//! 用户数据根内的文件与文本接口：路径一律相对用户数据根，越界 403。

use std::io::ErrorKind;
use std::path::PathBuf;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use tokio_util::io::ReaderStream;

use crate::session::error;
use crate::{cache, paths, store, AppState, User, META_DIR};

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
}

#[derive(Deserialize)]
pub struct DirQuery {
    dir: String,
}

#[derive(Deserialize)]
pub struct RenameRequest {
    from: String,
    to: String,
    version: Option<String>,
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
}

/// 把 io 错误映射成 HTTP：不存在 404、已存在 409、其他 500。越界由 paths 单独给出 403。
pub(crate) fn io_error(e: std::io::Error) -> Response {
    match e.kind() {
        ErrorKind::NotFound => error(StatusCode::NOT_FOUND, "not_found", "文件不存在"),
        ErrorKind::AlreadyExists => error(StatusCode::CONFLICT, "already_exists", "目标已存在，本接口只新建不覆盖"),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()),
    }
}

/// 请求里的相对路径 → 当前用户数据根内的绝对路径；越界 403。
pub(crate) fn resolve(state: &AppState, user: &User, rel: &str) -> Result<PathBuf, Response> {
    paths::resolve(&state.user_root(&user.fingerprint), rel).map_err(|e| error(StatusCode::FORBIDDEN, "forbidden", e.message()))
}

/// 写入类接口的磁盘余量检查：不足 507。
pub(crate) fn ensure_space(state: &AppState) -> Result<(), Response> {
    if state.disk_guard().enough() {
        Ok(())
    } else {
        Err(error(StatusCode::INSUFFICIENT_STORAGE, "insufficient_storage", "服务器空间不足，请联系管理员"))
    }
}

/// 阻塞工作放进 spawn_blocking；任务本身 panic 时回 500。领域错误留在 T 里由调用方映射。
pub(crate) async fn off_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, Response> {
    tokio::task::spawn_blocking(f).await.map_err(|e| error(StatusCode::INTERNAL_SERVER_ERROR, "io", &e.to_string()))
}

/// 阻塞 IO：io 错误按 io_error 映射。
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> std::io::Result<T> + Send + 'static) -> Result<T, Response> {
    off_thread(f).await?.map_err(io_error)
}

// ---- 文本元数据（设置 / 界面状态 / 模型缓存 / 能力表覆盖）----

async fn read_meta(state: AppState, user: User, name: &'static str) -> Response {
    match resolve(&state, &user, &format!("{META_DIR}/{name}")) {
        Err(r) => r,
        Ok(path) => match blocking(move || store::read_text(&path)).await {
            // 原文回传，缺文件时是 JSON null；不能用 Json<Option<String>>（null 会变成空响应体）。
            Ok(text) => ([(header::CONTENT_TYPE, "application/json; charset=utf-8")], text.unwrap_or_else(|| "null".into())).into_response(),
            Err(r) => r,
        },
    }
}

async fn write_meta(state: AppState, user: User, name: &'static str, body: axum::body::Bytes) -> Response {
    if let Err(r) = ensure_space(&state) {
        return r;
    }
    match resolve(&state, &user, &format!("{META_DIR}/{name}")) {
        Err(r) => r,
        Ok(path) => match blocking(move || store::atomic_write(&path, &body)).await {
            Ok(()) => StatusCode::NO_CONTENT.into_response(),
            Err(r) => r,
        },
    }
}

macro_rules! meta_routes {
    ($read:ident, $write:ident, $file:expr) => {
        pub async fn $read(State(state): State<AppState>, user: User) -> Response {
            read_meta(state, user, $file).await
        }
        pub async fn $write(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
            write_meta(state, user, $file, body).await
        }
    };
}

meta_routes!(read_settings, write_settings, "settings.json");
meta_routes!(read_ui_state, write_ui_state, "ui-state.json");
meta_routes!(read_models_cache, write_models_cache, "models-cache.json");

pub async fn read_capability_override(State(state): State<AppState>, user: User) -> Response {
    read_meta(state, user, "capabilities.override.json").await
}

