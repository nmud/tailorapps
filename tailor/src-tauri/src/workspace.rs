//! The builder runtime. Generated apps live in `<data>/workspace/apps/<slug>/` and share
//! one `node_modules` (React, Vite, lucide-react) installed once. The Builder agent can
//! write only inside an app's `src/`; Tailor owns `index.html`, `main.tsx` and `tailor.css`.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::appserver::valid_slug;

/// Files Tailor writes into every app and the Builder may not touch.
pub const PROTECTED: &[&str] = &["src/main.tsx", "src/tailor.css", "src/tailor.ts"];
const ALLOWED_EXT: &[&str] = &["tsx", "ts", "css", "json"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub ready: bool,
    pub node_version: Option<String>,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    pub ok: bool,
    pub errors: Vec<String>,
    pub duration_ms: u64,
    /// The build tooling itself failed (not the app's code), so the Builder can't fix it.
    pub crashed: bool,
}

/// Node used when the computer doesn't have a recent one (most people don't).
const PRIVATE_NODE: &str = "22.20.0";

/// Which Node runs builds: the system's, or Tailor's own copy in `<workspace>/node`.
#[derive(Clone)]
enum Node {
    System,
    Private(PathBuf),
}

fn hide_window(c: &mut Command) {
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = c;
}

fn private_node_dir(workspace: &Path) -> PathBuf {
    workspace.join("node").join(format!("node-v{PRIVATE_NODE}-win-x64"))
}

impl Node {
    fn node(&self) -> Command {
        let mut c = match self {
            // `node` may be a shim, so go through cmd on Windows.
            Node::System if cfg!(windows) => {
                let mut c = Command::new("cmd");
                c.args(["/C", "node"]);
                c
            }
            Node::System => Command::new("node"),
            Node::Private(dir) => {
                let mut c = Command::new(dir.join("node.exe"));
                let path = std::env::var_os("PATH").unwrap_or_default();
                let mut paths = vec![dir.clone()];
                paths.extend(std::env::split_paths(&path));
                c.env("PATH", std::env::join_paths(paths).unwrap_or_default());
                c
            }
        };
        hide_window(&mut c);
        c
    }

    fn npm(&self) -> Command {
        match self {
            Node::System if cfg!(windows) => {
                let mut c = Command::new("cmd");
                c.args(["/C", "npm"]);
                hide_window(&mut c);
                c
            }
            Node::System => Command::new("npm"),
            Node::Private(dir) => {
                let mut c = self.node();
                c.arg(dir.join("node_modules/npm/bin/npm-cli.js"));
                c
            }
        }
    }

    async fn version(&self) -> Option<String> {
        let out = self.node().arg("--version").output().await.ok()?;
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let major: u32 = v.trim_start_matches('v').split('.').next()?.parse().ok()?;
        (out.status.success() && major >= 20).then_some(v)
    }
}

async fn find_node(workspace: &Path) -> Option<(Node, String)> {
    let private = Node::Private(private_node_dir(workspace));
    if private_node_dir(workspace).join("node.exe").is_file() {
        if let Some(v) = private.version().await {
            return Some((private, v));
        }
    }
    Node::System.version().await.map(|v| (Node::System, v))
}

