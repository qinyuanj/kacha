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
    pub board_slots: u32,
    pub board_size_lines: crate::BoardSizeLines,
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
            // 画板位数量与画板体量提醒线（MiB）：初值，按每日用量日志调整，改参数重启服务即可，不用发版（ADR 0019）。
            board_slots: opt("--board-slots", "KACHA_BOARD_SLOTS", "").parse().unwrap_or(crate::board_list::DEFAULT_BOARD_SLOTS),
            board_size_lines: {
                let default = crate::BoardSizeLines::default();
                let mib = |flag: &str, env: &str, fallback: u64| opt(flag, env, "").parse::<u64>().map_or(fallback, |m| m.saturating_mul(1024 * 1024));
                crate::BoardSizeLines {
                    warn: mib("--board-warn-mb", "KACHA_BOARD_WARN_MB", default.warn),
                    alert: mib("--board-alert-mb", "KACHA_BOARD_ALERT_MB", default.alert),
                }
            },
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

/// 进程退出码。0：正常退出（含排空超时）。
pub const EXIT_OK: i32 = 0;
/// 数据根不可用（不能创建或写不了日志）、监听失败或服务异常退出；服务模式据此触发失败恢复。
pub const EXIT_FAILED: i32 = 1;
/// 监听地址无效（配置错误，重启也不会好）。
pub const EXIT_BAD_LISTEN: i32 = 2;

/// 在新建的多线程运行时上跑完 `future`（通常是 `start`），返回它给出的退出码。
/// 排空超时后被放弃的请求可能还占着阻塞线程：运行时最多再等 2 秒就结束。
pub fn run_blocking(future: impl Future<Output = i32>) -> std::io::Result<i32> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let code = runtime.block_on(future);
    runtime.shutdown_timeout(Duration::from_secs(2));
    Ok(code)
}

/// 启动并服务到 `shutdown` 完成，返回进程退出码（见 `EXIT_*`）。
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
        let _ = log.log(&format!("启动失败：{message}"));
        code
    };

    if let Err(e) = std::fs::create_dir_all(&data_root) {
        return fail(EXIT_FAILED, format!("创建数据根失败：{e}"));
    }
    // 写入探测：数据根不可写（如服务账户缺权限）时立即启动失败，而不是带病运行到第一次保存才出错。
    if let Err(e) = log.log(&format!("kacha-server {} 正在启动（{}），数据根 {}", crate::VERSION, mode.label(), data_root.display())) {
        eprintln!("数据根不可写（{}）：{e}", log.path().display());
        return EXIT_FAILED;
    }
    let addr: SocketAddr = match options.listen.parse() {
        Ok(addr) => addr,
        Err(_) => return fail(EXIT_BAD_LISTEN, format!("监听地址无效：{}", options.listen)),
    };
    let state = AppState::new(
        Config {
            data_root: data_root.clone(),
            gateway_url: options.gateway_url.clone(),
            static_dir: options.static_dir,
            result_hosts: options.result_hosts,
            min_free_bytes: options.min_free_gb.saturating_mul(1024 * 1024 * 1024),
            board_slots: options.board_slots,
            board_size_lines: options.board_size_lines,
        },
        Arc::new(crate::verify::HttpKeyVerifier::new(options.gateway_url)),
        Arc::new(SystemTime::now),
    );
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(e) => return fail(EXIT_FAILED, format!("监听 {addr} 失败：{e}")),
    };
    let local = listener.local_addr().unwrap_or(addr);
    println!("kacha-server {} 监听 http://{}，数据根 {}", crate::VERSION, local, data_root.display());
    let _ = log.log(&format!("kacha-server {} 启动（{}），监听 http://{}，数据根 {}，进程 {}", crate::VERSION, mode.label(), local, data_root.display(), std::process::id()));
    // 每日一次记录各用户数据根大小（不含密钥与提示词全文）。
    crate::usage_log::spawn_daily(Arc::new(crate::usage_log::UsageLogger::new(data_root.clone(), Arc::new(SystemTime::now))));
    on_listening(local);

    match serve::run(router(state), listener, shutdown, drain_limit, &log).await {
        Ok(drained) => {
            let how = match drained {
                Drained::Completed => "正常退出".to_string(),
                Drained::TimedOut { abandoned } => format!("排空超时退出（放弃 {abandoned} 个请求）"),
            };
            let _ = log.log(&format!("kacha-server {how}"));
            EXIT_OK
        }
        Err(e) => {
            eprintln!("服务端退出：{e}");
            let _ = log.log(&format!("kacha-server 异常退出：{e}"));
            EXIT_FAILED
        }
    }
}
