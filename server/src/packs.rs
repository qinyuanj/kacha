//! 画板包 HTTP 接口（#24）。包格式与合并规则在前端 core/boardPack.ts；这里只搬字节、守路径与资源预算。
//!
//! - 导出：POST /api/packs/export?op=<id>，请求体是 ExportSpec（source 一律相对用户数据根），
//!   响应体是边打包边发送的 zip 下载流（不落临时文件，单个大请求不进内存）。
//! - 导入：POST /api/packs/uploads 流式上传 zip 到用户元数据目录下的临时文件（不受 64 MB 单文件限制），
//!   再读条目 / 文本做导入前判定，最后 POST /api/packs/uploads/{id}/import?op=<op> 执行合并。
//!   导入结束（成功 / 失败 / 取消）或上传中断都删除临时文件。
//! - 取消与进度按操作 id 隔离：POST /api/packs/ops/{op}/cancel 只影响该操作；GET 读进度。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::board_pack::{self, ExportSpec, MergeUnit, CANCELLED};
use crate::session::error;
use crate::{AppState, User, META_DIR};

/// 上传临时文件放在用户元数据目录下，不与画板、任务目录混在一层。
const UPLOAD_DIR: &str = "packs";

// ---- 操作注册表：取消标记与进度按 (用户, 操作 id) 隔离 ----

#[derive(Default)]
pub struct PackOps {
    map: Mutex<HashMap<(String, String), Arc<Op>>>,
}

pub struct Op {
    cancel: AtomicBool,
    done: AtomicU64,
    total: AtomicU64,
}

impl PackOps {
    fn register(&self, user: &str, id: &str) -> Arc<Op> {
        let op = Arc::new(Op { cancel: AtomicBool::new(false), done: AtomicU64::new(0), total: AtomicU64::new(0) });
        self.map.lock().unwrap().insert((user.to_string(), id.to_string()), op.clone());
        op
    }

    fn get(&self, user: &str, id: &str) -> Option<Arc<Op>> {
        self.map.lock().unwrap().get(&(user.to_string(), id.to_string())).cloned()
    }

    fn finish(&self, user: &str, id: &str) {
        self.map.lock().unwrap().remove(&(user.to_string(), id.to_string()));
    }
}

fn valid_op_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn progress_fn(op: &Arc<Op>) -> impl Fn(u64, u64) {
    let op = op.clone();
    move |done, total| {
        op.done.store(done, Ordering::Relaxed);
        op.total.store(total, Ordering::Relaxed);
    }
}

/// 操作结束即注销；取消后新的查询也拿不到已结束的操作。
struct OpGuard {
    ops: Arc<PackOps>,
    user: String,
    id: String,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        self.ops.finish(&self.user, &self.id);
    }
}

fn begin_op(state: &AppState, user: &User, id: &str) -> Result<(Arc<Op>, OpGuard), Response> {
    if !valid_op_id(id) {
        return Err(error(StatusCode::BAD_REQUEST, "bad_request", "操作 id 只允许字母、数字、- 与 _"));
    }
    let op = state.pack_ops().register(&user.fingerprint, id);
    Ok((op.clone(), OpGuard { ops: state.pack_ops().clone(), user: user.fingerprint.clone(), id: id.to_string() }))
}

pub async fn op_progress(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    match state.pack_ops().get(&user.fingerprint, &id) {
        Some(op) => Json(serde_json::json!({ "done": op.done.load(Ordering::Relaxed), "total": op.total.load(Ordering::Relaxed) })).into_response(),
        None => error(StatusCode::NOT_FOUND, "not_found", "操作已结束或不存在"),
    }
}

pub async fn op_cancel(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    match state.pack_ops().get(&user.fingerprint, &id) {
        Some(op) => {
            op.cancel.store(true, Ordering::Relaxed);
            StatusCode::NO_CONTENT.into_response()
        }
        // 操作已结束（或从未存在）：取消是幂等的，不当错误。
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

// ---- 导出：流式 zip 下载 ----

#[derive(Deserialize)]
pub struct OpQuery {
    op: String,
}

/// 把阻塞的 zip 写入接到 HTTP 响应体：worker 在 spawn_blocking 里写，bounded channel 背压，
/// 客户端断开时 receiver 被 drop，writer 的下一次写出错即中止，不占异步线程也不留文件。
pub async fn export(State(state): State<AppState>, user: User, Query(q): Query<OpQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = crate::fs::ensure_space(&state) {
        return r;
    }
    let Ok(spec) = serde_json::from_slice::<ExportSpec>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要画板包导出规格");
    };
    let (op, _guard) = match begin_op(&state, &user, &q.op) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let root = state.user_root(&user.fingerprint);
    // 预检在流开始前完成：路径越界 / 条目重复还能回 4xx；打包中途的失败只能中止流（前端按下载失败处理）。
    let check_root = root.clone();
    let check_spec = serde_json::from_slice::<ExportSpec>(&body).unwrap();
    match tokio::task::spawn_blocking(move || board_pack::validate_export(&check_root, &check_spec)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return error(StatusCode::UNPROCESSABLE_ENTITY, "export_failed", &e.to_string()),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
    let permit = state.heavy().acquire().await;
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Vec<u8>>>(4);
    let writer = ChannelWriter(tx.clone());
    let progress = progress_fn(&op);
    let cancel = op.clone();
    // 许可与操作注册随打包任务存活：下载流发完（或客户端断开、writer 写出错）才释放。
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _guard = _guard;
        if let Err(e) = board_pack::export_to_writer(&root, &spec, writer, &progress, &cancel.cancel) {
            // 把错误交给流：接收端读到 Err 即中止下载（前端按导出失败 / 已取消处理）。
            let _ = tx.blocking_send(Err(e));
        }
    });
    let stream = tokio_stream_from_channel(rx);
    (
        [(header::CONTENT_TYPE, "application/zip"), (header::CONTENT_DISPOSITION, "attachment; filename=board.ugcpack")],
        Body::from_stream(stream),
    )
        .into_response()
}