/// Download Node from nodejs.org, check it against the published SHA-256, and unpack it.
#[cfg(windows)]
async fn install_private_node(workspace: &Path, log: &Channel<String>) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    const FAIL: &str = "Tailor couldn't download what it needs to build apps. Check your internet connection and try again.";

    let file = format!("node-v{PRIVATE_NODE}-win-x64.zip");
    let base = format!("https://nodejs.org/dist/v{PRIVATE_NODE}");
    let http = reqwest::Client::new();
    let sums = http
        .get(format!("{base}/SHASUMS256.txt"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| FAIL.to_string())?
        .text()
        .await
        .map_err(|_| FAIL.to_string())?;
    let expected = sums
        .lines()
        .find(|l| l.ends_with(&file))
        .and_then(|l| l.split_whitespace().next())
        .ok_or(FAIL)?
        .to_lowercase();

    let _ = log.send("Downloading build tools (one time, about 30 MB)".into());
    let resp = http
        .get(format!("{base}/{file}"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| FAIL.to_string())?;
    let total = resp.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    let mut next_report = 25u64;
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        bytes.extend_from_slice(&chunk.map_err(|_| FAIL.to_string())?);
        if total > 0 && bytes.len() as u64 * 100 / total >= next_report {
            let _ = log.send(format!("Downloaded {next_report}%"));
            next_report += 25;
        }
    }
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err("The download didn't match its checksum, so Tailor discarded it. Please try again.".into());
    }

    let _ = log.send("Unpacking build tools".into());
    let target = workspace.join("node");
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&target);
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        archive.extract(&target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}

#[cfg(not(windows))]
async fn install_private_node(_: &Path, _: &Channel<String>) -> Result<(), String> {
    Err("Install Node.js 20 or newer so Tailor can build apps.".into())
}

pub async fn status(workspace: &Path) -> WorkspaceStatus {
    WorkspaceStatus {
        ready: workspace.join("node_modules/vite").is_dir()
            && workspace.join("node_modules/react").is_dir()
            && workspace.join("build.mjs").is_file(),
        node_version: find_node(workspace).await.map(|(_, v)| v),
        path: workspace.to_string_lossy().to_string(),
    }
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Refresh Tailor-owned files from the bundled template and install dependencies once.
pub async fn prepare(template: &Path, workspace: &Path, log: &Channel<String>) -> Result<WorkspaceStatus, String> {
    if !template.is_dir() {
        return Err(format!("Tailor is missing some of its files ({}). Please reinstall Tailor.", template.display()));
    }
    for name in ["package.json", "build.mjs"] {
        std::fs::copy(template.join(name), workspace.join(name)).map_err(|e| e.to_string())?;
    }
    copy_tree(&template.join("template"), &workspace.join("template")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(workspace.join("apps")).map_err(|e| e.to_string())?;

    let node = match find_node(workspace).await {
        Some((node, _)) => node,
        None => {
            install_private_node(workspace, log).await?;
            find_node(workspace)
                .await
                .map(|(n, _)| n)
                .ok_or("Tailor couldn't set up its build tools. Please try again.")?
        }
    };

    let st = status(workspace).await;
    if st.ready {
        return Ok(st);
    }
    let _ = log.send("Installing the shared app runtime (React, Vite). This happens once.".into());
    let mut child = node
        .npm()
        .args(["install", "--no-audit", "--no-fund", "--loglevel=error"])
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run npm: {e}"))?;
    if let Some(stderr) = child.stderr.take() {
        let log = log.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = log.send(line);
            }
        });
    }
    let status_code = child.wait().await.map_err(|e| e.to_string())?;
    if !status_code.success() {
        return Err("Tailor couldn't download what it needs to build apps. Check your internet connection and try again.".into());
    }
    let _ = log.send("Runtime installed".into());
    Ok(status(workspace).await)
}

pub fn app_dir(workspace: &Path, slug: &str) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("Invalid app id: {slug}"));
    }
    Ok(workspace.join("apps").join(slug))
}

/// Create (or refresh the Tailor-owned files of) an app and write its manifest.
pub fn create_app(workspace: &Path, slug: &str, manifest: &Value) -> Result<(), String> {
    let dir = app_dir(workspace, slug)?;
    let template = workspace.join("template");
    if !template.is_dir() {
        return Err("Builder runtime is not prepared yet.".into());
    }
    let fresh = !dir.join("src/App.tsx").is_file();
    for rel in ["index.html", "src/main.tsx", "src/tailor.css", "src/tailor.ts", "public/tailor-runtime.js"] {
        let target = dir.join(rel);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::copy(template.join(rel), &target).map_err(|e| format!("{rel}: {e}"))?;
    }
    if fresh {
        for rel in ["src/App.tsx", "src/app.css"] {
            std::fs::copy(template.join(rel), dir.join(rel)).map_err(|e| format!("{rel}: {e}"))?;
        }
    }
    let pretty = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("tailor.json"), pretty).map_err(|e| e.to_string())
}

