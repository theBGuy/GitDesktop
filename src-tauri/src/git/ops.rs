use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::commit::{ExpectedRef, SWITCH_ROLLBACK_HINT};
use crate::git::diff::parse_numstat_z;
use crate::git::history::validate_hash;
use crate::git::ignored_guard::{self, ignored_files_in_the_way};
use crate::git::runner::{
    acquire_repo_lock, run_git, run_git_mutating, run_git_mutating_raw, run_git_raw,
    run_git_raw_env, run_git_raw_index_retry, run_git_raw_input, run_git_worktree_admin,
    DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT,
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
/// deliberately allowed: `reset --hard` leaves them alone only where the target
/// tracks no file at their path, so a caller resetting to an arbitrary commit
/// also needs [`refuse_untracked_reset_collisions`]. A merge, switch or pick that
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

/// How many colliding paths a refusal names before summarizing the rest.
const COLLISIONS_NAMED: usize = 5;

/// Refuses a `reset --hard <target>` that would overwrite untracked files: git
/// deletes any untracked file or directory in the way of a path the target
/// tracks (git-reset(1)), leaving no stash, object or reflog to recover it from.
/// Ignored files are deliberately not guarded, so build-artifact churn can't
/// block a legitimate reset. Callers hold the working-tree lock and have already
/// passed [`ensure_clean_tree`], so the index matches HEAD and an untracked path
/// is by definition one HEAD doesn't track.
async fn refuse_untracked_reset_collisions(repo: &str, target: &str) -> AppResult<()> {
    // Every listing runs from the resolved toplevel: they are cwd-relative, so only
    // from there do their paths line up and cover the whole tree the reset writes.
    let top = crate::git::runner::worktree_toplevel(repo).await?;
    let untracked: Vec<String> = git_list_untracked(top.clone())
        .await?
        .into_iter()
        .map(|entry| entry.path)
        .collect();
    if untracked.is_empty() {
        return Ok(());
    }
    let tracked = run_git(
        Some(&top),
        &["ls-tree", "-r", "--name-only", "-z", target],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    // A case-folding filesystem overwrites `G.txt` when the target writes `g.txt`
    // (measured, git 2.51.1 on NTFS), so the match folds exactly when git does.
    let ignore_case = run_git_raw(
        Some(&top),
        &["config", "--bool", "core.ignorecase"],
        DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|o| o.code == 0 && o.stdout_lossy().trim() == "true");
    let tracked: Vec<&str> = tracked.split('\0').filter(|s| !s.is_empty()).collect();
    let colliding = colliding_untracked(&untracked, &tracked, ignore_case);
    if colliding.is_empty() {
        return Ok(());
    }
    let mut named = colliding
        .iter()
        .take(COLLISIONS_NAMED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    if colliding.len() > COLLISIONS_NAMED {
        named.push_str(&format!(" and {} more", colliding.len() - COLLISIONS_NAMED));
    }
    // "Path", not "file": an entry can be a directory (`sub/`) or a file inside
    // one, standing where the target needs a file.
    let (noun, pronoun) = if colliding.len() == 1 {
        ("an untracked path", "it")
    } else {
        ("untracked paths", "them")
    };
    Err(AppError::InvalidArgument(format!(
        "resetting would overwrite {noun} ({named}) — move or remove {pronoun} first"
    )))
}

/// The untracked paths a checkout of `tracked` would overwrite: an exact match,
/// an untracked file standing where the target needs a directory, or an untracked
/// directory (or file inside one) standing where the target needs a file. An
/// untracked file merely sharing a directory with a tracked one is not in the way.
fn colliding_untracked(untracked: &[String], tracked: &[&str], ignore_case: bool) -> Vec<String> {
    let fold = |p: &str| {
        if ignore_case {
            p.to_lowercase()
        } else {
            p.to_string()
        }
    };
    let mut files = std::collections::HashSet::new();
    let mut dirs = std::collections::HashSet::new();
    for path in tracked {
        let path = fold(path);
        for (i, _) in path.match_indices('/') {
            dirs.insert(path[..i].to_string());
        }
        files.insert(path);
    }
    untracked
        .iter()
        .filter(|raw| {
            // `ls-files --others` names an untracked nested repository as `dir/`.
            let path = fold(raw.trim_end_matches('/'));
            files.contains(&path)
                || dirs.contains(&path)
                || path
                    .match_indices('/')
                    .any(|(i, _)| files.contains(&path[..i]))
        })
        .cloned()
        .collect()
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
/// executed todo line is `edit`/`e`), as opposed to a conflict. git writes
/// `rebase-merge/amend` only at a completed edit stop: an `edit` line that itself
/// failed (a held index.lock, a conflict) leaves the same `done` without it.
fn rebase_stopped_for_edit(git_dir: &Path) -> bool {
    if !git_dir.join("rebase-merge/amend").exists() {
        return false;
    }
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
/// the todo's verb is the only signal for that window — a user's own
/// multi-commit pick leaves it. An unreadable or empty todo reads as
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

/// The branch state `git reset` clears once it moves HEAD, both `--hard` and `--soft`
/// (measured, git 2.51.1): the merge and squash message files, rerere's `MERGE_RR`, and
/// the `AUTO_MERGE`, `CHERRY_PICK_HEAD` and `REVERT_HEAD` refs, and a stopped
/// `merge --autostash`'s `MERGE_AUTOSTASH`, which it files in the stash list. For the
/// resets that move their ref with `update-ref`, which clears none of it. Best-effort, as
/// in git: the move already landed, so nothing here fails it.
pub(crate) async fn clear_branch_state(repo: &str) {
    let mut args = vec!["rev-parse"];
    for name in ["MERGE_MSG", "SQUASH_MSG", "MERGE_MODE", "MERGE_RR"] {
        args.extend(["--git-path", name]);
    }
    if let Ok(out) = run_git(Some(repo), &args, DEFAULT_TIMEOUT).await {
        for path in out.stdout_lossy().lines() {
            let _ = std::fs::remove_file(Path::new(repo).join(path.trim_end_matches('\r')));
        }
    }
    for name in ["AUTO_MERGE", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        let _ = run_git_raw(
            Some(repo),
            &["update-ref", "--no-deref", "-d", name],
            DEFAULT_TIMEOUT,
        )
        .await;
    }
    // git's own message for the entry (measured, git 2.51.1). Unlike git, the ref goes only
    // once the stash list holds the entry, so a failed store never loses it.
    if let Ok(Some(stash)) = crate::git::commit::ref_oid(repo, "MERGE_AUTOSTASH").await {
        let stored = run_git_raw(
            Some(repo),
            &["stash", "store", "-m", "autostash", "-q", &stash],
            DEFAULT_TIMEOUT,
        )
        .await;
        if matches!(stored, Ok(out) if out.code == 0) {
            let _ = run_git_raw(
                Some(repo),
                &["update-ref", "--no-deref", "-d", "MERGE_AUTOSTASH", &stash],
                DEFAULT_TIMEOUT,
            )
            .await;
        }
    }
}

/// Branch-state fixtures the reset and undo parity pins share across modules. A test
/// module, so the guard scripts read the fixture merge as test code. Test-only.
#[cfg(test)]
pub(crate) mod branch_state_fixtures {
    use super::*;

    /// Which branch-state names exist in `repo` now, as files or as refs. Test-only: the
    /// parity pins compare it across git's own reset and the compare-and-swap ones.
    pub(crate) async fn branch_state_present(repo: &str) -> Vec<&'static str> {
        let mut present = Vec::new();
        for name in ["MERGE_MSG", "SQUASH_MSG", "MERGE_MODE", "MERGE_RR"] {
            if git_path_exists(repo, name).await {
                present.push(name);
            }
        }
        for name in [
            "AUTO_MERGE",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "MERGE_AUTOSTASH",
        ] {
            if crate::git::commit::ref_oid(repo, name)
                .await
                .unwrap()
                .is_some()
            {
                present.push(name);
            }
        }
        present
    }

    /// Writes every branch-state name `git reset` clears that no operation marker guards:
    /// the message files and rerere's `MERGE_RR` with throwaway bodies, and `AUTO_MERGE` at
    /// `oid`. Test-only, the synthetic half of the parity pins.
    pub(crate) async fn write_unguarded_branch_state(repo: &str, oid: &str) {
        for name in ["MERGE_MSG", "SQUASH_MSG", "MERGE_MODE", "MERGE_RR"] {
            let path = git_dir_path(repo, name)
                .await
                .expect("the git path resolves");
            std::fs::write(path, "x\n").unwrap();
        }
        run_git(
            Some(repo),
            &["update-ref", "AUTO_MERGE", oid],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
    }

    /// Stops a conflicted `merge --squash --autostash` on top of HEAD, a dirty tracked file
    /// stashed, and resolves it to HEAD's side: a clean tree holding MERGE_AUTOSTASH beside the
    /// squash's own state. Returns the autostash's oid. Test-only, the autostash parity pins.
    pub(crate) async fn stop_an_autostashed_squash(repo: &str) -> String {
        let dir = Path::new(repo);
        let git = |args: &'static [&'static str]| async move {
            run_git(Some(repo), args, DEFAULT_TIMEOUT).await.unwrap()
        };
        let start = crate::git::branches::current_branch_name(repo)
            .await
            .unwrap()
            .expect("fixture: HEAD is on a branch");
        std::fs::write(dir.join("auto.txt"), "base\n").unwrap();
        std::fs::write(dir.join("dirt.txt"), "clean\n").unwrap();
        git(&["add", "auto.txt", "dirt.txt"]).await;
        git(&["commit", "-qm", "autostash base"]).await;
        git(&["switch", "-qc", "autostash-feature"]).await;
        std::fs::write(dir.join("auto.txt"), "theirs\n").unwrap();
        git(&["commit", "-qam", "autostash theirs"]).await;
        run_git(Some(repo), &["switch", "-q", &start], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        std::fs::write(dir.join("auto.txt"), "mine\n").unwrap();
        git(&["commit", "-qam", "autostash mine"]).await;
        std::fs::write(dir.join("dirt.txt"), "dirty\n").unwrap();
        let squash = run_git_raw(
            Some(repo),
            &["merge", "--squash", "--autostash", "autostash-feature"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(squash.code, 0, "fixture: the squash stops on its conflict");
        git(&["checkout", "--ours", "--", "auto.txt"]).await;
        git(&["add", "auto.txt"]).await;
        crate::git::commit::ref_oid(repo, "MERGE_AUTOSTASH")
            .await
            .unwrap()
            .expect("fixture: the autostash is held")
    }
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
/// `--hard` also refuses when an untracked file sits at a path the target tracks,
/// which git would silently overwrite (see [`refuse_untracked_reset_collisions`]).
///
/// Every `--hard` guard and the reset itself run under ONE working-tree-lock hold,
/// so no other caller in THIS PROCESS can dirty the tree or start a merge between the
/// checks and a rewrite that has no stash and no reflog to recover from. The hold
/// is why the reset runs on the lock-free runners: `run_git_mutating` re-acquires
/// the same non-reentrant mutex and deadlocks, so its one-shot index.lock retry rides
/// `run_git_raw_index_retry` instead. The `--mixed` arm keeps `run_git_mutating`: it
/// has no guards to protect, so there is no check-then-act window and the retry is
/// worth more than a hold.
///
/// The hold's reach ends at this process, as `run_git_mutating`'s own doc says: a
/// separate MCP-server process holds its own lock, and no lock constrains a
/// terminal git or an editor writing files. So the `--hard` ref move is a
/// compare-and-swap against the tip the guards read: another process's commit in that
/// window refuses the reset instead of being discarded.
///
/// Worktree-correct without extra work: every spawn runs with `repo_path` as its
/// cwd, so a linked worktree resets ITS own HEAD and ITS own tree.
#[tauri::command]
pub async fn git_reset(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
    mode: Option<String>,
    expected_head: Option<String>,
    expected_branch: Option<String>,
) -> AppResult<()> {
    let expected_ref = ExpectedRef::from_wire(expected_branch)?;
    git_reset_core_expecting(&state, repo_path, hash, mode, expected_head, expected_ref).await
}

/// The refusal a hard reset gets when HEAD is no longer the tip the user confirmed.
/// KEEP IN STEP: one wording family with branches.rs's ref-move refusal and
/// commit.rs's `UNDO_HEAD_MOVED` ("… — nothing was <verb>.").
const RESET_HEAD_MOVED: &str = "The branch changed since you confirmed — nothing was reset.";

/// The refusal a hard reset gets when HEAD sits on another branch (or none) than the one
/// the user confirmed, even at the same commit. KEEP IN STEP with the family above, and
/// with the "HEAD moved while the dialog was open — nothing was reset." toasts in
/// SyncControls.tsx and BranchSwitcher.tsx that answer a switch the frontend sees first.
const RESET_BRANCH_SWITCHED: &str =
    "The checked-out branch changed since you confirmed — nothing was reset.";

/// The verdicts for a hard reset whose tree step failed after its ref moved, each leading
/// git's own text. `read-tree -u` can write some files before failing and moving the ref
/// back doesn't undo them, so none of them says nothing was reset.
const RESET_TREE_ROLLED_BACK: &str = "Updating your files failed, so the branch was moved back. \
                                      Some files may already show the reset's changes.";

/// The ref moved again before the rollback could move it back, so it stays where the
/// other process put it. `roll_back_reset` appends `SWITCH_ROLLBACK_HINT` to this verdict
/// and the two below.
const RESET_TREE_ROLLBACK_LOST: &str = "Updating your files failed, and another Git process \
                                        moved the branch before it could be moved back.";

/// The rollback itself failed with the ref still at the reset's target: a stale ref
/// `.lock`, not a race.
fn reset_tree_rollback_failed(oid: &str) -> String {
    format!(
        "Updating your files failed, and the branch couldn't be moved back: it now points at {}.",
        crate::git::commit::short_oid(oid)
    )
}

/// The rollback failed and the ref couldn't be re-read, so no commit is named.
const RESET_TREE_ROLLBACK_UNREAD: &str =
    "Updating your files failed, and the branch couldn't be moved back.";

#[cfg(test)]
tokio::task_local! {
    /// Awaited by the hard reset it is scoped to, after its guards and before the
    /// compare-and-swap, so a test can move HEAD inside that window.
    static RESET_PHASE_HOOK: crate::git::commit::PhaseHook;
    /// Awaited by the hard reset it is scoped to, after the compare-and-swap landed and
    /// before HEAD is re-read, so a test can switch branches inside that window.
    static RESET_SWAPPED_HOOK: crate::git::commit::PhaseHook;
    /// Awaited by the hard reset it is scoped to, after HEAD's re-read and before
    /// `read-tree`, so a test can fail the tree step or move the ref inside that window.
    static RESET_TREE_HOOK: crate::git::commit::PhaseHook;
}

pub(crate) async fn git_reset_core(
    state: &AppState,
    repo_path: String,
    hash: String,
    mode: Option<String>,
) -> AppResult<()> {
    git_reset_core_expecting(state, repo_path, hash, mode, None, ExpectedRef::Any).await
}

/// `expected_head` and `expected_ref` are consulted in the hard arm only: the reset then
/// runs only while HEAD is still that full oid on that branch (or detached, as it says),
/// checked first under the guards' hold, and the ref moves only while it still holds that
/// oid. The mixed arm ignores both, since its callers name an explicit user-chosen commit.
pub(crate) async fn git_reset_core_expecting(
    state: &AppState,
    repo_path: String,
    hash: String,
    mode: Option<String>,
    expected_head: Option<String>,
    expected_ref: ExpectedRef,
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
    // Identity before tree state: a dirty-tree refusal would mislead when the real
    // problem is a tip the user never saw.
    if expected_ref.moved(&repo_path).await? {
        return Err(AppError::Git {
            code: 1,
            stderr: RESET_BRANCH_SWITCHED.to_string(),
        });
    }
    if let Some(expected) = &expected_head {
        let current =
            run_git_raw(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
        // A non-zero exit is an unborn HEAD.
        if current.code != 0 || current.stdout_lossy().trim() != expected {
            return Err(AppError::Git {
                code: 1,
                stderr: RESET_HEAD_MOVED.to_string(),
            });
        }
    }
    ensure_clean_tree(&repo_path).await?;
    if op_state(&repo_path).await?.mid_op() {
        return Err(AppError::InvalidArgument(
            "an operation is still in progress — finish or abort it before resetting".into(),
        ));
    }
    // `update-ref` takes an oid as given where `reset --hard` peels, so the target is
    // resolved once and every step below writes that commit.
    let peeled = run_git(
        Some(&repo_path),
        &["rev-parse", "--verify", &format!("{hash}^{{commit}}")],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    refuse_untracked_reset_collisions(&repo_path, &peeled).await?;
    let cas = expected_ref.cas_ref(&repo_path).await?;
    // The swapped ref's own value, never HEAD's dereferenced one. `None` is an unborn
    // branch, reachable only unpinned (a pin refused it above); the swap then creates the
    // branch only while it still doesn't exist.
    let old = match expected_head {
        Some(expected) => Some(expected),
        None => cas.oid(&repo_path).await?,
    };
    #[cfg(test)]
    crate::git::commit::run_phase_hook(&RESET_PHASE_HOOK).await;
    let message = format!("reset: moving to {hash}");
    let out = cas
        .swap(&repo_path, &message, &peeled, old.as_deref())
        .await?;
    if out.code != 0 {
        return Err(cas
            .refusal(
                &repo_path,
                &expected_ref,
                old.as_deref(),
                &out,
                RESET_HEAD_MOVED,
                RESET_BRANCH_SWITCHED,
            )
            .await?);
    }
    #[cfg(test)]
    crate::git::commit::run_phase_hook(&RESET_SWAPPED_HOOK).await;
    // Before `read-tree`, so no file is written under a switched HEAD. A switch landing
    // between this read and `read-tree` taking index.lock stays unseen.
    cas.refuse_if_switched(
        &repo_path,
        old.as_deref(),
        Some(&peeled),
        RESET_BRANCH_SWITCHED,
        "reset",
        true,
    )
    .await?;
    #[cfg(test)]
    crate::git::commit::run_phase_hook(&RESET_TREE_HOOK).await;
    let tree = run_git_raw_index_retry(
        &repo_path,
        &["read-tree", "-u", "--reset", &peeled],
        DEFAULT_TIMEOUT,
    )
    .await;
    // A spawn failure or timeout rolls back like a failed exit: the ref already moved.
    let tree_failure = match &tree {
        Ok(out) if out.code == 0 => None,
        Ok(out) => Some((out.code, out.full_failure_text())),
        Err(e) => Some((1, e.to_string())),
    };
    if let Some((code, git_text)) = tree_failure {
        return Err(
            roll_back_reset(&repo_path, &cas, old.as_deref(), &peeled, code, &git_text).await,
        );
    }
    // After the tree step, as `git reset` writes it, so a rolled-back reset leaves it alone.
    if let Some(old) = &old {
        crate::git::commit::record_orig_head(&repo_path, old).await;
    }
    clear_branch_state(&repo_path).await;
    Ok(())
}

/// A hard reset's ref put back after its tree step failed, by a compare-and-swap from the
/// reset's own `peeled` target: it restores `old` only while nothing else moved the ref,
/// so a ref another process moved meanwhile is never moved back over it.
async fn roll_back_reset(
    repo_path: &str,
    cas: &crate::git::commit::CasRef,
    old: Option<&str>,
    peeled: &str,
    code: i32,
    git_text: &str,
) -> AppError {
    use crate::git::commit::RolledBack;
    let message = match cas.roll_back(repo_path, old, Some(peeled)).await {
        RolledBack::Restored => format!("{RESET_TREE_ROLLED_BACK}\n{git_text}"),
        RolledBack::Lost => {
            format!("{RESET_TREE_ROLLBACK_LOST} {SWITCH_ROLLBACK_HINT}\n{git_text}")
        }
        RolledBack::Stuck(why) => format!(
            "{} {SWITCH_ROLLBACK_HINT}\n{git_text}\n{why}",
            reset_tree_rollback_failed(peeled)
        ),
        RolledBack::Unread(why) => {
            format!("{RESET_TREE_ROLLBACK_UNREAD} {SWITCH_ROLLBACK_HINT}\n{git_text}\n{why}")
        }
    };
    AppError::Git {
        code,
        stderr: message,
    }
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

/// The `-m <n>` value for a merge commit's revert or pick: the 1-based parent that
/// counts as the mainline. Only the lower bound is checked here, since git itself
/// rejects a number above the commit's parent count. `None` passes no `-m`, so a
/// merge commit still fails with git's own reason.
fn mainline_arg(mainline: Option<u32>) -> AppResult<Option<String>> {
    match mainline {
        Some(0) => Err(AppError::InvalidArgument(
            "The mainline parent number starts at 1.".into(),
        )),
        Some(n) => Ok(Some(n.to_string())),
        None => Ok(None),
    }
}

/// The refusal for a multi-commit cherry-pick holding a merge commit.
pub(crate) const RANGE_MERGE_REFUSAL: &str =
    "This range contains a merge commit — cherry-pick it on its own to choose its mainline.";

/// Whether any of `hashes` is a merge commit, or `None` when git couldn't say.
/// The hashes go over stdin: one per argv slot, a large batch overflows Windows'
/// 32,767-character command line (about 790 full SHAs).
async fn batch_has_merge(repo_path: &str, hashes: &[String]) -> Option<bool> {
    let mut input = hashes.join("\n");
    input.push('\n');
    let out = run_git_raw_input(
        Some(repo_path),
        &["rev-list", "--stdin", "--no-walk", "--min-parents=2"],
        Some(&input),
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (out.code == 0).then(|| !out.stdout_lossy().trim().is_empty())
}

#[tauri::command]
pub async fn git_revert(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
    mainline: Option<u32>,
) -> AppResult<()> {
    git_revert_core(&state, repo_path, hash, mainline).await
}

pub(crate) async fn git_revert_core(
    state: &AppState,
    repo_path: String,
    hash: String,
    mainline: Option<u32>,
) -> AppResult<()> {
    validate_hash(&hash)?;
    let mainline = mainline_arg(mainline)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    let mut args = vec!["revert", "--no-edit"];
    if let Some(n) = &mainline {
        args.extend(["-m", n.as_str()]);
    }
    args.push(&hash);
    // Raw: a conflicted revert splits its report — `could not revert` on stderr,
    // the `CONFLICT (…` file list on stdout — so the error needs both halves.
    let out = run_git_mutating_raw(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
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
    mainline: Option<u32>,
) -> AppResult<bool> {
    git_cherry_pick_core(&state, repo_path, hash, mainline).await
}

pub(crate) async fn git_cherry_pick_core(
    state: &AppState,
    repo_path: String,
    hash: String,
    mainline: Option<u32>,
) -> AppResult<bool> {
    validate_hash(&hash)?;
    let mainline = mainline_arg(mainline)?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    let mut args = vec!["cherry-pick"];
    if let Some(n) = &mainline {
        args.extend(["-m", n.as_str()]);
    }
    args.push(&hash);
    // Raw: a conflicted pick splits its report — `could not apply` on stderr, the
    // `CONFLICT (…` file list on stdout — so the error needs both halves.
    let out = run_git_mutating_raw(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
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
/// names what was left behind and how to recover. `mainline` is a lone merge
/// commit's `-m` parent; a batch never takes one.
#[tauri::command]
pub async fn git_cherry_pick_onto(
    state: State<'_, AppState>,
    repo_path: String,
    hashes: Vec<String>,
    target_branch: String,
    mainline: Option<u32>,
) -> AppResult<CherryPickRangeResult> {
    cherry_pick_onto(&state, &repo_path, &hashes, &target_branch, mainline).await
}

/// Testable core of [`git_cherry_pick_onto`] — takes a plain `&AppState` so the
/// real-repo tokio tests can drive it (mirrors `rewrite_commits`).
pub(crate) async fn cherry_pick_onto(
    state: &AppState,
    repo_path: &str,
    hashes: &[String],
    target_branch: &str,
    mainline: Option<u32>,
) -> AppResult<CherryPickRangeResult> {
    cherry_pick_onto_with_timeouts(
        state,
        repo_path,
        hashes,
        target_branch,
        mainline,
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
    mainline: Option<u32>,
    pick_timeout: std::time::Duration,
    rollback_timeout: std::time::Duration,
) -> AppResult<CherryPickRangeResult> {
    validate_branch_arg(target_branch)?;
    for h in hashes {
        validate_hash(h)?;
    }
    let mainline = mainline_arg(mainline)?;
    if hashes.is_empty() {
        return Ok(CherryPickRangeResult {
            applied: 0,
            skipped: 0,
        });
    }

    // A batch never takes `-m`: one mainline number can't speak for every merge in
    // it, so a batch holding a merge refuses before anything moves. A lone merge
    // takes the caller's mainline, or without one keeps git's own verdict, rolled
    // back like any other single failure.
    if hashes.len() > 1 && mainline.is_some() {
        return Err(AppError::InvalidArgument(
            "A mainline parent applies to a single merge commit, not a batch.".into(),
        ));
    }
    // A check that can't run (an unresolvable hash among them) falls through to the
    // picks: the loop below already frames that failure in its rolled-back verdict.
    if hashes.len() > 1 && batch_has_merge(repo_path, hashes).await == Some(true) {
        return Err(AppError::InvalidArgument(RANGE_MERGE_REFUSAL.into()));
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
    // branch name, so fall back to restoring its commit directly. The branch NAME,
    // never the short ref: `git switch heads/<name>` refuses, while the plain name
    // picks the branch over a same-named tag.
    let original_branch = crate::git::branches::current_branch_name(repo_path).await?;
    if original_branch.is_some() && crate::git::branches::head_is_unborn(repo_path).await? {
        return Err(crate::git::branches::unborn_head_error());
    }
    let detached = original_branch.is_none();
    let original_restore = match original_branch {
        Some(name) => name,
        None => run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .trim()
            .to_string(),
    };

    // The target's tip before we touch it, so we can roll back cleanly. Read as the
    // branch the switch below lands on: the rollback resets `target` to this, so a
    // same-named tag's commit would discard the target's own work.
    let target_rev = crate::git::branches::branch_first_rev(repo_path, target_branch).await;
    let target_tip = run_git(
        Some(repo_path),
        &["rev-parse", &target_rev],
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
            let mut pick_args = vec!["cherry-pick"];
            if let Some(n) = &mainline {
                pick_args.extend(["-m", n.as_str()]);
            }
            pick_args.push(hash);
            let out = match run_git_raw(Some(repo_path), &pick_args, pick_timeout).await {
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

/// One row of a path listing. `path` is the lossy decode, for display only;
/// `undecodable` says the real name isn't valid UTF-8, so no text spelling of it
/// (and no verdict taken on that spelling) can be vouched for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathListingEntry {
    pub path: String,
    pub undecodable: bool,
}

/// Splits `-z` output on the NUL BYTE before any decode, so each name's
/// decodability is judged on its own raw bytes.
fn path_listing(stdout: &[u8]) -> Vec<PathListingEntry> {
    stdout
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| PathListingEntry {
            path: String::from_utf8_lossy(name).into_owned(),
            undecodable: std::str::from_utf8(name).is_err(),
        })
        .collect()
}

/// Every file git currently tracks (`git ls-files`), so the user can untrack one
/// that isn't showing pending changes (e.g. accidentally committed). Read-only.
#[tauri::command]
pub async fn git_list_tracked(repo_path: String) -> AppResult<Vec<PathListingEntry>> {
    let out = run_git(Some(&repo_path), &["ls-files", "-z"], DEFAULT_TIMEOUT).await?;
    Ok(path_listing(&out.stdout))
}

/// Every untracked file git would report as new (`ls-files --others
/// --exclude-standard`). The AI excluded-files view needs it because its corpus
/// is tracked plus untracked: an untracked NAME is disclosure the moment the file
/// shows up in status. Gitignored files stay out deliberately — they reach no AI
/// feature at all (absent from status and diffs), so the corpus matches what
/// generation actually sees. Read-only.
#[tauri::command]
pub async fn git_list_untracked(repo_path: String) -> AppResult<Vec<PathListingEntry>> {
    let out = run_git(
        Some(&repo_path),
        &["ls-files", "--others", "--exclude-standard", "-z"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(path_listing(&out.stdout))
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
        undecodable: false,
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
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a merge").await?;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Let git retain its own refusal for operations that already prevent a merge. A fetch
    // can't change this verdict, so a blocked merge skips the network wait that only the
    // ignored-file check needs.
    let blocked = ignored_guard::merge_is_blocked(&repo_path, &already_unmerged)
        .await
        .map_err(|e| ignored_guard::check_failed("Merge", e))?;
    let network = state.network_lock(&repo_path).await;
    let _net_guard = if blocked {
        None
    } else {
        Some(acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, "a merge").await?)
    };
    let mut args: Vec<&str> = vec!["merge", "--no-overwrite-ignore"];
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
    let rev = crate::git::branches::branch_first_rev(&repo_path, &branch).await;
    args.push(&rev);
    if !blocked {
        if let Some(incoming_sha) =
            ignored_guard::target_commit(&repo_path, &rev, DEFAULT_TIMEOUT, "Merge").await?
        {
            let paths = ignored_files_in_the_way(&repo_path, &incoming_sha, DEFAULT_TIMEOUT)
                .await
                .map_err(|e| ignored_guard::check_failed("Merge", e))?;
            if !paths.is_empty() {
                return Err(ignored_guard::merge_refusal(&branch, &paths));
            }
        }
    }
    // Raw, because a conflicted merge reports entirely on stdout and leaves
    // stderr empty — the combined text is what keeps that report in the error.
    let out = run_git_raw_index_retry(&repo_path, &args, DEFAULT_TIMEOUT).await?;
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
    let branch = crate::git::branches::branch_first_rev(&repo_path, &branch).await;

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
    let rev = crate::git::branches::branch_first_rev(&repo_path, &branch).await;
    let already_unmerged = unmerged_paths(&repo_path).await;
    // Raw: a conflicted rebase splits its report — `could not apply` plus the
    // resolve hints on stderr, the `CONFLICT (…` file list on stdout.
    let out = run_git_mutating_raw(
        state,
        &repo_path,
        &["-c", "core.editor=true", "rebase", &rev],
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
    let new_base = &crate::git::branches::branch_first_rev(repo_path, new_base).await;
    let old_base = &crate::git::branches::branch_first_rev(repo_path, old_base).await;
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

/// The app-data worktrees base, `<data_dir>/<identifier>/worktrees`: every
/// per-repository root sits directly in it. Mirrors `worktree.rs::worktree_root`'s
/// base derivation (that function returns a per-repo root), but resolved via
/// `dirs::data_dir()` (as `local_prs.rs` / `oplog.rs` do) since the merge
/// commands carry no `AppHandle`. Tauri's `app_data_dir()` is exactly
/// `dirs::data_dir()/<identifier>`, so this points at the same directory.
fn worktrees_base_dir() -> AppResult<std::path::PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data
        .join(crate::local_prs::APP_IDENTIFIER)
        .join("worktrees"))
}

/// The root for a repo KEY under `base`: `<base>/<repo_hash(key)>`. Two keys are in
/// use — the checkout path ([`worktree_root_dir`]) and the repository's worktree-stable
/// identity ([`identity_worktree_root_dir`]) — and both share one base, which is what
/// lets [`is_adoptable_pr_resolve`] accept a resolve under either.
fn worktree_root_in(base: &Path, key: &str) -> std::path::PathBuf {
    base.join(repo_hash(key))
}

fn worktree_root_for_key(key: &str) -> AppResult<std::path::PathBuf> {
    Ok(worktree_root_in(&worktrees_base_dir()?, key))
}

/// The checkout-path-keyed worktree root, the same directory agent-session worktrees
/// mint in (`worktree.rs::worktree_root`). This module mints nothing here: it only
/// ADOPTS resolve worktrees earlier builds left, plus `update_marker`'s pre-rekey root.
pub(crate) fn worktree_root_dir(repo_path: &str) -> AppResult<std::path::PathBuf> {
    worktree_root_for_key(repo_path)
}

/// The worktree root every checkout of a repository SHARES, keyed on `identity`
/// ([`crate::git::repo::repo_identity`]'s output, the absolute common git dir) rather
/// than the checkout path. Local- and remote-PR resolves mint here, and `update_marker`
/// mints and guards here, so a sibling worktree resolves the same directory. Takes the
/// resolved identity RAW (never normalized: `repo_hash` keeps separators) so the
/// mapping stays callable without a repo on disk.
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

/// The main tree's branch, as the `current` that [`finalize_base`] and the clean-tree
/// gates compare `base` against: its NAME, or `"HEAD"` when detached (no branch is
/// ever named that). An unborn HEAD is refused before any merge work starts.
async fn current_branch_for_merge(repo_path: &str) -> AppResult<String> {
    let Some(name) = crate::git::branches::current_branch_name(repo_path).await? else {
        return Ok("HEAD".to_string());
    };
    if crate::git::branches::head_is_unborn(repo_path).await? {
        return Err(crate::git::branches::unborn_head_error());
    }
    Ok(name)
}

/// The `originalRef` a history rewrite journals: HEAD's branch NAME, which
/// `oplog::is_interrupted` compares against the branch HEAD is on later, or `"HEAD"`
/// when detached; `None` when the read fails. Callers have already seen a born HEAD.
async fn journal_original_ref(repo_path: &str) -> Option<String> {
    match crate::git::branches::current_branch_name(repo_path).await {
        Ok(Some(name)) => Some(name),
        Ok(None) => Some("HEAD".to_string()),
        Err(_) => None,
    }
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
    let _current_guard = if base == current {
        let domain = state.working_tree_lock(repo_path).await;
        Some(acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a merge").await?)
    } else {
        None
    };
    // The main checkout's hold spans the branch/pin reads through the fast-forward.
    if base == current
        && crate::git::branches::current_branch_name(repo_path)
            .await?
            .as_deref()
            != Some(base)
    {
        return Err(AppError::Command(moved()));
    }
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
        let paths = ignored_files_in_the_way(repo_path, new_sha, DEFAULT_TIMEOUT)
            .await
            .map_err(|e| ignored_guard::check_failed("Fast-forward", e))?;
        if !paths.is_empty() {
            return Err(ignored_guard::finalize_refusal(base, None, &paths));
        }
        let out = run_git_raw_index_retry(
            repo_path,
            &["merge", "--ff-only", "--no-overwrite-ignore", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.full_failure_text(),
            });
        }
        return Ok(());
    }

    use crate::git::update_marker::{self as marker, LockProbe};

    // Resolved once, up front: the `managed` predicate below sits in a closure that
    // cannot await, and both arms must read the same root set the refusal did.
    // Fail-open per `update_marker`'s contract — a root this process cannot resolve
    // must never block the merge, and the update's own pin verify is what keeps the
    // fast-forward data-safe without it.
    let marker_roots = marker::roots_for_cached(state, repo_path).await.ok();

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
        let domain = state.working_tree_lock(&worktree).await;
        let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a merge").await?;
        // The holder was discovered outside its lock, so verify its branch and tip again.
        if crate::git::branches::current_branch_name(&worktree)
            .await?
            .as_deref()
            != Some(base)
            || branch_tip(&worktree, base).await? != tip_now
        {
            return Err(AppError::Command(moved()));
        }
        let paths = ignored_files_in_the_way(&worktree, new_sha, DEFAULT_TIMEOUT)
            .await
            .map_err(|e| ignored_guard::check_failed("Fast-forward", e))?;
        if !paths.is_empty() {
            return Err(ignored_guard::finalize_refusal(
                base,
                Some(&worktree),
                &paths,
            ));
        }
        let out = run_git_raw_index_retry(
            &worktree,
            &["merge", "--ff-only", "--no-overwrite-ignore", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Err(AppError::Command(format!(
                "{base} is checked out at {worktree}; couldn't fast-forward it there \
                 (its working tree may be dirty, or its history has diverged). {base} is unchanged.\n{}",
                out.full_failure_text()
            )));
        }
        return Ok(());
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
    let identity = state.repo_identity_cached(&repo_path).await?;
    let root = identity_worktree_root_dir(&identity)?;
    merge_local_pr(&state, &repo_path, &base, &head, &message, &strategy, &root).await
}

/// Testable core of [`git_merge_local_pr`] — takes a plain `&AppState` and an
/// explicit worktree-root dir so real-repo tokio tests can drive it against a
/// temp dir (mirrors `rewrite_commits` / `replace_file_lines`). The command
/// resolves `root` to the repository's identity root.
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
    let current = current_branch_for_merge(repo_path).await?;
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
    // a commit; rebase cherry-picks the range. Conflicts leave unmerged paths. The
    // head is read as the branch the PR names, never a same-named tag.
    let head_rev = crate::git::branches::branch_first_rev(repo_path, head).await;
    let range = format!("{base_tip}..{head_rev}");
    let result: AppResult<()> = match strategy {
        "squash" => {
            match run_git_raw(
                Some(&worktree_path),
                &["merge", "--squash", &head_rev],
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
            &["merge", "--no-ff", "-m", &message, &head_rev],
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
    let current = current_branch_for_merge(repo_path).await?;
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
    let base = worktrees_base_dir()?;
    cleanup_orphaned_resolve_worktrees(&state, &repo_path, &keep_paths, &base).await
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
/// `&AppState` and an explicit worktrees base (see [`find_remote_pr_resolve`]).
pub(crate) async fn cleanup_orphaned_resolve_worktrees(
    state: &AppState,
    repo_path: &str,
    keep_paths: &[String],
    base: &Path,
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
    // has MERGE_HEAD, so all three survive even if the frontend forgot them. The
    // scope is every root shape (`is_adoptable_pr_resolve`) over THIS repository's
    // registry, so a resolve any checkout of it minted, legacy roots included, is
    // reclaimable from any other.
    // Accepted race: a worktree is briefly clean, contained and merge-free between
    // `worktree add` and the merge starting. The frontend re-arms this sweep on
    // every switch back to a repo, so switching to ANY checkout of the repository
    // while a `merge_remote_pr` is mid-flight can land in that window; the cost is
    // a failed automatic merge the user retries, never resolved work.
    for path in all.iter().filter(|p| is_adoptable_pr_resolve(base, p)) {
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

/// Whether `path` is `<base>/<16 hex>/<name>`: an entry DIRECTLY inside one of the
/// per-repository roots under the worktrees base, whichever key hashed that root
/// (identity or a checkout path, this checkout's or another's). Shape only — it does
/// not say WHICH repository; a caller acting on the path checks registry membership
/// under the same spelling (see [`classify_pr_resolve_path`]).
///
/// The two sides routinely arrive as DIFFERENT SPELLINGS of the same location — git's
/// porcelain prints macOS's canonical `/private/var/…` where the caller holds the
/// `/var/…` symlink, and a Windows runner's 8.3 short name where the caller holds the
/// long one — so each side is canonicalized (`canonical_wt_path`) before comparing.
/// The normalize-only spelling is a second chance for a path that no longer exists,
/// where `canonicalize` fails on one side only. The separator after `base` is
/// required: a bare prefix match would accept a SIBLING `<base>evil/…`.
fn is_in_a_worktree_root(base: &Path, path: &str) -> bool {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    let base_str = base.to_string_lossy();
    root_shaped(&canonical_wt_path(path), &canonical_wt_path(&base_str))
        || root_shaped(&normalize_wt_path(path), &normalize_wt_path(&base_str))
}

/// The root shape over ONE spelling: both sides already spelled the same way.
fn root_shaped(path: &str, base: &str) -> bool {
    path.strip_prefix(&format!("{base}/"))
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(hash, name)| {
            hash.len() == 16
                && hash.bytes().all(|b| b.is_ascii_hexdigit())
                && !name.is_empty()
                && !name.contains('/')
        })
}

/// Whether `path` is a remote-PR resolve this app minted under ANY root of `base`:
/// the `gd-pr-resolve-` basename plus the root shape. Identity-free on purpose, so
/// resolves from every checkout and from pre-identity (checkout-keyed) roots are all
/// adopted without a migration. Not a repository scope by itself.
fn is_adoptable_pr_resolve(base: &Path, path: &str) -> bool {
    is_pr_resolve_worktree_path(path) && is_in_a_worktree_root(base, path)
}

/// Whether `path` is one of the `worktree list --porcelain` paths, compared through
/// the same two spellings as [`is_in_a_worktree_root`].
fn is_listed_worktree(listed: &[String], path: &str) -> bool {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    let (canon, norm) = (canonical_wt_path(path), normalize_wt_path(path));
    listed
        .iter()
        .any(|p| canonical_wt_path(p) == canon || normalize_wt_path(p) == norm)
}

/// How an IPC-supplied resolve path stands against THIS repository's registry.
#[derive(Debug, PartialEq)]
enum PrResolvePath {
    /// Adoptable by name and root shape AND registered, under one spelling.
    Registered,
    /// Adoptable by shape but registered under no spelling: already removed, or
    /// another repository's.
    Unregistered,
    Refused,
}

/// Classifies `path` against `listed` (this repository's porcelain paths). ONE
/// spelling must satisfy both the name+shape gate and membership: gates evaluated
/// independently would let a junction planted in a root's shape pass shape under
/// its own spelling and membership under its target's — a registered worktree
/// elsewhere. A path registered under any spelling but never shaped is Refused.
fn classify_pr_resolve_path(base: &Path, listed: &[String], path: &str) -> PrResolvePath {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    let base_str = base.to_string_lossy();
    let spellings: [fn(&str) -> String; 2] = [canonical_wt_path, normalize_wt_path];
    let shaped = |spell: fn(&str) -> String| {
        let p = spell(path);
        is_pr_resolve_worktree_path(&p) && root_shaped(&p, &spell(&base_str))
    };
    let member = |spell: fn(&str) -> String| {
        let p = spell(path);
        listed.iter().any(|l| spell(l) == p)
    };
    if spellings.iter().any(|&s| shaped(s) && member(s)) {
        PrResolvePath::Registered
    } else if is_listed_worktree(listed, path) || !spellings.iter().any(|&s| shaped(s)) {
        PrResolvePath::Refused
    } else {
        PrResolvePath::Unregistered
    }
}

/// Classifies an IPC-supplied worktree path before `worktree remove --force` (or a
/// push of its HEAD) is aimed at it. The registry is the repository scope — the
/// shape alone would accept a crafted path under another repository's root — and an
/// unreadable registry is an error, never a verdict.
async fn check_pr_resolve_worktree(
    repo_path: &str,
    base: &Path,
    worktree_path: &str,
) -> AppResult<PrResolvePath> {
    if !is_adoptable_pr_resolve(base, worktree_path) {
        return Ok(PrResolvePath::Refused);
    }
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(classify_pr_resolve_path(
        base,
        &parse_worktree_paths(&listed.stdout_lossy()),
        worktree_path,
    ))
}

fn not_a_pr_resolve(worktree_path: &str) -> AppError {
    AppError::InvalidArgument(format!(
        "not a pull-request resolve worktree: {worktree_path}"
    ))
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
    let identity = state.repo_identity_cached(&repo_path).await?;
    let root = identity_worktree_root_dir(&identity)?;
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

/// The takeover outcome for a resolve worktree that already exists. Its conflict list
/// may be EMPTY — a fully-resolved-but-unpushed resolve, which the frontend's takeover
/// renders exactly as that state.
async fn resumed_resolve(existing: RemotePrResolveHandle) -> RemotePrResolveOutcome {
    let conflicts = unmerged_paths(&existing.worktree_path).await;
    RemotePrResolveOutcome {
        status: "conflicts".to_string(),
        conflicts,
        worktree_path: Some(existing.worktree_path),
        worktree_id: Some(existing.worktree_id),
        pushed_sha: None,
    }
}

/// Testable core of [`git_merge_remote_pr`] — takes a plain `&AppState` and an
/// explicit worktree-root dir so real-repo tokio tests can drive it against a
/// temp dir (mirrors [`merge_local_pr`]). `root` is `<base>/<16 hex>`: the mint goes
/// in it, and the resume search spans every root beside it (see
/// [`find_remote_pr_resolve`]).
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
    let worktrees_base = root.parent().ok_or_else(|| {
        AppError::InvalidArgument(format!("not a worktree root: {}", root.display()))
    })?;

    // Resume before starting: an existing worktree for this (remote, PR) holds
    // work the user may already have done, so hand it back instead of minting a
    // second one that would strand the first. Checked again under the mint's admin
    // hold below; this early pass spares a resume the network fetch.
    if let Some(existing) = find_remote_pr_resolve(repo_path, number, lens, worktrees_base).await? {
        return Ok(resumed_resolve(existing).await);
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
    // Find-then-add under ONE admin hold. Every checkout of the repository shares
    // the roots and, within this process, this lock, so of two starts racing for one
    // PR here the second sees the first's worktree and resumes it instead of minting
    // twice; the lock is in-process, so a second app instance is not excluded.
    // Plain `run_git` inside: the admin runner would re-acquire the held lock.
    let admin_domain = state.worktree_admin_lock(repo_path).await;
    let admin = acquire_repo_lock(&admin_domain, LOCK_WAIT_TIMEOUT, "a worktree operation").await?;
    if let Some(existing) = find_remote_pr_resolve(repo_path, number, lens, worktrees_base).await? {
        drop(admin);
        return Ok(resumed_resolve(existing).await);
    }
    run_git(
        Some(repo_path),
        &["worktree", "add", "--detach", &worktree_path, &head_tip],
        WORKTREE_OP_TIMEOUT,
    )
    .await?;
    drop(admin);

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
    let base = worktrees_base_dir()?;
    finish_remote_pr_resolve(
        &state,
        &repo_path,
        &head,
        &worktree_path,
        &worktree_id,
        message.as_deref(),
        lens.as_deref(),
        &base,
    )
    .await
}

/// Testable core of [`git_finish_remote_pr_resolve`] (see [`find_remote_pr_resolve`]
/// for `base`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn finish_remote_pr_resolve(
    state: &AppState,
    repo_path: &str,
    head: &str,
    worktree_path: &str,
    worktree_id: &str,
    message: Option<&str>,
    lens: Option<&str>,
    base: &Path,
) -> AppResult<RemotePrResolveOutcome> {
    crate::git::branches::validate_branch_name(head)?;
    let remote = resolve_pr_remote(repo_path, lens).await?;
    if check_pr_resolve_worktree(repo_path, base, worktree_path).await? != PrResolvePath::Registered
    {
        return Err(not_a_pr_resolve(worktree_path));
    }
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
    let base = worktrees_base_dir()?;
    abort_remote_pr_resolve(&state, &repo_path, &worktree_path, &base).await
}

/// Testable core of [`git_abort_remote_pr_resolve`] (see [`find_remote_pr_resolve`]
/// for `base`).
pub(crate) async fn abort_remote_pr_resolve(
    state: &AppState,
    repo_path: &str,
    worktree_path: &str,
    base: &Path,
) -> AppResult<()> {
    match check_pr_resolve_worktree(repo_path, base, worktree_path).await? {
        PrResolvePath::Registered => remove_resolve_worktree(state, repo_path, worktree_path).await,
        // Another checkout already finished or discarded it: nothing left to tear
        // down, and discarding a stale handle must clear rather than fail.
        PrResolvePath::Unregistered => {}
        PrResolvePath::Refused => return Err(not_a_pr_resolve(worktree_path)),
    }
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
    let base = worktrees_base_dir()?;
    find_remote_pr_resolve(&repo_path, number, lens.as_deref(), &base).await
}

/// Testable core of [`git_find_remote_pr_resolve`]. `base` is the worktrees base,
/// not one repository's root: candidates come from THIS repository's shared
/// worktree registry, so any root under `base` that holds one of them counts — the
/// identity root, a legacy checkout-keyed root, or another checkout's.
pub(crate) async fn find_remote_pr_resolve(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
    base: &Path,
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
            if !is_adoptable_pr_resolve(base, &p) {
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
    let base = crate::git::branches::branch_first_rev(&repo_path, &base).await;
    let head = crate::git::branches::branch_first_rev(&repo_path, &head).await;

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
/// message = **squash**; many hashes + no message = **fixup** (keeps the leader
/// commit's message); every step keeps its leader's authorship. A commit is dropped only when
/// listed in `dropped`; any other omission refuses. Steps plus `dropped` must cover
/// `base..HEAD` exactly once, so a commit that landed after the plan was made is
/// refused rather than lost.
/// Refuses on a dirty tree, a paused operation or merge commits in range. Runs as git's
/// own `rebase -i` over the generated todo, so it applies all at once: if any step
/// fails — a conflict, a squash that leaves nothing to commit, a timeout —
/// `rebase --abort` returns the branch to its pre-run tip. When the abort itself
/// fails, the returned error names that tip and the remedy.
#[tauri::command]
pub async fn git_rewrite_commits(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
    dropped: Option<Vec<String>>,
) -> AppResult<()> {
    rewrite_commits(
        &state,
        &repo_path,
        &base,
        &steps,
        dropped.as_deref().unwrap_or(&[]),
    )
    .await
}

pub(crate) async fn rewrite_commits(
    state: &AppState,
    repo_path: &str,
    base: &str,
    steps: &[RewriteStep],
    dropped: &[String],
) -> AppResult<()> {
    rewrite_commits_with_timeouts(
        state,
        repo_path,
        base,
        steps,
        dropped,
        replay_timeout(steps, dropped),
        DEFAULT_TIMEOUT,
    )
    .await
}

/// Both rewrite entry points' refusal when the plan no longer matches the branch and
/// nothing was changed: the coverage check, the rebase start's missing-commits stop
/// and its start-tip gate all use it.
const UNCOVERED_RANGE_REFUSAL: &str =
    "the branch changed after this plan was made, so nothing was rewritten — start over";

/// Refuses a rewrite plan that doesn't list every commit of `in_range` (the
/// `base..HEAD` set) exactly once across `steps` and `dropped`. Shared by both
/// rewrite entry points so the replay and the interactive rebase refuse alike.
fn check_plan_covers_range(
    in_range: &std::collections::HashSet<String>,
    steps: &[RewriteStep],
    dropped: &[String],
) -> AppResult<()> {
    let mut listed = std::collections::HashSet::new();
    for h in steps.iter().flat_map(|s| &s.hashes).chain(dropped) {
        // A listed commit outside the live range means the branch moved (an amend,
        // a reset) since the plan was read.
        if !in_range.contains(h) {
            return Err(AppError::InvalidArgument(UNCOVERED_RANGE_REFUSAL.into()));
        }
        if !listed.insert(h.as_str()) {
            return Err(AppError::InvalidArgument(format!(
                "{h} is listed more than once in the rewrite plan"
            )));
        }
    }
    if in_range.iter().any(|h| !listed.contains(h.as_str())) {
        return Err(AppError::InvalidArgument(UNCOVERED_RANGE_REFUSAL.into()));
    }
    Ok(())
}

/// [`rewrite_commits`] with the git timeouts injectable. `rebase_timeout` bounds ONLY
/// the `rebase --continue` that replays the plan; `abort_timeout` only the failure
/// path's `rebase --abort` (and the start's abort of a missing-commits stop). Every
/// other git call keeps `DEFAULT_TIMEOUT`, so a zero value exercises one failure arm
/// at a time instead of failing before the rebase starts.
pub(crate) async fn rewrite_commits_with_timeouts(
    state: &AppState,
    repo_path: &str,
    base: &str,
    steps: &[RewriteStep],
    dropped: &[String],
    rebase_timeout: std::time::Duration,
    abort_timeout: std::time::Duration,
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
    for h in dropped {
        validate_hash(h)?;
    }

    // One hold across read → rebase → rollback covers this process's in-app ops; the MCP
    // server's separate AppState lock and the lock-free edit path are outside it, and
    // the start-tip gate catches what the hold misses. A poll can briefly show a paused
    // rebase's banner (the `break` pause). Commits another git process makes WHILE the
    // rebase runs are unsupported, as in any `git rebase`: a rollback may drop them (the
    // reflog keeps them). Lock-free runners only while held (see `run_git_mutating`).
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a history rewrite").await?;

    // Before the scratch-dir clear below: a paused op's rebase would lose the message
    // files its pending `exec` lines read.
    if op_in_progress(repo_path).await {
        return Err(AppError::InvalidArgument(MID_OP_REFUSAL.into()));
    }
    // git rebase refuses a dirty tree too, but a clear message here is nicer.
    let status = run_git(Some(repo_path), &["status", "--porcelain"], DEFAULT_TIMEOUT).await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }

    // HEAD is read once (the range, the coverage check, the journal anchor and the
    // start-tip gate all use it), and the branch the rebase must start on is read in
    // this same entry; the journal makes its own best-effort ref read.
    let orig = run_git(
        Some(repo_path),
        &["rev-parse", "--verify", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let head_name = read_head_name(repo_path).await?;
    // Every post-start probe reads the filesystem under the repo's OWN git dir, so
    // no failed git spawn can decide "nothing in progress".
    let git_dir = absolute_git_dir(repo_path)
        .await
        .ok_or_else(|| AppError::InvalidArgument("couldn't resolve the git dir".into()))?;
    let range = format!("{base}..{orig}");
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
    // The plan must cover `orig`'s range; a tip that moves after this read is caught
    // at the rebase start (`start_planned_rebase`).
    check_plan_covers_range(&in_range, steps, dropped)?;

    // Journal a pending entry AFTER the guards + `orig` capture, BEFORE the first
    // mutation (the rebase). Best-effort: a journal failure returns None and
    // the op proceeds unchanged. Runs under the lock (app-data I/O, not git) because
    // the `orig` anchor it records is only valid while this hold is unbroken.
    let original_ref = journal_original_ref(repo_path).await;
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

    let expected = PlanStart {
        tip: orig.clone(),
        head_name,
    };
    let op_result: AppResult<()> = async {
        let (_, todo_path) = write_rebase_todo(&git_dir, TodoRoute::Replay, steps, dropped).await?;
        let envs = rebase_editor_env(&todo_path);
        let envs: Vec<(&str, &str)> = envs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        start_planned_rebase(
            repo_path,
            &git_dir,
            base,
            &expected,
            &envs,
            DEFAULT_TIMEOUT,
            abort_timeout,
        )
        .await?;

        // Lock-free raw runner: this runs inside the compound's own working-tree hold.
        // A stop splits git's report across both streams (a conflicted pick's
        // `could not apply` on stderr, its `CONFLICT (…` list on stdout; the empty
        // amend on stderr), so every message below carries the full failure text.
        let resumed = run_git_raw_env(
            Some(repo_path),
            &REBASE_CONTINUE_ARGS,
            &CONTINUE_EDITOR_ENV,
            rebase_timeout,
        )
        .await;
        let rebasing = rebase_in_progress(&git_dir);
        let failure = match resumed {
            Ok(out) if out.code == 0 && !rebasing => return Ok(()),
            Ok(out) if rebasing => RebaseFailure::Git(out),
            Err(e) if rebasing => RebaseFailure::Other(e),
            // Nothing in progress after a failed continue: the kill landed after git
            // finished, so what happened is read off the branch.
            Ok(_) | Err(_) => return classify_finished_rebase(repo_path, &expected).await,
        };
        match abort_planned_rebase(repo_path, &git_dir, abort_timeout).await {
            Ok(()) => Err(rolled_back_error(failure)),
            Err(report) => Err(failed_abort_error(
                &git_dir,
                &expected,
                &report,
                Some(failure),
            )),
        }
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
/// non-interactive `exec … commit --amend -F`) and swaps it in through
/// `GIT_SEQUENCE_EDITOR`, so no editor ever opens. Stopping at an `edit` (or at a
/// conflict before one) leaves the rebase in progress for the banner to take over —
/// a normal outcome, not an error. Steps plus `dropped` must cover `base..HEAD`
/// exactly once; anything else refuses, since the generated todo replaces git's.
#[tauri::command]
pub async fn git_rebase_edit(
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
    dropped: Option<Vec<String>>,
) -> AppResult<()> {
    git_rebase_edit_with_timeout(repo_path, base, steps, dropped, DEFAULT_TIMEOUT).await
}

/// [`git_rebase_edit`] with the timeout of the `rebase --continue` that runs the plan
/// after the start-tip gate injectable; every other git call keeps `DEFAULT_TIMEOUT`.
pub(crate) async fn git_rebase_edit_with_timeout(
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
    dropped: Option<Vec<String>>,
    continue_timeout: std::time::Duration,
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
    let dropped = dropped.unwrap_or_default();
    for h in &dropped {
        validate_hash(h)?;
    }
    // Refuse while a sequencer op is mid-flight, BEFORE the scratch-dir clear below:
    // it would delete that rebase's pending message files, and its `exec … -F msg`
    // lines would fail on --continue. [`op_state`]'s detection is the one marker set.
    if op_in_progress(&repo_path).await {
        return Err(AppError::InvalidArgument(MID_OP_REFUSAL.into()));
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
    // HEAD is read once (the range, the coverage check, the journal anchor and the
    // start-tip gate all use it), and the branch the rebase must start on is read in
    // this same entry; the journal makes its own best-effort ref read.
    let original_sha = run_git(
        Some(&repo_path),
        &["rev-parse", "--verify", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let head_name = read_head_name(&repo_path).await?;
    // Every post-start probe reads the filesystem under the repo's OWN git dir, so
    // no failed git spawn can decide "nothing in progress".
    let git_dir = absolute_git_dir(&repo_path)
        .await
        .ok_or_else(|| AppError::InvalidArgument("couldn't resolve the git dir".into()))?;
    let range = format!("{base}..{original_sha}");
    let in_range: std::collections::HashSet<String> =
        run_git(Some(&repo_path), &["rev-list", &range], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .lines()
            .map(str::to_string)
            .collect();
    check_plan_covers_range(&in_range, &steps, &dropped)?;

    // Journal a pending entry AFTER the guards, BEFORE the first side effect
    // (scratch-dir setup / the rebase itself). Best-effort: a journal failure
    // returns None and the op proceeds unchanged. A paused rebase returns Ok, so
    // `finish` marks it "done" (git tracks the paused state); only a real Err is
    // "failed". `git_oplog_check` sees `rebasing` true only if the PROCESS died.
    let original_ref = journal_original_ref(&repo_path).await;
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

    let expected = PlanStart {
        tip: original_sha.clone(),
        head_name,
    };
    let op_result: AppResult<()> = async {
        let (dir, todo_path) =
            write_rebase_todo(&git_dir, TodoRoute::Edit, &steps, &dropped).await?;
        let envs = rebase_editor_env(&todo_path);
        let envs: Vec<(&str, &str)> = envs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let started = start_planned_rebase(
            &repo_path,
            &git_dir,
            &base,
            &expected,
            &envs,
            DEFAULT_TIMEOUT,
            DEFAULT_TIMEOUT,
        )
        .await;
        if let Err(AppError::InvalidArgument(msg)) = &started {
            // A refused start leaves no rebase to read these message files.
            if msg == UNCOVERED_RANGE_REFUSAL {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
        started?;

        let resumed = run_git_raw_env(
            Some(&repo_path),
            &REBASE_CONTINUE_ARGS,
            &CONTINUE_EDITOR_ENV,
            continue_timeout,
        )
        .await;
        let rebasing = rebase_in_progress(&git_dir);
        // Every stop with the rebase alive is left in progress on purpose: the user's
        // edit intent stands and the banner owns the rebase.
        let failure = match resumed {
            Err(e @ AppError::Timeout(_)) if rebasing => {
                return Err(AppError::Command(format!("{L_EDITTIMEOUT}\n{e}")));
            }
            Ok(out) if rebasing => RebaseFailure::Git(out),
            Err(e) if rebasing => RebaseFailure::Other(e),
            Ok(out) if out.code == 0 => return Ok(()),
            Ok(_) | Err(_) => return classify_finished_rebase(&repo_path, &expected).await,
        };
        // An `edit` stop or a conflict is the hand-off to the banner, not a failure;
        // any other stop never reached the plan's edit.
        if rebase_stopped_for_edit(&git_dir) || has_unmerged_paths(&repo_path).await {
            return Ok(());
        }
        Err(live_rebase_error(L_EDITINTERRUPTED, "", failure))
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

/// Both entry points' refusal while a merge, rebase, cherry-pick or revert is paused.
const MID_OP_REFUSAL: &str = "Can't edit history while a merge, rebase, cherry-pick or revert is in progress — finish or abort it from the banner first.";

// Each rewrite message's FIRST line (git's output only below it); the frontend reads
// the rollback verdicts off it (error-summary.ts ROLLBACK_VERDICTS).
const L_ROLLEDBACK: &str =
    "The rewrite couldn't be applied and was rolled back — your branch is unchanged.";
const L_ABORTFAILED: &str = "The rewrite failed and its automatic rollback also failed.";
const L_START: &str = "Couldn't start the rebase.";
const L_NOREWRITE: &str = "The rewrite plan was not applied, so nothing was rewritten as planned.";
const L_UNVERIFIED: &str =
    "The rewrite was rolled back — couldn't verify the state it started from.";
const L_UNCONFIRMED: &str = "The rewrite's outcome couldn't be confirmed.";
const L_EDITTIMEOUT: &str =
    "The rebase timed out and was left in progress — continue or abort it from the banner.";
const L_EDITINTERRUPTED: &str =
    "The rebase was interrupted and left in progress — continue or abort it from the banner.";

/// What git writes into `rebase-merge/head-name` when the rebase started detached.
const DETACHED_HEAD_NAME: &str = "detached HEAD";

/// git's refusal to start while another rebase's state exists (exit 128, no state
/// written).
const REBASE_DIR_EXISTS: &str = "It seems that there is already a rebase-merge directory";

/// The one rebase start both paths run. Flags are all in git 2.21 (the floor `break`
/// and `--no-reschedule-failed-exec` set); knobs newer than that ride `-c`, which an
/// older git ignores instead of refusing. `--no-autosquash` and `--no-rebase-merges`
/// keep git's own fallback todo a plain pick list, which the missing-commits check
/// compares ours against; `--no-verify` skips the pre-rebase hook. post-checkout fires
/// at the start; post-rewrite fires at the finish (the replay's scripts map its squash
/// groups and rewords) and, on the edit path, after each reword's amend too.
const REBASE_START_ARGS: [&str; 22] = [
    "-c",
    "core.editor=true",
    "-c",
    "rebase.missingCommitsCheck=error",
    "-c",
    "rebase.instructionFormat=%s",
    "-c",
    "rebase.abbreviateCommands=false",
    "-c",
    "rebase.updateRefs=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "rebase",
    "-i",
    "--no-autosquash",
    "--no-autostash",
    "--no-fork-point",
    "--no-rebase-merges",
    "--no-reschedule-failed-exec",
    "--no-verify",
];

/// git refuses `--[no-]reschedule-failed-exec` on `--continue`; the config pins it.
const REBASE_CONTINUE_ARGS: [&str; 10] = [
    "-c",
    "core.editor=true",
    "-c",
    "rebase.rescheduleFailedExec=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "rebase",
    "--continue",
];

/// Which entry point a todo is built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TodoRoute {
    /// The atomic replay: no `edit` stops. A fold group runs as one generated script
    /// that commits once (an intermediate fold can net empty, a leader's change can
    /// already be present, and an inline exec line is length-limited). Only those
    /// commits and a reword's amend run the commit hooks (pre-commit, commit-msg); a
    /// plain pick runs none.
    Replay,
    /// The resumable rebase: `edit` stops, native `fixup` folds, and amends skip the
    /// commit hooks.
    Edit,
}

/// The tip and branch an entry point read, which the rebase's own start record must
/// match before any pick runs.
#[derive(Debug)]
struct PlanStart {
    tip: String,
    /// The full ref HEAD was on (`refs/heads/<b>`), or [`DETACHED_HEAD_NAME`].
    head_name: String,
}

/// A rebase step that failed: git's own report, or a runner error (a timeout, a spawn
/// failure).
enum RebaseFailure {
    Git(crate::git::runner::GitOutput),
    Other(AppError),
}

/// Single-quotes `s` for the shell git runs editor and `exec` values through.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A path as the shell git runs `exec` and editor values through reads it: Windows
/// separators become `/`, which git's sh accepts there; elsewhere `\` is a legal
/// filename byte and must pass through untouched.
fn shell_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if cfg!(windows) {
        path.replace('\\', "/")
    } else {
        path.into_owned()
    }
}

/// The ref HEAD is on, or [`DETACHED_HEAD_NAME`] when it is detached. Any other
/// answer is an error, so the rebase never starts on an unknown branch.
async fn read_head_name(repo: &str) -> AppResult<String> {
    let out = run_git_raw(Some(repo), &["symbolic-ref", "-q", "HEAD"], DEFAULT_TIMEOUT).await?;
    let name = out.stdout_lossy().trim().to_string();
    match (out.code, name.is_empty()) {
        (0, _) => Ok(name),
        (1, true) => Ok(DETACHED_HEAD_NAME.into()),
        _ => out.exit_verdict().map(|_| name),
    }
}

/// The rebase todo for `steps` and `dropped`, and the files its `exec` lines read
/// (path, content) under `dir`: message files and the replay's scripts. It opens with
/// `break`, so the rebase pauses on `base` before any pick and the start-tip gate can
/// run; drops are explicit lines, since `missingCommitsCheck=error` refuses a bare
/// omission.
///
/// On the replay route a fold group drops every one of its commits and runs ONE
/// generated script ([`group_script`]) instead of picking its leader: a picked leader
/// whose change is already present stops as an empty pick, and an inline exec chain
/// is cut by git's `sh -c` at ~8 KiB (87+ folds, measured on Windows). A replay
/// reword amends through its own script too ([`reword_script`]).
fn rebase_todo(
    route: TodoRoute,
    steps: &[RewriteStep],
    dropped: &[String],
    dir: &Path,
    git_path: &str,
) -> (String, Vec<(std::path::PathBuf, String)>) {
    // The app's resolved git, not whatever `git` the sequencer's PATH holds.
    let git = sh_quote(git_path);
    let mut todo = String::from("break\n");
    let mut files = Vec::new();
    for h in dropped {
        todo.push_str(&format!("drop {h}\n"));
    }
    for (i, step) in steps.iter().enumerate() {
        let leader = &step.hashes[0];
        let folds = &step.hashes[1..];
        let message = step.message.as_deref().map(str::trim).unwrap_or("");
        let message_file = if message.is_empty() {
            None
        } else {
            let path = dir.join(format!("msg-{i}"));
            let quoted = sh_quote(&shell_path(&path));
            files.push((path, message.to_string()));
            Some(quoted)
        };
        match route {
            TodoRoute::Replay if !folds.is_empty() => {
                for h in &step.hashes {
                    todo.push_str(&format!("drop {h}\n"));
                }
                let script = dir.join(format!("group-{i}.sh"));
                let body = group_script(&git, leader, folds, message_file.as_deref());
                todo.push_str(&format!("exec sh {}\n", sh_quote(&shell_path(&script))));
                files.push((script, body));
            }
            TodoRoute::Replay => {
                todo.push_str(&format!("pick {leader}\n"));
                if let Some(file) = message_file {
                    let script = dir.join(format!("reword-{i}.sh"));
                    todo.push_str(&format!("exec sh {}\n", sh_quote(&shell_path(&script))));
                    files.push((script, reword_script(&git, &file)));
                }
            }
            TodoRoute::Edit => {
                let command = if step.edit { "edit" } else { "pick" };
                todo.push_str(&format!("{command} {leader}\n"));
                for fold in folds {
                    todo.push_str(&format!("fixup {fold}\n"));
                }
                // The edit path's message is already composed: a hook must not stall
                // a rebase the user resumes from the banner.
                if let Some(file) = message_file {
                    todo.push_str(&format!(
                        "exec {git} commit --amend --no-verify -F {file}\n"
                    ));
                }
            }
        }
    }
    (todo, files)
}

/// What a replay fold group's script reports when its commits add up to nothing.
const EMPTY_GROUP_ERROR: &str =
    "error: the squashed commits add up to no change, so the group would be empty";

/// The sh script a replay fold group runs (LF only): it stages the leader and every
/// fold (`cherry-pick -n`), refuses an empty net, and commits once with the leader's
/// author and author date, its message (`-C`) or the group's own (`-F`). The commit
/// runs the commit hooks once, with the whole group staged.
///
/// - The empty-net check passes `--ignore-submodules=none`: `.gitmodules` `ignore=all`
///   would otherwise hide a gitlink-only group, and a `-c` override doesn't outrank it.
/// - The author captures pass `--no-show-signature` (`log.showSignature` would splice
///   gpg output into them) and take the date in git's own `@<seconds> <tz>` form,
///   which round-trips every date (ISO 8601 breaks from 2100 on, and a plain raw
///   date before 1973). Each is its own assignment: `set -e` can't see a failure
///   inside a command's prefix assignment.
/// - Each member's old → new line goes to the sequencer's rewritten-list, which git
///   reads at the finish for notes rewriting and post-rewrite; dropped members are
///   otherwise missing from it.
fn group_script(git: &str, leader: &str, folds: &[String], message_file: Option<&str>) -> String {
    let members = || std::iter::once(leader).chain(folds.iter().map(String::as_str));
    let mut script = String::from("set -e\n");
    for h in members() {
        script.push_str(&format!("{git} cherry-pick -n {h}\n"));
    }
    script.push_str(&format!(
        "if {git} diff --cached --quiet --ignore-submodules=none; then echo '{EMPTY_GROUP_ERROR}' >&2; exit 1; fi\n"
    ));
    match message_file {
        None => script.push_str(&format!("{git} commit -C {leader}\n")),
        Some(file) => script.push_str(&format!(
            "n=$({git} log -1 --no-show-signature --format=%an {leader})\n\
             e=$({git} log -1 --no-show-signature --format=%ae {leader})\n\
             d=$({git} log -1 --no-show-signature --date=raw --format=@%ad {leader})\n\
             GIT_AUTHOR_NAME=\"$n\" GIT_AUTHOR_EMAIL=\"$e\" GIT_AUTHOR_DATE=\"$d\" \
             {git} commit -F {file}\n"
        )),
    }
    script.push_str(&format!("new=$({git} rev-parse HEAD)\n"));
    script.push_str(&format!(
        "list=$({git} rev-parse --git-path rebase-merge/rewritten-list)\n"
    ));
    for h in members() {
        script.push_str(&format!(
            "printf '%s %s\\n' \"$({git} rev-parse {h})\" \"$new\" >> \"$list\"\n"
        ));
    }
    script
}

/// The sh script a replay reword runs (LF only) after its pick: it amends with the new
/// message, then points the pick's rewritten-list line at the amended commit. git
/// records that line before the exec, so it would otherwise send the pick's notes and
/// post-rewrite to the orphaned pre-amend commit; `--no-post-rewrite` leaves the
/// finish's mapping as the only one. The commit hooks still run. A temp file and `mv`
/// stand in for `sed -i`, whose syntax differs between GNU and BSD sed.
fn reword_script(git: &str, message_file: &str) -> String {
    format!(
        "set -e\n\
         pre=$({git} rev-parse HEAD)\n\
         {git} commit --amend --no-post-rewrite -F {message_file}\n\
         new=$({git} rev-parse HEAD)\n\
         list=$({git} rev-parse --git-path rebase-merge/rewritten-list)\n\
         if [ -f \"$list\" ]; then sed \"s/ $pre\\$/ $new/\" \"$list\" > \"$list.gd-tmp\" \
         && mv \"$list.gd-tmp\" \"$list\"; fi\n"
    )
}

/// The replay's `rebase --continue` budget: one bound for the whole plan, which that
/// one process runs. Each `pick`/`drop` line (one per hash) gets 2 s; each exec line
/// gets a full per-command budget, since it runs a commit plus the user's own commit
/// hooks. Counted as [`rebase_todo`] writes the replay route.
fn replay_timeout(steps: &[RewriteStep], dropped: &[String]) -> std::time::Duration {
    let execs = steps
        .iter()
        .filter(|s| {
            !s.message.as_deref().map(str::trim).unwrap_or("").is_empty() || s.hashes.len() > 1
        })
        .count() as u32;
    let lines = dropped.len() + steps.iter().map(|s| s.hashes.len()).sum::<usize>();
    DEFAULT_TIMEOUT + std::time::Duration::from_secs(2 * lines as u64) + DEFAULT_TIMEOUT * execs
}

/// The editor pins for the rebase START. The env vars outrank any
/// `-c sequence.editor`/`core.editor`, so user config can't displace our todo.
fn rebase_editor_env(todo_path: &str) -> [(&'static str, String); 2] {
    [
        ("GIT_SEQUENCE_EDITOR", format!("cp {}", sh_quote(todo_path))),
        ("GIT_EDITOR", "true".to_string()),
    ]
}

/// The editor pins for the CONTINUE, which never launches the sequence editor: a
/// no-op one, so an exec line or hook that starts its own interactive rebase can't
/// pick up the plan's todo.
const CONTINUE_EDITOR_ENV: [(&str, &str); 2] =
    [("GIT_SEQUENCE_EDITOR", "true"), ("GIT_EDITOR", "true")];

/// Writes the route's todo and the files its exec lines read into the
/// `gd-rebase-edit` scratch dir under `git_dir` and returns the dir and the todo's
/// shell path. Those files must outlive a paused rebase the user continues from the
/// banner, so stale ones are cleared up front.
async fn write_rebase_todo(
    git_dir: &Path,
    route: TodoRoute,
    steps: &[RewriteStep],
    dropped: &[String],
) -> AppResult<(std::path::PathBuf, String)> {
    let dir = git_dir.join("gd-rebase-edit");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::InvalidArgument(format!("couldn't create scratch dir: {e}")))?;
    let git_path = shell_path(&crate::git::runner::git_bin().await?);
    let (todo, files) = rebase_todo(route, steps, dropped, &dir, &git_path);
    for (path, content) in files {
        std::fs::write(&path, content).map_err(|e| {
            AppError::InvalidArgument(format!("couldn't write {}: {e}", path.display()))
        })?;
    }
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, &todo)
        .map_err(|e| AppError::InvalidArgument(format!("couldn't write todo: {e}")))?;
    let todo_shell = shell_path(&todo_path);
    Ok((dir, todo_shell))
}

/// Whether a rebase is in progress, read off the filesystem under the repo's own git
/// dir. Any error but "not found" counts as in progress: a failed probe never reads
/// as "nothing in flight".
fn rebase_in_progress(git_dir: &Path) -> bool {
    ["rebase-merge", "rebase-apply"].iter().any(|name| {
        match std::fs::symlink_metadata(git_dir.join(name)) {
            Ok(_) => true,
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        }
    })
}

/// Whether the index holds unmerged paths (a conflicted stop). A failed probe reads
/// as none.
async fn has_unmerged_paths(repo: &str) -> bool {
    run_git(Some(repo), &["ls-files", "-u"], DEFAULT_TIMEOUT)
        .await
        .is_ok_and(|out| !out.stdout_lossy().trim().is_empty())
}

/// Aborts the rebase this rewrite started. `Err` carries why it didn't take: the
/// failed abort's own report, or a note that a rebase is still in progress after it.
async fn abort_planned_rebase(
    repo: &str,
    git_dir: &Path,
    timeout: std::time::Duration,
) -> Result<(), String> {
    let aborted = run_git_raw(
        Some(repo),
        &[
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "rebase",
            "--abort",
        ],
        timeout,
    )
    .await;
    match aborted {
        Err(e) => Err(e.to_string()),
        Ok(out) if out.code != 0 => Err(out.full_failure_text()),
        Ok(_) if rebase_in_progress(git_dir) => {
            Err("git rebase --abort exited cleanly but left a rebase in progress.".into())
        }
        Ok(_) => Ok(()),
    }
}

/// The rebase's own start record: the tip it started from and the ref it started on.
/// Never the shared `ORIG_HEAD`, which other ops overwrite.
struct StartRecord {
    orig_head: String,
    head_name: String,
}

impl StartRecord {
    fn matches(&self, expected: &PlanStart) -> bool {
        self.orig_head == expected.tip && self.head_name == expected.head_name
    }
}

/// The start record under `git_dir`; `None` when either file is unreadable.
fn read_start_record(git_dir: &Path) -> Option<StartRecord> {
    let read = |name: &str| {
        std::fs::read_to_string(git_dir.join("rebase-merge").join(name))
            .ok()
            .map(|s| s.trim().to_string())
    };
    Some(StartRecord {
        orig_head: read("orig-head")?,
        head_name: read("head-name")?,
    })
}

/// `lead` (one of the `L_*` first lines) with `body` lines below it and the failure's
/// own report last — git's whole output, both streams, for a git failure.
fn rebase_failure_error(lead: &str, body: &str, failure: RebaseFailure) -> AppError {
    shaped_failure_error(lead, body, failure, str::to_string)
}

/// [`rebase_failure_error`] for a rebase left in progress: git's report loses only its
/// progress counters, since its hints and advice stay true while the rebase is alive.
fn live_rebase_error(lead: &str, body: &str, failure: RebaseFailure) -> AppError {
    shaped_failure_error(lead, body, failure, strip_rebase_progress)
}

/// The rollback's error. git's report rides below the verdict without what the
/// rollback made untrue (see [`strip_rebase_noise`]).
fn rolled_back_error(failure: RebaseFailure) -> AppError {
    shaped_failure_error(L_ROLLEDBACK, "", failure, strip_rebase_noise)
}

/// `lead` and `body` over the failure, with a git report passed through `shape`.
fn shaped_failure_error(
    lead: &str,
    body: &str,
    failure: RebaseFailure,
    shape: fn(&str) -> String,
) -> AppError {
    let lead = if body.is_empty() {
        lead.to_string()
    } else {
        format!("{lead}\n{body}")
    };
    match failure {
        RebaseFailure::Git(out) => AppError::Git {
            code: out.code,
            stderr: format!("{lead}\n{}", shape(&out.full_failure_text()))
                .trim_end()
                .to_string(),
        },
        RebaseFailure::Other(e) => AppError::Command(format!("{lead}\n{e}")),
    }
}

/// `report` without git's `Rebasing (n/m)` progress segments, which git joins to the
/// next line with `\r`. Everything else stays, blank lines included.
fn strip_rebase_progress(report: &str) -> String {
    report_segments(report)
        .filter(|segment| !is_rebase_progress(segment))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `report`'s lines and `\r`-joined segments, each without the erase-line escape
/// (`ESC[K`) git puts in front of a segment when TERM is set.
fn report_segments(report: &str) -> impl Iterator<Item = &str> {
    report
        .split('\n')
        .flat_map(|line| line.split('\r'))
        .map(|segment| segment.strip_prefix("\x1b[K").unwrap_or(segment))
}

/// A rolled-back `report` without what the rollback made untrue: git's progress
/// counters, blank segments, the `Executing:` echo (its "execution failed" line
/// stays), the exec's dirty-tree errors, a commit's success summary, the status
/// block from "interactive rebase in progress;" to its first non-status line, and
/// git's advice on continuing (`hint:` lines, `git rebase --continue|--skip|--abort|
/// --edit-todo`, `git reset HEAD^`, `--allow-empty`). Other reason lines (error:,
/// fatal:, warning:, CONFLICT, could not apply) always stay. The C locale is forced,
/// so the English text is stable.
fn strip_rebase_noise(report: &str) -> String {
    let mut in_status = false;
    report_segments(report)
        .filter(|segment| {
            if segment
                .trim()
                .starts_with("interactive rebase in progress;")
            {
                in_status = true;
            } else if in_status && !is_status_line(segment) {
                in_status = false;
            }
            !in_status
        })
        .filter_map(strip_advice)
        .collect::<Vec<_>>()
        .join("\n")
}

/// A line of git's status block (wt-status): blank, one of its headings and
/// summaries, or one of its own indented lines (a tab-indented path, a parenthesized
/// hint, a todo line). Any other indented line, such as a hook's own reason, ends the
/// block.
fn is_status_line(segment: &str) -> bool {
    const TODO_VERBS: [&str; 12] = [
        "pick",
        "drop",
        "exec",
        "fixup",
        "squash",
        "edit",
        "reword",
        "break",
        "label",
        "reset",
        "merge",
        "update-ref",
    ];
    const STATUS: [&str; 17] = [
        "Last command done",
        "Last commands done",
        "Next command to do",
        "Next commands to do",
        "No commands remaining.",
        "You are currently ",
        "Changes to be committed:",
        "Changes not staged for commit:",
        "Untracked files:",
        "Unmerged paths:",
        "No changes",
        "nothing to commit",
        "nothing added to commit",
        "no changes added to commit",
        "Untracked files not listed",
        "Ignored files:",
        "interactive rebase in progress;",
    ];
    let trimmed = segment.trim();
    let spaces = segment.len() - segment.trim_start_matches(' ').len();
    let todo_line = spaces >= 3
        && trimmed
            .split_whitespace()
            .next()
            .is_some_and(|verb| TODO_VERBS.contains(&verb));
    trimmed.is_empty()
        || segment.starts_with('\t')
        || (segment.starts_with(' ') && trimmed.starts_with('('))
        || todo_line
        || STATUS.iter().any(|s| segment.starts_with(s))
}

/// A line stating why git stopped, kept whatever advice it quotes.
fn is_reason_line(trimmed: &str) -> bool {
    const REASON_PREFIXES: [&str; 4] = ["error:", "fatal:", "warning:", "CONFLICT"];
    REASON_PREFIXES.iter().any(|p| trimmed.starts_with(p)) || trimmed.contains("could not apply")
}

/// A line of git's own report that a rollback makes untrue even though it reads like a
/// reason: the exec's echo, its dirty-tree errors and their continuations (a
/// `<path>: needs merge` included), and a commit's success summary (an exec can
/// commit before a later step fails).
fn is_stale_after_rollback(segment: &str) -> bool {
    const DIRTY_TREE: [&str; 4] = [
        "error: cannot rebase:",
        "error: additionally, your index contains uncommitted changes.",
        "and made changes to the index and/or the working tree",
        "but left changes to the index and/or the working tree",
    ];
    const SUMMARY: [&str; 7] = [
        "Author: ",
        "Date: ",
        "create mode ",
        "delete mode ",
        "rename ",
        "mode change ",
        "copy ",
    ];
    let trimmed = segment.trim();
    if segment.starts_with("Executing: ")
        || segment.starts_with("[detached HEAD ")
        || DIRTY_TREE.iter().any(|d| trimmed.starts_with(d))
        || (!segment.starts_with([' ', '\t']) && trimmed.ends_with(": needs merge"))
    {
        return true;
    }
    if !segment.starts_with(' ') {
        return false;
    }
    let mut words = trimmed.split_whitespace();
    let files_changed = matches!(
        (words.next(), words.next(), words.next()),
        (Some(n), Some("file" | "files"), Some(changed))
            if n.bytes().all(|b| b.is_ascii_digit()) && changed.starts_with("changed")
    );
    files_changed || SUMMARY.iter().any(|s| trimmed.starts_with(s))
}

/// One report segment with git's continue advice removed, or `None` to drop it.
fn strip_advice(segment: &str) -> Option<&str> {
    const ADVICE: [&str; 7] = [
        "git rebase --continue",
        "git rebase --skip",
        "git rebase --abort",
        "git rebase --edit-todo",
        "git reset HEAD^",
        "You can fix the problem, and then run",
        "Commit or stash your changes, and then run",
    ];
    // git's empty-amend message ends its reason line with this advice sentence.
    const ALLOW_EMPTY: &str = "You can repeat your command with --allow-empty";
    let trimmed = segment.trim();
    if trimmed.is_empty() || is_rebase_progress(trimmed) || is_stale_after_rollback(segment) {
        return None;
    }
    if is_reason_line(trimmed) {
        return Some(segment);
    }
    if trimmed.starts_with("hint:") || ADVICE.iter().any(|a| trimmed.contains(a)) {
        return None;
    }
    match segment.find(ALLOW_EMPTY) {
        Some(at) => Some(segment[..at].trim_end()).filter(|kept| !kept.trim().is_empty()),
        None => Some(segment),
    }
}

fn is_rebase_progress(segment: &str) -> bool {
    let Some(inner) = segment
        .trim()
        .strip_prefix("Rebasing (")
        .and_then(|rest| rest.strip_suffix(')'))
    else {
        return false;
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    matches!(inner.split_once('/'), Some((n, m)) if digits(n) && digits(m))
}

/// A failed abort: the branch ref stays at `orig` (git moves it only when the rebase
/// finishes), so the remedy is the abort itself, never a reset. `orig` is what the
/// abort restores: the rebase's recorded start tip. The abort's own report says what
/// blocked it, ahead of the original failure's.
fn abort_failed_error(orig: &str, abort_report: &str, failure: Option<RebaseFailure>) -> AppError {
    let body = format!(
        "Your branch is left mid-rebase; its tip before this run was {orig}.\nFix what git reports below, then run git rebase --abort to restore it.\n{abort_report}"
    );
    match failure {
        Some(failure) => live_rebase_error(L_ABORTFAILED, body.trim_end(), failure),
        None => AppError::Command(format!("{L_ABORTFAILED}\n{}", body.trim_end())),
    }
}

/// A failed abort with the start record unreadable. git can't abort without it, but
/// `--quit` drops the state and a checkout reattaches the branch, whose ref the
/// rebase never moved (measured, git 2.51.1).
fn unreadable_record_error(
    expected: &PlanStart,
    abort_report: &str,
    failure: Option<RebaseFailure>,
) -> AppError {
    let target = match expected.head_name.strip_prefix("refs/heads/") {
        Some(branch) => branch.to_string(),
        None if expected.head_name == DETACHED_HEAD_NAME => expected.tip.clone(),
        None => expected.head_name.clone(),
    };
    let body = format!(
        "Your branch is left mid-rebase and its rebase record is unreadable; the plan was read at {}.\nRun git rebase --quit, then check out {target} again.\n{abort_report}",
        expected.tip
    );
    match failure {
        Some(failure) => live_rebase_error(L_ABORTFAILED, body.trim_end(), failure),
        None => AppError::Command(format!("{L_ABORTFAILED}\n{}", body.trim_end())),
    }
}

/// A failed abort after the gate passed: named by the rebase's own record when it is
/// readable, else with the `--quit` remedy.
fn failed_abort_error(
    git_dir: &Path,
    expected: &PlanStart,
    abort_report: &str,
    failure: Option<RebaseFailure>,
) -> AppError {
    match read_start_record(git_dir) {
        Some(record) => abort_failed_error(&record.orig_head, abort_report, failure),
        None => unreadable_record_error(expected, abort_report, failure),
    }
}

/// Starts the planned rebase, whose todo the editor pins in `envs` swap in, and runs
/// the start-tip gate at its leading `break`: `Ok` means the rebase is paused on
/// `base` with the plan's own tip and branch recorded, ready to continue. Any tip
/// move after the plan was read (a new commit or an amend trips git's missing-commits
/// stop; a reset to an ancestor or a branch switch trips the gate) aborts and
/// refuses; a rebase that isn't ours is never touched.
async fn start_planned_rebase(
    repo: &str,
    git_dir: &Path,
    base: &str,
    expected: &PlanStart,
    envs: &[(&str, &str)],
    start_timeout: std::time::Duration,
    abort_timeout: std::time::Duration,
) -> AppResult<()> {
    let mut args: Vec<&str> = REBASE_START_ARGS.to_vec();
    args.push(base);
    let started = run_git_raw_env(Some(repo), &args, envs, start_timeout).await;
    let rebasing = rebase_in_progress(git_dir);
    let out = match started {
        // No exit code and no report: routed as a failed start without the marker. A
        // timed-out git is already dead here: the runner kills its whole process tree.
        Err(e) if rebasing => {
            return clear_failed_start(repo, git_dir, expected, RebaseFailure::Other(e)).await;
        }
        Err(e) => return Err(rebase_failure_error(L_START, "", RebaseFailure::Other(e))),
        Ok(out) => out,
    };
    if out.code != 0 {
        if out.stderr.contains(REBASE_DIR_EXISTS) {
            return Err(rebase_failure_error(L_START, "", RebaseFailure::Git(out)));
        }
        if is_missing_commits_stop(&out.stderr) {
            // Ours by construction: git refuses to start over existing state (above),
            // and the entry's mid-op refusal ran first. git recorded the MOVED tip as
            // orig-head, so no tip comparison applies; the abort restores that tip.
            if !rebasing {
                return Err(AppError::InvalidArgument(UNCOVERED_RANGE_REFUSAL.into()));
            }
            return match abort_planned_rebase(repo, git_dir, abort_timeout).await {
                Ok(()) => Err(AppError::InvalidArgument(UNCOVERED_RANGE_REFUSAL.into())),
                Err(report) => Err(failed_abort_error(
                    git_dir,
                    expected,
                    &report,
                    Some(RebaseFailure::Git(out)),
                )),
            };
        }
        if rebasing {
            return clear_failed_start(repo, git_dir, expected, RebaseFailure::Git(out)).await;
        }
        return Err(rebase_failure_error(L_START, "", RebaseFailure::Git(out)));
    }
    if !rebasing {
        // Our leading `break` never ran, so git ran its own todo instead of ours.
        let (label, at) = if expected.head_name == DETACHED_HEAD_NAME {
            ("HEAD", "HEAD")
        } else {
            (expected.head_name.as_str(), expected.head_name.as_str())
        };
        let now = run_git(Some(repo), &["rev-parse", "--verify", at], DEFAULT_TIMEOUT)
            .await
            .map(|o| o.stdout_lossy().trim().to_string())
            .unwrap_or_else(|_| "an unreadable commit".into());
        return Err(AppError::Command(format!(
            "{L_NOREWRITE}\n{label} is at {now}; its tip before this run was {}.",
            expected.tip
        )));
    }
    match read_start_record(git_dir) {
        Some(record) if record.matches(expected) => Ok(()),
        Some(record) => match abort_planned_rebase(repo, git_dir, DEFAULT_TIMEOUT).await {
            Ok(()) => Err(AppError::InvalidArgument(UNCOVERED_RANGE_REFUSAL.into())),
            Err(report) => Err(abort_failed_error(&record.orig_head, &report, None)),
        },
        None => match abort_planned_rebase(repo, git_dir, DEFAULT_TIMEOUT).await {
            Ok(()) => Err(AppError::Command(format!(
                "{L_UNVERIFIED}\nIts tip before this run was {}.",
                expected.tip
            ))),
            Err(report) => Err(unreadable_record_error(expected, &report, None)),
        },
    }
}

/// A start that failed yet left a rebase in progress. Only a rebase whose own record
/// names the plan's tip and branch is ours to clear; any other is left alone. On the
/// branch, `--quit` drops the state without touching HEAD or the index; from a
/// detached HEAD only `--abort` puts the branch back.
async fn clear_failed_start(
    repo: &str,
    git_dir: &Path,
    expected: &PlanStart,
    failure: RebaseFailure,
) -> AppResult<()> {
    if !read_start_record(git_dir).is_some_and(|record| record.matches(expected)) {
        return Err(rebase_failure_error(L_START, "", failure));
    }
    let cleared = match read_head_name(repo).await {
        Ok(name) if name != DETACHED_HEAD_NAME => {
            let quit = run_git_raw(
                Some(repo),
                &[
                    "-c",
                    "gc.auto=0",
                    "-c",
                    "maintenance.auto=false",
                    "rebase",
                    "--quit",
                ],
                DEFAULT_TIMEOUT,
            )
            .await;
            match quit {
                Err(e) => Err(e.to_string()),
                Ok(out) if out.code != 0 => Err(out.full_failure_text()),
                Ok(_) if rebase_in_progress(git_dir) => {
                    Err("git rebase --quit exited cleanly but left a rebase in progress.".into())
                }
                Ok(_) => Ok(()),
            }
        }
        _ => abort_planned_rebase(repo, git_dir, DEFAULT_TIMEOUT).await,
    };
    match cleared {
        Ok(()) => Err(rebase_failure_error(L_START, "", failure)),
        Err(report) => Err(abort_failed_error(&expected.tip, &report, Some(failure))),
    }
}

/// A continue that failed with nothing left in progress: the kill landed after git
/// finished. The plan's branch, still checked out and moved off the plan's tip, means
/// it completed (a changed plan always moves the tip); at the plan's tip nothing was
/// rewritten; anything else is reported, not guessed.
async fn classify_finished_rebase(repo: &str, expected: &PlanStart) -> AppResult<()> {
    let orig = &expected.tip;
    if expected.head_name == DETACHED_HEAD_NAME {
        // A detached plan has no branch to read the outcome off.
        let head = run_git(
            Some(repo),
            &["rev-parse", "--verify", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_else(|_| "an unreadable commit".into());
        return Err(AppError::Command(format!(
            "{L_UNCONFIRMED}\nIts tip before this run was {orig}; HEAD is at {head}.\nIf a rebase is still in progress, run git rebase --abort."
        )));
    }
    let on = read_head_name(repo).await.ok();
    let at = run_git(
        Some(repo),
        &["rev-parse", "--verify", &expected.head_name],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string());
    match (on.as_deref(), at.as_deref()) {
        (Some(on), Some(at)) if on == expected.head_name && at != orig => Ok(()),
        (Some(on), Some(_)) if on == expected.head_name => Err(AppError::Command(format!(
            "{L_NOREWRITE}\n{} is at {orig}, its tip before this run.",
            expected.head_name
        ))),
        _ => Err(AppError::Command(format!(
            "{L_UNCONFIRMED}\nIts tip before this run was {orig}; HEAD is on {}, and {} reads {}.\nIf a rebase is still in progress, run git rebase --abort.",
            on.as_deref().unwrap_or("an unreadable ref"),
            expected.head_name,
            at.as_deref().unwrap_or("nothing"),
        ))),
    }
}

/// git's own report when a rebase todo omits a commit under
/// `missingCommitsCheck=error` (stderr, in the C locale the runner forces; git 2.51.1).
/// Two lines, so a conflicting pick's one-line "could not apply <sha>... <subject>"
/// can never match it.
const MISSING_COMMITS_STOP: &str =
    "some commits may have been dropped accidentally.\nDropped commits (newer to older):";

fn is_missing_commits_stop(stderr: &str) -> bool {
    stderr.replace("\r\n", "\n").contains(MISSING_COMMITS_STOP)
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
    // lightweight, where %(objectname) already IS the commit). The name is read in
    // full and stripped of exactly `refs/tags/`: the short form is `tags/<name>` for a
    // tag sharing its name with a branch.
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "refs/tags",
            "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents:subject)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let tags = out
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts
                .next()?
                .strip_prefix("refs/tags/")
                .filter(|n| !n.is_empty())?
                .to_string();
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
    use super::branch_state_fixtures::{
        branch_state_present, stop_an_autostashed_squash, write_unguarded_branch_state,
    };
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
        assert_eq!(
            untracked,
            vec![PathListingEntry {
                path: "new.txt".to_string(),
                undecodable: false
            }]
        );
    }

    /// `undecodable` is judged on each name's RAW bytes: a lost byte flags its own
    /// row only, while a real U+FFFD is valid UTF-8 and never flags. Fed as bytes
    /// because Windows git cannot put an undecodable name on disk or in the index.
    #[test]
    fn listing_rows_flag_only_genuinely_undecodable_names() {
        let mut stdout: Vec<u8> = Vec::new();
        for name in [
            b"ok.txt".as_slice(),
            b"caf\xE9.txt".as_slice(),
            "x\u{FFFD}y.txt".as_bytes(),
            b"sec\xFFret.md".as_slice(),
        ] {
            stdout.extend_from_slice(name);
            stdout.push(0);
        }
        let row = |path: &str, undecodable| PathListingEntry {
            path: path.to_string(),
            undecodable,
        };
        assert_eq!(
            path_listing(&stdout),
            vec![
                row("ok.txt", false),
                row("caf\u{FFFD}.txt", true),
                row("x\u{FFFD}y.txt", false),
                row("sec\u{FFFD}ret.md", true),
            ]
        );
        assert!(path_listing(b"").is_empty());
        assert_eq!(
            serde_json::to_value(row("a", true)).unwrap(),
            serde_json::json!({ "path": "a", "undecodable": true })
        );
    }

    /// The tracked listing reaches the same rows through git: a real U+FFFD name,
    /// committed for real, comes back decodable.
    #[tokio::test]
    async fn list_tracked_reports_a_real_replacement_name_as_decodable() {
        let (dir, repo) = setup_repo("tracked-fffd").await;
        commit_file(&repo, dir.path(), "x\u{FFFD}y.txt", "r\n", "fffd").await;
        let tracked = git_list_tracked(repo).await.unwrap();
        assert_eq!(
            tracked,
            vec![
                PathListingEntry {
                    path: "a.txt".to_string(),
                    undecodable: false
                },
                PathListingEntry {
                    path: "x\u{FFFD}y.txt".to_string(),
                    undecodable: false
                },
            ]
        );
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
    /// red here means the guard in `run_git_spawn` is gone and every
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
        // Untracked file → still Ok: `reset --hard` leaves it alone only where the
        // target doesn't track its path, which `refuse_untracked_reset_collisions` checks.
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

    #[test]
    fn colliding_untracked_matches_every_shape_git_overwrites() {
        let untracked = |paths: &[&str]| paths.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let tracked = ["a.txt", "d/x", "f", "sub/inner.txt"];
        assert_eq!(
            colliding_untracked(
                &untracked(&["a.txt", "d", "f/y", "sub/", "d/y", "other.txt"]),
                &tracked,
                false
            ),
            untracked(&["a.txt", "d", "f/y", "sub/"]),
            "exact path, file-where-dir, dir-where-file and a nested repo collide; \
             a sibling in a shared directory and an unrelated file don't"
        );
        assert!(colliding_untracked(&untracked(&["A.TXT"]), &tracked, false).is_empty());
        assert_eq!(
            colliding_untracked(&untracked(&["A.TXT", "D/X"]), &tracked, true),
            untracked(&["A.TXT", "D/X"]),
            "a case-folding checkout overwrites a differently-cased file"
        );
        assert!(colliding_untracked(&[], &tracked, false).is_empty());
        assert!(colliding_untracked(&untracked(&["a.txt"]), &[], false).is_empty());
    }

    /// Commits `g.txt`, then deletes it in a second commit: resetting to the first
    /// writes `g.txt` back. Returns the commit that tracks it.
    async fn setup_reset_collision(marker: &str) -> (tempfile::TempDir, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        commit_file(&repo, dir.path(), "g.txt", "tracked\n", "add g").await;
        let tracks_g = rev(&repo, "HEAD").await;
        git(&repo, &["rm", "-q", "g.txt"]).await;
        git(&repo, &["commit", "-m", "drop g"]).await;
        (dir, repo, tracks_g)
    }

    /// git deletes an untracked file in the way of a path the target tracks, and a
    /// clean-tree check can't see it. The destruction control at the end proves the
    /// refusal is what kept the bytes.
    #[tokio::test]
    async fn reset_hard_refuses_to_overwrite_an_untracked_file_the_target_tracks() {
        let (dir, repo, tracks_g) = setup_reset_collision("reset-hard-collide").await;
        let precious = b"precious untracked work\r\nno newline at end";
        std::fs::write(dir.path().join("g.txt"), precious).unwrap();
        assert!(
            ensure_clean_tree(&repo).await.is_ok(),
            "fixture must pass the clean-tree check, or this test proves nothing new"
        );
        let tip = rev(&repo, "HEAD").await;
        let state = AppState::default();

        let err = git_reset_core(&state, repo.clone(), tracks_g.clone(), Some("hard".into()))
            .await
            .expect_err("an untracked file at a target-tracked path must refuse the reset");
        assert!(
            matches!(&err, AppError::InvalidArgument(m)
                if m.contains("overwrite an untracked path (g.txt)")
                    && m.contains("move or remove it first")),
            "the refusal must name the file and the remedy, got {err:?}"
        );
        assert_eq!(std::fs::read(dir.path().join("g.txt")).unwrap(), precious);
        assert_eq!(rev(&repo, "HEAD").await, tip, "and HEAD never moved");

        // Destruction control: git itself has no such scruples.
        git(&repo, &["reset", "--hard", &tracks_g]).await;
        assert_eq!(
            tree_text(dir.path(), "g.txt"),
            "tracked\n",
            "an unguarded hard reset overwrites exactly what the refusal protects"
        );
    }

    /// Moving the file aside clears the refusal; the reset then behaves as before.
    #[tokio::test]
    async fn reset_hard_proceeds_once_the_colliding_file_is_gone() {
        let (dir, repo, tracks_g) = setup_reset_collision("reset-hard-cleared").await;
        std::fs::write(dir.path().join("g.txt"), "precious\n").unwrap();
        let state = AppState::default();
        assert!(
            git_reset_core(&state, repo.clone(), tracks_g.clone(), Some("hard".into()))
                .await
                .is_err()
        );
        std::fs::rename(dir.path().join("g.txt"), dir.path().join("g.moved")).unwrap();
        // `g.moved` is untracked everywhere, so it must not block the reset either.
        git_reset_core(&state, repo.clone(), tracks_g.clone(), Some("hard".into()))
            .await
            .expect("a reset with nothing in its way succeeds");
        assert_eq!(rev(&repo, "HEAD").await, tracks_g);
        assert_eq!(tree_text(dir.path(), "g.txt"), "tracked\n");
        assert_eq!(tree_text(dir.path(), "g.moved"), "precious\n");
    }

    /// An untracked file at a path the target doesn't track is out of the reset's
    /// way: no refusal, and the file survives byte-identical.
    #[tokio::test]
    async fn reset_hard_keeps_an_untracked_file_the_target_does_not_track() {
        let (dir, repo, tracks_g) = setup_reset_collision("reset-hard-bystander").await;
        let bytes = b"scratch\r\n";
        std::fs::write(dir.path().join("scratch.txt"), bytes).unwrap();
        let state = AppState::default();
        git_reset_core(&state, repo.clone(), tracks_g.clone(), Some("hard".into()))
            .await
            .expect("an untracked bystander must not block the reset");
        assert_eq!(rev(&repo, "HEAD").await, tracks_g);
        assert_eq!(
            std::fs::read(dir.path().join("scratch.txt")).unwrap(),
            bytes
        );
    }

    /// Called with a subdirectory, the guard still sees the whole tree: an untracked
    /// file at the root, where the target writes, refuses even though the
    /// subdirectory itself holds nothing untracked.
    #[tokio::test]
    async fn reset_collision_guard_resolves_the_toplevel_from_a_subdirectory() {
        let (dir, _repo, tracks_g) = setup_reset_collision("reset-collide-subdir").await;
        std::fs::write(dir.path().join("g.txt"), "precious\n").unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub = sub.to_string_lossy().into_owned();

        let err = refuse_untracked_reset_collisions(&sub, &tracks_g)
            .await
            .expect_err("a root-level collision must refuse from a subdirectory too");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("(g.txt)")),
            "got {err:?}"
        );
    }

    /// Past a handful, the refusal names the first few and counts the rest.
    #[tokio::test]
    async fn reset_hard_collision_refusal_caps_the_named_files() {
        let (dir, repo) = setup_repo("reset-hard-many").await;
        let base = rev(&repo, "HEAD").await;
        let names: Vec<String> = (1..=7).map(|i| format!("n{i}.txt")).collect();
        for name in &names {
            std::fs::write(dir.path().join(name), "tracked\n").unwrap();
        }
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "add seven"]).await;
        let tracks_all = rev(&repo, "HEAD").await;
        git(&repo, &["reset", "--hard", &base]).await;
        for name in &names {
            std::fs::write(dir.path().join(name), "mine\n").unwrap();
        }
        let state = AppState::default();
        let err = git_reset_core(&state, repo.clone(), tracks_all, Some("hard".into()))
            .await
            .expect_err("seven collisions refuse");
        let AppError::InvalidArgument(msg) = &err else {
            panic!("got {err:?}");
        };
        assert!(
            msg.contains("untracked paths (n1.txt, n2.txt, n3.txt, n4.txt, n5.txt and 2 more)")
                && msg.contains("move or remove them first"),
            "{msg}"
        );
    }

    fn assert_reset_head_moved(result: AppResult<()>) {
        match result {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, RESET_HEAD_MOVED),
            other => panic!("expected the head-moved refusal, got {other:?}"),
        }
    }

    /// The user confirmed against `seen`; an outside commit landed before the reset
    /// ran. The reset must keep that commit, with HEAD, index and tree untouched.
    #[tokio::test]
    async fn reset_hard_refuses_when_head_moved_since_confirmed() {
        let (dir, repo) = setup_repo("reset-hard-moved").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let seen = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "outside\n", "outside").await;
        let outside = rev(&repo, "HEAD").await;
        let state = AppState::default();

        let result = git_reset_core_expecting(
            &state,
            repo.clone(),
            base,
            Some("hard".into()),
            Some(seen),
            ExpectedRef::Any,
        )
        .await;

        assert_reset_head_moved(result);
        assert_eq!(
            rev(&repo, "HEAD").await,
            outside,
            "the outside commit is kept"
        );
        assert_eq!(tree_text(dir.path(), "a.txt"), "v1\n");
        assert_eq!(tree_text(dir.path(), "b.txt"), "outside\n");
        assert_eq!(
            git(&repo, &["status", "--porcelain"]).await,
            "",
            "index and tree are untouched"
        );
    }

    #[tokio::test]
    async fn reset_hard_with_current_head_succeeds() {
        let (dir, repo) = setup_repo("reset-hard-current").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        commit_file(&repo, dir.path(), "b.txt", "outside\n", "outside").await;
        let seen = rev(&repo, "HEAD").await;
        let state = AppState::default();

        git_reset_core_expecting(
            &state,
            repo.clone(),
            base.clone(),
            Some("hard".into()),
            Some(seen),
            ExpectedRef::Any,
        )
        .await
        .expect("a reset pinned to the current HEAD runs");

        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v0\n");
        assert!(!dir.path().join("b.txt").exists());
    }

    #[tokio::test]
    async fn reset_hard_expected_head_compare_is_full_hash_in_sha256_repos() {
        let dir = tempfile::Builder::new()
            .prefix("gd-rewrite-reset-hard-sha256-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "--object-format=sha256"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit_file(&repo, dir.path(), "a.txt", "v0\n", "base").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        assert_eq!(tip.len(), 64, "a sha256 oid");
        let state = AppState::default();

        // Same 63-char prefix, different last digit: only a full compare tells them apart.
        let last = if tip.ends_with('0') { '1' } else { '0' };
        for stale in [format!("{}{last}", &tip[..63]), tip[..40].to_string()] {
            let result = git_reset_core_expecting(
                &state,
                repo.clone(),
                base.clone(),
                Some("hard".into()),
                Some(stale),
                ExpectedRef::Any,
            )
            .await;
            assert_reset_head_moved(result);
            assert_eq!(rev(&repo, "HEAD").await, tip);
        }

        git_reset_core_expecting(
            &state,
            repo.clone(),
            base.clone(),
            Some("hard".into()),
            Some(tip),
            ExpectedRef::Any,
        )
        .await
        .expect("the full oid matches");
        assert_eq!(rev(&repo, "HEAD").await, base);
    }

    /// A switch to another branch at the SAME commit passes the oid pin; the branch pin
    /// refuses it before the tree is touched, and the branch HEAD is on proceeds.
    #[tokio::test]
    async fn reset_hard_refuses_a_same_oid_switch_to_another_branch() {
        let (dir, repo) = setup_repo("reset-hard-switched").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let seen = ExpectedRef::Branch(head_branch(&repo).await);
        git(&repo, &["switch", "-qc", "other"]).await;
        let state = AppState::default();
        let reset = |on: ExpectedRef| {
            git_reset_core_expecting(
                &state,
                repo.clone(),
                base.clone(),
                Some("hard".into()),
                Some(tip.clone()),
                on,
            )
        };

        match reset(seen).await {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, RESET_BRANCH_SWITCHED),
            other => panic!("expected the branch-switched refusal, got {other:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, tip, "HEAD is untouched");
        assert_eq!(tree_text(dir.path(), "a.txt"), "v1\n");

        reset(ExpectedRef::Branch("other".into()))
            .await
            .expect("the branch HEAD is on resets");
        assert_eq!(rev(&repo, "HEAD").await, base);
    }

    /// Detached and attached are different answers at the same commit, both ways.
    #[tokio::test]
    async fn reset_hard_refuses_a_detached_flip_either_way() {
        let (dir, repo) = setup_repo("reset-hard-flip").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let attached = ExpectedRef::Branch(head_branch(&repo).await);
        let state = AppState::default();
        let reset = |on: ExpectedRef| {
            git_reset_core_expecting(
                &state,
                repo.clone(),
                base.clone(),
                Some("hard".into()),
                Some(tip.clone()),
                on,
            )
        };
        let refused = |result: AppResult<()>| match result {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, RESET_BRANCH_SWITCHED),
            other => panic!("expected the branch-switched refusal, got {other:?}"),
        };

        refused(reset(ExpectedRef::Detached).await);
        git(&repo, &["checkout", "-q", "--detach"]).await;
        refused(reset(attached).await);
        assert_eq!(rev(&repo, "HEAD").await, tip);

        reset(ExpectedRef::Detached)
            .await
            .expect("a detached HEAD resets when the pin says detached");
        assert_eq!(rev(&repo, "HEAD").await, base);
    }

    /// The mixed arm serves History's reset and the MCP `reset_to_commit`, which name
    /// an explicit commit, so a pin never reaches it.
    #[tokio::test]
    async fn mixed_reset_ignores_expected_head() {
        let (dir, repo) = setup_repo("reset-mixed-pin").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let state = AppState::default();

        git_reset_core_expecting(
            &state,
            repo.clone(),
            base.clone(),
            Some("mixed".into()),
            Some("0".repeat(40)),
            ExpectedRef::Branch("not-this-branch".into()),
        )
        .await
        .expect("a mixed reset runs whatever the pin says");

        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v1\n");
    }

    async fn reset_hard_on(
        state: &AppState,
        repo: &str,
        target: &str,
        seen: &str,
        on: ExpectedRef,
    ) -> AppResult<()> {
        git_reset_core_expecting(
            state,
            repo.to_string(),
            target.to_string(),
            Some("hard".into()),
            Some(seen.to_string()),
            on,
        )
        .await
    }

    async fn reflog_subject(repo: &str, name: &str) -> String {
        git(repo, &["reflog", "-1", "--format=%gs", name])
            .await
            .trim()
            .to_string()
    }

    /// HEAD's branch as its full ref.
    async fn head_ref(repo: &str) -> String {
        git(repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string()
    }

    async fn orig_head(repo: &str) -> Option<String> {
        crate::git::commit::ref_oid(repo, "ORIG_HEAD")
            .await
            .unwrap()
    }

    fn racer_landed(slot: &std::sync::Mutex<Option<String>>) -> String {
        slot.lock().unwrap().clone().expect("the racer committed")
    }

    /// A seam that creates each of `locks`, left held for the test to remove, then runs
    /// `steps` as raw git.
    fn locking(
        repo: &str,
        locks: Vec<std::path::PathBuf>,
        steps: &[&[&str]],
    ) -> crate::git::commit::PhaseHook {
        let racer = crate::git::commit::racing_git(repo, steps);
        std::sync::Arc::new(move || {
            for lock in &locks {
                std::fs::write(lock, b"").unwrap();
            }
            racer()
        })
    }

    fn reset_message(result: AppResult<()>) -> String {
        match result {
            Err(AppError::Git { stderr, .. }) => stderr,
            other => panic!("expected a git error, got {other:?}"),
        }
    }

    /// Another process commits on top of the confirmed tip after the guards: the swap from
    /// that tip refuses, so the racer's commit stays the tip and the tree is untouched.
    #[tokio::test]
    async fn reset_hard_refuses_a_commit_landing_before_its_swap() {
        let (dir, repo) = setup_repo("reset-hard-raced").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let seen = rev(&repo, "HEAD").await;
        let on = ExpectedRef::Branch(head_branch(&repo).await);
        let (commit, landed) = crate::git::commit::racing_commit(&repo, "r.txt");
        let state = AppState::default();

        let result = RESET_PHASE_HOOK
            .scope(commit, reset_hard_on(&state, &repo, &base, &seen, on))
            .await;

        assert_reset_head_moved(result);
        assert_eq!(rev(&repo, "HEAD").await, racer_landed(&landed));
        assert_eq!(rev(&repo, "HEAD~1").await, seen);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v1\n");
        assert_eq!(git(&repo, &["status", "--porcelain"]).await, "");
        assert_eq!(orig_head(&repo).await, None);
    }

    /// The swap records what `git reset --hard` does: tree and index at the target,
    /// ORIG_HEAD at the old tip, and the move in the branch's reflog AND HEAD's (git logs
    /// HEAD when it moves HEAD's referent), under the hash as the caller spelled it.
    #[tokio::test]
    async fn reset_hard_records_orig_head_and_logs_both_reflogs() {
        let (dir, repo) = setup_repo("reset-hard-logs").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "third").await;
        let tip = rev(&repo, "HEAD").await;
        let full = head_ref(&repo).await;
        let short = &base[..12];
        let state = AppState::default();

        reset_hard_on(
            &state,
            &repo,
            short,
            &tip,
            ExpectedRef::Branch(head_branch(&repo).await),
        )
        .await
        .expect("the reset runs");

        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v0\n");
        assert!(!dir.path().join("b.txt").exists());
        assert_eq!(
            git(&repo, &["status", "--porcelain"]).await,
            "",
            "index and tree match the target"
        );
        assert_eq!(orig_head(&repo).await, Some(tip));
        for log in [full.as_str(), "HEAD"] {
            assert_eq!(
                reflog_subject(&repo, log).await,
                format!("reset: moving to {short}"),
                "{log}"
            );
        }
    }

    /// `update-ref` takes an oid as given, so a tag object's oid is peeled to its commit
    /// first, as `reset --hard` peels it: the branch never points at a tag.
    #[tokio::test]
    async fn reset_hard_peels_an_annotated_tag_to_its_commit() {
        let (dir, repo) = setup_repo("reset-hard-peel").await;
        let base = rev(&repo, "HEAD").await;
        git(&repo, &["tag", "-a", "v0", "-m", "tag"]).await;
        let tag_object = rev(&repo, "refs/tags/v0").await;
        assert_ne!(tag_object, base, "fixture: the tag is its own object");
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let full = head_ref(&repo).await;
        let state = AppState::default();

        reset_hard_on(&state, &repo, &tag_object, &tip, ExpectedRef::Any)
            .await
            .expect("the reset runs");

        assert_eq!(rev(&repo, &full).await, base);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v0\n");
    }

    /// Unpinned on an unborn branch, the swap creates the branch only while it still
    /// doesn't exist, and there is no old tip for ORIG_HEAD.
    #[tokio::test]
    async fn reset_hard_unpinned_creates_an_unborn_branch() {
        let (dir, repo) = setup_repo("reset-hard-unborn").await;
        let base = rev(&repo, "HEAD").await;
        git(&repo, &["switch", "-q", "--orphan", "fresh"]).await;
        let state = AppState::default();

        git_reset_core(&state, repo.clone(), base.clone(), Some("hard".into()))
            .await
            .expect("the reset creates the branch");

        assert_eq!(rev(&repo, "refs/heads/fresh").await, base);
        assert_eq!(tree_text(dir.path(), "a.txt"), "v0\n");
        assert_eq!(git(&repo, &["status", "--porcelain"]).await, "");
        assert_eq!(orig_head(&repo).await, None);
    }

    /// Detached, the swap moves HEAD itself (`--no-deref`): a commit landing first refuses
    /// it, and a clean one leaves the branch HEAD came from where it was while HEAD's
    /// reflog records the move.
    #[tokio::test]
    async fn reset_hard_detached_moves_head_itself() {
        let (dir, repo) = setup_repo("reset-hard-detached").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let branch = head_ref(&repo).await;
        git(&repo, &["checkout", "-q", "--detach"]).await;
        let (commit, landed) = crate::git::commit::racing_commit(&repo, "r.txt");
        let state = AppState::default();

        let result = RESET_PHASE_HOOK
            .scope(
                commit,
                reset_hard_on(&state, &repo, &base, &tip, ExpectedRef::Detached),
            )
            .await;

        assert_reset_head_moved(result);
        let racer = racer_landed(&landed);
        assert_eq!(rev(&repo, "HEAD").await, racer);

        reset_hard_on(&state, &repo, &base, &racer, ExpectedRef::Detached)
            .await
            .expect("a detached reset runs");
        assert_eq!(rev(&repo, "HEAD").await, base);
        assert_eq!(
            crate::git::branches::current_branch_ref(&repo)
                .await
                .unwrap(),
            None,
            "HEAD stays detached"
        );
        assert_eq!(rev(&repo, &branch).await, tip, "the branch stays put");
        assert_eq!(
            reflog_subject(&repo, "HEAD").await,
            format!("reset: moving to {base}")
        );
        assert_eq!(orig_head(&repo).await, Some(racer));
        assert_eq!(git(&repo, &["status", "--porcelain"]).await, "");
    }

    fn assert_reset_switched(result: AppResult<()>, case: &str) {
        match result {
            Err(AppError::Git { stderr, .. }) => {
                assert_eq!(stderr, RESET_BRANCH_SWITCHED, "{case}")
            }
            other => panic!("{case}: expected the branch-switched refusal, got {other:?}"),
        }
    }

    /// Another process switches branches right after the swap landed, which the swap (it
    /// compares only the branch's own oid) can't see: HEAD's re-read moves the branch back
    /// and refuses before any file is written. A branch at another commit and one at the
    /// confirmed tip both count.
    #[tokio::test]
    async fn reset_hard_moves_back_and_refuses_a_switch_right_after_its_swap() {
        for target in ["side", "twin"] {
            let (dir, repo) = setup_repo("reset-hard-switched-after").await;
            let base = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
            let tip = rev(&repo, "HEAD").await;
            let full = head_ref(&repo).await;
            let start = head_branch(&repo).await;
            git(&repo, &["branch", "twin"]).await;
            git(&repo, &["switch", "-qc", "side"]).await;
            commit_file(&repo, dir.path(), "s.txt", "s\n", "side work").await;
            git(&repo, &["switch", "-q", &start]).await;
            let state = AppState::default();

            let result = RESET_SWAPPED_HOOK
                .scope(
                    crate::git::commit::racing_git(&repo, &[&["switch", "-q", target]]),
                    reset_hard_on(&state, &repo, &base, &tip, ExpectedRef::Branch(start)),
                )
                .await;

            assert_reset_switched(result, target);
            assert_eq!(rev(&repo, &full).await, tip, "{target}: the branch is back");
            assert_eq!(
                head_branch(&repo).await,
                target,
                "{target}: the switch stands"
            );
            assert_eq!(
                tree_text(dir.path(), "a.txt"),
                "v1\n",
                "{target}: no file was written"
            );
            assert_eq!(git(&repo, &["status", "--porcelain"]).await, "", "{target}");
            assert_eq!(orig_head(&repo).await, None, "{target}");
            assert_eq!(reflog_subject(&repo, &full).await, "reset: rolling back");
        }
    }

    /// Detached, a switch onto a branch right after the swap replaced HEAD itself, so the
    /// swap left nothing to move back (moving HEAD back would undo the switch): the reset
    /// refuses with HEAD on the branch the switch chose and no file written.
    #[tokio::test]
    async fn reset_hard_detached_refuses_an_attach_right_after_its_swap() {
        let (dir, repo) = setup_repo("reset-hard-attached-after").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let start = head_branch(&repo).await;
        git(&repo, &["checkout", "-q", "--detach"]).await;
        let state = AppState::default();
        let attach = crate::git::commit::racing_git(&repo, &[&["switch", "-q", start.as_str()]]);

        let result = RESET_SWAPPED_HOOK
            .scope(
                attach,
                reset_hard_on(&state, &repo, &base, &tip, ExpectedRef::Detached),
            )
            .await;

        assert_reset_switched(result, "detached");
        assert_eq!(head_branch(&repo).await, start);
        assert_eq!(rev(&repo, "HEAD").await, tip);
        assert_eq!(
            tree_text(dir.path(), "a.txt"),
            "v1\n",
            "no file was written"
        );
        assert_eq!(git(&repo, &["status", "--porcelain"]).await, "");
        assert_eq!(orig_head(&repo).await, None);
    }

    /// Parity with git's own `reset --hard`, measured on twin repos (git 2.51.1): both clear
    /// MERGE_MSG, SQUASH_MSG, MERGE_MODE, MERGE_RR and AUTO_MERGE. git also clears
    /// CHERRY_PICK_HEAD and REVERT_HEAD, which never reach this reset: the op-state guard
    /// refuses them first. A resolved squash merge (no MERGE_HEAD, so no guard) is the real
    /// state that does reach it, autostash included.
    #[tokio::test]
    async fn reset_hard_clears_the_branch_state_git_reset_clears() {
        let unguarded = [
            "MERGE_MSG",
            "SQUASH_MSG",
            "MERGE_MODE",
            "MERGE_RR",
            "AUTO_MERGE",
        ];
        let state = AppState::default();
        for ours in [false, true] {
            let (dir, repo) = setup_repo("reset-hard-parity").await;
            let base = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
            write_unguarded_branch_state(&repo, &rev(&repo, "HEAD").await).await;
            assert_eq!(branch_state_present(&repo).await, unguarded);

            if ours {
                git_reset_core(&state, repo.clone(), base, Some("hard".into()))
                    .await
                    .expect("the reset runs");
            } else {
                git(&repo, &["reset", "--hard", &base]).await;
            }

            assert!(branch_state_present(&repo).await.is_empty(), "ours: {ours}");
        }

        for name in ["CHERRY_PICK_HEAD", "REVERT_HEAD"] {
            for ours in [false, true] {
                let (dir, repo) = setup_repo("reset-hard-parity-pick").await;
                let base = rev(&repo, "HEAD").await;
                commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
                git(&repo, &["update-ref", name, "HEAD"]).await;
                if ours {
                    let err = git_reset_core(&state, repo.clone(), base, Some("hard".into()))
                        .await
                        .expect_err("the op-state guard refuses first");
                    assert!(
                        matches!(&err, AppError::InvalidArgument(m) if m.contains("in progress"))
                    );
                    assert_eq!(branch_state_present(&repo).await, [name]);
                } else {
                    git(&repo, &["reset", "--hard", &base]).await;
                    assert!(
                        branch_state_present(&repo).await.is_empty(),
                        "git clears {name}"
                    );
                }
            }
        }

        for ours in [false, true] {
            let (dir, repo) = setup_repo("reset-hard-parity-squash").await;
            let base = rev(&repo, "HEAD").await;
            let start = head_branch(&repo).await;
            git(&repo, &["switch", "-qc", "feature"]).await;
            commit_file(&repo, dir.path(), "a.txt", "theirs\n", "feature edit").await;
            git(&repo, &["switch", "-q", &start]).await;
            commit_file(&repo, dir.path(), "a.txt", "mine\n", "base edit").await;
            let squash = run_git_raw(
                Some(&repo),
                &["merge", "--squash", "feature"],
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap();
            assert_ne!(squash.code, 0, "fixture: the squash stops on its conflict");
            git(&repo, &["checkout", "--ours", "--", "a.txt"]).await;
            git(&repo, &["add", "a.txt"]).await;
            assert!(
                ensure_clean_tree(&repo).await.is_ok(),
                "fixture: a clean tree"
            );
            assert_eq!(
                branch_state_present(&repo).await,
                ["MERGE_MSG", "SQUASH_MSG", "AUTO_MERGE"],
                "fixture: what the resolved squash leaves"
            );

            if ours {
                git_reset_core(&state, repo.clone(), base, Some("hard".into()))
                    .await
                    .expect("a resolved squash leaves nothing to refuse");
            } else {
                git(&repo, &["reset", "--hard", &base]).await;
            }

            assert!(branch_state_present(&repo).await.is_empty(), "ours: {ours}");
        }

        // A stopped `merge --squash --autostash`: git files MERGE_AUTOSTASH in the stash
        // list as "autostash" instead of dropping it.
        for ours in [false, true] {
            let (_dir, repo) = setup_repo("reset-hard-parity-autostash").await;
            let base = rev(&repo, "HEAD").await;
            let autostash = stop_an_autostashed_squash(&repo).await;
            assert!(
                ensure_clean_tree(&repo).await.is_ok(),
                "fixture: a clean tree"
            );

            if ours {
                git_reset_core(&state, repo.clone(), base, Some("hard".into()))
                    .await
                    .expect("the reset runs");
            } else {
                git(&repo, &["reset", "--hard", &base]).await;
            }

            assert!(branch_state_present(&repo).await.is_empty(), "ours: {ours}");
            assert_eq!(
                git(&repo, &["stash", "list", "--format=%gs"]).await,
                "autostash\n",
                "ours: {ours}"
            );
            assert_eq!(rev(&repo, "stash@{0}").await, autostash, "ours: {ours}");
        }
    }

    /// The tree step fails after the swap (a held index.lock): the branch goes back by a
    /// swap from the reset's own target, ORIG_HEAD stays unwritten, and the verdict says
    /// the branch moved back without claiming nothing was reset.
    #[tokio::test]
    async fn reset_hard_moves_the_branch_back_when_the_tree_step_fails() {
        let (dir, repo) = setup_repo("reset-hard-tree-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let on = ExpectedRef::Branch(head_branch(&repo).await);
        let index_lock = dir.path().join(".git").join("index.lock");
        let state = AppState::default();

        let result = RESET_TREE_HOOK
            .scope(
                locking(&repo, vec![index_lock.clone()], &[]),
                reset_hard_on(&state, &repo, &base, &tip, on),
            )
            .await;

        let message = reset_message(result);
        assert_eq!(message.lines().next(), Some(RESET_TREE_ROLLED_BACK));
        assert!(
            message.contains("index.lock"),
            "git's own text follows: {message}"
        );
        assert_eq!(
            rev(&repo, "HEAD").await,
            tip,
            "the branch is back where it was"
        );
        assert_eq!(orig_head(&repo).await, None);
        std::fs::remove_file(&index_lock).unwrap();
        assert_eq!(tree_text(dir.path(), "a.txt"), "v1\n");
        assert_eq!(git(&repo, &["status", "--porcelain"]).await, "");
    }

    /// Another process moves the branch while the tree step fails: the rollback's swap from
    /// the reset's target refuses, so the branch stays exactly where that process put it.
    #[tokio::test]
    async fn reset_hard_never_moves_back_a_ref_another_process_moved() {
        let (dir, repo) = setup_repo("reset-hard-rollback-lost").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let branch = head_ref(&repo).await;
        let elsewhere = git(
            &repo,
            &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"],
        )
        .await
        .trim()
        .to_string();
        let index_lock = dir.path().join(".git").join("index.lock");
        let state = AppState::default();
        let racer = locking(
            &repo,
            vec![index_lock.clone()],
            &[&["update-ref", branch.as_str(), elsewhere.as_str()]],
        );

        let result = RESET_TREE_HOOK
            .scope(
                racer,
                reset_hard_on(&state, &repo, &base, &tip, ExpectedRef::Any),
            )
            .await;

        let message = reset_message(result);
        assert_eq!(
            message.lines().next(),
            Some(format!("{RESET_TREE_ROLLBACK_LOST} {SWITCH_ROLLBACK_HINT}").as_str())
        );
        assert_eq!(
            rev(&repo, &branch).await,
            elsewhere,
            "where the racer put it"
        );
        std::fs::remove_file(&index_lock).unwrap();
    }

    /// The rollback's own swap is blocked by a stale ref lock while the branch still sits
    /// at the reset's target: the verdict names that commit, never the race copy.
    #[tokio::test]
    async fn reset_hard_names_where_the_branch_stuck_when_its_rollback_is_blocked() {
        let (dir, repo) = setup_repo("reset-hard-rollback-blocked").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "second").await;
        let tip = rev(&repo, "HEAD").await;
        let full = head_ref(&repo).await;
        let git_dir = dir.path().join(".git");
        let locks = vec![
            git_dir.join("index.lock"),
            git_dir.join(format!("{full}.lock")),
        ];
        let state = AppState::default();

        let result = RESET_TREE_HOOK
            .scope(
                locking(&repo, locks.clone(), &[]),
                reset_hard_on(
                    &state,
                    &repo,
                    &base,
                    &tip,
                    ExpectedRef::Branch(head_branch(&repo).await),
                ),
            )
            .await;

        let message = reset_message(result);
        assert_eq!(
            message.lines().next(),
            Some(
                format!(
                    "{} {SWITCH_ROLLBACK_HINT}",
                    reset_tree_rollback_failed(&base)
                )
                .as_str()
            )
        );
        assert!(message.contains(&base[..7]));
        assert!(!message.contains(RESET_TREE_ROLLBACK_LOST));
        assert_eq!(rev(&repo, &full).await, base);
        for lock in &locks {
            std::fs::remove_file(lock).unwrap();
        }
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
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)], &[])
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
            &[],
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
            &[],
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
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)], &[]).await;
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
                // Below the verdict, git's whole report: the rebase splits a
                // conflicted pick's report across both streams.
                assert!(
                    stderr.contains("could not apply")
                        && stderr.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "the verdict must carry git's diagnostic AND its file list: {stderr}"
                );
                // The rollback made git's progress and continue/skip/abort hints moot.
                assert!(
                    !stderr.lines().any(|l| l.starts_with("hint:")),
                    "no hint lines: {stderr}"
                );
                assert!(!stderr.contains("Rebasing ("), "no progress: {stderr}");
            }
            Ok(()) => panic!("the conflicting rewrite must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, orig);
        assert!(!rebasing(&repo).await, "the rollback leaves no rebase");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A squash conflicts inside its group script's `cherry-pick -n`, a failed exec
    /// rather than a pick's stop — so it needs its own conflict.
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
        // so the leader's pick conflicts before any fold is applied.
        let result = rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c2, c1],
                message: Some("combined".into()),
                edit: false,
            }],
            &[],
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
        assert!(!rebasing(&repo).await, "the rollback leaves no rebase");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// The other half of the family: a squash whose commits cancel out is refused by
    /// its group script, with no conflict to blame — the verdict must still carry
    /// that report under it.
    #[tokio::test]
    async fn empty_squash_rolls_back_and_carries_its_report() {
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
            &[],
        )
        .await;
        match result {
            Err(AppError::Git { ref stderr, .. }) => {
                assert_verdict_shape(stderr, "was rolled back");
                assert!(
                    stderr.lines().any(|l| l == EMPTY_GROUP_ERROR),
                    "the verdict must carry the empty-net report: {stderr}"
                );
            }
            Ok(()) => panic!("the empty squash must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, orig);
        assert!(!rebasing(&repo).await, "the rollback leaves no rebase");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A change, its revert and another change: replayed as one group, the fold after
    /// the revert would net the commit empty midway, yet the group applies.
    /// Returns (dir, repo, base, [leader, revert, other]).
    async fn revert_pair_group(marker: &str) -> (tempfile::TempDir, String, String, [String; 3]) {
        let (dir, repo) = setup_repo(marker).await;
        let base = rev(&repo, "HEAD").await;
        std::fs::write(dir.path().join("a.txt"), "v0\nX\n").unwrap();
        git(&repo, &["add", "."]).await;
        git(
            &repo,
            &[
                "commit",
                "--author",
                "Orig Author <orig@example.com>",
                "--date",
                "2021-01-01T10:00:00+02:00",
                "-m",
                "add X",
            ],
        )
        .await;
        let leader = rev(&repo, "HEAD").await;
        git(&repo, &["revert", "--no-edit", "HEAD"]).await;
        let revert = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "add b").await;
        let other = rev(&repo, "HEAD").await;
        (dir, repo, base, [leader, revert, other])
    }

    /// Re-creates `chain` (oldest first, ending at HEAD) with a bogus `gpgsig` header
    /// on its first commit and the same trees, moves the branch to the new tip, and
    /// returns the new chain. Under `log.showSignature` git then prints gpg's failed
    /// verification for that commit.
    async fn with_bogus_signature_on_first(repo: &str, chain: &[String]) -> Vec<String> {
        const SIGNATURE: &str = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEAAAAAAAAAAAAAAAAAAAAAAAAAAAFAmAAAAAACgkQAAAAAAAA\n AAA=\n =AAAA\n -----END PGP SIGNATURE-----\n";
        let mut parent: Option<String> = None;
        let mut rebuilt = Vec::new();
        for (i, commit) in chain.iter().enumerate() {
            let raw = git(repo, &["cat-file", "commit", commit]).await;
            let (headers, message) = raw.split_once("\n\n").expect("a commit object");
            let mut object = String::new();
            for line in headers.lines() {
                match (&parent, line.starts_with("parent ")) {
                    (Some(p), true) => object.push_str(&format!("parent {p}\n")),
                    _ => object.push_str(&format!("{line}\n")),
                }
            }
            if i == 0 {
                object.push_str(SIGNATURE);
            }
            object.push_str(&format!("\n{message}"));
            let out = run_git_raw_input(
                Some(repo),
                &["hash-object", "-t", "commit", "-w", "--stdin"],
                Some(&object),
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(out.code, 0, "hash-object: {}", out.full_failure_text());
            let sha = out.stdout_lossy().trim().to_string();
            parent = Some(sha.clone());
            rebuilt.push(sha);
        }
        git(repo, &["reset", "-q", "--hard", rebuilt.last().unwrap()]).await;
        rebuilt
    }

    #[tokio::test]
    async fn a_fold_group_whose_middle_nets_empty_still_applies() {
        for message in [None, Some("Squashed \"it\" (with quotes)\n\nbody line")] {
            let marker = format!("revert-pair-{}", message.is_some());
            let (dir, repo, base, group) = revert_pair_group(&marker).await;
            // The message group's script reads the leader's identity through `git
            // log`; a signed leader under `log.showSignature` would splice gpg's
            // verification output into it. Vacuous where gpg is absent (Git for
            // Windows bundles it).
            let group = if message.is_some() {
                with_bogus_signature_on_first(&repo, &group).await
            } else {
                group.to_vec()
            };
            let identity = "%an <%ae> %ad";
            let leader = git(
                &repo,
                &[
                    "log",
                    "-1",
                    &format!("--format={identity}"),
                    "--date=raw",
                    &group[0],
                ],
            )
            .await;
            if message.is_some() {
                git(&repo, &["config", "log.showSignature", "true"]).await;
            }
            let state = AppState::default();
            rewrite_commits(
                &state,
                &repo,
                &base,
                &[RewriteStep {
                    hashes: group.clone(),
                    message: message.map(str::to_string),
                    edit: false,
                }],
                &[],
            )
            .await
            .unwrap_or_else(|e| panic!("message={message:?}: {e}"));
            assert_eq!(
                git(&repo, &["rev-list", "--count", &format!("{base}..HEAD")])
                    .await
                    .trim(),
                "1"
            );
            assert_eq!(
                git(&repo, &["log", "-1", "--format=%B"]).await.trim_end(),
                message.unwrap_or("add X"),
                "the leader's message, or the group's verbatim"
            );
            let changed = git(&repo, &["diff", "--name-only", &base, "HEAD"]).await;
            assert_eq!(changed.trim(), "b.txt", "base plus the third change only");
            assert_eq!(tree_text(dir.path(), "a.txt"), "v0\n");
            assert_eq!(
                git(
                    &repo,
                    &[
                        "log",
                        "-1",
                        &format!("--format={identity}"),
                        "--date=raw",
                        "HEAD"
                    ]
                )
                .await,
                leader,
                "the leader's author and author date, timezone included"
            );
            assert!(leader.contains(" +0200"), "{leader}");
            assert!(!rebasing(&repo).await, "nothing is in progress");
            let status = git(&repo, &["status", "--porcelain"]).await;
            assert!(status.trim().is_empty(), "tree should be clean: {status}");
        }
    }

    /// A fold that conflicts inside its group's exec rolls back like any other stop,
    /// leaving no cherry-pick state behind.
    #[tokio::test]
    async fn a_fold_conflicting_inside_its_group_rolls_back() {
        let (dir, repo, base, [leader, revert, other]) = revert_pair_group("fold-conflict").await;
        commit_file(&repo, dir.path(), "a.txt", "v0\nZ\n", "add Z").await;
        let add_z = rev(&repo, "HEAD").await;
        let orig = add_z.clone();
        let expected = plan_start(&repo).await;

        // "add Z" leads onto `base`, then folding "add X" in conflicts on a.txt's end.
        let state = AppState::default();
        let result = rewrite_commits(
            &state,
            &repo,
            &base,
            &[
                RewriteStep {
                    hashes: vec![add_z, leader],
                    message: None,
                    edit: false,
                },
                pick(&revert),
                pick(&other),
            ],
            &[],
        )
        .await;
        let Err(AppError::Git { stderr, .. }) = &result else {
            panic!("the conflicting fold must roll back, got {result:?}");
        };
        assert_verdict_shape(stderr, "was rolled back");
        assert!(
            stderr.contains("could not apply") && stderr.contains("CONFLICT (content)"),
            "{stderr}"
        );
        assert!(!stderr.contains("git rebase --continue"), "{stderr}");
        assert_eq!(rev(&repo, "HEAD").await, orig);
        assert_eq!(read_head_name(&repo).await.unwrap(), expected.head_name);
        let git_dir = git_dir_of(&repo).await;
        assert!(!git_dir.join("sequencer").exists(), "no sequencer left");
        assert!(!git_dir.join("CHERRY_PICK_HEAD").exists());
        assert!(!rebasing(&repo).await, "the rollback leaves no rebase");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A group whose leader's change is already present (re-adding what a dropped
    /// revert removed) still applies: the leader is staged, never picked.
    #[tokio::test]
    async fn a_fold_group_whose_leader_is_already_applied_still_applies() {
        let (dir, repo) = setup_repo("empty-leader").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "x.txt", "X\n", "A add X").await;
        let a = rev(&repo, "HEAD").await;
        git(&repo, &["rm", "-q", "x.txt"]).await;
        git(&repo, &["commit", "-m", "B revert"]).await;
        let b = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "x.txt", "X\n", "C re-add X").await;
        let c = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "d.txt", "d\n", "D add d").await;
        let d = rev(&repo, "HEAD").await;

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[
                pick(&a),
                RewriteStep {
                    hashes: vec![c, d],
                    message: None,
                    edit: false,
                },
            ],
            &[b],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["C re-add X", "A add X", "base"]);
        let changed = git(&repo, &["show", "--name-only", "--format=", "HEAD"]).await;
        assert_eq!(changed.trim(), "d.txt", "the group carries D's change");
        assert!(!rebasing(&repo).await, "nothing is in progress");
    }

    /// A group far past the length an inline exec line survives applies as one
    /// commit (git's `sh -c` cuts an exec line at ~8 KiB on Windows).
    #[tokio::test]
    async fn a_120_commit_fold_group_applies_as_one_commit() {
        const N: usize = 120;
        let (_dir, repo) = setup_repo("long-group").await;
        let base = rev(&repo, "HEAD").await;
        let mut stream = String::new();
        for i in 1..=N {
            let msg = format!("c{i}\n");
            let content = format!("{i}\n");
            let from = if i == 1 {
                base.clone()
            } else {
                format!(":{}", i - 1)
            };
            stream.push_str(&format!(
                "commit refs/heads/long\nmark :{i}\nauthor A <a@a> 1700000000 +0000\n\
                 committer t <t@t> 1700000000 +0000\ndata {}\n{msg}from {from}\n\
                 M 100644 inline f{i}.txt\ndata {}\n{content}\n",
                msg.len(),
                content.len()
            ));
        }
        let out = run_git_raw_input(
            Some(&repo),
            &["fast-import", "--quiet"],
            Some(&stream),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(out.code, 0, "fast-import: {}", out.full_failure_text());
        git(&repo, &["reset", "-q", "--hard", "long"]).await;
        let chain: Vec<String> = git(&repo, &["rev-list", "--reverse", &format!("{base}..HEAD")])
            .await
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(chain.len(), N);

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: chain,
                message: None,
                edit: false,
            }],
            &[],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["c1", "base"]);
        let files = git(&repo, &["show", "--name-only", "--format=", "HEAD"]).await;
        assert_eq!(
            files.lines().count(),
            N,
            "every fold's change is in the commit"
        );
    }

    /// A fold group's one commit runs the commit hooks once, with the whole group
    /// staged.
    #[tokio::test]
    async fn a_fold_group_commits_once_through_the_hooks() {
        let (dir, repo) = setup_repo("group-hooks").await;
        let base = rev(&repo, "HEAD").await;
        let mut group = Vec::new();
        for (file, msg) in [("1.txt", "one"), ("2.txt", "two"), ("3.txt", "three")] {
            commit_file(&repo, dir.path(), file, "x\n", msg).await;
            group.push(rev(&repo, "HEAD").await);
        }
        write_hook(
            &repo,
            "pre-commit",
            "echo $(git diff --cached --name-only) >> \"$(git rev-parse --git-dir)/pre-commit-log\"",
        );
        write_hook(
            &repo,
            "commit-msg",
            "echo ran >> \"$(git rev-parse --git-dir)/commit-msg-log\"",
        );

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: group,
                message: None,
                edit: false,
            }],
            &[],
        )
        .await
        .unwrap();
        let git_dir = git_dir_of(&repo).await;
        let log = |name: &str| std::fs::read_to_string(git_dir.join(name)).unwrap_or_default();
        assert_eq!(log("pre-commit-log"), "1.txt 2.txt 3.txt\n");
        assert_eq!(log("commit-msg-log"), "ran\n");
        assert_eq!(subjects(&repo).await, vec!["one", "base"]);
    }

    /// Installs a post-rewrite hook that logs its argument and stdin to
    /// `.git/post-rewrite-log`.
    fn log_post_rewrite(repo: &str) {
        write_hook(
            repo,
            "post-rewrite",
            "log=\"$(git rev-parse --git-dir)/post-rewrite-log\"\necho \"post-rewrite $1\" >> \"$log\"\ncat >> \"$log\"",
        );
    }

    /// A group's members reach git's rewrite mappings: their notes are copied to the
    /// squashed commit, and post-rewrite sees every member beside the plain picks.
    #[tokio::test]
    async fn a_fold_group_maps_its_members_for_notes_and_post_rewrite() {
        let (dir, repo) = setup_repo("group-mappings").await;
        git(&repo, &["config", "notes.rewriteRef", "refs/notes/commits"]).await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "1.txt", "1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "2.txt", "2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "3.txt", "3\n", "three").await;
        let c3 = rev(&repo, "HEAD").await;
        git(&repo, &["notes", "add", "-m", "note-two", &c2]).await;
        git(&repo, &["notes", "add", "-m", "note-three", &c3]).await;
        log_post_rewrite(&repo);

        // Reordered so the pick is rewritten too.
        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[
                RewriteStep {
                    hashes: vec![c2.clone(), c3.clone()],
                    message: None,
                    edit: false,
                },
                pick(&c1),
            ],
            &[],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);
        let squashed = rev(&repo, "HEAD~1").await;
        let notes = git(&repo, &["notes", "show", &squashed]).await;
        assert!(
            notes.contains("note-two") && notes.contains("note-three"),
            "both members' notes reach the squashed commit: {notes}"
        );
        let log = std::fs::read_to_string(git_dir_of(&repo).await.join("post-rewrite-log"))
            .expect("post-rewrite ran");
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.first(), Some(&"post-rewrite rebase"), "{log}");
        for member in [&c2, &c3] {
            assert!(
                lines.contains(&format!("{member} {squashed}").as_str()),
                "post-rewrite maps {member}: {log}"
            );
        }
        let picked = rev(&repo, "HEAD").await;
        assert!(lines.contains(&format!("{c1} {picked}").as_str()), "{log}");
    }

    /// A plan of only fold groups (no pick for git to map) still fires post-rewrite.
    #[tokio::test]
    async fn an_all_group_plan_fires_post_rewrite() {
        let (dir, repo) = setup_repo("all-group-post-rewrite").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "1.txt", "1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "2.txt", "2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        log_post_rewrite(&repo);

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1.clone(), c2.clone()],
                message: Some("combined".into()),
                edit: false,
            }],
            &[],
        )
        .await
        .unwrap();
        let squashed = rev(&repo, "HEAD").await;
        let log = std::fs::read_to_string(git_dir_of(&repo).await.join("post-rewrite-log"))
            .expect("post-rewrite ran");
        assert_eq!(
            log,
            format!("post-rewrite rebase\n{c1} {squashed}\n{c2} {squashed}\n")
        );
    }

    /// A group holding only gitlink bumps commits under `.gitmodules` `ignore = all`,
    /// which hides them from a plain `diff --cached --quiet`.
    #[tokio::test]
    async fn a_gitlink_only_group_applies_under_submodule_ignore_all() {
        let (dir, repo) = setup_repo("gitlink-group").await;
        std::fs::write(
            dir.path().join(".gitmodules"),
            "[submodule \"sub\"]\n\tpath = sub\n\turl = ./nowhere\n\tignore = all\n",
        )
        .unwrap();
        git(&repo, &["add", ".gitmodules"]).await;
        let gitlink = |sha: &str| format!("160000,{},sub", sha.repeat(40));
        git(
            &repo,
            &["update-index", "--add", "--cacheinfo", &gitlink("1")],
        )
        .await;
        git(&repo, &["commit", "-m", "add sub"]).await;
        let base = rev(&repo, "HEAD").await;
        let mut bumps = Vec::new();
        for (sha, msg) in [("2", "bump one"), ("3", "bump two")] {
            git(&repo, &["update-index", "--cacheinfo", &gitlink(sha)]).await;
            git(&repo, &["commit", "-m", msg]).await;
            bumps.push(rev(&repo, "HEAD").await);
        }

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: bumps,
                message: None,
                edit: false,
            }],
            &[],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["bump one", "add sub", "base"]);
        let tree = git(&repo, &["ls-tree", "HEAD", "sub"]).await;
        assert!(
            tree.contains(&"3".repeat(40)),
            "the group's last bump: {tree}"
        );
    }

    /// A message group keeps its leader's exact author date at the edges git's other
    /// date forms break on: before 1973 (raw seconds), from 2100 on (ISO 8601), and
    /// the first hours of 1970 at a negative offset.
    #[tokio::test]
    async fn a_message_group_keeps_its_leaders_author_date_at_the_edges() {
        for (i, when) in [
            "@45815400 +0530",   // 1971-06-15T12:00:00+05:30
            "@4102444800 +0000", // 2100-01-01T00:00:00Z
            "@0 -0500",          // 1969-12-31T19:00:00-05:00
        ]
        .into_iter()
        .enumerate()
        {
            let (dir, repo) = setup_repo(&format!("edge-date-{i}")).await;
            let base = rev(&repo, "HEAD").await;
            std::fs::write(dir.path().join("1.txt"), "1\n").unwrap();
            git(&repo, &["add", "."]).await;
            // Through the env in git's raw form, the only one that sets all three:
            // `--date` refuses the pre-epoch one and ISO 8601 refuses 2100.
            let out = run_git_raw_env(
                Some(&repo),
                &["commit", "-m", "old"],
                &[("GIT_AUTHOR_DATE", when)],
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(out.code, 0, "{when}: {}", out.full_failure_text());
            let leader = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "2.txt", "2\n", "new").await;
            let fold = rev(&repo, "HEAD").await;
            let date = |r: &str| {
                let repo = repo.clone();
                let r = r.to_string();
                async move { git(&repo, &["log", "-1", "--date=raw", "--format=%ad", &r]).await }
            };
            let before = date(&leader).await;

            let state = AppState::default();
            rewrite_commits(
                &state,
                &repo,
                &base,
                &[RewriteStep {
                    hashes: vec![leader, fold],
                    message: Some("combined".into()),
                    edit: false,
                }],
                &[],
            )
            .await
            .unwrap_or_else(|e| panic!("{when}: {e}"));
            assert_eq!(subjects(&repo).await, vec!["combined", "base"], "{when}");
            assert_eq!(date("HEAD").await, before, "{when}");
        }
    }

    /// Installs a post-rewrite hook that logs its argument and stdin, and turns on
    /// notes rewriting; returns the log's path.
    async fn track_rewrites(repo: &str) -> std::path::PathBuf {
        git(repo, &["config", "notes.rewriteRef", "refs/notes/commits"]).await;
        log_post_rewrite(repo);
        git_dir_of(repo).await.join("post-rewrite-log")
    }

    /// A replay reword sends its commit's note and post-rewrite mapping to the FINAL
    /// reworded commit, whether its pick fast-forwards or not.
    #[tokio::test]
    async fn a_replay_reword_maps_its_commit_to_the_final_one() {
        for fast_forward in [true, false] {
            let (dir, repo) = setup_repo(&format!("reword-mapping-{fast_forward}")).await;
            let base = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "1.txt", "1\n", "one").await;
            let c1 = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "2.txt", "2\n", "two").await;
            let x = rev(&repo, "HEAD").await;
            git(&repo, &["notes", "add", "-m", "note-x", &x]).await;
            let log = track_rewrites(&repo).await;
            let reword = RewriteStep {
                hashes: vec![x.clone()],
                message: Some("reworded".into()),
                edit: false,
            };
            // Fast-forward: every pick replays onto its own parent. Otherwise "one" is
            // dropped, so "two" is picked onto a new parent.
            let (steps, dropped) = if fast_forward {
                (vec![pick(&c1), reword], vec![])
            } else {
                (vec![reword], vec![c1.clone()])
            };
            let state = AppState::default();
            rewrite_commits(&state, &repo, &base, &steps, &dropped)
                .await
                .unwrap();
            let head = rev(&repo, "HEAD").await;
            assert_eq!(
                subjects(&repo).await.first().map(String::as_str),
                Some("reworded")
            );
            assert_eq!(
                git(&repo, &["notes", "show", "HEAD"]).await.trim(),
                "note-x",
                "ff={fast_forward}: the note follows to the final commit"
            );
            let log = std::fs::read_to_string(&log).expect("post-rewrite ran");
            assert!(log.starts_with("post-rewrite rebase\n"), "{log}");
            let mapped: Vec<&str> = log
                .lines()
                .filter_map(|l| l.strip_prefix(&format!("{x} ")))
                .collect();
            assert_eq!(mapped, vec![head.as_str()], "ff={fast_forward}: {log}");
            let amend_events = log
                .lines()
                .filter(|l| l.starts_with("post-rewrite amend"))
                .count();
            assert_eq!(amend_events, 0, "{log}");
        }
    }

    /// A conflict ON the `edit` line hands off to the banner like any conflict, and
    /// never reads as a paused edit: git writes no `amend` there, before or after the
    /// conflict is resolved.
    #[tokio::test]
    async fn a_conflict_on_the_edit_line_is_not_a_paused_edit() {
        let (dir, repo) = setup_repo("edit-line-conflict").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let step = RewriteStep {
            hashes: vec![c2],
            message: None,
            edit: true,
        };
        // "two"'s patch (v1→v2) can't apply onto v0 once "one" is dropped.
        git_rebase_edit(repo.clone(), base, vec![step], Some(vec![c1]))
            .await
            .unwrap();
        assert!(rebasing(&repo).await, "left for the banner");
        assert!(!git(&repo, &["ls-files", "-u"]).await.trim().is_empty());
        assert!(!op_state(&repo).await.unwrap().edit_paused, "conflicted");

        std::fs::write(dir.path().join("a.txt"), "resolved\n").unwrap();
        git(&repo, &["add", "a.txt"]).await;
        assert!(git(&repo, &["ls-files", "-u"]).await.trim().is_empty());
        assert!(!op_state(&repo).await.unwrap().edit_paused, "resolved");
    }

    /// Reword keeps each commit's author and author date, and a squash its leader's;
    /// the committer is whoever ran the rewrite. Both routes.
    #[tokio::test]
    async fn rewrites_keep_each_commits_author_and_date() {
        for replay in [true, false] {
            let (dir, repo) = setup_repo(&format!("author-date-{replay}")).await;
            let base = rev(&repo, "HEAD").await;
            let mut commits = Vec::new();
            for (name, author, date) in [
                ("one", "Auth A <a@example.com>", "2001-01-01T00:00:00Z"),
                ("two", "Auth B <b@example.com>", "2002-02-02T00:00:00Z"),
                ("three", "Auth C <c@example.com>", "2003-03-03T00:00:00Z"),
            ] {
                std::fs::write(dir.path().join(format!("{name}.txt")), "x\n").unwrap();
                git(&repo, &["add", "."]).await;
                git(
                    &repo,
                    &["commit", "--author", author, "--date", date, "-m", name],
                )
                .await;
                commits.push(rev(&repo, "HEAD").await);
            }
            let identity = |r: String| {
                let repo = repo.clone();
                async move { git(&repo, &["log", "-1", "--format=%an|%aI", &r]).await }
            };
            let leader = identity(commits[0].clone()).await;
            let reworded = identity(commits[2].clone()).await;
            let plan = vec![
                RewriteStep {
                    hashes: vec![commits[0].clone(), commits[1].clone()],
                    message: Some("combined".into()),
                    edit: false,
                },
                RewriteStep {
                    hashes: vec![commits[2].clone()],
                    message: Some("reworded".into()),
                    edit: false,
                },
            ];
            if replay {
                let state = AppState::default();
                rewrite_commits(&state, &repo, &base, &plan, &[])
                    .await
                    .unwrap();
            } else {
                git_rebase_edit(repo.clone(), base, plan, None)
                    .await
                    .unwrap();
            }
            assert_eq!(subjects(&repo).await, vec!["reworded", "combined", "base"]);
            assert_eq!(identity("HEAD".into()).await, reworded, "replay={replay}");
            assert_eq!(identity("HEAD~1".into()).await, leader, "replay={replay}");
            assert_eq!(
                git(&repo, &["log", "-2", "--format=%cn"]).await,
                "t\nt\n",
                "the committer is the current user"
            );
        }
    }

    /// The rollback must run for every failure class, not just a conflict, and it
    /// says so: a killed continue is rolled back under the same verdict line.
    #[tokio::test]
    async fn rewrite_rolls_back_when_a_step_fails_non_git() {
        let (dir, repo) = setup_repo("rewrite-nongit").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();

        let state = AppState::default();
        // A zero budget fails the continue without running it, so the rebase sits at
        // its leading `break` and the engine sees AppError::Timeout — the non-Git arm.
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c1)],
            &[],
            NO_BUDGET,
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Err(AppError::Command(msg)) => {
                assert_verdict_shape(&msg, "was rolled back");
                assert!(msg.contains("timed out"), "the cause rides below: {msg}");
            }
            Ok(()) => panic!("the killed continue must fail"),
            Err(e) => panic!("expected the non-Git rolled-back arm, got {e:?}"),
        }
        assert_eq!(
            rev(&repo, "HEAD").await,
            orig,
            "a killed step must leave the branch at its pre-run tip"
        );
        assert!(!rebasing(&repo).await, "the rollback leaves no rebase");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// When the abort itself fails the rebase is left in progress, so the error has
    /// to name the pre-run tip and the abort as the remedy — and the branch REF is
    /// still safe, since git moves it only when the rebase finishes.
    #[tokio::test]
    async fn rewrite_failed_rollback_names_the_pre_run_tip_and_remedies() {
        let (dir, repo) = setup_repo("rewrite-rollback-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = c2.clone();
        let branch_ref = read_head_name(&repo).await.unwrap();

        let state = AppState::default();
        // "two"'s patch (v1→v2) can't apply onto v0 — a real conflict — while the zero
        // abort budget fails `rebase --abort` without running it.
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c2), pick(&c1)],
            &[],
            DEFAULT_TIMEOUT,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Git { stderr, .. }) => {
                assert_verdict_shape(&stderr, "rollback also failed");
                assert!(
                    stderr.contains(&orig),
                    "must name the pre-run tip: {stderr}"
                );
                assert!(
                    stderr.contains(
                        "Fix what git reports below, then run git rebase --abort to restore it."
                    ),
                    "must name the abort as the remedy: {stderr}"
                );
                assert!(!stderr.contains("reset --hard"), "never a reset: {stderr}");
                // The rebase is still alive, so git's hints stay; only progress goes.
                assert!(stderr.contains("\nhint: "), "{stderr}");
                assert!(!stderr.contains("Rebasing ("), "{stderr}");
                // The abort's own report says what blocked it, ahead of the conflict.
                let abort_report = stderr
                    .find(&AppError::Timeout(0).to_string())
                    .unwrap_or_else(|| panic!("the abort's own report rides along: {stderr}"));
                let conflict = stderr
                    .find("CONFLICT (content): Merge conflict in a.txt")
                    .unwrap_or_else(|| panic!("git's report rides below: {stderr}"));
                assert!(
                    abort_report < conflict,
                    "the abort's report leads: {stderr}"
                );
            }
            Ok(()) => panic!("the conflicting rewrite must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        assert!(rebasing(&repo).await, "the abort never ran");
        assert_eq!(
            rev(&repo, &branch_ref).await,
            orig,
            "the branch ref stays at the pre-run tip mid-rebase"
        );
    }

    /// A rewrite whose rebase can't even start never touched the branch, so its
    /// error leads with the start failure and claims no rollback at all.
    #[tokio::test]
    async fn rewrite_start_failure_leaves_the_branch_untouched() {
        let (dir, repo) = setup_repo("rewrite-start-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();
        let branch = head_branch(&repo).await;

        // A held index.lock fails the rebase start before it writes any state, while
        // the read-only guards above still pass (the runner runs git with
        // GIT_OPTIONAL_LOCKS=0).
        let lock = std::path::Path::new(&repo).join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let state = AppState::default();
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c1)], &[]).await;
        // Released before the assertions so a failure can't leave the fixture
        // locked for teardown.
        std::fs::remove_file(&lock).unwrap();

        match result {
            Err(AppError::Git { stderr, .. }) => {
                assert_eq!(
                    stderr.lines().next(),
                    Some("Couldn't start the rebase."),
                    "the start failure leads: {stderr}"
                );
                for literal in [
                    "was rolled back",
                    "rollback also failed",
                    "rollback restored",
                ] {
                    assert!(!stderr.contains(literal), "no rollback claim: {stderr}");
                }
            }
            Ok(()) => panic!("the locked start must fail"),
            Err(e) => panic!("expected a Git error, got {e:?}"),
        }
        // Deterministic: no git process ever got the lock, so nothing can have moved.
        assert_eq!(
            rev(&repo, "HEAD").await,
            orig,
            "the failed start must leave the branch exactly where it was"
        );
        assert!(!rebasing(&repo).await, "no rebase was left behind");
        assert_eq!(head_branch(&repo).await, branch, "HEAD stays on the branch");
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    /// A non-Git failure whose abort also fails can't pass through untouched — the
    /// remedy would be lost with it.
    #[tokio::test]
    async fn rewrite_non_git_failure_with_failed_rollback_still_names_the_remedies() {
        let (dir, repo) = setup_repo("rewrite-nongit-rollback-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let orig = c1.clone();
        let branch_ref = read_head_name(&repo).await.unwrap();

        let state = AppState::default();
        match rewrite_commits_with_timeouts(
            &state,
            &repo,
            &base,
            &[pick(&c1)],
            &[],
            NO_BUDGET,
            NO_BUDGET,
        )
        .await
        {
            Err(AppError::Command(msg)) => {
                assert_verdict_shape(&msg, "rollback also failed");
                assert!(msg.contains(&orig), "must name the pre-run tip: {msg}");
                assert!(
                    msg.contains(
                        "Fix what git reports below, then run git rebase --abort to restore it."
                    ),
                    "must name the abort as the remedy: {msg}"
                );
            }
            Ok(()) => panic!("the killed continue must fail"),
            Err(e) => panic!("expected the collapsed Command arm, got {e:?}"),
        }
        // Both budgets refuse before spawning, so the rebase deterministically sits at
        // its `break` with the branch ref untouched.
        assert!(rebasing(&repo).await, "the abort never ran");
        assert_eq!(rev(&repo, &branch_ref).await, orig);
    }

    /// A rewrite that rolls back must not take a concurrent in-app commit down with
    /// it. The second task waits until the rewrite observably holds the repo lock, then
    /// commits the way every other mutating command does; tokio's fair mutex queues it
    /// behind the whole compound. Multi-threaded flavor deliberately: the concurrent
    /// task must run in parallel instead of starving on a current-thread runtime.
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_commit_survives_a_rolled_back_rewrite() {
        let (dir, repo) = setup_repo("interleave").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
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
        // SECOND pick conflicts and the rewrite rolls back. "two" is declared
        // dropped, as the coverage check refuses an undeclared omission.
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c1), pick(&c3)], &[c2]).await;
        // The rollback verdict, not just any error: a refusal before the first
        // mutation would let the concurrent commit land without testing anything.
        match result {
            Err(AppError::Git { ref stderr, .. }) => {
                assert_verdict_shape(stderr, "was rolled back");
                assert!(
                    stderr.contains("your branch is unchanged"),
                    "a completed rollback must say so: {stderr}"
                );
            }
            other => panic!("the second pick must conflict and roll back, got {other:?}"),
        }
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

    const UNCOVERED_REFUSAL: &str =
        "the branch changed after this plan was made, so nothing was rewritten — start over";

    /// Two unpushed commits the plan knows about, then a third landed from outside
    /// the app after the plan was made. Returns (dir, repo, base, c1, c2, c3).
    async fn plan_with_an_outside_commit(
        marker: &str,
    ) -> (tempfile::TempDir, String, String, String, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        std::fs::write(dir.path().join("d.txt"), "d\n").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "outside"]).await;
        let c3 = rev(&repo, "HEAD").await;
        (dir, repo, base, c1, c2, c3)
    }

    #[tokio::test]
    async fn rewrite_refuses_uncovered_commits() {
        let (_dir, repo, base, c1, c2, c3) = plan_with_an_outside_commit("uncovered").await;
        let state = AppState::default();
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c1), pick(&c2)], &[]).await;
        let Err(AppError::InvalidArgument(msg)) = &result else {
            panic!("an uncovered commit must refuse, got {result:?}");
        };
        assert_eq!(msg, UNCOVERED_REFUSAL);
        assert_eq!(rev(&repo, "HEAD").await, c3, "the branch must be untouched");
        assert_eq!(subjects(&repo).await, vec!["outside", "two", "one", "base"]);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");
    }

    #[tokio::test]
    async fn rewrite_allows_explicit_drops() {
        let (dir, repo) = setup_repo("explicit-drop").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        rewrite_commits(&state, &repo, &base, &[pick(&c2)], &[c1])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["two", "base"]);
        assert!(
            !dir.path().join("b.txt").exists(),
            "the dropped commit's file is gone"
        );
    }

    #[tokio::test]
    async fn rewrite_refuses_an_out_of_range_dropped_hash() {
        let (dir, repo) = setup_repo("drop-out-of-range").await;
        let below = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "mid").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        let result = rewrite_commits(
            &state,
            &repo,
            &base,
            &[pick(&c1)],
            std::slice::from_ref(&below),
        )
        .await;
        let Err(AppError::InvalidArgument(msg)) = &result else {
            panic!("an out-of-range drop must refuse, got {result:?}");
        };
        assert_eq!(msg, UNCOVERED_REFUSAL);
        assert_eq!(rev(&repo, "HEAD").await, c1);
    }

    #[tokio::test]
    async fn rewrite_refuses_a_hash_listed_twice() {
        let (dir, repo) = setup_repo("listed-twice").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let twice = |h: &str| format!("{h} is listed more than once in the rewrite plan");

        let state = AppState::default();
        // Across the two lists: a step hash also declared dropped.
        let across = rewrite_commits(
            &state,
            &repo,
            &base,
            &[pick(&c1), pick(&c2)],
            std::slice::from_ref(&c1),
        )
        .await;
        assert!(
            matches!(&across, Err(AppError::InvalidArgument(m)) if *m == twice(&c1)),
            "{across:?}"
        );
        // Within the steps: one commit replayed twice.
        let in_steps = rewrite_commits(
            &state,
            &repo,
            &base,
            &[pick(&c1), pick(&c2), pick(&c1)],
            &[],
        )
        .await;
        assert!(
            matches!(&in_steps, Err(AppError::InvalidArgument(m)) if *m == twice(&c1)),
            "{in_steps:?}"
        );
        // Within the drops.
        let in_dropped = rewrite_commits(
            &state,
            &repo,
            &base,
            &[pick(&c2)],
            &[c1.clone(), c1.clone()],
        )
        .await;
        assert!(
            matches!(&in_dropped, Err(AppError::InvalidArgument(m)) if *m == twice(&c1)),
            "{in_dropped:?}"
        );
        assert_eq!(rev(&repo, "HEAD").await, c2, "the branch must be untouched");
        assert_eq!(subjects(&repo).await, vec!["two", "one", "base"]);
    }

    #[tokio::test]
    async fn rebase_edit_refuses_uncovered_commits() {
        let (_dir, repo, base, c1, c2, c3) = plan_with_an_outside_commit("rebase-uncovered").await;
        let result = git_rebase_edit(repo.clone(), base, vec![pick(&c1), pick(&c2)], None).await;
        let Err(AppError::InvalidArgument(msg)) = &result else {
            panic!("an uncovered commit must refuse, got {result:?}");
        };
        assert_eq!(msg, UNCOVERED_REFUSAL);
        assert_rebase_edit_untouched(&repo, &c3).await;
    }

    #[tokio::test]
    async fn rebase_edit_allows_explicit_drops() {
        let (dir, repo) = setup_repo("rebase-explicit-drop").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        git_rebase_edit(repo.clone(), base, vec![pick(&c2)], Some(vec![c1]))
            .await
            .unwrap();
        assert!(!git_path_exists(&repo, "rebase-merge").await);
        assert!(!git_path_exists(&repo, "rebase-apply").await);
        assert_eq!(subjects(&repo).await, vec!["two", "base"]);
    }

    /// Under `rebase.missingCommitsCheck=error` git refuses a todo that only OMITS
    /// a commit and stops the rebase with HEAD at `base` — the drop must be written.
    #[tokio::test]
    async fn rebase_edit_drops_explicitly_under_missing_commits_check() {
        let (dir, repo) = setup_repo("rebase-missing-check").await;
        git(&repo, &["config", "rebase.missingCommitsCheck", "error"]).await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let step = RewriteStep {
            hashes: vec![c2],
            message: None,
            edit: true,
        };
        git_rebase_edit(repo.clone(), base, vec![step], Some(vec![c1]))
            .await
            .unwrap();
        // Paused at the edit with the drop applied, not stopped on the todo.
        assert!(git_path_exists(&repo, "rebase-merge").await);
        assert_eq!(subjects(&repo).await, vec!["two", "base"]);
        let resumed = run_git_raw(
            Some(&repo),
            &["-c", "core.editor=true", "rebase", "--continue"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(
            resumed.code, 0,
            "the rebase must finish: {}",
            resumed.stderr
        );
        assert!(!git_path_exists(&repo, "rebase-merge").await);
        assert_eq!(subjects(&repo).await, vec!["two", "base"]);
    }

    /// git's undo idiom after a rewrite, `git reset --hard ORIG_HEAD`, must land on
    /// the tip the rewrite started from, as it does after `git rebase`.
    #[tokio::test]
    async fn rewrite_leaves_orig_head_at_the_original_tip() {
        let (dir, repo) = setup_repo("rewrite-orig-head").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        rewrite_commits(&state, &repo, &base, &[pick(&orig), pick(&c1)], &[])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);
        assert_eq!(rev(&repo, "ORIG_HEAD").await, orig);

        // Group commits and reword amends leave ORIG_HEAD alone too.
        commit_file(&repo, dir.path(), "d.txt", "d\n", "three").await;
        let tip = rev(&repo, "HEAD").await;
        let below = rev(&repo, "HEAD~1").await;
        let bottom = rev(&repo, "HEAD~2").await;
        let plan = [
            RewriteStep {
                hashes: vec![bottom.clone(), below.clone()],
                message: Some("squashed".into()),
                edit: false,
            },
            RewriteStep {
                hashes: vec![tip.clone()],
                message: Some("reworded".into()),
                edit: false,
            },
        ];
        rewrite_commits(&state, &repo, &base, &plan, &[])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["reworded", "squashed", "base"]);
        assert_eq!(rev(&repo, "ORIG_HEAD").await, tip);

        // A message-less group commits with `-C`, which leaves it alone as well.
        let tip = rev(&repo, "HEAD").await;
        let below = rev(&repo, "HEAD~1").await;
        let plan = [RewriteStep {
            hashes: vec![below, tip.clone()],
            message: None,
            edit: false,
        }];
        rewrite_commits(&state, &repo, &base, &plan, &[])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["squashed", "base"]);
        assert_eq!(rev(&repo, "ORIG_HEAD").await, tip);
    }

    #[test]
    fn missing_commits_stop_needs_gits_two_line_report() {
        let stop = "Warning: some commits may have been dropped accidentally.\nDropped commits (newer to older):\n - 5abc123 # two\n";
        assert!(is_missing_commits_stop(stop));
        assert!(is_missing_commits_stop(&stop.replace('\n', "\r\n")));
        // A conflicting pick names its commit's subject on one line, whatever it says.
        let conflict = "error: could not apply 5abc123... some commits may have been dropped accidentally.\nhint: Resolve all conflicts manually, mark them as resolved with\n";
        assert!(!is_missing_commits_stop(conflict));
    }

    /// A todo that omits an in-range commit stops on git's own missing-commits check
    /// at the start, and the shared starter aborts it and refuses.
    #[tokio::test]
    async fn rebase_edit_start_refuses_a_commit_missing_from_its_todo() {
        let (dir, repo) = setup_repo("rebase-start-stale").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let todo_path = write_test_todo(&repo, "stale-todo", &format!("break\npick {c1}\n"));
        let expected = plan_start(&repo).await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        assert!(
            matches!(&started, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
            "{started:?}"
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(
            rev(&repo, "HEAD").await,
            tip,
            "HEAD back at the original tip"
        );
        assert_eq!(
            read_head_name(&repo).await.unwrap(),
            expected.head_name,
            "HEAD is attached to the branch"
        );
        assert_eq!(subjects(&repo).await, vec!["two", "one", "base"]);
    }

    /// The real race: the plan was read at `tip`, then an outside commit landed
    /// before the rebase started. git stops on it, and the abort leaves the branch
    /// AT the new commit.
    #[tokio::test]
    async fn rebase_edit_start_aborts_cleanly_past_an_outside_commit() {
        let (dir, repo) = setup_repo("rebase-start-outside").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let todo_path = write_test_todo(
            &repo,
            "covering-todo",
            &format!("break\npick {c1}\npick {tip}\n"),
        );
        let expected = plan_start(&repo).await;
        commit_file(&repo, dir.path(), "d.txt", "d\n", "outside").await;
        let outside = rev(&repo, "HEAD").await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        assert!(
            matches!(&started, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
            "{started:?}"
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(
            rev(&repo, "HEAD").await,
            outside,
            "the branch keeps the new commit"
        );
        assert_eq!(
            read_head_name(&repo).await.unwrap(),
            expected.head_name,
            "HEAD is attached to the branch"
        );
        assert!(dir.path().join("d.txt").exists(), "its file is intact");
        assert_eq!(subjects(&repo).await, vec!["outside", "two", "one", "base"]);
    }

    /// HEAD's tip and branch as an entry point reads them.
    async fn plan_start(repo: &str) -> PlanStart {
        PlanStart {
            tip: rev(repo, "HEAD").await,
            head_name: read_head_name(repo).await.unwrap(),
        }
    }

    /// Writes a hand-made todo inside .git (keeping the worktree clean) and returns
    /// its shell path.
    fn write_test_todo(repo: &str, name: &str, todo: &str) -> String {
        let path = std::path::Path::new(repo).join(".git").join(name);
        std::fs::write(&path, todo).unwrap();
        shell_path(&path)
    }

    /// The shared starter with the production editor pins for `todo_path`.
    async fn start_with_todo(
        repo: &str,
        base: &str,
        expected: &PlanStart,
        todo_path: &str,
    ) -> AppResult<()> {
        let envs = rebase_editor_env(todo_path);
        let envs: Vec<(&str, &str)> = envs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let git_dir = git_dir_of(repo).await;
        start_planned_rebase(
            repo,
            &git_dir,
            base,
            expected,
            &envs,
            DEFAULT_TIMEOUT,
            DEFAULT_TIMEOUT,
        )
        .await
    }

    /// The todo the replay route writes for `steps`, saved where the starter reads it.
    async fn replay_todo(repo: &str, steps: &[RewriteStep]) -> String {
        let (_, todo_path) =
            write_rebase_todo(&git_dir_of(repo).await, TodoRoute::Replay, steps, &[])
                .await
                .unwrap();
        todo_path
    }

    /// The repo's own git dir, which the engine's probes read under.
    async fn git_dir_of(repo: &str) -> std::path::PathBuf {
        absolute_git_dir(repo).await.unwrap()
    }

    async fn rebasing(repo: &str) -> bool {
        rebase_in_progress(&git_dir_of(repo).await)
    }

    /// The start record's raw bytes, to prove a rebase that isn't ours is untouched.
    async fn start_record_bytes(repo: &str) -> (Vec<u8>, Vec<u8>) {
        let dir = git_dir_of(repo).await.join("rebase-merge");
        (
            std::fs::read(dir.join("orig-head")).unwrap(),
            std::fs::read(dir.join("head-name")).unwrap(),
        )
    }

    /// Pauses a rebase of `base..HEAD` at a leading `break`, the way another tool
    /// (or a user) would, outside the engine.
    async fn pause_foreign_rebase(repo: &str, base: &str) {
        let todo = write_test_todo(repo, "foreign-todo", "break\n");
        let editor = format!("cp '{todo}'");
        let out = run_git_raw_env(
            Some(repo),
            &["-c", "core.editor=true", "rebase", "-i", base],
            &[
                ("GIT_SEQUENCE_EDITOR", editor.as_str()),
                ("GIT_EDITOR", "true"),
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(out.code, 0, "the foreign rebase must pause: {}", out.stderr);
        assert!(rebasing(repo).await);
    }

    /// Arm 1: a rebase that isn't ours is left exactly as it was.
    #[tokio::test]
    async fn start_leaves_a_foreign_rebase_alone() {
        let (dir, repo) = setup_repo("start-foreign").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;
        let todo_path = replay_todo(&repo, &[pick(&c1), pick(&c2)]).await;
        pause_foreign_rebase(&repo, &base).await;
        let before = start_record_bytes(&repo).await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        let Err(AppError::Git { stderr, .. }) = &started else {
            panic!("a foreign rebase must refuse the start, got {started:?}");
        };
        assert_eq!(stderr.lines().next(), Some("Couldn't start the rebase."));
        assert!(
            rebasing(&repo).await,
            "the foreign rebase is still in progress"
        );
        assert_eq!(
            start_record_bytes(&repo).await,
            before,
            "and its record untouched"
        );
    }

    /// Arm 2, abort leg: a start git refuses partway (an invalid todo line, measured
    /// on git 2.51.1: exit 1, state left, HEAD detached at `base`) is ours to clear.
    #[tokio::test]
    async fn start_clears_its_own_rebase_left_detached_by_a_failed_start() {
        let (dir, repo) = setup_repo("start-invalid-line").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let branch = head_branch(&repo).await;
        let expected = plan_start(&repo).await;
        let todo_path = write_test_todo(
            &repo,
            "invalid-todo",
            &format!(
                "break\npick {c1}\npick {tip}\npick 0123456789abcdef0123456789abcdef01234567\n"
            ),
        );

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        let Err(AppError::Git { stderr, .. }) = &started else {
            panic!("a failed start must report, got {started:?}");
        };
        assert_eq!(stderr.lines().next(), Some("Couldn't start the rebase."));
        assert!(!rebasing(&repo).await, "our own rebase is cleared");
        assert_eq!(
            head_branch(&repo).await,
            branch,
            "HEAD is back on the branch"
        );
        assert_eq!(rev(&repo, "HEAD").await, tip);
        // The abort leg, read off HEAD's reflog: git started detached at `base`, and
        // the abort returned HEAD to the branch.
        let reflog = git(&repo, &["reflog", "-2", "--format=%gs", "HEAD"]).await;
        assert_eq!(
            reflog.lines().collect::<Vec<_>>(),
            vec![
                format!("rebase (abort): returning to {}", expected.head_name),
                format!("rebase (start): checkout {base}"),
            ],
            "{reflog}"
        );
    }

    /// Arm 2, quit and not-ours legs, on a paused rebase whose HEAD was checked back
    /// out to the branch (git allows it; measured, git 2.51.1).
    #[tokio::test]
    async fn clear_failed_start_quits_its_own_rebase_on_the_branch_only() {
        let (dir, repo) = setup_repo("clear-quit").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let branch = head_branch(&repo).await;
        let expected = plan_start(&repo).await;
        pause_foreign_rebase(&repo, &base).await;
        git(&repo, &["checkout", &branch]).await;
        let git_dir = git_dir_of(&repo).await;
        let failure = || RebaseFailure::Other(AppError::Command("start failed".into()));

        // Not ours: a record naming another branch is left alone.
        let other = PlanStart {
            tip: tip.clone(),
            head_name: "refs/heads/other".into(),
        };
        let before = start_record_bytes(&repo).await;
        let refused = clear_failed_start(&repo, &git_dir, &other, failure()).await;
        let Err(AppError::Command(msg)) = &refused else {
            panic!("expected the start failure, got {refused:?}");
        };
        assert_eq!(msg.lines().next(), Some("Couldn't start the rebase."));
        assert!(rebasing(&repo).await, "a rebase that isn't ours stays");
        assert_eq!(start_record_bytes(&repo).await, before);

        // Ours, on the branch: `--quit` drops the state and leaves HEAD alone.
        let cleared = clear_failed_start(&repo, &git_dir, &expected, failure()).await;
        let Err(AppError::Command(msg)) = &cleared else {
            panic!("expected the start failure, got {cleared:?}");
        };
        assert_eq!(msg.lines().next(), Some("Couldn't start the rebase."));
        assert!(!rebasing(&repo).await, "--quit cleared our rebase");
        assert_eq!(head_branch(&repo).await, branch);
        assert_eq!(rev(&repo, "HEAD").await, tip);
        // The quit leg ran, not an abort (which writes its own HEAD reflog entry).
        let reflog = git(&repo, &["reflog", "--format=%gs", "HEAD"]).await;
        assert!(
            !reflog.lines().any(|l| l.starts_with("rebase (abort)")),
            "{reflog}"
        );
    }

    /// A start that never spawned (a zero budget refuses first) reports itself and
    /// leaves nothing behind.
    #[tokio::test]
    async fn a_start_that_never_ran_reports_the_start_failure() {
        let (dir, repo) = setup_repo("start-timeout").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;
        let todo_path = replay_todo(&repo, &[pick(&c1)]).await;
        let envs = rebase_editor_env(&todo_path);
        let envs: Vec<(&str, &str)> = envs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let git_dir = git_dir_of(&repo).await;

        let started = start_planned_rebase(
            &repo,
            &git_dir,
            &base,
            &expected,
            &envs,
            NO_BUDGET,
            DEFAULT_TIMEOUT,
        )
        .await;
        let Err(AppError::Command(msg)) = &started else {
            panic!("a start that never ran must report, got {started:?}");
        };
        assert_eq!(msg.lines().next(), Some("Couldn't start the rebase."));
        assert!(!rebasing(&repo).await);
        assert_eq!(rev(&repo, "HEAD").await, c1);
    }

    /// Both entries refuse a plan the branch moved past before the call — an amended
    /// tip or a reset to an ancestor — with the one neutral refusal, untouched.
    #[tokio::test]
    async fn both_entries_refuse_a_plan_the_branch_moved_past() {
        for amend in [true, false] {
            for replay in [true, false] {
                let marker = format!("moved-past-{amend}-{replay}");
                let (dir, repo) = setup_repo(&marker).await;
                let base = rev(&repo, "HEAD").await;
                commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
                let c1 = rev(&repo, "HEAD").await;
                commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
                let c2 = rev(&repo, "HEAD").await;
                if amend {
                    git(&repo, &["commit", "--amend", "-m", "two amended"]).await;
                } else {
                    git(&repo, &["reset", "--hard", &c1]).await;
                }
                let moved = rev(&repo, "HEAD").await;
                let log = subjects(&repo).await;

                let plan = vec![pick(&c2), pick(&c1)];
                let result = if replay {
                    let state = AppState::default();
                    rewrite_commits(&state, &repo, &base, &plan, &[]).await
                } else {
                    git_rebase_edit(repo.clone(), base.clone(), plan, None).await
                };
                assert!(
                    matches!(&result, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
                    "amend={amend} replay={replay}: {result:?}"
                );
                assert_eq!(rev(&repo, "HEAD").await, moved, "nothing was rewritten");
                assert_eq!(subjects(&repo).await, log);
                assert!(!rebasing(&repo).await, "nothing is in progress");
            }
        }
    }

    #[test]
    fn rollback_reports_drop_rebase_progress_and_hints() {
        // A real 2.51.1 conflict stop from the pinned continue, as `full_failure_text`
        // joins it (stderr, then stdout).
        let report = "Rebasing (2/3)\rerror: could not apply 328946b... two\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: \"git add/rm <conflicted_files>\", then run \"git rebase --continue\".\nhint: You can instead skip this commit: run \"git rebase --skip\".\nhint: To abort and get back to the state before \"git rebase\", run \"git rebase --abort\".\nhint: Disable this message with \"git config set advice.mergeConflict false\"\nCould not apply 328946b...\nAuto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt";
        assert_eq!(
            strip_rebase_noise(report),
            "error: could not apply 328946b... two\nCould not apply 328946b...\nAuto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt"
        );
        assert_eq!(strip_rebase_noise("Rebasing (1/2)\rRebasing (2/2)\r\n"), "");
        // Only the exact counter shape is progress.
        assert_eq!(strip_rebase_noise("Rebasing (a/b)"), "Rebasing (a/b)");
        // A reason line stays whatever advice it quotes.
        let reason = "error: could not run \"git rebase --continue\"";
        assert_eq!(strip_rebase_noise(reason), reason);
    }

    /// Real 2.51.1 rollback reports from the replay's pinned continue, joined as
    /// `full_failure_text` joins them (paths and shas shortened): what the rollback
    /// made untrue goes, and every reason line stays. The first cases are captures of
    /// an earlier engine's inline exec chain (`cherry-pick -n … && commit --amend`),
    /// kept as regression pins; the group-script cases capture the current shape.
    #[test]
    fn rollback_reports_drop_gits_continue_advice() {
        let joined = |lines: &[&str]| lines.join("\n");
        let cases = [
            // Earlier engine: an empty amend at the end of an exec chain.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: git cherry-pick -n 72bbd32 && git commit --amend -F '/r/msg-0'",
                    "You asked to amend the most recent commit, but doing so would make",
                    "it empty. You can repeat your command with --allow-empty, or you can",
                    "remove the commit entirely with \"git reset HEAD^\".",
                    "error: cannot rebase: Your index contains uncommitted changes.",
                    "warning: execution failed: git cherry-pick -n 72bbd32 && git commit --amend -F '/r/msg-0'",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                    "interactive rebase in progress; onto 33b1f4a",
                    "Last commands done (4 commands done):",
                    "   drop 72bbd32 ",
                    "   exec git cherry-pick -n 72bbd32 && git commit --amend -F '/r/msg-0'",
                    "  (see more in file .git/rebase-merge/done)",
                    "No commands remaining.",
                    "You are currently rebasing branch 'main' on '33b1f4a'.",
                    "  (all conflicts fixed: run \"git rebase --continue\")",
                    "",
                    "No changes",
                ]),
                joined(&[
                    "You asked to amend the most recent commit, but doing so would make",
                    "it empty.",
                    "warning: execution failed: git cherry-pick -n 72bbd32 && git commit --amend -F '/r/msg-0'",
                ]),
            ),
            // A reason line after the status block ends it and stays.
            (
                joined(&[
                    "error: could not apply 65d8b67... c1 add X",
                    "interactive rebase in progress; onto 33b1f4a",
                    "Next command to do (1 remaining command):",
                    "   pick 3d2f335 two",
                    "  (use \"git rebase --edit-todo\" to view and edit)",
                    "You are currently editing a commit while rebasing branch 'main' on '33b1f4a'.",
                    "nothing to commit, working tree clean",
                    "no changes added to commit (use \"git add\" and/or \"git commit -a\")",
                    "CONFLICT (content): Merge conflict in f",
                    "f: needs merge",
                ]),
                joined(&[
                    "error: could not apply 65d8b67... c1 add X",
                    "CONFLICT (content): Merge conflict in f",
                ]),
            ),
            // Earlier engine: a fold conflicting inside its exec chain.
            (
                joined(&[
                    "Rebasing (2/5)\rRebasing (3/5)\rRebasing (4/5)\rExecuting: git cherry-pick -n 65d8b67 && git commit --amend --no-edit",
                    "error: could not apply 65d8b67... c1 add X",
                    "hint: after resolving the conflicts, mark the corrected paths",
                    "hint: with 'git add <paths>' or 'git rm <paths>'",
                    "hint: Disable this message with \"git config set advice.mergeConflict false\"",
                    "error: cannot rebase: You have unstaged changes.",
                    "error: additionally, your index contains uncommitted changes.",
                    "warning: execution failed: git cherry-pick -n 65d8b67 && git commit --amend --no-edit",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                    "Auto-merging f",
                    "CONFLICT (content): Merge conflict in f",
                    "f: needs merge",
                ]),
                joined(&[
                    "error: could not apply 65d8b67... c1 add X",
                    "warning: execution failed: git cherry-pick -n 65d8b67 && git commit --amend --no-edit",
                    "Auto-merging f",
                    "CONFLICT (content): Merge conflict in f",
                ]),
            ),
            // A commit-msg hook refusing a reword's amend.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: git commit --amend -F '/r/msg-1'",
                    "commit-msg says no",
                    "warning: execution failed: git commit --amend -F '/r/msg-1'",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    "commit-msg says no",
                    "warning: execution failed: git commit --amend -F '/r/msg-1'",
                ]),
            ),
            // A group script refusing its empty net.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: sh '/r/group-0.sh'",
                    EMPTY_GROUP_ERROR,
                    "warning: execution failed: sh '/r/group-0.sh'",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    EMPTY_GROUP_ERROR,
                    "warning: execution failed: sh '/r/group-0.sh'",
                ]),
            ),
            // The same under TERM (git 2.43, Ubuntu 24.04): the `Executing:` echo
            // carries a leading erase-line escape.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\r\r\x1b[KExecuting: sh '/p/.git/gd-rebase-edit/group-0.sh'",
                    EMPTY_GROUP_ERROR,
                    "warning: execution failed: sh '/p/.git/gd-rebase-edit/group-0.sh'",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    EMPTY_GROUP_ERROR,
                    "warning: execution failed: sh '/p/.git/gd-rebase-edit/group-0.sh'",
                ]),
            ),
            // A commit-msg hook refusing a group's commit.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: sh '/r/group-0.sh'",
                    "commit-msg: subject must start with a ticket id",
                    "error: cannot rebase: Your index contains uncommitted changes.",
                    "warning: execution failed: sh '/r/group-0.sh'",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    "commit-msg: subject must start with a ticket id",
                    "warning: execution failed: sh '/r/group-0.sh'",
                ]),
            ),
            // A conflict inside a group script.
            (
                joined(&[
                    "Rebasing (2/5)\rRebasing (3/5)\rRebasing (4/5)\rRebasing (5/5)\rExecuting: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "error: could not apply cd4b95f... two",
                    "hint: after resolving the conflicts, mark the corrected paths",
                    "hint: with 'git add <paths>' or 'git rm <paths>'",
                    "hint: Disable this message with \"git config set advice.mergeConflict false\"",
                    "error: cannot rebase: You have unstaged changes.",
                    "error: additionally, your index contains uncommitted changes.",
                    "warning: execution failed: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                    "Auto-merging a.txt",
                    "CONFLICT (content): Merge conflict in a.txt",
                    "a.txt: needs merge",
                ]),
                joined(&[
                    "error: could not apply cd4b95f... two",
                    "warning: execution failed: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "Auto-merging a.txt",
                    "CONFLICT (content): Merge conflict in a.txt",
                ]),
            ),
            // A group's pre-commit hook printing `git status`, then an INDENTED reason
            // of its own: only git's indented shapes continue the block.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "interactive rebase in progress; onto ce97f06",
                    "Last commands done (4 commands done):",
                    "   drop 9fa6fba ",
                    "   exec sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "  (see more in file .git/rebase-merge/done)",
                    "No commands remaining.",
                    "You are currently rebasing branch 'main' on 'ce97f06'.",
                    "  (all conflicts fixed: run \"git rebase --continue\")",
                    "",
                    "Changes to be committed:",
                    "  (use \"git restore --staged <file>...\" to unstage)",
                    "\tnew file:   x.txt",
                    "\tnew file:   y.txt",
                    "",
                    "  \u{2716} eslint found 3 problems",
                    "error: cannot rebase: Your index contains uncommitted changes.",
                    "warning: execution failed: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    "  \u{2716} eslint found 3 problems",
                    "warning: execution failed: sh '/r/.git/gd-rebase-edit/group-0.sh'",
                ]),
            ),
            // Earlier engine: an exec that committed, then left the tree dirty (a
            // pre-commit hook that edits a file): the commit's summary and git's
            // dirty-tree advice go.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: git cherry-pick -n ffa6155 && git commit --amend --no-edit",
                    "error: cannot rebase: You have unstaged changes.",
                    "warning: execution succeeded: git cherry-pick -n ffa6155 && git commit --amend --no-edit",
                    "but left changes to the index and/or the working tree.",
                    "Commit or stash your changes, and then run",
                    "",
                    "  git rebase --continue",
                    "[detached HEAD b0ebea1] one",
                    " Date: Sat Oct 17 13:52:18 2026 -0400",
                    " 2 files changed, 2 insertions(+)",
                    " create mode 100644 b.txt",
                    " create mode 100644 c.txt",
                ]),
                joined(&[
                    "warning: execution succeeded: git cherry-pick -n ffa6155 && git commit --amend --no-edit",
                ]),
            ),
            // Every line shape of a commit's summary (git 2.51.1 `commit` output).
            (
                joined(&[
                    "[detached HEAD 425de84] c1 add X",
                    " Author: Author A <A@x>",
                    " Date: Fri Jan 1 10:00:00 2021 +0200",
                    " 1 file changed, 1 insertion(+)",
                    " create mode 100644 x.txt",
                    " delete mode 100644 y.txt",
                    " rename a.txt => b.txt (100%)",
                    " copy c.txt => d.txt (100%)",
                    " mode change 100644 => 100755 run.sh",
                    "warning: execution succeeded: sh '/r/group-0.sh'",
                ]),
                joined(&["warning: execution succeeded: sh '/r/group-0.sh'"]),
            ),
            // Earlier engine: a hook that prints `git status` before its own
            // unindented reason.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: git cherry-pick -n 8794a9d && git commit --amend --no-edit",
                    "interactive rebase in progress; onto c1aea54",
                    "Last commands done (4 commands done):",
                    "   drop 8794a9d ",
                    "   exec git cherry-pick -n 8794a9d && git commit --amend --no-edit",
                    "  (see more in file .git/rebase-merge/done)",
                    "No commands remaining.",
                    "You are currently rebasing branch 'main' on 'c1aea54'.",
                    "  (all conflicts fixed: run \"git rebase --continue\")",
                    "",
                    "Changes to be committed:",
                    "  (use \"git restore --staged <file>...\" to unstage)",
                    "\tnew file:   c.txt",
                    "",
                    "lint failed: c.txt has trailing whitespace",
                    "error: cannot rebase: Your index contains uncommitted changes.",
                    "warning: execution failed: git cherry-pick -n 8794a9d && git commit --amend --no-edit",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    "lint failed: c.txt has trailing whitespace",
                    "warning: execution failed: git cherry-pick -n 8794a9d && git commit --amend --no-edit",
                ]),
            ),
            // git 2.34.1 (Ubuntu 22.04): an exec that failed, then one that succeeded,
            // each leaving the tree dirty; this git prints the continuations without
            // their period.
            (
                joined(&[
                    "Rebasing (2/3)\rRebasing (3/3)\r\r\x1b[KExecuting: sh -c 'echo x >> b.txt; exit 1'",
                    "error: cannot rebase: You have unstaged changes.",
                    "warning: execution failed: sh -c 'echo x >> b.txt; exit 1'",
                    "and made changes to the index and/or the working tree",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&["warning: execution failed: sh -c 'echo x >> b.txt; exit 1'"]),
            ),
            (
                joined(&[
                    "Rebasing (2/3)\rRebasing (3/3)\r\r\x1b[KExecuting: sh -c 'echo x >> b.txt'",
                    "error: cannot rebase: You have unstaged changes.",
                    "warning: execution succeeded: sh -c 'echo x >> b.txt'",
                    "but left changes to the index and/or the working tree",
                    "Commit or stash your changes, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&["warning: execution succeeded: sh -c 'echo x >> b.txt'"]),
            ),
            // A group's hook printing `git status` under status.showUntrackedFiles=no,
            // then its own reason.
            (
                joined(&[
                    "Rebasing (2/4)\rRebasing (3/4)\rRebasing (4/4)\rExecuting: sh '/r/group-0.sh'",
                    "interactive rebase in progress; onto cda714e",
                    "Last commands done (4 commands done):",
                    "   drop 0ab37aa ",
                    "   exec sh '/r/group-0.sh'",
                    "  (see more in file .git/rebase-merge/done)",
                    "No commands remaining.",
                    "You are currently rebasing branch 'main' on 'cda714e'.",
                    "  (all conflicts fixed: run \"git rebase --continue\")",
                    "",
                    "Changes to be committed:",
                    "  (use \"git restore --staged <file>...\" to unstage)",
                    "\tnew file:   1.txt",
                    "\tnew file:   2.txt",
                    "",
                    "Untracked files not listed (use -u option to show untracked files)",
                    "Ignored files:",
                    "lint: 2 files need formatting",
                    "error: cannot rebase: Your index contains uncommitted changes.",
                    "warning: execution failed: sh '/r/group-0.sh'",
                    "and made changes to the index and/or the working tree.",
                    "You can fix the problem, and then run",
                    "",
                    "  git rebase --continue",
                ]),
                joined(&[
                    "lint: 2 files need formatting",
                    "warning: execution failed: sh '/r/group-0.sh'",
                ]),
            ),
        ];
        for (report, kept) in cases {
            assert_eq!(strip_rebase_noise(&report), kept);
        }
    }

    /// A rebase left in progress keeps git's hints and advice, which stay true; only
    /// the progress counters (and a leading erase-line escape) go.
    #[test]
    fn live_rebase_reports_drop_only_progress() {
        let report = "Rebasing (2/3)\r\r\x1b[KExecuting: sh '/r/group-0.sh'\nerror: could not apply 328946b... two\nhint: Resolve all conflicts manually, mark them as resolved with\nYou can fix the problem, and then run\n\n  git rebase --continue";
        assert_eq!(
            strip_rebase_progress(report),
            "\nExecuting: sh '/r/group-0.sh'\nerror: could not apply 328946b... two\nhint: Resolve all conflicts manually, mark them as resolved with\nYou can fix the problem, and then run\n\n  git rebase --continue"
        );
    }

    /// Installs a hook script (`#!/bin/sh` + `body`).
    fn write_hook(repo: &str, name: &str, body: &str) {
        let hooks = std::path::Path::new(repo).join(".git/hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// Commits a file under an author other than the repo's configured user.
    async fn commit_file_by(repo: &str, dir: &std::path::Path, file: &str, msg: &str) {
        std::fs::write(dir.join(file), format!("{file}\n")).unwrap();
        git(repo, &["add", "."]).await;
        git(
            repo,
            &[
                "commit",
                "--author",
                "Orig Author <orig@example.com>",
                "-m",
                msg,
            ],
        )
        .await;
    }

    /// Under `rebase.updateRefs=true` a branch pointing into the range stays where it
    /// was. This pins the outcome: our replaced todo has no update-ref lines, so the
    /// start's `-c rebase.updateRefs=false` is defense in depth.
    #[tokio::test]
    async fn rewrite_leaves_a_branch_inside_the_range_alone_under_update_refs() {
        let (dir, repo) = setup_repo("update-refs").await;
        git(&repo, &["config", "rebase.updateRefs", "true"]).await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        git(&repo, &["branch", "mid"]).await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // A reorder changes every oid; an identity replay would reproduce them and
        // prove nothing.
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)], &[])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);
        assert_eq!(rev(&repo, "mid").await, c1, "the inner branch stays put");
    }

    /// A reset to an ancestor trips neither git check (our todo is a superset of
    /// git's own); only the start-tip gate catches it, before any commit comes back.
    #[tokio::test]
    async fn start_refuses_a_branch_reset_to_an_ancestor() {
        let (dir, repo) = setup_repo("start-ancestor").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "resurrect me").await;
        let c2 = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;
        let todo_path = replay_todo(&repo, &[pick(&c1), pick(&c2)]).await;
        git(&repo, &["reset", "--hard", &c1]).await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        assert!(
            matches!(&started, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
            "{started:?}"
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(rev(&repo, "HEAD").await, c1, "HEAD stays at the ancestor");
        assert_eq!(
            read_head_name(&repo).await.unwrap(),
            expected.head_name,
            "HEAD is attached to the branch"
        );
        assert_eq!(subjects(&repo).await, vec!["one", "base"]);
    }

    /// An outside amend of the tip trips git's missing-commits stop; the abort puts
    /// the branch back on the AMENDED tip and the start refuses as stale.
    #[tokio::test]
    async fn start_refuses_an_amended_tip() {
        let (dir, repo) = setup_repo("start-amend").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;
        let todo_path = replay_todo(&repo, &[pick(&c1), pick(&c2)]).await;
        git(&repo, &["commit", "--amend", "-m", "two amended"]).await;
        let amended = rev(&repo, "HEAD").await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        assert!(
            matches!(&started, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
            "{started:?}"
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(
            rev(&repo, "HEAD").await,
            amended,
            "the amended tip is restored"
        );
        assert_eq!(
            read_head_name(&repo).await.unwrap(),
            expected.head_name,
            "HEAD is attached to the branch"
        );
    }

    /// Arm 3 with a failed abort: the body names the tip the abort would restore,
    /// the rebase's recorded orig-head (the AMENDED tip), never the plan's.
    #[tokio::test]
    async fn a_failed_abort_after_an_outside_amend_names_the_amended_tip() {
        let (dir, repo) = setup_repo("start-amend-abort-fail").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;
        let todo_path = replay_todo(&repo, &[pick(&c1), pick(&c2)]).await;
        git(&repo, &["commit", "--amend", "-m", "two amended"]).await;
        let amended = rev(&repo, "HEAD").await;
        let envs = rebase_editor_env(&todo_path);
        let envs: Vec<(&str, &str)> = envs.iter().map(|(k, v)| (*k, v.as_str())).collect();

        let started = start_planned_rebase(
            &repo,
            &git_dir_of(&repo).await,
            &base,
            &expected,
            &envs,
            DEFAULT_TIMEOUT,
            NO_BUDGET,
        )
        .await;
        let Err(AppError::Git { stderr, .. }) = &started else {
            panic!("a failed abort must report, got {started:?}");
        };
        assert_verdict_shape(stderr, "rollback also failed");
        assert!(
            stderr.contains(&format!("its tip before this run was {amended}.")),
            "names the recorded tip: {stderr}"
        );
        assert!(
            !stderr.contains(&expected.tip),
            "never the plan's: {stderr}"
        );
        assert!(rebasing(&repo).await, "the abort never ran");
    }

    /// A branch switch to a same-tip ref passes the tip comparison but not the branch
    /// one: the start refuses and nothing is rewritten.
    #[tokio::test]
    async fn start_refuses_a_different_branch_at_the_same_tip() {
        let (dir, repo) = setup_repo("start-head-name").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let branch = head_branch(&repo).await;
        git(&repo, &["branch", "other"]).await;
        let expected = PlanStart {
            tip: c2.clone(),
            head_name: "refs/heads/other".into(),
        };
        let todo_path = replay_todo(&repo, &[pick(&c2), pick(&c1)]).await;

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        assert!(
            matches!(&started, Err(AppError::InvalidArgument(m)) if m == UNCOVERED_REFUSAL),
            "{started:?}"
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(rev(&repo, "HEAD").await, c2);
        assert_eq!(head_branch(&repo).await, branch);
        assert_eq!(subjects(&repo).await, vec!["two", "one", "base"]);
    }

    /// The replay refuses over a paused op with the edit path's own message, before
    /// it clears the shared scratch dir.
    #[tokio::test]
    async fn rewrite_refuses_a_concurrent_op() {
        let (dir, repo) = setup_repo("rewrite-reentry").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "x.txt", "x\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        std::fs::create_dir_all(std::path::Path::new(&repo).join(".git/rebase-merge")).unwrap();

        let state = AppState::default();
        let refused = rewrite_commits(&state, &repo, &base, &[pick(&c1)], &[]).await;
        let Err(AppError::InvalidArgument(msg)) = &refused else {
            panic!("the replay must refuse over a paused op, got {refused:?}");
        };
        assert_eq!(msg, MID_OP_REFUSAL);
        assert!(
            !std::path::Path::new(&repo)
                .join(".git/gd-rebase-edit")
                .exists(),
            "scratch dir must not be touched when refused"
        );
    }

    /// With the rebase's start record gone, git can't abort the rebase either
    /// (measured, git 2.51.1: `--abort` exits 1, "could not read
    /// '.git/rebase-merge/head'"), so the gate reports a failed rollback with the
    /// remedy that works there, and the branch ref is still at the plan's tip.
    #[tokio::test]
    async fn start_gate_with_an_unreadable_record_reports_a_failed_rollback() {
        let (dir, repo) = setup_repo("start-unreadable").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let branch_ref = read_head_name(&repo).await.unwrap();
        let expected = plan_start(&repo).await;
        let todo_path = write_test_todo(
            &repo,
            "unreadable-todo",
            &format!(
                "exec rm -f \"$(git rev-parse --git-path rebase-merge/orig-head)\"\nbreak\npick {c1}\npick {tip}\n"
            ),
        );

        let started = start_with_todo(&repo, &base, &expected, &todo_path).await;
        let Err(AppError::Command(msg)) = &started else {
            panic!("an unreadable record must refuse, got {started:?}");
        };
        assert_verdict_shape(msg, "rollback also failed");
        assert!(
            msg.contains(&format!("the plan was read at {tip}.")),
            "names the plan's tip: {msg}"
        );
        let branch = branch_ref.trim_start_matches("refs/heads/");
        assert!(
            msg.contains(&format!(
                "Run git rebase --quit, then check out {branch} again."
            )),
            "advises the remedy that works without the record: {msg}"
        );
        assert!(!msg.contains("git rebase --abort to restore"), "{msg}");
        assert_eq!(rev(&repo, &branch_ref).await, tip);
    }

    /// `--no-verify` on the rebase: a refusing pre-rebase hook blocks neither path.
    #[tokio::test]
    async fn a_refusing_pre_rebase_hook_blocks_neither_path() {
        let (dir, repo) = setup_repo("pre-rebase").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        write_hook(&repo, "pre-rebase", "exit 1");

        // Negative control: without the flag the hook refuses the rebase.
        let plain = run_git_raw(
            Some(&repo),
            &[
                "-c",
                "core.editor=true",
                "-c",
                "sequence.editor=true",
                "rebase",
                "-i",
                &c1,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(plain.code, 0, "the hook must refuse a plain rebase");
        assert!(
            plain.stderr.contains("pre-rebase hook refused"),
            "{}",
            plain.stderr
        );
        assert!(!rebasing(&repo).await);

        let state = AppState::default();
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)], &[])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);

        let tip = rev(&repo, "HEAD").await;
        let below = rev(&repo, "HEAD~1").await;
        let step = RewriteStep {
            hashes: vec![tip.clone()],
            message: None,
            edit: true,
        };
        git_rebase_edit(repo.clone(), base, vec![pick(&below), step], None)
            .await
            .unwrap();
        assert!(rebasing(&repo).await, "paused at the edit");
    }

    /// The replay's group commits run the commit hooks (a squash's `-F` commit and a
    /// message-less fixup's `-C` commit) and keep the leader's author; the edit path's
    /// amend and fixups run none.
    #[tokio::test]
    async fn replay_commits_run_commit_hooks_and_the_edit_path_skips_them() {
        let hook = "echo 'Hooked: yes' >> \"$1\"";
        let marker = "touch \"$(git rev-parse --git-dir)/pre-commit-ran\"";
        let plan = |c: &[String]| {
            vec![
                RewriteStep {
                    hashes: vec![c[0].clone(), c[1].clone()],
                    message: Some("combined".into()),
                    edit: false,
                },
                RewriteStep {
                    hashes: vec![c[2].clone(), c[3].clone()],
                    message: None,
                    edit: false,
                },
            ]
        };

        // A space in the repo path exercises every quoted path the todo carries.
        let (dir, repo) = setup_repo("hooks replay").await;
        let base = rev(&repo, "HEAD").await;
        let mut commits = Vec::new();
        for (file, msg) in [
            ("1.txt", "one"),
            ("2.txt", "two"),
            ("3.txt", "three"),
            ("4.txt", "four"),
        ] {
            commit_file_by(&repo, dir.path(), file, msg).await;
            commits.push(rev(&repo, "HEAD").await);
        }
        write_hook(&repo, "commit-msg", hook);
        write_hook(&repo, "pre-commit", marker);
        let state = AppState::default();
        rewrite_commits(&state, &repo, &base, &plan(&commits), &[])
            .await
            .unwrap();
        let log = git(&repo, &["log", "-2", "--format=%an|%B%x00"]).await;
        let entries: Vec<&str> = log
            .split('\0')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .collect();
        assert_eq!(entries.len(), 2, "{log}");
        for entry in &entries {
            assert!(
                entry.starts_with("Orig Author|"),
                "the leader's author stays: {entry}"
            );
            assert!(entry.contains("Hooked: yes"), "commit-msg ran: {entry}");
        }
        assert!(
            entries[0].contains("three"),
            "the fixup keeps its leader's message: {log}"
        );
        assert!(entries[1].contains("combined"), "{log}");
        assert!(std::path::Path::new(&repo)
            .join(".git/pre-commit-ran")
            .exists());

        let (dir, repo) = setup_repo("hooks edit").await;
        let base = rev(&repo, "HEAD").await;
        let mut commits = Vec::new();
        for (file, msg) in [
            ("1.txt", "one"),
            ("2.txt", "two"),
            ("3.txt", "three"),
            ("4.txt", "four"),
        ] {
            commit_file_by(&repo, dir.path(), file, msg).await;
            commits.push(rev(&repo, "HEAD").await);
        }
        write_hook(&repo, "commit-msg", hook);
        write_hook(&repo, "pre-commit", marker);
        git_rebase_edit(repo.clone(), base, plan(&commits), None)
            .await
            .unwrap();
        assert!(!rebasing(&repo).await, "a plan with no edit runs through");
        let log = git(&repo, &["log", "-2", "--format=%B"]).await;
        assert!(
            !log.contains("Hooked: yes"),
            "the edit path runs no commit hooks: {log}"
        );
        assert!(!std::path::Path::new(&repo)
            .join(".git/pre-commit-ran")
            .exists());
    }

    /// The edit path still pauses at an `edit` after the start-tip gate's continue.
    #[tokio::test]
    async fn rebase_edit_pauses_at_its_edit_after_the_gate() {
        let (dir, repo) = setup_repo("rebase-edit-pause").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let step = RewriteStep {
            hashes: vec![c2.clone()],
            message: None,
            edit: true,
        };
        git_rebase_edit(repo.clone(), base, vec![pick(&c1), step], None)
            .await
            .unwrap();
        assert!(rebasing(&repo).await);
        assert_eq!(rev(&repo, "HEAD").await, c2, "stopped at the edit commit");
        assert!(
            op_state(&repo).await.unwrap().edit_paused,
            "the banner reads a real edit stop as one"
        );
    }

    #[test]
    fn the_replay_route_never_writes_an_edit_stop() {
        let step = RewriteStep {
            hashes: vec!["aaaa".into()],
            message: None,
            edit: true,
        };
        let dir = std::path::Path::new("scratch");
        let (replay, _) = rebase_todo(
            TodoRoute::Replay,
            std::slice::from_ref(&step),
            &[],
            dir,
            "git",
        );
        assert_eq!(replay, "break\npick aaaa\n");
        let (edit, _) = rebase_todo(TodoRoute::Edit, &[step], &[], dir, "git");
        assert_eq!(edit, "break\nedit aaaa\n");
    }

    #[test]
    fn rebase_paths_are_single_quoted_for_the_shell() {
        assert_eq!(sh_quote("C:/repo/.git/todo"), "'C:/repo/.git/todo'");
        assert_eq!(sh_quote("dir with space/todo x"), "'dir with space/todo x'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");

        let step = RewriteStep {
            hashes: vec!["aaaa".into()],
            message: Some("reworded".into()),
            edit: false,
        };
        let dir = std::path::Path::new("C:/it's dir");
        let (todo, files) = rebase_todo(
            TodoRoute::Replay,
            &[step],
            &[],
            dir,
            "C:/Program Files/Git/cmd/git.exe",
        );
        assert_eq!(
            todo,
            "break\npick aaaa\nexec sh 'C:/it'\\''s dir/reword-0.sh'\n"
        );
        assert_eq!(files.len(), 2);
        let script = files
            .iter()
            .find(|(path, _)| shell_path(path).ends_with("reword-0.sh"))
            .map(|(_, content)| content.as_str())
            .unwrap();
        assert!(
            script.contains(
                "'C:/Program Files/Git/cmd/git.exe' commit --amend --no-post-rewrite -F 'C:/it'\\''s dir/msg-0'\n"
            ),
            "{script}"
        );
        assert!(files.iter().any(|(_, content)| content == "reworded"));
        let env = rebase_editor_env("C:/it's dir/todo");
        assert_eq!(env[0].1, r"cp 'C:/it'\''s dir/todo'");
    }

    /// Arm 4: a start that never ran our todo (its `break` never paused) completes on
    /// git's own todo — reported as nothing rewritten, with the branch where it was.
    #[tokio::test]
    async fn start_that_never_used_our_todo_reports_nothing_rewritten() {
        let (dir, repo) = setup_repo("start-unused-todo").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let tip = rev(&repo, "HEAD").await;
        let expected = plan_start(&repo).await;

        let envs = [("GIT_SEQUENCE_EDITOR", "true"), ("GIT_EDITOR", "true")];
        let git_dir = git_dir_of(&repo).await;
        let started = start_planned_rebase(
            &repo,
            &git_dir,
            &base,
            &expected,
            &envs,
            DEFAULT_TIMEOUT,
            DEFAULT_TIMEOUT,
        )
        .await;
        let Err(AppError::Command(msg)) = &started else {
            panic!("an unused todo must be reported, got {started:?}");
        };
        assert_eq!(
            msg.lines().next(),
            Some("The rewrite plan was not applied, so nothing was rewritten as planned.")
        );
        assert!(!rebasing(&repo).await);
        assert_eq!(rev(&repo, "HEAD").await, tip);
    }

    /// Only the start copies the plan's todo in; the continue's sequence editor is a
    /// no-op, so a nested interactive rebase can't pick the todo up.
    #[test]
    fn the_editor_env_pins_the_todo_copy_and_a_no_op_editor() {
        let env = rebase_editor_env("C:/repo/.git/gd-rebase-edit/todo");
        assert_eq!(
            env,
            [
                (
                    "GIT_SEQUENCE_EDITOR",
                    "cp 'C:/repo/.git/gd-rebase-edit/todo'".to_string()
                ),
                ("GIT_EDITOR", "true".to_string()),
            ]
        );
        assert_eq!(
            CONTINUE_EDITOR_ENV,
            [("GIT_SEQUENCE_EDITOR", "true"), ("GIT_EDITOR", "true")]
        );
    }

    /// The replay drops a fold group's commits and runs its script (every commit
    /// staged, one commit); the edit route keeps git's own `fixup` lines.
    #[test]
    fn fold_groups_build_one_script_on_replay_and_fixups_on_edit() {
        let steps = [
            RewriteStep {
                hashes: vec!["a1".into(), "a2".into(), "a3".into()],
                message: None,
                edit: false,
            },
            RewriteStep {
                hashes: vec!["b1".into(), "b2".into()],
                message: Some("squashed".into()),
                edit: false,
            },
            RewriteStep {
                hashes: vec!["c1".into()],
                message: None,
                edit: false,
            },
            RewriteStep {
                hashes: vec!["d1".into()],
                message: Some("reworded".into()),
                edit: false,
            },
        ];
        let dir = std::path::Path::new("d");
        let (replay, files) = rebase_todo(TodoRoute::Replay, &steps, &[], dir, "git");
        assert_eq!(
            replay,
            "break\n\
             drop a1\ndrop a2\ndrop a3\n\
             exec sh 'd/group-0.sh'\n\
             drop b1\ndrop b2\n\
             exec sh 'd/group-1.sh'\n\
             pick c1\n\
             pick d1\n\
             exec sh 'd/reword-3.sh'\n"
        );
        let file = |name: &str| {
            files
                .iter()
                .find(|(path, _)| shell_path(path) == name)
                .map(|(_, content)| content.as_str())
                .unwrap_or_else(|| panic!("no {name} in {files:?}"))
        };
        assert_eq!(files.len(), 5, "{files:?}");
        let empty_net = format!(
            "if 'git' diff --cached --quiet --ignore-submodules=none; \
             then echo '{EMPTY_GROUP_ERROR}' >&2; exit 1; fi\n"
        );
        let mappings = |members: &[&str]| {
            let mut lines = String::from(
                "new=$('git' rev-parse HEAD)\n\
                 list=$('git' rev-parse --git-path rebase-merge/rewritten-list)\n",
            );
            for m in members {
                lines.push_str(&format!(
                    "printf '%s %s\\n' \"$('git' rev-parse {m})\" \"$new\" >> \"$list\"\n"
                ));
            }
            lines
        };
        assert_eq!(
            file("d/group-0.sh"),
            format!(
                "set -e\n\
                 'git' cherry-pick -n a1\n\
                 'git' cherry-pick -n a2\n\
                 'git' cherry-pick -n a3\n\
                 {empty_net}\
                 'git' commit -C a1\n\
                 {}",
                mappings(&["a1", "a2", "a3"])
            )
        );
        assert_eq!(
            file("d/group-1.sh"),
            format!(
                "set -e\n\
                 'git' cherry-pick -n b1\n\
                 'git' cherry-pick -n b2\n\
                 {empty_net}\
                 n=$('git' log -1 --no-show-signature --format=%an b1)\n\
                 e=$('git' log -1 --no-show-signature --format=%ae b1)\n\
                 d=$('git' log -1 --no-show-signature --date=raw --format=@%ad b1)\n\
                 GIT_AUTHOR_NAME=\"$n\" GIT_AUTHOR_EMAIL=\"$e\" GIT_AUTHOR_DATE=\"$d\" \
                 'git' commit -F 'd/msg-1'\n\
                 {}",
                mappings(&["b1", "b2"])
            )
        );
        assert_eq!(file("d/msg-1"), "squashed");
        assert_eq!(file("d/msg-3"), "reworded");
        assert_eq!(
            file("d/reword-3.sh"),
            "set -e\n\
             pre=$('git' rev-parse HEAD)\n\
             'git' commit --amend --no-post-rewrite -F 'd/msg-3'\n\
             new=$('git' rev-parse HEAD)\n\
             list=$('git' rev-parse --git-path rebase-merge/rewritten-list)\n\
             if [ -f \"$list\" ]; then sed \"s/ $pre\\$/ $new/\" \"$list\" > \"$list.gd-tmp\" \
             && mv \"$list.gd-tmp\" \"$list\"; fi\n"
        );
        assert!(!files.iter().any(|(_, c)| c.contains('\r')), "LF only");
        let (edit, _) = rebase_todo(TodoRoute::Edit, &steps, &[], dir, "git");
        assert_eq!(
            edit,
            "break\n\
             pick a1\nfixup a2\nfixup a3\n\
             pick b1\nfixup b2\n\
             exec 'git' commit --amend --no-verify -F 'd/msg-1'\n\
             pick c1\n\
             pick d1\n\
             exec 'git' commit --amend --no-verify -F 'd/msg-3'\n"
        );
    }

    /// A path reaches the shell as-is off Windows, where `\` is a filename byte.
    #[test]
    fn shell_paths_swap_separators_on_windows_only() {
        let path = std::path::Path::new(r"bs\dir/todo");
        let expected = if cfg!(windows) {
            "bs/dir/todo"
        } else {
            r"bs\dir/todo"
        };
        assert_eq!(shell_path(path), expected);
    }

    /// A continue that times out on the edit path leaves the rebase for the banner,
    /// but says so instead of reporting a paused edit.
    #[tokio::test]
    async fn rebase_edit_continue_timeout_is_reported_and_left_in_progress() {
        let (dir, repo) = setup_repo("rebase-edit-timeout").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let branch_ref = read_head_name(&repo).await.unwrap();
        let step = RewriteStep {
            hashes: vec![c2.clone()],
            message: None,
            edit: true,
        };
        let result = git_rebase_edit_with_timeout(
            repo.clone(),
            base,
            vec![pick(&c1), step],
            None,
            NO_BUDGET,
        )
        .await;
        let Err(AppError::Command(msg)) = &result else {
            panic!("a timed-out continue must be reported, got {result:?}");
        };
        assert_eq!(
            msg.lines().next(),
            Some(
                "The rebase timed out and was left in progress — continue or abort it from the banner."
            )
        );
        assert!(rebasing(&repo).await, "left for the banner");
        assert_eq!(rev(&repo, &branch_ref).await, c2);
    }

    /// A continue that stops short of the plan's edit is reported, not toasted as a
    /// paused edit, and stays in progress for the banner. Here an index.lock taken at
    /// the start's checkout fails the first line, a pick or the `edit` itself; a
    /// failed `edit` line leaves the same `done` as a real stop, minus its `amend`.
    #[tokio::test]
    async fn rebase_edit_reports_a_stop_short_of_its_edit() {
        for edit_first in [false, true] {
            let (dir, repo) = setup_repo(&format!("rebase-edit-interrupted-{edit_first}")).await;
            let base = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
            let c1 = rev(&repo, "HEAD").await;
            commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
            let c2 = rev(&repo, "HEAD").await;
            let branch_ref = read_head_name(&repo).await.unwrap();
            write_hook(
                &repo,
                "post-checkout",
                "touch \"$(git rev-parse --git-dir)/index.lock\"",
            );
            let edit = |hash: &str| RewriteStep {
                hashes: vec![hash.to_string()],
                message: None,
                edit: true,
            };
            let plan = if edit_first {
                vec![edit(&c1), pick(&c2)]
            } else {
                vec![pick(&c1), edit(&c2)]
            };
            let result = git_rebase_edit(repo.clone(), base, plan, None).await;
            let lock = git_dir_of(&repo).await.join("index.lock");
            let Err(AppError::Git { stderr, .. }) = &result else {
                panic!("edit_first={edit_first}: a stop short of the edit must be reported, got {result:?}");
            };
            assert_eq!(
                stderr.lines().next(),
                Some(
                    "The rebase was interrupted and left in progress — continue or abort it from the banner."
                )
            );
            assert!(
                stderr.contains("index.lock"),
                "git's report rides below: {stderr}"
            );
            assert!(
                !stderr.contains("Rebasing ("),
                "no progress counters: {stderr}"
            );
            assert!(rebasing(&repo).await, "left for the banner");
            assert!(
                !op_state(&repo).await.unwrap().edit_paused,
                "edit_first={edit_first}: the banner doesn't read it as an edit stop"
            );
            assert_eq!(rev(&repo, &branch_ref).await, c2, "the branch is untouched");
            let _ = std::fs::remove_file(lock);
        }
    }

    /// A conflict before the plan's edit is the banner's to resolve: no error.
    #[tokio::test]
    async fn rebase_edit_hands_a_conflict_to_the_banner() {
        let (dir, repo) = setup_repo("rebase-edit-conflict").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let step = RewriteStep {
            hashes: vec![c1],
            message: None,
            edit: true,
        };
        // "two"'s patch (v1→v2) can't apply onto v0.
        git_rebase_edit(repo.clone(), base, vec![pick(&c2), step], None)
            .await
            .unwrap();
        assert!(rebasing(&repo).await, "left for the banner");
        assert!(!git(&repo, &["ls-files", "-u"]).await.trim().is_empty());
    }

    /// A continue that left nothing in progress is read off the branch: moved and
    /// still checked out is done, at the plan's tip is nothing rewritten, and any
    /// other state (or a detached plan) is reported unconfirmed.
    #[tokio::test]
    async fn a_finished_rebase_is_classified_off_the_branch() {
        let (dir, repo) = setup_repo("classify-finished").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let branch_ref = read_head_name(&repo).await.unwrap();
        let plan = |tip: &str, head_name: &str| PlanStart {
            tip: tip.to_string(),
            head_name: head_name.to_string(),
        };
        let verdict = |result: AppResult<()>| match result {
            Err(AppError::Command(msg)) => msg,
            other => panic!("expected a Command verdict, got {other:?}"),
        };

        // Moved off the plan's tip, still on the branch.
        classify_finished_rebase(&repo, &plan(&c1, &branch_ref))
            .await
            .unwrap();
        // At the plan's tip.
        let msg = verdict(classify_finished_rebase(&repo, &plan(&c2, &branch_ref)).await);
        assert_eq!(msg.lines().next(), Some(L_NOREWRITE), "{msg}");

        git(&repo, &["checkout", "--detach"]).await;
        // The branch is no longer checked out.
        let msg = verdict(classify_finished_rebase(&repo, &plan(&c1, &branch_ref)).await);
        assert_eq!(msg.lines().next(), Some(L_UNCONFIRMED), "{msg}");
        assert!(
            msg.contains(&format!("HEAD is on {DETACHED_HEAD_NAME}")),
            "{msg}"
        );
        // A plan made on a detached HEAD.
        let msg = verdict(classify_finished_rebase(&repo, &plan(&c1, DETACHED_HEAD_NAME)).await);
        assert_eq!(msg.lines().next(), Some(L_UNCONFIRMED), "{msg}");
        assert!(msg.contains(&format!("HEAD is at {c2}.")), "{msg}");
    }

    /// The replay's continue budget counts exactly the lines its todo carries: 2 s per
    /// pick or drop, and the per-command budget per exec (a commit plus its hooks).
    #[test]
    fn replay_timeout_counts_the_todo_work_lines() {
        let steps = [
            RewriteStep {
                hashes: vec!["a1".into()],
                message: None,
                edit: false,
            },
            RewriteStep {
                hashes: vec!["b1".into()],
                message: Some("reword".into()),
                edit: false,
            },
            RewriteStep {
                hashes: vec!["c1".into(), "c2".into()],
                message: None,
                edit: false,
            },
            RewriteStep {
                hashes: vec!["d1".into(), "d2".into(), "d3".into()],
                message: Some("squash".into()),
                edit: false,
            },
        ];
        let dropped = ["e1".to_string()];
        let (todo, _) = rebase_todo(
            TodoRoute::Replay,
            &steps,
            &dropped,
            std::path::Path::new("d"),
            "git",
        );
        let count = |verb: &str| todo.lines().filter(|l| l.starts_with(verb)).count() as u32;
        let (picks, drops, execs) = (count("pick "), count("drop "), count("exec "));
        assert_eq!(
            (picks, drops, execs),
            (2, 6, 3),
            "the fixture exercises every line kind: {todo}"
        );
        assert_eq!(
            todo.lines().count() as u32,
            1 + picks + drops + execs,
            "nothing else but the leading break: {todo}"
        );
        assert_eq!(
            replay_timeout(&steps, &dropped),
            DEFAULT_TIMEOUT
                + std::time::Duration::from_secs(2 * u64::from(picks + drops))
                + DEFAULT_TIMEOUT * execs
        );
    }

    #[tokio::test]
    async fn rebase_edit_refuses_an_out_of_range_step_hash() {
        let (dir, repo) = setup_repo("rebase-step-out-of-range").await;
        let below = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "mid").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;

        let result = git_rebase_edit(repo.clone(), base, vec![pick(&below), pick(&c1)], None).await;
        let Err(AppError::InvalidArgument(msg)) = &result else {
            panic!("an out-of-range step must refuse, got {result:?}");
        };
        assert_eq!(msg, UNCOVERED_REFUSAL);
        assert_rebase_edit_untouched(&repo, &c1).await;
    }

    /// A refused edit-rebase started nothing: no rebase, HEAD where it was, and no
    /// scratch dir.
    async fn assert_rebase_edit_untouched(repo: &str, head: &str) {
        assert!(!git_path_exists(repo, "rebase-merge").await);
        assert!(!git_path_exists(repo, "rebase-apply").await);
        assert_eq!(rev(repo, "HEAD").await, head, "HEAD must not move");
        assert!(
            !std::path::Path::new(repo)
                .join(".git/gd-rebase-edit")
                .exists(),
            "scratch dir must not be touched when refused"
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
        let out = cherry_pick_onto(&state, &repo, &[c1, c2], "target", None)
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
        match cherry_pick_onto(&state, &repo, &[c1, c2], "target", None).await {
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
        match cherry_pick_onto(&state, &repo, &[c1], "target", None).await {
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
            cherry_pick_onto(&state, &repo, &[c1], "target", None)
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
        assert!(
            cherry_pick_onto(&state, &repo, std::slice::from_ref(&c1), "target", None)
                .await
                .is_err()
        );
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

        match cherry_pick_onto(&state, &repo, &[c1], "target", None).await {
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
        match cherry_pick_onto(&state, &repo, &[merge_commit], "target", None).await {
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
            None,
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
            None,
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
            None,
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
        let result = git_rebase_edit(repo.clone(), base, vec![step], None).await;
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

    /// The state a user's own multi-commit `cherry-pick -n` leaves when it conflicts:
    /// `.git/sequencer` and NO `CHERRY_PICK_HEAD` (measured, git 2.51.1), which a
    /// marker-file gate reads as "nothing in flight".
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
        let refused = git_rebase_edit(repo.clone(), tip, vec![pick(&f1)], None).await;
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
        let err = git_revert_core(&state, repo.clone(), target, None)
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
        let err = git_cherry_pick_core(&state, repo.clone(), feature, None)
            .await
            .unwrap_err();
        assert_both_streams(&err, "cherry-pick", "could not apply");
    }

    // --- merge commits: the -m parent choice --------------------------------

    /// A two-parent merge whose sides touch different files: the default branch
    /// adds `m.txt`, `side` adds `s.txt`. Returns the merge and its two parents.
    async fn setup_two_parent_merge(marker: &str) -> (tempfile::TempDir, String, [String; 3]) {
        let (dir, repo) = setup_repo(marker).await;
        let main = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "side"]).await;
        commit_file(&repo, dir.path(), "s.txt", "s\n", "side work").await;
        git(&repo, &["switch", &main]).await;
        commit_file(&repo, dir.path(), "m.txt", "m\n", "main work").await;
        git(&repo, &["merge", "--no-ff", "-m", "merge side", "side"]).await;
        let merge = rev(&repo, "HEAD").await;
        let first = rev(&repo, "HEAD^1").await;
        let second = rev(&repo, "HEAD^2").await;
        (dir, repo, [merge, first, second])
    }

    async fn tree(repo: &str, r: &str) -> String {
        rev(repo, &format!("{r}^{{tree}}")).await
    }

    #[tokio::test]
    async fn reverting_a_merge_against_parent_one_restores_the_first_parents_tree() {
        let (_dir, repo, [merge, first, _]) = setup_two_parent_merge("revert-m1").await;
        let state = AppState::default();
        git_revert_core(&state, repo.clone(), merge.clone(), Some(1))
            .await
            .expect("a merge reverts once its mainline is named");
        assert_ne!(
            rev(&repo, "HEAD").await,
            merge,
            "the revert is a new commit"
        );
        assert_eq!(tree(&repo, "HEAD").await, tree(&repo, &first).await);
    }

    #[tokio::test]
    async fn reverting_a_merge_against_parent_two_undoes_the_other_side() {
        let (_dir, repo, [merge, first, second]) = setup_two_parent_merge("revert-m2").await;
        let state = AppState::default();
        git_revert_core(&state, repo.clone(), merge, Some(2))
            .await
            .expect("parent 2 is a valid mainline for a two-parent merge");
        let after = tree(&repo, "HEAD").await;
        assert_ne!(after, tree(&repo, &first).await);
        assert_eq!(after, tree(&repo, &second).await);
    }

    #[tokio::test]
    async fn reverting_an_ordinary_commit_needs_no_mainline() {
        // The commit right after the root, so the revert lands back on the root's tree.
        let (dir, repo) = setup_repo("revert-root-adjacent").await;
        let root = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "after root").await;
        let target = rev(&repo, "HEAD").await;
        let state = AppState::default();
        git_revert_core(&state, repo.clone(), target, None)
            .await
            .expect("an ordinary commit reverts without -m");
        assert_eq!(tree(&repo, "HEAD").await, tree(&repo, &root).await);
    }

    #[tokio::test]
    async fn reverting_a_merge_without_a_mainline_keeps_gits_own_error() {
        let (_dir, repo, [merge, ..]) = setup_two_parent_merge("revert-m-none").await;
        let state = AppState::default();
        match git_revert_core(&state, repo.clone(), merge.clone(), None).await {
            Err(AppError::Git { stderr, .. }) => assert!(
                stderr.contains("is a merge but no -m option was given"),
                "git's reason must reach the caller unchanged: {stderr}"
            ),
            other => panic!("expected git's raw failure, got {other:?}"),
        }
        assert_eq!(rev(&repo, "HEAD").await, merge);
    }

    #[tokio::test]
    async fn a_zero_mainline_is_refused_before_git_runs() {
        let (_dir, repo, [merge, ..]) = setup_two_parent_merge("mainline-zero").await;
        let state = AppState::default();
        let revert = git_revert_core(&state, repo.clone(), merge.clone(), Some(0)).await;
        assert!(
            matches!(revert, Err(AppError::InvalidArgument(_))),
            "got {revert:?}"
        );
        let pick = git_cherry_pick_core(&state, repo.clone(), merge.clone(), Some(0)).await;
        assert!(
            matches!(pick, Err(AppError::InvalidArgument(_))),
            "got {pick:?}"
        );
        assert_eq!(rev(&repo, "HEAD").await, merge, "nothing was written");
    }

    #[tokio::test]
    async fn cherry_picking_a_merge_against_parent_one_brings_the_side_branchs_changes() {
        let (dir, repo, [merge, ..]) = setup_two_parent_merge("pick-m1").await;
        git(&repo, &["switch", "-c", "target", "HEAD~1"]).await;
        let state = AppState::default();
        let created = git_cherry_pick_core(&state, repo.clone(), merge, Some(1))
            .await
            .expect("a merge picks once its mainline is named");
        assert!(created, "the pick records a commit");
        assert!(dir.path().join("s.txt").exists(), "the side's file arrives");
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
    }

    #[tokio::test]
    async fn cherry_picking_a_range_holding_a_merge_refuses_before_anything_moves() {
        let (dir, repo) = setup_repo("pick-range-merge").await;
        let main = head_branch(&repo).await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["switch", "-c", "side"]).await;
        commit_file(&repo, dir.path(), "s.txt", "s\n", "side work").await;
        git(&repo, &["switch", &main]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "before").await;
        git(&repo, &["merge", "--no-ff", "-m", "merge side", "side"]).await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "after").await;
        // `target..main`, oldest-first: the merge sits mid-range, its side commit too.
        let range = git(&repo, &["rev-list", "--reverse", "target..HEAD"]).await;
        let hashes: Vec<String> = range.lines().map(str::to_string).collect();
        assert_eq!(hashes.len(), 4, "side work, before, the merge, after");
        let target_tip = rev(&repo, "target").await;
        let head = rev(&repo, "HEAD").await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &hashes, "target", None).await {
            Err(AppError::InvalidArgument(msg)) => assert_eq!(msg, RANGE_MERGE_REFUSAL),
            Ok(_) => panic!("a range holding a merge must refuse up front"),
            Err(e) => panic!("expected the up-front refusal, got {e:?}"),
        }
        assert_eq!(
            rev(&repo, "target").await,
            target_tip,
            "target is untouched"
        );
        assert_eq!(rev(&repo, "HEAD").await, head);
        assert_eq!(head_branch(&repo).await, main, "the refusal never switched");
    }

    #[tokio::test]
    async fn cherry_picking_a_lone_merge_onto_a_branch_takes_its_mainline() {
        let (_dir, repo, [merge, first, _]) = setup_two_parent_merge("pick-onto-m1").await;
        git(&repo, &["branch", "target", &first]).await;
        let state = AppState::default();
        let out = cherry_pick_onto(
            &state,
            &repo,
            std::slice::from_ref(&merge),
            "target",
            Some(1),
        )
        .await
        .expect("a lone merge picks onto a branch once its mainline is named");
        assert_eq!((out.applied, out.skipped), (1, 0));
        assert_eq!(head_branch(&repo).await, "target");
        // Picked against its first parent onto that same parent, the merge's whole
        // contribution lands: the result matches the merge's own tree.
        assert_eq!(tree(&repo, "target").await, tree(&repo, &merge).await);
        assert!(!op_state(&repo).await.unwrap().cherry_picking);
    }

    #[tokio::test]
    async fn a_mainline_with_more_than_one_commit_is_refused_before_anything_moves() {
        let (dir, repo) = setup_repo("pick-onto-batch-mainline").await;
        let main = head_branch(&repo).await;
        git(&repo, &["branch", "target"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let target_tip = rev(&repo, "target").await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &[c1, c2], "target", Some(1)).await {
            Err(AppError::InvalidArgument(_)) => {}
            Ok(_) => panic!("a batch must never take a mainline"),
            Err(e) => panic!("expected the up-front refusal, got {e:?}"),
        }
        assert_eq!(rev(&repo, "target").await, target_tip);
        assert_eq!(head_branch(&repo).await, main);
    }

    /// `n` empty commits on `branch` from one `git fast-import` run, the commit at
    /// `merge_at` (1-based, above 1) merging a one-commit side branch. Returns the
    /// branch's first-parent chain oldest-first, so the side commit is not in it.
    async fn fast_import_chain(
        repo: &str,
        branch: &str,
        n: usize,
        merge_at: Option<usize>,
    ) -> Vec<String> {
        // The name lands in refs/heads/ templates below — route it through the
        // validator so the fixture stays injection-safe for future callers.
        crate::git::branches::validate_ref_name(branch).expect("fixture branch name");
        // The side commit is minted after commit 1, so a merge can't come sooner.
        if let Some(m) = merge_at {
            assert!((2..=n).contains(&m), "merge_at must be in 2..={n}, got {m}");
        }
        let side = n + 1;
        let mut stream = String::new();
        for i in 1..=n {
            let msg = format!("{branch} {i}\n");
            stream.push_str(&format!(
                "commit refs/heads/{branch}\nmark :{i}\ncommitter t <t@t> 1700000000 +0000\ndata {}\n{msg}",
                msg.len()
            ));
            if i > 1 {
                stream.push_str(&format!("from :{}\n", i - 1));
            }
            if merge_at == Some(i) {
                stream.push_str(&format!("merge :{side}\n"));
            }
            stream.push('\n');
            if i == 1 && merge_at.is_some() {
                let msg = format!("{branch} side\n");
                stream.push_str(&format!(
                    "commit refs/heads/{branch}-side\nmark :{side}\ncommitter t <t@t> 1700000000 +0000\ndata {}\n{msg}from :1\n\n",
                    msg.len()
                ));
            }
        }
        let out = run_git_raw_input(
            Some(repo),
            &["fast-import", "--quiet"],
            Some(&stream),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(out.code, 0, "fast-import: {}", out.full_failure_text());
        let chain = git(repo, &["rev-list", "--reverse", "--first-parent", branch]).await;
        chain.lines().map(str::to_string).collect()
    }

    /// The batch check reads its hashes over stdin, one per line, and `--no-walk`
    /// still holds there: only the listed commits are tested, never their history.
    /// 900 SHAs overflow Windows' 32,767-character command line, so this batch could
    /// not have reached git as argv.
    #[tokio::test]
    async fn the_batch_merge_check_reads_hundreds_of_hashes_over_stdin() {
        let (_dir, repo) = setup_repo("batch-merge-stdin").await;
        let plain = fast_import_chain(&repo, "plain", 900, None).await;
        assert_eq!(plain.len(), 900);
        assert!(
            plain.join(" ").len() > 32_767,
            "the batch must exceed the argv cap"
        );
        assert_eq!(batch_has_merge(&repo, &plain).await, Some(false));

        let merged = fast_import_chain(&repo, "merged", 900, Some(450)).await;
        assert_eq!(batch_has_merge(&repo, &merged).await, Some(true));
        // The commits after the merge descend from it; a walk would find it.
        assert_eq!(batch_has_merge(&repo, &merged[450..]).await, Some(false));
    }

    #[tokio::test]
    async fn a_batch_with_an_unresolvable_hash_keeps_the_rolled_back_verdict() {
        let (dir, repo) = setup_repo("pick-onto-bad-object").await;
        git(&repo, &["branch", "target"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        let bogus = "0123456789abcdef0123456789abcdef01234567".to_string();
        let target_tip = rev(&repo, "target").await;
        let hashes = [c1, bogus];
        assert_eq!(
            batch_has_merge(&repo, &hashes).await,
            None,
            "the check can't say, so the picks decide"
        );

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &hashes, "target", None).await {
            Err(AppError::Git { stderr, .. }) => assert_verdict_shape(&stderr, "was rolled back"),
            Ok(_) => panic!("an unresolvable pick must fail"),
            Err(e) => panic!("expected the rolled-back verdict, got {e:?}"),
        }
        assert_eq!(rev(&repo, "target").await, target_tip);
    }

    #[tokio::test]
    async fn commit_parents_lists_an_octopus_merges_parents_in_order() {
        let (dir, repo) = setup_repo("parents-octopus").await;
        let main = head_branch(&repo).await;
        for (branch, file) in [("one", "1.txt"), ("two", "2.txt")] {
            git(&repo, &["switch", "-c", branch, &main]).await;
            commit_file(&repo, dir.path(), file, "x\n", &format!("{branch} work")).await;
        }
        git(&repo, &["switch", &main]).await;
        commit_file(&repo, dir.path(), "m.txt", "m\n", "main work").await;
        git(&repo, &["merge", "--no-ff", "-m", "octopus", "one", "two"]).await;
        let merge = rev(&repo, "HEAD").await;

        let parents = crate::git::history::git_commit_parents(repo.clone(), merge.clone())
            .await
            .unwrap();
        let got: Vec<(String, String)> = parents.into_iter().map(|p| (p.hash, p.subject)).collect();
        let mut want = Vec::new();
        for (n, subject) in [(1, "main work"), (2, "one work"), (3, "two work")] {
            want.push((
                rev(&repo, &format!("{merge}^{n}")).await,
                subject.to_string(),
            ));
        }
        assert_eq!(got, want);
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

    /// A tag sharing its name with a branch lists under that plain name, which the
    /// delete and push paths then rebuild into `refs/tags/<name>`.
    #[tokio::test]
    async fn list_tags_names_a_tag_shadowed_by_a_branch() {
        let (_dir, repo) = setup_repo("tags-branch-shadow").await;
        git(&repo, &["tag", "release"]).await;
        git(&repo, &["branch", "release"]).await;
        git(&repo, &["tag", "plain"]).await;

        let mut names: Vec<String> = git_list_tags(repo.clone())
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["plain".to_string(), "release".to_string()]);
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

    /// A temp worktrees base and the root `key` maps to inside it, through the
    /// production `<base>/<repo_hash(key)>` mapping — the real app data is never touched.
    fn resolve_roots(
        holder: &tempfile::TempDir,
        key: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let base = holder.path().join("worktrees");
        let root = worktree_root_in(&base, key);
        (base, root)
    }

    /// A second checkout of `repo`: a detached linked worktree in its own temp dir.
    async fn add_linked_checkout(repo: &str) -> (tempfile::TempDir, String) {
        let holder = tempfile::tempdir().expect("create temp dir");
        let linked = holder.path().join("linked").to_string_lossy().into_owned();
        git(repo, &["worktree", "add", "--detach", &linked, "HEAD"]).await;
        (holder, linked)
    }

    /// The `gd-pr-resolve-*` entries in `repo`'s worktree registry.
    async fn pr_resolves_listed(repo: &str) -> Vec<String> {
        let porcelain = git(repo, &["worktree", "list", "--porcelain"]).await;
        parse_worktree_paths(&porcelain)
            .into_iter()
            .filter(|p| is_pr_resolve_worktree_path(p))
            .collect()
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
            &state, &repo, "feature", &wt, &wt_id, None, None, &wt_base,
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
        let (_, root) = resolve_roots(&root_holder, &repo);
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
        let (_, root) = resolve_roots(&root_holder, &repo);
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
        let (_, root) = resolve_roots(&root_holder, &repo);
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
        let (_, root) = resolve_roots(&root_holder, &repo);
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
            &state, &repo, "feature", &wt, &legacy_id, None, None, &wt_base,
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
        let found = find_remote_pr_resolve(&repo, 99, None, &wt_base)
            .await
            .unwrap()
            .expect("the live resolve is found");
        assert_eq!(
            canonical_wt_path(&found.worktree_path),
            canonical_wt_path(&wt)
        );
        assert_eq!(found.worktree_id, wt_id, "the id is parsed off the path");
        // Neither a different PR number nor a different lens may claim it.
        assert!(find_remote_pr_resolve(&repo, 98, None, &wt_base)
            .await
            .unwrap()
            .is_none());
        assert!(find_remote_pr_resolve(&repo, 99, Some("upstream"), &wt_base)
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

        abort_remote_pr_resolve(&state, &repo, &wt, &wt_base)
            .await
            .unwrap();
        assert!(!Path::new(&wt).exists(), "worktree removed after abort");
        assert!(find_remote_pr_resolve(&repo, 99, None, &wt_base)
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
            &wt_base,
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
                &state, &repo, "feature", &wt, bad_id, None, None, &wt_base,
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
            &state, &repo, "feature", &wt, &wt_id, None, None, &wt_base,
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

    /// A batch rollback returns to the branch it started on even when a tag shares
    /// that branch's name: `git switch heads/<name>` refuses ("a branch is expected"),
    /// while the plain name picks the branch over the tag.
    #[tokio::test]
    async fn cherry_pick_onto_rollback_returns_to_a_branch_shadowed_by_a_tag() {
        let (dir, repo) = setup_repo("pick-onto-tag-shadow").await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c2 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "feature"]).await;
        let feature_tip = rev(&repo, "HEAD").await;
        git(&repo, &["tag", "feature", "target"]).await;

        let state = AppState::default();
        match cherry_pick_onto(&state, &repo, &[c1, c2], "target", None).await {
            Err(AppError::Git { stderr, .. }) => {
                assert!(stderr.contains("was rolled back"), "{stderr}");
            }
            Ok(_) => panic!("the conflicting pick must fail"),
            Err(e) => panic!("expected the rolled-back verdict, got {e:?}"),
        }
        assert_eq!(rev(&repo, "refs/heads/target").await, target_tip);
        assert_eq!(
            git(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/feature"
        );
        assert_eq!(rev(&repo, "HEAD").await, feature_tip);
        assert_eq!(
            pick_record(&repo).await.original_ref.as_deref(),
            Some("feature"),
            "the journal names the branch the recovery banner compares against"
        );
    }

    /// Advancing the CURRENT branch touches the main tree, so a dirty one is refused
    /// up front — including when a tag shares the branch's name.
    #[tokio::test]
    async fn merge_local_pr_guards_a_current_base_shadowed_by_a_tag() {
        let (dir, repo) = setup_repo("lpr-tag-shadow").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        git(&repo, &["tag", &base]).await;
        let base_before = rev(&repo, "HEAD").await;
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let Err(err) =
            merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root).await
        else {
            panic!("a dirty current base is refused");
        };
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("uncommitted changes")),
            "{err:?}"
        );
        // HEAD is still on `base`, so its tip is the branch's.
        assert_eq!(rev(&repo, "HEAD").await, base_before);
        assert_eq!(tree_text(dir.path(), "a.txt"), "dirty\n");
    }

    /// The finish re-guards the main tree when `base` is the current branch; a tag
    /// sharing that name must not skip it.
    #[tokio::test]
    async fn finish_local_pr_merge_guards_a_current_base_shadowed_by_a_tag() {
        let (dir, repo) = setup_repo("lpr-finish-tag-shadow").await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        git(&repo, &["tag", &base]).await;
        let base_before = rev(&repo, "HEAD").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        git(&wt, &["checkout", "--theirs", "a.txt"]).await;
        git(&wt, &["add", "a.txt"]).await;
        // Dirtied during the resolution, after the merge's own upfront check.
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();

        let Err(err) = finish_local_pr_merge(
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
        else {
            panic!("a dirty current base is refused");
        };
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("uncommitted changes")),
            "{err:?}"
        );
        assert_eq!(rev(&repo, "HEAD").await, base_before);
        remove_resolve_worktree(&state, &repo, &wt).await;
    }

    /// The history rewrites journal the branch they started on by its plain name —
    /// the recovery banner compares it against the branch HEAD is on now.
    #[tokio::test]
    async fn rewrites_journal_a_branch_shadowed_by_a_tag_by_its_name() {
        let (dir, repo) = setup_repo("rewrite-tag-shadow").await;
        let base = rev(&repo, "HEAD").await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        git(&repo, &["tag", "feature", &base]).await;

        let state = AppState::default();
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)], &[])
            .await
            .unwrap();
        let journaled = |op: &'static str| {
            let repo = repo.clone();
            async move {
                crate::oplog::git_oplog_list(repo)
                    .await
                    .expect("the journal must be readable")
                    .into_iter()
                    .find(|e| e.op == op)
                    .expect("the op must be journaled")
                    .original_ref
            }
        };
        assert_eq!(
            journaled("rewrite_commits").await.as_deref(),
            Some("feature")
        );

        let tip = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "d.txt", "d\n", "three").await;
        let c3 = rev(&repo, "HEAD").await;
        git_rebase_edit(repo.clone(), tip, vec![pick(&c3)], None)
            .await
            .unwrap();
        assert_eq!(journaled("rebase_edit").await.as_deref(), Some("feature"));
    }

    /// A repo on its default branch at the seed commit, with `feature` one commit
    /// (`f.txt`) ahead of it and a TAG `feature` on the seed. A bare `feature` resolves
    /// to that tag (gitrevisions checks refs/tags before refs/heads), so every probe
    /// below tells "branch" from "tag" apart. Returns the dir, repo, default branch and
    /// the branch tip.
    async fn branch_shadowed_by_tag(marker: &str) -> (tempfile::TempDir, String, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        let base = head_branch(&repo).await;
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "f.txt", "f\n", "feature work").await;
        let feature_tip = rev(&repo, "HEAD").await;
        git(&repo, &["switch", &base]).await;
        git(&repo, &["tag", "feature"]).await;
        (dir, repo, base, feature_tip)
    }

    /// Merging a branch picked by name merges the BRANCH, not a same-named tag.
    #[tokio::test]
    async fn merge_takes_the_branch_shadowed_by_a_tag() {
        let (dir, repo, _base, feature_tip) = branch_shadowed_by_tag("merge-shadow").await;
        let state = AppState::default();
        git_merge_core(
            &state,
            repo.clone(),
            "feature".into(),
            false,
            false,
            "none".into(),
        )
        .await
        .unwrap();
        assert_eq!(rev(&repo, "HEAD").await, feature_tip);
        assert!(dir.path().join("f.txt").exists());
    }

    /// An unshadowed branch merges under its plain name, so git's default message
    /// still reads "Merge branch 'side'", never the qualified ref.
    #[tokio::test]
    async fn merge_keeps_the_default_message_for_an_unshadowed_branch() {
        let (dir, repo) = setup_repo("merge-message").await;
        git(&repo, &["switch", "-c", "side"]).await;
        commit_file(&repo, dir.path(), "s.txt", "s\n", "side work").await;
        git(&repo, &["switch", "-"]).await;
        let state = AppState::default();
        git_merge_core(
            &state,
            repo.clone(),
            "side".into(),
            false,
            true,
            "none".into(),
        )
        .await
        .unwrap();
        let subject = git(&repo, &["log", "-1", "--format=%s"]).await;
        assert!(subject.starts_with("Merge branch 'side'"), "{subject}");
    }

    /// The merge preview predicts the BRANCH's merge (a fast-forward here), not the
    /// tag's (already up to date).
    #[tokio::test]
    async fn merge_preview_reads_the_branch_shadowed_by_a_tag() {
        let (_dir, repo, _base, _tip) = branch_shadowed_by_tag("preview-shadow").await;
        let preview = git_merge_preview(repo.clone(), "feature".into(), "none".into())
            .await
            .unwrap();
        assert_eq!(preview.status, "fast-forward");
    }

    /// Rebasing onto a branch picked by name replays onto the BRANCH.
    #[tokio::test]
    async fn rebase_onto_a_branch_shadowed_by_a_tag_takes_the_branch() {
        let (dir, repo, _base, feature_tip) = branch_shadowed_by_tag("rebase-shadow").await;
        git(&repo, &["switch", "-c", "topic"]).await;
        commit_file(&repo, dir.path(), "t.txt", "t\n", "topic work").await;
        let state = AppState::default();
        git_rebase_core(&state, repo.clone(), "feature".into())
            .await
            .unwrap();
        let plain = rev(&repo, "HEAD~1").await;

        // `--onto` resolves its new base the same way.
        let (dir2, repo2, base2, tip2) = branch_shadowed_by_tag("rebase-onto-shadow").await;
        git(&repo2, &["switch", "-c", "wrong", &base2]).await;
        commit_file(&repo2, dir2.path(), "w.txt", "w\n", "wrong base work").await;
        git(&repo2, &["switch", "-c", "topic"]).await;
        commit_file(&repo2, dir2.path(), "t.txt", "t\n", "topic work").await;
        rebase_onto(&state, &repo2, "feature", "wrong")
            .await
            .unwrap();
        let onto = rev(&repo2, "HEAD~1").await;
        assert_eq!((plain, onto), (feature_tip, tip2));
        assert!(
            !dir2.path().join("w.txt").exists(),
            "the wrong base's work is dropped"
        );
    }

    /// The local-PR conflict precheck reads the head BRANCH: here it conflicts with
    /// the base, where the tag (an ancestor of base) would read as a clean merge.
    #[tokio::test]
    async fn conflict_preview_reads_a_head_shadowed_by_a_tag() {
        let (dir, repo, base, _tip) = branch_shadowed_by_tag("conflict-preview-shadow").await;
        git(&repo, &["switch", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feature edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        let preview = git_conflict_preview(repo.clone(), base.clone(), "feature".into())
            .await
            .unwrap();
        assert_eq!(preview.status, "conflict");
    }

    /// A batch rollback restores the target BRANCH's own tip: rewinding it to a
    /// same-named tag's commit would discard the target's commits.
    #[tokio::test]
    async fn cherry_pick_onto_rollback_keeps_a_target_shadowed_by_a_tag() {
        let (dir, repo) = setup_repo("pick-onto-target-shadow").await;
        git(&repo, &["tag", "target"]).await;
        git(&repo, &["branch", "target"]).await;
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "feature\n", "feature edit").await;
        let c2 = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "target"]).await;
        commit_file(&repo, dir.path(), "a.txt", "target\n", "target edit").await;
        let target_tip = rev(&repo, "refs/heads/target").await;
        git(&repo, &["checkout", "feature"]).await;

        let state = AppState::default();
        assert!(
            cherry_pick_onto(&state, &repo, &[c1, c2], "target", None)
                .await
                .is_err(),
            "the conflicting batch fails and rolls back"
        );
        assert_eq!(rev(&repo, "refs/heads/target").await, target_tip);
    }

    /// A local-PR merge merges the head BRANCH, not a same-named tag.
    #[tokio::test]
    async fn merge_local_pr_merges_a_head_shadowed_by_a_tag() {
        let (_dir, repo, base, _tip) = branch_shadowed_by_tag("lpr-head-shadow").await;
        // Off `base`, so the merge advances it by update-ref.
        git(&repo, &["switch", "-c", "work"]).await;
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let Ok(outcome) =
            merge_local_pr(&state, &repo, &base, "feature", "merge it", "merge", &root).await
        else {
            panic!("the merge succeeds");
        };
        assert_eq!(outcome.status, "merged");
        git(&repo, &["cat-file", "-e", &format!("{base}:f.txt")]).await;
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
            &state, &repo, "feature", &wt, &wt_id, None, None, &wt_base,
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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

        cleanup_orphaned_resolve_worktrees(&state, &repo, &[], &wt_base)
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

    /// Every checkout of a repository resolves one identity, hence one resolve root: a
    /// resolve started from the main checkout is offered to a linked one, a start
    /// there resumes it instead of minting a second, and it finishes from there.
    #[tokio::test]
    async fn remote_pr_resolve_minted_in_one_checkout_is_found_and_finished_from_another() {
        use crate::git::worktree::canonical_wt_path;
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-cross").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let (_linked_holder, linked) = add_linked_checkout(&repo).await;
        let identity = crate::git::repo::repo_identity(&repo).await.unwrap();
        assert_eq!(
            crate::git::repo::repo_identity(&linked).await.unwrap(),
            identity,
            "the premise: both checkouts share one identity"
        );

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (wt_base, root) = resolve_roots(&root_holder, &identity);
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 21, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(outcome.status, "conflicts");
        let wt = outcome.worktree_path.clone().expect("worktree path set");

        let found = find_remote_pr_resolve(&linked, 21, None, &wt_base)
            .await
            .unwrap()
            .expect("the other checkout's resolve is offered here");
        assert_eq!(
            canonical_wt_path(&found.worktree_path),
            canonical_wt_path(&wt)
        );
        assert_eq!(Some(&found.worktree_id), outcome.worktree_id.as_ref());

        let resumed = merge_remote_pr(&state, &linked, 21, &base, "feature", None, None, &root)
            .await
            .unwrap();
        assert_eq!(
            resumed.worktree_id, outcome.worktree_id,
            "resumed, not re-minted"
        );
        assert_eq!(pr_resolves_listed(&repo).await.len(), 1);

        std::fs::write(Path::new(&wt).join("a.txt"), "resolved\n").unwrap();
        git(&wt, &["add", "a.txt"]).await;
        let done = finish_remote_pr_resolve(
            &state,
            &linked,
            "feature",
            &found.worktree_path,
            &found.worktree_id,
            None,
            None,
            &wt_base,
        )
        .await
        .unwrap();
        assert_eq!(done.status, "pushed");
        assert_eq!(
            Some(rev(&bare, "refs/heads/feature").await),
            done.pushed_sha,
            "the PR head is the merge finished from the second checkout"
        );
        assert!(!Path::new(&wt).exists(), "worktree removed after finish");
        assert!(pr_resolves_listed(&repo).await.is_empty());
    }

    /// The root shape alone would accept ANY repository's resolve, since every root
    /// under the base has it. Registry membership is the repository scope: a path
    /// unregistered here is never removed — finish refuses it, abort treats it as
    /// already gone (the stale-handle case) and leaves it untouched.
    #[tokio::test]
    async fn remote_pr_guard_never_touches_a_root_shaped_path_unregistered_here() {
        let (dir, _origin, repo, bare) = setup_repo_with_origin("rpr-foreign-x").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let head_before = rev(&bare, "refs/heads/feature").await;
        let (_other_dir, _other_origin, other, _other_bare) =
            setup_repo_with_origin("rpr-foreign-y").await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
        let state = AppState::default();
        let outcome = merge_remote_pr(&state, &repo, 3, &base, "feature", None, None, &root)
            .await
            .unwrap();
        let wt = outcome.worktree_path.clone().expect("worktree path set");
        let wt_id = outcome.worktree_id.clone().expect("worktree id set");
        assert!(
            is_adoptable_pr_resolve(&wt_base, &wt),
            "the premise: the foreign path has the accepted root shape"
        );

        abort_remote_pr_resolve(&state, &other, &wt, &wt_base)
            .await
            .expect("abort of an unregistered resolve is a no-op");
        let err =
            finish_remote_pr_resolve(&state, &other, "feature", &wt, &wt_id, None, None, &wt_base)
                .await
                .unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("not a pull-request resolve worktree")),
            "got: {err:?}"
        );
        assert!(
            Path::new(&wt).exists(),
            "the other repository's resolve is untouched"
        );
        assert_eq!(pr_resolves_listed(&repo).await.len(), 1);
        assert_eq!(rev(&bare, "refs/heads/feature").await, head_before);

        // Its own repository still passes the same guard.
        abort_remote_pr_resolve(&state, &repo, &wt, &wt_base)
            .await
            .unwrap();
        assert!(!Path::new(&wt).exists());

        // Once removed it is unregistered here too: a second Discard clears, while
        // finish keeps refusing the same path.
        abort_remote_pr_resolve(&state, &repo, &wt, &wt_base)
            .await
            .expect("abort of an already-removed resolve is a no-op");
        let err =
            finish_remote_pr_resolve(&state, &repo, "feature", &wt, &wt_id, None, None, &wt_base)
                .await
                .unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("not a pull-request resolve worktree")),
            "got: {err:?}"
        );
    }

    /// A worthless resolve in a CHECKOUT-keyed root is reclaimable from any checkout of
    /// the repository; in-progress work survives the worthless gate.
    #[tokio::test]
    async fn cleanup_reclaims_a_worthless_resolve_in_a_legacy_checkout_root() {
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-legacy-sweep").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let (_linked_holder, linked) = add_linked_checkout(&repo).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (wt_base, legacy_root) = resolve_roots(&root_holder, &repo);
        let state = AppState::default();
        // In progress (dirty), minted under the legacy root the way an older build did.
        let dirty = merge_remote_pr(&state, &repo, 5, &base, "feature", None, None, &legacy_root)
            .await
            .unwrap()
            .worktree_path
            .expect("worktree path set");
        // Worthless: detached at a commit the remote has, no merge in flight.
        let head_tip = rev(&repo, "refs/remotes/origin/feature").await;
        let clean = legacy_root
            .join("gd-pr-resolve-origin-4-clean")
            .to_string_lossy()
            .into_owned();
        git(&repo, &["worktree", "add", "--detach", &clean, &head_tip]).await;

        cleanup_orphaned_resolve_worktrees(&state, &linked, &[], &wt_base)
            .await
            .unwrap();

        assert!(
            !Path::new(&clean).exists(),
            "a worthless legacy-rooted resolve is reclaimed from another checkout"
        );
        assert!(Path::new(&dirty).exists(), "an in-progress one is kept");
        assert_eq!(pr_resolves_listed(&repo).await.len(), 1);
    }

    /// An in-progress resolve in a legacy checkout-keyed root is adopted as-is: a
    /// start through the identity root resumes it rather than minting beside it.
    #[tokio::test]
    async fn remote_pr_resume_adopts_a_legacy_rooted_resolve() {
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-legacy-resume").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let (_linked_holder, linked) = add_linked_checkout(&repo).await;
        let identity = crate::git::repo::repo_identity(&repo).await.unwrap();

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (wt_base, legacy_root) = resolve_roots(&root_holder, &repo);
        let identity_root = worktree_root_in(&wt_base, &identity);
        assert_ne!(
            legacy_root, identity_root,
            "the premise: two different roots"
        );

        let state = AppState::default();
        let legacy = merge_remote_pr(&state, &repo, 8, &base, "feature", None, None, &legacy_root)
            .await
            .unwrap();
        assert_eq!(legacy.status, "conflicts");

        for checkout in [&repo, &linked] {
            let found = find_remote_pr_resolve(checkout, 8, None, &wt_base)
                .await
                .unwrap()
                .expect("the legacy-rooted resolve is found");
            assert_eq!(Some(&found.worktree_id), legacy.worktree_id.as_ref());
            let resumed = merge_remote_pr(
                &state,
                checkout,
                8,
                &base,
                "feature",
                None,
                None,
                &identity_root,
            )
            .await
            .unwrap();
            assert_eq!(resumed.worktree_id, legacy.worktree_id, "from {checkout}");
            assert!(resumed.conflicts.iter().any(|p| p == "a.txt"));
        }
        assert_eq!(pr_resolves_listed(&repo).await.len(), 1);
        assert!(
            !identity_root.exists() || std::fs::read_dir(&identity_root).unwrap().next().is_none(),
            "nothing was minted under the identity root"
        );
    }

    /// Two starts of one PR racing from two checkouts: the find-then-add runs under
    /// the shared admin hold, so exactly one mints and the other resumes it.
    #[tokio::test]
    async fn concurrent_remote_pr_starts_from_two_checkouts_mint_one_resolve() {
        let (dir, _origin, repo, _bare) = setup_repo_with_origin("rpr-race").await;
        let base = push_conflicting_pair(&repo, dir.path(), "origin").await;
        let (_linked_holder, linked) = add_linked_checkout(&repo).await;
        let identity = crate::git::repo::repo_identity(&repo).await.unwrap();

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (_, root) = resolve_roots(&root_holder, &identity);
        let state = AppState::default();
        let (a, b) = tokio::join!(
            merge_remote_pr(&state, &repo, 64, &base, "feature", None, None, &root),
            merge_remote_pr(&state, &linked, 64, &base, "feature", None, None, &root),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.worktree_id, b.worktree_id, "one winner, one resume");
        let listed = pr_resolves_listed(&repo).await;
        assert_eq!(listed.len(), 1, "exactly one resolve worktree: {listed:?}");
    }

    /// Refspec metacharacters are rejected BEFORE anything is fetched, created, or
    /// pushed — these names are interpolated into fetch/push refspecs, where `*`
    /// globs and `:` separates. A lens whose remote does not exist is refused just
    /// as early, rather than silently falling back to origin.
    #[tokio::test]
    async fn remote_pr_rejects_bad_refs_and_missing_remotes_before_any_mutation() {
        let (dir, repo) = setup_repo("rpr-validate").await;
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let (_, root) = resolve_roots(&root_holder, &repo);
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
        let (wt_base, root) = resolve_roots(&root_holder, &repo);
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
                &state, &repo, bad, &wt, "abcdef", None, None, &wt_base,
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
            &state, &repo, "feature", &wt, "abcdef", None, None, &wt_base,
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

        let base = Path::new("/data/wt");
        // Directly inside ANY 16-hex root: the identity root, a legacy checkout-keyed
        // one, another checkout's — the shape cannot tell them apart, by design.
        for path in [
            "/data/wt/0123456789abcdef/gd-pr-resolve-origin-12-abc",
            "/data/wt/fedcba9876543210/gd-pr-resolve-origin-12-abc",
        ] {
            assert!(is_adoptable_pr_resolve(base, path), "{path}");
        }
        for path in [
            // Ours by name but outside the base, and in a root but not ours.
            "/users/me/gd-pr-resolve-origin-12-abc",
            "/data/wt/0123456789abcdef/my-work",
            // A SIBLING of the base sharing its prefix must not slip through a bare
            // `starts_with` — acceptance ends in `worktree remove --force`.
            "/data/wtevil/0123456789abcdef/gd-pr-resolve-origin-12-abc",
            // Not directly in a root: in the base itself, one level too deep, or
            // under a directory that is not a `repo_hash` (wrong length, non-hex).
            "/data/wt/gd-pr-resolve-origin-12-abc",
            "/data/wt/0123456789abcdef/nested/gd-pr-resolve-origin-12-abc",
            "/data/wt/0123456789abcde/gd-pr-resolve-origin-12-abc",
            "/data/wt/0123456789abcdeg/gd-pr-resolve-origin-12-abc",
            "/data/wt/0123456789abcdef0/gd-pr-resolve-origin-12-abc",
        ] {
            assert!(!is_adoptable_pr_resolve(base, path), "{path}");
        }
        // The production mapping always lands in the accepted shape.
        let minted = worktree_root_in(base, "C:/repos/app/.git").join("gd-pr-resolve-origin-1-abc");
        assert!(is_adoptable_pr_resolve(base, &minted.to_string_lossy()));
    }

    /// The divergent-spelling class the 3-OS matrix caught: one side reaches a
    /// directory through a link, the other through its real path. macOS's
    /// `/var → /private/var` temp dirs are that shape; a junction reproduces it on
    /// Windows, the only platform this can run on locally. Canonicalizing BOTH
    /// sides is what makes the two spellings compare equal — and the shape test must
    /// still REFUSE a sibling of the base through either spelling.
    #[cfg(windows)]
    #[test]
    fn worktree_root_shape_matches_across_a_linked_spelling() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let real = tmp.path().join("real");
        let leaf = Path::new("0123456789abcdef").join("gd-pr-resolve-origin-1-abc");
        std::fs::create_dir_all(real.join(&leaf)).unwrap();
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

        let child_real = real.join(&leaf).to_string_lossy().into_owned();
        let child_link = link.join(&leaf).to_string_lossy().into_owned();
        // Base spelled one way, child the other — both directions.
        assert!(
            is_in_a_worktree_root(&link, &child_real),
            "linked base vs real child"
        );
        assert!(
            is_in_a_worktree_root(&real, &child_link),
            "real base vs linked child"
        );
        // A sibling sharing the base's prefix is still refused through either.
        let sibling = tmp.path().join("realevil").join(&leaf);
        std::fs::create_dir_all(&sibling).unwrap();
        let sibling = sibling.to_string_lossy().into_owned();
        assert!(!is_in_a_worktree_root(&real, &sibling));
        assert!(!is_in_a_worktree_root(&link, &sibling));
    }

    /// Windows-only: drive letters, case-insensitivity and backslash separators
    /// are meaningful there and nowhere else (`Path::file_name` only splits on
    /// `\` on Windows), so this spelling row cannot run cross-platform.
    #[cfg(windows)]
    #[test]
    fn pr_resolve_worktree_guard_accepts_windows_spellings() {
        let base = Path::new("C:/data/wt");
        assert!(is_adoptable_pr_resolve(
            base,
            "c:\\data\\wt\\0123456789ABCDEF\\gd-pr-resolve-origin-12-abc"
        ));
        assert!(!is_adoptable_pr_resolve(
            base,
            "C:/data/wtevil/0123456789abcdef/gd-pr-resolve-origin-12-abc"
        ));
        // Registry membership compares through the same spellings.
        let listed = vec!["C:/data/wt/0123456789abcdef/gd-pr-resolve-origin-12-abc".to_string()];
        assert!(is_listed_worktree(
            &listed,
            "c:\\data\\wt\\0123456789abcdef\\gd-pr-resolve-origin-12-abc"
        ));
        assert!(!is_listed_worktree(
            &listed,
            "c:\\data\\wt\\fedcba9876543210\\gd-pr-resolve-origin-12-abc"
        ));
    }

    #[test]
    fn pr_resolve_path_classification() {
        let base = Path::new("/data/wt");
        let resolve = "/data/wt/0123456789abcdef/gd-pr-resolve-origin-12-abc";
        let check = |listed: &[&str], path: &str| {
            let listed: Vec<String> = listed.iter().map(|s| s.to_string()).collect();
            classify_pr_resolve_path(base, &listed, path)
        };
        assert_eq!(check(&[resolve], resolve), PrResolvePath::Registered);
        assert_eq!(check(&[], resolve), PrResolvePath::Unregistered);
        // Registered but not shaped as a resolve: never a silent no-op.
        let plain = "/data/wt/0123456789abcdef/feature";
        assert_eq!(check(&[plain], plain), PrResolvePath::Refused);
        let outside = "/elsewhere/gd-pr-resolve-origin-12-abc";
        assert_eq!(check(&[outside], outside), PrResolvePath::Refused);
        assert_eq!(check(&[], outside), PrResolvePath::Refused);
    }

    /// A junction planted in a root's shape, pointing at a registered worktree
    /// elsewhere, passes shape under its own spelling and membership under its
    /// target's. Both gates must hold under ONE spelling, so it is refused.
    #[cfg(windows)]
    #[test]
    fn pr_resolve_guard_refuses_a_shaped_junction_to_a_registered_worktree() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let base = tmp.path().join("wt");
        let target = tmp.path().join("elsewhere").join("linked");
        std::fs::create_dir_all(&target).unwrap();
        let root = base.join("0123456789abcdef");
        std::fs::create_dir_all(&root).unwrap();
        let junction = root.join("gd-pr-resolve-origin-1-abc");
        let made = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .output()
            .expect("run mklink");
        assert!(
            made.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&made.stderr)
        );

        let listed = vec![target.to_string_lossy().into_owned()];
        let junction = junction.to_string_lossy().into_owned();
        assert!(
            is_adoptable_pr_resolve(&base, &junction) && is_listed_worktree(&listed, &junction),
            "the premise: each gate passes on its own under some spelling"
        );
        assert_eq!(
            classify_pr_resolve_path(&base, &listed, &junction),
            PrResolvePath::Refused
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
        git(&repo, &["branch", "finalize-base-holder"]).await;
        let tip = rev(&repo, "refs/heads/finalize-base-holder").await;
        let root = dir.path().join("gd-worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        let _live =
            marker::UpdateMarker::create_for(&root.join("gd-update-live"), "finalize-base-holder")
                .expect("the marker mints");

        let state = AppState::default();
        let current = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let err = finalize_base(
            &state,
            &repo,
            "finalize-base-holder",
            &tip,
            &current,
            Some(&tip),
        )
        .await
        .expect_err("advancing a branch an update is merging is refused");
        assert_eq!(
            err.to_string(),
            marker::branch_update_refusal("finalize-base-holder").to_string()
        );
        assert_eq!(
            rev(&repo, "refs/heads/finalize-base-holder").await,
            tip,
            "and the branch is exactly where it was"
        );
    }
    #[tokio::test]
    async fn merge_ignored_shapes_and_modes() {
        use crate::git::ignored_guard::tests::{Fixture, Shape, SHAPES};
        for shape in SHAPES {
            for diverged in [false, true] {
                if shape == Shape::ModifyDelete && !diverged {
                    continue;
                }
                for (squash, no_ff, strategy) in [
                    (false, false, ""),
                    (true, false, ""),
                    (false, true, ""),
                    (false, false, "theirs"),
                ] {
                    let f = Fixture::new(shape, diverged).await;
                    let result = super::git_merge_core(
                        &AppState::default(),
                        f.repo.clone(),
                        "incoming".into(),
                        squash,
                        no_ff,
                        strategy.into(),
                    )
                    .await;
                    if shape == Shape::InsideIgnoredDir {
                        result.unwrap();
                        f.assert_landed().await;
                    } else {
                        f.assert_unchanged(&result.unwrap_err()).await;
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn merge_ignored_guard_sensitivity() {
        use crate::git::ignored_guard::tests::{Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let state = AppState::default();
        let err = super::git_merge_core(
            &state,
            f.repo.clone(),
            "incoming".into(),
            false,
            false,
            "".into(),
        )
        .await
        .unwrap_err();
        f.assert_unchanged(&err).await;
        f.remove_ignored();
        super::git_merge_core(
            &state,
            f.repo.clone(),
            "incoming".into(),
            false,
            false,
            "".into(),
        )
        .await
        .unwrap();
        f.assert_landed().await;
    }

    #[tokio::test]
    async fn merge_ignored_subdirectory_refuses() {
        use crate::git::ignored_guard::tests::{Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let sub = Path::new(&f.repo).join("sub");
        std::fs::create_dir(&sub).unwrap();
        let err = super::git_merge_core(
            &AppState::default(),
            sub.to_string_lossy().into_owned(),
            "incoming".into(),
            false,
            false,
            "".into(),
        )
        .await
        .unwrap_err();
        f.assert_unchanged(&err).await;
    }

    #[tokio::test]
    async fn merge_ignored_mid_merge_keeps_gits_refusal() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        run(&f.repo, &["branch", "other", "HEAD~1"]).await;
        run(&f.repo, &["switch", "-q", "other"]).await;
        std::fs::write(Path::new(&f.repo).join("other.txt"), "other\n").unwrap();
        run(&f.repo, &["add", "other.txt"]).await;
        run(&f.repo, &["commit", "-qm", "other"]).await;
        run(&f.repo, &["switch", "-q", "local"]).await;
        run(&f.repo, &["merge", "--no-ff", "--no-commit", "other"]).await;
        assert!(super::op_state(&f.repo).await.unwrap().merging);
        let native = run_git_raw(
            Some(&f.repo),
            &["merge", "--no-edit", "--no-overwrite-ignore", "incoming"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(native.code, 0);
        let err = super::git_merge_core(
            &AppState::default(),
            f.repo.clone(),
            "incoming".into(),
            false,
            false,
            "".into(),
        )
        .await
        .unwrap_err();
        let AppError::Git { code, stderr } = err else {
            panic!("{err:?}");
        };
        assert_eq!(code, native.code);
        assert_eq!(stderr, native.full_failure_text());
    }

    #[tokio::test]
    async fn finalize_ignored_guard_sensitivity_current() {
        assert_finalize_ignored_guard_sensitivity(false).await;
    }

    #[tokio::test]
    async fn finalize_ignored_guard_sensitivity_holder() {
        assert_finalize_ignored_guard_sensitivity(true).await;
    }

    async fn assert_finalize_ignored_guard_sensitivity(held: bool) {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape};
        let mut f = Fixture::new(Shape::IgnoredFile, false).await;
        let repo = f.repo.clone();
        if held {
            let holder = f.dir.path().join("holder").to_string_lossy().into_owned();
            run(&repo, &["switch", "--detach", "-q"]).await;
            run(&repo, &["worktree", "add", &holder, "local"]).await;
            std::fs::rename(
                Path::new(&repo).join(f.ignored),
                Path::new(&holder).join(f.ignored),
            )
            .unwrap();
            f.repo = holder;
        }
        f.snapshot().await;
        let current = if held { "HEAD" } else { "local" };
        let state = AppState::default();
        let err = super::finalize_base(&state, &repo, "local", &f.target, current, Some(&f.head))
            .await
            .unwrap_err();
        f.assert_unchanged(&err).await;
        if held {
            // The holder's path comes from git's worktree porcelain, which prints long
            // names where a Windows runner's temp dir is an 8.3 short name.
            use crate::git::worktree::canonical_wt_path;
            let message = err.to_string();
            let named = message
                .split_once(" is checked out at ")
                .and_then(|(_, rest)| rest.split_once(", where "))
                .map(|(path, _)| path)
                .unwrap_or_else(|| panic!("refusal names no holder: {message}"));
            assert_eq!(
                canonical_wt_path(named),
                canonical_wt_path(&f.repo),
                "{message}"
            );
        }
        f.remove_ignored();
        super::finalize_base(&state, &repo, "local", &f.target, current, Some(&f.head))
            .await
            .unwrap();
        f.assert_landed().await;
        assert_eq!(run(&f.repo, &["rev-parse", "HEAD"]).await, f.target);
    }

    #[tokio::test]
    async fn merge_ignored_guard_matches_native_operation_states() {
        use crate::git::ignored_guard::tests::{Fixture, Shape, MERGE_STATES};
        for state in MERGE_STATES {
            let mut f = Fixture::new(Shape::IgnoredFile, true).await;
            state.install(&f).await;
            f.snapshot().await;
            let expected = if state.blocks_merge() {
                Some(
                    run_git_raw(
                        Some(&f.repo),
                        &["merge", "--no-overwrite-ignore", "--no-edit", "incoming"],
                        DEFAULT_TIMEOUT,
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let err = git_merge_core(
                &AppState::default(),
                f.repo.clone(),
                "incoming".into(),
                false,
                false,
                "".into(),
            )
            .await
            .unwrap_err();
            if let Some(expected) = expected {
                let AppError::Git { code, stderr } = err else {
                    panic!("{state:?}: {err:?}")
                };
                assert_ne!(expected.code, 0);
                assert_eq!(code, expected.code);
                assert_eq!(stderr, expected.full_failure_text(), "{state:?}");
                f.assert_snapshot().await;
            } else {
                f.assert_unchanged(&err).await;
            }
        }
    }

    #[tokio::test]
    async fn merge_blocked_by_native_state_does_not_wait_for_fetch() {
        use crate::git::ignored_guard::tests::{Fixture, MergeState, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        MergeState::MergeHead.install(&f).await;
        let expected = run_git_raw(
            Some(&f.repo),
            &["merge", "--no-overwrite-ignore", "--no-edit", "incoming"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(expected.code, 0);
        let state = AppState::default();
        let network = state.network_lock(&f.repo).await;
        let _held = acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, "a fetch")
            .await
            .unwrap();
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            git_merge_core(
                &state,
                f.repo.clone(),
                "incoming".into(),
                false,
                false,
                "".into(),
            ),
        )
        .await
        .expect("git's own refusal must precede the network wait")
        .unwrap_err();
        let AppError::Git { code, stderr } = err else {
            panic!("{err:?}")
        };
        assert_eq!(code, expected.code);
        assert_eq!(stderr, expected.full_failure_text());
        assert!(stderr.contains("MERGE_HEAD exists"), "{stderr}");
        f.assert_snapshot().await;
    }

    #[tokio::test]
    async fn finalize_current_branch_rechecks_the_checkout() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, false).await;
        run(&f.repo, &["switch", "-c", "other"]).await;
        let err = finalize_base(
            &AppState::default(),
            &f.repo,
            "local",
            &f.target,
            "local",
            Some(&f.head),
        )
        .await
        .unwrap_err();
        let AppError::Command(message) = err else {
            panic!("{err:?}")
        };
        assert!(
            message.starts_with("local moved while this merge was being prepared"),
            "{message}"
        );
        f.assert_intact().await;
        assert_eq!(
            run(&f.repo, &["rev-parse", "refs/heads/other"]).await,
            f.head
        );
    }
}
