//! `tailor.exe --app <slug>`: one generated app running as its own program, with its own
//! taskbar button, icon and window. It loads the app from Tailor's local app host, starting
//! Tailor in the background first if it isn't running.

use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::image::Image;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use tauri::utils::config::WindowEffectsConfig;
use tauri::window::Effect;

use crate::appserver::valid_slug;
use crate::{APPS_PORT, standalone};

/// Percent-encode a value for a query string.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn host_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], APPS_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Start Tailor quietly in the tray and wait for its app host.
fn ensure_host() {
    if host_running() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).arg("--background").spawn();
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) && !host_running() {
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Tailor's current theme ("light" or "dark"), so the window frame matches the app.
fn theme(slug: &str) -> Option<tauri::Theme> {
    let mut stream = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], APPS_PORT)), Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    use std::io::{Read, Write};
    write!(stream, "GET /__tailor/theme HTTP/1.1\r\nHost: {slug}.localhost:{APPS_PORT}\r\nConnection: close\r\n\r\n").ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    let json = body.split("\r\n\r\n").nth(1)?;
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    Some(if v["theme"] == "dark" { tauri::Theme::Dark } else { tauri::Theme::Light })
}

pub fn run(slug: String) {
    if !valid_slug(&slug) {
        return;
    }
    standalone::set_process_app_id(&standalone::app_id(&slug));
    ensure_host();
    let theme = theme(&slug);

    let mut context = crate::context();
    context.config_mut().app.windows.clear();

    tauri::Builder::default()
        .setup(move |app| {
            let dir = app.path().app_data_dir()?.join("workspace/apps").join(&slug);
            let name = std::fs::read_to_string(dir.join("tailor.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v["name"].as_str().map(String::from))
                .unwrap_or_else(|| slug.clone());

            // The window is Tailor's own frame page (glass title bar and border, same as Tailor);
            // the app itself runs inside it, sealed off at its own address.
            let dark = matches!(theme, Some(tauri::Theme::Dark));
            let frame = format!(
                "index.html?frame={slug}&name={}&theme={}",
                encode(&name),
                if dark { "dark" } else { "light" }
            );
            let mut builder = WebviewWindowBuilder::new(app, "app", WebviewUrl::App(frame.into()))
                .title(&name)
                .inner_size(1120.0, 780.0)
                .min_inner_size(480.0, 360.0)
                .decorations(false)
                .transparent(true)
                .shadow(true)
                .effects(WindowEffectsConfig {
                    effects: vec![if dark { Effect::MicaDark } else { Effect::MicaLight }],
                    state: None,
                    radius: None,
                    color: None,
                    ..Default::default()
                })
                .theme(theme);
            let icon_png = dir.join("icon.png");
            if let Ok(bytes) = std::fs::read(&icon_png) {
                if let Ok(img) = Image::from_bytes(&bytes) {
                    builder = builder.icon(img)?;
                }
            }
            let window = builder.build()?;
            #[cfg(windows)]
            if let Ok(hwnd) = window.hwnd() {
                standalone::set_window_identity(hwnd.0 as isize, &slug, &name, &dir.join("icon.ico"));
            }
            #[cfg(not(windows))]
            let _ = window;
            Ok(())
        })
        .run(context)
        .expect("error while running app window");
}
