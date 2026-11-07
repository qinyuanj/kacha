//! 画板包 HTTP 接口（#24）：导出下载流、流式上传导入、按操作隔离的取消、507、全局并发排队。进程内对 router。
mod common;

use std::io::Read;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use common::*;
use http_body_util::BodyExt;
use tower::ServiceExt;

const TASK: &str = "2026-09-16/20260916T010000Z-0000000a";

fn png() -> Vec<u8> {
    let mut b = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    b.extend_from_slice(&[1, 2, 3, 4]);
    b
}

fn seed_task(h: &Harness, key: &str) {
    let dir = h.user_root(key).join(TASK);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), format!("{{\"task_id\":\"{}\"}}", TASK.split('/').nth(1).unwrap())).unwrap();
    std::fs::write(dir.join("result.png"), png()).unwrap();
}

fn export_spec() -> serde_json::Value {
    serde_json::json!({
        "texts": [
            { "entry": "manifest.json", "text": "{\"pack_format_version\":1,\"app_version\":\"0.3.2\",\"boards\":[\"画板/a.ugcboard.json\"]}" },
            { "entry": "画板/a.ugcboard.json", "text": "{\"format_version\":1,\"title\":\"a\"}" }
        ],
        "task_dirs": [TASK],
        "files": [{ "source": "别处/猫.png", "entry": "导入参考图/abc.png" }]
    })
}

fn zip_entries(bytes: &[u8]) -> Vec<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect()
}

#[tokio::test]
async fn export_streams_a_zip_download_with_all_entries() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, GOOD_KEY);
    let root = h.user_root(GOOD_KEY);
    std::fs::create_dir_all(root.join("别处")).unwrap();
    std::fs::write(root.join("别处/猫.png"), png()).unwrap();
    let reply = h.send(Method::POST, "/api/packs/export?op=e1", Some(&cookie), export_spec().to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.headers.get(header::CONTENT_TYPE).unwrap(), "application/zip");
    assert!(reply.headers.get(header::CONTENT_DISPOSITION).unwrap().to_str().unwrap().contains("attachment"));
    let names = zip_entries(&reply.body);
    assert!(names.contains(&"manifest.json".to_string()) && names.contains(&format!("{TASK}/result.png")) && names.contains(&"导入参考图/abc.png".to_string()), "{names:?}");
    // 下载流不落临时文件。
    assert!(!std::fs::read_dir(&root).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".tmp")));
}

#[tokio::test]
async fn export_rejects_absolute_source_and_symlink_escape() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, GOOD_KEY);
    let mut spec = export_spec();
    spec["files"] = serde_json::json!([{ "source": "/etc/hostname", "entry": "导入参考图/x.png" }]);
    let reply = h.send(Method::POST, "/api/packs/export?op=e2", Some(&cookie), spec.to_string()).await;
    assert_eq!(reply.status, 422, "任意文件读必须被拒：{}", reply.text());
    assert!(reply.text().contains("越界"));

    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.png"), png()).unwrap();
    if symlink_dir(outside.path(), &h.user_root(GOOD_KEY).join("link")) {
        let mut spec = export_spec();
        spec["files"] = serde_json::json!([{ "source": "link/secret.png", "entry": "导入参考图/x.png" }]);
        let reply = h.send(Method::POST, "/api/packs/export?op=e3", Some(&cookie), spec.to_string()).await;
        assert_eq!(reply.status, 422, "符号链接越界必须被拒：{}", reply.text());
    }
}

/// 走完导入流程：流式上传 → 条目 / 文本 → 合并；临时文件在结束后删除。
async fn upload_pack(h: &Harness, cookie: &str, bytes: Vec<u8>) -> String {
    let reply = h.send(Method::POST, "/api/packs/uploads", Some(cookie), Body::from(bytes)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.json()["id"].as_str().unwrap().to_string()
}

fn fixture_pack() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../client/fixtures/packs/v0.3.2-flash-layers.ugcpack")).unwrap()
}

