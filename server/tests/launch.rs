//! 进程启动（#70）：前台与服务模式共用的启动函数，生命周期写入 `<数据根>/server.log`。

use std::time::Duration;

use kacha_server::launch::{start, Mode, Options};
use tokio::sync::oneshot;

fn options(listen: &str, data_root: &std::path::Path) -> Options {
    let args: Vec<String> = ["--listen", listen, "--data-root", data_root.to_str().unwrap(), "--gateway-url", "http://gateway.test"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    Options::parse(&args)
}

/// 生命周期日志的约定位置：数据根下的服务端日志目录（与 users/ 并列）。
fn server_log(data_root: &std::path::Path) -> String {
    std::fs::read_to_string(data_root.join("server-log").join("server.log")).unwrap_or_default()
}

#[test]
fn board_slots_and_size_lines_are_command_line_options_with_defaults() {
    let defaults = Options::parse(&[]);
    assert_eq!(defaults.board_slots, 10);
    assert_eq!(defaults.board_size_lines, kacha_server::BoardSizeLines { warn: 500 * 1024 * 1024, alert: 1024 * 1024 * 1024 });
    let args: Vec<String> = ["--board-slots", "12", "--board-warn-mb", "300", "--board-alert-mb", "800"].iter().map(|s| s.to_string()).collect();
    let set = Options::parse(&args);
    assert_eq!(set.board_slots, 12);
    assert_eq!(set.board_size_lines, kacha_server::BoardSizeLines { warn: 300 * 1024 * 1024, alert: 800 * 1024 * 1024 });
}

#[tokio::test]
async fn unwritable_server_log_is_a_start_failure() {
    let dir = tempfile::tempdir().unwrap();
    // 日志目录位置被一个普通文件占住：写不了日志，服务模式就没有任何现场记录，必须启动失败。
    std::fs::write(dir.path().join("server-log"), b"not a dir").unwrap();
    let code = start(options("127.0.0.1:0", dir.path()), Mode::Service, Duration::from_secs(60), |_| panic!("不应开始监听"), std::future::pending()).await;
    assert_eq!(code, 1);
}

#[tokio::test]
async fn start_serves_until_shutdown_then_exits_zero_and_logs_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let data_root = dir.path().join("data");
    let (addr_tx, addr_rx) = oneshot::channel();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let run = tokio::spawn(start(options("127.0.0.1:0", &data_root), Mode::Service, Duration::from_secs(60), move |addr| {
        let _ = addr_tx.send(addr);
    }, async move {
        let _ = stop_rx.await;
    }));

    let addr = addr_rx.await.unwrap();
    let res = reqwest::get(format!("http://{addr}/api/config")).await.unwrap();
    assert_eq!(res.status().as_u16(), 200);
    stop_tx.send(()).unwrap();
    let code = tokio::time::timeout(Duration::from_secs(5), run).await.unwrap().unwrap();
    assert_eq!(code, 0);

    let log = server_log(&data_root);
    for expected in [kacha_server::VERSION, &format!("{addr}"), data_root.to_str().unwrap(), "服务模式", "收到关停信号", "排空完成", "退出"] {
        assert!(log.contains(expected), "server.log 缺少「{expected}」：\n{log}");
    }
}

#[tokio::test]
async fn listen_failure_exits_nonzero_and_logs_reason() {
    let dir = tempfile::tempdir().unwrap();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let listen = taken.local_addr().unwrap().to_string();

    let code = start(options(&listen, dir.path()), Mode::Foreground, Duration::from_secs(60), |_| panic!("不应开始监听"), std::future::pending()).await;
    assert_ne!(code, 0);
    let log = server_log(dir.path());
    assert!(log.contains(&format!("监听 {listen} 失败")), "{log}");
}

#[tokio::test]
async fn invalid_listen_address_exits_two_and_logs_reason() {
    let dir = tempfile::tempdir().unwrap();
    let code = start(options("not-an-address", dir.path()), Mode::Foreground, Duration::from_secs(60), |_| panic!("不应开始监听"), std::future::pending()).await;
    assert_eq!(code, 2);
    assert!(server_log(dir.path()).contains("监听地址无效：not-an-address"));
}
