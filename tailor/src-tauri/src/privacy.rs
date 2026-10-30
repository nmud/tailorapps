//! The privacy floor. Every event, whatever its source, passes through `sanitize`
//! before it is written. Rules here cannot be loosened from the UI, only tightened.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::db::Event;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LearningCfg {
    /// Master switch. Off until the user turns it on.
    pub enabled: bool,
    pub extension: bool,
    pub desktop: bool,
    pub include_search_terms: bool,
    pub include_paths: bool,
    pub deny_apps: Vec<String>,
    pub deny_domains: Vec<String>,
    pub retention_days: u32,
}

impl Default for LearningCfg {
    fn default() -> Self {
        Self {
            enabled: false,
            extension: true,
            desktop: true,
            include_search_terms: false,
            include_paths: false,
            deny_apps: vec![],
            deny_domains: vec![],
            retention_days: 30,
        }
    }
}

/// Never recorded at all.
const BLOCKED_APPS: &[&str] = &[
    "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "enpass",
    "nordpass", "proton pass", "credentialuibroker", "consent", "logonui", "lockapp",
    "sechealthui", "securityhealthsystray", "keychain",
];

/// Recorded as "used this app", never with window titles (titles carry contact names).
const PRIVATE_TITLE_APPS: &[&str] = &[
    "slack", "discord", "whatsapp", "telegram", "signal", "teams", "ms-teams", "outlook", "olk",
    "thunderbird", "zoom", "messenger", "skype", "mail", "hxoutlook",
];

/// Never recorded at all: finance, identity, credential managers.
const BLOCKED_DOMAINS: &[&str] = &[
    "paypal.com", "venmo.com", "chase.com", "bankofamerica.com", "wellsfargo.com",
    "capitalone.com", "americanexpress.com", "citi.com", "schwab.com", "fidelity.com",
    "vanguard.com", "robinhood.com", "coinbase.com", "1password.com", "bitwarden.com",
    "lastpass.com", "accounts.google.com", "login.microsoftonline.com", "login.live.com",
    "okta.com", "auth0.com", "irs.gov", "ssa.gov",
];
/// Any domain label containing one of these is skipped (e.g. `mybank.com`, `mychart.org`).
const BLOCKED_DOMAIN_WORDS: &[&str] = &["bank", "mychart", "patientportal"];
/// Any domain label equal to one of these is skipped (e.g. `login.example.com`).
const BLOCKED_DOMAIN_LABELS: &[&str] = &["login", "signin", "auth", "sso", "accounts", "id"];

/// Domain-only: page titles dropped (inboxes, chats).
const PRIVATE_TITLE_DOMAINS: &[&str] = &[
    "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
    "web.whatsapp.com", "messenger.com", "discord.com", "slack.com", "app.slack.com",
    "teams.microsoft.com", "web.telegram.org", "mail.proton.me", "mail.yahoo.com",
    "linkedin.com", "facebook.com", "instagram.com",
];

/// Browser windows seen from the desktop carry page titles with no address, so the domain rules
/// above can't apply to them. The browser add-on reports browsing instead.
pub const BROWSERS: &[&str] = &["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc"];

const KINDS: &[&str] = &["focus", "copy", "paste", "search", "download", "navigate", "tabs", "windows", "setup"];

static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}").unwrap());
static LONG_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d[\d \-]{5,}\d").unwrap());
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-]{28,}").unwrap());

fn matches_domain(domain: &str, list: &[&str]) -> bool {
    list.iter()
        .any(|d| domain == *d || domain.ends_with(&format!(".{d}")))
}

pub fn scrub_text(text: &str) -> String {
    let t = EMAIL.replace_all(text, "[email]");
    let t = LONG_NUMBER.replace_all(&t, "[number]");
    let t = TOKEN.replace_all(&t, "[id]");
    let t = t.trim();
    if t.chars().count() > 140 {
        let cut: String = t.chars().take(139).collect();
        format!("{cut}…")
    } else {
        t.to_string()
    }
}

