//! 进程入口：单进程托管前端静态文件与 API。
//!
//! 配置走命令行参数与环境变量（KACHA_*）；listen / 数据根 / 网关地址 / 静态目录可配置。
//! 不带子命令时在前台运行，Ctrl+C 优雅关停；`service` 子命令供 Windows 服务控制管理器启动（#70）。

use kacha_server::launch::{self, Mode, Options};
use kacha_server::serve::DRAIN_LIMIT;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("cleanup") => std::process::exit(kacha_server::cleanup::run_cli(&args[1..])),
        Some("service") if !wants_help(&args) => std::process::exit(service(&args[1..])),
        _ => {}
    }
    if wants_help(&args) {
        println!("kacha-server {}", kacha_server::VERSION);
        println!("用法：kacha-server [--listen 0.0.0.0:3004] [--data-root <目录>] [--gateway-url <new-api 地址>] [--static-dir <前端构建目录>] [--result-hosts <逗号分隔主机>] [--min-free-gb 20] [--board-slots 10] [--board-warn-mb 500] [--board-alert-mb 1024]");
        println!("环境变量：KACHA_LISTEN、KACHA_DATA_ROOT、KACHA_GATEWAY_URL、KACHA_STATIC_DIR、KACHA_RESULT_HOSTS、KACHA_MIN_FREE_GB、KACHA_BOARD_SLOTS、KACHA_BOARD_WARN_MB、KACHA_BOARD_ALERT_MB");
        println!("清理与恢复：kacha-server cleanup --help；kacha-server cleanup restore --help");
        println!("Windows 服务：kacha-server service <与上面相同的参数>，只供服务控制管理器启动（见部署说明）；生命周期日志写入 <数据根>/server.log");
        return;
    }

    let ctrl_c = async {
        if tokio::signal::ctrl_c().await.is_err() {
            // 无法监听 Ctrl+C 时不能当作收到关停信号。
            std::future::pending::<()>().await;
        }
    };
    let code = launch::run_blocking(launch::start(Options::parse(&args), Mode::Foreground, DRAIN_LIMIT, |_| {}, ctrl_c)).unwrap_or_else(|e| {
        eprintln!("创建异步运行时失败：{e}");
        launch::EXIT_FAILED
    });
    std::process::exit(code);
}

fn wants_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

#[cfg(windows)]
fn service(args: &[String]) -> i32 {
    kacha_server::win_service::run(args)
}

#[cfg(not(windows))]
fn service(_args: &[String]) -> i32 {
    eprintln!("service 子命令只在 Windows 上可用；其他系统请直接前台运行或交给 systemd 等进程管理器。");
    launch::EXIT_FAILED
}
