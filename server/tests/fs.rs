mod common;

use axum::body::Body;
use axum::http::Method;
use common::*;
use kacha_server::cache::IMMUTABLE;

async fn get_file(h: &Harness, cookie: &str, path: &str) -> common::Reply {
    h.get(&format!("/api/fs/file?path={}", q(path)), Some(cookie)).await
}

#[tokio::test]
async fn settings_ui_state_and_models_cache_are_per_user() {
    let h = Harness::new();
    let alice = h.session(GOOD_KEY).await;
    let bob = h.session(OTHER_KEY).await;
    // 未写入时读到 null，不是错误。
    let empty = h.get("/api/settings", Some(&alice)).await;
    assert_eq!(empty.status, 200);
    assert_eq!(empty.json(), serde_json::Value::Null);

    let settings = serde_json::json!({ "format_version": 1, "base_url": "http://gw", "concurrency": 2 }).to_string();
    assert_eq!(h.put("/api/settings", &alice, settings.clone()).await.status, 204);
    assert_eq!(h.get("/api/settings", Some(&alice)).await.json()["concurrency"], 2);
    assert_eq!(h.get("/api/settings", Some(&bob)).await.json(), serde_json::Value::Null, "另一个用户看不到");

    assert_eq!(h.put("/api/ui-state", &alice, r#"{"open_boards":["画板/a.ugcboard.json"]}"#).await.status, 204);
    assert_eq!(h.put("/api/models-cache", &alice, r#"{"model_ids":["m"]}"#).await.status, 204);
    assert_eq!(h.get("/api/ui-state", Some(&bob)).await.json(), serde_json::Value::Null);
    assert_eq!(h.get("/api/models-cache", Some(&bob)).await.json(), serde_json::Value::Null);
    assert_eq!(h.get("/api/capability-override", Some(&alice)).await.json(), serde_json::Value::Null);
    // 元数据不落在用户数据根顶层的画板目录里。
    assert!(h.user_root(GOOD_KEY).join(".kacha").join("settings.json").exists());
}

#[tokio::test]
async fn write_new_file_only_creates_and_conflicts_with_409() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let uri = format!("/api/fs/file?path={}", q("2026-11-04/task-a/result.png"));
    let first = h.put(&uri, &cookie, Body::from(vec![1u8, 2, 3])).await;
    assert_eq!(first.status, 201, "{}", first.text());
    let again = h.put(&uri, &cookie, Body::from(vec![9u8])).await;
    assert_eq!(again.status, 409, "只新建不覆盖");
    assert_eq!(get_file(&h, &cookie, "2026-11-04/task-a/result.png").await.body, vec![1, 2, 3]);
    assert_eq!(h.get("/api/fs/file?path=missing.txt", Some(&cookie)).await.status, 404);
    assert_eq!(h.get("/api/fs/is-file?path=2026-11-04/task-a/result.png", Some(&cookie)).await.json(), true);
    assert_eq!(h.get("/api/fs/is-file?path=2026-11-04/task-a", Some(&cookie)).await.json(), false);
    assert_eq!(h.get("/api/fs/sha256?path=2026-11-04/task-a/result.png", Some(&cookie)).await.json(), "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
}

#[tokio::test]
async fn read_file_cache_headers_follow_path_shape() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    let files = [
        ("2026-11-04/20261104T120000Z-abc/result.png", IMMUTABLE),
        ("2026-11-04/20261104T120000Z-abc/.staging/result.png", "no-cache"),
        ("导入参考图/abc.png", "no-cache"),
        ("画板/本地.ugcboard.json", "no-cache"),
        ("2026-11-04/顶层.png", "no-cache"),
    ];
    for (rel, _) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"bytes").unwrap();
    }
    for (rel, expected) in files {
        let reply = get_file(&h, &cookie, rel).await;
        assert_eq!(reply.status, 200, "{rel}: {}", reply.text());
        assert_eq!(reply.headers.get("cache-control").and_then(|v| v.to_str().ok()), Some(expected), "{rel}");
        assert!(reply.headers.get("etag").is_none(), "{rel} 不应带 ETag");
        assert!(reply.headers.get("last-modified").is_none(), "{rel} 不应带 Last-Modified");
    }
}

#[tokio::test]
async fn list_dir_returns_names_and_skips_nothing_outside() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    h.put(&format!("/api/fs/file?path={}", q("2026-11-04/task-a/result.png")), &cookie, Body::from(vec![1u8])).await;
    h.put(&format!("/api/fs/file?path={}", q("2026-11-04/task-a/task.json")), &cookie, Body::from(b"{}".to_vec())).await;
    let listing = h.get(&format!("/api/fs/dir?path={}", q("2026-11-04/task-a")), Some(&cookie)).await;
    assert_eq!(listing.status, 200, "{}", listing.text());
    let names: Vec<String> = listing.json().as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["result.png", "task.json"]);
    assert!(listing.json()[0]["is_dir"].is_boolean());
}

