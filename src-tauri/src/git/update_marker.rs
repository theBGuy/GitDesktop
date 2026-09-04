//! In-flight markers for `update_branch_from`'s hidden `gd-update-*` checkout, plus
//! the sweep that clears the ones a crash left behind.
//!
//! An update checks the target branch out in a throwaway worktree under the app-data
//! worktrees root for the whole merge. Everything else that wants that branch —
//! switching, renaming, deleting, cherry-picking onto it — would otherwise collide
//! with git's own message naming a hidden app-data path. A marker minted before the
//! `worktree add` turns those collisions into one sentence the user can act on, and
//! it works ACROSS PROCESSES (the MCP server runs these same functions) because the
//! signal is filesystem state, not process state.
//!
//! The marker is two files beside the checkout, sharing its stem: an unlocked `.json`
//! manifest and an exclusively-locked `.lock`. Two files is forced by Windows —
//! `LockFileEx` blocks cross-process READS of a locked range, so a single locked
//! manifest would be unreadable by the very probes that need it. Liveness is the lock
//! itself: the OS releases it when the owning process dies, so a probe that can
//! acquire it is looking at a crash orphan.
//!
//! A probe that establishes nothing fails OPEN in BOTH directions — no refusal and no
//! removal, leaving the caller exactly where it stood before markers existed. An IO
//! hiccup must never block a user's action, nor authorize deleting a checkout.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    run_git_raw, try_acquire_repo_lock, DEFAULT_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::state::AppState;

/// The basename prefix every update mint carries (`branches.rs::update_worktree_path`).
/// It is the NAME filter for every claim and must never widen — the same root holds the
/// user's `gd/session/*` agent worktrees. It is only the first gate: a claim also has to
/// pass the root-scope check, the lock probe, and (for the markerless shape) the age
/// gate before anything is removed.
const MARKER_PREFIX: &str = "gd-update-";

/// How stale a leftover must be before the sweep claims it. Uniform and generous: the
/// age gate is what closes every mint-order race (a marker written microseconds before
/// its `worktree add`), and a live update is spared at any age by its held lock anyway.
const ORPHAN_MIN_AGE: Duration = Duration::from_secs(600);

/// One detached sweep at a time across the process — the healing pass is best-effort
/// and idempotent, so a second concurrent run would only contend for the admin domain.
static SWEEP_RUNNING: AtomicBool = AtomicBool::new(false);

/// In-process test override, consulted by [`root_for`] before the real app-data
/// resolution — the ONLY seam a test may use to reach this module's entry points
/// (mirrors [`crate::local_issues`]'s; never process env, which races parallel tests'
/// env reads).
#[cfg(test)]
static TEST_ROOT_DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Serializes the tests that install [`TEST_ROOT_DIR`], since the override is
/// process-wide. Test-only.
#[cfg(test)]
static TEST_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Installs (or clears) the in-process override, returning the previous value so a
/// caller can restore it. Test-only.
#[cfg(test)]
pub(crate) fn swap_test_root_dir(dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut slot = TEST_ROOT_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, dir)
}

/// Takes the serializing guard for the process-wide root override. Test-only.
#[cfg(test)]
pub(crate) fn test_root_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_ROOT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Points this module's root resolution at `dir` for as long as it is held, restoring
/// the prior override on drop — panics included, so a failing test cannot leave one
/// standing for whichever test is next through the lock. Test-only.
#[cfg(test)]
pub(crate) struct TestRootOverride(Option<PathBuf>);

#[cfg(test)]
impl TestRootOverride {
    pub(crate) fn set(dir: &Path) -> Self {
        Self(swap_test_root_dir(Some(dir.to_path_buf())))
    }
}

#[cfg(test)]
impl Drop for TestRootOverride {
    fn drop(&mut self) {
        swap_test_root_dir(self.0.take());
    }
}

/// The worktree root this module works in. Every entry point resolves through here so a
/// test can point the whole module at a temp directory; outside tests it is exactly
/// `ops::worktree_root_dir`.
fn root_for(repo_path: &str) -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_ROOT_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return Ok(dir);
    }
    crate::git::ops::worktree_root_dir(repo_path)
}

/// The marker manifest. Plain readable JSON so a probe in another process can answer
/// "which branch?" while the update still holds the lock beside it.
#[derive(Serialize, Deserialize)]
struct UpdateManifest {
    branch: String,
    /// The owning process, so a leftover marker can be traced by hand. Never a
    /// liveness signal — the OS recycles pids, and the lock answers that question.
    pid: u32,
}

/// The refusal a site raises when a live update holds `branch`.
pub(crate) fn branch_update_refusal(branch: &str) -> AppError {
    AppError::Command(format!(
        "A branch update is bringing {branch} up to date — try again when it finishes."
    ))
}

/// The refusal for a site that cannot know which branch it is about to touch.
fn any_update_refusal() -> AppError {
    AppError::Command("A branch update is running — try again when it finishes.".to_string())
}

/// The refusal when a PROVABLY dead update's leftover still holds `branch` and this
/// attempt could not clear it, which now means only one thing: the worktree-admin
/// domain was busy. Raised solely off a `Released` probe, so it never says an update is
/// running — that would be a claim the probe just disproved.
pub(crate) fn interrupted_update_refusal(branch: &str) -> AppError {
    AppError::Command(format!(
        "An interrupted branch update is still holding {branch} — try again in a moment."
    ))
}

/// A marker sidecar beside `worktree_dir`, sharing its basename: `<dir>.<ext>`. Built
/// from the whole basename rather than `with_extension`, which would eat a suffix the
/// mint's own name already carries.
fn sidecar(worktree_dir: &Path, ext: &str) -> Option<PathBuf> {
    let name = worktree_dir.file_name()?.to_str()?;
    Some(worktree_dir.with_file_name(format!("{name}.{ext}")))
}

/// The marker pair an update holds for its whole window, released by `Drop` — and by
/// the OS if the process dies first, which is what makes the sweep safe.
pub(crate) struct UpdateMarker {
    json_path: PathBuf,
    lock_path: PathBuf,
    /// The locked handle. `Option` only so `Drop` can close it BEFORE the deletes:
    /// Windows refuses to unlink a file with an open handle.
    handle: Option<std::fs::File>,
    /// When cleared, `Drop` releases the lock but LEAVES both sidecars on disk.
    delete_on_drop: bool,
}

