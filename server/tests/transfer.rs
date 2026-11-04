//! 浏览器上传参考图与结果下载（#28）：上传落到导入参考图目录，下载带附件文件名，整板 zip 流式生成。
mod common;

use axum::body::Body;
use axum::http::Method;
use common::*;

/// 最小 PNG 头（嗅探只看签名）。
fn png_bytes(tag: u8) -> Vec<u8> {
    let mut v = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, tag]);
    v
}

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

async fn upload(h: &Harness, cookie: &str, bytes: Vec<u8>) -> Reply {
    h.send(Method::POST, "/api/upload/reference", Some(cookie), Body::from(bytes)).await
}

#[tokio::test]
async fn uploaded_reference_lands_in_imported_references_by_content_hash() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let bytes = png_bytes(1);
    let reply = upload(&h, &cookie, bytes.clone()).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    let expected = format!("导入参考图/{}.png", sha_hex(&bytes));
    assert_eq!(reply.json()["path"], expected.as_str());
    assert_eq!(std::fs::read(h.user_root(GOOD_KEY).join(&expected)).unwrap(), bytes);
    // 同内容再传一次：同一路径，按成功处理，不报 409。
    let again = upload(&h, &cookie, bytes.clone()).await;
    assert_eq!(again.status, 201, "{}", again.text());
    assert_eq!(again.json()["path"], expected.as_str());
    // 临时文件不留在目录里。
    let names: Vec<_> = std::fs::read_dir(h.user_root(GOOD_KEY).join("导入参考图")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(names, vec![format!("{}.png", sha_hex(&bytes))]);
}

#[tokio::test]
async fn upload_rejects_non_images_and_requires_session() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let reply = upload(&h, &cookie, b"hello, not an image".to_vec()).await;
    assert_eq!(reply.status, 422, "{}", reply.text());
    assert_eq!(reply.json()["code"], "not_image");
    assert!(!h.user_root(GOOD_KEY).join("导入参考图").exists() || std::fs::read_dir(h.user_root(GOOD_KEY).join("导入参考图")).unwrap().next().is_none(), "拒绝时不留文件");
    let anon = h.send(Method::POST, "/api/upload/reference", None, Body::from(png_bytes(2))).await;
    assert_eq!(anon.status, 401);
}

#[tokio::test]
async fn upload_accepts_bodies_larger_than_the_default_two_megabytes() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let mut bytes = png_bytes(3);
    bytes.resize(5 * 1024 * 1024, 7);
    let reply = upload(&h, &cookie, bytes.clone()).await;
    assert_eq!(reply.status, 201, "{}", reply.text());
    assert_eq!(reply.json()["path"], format!("导入参考图/{}.png", sha_hex(&bytes)).as_str());
}

fn put_file(h: &Harness, key: &str, rel: &str, bytes: &[u8]) {
    let target = h.user_root(key).join(rel);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, bytes).unwrap();
}

fn zip_entries(body: &[u8]) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(body.to_vec())).expect("不是合法 zip");
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).unwrap();
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).unwrap();
        out.push((f.name().to_string(), bytes));
    }
    out.sort();
    out
}

fn disposition(reply: &Reply) -> String {
    reply.headers.get("content-disposition").expect("没有 Content-Disposition").to_str().unwrap().to_string()
}

const DIR_A: &str = "2026-11-04/20261104T010000Z-0000000a";
const DIR_B: &str = "2026-11-04/20261104T020000Z-0000000b";

#[tokio::test]
async fn single_result_without_layers_downloads_as_attachment() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/result.png"), &png_bytes(1));
    let reply = h.get(&format!("/api/download/result?path={}", q(&format!("{DIR_A}/result.png"))), Some(&cookie)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.body, png_bytes(1));
    let cd = disposition(&reply);
    assert!(cd.starts_with("attachment"), "{cd}");
    assert!(cd.contains("result.png"), "{cd}");
    // 指定下载名（参考图用显示名）：中文按 RFC 5987 编码。
    let named = h.get(&format!("/api/download/result?path={}&name={}", q(&format!("{DIR_A}/result.png")), q("红猫.png")), Some(&cookie)).await;
    assert!(disposition(&named).contains("filename*=UTF-8''%E7%BA%A2%E7%8C%AB.png"), "{}", disposition(&named));
    let missing = h.get(&format!("/api/download/result?path={}", q(&format!("{DIR_B}/result.png"))), Some(&cookie)).await;
    assert_eq!(missing.status, 404);
    let escape = h.get("/api/download/result?path=..%2F..%2Fx.png", Some(&cookie)).await;
    assert_eq!(escape.status, 403);
}

