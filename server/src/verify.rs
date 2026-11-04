//! 用 new-api 网关的令牌用量接口验证密钥：读得到令牌即有效，读不到（401）即无效。

use std::future::Future;
use std::pin::Pin;

use crate::{KeyCheck, KeyVerifier};

pub struct HttpKeyVerifier {
    base_url: String,
    client: reqwest::Client,
}

impl HttpKeyVerifier {
    pub fn new(base_url: String) -> Self {
        HttpKeyVerifier {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().expect("HTTP 客户端"),
        }
    }
}

impl KeyVerifier for HttpKeyVerifier {
    fn verify<'a>(&'a self, key: &'a str) -> Pin<Box<dyn Future<Output = KeyCheck> + Send + 'a>> {
        Box::pin(async move {
            let url = format!("{}/api/usage/token", self.base_url);
            match self.client.get(&url).bearer_auth(key).send().await {
                Ok(res) if res.status().is_success() => KeyCheck::Valid,
                Ok(res) if res.status() == reqwest::StatusCode::UNAUTHORIZED || res.status() == reqwest::StatusCode::FORBIDDEN => KeyCheck::Invalid,
                Ok(res) => KeyCheck::Unavailable(format!("网关返回 HTTP {}", res.status())),
                Err(e) => KeyCheck::Unavailable(e.to_string()),
            }
        })
    }
}
