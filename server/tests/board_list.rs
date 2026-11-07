//! #87 画板列表：GET /api/boards/list 返回每块画板的名称、是否归档、画板体量，以及画板位已用 / 总数与体量提醒线。

mod common;

use axum::http::StatusCode;
use common::*;
use kacha_server::BoardSizeLines;

const A: &str = "2026-10-01/20261001T000000Z-0000000a";
const B: &str = "2026-10-02/20261002T000000Z-0000000b";
const C: &str = "2026-10-03/20261003T000000Z-0000000c";

/// 任务目录里放两个文件（共 `bytes` 字节，含子目录里的图层）。
fn seed_task(h: &Harness, rel: &str, bytes: usize) {
    let dir = h.user_root(GOOD_KEY).join(rel);
    std::fs::create_dir_all(dir.join("layers")).unwrap();
    std::fs::write(dir.join("task.json"), "{}").unwrap();
    std::fs::write(dir.join("layers/01.png"), vec![7u8; bytes - 2]).unwrap();
}

/// 引用若干任务目录的画板：结果节点的 path 与 task_id 各指一次同一目录（同一目录只算一次）。
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

fn write_board(h: &Harness, rel: &str, text: &str) {
    let path = h.user_root(GOOD_KEY).join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn row<'a>(v: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    v["boards"].as_array().unwrap().iter().find(|b| b["name"] == name).unwrap_or_else(|| panic!("列表里没有 {name}：{v}"))
}

#[tokio::test]
async fn list_gives_each_board_its_size_archive_flag_and_slot_usage() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, A, 1000);
    seed_task(&h, B, 300);
    seed_task(&h, C, 50);
    // 两块画板共用 B：各自的体量都按完整字节计（不去重）。
    write_board(&h, "画板/大.ugcboard.json", &board_referencing(&[A, B]));
    write_board(&h, "画板/小.ugcboard.json", &board_referencing(&[B]));
    write_board(&h, "画板/空.ugcboard.json", &board_referencing(&[]));
    // 归档子目录里的画板：标为已归档、不占画板位。
    write_board(&h, "画板/归档/旧.ugcboard.json", &board_referencing(&[C]));

    let r = h.get("/api/boards/list", Some(&cookie)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    assert_eq!(v["boards"].as_array().unwrap().len(), 4, "{v}");
    assert_eq!(row(&v, "大.ugcboard.json")["bytes"], 1300);
    assert_eq!(row(&v, "大.ugcboard.json")["archived"], false);
    assert_eq!(row(&v, "大.ugcboard.json")["path"], "画板/大.ugcboard.json");
    assert_eq!(row(&v, "小.ugcboard.json")["bytes"], 300);
    assert_eq!(row(&v, "空.ugcboard.json")["bytes"], 0);
    assert_eq!(row(&v, "旧.ugcboard.json")["bytes"], 50);
    assert_eq!(row(&v, "旧.ugcboard.json")["archived"], true);
    assert_eq!(row(&v, "旧.ugcboard.json")["path"], "画板/归档/旧.ugcboard.json");
    // 默认配置：10 块画板位，500 MiB 黄、1 GiB 红。
    assert_eq!(v["slots"], serde_json::json!({ "used": 3, "total": 10 }));
    assert_eq!(v["size_lines"], serde_json::json!({ "warn": 500u64 * 1024 * 1024, "alert": 1024u64 * 1024 * 1024 }));
    // 需要会话。
    assert_eq!(h.get("/api/boards/list", None).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn list_counts_missing_task_dirs_as_zero_and_keeps_unreadable_boards_without_a_size() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, A, 400);
    // 引用了不存在的任务目录：缺的部分按 0 计。
    write_board(&h, "画板/缺图.ugcboard.json", &board_referencing(&[A, B]));
    // 读不懂的画板仍列出、占画板位，体量未知。
    write_board(&h, "画板/坏.ugcboard.json", "not json");
    // 只剩 .bak 的画板：按 .bak 计算。
    write_board(&h, "画板/只有备份.ugcboard.json.bak", &board_referencing(&[A]));

    let v = h.get("/api/boards/list", Some(&cookie)).await.json();
    assert_eq!(row(&v, "缺图.ugcboard.json")["bytes"], 400);
    assert!(row(&v, "坏.ugcboard.json")["bytes"].is_null(), "{v}");
    assert_eq!(row(&v, "只有备份.ugcboard.json")["bytes"], 400);
    assert_eq!(v["slots"]["used"], 3);
}

#[tokio::test]
async fn list_of_a_new_user_is_empty() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let v = h.get("/api/boards/list", Some(&cookie)).await.json();
    assert_eq!(v["boards"], serde_json::json!([]));
    assert_eq!(v["slots"]["used"], 0);
}

#[tokio::test]
async fn slot_count_and_size_lines_come_from_server_config() {
    let h = Harness::with_board_config(3, BoardSizeLines { warn: 1000, alert: 5000 });
    let cookie = h.session(GOOD_KEY).await;
    write_board(&h, "画板/一.ugcboard.json", &board_referencing(&[]));
    let v = h.get("/api/boards/list", Some(&cookie)).await.json();
    assert_eq!(v["slots"], serde_json::json!({ "used": 1, "total": 3 }));
    assert_eq!(v["size_lines"], serde_json::json!({ "warn": 1000, "alert": 5000 }));
}
