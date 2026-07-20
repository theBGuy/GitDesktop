//! Headless reader for the per-repo Jira link store (`jira-links.json`).
//!
//! **The Jira link is GitDesktop's own app-data** — a per-repo pointer at a linked
//! Jira project (`{siteHost, projectKey, projectName}`), never written into the repo
//! itself. The GUI persists it via the Tauri Store plugin (`src/lib/jira/store.ts`);
//! this module is the headless mirror the MCP server (which has NO `AppHandle`) uses to
//! READ the SAME file so its `jira_*` tools resolve the linked project without taking a
//! `site`/`projectKey` param (the stored link is the single source of truth).
//!
//! ## Storage-dir + key mirroring (the make-or-break detail)
//!
//! Same contract as [`crate::local_prs`]: the file is
//! `dirs::data_dir()/<identifier>/jira-links.json` (the `tauri-plugin-store` v2
//! `BaseDirectory::AppData` resolution), reusing [`crate::local_prs::APP_IDENTIFIER`].
//! Entries are keyed by the repo's worktree-stable identity
//! ([`crate::git::repo::repo_identity`] — `git rev-parse --git-common-dir`), so the
//! link is shared across the main checkout and every worktree. The GUI's read path
//! ([`getJiraLink`](../src/lib/jira/store.ts)) looks up the identity key first and
//! falls back to the raw checkout path (a link created under a legacy path key, before
//! the next GUI mutation folds it onto the identity); this reader mirrors that exact
//! two-step lookup.
//!
//! ## Read-only
//!
//! The MCP server NEVER writes this file (linking happens only in the GUI), so — unlike
//! `local_prs` — there is no create/mutate/atomic-write or fold/migration machinery
//! here. A missing file, an absent entry, or a malformed *entry* all read as "no link"
//! (`None`), so a single hand-edited or partly-corrupt entry can't crash a tool call. A
//! malformed store *file* (invalid JSON — genuine corruption of the whole store)
//! deliberately surfaces an error instead of silently reading as "no link", so real
//! corruption is visible rather than masked (both behaviors are unit-tested).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// The store filename (mirrors `src/lib/jira/store.ts`'s `load("jira-links.json")`).
const STORE_FILE: &str = "jira-links.json";

/// A repo's Jira link, as the headless reader surfaces it. Mirrors the frontend
/// `JiraLink` (`src/lib/jira/store.ts`) camelCase shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraLinkEntry {
    /// The Atlassian site host, e.g. `mycompany.atlassian.net`.
    pub site_host: String,
    /// The project key, e.g. `PROJ`.
    pub project_key: String,
    /// The project's display name.
    pub project_name: String,
}

/// Resolve the absolute path of the `jira-links.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — identical to [`crate::local_prs::store_path`].
pub fn store_path() -> AppResult<PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(crate::local_prs::APP_IDENTIFIER).join(STORE_FILE))
}

/// Read the whole store file as a JSON object. A missing file → an empty object (no
/// links stored yet). Read-only: a present-but-malformed file surfaces a clear error
/// (we never look up entries in a file we couldn't parse) — but a well-formed file with
/// a malformed *entry* is handled per-entry by [`link_from_value`].
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "jira-links store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "jira-links store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Compare two repo-path keys for "same repo" tolerantly: normalize separators to
/// `/`, and treat a leading Windows drive letter case-insensitively (`C:` == `c:`).
/// Mirrors [`crate::local_prs`]'s `same_repo` so the legacy-path fallback matches the
/// GUI's tolerant key handling (a differently-spelled checkout path still resolves).
fn same_repo(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        let slashed: String = s.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
        // Lowercase only a leading "X:" drive-letter prefix.
        let bytes = slashed.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let mut out = String::with_capacity(slashed.len());
            out.push(bytes[0].to_ascii_lowercase() as char);
            out.push_str(&slashed[1..]);
            out
        } else {
            slashed
        }
    }
    norm(a) == norm(b)
}

/// Type-guard one stored value into a [`JiraLinkEntry`] — `None` when it isn't an
/// object, or any of the three required fields is missing / not a string (per-field
/// `Value::as_str` guards). A malformed entry reads as "no link" rather than erroring,
/// mirroring the frontend `asLink` guard.
fn link_from_value(value: &Value) -> Option<JiraLinkEntry> {
    let obj = value.as_object()?;
    let site_host = obj.get("siteHost").and_then(Value::as_str)?.to_string();
    let project_key = obj.get("projectKey").and_then(Value::as_str)?.to_string();
    let project_name = obj.get("projectName").and_then(Value::as_str)?.to_string();
    Some(JiraLinkEntry {
        site_host,
        project_key,
        project_name,
    })
}

/// Look up a repo's link in a loaded store map: the identity key first, then — only when
/// the identity differs from the raw checkout path — the raw path as a tolerant legacy
/// fallback (a link created under a checkout-path key before the GUI folds it onto the
/// identity). Pure so the lookup order is unit-testable against a plain map.
fn lookup(store: &Map<String, Value>, identity: &str, legacy: &str) -> Option<JiraLinkEntry> {
    // Identity key (exact) first — the canonical, worktree-stable key.
    if let Some(link) = store.get(identity).and_then(link_from_value) {
        return Some(link);
    }
    // When the resolved identity IS the raw path, there's no separate legacy entry to
    // check. Otherwise fall back to the checkout path — exact, then slash/drive-tolerant.
    if identity == legacy {
        return None;
    }
    if let Some(link) = store.get(legacy).and_then(link_from_value) {
        return Some(link);
    }
    store
        .iter()
        .find(|(k, _)| same_repo(k, legacy))
        .and_then(|(_, v)| link_from_value(v))
}

