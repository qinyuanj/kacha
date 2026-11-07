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

#[derive(serde::Deserialize)]
struct BoardPolicy {
    archive_dir: String,
    default_board_title: String,
    archived_read_only: String,
    slots_full: String,
    slots_full_head: String,
}

fn policy() -> &'static BoardPolicy {
    static POLICY: std::sync::OnceLock<BoardPolicy> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| serde_json::from_str(include_str!("../../contracts/board-policy.json")).expect("valid board policy contract"))
}

pub fn default_board_title() -> &'static str { &policy().default_board_title }

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

/// 可编辑画板计数与列表使用同一规则：只剩 .bak 的也占位，归档子目录不占位。
pub fn used_board_slots(user_root: &Path) -> std::io::Result<usize> {
    Ok(list_board_names(&user_root.join(BOARDS_DIR))?.len())
}

/// 所有新增可编辑画板的服务端路径共用的预检（#89）：新建画板、导入画板包，以及之后的取消归档、复制为新画板、移出为新画板。
/// 位满时 409 `board_slots_full`，文案从 TS/Rust 共用的 board-policy 契约读取。
/// 调用方必须持有 AppState::board_lock，并一直持有到新增画板完成；additional 是本次新增总数。
/// 不为已有超额用户阻止编辑；additional = 0 时无论已用多少都允许。
pub fn ensure_board_slots(user_root: &Path, total: u32, additional: usize) -> Result<(), Response> {
    if additional == 0 {
        return Ok(());
    }
    let used = used_board_slots(user_root).map_err(crate::fs::io_error)?;
    if used.saturating_add(additional) <= total as usize {
        Ok(())
    } else {
        Err(crate::session::error(
            axum::http::StatusCode::CONFLICT,
            "board_slots_full",
            &policy().slots_full.replace("{head}", &policy().slots_full_head).replace("{used}", &used.to_string()).replace("{total}", &total.to_string()),
        ))
    }
}

/// 调用方持有画板锁；目标首次出现时检查画板位，已有主文件或备份不新增位。
pub fn ensure_new_board_path(root: &Path, total: u32, path: &Path) -> Result<(), Response> {
    let main = board_main_path(path);
    if occupies_board_slot(root, path) && !main.exists() && !bak_path(&main).exists() {
        ensure_board_slots(root, total, 1)?;
    }
    Ok(())
}

/// 主文件与仅剩备份共用同一个画板位。
pub fn board_main_path(path: &Path) -> std::path::PathBuf {
    if path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&format!("{}.bak", crate::store::BOARD_EXTENSION))) {
        path.with_file_name(path.file_name().unwrap().to_string_lossy().trim_end_matches(".bak"))
    } else { path.to_path_buf() }
}

/// 画板目录直属的主文件或备份；归档及其它子目录不计。
pub fn occupies_board_slot(user_root: &Path, path: &Path) -> bool {
    path.parent() == Some(user_root.join(BOARDS_DIR).as_path())
        && board_main_path(path).file_name().is_some_and(|n| n.to_string_lossy().ends_with(crate::store::BOARD_EXTENSION))
}

/// 归档子目录（不保证存在）。
pub fn archive_dir(user_root: &Path) -> std::path::PathBuf {
    user_root.join(BOARDS_DIR).join(&policy().archive_dir)
}

/// 归档画板的位置：归档子目录直属的画板文件（#90）。
pub fn is_archive_slot(user_root: &Path, path: &Path) -> bool {
    path.parent() == Some(archive_dir(user_root).as_path())
        && path.file_name().is_some_and(|n| n.to_string_lossy().ends_with(crate::store::BOARD_EXTENSION))
}

/// 归档子目录下的任何路径都只读：写画板、改名都不能进出这里，只能经归档 / 取消归档（取消归档要检查画板位）。
pub fn in_archive(user_root: &Path, path: &Path) -> bool {
    path.starts_with(archive_dir(user_root))
}

/// 写入或改名碰到归档画板时的 409，文案由共享契约定义。
pub fn archived_read_only() -> Response {
    crate::session::error(axum::http::StatusCode::CONFLICT, "board_archived", &policy().archived_read_only)
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
    dirs.iter().map(|d| crate::paths::resolve(user_root, d).ok().map(|p| tree_bytes(&p))).sum()
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
        boards.extend(rows(&root, &format!("{BOARDS_DIR}/{}", policy().archive_dir), true)?);
        Ok(BoardList { boards, slots: Slots { used, total }, size_lines })
    })
    .await;
    match listed {
        Ok(Ok(list)) => Json(list).into_response(),
        Ok(Err(e)) => crate::fs::io_error(e),
        Err(r) => r,
    }
}
