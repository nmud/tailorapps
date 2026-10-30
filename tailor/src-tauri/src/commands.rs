use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use tauri::ipc::Channel;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

use crate::appserver::app_url;
use crate::standalone;
use crate::auth::User;
use crate::db::{self, Event};
use crate::llm::{self, ChatRequest};
use crate::privacy::LearningCfg;
use crate::workspace::{self, BuildResult, SourceFile, WorkspaceStatus};
use crate::{APPS_PORT, INGEST_PORT, Shared, now_ms, record_events};

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── activity ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn events_query(
    state: State<'_, Shared>,
    since: i64,
    until: Option<i64>,
    limit: Option<i64>,
    newest_first: Option<bool>,
) -> Res<Vec<Event>> {
    let conn = state.db.lock().unwrap();
    db::query_events(
        &conn,
        since,
        until.unwrap_or(i64::MAX),
        limit.unwrap_or(50_000),
        newest_first.unwrap_or(false),
    )
    .map_err(err)
}

/// Used by demo replay. Demo events bypass the learning switch but not the privacy filter.
#[tauri::command]
pub fn events_insert(app: AppHandle, state: State<'_, Shared>, events: Vec<Event>) -> Res<usize> {
    let events = events
        .into_iter()
        .map(|mut e| {
            e.source = "demo".into();
            e
        })
        .collect();
    Ok(record_events(&state, &app, events))
}

#[tauri::command]
pub fn events_delete(state: State<'_, Shared>, ids: Vec<i64>) -> Res<usize> {
    let conn = state.db.lock().unwrap();
    db::delete_events(&conn, &ids).map_err(err)
}

#[tauri::command]
pub fn events_clear(state: State<'_, Shared>, source: Option<String>) -> Res<usize> {
    let conn = state.db.lock().unwrap();
    db::clear_events(&conn, source.as_deref()).map_err(err)
}

// ── storage ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn kv_get(state: State<'_, Shared>, key: String) -> Res<Option<Value>> {
    let conn = state.db.lock().unwrap();
    Ok(db::kv_get(&conn, &key))
}

#[tauri::command]
pub fn kv_set(state: State<'_, Shared>, key: String, value: Value) -> Res<()> {
    if key == "learning" {
        return Err("Use learning_set".into());
    }
    let conn = state.db.lock().unwrap();
    db::kv_set(&conn, &key, &value).map_err(err)
}

#[tauri::command]
pub fn docs_list(state: State<'_, Shared>, collection: String) -> Res<Vec<Value>> {
    let conn = state.db.lock().unwrap();
    db::docs_list(&conn, &collection).map_err(err)
}

#[tauri::command]
pub fn docs_put(state: State<'_, Shared>, collection: String, id: String, data: Value) -> Res<()> {
    let conn = state.db.lock().unwrap();
    db::docs_put(&conn, &collection, &id, &data, now_ms()).map_err(err)
}

#[tauri::command]
pub fn docs_delete(state: State<'_, Shared>, collection: String, id: String) -> Res<()> {
    let conn = state.db.lock().unwrap();
    db::docs_delete(&conn, &collection, &id).map(|_| ()).map_err(err)
}

// ── learning ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn learning_get(state: State<'_, Shared>) -> LearningCfg {
    state.learning.read().unwrap().clone()
}

#[tauri::command]
pub fn learning_set(app: AppHandle, state: State<'_, Shared>, cfg: LearningCfg) -> Res<LearningCfg> {
    {
        let conn = state.db.lock().unwrap();
        db::kv_set(&conn, "learning", &serde_json::to_value(&cfg).map_err(err)?).map_err(err)?;
    }
    *state.learning.write().unwrap() = cfg.clone();
    crate::purge_old(&state);
    // Switching a source off forgets its live snapshot straight away.
    if !(cfg.enabled && cfg.extension) {
        *state.live_tabs.write().unwrap() = (0, vec![]);
    }
    if !(cfg.enabled && cfg.desktop) {
        *state.live_windows.write().unwrap() = (0, vec![]);
    }
    crate::tray::set_learning_label(&app, cfg.enabled);
    Ok(cfg)
}

#[tauri::command]
pub fn runtime_status(state: State<'_, Shared>) -> Value {
    json!({
        "ingestPort": INGEST_PORT,
        "appsPort": APPS_PORT,
        "extensionLastSeen": state.extension_last_seen.load(Ordering::Relaxed),
        "desktopLastSeen": state.desktop_last_seen.load(Ordering::Relaxed),
        "platform": std::env::consts::OS,
    })
}

// ── account ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn auth_current(state: State<'_, Shared>) -> Res<Option<User>> {
    Ok(state.auth.current(&state.http).await)
}

#[tauri::command]
pub async fn auth_login(state: State<'_, Shared>, email: String, password: String) -> Res<User> {
    state.auth.login(&state.http, &email, &password).await
}

#[tauri::command]
pub async fn auth_signup(state: State<'_, Shared>, name: String, email: String, password: String) -> Res<User> {
    state.auth.signup(&state.http, &name, &email, &password).await
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle, state: State<'_, Shared>) -> Res<()> {
    for (label, w) in app.webview_windows() {
        if label.starts_with("app-") {
            let _ = w.close();
        }
    }
    state.auth.logout(&state.http).await;
    Ok(())
}

