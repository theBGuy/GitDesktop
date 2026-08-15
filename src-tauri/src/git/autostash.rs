//! App-level stash → op → reapply compounds for pull, merge and switch.
//!
//! Each command acquires `repo_lock` ONCE and uses only the lock-free runners
//! while holding it — `run_git_mutating` re-acquires the same non-reentrant
//! mutex and deadlocks (precedent: `git_stash_paths_core`). The inner steps
//! therefore lose `run_git_mutating`'s one-shot index.lock retry, the same
//! trade-off that compound accepts.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::branches::validate_ref_name;
use crate::git::remote::run_git_with_creds_once;
use crate::git::runner::{run_git, run_git_raw, GitOutput, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::state::AppState;

/// How a stash → op → reapply compound ended. Every failure mode is reportable —
/// a variant, refined by its discriminant field — because git's own `--autostash`
/// reports none of them: it exits 0 even when the reapply conflicts.
#[derive(Debug, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutostashOutcome {
    /// Tree was clean at stash time; the op ran plainly (op failure returns Err, not this).
    NothingStashed,
    /// Stash pushed, reapply not requested (switch with reapply=false).
    StashedOnly,
    /// stash → op → pop, all clean.
    Reapplied,
    /// Op succeeded; pop failed. Git retains the stash entry on a conflicted pop.
    /// `conflicted` distinguishes a merge conflict (unmerged paths in the changes
    /// list) from a pop git refused outright, which leaves nothing to resolve.
    ReapplyConflicted { stderr: String, conflicted: bool },
    /// Op failed with no in-progress state; the stash was popped back cleanly.
    OpFailedRestored { stderr: String },
    /// Op failed leaving in-progress state (e.g. rebase conflict), OR the restore-pop
    /// itself failed — stash kept either way. `in_progress` says which: only the
    /// first has a merge/rebase for the user to continue or abort.
    OpFailedStashKept { stderr: String, in_progress: bool },
}

