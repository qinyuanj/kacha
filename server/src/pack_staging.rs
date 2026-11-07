//! 去重上传（#62）的暂存布局：每次导入一个目录 `<用户元数据目录>/pack-content/<id>.staging.tmp/`，
//! 里面每份内容一个文件，以它的 sha256 命名；写入中的内容先落在同目录的 `<sha256>.<随机>.part`，核对后改名。
//! HTTP 层（packs）与合并（board_pack）都只经这里拼暂存路径。

use std::path::{Path, PathBuf};

use crate::META_DIR;

/// 暂存目录所在的元数据子目录。
pub const DIR: &str = "pack-content";
/// 暂存目录名后缀（过期回收按它识别）。
pub const SUFFIX: &str = ".staging.tmp";

/// 某个用户数据根下 id 对应的暂存目录。
pub fn dir(root: &Path, id: &str) -> PathBuf {
    root.join(META_DIR).join(DIR).join(format!("{id}{SUFFIX}"))
}

pub fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 暂存里一份内容的文件（文件名即它的 sha256）。
pub fn content(staging: &Path, sha256: &str) -> PathBuf {
    staging.join(sha256)
}

/// 写入中的一份内容：`nonce` 区分同一份内容的并发上传。
pub fn part(staging: &Path, sha256: &str, nonce: u64) -> PathBuf {
    staging.join(format!("{sha256}.{nonce:x}.part"))
}
