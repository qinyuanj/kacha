//! 归档与取消归档（#90，ADR 0019）：把画板（连同 `.bak`）在画板目录与其归档子目录之间搬移，画板文件格式不变。
//!
//! 目标文件名由前端按同名加 (2) 的规则挑好（与改名一致），这里只校验方向、版本与画板位；目标已被占（含孤立 `.bak`）409。
//! 取消归档新增一块可编辑画板，在 board_lock 内走共用的画板位检查，直到搬完才放锁。

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;

use crate::board_list::{ensure_board_slots, is_archive_slot, occupies_board_slot};
use crate::fs::{board_guarded_result, off_thread, resolve};
use crate::session::error;
use crate::{store, AppState, User};

#[derive(Deserialize)]
struct MoveRequest {
    from: String,
    to: String,
    /// 带版本：主文件内容已变 409 board_conflict（与改名、删除同语义）。
    version: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Archive,
    Unarchive,
}

/// POST /api/boards/archive：可编辑画板 → 归档子目录；腾出一个画板位。
pub async fn archive(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
    move_board(state, user, &body, Direction::Archive).await
}

/// POST /api/boards/unarchive：归档画板 → 画板目录；画板位满 409 board_slots_full。
pub async fn unarchive(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
    move_board(state, user, &body, Direction::Unarchive).await
}

async fn move_board(state: AppState, user: User, body: &[u8], direction: Direction) -> Response {
    let Ok(req) = serde_json::from_slice::<MoveRequest>(body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要 from 与 to");
    };
    let (from, to) = match (resolve(&state, &user, &req.from), resolve(&state, &user, &req.to)) {
        (Ok(f), Ok(t)) => (f, t),
        (Err(r), _) | (_, Err(r)) => return r,
    };
    let root = state.user_root(&user.fingerprint);
    let allowed = match direction {
        Direction::Archive => occupies_board_slot(&root, &from) && is_archive_slot(&root, &to),
        Direction::Unarchive => is_archive_slot(&root, &from) && occupies_board_slot(&root, &to),
    };
    if !allowed {
        return error(StatusCode::BAD_REQUEST, "bad_request", "归档只在画板目录与其归档子目录之间搬移画板文件");
    }
    let total = state.board_slots();
    let _lock = state.board_lock().lock().await;
    let moved = off_thread(move || -> Result<std::io::Result<()>, Response> {
        if let Err(e) = store::check_board_guard(&from, req.version.as_deref()) {
            return Ok(Err(e));
        }
        if direction == Direction::Unarchive {
            ensure_board_slots(&root, total, 1)?;
        }
        if let Some(dir) = to.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                return Ok(Err(e));
            }
        }
        Ok(store::rename_board_guarded(&from, &to, req.version.as_deref()))
    })
    .await;
    match moved {
        Ok(Ok(io)) => board_guarded_result(Ok(io)),
        Ok(Err(r)) | Err(r) => r,
    }
}
