//! 结果中转：服务端从允许列表内的对象存储下载并流式写入任务目录的暂存区，校验后提交。
mod common;

use std::net::SocketAddr;

use axum::body::Body;
use axum::http::Method;
use axum::routing::get;
use axum::Router;
use common::*;

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 73, 72, 68, 82];

/// 本地对象存储桩：/objects/a.png 给 PNG，/objects/missing.png 给 404，/objects/big.bin 给非图片。
async fn object_store() -> String {
    let app = Router::new()
        .route("/objects/a.png", get(|| async { ([(axum::http::header::CONTENT_TYPE, "image/png")], PNG) }))
        .route("/objects/missing.png", get(|| async { (axum::http::StatusCode::NOT_FOUND, "gone") }))
        .route("/objects/unauthorized.png", get(|| async { (axum::http::StatusCode::UNAUTHORIZED, "denied") }))
        .route("/objects/forbidden.png", get(|| async { (axum::http::StatusCode::FORBIDDEN, "denied") }))
        .route("/objects/throttled.png", get(|| async { (axum::http::StatusCode::TOO_MANY_REQUESTS, "slow down") }))
        .route("/objects/big.bin", get(|| async { "not an image" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn relay_body(url: &str, dir: &str, stem: &str) -> String {
    serde_json::json!({ "url": url, "dir": dir, "stem": stem }).to_string()
}

async fn relay(h: &Harness, cookie: &str, url: &str, dir: &str, stem: &str) -> Reply {
    h.send(Method::POST, "/api/fs/relay", Some(cookie), relay_body(url, dir, stem)).await
}

async fn commit(h: &Harness, cookie: &str, dir: &str, from: &str, stem: &str) -> Reply {
    h.send(Method::POST, "/api/fs/relay/commit", Some(cookie), serde_json::json!({ "dir": dir, "from": from, "stem": stem }).to_string()).await
}

#[tokio::test]
async fn relay_downloads_to_staging_sniffs_extension_and_commits() {
    let store = object_store().await;
    let h = Harness::with_result_hosts(vec!["127.0.0.1".into()]);
    let cookie = h.session(GOOD_KEY).await;
    let dir = "2026-11-04/20261104T000000Z-00000001";
    let res = relay(&h, &cookie, &format!("{store}/objects/a.png"), dir, "0").await;
    assert_eq!(res.status, 200, "{}", res.text());
    assert_eq!(res.json(), serde_json::json!({ "file": "0.png", "path": format!("{dir}/.staging/0.png") }));
    // 暂存区不是成品：提交前没有 result.*。
    assert!(!h.user_root(GOOD_KEY).join(dir).join("result.png").exists());
    let staged = h.get(&format!("/api/fs/file?path={}", q(&format!("{dir}/.staging/0.png"))), Some(&cookie)).await;
    assert_eq!(staged.body, PNG, "字节完整落盘，可读回校验");

    let done = commit(&h, &cookie, dir, "0.png", "result").await;
    assert_eq!(done.status, 200, "{}", done.text());
    assert_eq!(done.json(), serde_json::json!({ "file": "result.png", "path": format!("{dir}/result.png") }));
    assert!(!h.user_root(GOOD_KEY).join(dir).join(".staging").join("0.png").exists(), "提交后暂存文件消失");
    assert_eq!(h.get(&format!("/api/fs/file?path={}", q(&format!("{dir}/result.png"))), Some(&cookie)).await.body, PNG);

    // 成品只新建不覆盖。
    let again = relay(&h, &cookie, &format!("{store}/objects/a.png"), dir, "1").await;
    assert_eq!(again.status, 200);
    let conflict = commit(&h, &cookie, dir, "1.png", "result").await;
    assert_eq!(conflict.status, 409, "{}", conflict.text());
    assert_eq!(h.get(&format!("/api/fs/file?path={}", q(&format!("{dir}/result.png"))), Some(&cookie)).await.body, PNG);
}

#[tokio::test]
async fn relay_rejects_scheme_and_host_outside_allow_list() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    for url in [
        "http://example.com/objects/a.png",
        "https://volces.com.evil.example/a.png",
        "file:///etc/passwd",
        "ftp://127.0.0.1/a.png",
        "not a url",
    ] {
        let res = relay(&h, &cookie, url, "2026-11-04/t", "0").await;
        assert_eq!(res.status, 400, "{url} → {}", res.text());
        assert_eq!(res.json()["code"], "result_url_not_allowed");
        assert!(!res.text().contains(url) || url == "not a url", "错误不带原始地址（可能含签名）");
    }
    // 默认允许列表包含火山引擎与阿里云对象存储域名。
    let defaults = kacha_server::relay::default_result_hosts();
    assert!(defaults.iter().any(|h| h.contains("volces.com")));
    assert!(defaults.contains(&".aliyuncs.com"));
}

#[tokio::test]
async fn relay_upstream_failure_is_reported_and_leaves_no_product_file() {
    let store = object_store().await;
    let h = Harness::with_result_hosts(vec!["127.0.0.1".into()]);
    let cookie = h.session(GOOD_KEY).await;
    let dir = "2026-11-04/t2";
    let missing = relay(&h, &cookie, &format!("{store}/objects/missing.png"), dir, "0").await;
    assert_eq!(missing.status, 502, "上游失败统一 502：{}", missing.text());
    assert_eq!(missing.json()["upstream_status"], 404, "错误体保留上游状态");
    assert!(!missing.text().contains("missing.png"), "不回显签名地址");
    let not_image = relay(&h, &cookie, &format!("{store}/objects/big.bin"), dir, "1").await;
    assert_eq!(not_image.status, 422, "非图片字节：{}", not_image.text());
    assert_eq!(not_image.json()["code"], "invalid_image");
    let leftover = h.get(&format!("/api/fs/dir?path={}", q(dir)), Some(&cookie)).await;
    assert!(leftover.status == 404 || leftover.json().as_array().unwrap().is_empty(), "失败不留成品或暂存文件：{}", leftover.text());
    // 失败后可以重来：同名暂存不被占住。
    assert_eq!(relay(&h, &cookie, &format!("{store}/objects/a.png"), dir, "0").await.status, 200);
}

#[tokio::test]
async fn relay_discard_clears_staging_and_rejects_escape() {
    let store = object_store().await;
    let h = Harness::with_result_hosts(vec!["127.0.0.1".into()]);
    let cookie = h.session(GOOD_KEY).await;
    let dir = "2026-11-04/t3";
    assert_eq!(relay(&h, &cookie, &format!("{store}/objects/a.png"), dir, "0").await.status, 200);
    let drop = h.send(Method::DELETE, &format!("/api/fs/relay?dir={}", q(dir)), Some(&cookie), Body::empty()).await;
    assert_eq!(drop.status, 204, "{}", drop.text());
    assert!(h.get(&format!("/api/fs/dir?path={}", q(dir)), Some(&cookie)).await.json().as_array().unwrap().is_empty());
    // 任务目录外的路径一律越界；commit 不能拿别的文件冒充暂存文件。
    assert_eq!(relay(&h, &cookie, &format!("{store}/objects/a.png"), "../x", "0").await.status, 403);
    assert_eq!(relay(&h, &cookie, &format!("{store}/objects/a.png"), dir, "../result").await.status, 403);
    assert_eq!(commit(&h, &cookie, dir, "../../etc/passwd", "result").await.status, 403);
    let other = h.session(OTHER_KEY).await;
    assert_eq!(relay(&h, &other, &format!("{store}/objects/a.png"), dir, "9").await.status, 200);
    assert!(h.user_root(GOOD_KEY).join(dir).join(".staging").join("9.png").exists() == false, "按用户隔离");
}

#[tokio::test]
async fn upstream_auth_failures_are_502_not_session_or_path_errors() {
    let store = object_store().await;
    let h = Harness::with_result_hosts(vec!["127.0.0.1".into()]);
    let cookie = h.session(GOOD_KEY).await;
    let dir = "2026-11-04/t4";
    for (object, upstream) in [("unauthorized.png", 401), ("forbidden.png", 403), ("throttled.png", 429)] {
        let res = relay(&h, &cookie, &format!("{store}/objects/{object}"), dir, "0").await;
        assert_eq!(res.status, 502, "{object}：{}", res.text());
        assert_eq!(res.json()["code"], "download_failed");
        assert_eq!(res.json()["upstream_status"], upstream);
        assert!(res.text().contains(&format!("HTTP {upstream}")), "文案如实显示上游状态：{}", res.text());
    }
    assert_eq!(h.get("/api/session", Some(&cookie)).await.status, 200, "上游 401 不影响会话");
    // 路径越界仍是 403，与上游 403 可区分。
    let escape = relay(&h, &cookie, &format!("{store}/objects/a.png"), "../x", "0").await;
    assert_eq!(escape.status, 403);
    assert_eq!(escape.json()["code"], "forbidden");
}