/// `git stash push --include-untracked` (parity with `git_stash_all_core`).
/// `false` when git found nothing to stash: it exits 0 without creating an entry,
/// so this stdout line is the only signal (`run_git` pins `LC_ALL=C`).
async fn autostash_push(repo: &str) -> AppResult<bool> {
    let out = run_git(
        Some(repo),
        &["stash", "push", "--include-untracked"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(!out
        .stdout_lossy()
        .trim_start()
        .starts_with("No local changes to save"))
}

/// Raw so a conflicted pop (exit 1) can be classified rather than propagated.
async fn autostash_pop(repo: &str) -> AppResult<GitOutput> {
    run_git_raw(Some(repo), &["stash", "pop"], DEFAULT_TIMEOUT).await
}

/// Failure text for an outcome payload. git splits its reporting across both
/// streams — a conflicted merge and a conflicted `stash pop` write everything to
/// stdout and leave stderr EMPTY (measured, git 2.51.1) — so stdout backfills.
fn failure_text(out: &GitOutput) -> String {
    let stderr = out.stderr.trim();
    if stderr.is_empty() {
        out.stdout_lossy().trim().to_string()
    } else {
        stderr.to_string()
    }
}

/// Shapes a non-zero raw result exactly as `run_git` would, so the no-stash path's
/// error reaches the frontend identical to the plain command's.
fn git_error(out: GitOutput) -> AppError {
    AppError::Git {
        code: out.code,
        stderr: out.stderr,
    }
}

/// Turns the inner op's result into an outcome, unwinding the autostash when it can
/// be unwound safely. Never errors on a failed pop — the retained stash is the
/// user's safety net, and reporting it is the whole point of the outcome enum.
async fn settle(
    repo: &str,
    stashed: bool,
    reapply: bool,
    op: AppResult<GitOutput>,
) -> AppResult<AutostashOutcome> {
    // Nothing was stashed, so there is nothing to unwind: behave like the plain command.
    if !stashed {
        let out = op?;
        if out.code != 0 {
            return Err(git_error(out));
        }
        return Ok(AutostashOutcome::NothingStashed);
    }

    let failure = match &op {
        Ok(out) if out.code == 0 => None,
        Ok(out) => Some(failure_text(out)),
        Err(err) => Some(err.to_string()),
    };

    if let Some(stderr) = failure {
        // Popping onto an in-progress merge/rebase would tangle the stash with
        // conflicts the user still has to resolve — keep it instead.
        if crate::git::ops::op_in_progress(repo).await {
            return Ok(AutostashOutcome::OpFailedStashKept {
                stderr,
                in_progress: true,
            });
        }
        let restored = matches!(autostash_pop(repo).await, Ok(out) if out.code == 0);
        return Ok(if restored {
            AutostashOutcome::OpFailedRestored { stderr }
        } else {
            AutostashOutcome::OpFailedStashKept {
                stderr,
                in_progress: false,
            }
        });
    }

    if !reapply {
        return Ok(AutostashOutcome::StashedOnly);
    }
    let stderr = match autostash_pop(repo).await {
        Ok(out) if out.code == 0 => return Ok(AutostashOutcome::Reapplied),
        Ok(out) => failure_text(&out),
        Err(err) => err.to_string(),
    };
    Ok(AutostashOutcome::ReapplyConflicted {
        stderr,
        // git aborts some pops without merging at all (an untracked file already in
        // the way), leaving nothing for the user to resolve; an unreadable index
        // answers the same way.
        conflicted: crate::git::ops::has_unmerged(repo).await.unwrap_or(false),
    })
}

/// Pull with the uncommitted changes stashed across the operation and reapplied
/// afterwards, reporting every failure mode the plain pull would collapse into a
/// bare error.
#[tauri::command]
pub async fn git_pull_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    mode: String,
) -> AppResult<AutostashOutcome> {
    git_pull_autostash_core(&state, repo_path, mode).await
}

pub(crate) async fn git_pull_autostash_core(
    state: &AppState,
    repo_path: String,
    mode: String,
) -> AppResult<AutostashOutcome> {
    // Same mode→flag map as `git_pull_core`; the frontend retries the refused pull
    // with the mode it originally attempted.
    let flag = match mode.as_str() {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    // A read that shells out to git itself — resolve it BEFORE taking the lock.
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    let op = run_git_with_creds_once(&repo_path, &cred, &["pull", flag], NETWORK_TIMEOUT).await;
    settle(&repo_path, stashed, true, op).await
}

/// Merge `branch` into the current one with the uncommitted changes stashed across
/// the merge and reapplied afterwards. Plain `--no-edit` merges only.
#[tauri::command]
pub async fn git_merge_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
) -> AppResult<AutostashOutcome> {
    git_merge_autostash_core(&state, repo_path, branch).await
}

pub(crate) async fn git_merge_autostash_core(
    state: &AppState,
    repo_path: String,
    branch: String,
) -> AppResult<AutostashOutcome> {
    validate_ref_name(&branch)?;

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    let op = run_git_raw(
        Some(&repo_path),
        &["merge", "--no-edit", &branch],
        DEFAULT_TIMEOUT,
    )
    .await;
    settle(&repo_path, stashed, true, op).await
}

/// Switch branches with the uncommitted changes stashed across the switch, and
/// reapplied on the far side when `reapply` is set. `remote` checks out a
/// remote-only branch as a tracking branch, mirroring `git_checkout_remote_branch`.
#[tauri::command]
pub async fn git_switch_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    remote: Option<String>,
    reapply: bool,
) -> AppResult<AutostashOutcome> {
    git_switch_autostash_core(&state, repo_path, name, remote, reapply).await
}