// ---- 画板 ----

pub async fn read_board(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    match resolve(&state, &user, &q.path) {
        Err(r) => r,
        Ok(path) => match blocking(move || store::read_board(&path)).await {
            Ok(texts) => Json(texts).into_response(),
            Err(r) => r,
        },
    }
}

#[derive(Deserialize)]
pub struct BoardQuery {
    path: String,
    /// 带版本写：内容已变返回 409 board_conflict；文件已不存在返回 409 board_missing。
    version: Option<String>,
    /// 只新建不覆盖：两页同时建同名画板时后到者 409。
    create_only: Option<bool>,
}

pub async fn write_board(State(state): State<AppState>, user: User, Query(q): Query<BoardQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = ensure_space(&state) {
        return r;
    }
    let guard = if q.create_only.unwrap_or(false) {
        store::BoardWriteGuard::CreateOnly
    } else if let Some(version) = q.version {
        store::BoardWriteGuard::Version(version)
    } else {
        store::BoardWriteGuard::Any
    };
    let path = match resolve(&state, &user, &q.path) {
        Err(r) => return r,
        Ok(p) => p,
    };
    // 读、比较、写之间不能插进另一个写：同进程内画板写与改名串行。
    let _lock = state.board_lock().lock().await;
    match off_thread(move || String::from_utf8(body.to_vec()).map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e)).map_err(store::BoardSaveError::from).and_then(|text| store::write_board_guarded(&path, &text, guard))).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => board_save_error(e),
        Err(r) => r,
    }
}

fn board_save_error(e: store::BoardSaveError) -> Response {
    match e {
        store::BoardSaveError::Conflict => error(StatusCode::CONFLICT, "board_conflict", "画板已在别处修改，请重新载入"),
        store::BoardSaveError::Missing => error(StatusCode::CONFLICT, "board_missing", "画板已在别处改名或删除，请重新载入；未保存的改动仍在本页，可先导出"),
        store::BoardSaveError::AlreadyExists => error(StatusCode::CONFLICT, "already_exists", "同名画板已存在，请换一个名字"),
        store::BoardSaveError::Io(e) => io_error(e),
    }
}

pub async fn rename_board(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
    let Ok(req) = serde_json::from_slice::<RenameRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要 from 与 to");
    };
    let (from, to) = match (resolve(&state, &user, &req.from), resolve(&state, &user, &req.to)) {
        (Ok(f), Ok(t)) => (f, t),
        (Err(r), _) | (_, Err(r)) => return r,
    };
    let _lock = state.board_lock().lock().await;
    match off_thread(move || store::rename_board_guarded(&from, &to, req.version.as_deref())).await {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) if e.kind() == ErrorKind::NotFound => error(StatusCode::NOT_FOUND, "not_found", "画板不存在，可能已在别处改名或删除；请重新载入画板列表"),
        Ok(Err(e)) if e.kind() == ErrorKind::InvalidInput => error(StatusCode::CONFLICT, "board_conflict", "画板已在别处修改，请重新载入"),
        Ok(Err(e)) => io_error(e),
        Err(r) => r,
    }
}

pub async fn list_board_names(State(state): State<AppState>, user: User, Query(q): Query<DirQuery>) -> Response {
    match resolve(&state, &user, &q.dir) {
        Err(r) => r,
        Ok(path) => match blocking(move || store::list_board_names(&path)).await {
            Ok(names) => Json(names).into_response(),
            Err(r) => r,
        },
    }
}

// ---- 通用文件 ----

/// 流式读取；同一路径供 `<img>` 使用（cookie 认人），替代桌面的本地文件 URL。
pub async fn read_file(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    let path = match resolve(&state, &user, &q.path) {
        Err(r) => return r,
        Ok(p) => p,
    };
    let meta = match tokio::fs::metadata(&path).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return error(StatusCode::NOT_FOUND, "not_found", "不是文件"),
        Err(_) => return error(StatusCode::NOT_FOUND, "not_found", "文件不存在"),
    };
    match tokio::fs::File::open(&path).await {
        Ok(file) => (
            [
                (header::CONTENT_LENGTH, meta.len().to_string()),
                (header::CONTENT_TYPE, content_type(&q.path)),
                (header::CACHE_CONTROL, cache::cache_control(&q.path).to_string()),
            ],
            Body::from_stream(ReaderStream::new(file)),
        )
            .into_response(),
        Err(e) => io_error(e),
    }
}