#[tokio::test]
async fn single_result_with_layers_downloads_as_zip_with_layer_files() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/result.png"), &png_bytes(1));
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/layers/01.png"), &png_bytes(2));
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/layers/02.png"), &png_bytes(3));
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/layers.json"), br#"{"layers":[]}"#);
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/task.json"), b"{}");
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/.staging/0.png"), &png_bytes(9));
    let reply = h.get(&format!("/api/download/result?path={}", q(&format!("{DIR_A}/result.png"))), Some(&cookie)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.headers.get("content-type").unwrap(), "application/zip");
    assert!(disposition(&reply).contains("20261104T010000Z-0000000a.zip"), "{}", disposition(&reply));
    let entries = zip_entries(&reply.body);
    let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, vec!["layers.json", "layers/01.png", "layers/02.png", "result.png"], "只含底图、图层与 layers.json，不含任务记录与暂存区");
    assert_eq!(entries[1].1, png_bytes(2));
}

#[tokio::test]
async fn board_zip_contains_every_result_with_layers_and_skips_other_nodes() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    put_file(&h, GOOD_KEY, &format!("{DIR_A}/result.png"), &png_bytes(1));
    put_file(&h, GOOD_KEY, &format!("{DIR_B}/result.jpg"), &[0xff, 0xd8, 0xff, 0xe0]);
    put_file(&h, GOOD_KEY, &format!("{DIR_B}/layers/01.png"), &png_bytes(2));
    put_file(&h, GOOD_KEY, &format!("{DIR_B}/layers.json"), br#"{"layers":[]}"#);
    put_file(&h, GOOD_KEY, "导入参考图/abc.png", &png_bytes(5));
    let board = serde_json::json!({
        "format_version": 1, "title": "海报", "viewport": { "zoom": 1, "x": 0, "y": 0 }, "edges": [],
        "nodes": [
            { "id": "r1", "type": "result", "task_id": "20261104T010000Z-0000000a", "file": "result.png", "path": format!("{DIR_A}/result.png") },
            { "id": "r2", "type": "result", "task_id": "20261104T020000Z-0000000b", "file": "result.jpg", "path": format!("{DIR_B}/result.jpg") },
            { "id": "r3", "type": "result", "task_id": "20261104T010000Z-0000000a", "file": "result.png", "path": format!("{DIR_A}/result.png") },
            { "id": "r4", "type": "result", "task_id": "x", "file": "result.png", "path": "2026-11-04/gone/result.png" },
            { "id": "ref", "type": "reference", "path": "导入参考图/abc.png" },
            { "id": "p", "type": "prompt", "text": "猫" }
        ]
    });
    put_file(&h, GOOD_KEY, "画板/海报.ugcboard.json", board.to_string().as_bytes());
    let reply = h.get(&format!("/api/download/board-results?path={}", q("画板/海报.ugcboard.json")), Some(&cookie)).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.headers.get("content-type").unwrap(), "application/zip");
    assert!(reply.headers.get("content-length").is_none(), "流式生成，不预先算整包长度");
    assert!(disposition(&reply).contains("filename*=UTF-8''%E6%B5%B7%E6%8A%A5"), "{}", disposition(&reply));
    let entries = zip_entries(&reply.body);
    let names: Vec<String> = entries.iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(
        names,
        vec![
            format!("{DIR_A}/result.png"),
            format!("{DIR_B}/layers.json"),
            format!("{DIR_B}/layers/01.png"),
            format!("{DIR_B}/result.jpg"),
            "缺失文件.txt".to_string(),
        ],
        "每个结果一次（去重），带图层；参考图不算结果；缺失的列进说明"
    );
    assert!(String::from_utf8_lossy(&entries[4].1).contains("2026-11-04/gone/result.png"));
    let other = h.session(OTHER_KEY).await;
    assert_eq!(h.get(&format!("/api/download/board-results?path={}", q("画板/海报.ugcboard.json")), Some(&other)).await.status, 404, "按用户隔离");
}