pub(crate) async fn git_switch_autostash_core(
    state: &AppState,
    repo_path: String,
    name: String,
    remote: Option<String>,
    reapply: bool,
) -> AppResult<AutostashOutcome> {
    validate_ref_name(&name)?;
    if let Some(remote) = &remote {
        validate_ref_name(remote)?;
    }
    let tracking = remote.map(|remote| format!("{remote}/{name}"));

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    let args: Vec<&str> = match &tracking {
        Some(tracking) => vec!["switch", "--track", tracking],
        None => vec!["switch", &name],
    };
    let op = run_git_raw(Some(&repo_path), &args, DEFAULT_TIMEOUT).await;
    settle(&repo_path, stashed, reapply, op).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// `core.autocrlf=false` keeps every checkout/stash-pop byte-exact regardless of
    /// the machine's global git config — content assertions below depend on it.
    async fn configure(repo: &str) {
        git(repo, &["config", "core.autocrlf", "false"]).await;
        git(repo, &["config", "user.email", "t@t"]).await;
        git(repo, &["config", "user.name", "t"]).await;
    }

    async fn commit_all(repo: &str, msg: &str) {
        git(repo, &["add", "-A"]).await;
        git(repo, &["commit", "-m", msg]).await;
    }

    fn write(dir: &std::path::Path, file: &str, content: &str) {
        std::fs::write(dir.join(file), content).unwrap();
    }

    fn read(dir: &std::path::Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).unwrap()
    }

    fn temp(marker: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("gd-autostash-{marker}-"))
            .tempdir()
            .expect("create temp dir")
    }

    /// A repo with `a.txt`/`b.txt` committed on `main` — enough for one overlapping
    /// and one non-overlapping dirty file.
    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let dir = temp(marker);
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-b", "main"]).await;
        configure(&repo).await;
        write(dir.path(), "a.txt", "v0\n");
        write(dir.path(), "b.txt", "b0\n");
        commit_all(&repo, "base").await;
        (dir, repo)
    }

    /// Bare origin + an upstream work clone + the clone under test. Returns
    /// `(tempdir, upstream, clone)`; both work trees sit next to the bare repo.
    async fn setup_clone(marker: &str) -> (tempfile::TempDir, String, String) {
        let dir = temp(marker);
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "--bare", "-b", "main", "origin.git"]).await;
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );

        git(&root, &["init", "-b", "main", "work"]).await;
        let work_dir = dir.path().join("work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        write(&work_dir, "a.txt", "v0\n");
        write(&work_dir, "b.txt", "b0\n");
        commit_all(&work, "base").await;
        git(&work, &["remote", "add", "origin", &url]).await;
        git(&work, &["push", "-u", "origin", "main"]).await;

        // The clone's own checkout must be LF too, before its config exists.
        git(
            &root,
            &["-c", "core.autocrlf=false", "clone", &url, "clone"],
        )
        .await;
        let clone = dir.path().join("clone").to_string_lossy().into_owned();
        configure(&clone).await;
        (dir, work, clone)
    }

    async fn stash_list(repo: &str) -> String {
        git(repo, &["stash", "list"]).await.trim().to_string()
    }

    async fn unmerged(repo: &str) -> String {
        git(repo, &["ls-files", "--unmerged"])
            .await
            .trim()
            .to_string()
    }

    async fn head_branch(repo: &str) -> String {
        git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string()
    }

    fn stderr_of(outcome: &AutostashOutcome) -> &str {
        match outcome {
            AutostashOutcome::ReapplyConflicted { stderr, .. }
            | AutostashOutcome::OpFailedRestored { stderr }
            | AutostashOutcome::OpFailedStashKept { stderr, .. } => stderr,
            other => panic!("expected a failure-carrying outcome, got {other:?}"),
        }
    }

    // ---- pull -------------------------------------------------------------

    #[tokio::test]
    async fn pull_autostash_reapplies_non_overlapping_changes() {
        let (dir, work, clone) = setup_clone("pull-reapply").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "ffOnly".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(read(&clone_dir, "a.txt"), "upstream\n");
        assert_eq!(read(&clone_dir, "b.txt"), "mine\n");
        assert!(stash_list(&clone).await.is_empty());
    }

    #[tokio::test]
    async fn pull_autostash_reports_a_conflicted_reapply() {
        let (dir, work, clone) = setup_clone("pull-conflict").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        write(&dir.path().join("clone"), "a.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "ffOnly".into())
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::ReapplyConflicted {
                    conflicted: true,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert!(!stderr_of(&outcome).is_empty());
        // git keeps the entry on a conflicted pop, and the tree is left unmerged.
        assert!(!stash_list(&clone).await.is_empty());
        assert!(unmerged(&clone).await.contains("a.txt"));
    }

    #[tokio::test]
    async fn pull_autostash_on_a_clean_tree_stashes_nothing() {
        let (dir, work, clone) = setup_clone("pull-clean").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "ffOnly".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::NothingStashed),
            "{outcome:?}"
        );
        assert_eq!(read(&dir.path().join("clone"), "a.txt"), "upstream\n");
        assert!(stash_list(&clone).await.is_empty());
    }

    #[tokio::test]
    async fn pull_autostash_restores_changes_when_ff_only_refuses() {
        let (dir, work, clone) = setup_clone("pull-restore").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        // Diverge locally so --ff-only aborts, leaving no in-progress state.
        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "b.txt", "local commit\n");
        commit_all(&clone, "local").await;
        write(&clone_dir, "b.txt", "dirty\n");

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "ffOnly".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::OpFailedRestored { .. }),
            "{outcome:?}"
        );
        assert!(!stderr_of(&outcome).is_empty());
        assert_eq!(read(&clone_dir, "b.txt"), "dirty\n");
        assert!(stash_list(&clone).await.is_empty());
    }

    #[tokio::test]
    async fn pull_autostash_keeps_the_stash_when_a_rebase_conflicts() {
        let (dir, work, clone) = setup_clone("pull-rebase").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "a.txt", "mine\n");
        commit_all(&clone, "local").await;
        write(&clone_dir, "b.txt", "dirty\n");

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "rebase".into())
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::OpFailedStashKept {
                    in_progress: true,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert!(crate::git::ops::op_state(&clone).await.unwrap().rebasing);
        assert!(!stash_list(&clone).await.is_empty());
    }

    // ---- merge ------------------------------------------------------------

    /// `main` with a `feat` branch that rewrote `a.txt`, checked out on `main`.
    async fn setup_with_feat(marker: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        git(&repo, &["switch", "-c", "feat"]).await;
        write(dir.path(), "a.txt", "feat\n");
        commit_all(&repo, "feat").await;
        git(&repo, &["switch", "main"]).await;
        (dir, repo)
    }

    #[tokio::test]
    async fn merge_autostash_reapplies_non_overlapping_changes() {
        let (dir, repo) = setup_with_feat("merge-reapply").await;
        write(dir.path(), "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(read(dir.path(), "a.txt"), "feat\n");
        assert_eq!(read(dir.path(), "b.txt"), "mine\n");
        assert!(stash_list(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn merge_autostash_reports_a_conflicted_reapply() {
        let (dir, repo) = setup_with_feat("merge-conflict").await;
        write(dir.path(), "a.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::ReapplyConflicted {
                    conflicted: true,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert!(!stash_list(&repo).await.is_empty());
        assert!(unmerged(&repo).await.contains("a.txt"));
    }

    #[tokio::test]
    async fn merge_autostash_on_a_clean_tree_stashes_nothing() {
        let (dir, repo) = setup_with_feat("merge-clean").await;

        let state = AppState::default();
        let outcome = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::NothingStashed),
            "{outcome:?}"
        );
        assert_eq!(read(dir.path(), "a.txt"), "feat\n");
    }

    #[tokio::test]
    async fn merge_autostash_restores_changes_when_the_merge_is_rejected() {
        let (dir, repo) = setup_with_feat("merge-restore").await;
        write(dir.path(), "b.txt", "dirty\n");

        let state = AppState::default();
        // An unknown ref fails the merge outright — no MERGE_HEAD to protect.
        let outcome = git_merge_autostash_core(&state, repo.clone(), "nope".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::OpFailedRestored { .. }),
            "{outcome:?}"
        );
        assert!(!stderr_of(&outcome).is_empty());
        assert_eq!(read(dir.path(), "b.txt"), "dirty\n");
        assert!(stash_list(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn merge_autostash_keeps_the_stash_when_the_merge_conflicts() {
        let (dir, repo) = setup_with_feat("merge-kept").await;
        write(dir.path(), "a.txt", "main\n");
        commit_all(&repo, "main side").await;
        write(dir.path(), "b.txt", "dirty\n");

        let state = AppState::default();
        let outcome = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::OpFailedStashKept {
                    in_progress: true,
                    ..
                }
            ),
            "{outcome:?}"
        );
        // A conflicted merge reports on stdout only, so the payload proves the
        // stderr-empty fallback works.
        assert!(stderr_of(&outcome).contains("CONFLICT"));
        assert!(crate::git::ops::op_state(&repo).await.unwrap().merging);
        assert!(!stash_list(&repo).await.is_empty());
    }

    // ---- switch -----------------------------------------------------------

    #[tokio::test]
    async fn switch_autostash_reapplies_on_the_target_branch() {
        let (dir, repo) = setup_with_feat("switch-reapply").await;
        write(dir.path(), "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_switch_autostash_core(&state, repo.clone(), "feat".into(), None, true)
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(head_branch(&repo).await, "feat");
        assert_eq!(read(dir.path(), "b.txt"), "mine\n");
        assert!(stash_list(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn switch_autostash_without_reapply_leaves_the_stash() {
        let (dir, repo) = setup_with_feat("switch-stashed").await;
        write(dir.path(), "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_switch_autostash_core(&state, repo.clone(), "feat".into(), None, false)
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::StashedOnly),
            "{outcome:?}"
        );
        assert_eq!(head_branch(&repo).await, "feat");
        assert!(!stash_list(&repo).await.is_empty());
        assert!(git(&repo, &["status", "--porcelain"])
            .await
            .trim()
            .is_empty());
    }

    #[tokio::test]
    async fn switch_autostash_reports_a_conflicted_reapply() {
        let (dir, repo) = setup_with_feat("switch-conflict").await;
        write(dir.path(), "a.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_switch_autostash_core(&state, repo.clone(), "feat".into(), None, true)
            .await
            .unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::ReapplyConflicted {
                    conflicted: true,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(head_branch(&repo).await, "feat");
        assert!(!stash_list(&repo).await.is_empty());
        assert!(unmerged(&repo).await.contains("a.txt"));
    }

    #[tokio::test]
    async fn switch_autostash_tracks_a_remote_only_branch() {
        let (dir, work, clone) = setup_clone("switch-remote").await;
        let work_dir = dir.path().join("work");
        git(&work, &["switch", "-c", "feat"]).await;
        write(&work_dir, "a.txt", "feat\n");
        commit_all(&work, "feat").await;
        git(&work, &["push", "-u", "origin", "feat"]).await;
        git(&clone, &["fetch"]).await;

        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_switch_autostash_core(
            &state,
            clone.clone(),
            "feat".into(),
            Some("origin".into()),
            true,
        )
        .await
        .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(head_branch(&clone).await, "feat");
        assert_eq!(read(&clone_dir, "a.txt"), "feat\n");
        assert_eq!(read(&clone_dir, "b.txt"), "mine\n");
    }

    // ---- contract ---------------------------------------------------------

    /// The whole feature triggers off git's English refusal wording, matched in
    /// `src/lib/error-summary.ts`. These literals are duplicated here ON PURPOSE:
    /// a git release that rewords one would otherwise kill the recovery flow
    /// silently, and this is the only thing that would notice.
    #[tokio::test]
    async fn refusal_stderr_still_matches_the_frontend_markers() {
        const MERGE_TRACKED: &str =
            "your local changes to the following files would be overwritten by merge";
        const MERGE_UNTRACKED: &str =
            "the following untracked working tree files would be overwritten by merge";
        const CHECKOUT_TRACKED: &str =
            "your local changes to the following files would be overwritten by checkout";
        const CHECKOUT_UNTRACKED: &str =
            "the following untracked working tree files would be overwritten by checkout";
        const REBASE_UNSTAGED: &str = "cannot pull with rebase: you have unstaged changes";
        const REBASE_STAGED: &str =
            "cannot pull with rebase: your index contains uncommitted changes";

        async fn refusal(repo: &str, args: &[&str]) -> String {
            let out = run_git_raw(Some(repo), args, DEFAULT_TIMEOUT)
                .await
                .unwrap();
            assert_ne!(out.code, 0, "expected git to refuse {args:?}");
            out.stderr.to_lowercase()
        }
        fn assert_marker(stderr: &str, marker: &str) {
            assert!(
                stderr.contains(marker),
                "git no longer emits {marker:?} — the frontend classifier is now blind to this \
                 refusal. Actual stderr:\n{stderr}"
            );
        }

        // Tracked overlap: `feat` rewrote a.txt and so did the working tree.
        let (dir, repo) = setup_with_feat("markers-tracked").await;
        write(dir.path(), "a.txt", "dirty\n");
        assert_marker(
            &refusal(&repo, &["merge", "--no-edit", "feat"]).await,
            MERGE_TRACKED,
        );
        assert_marker(&refusal(&repo, &["switch", "feat"]).await, CHECKOUT_TRACKED);

        // Untracked overlap: `feat` adds a file the working tree already has.
        let (dir, repo) = setup_repo("markers-untracked").await;
        git(&repo, &["switch", "-c", "feat"]).await;
        write(dir.path(), "u.txt", "theirs\n");
        commit_all(&repo, "add untracked-to-be").await;
        git(&repo, &["switch", "main"]).await;
        write(dir.path(), "u.txt", "mine\n");
        assert_marker(
            &refusal(&repo, &["merge", "--no-edit", "feat"]).await,
            MERGE_UNTRACKED,
        );
        assert_marker(
            &refusal(&repo, &["switch", "feat"]).await,
            CHECKOUT_UNTRACKED,
        );

        // `pull --rebase` refuses up front, with a different line per dirty kind.
        let (dir, work, clone) = setup_clone("markers-rebase").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        write(&dir.path().join("clone"), "b.txt", "dirty\n");
        assert_marker(
            &refusal(&clone, &["pull", "--rebase"]).await,
            REBASE_UNSTAGED,
        );
        git(&clone, &["add", "b.txt"]).await;
        assert_marker(&refusal(&clone, &["pull", "--rebase"]).await, REBASE_STAGED);
    }

    #[test]
    fn outcome_serializes_to_the_pinned_wire_shape() {
        // The frontend branches on these exact strings; `rename_all` alone does NOT
        // cover fields, so the `stderr` casing is pinned here too.
        let json = |o: &AutostashOutcome| serde_json::to_string(o).unwrap();
        assert_eq!(
            json(&AutostashOutcome::NothingStashed),
            r#"{"kind":"nothingStashed"}"#
        );
        assert_eq!(
            json(&AutostashOutcome::StashedOnly),
            r#"{"kind":"stashedOnly"}"#
        );
        assert_eq!(
            json(&AutostashOutcome::Reapplied),
            r#"{"kind":"reapplied"}"#
        );
        assert_eq!(
            json(&AutostashOutcome::ReapplyConflicted {
                stderr: "boom".into(),
                conflicted: true
            }),
            r#"{"kind":"reapplyConflicted","stderr":"boom","conflicted":true}"#
        );
        assert_eq!(
            json(&AutostashOutcome::ReapplyConflicted {
                stderr: "boom".into(),
                conflicted: false
            }),
            r#"{"kind":"reapplyConflicted","stderr":"boom","conflicted":false}"#
        );
        assert_eq!(
            json(&AutostashOutcome::OpFailedRestored {
                stderr: "boom".into()
            }),
            r#"{"kind":"opFailedRestored","stderr":"boom"}"#
        );
        assert_eq!(
            json(&AutostashOutcome::OpFailedStashKept {
                stderr: "boom".into(),
                in_progress: true
            }),
            r#"{"kind":"opFailedStashKept","stderr":"boom","inProgress":true}"#
        );
        assert_eq!(
            json(&AutostashOutcome::OpFailedStashKept {
                stderr: "boom".into(),
                in_progress: false
            }),
            r#"{"kind":"opFailedStashKept","stderr":"boom","inProgress":false}"#
        );
    }

    #[tokio::test]
    async fn autostash_refuses_mid_merge() {
        let (dir, repo) = setup_with_feat("guard").await;
        write(dir.path(), "a.txt", "main\n");
        commit_all(&repo, "main side").await;
        // A real conflicted merge: unmerged index entries, mid-resolve.
        run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(!unmerged(&repo).await.is_empty());

        let state = AppState::default();
        let err = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
    }

    #[tokio::test]
    async fn autostash_refuses_a_staged_but_uncommitted_merge() {
        let (dir, repo) = setup_with_feat("guard-staged").await;
        write(dir.path(), "a.txt", "main\n");
        commit_all(&repo, "main side").await;
        run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        // Conflicts resolved and staged, merge not committed: no unmerged entries
        // left, so only the op-state half of the guard can catch this.
        write(dir.path(), "a.txt", "resolved\n");
        git(&repo, &["add", "a.txt"]).await;
        assert!(unmerged(&repo).await.is_empty());
        assert!(crate::git::ops::op_state(&repo).await.unwrap().merging);

        let state = AppState::default();
        let err = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
    }

    #[tokio::test]
    async fn settle_keeps_the_stash_when_the_restore_pop_fails() {
        let (dir, repo) = setup_repo("restore-pop-fails").await;
        write(dir.path(), "b.txt", "stashed\n");
        git(&repo, &["stash", "push", "--include-untracked"]).await;
        // A conflicting local edit makes the restore-pop refuse outright, with no
        // op state to explain it.
        write(dir.path(), "b.txt", "blocking\n");
        let op = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "nope"],
            DEFAULT_TIMEOUT,
        )
        .await;

        let outcome = settle(&repo, true, true, op).await.unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::OpFailedStashKept {
                    in_progress: false,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert!(!stderr_of(&outcome).is_empty());
        assert!(!stash_list(&repo).await.is_empty());
        assert_eq!(read(dir.path(), "b.txt"), "blocking\n");
    }

    #[tokio::test]
    async fn settle_reports_an_aborted_pop_as_not_conflicted() {
        let (dir, repo) = setup_repo("pop-aborted").await;
        write(dir.path(), "u.txt", "mine\n");
        git(&repo, &["stash", "push", "--include-untracked"]).await;
        // An untracked file back in the way makes git abort the pop before merging
        // anything: the stash is kept but there is nothing conflicted to resolve.
        write(dir.path(), "u.txt", "other\n");
        let op = run_git_raw(Some(&repo), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await;

        let outcome = settle(&repo, true, true, op).await.unwrap();
        assert!(
            matches!(
                outcome,
                AutostashOutcome::ReapplyConflicted {
                    conflicted: false,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert!(!stderr_of(&outcome).is_empty());
        assert!(!stash_list(&repo).await.is_empty());
        assert!(unmerged(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn a_failure_with_nothing_stashed_matches_the_plain_command_error() {
        let (_dir, repo) = setup_repo("plain-parity").await;
        let state = AppState::default();

        let compound = git_merge_autostash_core(&state, repo.clone(), "nope".into())
            .await
            .unwrap_err();
        let plain = crate::git::ops::git_merge_core(
            &state,
            repo.clone(),
            "nope".into(),
            false,
            false,
            "none".into(),
        )
        .await
        .unwrap_err();

        match (&compound, &plain) {
            (
                AppError::Git {
                    code: a,
                    stderr: a_err,
                },
                AppError::Git {
                    code: b,
                    stderr: b_err,
                },
            ) => {
                assert_eq!(a, b);
                assert_eq!(a_err, b_err);
            }
            other => panic!("expected two git errors, got {other:?}"),
        }
    }
}
