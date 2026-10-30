//! Desktop activity collector. Samples the foreground window every two seconds and
//! records focus segments (app + window title + duration). It also notices *that* the
//! clipboard changed, never *what* was copied. Idle time is not counted.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

use crate::db::Event;
use crate::{Shared, now_ms, record_events};

const SAMPLE_MS: u64 = 2_000;
const IDLE_MS: u64 = 120_000;
const MIN_SEGMENT_MS: i64 = 3_000;
const LIVE_WINDOWS_MS: i64 = 10_000;
const WINDOW_NOTE_MS: i64 = 5 * 60_000;
const SETUP_SCAN_MS: i64 = 60 * 60_000;

/// Shell surfaces and Tailor itself are never recorded.
const IGNORED: &[&str] = &[
    "tailor", "explorer", "searchhost", "searchapp", "shellexperiencehost",
    "startmenuexperiencehost", "applicationframehost", "lockapp", "textinputhost",
    "systemsettings", "taskmgr", "msedgewebview2",
];
const BROWSERS: &[&str] = &["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc"];
const BROWSER_SUFFIXES: &[&str] = &[
    " - Google Chrome", " - Microsoft\u{200b} Edge", " - Microsoft Edge", " — Mozilla Firefox",
    " - Mozilla Firefox", " - Brave", " - Opera", " - Vivaldi",
];

fn clean_title(app: &str, title: &str) -> String {
    let mut t = title.to_string();
    if BROWSERS.contains(&app) {
        for s in BROWSER_SUFFIXES {
            if let Some(stripped) = t.strip_suffix(s) {
                t = stripped.to_string();
            }
        }
        if let Some(idx) = t.find(" and ") {
            if t[idx..].contains("more page") {
                t.truncate(idx);
            }
        }
    }
    t
}

pub fn start(state: Shared, app: AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || run(state, app));
    #[cfg(not(windows))]
    let _ = (state, app);
}