fn tokio_stream_from_channel(rx: tokio::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) })
}

struct ChannelWriter(tokio::sync::mpsc::Sender<std::io::Result<Vec<u8>>>);

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // 阻塞等接收方取走：bounded channel 即背压，不在内存里堆整个包。
        self.0.blocking_send(Ok(buf.to_vec())).map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, CANCELLED))?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// ---- 导入：流式上传 → 判定 → 合并 ----

#[derive(serde::Serialize)]
struct Uploaded {
    id: String,
}

/// 上传临时文件守卫：任何提前返回（含客户端断开导致 Future 被 drop）都删掉半成品。
struct UploadGuard {
    file: PathBuf,
    keep: bool,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.file);
            let _ = std::fs::remove_dir(self.file.parent().unwrap_or(Path::new(".")));
        }
    }
}

fn upload_path(root: &Path, id: &str) -> PathBuf {
    root.join(META_DIR).join(UPLOAD_DIR).join(format!("{id}.ugcpack.tmp"))
}

pub async fn upload(State(state): State<AppState>, user: User, body: Body) -> Response {
    if let Err(r) = crate::fs::ensure_space(&state) {
        return r;
    }
    let root = state.user_root(&user.fingerprint);
    let _permit = state.heavy().acquire().await;
    let id = format!("{:x}", rand_u64());
    let file = upload_path(&root, &id);
    if let Err(e) = std::fs::create_dir_all(file.parent().unwrap()) {
        return crate::fs::io_error(e);
    }
    let mut guard = UploadGuard { file: file.clone(), keep: false };
    let mut out = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&file).await {
        Ok(f) => f,
        Err(e) => return crate::fs::io_error(e),
    };
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => return error(StatusCode::BAD_REQUEST, "upload_failed", "上传中断"),
        };
        if let Err(e) = out.write_all(&chunk).await {
            return crate::fs::io_error(e);
        }
    }
    if let Err(e) = out.sync_all().await {
        return crate::fs::io_error(e);
    }
    drop(out);
    guard.keep = true;
    Json(Uploaded { id }).into_response()
}

fn rand_u64() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    u64::from_le_bytes(b)
}

fn resolve_upload(state: &AppState, user: &User, id: &str) -> Result<PathBuf, Response> {
    if !valid_op_id(id) {
        return Err(error(StatusCode::BAD_REQUEST, "bad_request", "上传 id 无效"));
    }
    let file = upload_path(&state.user_root(&user.fingerprint), id);
    if !file.is_file() {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "上传的画板包不存在或已被清理"));
    }
    Ok(file)
}

pub async fn upload_entries(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    let file = match resolve_upload(&state, &user, &id) {
        Ok(f) => f,
        Err(r) => return r,
    };
    match tokio::task::spawn_blocking(move || board_pack::entries(&file)).await {
        Ok(Ok(names)) => Json(names).into_response(),
        Ok(Err(e)) => error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pack", &format!("无法读取画板包：{e}")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

pub async fn upload_texts(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>, body: axum::body::Bytes) -> Response {
    let Ok(names) = serde_json::from_slice::<Vec<String>>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要条目名列表");
    };
    let file = match resolve_upload(&state, &user, &id) {
        Ok(f) => f,
        Err(r) => return r,
    };
    match tokio::task::spawn_blocking(move || board_pack::read_texts(&file, &names)).await {
        Ok(Ok(texts)) => Json(texts).into_response(),
        Ok(Err(e)) => error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pack", &format!("无法读取画板包：{e}")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 执行导入：结束后无论结局都删除上传临时文件（已移入的单元保留）。
pub async fn import(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>, Query(q): Query<OpQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = crate::fs::ensure_space(&state) {
        return r;
    }
    let Ok(units) = serde_json::from_slice::<Vec<MergeUnit>>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要合并单元列表");
    };
    let file = match resolve_upload(&state, &user, &id) {
        Ok(f) => f,
        Err(r) => return r,
    };
    // 导入结束即删除上传的包。
    let cleanup = UploadGuard { file: file.clone(), keep: false };
    let (op, _guard) = match begin_op(&state, &user, &q.op) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let root = state.user_root(&user.fingerprint);
    let _permit = state.heavy().acquire().await;
    let progress = progress_fn(&op);
    let cancel = op.clone();
    let result = tokio::task::spawn_blocking(move || board_pack::import(&file, &root, &units, &progress, &cancel.cancel)).await;
    drop(cleanup);
    match result {
        Ok(Ok(report)) => Json(report).into_response(),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => error(StatusCode::CONFLICT, "cancelled", CANCELLED),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidData => error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pack", &e.to_string()),
        Ok(Err(e)) => crate::fs::io_error(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 放弃上传（用户在判定后取消）：删除临时文件。
pub async fn discard_upload(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    let file = upload_path(&state.user_root(&user.fingerprint), &id);
    if !valid_op_id(&id) {
        return error(StatusCode::BAD_REQUEST, "bad_request", "上传 id 无效");
    }
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir(file.parent().unwrap());
    StatusCode::NO_CONTENT.into_response()
}
