//! 清理（ADR 0018，ADR 0010「任务目录不删」的服务端例外）。
//!
//! 候选只有两类：
//! - 闲置用户：连续 60 天无访问的用户数据根（最后访问时间取 `.kacha/user.json`，缺失时取整棵树最新修改时间）；
//! - 未引用任务目录：该用户所有画板（用户数据根内任意位置，含 `.bak`）都不引用、且建立超过 30 天。建立时间取
//!   「task_id 时间戳」与「目录内最新修改时间」中较晚者（保守：导入或刚写入的不会被当成旧目录）。
//!
//! 任一画板读不懂（损坏 / 版本更高）时该用户本轮不清理任务目录。正式执行把候选移入
//! `<数据根>/recycle/<UTC 时刻>/…`（保持原相对路径，便于管理员搬回），超过 14 天的批次在下次执行时彻底删除；
//! `--purge` 跳过回收区。任务目录的缩略图缓存直接删除，不进回收区（#49）。不自动运行：只有管理员命令与用户自助清理两个入口。

use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::references::{board_task_dirs, is_date_dir};
use crate::store::BOARD_EXTENSION;

const DAY: u64 = 86400;
pub const IDLE_AFTER: Duration = Duration::from_secs(60 * DAY);
pub const UNREFERENCED_AFTER: Duration = Duration::from_secs(30 * DAY);
pub const RECYCLE_KEEP: Duration = Duration::from_secs(14 * DAY);

pub const USERS_DIR: &str = "users";
pub const RECYCLE_DIR: &str = "recycle";
pub const BOARDS_DIR: &str = "画板";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    IdleUser,
    UnreferencedTaskDir,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::IdleUser => "闲置用户",
            Kind::UnreferencedTaskDir => "未引用任务目录",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub kind: Kind,
    /// 相对数据根，正斜杠。
    pub rel: String,
    pub bytes: u64,
    /// 闲置用户：最后访问时间；任务目录：目录内最新修改时间（文件只写一次，服务端不记逐目录读取）。
    pub last_access: SystemTime,
}

/// 用户数据根内的一个未引用任务目录（相对用户数据根，`<日期>/<task_id>`）。
#[derive(Debug, Clone)]
pub struct TaskDirCandidate {
    pub dir: String,
    pub bytes: u64,
    pub last_write: SystemTime,
}

#[derive(Debug, Clone)]
pub struct RecycleBatch {
    pub rel: String,
    pub bytes: u64,
    pub moved_at: SystemTime,
}

#[derive(Debug, Default)]
pub struct Plan {
    pub candidates: Vec<Candidate>,
    /// (用户数据根相对数据根, 原因)：该用户本轮不清理任务目录。
    pub skipped: Vec<(String, String)>,
    pub expired_recycle: Vec<RecycleBatch>,
}

/// 画板读不懂：给出相对用户数据根的画板路径。
#[derive(Debug, Clone, PartialEq)]
pub struct UnreadableBoard(pub String);

// ---- 文件树工具 ----

/// 整棵树的文件字节数（不跟随符号链接）。
pub fn tree_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).map(|it| it.flatten().map(|e| tree_bytes(&e.path())).sum()).unwrap_or(0)
}

/// 整棵树（含目录自身）的最新修改时间。
fn tree_newest(path: &Path) -> SystemTime {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return UNIX_EPOCH };
    let own = meta.modified().unwrap_or(UNIX_EPOCH);
    if !meta.is_dir() {
        return own;
    }
    std::fs::read_dir(path)
        .map(|it| it.flatten().map(|e| tree_newest(&e.path())).fold(own, SystemTime::max))
        .unwrap_or(own)
}

fn dir_names(path: &Path) -> io::Result<Vec<String>> {
    let mut names = Vec::new();
    for e in std::fs::read_dir(path)? {
        let e = e?;
        if e.file_type()?.is_dir() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
    }
    names.sort();
    Ok(names)
}

