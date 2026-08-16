//! Operation journal ("opslog"): a durable, per-repo record of the four compound
//! rollback git operations (local-PR merge, cherry-pick-onto, rewrite-commits,
//! interactive rebase-edit). If one is interrupted by a crash or restart mid-op, a
//! `"pending"` record survives on disk and [`git_oplog_check`] points the user at
//! their pre-op state on relaunch.
//!
//! ## Inform-only, best-effort safety net
//!
//! The journal NEVER performs a git mutation to "recover" — it records and surfaces,
//! nothing more. A journal write failure must NEVER fail or alter a git op:
//! [`begin`]/[`finish`] swallow+log every error and let the caller proceed.
//!
//! ## Storage-dir mirroring contract
//!
//! `opslog.json` is resolved with the SAME `dirs::data_dir()` the Tauri path layer
//! uses, joined with the bundle identifier (mirroring `local_prs.rs`):
//! `%APPDATA%\com.thebguy.gitdesktop\` on Windows, `~/Library/Application
//! Support/<id>/` on macOS, `$XDG_DATA_HOME/<id>/` (or `~/.local/share/<id>/`) on Linux.
//!
//! ## Value-based round-trip (never drop unknown fields)
//!
//! The file is read as a `serde_json::Value` and mutated record-by-record as `Value`s
//! — existing records are NEVER deserialized into a struct and re-serialized (that
//! would drop any field a future GUI version adds). New records are built from the
//! typed [`OpLogEntry`]. Writes are atomic (temp file + rename).
//!
//! ## Concurrency
//!
//! One shared file keyed by repo path, written from concurrent async handlers, so a
//! naive read→modify→write loses updates. Every read-modify-write goes through a sync
//! helper guarded by [`OPLOG_LOCK`] held across read→mutate→write: `atomic_write`
//! gives torn-file safety, the lock gives lost-update safety — both are needed. The
//! lock is never held across an `.await`.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// The Tauri bundle identifier — the app-data subdir the store writes under.
const APP_IDENTIFIER: &str = "com.thebguy.gitdesktop";
/// The store filename.
const STORE_FILE: &str = "opslog.json";
/// Keep at most this many entries per repo (never evicting a `"pending"` one).
const HISTORY_CAP: usize = 50;

/// A single journaled operation. `#[serde(rename_all = "camelCase")]` freezes the
/// wire shape the frontend package consumes verbatim — do not rename fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogEntry {
    /// uuid v4.
    pub id: String,
    /// Machine key: `"merge_local_pr"` | `"cherry_pick_onto"` | `"rewrite_commits"` | `"rebase_edit"`.
    pub op: String,
    /// Human summary, e.g. `"Squash-merge feature → main"`.
    pub label: String,
    /// `"pending"` | `"done"` | `"failed"` | `"dismissed"`.
    pub status: String,
    /// `now_iso()` captured at [`begin`].
    pub started_at: String,
    /// `now_iso()` captured at [`finish`]/reconcile.
    pub finished_at: Option<String>,
    /// Branch (or `"HEAD"` if detached) we were on.
    pub original_ref: Option<String>,
    /// Pre-op HEAD sha (`git rev-parse HEAD` before the op).
    pub original_sha: String,
    /// The reset-rollback target (base_tip / target_tip / orig HEAD).
    pub pre_op_tip: Option<String>,
    /// Failure detail when `status == "failed"`.
    pub error: Option<String>,
}

/// Guards the whole read-modify-write of the shared store file (see module docs).
/// Never held across an `.await` — the store fns it wraps are all synchronous.
fn oplog_lock() -> &'static Mutex<()> {
    static OPLOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    OPLOG_LOCK.get_or_init(|| Mutex::new(()))
}

/// Pure resolution of the store's base directory, in precedence order:
/// 1. a non-empty `GD_OPLOG_DIR` override — the escape hatch for headless/test callers;
/// 2. under `cfg!(test)`, a temp subdir, so no in-crate test can write the user's real
///    store (the instrumented ops run for real under `cargo test`);
/// 3. otherwise the real app-data dir (`dirs::data_dir()/<identifier>`).
///
/// No filesystem side effects — `atomic_write` creates the parent at write time.
fn resolve_store_base(gd_oplog_dir: Option<&str>, is_test: bool) -> AppResult<PathBuf> {
    match gd_oplog_dir {
        Some(dir) if !dir.is_empty() => Ok(PathBuf::from(dir)),
        _ if is_test => Ok(std::env::temp_dir().join("gd-oplog-test")),
        _ => {
            let data = dirs::data_dir().ok_or_else(|| {
                AppError::Command("could not resolve the app-data directory".to_string())
            })?;
            Ok(data.join(APP_IDENTIFIER))
        }
    }
}

