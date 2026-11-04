//! 浏览器上传与下载（#28）：系统文件对话框在 Web 版换成上传参考图与下载结果。
//!
//! - 上传参考图：请求体流式落临时文件，边写边算 SHA-256，按内容放进 `导入参考图/<sha256>.<ext>`
//!   （与画板包布局一致，不是任务目录）；同内容重复上传指向同一文件，按成功处理。
//! - 下载：单个文件、带图层的单张结果（zip）与整板全部结果（zip）。zip 由服务端边打边发，不在内存或磁盘攒整包。

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::session::error;
use crate::{paths, relay, AppState, User};

/// 参考图上传落点（与画板包导入的参考图同目录）。
pub const IMPORTED_REFERENCES_DIR: &str = "导入参考图";
/// 单文件上限：与中转结果一致（ADR 0018 的 64 MB 请求预算）。
const MAX_UPLOAD_BYTES: u64 = 64 * 1024 * 1024;

fn forbidden(e: paths::PathError) -> Response {
    error(StatusCode::FORBIDDEN, "forbidden", e.message())
}

fn io_response(e: std::io::Error) -> Response {
    match e.kind() {
        std::io::ErrorKind::NotFound => error(StatusCode::NOT_FOUND, "not_found", "文件不存在"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 临时文件在作用域结束（含客户端中途断开）时删除，不留半成品。
struct TempGuard(PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(serde::Serialize)]
struct Uploaded {
    /// 相对用户数据根的路径。
    path: String,
    sha256: String,
}

/// 上传一张参考图：请求体即文件字节。返回落盘后的相对路径；不是图片 422，超过上限 413。
pub async fn upload_reference(State(state): State<AppState>, user: User, body: Body) -> Response {
    let dir = match paths::resolve(&state.user_root(&user.fingerprint), IMPORTED_REFERENCES_DIR) {
        Ok(d) => d,
        Err(e) => return forbidden(e),
    };
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return io_response(e);
    }
    // 点开头：重新定位与清理遍历都跳过隐藏条目。
    let tmp = crate::store::temp_path_for(&dir.join(".upload"));
    let guard = TempGuard(tmp.clone());
    let mut file = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).await {
        Ok(f) => f,
        Err(e) => return io_response(e),
    };
    let mut hasher = Sha256::new();
    let mut head: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::BAD_REQUEST, "upload_interrupted", "上传中断");
        };
        total += chunk.len() as u64;
        if total > MAX_UPLOAD_BYTES {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "图片超过 64 MB 上限");
        }
        if head.len() < 64 {
            head.extend_from_slice(&chunk[..chunk.len().min(64 - head.len())]);
        }
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            return io_response(e);
        }
    }
    let Some(ext) = relay::sniff_extension(&head) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "not_image", "不是可识别的图片");
    };
    if let Err(e) = file.sync_all().await {
        return io_response(e);
    }
    drop(file);
    let sha256: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    let name = format!("{sha256}.{ext}");
    let target = dir.join(&name);
    // 只新建不覆盖；同名即同内容（文件名就是内容哈希），已存在按成功处理。
    match std::fs::hard_link(&tmp, &target) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return io_response(e),
    }
    drop(guard);
    (StatusCode::CREATED, Json(Uploaded { path: format!("{IMPORTED_REFERENCES_DIR}/{name}"), sha256 })).into_response()
}

// ---- 下载 ----

#[derive(serde::Deserialize)]
pub struct DownloadQuery {
    path: String,
    /// 下载文件名（如参考图的显示名）；缺省取路径最后一段。
    name: Option<String>,
}

/// RFC 5987 编码（只保留 attr-char）。
fn encode_rfc5987(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 附件头：ASCII 回退名 + UTF-8 原名（中文画板名、参考图显示名）。
fn attachment(name: &str) -> String {
    let fallback: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", encode_rfc5987(name))
}

fn file_name_of(rel: &str) -> String {
    rel.rsplit(['/', '\\']).next().unwrap_or(rel).to_string()
}

/// 结果的图层文件：底图名为 `result.*` 时，同一任务目录里的 `layers.json` 与 `layers/` 下的图层（不含隐藏项）。
/// 返回 (相对任务目录的条目名, 真实路径)，按名字排序。
fn layer_files(result: &Path) -> Vec<(String, PathBuf)> {
    let is_result = result.file_stem().is_some_and(|s| s == "result");
    let Some(dir) = result.parent().filter(|_| is_result) else { return Vec::new() };
    let mut out = Vec::new();
    let json = dir.join("layers.json");
    if json.is_file() {
        out.push(("layers.json".to_string(), json));
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("layers")) {
        let mut layers: Vec<(String, PathBuf)> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !n.starts_with('.'))
            .map(|n| (format!("layers/{n}"), dir.join("layers").join(&n)))
            .collect();
        layers.sort();
        out.extend(layers);
    }
    out
}

/// zip 的一项：文件按路径流式读入，文本直接写。
enum ZipItem {
    File(String, PathBuf),
    Text(String, String),
}

/// 把同步 zip 写入桥接到响应流：有界通道提供背压，客户端断开时发送失败即中止打包。
struct ChannelWriter {
    tx: tokio::sync::mpsc::Sender<std::io::Result<axum::body::Bytes>>,
    buf: Vec<u8>,
}

const ZIP_CHUNK: usize = 64 * 1024;

impl ChannelWriter {
    fn send_buf(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = axum::body::Bytes::from(std::mem::take(&mut self.buf));
        self.tx.blocking_send(Ok(chunk)).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "客户端已断开"))
    }
}

impl std::io::Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= ZIP_CHUNK {
            self.send_buf()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.send_buf()
    }
}

