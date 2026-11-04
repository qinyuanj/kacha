//! 资源限制（#24）：单文件请求体 64 MB、全局大请求并发 4、磁盘余量不足 507。进程内对 router 测试。
mod common;

use axum::body::Body;
use common::*;

const MB: usize = 1024 * 1024;

#[tokio::test]
async fn single_file_body_up_to_64_mb_is_accepted_and_larger_is_413() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    // 结果图、参考图快照常在几 MB 到几十 MB：不能被框架默认的 2 MB 挡掉。
    let ok = h.put(&format!("/api/fs/file?path={}", q("2026-11-05/t/result.png")), &cookie, Body::from(vec![7u8; 64 * MB])).await;
    assert_eq!(ok.status, 201, "{}", ok.text());
    let big = h.put(&format!("/api/fs/file?path={}", q("2026-11-05/t/big.png")), &cookie, Body::from(vec![7u8; 64 * MB + 1])).await;
    assert_eq!(big.status, 413);
    assert!(!h.user_root(GOOD_KEY).join("2026-11-05/t/big.png").exists());
}