/// This repo's Jira link, or `None` when it's unlinked (no store file, no entry, or a
/// malformed entry). Read-only. Resolves the repo's worktree-stable identity
/// ([`crate::git::repo::repo_identity`]) and looks that up first, then the raw
/// `repo_path` as a tolerant legacy fallback — mirroring the GUI's `getJiraLink`.
pub async fn get_link(repo_path: &str) -> AppResult<Option<JiraLinkEntry>> {
    let identity = crate::git::repo::repo_identity(repo_path).await;
    let path = store_path()?;
    let store = read_store(&path)?;
    Ok(lookup(&store, &identity, repo_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn link_json() -> Value {
        json!({
            "siteHost": "acme.atlassian.net",
            "projectKey": "PROJ",
            "projectName": "Project X",
        })
    }

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-jira-links-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn read_missing_file_yields_no_link() {
        // The end-to-end "no store file" case: read_store → empty map → lookup None.
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        assert_eq!(lookup(&store, "C:/repo/.git", r"C:\repo"), None);
    }

    #[test]
    fn malformed_store_is_an_error_not_a_clobber() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is left intact (read-only).
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
    }

    #[test]
    fn parses_a_well_formed_entry() {
        let link = link_from_value(&link_json()).unwrap();
        assert_eq!(link.site_host, "acme.atlassian.net");
        assert_eq!(link.project_key, "PROJ");
        assert_eq!(link.project_name, "Project X");
    }

    #[test]
    fn malformed_entry_reads_as_none() {
        // Not an object.
        assert!(link_from_value(&json!("nope")).is_none());
        assert!(link_from_value(&json!(42)).is_none());
        assert!(link_from_value(&Value::Null).is_none());
        // Missing a required field.
        assert!(
            link_from_value(&json!({ "siteHost": "a.atlassian.net", "projectKey": "P" })).is_none()
        );
        // A required field of the wrong type.
        assert!(link_from_value(&json!({
            "siteHost": "a.atlassian.net",
            "projectKey": 7,
            "projectName": "X"
        }))
        .is_none());
    }

    #[test]
    fn lookup_prefers_the_identity_key() {
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let legacy = r"C:\ProjectRepos\demo\harbor";
        let mut store = Map::new();
        store.insert(identity.to_string(), link_json());
        // A DIFFERENT link under the legacy path must not shadow the identity one.
        store.insert(
            legacy.to_string(),
            json!({ "siteHost": "old.atlassian.net", "projectKey": "OLD", "projectName": "Old" }),
        );
        let link = lookup(&store, identity, legacy).unwrap();
        assert_eq!(link.site_host, "acme.atlassian.net");
    }

    #[test]
    fn lookup_falls_back_to_the_legacy_path_key() {
        // A link created under the checkout path (before a GUI mutation folds it onto
        // the identity) still resolves — exact match.
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let legacy = r"C:\ProjectRepos\demo\harbor";
        let mut store = Map::new();
        store.insert(legacy.to_string(), link_json());
        let link = lookup(&store, identity, legacy).unwrap();
        assert_eq!(link.project_key, "PROJ");
    }

    #[test]
    fn lookup_legacy_fallback_is_slash_and_drive_tolerant() {
        // The stored legacy key is spelled differently (slashes + drive case) than the
        // raw path the server was launched with — the tolerant comparator still matches.
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let stored_legacy = r"C:\ProjectRepos\demo\harbor";
        let launched_with = "c:/ProjectRepos/demo/harbor";
        let mut store = Map::new();
        store.insert(stored_legacy.to_string(), link_json());
        let link = lookup(&store, identity, launched_with).unwrap();
        assert_eq!(link.site_host, "acme.atlassian.net");
    }

    #[test]
    fn lookup_no_entry_is_none() {
        let mut store = Map::new();
        store.insert("C:/other/.git".to_string(), link_json());
        assert_eq!(lookup(&store, "C:/repo/.git", r"C:\repo"), None);
    }

    #[test]
    fn lookup_no_legacy_check_when_identity_equals_path() {
        // When repo_identity returned the raw path itself (identity == legacy), there's
        // no distinct legacy entry to consult — a malformed identity entry is just None.
        let repo = r"C:\repo";
        let mut store = Map::new();
        store.insert(repo.to_string(), json!({ "siteHost": "a.atlassian.net" })); // malformed
        assert_eq!(lookup(&store, repo, repo), None);
    }

    #[test]
    fn read_and_lookup_end_to_end_via_temp_file() {
        let (_tmp, path) = tmp_store();
        let identity = "C:/repo/reads/.git";
        let mut store = Map::new();
        store.insert(identity.to_string(), link_json());
        std::fs::write(&path, serde_json::to_vec(&Value::Object(store)).unwrap()).unwrap();

        let back = read_store(&path).unwrap();
        let link = lookup(&back, identity, "C:/repo/reads").unwrap();
        assert_eq!(link.project_key, "PROJ");
    }
}
