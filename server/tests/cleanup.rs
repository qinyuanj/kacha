//! `kacha-server cleanup` 命令行入口：时间一律由 `--now` 注入，文件时间显式设定，不依赖真实时钟。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, UNIX_EPOCH};

const DAY: u64 = 86400;
/// 2027-01-15T08:00:00Z
const NOW: u64 = 1_800_000_000;

struct Root {
    dir: tempfile::TempDir,
}

impl Root {
    fn new() -> Self {
        Root { dir: tempfile::tempdir().unwrap() }
    }
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn user(&self, fp: &str) -> PathBuf {
        self.path().join("users").join(fp)
    }
    /// 用户元数据：最后访问时间。
    fn user_meta(&self, fp: &str, last_access: u64) {
        let meta = self.user(fp).join(".kacha");
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(meta.join("user.json"), format!("{{\"fingerprint\":\"{fp}\",\"last_access_at\":{last_access}}}")).unwrap();
        age(&self.user(fp).join(".kacha"), last_access);
    }
    /// 建一个任务目录（相对用户数据根），内容 bytes 字节，所有文件时间设为 at。
    fn task_dir(&self, fp: &str, rel: &str, bytes: usize, at: u64) -> PathBuf {
        let dir = self.user(fp).join(rel);
        std::fs::create_dir_all(dir.join("layers")).unwrap();
        std::fs::write(dir.join("task.json"), "{}").unwrap();
        std::fs::write(dir.join("layers/01.png"), vec![7u8; bytes - 2]).unwrap();
        age(&dir, at);
        dir
    }
    fn board(&self, fp: &str, name: &str, text: &str) {
        let dir = self.user(fp).join("画板");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), text).unwrap();
    }
    fn run(&self, extra: &[&str], now: u64) -> (i32, String, String) {
        let out = Command::new(env!("CARGO_BIN_EXE_kacha-server"))
            .arg("cleanup")
            .args(["--data-root", self.path().to_str().unwrap(), "--now", &now.to_string()])
            .args(extra)
            .output()
            .unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
    }
    /// 整棵树（相对路径 + 大小），用于断言磁盘没被改动。
    fn tree(&self) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        walk(self.path(), self.path(), &mut out);
        out.sort();
        out
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let e = e.unwrap();
        let rel = e.path().strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
        let meta = e.metadata().unwrap();
        if meta.is_dir() {
            out.push((format!("{rel}/"), 0));
            walk(base, &e.path(), out);
        } else {
            out.push((rel, meta.len()));
        }
    }
}

/// 把目录树里所有文件与目录的修改时间设为 at（目录最后设，免得被子项写入刷新）。
fn age(path: &Path, at: u64) {
    let t = UNIX_EPOCH + Duration::from_secs(at);
    if path.is_dir() {
        for e in std::fs::read_dir(path).unwrap() {
            age(&e.unwrap().path(), at);
        }
    }
    std::fs::File::open(path).unwrap().set_modified(t).unwrap();
}

fn board_with_result(task_dir: &str) -> String {
    let task_id = task_dir.split('/').nth(1).unwrap();
    format!(
        r#"{{"format_version":1,"title":"b","viewport":{{"zoom":1,"x":0,"y":0}},"edges":[],"nodes":[{{"id":"r","type":"result","pos":[0,0],"size":[1,1],"task_id":"{task_id}","file":"result.png","path":"{task_dir}/result.png","layer_count":0,"record":{{}}}}]}}"#
    )
}

fn board_with_failed_task(task_id: &str) -> String {
    format!(
        r#"{{"format_version":1,"title":"b","viewport":{{"zoom":1,"x":0,"y":0}},"edges":[],"nodes":[{{"id":"t","type":"task","pos":[0,0],"size":[1,1],"model":"m","size_spec":{{}},"image_ports":0,"layer_decomposition":false,"transparent_background":false,"last_submitted":{{"task_id":"{task_id}","images":[]}}}}]}}"#
    )
}

const OLD: &str = "2026-10-01/20261001T000000Z-0000000a";
const OLD_B: &str = "2026-10-02/20261002T000000Z-0000000b";
const OLD_C: &str = "2026-10-03/20261003T000000Z-0000000c";
const YOUNG: &str = "2027-01-01/20270101T000000Z-0000000d";

/// 一个活跃用户（各类任务目录）+ 一个闲置用户。
fn scenario() -> Root {
    let r = Root::new();
    r.user_meta("active", NOW - 3 * DAY);
    r.task_dir("active", OLD, 1000, NOW - 100 * DAY); // 未引用、建立超过 30 天 → 候选
    r.task_dir("active", OLD_B, 500, NOW - 100 * DAY); // 结果节点引用
    r.task_dir("active", OLD_C, 300, NOW - 100 * DAY); // 只在 .bak 里的失败任务引用
    r.task_dir("active", YOUNG, 200, NOW - 14 * DAY); // 未引用但未满 30 天
    r.board("active", "主.ugcboard.json", &board_with_result(OLD_B));
    r.board("active", "主.ugcboard.json.bak", &board_with_failed_task("20261003T000000Z-0000000c"));
    r.user_meta("idle", NOW - 61 * DAY);
    r.task_dir("idle", OLD, 4000, NOW - 90 * DAY);
    r.board("idle", "x.ugcboard.json", &board_with_result(OLD));
    r
}