fn write_zip(items: Vec<ZipItem>, out: ChannelWriter) -> std::io::Result<()> {
    use zip::write::SimpleFileOptions;
    let to_io = |e: zip::result::ZipError| std::io::Error::other(e.to_string());
    let mut zip = zip::ZipWriter::new_stream(out);
    // 图片本身已压缩：原样存放；文本 deflate。
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
    let deflated = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for item in items {
        match item {
            ZipItem::File(name, path) => {
                let mut file = std::fs::File::open(&path)?;
                let options = if name.ends_with(".json") { deflated.large_file(true) } else { stored };
                zip.start_file(name.as_str(), options).map_err(to_io)?;
                std::io::copy(&mut file, &mut zip)?;
            }
            ZipItem::Text(name, text) => {
                zip.start_file(name.as_str(), deflated).map_err(to_io)?;
                std::io::Write::write_all(&mut zip, text.as_bytes())?;
            }
        }
    }
    let mut out = zip.finish().map_err(to_io)?.into_inner();
    std::io::Write::flush(&mut out)
}

/// 边打包边发送的 zip 响应：不设 Content-Length；中途出错时流以错误结束（浏览器显示下载失败）。
fn zip_response(file_name: &str, items: Vec<ZipItem>) -> Response {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<std::io::Result<axum::body::Bytes>>(4);
    let err_tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        if let Err(e) = write_zip(items, ChannelWriter { tx, buf: Vec::new() }) {
            let _ = err_tx.blocking_send(Err(e));
        }
    });
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
    (
        [(axum::http::header::CONTENT_TYPE, "application/zip".to_string()), (axum::http::header::CONTENT_DISPOSITION, attachment(file_name))],
        Body::from_stream(stream),
    )
        .into_response()
}

/// 下载单张图片：结果带图层时打成 `<task_id>.zip`（底图 + layers/ + layers.json），否则原文件作为附件。
pub async fn download_result(State(state): State<AppState>, user: User, Query(q): Query<DownloadQuery>) -> Response {
    let path = match paths::resolve(&state.user_root(&user.fingerprint), &q.path) {
        Ok(p) => p,
        Err(e) => return forbidden(e),
    };
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        _ => return error(StatusCode::NOT_FOUND, "not_found", "文件不存在"),
    };
    let base_name = file_name_of(&q.path);
    let probe = path.clone();
    let layers = tokio::task::spawn_blocking(move || layer_files(&probe)).await.unwrap_or_default();
    if !layers.is_empty() {
        let task_id = path.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "result".into());
        let mut items = vec![ZipItem::File(base_name, path)];
        items.extend(layers.into_iter().map(|(name, p)| ZipItem::File(name, p)));
        return zip_response(&format!("{task_id}.zip"), items);
    }
    let file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(e) => return io_response(e),
    };
    let name = q.name.filter(|n| !n.trim().is_empty()).unwrap_or(base_name);
    (
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (axum::http::header::CONTENT_LENGTH, meta.len().to_string()),
            (axum::http::header::CONTENT_DISPOSITION, attachment(&name)),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response()
}

/// 整板结果打包的清单：画板里每个结果节点的图片（按路径去重）及其图层；缺失或越界的列进说明文件。
fn board_result_items(root: &Path, board_text: &str) -> Result<Vec<ZipItem>, String> {
    let doc: serde_json::Value = serde_json::from_str(board_text).map_err(|_| "画板文件损坏".to_string())?;
    let nodes = doc.get("nodes").and_then(|n| n.as_array()).cloned().unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    let mut items = Vec::new();
    let mut missing = Vec::new();
    for node in nodes {
        if node.get("type").and_then(|t| t.as_str()) != Some("result") {
            continue;
        }
        let Some(rel) = node.get("path").and_then(|p| p.as_str()) else { continue };
        let rel = rel.replace('\\', "/");
        if !seen.insert(rel.clone()) {
            continue;
        }
        match paths::resolve(root, &rel) {
            Ok(path) if path.is_file() => {
                let dir_rel = rel.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
                let layers = layer_files(&path);
                items.push(ZipItem::File(rel.clone(), path));
                items.extend(layers.into_iter().map(|(name, p)| ZipItem::File(format!("{dir_rel}{name}"), p)));
            }
            _ => missing.push(rel),
        }
    }
    if !missing.is_empty() {
        let text = format!("以下结果在用户数据根中缺失，未打包（可在画板上重新定位后再下载）：\n{}\n", missing.join("\n"));
        items.push(ZipItem::Text("缺失文件.txt".into(), text));
    }
    Ok(items)
}

/// 整板全部结果打成一个 zip，服务端流式生成；条目按用户数据根内的相对路径存放。
pub async fn download_board_results(State(state): State<AppState>, user: User, Query(q): Query<DownloadQuery>) -> Response {
    let root = state.user_root(&user.fingerprint);
    let path = match paths::resolve(&root, &q.path) {
        Ok(p) => p,
        Err(e) => return forbidden(e),
    };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(e) => return io_response(e),
    };
    let items = match tokio::task::spawn_blocking(move || board_result_items(&root, &text)).await {
        Ok(Ok(items)) => items,
        Ok(Err(why)) => return error(StatusCode::UNPROCESSABLE_ENTITY, "board_corrupt", &why),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    };
    let stem = file_name_of(&q.path);
    let stem = stem.strip_suffix(".ugcboard.json").unwrap_or(&stem);
    zip_response(&format!("{stem}-结果.zip"), items)
}

/// 本模块的路由（独立注册，减少与其他接口的合并冲突）。
pub fn routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/upload/reference", axum::routing::post(upload_reference))
        .route("/api/download/result", axum::routing::get(download_result))
        .route("/api/download/board-results", axum::routing::get(download_board_results))
}
