//! 画板包（ADR 0013）的 zip 读写与合并搬运。包格式的规则（带哪些条目、布局是否合法、合并单元怎么比对、
//! 结果怎么计数）全部在前端 core/boardPack.ts；这里只按给定条目与合并单元搬字节，并守住路径安全。
//!
//! 导出：流式写同目录临时文件，JSON deflate、其余 store，完成后 rename 覆盖目标。
//! 包格式 v2：导出前按规格给出逐文件长度与 sha256（entry_facts），导出时不写规格里 omitted 的条目。
//! 导入：只解压属于给定合并单元的条目到输出根目录下的临时目录，校验后逐个单元原子 rename 移入；
//! 目标已存在时按单元的身份文件（或整文件）比对，一致为跳过、不一致为冲突，均不覆盖。
//! 失败 / 取消时清理临时目录，已移入的保留；进程被杀留下的临时目录在下次导入开始时清理。
//! 包格式 v2 被省略的路径（前端核心已判过映射合法）在临时目录里还原：硬链接到代表文件，失败回退为复制，
//! 之后与实存条目一样按合并单元比对、移入（ADR 0018 补记）。
//! 去重上传（#62）：浏览器只上传缺少的内容（每份按 sha256 存在暂存里），再给「路径 → sha256」的落盘清单；
//! 同一份内容第一份落盘、其余硬链接（失败回退为复制），之后与整包导入走同一段校验与合并。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;

use crate::store;

pub const CANCELLED: &str = "已取消";
const CHUNK: usize = 1 << 20;
/// 导入临时目录名 `.ugcpack-import.<pid>-<纳秒>-<序号>.tmp`（由 store::temp_path_for 生成）。
const IMPORT_TEMP_STEM: &str = "ugcpack-import";

#[derive(Debug, Deserialize, Clone)]
pub struct PackText {
    pub entry: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct PackFile {
    /// 相对用户数据根的路径（Web 版接口不收绝对路径；绝对路径 / 越界 / 符号链接越界一律拒绝）。
    pub source: String,
    /// 包内路径（正斜杠）。
    pub entry: String,
}

#[derive(Debug, Deserialize)]
pub struct ExportSpec {
    /// 直接写入的文本条目（清单、画板）；算字节事实时不需要。
    #[serde(default)]
    pub texts: Vec<PackText>,
    /// 相对输出根目录的目录，整目录写入；本机不存在的跳过。
    pub task_dirs: Vec<String>,
    pub files: Vec<PackFile>,
    /// 包格式 v2 里不写的条目（前端核心按内容去重选出的被省略路径，已记进清单的 duplicates）。
    /// 必须是本规格要写的文件，不能是文本条目。
    #[serde(default)]
    pub omitted: Vec<String>,
}

/// 导出要写的一个文件的字节事实：包内路径、长度与 sha256（前端核心据此去重）。
#[derive(Debug, Serialize, PartialEq)]
pub struct EntryFact {
    pub entry: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ExportReport {
    pub task_dirs: usize,
    pub bytes: u64,
}

/// 合并单元：`identity` 为目录内判定「同一份」的相对文件；为 None 时单元本身是文件，按整文件比对。
#[derive(Debug, Deserialize)]
pub struct MergeUnit {
    pub path: String,
    pub identity: Option<String>,
}

/// v2 包里被省略的路径与它的代表条目（都是包内路径）：导入时把 path 还原为与 source 内容相同的文件。
#[derive(Debug, Deserialize, Clone)]
pub struct PackDuplicate {
    pub path: String,
    pub source: String,
}

/// 还原被省略路径的方式：默认硬链接；测试注入失败以走复制回退。
pub type Linker<'a> = dyn Fn(&Path, &Path) -> io::Result<()> + 'a;

/// 硬链接到代表文件；链接失败（文件系统不支持、跨卷、链接数上限等）时复制。目标已存在时报错，不覆盖。
fn link_or_copy(link: &Linker<'_>, source: &Path, dest: &Path) -> io::Result<()> {
    if dest.symlink_metadata().is_ok() {
        return Err(invalid(format!("还原目标已存在：{}", dest.display())));
    }
    if link(source, dest).is_ok() {
        return Ok(());
    }
    let mut from = File::open(source)?;
    let mut to = File::create_new(dest)?;
    io::copy(&mut from, &mut to)?;
    Ok(())
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MergeOutcome {
    Moved,
    Identical,
    Conflict,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct UnitOutcome {
    pub path: String,
    pub outcome: MergeOutcome,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ImportReport {
    pub outcomes: Vec<UnitOutcome>,
    pub bytes: u64,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn zip_err(e: zip::result::ZipError) -> io::Error {
    invalid(e.to_string())
}

fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(io::Error::new(io::ErrorKind::Interrupted, CANCELLED))
    } else {
        Ok(())
    }
}

/// 包内路径只允许正斜杠分隔的普通相对段：不含 `..`、`.`、空段、反斜杠、盘符与控制字符。
fn safe_join(base: &Path, name: &str) -> io::Result<PathBuf> {
    let ok = name.split('/').all(|s| !s.is_empty() && s != "." && s != ".." && !s.chars().any(|c| c == '\\' || c == ':' || c.is_control()));
    if !ok {
        return Err(invalid(format!("包内路径无效：{name}")));
    }
    Ok(name.split('/').fold(base.to_path_buf(), |p, s| p.join(s)))
}

/// 目录内全部文件（相对该目录，正斜杠，排序）；不跟随符号链接。
fn files_under(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), dir.to_path_buf())];
    while let Some((prefix, path)) = stack.pop() {
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push((format!("{name}/"), entry.path()));
            } else if kind.is_file() {
                out.push((name, entry.path()));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn copy_chunks(reader: &mut impl Read, writer: &mut impl Write, done: &mut u64, total: u64, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<()> {
    let mut buf = vec![0u8; CHUNK];
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        writer.write_all(&buf[..n])?;
        *done += n as u64;
        progress(*done, total);
    }
}

/// 流式 sha256：导出时给任务目录外的文件算包内名，不要求是可解码的图片。
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(format!("{:x}", hasher.finalize()));
        }
        hasher.update(&buf[..n]);
    }
}

