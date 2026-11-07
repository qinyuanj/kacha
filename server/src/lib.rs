//! Kacha 服务端：单进程托管前端静态文件与 API（ADR 0018）。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};

pub mod board_list;
pub mod board_measure;
pub mod board_pack;
pub mod cache;
mod civil;
pub mod cleanup;
pub mod fs;
pub mod image_info;
pub mod launch;
pub mod limits;
pub mod logger;
pub mod pack_staging;
pub mod packs;
pub mod paths;
pub mod redact;
pub mod references;
pub mod relay;
pub mod serve;
pub mod server_log;
mod session;
pub mod store;
pub mod thumbs;
pub mod transfer;
pub mod usage;
pub mod usage_log;
pub mod verify;
#[cfg(windows)]
pub mod win_service;

pub use session::{fingerprint, SESSION_COOKIE};

/// 设置、界面状态、模型缓存与日志放在用户数据根下的元数据目录，不混进画板与任务目录。
pub const META_DIR: &str = ".kacha";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 单文件请求体上限：64 MB；画板包单份内容、图片上传、中转结果同用这一个数。
/// client 的 core/boardPack.ts `MAX_CONTENT_BYTES` 是它的跨语言副本，改一处要同改另一处。
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// 413 文案里的上限，如「64 MB」。
pub fn max_body_label() -> String {
    format!("{} MB", MAX_BODY_BYTES / (1024 * 1024))
}

#[derive(Clone, Debug)]
pub struct Config {
    /// 数据根：其下 `users/<指纹>/` 是各用户数据根。
    pub data_root: PathBuf,
    /// new-api 网关地址：服务端用它验证密钥，也下发给浏览器直接调用。
    pub gateway_url: String,
    /// 前端静态文件目录（vite 构建产物）；None 时只提供 API。
    pub static_dir: Option<PathBuf>,
    /// 结果中转额外允许的主机（默认列表之外，部署可追加；见 relay::default_result_hosts）。
    pub result_hosts: Vec<String>,
    /// 剩余磁盘低于该值时写入类接口返回 507（默认 20 GB）。
    pub min_free_bytes: u64,
    /// 画板位数量（ADR 0019，默认 10）：每人可同时持有的可编辑画板数。
    pub board_slots: u32,
    /// 画板体量提醒线（默认 500 MiB 黄、1 GiB 红）：只提醒、不阻止生成。
    pub board_size_lines: BoardSizeLines,
    /// 用量上限与提醒比例（默认上限留空即不提醒、80% 黄）：只提醒、不阻止生成（#88）。
    pub usage_limit: UsageLimit,
}

pub use board_list::BoardSizeLines;
pub use usage::UsageLimit;

/// 网关对一把密钥的结论。Unavailable 是服务故障，不能当成密钥无效。
#[derive(Debug, Clone, PartialEq)]
pub enum KeyCheck {
    Valid,
    Invalid,
    Unavailable(String),
}

pub trait KeyVerifier: Send + Sync {
    fn verify<'a>(&'a self, key: &'a str) -> Pin<Box<dyn Future<Output = KeyCheck> + Send + 'a>>;
}

pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    config: Config,
    verifier: Arc<dyn KeyVerifier>,
    clock: Clock,
    sessions: session::Sessions,
    /// 画板读-比较-写与改名的互斥：版本校验必须整体串行，否则两页同时写都通过。
    board_lock: tokio::sync::Mutex<()>,
    /// 全局大请求并发上限（文件写入、结果图下载、SHA、图片解析、缩略图生成、读画板包内容、画板包导入导出；画板包上传不占）。
    heavy: limits::HeavyGate,
    /// 磁盘余量守卫：写入类接口余量不足返回 507。
    disk: limits::DiskGuard,
    /// 画板包操作的取消标记与进度，按 (用户, 操作 id) 隔离。
    pack_ops: Arc<packs::PackOps>,
}

impl AppState {
    /// 生产装配：磁盘余量读数据根所在的文件系统。
    pub fn new(config: Config, verifier: Arc<dyn KeyVerifier>, clock: Clock) -> Self {
        let root = config.data_root.clone();
        Self::with_free_space(config, verifier, clock, Arc::new(move || limits::filesystem_free_space(&root)))
    }