#[tokio::test]
async fn import_uploads_streams_merges_and_deletes_temp_file() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let id = upload_pack(&h, &cookie, fixture_pack()).await;
    let root = h.user_root(GOOD_KEY);
    assert!(root.join(".kacha/packs").join(format!("{id}.ugcpack.tmp")).is_file());

    let entries = h.get(&format!("/api/packs/uploads/{id}/entries"), Some(&cookie)).await;
    let names: Vec<String> = entries.json().as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert!(names.contains(&"manifest.json".to_string()));
    let texts = h.send(Method::POST, &format!("/api/packs/uploads/{id}/texts"), Some(&cookie), serde_json::json!(["manifest.json", "画板/旧版画板.ugcboard.json"]).to_string()).await;
    assert!(texts.json()["manifest.json"].as_str().unwrap().contains("0.3.2"));

    let body = serde_json::json!({
        "units": [
            { "path": TASK, "identity": "task.json" },
            { "path": "导入参考图/5e4b079355f5f06363744c0778c5174040645713e06e6877eae22f573d46e6b0.png", "identity": null }
        ],
        "duplicates": []
    });
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i1"), Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.json()["outcomes"][0]["outcome"], "moved");
    let dir = root.join(TASK);
    assert!(dir.join("layers/01.png").is_file() && dir.join("layers.json").is_file(), "v0.3.x 图层与 layers.json 都要导入");
    assert!(!root.join(".kacha/packs").join(format!("{id}.ugcpack.tmp")).exists(), "导入结束删除临时文件");
}

#[tokio::test]
async fn import_rejects_the_v1_bare_unit_array_body() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let id = upload_pack(&h, &cookie, fixture_pack()).await;
    let bare = serde_json::json!([{ "path": TASK, "identity": "task.json" }]);
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=v1"), Some(&cookie), bare.to_string()).await;
    assert_eq!(reply.status, 400, "{}", reply.text());
    assert!(!h.user_root(GOOD_KEY).join(TASK).exists(), "请求体不合格时不写入");
}

// ---- 过期上传暂存的回收（#56）----

/// 预置一份上传暂存，修改时间设为 harness 时钟往前 `age`（harness 时钟与真实时间无关，必须显式设）。
fn seed_upload_temp(h: &Harness, key: &str, name: &str, age: std::time::Duration) -> std::path::PathBuf {
    let dir = h.user_root(key).join(".kacha/packs");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    std::fs::write(&file, b"half a pack").unwrap();
    set_mtime(&file, h.now() - age);
    file
}

fn set_mtime(path: &std::path::Path, at: std::time::SystemTime) {
    // Windows 改修改时间要写权限，只读打开会被拒绝。
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(at).unwrap();
}

fn upload_temp(h: &Harness, key: &str, id: &str) -> std::path::PathBuf {
    h.user_root(key).join(".kacha/packs").join(format!("{id}.ugcpack.tmp"))
}

const HOUR: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[tokio::test]
async fn upload_sweeps_expired_upload_temp_files_and_keeps_the_new_one() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let old = seed_upload_temp(&h, GOOD_KEY, "0ld.ugcpack.tmp", std::time::Duration::ZERO);
    h.advance(HOUR + std::time::Duration::from_secs(60));

    let id = upload_pack(&h, &cookie, fixture_pack()).await;

    assert!(!old.exists(), "超过 1 小时的上传临时文件在下次上传时被删");
    assert!(upload_temp(&h, GOOD_KEY, &id).is_file(), "本次上传的文件保留");
}

#[tokio::test]
async fn upload_keeps_unexpired_temp_files_and_other_users_files() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    // 另一个页面正在上传或等待导入：59 分钟前最后写入。
    let busy = seed_upload_temp(&h, GOOD_KEY, "b05y.ugcpack.tmp", HOUR - std::time::Duration::from_secs(60));
    // 不是上传暂存的文件、别的用户的过期暂存，都不归本次上传清理。
    let unrelated = seed_upload_temp(&h, GOOD_KEY, "notes.txt", 2 * HOUR);
    let others = seed_upload_temp(&h, OTHER_KEY, "07he7.ugcpack.tmp", 2 * HOUR);

    let id = upload_pack(&h, &cookie, fixture_pack()).await;

    assert!(busy.is_file(), "未过期的上传临时文件不被删");
    assert!(unrelated.is_file() && others.is_file());
    assert!(upload_temp(&h, GOOD_KEY, &id).is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn upload_sweep_is_repeatable_and_survives_delete_failures() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let stale = seed_upload_temp(&h, GOOD_KEY, "57a1e.ugcpack.tmp", 2 * HOUR);
    let fresh = seed_upload_temp(&h, GOOD_KEY, "f4e5h.ugcpack.tmp", std::time::Duration::ZERO);
    // 删不掉的过期暂存：只读目录里的文件无法删除。
    let stuck = h.user_root(GOOD_KEY).join(".kacha/packs/5tuck.ugcpack.tmp");
    std::fs::create_dir_all(&stuck).unwrap();
    std::fs::write(stuck.join("part"), b"x").unwrap();
    std::fs::set_permissions(&stuck, std::fs::Permissions::from_mode(0o555)).unwrap();
    set_mtime(&stuck, h.now() - 2 * HOUR);

    let first = upload_pack(&h, &cookie, fixture_pack()).await;
    // harness 时钟比真实时间超前，把刚上传的文件对齐到时钟，模拟它仍在等待导入。
    set_mtime(&upload_temp(&h, GOOD_KEY, &first), h.now());
    let second = upload_pack(&h, &cookie, fixture_pack()).await;

    std::fs::set_permissions(&stuck, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!stale.exists(), "过期文件被删");
    assert!(stuck.join("part").exists(), "删除失败不影响本次上传（两次上传都已成功返回）");
    assert!(fresh.is_file(), "重复执行不误删未过期文件");
    assert!(upload_temp(&h, GOOD_KEY, &first).is_file() && upload_temp(&h, GOOD_KEY, &second).is_file());
}