#[tokio::test]
async fn boards_roundtrip_rename_and_names() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let path = "画板/测试.ugcboard.json";
    let read = h.get(&format!("/api/boards?path={}", q(path)), Some(&cookie)).await;
    assert_eq!(read.status, 200);
    assert_eq!(read.json(), serde_json::json!({ "main": null, "bak": null, "version": null }));
    assert_eq!(h.put(&format!("/api/boards?path={}", q(path)), &cookie, r#"{"format_version":1}"#).await.status, 204);
    assert_eq!(h.get(&format!("/api/boards?path={}", q(path)), Some(&cookie)).await.json()["main"], r#"{"format_version":1}"#);
    assert_eq!(h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(&cookie)).await.json(), serde_json::json!(["测试.ugcboard.json"]));
    let rename = h
        .send(
            Method::POST,
            "/api/boards/rename",
            Some(&cookie),
            serde_json::json!({ "from": path, "to": "画板/改名.ugcboard.json" }).to_string(),
        )
        .await;
    assert_eq!(rename.status, 204, "{}", rename.text());
    assert_eq!(h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(&cookie)).await.json(), serde_json::json!(["改名.ugcboard.json"]));
    let other = h.session(OTHER_KEY).await;
    assert_eq!(h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(&other)).await.json(), serde_json::json!([]));
}

#[tokio::test]
async fn unauthenticated_requests_are_401() {
    let h = Harness::new();
    for uri in ["/api/settings", "/api/fs/file?path=a.txt", "/api/boards?path=a"] {
        assert_eq!(h.get(uri, None).await.status, 401, "{uri}");
    }
    assert_eq!(h.send(Method::POST, "/api/log", None, "{}").await.status, 401);
}

#[tokio::test]
async fn path_traversal_absolute_and_symlink_are_403() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    for bad in ["../outside.txt", "/etc/passwd", "C:/Windows/win.ini", "a/../../x", ".."] {
        for uri in [format!("/api/fs/file?path={}", q(bad)), format!("/api/boards?path={}", q(bad))] {
            let got = h.get(&uri, Some(&cookie)).await;
            assert_eq!(got.status, 403, "GET {uri} → {} {}", got.status, got.text());
            let written = h.put(&uri, &cookie, Body::from(vec![1u8])).await;
            assert!(written.status == 403 || written.status == 405, "PUT {uri} → {}", written.status);
        }
        let create = h.put(&format!("/api/fs/file?path={}", q(bad)), &cookie, Body::from(vec![1u8])).await;
        assert_eq!(create.status, 403, "新建 {bad}");
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "外面").unwrap();
    if symlink_dir(outside.path(), &h.user_root(GOOD_KEY).join("link")) {
        let got = h.get("/api/fs/file?path=link/secret.txt", Some(&cookie)).await;
        assert_eq!(got.status, 403, "符号链接越界：{}", got.text());
    }
}

#[tokio::test]
async fn log_event_accepts_known_kind_and_rejects_unknown() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let ok = h
        .send(Method::POST, "/api/log", Some(&cookie), serde_json::json!({ "kind": "connection", "fields": { "ok": true } }).to_string())
        .await;
    assert_eq!(ok.status, 204, "{}", ok.text());
    assert!(h.user_root(GOOD_KEY).join(".kacha").join("diagnostics.log").exists());
    let bad = h.send(Method::POST, "/api/log", Some(&cookie), serde_json::json!({ "kind": "bogus", "fields": {} }).to_string()).await;
    assert_eq!(bad.status, 400);
}

