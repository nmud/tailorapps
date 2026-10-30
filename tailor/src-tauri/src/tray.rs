//! Tailor lives in the system tray: left-click opens it; the menu can pause learning or quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{Shared, db, show_main};

/// The "Pause learning" / "Resume learning" item, kept so its label can follow the setting.
pub struct LearningItem(pub MenuItem<Wry>);

fn learning_label(enabled: bool) -> &'static str {
    if enabled { "Pause learning" } else { "Turn on learning" }
}

pub fn build(app: &AppHandle, learning_enabled: bool) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Tailor", true, None::<&str>)?;
    let learning = MenuItem::with_id(app, "learning", learning_label(learning_enabled), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Tailor", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &learning, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(LearningItem(learning));

    let mut tray = TrayIconBuilder::with_id("tailor")
        .tooltip("Tailor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "learning" => toggle_learning(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn set_learning_label(app: &AppHandle, enabled: bool) {
    if let Some(item) = app.try_state::<LearningItem>() {
        let _ = item.0.set_text(learning_label(enabled));
    }
}

fn toggle_learning(app: &AppHandle) {
    let state = app.state::<Shared>();
    let cfg = {
        let mut cfg = state.learning.write().unwrap();
        cfg.enabled = !cfg.enabled;
        if cfg.enabled && !cfg.extension && !cfg.desktop {
            cfg.extension = true;
            cfg.desktop = true;
        }
        cfg.clone()
    };
    if let Ok(v) = serde_json::to_value(&cfg) {
        let _ = db::kv_set(&state.db.lock().unwrap(), "learning", &v);
    }
    set_learning_label(app, cfg.enabled);
    let _ = app.emit("learning-changed", cfg.enabled);
}
