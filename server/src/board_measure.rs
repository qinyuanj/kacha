//! 整理模式的体量（#92）：按任务目录量一块画板（请求体里的画板原文，可以是还没保存的内容）。
//!
//! 返回每个节点引用的任务目录，以及画板引用的每个任务目录的字节数。口径与画板列表的画板体量一致：
//! 引用判定同为 `references`，字节同为 `cleanup::tree_bytes`；各目录字节之和就是画板体量。
//! 阶段体量、「收掉未定稿」预计减少多少由前端按节点做集合运算，服务端不需要知道阶段与定稿。

use std::collections::BTreeMap;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::cleanup::tree_bytes;
use crate::references::board_node_task_dirs;
use crate::session::error;
use crate::{AppState, User};

#[derive(Serialize)]
struct BoardMeasure {
    /// 节点 id → 它引用的任务目录（相对用户数据根）；不引用任务目录的节点不列。
    nodes: BTreeMap<String, Vec<String>>,
    /// 画板引用的每个任务目录 → 字节数（不存在按 0）。
    dirs: BTreeMap<String, u64>,
}

/// POST /api/boards/measure：请求体为画板原文；读不懂（损坏 / 版本更高）400。
pub async fn measure_board(State(state): State<AppState>, user: User, body: Bytes) -> Response {
    let Some(nodes) = board_node_task_dirs(&String::from_utf8_lossy(&body)) else {
        return error(StatusCode::BAD_REQUEST, "unreadable_board", "读不懂这块画板");
    };
    let root = state.user_root(&user.fingerprint);
    let measured = crate::fs::off_thread(move || {
        let mut out = BoardMeasure { nodes: BTreeMap::new(), dirs: BTreeMap::new() };
        for node in nodes {
            for dir in &node.dirs {
                if !out.dirs.contains_key(dir) {
                    out.dirs.insert(dir.clone(), tree_bytes(&root.join(dir)));
                }
            }
            if let (Some(id), false) = (node.id, node.dirs.is_empty()) {
                out.nodes.entry(id).or_default().extend(node.dirs);
            }
        }
        out
    })
    .await;
    match measured {
        Ok(m) => Json(m).into_response(),
        Err(r) => r,
    }
}
