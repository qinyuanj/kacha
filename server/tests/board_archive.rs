//! #90 归档画板：归档 / 取消归档、写入拒绝、复制为新画板的画板位检查、清理与 cleanup restore，经 HTTP 边界验证。
mod common;

use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Method, StatusCode};
use common::*;
use kacha_server::BoardSizeLines;

const DAY: u64 = 86400;
/// Harness 时钟起点 1_800_000_000 = 2027-01-15T08:00:00Z。
const BATCH: &str = "20270115T080000Z";
const OLD: &str = "2026-10-01/20261001T000000Z-0000000a";
const A: &str = "画板/甲.ugcboard.json";
const A_ARCHIVED: &str = "画板/归档/甲.ugcboard.json";

fn board_uri(path: &str) -> String {
    format!("/api/boards?path={}", q(path))
}

async fn create(h: &Harness, cookie: &str, path: &str, text: &str) -> Reply {
    h.put(&format!("{}&create_only=true", board_uri(path)), cookie, text.to_string()).await
}

async fn move_board(h: &Harness, cookie: &str, action: &str, from: &str, to: &str, version: Option<&str>) -> Reply {
    let body = serde_json::json!({ "from": from, "to": to, "version": version });
    h.send(Method::POST, &format!("/api/boards/{action}"), Some(cookie), body.to_string()).await
}

async fn archive(h: &Harness, cookie: &str, from: &str, to: &str) -> Reply {
    move_board(h, cookie, "archive", from, to, None).await
}

async fn unarchive(h: &Harness, cookie: &str, from: &str, to: &str) -> Reply {
    move_board(h, cookie, "unarchive", from, to, None).await
}

async fn listing(h: &Harness, cookie: &str) -> serde_json::Value {
    h.get("/api/boards/list", Some(cookie)).await.json()
}

/// 列表里的 (path, archived)。
async fn rows(h: &Harness, cookie: &str) -> Vec<(String, bool)> {
    listing(h, cookie).await["boards"].as_array().unwrap().iter().map(|b| (b["path"].as_str().unwrap().to_string(), b["archived"].as_bool().unwrap())).collect()
}

fn board_referencing(dir: &str) -> String {
    let id = dir.split('/').nth(1).unwrap();
    format!(
        r#"{{"format_version":1,"title":"甲","viewport":{{"zoom":1,"x":0,"y":0}},"edges":[],"nodes":[{{"id":"r","type":"result","pos":[0,0],"size":[1,1],"task_id":"{id}","file":"result.png","path":"{dir}/result.png","layer_count":0,"record":{{}}}}]}}"#
    )
}

fn seed_task(h: &Harness, rel: &str, at: u64) {
    let dir = h.user_root(GOOD_KEY).join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), "{}").unwrap();
    std::fs::write(dir.join("result.png"), [1u8, 2, 3]).unwrap();
    let t = filetime::FileTime::from_system_time(UNIX_EPOCH + Duration::from_secs(at));
    for e in std::fs::read_dir(&dir).unwrap() {
        filetime::set_file_mtime(e.unwrap().path(), t).unwrap();
    }
    filetime::set_file_mtime(&dir, t).unwrap();
}

