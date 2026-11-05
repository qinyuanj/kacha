//! 当前用户用量与自助清理：只处理自己的用户数据根，规则与管理员 `cleanup` 命令一致。
//!
//! 用户只能移走未引用任务目录（闲置用户只能由管理员处理）；删除同样先进回收区。
//! 不缓存引用判断：每次请求重读画板，接受 O(画板文件) 的扫描换取「读不懂就拒绝」的保守语义。

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::cleanup::{self, TaskDirCandidate, UnreadableBoard};
use crate::session::error;
use crate::{AppState, User};

#[derive(Deserialize)]
struct CleanupRequest {
    dirs: Vec<String>,
}

fn candidate_json(d: &TaskDirCandidate) -> Value {
    json!({
        "dir": d.dir,
        "bytes": d.bytes,
        "last_write": d.last_write.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs(),
    })
}

/// GET /api/usage：总量、按日期目录汇总、画板与元数据量、最后访问时间，以及未引用任务目录清单。
pub async fn usage(State(state): State<AppState>, user: User) -> Response {
    let root = state.user_root(&user.fingerprint);
    let now = state.now();
    match crate::fs::off_thread(move || {
        let total = cleanup::tree_bytes(&root);
        let mut by_date: Vec<(String, u64)> = Vec::new();
        for dir in cleanup::task_dirs(&root).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()))? {
            let (date, _) = dir.split_once('/').unwrap();
            let bytes = cleanup::tree_bytes(&root.join(&dir));
            if let Some(row) = by_date.iter_mut().find(|(d, _)| d == date) {
                row.1 += bytes;
            } else {
                by_date.push((date.to_string(), bytes));
            }
        }
        let access = cleanup::last_access(&root).duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let (unreferenced, unreadable) = match cleanup::unreferenced_task_dirs(&root, now).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()))? {
            Ok(dirs) => (json!(dirs.iter().map(candidate_json).collect::<Vec<_>>()), Value::Null),
            Err(UnreadableBoard(board)) => (Value::Null, json!(board)),
        };
        Ok(Json(json!({
            "total_bytes": total,
            "boards_bytes": cleanup::tree_bytes(&root.join(cleanup::BOARDS_DIR)),
            "meta_bytes": cleanup::tree_bytes(&root.join(crate::META_DIR)),
            "last_access": access,
            "by_date": by_date.iter().map(|(date, bytes)| json!({ "date": date, "bytes": bytes })).collect::<Vec<_>>(),
            "unreferenced": unreferenced,
            "unreadable_board": unreadable,
        }))
        .into_response())
    })
    .await
    {
        Ok(Ok(r)) | Ok(Err(r)) | Err(r) => r,
    }
}

/// POST /api/cleanup/unreferenced {dirs:[…]}：逐条重算候选资格，合格的移入回收区。
pub async fn cleanup_unreferenced(State(state): State<AppState>, user: User, body: Bytes) -> Response {
    let req = match serde_json::from_slice::<CleanupRequest>(&body) {
        Ok(r) => r,
        Err(_) => return error(StatusCode::BAD_REQUEST, "bad_request", "请求体需要 { \"dirs\": [\"<日期>/<task_id>\", …] }"),
    };
    let data_root = state.data_root();
    let root = state.user_root(&user.fingerprint);
    let rel_prefix = format!("users/{}", user.fingerprint);
    let now = state.now();
    match crate::fs::off_thread(move || {
        let dirs = match cleanup::unreferenced_task_dirs(&root, now).map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()))? {
            Ok(dirs) => dirs,
            Err(UnreadableBoard(board)) => {
                return Err(error(StatusCode::CONFLICT, "board_unreadable", &format!("画板读不懂（{board}），为避免误删暂不清理；请先修好或导出画板包")))
            }
        };
        let mut moved = Vec::new();
        let mut skipped = Vec::new();
        for want in req.dirs {
            match dirs.iter().find(|d| d.dir == want) {
                Some(d) => match cleanup::move_to_recycle(&data_root, &format!("{rel_prefix}/{}", d.dir), now) {
                    Ok(()) => moved.push(candidate_json(d)),
                    Err(e) => return Err(error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string())),
                },
                None => skipped.push(want),
            }
        }
        Ok(Json(json!({ "moved": moved, "skipped": skipped })).into_response())
    })
    .await
    {
        Ok(Ok(r)) | Ok(Err(r)) | Err(r) => r,
    }
}

use axum::response::IntoResponse;
