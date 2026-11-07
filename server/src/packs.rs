//! 画板包 HTTP 接口（#24）。包格式与合并规则在前端 core/boardPack.ts；这里只搬字节、守路径与资源预算。
//!
//! - 导出：先 POST /api/packs/export/facts?op=<id> 取逐文件长度与 sha256（前端核心据此按内容去重），
//!   再 POST /api/packs/export?op=<id>，请求体是 ExportSpec（source 一律相对用户数据根，omitted 里的条目不写），
//!   响应体是边打包边发送的 zip 下载流（不落临时文件，单个大请求不进内存）。
//! - 导入：POST /api/packs/uploads 流式上传 zip 到用户元数据目录下的临时文件（不受 64 MB 单文件限制），
//!   再读条目 / 文本做导入前判定，最后 POST /api/packs/uploads/{id}/import?op=<op> 执行合并。
//!   导入结束（成功 / 失败 / 取消）或上传中断都删除临时文件。
//!   关页等留下的临时文件，在该用户下次上传开始时按修改时间回收（超过 1 小时）。
//!   上传可带 `?op=<id>`（#59）：总量取 Content-Length，每写一块更新已完成字节数；被取消回 409 并删掉半成品。
//!   上传不占大请求名额（#60）：两块之间空闲超过 60 秒回 408 并删掉半成品；Content-Length 加余量门槛
//!   超过可用磁盘时，开始写入前就回 507。读条目 / 文本、合并、导出仍要拿名额。
//! - 取消与进度按操作 id 隔离：POST /api/packs/ops/{op}/cancel 只影响该操作；GET 读进度，操作已结束或不存在时回 204。

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
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::board_pack::{self, ExportSpec, MergeUnit, PackDuplicate, CANCELLED};
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
    /// 取消时唤醒在异步里等待的一方（上传停在等下一块请求体时也要能立刻结束）。
    cancelled: tokio::sync::Notify,
    done: AtomicU64,
    total: AtomicU64,
}

impl Op {
    /// 等到该操作被取消；先登记再查标记，取消发生在两者之间也不会漏。
    async fn wait_cancelled(&self) {
        let notified = self.cancelled.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.cancel.load(Ordering::Relaxed) {
            return;
        }
        notified.await;
    }
}

