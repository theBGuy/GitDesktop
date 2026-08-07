//! Throwaway `git worktree`s for agent sessions: every write-capable agent run
//! happens in an isolated branch checkout OUTSIDE the repo, so the user's working
//! tree, index, and current branch are never touched no matter what the agent does.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating, run_git_raw, DEFAULT_TIMEOUT};
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
}

/// Normalizes a worktree path for cross-source comparison: git prints forward
/// slashes while the app stores native separators (back-slashes on Windows), and
/// Windows paths are case-insensitive. Lower-casing is harmless on Unix here — the
/// only paths compared are app-generated session dirs vs. git's own output.
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
    run_git_mutating(
        &state,
        &repo_path,
        &["worktree", "add", "-b", &branch, &path_str, base],
        DEFAULT_TIMEOUT,
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

/// Lists the repo's **user** worktrees for the worktree manager — every checkout
/// except the app-internal agent-session ones; the main worktree is always first
/// and undeletable. Prunes first so stale admin entries (directory deleted
/// out-of-band) self-heal — such an entry also holds a branch lock, and it's
/// filtered from the list, so the manager could never clear it otherwise. Git never
/// prunes a *locked* worktree, so one on a temporarily-disconnected drive is safe if
/// the user locked it.
#[tauri::command]
pub async fn git_worktree_list_user(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
) -> AppResult<Vec<UserWorktree>> {
    let _ = run_git_mutating(&state, &repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
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
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
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
    run_git_mutating(
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
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
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
    run_git_mutating(
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
    run_git_mutating(
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
fn canonical_wt_path(p: &str) -> String {
    let resolved = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| p.to_string());
    normalize_wt_path(resolved.strip_prefix(r"\\?\").unwrap_or(&resolved))
}

/// Whether git still lists `path` as one of the repo's worktrees. An unreadable
/// registry answers `true`: the caller uses this to decide whether deleting the
/// folder is safe, and uncertainty must never authorize a delete.
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
                .any(|w| canonical_wt_path(&w.path) == target)
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
    // `git worktree remove` deletes the directory itself, but its recursive delete
    // mishandles Windows reparse points: a worktree with pnpm-installed deps
    // (`node_modules/*` junctioned into `.pnpm/`) fails with `failed to delete
    // '<path>': Invalid argument`, half-removed. Finish it ourselves —
    // `std::fs::remove_dir_all` deletes reparse points as links (hardened since Rust
    // 1.63) — then `prune` to reconcile git's dangling admin entry.
    if let Err(git_err) = run_git_mutating(state, repo_path, &args, DEFAULT_TIMEOUT).await {
        // git drops `.git/worktrees/<id>` BEFORE deleting the directory, so a still-
        // registered path means git refused as policy (dirty, locked, main worktree) —
        // surface that error, which the frontend reads to offer the forced retry.
        // Finishing the delete is only sound once the entry is gone; an unreadable
        // registry counts as registered, so a folder is never deleted on a guess.
        if worktree_is_registered(repo_path, path).await {
            return Err(git_err);
        }
        match std::fs::remove_dir_all(path) {
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
        let _ = run_git_mutating(state, repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    }
    // The branch can only be deleted once it's no longer checked out (i.e. after
    // the worktree is gone). Best-effort: a failure here shouldn't fail removal.
    if let Some(branch) = branch.as_deref().filter(|b| !b.is_empty()) {
        let _ = run_git_mutating(state, repo_path, &["branch", "-D", branch], DEFAULT_TIMEOUT).await;
    }
    Ok(())
}

/// Prunes stale worktree admin entries (a worktree whose directory was deleted
/// out from under git, e.g. by an app crash). Safe to run on startup.
#[tauri::command]
pub async fn git_worktree_prune(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    run_git_mutating(&state, &repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await?;
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
    let status = run_git(
        Some(&worktree_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if status.stdout_lossy().trim().is_empty() {
        return Ok(None);
    }
    run_git_mutating(&state, &worktree_path, &["add", "-A"], DEFAULT_TIMEOUT).await?;
    run_git_mutating(
        &state,
        &worktree_path,
        &["commit", "-m", &message],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let head = run_git(
        Some(&worktree_path),
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
    let head = run_git(
        Some(&worktree_path),
        &["rev-parse", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if head.stdout_lossy().trim() == base.trim() {
        return Ok(false);
    }
    run_git_mutating(
        &state,
        &worktree_path,
        &["reset", "--soft", &base],
        DEFAULT_TIMEOUT,
    )
    .await?;
    run_git_mutating(
        &state,
        &worktree_path,
        &["commit", "-m", &message],
        DEFAULT_TIMEOUT,
    )
    .await?;
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
    let _ = run_git_mutating(&state, &repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    run_git_mutating(
        &state,
        &repo_path,
        &["worktree", "add", &path, &branch],
        DEFAULT_TIMEOUT,
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
}
