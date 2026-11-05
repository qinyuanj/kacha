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

#[tokio::test]
async fn session_survives_server_restart() {
    let mut h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    h.restart();
    let reply = h.get("/api/session", Some(&cookie)).await;
    assert_eq!(reply.status, 200, "重启后 7 天内不必重新粘贴密钥：{}", reply.text());
    assert_eq!(reply.json()["fingerprint"], fingerprint(GOOD_KEY));
}

#[tokio::test]
async fn logout_and_expiry_still_invalidate_after_restart() {
    let mut h = Harness::new();
    let logged_out = h.session(GOOD_KEY).await;
    let expiring = h.session(OTHER_KEY).await;
    assert_eq!(h.send(axum::http::Method::DELETE, "/api/session", Some(&logged_out), axum::body::Body::empty()).await.status, 204);
    h.restart();
    assert_eq!(h.get("/api/session", Some(&logged_out)).await.status, 401, "退出的会话重启后不复活");
    assert_eq!(h.get("/api/session", Some(&expiring)).await.status, 200);
    h.advance(std::time::Duration::from_secs(7 * 86400 + 1));
    h.restart();
    assert_eq!(h.get("/api/session", Some(&expiring)).await.status, 401, "过期时间随会话持久化");
}

#[tokio::test]
async fn persisted_sessions_hold_only_token_hash_and_fingerprint() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let token = cookie.split('=').nth(1).unwrap();
    let text = std::fs::read_to_string(h.data_root().join("sessions.json")).unwrap();
    assert!(!text.contains(token), "不落会话令牌原文：{text}");
    assert!(!text.contains(GOOD_KEY), "不落密钥：{text}");
    let saved: serde_json::Value = serde_json::from_str(&text).unwrap();
    let entry = &saved["sessions"][0];
    assert_eq!(entry["token_sha256"], fingerprint(token));
    assert_eq!(entry["fingerprint"], fingerprint(GOOD_KEY));
    assert_eq!(entry["expires_at"], h.now_secs() + 7 * 86400);
}

#[tokio::test]
async fn corrupt_session_file_means_paste_again_not_failed_start() {
    let mut h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    std::fs::write(h.data_root().join("sessions.json"), "{broken").unwrap();
    h.restart();
    assert_eq!(h.get("/api/session", Some(&cookie)).await.status, 401);
    let again = h.session(GOOD_KEY).await;
    assert_eq!(h.get("/api/session", Some(&again)).await.status, 200);
}