impl UpdateMarker {
    /// Mints the marker for the checkout about to be created at `worktree_dir`.
    /// Callers create it BEFORE the `worktree add` — that add is the longest part of
    /// the collision window, so the signal has to predate it. A creation failure
    /// refuses the update: an app-data write that fails is the same failure domain as
    /// materializing the checkout itself.
    pub(crate) fn create_for(worktree_dir: &Path, branch: &str) -> AppResult<UpdateMarker> {
        let (Some(json_path), Some(lock_path)) =
            (sidecar(worktree_dir, "json"), sidecar(worktree_dir, "lock"))
        else {
            return Err(AppError::Command(format!(
                "could not place an update marker beside {}",
                worktree_dir.display()
            )));
        };
        let manifest = serde_json::to_vec(&UpdateManifest {
            branch: branch.to_string(),
            pid: std::process::id(),
        })
        .map_err(|e| AppError::Command(format!("could not record the update marker: {e}")))?;
        std::fs::write(&json_path, manifest)?;

        let opened = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path);
        let file = match opened {
            Ok(file) => file,
            Err(e) => {
                let _ = std::fs::remove_file(&json_path);
                return Err(AppError::Io(e));
            }
        };
        if let Err(e) = file.try_lock() {
            drop(file);
            let _ = std::fs::remove_file(&lock_path);
            let _ = std::fs::remove_file(&json_path);
            return Err(AppError::Command(format!(
                "could not claim the update marker at {}: {e}",
                lock_path.display()
            )));
        }
        Ok(UpdateMarker {
            json_path,
            lock_path,
            handle: Some(file),
            delete_on_drop: true,
        })
    }

    /// Keeps both sidecars on disk when this marker drops, releasing only the lock.
    ///
    /// For a teardown that could not confirm the checkout is gone: deleting the sidecars
    /// there would turn a surviving directory into the `Missing` shape, which no
    /// age-free claim may touch and which therefore sits holding its branch until the
    /// age gate expires. Retained, it is a `Released` marker the very next branch
    /// operation can clear.
    pub(crate) fn retain_for_recovery(&mut self) {
        self.delete_on_drop = false;
    }
}

impl Drop for UpdateMarker {
    fn drop(&mut self) {
        // Closing releases the lock and, on Windows, is what makes the unlink legal.
        drop(self.handle.take());
        if !self.delete_on_drop {
            return;
        }
        let _ = std::fs::remove_file(&self.lock_path);
        let _ = std::fs::remove_file(&self.json_path);
    }
}

/// What a lock probe could establish. Four states because the consumers need different
/// defaults, and each state authorizes exactly one thing:
/// - only `Live` may say an update is RUNNING — an unreadable lock must never block a
///   user's action on a guess;
/// - only `Released` may authorize an AGE-FREE removal, and its refusal when that
///   removal cannot proceed says INTERRUPTED, which is what it just proved;
/// - `Missing` and `Unknown` prove nothing, so they authorize neither and leave every
///   caller at exactly the behavior it had before markers existed.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LockProbe {
    /// Someone holds the lock — the update that minted it is still running.
    Live,
    /// The lock file exists and was acquirable: its owner is provably gone, since the
    /// OS releases file locks on process death.
    Released,
    /// No lock file at all. NOT proof of death: a pre-marker binary mints no marker,
    /// and a stale one can still be running an update (a not-yet-restarted MCP server
    /// beside a rebuilt GUI). Only age can settle this shape.
    Missing,
    /// The probe established nothing — a transient IO failure.
    Unknown,
}

