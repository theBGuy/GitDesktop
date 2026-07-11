//! Per-site Jira custom-field discovery cache (agile fields — phase 4).
//!
//! Story points and sprint live in per-TENANT `customfield_NNNNN` ids (the numeric id
//! differs from one Jira site to the next), so before the issue-list / issue-view field
//! lists can request them, we must discover them. This module is the persisted cache of
//! that discovery, keyed by site HOST (several repos can share one site).
//!
//! ## Storage-dir mirroring contract (same as [`crate::local_prs`])
//!
//! The file is `jira-field-maps.json` under `dirs::data_dir()/<APP_IDENTIFIER>/` — the
//! very directory the Tauri Store plugin resolves `BaseDirectory::AppData` to (see the
//! `local_prs` module docs for the derivation). Both the GUI process AND the headless MCP
//! server process discover against the same Jira sites, so both read and write this one
//! file — writes are therefore atomic (temp file + rename via
//! [`crate::fsops::atomic_write`]), and we NEVER assume single-process ownership.
//!
//! ```text
//!   Windows: %APPDATA%\com.thebguy.gitdesktop\jira-field-maps.json
//!   macOS:   ~/Library/Application Support/com.thebguy.gitdesktop/jira-field-maps.json
//!   Linux:   $XDG_DATA_HOME (or ~/.local/share)/com.thebguy.gitdesktop/jira-field-maps.json
//! ```
//!
//! JSON shape:
//!
//! ```json
//! { "<siteHost>": { "storyPointsFieldId": "customfield_10016" | null,
//!                   "sprintFieldId": "customfield_10020" | null,
//!                   "resolvedAt": "2026-07-11T00:00:00.000Z" } }
//! ```
//!
//! ## This is a CACHE — tolerance differs from [`crate::jira_links`] on purpose
//!
//! `jira_links.rs` treats a malformed file as a hard error (it holds user intent we must
//! never silently drop). This file holds only DISCOVERED data we can always re-derive, so
//! the tolerance is the opposite: a malformed/unreadable file, or a malformed individual
//! entry, degrades to "no entry" — which triggers rediscovery and an overwrite — and is
//! NEVER surfaced as an error to the caller. Discovery is best-effort; a site legitimately
//! without agile fields caches an all-`None` entry so we don't re-probe it every call.
//!
//! ## Two in-process layers
//!
//! 1. The persisted [`SiteFieldMap`] per site, mirrored in an `OnceLock<Mutex<HashMap>>`
//!    so a warm process answers from memory without touching disk.
//! 2. An in-process-ONLY (never persisted) full field-NAME map per site
//!    (`field id → display name`), populated at discovery time and consumed by the error
//!    translation in [`crate::forge::jira`] to render `customfield_10016` as
//!    `Story point estimate`. It is intentionally not persisted — it is large, changes
//!    rarely matter, and the error path must never do I/O.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::local_prs::APP_IDENTIFIER;

/// The store filename under the app-data dir.
const STORE_FILE: &str = "jira-field-maps.json";

/// The discovered agile custom-field ids for one Jira site, plus when we resolved them.
/// Both ids are `Option` — a site legitimately without a given agile field caches `None`
/// (so we don't re-probe it forever). Serialized to / from `jira-field-maps.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteFieldMap {
    /// `customfield_NNNNN` for the story-points estimate field, or `None`.
    #[serde(default)]
    pub story_points_field_id: Option<String>,
    /// `customfield_NNNNN` for the sprint field, or `None`.
    #[serde(default)]
    pub sprint_field_id: Option<String>,
    /// RFC3339 timestamp of the discovery that produced this entry.
    #[serde(default)]
    pub resolved_at: String,
}

/// The in-process mirror of the persisted per-site map. Populated lazily: a hit here
/// answers without disk I/O; a miss falls back to reading the file (then caches).
static CACHE: OnceLock<Mutex<HashMap<String, SiteFieldMap>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, SiteFieldMap>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The in-process-ONLY full field-name map per site (`field id → display name`), never
/// persisted. Populated at discovery time from the `/field` response; consumed by the
/// error translation so a `customfield_NNNNN` key renders as its human name. Empty for a
/// site until its first discovery in THIS process (the error path then falls back to raw
/// ids — today's behavior).
static NAME_MAPS: OnceLock<Mutex<HashMap<String, HashMap<String, String>>>> = OnceLock::new();

fn name_maps() -> &'static Mutex<HashMap<String, HashMap<String, String>>> {
    NAME_MAPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the absolute path of `jira-field-maps.json` under the app-data dir. Mirrors
/// [`crate::local_prs::store_path`] (same `dirs::data_dir()/<identifier>` root).
fn store_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER).join(STORE_FILE))
}

/// Read the whole store file as a JSON object. Because this is a CACHE, ANY failure —
/// missing file, unreadable file, non-JSON, or a non-object top level — degrades to an
/// empty map rather than an error (the caller re-discovers and overwrites).
fn read_store(path: &Path) -> Map<String, Value> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        },
        Err(_) => Map::new(),
    }
}

/// Look up a site's cached map: in-process cache first, then the on-disk store (caching
/// the result). Returns `None` when the site has no persisted entry yet (a discovery is
/// warranted) — a malformed entry is treated as absent (tolerance contract). Never errors.
pub fn get(site: &str) -> Option<SiteFieldMap> {
    if let Some(entry) = cache().lock().ok().and_then(|c| c.get(site).cloned()) {
        return Some(entry);
    }
    let path = store_path()?;
    let store = read_store(&path);
    let raw = store.get(site)?;
    // A malformed entry (wrong shape) degrades to "absent" → rediscovery + overwrite.
    let entry: SiteFieldMap = serde_json::from_value(raw.clone()).ok()?;
    if let Ok(mut c) = cache().lock() {
        c.insert(site.to_string(), entry.clone());
    }
    Some(entry)
}