#[tokio::test]
async fn cancel_only_affects_the_named_operation_and_cleans_temp() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let id = upload_pack(&h, &cookie, fixture_pack()).await;
    let body = serde_json::json!({ "units": [{ "path": TASK, "identity": "task.json" }], "duplicates": [] }).to_string();
    // 先取消操作 i-cancel，再执行：该操作应取消，其他操作不受影响。
    assert_eq!(h.send(Method::POST, "/api/packs/ops/i-cancel/cancel", Some(&cookie), Body::empty()).await.status, 204);
    // 已结束 / 不存在的操作的取消是幂等的；真正进行中的操作由 worker 在检查点读到标记。
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i-other"), Some(&cookie), body.clone()).await;
    assert_eq!(reply.status, 200, "取消别的操作不能影响本操作：{}", reply.text());
    // 上传在导入后被清理；对同一上传再导入是 404。
    let again = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i-other2"), Some(&cookie), body).await;
    assert_eq!(again.status, 404);
    // 放弃上传：DELETE 清掉临时文件。
    let id2 = upload_pack(&h, &cookie, fixture_pack()).await;
    assert_eq!(h.send(Method::DELETE, &format!("/api/packs/uploads/{id2}"), Some(&cookie), Body::empty()).await.status, 204);
    assert!(!h.user_root(GOOD_KEY).join(".kacha/packs").join(format!("{id2}.ugcpack.tmp")).exists());
}

#[tokio::test]
async fn insufficient_disk_returns_507_on_writes_and_packs() {
    let h = Harness::with_free_space(Some(1024));
    let cookie = h.session(GOOD_KEY).await;
    let file = h.put(&format!("/api/fs/file?path={}", q("a/b.png")), &cookie, Body::from(vec![1u8])).await;
    assert_eq!(file.status, 507);
    assert_eq!(file.json()["message"], "服务器空间不足，请联系管理员");
    let settings = h.put("/api/settings", &cookie, "{}").await;
    assert_eq!(settings.status, 507);
    let board = h.put(&format!("/api/boards?path={}", q("画板/a.ugcboard.json")), &cookie, "{}").await;
    assert_eq!(board.status, 507);
    let up = h.send(Method::POST, "/api/packs/uploads", Some(&cookie), Body::from(fixture_pack())).await;
    assert_eq!(up.status, 507);
    let ex = h.send(Method::POST, "/api/packs/export?op=e9", Some(&cookie), export_spec().to_string()).await;
    assert_eq!(ex.status, 507);
    let reference = h.send(Method::POST, "/api/upload/reference", Some(&cookie), Body::from(vec![0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).await;
    assert_eq!(reference.status, 507, "上传参考图也是写入：{}", reference.text());
    // 读接口不受 507 影响。
    assert_eq!(h.get("/api/boards/names?dir=%E7%94%BB%E6%9D%BF", Some(&cookie)).await.status, 200);
    // 余量恢复后可写。
    let ok = Harness::with_free_space(Some(30 * 1024 * 1024 * 1024));
    let c2 = ok.session(GOOD_KEY).await;
    assert_eq!(ok.put("/api/settings", &c2, "{}").await.status, 204);
}

/// 导出进行中取消：worker 阻塞在背压时读到该操作的取消标记即中止，下载流以错误结束。
#[tokio::test]
async fn cancelling_an_in_flight_export_aborts_its_stream_only() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    let dir = root.join(TASK);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), b"{}").unwrap();
    std::fs::write(dir.join("result.bin"), vec![7u8; 12 * 1024 * 1024]).unwrap();
    let spec = serde_json::json!({ "texts": [], "task_dirs": [TASK], "files": [] }).to_string();
    let req = Request::builder().method(Method::POST).uri("/api/packs/export?op=c1").header(header::COOKIE, &cookie).body(Body::from(spec)).unwrap();
    let res = h.app.clone().oneshot(req).await.unwrap();
    let body = res.into_body();
    // 等 worker 真的在跑，再取消。
    for _ in 0..50 {
        let p = h.get("/api/packs/ops/c1", Some(&cookie)).await;
        if p.status == 200 && p.json()["done"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(h.send(Method::POST, "/api/packs/ops/c1/cancel", Some(&cookie), Body::empty()).await.status, 204);
    let err = body.collect().await.unwrap_err();
    assert!(err.to_string().contains("已取消"), "取消应以错误中止流：{err}");
    // 操作已注销（进度接口回 204，不当错误）；不留临时文件。
    assert_eq!(h.get("/api/packs/ops/c1", Some(&cookie)).await.status, 204);
}

#[tokio::test]
async fn fifth_concurrent_heavy_request_queues_until_a_slot_frees() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    // 足够大：4 格 channel × 1 MB 背压后 worker 仍没写完。
    let dir = root.join(TASK);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), b"{}").unwrap();
    std::fs::write(dir.join("result.bin"), vec![7u8; 12 * 1024 * 1024]).unwrap();
    let spec = serde_json::json!({ "texts": [], "task_dirs": [TASK], "files": [] }).to_string();

    let mut pending = Vec::new();
    for i in 0..4 {
        let req = Request::builder().method(Method::POST).uri(format!("/api/packs/export?op=q{i}")).header(header::COOKIE, &cookie).body(Body::from(spec.clone())).unwrap();
        let res = h.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        pending.push(res.into_body());
    }
    let req = Request::builder().method(Method::POST).uri("/api/packs/export?op=q4").header(header::COOKIE, &cookie).body(Body::from(spec.clone())).unwrap();
    let fifth = tokio::spawn(h.app.clone().oneshot(req));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!fifth.is_finished(), "第五个大请求必须排队");
    // 读完一个响应，腾出位置。
    let first = pending.remove(0);
    let bytes = first.collect().await.unwrap().to_bytes();
    assert_eq!(zip_entries(&bytes).len(), 2);
    let fifth_res = tokio::time::timeout(std::time::Duration::from_secs(10), fifth).await.unwrap().unwrap().unwrap();
    assert_eq!(fifth_res.status(), StatusCode::OK);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(fifth_res.into_body().collect().await.unwrap().to_bytes())).unwrap();
    let mut record = String::new();
    archive.by_name(&format!("{TASK}/task.json")).unwrap().read_to_string(&mut record).unwrap();
    assert_eq!(record, "{}");
    for body in pending {
        let _ = body.collect().await.unwrap();
    }
}

