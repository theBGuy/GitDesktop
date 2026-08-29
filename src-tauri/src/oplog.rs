//! Operation journal ("opslog"): a durable, per-repo record of the five compound
//! rollback git operations (local-PR merge, cherry-pick-onto, rewrite-commits,
//! interactive rebase-edit, pull-rebase drop). If one is interrupted by a crash or restart mid-op, a
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
//!
//! The mutex only covers THIS process, and `gitdesktop mcp` runs the same binary as a
//! second writer, so each guarded helper also takes the cross-process
//! [`crate::store_lock`] inside the mutex — cheap intra-process serialization first,
//! then the OS-level file lock (which fails open, as this journal must).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// The Tauri bundle identifier — the app-data subdir the store writes under.
const APP_IDENTIFIER: &str = "com.thebguy.gitdesktop";
/// The store filename.
const STORE_FILE: &str = "opslog.json";
/// Keep at most this many entries per repo (never evicting a `"pending"` or
/// `"paused"` one).
const HISTORY_CAP: usize = 50;

/// A single journaled operation. `#[serde(rename_all = "camelCase")]` freezes the
/// wire shape the frontend package consumes verbatim — do not rename fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpLogEntry {
    /// uuid v4.
    pub id: String,
    /// Machine key: `"merge_local_pr"` | `"cherry_pick_onto"` | `"rewrite_commits"` |
    /// `"rebase_edit"` | `"pull_rebase_drop"`.
    pub op: String,
    /// Human summary, e.g. `"Squash-merge feature → main"`.
    pub label: String,
    /// `"pending"` | `"done"` | `"failed"` | `"dismissed"` | `"paused"` | `"concluded"`.
    /// `"paused"` = handed to the user mid-op (a stopped cherry-pick), so it is
    /// neither in-flight nor finished until they continue or abort it;
    /// `"concluded"` = that pick ended outside the app, so the journal knows only
    /// that it is over (see [`conclude_stale_pauses`]).
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
/// Mirrors `local_prs.rs`. `pub(crate)` so a caller holding two spellings of one repo can
/// tell whether they already resolve to one journal key — junctions, symlinks, 8.3 names
/// and path-body case are outside this tolerance and need a second probe.
pub(crate) fn same_repo(a: &str, b: &str) -> bool {
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
    let _store_lock = crate::store_lock::lock_store(&path);
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

/// Drop oldest evictable entries until `list.len() <= HISTORY_CAP`. An unfinished
/// entry is never evicted — `"pending"` may be an in-flight op, and `"paused"` is a
/// live handle [`close_paused_pick`] still needs — so the cap is a soft ceiling that
/// a burst of concurrent unfinished ops can legitimately exceed. `"concluded"` is
/// deliberately OUTSIDE that set: a pick that ended outside the app is over, so its
/// record ages out like any other finished one.
fn cap_history(list: &mut Vec<Value>) {
    if list.len() <= HISTORY_CAP {
        return;
    }
    // Iterate oldest-first (end of the newest-first vec) and remove finished entries
    // until at or under the cap.
    let mut i = list.len();
    while list.len() > HISTORY_CAP && i > 0 {
        i -= 1;
        let status = list[i].get("status").and_then(Value::as_str);
        let unfinished = matches!(status, Some("pending") | Some("paused"));
        if !unfinished {
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
    let _store_lock = crate::store_lock::lock_store(&path);
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

/// How a paused op ended, once the user acted on it — see [`close_paused_pick`].
pub(crate) enum PausedOutcome {
    /// Continued to completion in-app.
    Continued,
    /// Abandoned in-app.
    Aborted,
}

/// Mark an entry as handed to the user: no `finishedAt` (the op hasn't ended) and no
/// `error` (the conflict lives in the banner, and the history dialog's error line
/// gates on `"failed"`). Both are written explicitly so the shape holds whatever the
/// record carried before.
fn apply_pause(obj: &mut Map<String, Value>) {
    obj.insert("status".to_string(), Value::String("paused".to_string()));
    obj.insert("finishedAt".to_string(), Value::Null);
    obj.insert("error".to_string(), Value::Null);
}

/// Close a paused entry at its terminal disposition. An abort is journaled `"failed"`
/// with the same wording [`crate::git::ops::git_abort_local_pr_merge`] uses, so the
/// history dialog reads one sentence for a user-abandoned op.
fn apply_close(obj: &mut Map<String, Value>, outcome: &PausedOutcome, now: String) {
    let (status, error) = match outcome {
        PausedOutcome::Continued => ("done", Value::Null),
        PausedOutcome::Aborted => ("failed", Value::String("aborted by user".to_string())),
    };
    obj.insert("status".to_string(), Value::String(status.to_string()));
    obj.insert("finishedAt".to_string(), Value::String(now));
    obj.insert("error".to_string(), error);
}

/// The id of the NEWEST `"paused"` cherry-pick entry in `entries`, if any. Sorts in
/// place (the caller owns a store copy), so callers may pass unsorted store order.
fn newest_paused_pick(entries: &mut [Value]) -> Option<String> {
    sort_newest_first(entries);
    entries
        .iter()
        .find(|e| {
            e.get("op").and_then(Value::as_str) == Some("cherry_pick_onto")
                && e.get("status").and_then(Value::as_str) == Some("paused")
        })
        .and_then(|e| e.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
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

/// Conclude every STALE `"paused"` cherry-pick record in `list` — one whose pick was
/// finished or abandoned OUTSIDE the app (a terminal `git cherry-pick
/// --continue`/`--abort`), which otherwise leaves the record paused forever: immortal
/// under [`cap_history`], a live handle [`close_paused_pick`] misattributes to the
/// next in-app pick, and a permanent lie in Operation history.
///
/// The verdict is deliberately narrower than `mid_op`: a concurrent merge or rebase
/// says nothing about a pick. It comes from TWO reads, and either one saying "a pick
/// is live" spares the records. `cherry_picking` is the caller's earlier op-state
/// read, which by the time we hold the lock is two git subprocesses old — a pick that
/// paused in that window would have its brand-new record concluded permanently, and
/// the user's later Continue/Abort would then find no handle to close. So
/// `pick_in_progress` re-probes under the lock and is authoritative for that
/// direction; it must answer whether `CHERRY_PICK_HEAD` exists for THIS repo, which
/// is exactly the marker a paused (single-hash) pick leaves.
///
/// Residual, accepted: git can finish an in-app continue between that probe and
/// [`close_paused_pick`]'s own locked RMW, so a check landing in those few
/// milliseconds concludes the record first and the close then no-ops. Both run
/// in-process and the window is order-of-ms; the cost is one history row reading
/// "Ended outside the app" for a pick that ended inside it.
///
/// ALL stale records are concluded, not just the pre-newest ones — leaving any behind
/// keeps the close-handle misattribution alive.
///
/// Status-write ONLY: the journal never mutates git to "recover" (module contract), and
/// `finishedAt` stays null because a reconcile observes THAT the op ended, never when.
/// Answers whether anything changed, so a no-op check doesn't rewrite the file.
fn conclude_stale_pauses(
    list: &mut [Value],
    cherry_picking: bool,
    pick_in_progress: impl Fn() -> bool,
) -> bool {
    fn is_paused_pick(entry: &Value) -> bool {
        entry.get("status").and_then(Value::as_str) == Some("paused")
            // Every paused record is a cherry-pick today; asserting the op keeps the
            // verdict honest if another op ever learns to pause.
            && entry.get("op").and_then(Value::as_str) == Some("cherry_pick_onto")
    }

    // Probe only when there is something to conclude — the common check touches no
    // filesystem beyond the store it already read.
    if !list.iter().any(is_paused_pick) {
        return false;
    }
    if cherry_picking || pick_in_progress() {
        return false;
    }
    let mut changed = false;
    for entry in list.iter_mut() {
        if !is_paused_pick(entry) {
            continue;
        }
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("status".to_string(), Value::String("concluded".to_string()));
            changed = true;
        }
    }
    changed
}

/// Reconcile `repo`'s entries against real git state, persist, and return the
/// still-`"pending"` entries newest-first (0 or 1). `mid_op` = a merge, cherry-pick,
/// rebase or revert is currently in progress ([`RepoOpState::mid_op`]);
/// `tree_dirty` = tracked changes are present (catches a mid-squash interrupt
/// git_op_state can't see); `current_branch` = the branch HEAD is on now;
/// `cherry_picking` and the `pick_in_progress` re-probe gate the stale-pause arm
/// alone, and the probe runs INSIDE the lock (see [`conclude_stale_pauses`]).
/// Guarded by [`OPLOG_LOCK`] plus the cross-process store lock.
fn reconcile(
    repo: &str,
    mid_op: bool,
    tree_dirty: bool,
    current_branch: &str,
    cherry_picking: bool,
    pick_in_progress: impl Fn() -> bool,
) -> AppResult<Vec<OpLogEntry>> {
    reconcile_at(
        &store_path()?,
        repo,
        mid_op,
        tree_dirty,
        current_branch,
        cherry_picking,
        pick_in_progress,
    )
}

/// The store logic behind [`reconcile`], taking an explicit path so a test can drive it
/// against a temp file of its own (mirroring [`crate::review_notes`]'s `set_at`). The
/// shared `cfg(test)` store can't answer whether a check WROTE, only what it left.
fn reconcile_at(
    path: &Path,
    repo: &str,
    mid_op: bool,
    tree_dirty: bool,
    current_branch: &str,
    cherry_picking: bool,
    pick_in_progress: impl Fn() -> bool,
) -> AppResult<Vec<OpLogEntry>> {
    let now = now_iso();
    let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(path);
    let mut store = read_store(path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(Vec::new());
    };
    let Some(list) = store.get_mut(&key).and_then(Value::as_array_mut) else {
        return Ok(Vec::new());
    };

    let mut changed = conclude_stale_pauses(list, cherry_picking, pick_in_progress);

    // Indices of pending entries, newest-first by startedAt. Strictly `"pending"`:
    // a live `"paused"` op was handed to the user and is owned by the conflict
    // banner, never a recovery candidate — and a concluded one is over, so neither
    // may reach this function's RETURN value (the recovery banner renders every
    // returned entry as "Interrupted").
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

    let results: Vec<OpLogEntry> = if pending_idx.is_empty() {
        Vec::new()
    } else {
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
                changed = true;
            }
        }
        keep_pending
            .and_then(|idx| serde_json::from_value(list[idx].clone()).ok())
            .into_iter()
            .collect()
    };

    if changed {
        write_store(path, &store)?;
    }
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
    let repo = repo.to_string();
    match crate::store_lock::locked_store_task(move || insert_pending(&repo, &entry)).await {
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
    let (repo, id) = (repo.to_string(), id.clone());
    let result = crate::store_lock::locked_store_task(move || {
        mutate_entry(&repo, &id, |obj| {
            obj.insert("status".to_string(), Value::String(status.to_string()));
            obj.insert("finishedAt".to_string(), Value::String(now));
            match error {
                Some(msg) => {
                    obj.insert("error".to_string(), Value::String(msg));
                }
                None => {
                    obj.insert("error".to_string(), Value::Null);
                }
            }
        })
    })
    .await;
    if let Err(e) = result {
        eprintln!("gitdesktop: opslog finish failed (op unaffected): {e}");
    }
}

/// Best-effort: if `id` is `Some`, flip that entry to `"paused"` — the op did not
/// end, it was handed to the user to resolve, so it is neither a failure nor a
/// recovery candidate until [`close_paused_pick`] closes it. Swallow+log like
/// [`finish`].
pub(crate) async fn pause(repo: &str, id: &Option<String>) {
    let Some(id) = id else {
        return;
    };
    let (repo, id) = (repo.to_string(), id.clone());
    let result =
        crate::store_lock::locked_store_task(move || mutate_entry(&repo, &id, apply_pause)).await;
    if let Err(e) = result {
        eprintln!("gitdesktop: opslog pause failed (op unaffected): {e}");
    }
}

/// Best-effort: close `repo`'s newest `"paused"` cherry-pick entry now that the user
/// has ended the pick in-app. No paused entry → no-op.
///
/// The handle is the newest paused record, not the specific pick, so it can only be
/// as accurate as the store is current: [`conclude_stale_pauses`] retires the records
/// of picks ended outside the app on the next [`git_oplog_check`] that finds no pick
/// in progress, which is what keeps one from standing in as this op's handle.
pub(crate) async fn close_paused_pick(repo: &str, outcome: PausedOutcome) {
    let (repo, now) = (repo.to_string(), now_iso());
    let result = crate::store_lock::locked_store_task(move || {
        close_newest_paused_pick(&repo, &outcome, now)
    })
    .await;
    if let Err(e) = result {
        eprintln!("gitdesktop: opslog close failed (op unaffected): {e}");
    }
}

/// The lookup AND the status write under ONE acquisition of both locks. Splitting
/// them (find the handle, release, re-take to mutate) lets two concurrent closes
/// resolve the same newest-paused id and both write it — the second overwriting the
/// first's disposition.
fn close_newest_paused_pick(repo: &str, outcome: &PausedOutcome, now: String) -> AppResult<()> {
    let path = store_path()?;
    let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(());
    };
    let Some(list) = store.get_mut(&key).and_then(Value::as_array_mut) else {
        return Ok(());
    };
    // Resolve the handle on a copy: `newest_paused_pick` sorts what it is given, and
    // the stored order is the file's own (readers sort for themselves).
    let Some(id) = newest_paused_pick(&mut list.clone()) else {
        return Ok(());
    };
    let Some(obj) = list
        .iter_mut()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .and_then(Value::as_object_mut)
    else {
        return Ok(());
    };
    apply_close(obj, outcome, now);
    write_store(&path, &store)
}

/// The `preOpTip` a [`begin`] recorded for `id` — the ref position the operation
/// was built on, for a later step that must refuse to move a ref that has since
/// been changed by anyone else. `None` whenever it can't be established
/// (unjournaled op, pruned entry, unreadable store), so callers must treat the
/// absence as "unknown", never as "unchanged".
pub(crate) async fn pre_op_tip(repo: &str, id: &Option<String>) -> Option<String> {
    let id = id.as_ref()?.clone();
    let repo = repo.to_string();
    let entries = read_repo_entries(repo).await.ok()?;
    entries
        .iter()
        .find(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .and_then(|e| e.get("preOpTip"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `repo`'s entries in stored order, read off the async runtime. The read takes no FILE
/// lock (`atomic_write` already gives it a whole file or none) but it does take
/// [`OPLOG_LOCK`], which the writers now hold across the store lock's blocking retry — so
/// a reader on a tokio worker could park behind one for the whole budget.
async fn read_repo_entries(repo: String) -> AppResult<Vec<Value>> {
    crate::store_lock::locked_store_task(move || {
        let path = store_path()?;
        let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
        let store = read_store(&path)?;
        Ok(repo_entries(&store, &repo))
    })
    .await
}

/// Return `repo`'s journal entries newest-first by `startedAt`. Pure store read,
/// no git access. Missing repo key → `[]`.
#[tauri::command]
pub async fn git_oplog_list(repo_path: String) -> AppResult<Vec<OpLogEntry>> {
    let mut entries = read_repo_entries(repo_path).await?;
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
    // The stale-pause verdict keys on the pick flag ALONE, not `mid_op` — see
    // `conclude_stale_pauses`. This read goes stale across the two git subprocesses
    // below, so `reconcile` re-probes the marker under the lock; this one only
    // short-circuits.
    let cherry_picking = state.cherry_picking;
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
    // The store RMW blocks on the cross-process lock's retry budget, so it runs off the
    // async runtime; the marker re-probe is built inside the job, which keeps it on the
    // same thread as the lock it must run under.
    crate::store_lock::locked_store_task(move || {
        reconcile(
            &repo_path,
            mid_op,
            tree_dirty,
            &current_branch,
            cherry_picking,
            // FS-only (no subprocess), so it is cheap to run while holding the store lock.
            || crate::git::ops::cherry_pick_marker_present(&repo_path),
        )
    })
    .await
}

/// Set the entry with `id` under `repo` to `status = "dismissed"` and persist.
/// Unknown id → `Ok(())` (no-op) — never error the UI.
#[tauri::command]
pub async fn git_oplog_dismiss(repo_path: String, id: String) -> AppResult<()> {
    crate::store_lock::locked_store_task(move || {
        mutate_entry(&repo_path, &id, |obj| {
            obj.insert("status".to_string(), Value::String("dismissed".to_string()));
        })
    })
    .await
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
    fn cap_never_evicts_an_unfinished_entry() {
        // A newest-first list: 60 done entries, then the two oldest unfinished ones.
        // Capping to 50 must drop oldest done entries but keep both of those.
        let mut list: Vec<Value> = Vec::new();
        for i in 0..60 {
            list.push(json!({
                "id": format!("done-{i}"),
                "status": "done",
                "startedAt": format!("2026-02-{:02}T00:00:00.000Z", i + 1),
            }));
        }
        // The oldest entries (last in newest-first order) are still open.
        list.push(json!({
            "id": "old-pending",
            "status": "pending",
            "startedAt": "2026-01-02T00:00:00.000Z",
        }));
        list.push(json!({
            "id": "old-paused",
            "op": "cherry_pick_onto",
            "status": "paused",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }));
        cap_history(&mut list);

        assert!(list.len() <= HISTORY_CAP);
        assert!(
            list.iter().any(|e| e["id"] == "old-pending"),
            "the pending entry must never be evicted by the cap"
        );
        assert!(
            list.iter().any(|e| e["id"] == "old-paused"),
            "evicting a paused entry would lose the handle the close helper needs"
        );
    }

    /// Build a wire record for a `cherry_pick_onto` entry at `status`.
    fn pick_record(id: &str, started_at: &str, status: &str) -> Value {
        json!({
            "id": id,
            "op": "cherry_pick_onto",
            "label": "Cherry-pick abc1234 → target",
            "status": status,
            "startedAt": started_at,
            "finishedAt": null,
            "originalRef": "feature",
            "originalSha": "abc123",
            "preOpTip": "def456",
            "error": null,
        })
    }

    #[test]
    fn pause_marks_the_entry_without_finishing_it() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut rec = pick_record("pick-1", "2026-01-01T00:00:00.000Z", "pending");
        // Seed the fields pause must clear, so the assertions below can't pass by
        // the record having arrived clean.
        let obj = rec.as_object_mut().unwrap();
        obj.insert("finishedAt".into(), json!("2026-01-02T00:00:00.000Z"));
        obj.insert("error".into(), json!("stale"));
        let mut store = Map::new();
        store.insert(repo.to_string(), Value::Array(vec![rec]));
        write_store(&path, &store).unwrap();

        let mut s = read_store(&path).unwrap();
        apply_pause(s[repo].as_array_mut().unwrap()[0].as_object_mut().unwrap());
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        let entry = &back[repo][0];
        assert_eq!(entry["status"], "paused");
        assert_eq!(
            entry["finishedAt"],
            Value::Null,
            "a paused op has not ended, so it has no finish time"
        );
        assert_eq!(entry["error"], Value::Null);
        // And it still parses, or the history dialog's from_value filter drops it.
        let parsed: OpLogEntry = serde_json::from_value(entry.clone()).unwrap();
        assert_eq!(parsed.status, "paused");
        assert!(parsed.finished_at.is_none());
    }

    #[test]
    fn close_targets_the_newest_paused_pick() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            Value::Array(vec![
                pick_record("old-paused", "2026-01-01T00:00:00.000Z", "paused"),
                pick_record("new-paused", "2026-01-03T00:00:00.000Z", "paused"),
                pick_record("later-done", "2026-01-04T00:00:00.000Z", "done"),
            ]),
        );
        write_store(&path, &store).unwrap();

        let mut entries = repo_entries(&read_store(&path).unwrap(), repo);
        let id = newest_paused_pick(&mut entries).expect("the paused pick must be found");
        assert_eq!(id, "new-paused", "a newer finished entry is not the handle");

        let mut s = read_store(&path).unwrap();
        {
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let obj = list
                .iter_mut()
                .find(|e| e["id"] == id)
                .unwrap()
                .as_object_mut()
                .unwrap();
            apply_close(
                obj,
                &PausedOutcome::Aborted,
                "2026-01-05T00:00:00.000Z".to_string(),
            );
        }
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        let list = back[repo].as_array().unwrap();
        let closed = list.iter().find(|e| e["id"] == "new-paused").unwrap();
        assert_eq!(closed["status"], "failed");
        assert_eq!(closed["error"], "aborted by user");
        assert_eq!(closed["finishedAt"], "2026-01-05T00:00:00.000Z");
        // Only the newest is closed: an older paused record is not this op's.
        let untouched = list.iter().find(|e| e["id"] == "old-paused").unwrap();
        assert_eq!(untouched["status"], "paused");
    }

    #[test]
    fn close_continued_marks_done_without_an_error() {
        let mut rec = pick_record("pick-1", "2026-01-01T00:00:00.000Z", "paused");
        apply_close(
            rec.as_object_mut().unwrap(),
            &PausedOutcome::Continued,
            "2026-01-02T00:00:00.000Z".to_string(),
        );
        assert_eq!(rec["status"], "done");
        assert_eq!(rec["finishedAt"], "2026-01-02T00:00:00.000Z");
        assert_eq!(rec["error"], Value::Null);
    }

    #[test]
    fn close_is_a_no_op_without_a_paused_pick() {
        // A finished pick and another op's paused entry: neither is a pick handle,
        // so the close helper must find nothing to flip.
        let mut entries = vec![
            pick_record("done-pick", "2026-01-02T00:00:00.000Z", "done"),
            json!({
                "id": "paused-merge",
                "op": "merge_local_pr",
                "status": "paused",
                "startedAt": "2026-01-03T00:00:00.000Z",
            }),
        ];
        assert!(newest_paused_pick(&mut entries).is_none());
        assert!(newest_paused_pick(&mut Vec::new()).is_none());
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

    #[test]
    fn same_repo_tolerates_slashes_and_drive_case() {
        // The key matcher the GUI and the MCP both depend on to land on ONE key per repo
        // (mirrors `local_prs`'s): separators normalize, the drive letter is
        // case-insensitive, the rest of the path is not.
        assert!(same_repo(
            r"C:\ProjectRepos\demo\harbor",
            "C:/ProjectRepos/demo/harbor"
        ));
        assert!(same_repo(
            r"C:\ProjectRepos\demo\harbor",
            r"c:\ProjectRepos\demo\harbor"
        ));
        assert!(!same_repo(r"C:\a\b", r"C:\a\c"));
    }

    #[test]
    fn existing_key_reuses_a_tolerant_match() {
        let mut store = Map::new();
        store.insert(r"C:\repo\one".to_string(), json!([]));
        // A differently-spelled but same repo reuses the stored key, so a journal write
        // can't strand a second entry the reader never looks at.
        assert_eq!(
            existing_key(&store, "c:/repo/one").as_deref(),
            Some(r"C:\repo\one")
        );
        assert_eq!(existing_key(&store, r"C:\repo\two"), None);
    }

    /// A reconcile that changes nothing must not rewrite the file: the store is shared
    /// with a second process, and a needless write is a needless chance to lose its
    /// concurrent update. The seeded bytes are deliberately NOT what `write_store`
    /// produces (compact, unsorted), so any write at all — even one that changes no
    /// record — is visible in the comparison.
    #[test]
    fn a_reconcile_with_nothing_to_do_writes_nothing() {
        let (_tmp, path) = tmp_store();
        let repo = r"C:\oplog\no-write-pin";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            Value::Array(vec![
                pick_record("live-pause", "2026-01-01T00:00:00.000Z", "paused"),
                pending_record("interrupted", "2026-01-02T00:00:00.000Z"),
            ]),
        );
        // Compact, which is NOT what `write_store` emits.
        let seeded = serde_json::to_string(&Value::Object(store)).unwrap();
        std::fs::write(&path, seeded.as_bytes()).unwrap();
        let before = std::fs::read(&path).unwrap();

        // Nothing to do on either arm: a pick is in progress (so the pause stands), and
        // the pending op is genuinely interrupted (so it stays pending).
        let returned = reconcile_at(&path, repo, true, true, "feature", true, || true).unwrap();
        assert_eq!(returned.len(), 1);
        assert_eq!(returned[0].id, "interrupted");

        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "a no-op check must leave the file byte-identical"
        );
    }

    // ── Stale-pause reconcile ────────────────────────────────────────────────
    //
    // These drive `reconcile`/`git_oplog_check` for real, so they go through
    // `store_path()` — the cfg(test) arm, a temp file no in-crate test may leave the
    // developer's real store for. The file is shared with every other test in the
    // binary, so each seeds a repo key of its own and mutates under the same locks
    // production takes.

    /// Replace `repo`'s entries in the seam-resolved store, as one locked RMW.
    fn seed_entries(repo: &str, entries: Vec<Value>) {
        let path = store_path().unwrap();
        let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _store_lock = crate::store_lock::lock_store(&path);
        let mut store = read_store(&path).unwrap();
        store.insert(repo.to_string(), Value::Array(entries));
        write_store(&path, &store).unwrap();
    }

    /// `repo`'s record `id`, straight off disk — under both locks, so the read can't
    /// land inside another test's (or process's) atomic rename over the file.
    fn stored_entry(repo: &str, id: &str) -> Value {
        let path = store_path().unwrap();
        let _guard = oplog_lock().lock().unwrap_or_else(|p| p.into_inner());
        let _store_lock = crate::store_lock::lock_store(&path);
        let store = read_store(&path).unwrap();
        repo_entries(&store, repo)
            .into_iter()
            .find(|e| e.get("id").and_then(Value::as_str) == Some(id))
            .unwrap_or_else(|| panic!("record {id} must still be in the store"))
    }

    async fn git(repo: &str, args: &[&str]) -> String {
        crate::git::runner::run_git(Some(repo), args, crate::git::runner::DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
            .stdout_lossy()
    }

    async fn commit(repo: &str, dir: &Path, file: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-m", msg]).await;
    }

    /// A repo left mid-cherry-pick on a content conflict: `target` and `feature` both
    /// edited `a.txt`, so picking feature's commit onto target stops for the user.
    async fn setup_conflicting_pick(marker: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-oplog-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit(&repo, dir.path(), "a.txt", "base\n", "base").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let pick = git(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        git(&repo, &["checkout", "target"]).await;
        commit(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        // Conflicts by construction, so git exits nonzero and leaves the pick open.
        let _ = crate::git::runner::run_git(
            Some(&repo),
            &["cherry-pick", &pick],
            crate::git::runner::DEFAULT_TIMEOUT,
        )
        .await;
        assert!(
            crate::git::ops::git_op_state(repo.clone())
                .await
                .unwrap()
                .cherry_picking,
            "the fixture must leave a pick in progress"
        );
        (dir, repo)
    }

    /// A pick concluded OUTSIDE the app leaves its record `"paused"` — nothing in-app
    /// ever closes it, so it was cap-immortal, a handle the next in-app close would
    /// misattribute, and a permanent lie in the history dialog. The next check must
    /// retire it, WITHOUT leaking it into the return value (the recovery banner
    /// renders every returned entry as "Interrupted").
    #[tokio::test]
    async fn a_stale_paused_pick_is_concluded_by_the_next_check() {
        let (_dir, repo) = setup_conflicting_pick("stale-pause").await;
        seed_entries(
            &repo,
            vec![pick_record(
                "stale-pick",
                "2026-01-01T00:00:00.000Z",
                "paused",
            )],
        );
        // The terminal route the app has no hook for.
        git(&repo, &["cherry-pick", "--abort"]).await;

        let returned = git_oplog_check(repo.clone()).await.unwrap();
        assert!(
            returned.is_empty(),
            "a concluded record must never reach the recovery banner: {returned:?}"
        );
        let entry = stored_entry(&repo, "stale-pick");
        assert_eq!(entry["status"], "concluded");
        assert_eq!(
            entry["finishedAt"],
            Value::Null,
            "a reconcile observes THAT the op ended, never when"
        );
    }

    /// NEGATIVE CONTROL for the arm above: a pick the user is still resolving reads
    /// `cherry_picking == true`, and its record is the live handle `close_paused_pick`
    /// needs — concluding it would break every in-app continue/abort.
    #[tokio::test]
    async fn a_live_paused_pick_is_never_concluded() {
        let (_dir, repo) = setup_conflicting_pick("live-pause").await;
        seed_entries(
            &repo,
            vec![pick_record(
                "live-pick",
                "2026-01-01T00:00:00.000Z",
                "paused",
            )],
        );

        let returned = git_oplog_check(repo.clone()).await.unwrap();
        assert!(returned.is_empty(), "a pause is not an interrupt");
        assert_eq!(
            stored_entry(&repo, "live-pick")["status"],
            "paused",
            "a pick still in progress keeps its record"
        );
    }

    /// The check's `git_op_state` read is two git subprocesses old by the time
    /// `reconcile` holds the lock, so a pick that pauses in that window arrives with
    /// the flag reading FALSE. Concluding then would retire a record the user's
    /// Continue/Abort still needs — the marker re-probe, taken under the lock, is what
    /// overrules the stale flag.
    #[tokio::test]
    async fn a_pick_that_started_after_the_state_read_is_not_concluded() {
        let (_dir, repo) = setup_conflicting_pick("post-read-pause").await;
        seed_entries(
            &repo,
            vec![pick_record(
                "raced-pick",
                "2026-01-01T00:00:00.000Z",
                "paused",
            )],
        );

        // `cherry_picking: false` is the stale pre-race read; the pick is live NOW.
        let returned = reconcile(&repo, false, false, "target", false, || {
            crate::git::ops::cherry_pick_marker_present(&repo)
        })
        .unwrap();

        assert!(returned.is_empty());
        assert_eq!(
            stored_entry(&repo, "raced-pick")["status"],
            "paused",
            "the locked re-probe must overrule the stale op-state read"
        );
    }

    #[test]
    fn every_stale_paused_pick_is_concluded_in_one_pass() {
        let repo = r"C:\oplog\two-stale-pauses";
        seed_entries(
            repo,
            vec![
                pick_record("older-paused", "2026-01-01T00:00:00.000Z", "paused"),
                pick_record("newer-paused", "2026-01-02T00:00:00.000Z", "paused"),
                // Not a pick: the op guard must leave it alone.
                json!({
                    "id": "paused-merge",
                    "op": "merge_local_pr",
                    "status": "paused",
                    "startedAt": "2026-01-03T00:00:00.000Z",
                }),
            ],
        );

        let returned = reconcile(repo, false, false, "main", false, || false).unwrap();
        assert!(returned.is_empty());
        // Sparing the newest would leave `close_paused_pick` a stale handle to
        // misattribute the user's next in-app pick to.
        for id in ["older-paused", "newer-paused"] {
            assert_eq!(stored_entry(repo, id)["status"], "concluded", "{id}");
        }
        assert_eq!(stored_entry(repo, "paused-merge")["status"], "paused");
    }

    #[test]
    fn the_pending_arm_is_untouched_by_the_paused_one() {
        let repo = r"C:\oplog\pending-beside-a-stale-pause";
        seed_entries(
            repo,
            vec![
                pending_record("interrupted-merge", "2026-01-03T00:00:00.000Z"),
                pick_record("stale-pick", "2026-01-01T00:00:00.000Z", "paused"),
            ],
        );

        // A merge is mid-flight — which is why the pause verdict reads
        // `cherry_picking` and not repo-wide `mid_op`: this merge says nothing about
        // whether a cherry-pick ended.
        let returned = reconcile(repo, true, false, "feature", false, || false).unwrap();
        assert_eq!(returned.len(), 1, "{returned:?}");
        assert_eq!(returned[0].id, "interrupted-merge");
        assert_eq!(returned[0].status, "pending");
        assert_eq!(stored_entry(repo, "stale-pick")["status"], "concluded");
    }

    #[test]
    fn cap_evicts_a_concluded_entry() {
        // The flip of `cap_never_evicts_an_unfinished_entry`: a pick that ended
        // outside the app is over, so its record ages out like any finished one —
        // which is what stops a stale pause from starving the cap forever.
        let mut list: Vec<Value> = (0..60)
            .map(|i| {
                json!({
                    "id": format!("done-{i}"),
                    "status": "done",
                    "startedAt": format!("2026-02-{:02}T00:00:00.000Z", i + 1),
                })
            })
            .collect();
        list.push(json!({
            "id": "old-concluded",
            "op": "cherry_pick_onto",
            "status": "concluded",
            "startedAt": "2026-01-01T00:00:00.000Z",
        }));
        cap_history(&mut list);

        assert!(list.len() <= HISTORY_CAP);
        assert!(
            !list.iter().any(|e| e["id"] == "old-concluded"),
            "a concluded record is finished, so the cap must be able to evict it"
        );
    }
}
