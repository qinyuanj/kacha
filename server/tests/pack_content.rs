//! 画板包按内容去重上传（#62）：问已有、开暂存、逐份上传（核对 sha256、64 MB 上限、名额 / 超时 / 余量 / 取消沿用上传规则）、
//! 按落盘清单合并（同次导入内相同内容硬链接、参考图快照比对 task.json）。进程内对 router。
mod common;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const TASK_A: &str = "2026-09-16/20260916T010000Z-0000000a";
const TASK_B: &str = "2026-09-16/20260916T020000Z-0000000b";
const RED: &[u8] = b"\x89PNG red result";
const BLUE: &[u8] = b"\x89PNG blue result";

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn record_a() -> Vec<u8> {
    br#"{"task_id":"20260916T010000Z-0000000a","references":[]}"#.to_vec()
}

/// 任务 B 的参考图快照是任务 A 的结果图；task.json 记了快照的 sha256。
fn record_b(snapshot_sha: &str) -> Vec<u8> {
    format!(r#"{{"task_id":"20260916T020000Z-0000000b","references":[{{"file":"reference-1.png","sha256":"{snapshot_sha}"}}]}}"#).into_bytes()
}

fn units() -> serde_json::Value {
    serde_json::json!([{ "path": TASK_A, "identity": "task.json" }, { "path": TASK_B, "identity": "task.json" }])
}

fn files(b_record: &[u8]) -> serde_json::Value {
    serde_json::json!([
        { "path": format!("{TASK_A}/result.png"), "sha256": sha(RED) },
        { "path": format!("{TASK_A}/task.json"), "sha256": sha(&record_a()) },
        { "path": format!("{TASK_B}/reference-1.png"), "sha256": sha(RED) },
        { "path": format!("{TASK_B}/result.png"), "sha256": sha(BLUE) },
        { "path": format!("{TASK_B}/task.json"), "sha256": sha(b_record) },
    ])
}

async fn open_staging(h: &Harness, cookie: &str) -> String {
    let reply = h.send(Method::POST, "/api/packs/staging", Some(cookie), Body::empty()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.json()["id"].as_str().unwrap().to_string()
}

async fn put_content(h: &Harness, cookie: &str, staging: &str, sha256: &str, bytes: &[u8]) -> Reply {
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/packs/staging/{staging}/contents/{sha256}"))
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_LENGTH, bytes.len().to_string());
    reply_of(h.app.clone().oneshot(req.body(Body::from(bytes.to_vec())).unwrap()).await.unwrap()).await
}

async fn reply_of(res: axum::response::Response) -> Reply {
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Reply { status, headers, body }
}

fn staging_dirs(h: &Harness, key: &str) -> Vec<String> {
    let dir = h.user_root(key).join(".kacha/pack-content");
    std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()
}

/// 上传每份内容（相同内容只传一次）后按落盘清单合并。
async fn import_two_tasks(h: &Harness, cookie: &str, b_record: &[u8]) -> Reply {
    let staging = open_staging(h, cookie).await;
    for bytes in [RED, BLUE, &record_a()[..], b_record] {
        let reply = put_content(h, cookie, &staging, &sha(bytes), bytes).await;
        assert_eq!(reply.status, 204, "{}", reply.text());
    }
    let body = serde_json::json!({ "units": units(), "files": files(b_record) }).to_string();
    h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=m1"), Some(cookie), body).await
}

#[tokio::test]
async fn same_content_within_one_import_is_written_once_and_hard_linked() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = import_two_tasks(&h, &cookie, &record_b(&sha(RED))).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let outcomes: Vec<String> = reply.json()["outcomes"].as_array().unwrap().iter().map(|o| o["outcome"].as_str().unwrap().to_string()).collect();
    assert_eq!(outcomes, vec!["moved", "moved"]);
    assert_eq!(reply.json()["bytes"], (RED.len() + BLUE.len() + record_a().len() + record_b(&sha(RED)).len()) as u64, "按上传的内容计字节，不重复计");
    let root = h.user_root(GOOD_KEY);
    let (result, snapshot) = (root.join(TASK_A).join("result.png"), root.join(TASK_B).join("reference-1.png"));
    assert_eq!(std::fs::read(&result).unwrap(), RED);
    assert_eq!(std::fs::read(&snapshot).unwrap(), RED);
    assert!(same_file::is_same_file(&result, &snapshot).unwrap(), "同次导入内相同内容应是硬链接");
    assert_eq!(std::fs::read(root.join(TASK_B).join("result.png")).unwrap(), BLUE);
    assert!(staging_dirs(&h, GOOD_KEY).is_empty(), "合并结束删除暂存");
    assert!(!std::fs::read_dir(&root).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".tmp")), "不留导入临时目录");
}

