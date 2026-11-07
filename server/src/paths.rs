//! 路径越界拦截：所有接口的路径参数都是相对于用户数据根的相对路径。

use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    /// 越界：`..`、绝对路径、盘符 / UNC、符号链接指到用户数据根外 → 403。
    Forbidden(String),
}

impl PathError {
    pub fn message(&self) -> &str {
        match self {
            PathError::Forbidden(m) => m,
        }
    }
}

/// 规范化相对路径并逐段检查真实路径，最终拼出的路径必须仍在用户数据根内。
///
/// - 空路径指用户数据根本身；拒绝绝对路径（含 Windows 盘符 / UNC）、`..`、反斜杠、盘符冒号与控制字符。
/// - 已存在的前缀经 canonicalize 消除符号链接，再确认落在根内；写入最后一级允许尚不存在。
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    let forbidden = |why: &str| PathError::Forbidden(format!("路径越界，只允许用户数据根内的相对路径：{why}"));
    let trimmed = rel.replace('\\', "/");
    // 空路径指用户数据根本身（列目录用）；文件读写仍由调用方给出具体路径。
    if trimmed.is_empty() {
        return root.canonicalize().map_err(|_| forbidden("用户数据根不存在"));
    }
    let path = Path::new(&trimmed);
    if path.is_absolute() || trimmed.starts_with('/') {
        return Err(forbidden(rel));
    }
    let mut out = root.to_path_buf();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => {
                let text = seg.to_string_lossy();
                if text.contains(':') || text.chars().any(|c| c.is_control()) {
                    return Err(forbidden(rel));
                }
                out.push(seg);
            }
            // Windows 的盘符 / UNC 前缀在 Linux 上是普通段，另由上面的 ':' 检查拦下盘符；
            // UNC 的反斜杠已被归一化为 '/'，首段为空即绝对路径。
            _ => return Err(forbidden(rel)),
        }
    }
    let canon_root = root.canonicalize().map_err(|_| forbidden("用户数据根不存在"))?;
    check_within(&canon_root, &out)?;
    Ok(out)
}

/// canonicalize 已存在的最深前缀，确认仍在根内；不存在的末级由调用方创建。
fn check_within(root: &Path, target: &Path) -> Result<(), PathError> {
    let mut existing = target;
    while !existing.exists() {
        match existing.parent() {
            Some(p) => existing = p,
            None => break,
        }
    }
    let canon = existing.canonicalize().map_err(|e| PathError::Forbidden(e.to_string()))?;
    if canon.starts_with(root) {
        Ok(())
    } else {
        Err(PathError::Forbidden(format!("符号链接越界：{}", target.display())))
    }
}

/// 在 `link` 建指向目录 `target` 的符号链接，供本 crate 的逃逸防护测试用（集成测试另有一份，在 tests/common）。
/// Windows 没有开发者模式或管理员权限时建不了：打印原因并返回 false，调用方跳过；其它失败直接 panic。
#[cfg(test)]
pub(crate) fn symlink_dir_for_test(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(target, link);
    match made {
        Ok(()) => true,
        // ERROR_PRIVILEGE_NOT_HELD：当前账户无权创建符号链接。
        Err(e) if cfg!(windows) && e.raw_os_error() == Some(1314) => {
            eprintln!("跳过符号链接断言：无权创建符号链接（需开发者模式或管理员权限）：{e}");
            false
        }
        Err(e) => panic!("创建符号链接 {} 失败：{e}", link.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn empty_path_means_user_root() {
        let r = root();
        assert_eq!(resolve(r.path(), "").unwrap(), r.path().canonicalize().unwrap());
    }

    #[test]
    fn accepts_relative_paths_inside_root() {
        let r = root();
        assert_eq!(resolve(r.path(), "画板/本地.ugcboard.json").unwrap(), r.path().join("画板/本地.ugcboard.json"));
    }

    #[test]
    fn rejects_absolute_parent_and_windows_shapes() {
        let r = root();
        for bad in ["../outside.txt", "a/../../outside.txt", "/etc/passwd", "C:/Windows/win.ini", "C:win.ini", "//server/share/x", "..", "a\\..\\b", "a:b"] {
            assert!(resolve(r.path(), bad).is_err(), "应拒绝 {bad}");
        }
    }

    #[test]
    fn rejects_symlink_escaping_root() {
        let outside = root();
        let r = root();
        if !symlink_dir_for_test(outside.path(), &r.path().join("link")) {
            return;
        }
        assert!(resolve(r.path(), "link/secret.txt").is_err());
        // 指向根内的符号链接合法。
        std::fs::create_dir(r.path().join("real")).unwrap();
        assert!(symlink_dir_for_test(&r.path().join("real"), &r.path().join("inside")));
        assert!(resolve(r.path(), "inside/file.txt").is_ok());
    }
}