/// 上传带操作 id（#59）：总量取 Content-Length，每写一块更新已完成字节数；请求体停在半路时取消，回 409 并删掉写了一半的文件。
#[tokio::test]
async fn cancelling_a_stalled_upload_returns_409_and_deletes_the_partial_file() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(1);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/packs/uploads?op=u1")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_LENGTH, "4096")
        .body(Body::from_stream(stream))
        .unwrap();
    let pending = tokio::spawn(h.app.clone().oneshot(req));
    tx.send(Ok(vec![7u8; 1024])).await.unwrap();
    // 等第一块真的写下去，进度报出总量与已完成字节数。
    let mut progress = serde_json::Value::Null;
    for _ in 0..100 {
        let p = h.get("/api/packs/ops/u1", Some(&cookie)).await;
        if p.status == 200 && p.json()["done"].as_u64() == Some(1024) {
            progress = p.json();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(progress, serde_json::json!({ "done": 1024, "total": 4096 }), "上传进度应报出已写字节与 Content-Length");
    let packs = h.user_root(GOOD_KEY).join(".kacha/packs");
    assert_eq!(std::fs::read_dir(&packs).unwrap().count(), 1, "写了一半的临时文件在盘上");

    // 请求体停住（发送端不关），这时取消。
    assert_eq!(h.send(Method::POST, "/api/packs/ops/u1/cancel", Some(&cookie), Body::empty()).await.status, 204);
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), pending).await.expect("取消后上传应立即结束").unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["code"], "cancelled");
    assert_eq!(body["message"], "已取消");
    assert!(!packs.exists() || std::fs::read_dir(&packs).unwrap().count() == 0, "写了一半的临时文件要删掉");
    assert_eq!(h.get("/api/packs/ops/u1", Some(&cookie)).await.status, 204, "上传结束即注销操作");
    drop(tx);
}

#[tokio::test]
async fn upload_with_op_reports_full_progress_and_unregisters_when_done() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let bytes = fixture_pack();
    let reply = h.send(Method::POST, "/api/packs/uploads?op=u2", Some(&cookie), Body::from(bytes)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let id = reply.json()["id"].as_str().unwrap().to_string();
    assert!(h.user_root(GOOD_KEY).join(".kacha/packs").join(format!("{id}.ugcpack.tmp")).is_file());
    assert_eq!(h.get("/api/packs/ops/u2", Some(&cookie)).await.status, 204);
    // 操作 id 照常校验。
    assert_eq!(h.send(Method::POST, "/api/packs/uploads?op=bad%20id", Some(&cookie), Body::from(fixture_pack())).await.status, 400);
}

