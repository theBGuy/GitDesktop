//! Reviewer-notes storage core for the MCP server's write tool and the GUI.
//!
//! **Reviewer notes are GitDesktop's own app-data deposits** — no forge or remote writes
//! are involved. An agent session deposits a per-branch note ("Notes for reviewers") keyed
//! by repo + branch; the GUI later seeds its Create-PR dialog's "Notes for reviewers" field
//! from this store. This module owns every WRITE to that file: the MCP server (which has NO
//! `AppHandle`) calls [`set`] directly, and the GUI routes through
//! [`review_notes_set_branch`]/[`review_notes_delete_branch`] so both processes mutate under
//! one [`crate::store_lock`]. The GUI still READS through the Tauri Store plugin
//! (`src/lib/review-notes/store.ts`), reloading after each write.
//! It is a leaner parallel of [`crate::local_issues`] / [`crate::local_prs`] — see
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
//! agree on the file. A `GD_REVIEW_NOTES_DIR` override and a `cfg(test)` temp dir precede that
//! resolution; see [`resolve_store_base`].
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
use std::sync::{Mutex, OnceLock};

use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The store filename the GUI's reviewer-notes store writes.
const STORE_FILE: &str = "review-notes.json";

/// Guards the whole read-modify-write of the shared store file within THIS process
/// (mirroring [`crate::oplog`]'s `OPLOG_LOCK`). It sits OUTSIDE the cross-process
/// file lock deliberately: same-process serialization is exact and free, where the
/// file lock fails open after its retry budget — so two concurrent handlers in one
/// process must not be relying on it. Never held across an `.await`: every fn it
/// wraps is synchronous.
fn notes_lock() -> &'static Mutex<()> {
    static NOTES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    NOTES_LOCK.get_or_init(|| Mutex::new(()))
}

/// Pure resolution of the store's base directory, in precedence order (mirroring
/// [`crate::oplog::resolve_store_base`]):
/// 1. a non-empty `GD_REVIEW_NOTES_DIR` override — the escape hatch for headless/test
///    callers. Unlike the oplog (Rust-only), this store has a GUI reader/writer that
///    does NOT honor the override, so an override splits the Rust side from the GUI's
///    copy entirely;
/// 2. under `cfg!(test)`, a temp subdir, so no in-crate test can write the user's real
///    store (the rename migration runs for real under `cargo test`);
/// 3. otherwise the real app-data dir (`dirs::data_dir()/<identifier>`), mirroring
///    `tauri-plugin-store` v2's `BaseDirectory::AppData` — see the module contract.
///
/// No filesystem side effects — `atomic_write` creates the parent at write time.
fn resolve_store_base(gd_review_notes_dir: Option<&str>, is_test: bool) -> AppResult<PathBuf> {
    match gd_review_notes_dir {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ if is_test => Ok(std::env::temp_dir().join("gd-review-notes-test")),
        _ => {
            let data = dirs::data_dir().ok_or_else(|| {
                AppError::Command("could not resolve the app-data directory".to_string())
            })?;
            Ok(data.join(APP_IDENTIFIER))
        }
    }
}

/// Absolute path of the `review-notes.json` the frontend store writes —
/// `<store base>/review-notes.json`; see [`resolve_store_base`] for how the base is chosen.
pub(crate) fn store_path() -> AppResult<PathBuf> {
    let base = resolve_store_base(
        std::env::var("GD_REVIEW_NOTES_DIR").ok().as_deref(),
        cfg!(test),
    )?;
    Ok(base.join(STORE_FILE))
}

/// The note stored for `repo`'s `branch`, read through [`store_path`] — the seam-aware
/// reader an end-to-end test asserts on. Test-only; production readers are the GUI's.
#[cfg(test)]
pub(crate) fn note_body(repo: &str, branch: &str) -> Option<String> {
    let store = read_store(&store_path().ok()?).ok()?;
    store
        .get(repo)?
        .get(branch)?
        .get("body")
        .and_then(Value::as_str)
        .map(str::to_string)
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
    // Hold both locks across the whole read→modify→write: the GUI and the
    // `gitdesktop mcp` server both write this file, and an unlocked RMW drops whichever
    // note lost the race (see [`crate::store_lock`]; acquisition fails open, which is
    // why the exact in-process mutex goes outside it).
    let _guard = notes_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _lock = crate::store_lock::lock_store(&path);
    set_at(&path, repo, branch, body)
}