impl PackOps {
    fn register(&self, user: &str, id: &str) -> Arc<Op> {
        let op = Arc::new(Op { cancel: AtomicBool::new(false), cancelled: tokio::sync::Notify::new(), done: AtomicU64::new(0), total: AtomicU64::new(0) });
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
        // 操作已结束或尚未开始：轮询与阶段切换难免撞上这个间隙，不当错误（不回 404，见 #59）。
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

pub async fn op_cancel(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    match state.pack_ops().get(&user.fingerprint, &id) {
        Some(op) => {
            op.cancel.store(true, Ordering::Relaxed);
            op.cancelled.notify_waiters();
            StatusCode::NO_CONTENT.into_response()
        }
        // 操作已结束（或从未存在）：取消是幂等的，不当错误。
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

/// 阻塞的画板包操作（字节事实、合并落盘）的结局到 HTTP 回复：被取消 409、包或规格不合格 422（`invalid_code`），
/// 其余 io 错误按读写接口的映射（404 / 409 / 500）。
fn pack_reply<T: serde::Serialize>(result: Result<std::io::Result<T>, tokio::task::JoinError>, invalid_code: &str) -> Response {
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::Interrupted => error(StatusCode::CONFLICT, "cancelled", CANCELLED),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidData => error(StatusCode::UNPROCESSABLE_ENTITY, invalid_code, &e.to_string()),
        Ok(Err(e)) => crate::fs::io_error(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
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

/// 导出前的字节事实（包格式 v2 的 hash 阶段）：请求体是不含文本条目的导出规格，返回每个要写的文件的长度与 sha256。
/// 与导出同样读全部文件，故占一个大请求名额；进度按已读字节，可按操作 id 取消（409）。
pub async fn export_facts(State(state): State<AppState>, user: User, Query(q): Query<OpQuery>, body: axum::body::Bytes) -> Response {
    let Ok(spec) = serde_json::from_slice::<ExportSpec>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要画板包导出规格");
    };
    let (op, _guard) = match begin_op(&state, &user, &q.op) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let root = state.user_root(&user.fingerprint);
    let _permit = state.heavy().acquire().await;
    let progress = progress_fn(&op);
    let cancel = op.clone();
    pack_reply(tokio::task::spawn_blocking(move || board_pack::entry_facts(&root, &spec, &progress, &cancel.cancel)).await, "export_failed")
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

const UPLOAD_SUFFIX: &str = ".ugcpack.tmp";

fn upload_path(root: &Path, id: &str) -> PathBuf {
    root.join(META_DIR).join(UPLOAD_DIR).join(format!("{id}{UPLOAD_SUFFIX}"))
}

/// 去重上传（#62）的暂存：每次导入一个目录 `<id>.staging.tmp/`，里面每份内容一个文件，以 sha256 命名。
const CONTENT_DIR: &str = "pack-content";
const CONTENT_SUFFIX: &str = ".staging.tmp";

/// 该用户的上传暂存：(元数据目录下的子目录, 暂存条目名后缀)。新的上传暂存位置加在这里，
/// 每次上传开始时一并回收。
const UPLOAD_STAGING: &[(&str, &str)] = &[(UPLOAD_DIR, UPLOAD_SUFFIX), (CONTENT_DIR, CONTENT_SUFFIX)];

/// 上传暂存最后一次写入超过这个时间才回收：并发进行中的上传在持续写入，等待导入的不会等这么久。
const STALE_UPLOAD_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// 回收关页、`discard` 没发出去等情况留下的上传暂存。只删过期条目；删除失败留给下次，不影响本次上传。
fn sweep_stale_uploads(root: &Path, now: std::time::SystemTime) {
    for (dir, suffix) in UPLOAD_STAGING {
        for entry in std::fs::read_dir(root.join(META_DIR).join(dir)).into_iter().flatten().flatten() {
            if !entry.file_name().to_string_lossy().ends_with(suffix) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let stale = meta.modified().is_ok_and(|m| now.duration_since(m).is_ok_and(|age| age >= STALE_UPLOAD_AGE));
            if !stale {
                continue;
            }
            let _ = if meta.is_dir() { std::fs::remove_dir_all(entry.path()) } else { std::fs::remove_file(entry.path()) };
        }
    }
}

#[derive(Deserialize)]
pub struct UploadQuery {
    op: Option<String>,
}

fn content_length(headers: &axum::http::HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok())
}

/// 写请求体时的附加规则：已完成字节从 `base` 起算（去重上传跨多份内容累计进度）；写过 `max` 字节回 413；
/// `hasher` 边写边算 sha256。
#[derive(Default)]
struct Receive<'a> {
    op: Option<&'a Op>,
    base: u64,
    max: Option<u64>,
    hasher: Option<&'a mut Sha256>,
}

/// 把上传请求体逐块写进 `out`，返回写入的字节数。上传类接口共用（#60）：
/// - 不拿大请求许可，快慢取决于客户端；两块之间空闲超过 UPLOAD_IDLE_TIMEOUT 回 408。
/// - 带操作时每写一块更新已完成字节数；等下一块时也看取消，被取消回 409。
///
/// 出错时由调用方的守卫删掉写了一半的文件。
async fn receive_body(body: Body, out: &mut tokio::fs::File, rules: Receive<'_>) -> Result<u64, Response> {
    let Receive { op, base, max, mut hasher } = rules;
    let mut stream = body.into_data_stream();
    let mut done = 0u64;
    loop {
        let next = tokio::time::timeout(crate::limits::UPLOAD_IDLE_TIMEOUT, async {
            match op {
                // 请求体停在半路（慢连接、卡住）时取消也要立刻生效。
                Some(op) => tokio::select! {
                    chunk = stream.next() => Ok(chunk),
                    _ = op.wait_cancelled() => Err(()),
                },
                None => Ok(stream.next().await),
            }
        })
        .await;
        let next = match next {
            Err(_) => return Err(error(StatusCode::REQUEST_TIMEOUT, "upload_timeout", UPLOAD_TIMEOUT_MESSAGE)),
            Ok(Err(())) => return Err(error(StatusCode::CONFLICT, "cancelled", CANCELLED)),
            Ok(Ok(next)) => next,
        };
        let Some(chunk) = next else { return Ok(done) };
        let chunk = chunk.map_err(|_| error(StatusCode::BAD_REQUEST, "upload_failed", "上传中断"))?;
        done += chunk.len() as u64;
        if max.is_some_and(|max| done > max) {
            return Err(too_large());
        }
        out.write_all(&chunk).await.map_err(crate::fs::io_error)?;
        if let Some(h) = hasher.as_deref_mut() {
            h.update(&chunk);
        }
        if let Some(op) = op {
            op.done.store(base + done, Ordering::Relaxed);
            if op.cancel.load(Ordering::Relaxed) {
                return Err(error(StatusCode::CONFLICT, "cancelled", CANCELLED));
            }
        }
    }
}

const UPLOAD_TIMEOUT_MESSAGE: &str = "上传中断：超过 60 秒没有收到数据，请检查网络后重试";

fn too_large() -> Response {
    error(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large", "单份内容超过 64 MB 上限")
}

pub async fn upload(State(state): State<AppState>, user: User, Query(q): Query<UploadQuery>, headers: axum::http::HeaderMap, body: Body) -> Response {
    // 开始写入前预检：已知长度时要放得下这次上传，未知时按现有门槛。
    let length = content_length(&headers);
    if let Err(r) = crate::fs::ensure_space_for(&state, length) {
        return r;
    }
    // 带操作 id 时报进度、可取消；不带时照旧（进度与取消都没有）。
    let tracked = match q.op.as_deref().map(|id| begin_op(&state, &user, id)).transpose() {
        Ok(v) => v,
        Err(r) => return r,
    };
    let op = tracked.as_ref().map(|(op, _)| op.clone());
    if let Some(op) = &op {
        op.total.store(length.unwrap_or(0), Ordering::Relaxed);
    }
    let root = state.user_root(&user.fingerprint);
    sweep_stale_uploads(&root, state.now());
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
    if let Err(r) = receive_body(body, &mut out, Receive { op: op.as_deref(), ..Default::default() }).await {
        return r;
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
    let _permit = state.heavy().acquire().await;
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
    let _permit = state.heavy().acquire().await;
    match tokio::task::spawn_blocking(move || board_pack::read_texts(&file, &names)).await {
        Ok(Ok(texts)) => Json(texts).into_response(),
        Ok(Err(e)) => error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pack", &format!("无法读取画板包：{e}")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 导入请求体：v1 包只有合并单元列表；v2 包另带被省略路径的还原清单（为空时与 v1 相同）。
#[derive(Deserialize)]
#[serde(untagged)]
enum ImportRequest {
    Units(Vec<MergeUnit>),
    WithDuplicates {
        units: Vec<MergeUnit>,
        #[serde(default)]
        duplicates: Vec<PackDuplicate>,
    },
}

/// 执行导入：结束后无论结局都删除上传临时文件（已移入的单元保留）。
pub async fn import(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>, Query(q): Query<OpQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = crate::fs::ensure_space(&state) {
        return r;
    }
    let (units, duplicates) = match serde_json::from_slice::<ImportRequest>(&body) {
        Ok(ImportRequest::Units(units)) => (units, Vec::new()),
        Ok(ImportRequest::WithDuplicates { units, duplicates }) => (units, duplicates),
        Err(_) => return error(StatusCode::BAD_REQUEST, "bad_request", "需要合并单元列表"),
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
    let result = tokio::task::spawn_blocking(move || board_pack::import(&file, &root, &units, &duplicates, &progress, &cancel.cancel)).await;
    drop(cleanup);
    pack_reply(result, "invalid_pack")
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

// ---- 去重上传（#62）：问已有 → 开暂存 → 逐份上传缺少的内容 → 按落盘清单合并 ----
// 上传沿用整包上传的规则（#60）：不拿大请求名额、空闲超时 408、按 Content-Length 的余量预检 507、按操作 id 取消 409；
// 另外每份内容遵守单文件 64 MB 上限（413），并边写边算 sha256 与声明核对（不一致按损坏 422）。
// 问已有（要读身份文件算 sha256）与合并落盘仍拿大请求名额。

/// 用户数据根里已有的合并单元，每个单元一种状态（见 board_pack::ExistingUnit）；路径越界回 403。
pub async fn existing(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
    let Ok(units) = serde_json::from_slice::<Vec<MergeUnit>>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要合并单元列表");
    };
    let root = state.user_root(&user.fingerprint);
    let _permit = state.heavy().acquire().await;
    match tokio::task::spawn_blocking(move || board_pack::existing_units(&root, &units)).await {
        Ok(Ok(out)) => Json(out).into_response(),
        Ok(Err(e)) => error(StatusCode::FORBIDDEN, "forbidden", &e.to_string()),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

fn staging_path(root: &Path, id: &str) -> PathBuf {
    root.join(META_DIR).join(CONTENT_DIR).join(format!("{id}{CONTENT_SUFFIX}"))
}

fn resolve_staging(state: &AppState, user: &User, id: &str) -> Result<PathBuf, Response> {
    if !valid_op_id(id) {
        return Err(error(StatusCode::BAD_REQUEST, "bad_request", "暂存 id 无效"));
    }
    let dir = staging_path(&state.user_root(&user.fingerprint), id);
    if !dir.is_dir() {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "上传暂存不存在或已被清理"));
    }
    Ok(dir)
}

/// 开一份去重上传暂存。这是一次去重上传的开始：照整包上传的做法先回收该用户过期的上传暂存。
pub async fn open_staging(State(state): State<AppState>, user: User) -> Response {
    let root = state.user_root(&user.fingerprint);
    sweep_stale_uploads(&root, state.now());
    let id = format!("{:x}", rand_u64());
    match std::fs::create_dir_all(staging_path(&root, &id)) {
        Ok(()) => Json(Uploaded { id }).into_response(),
        Err(e) => crate::fs::io_error(e),
    }
}

#[derive(Deserialize)]
pub struct ContentQuery {
    op: Option<String>,
    /// 本份之前已传的字节与全部要传的字节：进度跨各份累计。
    done: Option<u64>,
    total: Option<u64>,
}

/// 上传一份内容到暂存：先写临时的 `.part`，边写边算 sha256，与路径里声明的一致才改名为 `<sha256>`。
pub async fn put_content(
    State(state): State<AppState>,
    user: User,
    AxPath((id, sha256)): AxPath<(String, String)>,
    Query(q): Query<ContentQuery>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    if !board_pack::valid_sha256(&sha256) {
        return error(StatusCode::BAD_REQUEST, "bad_request", "sha256 应为 64 位小写十六进制");
    }
    let dir = match resolve_staging(&state, &user, &id) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let length = content_length(&headers);
    if length.is_some_and(|n| n > crate::MAX_BODY_BYTES as u64) {
        return too_large();
    }
    if let Err(r) = crate::fs::ensure_space_for(&state, length) {
        return r;
    }
    let tracked = match q.op.as_deref().map(|op| begin_op(&state, &user, op)).transpose() {
        Ok(v) => v,
        Err(r) => return r,
    };
    let op = tracked.as_ref().map(|(op, _)| op.clone());
    let base = q.done.unwrap_or(0);
    if let Some(op) = &op {
        op.total.store(q.total.unwrap_or(base + length.unwrap_or(0)), Ordering::Relaxed);
        op.done.store(base, Ordering::Relaxed);
    }
    let target = board_pack::staged_content(&dir, &sha256);
    let part = dir.join(format!("{sha256}.{:x}.part", rand_u64()));
    let mut guard = PartGuard { file: part.clone(), keep: false };
    let mut out = match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await {
        Ok(f) => f,
        Err(e) => return crate::fs::io_error(e),
    };
    let mut hasher = Sha256::new();
    let rules = Receive { op: op.as_deref(), base, max: Some(crate::MAX_BODY_BYTES as u64), hasher: Some(&mut hasher) };
    if let Err(r) = receive_body(body, &mut out, rules).await {
        return r;
    }
    if format!("{:x}", hasher.finalize()) != sha256 {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pack", "上传的内容与声明的 sha256 不一致，画板包已损坏");
    }
    if let Err(e) = out.sync_all().await {
        return crate::fs::io_error(e);
    }
    drop(out);
    // 同一份内容重复上传（重试）时覆盖为同样的字节，结果不变。
    if let Err(e) = std::fs::rename(&part, &target) {
        return crate::fs::io_error(e);
    }
    guard.keep = true;
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct StagedImport {
    units: Vec<MergeUnit>,
    files: Vec<board_pack::PlacedFile>,
}

/// 按落盘清单合并：结束后无论结局都删除暂存（已移入的单元保留）。
pub async fn import_staging(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>, Query(q): Query<OpQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = crate::fs::ensure_space(&state) {
        return r;
    }
    let Ok(StagedImport { units, files }) = serde_json::from_slice::<StagedImport>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要合并单元与落盘清单");
    };
    let dir = match resolve_staging(&state, &user, &id) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let cleanup = StagingGuard(dir.clone());
    let (op, _guard) = match begin_op(&state, &user, &q.op) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let root = state.user_root(&user.fingerprint);
    let _permit = state.heavy().acquire().await;
    let progress = progress_fn(&op);
    let cancel = op.clone();
    let result = tokio::task::spawn_blocking(move || board_pack::import_staged(&dir, &root, &units, &files, &progress, &cancel.cancel)).await;
    drop(cleanup);
    pack_reply(result, "invalid_pack")
}

/// 写了一半的内容文件守卫：只删这个文件，不动暂存目录（同一暂存里还有别的内容）。
struct PartGuard {
    file: PathBuf,
    keep: bool,
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = std::fs::remove_file(&self.file);
        }
    }
}

/// 暂存目录守卫：离开作用域时整目录删除。
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 放弃暂存（导入在合并之前被取消 / 失败）：删除整个暂存目录，幂等。
pub async fn discard_staging(State(state): State<AppState>, user: User, AxPath(id): AxPath<String>) -> Response {
    if !valid_op_id(&id) {
        return error(StatusCode::BAD_REQUEST, "bad_request", "暂存 id 无效");
    }
    let _ = std::fs::remove_dir_all(staging_path(&state.user_root(&user.fingerprint), &id));
    StatusCode::NO_CONTENT.into_response()
}