fn older_than(now: SystemTime, t: SystemTime, limit: Duration) -> bool {
    now.duration_since(t).map(|d| d > limit).unwrap_or(false)
}

// ---- 判断 ----

/// 用户的最后访问时间。
pub fn last_access(user_root: &Path) -> SystemTime {
    let meta = user_root.join(crate::META_DIR).join("user.json");
    std::fs::read(&meta)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("last_access_at").and_then(|n| n.as_u64()))
        .map(|s| UNIX_EPOCH + Duration::from_secs(s))
        .unwrap_or_else(|| tree_newest(user_root))
}

fn is_board_file(name: &str) -> bool {
    !name.starts_with('.') && (name.ends_with(BOARD_EXTENSION) || name.ends_with(&format!("{BOARD_EXTENSION}.bak")))
}

/// 该用户所有画板（含 `.bak`）引用的任务目录；任一读不懂即报错。
///
/// 递归整个用户数据根而不只是 `画板/`：画板写入 / 改名接口接受用户数据根内的任意路径，
/// 只扫 `画板/` 会把别处画板引用的任务目录误判为未引用。不跟随符号链接。
pub fn referenced_task_dirs(user_root: &Path) -> Result<BTreeSet<String>, UnreadableBoard> {
    let mut out = BTreeSet::new();
    let mut stack = vec![user_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let rel = || path.strip_prefix(user_root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(path),
                Ok(t) if t.is_file() && is_board_file(&name) => {
                    let text = std::fs::read(&path).map_err(|_| UnreadableBoard(rel()))?;
                    let dirs = board_task_dirs(&String::from_utf8_lossy(&text)).ok_or_else(|| UnreadableBoard(rel()))?;
                    out.extend(dirs);
                }
                _ => {}
            }
        }
    }
    Ok(out)
}

/// 用户数据根内全部任务目录（`<日期>/<task_id>`，跳过隐藏条目）。
pub fn task_dirs(user_root: &Path) -> io::Result<Vec<String>> {
    let mut out = Vec::new();
    for date in dir_names(user_root)? {
        if !is_date_dir(&date) {
            continue;
        }
        for id in dir_names(&user_root.join(&date))? {
            if !id.starts_with('.') {
                out.push(format!("{date}/{id}"));
            }
        }
    }
    Ok(out)
}

/// 一个用户的未引用任务目录（用户自助清理与管理员命令同一规则）。
pub fn unreferenced_task_dirs(user_root: &Path, now: SystemTime) -> io::Result<Result<Vec<TaskDirCandidate>, UnreadableBoard>> {
    let referenced = match referenced_task_dirs(user_root) {
        Ok(r) => r,
        Err(e) => return Ok(Err(e)),
    };
    let mut out = Vec::new();
    for dir in task_dirs(user_root)? {
        if referenced.contains(&dir) {
            continue;
        }
        let abs = user_root.join(&dir);
        let last_write = tree_newest(&abs);
        let stamp = dir.split('/').nth(1).and_then(task_id_time);
        let established = stamp.map_or(last_write, |s| s.max(last_write));
        if older_than(now, established, UNREFERENCED_AFTER) {
            out.push(TaskDirCandidate { bytes: tree_bytes(&abs), dir, last_write });
        }
    }
    Ok(Ok(out))
}

