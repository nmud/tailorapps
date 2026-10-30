mod aitools;
mod app_mode;
mod appserver;
mod auth;
mod collector;
mod commands;
mod db;
mod ingest;
mod llm;
mod privacy;
mod standalone;
mod tray;
mod workspace;

use std::path::PathBuf;
use std::sync::atomic::AtomicI64;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Emitter, Manager};

/// Port the browser extension posts permissioned events to.
pub const INGEST_PORT: u16 = 47821;
/// Port that serves every generated app at `http://<slug>.localhost:48100`.
pub const APPS_PORT: u16 = 48100;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub learning: RwLock<privacy::LearningCfg>,
    pub workspace_dir: PathBuf,
    pub extension_last_seen: AtomicI64,
    pub desktop_last_seen: AtomicI64,
    pub http: reqwest::Client,
    pub auth: auth::AuthState,
    /// Live snapshots (memory only, never stored) for apps the person allowed to see them.
    pub live_tabs: RwLock<(i64, Vec<serde_json::Value>)>,
    pub live_windows: RwLock<(i64, Vec<serde_json::Value>)>,
    /// Generated apps Tailor launched, so removing an app can close it.
    pub app_processes: Mutex<std::collections::HashMap<String, Vec<std::process::Child>>>,
}

pub type Shared = Arc<AppState>;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Sanitize, store and announce a batch of events. Every source goes through here.
pub fn record_events(state: &AppState, app: &tauri::AppHandle, events: Vec<db::Event>) -> usize {
    let cfg = state.learning.read().unwrap().clone();
    let clean: Vec<db::Event> = events
        .into_iter()
        .filter_map(|e| privacy::admit(e, &cfg))
        .collect();
    if clean.is_empty() {
        return 0;
    }
    let inserted = {
        let conn = state.db.lock().unwrap();
        db::insert_events(&conn, &clean).unwrap_or(0)
    };
    if inserted > 0 {
        let _ = app.emit("activity", inserted);
    }
    inserted
}

/// Forget activity older than the person's chosen retention. Runs hourly, because Tailor can
/// stay open in the tray for weeks, and whenever the setting changes.
pub fn purge_old(state: &AppState) {
    let days = state.learning.read().unwrap().retention_days;
    if days > 0 {
        let cutoff = now_ms() - days as i64 * 86_400_000;
        let _ = db::delete_events_before(&state.db.lock().unwrap(), cutoff);
    }
}

/// Bring Tailor's main window back from the tray.
pub fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    // `tailor.exe --app <slug>` opens one generated app as its own program.
    if let Some(slug) = args.iter().position(|a| a == "--app").and_then(|i| args.get(i + 1)) {
        return app_mode::run(slug.clone());
    }
    let background = args.iter().any(|a| a == "--background");

    tauri::Builder::default()
        // A second launch (Start menu, desktop shortcut) just brings back the running Tailor.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .on_window_event(|window, event| {
            // Closing Tailor keeps it running in the tray, like Discord.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("tailor.db"))?;
            let learning: privacy::LearningCfg = db::kv_get(&conn, "learning")
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            if learning.retention_days > 0 {
                let cutoff = now_ms() - learning.retention_days as i64 * 86_400_000;
                let _ = db::delete_events_before(&conn, cutoff);
            }
            let workspace_dir = data_dir.join("workspace");
            std::fs::create_dir_all(workspace_dir.join("apps"))?;

            let state: Shared = Arc::new(AppState {
                db: Mutex::new(conn),
                learning: RwLock::new(learning),
                workspace_dir,
                extension_last_seen: AtomicI64::new(0),
                desktop_last_seen: AtomicI64::new(0),
                http: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(900))
                    .build()?,
                auth: auth::AuthState::default(),
                live_tabs: RwLock::new((0, vec![])),
                live_windows: RwLock::new((0, vec![])),
                app_processes: Mutex::new(Default::default()),
            });
            app.manage(state.clone());

            let handle = app.handle().clone();
            tray::build(&handle, state.learning.read().unwrap().enabled)?;
            tauri::async_runtime::spawn(ingest::serve(state.clone(), handle.clone()));
            tauri::async_runtime::spawn(appserver::serve(state.clone(), handle.clone()));
            let purge = state.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    purge_old(&purge);
                }
            });
            collector::start(state, handle);
            if !background {
                show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::events_query,
            commands::events_insert,
            commands::events_delete,
            commands::events_clear,
            commands::kv_get,
            commands::kv_set,
            commands::docs_list,
            commands::docs_put,
            commands::docs_delete,
            commands::learning_get,
            commands::learning_set,
            commands::runtime_status,
            commands::auth_current,
            commands::auth_login,
            commands::auth_signup,
            commands::auth_logout,
            commands::auth_send_reset,
            commands::auth_confirm_reset,
            commands::extension_reveal,
            commands::llm_chat,
            commands::workspace_status,
            commands::workspace_prepare,
            commands::app_create,
            commands::app_write_files,
            commands::app_read_files,
            commands::app_build,
            commands::app_delete,
            commands::app_open_window,
            commands::app_close_window,
            commands::app_set_icon,
            commands::app_install,
            commands::app_uninstall,
        ])
        .run(context())
        .expect("error while running tauri application");
}

fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}