#[tokio::test]
async fn existing_reports_identity_sha256_of_units_already_on_the_server() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    std::fs::create_dir_all(root.join(TASK_A)).unwrap();
    std::fs::write(root.join(TASK_A).join("task.json"), record_a()).unwrap();
    std::fs::create_dir_all(root.join("导入参考图")).unwrap();
    std::fs::write(root.join("导入参考图/猫.png"), b"cat").unwrap();
    // 目录在、身份文件不在：读不出。
    std::fs::create_dir_all(root.join(TASK_B)).unwrap();
    let body = serde_json::json!([
        { "path": TASK_A, "identity": "task.json" },
        { "path": TASK_B, "identity": "task.json" },
        { "path": "2026-09-16/20260916T090000Z-000000ff", "identity": "task.json" },
        { "path": "导入参考图/猫.png", "identity": null },
        { "path": "导入参考图/狗.png", "identity": null },
    ]);
    let reply = h.send(Method::POST, "/api/packs/existing", Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(
        reply.json(),
        serde_json::json!([
            { "path": TASK_A, "state": "present", "sha256": sha(&record_a()) },
            { "path": TASK_B, "state": "unreadable" },
            { "path": "2026-09-16/20260916T090000Z-000000ff", "state": "absent" },
            { "path": "导入参考图/猫.png", "state": "present", "sha256": sha(b"cat") },
            { "path": "导入参考图/狗.png", "state": "absent" },
        ])
    );
    let escape = serde_json::json!([{ "path": "../x", "identity": null }]);
    let reply = h.send(Method::POST, "/api/packs/existing", Some(&cookie), escape.to_string()).await;
    assert!(reply.status.is_client_error(), "越界路径必须被拒：{}", reply.status);
}

/// 问已有的响应逐字节固定（#81）：已有、缺少、读不了三种状态的字段与字段顺序都不随实现改动变化。
#[tokio::test]
async fn existing_response_bytes_are_fixed_for_present_absent_and_unreadable_units() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    std::fs::create_dir_all(root.join(TASK_A)).unwrap();
    std::fs::write(root.join(TASK_A).join("task.json"), b"task a").unwrap();
    std::fs::create_dir_all(root.join(TASK_B)).unwrap();
    std::fs::create_dir_all(root.join("导入参考图")).unwrap();
    std::fs::write(root.join("导入参考图/猫.png"), b"cat").unwrap();
    let body = serde_json::json!([
        { "path": TASK_A, "identity": "task.json" },
        { "path": TASK_B, "identity": "task.json" },
        { "path": "导入参考图/猫.png", "identity": null },
        { "path": "导入参考图/狗.png", "identity": null },
    ]);
    let reply = h.send(Method::POST, "/api/packs/existing", Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(
        reply.text(),
        concat!(
            r#"[{"path":"2026-09-16/20260916T010000Z-0000000a","sha256":"2f1c6ae9742efa12f5d8a5129b61c2c0150c15ffa56a3aa87aab61362a944e27","state":"present"},"#,
            r#"{"path":"2026-09-16/20260916T020000Z-0000000b","state":"unreadable"},"#,
            r#"{"path":"导入参考图/猫.png","sha256":"77af778b51abd4a3c51c5ddd97204a9c3ae614ebccb75a606c3b6865aed6744e","state":"present"},"#,
            r#"{"path":"导入参考图/狗.png","state":"absent"}]"#,
        )
    );
}

#[tokio::test]
async fn content_whose_sha256_differs_from_the_declared_one_is_rejected_as_corrupt() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let staging = open_staging(&h, &cookie).await;
    let reply = put_content(&h, &cookie, &staging, &sha(BLUE), RED).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
    assert_eq!(reply.json()["code"], "invalid_pack");
    let dir = h.user_root(GOOD_KEY).join(".kacha/pack-content").join(staging_dirs(&h, GOOD_KEY)[0].clone());
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0, "不一致的内容不留在暂存里");
    let bad = put_content(&h, &cookie, &staging, "not-a-sha", RED).await;
    assert_eq!(bad.status, 400, "{}", bad.text());
}

