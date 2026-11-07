//! #92 整理模式的体量：POST /api/boards/measure 按任务目录给出一块画板（请求体里的画板原文）的体量，
//! 口径与画板列表的画板体量一致（同一引用判定 + 同一字节累加）。

mod common;

use axum::http::{Method, StatusCode};
use common::*;
use serde_json::json;

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

fn task_id(dir: &str) -> &str {
    dir.split('/').nth(1).unwrap()
}

/// 两个结果（r1 在 A、r2 在 B）、一个参考图（也指 A）、一个最近提交在 C 的任务、一个提示词。
fn board() -> String {
    json!({
        "format_version": 2,
        "title": "b",
        "viewport": { "zoom": 1, "x": 0, "y": 0 },
        "edges": [],
        "nodes": [
            { "id": "r1", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": task_id(A), "file": "result.png", "path": format!("{A}/result.png"), "layer_count": 0, "record": {}, "final": true },
            { "id": "r2", "type": "result", "pos": [0, 0], "size": [1, 1], "task_id": task_id(B), "file": "result.png", "path": format!("{B}/result.png"), "layer_count": 0, "record": {} },
            { "id": "ref", "type": "reference", "pos": [0, 0], "size": [1, 1], "path": format!("{A}/result.png"), "sha256": "0", "display_name": "a.png" },
            { "id": "t", "type": "task", "pos": [0, 0], "size": [1, 1], "last_submitted": { "task_id": task_id(C) } },
            { "id": "p", "type": "prompt", "pos": [0, 0], "size": [1, 1], "text": "猫" }
        ],
        "stages": [{ "id": "s1", "name": "第一轮", "nodes": ["r1", "r2"], "collapsed": false }]
    })
    .to_string()
}

#[tokio::test]
async fn measure_gives_each_nodes_task_dirs_and_each_dirs_bytes_matching_the_board_list() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, A, 1000);
    seed_task(&h, B, 300);
    seed_task(&h, C, 50);
    let text = board();
    let path = h.user_root(GOOD_KEY).join("画板/b.ugcboard.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &text).unwrap();

    let r = h.send(Method::POST, "/api/boards/measure", Some(&cookie), text).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let v = r.json();
    // 每个节点引用的任务目录；不引用任何任务目录的节点（提示词）不列。
    assert_eq!(v["nodes"], json!({ "r1": [A], "r2": [B], "ref": [A], "t": [C] }));
    // 画板引用的每个任务目录的字节数（同一目录只列一次）。
    assert_eq!(v["dirs"], json!({ (A): 1000, (B): 300, (C): 50 }));

    // 与画板列表同一口径：各任务目录字节之和 = 列表里这块画板的体量。
    let list = h.get("/api/boards/list", Some(&cookie)).await.json();
    let listed = list["boards"].as_array().unwrap().iter().find(|b| b["name"] == "b.ugcboard.json").unwrap()["bytes"].as_u64().unwrap();
    let sum: u64 = v["dirs"].as_object().unwrap().values().map(|b| b.as_u64().unwrap()).sum();
    assert_eq!(sum, listed);
    assert_eq!(sum, 1350);
}

#[tokio::test]
async fn measure_counts_missing_task_dirs_as_zero() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed_task(&h, A, 1000);
    let v = h.send(Method::POST, "/api/boards/measure", Some(&cookie), board()).await.json();
    assert_eq!(v["dirs"], json!({ (A): 1000, (B): 0, (C): 0 }));
}

#[tokio::test]
async fn measure_rejects_unreadable_boards_and_needs_a_session() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let r = h.send(Method::POST, "/api/boards/measure", Some(&cookie), "not json").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.text());
    // 版本更高的画板读不懂，不能当成没有引用。
    let newer = board().replace(r#""format_version":2"#, r#""format_version":99"#);
    assert_eq!(h.send(Method::POST, "/api/boards/measure", Some(&cookie), newer).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(h.send(Method::POST, "/api/boards/measure", None, board()).await.status, StatusCode::UNAUTHORIZED);
}
