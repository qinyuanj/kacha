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

fn server_log(data_root: &std::path::Path) -> String {
    std::fs::read_to_string(data_root.join("server.log")).unwrap_or_default()
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