/// 管理员清理计划。
pub fn plan(data_root: &Path, now: SystemTime) -> io::Result<Plan> {
    let mut plan = Plan::default();
    let users = data_root.join(USERS_DIR);
    let fps = if users.is_dir() { dir_names(&users)? } else { Vec::new() };
    for fp in fps {
        let root = users.join(&fp);
        let user_rel = format!("{USERS_DIR}/{fp}");
        let access = last_access(&root);
        if older_than(now, access, IDLE_AFTER) {
            plan.candidates.push(Candidate { kind: Kind::IdleUser, rel: user_rel, bytes: tree_bytes(&root), last_access: access });
            continue;
        }
        match unreferenced_task_dirs(&root, now)? {
            Ok(dirs) => plan.candidates.extend(dirs.into_iter().map(|d| Candidate {
                kind: Kind::UnreferencedTaskDir,
                rel: format!("{user_rel}/{}", d.dir),
                bytes: d.bytes,
                last_access: d.last_write,
            })),
            Err(UnreadableBoard(board)) => plan.skipped.push((user_rel, format!("画板读不懂（{board}），本轮不清理其任务目录"))),
        }
    }
    // 列出顺序稳定：先闲置用户，再未引用任务目录，各自按路径。
    plan.candidates.sort_by_key(|c| (c.kind != Kind::IdleUser, c.rel.clone()));
    let recycle = data_root.join(RECYCLE_DIR);
    if recycle.is_dir() {
        for name in dir_names(&recycle)? {
            if let Some(moved_at) = parse_stamp(&name) {
                if older_than(now, moved_at, RECYCLE_KEEP) {
                    plan.expired_recycle.push(RecycleBatch { bytes: tree_bytes(&recycle.join(&name)), rel: format!("{RECYCLE_DIR}/{name}"), moved_at });
                }
            }
        }
    }
    Ok(plan)
}

// ---- 执行 ----

/// 本次执行的回收区批次目录名。
fn batch_dir(data_root: &Path, now: SystemTime) -> PathBuf {
    data_root.join(RECYCLE_DIR).join(format_stamp(now))
}

/// 把一个未引用任务目录（`users/<指纹>/<日期>/<task_id>`）移入回收区，并删掉它的缩略图。
pub fn recycle_task_dir(data_root: &Path, rel: &str, now: SystemTime) -> io::Result<()> {
    move_to_recycle(data_root, rel, now)?;
    drop_thumbs(data_root, rel);
    Ok(())
}

/// 任务目录离开用户数据根后，`.kacha/thumbs` 下对应的缩略图直接删除，不进回收区：缓存随时可重建，
/// `cleanup restore` 搬回任务目录后下次请求自会重新生成。闲置用户整根移走时 `.kacha` 随之移走，不走这里。
/// 删除失败只记日志，不影响清理结果。
fn drop_thumbs(data_root: &Path, rel: &str) {
    let mut parts = rel.splitn(3, '/');
    let (Some(USERS_DIR), Some(fp), Some(dir)) = (parts.next(), parts.next(), parts.next()) else { return };
    let meta = data_root.join(USERS_DIR).join(fp).join(crate::META_DIR);
    let thumbs = meta.join(crate::thumbs::THUMBS_DIR).join(dir);
    match std::fs::remove_dir_all(&thumbs) {
        Ok(()) => remove_empty_parent(&thumbs),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            let fields = serde_json::json!({ "path": dir, "error": format!("清理时删除缩略图失败：{e}") });
            let _ = crate::logger::Logger::new(meta, crate::VERSION).log("thumb_failed", fields.as_object().unwrap());
        }
    }
}

/// 把数据根内的 `rel` 移入回收区（保持相对路径）；同一批次内同名时加序号。
fn move_to_recycle(data_root: &Path, rel: &str, now: SystemTime) -> io::Result<()> {
    let src = data_root.join(rel);
    let mut target = batch_dir(data_root, now).join(rel);
    let mut n = 1;
    while target.exists() {
        target = batch_dir(data_root, now).join(format!("{rel}~{n}"));
        n += 1;
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&src, &target)?;
    remove_empty_parent(&src);
    Ok(())
}

/// 任务目录移走后，空的日期目录一并去掉（失败忽略）。
fn remove_empty_parent(src: &Path) {
    if let Some(parent) = src.parent() {
        if parent.file_name().and_then(|n| n.to_str()).is_some_and(is_date_dir) {
            let _ = std::fs::remove_dir(parent);
        }
    }
}

