//! 以密钥指纹为身份的用户、用户数据根与会话（ADR 0018）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::AppState;

pub const SESSION_COOKIE: &str = "kacha_session";
pub const SESSION_TTL: Duration = Duration::from_secs(7 * 86400);
pub const SESSION_TTL_SECS: u64 = 7 * 86400;

/// 密钥指纹 = 密钥原文的 SHA-256 小写十六进制；服务端只存指纹。
pub fn fingerprint(key: &str) -> String {
    Sha256::digest(key.trim().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Session>>,
    /// 每个会话上次落盘最后访问时间的时刻：读图等高频请求不必每次写盘。
    touched: Mutex<HashMap<String, SystemTime>>,
}

#[derive(Clone)]
struct Session {
    fingerprint: String,
    expires_at: SystemTime,
}

impl Sessions {
    fn issue(&self, fingerprint: String, now: SystemTime) -> String {
        let token = random_token();
        self.map.lock().unwrap().insert(token.clone(), Session { fingerprint, expires_at: now + SESSION_TTL });
        token
    }

    fn lookup(&self, token: &str, now: SystemTime) -> Option<String> {
        let mut map = self.map.lock().unwrap();
        match map.get(token) {
            Some(s) if s.expires_at > now => Some(s.fingerprint.clone()),
            Some(_) => {
                map.remove(token);
                None
            }
            None => None,
        }
    }

    fn revoke(&self, token: &str) {
        self.map.lock().unwrap().remove(token);
    }
}

/// 16 字节系统熵的十六进制；浏览器侧拿不到 randomUUID，服务端照常可以。
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("系统随机数不可用");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 用户数据根下的元数据：指纹 + 最后访问时间，供清理判断闲置用户。
#[derive(Serialize, Deserialize)]
pub struct UserMeta {
    pub fingerprint: String,
    pub last_access_at: u64,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub key: String,
}

pub fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(serde_json::json!({ "code": code, "message": message }))).into_response()
}

pub async fn login(state: &AppState, body: &[u8]) -> Response {
    let Ok(req) = serde_json::from_slice::<LoginRequest>(body) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "请求体需要 { \"key\": \"<new-api API 密钥>\" }");
    };
    let key = req.key.trim();
    if key.is_empty() {
        return error(StatusCode::BAD_REQUEST, "bad_request", "请粘贴 new-api API 密钥");
    }
    match state.verifier().verify(key).await {
        crate::KeyCheck::Invalid => return error(StatusCode::UNAUTHORIZED, "invalid_key", "网关拒绝了这把密钥，请检查是否粘贴完整、是否已停用"),
        crate::KeyCheck::Unavailable(detail) => {
            return error(StatusCode::SERVICE_UNAVAILABLE, "gateway_unavailable", &format!("无法连接网关验证密钥（{detail}），这不是密钥问题，请稍后重试"))
        }
        crate::KeyCheck::Valid => {}
    }
    let fp = fingerprint(key);
    let now = state.now();
    let root = state.user_root(&fp);
    if let Err(e) = std::fs::create_dir_all(root.join(crate::META_DIR)) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &format!("建立用户数据根失败：{e}"));
    }
    if let Err(e) = touch_access(&root, &fp, now) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &format!("记录用户信息失败：{e}"));
    }
    let token = state.sessions().issue(fp.clone(), now);
    let cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL_SECS}"
    );
    (
        [(header::SET_COOKIE, cookie)],
        Json(serde_json::json!({ "fingerprint": fp })),
    )
        .into_response()
}

pub fn logout(state: &AppState, headers: &HeaderMap) -> Response {
    if let Some(token) = session_token(headers) {
        state.sessions().revoke(&token);
    }
    (
        [(header::SET_COOKIE, format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"))],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

/// 最后访问时间的落盘节流：5 分钟内的重复访问不重复写。
const ACCESS_TOUCH_INTERVAL: Duration = Duration::from_secs(300);

/// 带会话访问时的身份；同时按节流更新最后访问时间。
pub fn current_user(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = session_token(headers)?;
    let now = state.now();
    let fp = state.sessions().lookup(&token, now)?;
    let due = {
        let mut touched = state.sessions().touched.lock().unwrap();
        match touched.get(&token) {
            Some(last) if now.duration_since(*last).unwrap_or_default() < ACCESS_TOUCH_INTERVAL => false,
            _ => {
                touched.insert(token, now);
                true
            }
        }
    };
    if due {
        let root = state.user_root(&fp);
        let _ = touch_access(&root, &fp, now);
    }
    Some(fp)
}

pub fn touch_access(root: &std::path::Path, fp: &str, now: SystemTime) -> std::io::Result<()> {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let meta = UserMeta { fingerprint: fp.to_string(), last_access_at: secs };
    crate::store::atomic_write(&root.join(crate::META_DIR).join("user.json"), serde_json::to_string_pretty(&meta).unwrap().as_bytes())
}

pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).flat_map(|v| v.split(';')).find_map(|part| {
        let part = part.trim();
        part.strip_prefix(&format!("{SESSION_COOKIE}=")).map(|v| v.trim().to_string())
    })
}
