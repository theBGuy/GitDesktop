//! Reviewer-notes storage core for the MCP server's write tool and the GUI.
//!
//! **Reviewer notes are GitDesktop's own app-data deposits** — no forge or remote writes
//! are involved. An agent session deposits a per-branch note ("Notes for reviewers") keyed
//! by repo + branch; the GUI later seeds its Create-PR dialog's "Notes for reviewers" field
//! from this store. The GUI persists them via the Tauri Store plugin (`src/lib/…`); this
//! module is the headless mirror the MCP server (which has NO `AppHandle`) uses to write the
//! SAME file. It is a leaner parallel of [`crate::local_issues`] / [`crate::local_prs`] — see
//! either for the full storage-dir / Value-round-trip / statelessness contract, which applies
//! identically here (only the store filename and the record shape differ).
//!
//! ## Storage-dir mirroring contract
//!
//! `tauri-plugin-store` v2 resolves a relative store path against `BaseDirectory::AppData`
//! (`dirs::data_dir()/<identifier>`), and our identifier is `com.thebguy.gitdesktop`. So the
//! file is:
//!
//! ```text
//!   Windows: %APPDATA%\com.thebguy.gitdesktop\review-notes.json
//!   macOS:   ~/Library/Application Support/com.thebguy.gitdesktop/review-notes.json
//!   Linux:   $XDG_DATA_HOME (or ~/.local/share)/com.thebguy.gitdesktop/review-notes.json
//! ```
//!
//! We resolve it here with the SAME `dirs::data_dir()` the Tauri path layer uses, joined with
//! the identifier (reusing [`crate::local_prs::APP_IDENTIFIER`]) — so the two processes always
//! agree on the file.
//!
//! ## Shape
//!
//! ```text
//!   { "<identityKey>": { "<branchName>": { "body": string, "savedAt": string } } }
//! ```
//!
//! `identityKey` is [`crate::git::repo::repo_identity`]'s output (the worktree-stable common
//! git dir). This store is **identity-keyed from day one** — there are NO legacy checkout-path
//! keys to fold, so (unlike `local_prs`/`local_issues`) there is deliberately no
//! `consolidate`/`fold_legacy_key` machinery here. Don't add any.
//!
//! ## Value-based round-trip (never drop unknown fields)
//!
//! The whole file is read as a `serde_json::Value`, and only the target repo/branch entry is
//! mutated. Existing entries are never deserialized into a struct and re-serialized (that would
//! silently drop any field a future GUI adds); the new record is built as a small `Value`.
//! Writes are atomic (temp file in the same dir + rename over the target).
//!
//! ## Statelessness
//!
//! The GUI holds this store in memory (`autoSave`), so every call here does a FRESH
//! read → modify → atomic write. We never cache across calls.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The store filename the GUI's reviewer-notes store writes.
const STORE_FILE: &str = "review-notes.json";

/// Resolve the absolute path of the `review-notes.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — see the module contract and [`crate::local_prs`].
pub(crate) fn store_path() -> AppResult<PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(APP_IDENTIFIER).join(STORE_FILE))
}

/// Read the whole store file as a JSON object. A missing file is an empty object;
/// a present-but-malformed file is a hard error (we must never clobber it).
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "review-notes store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "review-notes store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Serialize the store object (pretty) and write it back atomically — temp file in the
/// same dir + rename over the target (via [`crate::fsops::atomic_write`]).
fn write_store(path: &Path, store: &Map<String, Value>) -> AppResult<()> {
    let body = serde_json::to_string_pretty(&Value::Object(store.clone()))
        .map_err(|e| AppError::Command(format!("serialize review-notes store: {e}")))?;
    crate::fsops::atomic_write(path, body.as_bytes())
}

/// The current UTC timestamp in JS `Date.prototype.toISOString()` format —
/// RFC3339 with millisecond precision and a `Z` suffix (e.g. `2026-06-20T20:45:33.666Z`).
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Set (upsert or clear) the reviewer note for `branch` under `repo` in the real app-data
/// store. `repo` is the worktree-stable identity key ([`crate::git::repo::repo_identity`]).
///
/// A non-empty `body` upserts `{ body, savedAt: <now> }`; a body that is empty or
/// whitespace-only CLEARS the branch entry (and removes the repo key entirely once its map
/// empties, so an emptied store stays tidy). Returns `true` when a note was saved, `false`
/// when the empty-body rule cleared the deposit.
pub fn set(repo: &str, branch: &str, body: &str) -> AppResult<bool> {
    let path = store_path()?;
    set_at(&path, repo, branch, body)
}

/// The pure store logic behind [`set`], taking an explicit path so tests can drive it against
/// a temp file without touching the real app-data store.
fn set_at(path: &Path, repo: &str, branch: &str, body: &str) -> AppResult<bool> {
    let mut store = read_store(path)?;
    let saved = if body.trim().is_empty() {
        clear_branch(&mut store, repo, branch);
        false
    } else {
        upsert_branch(&mut store, repo, branch, body);
        true
    };
    write_store(path, &store)?;
    Ok(saved)
}

