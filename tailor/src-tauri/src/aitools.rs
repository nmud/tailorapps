//! Looks at how the person's AI tools are set up: which MCP servers, connectors, plugins and
//! skills each one has. Reads names only. Commands, arguments, URLs, headers and keys inside
//! these config files are never read out or stored.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct AiTool {
    /// The app the item belongs to, e.g. "Claude Code".
    pub app: String,
    /// mcp-server | connector | plugin | skill
    pub kind: String,
    pub name: String,
    /// user | project | plugin | cloud
    pub scope: String,
    /// Project folder name for project-scoped servers.
    pub project: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming"))
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Server names from an `mcpServers`/`servers` object, or a bare map of server definitions.
fn server_names(v: &Value) -> Vec<String> {
    let map = v
        .get("mcpServers")
        .or_else(|| v.get("servers"))
        .and_then(|m| m.as_object())
        .or_else(|| {
            v.as_object().filter(|o| {
                o.values().all(|s| s.get("command").is_some() || s.get("url").is_some() || s.get("type").is_some())
            })
        });
    map.map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

fn push(out: &mut Vec<AiTool>, app: &str, kind: &str, name: String, scope: &str, project: Option<String>) {
    let name: String = name.chars().take(60).collect();
    if !name.is_empty() {
        out.push(AiTool { app: app.into(), kind: kind.into(), name, scope: scope.into(), project });
    }
}

fn claude_code(out: &mut Vec<AiTool>) {
    let app = "Claude Code";
    let home = home();
    if let Some(cfg) = read_json(&home.join(".claude.json")) {
        for name in server_names(&cfg) {
            push(out, app, "mcp-server", name, "user", None);
        }
        if let Some(projects) = cfg.get("projects").and_then(|p| p.as_object()) {
            for (path, p) in projects {
                let folder = Path::new(path).file_name().map(|f| f.to_string_lossy().to_string());
                if let Some(servers) = p.get("mcpServers").and_then(|m| m.as_object()) {
                    for name in servers.keys() {
                        push(out, app, "mcp-server", name.clone(), "project", folder.clone());
                    }
                }
            }
        }
        if let Some(connectors) = cfg.get("claudeAiMcpEverConnected").and_then(|c| c.as_array()) {
            for c in connectors.iter().filter_map(|c| c.as_str()) {
                push(out, app, "connector", c.trim_start_matches("claude.ai ").to_string(), "cloud", None);
            }
        }
    }

    // Plugins the person turned on, and any MCP servers they bring.
    let enabled = read_json(&home.join(".claude/settings.json"))
        .and_then(|s| s.get("enabledPlugins").cloned())
        .and_then(|e| e.as_object().cloned())
        .unwrap_or_default();
    let installed = read_json(&home.join(".claude/plugins/installed_plugins.json"));
    for (id, on) in &enabled {
        if on.as_bool() != Some(true) {
            continue;
        }
        let name = id.split('@').next().unwrap_or(id).to_string();
        push(out, app, "plugin", name.clone(), "user", None);
        let install_path = installed
            .as_ref()
            .and_then(|i| i["plugins"][id].as_array().and_then(|a| a.last().cloned()))
            .and_then(|p| p["installPath"].as_str().map(PathBuf::from));
        if let Some(mcp) = install_path.and_then(|p| read_json(&p.join(".mcp.json"))) {
            for server in server_names(&mcp) {
                push(out, app, "mcp-server", server, "plugin", Some(name.clone()));
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(home.join(".claude/skills")) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                push(out, app, "skill", e.file_name().to_string_lossy().to_string(), "user", None);
            }
        }
    }
}

fn simple(out: &mut Vec<AiTool>, app: &str, path: PathBuf) {
    if let Some(cfg) = read_json(&path) {
        for name in server_names(&cfg) {
            push(out, app, "mcp-server", name, "user", None);
        }
    }
}

pub fn scan() -> Vec<AiTool> {
    let mut out = vec![];
    claude_code(&mut out);
    simple(&mut out, "Claude Desktop", appdata().join("Claude/claude_desktop_config.json"));
    simple(&mut out, "Cursor", home().join(".cursor/mcp.json"));
    simple(&mut out, "Windsurf", home().join(".codeium/windsurf/mcp_config.json"));
    simple(&mut out, "VS Code", appdata().join("Code/User/mcp.json"));
    out
}

/// One line per app for the activity log, e.g. "9 MCP servers, 5 connectors, 4 plugins, 23 skills".
pub fn summarize(tools: &[AiTool]) -> Vec<(String, usize, String)> {
    let mut apps: Vec<String> = tools.iter().map(|t| t.app.clone()).collect();
    apps.dedup();
    apps.sort();
    apps.dedup();
    apps.into_iter()
        .map(|app| {
            let items: Vec<&AiTool> = tools.iter().filter(|t| t.app == app).collect();
            let count = |k: &str| items.iter().filter(|t| t.kind == k).count();
            let parts: Vec<String> = [
                ("mcp-server", "MCP servers"),
                ("connector", "connectors"),
                ("plugin", "plugins"),
                ("skill", "skills"),
            ]
            .iter()
            .filter(|(k, _)| count(k) > 0)
            .map(|(k, label)| format!("{} {label}", count(k)))
            .collect();
            (app, items.len(), parts.join(", "))
        })
        .collect()
}
