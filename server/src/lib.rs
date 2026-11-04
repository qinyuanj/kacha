//! Kacha 服务端：单进程托管前端静态文件与 API（ADR 0018）。

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::SystemTime;

use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};

pub mod board_pack;
pub mod fs;
pub mod image_info;
pub mod logger;
pub mod paths;
pub mod redact;
pub mod relay;
mod session;
pub mod store;
pub mod transfer;
pub mod verify;

pub use session::{fingerprint, SESSION_COOKIE};

/// 设置、界面状态、模型缓存与日志放在用户数据根下的元数据目录，不混进画板与任务目录。
pub const META_DIR: &str = ".kacha";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

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
}

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
}

impl AppState {
    pub fn new(config: Config, verifier: Arc<dyn KeyVerifier>, clock: Clock) -> Self {
        AppState { inner: Arc::new(Inner { config, verifier, clock, sessions: session::Sessions::default(), board_lock: tokio::sync::Mutex::new(()) }) }
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
        .route("/api/boards", get(fs::read_board).put(fs::write_board))
        .route("/api/boards/rename", axum::routing::post(fs::rename_board))
        .route("/api/boards/names", get(fs::list_board_names))
        .route("/api/fs/file", get(fs::read_file).put(fs::write_new_file))
        .route("/api/fs/dir", get(fs::list_dir))
        .route("/api/fs/is-file", get(fs::is_file))
        .route("/api/fs/sha256", get(fs::file_sha256))
        .route("/api/fs/inspect-image", get(fs::inspect_image))
        .route("/api/fs/relay", axum::routing::post(relay::relay).delete(relay::discard))
        .route("/api/fs/relay/commit", axum::routing::post(relay::commit))
        .merge(transfer::routes())
        .route("/api/log", axum::routing::post(fs::log_event))
        .route("/api/{*rest}", axum::routing::any(api_fallback))
        .fallback_service(static_service(&state))
        .with_state(state)
}

async fn api_fallback() -> axum::response::Response {
    fs::api_not_found().await
}

/// 前端静态文件 + CSP。桌面版 CSP 在 tauri.conf.json，Web 版由服务端下发；
/// connect-src 必须放行浏览器直连的网关地址。
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
