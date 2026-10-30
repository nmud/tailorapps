//! Serves each generated app from its own origin: `http://<slug>.localhost:48100`.
//! Separate origins give every app its own storage, and the CSP header limits each
//! app to the network domains the user approved.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::{APPS_PORT, Shared, now_ms};

/// Live data an app may be allowed to read. The person sees and approves these per app.
pub const FEEDS: &[&str] = &["open-tabs", "open-windows", "ai-tools"];

/// Tailor's own pages, which frame apps and show their theme and icon.
pub fn launchers() -> &'static [&'static str] {
    if cfg!(debug_assertions) {
        &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"]
    } else {
        &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"]
    }
}

/// Apps the Tester is using right now: links they open are not sent to the browser.
static TESTING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// When each app last opened a link, to stop an app from flooding the browser.
static LAST_OPEN: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

pub fn set_testing(slug: &str, testing: bool) {
    let mut set = TESTING.lock().unwrap();
    if testing {
        set.insert(slug.to_string());
    } else {
        set.remove(slug);
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// A request made by the app's own page, not by another website or another app. Requests with
/// no browser headers come from programs on this computer, which can read these files anyway.
fn from_app_itself(headers: &HeaderMap, slug: &str) -> bool {
    let site_ok = header_str(headers, "sec-fetch-site").map(|v| v == "same-origin").unwrap_or(true);
    let origin_ok = header_str(headers, "origin").map(|o| o == format!("http://{slug}.localhost:{APPS_PORT}")).unwrap_or(true);
    site_ok && origin_ok
}

/// A request from the app itself or from one of Tailor's own pages.
fn from_app_or_tailor(headers: &HeaderMap, slug: &str) -> bool {
    if from_app_itself(headers, slug) {
        return true;
    }
    let from = header_str(headers, "origin").or_else(|| header_str(headers, "referer")).unwrap_or("");
    launchers().iter().any(|l| from == *l || from.starts_with(&format!("{l}/")))
}

/// A link an app may open: plain web addresses only, rebuilt from their parts.
fn safe_link(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()?;
    let out = url.to_string();
    (out.len() <= 2048).then_some(out)
}

#[derive(Clone)]
struct Ctx {
    state: Shared,
    app: AppHandle,
}

pub async fn serve(state: Shared, app: AppHandle) {
    let router = Router::new().fallback(handle).with_state(Ctx { state, app });
    let v6 = router.clone();
    tokio::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::bind(("::1", APPS_PORT)).await {
            let _ = axum::serve(listener, v6).await;
        }
    });
    match tokio::net::TcpListener::bind(("127.0.0.1", APPS_PORT)).await {
        Ok(listener) => {
            let _ = axum::serve(listener, router).await;
        }
        Err(e) => eprintln!("tailor: app host port {APPS_PORT} unavailable: {e}"),
    }
}

pub fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 48
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
}

pub fn app_url(slug: &str) -> String {
    format!("http://{slug}.localhost:{APPS_PORT}/")
}

fn slug_from_host(headers: &HeaderMap) -> Option<String> {
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let name = host.split(':').next()?;
    let slug = name.strip_suffix(".localhost")?;
    valid_slug(slug).then(|| slug.to_string())
}

fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(rel))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Network domains the user approved for this app, from its `tailor.json`.
fn approved_hosts(app_dir: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(app_dir.join("tailor.json")) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return vec![];
    };
    // An app that can read live data from this computer never also gets the internet.
    if v["feeds"].as_array().is_some_and(|f| !f.is_empty()) {
        return vec![];
    }
    v["network"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| d.as_str())
                .map(|d| d.trim().to_lowercase())
                .filter(|d| {
                    !d.is_empty()
                        && d.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                })
                .map(|d| format!("https://{d}"))
                .collect()
        })
        .unwrap_or_default()
}

fn csp(hosts: &[String]) -> String {
    let net = hosts.join(" ");
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob: {net}; font-src 'self' data:; connect-src 'self' {net}; \
         media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; \
         frame-ancestors 'self' {}",
        launchers().join(" ")
    )
}