fn delete(data_root: &Path, rel: &str) -> io::Result<()> {
    let path = data_root.join(rel);
    if std::fs::symlink_metadata(&path)?.is_dir() {
        std::fs::remove_dir_all(&path)?;
    } else {
        std::fs::remove_file(&path)?;
    }
    remove_empty_parent(&path);
    Ok(())
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub done: Vec<String>,
    pub failed: Vec<(String, String)>,
}

/// 正式执行：先彻底删除过期回收区批次，再处理候选（purge = 直接删除）。单条失败不中断。
pub fn execute(data_root: &Path, plan: &Plan, now: SystemTime, purge: bool) -> Outcome {
    let mut out = Outcome::default();
    for batch in &plan.expired_recycle {
        match delete(data_root, &batch.rel) {
            Ok(()) => out.done.push(batch.rel.clone()),
            Err(e) => out.failed.push((batch.rel.clone(), e.to_string())),
        }
    }
    for c in &plan.candidates {
        let r = match (c.kind, purge) {
            (_, true) => delete(data_root, &c.rel).inspect(|()| drop_thumbs(data_root, &c.rel)),
            (Kind::IdleUser, false) => move_to_recycle(data_root, &c.rel, now),
            (Kind::UnreferencedTaskDir, false) => recycle_task_dir(data_root, &c.rel, now),
        };
        match r {
            Ok(()) => out.done.push(c.rel.clone()),
            Err(e) => out.failed.push((c.rel.clone(), e.to_string())),
        }
    }
    out
}