/// Persist a discovered map for a site: read → modify → atomic write (the `local_prs`
/// pattern, tolerant of concurrent GUI/MCP writers), and update the in-process cache. A
/// write failure is swallowed (best-effort cache) after the in-process cache is set, so a
/// warm process still answers from memory even if the disk write couldn't land. Never
/// errors to the caller.
pub fn put(site: &str, entry: SiteFieldMap) {
    if let Ok(mut c) = cache().lock() {
        c.insert(site.to_string(), entry.clone());
    }
    let Some(path) = store_path() else {
        return;
    };
    let mut store = read_store(&path);
    let Ok(value) = serde_json::to_value(&entry) else {
        return;
    };
    store.insert(site.to_string(), value);
    if let Ok(body) = serde_json::to_string_pretty(&Value::Object(store)) {
        // Best-effort: a failed disk write leaves the in-process cache authoritative for
        // this process; the next process rediscovers.
        let _ = crate::fsops::atomic_write(&path, body.as_bytes());
    }
}

/// Store the in-process-only full field-name map (`field id → display name`) for a site,
/// captured at discovery time. Overwrites any prior map for the site. Never persisted.
pub fn set_name_map(site: &str, names: HashMap<String, String>) {
    if let Ok(mut m) = name_maps().lock() {
        m.insert(site.to_string(), names);
    }
}

/// The display name for a single field id on a site, from the in-process name map. `None`
/// when the site has no name map in this process yet (no discovery happened), or the id is
/// unknown — the error path then renders the raw id (today's behavior). NO disk / network
/// I/O: the error path must stay pure.
pub fn field_name(site: &str, field_id: &str) -> Option<String> {
    name_maps()
        .lock()
        .ok()
        .and_then(|m| m.get(site).and_then(|names| names.get(field_id).cloned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_store() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "gd-jira-field-maps-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        p
    }

    #[test]
    fn site_field_map_round_trips_through_json() {
        let entry = SiteFieldMap {
            story_points_field_id: Some("customfield_10016".to_string()),
            sprint_field_id: Some("customfield_10020".to_string()),
            resolved_at: "2026-07-11T00:00:00.000Z".to_string(),
        };
        // camelCase on the wire.
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["storyPointsFieldId"], "customfield_10016");
        assert_eq!(v["sprintFieldId"], "customfield_10020");
        assert_eq!(v["resolvedAt"], "2026-07-11T00:00:00.000Z");
        let back: SiteFieldMap = serde_json::from_value(v).unwrap();
        assert_eq!(back, entry);
    }

    #[test]
    fn read_store_round_trips_via_disk() {
        let path = tmp_store();
        let mut store = Map::new();
        store.insert(
            "team.atlassian.net".to_string(),
            json!({
                "storyPointsFieldId": "customfield_10016",
                "sprintFieldId": null,
                "resolvedAt": "2026-07-11T00:00:00.000Z"
            }),
        );
        let body = serde_json::to_string_pretty(&Value::Object(store)).unwrap();
        crate::fsops::atomic_write(&path, body.as_bytes()).unwrap();

        let back = read_store(&path);
        let entry: SiteFieldMap =
            serde_json::from_value(back["team.atlassian.net"].clone()).unwrap();
        assert_eq!(
            entry.story_points_field_id.as_deref(),
            Some("customfield_10016")
        );
        assert!(entry.sprint_field_id.is_none());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn malformed_file_degrades_to_empty_map() {
        // A CACHE — a garbage file is not an error; it reads as empty (→ rediscovery).
        let path = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        assert!(read_store(&path).is_empty());
        // A JSON non-object also degrades to empty.
        std::fs::write(&path, b"[1, 2, 3]").unwrap();
        assert!(read_store(&path).is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_file_degrades_to_empty_map() {
        let path = tmp_store();
        assert!(read_store(&path).is_empty());
    }

    #[test]
    fn malformed_entry_deserializes_to_absent() {
        // A present-but-malformed entry (wrong types) → treated as absent by `get`'s
        // deserialize-tolerant path. We exercise the deserialize directly since `get`
        // reads the real app-data store.
        let raw = json!({ "storyPointsFieldId": 12345 }); // wrong type (number, not string)
        assert!(serde_json::from_value::<SiteFieldMap>(raw).is_err());
        // A well-formed but partial entry (only resolvedAt) is fine — ids default to None.
        let partial = json!({ "resolvedAt": "2026-07-11T00:00:00.000Z" });
        let entry: SiteFieldMap = serde_json::from_value(partial).unwrap();
        assert!(entry.story_points_field_id.is_none());
        assert!(entry.sprint_field_id.is_none());
    }

    #[test]
    fn name_map_lookup_in_process() {
        let site = "names-test.atlassian.net";
        // Nothing set yet → None (error path renders raw id).
        assert!(field_name(site, "customfield_10016").is_none());
        let mut names = HashMap::new();
        names.insert(
            "customfield_10016".to_string(),
            "Story point estimate".to_string(),
        );
        set_name_map(site, names);
        assert_eq!(
            field_name(site, "customfield_10016").as_deref(),
            Some("Story point estimate")
        );
        // Unknown id → None.
        assert!(field_name(site, "customfield_99999").is_none());
    }
}
