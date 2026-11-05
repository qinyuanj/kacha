//! 进程入口：单进程托管前端静态文件与 API。
//!
//! 配置走命令行参数与环境变量（KACHA_*）；listen / 数据根 / 网关地址 / 静态目录可配置。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;

use kacha_server::{router, AppState, Config};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("cleanup") {
        std::process::exit(kacha_server::cleanup::run_cli(&args[1..]));
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("kacha-server {}", kacha_server::VERSION);
        println!("用法：kacha-server [--listen 0.0.0.0:3004] [--data-root <目录>] [--gateway-url <new-api 地址>] [--static-dir <前端构建目录>] [--result-hosts <逗号分隔主机>] [--min-free-gb 20]");
        println!("环境变量：KACHA_LISTEN、KACHA_DATA_ROOT、KACHA_GATEWAY_URL、KACHA_STATIC_DIR、KACHA_RESULT_HOSTS、KACHA_MIN_FREE_GB");
        println!("清理与恢复：kacha-server cleanup --help；kacha-server cleanup restore --help");
        return;
    }

    let opt = |flag: &str, env: &str, default: &str| -> String {
        args.windows(2)
            .find(|w| w[0] == flag)
            .map(|w| w[1].clone())
            .or_else(|| std::env::var(env).ok())
            .unwrap_or_else(|| default.to_string())
    };
    let listen = opt("--listen", "KACHA_LISTEN", "0.0.0.0:3004");
    let data_root = PathBuf::from(opt("--data-root", "KACHA_DATA_ROOT", "./kacha-data"));
    let gateway_url = opt("--gateway-url", "KACHA_GATEWAY_URL", "http://lzxsvn:3001");
    let static_dir = args
        .windows(2)
        .find(|w| w[0] == "--static-dir")
        .map(|w| PathBuf::from(&w[1]))
        .or_else(|| std::env::var("KACHA_STATIC_DIR").ok().map(PathBuf::from));
    // 结果中转允许列表：默认含火山引擎对象存储，部署可用逗号分隔追加主机（如内网对象存储）。
    // 磁盘余量门槛（GB），低于它写入类接口返回 507。
    let min_free_gb: u64 = opt("--min-free-gb", "KACHA_MIN_FREE_GB", "20").parse().unwrap_or(20);
    let result_hosts = opt("--result-hosts", "KACHA_RESULT_HOSTS", "")
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if let Err(e) = std::fs::create_dir_all(&data_root) {
        eprintln!("创建数据根失败：{e}");
        std::process::exit(1);
    }
    let state = AppState::new(
        Config {
            data_root: data_root.clone(),
            gateway_url: gateway_url.clone(),
            static_dir,
            result_hosts,
            min_free_bytes: min_free_gb.saturating_mul(1024 * 1024 * 1024),
        },
        Arc::new(kacha_server::verify::HttpKeyVerifier::new(gateway_url.clone())),
        Arc::new(SystemTime::now),
    );
    let addr: SocketAddr = listen.parse().unwrap_or_else(|_| {
        eprintln!("监听地址无效：{listen}");
        std::process::exit(2);
    });
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
        eprintln!("监听 {addr} 失败：{e}");
        std::process::exit(1);
    });
    println!("kacha-server {} 监听 http://{}，数据根 {}", kacha_server::VERSION, listener.local_addr().unwrap(), data_root.display());
    // 每日一次记录各用户数据根大小（不含密钥与提示词全文）。
    kacha_server::usage_log::spawn_daily(std::sync::Arc::new(kacha_server::usage_log::UsageLogger::new(data_root.clone(), Arc::new(SystemTime::now))));
    axum::serve(listener, router(state)).await.expect("服务端退出");
}