// ---- 时间 ----

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn parts(t: SystemTime) -> (i64, u32, u32, u64, u64, u64) {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / DAY) as i64);
    let rem = secs % DAY;
    (y, m, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `YYYY-MM-DDTHH:MM:SSZ`
pub fn format_utc(t: SystemTime) -> String {
    let (y, m, d, hh, mm, ss) = parts(t);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// 回收区批次名 `YYYYMMDDTHHMMSSZ`（与 task_id 时间戳同形）。
fn format_stamp(t: SystemTime) -> String {
    let (y, m, d, hh, mm, ss) = parts(t);
    format!("{y:04}{m:02}{d:02}T{hh:02}{mm:02}{ss:02}Z")
}

fn from_fields(y: &str, mo: &str, d: &str, h: &str, mi: &str, s: &str) -> Option<SystemTime> {
    let (y, mo, d): (i64, u32, u32) = (y.parse().ok()?, mo.parse().ok()?, d.parse().ok()?);
    let (h, mi, s): (u64, u64, u64) = (h.parse().ok()?, mi.parse().ok()?, s.parse().ok()?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = u64::try_from(days_from_civil(y, mo, d)).ok()?;
    Some(UNIX_EPOCH + Duration::from_secs(days * DAY + h * 3600 + mi * 60 + s))
}

fn parse_stamp(s: &str) -> Option<SystemTime> {
    let b = s.as_bytes();
    if b.len() != 16 || b[8] != b'T' || b[15] != b'Z' || !s[..8].bytes().chain(s[9..15].bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    from_fields(&s[0..4], &s[4..6], &s[6..8], &s[9..11], &s[11..13], &s[13..15])
}

fn task_id_time(task_id: &str) -> Option<SystemTime> {
    parse_stamp(task_id.get(..16)?)
}

/// `--now`：Unix 秒或 `YYYY-MM-DDTHH:MM:SSZ`。
pub fn parse_now(s: &str) -> Option<SystemTime> {
    if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
        return Some(UNIX_EPOCH + Duration::from_secs(s.parse().ok()?));
    }
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    from_fields(&s[0..4], &s[5..7], &s[8..10], &s[11..13], &s[14..16], &s[17..19])
}

// ---- 命令行 ----

const USAGE: &str = "用法：kacha-server cleanup [--dry-run | --purge] [--data-root <目录>] [--now <Unix 秒 | YYYY-MM-DDTHH:MM:SSZ>]\n\
  --dry-run  只列候选（类别、路径、大小、最后访问时间）与将彻底删除的回收区批次，不改动磁盘\n\
  --purge    跳过回收区直接删除（磁盘紧急时）\n\
  默认       候选移入 <数据根>/recycle/<UTC 时刻>/，超过 14 天的批次彻底删除\n\
  数据根也可用环境变量 KACHA_DATA_ROOT；--now 只供测试与演练\n\
  恢复：kacha-server cleanup restore [--data-root <目录>] [<批次>/<原路径>]\n\
  恢复     不带条目时列出回收区；带条目时把它搬回原位置，目标已存在则拒绝";

const RESTORE_USAGE: &str = "用法：kacha-server cleanup restore [--data-root <目录>] [<批次>/<原路径>]";

/// 回收区里可独立恢复的条目：整个闲置用户数据根，或一个未引用任务目录。
fn recycle_entries(data_root: &Path) -> io::Result<Vec<String>> {
    let mut entries = Vec::new();
    let recycle = data_root.join(RECYCLE_DIR);
    if !recycle.is_dir() {
        return Ok(entries);
    }
    for batch in dir_names(&recycle)? {
        let batch_root = recycle.join(&batch);
        let users = batch_root.join(USERS_DIR);
        if !users.is_dir() {
            continue;
        }
        for fp in dir_names(&users)? {
            let user = users.join(&fp);
            let prefix = format!("{batch}/{USERS_DIR}/{fp}");
            if user.join(crate::META_DIR).is_dir() {
                entries.push(prefix);
                continue;
            }
            for date in dir_names(&user)? {
                if !is_date_dir(&date) {
                    continue;
                }
                for task in dir_names(&user.join(&date))? {
                    entries.push(format!("{prefix}/{date}/{task}"));
                }
            }
        }
    }
    entries.sort();
    Ok(entries)
}

fn restore_entry(data_root: &Path, entry: &str) -> io::Result<()> {
    if entry.contains('\\') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "条目必须使用正斜杠相对路径"));
    }
    let path = Path::new(entry);
    let mut components = path.components();
    let Some(std::path::Component::Normal(batch)) = components.next() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "条目必须包含回收区批次"));
    };
    if parse_stamp(&batch.to_string_lossy()).is_none() || components.clone().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "回收区条目无效"));
    }
    let original = components.as_path();
    if !original.starts_with(USERS_DIR) || original.components().count() < 2 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "回收区条目必须来自 users/"));
    }
    let source = data_root.join(RECYCLE_DIR).join(path);
    if !source.exists() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "回收区条目不存在"));
    }
    let target = data_root.join(original);
    if target.exists() {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "原位置已存在，未覆盖"));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(source, target)
}

fn run_restore_cli(args: &[String]) -> i32 {
    let mut data_root = std::env::var("KACHA_DATA_ROOT").ok().unwrap_or_else(|| "./kacha-data".into());
    let mut entry = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--data-root" => {
                let Some(v) = it.next() else {
                    eprintln!("--data-root 缺少取值\n{RESTORE_USAGE}");
                    return 2;
                };
                data_root = v.clone();
            }
            "-h" | "--help" => {
                println!("{RESTORE_USAGE}");
                return 0;
            }
            other if other.starts_with('-') || entry.is_some() => {
                eprintln!("未知或重复参数：{other}\n{RESTORE_USAGE}");
                return 2;
            }
            other => entry = Some(other),
        }
    }
    let root = PathBuf::from(data_root);
    let entries = match recycle_entries(&root) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("读取回收区失败：{e}");
            return 1;
        }
    };
    let Some(selected) = entry else {
        println!("# 批次/原路径（相对 recycle）\t字节");
        for item in &entries {
            println!("{item}\t{}", tree_bytes(&root.join(RECYCLE_DIR).join(item)));
        }
        println!("# 可回收条目 {} 项；用 cleanup restore <条目> 恢复", entries.len());
        return 0;
    };
    if !entries.iter().any(|item| item == selected) {
        eprintln!("回收区条目不存在或不可独立恢复：{selected}");
        return 1;
    }
    match restore_entry(&root, selected) {
        Ok(()) => {
            println!("已恢复 {selected}");
            0
        }
        Err(e) => {
            eprintln!("恢复 {selected} 失败：{e}");
            1
        }
    }
}

