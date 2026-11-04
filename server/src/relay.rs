//! 结果中转：对象存储不允许跨域，浏览器把结果地址交给服务端，由服务端只从允许列表内的主机下载，
//! 流式写进任务目录的 `.staging/` 暂存区（只新建不覆盖）。浏览器读回校验后才提交为成品，
//! 因此 `result.*` 永远只在全部校验通过后出现；取消 / 失败由 discard 清掉暂存区。
//!
//! 错误一律不回显原始地址（含临时签名），上游状态如实带回供前端按既有类别处理。

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::session::error;
use crate::{paths, AppState, User};

/// 单文件上限（ADR 0018 的 64 MB 请求预算同样适用于中转结果）。
const MAX_RESULT_BYTES: u64 = 64 * 1024 * 1024;
const STAGING_DIR: &str = ".staging";

/// 默认可下载的结果主机后缀：火山引擎对象存储（Seedream 结果所在）及其 CDN 域名。
pub fn default_result_hosts() -> &'static [&'static str] {
    &[".volces.com", ".volccdn.com", ".bytepluses.com"]
}

/// 主机匹配：条目 `.volces.com` 允许其子域与本体；`127.0.0.1` 这类无点前缀条目只精确匹配。
fn host_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allowed.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() {
            return false;
        }
        let bare = entry.trim_start_matches('.');
        host == bare || (entry.starts_with('.') && host.ends_with(&format!(".{bare}")))
    })
}

fn check_url(raw: &str, extra: &[String]) -> Result<reqwest::Url, Response> {
    let allowed: Vec<String> = default_result_hosts().iter().map(|s| s.to_string()).chain(extra.iter().cloned()).collect();
    let url = reqwest::Url::parse(raw).map_err(|_| error(StatusCode::BAD_REQUEST, "result_url_not_allowed", "结果地址不是合法的 URL"))?;
    let host = url.host_str().unwrap_or_default();
    if !matches!(url.scheme(), "http" | "https") || !host_allowed(host, &allowed) {
        return Err(error(StatusCode::BAD_REQUEST, "result_url_not_allowed", "结果地址不在允许下载的对象存储列表内"));
    }
    Ok(url)
}

/// 暂存文件的主干名：只允许简单标识，避免经由文件名越界。
fn valid_stem(stem: &str) -> bool {
    !stem.is_empty() && stem.len() <= 64 && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 成品主干：`result` 或 `layers/NN`（图层文件名由字节扩展名决定，与前端 layerFileName 一致）。
fn valid_product_stem(stem: &str) -> bool {
    stem == "result" || (stem.len() == 9 && stem.starts_with("layers/") && stem[7..].chars().all(|c| c.is_ascii_digit()))
}

fn staging_file_name(name: &str) -> bool {
    name.contains('.') && !name.contains(['/', '\\']) && !name.starts_with('.') && name.len() <= 80
}

fn resolve_dir(state: &AppState, user: &User, dir: &str) -> Result<PathBuf, Response> {
    paths::resolve(&state.user_root(&user.fingerprint), dir).map_err(|e| error(StatusCode::FORBIDDEN, "forbidden", e.message()))
}

/// 与前端 sniffImage 一致的扩展名嗅探：扩展名由字节决定，浏览器不传。
pub fn sniff_extension(head: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| head.len() >= sig.len() && &head[..sig.len()] == sig;
    let ascii = |text: &str, offset: usize| head.len() >= offset + text.len() && &head[offset..offset + text.len()] == text.as_bytes();
    if starts(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("png");
    }
    if starts(&[0xff, 0xd8, 0xff]) {
        return Some("jpg");
    }
    if ascii("RIFF", 0) && ascii("WEBP", 8) {
        return Some("webp");
    }
    if ascii("GIF87a", 0) || ascii("GIF89a", 0) {
        return Some("gif");
    }
    if ascii("ftyp", 4) {
        let brands = std::iter::once(8).chain((16..head.len().min(64)).step_by(4));
        for offset in brands {
            if ["heic", "heix", "hevc", "hevx"].iter().any(|b| ascii(b, offset)) {
                return Some("heic");
            }
            if ["mif1", "msf1"].iter().any(|b| ascii(b, offset)) {
                return Some("heif");
            }
        }
    }
    if ascii("BM", 0) {
        return Some("bmp");
    }
    if starts(&[0x49, 0x49, 0x2a, 0x00]) || starts(&[0x4d, 0x4d, 0x00, 0x2a]) {
        return Some("tiff");
    }
    None
}

/// 临时文件在作用域结束（含客户端断开导致的 Future 被 drop）时删除，不留半成品。
/// 暂存目录只在为空时一并删掉；成功落盘后目录里有内容，保留。
struct TempGuard(PathBuf, PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_dir(&self.1);
    }
}

#[derive(Deserialize)]
pub struct RelayRequest {
    url: String,
    /// 任务目录（相对用户数据根，`<日期>/<task_id>`）。
    dir: String,
    /// 暂存主干名（如 `0`、`1`），扩展名由服务端嗅探。
    stem: String,
}

#[derive(Deserialize)]
pub struct DirQuery {
    dir: String,
}

#[derive(Deserialize)]
pub struct CommitRequest {
    dir: String,
    /// 暂存区内的文件名（含嗅探出的扩展名）。
    from: String,
    /// 成品主干名：`result` 或 `layers/NN`。
    stem: String,
}

#[derive(serde::Serialize)]
struct Relayed {
    file: String,
    path: String,
}