// ---- 包格式 v2：被省略的路径在服务端还原 ----

const OTHER: &str = "2026-09-16/20260916T020000Z-0000000b";
const REF_A: &str = "导入参考图/aa.png";
const REF_B: &str = "导入参考图/bb.png";

/// 手工构造的 v2 包：OTHER 的结果图、参考图快照与另一张导入参考图都被省略，只存代表条目。
fn v2_pack() -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let manifest = serde_json::json!({
        "pack_format_version": 2, "app_version": "0.4.0", "boards": ["画板/a.ugcboard.json"],
        "duplicates": { format!("{OTHER}/result.png"): format!("{TASK}/result.png"), format!("{OTHER}/references/01.png"): format!("{TASK}/result.png"), REF_B: REF_A }
    });
    let entries: Vec<(String, Vec<u8>)> = vec![
        ("manifest.json".into(), manifest.to_string().into_bytes()),
        ("画板/a.ugcboard.json".into(), b"{\"format_version\":1,\"title\":\"a\"}".to_vec()),
        (format!("{TASK}/task.json"), b"{\"task_id\":\"a\"}".to_vec()),
        (format!("{TASK}/result.png"), png()),
        (format!("{OTHER}/task.json"), b"{\"task_id\":\"b\"}".to_vec()),
        (REF_A.into(), b"ref".to_vec()),
    ];
    for (name, bytes) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn v2_import_body(duplicates: serde_json::Value) -> String {
    serde_json::json!({
        "units": [
            { "path": TASK, "identity": "task.json" },
            { "path": OTHER, "identity": "task.json" },
            { "path": REF_A, "identity": null },
            { "path": REF_B, "identity": null }
        ],
        "duplicates": duplicates
    })
    .to_string()
}

#[tokio::test]
async fn importing_a_v2_pack_restores_omitted_paths_as_hard_links() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let id = upload_pack(&h, &cookie, v2_pack()).await;
    let duplicates = serde_json::json!([
        { "path": format!("{OTHER}/references/01.png"), "source": format!("{TASK}/result.png") },
        { "path": format!("{OTHER}/result.png"), "source": format!("{TASK}/result.png") },
        { "path": REF_B, "source": REF_A }
    ]);
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=v2"), Some(&cookie), v2_import_body(duplicates)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let outcomes: Vec<String> = reply.json()["outcomes"].as_array().unwrap().iter().map(|o| o["outcome"].as_str().unwrap().to_string()).collect();
    assert_eq!(outcomes, vec!["moved"; 4]);
    let root = h.user_root(GOOD_KEY);
    for (omitted, representative) in [
        (format!("{OTHER}/result.png"), format!("{TASK}/result.png")),
        (format!("{OTHER}/references/01.png"), format!("{TASK}/result.png")),
        (REF_B.to_string(), REF_A.to_string()),
    ] {
        assert_eq!(std::fs::read(root.join(&omitted)).unwrap(), std::fs::read(root.join(&representative)).unwrap(), "{omitted}");
        assert!(same_file::is_same_file(root.join(&omitted), root.join(&representative)).unwrap(), "能硬链接时 {omitted} 应是 {representative} 的硬链接");
    }
    assert!(!root.join(".kacha/packs").join(format!("{id}.ugcpack.tmp")).exists());
}

#[tokio::test]
async fn v2_import_rejects_unsafe_or_dangling_duplicates_without_writing() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    for (i, duplicates) in [
        serde_json::json!([{ "path": format!("{OTHER}/../../evil.png"), "source": format!("{TASK}/result.png") }]),
        serde_json::json!([{ "path": format!("{OTHER}/result.png"), "source": "../outside.png" }]),
        serde_json::json!([{ "path": format!("{OTHER}/result.png"), "source": format!("{TASK}/没有.png") }]),
        serde_json::json!([{ "path": format!("{TASK}/result.png"), "source": REF_A }]),
    ]
    .into_iter()
    .enumerate()
    {
        let id = upload_pack(&h, &cookie, v2_pack()).await;
        let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=bad{i}"), Some(&cookie), v2_import_body(duplicates.clone())).await;
        assert_eq!(reply.status, 422, "{duplicates}: {}", reply.text());
        assert!(!root.join("2026-09-16").exists() && !root.join("导入参考图").exists(), "{duplicates}: 不能移入任何单元");
        assert!(!root.parent().unwrap().join("evil.png").exists());
    }
}

// ---- 导出包格式 v2：服务端给字节事实、只写实存条目（#63） ----