/// Absolute path of `opslog.json` — `<store base>/opslog.json`; see
/// [`resolve_store_base`] for how the base is chosen.
pub fn store_path() -> AppResult<PathBuf> {
    let base = resolve_store_base(std::env::var("GD_OPLOG_DIR").ok().as_deref(), cfg!(test))?;
    Ok(base.join(STORE_FILE))
}

/// Read the whole store file as a JSON object. A missing file is an empty object;
/// a present-but-malformed file is a hard error (we must never clobber it).
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "opslog store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "opslog store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Serialize the store object (pretty) and write it back atomically — temp file in
/// the same dir + rename over the target (via [`crate::fsops::atomic_write`]) so a
/// reader never sees a partial file.
fn write_store(path: &Path, store: &Map<String, Value>) -> AppResult<()> {
    let body = serde_json::to_string_pretty(&Value::Object(store.clone()))
        .map_err(|e| AppError::Command(format!("serialize opslog store: {e}")))?;
    crate::fsops::atomic_write(path, body.as_bytes())
}

/// Compare two repo-path keys for "same repo" tolerantly: normalize separators to
/// `/` and treat a leading Windows drive letter case-insensitively (`C:` == `c:`).
/// Mirrors `local_prs.rs`.
fn same_repo(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        let slashed: String = s.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
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

/// Find the EXISTING store key for `repo` (exact first, then tolerant match), so we
/// reuse a single key per repo. Returns `None` when the repo has no entry yet.
fn existing_key(store: &Map<String, Value>, repo: &str) -> Option<String> {
    if store.contains_key(repo) {
        return Some(repo.to_string());
    }
    store
        .keys()
        .find(|k| same_repo(k, repo))
        .map(String::to_string)
}

/// The current UTC timestamp in JS `Date.prototype.toISOString()` format —
/// RFC3339 with millisecond precision and a `Z` suffix.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Read `repo`'s entries as a `Vec<Value>` (empty when the repo has no key), in
/// stored order. Callers sort/filter as needed.
fn repo_entries(store: &Map<String, Value>, repo: &str) -> Vec<Value> {
    existing_key(store, repo)
        .and_then(|k| store.get(&k))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Sort entries newest-first by `startedAt` (descending; string RFC3339 sorts
/// lexicographically, which is chronological for this fixed-width format).
fn sort_newest_first(entries: &mut [Value]) {
    entries.sort_by(|a, b| {
        let sa = a.get("startedAt").and_then(Value::as_str).unwrap_or("");
        let sb = b.get("startedAt").and_then(Value::as_str).unwrap_or("");
        sb.cmp(sa)
    });
}

// ── Guarded sync store operations (each takes the lock for the whole RMW) ──────

/// Insert a new `"pending"` entry for `repo`, cap the history, and persist.
/// Guarded by [`OPLOG_LOCK`] for the whole read-modify-write.
fn insert_pending(repo: &str, entry: &OpLogEntry) -> AppResult<()> {
    let record = serde_json::to_value(entry)
        .map_err(|e| AppError::Command(format!("serialize opslog entry: {e}")))?;
    let path = store_path()?;
    let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut store = read_store(&path)?;

    let key = existing_key(&store, repo).unwrap_or_else(|| repo.to_string());
    let arr = store.entry(key).or_insert_with(|| Value::Array(Vec::new()));
    let list = arr
        .as_array_mut()
        .ok_or_else(|| AppError::Command("opslog repo entry is not an array".to_string()))?;
    list.insert(0, record);
    cap_history(list);

    write_store(&path, &store)
}

/// Drop oldest non-`"pending"` entries until `list.len() <= HISTORY_CAP`. A
/// `"pending"` entry (possibly an in-flight op) is never evicted, so the cap is a
/// soft ceiling that a burst of concurrent pending ops can legitimately exceed.
fn cap_history(list: &mut Vec<Value>) {
    if list.len() <= HISTORY_CAP {
        return;
    }
    // Iterate oldest-first (end of the newest-first vec) and remove non-pending
    // until at or under the cap.
    let mut i = list.len();
    while list.len() > HISTORY_CAP && i > 0 {
        i -= 1;
        let is_pending = list[i].get("status").and_then(Value::as_str) == Some("pending");
        if !is_pending {
            list.remove(i);
        }
    }
}

/// Apply `mutate` to the entry with `id` under `repo` (if present) and persist.
/// Guarded by [`OPLOG_LOCK`]. Unknown id → no-op `Ok(())`.
fn mutate_entry<F>(repo: &str, id: &str, mutate: F) -> AppResult<()>
where
    F: FnOnce(&mut Map<String, Value>),
{
    let path = store_path()?;
    let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut store = read_store(&path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(());
    };
    let Some(list) = store.get_mut(&key).and_then(Value::as_array_mut) else {
        return Ok(());
    };
    let Some(target) = list
        .iter_mut()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
    else {
        return Ok(());
    };
    let Some(obj) = target.as_object_mut() else {
        return Ok(());
    };
    mutate(obj);
    write_store(&path, &store)
}

/// The newest pending op is genuinely interrupted UNLESS the repo is back in a
/// clean, on-home state: no git op mid-flight, no tracked changes, and we're on the
/// branch the op started from. (A completed `merge_local_pr` returns to its original
/// branch with a clean tree; a mid-squash interrupt leaves staged changes on `base`
/// with NONE of the `git_op_state` markers set — so `mid_op` alone would miss it.)
fn is_interrupted(
    mid_op: bool,
    tree_dirty: bool,
    current_branch: &str,
    original_ref: Option<&str>,
) -> bool {
    let on_home = match original_ref {
        // Started on a branch → a completed op must be back on it. An empty
        // current_branch means the `rev-parse` read failed; don't let that
        // manufacture a false interrupt (mirrors tree_dirty's fail-safe default).
        Some(r) if r != "HEAD" && !current_branch.is_empty() => current_branch == r,
        // Detached / unknown start, or a failed branch read: can't gate on the
        // branch, so rely on the other two signals.
        _ => true,
    };
    mid_op || tree_dirty || !on_home
}

/// Reconcile `repo`'s pending entries against real git state, persist, and return
/// the still-`"pending"` entries newest-first (0 or 1). `mid_op` = a merge,
/// cherry-pick, rebase or revert is currently in progress ([`RepoOpState::mid_op`]);
/// `tree_dirty` = tracked changes are present (catches a mid-squash interrupt
/// git_op_state can't see); `current_branch` = the branch HEAD is on now. Guarded
/// by [`OPLOG_LOCK`].
fn reconcile(
    repo: &str,
    mid_op: bool,
    tree_dirty: bool,
    current_branch: &str,
) -> AppResult<Vec<OpLogEntry>> {
    let path = store_path()?;
    let now = now_iso();
    let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut store = read_store(&path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(Vec::new());
    };
    let Some(list) = store.get_mut(&key).and_then(Value::as_array_mut) else {
        return Ok(Vec::new());
    };

    // Indices of pending entries, newest-first by startedAt.
    let mut pending_idx: Vec<usize> = list
        .iter()
        .enumerate()
        .filter(|(_, e)| e.get("status").and_then(Value::as_str) == Some("pending"))
        .map(|(i, _)| i)
        .collect();
    pending_idx.sort_by(|&a, &b| {
        let sa = list[a]
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let sb = list[b]
            .get("startedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        sb.cmp(sa)
    });

    if pending_idx.is_empty() {
        return Ok(Vec::new());
    }

    // The genuinely-interrupted op, if any: the NEWEST pending, but only when the
    // repo isn't back in a clean, on-home state (see `is_interrupted`). git permits
    // only one such op at a time, so at most one entry is genuinely interrupted;
    // every other pending must have completed (a newer op started, or the repo is
    // clean) — `finish` just never wrote "done".
    let keep_pending = pending_idx.first().copied().filter(|&i| {
        is_interrupted(
            mid_op,
            tree_dirty,
            current_branch,
            list[i].get("originalRef").and_then(Value::as_str),
        )
    });
    for &idx in &pending_idx {
        if Some(idx) == keep_pending {
            continue;
        }
        if let Some(obj) = list[idx].as_object_mut() {
            obj.insert("status".to_string(), Value::String("done".to_string()));
            obj.insert("finishedAt".to_string(), Value::String(now.clone()));
        }
    }

    let results: Vec<OpLogEntry> = keep_pending
        .and_then(|idx| serde_json::from_value(list[idx].clone()).ok())
        .into_iter()
        .collect();

    write_store(&path, &store)?;
    Ok(results)
}

// ── Public API ────────────────────────────────────────────────────────────────

/// Best-effort: insert a `"pending"` entry for `repo`, returning its id. On ANY
/// failure, log and return `None` — the caller proceeds regardless (journaling
/// never breaks the op).
pub async fn begin(
    repo: &str,
    op: &str,
    label: &str,
    original_ref: Option<String>,
    original_sha: &str,
    pre_op_tip: Option<&str>,
) -> Option<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let entry = OpLogEntry {
        id: id.clone(),
        op: op.to_string(),
        label: label.to_string(),
        status: "pending".to_string(),
        started_at: now_iso(),
        finished_at: None,
        original_ref,
        original_sha: original_sha.to_string(),
        pre_op_tip: pre_op_tip.map(str::to_string),
        error: None,
    };
    match insert_pending(repo, &entry) {
        Ok(()) => Some(id),
        Err(e) => {
            eprintln!("gitdesktop: opslog begin failed (op continues): {e}");
            None
        }
    }
}

/// Best-effort: if `id` is `Some`, flip that entry to `"done"` (error `None`) or
/// `"failed"` (error `Some`), and set `finishedAt`. Swallow+log write errors — a
/// journal failure never affects the op's outcome.
pub async fn finish(repo: &str, id: &Option<String>, error: Option<String>) {
    let Some(id) = id else {
        return;
    };
    let now = now_iso();
    let status = if error.is_some() { "failed" } else { "done" };
    let result = mutate_entry(repo, id, |obj| {
        obj.insert("status".to_string(), Value::String(status.to_string()));
        obj.insert("finishedAt".to_string(), Value::String(now));
        match &error {
            Some(msg) => {
                obj.insert("error".to_string(), Value::String(msg.clone()));
            }
            None => {
                obj.insert("error".to_string(), Value::Null);
            }
        }
    });
    if let Err(e) = result {
        eprintln!("gitdesktop: opslog finish failed (op unaffected): {e}");
    }
}

/// The `preOpTip` a [`begin`] recorded for `id` — the ref position the operation
/// was built on, for a later step that must refuse to move a ref that has since
/// been changed by anyone else. `None` whenever it can't be established
/// (unjournaled op, pruned entry, unreadable store), so callers must treat the
/// absence as "unknown", never as "unchanged".
pub(crate) async fn pre_op_tip(repo: &str, id: &Option<String>) -> Option<String> {
    let id = id.as_ref()?;
    let path = store_path().ok()?;
    let entries = {
        let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
        let store = read_store(&path).ok()?;
        repo_entries(&store, repo)
    };
    entries
        .iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .and_then(|e| e.get("preOpTip"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Return `repo`'s journal entries newest-first by `startedAt`. Pure store read,
/// no git access. Missing repo key → `[]`.
#[tauri::command]
pub async fn git_oplog_list(repo_path: String) -> AppResult<Vec<OpLogEntry>> {
    let path = store_path()?;
    let mut entries = {
        let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
        let store = read_store(&path)?;
        repo_entries(&store, &repo_path)
    };
    sort_newest_first(&mut entries);
    Ok(entries
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

/// Reconcile `repo`'s pending entries against real git state (see the module
/// contract) and return the genuinely-interrupted entries (0 or 1), newest-first.
/// All git reads happen OUTSIDE the store lock.
#[tauri::command]
pub async fn git_oplog_check(repo_path: String) -> AppResult<Vec<OpLogEntry>> {
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};

    let state = crate::git::ops::git_op_state(repo_path.clone()).await?;
    // `mid_op` over a hand-listed set: the flag list lives on `RepoOpState`. Not
    // `op_in_progress`, whose Err arm answers `true` — that would manufacture an
    // interrupt from a failed read, which the two probes below refuse to do.
    let mid_op = state.mid_op();
    // A squash-merge leaves none of those markers, so git_op_state alone misses a
    // mid-squash interrupt. Corroborate with a *tracked*-dirty check (untracked is
    // allowed — mirrors ensure_clean_tree) + the current branch.
    let tree_dirty = run_git(
        Some(&repo_path),
        &["status", "--porcelain", "--untracked-files=no"],
        DEFAULT_TIMEOUT,
    )
    .await
    .map(|o| !o.stdout_lossy().trim().is_empty())
    .unwrap_or(false); // best-effort: a failed read must not manufacture an interrupt
    let current_branch = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .map(|o| o.stdout_lossy().trim().to_string())
    .unwrap_or_default();
    reconcile(&repo_path, mid_op, tree_dirty, &current_branch)
}

/// Set the entry with `id` under `repo` to `status = "dismissed"` and persist.
/// Unknown id → `Ok(())` (no-op) — never error the UI.
#[tauri::command]
pub async fn git_oplog_dismiss(repo_path: String, id: String) -> AppResult<()> {
    mutate_entry(&repo_path, &id, |obj| {
        obj.insert("status".to_string(), Value::String("dismissed".to_string()));
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These tests exercise the pure store logic against a temp file, driving the
    // SAME read/mutate/write helpers the public fns use but with an explicit path,
    // so they never touch the real app-data store.

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-opslog-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    #[test]
    fn store_path_avoids_the_real_store_under_test() {
        // This runs in a cfg(test) build, so `store_path` takes arm 2 (temp subdir)
        // UNLESS a GD_OPLOG_DIR override is present in the environment. Branch on the
        // var rather than mutating process env (which would race parallel tests).
        let path = store_path().unwrap();
        match std::env::var("GD_OPLOG_DIR").ok().filter(|d| !d.is_empty()) {
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
    fn store_path_honors_gd_oplog_dir_override() {
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
            std::env::temp_dir().join("gd-oplog-test")
        );
        // 2. No override + test → the temp subdir.
        assert_eq!(
            resolve_store_base(None, true).unwrap(),
            std::env::temp_dir().join("gd-oplog-test")
        );
        // 3. No override + non-test → the real app-data dir (ends with the identifier).
        let real = resolve_store_base(None, false).unwrap();
        assert!(
            real.components().any(|c| c.as_os_str() == APP_IDENTIFIER),
            "real base {real:?} should contain {APP_IDENTIFIER}"
        );
    }

    #[test]
    fn is_interrupted_flags_a_mid_squash() {
        // Squash-merge killed mid-flight: no git_op_state marker (mid_op false), but
        // tracked changes are staged on `base` and we're no longer on the op's
        // origin branch — must be flagged interrupted.
        assert!(is_interrupted(false, true, "main", Some("feature")));
    }

    #[test]
    fn is_interrupted_clears_a_completed_and_home_op() {
        // A completed merge_local_pr returns to its origin branch with a clean tree
        // and no op mid-flight — not interrupted.
        assert!(!is_interrupted(false, false, "feature", Some("feature")));
    }

    #[test]
    fn is_interrupted_flags_a_live_mid_op() {
        // git_op_state still shows an op in progress → interrupted even if the tree
        // reads clean and the branch matches.
        assert!(is_interrupted(true, false, "feature", Some("feature")));
    }

    #[test]
    fn is_interrupted_ignores_a_failed_branch_read() {
        // A failed `rev-parse` yields an empty current_branch; a completed op that
        // started on a branch must NOT be flagged just because we couldn't read it.
        assert!(!is_interrupted(false, false, "", Some("feature")));
    }

    /// Build a wire record (camelCase) for a pending entry, as `begin` would.
    fn pending_record(id: &str, started_at: &str) -> Value {
        json!({
            "id": id,
            "op": "merge_local_pr",
            "label": "Merge feature → main",
            "status": "pending",
            "startedAt": started_at,
            "finishedAt": null,
            "originalRef": "feature",
            "originalSha": "abc123",
            "preOpTip": "def456",
            "error": null,
        })
    }

    #[test]
    fn begin_then_list_yields_a_pending_entry() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        // Simulate begin's insert against our temp file.
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            Value::Array(vec![pending_record("op-1", "2026-01-01T00:00:00.000Z")]),
        );
        write_store(&path, &store).unwrap();

        let mut entries = repo_entries(&read_store(&path).unwrap(), repo);
        sort_newest_first(&mut entries);
        let parsed: Vec<OpLogEntry> = entries
            .into_iter()
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "op-1");
        assert_eq!(parsed[0].status, "pending");
        assert!(parsed[0].finished_at.is_none());
    }

    #[test]
    fn finish_flips_to_done_and_failed_with_finished_at() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            Value::Array(vec![
                pending_record("done-1", "2026-01-01T00:00:00.000Z"),
                pending_record("fail-1", "2026-01-02T00:00:00.000Z"),
            ]),
        );
        write_store(&path, &store).unwrap();

        // Drive the same mutation finish uses, against the temp file.
        let flip = |path: &Path, id: &str, error: Option<String>| {
            let mut s = read_store(path).unwrap();
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let obj = list
                .iter_mut()
                .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
                .unwrap()
                .as_object_mut()
                .unwrap();
            let status = if error.is_some() { "failed" } else { "done" };
            obj.insert("status".into(), Value::String(status.into()));
            obj.insert(
                "finishedAt".into(),
                Value::String("2026-01-03T00:00:00.000Z".into()),
            );
            match error {
                Some(m) => obj.insert("error".into(), Value::String(m)),
                None => obj.insert("error".into(), Value::Null),
            };
            write_store(path, &s).unwrap();
        };
        flip(&path, "done-1", None);
        flip(&path, "fail-1", Some("boom".into()));

        let back = read_store(&path).unwrap();
        let list = back[repo].as_array().unwrap();
        let done = list.iter().find(|e| e["id"] == "done-1").unwrap();
        assert_eq!(done["status"], "done");
        assert_eq!(done["finishedAt"], "2026-01-03T00:00:00.000Z");
        assert_eq!(done["error"], Value::Null);
        let failed = list.iter().find(|e| e["id"] == "fail-1").unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"], "boom");
        assert_eq!(failed["finishedAt"], "2026-01-03T00:00:00.000Z");
    }

    #[test]
    fn unknown_fields_survive_a_begin_finish_round_trip() {
        // A record carrying a field this Rust code has never heard of must survive a
        // status mutation untouched (never drop unknown fields a future GUI adds).
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        let mut rec = pending_record("op-1", "2026-01-01T00:00:00.000Z");
        rec.as_object_mut()
            .unwrap()
            .insert("futureField".into(), json!(42));
        rec.as_object_mut()
            .unwrap()
            .insert("nested".into(), json!({ "keep": ["me", 2, true] }));
        store.insert(repo.to_string(), Value::Array(vec![rec]));
        write_store(&path, &store).unwrap();

        // Flip status the way finish does (Value-level; no struct round-trip).
        let mut s = read_store(&path).unwrap();
        {
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let obj = list[0].as_object_mut().unwrap();
            obj.insert("status".into(), Value::String("done".into()));
            obj.insert(
                "finishedAt".into(),
                Value::String("2026-01-02T00:00:00.000Z".into()),
            );
        }
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        let entry = &back[repo][0];
        assert_eq!(entry["futureField"], 42);
        assert_eq!(entry["nested"]["keep"], json!(["me", 2, true]));
        assert_eq!(entry["status"], "done");
    }

    #[test]
    fn cap_never_evicts_a_pending_entry() {
        // A newest-first list: 1 old pending at the very end, then 60 done entries.
        // Capping to 50 must drop oldest done entries but keep the pending one.
        let mut list: Vec<Value> = Vec::new();
        for i in 0..60 {
            list.push(json!({
                "id": format!("done-{i}"),
                "status": "done",
                "startedAt": format!("2026-02-{:02}T00:00:00.000Z", i + 1),
            }));
        }
        // The oldest entry (last in newest-first order) is pending.
        list.push(json!({
            "id": "old-pending",
            "status": "pending",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }));
        cap_history(&mut list);

        assert!(list.len() <= HISTORY_CAP);
        assert!(
            list.iter().any(|e| e["id"] == "old-pending"),
            "the pending entry must never be evicted by the cap"
        );
    }

    #[test]
    fn dismiss_sets_dismissed_status() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            Value::Array(vec![pending_record("op-1", "2026-01-01T00:00:00.000Z")]),
        );
        write_store(&path, &store).unwrap();

        // Drive dismiss's mutation against the temp file.
        let mut s = read_store(&path).unwrap();
        {
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let obj = list
                .iter_mut()
                .find(|e| e["id"] == "op-1")
                .unwrap()
                .as_object_mut()
                .unwrap();
            obj.insert("status".into(), Value::String("dismissed".into()));
        }
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        assert_eq!(back[repo][0]["status"], "dismissed");
    }

    #[test]
    fn missing_repo_key_lists_empty() {
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        let entries = repo_entries(&store, r"C:\nope");
        assert!(entries.is_empty());
    }
}
