//! Throwaway `git worktree`s for agent sessions: every write-capable agent run
//! happens in an isolated branch checkout OUTSIDE the repo, so the user's working
//! tree, index, and current branch are never touched no matter what the agent does.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::git::branches::{
    direct_tracking_target, remove_deleted_branch_section, restore_upstream, TrackedBy,
    UPSTREAM_WRITE_FAILED,
};
use crate::git::runner::{
    acquire_repo_lock, acquire_repo_lock_unbounded, config_lock_busy, is_config_lock_contention,
    run_git, run_git_raw, run_git_raw_input, run_git_worktree_admin, try_acquire_repo_lock,
    with_config_write_lock, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::state::AppState;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The short session id (also the worktree's directory name).
    pub id: String,
    /// Absolute path to the worktree checkout.
    pub path: String,
    /// The session branch (`gd/session/<id>`), or empty if detached.
    pub branch: String,
    /// The commit the worktree was created from — the base for a session's
    /// cumulative `base..HEAD` diff. Resolved by `create`; empty from `list`.
    pub base: String,
}

/// A worktree as shown in the **user-facing** worktree manager — richer than the
/// agent-session `WorktreeInfo` (adds HEAD + main/detached/locked state). Session
/// worktrees are filtered out before this is ever built (see `git_worktree_list_user`).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserWorktree {
    /// Absolute path to the checkout (as git reports it — forward slashes).
    pub path: String,
    /// The checked-out branch, or "" when detached.
    pub branch: String,
    /// The worktree's HEAD commit sha (full).
    pub head: String,
    /// The repo's main worktree (git always lists it first); undeletable.
    pub is_main: bool,
    /// Detached HEAD — no branch checked out.
    pub is_detached: bool,
    /// `git worktree lock`ed — blocks prune/remove without `--force`.
    pub is_locked: bool,
    /// The lock reason, when one was given (else "").
    pub lock_reason: String,
    /// Epoch ms of the worktree's last git activity, probed from its index
    /// file's mtime with HEAD as the fallback. `None` when neither is readable.
    pub last_activity_ms: Option<i64>,
}

/// Normalizes a worktree path for cross-source comparison: git prints forward
/// slashes while the app stores native separators (back-slashes on Windows), and
/// Windows paths are case-insensitive. Lower-casing is harmless on Unix here —
/// session-dir comparisons are app-generated vs. git's own output, and the
/// registration check (`canonical_wt_path`) can only over-report "registered",
/// which refuses a fallback delete: the safe direction.
pub(crate) fn normalize_wt_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

/// A short, stable hash of the repo path, used to namespace a repo's session
/// worktrees. Lower-cased first since Windows paths are case-insensitive. Kept in sync
/// BY HAND with `ops::repo_hash`, which `ops_and_worktree_repo_hash_agree` enforces.
pub(crate) fn repo_hash(repo_path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    repo_path.to_lowercase().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// A reasonably unique session id: process id + the low bits of the current
/// time. Collisions are astronomically unlikely at human session-creation pace,
/// and `git worktree add -b` fails loudly on a duplicate branch regardless.
fn new_session_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:x}{:x}", std::process::id(), nanos & 0xffff_ffff_ffff)
}

/// The per-repo session-worktree root: `<app_data>/worktrees/<repo-hash>`.
fn worktree_root(app: &AppHandle, repo_path: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .join("worktrees")
        .join(repo_hash(repo_path));
    Ok(dir)
}

/// Build the argv that adds a session worktree on a fresh branch. Pure so the
/// flag table is unit-testable without a repo.
///
/// `--no-track` keeps `branch.autoSetupMerge` (`always`, or `inherit` off a
/// tracking base) from giving the session branch an upstream, which would make
/// it eligible for merged-branch cleanup. It stays outside the `-b <branch>`
/// pair, which must not be split.
fn build_session_worktree_add_args<'a>(
    branch: &'a str,
    path: &'a str,
    base: &'a str,
) -> Vec<&'a str> {
    vec!["worktree", "add", "--no-track", "-b", branch, path, base]
}

/// The start point a new worktree branches from: trimmed, `HEAD` when absent or
/// blank, and otherwise through the shared ref chokepoint before it reaches argv,
/// where a leading `-` would parse as a `worktree add` option.
fn worktree_base_ref(base: Option<&str>) -> AppResult<&str> {
    let base = base
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    crate::git::branches::validate_ref_name(base)?;
    Ok(base)
}

/// Creates a throwaway worktree off `base_ref` (default HEAD) on a fresh
/// `gd/session/<id>` branch, under the app-data worktree root. Returns the new
/// worktree's id/path/branch.
#[tauri::command]
pub async fn git_worktree_create(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    base_ref: Option<String>,
) -> AppResult<WorktreeInfo> {
    let base = worktree_base_ref(base_ref.as_deref())?;
    let id = new_session_id();
    let branch = format!("gd/session/{id}");
    let root = worktree_root(&app, &repo_path)?;
    std::fs::create_dir_all(&root)?;
    let path = root.join(&id);
    let path_str = path.to_string_lossy().into_owned();
    run_git_worktree_admin(
        &state,
        &repo_path,
        &build_session_worktree_add_args(&branch, &path_str, base),
        WORKTREE_OP_TIMEOUT,
    )
    .await?;
    // The fresh worktree's HEAD is exactly the base commit (no turns yet); record
    // it so the session diff can show the cumulative `base..HEAD` across turns.
    let head = run_git(Some(&path_str), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    Ok(WorktreeInfo {
        id,
        path: path_str,
        branch,
        base: head.stdout_lossy().trim().to_string(),
    })
}

/// Lists the repo's worktrees (main checkout included). Used to discover orphaned
/// session worktrees left by a crash so they can be cleaned up.
#[tauri::command]
pub async fn git_worktree_list(repo_path: String) -> AppResult<Vec<WorktreeInfo>> {
    let out = run_git(
        Some(&repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_worktree_list(&out.stdout_lossy()))
}

/// Prunes stale worktree admin entries ONLY IF the admin domain is free right now.
/// Contended means an admin op (a removal) is in flight, and this prune is
/// skippable: its result is discarded either way, a removal runs its own prune when
/// it ends, and queueing would stall the list read behind a multi-minute hold.
/// Having pruned, it releases the hold and fires a DETACHED sweep for interrupted
/// updates' orphaned checkouts, which prune itself cannot reach.
/// `true` when the prune ran.
pub(crate) async fn prune_worktrees_if_free(state: &AppState, repo_path: &str) -> bool {
    let domain = state.worktree_admin_lock(repo_path).await;
    let Some(guard) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return false;
    };
    let _ = run_git(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    // Released before the sweep is fired, and the sweep detached: it heals what prune
    // cannot (an interrupted update's checkout is never prunable, still holds a branch,
    // and is filtered from every listing), but removing one runs for minutes, which
    // this read must never wait on — and a task spawned under our own hold would lose
    // its try-acquire to us and do nothing.
    drop(guard);
    crate::git::update_marker::spawn_orphan_sweep(state, repo_path).await;
    true
}

/// Lists the repo's **user** worktrees for the worktree manager — every checkout
/// except the app-internal agent-session ones; the main worktree is always first
/// and undeletable. Prunes first (when nothing else is doing admin work) so stale
/// admin entries (directory deleted out-of-band) self-heal — such an entry also
/// holds a branch lock, and it's filtered from the list, so the manager could never
/// clear it otherwise. Git never prunes a *locked* worktree, so one on a
/// temporarily-disconnected drive is safe if the user locked it. The list read
/// itself is lock-free, so it still answers while a removal runs.
///
/// `prune: Some(false)` skips the prune and its orphan sweep for a passive read (a
/// row hint painting), so rendering never unlinks an unlocked worktree on a
/// disconnected drive; absent or `true` keeps the prune-first read.
#[tauri::command]
pub async fn git_worktree_list_user(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    prune: Option<bool>,
) -> AppResult<Vec<UserWorktree>> {
    // Authoritative exclusion: the sessions registry's owned worktree paths.
    let session_paths = crate::sessions::session_worktree_paths(&app);
    // Defense-in-depth: anything under the app-data worktrees root.
    let app_data_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| normalize_wt_path(&d.join("worktrees").to_string_lossy()));
    list_user_worktrees_impl(
        &state,
        &repo_path,
        &session_paths,
        app_data_root.as_deref(),
        prune.unwrap_or(true),
    )
    .await
}

/// The body of `git_worktree_list_user` with the app-derived exclusions already
/// resolved. `prune` false never calls `prune_worktrees_if_free`, so neither the
/// prune nor the orphan sweep it fires runs; the list and filters are shared.
async fn list_user_worktrees_impl(
    state: &AppState,
    repo_path: &str,
    session_paths: &std::collections::HashSet<String>,
    app_data_root: Option<&str>,
    prune: bool,
) -> AppResult<Vec<UserWorktree>> {
    if prune {
        prune_worktrees_if_free(state, repo_path).await;
    }
    let out = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let raw = parse_worktree_porcelain(&out.stdout_lossy());

    let user = raw
        .into_iter()
        .enumerate()
        .filter(|(_, w)| !w.prunable)
        // The main worktree (index 0) is never a session worktree; keep it
        // unconditionally so the user can always switch back to it.
        .filter(|(i, w)| *i == 0 || !is_session_worktree(w, session_paths, app_data_root))
        .map(|(i, w)| UserWorktree {
            is_main: i == 0,
            is_detached: w.detached,
            is_locked: w.locked.is_some(),
            lock_reason: w.locked.unwrap_or_default(),
            last_activity_ms: worktree_last_activity_ms(&w.path),
            path: w.path,
            branch: w.branch,
            head: w.head,
        })
        .collect();
    Ok(user)
}

/// Creates a **user** worktree at `path`. With `new_branch`, branches `branch` off
/// `base_ref` (default HEAD) and checks it out (`worktree add -b`); otherwise checks
/// out the EXISTING `branch`. Distinct from `git_worktree_create`, which makes
/// app-internal `gd/session/*` worktrees under app-data. Never `--force`s: a branch
/// already checked out elsewhere fails loudly with git's own message.
#[tauri::command]
pub async fn git_worktree_add_user(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    branch: String,
    new_branch: bool,
    base_ref: Option<String>,
) -> AppResult<()> {
    git_worktree_add_user_core(
        &state,
        &repo_path,
        &path,
        &branch,
        new_branch,
        base_ref.as_deref(),
    )
    .await
}

pub(crate) async fn git_worktree_add_user_core(
    state: &AppState,
    repo_path: &str,
    path: &str,
    branch: &str,
    new_branch: bool,
    base_ref: Option<&str>,
) -> AppResult<()> {
    let branch = branch.trim();
    let path = path.trim();
    if branch.is_empty() {
        return Err(AppError::InvalidArgument("a branch is required".into()));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument("a worktree path is required".into()));
    }
    // A leading '-' would be parsed as a git option, not a path/branch.
    if path.starts_with('-') || branch.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "path and branch must not start with '-'".into(),
        ));
    }
    refuse_ambiguous_worktree_path(path, cfg!(windows))?;
    crate::git::branches::refuse_session_branch_name(branch)?;
    if std::path::Path::new(repo_path).join(path).exists() {
        return Err(AppError::InvalidArgument(format!(
            "{path} already exists — choose a new folder"
        )));
    }
    let base = worktree_base_ref(base_ref)?;
    // Before the add: a line written ahead of a failed add is inert.
    exclude_if_inside_gitdesktop(repo_path, &resolve_worktree_path(repo_path, path)).await;
    if new_branch {
        return add_worktree_on_new_branch(state, repo_path, path, branch, base).await;
    }
    // Existing-branch arm only: `-b` creates the name, so a collision there is
    // already git's clear "already exists". Here the branch may be held by an
    // update's hidden checkout, which git names by an app-data path. Heal-free:
    // the `worktree add` below takes the admin domain, and a sweep fired here
    // would win it first and turn a would-succeed add into a `Busy`.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, branch).await?;
    let args = ["worktree", "add", path, branch];
    run_git_worktree_admin(state, repo_path, &args, WORKTREE_OP_TIMEOUT).await?;
    Ok(())
}

/// The worktree manager's `worktree add -b`, run under the held admin domain without the
/// config-write mutex. If its child `git branch` loses the config lock (branch created,
/// no upstream, no worktree), it finishes as `finish_tracking_setup` does: the worktree
/// leg runs first, whatever the upstream's fate, then only an upstream git itself would
/// have pinned is restored, under the mutex as a leaf (`inherit` is never guessed). One
/// that can't be pinned leaves git's error, and one whose repair fails says what landed;
/// either way the worktree was added.
async fn add_worktree_on_new_branch(
    state: &AppState,
    repo_path: &str,
    path: &str,
    branch: &str,
    base: &str,
) -> AppResult<()> {
    let domain = state.worktree_admin_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a worktree operation").await?;
    let args = ["worktree", "add", "-b", branch, path, base];
    let out = run_git_raw(Some(repo_path), &args, WORKTREE_OP_TIMEOUT).await?;
    let lost_upstream =
        is_config_lock_contention(&out.stderr) && out.stderr.contains(UPSTREAM_WRITE_FAILED);
    if out.code == 0 || !lost_upstream {
        return out.exit_verdict().map(drop);
    }
    let upstream = direct_tracking_target(repo_path, base, TrackedBy::AutoSetupMerge).await;
    let args = ["worktree", "add", path, branch];
    run_git_raw(Some(repo_path), &args, WORKTREE_OP_TIMEOUT)
        .await?
        .exit_verdict()?;
    let Some(upstream) = upstream else {
        return out.exit_verdict().map(drop);
    };
    let restored = with_config_write_lock(repo_path, |held| async move {
        restore_upstream(&held, repo_path, branch, &upstream).await
    })
    .await;
    if restored {
        return Ok(());
    }
    // Re-adding fails on the existing path and branch; setting the upstream finishes.
    Err(config_lock_busy(&format!(
        "the worktree and branch {branch} were created without upstream tracking — set \
         the upstream on {branch} to finish."
    )))
}

