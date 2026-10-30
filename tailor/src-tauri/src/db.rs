use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  app         TEXT,
  domain      TEXT,
  title       TEXT,
  url         TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  meta        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  collection TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (collection, id)
);
";

/// One permissioned observation. Content (copied text, page bodies, keystrokes) is never stored.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(default)]
    pub id: i64,
    pub ts: i64,
    #[serde(default)]
    pub source: String,
    pub kind: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub meta: Option<Value>,
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

pub fn insert_events(conn: &Connection, events: &[Event]) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO events (ts, source, kind, app, domain, title, url, duration_ms, meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;
    let mut n = 0;
    for e in events {
        n += stmt.execute(params![
            e.ts,
            e.source,
            e.kind,
            e.app,
            e.domain,
            e.title,
            e.url,
            e.duration_ms,
            e.meta.as_ref().map(|m| m.to_string()),
        ])?;
    }
    Ok(n)
}

pub fn query_events(
    conn: &Connection,
    since: i64,
    until: i64,
    limit: i64,
    newest_first: bool,
) -> rusqlite::Result<Vec<Event>> {
    let sql = format!(
        "SELECT id, ts, source, kind, app, domain, title, url, duration_ms, meta
         FROM events WHERE ts >= ?1 AND ts <= ?2 ORDER BY ts {} LIMIT ?3",
        if newest_first { "DESC" } else { "ASC" }
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![since, until, limit], |r| {
        let meta: Option<String> = r.get(9)?;
        Ok(Event {
            id: r.get(0)?,
            ts: r.get(1)?,
            source: r.get(2)?,
            kind: r.get(3)?,
            app: r.get(4)?,
            domain: r.get(5)?,
            title: r.get(6)?,
            url: r.get(7)?,
            duration_ms: r.get(8)?,
            meta: meta.and_then(|m| serde_json::from_str(&m).ok()),
        })
    })?;
    rows.collect()
}

pub fn delete_events(conn: &Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare_cached("DELETE FROM events WHERE id = ?1")?;
    let mut n = 0;
    for id in ids {
        n += stmt.execute(params![id])?;
    }
    Ok(n)
}

pub fn clear_events(conn: &Connection, source: Option<&str>) -> rusqlite::Result<usize> {
    match source {
        Some(s) => conn.execute("DELETE FROM events WHERE source = ?1", params![s]),
        None => conn.execute("DELETE FROM events", []),
    }
}

pub fn delete_events_before(conn: &Connection, ts: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM events WHERE ts < ?1", params![ts])
}

pub fn kv_get(conn: &Connection, key: &str) -> Option<Value> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn kv_set(conn: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO kv (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

pub fn docs_list(conn: &Connection, collection: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt =
        conn.prepare("SELECT data FROM docs WHERE collection = ?1 ORDER BY updated_at DESC")?;
    let rows = stmt.query_map(params![collection], |r| r.get::<_, String>(0))?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect())
}

pub fn docs_put(conn: &Connection, collection: &str, id: &str, data: &Value, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO docs (collection, id, data, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![collection, id, data.to_string(), now],
    )?;
    Ok(())
}

pub fn docs_delete(conn: &Connection, collection: &str, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM docs WHERE collection = ?1 AND id = ?2",
        params![collection, id],
    )
}