/// Save (or clear) the GUI's reviewer note for `branch`, taking the same
/// cross-process lock the MCP writer takes. The GUI's plugin-store writer keeps a
/// per-process cache the MCP server's writes are invisible to, so its whole
/// read→modify→write runs here instead. An empty or whitespace-only `body` clears
/// the deposit; the answer is whether a note was saved (see [`set`]).
#[tauri::command]
pub async fn review_notes_set_branch(
    repo_path: String,
    branch: String,
    body: String,
) -> AppResult<bool> {
    let identity = crate::git::repo::repo_identity(&repo_path).await;
    set(&identity, &branch, &body)
}

/// Remove the GUI's reviewer note for `branch` — the consume-on-open path behind the
/// Create-PR dialogs — through [`set`]'s empty-body clear, so both write routes share
/// one locked implementation. A branch with no note is a harmless no-op.
#[tauri::command]
pub async fn review_notes_delete_branch(repo_path: String, branch: String) -> AppResult<()> {
    let identity = crate::git::repo::repo_identity(&repo_path).await;
    set(&identity, &branch, "")?;
    Ok(())
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

/// Carry `from`'s reviewer note over to `to` under `repo`, so a renamed branch keeps its
/// deposit. `repo` is the worktree-stable identity key ([`crate::git::repo::repo_identity`]).
///
/// The note record moves verbatim (unknown fields included) and its `savedAt` is left alone —
/// a rename is not a re-save. Nothing is written when there is nothing to migrate.
pub(crate) fn rename_branch(repo: &str, from: &str, to: &str) -> AppResult<()> {
    let path = store_path()?;
    // Same lock pair as [`set`]: the read→move→write must not interleave with a
    // concurrent deposit, which would resurrect the old branch name's note.
    let _guard = notes_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _lock = crate::store_lock::lock_store(&path);
    rename_at(&path, repo, from, to)
}

/// The pure store logic behind [`rename_branch`], taking an explicit path so tests can drive
/// it against a temp file without touching the real app-data store.
fn rename_at(path: &Path, repo: &str, from: &str, to: &str) -> AppResult<()> {
    // A same-name rename has nothing to migrate, so skip the redundant rewrite of the file.
    if from == to {
        return Ok(());
    }
    let mut store = read_store(path)?;
    if !move_branch(&mut store, repo, from, to) {
        // Nothing to migrate: leave the file (which may not even exist) untouched.
        return Ok(());
    }
    write_store(path, &store)
}

/// Move `from`'s note onto `to` within `repo`'s map, dropping the repo key if that empties it.
/// Returns whether anything changed, so the caller can skip the write entirely.
fn move_branch(store: &mut Map<String, Value>, repo: &str, from: &str, to: &str) -> bool {
    let Some(entry) = store.get_mut(repo) else {
        return false;
    };
    let Some(branches) = entry.as_object_mut() else {
        return false;
    };
    let changed = match branches.remove(from) {
        Some(note) => {
            branches.insert(to.to_string(), note);
            true
        }
        // Nothing carried over, so a note already under the new name is stale: `git branch -m`
        // refuses an existing target, so that note belongs to a branch that no longer answers
        // to the name (the commit-draft rule, `migrateCommitDraft` in src/lib/stores/ui.ts).
        None => branches.remove(to).is_some(),
    };
    if changed && branches.is_empty() {
        store.remove(repo);
    }
    changed
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

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-review-notes-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    #[test]
    fn store_path_avoids_the_real_store_under_test() {
        // This runs in a cfg(test) build, so `store_path` takes arm 2 (temp subdir)
        // UNLESS a GD_REVIEW_NOTES_DIR override is present in the environment. Branch on
        // the var rather than mutating process env (which would race parallel tests).
        let path = store_path().unwrap();
        assert!(path.ends_with(STORE_FILE), "path: {}", path.display());
        match std::env::var("GD_REVIEW_NOTES_DIR").ok().filter(|d| !d.is_empty()) {
            Some(dir) => {
                // Override wins even under test: path is under the override dir.
                assert!(
                    path.starts_with(&dir),
                    "override path {path:?} should be under {dir}"
                );
            }
            None => {
                // The real store must NOT be reachable from an in-crate test.
                assert!(
                    path.starts_with(std::env::temp_dir()),
                    "test store {path:?} should be under the temp dir"
                );
                assert!(
                    !path.components().any(|c| c.as_os_str() == APP_IDENTIFIER),
                    "test store {path:?} must not contain the real app-data segment {APP_IDENTIFIER}"
                );
            }
        }
    }

    #[test]
    fn store_path_honors_gd_review_notes_dir_override() {
        // Drive the pure resolver directly — deterministic + parallel-safe (no
        // process-env mutation).
        // 1. An explicit override wins regardless of the test flag.
        let over = resolve_store_base(Some("C:/tmp/x"), true).unwrap();
        assert_eq!(over, PathBuf::from("C:/tmp/x"));
        let over_nontest = resolve_store_base(Some("C:/tmp/x"), false).unwrap();
        assert_eq!(over_nontest, PathBuf::from("C:/tmp/x"));
        // An empty override is ignored (falls through to the next arm).
        assert_eq!(
            resolve_store_base(Some(""), true).unwrap(),
            std::env::temp_dir().join("gd-review-notes-test")
        );
        // 2. No override + test → the temp subdir.
        assert_eq!(
            resolve_store_base(None, true).unwrap(),
            std::env::temp_dir().join("gd-review-notes-test")
        );
        // 3. No override + non-test → the real app-data dir, so the production path
        //    stays …/com.thebguy.gitdesktop/review-notes.json, unchanged by the seam.
        let real = resolve_store_base(None, false).unwrap();
        assert_eq!(real, dirs::data_dir().unwrap().join(APP_IDENTIFIER));
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn malformed_store_is_an_error_not_a_clobber() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is left intact.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
    }

    #[test]
    fn set_upserts_body_and_stamps_saved_at() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        let saved = set_at(&path, repo, "feature", "please look at the migration").unwrap();
        assert!(saved);

        let back = read_store(&path).unwrap();
        let note = &back[repo]["feature"];
        assert_eq!(note["body"], "please look at the migration");
        assert!(note["savedAt"].is_string());
        let ts = note["savedAt"].as_str().unwrap();
        assert!(ts.ends_with('Z'), "expected ISO Z suffix: {ts}");
    }

    #[test]
    fn set_overwrites_an_existing_branch_note() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "first").unwrap();
        set_at(&path, repo, "feature", "second").unwrap();

        let back = read_store(&path).unwrap();
        assert_eq!(back[repo]["feature"]["body"], "second");
        // Only one branch entry — an upsert, not an append.
        assert_eq!(back[repo].as_object().unwrap().len(), 1);
    }

    #[test]
    fn empty_body_clears_the_branch_but_keeps_siblings() {
        let (_tmp, path) = tmp_store();
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
    }

    #[test]
    fn clearing_last_branch_removes_the_repo_key() {
        let (_tmp, path) = tmp_store();
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
    }

    #[test]
    fn clearing_a_missing_branch_is_a_harmless_noop() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        // No prior entry — clearing a never-set branch just writes an empty store.
        let saved = set_at(&path, repo, "ghost", "").unwrap();
        assert!(!saved);
        let back = read_store(&path).unwrap();
        assert!(back.is_empty());
    }

    #[test]
    fn upsert_preserves_sibling_repos_and_unknown_fields() {
        let (_tmp, path) = tmp_store();
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
    }

    #[test]
    fn rename_moves_the_note_to_the_new_branch() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "look at the migration").unwrap();
        set_at(&path, repo, "other", "note B").unwrap();

        rename_at(&path, repo, "feature", "feature-renamed").unwrap();

        let back = read_store(&path).unwrap();
        assert!(back[repo].get("feature").is_none(), "{back:?}");
        assert_eq!(back[repo]["feature-renamed"]["body"], "look at the migration");
        // The sibling branch is untouched.
        assert_eq!(back[repo]["other"]["body"], "note B");
    }

    #[test]
    fn rename_overwrites_a_note_sitting_under_the_new_name() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "carried over").unwrap();
        set_at(&path, repo, "taken", "stale").unwrap();

        rename_at(&path, repo, "feature", "taken").unwrap();

        let back = read_store(&path).unwrap();
        assert_eq!(back[repo]["taken"]["body"], "carried over");
        assert_eq!(back[repo].as_object().unwrap().len(), 1);
    }

    #[test]
    fn rename_without_a_source_note_drops_a_stale_target_note() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "taken", "stale").unwrap();
        set_at(&path, repo, "other", "note B").unwrap();

        // "feature" never had a note, so the one under the claimed name is stale.
        rename_at(&path, repo, "feature", "taken").unwrap();

        let back = read_store(&path).unwrap();
        assert!(back[repo].get("taken").is_none(), "{back:?}");
        assert_eq!(back[repo]["other"]["body"], "note B");
    }

    #[test]
    fn stale_target_delete_that_empties_the_map_drops_the_repo_key() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "taken", "stale").unwrap();

        rename_at(&path, repo, "feature", "taken").unwrap();

        let back = read_store(&path).unwrap();
        assert!(back.get(repo).is_none(), "repo key should be gone: {back:?}");
        assert!(back.is_empty());
    }

    #[test]
    fn rename_with_nothing_to_migrate_writes_nothing() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        // No store file at all: an unnoted branch's rename must not create one.
        rename_at(&path, repo, "feature", "feature-renamed").unwrap();
        assert!(!path.exists(), "no store file should have been created");

        // A store holding only other repos/branches is left byte-identical.
        set_at(&path, "C:/repo/other/.git", "main", "keep me").unwrap();
        let before = std::fs::read(&path).unwrap();
        rename_at(&path, repo, "feature", "feature-renamed").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_same_name_rename_leaves_the_note_alone() {
        let (_tmp, path) = tmp_store();
        let repo = "C:/repo/one/.git";
        set_at(&path, repo, "feature", "keep me").unwrap();

        rename_at(&path, repo, "feature", "feature").unwrap();

        let back = read_store(&path).unwrap();
        assert_eq!(back[repo]["feature"]["body"], "keep me");
    }

    #[test]
    fn rename_preserves_unknown_fields_on_the_moved_and_sibling_notes() {
        let (_tmp, path) = tmp_store();
        let other_repo = "C:/repo/other/.git";
        let repo = "C:/repo/one/.git";
        let mut store = Map::new();
        store.insert(
            other_repo.to_string(),
            json!({ "main": { "body": "keep me", "savedAt": "2026-01-01T00:00:00.000Z", "futureField": 7 } }),
        );
        store.insert(
            repo.to_string(),
            json!({ "feature": { "body": "moved", "savedAt": "2026-01-02T00:00:00.000Z", "futureField": 9 } }),
        );
        write_store(&path, &store).unwrap();

        rename_at(&path, repo, "feature", "feature-renamed").unwrap();

        let back = read_store(&path).unwrap();
        // The record moves verbatim — unknown field and original savedAt included.
        assert_eq!(back[repo]["feature-renamed"]["futureField"], 9);
        assert_eq!(
            back[repo]["feature-renamed"]["savedAt"],
            "2026-01-02T00:00:00.000Z"
        );
        // The other repo's note (and its unknown field) is untouched.
        assert_eq!(back[other_repo]["main"]["futureField"], 7);
    }

    #[test]
    fn now_iso_matches_js_toisostring_shape() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'), "expected Z suffix: {ts}");
        let dot = ts.find('.').expect("expected millisecond fraction");
        assert_eq!(&ts[dot + 4..], "Z", "expected 3-digit millis: {ts}");
    }
}