fn seed_duplicate_reference(h: &Harness) {
    seed_task(h, GOOD_KEY);
    let root = h.user_root(GOOD_KEY);
    std::fs::create_dir_all(root.join("别处")).unwrap();
    // 与任务目录里的结果图内容相同：迭代时上一轮结果被当作参考图。
    std::fs::write(root.join("别处/猫.png"), png()).unwrap();
}

#[tokio::test]
async fn export_facts_report_size_and_sha256_of_every_file_the_export_would_write() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_duplicate_reference(&h);
    let body = serde_json::json!({ "task_dirs": [TASK, "2026-09-16/20260916T090000Z-000000ff"], "files": [{ "source": "别处/猫.png", "entry": "导入参考图/abc.png" }] });
    let reply = h.send(Method::POST, "/api/packs/export/facts?op=f1", Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let facts = reply.json();
    let facts = facts.as_array().unwrap();
    let entries: Vec<&str> = facts.iter().map(|f| f["entry"].as_str().unwrap()).collect();
    // 用户数据根里不存在的任务目录跳过，与导出一致；文本条目不在其中。
    assert_eq!(entries, vec![format!("{TASK}/result.png").as_str(), format!("{TASK}/task.json").as_str(), "导入参考图/abc.png"]);
    let fact = |entry: &str| facts.iter().find(|f| f["entry"] == entry).unwrap().clone();
    let result = fact(&format!("{TASK}/result.png"));
    assert_eq!(result["size"], png().len() as u64);
    assert_eq!(result["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(fact("导入参考图/abc.png")["sha256"], result["sha256"], "内容相同则 sha256 相同");
    assert_ne!(fact(&format!("{TASK}/task.json"))["sha256"], result["sha256"]);
    // 结束即注销操作：之后的进度查询按「已结束」回 204（#59）。
    assert_eq!(h.get("/api/packs/ops/f1", Some(&cookie)).await.status, 204, "结束即注销操作");
}

#[tokio::test]
async fn export_facts_reject_sources_outside_the_user_root() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let body = serde_json::json!({ "task_dirs": [], "files": [{ "source": "/etc/hostname", "entry": "导入参考图/x.png" }] });
    let reply = h.send(Method::POST, "/api/packs/export/facts?op=f2", Some(&cookie), body.to_string()).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
}

#[tokio::test]
async fn cancelling_export_facts_returns_409() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let dir = h.user_root(GOOD_KEY).join(TASK);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), b"{}").unwrap();
    std::fs::write(dir.join("result.bin"), vec![7u8; 96 * 1024 * 1024]).unwrap();
    let body = serde_json::json!({ "task_dirs": [TASK], "files": [] }).to_string();
    let req = Request::builder().method(Method::POST).uri("/api/packs/export/facts?op=f3").header(header::COOKIE, &cookie).body(Body::from(body)).unwrap();
    let pending = tokio::spawn(h.app.clone().oneshot(req));
    for _ in 0..400 {
        let p = h.get("/api/packs/ops/f3", Some(&cookie)).await;
        if p.status == 200 && p.json()["done"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(h.send(Method::POST, "/api/packs/ops/f3/cancel", Some(&cookie), Body::empty()).await.status, 204);
    let res = pending.await.unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let text = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(text.contains("已取消"), "{text}");
}

#[tokio::test]
async fn export_writes_only_present_entries_and_the_manifest_lists_duplicates() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_duplicate_reference(&h);
    let manifest = serde_json::json!({ "pack_format_version": 2, "app_version": "0.4.0", "boards": ["画板/a.ugcboard.json"], "duplicates": { "导入参考图/abc.png": format!("{TASK}/result.png") } });
    let mut spec = export_spec();
    spec["texts"][0]["text"] = manifest.to_string().into();
    spec["omitted"] = serde_json::json!(["导入参考图/abc.png"]);
    let reply = h.send(Method::POST, "/api/packs/export?op=v2e", Some(&cookie), spec.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    let mut names = zip_entries(&reply.body);
    names.sort();
    assert_eq!(names, vec![format!("{TASK}/result.png"), format!("{TASK}/task.json"), "manifest.json".to_string(), "画板/a.ugcboard.json".to_string()]);
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(reply.body.to_vec())).unwrap();
    let mut text = String::new();
    archive.by_name("manifest.json").unwrap().read_to_string(&mut text).unwrap();
    let written: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(written["duplicates"]["导入参考图/abc.png"], format!("{TASK}/result.png"));
}

