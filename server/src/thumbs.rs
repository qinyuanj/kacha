//! 节点缩略图（#49）：首次请求时按需生成，缓存在 `.kacha/thumbs/<日期>/<task_id>/<文件>`。
//!
//! 缓存不进任务目录、也不进画板包，随时可以删掉重建；文件名沿用原图，内容可能是 JPEG 或 PNG，类型看字节。
//! 只有任务目录形状的路径才生成（判定见 `cache`）：这些文件不可变，缓存永远不会过期。
//! 其余情况一律回退原图：节点宁可显示大图，也不能因为缩略图而空白。

use std::fmt::Display;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, ImageResult};

use crate::fs::{off_thread, resolve, serve_file, PathQuery};
use crate::{cache, logger, store, AppState, User, META_DIR};

/// 元数据目录下的缩略图缓存目录；内部按原图相对路径分层。
pub const THUMBS_DIR: &str = "thumbs";
/// 不小于节点默认显示宽度（`IMAGE_NODE_WIDTH` = 240）的 2 倍。
const LONG_EDGE: u32 = 512;
const JPEG_QUALITY: u8 = 80;

pub async fn read_thumb(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    let src = match resolve(&state, &user, &q.path) {
        Err(r) => return r,
        Ok(p) => p,
    };
    // 先看原图：缺图必须 404，哪怕还留着缓存，前端的「图片缺失」占位靠它。
    let is_file = tokio::fs::metadata(&src).await.is_ok_and(|m| m.is_file());
    if !is_file || !cache::is_immutable_task_file(&q.path) {
        return serve_file(&src, &q.path).await;
    }
    let cache_file = match resolve(&state, &user, &format!("{META_DIR}/{THUMBS_DIR}/{}", q.path)) {
        Err(r) => return r,
        Ok(p) => p,
    };
    if let Ok(bytes) = tokio::fs::read(&cache_file).await {
        return thumb_response(bytes, &q.path);
    }

    let job = Job { src: src.clone(), cache_file, log_dir: state.user_root(&user.fingerprint).join(META_DIR), rel: q.path.clone() };
    let (needed, job) = match off_thread(move || (job.needs_resize(), job)).await {
        Err(r) => return r,
        Ok(checked) => checked,
    };
    if !needed {
        return serve_file(&src, &q.path).await;
    }

    // 只有真正解码才占大请求名额；同一张图并发到达时，后到者在 generate 里读到先到者的缓存。
    let _permit = state.heavy().acquire().await;
    let may_store = state.disk_guard().enough();
    match off_thread(move || job.generate(may_store)).await {
        Err(r) => r,
        Ok(Some(bytes)) => thumb_response(bytes, &q.path),
        Ok(None) => serve_file(&src, &q.path).await,
    }
}

fn thumb_response(bytes: Vec<u8>, rel: &str) -> Response {
    let content_type = if bytes.starts_with(&[0xFF, 0xD8]) { "image/jpeg" } else { "image/png" };
    ([(header::CONTENT_TYPE, content_type), (header::CACHE_CONTROL, cache::cache_control(rel))], bytes).into_response()
}

struct Job {
    src: PathBuf,
    cache_file: PathBuf,
    log_dir: PathBuf,
    rel: String,
}

impl Job {
    /// 只读文件头。原图够小或读不出来时都不生成，直接回原图。
    fn needs_resize(&self) -> bool {
        match dimensions(&self.src) {
            Ok((width, height)) => width.max(height) > LONG_EDGE,
            Err(e) => {
                self.log_failure(e);
                false
            }
        }
    }

    /// 生成缩略图并写缓存；生成失败时返回 None，不写缓存。写缓存失败不影响本次回复。
    fn generate(&self, may_store: bool) -> Option<Vec<u8>> {
        if let Ok(bytes) = std::fs::read(&self.cache_file) {
            return Some(bytes);
        }
        let bytes = match render(&self.src) {
            Ok(bytes) => bytes,
            Err(e) => {
                self.log_failure(e);
                return None;
            }
        };
        if may_store {
            if let Err(e) = store::atomic_write(&self.cache_file, &bytes) {
                self.log_failure(e);
            }
        }
        Some(bytes)
    }

    fn log_failure(&self, e: impl Display) {
        let fields = serde_json::json!({ "path": self.rel, "error": e.to_string() });
        let _ = logger::Logger::new(self.log_dir.clone(), crate::VERSION).log("thumb_failed", fields.as_object().unwrap());
    }
}

fn dimensions(src: &Path) -> ImageResult<(u32, u32)> {
    ImageReader::open(src)?.with_guessed_format()?.into_dimensions()
}

fn render(src: &Path) -> ImageResult<Vec<u8>> {
    let mut decoder = ImageReader::open(src)?.with_guessed_format()?.into_decoder()?;
    // 输出不带 EXIF，转正要落在像素上，否则节点里的图是横的。
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    encode(&shrink(&image))
}

/// 缩小到长边 LONG_EDGE。带 alpha 的图要预乘后再缩：`image` 按通道独立求平均，
/// 透明区的 RGB（常是黑色）会渗进半透明边缘，抠图缩小后带一圈黑边。
fn shrink(image: &DynamicImage) -> DynamicImage {
    if !image.color().has_alpha() {
        return image.thumbnail(LONG_EDGE, LONG_EDGE);
    }
    let mut premultiplied = image.to_rgba8();
    for pixel in premultiplied.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = (u32::from(*channel) * alpha / 255) as u8;
        }
    }
    let mut small = DynamicImage::ImageRgba8(premultiplied).thumbnail(LONG_EDGE, LONG_EDGE).into_rgba8();
    for pixel in small.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        if alpha > 0 {
            for channel in &mut pixel.0[..3] {
                *channel = (u32::from(*channel) * 255 / alpha).min(255) as u8;
            }
        }
    }
    DynamicImage::ImageRgba8(small)
}

/// 真有透明像素才输出 PNG：生成结果常是不透明的 RGBA，按色彩类型判定会让它们都变成大 PNG。
fn encode(image: &DynamicImage) -> ImageResult<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    if image.color().has_alpha() && image.to_rgba8().pixels().any(|p| p[3] < u8::MAX) {
        image.to_rgba8().write_to(&mut out, ImageFormat::Png)?;
    } else {
        JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY).encode_image(&image.to_rgb8())?;
    }
    Ok(out.into_inner())
}