#[tokio::test]
async fn reference_snapshot_that_disagrees_with_task_json_is_rejected_and_nothing_is_moved() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    // task.json 说快照是蓝图，落盘清单里快照却是红图。
    let reply = import_two_tasks(&h, &cookie, &record_b(&sha(BLUE))).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
    assert_eq!(reply.json()["code"], "invalid_pack");
    assert!(reply.json()["message"].as_str().unwrap().contains("reference-1.png"), "{}", reply.text());
    let root = h.user_root(GOOD_KEY);
    assert!(!root.join(TASK_A).exists() && !root.join(TASK_B).exists(), "不合格时一个单元都不移入");
    assert!(staging_dirs(&h, GOOD_KEY).is_empty(), "失败也删除暂存");
}

#[tokio::test]
async fn importing_again_reports_identical_and_a_missing_content_is_corrupt() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(import_two_tasks(&h, &cookie, &record_b(&sha(RED))).await.status, 200);
    // 问已有之后有人抢先导入了同一任务：合并时照常比对 task.json，判为一致、不覆盖。
    let again = import_two_tasks(&h, &cookie, &record_b(&sha(RED))).await;
    assert_eq!(again.status, 200, "{}", again.text());
    assert!(again.json()["outcomes"].as_array().unwrap().iter().all(|o| o["outcome"] == "identical"), "{}", again.text());

    let staging = open_staging(&h, &cookie).await;
    let body = serde_json::json!({ "units": [{ "path": "2026-09-17/20260917T000000Z-0000000c", "identity": "task.json" }], "files": [{ "path": "2026-09-17/20260917T000000Z-0000000c/task.json", "sha256": sha(b"never uploaded") }] });
    let reply = h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=m2"), Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
    // 不属于任何合并单元的路径、越界路径：拒绝。
    let staging = open_staging(&h, &cookie).await;
    put_content(&h, &cookie, &staging, &sha(RED), RED).await;
    for path in ["别处/x.png", "../x.png"] {
        let body = serde_json::json!({ "units": units(), "files": [{ "path": path, "sha256": sha(RED) }] });
        let reply = h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=m3"), Some(&cookie), body.to_string()).await;
        assert!(reply.status.is_client_error(), "{path}: {}", reply.text());
    }
}

#[tokio::test]
async fn content_over_the_64_mb_body_limit_is_rejected_with_413() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let staging = open_staging(&h, &cookie).await;
    // 声明的长度超限：不读请求体就拒绝。
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/packs/staging/{staging}/contents/{}", sha(RED)))
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_LENGTH, (kacha_server::MAX_BODY_BYTES + 1).to_string())
        .body(Body::empty())
        .unwrap();
    assert_eq!(h.app.clone().oneshot(req).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    // 没有 Content-Length、实际超限：写到上限即拒绝并删掉半成品。
    let big = vec![0u8; kacha_server::MAX_BODY_BYTES + 1];
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/packs/staging/{staging}/contents/{}", sha(&big)))
        .header(header::COOKIE, &cookie)
        .body(Body::from_stream(futures_util::stream::iter(big.chunks(1 << 20).map(|c| Ok::<_, std::io::Error>(c.to_vec())).collect::<Vec<_>>())))
        .unwrap();
    assert_eq!(h.app.clone().oneshot(req).await.unwrap().status(), StatusCode::PAYLOAD_TOO_LARGE);
    let dir = h.user_root(GOOD_KEY).join(".kacha/pack-content").join(&staging_dirs(&h, GOOD_KEY)[0]);
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
}

// ---- 沿用上传规则：不占名额、空闲超时、余量预检、按操作 id 取消（#60）----

type BodySender = tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>;

fn stalled_content(cookie: &str, staging: &str, op: &str, content_length: u64) -> (BodySender, Request<Body>) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(1);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/packs/staging/{staging}/contents/{}?op={op}&done=100&total=10000", sha(b"whatever")))
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_LENGTH, content_length.to_string());
    (tx, req.body(Body::from_stream(stream)).unwrap())
}

fn partial_files(h: &Harness, staging: &str) -> usize {
    let dir = h.user_root(GOOD_KEY).join(".kacha/pack-content").join(format!("{staging}.staging.tmp"));
    std::fs::read_dir(dir).into_iter().flatten().count()
}

