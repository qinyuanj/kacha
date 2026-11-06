//! 缩略图接口：`GET /api/fs/thumb`。断言 HTTP 回复与落盘结果。
mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::header;
use common::*;
use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};
use tokio::time::timeout;

const IMMUTABLE: &str = "private, max-age=31536000, immutable";
const TASK_FILE: &str = "2026-11-04/20261104T120000Z-abc/result.png";

async fn get_thumb(h: &Harness, cookie: &str, path: &str) -> Reply {
    h.get(&format!("/api/fs/thumb?path={}", q(path)), Some(cookie)).await
}

fn seed(root: &Path, rel: &str, bytes: &[u8]) {
    let target = root.join(rel);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, bytes).unwrap();
}

fn cached(root: &Path, rel: &str) -> PathBuf {
    root.join(".kacha/thumbs").join(rel)
}

fn encode(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image.write_to(&mut out, format).unwrap();
    out.into_inner()
}

fn opaque(width: u32, height: u32) -> DynamicImage {
    DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 128])))
}

/// 左侧不透明白、右侧全透明黑：透明区的 RGB 是黑色，缩小时不能渗进边缘。
/// 分界取 2/5，缩小后落在像素中间，才会出现半透明的边缘像素。
fn partly_transparent(width: u32, height: u32) -> DynamicImage {
    DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, _| if x < width * 2 / 5 { Rgba([255, 255, 255, 255]) } else { Rgba([0, 0, 0, 0]) }))
}

fn content_type(reply: &Reply) -> &str {
    reply.headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap()
}

fn cache_control(reply: &Reply) -> &str {
    reply.headers.get(header::CACHE_CONTROL).unwrap().to_str().unwrap()
}

fn decoded(reply: &Reply, format: ImageFormat) -> DynamicImage {
    image::load_from_memory_with_format(&reply.body, format).expect("回复应是该格式的图片")
}

#[tokio::test]
async fn opaque_large_image_gets_a_512_jpeg_and_is_cached() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    seed(&root, TASK_FILE, &encode(opaque(1000, 600), ImageFormat::Png));

    let reply = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(content_type(&reply), "image/jpeg");
    assert_eq!(cache_control(&reply), IMMUTABLE);
    assert_eq!(decoded(&reply, ImageFormat::Jpeg).dimensions(), (512, 307));
    assert_eq!(std::fs::read(cached(&root, TASK_FILE)).unwrap(), reply.body, "缓存落在 .kacha/thumbs/<日期>/<task_id>/<文件>");
}

#[tokio::test]
async fn portrait_image_scales_by_its_long_edge() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed(&h.user_root(GOOD_KEY), TASK_FILE, &encode(opaque(600, 1000), ImageFormat::Png));
    assert_eq!(decoded(&get_thumb(&h, &cookie, TASK_FILE).await, ImageFormat::Jpeg).dimensions(), (307, 512));
}

#[tokio::test]
async fn rgba_image_without_transparent_pixels_counts_as_opaque() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let image = DynamicImage::ImageRgba8(opaque(800, 800).to_rgba8());
    seed(&h.user_root(GOOD_KEY), TASK_FILE, &encode(image, ImageFormat::Png));
    assert_eq!(content_type(&get_thumb(&h, &cookie, TASK_FILE).await), "image/jpeg");
}

#[tokio::test]
async fn image_with_alpha_gets_a_png_that_keeps_transparency() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    seed(&h.user_root(GOOD_KEY), TASK_FILE, &encode(partly_transparent(1000, 1000), ImageFormat::Png));

    let reply = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_eq!(content_type(&reply), "image/png");
    assert_eq!(cache_control(&reply), IMMUTABLE);
    let image = decoded(&reply, ImageFormat::Png).to_rgba8();
    assert_eq!(image.dimensions(), (512, 512));
    assert_eq!(image.get_pixel(10, 10).0, [255, 255, 255, 255]);
    assert_eq!(image.get_pixel(500, 10).0[3], 0, "透明区仍透明");
    let edge: Vec<_> = (0..512).map(|x| image.get_pixel(x, 256).0).filter(|p| p[3] > 8 && p[3] < 255).collect();
    assert!(!edge.is_empty(), "夹具要产生半透明边缘");
    assert!(edge.iter().all(|p| p[0] > 240 && p[1] > 240 && p[2] > 240), "透明区的黑色渗进了边缘：{edge:?}");
}