/// Probes the marker lock at `lock_path`.
///
/// SHARED, not exclusive: an exclusive probe excludes other PROBES, so two running
/// concurrently would have one read `WouldBlock` and call a dead marker `Live`. A shared
/// request still blocks against the minter's exclusive hold, which is the only signal
/// this needs. Two probes may now both read `Released` at once, which is harmless —
/// every destructive path re-probes under the worktree-admin domain, and
/// `remove_update_leftover` is idempotent.
fn probe_lock(lock_path: &Path) -> LockProbe {
    match std::fs::File::open(lock_path) {
        // The probe's own SHARED acquisition is released when `file` closes at end of
        // scope.
        Ok(file) => match file.try_lock_shared() {
            Ok(()) => LockProbe::Released,
            Err(std::fs::TryLockError::WouldBlock) => LockProbe::Live,
            Err(std::fs::TryLockError::Error(_)) => LockProbe::Unknown,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => LockProbe::Missing,
        Err(_) => LockProbe::Unknown,
    }
}

/// The manifest beside a marker, or `None` when it is missing, unreadable, or not the
/// shape this module writes — untrusted JSON is never allowed to panic or to refuse.
fn read_manifest(json_path: &Path) -> Option<UpdateManifest> {
    let bytes = std::fs::read(json_path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether `path` names an update's throwaway checkout — its basename starts with
/// `gd-update-`. Modeled on `ops::is_resolve_worktree_path`: the basename is the
/// reliable signal, since porcelain may print a normalized leading path.
pub(crate) fn is_update_worktree_path(path: &str) -> bool {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| name.starts_with(MARKER_PREFIX))
}

/// Whether `path` is an update checkout THIS app manages for `repo_path`: the mint
/// basename AND a parent that is the repo's own worktree root. The root scope is what
/// keeps a user's own worktree that merely happens to be named `gd-update-*` — with
/// some stray unlocked `.lock` beside it — out of every marker arm, refusal and
/// removal alike.
///
/// Compared through the repo's two path spellings (`canonical_wt_path` resolves
/// symlinks and Windows short names, `normalize_wt_path` is the second chance for a
/// path that no longer exists), since porcelain prints resolved paths while the root is
/// app-built. Any resolution failure answers `false`: cleanup fails CLOSED.
pub(crate) fn is_managed_update_worktree(repo_path: &str, path: &str) -> bool {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    if !is_update_worktree_path(path) {
        return false;
    }
    let (Ok(root), Some(parent)) = (root_for(repo_path), Path::new(path).parent()) else {
        return false;
    };
    let (parent, root) = (parent.to_string_lossy(), root.to_string_lossy());
    canonical_wt_path(&parent) == canonical_wt_path(&root)
        || normalize_wt_path(&parent) == normalize_wt_path(&root)
}

/// The lock state of the `gd-update-*` checkout at `path`. Callers match on all four
/// answers rather than a predicate: `Live` refuses, `Released` claims, and
/// `Missing`/`Unknown` prove nothing and behave exactly as if markers did not exist.
/// An unusable path reads `Unknown`.
pub(crate) fn update_worktree_probe(path: &str) -> LockProbe {
    match sidecar(Path::new(path), "lock") {
        Some(lock) => probe_lock(&lock),
        None => LockProbe::Unknown,
    }
}

/// One scan of a worktree root's markers.
struct RefuseOutcome {
    /// The ready-to-return refusal, when a LIVE update matches the query.
    pub(crate) refusal: Option<AppError>,
    /// A dead marker was seen — its leftovers are worth sweeping.
    pub(crate) saw_dead: bool,
}

/// Core of the refusal guards, over an explicit `root` so tests never write under the
/// real app data. `branch` scopes the query; `None` asks "is ANY update running", the
/// only honest question for a site that learns its branch name after the fact.
///
/// Deliberately liveness-only in `None` mode: an unreadable manifest still proves an
/// update is running, and that mode needs nothing else. In branch mode the manifest is
/// the match, so an unreadable one fails open.
fn refuse_in(root: &Path, branch: Option<&str>) -> RefuseOutcome {
    let mut outcome = RefuseOutcome {
        refusal: None,
        saw_dead: false,
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return outcome;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".lock") else {
            continue;
        };
        if !stem.starts_with(MARKER_PREFIX) {
            continue;
        }
        match probe_lock(&entry.path()) {
            LockProbe::Live => {}
            // `Missing` here means the file vanished between the listing and the open,
            // which is a finished update either way — both are sweepable leftovers.
            LockProbe::Released | LockProbe::Missing => {
                outcome.saw_dead = true;
                continue;
            }
            LockProbe::Unknown => continue,
        }
        match branch {
            None => {
                outcome.refusal = Some(any_update_refusal());
                return outcome;
            }
            Some(want) => {
                if read_manifest(&root.join(format!("{stem}.json")))
                    .is_some_and(|m| m.branch == want)
                {
                    outcome.refusal = Some(branch_update_refusal(want));
                    return outcome;
                }
            }
        }
    }
    outcome
}

/// Refuses when a live update is bringing `branch` up to date, and schedules a sweep
/// if the scan met a crash orphan on the way. Every guarded site is therefore also a
/// healing trigger.
pub(crate) async fn refuse_if_branch_updating(
    state: &AppState,
    repo_path: &str,
    branch: &str,
) -> AppResult<()> {
    refuse_and_heal(state, repo_path, Some(branch)).await
}

/// The repo-scoped form, for a site that cannot name the branch it is about to touch.
pub(crate) async fn refuse_if_any_updating(state: &AppState, repo_path: &str) -> AppResult<()> {
    refuse_and_heal(state, repo_path, None).await
}

/// The same refusal WITHOUT the healing sweep, for a caller whose very next step takes
/// the worktree-admin domain: a detached sweep fired here would win that domain by
/// milliseconds and turn an operation that would have succeeded into a `Busy`.
pub(crate) fn refuse_if_branch_updating_no_heal(repo_path: &str, branch: &str) -> AppResult<()> {
    let Ok(root) = root_for(repo_path) else {
        return Ok(());
    };
    match refuse_in(&root, Some(branch)).refusal {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

async fn refuse_and_heal(state: &AppState, repo_path: &str, branch: Option<&str>) -> AppResult<()> {
    let Ok(root) = root_for(repo_path) else {
        return Ok(());
    };
    let outcome = refuse_in(&root, branch);
    if outcome.saw_dead {
        spawn_orphan_sweep(state, repo_path).await;
    }
    match outcome.refusal {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Fires one background sweep, never blocking the caller on it. The domain is resolved
/// here and MOVED into the task, so the acquisition happens off this stack — a caller
/// may already hold the working-tree lock, or the admin domain itself, and neither may
/// nest with the other.
///
/// A caller holding the admin domain must RELEASE it before calling: the task's own
/// try-acquire would otherwise lose to that hold and the sweep would never run.
pub(crate) async fn spawn_orphan_sweep(state: &AppState, repo_path: &str) {
    let domain = state.worktree_admin_lock(repo_path).await;
    // The flag is process-global rather than per-repo — healing is best-effort and one
    // pass at a time is enough. Set with no await between here and the spawn, so a
    // caller cancelled mid-fn can never leave it set with no task to clear it.
    if SWEEP_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let repo = repo_path.to_string();
    tauri::async_runtime::spawn(async move {
        if let Some(_admin) = try_acquire_repo_lock(&domain, "a worktree operation") {
            sweep_update_orphans_locked(&repo).await;
        }
        SWEEP_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// Clears the ONE dead `gd-update-*` leftover at `holder`, a path a caller just read
/// out of `worktree list --porcelain`. `true` means it is gone and the caller should
/// re-probe; `false` means it must not proceed (still live, unprobeable, or the admin
/// domain was busy).
///
/// No age gate, unlike the background sweep, and `Released` is what buys that: the mint
/// writes and locks the marker BEFORE `worktree add`, so a registered checkout whose
/// lock file EXISTS was minted by a marker-era process, and the OS having released that
/// lock is direct proof the process died — never a mint-order race.
///
/// That proof covers only checkouts whose lock file exists. A `Missing` lock at a
/// registered holder means a pre-marker binary minted it, and such a binary can still
/// be running the update right now (a stale MCP-server exe beside a rebuilt GUI), so it
/// is refused here and left to the age-gated background sweep.
///
/// Root-scoped: only a checkout directly under THIS repo's app-data worktree root is
/// ours to force-remove. A user's own worktree that happens to be named `gd-update-*`
/// is never touched, whatever sits beside it.
pub(crate) async fn claim_dead_update_worktree(
    state: &AppState,
    repo_path: &str,
    holder: &str,
) -> bool {
    if !is_managed_update_worktree(repo_path, holder) {
        return false;
    }
    let path = Path::new(holder);
    let (Some(root), Some(stem), Some(lock)) = (
        path.parent(),
        path.file_name().and_then(|s| s.to_str()),
        sidecar(path, "lock"),
    ) else {
        return false;
    };
    if probe_lock(&lock) != LockProbe::Released {
        return false;
    }
    let domain = state.worktree_admin_lock(repo_path).await;
    let Some(_admin) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return false;
    };
    // Re-probe under the hold: the first probe raced anything that could have started
    // an update on this stem in between.
    if probe_lock(&lock) != LockProbe::Released {
        return false;
    }
    remove_update_leftover(repo_path, root, stem).await;
    true
}

/// Clears the leftovers of DEAD updates of `branch` specifically, age-free, so the very
/// next update of a branch a crash interrupted heals its own predecessor synchronously
/// instead of racing a detached sweep for the worktree-admin domain.
///
/// Same proof as [`claim_dead_update_worktree`] and the same limit: only a lock file
/// that EXISTS and is acquirable authorizes a removal, so a pre-marker build's
/// markerless checkout is never claimed here. No porcelain read is needed — the lock
/// file alone carries the proof.
pub(crate) async fn claim_dead_updates_for_branch(state: &AppState, repo_path: &str, branch: &str) {
    let Ok(root) = root_for(repo_path) else {
        return;
    };
    // Nothing to heal is the overwhelmingly common case; answer it without paying for
    // the domain resolution or its lock.
    if dead_stems_for_branch(&root, branch).is_empty() {
        return;
    }
    let domain = state.worktree_admin_lock(repo_path).await;
    let Some(_admin) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return;
    };
    claim_dead_stems_for_branch_locked(repo_path, &root, branch).await;
}

/// The body of [`claim_dead_updates_for_branch`], over an explicit root so tests can
/// drive it. The caller MUST hold the repo's worktree-admin domain.
async fn claim_dead_stems_for_branch_locked(repo_path: &str, root: &Path, branch: &str) {
    for stem in dead_stems_for_branch(root, branch) {
        // Re-probe under the hold, as the single-holder claim does.
        if probe_lock(&root.join(format!("{stem}.lock"))) != LockProbe::Released {
            continue;
        }
        remove_update_leftover(repo_path, root, &stem).await;
    }
}

/// The stems under `root` whose lock file exists, probes `Released`, and whose manifest
/// names `branch`. Age-free by construction: an existing-but-released lock is the
/// proof, so a markerless (`Missing`) stem is never a candidate here.
fn dead_stems_for_branch(root: &Path, branch: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut stems = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".lock") else {
            continue;
        };
        if !stem.starts_with(MARKER_PREFIX) {
            continue;
        }
        if probe_lock(&entry.path()) != LockProbe::Released {
            continue;
        }
        if read_manifest(&root.join(format!("{stem}.json"))).is_some_and(|m| m.branch == branch) {
            stems.push(stem.to_string());
        }
    }
    stems
}

/// Removes the `gd-update-*` leftovers a crashed or killed update left behind, so the
/// branches they still hold come free. Skipped entirely when the worktree-admin domain
/// is busy: a removal is in flight, healing is never urgent, and queueing would stall
/// the caller behind a multi-minute hold.
pub(crate) async fn sweep_orphaned_update_worktrees(state: &AppState, repo_path: &str) {
    let domain = state.worktree_admin_lock(repo_path).await;
    let Some(_admin) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return;
    };
    sweep_update_orphans_locked(repo_path).await;
}

/// The sweep body. The caller MUST already hold the repo's worktree-admin domain —
/// `run_git_worktree_admin` would re-acquire it and deadlock, so the runners here are
/// the lock-free ones, exactly as `branches.rs::remove_tmp_worktree` does.
async fn sweep_update_orphans_locked(repo_path: &str) {
    let Ok(root) = root_for(repo_path) else {
        return;
    };
    sweep_in(repo_path, &root, ORPHAN_MIN_AGE).await;
}

/// The sweep over an explicit root and age threshold, so tests can drive it against a
/// temp directory without waiting out the real one.
async fn sweep_in(repo_path: &str, root: &Path, min_age: Duration) {
    for stem in orphaned_update_stems(root, min_age) {
        remove_update_leftover(repo_path, root, &stem).await;
    }
}

/// Removes one claimed leftover: its checkout, git's admin entry, and the marker pair.
/// Lock-free runners — every caller already holds the worktree-admin domain.
async fn remove_update_leftover(repo_path: &str, root: &Path, stem: &str) {
    let dir = root.join(stem);
    if dir.exists() {
        let dir_str = dir.to_string_lossy().into_owned();
        let _ = run_git_raw(
            Some(repo_path),
            &["worktree", "remove", "--force", &dir_str],
            WORKTREE_OP_TIMEOUT,
        )
        .await;
        let _ = run_git_raw(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
        // git's own recursive delete mishandles Windows reparse points, and an
        // unregistered leftover is never its job at all.
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    let _ = std::fs::remove_file(root.join(format!("{stem}.lock")));
    let _ = std::fs::remove_file(root.join(format!("{stem}.json")));
}

/// The claim decision: which `gd-update-<stem>` leftovers under `root` a sweep may
/// take. Three conditions, all required — the basename prefix (this root also holds
/// the user's agent-session worktrees, and a mis-claim would delete one), a released or
/// absent lock, and an age past `min_age`. Anything unreadable is left alone.
///
/// The two shapes measure age from different things, because for a markerless checkout
/// the sidecars that would carry a mint time do not exist (see [`stem_age`]).
fn orphaned_update_stems(root: &Path, min_age: Duration) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    // Stem → the paths it owns, since a crash leaves any subset of dir/json/lock.
    let mut candidates: std::collections::BTreeMap<String, Vec<PathBuf>> =
        std::collections::BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let stem = if kind.is_dir() {
            name
        } else if let Some(stem) = name.strip_suffix(".lock").or(name.strip_suffix(".json")) {
            stem
        } else {
            continue;
        };
        if !stem.starts_with(MARKER_PREFIX) {
            continue;
        }
        candidates
            .entry(stem.to_string())
            .or_default()
            .push(entry.path());
    }

    let now = SystemTime::now();
    candidates
        .into_iter()
        .filter_map(|(stem, paths)| {
            // `Missing` is claimable HERE and nowhere else: the age gate is what stands
            // in for the proof a lock file would have given. `Unknown` and `Live` are
            // spared.
            let probe = probe_lock(&root.join(format!("{stem}.lock")));
            if !matches!(probe, LockProbe::Released | LockProbe::Missing) {
                return None;
            }
            let age = stem_age(root, &stem, &probe, &paths, now)?;
            (age >= min_age).then_some(stem)
        })
        .collect()
}

/// How long ago a stem last showed a sign of life. `None` whenever nothing readable can
/// answer, which leaves it unclaimed — the safe direction in every shape.
///
/// A marker-bearing (`Released`) stem measures from its own files: the sidecars are
/// written at mint time and never rewritten, so their mtime IS the update's start.
///
/// A markerless checkout has no such file, and its directory's mtime cannot stand in —
/// a directory's mtime does not move when git writes inside its SUBdirectories, so a
/// pre-marker binary's hours-long merge would read as untouched and be force-removed
/// mid-flight. It measures from the worktree's own git activity instead, via the
/// worktree manager's probe: the `index` (HEAD as fallback) inside the admin directory
/// its `.git` pointer names, which git rewrites on checkout, merge and commit alike.
/// Following the pointer also sidesteps guessing the admin directory's name, which git
/// de-duplicates. A checkout with no readable git state answers `None`.
fn stem_age(
    root: &Path,
    stem: &str,
    probe: &LockProbe,
    paths: &[PathBuf],
    now: SystemTime,
) -> Option<Duration> {
    let dir = root.join(stem);
    if *probe == LockProbe::Missing && dir.is_dir() {
        let ms = crate::git::worktree::worktree_last_activity_ms(&dir.to_string_lossy())?;
        let last =
            SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(u64::try_from(ms).ok()?))?;
        return Some(now.duration_since(last).unwrap_or(Duration::ZERO));
    }
    // The NEWEST mtime of anything the stem owns: the most recent sign of life is what
    // has to be old, not the oldest.
    let newest = paths
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok()?.modified().ok())
        .max()?;
    Some(now.duration_since(newest).unwrap_or(Duration::ZERO))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::run_git;

    fn temp_root(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-marker-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let root = dir.path().to_path_buf();
        (dir, root)
    }

    /// A DEAD marker pair: the manifest plus an unlocked `.lock`, the shape a crashed
    /// update leaves behind once the OS drops its lock.
    fn write_dead_marker(root: &Path, stem: &str, branch: &str) {
        std::fs::write(
            root.join(format!("{stem}.json")),
            serde_json::to_vec(&UpdateManifest {
                branch: branch.to_string(),
                pid: 4242,
            })
            .unwrap(),
        )
        .unwrap();
        std::fs::write(root.join(format!("{stem}.lock")), b"").unwrap();
    }

    #[test]
    fn create_writes_a_readable_manifest_and_holds_the_lock() {
        let (_guard, root) = temp_root("create");
        let wt = root.join("gd-update-1234-99");
        let marker = UpdateMarker::create_for(&wt, "feature").expect("the marker mints");

        let json = root.join("gd-update-1234-99.json");
        let lock = root.join("gd-update-1234-99.lock");
        // The manifest stays readable while the update runs — the whole reason the
        // lock lives in a SEPARATE file on Windows.
        let manifest = read_manifest(&json).expect("the manifest parses");
        assert_eq!(manifest.branch, "feature");
        assert_eq!(manifest.pid, std::process::id());
        assert_eq!(probe_lock(&lock), LockProbe::Live, "a held marker is live");

        drop(marker);
        assert!(!json.exists(), "the manifest is cleaned up");
        assert!(!lock.exists(), "the lock file is cleaned up");
    }

    #[test]
    fn refusal_matches_the_live_branch_and_nothing_else() {
        let (_guard, root) = temp_root("refuse");
        let _marker =
            UpdateMarker::create_for(&root.join("gd-update-live"), "feature").expect("mints");

        let hit = refuse_in(&root, Some("feature"));
        assert_eq!(
            hit.refusal.expect("the live branch is refused").to_string(),
            "A branch update is bringing feature up to date — try again when it finishes."
        );
        assert!(!hit.saw_dead);

        assert!(
            refuse_in(&root, Some("other")).refusal.is_none(),
            "another branch is untouched by this update"
        );
        assert_eq!(
            refuse_in(&root, None)
                .refusal
                .expect("any-mode refuses on liveness alone")
                .to_string(),
            "A branch update is running — try again when it finishes."
        );
    }

    /// A crash orphan refuses nothing — it holds no update — but it IS the signal
    /// that flips a guard site into a healing trigger.
    #[test]
    fn a_dead_marker_refuses_nothing_and_flags_a_sweep() {
        let (_guard, root) = temp_root("dead");
        write_dead_marker(&root, "gd-update-dead", "feature");

        for query in [Some("feature"), None] {
            let outcome = refuse_in(&root, query);
            assert!(outcome.refusal.is_none(), "{query:?} must not refuse");
            assert!(outcome.saw_dead, "{query:?} must flag the sweep");
        }
    }

    /// Untrusted JSON never decides a refusal: a manifest that doesn't parse leaves
    /// the branch query unmatched, and git's own error speaks as it does today.
    #[test]
    fn an_unparseable_manifest_fails_open() {
        let (_guard, root) = temp_root("badjson");
        let _marker =
            UpdateMarker::create_for(&root.join("gd-update-bad"), "feature").expect("mints");
        std::fs::write(root.join("gd-update-bad.json"), b"{\"branch\": 7}").unwrap();

        let outcome = refuse_in(&root, Some("feature"));
        assert!(outcome.refusal.is_none(), "a wrong-typed field fails open");
        assert!(
            !outcome.saw_dead,
            "the lock is still held, so nothing is dead"
        );
    }

    #[test]
    fn is_update_worktree_path_matches_the_mint_basename_only() {
        assert!(is_update_worktree_path("C:/data/worktrees/h/gd-update-1-2"));
        assert!(is_update_worktree_path(
            "/home/u/.local/share/w/h/gd-update-x"
        ));
        // A PARENT named like a mint must not make a child one.
        assert!(!is_update_worktree_path("C:/repos/gd-update-ish/feature"));
        assert!(!is_update_worktree_path("C:/data/worktrees/h/gd-resolve-1"));
        assert!(!is_update_worktree_path("C:/repos/app"));
    }

    /// The claim discipline, fixture by fixture. The decoys matter most: this root is
    /// shared with the user's agent-session worktrees, and claiming one would delete
    /// work the app promises to keep.
    #[test]
    fn the_sweep_claims_only_aged_dead_update_leftovers() {
        let (_guard, root) = temp_root("claims");

        std::fs::create_dir_all(root.join("gd-update-dead")).unwrap();
        write_dead_marker(&root, "gd-update-dead", "feature");

        // A live update — its lock is held for the length of this test.
        std::fs::create_dir_all(root.join("gd-update-busy")).unwrap();
        let live = UpdateMarker::create_for(&root.join("gd-update-busy"), "feature")
            .expect("the live marker mints");

        // A pre-marker build's orphan: the checkout with no marker at all. This bare
        // directory has no git state, so no activity signal can be read from it — and
        // the markerless shape claims only on that signal.
        std::fs::create_dir_all(root.join("gd-update-markerless")).unwrap();

        // The marker pair whose checkout is already gone.
        write_dead_marker(&root, "gd-update-pruned", "feature");

        // Decoys: an agent-session worktree (named by session id) and a near-miss.
        std::fs::create_dir_all(root.join("1a2b3c4d")).unwrap();
        std::fs::create_dir_all(root.join("gd-resolve-9")).unwrap();
        std::fs::create_dir_all(root.join("gd-updater-tool")).unwrap();

        let mut claimed = orphaned_update_stems(&root, Duration::ZERO);
        claimed.sort();
        assert_eq!(
            claimed,
            vec!["gd-update-dead".to_string(), "gd-update-pruned".to_string()],
            "a live marker, every non-mint basename, and a checkout whose activity \
             cannot be read are all spared"
        );

        assert!(
            orphaned_update_stems(&root, ORPHAN_MIN_AGE).is_empty(),
            "nothing this fresh is claimed at the production age gate"
        );

        drop(live);
        for decoy in ["1a2b3c4d", "gd-resolve-9", "gd-updater-tool"] {
            assert!(root.join(decoy).exists(), "{decoy} survives the decision");
        }
    }

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// End to end against a real repo, with every kind of neighbour present: the
    /// crash-orphaned update worktree is removed, its admin entry pruned, its marker
    /// files deleted, and the branch it held is free again — while a live update, a
    /// resolve worktree, and an agent-session checkout holding real content all come
    /// through the DELETING pass untouched.
    #[tokio::test]
    async fn the_sweep_frees_the_branch_an_orphaned_update_was_holding() {
        let (_guard, base) = temp_root("sweep-e2e");
        let repo = base.join("repo");
        let root = base.join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        git(&repo_s, &["init", "-q"]).await;
        git(&repo_s, &["config", "user.email", "t@t.local"]).await;
        git(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        git(&repo_s, &["add", "-A"]).await;
        git(&repo_s, &["commit", "-qm", "seed"]).await;
        git(&repo_s, &["branch", "feature"]).await;

        let orphan = root.join("gd-update-crashed");
        let orphan_s = orphan.to_string_lossy().into_owned();
        git(
            &repo_s,
            &["worktree", "add", "--quiet", &orphan_s, "feature"],
        )
        .await;
        write_dead_marker(&root, "gd-update-crashed", "feature");
        assert!(
            run_git_raw(Some(&repo_s), &["branch", "-D", "feature"], DEFAULT_TIMEOUT)
                .await
                .unwrap()
                .code
                != 0,
            "the fixture must reproduce the branch hold"
        );

        // An agent session's checkout, with content the app promises to keep.
        let session = root.join("1a2b3c4d");
        std::fs::create_dir_all(&session).unwrap();
        let session_file = session.join("notes.txt");
        std::fs::write(&session_file, b"agent work in progress\n").unwrap();
        // A local-PR resolve worktree, and a live update of another branch.
        std::fs::create_dir_all(root.join("gd-resolve-77")).unwrap();
        std::fs::create_dir_all(root.join("gd-update-busy")).unwrap();
        let live = UpdateMarker::create_for(&root.join("gd-update-busy"), "other")
            .expect("the live marker mints");
        // A dead leftover that is simply too young to claim.
        std::fs::create_dir_all(root.join("gd-update-young")).unwrap();
        write_dead_marker(&root, "gd-update-young", "feature");

        // The production age gate spares everything here: every fixture is seconds old,
        // which is exactly the young-dead case.
        sweep_in(&repo_s, &root, ORPHAN_MIN_AGE).await;
        assert!(
            orphan.exists() && root.join("gd-update-young").exists(),
            "nothing this fresh is removed at the production age gate"
        );

        // Now the deleting pass, with every neighbour still in place.
        sweep_in(&repo_s, &root, Duration::ZERO).await;

        assert!(!orphan.exists(), "the orphaned checkout is gone");
        assert!(
            !root.join("gd-update-crashed.lock").exists()
                && !root.join("gd-update-crashed.json").exists(),
            "the marker pair is gone with it"
        );
        assert!(
            !git(&repo_s, &["worktree", "list", "--porcelain"])
                .await
                .contains("gd-update-crashed"),
            "and its admin entry is pruned"
        );
        assert_eq!(
            run_git_raw(Some(&repo_s), &["branch", "-D", "feature"], DEFAULT_TIMEOUT)
                .await
                .unwrap()
                .code,
            0,
            "the branch the orphan was holding is free again"
        );

        // The neighbours: the session checkout keeps its bytes, the resolve worktree
        // stands, and the LIVE update survives a pass that would otherwise claim it.
        assert_eq!(
            std::fs::read(&session_file).expect("the session file survives"),
            b"agent work in progress\n",
            "an agent session's content is byte-identical after the sweep"
        );
        assert!(root.join("gd-resolve-77").exists(), "resolve worktree kept");
        assert!(
            root.join("gd-update-busy").exists() && root.join("gd-update-busy.lock").exists(),
            "a live update is spared at any age"
        );
        drop(live);
    }

    /// All four probe states. `Missing` and `Unknown` are the arms that matter: neither
    /// may read as released, because only `Released` authorizes an age-free removal.
    #[test]
    fn the_lock_probe_separates_all_four_states() {
        let (_guard, root) = temp_root("probe");
        let marker = UpdateMarker::create_for(&root.join("gd-update-held"), "feature")
            .expect("the marker mints");
        assert_eq!(
            probe_lock(&root.join("gd-update-held.lock")),
            LockProbe::Live
        );
        drop(marker);
        assert_eq!(
            probe_lock(&root.join("gd-update-held.lock")),
            LockProbe::Missing,
            "no lock file at all is the pre-marker orphan shape, not proof of death"
        );

        std::fs::write(root.join("gd-update-freed.lock"), b"").unwrap();
        assert_eq!(
            probe_lock(&root.join("gd-update-freed.lock")),
            LockProbe::Released,
            "an existing, acquirable lock proves its owner is gone"
        );

        // An open that fails as something OTHER than NotFound. There is no one
        // portable way to produce that, so each platform uses its own real shape.
        #[cfg(windows)]
        {
            // A directory where the lock file should be: Windows refuses to open one
            // as a file with ERROR_ACCESS_DENIED (measured, os error 5) — the same
            // class a transient share violation lands in.
            let blocked = root.join("gd-update-blocked.lock");
            std::fs::create_dir(&blocked).unwrap();
            assert_eq!(
                probe_lock(&blocked),
                LockProbe::Unknown,
                "an unreadable lock is never treated as dead"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let blocked = root.join("gd-update-blocked.lock");
            std::fs::write(&blocked, b"").unwrap();
            std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o000)).unwrap();
            // Root ignores the mode bits, and there is no second portable way to make
            // an open fail as anything but NotFound — so that case asserts nothing
            // rather than asserting something untrue.
            if std::fs::File::open(&blocked).is_err() {
                assert_eq!(
                    probe_lock(&blocked),
                    LockProbe::Unknown,
                    "an unreadable lock is never treated as dead"
                );
            }
        }
    }

    /// Negative control for the guard MECHANISM: the root holds a live marker and no
    /// worktree at all, so nothing but the marker scan can produce this refusal —
    /// delete the scan and the same fixture answers `Ok`.
    ///
    /// This fixture IS the pre-add window: minted, `worktree add` not yet run, nothing
    /// in porcelain. It is the only thing standing between a delete or a reset and an
    /// update that dies on a missing ref, which is why those sites guard on the marker
    /// before their porcelain read.
    #[test]
    fn the_refusal_comes_from_the_marker_not_from_git() {
        let (_guard, root) = temp_root("negative-control");
        let _marker =
            UpdateMarker::create_for(&root.join("gd-update-solo"), "feature").expect("mints");
        assert!(
            !root.join("gd-update-solo").exists(),
            "no checkout exists — git would have nothing to refuse"
        );
        assert!(refuse_in(&root, Some("feature")).refusal.is_some());
        // The no-heal form the pre-add guards use reaches the same verdict through the
        // same scan; only its healing differs.
        assert_eq!(
            refuse_in(&root, Some("feature"))
                .refusal
                .expect("the pre-add window refuses")
                .to_string(),
            branch_update_refusal("feature").to_string()
        );
        assert!(refuse_in(&root, Some("other")).refusal.is_none());
    }

    /// The targeted, age-free claim: only a lock that EXISTS and is acquirable, and
    /// only for the branch asked about. The markerless case is the one that matters —
    /// a pre-marker binary mints no lock and may still be running that update.
    #[test]
    fn the_branch_claim_takes_only_released_locks_for_that_branch() {
        let (_guard, root) = temp_root("branch-claim");

        std::fs::create_dir_all(root.join("gd-update-dead")).unwrap();
        write_dead_marker(&root, "gd-update-dead", "feature");

        // A live update of the same branch.
        std::fs::create_dir_all(root.join("gd-update-busy")).unwrap();
        let live = UpdateMarker::create_for(&root.join("gd-update-busy"), "feature")
            .expect("the live marker mints");

        // A dead update of a DIFFERENT branch.
        write_dead_marker(&root, "gd-update-other", "release");

        // A pre-marker build's checkout: no lock file at all.
        std::fs::create_dir_all(root.join("gd-update-markerless")).unwrap();

        assert_eq!(
            dead_stems_for_branch(&root, "feature"),
            vec!["gd-update-dead".to_string()],
            "live, other-branch, and markerless stems are all spared"
        );
        assert!(
            dead_stems_for_branch(&root, "nothing-here").is_empty(),
            "a branch with no leftovers claims nothing"
        );

        // And the removal it authorizes takes only that stem, with no age gate — the
        // headline crash-recovery case, where the next update heals its predecessor.
        // The repo path is bogus on purpose: every git call fails and the filesystem
        // fallback finishes the job, which is the arm that must not touch a neighbour.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(claim_dead_stems_for_branch_locked(
                "C:/nonexistent-repo",
                &root,
                "feature",
            ));
        assert!(
            !root.join("gd-update-dead").exists(),
            "the leftover is gone"
        );
        assert!(
            !root.join("gd-update-dead.lock").exists()
                && !root.join("gd-update-dead.json").exists(),
            "with its marker pair"
        );
        assert!(
            root.join("gd-update-busy").exists()
                && root.join("gd-update-other.lock").exists()
                && root.join("gd-update-markerless").exists(),
            "the live, other-branch, and markerless neighbours are untouched"
        );
        drop(live);
    }

    /// Regression pin: a REGISTERED `gd-update-*` checkout with no lock file must never
    /// take the age-free claim. Its minter was a pre-marker binary, which can still be
    /// running the update — only the age-gated sweep may ever touch it.
    #[tokio::test]
    async fn a_markerless_holder_is_never_claimed_age_free() {
        let (_guard, root) = temp_root("markerless-claim");
        let orphan = root.join("gd-update-premarker");
        std::fs::create_dir_all(&orphan).unwrap();
        assert_eq!(
            update_worktree_probe(&orphan.to_string_lossy()),
            LockProbe::Missing
        );

        let state = AppState::default();
        assert!(
            !claim_dead_update_worktree(&state, "C:/nonexistent-repo", &orphan.to_string_lossy())
                .await,
            "a markerless holder is refused before any git runs"
        );
        assert!(orphan.exists(), "and its checkout is left untouched");

        // Nor does the background sweep take it on this fixture: a bare directory has no
        // git state, and the markerless shape is claimable only off an activity signal.
        assert!(
            orphaned_update_stems(&root, Duration::ZERO).is_empty(),
            "an unreadable checkout is never claimed, at any age"
        );
    }

    /// A teardown that could not remove the checkout must leave the marker RECOVERABLE:
    /// sidecars retained and unlocked, i.e. `Released`, so the next branch operation
    /// clears it age-free. Deleting them there would leave a markerless holder that
    /// nothing may touch until the age gate expires.
    #[test]
    fn a_failed_teardown_retains_the_marker_as_released() {
        let (_guard, root) = temp_root("retain");
        let dir = root.join("gd-update-stuck");
        std::fs::create_dir_all(&dir).unwrap();
        let mut marker = UpdateMarker::create_for(&dir, "feature").expect("the marker mints");
        assert_eq!(
            probe_lock(&root.join("gd-update-stuck.lock")),
            LockProbe::Live
        );

        // The teardown could not confirm the directory was gone.
        marker.retain_for_recovery();
        drop(marker);

        assert!(
            root.join("gd-update-stuck.lock").exists()
                && root.join("gd-update-stuck.json").exists(),
            "both sidecars survive a failed teardown"
        );
        assert_eq!(
            probe_lock(&root.join("gd-update-stuck.lock")),
            LockProbe::Released,
            "and the lock is released, so a claim can recover it immediately"
        );
        assert_eq!(
            dead_stems_for_branch(&root, "feature"),
            vec!["gd-update-stuck".to_string()],
            "the age-free branch claim picks it up with no waiting"
        );
    }

    /// Root scope: a `gd-update-*` worktree the USER made, outside our app-data root, is
    /// theirs. Even with a stray unlocked `.lock` beside it — which would otherwise read
    /// `Released` — no marker arm may claim or refuse on it.
    #[test]
    fn a_user_worktree_outside_the_root_is_never_managed() {
        let (_guard, base) = temp_root("scope");
        let root = base.join("worktrees");
        let elsewhere = base.join("user-repos");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let repo = "C:/repos/app";

        let mine = root.join("gd-update-1-2");
        std::fs::create_dir_all(&mine).unwrap();
        assert!(is_managed_update_worktree(repo, &mine.to_string_lossy()));

        // Same basename, same stray sidecar, different parent.
        let theirs = elsewhere.join("gd-update-1-2");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(elsewhere.join("gd-update-1-2.lock"), b"").unwrap();
        assert_eq!(
            probe_lock(&elsewhere.join("gd-update-1-2.lock")),
            LockProbe::Released,
            "the fixture must reproduce the tempting shape"
        );
        assert!(
            !is_managed_update_worktree(repo, &theirs.to_string_lossy()),
            "a user's own worktree is out of scope however its neighbours look"
        );
        // A nested path under our root is not a direct child, so it is not ours either.
        assert!(!is_managed_update_worktree(
            repo,
            &root.join("nested").join("gd-update-1-2").to_string_lossy()
        ));
    }

    /// The markerless shape's age gate must read a signal git actually MOVES. A
    /// directory's own mtime does not change when git writes inside its subdirectories,
    /// so measuring from it would call a pre-marker binary's hours-long merge idle and
    /// force-remove it mid-flight. This drives a REAL worktree, where the activity probe
    /// has something to read.
    #[tokio::test]
    async fn a_markerless_checkout_ages_from_its_git_activity() {
        let (_guard, base) = temp_root("markerless-age");
        let repo = base.join("repo");
        let root = base.join("worktrees");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        git(&repo_s, &["init", "-q"]).await;
        git(&repo_s, &["config", "user.email", "t@t.local"]).await;
        git(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        git(&repo_s, &["add", "-A"]).await;
        git(&repo_s, &["commit", "-qm", "seed"]).await;
        git(&repo_s, &["branch", "feature"]).await;

        // A pre-marker binary's checkout: registered, no sidecars anywhere.
        let wt = root.join("gd-update-premarker");
        let wt_s = wt.to_string_lossy().into_owned();
        git(&repo_s, &["worktree", "add", "--quiet", &wt_s, "feature"]).await;
        assert_eq!(update_worktree_probe(&wt_s), LockProbe::Missing);
        assert!(
            crate::git::worktree::worktree_last_activity_ms(&wt_s).is_some(),
            "the fixture must give the probe an index to read"
        );

        // Freshly checked out, so at the production gate it reads BUSY, not orphaned —
        // this is the arm that protects a still-running pre-marker update.
        assert!(
            orphaned_update_stems(&root, ORPHAN_MIN_AGE).is_empty(),
            "a checkout git touched moments ago is never claimed"
        );
        // And it stays reachable: with the threshold dropped, the same signal claims it.
        assert_eq!(
            orphaned_update_stems(&root, Duration::ZERO),
            vec!["gd-update-premarker".to_string()],
            "the shape still heals once it is genuinely stale"
        );
    }
}