    /// 磁盘余量探针可注入：测试不必真的填满磁盘。
    pub fn with_free_space(config: Config, verifier: Arc<dyn KeyVerifier>, clock: Clock, free_space: limits::FreeSpace) -> Self {
        let sessions = session::Sessions::load(&config.data_root, clock());
        AppState {
            inner: Arc::new(Inner {
                disk: limits::DiskGuard::new(free_space, config.min_free_bytes),
                config,
                verifier,
                clock,
                sessions,
                board_lock: tokio::sync::Mutex::new(()),
                heavy: limits::HeavyGate::default(),
                pack_ops: Arc::new(packs::PackOps::default()),
            }),
        }
    }

    pub fn heavy(&self) -> &limits::HeavyGate {
        &self.inner.heavy
    }

    pub fn disk_guard(&self) -> &limits::DiskGuard {
        &self.inner.disk
    }

    pub fn pack_ops(&self) -> &Arc<packs::PackOps> {
        &self.inner.pack_ops
    }

    pub fn board_lock(&self) -> &tokio::sync::Mutex<()> {
        &self.inner.board_lock
    }

    pub fn verifier(&self) -> &Arc<dyn KeyVerifier> {
        &self.inner.verifier
    }

    pub fn sessions(&self) -> &session::Sessions {
        &self.inner.sessions
    }

    pub fn now(&self) -> SystemTime {
        (self.inner.clock)()
    }

    pub fn data_root(&self) -> PathBuf {
        self.inner.config.data_root.clone()
    }

    /// 某指纹对应的用户数据根（不保证存在）。
    pub fn user_root(&self, fingerprint: &str) -> PathBuf {
        self.inner.config.data_root.join("users").join(fingerprint)
    }

    pub fn static_dir(&self) -> Option<&PathBuf> {
        self.inner.config.static_dir.as_ref()
    }

    pub fn result_hosts(&self) -> &[String] {
        &self.inner.config.result_hosts
    }

    pub fn board_slots(&self) -> u32 {
        self.inner.config.board_slots
    }

    pub fn board_size_lines(&self) -> BoardSizeLines {
        self.inner.config.board_size_lines
    }

    pub fn usage_limit(&self) -> UsageLimit {
        self.inner.config.usage_limit
    }
}

async fn config(axum::extract::State(state): axum::extract::State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "version": VERSION, "gateway_url": state.inner.config.gateway_url }))
}

/// 会话身份（登录接口之外的全部接口都要过）。
#[derive(Clone)]
pub struct User {
    pub fingerprint: String,
}

impl axum::extract::FromRequestParts<AppState> for User {
    type Rejection = axum::response::Response;

    async fn from_request_parts(parts: &mut axum::http::request::Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let state = axum::extract::State::<AppState>::from_request_parts(parts, state).await.map_err(|e| e.into_response())?;
        match session::current_user(&state, &parts.headers) {
            Some(fingerprint) => Ok(User { fingerprint }),
            None => Err(session::error(axum::http::StatusCode::UNAUTHORIZED, "unauthenticated", "会话已失效，请重新粘贴 API 密钥")),
        }
    }
}

use axum::response::IntoResponse;

async fn login(axum::extract::State(state): axum::extract::State<AppState>, body: axum::body::Bytes) -> axum::response::Response {
    session::login(&state, &body).await
}

async fn session_info(axum::extract::State(_state): axum::extract::State<AppState>, user: User) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "fingerprint": user.fingerprint }))
}

