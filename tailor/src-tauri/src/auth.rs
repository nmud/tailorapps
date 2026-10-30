//! Accounts. Sign-in, refresh and password reset talk to Supabase Auth directly; sign-up and
//! Muse calls go through Tailor's backend function. Tokens never reach the webview: the refresh
//! token lives in Windows Credential Manager and the access token only in memory.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::now_ms;

pub const SUPABASE_URL: &str = match option_env!("TAILOR_SUPABASE_URL") {
    Some(v) => v,
    None => "https://uwkphgzwwrzrjliphpnd.supabase.co",
};
/// Publishable (client-safe) key.
pub const PUBLISHABLE_KEY: &str = match option_env!("TAILOR_SUPABASE_KEY") {
    Some(v) => v,
    None => "sb_publishable_HKraMS49hxJCCKFIYvk-2A_hRSryxvf",
};

const OFFLINE: &str = "Can't reach Tailor. Check your internet connection and try again.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Debug, Clone)]
struct Session {
    access_token: String,
    refresh_token: String,
    /// unix ms
    expires_at: i64,
    user: User,
}

/// What we keep across restarts (small enough for Credential Manager).
#[derive(Serialize, Deserialize)]
struct Stored {
    refresh_token: String,
    user: User,
}

#[derive(Default)]
pub struct AuthState {
    session: Mutex<Option<Session>>,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("tailor", "session").map_err(|e| e.to_string())
}

