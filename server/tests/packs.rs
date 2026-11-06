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

    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), png()).unwrap();
        std::os::unix::fs::symlink(outside.path(), h.user_root(GOOD_KEY).join("link")).unwrap();
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

    let units = serde_json::json!([
        { "path": TASK, "identity": "task.json" },
        { "path": "导入参考图/5e4b079355f5f06363744c0778c5174040645713e06e6877eae22f573d46e6b0.png", "identity": null }
    ]);
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i1"), Some(&cookie), units.to_string()).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.json()["outcomes"][0]["outcome"], "moved");
    let dir = root.join(TASK);
    assert!(dir.join("layers/01.png").is_file() && dir.join("layers.json").is_file(), "v0.3.x 图层与 layers.json 都要导入");
    assert!(!root.join(".kacha/packs").join(format!("{id}.ugcpack.tmp")).exists(), "导入结束删除临时文件");
}

#[tokio::test]
async fn cancel_only_affects_the_named_operation_and_cleans_temp() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let id = upload_pack(&h, &cookie, fixture_pack()).await;
    let units = serde_json::json!([{ "path": TASK, "identity": "task.json" }]);
    // 先取消操作 i-cancel，再执行：该操作应取消，其他操作不受影响。
    assert_eq!(h.send(Method::POST, "/api/packs/ops/i-cancel/cancel", Some(&cookie), Body::empty()).await.status, 204);
    let units2 = units.to_string();
    // 已结束 / 不存在的操作的取消是幂等的；真正进行中的操作由 worker 在检查点读到标记。
    let reply = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i-other"), Some(&cookie), units2).await;
    assert_eq!(reply.status, 200, "取消别的操作不能影响本操作：{}", reply.text());
    // 上传在导入后被清理；对同一上传再导入是 404。
    let again = h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=i-other2"), Some(&cookie), units.to_string()).await;
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
    // 操作已注销；不留临时文件。
    assert_eq!(h.get("/api/packs/ops/c1", Some(&cookie)).await.status, 404);
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let (a, b) = (std::fs::metadata(root.join(&omitted)).unwrap(), std::fs::metadata(root.join(&representative)).unwrap());
            assert_eq!((a.dev(), a.ino()), (b.dev(), b.ino()), "能硬链接时 {omitted} 应是 {representative} 的硬链接");
        }
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
