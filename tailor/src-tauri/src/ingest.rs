//! Local endpoint for the browser extension. Only the Tailor add-on may call it: its fixed ID
//! (from the `key` in its manifest), the `x-tailor-client` header (which forces a CORS preflight
//! that web pages fail), and this exact address (so DNS-rebinding pages are refused).

use axum::extract::State;
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::db::Event;
use crate::{INGEST_PORT, Shared, now_ms, record_events};

#[derive(Clone)]
struct Ctx {
    state: Shared,
    app: AppHandle,
}

#[derive(Deserialize)]
struct Batch {
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveTab {
    #[serde(default)]
    title: Option<String>,
    url: String,
    #[serde(default)]
    window_id: i64,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    last_accessed: f64,
}

#[derive(Deserialize)]
struct TabsSnapshot {
    tabs: Vec<LiveTab>,
}

/// The Tailor add-on in Chrome and Edge. Its ID comes from the `key` in extension/manifest.json.
const EXTENSION_ORIGIN: &str = "chrome-extension://lenfcjijjcpojhgolcdhchipmabbdoha";

fn is_extension_origin(origin: &str) -> bool {
    origin == EXTENSION_ORIGIN
}

fn host_ok(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    host == format!("127.0.0.1:{INGEST_PORT}") || host == format!("localhost:{INGEST_PORT}")
}

fn authorized(headers: &HeaderMap) -> bool {
    let client_ok = headers
        .get("x-tailor-client")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "extension")
        .unwrap_or(false);
    let origin_ok = match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(o) => is_extension_origin(o),
        None => true,
    };
    client_ok && origin_ok && host_ok(headers)
}

pub async fn serve(state: Shared, app: AppHandle) {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.to_str().map(is_extension_origin).unwrap_or(false)
        }))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, HeaderName::from_static("x-tailor-client")]);

    let router = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/events", post(events))
        .route("/v1/tabs", post(tabs))
        .layer(cors)
        .with_state(Ctx { state, app });

    match tokio::net::TcpListener::bind(("127.0.0.1", INGEST_PORT)).await {
        Ok(listener) => {
            let _ = axum::serve(listener, router).await;
        }
        Err(e) => eprintln!("tailor: ingest port {INGEST_PORT} unavailable: {e}"),
    }
}

fn learning_view(ctx: &Ctx) -> Value {
    let cfg = ctx.state.learning.read().unwrap();
    json!({
        "app": "tailor",
        "version": env!("CARGO_PKG_VERSION"),
        "learning": cfg.enabled && cfg.extension,
        "includeSearchTerms": cfg.include_search_terms,
        "includePaths": cfg.include_paths,
        "denyDomains": cfg.deny_domains,
    })
}

async fn status(State(ctx): State<Ctx>, headers: HeaderMap) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    ctx.state.extension_last_seen.store(now_ms(), Ordering::Relaxed);
    Ok(Json(learning_view(&ctx)))
}

async fn events(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    ctx.state.extension_last_seen.store(now_ms(), Ordering::Relaxed);
    let (enabled, extension) = {
        let cfg = ctx.state.learning.read().unwrap();
        (cfg.enabled, cfg.extension)
    };
    let mut accepted = 0;
    if enabled && extension {
        let now = now_ms();
        let events: Vec<Event> = batch
            .events
            .into_iter()
            .take(500)
            .filter(|e| e.ts > now - 7 * 86_400_000 && e.ts <= now + 60_000)
            .map(|mut e| {
                e.source = "extension".into();
                e.id = 0;
                e
            })
            .collect();
        accepted = record_events(&ctx.state, &ctx.app, events);
    }
    let mut view = learning_view(&ctx);
    view["accepted"] = json!(accepted);
    Ok(Json(view))
}

/// The tabs open right now. Held in memory only, for apps the person allowed to see them.
async fn tabs(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    Json(snapshot): Json<TabsSnapshot>,
) -> Result<Json<Value>, StatusCode> {
    if !authorized(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let now = now_ms();
    ctx.state.extension_last_seen.store(now, Ordering::Relaxed);
    let mut cfg = ctx.state.learning.read().unwrap().clone();
    if !(cfg.enabled && cfg.extension) {
        *ctx.state.live_tabs.write().unwrap() = (0, vec![]);
        return Ok(Json(learning_view(&ctx)));
    }
    // Live tabs aren't stored, so keep addresses (minus query strings) for reopening them.
    cfg.include_paths = true;
    let live: Vec<Value> = snapshot
        .tabs
        .into_iter()
        .take(500)
        .filter_map(|t| {
            let host = reqwest::Url::parse(&t.url).ok()?.host_str()?.to_string();
            let ev = crate::privacy::sanitize(
                Event {
                    ts: now,
                    kind: "focus".into(),
                    domain: Some(host),
                    title: t.title,
                    url: Some(t.url),
                    ..Default::default()
                },
                &cfg,
            )?;
            Some(json!({
                "title": ev.title,
                "url": ev.url,
                "domain": ev.domain,
                "windowId": t.window_id,
                "active": t.active,
                "lastAccessed": t.last_accessed as i64,
            }))
        })
        .collect();
    *ctx.state.live_tabs.write().unwrap() = (now, live);
    Ok(Json(learning_view(&ctx)))
}