/// Renames (moves) a user worktree from `from_path` to `to_path`
/// (`git worktree move`) — updates git's admin metadata and the worktree's `.git`
/// pointer file. Git refuses to move the **main** worktree, to move onto an
/// existing path, or to move a **locked** worktree (unlock it first); those
/// surface as git's own message. The caller must not move the worktree it's
/// currently running in (the UI disables that).
#[tauri::command]
pub async fn git_worktree_move(
    state: State<'_, AppState>,
    repo_path: String,
    from_path: String,
    to_path: String,
) -> AppResult<()> {
    let from = from_path.trim();
    let to = to_path.trim();
    if from.is_empty() || to.is_empty() {
        return Err(AppError::InvalidArgument(
            "both worktree paths are required".into(),
        ));
    }
    // A leading '-' would be parsed as a git option.
    if from.starts_with('-') || to.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "paths must not start with '-'".into(),
        ));
    }
    if std::path::Path::new(to).exists() {
        return Err(AppError::InvalidArgument(format!(
            "{to} already exists — choose a new name"
        )));
    }
    run_git_worktree_admin(
        &state,
        &repo_path,
        &["worktree", "move", from, to],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Locks a worktree (`git worktree lock`) so git won't prune, move, or remove it
/// without `--force` — useful for one on a removable or network drive, or to
/// guard it from accidental removal. An optional `reason` is shown back to the
/// user (in the lock badge + the delete confirm). Git refuses the main worktree.
#[tauri::command]
pub async fn git_worktree_lock(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    reason: Option<String>,
) -> AppResult<()> {
    let path = worktree_path_arg(&path)?;
    let reason = reason.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut args: Vec<&str> = vec!["worktree", "lock"];
    // `--reason` consumes the next token as its value, so a reason starting with
    // '-' is parsed as the value, not an option — no injection via the Vec API.
    if let Some(r) = reason {
        args.push("--reason");
        args.push(r);
    }
    args.push(path);
    run_git_worktree_admin(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Unlocks a worktree previously locked with `git_worktree_lock`.
#[tauri::command]
pub async fn git_worktree_unlock(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
) -> AppResult<()> {
    let path = worktree_path_arg(&path)?;
    run_git_worktree_admin(
        &state,
        &repo_path,
        &["worktree", "unlock", path],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Repairs worktree administrative links (`git worktree repair`) after the
/// repository folder was moved or renamed — which breaks the absolute paths git
/// records in each linked worktree's `.git` pointer (and the main repo's
/// `.git/worktrees/<id>/gitdir`). Run from anywhere in the repo; it re-derives
/// the paths. Safe + idempotent — a no-op when the links are already correct.
#[tauri::command]
pub async fn git_worktree_repair(
    state: State<'_, AppState>,
    repo_path: String,
) -> AppResult<()> {
    run_git_worktree_admin(
        &state,
        &repo_path,
        &["worktree", "repair"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The comparison form of a worktree path: `normalize_wt_path` over the RESOLVED
/// path, since git records worktrees canonically — a symlinked parent (macOS
/// `/var` → `/private/var`) or a Windows verbatim prefix would otherwise read as a
/// different worktree. Unresolvable paths (already deleted) fall back to the raw
/// form; both sides get the same treatment, so quirks cancel out.
pub(crate) fn canonical_wt_path(p: &str) -> String {
    let resolved = dunce::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string());
    normalize_wt_path(&strip_verbatim(&resolved))
}

/// Unwraps a Windows verbatim spelling to the form git prints. `dunce` drops the
/// prefix only from drive paths it can express plainly (dunce 1.0.5 keeps it past
/// MAX_PATH, on reserved names, and on every UNC share), so both leftover forms land
/// here: `\\?\UNC\server\share` must fold to git's `//server/share`, never
/// `unc/server/share`. Pure string work, so tests never touch the filesystem.
///
/// The UNC prefix matches case-insensitively, as Windows parses it: the
/// canonicalize-failed fallback passes a caller's own spelling through here.
fn strip_verbatim(resolved: &str) -> String {
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    let is_unc = resolved
        .get(..VERBATIM_UNC.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(VERBATIM_UNC));
    if is_unc {
        // ASCII prefix matched, so its length is a char boundary.
        return format!(r"\\{}", &resolved[VERBATIM_UNC.len()..]);
    }
    resolved
        .strip_prefix(r"\\?\")
        .unwrap_or(resolved)
        .to_string()
}

/// Whether git still lists `path` as a LIVE worktree of the repo. An unreadable
/// registry answers `true`: the caller uses this to decide whether deleting the
/// folder is safe, and uncertainty must never authorize a delete.
///
/// A `prunable` entry answers `false` even though it is listed: git has already
/// torn the worktree down past the point of policy refusal, so the caller's
/// delete-then-prune fallback is the right recovery. For the variant that leaves the
/// checkout on disk with its gitdir link gone, that fallback is the ONLY recovery,
/// because git refuses `worktree remove` on it in both force modes ("validation
/// failed, cannot remove working tree: '<path>/.git' does not exist"). With the
/// directory fully gone git's own remove succeeds and this never has to arbitrate.
async fn worktree_is_registered(repo_path: &str, path: &str) -> bool {
    let out = run_git_raw(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await;
    match out {
        Ok(out) if out.code == 0 => {
            let target = canonical_wt_path(path);
            parse_worktree_porcelain(&out.stdout_lossy())
                .iter()
                .any(|w| canonical_wt_path(&w.path) == target && !w.prunable)
        }
        _ => true,
    }
}

/// What a removal did with the branch it was asked to delete. The spared arms
/// let the caller tell the user a branch they expected gone is still there.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum BranchCleanup {
    Deleted,
    /// The tip gained commits since the removal began, so deleting it would drop them.
    SparedMoved,
    /// The tip couldn't be read or git refused the delete; the branch is left as is.
    SparedUnreadable,
    /// No branch was passed, or it was already gone.
    NotRequested,
}

/// The `git_worktree_remove` result; the TS mirror is `WorktreeRemoveOutcome` in
/// `src/lib/git/worktree.ts`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveOutcome {
    pub branch_cleanup: BranchCleanup,
}

/// Removes a session worktree and (when given) deletes its branch. `force` is
/// needed to drop a worktree with uncommitted changes (a discarded session
/// whose output was never committed) or a locked one.
#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    branch: Option<String>,
    force: bool,
) -> AppResult<WorktreeRemoveOutcome> {
    remove_worktree(&state, &repo_path, &path, branch, force).await
}

/// The body of `git_worktree_remove`, callable without a Tauri `State`.
pub(crate) async fn remove_worktree(
    state: &AppState,
    repo_path: &str,
    path: &str,
    branch: Option<String>,
    force: bool,
) -> AppResult<WorktreeRemoveOutcome> {
    let mut args = vec!["worktree", "remove"];
    if force {
        // Doubled deliberately: git requires `--force` TWICE to remove a LOCKED
        // worktree ("use 'remove -f -f'"); the second flag is a no-op for a
        // merely-dirty one.
        args.push("--force");
        args.push("--force");
    }
    args.push(path);

    // The WORKTREE-ADMIN domain only, and unbounded: this hold spans a whole
    // checkout's deletion (minutes on a large tree), so taking the working-tree lock
    // with it would stall staging and committing for the duration — the bug the
    // delete dialog's "you can close this and keep working" promise depends on.
    // Nothing may error out of the wait: the removal IS the long operation.
    let domain = state.worktree_admin_lock(repo_path).await;
    let _guard = acquire_repo_lock_unbounded(&domain, "a worktree removal").await;

    // The branch delete is decided from the tip observed BEFORE the removal instead
    // of from a working-tree hold: git itself refuses to delete a branch checked out
    // in any worktree, and the equality check below covers the commit race the old
    // whole-repo hold closed — a hold that never reached another process (the MCP
    // server) anyway. An unreadable tip skips the delete.
    let branch = branch.as_deref().filter(|b| !b.is_empty());
    let expected_tip = match branch {
        Some(b) => read_branch_tip(repo_path, b).await,
        None => TipRead::Absent,
    };

    // `git worktree remove` deletes the directory itself, but its recursive delete
    // mishandles Windows reparse points: a worktree with pnpm-installed deps
    // (`node_modules/*` junctioned into `.pnpm/`) fails with `failed to delete
    // '<path>': Invalid argument`, half-removed. Finish it ourselves —
    // `std::fs::remove_dir_all` deletes reparse points as links (hardened since Rust
    // 1.63) — then `prune` to reconcile git's dangling admin entry.
    if let Err(git_err) = run_git(Some(repo_path), &args, WORKTREE_OP_TIMEOUT).await {
        // Two measured orderings: git's own FAILED delete still unregisters, so a live
        // registration means a policy refusal (dirty, locked, main) — surface it, since
        // the frontend reads that error to offer the forced retry. A KILLED delete
        // instead leaves the entry over a half-deleted directory, which
        // `worktree_is_registered` reports as unregistered so this fallback can finish
        // it. An unreadable registry counts as registered: never delete on a guess.
        if worktree_is_registered(repo_path, path).await {
            return Err(git_err);
        }
        // Deleting a whole checkout runs for minutes on a large tree; keep it off the
        // async worker thread.
        let target = path.to_string();
        let removed = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(target))
            .await
            .map_err(|e| AppError::Command(format!("Worktree removal task failed: {e}")))?;
        match removed {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // Removed despite an error partway (a child vanished under us) — good enough.
            Err(_) if !std::path::Path::new(path).exists() => {}
            // Still there — usually a file locked by another process (an editor, terminal, or
            // file watcher holding a handle in `node_modules`/`target`). Surface THAT cause
            // rather than git's stale "Invalid argument", so the message is actionable.
            Err(e) => {
                return Err(AppError::Command(format!(
                    "Couldn't remove the worktree at {path}: {e}. Close any program using that folder (editor, terminal, file watcher) and try again."
                )));
            }
        }
        // Best-effort reconcile: a prune hiccup must never turn a successful removal
        // into a reported failure.
        let _ = run_git(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    }
    // The branch can only be deleted once it's no longer checked out (i.e. after
    // the worktree is gone). Best-effort: a failure here shouldn't fail removal.
    let branch_cleanup = match (branch, expected_tip) {
        (Some(branch), TipRead::Present(expected_tip)) => {
            delete_branch_if_unmoved(repo_path, branch, &expected_tip).await
        }
        (Some(_), TipRead::Unreadable) => BranchCleanup::SparedUnreadable,
        _ => BranchCleanup::NotRequested,
    };
    Ok(WorktreeRemoveOutcome { branch_cleanup })
}

/// A branch-tip read that keeps "gone" apart from "couldn't tell".
#[derive(Debug, PartialEq, Eq)]
enum TipRead {
    Present(String),
    /// `rev-parse --verify --quiet` exits 1 with no output for a missing ref.
    Absent,
    /// An invalid name, a failed spawn, or any other git failure.
    Unreadable,
}

/// The commit `refs/heads/<branch>` points at.
///
/// Fully qualified: bare `rev-parse <name>` resolves a same-named TAG first, which
/// would compare a tag's tip against a branch delete. The name is IPC-supplied and
/// validated here, so an invalid name skips the whole delete rather than reaching
/// this template or the `branch -D` argv downstream.
async fn read_branch_tip(repo_path: &str, branch: &str) -> TipRead {
    if crate::git::branches::validate_ref_name(branch).is_err() {
        return TipRead::Unreadable;
    }
    let Ok(out) = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return TipRead::Unreadable;
    };
    let tip = out.stdout_lossy().trim().to_string();
    match out.code {
        0 if !tip.is_empty() => TipRead::Present(tip),
        1 if tip.is_empty() => TipRead::Absent,
        _ => TipRead::Unreadable,
    }
}

/// [`read_branch_tip`] collapsed to the tip alone; `None` for gone or unreadable.
#[cfg(test)]
async fn validated_branch_tip(repo_path: &str, branch: &str) -> Option<String> {
    match read_branch_tip(repo_path, branch).await {
        TipRead::Present(tip) => Some(tip),
        _ => None,
    }
}

/// Deletes `branch` ONLY IF its tip is still `expected_tip` — a commit that landed
/// on it since would otherwise be discarded by a `-D` decided before it existed.
/// Never an error: a refusal must not turn a completed removal into a reported
/// failure, so the outcome reports what happened to the branch instead.
async fn delete_branch_if_unmoved(
    repo_path: &str,
    branch: &str,
    expected_tip: &str,
) -> BranchCleanup {
    match read_branch_tip(repo_path, branch).await {
        TipRead::Present(tip) if tip == expected_tip => {}
        TipRead::Present(_) => return BranchCleanup::SparedMoved,
        TipRead::Absent => return BranchCleanup::NotRequested,
        TipRead::Unreadable => return BranchCleanup::SparedUnreadable,
    }
    // `-D` rewrites `branch.*`, so it runs under the config-write mutex (a leaf below
    // the held admin domain), and a lost config lock is repaired before the result goes.
    with_config_write_lock(repo_path, |held| async move {
        let deleted =
            run_git_raw(Some(repo_path), &["branch", "-D", branch], DEFAULT_TIMEOUT).await;
        match deleted {
            Ok(out) if out.code == 0 => {
                if is_config_lock_contention(&out.stderr) {
                    remove_deleted_branch_section(&held, repo_path, branch).await;
                }
                BranchCleanup::Deleted
            }
            // git refused (the branch is checked out elsewhere) or the run failed.
            _ => BranchCleanup::SparedUnreadable,
        }
    })
    .await
}

/// Prunes stale worktree admin entries (a worktree whose directory was deleted
/// out from under git, e.g. by an app crash). Safe to run on startup.
#[tauri::command]
pub async fn git_worktree_prune(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    run_git_worktree_admin(&state, &repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Stages everything (including untracked files) in a worktree and commits it,
/// so an agent session's output becomes a clean, reviewable commit on its
/// branch. Returns the new commit hash, or `None` when the agent changed
/// nothing (no commit made).
#[tauri::command]
pub async fn git_worktree_commit_all(
    state: State<'_, AppState>,
    worktree_path: String,
    message: String,
) -> AppResult<Option<String>> {
    worktree_commit_all(&state, &worktree_path, &message).await
}

/// The body of `git_worktree_commit_all`, callable without a Tauri `State`.
pub(crate) async fn worktree_commit_all(
    state: &AppState,
    worktree_path: &str,
    message: &str,
) -> AppResult<Option<String>> {
    // One hold across the emptiness check → add → commit → HEAD read: otherwise a
    // concurrent write lands between the check and `add -A` (sweeping files this
    // commit never meant to carry), and the HEAD read can report someone else's commit
    // as this one's. Lock-free runners only while held (see `run_git_mutating`).
    // The WORKTREE's own working-tree domain, and unbounded: a session turn is
    // background work that has to queue rather than fail the turn.
    let domain = state.working_tree_lock(worktree_path).await;
    let _guard = acquire_repo_lock_unbounded(&domain, "an agent session commit").await;

    let status = run_git(
        Some(worktree_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if status.stdout_lossy().trim().is_empty() {
        return Ok(None);
    }
    run_git(Some(worktree_path), &["add", "-A"], DEFAULT_TIMEOUT).await?;
    // Raw: a refusing `commit` writes its whole report to stdout and leaves
    // stderr EMPTY (measured, git 2.51.1), which a stderr-only error renders as
    // the bare "git exited with code 1".
    let commit = run_git_raw(
        Some(worktree_path),
        &["commit", "-m", message],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if commit.code != 0 {
        return Err(AppError::Git {
            code: commit.code,
            stderr: commit.full_failure_text(),
        });
    }
    let head = run_git(
        Some(worktree_path),
        &["rev-parse", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(Some(head.stdout_lossy().trim().to_string()))
}

/// Collapses all of a session branch's per-turn commits since `base` into one
/// commit with `message` (soft-reset to base, then re-commit the combined
/// tree). Returns `false` when HEAD is already at `base` (nothing to squash).
/// Used by "Keep" to turn the turn-by-turn checkpoints into a clean single
/// commit before the branch becomes a PR.
#[tauri::command]
pub async fn git_worktree_squash(
    state: State<'_, AppState>,
    worktree_path: String,
    base: String,
    message: String,
) -> AppResult<bool> {
    // One hold across the HEAD check → soft-reset → commit: between the reset and the
    // commit the branch sits rewound with every turn's changes staged, so a concurrent
    // commit or discard there either loses the session's work or folds foreign changes
    // into the squash. Lock-free runners only while held (see `run_git_mutating`).
    // Unbounded for the same reason as `worktree_commit_all`.
    let domain = state.working_tree_lock(&worktree_path).await;
    let _guard = acquire_repo_lock_unbounded(&domain, "a session squash").await;

    let head = run_git(
        Some(&worktree_path),
        &["rev-parse", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if head.stdout_lossy().trim() == base.trim() {
        return Ok(false);
    }
    run_git(
        Some(&worktree_path),
        &["reset", "--soft", &base],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // Raw, for the same stdout-only commit refusal as `worktree_commit_all` — and
    // this one leaves the branch rewound with everything staged, so the error the
    // user reads has to say why.
    let commit = run_git_raw(
        Some(&worktree_path),
        &["commit", "-m", &message],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if commit.code != 0 {
        return Err(AppError::Git {
            code: commit.code,
            stderr: commit.full_failure_text(),
        });
    }
    Ok(true)
}

/// Re-creates a worktree for a previously *kept* session on its EXISTING branch
/// (not a fresh `-b`), so the user resumes where they left off. Prunes first in case
/// a stale admin entry lingers from the prior removal; the branch must not be checked
/// out elsewhere (Keep removes the worktree first). `base` is unchanged frontend-side
/// so the cumulative `base..HEAD` diff still spans all turns.
#[tauri::command]
pub async fn git_worktree_resume(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    branch: String,
) -> AppResult<()> {
    let _ =
        run_git_worktree_admin(&state, &repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    run_git_worktree_admin(
        &state,
        &repo_path,
        &["worktree", "add", &path, &branch],
        WORKTREE_OP_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// One `git worktree list --porcelain` stanza, with the extra attributes the
/// user-facing manager needs (the agent `WorktreeInfo` path ignores these).
#[derive(Default)]
struct RawWorktree {
    path: String,
    head: String,
    branch: String,
    detached: bool,
    /// `Some(reason)` when locked (reason may be ""); `None` when unlocked.
    locked: Option<String>,
    /// git considers this entry stale (its directory is gone) — hide it.
    prunable: bool,
}

/// Parses `git worktree list --porcelain` into one `RawWorktree` per stanza,
/// reading the `HEAD` / `branch` / `detached` / `locked` / `prunable` attribute
/// lines. Stanzas are blank-line separated and the main worktree is always first.
fn parse_worktree_porcelain(porcelain: &str) -> Vec<RawWorktree> {
    let mut out: Vec<RawWorktree> = Vec::new();
    let mut cur: Option<RawWorktree> = None;
    for line in porcelain.lines() {
        let line = line.trim_end();
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            cur = Some(RawWorktree {
                path: p.to_string(),
                ..Default::default()
            });
        } else if let Some(w) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                w.head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            } else if line == "detached" {
                w.detached = true;
            } else if line == "locked" {
                w.locked = Some(String::new());
            } else if let Some(r) = line.strip_prefix("locked ") {
                w.locked = Some(r.to_string());
            } else if line == "prunable" || line.starts_with("prunable ") {
                w.prunable = true;
            }
        }
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    out
}

/// Whether a worktree belongs to an agent session and must be hidden from the
/// user. Registry path match is authoritative; the `gd/session/*` branch and the
/// app-data-root path are belt-and-suspenders for a stale/missing registry entry.
fn is_session_worktree(
    w: &RawWorktree,
    session_paths: &std::collections::HashSet<String>,
    app_data_root: Option<&str>,
) -> bool {
    let norm = normalize_wt_path(&w.path);
    if session_paths.contains(&norm) {
        return true;
    }
    if w.branch.starts_with("gd/session/") {
        return true;
    }
    if let Some(root) = app_data_root {
        if norm.starts_with(&format!("{root}/")) {
            return true;
        }
    }
    false
}

/// A file's mtime as epoch ms, or `None` when it is unreadable.
pub(crate) fn file_mtime_ms(path: &std::path::Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(ms).ok()
}

/// When git last did work in this worktree, as epoch ms. The index file's mtime
/// is the signal: it moves on checkout, stage, commit, and status alike, whereas
/// the admin directory's own mtime and `logs/HEAD` are rewritten wholesale by a
/// `gc` pass, which makes every dormant worktree look freshly used (measured on
/// 8 real worktrees, 2026-08-30). HEAD's mtime is the fallback. `None` on
/// anything unreadable — one worktree with odd admin files must never fail the
/// whole list.
pub(crate) fn worktree_last_activity_ms(worktree_path: &str) -> Option<i64> {
    let admin = crate::git::ops::resolve_git_admin_dir(std::path::Path::new(worktree_path))?;
    file_mtime_ms(&admin.join("index")).or_else(|| file_mtime_ms(&admin.join("HEAD")))
}

/// Parses `git worktree list --porcelain` into one `WorktreeInfo` per stanza.
/// Stanzas are blank-line separated; each carries a `worktree <path>` line and
/// (unless detached) a `branch refs/heads/<name>` line.
///
/// A `prunable` stanza is skipped: its folder is gone, and the list has to say so
/// even when the prune that would have dropped the entry didn't run.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch = String::new();
    let mut prunable = false;
    let flush = |path: &mut Option<String>,
                 branch: &mut String,
                 prunable: &mut bool,
                 out: &mut Vec<WorktreeInfo>| {
        let p = path.take();
        let b = std::mem::take(branch);
        if std::mem::take(prunable) {
            return;
        }
        if let Some(p) = p {
            let id = std::path::Path::new(&p)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(WorktreeInfo {
                id,
                path: p,
                branch: b,
                base: String::new(),
            });
        }
    };
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut prunable, &mut out);
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line == "prunable" || line.starts_with("prunable ") {
            prunable = true;
        }
    }
    flush(&mut path, &mut branch, &mut prunable, &mut out);
    out
}

/// A worktree path argument trimmed, refused when blank or when a leading '-' would
/// make git (or gh) read it as an option.
pub(crate) fn worktree_path_arg(path: &str) -> AppResult<&str> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::InvalidArgument(
            "a worktree path is required".into(),
        ));
    }
    if path.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "path must not start with '-'".into(),
        ));
    }
    Ok(path)
}

/// Lexical refusals for a path a NEW worktree would be created at. Control characters
/// are refused everywhere; with `windows`, so is any segment Win32 would respell (a
/// trailing dot or space is dropped, a device name opens the device), since git and
/// the filesystem would then disagree on which folder the worktree is.
pub(crate) fn refuse_ambiguous_worktree_path(path: &str, windows: bool) -> AppResult<()> {
    if let Some(segment) = path
        .split(['/', '\\'])
        .find(|s| s.chars().any(char::is_control))
    {
        return Err(AppError::InvalidArgument(format!(
            "\"{}\" contains a control character, so it can't name a worktree folder — choose another folder name.",
            segment.escape_debug()
        )));
    }
    if !windows {
        return Ok(());
    }
    // A drive prefix without a root (`C:x`, `C:..`) resolves against a per-drive cwd, so
    // the probe (the app's cwd) and gh (the repo's) would read different folders. Lexical
    // so non-Windows test hosts, whose `Path` parses no prefixes, see the same verdict.
    if let [drive, b':', rest @ ..] = path.as_bytes() {
        if drive.is_ascii_alphabetic() && !matches!(rest.first(), Some(b'/' | b'\\')) {
            let drive = drive.to_ascii_uppercase() as char;
            return Err(AppError::InvalidArgument(format!(
                "\"{path}\" is relative to drive {drive}:'s current folder, so the worktree path is ambiguous — use a full path like {drive}:\\... or a path relative to the repository."
            )));
        }
    }
    for component in std::path::Path::new(path).components() {
        let std::path::Component::Normal(name) = component else {
            continue;
        };
        let name = name.to_string_lossy();
        if name.ends_with('.') || name.ends_with(' ') {
            return Err(AppError::InvalidArgument(format!(
                "\"{name}\" ends in a dot or space, which Windows drops, so the worktree path is ambiguous — choose another folder name."
            )));
        }
        if crate::fsops::path_has_reserved_component(std::path::Path::new(&*name)) {
            return Err(AppError::InvalidArgument(format!(
                "\"{name}\" is a reserved Windows device name — choose another folder name."
            )));
        }
    }
    Ok(())
}

/// A user-supplied worktree path as git resolves it: relative paths are joined onto
/// the repo, which is the cwd gh and git run the checkout from.
pub(crate) fn resolve_worktree_path(repo_path: &str, path: &str) -> String {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(repo_path)
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

/// The info/exclude line that keeps in-repo worktrees out of `git status`.
pub(crate) const GITDESKTOP_WORKTREES_EXCLUDE: &str = "/.gitdesktop/worktrees/";

/// A path git printed on its own line, with only the line terminator removed: on POSIX
/// a trailing space is part of a folder's name.
pub(crate) fn stdout_path(stdout: &str) -> &str {
    stdout.trim_end_matches(['\r', '\n'])
}

/// The repo's absolute common dir. Strict, unlike the identity resolver: a failed
/// read is an Err, never the raw path, which would put `info/exclude` in the tree.
pub(crate) async fn git_common_dir(repo_path: &str) -> AppResult<String> {
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let common = stdout_path(&out.stdout_lossy()).to_string();
    if common.is_empty() {
        return Err(AppError::Command("git named no common directory".into()));
    }
    Ok(common)
}

/// The main worktree root: the common dir's parent when the common dir is named
/// `.git`, else None (a bare repo, or a separate git dir under another name).
/// Case is kept: `is_inside_gitdesktop_worktrees` applies the platform's own fold.
fn main_root_from_common_dir(common: &str) -> Option<String> {
    let unified = strip_verbatim(common).replace('\\', "/");
    let (parent, last) = unified.trim_end_matches('/').rsplit_once('/')?;
    last.eq_ignore_ascii_case(".git")
        .then(|| parent.to_string())
}

/// Lexical: `resolved_target` (resolve_worktree_path's output) lies strictly
/// inside `<root>/.gitdesktop/worktrees/`. Pure strings, no Path parsing: `.` and
/// empty segments (a typed `./` or trailing slash) fold away, a `..` past the prefix
/// refuses. Case folds on Windows and macOS, where checkouts normally sit on
/// case-insensitive filesystems (git's init-time `core.ignorecase` probe), since the
/// exclude line only hides a folder git matches it against.
pub(crate) fn is_inside_gitdesktop_worktrees(root: &str, resolved_target: &str) -> bool {
    inside_gitdesktop_worktrees(
        root,
        resolved_target,
        cfg!(any(windows, target_os = "macos")),
    )
}

fn inside_gitdesktop_worktrees(root: &str, resolved_target: &str, fold_case: bool) -> bool {
    let (root_lead, root) = lexical_segments(root, fold_case);
    let (target_lead, target) = lexical_segments(resolved_target, fold_case);
    let prefix_len = root.len() + 2;
    root_lead == target_lead
        && target.len() > prefix_len
        && target.starts_with(&root)
        && target[root.len()..prefix_len] == [".gitdesktop", "worktrees"]
        && !target[prefix_len..].iter().any(|s| s == "..")
}

/// A path's leading-separator count (so `//server/share` stays apart from `/server`)
/// and its segments, with separators normalized and `.`/empty segments dropped.
fn lexical_segments(p: &str, fold_case: bool) -> (usize, Vec<String>) {
    let mut s = strip_verbatim(p).replace('\\', "/");
    if fold_case {
        s = s.to_lowercase();
    }
    let rest = s.trim_start_matches('/');
    let lead = s.len() - rest.len();
    let segments = rest
        .split('/')
        .filter(|seg| !matches!(*seg, "" | "."))
        .map(str::to_string)
        .collect();
    (lead, segments)
}

/// The bytes to append so `existing` gains `line`, or None when a line already
/// equals it. Only trailing spaces are trimmed, as git ignores them: a leading space
/// is part of git's pattern. Append-only and byte-level: nothing is rewritten.
fn exclude_append_bytes(existing: &[u8], line: &str) -> Option<Vec<u8>> {
    let present = existing.split(|&b| b == b'\n').any(|l| {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        let end = l.iter().rposition(|&b| b != b' ').map_or(0, |i| i + 1);
        &l[..end] == line.as_bytes()
    });
    if present {
        return None;
    }
    let eol: &[u8] = if existing.windows(2).any(|w| w == b"\r\n") {
        b"\r\n"
    } else {
        b"\n"
    };
    let mut out = Vec::new();
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        out.extend_from_slice(eol);
    }
    out.extend_from_slice(line.as_bytes());
    out.extend_from_slice(eol);
    Some(out)
}

async fn append_exclude(common: &str) -> AppResult<bool> {
    let info = std::path::Path::new(common).join("info");
    tokio::task::spawn_blocking(move || -> std::io::Result<bool> {
        use std::io::Write;
        std::fs::create_dir_all(&info)?;
        let file = info.join("exclude");
        let existing = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e),
        };
        let Some(bytes) = exclude_append_bytes(&existing, GITDESKTOP_WORKTREES_EXCLUDE) else {
            return Ok(false);
        };
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)?
            .write_all(&bytes)?;
        Ok(true)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
    .map_err(AppError::Io)
}

/// Appends GITDESKTOP_WORKTREES_EXCLUDE to `<git common dir>/info/exclude`
/// unless a line already equals it. Ok(true) = appended, Ok(false) = present.
/// For callers that settle anchoring themselves; the checkout paths use the wrapper.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn ensure_gitdesktop_excluded(repo_path: &str) -> AppResult<bool> {
    append_exclude(&git_common_dir(repo_path).await?).await
}

/// Call-site wrapper: appends when the target is inside the MAIN worktree
/// root's or the open checkout's `.gitdesktop/worktrees/`. Never fails.
pub(crate) async fn exclude_if_inside_gitdesktop(repo_path: &str, resolved_target: &str) {
    let result = async {
        let common = git_common_dir(repo_path).await?;
        let anchored = main_root_from_common_dir(&common)
            .is_some_and(|m| is_inside_gitdesktop_worktrees(&m, resolved_target))
            || is_inside_gitdesktop_worktrees(repo_path, resolved_target);
        if anchored {
            append_exclude(&common).await?;
        }
        AppResult::Ok(())
    }
    .await;
    if let Err(e) = result {
        eprintln!("gitdesktop: couldn't add the worktree exclude (continuing): {e}");
    }
}

/// The most commits a divergence report lists; `more` says a further one exists. Its
/// twins: `DIVERGED_COMMIT_CAP` in src/lib/git/api/pr-actions.ts and the guide's "newest 20".
const DIVERGED_COMMIT_CAP: usize = 20;

/// A commit a forced re-sync would reset away: full sha and subject line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DivergedCommit {
    pub sha: String,
    pub subject: String,
}

/// `AppError::WorktreeDiverged`'s Display. One plain sentence first, because the
/// frontend takes line 1 as the toast title.
pub(crate) fn diverged_message(path: &str, count: usize, more: bool, dirty: bool) -> String {
    let commits = if more {
        format!("more than {DIVERGED_COMMIT_CAP} commits that aren't")
    } else if count == 1 {
        "1 commit that isn't".to_string()
    } else {
        format!("{count} commits that aren't")
    };
    let mut message = format!("The worktree at {path} has {commits} on the pull request's branch.");
    if dirty {
        message.push_str(" It also has uncommitted changes.");
    }
    message
}

/// The registered worktree at a checkout target, as `git worktree list` reports it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WtEntry {
    /// Stanza 0: the repo's main worktree.
    pub is_main: bool,
    /// The branch with exactly `refs/heads/` stripped; "" when detached.
    pub branch: String,
    /// The full HEAD oid from the porcelain stanza.
    pub head: String,
    pub detached: bool,
    /// git's spelling of the path.
    pub path: String,
}

/// What the checkout target looks like locally: whether the PR's head commit is in
/// the object store, and the worktree registered at the path, if any.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WtProbe {
    pub tip_local: bool,
    pub entry: Option<WtEntry>,
}

/// Whether two spellings name one worktree; the match picks the checkout's write target.
/// Spelling folds `\` and case only on Windows. Elsewhere a case-only difference counts
/// only when the filesystem confirms one directory, so a case-insensitive macOS volume
/// still matches while a case-sensitive one (APFS can be) never lands on the wrong row.
pub(crate) fn same_wt_path(a: &str, b: &str) -> bool {
    wt_paths_match(a, b, cfg!(windows), same_dir_on_disk)
}

/// [`same_wt_path`] with the filesystem's same-directory answer injected.
fn wt_paths_match(a: &str, b: &str, windows: bool, same_dir: impl Fn(&str, &str) -> bool) -> bool {
    same_wt_spelling(a, b, windows, windows) || same_dir(a, b)
}

/// Whether both paths exist as one directory: equal canonical paths, or on unix one
/// (device, inode), which holds however a case-insensitive volume spells the name.
fn same_dir_on_disk(a: &str, b: &str) -> bool {
    if matches!(
        (std::fs::canonicalize(a), std::fs::canonicalize(b)),
        (Ok(x), Ok(y)) if x == y
    ) {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(x), Ok(y)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return x.dev() == y.dev() && x.ino() == y.ino();
        }
    }
    false
}

/// [`same_wt_path`]'s lexical arm, the frontend checkout-path rule: `\` is a separator
/// only on `windows` (elsewhere it is a filename byte), case folds only when
/// `fold_case`, and a trailing `/` always trims.
fn same_wt_spelling(a: &str, b: &str, windows: bool, fold_case: bool) -> bool {
    let norm = |p: &str| {
        let p = if windows {
            p.replace('\\', "/")
        } else {
            p.to_string()
        };
        let p = if fold_case { p.to_lowercase() } else { p };
        p.trim_end_matches('/').to_string()
    };
    norm(a) == norm(b)
}

/// `git merge-base --is-ancestor`: exit 0 is true, 1 is false, anything else fails.
pub(crate) async fn is_ancestor(
    repo_path: &str,
    ancestor: &str,
    descendant: &str,
) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", ancestor, descendant],
        DEFAULT_TIMEOUT,
    )
    .await?;
    exit_bool(out)
}