/// `kacha-server cleanup …`；返回进程退出码（0 成功，1 有条目失败或读数据根失败，2 参数错误）。
pub fn run_cli(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("restore") {
        return run_restore_cli(&args[1..]);
    }
    let mut dry_run = false;
    let mut purge = false;
    let mut data_root = std::env::var("KACHA_DATA_ROOT").ok().unwrap_or_else(|| "./kacha-data".into());
    let mut now = SystemTime::now();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dry-run" => dry_run = true,
            "--purge" => purge = true,
            "--data-root" | "--now" => {
                let Some(v) = it.next() else {
                    eprintln!("{a} 缺少取值\n{USAGE}");
                    return 2;
                };
                if a == "--data-root" {
                    data_root = v.clone();
                } else if let Some(t) = parse_now(v) {
                    now = t;
                } else {
                    eprintln!("--now 无效：{v}\n{USAGE}");
                    return 2;
                }
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return 0;
            }
            other => {
                eprintln!("未知参数：{other}\n{USAGE}");
                return 2;
            }
        }
    }
    if dry_run && purge {
        eprintln!("--dry-run 与 --purge 不能同时使用\n{USAGE}");
        return 2;
    }
    let root = PathBuf::from(&data_root);
    if !root.join(USERS_DIR).is_dir() {
        eprintln!("数据根下没有 {USERS_DIR}/：{}（--data-root 是否指对？）", root.display());
        return 1;
    }
    let plan = match plan(&root, now) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("扫描数据根失败：{e}");
            return 1;
        }
    };
    let total: u64 = plan.candidates.iter().map(|c| c.bytes).sum();
    println!("# kacha-server cleanup {}，数据根 {}，时刻 {}", if dry_run { "预览" } else if purge { "直接删除" } else { "移入回收区" }, root.display(), format_utc(now));
    println!("# 类别\t路径（相对数据根）\t字节\t最后访问时间");
    for (user, reason) in &plan.skipped {
        println!("# 跳过 {user}：{reason}");
    }
    for c in &plan.candidates {
        println!("{}\t{}\t{}\t{}", c.kind.label(), c.rel, c.bytes, format_utc(c.last_access));
    }
    for b in &plan.expired_recycle {
        println!("回收区过期\t{}\t{}\t{}", b.rel, b.bytes, format_utc(b.moved_at));
    }
    println!("# 候选 {} 项，共 {} 字节；回收区过期批次 {} 个", plan.candidates.len(), total, plan.expired_recycle.len());
    if dry_run {
        return 0;
    }
    let outcome = execute(&root, &plan, now, purge);
    for (rel, e) in &outcome.failed {
        eprintln!("失败 {rel}：{e}");
    }
    println!("# 完成 {} 项，失败 {} 项", outcome.done.len(), outcome.failed.len());
    i32::from(!outcome.failed.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_round_trip() {
        let t = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
        assert_eq!(format_utc(t), "2027-01-15T08:00:00Z");
        assert_eq!(parse_now("2027-01-15T08:00:00Z"), Some(t));
        assert_eq!(parse_stamp("20270115T080000Z"), Some(t));
        assert_eq!(format_utc(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
        assert_eq!(parse_now("2027-13-01T00:00:00Z"), None);
    }
}