fn check_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    let path = PathBuf::from(&rel);
    let normal = path.components().all(|c| matches!(c, Component::Normal(_)));
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_EXT.contains(&e))
        .unwrap_or(false);
    let name_ok = rel
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_'));
    if !rel.starts_with("src/") || !normal || !ext_ok || !name_ok {
        return Err(format!("Refused to write {rel}: apps may only write .tsx/.ts/.css/.json files under src/"));
    }
    if PROTECTED.contains(&rel.as_str()) {
        return Err(format!("Refused to write {rel}: this file is managed by Tailor"));
    }
    Ok(path)
}

fn collect(dir: &Path, root: &Path, out: &mut Vec<SourceFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, root, out);
        } else if let Ok(content) = std::fs::read_to_string(&path) {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !PROTECTED.contains(&rel.as_str()) {
                out.push(SourceFile { path: rel, content });
            }
        }
    }
}

pub fn read_files(workspace: &Path, slug: &str) -> Result<Vec<SourceFile>, String> {
    let dir = app_dir(workspace, slug)?;
    let mut out = vec![];
    collect(&dir.join("src"), &dir, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Write files; `replace` first removes every Builder-owned file (used to restore a version).
pub fn write_files(
    workspace: &Path,
    slug: &str,
    files: &[SourceFile],
    delete: &[String],
    replace: bool,
) -> Result<Vec<String>, String> {
    let dir = app_dir(workspace, slug)?;
    let checked: Vec<(PathBuf, &SourceFile)> = files
        .iter()
        .map(|f| check_rel(&f.path).map(|p| (p, f)))
        .collect::<Result<_, _>>()?;
    if replace {
        for f in read_files(workspace, slug)? {
            let _ = std::fs::remove_file(dir.join(&f.path));
        }
    }
    for rel in delete {
        if let Ok(p) = check_rel(rel) {
            let _ = std::fs::remove_file(dir.join(p));
        }
    }
    let mut written = vec![];
    for (rel, f) in checked {
        let target = dir.join(&rel);
        std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&target, &f.content).map_err(|e| e.to_string())?;
        written.push(f.path.clone());
    }
    Ok(written)
}

pub async fn build(workspace: &Path, slug: &str) -> Result<BuildResult, String> {
    let dir = app_dir(workspace, slug)?;
    if !dir.is_dir() {
        return Err(format!("App {slug} does not exist"));
    }
    let started = Instant::now();
    let rel = format!("apps/{slug}");
    let (node, _) = find_node(workspace)
        .await
        .ok_or("Tailor's build tools aren't ready yet. Please try again.")?;
    let child = node
        .node()
        .args(["build.mjs", &rel])
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start node: {e}"))?;
    let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output())
        .await
        .map_err(|_| "Build timed out after 3 minutes".to_string())?
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<Value>(l.trim()).ok().filter(|v| v.get("ok").is_some()));
    let duration_ms = started.elapsed().as_millis() as u64;
    match parsed {
        Some(v) => Ok(BuildResult {
            ok: v["ok"].as_bool().unwrap_or(false),
            errors: v["errors"]
                .as_array()
                .map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            duration_ms,
            crashed: false,
        }),
        None => Ok(BuildResult {
            ok: false,
            errors: vec![format!(
                "Build tooling crashed: {}",
                String::from_utf8_lossy(&output.stderr).chars().take(2000).collect::<String>()
            )],
            duration_ms,
            crashed: true,
        }),
    }
}

pub fn delete_app(workspace: &Path, slug: &str) -> Result<(), String> {
    let dir = app_dir(workspace, slug)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}
