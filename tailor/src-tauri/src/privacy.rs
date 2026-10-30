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
        if PRIVATE_TITLE_APPS.iter().any(|p| a == *p || a.starts_with(p)) {
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