#[tokio::test]
async fn stalled_content_uploads_do_not_hold_heavy_slots_and_report_progress_across_contents() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let staging = open_staging(&h, &cookie).await;
    let mut held = Vec::new();
    for i in 0..kacha_server::limits::HEAVY_CONCURRENCY {
        let (tx, req) = stalled_content(&cookie, &staging, &format!("c{i}"), 4096);
        held.push((tx.clone(), tokio::spawn(h.app.clone().oneshot(req))));
        tx.send(Ok(vec![1u8; 1024])).await.unwrap();
    }
    for _ in 0..500 {
        if partial_files(&h, &staging) == 4 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(h.state.heavy().active(), 0, "内容上传不拿大请求名额");
    // 进度跨各份累计：本份之前已传 100、全部 10000。
    for _ in 0..500 {
        let p = h.get("/api/packs/ops/c0", Some(&cookie)).await;
        if p.status == 200 && p.json()["done"] == 1124 {
            assert_eq!(p.json()["total"], 10000);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(h.get("/api/packs/ops/c0", Some(&cookie)).await.json()["done"], 1124);

    // 取消其中一份：409，删掉它写了一半的文件，其余不受影响。
    assert_eq!(h.send(Method::POST, "/api/packs/ops/c0/cancel", Some(&cookie), Body::empty()).await.status, 204);
    // 请求体发送端留着：丢掉它请求体就结束了，会先回 422 而不是取消。
    let (_sender, first) = held.remove(0);
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), first).await.unwrap().unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(partial_files(&h, &staging), 3);
    assert!(held.iter().all(|(_, p)| !p.is_finished()));
}

#[tokio::test(start_paused = true)]
async fn content_upload_idle_for_over_60_seconds_returns_408_and_deletes_the_partial_file() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let staging = open_staging(&h, &cookie).await;
    let (tx, req) = stalled_content(&cookie, &staging, "idle", 4096);
    let pending = tokio::spawn(h.app.clone().oneshot(req));
    tx.send(Ok(vec![7u8; 1024])).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(61)).await;
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), pending).await.unwrap().unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::REQUEST_TIMEOUT);
    assert_eq!(partial_files(&h, &staging), 0);
    drop(tx);
}

#[tokio::test]
async fn content_that_does_not_fit_above_the_free_space_threshold_returns_507() {
    let h = Harness::with_free_space(Some(kacha_server::limits::DEFAULT_MIN_FREE_BYTES + 10));
    let cookie = h.session(GOOD_KEY).await;
    let staging = open_staging(&h, &cookie).await;
    let reply = put_content(&h, &cookie, &staging, &sha(RED), RED).await;
    assert_eq!(reply.status, 507, "{}", reply.text());
    assert_eq!(partial_files(&h, &staging), 0);
}

#[tokio::test]
async fn staging_is_swept_with_other_upload_temps_once_expired_and_can_be_discarded() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let old = open_staging(&h, &cookie).await;
    put_content(&h, &cookie, &old, &sha(RED), RED).await;
    let dir = |id: &str| h.user_root(GOOD_KEY).join(".kacha/pack-content").join(format!("{id}.staging.tmp"));
    // harness 时钟与真实时间无关：显式把暂存的修改时间设成 2 小时前 / 刚刚。
    let at = |path: &std::path::Path, t: std::time::SystemTime| filetime::set_file_mtime(path, filetime::FileTime::from_system_time(t)).unwrap();
    at(&dir(&old), h.now() - std::time::Duration::from_secs(2 * 3600));
    let fresh = open_staging(&h, &cookie).await;
    assert!(!dir(&old).exists(), "过期的去重暂存在下次上传开始时回收");
    at(&dir(&fresh), h.now());
    // 整包上传开始时也回收它；未过期的保留。
    let other = open_staging(&h, &cookie).await;
    assert!(dir(&fresh).exists() && dir(&other).exists());
    at(&dir(&fresh), h.now() - std::time::Duration::from_secs(2 * 3600));
    at(&dir(&other), h.now());
    assert_eq!(h.send(Method::POST, "/api/packs/uploads", Some(&cookie), Body::from(b"zip".to_vec())).await.status, 200);
    assert!(!dir(&fresh).exists(), "整包上传开始时也回收过期的去重暂存");
    assert_eq!(h.send(Method::DELETE, &format!("/api/packs/staging/{other}"), Some(&cookie), Body::empty()).await.status, 204);
    assert!(!dir(&other).exists());
}
