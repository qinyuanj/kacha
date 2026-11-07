//! #68 用户删除画板：DELETE /api/boards 把主文件与 `.bak` 移入回收区；管理员用 `cleanup restore` 搬回。

mod common;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{Method, StatusCode};
use common::*;

const DAY: u64 = 86400;
/// Harness 时钟起点 1_800_000_000 = 2027-01-15T08:00:00Z。
const BATCH: &str = "20270115T080000Z";
const BOARD: &str = "画板/草稿.ugcboard.json";
const OLD: &str = "2026-10-01/20261001T000000Z-0000000a";
const SHARED: &str = "2026-10-02/20261002T000000Z-0000000b";

fn board_uri(path: &str) -> String {
    format!("/api/boards?path={}", q(path))
}

async fn delete_board(h: &Harness, cookie: Option<&str>, path: &str, version: Option<&str>) -> Reply {
    let mut uri = board_uri(path);
    if let Some(v) = version {
        uri.push_str(&format!("&version={v}"));
    }
    h.send(Method::DELETE, &uri, cookie, Body::empty()).await
}

/// 写两次，留下主文件与 `.bak`；返回主文件版本。
async fn seed_board(h: &Harness, cookie: &str, path: &str, first: &str, second: &str) -> String {
    assert_eq!(h.put(&board_uri(path), cookie, first.to_string()).await.status, 204);
    assert_eq!(h.put(&board_uri(path), cookie, second.to_string()).await.status, 204);
    h.get(&board_uri(path), Some(cookie)).await.json()["version"].as_str().unwrap().to_string()
}

async fn names(h: &Harness, cookie: &str) -> serde_json::Value {
    h.get(&format!("/api/boards/names?dir={}", q("画板")), Some(cookie)).await.json()
}

fn recycled(h: &Harness, key: &str, rel: &str) -> std::path::PathBuf {
    h.data_root().join("recycle").join(BATCH).join("users").join(fingerprint(key)).join(rel)
}

fn restore(data_root: &Path, entry: Option<&str>) -> (i32, String, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kacha-server"));
    command.args(["cleanup", "restore", "--data-root", data_root.to_str().unwrap()]);
    if let Some(entry) = entry {
        command.arg(entry);
    }
    let out = command.output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn seed_task(h: &Harness, key: &str, rel: &str, at: u64) {
    let dir = h.user_root(key).join(rel);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("task.json"), "{}").unwrap();
    std::fs::write(dir.join("result.png"), [1u8, 2, 3]).unwrap();
    // filetime 跨平台改修改时间：Windows 上只读打开的句柄改不了时间，目录也打不开。
    let t = filetime::FileTime::from_system_time(UNIX_EPOCH + Duration::from_secs(at));
    for e in std::fs::read_dir(&dir).unwrap() {
        filetime::set_file_mtime(e.unwrap().path(), t).unwrap();
    }
    filetime::set_file_mtime(&dir, t).unwrap();
}

