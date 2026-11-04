mod common;

use common::*;

#[tokio::test]
async fn version_comes_from_server_manifest_and_needs_no_session() {
    let h = Harness::new();
    let reply = h.get("/api/config", None).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(reply.json()["gateway_url"], "http://gateway.test");
}

#[tokio::test]
async fn valid_key_gets_strict_session_cookie_and_user_data_root() {
    let h = Harness::new();
    let reply = h.login(GOOD_KEY).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let cookie = reply.headers.get("set-cookie").unwrap().to_str().unwrap();
    assert!(cookie.starts_with("kacha_session="), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Strict"), "{cookie}");
    assert!(cookie.contains("Path=/"), "{cookie}");
    assert!(!cookie.contains("Secure"), "内网 HTTP 不能带 Secure：{cookie}");
    assert!(cookie.contains("Max-Age=604800"), "7 天会话：{cookie}");
    let meta = meta_path(&h.user_root(GOOD_KEY));
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&meta).unwrap()).unwrap();
    assert_eq!(saved["fingerprint"], fingerprint(GOOD_KEY));
    assert!(saved["last_access_at"].as_u64().is_some());
    // 服务器上的数据不落密钥原文。
    assert!(!std::fs::read_to_string(&meta).unwrap().contains(GOOD_KEY));
}

#[tokio::test]
async fn invalid_key_and_gateway_outage_are_distinguished() {
    let h = Harness::new();
    let invalid = h.login(BAD_KEY).await;
    assert_eq!(invalid.status, 401);
    assert_eq!(invalid.json()["code"], "invalid_key");
    assert!(invalid.text().contains("密钥"), "{}", invalid.text());
    assert!(invalid.headers.get("set-cookie").is_none());
    assert!(!h.user_root(BAD_KEY).exists(), "验证失败不能建用户数据根");

    let outage = h.login(OUTAGE_KEY).await;
    assert_eq!(outage.status, 503);
    assert_eq!(outage.json()["code"], "gateway_unavailable");
    assert_ne!(outage.json()["code"], invalid.json()["code"]);
}

#[tokio::test]
async fn session_returns_identity_for_logged_in_cookie() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = h.get("/api/session", Some(&cookie)).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.json()["fingerprint"], fingerprint(GOOD_KEY));
    assert_eq!(h.get("/api/session", None).await.status, 401);
}

#[tokio::test]
async fn expired_session_returns_401() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    h.advance(std::time::Duration::from_secs(6 * 86400 + 3600));
    assert_eq!(h.get("/api/session", Some(&cookie)).await.status, 200, "7 天内仍有效");
    h.advance(std::time::Duration::from_secs(24 * 3600));
    assert_eq!(h.get("/api/session", Some(&cookie)).await.status, 401, "超过 7 天失效");
}

#[tokio::test]
async fn logout_invalidates_the_session_and_clears_cookie() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = h.send(axum::http::Method::DELETE, "/api/session", Some(&cookie), axum::body::Body::empty()).await;
    assert_eq!(reply.status, 204);
    let cleared = reply.headers.get("set-cookie").unwrap().to_str().unwrap();
    assert!(cleared.contains("Max-Age=0"), "{cleared}");
    assert_eq!(h.get("/api/session", Some(&cookie)).await.status, 401);
}

#[tokio::test]
async fn revisit_updates_last_access_at() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let before = h.now_secs();
    h.advance(std::time::Duration::from_secs(3600));
    h.get("/api/session", Some(&cookie)).await;
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(meta_path(&h.user_root(GOOD_KEY))).unwrap()).unwrap();
    assert!(saved["last_access_at"].as_u64().unwrap() >= before + 3600);
}
