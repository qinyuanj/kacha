//! 进程内调用 axum router 的测试工具：临时数据根、可拨的时钟、伪网关。
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use kacha_server::{router, AppState, Config, KeyCheck, KeyVerifier};
use tower::ServiceExt;

pub const GOOD_KEY: &str = "sk-good-key";
pub const OTHER_KEY: &str = "sk-other-key";
pub const BAD_KEY: &str = "sk-bad-key";
/// 伪网关对这把密钥报「服务不可用」。
pub const OUTAGE_KEY: &str = "sk-outage";

struct FakeGateway;

impl KeyVerifier for FakeGateway {
    fn verify<'a>(&'a self, key: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = KeyCheck> + Send + 'a>> {
        Box::pin(async move {
            match key {
                GOOD_KEY | OTHER_KEY => KeyCheck::Valid,
                OUTAGE_KEY => KeyCheck::Unavailable("网关返回 HTTP 503".into()),
                _ => KeyCheck::Invalid,
            }
        })
    }
}

pub struct Harness {
    pub dir: tempfile::TempDir,
    pub app: Router,
    now: Arc<Mutex<SystemTime>>,
    result_hosts: Vec<String>,
    free_space: Option<u64>,
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|_| panic!("不是 JSON：{}", self.text()))
    }
    /// Set-Cookie 里的 `name=value` 部分，供后续请求带上。
    pub fn cookie(&self) -> String {
        let raw = self.headers.get(header::SET_COOKIE).expect("没有 Set-Cookie").to_str().unwrap();
        raw.split(';').next().unwrap().to_string()
    }
}

impl Harness {
    pub fn new() -> Self {
        Self::with_result_hosts(Vec::new())
    }

    pub fn with_result_hosts(result_hosts: Vec<String>) -> Self {
        Self::build(result_hosts, None)
    }

    /// 注入固定磁盘余量（None = 读真实文件系统）。
    pub fn with_free_space(free_space: Option<u64>) -> Self {
        Self::build(Vec::new(), free_space)
    }

    fn build(result_hosts: Vec<String>, free_space: Option<u64>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let now = Arc::new(Mutex::new(UNIX_EPOCH + Duration::from_secs(1_800_000_000)));
        let app = Self::app(dir.path(), &now, &result_hosts, free_space);
        Harness { dir, app, now, result_hosts, free_space }
    }

    fn app(data_root: &Path, now: &Arc<Mutex<SystemTime>>, result_hosts: &[String], free_space: Option<u64>) -> Router {
        let clock_now = now.clone();
        let config = Config {
            data_root: data_root.to_path_buf(),
            gateway_url: "http://gateway.test".into(),
            static_dir: None,
            result_hosts: result_hosts.to_vec(),
            min_free_bytes: kacha_server::limits::DEFAULT_MIN_FREE_BYTES,
        };
        let clock: kacha_server::Clock = Arc::new(move || *clock_now.lock().unwrap());
        let state = match free_space {
            Some(bytes) => AppState::with_free_space(config, Arc::new(FakeGateway), clock, Arc::new(move || Ok(bytes))),
            None => AppState::new(config, Arc::new(FakeGateway), clock),
        };
        router(state)
    }

    /// 模拟服务端重启：丢弃全部进程内状态，只留下数据根。
    pub fn restart(&mut self) {
        self.app = Self::app(self.dir.path(), &self.now, &self.result_hosts, self.free_space);
    }

    pub fn data_root(&self) -> &Path {
        self.dir.path()
    }

    pub fn advance(&self, by: Duration) {
        *self.now.lock().unwrap() += by;
    }

    pub fn now(&self) -> SystemTime {
        *self.now.lock().unwrap()
    }

    pub fn now_secs(&self) -> u64 {
        self.now.lock().unwrap().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    pub async fn send(&self, method: Method, uri: &str, cookie: Option<&str>, body: impl Into<Body>) -> Reply {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let res = self.app.clone().oneshot(req.body(body.into()).unwrap()).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply { status, headers, body }
    }

    pub async fn get(&self, uri: &str, cookie: Option<&str>) -> Reply {
        self.send(Method::GET, uri, cookie, Body::empty()).await
    }

    pub async fn put(&self, uri: &str, cookie: &str, body: impl Into<Body>) -> Reply {
        self.send(Method::PUT, uri, Some(cookie), body).await
    }

    pub async fn login(&self, key: &str) -> Reply {
        self.send(Method::POST, "/api/session", None, serde_json::json!({ "key": key }).to_string()).await
    }

    /// 登录并返回会话 cookie。
    pub async fn session(&self, key: &str) -> String {
        let reply = self.login(key).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
        reply.cookie()
    }

    pub fn user_root(&self, key: &str) -> PathBuf {
        self.data_root().join("users").join(fingerprint(key))
    }
}

/// 密钥的 SHA-256（小写十六进制）。期望值独立于实现计算。
pub fn fingerprint(key: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// URL 查询参数编码（路径参数含中文、斜杠等）。
pub fn q(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// 用户元数据文件位置。
pub fn meta_path(root: &Path) -> PathBuf {
    root.join(".kacha").join("user.json")
}
