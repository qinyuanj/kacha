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

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escaping_root() {
        let outside = root();
        let r = root();
        std::os::unix::fs::symlink(outside.path(), r.path().join("link")).unwrap();
        assert!(resolve(r.path(), "link/secret.txt").is_err());
        // 指向根内的符号链接合法。
        std::fs::create_dir(r.path().join("real")).unwrap();
        std::os::unix::fs::symlink(r.path().join("real"), r.path().join("inside")).unwrap();
        assert!(resolve(r.path(), "inside/file.txt").is_ok());
    }
}