#[tokio::test]
async fn jpeg_exif_rotation_is_baked_into_the_thumbnail() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let plain = encode(opaque(1000, 600), ImageFormat::Jpeg);
    // Orientation = 6（顺时针 90°）：输出的 JPEG 不带 EXIF，转正要在像素上完成，否则节点里图是横的。
    let tiff = [b"II*\0".as_slice(), &8u32.to_le_bytes(), &1u16.to_le_bytes(), &0x0112u16.to_le_bytes(), &3u16.to_le_bytes(), &1u32.to_le_bytes(), &6u16.to_le_bytes(), &[0, 0], &0u32.to_le_bytes()].concat();
    let payload = [b"Exif\0\0".as_slice(), &tiff].concat();
    let app1 = [[0xFF, 0xE1].as_slice(), &((payload.len() + 2) as u16).to_be_bytes(), &payload].concat();
    let rotated = [&plain[..2], &app1, &plain[2..]].concat();
    let rel = "2026-11-04/task-a/result.jpg";
    seed(&h.user_root(GOOD_KEY), rel, &rotated);
    assert_eq!(decoded(&get_thumb(&h, &cookie, rel).await, ImageFormat::Jpeg).dimensions(), (307, 512));
}

#[tokio::test]
async fn format_comes_from_the_bytes_not_the_extension() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let rel = "2026-11-04/task-a/refs/没有扩展名";
    seed(&h.user_root(GOOD_KEY), rel, &encode(opaque(900, 900), ImageFormat::Jpeg));
    assert_eq!(decoded(&get_thumb(&h, &cookie, rel).await, ImageFormat::Jpeg).dimensions(), (512, 512));
}

#[tokio::test]
async fn small_image_returns_the_original_without_caching() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    let bytes = encode(opaque(512, 300), ImageFormat::Png);
    seed(&root, TASK_FILE, &bytes);

    let reply = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, bytes);
    assert_eq!(content_type(&reply), "image/png");
    assert_eq!(cache_control(&reply), IMMUTABLE);
    assert!(!cached(&root, TASK_FILE).exists());
}

#[tokio::test]
async fn corrupt_image_returns_the_original_logs_and_writes_no_cache() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    // 文件头完好、像素数据被截断：读得出尺寸，解码才失败。
    let full = encode(opaque(1000, 1000), ImageFormat::Png);
    let truncated = full[..full.len() / 2].to_vec();
    let garbage = b"not an image at all".to_vec();
    for (rel, bytes) in [(TASK_FILE, truncated), ("2026-11-04/task-a/garbage.png", garbage)] {
        seed(&root, rel, &bytes);
        let reply = get_thumb(&h, &cookie, rel).await;
        assert_eq!(reply.status, 200, "{rel}");
        assert_eq!(reply.body, bytes, "{rel}");
        assert!(!cached(&root, rel).exists(), "{rel}");
    }
    let log = std::fs::read_to_string(root.join(".kacha/diagnostics.log")).unwrap();
    assert_eq!(log.lines().filter(|l| l.contains("thumb_failed")).count(), 2, "{log}");
    assert!(log.contains("garbage.png"), "{log}");
}

#[tokio::test]
async fn missing_original_is_404_even_when_a_cached_thumbnail_remains() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    assert_eq!(get_thumb(&h, &cookie, TASK_FILE).await.status, 404);
    assert_eq!(get_thumb(&h, &cookie, "2026-11-04/task-a").await.status, 404, "目录不是文件");

    seed(&root, TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    assert_eq!(get_thumb(&h, &cookie, TASK_FILE).await.status, 200);
    std::fs::remove_file(root.join(TASK_FILE)).unwrap();
    let gone = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_eq!(gone.status, 404, "缺图占位靠这个 404");
    assert!(gone.headers.get(header::CACHE_CONTROL).is_none(), "404 不能被长期缓存");
}