/// 收集导出要读的本机文件：任务目录整目录 + 单文件，全部相对 root 解析（含符号链接越界检查）。
fn export_sources(root: &Path, spec: &ExportSpec) -> io::Result<(Vec<(String, PathBuf)>, usize)> {
    let mut sources: Vec<(String, PathBuf)> = Vec::new();
    let mut task_dirs = 0;
    for dir in &spec.task_dirs {
        let path = resolve_in(root, dir)?;
        if !path.is_dir() {
            continue;
        }
        task_dirs += 1;
        sources.extend(files_under(&path)?.into_iter().map(|(name, p)| (format!("{dir}/{name}"), p)));
    }
    for f in &spec.files {
        let path = resolve_in(root, &f.source)?;
        sources.push((f.entry.clone(), path));
    }
    let omitted: BTreeSet<&str> = spec.omitted.iter().map(String::as_str).collect();
    if let Some(name) = omitted.iter().find(|name| !sources.iter().any(|(n, _)| n == *name)) {
        return Err(invalid(format!("被省略的条目不是导出的文件：{name}")));
    }
    sources.retain(|(name, _)| !omitted.contains(name.as_str()));
    Ok((sources, task_dirs))
}

/// 导出要写的全部文件（不含 omitted 与文本条目）的长度与 sha256，按包内路径排序。progress 按已读字节报告，可取消。
pub fn entry_facts(root: &Path, spec: &ExportSpec, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<Vec<EntryFact>> {
    let (mut sources, _) = export_sources(root, spec)?;
    check_entry_names(&[], &sources)?;
    sources.sort();
    let total = sources.iter().map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();
    let mut done = 0;
    let mut facts = Vec::with_capacity(sources.len());
    let mut buf = vec![0u8; CHUNK];
    for (entry, path) in sources {
        let mut file = File::open(&path)?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        loop {
            check_cancel(cancel)?;
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            size += n as u64;
            done += n as u64;
            progress(done, total);
        }
        facts.push(EntryFact { entry, size, sha256: format!("{:x}", hasher.finalize()) });
    }
    Ok(facts)
}

/// 相对用户数据根解析：拒绝绝对路径、`..` 与符号链接越界（board_pack 不再接受浏览器传来的本机绝对路径）。
fn resolve_in(root: &Path, rel: &str) -> io::Result<PathBuf> {
    crate::paths::resolve(root, rel).map_err(|e| invalid(e.message()))
}

fn check_entry_names(texts: &[PackText], sources: &[(String, PathBuf)]) -> io::Result<()> {
    let mut names = BTreeSet::new();
    for name in texts.iter().map(|t| &t.entry).chain(sources.iter().map(|(n, _)| n)) {
        safe_join(Path::new(""), name)?;
        if !names.insert(name.as_str()) {
            return Err(invalid(format!("包内路径重复：{name}")));
        }
    }
    Ok(())
}

/// 导出预检：在开始发送下载流之前发现路径越界 / 条目非法，此时还能回 HTTP 错误状态。
pub fn validate_export(root: &Path, spec: &ExportSpec) -> io::Result<()> {
    let (sources, _) = export_sources(root, spec)?;
    check_entry_names(&spec.texts, &sources)
}

/// 边打包边写进 writer（HTTP 下载流用 ZipWriter::new_stream；落盘用 File）。不创建临时文件。
pub fn export_to_writer<W: Write>(root: &Path, spec: &ExportSpec, writer: W, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ExportReport> {
    let (sources, task_dirs) = export_sources(root, spec)?;
    check_entry_names(&spec.texts, &sources)?;
    let total = sources.iter().map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();
    let mut zip = zip::ZipWriter::new_stream(writer);
    let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for text in &spec.texts {
        zip.start_file(text.entry.as_str(), deflate).map_err(zip_err)?;
        zip.write_all(text.text.as_bytes())?;
    }
    let mut done = 0;
    for (name, path) in &sources {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        let options = if name.to_lowercase().ends_with(".json") { deflate } else { store };
        zip.start_file(name.as_str(), options.large_file(size >= u32::MAX as u64)).map_err(zip_err)?;
        copy_chunks(&mut file, &mut zip, &mut done, total, progress, cancel)?;
    }
    zip.finish().map_err(zip_err)?;
    Ok(ExportReport { task_dirs, bytes: done })
}

pub fn export(root: &Path, spec: &ExportSpec, target: &Path, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ExportReport> {
    // 先解析并校验条目，再创建临时文件：路径非法时不留任何文件。
    let (sources, task_dirs) = export_sources(root, spec)?;
    check_entry_names(&spec.texts, &sources)?;
    let total = sources.iter().map(|(_, p)| fs::metadata(p).map(|m| m.len()).unwrap_or(0)).sum::<u64>();

    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = store::temp_path_for(target);
    let result = (|| {
        let mut zip = zip::ZipWriter::new(File::create_new(&tmp)?);
        let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for text in &spec.texts {
            zip.start_file(text.entry.as_str(), deflate).map_err(zip_err)?;
            zip.write_all(text.text.as_bytes())?;
        }
        let mut done = 0;
        for (name, path) in &sources {
            let mut file = File::open(path)?;
            let size = file.metadata()?.len();
            let options = if name.to_lowercase().ends_with(".json") { deflate } else { store };
            zip.start_file(name.as_str(), options.large_file(size >= u32::MAX as u64)).map_err(zip_err)?;
            copy_chunks(&mut file, &mut zip, &mut done, total, progress, cancel)?;
        }
        let file = zip.finish().map_err(zip_err)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        Ok(ExportReport { task_dirs, bytes: done })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn open_archive(pack: &Path) -> io::Result<zip::ZipArchive<File>> {
    zip::ZipArchive::new(File::open(pack)?).map_err(|e| invalid(format!("不是有效的画板包：{e}")))
}

/// 包内全部文件条目名（不含目录条目）。
pub fn entries(pack: &Path) -> io::Result<Vec<String>> {
    let archive = open_archive(pack)?;
    Ok(archive.file_names().filter(|n| !n.ends_with('/')).map(str::to_string).collect())
}

/// 读指定条目的 UTF-8 文本；包内没有的条目不出现在结果里。
pub fn read_texts(pack: &Path, names: &[String]) -> io::Result<BTreeMap<String, String>> {
    let mut archive = open_archive(pack)?;
    let mut texts = BTreeMap::new();
    for name in names {
        let mut file = match archive.by_name(name) {
            Ok(file) => file,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(e) => return Err(zip_err(e)),
        };
        let mut text = String::new();
        file.read_to_string(&mut text).map_err(|_| invalid(format!("包内 {name} 不是 UTF-8 文本")))?;
        texts.insert(name.clone(), text);
    }
    Ok(texts)
}

/// 临时目录守卫：离开作用域时删除（成功时里面只剩未移入的单元）。
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 导入临时目录超过这个时间才被当作「进程被杀留下的」清理：并发导入互不删对方的目录。
const STALE_IMPORT_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// 清理进程被杀时留下的导入临时目录。多页面 / 多用户可同时导入，只删确认过期的（按目录 mtime）。
fn sweep_stale_imports(root: &Path) {
    let prefix = format!(".{IMPORT_TEMP_STEM}.");
    let now = std::time::SystemTime::now();
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with(&prefix) && name.ends_with(".tmp") && entry.file_type().is_ok_and(|t| t.is_dir())) {
            continue;
        }
        let stale = entry.metadata().and_then(|m| m.modified()).map(|m| now.duration_since(m).map(|d| d >= STALE_IMPORT_AGE).unwrap_or(false)).unwrap_or(false);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// 逐块比对两个文件；任一读不了视为不同。
fn same_file(a: &Path, b: &Path) -> bool {
    let compare = || -> io::Result<bool> {
        let (mut x, mut y) = (File::open(a)?, File::open(b)?);
        if x.metadata()?.len() != y.metadata()?.len() {
            return Ok(false);
        }
        let (mut bx, mut by) = (vec![0u8; CHUNK], vec![0u8; CHUNK]);
        loop {
            let n = x.read(&mut bx)?;
            if n == 0 {
                return Ok(true);
            }
            y.read_exact(&mut by[..n])?;
            if bx[..n] != by[..n] {
                return Ok(false);
            }
        }
    };
    compare().unwrap_or(false)
}

fn belongs_to_unit(units: &[MergeUnit], name: &str) -> bool {
    units.iter().any(|u| name == u.path || name.strip_prefix(u.path.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

pub fn import(pack: &Path, root: &Path, units: &[MergeUnit], duplicates: &[PackDuplicate], progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    import_with(pack, root, units, duplicates, &|from, to| fs::hard_link(from, to), progress, cancel)
}

/// 同 import，可注入还原被省略路径时的链接方式。
pub fn import_with(pack: &Path, root: &Path, units: &[MergeUnit], duplicates: &[PackDuplicate], link: &Linker<'_>, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    fs::create_dir_all(root)?;
    for unit in units {
        resolve_in(root, &unit.path)?;
        if let Some(identity) = &unit.identity {
            safe_join(Path::new(""), identity)?;
        }
    }
    for d in duplicates {
        safe_join(Path::new(""), &d.path)?;
        safe_join(Path::new(""), &d.source)?;
    }
    // 只还原落在合并单元里的省略路径；代表条目不在任何单元里时也要解压出来作为还原来源。
    let restore: Vec<&PackDuplicate> = duplicates.iter().filter(|d| belongs_to_unit(units, &d.path)).collect();
    let sources: BTreeSet<&str> = restore.iter().map(|d| d.source.as_str()).collect();
    let mut archive = open_archive(pack)?;
    let mut extract = Vec::new();
    let mut total = 0;
    for i in 0..archive.len() {
        let file = archive.by_index(i).map_err(zip_err)?;
        let name = file.name().to_string();
        if file.is_dir() || !(belongs_to_unit(units, &name) || sources.contains(name.as_str())) {
            continue;
        }
        safe_join(root, &name)?;
        total += file.size();
        extract.push((i, name));
    }

    fs::create_dir_all(root)?;
    sweep_stale_imports(root);
    let temp = TempDir(store::temp_path_for(&root.join(IMPORT_TEMP_STEM)));
    fs::create_dir(&temp.0)?;
    let mut done = 0;
    for (index, name) in &extract {
        let mut file = archive.by_index(*index).map_err(zip_err)?;
        let dest = safe_join(&temp.0, name)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create_new(&dest)?;
        copy_chunks(&mut file, &mut out, &mut done, total, progress, cancel)?;
    }

    // 还原被省略的路径（还在临时目录里，校验与比对看到的就是还原后的单元）。
    for d in &restore {
        check_cancel(cancel)?;
        let source = safe_join(&temp.0, &d.source)?;
        if !source.is_file() {
            return Err(invalid(format!("包内缺少 {}（{} 的代表条目）", d.source, d.path)));
        }
        let dest = safe_join(&temp.0, &d.path)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        link_or_copy(link, &source, &dest)?;
    }

    // 整包回退路径没有落盘清单：按解压（含还原）后的文件现算 sha256。
    check_reference_snapshots(&temp.0, units, |path| safe_join(&temp.0, path).ok().filter(|p| p.is_file()).and_then(|p| sha256_file(&p).ok()))?;
    let outcomes = merge_units(&temp.0, root, units, cancel)?;
    Ok(ImportReport { outcomes, bytes: done })
}

/// 两条导入路径共用的收尾：临时目录里已备好各单元（含还原的省略路径），先校验每个单元都在（目录单元还要有身份文件），
/// 不合格时一个都不移入；再逐个单元移入——目标已存在时按身份文件（或整文件）比对，一致为跳过、不一致为冲突，均不覆盖。
fn merge_units(temp: &Path, root: &Path, units: &[MergeUnit], cancel: &AtomicBool) -> io::Result<Vec<UnitOutcome>> {
    for unit in units {
        let from = safe_join(temp, &unit.path)?;
        let present = match &unit.identity {
            Some(identity) => safe_join(&from, identity)?.is_file(),
            None => from.is_file(),
        };
        if !present {
            return Err(invalid(format!("包内缺少 {}", unit.path)));
        }
    }

    let mut outcomes = Vec::new();
    for unit in units {
        check_cancel(cancel)?;
        let from = safe_join(temp, &unit.path)?;
        let to = resolve_in(root, &unit.path)?;
        let outcome = if to.exists() {
            let same = match &unit.identity {
                Some(identity) => same_file(&safe_join(&from, identity)?, &safe_join(&to, identity)?),
                None => same_file(&from, &to),
            };
            if same {
                MergeOutcome::Identical
            } else {
                MergeOutcome::Conflict
            }
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&from, &to)?;
            MergeOutcome::Moved
        };
        outcomes.push(UnitOutcome { path: unit.path.clone(), outcome });
    }
    Ok(outcomes)
}

// ---- 去重上传的落盘（#62） ----

/// 去重上传落盘清单的一项：合并单元里的一个文件与它的内容 sha256。「哪个路径对应哪份内容」由浏览器给、这里信任；
/// 内容本身在上传时已按 sha256 核对过。
#[derive(Debug, Deserialize, Clone)]
pub struct PlacedFile {
    pub path: String,
    pub sha256: String,
}

pub fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 暂存里一份内容的文件名（即它的 sha256）。
pub fn staged_content(staging: &Path, sha256: &str) -> PathBuf {
    staging.join(sha256)
}

pub fn import_staged(staging: &Path, root: &Path, units: &[MergeUnit], files: &[PlacedFile], progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    import_staged_with(staging, root, units, files, &|from, to| fs::hard_link(from, to), progress, cancel)
}

/// 按落盘清单把暂存的内容放进临时目录里的各单元：同一份内容第一份从暂存移过来，其余硬链接到它（失败回退为复制）；
/// 再比对 task.json 里记了 sha256 的参考图快照（不一致按损坏拒绝），最后与整包导入同样校验、合并。可注入链接方式。
pub fn import_staged_with(staging: &Path, root: &Path, units: &[MergeUnit], files: &[PlacedFile], link: &Linker<'_>, progress: &dyn Fn(u64, u64), cancel: &AtomicBool) -> io::Result<ImportReport> {
    fs::create_dir_all(root)?;
    for unit in units {
        resolve_in(root, &unit.path)?;
        if let Some(identity) = &unit.identity {
            safe_join(Path::new(""), identity)?;
        }
    }
    let mut declared = BTreeMap::new();
    for f in files {
        safe_join(Path::new(""), &f.path)?;
        if !belongs_to_unit(units, &f.path) {
            return Err(invalid(format!("落盘清单里的 {} 不属于任何合并单元", f.path)));
        }
        if !valid_sha256(&f.sha256) {
            return Err(invalid(format!("{} 的 sha256 无效", f.path)));
        }
        if declared.insert(f.path.as_str(), f.sha256.as_str()).is_some() {
            return Err(invalid(format!("落盘清单里的路径重复：{}", f.path)));
        }
        if !staged_content(staging, &f.sha256).is_file() {
            return Err(invalid(format!("缺少 {} 的内容（没有上传）", f.path)));
        }
    }

    fs::create_dir_all(root)?;
    sweep_stale_imports(root);
    let temp = TempDir(store::temp_path_for(&root.join(IMPORT_TEMP_STEM)));
    fs::create_dir(&temp.0)?;
    let mut placed: BTreeMap<&str, PathBuf> = BTreeMap::new();
    let total: u64 = declared.values().collect::<BTreeSet<_>>().iter().map(|sha| fs::metadata(staged_content(staging, sha)).map(|m| m.len()).unwrap_or(0)).sum();
    let mut done = 0;
    for (path, sha256) in &declared {
        check_cancel(cancel)?;
        let dest = safe_join(&temp.0, path)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        match placed.get(sha256) {
            Some(first) => link_or_copy(link, first, &dest)?,
            None => {
                // 第一份落盘：暂存与用户数据根在同一文件系统，直接移过来；移不了就复制。
                let blob = staged_content(staging, sha256);
                done += fs::metadata(&blob)?.len();
                if fs::rename(&blob, &dest).is_err() {
                    fs::copy(&blob, &dest)?;
                }
                placed.insert(sha256, dest);
                progress(done, total);
            }
        }
    }

    check_reference_snapshots(&temp.0, units, |path| declared.get(path).map(|sha| sha.to_string()))?;
    let outcomes = merge_units(&temp.0, root, units, cancel)?;
    Ok(ImportReport { outcomes, bytes: done })
}

/// task.json 的 references[] 里记了 sha256 的参考图快照，与这次导入里它的实际内容（`actual` 按包内路径给 sha256）比对；
/// 不一致按损坏拒绝。两条导入路径都比对：去重上传按落盘清单，整包回退按解压后的文件。
/// 这是「格式规则在前端核心」（ADR 0013）的信任边界例外：服务端只读快照的 file 与 sha256，不解释其他字段。
/// task.json 读不了或不是这个形状时不比对（旧包、非 Web 版的记录照常导入）。
fn check_reference_snapshots(temp: &Path, units: &[MergeUnit], actual: impl Fn(&str) -> Option<String>) -> io::Result<()> {
    for unit in units {
        let Some(identity) = &unit.identity else { continue };
        let Ok(text) = fs::read(safe_join(&safe_join(temp, &unit.path)?, identity)?) else { continue };
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(&text) else { continue };
        for reference in record.get("references").and_then(|r| r.as_array()).into_iter().flatten() {
            let (Some(file), Some(expected)) = (reference.get("file").and_then(|v| v.as_str()), reference.get("sha256").and_then(|v| v.as_str())) else { continue };
            let path = format!("{}/{file}", unit.path);
            if let Some(actual) = actual(&path) {
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(invalid(format!("参考图快照 {path} 与 task.json 记录的 sha256 不一致，画板包已损坏")));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK_A: &str = "2026-09-16/20260916T010000Z-0000000a";
    const TASK_B: &str = "2026-09-16/20260916T020000Z-0000000b";
    const REF: &str = "导入参考图/abc.png";
    const REF_SOURCE: &str = "别处/猫.png";

    fn no_progress(_: u64, _: u64) {}

    fn write(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    struct Fixture {
        tmp: tempfile::TempDir,
        root: PathBuf,
        external: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出 A");
        for dir in [TASK_A, TASK_B] {
            write(&root.join(dir).join("task.json"), format!("{{\"task_id\":\"{dir}\"}}").as_bytes());
            write(&root.join(dir).join("result.png"), &[0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        }
        write(&root.join(TASK_B).join("layers/01.png"), b"layer");
        write(&root.join("2026-09-16/20260916T030000Z-0000000c/task.json"), b"{}");
        // 根内但不在任务目录里的参考图（v0.3.x 的「根外」在 Web 版一律相对用户数据根）。
        write(&root.join(REF_SOURCE), b"cat");
        let external = root.join(REF_SOURCE);
        Fixture { tmp, root, external }
    }

    fn text(entry: &str, text: &str) -> PackText {
        PackText { entry: entry.into(), text: text.into() }
    }

    fn spec(f: &Fixture) -> ExportSpec {
        ExportSpec {
            texts: vec![text("manifest.json", "{\"pack_format_version\":1}"), text("画板/千问测试.ugcboard.json", "{\"title\":\"千问测试\"}")],
            task_dirs: vec![TASK_A.into(), TASK_B.into(), "2026-09-17/20260917T000000Z-missing".into()],
            files: vec![PackFile { source: REF_SOURCE.into(), entry: REF.into() }],
            omitted: vec![],
        }
    }

    fn units() -> Vec<MergeUnit> {
        let dir = |p: &str| MergeUnit { path: p.into(), identity: Some("task.json".into()) };
        vec![dir(TASK_A), dir(TASK_B), MergeUnit { path: REF.into(), identity: None }]
    }

    fn outcomes(report: &ImportReport) -> Vec<(&str, MergeOutcome)> {
        report.outcomes.iter().map(|o| (o.path.as_str(), o.outcome)).collect()
    }

    fn zip_entries(path: &Path) -> Vec<(String, zip::CompressionMethod)> {
        let mut archive = open_archive(path).unwrap();
        (0..archive.len())
            .map(|i| {
                let f = archive.by_index(i).unwrap();
                (f.name().to_string(), f.compression())
            })
            .collect()
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir).map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        names
    }

    fn make_zip(path: &Path, entries: &[&str]) {
        let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
        for e in entries {
            zip.start_file(*e, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn export_writes_texts_dirs_and_files_storing_images() {
        let f = fixture();
        let target = f.tmp.path().join("出/千问测试.ugcpack");
        let report = export(&f.root, &spec(&f), &target, &no_progress, &AtomicBool::new(false)).unwrap();
        let task_json_bytes: u64 = [TASK_A, TASK_B].iter().map(|d| fs::metadata(f.root.join(d).join("task.json")).unwrap().len()).sum();
        assert_eq!(report, ExportReport { task_dirs: 2, bytes: 7 + 7 + 5 + 3 + task_json_bytes });
        let entries = zip_entries(&target);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "manifest.json",
                "画板/千问测试.ugcboard.json",
                &format!("{TASK_A}/result.png"),
                &format!("{TASK_A}/task.json"),
                &format!("{TASK_B}/layers/01.png"),
                &format!("{TASK_B}/result.png"),
                &format!("{TASK_B}/task.json"),
                REF,
            ]
        );
        for (name, method) in &entries {
            let expected = if name.ends_with(".json") { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
            assert_eq!(*method, expected, "{name}");
        }
        assert!(!names_in(target.parent().unwrap()).iter().any(|n| n.ends_with(".tmp")));
    }

    #[test]
    fn export_rejects_unsafe_or_duplicate_entries() {
        let f = fixture();
        let target = f.tmp.path().join("bad.ugcpack");
        let mut traversal = spec(&f);
        traversal.task_dirs = vec!["../outside".into()];
        assert!(export(&f.root, &traversal, &target, &no_progress, &AtomicBool::new(false)).is_err());
        let mut duplicate = spec(&f);
        duplicate.files.push(PackFile { source: REF_SOURCE.into(), entry: "manifest.json".into() });
        let err = export(&f.root, &duplicate, &target, &no_progress, &AtomicBool::new(false)).unwrap_err();
        assert!(err.to_string().contains("重复"), "{err}");
        assert!(!target.exists());
    }

    #[test]
    fn cancelled_export_leaves_no_file() {
        let f = fixture();
        let target = f.tmp.path().join("c.ugcpack");
        let err = export(&f.root, &spec(&f), &target, &no_progress, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(names_in(f.tmp.path()).iter().all(|n| !n.contains("c.ugcpack")));
    }

    #[test]
    fn sha256_of_any_file() {
        let f = fixture();
        assert_eq!(sha256_file(&f.external).unwrap(), format!("{:x}", Sha256::digest(b"cat")));
        assert!(sha256_file(&f.tmp.path().join("没有")).is_err());
    }

    fn exported(f: &Fixture) -> PathBuf {
        let target = f.tmp.path().join("p.ugcpack");
        export(&f.root, &spec(f), &target, &no_progress, &AtomicBool::new(false)).unwrap();
        target
    }

    #[test]
    fn lists_entries_and_reads_requested_texts() {
        let f = fixture();
        let pack = exported(&f);
        assert_eq!(entries(&pack).unwrap().len(), 8);
        let texts = read_texts(&pack, &["manifest.json".into(), "画板/没有.ugcboard.json".into()]).unwrap();
        assert_eq!(texts.into_iter().collect::<Vec<_>>(), vec![("manifest.json".to_string(), "{\"pack_format_version\":1}".to_string())]);
        fs::write(f.tmp.path().join("junk.ugcpack"), b"not a zip").unwrap();
        assert!(entries(&f.tmp.path().join("junk.ugcpack")).is_err());
    }

    #[test]
    fn import_moves_units_only_then_is_idempotent() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let report = import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&report), vec![(TASK_A, MergeOutcome::Moved), (TASK_B, MergeOutcome::Moved), (REF, MergeOutcome::Moved)]);
        assert_eq!(fs::read(other.join(TASK_B).join("layers/01.png")).unwrap(), b"layer");
        assert_eq!(fs::read(other.join(REF)).unwrap(), b"cat");
        // 清单与画板不属于合并单元，不解压（画板由前端按改名规则写）；临时目录已清理。
        assert_eq!(names_in(&other), vec!["2026-09-16", "导入参考图"]);

        let again = import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&again), vec![(TASK_A, MergeOutcome::Identical), (TASK_B, MergeOutcome::Identical), (REF, MergeOutcome::Identical)]);
        assert_eq!(names_in(&other), vec!["2026-09-16", "导入参考图"]);
    }

    #[test]
    fn differing_identity_is_a_conflict_and_not_overwritten() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        write(&other.join(TASK_A).join("task.json"), b"{\"local\":true}");
        write(&other.join(REF), b"dog");
        let report = import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&report), vec![(TASK_A, MergeOutcome::Conflict), (TASK_B, MergeOutcome::Moved), (REF, MergeOutcome::Conflict)]);
        assert_eq!(fs::read(other.join(TASK_A).join("task.json")).unwrap(), b"{\"local\":true}");
        assert!(!other.join(TASK_A).join("result.png").exists());
        assert_eq!(fs::read(other.join(REF)).unwrap(), b"dog");
    }

    #[test]
    fn cancelled_import_cleans_temp_dir_and_writes_nothing() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let err = import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), CANCELLED);
        assert!(names_in(&other).is_empty(), "{:?}", names_in(&other));
    }

    #[test]
    fn cancel_after_extraction_moves_nothing_and_cleans_temp() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let cancel = AtomicBool::new(false);
        // 解压完最后一个字节时取消：解压阶段已结束，移入阶段第一次检查即中止。
        let progress = |done: u64, all: u64| {
            if done == all {
                cancel.store(true, Ordering::Relaxed);
            }
        };
        assert!(import(&pack, &other, &units(), &[], &progress, &cancel).is_err());
        assert!(names_in(&other).is_empty(), "{:?}", names_in(&other));
    }

    #[test]
    fn import_sweeps_temp_dirs_left_by_a_killed_process() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        let stale = other.join(".ugcpack-import.123-456-0.tmp");
        write(&stale.join("导入参考图/abc.png"), b"cat");
        // 进程被杀留下的目录：mtime 早于过期门槛才会被清理。
        let old = filetime::FileTime::from_system_time(std::time::SystemTime::now() - STALE_IMPORT_AGE * 2);
        filetime::set_file_times(&stale, old, old).unwrap();
        write(&other.join(".别的.tmp/x"), b"x");
        import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(names_in(&other), vec![".别的.tmp", "2026-09-16", "导入参考图"]);
    }

    #[test]
    fn concurrent_import_does_not_delete_a_fresh_temp_dir() {
        let f = fixture();
        let pack = exported(&f);
        let other = f.tmp.path().join("输出 B");
        // 另一页面正在导入：临时目录是新鲜的，不能被这次导入清掉。
        let active = other.join(".ugcpack-import.999-111-0.tmp");
        write(&active.join("导入参考图/abc.png"), b"cat");
        import(&pack, &other, &units(), &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert!(active.join("导入参考图/abc.png").is_file(), "并发导入的临时目录被误删");
    }

    #[test]
    fn export_rejects_absolute_source_outside_root() {
        let f = fixture();
        let target = f.tmp.path().join("x.ugcpack");
        let mut s = spec(&f);
        s.files = vec![PackFile { source: "/etc/hostname".into(), entry: "导入参考图/x.png".into() }];
        let err = export(&f.root, &s, &target, &no_progress, &AtomicBool::new(false)).unwrap_err();
        assert!(err.to_string().contains("越界"), "{err}");
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_symlink_escaping_root() {
        let f = fixture();
        let target = f.tmp.path().join("x.ugcpack");
        std::os::unix::fs::symlink(f.tmp.path(), f.root.join("link")).unwrap();
        let mut s = spec(&f);
        s.files = vec![PackFile { source: "link/root/别处/猫.png".into(), entry: "导入参考图/x.png".into() }];
        // link 指向用户数据根之外（root 的父目录的父目录），解析后越界。
        assert!(export(&f.root, &s, &target, &no_progress, &AtomicBool::new(false)).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn export_to_writer_streams_same_zip_as_file_export() {
        let f = fixture();
        let mut buf = Vec::new();
        let report = export_to_writer(&f.root, &spec(&f), &mut buf, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(report.task_dirs, 2);
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), &buf).unwrap();
        let names: Vec<String> = entries(file.path()).unwrap();
        assert!(names.contains(&"manifest.json".to_string()));
        assert!(names.contains(&REF.to_string()));
        assert_eq!(names.len(), 8);
    }

    /// 用 tag v0.3.2 的代码生成的桌面版画板包（Flash 图层结果 + layers.json + 根外参考图）。
    fn v032_pack() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../client/fixtures/packs/v0.3.2-flash-layers.ugcpack")
    }

    #[test]
    fn imports_pack_generated_by_desktop_v0_3_2() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出");
        let units = vec![
            MergeUnit { path: "2026-09-16/20260916T010000Z-0000000a".into(), identity: Some("task.json".into()) },
            MergeUnit { path: "导入参考图/5e4b079355f5f06363744c0778c5174040645713e06e6877eae22f573d46e6b0.png".into(), identity: None },
        ];
        let report = import(&v032_pack(), &root, &units, &[], &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(outcomes(&report), vec![(units[0].path.as_str(), MergeOutcome::Moved), (units[1].path.as_str(), MergeOutcome::Moved)]);
        let dir = root.join("2026-09-16/20260916T010000Z-0000000a");
        // 图层文件与 layers.json 都在；导入后按任务目录真源继续迭代。
        let layers: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("layers.json")).unwrap()).unwrap();
        assert_eq!(layers["layers"].as_array().unwrap().len(), 2);
        for file in ["layers/01.png", "layers/02.png", "result.png"] {
            assert!(dir.join(file).is_file(), "缺 {file}");
        }
        let record: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("task.json")).unwrap()).unwrap();
        assert_eq!(record["task_id"], "20260916T010000Z-0000000a");
        let board = read_texts(&v032_pack(), &["画板/旧版画板.ugcboard.json".into()]).unwrap();
        assert!(board["画板/旧版画板.ugcboard.json"].contains("旧版画板"));
    }

    #[test]
    fn import_rejects_unsafe_or_missing_units_without_writing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("输出");
        let traversal = tmp.path().join("t.ugcpack");
        make_zip(&traversal, &["manifest.json", &format!("{TASK_A}/../../evil.png"), &format!("{TASK_A}/task.json")]);
        let task = || vec![MergeUnit { path: TASK_A.into(), identity: Some("task.json".into()) }];
        assert!(import(&traversal, &root, &task(), &[], &no_progress, &AtomicBool::new(false)).is_err());
        let unsafe_unit = vec![MergeUnit { path: "../x".into(), identity: None }];
        assert!(import(&traversal, &root, &unsafe_unit, &[], &no_progress, &AtomicBool::new(false)).is_err());
        let no_record = tmp.path().join("n.ugcpack");
        make_zip(&no_record, &["manifest.json", &format!("{TASK_A}/result.png")]);
        let err = import(&no_record, &root, &task(), &[], &no_progress, &AtomicBool::new(false)).unwrap_err();
        assert!(err.to_string().contains("缺少"), "{err}");
        assert!(names_in(&root).is_empty(), "{:?}", names_in(&root));
    }

    /// v2 包：TASK_B 的 task.json 与结果图、导入参考图 REF 都被省略，只存 TASK_A 里的代表条目。
    fn v2_fixture() -> (tempfile::TempDir, PathBuf, Vec<MergeUnit>, Vec<PackDuplicate>) {
        let tmp = tempfile::tempdir().unwrap();
        let pack = tmp.path().join("v2.ugcpack");
        let mut zip = zip::ZipWriter::new(File::create(&pack).unwrap());
        for (name, bytes) in [("manifest.json".to_string(), &b"{}"[..]), (format!("{TASK_A}/task.json"), b"{\"same\":1}"), (format!("{TASK_A}/result.png"), b"png")] {
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        let dup = |path: String, source: String| PackDuplicate { path, source };
        let duplicates = vec![
            dup(format!("{TASK_B}/task.json"), format!("{TASK_A}/task.json")),
            dup(format!("{TASK_B}/result.png"), format!("{TASK_A}/result.png")),
            dup(REF.into(), format!("{TASK_A}/result.png")),
        ];
        (tmp, pack, units(), duplicates)
    }

    #[cfg(unix)]
    fn inode(path: &Path) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        let m = fs::metadata(path).unwrap();
        (m.dev(), m.ino())
    }

    #[test]
    fn v2_omitted_paths_are_hard_linked_and_count_toward_layout() {
        let (tmp, pack, units, duplicates) = v2_fixture();
        let root = tmp.path().join("输出");
        let report = import(&pack, &root, &units, &duplicates, &no_progress, &AtomicBool::new(false)).unwrap();
        // 被省略的 task.json 还原后，TASK_B 仍按身份文件比对、照常移入。
        assert_eq!(outcomes(&report), vec![(TASK_A, MergeOutcome::Moved), (TASK_B, MergeOutcome::Moved), (REF, MergeOutcome::Moved)]);
        assert_eq!(fs::read(root.join(TASK_B).join("task.json")).unwrap(), b"{\"same\":1}");
        for omitted in [root.join(TASK_B).join("result.png"), root.join(REF)] {
            assert_eq!(fs::read(&omitted).unwrap(), b"png");
            #[cfg(unix)]
            assert_eq!(inode(&omitted), inode(&root.join(TASK_A).join("result.png")), "应是硬链接：{}", omitted.display());
        }
        // 再导一次：还原后的单元与本机一致，全部跳过。
        let again = import(&pack, &root, &units, &duplicates, &no_progress, &AtomicBool::new(false)).unwrap();
        assert!(again.outcomes.iter().all(|o| o.outcome == MergeOutcome::Identical), "{:?}", again.outcomes);
    }

    /// 去重上传的暂存：两个任务目录的 task.json 与结果图内容各相同，暂存里每份内容只有一个文件。
    fn staged_fixture() -> (tempfile::TempDir, PathBuf, Vec<MergeUnit>, Vec<PlacedFile>) {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging");
        let sha = |b: &[u8]| format!("{:x}", Sha256::digest(b));
        for bytes in [&b"png"[..], b"{\"same\":1}"] {
            write(&staged_content(&staging, &sha(bytes)), bytes);
        }
        let placed = |path: String, bytes: &[u8]| PlacedFile { path, sha256: sha(bytes) };
        let files = vec![
            placed(format!("{TASK_A}/task.json"), b"{\"same\":1}"),
            placed(format!("{TASK_A}/result.png"), b"png"),
            placed(format!("{TASK_B}/task.json"), b"{\"same\":1}"),
            placed(format!("{TASK_B}/result.png"), b"png"),
        ];
        let dir = |p: &str| MergeUnit { path: p.into(), identity: Some("task.json".into()) };
        (tmp, staging, vec![dir(TASK_A), dir(TASK_B)], files)
    }

    #[test]
    fn staged_same_content_is_hard_linked_or_copied_when_linking_fails() {
        let (tmp, staging, units, files) = staged_fixture();
        let root = tmp.path().join("输出");
        let report = import_staged(&staging, &root, &units, &files, &no_progress, &AtomicBool::new(false)).unwrap();
        assert!(report.outcomes.iter().all(|o| o.outcome == MergeOutcome::Moved));
        assert_eq!(report.bytes, 3 + 10, "每份内容只计一次");
        #[cfg(unix)]
        assert_eq!(inode(&root.join(TASK_A).join("result.png")), inode(&root.join(TASK_B).join("result.png")));

        let (tmp, staging, units, files) = staged_fixture();
        let root = tmp.path().join("输出");
        let links = std::cell::Cell::new(0);
        let failing = |_: &Path, _: &Path| -> io::Result<()> {
            links.set(links.get() + 1);
            Err(io::Error::other("不支持硬链接"))
        };
        let report = import_staged_with(&staging, &root, &units, &files, &failing, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(links.get(), 2, "每份内容的第二份先尝试链接");
        assert!(report.outcomes.iter().all(|o| o.outcome == MergeOutcome::Moved));
        for file in ["task.json", "result.png"] {
            assert_eq!(fs::read(root.join(TASK_B).join(file)).unwrap(), fs::read(root.join(TASK_A).join(file)).unwrap());
            #[cfg(unix)]
            assert_ne!(inode(&root.join(TASK_A).join(file)), inode(&root.join(TASK_B).join(file)), "回退后应是独立副本");
        }
    }

    #[test]
    fn v2_link_failure_falls_back_to_copy() {
        let (tmp, pack, units, duplicates) = v2_fixture();
        let root = tmp.path().join("输出");
        let links = std::cell::Cell::new(0);
        let failing = |_: &Path, _: &Path| -> io::Result<()> {
            links.set(links.get() + 1);
            Err(io::Error::other("不支持硬链接"))
        };
        let report = import_with(&pack, &root, &units, &duplicates, &failing, &no_progress, &AtomicBool::new(false)).unwrap();
        assert_eq!(links.get(), 3, "每个省略路径都先尝试链接");
        assert!(report.outcomes.iter().all(|o| o.outcome == MergeOutcome::Moved));
        for omitted in [root.join(TASK_B).join("result.png"), root.join(REF)] {
            assert_eq!(fs::read(&omitted).unwrap(), b"png");
            #[cfg(unix)]
            assert_ne!(inode(&omitted), inode(&root.join(TASK_A).join("result.png")), "回退后应是独立副本");
        }
    }
}
