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
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("kacha-server {}", kacha_server::VERSION);
        println!("用法：kacha-server [--listen 0.0.0.0:3004] [--data-root <目录>] [--gateway-url <new-api 地址>] [--static-dir <前端构建目录>]");
        println!("环境变量：KACHA_LISTEN、KACHA_DATA_ROOT、KACHA_GATEWAY_URL、KACHA_STATIC_DIR");
        return;
    }
    if args.first().map(String::as_str) == Some("cleanup") {
        eprintln!("cleanup 子命令由 #25 实现");
        std::process::exit(2);
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

    if let Err(e) = std::fs::create_dir_all(&data_root) {
        eprintln!("创建数据根失败：{e}");
        std::process::exit(1);
    }
    let state = AppState::new(
        Config { data_root: data_root.clone(), gateway_url: gateway_url.clone(), static_dir },
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
    axum::serve(listener, router(state)).await.expect("服务端退出");
}
