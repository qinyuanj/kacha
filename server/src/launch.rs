//! 进程启动（#70）：命令行与环境变量解析、装配应用状态、监听并服务到关停信号。
//!
//! 前台模式与 Windows 服务模式共用 `start`，区别只在关停信号来自 Ctrl+C 还是 SCM 停止请求。
//! 生命周期（启动、启动失败、关停、排空、退出）写入 `<数据根>/server.log`；前台另有原来的控制台输出。

use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::serve::{self, Drained};
use crate::server_log::ServerLog;
use crate::{router, AppState, Config};

/// 前台与服务模式共用的启动参数；命令行优先于环境变量 KACHA_*。
#[derive(Clone, Debug)]
pub struct Options {
    pub listen: String,
    pub data_root: PathBuf,
    pub gateway_url: String,
    pub static_dir: Option<PathBuf>,
    pub result_hosts: Vec<String>,
    pub min_free_gb: u64,
}

impl Options {
    pub fn parse(args: &[String]) -> Self {
        let opt = |flag: &str, env: &str, default: &str| -> String {
            args.windows(2)
                .find(|w| w[0] == flag)
                .map(|w| w[1].clone())
                .or_else(|| std::env::var(env).ok())
                .unwrap_or_else(|| default.to_string())
        };
        let static_dir = args
            .windows(2)
            .find(|w| w[0] == "--static-dir")
            .map(|w| PathBuf::from(&w[1]))
            .or_else(|| std::env::var("KACHA_STATIC_DIR").ok().map(PathBuf::from));
        Options {
            listen: opt("--listen", "KACHA_LISTEN", "0.0.0.0:3004"),
            data_root: PathBuf::from(opt("--data-root", "KACHA_DATA_ROOT", "./kacha-data")),
            gateway_url: opt("--gateway-url", "KACHA_GATEWAY_URL", "http://lzxsvn:3001"),
            static_dir,
            // 结果中转允许列表：默认含火山引擎对象存储，部署可用逗号分隔追加主机（如内网对象存储）。
            result_hosts: opt("--result-hosts", "KACHA_RESULT_HOSTS", "")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            // 磁盘余量门槛（GB），低于它写入类接口返回 507。
            min_free_gb: opt("--min-free-gb", "KACHA_MIN_FREE_GB", "20").parse().unwrap_or(20),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Foreground,
    Service,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Foreground => "前台模式",
            Mode::Service => "服务模式",
        }
    }
}

/// 启动并服务到 `shutdown` 完成，返回进程退出码：0 正常退出（含排空超时），1 数据根或监听失败，2 监听地址无效。
/// 开始监听后调用 `on_listening`（服务模式据此向 SCM 报告 RUNNING）。
pub async fn start(
    options: Options,
    mode: Mode,
    drain_limit: Duration,
    on_listening: impl FnOnce(SocketAddr),
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> i32 {
    let data_root = options.data_root.clone();
    let log = ServerLog::new(data_root.clone());
    let fail = |code: i32, message: String| {
        eprintln!("{message}");
        log.log(&format!("启动失败：{message}"));
        code
    };

    if let Err(e) = std::fs::create_dir_all(&data_root) {
        return fail(1, format!("创建数据根失败：{e}"));
    }
    let addr: SocketAddr = match options.listen.parse() {
        Ok(addr) => addr,
        Err(_) => return fail(2, format!("监听地址无效：{}", options.listen)),
    };
    let state = AppState::new(
        Config {
            data_root: data_root.clone(),
            gateway_url: options.gateway_url.clone(),
            static_dir: options.static_dir,
            result_hosts: options.result_hosts,
            min_free_bytes: options.min_free_gb.saturating_mul(1024 * 1024 * 1024),
        },
        Arc::new(crate::verify::HttpKeyVerifier::new(options.gateway_url)),
        Arc::new(SystemTime::now),
    );
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => return fail(1, format!("监听 {addr} 失败：{e}")),
    };
    let local = listener.local_addr().unwrap_or(addr);
    println!("kacha-server {} 监听 http://{}，数据根 {}", crate::VERSION, local, data_root.display());
    log.log(&format!("kacha-server {} 启动（{}），监听 http://{}，数据根 {}，进程 {}", crate::VERSION, mode.label(), local, data_root.display(), std::process::id()));
    // 每日一次记录各用户数据根大小（不含密钥与提示词全文）。
    crate::usage_log::spawn_daily(Arc::new(crate::usage_log::UsageLogger::new(data_root.clone(), Arc::new(SystemTime::now))));
    on_listening(local);

    match serve::run(router(state), listener, shutdown, drain_limit, &log).await {
        Ok(drained) => {
            let how = match drained {
                Drained::Completed => "正常退出".to_string(),
                Drained::TimedOut { abandoned } => format!("排空超时退出（放弃 {abandoned} 个请求）"),
            };
            log.log(&format!("kacha-server {how}"));
            0
        }
        Err(e) => {
            eprintln!("服务端退出：{e}");
            log.log(&format!("kacha-server 异常退出：{e}"));
            1
        }
    }
}