#[tokio::test]
async fn export_rejects_omitting_entries_that_are_not_files_of_the_spec() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_duplicate_reference(&h);
    for (i, omitted) in [serde_json::json!(["导入参考图/没有.png"]), serde_json::json!(["manifest.json"]), serde_json::json!(["画板/a.ugcboard.json"])].into_iter().enumerate() {
        let mut spec = export_spec();
        spec["omitted"] = omitted.clone();
        let reply = h.send(Method::POST, &format!("/api/packs/export?op=om{i}"), Some(&cookie), spec.to_string()).await;
        assert_eq!(reply.status, 422, "{omitted}: {}", reply.text());
    }
}

// ---- 上传不占大请求名额、空闲超时、余量预检（#60）----

type BodySender = tokio::sync::mpsc::Sender<Result<Vec<u8>, std::io::Error>>;

/// 请求体由测试一块一块喂、可以停住不发的上传请求。
fn stalled_upload(cookie: &str, op: &str, content_length: Option<u64>) -> (BodySender, Request<Body>) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(1);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    let mut req = Request::builder().method(Method::POST).uri(format!("/api/packs/uploads?op={op}")).header(header::COOKIE, cookie);
    if let Some(len) = content_length {
        req = req.header(header::CONTENT_LENGTH, len.to_string());
    }
    (tx, req.body(Body::from_stream(stream)).unwrap())
}

fn upload_temps(h: &Harness, key: &str) -> usize {
    let packs = h.user_root(key).join(".kacha/packs");
    if packs.exists() { std::fs::read_dir(packs).unwrap().count() } else { 0 }
}

/// 等到 `count` 个上传临时文件都写到 `len` 字节，并把它们的修改时间对齐到 harness 时钟。
async fn wait_for_partial_uploads(h: &Harness, count: usize, len: u64) {
    let packs = h.user_root(GOOD_KEY).join(".kacha/packs");
    for _ in 0..500 {
        let files: Vec<_> = std::fs::read_dir(&packs).into_iter().flatten().flatten().collect();
        // 按路径取元数据：Windows 上目录项缓存的大小在文件写入期间不会更新。
        if files.len() == count && files.iter().all(|f| std::fs::metadata(f.path()).is_ok_and(|m| m.len() == len)) {
            files.iter().for_each(|f| set_mtime(&f.path(), h.now()));
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("没等到 {count} 个写了 {len} 字节的上传临时文件");
}

#[tokio::test]
async fn four_stalled_uploads_do_not_block_an_export() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, GOOD_KEY);
    let mut senders = Vec::new();
    let mut pending = Vec::new();
    for i in 0..kacha_server::limits::HEAVY_CONCURRENCY {
        let (tx, req) = stalled_upload(&cookie, &format!("s{i}"), Some(4096));
        pending.push(tokio::spawn(h.app.clone().oneshot(req)));
        tx.send(Ok(vec![7u8; 1024])).await.unwrap();
        senders.push(tx);
        // 等这一块写下去，再把修改时间对齐到 harness 时钟：否则下一个上传开始时会把它当过期暂存回收。
        wait_for_partial_uploads(&h, i + 1, 1024).await;
    }
    assert_eq!(upload_temps(&h, GOOD_KEY), 4, "4 个上传都已开始写临时文件，然后停住不发");

    let spec = serde_json::json!({ "texts": [], "task_dirs": [TASK], "files": [] }).to_string();
    let export = tokio::time::timeout(std::time::Duration::from_secs(10), h.send(Method::POST, "/api/packs/export?op=x1", Some(&cookie), spec))
        .await
        .expect("挂起的上传不能占住大请求名额，导出必须能完成");
    assert_eq!(export.status, 200, "{}", export.text());
    assert!(zip_entries(&export.body).contains(&format!("{TASK}/result.png")));
    assert!(pending.iter().all(|p| !p.is_finished()), "上传仍在等请求体");
    drop(senders);
}

#[tokio::test(start_paused = true)]
async fn upload_idle_for_over_60_seconds_returns_408_and_deletes_the_temp_file() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let (tx, req) = stalled_upload(&cookie, "idle", Some(4096));
    let pending = tokio::spawn(h.app.clone().oneshot(req));
    tx.send(Ok(vec![7u8; 1024])).await.unwrap();
    // 计的是块与块之间的空闲：59 秒后再来一块，计时重新开始。
    tokio::time::sleep(std::time::Duration::from_secs(59)).await;
    tx.send(Ok(vec![7u8; 1024])).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(59)).await;
    assert!(!pending.is_finished(), "块与块之间没超过 60 秒，上传继续");
    assert_eq!(upload_temps(&h, GOOD_KEY), 1, "写了一半的临时文件在盘上");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), pending).await.expect("空闲超过 60 秒应结束上传").unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::REQUEST_TIMEOUT);
    let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["code"], "upload_timeout");
    assert_eq!(upload_temps(&h, GOOD_KEY), 0, "超时删除临时文件");
    assert_eq!(h.get("/api/packs/ops/idle", Some(&cookie)).await.status, 204, "超时即注销操作");
    drop(tx);
}