fn io_response(e: std::io::Error) -> Response {
    match e.kind() {
        ErrorKind::AlreadyExists => error(StatusCode::CONFLICT, "already_exists", "目标已存在，只新建不覆盖"),
        ErrorKind::NotFound => error(StatusCode::NOT_FOUND, "not_found", "暂存文件不存在"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 下载并流式写入 `<任务目录>/.staging/<stem>.<ext>`；返回相对任务目录的文件名与相对用户数据根的路径。
pub async fn relay(State(state): State<AppState>, user: User, body: Bytes) -> Response {
    if !state.disk_guard().enough() {
        return error(StatusCode::INSUFFICIENT_STORAGE, "insufficient_storage", "服务器空间不足，请联系管理员");
    }
    let Ok(req) = serde_json::from_slice::<RelayRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要 url、dir 与 stem");
    };
    if !valid_stem(&req.stem) {
        return error(StatusCode::FORBIDDEN, "forbidden", "暂存主干名只允许字母、数字、- 与 _");
    }
    let url = match check_url(&req.url, state.result_hosts()) {
        Ok(u) => u,
        Err(r) => return r,
    };
    let dir = match resolve_dir(&state, &user, &req.dir) {
        Ok(d) => d,
        Err(r) => return r,
    };
    // 大请求：结果图下载计入全局并发，许可覆盖整个下载与落盘。
    let _permit = state.heavy().acquire().await;
    // 跟随重定向但每一步仍要过允许列表：重定向到列表外即停止，按「地址不被允许」处理。
    let extra: Vec<String> = state.result_hosts().to_vec();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(move |attempt| if check_url(attempt.url().as_str(), &extra).is_ok() { attempt.follow() } else { attempt.stop() }))
        .timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(c) => c,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    };
    let response = match client.get(url).header(reqwest::header::ACCEPT, "image/*").send().await {
        Ok(r) => r,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "download_failed", "下载结果图失败：网络不可达"),
    };
    if response.status().is_redirection() {
        return error(StatusCode::BAD_REQUEST, "result_url_not_allowed", "结果地址重定向到了允许列表之外的主机");
    }
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mapped = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
        return error(mapped, "download_failed", &format!("下载结果图失败：上游 HTTP {status}"));
    }
    if response.content_length().is_some_and(|len| len > MAX_RESULT_BYTES) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "download_failed", "结果图超过 64 MB 上限");
    }

    let staging = dir.join(STAGING_DIR);
    if let Err(e) = std::fs::create_dir_all(&staging) {
        return io_response(e);
    }
    let tmp = crate::store::temp_path_for(&staging.join("relay"));
    let guard = TempGuard(tmp.clone(), staging.clone());
    let mut file = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await {
        Ok(f) => f,
        Err(e) => return io_response(e),
    };
    let mut head: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "download_failed", "下载结果图失败：读取上游响应中断"),
        };
        total += chunk.len() as u64;
        if total > MAX_RESULT_BYTES {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "download_failed", "结果图超过 64 MB 上限");
        }
        if head.len() < 64 {
            head.extend_from_slice(&chunk[..chunk.len().min(64 - head.len())]);
        }
        if let Err(e) = file.write_all(&chunk).await {
            return io_response(e);
        }
    }
    let Some(ext) = sniff_extension(&head) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_image", "下载的内容不是可识别的图片");
    };
    if total == 0 {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_image", "下载结果图为空");
    }
    if let Err(e) = file.sync_all().await {
        return io_response(e);
    }
    drop(file);
    let file_name = format!("{}.{}", req.stem, ext);
    let target = staging.join(&file_name);
    if let Err(e) = std::fs::hard_link(&tmp, &target) {
        return io_response(e);
    }
    drop(guard);
    Json(Relayed { path: format!("{}/{STAGING_DIR}/{file_name}", req.dir), file: file_name }).into_response()
}

/// 提交暂存结果为成品：只新建不覆盖，扩展名沿用暂存文件。调用顺序由前端保证（result 最后）。
pub async fn commit(State(state): State<AppState>, user: User, body: Bytes) -> Response {
    let Ok(req) = serde_json::from_slice::<CommitRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要 dir、from 与 stem");
    };
    if !valid_product_stem(&req.stem) || !staging_file_name(&req.from) {
        return error(StatusCode::FORBIDDEN, "forbidden", "成品只能是 result 或 layers/NN，来源只能是暂存区文件");
    }
    let dir = match resolve_dir(&state, &user, &req.dir) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let ext = req.from.rsplit('.').next().unwrap_or_default();
    let staged = dir.join(STAGING_DIR).join(&req.from);
    let target = dir.join(format!("{}.{}", req.stem, ext));
    // 暂存区本身是服务端创建的；这里再确认目标与来源都在任务目录内（含符号链接检查）。
    if let Err(e) = paths::resolve(&state.user_root(&user.fingerprint), &format!("{}/{STAGING_DIR}/{}", req.dir, req.from)) {
        return error(StatusCode::FORBIDDEN, "forbidden", e.message());
    }
    match (|| -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::hard_link(&staged, &target)?;
        std::fs::remove_file(&staged)?;
        // 暂存区空了就连目录一起删掉：任务目录里只留下成品。
        let _ = std::fs::remove_dir(dir.join(STAGING_DIR));
        Ok(())
    })() {
        Ok(()) => {
            let file = format!("{}.{}", req.stem, ext);
            Json(Relayed { path: format!("{}/{}", req.dir, file), file }).into_response()
        }
        Err(e) => io_response(e),
    }
}

/// 取消或校验失败：清掉任务目录的暂存区，不留半成品。
pub async fn discard(State(state): State<AppState>, user: User, Query(q): Query<DirQuery>) -> Response {
    let dir = match resolve_dir(&state, &user, &q.dir) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let staging: &Path = &dir.join(STAGING_DIR);
    match std::fs::remove_dir_all(staging) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) if e.kind() == ErrorKind::NotFound => StatusCode::NO_CONTENT.into_response(),
        Err(e) => io_response(e),
    }
}