#[cfg(windows)]
fn run(state: Shared, app: AppHandle) {
    let mut current: Option<(String, String, i64)> = None;
    let mut last_clip = win::clipboard_seq();
    let mut last_live = 0i64;
    let mut last_window_note = 0i64;
    let mut last_setup = 0i64;

    loop {
        std::thread::sleep(Duration::from_millis(SAMPLE_MS));
        let (enabled, desktop) = {
            let cfg = state.learning.read().unwrap();
            (cfg.enabled, cfg.desktop)
        };
        let active = enabled && desktop;
        let now = now_ms();
        // When the extension is live, it reports browser activity in more detail.
        let extension_live = now - state.extension_last_seen.load(Ordering::Relaxed) < 10 * 60_000;

        let fg = if active && win::idle_ms() < IDLE_MS {
            win::foreground().filter(|(a, _)| {
                !IGNORED.contains(&a.as_str()) && !(extension_live && BROWSERS.contains(&a.as_str()))
            })
        } else {
            None
        };

        let changed = match (&current, &fg) {
            (Some(c), Some(f)) => c.0 != f.0 || c.1 != f.1,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if changed {
            if let Some((a, t, start)) = current.take() {
                let dur = now - start;
                if dur >= MIN_SEGMENT_MS {
                    state.desktop_last_seen.store(now, Ordering::Relaxed);
                    record_events(
                        &state,
                        &app,
                        vec![Event {
                            ts: start,
                            source: "desktop".into(),
                            kind: "focus".into(),
                            app: Some(a),
                            title: Some(t),
                            duration_ms: dur,
                            ..Default::default()
                        }],
                    );
                }
            }
        }
        if current.is_none() {
            if let Some((a, t)) = fg.clone() {
                current = Some((a, t, now));
            }
        }

        let seq = win::clipboard_seq();
        if seq != last_clip {
            last_clip = seq;
            if let Some((a, t)) = fg.as_ref() {
                record_events(
                    &state,
                    &app,
                    vec![Event {
                        ts: now,
                        source: "desktop".into(),
                        kind: "copy".into(),
                        app: Some(a.clone()),
                        title: Some(t.clone()),
                        meta: Some(json!({ "inferred": true })),
                        ..Default::default()
                    }],
                );
            }
        }

        if !active {
            if last_live != 0 {
                *state.live_windows.write().unwrap() = (0, vec![]);
                last_live = 0;
            }
            continue;
        }
        let present = fg.is_some();

        // Which windows are open right now (kept in memory for apps the person allowed to see it).
        if now - last_live >= LIVE_WINDOWS_MS {
            last_live = now;
            let windows: Vec<(String, String)> = win::open_windows()
                .into_iter()
                .filter(|(a, _)| !IGNORED.contains(&a.as_str()))
                .collect();
            let live: Vec<serde_json::Value> = windows.iter().map(|(a, t)| json!({ "app": a, "title": t })).collect();
            *state.live_windows.write().unwrap() = (now, live);

            // Every few minutes of real use, note apps with several windows open at once.
            if present && now - last_window_note >= WINDOW_NOTE_MS {
                last_window_note = now;
                let mut by_app: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
                for (a, t) in &windows {
                    by_app.entry(a.as_str()).or_default().push(t.as_str());
                }
                let events: Vec<Event> = by_app
                    .into_iter()
                    .filter(|(_, titles)| titles.len() >= 2)
                    .map(|(a, titles)| Event {
                        ts: now,
                        source: "desktop".into(),
                        kind: "windows".into(),
                        app: Some(a.to_string()),
                        title: Some(titles.iter().take(3).cloned().collect::<Vec<_>>().join(" · ")),
                        meta: Some(json!({ "windowCount": titles.len() })),
                        ..Default::default()
                    })
                    .collect();
                record_events(&state, &app, events);
            }
        }

        // How the person's AI tools are set up (names only), about once an hour.
        if present && now - last_setup >= SETUP_SCAN_MS {
            last_setup = now;
            let tools = crate::aitools::scan();
            let events: Vec<Event> = crate::aitools::summarize(&tools)
                .into_iter()
                .map(|(tool, count, summary)| Event {
                    ts: now,
                    source: "desktop".into(),
                    kind: "setup".into(),
                    app: Some(tool),
                    title: Some(summary),
                    meta: Some(json!({ "count": count })),
                    ..Default::default()
                })
                .collect();
            record_events(&state, &app, events);
        }
    }
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        WS_EX_TOOLWINDOW,
    };
    use windows::core::PWSTR;

    pub fn clipboard_seq() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }

    pub fn idle_ms() -> u64 {
        unsafe {
            let mut info = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut info).as_bool() {
                GetTickCount().wrapping_sub(info.dwTime) as u64
            } else {
                0
            }
        }
    }

    /// (process name without extension, cleaned window title)
    pub fn foreground() -> Option<(String, String)> {
        unsafe {
            let hwnd: HWND = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            describe(hwnd)
        }
    }

    /// Every visible, titled top-level window the person can actually see.
    pub fn open_windows() -> Vec<(String, String)> {
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let list = &mut *(lparam.0 as *mut Vec<(String, String)>);
                let owned = GetWindow(hwnd, GW_OWNER).map(|h| !h.0.is_null()).unwrap_or(false);
                let tool = (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0;
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(
                    hwnd,
                    DWMWA_CLOAKED,
                    &mut cloaked as *mut u32 as *mut std::ffi::c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                if IsWindowVisible(hwnd).as_bool() && !owned && !tool && cloaked == 0 && GetWindowTextLengthW(hwnd) > 0 {
                    if let Some(w) = describe(hwnd) {
                        list.push(w);
                    }
                }
                BOOL(1)
            }
        }
        let mut list: Vec<(String, String)> = vec![];
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut list as *mut _ as isize));
        }
        list
    }

    unsafe fn describe(hwnd: HWND) -> Option<(String, String)> {
        unsafe {
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut buf);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);

            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut name = [0u16; 1024];
            let mut size = name.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(name.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            ok.ok()?;
            let path = String::from_utf16_lossy(&name[..size as usize]);
            let exe = std::path::Path::new(&path)
                .file_stem()?
                .to_string_lossy()
                .to_lowercase();
            let title = super::clean_title(&exe, title.trim());
            Some((exe, title))
        }
    }
}