/// Feeds this app was granted, from its `tailor.json`.
fn granted_feeds(app_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(app_dir.join("tailor.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v["feeds"].as_array().cloned())
        .map(|a| a.iter().filter_map(|f| f.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut res = (status, body.to_string()).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn unavailable(reason: &str) -> Value {
    json!({ "available": false, "reason": reason, "items": [] })
}

fn feed(state: &Shared, name: &str) -> Value {
    let cfg = state.learning.read().unwrap().clone();
    match name {
        "open-tabs" => {
            if !(cfg.enabled && cfg.extension) {
                return unavailable("Turn on “Websites you visit” in Tailor’s Learning page to use this.");
            }
            let (at, tabs) = state.live_tabs.read().unwrap().clone();
            if at == 0 || now_ms() - at > 5 * 60_000 {
                return unavailable("Tailor can’t see your browser yet. Add the Tailor add-on to Chrome or Edge.");
            }
            json!({ "available": true, "updatedAt": at, "items": tabs })
        }
        "open-windows" => {
            if !(cfg.enabled && cfg.desktop) {
                return unavailable("Turn on “Apps on this computer” in Tailor’s Learning page to use this.");
            }
            let (at, windows) = state.live_windows.read().unwrap().clone();
            json!({ "available": at > 0, "updatedAt": at, "items": windows })
        }
        // Read on request from config files (names only); nothing is recorded over time.
        "ai-tools" => {
            if !cfg.enabled {
                return unavailable("Turn on learning in Tailor to use this.");
            }
            json!({ "available": true, "updatedAt": now_ms(), "items": crate::aitools::scan() })
        }
        _ => unavailable("Unknown data."),
    }
}

/// Small API for generated apps: read approved feeds, and open web links in the browser.
fn api(ctx: &Ctx, slug: &str, app_dir: &Path, method: &Method, headers: &HeaderMap, path: &str, body: &Bytes) -> Response {
    if !app_dir.join("tailor.json").is_file() {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }));
    }
    if path == "/__tailor/theme" || path == "/__tailor/icon" {
        if !from_app_or_tailor(headers, slug) {
            return json_response(StatusCode::FORBIDDEN, json!({ "error": "not allowed" }));
        }
    } else if !from_app_itself(headers, slug) {
        return json_response(StatusCode::FORBIDDEN, json!({ "error": "not allowed" }));
    }
    if let Some(name) = path.strip_prefix("/__tailor/feeds/") {
        if method != Method::GET || !FEEDS.contains(&name) {
            return json_response(StatusCode::NOT_FOUND, unavailable("Unknown data."));
        }
        if !granted_feeds(app_dir).iter().any(|f| f == name) {
            return json_response(StatusCode::FORBIDDEN, unavailable("This app wasn’t given permission to see this."));
        }
        return json_response(StatusCode::OK, feed(&ctx.state, name));
    }
    if path == "/__tailor/theme" {
        let theme = crate::db::kv_get(&ctx.state.db.lock().unwrap(), "theme_effective")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| "light".into());
        let mut res = json_response(StatusCode::OK, json!({ "theme": theme }));
        // The app's window frame (a Tailor page) follows the theme too.
        if let Some(origin) = header_str(headers, "origin").filter(|o| launchers().contains(o)) {
            if let Ok(v) = HeaderValue::from_str(origin) {
                res.headers_mut().insert("access-control-allow-origin", v);
                res.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
            }
        }
        return res;
    }
    if path == "/__tailor/icon" {
        return match std::fs::read(app_dir.join("icon.png")) {
            Ok(bytes) => {
                let mut res = Response::new(Body::from(bytes));
                res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
                res
            }
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        };
    }
    if path == "/__tailor/open" && method == Method::POST {
        if !header_str(headers, "content-type").unwrap_or("").starts_with("application/json") {
            return json_response(StatusCode::UNSUPPORTED_MEDIA_TYPE, json!({ "ok": false }));
        }
        let Some(url) = serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v["url"].as_str().and_then(safe_link))
        else {
            return json_response(StatusCode::BAD_REQUEST, json!({ "ok": false }));
        };
        // While the Tester uses the app, links are noted but nothing opens on screen.
        if TESTING.lock().unwrap().contains(slug) {
            return json_response(StatusCode::OK, json!({ "ok": true, "opened": false }));
        }
        let now = now_ms();
        {
            let mut last = LAST_OPEN.lock().unwrap();
            if now - last.get(slug).copied().unwrap_or(0) < 1_000 {
                return json_response(StatusCode::TOO_MANY_REQUESTS, json!({ "ok": false }));
            }
            last.insert(slug.to_string(), now);
        }
        let _ = ctx.app.opener().open_url(url, None::<&str>);
        return json_response(StatusCode::OK, json!({ "ok": true }));
    }
    json_response(StatusCode::NOT_FOUND, json!({ "error": "not found" }))
}

async fn handle(State(ctx): State<Ctx>, method: Method, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    let Some(slug) = slug_from_host(&headers) else {
        return (StatusCode::NOT_FOUND, "Tailor app host: no app at this address").into_response();
    };
    let state = &ctx.state;
    let app_dir = state.workspace_dir.join("apps").join(&slug);
    if uri.path().starts_with("/__tailor/") {
        return api(&ctx, &slug, &app_dir, &method, &headers, uri.path(), &body);
    }
    let dist = app_dir.join("dist");
    if !dist.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            format!("{slug} has not been built yet"),
        )
            .into_response();
    }

    let rel = uri.path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let Some(mut path) = safe_join(&dist, rel) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !path.is_file() {
        // Single-page apps: unknown routes fall back to the document; missing assets 404.
        if Path::new(rel).extension().is_some() {
            return StatusCode::NOT_FOUND.into_response();
        }
        path = dist.join("index.html");
    }

    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut res = Response::new(Body::from(bytes));
            let h = res.headers_mut();
            h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(&path)));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            // Looking up a made-up address (data.elsewhere.example) would also send data out.
            h.insert("x-dns-prefetch-control", HeaderValue::from_static("off"));
            if let Ok(v) = HeaderValue::from_str(&csp(&approved_hosts(&app_dir))) {
                h.insert("content-security-policy", v);
            }
            res
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