fn cli(h: &Harness, args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_kacha-server")).arg("cleanup").args(args).args(["--data-root", h.data_root().to_str().unwrap()]).output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[tokio::test]
async fn archive_frees_a_slot_and_unarchive_needs_a_free_slot() {
    let h = Harness::with_board_config(1, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(h.put(&board_uri(A), &cookie, r#"{"v":1}"#).await.status, StatusCode::NO_CONTENT);
    assert_eq!(h.put(&board_uri(A), &cookie, r#"{"v":2}"#).await.status, StatusCode::NO_CONTENT);

    let res = archive(&h, &cookie, A, A_ARCHIVED).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    assert_eq!(rows(&h, &cookie).await, vec![(A_ARCHIVED.to_string(), true)]);
    assert_eq!(listing(&h, &cookie).await["slots"]["used"], 0);
    // 画板文件原样搬走（连同 .bak），格式不变。
    let texts = h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json();
    assert_eq!((texts["main"].as_str(), texts["bak"].as_str()), (Some(r#"{"v":2}"#), Some(r#"{"v":1}"#)));

    // 腾出的画板位可以新建；位满后取消归档被拒，归档画板原地不动。
    assert_eq!(create(&h, &cookie, "画板/乙.ugcboard.json", "{}").await.status, StatusCode::NO_CONTENT);
    let full = unarchive(&h, &cookie, A_ARCHIVED, A).await;
    assert_eq!(full.status, StatusCode::CONFLICT, "{}", full.text());
    assert_eq!(full.json()["code"], "board_slots_full");
    // 独立的规格期望值：与新建被拒同一句统一文案。
    assert_eq!(full.json()["message"], "画板位满了（1/1），归档或删掉一块再新建。");
    assert!(h.user_root(GOOD_KEY).join(A_ARCHIVED).is_file());
    assert!(!h.user_root(GOOD_KEY).join(A).exists());

    // 有空位后取消归档，画板回到可编辑位置。
    assert_eq!(h.send(Method::DELETE, &board_uri("画板/乙.ugcboard.json"), Some(&cookie), Body::empty()).await.status, StatusCode::NO_CONTENT);
    let ok = unarchive(&h, &cookie, A_ARCHIVED, A).await;
    assert_eq!(ok.status, StatusCode::NO_CONTENT, "{}", ok.text());
    assert_eq!(rows(&h, &cookie).await, vec![(A.to_string(), false)]);
    assert_eq!(h.get(&board_uri(A), Some(&cookie)).await.json()["bak"], r#"{"v":1}"#);
}

#[tokio::test]
async fn archive_and_unarchive_only_move_between_the_board_dir_and_its_archive() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(create(&h, &cookie, A, "{}").await.status, StatusCode::NO_CONTENT);
    for (action, from, to) in [
        ("archive", A, "画板/甲2.ugcboard.json"),
        ("archive", A, "别处/甲.ugcboard.json"),
        ("archive", A, "画板/归档/子/甲.ugcboard.json"),
        ("archive", A, "画板/归档/甲.txt"),
        ("unarchive", A, "画板/甲2.ugcboard.json"),
    ] {
        let res = move_board(&h, &cookie, action, from, to, None).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{action} {from} → {to}：{}", res.text());
    }
    assert_eq!(archive(&h, &cookie, "../x.ugcboard.json", A_ARCHIVED).await.status, StatusCode::FORBIDDEN);
    assert_eq!(archive(&h, &cookie, "画板/没有.ugcboard.json", "画板/归档/没有.ugcboard.json").await.status, StatusCode::NOT_FOUND);
    assert_eq!(rows(&h, &cookie).await, vec![(A.to_string(), false)]);

    // 带版本：内容已变 409 board_conflict；归档里已有同名 409 already_exists，都不搬。
    assert_eq!(move_board(&h, &cookie, "archive", A, A_ARCHIVED, Some("stale")).await.json()["code"], "board_conflict");
    let dir = h.user_root(GOOD_KEY).join("画板/归档");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("甲.ugcboard.json.bak"), "{}").unwrap();
    assert_eq!(archive(&h, &cookie, A, A_ARCHIVED).await.json()["code"], "already_exists");
    assert!(h.user_root(GOOD_KEY).join(A).is_file());
}

#[tokio::test]
async fn archived_boards_are_read_only_but_can_be_read_and_deleted() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(create(&h, &cookie, A, r#"{"v":1}"#).await.status, StatusCode::NO_CONTENT);
    assert_eq!(archive(&h, &cookie, A, A_ARCHIVED).await.status, StatusCode::NO_CONTENT);
    let version = h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json()["version"].as_str().unwrap().to_string();

    for uri in [board_uri(A_ARCHIVED), format!("{}&version={version}", board_uri(A_ARCHIVED)), format!("{}&create_only=true", board_uri("画板/归档/新.ugcboard.json"))] {
        let res = h.put(&uri, &cookie, r#"{"v":"改"}"#).await;
        assert_eq!(res.status, StatusCode::CONFLICT, "{uri}：{}", res.text());
        assert_eq!(res.json()["code"], "board_archived");
    }
    assert_eq!(h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json()["main"], r#"{"v":1}"#);
    assert!(!h.user_root(GOOD_KEY).join("画板/归档/新.ugcboard.json").exists());

    // 改名不能绕过归档 / 取消归档（取消归档要检查画板位）。
    for (from, to) in [(A_ARCHIVED, A), (A_ARCHIVED, "画板/归档/乙.ugcboard.json")] {
        let body = serde_json::json!({ "from": from, "to": to });
        let res = h.send(Method::POST, "/api/boards/rename", Some(&cookie), body.to_string()).await;
        assert_eq!(res.json()["code"], "board_archived", "{from} → {to}");
    }
    assert_eq!(rows(&h, &cookie).await, vec![(A_ARCHIVED.to_string(), true)]);

    // 删除照常：归档不是备份。
    assert_eq!(h.send(Method::DELETE, &board_uri(A_ARCHIVED), Some(&cookie), Body::empty()).await.status, StatusCode::NO_CONTENT);
    assert!(rows(&h, &cookie).await.is_empty());
}

#[tokio::test]
async fn copy_of_an_archived_board_takes_a_slot_and_leaves_the_original_unchanged() {
    let h = Harness::with_board_config(1, BoardSizeLines::default());
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(create(&h, &cookie, A, r#"{"v":1}"#).await.status, StatusCode::NO_CONTENT);
    assert_eq!(archive(&h, &cookie, A, A_ARCHIVED).await.status, StatusCode::NO_CONTENT);
    let original = h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json()["main"].as_str().unwrap().to_string();

    // 复制为新画板 = 把归档画板的内容只新建写进画板目录。
    assert_eq!(create(&h, &cookie, A, &original).await.status, StatusCode::NO_CONTENT);
    let full = create(&h, &cookie, "画板/甲 (2).ugcboard.json", &original).await;
    assert_eq!(full.json()["code"], "board_slots_full", "{}", full.text());
    assert_eq!(full.json()["message"], "画板位满了（1/1），归档或删掉一块再新建。");

    let version = h.get(&board_uri(A), Some(&cookie)).await.json()["version"].as_str().unwrap().to_string();
    assert_eq!(h.put(&format!("{}&version={version}", board_uri(A)), &cookie, r#"{"v":"改"}"#).await.status, StatusCode::NO_CONTENT);
    assert_eq!(h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json()["main"], r#"{"v":1}"#);
    assert_eq!(rows(&h, &cookie).await, vec![(A.to_string(), false), (A_ARCHIVED.to_string(), true)]);
}

#[tokio::test]
async fn archived_board_references_survive_cleanup_and_restore_returns_it_to_the_archive() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, OLD, h.now_secs() - 100 * DAY);
    assert_eq!(create(&h, &cookie, A, &board_referencing(OLD)).await.status, StatusCode::NO_CONTENT);
    assert_eq!(archive(&h, &cookie, A, A_ARCHIVED).await.status, StatusCode::NO_CONTENT);

    // 用户自助清理与管理员命令都把归档画板的引用算作有引用。
    let usage = h.get("/api/usage", Some(&cookie)).await.json();
    assert_eq!(usage["unreferenced"], serde_json::json!([]), "{usage}");
    let now = h.now_secs().to_string();
    let (code, out, err) = cli(&h, &["--dry-run", "--now", &now]);
    assert_eq!(code, 0, "{err}");
    assert!(!out.contains("未引用任务目录"), "{out}");
    let (code, _, err) = cli(&h, &["--now", &now]);
    assert_eq!(code, 0, "{err}");
    assert!(h.user_root(GOOD_KEY).join(OLD).join("result.png").is_file());

    // 删掉归档画板后 restore：按原相对路径回到归档位置，仍不占画板位。
    assert_eq!(h.send(Method::DELETE, &board_uri(A_ARCHIVED), Some(&cookie), Body::empty()).await.status, StatusCode::NO_CONTENT);
    let entry = format!("{BATCH}/users/{}/{A_ARCHIVED}", fingerprint(GOOD_KEY));
    let out = Command::new(env!("CARGO_BIN_EXE_kacha-server")).args(["cleanup", "restore", "--data-root", h.data_root().to_str().unwrap(), &entry]).output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(rows(&h, &cookie).await, vec![(A_ARCHIVED.to_string(), true)]);
    assert_eq!(listing(&h, &cookie).await["slots"]["used"], 0);
    assert_eq!(h.get(&board_uri(A_ARCHIVED), Some(&cookie)).await.json()["main"], board_referencing(OLD));
}