// ---- #27：画板版本校验与过期保存 ----

#[tokio::test]
async fn board_read_returns_content_version_and_stale_write_is_409() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let path = "画板/协作.ugcboard.json";
    let uri = format!("/api/boards?path={}", q(path));
    assert_eq!(h.get(&uri, Some(&cookie)).await.json(), serde_json::json!({ "main": null, "bak": null, "version": null }));

    assert_eq!(h.put(&uri, &cookie, r#"{"format_version":1,"title":"一页"}"#).await.status, 204);
    let v1 = h.get(&uri, Some(&cookie)).await.json()["version"].as_str().unwrap().to_string();
    assert_eq!(v1.len(), 64, "版本是内容 SHA-256");

    assert_eq!(h.put(&format!("{uri}&version={v1}"), &cookie, r#"{"format_version":1,"title":"A 页"}"#).await.status, 204);
    let stale = h.put(&format!("{uri}&version={v1}"), &cookie, r#"{"format_version":1,"title":"B 页"}"#).await;
    assert_eq!(stale.status, 409, "{}", stale.text());
    assert_eq!(stale.json()["code"], "board_conflict");
    assert!(stale.json()["message"].as_str().unwrap().contains("画板已在别处修改，请重新载入"));
    assert_eq!(h.get(&uri, Some(&cookie)).await.json()["main"], r#"{"format_version":1,"title":"A 页"}"#);
    assert_eq!(h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(&cookie)).await.json(), serde_json::json!(["协作.ugcboard.json"]));
}

#[tokio::test]
async fn versioned_write_to_missing_board_is_conflict_not_recreate() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let old = format!("/api/boards?path={}&version={}", q("画板/旧名.ugcboard.json"), "00".repeat(32));
    let res = h.put(&old, &cookie, r#"{"format_version":1}"#).await;
    assert_eq!(res.status, 409, "旧名已改名时不能再凭空新建：{}", res.text());
    assert_eq!(res.json()["code"], "board_missing");
    assert_eq!(h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(&cookie)).await.json(), serde_json::json!([]));
}

#[tokio::test]
async fn create_only_board_write_conflicts_instead_of_overwriting() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let uri = format!("/api/boards?path={}&create_only=true", q("画板/新建.ugcboard.json"));
    assert_eq!(h.put(&uri, &cookie, r#"{"format_version":1}"#).await.status, 204);
    let again = h.put(&uri, &cookie, r#"{"format_version":2}"#).await;
    assert_eq!(again.status, 409);
    assert_eq!(again.json()["code"], "already_exists");
    assert_eq!(h.get(&format!("/api/boards?path={}", q("画板/新建.ugcboard.json")), Some(&cookie)).await.json()["main"], r#"{"format_version":1}"#);
}

#[tokio::test]
async fn rename_missing_board_is_clear_error_and_version_guarded() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let missing = h
        .send(Method::POST, "/api/boards/rename", Some(&cookie), serde_json::json!({ "from": "画板/旧名.ugcboard.json", "to": "画板/又改名.ugcboard.json" }).to_string())
        .await;
    assert_eq!(missing.status, 404, "源文件不存在不能静默成功：{}", missing.text());
    assert_eq!(missing.json()["code"], "not_found");

    let path = "画板/原名.ugcboard.json";
    h.put(&format!("/api/boards?path={}", q(path)), &cookie, r#"{"v":1}"#).await;
    let v1 = h.get(&format!("/api/boards?path={}", q(path)), Some(&cookie)).await.json()["version"].as_str().unwrap().to_string();
    h.put(&format!("/api/boards?path={}&version={v1}", q(path)), &cookie, r#"{"v":2}"#).await;
    let stale = h
        .send(Method::POST, "/api/boards/rename", Some(&cookie), serde_json::json!({ "from": path, "to": "画板/新名.ugcboard.json", "version": v1 }).to_string())
        .await;
    assert_eq!(stale.status, 409, "{}", stale.text());
    assert_eq!(stale.json()["code"], "board_conflict");
    assert!(h.user_root(GOOD_KEY).join(path).exists(), "过期改名不能移动文件");
    assert!(!h.user_root(GOOD_KEY).join("画板/新名.ugcboard.json").exists());
}
