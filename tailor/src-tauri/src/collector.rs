//! Desktop activity collector. Samples the foreground window every two seconds and
//! records focus segments (app + window title + duration). It also notices *that* the
//! clipboard changed, never *what* was copied. Time stops counting when the computer sleeps or
//! locks, or two minutes after the last keyboard, mouse or game-controller input, and each stretch
//! ends at the last moment of real use. A full-screen game or video that keeps the screen on still
//! counts without input.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

use crate::db::Event;
use crate::privacy::BROWSERS;
use crate::{Shared, now_ms, record_events};

const SAMPLE_MS: u64 = 2_000;
const IDLE_MS: u64 = 120_000;
const MIN_SEGMENT_MS: i64 = 3_000;
const LIVE_WINDOWS_MS: i64 = 10_000;
const WINDOW_NOTE_MS: i64 = 5 * 60_000;
const SETUP_SCAN_MS: i64 = 60 * 60_000;
/// Checks happen every two seconds; a longer gap means the computer was asleep.
const SLEEP_GAP_MS: i64 = 20_000;

/// Shell surfaces and Tailor itself are never recorded.
const IGNORED: &[&str] = &[
    "tailor", "explorer", "searchhost", "searchapp", "shellexperiencehost",
    "startmenuexperiencehost", "applicationframehost", "lockapp", "textinputhost",
    "systemsettings", "taskmgr", "msedgewebview2",
];
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

/// When a stretch of activity really ended: before a sleep, at the last check; when the person
/// stopped using the computer, at their last input; otherwise now.
fn segment_end(start: i64, now: i64, last_check: i64, slept: bool, idle_since: Option<i64>) -> i64 {
    let end = if slept { last_check } else { idle_since.unwrap_or(now) };
    end.clamp(start, now)
}

#[cfg(windows)]
fn run(state: Shared, app: AppHandle) {
    let mut current: Option<(String, String, i64)> = None;
    let mut last_check = now_ms();
    let mut last_packets = win::controller_packets();
    let mut last_controller = 0i64;
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
        let slept = now - last_check > SLEEP_GAP_MS;
        let check_before = last_check;
        last_check = now;

        // Windows doesn't count game controllers as input, so watch them separately.
        let packets = win::controller_packets();
        if packets != last_packets {
            last_packets = packets;
            last_controller = now;
        }
        let input_idle = (win::idle_ms() as i64).min(now - last_controller);
        let watching = win::foreground_fullscreen() && win::display_kept_on();
        let in_use = !slept && (input_idle < IDLE_MS as i64 || watching);
        // When the extension is live, it reports browser activity in more detail.
        let extension_live = now - state.extension_last_seen.load(Ordering::Relaxed) < 10 * 60_000;

        let fg = if active && in_use {
            win::foreground().filter(|(a, _)| {
                !IGNORED.contains(&a.as_str()) && !(extension_live && BROWSERS.contains(&a.as_str()))
            })
            // Browser page titles are dropped by the privacy filter, so one browser visit is one segment.
            .map(|(a, t)| if BROWSERS.contains(&a.as_str()) { (a, String::new()) } else { (a, t) })
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
                let idle_since = (fg.is_none() && !watching).then(|| now - input_idle);
                let dur = segment_end(start, now, check_before, slept, idle_since) - start;
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
            // Same privacy filter as recorded activity: no password managers or denied apps, no
            // chat and mail titles, no browser page titles, emails and numbers scrubbed.
            let cfg = state.learning.read().unwrap().clone();
            let windows: Vec<(String, String)> = win::open_windows()
                .into_iter()
                .filter(|(a, _)| !IGNORED.contains(&a.as_str()))
                .filter_map(|(a, t)| crate::privacy::live_window(&a, &t, &cfg))
                .map(|(a, t)| (a, t.unwrap_or_default()))
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
    use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
    use windows::Win32::System::Power::{CallNtPowerInformation, ES_DISPLAY_REQUIRED, SystemExecutionState};
    use windows::Win32::UI::Input::XboxController::{XINPUT_STATE, XInputGetState};
    use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowRect,
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

    /// The front window fills its whole screen: usually a game or a full-screen video.
    pub fn foreground_fullscreen() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return false;
            }
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info).as_bool() {
                return false;
            }
            let m = info.rcMonitor;
            rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
        }
    }

    /// Something asked Windows to keep the screen on, as games and video players do.
    pub fn display_kept_on() -> bool {
        let mut state = 0u32;
        let status = unsafe {
            CallNtPowerInformation(
                SystemExecutionState,
                None,
                0,
                Some(&mut state as *mut u32 as *mut std::ffi::c_void),
                std::mem::size_of::<u32>() as u32,
            )
        };
        status.is_ok() && state & ES_DISPLAY_REQUIRED.0 != 0
    }

    /// One counter per game controller; it changes whenever that controller is used.
    pub fn controller_packets() -> [u32; 4] {
        let mut out = [0u32; 4];
        for (i, slot) in out.iter_mut().enumerate() {
            let mut st = XINPUT_STATE::default();
            if unsafe { XInputGetState(i as u32, &mut st) } == 0 {
                *slot = st.dwPacketNumber;
            }
        }
        out
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

#[cfg(test)]
mod tests {
    use super::segment_end;

    const MIN: i64 = 60_000;

    #[test]
    fn a_focus_change_ends_the_stretch_now() {
        assert_eq!(segment_end(0, 10 * MIN, 10 * MIN - 2_000, false, None), 10 * MIN);
    }

    #[test]
    fn walking_away_ends_the_stretch_at_the_last_input() {
        // Last touched the keyboard at 8 minutes; noticed at 10 (two minutes idle).
        assert_eq!(segment_end(0, 10 * MIN, 10 * MIN - 2_000, false, Some(8 * MIN)), 8 * MIN);
    }

    #[test]
    fn sleep_time_is_never_counted() {
        // Last check at 5 minutes, then the laptop slept for six hours.
        assert_eq!(segment_end(0, 365 * MIN, 5 * MIN, true, Some(0)), 5 * MIN);
    }

    #[test]
    fn the_end_is_never_before_the_start() {
        assert_eq!(segment_end(9 * MIN, 10 * MIN, 10 * MIN, false, Some(8 * MIN)), 9 * MIN);
    }
}
