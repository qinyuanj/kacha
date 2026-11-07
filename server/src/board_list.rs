//! 画板列表（#87）：每块画板的名称、是否归档、画板体量，以及画板位已用 / 总数。
//!
//! 画板体量 = 画板引用的全部任务目录的字节和（按文件长度累加，不按内容去重），引用判定复用清理的
//! `references::board_task_dirs`，不另立画板格式知识；所以它可能略大于导出画板包时去重后的预估，界面一律写「约 X」。
//! 画板位已用 = 画板目录（不含归档子目录）下的画板数；读不懂的画板也占位。

use std::path::Path;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::cleanup::{tree_bytes, BOARDS_DIR};
use crate::references::board_task_dirs;
use crate::store::{bak_path, list_board_names};
use crate::{AppState, User};

/// 画板位数量默认值（ADR 0019）。
pub const DEFAULT_BOARD_SLOTS: u32 = 10;

/// 归档画板放在画板目录下的这个子目录里（画板文件格式不变）。
pub const ARCHIVE_DIR: &str = "归档";

const MIB: u64 = 1024 * 1024;

/// 画板体量提醒线（字节）：超过 warn 标黄，超过 alert 标红。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BoardSizeLines {
    pub warn: u64,
    pub alert: u64,
}

impl Default for BoardSizeLines {
    fn default() -> Self {
        BoardSizeLines { warn: 500 * MIB, alert: 1024 * MIB }
    }
}

#[derive(Serialize)]
struct BoardRow {
    /// 画板文件名（含扩展名）。
    name: String,
    /// 相对用户数据根，正斜杠。
    path: String,
    archived: bool,
    /// 画板体量；主文件与 `.bak` 都读不懂时为 null（未知，不当成 0）。
    bytes: Option<u64>,
}

#[derive(Serialize)]
struct Slots {
    used: usize,
    total: u32,
}

#[derive(Serialize)]
struct BoardList {
    boards: Vec<BoardRow>,
    slots: Slots,
    size_lines: BoardSizeLines,
}

/// 一块画板的体量：主文件读不懂时按 `.bak` 算（与打开画板时的回退一致）。
fn board_bytes(user_root: &Path, board: &Path) -> Option<u64> {
    let dirs = [board.to_path_buf(), bak_path(board)]
        .iter()
        .find_map(|p| std::fs::read(p).ok().and_then(|b| board_task_dirs(&String::from_utf8_lossy(&b))))?;
    Some(dirs.iter().map(|d| tree_bytes(&user_root.join(d))).sum())
}

fn rows(user_root: &Path, rel_dir: &str, archived: bool) -> std::io::Result<Vec<BoardRow>> {
    let dir = user_root.join(rel_dir);
    Ok(list_board_names(&dir)?
        .into_iter()
        .map(|name| BoardRow { bytes: board_bytes(user_root, &dir.join(&name)), path: format!("{rel_dir}/{name}"), name, archived })
        .collect())
}

/// GET /api/boards/list：可编辑画板在前、归档画板在后，各自按文件名。
pub async fn list_boards(State(state): State<AppState>, user: User) -> Response {
    let root = state.user_root(&user.fingerprint);
    let (total, size_lines) = (state.board_slots(), state.board_size_lines());
    let listed = crate::fs::off_thread(move || -> std::io::Result<BoardList> {
        let mut boards = rows(&root, BOARDS_DIR, false)?;
        let used = boards.len();
        boards.extend(rows(&root, &format!("{BOARDS_DIR}/{ARCHIVE_DIR}"), true)?);
        Ok(BoardList { boards, slots: Slots { used, total }, size_lines })
    })
    .await;
    match listed {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(e)) => crate::fs::io_error(e),
        Err(r) => r,
    }
}
