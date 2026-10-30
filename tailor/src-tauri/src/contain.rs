//! Generated apps run in frames. Their content security policy limits what they can fetch, but
//! not where the frame itself goes, so an app could otherwise send data out by navigating to
//! `https://elsewhere/?data=…`. Tailor's windows answer every page load that isn't Tailor itself
//! or a generated app with a local "blocked" page, so the request never leaves the computer.
//!
//! (Cancelling in FrameNavigationStarting is not enough: WebView2 has already sent the request.)

use crate::APPS_PORT;

/// Pages Tailor's windows may load: Tailor itself, generated apps and blank pages.
pub fn document_url_allowed(uri: &str) -> bool {
    if uri == "about:blank" || uri == "about:srcdoc" {
        return true;
    }
    if crate::appserver::launchers().iter().any(|l| uri == *l || uri.starts_with(&format!("{l}/"))) {
        return true;
    }
    let Ok(url) = reqwest::Url::parse(uri) else { return false };
    url.scheme() == "http"
        && url.port() == Some(APPS_PORT)
        && url
            .host_str()
            .and_then(|h| h.strip_suffix(".localhost"))
            .is_some_and(crate::appserver::valid_slug)
}

#[cfg(windows)]
pub fn keep_frames_local(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT, ICoreWebView2_22,
            ICoreWebView2NavigationStartingEventArgs, ICoreWebView2WebResourceRequestedEventArgs,
        };
        use webview2_com::{NavigationStartingEventHandler, WebResourceRequestedEventHandler, take_pwstr};
        use windows_core::{Interface, PWSTR, w};

        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let env = webview.environment();

        // Requests from the page and its frames, held until this answers.
        let blocker = WebResourceRequestedEventHandler::create(Box::new(
            move |_, args: Option<ICoreWebView2WebResourceRequestedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
                args.ResourceContext(&mut context)?;
                if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
                    return Ok(());
                }
                let mut uri = PWSTR::null();
                args.Request()?.Uri(&mut uri)?;
                if !document_url_allowed(&take_pwstr(uri)) {
                    let blocked = env.CreateWebResourceResponse(None, 403, w!("Blocked by Tailor"), w!(""))?;
                    args.SetResponse(&blocked)?;
                }
                Ok(())
            },
        ));
        let mut token = Default::default();
        if let Ok(core22) = core.cast::<ICoreWebView2_22>() {
            let _ = core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                w!("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
            );
        } else {
            eprintln!("tailor: this WebView2 is too old to keep app frames local; update Microsoft Edge WebView2");
        }
        let _ = core.add_WebResourceRequested(&blocker, &mut token);

        // Also stop the frame itself from moving, so the app stays on screen instead of an error.
        let stay = NavigationStartingEventHandler::create(Box::new(
            |_, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
                if let Some(args) = args {
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    if !document_url_allowed(&take_pwstr(uri)) {
                        args.SetCancel(true)?;
                    }
                }
                Ok(())
            },
        ));
        let mut token = Default::default();
        let _ = core.add_FrameNavigationStarting(&stay, &mut token);
    });
}

#[cfg(not(windows))]
pub fn keep_frames_local(_: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::document_url_allowed;

    #[test]
    fn windows_load_only_tailor_and_its_apps() {
        assert!(document_url_allowed("http://paper-ledger.localhost:48100/"));
        assert!(document_url_allowed("http://paper-ledger.localhost:48100/?tailorFrame=1#x"));
        assert!(document_url_allowed("http://tauri.localhost/index.html?frame=paper-ledger"));
        assert!(document_url_allowed("about:blank"));
        for bad in [
            "https://evil.example/?d=secret",
            "http://127.0.0.1:47999/leak",
            "http://evil.example:48100/",
            "http://paper-ledger.localhost:48101/",
            "http://localhost:48100/",
            "http://a.b.localhost:48100/",
            "https://paper-ledger.localhost:48100/",
            "http://paper-ledger.localhost.evil.example:48100/",
            "http://tauri.localhost.evil.example/",
            "javascript:alert(1)",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(!document_url_allowed(bad), "{bad}");
        }
    }
}