async fn logout(axum::extract::State(state): axum::extract::State<AppState>, headers: HeaderMap) -> axum::response::Response {
    session::logout(&state, &headers)
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/config", get(config))
        .route("/api/session", get(session_info).post(login).delete(logout))
        .route("/api/settings", get(fs::read_settings).put(fs::write_settings))
        .route("/api/ui-state", get(fs::read_ui_state).put(fs::write_ui_state))
        .route("/api/models-cache", get(fs::read_models_cache).put(fs::write_models_cache))
        .route("/api/capability-override", get(fs::read_capability_override))
        .route("/api/boards", get(fs::read_board).put(fs::write_board).delete(fs::delete_board))
        .route("/api/boards/rename", axum::routing::post(fs::rename_board))
        .route("/api/boards/names", get(fs::list_board_names))
        .route("/api/boards/list", get(board_list::list_boards))
        .route("/api/boards/measure", axum::routing::post(board_measure::measure_board))
        .route("/api/fs/file", get(fs::read_file).put(fs::write_new_file))
        .route("/api/fs/thumb", get(thumbs::read_thumb))
        .route("/api/fs/dir", get(fs::list_dir))
        .route("/api/fs/is-file", get(fs::is_file))
        .route("/api/fs/sha256", get(fs::file_sha256))
        .route("/api/fs/inspect-image", get(fs::inspect_image))
        .route("/api/fs/relay", axum::routing::post(relay::relay).delete(relay::discard))
        .route("/api/fs/relay/commit", axum::routing::post(relay::commit))
        .merge(transfer::routes())
        .route("/api/usage", get(usage::usage))
        .route("/api/cleanup/unreferenced", axum::routing::post(usage::cleanup_unreferenced))
        .route("/api/log", axum::routing::post(fs::log_event))
        // 画板包：导出为下载流；导入先流式上传（不受单文件 64 MB 限制），再判定、合并。
        .route("/api/packs/export", axum::routing::post(packs::export))
        .route("/api/packs/export/facts", axum::routing::post(packs::export_facts))
        .route("/api/packs/uploads", axum::routing::post(packs::upload).layer(axum::extract::DefaultBodyLimit::disable()))
        .route("/api/packs/uploads/{id}/entries", get(packs::upload_entries))
        .route("/api/packs/uploads/{id}/texts", axum::routing::post(packs::upload_texts))
        .route("/api/packs/uploads/{id}/import", axum::routing::post(packs::import))
        .route("/api/packs/uploads/{id}", axum::routing::delete(packs::discard_upload))
        // 去重上传（#62）：问已有 → 开暂存 → 逐份上传缺少的内容（流式，单份 64 MB 上限由接口自己守）→ 按落盘清单合并。
        .route("/api/packs/existing", axum::routing::post(packs::existing))
        .route("/api/packs/staging", axum::routing::post(packs::open_staging))
        .route("/api/packs/staging/{id}", axum::routing::delete(packs::discard_staging))
        .route("/api/packs/staging/{id}/contents/{sha256}", axum::routing::put(packs::put_content).layer(axum::extract::DefaultBodyLimit::disable()))
        .route("/api/packs/staging/{id}/import", axum::routing::post(packs::import_staging))
        .route("/api/packs/ops/{op}", get(packs::op_progress))
        .route("/api/packs/ops/{op}/cancel", axum::routing::post(packs::op_cancel))
        .route("/api/{*rest}", axum::routing::any(api_fallback))
        // 单文件请求体上限（ADR 0018）：超过 413；画板包上传走单独的流式路径，不受此限。
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .fallback_service(static_service(&state))
        .with_state(state)
}

async fn api_fallback() -> axum::response::Response {
    fs::api_not_found().await
}

/// 前端静态文件 + CSP；connect-src 必须放行浏览器直连的网关地址。
fn static_service(
    state: &AppState,
) -> tower_http::set_header::SetResponseHeader<tower_http::services::ServeDir, axum::http::HeaderValue> {
    let gateway = state.inner.config.gateway_url.clone();
    let dir = state.static_dir().cloned().unwrap_or_else(|| PathBuf::from("."));
    let csp = format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' {gateway}; object-src 'none'; base-uri 'none'; form-action 'none'"
    );
    let inner = tower_http::services::ServeDir::new(dir).append_index_html_on_directories(true);
    tower_http::set_header::SetResponseHeader::overriding(inner, axum::http::header::CONTENT_SECURITY_POLICY, axum::http::HeaderValue::from_str(&csp).unwrap())
}
