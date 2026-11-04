//! 用量与用户自助清理：HTTP 接口；时间来自 Harness 的可拨时钟，目录时间显式设定。

mod common;

use std::time::Duration;

use axum::http::{Method, StatusCode};
use common::{Harness, GOOD_KEY, OTHER_KEY};

const DAY: u64 = 86400;
const OLD: &str = "2026-10-01/20261001T000000Z-0000000a";
const KEPT: &str = "2026-10-02/20261002T000000Z-0000000b";

fn seed_task(h: &Harness, key: &str, rel: &str, bytes: usize, at: u64) {
    let dir = h.user_root(key).join(rel);
    std::fs::create_dir_all(dir.join("layers")).unwrap();
    std::fs::write(dir.join("task.json"), "{}").unwrap();
    std::fs::write(dir.join("layers/01.png"), vec![7u8; bytes - 2]).unwrap();
    age(&dir, at);
}

fn age(path: &std::path::Path, at: u64) {
    use std::time::UNIX_EPOCH;
    let t = UNIX_EPOCH + Duration::from_secs(at);
    if path.is_dir() {
        for e in std::fs::read_dir(path).unwrap() {
            age(&e.unwrap().path(), at);
        }
    }
    std::fs::File::open(path).unwrap().set_modified(t).unwrap();
}

fn board_referencing(dir: &str) -> String {
    let id = dir.split('/').nth(1).unwrap();
    format!(
        r#"{{"format_version":1,"title":"b","viewport":{{"zoom":1,"x":0,"y":0}},"edges":[],"nodes":[{{"id":"r","type":"result","pos":[0,0],"size":[1,1],"task_id":"{id}","file":"result.png","path":"{dir}/result.png","layer_count":0,"record":{{}}}}]}}"#
    )
}

fn write_board(h: &Harness, key: &str, name: &str, text: &str) {
    let dir = h.user_root(key).join("画板");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(name), text).unwrap();
}

async fn setup(h: &Harness) -> String {
    let cookie = h.session(GOOD_KEY).await;
    let now = h.now_secs();
    seed_task(h, GOOD_KEY, OLD, 1000, now - 100 * DAY);
    seed_task(h, GOOD_KEY, KEPT, 500, now - 100 * DAY);
    seed_task(h, GOOD_KEY, "2027-01-01/20270101T000000Z-0000000d", 200, now - 14 * DAY);
    write_board(h, GOOD_KEY, "主.ugcboard.json", &board_referencing(KEPT));
    // 元数据与画板计入用量。
    std::fs::write(h.user_root(GOOD_KEY).join(".kacha/settings.json"), vec![1u8; 123]).unwrap();
    // 另一个用户有同样规则下的未引用目录：互相不可见。
    h.session(OTHER_KEY).await;
    seed_task(h, OTHER_KEY, OLD, 7000, now - 100 * DAY);
    cookie
}

#[tokio::test]
async fn usage_lists_total_per_date_and_unreferenced_dirs_with_bytes_and_last_write() {
    let h = Harness::new();
    let cookie = setup(&h).await;
    let r = h.get("/api/usage", Some(&cookie)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    let dirs = v["unreferenced"].as_array().unwrap();
    assert_eq!(dirs.len(), 1, "{v}");
    assert_eq!(dirs[0]["dir"], OLD);
    assert_eq!(dirs[0]["bytes"], 1000);
    assert_eq!(dirs[0]["last_write"], h.now_secs() - 100 * DAY);
    let total: u64 = walk_bytes(&h.user_root(GOOD_KEY));
    assert_eq!(v["total_bytes"], total);
    assert_eq!(v["last_access"], h.now_secs());
    assert!(v["boards_bytes"].as_u64().unwrap() >= board_referencing(KEPT).len() as u64);
    // 按日期汇总：只含任务目录，1000+500 归 2026-10-01/02，200 归 2027-01-01。
    let by_date = v["by_date"].as_array().unwrap();
    assert_eq!(by_date.len(), 3, "{v}");
    assert_eq!(by_date[0]["date"], "2026-10-01");
    assert_eq!(by_date[0]["bytes"], 1000);
    // 需要会话。
    assert_eq!(h.get("/api/usage", None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn usage_reports_unreadable_board_instead_of_unreferenced_list() {
    let h = Harness::new();
    let cookie = setup(&h).await;
    write_board(&h, GOOD_KEY, "坏.ugcboard.json", "not json");
    let v = h.get("/api/usage", Some(&cookie)).await.json();
    assert!(v["unreadable_board"].is_string(), "{v}");
    assert!(v["unreferenced"].is_null(), "{v}");
}

#[tokio::test]
async fn cleanup_moves_only_the_given_unreferenced_dirs_into_recycle() {
    let h = Harness::new();
    let cookie = setup(&h).await;
    // 请求体带被引用与年轻目录：服务端逐条重算，只清真正合格的。
    let body = serde_json::json!({ "dirs": [OLD, KEPT, "2027-01-01/20270101T000000Z-0000000d", "../other", "users/other"] }).to_string();
    let r = h.send(Method::POST, "/api/cleanup/unreferenced", Some(&cookie), body).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["moved"].as_array().unwrap().len(), 1, "{v}");
    assert_eq!(v["moved"][0]["dir"], OLD);
    assert_eq!(v["skipped"], serde_json::json!([KEPT, "2027-01-01/20270101T000000Z-0000000d", "../other", "users/other"]));
    let root = h.user_root(GOOD_KEY);
    assert!(!root.join(OLD).exists());
    assert!(root.join(KEPT).exists());
    // 回收区在用户数据根之外，保持 users/<指纹>/<任务目录> 形状。
    let moved = std::fs::read_dir(h.data_root().join("recycle")).unwrap().next().unwrap().unwrap();
    assert!(moved.path().join(format!("users/{}/{}", common::fingerprint(GOOD_KEY), OLD)).join("task.json").exists());
    // 请求体不是数组。
    let bad = h.send(Method::POST, "/api/cleanup/unreferenced", Some(&cookie), "{}").await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn cleanup_refuses_while_any_board_is_unreadable() {
    let h = Harness::new();
    let cookie = setup(&h).await;
    write_board(&h, GOOD_KEY, "坏.ugcboard.json", "{}");
    let r = h.send(Method::POST, "/api/cleanup/unreferenced", Some(&cookie), serde_json::json!({"dirs":[OLD]}).to_string()).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text());
    assert_eq!(r.json()["code"], "board_unreadable");
    assert!(h.user_root(GOOD_KEY).join(OLD).exists());
}

fn walk_bytes(path: &std::path::Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).unwrap().len();
    }
    std::fs::read_dir(path).unwrap().map(|e| walk_bytes(&e.unwrap().path())).sum()
}
