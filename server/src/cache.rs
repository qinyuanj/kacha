//! 读文件类接口的缓存头：任务目录文件只写一次、不可变（ADR 0010），可让浏览器长期缓存（#47）。
//!
//! 只按路径形状判定，不看扩展名、不加 ETag / Last-Modified。缩略图接口复用同一判定。

/// 任务目录文件的缓存头。
pub const IMMUTABLE: &str = "private, max-age=31536000, immutable";
/// 其余路径（`.staging/`、`导入参考图/`、画板等）每次都向服务端确认。
pub const NO_CACHE: &str = "no-cache";

use crate::references::is_date_dir;
use crate::relay::STAGING_DIR;

/// 相对用户数据根的路径是否是 `<UTC 日期>/<task_id>/<文件>` 形状、且不在 `.staging/` 下。
///
/// 与 `paths::resolve` 一样归一化：反斜杠当分隔符，空段与 `.` 段忽略。任何一段是 `.staging` 都不算。
pub fn is_immutable_task_file(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    parts.len() >= 3 && is_date_dir(parts[0]) && !parts.contains(&STAGING_DIR) && !parts.contains(&"..")
}

/// 按路径形状给出 `Cache-Control` 值。
pub fn cache_control(rel: &str) -> &'static str {
    if is_immutable_task_file(rel) {
        IMMUTABLE
    } else {
        NO_CACHE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_directory_files_are_immutable() {
        for ok in [
            "2026-11-04/20261104T120000Z-abc/result.png",
            "2026-11-04/20261104T120000Z-abc/task.json",
            "2026-11-04/20261104T120000Z-abc/layers/01.png",
            "2026-11-04/20261104T120000Z-abc/refs/没有扩展名",
            "2026-11-04/旧桌面任务/result.png",
            "2026-11-04\\task-a\\result.png",
            "2026-11-04/./task-a//result.png",
        ] {
            assert!(is_immutable_task_file(ok), "应为不可变：{ok}");
            assert_eq!(cache_control(ok), IMMUTABLE);
        }
    }

    #[test]
    fn wrong_date_shape_is_not_immutable() {
        for bad in [
            "2026-1-04/task-a/result.png",
            "20261104/task-a/result.png",
            "2026-11-04x/task-a/result.png",
            "x2026-11-04/task-a/result.png",
            "2026-11-04 /task-a/result.png",
            "２０２６-11-04/task-a/result.png",
        ] {
            assert!(!is_immutable_task_file(bad), "日期不对：{bad}");
        }
    }

    #[test]
    fn wrong_depth_is_not_immutable() {
        for bad in ["", "2026-11-04", "2026-11-04/", "2026-11-04/result.png", "2026-11-04/task-a", "2026-11-04/task-a/", "画板/2026-11-04/task-a/result.png"] {
            assert!(!is_immutable_task_file(bad), "层级不对：{bad}");
        }
    }

    #[test]
    fn staging_is_not_immutable() {
        for bad in [
            "2026-11-04/task-a/.staging/result.png",
            "2026-11-04/task-a/.staging/layers/01.png",
            "2026-11-04/task-a/./.staging/result.png",
            "2026-11-04/task-a/layers/.staging/01.png",
            ".staging/2026-11-04/task-a/result.png",
            "2026-11-04/.staging/task-a/result.png",
        ] {
            assert!(!is_immutable_task_file(bad), ".staging 下：{bad}");
            assert_eq!(cache_control(bad), NO_CACHE);
        }
        // 只是名字以 .staging 开头的普通文件不算暂存区。
        assert!(is_immutable_task_file("2026-11-04/task-a/.staging.png"));
    }

    #[test]
    fn other_paths_are_no_cache() {
        for other in ["导入参考图/abc.png", "画板/本地.ugcboard.json", ".kacha/settings.json", "result.png"] {
            assert_eq!(cache_control(other), NO_CACHE, "{other}");
        }
    }
}