/// Whether learning allows recording from this source right now. Sample-week ("demo") events
/// are only ever added on request, so they skip the switches but not the filter below.
pub fn source_allowed(source: &str, cfg: &LearningCfg) -> bool {
    match source {
        "demo" => true,
        "extension" => cfg.enabled && cfg.extension,
        "desktop" => cfg.enabled && cfg.desktop,
        _ => false,
    }
}

/// The one gate in front of every write: the learning switches, then the privacy filter.
pub fn admit(ev: Event, cfg: &LearningCfg) -> Option<Event> {
    if !source_allowed(&ev.source, cfg) {
        return None;
    }
    sanitize(ev, cfg)
}

/// A window in the live "open windows" feed, after the same filter as recorded activity.
pub fn live_window(app: &str, title: &str, cfg: &LearningCfg) -> Option<(String, Option<String>)> {
    let ev = sanitize(
        Event { source: "desktop".into(), kind: "focus".into(), app: Some(app.into()), title: Some(title.into()), ..Default::default() },
        cfg,
    )?;
    Some((ev.app.unwrap_or_default(), ev.title))
}

/// Returns `None` when the event must not be stored.
pub fn sanitize(mut ev: Event, cfg: &LearningCfg) -> Option<Event> {
    if !KINDS.contains(&ev.kind.as_str()) {
        return None;
    }

    if let Some(app) = ev.app.as_deref() {
        let a = app.to_lowercase();
        if BLOCKED_APPS.iter().any(|b| a.contains(b))
            || cfg.deny_apps.iter().any(|d| !d.trim().is_empty() && a.contains(&d.trim().to_lowercase()))
        {
            return None;
        }
        if PRIVATE_TITLE_APPS.iter().any(|p| a == *p || a.starts_with(p))
            || (ev.source == "desktop" && BROWSERS.contains(&a.as_str()))
        {
            ev.title = None;
        }
    }

    if let Some(domain) = ev.domain.as_deref() {
        let d = domain.trim().to_lowercase();
        let d = d.strip_prefix("www.").unwrap_or(&d).to_string();
        if d.is_empty() {
            ev.domain = None;
        } else {
            if matches_domain(&d, BLOCKED_DOMAINS)
                || d.split('.').any(|part| {
                    BLOCKED_DOMAIN_WORDS.iter().any(|w| part.contains(w))
                        || BLOCKED_DOMAIN_LABELS.contains(&part)
                })
                || cfg.deny_domains.iter().any(|x| {
                    let x = x.trim().to_lowercase();
                    !x.is_empty() && (d == x || d.ends_with(&format!(".{x}")))
                })
            {
                return None;
            }
            if matches_domain(&d, PRIVATE_TITLE_DOMAINS) {
                ev.title = None;
                ev.url = None;
            }
            ev.domain = Some(d);
        }
    }

    if ev.kind == "search" && !cfg.include_search_terms {
        ev.title = None;
    }

    ev.title = ev
        .title
        .map(|t| scrub_text(&t))
        .filter(|t| !t.is_empty());

    ev.url = if cfg.include_paths {
        ev.url.and_then(|u| {
            // keep scheme + host + path; drop query strings and fragments
            let base = u.split(['?', '#']).next().unwrap_or("").to_string();
            if base.starts_with("http") { Some(scrub_text(&base)) } else { None }
        })
    } else {
        None
    };

    ev.app = ev.app.map(|a| a.chars().take(64).collect());
    ev.duration_ms = ev.duration_ms.clamp(0, 6 * 3_600_000);

    // Only a small, known set of numeric/label metadata survives.
    ev.meta = ev.meta.and_then(|m| {
        let obj = m.as_object()?;
        let mut out = Map::new();
        for key in ["chars", "inferred", "target", "ext", "engine", "tabCount", "windowCount", "count"] {
            if let Some(v) = obj.get(key) {
                let keep = match v {
                    Value::Number(_) | Value::Bool(_) => true,
                    Value::String(s) => s.len() <= 24,
                    _ => false,
                };
                if keep {
                    out.insert(key.to_string(), v.clone());
                }
            }
        }
        if out.is_empty() { None } else { Some(Value::Object(out)) }
    });

    Some(ev)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on() -> LearningCfg {
        LearningCfg { enabled: true, ..Default::default() }
    }

    fn ev(source: &str, kind: &str, app: Option<&str>, domain: Option<&str>, title: &str) -> Event {
        Event {
            ts: 1,
            source: source.into(),
            kind: kind.into(),
            app: app.map(String::from),
            domain: domain.map(String::from),
            title: Some(title.into()),
            url: domain.map(|d| format!("https://{d}/path/page?q=secret#frag")),
            ..Default::default()
        }
    }

    fn site(domain: &str, title: &str) -> Event {
        ev("extension", "focus", None, Some(domain), title)
    }

    fn desktop(app: &str, title: &str) -> Event {
        ev("desktop", "focus", Some(app), None, title)
    }

    #[test]
    fn learning_is_off_until_turned_on() {
        let cfg = LearningCfg::default();
        assert!(!cfg.enabled);
        assert!(admit(site("arxiv.org", "Paper"), &cfg).is_none());
        assert!(admit(desktop("code", "main.rs"), &cfg).is_none());
    }

    #[test]
    fn pausing_learning_stops_every_source() {
        let cfg = LearningCfg { enabled: false, extension: true, desktop: true, ..Default::default() };
        assert!(admit(site("arxiv.org", "Paper"), &cfg).is_none());
        assert!(admit(desktop("code", "main.rs"), &cfg).is_none());
        assert!(admit(ev("desktop", "setup", Some("Claude Code"), None, "3 MCP servers"), &cfg).is_none());
    }

    #[test]
    fn each_source_switch_works_on_its_own() {
        let no_web = LearningCfg { extension: false, ..on() };
        assert!(admit(site("arxiv.org", "Paper"), &no_web).is_none());
        assert!(admit(desktop("code", "main.rs"), &no_web).is_some());

        let no_desktop = LearningCfg { desktop: false, ..on() };
        assert!(admit(desktop("code", "main.rs"), &no_desktop).is_none());
        assert!(admit(ev("desktop", "windows", Some("windowsterminal"), None, "a · b"), &no_desktop).is_none());
        assert!(admit(site("arxiv.org", "Paper"), &no_desktop).is_some());
    }

    #[test]
    fn unknown_sources_are_refused() {
        assert!(admit(ev("", "focus", Some("code"), None, "x"), &on()).is_none());
        assert!(admit(ev("other", "focus", Some("code"), None, "x"), &on()).is_none());
    }

    #[test]
    fn sample_week_needs_no_switch_but_is_still_filtered() {
        let off = LearningCfg::default();
        assert!(admit(ev("demo", "focus", None, Some("arxiv.org"), "Paper"), &off).is_some());
        assert!(admit(ev("demo", "focus", None, Some("chase.com"), "Accounts"), &off).is_none());
    }

    #[test]
    fn apps_you_turn_off_are_never_recorded() {
        let cfg = LearningCfg { deny_apps: vec!["  Spotify ".into(), "".into()], ..on() };
        assert!(admit(desktop("spotify", "Song"), &cfg).is_none());
        assert!(admit(desktop("SpotifyHelper", "x"), &cfg).is_none());
        assert!(admit(desktop("code", "main.rs"), &cfg).is_some(), "an empty entry must not block everything");
    }

    #[test]
    fn sites_you_turn_off_are_never_recorded_with_their_subdomains() {
        let cfg = LearningCfg { deny_domains: vec!["Reddit.com".into()], ..on() };
        assert!(admit(site("reddit.com", "r/rust"), &cfg).is_none());
        assert!(admit(site("www.reddit.com", "r/rust"), &cfg).is_none());
        assert!(admit(site("old.reddit.com", "r/rust"), &cfg).is_none());
        assert!(admit(site("notreddit.com", "x"), &cfg).is_some(), "only the site and its subdomains");
    }

    #[test]
    fn password_managers_and_sign_in_screens_are_never_recorded() {
        for app in ["1password", "Bitwarden", "keepassxc", "credentialuibroker", "lockapp"] {
            assert!(admit(desktop(app, "Vault"), &on()).is_none(), "{app}");
        }
    }

    #[test]
    fn banking_health_and_login_sites_are_never_recorded() {
        for d in [
            "chase.com", "www.paypal.com", "secure.chase.com", "mybank.com", "mychart.org",
            "login.example.com", "accounts.google.com", "sso.company.com", "irs.gov",
        ] {
            assert!(admit(site(d, "Account"), &on()).is_none(), "{d}");
        }
        assert!(admit(site("arxiv.org", "Paper"), &on()).is_some());
    }

    #[test]
    fn chat_and_mail_keep_the_app_but_never_the_title() {
        let slack = admit(desktop("slack", "DM with Alice Smith"), &on()).unwrap();
        assert_eq!(slack.app.as_deref(), Some("slack"));
        assert!(slack.title.is_none());
        let gmail = admit(site("mail.google.com", "Inbox (3) - alice@example.com"), &LearningCfg { include_paths: true, ..on() }).unwrap();
        assert!(gmail.title.is_none());
        assert!(gmail.url.is_none());
    }

    #[test]
    fn browser_titles_seen_from_the_desktop_are_dropped() {
        let e = admit(desktop("chrome", "Chase: Statement for account 1234"), &on()).unwrap();
        assert_eq!(e.app.as_deref(), Some("chrome"));
        assert!(e.title.is_none());
        // Browsing reported by the add-on keeps its title (its domain was checked above).
        assert!(admit(site("arxiv.org", "Attention Is All You Need"), &on()).unwrap().title.is_some());
    }

    #[test]
    fn search_terms_are_off_unless_allowed() {
        let search = || ev("extension", "search", None, Some("google.com"), "symptoms of flu");
        assert!(admit(search(), &on()).unwrap().title.is_none());
        let allowed = LearningCfg { include_search_terms: true, ..on() };
        assert_eq!(admit(search(), &allowed).unwrap().title.as_deref(), Some("symptoms of flu"));
    }

    #[test]
    fn page_addresses_are_off_unless_allowed_and_never_keep_queries() {
        assert!(admit(site("arxiv.org", "Paper"), &on()).unwrap().url.is_none());
        let allowed = LearningCfg { include_paths: true, ..on() };
        assert_eq!(admit(site("arxiv.org", "Paper"), &allowed).unwrap().url.as_deref(), Some("https://arxiv.org/path/page"));
    }

    #[test]
    fn emails_numbers_and_tokens_are_scrubbed_from_titles() {
        let e = admit(desktop("code", "bob@example.com 4111 1111 1111 1111 ghp_abcdefghijklmnopqrstuvwxyz0123"), &on()).unwrap();
        let t = e.title.unwrap();
        assert!(!t.contains("bob@example.com") && t.contains("[email]"), "{t}");
        assert!(!t.contains("4111") && t.contains("[number]"), "{t}");
        assert!(!t.contains("ghp_") && t.contains("[id]"), "{t}");
    }

    #[test]
    fn unknown_kinds_and_extra_metadata_are_dropped() {
        assert!(admit(ev("extension", "keystrokes", None, Some("arxiv.org"), "x"), &on()).is_none());
        let mut e = site("arxiv.org", "Paper");
        e.meta = Some(serde_json::json!({ "chars": 120, "clipboard": "secret text", "tabCount": 4 }));
        let meta = admit(e, &on()).unwrap().meta.unwrap();
        assert!(meta.get("clipboard").is_none());
        assert_eq!(meta["chars"], 120);
    }

    #[test]
    fn the_open_windows_feed_uses_the_same_filter() {
        let cfg = LearningCfg { deny_apps: vec!["steam".into()], ..on() };
        assert!(live_window("1password", "Vault", &cfg).is_none());
        assert!(live_window("steam", "Library", &cfg).is_none());
        assert_eq!(live_window("outlook", "Re: salary review", &cfg), Some(("outlook".into(), None)));
        assert_eq!(live_window("msedge", "Bank of X - balance", &cfg), Some(("msedge".into(), None)));
        assert_eq!(live_window("code", "bob@example.com notes", &cfg).unwrap().1.as_deref(), Some("[email] notes"));
    }
}
