use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::diff::parse_numstat_z;
use crate::git::history::validate_hash;
use crate::git::runner::{
    acquire_repo_lock, run_git, run_git_mutating, run_git_mutating_raw, run_git_raw,
    run_git_raw_input, run_git_worktree_admin, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT,
    WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{FileDiff, RepoOpState, RewriteStep, StashEntry, TagInfo};
use crate::state::AppState;

/// Refuses when the working tree has **tracked** changes (staged or unstaged).
///
/// Compound ops whose failure path does `reset --hard` (local-PR merge,
/// cherry-pick-onto) MUST call this before their first mutation: a protective
/// `switch <target>` is a no-op when target IS the current branch, so a dirty
/// tree would otherwise flow into the destructive reset. Untracked files are
/// deliberately allowed — `reset --hard` never removes them, and a merge that
/// would clobber one is refused by git itself.
async fn ensure_clean_tree(repo: &str) -> AppResult<()> {
    let status = run_git(
        Some(repo),
        &["status", "--porcelain", "--untracked-files=no"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }
    Ok(())
}

/// Resolves a path inside .git (worktree-safe via --git-path) to an absolute one.
async fn git_dir_path(repo: &str, name: &str) -> Option<std::path::PathBuf> {
    let out = run_git(
        Some(repo),
        &["rev-parse", "--git-path", name],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let raw = out.stdout_lossy();
    let p = Path::new(raw.trim());
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(repo).join(p)
    })
}

/// Whether a file/dir inside .git exists (worktree-safe via --git-path).
async fn git_path_exists(repo: &str, name: &str) -> bool {
    match git_dir_path(repo, name).await {
        Some(path) => path.exists(),
        None => false,
    }
}

/// The repo's OWN git dir, absolute — one spawn, so [`op_state`]'s eight marker
/// probes become plain filesystem reads instead of eight `rev-parse` children.
///
/// `--absolute-git-dir`, never `--git-common-dir`: a linked worktree keeps its
/// op markers (`MERGE_HEAD`, `rebase-merge`, the sequencer) under
/// `<main>/.git/worktrees/<name>/`, and the common dir names the MAIN checkout's
/// `.git` — reading markers there would report the wrong tree's operation
/// (measured, git 2.51.1; same call as `git::stats`). `None` for anything that
/// isn't a repo, which callers must read as "no operation", not as an error.
async fn absolute_git_dir(repo: &str) -> Option<std::path::PathBuf> {
    let out = run_git(
        Some(repo),
        &["rev-parse", "--absolute-git-dir"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let raw = out.stdout_lossy();
    // Line endings ONLY: a trailing space can be part of the directory name, and
    // `trim()` would strip it into a path that does not exist.
    let dir = raw.trim_end_matches(['\r', '\n']);
    (!dir.is_empty()).then(|| std::path::PathBuf::from(dir))
}

/// The target of a linked worktree's or submodule's `.git` pointer file
/// (`gitdir: <path>`). The recorded path may be relative to the tree holding that
/// file, so callers resolve it. Line-scanned rather than whole-content-trimmed, which
/// keeps a pointer carrying stray leading lines readable.
pub(crate) fn parse_gitdir_pointer(content: &str) -> Option<&str> {
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
}

/// The admin dir behind a tree's `.git`, resolved without spawning git — for the
/// paths that pay this on EVERY commit, or while holding a lock, and must not grow a
/// `rev-parse` child for it. `None` for anything unreadable, which callers read as an
/// absence ("no markers", "no activity"), never as an error.
///
/// A linked worktree or submodule replaces `.git` with a one-line `gitdir:` pointer
/// to the dir holding ITS state, and that path may be relative to the tree holding
/// the `.git` file — always for a submodule (`gitdir: ../.git/modules/<name>`), and
/// for a worktree under `worktree.useRelativePaths` / `--relative-paths`
/// (`gitdir: ../<main>/.git/worktrees/<name>`); measured, git 2.51.1. Joining on the
/// tree root resolves those and leaves an absolute pointer untouched.
pub(crate) fn resolve_git_admin_dir(tree_root: &Path) -> Option<std::path::PathBuf> {
    let dot_git = tree_root.join(".git");
    match std::fs::metadata(&dot_git) {
        Ok(meta) if meta.is_dir() => Some(dot_git),
        Ok(_) => {
            let pointer = std::fs::read_to_string(&dot_git).ok()?;
            Some(tree_root.join(parse_gitdir_pointer(&pointer)?))
        }
        Err(_) => None,
    }
}

/// Whether `CHERRY_PICK_HEAD` is present, resolved without spawning git (see
/// [`resolve_git_admin_dir`]).
///
/// Narrower than [`op_state`] on purpose: it answers only "is a single-commit pick
/// stopped here", the state `cherry-pick <hash>` leaves and `git commit` clears. The
/// sequencer-only pick (`cherry-pick -n`, no marker) is deliberately outside it.
pub(crate) fn cherry_pick_marker_present(repo: &str) -> bool {
    resolve_git_admin_dir(Path::new(repo))
        .is_some_and(|dir| dir.join("CHERRY_PICK_HEAD").exists())
}

/// Whether a rebase is stopped here, resolved without spawning git (see
/// [`resolve_git_admin_dir`]) — the same `rebase-merge`/`rebase-apply` pair
/// [`op_state`] reads, for the callers that need the verdict while holding a lock.
pub(crate) fn rebase_marker_present(repo: &str) -> bool {
    resolve_git_admin_dir(Path::new(repo)).is_some_and(|dir| {
        dir.join("rebase-merge").exists() || dir.join("rebase-apply").exists()
    })
}

/// True when an interactive rebase is paused at an `edit` instruction (the last
/// executed todo line is `edit`/`e`), as opposed to a conflict.
fn rebase_stopped_for_edit(git_dir: &Path) -> bool {
    let Ok(done) = std::fs::read_to_string(git_dir.join("rebase-merge/done")) else {
        return false;
    };
    done.lines()
        .rfind(|l| !l.trim().is_empty())
        .map(|last| {
            let cmd = last.split_whitespace().next().unwrap_or("");
            cmd == "edit" || cmd == "e"
        })
        .unwrap_or(false)
}

/// Which verb a pending `.git/sequencer` is replaying: `Some(true)` for revert,
/// `Some(false)` for cherry-pick, `None` when no sequencer state exists.
///
/// A multi-commit `cherry-pick -n` that conflicts leaves the sequencer with NO
/// `CHERRY_PICK_HEAD` (measured, git 2.51.1: `--no-commit` never writes one), so
/// the todo's verb is the only signal for that window — the app's own
/// squash/fixup engine creates it. An unreadable or empty todo reads as
/// cherry-pick, matching the best-effort probes around it. Interactive rebase
/// uses `rebase-merge/git-rebase-todo` instead, so it can never land here.
fn sequencer_reverting(git_dir: &Path) -> Option<bool> {
    if !git_dir.join("sequencer").exists() {
        return None;
    }
    let todo = std::fs::read_to_string(git_dir.join("sequencer/todo")).unwrap_or_default();
    let verb = todo
        .lines()
        .find(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .and_then(|line| line.split_whitespace().next());
    Some(verb == Some("revert"))
}

/// Which multi-step git operation, if any, is mid-flight — drives the
/// conflict-resolution banner.
#[tauri::command]
pub async fn git_op_state(repo_path: String) -> AppResult<RepoOpState> {
    op_state(&repo_path).await
}

/// The detection behind [`git_op_state`], shared so compounds that must not
/// touch a tree with in-progress state gate on the SAME marker files the banner
/// reports on.
pub(crate) async fn op_state(repo_path: &str) -> AppResult<RepoOpState> {
    let quiet = RepoOpState {
        merging: false,
        rebasing: false,
        cherry_picking: false,
        reverting: false,
        edit_paused: false,
    };
    // An unresolvable git dir reads as "nothing in flight", NEVER an error:
    // `op_in_progress` maps `Err` to true, so failing here would fail-close every
    // stash / history-edit / promotion guard in the app.
    let Some(git_dir) = absolute_git_dir(repo_path).await else {
        return Ok(quiet);
    };
    let exists = |name: &str| git_dir.join(name).exists();

    let rebasing = exists("rebase-merge") || exists("rebase-apply");
    let edit_paused = rebasing && rebase_stopped_for_edit(&git_dir);
    let cherry_head = exists("CHERRY_PICK_HEAD");
    let revert_head = exists("REVERT_HEAD");
    // The sequencer only decides the verb when neither head marker names it —
    // folding a revert into `cherry_picking` would mislabel the banner and hand
    // Continue/Abort the wrong git command.
    let sequencer = if cherry_head || revert_head {
        None
    } else {
        sequencer_reverting(&git_dir)
    };
    Ok(RepoOpState {
        merging: exists("MERGE_HEAD"),
        rebasing,
        cherry_picking: cherry_head || sequencer == Some(false),
        reverting: revert_head || sequencer == Some(true),
        edit_paused,
    })
}

/// Non-empty `git ls-files --unmerged` — the conflicted entries the changes list
/// shows.
pub(crate) async fn has_unmerged(repo: &str) -> AppResult<bool> {
    let out = run_git(Some(repo), &["ls-files", "--unmerged"], DEFAULT_TIMEOUT).await?;
    Ok(!out.stdout_lossy().trim().is_empty())
}

/// Whether the repo is left mid-op. Reuses [`op_state`]'s detection so this gate
/// and the conflict banner can't drift apart. Best-effort, not fail-closed: the
/// probes swallow read failures into absent, so the `Err` arm is defensive
/// should [`op_state`] ever gain a fallible read.
pub(crate) async fn op_in_progress(repo: &str) -> bool {
    match op_state(repo).await {
        Ok(state) => state.mid_op(),
        Err(_) => true,
    }
}

/// Refuses to stash mid-operation: `git stash push` can't write an unmerged
/// index, and stashing a merge/rebase/cherry-pick/revert that is only
/// staged-resolved sweeps the resolution out of the operation git still holds
/// state for.
/// The mid-op detection is best-effort (see [`op_in_progress`]), and a rebase
/// paused at an `edit` step is refused as well, matching autostash. Only
/// lock-free runners, so callers may hold the repo lock across it.
pub(crate) async fn refuse_mid_op(repo: &str) -> AppResult<()> {
    refuse_mid_op_for(repo, "stash").await
}

/// [`refuse_mid_op`] with the refused action named, for the gate's non-stash
/// callers: the message reaches the user verbatim, so it has to say what they
/// actually asked for. `action` completes "Can't {action} while …".
pub(crate) async fn refuse_mid_op_for(repo: &str, action: &str) -> AppResult<()> {
    if has_unmerged(repo).await? {
        return Err(AppError::InvalidArgument(format!(
            "Can't {action} while a conflict is in progress — resolve the conflicts first."
        )));
    }
    if op_in_progress(repo).await {
        return Err(AppError::InvalidArgument(format!(
            "Can't {action} while a merge, rebase, cherry-pick or revert is in progress — finish or abort it first."
        )));
    }
    Ok(())
}

fn validate_op(op: &str) -> AppResult<()> {
    match op {
        "merge" | "rebase" | "cherry-pick" | "revert" => Ok(()),
        _ => Err(AppError::InvalidArgument(format!("unknown operation: {op}"))),
    }
}

/// Abandons an in-progress merge/rebase/cherry-pick/revert, restoring the
/// pre-operation state.
#[tauri::command]
pub async fn git_op_abort(
    state: State<'_, AppState>,
    repo_path: String,
    op: String,
) -> AppResult<()> {
    op_abort(&state, &repo_path, &op).await
}

/// Testable core of [`git_op_abort`] — takes a plain `&AppState` so real-repo tokio
/// tests can drive it.
pub(crate) async fn op_abort(state: &AppState, repo_path: &str, op: &str) -> AppResult<()> {
    validate_op(op)?;
    let out = run_git_mutating_raw(state, repo_path, &[op, "--abort"], DEFAULT_TIMEOUT).await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    // Closes the stop arm's paused record as the user's own abandonment: a cherry-pick
    // owns a `cherry_pick_onto` record, a rebase owns a guarded pull's
    // `pull_rebase_drop` one. Each closes only its OWN op's record, so the two can
    // never take each other's disposition.
    //
    // The accepted cost, unchanged from when only picks paused but now with a second
    // op's trigger surface: the handle is the newest paused record of that op, not an
    // op id, so a STALE one — left by an op continued or aborted outside the app —
    // would be closed as "aborted by user" by the next in-app abort of its kind. The
    // rebase arm widens WHICH aborts can do that (any in-app rebase abort, not just a
    // guarded pull's), never what it can reach: only an already-stale record, and only
    // until the next `git_oplog_check` that finds no op of its kind in progress
    // retires it via `conclude_stale_pauses`.
    match op {
        "cherry-pick" => {
            crate::oplog::close_paused_pick(repo_path, crate::oplog::PausedOutcome::Aborted).await
        }
        "rebase" => {
            crate::oplog::close_paused_pull_drop(repo_path, crate::oplog::PausedOutcome::Aborted)
                .await
        }
        _ => {}
    }
    Ok(())
}

/// Finishes an in-progress operation once every conflict is resolved and
/// staged. A merge concludes with its commit; rebase/cherry-pick/revert continue
/// with `core.editor=true` so git never tries to open an editor.
///
/// `false` means the pending cherry-pick was dropped as empty instead of
/// committed (the resolution left nothing to commit); `true` that the operation
/// completed normally. Callers must say which happened — the frontend's
/// "continued" copy would otherwise promise a commit that was never made.
#[tauri::command]
pub async fn git_op_continue(
    state: State<'_, AppState>,
    repo_path: String,
    op: String,
) -> AppResult<bool> {
    op_continue(&state, &repo_path, &op).await
}

/// Testable core of [`git_op_continue`] — takes a plain `&AppState` so real-repo
/// tokio tests can drive it. Same `bool` contract.
pub(crate) async fn op_continue(state: &AppState, repo_path: &str, op: &str) -> AppResult<bool> {
    validate_op(op)?;
    let args: Vec<&str> = match op {
        // `--cleanup=strip` is load-bearing: with no editor run, cleanup defaults
        // to `whitespace`, leaving MERGE_MSG's `# Conflicts:` block in the
        // recorded message (measured, git 2.51.1).
        "merge" => vec!["commit", "--no-edit", "--cleanup=strip"],
        other => vec!["-c", "core.editor=true", other, "--continue"],
    };
    // Raw: a `--continue` refused over unresolved paths reports `<path>: needs
    // merge` on STDOUT with stderr empty (measured, git 2.51.1), which a
    // stderr-only error renders as "git exited with code 1".
    let out = run_git_mutating_raw(state, repo_path, &args, DEFAULT_TIMEOUT).await?;
    if out.code != 0 {
        // A resolution that keeps the target's side leaves the pick with nothing to
        // commit: `--continue` then exits 1 asking for `--skip`, on stderr, with
        // CHERRY_PICK_HEAD still in place (measured, git 2.51.1). Taking that escape
        // is what lets Continue finish an all-ours resolution. Cherry-pick only —
        // `revert --continue` writes no such advice for the same resolution
        // (measured), so there is nothing to match on there.
        if op == "cherry-pick"
            && (out.stderr.contains("is now empty") || out.stderr.contains("--allow-empty"))
        {
            let skip = run_git_mutating_raw(
                state,
                repo_path,
                &["cherry-pick", "--skip"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if skip.code == 0 {
                // The skip ended the pick just as a commit would, so the journal's
                // paused record closes here too.
                crate::oplog::close_paused_pick(repo_path, crate::oplog::PausedOutcome::Continued)
                    .await;
                return Ok(false);
            }
            return Err(
                classify_failure(repo_path, op, &[], skip.code, skip.full_failure_text()).await,
            );
        }
        // Empty baseline, unlike every other site: a refused `--continue` reports
        // the paths the operation the CALLER named is already paused on, so they
        // are attributable by construction rather than by having just appeared.
        return Err(classify_failure(repo_path, op, &[], out.code, out.full_failure_text()).await);
    }
    // A cherry-pick that reaches here is over, so a `cherry_pick_onto` record the
    // stop arm left "paused" is closed as done. This is one of the two in-app routes
    // that end a pick — the commit box is the other, and closes it too.
    //
    // A rebase owns a guarded pull's `pull_rebase_drop` record and is the arm that
    // needs the marker check: `--continue` can stop AGAIN at the next commit it
    // replays, and closing then would report a pull the user is still resolving as
    // done. Each op closes only its own record, and the same stale-handle cost
    // `op_abort` documents applies here: an op ended outside the app keeps its record
    // paused until the next `git_oplog_check` that finds none of its kind in progress
    // retires it, and until then an in-app continue of that kind would close it.
    match op {
        "cherry-pick" => {
            crate::oplog::close_paused_pick(repo_path, crate::oplog::PausedOutcome::Continued).await
        }
        "rebase" if !rebase_marker_present(repo_path) => {
            crate::oplog::close_paused_pull_drop(repo_path, crate::oplog::PausedOutcome::Continued)
                .await
        }
        _ => {}
    }
    Ok(true)
}

/// Discards selected 1-based lines from an untracked (new) file by deleting them
/// in place. A new file's diff is all additions, so there is no index/patch to
/// reverse-apply (reverse-applying a new-file patch would delete the whole file).
/// The file stays untracked; discarding every line leaves it empty (whole-file
/// removal is `git_discard_paths`' recycle-bin path).
#[tauri::command]
pub async fn git_discard_untracked_lines(
    repo_path: String,
    path: String,
    lines: Vec<u32>,
) -> AppResult<()> {
    if lines.is_empty() {
        return Err(AppError::InvalidArgument("no lines selected".into()));
    }
    let full = Path::new(&repo_path).join(&path);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let content = std::fs::read_to_string(&full)?;
        let drop: std::collections::HashSet<u32> = lines.into_iter().collect();
        std::fs::write(&full, remove_lines(&content, &drop))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(())
}

/// Removes the given 1-based line numbers from `content`, keeping every other
/// line byte-for-byte. `split_inclusive('\n')` keeps each line's terminator
/// attached, so CRLF endings and a missing final newline are preserved.
fn remove_lines(content: &str, drop: &std::collections::HashSet<u32>) -> String {
    content
        .split_inclusive('\n')
        .enumerate()
        .filter(|(i, _)| !drop.contains(&(*i as u32 + 1)))
        .map(|(_, line)| line)
        .collect()
}

/// Moves the branch pointer to `hash`. `mode` is `"mixed"` (the default — the
/// working tree keeps every change) or `"hard"`, which rewrites the working tree
/// too and is therefore refused while tracked changes are outstanding: `--hard`
/// discards them with no stash and no reflog entry to recover from.
///
/// `--hard` also refuses mid-operation. A paused merge/rebase/pick/revert can sit
/// on a CLEAN tree (the sequencer's own state lives in `.git`, not the tree), so
/// the dirty check alone would let a reset strand those markers and leave the
/// repo claiming an operation whose commits have moved out from under it.
///
/// Both `--hard` guards and the reset itself run under ONE working-tree-lock hold,
/// so no other caller in THIS PROCESS can dirty the tree or start a merge between the
/// checks and a rewrite that has no stash and no reflog to recover from. The hold
/// is why the reset runs on the lock-free `run_git`: `run_git_mutating` re-acquires
/// the same non-reentrant mutex and deadlocks, so this trades away its one-shot
/// index.lock retry — the same bargain `git_stash_all_core` and the cherry-pick
/// compound make. The `--mixed` arm keeps `run_git_mutating`: it has no guards to
/// protect, so there is no check-then-act window and the retry is worth more than
/// a hold.
///
/// The hold's reach ends at this process, as `run_git_mutating`'s own doc says: a
/// separate MCP-server process holds its own lock, and no lock constrains a
/// terminal git or an editor writing files.
///
/// Worktree-correct without extra work: every spawn runs with `repo_path` as its
/// cwd, so a linked worktree resets ITS own HEAD and ITS own tree.
#[tauri::command]
pub async fn git_reset(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
    mode: Option<String>,
) -> AppResult<()> {
    git_reset_core(&state, repo_path, hash, mode).await
}

pub(crate) async fn git_reset_core(
    state: &AppState,
    repo_path: String,
    hash: String,
    mode: Option<String>,
) -> AppResult<()> {
    validate_hash(&hash)?;
    let hard = match mode.as_deref() {
        None | Some("mixed") => false,
        Some("hard") => true,
        Some(other) => {
            return Err(AppError::InvalidArgument(format!(
                "unknown reset mode: {other}"
            )))
        }
    };
    if !hard {
        run_git_mutating(
            state,
            &repo_path,
            &["reset", "--mixed", &hash],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(());
    }
    // One hold across both guards and the rewrite — see this function's doc for
    // why the runner inside it must be the lock-free one.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a reset").await?;
    ensure_clean_tree(&repo_path).await?;
    if op_state(&repo_path).await?.mid_op() {
        return Err(AppError::InvalidArgument(
            "an operation is still in progress — finish or abort it before resetting".into(),
        ));
    }
    run_git(
        Some(&repo_path),
        &["reset", "--hard", &hash],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn git_checkout_commit(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    run_git_mutating(&state, &repo_path, &["switch", "--detach", &hash], DEFAULT_TIMEOUT)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn git_revert(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    git_revert_core(&state, repo_path, hash).await
}

pub(crate) async fn git_revert_core(
    state: &AppState,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // -m is not supported here; reverting merge commits needs a parent choice
    // Raw: a conflicted revert splits its report — `could not revert` on stderr,
    // the `CONFLICT (…` file list on stdout — so the error needs both halves.
    let out = run_git_mutating_raw(
        state,
        &repo_path,
        &["revert", "--no-edit", &hash],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(classify_failure(
            &repo_path,
            "revert",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

/// Returns true when a commit was created. Cherry-picking changes that are
/// already present makes git stop with an in-progress empty pick; that's not
/// an error worth surfacing raw — clean up with --skip and report false.
#[tauri::command]
pub async fn git_cherry_pick(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<bool> {
    git_cherry_pick_core(&state, repo_path, hash).await
}

pub(crate) async fn git_cherry_pick_core(
    state: &AppState,
    repo_path: String,
    hash: String,
) -> AppResult<bool> {
    validate_hash(&hash)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw: a conflicted pick splits its report — `could not apply` on stderr, the
    // `CONFLICT (…` file list on stdout — so the error needs both halves.
    let out =
        run_git_mutating_raw(state, &repo_path, &["cherry-pick", &hash], DEFAULT_TIMEOUT).await?;
    if out.code == 0 {
        return Ok(true);
    }
    // The already-applied sentence arrives on stderr (measured); gating on the raw
    // stream keeps the stdout backfill from widening what counts as "empty".
    if out.stderr.contains("is now empty") || out.stderr.contains("--allow-empty") {
        let _ = run_git_mutating_raw(
            state,
            &repo_path,
            &["cherry-pick", "--skip"],
            DEFAULT_TIMEOUT,
        )
        .await;
        return Ok(false);
    }
    Err(classify_failure(
        &repo_path,
        "cherry-pick",
        &already_unmerged,
        out.code,
        out.full_failure_text(),
    )
    .await)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickRangeResult {
    pub applied: usize,
    pub skipped: usize,
}

/// Copies the given commits (oldest-first) onto `target_branch`, then leaves
/// you on that branch. Commits whose changes already exist there are skipped
/// rather than erroring. A single commit that conflicts stops on `target_branch`
/// with the pick in progress, for the conflict banner to continue or abort.
/// Every other failure (and any failure in a multi-commit batch) is rolled back:
/// the target branch is reset to its prior tip and you return to where you
/// started. Each rollback step is best-effort; when one fails the returned error
/// names what was left behind and how to recover.
#[tauri::command]
pub async fn git_cherry_pick_onto(
    state: State<'_, AppState>,
    repo_path: String,
    hashes: Vec<String>,
    target_branch: String,
) -> AppResult<CherryPickRangeResult> {
    cherry_pick_onto(&state, &repo_path, &hashes, &target_branch).await
}

/// Testable core of [`git_cherry_pick_onto`] — takes a plain `&AppState` so the
/// real-repo tokio tests can drive it (mirrors `rewrite_commits`).
pub(crate) async fn cherry_pick_onto(
    state: &AppState,
    repo_path: &str,
    hashes: &[String],
    target_branch: &str,
) -> AppResult<CherryPickRangeResult> {
    cherry_pick_onto_with_timeouts(
        state,
        repo_path,
        hashes,
        target_branch,
        DEFAULT_TIMEOUT,
        DEFAULT_TIMEOUT,
    )
    .await
}

/// [`cherry_pick_onto`] with the git timeouts injectable. `pick_timeout` bounds ONLY
/// the `cherry-pick` calls in the loop (not the empty-pick `--skip` beside them);
/// `rollback_timeout` only the funnel's `reset --hard target_tip` and the restore
/// `switch`. The setup reads, the initial switch, that `--skip` and the best-effort
/// abort keep `DEFAULT_TIMEOUT`, so a zero value exercises one failure arm at a time
/// instead of failing before the first mutation.
pub(crate) async fn cherry_pick_onto_with_timeouts(
    state: &AppState,
    repo_path: &str,
    hashes: &[String],
    target_branch: &str,
    pick_timeout: std::time::Duration,
    rollback_timeout: std::time::Duration,
) -> AppResult<CherryPickRangeResult> {
    validate_branch_arg(target_branch)?;
    for h in hashes {
        validate_hash(h)?;
    }
    if hashes.is_empty() {
        return Ok(CherryPickRangeResult {
            applied: 0,
            skipped: 0,
        });
    }

    // One hold across guard → capture → pick → rollback: the rollback hard-resets
    // `target` to the `target_tip` captured up here, so a commit another caller lands
    // in between would be destroyed by a reset to a tip that predates it. Lock-free
    // runners only while held (see `run_git_mutating`).
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a cherry-pick").await?;

    // Ahead of the tree check because it can't stand in for this one: a pick paused
    // with its conflicts staged has a CLEAN tree, so the only refusal left would be
    // git's own raw "cannot switch branch while cherry-picking" (measured, git
    // 2.51.1). Shares `op_state`'s detection, like the rebase-edit guard.
    if op_in_progress(repo_path).await {
        return Err(AppError::InvalidArgument(
            "Can't cherry-pick while a merge, rebase, cherry-pick or revert is in progress — finish or abort it from the banner first.".into(),
        ));
    }

    // The failure path hard-resets `target` to its prior tip, which would discard
    // uncommitted work when target is the current branch — refuse first.
    ensure_clean_tree(repo_path).await?;

    // With the other pre-flight guards, so nothing is journaled or switched before an
    // update holding `target` is ruled out.
    crate::git::update_marker::refuse_if_branch_updating(state, repo_path, target_branch).await?;

    // Where we are now, so we can return on failure. A detached HEAD has no
    // branch name, so fall back to restoring its commit directly.
    let original_ref = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let detached = original_ref == "HEAD";
    let original_restore = if detached {
        run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .trim()
            .to_string()
    } else {
        original_ref
    };

    // The target's tip before we touch it, so we can roll back cleanly.
    let target_tip = run_git(
        Some(repo_path),
        &["rev-parse", target_branch],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();

    // Journal a pending entry AFTER the guards + state capture, BEFORE the first
    // mutation. Best-effort: a journal failure returns None and the op proceeds.
    // Runs under the lock (app-data I/O, not git) because the anchors it records
    // are only valid while the hold that captured them is unbroken.
    let original_sha = run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await
        .ok()
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_default();
    let label = format!(
        "Cherry-pick {} commit(s) onto {target_branch}",
        hashes.len()
    );
    let original_ref_label = if detached {
        "HEAD".to_string()
    } else {
        original_restore.clone()
    };
    let op_id = crate::oplog::begin(
        repo_path,
        "cherry_pick_onto",
        &label,
        Some(original_ref_label),
        &original_sha,
        Some(&target_tip),
    )
    .await;

    let result: AppResult<CherryPickRangeResult> = async {
        // `reset --hard target_tip` in the funnel below is valid ONLY with HEAD on
        // `target`: on the user's original branch it would rewind THAT branch to the
        // target's tip. Defensive — the only path into the funnel has already
        // switched — so any future early exit inherits the guarantee.
        let switched = match run_git(
            Some(repo_path),
            &["switch", target_branch],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Ok(_) => true,
            Err(e) => return Err(e),
        };

        let mut applied = 0usize;
        let mut skipped = 0usize;
        // The pre-op unmerged set for `classify_failure` below. `ensure_clean_tree`
        // already refused a dirty tree, so this reads empty — kept real for the same
        // reason `git_cherry_pick_core` reads it: a baseline is never assumed.
        let already_unmerged = unmerged_paths(repo_path).await;
        // Every failure class that reaches this leaves through the one rollback funnel
        // below, so none of them exits with HEAD on `target` unless the rollback itself
        // fails, which the error then says. The exception returns before it: a
        // single-commit conflict, which stops for the user instead.
        let mut failure: Option<(String, AppError)> = None;
        'picks: for hash in hashes {
            // Raw plus an explicit code check, never a mutating runner: this loop
            // runs inside the compound's own working-tree hold. A conflicted pick
            // splits its report — `could not apply` on stderr, the `CONFLICT (…`
            // file list on stdout — so the rollback verdict below needs both.
            let out = match run_git_raw(Some(repo_path), &["cherry-pick", hash], pick_timeout).await
            {
                Ok(out) => out,
                Err(e) => {
                    failure = Some((hash.clone(), e));
                    break 'picks;
                }
            };
            if out.code == 0 {
                applied += 1;
                continue;
            }
            // The already-applied sentence arrives on stderr (measured); gating on
            // the raw stream keeps the stdout half from widening what counts as
            // "empty".
            if out.stderr.contains("is now empty") || out.stderr.contains("--allow-empty") {
                let _ = run_git(
                    Some(repo_path),
                    &["cherry-pick", "--skip"],
                    DEFAULT_TIMEOUT,
                )
                .await;
                skipped += 1;
                continue;
            }
            // A lone commit that conflicts stops here instead of rolling back:
            // CHERRY_PICK_HEAD survives for the conflict banner's Continue/Abort, and
            // resolving on `target` is where the user wants to end up anyway — the same
            // place a manual checkout-and-pick would have left them. A batch keeps the
            // rollback (git's sequencer resume is not wired up), and so does a
            // single-commit failure that added no conflict.
            let err = if hashes.len() == 1 {
                classify_failure(
                    repo_path,
                    "cherry-pick",
                    &already_unmerged,
                    out.code,
                    out.full_failure_text(),
                )
                .await
            } else {
                AppError::Git {
                    code: out.code,
                    stderr: out.full_failure_text(),
                }
            };
            if matches!(err, AppError::Conflict { .. }) {
                return Err(err);
            }
            failure = Some((hash.clone(), err));
            break 'picks;
        }

        if let Some((hash, err)) = failure {
            // Roll everything back: abort the in-progress pick, drop the commits
            // already applied in this batch, and return home. Every attempt stays
            // best-effort, but the two that decide whether the repo actually came
            // home are captured — the error below must not promise a rollback that
            // didn't happen. The abort is not one of them: `reset --hard` clears
            // the pick state on its own, so a failed abort with a good reset still
            // leaves nothing in progress.
            let _ = run_git(
                Some(repo_path),
                &["cherry-pick", "--abort"],
                DEFAULT_TIMEOUT,
            )
            .await;
            let reset_ok = if switched {
                run_git(
                    Some(repo_path),
                    &["reset", "--hard", &target_tip],
                    rollback_timeout,
                )
                .await
                .is_ok()
            } else {
                true
            };
            let restore_args: Vec<&str> = if detached {
                vec!["switch", "--detach", &original_restore]
            } else {
                vec!["switch", &original_restore]
            };
            let restore_ok = run_git(Some(repo_path), &restore_args, rollback_timeout)
                .await
                .is_ok();
            let rolled_back = reset_ok && restore_ok;
            // The remedy has to match the damage: a failed reset can leave this
            // run's commits on `target`, while a good reset with a failed
            // return-switch leaves the branch correct and only HEAD misplaced —
            // telling that user to `--abort` names a no-op.
            // Every verdict leads with one short line naming the outcome, details
            // and remedies below it, git's own output last: the frontend collapses
            // a message whose first line is git conflict output into "operation
            // paused", which is the one thing these arms are not.
            let recovery = if reset_ok {
                // `original_restore` is a bare SHA on the detached path, and plain
                // `git switch <sha>` refuses it — the remedy has to be runnable.
                if detached {
                    format!(
                        "The cherry-pick failed; the rollback restored {target_branch}.\nYou are still checked out on it — switch back with git switch --detach {original_restore}."
                    )
                } else {
                    format!(
                        "The cherry-pick failed; the rollback restored {target_branch}.\nYou are still checked out on it — switch back to {original_restore}."
                    )
                }
            } else {
                format!(
                    "The cherry-pick failed and its automatic rollback also failed.\n{target_branch} may still carry the commits applied so far; its tip before this run was {target_tip}.\nRun git cherry-pick --abort if a pick is still in progress, or git reset --hard {target_tip} on {target_branch} to restore it."
                )
            };
            // Only a good reset retires git's hints: it cleared the pick state, so
            // the report's `--continue` / `--abort` advice is stale. A FAILED reset
            // leaves a pick that may still be in progress, which is why the recovery
            // line above points the user at `--abort` on purpose.
            let stale_hints = if reset_ok {
                "\nThe rollback has already run, so git's continue/abort hints above no longer apply."
            } else {
                ""
            };
            let short = &hash[..hash.len().min(7)];
            return Err(match err {
                AppError::Git { code, stderr } if rolled_back => AppError::Git {
                    code,
                    stderr: format!(
                        "The cherry-pick was rolled back — {target_branch} is unchanged.\nPick {short} failed, usually a conflict; nothing from this batch was kept.\n{stderr}{stale_hints}"
                    ),
                },
                AppError::Git { code, stderr } => AppError::Git {
                    code,
                    stderr: format!(
                        "{recovery}\nThe failing pick was {short}.\n{stderr}{stale_hints}"
                    ),
                },
                other if rolled_back => other,
                // Timeout carries only a u64 and GitNotFound carries nothing, so a
                // variant-preserving wrap isn't available for every arm — one
                // `Command` carrying the whole explanation beats a scheme where
                // which variant survives depends on the failure class.
                other => AppError::Command(format!(
                    "{recovery}\nThe failing pick was {short}.\n{other}"
                )),
            });
        }

        Ok(CherryPickRangeResult { applied, skipped })
    }
    .await;

    // Every git step (including the rollback) is done — release before the
    // journal's app-data I/O so it doesn't extend the hold.
    drop(guard);

    // The stop arm handed the pick to the user rather than ending it, so its record
    // is "paused", not "failed". `AppError::Conflict` leaves this funnel only from
    // that arm (every other class routes through the rollback below it), so matching
    // on the variant needs no `hashes.len()` gate.
    if matches!(result, Err(AppError::Conflict { .. })) {
        crate::oplog::pause(repo_path, &op_id).await;
    } else {
        crate::oplog::finish(
            repo_path,
            &op_id,
            result.as_ref().err().map(|e| e.to_string()),
        )
        .await;
    }
    result
}

/// Discards every uncommitted change: untracked files go to the recycle bin,
/// tracked changes are hard-reset to HEAD.
#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_discard_all_core(&state, repo_path).await
}

pub(crate) async fn git_discard_all_core(state: &AppState, repo_path: String) -> AppResult<()> {
    use crate::git::runner::{run_git, run_git_raw};

    // Snapshot, trash and reset under ONE hold, so nothing can be staged between
    // the untracked sweep and the reset that would then be destroyed with no
    // recycle-bin copy. That means the lock-free `run_git` for the reset —
    // `run_git_mutating` re-acquires this non-reentrant lock and deadlocks —
    // trading away its one-shot index.lock retry (as the stash compound does). The
    // hold spans the whole trash loop deliberately: on a huge untracked set it can
    // last minutes, and a waiter is refused with the labeled Busy once its 10s
    // `LOCK_WAIT_TIMEOUT` runs out. That refusal is the price of
    // point-of-acquisition semantics.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a discard").await?;

    let status_out = run_git(
        Some(&repo_path),
        &[
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let status = crate::git::status::parse_status_v2(&status_out.stdout_lossy());
    let untracked: Vec<String> = status
        .entries
        .iter()
        .filter(|e| e.unstaged == Some(crate::git::types::ChangeKind::Untracked))
        .map(|e| e.path.clone())
        .collect();

    if !untracked.is_empty() {
        let repo = repo_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for path in untracked {
                let full = Path::new(&repo).join(&path);
                crate::fsops::trash_delete(&full).map_err(AppError::Io)?;
            }
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    }

    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if head_exists {
        run_git(
            Some(&repo_path),
            &["reset", "--hard", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_stash_all_core(&state, repo_path).await
}

pub(crate) async fn git_stash_all_core(state: &AppState, repo_path: String) -> AppResult<()> {
    // Guard and stash under ONE hold, so no merge/rebase/cherry-pick can start
    // between the check and the push. That means the lock-free `run_git` for the
    // push itself — `run_git_mutating` re-acquires this non-reentrant lock and
    // deadlocks — trading away its one-shot index.lock retry (as autostash does).
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a stash operation").await?;
    refuse_mid_op(&repo_path).await?;

    let excludes = reserved_stash_excludes(&repo_path).await?;
    // The common path keeps the exact argv it always had, on every platform.
    if excludes.is_empty() {
        run_git(
            Some(&repo_path),
            &["stash", "push", "--include-untracked"],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(());
    }

    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked", "--"];
    args.extend(excludes.iter().map(String::as_str));
    let out = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    // Excluding every change leaves git nothing to stash, which it reports as
    // success — stash-ALL names the reason rather than silently doing nothing. The
    // autostash compounds read the same answer as "nothing to stash" and carry on,
    // which is right for them and wrong here.
    if stash_saved_nothing(&out.stdout_lossy()) {
        return Err(AppError::InvalidArgument(
            "Can't stash — the only changes are Windows-reserved filenames (nul, con, com1, …), which Git can't put in a stash.".to_string(),
        ));
    }
    Ok(())
}

/// `:(exclude,literal)` pathspecs for every untracked path holding a reserved
/// device name, so `stash push --include-untracked` skips what it cannot touch:
/// such a path is plain-path-unreachable, and git writes the stash entry and THEN
/// fails removing the file (exit 1), leaving a stash plus an unchanged tree
/// (measured, git 2.51.1). Empty off Windows and on a tree holding none, so the
/// caller's usual argv is untouched. Lock-free — every caller already holds the
/// working-tree lock, where `run_git_mutating` would deadlock.
pub(crate) async fn reserved_stash_excludes(repo_path: &str) -> AppResult<Vec<String>> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let status_out = run_git(
        Some(repo_path),
        &["status", "--porcelain=v2", "--untracked-files=all", "-z"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(
        crate::git::status::parse_status_v2(&status_out.stdout_lossy())
            .entries
            .iter()
            .filter(|e| {
                e.unstaged == Some(crate::git::types::ChangeKind::Untracked)
                    && crate::fsops::path_has_reserved_component(Path::new(&e.path))
            })
            .map(|e| format!(":(exclude,literal){}", e.path))
            .collect(),
    )
}

/// True when `git stash push` found nothing to save: it exits 0 without creating
/// an entry, so this stdout line is the only signal (`run_git` pins `LC_ALL=C`).
/// Shared so the stash-all and autostash readings of git's sentinel cannot drift.
pub(crate) fn stash_saved_nothing(stdout: &str) -> bool {
    stdout.trim_start().starts_with("No local changes to save")
}

/// One selected file to discard, paired with whether it's untracked (which
/// decides recycle-bin vs. `git restore`).
#[derive(serde::Deserialize)]
pub struct DiscardPath {
    pub path: String,
    pub untracked: bool,
}

/// Discards working-tree changes for a selection of files: tracked files are
/// restored from the index, untracked files go to the OS recycle bin. The
/// scoped analogue of `git_discard_all`.
#[tauri::command]
pub async fn git_discard_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<DiscardPath>,
) -> AppResult<()> {
    git_discard_paths_core(&state, repo_path, paths).await
}

pub(crate) async fn git_discard_paths_core(
    state: &AppState,
    repo_path: String,
    paths: Vec<DiscardPath>,
) -> AppResult<()> {
    let untracked: Vec<String> = paths
        .iter()
        .filter(|p| p.untracked)
        .map(|p| p.path.clone())
        .collect();
    // Literal pathspecs: a `[slug]`-style path would otherwise also restore its
    // glob-siblings, discarding edits the user never selected. The untracked half
    // below takes the path as a filesystem name instead, so it must stay raw.
    let tracked: Vec<String> = paths
        .iter()
        .filter(|p| !p.untracked)
        .map(|p| crate::git::pathspec::literal(&p.path))
        .collect();

    if !untracked.is_empty() {
        let repo = repo_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for path in untracked {
                let full = Path::new(&repo).join(&path);
                crate::fsops::trash_delete(&full).map_err(AppError::Io)?;
            }
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    }

    // Chunked to stay under the Windows ~32K command-line limit on big selections.
    for batch in tracked.chunks(100) {
        let mut args = vec!["restore", "--"];
        args.extend(batch.iter().map(String::as_str));
        run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

/// Stashes only the selected files (their tracked changes plus any untracked
/// matches), leaving the rest of the working tree in place. Creates a single
/// stash entry; `git stash push` with a pathspec no-ops cleanly if nothing
/// matches. `true` means an entry was actually created.
#[tauri::command]
pub async fn git_stash_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<bool> {
    git_stash_paths_core(&state, repo_path, paths).await
}

/// `Ok(false)` when the selection matched nothing and no stash entry was
/// created — the caller decides how to report that, since `git stash push`
/// itself exits 0 either way.
pub(crate) async fn git_stash_paths_core(
    state: &AppState,
    repo_path: String,
    mut paths: Vec<String>,
) -> AppResult<bool> {
    // An empty-string entry is not a valid pathspec (`fatal: empty string is not a
    // valid pathspec`) and would fail every git call below; drop those. Do NOT trim
    // whitespace — space-prefixed/suffixed filenames are legal and GUI paths arrive
    // verbatim from `git status`, so trimming would corrupt them.
    paths.retain(|p| !p.is_empty());
    if paths.is_empty() {
        return Ok(false);
    }

    // A native `git stash push -- <paths>` always snapshots the WHOLE index into
    // the stash's index-commit (`^2`), so any OTHER staged file rides along and can
    // resurrect on `pop --index`. To capture only the selection, hold the per-repo
    // lock across the whole compound sequence and use the lock-free `run_git` for
    // every step while holding it — the working-tree domain is a non-reentrant
    // `tokio::sync::Mutex`, so `run_git_mutating` would re-acquire it and deadlock.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a stash operation").await?;

    // Refuse mid-operation, before any mutation: an unmerged index blocks both a
    // native `git stash push` and the slow path's `write-tree` snapshot, and a
    // merge/rebase/cherry-pick that is only staged-resolved has no unmerged entries
    // yet a stash covering the resolved paths sweeps the resolution out of the
    // operation git is still holding state for.
    refuse_mid_op(&repo_path).await?;

    // Enumerate EVERY path staged vs HEAD, NUL-safe. `--no-renames` decomposes a
    // staged rename into delete+add so the subtraction sees stable per-path names
    // (an unselected half is preserved via reset/restore like any other staged path).
    let all_out = run_git(
        Some(&repo_path),
        &["diff", "--cached", "--no-renames", "-z", "--name-only"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let all_staged: Vec<String> = all_out
        .stdout_lossy()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();

    // Enumerate the staged files MATCHED by the selection via git's own pathspec
    // resolution (`diff --cached -- <paths>`), so `unselected_staged` is
    // definitionally consistent with what `stash push -- <paths>` will sweep —
    // directory args, globs and case-insensitive filesystems all resolve identically
    // (an exact string match against the enumeration would misclassify them).
    // Chunked at 100 for the Windows argv limit; a pathspec matching nothing staged
    // contributes nothing and still exits 0 (so `run_git`'s error-on-nonzero doesn't trip).
    let mut selected_staged: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in paths.chunks(100) {
        let mut args = vec!["diff", "--cached", "--no-renames", "-z", "--name-only", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let matched = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
        selected_staged.extend(
            matched
                .stdout_lossy()
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_string),
        );
    }

    // Literal pathspecs for the re-feed below: these are concrete paths git just
    // enumerated, and steps (a)/(c) hand them BACK to git as patterns. A raw
    // `src/app/[slug]/page.tsx` would reset and re-stage its glob-siblings too —
    // including selected ones this compound op is mid-way through stashing.
    let unselected_staged: Vec<String> = all_staged
        .iter()
        .filter(|p| !selected_staged.contains(*p))
        .map(|p| crate::git::pathspec::literal(p))
        .collect();

    let mut stash_args = vec!["stash", "push", "--include-untracked", "--"];
    stash_args.extend(paths.iter().map(String::as_str));

    // A pathspec matching nothing still exits 0, so this stdout line is the only
    // signal that no entry was created; `run_git` pins `LC_ALL=C` to keep it stable.
    fn created_entry(out: &crate::git::runner::GitOutput) -> bool {
        !out.stdout_lossy()
            .trim_start()
            .starts_with("No local changes to save")
    }

    // Fast path: no other staged file to protect, so the native pathspec stash is
    // already exact.
    if unselected_staged.is_empty() {
        let out = run_git(Some(&repo_path), &stash_args, DEFAULT_TIMEOUT).await?;
        return Ok(created_entry(&out));
    }

    // Snapshot the full index so the unselected files' exact staged blobs can be
    // restored afterward. A `write-tree` failure aborts pre-mutation and propagates
    // RAW: the mid-op guard above already reported the merge case, so a failure
    // reaching here is something else (corruption/permissions) and must not be
    // mislabeled as a merge.
    let full_tree = run_git(Some(&repo_path), &["write-tree"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    // Do the mutation, then ALWAYS restore the unselected index — even if the stash
    // step errors, else the unselected staged files are left unstaged. The chaining
    // below lets the primary (mutate) error win; otherwise the restore error surfaces.
    let mutate: AppResult<bool> = async {
        // a. Unstage the unselected staged paths (index only; worktree untouched).
        //    Chunk at 100 for the Windows argv limit (mirror git_discard_paths_core).
        for chunk in unselected_staged.chunks(100) {
            let mut args = vec!["reset", "-q", "--"];
            args.extend(chunk.iter().map(String::as_str));
            run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
        }
        // b. Native pathspec stash of the selection — EXACTLY ONE call (chunking
        //    would create multiple stash entries). The `^2` index-commit is now
        //    clean: the index holds only the selected staged changes.
        let out = run_git(Some(&repo_path), &stash_args, DEFAULT_TIMEOUT).await?;
        Ok(created_entry(&out))
    }
    .await;

    // c. Restore the exact staged blobs for the unselected paths (index only, no
    //    worktree). An unselected staged NEW file became untracked after its
    //    `reset`; the stash's selection-only pathspec did not sweep it, and this
    //    re-adds it.
    let source_arg = format!("--source={full_tree}");
    let mut restore: AppResult<()> = Ok(());
    for chunk in unselected_staged.chunks(100) {
        let mut args = vec!["restore", "--staged", source_arg.as_str(), "--"];
        args.extend(chunk.iter().map(String::as_str));
        if let Err(e) = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await {
            restore = Err(e);
            break;
        }
    }

    mutate.and_then(|created| restore.map(|()| created))
}

/// Stops tracking the files matching `pathspecs` (each a file, a folder, or a
/// glob like "*.log") via one `git rm --cached`, so they stay on disk but leave
/// the index, then appends `ignore_patterns` to .gitignore so they aren't
/// re-added. The "untrack" counterpart to the ignore menu — one or many files.
/// `--force` covers files with staged changes (content preserved on disk).
#[tauri::command]
pub async fn git_untrack(
    state: State<'_, AppState>,
    repo_path: String,
    pathspecs: Vec<String>,
    ignore_patterns: Vec<String>,
) -> AppResult<()> {
    let specs: Vec<&str> = pathspecs
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["rm", "--cached", "--force", "-r", "--"];
    args.extend(specs);
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    crate::fsops::append_to_gitignore(repo_path, ignore_patterns).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_pop(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_stash_pop_core(&state, repo_path).await
}

pub(crate) async fn git_stash_pop_core(state: &AppState, repo_path: String) -> AppResult<()> {
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw: a conflicted pop reports entirely on stdout and leaves stderr empty
    // (measured, git 2.51.1), so a stderr-only error is blind to the whole report
    // — and to the fact that git kept the stash entry.
    let out = run_git_mutating_raw(state, &repo_path, &["stash", "pop"], DEFAULT_TIMEOUT).await?;
    if out.code != 0 {
        return Err(classify_failure(
            &repo_path,
            "stash-pop",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

/// Every file git currently tracks (`git ls-files`), so the user can untrack one
/// that isn't showing pending changes (e.g. accidentally committed). Read-only.
#[tauri::command]
pub async fn git_list_tracked(repo_path: String) -> AppResult<Vec<String>> {
    let out = run_git(Some(&repo_path), &["ls-files", "-z"], DEFAULT_TIMEOUT).await?;
    Ok(out
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

/// Every untracked file git would report as new (`ls-files --others
/// --exclude-standard`). The AI excluded-files view needs it because its corpus
/// is tracked plus untracked: an untracked NAME is disclosure the moment the file
/// shows up in status. Gitignored files stay out deliberately — they reach no AI
/// feature at all (absent from status and diffs), so the corpus matches what
/// generation actually sees. Read-only.
#[tauri::command]
pub async fn git_list_untracked(repo_path: String) -> AppResult<Vec<String>> {
    let out = run_git(
        Some(&repo_path),
        &["ls-files", "--others", "--exclude-standard", "-z"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

/// An ignored file and the .gitignore rule responsible for ignoring it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredFile {
    /// Repo-relative path; a trailing "/" marks a collapsed ignored directory.
    path: String,
    /// The gitignore file the rule lives in (".gitignore", ".git/info/exclude", …).
    source: String,
    /// 1-based line of the rule in `source` (0 if it couldn't be parsed).
    line: u32,
    /// The matching pattern text.
    pattern: String,
}

/// Files git ignores (untracked + matched by a gitignore rule), each with the
/// rule responsible — surfaced nowhere else (git_status drops ignored entries).
/// Fully-ignored directories are collapsed (e.g. "node_modules/"). Read-only.
#[tauri::command]
pub async fn git_ignored_files(repo_path: String) -> AppResult<Vec<IgnoredFile>> {
    let listed = run_git(
        Some(&repo_path),
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let paths: Vec<String> = listed
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    // Attach the responsible rule via `check-ignore -v` (NUL output, four tokens
    // per match: source, line, pattern, path). `-z` requires the paths on stdin,
    // not as args, so feed them NUL-delimited.
    let input: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let checked = run_git_raw_input(
        Some(&repo_path),
        &["check-ignore", "--verbose", "-z", "--stdin"],
        Some(&input),
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = checked.stdout_lossy();
    let tokens: Vec<&str> = text.split('\0').collect();

    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < tokens.len() {
        let (source, line, pattern, path) =
            (tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]);
        i += 4;
        if path.is_empty() {
            continue;
        }
        out.push(IgnoredFile {
            path: path.to_string(),
            source: source.to_string(),
            line: line.parse().unwrap_or(0),
            pattern: pattern.to_string(),
        });
    }
    Ok(out)
}

/// Force-adds the given pathspecs (`git add --force`), tracking files a gitignore
/// rule would otherwise exclude. A directory tracks its whole (ignored) content,
/// so callers should confirm first.
#[tauri::command]
pub async fn git_force_add(
    state: State<'_, AppState>,
    repo_path: String,
    pathspecs: Vec<String>,
) -> AppResult<()> {
    git_force_add_core(&state, repo_path, pathspecs).await
}

pub(crate) async fn git_force_add_core(
    state: &AppState,
    repo_path: String,
    pathspecs: Vec<String>,
) -> AppResult<()> {
    let specs: Vec<&str> = pathspecs
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    // Windows-only: a reserved-device FILE under a force-added directory aborts the
    // WHOLE add ("unable to index file", measured, git 2.51.1) and the user never
    // saw it — `git_ignored_files` collapses a fully-ignored directory to one entry.
    // Exclude four of the shapes `path_has_reserved_component` calls reserved: the
    // bare name, any extension, and either spelled as a directory (unreadable by
    // plain path, so git only warns there). A leading `**/` matches at the repo root
    // too. Not covered: a trailing-space stem (`nul `), which the predicate accepts
    // and no glob can spell — an accepted residual, not an oversight.
    let reserved_excludes: Vec<String> = if cfg!(windows) {
        crate::fsops::RESERVED_DEVICE_NAMES
            .iter()
            .flat_map(|name| {
                [
                    format!(":(exclude,glob,icase)**/{name}"),
                    format!(":(exclude,glob,icase)**/{name}.*"),
                    format!(":(exclude,glob,icase)**/{name}/**"),
                    format!(":(exclude,glob,icase)**/{name}.*/**"),
                ]
            })
            .collect()
    } else {
        Vec::new()
    };
    let mut args: Vec<&str> = vec!["add", "--force", "--"];
    args.extend(specs);
    args.extend(reserved_excludes.iter().map(String::as_str));
    run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// A gitignore rule to delete: the file it lives in + its exact pattern line.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnignoreRule {
    source: String,
    pattern: String,
}

/// Removes gitignore rule lines (matched by exact trimmed content) from their
/// source files — the "remove rule" / stop-ignoring action. Matching by content
/// (not line number) keeps it safe if the file shifted since it was read.
///
/// Trimming is git's own (`trim_ignore_pattern`), not `str::trim`: a blanket trim
/// collapses `/notes\ ` and `/notes\` to the same key, so unignoring either rule
/// would delete both lines.
#[tauri::command]
pub async fn git_unignore_rules(repo_path: String, rules: Vec<UnignoreRule>) -> AppResult<()> {
    let mut by_source: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in rules {
        let pat = crate::fsops::trim_ignore_pattern(&r.pattern).to_string();
        if r.source.trim().is_empty() || pat.is_empty() {
            continue;
        }
        by_source.entry(r.source).or_default().push(pat);
    }

    for (source, patterns) in by_source {
        let path = {
            let p = Path::new(&source);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&repo_path).join(&source)
            }
        };
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::Io(e)),
        };
        // Strip a leading UTF-8 BOM for processing (it is not whitespace, so it
        // rides on the first line and breaks the pattern match), and restore it
        // on write. Preserve the file's existing line-ending convention — `lines()`
        // drops both \n and \r\n, so a naive `join("\n")` would silently rewrite a
        // Windows CRLF .gitignore to LF.
        let (has_bom, content) = match raw.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        let ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
        let kept: Vec<&str> = content
            .lines()
            .filter(|l| {
                !patterns
                    .iter()
                    .any(|p| crate::fsops::trim_ignore_pattern(l) == p)
            })
            .collect();
        let mut next = kept.join(ending);
        // Keep the trailing newline if the original had one, even when every
        // line was removed (so the file's convention is preserved, not truncated).
        if content.ends_with('\n') {
            next.push_str(ending);
        }
        if has_bom {
            next.insert(0, '\u{feff}');
        }
        tokio::fs::write(&path, next).await.map_err(AppError::Io)?;
    }
    Ok(())
}

/// Outcome of an applied suggestion — what actually happened, for honest toasts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLinesResult {
    /// True when the file was staged after the edit (only when it had no other
    /// local changes before the apply, so the index gains exactly this edit).
    pub staged: bool,
    /// Whether the file already had local changes (staged or unstaged) BEFORE
    /// the apply — when true we never auto-stage (it would sweep those in too).
    pub had_local_changes: bool,
}

/// Applies a reviewer `suggestion` to the local working tree: replaces the
/// `expected_lines` at `start_line` with `replacement_lines`, but only after
/// verifying the file still holds exactly `expected_lines` there (so an Apply
/// on a drifted/outdated file is refused rather than corrupting it). The
/// suggestion semantics (which lines, what replacement) live in the frontend;
/// this is the provider-agnostic git-working-tree primitive behind them.
#[tauri::command]
pub async fn git_replace_file_lines(
    state: State<'_, AppState>,
    repo_path: String,
    file_path: String,
    start_line: u32,
    expected_lines: Vec<String>,
    replacement_lines: Vec<String>,
    stage_when_clean: bool,
) -> AppResult<ApplyLinesResult> {
    replace_file_lines(
        &state,
        &repo_path,
        &file_path,
        start_line,
        &expected_lines,
        &replacement_lines,
        stage_when_clean,
    )
    .await
}

/// Testable core of [`git_replace_file_lines`] — takes a plain `&AppState` so
/// the real-repo tokio tests can drive it (mirrors `rewrite_commits`).
pub(crate) async fn replace_file_lines(
    state: &AppState,
    repo_path: &str,
    file_path: &str,
    start_line: u32,
    expected_lines: &[String],
    replacement_lines: &[String],
    stage_when_clean: bool,
) -> AppResult<ApplyLinesResult> {
    // Pre-mutation validation: every locally-checkable precondition before we
    // touch the file, each with a specific message.
    if start_line < 1 {
        return Err(AppError::InvalidArgument(
            "start_line must be 1-based (>= 1)".into(),
        ));
    }
    if expected_lines.is_empty() {
        return Err(AppError::InvalidArgument(
            "expected_lines must not be empty — a suggestion replaces at least one line".into(),
        ));
    }
    let rel = Path::new(file_path);
    if rel.is_absolute() || file_path.is_empty() {
        return Err(AppError::InvalidArgument(format!(
            "file_path must be repo-relative: {file_path}"
        )));
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::InvalidArgument(format!(
            "file_path must not contain '..' traversal: {file_path}"
        )));
    }

    // Hold the repo's mutating lock across the WHOLE dirty-check → read → verify →
    // write → stage sequence, not just the final `git add`: otherwise two concurrent
    // Apply calls on different ranges of one file interleave and the second silently
    // overwrites the first's write. The working-tree domain is a `tokio::sync::Mutex`
    // (safe to hold across `.await`) but non-reentrant — use the lock-free `run_git`
    // below, never `run_git_mutating`, which would deadlock.
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a file edit").await?;

    let repo_root = std::path::Path::new(repo_path);
    let target = repo_root.join(rel);
    // Resolve the repo root and target, then confirm the target stays inside the
    // repo (defends against symlink/`..` escapes the string check can miss).
    let canon_root = tokio::fs::canonicalize(repo_root)
        .await
        .map_err(|_| AppError::InvalidArgument(format!("repo_path does not exist: {repo_path}")))?;
    let canon_target = tokio::fs::canonicalize(&target).await.map_err(|_| {
        AppError::InvalidArgument(format!("file does not exist: {file_path}"))
    })?;
    if !canon_target.starts_with(&canon_root) {
        return Err(AppError::InvalidArgument(format!(
            "file_path resolves outside the repository: {file_path}"
        )));
    }
    let meta = tokio::fs::metadata(&canon_target).await.map_err(AppError::Io)?;
    if !meta.is_file() {
        return Err(AppError::InvalidArgument(format!(
            "file_path is not a regular file: {file_path}"
        )));
    }

    // Dirty check BEFORE the edit: any porcelain output for this path means the
    // file already had staged/unstaged changes, so we must not auto-stage. Literal
    // pathspec — a glob-sibling's dirtiness must not decide this file's fate.
    let spec = crate::git::pathspec::literal(file_path);
    let status = run_git(
        Some(repo_path),
        &["status", "--porcelain", "--", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let had_local_changes = !status.stdout_lossy().trim().is_empty();

    // Read the file and verify the range still matches the suggestion's anchor.
    let raw = tokio::fs::read_to_string(&canon_target)
        .await
        .map_err(AppError::Io)?;
    // Same BOM/EOL idiom as `git_unignore_rules`: strip a leading BOM and restore
    // it, and preserve the file's line ending (`lines()` drops both \n and \r\n).
    let (has_bom, content) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, raw.as_str()),
    };
    let ending = if content.contains("\r\n") { "\r\n" } else { "\n" };

    let existing: Vec<&str> = content.lines().collect();
    let start = (start_line - 1) as usize;
    let end = start + expected_lines.len();
    // Range beyond EOF, or any line differing, is a mismatch — the file drifted.
    let matches = end <= existing.len()
        && existing[start..end]
            .iter()
            .zip(expected_lines.iter())
            .all(|(have, want)| *have == want.as_str());
    if !matches {
        // Drift is a legitimate state, not a caller bug — use `Command` so its
        // bare Display surfaces cleanly in the UI toast (InvalidArgument's
        // "invalid argument: " prefix would leak into user-facing copy).
        return Err(AppError::Command(format!(
            "{file_path} has changed since the suggestion was made — the lines to replace no longer match"
        )));
    }

    let mut next_lines: Vec<&str> = Vec::with_capacity(
        existing.len() - expected_lines.len() + replacement_lines.len(),
    );
    next_lines.extend_from_slice(&existing[..start]);
    next_lines.extend(replacement_lines.iter().map(String::as_str));
    next_lines.extend_from_slice(&existing[end..]);
    let mut next = next_lines.join(ending);
    // Preserve the file's trailing-newline presence (even if the edit emptied it).
    if content.ends_with('\n') {
        next.push_str(ending);
    }
    if has_bom {
        next.insert(0, '\u{feff}');
    }
    tokio::fs::write(&canon_target, next)
        .await
        .map_err(AppError::Io)?;

    // Stage only when asked AND the file was otherwise clean, so the index gains
    // exactly this edit. Lock-free `run_git` — we already hold the repo lock.
    let staged = stage_when_clean && !had_local_changes;
    if staged {
        run_git(Some(repo_path), &["add", "--", &spec], DEFAULT_TIMEOUT).await?;
    }

    Ok(ApplyLinesResult {
        staged,
        had_local_changes,
    })
}

#[tauri::command]
pub async fn git_stash_count(repo_path: String) -> AppResult<u32> {
    let out = crate::git::runner::run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%H"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy().lines().count() as u32)
}

#[tauri::command]
pub async fn git_stash_list(repo_path: String) -> AppResult<Vec<StashEntry>> {
    let out = run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%gd%x00%s%x00%cI"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let entries = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\0');
            let (Some(refname), Some(message), Some(date)) =
                (parts.next(), parts.next(), parts.next())
            else {
                return None;
            };
            // %gd is "stash@{N}" — the N is the index every other stash
            // command addresses.
            let index: u32 = refname
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(StashEntry {
                index,
                message: message.to_string(),
                date: date.to_string(),
            })
        })
        .collect();
    Ok(entries)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
    /// Lives in the stash's untracked-files parent (^3), so its content reads
    /// from there rather than the stash commit itself.
    pub untracked: bool,
}

/// A stash commit that has fallen out of `git stash list` (dropped, or
/// orphaned by an interrupted operation) but still holds recoverable work,
/// found by walking dangling commits.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanedStash {
    pub sha: String,
    pub message: String,
    pub date: String,
    pub file_count: u32,
}

/// The files a stash-shaped ref holds, including untracked ones, keyed by a
/// ref spec (`stash@{N}` for a live stash, or a raw sha for a dangling one).
async fn stash_files_at(repo: &str, spec: &str) -> AppResult<Vec<StashFile>> {
    let out = run_git(
        Some(repo),
        &[
            "stash",
            "show",
            "--numstat",
            "-z",
            "--include-untracked",
            spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let entries = parse_numstat_z(&out.stdout_lossy());

    // Paths in the untracked parent (^3, present only when untracked files
    // were stashed) need their "new" content read from there.
    let untracked_ref = format!("{spec}^3");
    let mut untracked = std::collections::HashSet::new();
    if let Ok(o) = run_git(
        Some(repo),
        &["ls-tree", "-r", "--name-only", "-z", &untracked_ref],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        for p in o.stdout_lossy().split('\0').filter(|s| !s.is_empty()) {
            untracked.insert(p.to_string());
        }
    }

    Ok(entries
        .into_iter()
        .map(|e| StashFile {
            untracked: untracked.contains(&e.path),
            path: e.path,
            added: e.added,
            deleted: e.deleted,
            is_binary: e.is_binary,
        })
        .collect())
}

/// One file's diff from a stash-shaped ref. Tracked changes diff the stash
/// against its base (`^1`); untracked files live in the stash's third parent
/// (`^3`, created by `--include-untracked`), so an empty tracked diff falls
/// back to that. `spec` is `stash@{N}` for a live stash or a raw sha.
async fn stash_file_diff_at(repo: &str, spec: &str, file_path: &str) -> AppResult<FileDiff> {
    let base = format!("{spec}^1");
    // Literal pathspec: the path comes from the stash's own file list, so a
    // `[slug]`-style name would splice a glob-sibling's hunks into this file's diff.
    let path_spec = crate::git::pathspec::literal(file_path);
    let out = run_git(
        Some(repo),
        &["diff", "--no-color", &base, spec, "--", &path_spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();
    if text.trim().is_empty() {
        // Not a tracked change — try the untracked-files parent if present.
        let untracked = format!("{spec}^3");
        if let Ok(o) = run_git(
            Some(repo),
            &["diff", "--no-color", &base, &untracked, "--", &path_spec],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            text = o.stdout_lossy();
        }
    }
    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = crate::git::diff::truncate_at_char_boundary(text, 1_000_000);
    Ok(FileDiff {
        file_path: file_path.to_string(),
        is_binary,
        is_truncated,
        text,
    })
}

/// The files a stash holds, including untracked ones, so it can be browsed
/// file by file instead of as one combined diff (where a single binary file
/// would mark the whole preview unreadable).
#[tauri::command]
pub async fn git_stash_files(repo_path: String, index: u32) -> AppResult<Vec<StashFile>> {
    stash_files_at(&repo_path, &format!("stash@{{{index}}}")).await
}

/// One file's diff from a stash — see [`stash_file_diff_at`] for the `^1`/`^3`
/// tracked-vs-untracked resolution.
#[tauri::command]
pub async fn git_stash_file_diff(
    repo_path: String,
    index: u32,
    file_path: String,
) -> AppResult<FileDiff> {
    stash_file_diff_at(&repo_path, &format!("stash@{{{index}}}"), &file_path).await
}

/// Find dangling stash commits — work a `git stash` created that has since
/// fallen out of `git stash list` (dropped, or abandoned by an interrupted
/// operation). Walks `git fsck` dangling commits, keeps only stash-shaped
/// ones not already live, and reports each with its file count, newest first.
#[tauri::command]
pub async fn git_orphaned_stashes(repo_path: String) -> AppResult<Vec<OrphanedStash>> {
    let fsck = run_git(
        Some(&repo_path),
        &["fsck", "--no-progress"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let candidates: Vec<String> = fsck
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next(), parts.next()) {
                (Some("dangling"), Some("commit"), Some(sha)) => Some(sha.to_string()),
                _ => None,
            }
        })
        .collect();

    // Shas already live in `git stash list` — don't double-list them.
    let live = run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%H"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let live: std::collections::HashSet<String> = live
        .stdout_lossy()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut out: Vec<OrphanedStash> = Vec::new();
    for sha in candidates {
        if live.contains(&sha) {
            continue;
        }
        // Tolerant: a candidate whose metadata won't parse is simply skipped
        // rather than failing the whole list.
        let Ok(meta) = run_git(
            Some(&repo_path),
            &["log", "-1", "--format=%s%x00%cI%x00%P", &sha],
            DEFAULT_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        let meta = meta.stdout_lossy();
        let mut parts = meta.trim_end_matches('\n').splitn(3, '\0');
        let (Some(subject), Some(date), Some(parents)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // Stash-shaped: a `WIP on <branch>:`/`On <branch>:` subject and at
        // least two parents (base + index; a third holds untracked files).
        if !(subject.starts_with("WIP on ") || subject.starts_with("On ")) {
            continue;
        }
        if parents.split_whitespace().count() < 2 {
            continue;
        }
        let file_count = stash_files_at(&repo_path, &sha)
            .await
            .map(|f| f.len() as u32)
            .unwrap_or(0);
        out.push(OrphanedStash {
            sha,
            message: subject.to_string(),
            date: date.to_string(),
            file_count,
        });
    }

    // Newest first by committer date (ISO 8601 sorts lexically).
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

/// The files a dangling (orphaned) stash holds, browsed by sha.
#[tauri::command]
pub async fn git_orphaned_stash_files(
    repo_path: String,
    sha: String,
) -> AppResult<Vec<StashFile>> {
    validate_hash(&sha)?;
    stash_files_at(&repo_path, &sha).await
}

/// One file's diff from a dangling (orphaned) stash, by sha.
#[tauri::command]
pub async fn git_orphaned_stash_file_diff(
    repo_path: String,
    sha: String,
    file_path: String,
) -> AppResult<FileDiff> {
    validate_hash(&sha)?;
    stash_file_diff_at(&repo_path, &sha, &file_path).await
}

/// Restore a dangling (orphaned) stash into the working tree. Applies (never
/// drops or commits); a conflict surfaces through the normal error path under
/// its own `stash-restore` op, because there is no stash-list entry left to send
/// the user back to — that is the whole point of the orphaned path.
#[tauri::command]
pub async fn git_restore_orphaned(
    state: State<'_, AppState>,
    repo_path: String,
    sha: String,
) -> AppResult<()> {
    git_restore_orphaned_core(&state, repo_path, sha).await
}

/// Testable core of [`git_restore_orphaned`] — takes a plain `&AppState` so the
/// real-repo tokio tests can drive it (mirrors [`git_stash_apply_core`]).
pub(crate) async fn git_restore_orphaned_core(
    state: &AppState,
    repo_path: String,
    sha: String,
) -> AppResult<()> {
    validate_hash(&sha)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw, for the same stdout-only conflict report as `git_stash_pop_core`.
    let out = run_git_mutating_raw(
        state,
        &repo_path,
        &["stash", "apply", &sha],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(classify_failure(
            &repo_path,
            "stash-restore",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
    pop: bool,
) -> AppResult<()> {
    git_stash_apply_core(&state, repo_path, index, pop).await
}

pub(crate) async fn git_stash_apply_core(
    state: &AppState,
    repo_path: String,
    index: u32,
    pop: bool,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw, for the same stdout-only conflict report as `git_stash_pop_core`.
    let out =
        run_git_mutating_raw(state, &repo_path, &["stash", sub, &spec], DEFAULT_TIMEOUT).await?;
    if out.code != 0 {
        let op = if pop { "stash-pop" } else { "stash-apply" };
        return Err(classify_failure(
            &repo_path,
            op,
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
) -> AppResult<()> {
    git_stash_drop_core(&state, repo_path, index).await
}

pub(crate) async fn git_stash_drop_core(
    state: &AppState,
    repo_path: String,
    index: u32,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    run_git_mutating(
        state,
        &repo_path,
        &["stash", "drop", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

fn validate_branch_arg(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// Merges a branch into the current one. With `squash` the combined changes are
/// left staged so the user writes the commit. Otherwise `no_ff` forces a merge
/// commit even when a fast-forward is possible, and `strategy` ("ours"/"theirs",
/// anything else = none) auto-resolves conflicting hunks toward the current /
/// incoming side via `-X`. Unresolved conflicts leave a normal merge-conflict state.
#[tauri::command]
pub async fn git_merge(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    squash: bool,
    no_ff: bool,
    strategy: String,
) -> AppResult<()> {
    git_merge_core(&state, repo_path, branch, squash, no_ff, strategy).await
}

pub(crate) async fn git_merge_core(
    state: &AppState,
    repo_path: String,
    branch: String,
    squash: bool,
    no_ff: bool,
    strategy: String,
) -> AppResult<()> {
    validate_branch_arg(&branch)?;
    let mut args: Vec<&str> = vec!["merge"];
    if squash {
        args.push("--squash");
    } else {
        args.push("--no-edit");
        if no_ff {
            args.push("--no-ff");
        }
        match strategy.as_str() {
            "ours" => args.extend(["-X", "ours"]),
            "theirs" => args.extend(["-X", "theirs"]),
            _ => {}
        }
    }
    args.push(&branch);
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw, because a conflicted merge reports entirely on stdout and leaves
    // stderr empty — the combined text is what keeps that report in the error.
    let out = run_git_mutating_raw(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    if out.code != 0 {
        return Err(classify_failure(
            &repo_path,
            "merge",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// "up-to-date" | "fast-forward" | "clean" | "conflict" | "unknown".
    pub status: String,
    /// Conflicting file paths when status is "conflict" (may be empty if the
    /// git version doesn't report them).
    pub conflicts: Vec<String>,
}

/// Predicts merging `branch` into the current branch **without touching the
/// working tree or index**: merge-base for the up-to-date / fast-forward cases,
/// then `git merge-tree --write-tree` (needs git 2.38+, which is also where
/// `--name-only` landed) for a real in-memory merge, honoring `strategy`
/// ("ours"/"theirs" → `-X`) so the prediction matches the real merge — content
/// conflicts auto-resolve, structural ones still report as conflicts. Older git
/// or any error degrades to "unknown" so the UI hides the preview.
#[tauri::command]
pub async fn git_merge_preview(
    repo_path: String,
    branch: String,
    strategy: String,
) -> AppResult<MergePreview> {
    validate_branch_arg(&branch)?;
    let unknown = || MergePreview {
        status: "unknown".to_string(),
        conflicts: Vec::new(),
    };

    let head = run_git_raw(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    let tip = run_git_raw(Some(&repo_path), &["rev-parse", &branch], DEFAULT_TIMEOUT).await?;
    if head.code != 0 || tip.code != 0 {
        return Ok(unknown());
    }
    let head = head.stdout_lossy().trim().to_string();
    let tip = tip.stdout_lossy().trim().to_string();

    let base_out =
        run_git_raw(Some(&repo_path), &["merge-base", "HEAD", &branch], DEFAULT_TIMEOUT).await?;
    if base_out.code == 0 {
        let base = base_out.stdout_lossy().trim().to_string();
        if base == tip {
            return Ok(MergePreview {
                status: "up-to-date".to_string(),
                conflicts: Vec::new(),
            });
        }
        if base == head {
            return Ok(MergePreview {
                status: "fast-forward".to_string(),
                conflicts: Vec::new(),
            });
        }
    }

    // Diverged (or unrelated histories) — do the merge in memory, honoring the
    // chosen strategy so the prediction matches what the real merge will do.
    let mut args: Vec<&str> = vec!["merge-tree", "--write-tree", "--name-only"];
    match strategy.as_str() {
        "ours" => args.extend(["-X", "ours"]),
        "theirs" => args.extend(["-X", "theirs"]),
        _ => {}
    }
    args.extend(["HEAD", &branch]);
    let mt = run_git_raw(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    match mt.code {
        0 => Ok(MergePreview {
            status: "clean".to_string(),
            conflicts: Vec::new(),
        }),
        1 => {
            // Line 1 is the merged-tree OID; the conflicted file names follow,
            // ending at the blank line before any informational messages. Empty
            // stdout means git refused the merge (no tree OID) — that's an
            // "unknown", not a zero-file conflict.
            let text = mt.stdout_lossy();
            if text.trim().is_empty() {
                return Ok(unknown());
            }
            let conflicts: Vec<String> = text
                .lines()
                .skip(1)
                .take_while(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            Ok(MergePreview {
                status: "conflict".to_string(),
                conflicts,
            })
        }
        _ => Ok(unknown()),
    }
}

/// Rebases the current branch onto another. Conflicts leave the rebase in
/// progress — the changes panel's conflict banner takes it from there
/// (continue or abort).
#[tauri::command]
pub async fn git_rebase(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
) -> AppResult<()> {
    git_rebase_core(&state, repo_path, branch).await
}

pub(crate) async fn git_rebase_core(
    state: &AppState,
    repo_path: String,
    branch: String,
) -> AppResult<()> {
    validate_branch_arg(&branch)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw: a conflicted rebase splits its report — `could not apply` plus the
    // resolve hints on stderr, the `CONFLICT (…` file list on stdout.
    let out = run_git_mutating_raw(
        state,
        &repo_path,
        &["-c", "core.editor=true", "rebase", &branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(classify_failure(
            &repo_path,
            "rebase",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

/// Rebases the current branch onto `new_base`, replaying **only** the commits
/// after `old_base` (`old_base..HEAD`). This is the "I branched off the wrong
/// branch" fix: `git rebase --onto <new_base> <old_base>` excludes `old_base`'s
/// own commits, whereas a plain `git rebase <new_base>` would drag them along.
/// Conflicts leave the rebase in progress — the changes panel's conflict banner
/// (driven by `git_op_state`) takes it from there via continue/abort.
async fn rebase_onto(
    state: &AppState,
    repo_path: &str,
    new_base: &str,
    old_base: &str,
) -> AppResult<()> {
    validate_branch_arg(new_base)?;
    validate_branch_arg(old_base)?;
    let already_unmerged = unmerged_paths(repo_path).await;
    // Raw, for the same split report as `git_rebase_core`.
    let out = run_git_mutating_raw(
        state,
        repo_path,
        &[
            "-c",
            "core.editor=true",
            "rebase",
            "--onto",
            new_base,
            old_base,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(classify_failure(
            repo_path,
            "rebase",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    Ok(())
}

#[tauri::command]
pub async fn git_rebase_onto(
    state: State<'_, AppState>,
    repo_path: String,
    new_base: String,
    old_base: String,
) -> AppResult<()> {
    rebase_onto(&state, &repo_path, &new_base, &old_base).await
}

/// The outcome of a local-PR merge attempt (`git_merge_local_pr` /
/// `git_finish_local_pr_merge`). The frontend consumes this verbatim, so the
/// `#[serde(rename_all = "camelCase")]` shape is a frozen contract.
///
/// Conflicts are resolved in an isolated DETACHED worktree (GitHub-style): the
/// user's current branch and uncommitted work are never touched, so on a conflict
/// the tree lives in a throwaway worktree (`worktree_id` / `worktree_path`) that
/// the frontend points its conflict editor at.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPrMergeOutcome {
    /// `"merged"` (the merge landed and `base` was advanced) or `"conflicts"`
    /// (the merge is paused in the resolve worktree for the user to resolve).
    pub status: String,
    /// Unmerged paths **in the resolve worktree** (empty when merged). From
    /// `diff --name-only --diff-filter=U` run with cwd = the worktree.
    pub conflicts: Vec<String>,
    /// A commit sha for display only: base's tip at the start of the op on the
    /// initial call, the resolved/merged commit on finish.
    pub base_tip: String,
    /// The resolve worktree's id — set only on `"conflicts"`, threaded to
    /// finish/abort so they can find and tear it down. `None` when merged.
    pub worktree_id: Option<String>,
    /// Absolute path to the resolve worktree — set only on `"conflicts"`. The
    /// frontend points its conflict editor here. `None` when merged.
    pub worktree_path: Option<String>,
    /// The oplog entry id, threaded to finish/abort so they can close it.
    pub op_id: Option<String>,
}

/// The current unmerged (conflicted) paths in `repo`'s working tree, via
/// `diff --name-only --diff-filter=U`. Uses `run_git_raw` so a non-zero exit
/// (e.g. mid-operation) is treated as "no readable conflicts" rather than an
/// error. Empty ⇒ no conflicts / a clean tree.
pub(crate) async fn unmerged_paths(repo_path: &str) -> Vec<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["diff", "--name-only", "--diff-filter=U"],
        DEFAULT_TIMEOUT,
    )
    .await;
    match out {
        Ok(o) if o.code == 0 => o
            .stdout_lossy()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Shapes a failed mutating git op, telling a PAUSED operation from a plain
/// failure: an op that ADDED an unmerged path stopped mid-way and left the tree
/// for the user to resolve, which is a different thing for the frontend to say
/// than "the command failed". Otherwise the `AppError::Git` the site produced
/// before, byte-identical.
///
/// `already_unmerged` is the site's unmerged set from BEFORE the op, and it is
/// what keeps a pre-existing conflict from being re-attributed: git refuses
/// outright on an unmerged index rather than adding to it — a pull answers
/// "Pulling is not possible because you have unmerged files", a `stash pop`
/// "error: could not write index", and one with nothing to pop "No stash entries
/// found" (measured, git 2.51.1). Every one of those leaves the index untouched,
/// so the post-failure snapshot alone would hand the paused merge's files to
/// whichever op merely bounced off them, under that op's copy. `op_continue`
/// passes an empty baseline on purpose: the paths it reports are the ones the
/// operation it names is already paused on.
///
/// A baseline rather than matching `op` against [`op_state`]'s flags, which
/// would look equivalent and is not: a conflicted `merge --squash` writes NO
/// marker at all (measured, git 2.51.1 — the same fact
/// `local_pr_finish_squash_all_ours_is_a_known_no_op` rests on), so a flag gate
/// would silently stop classifying every squash-merge conflict.
///
/// `op` is the closed set the frontend's copy table keys on — `merge`, `rebase`,
/// `cherry-pick`, `revert`, `stash-pop`, `stash-apply`, `stash-restore` — and
/// names the operation the user now has to finish, not the git subcommand that
/// failed (a refused `commit --no-edit` concluding a merge is a paused `merge`).
///
/// `report` must be [`GitOutput::full_failure_text`]: the conflict families split
/// ONE report across both streams, so either half alone is silent data loss.
/// Lock-free (the probe uses `run_git_raw`), so compounds may call it while
/// holding any domain's lock.
pub(crate) async fn classify_failure(
    repo_path: &str,
    op: &str,
    already_unmerged: &[String],
    code: i32,
    report: String,
) -> AppError {
    let paths = unmerged_paths(repo_path).await;
    if paths.iter().all(|p| already_unmerged.contains(p)) {
        return AppError::Git {
            code,
            stderr: report,
        };
    }
    AppError::Conflict {
        op: op.to_string(),
        paths,
        report,
    }
}

/// A short, stable hash of a repo key, kept in sync BY HAND with
/// `worktree.rs::repo_hash` (both hash the lower-cased key with `DefaultHasher`) —
/// `ops_and_worktree_repo_hash_agree` is what enforces that by-hand sync.
/// Resolve worktrees — and `branches.rs`'s `gd-update-*` checkouts — must land
/// under the same `<app_data>/worktrees/<hash>` root, because that placement
/// is what makes `git_worktree_list_user` hide them from the user-facing worktree
/// manager (`is_session_worktree`'s app-data check).
pub(crate) fn repo_hash(repo_path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    repo_path.to_lowercase().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The app-data worktree root for a repo KEY — `<data_dir>/<identifier>/worktrees/
/// <hash>`. Mirrors `worktree.rs::worktree_root`, but resolved via
/// `dirs::data_dir()` (as `local_prs.rs` / `oplog.rs` do) since the local-PR
/// merge commands carry no `AppHandle`. Tauri's `app_data_dir()` is exactly
/// `dirs::data_dir()/<identifier>`, so this points at the same directory.
///
/// Two keys are in use, and the base path must never differ between them: the checkout
/// path ([`worktree_root_dir`]) and the repository's worktree-stable identity
/// ([`identity_worktree_root_dir`]).
fn worktree_root_for_key(key: &str) -> AppResult<std::path::PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data
        .join(crate::local_prs::APP_IDENTIFIER)
        .join("worktrees")
        .join(repo_hash(key)))
}

/// The checkout-path-keyed worktree root: resolve worktrees, agent-session worktrees,
/// and the pre-rekey update-marker root all live here.
pub(crate) fn worktree_root_dir(repo_path: &str) -> AppResult<std::path::PathBuf> {
    worktree_root_for_key(repo_path)
}

/// The worktree root every checkout of a repository SHARES, keyed on `identity`
/// ([`crate::git::repo::repo_identity`]'s output, the absolute common git dir) rather
/// than the checkout path. `update_marker` mints and guards here so a sibling worktree
/// resolves the same directory and sees the same markers. Takes the resolved identity
/// so the mapping stays callable without a repo on disk.
pub(crate) fn identity_worktree_root_dir(identity: &str) -> AppResult<std::path::PathBuf> {
    worktree_root_for_key(identity)
}

/// Tears down a resolve worktree: `git worktree remove --force <path>` then
/// `git worktree prune`, both in the MAIN repo, both best-effort (a resolve
/// worktree is detached and holds no branch, so nothing else needs cleanup).
async fn remove_resolve_worktree(state: &AppState, repo_path: &str, worktree_path: &str) {
    let _ = run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "remove", "--force", worktree_path],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    let _ =
        run_git_worktree_admin(state, repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
}

/// Parses `git worktree list --porcelain` into the checked-out branch name of
/// each stanza — the only field `finalize_base` needs. Each stanza starts with a
/// `worktree <path>` line and carries a `branch refs/heads/<name>` line unless it
/// is `detached`; a detached stanza (like our resolve worktree) yields an empty
/// string, so it never matches `base`. Blank lines separate stanzas.
pub(crate) fn parse_worktree_branches(porcelain: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in porcelain.lines() {
        let line = line.trim_end();
        if line.starts_with("worktree ") {
            // A new stanza — default its branch to empty (detached) until a
            // `branch` line fills it in.
            out.push(String::new());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(cur) = out.last_mut() {
                *cur = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            }
        }
    }
    out
}

/// The `worktree <path>` line of every stanza in `git worktree list --porcelain`,
/// in list order.
pub(crate) fn parse_worktree_paths(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter_map(|line| line.trim_end().strip_prefix("worktree "))
        .map(str::to_string)
        .collect()
}

/// The worktree checking `branch` out, from one `worktree list --porcelain` read.
/// Both parsers emit one entry per stanza in list order, so the zip pairs each path
/// with its own branch; a detached stanza (our resolve worktrees) carries an empty
/// name and never matches.
fn worktree_holding(porcelain: &str, branch: &str) -> Option<String> {
    parse_worktree_paths(porcelain)
        .into_iter()
        .zip(parse_worktree_branches(porcelain))
        .find(|(_, b)| b == branch)
        .map(|(path, _)| path)
}

/// Whether a worktree path is one of our resolve worktrees — its final path
/// segment starts with `gd-resolve-`. The basename is the reliable signal:
/// `git_merge_local_pr` names them `gd-resolve-<id>`, and porcelain may
/// normalize the leading path so an app-data-root prefix check is less robust.
fn is_resolve_worktree_path(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("gd-resolve-"))
        .unwrap_or(false)
}

/// A fresh resolve-worktree id: the first 12 hex chars of a v4 uuid. Short
/// deliberately — every path in the checkout is measured from this directory, and
/// a full 36-char uuid spent much of Windows' 260-char budget on the name alone.
/// A collision at 48 random bits stays unreachable, and would be refused rather
/// than reused: `worktree add` fails on a registered or non-empty path.
fn new_resolve_worktree_id() -> String {
    let mut id = uuid::Uuid::new_v4().simple().to_string();
    id.truncate(12);
    id
}

/// Pure decision for [`git_cleanup_orphaned_resolve_worktrees`]: from all
/// worktree paths, pick the resolve worktrees (basename `gd-resolve-*`) whose
/// normalized path is NOT among `keep`. Normalization matches how the app
/// compares worktree paths elsewhere (`normalize_wt_path`: forward-slashed +
/// lower-cased), so a kept path git prints with slashes still matches a kept
/// path the frontend stored with back-slashes.
fn orphaned_resolve_worktrees(all_paths: &[String], keep: &[String]) -> Vec<String> {
    use crate::git::worktree::normalize_wt_path;
    let keep_norm: std::collections::HashSet<String> =
        keep.iter().map(|p| normalize_wt_path(p)).collect();
    all_paths
        .iter()
        .filter(|p| is_resolve_worktree_path(p))
        .filter(|p| !keep_norm.contains(&normalize_wt_path(p)))
        .cloned()
        .collect()
}

/// A branch's tip, read through its fully-qualified ref. Never a bare name:
/// gitrevisions resolves `refs/tags/<name>` BEFORE `refs/heads/<name>`, so a tag
/// sharing the branch name would silently anchor a merge to the tag's commit
/// (git only warns, and exits 0). Callers validate `base` with
/// `validate_branch_name`, so the interpolation carries no refspec syntax.
async fn branch_tip(repo_path: &str, base: &str) -> AppResult<String> {
    Ok(run_git(
        Some(repo_path),
        &["rev-parse", "--verify", &format!("refs/heads/{base}")],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string())
}

/// Advances `base` to `new_sha` after the merge landed in the resolve worktree,
/// picking the safe mechanic for wherever `base` is checked out:
/// - the MAIN repo's current branch → `merge --ff-only` there (the tree was gated
///   clean upfront); a failure propagates as commit-or-stash.
/// - checked out in ANOTHER worktree → run the ff-only INSIDE that worktree so its
///   index and working tree advance too. A bare `update-ref` would desync it
///   (phantom reverts). A dirty one fails cleanly and `base` stays unchanged.
/// - checked out nowhere → a compare-and-swap `update-ref`, no working tree
///   touched.
///
/// `expected_tip` is where `base` stood when the merge was built. Every arm is
/// refused unless `base` is still exactly there, because all three would
/// otherwise honor a rewind as readily as a fresh commit: `merge --ff-only`
/// fast-forwards happily from a `reset --hard <ancestor>`, and a containment
/// test accepts it too. `None` means the anchor could not be established (an
/// unjournaled merge) — the containment test alone then stands, which still
/// refuses a diverged base but cannot see a deliberate rewind.
async fn finalize_base(
    state: &AppState,
    repo_path: &str,
    base: &str,
    new_sha: &str,
    current: &str,
    expected_tip: Option<&str>,
) -> AppResult<()> {
    let moved = || {
        format!(
            "{base} moved while this merge was being prepared, so advancing it would discard \
             that change. {base} is unchanged — re-run the merge from its current tip."
        )
    };
    // One read, before any arm: whatever `base` points at now has to match the
    // tip the merge was built on.
    let tip_now = branch_tip(repo_path, base).await?;
    if let Some(expected) = expected_tip {
        if tip_now != expected {
            return Err(AppError::Command(moved()));
        }
    } else {
        // Anchor unknown: fall back to containment, which catches a base that
        // gained commits but not one deliberately moved back.
        let contains = run_git_raw(
            Some(repo_path),
            &["merge-base", "--is-ancestor", &tip_now, new_sha],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if contains.code != 0 {
            return Err(AppError::Command(moved()));
        }
    }

    if base == current {
        // `base` is the main repo's current branch — fast-forward its working
        // tree to the merged commit. (Guaranteed a fast-forward: `new_sha` was
        // built from base's tip in the resolve worktree.)
        run_git_mutating(
            state,
            repo_path,
            &["merge", "--ff-only", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(());
    }

    use crate::git::update_marker::{self as marker, LockProbe};

    // Resolved once, up front: the `managed` predicate below sits in a closure that
    // cannot await, and both arms must read the same root set the refusal did.
    // Fail-open per `update_marker`'s contract — a root this process cannot resolve
    // must never block the merge, and the update's own pin verify is what keeps the
    // fast-forward data-safe without it.
    let marker_roots = marker::roots_for(repo_path).await.ok();

    // An update that has minted its marker but not yet registered its checkout is
    // invisible to the porcelain read below, so the marker covers that half of the
    // window and the arm below covers it once registered. Heal-free: this call's own
    // continuation takes the admin domain to tear the resolve worktree down.
    if let Some(roots) = marker_roots.as_ref() {
        marker::refuse_if_branch_updating_in(roots, base)?;
    }

    // Is `base` checked out in some OTHER worktree? Our resolve worktree is detached,
    // so it never carries `base` as a branch and is safely excluded.
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut owning_worktree = worktree_holding(&listed.stdout_lossy(), base);

    // An update's hidden checkout is never a fast-forward target: advancing `base`
    // under a running update moves the branch it pinned and kills it at its pin verify.
    // Only a HELD lock refuses and only a RELEASED one authorizes the age-free removal;
    // a marker that proves neither — and any `gd-update-*` worktree outside our own
    // root, which is the user's — leaves this routing exactly as it was before markers
    // existed, which the update's own pin verify already makes data-safe.
    let managed = |w: &&str| {
        marker_roots
            .as_ref()
            .is_some_and(|roots| marker::is_managed_update_worktree_in(roots, w))
    };
    if let Some(holder) = owning_worktree.as_deref().filter(managed).map(str::to_string) {
        match marker::update_worktree_probe(&holder) {
            LockProbe::Live => return Err(marker::branch_update_refusal(base)),
            LockProbe::Released => {
                if !marker::claim_dead_update_worktree(state, repo_path, &holder).await {
                    return Err(marker::interrupted_update_refusal(base));
                }
                let relisted = run_git(
                    Some(repo_path),
                    &["worktree", "list", "--porcelain"],
                    DEFAULT_TIMEOUT,
                )
                .await?;
                owning_worktree = worktree_holding(&relisted.stdout_lossy(), base);
                // Another update may hold `base` by now. Same rule as above, so each
                // message stays true: a held lock says running, a released one says
                // interrupted, and an unprovable one routes as it always did.
                if let Some(next) = owning_worktree.as_deref().filter(managed) {
                    match marker::update_worktree_probe(next) {
                        LockProbe::Live => return Err(marker::branch_update_refusal(base)),
                        LockProbe::Released => {
                            return Err(marker::interrupted_update_refusal(base))
                        }
                        LockProbe::Missing | LockProbe::Unknown => {}
                    }
                }
            }
            LockProbe::Missing | LockProbe::Unknown => {}
        }
    }

    if let Some(worktree) = owning_worktree {
        // Route the fast-forward INTO the worktree holding `base` so its index and
        // working tree advance too; fails cleanly (base untouched) if it's dirty.
        return run_git_mutating(
            state,
            &worktree,
            &["merge", "--ff-only", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await
        .map(|_| ())
        .map_err(|e| match e {
            AppError::Git { stderr, .. } => AppError::Command(format!(
                "{base} is checked out at {worktree}; couldn't fast-forward it there \
                 (its working tree may be dirty, or its history has diverged). {base} is unchanged.\n{stderr}"
            )),
            other => other,
        });
    }

    // Not checked out anywhere — move the ref directly, no working tree touched.
    // git's own `<oldvalue>` argument closes the window between the check above
    // and this write.
    run_git_mutating(
        state,
        repo_path,
        &["update-ref", &format!("refs/heads/{base}"), new_sha, &tip_now],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_err(|e| match e {
        // Only a CAS mismatch means `base` moved — git says `is at <sha> but
        // expected <sha>` (measured, 2.51.1). "cannot lock ref" alone does NOT
        // discriminate: a stale .lock file and a permissions failure say it too,
        // and must keep git's own message rather than a wrong explanation.
        AppError::Git { stderr, .. } if stderr.contains("but expected") => {
            AppError::Command(format!("{}\n{stderr}", moved()))
        }
        other => other,
    })?;
    Ok(())
}

/// Merges `head` into `base` for a local PR, matching GitHub's merge options:
/// - "merge"  → a `--no-ff` merge commit carrying `message`
/// - "squash" → head's commits squashed into one commit with `message`
/// - "rebase" → head's commits replayed onto base (cherry-pick range, no merge
///   commit), preserving their individual messages — `message` is unused
///
/// The merge runs in a hidden DETACHED worktree at `base`'s tip, so the user's
/// branch and uncommitted work are NEVER touched. Clean ⇒ `base` is advanced
/// (`finalize_base`), the worktree torn down, `status: "merged"`. Conflict ⇒ the
/// worktree is kept and returned so the frontend drives resolution there, then
/// calls `git_finish_local_pr_merge` / `git_abort_local_pr_merge`. A clean main
/// tree is required ONLY when `base` IS the current branch (advancing it
/// unavoidably touches the tree).
#[tauri::command]
pub async fn git_merge_local_pr(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    head: String,
    message: String,
    strategy: String,
) -> AppResult<LocalPrMergeOutcome> {
    let root = worktree_root_dir(&repo_path)?;
    merge_local_pr(&state, &repo_path, &base, &head, &message, &strategy, &root).await
}

/// Testable core of [`git_merge_local_pr`] — takes a plain `&AppState` and an
/// explicit worktree-root dir so real-repo tokio tests can drive it against a
/// temp dir (mirrors `rewrite_commits` / `replace_file_lines`). The command
/// resolves `root` to the app-data worktrees dir.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn merge_local_pr(
    state: &AppState,
    repo_path: &str,
    base: &str,
    head: &str,
    message: &str,
    strategy: &str,
    root: &Path,
) -> AppResult<LocalPrMergeOutcome> {
    use crate::git::runner::run_git;

    // `base` reaches `refs/heads/<base>` (finalize_base's update-ref) and `head`
    // the merge argv, so both take the branch-name gate: refspec metacharacters
    // AND rev-expression syntax, which would otherwise merge/advance an ancestor
    // (`feature~1` resolves). In the core, so every caller is gated.
    crate::git::branches::validate_branch_name(base)?;
    crate::git::branches::validate_branch_name(head)?;

    let message = if message.trim().is_empty() {
        format!("Merge {head} into {base}")
    } else {
        message.to_string()
    };

    // Where the main tree is now, and base's tip — captured before any mutation.
    let current = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    // Fully-qualified: this one read anchors the journal, the resolve worktree's
    // start point, and the rebase strategy's replay range.
    let base_tip = branch_tip(repo_path, base).await?;

    // Only advancing the CURRENT branch touches the main tree — gate that one
    // case on a clean tree (finalize_base's `merge --ff-only` would otherwise
    // fail, or clobber uncommitted work). Merging into any other branch leaves
    // the main tree alone, so no clean-tree requirement.
    if base == current {
        ensure_clean_tree(repo_path).await?;
    }

    // Journal a pending entry AFTER the state capture, BEFORE the first mutation.
    // Best-effort: a journal failure returns None and the op proceeds unchanged.
    let verb = match strategy {
        "squash" => "Squash-merge",
        "rebase" => "Rebase-merge",
        _ => "Merge",
    };
    let label = format!("{verb} {head} → {base}");
    let op_id = crate::oplog::begin(
        repo_path,
        "merge_local_pr",
        &label,
        Some(base.to_string()),
        &base_tip,
        Some(&base_tip),
    )
    .await;

    // Create the isolated DETACHED resolve worktree at base's tip.
    let worktree_id = new_resolve_worktree_id();
    let worktree_path = root.join(format!("gd-resolve-{worktree_id}"));
    let worktree_path = worktree_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::create_dir_all(root) {
        crate::oplog::finish(repo_path, &op_id, Some(e.to_string())).await;
        return Err(AppError::Io(e));
    }
    let add = run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "add", "--detach", &worktree_path, &base_tip],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    if let Err(err) = add {
        // The worktree was never created — nothing to tear down.
        crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
        return Err(err);
    }

    // Run the strategy IN the worktree (cwd = worktree_path). Squash/merge write
    // a commit; rebase cherry-picks the range. Conflicts leave unmerged paths.
    let range = format!("{base_tip}..{head}");
    let result: AppResult<()> = match strategy {
        "squash" => {
            match run_git_raw(
                Some(&worktree_path),
                &["merge", "--squash", head],
                DEFAULT_TIMEOUT,
            )
            .await
            {
                Ok(o) if o.code == 0 => run_git_raw(
                    Some(&worktree_path),
                    &["commit", "-m", &message],
                    DEFAULT_TIMEOUT,
                )
                .await
                .and_then(check_code),
                // Hand-rolled rather than `check_code` because the success arm
                // chains a commit; the failure shaping has to match it.
                Ok(o) => Err(AppError::Git {
                    code: o.code,
                    stderr: o.full_failure_text(),
                }),
                Err(e) => Err(e),
            }
        }
        "rebase" => run_git_raw(
            Some(&worktree_path),
            &["cherry-pick", &range],
            DEFAULT_TIMEOUT,
        )
        .await
        .and_then(check_code),
        _ => run_git_raw(
            Some(&worktree_path),
            &["merge", "--no-ff", "-m", &message, head],
            DEFAULT_TIMEOUT,
        )
        .await
        .and_then(check_code),
    };

    match result {
        Ok(()) => {
            // Clean: the worktree HEAD is the merged commit.
            let new_sha = run_git(Some(&worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
                .await?
                .stdout_lossy()
                .trim()
                .to_string();
            // The tip is still in scope here — no need to recover it.
            if let Err(err) =
                finalize_base(state, repo_path, base, &new_sha, &current, Some(&base_tip)).await
            {
                // base couldn't be advanced (e.g. checked out elsewhere, or the
                // ff-only failed) — clean up the worktree and surface the cause.
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
                return Err(err);
            }
            remove_resolve_worktree(state, repo_path, &worktree_path).await;
            crate::oplog::finish(repo_path, &op_id, None).await;
            Ok(LocalPrMergeOutcome {
                status: "merged".to_string(),
                conflicts: Vec::new(),
                base_tip,
                worktree_id: None,
                worktree_path: None,
                op_id,
            })
        }
        Err(err) => {
            // Conflict vs. genuine error: unmerged paths in the WORKTREE is the
            // conflict signal (covers merge/squash/cherry-pick alike — squash
            // never writes MERGE_HEAD, so this is more reliable than op markers).
            let conflicts = unmerged_paths(&worktree_path).await;
            if !conflicts.is_empty() {
                // Keep the worktree + leave the oplog pending; the frontend drives
                // resolution there, then finish/abort close it.
                Ok(LocalPrMergeOutcome {
                    status: "conflicts".to_string(),
                    conflicts,
                    base_tip,
                    worktree_id: Some(worktree_id),
                    worktree_path: Some(worktree_path),
                    op_id,
                })
            } else {
                // Genuine (non-conflict) failure: tear the worktree down (the main
                // tree and base were never touched) and propagate.
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
                match err {
                    AppError::Git { code, stderr } => Err(AppError::Git {
                        code,
                        stderr: format!(
                            "{strategy} merge failed; {base} is unchanged.\n{stderr}"
                        ),
                    }),
                    other => Err(other),
                }
            }
        }
    }
}

/// Completes a local-PR merge that `git_merge_local_pr` left conflicted, once the
/// user has resolved (and staged) every conflict IN THE RESOLVE WORKTREE. Refuses
/// while any unmerged path remains there. On success `base` is advanced to the
/// resolved commit (`finalize_base`), the worktree is removed, and it reports
/// `status: "merged"`. For a `rebase` strategy a *later* commit in the range can
/// re-conflict — it then stays in the worktree and reports `status: "conflicts"`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per field, IPC-shaped
pub async fn git_finish_local_pr_merge(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    strategy: String,
    message: String,
    worktree_path: String,
    worktree_id: String,
    op_id: Option<String>,
) -> AppResult<LocalPrMergeOutcome> {
    finish_local_pr_merge(
        &state,
        &repo_path,
        &base,
        &strategy,
        &message,
        &worktree_path,
        &worktree_id,
        op_id,
    )
    .await
}

/// Testable core of [`git_finish_local_pr_merge`] — takes a plain `&AppState` so
/// real-repo tokio tests can drive it (mirrors [`merge_local_pr`]).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn finish_local_pr_merge(
    state: &AppState,
    repo_path: &str,
    base: &str,
    strategy: &str,
    message: &str,
    worktree_path: &str,
    worktree_id: &str,
    op_id: Option<String>,
) -> AppResult<LocalPrMergeOutcome> {
    // Same gate as `merge_local_pr` — this path reaches the identical
    // `finalize_base` update-ref refspec.
    crate::git::branches::validate_branch_name(base)?;

    // When `base` IS the current branch, `finalize_base` ends in a `merge --ff-only`
    // into the main tree — re-guard clean HERE, since the user may have dirtied it
    // during resolution (after `git_merge_local_pr`'s upfront check). Otherwise base
    // moves by `update-ref` and the main tree is never touched.
    let current = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    if base == current {
        ensure_clean_tree(repo_path).await?;
    }

    // Guard: every conflict in the worktree must be resolved first.
    let remaining = unmerged_paths(worktree_path).await;
    if !remaining.is_empty() {
        return Err(AppError::Command("Resolve every conflict first".to_string()));
    }

    match strategy {
        "rebase" => {
            // Continue the cherry-pick in the worktree with a non-interactive
            // editor so git never blocks (mirrors git_op_continue / git_rebase).
            let out = run_git_raw(
                Some(worktree_path),
                &["-c", "core.editor=true", "cherry-pick", "--continue"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // A later commit in the range may re-conflict; if so, stay in the
            // worktree and re-report conflicts (do NOT finalize or remove).
            let conflicts = unmerged_paths(worktree_path).await;
            if !conflicts.is_empty() {
                let tip = run_git(Some(worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
                    .await
                    .ok()
                    .map(|o| o.stdout_lossy().trim().to_string())
                    .unwrap_or_default();
                return Ok(LocalPrMergeOutcome {
                    status: "conflicts".to_string(),
                    conflicts,
                    base_tip: tip,
                    worktree_id: Some(worktree_id.to_string()),
                    worktree_path: Some(worktree_path.to_string()),
                    op_id,
                });
            }
            // A non-conflict, non-zero exit means something genuinely failed
            // (e.g. "no cherry-pick in progress" when nothing was staged) — surface
            // it on the exit code ALONE, since git can refuse with stderr empty and
            // its whole report on stdout
            // (`a_refusing_commit_reports_on_stdout_with_stderr_empty`), which a
            // stderr gate would report as "merged". Defensive, not behavior-changing:
            // no `--continue` failure measured on 2.51.1 is stdout-only (3 shapes).
            if out.code != 0 {
                return Err(AppError::Git {
                    code: out.code,
                    stderr: out.full_failure_text(),
                });
            }
        }
        _ => {
            // squash / merge → conclude with a commit in the worktree. If the user
            // committed the resolution by hand there is nothing staged; tolerate
            // git's "nothing to commit" instead of erroring.
            //
            // An unfinished MERGE always commits, even with nothing staged: an
            // all-"ours" resolution stages a diff identical to HEAD, and skipping
            // would leave `base` at its old tip while the flow reports "merged".
            // Squash writes no MERGE_HEAD (measured), so an all-ours squash still
            // nets an empty diff and is skipped — a known degenerate case, left
            // unchanged here and pinned by a test.
            let merging = git_path_exists(worktree_path, "MERGE_HEAD").await;
            let staged = run_git_raw(
                Some(worktree_path),
                &["diff", "--cached", "--quiet"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // exit 0 ⇒ nothing staged ⇒ already committed (or empty) ⇒ skip commit.
            if merging || staged.code != 0 {
                let commit = run_git_raw(
                    Some(worktree_path),
                    &["commit", "-m", message],
                    DEFAULT_TIMEOUT,
                )
                .await?;
                if commit.code != 0 {
                    // Both streams, for the tolerance test as well as the error: a
                    // refusing `commit` reports on stdout with stderr EMPTY
                    // (`a_refusing_commit_reports_on_stdout_with_stderr_empty`), so
                    // reading stderr alone can never see the sentence it looks for.
                    let report = commit.full_failure_text();
                    let lower = report.to_lowercase();
                    let already = lower.contains("nothing to commit")
                        || lower.contains("no changes added");
                    if !already {
                        return Err(AppError::Git {
                            code: commit.code,
                            stderr: report,
                        });
                    }
                }
            }
        }
    }

    // Completed with no remaining conflicts: advance base, tear down, close oplog.
    // `current` was resolved up top (and re-guarded clean when base == current).
    let new_sha = run_git(Some(worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
    // The resolution session is unbounded, so the tip this merge was built on has
    // to come from the journal `merge_local_pr` wrote before it started.
    let expected_tip = crate::oplog::pre_op_tip(repo_path, &op_id).await;
    finalize_base(
        state,
        repo_path,
        base,
        &new_sha,
        &current,
        expected_tip.as_deref(),
    )
    .await?;
    remove_resolve_worktree(state, repo_path, worktree_path).await;
    crate::oplog::finish(repo_path, &op_id, None).await;
    Ok(LocalPrMergeOutcome {
        status: "merged".to_string(),
        conflicts: Vec::new(),
        base_tip: new_sha,
        worktree_id: None,
        worktree_path: None,
        op_id,
    })
}

/// Abandons a local-PR merge that `git_merge_local_pr` left conflicted: removes
/// the resolve worktree (`--force`) and prunes. The user's main tree and branch
/// were never touched, so there is nothing else to roll back. Best-effort, then
/// closes the oplog entry as failed ("aborted by user").
#[tauri::command]
pub async fn git_abort_local_pr_merge(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
    op_id: Option<String>,
) -> AppResult<()> {
    remove_resolve_worktree(&state, &repo_path, &worktree_path).await;
    crate::oplog::finish(&repo_path, &op_id, Some("aborted by user".to_string())).await;
    Ok(())
}

/// Sweeps orphaned resolve worktrees (`gd-resolve-<id>`) left under the app-data
/// root by a paused local-PR merge. The only live handle to one is a local PR's
/// `pendingMerge`, so a crash mid-resolve (or a lost PR) orphans it with no UI path
/// to remove it — being detached, the user-facing worktree manager excludes it. The
/// frontend calls this on repo open with every STILL-ACTIVE `pendingMerge` path as
/// `keep_paths`; every other `gd-resolve-*` worktree is torn down. Best-effort per
/// worktree; always returns `Ok(())`.
#[tauri::command]
pub async fn git_cleanup_orphaned_resolve_worktrees(
    state: State<'_, AppState>,
    repo_path: String,
    keep_paths: Vec<String>,
) -> AppResult<()> {
    let root = worktree_root_dir(&repo_path)?;
    cleanup_orphaned_resolve_worktrees(&state, &repo_path, &keep_paths, &root).await
}

/// Whether a remote-PR resolve worktree holds NOTHING worth keeping: no merge in
/// progress, a clean tree, AND no commit that isn't already on some remote. Fails
/// CLOSED — any unreadable signal answers "keep", because the caller's next step
/// is `worktree remove --force`.
async fn pr_resolve_is_worthless(worktree_path: &str) -> bool {
    // MERGE_HEAD first: a clean tree does NOT imply no merge. Resolving every
    // conflict as "ours" stages content byte-identical to HEAD, so
    // `status --porcelain` prints nothing while the merge is still unfinished
    // (measured, git 2.51.1) — and the finish path concludes exactly that merge.
    match git_dir_path(worktree_path, "MERGE_HEAD").await {
        Some(p) if !p.exists() => {}
        // Present, or unresolvable — either way, keep.
        _ => return false,
    }
    let status = run_git_raw(
        Some(worktree_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await;
    match status {
        Ok(o) if o.code == 0 && o.stdout_lossy().trim().is_empty() => {}
        _ => return false,
    }
    let unpushed = run_git_raw(
        Some(worktree_path),
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        DEFAULT_TIMEOUT,
    )
    .await;
    matches!(unpushed, Ok(o) if o.code == 0 && o.stdout_lossy().trim() == "0")
}

/// Testable core of [`git_cleanup_orphaned_resolve_worktrees`] — takes a plain
/// `&AppState` and an explicit worktree root (see [`merge_remote_pr`]).
pub(crate) async fn cleanup_orphaned_resolve_worktrees(
    state: &AppState,
    repo_path: &str,
    keep_paths: &[String],
    root: &Path,
) -> AppResult<()> {
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let all = parse_worktree_paths(&listed.stdout_lossy());
    for path in orphaned_resolve_worktrees(&all, keep_paths) {
        // remove_resolve_worktree is itself best-effort (both git calls swallow
        // errors), so one stuck worktree can't stop the rest.
        remove_resolve_worktree(state, repo_path, &path).await;
    }

    // Remote-PR resolves take no keep-set: WORTHLESSNESS is the protection, and it
    // is strictly safer than a caller-supplied list — a paused conflicted resolve
    // is dirty, a resolved-but-unpushed one has commits, and a merge in progress
    // has MERGE_HEAD, so all three survive even if the frontend forgot them.
    // Accepted race: a worktree is briefly clean, contained and merge-free between
    // `worktree add` and the merge starting. The frontend re-arms this sweep on
    // every switch back to a repo, so switching away and back while a
    // `merge_remote_pr` is mid-flight can land in that window; the cost is a
    // failed automatic merge the user retries, never resolved work.
    for path in all
        .iter()
        .filter(|p| is_pr_resolve_worktree_path(p))
        .filter(|p| path_is_under(root, p))
    {
        if pr_resolve_is_worthless(path).await {
            remove_resolve_worktree(state, repo_path, path).await;
        }
    }
    Ok(())
}

/// The outcome of a step in the REMOTE-PR conflict-resolution ladder. `status` is
/// `"pushed"` (the merge landed on the PR head) or `"conflicts"` (the isolated
/// worktree is kept so the user can resolve there, then finish/abort).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrResolveOutcome {
    pub status: String,
    pub conflicts: Vec<String>,
    /// Absolute path to the resolve worktree — set only on `"conflicts"`.
    pub worktree_path: Option<String>,
    pub worktree_id: Option<String>,
    /// The commit now on the PR head — set only on `"pushed"`.
    pub pushed_sha: Option<String>,
}

/// A live resolve worktree, as [`git_find_remote_pr_resolve`] rediscovers it. The
/// id is parsed from the path HERE because this module owns the naming scheme.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePrResolveHandle {
    pub worktree_path: String,
    pub worktree_id: String,
}

/// Whether a worktree path is one of our REMOTE-PR resolve worktrees — basename
/// `gd-pr-resolve-<remote>-<number>-<id>`. Matches on the bare `gd-pr-resolve-`
/// prefix so it covers EVERY remote/number, and deliberately does NOT match
/// [`is_resolve_worktree_path`]'s `gd-resolve-`, keeping the local-PR orphan sweep
/// away from a remote resolve holding the user's resolutions.
fn is_pr_resolve_worktree_path(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("gd-pr-resolve-"))
        .unwrap_or(false)
}

/// The basename prefix identifying one PR's resolve worktree. The REMOTE is part
/// of it: the same PR number means different branches under different lenses, so
/// leaving it out would let a fork's origin and upstream resolves collide.
fn pr_resolve_prefix(remote: &str, number: u64) -> String {
    format!("gd-pr-resolve-{remote}-{number}-")
}

/// Whether `path` lives under `root`. The two sides routinely arrive as DIFFERENT
/// SPELLINGS of the same location — git's porcelain prints macOS's canonical
/// `/private/var/…` where the caller holds the `/var/…` symlink, and a Windows
/// runner's 8.3 short name (`RUNNER~1`) where the caller holds the long one — so
/// each side is canonicalized (`canonical_wt_path`, the #152 helper) before
/// comparing. The normalize-only spelling is a second chance for a path that no
/// longer exists: `canonicalize` fails there, and one side falling back while the
/// other resolves would make two spellings of the same path look different.
/// Either comparison is a containment check against the SAME root, so accepting
/// either never widens what passes. The separator is appended (as
/// `is_session_worktree` does) — a bare prefix match would accept a SIBLING
/// directory `<root>evil/…`.
fn path_is_under(root: &Path, path: &str) -> bool {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    let root_str = root.to_string_lossy();
    let canon = canonical_wt_path(path).starts_with(&format!("{}/", canonical_wt_path(&root_str)));
    let norm = normalize_wt_path(path).starts_with(&format!("{}/", normalize_wt_path(&root_str)));
    canon || norm
}

/// Guards an IPC-supplied worktree path before `worktree remove --force` is aimed
/// at it: it must be one of ours AND live under this repo's app-data worktree root.
fn ensure_pr_resolve_worktree(root: &Path, worktree_path: &str) -> AppResult<()> {
    if is_pr_resolve_worktree_path(worktree_path) && path_is_under(root, worktree_path) {
        return Ok(());
    }
    Err(AppError::InvalidArgument(format!(
        "not a pull-request resolve worktree: {worktree_path}"
    )))
}

/// The git remote a PR lens addresses, validated for this flow. Reuses the lens →
/// remote mapping the forge reads share, then requires the remote to actually
/// exist (a missing `upstream` on a non-fork clone must fail before any mutation)
/// and to be filename-safe, since the name lands in a worktree DIRECTORY name.
async fn resolve_pr_remote(repo_path: &str, lens: Option<&str>) -> AppResult<&'static str> {
    let remote = crate::github::lens_remote(lens)?;
    // Unreachable while `lens_remote`'s set stays closed ("origin"/"upstream") —
    // kept because the name is embedded in a worktree DIRECTORY name, and that
    // closed set is exactly what the naming scheme currently rests on.
    if remote.is_empty()
        || !remote
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(AppError::InvalidArgument(format!(
            "unusable remote name: {remote}"
        )));
    }
    let names = crate::git::remote::git_remotes(repo_path.to_string()).await?;
    if !names.iter().any(|n| n == remote) {
        return Err(AppError::InvalidArgument(format!(
            "remote does not exist: {remote}"
        )));
    }
    Ok(remote)
}

/// Pushes `sha` onto `remote`'s `head` branch, fully qualified and NEVER forced
/// (no `--force`, no lease): the merge carries `<remote>/<head>` as a parent, so
/// the server sees a fast-forward — a refusal means the head moved, which has to
/// surface rather than be overridden.
async fn push_pr_head(
    state: &AppState,
    repo_path: &str,
    remote: &str,
    sha: &str,
    head: &str,
) -> AppResult<()> {
    let cred = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    let refspec = format!("{sha}:refs/heads/{head}");
    crate::git::remote::run_git_mutating_with_creds(
        state,
        repo_path,
        &cred,
        &["push", remote, &refspec],
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The message text of an error, preferring git's own stderr.
fn error_detail(err: &AppError) -> String {
    match err {
        AppError::Git { stderr, .. } => stderr.trim().to_string(),
        other => other.to_string(),
    }
}

/// Merges `<remote>/<base>` into a remote pull request's head, resolving in a
/// hidden DETACHED worktree so the user's branch and working tree are never
/// touched. Clean ⇒ the merge is pushed straight to `refs/heads/<head>` on that
/// remote and the worktree is torn down (`status: "pushed"`). Conflict ⇒ the
/// worktree is kept and returned so the frontend drives resolution there, then
/// calls [`git_finish_remote_pr_resolve`] / [`git_abort_remote_pr_resolve`].
///
/// `lens` picks the remote exactly as the forge reads do — under a fork's upstream
/// lens the PR's branches live on `upstream`, and fetching/pushing `origin` would
/// silently target the user's fork instead.
///
/// Fork PRs are NOT handled here (pushing needs write access to the head repo);
/// the frontend gates on `PrDetails::cross_repository`.
#[tauri::command]
pub async fn git_merge_remote_pr(
    state: State<'_, AppState>,
    repo_path: String,
    number: u64,
    base: String,
    head: String,
    message: Option<String>,
    lens: Option<String>,
) -> AppResult<RemotePrResolveOutcome> {
    let root = worktree_root_dir(&repo_path)?;
    merge_remote_pr(
        &state,
        &repo_path,
        number,
        &base,
        &head,
        message.as_deref(),
        lens.as_deref(),
        &root,
    )
    .await
}

/// Testable core of [`git_merge_remote_pr`] — takes a plain `&AppState` and an
/// explicit worktree-root dir so real-repo tokio tests can drive it against a
/// temp dir (mirrors [`merge_local_pr`]).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn merge_remote_pr(
    state: &AppState,
    repo_path: &str,
    number: u64,
    base: &str,
    head: &str,
    message: Option<&str>,
    lens: Option<&str>,
    root: &Path,
) -> AppResult<RemotePrResolveOutcome> {
    // Both names are interpolated into fetch/push refspecs, so they take the
    // STRICT validator (its `*?[:\ ` blocklist is the refspec-injection defense,
    // plus the rev-expression rejection), and they take it before anything mutates.
    crate::git::branches::validate_branch_name(base)?;
    crate::git::branches::validate_branch_name(head)?;
    let remote = resolve_pr_remote(repo_path, lens).await?;

    // Resume before starting: an existing worktree for this (remote, PR) holds
    // work the user may already have done, so hand it back instead of minting a
    // second one that would strand the first. Its conflict list may be EMPTY —
    // that's a fully-resolved-but-unpushed resolve, and the frontend's takeover
    // renders exactly that state.
    if let Some(existing) = find_remote_pr_resolve(repo_path, number, lens, root).await? {
        let conflicts = unmerged_paths(&existing.worktree_path).await;
        return Ok(RemotePrResolveOutcome {
            status: "conflicts".to_string(),
            conflicts,
            worktree_path: Some(existing.worktree_path),
            worktree_id: Some(existing.worktree_id),
            pushed_sha: None,
        });
    }

    let cred = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    let base_spec = format!("+refs/heads/{base}:refs/remotes/{remote}/{base}");
    let head_spec = format!("+refs/heads/{head}:refs/remotes/{remote}/{head}");
    if let Err(err) = crate::git::remote::run_git_mutating_with_creds(
        state,
        repo_path,
        &cred,
        &["fetch", "--no-tags", remote, &base_spec, &head_spec],
        NETWORK_TIMEOUT,
    )
    .await
    {
        return Err(AppError::Command(format!(
            "Could not fetch the pull request branches from {remote}.\n{}",
            error_detail(&err)
        )));
    }

    let head_ref = format!("refs/remotes/{remote}/{head}");
    let base_ref = format!("refs/remotes/{remote}/{base}");
    let head_tip = run_git(Some(repo_path), &["rev-parse", &head_ref], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
    let base_tip = run_git(Some(repo_path), &["rev-parse", &base_ref], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    // The head already contains base ⇒ there is nothing to merge. Report that
    // honestly rather than claiming a push that never happened (the frontend only
    // starts this when the forge says conflicting, so it's a staleness race).
    let merge_base = run_git_raw(
        Some(repo_path),
        &["merge-base", &base_tip, &head_tip],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.code == 0)
    .map(|o| o.stdout_lossy().trim().to_string());
    if merge_base.as_deref() == Some(base_tip.as_str()) {
        return Err(AppError::Command(format!(
            "The pull request head already contains {base} — nothing to resolve."
        )));
    }

    // The isolated DETACHED worktree at the PR head's tip. No journal entry: the
    // worktree IS the durable resume handle (`find` rediscovers it), and the
    // oplog's interrupted-check keys on the MAIN repo's branch, which this flow
    // never touches — a paused resolve would read as interrupted forever.
    // The local resolve mint's short id, shared deliberately: this directory name
    // is the base every path in the checkout is measured from, and the remote
    // prefix already spends 14 chars of Windows' 260-char budget before the id.
    let worktree_id = new_resolve_worktree_id();
    let worktree_path = root.join(format!(
        "{}{worktree_id}",
        pr_resolve_prefix(remote, number)
    ));
    let worktree_path = worktree_path.to_string_lossy().into_owned();
    std::fs::create_dir_all(root).map_err(AppError::Io)?;
    run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "add", "--detach", &worktree_path, &head_tip],
        WORKTREE_OP_TIMEOUT,
    )
    .await?;

    let message = match message.map(str::trim) {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => format!("Merge {base} into {head}"),
    };
    // Lock-free with cwd = the worktree: the main repo isn't involved, and the
    // mutating runners are not re-entrant under the per-repo lock.
    let merged = run_git_raw(
        Some(&worktree_path),
        &["merge", "--no-ff", "-m", &message, &base_tip],
        DEFAULT_TIMEOUT,
    )
    .await
    .and_then(check_code);

    match merged {
        Ok(()) => {
            let new_sha = run_git(Some(&worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
                .await?
                .stdout_lossy()
                .trim()
                .to_string();
            if let Err(err) = push_pr_head(state, repo_path, remote, &new_sha, head).await {
                // Nothing here is the user's work — the merge was automatic, so
                // tearing the worktree down costs only a cheap retry.
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                return Err(AppError::Command(format!(
                    "Could not push the merge to the pull request branch. The pull request head may have moved — try again.\n{}",
                    error_detail(&err)
                )));
            }
            remove_resolve_worktree(state, repo_path, &worktree_path).await;
            Ok(RemotePrResolveOutcome {
                status: "pushed".to_string(),
                conflicts: Vec::new(),
                worktree_path: None,
                worktree_id: None,
                pushed_sha: Some(new_sha),
            })
        }
        Err(err) => {
            // Unmerged paths in the WORKTREE are the conflict signal.
            let conflicts = unmerged_paths(&worktree_path).await;
            if !conflicts.is_empty() {
                // Keep the worktree; the frontend drives resolution there, then
                // finish/abort close it out.
                Ok(RemotePrResolveOutcome {
                    status: "conflicts".to_string(),
                    conflicts,
                    worktree_path: Some(worktree_path),
                    worktree_id: Some(worktree_id),
                    pushed_sha: None,
                })
            } else {
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                Err(AppError::Command(format!(
                    "merge failed; nothing was pushed.\n{}",
                    error_detail(&err)
                )))
            }
        }
    }
}

/// Completes a remote-PR resolve that [`git_merge_remote_pr`] left conflicted,
/// once the user has resolved (and staged) every conflict IN THE RESOLVE
/// WORKTREE. Refuses while any unmerged path remains. On success the resolved
/// merge is pushed to the lens remote's PR head and the worktree is removed; a
/// REJECTED push keeps the worktree, because it holds the user's resolutions.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per field, IPC-shaped
pub async fn git_finish_remote_pr_resolve(
    state: State<'_, AppState>,
    repo_path: String,
    head: String,
    worktree_path: String,
    worktree_id: String,
    message: Option<String>,
    lens: Option<String>,
) -> AppResult<RemotePrResolveOutcome> {
    let root = worktree_root_dir(&repo_path)?;
    finish_remote_pr_resolve(
        &state,
        &repo_path,
        &head,
        &worktree_path,
        &worktree_id,
        message.as_deref(),
        lens.as_deref(),
        &root,
    )
    .await
}

/// Testable core of [`git_finish_remote_pr_resolve`] (see [`merge_remote_pr`]).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn finish_remote_pr_resolve(
    state: &AppState,
    repo_path: &str,
    head: &str,
    worktree_path: &str,
    worktree_id: &str,
    message: Option<&str>,
    lens: Option<&str>,
    root: &Path,
) -> AppResult<RemotePrResolveOutcome> {
    crate::git::branches::validate_branch_name(head)?;
    let remote = resolve_pr_remote(repo_path, lens).await?;
    ensure_pr_resolve_worktree(root, worktree_path)?;
    // Parse the identity this module itself encodes into the directory name —
    // `gd-pr-resolve-<remote>-<number>-<id>` — rather than suffix-matching the
    // id: an empty id makes `ends_with` vacuously true, and a partial one matches
    // any worktree whose name happens to end that way. The remote segment is what
    // stops one lens from finishing (and pushing) another lens's resolve.
    let basename = std::path::Path::new(worktree_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let Some(rest) = basename.strip_prefix(&format!("gd-pr-resolve-{remote}-")) else {
        return Err(AppError::InvalidArgument(format!(
            "this resolve worktree does not belong to the {remote} remote"
        )));
    };
    // `<number>-<id>`: the number is digits, so the FIRST `-` ends it and
    // everything after is the id. Taking the WHOLE tail rather than the next
    // segment is what keeps worktrees minted before the id shortened — a full
    // 36-char uuid, dashes and all — finishable without a migration.
    let parsed_id = rest
        .split_once('-')
        .filter(|(number, _)| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
        .map(|(_, id)| id);
    if worktree_id.is_empty() || parsed_id != Some(worktree_id) {
        return Err(AppError::InvalidArgument(
            "the resolve worktree path and id do not match".to_string(),
        ));
    }

    let remaining = unmerged_paths(worktree_path).await;
    if !remaining.is_empty() {
        return Err(AppError::Command("Resolve every conflict first.".to_string()));
    }

    // Conclude the merge with a commit in the worktree. An unfinished merge is
    // ALWAYS committed, even with nothing staged: resolving every conflict as
    // "ours" leaves a staged diff identical to HEAD, and the commit's value is
    // recording the second parent (git commits such a merge fine — measured). The
    // skip arm is only for the genuine already-committed-by-hand case: no merge
    // pending AND nothing staged.
    let merging = git_path_exists(worktree_path, "MERGE_HEAD").await;
    let staged = run_git_raw(
        Some(worktree_path),
        &["diff", "--cached", "--quiet"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if merging || staged.code != 0 {
        // No `-m` ⇒ git's prepared MERGE_MSG; `--no-edit` (plus a no-op editor)
        // keeps it non-interactive either way. `--cleanup=strip` is load-bearing:
        // with no editor run, cleanup defaults to `whitespace`, which leaves
        // MERGE_MSG's `# Conflicts:` block in the recorded message — and that
        // shows on the forge (measured, git 2.51.1).
        let args: Vec<&str> = match message.map(str::trim) {
            Some(m) if !m.is_empty() => vec!["commit", "-m", m],
            _ => vec![
                "-c",
                "core.editor=true",
                "commit",
                "--no-edit",
                "--cleanup=strip",
            ],
        };
        let commit = run_git_raw(Some(worktree_path), &args, DEFAULT_TIMEOUT).await?;
        if commit.code != 0 {
            // Both streams, for the tolerance test as well as the error: a
            // refusing `commit` reports on stdout with stderr EMPTY
            // (`a_refusing_commit_reports_on_stdout_with_stderr_empty`), so
            // reading stderr alone can never see the sentence it looks for.
            let report = commit.full_failure_text();
            let lower = report.to_lowercase();
            let already =
                lower.contains("nothing to commit") || lower.contains("no changes added");
            if !already {
                return Err(AppError::Git {
                    code: commit.code,
                    stderr: report,
                });
            }
        }
    }

    let new_sha = run_git(Some(worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
    // Still sitting on the fetched head ⇒ the merge was never concluded, so there
    // is nothing to push (pushing it would be a no-op reported as success).
    let head_tip = run_git(
        Some(repo_path),
        &["rev-parse", &format!("refs/remotes/{remote}/{head}")],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    if new_sha == head_tip {
        return Err(AppError::Command(
            "Nothing to push — the merge was not completed.".to_string(),
        ));
    }

    if let Err(err) = push_pr_head(state, repo_path, remote, &new_sha, head).await {
        // KEEP the worktree: it holds the user's conflict resolutions, and `find`
        // rediscovers it so a retry resumes rather than starting over.
        return Err(AppError::Command(format!(
            "The pull request head moved while you were resolving — abort and start again, or retry.\n{}",
            error_detail(&err)
        )));
    }
    remove_resolve_worktree(state, repo_path, worktree_path).await;
    Ok(RemotePrResolveOutcome {
        status: "pushed".to_string(),
        conflicts: Vec::new(),
        worktree_path: None,
        worktree_id: None,
        pushed_sha: Some(new_sha),
    })
}

/// Abandons a remote-PR resolve: removes the resolve worktree (`--force`) and
/// prunes. Nothing was pushed and no local branch was touched, so there is nothing
/// else to roll back — teardown only, which is why it needs no lens. Best-effort.
#[tauri::command]
pub async fn git_abort_remote_pr_resolve(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
) -> AppResult<()> {
    let root = worktree_root_dir(&repo_path)?;
    abort_remote_pr_resolve(&state, &repo_path, &worktree_path, &root).await
}

/// Testable core of [`git_abort_remote_pr_resolve`] (see [`merge_remote_pr`]).
pub(crate) async fn abort_remote_pr_resolve(
    state: &AppState,
    repo_path: &str,
    worktree_path: &str,
    root: &Path,
) -> AppResult<()> {
    ensure_pr_resolve_worktree(root, worktree_path)?;
    remove_resolve_worktree(state, repo_path, worktree_path).await;
    Ok(())
}

/// The live resolve worktree for PR `number` under `lens`'s remote, if one exists
/// — so a reopened PR view can offer to resume instead of starting over, and so
/// [`merge_remote_pr`] never mints a duplicate. Read-only.
#[tauri::command]
pub async fn git_find_remote_pr_resolve(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Option<RemotePrResolveHandle>> {
    let root = worktree_root_dir(&repo_path)?;
    find_remote_pr_resolve(&repo_path, number, lens.as_deref(), &root).await
}

/// Testable core of [`git_find_remote_pr_resolve`] (see [`merge_remote_pr`]).
pub(crate) async fn find_remote_pr_resolve(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
    root: &Path,
) -> AppResult<Option<RemotePrResolveHandle>> {
    let remote = crate::github::lens_remote(lens)?;
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let prefix = pr_resolve_prefix(remote, number);
    Ok(parse_worktree_paths(&listed.stdout_lossy())
        .into_iter()
        .find_map(|p| {
            // Porcelain paths and `root` can be different spellings of the same
            // location (see `path_is_under`).
            if !path_is_under(root, &p) {
                return None;
            }
            // The id is the segment AFTER the prefix — this module names these
            // directories, so it is also the one that reads the name back.
            let id = std::path::Path::new(&p)
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|name| name.strip_prefix(&prefix))?
                .to_string();
            Some(RemotePrResolveHandle {
                worktree_path: p,
                worktree_id: id,
            })
        }))
}

/// Maps a raw git output into a `Result`, turning a non-zero exit into
/// `AppError::Git` (so `run_git_raw` call sites can distinguish a clean commit
/// from a conflict via the returned `Err`, while still surfacing the
/// unmerged-paths signal for the conflict branch).
fn check_code(o: crate::git::runner::GitOutput) -> AppResult<()> {
    if o.code == 0 {
        Ok(())
    } else {
        // Both streams: the cherry-pick/merge strategies below conflict with their
        // file list on stdout, which a stderr-only error would drop.
        Err(AppError::Git {
            code: o.code,
            stderr: o.full_failure_text(),
        })
    }
}

/// Predicts whether merging `head` into `base` would conflict, **without touching
/// the working tree or index** — the read-only precheck for a local-PR merge.
/// Reuses `git merge-tree --write-tree --name-only` (both landed in git 2.38):
/// exit 0 ⇒ `"clean"`; exit 1 ⇒ `"conflict"` with the conflicted names;
/// anything else / old git ⇒ `"unknown"`. Up-to-date and fast-forward cases are
/// short-circuited via merge-base and reported as `"clean"` (the merge would
/// succeed).
#[tauri::command]
pub async fn git_conflict_preview(
    repo_path: String,
    base: String,
    head: String,
) -> AppResult<MergePreview> {
    validate_branch_arg(&base)?;
    validate_branch_arg(&head)?;
    let unknown = || MergePreview {
        status: "unknown".to_string(),
        conflicts: Vec::new(),
    };

    let base_sha = run_git_raw(Some(&repo_path), &["rev-parse", &base], DEFAULT_TIMEOUT).await?;
    let head_sha = run_git_raw(Some(&repo_path), &["rev-parse", &head], DEFAULT_TIMEOUT).await?;
    if base_sha.code != 0 || head_sha.code != 0 {
        return Ok(unknown());
    }
    let base_sha = base_sha.stdout_lossy().trim().to_string();
    let head_sha = head_sha.stdout_lossy().trim().to_string();

    // Already-merged (head reachable from base) or fast-forward (base reachable
    // from head): both merge cleanly.
    let mb = run_git_raw(
        Some(&repo_path),
        &["merge-base", &base, &head],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if mb.code == 0 {
        let mbase = mb.stdout_lossy().trim().to_string();
        if mbase == head_sha || mbase == base_sha {
            return Ok(MergePreview {
                status: "clean".to_string(),
                conflicts: Vec::new(),
            });
        }
    }

    let mt = run_git_raw(
        Some(&repo_path),
        &["merge-tree", "--write-tree", "--name-only", &base, &head],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match mt.code {
        0 => Ok(MergePreview {
            status: "clean".to_string(),
            conflicts: Vec::new(),
        }),
        1 => {
            // Same output shape as `git_merge_preview`: line 1 is the tree OID, then
            // the conflicted names. Empty stdout ⇒ git refused ⇒ "unknown".
            let text = mt.stdout_lossy();
            if text.trim().is_empty() {
                return Ok(unknown());
            }
            let conflicts: Vec<String> = text
                .lines()
                .skip(1)
                .take_while(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            Ok(MergePreview {
                status: "conflict".to_string(),
                conflicts,
            })
        }
        _ => Ok(unknown()),
    }
}

/// Rewrites the unpushed tip of the current branch (`base..HEAD`) — one commit per
/// step, in step order. The interactive-rebase vocabulary maps onto step shape: one
/// hash + no message = **pick**; one hash + message = **reword**; many hashes +
/// message = **squash**; many hashes + no message = **fixup** (reuses the leader
/// commit's message and authorship via `commit -C`). Omitting a commit **drops** it.
/// Refuses on a dirty tree or merge commits in range. If any step fails — a conflict,
/// a squash that leaves nothing to commit, a timeout — the branch is rolled back to
/// its pre-run tip. The rollback is best-effort; when it fails the returned
/// error names what was left behind and how to recover.
#[tauri::command]
pub async fn git_rewrite_commits(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
) -> AppResult<()> {
    rewrite_commits(&state, &repo_path, &base, &steps).await
}

pub(crate) async fn rewrite_commits(
    state: &AppState,
    repo_path: &str,
    base: &str,
    steps: &[RewriteStep],
) -> AppResult<()> {
    rewrite_commits_with_timeouts(
        state,
        repo_path,
        base,
        steps,
        DEFAULT_TIMEOUT,
        DEFAULT_TIMEOUT,
    )
    .await
}

/// [`rewrite_commits`] with the git timeouts injectable. `pick_timeout` bounds ONLY
/// the replay loop's `cherry-pick` calls; `rollback_timeout` only the funnel's
/// `reset --hard orig`. The guards, the initial rewind onto `base`, the multi-hash
/// step's `commit` and the best-effort abort keep `DEFAULT_TIMEOUT`, so a zero value
/// exercises one failure arm at a time instead of failing before the first mutation.
pub(crate) async fn rewrite_commits_with_timeouts(
    state: &AppState,
    repo_path: &str,
    base: &str,
    steps: &[RewriteStep],
    pick_timeout: std::time::Duration,
    rollback_timeout: std::time::Duration,
) -> AppResult<()> {
    validate_hash(base)?;
    if steps.is_empty() {
        return Err(AppError::InvalidArgument("no rewrite steps".into()));
    }
    for step in steps {
        if step.hashes.is_empty() {
            return Err(AppError::InvalidArgument("empty rewrite step".into()));
        }
        for h in &step.hashes {
            validate_hash(h)?;
        }
        // A multi-hash step with no message is a valid fixup (reuse the leader's
        // message), so no message requirement here — pick/reword/squash/fixup
        // are all expressible.
    }

    // One hold across gate → capture → replay → rollback: the rollback hard-resets to
    // the `orig` captured up here, so a commit another caller lands mid-replay would be
    // destroyed, and between `reset --hard base` and the picks the branch sits rewound
    // where a concurrent read sees a truncated history. Lock-free runners only while
    // held (see `run_git_mutating`).
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a history rewrite").await?;

    // reset --hard would destroy uncommitted work — refuse instead.
    let status = run_git(
        Some(repo_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }

    let range = format!("{base}..HEAD");
    let merges = run_git(
        Some(repo_path),
        &["rev-list", "--merges", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !merges.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the range contains merge commits, which can't be rewritten".into(),
        ));
    }
    let in_range: std::collections::HashSet<String> =
        run_git(Some(repo_path), &["rev-list", &range], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .lines()
            .map(str::to_string)
            .collect();
    for step in steps {
        for h in &step.hashes {
            if !in_range.contains(h) {
                return Err(AppError::InvalidArgument(format!(
                    "{h} is not an unpushed commit on this branch"
                )));
            }
        }
    }

    let orig = run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    // Journal a pending entry AFTER the guards + `orig` capture, BEFORE the first
    // mutation (`reset --hard`). Best-effort: a journal failure returns None and
    // the op proceeds unchanged. Runs under the lock (app-data I/O, not git) because
    // the `orig` anchor it records is only valid while this hold is unbroken.
    let original_ref = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|s| !s.is_empty());
    let label = format!("Rewrite {} commit(s)", steps.len());
    let op_id = crate::oplog::begin(
        repo_path,
        "rewrite_commits",
        &label,
        original_ref,
        &orig,
        Some(&orig),
    )
    .await;

    let op_result: AppResult<()> = async {
        // Every failure class — the initial rewind, a conflict, a timeout — leaves
        // through the one rollback funnel below, so none of them strands the branch
        // rewound at `base` unless the rollback itself fails, which the error says.
        let mut failure: Option<AppError> =
            run_git(Some(repo_path), &["reset", "--hard", base], DEFAULT_TIMEOUT)
                .await
                .err();
        // A rewind that failed never reached the replay, so the detail lines
        // below have to describe THAT state: no pick ran (the user copy hedges
        // the branch position — a killed reset can still have moved it).
        let rewound = failure.is_none();
        if failure.is_none() {
            // Raw plus `check_code`, never a mutating runner: this loop runs inside
            // the compound's own working-tree hold. Failures land on either stream —
            // a conflicted pick splits `could not apply` (stderr) from its `CONFLICT (…`
            // file list (stdout), and `commit` reports a squash that left nothing to
            // commit on stdout alone — so a stderr-only error would carry half a
            // message, or none at all.
            'steps: for step in steps {
                let single_pick = step.hashes.len() == 1 && step.message.is_none();
                if single_pick {
                    let args = ["cherry-pick", step.hashes[0].as_str()];
                    if let Err(e) = run_git_raw(Some(repo_path), &args, pick_timeout)
                        .await
                        .and_then(check_code)
                    {
                        failure = Some(e);
                        break 'steps;
                    }
                } else {
                    let mut args = vec!["cherry-pick", "-n"];
                    args.extend(step.hashes.iter().map(String::as_str));
                    if let Err(e) = run_git_raw(Some(repo_path), &args, pick_timeout)
                        .await
                        .and_then(check_code)
                    {
                        failure = Some(e);
                        break 'steps;
                    }
                    let message = step.message.as_deref().map(str::trim).unwrap_or("");
                    // With a message → squash/reword. Without → fixup: reuse the first
                    // (leader) commit's message and authorship.
                    let commit_args: Vec<&str> = if message.is_empty() {
                        vec!["commit", "-C", step.hashes[0].as_str()]
                    } else {
                        vec!["commit", "-m", message]
                    };
                    if let Err(e) = run_git_raw(Some(repo_path), &commit_args, DEFAULT_TIMEOUT)
                        .await
                        .and_then(check_code)
                    {
                        failure = Some(e);
                        break 'steps;
                    }
                }
            }
        }

        if let Some(err) = failure {
            // Roll back: abort any in-progress pick, then return the branch to its
            // pre-run tip. The abort stays best-effort and outside the verdict —
            // `reset --hard` clears the unmerged index and CHERRY_PICK_HEAD, but a
            // multi-hash step's `.git/sequencer` survives it and only `--abort`
            // clears it, which is why the recovery text names that command: while
            // it is there the repo still reads as mid-op (see `op_state`). The
            // reset itself is captured: the error must not promise a rollback that
            // didn't happen.
            let _ = run_git(
                Some(repo_path),
                &["cherry-pick", "--abort"],
                DEFAULT_TIMEOUT,
            )
            .await;
            // The replay never leaves the branch, so there is no return-switch to
            // verify: this one reset is the whole rollback verdict.
            let reset_ok = run_git(
                Some(repo_path),
                &["reset", "--hard", &orig],
                rollback_timeout,
            )
            .await
            .is_ok();
            // Every verdict leads with one short line naming the outcome, details
            // and remedies below it, git's own output last: the frontend collapses
            // a message whose first line is git conflict output into "operation
            // paused", which is the one thing these arms are not.
            let cause = if rewound {
                "Usually a conflict, or a squash/fixup that left nothing to commit."
            } else {
                "The rewind onto the base commit failed, so nothing was replayed."
            };
            let damage = if rewound {
                format!("Your branch may be left partly rewritten; its tip before this run was {orig}.")
            } else {
                format!("Your branch should still be at its original tip {orig}.")
            };
            let recovery = format!(
                "The rewrite failed and its automatic rollback also failed.\n{damage}\nRun git cherry-pick --abort if a pick is still in progress, or git reset --hard {orig} to restore it."
            );
            return Err(match err {
                AppError::Git { code, stderr } if reset_ok => AppError::Git {
                    code,
                    stderr: format!(
                        "The rewrite couldn't be applied and was rolled back — your branch is unchanged.\n{cause}\n{stderr}"
                    ),
                },
                AppError::Git { code, stderr } => AppError::Git {
                    code,
                    stderr: format!("{recovery}\n{stderr}"),
                },
                other if reset_ok => other,
                // Timeout carries only a u64 and GitNotFound carries nothing, so a
                // variant-preserving wrap isn't available for every arm — one
                // `Command` carrying the whole explanation beats a scheme where
                // which variant survives depends on the failure class.
                other => AppError::Command(format!("{recovery}\n{other}")),
            });
        }
        Ok(())
    }
    .await;

    // Every git step (including the rollback) is done — release before the
    // journal's app-data I/O so it doesn't extend the hold.
    drop(guard);

    crate::oplog::finish(
        repo_path,
        &op_id,
        op_result.as_ref().err().map(|e| e.to_string()),
    )
    .await;
    op_result
}

/// Rewrites the unpushed tip via a **real, resumable** `git rebase -i` — used when
/// the plan contains an `edit` (the atomic replay engine can't pause). Generates
/// the todo (pick/edit the leader, fixup the folds, reword/squash messages via a
/// non-interactive `exec … commit --amend -F`) and injects it with
/// `sequence.editor`, so no editor ever opens. Stopping at an `edit` (or at a
/// conflict before one) leaves the rebase in progress for the banner to take over —
/// a normal outcome, not an error.
#[tauri::command]
pub async fn git_rebase_edit(
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
) -> AppResult<()> {
    validate_hash(&base)?;
    if steps.is_empty() {
        return Err(AppError::InvalidArgument("no rebase steps".into()));
    }
    for step in &steps {
        if step.hashes.is_empty() {
            return Err(AppError::InvalidArgument("empty rebase step".into()));
        }
        for h in &step.hashes {
            validate_hash(h)?;
        }
    }
    // CRITICAL: refuse if a sequencer op is already mid-flight, BEFORE the
    // scratch-dir clear below — otherwise it would delete the in-flight rebase's
    // pending message files (its `exec ... -F msg` lines would then fail on
    // --continue, losing the message), and the post-run check would mask it as
    // success.
    // Shares [`op_state`]'s detection rather than re-listing markers: the
    // hand-rolled copy this replaces missed the sequencer-only and revert windows.
    if op_in_progress(&repo_path).await {
        return Err(AppError::InvalidArgument(
            "Can't edit history while a merge, rebase, cherry-pick or revert is in progress — finish or abort it from the banner first.".into(),
        ));
    }
    // git rebase refuses a dirty tree too, but a clear message here is nicer.
    let status = run_git(
        Some(&repo_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }

    // Journal a pending entry AFTER the guards, BEFORE the first side effect
    // (scratch-dir setup / the rebase itself). Best-effort: a journal failure
    // returns None and the op proceeds unchanged. A paused rebase returns Ok, so
    // `finish` marks it "done" (git tracks the paused state); only a real Err is
    // "failed". `git_oplog_check` sees `rebasing` true only if the PROCESS died.
    let original_sha = run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await
        .ok()
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_default();
    let original_ref = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|s| !s.is_empty());
    let label = format!("Interactive rebase onto {base}");
    let op_id = crate::oplog::begin(
        &repo_path,
        "rebase_edit",
        &label,
        original_ref,
        &original_sha,
        Some(&original_sha),
    )
    .await;

    let op_result: AppResult<()> = async {
        // Scratch dir inside .git for the generated todo + message files. The
        // message files are referenced by `exec` lines that run on each --continue,
        // so they must outlive this call — clear stale ones up front instead.
        let dir = git_dir_path(&repo_path, "gd-rebase-edit")
            .await
            .ok_or_else(|| AppError::InvalidArgument("couldn't resolve the git dir".into()))?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::InvalidArgument(format!("couldn't create scratch dir: {e}")))?;

        let mut todo = String::new();
        for (i, step) in steps.iter().enumerate() {
            todo.push_str(if step.edit { "edit " } else { "pick " });
            todo.push_str(&step.hashes[0]);
            todo.push('\n');
            for fold in &step.hashes[1..] {
                todo.push_str("fixup ");
                todo.push_str(fold);
                todo.push('\n');
            }
            let message = step.message.as_deref().map(str::trim).unwrap_or("");
            if !message.is_empty() {
                let msg_path = dir.join(format!("msg-{i}"));
                std::fs::write(&msg_path, message).map_err(|e| {
                    AppError::InvalidArgument(format!("couldn't write message: {e}"))
                })?;
                let msg_fwd = msg_path.to_string_lossy().replace('\\', "/");
                // --no-verify: the message is already composed; don't let a
                // pre-commit/commit-msg hook stall the rebase mid-flight.
                todo.push_str(&format!(
                    "exec git commit --amend --no-verify -F \"{msg_fwd}\"\n"
                ));
            }
        }
        let todo_path = dir.join("todo");
        std::fs::write(&todo_path, &todo)
            .map_err(|e| AppError::InvalidArgument(format!("couldn't write todo: {e}")))?;
        let todo_fwd = todo_path.to_string_lossy().replace('\\', "/");
        // `sequence.editor` swaps git's generated todo for ours (a plain copy);
        // `core.editor=true` guarantees nothing ever blocks waiting for an editor.
        let seq_editor = format!("sequence.editor=cp \"{todo_fwd}\"");

        let out = run_git_raw(
            Some(&repo_path),
            &[
                "-c",
                "core.editor=true",
                "-c",
                &seq_editor,
                "rebase",
                "-i",
                &base,
            ],
            DEFAULT_TIMEOUT,
        )
        .await?;

        // A paused rebase leaves rebase-merge in place — that's the hand-off to the
        // banner, not a failure. Only error when nothing's in progress.
        let rebasing = git_path_exists(&repo_path, "rebase-merge").await
            || git_path_exists(&repo_path, "rebase-apply").await;
        if !rebasing && out.code != 0 {
            return Err(AppError::Git {
                code: out.code,
                stderr: format!("Couldn't start the rebase.\n{}", out.stderr),
            });
        }
        Ok(())
    }
    .await;

    crate::oplog::finish(
        &repo_path,
        &op_id,
        op_result.as_ref().err().map(|e| e.to_string()),
    )
    .await;
    op_result
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub hash: String,
    /// The full commit message (subject + body), so the Edit-history editor can
    /// pre-fill reword/squash fields without truncating multi-line bodies.
    pub message: String,
}

/// Full messages for the unpushed commits `base..HEAD`. NUL-delimited so
/// multi-line bodies survive intact.
#[tauri::command]
pub async fn git_unpushed_messages(
    repo_path: String,
    base: String,
) -> AppResult<Vec<CommitMessage>> {
    validate_hash(&base)?;
    let range = format!("{base}..HEAD");
    let out = run_git(
        Some(&repo_path),
        &["log", "-z", "--format=%H%n%B", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let mut messages = Vec::new();
    for record in text.split('\0') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        match record.split_once('\n') {
            Some((hash, message)) => messages.push(CommitMessage {
                hash: hash.trim().to_string(),
                message: message.trim_end().to_string(),
            }),
            None => messages.push(CommitMessage {
                hash: record.trim().to_string(),
                message: String::new(),
            }),
        }
    }
    Ok(messages)
}

/// The tag-name rules for every path a tag rides: `refs/tags/<name>` push and
/// delete refspecs, `gh release` argv, and GitLab release endpoint paths. Adds
/// the rev-expression forms `git check-ref-format` forbids to the shared ref
/// validator, which permits them only for branch start-points (rev expressions
/// may use them).
/// The single-`@` rule is deliberately absent — it matches the ENTIRE refname,
/// never `refs/tags/<name>`, so a tag named `@` is creatable (probe-verified).
/// CI-dispatch refs are free-text branch-or-tag and deliberately skip this.
pub(crate) fn validate_tag_name(name: &str) -> AppResult<()> {
    if name.contains('~') || name.contains('^') || name.contains("..") || name.contains("@{") {
        return Err(AppError::InvalidArgument(format!(
            "invalid tag name: {name}"
        )));
    }
    // The shared validator covers empty / leading `-` / refspec metacharacters —
    // `*` in a `refs/tags/<name>` refspec would mirror-push every tag.
    crate::git::branches::validate_ref_name(name)
        .map_err(|_| AppError::InvalidArgument(format!("invalid tag name: {name}")))
}

#[tauri::command]
pub async fn git_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    hash: String,
) -> AppResult<()> {
    git_tag_core(&state, repo_path, name, hash).await
}

pub(crate) async fn git_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    validate_tag_name(&name)?;
    run_git_mutating(state, &repo_path, &["tag", "--", &name, &hash], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_push_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_push_tag_core(&state, repo_path, name).await
}

pub(crate) async fn git_push_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    let spec = format!("refs/tags/{name}");
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    crate::git::remote::run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &["push", "origin", &spec],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Deletes a tag locally, and (optionally) from origin too.
#[tauri::command]
pub async fn git_delete_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    on_remote: bool,
) -> AppResult<()> {
    git_delete_tag_core(&state, repo_path, name, on_remote).await
}

pub(crate) async fn git_delete_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
    on_remote: bool,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    run_git_mutating(
        state,
        &repo_path,
        &["tag", "-d", "--", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if on_remote {
        let spec = format!(":refs/tags/{name}");
        let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
        crate::git::remote::run_git_mutating_with_creds(
            state,
            &repo_path,
            &cred,
            &["push", "origin", &spec],
            crate::git::runner::NETWORK_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

/// Every tag in the repo, newest first. Annotated tags carry their own message
/// + date; lightweight tags fall back to the commit they point at.
#[tauri::command]
pub async fn git_list_tags(repo_path: String) -> AppResult<Vec<TagInfo>> {
    // %(*objectname) is the dereferenced commit for annotated tags (empty for
    // lightweight, where %(objectname) already IS the commit).
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "refs/tags",
            "--format=%(refname:short)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents:subject)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let tags = out
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let object_type = parts.next().unwrap_or("");
            let object_name = parts.next().unwrap_or("");
            let deref = parts.next().unwrap_or("");
            let date = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            Some(TagInfo {
                name,
                target: if deref.is_empty() {
                    object_name.to_string()
                } else {
                    deref.to_string()
                },
                date,
                annotated: object_type == "tag",
                subject,
            })
        })
        .collect();
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only: the interleave control queues on the lock WITHOUT a wait bound.
    use crate::git::runner::acquire_repo_lock_unbounded;

    fn dropping(content: &str, lines: &[u32]) -> String {
        remove_lines(content, &lines.iter().copied().collect())
    }

    /// Tag names are interpolated into `refs/tags/<name>` and `:refs/tags/<name>`
    /// push refspecs, where `*` mirror-pushes every tag and `:` retargets the
    /// push — so the metacharacters are refused before any remote work.
    #[test]
    fn validate_tag_name_rejects_refspec_metacharacters() {
        for bad in [
            "a:b", "a*b", "a?", "a[b", "a b", "a\\b", "a\u{7}b", "", "-x",
            // Rev-expression forms git itself refuses in a ref name.
            "v1~1", "v1^2", "a@{b", "v1..2",
        ] {
            assert!(
                validate_tag_name(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
        // `@` and `@`-components are creatable tags (probe-verified) — git's
        // anti-`@` rule matches the whole refname, never `refs/tags/<name>`.
        for good in ["feat/x", "release-1.2", "v1.0.0", "a@b", "v1/x", "@", "v1/@/x"] {
            assert!(
                validate_tag_name(good).is_ok(),
                "expected {good:?} to be accepted"
            );
        }
    }

    #[test]
    fn remove_lines_drops_only_selected_and_keeps_the_rest() {
        // 1-based line numbers; line 2 ("b") removed, others byte-identical.
        assert_eq!(dropping("a\nb\nc\n", &[2]), "a\nc\n");
        assert_eq!(dropping("a\nb\nc\n", &[1, 3]), "b\n");
    }

    #[test]
    fn remove_lines_preserves_crlf_and_missing_final_newline() {
        // CRLF: each kept line keeps its "\r\n".
        assert_eq!(dropping("a\r\nb\r\nc\r\n", &[2]), "a\r\nc\r\n");
        // No trailing newline: the last line ("c") has no terminator; removing a
        // middle line leaves the rest exactly as they were.
        assert_eq!(dropping("a\nb\nc", &[2]), "a\nc");
        // Removing the unterminated last line keeps the prior line's "\n".
        assert_eq!(dropping("a\nb\nc", &[3]), "a\nb\n");
    }

    #[test]
    fn remove_lines_can_empty_the_file_and_ignores_unknown_numbers() {
        // Discarding every line leaves an empty file (whole-file delete is a
        // separate path), and out-of-range numbers are simply ignored.
        assert_eq!(dropping("a\nb\n", &[1, 2]), "");
        assert_eq!(dropping("a\nb\n", &[9]), "a\nb\n");
    }

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    async fn commit_file(repo: &str, dir: &std::path::Path, file: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-m", msg]).await;
    }

    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-rewrite-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit_file(&repo, dir.path(), "a.txt", "v0\n", "base").await;
        (dir, repo)
    }

    async fn rev(repo: &str, r: &str) -> String {
        git(repo, &["rev-parse", r]).await.trim().to_string()
    }

    /// The untracked listing names new files only: tracked ones are already in
    /// the index, and a gitignored one is deliberately absent — it reaches no AI
    /// feature, so the excluded-files corpus must not claim it as disclosure.
    #[tokio::test]
    async fn list_untracked_names_only_new_unignored_files() {
        let (dir, repo) = setup_repo("untracked").await;
        commit_file(&repo, dir.path(), ".gitignore", "secret.log\n", "rules").await;
        std::fs::write(dir.path().join("new.txt"), "n\n").unwrap();
        std::fs::write(dir.path().join("secret.log"), "s\n").unwrap();

        let untracked = git_list_untracked(repo).await.unwrap();
        assert_eq!(untracked, vec!["new.txt".to_string()]);
    }

    async fn subjects(repo: &str) -> Vec<String> {
        git(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The injected budget for every "git failed" test. `run_git` refuses a zero
    /// budget before it spawns anything, so these tests rest on a contract rather
    /// than on scheduling: any nonzero budget — even one that already expired —
    /// races how fast git runs, which is how 1ms passed here and failed on CI's
    /// Linux runners.
    const NO_BUDGET: std::time::Duration = std::time::Duration::ZERO;

    /// Pins the runner's zero-budget contract, both halves: a timeout is reported,
    /// and git never runs (a `git init` under it leaves no repository behind). A
    /// red here means the guard in `run_git_raw_input_bytes` is gone and every
    /// killed-git test below is silently racing the child again.
    #[tokio::test]
    async fn a_zero_budget_times_out_without_running_git() {
        let (dir, repo) = setup_repo("zero-budget").await;
        for i in 0..10 {
            match run_git(Some(&repo), &["rev-parse", "HEAD"], NO_BUDGET).await {
                Err(AppError::Timeout(_)) => {}
                Ok(_) => panic!("iteration {i} ran to completion instead of timing out"),
                Err(e) => panic!("iteration {i} failed for another reason: {e:?}"),
            }
        }
        // The side-effect half: a refused call cannot have spawned git.
        let untouched = dir.path().join("untouched");
        std::fs::create_dir(&untouched).unwrap();
        let path = untouched.to_string_lossy().into_owned();
        assert!(run_git(Some(&path), &["init"], NO_BUDGET).await.is_err());
        assert!(
            !untouched.join(".git").exists(),
            "a zero budget must refuse before spawning, not kill a running git"
        );
    }

    /// The three literals the frontend keys its rollback verdicts on, and the
    /// shape it reads them in: a short leading line carrying exactly one of them,
    /// with git's own conflict output pushed below. Without that the message is
    /// collapsed into "operation paused" — the one state these arms are never in.
    fn assert_verdict_shape(message: &str, literal: &str) {
        const LITERALS: [&str; 3] = [
            "was rolled back",
            "rollback also failed",
            "rollback restored",
        ];
        let first = message.lines().next().unwrap_or_default();
        assert!(
            first.contains(literal),
            "the verdict must lead the message: {message}"
        );
        assert!(
            first.len() <= 90,
            "the verdict line must stay short ({} bytes): {first}",
            first.len()
        );
        assert!(
            !first.contains("could not apply") && !first.contains("CONFLICT ("),
            "git's own conflict output must not front the message: {message}"
        );
        let hits: Vec<&str> = LITERALS
            .iter()
            .copied()
            .filter(|l| message.contains(l))
            .collect();
        assert_eq!(
            hits,
            vec![literal],
            "a verdict carries exactly one contract literal: {message}"
        );
    }

    fn pick(hash: &str) -> RewriteStep {
        RewriteStep {
            hashes: vec![hash.to_string()],
            message: None,
            edit: false,
        }
    }

    #[tokio::test]
    async fn ensure_clean_tree_allows_clean_and_untracked_but_refuses_tracked() {
        let (dir, repo) = setup_repo("clean-tree").await;
        // Clean tree → Ok.
        assert!(ensure_clean_tree(&repo).await.is_ok());
        // Untracked file → still Ok (`reset --hard` never removes it).
        std::fs::write(dir.path().join("scratch.txt"), "x\n").unwrap();
        assert!(ensure_clean_tree(&repo).await.is_ok());
        // Unstaged tracked change → refused (this is the reset --hard loss surface).
        std::fs::write(dir.path().join("a.txt"), "v1\n").unwrap();
        assert!(ensure_clean_tree(&repo).await.is_err());
        // Staged tracked change → refused (the exact incident state).
        git(&repo, &["add", "a.txt"]).await;
        assert!(ensure_clean_tree(&repo).await.is_err());

    }

    /// Working-tree content with line endings normalized: an ambient
    /// `core.autocrlf=true` (the Windows default) materializes committed `\n` as
    /// `\r\n`, which would false-fail every content assertion below.
    fn tree_text(dir: &std::path::Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file))
            .unwrap()
            .replace("\r\n", "\n")
    }

    /// `--hard` mode moves HEAD *and* rewrites the working tree; `--mixed` (the
    /// default every existing caller gets) moves the pointer alone.
    #[tokio::test]
    async fn reset_hard_moves_the_tree_and_mixed_leaves_it() {
        let (dir, repo) = setup_repo("reset-hard").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let state = AppState::default();

        // Default mode: the pointer rewinds, the file keeps the newer content.
        git_reset_core(&state, repo.clone(), base.clone(), None)
            .await
            .expect("mixed reset succeeds");
        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(
            tree_text(dir.path(), "a.txt"),
            "v1\n",
            "a mixed reset must not touch the working tree"
        );

        // Hard mode from a clean tree: both move.
        git(&repo, &["reset", "--hard", &tip]).await;
        git_reset_core(&state, repo.clone(), base.clone(), Some("hard".into()))
            .await
            .expect("hard reset succeeds");
        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(
            tree_text(dir.path(), "a.txt"),
            "v0\n",
            "a hard reset rewrites the working tree to the target commit"
        );
    }

    /// The guard that makes `--hard` safe to offer: uncommitted tracked work is a
    /// typed refusal, not a discarded file. The second half is the destruction
    /// control — the same `reset --hard` run WITHOUT the guard eats the edit, so
    /// the refusal is provably what saved it.
    #[tokio::test]
    async fn reset_hard_refuses_a_dirty_tree_and_leaves_it_untouched() {
        let (dir, repo) = setup_repo("reset-hard-dirty").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        std::fs::write(dir.path().join("a.txt"), "uncommitted work\n").unwrap();
        let state = AppState::default();

        let err = git_reset_core(&state, repo.clone(), base.clone(), Some("hard".into()))
            .await
            .expect_err("a dirty tree must refuse a hard reset");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("uncommitted changes")),
            "the refusal must name the remedy, got {err:?}"
        );
        assert_eq!(
            tree_text(dir.path(), "a.txt"),
            "uncommitted work\n",
            "the edit survives"
        );
        assert_eq!(rev(&repo, "HEAD").await, tip, "and HEAD never moved");

        // Destruction control: git itself has no such scruples.
        git(&repo, &["reset", "--hard", &base]).await;
        assert_eq!(
            tree_text(dir.path(), "a.txt"),
            "v0\n",
            "an unguarded hard reset destroys exactly what the refusal protects"
        );
    }

    /// A paused sequencer sits on a CLEAN tree, so the dirty check alone lets a
    /// hard reset through and strands the operation's markers. The op-state guard
    /// is what refuses it.
    #[tokio::test]
    async fn reset_hard_refuses_while_an_operation_is_in_progress() {
        let (dir, repo) = setup_repo("reset-hard-midop").await;
        let base = rev(&repo, "HEAD").await;
        let start = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        git(&repo, &["switch", &start]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        // A conflicting merge leaves MERGE_HEAD standing.
        let _ = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "feature"],
            DEFAULT_TIMEOUT,
        )
        .await;
        assert!(
            op_state(&repo).await.unwrap().merging,
            "fixture must leave a merge in progress"
        );
        // Resolve back to HEAD's own content so the index matches it and the tree
        // reads CLEAN — this is the whole point: only the operation marker is left
        // to refuse, so a pass here can't be the dirty check doing the work.
        git(&repo, &["checkout", "--ours", "--", "a.txt"]).await;
        git(&repo, &["add", "a.txt"]).await;
        assert!(
            ensure_clean_tree(&repo).await.is_ok(),
            "fixture must leave a CLEAN tree, or this test proves nothing new"
        );

        let state = AppState::default();
        let tip = rev(&repo, "HEAD").await;
        let err = git_reset_core(&state, repo.clone(), base.clone(), Some("hard".into()))
            .await
            .expect_err("a mid-operation hard reset must refuse");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("in progress")),
            "got {err:?}"
        );
        assert_eq!(rev(&repo, "HEAD").await, tip, "HEAD never moved");
        assert!(
            op_state(&repo).await.unwrap().merging,
            "and the operation's markers are still there to finish or abort"
        );
    }

    /// An unrecognized mode is rejected before any git runs, so a typo can never
    /// silently degrade to the destructive arm — or to the harmless one.
    #[tokio::test]
    async fn reset_rejects_an_unknown_mode() {
        let (_dir, repo) = setup_repo("reset-mode").await;
        let base = rev(&repo, "HEAD").await;
        let state = AppState::default();
        let err = git_reset_core(&state, repo, base, Some("keep".into()))
            .await
            .expect_err("unknown modes are refused");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("keep")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn reorder_swaps_independent_commits() {
        let (dir, repo) = setup_repo("reorder").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Oldest-first steps: "two" lands at the bottom, "one" on top.
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);

    }

    #[tokio::test]
    async fn squash_combines_commits() {
        let (dir, repo) = setup_repo("squash").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1, c2],
                message: Some("combined".into()),
                edit: false,
            }],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["combined", "base"]);
        assert!(dir.path().join("b.txt").exists());
        assert!(dir.path().join("c.txt").exists());

    }

    #[tokio::test]
    async fn fixup_keeps_leader_message() {
        let (dir, repo) = setup_repo("fixup").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "keep this message").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "discard me").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Multi-hash step with NO message = fixup: collapse c1+c2 but reuse c1's
        // message ("keep this message"), dropping c2's.
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1, c2],
                message: None,
                edit: false,
            }],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["keep this message", "base"]);
        assert!(dir.path().join("b.txt").exists());
        assert!(dir.path().join("c.txt").exists());

    }

    #[tokio::test]
    async fn conflicting_rewrite_rolls_back() {
        let (dir, repo) = setup_repo("conflict").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // "two"'s patch (v1→v2) can't apply onto v0 — conflict, then rollback.
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)]).await;
        match result {
            Err(AppError::Git { ref stderr, .. }) => {
                // The negative control rides in `assert_verdict_shape`'s
                // exactly-one check: the failed-rollback recovery text must never
                // leak onto the path that did come home.
                assert_verdict_shape(stderr, "was rolled back");
                assert!(
                    stderr.contains("your branch is unchanged"),
                    "a completed rollback must say so: {stderr}"
                );
                // Below the verdict, git's whole report: the replay loop splits it
                // across both streams exactly like `cherry_pick_onto`'s loop.
                assert!(
                    stderr.contains("could not apply")
                        && stderr.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "the verdict must carry git's diagnostic AND its file list: {stderr}"
                );
            }
            Ok(()) => panic!("the conflicting rewrite must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, orig);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");

    }

    /// The multi-hash pick splits its report the same way the single-hash one
    /// does, and it is a separate call site — so it needs its own conflict.
    #[tokio::test]
    async fn conflicting_squash_rolls_back_and_carries_gits_report() {
        let (dir, repo) = setup_repo("conflict-squash").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Squashing them newest-first replays "two"'s patch (v1→v2) onto v0 first,
        // so the `cherry-pick -n` leg conflicts before any commit is attempted.
        let result = rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c2, c1],
                message: Some("combined".into()),
                edit: false,
            }],
        )
        .await;
        match result {
            Err(AppError::Git { ref stderr, .. }) => {
                assert_verdict_shape(stderr, "was rolled back");
                assert!(
                    stderr.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "the verdict must carry git's stdout file list: {stderr}"
                );
            }
            Ok(()) => panic!("the conflicting squash must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, orig);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// The other half of the family: a squash whose commits cancel out fails at
    /// `commit`, which reports on STDOUT alone — a stderr-only error would leave
    /// the verdict with no explanation under it at all.
    #[tokio::test]
    async fn empty_squash_rolls_back_and_carries_gits_report() {
        let (dir, repo) = setup_repo("empty-squash").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        // Restores the base content, so replaying the pair as one commit onto
        // `base` nets an empty tree change.
        commit_file(&repo, dir.path(), "a.txt", "v0\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        let result = rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1, c2],
                message: Some("combined".into()),
                edit: false,
            }],
        )
        .await;
        match result {
            Err(AppError::Git { ref stderr, .. }) => {
                assert_verdict_shape(stderr, "was rolled back");
                // git's whole sentence, not the bare "nothing to commit": the
                // verdict's own cause line already says that much, so the short
                // form passes even when git's report was dropped entirely.
                assert!(
                    stderr.contains("nothing to commit, working tree clean"),
                    "the verdict must carry git's stdout-only report: {stderr}"
                );
            }
            Ok(()) => panic!("the empty squash must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, orig);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// The rollback must run for every failure class, not just a conflict — a
    /// killed pick otherwise leaves the branch rewound onto `base`.
    #[tokio::test]
    async fn rewrite_rolls_back_when_a_step_fails_non_git() {
        let (dir, repo) = setup_repo("rewrite-nongit").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();

        let state = AppState::default();
        // A zero budget fails the pick without running it, so the loop sees
        // AppError::Timeout — the non-Git arm, which passes through untouched once the
        // rollback lands.
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c1)],
            NO_BUDGET,
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Err(AppError::Timeout(_)) => {}
            Ok(()) => panic!("the killed pick must fail"),
            Err(e) => panic!("expected the non-Git arm, got {e:?}"),
        }
        assert_eq!(
            rev(&repo, "HEAD").await,
            orig,
            "a killed step must leave the branch at its pre-run tip"
        );
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// When the rollback itself fails the branch really is left rewritten, so the
    /// error has to name the pre-run tip and both remedies — asserted against the
    /// destruction it warns about, not just the wording.
    #[tokio::test]
    async fn rewrite_failed_rollback_names_the_pre_run_tip_and_remedies() {
        let (dir, repo) = setup_repo("rewrite-rollback-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = c2.clone();

        let state = AppState::default();
        // "two"'s patch (v1→v2) can't apply onto v0 — a real conflict — while the zero
        // rollback budget fails `reset --hard orig` without running it.
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c2), pick(&c1)],
            DEFAULT_TIMEOUT,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "rollback also failed");
                assert!(stderr.contains(&orig), "must name the pre-run tip: {stderr}");
                assert!(
                    stderr.contains("cherry-pick --abort") && stderr.contains("reset --hard"),
                    "must name both remedies: {stderr}"
                );
            }
            Ok(()) => panic!("the conflicting rewrite must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        // The rollback provably never ran (a zero budget refuses before spawning), so
        // the damage is deterministic; a production timeout races it, hence the hedge.
        assert_ne!(
            rev(&repo, "HEAD").await,
            orig,
            "the failed rollback leaves the branch where the replay abandoned it"
        );
        assert_eq!(subjects(&repo).await, vec!["base"]);
        // The abort keeps DEFAULT_TIMEOUT, so nothing is left mid-pick either way.
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
    }

    /// A rewrite that dies on the initial rewind never replayed anything, so its
    /// error must not borrow the replay's detail text: no conflict to blame, and a
    /// branch that never left its tip can't be "partly rewritten".
    #[tokio::test]
    async fn rewrite_rewind_failure_reports_a_branch_that_never_moved() {
        let (dir, repo) = setup_repo("rewrite-rewind-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();

        // A held index.lock fails every `reset --hard` — the rewind and the
        // rollback alike — with no kill race in play, while the read-only guards
        // above still pass (the runner runs git with GIT_OPTIONAL_LOCKS=0).
        let lock = std::path::Path::new(&repo).join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let state = AppState::default();
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c1)]).await;
        // Released before the assertions so a failure can't leave the fixture
        // locked for teardown.
        std::fs::remove_file(&lock).unwrap();

        match result {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "rollback also failed");
                assert!(
                    stderr.contains(&format!("should still be at its original tip {orig}")),
                    "a rewind that never moved HEAD must be described as such: {stderr}"
                );
                assert!(
                    !stderr.contains("partly rewritten") && !stderr.contains("Usually a conflict"),
                    "the replay's detail text must not leak onto the rewind path: {stderr}"
                );
                assert!(
                    stderr.contains("reset --hard"),
                    "must still name the remedy: {stderr}"
                );
            }
            Ok(()) => panic!("the locked rewind must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        // Deterministic, unlike the killed-git arms: no git process ever got the
        // lock, so nothing can have moved.
        assert_eq!(
            rev(&repo, "HEAD").await,
            orig,
            "the failed rewind must leave the branch exactly where it was"
        );
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A non-Git failure whose rollback also fails can't pass through untouched —
    /// the remedies would be lost with it.
    #[tokio::test]
    async fn rewrite_non_git_failure_with_failed_rollback_still_names_the_remedies() {
        let (dir, repo) = setup_repo("rewrite-nongit-rollback-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();

        let state = AppState::default();
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c1)],
            NO_BUDGET,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Command(msg)) => {
                assert_verdict_shape(&msg, "rollback also failed");
                assert!(msg.contains(&orig), "must name the pre-run tip: {msg}");
                assert!(
                    msg.contains("cherry-pick --abort") && msg.contains("reset --hard"),
                    "must name both remedies: {msg}"
                );
            }
            Ok(()) => panic!("the killed pick must fail"),
            Err(e) => panic!("expected the collapsed Command arm, got {e:?}"),
        }
        // The rollback provably never ran (a zero budget refuses before spawning), so
        // the rewound branch is deterministic; a production timeout races it.
        assert_ne!(
            rev(&repo, "HEAD").await,
            orig,
            "the failed rollback leaves the branch rewound onto base"
        );
    }

    /// Negative control for the compound-lock fix: a rewrite that rolls back must
    /// not take a concurrent commit down with it. The second task waits until the
    /// rewrite observably holds the repo lock, then commits the way every other
    /// mutating command does; tokio's fair mutex queues it behind the whole
    /// compound. When the lock was taken per STEP instead, that commit landed
    /// between two cycles and the rollback's `reset --hard orig` destroyed it.
    /// Multi-threaded flavor deliberately: the concurrent task must genuinely run
    /// in parallel instead of starving on a current-thread runtime.
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_commit_survives_a_rolled_back_rewrite() {
        let (dir, repo) = setup_repo("interleave").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "two").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "three").await;
        let c3 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = std::sync::Arc::new(AppState::default());
        let concurrent = {
            let state = state.clone();
            let repo = repo.clone();
            tokio::spawn(async move {
                let domain = state.working_tree_lock(&repo).await;
                // Bounded wait: if the compound somehow finished first we still
                // commit, and the assertions below stay meaningful either way.
                for _ in 0..500 {
                    if domain.lock().try_lock().is_err() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                }
                // The same queue an ordinary mutating caller joins, minus the wait
                // bound: this test pins the compound's ATOMICITY, so a compound that
                // outran `LOCK_WAIT_TIMEOUT` on a loaded runner must not turn it into
                // a Busy failure. Lock-free runner, since the hold is ours.
                let _guard = acquire_repo_lock_unbounded(&domain, "a commit").await;
                run_git(
                    Some(&repo),
                    &["commit", "--allow-empty", "-m", "concurrent"],
                    DEFAULT_TIMEOUT,
                )
                .await
                .expect("the queued commit must succeed once the compound releases");
            })
        };

        // "three"'s patch (v1→v2) can't apply after only "one" replayed, so the
        // SECOND pick conflicts — the compound has already mutated the branch by
        // the time it rolls back.
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c1), pick(&c3)]).await;
        assert!(result.is_err(), "the second pick must conflict");
        concurrent.await.expect("concurrent task panicked");

        let log = subjects(&repo).await;
        assert_eq!(
            log.first().map(String::as_str),
            Some("concurrent"),
            "the concurrent commit must survive the rollback: {log:?}"
        );
        assert_eq!(
            rev(&repo, "HEAD~1").await,
            orig,
            "and it must sit directly on the tip the rewrite rolled back to"
        );
    }

    #[tokio::test]
    async fn cherry_pick_onto_copies_commits_to_the_target_branch() {
        let (dir, repo) = setup_repo("pick-onto").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        let out = cherry_pick_onto(&state, &repo, &[c1, c2], "target")
            .await
            .unwrap();
        assert_eq!((out.applied, out.skipped), (2, 0));
        // Success leaves you ON the target branch, both commits copied in order.
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "target"
        );
        assert_eq!(subjects(&repo).await, vec!["two", "one", "base"]);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A BATCH keeps the rollback — git's sequencer resume isn't wired up, so the
    /// half-applied batch has nowhere to go but back.
    #[tokio::test]
    async fn cherry_pick_onto_batch_conflict_rolls_back_and_returns_home() {
        let (dir, repo) = setup_repo("pick-onto-conflict").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        // The first pick applies cleanly; the second touches the file target
        // diverged on, so the batch fails partway through.
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c2 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "feature"]).await;
        let feature_tip = rev(&repo, "HEAD").await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &[c1, c2], "target").await {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "was rolled back");
                assert!(
                    stderr.contains("target is unchanged"),
                    "the error must tell the user the target is unchanged: {stderr}"
                );
                // Below the verdict, git's whole report: the batch loop splits it
                // across both streams exactly like the single-pick path.
                assert!(
                    stderr.contains("could not apply")
                        && stderr.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "the verdict must carry git's diagnostic AND its file list: {stderr}"
                );
                // git's report ends in --continue/--abort hints that the rollback has
                // already invalidated, so the message must retire them last.
                assert!(
                    stderr
                        .trim_end()
                        .ends_with("git's continue/abort hints above no longer apply."),
                    "the rolled-back verdict must retire git's own hints: {stderr}"
                );
            }
            Ok(_) => panic!("the conflicting pick must fail"),
            Err(e) => panic!("expected a Git error, got {e}"),
        }
        // Rolled fully back: the target's tip is untouched, no pick is in progress,
        // and we're back on the branch we started from.
        assert_eq!(rev(&repo, "target").await, target_tip);
        assert_eq!(rev(&repo, "HEAD").await, feature_tip);
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "feature"
        );
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// One commit that conflicts STOPS on the target instead of rolling back: the
    /// dialog is the app's only route to "send this commit to another branch", so a
    /// rollback would dead-end the user in a terminal.
    #[tokio::test]
    async fn cherry_pick_onto_single_conflict_pauses_on_the_target() {
        let (dir, repo) = setup_repo("pick-onto-single-conflict").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c1 = rev(&repo, "HEAD").await;
        // Diverge target on the same file so the pick can't apply.
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "feature"]).await;
        let feature_tip = rev(&repo, "HEAD").await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &[c1], "target").await {
            Err(AppError::Conflict { op, paths, report }) => {
                assert_eq!(op, "cherry-pick", "the banner's copy table keys on this");
                assert_eq!(paths, vec!["a.txt".to_string()]);
                assert!(
                    report.contains("could not apply")
                        && report.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "the report must carry git's diagnostic AND its file list: {report}"
                );
            }
            Ok(_) => panic!("the conflicting pick must fail"),
            Err(e) => panic!("expected the structured conflict, got {e:?}"),
        }
        // No rollback ran: the pick is still in progress, on the target branch, with
        // the target's own tip intact and the source branch untouched.
        assert!(
            op_state(&repo).await.unwrap().cherry_picking,
            "the paused pick must be visible to the conflict banner"
        );
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "target",
            "resolving happens where the commit is going"
        );
        assert_eq!(rev(&repo, "target").await, target_tip);
        assert_eq!(rev(&repo, "feature").await, feature_tip);
        // A paused op is never a PENDING journal record, so reconcile can't read it
        // as interrupted — the recovery banner must not offer to undo a pick the
        // user is still resolving.
        assert!(
            crate::oplog::git_oplog_check(repo.clone())
                .await
                .unwrap()
                .is_empty(),
            "a paused pick must leave no pending journal entry"
        );
        // The history dialog must not call it "Failed": the deliberate handoff is a
        // pause, and the op has not ended, so it carries no finish time.
        let record = pick_record(&repo).await;
        assert_eq!(record.status, "paused");
        assert!(
            record.finished_at.is_none(),
            "a paused op has not finished: {:?}",
            record.finished_at
        );
    }

    /// The repo's newest journaled `cherry_pick_onto` entry.
    async fn pick_record(repo: &str) -> crate::oplog::OpLogEntry {
        crate::oplog::git_oplog_list(repo.to_string())
            .await
            .expect("the journal must be readable")
            .into_iter()
            .find(|e| e.op == "cherry_pick_onto")
            .expect("the pick must be journaled")
    }

    /// Pause a single-commit pick of `feature`'s edit onto `target`, both diverged on
    /// `a.txt`, and hand back the repo dir plus the target's tip. The shared fixture
    /// behind every paused-record test.
    async fn setup_paused_pick(marker: &str) -> (tempfile::TempDir, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c1 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;

        let state = AppState::default();
        assert!(
            cherry_pick_onto(&state, &repo, &[c1], "target")
                .await
                .is_err(),
            "the fixture's pick must conflict"
        );
        assert_eq!(
            pick_record(&repo).await.status,
            "paused",
            "the fixture must start from a paused journal record"
        );
        (dir, repo, target_tip)
    }

    /// A pick paused with its conflicts staged has a CLEAN tree, so `ensure_clean_tree`
    /// waves a second run through: without the in-progress guard the user meets git's
    /// raw "cannot switch branch while cherry-picking" instead of the app's own
    /// refusal, and the resolution they staged is one `cherry-pick <hash>` away from
    /// being replaced by fresh conflict stages (measured, git 2.51.1).
    #[tokio::test]
    async fn cherry_pick_onto_refuses_while_a_pick_is_in_progress() {
        let (dir, repo) = setup_repo("pick-onto-reentry").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c1 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;

        // Pause a pick on target and resolve it all-ours, which stages a resolution
        // AND leaves the tree clean.
        let state = AppState::default();
        assert!(cherry_pick_onto(&state, &repo, std::slice::from_ref(&c1), "target")
            .await
            .is_err());
        git(&repo, &["checkout", "--ours", "a.txt"]).await;
        git(&repo, &["add", "a.txt"]).await;
        let staged = git(&repo, &["ls-files", "--unmerged"]).await;
        assert!(
            staged.trim().is_empty(),
            "the fixture must start from a RESOLVED index: {staged}"
        );
        let tracked = git(&repo, &["status", "--porcelain", "--untracked-files=no"]).await;
        assert!(
            tracked.trim().is_empty(),
            "and from a clean tree, or the guard under test isn't the one refusing: {tracked}"
        );

        match cherry_pick_onto(&state, &repo, &[c1], "target").await {
            Err(AppError::InvalidArgument(msg)) => {
                assert!(
                    msg.starts_with("Can't cherry-pick while") && msg.contains("in progress"),
                    "the refusal is the toast summary verbatim, so it reads as a sentence: {msg}"
                );
            }
            Ok(_) => panic!("a second pick must be refused while one is in progress"),
            Err(e) => panic!("expected the app's own refusal, got {e:?}"),
        }
        // The staged resolution and the paused pick both survive untouched.
        assert!(
            git(&repo, &["ls-files", "--unmerged"]).await.trim().is_empty(),
            "the refusal must not re-conflict the resolved index"
        );
        assert!(op_state(&repo).await.unwrap().cherry_picking);
        assert_eq!(rev(&repo, "target").await, target_tip);
    }

    /// `classify_failure`'s pass-through arm: a pick that fails WITHOUT adding a
    /// conflict is still a plain `AppError::Git`, so a single commit takes the
    /// rollback exactly as it did before the stop arm existed. A merge commit
    /// without `-m` is the cheapest such failure.
    #[tokio::test]
    async fn cherry_pick_onto_rolls_back_a_single_non_conflict_failure() {
        let (dir, repo) = setup_repo("pick-onto-merge-commit").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        git(&repo, &["checkout", "-b", "side"]).await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        git(&repo, &["checkout", "feature"]).await;
        git(&repo, &["merge", "--no-ff", "-m", "merge side", "side"]).await;
        let merge_commit = rev(&repo, "HEAD").await;
        let feature_tip = merge_commit.clone();
        let target_tip = rev(&repo, "target").await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &[merge_commit], "target").await {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "was rolled back");
                assert!(
                    stderr.contains("is a merge but no -m option was given"),
                    "git's own reason must survive the pass-through: {stderr}"
                );
            }
            Ok(_) => panic!("cherry-picking a merge commit without -m must fail"),
            Err(e) => panic!("expected the pass-through Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "target").await, target_tip);
        assert_eq!(rev(&repo, "HEAD").await, feature_tip);
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
    }

    /// Continue on an all-ours resolution: the pick has nothing left to commit, so
    /// git refuses `--continue` and asks for `--skip` (measured, git 2.51.1). The
    /// banner's Continue has to take that escape, or the state P1's pause makes
    /// routine dead-ends in the UI.
    #[tokio::test]
    async fn op_continue_finishes_a_cherry_pick_emptied_by_its_resolution() {
        let (_dir, repo, target_tip) = setup_paused_pick("continue-empty-pick").await;
        git(&repo, &["checkout", "--ours", "a.txt"]).await;
        git(&repo, &["add", "a.txt"]).await;

        let state = AppState::default();
        let recorded = op_continue(&state, &repo, "cherry-pick")
            .await
            .expect("continue must finish a pick emptied by its own resolution");
        assert!(
            !recorded,
            "the skipped pick recorded no commit, and the banner's copy keys on that"
        );
        assert!(
            !op_state(&repo).await.unwrap().cherry_picking,
            "the escape must leave nothing in progress"
        );
        // Nothing was committed: the resolution kept the target's own content.
        assert_eq!(rev(&repo, "HEAD").await, target_tip);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
        // The skip ended the op, so its paused journal record closes too.
        assert_eq!(pick_record(&repo).await.status, "done");
    }

    /// Aborting a paused pick closes its record as the user's own abandonment, in the
    /// same words the local-PR merge abort uses.
    #[tokio::test]
    async fn op_abort_closes_the_paused_pick_record_as_aborted() {
        let (_dir, repo, target_tip) = setup_paused_pick("abort-closes-record").await;

        let state = AppState::default();
        op_abort(&state, &repo, "cherry-pick")
            .await
            .expect("aborting a paused pick must succeed");
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
        assert_eq!(rev(&repo, "HEAD").await, target_tip);

        let record = pick_record(&repo).await;
        assert_eq!(record.status, "failed");
        assert_eq!(record.error.as_deref(), Some("aborted by user"));
        assert!(record.finished_at.is_some());
    }

    /// The sibling arm: a resolution that keeps content of its own DOES commit, so
    /// the same call answers true and the banner says the pick continued — and the
    /// paused journal record closes with it.
    #[tokio::test]
    async fn op_continue_reports_a_recorded_commit_for_a_resolved_cherry_pick() {
        let (dir, repo, target_tip) = setup_paused_pick("continue-resolved-pick").await;
        std::fs::write(dir.path().join("a.txt"), "merged\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;

        let state = AppState::default();
        let recorded = op_continue(&state, &repo, "cherry-pick")
            .await
            .expect("a resolved pick must continue");
        assert!(recorded, "a pick that commits must answer true");
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
        assert_ne!(
            rev(&repo, "HEAD").await,
            target_tip,
            "the resolution must have landed as a commit"
        );
        let record = pick_record(&repo).await;
        assert_eq!(record.status, "done");
        assert!(
            record.finished_at.is_some(),
            "a closed record must carry its finish time"
        );
        assert_eq!(record.error, None, "a continued pick is not a failure");
    }

    /// git's own conflict advice offers `git commit`, and the commit box has no
    /// mid-op gate, so a paused pick can be concluded without `--continue` ever
    /// running. The journal must close its record on that route too, or the next
    /// in-app abort of any pick reads the stale record as "aborted by user".
    /// (Exercises `git::commit::git_commit_core`; the fixture lives here.)
    #[tokio::test]
    async fn a_commit_closes_the_paused_cherry_pick_record() {
        let (dir, repo, target_tip) = setup_paused_pick("commit-closes-record").await;
        std::fs::write(dir.path().join("a.txt"), "merged\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;

        let state = AppState::default();
        crate::git::commit::git_commit_core(
            &state,
            repo.clone(),
            "resolve the pick".to_string(),
            None,
            false,
        )
        .await
        .expect("the commit box must be able to conclude a resolved pick");
        assert!(
            !op_state(&repo).await.unwrap().cherry_picking,
            "the commit must have concluded the pick"
        );
        assert_ne!(rev(&repo, "HEAD").await, target_tip);

        let record = pick_record(&repo).await;
        assert_eq!(record.status, "done");
        assert!(record.finished_at.is_some());
        assert_eq!(record.error, None);
    }

    /// The commit route's gate, from the other side: a pick concluded OUTSIDE the app
    /// leaves its record paused by design, and every ordinary commit afterwards must
    /// leave it alone. Without the was-picking gate the widest close route would flip
    /// whatever stale record the repo still holds on the user's next unrelated commit.
    #[tokio::test]
    async fn an_ordinary_commit_leaves_a_stale_paused_record_alone() {
        let (dir, repo, _target_tip) = setup_paused_pick("commit-leaves-stale-record").await;
        git(&repo, &["cherry-pick", "--abort"]).await;
        assert!(
            !op_state(&repo).await.unwrap().cherry_picking,
            "the out-of-app abort must have ended the pick"
        );
        assert_eq!(
            pick_record(&repo).await.status,
            "paused",
            "nothing in-app closed it, so the record is the stale one this pins"
        );

        std::fs::write(dir.path().join("unrelated.txt"), "unrelated\n").unwrap();
        git(&repo, &["add", "unrelated.txt"]).await;
        let state = AppState::default();
        crate::git::commit::git_commit_core(
            &state,
            repo.clone(),
            "an unrelated change".to_string(),
            None,
            false,
        )
        .await
        .expect("an ordinary commit must succeed");

        let record = pick_record(&repo).await;
        assert_eq!(
            record.status, "paused",
            "no pick was in progress, so this commit concluded nothing"
        );
        assert!(record.finished_at.is_none());
    }

    /// Only a CONFLICT stops on the target; every other failure class still rolls
    /// back, single commit included — a killed pick otherwise leaves HEAD on the
    /// target with nothing for the user to resolve.
    #[tokio::test]
    async fn cherry_pick_onto_rolls_back_when_a_pick_fails_non_git() {
        let (dir, repo) = setup_repo("pick-onto-nongit").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let feature_tip = c1.clone();
        let target_tip = rev(&repo, "target").await;

        let state = AppState::default();
        // A zero budget fails the pick without running it, so the loop sees
        // AppError::Timeout — the non-Git arm. Everything else (switch, rollback) keeps
        // the real timeout, so the state below is the completed rollback's.
        match cherry_pick_onto_with_timeouts(
            &state,
            &repo,
            &[c1],
            "target",
            NO_BUDGET,
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Err(AppError::Timeout(_)) => {}
            Ok(_) => panic!("the killed pick must fail"),
            Err(e) => panic!("expected the non-Git arm, got {e:?}"),
        }
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .trim(),
            "feature",
            "a failed pick must leave you on the branch you started from"
        );
        assert_eq!(rev(&repo, "HEAD").await, feature_tip);
        assert_eq!(rev(&repo, "target").await, target_tip);
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A rollback that fails can leave the batch's commits on the target, so the
    /// error has to name its prior tip and both remedies.
    #[tokio::test]
    async fn cherry_pick_onto_failed_rollback_names_the_pre_run_tip_and_remedies() {
        let (dir, repo) = setup_repo("pick-onto-rollback-fail").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        // First pick applies cleanly; the second touches the file target diverged on.
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c2 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "feature"]).await;

        let state = AppState::default();
        // The zero rollback budget fails `reset --hard target_tip` and the restore
        // switch without running either; the picks themselves keep the real timeout,
        // so the second one is a genuine conflict.
        match cherry_pick_onto_with_timeouts(
            &state,
            &repo,
            &[c1, c2],
            "target",
            DEFAULT_TIMEOUT,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "rollback also failed");
                assert!(
                    stderr.contains(&target_tip),
                    "must name the target's prior tip: {stderr}"
                );
                assert!(
                    stderr.contains("cherry-pick --abort") && stderr.contains("reset --hard"),
                    "must name both remedies: {stderr}"
                );
            }
            Ok(_) => panic!("the conflicting pick must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        // Neither rollback step ran (a zero budget refuses before spawning), so the
        // damage is deterministic; a production timeout races it, hence the hedge.
        assert_ne!(
            rev(&repo, "target").await,
            target_tip,
            "the failed reset leaves this batch's first commit on target"
        );
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "target",
            "and the failed restore switch leaves you there"
        );
        // The abort keeps DEFAULT_TIMEOUT, so nothing is left mid-pick either way.
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
    }

    /// A non-Git failure whose rollback also fails can't pass through untouched —
    /// the remedies would be lost with it.
    #[tokio::test]
    async fn cherry_pick_onto_non_git_failure_with_failed_rollback_names_the_remedies() {
        let (dir, repo) = setup_repo("pick-onto-nongit-rollback-fail").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let target_tip = rev(&repo, "target").await;

        let state = AppState::default();
        match cherry_pick_onto_with_timeouts(
            &state,
            &repo,
            &[c1],
            "target",
            NO_BUDGET,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Command(msg)) => {
                assert_verdict_shape(&msg, "rollback also failed");
                assert!(
                    msg.contains(&target_tip),
                    "must name the target's prior tip: {msg}"
                );
                assert!(
                    msg.contains("cherry-pick --abort") && msg.contains("reset --hard"),
                    "must name both remedies: {msg}"
                );
            }
            Ok(_) => panic!("the killed pick must fail"),
            Err(e) => panic!("expected the collapsed Command arm, got {e:?}"),
        }
        // The restore switch provably never ran (a zero budget refuses before
        // spawning); a production timeout races it, which is why the message hedges.
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "target",
            "the failed restore switch leaves you on the target"
        );
    }

    #[tokio::test]
    async fn rebase_edit_refuses_a_concurrent_op() {
        let (dir, repo) = setup_repo("reentry").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "x.txt", "x\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        // Simulate an in-progress rebase via its marker dir.
        std::fs::create_dir_all(std::path::Path::new(&repo).join(".git/rebase-merge"))
            .unwrap();
        let step = RewriteStep {
            hashes: vec![c1],
            message: None,
            edit: true,
        };
        let result = git_rebase_edit(repo.clone(), base, vec![step]).await;
        assert!(
            result.is_err(),
            "must refuse a new edit-rebase while one is in progress"
        );
        // The guard runs before the scratch-dir clear, so it's never created —
        // the in-flight rebase's message files are left untouched.
        assert!(
            !std::path::Path::new(&repo)
                .join(".git/gd-rebase-edit")
                .exists(),
            "scratch dir must not be touched when refused"
        );

    }

    /// The state the app's own squash/fixup engine creates: a multi-hash
    /// `cherry-pick -n` that conflicts leaves `.git/sequencer` and NO
    /// `CHERRY_PICK_HEAD` (measured, git 2.51.1), which every marker-file gate
    /// used to read as "nothing in flight".
    #[tokio::test]
    async fn op_state_sees_a_sequencer_only_cherry_pick() {
        let (dir, repo) = setup_repo("seq-pick").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "f1\n", "feat one").await;
        commit_file(&repo, dir.path(), "a.txt", "f2\n", "feat two").await;
        let f1 = rev(&repo, "feature~1").await;
        let f2 = rev(&repo, "feature").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        let tip = rev(&repo, "HEAD").await;

        let attempt = run_git_raw(
            Some(&repo),
            &["cherry-pick", "-n", &f1, &f2],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(attempt.code, 0, "the multi-hash pick should conflict");
        assert!(
            !git_path_exists(&repo, "CHERRY_PICK_HEAD").await,
            "`-n` writes no CHERRY_PICK_HEAD — the whole point of the sequencer probe"
        );

        let state = op_state(&repo).await.unwrap();
        assert!(state.cherry_picking, "the sequencer names the pick");
        assert!(!state.reverting);
        assert!(op_in_progress(&repo).await);

        // Reachable through the guard that clears another op's pending files. The
        // message is load-bearing: the dirty-tree guard below it also refuses this
        // tree, so only the wording proves WHICH guard caught it.
        let refused = git_rebase_edit(repo.clone(), tip, vec![pick(&f1)]).await;
        let Err(AppError::InvalidArgument(msg)) = &refused else {
            panic!("edit-rebase must refuse over sequencer state, got {refused:?}");
        };
        assert!(
            msg.starts_with("Can't edit history while"),
            "the mid-op guard must be the one that refuses: {msg}"
        );
    }

    /// A conflicted `git revert` is its own operation: labeled as a revert, never
    /// folded into cherry-pick (which would hand Continue the wrong git command).
    #[tokio::test]
    async fn op_state_sees_a_revert_and_continues_it() {
        let (dir, repo) = setup_repo("revert-op").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let target = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;

        let revert = run_git_raw(
            Some(&repo),
            &["revert", "--no-edit", &target],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(revert.code, 0, "the revert should conflict");

        let state = op_state(&repo).await.unwrap();
        assert!(state.reverting);
        assert!(!state.cherry_picking, "a revert is not a cherry-pick");
        assert!(op_in_progress(&repo).await);

        // The `revert` arms of validate_op / op_continue are now reachable.
        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;
        let app = AppState::default();
        op_continue(&app, &repo, "revert").await.unwrap();
        assert!(!op_state(&repo).await.unwrap().reverting);
        assert_eq!(subjects(&repo).await.len(), 4, "the revert commit landed");
    }

    /// Every flag counts, and `edit_paused` alone does not — the gates that once
    /// re-listed these fields each missed a different one, so the predicate they
    /// now share is pinned per flag rather than through any single caller.
    #[test]
    fn mid_op_covers_every_operation_flag() {
        let clear = RepoOpState {
            merging: false,
            rebasing: false,
            cherry_picking: false,
            reverting: false,
            edit_paused: false,
        };
        assert!(!clear.mid_op(), "a quiet repo is not mid-op");
        for set in [
            |s: &mut RepoOpState| s.merging = true,
            |s: &mut RepoOpState| s.rebasing = true,
            |s: &mut RepoOpState| s.cherry_picking = true,
            |s: &mut RepoOpState| s.reverting = true,
        ] {
            let mut state = clear.clone();
            set(&mut state);
            assert!(state.mid_op(), "{state:?} is mid-op");
        }
        let mut paused = clear.clone();
        paused.edit_paused = true;
        assert!(
            !paused.mid_op(),
            "edit_paused qualifies `rebasing`; it never stands alone"
        );
    }

    /// The sequencer's verb decides which op it is; anything unreadable stays a
    /// cherry-pick, matching the best-effort contract of the probes around it.
    #[tokio::test]
    async fn sequencer_verb_discriminates_revert_from_cherry_pick() {
        let (_dir, repo) = setup_repo("seq-verb").await;
        let seq = std::path::Path::new(&repo).join(".git/sequencer");
        std::fs::create_dir_all(&seq).unwrap();

        std::fs::write(seq.join("todo"), "revert abc1234 undo it\n").unwrap();
        let state = op_state(&repo).await.unwrap();
        assert!(state.reverting && !state.cherry_picking);

        std::fs::write(seq.join("todo"), "pick abc1234 add it\n").unwrap();
        let state = op_state(&repo).await.unwrap();
        assert!(state.cherry_picking && !state.reverting);

        std::fs::write(seq.join("todo"), "").unwrap();
        let state = op_state(&repo).await.unwrap();
        assert!(state.cherry_picking && !state.reverting);

        std::fs::remove_dir_all(&seq).unwrap();
        let state = op_state(&repo).await.unwrap();
        assert!(!state.cherry_picking && !state.reverting);
    }

    /// A linked worktree keeps its op markers under
    /// `<main>/.git/worktrees/<name>/`, so the banner and every mid-op guard read
    /// the WRONG tree unless the git dir is resolved with `--absolute-git-dir`:
    /// under the common dir the FIRST assertion below fails. The second is a
    /// redundancy check that the marker really is worktree-local — it reads the
    /// main `.git` either way, so it discriminates nothing on its own.
    #[tokio::test]
    async fn op_state_reads_a_linked_worktrees_own_markers() {
        let (dir, repo) = setup_repo("worktree-markers").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        let tip = rev(&repo, "HEAD").await;

        // Outside the repo's own tree, so the checkout isn't a nested untracked
        // directory; both temp dirs are removed when the test ends.
        let link_dir = tempfile::Builder::new()
            .prefix("gd-rewrite-worktree-link-")
            .tempdir()
            .expect("create temp dir");
        let link = link_dir.path().join("linked").to_string_lossy().into_owned();
        git(&repo, &["worktree", "add", "--detach", &link, &tip]).await;

        let merge = run_git_raw(
            Some(&link),
            &["merge", "--no-edit", "feature"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merge.code, 0, "the merge inside the worktree should conflict");

        assert!(
            op_state(&link).await.unwrap().merging,
            "the worktree's own MERGE_HEAD must be the one that's read"
        );
        assert!(op_in_progress(&link).await);
        assert!(
            !op_state(&repo).await.unwrap().merging,
            "and the main checkout stays quiet — nothing is in progress there"
        );

        git(&repo, &["worktree", "remove", "--force", &link]).await;
    }

    /// The commit path's spawn-free probe has to follow the one-line `gitdir:`
    /// pointer a linked worktree leaves in place of `.git`, or a pick paused in a
    /// worktree would close no journal record when the commit box concludes it.
    #[tokio::test]
    async fn cherry_pick_marker_probe_follows_a_worktrees_gitdir_pointer() {
        let (dir, repo) = setup_repo("worktree-pick-marker").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        let c1 = rev(&repo, "HEAD").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        let tip = rev(&repo, "HEAD").await;

        let link_dir = tempfile::Builder::new()
            .prefix("gd-rewrite-worktree-pick-")
            .tempdir()
            .expect("create temp dir");
        let link = link_dir.path().join("linked").to_string_lossy().into_owned();
        git(&repo, &["worktree", "add", "--detach", &link, &tip]).await;
        assert!(
            !cherry_pick_marker_present(&link),
            "nothing is picking in the fresh worktree"
        );

        let pick = run_git_raw(Some(&link), &["cherry-pick", &c1], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(pick.code, 0, "the pick inside the worktree should conflict");
        assert!(
            cherry_pick_marker_present(&link),
            "the worktree's own CHERRY_PICK_HEAD must be found through its gitdir pointer"
        );
        assert!(
            !cherry_pick_marker_present(&repo),
            "and the main checkout has no pick of its own"
        );

        git(&repo, &["worktree", "remove", "--force", &link]).await;
    }

    /// The same probe against a RELATIVE `gitdir:` pointer, which a submodule always
    /// writes (`gitdir: ../.git/modules/<name>`) and a worktree writes under
    /// `worktree.useRelativePaths` (`gitdir: ../<main>/.git/worktrees/<name>`) — both
    /// shapes measured, git 2.51.1. Resolving one against the process CWD instead of
    /// the tree holding the `.git` file would answer "no pick" and silently skip the
    /// close. The pointer is written by hand: a live submodule needs a second repo
    /// plus `protocol.file.allow`, and `--relative-paths` needs git >= 2.48, which
    /// the CI matrix's runners don't all carry.
    #[test]
    fn cherry_pick_marker_probe_resolves_a_relative_gitdir_pointer() {
        let tmp = tempfile::Builder::new()
            .prefix("gd-relative-gitdir-")
            .tempdir()
            .expect("create temp dir");
        let tree = tmp.path().join("tree");
        let real_git_dir = tmp.path().join("real/.git/modules/mod");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::create_dir_all(&real_git_dir).unwrap();
        std::fs::write(tree.join(".git"), "gitdir: ../real/.git/modules/mod\n").unwrap();
        let repo = tree.to_string_lossy().into_owned();

        assert!(
            !cherry_pick_marker_present(&repo),
            "no marker file, no pick — the pointer alone proves nothing"
        );
        std::fs::write(real_git_dir.join("CHERRY_PICK_HEAD"), "deadbeef\n").unwrap();
        assert!(
            cherry_pick_marker_present(&repo),
            "a relative pointer resolves against the tree holding the .git file"
        );
    }

    /// The tolerance both spawn-free `.git` resolutions share: the line-scanning form,
    /// which reads a pointer past stray leading lines. Its failure direction is the
    /// safe one for both callers — an unresolvable pointer means "no markers" / "no
    /// activity", never an error.
    #[test]
    fn a_junk_prefixed_gitdir_pointer_resolves_for_both_entry_points() {
        let tmp = tempfile::Builder::new()
            .prefix("gd-junk-gitdir-")
            .tempdir()
            .expect("create temp dir");
        let tree = tmp.path().join("tree");
        let admin = tmp.path().join("real/.git/worktrees/wt");
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(
            tree.join(".git"),
            "# stray leading line\ngitdir: ../real/.git/worktrees/wt\n",
        )
        .unwrap();
        let tree_s = tree.to_string_lossy().into_owned();

        assert!(
            resolve_git_admin_dir(&tree).is_some(),
            "the pointer is found past the junk line"
        );
        std::fs::write(admin.join("CHERRY_PICK_HEAD"), "deadbeef\n").unwrap();
        assert!(
            cherry_pick_marker_present(&tree_s),
            "the op-marker probe reads through it"
        );
        std::fs::write(admin.join("index"), b"idx").unwrap();
        assert!(
            crate::git::worktree::worktree_last_activity_ms(&tree_s).is_some(),
            "and so does the worktree activity probe"
        );
    }

    /// The probe `op_continue` consults while holding the repo lock: a rebase that
    /// STOPPED must read true and an aborted one false, or a guarded pull's drop
    /// record closes at the wrong moment — mid-rebase, or never. Both marker dirs
    /// count, because the probe is an OR over the pair: the default merge backend
    /// writes `rebase-merge`, `--apply` writes `rebase-apply`.
    #[tokio::test]
    async fn rebase_marker_probe_tracks_a_paused_rebase() {
        let (dir, repo) = setup_repo("rebase-marker").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        git(&repo, &["switch", "feature"]).await;

        assert!(!rebase_marker_present(&repo), "nothing is rebasing yet");

        for backend in [Vec::new(), vec!["--apply"]] {
            let mut argv = vec!["rebase"];
            argv.extend(backend.iter().copied());
            argv.push(&base);
            let out = run_git_raw(Some(&repo), &argv, DEFAULT_TIMEOUT).await.unwrap();
            assert_ne!(out.code, 0, "the rebase should conflict: {argv:?}");
            assert!(
                rebase_marker_present(&repo),
                "a stopped rebase leaves its marker dir: {argv:?}"
            );
            git(&repo, &["rebase", "--abort"]).await;
            assert!(
                !rebase_marker_present(&repo),
                "and the abort clears it: {argv:?}"
            );
        }
    }

    /// The rebase twin of the pick probe above: the same spawn-free lookup has to
    /// follow a linked worktree's one-line `gitdir:` pointer, or a guarded pull
    /// paused in a worktree would read as finished and close its record mid-rebase.
    #[tokio::test]
    async fn rebase_marker_probe_follows_a_worktrees_gitdir_pointer() {
        let (dir, repo) = setup_repo("worktree-rebase-marker").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        let feature_tip = rev(&repo, "HEAD").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        let tip = rev(&repo, "HEAD").await;

        let link_dir = tempfile::Builder::new()
            .prefix("gd-worktree-rebase-marker-")
            .tempdir()
            .expect("create temp dir");
        let link = link_dir.path().join("linked").to_string_lossy().into_owned();
        git(&repo, &["worktree", "add", "--detach", &link, &feature_tip]).await;
        assert!(
            !rebase_marker_present(&link),
            "nothing is rebasing in the fresh worktree"
        );

        let out = run_git_raw(Some(&link), &["rebase", &tip], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(out.code, 0, "the rebase inside the worktree should conflict");
        assert!(
            rebase_marker_present(&link),
            "the worktree's own marker must be found through its gitdir pointer"
        );
        assert!(
            !rebase_marker_present(&repo),
            "and the main checkout has no rebase of its own"
        );

        git(&repo, &["worktree", "remove", "--force", &link]).await;
    }

    /// Conflicted revert / cherry-pick / rebase all split ONE report across both
    /// streams: the diagnostic on stderr, the conflicted-file list on stdout. An
    /// error carrying either alone looks populated while dropping exactly what
    /// the user needs to decide how to resolve — and each leaves the repo PAUSED,
    /// which the structured variant says outright instead of by prose match.
    #[tokio::test]
    async fn a_conflicted_revert_carries_both_streams() {
        let (dir, repo) = setup_repo("revert-details").await;
        commit_file(&repo, dir.path(), "a.txt", "one\n", "one").await;
        let target = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "two\n", "two").await;

        let state = AppState::default();
        let err = git_revert_core(&state, repo.clone(), target)
            .await
            .unwrap_err();
        assert_both_streams(&err, "revert", "could not revert");
    }

    #[tokio::test]
    async fn a_conflicted_cherry_pick_carries_both_streams() {
        let (dir, repo) = setup_repo("pick-details").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        let feature = rev(&repo, "HEAD").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;

        let state = AppState::default();
        let err = git_cherry_pick_core(&state, repo.clone(), feature)
            .await
            .unwrap_err();
        assert_both_streams(&err, "cherry-pick", "could not apply");
    }

    #[tokio::test]
    async fn a_conflicted_rebase_carries_both_streams() {
        let (dir, repo) = setup_repo("rebase-details").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;

        let state = AppState::default();
        let err = git_rebase_core(&state, repo.clone(), "feature".into())
            .await
            .unwrap_err();
        assert_both_streams(&err, "rebase", "ould not apply");
    }

    /// `rebase --onto` shares the shaping but not the argv, so it gets its own
    /// conflict test: `fix` branched off `feature` (the wrong base) and replaying
    /// only its own commits onto the default branch collides there.
    #[tokio::test]
    async fn a_conflicted_rebase_onto_carries_both_streams() {
        let (dir, repo) = setup_repo("rebase-onto-conflict").await;
        let main = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "f.txt", "f\n", "feature edit").await;
        git(&repo, &["switch", "-c", "fix"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "fix edit").await;
        git(&repo, &["switch", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        git(&repo, &["switch", "fix"]).await;

        let state = AppState::default();
        let err = rebase_onto(&state, &repo, &main, "feature")
            .await
            .unwrap_err();
        assert_both_streams(&err, "rebase", "ould not apply");
        assert!(op_state(&repo).await.unwrap().rebasing);
    }

    /// The one stdout-ONLY case in the family: `--continue` with paths still
    /// unmerged names them on stdout and writes nothing to stderr, which a
    /// stderr-only error renders to the user as "git exited with code 1".
    #[tokio::test]
    async fn a_refused_continue_names_the_unresolved_file() {
        let (dir, repo) = setup_repo("continue-unresolved").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;

        let state = AppState::default();
        assert!(
            git_rebase_core(&state, repo.clone(), "feature".into())
                .await
                .is_err(),
            "the rebase must conflict for --continue to have something to refuse"
        );

        let err = op_continue(&state, &repo, "rebase").await.unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        // The caller's own op passes through: this refusal names no operation, and
        // a `--continue` that did nothing leaves no diagnostic to read one from.
        assert_eq!(op, "rebase");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("a.txt: needs merge"),
            "the refusal must name the unresolved file: {report}"
        );
    }

    /// The paused operation is named, the conflicted file listed, and both halves
    /// of git's report reached `report`: `diagnostic` on stderr, and the
    /// `CONFLICT (…` file list on stdout.
    fn assert_both_streams(err: &AppError, op: &str, diagnostic: &str) {
        let AppError::Conflict {
            op: named,
            paths,
            report,
        } = err
        else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(named, op, "the paused operation must be named");
        assert_eq!(
            paths,
            &vec!["a.txt".to_string()],
            "the conflicted file must be listed"
        );
        assert!(
            report.contains(diagnostic),
            "stderr's own diagnostic ({diagnostic:?}) must survive: {report}"
        );
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "and stdout's conflicted-file list with it: {report}"
        );
    }

    /// A stash holding an edit to `a.txt`, and a committed `a.txt` in the way, so
    /// reapplying it conflicts. git keeps the entry either way (measured, 2.51.1).
    async fn stash_over_a_conflicting_commit(marker: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        std::fs::write(dir.path().join("a.txt"), "mine\n").unwrap();
        git(&repo, &["stash", "push", "--include-untracked"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "diverge").await;
        (dir, repo)
    }

    /// The whole stash family reports a conflict on stdout with stderr EMPTY, so a
    /// stderr-only error rendered as "git exited with code 1" — and said nothing
    /// about the entry git kept.
    fn assert_stash_conflict(err: &AppError, expected_op: &str) {
        let AppError::Conflict { op, paths, report } = err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, expected_op);
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "the stdout-only report must survive: {report}"
        );
    }

    #[tokio::test]
    async fn a_conflicted_stash_pop_names_its_op_and_keeps_the_entry() {
        let (_dir, repo) = stash_over_a_conflicting_commit("stash-pop-conflict").await;
        let state = AppState::default();

        let err = git_stash_pop_core(&state, repo.clone()).await.unwrap_err();
        assert_stash_conflict(&err, "stash-pop");
        // The copy this drives promises the stash is still there — pin that.
        assert!(
            !git(&repo, &["stash", "list"]).await.trim().is_empty(),
            "a conflicted pop keeps the entry"
        );
    }

    #[tokio::test]
    async fn a_conflicted_stash_apply_names_the_sub_command_it_ran() {
        let (_dir, repo) = stash_over_a_conflicting_commit("stash-apply-conflict").await;
        let state = AppState::default();

        let err = git_stash_apply_core(&state, repo.clone(), 0, false)
            .await
            .unwrap_err();
        assert_stash_conflict(&err, "stash-apply");

        // The same entrypoint with `pop` set names the other op.
        git(&repo, &["checkout", "--ours", "a.txt"]).await;
        git(&repo, &["reset", "--hard", "HEAD"]).await;
        let err = git_stash_apply_core(&state, repo.clone(), 0, true)
            .await
            .unwrap_err();
        assert_stash_conflict(&err, "stash-pop");
    }

    /// The orphaned path takes its OWN op: the entry it restores is dangling —
    /// dropped from the list, as this fixture does — so the stash-apply copy's
    /// promise that "your stash was kept" would send the user to a `stash list`
    /// that no longer holds their work.
    #[tokio::test]
    async fn a_conflicted_orphaned_restore_takes_its_own_op() {
        let (_dir, repo) = stash_over_a_conflicting_commit("stash-orphan-conflict").await;
        // Browse the entry by sha, then drop it: that dangling commit is exactly
        // what the orphaned-stash restore is handed.
        let sha = rev(&repo, "stash@{0}").await;
        git(&repo, &["stash", "drop"]).await;
        assert!(
            git(&repo, &["stash", "list"]).await.trim().is_empty(),
            "the fixture's entry really is off the list"
        );
        let state = AppState::default();

        let err = git_restore_orphaned_core(&state, repo.clone(), sha)
            .await
            .unwrap_err();
        assert_stash_conflict(&err, "stash-restore");
    }

    /// A tree already paused on conflicts, so every op below fails by BOUNCING
    /// off the unmerged index rather than adding to it. The pre-op baseline is
    /// what keeps the paused merge's files from being re-attributed to whichever
    /// op merely refused — the toast would otherwise name an operation the
    /// conflict banner (which reads op_state) disagrees with.
    async fn repo_paused_on_a_conflicted_merge(marker: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "side"]).await;
        commit_file(&repo, dir.path(), "a.txt", "theirs\n", "side edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
        let merge = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "side"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merge.code, 0, "the fixture's merge must conflict");
        assert_eq!(unmerged_paths(&repo).await, vec!["a.txt".to_string()]);
        assert!(op_state(&repo).await.unwrap().merging);
        (dir, repo)
    }

    /// Popping with NOTHING to pop, on a tree already paused on a merge: git
    /// answers "No stash entries found." without touching the index, so the
    /// paused merge's file is still the only unmerged path. Attributing it to the
    /// pop would tell the user their stash was kept when there was never a stash.
    #[tokio::test]
    async fn a_stashless_pop_on_a_paused_tree_is_not_a_stash_conflict() {
        let (_dir, repo) = repo_paused_on_a_conflicted_merge("stash-pop-misattrib").await;
        let state = AppState::default();

        let err = git_stash_pop_core(&state, repo.clone()).await.unwrap_err();
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a plain git error, got {err:?}");
        };
        assert!(
            stderr.contains("No stash entries found"),
            "git's own answer must reach the user: {stderr}"
        );
        assert!(
            op_state(&repo).await.unwrap().merging,
            "and the merge it bounced off is still the operation in progress"
        );
    }

    #[tokio::test]
    async fn rebase_onto_moves_only_its_own_commits() {
        // The "branched off the wrong branch" scenario: `fix` was branched off
        // `feature` (the wrong base), which itself branched off the default
        // branch. Rebasing `fix` --onto default from `feature` must replay ONLY
        // fix's own commits and drop feature's.
        let (dir, repo) = setup_repo("rebase-onto").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "f.txt", "f\n", "feature one").await;
        git(&repo, &["checkout", "-b", "fix"]).await;
        commit_file(&repo, dir.path(), "x.txt", "x\n", "fix one").await;
        commit_file(&repo, dir.path(), "x.txt", "x2\n", "fix two").await;
        // Advance the default branch so it diverges from feature.
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "main advance").await;
        let main_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "fix"]).await;

        let state = AppState::default();
        rebase_onto(&state, &repo, &main, "feature").await.unwrap();

        // `fix` now carries only its own two commits, replayed onto the default
        // branch's tip — feature's commit is excluded.
        assert_eq!(
            subjects(&repo).await,
            vec!["fix two", "fix one", "main advance", "base"],
            "only fix's own commits replay onto the new base; feature's excluded"
        );
        assert_eq!(
            rev(&repo, "fix~2").await,
            main_tip,
            "fix's commits sit directly on the new base's tip"
        );

    }

    /// A conflicted merge writes everything to stdout and leaves stderr empty
    /// (measured, git 2.51.1), so the error has to carry stdout — `AppError::Git`
    /// renders an empty stderr as "git exited with code N", which the frontend's
    /// conflict markers cannot classify.
    #[tokio::test]
    async fn merge_conflict_error_carries_the_classifiable_output() {
        let (dir, repo) = setup_repo("merge-conflict-payload").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;

        let state = AppState::default();
        let err = git_merge_core(
            &state,
            repo.clone(),
            "feature".into(),
            false,
            false,
            "none".into(),
        )
        .await
        .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "merge");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        // Kept against `report`: the same text still classifies through the
        // frontend's anchored CONFLICT_MARKERS fallback (error-summary.ts).
        assert!(
            report.lines().any(|l| l.starts_with("CONFLICT (")),
            "the conflict line must reach the frontend: {report}"
        );
        assert!(
            report.contains("Automatic merge failed"),
            "git's merge verdict must survive: {report}"
        );
        assert!(op_state(&repo).await.unwrap().merging);
    }

    #[tokio::test]
    async fn merge_preview_reports_outcomes() {
        let (dir, repo) = setup_repo("preview").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        commit_file(&repo, dir.path(), "shared.txt", "base\n", "base shared").await;

        // up-to-date: a branch pinned at an ancestor of HEAD.
        git(&repo, &["branch", "old"]).await;
        commit_file(&repo, dir.path(), "shared.txt", "main2\n", "advance main").await;
        let up = git_merge_preview(repo.clone(), "old".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(up.status, "up-to-date");

        // fast-forward: a branch strictly ahead of HEAD.
        git(&repo, &["checkout", "-b", "ahead"]).await;
        commit_file(&repo, dir.path(), "ahead.txt", "a\n", "ahead only").await;
        git(&repo, &["checkout", &main]).await;
        let ff = git_merge_preview(repo.clone(), "ahead".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(ff.status, "fast-forward");

        // conflict: divergent edits to shared.txt (needs git merge-tree, 2.38+).
        git(&repo, &["checkout", "-b", "feat"]).await;
        commit_file(&repo, dir.path(), "shared.txt", "feat\n", "feat edit").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "shared.txt", "main3\n", "main edit").await;
        let cf = git_merge_preview(repo.clone(), "feat".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(cf.status, "conflict", "conflicts: {:?}", cf.conflicts);
        assert!(
            cf.conflicts.iter().any(|f| f.contains("shared.txt")),
            "{:?}",
            cf.conflicts
        );

        // A content conflict auto-resolves with -X (strategy-aware preview) →
        // the same merge predicts "clean" once a side is chosen.
        let resolved =
            git_merge_preview(repo.clone(), "feat".to_string(), "theirs".to_string())
                .await
                .unwrap();
        assert_eq!(resolved.status, "clean", "{:?}", resolved.conflicts);

    }

    #[tokio::test]
    async fn conflict_preview_reports_clean_and_conflict() {
        let (dir, repo) = setup_repo("conflict-preview").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // A non-conflicting feature: touches a different file than base advances.
        git(&repo, &["checkout", "-b", "clean-feat"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feat\n", "feat only").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "base-only.txt", "b\n", "base only").await;
        let clean = git_conflict_preview(repo.clone(), main.clone(), "clean-feat".to_string())
            .await
            .unwrap();
        assert_eq!(clean.status, "clean", "conflicts: {:?}", clean.conflicts);

        // A conflicting feature: divergent edits to the same file as base.
        git(&repo, &["checkout", "-b", "bad-feat"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feat-edit\n", "feat edit a").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "main-edit\n", "main edit a").await;
        let conflict = git_conflict_preview(repo.clone(), main.clone(), "bad-feat".to_string())
            .await
            .unwrap();
        assert_eq!(
            conflict.status, "conflict",
            "conflicts: {:?}",
            conflict.conflicts
        );
        assert!(
            conflict.conflicts.iter().any(|f| f.contains("a.txt")),
            "{:?}",
            conflict.conflicts
        );

    }

    #[tokio::test]
    async fn unmerged_paths_lists_conflicts_only_when_present() {
        // Drives the conflict-vs-clean detection that git_merge_local_pr relies on
        // to decide between "leave it for the user" and "roll back".
        let (dir, repo) = setup_repo("unmerged").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Clean tree ⇒ no unmerged paths.
        assert!(unmerged_paths(&repo).await.is_empty());

        // Manufacture a real conflicted merge on `main`.
        git(&repo, &["checkout", "-b", "feat"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feat\n", "feat edit").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "main\n", "main edit").await;
        // A conflicting merge exits non-zero and leaves unmerged paths in place.
        let merged = run_git_raw(
            Some(&repo),
            &["merge", "--no-ff", "-m", "m", "feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merged.code, 0, "the merge should conflict");
        let paths = unmerged_paths(&repo).await;
        assert!(
            paths.iter().any(|p| p == "a.txt"),
            "expected a.txt among {paths:?}"
        );

    }

    /// Makes a throwaway dir and writes `.gitignore` with the given raw bytes.
    fn gitignore_dir(marker: &str, content: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-unignore-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        std::fs::write(dir.path().join(".gitignore"), content).unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        (dir, repo)
    }

    fn rule(pattern: &str) -> UnignoreRule {
        UnignoreRule {
            source: ".gitignore".into(),
            pattern: pattern.into(),
        }
    }

    #[tokio::test]
    async fn unignore_preserves_crlf_and_comments() {
        // A Windows .gitignore (CRLF) with a comment and two rules.
        let (dir, repo) = gitignore_dir("crlf", "# build artifacts\r\n*.log\r\nbuild/\r\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        // CRLF kept, comment + the untouched rule kept, trailing CRLF kept.
        assert_eq!(out, "# build artifacts\r\nbuild/\r\n");
    }

    #[tokio::test]
    async fn unignore_last_rule_keeps_trailing_newline() {
        let (dir, repo) = gitignore_dir("last", "*.log\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        // Removing the only rule leaves a single newline, not a 0-byte file.
        assert_eq!(out, "\n");
    }

    /// Two rules that a blanket `trim()` collapses into one key — `/notes\ `
    /// names a file whose name ends in a space, `/notes\` one ending in a
    /// backslash — must be removable independently. Trimming the escape away
    /// deletes the wrong line as well as the right one.
    #[tokio::test]
    async fn unignore_removes_only_the_targeted_escaped_rule() {
        let body = "/notes\\ \n/notes\\\nkeep\n";

        let (dir, repo) = gitignore_dir("escaped-space", body);
        git_unignore_rules(repo, vec![rule("/notes\\ ")]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "/notes\\\nkeep\n"
        );

        let (dir2, repo2) = gitignore_dir("escaped-slash", body);
        git_unignore_rules(repo2, vec![rule("/notes\\")]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir2.path().join(".gitignore")).unwrap(),
            "/notes\\ \nkeep\n"
        );
    }

    #[tokio::test]
    async fn unignore_strips_and_restores_bom() {
        // A UTF-8 BOM ahead of the first (targeted) rule must not block the match.
        let (dir, repo) = gitignore_dir("bom", "\u{feff}*.log\nbuild/\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert_eq!(out, "\u{feff}build/\n");
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn replace_lines_clean_file_stages_exactly_the_edit() {
        let (dir, repo) = setup_repo("replace-clean").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B1", "B2"]),
            true,
        )
        .await
        .unwrap();
        assert!(res.staged);
        assert!(!res.had_local_changes);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nB1\nB2\nc\n"
        );
        // The index holds exactly this edit — the staged blob matches the file,
        // so there is no unstaged remainder for src.txt.
        let porcelain = git(&repo, &["status", "--porcelain", "--", "src.txt"]).await;
        assert_eq!(porcelain, "M  src.txt\n", "unexpected status: {porcelain:?}");

    }

    #[tokio::test]
    async fn replace_lines_dirty_file_does_not_stage() {
        let (dir, repo) = setup_repo("replace-dirty").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;
        // A pre-existing unstaged edit elsewhere in the same file.
        std::fs::write(dir.path().join("src.txt"), "a\nb\nCHANGED\n").unwrap();

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B"]),
            true,
        )
        .await
        .unwrap();
        assert!(!res.staged, "must not stage a file with pre-existing changes");
        assert!(res.had_local_changes);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nB\nCHANGED\n"
        );
        // Nothing staged: the change is unstaged-only (" M").
        let porcelain = git(&repo, &["status", "--porcelain", "--", "src.txt"]).await;
        assert_eq!(porcelain, " M src.txt\n", "unexpected status: {porcelain:?}");

    }

    #[tokio::test]
    async fn replace_lines_mismatch_leaves_file_untouched() {
        let (dir, repo) = setup_repo("replace-mismatch").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;
        let before = std::fs::read(dir.path().join("src.txt")).unwrap();

        let state = AppState::default();
        // Expected "X" at line 2 but the file has "b" — drift, must be refused.
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["X"]),
            &lines(&["B"]),
            true,
        )
        .await;
        assert!(res.is_err());
        // File is byte-identical to before the attempted apply.
        assert_eq!(std::fs::read(dir.path().join("src.txt")).unwrap(), before);

    }

    #[tokio::test]
    async fn replace_lines_beyond_eof_is_a_mismatch() {
        let (dir, repo) = setup_repo("replace-eof").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\n", "seed").await;
        let before = std::fs::read(dir.path().join("src.txt")).unwrap();

        let state = AppState::default();
        // start_line 2 with two expected lines runs past EOF → mismatch.
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b", "c"]),
            &lines(&["B"]),
            true,
        )
        .await;
        assert!(res.is_err());
        assert_eq!(std::fs::read(dir.path().join("src.txt")).unwrap(), before);

    }

    #[tokio::test]
    async fn replace_lines_preserves_crlf() {
        let (dir, repo) = setup_repo("replace-crlf").await;
        commit_file(&repo, dir.path(), "src.txt", "a\r\nb\r\nc\r\n", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B1", "B2"]),
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        // Read as bytes to prove the CRLF flavor survived (no LF conversion).
        assert_eq!(
            std::fs::read(dir.path().join("src.txt")).unwrap(),
            b"a\r\nB1\r\nB2\r\nc\r\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_pure_deletion_removes_the_range() {
        let (dir, repo) = setup_repo("replace-delete").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\nd\n", "seed").await;

        let state = AppState::default();
        // Empty replacement = delete lines 2..3 ("b","c").
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b", "c"]),
            &[],
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nd\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_preserves_missing_trailing_newline() {
        let (dir, repo) = setup_repo("replace-notrail").await;
        // No trailing newline on the seed file.
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            3,
            &lines(&["c"]),
            &lines(&["C"]),
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        // Still no trailing newline after the edit.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nb\nC"
        );

    }

    #[tokio::test]
    async fn replace_lines_sequential_applies_both_survive() {
        // The sequential form of the concurrency guard: two applies to DIFFERENT
        // ranges of one file, each verifying against the other's post-edit state,
        // both succeed and both edits survive (a race would clobber the first).
        let (dir, repo) = setup_repo("replace-seq").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\nd\n", "seed").await;
        let state = AppState::default();

        replace_file_lines(&state, &repo, "src.txt", 1, &lines(&["a"]), &lines(&["A"]), false)
            .await
            .unwrap();
        // Second apply anchors on line 4 ("d"), which must still match after the
        // first edit (only line 1 changed) — proving it saw the first's write.
        replace_file_lines(&state, &repo, "src.txt", 4, &lines(&["d"]), &lines(&["D"]), false)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "A\nb\nc\nD\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_rejects_invalid_arguments() {
        let (dir, repo) = setup_repo("replace-invalid").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\n", "seed").await;
        let state = AppState::default();

        // start_line 0 is not 1-based.
        assert!(replace_file_lines(&state, &repo, "src.txt", 0, &lines(&["a"]), &[], false)
            .await
            .is_err());
        // Empty expected_lines.
        assert!(replace_file_lines(&state, &repo, "src.txt", 1, &[], &[], false)
            .await
            .is_err());
        // Traversal outside the repo.
        assert!(replace_file_lines(
            &state,
            &repo,
            "../escape.txt",
            1,
            &lines(&["a"]),
            &[],
            false
        )
        .await
        .is_err());
        // Nonexistent file.
        assert!(replace_file_lines(&state, &repo, "missing.txt", 1, &lines(&["a"]), &[], false)
            .await
            .is_err());

    }

    #[tokio::test]
    async fn orphaned_stashes_finds_a_dropped_stash() {
        let (dir, repo) = setup_repo("orphaned-stash").await;
        // Make a tracked change plus an untracked file, then stash both.
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        git(&repo, &["stash", "push", "-u", "-m", "rescue me"]).await;
        let sha = rev(&repo, "stash@{0}").await;
        // Drop it → the commit becomes dangling but still reachable by sha.
        git(&repo, &["stash", "drop"]).await;

        let found = git_orphaned_stashes(repo.clone()).await.unwrap();
        let entry = found
            .iter()
            .find(|o| o.sha == sha)
            .expect("dropped stash should appear as orphaned");
        assert!(
            entry.message.starts_with("On ") || entry.message.contains("rescue me"),
            "message was {:?}",
            entry.message
        );
        assert!(entry.file_count > 0, "file_count was {}", entry.file_count);

        // A live stash must NOT be reported as orphaned.
        std::fs::write(dir.path().join("a.txt"), "changed again\n").unwrap();
        git(&repo, &["stash", "push", "-m", "still live"]).await;
        let live_sha = rev(&repo, "stash@{0}").await;
        let found2 = git_orphaned_stashes(repo.clone()).await.unwrap();
        assert!(
            !found2.iter().any(|o| o.sha == live_sha),
            "live stash should be excluded"
        );

    }

    /// The diff pane discards a rendered body whose `file_path` doesn't match the
    /// path it asked for (that mismatch is how it detects a stale placeholder), so
    /// the echo must stay verbatim — including a `[slug]`-style name, which only
    /// survives because the pathspec is quoted literally.
    #[tokio::test]
    async fn stash_file_diff_echoes_the_requested_path() {
        let (dir, repo) = setup_repo("stash-file-diff-echo").await;
        let root = dir.path();
        std::fs::create_dir_all(root.join("[slug]")).unwrap();
        std::fs::write(root.join("plain.txt"), "one\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "seed"]).await;

        std::fs::write(root.join("plain.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["stash", "push", "-m", "echo test"]).await;

        for path in ["plain.txt", "[slug]/a.txt"] {
            let diff = git_stash_file_diff(repo.clone(), 0, path.to_string())
                .await
                .unwrap();
            assert_eq!(diff.file_path, path);
            assert!(
                diff.text.contains("+two"),
                "no hunk for {path}: {}",
                diff.text
            );
        }
    }

    #[test]
    fn parse_worktree_branches_reads_path_and_branch_and_detached() {
        // Main worktree on a branch, a linked worktree on another branch, and a
        // DETACHED worktree (no `branch` line → empty branch, like our resolve wt).
        let porcelain = "\
worktree C:/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/master

worktree C:/repos/app-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature

worktree C:/data/worktrees/h/gd-resolve-abc
HEAD 3333333333333333333333333333333333333333
detached
";
        let got = parse_worktree_branches(porcelain);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], "master");
        assert_eq!(got[1], "feature");
        // Detached stanza carries no branch — must not match `base` in finalize_base.
        assert_eq!(got[2], "");
        // Membership check mirrors finalize_base's "checked out elsewhere" test.
        assert!(got.iter().any(|b| b == "feature"));
        assert!(!got.iter().any(|b| b == "nope"));
    }

    #[test]
    fn parse_worktree_paths_reads_every_stanza_path() {
        let porcelain = "\
worktree C:/repos/app
HEAD 1111
branch refs/heads/master

worktree C:/data/worktrees/h/gd-resolve-abc
HEAD 2222
detached
";
        assert_eq!(
            parse_worktree_paths(porcelain),
            vec![
                "C:/repos/app".to_string(),
                "C:/data/worktrees/h/gd-resolve-abc".to_string(),
            ]
        );
    }

    /// `worktree_root_dir` hardcodes the bundle identifier, but the filter that
    /// hides our internal checkouts (`is_session_worktree`'s app-data arm) reads
    /// Tauri's `app_data_dir()`, i.e. `dirs::data_dir()/<identifier>` from
    /// `tauri.conf.json`. Renaming the identifier there alone would strand every
    /// hidden family (`gd-resolve-*`, `gd-update-*`) outside that filter with no
    /// other signal, so the two sides are pinned against each other here — the
    /// non-circular half of the mint-path tests, which check a path against the
    /// resolver that built it.
    #[test]
    fn worktree_root_dir_uses_the_shipped_bundle_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json"))
            .expect("tauri.conf.json parses");
        let identifier = conf["identifier"]
            .as_str()
            .expect("tauri.conf.json declares an identifier");
        let data = dirs::data_dir().expect("the app-data directory resolves");
        let root = worktree_root_dir("C:\\repos\\app").expect("the worktree root resolves");
        let under = root
            .strip_prefix(&data)
            .expect("the worktree root sits under the app-data directory");
        assert_eq!(
            under.components().next().map(|c| c.as_os_str()),
            Some(std::ffi::OsStr::new(identifier)),
            "worktree_root_dir's identifier drifted from tauri.conf.json's"
        );
    }

    /// `repo_hash` exists twice — here and in `worktree.rs` — and the comment on each
    /// says "kept in sync BY HAND". This is that sync, mechanized: a drift would split
    /// one repo's hidden checkouts across two roots, so the guards, the sweeps, and the
    /// filter that hides them from the worktree manager would each read a different
    /// directory. Mixed case and both separators, since the hash lower-cases but does
    /// not normalize separators.
    #[test]
    fn ops_and_worktree_repo_hash_agree() {
        for key in [
            "C:\\repos\\app",
            "C:/repos/app",
            "C:\\Repos\\App",
            "c:/repos/APP",
            "C:\\repos\\app\\.git",
            "/home/u/repos/app/.git",
            "",
        ] {
            assert_eq!(
                repo_hash(key),
                crate::git::worktree::repo_hash(key),
                "the two hand-kept copies disagree on {key:?}"
            );
        }
    }

    #[test]
    fn orphaned_resolve_worktrees_picks_gd_resolve_paths_not_kept() {
        let all = vec![
            // Main worktree — not a resolve worktree, never swept.
            "C:/repos/app".to_string(),
            // A user worktree that merely contains "gd-resolve-" mid-path but whose
            // BASENAME doesn't start with it — must NOT be swept.
            "C:/repos/gd-resolve-ish/feature".to_string(),
            // The kept (active) resolve worktree — frontend passed it in keep_paths,
            // but with back-slashes and different case (as the store holds it).
            "C:/data/worktrees/h/gd-resolve-keep".to_string(),
            // An orphaned resolve worktree — swept.
            "C:/data/worktrees/h/gd-resolve-orphan".to_string(),
        ];
        let keep = vec!["c:\\data\\worktrees\\h\\gd-resolve-keep".to_string()];

        let got = orphaned_resolve_worktrees(&all, &keep);
        assert_eq!(got, vec!["C:/data/worktrees/h/gd-resolve-orphan".to_string()]);

        // The basename test is the gate: a mid-path "gd-resolve-" is not a match.
        assert!(!is_resolve_worktree_path("C:/repos/gd-resolve-ish/feature"));
        assert!(is_resolve_worktree_path("C:/data/worktrees/h/gd-resolve-orphan"));
        // Empty keep list → every resolve worktree is orphaned.
        let all_orphans = orphaned_resolve_worktrees(&all, &[]);
        assert_eq!(all_orphans.len(), 2);
    }

    /// The directory name is a Windows MAX_PATH budget item — every path inside
    /// the checkout is measured from it — and it is also what the orphan sweep
    /// recognizes, so both the length and the prefix are pinned here.
    #[test]
    fn resolve_worktree_id_is_12_hex_under_the_gd_resolve_prefix() {
        let id = super::new_resolve_worktree_id();
        assert_eq!(id.len(), 12, "id was {id}");
        assert!(
            id.bytes().all(|b| b.is_ascii_hexdigit()),
            "id must be bare hex (no dashes, no braces): {id}"
        );
        assert_ne!(id, super::new_resolve_worktree_id());

        let name = format!("gd-resolve-{id}");
        assert_eq!(name.len(), 23, "name was {name}");
        assert!(is_resolve_worktree_path(&format!(
            "C:/data/worktrees/h/{name}"
        )));
    }

    #[test]
    fn repo_hash_is_case_insensitive_and_16_hex() {
        // Mirrors worktree.rs::repo_hash's contract: case-insensitive (Windows
        // paths) and a stable 16-hex string, so resolve worktrees land under the
        // identical app-data root worktree.rs uses (and are hidden by the
        // user-facing manager's app-data-root filter).
        assert_eq!(super::repo_hash("C:/Repos/App"), super::repo_hash("c:/repos/app"));
        assert_ne!(super::repo_hash("C:/Repos/App"), super::repo_hash("C:/Repos/Other"));
        assert_eq!(super::repo_hash("C:/Repos/App").len(), 16);
    }

    /// `base` reaches `refs/heads/<base>` in `finalize_base`'s `update-ref` and
    /// `head` the merge argv, so both are refused for refspec metacharacters
    /// AND rev-expression syntax before any git runs. The rev cases are the
    /// sharper half: `rev-parse` RESOLVES them, so `feature~1` would pass an
    /// existence probe and merge an ancestor, then fail at `refs/heads/main~1`.
    #[tokio::test]
    async fn merge_local_pr_rejects_metacharacters_and_rev_expressions() {
        // A real directory that is deliberately NOT a repo: without the guard the
        // first `rev-parse` fails as `AppError::Git`, so asserting the
        // `InvalidArgument` variant (not merely `is_err`) is what pins the guard.
        let dir = tempfile::tempdir().expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        let root = dir.path().join("root");
        let state = AppState::default();
        for bad in [
            "a*b", "a?b", "a[b", "a:b", "feature~1", "main^", "HEAD@{1}", "main..other", "@",
        ] {
            for (base, head) in [(bad, "feature"), ("main", bad)] {
                assert!(
                    matches!(
                        merge_local_pr(&state, &repo, base, head, "m", "merge", &root).await,
                        Err(AppError::InvalidArgument(_))
                    ),
                    "expected {base:?} -> {head:?} to be refused as an invalid branch name"
                );
            }
        }
    }

    /// A clean local-PR merge where `base` is NOT the current branch: the main
    /// tree stays on its branch with its uncommitted work intact, and `base`
    /// advances to the merged commit via `update-ref` (never checked out).
    #[tokio::test]
    async fn merge_local_pr_clean_leaves_main_tree_untouched_and_advances_base() {
        let (dir, repo) = setup_repo("lpr-clean").await;
        let base_start = rev(&repo, "HEAD").await;
        // The base branch is whatever `git init` created (main/master varies by
        // config) — capture it rather than hardcoding.
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // Add a feature branch off base with one non-conflicting commit, then
        // return to base and DIRTY the tree + move onto another branch.
        git(&repo, &["branch", "feature"]).await;
        git(&repo, &["switch", "feature"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feature\n", "feat commit").await;
        git(&repo, &["switch", &base]).await;
        // Move the main tree OFF base onto `work`, and leave uncommitted changes.
        git(&repo, &["switch", "-c", "work"]).await;
        std::fs::write(dir.path().join("wip.txt"), "uncommitted\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();

        // The root dir is deliberately NOT pre-created here — production
        // `merge_local_pr` is relied on to create it. The holder's TempDir is the
        // dir ABOVE `root`, so `root` itself stays absent until the code makes it.
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(
            &state,
            &repo,
            &base,
            "feature",
            "merge it",
            "merge",
            &root,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, "merged");
        assert!(outcome.conflicts.is_empty());
        assert!(outcome.worktree_path.is_none());
        assert_eq!(outcome.base_tip, base_start);

        // Main tree is untouched: still on `work`, dirty files intact.
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "work"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert!(dir.path().join("wip.txt").exists(), "untracked WIP survives");

        // base advanced: it now contains feature's commit. `cat-file -e` exits 0
        // only when the blob is reachable; `git()` unwraps, so a missing file
        // would panic the test.
        let base_tip = rev(&repo, &base).await;
        assert_ne!(base_tip, base_start, "base moved");
        git(&repo, &["cat-file", "-e", &format!("{base}:feat.txt")]).await;

        // No resolve worktree left behind.
        let wts = git(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !wts.contains("gd-resolve-"),
            "resolve worktree removed: {wts}"
        );
    }

    /// A conflicting local-PR merge keeps the resolve worktree and reports the
    /// conflicted paths + the worktree id/path; the main tree and `base` are
    /// untouched. Aborting then removes the worktree.
    #[tokio::test]
    async fn merge_local_pr_conflict_keeps_worktree_then_abort_removes_it() {
        let (dir, repo) = setup_repo("lpr-conflict").await;
        let base_start = rev(&repo, "HEAD").await; // base @ a.txt="v0\n"
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // feature edits a.txt one way; base edits it another → conflict on merge.
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        let base_before = rev(&repo, &base).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let state = AppState::default();
        let outcome = merge_local_pr(
            &state,
            &repo,
            &base,
            "feature",
            "merge it",
            "merge",
            &root,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, "conflicts");
        assert!(
            outcome.conflicts.iter().any(|p| p == "a.txt"),
            "a.txt conflicts: {:?}",
            outcome.conflicts
        );
        let wt_path = outcome.worktree_path.clone().expect("worktree path set");
        assert!(outcome.worktree_id.is_some());
        assert!(std::path::Path::new(&wt_path).exists(), "worktree kept");

        // Main tree + base untouched during the conflict.
        assert_eq!(rev(&repo, &base).await, base_before);
        assert_ne!(base_before, base_start);

        // Abort: `git_abort_local_pr_merge` is a thin wrapper over
        // `remove_resolve_worktree` (+ oplog finish, which no-ops on op_id None
        // here). Call the shared helper directly — the command form needs a real
        // `tauri::State`, not constructible in a unit test.
        remove_resolve_worktree(&state, &repo, &wt_path).await;
        assert!(
            !std::path::Path::new(&wt_path).exists(),
            "worktree removed after abort"
        );
    }

    /// A repo wired to a BARE origin, the way the remote-PR ladder expects one.
    /// Returns both temp dirs (each must outlive the test), the repo path, and the
    /// bare path. Forward slashes: a Windows backslash path is a poor remote URL.
    async fn setup_repo_with_origin(
        marker: &str,
    ) -> (tempfile::TempDir, tempfile::TempDir, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        let (bare_dir, bare) = add_bare_remote(&repo, marker, "origin").await;
        (dir, bare_dir, repo, bare)
    }

    /// The tag push end to end against a real (file) remote: the tightened name
    /// check must let a normal tag through, and refuse a glob before pushing.
    #[tokio::test]
    async fn push_tag_lands_the_tag_on_the_remote() {
        let (_dir, _bare_dir, repo, bare) = setup_repo_with_origin("push-tag").await;
        let head = rev(&repo, "HEAD").await;
        let state = AppState::default();

        git_tag_core(&state, repo.clone(), "v1.0.0".to_string(), head.clone())
            .await
            .unwrap();
        git_push_tag_core(&state, repo.clone(), "v1.0.0".to_string())
            .await
            .unwrap();
        assert_eq!(rev(&bare, "refs/tags/v1.0.0").await, head);

        // A glob name never reaches the refspec (it would mirror-push every tag).
        // Assert on the VALIDATOR's rejection: git refusing the odd refspec later
        // would satisfy a bare `is_err()` for the wrong reason.
        match git_push_tag_core(&state, repo, "v1.*".to_string()).await {
            Err(AppError::InvalidArgument(msg)) => {
                assert!(msg.contains("invalid tag name"), "got: {msg}");
            }
            other => panic!("expected the tag validator to reject the glob, got {other:?}"),
        }
    }

    /// A second bare repo wired to `repo` under `remote` — what a fork clone's
    /// `upstream` looks like.
    async fn add_bare_remote(
        repo: &str,
        marker: &str,
        remote: &str,
    ) -> (tempfile::TempDir, String) {
        let bare_dir = tempfile::Builder::new()
            .prefix(&format!("gd-{remote}-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let bare = bare_dir.path().to_string_lossy().replace('\\', "/");
        git(&bare, &["init", "--bare"]).await;
        git(repo, &["remote", "add", remote, &bare]).await;
        (bare_dir, bare)
    }

    /// Pushes a base/head pair to `remote` that conflicts on the same line of
    /// `a.txt`, leaving the main tree on `base`. Returns the base branch name.
    async fn push_conflicting_pair(repo: &str, dir: &std::path::Path, remote: &str) -> String {
        let base = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(repo, &["switch", "-c", "feature"]).await;
        commit_file(repo, dir, "a.txt", "feature-side\n", "feat edit").await;
        git(repo, &["switch", &base]).await;
        commit_file(repo, dir, "a.txt", "base-side\n", "base edit").await;
        git(repo, &["push", remote, &base, "feature"]).await;
        base
    }

    /// The whole conflict ladder: the merge lands in an isolated worktree, the
    /// PR head on the remote is untouched while conflicts stand, and finishing
    /// pushes the resolved merge onto it.
    #[tokio::test]
    async fn remote_pr_conflict_then_finish_pushes_the_resolution() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-conflict").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let head_before = rev(&bare, "refs/heads/feature").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 42, &base, "feature", None, None, &root)
            .await
            .unwrap();

        assert_eq!(outcome.status, "conflicts");
        assert!(
            outcome.conflicts.iter().any(|p| p == "a.txt"),
            "a.txt conflicts: {:?}",
            outcome.conflicts
        );
        assert!(outcome.pushed_sha.is_none(), "nothing pushed yet");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let wt_id = outcome.worktree_id.clone().expect("worktree id set");
        assert!(Path::new(&wt).exists(), "worktree kept");
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            head_before,
            "the PR head on the remote is untouched while conflicts stand"
        );

        // Resolve + stage inside the worktree, as the frontend's editor does.
        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;

        let done = finish_remote_pr_resolve(
            &state, &repo, "feature", &wt, &wt_id, None, None, &root,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "pushed");
        let pushed = done.pushed_sha.clone().expect("pushed sha");
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            pushed,
            "the PR head is the pushed merge"
        );
        assert!(!Path::new(&wt).exists(), "worktree removed after finish");
    }

    /// A clean divergence needs no user input: the merge is pushed straight
    /// through and the worktree never survives the call.
    #[tokio::test]
    async fn remote_pr_clean_divergence_pushes_immediately() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-clean").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Different files ⇒ the merge is clean, but the branches still diverge.
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feature\n", "feat commit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "b.txt", "base\n", "base commit").await;
        git(&repo, &["push", "origin", &base, "feature"]).await;
        let head_before = rev(&bare, "refs/heads/feature").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 7, &base, "feature", None, None, &root)
            .await
            .unwrap();

        assert_eq!(outcome.status, "pushed");
        assert!(outcome.conflicts.is_empty());
        assert!(outcome.worktree_path.is_none());
        let pushed = outcome.pushed_sha.clone().expect("pushed sha");
        assert_ne!(pushed, head_before, "the PR head advanced");
        assert_eq!(rev(&bare, "refs/heads/feature").await, pushed);

        let wts = git(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(!wts.contains("gd-pr-resolve-"), "worktree removed: {wts}");
    }

    /// Under the upstream lens the PR's branches live on `upstream`. Fetching or
    /// pushing `origin` here would silently target the user's FORK — the whole
    /// point of the lens — so both ends must land on upstream and origin must not
    /// even gain the branch.
    #[tokio::test]
    async fn remote_pr_ladder_follows_the_upstream_lens() {
        let (dir, _origin_dir, repo, origin) = setup_repo_with_origin("rpr-lens").await;
        let (_up_dir, upstream) = add_bare_remote(&repo, "rpr-lens", "upstream").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feature\n", "feat commit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "b.txt", "base\n", "base commit").await;
        // The PR lives on UPSTREAM; origin (the fork) never gets `feature`.
        git(&repo, &["push", "upstream", &base, "feature"]).await;
        git(&repo, &["push", "origin", &base]).await;
        let upstream_before = rev(&upstream, "refs/heads/feature").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(
            &state,
            &repo,
            31,
            &base,
            "feature",
            None,
            Some("upstream"),
            &root,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, "pushed");
        let pushed = outcome.pushed_sha.clone().expect("pushed sha");
        assert_ne!(pushed, upstream_before);
        assert_eq!(
            rev(&upstream, "refs/heads/feature").await,
            pushed,
            "the merge landed on upstream"
        );
        let origin_refs = git(&origin, &["for-each-ref", "--format=%(refname)", "refs/heads"]).await;
        assert!(
            !origin_refs.contains("refs/heads/feature"),
            "the fork never received the PR branch: {origin_refs}"
        );
    }

    /// A second start for the same (remote, PR) hands back the SAME worktree —
    /// minting another would strand the first with the user's resolutions in it.
    /// Once everything is resolved the takeover reports an EMPTY conflict list.
    #[tokio::test]
    async fn remote_pr_second_start_resumes_the_existing_worktree() {
        use crate::git::worktree::canonical_wt_path;
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-dedupe").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let first = merge_remote_pr(&state, &repo, 77, &base, "feature", None, None, &root)
            .await
            .unwrap();
        let wt = first.worktree_path.clone().expect("worktree path set");
        // The REMOTE is part of the name, so the same number under two lenses
        // cannot collide.
        let name = Path::new(&wt).file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("gd-pr-resolve-origin-77-"), "got: {name}");

        let second = merge_remote_pr(&state, &repo, 77, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(second.status, "conflicts");
        // Compare CANONICALIZED: the resumed path came back through git's
        // porcelain, which prints macOS's `/private/var/…` for the `/var/…` temp
        // dir this test created (and long names for a Windows runner's 8.3 short
        // names) — raw string equality would fail there and pass here.
        assert_eq!(
            second.worktree_path.as_deref().map(canonical_wt_path),
            Some(canonical_wt_path(&wt))
        );
        assert_eq!(second.worktree_id, first.worktree_id);
        assert!(second.conflicts.iter().any(|p| p == "a.txt"));

        let porcelain = git(&repo, &["worktree", "list", "--porcelain"]).await;
        let mine = parse_worktree_paths(&porcelain)
            .into_iter()
            .filter(|p| is_pr_resolve_worktree_path(p))
            .count();
        assert_eq!(mine, 1, "exactly one resolve worktree: {porcelain}");

        // Fully resolved but not yet finished: the takeover reports no conflicts,
        // which is what drives the frontend's "Finish to push" state.
        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;
        let third = merge_remote_pr(&state, &repo, 77, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(third.status, "conflicts");
        assert!(third.conflicts.is_empty(), "got: {:?}", third.conflicts);
    }

    /// The remote-PR resolve directory is the same Windows MAX_PATH budget item
    /// the local `gd-resolve-` mint was shortened for — every path in the checkout
    /// is measured from it — so the minted name's length is pinned here, at the
    /// mint itself (composing the prefix by hand would not notice a regression).
    #[tokio::test]
    async fn remote_pr_resolve_worktree_name_is_12_hex_under_the_pr_prefix() {
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-name").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 42, &base, "feature", None, None, &root)
            .await
            .unwrap();

        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let name = Path::new(&wt).file_name().unwrap().to_string_lossy().into_owned();
        let prefix = pr_resolve_prefix("origin", 42);
        let id = name
            .strip_prefix(&prefix)
            .unwrap_or_else(|| panic!("name {name} under prefix {prefix}"));
        assert_eq!(id.len(), 12, "id was {id}");
        assert!(
            id.bytes().all(|b| b.is_ascii_hexdigit()),
            "id must be bare hex (no dashes, no braces): {id}"
        );
        // `gd-pr-resolve-` (14) + `origin` (6) + `-` + a 2-digit number + `-` + 12.
        assert_eq!(name.len(), 36, "name was {name}");
        // The id handed to the frontend is the one in the path, or a resume would
        // fail its match check.
        assert_eq!(outcome.worktree_id.as_deref(), Some(id));
    }

    /// Resolve worktrees minted before the id shortened are still on disk with a
    /// full 36-char uuid tail, and this flow ships no migration: `finish` parses
    /// the id as the whole post-number tail, so such a name still pushes.
    #[tokio::test]
    async fn finish_remote_pr_resolve_still_accepts_a_legacy_uuid_name() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-legacy").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let head_before = rev(&bare, "refs/heads/feature").await;
        // `finish` reads the head tip from the remote-tracking ref the start step
        // would have fetched; this fixture skips that step.
        git(&repo, &["fetch", "origin"]).await;

        let legacy_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(legacy_id.len(), 36, "the old mint's shape: {legacy_id}");
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let wt = root
            .join(format!("{}{legacy_id}", pr_resolve_prefix("origin", 8)))
            .to_string_lossy()
            .into_owned();
        let head_tip = rev(&repo, "refs/remotes/origin/feature").await;
        let base_tip = rev(&repo, &format!("refs/remotes/origin/{base}")).await;
        git(&repo, &["worktree", "add", "--detach", &wt, &head_tip]).await;
        let merged = run_git_raw(
            Some(&wt),
            &["merge", "--no-ff", "-m", "Merge base into feature", &base_tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merged.code, 0, "the fixture merge conflicts as the flow's does");

        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;

        let state = AppState::default();
        let done = finish_remote_pr_resolve(
            &state, &repo, "feature", &wt, &legacy_id, None, None, &root,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "pushed");
        let pushed = done.pushed_sha.clone().expect("pushed sha");
        assert_ne!(pushed, head_before, "the PR head advanced");
        assert_eq!(rev(&bare, "refs/heads/feature").await, pushed);
    }

    /// Abort tears the worktree down and pushes nothing; `find` locates the live
    /// worktree by (remote, number) beforehand and reports none afterwards. The
    /// local-PR orphan sweep must NOT claim it (its `gd-resolve-` prefix
    /// deliberately misses `gd-pr-resolve-`).
    #[tokio::test]
    async fn remote_pr_abort_removes_worktree_and_find_tracks_it() {
        use crate::git::worktree::canonical_wt_path;
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-abort").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let head_before = rev(&bare, "refs/heads/feature").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 99, &base, "feature", None, None, &root)
            .await
            .unwrap();
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let wt_id = outcome.worktree_id.clone().expect("worktree id set");

        // Identity is by CANONICALIZED path: git's porcelain prints its own
        // spelling of the same location (forward slashes here, macOS's
        // `/private/var/…` for a `/var/…` temp dir, long names for a Windows
        // runner's 8.3 short names), so raw string equality is not identity.
        let found = find_remote_pr_resolve(&repo, 99, None, &root)
            .await
            .unwrap()
            .expect("the live resolve is found");
        assert_eq!(
            canonical_wt_path(&found.worktree_path),
            canonical_wt_path(&wt)
        );
        assert_eq!(found.worktree_id, wt_id, "the id is parsed off the path");
        // Neither a different PR number nor a different lens may claim it.
        assert!(find_remote_pr_resolve(&repo, 98, None, &root)
            .await
            .unwrap()
            .is_none());
        assert!(find_remote_pr_resolve(&repo, 99, Some("upstream"), &root)
            .await
            .unwrap()
            .is_none());

        // Negative control on the REAL porcelain: an empty keep-set sweeps every
        // orphan the local-PR flow owns — and this worktree is not one of them.
        let porcelain = git(&repo, &["worktree", "list", "--porcelain"]).await;
        let all = parse_worktree_paths(&porcelain);
        assert!(all.iter().any(|p| p.contains("gd-pr-resolve-")), "{porcelain}");
        assert!(
            orphaned_resolve_worktrees(&all, &[]).is_empty(),
            "the local-PR sweep must not touch a remote-PR resolve: {all:?}"
        );

        abort_remote_pr_resolve(&state, &repo, &wt, &root)
            .await
            .unwrap();
        assert!(!Path::new(&wt).exists(), "worktree removed after abort");
        assert!(find_remote_pr_resolve(&repo, 99, None, &root)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            head_before,
            "abort pushes nothing"
        );
    }

    /// The same comment-block wart in the MAIN-repo "continue a merge" command:
    /// `commit --no-edit` runs no editor, so git's cleanup defaults to
    /// `whitespace` and MERGE_MSG's `# Conflicts:` lines land in the user's own
    /// merge commit.
    #[tokio::test]
    async fn op_continue_merge_records_a_comment_free_message() {
        let (dir, repo) = setup_repo("op-continue-merge").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;

        // Conflict, then resolve + stage exactly as the conflict editor does.
        let merged = run_git_raw(Some(&repo), &["merge", "feature"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(merged.code, 0, "the merge must conflict for this to be real");
        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;

        let state = AppState::default();
        op_continue(&state, &repo, "merge").await.unwrap();

        let msg = git(&repo, &["log", "-1", "--format=%B"]).await;
        assert!(
            !msg.lines().any(|l| l.starts_with('#')),
            "the merge commit must not record git's comment block, got: {msg:?}"
        );
        assert!(
            msg.contains("Merge"),
            "the subject line survives cleanup, got: {msg:?}"
        );
        // It really is a merge commit (the continue concluded the merge).
        let parents = git(&repo, &["rev-list", "--parents", "-n1", "HEAD"]).await;
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "commit + 2 parents, got: {parents:?}"
        );
    }

    /// The squash sibling: a conflicted `merge --squash` writes SQUASH_MSG (not
    /// MERGE_HEAD), and SQUASH_MSG carries the same `# Conflicts:` block — so the
    /// continue must strip it too. The result is a SINGLE-parent commit, which is
    /// what makes this a different path from the merge arm rather than a rerun.
    #[tokio::test]
    async fn op_continue_squash_records_a_comment_free_single_parent_commit() {
        let (dir, repo) = setup_repo("op-continue-squash").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        let before = rev(&repo, "HEAD").await;

        let squashed = run_git_raw(Some(&repo), &["merge", "--squash", "feature"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(squashed.code, 0, "the squash must conflict for this to be real");
        // Squash leaves no MERGE_HEAD — only SQUASH_MSG carries the comment block.
        let merge_head = git(&repo, &["rev-parse", "--git-path", "MERGE_HEAD"])
            .await
            .trim()
            .to_string();
        assert!(!Path::new(&merge_head).exists(), "squash writes no MERGE_HEAD");
        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;

        let state = AppState::default();
        op_continue(&state, &repo, "merge").await.unwrap();

        let msg = git(&repo, &["log", "-1", "--format=%B"]).await;
        assert!(
            !msg.lines().any(|l| l.starts_with('#')),
            "the squash commit must not record git's comment block, got: {msg:?}"
        );
        // A squash records ONE parent — the feature side is not a parent.
        let parents = git(&repo, &["rev-list", "--parents", "-n1", "HEAD"]).await;
        assert_eq!(
            parents.split_whitespace().count(),
            2,
            "commit + 1 parent, got: {parents:?}"
        );
        assert_ne!(rev(&repo, "HEAD").await, before, "the squash committed");
    }

    /// LIVE REPRO (dogfood blocker): resolving every conflict as "ours" stages a
    /// diff byte-identical to HEAD, so a staged-diff-only check skips the commit,
    /// HEAD never leaves the fetched tip, and finish dead-ends on "Nothing to
    /// push". While MERGE_HEAD exists the merge must be committed — its value is
    /// the second parent, not a tree change.
    #[tokio::test]
    async fn remote_pr_finish_commits_an_all_ours_resolution() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-ours").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let head_before = rev(&bare, "refs/heads/feature").await;
        let tree_before = git(&bare, &["rev-parse", &format!("{head_before}^{{tree}}")])
            .await
            .trim()
            .to_string();

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 55, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let wt_id = outcome.worktree_id.clone().expect("worktree id set");

        // Keep the PR head's side of every conflict — the staged diff is now EMPTY
        // even though the merge is unfinished. This is the exact live repro.
        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;
        let porcelain = git(&wt, &["status", "--porcelain"]).await;
        assert!(
            porcelain.trim().is_empty(),
            "the all-ours resolution stages nothing: {porcelain:?}"
        );

        // Wrong lens: this worktree is named for `origin`, so finishing it under
        // the upstream lens would push the merge to the WRONG repository. Refused
        // before anything is committed or pushed.
        git(&repo, &["remote", "add", "upstream", &bare]).await;
        let err = finish_remote_pr_resolve(
            &state,
            &repo,
            "feature",
            &wt,
            &wt_id,
            None,
            Some("upstream"),
            &root,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("does not belong to the upstream"),
            "got: {err}"
        );
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            head_before,
            "the refused finish pushed nothing"
        );
        git(&repo, &["remote", "remove", "upstream"]).await;

        // An EMPTY id must be refused, not accepted: every path "ends with" the
        // empty string, so a suffix match would wave it through. A partial id is
        // refused for the same reason — the id must match the whole trailing segment.
        for bad_id in ["", &wt_id[wt_id.len() - 4..]] {
            let err = finish_remote_pr_resolve(
                &state, &repo, "feature", &wt, bad_id, None, None, &root,
            )
            .await
            .unwrap_err();
            assert!(
                err.to_string().contains("path and id do not match"),
                "id {bad_id:?} got: {err}"
            );
        }
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            head_before,
            "no refused finish pushed anything"
        );

        let done = finish_remote_pr_resolve(
            &state, &repo, "feature", &wt, &wt_id, None, None, &root,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "pushed");
        let pushed = done.pushed_sha.clone().expect("pushed sha");
        assert_ne!(pushed, head_before, "the PR head advanced");
        assert_eq!(rev(&bare, "refs/heads/feature").await, pushed);

        // A real MERGE commit: two parents, and the head's own tree preserved.
        let parents = git(&bare, &["rev-list", "--parents", "-n1", &pushed]).await;
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "commit + 2 parents, got: {parents:?}"
        );
        assert_eq!(
            git(&bare, &["rev-parse", &format!("{pushed}^{{tree}}")])
                .await
                .trim(),
            tree_before,
            "an all-ours merge keeps the head's tree"
        );

        // The recorded message must carry NO comment block: with no editor run,
        // git's cleanup defaults to `whitespace` and would leave MERGE_MSG's
        // `# Conflicts:` lines in the message, publicly visible on the forge.
        let msg = git(&bare, &["log", "-1", "--format=%B", &pushed]).await;
        assert!(
            !msg.lines().any(|l| l.starts_with('#')),
            "the pushed message must not contain git's comment block, got: {msg:?}"
        );
        assert!(
            msg.contains("Merge"),
            "the subject line survives cleanup, got: {msg:?}"
        );
        assert!(!Path::new(&wt).exists(), "worktree removed after finish");
    }

    /// The LOCAL sibling of the same class, and the worse one: skipping the commit
    /// there left `base` at its old tip while the flow reported "merged" — a
    /// silent false merge. `base` must actually advance to a 2-parent commit.
    #[tokio::test]
    async fn local_pr_finish_commits_an_all_ours_resolution() {
        let (dir, repo) = setup_repo("lpr-ours").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        // Move the main tree OFF base so finalize_base takes the update-ref path.
        git(&repo, &["switch", "-c", "work"]).await;
        let base_before = rev(&repo, &base).await;
        let tree_before = git(&repo, &["rev-parse", &format!("{base_before}^{{tree}}")])
            .await
            .trim()
            .to_string();

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;
        let porcelain = git(&wt, &["status", "--porcelain"]).await;
        assert!(
            porcelain.trim().is_empty(),
            "the all-ours resolution stages nothing: {porcelain:?}"
        );

        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "merge",
            "merge it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "merged");

        let base_after = rev(&repo, &base).await;
        assert_ne!(base_after, base_before, "base actually advanced");
        let parents = git(&repo, &["rev-list", "--parents", "-n1", &base_after]).await;
        assert_eq!(
            parents.split_whitespace().count(),
            3,
            "commit + 2 parents, got: {parents:?}"
        );
        assert_eq!(
            git(&repo, &["rev-parse", &format!("{base_after}^{{tree}}")])
                .await
                .trim(),
            tree_before,
            "an all-ours merge keeps base's tree"
        );
    }

    /// The wording `finalize_base`'s CAS refusal discriminates on. Both failures
    /// say "cannot lock ref", so only `is at <sha> but expected <sha>` marks the
    /// compare-and-swap mismatch — a git release that reworded it would turn every
    /// other update-ref failure into a wrong "base moved" explanation.
    #[tokio::test]
    async fn update_ref_names_a_cas_mismatch_distinctly() {
        let (dir, repo) = setup_repo("cas-wording").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["branch", "target", "HEAD~1"]).await;

        // `target` is at HEAD~1, so claiming it is at `tip` is a CAS mismatch.
        let mismatch = run_git_raw(
            Some(&repo),
            &["update-ref", "refs/heads/target", &tip, &tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(mismatch.code, 0);
        assert!(
            mismatch.stderr.contains("but expected"),
            "git no longer names a CAS mismatch distinctly: {}",
            mismatch.stderr
        );

        // A different update-ref failure: same "cannot lock ref" lead-in, no
        // mismatch phrase — the half that makes the discriminant necessary.
        let other = run_git_raw(
            Some(&repo),
            &["update-ref", "refs/heads/absent", &tip, &tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(other.code, 0);
        assert!(
            other.stderr.contains("cannot lock ref") && !other.stderr.contains("but expected"),
            "a non-mismatch failure must not read as a moved base: {}",
            other.stderr
        );
    }

    /// A tag sharing the base branch's name must not steer the merge: gitrevisions
    /// resolves `refs/tags/<name>` BEFORE `refs/heads/<name>`, and git only warns
    /// (exit 0), so a bare-name read would anchor the journal, the resolve
    /// worktree and the replay range to the tag's commit.
    #[tokio::test]
    async fn local_pr_merge_ignores_a_tag_sharing_the_base_branch_name() {
        let (dir, repo) = setup_repo("lpr-tag-shadow").await;
        let base = head_branch(&repo).await;
        let stale = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        let base_before = rev(&repo, "HEAD").await;
        git(&repo, &["switch", "-c", "feature", &stale]).await;
        commit_file(&repo, dir.path(), "f.txt", "feature\n", "feat commit").await;
        // Off base for the update-ref arm, by SHA and before the tag exists:
        // `git switch -c <new> <start-point>` refuses an ambiguous start-point
        // outright (`fatal: ambiguous object name`, exit 128), unlike the
        // `rev-parse` read this test is about, which quietly picks the tag.
        git(&repo, &["switch", "-c", "work", &base_before]).await;
        // A tag on an OLDER commit, named exactly like the base branch.
        git(&repo, &["tag", &base, &stale]).await;
        assert_ne!(stale, base_before, "the tag points somewhere else");

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();

        assert_eq!(outcome.status, "merged");
        assert_eq!(
            outcome.base_tip, base_before,
            "the merge is anchored to the BRANCH tip, not the tag's commit"
        );
        // Read through the qualified ref — a bare name is ambiguous here now.
        let base_after = branch_tip(&repo, &base).await.unwrap();
        assert_ne!(base_after, base_before, "base advanced from its own tip");
        git(
            &repo,
            &["merge-base", "--is-ancestor", &base_before, &base_after],
        )
        .await;
        git(&repo, &["cat-file", "-e", &format!("{base_after}:f.txt")]).await;
    }

    /// The green direction, and the only test that would catch an anchor that is
    /// present but WRONG: the refusal tests stay green against any anchor that
    /// merely differs from base's tip — including the pre-op HEAD its sibling
    /// journal calls record — so one successful finish through a real `op_id` is
    /// what pins `pre_op_tip` to base's tip and the `"preOpTip"` store key to the
    /// reader.
    #[tokio::test]
    async fn local_pr_finish_through_the_journaled_anchor_still_merges() {
        let (dir, repo) = setup_repo("lpr-anchor-green").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        // Off base, so finalize takes the update-ref arm. Its own branch tip is
        // deliberately NOT base's, so a HEAD-shaped anchor would refuse here.
        git(&repo, &["switch", "-c", "work"]).await;
        commit_file(&repo, dir.path(), "w.txt", "w\n", "work edit").await;
        let base_before = rev(&repo, &base).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        assert!(
            outcome.op_id.is_some(),
            "the anchor under test comes from the oplog entry"
        );

        // Resolve toward the incoming side, so base's new tip must carry
        // feature's content rather than its own.
        git(&wt, &["checkout", "--theirs", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;

        // Nothing touches `base` in between — the anchor must accept it.
        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "merge",
            "merge it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            outcome.op_id.clone(),
        )
        .await
        .unwrap();

        assert_eq!(done.status, "merged");
        let base_after = rev(&repo, &base).await;
        assert_ne!(base_after, base_before, "base advanced");
        assert_eq!(
            base_after, done.base_tip,
            "base is at the commit the resolve worktree produced"
        );
        assert_eq!(
            nlf(git(&repo, &["show", &format!("{base_after}:a.txt")]).await),
            "feature-side\n",
            "base carries the resolution staged in the worktree"
        );
        assert!(
            !std::path::Path::new(&wt).exists(),
            "the resolve worktree is torn down on success"
        );
    }

    /// A backward move is intent too: someone resetting `base` to an ancestor
    /// mid-resolution means it, and every finalize arm would honor the rewind as
    /// readily as a commit (`merge --ff-only` fast-forwards from it; containment
    /// accepts it). Only the journaled pre-op tip can tell "we started here" from
    /// "someone moved it back", so this drives the real `op_id`.
    #[tokio::test]
    async fn local_pr_finish_refuses_a_base_reset_backwards_during_resolution() {
        let (dir, repo) = setup_repo("lpr-base-rewound").await;
        let base = head_branch(&repo).await;
        let root_tip = rev(&repo, "HEAD").await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        git(&repo, &["switch", "-c", "work"]).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        // Without a journaled id there is no anchor and this test would pass
        // vacuously through the containment fallback.
        assert!(
            outcome.op_id.is_some(),
            "the anchor under test comes from the oplog entry"
        );

        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;

        // Someone deliberately rewinds `base` to the commit before the merge was
        // started — an ancestor of what the worktree built, so containment alone
        // would wave it through.
        git(&repo, &["branch", "-f", &base, &root_tip]).await;

        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "merge",
            "merge it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            outcome.op_id.clone(),
        )
        .await;
        let Err(err) = done else {
            panic!("expected the rewound base to be refused");
        };
        assert!(
            err.to_string().contains("moved"),
            "the refusal names the moved base: {err}"
        );
        assert_eq!(
            rev(&repo, &base).await,
            root_tip,
            "the rewind stands — the merge did not re-advance it"
        );
        assert!(
            std::path::Path::new(&wt).exists(),
            "the resolve worktree survives so the user can retry"
        );
    }

    /// The resolve session is unbounded, so `base` can gain a commit while the
    /// user works. Advancing it anyway would drop that commit silently — the
    /// refusal keeps it, and the worktree survives so the resolution isn't lost.
    /// Drives `op_id: None` on purpose: this is the containment fallback that
    /// stands in for an unjournaled merge.
    #[tokio::test]
    async fn local_pr_finish_refuses_when_base_moved_and_keeps_the_worktree() {
        let (dir, repo) = setup_repo("lpr-base-moved").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        // Off base, so finalize_base takes the update-ref path.
        git(&repo, &["switch", "-c", "work"]).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;

        // A concurrent writer lands a commit on `base` mid-resolution. Plumbing,
        // so the main tree stays where the flow left it.
        let base_before = rev(&repo, &base).await;
        let tree = git(&repo, &["rev-parse", &format!("{base_before}^{{tree}}")])
            .await
            .trim()
            .to_string();
        let landed = git(
            &repo,
            &["commit-tree", &tree, "-p", &base_before, "-m", "concurrent"],
        )
        .await
        .trim()
        .to_string();
        // `branch -f` rather than an interpolated `refs/heads/<base>` refspec:
        // the static invariant gate treats those templates as a reviewed surface.
        git(&repo, &["branch", "-f", &base, &landed]).await;

        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "merge",
            "merge it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            None,
        )
        .await;
        let Err(err) = done else {
            panic!("expected the moved base to be refused");
        };
        assert!(
            err.to_string().contains("moved"),
            "the refusal names the moved base: {err}"
        );
        assert_eq!(
            rev(&repo, &base).await,
            landed,
            "the concurrent commit is still base's tip — nothing was eaten"
        );
        assert!(
            std::path::Path::new(&wt).exists(),
            "the resolve worktree survives so the user can retry"
        );
    }

    /// KNOWN degenerate case, pinned deliberately (NOT changed this round):
    /// `merge --squash` writes no MERGE_HEAD (measured, git 2.51.1), so an
    /// all-"ours" squash genuinely stages nothing, the commit is skipped, and
    /// `base` stays put while the flow still reports "merged". Recorded here so it
    /// cannot change silently.
    #[tokio::test]
    async fn local_pr_finish_squash_all_ours_is_a_known_no_op() {
        let (dir, repo) = setup_repo("lpr-squash-ours").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        git(&repo, &["switch", "-c", "work"]).await;
        let base_before = rev(&repo, &base).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "squash it", "squash", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        // Squash leaves no MERGE_HEAD — the signal the merge arm relies on.
        let merge_head = git(&wt, &["rev-parse", "--git-path", "MERGE_HEAD"])
            .await
            .trim()
            .to_string();
        assert!(
            !Path::new(&merge_head).exists(),
            "squash writes no MERGE_HEAD: {merge_head}"
        );

        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;

        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "squash",
            "squash it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            None,
        )
        .await
        .unwrap();
        // The behavior as it stands today: reported merged, base unmoved.
        assert_eq!(done.status, "merged");
        assert_eq!(
            rev(&repo, &base).await,
            base_before,
            "KNOWN: an all-ours squash advances nothing"
        );
    }

    /// The premise the two conclude-with-commit legs rest on
    /// (`finish_local_pr_merge`, `finish_remote_pr_resolve`): a `git commit` that
    /// refuses writes its whole report to STDOUT and leaves stderr EMPTY, so an
    /// error carrying stderr alone renders as the bare "git exited with code 1".
    /// That is the split `full_failure_text` exists to close.
    ///
    /// Pinned here rather than at those call sites because no real-repo fixture
    /// can reach them with this shape: every OTHER commit refusal measured (git
    /// 2.51.1) — a rejecting hook, an empty message, a signing failure — reports
    /// on stderr, and git redirects hook output to stderr too, so a hook cannot
    /// stage the stdout case either.
    #[tokio::test]
    async fn a_refusing_commit_reports_on_stdout_with_stderr_empty() {
        let (dir, repo) = setup_repo("commit-streams").await;

        // Clean tree, nothing staged.
        let clean = run_git_raw(Some(&repo), &["commit", "-m", "x"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(clean.code, 0, "a commit with nothing staged must refuse");
        assert!(
            clean.stderr.trim().is_empty(),
            "stderr staying empty is the whole problem: {}",
            clean.stderr
        );
        assert!(
            clean.stdout_lossy().contains("nothing to commit"),
            "git's report rides stdout: {}",
            clean.stdout_lossy()
        );

        // Same refusal with an untracked file present is a DIFFERENT sentence —
        // and the one neither `already` allow-list substring matches, so it is the
        // shape that reaches the error build rather than being swallowed.
        std::fs::write(dir.path().join("untracked.txt"), "u\n").unwrap();
        let untracked = run_git_raw(Some(&repo), &["commit", "-m", "x"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(
            untracked.code, 0,
            "a commit refusing over only-untracked files must still refuse"
        );
        assert!(
            untracked.stderr.trim().is_empty(),
            "stderr staying empty is the whole problem: {}",
            untracked.stderr
        );
        let report = untracked.stdout_lossy();
        assert!(
            report.contains("nothing added to commit but untracked files present"),
            "git's report rides stdout: {report}"
        );
        // This variant's sentence matches NEITHER allow-list substring, so it
        // reaches the error build even off combined output — the blind spot that
        // makes full_failure_text() load-bearing at both conclude-with-commit legs.
        let lower = report.to_lowercase();
        assert!(
            !lower.contains("nothing to commit") && !lower.contains("no changes added"),
            "the untracked refusal must not match the tolerate-it substrings: {report}"
        );
    }

    /// Resolving and committing BY HAND in the resolve worktree still finishes the
    /// merge. The arm that carries it is the SKIP above the conclude-with-commit
    /// step: a hand commit clears MERGE_HEAD and leaves nothing staged, so no
    /// commit is attempted at all. The "nothing to commit" tolerance below it now
    /// reads git's combined output, which is where that sentence actually lands —
    /// it covers a commit refused between the staged probe and the commit itself.
    #[tokio::test]
    async fn local_pr_finish_accepts_a_hand_committed_resolution() {
        let (dir, repo) = setup_repo("lpr-hand-commit").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        // Off `base` so advancing it never touches the main working tree.
        git(&repo, &["switch", "-c", "work"]).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;
        git(&wt, &["commit", "-m", "resolved by hand"]).await;
        let resolved = rev(&wt, "HEAD").await;
        assert!(
            !git_path_exists(&wt, "MERGE_HEAD").await,
            "a hand commit concludes the merge, clearing MERGE_HEAD"
        );

        let done = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "merge",
            "merge it",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "merged");
        assert_eq!(
            rev(&repo, &base).await,
            resolved,
            "base advances to the commit the user made"
        );
        assert!(
            !Path::new(&wt).exists(),
            "the resolve worktree is torn down"
        );
    }

    /// The `rebase` strategy's `cherry-pick --continue` can fail with no conflict
    /// left to report — an all-"ours" resolution makes the pick empty. That is a
    /// failure, never "merged", and the report splits: git explains itself on
    /// stderr while the state of the tree rides stdout.
    #[tokio::test]
    async fn local_pr_finish_rebase_reports_a_failed_continue_from_both_streams() {
        let (dir, repo) = setup_repo("lpr-rebase-continue").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        git(&repo, &["switch", "-c", "work"]).await;
        let base_before = rev(&repo, &base).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "", "rebase", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        // Every conflict resolved as "ours": nothing unmerged is left, so the
        // continue runs — and lands on a pick with no content.
        git(&wt, &["checkout", "--ours", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;

        let err = finish_local_pr_merge(
            &state,
            &repo,
            &base,
            "rebase",
            "",
            &wt,
            &outcome.worktree_id.clone().unwrap_or_default(),
            None,
        )
        .await;
        let Err(err) = err else {
            panic!("expected the failed continue to be reported");
        };
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a git error, got {err:?}");
        };
        assert!(
            stderr.contains("is now empty"),
            "git's own explanation (stderr) must survive: {stderr}"
        );
        assert!(
            stderr.contains("nothing to commit"),
            "and the stdout half that says what the tree looks like: {stderr}"
        );
        assert_eq!(
            rev(&repo, &base).await,
            base_before,
            "a failed continue never advances base"
        );
    }

    /// The PR head moving while the user resolves must FAIL honestly (the push is
    /// never forced) and KEEP the worktree — it holds resolutions that would
    /// otherwise be lost.
    #[tokio::test]
    async fn remote_pr_finish_fails_and_keeps_worktree_when_head_moved() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-moved").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 12, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let wt_id = outcome.worktree_id.clone().expect("worktree id set");

        // Someone pushes to the PR branch while the user is resolving.
        git(&repo, &["switch", "feature"]).await;
        commit_file(&repo, dir.path(), "c.txt", "moved\n", "head moved").await;
        git(&repo, &["push", "origin", "feature"]).await;
        let moved = rev(&bare, "refs/heads/feature").await;

        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;

        let err = finish_remote_pr_resolve(
            &state, &repo, "feature", &wt, &wt_id, None, None, &root,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("moved while you were resolving"),
            "got: {err}"
        );
        assert!(
            Path::new(&wt).exists(),
            "the worktree keeps the user's resolutions"
        );
        assert_eq!(
            rev(&bare, "refs/heads/feature").await,
            moved,
            "the head that moved is never overwritten"
        );
    }

    /// The reclamation arm removes a remote-PR resolve worktree ONLY when it is
    /// provably worthless. A paused conflict (dirty), a resolved-but-unpushed
    /// merge (a local-only commit), and an all-"ours" resolution (which reads
    /// CLEAN and contained — only MERGE_HEAD betrays it) all survive an EMPTY
    /// keep-set; that is what makes the keep-set unnecessary for this arm.
    #[tokio::test]
    async fn cleanup_keeps_in_progress_resolves_and_reclaims_only_worthless_ones() {
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-sweep").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();

        // (1) A paused conflicted resolve — dirty.
        let dirty = merge_remote_pr(&state, &repo, 1, &base, "feature", None, None, &root)
            .await
            .unwrap()
            .worktree_path
            .expect("worktree path set");
        // (2) Resolved and committed but never pushed — clean tree, local-only commit.
        let unpushed = merge_remote_pr(&state, &repo, 2, &base, "feature", None, None, &root)
            .await
            .unwrap()
            .worktree_path
            .expect("worktree path set");
        std::fs::write(Path::new(&unpushed).join("a.txt"), "resolved\n").unwrap();
        git(&unpushed, &["add", "a.txt"]).await;
        git(&unpushed, &["-c", "core.editor=true", "commit", "--no-edit"]).await;
        // (3) Every conflict resolved as "ours" and staged, not yet committed. The
        // staged content is byte-identical to HEAD and HEAD is still the fetched
        // tip, so this reads clean AND fully contained — MERGE_HEAD is the only
        // remaining evidence of the user's work.
        let ours = merge_remote_pr(&state, &repo, 3, &base, "feature", None, None, &root)
            .await
            .unwrap()
            .worktree_path
            .expect("worktree path set");
        git(&ours, &["checkout", "--ours", "a.txt"]).await;
        git(&ours, &["add", "a.txt"]).await;
        // Pin the premise this gate exists for, rather than assuming it.
        let porcelain = git(&ours, &["status", "--porcelain"]).await;
        assert!(
            porcelain.trim().is_empty(),
            "an all-ours resolution reads CLEAN, got: {porcelain:?}"
        );
        let contained = git(
            &ours,
            &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        )
        .await;
        assert_eq!(contained.trim(), "0", "and fully contained by the remote");

        // (4) Worthless: detached exactly at a commit the remote already has, with
        // no merge in flight.
        let head_tip = rev(&repo, "refs/remotes/origin/feature").await;
        let clean = root
            .join("gd-pr-resolve-origin-4-clean")
            .to_string_lossy()
            .into_owned();
        git(&repo, &["worktree", "add", "--detach", &clean, &head_tip]).await;

        cleanup_orphaned_resolve_worktrees(&state, &repo, &[], &root)
            .await
            .unwrap();

        assert!(
            Path::new(&dirty).exists(),
            "a paused conflicted resolve is kept"
        );
        assert!(
            Path::new(&unpushed).exists(),
            "a resolved-but-unpushed resolve is kept"
        );
        assert!(
            Path::new(&ours).exists(),
            "an unfinished merge is kept even though the tree reads clean"
        );
        assert!(
            !Path::new(&clean).exists(),
            "a clean, fully-contained worktree with no merge in flight is reclaimed"
        );
    }

    /// Refspec metacharacters are rejected BEFORE anything is fetched, created, or
    /// pushed — these names are interpolated into fetch/push refspecs, where `*`
    /// globs and `:` separates. A lens whose remote does not exist is refused just
    /// as early, rather than silently falling back to origin.
    #[tokio::test]
    async fn remote_pr_rejects_bad_refs_and_missing_remotes_before_any_mutation() {
        let (dir, repo) = setup_repo("rpr-validate").await;
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();

        // Metacharacters and rev expressions alike: on this path the names are
        // interpolated into `+refs/heads/{head}:refs/remotes/{remote}/{head}`,
        // whose refname rules reject all of them before anything resolves. The
        // gate is defense-in-depth, and buys an early error naming the bad
        // branch where the ungated path fails later as an opaque invalid-refspec
        // fetch error. (Resolution is the LOCAL path's hazard.)
        for (base, head) in [
            ("ma*in", "feature"),
            ("main", "fea:ture"),
            ("main", "*"),
            ("feature~1", "feature"),
            ("main", "feature~1"),
            ("main^", "feature"),
            ("main", "HEAD@{1}"),
            ("main..other", "feature"),
            ("main", "@"),
        ] {
            let err = merge_remote_pr(&state, &repo, 5, base, head, None, None, &root)
                .await
                .unwrap_err();
            // The MESSAGE, not just the variant: this clone has no remotes, so
            // `resolve_pr_remote` also fails as `InvalidArgument` — a variant-only
            // assertion passes with the name gate removed entirely.
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid branch name")),
                "{base}/{head} got: {err:?}"
            );
        }

        // This clone has no remotes at all, so every lens must fail by NAME.
        let err = merge_remote_pr(&state, &repo, 5, "main", "feature", None, None, &root)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("origin"), "got: {err}");
        let err = merge_remote_pr(&state, &repo, 5, "main", "feature", None, Some("upstream"), &root)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("upstream"), "got: {err}");
        // An unknown lens never reaches git at all. The MESSAGE again: a known lens
        // whose remote is missing raises `InvalidArgument` too, so a variant-only
        // assertion here passes whether the lens set or the remote lookup refused.
        let err = merge_remote_pr(&state, &repo, 5, "main", "feature", None, Some("fork"), &root)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("unknown remote lens")),
            "got: {err:?}"
        );

        // Nothing was created on disk.
        assert!(!root.exists(), "no worktree root created");
        let wts = git(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(!wts.contains("gd-pr-resolve-"), "{wts}");
        assert!(dir.path().join("a.txt").exists(), "the tree is untouched");
    }

    /// Finishing a resolve pushes to `refs/heads/<head>` on the lens remote, so the
    /// head must name a BRANCH: a rev expression would resolve locally and push the
    /// wrong commit. The gate runs before the remote lookup, and the assertion is on
    /// its MESSAGE — this clone has no remotes, so `resolve_pr_remote` raises
    /// `InvalidArgument` for every input and a variant-only match would be vacuous
    /// (proven by the valid-head row below).
    #[tokio::test]
    async fn finish_remote_pr_resolve_rejects_rev_expressions_in_the_head() {
        let (_dir, repo) = setup_repo("frpr-validate").await;
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let wt = root.join("gd-pr-resolve-origin-5-abcdef").to_string_lossy().into_owned();
        let state = AppState::default();

        for bad in [
            "feature~1",
            "main^",
            "HEAD@{1}",
            "main..other",
            "a^{commit}",
            "@",
            "a*b",
            "a:b",
        ] {
            let err = finish_remote_pr_resolve(
                &state, &repo, bad, &wt, "abcdef", None, None, &root,
            )
            .await
            .unwrap_err();
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid branch name")),
                "{bad:?} got: {err:?}"
            );
        }

        // The confounder, live: a VALID head gets the same variant from the remote
        // lookup instead — only the message tells the two gates apart.
        let err = finish_remote_pr_resolve(
            &state, &repo, "feature", &wt, "abcdef", None, None, &root,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("remote does not exist")),
            "got: {err:?}"
        );
    }

    #[test]
    fn pr_resolve_worktree_paths_are_guarded_by_prefix_and_root() {
        // Forward slashes only: `Path::file_name` treats `\` as a separator on
        // WINDOWS ONLY, so a backslash fixture is a whole-string basename on
        // Linux/macOS and would test something different there.
        assert!(is_pr_resolve_worktree_path(
            "/data/wt/h/gd-pr-resolve-origin-12-abc"
        ));
        assert!(!is_pr_resolve_worktree_path("/data/wt/h/gd-resolve-abc"));
        assert!(!is_resolve_worktree_path(
            "/data/wt/h/gd-pr-resolve-origin-12-abc"
        ));
        // Mid-path only ⇒ not a match (the basename is the signal).
        assert!(!is_pr_resolve_worktree_path("/repos/gd-pr-resolve-ish/feature"));
        // The remote namespaces the directory, so two lenses never collide.
        assert_ne!(pr_resolve_prefix("origin", 12), pr_resolve_prefix("upstream", 12));

        let root = Path::new("/data/wt/h");
        assert!(ensure_pr_resolve_worktree(root, "/data/wt/h/gd-pr-resolve-origin-12-abc").is_ok());
        // Ours by name but OUTSIDE the app-data root, and inside the root but not
        // ours — both refused before `worktree remove --force` is aimed at them.
        assert!(ensure_pr_resolve_worktree(root, "/users/me/gd-pr-resolve-origin-12-abc").is_err());
        assert!(ensure_pr_resolve_worktree(root, "/data/wt/h/my-work").is_err());
        // A SIBLING directory sharing the root's prefix must not slip through a
        // bare `starts_with` — this check ends in `worktree remove --force`.
        assert!(
            ensure_pr_resolve_worktree(root, "/data/wt/hevil/gd-pr-resolve-origin-12-abc").is_err()
        );
    }

    /// The divergent-spelling class the 3-OS matrix caught: one side reaches a
    /// directory through a link, the other through its real path. macOS's
    /// `/var → /private/var` temp dirs are that shape; a junction reproduces it on
    /// Windows, the only platform this can run on locally. Canonicalizing BOTH
    /// sides is what makes the two spellings compare equal — and containment must
    /// still REFUSE a sibling through either spelling.
    #[cfg(windows)]
    #[test]
    fn path_is_under_matches_across_a_linked_spelling() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let real = tmp.path().join("real");
        let leaf = "gd-pr-resolve-origin-1-abc";
        std::fs::create_dir_all(real.join(leaf)).unwrap();
        let link = tmp.path().join("link");
        // Directory junctions need no elevation (unlike symlinks).
        let made = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &real.to_string_lossy(),
            ])
            .output()
            .expect("run mklink");
        assert!(
            made.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&made.stderr)
        );

        let child_real = real.join(leaf).to_string_lossy().into_owned();
        let child_link = link.join(leaf).to_string_lossy().into_owned();
        // Root spelled one way, child the other — both directions.
        assert!(path_is_under(&link, &child_real), "linked root vs real child");
        assert!(path_is_under(&real, &child_link), "real root vs linked child");
        // A sibling sharing the root's prefix is still refused through either.
        let sibling = tmp.path().join("realevil").join(leaf);
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling = sibling.to_string_lossy().into_owned();
        assert!(!path_is_under(&real, &sibling));
        assert!(!path_is_under(&link, &sibling));
    }

    /// Windows-only: drive letters, case-insensitivity and backslash separators
    /// are meaningful there and nowhere else (`Path::file_name` only splits on
    /// `\` on Windows), so this spelling row cannot run cross-platform.
    #[cfg(windows)]
    #[test]
    fn pr_resolve_worktree_guard_accepts_windows_spellings() {
        let root = Path::new("C:/data/wt/h");
        assert!(
            ensure_pr_resolve_worktree(root, "c:\\data\\wt\\h\\gd-pr-resolve-origin-12-abc").is_ok()
        );
        assert!(
            ensure_pr_resolve_worktree(root, "C:/data/wt/hevil/gd-pr-resolve-origin-12-abc")
                .is_err()
        );
    }

    /// Discarding a path holding glob metacharacters touches ONLY that path.
    /// Pathspecs glob, so a raw `src/app/[slug]/page.tsx` also restores the
    /// character-class sibling `src/app/s/page.tsx` — silently destroying
    /// uncommitted work the user never selected (measured, git 2.51.1).
    #[tokio::test]
    async fn discard_paths_does_not_restore_glob_siblings() {
        let (dir, repo) = setup_repo("discard-glob-sibling").await;
        std::fs::create_dir_all(dir.path().join("src/app/[slug]")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/app/s")).unwrap();
        commit_file(&repo, dir.path(), "src/app/[slug]/page.tsx", "v0\n", "add route").await;
        commit_file(&repo, dir.path(), "src/app/s/page.tsx", "v0\n", "add sibling").await;

        std::fs::write(dir.path().join("src/app/[slug]/page.tsx"), "throw away\n").unwrap();
        std::fs::write(dir.path().join("src/app/s/page.tsx"), "PRECIOUS\n").unwrap();

        let state = AppState::default();
        git_discard_paths_core(
            &state,
            repo.clone(),
            vec![DiscardPath {
                path: "src/app/[slug]/page.tsx".into(),
                untracked: false,
            }],
        )
        .await
        .unwrap();

        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("src/app/[slug]/page.tsx")).unwrap()),
            "v0\n",
            "the selected file is discarded"
        );
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("src/app/s/page.tsx")).unwrap()),
            "PRECIOUS\n",
            "the glob-sibling keeps its uncommitted work"
        );
    }

    /// Creating and probing a reserved device name is only possible through the
    /// verbatim path — the plain one answers for the device, not the file.
    #[cfg(windows)]
    fn verbatim(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(format!(
            r"\\?\{}",
            dir.join(name).to_string_lossy().replace('/', "\\")
        ))
    }

    /// Both discard cores remove an untracked file named after a reserved DOS
    /// device. Such a file enumerates normally but resolves to the DEVICE for
    /// every open/stat/unlink by its plain path, so the recycle bin refuses it
    /// and only a `\\?\` verbatim unlink gets rid of it.
    #[cfg(windows)]
    #[tokio::test]
    async fn discard_removes_reserved_device_named_files() {
        let (dir, repo) = setup_repo("discard-reserved").await;
        let root = dir.path().to_path_buf();
        for name in ["nul", "nul.txt"] {
            std::fs::write(verbatim(&root, name), b"x\n").expect("verbatim write");
        }

        let state = AppState::default();
        git_discard_paths_core(
            &state,
            repo.clone(),
            vec![DiscardPath {
                path: "nul".into(),
                untracked: true,
            }],
        )
        .await
        .expect("the selected reserved-name file is discarded");
        // `git_discard_all_core` takes the remaining one off the untracked list.
        git_discard_all_core(&state, repo.clone())
            .await
            .expect("discard-all clears the reserved-name file");

        let listed: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        for name in ["nul", "nul.txt"] {
            assert!(
                std::fs::metadata(verbatim(&root, name)).is_err(),
                "{name} is gone from disk"
            );
            assert!(!listed.contains(&name.to_string()), "{name} is not listed");
        }
    }

    /// Discard-all is one compound: the untracked sweep must run INSIDE the hold,
    /// not before it, or work staged while the recycle-bin pass grinds through a
    /// large tree is destroyed by the reset with no copy anywhere. Multi-threaded
    /// flavor so the spawned discard genuinely races the hold. Windows-gated like
    /// every other test that reaches `trash_delete` — the OS trash is not a
    /// dependable fixture on the Linux/macOS CI legs.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn discard_all_holds_the_repo_across_the_untracked_sweep() {
        let (dir, repo) = setup_repo("discard-hold").await;
        commit_file(&repo, dir.path(), "tracked.txt", "v0\n", "add tracked").await;
        std::fs::write(dir.path().join("tracked.txt"), "dirty\n").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "u\n").unwrap();

        let state = std::sync::Arc::new(AppState::default());
        let domain = state.working_tree_lock(&repo).await;
        let guard = acquire_repo_lock_unbounded(&domain, "a commit").await;

        let discard = {
            let state = state.clone();
            let repo = repo.clone();
            tokio::spawn(async move { git_discard_all_core(&state, repo).await })
        };
        // Lock-free, the sweep trashes the file within milliseconds — this window is
        // what the hold has to keep shut. One-directional: a discard that had not yet
        // reached the acquire would also leave the file in place, so a green here is
        // only meaningful against the revert control (trash outside the hold → red),
        // which is what calibrates the wait. Nothing observable marks the acquire
        // itself, and inventing a seam for it would only move the race.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(
            dir.path().join("untracked.txt").exists(),
            "the untracked sweep must wait for the lock, not run ahead of it"
        );

        drop(guard);
        discard
            .await
            .expect("discard task panicked")
            .expect("the discard succeeds once the hold releases");
        assert!(!dir.path().join("untracked.txt").exists());
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("tracked.txt")).unwrap()),
            "v0\n"
        );
    }

    // --- git_stash_paths_core: selective stash must not leak unselected staged files ---

    /// Strip CRLF → LF so content assertions are line-ending-agnostic: on Windows
    /// with `core.autocrlf=true` git checks blobs out CRLF, so a worktree read (or a
    /// `git show :f` of a text blob) comes back with `\r\n`.
    fn nlf(s: impl AsRef<str>) -> String {
        s.as_ref().replace("\r\n", "\n")
    }

    /// Names listed in a stash entry (`^2` index + `^3` untracked), one per line.
    async fn stash_names(repo: &str) -> Vec<String> {
        git(
            repo,
            &[
                "stash",
                "show",
                "--include-untracked",
                "--name-only",
                "stash@{0}",
            ],
        )
        .await
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// Count of stash entries.
    async fn stash_count(repo: &str) -> usize {
        git(repo, &["stash", "list"])
            .await
            .lines()
            .filter(|l| !l.is_empty())
            .count()
    }

    #[tokio::test]
    async fn directory_selection_matches_pathspec_semantics() {
        let (dir, repo) = setup_repo("stash-dir-selection").await;
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        commit_file(&repo, dir.path(), "src/a.txt", "a0\n", "add src/a").await;
        commit_file(&repo, dir.path(), "src/b.txt", "b0\n", "add src/b").await;
        commit_file(&repo, dir.path(), "other.txt", "o0\n", "add other").await;
        // Stage changes to src/a.txt AND other.txt; leave src/b.txt unstaged.
        std::fs::write(dir.path().join("src/a.txt"), "a1\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "o1\n").unwrap();
        git(&repo, &["add", "src/a.txt", "other.txt"]).await;
        std::fs::write(dir.path().join("src/b.txt"), "b1\n").unwrap();

        let state = AppState::default();
        // A directory pathspec: git stashes src/* recursively, so the classification
        // must treat both src files as selected (not misclassify them as unselected).
        git_stash_paths_core(&state, repo.clone(), vec!["src".into()])
            .await
            .unwrap();

        // Stash lists exactly the two src files (order-insensitive).
        let mut names = stash_names(&repo).await;
        names.sort();
        assert_eq!(names, vec!["src/a.txt".to_string(), "src/b.txt".to_string()]);
        // other.txt still staged with its full change.
        assert_eq!(nlf(git(&repo, &["show", ":other.txt"]).await), "o1\n");
        // Both src files reverted to HEAD in the worktree.
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("src/a.txt")).unwrap()), "a0\n");
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("src/b.txt")).unwrap()), "b0\n");
        // No split-brain: neither src file is left staged (which would mean its
        // change lives in BOTH the stash and the index).
        let cached = git(&repo, &["diff", "--cached", "--name-only"]).await;
        assert!(!cached.contains("src/a.txt"), "src/a.txt not staged: {cached:?}");
        assert!(!cached.contains("src/b.txt"), "src/b.txt not staged: {cached:?}");
    }

    #[tokio::test]
    async fn stashes_only_selected_leaves_unselected_fully_staged() {
        let (dir, repo) = setup_repo("stash-only-selected").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // A fully staged, B unstaged working-tree change.
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        // Stash lists ONLY B — A did not ride along.
        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // A is still staged with its full change.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
        // B was reverted to HEAD in the worktree.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("B")).unwrap()),
            "b0\n"
        );
    }

    #[tokio::test]
    async fn fast_path_stashes_selection_when_nothing_else_staged() {
        // Fast path: nothing staged at all, so the native pathspec stash is exact.
        let (dir, repo) = setup_repo("stash-fast-nothing-staged").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // Only an UNSTAGED change to B; index is clean.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // B reverted to HEAD in the worktree.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("B")).unwrap()),
            "b0\n"
        );
        // No staged entries appeared (the fast path staged nothing).
        assert!(
            git(&repo, &["diff", "--cached", "--name-only"]).await.trim().is_empty(),
            "no staged entries after fast-path stash"
        );
        assert_eq!(stash_count(&repo).await, 1);
    }

    #[tokio::test]
    async fn fast_path_when_selection_is_the_only_staged_file() {
        // Fast path: the selection IS the only staged file, so nothing else needs
        // protecting.
        let (dir, repo) = setup_repo("stash-fast-only-staged").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["A".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["A".to_string()]);
        // A reverted to HEAD in the worktree; A's staged change went into the stash.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a0\n"
        );
        assert!(
            git(&repo, &["diff", "--cached", "--name-only"]).await.trim().is_empty(),
            "no staged entries after fast-path stash"
        );
        // Popping restores A's change to the worktree.
        git(&repo, &["stash", "pop"]).await;
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a1\n"
        );
    }

    // Helper: overwrite `f` with `staged`, `git add f`, then overwrite the worktree
    // with `worktree` — the index now holds `staged`, the worktree holds `worktree`
    // (deterministic hunk-level partial staging).
    async fn partial_stage(repo: &str, dir: &std::path::Path, f: &str, staged: &str, worktree: &str) {
        std::fs::write(dir.join(f), staged).unwrap();
        git(repo, &["add", f]).await;
        std::fs::write(dir.join(f), worktree).unwrap();
    }

    #[tokio::test]
    async fn preserves_unselected_partial_staging() {
        let (dir, repo) = setup_repo("stash-partial-unselected").await;
        let full = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
        commit_file(&repo, dir.path(), "A2", full, "add A2").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // A2 partially staged: index gets line2 edited, worktree also edits line9.
        let staged = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
        let worktree = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\n";
        partial_stage(&repo, dir.path(), "A2", staged, worktree).await;
        // B unstaged.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        // Stash lists only B.
        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // A2's index blob (partial hunk) and worktree are both unchanged.
        assert_eq!(nlf(git(&repo, &["show", ":A2"]).await), staged);
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A2")).unwrap()),
            worktree
        );
    }

    #[tokio::test]
    async fn preserves_unselected_staged_new_and_deletion() {
        let (dir, repo) = setup_repo("stash-new-and-delete").await;
        commit_file(&repo, dir.path(), "D", "d0\n", "add D").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // N staged-new.
        std::fs::write(dir.path().join("N"), "n0\n").unwrap();
        git(&repo, &["add", "N"]).await;
        // D staged-delete.
        git(&repo, &["rm", "D"]).await;
        // B unstaged.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // N still staged as an addition; D still staged as a deletion.
        let staged_status = git(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(staged_status.contains("A\tN"), "N staged-new: {staged_status:?}");
        assert!(staged_status.contains("D\tD"), "D staged-delete: {staged_status:?}");

        // After popping the (B-only) stash, N/D states are intact.
        git(&repo, &["stash", "pop"]).await;
        let after = git(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(after.contains("A\tN"), "N intact after pop: {after:?}");
        assert!(after.contains("D\tD"), "D intact after pop: {after:?}");
    }

    #[tokio::test]
    async fn selected_partially_staged_file_fully_stashed_and_reverts() {
        let (dir, repo) = setup_repo("stash-selected-partial").await;
        let full = "p1\np2\np3\n";
        commit_file(&repo, dir.path(), "P", full, "add P").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        // P partially staged (selected): index edits p1, worktree also edits p3.
        let staged = "P1\np2\np3\n";
        let worktree = "P1\np2\nP3\n";
        partial_stage(&repo, dir.path(), "P", staged, worktree).await;
        // A fully staged (unselected).
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["P".into()])
            .await
            .unwrap();

        // Stash lists only P; A stayed staged.
        assert_eq!(stash_names(&repo).await, vec!["P".to_string()]);
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
        // P reverted to HEAD in the worktree.
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("P")).unwrap()), full);

        // Popping restores P's FULL change into the worktree — both the staged and
        // unstaged hunks (p1→P1 AND p3→P3). A plain `stash pop` (no --index) restores
        // to the worktree only, so we assert the file content, not the index split.
        git(&repo, &["stash", "pop"]).await;
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("P")).unwrap()),
            worktree
        );
    }

    #[tokio::test]
    async fn selected_untracked_file_stashed_and_removed() {
        let (dir, repo) = setup_repo("stash-selected-untracked").await;
        // Another staged file so we exercise the index-protecting path.
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;
        // U untracked, selected.
        std::fs::write(dir.path().join("U"), "u0\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["U".into()])
            .await
            .unwrap();

        // U gone from the worktree, and listed in the stash's untracked parent.
        assert!(!dir.path().join("U").exists(), "U removed from worktree");
        assert_eq!(stash_names(&repo).await, vec!["U".to_string()]);
        // A left staged, untouched.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
    }

    #[tokio::test]
    async fn refuses_selective_stash_during_merge() {
        let (dir, repo) = setup_repo("stash-merge-refuse").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Two branches editing x divergently → conflicting merge.
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "x", "other\n", "other edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        // Conflicting merge leaves an unmerged index (merge in progress). Use
        // run_git_raw — a conflicting `git merge` exits non-zero, which run_git
        // would surface as an Err.
        let merge = run_git_raw(Some(&repo), &["merge", "other"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(merge.code, 0, "merge should conflict");

        let state = AppState::default();
        let err = git_stash_paths_core(&state, repo.clone(), vec!["x".into()])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        // No stash created.
        assert_eq!(stash_count(&repo).await, 0);
    }

    // --- mid-operation stash guard ------------------------------------------
    //
    // The destructive state is a merge/rebase/cherry-pick whose conflicts are
    // RESOLVED AND STAGED: `ls-files --unmerged` reads empty while the op marker
    // stands, and a stash there sweeps both the resolution and the marker away.

    async fn head_branch(repo: &str) -> String {
        git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string()
    }

    /// A staged-resolved operation leaves no unmerged entries — the half of the
    /// guard that cannot see it.
    async fn nothing_unmerged(repo: &str) -> bool {
        git(repo, &["ls-files", "--unmerged"])
            .await
            .trim()
            .is_empty()
    }

    /// Two branches editing `x` divergently, merged, then resolved and staged —
    /// MERGE_HEAD present, no unmerged entries.
    async fn staged_resolved_merge(marker: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "x", "other\n", "other edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        // run_git_raw: a conflicting merge exits non-zero.
        let merge = run_git_raw(Some(&repo), &["merge", "other"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(merge.code, 0, "merge should conflict");
        std::fs::write(dir.path().join("x"), "resolved\n").unwrap();
        git(&repo, &["add", "x"]).await;
        (dir, repo)
    }

    #[tokio::test]
    async fn stash_all_refuses_a_staged_but_uncommitted_merge() {
        let (_dir, repo) = staged_resolved_merge("stash-all-staged-merge").await;
        // Pins the exact gap: nothing unmerged is left, only the op marker.
        assert!(nothing_unmerged(&repo).await);
        assert!(op_state(&repo).await.unwrap().merging);

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(
            op_state(&repo).await.unwrap().merging,
            "the merge must still be in progress"
        );
        assert_eq!(nlf(git(&repo, &["show", ":x"]).await), "resolved\n");
    }

    /// A `--no-commit` merge never conflicts at all, so an unmerged-entry check can
    /// never see it — and stashing it drops the merged-in file entirely.
    #[tokio::test]
    async fn stash_all_refuses_a_no_commit_merge() {
        let (dir, repo) = setup_repo("stash-all-no-commit-merge").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "y", "other\n", "add y").await;
        git(&repo, &["switch", &base]).await;
        git(&repo, &["merge", "--no-commit", "--no-ff", "other"]).await;
        assert!(nothing_unmerged(&repo).await);
        assert!(op_state(&repo).await.unwrap().merging);

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(op_state(&repo).await.unwrap().merging);
        assert_eq!(nlf(git(&repo, &["show", ":y"]).await), "other\n");
    }

    /// The costliest arm: stashing here leaves the rebase running, and the later
    /// `rebase --continue` drops the replayed commit from history outright.
    #[tokio::test]
    async fn stash_all_refuses_a_paused_rebase_with_a_staged_resolution() {
        let (dir, repo) = setup_repo("stash-all-rebase").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "x", "feature\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        git(&repo, &["switch", "feature"]).await;
        let rebase = run_git_raw(Some(&repo), &["rebase", &base], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(rebase.code, 0, "rebase should conflict");
        std::fs::write(dir.path().join("x"), "resolved\n").unwrap();
        git(&repo, &["add", "x"]).await;
        assert!(nothing_unmerged(&repo).await);
        assert!(op_state(&repo).await.unwrap().rebasing);

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(
            op_state(&repo).await.unwrap().rebasing,
            "the paused rebase must survive"
        );
        assert_eq!(nlf(git(&repo, &["show", ":x"]).await), "resolved\n");
    }

    #[tokio::test]
    async fn stash_all_refuses_a_staged_cherry_pick() {
        let (dir, repo) = setup_repo("stash-all-cherry-pick").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "x", "other\n", "other edit").await;
        let pick_sha = rev(&repo, "HEAD").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        let picked = run_git_raw(Some(&repo), &["cherry-pick", &pick_sha], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(picked.code, 0, "cherry-pick should conflict");
        std::fs::write(dir.path().join("x"), "resolved\n").unwrap();
        git(&repo, &["add", "x"]).await;
        assert!(nothing_unmerged(&repo).await);
        assert!(op_state(&repo).await.unwrap().cherry_picking);

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(
            op_state(&repo).await.unwrap().cherry_picking,
            "the cherry-pick must still be in progress"
        );
        assert_eq!(nlf(git(&repo, &["show", ":x"]).await), "resolved\n");
    }

    /// The selective path destroys only when the selection COVERS the resolved
    /// path, so that is what this selects (an unrelated path is measurably safe).
    #[tokio::test]
    async fn refuses_selective_stash_during_a_staged_merge() {
        let (_dir, repo) = staged_resolved_merge("stash-paths-staged-merge").await;
        assert!(nothing_unmerged(&repo).await);

        let state = AppState::default();
        let err = git_stash_paths_core(&state, repo.clone(), vec!["x".into()])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(op_state(&repo).await.unwrap().merging);
        assert_eq!(nlf(git(&repo, &["show", ":x"]).await), "resolved\n");
    }

    /// Both refusal sentences are user-visible copy (the toast prints them
    /// verbatim), and each arm has its own: conflicts to resolve vs. an operation
    /// to finish or abort.
    #[tokio::test]
    async fn mid_op_refusal_names_the_arm_it_caught() {
        // Unmerged arm: a conflicting merge, nothing resolved yet.
        let (dir, repo) = setup_repo("stash-guard-wording").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "x", "other\n", "other edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        run_git_raw(Some(&repo), &["merge", "other"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        fn message(err: AppError) -> String {
            match err {
                AppError::InvalidArgument(msg) => msg,
                other => panic!("expected a refusal, got {other:?}"),
            }
        }

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert_eq!(
            message(err),
            "Can't stash while a conflict is in progress — resolve the conflicts first."
        );

        // Op-state arm: the same merge, resolved and staged.
        let (_dir, repo) = staged_resolved_merge("stash-guard-wording-staged").await;
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert_eq!(
            message(err),
            "Can't stash while a merge, rebase, cherry-pick or revert is in progress — finish or abort it first."
        );
    }

    /// Over-refusal check: with no operation in flight, stash-all still puts both
    /// tracked and untracked work away.
    #[tokio::test]
    async fn stash_all_succeeds_on_a_plain_dirty_tree() {
        let (dir, repo) = setup_repo("stash-all-dirty").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        std::fs::write(dir.path().join("U"), "u\n").unwrap();

        let state = AppState::default();
        git_stash_all_core(&state, repo.clone()).await.unwrap();

        assert_eq!(stash_count(&repo).await, 1);
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a0\n"
        );
        assert!(!dir.path().join("U").exists(), "untracked work was stashed");
    }

    /// An untracked reserved-device name makes `stash push --include-untracked`
    /// write the entry and then fail removing it, leaving a stash AND the tree
    /// untouched. Excluding it puts the rest of the work away and leaves the
    /// unreachable file alone.
    #[cfg(windows)]
    #[tokio::test]
    async fn stash_all_works_around_a_reserved_device_named_file() {
        let (dir, repo) = setup_repo("stash-reserved").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        std::fs::write(verbatim(dir.path(), "nul"), b"x\n").expect("verbatim write");

        let state = AppState::default();
        git_stash_all_core(&state, repo.clone()).await.unwrap();

        assert_eq!(stash_count(&repo).await, 1);
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a0\n",
            "the tracked change is stashed, not merely recorded"
        );
        assert!(
            std::fs::metadata(verbatim(dir.path(), "nul")).is_ok(),
            "the reserved-name file stays put"
        );
    }

    /// Excluding every change would leave git nothing to stash, which it reports
    /// as success — the refusal is what tells the user why nothing happened.
    #[cfg(windows)]
    #[tokio::test]
    async fn stash_all_refuses_when_only_a_reserved_device_name_changed() {
        let (dir, repo) = setup_repo("stash-reserved-only").await;
        std::fs::write(verbatim(dir.path(), "nul"), b"x\n").expect("verbatim write");

        let state = AppState::default();
        let err = git_stash_all_core(&state, repo.clone()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(stash_count(&repo).await, 0);
        assert!(std::fs::metadata(verbatim(dir.path(), "nul")).is_ok());
    }

    /// Off Windows `nul` is an ordinary file name, so the exclusion must not fire
    /// — this pins the `cfg!(windows)` gate rather than the exclusion itself.
    #[cfg(not(windows))]
    #[tokio::test]
    async fn stash_all_stashes_a_file_named_nul_off_windows() {
        let (dir, repo) = setup_repo("stash-nul-unix").await;
        std::fs::write(dir.path().join("nul"), "u\n").unwrap();

        let state = AppState::default();
        git_stash_all_core(&state, repo.clone()).await.unwrap();

        assert_eq!(stash_count(&repo).await, 1);
        assert!(!dir.path().join("nul").exists(), "it stashes like any file");
    }

    /// A reserved-device FILE inside a collapsed ignored directory aborts the whole
    /// force-add, and the user cannot see it to deselect it. Excluding those names
    /// tracks the rest of the directory. The `nul.d/` arm covers the reserved
    /// DIRECTORY shape (which git can only warn about, never index) and the `com10`
    /// arm is the over-match control.
    #[cfg(windows)]
    #[tokio::test]
    async fn force_add_skips_reserved_names_inside_an_ignored_directory() {
        let (dir, repo) = setup_repo("force-add-reserved").await;
        commit_file(&repo, dir.path(), ".gitignore", "junk/\n", "ignore junk").await;
        let junk = dir.path().join("junk");
        std::fs::create_dir(&junk).unwrap();
        std::fs::write(junk.join("keep.txt"), "k\n").unwrap();
        std::fs::write(junk.join("com10.txt"), "c\n").unwrap();
        std::fs::write(verbatim(&junk, "nul.txt"), b"n\n").expect("verbatim write");
        let nul_dir = verbatim(&junk, "nul.d");
        std::fs::create_dir(&nul_dir).expect("verbatim mkdir");
        std::fs::write(nul_dir.join("inner.txt"), b"i\n").expect("verbatim write");

        let state = AppState::default();
        // The literal spelling the ignored-files dialog actually sends.
        git_force_add_core(&state, repo.clone(), vec![crate::git::pathspec::literal("junk/")])
            .await
            .expect("the reserved name is skipped instead of aborting the add");

        let tracked = git(&repo, &["ls-files"]).await;
        let names: Vec<&str> = tracked.lines().collect();
        assert!(names.contains(&"junk/keep.txt"), "{names:?}");
        assert!(
            names.contains(&"junk/com10.txt"),
            "com10 is an ordinary name and must still be tracked: {names:?}"
        );
        assert!(!names.contains(&"junk/nul.txt"), "{names:?}");
        assert!(!names.contains(&"junk/nul.d/inner.txt"), "{names:?}");

        // The temp dir's own cleanup walks plain paths and cannot reach either.
        std::fs::remove_file(nul_dir.join("inner.txt")).expect("verbatim unlink");
        std::fs::remove_dir(&nul_dir).expect("verbatim rmdir");
        std::fs::remove_file(verbatim(&junk, "nul.txt")).expect("verbatim unlink");
    }

    #[tokio::test]
    async fn empty_selection_is_noop() {
        let (dir, repo) = setup_repo("stash-empty").await;
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec![])
            .await
            .unwrap();

        assert!(!created);
        assert_eq!(stash_count(&repo).await, 0);
    }

    /// A selection that matches nothing reports `false`. `git stash push` exits 0
    /// on that path, so without the return the MCP tool answers "stashed" for a
    /// no-op and the agent believes work was put away.
    #[tokio::test]
    async fn selection_matching_nothing_reports_no_stash() {
        let (dir, repo) = setup_repo("stash-no-match").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        // An unrelated uncommitted change, so the repo is NOT clean overall.
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["nonexistent.txt".into()])
            .await
            .unwrap();

        assert!(!created, "nothing matched, so no stash entry was created");
        assert_eq!(stash_count(&repo).await, 0);
        // The unrelated change is untouched.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a1\n"
        );
    }

    /// The index-protecting slow path reports the same way: the selection matches
    /// nothing while another file stays staged.
    #[tokio::test]
    async fn slow_path_selection_matching_nothing_reports_no_stash() {
        let (dir, repo) = setup_repo("stash-no-match-slow").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["nonexistent.txt".into()])
            .await
            .unwrap();

        assert!(!created);
        assert_eq!(stash_count(&repo).await, 0);
        // A survived the reset/restore round trip with its staged blob intact.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
    }

    #[tokio::test]
    async fn real_selection_reports_a_stash_was_created() {
        let (dir, repo) = setup_repo("stash-reports-created").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert!(created);
        assert_eq!(stash_count(&repo).await, 1);
    }

    /// A local-PR merge must never advance `base` while an update holds it. The marker
    /// alone is the signal in the PRE-ADD window — nothing is in `worktree list` yet —
    /// so `finalize_base` has to refuse before it reads the porcelain at all.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn finalize_base_refuses_while_an_update_holds_the_base_branch() {
        use crate::git::update_marker as marker;
        let (dir, repo) = setup_repo("finalize-update-guard").await;
        git(&repo, &["branch", "feature"]).await;
        let tip = rev(&repo, "refs/heads/feature").await;
        let root = dir.path().join("gd-worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        let _live = marker::UpdateMarker::create_for(&root.join("gd-update-live"), "feature")
            .expect("the marker mints");

        let state = AppState::default();
        let current = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let err = finalize_base(&state, &repo, "feature", &tip, &current, Some(&tip))
            .await
            .expect_err("advancing a branch an update is merging is refused");
        assert_eq!(
            err.to_string(),
            marker::branch_update_refusal("feature").to_string()
        );
        assert_eq!(
            rev(&repo, "refs/heads/feature").await,
            tip,
            "and the branch is exactly where it was"
        );
    }
}
