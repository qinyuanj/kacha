//! 服务端生命周期日志（#70）：`<数据根>/server.log`，记录启动、启动失败、关停信号、排空结果与退出。
//!
//! 与前端事件日志 `diagnostics.log`（logger 模块）分开：这里只写进程自身的状态，调用方负责不写密钥、
//! 提示词全文或签名结果地址。Windows 服务模式没有控制台，这份日志是唯一的现场记录。
//! 按大小轮转：当前段写满后改名为 `server.1.log`（覆盖更早的一段），总量不超过两段。写入失败静默降级。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::logger::utc_timestamp;

pub const SERVER_LOG_FILENAME: &str = "server.log";
pub const ROTATED_FILENAME: &str = "server.1.log";
/// 单段上限 1 MiB；连同轮转出的一段，总量不超过 2 MiB。
pub const DEFAULT_SEGMENT_BYTES: u64 = 1024 * 1024;

pub struct ServerLog {
    dir: PathBuf,
    segment_bytes: u64,
    lock: Mutex<()>,
}

impl ServerLog {
    pub fn new(data_root: PathBuf) -> Self {
        Self::with_segment_bytes(data_root, DEFAULT_SEGMENT_BYTES)
    }

    pub fn with_segment_bytes(data_root: PathBuf, segment_bytes: u64) -> Self {
        assert!(segment_bytes > 0, "日志段容量无效");
        Self { dir: data_root, segment_bytes, lock: Mutex::new(()) }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(SERVER_LOG_FILENAME)
    }

    /// 追加一行 `<UTC 时间> <内容>`；内容中的换行压成空格，保证一事一行。
    pub fn log(&self, message: &str) {
        let line = format!("{} {}\n", utc_timestamp(SystemTime::now()), message.replace(['\r', '\n'], " "));
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let current = self.path();
        let size = file_size(&current);
        if size > 0 && size + line.len() as u64 > self.segment_bytes {
            let _ = fs::rename(&current, self.dir.join(ROTATED_FILENAME));
        }
        let _ = OpenOptions::new().create(true).append(true).open(&current).and_then(|mut f| f.write_all(line.as_bytes()));
    }
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_timestamped_single_lines() {
        let dir = tempfile::tempdir().unwrap();
        let log = ServerLog::new(dir.path().to_path_buf());
        log.log("启动");
        log.log("两行\n合一");
        let text = fs::read_to_string(dir.path().join("server.log")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with("Z 启动"), "{}", lines[0]);
        assert!(lines[1].ends_with("Z 两行 合一"), "{}", lines[1]);
    }

    #[test]
    fn rotates_by_size_and_keeps_at_most_two_segments() {
        let dir = tempfile::tempdir().unwrap();
        let log = ServerLog::with_segment_bytes(dir.path().to_path_buf(), 300);
        for i in 0..100 {
            log.log(&format!("事件 {i}"));
        }
        let names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        for name in ["server.log", "server.1.log"] {
            assert!(file_size(&dir.path().join(name)) <= 300, "{name} 超过段上限");
        }
        assert!(fs::read_to_string(dir.path().join("server.log")).unwrap().contains("事件 99"));
    }
}
