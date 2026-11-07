//! #89：画板位限制经 HTTP 边界验证，不依赖内部检查实现。
mod common;

use std::io::Write;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use common::*;
use kacha_server::BoardSizeLines;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const TASK: &str = "2026-09-16/20260916T010000Z-0000000a";
const RECORD: &[u8] = br#"{"task_id":"20260916T010000Z-0000000a"}"#;

/// 用户数据根里除元数据目录外的全部文件（相对路径）：导入被拒时应与导入前相同。
fn user_files(h: &Harness) -> Vec<String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, out);
            } else {
                out.push(p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let root = h.user_root(GOOD_KEY);
    let mut out = Vec::new();
    for e in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        if e.file_name() != ".kacha" {
            if e.path().is_dir() {
                walk(&e.path(), &root, &mut out);
            } else {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

fn one_task_pack() -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in [("manifest.json".to_string(), b"{}".to_vec()), (format!("{TASK}/task.json"), RECORD.to_vec())] {
        zip.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// 整包导入：上传后按合并单元导入，声明将新增 `boards` 块画板。
async fn whole_pack_import(h: &Harness, cookie: &str, boards: usize) -> Reply {
    let up = h.send(Method::POST, "/api/packs/uploads", Some(cookie), Body::from(one_task_pack())).await;
    assert_eq!(up.status, StatusCode::OK, "{}", up.text());
    let id = up.json()["id"].as_str().unwrap().to_string();
    let body = serde_json::json!({ "units": [{ "path": TASK, "identity": "task.json" }], "duplicates": [], "boards": boards, "new_boards": (0..boards).map(|i| serde_json::json!({"title":format!("导入{i}"),"text":"{}"})).collect::<Vec<_>>() });
    h.send(Method::POST, &format!("/api/packs/uploads/{id}/import?op=w"), Some(cookie), body.to_string()).await
}

/// 去重导入：开暂存、传内容后按落盘清单导入，声明将新增 `boards` 块画板。
async fn staged_import(h: &Harness, cookie: &str, boards: usize) -> Reply {
    let staging = h.send(Method::POST, "/api/packs/staging", Some(cookie), Body::empty()).await.json()["id"].as_str().unwrap().to_string();
    let sha = format!("{:x}", Sha256::digest(RECORD));
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/packs/staging/{staging}/contents/{sha}"))
        .header(header::COOKIE, cookie)
        .header(header::CONTENT_LENGTH, RECORD.len().to_string());
    let put = h.app.clone().oneshot(req.body(Body::from(RECORD.to_vec())).unwrap()).await.unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);
    let body = serde_json::json!({ "units": [{ "path": TASK, "identity": "task.json" }], "files": [{ "path": format!("{TASK}/task.json"), "sha256": sha }], "boards": boards, "new_boards": (0..boards).map(|i| serde_json::json!({"title":format!("导入{i}"),"text":"{}"})).collect::<Vec<_>>() });
    h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=s"), Some(cookie), body.to_string()).await
}

fn seed(h: &Harness, rel: &str) {
    let path = h.user_root(GOOD_KEY).join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "{}").unwrap();
}

async fn create(h: &Harness, cookie: &str, name: &str) -> Reply {
    h.put(&format!("/api/boards?path={}&create_only=true", q(&format!("画板/{name}.ugcboard.json"))), cookie, "{}").await
}

#[tokio::test]
async fn generic_writes_and_rename_cannot_bypass_slots_or_archive_read_only() {
    let h = Harness::with_board_config(1, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/已有.ugcboard.json");
    seed(&h, "别处/新.ugcboard.json");
    let moved = h.send(Method::POST, "/api/boards/rename", Some(&cookie), serde_json::json!({"from":"别处/新.ugcboard.json","to":"画板/新.ugcboard.json"}).to_string()).await;
    assert_eq!(moved.json()["code"], "board_slots_full", "{}", moved.text());
    assert!(h.user_root(GOOD_KEY).join("别处/新.ugcboard.json").is_file());
    let written = h.put(&format!("/api/fs/file?path={}", q("画板/新.ugcboard.json")), &cookie, "{}").await;
    assert_eq!(written.json()["code"], "board_slots_full", "{}", written.text());
    let backup = h.put(&format!("/api/fs/file?path={}", q("画板/备份.ugcboard.json.bak")), &cookie, "{}").await;
    assert_eq!(backup.json()["code"], "board_slots_full", "{}", backup.text());
    let moved_backup = h.send(Method::POST, "/api/boards/rename", Some(&cookie), serde_json::json!({"from":"别处/新.ugcboard.json","to":"画板/备份.ugcboard.json.bak"}).to_string()).await;
    assert_eq!(moved_backup.json()["code"], "board_slots_full", "{}", moved_backup.text());
    let archived = h.put(&format!("/api/fs/file?path={}", q("画板/归档/新.ugcboard.json")), &cookie, "{}").await;
    assert_eq!(archived.json()["code"], "board_archived", "{}", archived.text());
    assert!(!h.user_root(GOOD_KEY).join("画板/新.ugcboard.json").exists());
    assert!(!h.user_root(GOOD_KEY).join("画板/归档/新.ugcboard.json").exists());
}

#[tokio::test]
async fn concurrent_creates_cannot_take_the_same_last_slot() {
    let h = Harness::with_board_config(2, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/已有.ugcboard.json.bak");
    seed(&h, "画板/归档/旧.ugcboard.json");
    let (a, b) = tokio::join!(create(&h, &cookie, "甲"), create(&h, &cookie, "乙"));
    let (ok, full) = if a.status == StatusCode::NO_CONTENT { (a, b) } else { (b, a) };
    assert_eq!(ok.status, StatusCode::NO_CONTENT, "{}", ok.text());
    assert_eq!(full.status, StatusCode::CONFLICT, "{}", full.text());
    assert_eq!(full.json()["code"], "board_slots_full");
    // 独立的规格期望值：错误须提供实际计数与下一步。
    assert_eq!(full.json()["message"], "画板位满了（2/2），归档或删掉一块再新建。");
    assert_eq!(h.get("/api/boards/list", Some(&cookie)).await.json()["slots"]["used"], 2);
}

#[tokio::test]
async fn over_limit_users_can_edit_and_restore_bak_but_cannot_create() {
    let h = Harness::with_board_config(1, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/已有.ugcboard.json");
    seed(&h, "画板/备份.ugcboard.json.bak");
    let uri = format!("/api/boards?path={}", q("画板/已有.ugcboard.json"));
    let version = h.get(&uri, Some(&cookie)).await.json()["version"].as_str().unwrap().to_string();
    let saved = h.put(&format!("{uri}&version={version}"), &cookie, "{\"changed\":true}").await;
    assert_eq!(saved.status, StatusCode::NO_CONTENT, "{}", saved.text());
    assert_eq!(h.put(&format!("/api/boards?path={}", q("画板/备份.ugcboard.json")), &cookie, "{}").await.status, StatusCode::NO_CONTENT);
    assert_eq!(create(&h, &cookie, "新").await.json()["code"], "board_slots_full");
    // 同名、旧版本、已删除的 409 语义仍优先保留。
    assert_eq!(create(&h, &cookie, "已有").await.json()["code"], "already_exists");
    assert_eq!(h.put(&format!("{uri}&version={version}"), &cookie, "{}").await.json()["code"], "board_conflict");
    assert_eq!(h.put(&format!("/api/boards?path={}&version={version}", q("画板/不在.ugcboard.json")), &cookie, "{}").await.json()["code"], "board_missing");
    // 旧的无版本写也不能绕过新建检查。
    assert_eq!(h.put(&format!("/api/boards?path={}", q("画板/新.ugcboard.json")), &cookie, "{}").await.json()["code"], "board_slots_full");
}

#[tokio::test]
async fn importing_more_boards_than_free_slots_is_rejected_before_writing_any_file() {
    let h = Harness::with_board_config(2, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/已有.ugcboard.json");
    let before = user_files(&h);
    for reply in [whole_pack_import(&h, &cookie, 2).await, staged_import(&h, &cookie, 2).await] {
        assert_eq!(reply.status, StatusCode::CONFLICT, "{}", reply.text());
        assert_eq!(reply.json()["code"], "board_slots_full");
        assert_eq!(reply.json()["message"], "画板位满了（1/2），归档或删掉一块再新建。");
        assert_eq!(user_files(&h), before, "被拒的导入不写任何文件");
    }
    // 有足够空位时照常导入。
    let ok = staged_import(&h, &cookie, 1).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert!(h.user_root(GOOD_KEY).join(TASK).join("task.json").is_file());
}

#[tokio::test]
async fn concurrent_imports_commit_prepared_boards_before_releasing_the_slot_lock() {
    let h = Harness::with_board_config(2, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/已有.ugcboard.json");
    async fn prepare(h: &Harness, cookie: &str, title: &str) -> (String, String) {
        let staging = h.send(Method::POST, "/api/packs/staging", Some(cookie), Body::empty()).await.json()["id"].as_str().unwrap().to_string();
        filetime::set_file_mtime(h.user_root(GOOD_KEY).join(".kacha/pack-content").join(format!("{staging}.staging.tmp")), filetime::FileTime::from_system_time(h.now())).unwrap();
        let sha = format!("{:x}", Sha256::digest(RECORD));
        let put = h.app.clone().oneshot(Request::builder().method(Method::PUT).uri(format!("/api/packs/staging/{staging}/contents/{sha}")).header(header::COOKIE, cookie).body(Body::from(RECORD.to_vec())).unwrap()).await.unwrap();
        assert_eq!(put.status(), StatusCode::NO_CONTENT);
        let task = format!("{TASK}-{title}");
        let body = serde_json::json!({"boards":0,"units":[{"path":task,"identity":"task.json"}],"files":[{"path":format!("{task}/task.json"),"sha256":sha}],"new_boards":[{"title":title,"text":"{\"format_version\":2,\"nodes\":[]}"}]});
        // 上传会更新目录 mtime；与测试时钟对齐，避免下一次开暂存误回收。
        filetime::set_file_mtime(h.user_root(GOOD_KEY).join(".kacha/pack-content").join(format!("{staging}.staging.tmp")), filetime::FileTime::from_system_time(h.now())).unwrap();
        (format!("/api/packs/staging/{staging}/import?op=test"), body.to_string())
    }
    let (uri_a, body_a) = prepare(&h, &cookie, "甲").await;
    let (uri_b, body_b) = prepare(&h, &cookie, "乙").await;
    let before = user_files(&h);
    let (a, b) = tokio::join!(h.send(Method::POST, &uri_a, Some(&cookie), body_a), h.send(Method::POST, &uri_b, Some(&cookie), body_b));
    let replies = [a, b];
    assert_eq!(replies.iter().filter(|r| r.status == StatusCode::OK).count(), 1);
    assert!(replies.iter().any(|r| r.json()["code"] == "board_slots_full"));
    assert_eq!(user_files(&h).len(), before.len() + 2, "成功导入的任务和画板，失败的只留下已有文件");
}

#[tokio::test]
async fn merge_units_cannot_be_used_to_write_boards() {
    let h = Harness::with_board_config(10, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    for path in ["画板/x.ugcboard.json", "画板/归档/x.ugcboard.json"] {
    let staging = h.send(Method::POST, "/api/packs/staging", Some(&cookie), Body::empty()).await.json()["id"].as_str().unwrap().to_string();
    let content = b"{\"format_version\":2}";
    let sha = format!("{:x}", Sha256::digest(content));
    let put = h.app.clone().oneshot(Request::builder().method(Method::PUT).uri(format!("/api/packs/staging/{staging}/contents/{sha}")).header(header::COOKIE, &cookie).body(Body::from(content.to_vec())).unwrap()).await.unwrap();
    assert_eq!(put.status(), StatusCode::NO_CONTENT);
        let body = serde_json::json!({"boards":0,"units":[{"path":path,"identity":null}],"files":[{"path":path,"sha256":sha}]});
        let reply = h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=x"), Some(&cookie), body.to_string()).await;
        assert_eq!(reply.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", reply.text());
        assert!(!h.user_root(GOOD_KEY).join(path).exists());
    }
}

#[tokio::test]
async fn prepared_board_titles_support_unicode_and_collisions_without_overwriting() {
    let h = Harness::with_board_config(10, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    seed(&h, "画板/😀.ugcboard.json");
    let staging = h.send(Method::POST, "/api/packs/staging", Some(&cookie), Body::empty()).await.json()["id"].as_str().unwrap().to_string();
    let body = serde_json::json!({"boards":0,"units":[],"files":[],"new_boards":[{"title":"😀","text":"emoji"},{"title":"a中","text":"Chinese"},{"title":"😀","text":"second"}]});
    let r = h.send(Method::POST, &format!("/api/packs/staging/{staging}/import?op=unicode"), Some(&cookie), body.to_string()).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.json()["boards"], serde_json::json!(["画板/😀 (2).ugcboard.json", "画板/a中.ugcboard.json", "画板/😀 (3).ugcboard.json"]));
    assert_eq!(std::fs::read_to_string(h.user_root(GOOD_KEY).join("画板/😀.ugcboard.json")).unwrap(), "{}");
}

#[tokio::test]
async fn whole_pack_import_with_enough_slots_merges() {
    let h = Harness::with_board_config(1, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    let ok = whole_pack_import(&h, &cookie, 1).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.text());
    assert!(h.user_root(GOOD_KEY).join(TASK).join("task.json").is_file());
}