#[test]
fn dry_run_lists_only_the_two_candidate_kinds_with_path_size_and_last_access_and_changes_nothing() {
    let r = scenario();
    let before = r.tree();
    let (code, out, err) = r.run(&["--dry-run"], NOW);
    assert_eq!(code, 0, "{err}");
    assert_eq!(r.tree(), before, "--dry-run 不能改动磁盘");
    let rows: Vec<Vec<&str>> = out.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).map(|l| l.split('\t').collect()).collect();
    // 闲置用户整个用户数据根：大小含元数据与画板，最后访问时间来自 user.json（NOW-61 天 = 2026-11-15T08:00:00Z）。
    let idle_bytes: u64 = before.iter().filter(|(p, _)| p.starts_with("users/idle/")).map(|(_, n)| n).sum();
    let idle_bytes = idle_bytes.to_string();
    let idle = vec!["闲置用户", "users/idle", idle_bytes.as_str(), "2026-11-15T08:00:00Z"];
    let unref = vec!["未引用任务目录", "users/active/2026-10-01/20261001T000000Z-0000000a", "1000", "2026-10-07T08:00:00Z"];
    assert_eq!(rows, vec![idle, unref], "输出：\n{out}");
}

#[test]
fn unreadable_board_blocks_task_dir_cleanup_for_that_user_but_not_idle_users() {
    let r = scenario();
    r.board("active", "坏.ugcboard.json", "{ not json");
    let (code, out, _) = r.run(&["--dry-run"], NOW);
    assert_eq!(code, 0);
    assert!(!out.contains("未引用任务目录"), "{out}");
    assert!(out.contains("闲置用户\tusers/idle\t"), "{out}");
    assert!(out.lines().any(|l| l.starts_with('#') && l.contains("users/active") && l.contains("坏.ugcboard.json")), "要说明跳过原因：\n{out}");
}

#[test]
fn execute_moves_candidates_to_recycle_and_purges_entries_older_than_14_days_on_a_later_run() {
    let r = scenario();
    let (code, _, err) = r.run(&[], NOW);
    assert_eq!(code, 0, "{err}");
    assert!(!r.user("idle").exists());
    assert!(!r.user("active").join(OLD).exists());
    for keep in [OLD_B, OLD_C, YOUNG] {
        assert!(r.user("active").join(keep).exists(), "{keep} 不该被清理");
    }
    let batch = r.path().join("recycle").join("20270115T080000Z");
    assert!(batch.join("users/idle/.kacha/user.json").exists());
    assert_eq!(std::fs::metadata(batch.join("users/active").join(OLD).join("layers/01.png")).unwrap().len(), 998);

    // 13 天后再跑：回收区条目还在保留期内。
    let (code, _, _) = r.run(&[], NOW + 13 * DAY);
    assert_eq!(code, 0);
    assert!(batch.exists());
    // 15 天后：dry-run 只列出将要彻底删除的条目，不删。
    let (_, out, _) = r.run(&["--dry-run"], NOW + 15 * DAY);
    assert!(out.contains("回收区过期\trecycle/20270115T080000Z\t"), "{out}");
    assert!(batch.exists());
    let (code, _, _) = r.run(&[], NOW + 15 * DAY);
    assert_eq!(code, 0);
    assert!(!batch.exists(), "超过 14 天的回收区条目应彻底删除");
}

#[test]
fn purge_skips_the_recycle_area() {
    let r = scenario();
    let (code, _, err) = r.run(&["--purge"], NOW);
    assert_eq!(code, 0, "{err}");
    assert!(!r.user("idle").exists());
    assert!(!r.user("active").join(OLD).exists());
    assert!(r.user("active").join(OLD_B).exists());
    assert!(!r.path().join("recycle").exists() || std::fs::read_dir(r.path().join("recycle")).unwrap().next().is_none());
}

#[test]
fn rejects_dry_run_with_purge_and_bad_now() {
    let r = scenario();
    let before = r.tree();
    assert_eq!(r.run(&["--dry-run", "--purge"], NOW).0, 2);
    let out = Command::new(env!("CARGO_BIN_EXE_kacha-server"))
        .args(["cleanup", "--data-root", r.path().to_str().unwrap(), "--now", "昨天"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(r.tree(), before);
}

#[test]
fn now_accepts_utc_timestamp() {
    let r = scenario();
    let out = Command::new(env!("CARGO_BIN_EXE_kacha-server"))
        .args(["cleanup", "--dry-run", "--data-root", r.path().to_str().unwrap(), "--now", "2027-01-15T08:00:00Z"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("闲置用户\tusers/idle\t"));
}