#[tauri::command]
pub async fn auth_send_reset(state: State<'_, Shared>, email: String) -> Res<()> {
    state.auth.send_reset(&state.http, &email).await
}

#[tauri::command]
pub async fn auth_confirm_reset(state: State<'_, Shared>, email: String, code: String, password: String) -> Res<User> {
    state.auth.confirm_reset(&state.http, &email, &code, &password).await
}

// ── model access ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn llm_chat(state: State<'_, Shared>, req: ChatRequest, on_delta: Channel<String>) -> Res<String> {
    llm::chat(&state, req, &on_delta).await
}

// ── browser add-on ──────────────────────────────────────────────────────────

/// Show the browser add-on folder in File Explorer so it can be loaded into Chrome or Edge.
#[tauri::command]
pub fn extension_reveal(app: AppHandle) -> Res<String> {
    let dir = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extension")
    } else {
        app.path().resolve("extension", BaseDirectory::Resource).map_err(err)?
    };
    let dir = dir.canonicalize().map_err(err)?;
    let shown = dir.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    std::process::Command::new("explorer").arg(&shown).spawn().map_err(err)?;
    Ok(shown)
}

// ── builder runtime ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn workspace_status(state: State<'_, Shared>) -> Res<WorkspaceStatus> {
    Ok(workspace::status(&state.workspace_dir).await)
}

#[tauri::command]
pub async fn workspace_prepare(app: AppHandle, state: State<'_, Shared>, on_log: Channel<String>) -> Res<WorkspaceStatus> {
    let template = app
        .path()
        .resolve("resources/workspace", BaseDirectory::Resource)
        .map_err(err)?;
    workspace::prepare(&template, &state.workspace_dir, &on_log).await
}

#[tauri::command]
pub fn app_create(state: State<'_, Shared>, id: String, manifest: Value) -> Res<String> {
    workspace::create_app(&state.workspace_dir, &id, &manifest)?;
    Ok(app_url(&id))
}

#[tauri::command]
pub fn app_write_files(
    state: State<'_, Shared>,
    id: String,
    files: Vec<SourceFile>,
    delete: Option<Vec<String>>,
    replace: Option<bool>,
) -> Res<Vec<String>> {
    workspace::write_files(
        &state.workspace_dir,
        &id,
        &files,
        &delete.unwrap_or_default(),
        replace.unwrap_or(false),
    )
}

#[tauri::command]
pub fn app_read_files(state: State<'_, Shared>, id: String) -> Res<Vec<SourceFile>> {
    workspace::read_files(&state.workspace_dir, &id)
}

#[tauri::command]
pub async fn app_build(state: State<'_, Shared>, id: String) -> Res<BuildResult> {
    workspace::build(&state.workspace_dir, &id).await
}

#[tauri::command]
pub async fn app_delete(state: State<'_, Shared>, id: String) -> Res<()> {
    if let Some(list) = state.app_processes.lock().unwrap().remove(&id) {
        for mut child in list {
            let _ = child.kill();
        }
    }
    workspace::delete_app(&state.workspace_dir, &id)
}

/// Open a generated app as its own program (`tailor.exe --app <id>`): its own taskbar button,
/// icon and window. It loads from its own origin with no Tauri capabilities.
#[tauri::command]
pub fn app_open_window(state: State<'_, Shared>, id: String) -> Res<()> {
    if !crate::appserver::valid_slug(&id) {
        return Err("Invalid app id".into());
    }
    let exe = std::env::current_exe().map_err(err)?;
    let child = std::process::Command::new(exe).args(["--app", &id]).spawn().map_err(err)?;
    let mut running = state.app_processes.lock().unwrap();
    let list = running.entry(id).or_default();
    list.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
    list.push(child);
    Ok(())
}

/// Close any copies of an app that Tailor opened.
#[tauri::command]
pub fn app_close_window(state: State<'_, Shared>, id: String) -> Res<()> {
    if let Some(list) = state.app_processes.lock().unwrap().remove(&id) {
        for mut child in list {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Save the app's icon (a 256px PNG drawn by the launcher) as icon.png and icon.ico.
#[tauri::command]
pub fn app_set_icon(state: State<'_, Shared>, id: String, png: Vec<u8>) -> Res<()> {
    let dir = workspace::app_dir(&state.workspace_dir, &id)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    std::fs::write(dir.join("icon.png"), &png).map_err(err)?;
    std::fs::write(dir.join("icon.ico"), standalone::png_to_ico(&png)).map_err(err)
}

/// Add the app to the Start menu (so it can be searched for and pinned). Returns the shortcut path.
#[tauri::command]
pub fn app_install(state: State<'_, Shared>, id: String, name: String, description: String) -> Res<String> {
    let dir = workspace::app_dir(&state.workspace_dir, &id)?;
    let path = standalone::create_shortcut(&id, &name, &description, &dir.join("icon.ico"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn app_uninstall(state: State<'_, Shared>, id: String, shortcut: Option<String>) -> Res<()> {
    let _ = app_close_window(state, id);
    if let Some(path) = shortcut {
        standalone::remove_shortcut(std::path::Path::new(&path));
    }
    Ok(())
}