#[tokio::test]
async fn upload_that_does_not_fit_above_the_free_space_threshold_returns_507_without_a_temp_file() {
    let min_free = kacha_server::limits::DEFAULT_MIN_FREE_BYTES;
    // 余量刚过门槛：现有判定放行，但放不下 4096 字节的包。
    let h = Harness::with_free_space(Some(min_free + 4095));
    let cookie = h.session(GOOD_KEY).await;
    let (tx, req) = stalled_upload(&cookie, "big", Some(4096));
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), h.app.clone().oneshot(req)).await.expect("开始写入前就应拒绝，不等请求体").unwrap();
    assert_eq!(res.status(), StatusCode::INSUFFICIENT_STORAGE);
    let body: serde_json::Value = serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["code"], "insufficient_storage");
    assert!(!h.user_root(GOOD_KEY).join(".kacha/packs").exists(), "不创建临时文件");
    drop(tx);

    // 放得下（长度 + 门槛不超过余量）照常上传。
    let fits = h.post_with_length("/api/packs/uploads", &cookie, vec![7u8; 4095]).await;
    assert_eq!(fits.status, 200, "{}", fits.text());
    // 没有 Content-Length：按现有的余量门槛判定，余量够门槛即放行。
    let (tx, req) = stalled_upload(&cookie, "nolen", None);
    let pending = tokio::spawn(h.app.clone().oneshot(req));
    tx.send(Ok(vec![7u8; 8192])).await.unwrap();
    drop(tx);
    let res = tokio::time::timeout(std::time::Duration::from_secs(5), pending).await.unwrap().unwrap().unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

// ---- 整包上传回退路径同样比对参考图快照（#51：服务端为信任边界读 task.json 的快照 hash）----

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// OTHER 的参考图快照与 TASK 的结果图内容相同（v2 省略、导入时还原）；OTHER 的 task.json 记下快照的 sha256。
fn snapshot_pack(recorded_sha: &str) -> Vec<u8> {
    use std::io::Write;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let manifest = serde_json::json!({
        "pack_format_version": 2, "app_version": "0.4.0", "boards": ["画板/a.ugcboard.json"],
        "duplicates": { format!("{OTHER}/reference-1.png"): format!("{TASK}/result.png") }
    });
    let record = serde_json::json!({ "task_id": "b", "references": [{ "file": "reference-1.png", "sha256": recorded_sha }] });
    let entries: Vec<(String, Vec<u8>)> = vec![
        ("manifest.json".into(), manifest.to_string().into_bytes()),
        ("画板/a.ugcboard.json".into(), b"{\"format_version\":1,\"title\":\"a\"}".to_vec()),
        (format!("{TASK}/task.json"), b"{\"task_id\":\"a\"}".to_vec()),
        (format!("{TASK}/result.png"), png()),
        (format!("{OTHER}/task.json"), record.to_string().into_bytes()),
    ];
    for (name, bytes) in entries {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

async fn import_snapshot_pack(h: &Harness, cookie: &str, recorded_sha: &str) -> Reply {
    let id = upload_pack(h, cookie, snapshot_pack(recorded_sha)).await;
    let body = serde_json::json!({
        "units": [{ "path": TASK, "identity": "task.json" }, { "path": OTHER, "identity": "task.json" }],
        "duplicates": [{ "path": format!("{OTHER}/reference-1.png"), "source": format!("{TASK}/result.png") }]
    });
    h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=snap"), Some(cookie), body.to_string()).await
}

#[tokio::test]
async fn whole_pack_import_rejects_a_reference_snapshot_that_disagrees_with_task_json() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = import_snapshot_pack(&h, &cookie, &sha_hex(b"not the snapshot")).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
    assert_eq!(reply.json()["code"], "invalid_pack");
    assert!(reply.json()["message"].as_str().unwrap().contains("reference-1.png"), "{}", reply.text());
    let root = h.user_root(GOOD_KEY);
    assert!(!root.join(TASK).exists() && !root.join(OTHER).exists(), "不合格时一个单元都不移入");
    assert_eq!(upload_temps(&h, GOOD_KEY), 0, "失败也删除上传临时文件");
}

#[tokio::test]
async fn whole_pack_import_accepts_a_reference_snapshot_matching_task_json() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = import_snapshot_pack(&h, &cookie, &sha_hex(&png()).to_uppercase()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(std::fs::read(h.user_root(GOOD_KEY).join(OTHER).join("reference-1.png")).unwrap(), png());
}
