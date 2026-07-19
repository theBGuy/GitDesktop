//! The persisted shared-repos store for the LAN companion's multi-repo registry.
//!
//! Registry v1 mirrored the desktop's active repo exactly; this store is the
//! browse-all-repos direction the registry doc comment promised: a user-curated
//! set of repos the companion serves ALONGSIDE the active repo (active ∪ shared).
//! Only the on-disk `path` is persisted — the display `name` (basename) and the
//! opaque wire id (`repo_id_for`) are computed at load/share time, never stored, so
//! the store file never carries a wire id it could drift from.
//!
//! ## Persistence idiom (mirrors [`crate::lan::auth`]'s device store exactly)
//!
//! File `lan-shared-repos.json` under the same app-data dir as `lan-devices.json`,
//! a top-level object `{"repos":[{"path":"…"}]}` whose unknown top-level keys are
//! preserved across writes, all sync I/O serialized behind [`store_lock`] (never
//! held across an `.await`), written via [`crate::fsops::atomic_write`], and cached
//! in a process-global [`OnceLock`] invalidated on every write and on a test
//! store-path swap. App-global (NOT per-repo): sharing is an app-level decision.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The shared-repos store filename under the app-data dir. Rust-owned and
/// app-global (NOT per-repo), like [`crate::lan::auth`]'s `lan-devices.json`.
const STORE_FILE: &str = "lan-shared-repos.json";

// --------------------------------------------------------------------------
// Store-path injection (for tests) — mirrors auth.rs
// --------------------------------------------------------------------------

/// Test-only override for the store path. Production resolves the real app-data
/// file via [`store_path`]; tests point this at a temp file so they never touch
/// the real `%APPDATA%\com.thebguy.gitdesktop` dir.
static STORE_PATH_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn store_path_override() -> &'static Mutex<Option<PathBuf>> {
    STORE_PATH_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Point the shared-repos store at `path` for the current process (test-only).
/// Returns the previous override so a test can restore it. Invalidates the cache
/// (it holds entries from the previous path's file).
#[cfg(test)]
pub(crate) fn set_store_path_for_test(path: Option<PathBuf>) -> Option<PathBuf> {
    let mut guard = store_path_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    invalidate_cache();
    std::mem::replace(&mut *guard, path)
}

/// Resolve the absolute path of `lan-shared-repos.json` under the app-data dir —
/// the same root [`crate::lan::auth`]'s device store uses. A test override wins.
fn store_path() -> AppResult<PathBuf> {
    if let Some(over) = store_path_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Ok(over);
    }
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(APP_IDENTIFIER).join(STORE_FILE))
}

/// Serializes the whole read-modify-write of the store across the sync I/O only.
/// Never held across an `.await`.
fn store_lock() -> &'static Mutex<()> {
    static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

/// In-memory cache of the on-disk shared-repo paths, so repeated reads don't
/// re-parse the file. `None` = not loaded; every write invalidates it back to
/// `None`. Guarded by its own mutex, always taken WHILE holding [`store_lock`].
static CACHE: OnceLock<Mutex<Option<Vec<String>>>> = OnceLock::new();

fn cache() -> &'static Mutex<Option<Vec<String>>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Drop the in-memory cache. Called on every store write and on a test store-path
/// swap, so the next read reloads from disk.
fn invalidate_cache() {
    *cache().lock().unwrap_or_else(|p| p.into_inner()) = None;
}

// --------------------------------------------------------------------------
// Records
// --------------------------------------------------------------------------

/// A persisted shared-repo record. Only the on-disk `path` is stored; the display
/// name and wire id are computed from it at load/share time (never persisted).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredRepo {
    path: String,
}

/// Read the whole store file as a JSON object. A missing file is an empty object;
/// a present-but-malformed file is a hard error (never clobber it — it holds the
/// user's curated share list we must not silently drop).
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "lan-shared-repos store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "lan-shared-repos store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// The stored repo paths under the `"repos"` array key. Unknown top-level keys are
/// preserved by [`write_repos`], which replaces only the `"repos"` key.
fn repos_from(store: &Map<String, Value>) -> Vec<String> {
    store
        .get("repos")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<StoredRepo>(v.clone()).ok())
                .map(|r| r.path)
                .collect()
        })
        .unwrap_or_default()
}