fn content_type(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
    .into()
}

/// 只新建不覆盖：已存在 409。请求体即文件字节。
pub async fn write_new_file(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>, body: axum::body::Bytes) -> Response {
    if let Err(r) = ensure_space(&state) {
        return r;
    }
    let path = match resolve(&state, &user, &q.path) {
        Err(r) => return r,
        Ok(p) => p,
    };
    // 大请求：文件写入计入全局并发，阻塞 IO 在 spawn_blocking。
    let _permit = state.heavy().acquire().await;
    match blocking(move || store::write_new_file(&path, &body)).await {
        Ok(()) => StatusCode::CREATED.into_response(),
        Err(r) => r,
    }
}

pub async fn is_file(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    match resolve(&state, &user, &q.path) {
        Err(r) => r,
        Ok(path) => Json(blocking(move || Ok(path.is_file())).await.unwrap_or(false)).into_response(),
    }
}

pub async fn list_dir(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    let path = match resolve(&state, &user, &q.path) {
        Err(r) => return r,
        Ok(p) => p,
    };
    match blocking(move || {
        // 不跟随符号链接进目录。
        std::fs::read_dir(&path)?
            .filter_map(|e| e.ok())
            .map(|e| Ok(DirEntry { name: e.file_name().to_string_lossy().into_owned(), is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false) }))
            .collect::<std::io::Result<Vec<_>>>()
    })
    .await
    {
        Ok(mut entries) => {
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Json(entries).into_response()
        }
        Err(r) => r,
    }
}

pub async fn file_sha256(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    match resolve(&state, &user, &q.path) {
        Err(r) => r,
        Ok(path) => {
            let _permit = state.heavy().acquire().await;
            match blocking(move || crate::board_pack::sha256_file(&path)).await {
            Ok(sha) => Json(sha).into_response(),
            Err(r) => r,
            }
        }
    }
}

pub async fn inspect_image(State(state): State<AppState>, user: User, Query(q): Query<PathQuery>) -> Response {
    match resolve(&state, &user, &q.path) {
        Err(r) => r,
        Ok(path) => {
            let _permit = state.heavy().acquire().await;
            match blocking(move || crate::image_info::inspect(&path)).await {
            Ok(info) => Json(info).into_response(),
            Err(r) => r,
            }
        }
    }
}

#[derive(Deserialize)]
pub struct LogRequest {
    kind: String,
    #[serde(default)]
    fields: serde_json::Map<String, serde_json::Value>,
}

/// 前端日志按用户写进各自的元数据目录；事件类别白名单沿用 logger。
pub async fn log_event(State(state): State<AppState>, user: User, body: axum::body::Bytes) -> Response {
    let Ok(req) = serde_json::from_slice::<LogRequest>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "需要 kind 与 fields");
    };
    if !crate::logger::EVENT_KINDS.contains(&req.kind.as_str()) {
        return error(StatusCode::BAD_REQUEST, "bad_request", "未知事件类别");
    }
    let root = state.user_root(&user.fingerprint);
    let dir = root.join(META_DIR);
    let kind = req.kind.clone();
    let fields = req.fields.clone();
    match blocking(move || {
        std::fs::create_dir_all(&dir)?;
        crate::logger::Logger::new(dir, crate::VERSION).log(&kind, &fields).map_err(|e| std::io::Error::other(e))
    })
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(r) => r,
    }
}

/// 未匹配的 /api 路径：明确 404，不回退到 index.html。
pub async fn api_not_found() -> Response {
    error(StatusCode::NOT_FOUND, "not_found", "没有这个接口")
}
