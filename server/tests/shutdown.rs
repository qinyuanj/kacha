//! 优雅关停（#70）：前台 Ctrl+C 与 Windows 服务停止请求共用同一条关停路径。
//! 用真实监听器起服务器，在进程内给关停信号，从客户端观察行为。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::routing::get;
use axum::Router;
use kacha_server::serve::{run, Drained};
use kacha_server::server_log::ServerLog;
use tokio::sync::{oneshot, Notify};

/// /slow 进入后通知 `entered`，等 `release` 才返回；/fast 立即返回。
fn app(entered: Arc<Notify>, release: Arc<Notify>) -> Router {
    Router::new()
        .route(
            "/slow",
            get(move || async move {
                entered.notify_one();
                release.notified().await;
                "done"
            }),
        )
        .route("/fast", get(|| async { "fast" }))
}

struct Running {
    addr: SocketAddr,
    stop: oneshot::Sender<()>,
    server: tokio::task::JoinHandle<std::io::Result<Drained>>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    _dir: tempfile::TempDir,
}

async fn start(drain_limit: Duration) -> Running {
    let dir = tempfile::tempdir().unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let log = ServerLog::new(dir.path().to_path_buf());
    let app = app(entered.clone(), release.clone());
    let server = tokio::spawn(async move {
        run(app, listener, async move {
            let _ = stopped.await;
        }, drain_limit, &log)
        .await
    });
    Running { addr, stop, server, entered, release, _dir: dir }
}

async fn get_text(addr: SocketAddr, path: &str) -> reqwest::Result<(u16, String)> {
    // 每次新建客户端：不复用连接池里的旧连接，确保是一条新连接。
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
    let res = client.get(format!("http://{addr}{path}")).send().await?;
    let status = res.status().as_u16();
    Ok((status, res.text().await?))
}

#[tokio::test]
async fn in_flight_request_finishes_and_new_connections_are_refused_after_shutdown() {
    let s = start(Duration::from_secs(60)).await;
    let slow = tokio::spawn(get_text(s.addr, "/slow"));
    s.entered.notified().await;

    s.stop.send(()).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(get_text(s.addr, "/fast").await.is_err(), "关停开始后不应再接受新连接");

    s.release.notify_one();
    let (status, body) = slow.await.unwrap().unwrap();
    assert_eq!((status, body.as_str()), (200, "done"));
    let drained = tokio::time::timeout(Duration::from_secs(5), s.server).await.expect("服务器应在排空后返回").unwrap().unwrap();
    assert_eq!(drained, Drained::Completed);
}

#[tokio::test]
async fn drain_gives_up_after_limit_and_reports_abandoned_requests() {
    let s = start(Duration::from_millis(300)).await;
    let _slow = tokio::spawn(get_text(s.addr, "/slow"));
    s.entered.notified().await;

    s.stop.send(()).unwrap();
    let drained = tokio::time::timeout(Duration::from_secs(5), s.server).await.expect("超过排空上限后服务器必须返回").unwrap().unwrap();
    assert_eq!(drained, Drained::TimedOut { abandoned: 1 });
    drop(s.release);
}

#[tokio::test]
async fn idle_server_stops_promptly() {
    let s = start(Duration::from_secs(60)).await;
    assert_eq!(get_text(s.addr, "/fast").await.unwrap(), (200, "fast".to_string()));
    s.stop.send(()).unwrap();
    let drained = tokio::time::timeout(Duration::from_secs(5), s.server).await.expect("空闲时应立即退出").unwrap().unwrap();
    assert_eq!(drained, Drained::Completed);
}
