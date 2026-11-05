//! 以密钥指纹为身份的用户、用户数据根与会话（ADR 0018）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// 密钥指纹 = 密钥原文的 SHA-256 小写十六进制；服务端只存指纹。
pub fn fingerprint(key: &str) -> String {
    sha256_hex(key.trim())
}

/// 数据根下的会话文件：只含令牌哈希、指纹与过期时间。拿到它也换不出可用的 cookie，更没有密钥。
const SESSIONS_FILE: &str = "sessions.json";
const SESSIONS_FORMAT_VERSION: u32 = 1;

/// 会话表：内存为工作副本，每次发放与作废都整表原子落盘，服务重启后会话仍有效。
/// 表项以令牌哈希为键（令牌是 128 位随机数，不需要加盐）。
pub struct Sessions {
    file: PathBuf,
    map: Mutex<HashMap<String, Session>>,
    /// 每个会话上次落盘最后访问时间的时刻：读图等高频请求不必每次写盘。
    touched: Mutex<HashMap<String, SystemTime>>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    fingerprint: String,
    #[serde(with = "unix_secs")]
    expires_at: SystemTime,
}

mod unix_secs {
    use super::*;
    use serde::{Deserializer, Serializer};

    pub fn serialize<S: Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<SystemTime, D::Error> {
        Ok(UNIX_EPOCH + Duration::from_secs(u64::deserialize(d)?))
    }
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    token_sha256: String,
    #[serde(flatten)]
    session: Session,
}

#[derive(Serialize, Deserialize)]
struct SavedSessions {
    format_version: u32,
    sessions: Vec<SavedSession>,
}

impl Sessions {
    /// 读回未过期的会话。文件缺失是首次启动；损坏或版本更高时不阻止服务启动，
    /// 代价只是用户重新粘贴一次密钥（密钥在浏览器里，不丢数据）。
    pub fn load(data_root: &Path, now: SystemTime) -> Self {
        let file = data_root.join(SESSIONS_FILE);
        let map = match std::fs::read(&file) {
            Ok(bytes) => match serde_json::from_slice::<SavedSessions>(&bytes) {
                Ok(saved) if saved.format_version <= SESSIONS_FORMAT_VERSION => {
                    saved.sessions.into_iter().filter(|s| s.session.expires_at > now).map(|s| (s.token_sha256, s.session)).collect()
                }
                Ok(saved) => {
                    eprintln!("[kacha] {} 版本 {} 高于本程序，已有会话作废", file.display(), saved.format_version);
                    HashMap::new()
                }
                Err(e) => {
                    eprintln!("[kacha] {} 无法解析（{e}），已有会话作废", file.display());
                    HashMap::new()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => {
                eprintln!("[kacha] 读取 {} 失败（{e}），已有会话作废", file.display());
                HashMap::new()
            }
        };
        Sessions { file, map: Mutex::new(map), touched: Mutex::default() }
    }

    /// 调用方持有 map 的锁，落盘顺序因此与内存变更一致。
    fn save(&self, map: &HashMap<String, Session>) -> std::io::Result<()> {
        let sessions = map.iter().map(|(hash, s)| SavedSession { token_sha256: hash.clone(), session: s.clone() }).collect();
        let text = serde_json::to_string_pretty(&SavedSessions { format_version: SESSIONS_FORMAT_VERSION, sessions }).map_err(std::io::Error::other)?;
        crate::store::atomic_write(&self.file, text.as_bytes())
    }

    /// 落盘失败即发放失败：否则这个会话重启后会无声消失。
    fn issue(&self, fingerprint: String, now: SystemTime) -> std::io::Result<String> {
        let token = random_token();
        let hash = sha256_hex(&token);
        let mut map = self.map.lock().unwrap();
        map.retain(|_, s| s.expires_at > now);
        map.insert(hash.clone(), Session { fingerprint, expires_at: now + SESSION_TTL });
        if let Err(e) = self.save(&map) {
            map.remove(&hash);
            return Err(e);
        }
        self.touched.lock().unwrap().retain(|k, _| map.contains_key(k));
        Ok(token)
    }

    /// 过期表项只从内存摘掉：过期时间已在文件里，读回时同样失效，下次发放时一并清出文件。
    fn lookup(&self, token: &str, now: SystemTime) -> Option<String> {
        let hash = sha256_hex(token);
        let mut map = self.map.lock().unwrap();
        match map.get(&hash) {
            Some(s) if s.expires_at > now => Some(s.fingerprint.clone()),
            Some(_) => {
                map.remove(&hash);
                None
            }
            None => None,
        }
    }

    /// 落盘失败时内存里已作废，但重启后会复活，必须告知调用方。
    fn revoke(&self, token: &str) -> std::io::Result<()> {
        let hash = sha256_hex(token);
        let mut map = self.map.lock().unwrap();
        self.touched.lock().unwrap().remove(&hash);
        if map.remove(&hash).is_none() {
            return Ok(());
        }
        self.save(&map)
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
    let token = match state.sessions().issue(fp.clone(), now) {
        Ok(token) => token,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "io", &format!("保存会话失败：{e}")),
    };
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
    let saved = session_token(headers).map_or(Ok(()), |token| state.sessions().revoke(&token));
    let cookie = [(header::SET_COOKIE, format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"))];
    match saved {
        Ok(()) => (cookie, StatusCode::NO_CONTENT).into_response(),
        Err(e) => (cookie, error(StatusCode::INTERNAL_SERVER_ERROR, "io", &format!("保存会话失败：{e}"))).into_response(),
    }
}

/// 最后访问时间的落盘节流：5 分钟内的重复访问不重复写。
const ACCESS_TOUCH_INTERVAL: Duration = Duration::from_secs(300);

/// 带会话访问时的身份；同时按节流更新最后访问时间。
pub fn current_user(state: &AppState, headers: &HeaderMap) -> Option<String> {
    let token = session_token(headers)?;
    let now = state.now();
    let fp = state.sessions().lookup(&token, now)?;
    let due = {
        let hash = sha256_hex(&token);
        let mut touched = state.sessions().touched.lock().unwrap();
        match touched.get(&hash) {
            Some(last) if now.duration_since(*last).unwrap_or_default() < ACCESS_TOUCH_INTERVAL => false,
            _ => {
                touched.insert(hash, now);
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