#[tokio::test]
async fn second_request_hits_the_cache() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    seed(&root, TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    let first = get_thumb(&h, &cookie, TASK_FILE).await;

    // 把缓存换成另一张可辨认的图：第二次回的是它，说明没有重新生成。
    let marker = encode(partly_transparent(16, 16), ImageFormat::Png);
    std::fs::write(cached(&root, TASK_FILE), &marker).unwrap();
    let second = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_ne!(first.body, second.body);
    assert_eq!(second.body, marker);
    assert_eq!(content_type(&second), "image/png", "文件名是 .png 也可能装 JPEG，类型看字节");
    assert_eq!(cache_control(&second), IMMUTABLE);
    assert_eq!(content_type(&first), "image/jpeg");
}

#[tokio::test]
async fn equivalent_spellings_of_a_path_share_one_cache_entry() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    seed(&root, TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    let reply = get_thumb(&h, &cookie, "2026-11-04/./20261104T120000Z-abc//result.png").await;
    assert_eq!(reply.status, 200);
    assert_eq!(content_type(&reply), "image/jpeg");
    assert!(cached(&root, TASK_FILE).exists());
}

#[tokio::test]
async fn paths_outside_task_directories_return_the_original_with_no_cache() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    let bytes = encode(opaque(1000, 1000), ImageFormat::Png);
    for rel in ["导入参考图/cat.png", "2026-11-04/task-a/.staging/result.png", "画板/贴图.png"] {
        seed(&root, rel, &bytes);
        let reply = get_thumb(&h, &cookie, rel).await;
        assert_eq!(reply.status, 200, "{rel}");
        assert_eq!(reply.body, bytes, "{rel}");
        assert_eq!(content_type(&reply), "image/png", "{rel}");
        assert_eq!(cache_control(&reply), "no-cache", "{rel}");
        assert!(!cached(&root, rel).exists(), "{rel}");
    }
}

#[tokio::test]
async fn low_disk_still_serves_the_thumbnail_but_writes_no_cache() {
    let h = Harness::with_free_space(Some(0));
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    seed(&root, TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    let reply = get_thumb(&h, &cookie, TASK_FILE).await;
    assert_eq!(reply.status, 200);
    assert_eq!(decoded(&reply, ImageFormat::Jpeg).dimensions(), (512, 512));
    assert!(!cached(&root, TASK_FILE).exists());
}

#[tokio::test]
async fn only_generation_takes_a_heavy_slot() {
    let h = Harness::new();
    let cookie = h.session(GOOD_KEY).await;
    let root = h.user_root(GOOD_KEY);
    let small = "2026-11-04/task-a/small.png";
    let hit = "2026-11-04/task-a/hit.png";
    seed(&root, TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    seed(&root, small, &encode(opaque(64, 64), ImageFormat::Png));
    seed(&root, hit, &encode(opaque(1000, 1000), ImageFormat::Png));
    assert_eq!(get_thumb(&h, &cookie, hit).await.status, 200);

    let mut held = Vec::new();
    for _ in 0..kacha_server::limits::HEAVY_CONCURRENCY {
        held.push(h.state.heavy().acquire().await);
    }
    let patience = Duration::from_millis(200);
    assert!(timeout(patience, get_thumb(&h, &cookie, TASK_FILE)).await.is_err(), "名额占满时生成要排队");
    assert_eq!(timeout(patience, get_thumb(&h, &cookie, hit)).await.expect("命中缓存不排队").status, 200);
    assert_eq!(timeout(patience, get_thumb(&h, &cookie, small)).await.expect("小图不排队").status, 200);
    drop(held);
    assert_eq!(content_type(&get_thumb(&h, &cookie, TASK_FILE).await), "image/jpeg");
}

#[tokio::test]
async fn thumbnails_follow_session_and_path_rules() {
    let h = Harness::new();
    let alice = h.session(GOOD_KEY).await;
    let bob = h.session(OTHER_KEY).await;
    seed(&h.user_root(GOOD_KEY), TASK_FILE, &encode(opaque(1000, 1000), ImageFormat::Png));
    assert_eq!(h.get(&format!("/api/fs/thumb?path={}", q(TASK_FILE)), None).await.status, 401);
    assert_eq!(get_thumb(&h, &bob, TASK_FILE).await.status, 404, "别的用户看不到");
    assert_eq!(get_thumb(&h, &alice, "../outside.png").await.status, 403);
    assert_eq!(get_thumb(&h, &alice, "2026-11-04/../../outside.png").await.status, 403);
}