fn load_stored() -> Option<Stored> {
    let raw = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_stored(s: &Session) {
    if let Ok(e) = entry() {
        let stored = Stored { refresh_token: s.refresh_token.clone(), user: s.user.clone() };
        let _ = e.set_password(&serde_json::to_string(&stored).unwrap_or_default());
    }
}

fn clear_stored() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

fn parse_session(v: &Value) -> Option<Session> {
    let access_token = v["access_token"].as_str()?.to_string();
    let refresh_token = v["refresh_token"].as_str()?.to_string();
    let expires_at = v["expires_at"]
        .as_i64()
        .map(|s| s * 1000)
        .or_else(|| v["expires_in"].as_i64().map(|s| now_ms() + s * 1000))
        .unwrap_or(now_ms() + 3_600_000);
    let u = &v["user"];
    let email = u["email"].as_str().unwrap_or_default().to_string();
    let name = u["user_metadata"]["name"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| email.split('@').next().unwrap_or("").to_string());
    Some(Session {
        access_token,
        refresh_token,
        expires_at,
        user: User { id: u["id"].as_str()?.to_string(), email, name },
    })
}

/// Turn an auth error response into words a person can act on.
fn friendly(status: u16, body: &Value) -> String {
    let code = body["error_code"].as_str().or_else(|| body["error"]["code"].as_str()).unwrap_or("");
    let msg = body["msg"]
        .as_str()
        .or_else(|| body["error_description"].as_str())
        .or_else(|| body["error"]["message"].as_str())
        .unwrap_or("");
    match code {
        "invalid_credentials" => "That email and password don't match.".into(),
        "otp_expired" | "otp_disabled" => "That code is wrong or has expired. Ask for a new one.".into(),
        "weak_password" => "Please choose a longer password (at least 8 characters).".into(),
        "over_request_rate_limit" | "over_email_send_rate_limit" => {
            "Too many tries. Please wait a few minutes and try again.".into()
        }
        _ if !msg.is_empty() && body["error"]["message"].is_string() => msg.into(),
        _ if status == 429 => "Too many tries. Please wait a few minutes and try again.".into(),
        _ => "Something went wrong. Please try again.".into(),
    }
}

async fn post(http: &reqwest::Client, url: &str, body: Value, bearer: Option<&str>) -> Result<Value, String> {
    let mut rb = http.post(url).header("apikey", PUBLISHABLE_KEY).json(&body);
    if let Some(t) = bearer {
        rb = rb.bearer_auth(t);
    }
    let resp = rb.send().await.map_err(|_| OFFLINE.to_string())?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status >= 400 {
        return Err(friendly(status, &v));
    }
    Ok(v)
}

impl AuthState {
    async fn set(&self, s: Session) -> User {
        save_stored(&s);
        let user = s.user.clone();
        *self.session.lock().await = Some(s);
        user
    }

    pub async fn login(&self, http: &reqwest::Client, email: &str, password: &str) -> Result<User, String> {
        let v = post(
            http,
            &format!("{SUPABASE_URL}/auth/v1/token?grant_type=password"),
            json!({ "email": email.trim().to_lowercase(), "password": password }),
            None,
        )
        .await?;
        let s = parse_session(&v).ok_or("Something went wrong. Please try again.")?;
        Ok(self.set(s).await)
    }

    pub async fn signup(&self, http: &reqwest::Client, name: &str, email: &str, password: &str) -> Result<User, String> {
        post(
            http,
            &format!("{SUPABASE_URL}/functions/v1/tailor/signup"),
            json!({ "name": name, "email": email, "password": password }),
            None,
        )
        .await?;
        self.login(http, email, password).await
    }

    async fn refresh_with(&self, http: &reqwest::Client, refresh_token: &str) -> Result<User, String> {
        let v = post(
            http,
            &format!("{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token"),
            json!({ "refresh_token": refresh_token }),
            None,
        )
        .await?;
        let s = parse_session(&v).ok_or("Please sign in again.")?;
        Ok(self.set(s).await)
    }

    /// The signed-in user, restoring the saved session on first call.
    /// Offline with a saved session: returns the saved user so the app still opens.
    pub async fn current(&self, http: &reqwest::Client) -> Option<User> {
        if let Some(s) = self.session.lock().await.as_ref() {
            return Some(s.user.clone());
        }
        let stored = load_stored()?;
        match self.refresh_with(http, &stored.refresh_token).await {
            Ok(u) => Some(u),
            Err(e) if e == OFFLINE => Some(stored.user),
            Err(_) => {
                clear_stored();
                None
            }
        }
    }

    /// A valid access token, refreshing it when it is about to expire.
    pub async fn access_token(&self, http: &reqwest::Client, force_refresh: bool) -> Result<String, String> {
        let (token, refresh, fresh) = {
            let guard = self.session.lock().await;
            match guard.as_ref() {
                Some(s) => (s.access_token.clone(), s.refresh_token.clone(), s.expires_at - now_ms() > 60_000),
                None => match load_stored() {
                    Some(st) => (String::new(), st.refresh_token, false),
                    None => return Err("Please sign in again.".into()),
                },
            }
        };
        if fresh && !force_refresh {
            return Ok(token);
        }
        match self.refresh_with(http, &refresh).await {
            Ok(_) => Ok(self.session.lock().await.as_ref().map(|s| s.access_token.clone()).unwrap_or_default()),
            Err(e) if e == OFFLINE => Err(e),
            Err(_) => {
                self.forget().await;
                Err("Please sign in again.".into())
            }
        }
    }

    pub async fn forget(&self) {
        *self.session.lock().await = None;
        clear_stored();
    }

    pub async fn logout(&self, http: &reqwest::Client) {
        let token = self.session.lock().await.as_ref().map(|s| s.access_token.clone());
        if let Some(t) = token {
            let _ = post(http, &format!("{SUPABASE_URL}/auth/v1/logout"), json!({}), Some(&t)).await;
        }
        self.forget().await;
    }

    pub async fn send_reset(&self, http: &reqwest::Client, email: &str) -> Result<(), String> {
        post(
            http,
            &format!("{SUPABASE_URL}/auth/v1/recover"),
            json!({ "email": email.trim().to_lowercase() }),
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn confirm_reset(&self, http: &reqwest::Client, email: &str, code: &str, password: &str) -> Result<User, String> {
        if password.chars().count() < 8 {
            return Err("Please choose a longer password (at least 8 characters).".into());
        }
        let v = post(
            http,
            &format!("{SUPABASE_URL}/auth/v1/verify"),
            json!({ "type": "recovery", "email": email.trim().to_lowercase(), "token": code.trim() }),
            None,
        )
        .await?;
        let s = parse_session(&v).ok_or("That code is wrong or has expired. Ask for a new one.")?;
        let token = s.access_token.clone();
        let req = http
            .put(format!("{SUPABASE_URL}/auth/v1/user"))
            .header("apikey", PUBLISHABLE_KEY)
            .bearer_auth(&token)
            .json(&json!({ "password": password }));
        let resp = req.send().await.map_err(|_| OFFLINE.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(friendly(status, &body));
        }
        Ok(self.set(s).await)
    }
}
