//! 带优雅关停的 HTTP 服务（#70）。前台模式（Ctrl+C）与 Windows 服务模式（SCM 停止请求）共用：
//! 两者只在 `shutdown` future 的来源上不同。
//!
//! 关停信号到来后立即停止接受新连接，等进行中的请求处理完；排空超过上限就放弃剩余请求返回，
//! 由调用方退出进程（对仍在执行的阻塞任务等同于强行结束）。单个目标文件都经临时文件加原子改名
//! 落位，不会被写成半截；跨文件的操作（画板改名、删除连同 `.bak`）若恰在两步之间被结束，
//! 可能留下孤立的 `.bak`，各文件本身完整。

use std::future::{Future, IntoFuture};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use tokio::net::TcpListener;

use crate::server_log::ServerLog;

/// 关停时等待进行中请求的上限。
pub const DRAIN_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Drained {
    /// 进行中的请求全部处理完。
    Completed,
    /// 超过排空上限，放弃了这么多仍在处理的请求（响应体已在下发的不计入）。
    TimedOut { abandoned: usize },
}

/// 一直服务到 `shutdown` 完成，再排空进行中的请求（最多 `drain_limit`）。
/// 关停信号与排空结果写入 `log`。监听出错时返回错误。
pub async fn run(
    app: Router,
    listener: TcpListener,
    shutdown: impl Future<Output = ()> + Send + 'static,
    drain_limit: Duration,
    log: &ServerLog,
) -> std::io::Result<Drained> {
    let in_flight = Arc::new(AtomicUsize::new(0));
    let counter = in_flight.clone();
    let app = app.layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
        let guard = InFlight::enter(counter.clone());
        async move {
            let res = next.run(req).await;
            drop(guard);
            res
        }
    }));

    let (signalled_tx, signalled_rx) = tokio::sync::oneshot::channel::<()>();
    let signal = async move {
        shutdown.await;
        let _ = signalled_tx.send(());
    };
    let server = axum::serve(listener, app).with_graceful_shutdown(signal).into_future();
    tokio::pin!(server);

    // 空闲时信号与服务器结束会同时就绪：先看信号，保证关停与排空结果一定进日志。
    tokio::select! {
        biased;
        _ = signalled_rx => {}
        result = &mut server => return result.map(|()| Drained::Completed),
    }
    let pending = in_flight.load(Ordering::SeqCst);
    let _ = log.log(&format!("收到关停信号，停止接受新连接，等待 {pending} 个进行中的请求（上限 {} 秒）", drain_limit.as_secs_f32()));

    match tokio::time::timeout(drain_limit, &mut server).await {
        Ok(result) => {
            result?;
            let _ = log.log("排空完成，进行中的请求均已处理完");
            Ok(Drained::Completed)
        }
        Err(_) => {
            let abandoned = in_flight.load(Ordering::SeqCst);
            let _ = log.log(&format!("排空超时，放弃 {abandoned} 个进行中的请求"));
            Ok(Drained::TimedOut { abandoned })
        }
    }
}

/// 进行中请求计数：进入处理时加一，处理结束（含被取消）时减一。
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn enter(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        InFlight(counter)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
