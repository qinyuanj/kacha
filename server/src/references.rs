//! 画板文件引用了哪些任务目录：清理未引用任务目录的依据（ADR 0018）。
//!
//! 规则定义在画板文件格式（JSON 原文）上，用例在 `contracts/fixtures/board-references/` 夹具里。

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

/// 画板文件格式版本上限（与前端 `BOARD_FORMAT_VERSION` 一致）。
/// 2 加入的阶段（顶层 stages，只列节点 id）与定稿（结果节点 final）都不带来新的引用，规则不变。
pub const BOARD_FORMAT_VERSION: u64 = 2;

fn date_dir() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap())
}

fn task_id_stamp() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([0-9]{4})([0-9]{2})([0-9]{2})T[0-9]{6}Z-").unwrap())
}

/// 是否是 UTC 日期目录名（任务目录的第一层）。
pub fn is_date_dir(name: &str) -> bool {
    date_dir().is_match(name)
}

/// 相对用户数据根的路径（正斜杠）落在 `<日期>/<task_id>/…` 里时返回任务目录。
pub fn task_dir_of_rel_path(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    (parts.len() >= 3 && is_date_dir(parts[0]) && !parts[1].is_empty()).then(|| format!("{}/{}", parts[0], parts[1]))
}

/// 由 task_id 开头的 UTC 时间戳还原任务目录；不是本工具生成的编号时为 None。
pub fn task_dir_of_task_id(task_id: &str) -> Option<String> {
    let c = task_id_stamp().captures(task_id)?;
    Some(format!("{}-{}-{}/{}", &c[1], &c[2], &c[3], task_id))
}

fn add_path(out: &mut BTreeSet<String>, v: Option<&Value>) {
    if let Some(dir) = v.and_then(Value::as_str).and_then(task_dir_of_rel_path) {
        out.insert(dir);
    }
}

fn add_task_id(out: &mut BTreeSet<String>, v: Option<&Value>) {
    if let Some(dir) = v.and_then(Value::as_str).and_then(task_dir_of_task_id) {
        out.insert(dir);
    }
}

/// 读不懂的节点：其中任何像任务目录路径或任务编号的字符串都算引用（保守）。
fn add_deep(out: &mut BTreeSet<String>, v: &Value) {
    match v {
        Value::String(_) => {
            add_path(out, Some(v));
            add_task_id(out, Some(v));
        }
        Value::Array(items) => items.iter().for_each(|x| add_deep(out, x)),
        Value::Object(map) => map.values().for_each(|x| add_deep(out, x)),
        _ => {}
    }
}

fn add_node(out: &mut BTreeSet<String>, node: &Value) {
    let Some(obj) = node.as_object() else {
        return add_deep(out, node);
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("prompt") => {}
        Some("reference") => add_path(out, obj.get("path")),
        Some("result") => {
            add_path(out, obj.get("path"));
            add_task_id(out, obj.get("task_id"));
        }
        Some("task") => {
            let Some(last) = obj.get("last_submitted").and_then(Value::as_object) else { return };
            add_task_id(out, last.get("task_id"));
            // 同一次提交按份数展开的各份（失败 / 已取消 / 已中断的份没有结果节点，只靠这里引用）。
            if let Some(ids) = last.get("copy_task_ids").and_then(Value::as_array) {
                ids.iter().for_each(|id| add_task_id(out, Some(id)));
            }
            if let Some(images) = last.get("images").and_then(Value::as_array) {
                for image in images.iter().filter_map(Value::as_object) {
                    add_task_id(out, image.get("task_id"));
                    add_path(out, image.get("path"));
                }
            }
        }
        _ => add_deep(out, node),
    }
}

/// 画板文件引用的任务目录（去重、字典序）；None = 读不懂（损坏 / 版本更高），不能当成没有引用。
pub fn board_task_dirs(text: &str) -> Option<Vec<String>> {
    let raw: Value = serde_json::from_str(text).ok()?;
    let obj = raw.as_object()?;
    let version = obj.get("format_version")?.as_f64()?;
    if version.fract() != 0.0 || version < 1.0 || version > BOARD_FORMAT_VERSION as f64 {
        return None;
    }
    let nodes = obj.get("nodes")?.as_array()?;
    let mut out = BTreeSet::new();
    nodes.iter().for_each(|n| add_node(&mut out, n));
    Some(out.into_iter().collect())
}