/// Persist `paths` as the `"repos"` array, atomically. `store` is the
/// previously-read store map (from [`read_store`] under the store lock); we
/// replace only its `"repos"` key so unknown top-level keys survive.
fn write_repos(path: &Path, mut store: Map<String, Value>, paths: &[String]) -> AppResult<()> {
    let arr = paths
        .iter()
        .map(|p| serde_json::to_value(StoredRepo { path: p.clone() }).unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    store.insert("repos".to_string(), Value::Array(arr));
    let body = serde_json::to_string_pretty(&Value::Object(store))
        .map_err(|e| AppError::Command(format!("serialize lan-shared-repos store: {e}")))?;
    let res = crate::fsops::atomic_write(path, body.as_bytes());
    // Invalidate at this single write choke point so no write path leaves a stale
    // cache — even on a failed write (on-disk state is then indeterminate).
    invalidate_cache();
    res
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/// The persisted shared-repo paths, in stored order. Backed by the in-memory
/// cache: on a miss the store is read under the store lock and the cache
/// populated; every write invalidates it.
pub fn list_paths() -> AppResult<Vec<String>> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut c = cache().lock().unwrap_or_else(|p| p.into_inner());
    if c.is_none() {
        let store = read_store(&path)?;
        *c = Some(repos_from(&store));
    }
    Ok(c.as_ref().expect("cache populated above").clone())
}

/// Add `repo_path` to the shared set if not already present (verbatim string
/// match). Returns the updated list. The caller resolves id-level dedup BEFORE
/// calling this (two worktree paths of one repo collide on id, not on string); a
/// verbatim duplicate here is a no-op.
pub fn add_path(repo_path: &str) -> AppResult<Vec<String>> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path)?;
    let mut paths = repos_from(&store);
    if !paths.iter().any(|p| p == repo_path) {
        paths.push(repo_path.to_string());
        write_repos(&path, store, &paths)?;
    }
    Ok(paths)
}

/// Remove `repo_path` from the shared set (verbatim string match). Returns the
/// updated list. An unknown path is a no-op returning the current list.
pub fn remove_path(repo_path: &str) -> AppResult<Vec<String>> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path)?;
    let mut paths = repos_from(&store);
    let before = paths.len();
    paths.retain(|p| p != repo_path);
    if paths.len() != before {
        write_repos(&path, store, &paths)?;
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_store() -> PathBuf {
        std::env::temp_dir().join(format!(
            "gd-lan-shared-repos-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn store_round_trips_and_dedups_verbatim() {
        let _lock = crate::lan::auth::store_test_lock();
        let tmp = temp_store();
        let prev = set_store_path_for_test(Some(tmp.clone()));

        // Empty to start.
        assert!(list_paths().unwrap().is_empty());

        // Add two, verbatim-dedup the first.
        add_path("C:/repo-a").unwrap();
        let after = add_path("C:/repo-b").unwrap();
        assert_eq!(after, vec!["C:/repo-a", "C:/repo-b"]);
        let dup = add_path("C:/repo-a").unwrap();
        assert_eq!(
            dup,
            vec!["C:/repo-a", "C:/repo-b"],
            "verbatim add is a no-op"
        );
        assert_eq!(list_paths().unwrap(), vec!["C:/repo-a", "C:/repo-b"]);

        // Remove one; an unknown remove is a no-op.
        let removed = remove_path("C:/repo-a").unwrap();
        assert_eq!(removed, vec!["C:/repo-b"]);
        let noop = remove_path("C:/does-not-exist").unwrap();
        assert_eq!(noop, vec!["C:/repo-b"]);

        // Survives a fresh read (reads disk with the cache cleared).
        invalidate_cache();
        assert_eq!(list_paths().unwrap(), vec!["C:/repo-b"]);

        set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn unknown_top_level_keys_survive_a_write() {
        let _lock = crate::lan::auth::store_test_lock();
        let tmp = temp_store();
        let prev = set_store_path_for_test(Some(tmp.clone()));

        // Seed a store with a repo AND an extra top-level key a future version wrote.
        add_path("C:/repo-a").unwrap();
        let mut raw: Value = serde_json::from_slice(&std::fs::read(&tmp).unwrap()).unwrap();
        raw.as_object_mut()
            .unwrap()
            .insert("future".to_string(), json!({ "x": 1 }));
        std::fs::write(&tmp, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();
        invalidate_cache();

        // A write (add another) through the public API must preserve the extra key.
        add_path("C:/repo-b").unwrap();
        let after: Value = serde_json::from_slice(&std::fs::read(&tmp).unwrap()).unwrap();
        assert_eq!(after["future"]["x"], json!(1));

        set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }
}