/// A yes/no git probe's exit: 0 is true, 1 is false, anything else is the failure.
fn exit_bool(out: crate::git::runner::GitOutput) -> AppResult<bool> {
    match out.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => out.exit_verdict().map(|_| false),
    }
}

/// Probes the checkout target: the PR tip's presence (false without an oid) and the
/// worktree registered at the path.
pub(crate) async fn probe_worktree(
    repo_path: &str,
    resolved: &str,
    oid: Option<&str>,
) -> AppResult<WtProbe> {
    let tip_local = match oid {
        Some(oid) => tip_is_local(repo_path, oid).await?,
        None => false,
    };
    let entry = registered_worktree(repo_path, resolved).await?;
    Ok(WtProbe { tip_local, entry })
}

/// Whether `oid` names a local commit. Needs the `^{commit}` peel: `--verify` on a
/// bare full hex succeeds even when no such object exists.
async fn tip_is_local(repo_path: &str, oid: &str) -> AppResult<bool> {
    let peeled = format!("{oid}^{{commit}}");
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "--quiet", &peeled],
        DEFAULT_TIMEOUT,
    )
    .await?;
    exit_bool(out)
}

/// The non-prunable worktree `git worktree list` registers at `resolved`, if any.
async fn registered_worktree(repo_path: &str, resolved: &str) -> AppResult<Option<WtEntry>> {
    let porcelain = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    // same_wt_path's canonicalize fallback is blocking filesystem I/O (slow on a
    // network share), so the row match runs off the async workers.
    let rows = parse_worktree_porcelain(&porcelain);
    let resolved = resolved.to_string();
    tokio::task::spawn_blocking(move || {
        rows.into_iter()
            .enumerate()
            .find(|(_, w)| !w.prunable && same_wt_path(&w.path, &resolved))
            .map(|(i, w)| WtEntry {
                is_main: i == 0,
                branch: w.branch,
                head: w.head,
                detached: w.detached,
                path: w.path,
            })
    })
    .await
    .map_err(|e| AppError::Command(format!("Worktree lookup task failed: {e}")))
}

/// Whether a linked worktree has the PR's local branch checked out: the exact name the
/// checkout passes gh as `--branch`.
pub(crate) fn on_pr_branch(e: &WtEntry, local: &str) -> bool {
    !e.is_main && !e.detached && e.branch == local
}

/// The commits on `wt_head` that `oid` lacks, newest first and capped, when neither
/// contains the other: a behind-only worktree fast-forwards and an ahead-only one is
/// "Already up to date", so only true divergence fails gh's `merge --ff-only`.
async fn diverged_from(
    repo_path: &str,
    wt_head: &str,
    oid: &str,
) -> AppResult<Option<(Vec<DivergedCommit>, bool)>> {
    if is_ancestor(repo_path, wt_head, oid).await? || is_ancestor(repo_path, oid, wt_head).await? {
        return Ok(None);
    }
    let range = format!("{oid}..{wt_head}");
    let limit = (DIVERGED_COMMIT_CAP + 1).to_string();
    let out = run_git(
        Some(repo_path),
        &[
            "log",
            "-z",
            "--no-show-signature",
            "--format=%H%x1f%s",
            "-n",
            &limit,
            &range,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    let mut commits: Vec<DivergedCommit> = out
        .split('\0')
        .filter(|r| !r.trim().is_empty())
        .map(|r| {
            let (sha, subject) = r.split_once('\x1f').unwrap_or((r, ""));
            DivergedCommit {
                sha: sha.trim().to_string(),
                subject: subject.to_string(),
            }
        })
        .collect();
    if commits.is_empty() {
        return Ok(None);
    }
    let more = commits.len() > DIVERGED_COMMIT_CAP;
    commits.truncate(DIVERGED_COMMIT_CAP);
    Ok(Some((commits, more)))
}

/// Uncommitted changes to TRACKED files, which `reset --hard` destroys; untracked
/// files survive it, so `-uno` leaves them out.
async fn worktree_dirty(wt_path: &str) -> AppResult<bool> {
    let out = run_git(
        Some(wt_path),
        &["status", "--porcelain", "-uno"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(!out.stdout_lossy().trim().is_empty())
}

/// Untracked files in the worktree whose paths `oid`'s tree tracks: `reset --hard`
/// overwrites those, which `worktree_dirty` deliberately leaves out. Bounded by the
/// untracked list, and asked over stdin, so no argv grows with it.
async fn untracked_collisions(repo_path: &str, wt_path: &str, oid: &str) -> AppResult<u32> {
    let listed = run_git(
        Some(wt_path),
        &["ls-files", "--others", "--exclude-standard", "-z"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    // One `<oid>:<path>` query per line, so a path holding a newline can't be asked.
    let queries: String = listed
        .split('\0')
        .filter(|p| !p.is_empty() && !p.contains('\n'))
        .map(|p| format!("{oid}:{p}\n"))
        .collect();
    if queries.is_empty() {
        return Ok(0);
    }
    let out = run_git_raw_input(
        Some(repo_path),
        &["cat-file", "--batch-check"],
        Some(&queries),
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    let tracked = out
        .stdout_lossy()
        .lines()
        .filter(|l| !l.trim_end().ends_with(" missing"))
        .count();
    Ok(u32::try_from(tracked).unwrap_or(u32::MAX))
}

/// `WorktreeDiverged` for `e` when every probe answers and the histories diverge;
/// `None` on no divergence or any failed probe, so the caller keeps its own outcome.
/// A failed collision count reads 0: the confirm only omits that line.
/// `echo_path` is the caller's input path, which a forced retry sends back verbatim.
pub(crate) async fn divergence_error(
    repo_path: &str,
    echo_path: &str,
    e: &WtEntry,
    oid: &str,
) -> Option<AppError> {
    let (commits, more) = diverged_from(repo_path, &e.head, oid).await.ok()??;
    let dirty = worktree_dirty(&e.path).await.ok()?;
    let untracked = untracked_collisions(repo_path, &e.path, oid)
        .await
        .unwrap_or(0);
    Some(AppError::WorktreeDiverged {
        path: echo_path.to_string(),
        shown_path: e.path.clone(),
        head: e.head.clone(),
        commits,
        more,
        dirty,
        untracked,
    })
}

/// gh's existing-worktree arm checks the PR's branch out in place, so a path naming the
/// main checkout would switch the user's own branch. A linked worktree on another
/// branch stays allowed: switching it is gh's documented contract.
fn refuse_main_worktree(entry: Option<&WtEntry>, path: &str) -> AppResult<()> {
    if entry.is_some_and(|e| e.is_main) {
        return Err(AppError::InvalidArgument(format!(
            "{path} is this repository's main checkout — pick a new folder, or the pull request's own worktree."
        )));
    }
    Ok(())
}

/// A fork PR's worktree is matched by the bare head, so a linked worktree on the user's
/// same-named branch would be switched or reset to the fork's. Keyed on `fork`, never
/// `head != local`: an ownerless fork's local name is the bare head too. That also
/// refuses such a fork's own earlier worktree, deliberately, and with no remedy: while
/// its bare-named branch exists, refuse_ownerless_branch_namesake refuses every target.
#[cfg(test)]
pub(crate) fn refuse_own_head_namesake(
    entry: Option<&WtEntry>,
    path: &str,
    head: &str,
    local: &str,
    fork: bool,
) -> AppResult<()> {
    refuse_own_head_namesake_on("GitHub", entry, path, head, local, fork)
}

/// The own-head namesake refusal (contract above), its copy naming `forge` and that
/// forge's noun.
pub(crate) fn refuse_own_head_namesake_on(
    forge: &str,
    entry: Option<&WtEntry>,
    path: &str,
    head: &str,
    local: &str,
    fork: bool,
) -> AppResult<()> {
    let own = entry.is_some_and(|e| !e.is_main && !e.detached && e.branch == head);
    if !(fork && own) {
        return Ok(());
    }
    let noun = request_noun(forge);
    Err(AppError::InvalidArgument(if head == local {
        format!(
            "{path} is on branch {head}, which may be your own: {forge} no longer names this {noun}'s fork, so its branch can't be told apart from yours — nothing was checked out."
        )
    } else {
        format!(
            "{path} is on your own branch {head}, not the {noun}'s {local} — pick a new folder."
        )
    }))
}

/// gh checks an existing branch out into a new or reused worktree and fast-forwards it,
/// so an ownerless fork (local == bare head) refuses at every target while the branch
/// exists, and when the probe fails. Not refused: an existing `<owner>/<head>` is the
/// PR's own earlier branch, and a same-repo PR's branch existing is the normal flow.
/// Force needs no probe: an entry off `local` is `Changed` there before any reset, and
/// one on it (`Moved`/`Proceed`) meets refuse_own_head_namesake first.
#[cfg(test)]
async fn refuse_ownerless_branch_namesake(
    repo_path: &str,
    head: &str,
    local: &str,
    fork: bool,
) -> AppResult<()> {
    refuse_ownerless_branch_namesake_on("GitHub", repo_path, head, local, fork).await
}

/// The forge's word for the reviewed entity, for copy that names it.
pub(crate) fn request_noun(forge: &str) -> &'static str {
    if forge == "GitLab" {
        "merge request"
    } else {
        "pull request"
    }
}

/// The ownerless-fork namesake refusal (contract above), its copy naming `forge` and
/// that forge's noun.
pub(crate) async fn refuse_ownerless_branch_namesake_on(
    forge: &str,
    repo_path: &str,
    head: &str,
    local: &str,
    fork: bool,
) -> AppResult<()> {
    if !fork || head != local {
        return Ok(());
    }
    // Case-insensitive, unlike branches::branch_exists_exact: on a case-insensitive
    // filesystem gh's own lookup of `main` lands on a loose `Main`, so the wider match
    // fails closed. A failed listing refuses too (run_git errs on a non-zero exit).
    let listed = run_git(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let exists = listed.map(|out| {
        out.stdout_lossy().lines().any(|line| {
            line.strip_prefix("refs/heads/")
                .is_some_and(|name| name.to_lowercase() == local.to_lowercase())
        })
    });
    match exists {
        Ok(false) => Ok(()),
        Ok(true) => Err(AppError::InvalidArgument(format!(
            "A branch named {local} already exists and may be your own: {forge} no longer names this {}'s fork, so its branch can't be told apart from yours — nothing was checked out.",
            request_noun(forge)
        ))),
        Err(_) => Err(AppError::InvalidArgument(format!(
            "Couldn't check whether a branch named {local} already exists — try again."
        ))),
    }
}

/// The pre-spawn candidate: an existing worktree on the PR's branch with the PR's tip
/// already local, so divergence is provable before gh fetches.
fn pre_spawn_candidate<'a>(pre: &'a WtProbe, local: &str) -> Option<&'a WtEntry> {
    pre.entry
        .as_ref()
        .filter(|e| pre.tip_local && on_pr_branch(e, local))
}

/// The post-spawn candidate. It needs PROGRESS evidence that this run's gh got past
/// its fetch (the tip arrived, or the worktree was created or switched branch), so an
/// auth, network or path failure is never read as divergence.
pub(crate) fn post_spawn_candidate<'a>(
    pre: &WtProbe,
    post: &'a WtProbe,
    local: &str,
) -> Option<&'a WtEntry> {
    let branch = |p: &WtProbe| p.entry.as_ref().map(|e| e.branch.clone());
    let progress = (!pre.tip_local && post.tip_local) || branch(pre) != branch(post);
    post.entry
        .as_ref()
        .filter(|e| progress && post.tip_local && on_pr_branch(e, local))
}

/// The forced re-sync's verdict over a fresh probe. `Moved` and `Proceed` are both
/// reachable only on the PR's local branch, so no reset or confirm list ever targets
/// another.
#[derive(Debug, PartialEq)]
enum ForceGate<'a> {
    NotAWorktree,
    Changed,
    Moved(&'a WtEntry),
    Proceed,
}

fn force_gate<'a>(probe: &'a WtProbe, expected: &str, local: &str) -> ForceGate<'a> {
    let Some(e) = probe.entry.as_ref().filter(|e| !e.is_main && !e.detached) else {
        return ForceGate::NotAWorktree;
    };
    if !on_pr_branch(e, local) {
        return ForceGate::Changed;
    }
    if e.head != expected {
        return ForceGate::Moved(e);
    }
    ForceGate::Proceed
}

/// How the checkout treats an existing worktree: a fast-forward re-sync, or the
/// forced reset the user confirmed at `expected` (an already shape-checked full oid).
pub(crate) enum CheckoutMode<'a> {
    Sync,
    Force { expected: &'a str },
}

/// The worktree checkout's local refusals, in order, before gh spawns. Sync: the
/// registry read refuses the main checkout, then a fork PR's bare-head namesake (a
/// worktree on it, then for any target an ownerless fork's existing branch), and a failed
/// registry read refuses too (gh run from a linked worktree would switch the main
/// checkout); with the tip probe answered, a provable divergence refuses, while
/// a failed tip probe proceeds to gh unclassified. Force: only an answered probe of a
/// linked worktree on gh's branch, still at `expected` and no fork's namesake,
/// proceeds. `head` is the PR's bare head branch, `local` the `--branch` name, `fork`
/// whether the PR is cross-repository. Returns the sync pre-probe the post-spawn
/// classification compares against (only with an answered tip probe).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn checkout_pre_spawn_gate(
    repo_path: &str,
    echo_path: &str,
    resolved: &str,
    oid: Option<&str>,
    head: &str,
    local: &str,
    fork: bool,
    mode: CheckoutMode<'_>,
) -> AppResult<Option<WtProbe>> {
    checkout_pre_spawn_gate_on(
        "GitHub", repo_path, echo_path, resolved, oid, head, local, fork, mode,
    )
    .await
}