fn board_referencing(dirs: &[&str]) -> String {
    let nodes: Vec<String> = dirs
        .iter()
        .enumerate()
        .map(|(i, dir)| {
            let id = dir.split('/').nth(1).unwrap();
            format!(r#"{{"id":"r{i}","type":"result","pos":[0,0],"size":[1,1],"task_id":"{id}","file":"result.png","path":"{dir}/result.png","layer_count":0,"record":{{}}}}"#)
        })
        .collect();
    format!(r#"{{"format_version":1,"title":"b","viewport":{{"zoom":1,"x":0,"y":0}},"edges":[],"nodes":[{}]}}"#, nodes.join(","))
}

#[tokio::test]
async fn delete_moves_main_and_bak_into_recycle_keeping_relative_path() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let version = seed_board(&h, &cookie, BOARD, r#"{"v":1}"#, r#"{"v":2}"#).await;
    seed_board(&h, &cookie, "画板/留下.ugcboard.json", "{}", "{}").await;

    let res = delete_board(&h, Some(&cookie), BOARD, Some(&version)).await;
    assert_eq!(res.status, StatusCode::NO_CONTENT, "{}", res.text());
    assert_eq!(names(&h, &cookie).await, serde_json::json!(["留下.ugcboard.json"]));
    assert!(!h.user_root(GOOD_KEY).join(BOARD).exists());
    assert!(!h.user_root(GOOD_KEY).join(format!("{BOARD}.bak")).exists());
    // 同一次删除的两个文件落在同一批次，保持原相对路径。
    assert_eq!(std::fs::read_to_string(recycled(&h, GOOD_KEY, BOARD)).unwrap(), r#"{"v":2}"#);
    assert_eq!(std::fs::read_to_string(recycled(&h, GOOD_KEY, &format!("{BOARD}.bak"))).unwrap(), r#"{"v":1}"#);
}

#[tokio::test]
async fn delete_without_version_and_with_only_bak() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    assert_eq!(h.put(&board_uri(BOARD), &cookie, "{}").await.status, 204);
    assert_eq!(delete_board(&h, Some(&cookie), BOARD, None).await.status, StatusCode::NO_CONTENT);
    assert!(recycled(&h, GOOD_KEY, BOARD).exists());

    // 只剩 .bak 的画板（列表里也算）同样可删。
    let orphan = "画板/孤立.ugcboard.json";
    std::fs::write(h.user_root(GOOD_KEY).join(format!("{orphan}.bak")), "{}").unwrap();
    assert_eq!(delete_board(&h, Some(&cookie), orphan, None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(names(&h, &cookie).await, serde_json::json!([]));
}

#[tokio::test]
async fn stale_version_is_409_and_board_stays() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let old = seed_board(&h, &cookie, BOARD, r#"{"v":1}"#, r#"{"v":2}"#).await;
    assert_eq!(h.put(&format!("{}&version={old}", board_uri(BOARD)), &cookie, r#"{"v":3}"#).await.status, 204);

    let res = delete_board(&h, Some(&cookie), BOARD, Some(&old)).await;
    assert_eq!(res.status, StatusCode::CONFLICT, "{}", res.text());
    assert_eq!(res.json()["code"], "board_conflict");
    assert_eq!(h.get(&board_uri(BOARD), Some(&cookie)).await.json()["main"], r#"{"v":3}"#);
    assert!(!h.data_root().join("recycle").exists());
}

#[tokio::test]
async fn missing_board_is_clear_error() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let res = delete_board(&h, Some(&cookie), "画板/没有.ugcboard.json", None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.text());
    assert_eq!(res.json()["code"], "not_found");
    assert!(res.json()["message"].as_str().unwrap().contains("可能已在别处改名或删除"));
}

#[tokio::test]
async fn traversal_unauthenticated_and_other_users_are_blocked() {
    let h = Harness::new();
    let alice = h.session(GOOD_KEY).await;
    seed_board(&h, &alice, BOARD, "{}", "{}").await;
    for bad in ["../x.ugcboard.json", "/etc/passwd", "a/../../x"] {
        assert_eq!(delete_board(&h, Some(&alice), bad, None).await.status, StatusCode::FORBIDDEN, "{bad}");
    }
    assert_eq!(delete_board(&h, None, BOARD, None).await.status, StatusCode::UNAUTHORIZED);
    // 只删画板文件：日期目录、元数据目录、用户数据根本身、伪装成画板名的目录都拒绝。
    seed_task(&h, GOOD_KEY, OLD, h.now_secs());
    std::fs::create_dir_all(h.user_root(GOOD_KEY).join("画板/目录.ugcboard.json")).unwrap();
    for bad in ["2026-10-01", OLD, ".kacha", "", "画板", "画板/草稿.ugcboard.json.bak", "画板/目录.ugcboard.json"] {
        assert_eq!(delete_board(&h, Some(&alice), bad, None).await.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert!(h.user_root(GOOD_KEY).join(OLD).join("result.png").exists());
    assert!(h.user_root(GOOD_KEY).join(".kacha").exists());
    assert!(!h.data_root().join("recycle").exists());
    // 另一个用户按自己的用户数据根解析同名路径：找不到，不碰 alice 的画板。
    let bob = h.session(OTHER_KEY).await;
    assert_eq!(delete_board(&h, Some(&bob), BOARD, None).await.status, StatusCode::NOT_FOUND);
    assert!(h.user_root(GOOD_KEY).join(BOARD).exists());
}

#[tokio::test]
async fn stale_save_after_delete_is_missing_and_same_name_can_be_recreated() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let version = seed_board(&h, &cookie, BOARD, "{}", r#"{"v":2}"#).await;
    assert_eq!(delete_board(&h, Some(&cookie), BOARD, Some(&version)).await.status, StatusCode::NO_CONTENT);

    let stale = h.put(&format!("{}&version={version}", board_uri(BOARD)), &cookie, r#"{"v":3}"#).await;
    assert_eq!(stale.status, StatusCode::CONFLICT, "{}", stale.text());
    assert_eq!(stale.json()["code"], "board_missing");
    assert!(stale.json()["message"].as_str().unwrap().contains("可能已在别处改名或删除"));
    assert_eq!(names(&h, &cookie).await, serde_json::json!([]));

    let created = h.put(&format!("{}&create_only=true", board_uri(BOARD)), &cookie, r#"{"v":"new"}"#).await;
    assert_eq!(created.status, StatusCode::NO_CONTENT, "{}", created.text());
    assert_eq!(names(&h, &cookie).await, serde_json::json!(["草稿.ugcboard.json"]));
}

#[tokio::test]
async fn admin_restore_moves_board_back_and_refuses_to_overwrite() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_board(&h, &cookie, BOARD, r#"{"v":1}"#, r#"{"v":2}"#).await;
    assert_eq!(delete_board(&h, Some(&cookie), BOARD, None).await.status, StatusCode::NO_CONTENT);

    let entry = format!("{BATCH}/users/{}/{BOARD}", fingerprint(GOOD_KEY));
    let (code, out, err) = restore(h.data_root(), None);
    assert_eq!(code, 0, "{err}");
    assert!(out.contains(&entry), "{out}");
    assert!(!out.contains(&format!("{entry}.bak")), "画板与 .bak 是同一个条目：{out}");

    // 用户之后新建了同名画板：拒绝覆盖，回收区原样保留。
    assert_eq!(h.put(&board_uri(BOARD), &cookie, r#"{"v":"new"}"#).await.status, 204);
    let (code, _, err) = restore(h.data_root(), Some(&entry));
    assert_eq!(code, 1);
    assert!(err.contains("已存在"), "{err}");
    assert_eq!(h.get(&board_uri(BOARD), Some(&cookie)).await.json()["main"], r#"{"v":"new"}"#);
    assert!(recycled(&h, GOOD_KEY, BOARD).exists());

    assert_eq!(delete_board(&h, Some(&cookie), BOARD, None).await.status, StatusCode::NO_CONTENT);
    // 同一秒内第二次删除：顺延到下一秒的批次，不覆盖第一份，两份都能列出、都能恢复。
    let second = format!("20270115T080001Z/users/{}/{BOARD}", fingerprint(GOOD_KEY));
    let (_, out, _) = restore(h.data_root(), None);
    assert!(out.contains(&entry) && out.contains(&second), "{out}");
    let (code, out, err) = restore(h.data_root(), Some(&entry));
    assert_eq!(code, 0, "{err}\n{out}");
    let texts = h.get(&board_uri(BOARD), Some(&cookie)).await.json();
    assert_eq!(texts["main"], r#"{"v":2}"#);
    assert_eq!(texts["bak"], r#"{"v":1}"#);
    assert!(!recycled(&h, GOOD_KEY, BOARD).exists());

    let (code, _, err) = restore(h.data_root(), Some(&second));
    assert_eq!(code, 1, "原位置已被恢复的第一份占住：{err}");
    assert_eq!(std::fs::read_to_string(h.data_root().join("recycle").join(&second)).unwrap(), r#"{"v":"new"}"#);
}

#[tokio::test]
async fn recycled_boards_expire_with_the_cleanup_batch() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_board(&h, &cookie, BOARD, "{}", "{}").await;
    assert_eq!(delete_board(&h, Some(&cookie), BOARD, None).await.status, StatusCode::NO_CONTENT);
    let later = (h.now_secs() + 15 * DAY).to_string();
    let out = Command::new(env!("CARGO_BIN_EXE_kacha-server"))
        .args(["cleanup", "--data-root", h.data_root().to_str().unwrap(), "--now", &later])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!h.data_root().join("recycle").join(BATCH).exists());
}

#[tokio::test]
async fn deleted_board_no_longer_holds_its_task_dirs() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let old = h.now_secs() - 100 * DAY;
    seed_task(&h, GOOD_KEY, OLD, old);
    seed_task(&h, GOOD_KEY, SHARED, old);
    let dir = h.user_root(GOOD_KEY).join("画板");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("草稿.ugcboard.json"), board_referencing(&[OLD, SHARED])).unwrap();
    std::fs::write(dir.join("留下.ugcboard.json"), board_referencing(&[SHARED])).unwrap();
    let unreferenced = |v: serde_json::Value| v["unreferenced"].as_array().unwrap().iter().map(|d| d["dir"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert!(unreferenced(h.get("/api/usage", Some(&cookie)).await.json()).is_empty());

    assert_eq!(delete_board(&h, Some(&cookie), BOARD, None).await.status, StatusCode::NO_CONTENT);
    // 生成结果不动；独占引用的老任务目录成为未引用，共享的不是。回收区里的画板不算引用。
    assert!(h.user_root(GOOD_KEY).join(OLD).join("result.png").exists());
    assert_eq!(unreferenced(h.get("/api/usage", Some(&cookie)).await.json()), vec![OLD.to_string()]);
}
