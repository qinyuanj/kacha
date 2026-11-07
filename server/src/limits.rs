//! 资源限制（ADR 0018 / #24）：全局大请求并发上限、写入前的磁盘余量检查、每日一次的用户数据根大小日志。
//!
//! 大请求（文件写入、结果图下载、SHA、图片解析、缩略图生成、读画板包内容、画板包导入导出）都要先拿到 HeavyGate 的许可：
//! 全局最多 4 个并发，其余排队；阻塞的 zip / IO 在 spawn_blocking 里跑，不占异步线程。
//! 画板包上传不拿许可（#60）：快慢取决于客户端网速，改由空闲超时与按 Content-Length 的余量预检兜住。
//! 磁盘余量低于门槛时写入类接口返回 507；余量来源可注入（测试不必真的填满磁盘）。

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// 全局同时处理的大请求数。
pub const HEAVY_CONCURRENCY: usize = 4;
/// 剩余磁盘低于该值时拒绝写入。
pub const DEFAULT_MIN_FREE_BYTES: u64 = 20 * 1024 * 1024 * 1024;
/// 上传请求体两块数据之间允许的最长空闲：超过即 408 并删掉临时文件（#60）。
pub const UPLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// 磁盘余量来源：生产读文件系统，测试注入固定值。
pub type FreeSpace = Arc<dyn Fn() -> io::Result<u64> + Send + Sync>;

/// 读 path 所在文件系统的可用字节数。
pub fn filesystem_free_space(path: &Path) -> io::Result<u64> {
    platform_free_space(path)
}

#[cfg(unix)]
fn platform_free_space(path: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // 非 root 可用块 × 块大小。
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(windows)]
fn platform_free_space(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(free)
}

#[derive(Clone)]
pub struct HeavyGate {
    semaphore: Arc<Semaphore>,
}

impl Default for HeavyGate {
    fn default() -> Self {
        Self { semaphore: Arc::new(Semaphore::new(HEAVY_CONCURRENCY)) }
    }
}

impl HeavyGate {
    /// 排队取一个大请求许可；许可持有期间计入并发。许可跨 spawn_blocking 持有。
    pub async fn acquire(&self) -> OwnedSemaphorePermit {
        self.semaphore.clone().acquire_owned().await.expect("大请求信号量不关闭")
    }

    /// 当前正在执行的大请求数（测试与日志用）。
    pub fn active(&self) -> usize {
        HEAVY_CONCURRENCY - self.semaphore.available_permits()
    }
}

/// 磁盘余量守卫：写入类接口调用，余量不足返回 false。
pub struct DiskGuard {
    free_space: FreeSpace,
    min_free_bytes: u64,
    /// 余量读不到时的日志节流（不每次请求都打）。
    last_warn: std::sync::Mutex<Option<SystemTime>>,
}

impl DiskGuard {
    pub fn new(free_space: FreeSpace, min_free_bytes: u64) -> Self {
        Self { free_space, min_free_bytes, last_warn: std::sync::Mutex::new(None) }
    }

    /// 注入固定余量的守卫（测试用）。
    pub fn fixed(available: u64) -> Self {
        Self::new(Arc::new(move || Ok(available)), DEFAULT_MIN_FREE_BYTES)
    }

    pub fn enough(&self) -> bool {
        self.fits(None)
    }

    /// 写入 `incoming` 字节后余量仍不低于门槛；长度未知（None）时按现有门槛判定。
    pub fn fits(&self, incoming: Option<u64>) -> bool {
        match (self.free_space)() {
            Ok(free) => free >= self.min_free_bytes.saturating_add(incoming.unwrap_or(0)),
            Err(_) => {
                // 读不到余量时不拒绝服务（避免把监控故障当成磁盘满），但每小时提醒一次。
                let mut last = self.last_warn.lock().unwrap();
                let now = SystemTime::now();
                if last.map(|t| now.duration_since(t).map(|d| d >= Duration::from_secs(3600)).unwrap_or(true)).unwrap_or(true) {
                    eprintln!("[kacha] 无法读取磁盘余量，写入未做空间检查");
                    *last = Some(now);
                }
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disk_guard_rejects_below_threshold() {
        assert!(!DiskGuard::fixed(20 * 1024 * 1024 * 1024 - 1).enough());
        assert!(DiskGuard::fixed(20 * 1024 * 1024 * 1024).enough());
        // 已知要写多少：写完后仍不低于门槛才放行。
        assert!(DiskGuard::fixed(20 * 1024 * 1024 * 1024 + 10).fits(Some(10)));
        assert!(!DiskGuard::fixed(20 * 1024 * 1024 * 1024 + 10).fits(Some(11)));
        assert!(!DiskGuard::fixed(u64::MAX - 1).fits(Some(u64::MAX)), "长度相加不溢出");
        // 余量读不到不拒绝服务。
        assert!(DiskGuard::new(Arc::new(|| Err(io::Error::other("statvfs 失败"))), DEFAULT_MIN_FREE_BYTES).enough());
    }

    #[test]
    fn reads_real_filesystem_free_space() {
        let dir = tempfile::tempdir().unwrap();
        assert!(filesystem_free_space(dir.path()).unwrap() > 0);
    }
}