/// The force arm's refusal when the worktree moved off what the user confirmed.
pub(crate) fn changed_since_confirm(echo_path: &str) -> AppError {
    AppError::InvalidArgument(format!(
        "The worktree at {echo_path} changed since you confirmed, so nothing was reset — run the checkout again."
    ))
}

/// [`checkout_pre_spawn_gate`] with its namesake copy naming `forge`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn checkout_pre_spawn_gate_on(
    forge: &str,
    repo_path: &str,
    echo_path: &str,
    resolved: &str,
    oid: Option<&str>,
    head: &str,
    local: &str,
    fork: bool,
    mode: CheckoutMode<'_>,
) -> AppResult<Option<WtProbe>> {
    let CheckoutMode::Force { expected } = mode else {
        let entry = registered_worktree(repo_path, resolved)
            .await
            .map_err(|_| {
                AppError::InvalidArgument(format!(
                    "Couldn't check the worktree at {echo_path} — try again."
                ))
            })?;
        refuse_main_worktree(entry.as_ref(), echo_path)?;
        refuse_own_head_namesake_on(forge, entry.as_ref(), echo_path, head, local, fork)?;
        refuse_ownerless_branch_namesake_on(forge, repo_path, head, local, fork).await?;
        let Some(oid) = oid else {
            return Ok(None);
        };
        // An unknown tip proves no divergence and is no baseline for post-spawn
        // progress evidence, so gh's own error stays the answer.
        let Ok(tip_local) = tip_is_local(repo_path, oid).await else {
            return Ok(None);
        };
        let probe = WtProbe { tip_local, entry };
        if let Some(e) = pre_spawn_candidate(&probe, local) {
            if let Some(diverged) = divergence_error(repo_path, echo_path, e, oid).await {
                return Err(diverged);
            }
        }
        return Ok(Some(probe));
    };
    let probe = probe_worktree(repo_path, resolved, oid)
        .await
        .map_err(|_| {
            AppError::InvalidArgument(format!(
                "Couldn't check the worktree at {echo_path}, so nothing was reset — try again."
            ))
        })?;
    let changed = || changed_since_confirm(echo_path);
    let verdict = force_gate(&probe, expected, local);
    if matches!(verdict, ForceGate::Moved(_) | ForceGate::Proceed) {
        refuse_own_head_namesake_on(forge, probe.entry.as_ref(), echo_path, head, local, fork)?;
    }
    match verdict {
        ForceGate::NotAWorktree => Err(AppError::InvalidArgument(format!(
            "Only an existing worktree of this repository can be reset to the pull request — {echo_path} isn't one."
        ))),
        ForceGate::Changed => Err(changed()),
        ForceGate::Moved(e) => {
            let fresh = match oid {
                Some(oid) if probe.tip_local => divergence_error(repo_path, echo_path, e, oid).await,
                _ => None,
            };
            Err(fresh.unwrap_or_else(changed))
        }
        ForceGate::Proceed => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The module itself no longer calls the working-tree runner — the interleave
    // tests below drive it as an ordinary caller would.
    use crate::git::ops::parse_gitdir_pointer;
    use crate::git::runner::{hold_config_lock, lock_events, run_git_mutating};

    #[test]
    fn repo_hash_is_stable_and_case_insensitive() {
        assert_eq!(repo_hash("C:/Repos/App"), repo_hash("c:/repos/app"));
        assert_ne!(repo_hash("C:/Repos/App"), repo_hash("C:/Repos/Other"));
    }

    /// Separators are NOT normalized away, unlike case — which is why anything that
    /// hashes a repo identity (the update-marker roots) must carry the resolver's own
    /// spelling rather than a `normalize_wt_path`ed copy of it.
    #[test]
    fn repo_hash_distinguishes_separator_spellings() {
        assert_ne!(repo_hash(r"C:\repos\x"), repo_hash("c:/repos/x"));
    }

    /// Verbatim spellings fold to the form git prints: a UNC share to `//server/share`
    /// (never `unc/server/share`), a drive path to `c:/…`, and a plain path passes
    /// through. Pure strings, so no share lookup ever runs.
    #[test]
    fn strip_verbatim_unwraps_verbatim_spellings_to_gits_form() {
        let folded = |p: &str| normalize_wt_path(&strip_verbatim(p));
        assert_eq!(
            folded(r"\\?\UNC\server\share\repo\.git"),
            "//server/share/repo/.git"
        );
        assert_eq!(folded(r"\\?\unc\server\share\x"), "//server/share/x");
        assert_eq!(folded(r"\\?\Z:\dir\repo"), "z:/dir/repo");
        assert_eq!(folded(r"C:\dir\repo"), "c:/dir/repo");
    }

    #[test]
    fn parse_worktree_list_reads_path_and_branch() {
        let porcelain = "\
worktree C:/repos/app
HEAD 462b9fc1bb9cebaf69593c294ff5d4f2f3769af7
branch refs/heads/master

worktree C:/data/worktrees/abc/sess1
HEAD 462b9fc1bb9cebaf69593c294ff5d4f2f3769af7
branch refs/heads/gd/session/sess1
";
        let got = parse_worktree_list(porcelain);
        assert_eq!(
            got,
            vec![
                WorktreeInfo {
                    id: "app".into(),
                    path: "C:/repos/app".into(),
                    branch: "master".into(),
                    base: String::new(),
                },
                WorktreeInfo {
                    id: "sess1".into(),
                    path: "C:/data/worktrees/abc/sess1".into(),
                    branch: "gd/session/sess1".into(),
                    base: String::new(),
                },
            ]
        );
    }

    /// A folder-less entry must not read as a live session when the startup prune
    /// was skipped, so the list drops it, bare `prunable` line included.
    #[test]
    fn parse_worktree_list_skips_prunable_entries() {
        let porcelain = "\
worktree C:/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree C:/repos/app-stale
HEAD 4444444444444444444444444444444444444444
branch refs/heads/gone
prunable gitdir file points to non-existent location

worktree C:/repos/app-bare
HEAD 5555555555555555555555555555555555555555
detached
prunable

worktree C:/repos/app-live
HEAD 6666666666666666666666666666666666666666
branch refs/heads/live
";
        let got = parse_worktree_list(porcelain);
        let paths: Vec<&str> = got.iter().map(|w| w.path.as_str()).collect();
        assert_eq!(paths, ["C:/repos/app", "C:/repos/app-live"]);
        assert_eq!(got[1].branch, "live", "a skipped stanza's branch never leaks");
    }

    #[test]
    fn parse_porcelain_reads_head_branch_detached_and_locked() {
        let porcelain = "\
worktree C:/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree C:/repos/app-detached
HEAD 2222222222222222222222222222222222222222
detached

worktree C:/repos/app-locked
HEAD 3333333333333333333333333333333333333333
branch refs/heads/feature
locked on a removable drive

worktree C:/repos/app-stale
HEAD 4444444444444444444444444444444444444444
branch refs/heads/gone
prunable gitdir file points to non-existent location
";
        let got = parse_worktree_porcelain(porcelain);
        assert_eq!(got.len(), 4);
        assert_eq!(got[0].branch, "main");
        assert_eq!(got[0].head, "1111111111111111111111111111111111111111");
        assert!(!got[0].detached && got[0].locked.is_none());
        assert!(got[1].detached && got[1].branch.is_empty());
        assert_eq!(got[2].locked.as_deref(), Some("on a removable drive"));
        assert!(got[3].prunable);
    }

    #[test]
    fn parse_porcelain_reads_locked_without_reason() {
        let porcelain = "worktree C:/wt\nHEAD abc\nbranch refs/heads/x\nlocked\n";
        let got = parse_worktree_porcelain(porcelain);
        assert_eq!(got[0].locked.as_deref(), Some(""));
    }

    #[test]
    fn is_session_worktree_matches_registry_branch_and_app_data() {
        use std::collections::HashSet;
        let registry: HashSet<String> =
            [normalize_wt_path("C:\\Users\\me\\AppData\\Local\\app\\worktrees\\h\\sess1")]
                .into_iter()
                .collect();
        let app_root = Some("c:/users/me/appdata/local/app/worktrees");

        // 1) exact registry path match (note: stored with backslashes, git emits slashes)
        let by_registry = RawWorktree {
            path: "C:/Users/me/AppData/Local/app/worktrees/h/sess1".into(),
            branch: "some-renamed-branch".into(),
            ..Default::default()
        };
        assert!(is_session_worktree(&by_registry, &registry, app_root));

        // 2) gd/session/* branch even if the registry is missing it
        let by_branch = RawWorktree {
            path: "C:/somewhere/else".into(),
            branch: "gd/session/abc".into(),
            ..Default::default()
        };
        assert!(is_session_worktree(&by_branch, &HashSet::new(), app_root));

        // 3) under the app-data worktrees root even with a non-session branch
        let by_path = RawWorktree {
            path: "C:/Users/me/AppData/Local/app/worktrees/h/orphan".into(),
            branch: "main".into(),
            ..Default::default()
        };
        assert!(is_session_worktree(&by_path, &HashSet::new(), app_root));

        // 4) an update's throwaway `gd-update-*` checkout, hidden by that same root
        // (the branch it holds is one of the user's own, so only the path can hide it)
        let by_update = RawWorktree {
            path: "C:/Users/me/AppData/Local/app/worktrees/h/gd-update-1234-99".into(),
            branch: "feature".into(),
            ..Default::default()
        };
        assert!(is_session_worktree(&by_update, &HashSet::new(), app_root));

        // 5) an ordinary user worktree is NOT excluded
        let user = RawWorktree {
            path: "C:/repos/app-feature".into(),
            branch: "feature".into(),
            ..Default::default()
        };
        assert!(!is_session_worktree(&user, &registry, app_root));
    }

    #[test]
    fn parse_gitdir_pointer_reads_absolute_relative_and_padded_forms() {
        assert_eq!(
            parse_gitdir_pointer("gitdir: C:/repos/app/.git/worktrees/wt\n"),
            Some("C:/repos/app/.git/worktrees/wt")
        );
        assert_eq!(
            parse_gitdir_pointer("gitdir: ../repo/.git/worktrees/wt"),
            Some("../repo/.git/worktrees/wt")
        );
        // No space after the colon, and a trailing blank line.
        assert_eq!(
            parse_gitdir_pointer("gitdir:/srv/repo/.git/worktrees/wt\n\n"),
            Some("/srv/repo/.git/worktrees/wt")
        );
        assert_eq!(parse_gitdir_pointer("gitdir:\n"), None);
        assert_eq!(parse_gitdir_pointer("not a pointer file\n"), None);
        assert_eq!(parse_gitdir_pointer(""), None);
    }

    #[test]
    fn parse_worktree_list_handles_detached_head() {
        // A detached worktree has no `branch` line.
        let porcelain = "worktree C:/repos/app\nHEAD 462b9fc\ndetached\n";
        let got = parse_worktree_list(porcelain);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].branch, "");
        assert_eq!(got[0].id, "app");
    }

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// Real-repo lifecycle: add a session worktree, see it in the parsed list,
    /// remove + prune + delete its branch. Requires git on PATH (true for dev).
    #[tokio::test]
    async fn worktree_add_list_remove_roundtrip() {
        let _base = tempfile::Builder::new()
            .prefix("gd-wt-test-")
            .tempdir()
            .expect("create temp dir");
        let base = _base.path().to_path_buf();
        let repo = base.join("repo");
        let wt = base.join("wt");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        let wt_s = wt.to_string_lossy().into_owned();

        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;

        run(
            &repo_s,
            &build_session_worktree_add_args("gd/session/test", &wt_s, "HEAD"),
        )
        .await;
        assert!(wt.join("a.txt").exists(), "worktree checkout has the file");

        let list = parse_worktree_list(&run(&repo_s, &["worktree", "list", "--porcelain"]).await);
        let sess = list
            .iter()
            .find(|w| w.branch == "gd/session/test")
            .expect("session worktree is listed");
        assert_eq!(sess.id, "wt");

        run(&repo_s, &["worktree", "remove", "--force", &wt_s]).await;
        run(&repo_s, &["worktree", "prune"]).await;
        run(&repo_s, &["branch", "-D", "gd/session/test"]).await;
        let after = parse_worktree_list(&run(&repo_s, &["worktree", "list", "--porcelain"]).await);
        assert!(
            after.iter().all(|w| w.branch != "gd/session/test"),
            "session worktree is gone after remove"
        );
    }

    /// Keep (remove worktree, retain branch) then Resume (re-add the worktree on
    /// the SAME existing branch at the SAME path) — the resumed checkout has the
    /// kept work and the branch is back in the worktree list.
    #[tokio::test]
    async fn worktree_keep_then_resume_reattaches_branch() {
        let _base = tempfile::Builder::new()
            .prefix("gd-wt-resume-")
            .tempdir()
            .expect("create temp dir");
        let base = _base.path().to_path_buf();
        let repo = base.join("repo");
        let wt = base.join("wt");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        let wt_s = wt.to_string_lossy().into_owned();

        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;

        // Session: worktree on a fresh branch, makes a commit (the "kept" work).
        run(
            &repo_s,
            &build_session_worktree_add_args("gd/session/keep", &wt_s, "HEAD"),
        )
        .await;
        std::fs::write(wt.join("b.txt"), "work\n").unwrap();
        run(&wt_s, &["add", "-A"]).await;
        run(&wt_s, &["commit", "-qm", "agent work"]).await;

        // Keep: drop the worktree dir, retain the branch. No --force, matching
        // production (per-turn commits leave the worktree clean).
        run(&repo_s, &["worktree", "remove", &wt_s]).await;
        assert!(!wt.exists(), "worktree dir gone after keep");

        // Resume: re-add a worktree on the EXISTING branch at the same path.
        run(&repo_s, &["worktree", "prune"]).await;
        run(&repo_s, &["worktree", "add", &wt_s, "gd/session/keep"]).await;
        assert!(
            wt.join("b.txt").exists(),
            "resumed worktree has the kept work"
        );
        let list = parse_worktree_list(&run(&repo_s, &["worktree", "list", "--porcelain"]).await);
        assert!(
            list.iter().any(|w| w.branch == "gd/session/keep"),
            "branch is checked out in a worktree again after resume"
        );
    }

    #[test]
    fn session_worktree_add_args_suppress_tracking_before_branch_flag() {
        let args = build_session_worktree_add_args("gd/session/x", "/wt/x", "HEAD");
        assert_eq!(
            args,
            [
                "worktree",
                "add",
                "--no-track",
                "-b",
                "gd/session/x",
                "/wt/x",
                "HEAD"
            ]
        );
    }

    /// Absent or blank defaults to HEAD, rev syntax passes, and anything git would
    /// parse as an option never reaches the `worktree add` argv.
    #[test]
    fn worktree_base_ref_defaults_and_refuses_option_shapes() {
        for (input, want) in [
            (None, Some("HEAD")),
            (Some(""), Some("HEAD")),
            (Some("  "), Some("HEAD")),
            (Some(" main "), Some("main")),
            (Some("main~2"), Some("main~2")),
            (Some("origin/main"), Some("origin/main")),
            (Some("-x"), None),
            (Some("--force"), None),
            (Some(" --force"), None),
        ] {
            let got = worktree_base_ref(input);
            match want {
                Some(w) => assert_eq!(got.ok(), Some(w), "input {input:?}"),
                None => assert!(
                    matches!(got, Err(AppError::InvalidArgument(_))),
                    "input {input:?} must be refused, got {got:?}"
                ),
            }
        }
    }

    /// Under `branch.autoSetupMerge = always` a session branch created from the
    /// builder's argv has NO upstream; the control arm drops `--no-track` and must
    /// pick one up, proving the config is live in this repo.
    #[tokio::test]
    async fn session_worktree_branch_has_no_upstream_under_autosetupmerge_always() {
        let (base, repo_s) = setup_repo("no-track").await;
        run(&repo_s, &["config", "branch.autoSetupMerge", "always"]).await;

        let wt_s = base.path().join("wt").to_string_lossy().into_owned();
        run(
            &repo_s,
            &build_session_worktree_add_args("gd/session/nt", &wt_s, "HEAD"),
        )
        .await;
        // The runner pins LC_ALL=C, so git's English refusal is stable to match.
        let upstream = run_git(
            Some(&repo_s),
            &["rev-parse", "--abbrev-ref", "gd/session/nt@{upstream}"],
            DEFAULT_TIMEOUT,
        )
        .await
        .err();
        assert!(
            matches!(&upstream, Some(AppError::Git { stderr, .. }) if stderr.contains("no upstream")),
            "session branch must have no upstream, got {upstream:?}"
        );

        let ctl_s = base.path().join("ctl").to_string_lossy().into_owned();
        let tracking: Vec<&str> = build_session_worktree_add_args("gd/session/ctl", &ctl_s, "HEAD")
            .into_iter()
            .filter(|a| *a != "--no-track")
            .collect();
        run(&repo_s, &tracking).await;
        assert!(
            !run(
                &repo_s,
                &["rev-parse", "--abbrev-ref", "gd/session/ctl@{upstream}"]
            )
            .await
            .trim()
            .is_empty(),
            "control branch without --no-track should track its base"
        );
    }

    /// A temp repo with one commit, for the `remove_worktree` tests. The returned
    /// `TempDir` owns the whole tree (worktrees included, so they're cleaned up
    /// too) and must stay alive for the test's duration.
    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let base = tempfile::Builder::new()
            .prefix(&format!("gd-wt-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = base.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        (base, repo_s)
    }

    #[tokio::test]
    async fn worktree_add_refuses_session_branch_name_any_case() {
        for new_branch in [true, false] {
            let (base, repo) = setup_repo("session-branch-name").await;
            let name = "GD/Session/x";
            if !new_branch {
                run(&repo, &["branch", name]).await;
            }
            let before = run(&repo, &["for-each-ref", "refs/heads"]).await;
            let path = base.path().join("prefixed-branch");
            let result = git_worktree_add_user_core(
                &AppState::default(),
                &repo,
                &path.to_string_lossy(),
                name,
                new_branch,
                None,
            )
            .await;
            assert!(
                matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                    "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
                "{result:?}"
            );
            assert!(!path.exists());
            assert_eq!(run(&repo, &["for-each-ref", "refs/heads"]).await, before);
        }
    }

    #[tokio::test]
    async fn worktree_add_resolves_a_relative_path_against_the_repo() {
        let (_base, repo) = setup_repo("relative-path").await;
        let taken = std::path::Path::new(&repo).join("taken");
        std::fs::create_dir(&taken).unwrap();
        std::fs::write(taken.join("keep.txt"), "keep\n").unwrap();
        let result = git_worktree_add_user_core(
            &AppState::default(),
            &repo,
            "taken",
            "fresh",
            true,
            None,
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if
                message.contains("already exists — choose a new folder")),
            "{result:?}"
        );
        assert!(run(&repo, &["for-each-ref", "refs/heads/fresh"])
            .await
            .is_empty());
    }

    #[test]
    fn exclude_append_bytes_appends_once_with_the_file_eol() {
        let line = GITDESKTOP_WORKTREES_EXCLUDE;
        let some =
            |bytes: &[u8]| exclude_append_bytes(bytes, line).map(|b| String::from_utf8(b).unwrap());
        assert_eq!(some(b"").as_deref(), Some("/.gitdesktop/worktrees/\n"));
        assert_eq!(
            some(b"a\nb\n").as_deref(),
            Some("/.gitdesktop/worktrees/\n")
        );
        assert_eq!(
            some(b"a\r\nb").as_deref(),
            Some("\r\n/.gitdesktop/worktrees/\r\n")
        );
        assert_eq!(
            some(b"a\nb").as_deref(),
            Some("\n/.gitdesktop/worktrees/\n")
        );
        assert_eq!(some(b"# x\n/.gitdesktop/worktrees/\n"), None);
        assert_eq!(some(b"/.gitdesktop/worktrees/\r\nz"), None);
        assert_eq!(some(b"/.gitdesktop/worktrees/  "), None);
        // git keeps a leading space in the pattern, so that line isn't ours.
        assert_eq!(
            some(b"  /.gitdesktop/worktrees/\n").as_deref(),
            Some("/.gitdesktop/worktrees/\n")
        );
        // Containing the line isn't being it.
        assert!(some(b"/.gitdesktop/worktrees/x\n").is_some());
        // Non-UTF-8 content is tolerated and left as it is.
        let bytes = exclude_append_bytes(b"\xff\xfe\n", line).unwrap();
        assert_eq!(bytes, b"/.gitdesktop/worktrees/\n");
    }

    #[test]
    fn main_root_from_common_dir_gitdesktop_worktrees_anchor() {
        let root = |c: &str| main_root_from_common_dir(c);
        assert_eq!(root("C:/r/.git").as_deref(), Some("C:/r"));
        assert_eq!(root(r"C:\r\.git\").as_deref(), Some("C:/r"));
        assert_eq!(root("C:/.git").as_deref(), Some("C:"));
        assert_eq!(
            root(r"\\?\UNC\srv\share\r\.git").as_deref(),
            Some("//srv/share/r")
        );
        assert_eq!(root("/home/u/r/.git").as_deref(), Some("/home/u/r"));
        assert_eq!(root("/x/repo.git"), None);
        assert_eq!(root("/x/gitdir"), None);
        // Case survives, so a byte-exact (unfolded) compare still anchors under it.
        let mixed = root("/repos/MyRepo/.git").unwrap();
        assert_eq!(mixed, "/repos/MyRepo");
        let target = "/repos/MyRepo/.gitdesktop/worktrees/pr-7";
        assert!(inside_gitdesktop_worktrees(&mixed, target, false));
    }

    #[test]
    fn is_inside_gitdesktop_worktrees_string_shapes() {
        let inside = |root: &str, target: &str| inside_gitdesktop_worktrees(root, target, true);
        assert!(inside("C:/r", r"C:\r\.gitdesktop\worktrees\x"));
        assert!(inside("C:/r", r"c:\R\.GitDesktop\Worktrees\x"));
        assert!(inside(
            "//srv/share/r",
            r"\\srv\share\r\.gitdesktop\worktrees\x"
        ));
        assert!(inside(
            "//srv/share/r",
            r"\\?\UNC\srv\share\r\.gitdesktop\worktrees\x"
        ));
        assert!(inside("C:/r", r"\\?\C:\r\.gitdesktop\worktrees\x"));
        assert!(inside("c:", r"C:\.gitdesktop\worktrees\x"));
        assert!(inside("C:/r/", "C:/r/.gitdesktop/worktrees/x"));
        assert!(inside("C:/r", "C:/r/.gitdesktop/worktrees/x/nested"));
        assert!(inside("/home/u/r", "/home/u/r/.gitdesktop/worktrees/x"));
        assert!(inside("C:/r", "C:/r/.gitdesktop/worktrees/./x"));
        assert!(inside("C:/r", "C:/r/.gitdesktop/worktrees/x/"));
        assert!(inside("C:/r", "C:/r/./.gitdesktop//worktrees/x"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktrees/../../src"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktrees/x/../../y"));
        assert!(!inside("C:/r", "C:/r/../r/.gitdesktop/worktrees/x"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktreesX/y"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/other/y"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktrees"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktrees/"));
        assert!(!inside("C:/r", "C:/r/.gitdesktop/worktrees/./"));
        assert!(!inside("C:/r", "C:/rx/.gitdesktop/worktrees/x"));
        assert!(!inside("C:/r", "C:/other/.gitdesktop/worktrees/x"));
        assert!(!inside(
            "//srv/share/r",
            "/srv/share/r/.gitdesktop/worktrees/x"
        ));
    }

    #[test]
    fn is_inside_gitdesktop_worktrees_folds_case_only_when_asked() {
        let typed = "/home/u/r/.GitDesktop/Worktrees/pr-7";
        assert!(!inside_gitdesktop_worktrees("/home/u/r", typed, false));
        assert!(inside_gitdesktop_worktrees("/home/u/r", typed, true));
        let exact = "/home/u/r/.gitdesktop/worktrees/x";
        assert!(!inside_gitdesktop_worktrees("/home/u/R", exact, false));
        assert!(inside_gitdesktop_worktrees("/home/u/r", exact, false));
    }

    /// The typed spellings `resolve_worktree_path` passes through unnormalized.
    #[test]
    fn resolved_dot_and_trailing_slash_spellings_are_contained() {
        for typed in [
            "./.gitdesktop/worktrees/pr-7",
            ".gitdesktop/worktrees/pr-7/",
        ] {
            let resolved = resolve_worktree_path("/home/u/r", typed);
            assert!(
                is_inside_gitdesktop_worktrees("/home/u/r", &resolved),
                "{resolved}"
            );
        }
    }

    /// Only these shapes need `Path::join`, which parses drive prefixes on Windows only.
    #[cfg(windows)]
    #[test]
    fn resolved_gitdesktop_worktrees_windows_shapes() {
        let drive_relative = resolve_worktree_path(r"C:\r", r"C:.gitdesktop\worktrees\x");
        assert!(!is_inside_gitdesktop_worktrees("C:/r", &drive_relative));
        let root_relative = resolve_worktree_path(r"C:\r", r"\.gitdesktop\worktrees\x");
        assert!(!is_inside_gitdesktop_worktrees("C:/r", &root_relative));
        let drive_root = main_root_from_common_dir("C:/.git").unwrap();
        assert!(is_inside_gitdesktop_worktrees(&drive_root, &root_relative));
    }

    fn exclude_file(repo: &str) -> std::path::PathBuf {
        std::path::Path::new(repo)
            .join(".git")
            .join("info")
            .join("exclude")
    }

    fn excludes_line(repo: &str) -> bool {
        let bytes = std::fs::read(exclude_file(repo)).unwrap_or_default();
        String::from_utf8_lossy(&bytes)
            .lines()
            .any(|l| l.trim() == GITDESKTOP_WORKTREES_EXCLUDE)
    }

    async fn untracked_status(repo: &str) -> String {
        run(repo, &["status", "--porcelain", "--untracked-files=all"]).await
    }

    /// A linked worktree of `repo` at `<base>/linked`, on its own branch.
    async fn add_linked(base: &tempfile::TempDir, repo: &str) -> String {
        let linked = base.path().join("linked").to_string_lossy().into_owned();
        run(repo, &["worktree", "add", "-q", "-b", "linked-b", &linked]).await;
        linked
    }

    #[tokio::test]
    async fn ensure_gitdesktop_excluded_creates_missing_info_exclude() {
        let (_base, repo) = setup_repo("exclude-missing").await;
        std::fs::remove_dir_all(std::path::Path::new(&repo).join(".git").join("info")).ok();
        assert!(ensure_gitdesktop_excluded(&repo).await.unwrap());
        assert_eq!(
            std::fs::read(exclude_file(&repo)).unwrap(),
            b"/.gitdesktop/worktrees/\n"
        );
    }

    #[tokio::test]
    async fn ensure_gitdesktop_excluded_appends_once_and_preserves_content() {
        let (_base, repo) = setup_repo("exclude-append").await;
        std::fs::write(exclude_file(&repo), b"# x\r\n*.tmp").unwrap();
        assert!(ensure_gitdesktop_excluded(&repo).await.unwrap());
        assert!(!ensure_gitdesktop_excluded(&repo).await.unwrap());
        assert_eq!(
            std::fs::read(exclude_file(&repo)).unwrap(),
            b"# x\r\n*.tmp\r\n/.gitdesktop/worktrees/\r\n"
        );
    }

    #[tokio::test]
    async fn ensure_gitdesktop_excluded_from_linked_worktree_writes_common_dir() {
        let (base, repo) = setup_repo("exclude-linked").await;
        let linked = add_linked(&base, &repo).await;
        assert!(ensure_gitdesktop_excluded(&linked).await.unwrap());
        assert!(excludes_line(&repo));
        let own = std::path::Path::new(&repo).join(".git/worktrees/linked/info/exclude");
        assert!(!own.exists());
    }

    #[tokio::test]
    async fn worktree_add_user_into_gitdesktop_worktrees_excludes_it() {
        let (_base, repo) = setup_repo("exclude-add").await;
        let state = AppState::default();
        git_worktree_add_user_core(
            &state,
            &repo,
            ".gitdesktop/worktrees/wt1",
            "wt1",
            true,
            None,
        )
        .await
        .unwrap();
        assert!(excludes_line(&repo));
        assert_eq!(untracked_status(&repo).await, "");
    }

    #[tokio::test]
    async fn worktree_add_user_outside_gitdesktop_writes_no_exclude() {
        let (base, repo) = setup_repo("exclude-outside").await;
        let before = std::fs::read(exclude_file(&repo)).unwrap();
        let path = base.path().join("wt-out").to_string_lossy().into_owned();
        git_worktree_add_user_core(&AppState::default(), &repo, &path, "out", true, None)
            .await
            .unwrap();
        assert_eq!(std::fs::read(exclude_file(&repo)).unwrap(), before);
    }

    #[tokio::test]
    async fn worktree_add_user_survives_an_unwritable_exclude() {
        let (_base, repo) = setup_repo("exclude-unwritable").await;
        std::fs::remove_file(exclude_file(&repo)).ok();
        // POSIX git refuses an exclude path that is a directory, so there a missing file
        // in a read-only info/ makes only the app's create fail.
        // Root ignores directory permissions, so the read-only trick can't block it.
        // SAFETY: geteuid has no preconditions and cannot fail.
        #[cfg(unix)]
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        // Restored on drop: a read-only dir can fail TempDir cleanup.
        #[cfg(unix)]
        let _readonly = {
            use std::os::unix::fs::PermissionsExt;
            struct Restore(std::path::PathBuf);
            impl Drop for Restore {
                fn drop(&mut self) {
                    let mode = std::fs::Permissions::from_mode(0o755);
                    std::fs::set_permissions(&self.0, mode).ok();
                }
            }
            let info = exclude_file(&repo).parent().unwrap().to_path_buf();
            std::fs::set_permissions(&info, std::fs::Permissions::from_mode(0o555)).unwrap();
            Restore(info)
        };
        #[cfg(windows)]
        std::fs::create_dir(exclude_file(&repo)).unwrap();
        let path = ".gitdesktop/worktrees/wt1";
        git_worktree_add_user_core(&AppState::default(), &repo, path, "wt1", true, None)
            .await
            .unwrap();
        assert!(std::path::Path::new(&repo).join(path).is_dir());
        assert!(!excludes_line(&repo));
    }

    #[tokio::test]
    async fn worktree_add_user_from_linked_checkout_excludes_in_common_dir() {
        let (base, repo) = setup_repo("exclude-from-linked").await;
        let linked = add_linked(&base, &repo).await;
        // git's own spelling of the main root, as the app's default path derives it.
        let main = run(&repo, &["rev-parse", "--show-toplevel"]).await;
        let target = format!("{}/.gitdesktop/worktrees/wt2", main.trim());
        git_worktree_add_user_core(&AppState::default(), &linked, &target, "wt2", true, None)
            .await
            .unwrap();
        assert!(excludes_line(&repo));
        assert_eq!(untracked_status(&repo).await, "");
    }

    #[tokio::test]
    async fn worktree_add_user_typed_under_linked_checkout_excludes_in_common_dir() {
        let (base, repo) = setup_repo("exclude-typed-linked").await;
        let linked = add_linked(&base, &repo).await;
        let path = ".gitdesktop/worktrees/wt4";
        git_worktree_add_user_core(&AppState::default(), &linked, path, "wt4", true, None)
            .await
            .unwrap();
        assert!(std::path::Path::new(&linked).join(path).is_dir());
        assert!(excludes_line(&repo));
        assert_eq!(untracked_status(&linked).await, "");
    }

    #[tokio::test]
    async fn worktree_add_user_failed_add_leaves_line_inert() {
        let (_base, repo) = setup_repo("exclude-failed-add").await;
        run(&repo, &["branch", "dup"]).await;
        let before = untracked_status(&repo).await;
        let path = ".gitdesktop/worktrees/wt3";
        let result =
            git_worktree_add_user_core(&AppState::default(), &repo, path, "dup", true, None).await;
        assert!(result.is_err(), "{result:?}");
        assert_eq!(untracked_status(&repo).await, before);
        assert!(!std::path::Path::new(&repo).join(path).exists());
    }

    /// The worktree registry as git reports it, forward-slashed + lower-cased so a
    /// `/dir-name` substring check is separator- and case-agnostic.
    async fn registry(repo: &str) -> String {
        normalize_wt_path(&run(repo, &["worktree", "list", "--porcelain"]).await)
    }

    /// A forced removal of a LOCKED worktree must fully remove it — git needs
    /// `--force` twice for a locked one, and a half-removal leaves an admin entry
    /// that prune can't drop. The branch is not part of the removal here.
    #[tokio::test]
    async fn locked_worktree_force_remove_clears_registration() {
        let (base, repo_s) = setup_repo("force-locked").await;
        let wt = base.path().join("locked-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-lock", &wt_s, "HEAD"]).await;
        run(&repo_s, &["worktree", "lock", &wt_s]).await;

        let state = AppState::default();
        let outcome = remove_worktree(&state, &repo_s, &wt_s, None, true)
            .await
            .expect("forced removal of a locked worktree succeeds");
        assert_eq!(outcome.branch_cleanup, BranchCleanup::NotRequested);

        assert!(!wt.exists(), "the checkout is gone from disk");
        assert!(
            !registry(&repo_s).await.contains("/locked-wt"),
            "no admin entry is left behind"
        );
        assert!(
            !run(&repo_s, &["branch", "--list", "feat-lock"])
                .await
                .trim()
                .is_empty(),
            "the branch survives a removal that wasn't asked to delete it"
        );
    }

    /// A non-forced removal git refuses over uncommitted work must surface git's
    /// error with the checkout intact — the frontend keys on that message to offer
    /// the forced retry.
    #[tokio::test]
    async fn dirty_worktree_nonforced_remove_surfaces_error() {
        let (base, repo_s) = setup_repo("dirty").await;
        let wt = base.path().join("dirty-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-dirty", &wt_s, "HEAD"]).await;
        std::fs::write(wt.join("scratch.txt"), "wip\n").unwrap();

        let state = AppState::default();
        let err = remove_worktree(&state, &repo_s, &wt_s, None, false)
            .await
            .expect_err("git refuses to drop uncommitted work");

        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("force") || msg.contains("modified") || msg.contains("untracked"),
            "error must match the frontend's escalation vocabulary: {msg}"
        );
        assert!(wt.exists(), "the dirty checkout is left on disk");
        assert!(
            registry(&repo_s).await.contains("/dirty-wt"),
            "the worktree stays registered"
        );
    }

    /// The other half of the same guard: a CLEAN but locked worktree. Nothing is
    /// dirty, yet git still refuses — the removal must report that instead of
    /// deleting the folder behind git's back and leaving an unprunable entry.
    #[tokio::test]
    async fn locked_clean_worktree_nonforced_remove_refuses() {
        let (base, repo_s) = setup_repo("locked-clean").await;
        let wt = base.path().join("clean-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-clean", &wt_s, "HEAD"]).await;
        run(&repo_s, &["worktree", "lock", &wt_s]).await;

        let state = AppState::default();
        let err = remove_worktree(&state, &repo_s, &wt_s, None, false)
            .await
            .expect_err("git refuses to drop a locked worktree without --force");

        let msg = err.to_string().to_lowercase();
        assert!(msg.contains("locked"), "the lock must be named: {msg}");
        assert!(wt.exists(), "the locked checkout is left on disk");
        assert!(
            registry(&repo_s).await.contains("/clean-wt"),
            "the worktree stays registered"
        );
    }

    /// The main worktree is never deleted behind git's back: git refuses in
    /// both force modes, the entry stays registered, and the checkout
    /// survives.
    #[tokio::test]
    async fn main_worktree_remove_surfaces_error_and_keeps_checkout() {
        let (_base, repo_s) = setup_repo("main-wt").await;
        let state = AppState::default();
        for force in [false, true] {
            let err = remove_worktree(&state, &repo_s, &repo_s, None, force)
                .await
                .expect_err("git refuses to remove the main working tree");
            assert!(
                err.to_string().to_lowercase().contains("main working tree"),
                "git must name the reason: {err}"
            );
        }
        assert!(
            std::path::Path::new(&repo_s).join("a.txt").exists(),
            "the main checkout survives"
        );
        assert!(
            registry(&repo_s).await.contains("/repo"),
            "main stays registered"
        );
    }

    /// The fallback still finishes a removal git half-did: git de-registers
    /// `.git/worktrees/<id>` BEFORE deleting the directory, so a leftover
    /// folder with no admin entry must be deleted, not reported.
    #[tokio::test]
    async fn deregistered_worktree_remove_deletes_leftover_folder() {
        let (base, repo_s) = setup_repo("deregistered").await;
        let wt = base.path().join("orphan-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-orphan", &wt_s, "HEAD"]).await;
        // Reproduce git's ordering: admin entry gone, checkout still on disk.
        std::fs::remove_dir_all(
            std::path::Path::new(&repo_s).join(".git").join("worktrees"),
        )
        .expect("drop the worktree admin dir");

        let state = AppState::default();
        remove_worktree(&state, &repo_s, &wt_s, None, false)
            .await
            .expect("a de-registered leftover folder is finished off, not reported");
        assert!(!wt.exists(), "the leftover checkout is deleted");
        assert!(
            !registry(&repo_s).await.contains("/orphan-wt"),
            "nothing is left in the registry"
        );
    }

    /// A removal killed mid-delete (a timeout on a huge tree) leaves the state git
    /// reports as `prunable gitdir file points to non-existent location`: entry
    /// still registered, checkout still on disk, its inner `.git` link already
    /// gone. git then refuses `worktree remove` in both force modes, so the retry
    /// has to fall through to our own delete + prune.
    #[tokio::test]
    async fn prunable_half_removed_worktree_is_removed_on_retry() {
        let (base, repo_s) = setup_repo("prunable-half").await;
        let wt = base.path().join("half-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-half", &wt_s, "HEAD"]).await;
        std::fs::remove_file(wt.join(".git")).expect("break the gitdir link");
        assert!(
            registry(&repo_s).await.contains("prunable"),
            "the fixture must reproduce the prunable state"
        );

        let state = AppState::default();
        remove_worktree(&state, &repo_s, &wt_s, None, false)
            .await
            .expect("the retry finishes an interrupted removal");
        assert!(!wt.exists(), "the half-deleted checkout is gone");
        assert!(
            !registry(&repo_s).await.contains("/half-wt"),
            "the stale admin entry is pruned"
        );
    }

    /// The same interruption one step later — directory already gone, entry still
    /// registered and prunable. Removal must reconcile it rather than report the
    /// worktree as missing.
    #[tokio::test]
    async fn prunable_registered_entry_with_dir_gone_is_reconciled() {
        let (base, repo_s) = setup_repo("prunable-gone").await;
        let wt = base.path().join("gone-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-gone", &wt_s, "HEAD"]).await;
        std::fs::remove_dir_all(&wt).expect("drop the whole checkout");
        assert!(
            registry(&repo_s).await.contains("prunable"),
            "the fixture must reproduce the prunable state"
        );

        let state = AppState::default();
        remove_worktree(&state, &repo_s, &wt_s, None, false)
            .await
            .expect("a vanished checkout is reconciled, not reported");
        assert!(
            !registry(&repo_s).await.contains("/gone-wt"),
            "the stale admin entry is gone"
        );
    }

    /// The last-activity probe over both worktree shapes: the main checkout,
    /// whose `.git` is a directory, and a linked one, whose `.git` is a pointer
    /// file. Then the index-over-HEAD priority, which every order-blind
    /// assertion above would also pass for a HEAD-first probe, the relative form
    /// of that pointer, and the fallback chain — index gone leaves HEAD, both
    /// gone reports nothing rather than erroring.
    ///
    /// The pointer is rewritten in place and never restored, so every assertion
    /// after that stage resolves through the RELATIVE form rather than git's
    /// absolute one. Deliberate: it keeps both arms exercised, and the admin
    /// paths the deletions use come from the repo path, not the pointer.
    #[tokio::test]
    async fn last_activity_reads_both_worktree_shapes_and_falls_back() {
        let (base, repo_s) = setup_repo("last-activity").await;
        let wt = base.path().join("age-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-age", &wt_s, "HEAD"]).await;

        let now = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        for path in [&repo_s, &wt_s] {
            let ms = worktree_last_activity_ms(path)
                .unwrap_or_else(|| panic!("a live worktree has a readable mtime: {path}"));
            assert!(
                (ms - now).abs() < 5 * 60 * 1000,
                "{path}: {ms} is not within 5 minutes of {now}"
            );
        }

        let admin = std::path::Path::new(&repo_s)
            .join(".git")
            .join("worktrees")
            .join("age-wt");
        let index = admin.join("index");
        let head = admin.join("HEAD");

        // Backdate the index an hour with its bytes untouched, so the two stamps
        // are ordered and far apart: the probe must report the OLDER one, which
        // neither a HEAD-first nor a newest-of-the-two resolution can. Setting the
        // time rather than sleeping keeps this off the filesystem's timestamp
        // granularity.
        let handle = std::fs::OpenOptions::new()
            .write(true)
            .open(&index)
            .expect("open the linked index");
        handle
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
            .expect("backdate the linked index");
        drop(handle);

        let index_ms = file_mtime_ms(&index).expect("the backdated index has an mtime");
        let head_ms = file_mtime_ms(&head).expect("HEAD has an mtime");
        assert!(
            index_ms < head_ms,
            "the fixture must separate the stamps: index {index_ms}, HEAD {head_ms}"
        );
        assert_eq!(
            worktree_last_activity_ms(&wt_s),
            Some(index_ms),
            "the index is the signal, not HEAD"
        );

        // git records an ABSOLUTE pointer unless `worktree.useRelativePaths` is on,
        // so only a hand-built one exercises the relative arm at the filesystem level.
        let repo_dir = std::path::Path::new(&repo_s)
            .file_name()
            .expect("the temp repo has a directory name")
            .to_string_lossy()
            .into_owned();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: ../{repo_dir}/.git/worktrees/age-wt\n"),
        )
        .expect("rewrite the pointer in its relative form");
        assert_eq!(
            worktree_last_activity_ms(&wt_s),
            Some(index_ms),
            "a relative gitdir pointer resolves against the worktree"
        );

        std::fs::remove_file(&index).expect("drop the linked index");
        assert_eq!(
            worktree_last_activity_ms(&wt_s),
            Some(head_ms),
            "HEAD carries the fallback when the index is unreadable"
        );
        std::fs::remove_file(&head).expect("drop the linked HEAD");
        assert_eq!(
            worktree_last_activity_ms(&wt_s),
            None,
            "an unreadable probe reports nothing instead of failing"
        );
    }

    /// Sibling of `git::ops`'s rewrite interleave control, for the other compound
    /// shape: status check → `add -A` → commit → HEAD read. The second task commits
    /// through the normal mutating path once the turn observably holds the lock, and
    /// tokio's fair mutex queues it behind the whole turn — so neither side's work is
    /// lost and the hash handed back is the turn's OWN commit. Per-step locking let
    /// that commit land mid-sequence, where `add -A` swept it into the turn or the
    /// HEAD read misreported it as the turn's.
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_commit_never_loses_a_worktree_turn() {
        let (_base, repo_s) = setup_repo("commit-all-race").await;
        // The turn's output: an untracked file only `add -A` picks up.
        std::fs::write(std::path::Path::new(&repo_s).join("agent.txt"), "turn\n").unwrap();

        let state = std::sync::Arc::new(AppState::default());
        let concurrent = {
            let state = state.clone();
            let repo = repo_s.clone();
            tokio::spawn(async move {
                let domain = state.working_tree_lock(&repo).await;
                // Bounded wait: if the turn somehow finished first we still commit,
                // and the assertions below stay meaningful either way.
                for _ in 0..500 {
                    if domain.lock().try_lock().is_err() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                // The same queue an ordinary mutating caller joins, minus the wait
                // bound: this test pins the turn's ATOMICITY, so a turn that outran
                // `LOCK_WAIT_TIMEOUT` on a loaded runner must not turn it into a Busy
                // failure. Lock-free runner, since the hold is ours.
                let _guard = acquire_repo_lock_unbounded(&domain, "a commit").await;
                run_git(
                    Some(&repo),
                    &["commit", "--allow-empty", "-m", "concurrent"],
                    DEFAULT_TIMEOUT,
                )
                .await
                .expect("the queued commit must succeed once the turn releases");
            })
        };

        let hash = worktree_commit_all(&state, &repo_s, "session turn")
            .await
            .expect("committing a dirty worktree succeeds")
            .expect("a dirty worktree produces a commit");
        concurrent.await.expect("concurrent task panicked");

        // The hash handed back names the TURN's commit, never the racing one.
        let subject = run(&repo_s, &["log", "-1", "--format=%s", &hash]).await;
        assert_eq!(subject.trim(), "session turn");
        // Both commits survive, in whichever order they queued.
        let log = run(&repo_s, &["log", "--format=%s"]).await;
        assert!(log.contains("concurrent"), "concurrent commit lost: {log}");
        assert!(log.contains("session turn"), "turn commit lost: {log}");
        // And the turn's own output rode along in the turn's commit, not a later one.
        let files = run(&repo_s, &["show", "--name-only", "--format=", &hash]).await;
        assert!(files.contains("agent.txt"), "turn's output missing: {files}");
    }

    /// The bug this split fixes: while a removal holds the worktree-admin lock, a
    /// commit must run to completion rather than queue behind it. Deterministic —
    /// the admin lock is held outright for the whole call, no timing bet.
    #[tokio::test]
    async fn staging_runs_while_a_worktree_removal_holds_the_admin_lock() {
        let (_base, repo_s) = setup_repo("admin-vs-commit").await;
        let state = AppState::default();
        let _admin = acquire_repo_lock_unbounded(
            &state.worktree_admin_lock(&repo_s).await,
            "a worktree removal",
        )
        .await;

        run_git_mutating(
            &state,
            &repo_s,
            &["commit", "--allow-empty", "-m", "during removal"],
            DEFAULT_TIMEOUT,
        )
        .await
        .expect("a commit must not wait on the worktree-admin domain");
        assert!(run(&repo_s, &["log", "--format=%s"])
            .await
            .contains("during removal"));
    }

    /// The inverse direction, and the one the owner hit from the other side: a
    /// removal must not wait on whatever holds the working tree.
    #[tokio::test]
    async fn a_worktree_removal_runs_while_the_working_tree_lock_is_held() {
        let (base, repo_s) = setup_repo("commit-vs-removal").await;
        let wt = base.path().join("busy-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-busy", &wt_s, "HEAD"]).await;

        let state = AppState::default();
        let working_tree = state.working_tree_lock(&repo_s).await;
        let _held = working_tree.lock().lock_owned().await;

        let outcome = remove_worktree(&state, &repo_s, &wt_s, Some("feat-busy".into()), false)
            .await
            .expect("a removal must not wait on the working-tree domain");
        assert_eq!(outcome.branch_cleanup, BranchCleanup::Deleted);
        assert!(!wt.exists(), "the checkout is gone");
        assert!(
            run(&repo_s, &["branch", "--list", "feat-busy"])
                .await
                .trim()
                .is_empty(),
            "and its branch went with it"
        );
    }

    /// The opportunistic prune SKIPS rather than queues while an admin op runs, so
    /// the worktree list still answers during a removal. The stale entry surviving
    /// the contended call is what proves it was skipped and not merely slow.
    #[tokio::test]
    async fn the_opportunistic_prune_is_skipped_while_admin_work_runs() {
        let (base, repo_s) = setup_repo("prune-if-free").await;
        let wt = base.path().join("stale-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-stale", &wt_s, "HEAD"]).await;
        std::fs::remove_dir_all(&wt).expect("drop the checkout behind git's back");

        let state = AppState::default();
        let contended = {
            let _admin = acquire_repo_lock_unbounded(
                &state.worktree_admin_lock(&repo_s).await,
                "a worktree removal",
            )
            .await;
            prune_worktrees_if_free(&state, &repo_s).await
        };
        assert!(!contended, "a held admin lock skips the prune");
        assert!(
            registry(&repo_s).await.contains("/stale-wt"),
            "the stale entry survives a skipped prune"
        );

        assert!(
            prune_worktrees_if_free(&state, &repo_s).await,
            "a free admin lock runs it"
        );
        assert!(
            !registry(&repo_s).await.contains("/stale-wt"),
            "and the stale entry is gone"
        );
    }

    /// A passive read (`prune` false) answers what the pruning read answers, with
    /// the same filters, but leaves a deleted worktree's admin entry in place; the
    /// default read prunes it. A locked worktree on a missing drive survives both.
    #[tokio::test]
    async fn the_user_list_without_prune_keeps_a_stale_admin_entry() {
        let (base, repo_s) = setup_repo("list-no-prune").await;
        let add = |dir: &str, branch: &str| {
            let path = base.path().join(dir).to_string_lossy().into_owned();
            let repo = repo_s.clone();
            let branch = branch.to_string();
            async move {
                run(&repo, &["worktree", "add", "-b", &branch, &path, "HEAD"]).await;
                path
            }
        };
        let healthy = add("healthy-wt", "feat-healthy").await;
        let locked = add("locked-wt", "feat-locked").await;
        run(
            &repo_s,
            &["worktree", "lock", "--reason", "offline", &locked],
        )
        .await;
        // Every compare is canonical, since git records resolved spellings (macOS
        // `/private/var`, Windows long names); this one resolves before the removal.
        let locked_key = canonical_wt_path(&locked);
        std::fs::remove_dir_all(&locked).expect("the drive went away");
        let stale = add("stale-wt", "feat-stale").await;
        std::fs::remove_dir_all(&stale).expect("drop the checkout behind git's back");
        let session = add("session-wt", "feat-session").await;
        let app_data = base.path().join("app-data").join("worktrees");
        std::fs::create_dir_all(&app_data).unwrap();
        let internal = app_data.join("x").to_string_lossy().into_owned();
        run(
            &repo_s,
            &["worktree", "add", "-b", "feat-internal", &internal, "HEAD"],
        )
        .await;

        let session_paths: std::collections::HashSet<String> =
            [canonical_wt_path(&session)].into_iter().collect();
        let root = canonical_wt_path(&app_data.to_string_lossy());
        let state = AppState::default();
        let admin_entry = std::path::Path::new(&repo_s)
            .join(".git")
            .join("worktrees")
            .join("stale-wt");

        let peek = list_user_worktrees_impl(&state, &repo_s, &session_paths, Some(&root), false)
            .await
            .expect("the passive read answers");
        let shown: Vec<(String, bool, bool)> = peek
            .iter()
            .map(|w| (canonical_wt_path(&w.path), w.is_main, w.is_locked))
            .collect();
        assert_eq!(
            shown,
            vec![
                (canonical_wt_path(&repo_s), true, false),
                (canonical_wt_path(&healthy), false, false),
                (locked_key, false, true),
            ],
            "main first; session, app-data and prunable entries filtered"
        );
        assert!(admin_entry.exists(), "a passive read prunes nothing");
        assert!(registry(&repo_s).await.contains("/stale-wt"));

        let pruned = list_user_worktrees_impl(&state, &repo_s, &session_paths, Some(&root), true)
            .await
            .expect("the pruning read answers");
        assert_eq!(pruned, peek, "both reads list the same worktrees");
        assert!(
            !admin_entry.exists(),
            "the default read prunes the stale entry"
        );
        assert!(
            registry(&repo_s).await.contains("/locked-wt"),
            "git never prunes a locked one"
        );
    }

    /// The branch delete is now gated on the tip, not on a whole-repo hold: an
    /// unmoved branch goes, one that gained a commit since stays.
    #[tokio::test]
    async fn delete_branch_if_unmoved_spares_a_branch_that_moved() {
        let (base, repo_s) = setup_repo("tip-gate").await;
        let repo_dir = base.path().join("repo");
        run(&repo_s, &["branch", "unmoved"]).await;
        run(&repo_s, &["branch", "moved"]).await;
        let tip = validated_branch_tip(&repo_s, "moved")
            .await
            .expect("a fresh branch has a tip");

        // The branch gains a commit after the tip was recorded.
        run(&repo_s, &["switch", "-q", "moved"]).await;
        std::fs::write(repo_dir.join("later.txt"), "later\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "landed after the snapshot"]).await;
        run(&repo_s, &["switch", "-q", "-"]).await;

        assert_eq!(
            delete_branch_if_unmoved(&repo_s, "moved", &tip).await,
            BranchCleanup::SparedMoved
        );
        assert!(
            !run(&repo_s, &["branch", "--list", "moved"])
                .await
                .trim()
                .is_empty(),
            "a branch that moved since the snapshot must survive"
        );

        let unmoved_tip = validated_branch_tip(&repo_s, "unmoved").await.unwrap();
        assert_eq!(
            delete_branch_if_unmoved(&repo_s, "unmoved", &unmoved_tip).await,
            BranchCleanup::Deleted
        );
        assert!(
            run(&repo_s, &["branch", "--list", "unmoved"])
                .await
                .trim()
                .is_empty(),
            "an unmoved branch is deleted"
        );

        // A branch that never existed is a no-op with nothing to report as kept.
        assert_eq!(
            delete_branch_if_unmoved(&repo_s, "never-existed", &unmoved_tip).await,
            BranchCleanup::NotRequested
        );
    }

    /// `branch -D` exits 0 when it loses `.git/config.lock`, so the best-effort delete
    /// still has to repair: the branch's `branch.<name>` section goes with it, through
    /// the repair's retry when the lock outlives its first attempt.
    #[tokio::test]
    async fn delete_branch_if_unmoved_drops_the_section_a_lost_config_lock_left() {
        use crate::git::runner::{release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK};
        let (base, repo_s) = setup_repo("tip-gate-config-lock").await;
        let branch = "gd/session/cfg-lock";
        run(&repo_s, &["branch", branch]).await;
        run(
            &repo_s,
            &[
                "config",
                &format!("branch.{branch}.gitdesktopArchived"),
                "true",
            ],
        )
        .await;
        let tip = validated_branch_tip(&repo_s, branch).await.unwrap();
        let lock = base.path().join("repo").join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock, 2);

        assert_eq!(
            CONFIG_WRITE_ATTEMPT_HOOK
                .scope(hook, delete_branch_if_unmoved(&repo_s, branch, &tip))
                .await,
            BranchCleanup::Deleted
        );
        assert!(
            validated_branch_tip(&repo_s, branch).await.is_none(),
            "deleted"
        );
        let section = run_git_raw(
            Some(&repo_s),
            &["config", "--get-regexp", r"^branch\.gd/session/cfg-lock\."],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(
            section.code,
            1,
            "no stale section: {}",
            section.stdout_lossy()
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// `setup_repo` plus an `origin` whose `feat` and `same-name` tracking refs sit at
    /// HEAD, and a `local-start` branch that tracks `origin/feat`.
    async fn repo_with_tracking_refs(marker: &str) -> (tempfile::TempDir, String) {
        let (base, repo_s) = setup_repo(marker).await;
        let nowhere = base.path().join("nowhere.git");
        run(
            &repo_s,
            &["remote", "add", "origin", &nowhere.to_string_lossy()],
        )
        .await;
        for name in ["feat", "same-name"] {
            let tracking = format!("refs/remotes/origin/{name}");
            run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        }
        run(
            &repo_s,
            &["branch", "--track", "local-start", "origin/feat"],
        )
        .await;
        (base, repo_s)
    }

    /// `branch.<name>.remote` and `.merge`, or `None` for each that is unset.
    async fn tracking_of(repo: &str, branch: &str) -> (Option<String>, Option<String>) {
        let mut got = Vec::new();
        for key in ["remote", "merge"] {
            let key = format!("branch.{branch}.{key}");
            let out = run_git_raw(Some(repo), &["config", "--get", &key], DEFAULT_TIMEOUT)
                .await
                .unwrap();
            got.push((out.code == 0).then(|| out.stdout_lossy().trim().to_string()));
        }
        let merge = got.pop().unwrap();
        (got.pop().unwrap(), merge)
    }

    /// The canary the add repair rests on (git 2.51.1): `worktree add -b` whose child
    /// `git branch` loses the config lock exits 255 with the branch created, untracked,
    /// and no worktree; adding that existing branch writes no config at all.
    #[tokio::test]
    async fn git_creates_the_branch_but_no_worktree_when_tracking_loses_the_config_lock() {
        use crate::git::branches::UPSTREAM_WRITE_FAILED;
        let (base, repo_s) = repo_with_tracking_refs("wt-cfg-shape").await;
        let wt = base.path().join("wt-shape").to_string_lossy().into_owned();
        let lock = hold_config_lock(&repo_s);
        let added = run_git_raw(
            Some(&repo_s),
            &["worktree", "add", "-b", "shape", &wt, "origin/feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(added.code, 255, "{}", added.stderr);
        assert!(is_config_lock_contention(&added.stderr), "{}", added.stderr);
        assert!(
            added.stderr.contains(UPSTREAM_WRITE_FAILED),
            "{}",
            added.stderr
        );
        assert!(
            validated_branch_tip(&repo_s, "shape").await.is_some(),
            "created"
        );
        assert_eq!(tracking_of(&repo_s, "shape").await, (None, None));
        assert!(!std::path::Path::new(&wt).exists(), "no worktree");

        let existing = run_git_raw(
            Some(&repo_s),
            &["worktree", "add", &wt, "shape"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(existing.code, 0, "{}", existing.stderr);
        assert!(std::path::Path::new(&wt).join("a.txt").exists());
    }

    /// Every `branch.autoSetupMerge` mode × start in which `worktree add -b` tracks
    /// (the create table's, measured, git 2.51.1). A lost upstream ends where an
    /// uncontended twin does, with the worktree checked out before the config-write
    /// mutex is ever requested; `inherit`, whose upstream can't be pinned, keeps
    /// git's error with no upstream, the worktree still added.
    #[tokio::test]
    async fn a_new_branch_worktree_repairs_only_what_git_itself_would_write() {
        use crate::git::branches::UPSTREAM_WRITE_FAILED;
        use crate::git::runner::{
            release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK, CONFIG_WRITE_LOCK_EVENTS,
        };
        use std::sync::atomic::Ordering;
        let (base, repo_s) = repo_with_tracking_refs("wt-cfg-modes").await;
        let state = AppState::default();
        // (mode, start, new branch, contended, repaired)
        type Case = (
            Option<&'static str>,
            Option<&'static str>,
            &'static str,
            bool,
            bool,
        );
        let cases: [Case; 6] = [
            (None, Some("origin/feat"), "wt-twin", false, true),
            (None, Some("origin/feat"), "wt-default", true, true),
            (Some("always"), Some("local-start"), "wt-always", true, true),
            (Some("always"), None, "wt-always-head", true, true),
            (
                Some("simple"),
                Some("origin/same-name"),
                "same-name",
                true,
                true,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "wt-inherit",
                true,
                false,
            ),
        ];
        for (mode, start, name, contended, repaired) in cases {
            let _ = run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", "branch.autoSetupMerge"],
                DEFAULT_TIMEOUT,
            )
            .await;
            if let Some(mode) = mode {
                run(&repo_s, &["config", "branch.autoSetupMerge", mode]).await;
            }
            // What git itself writes in this mode, uncontended. `simple` gets the
            // measured literal: its twin can't share the name tracking requires.
            let want = if mode == Some("simple") {
                (Some("origin".into()), Some("refs/heads/same-name".into()))
            } else {
                let twin = format!("{name}-twin");
                let mut twin_args = vec!["branch", twin.as_str()];
                twin_args.extend(start);
                run(&repo_s, &twin_args).await;
                tracking_of(&repo_s, &twin).await
            };
            assert!(want.0.is_some(), "{mode:?} × {start:?}: git tracks here");

            let wt = base.path().join(name);
            let wt_s = wt.to_string_lossy().into_owned();
            let lock = repo_s.clone() + "/.git/config.lock";
            let (hook, attempts) = if contended {
                release_config_lock_before_attempt(hold_config_lock(&repo_s), 2)
            } else {
                release_config_lock_before_attempt(lock.clone().into(), usize::MAX)
            };
            let probe = wt.join("a.txt");
            let (events, log) = lock_events(move || probe.exists());
            let add = git_worktree_add_user_core(&state, &repo_s, &wt_s, name, true, start);
            let added = CONFIG_WRITE_LOCK_EVENTS
                .scope(events, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, add))
                .await;
            let _ = std::fs::remove_file(&lock);

            let case = format!("{mode:?} × {start:?}");
            assert!(wt.join("a.txt").exists(), "{case}: the worktree was added");
            assert_eq!(
                run(&wt_s, &["symbolic-ref", "--short", "HEAD"])
                    .await
                    .trim(),
                name,
                "{case}"
            );
            let got = tracking_of(&repo_s, name).await;
            let log = log.lock().unwrap().clone();
            if !contended {
                added.unwrap_or_else(|e| panic!("{case}: {e}"));
                assert_eq!(got, want, "{case}");
                assert_eq!(attempts.load(Ordering::SeqCst), 0, "{case}: no repair");
                assert!(log.is_empty(), "{case}: no mutex uncontended");
            } else if repaired {
                added.unwrap_or_else(|e| panic!("{case}: {e}"));
                assert_eq!(got, want, "{case}: what git would have written");
                assert_eq!(attempts.load(Ordering::SeqCst), 2, "{case}");
                assert_eq!(
                    log,
                    [("waiting", true), ("acquired", true), ("freed", true)],
                    "{case}: the checkout came before the hold"
                );
            } else {
                let err = added.expect_err("an unpinnable upstream surfaces git's error");
                let AppError::Git { stderr, .. } = &err else {
                    panic!("expected git's error, got {err:?}")
                };
                assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
                assert_eq!(got, (None, None), "{case}: no guessed upstream");
                assert!(log.is_empty(), "{case}: nothing to write");
            }
        }
    }

    /// A lock held through the upstream repair's retry still adds the worktree, and the
    /// caller hears that it landed without tracking, never git's lock-file text.
    #[tokio::test]
    async fn a_new_branch_worktree_whose_upstream_repair_also_loses_is_still_added() {
        use crate::git::runner::config_lock_busy;
        let (base, repo_s) = repo_with_tracking_refs("wt-cfg-held").await;
        let wt = base.path().join("wt-held");
        let wt_s = wt.to_string_lossy().into_owned();
        let lock = hold_config_lock(&repo_s);
        let state = AppState::default();
        let err = git_worktree_add_user_core(
            &state,
            &repo_s,
            &wt_s,
            "wt-held",
            true,
            Some("origin/feat"),
        )
        .await
        .expect_err("the lost upstream is reported");
        std::fs::remove_file(&lock).unwrap();
        assert!(matches!(err, AppError::Command(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            config_lock_busy(
                "the worktree and branch wt-held were created without upstream tracking — \
                 set the upstream on wt-held to finish."
            )
            .to_string()
        );
        assert!(
            !err.to_string().contains("could not lock config file"),
            "{err}"
        );
        assert!(wt.join("a.txt").exists(), "the worktree was added");
        assert_eq!(tracking_of(&repo_s, "wt-held").await, (None, None));
    }

    /// git's own refusal is the third guard: a branch still checked out in a
    /// worktree survives even at its recorded tip.
    #[tokio::test]
    async fn delete_branch_if_unmoved_defers_to_gits_checkout_refusal() {
        let (base, repo_s) = setup_repo("tip-gate-checked-out").await;
        let wt = base.path().join("live-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-live", &wt_s, "HEAD"]).await;
        let tip = validated_branch_tip(&repo_s, "feat-live").await.unwrap();

        assert_eq!(
            delete_branch_if_unmoved(&repo_s, "feat-live", &tip).await,
            BranchCleanup::SparedUnreadable
        );
        assert!(
            !run(&repo_s, &["branch", "--list", "feat-live"])
                .await
                .trim()
                .is_empty(),
            "git refuses to delete a branch checked out in a worktree"
        );
    }

    /// A branch deleted out from under the session leaves nothing to report as
    /// kept, and an unreadable name is reported as spared rather than deleted.
    #[tokio::test]
    async fn removal_reports_a_vanished_branch_as_not_requested() {
        let (base, repo_s) = setup_repo("tip-gate-vanished").await;
        let wt = base.path().join("vanished-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--detach", &wt_s, "HEAD"]).await;

        let state = AppState::default();
        let outcome = remove_worktree(&state, &repo_s, &wt_s, Some("gone".into()), false)
            .await
            .expect("the removal itself succeeds");
        assert_eq!(outcome.branch_cleanup, BranchCleanup::NotRequested);
        assert!(!wt.exists(), "the checkout is gone");
        assert_eq!(
            read_branch_tip(&repo_s, "glob*name").await,
            TipRead::Unreadable
        );
    }

    /// The exact JSON `removeWorktree` reads in `src/lib/git/worktree.ts`: a
    /// camelCase field and camelCase variant tags, no snake_case spelling.
    #[test]
    fn worktree_remove_outcome_serializes_to_the_ts_wire_shape() {
        let cases = [
            (BranchCleanup::Deleted, "deleted"),
            (BranchCleanup::SparedMoved, "sparedMoved"),
            (BranchCleanup::SparedUnreadable, "sparedUnreadable"),
            (BranchCleanup::NotRequested, "notRequested"),
        ];
        for (branch_cleanup, tag) in cases {
            let json = serde_json::to_string(&WorktreeRemoveOutcome { branch_cleanup }).unwrap();
            assert_eq!(json, format!(r#"{{"branchCleanup":"{tag}"}}"#));
            assert!(!json.contains("branch_cleanup"), "{json}");
        }
    }

    fn invalid_argument(result: AppResult<impl std::fmt::Debug>) -> String {
        match result {
            Err(AppError::InvalidArgument(message)) => message,
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    #[test]
    fn worktree_path_arg_trims_and_refuses_blank_and_option_shapes() {
        assert_eq!(worktree_path_arg("  C:/x/wt \n").unwrap(), "C:/x/wt");
        assert_eq!(worktree_path_arg("rel/wt").unwrap(), "rel/wt");
        for blank in ["", "   ", "\t\n"] {
            assert_eq!(
                invalid_argument(worktree_path_arg(blank)),
                "a worktree path is required"
            );
        }
        for option in ["-x", " -x", "--force"] {
            assert_eq!(
                invalid_argument(worktree_path_arg(option)),
                "path must not start with '-'"
            );
        }
    }

    #[test]
    fn ambiguous_worktree_path_refusals_are_lexical_and_windows_scoped() {
        let refused = [
            ("C:/x/wt.", "\"wt.\" ends in a dot or space"),
            ("C:/x/wt /y", "\"wt \" ends in a dot or space"),
            ("C:/x/nul", "\"nul\" is a reserved Windows device name"),
            (
                "C:/x/con.txt/y",
                "\"con.txt\" is a reserved Windows device name",
            ),
            ("C:/x/a\nb", "\"a\\nb\" contains a control character"),
        ];
        for (path, lead) in refused {
            let message = invalid_argument(refuse_ambiguous_worktree_path(path, true));
            assert!(message.starts_with(lead), "{path:?}: {message}");
            assert!(
                message.ends_with("choose another folder name."),
                "{message}"
            );
        }
        for path in ["C:/x/GitDesktop-pr-255", "C:/x/nully", "../wt", "C:/x/./wt"] {
            assert!(
                refuse_ambiguous_worktree_path(path, true).is_ok(),
                "{path:?}"
            );
        }
        for (path, _) in &refused[..4] {
            assert!(
                refuse_ambiguous_worktree_path(path, false).is_ok(),
                "{path:?}"
            );
        }
        assert!(refuse_ambiguous_worktree_path("/x/a\nb", false).is_err());
        assert!(refuse_ambiguous_worktree_path("/x/a\0b", false).is_err());
    }

    #[test]
    fn drive_relative_worktree_paths_are_refused_with_the_full_path_remedy() {
        for path in ["C:../main", "C:x", "C:", "c:.", "C:..", "C:x\\y"] {
            let message = invalid_argument(refuse_ambiguous_worktree_path(path, true));
            assert!(
                message.starts_with(&format!(
                    "\"{path}\" is relative to drive C:'s current folder"
                )),
                "{path:?}: {message}"
            );
            assert!(
                message.ends_with(
                    "use a full path like C:\\... or a path relative to the repository."
                ),
                "{message}"
            );
            assert!(
                refuse_ambiguous_worktree_path(path, false).is_ok(),
                "{path:?}"
            );
        }
        for path in ["C:/x", "C:\\x", "../x", "sub/x", "\\x", "/x", "ab:c", "1:x"] {
            assert!(
                refuse_ambiguous_worktree_path(path, true).is_ok(),
                "{path:?}"
            );
        }
    }

    /// The checkout UI reads every key off this error and sends `path` and `head`
    /// back on the forced retry, so the kind, the key spellings and their order are
    /// the contract.
    #[test]
    fn worktree_diverged_serializes_to_the_pinned_wire_shape() {
        let one = AppError::WorktreeDiverged {
            path: "C:/wt/GitDesktop-pr-255".to_string(),
            shown_path: "C:/wt/GitDesktop-pr-255".to_string(),
            head: "1111111111111111111111111111111111111111".to_string(),
            commits: vec![DivergedCommit {
                sha: "2222222222222222222222222222222222222222".to_string(),
                subject: "local work".to_string(),
            }],
            more: false,
            dirty: false,
            untracked: 0,
        };
        let wire = serde_json::to_string(&one).unwrap();
        assert_eq!(
            wire,
            r#"{"kind":"worktreeDiverged","message":"The worktree at C:/wt/GitDesktop-pr-255 has 1 commit that isn't on the pull request's branch.","path":"C:/wt/GitDesktop-pr-255","head":"1111111111111111111111111111111111111111","commits":[{"sha":"2222222222222222222222222222222222222222","subject":"local work"}],"more":false,"dirty":false,"untracked":0}"#
        );
        assert!(!wire.contains('_'), "{wire}");

        let many = AppError::WorktreeDiverged {
            path: "C:/wt/pr".to_string(),
            shown_path: "C:/wt/pr".to_string(),
            head: "1111111111111111111111111111111111111111".to_string(),
            commits: vec![
                DivergedCommit {
                    sha: "3333333333333333333333333333333333333333".to_string(),
                    subject: "newest".to_string(),
                },
                DivergedCommit {
                    sha: "2222222222222222222222222222222222222222".to_string(),
                    subject: "older".to_string(),
                },
            ],
            more: true,
            dirty: true,
            untracked: 3,
        };
        let wire = serde_json::to_string(&many).unwrap();
        assert_eq!(
            wire,
            r#"{"kind":"worktreeDiverged","message":"The worktree at C:/wt/pr has more than 20 commits that aren't on the pull request's branch. It also has uncommitted changes.","path":"C:/wt/pr","head":"1111111111111111111111111111111111111111","commits":[{"sha":"3333333333333333333333333333333333333333","subject":"newest"},{"sha":"2222222222222222222222222222222222222222","subject":"older"}],"more":true,"dirty":true,"untracked":3}"#
        );
        assert!(!wire.contains('_'), "{wire}");
    }

    #[test]
    fn diverged_message_counts_and_dirty_suffix() {
        let lead = "The worktree at C:/wt has";
        let tail = "on the pull request's branch.";
        let dirty = " It also has uncommitted changes.";
        for (count, more, n) in [
            (1, false, "1 commit that isn't"),
            (3, false, "3 commits that aren't"),
            (20, true, "more than 20 commits that aren't"),
        ] {
            assert_eq!(
                diverged_message("C:/wt", count, more, false),
                format!("{lead} {n} {tail}")
            );
            assert_eq!(
                diverged_message("C:/wt", count, more, true),
                format!("{lead} {n} {tail}{dirty}")
            );
        }
    }

    fn wt_entry(is_main: bool, branch: &str, head: &str, detached: bool) -> WtEntry {
        WtEntry {
            is_main,
            branch: branch.to_string(),
            head: head.to_string(),
            detached,
            path: "C:/wt/pr".to_string(),
        }
    }

    fn wt_probe(tip_local: bool, entry: Option<WtEntry>) -> WtProbe {
        WtProbe { tip_local, entry }
    }

    /// Only a fork PR refuses, and only for a linked worktree on the bare head, an
    /// ownerless fork (local == head) included: the PR's own `<owner>/<head>` worktree,
    /// the main checkout (its own refusal), a detached one and a same-repo PR all pass.
    #[test]
    fn own_branch_namesake_of_a_fork_head_is_refused() {
        let sha = "1111111111111111111111111111111111111111";
        let check = |entry: WtEntry, head: &str, local: &str, fork: bool| {
            refuse_own_head_namesake(Some(&entry), "C:/wt/x", head, local, fork)
        };
        let on = |branch: &str| wt_entry(false, branch, sha, false);
        // Owner-known fork, worktree on the bare head.
        assert_eq!(
            invalid_argument(check(on("main"), "main", "alice/main", true)),
            "C:/wt/x is on your own branch main, not the pull request's alice/main — pick a new folder."
        );
        // Ownerless fork: the local name is the bare head, and the identity is unknown.
        assert_eq!(
            invalid_argument(check(on("main"), "main", "main", true)),
            "C:/wt/x is on branch main, which may be your own: GitHub no longer names this pull request's fork, so its branch can't be told apart from yours — nothing was checked out."
        );
        // Same-repo PR on its own branch, and an owner-known fork on its prefixed one.
        assert!(check(on("main"), "main", "main", false).is_ok());
        assert!(check(on("alice/main"), "main", "alice/main", true).is_ok());
        assert!(check(on("other"), "main", "alice/main", true).is_ok());
        assert!(check(on("other"), "main", "main", true).is_ok());
        assert!(check(on("other"), "main", "main", false).is_ok());
        assert!(check(wt_entry(false, "", sha, true), "main", "main", true).is_ok());
        assert!(check(wt_entry(true, "main", sha, false), "main", "main", true).is_ok());
        assert!(refuse_own_head_namesake(None, "C:/wt/x", "main", "main", true).is_ok());
    }

    #[test]
    fn force_gate_refuses_non_worktrees_and_moved_heads() {
        let expected = "1111111111111111111111111111111111111111";
        let moved = "2222222222222222222222222222222222222222";
        let gate = |entry: Option<WtEntry>| {
            let probe = wt_probe(true, entry);
            match force_gate(&probe, expected, "feat") {
                ForceGate::NotAWorktree => "not-a-worktree".to_string(),
                ForceGate::Changed => "changed".to_string(),
                ForceGate::Moved(e) => format!("moved:{}", e.head),
                ForceGate::Proceed => "proceed".to_string(),
            }
        };
        assert_eq!(gate(None), "not-a-worktree");
        assert_eq!(
            gate(Some(wt_entry(true, "feat", expected, false))),
            "not-a-worktree"
        );
        assert_eq!(
            gate(Some(wt_entry(false, "", expected, true))),
            "not-a-worktree"
        );
        assert_eq!(
            gate(Some(wt_entry(false, "other", expected, false))),
            "changed"
        );
        assert_eq!(
            gate(Some(wt_entry(false, "other", moved, false))),
            "changed"
        );
        assert_eq!(
            gate(Some(wt_entry(false, "feat", moved, false))),
            format!("moved:{moved}")
        );
        assert_eq!(
            gate(Some(wt_entry(false, "feat", expected, false))),
            "proceed"
        );
    }

    /// The checkout names the local branch itself (`--branch`), so both spellings can
    /// exist at once and only the passed name is the PR's branch: a worktree on the
    /// other one is never offered a reset or a confirm list.
    #[test]
    fn on_pr_branch_matches_only_the_passed_local_name() {
        let e = |branch: &str| wt_entry(false, branch, "h", false);
        assert!(on_pr_branch(&e("alice/main"), "alice/main"));
        assert!(!on_pr_branch(&e("main"), "alice/main"));
        assert!(on_pr_branch(&e("main"), "main"));
        assert!(!on_pr_branch(&e("alice/main"), "main"));
        assert!(!on_pr_branch(&wt_entry(true, "feat", "h", false), "feat"));
        assert!(!on_pr_branch(&wt_entry(false, "feat", "h", true), "feat"));

        let expected = "1111111111111111111111111111111111111111";
        for (branch, verdict) in [("main", "changed"), ("alice/main", "proceed")] {
            let probe = wt_probe(true, Some(wt_entry(false, branch, expected, false)));
            let got = match force_gate(&probe, expected, "alice/main") {
                ForceGate::Changed => "changed",
                ForceGate::Proceed => "proceed",
                other => panic!("{other:?}"),
            };
            assert_eq!(got, verdict, "{branch}");
            assert_eq!(
                pre_spawn_candidate(&probe, "alice/main").is_some(),
                verdict == "proceed"
            );
        }
    }

    #[test]
    fn pre_and_post_spawn_candidates_need_tip_branch_and_progress() {
        let on_pr = || Some(wt_entry(false, "feat", "h", false));
        let main = || Some(wt_entry(true, "feat", "h", false));
        let other = || Some(wt_entry(false, "other", "h", false));

        assert!(pre_spawn_candidate(&wt_probe(true, on_pr()), "feat").is_some());
        assert!(pre_spawn_candidate(&wt_probe(false, on_pr()), "feat").is_none());
        assert!(pre_spawn_candidate(&wt_probe(true, None), "feat").is_none());
        assert!(pre_spawn_candidate(&wt_probe(true, main()), "feat").is_none());
        assert!(pre_spawn_candidate(&wt_probe(true, other()), "feat").is_none());

        let post =
            |pre: WtProbe, post: WtProbe| post_spawn_candidate(&pre, &post, "feat").is_some();
        // No progress: same tip state, same branch.
        assert!(!post(wt_probe(true, on_pr()), wt_probe(true, on_pr())));
        // The tip arrived.
        assert!(post(wt_probe(false, on_pr()), wt_probe(true, on_pr())));
        // The worktree was created, or switched onto the PR's branch.
        assert!(post(wt_probe(true, None), wt_probe(true, on_pr())));
        assert!(post(wt_probe(true, other()), wt_probe(true, on_pr())));
        // Progress alone is not enough.
        assert!(!post(wt_probe(false, None), wt_probe(true, main())));
        assert!(!post(wt_probe(false, None), wt_probe(true, other())));
        assert!(!post(wt_probe(true, None), wt_probe(false, on_pr())));
    }

    /// The non-force twin of force_gate's main-entry filter: gh would otherwise check
    /// the PR's branch out in the user's main checkout.
    #[test]
    fn main_worktree_is_refused_before_any_spawn() {
        assert_eq!(
            invalid_argument(refuse_main_worktree(
                Some(&wt_entry(true, "main", "h", false)),
                "C:/repo"
            )),
            "C:/repo is this repository's main checkout — pick a new folder, or the pull request's own worktree."
        );
        for entry in [
            None,
            Some(wt_entry(false, "other", "h", false)),
            Some(wt_entry(false, "", "h", true)),
            Some(wt_entry(false, "feat", "h", false)),
        ] {
            assert!(refuse_main_worktree(entry.as_ref(), "C:/wt").is_ok());
        }
    }

    #[test]
    fn same_wt_path_ignores_separator_case_and_trailing_slash() {
        // `\` is a separator only on Windows.
        let windows = cfg!(windows);
        assert_eq!(same_wt_path("C:\\Repos\\WT", "c:/repos/wt"), windows);
        assert!(same_wt_path("C:/repos/wt/", "C:/repos/wt"));
        assert_eq!(same_wt_path("C:/repos/wt\\", "c:/Repos/wt"), windows);
        assert!(!same_wt_path("C:/repos/wt", "C:/repos/wt2"));
        assert!(!same_wt_path("C:/repos/wt", "C:/repos"));
    }

    /// Only line terminators come off a printed path; spaces are part of its name.
    #[test]
    fn stdout_path_trims_only_the_line_terminator() {
        assert_eq!(stdout_path("/tmp/project \n"), "/tmp/project ");
        assert_eq!(stdout_path("C:/repo\r\n"), "C:/repo");
        assert_eq!(stdout_path(" /lead"), " /lead");
        assert_eq!(stdout_path("/a/b"), "/a/b");
    }

    /// Every platform's arm on every platform: (windows, fold_case) for Windows, macOS
    /// and other POSIX. Backslashes fold only on Windows, case on Windows and macOS.
    #[test]
    fn same_wt_spelling_folds_case_only_when_asked() {
        let (win, mac, posix) = ((true, true), (false, true), (false, false));
        let rows: [(&str, &str, [bool; 3]); 5] = [
            ("/tmp/wt/", "/tmp/wt", [true, true, true]),
            ("/tmp/review", "/tmp/review2", [false, false, false]),
            ("/tmp/Review", "/tmp/review", [true, true, false]),
            ("/tmp/review\\one", "/tmp/review/one", [true, false, false]),
            ("C:\\repos\\wt\\", "C:/repos/wt", [true, false, false]),
        ];
        for (a, b, want) in rows {
            for ((windows, fold), want) in [win, mac, posix].into_iter().zip(want) {
                assert_eq!(
                    same_wt_spelling(a, b, windows, fold),
                    want,
                    "{a} vs {b}, windows {windows}, fold {fold}"
                );
            }
        }
    }

    /// A differently-cased target matches the registered worktree exactly when the
    /// volume makes it the same folder (macOS default APFS), and is a new folder on a
    /// case-sensitive one (Linux, case-sensitive APFS).
    #[cfg(unix)]
    #[tokio::test]
    async fn registry_case_match_follows_the_volume() {
        let (base, repo) = setup_repo("case-exact").await;
        let review = base.path().join("review").to_string_lossy().into_owned();
        let upper = base.path().join("Review").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "-b", "rv", &review, "HEAD"]).await;
        assert!(registered_worktree(&repo, &review).await.unwrap().is_some());
        let folds = std::path::Path::new(&upper).exists();
        let hit = registered_worktree(&repo, &upper).await.unwrap();
        assert_eq!(hit.is_some(), folds, "volume folds case: {folds}");
    }

    /// The match logic over an injected filesystem answer, on every platform: Windows
    /// folds spelling; elsewhere a case-only difference needs the same directory.
    #[test]
    fn case_only_matches_need_the_filesystem_off_windows() {
        let (yes, no) = (|_: &str, _: &str| true, |_: &str, _: &str| false);
        assert!(wt_paths_match("C:\\Repos\\WT", "c:/repos/wt", true, no));
        assert!(wt_paths_match("/r/wt/", "/r/wt", false, no));
        assert!(!wt_paths_match("/r/Review", "/r/review", false, no));
        assert!(wt_paths_match("/r/Review", "/r/review", false, yes));
        assert!(!wt_paths_match(
            "/r/review\\one",
            "/r/review/one",
            false,
            no
        ));
    }

    #[tokio::test]
    async fn add_user_refuses_ambiguous_windows_paths() {
        let (base, repo) = setup_repo("ambiguous-path").await;
        let root = base.path().to_string_lossy().into_owned();
        let mut paths = vec![format!("{root}/a\nb")];
        if cfg!(windows) {
            paths.push(format!("{root}/wt."));
            paths.push(format!("{root}/nul"));
            paths.push(format!("{root}/con.txt/wt"));
        }
        for path in paths {
            let expected = refuse_ambiguous_worktree_path(&path, cfg!(windows))
                .unwrap_err()
                .to_string();
            let result =
                git_worktree_add_user_core(&AppState::default(), &repo, &path, "feat", true, None)
                    .await;
            assert!(
                matches!(&result, Err(e @ AppError::InvalidArgument(_)) if e.to_string() == expected),
                "{path:?}: {result:?}"
            );
        }
        assert!(run(&repo, &["branch", "--list", "feat"])
            .await
            .trim()
            .is_empty());
    }

    #[tokio::test]
    async fn divergence_probe_reads_a_real_linked_worktree() {
        let (base, repo) = setup_repo("divergence").await;
        std::fs::write(std::path::Path::new(&repo).join("b.txt"), "t\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "T"]).await;
        let t = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        let parent = run(&repo, &["rev-parse", "HEAD^"]).await.trim().to_string();
        let wt = base.path().join("wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "-b", "feat", &wt_s, &t]).await;

        // Equal, behind-only and ahead-only all fast-forward or are up to date.
        assert_eq!(diverged_from(&repo, &t, &t).await.unwrap(), None);
        run(&wt_s, &["reset", "-q", "--hard", &parent]).await;
        assert_eq!(diverged_from(&repo, &parent, &t).await.unwrap(), None);
        run(&wt_s, &["reset", "-q", "--hard", &t]).await;
        for i in 1..=21 {
            run(
                &wt_s,
                &["commit", "-q", "--allow-empty", "-m", &format!("local {i}")],
            )
            .await;
        }
        let ahead = run(&wt_s, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert_eq!(diverged_from(&repo, &ahead, &t).await.unwrap(), None);

        // A sibling of T off its parent that adds c.txt: neither side contains the other.
        run(&repo, &["checkout", "-q", "-b", "side", &parent]).await;
        std::fs::write(std::path::Path::new(&repo).join("c.txt"), "s\n").unwrap();
        run(&repo, &["add", "c.txt"]).await;
        run(&repo, &["commit", "-qm", "sibling"]).await;
        let sibling = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        let (commits, more) = diverged_from(&repo, &ahead, &sibling)
            .await
            .unwrap()
            .unwrap();
        assert!(more);
        assert_eq!(commits.len(), 20);
        assert_eq!(commits[0].sha, ahead);
        assert_eq!(commits[0].subject, "local 21");
        assert_eq!(commits[19].subject, "local 2");

        assert!(!worktree_dirty(&wt_s).await.unwrap());
        std::fs::write(wt.join("untracked.txt"), "u\n").unwrap();
        assert!(
            !worktree_dirty(&wt_s).await.unwrap(),
            "-uno leaves untracked out"
        );
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        assert!(worktree_dirty(&wt_s).await.unwrap());

        // Only an untracked path the target tracks is one reset --hard overwrites.
        assert_eq!(
            untracked_collisions(&repo, &wt_s, &sibling).await.unwrap(),
            0
        );
        std::fs::write(wt.join("c.txt"), "mine\n").unwrap();
        assert_eq!(
            untracked_collisions(&repo, &wt_s, &sibling).await.unwrap(),
            1
        );
        assert_eq!(untracked_collisions(&repo, &wt_s, &t).await.unwrap(), 0);

        let probe = probe_worktree(&repo, &wt_s, Some(&t)).await.unwrap();
        assert!(probe.tip_local);
        let entry = probe.entry.expect("the linked worktree is found");
        assert!(!entry.is_main && !entry.detached);
        assert_eq!(entry.branch, "feat");
        assert_eq!(entry.head, ahead);
        assert_eq!(
            std::fs::canonicalize(&entry.path).unwrap(),
            std::fs::canonicalize(&wt).unwrap()
        );

        let absent = "0123456789abcdef0123456789abcdef01234567";
        let probe = probe_worktree(&repo, &repo, Some(absent)).await.unwrap();
        assert!(!probe.tip_local);
        assert!(probe.entry.expect("the repo root is listed").is_main);
        // The main worktree is never a candidate, even with the tip local.
        let probe = probe_worktree(&repo, &repo, Some(&t)).await.unwrap();
        assert!(probe.tip_local);
        assert!(pre_spawn_candidate(&probe, "master").is_none());
        assert!(pre_spawn_candidate(&probe, "main").is_none());
        assert!(refuse_main_worktree(probe.entry.as_ref(), &repo).is_err());
        let linked = probe_worktree(&repo, &wt_s, None).await.unwrap();
        assert!(refuse_main_worktree(linked.entry.as_ref(), &wt_s).is_ok());

        let relative = resolve_worktree_path(&repo, "../wt");
        let probe = probe_worktree(&repo, &relative, None).await.unwrap();
        assert!(!probe.tip_local);
        assert_eq!(probe.entry.map(|e| e.branch).as_deref(), Some("feat"));

        // The command's pre-spawn gate over the same fixture: each refusal it owns.
        let oid = Some(sibling.as_str());
        let sync = || CheckoutMode::Sync;
        assert_eq!(
            invalid_argument(checkout_pre_spawn_gate(&repo, &repo, &repo, oid, "feat", "feat", false, sync()).await),
            format!("{repo} is this repository's main checkout — pick a new folder, or the pull request's own worktree.")
        );
        // A same-repo PR on its own branch's worktree keeps the divergence flow.
        match checkout_pre_spawn_gate(&repo, "wt-echo", &wt_s, oid, "feat", "feat", false, sync())
            .await
        {
            Err(AppError::WorktreeDiverged {
                path,
                shown_path,
                head,
                commits,
                more,
                dirty,
                untracked,
            }) => {
                assert_eq!((path.as_str(), head.as_str()), ("wt-echo", ahead.as_str()));
                assert_eq!(shown_path, entry.path);
                assert_eq!(commits.len(), 20);
                assert!(more && dirty);
                assert_eq!(untracked, 1);
            }
            other => panic!("{other:?}"),
        }
        // A fork PR whose bare head names the worktree's own branch: gh would switch
        // the user's branch to the fork's, so the gate refuses.
        assert_eq!(
            invalid_argument(
                checkout_pre_spawn_gate(
                    &repo,
                    "wt",
                    &wt_s,
                    oid,
                    "feat",
                    "alice/feat",
                    true,
                    sync()
                )
                .await
            ),
            "wt is on your own branch feat, not the pull request's alice/feat — pick a new folder."
        );
        // An ownerless fork's local name is the bare head, so only `fork` can refuse it.
        assert!(invalid_argument(
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "feat", "feat", true, sync()).await
        )
        .starts_with("wt is on branch feat, which may be your own"));
        // A fork whose local name is the worktree's branch keeps the divergence flow:
        // the refusal keys on the bare head, never the local name.
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "x", "feat", true, sync()).await;
        assert!(
            matches!(gate, Err(AppError::WorktreeDiverged { .. })),
            "{gate:?}"
        );
        // A worktree on another name than the PR's local branch, same-repo or fork:
        // nothing is provable, so gh decides.
        for (head, local, fork) in [
            ("other", "other", false),
            ("other", "alice/other", true),
            ("other", "other", true),
        ] {
            let pre = checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, head, local, fork, sync())
                .await
                .unwrap();
            assert_eq!(
                pre.and_then(|p| p.entry).map(|e| e.branch).as_deref(),
                Some("feat")
            );
        }
        let fresh = base.path().join("new-wt").to_string_lossy().into_owned();
        let pre =
            checkout_pre_spawn_gate(&repo, &fresh, &fresh, oid, "feat", "feat", false, sync())
                .await
                .unwrap();
        assert!(pre.is_some_and(|p| p.tip_local && p.entry.is_none()));

        // A failed registry read fails closed: from a linked worktree, gh would
        // switch whatever checkout the path names, the main one included.
        let missing = base.path().join("missing").to_string_lossy().into_owned();
        assert_eq!(
            invalid_argument(
                checkout_pre_spawn_gate(
                    &missing,
                    "root",
                    &repo,
                    oid,
                    "feat",
                    "feat",
                    false,
                    sync()
                )
                .await
            ),
            "Couldn't check the worktree at root — try again."
        );
        // A failed tip probe (git exits 128 on a reflog entry that doesn't exist)
        // still runs the registry refusals, then proceeds unclassified.
        let bad_tip = Some("HEAD@{99}");
        assert!(tip_is_local(&repo, "HEAD@{99}").await.is_err());
        assert!(invalid_argument(
            checkout_pre_spawn_gate(&repo, "root", &repo, bad_tip, "feat", "feat", false, sync())
                .await
        )
        .starts_with("root is this repository's main checkout"));
        assert!(invalid_argument(
            checkout_pre_spawn_gate(
                &repo,
                "wt",
                &wt_s,
                bad_tip,
                "feat",
                "alice/feat",
                true,
                sync()
            )
            .await
        )
        .starts_with("wt is on your own branch feat"));
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, bad_tip, "feat", "feat", false, sync())
                .await;
        assert!(matches!(gate, Ok(None)), "{gate:?}");

        let proceed = CheckoutMode::Force { expected: &ahead };
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "feat", "feat", false, proceed).await;
        assert!(matches!(gate, Ok(None)), "{gate:?}");
        // A forced reset never lands on an ownerless fork's namesake either.
        let ownerless = CheckoutMode::Force { expected: &ahead };
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "feat", "feat", true, ownerless).await;
        assert!(invalid_argument(gate).starts_with("wt is on branch feat, which may be your own"));
        let moved = CheckoutMode::Force { expected: &t };
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "feat", "feat", false, moved).await;
        assert!(
            matches!(&gate, Err(AppError::WorktreeDiverged { head, .. }) if *head == ahead),
            "{gate:?}"
        );
        let other = CheckoutMode::Force { expected: &ahead };
        let gate =
            checkout_pre_spawn_gate(&repo, "wt", &wt_s, oid, "feat", "alice/feat", true, other)
                .await;
        assert!(
            invalid_argument(gate).starts_with("The worktree at wt changed since you confirmed")
        );
        let main = CheckoutMode::Force { expected: &ahead };
        let gate =
            checkout_pre_spawn_gate(&repo, "root", &repo, oid, "side", "side", false, main).await;
        assert!(invalid_argument(gate).starts_with("Only an existing worktree of this repository"));
    }

    /// An ownerless fork refuses every target while a branch of the bare head's name
    /// exists (gh would fast-forward it), and a failed probe refuses too; owner-prefixed
    /// and same-repo PRs proceed onto an existing branch.
    #[tokio::test]
    async fn ownerless_fork_refuses_every_target_while_its_bare_branch_exists() {
        let (base, repo) = setup_repo("ownerless-branch").await;
        run(&repo, &["branch", "mine"]).await;
        run(&repo, &["branch", "alice/mine"]).await;
        let path = |name: &str| base.path().join(name).to_string_lossy().into_owned();
        let (fresh, other, named) = (path("fresh"), path("other-wt"), path("mine-wt"));
        run(&repo, &["worktree", "add", "-q", "-b", "other", &other]).await;
        run(&repo, &["worktree", "add", "-q", &named, "mine"]).await;
        let gate = |target: &str, head: &'static str, local: &'static str, fork: bool| {
            let (repo, target) = (repo.clone(), target.to_string());
            async move {
                checkout_pre_spawn_gate(
                    &repo,
                    "wt",
                    &target,
                    None,
                    head,
                    local,
                    fork,
                    CheckoutMode::Sync,
                )
                .await
            }
        };
        let exists = "A branch named mine already exists and may be your own: GitHub no longer names this pull request's fork, so its branch can't be told apart from yours — nothing was checked out.";
        // A new folder, and a linked worktree on another branch (gh would check the
        // branch out there and fast-forward it).
        for target in [&fresh, &other] {
            assert_eq!(
                invalid_argument(gate(target, "mine", "mine", true).await),
                exists,
                "{target}"
            );
        }
        // A case variant counts: a case-insensitive filesystem aliases the two.
        run(&repo, &["branch", "Upper"]).await;
        assert!(invalid_argument(gate(&fresh, "upper", "upper", true).await)
            .starts_with("A branch named upper already exists"));
        // A worktree on the bare head: its own refusal, which names the folder, speaks first.
        assert!(invalid_argument(gate(&named, "mine", "mine", true).await)
            .starts_with("wt is on branch mine, which may be your own"));
        for (target, head, local, fork) in [
            (&fresh, "ghost", "ghost", true),
            (&other, "ghost", "ghost", true),
            (&fresh, "mine", "alice/mine", true),
            (&other, "mine", "alice/mine", true),
            (&fresh, "mine", "mine", false),
        ] {
            let result = gate(target, head, local, fork).await;
            assert!(
                matches!(result, Ok(None)),
                "{target} {head} {local} {fork}: {result:?}"
            );
        }
        let missing = path("missing");
        assert_eq!(
            invalid_argument(
                refuse_ownerless_branch_namesake(&missing, "mine", "mine", true).await
            ),
            "Couldn't check whether a branch named mine already exists — try again."
        );
    }
}