/// Upsert `{ body, savedAt: <now> }` for `branch` under `repo`, creating the repo's branch
/// map if absent. Only the target branch entry is replaced — sibling branches and any unknown
/// fields on other entries are left untouched.
fn upsert_branch(store: &mut Map<String, Value>, repo: &str, branch: &str, body: &str) {
    let record = serde_json::json!({ "body": body, "savedAt": now_iso() });
    let entry = store
        .entry(repo.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(branches) = entry.as_object_mut() {
        branches.insert(branch.to_string(), record);
    } else {
        // A non-object repo entry (corrupt/foreign shape) is replaced with a fresh map
        // holding just this branch, rather than silently failing the write.
        let mut branches = Map::new();
        branches.insert(branch.to_string(), record);
        *entry = Value::Object(branches);
    }
}

/// Remove `branch` from `repo`'s map, and drop the repo key entirely if that leaves it empty.
fn clear_branch(store: &mut Map<String, Value>, repo: &str, branch: &str) {
    let Some(entry) = store.get_mut(repo) else {
        return;
    };
    let Some(branches) = entry.as_object_mut() else {
        return;
    };
    branches.remove(branch);
    if branches.is_empty() {
        store.remove(repo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These tests exercise the pure store logic (read/mutate/write over a Value map)
    // against a temp file, bypassing `store_path()` so they never touch the real
    // app-data store. `set` wraps this same logic + the fixed path.

    fn tmp_store() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "gd-review-notes-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        p
    }

    #[test]
    fn store_path_is_under_identifier_and_named() {
        let path = store_path().unwrap();
        // …/com.thebguy.gitdesktop/review-notes.json
        assert!(path.ends_with(STORE_FILE), "path: {}", path.display());
        assert!(
            path.to_string_lossy().contains(APP_IDENTIFIER),
            "path: {}",
            path.display()
        );
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let path = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn malformed_store_is_an_error_not_a_clobber() {
        let path = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is left intact.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn set_upserts_body_and_stamps_saved_at() {
        let path = tmp_store();
        let repo = "C:/repo/one/.git";
        let saved = set_at(&path, repo, "feature", "please look at the migration").unwrap();
        assert!(saved);

        let back = read_store(&path).unwrap();
        let note = &back[repo]["feature"];
        assert_eq!(note["body"], "please look at the migration");
        assert!(note["savedAt"].is_string());
        let ts = note["savedAt"].as_str().unwrap();
        assert!(ts.ends_with('Z'), "expected ISO Z suffix: {ts}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn set_overwrites_an_existing_branch_note() {
        let path = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "first").unwrap();
        set_at(&path, repo, "feature", "second").unwrap();

        let back = read_store(&path).unwrap();
        assert_eq!(back[repo]["feature"]["body"], "second");
        // Only one branch entry — an upsert, not an append.
        assert_eq!(back[repo].as_object().unwrap().len(), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn empty_body_clears_the_branch_but_keeps_siblings() {
        let path = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "note A").unwrap();
        set_at(&path, repo, "other", "note B").unwrap();

        // Clear "feature" with a whitespace-only body.
        let saved = set_at(&path, repo, "feature", "   \n\t ").unwrap();
        assert!(!saved);

        let back = read_store(&path).unwrap();
        assert!(back[repo].get("feature").is_none());
        // The sibling branch is untouched.
        assert_eq!(back[repo]["other"]["body"], "note B");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn clearing_last_branch_removes_the_repo_key() {
        let path = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "note").unwrap();
        // Clearing the only branch drops the repo key entirely.
        let saved = set_at(&path, repo, "feature", "").unwrap();
        assert!(!saved);

        let back = read_store(&path).unwrap();
        assert!(
            back.get(repo).is_none(),
            "repo key should be gone: {back:?}"
        );
        assert!(back.is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn clearing_a_missing_branch_is_a_harmless_noop() {
        let path = tmp_store();
        let repo = "C:/repo/one/.git";
        // No prior entry — clearing a never-set branch just writes an empty store.
        let saved = set_at(&path, repo, "ghost", "").unwrap();
        assert!(!saved);
        let back = read_store(&path).unwrap();
        assert!(back.is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn upsert_preserves_sibling_repos_and_unknown_fields() {
        let path = tmp_store();
        let other_repo = "C:/repo/other/.git";
        let repo = "C:/repo/one/.git";
        // Seed a store with a sibling repo carrying a note that has an unknown field, plus
        // a sibling branch under our repo.
        let mut store = Map::new();
        store.insert(
            other_repo.to_string(),
            json!({ "main": { "body": "keep me", "savedAt": "2026-01-01T00:00:00.000Z", "futureField": 7 } }),
        );
        store.insert(
            repo.to_string(),
            json!({ "sibling": { "body": "sib", "savedAt": "2026-01-01T00:00:00.000Z" } }),
        );
        write_store(&path, &store).unwrap();

        set_at(&path, repo, "feature", "new note").unwrap();

        let back = read_store(&path).unwrap();
        // The other repo's note (and its unknown field) is untouched.
        assert_eq!(back[other_repo]["main"]["body"], "keep me");
        assert_eq!(back[other_repo]["main"]["futureField"], 7);
        // Our repo now has both the sibling branch and the new one.
        assert_eq!(back[repo]["sibling"]["body"], "sib");
        assert_eq!(back[repo]["feature"]["body"], "new note");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn now_iso_matches_js_toisostring_shape() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'), "expected Z suffix: {ts}");
        let dot = ts.find('.').expect("expected millisecond fraction");
        assert_eq!(&ts[dot + 4..], "Z", "expected 3-digit millis: {ts}");
    }
}
