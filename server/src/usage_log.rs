//! 每日一次的各用户数据根大小日志（#24）：只记密钥指纹前缀与字节数，不含 API 密钥与提示词全文。
//! 写到数据根下的服务端日志目录（不属于任何用户的诊断日志）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::Clock;

/// 服务端日志目录：与用户目录并列，避免被用户清理 / 画板包导出当成内容。
const SERVER_LOG_DIR: &str = "server-log";

/// 目录大小（递归，跟随普通文件与目录；读不了的条目跳过）。
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        stack.push(entry.path());
                    } else {
                        total += meta.len();
                    }
                }
            }
        }
    }
    total
}

/// 每天记一次。`last_day` 记录上次落账的 UTC 日序号，进程内去重。
pub struct UsageLogger {
    data_root: PathBuf,
    clock: Clock,
    last_day: Mutex<Option<i64>>,
}

impl UsageLogger {
    pub fn new(data_root: PathBuf, clock: Clock) -> Self {
        Self { data_root, clock, last_day: Mutex::new(None) }
    }

    fn day(now: SystemTime) -> i64 {
        (now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() / 86_400) as i64
    }

    /// 到点（或首次调用）就记录一轮；同一天内的重复调用不写。
    pub fn maybe_log(&self) {
        let today = Self::day((self.clock)());
        {
            let mut last = self.last_day.lock().unwrap();
            if *last == Some(today) {
                return;
            }
            *last = Some(today);
        }
        let root = self.data_root.clone();
        let data_root = self.data_root.clone();
        // 遍历用户目录是阻塞 IO：不占异步线程。
        tokio::task::spawn_blocking(move || log_all(&data_root, &root));
    }
}

fn log_all(_data_root: &Path, root: &Path) {
    let users = root.join("users");
    let Ok(entries) = std::fs::read_dir(&users) else { return };
    let log_dir = root.join(SERVER_LOG_DIR);
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let fingerprint = entry.file_name().to_string_lossy().into_owned();
        let bytes = dir_size(&entry.path());
        // 指纹不是密钥（单向 SHA-256），只取前缀便于对账；绝不写密钥与提示词。
        let _ = crate::logger::Logger::new(log_dir.clone(), crate::VERSION).log(
            "usage",
            &serde_json::json!({ "user": &fingerprint[..fingerprint.len().min(12)], "bytes": bytes })
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
    }
}

/// 后台任务：每小时检查一次是否该记今日用量。
pub fn spawn_daily(logger: std::sync::Arc<UsageLogger>) {
    tokio::spawn(async move {
        loop {
            logger.maybe_log();
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn logs_each_user_size_once_per_day_without_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let users = tmp.path().join("users");
        std::fs::create_dir_all(users.join("abcdef1234567890").join("2026-11-05/t")).unwrap();
        std::fs::write(users.join("abcdef1234567890").join("2026-11-05/t/result.png"), vec![0u8; 100]).unwrap();
        std::fs::write(users.join("abcdef1234567890").join("2026-11-05/t/task.json"), "{\"prompt\":\"秘密提示词\"}".as_bytes()).unwrap();
        let now = Arc::new(Mutex::new(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000)));
        let clock_now = now.clone();
        let logger = UsageLogger::new(tmp.path().to_path_buf(), Arc::new(move || *clock_now.lock().unwrap()));
        logger.maybe_log();
        logger.maybe_log(); // 同一天第二次不写
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let log = std::fs::read_to_string(tmp.path().join(SERVER_LOG_DIR).join("diagnostics.log")).unwrap();
        assert_eq!(log.lines().count(), 1, "{log}");
        assert!(log.contains("\"event\":\"usage\"") && log.contains("abcdef123456"), "{log}");
        assert!(log.contains("\"bytes\":"), "{log}");
        assert!(!log.contains("秘密提示词"), "日志不含提示词全文：{log}");
        // 跨天后会再记一次。
        *now.lock().unwrap() += std::time::Duration::from_secs(86_400);
        logger.maybe_log();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(std::fs::read_to_string(tmp.path().join(SERVER_LOG_DIR).join("diagnostics.log")).unwrap().lines().count(), 2);
    }
}
