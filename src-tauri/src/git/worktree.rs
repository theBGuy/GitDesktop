//! Throwaway `git worktree`s for agent sessions: every write-capable agent run
//! happens in an isolated branch checkout OUTSIDE the repo, so the user's working
//! tree, index, and current branch are never touched no matter what the agent does.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    acquire_repo_lock_unbounded, run_git, run_git_raw, run_git_worktree_admin,
    try_acquire_repo_lock, DEFAULT_HOLDER, DEFAULT_TIMEOUT, WORKTREE_OP_TIMEOUT,
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
/// worktrees. Lower-cased first since Windows paths are case-insensitive.
fn repo_hash(repo_path: &str) -> String {
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
    let id = new_session_id();
    let branch = format!("gd/session/{id}");
    let root = worktree_root(&app, &repo_path)?;
    std::fs::create_dir_all(&root)?;
    let path = root.join(&id);
    let path_str = path.to_string_lossy().into_owned();
    let base = base_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    run_git_worktree_admin(
        &state,
        &repo_path,
        &["worktree", "add", "-b", &branch, &path_str, base],
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
/// `true` when the prune ran.
pub(crate) async fn prune_worktrees_if_free(state: &AppState, repo_path: &str) -> bool {
    let domain = state.worktree_admin_lock(repo_path).await;
    let Some(_guard) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return false;
    };
    let _ = run_git(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
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
#[tauri::command]
pub async fn git_worktree_list_user(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> AppResult<Vec<UserWorktree>> {
    prune_worktrees_if_free(&state, &repo_path).await;
    let out = run_git(
        Some(&repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let raw = parse_worktree_porcelain(&out.stdout_lossy());

    // Authoritative exclusion: the sessions registry's owned worktree paths.
    let session_paths = crate::sessions::session_worktree_paths(&app);
    // Defense-in-depth: anything under the app-data worktrees root.
    let app_data_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| normalize_wt_path(&d.join("worktrees").to_string_lossy()));

    let user = raw
        .into_iter()
        .enumerate()
        .filter(|(_, w)| !w.prunable)
        // The main worktree (index 0) is never a session worktree; keep it
        // unconditionally so the user can always switch back to it.
        .filter(|(i, w)| {
            *i == 0 || !is_session_worktree(w, &session_paths, app_data_root.as_deref())
        })
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
    // `gd/session/*` is reserved for agent sessions, which the manager hides — a
    // user worktree on such a branch would be created and then vanish from view.
    if branch.starts_with("gd/session/") {
        return Err(AppError::InvalidArgument(
            "the gd/session/ prefix is reserved for agent sessions".into(),
        ));
    }
    if std::path::Path::new(path).exists() {
        return Err(AppError::InvalidArgument(format!(
            "{path} already exists — choose a new folder"
        )));
    }
    let base = base_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("HEAD");
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if new_branch {
        args.extend_from_slice(&["-b", branch, path, base]);
    } else {
        args.extend_from_slice(&[path, branch]);
    }
    run_git_worktree_admin(&state, &repo_path, &args, WORKTREE_OP_TIMEOUT).await?;
    Ok(())
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
    let resolved = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string());
    normalize_wt_path(resolved.strip_prefix(r"\\?\").unwrap_or(&resolved))
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
) -> AppResult<()> {
    remove_worktree(&state, &repo_path, &path, branch, force).await
}

/// The body of `git_worktree_remove`, callable without a Tauri `State`.
pub(crate) async fn remove_worktree(
    state: &AppState,
    repo_path: &str,
    path: &str,
    branch: Option<String>,
    force: bool,
) -> AppResult<()> {
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
    // server) anyway. An unreadable tip counts as absent, so the delete is skipped.
    let branch = branch.as_deref().filter(|b| !b.is_empty());
    let expected_tip = match branch {
        Some(b) => branch_tip(repo_path, b).await,
        None => None,
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
    if let (Some(branch), Some(expected_tip)) = (branch, expected_tip.as_deref()) {
        delete_branch_if_unmoved(repo_path, branch, expected_tip).await;
    }
    Ok(())
}

/// The commit `refs/heads/<branch>` points at. `None` when the branch is gone or
/// the read fails — callers treat both as "don't touch it".
///
/// Fully qualified: bare `rev-parse <name>` resolves a same-named TAG first, which
/// would compare a tag's tip against a branch delete. The name is IPC-supplied and
/// validated here, so an invalid name skips the whole delete rather than reaching
/// this template or the `branch -D` argv downstream.
async fn branch_tip(repo_path: &str, branch: &str) -> Option<String> {
    crate::git::branches::validate_ref_name(branch).ok()?;
    let out = run_git_raw(
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
    .ok()?;
    (out.code == 0)
        .then(|| out.stdout_lossy().trim().to_string())
        .filter(|tip| !tip.is_empty())
}

/// Deletes `branch` ONLY IF its tip is still `expected_tip` — a commit that landed
/// on it since would otherwise be discarded by a `-D` decided before it existed.
/// A moved or unreadable tip skips silently; the delete stays best-effort, since a
/// refusal must never turn a completed removal into a reported failure.
async fn delete_branch_if_unmoved(repo_path: &str, branch: &str, expected_tip: &str) {
    if branch_tip(repo_path, branch).await.as_deref() != Some(expected_tip) {
        return;
    }
    let _ = run_git(Some(repo_path), &["branch", "-D", branch], DEFAULT_TIMEOUT).await;
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
    let _guard = acquire_repo_lock_unbounded(&domain, DEFAULT_HOLDER).await;

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
    let _guard = acquire_repo_lock_unbounded(&domain, DEFAULT_HOLDER).await;

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

/// The target of a linked worktree's `.git` pointer file (`gitdir: <path>`).
/// The recorded path may be relative to the worktree, so callers resolve it.
fn parse_gitdir_pointer(content: &str) -> Option<&str> {
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
}

/// A file's mtime as epoch ms, or `None` when it is unreadable.
fn file_mtime_ms(path: &std::path::Path) -> Option<i64> {
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
fn worktree_last_activity_ms(worktree_path: &str) -> Option<i64> {
    let root = std::path::Path::new(worktree_path);
    let dotgit = root.join(".git");
    // `git::ops::marker_dir` resolves the same `.git`-dir-or-pointer question for
    // op markers, so a change to either resolution rule has to land in both until
    // they are hoisted into one shared helper.
    let admin = match std::fs::metadata(&dotgit) {
        Ok(meta) if meta.is_dir() => dotgit,
        // A linked worktree's `.git` is a pointer to `<repo>/.git/worktrees/<id>`,
        // recorded relative under `worktree.useRelativePaths` — joining on the
        // tree resolves that and leaves an absolute pointer untouched.
        Ok(_) => {
            let pointer = std::fs::read_to_string(&dotgit).ok()?;
            root.join(parse_gitdir_pointer(&pointer)?)
        }
        Err(_) => return None,
    };
    file_mtime_ms(&admin.join("index")).or_else(|| file_mtime_ms(&admin.join("HEAD")))
}

/// Parses `git worktree list --porcelain` into one `WorktreeInfo` per stanza.
/// Stanzas are blank-line separated; each carries a `worktree <path>` line and
/// (unless detached) a `branch refs/heads/<name>` line.
fn parse_worktree_list(porcelain: &str) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut branch = String::new();
    let flush = |path: &mut Option<String>, branch: &mut String, out: &mut Vec<WorktreeInfo>| {
        if let Some(p) = path.take() {
            let id = std::path::Path::new(&p)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(WorktreeInfo {
                id,
                path: p,
                branch: std::mem::take(branch),
                base: String::new(),
            });
        }
    };
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut out);
            path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        }
    }
    flush(&mut path, &mut branch, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    // The module itself no longer calls the working-tree runner — the interleave
    // tests below drive it as an ordinary caller would.
    use crate::git::runner::run_git_mutating;

    #[test]
    fn repo_hash_is_stable_and_case_insensitive() {
        assert_eq!(repo_hash("C:/Repos/App"), repo_hash("c:/repos/app"));
        assert_ne!(repo_hash("C:/Repos/App"), repo_hash("C:/Repos/Other"));
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

        // 4) an ordinary user worktree is NOT excluded
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
            &["worktree", "add", "-b", "gd/session/test", &wt_s, "HEAD"],
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
            &["worktree", "add", "-b", "gd/session/keep", &wt_s, "HEAD"],
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
        remove_worktree(&state, &repo_s, &wt_s, None, true)
            .await
            .expect("forced removal of a locked worktree succeeds");

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

        remove_worktree(&state, &repo_s, &wt_s, Some("feat-busy".into()), false)
            .await
            .expect("a removal must not wait on the working-tree domain");
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

    /// The branch delete is now gated on the tip, not on a whole-repo hold: an
    /// unmoved branch goes, one that gained a commit since stays.
    #[tokio::test]
    async fn delete_branch_if_unmoved_spares_a_branch_that_moved() {
        let (base, repo_s) = setup_repo("tip-gate").await;
        let repo_dir = base.path().join("repo");
        run(&repo_s, &["branch", "unmoved"]).await;
        run(&repo_s, &["branch", "moved"]).await;
        let tip = branch_tip(&repo_s, "moved")
            .await
            .expect("a fresh branch has a tip");

        // The branch gains a commit after the tip was recorded.
        run(&repo_s, &["switch", "-q", "moved"]).await;
        std::fs::write(repo_dir.join("later.txt"), "later\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "landed after the snapshot"]).await;
        run(&repo_s, &["switch", "-q", "-"]).await;

        delete_branch_if_unmoved(&repo_s, "moved", &tip).await;
        assert!(
            !run(&repo_s, &["branch", "--list", "moved"])
                .await
                .trim()
                .is_empty(),
            "a branch that moved since the snapshot must survive"
        );

        let unmoved_tip = branch_tip(&repo_s, "unmoved").await.unwrap();
        delete_branch_if_unmoved(&repo_s, "unmoved", &unmoved_tip).await;
        assert!(
            run(&repo_s, &["branch", "--list", "unmoved"])
                .await
                .trim()
                .is_empty(),
            "an unmoved branch is deleted"
        );

        // A branch that never existed is a no-op, not a panic.
        delete_branch_if_unmoved(&repo_s, "never-existed", &unmoved_tip).await;
    }

    /// git's own refusal is the third guard: a branch still checked out in a
    /// worktree survives even at its recorded tip.
    #[tokio::test]
    async fn delete_branch_if_unmoved_defers_to_gits_checkout_refusal() {
        let (base, repo_s) = setup_repo("tip-gate-checked-out").await;
        let wt = base.path().join("live-wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-b", "feat-live", &wt_s, "HEAD"]).await;
        let tip = branch_tip(&repo_s, "feat-live").await.unwrap();

        delete_branch_if_unmoved(&repo_s, "feat-live", &tip).await;
        assert!(
            !run(&repo_s, &["branch", "--list", "feat-live"])
                .await
                .trim()
                .is_empty(),
            "git refuses to delete a branch checked out in a worktree"
        );
    }
}
