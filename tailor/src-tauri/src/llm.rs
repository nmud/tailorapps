//! Muse calls, made through Tailor's backend with the signed-in user's token. The backend
//! holds the Muse key and picks the model for each agent.

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::ipc::Channel;

use crate::AppState;
use crate::auth::{PUBLISHABLE_KEY, SUPABASE_URL};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// observer | designer | builder
    pub agent: String,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub response_format: Option<Value>,
    #[serde(default)]
    pub stream: bool,
    /// Send `false` to drop the reasoning setting if the model rejects it.
    #[serde(default)]
    pub reasoning: Option<bool>,
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n).collect::<String>()) }
}

fn content_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str().or_else(|| p.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Our backend's own errors carry a plain message; Muse errors are passed through as
/// "HTTP <status>: <body>" so the app can adapt (e.g. retry without structured output).
fn describe_error(status: u16, text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        if let (Some(code), Some(msg)) = (v["error"]["code"].as_str(), v["error"]["message"].as_str()) {
            if matches!(code, "signed_out" | "not_configured" | "daily_limit" | "too_large") {
                return msg.to_string();
            }
        }
    }
    format!("HTTP {status}: {}", truncate(text, 900))
}

async fn send(state: &AppState, req: &ChatRequest, force_refresh: bool) -> Result<reqwest::Response, String> {
    let mut body = json!({ "agent": req.agent, "messages": req.messages });
    if let Some(rf) = &req.response_format {
        body["response_format"] = rf.clone();
    }
    if req.stream {
        body["stream"] = json!(true);
    }
    if req.reasoning == Some(false) {
        body["reasoning"] = json!(false);
    }

    // Debug builds can point at a local OpenAI-compatible server for offline testing.
    #[cfg(debug_assertions)]
    if let Ok(dev) = std::env::var("TAILOR_DEV_LLM_URL") {
        body["model"] = json!(format!("dev-{}", req.agent));
        return state
            .http
            .post(format!("{}/chat/completions", dev.trim_end_matches('/')))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string());
    }

    let token = state.auth.access_token(&state.http, force_refresh).await?;
    state
        .http
        .post(format!("{SUPABASE_URL}/functions/v1/tailor/chat"))
        .header("apikey", PUBLISHABLE_KEY)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Can't reach Tailor. Check your internet connection and try again.".to_string())
}

pub async fn chat(state: &AppState, req: ChatRequest, on_delta: &Channel<String>) -> Result<String, String> {
    let mut resp = send(state, &req, false).await?;
    if resp.status().as_u16() == 401 {
        resp = send(state, &req, true).await?;
    }
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(describe_error(status.as_u16(), &text));
    }

    if !req.stream {
        let v: Value = resp.json().await.map_err(|_| "Something went wrong. Please try again.".to_string())?;
        if let Some(err) = v.get("error") {
            return Err(format!("HTTP 500: {}", truncate(&err.to_string(), 900)));
        }
        let msg = &v["choices"][0]["message"];
        if let Some(refusal) = msg["refusal"].as_str() {
            return Err(format!("The model declined: {refusal}"));
        }
        return Ok(content_text(&msg["content"]));
    }

    // Server-sent events. Buffer bytes, split on newlines, decode whole lines only.
    let mut out = String::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The connection dropped. Please try again.".to_string())?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(err) = v.get("error") {
                return Err(format!("HTTP 500: {}", truncate(&err.to_string(), 900)));
            }
            let delta = content_text(&v["choices"][0]["delta"]["content"]);
            if !delta.is_empty() {
                out.push_str(&delta);
                let _ = on_delta.send(delta);
            }
        }
    }
    Ok(out)
}
