//! App-level stash → op → reapply compounds for pull, merge, rebase and switch.
//!
//! Each command acquires `repo_lock` ONCE and uses only the lock-free runners
//! while holding it — `run_git_mutating` re-acquires the same non-reentrant
//! mutex and deadlocks (precedent: `git_stash_paths_core`). The inner steps
//! therefore lose `run_git_mutating`'s one-shot index.lock retry, the same
//! trade-off that compound accepts.

use tauri::State;

use crate::error::AppResult;
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
///
/// `pub(crate)` for `git::pull_guard`, whose decided-pull compound is this
/// module's shape run from another entry point.
pub(crate) async fn autostash_push(repo: &str) -> AppResult<bool> {
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

/// Turns the inner op's result into an outcome, unwinding the autostash when it can
/// be unwound safely. Never errors on a failed pop — the retained stash is the
/// user's safety net, and reporting it is the whole point of the outcome enum.
///
/// `op_name` is the paused operation the no-stash arm reports — `classify_failure`'s
/// closed set, spelled as the matching plain core spells it.
///
/// `pub(crate)` for `git::pull_guard`, whose decided-pull compound settles the
/// same way this module's do.
pub(crate) async fn settle(
    repo: &str,
    op_name: &str,
    stashed: bool,
    reapply: bool,
    op: AppResult<GitOutput>,
) -> AppResult<AutostashOutcome> {
    // Nothing was stashed, so there is nothing to unwind: behave like the plain
    // command, structured error included — the same failure must not report as a
    // conflict through one entry point and as prose through the other.
    if !stashed {
        let out = op?;
        if out.code != 0 {
            // The baseline is empty because every compound refuses mid-op BEFORE
            // stashing, so nothing was unmerged when the op started (`op_continue`
            // passes an empty one for its own reason). `full_failure_text` because
            // merge and pull both carry half their report on stdout, which the
            // parity tests below pin; switch is the exception in the other direction
            // — a FAILING `git switch` emits no stdout at all (measured across its
            // refusal modes), so the combined text is identical to stderr alone.
            return Err(crate::git::ops::classify_failure(
                repo,
                op_name,
                &[],
                out.code,
                out.full_failure_text(),
            )
            .await);
        }
        return Ok(AutostashOutcome::NothingStashed);
    }

    let failure = match &op {
        Ok(out) if out.code == 0 => None,
        // Combined, matching the no-stash arm and the plain cores:
        // a substitution reports a conflicted pull's fetch summary alone and says
        // nothing about the conflict, so the stashed and unstashed paths would
        // disagree on the same failure.
        Ok(out) => Some(out.full_failure_text()),
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
    // Substitution here, unlike the op-failure arms' combined text: a conflicted pop
    // reports on stdout alone, and a refused pop leads with stderr NAMING the blocking
    // file while its stdout is generic `status` noise (measured, git 2.51.1.windows.1).
    let stderr = match autostash_pop(repo).await {
        Ok(out) if out.code == 0 => return Ok(AutostashOutcome::Reapplied),
        Ok(out) => out.failure_text(),
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
    // Same label as `git_pull_core`: the operation a conflicted pull pauses is the
    // mode it RAN. A refused `--ff-only` leaves nothing unmerged, so its label
    // never surfaces.
    let paused = if mode == "rebase" { "rebase" } else { "merge" };
    // Rebase mode runs the two-phase guard first — bare `git pull --rebase` can
    // silently drop a pushed commit a force-push rewrote away (git::pull_guard).
    // `None` means the guard stood down and this pull proceeds unchanged.
    if mode == "rebase" {
        if let Some(outcome) = crate::git::pull_guard::guarded_pull_autostash(state, &repo_path).await? {
            return Ok(outcome);
        }
    }
    // A read that shells out to git itself — resolve it BEFORE taking the lock.
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    let op = run_git_with_creds_once(&repo_path, &cred, &["pull", flag], NETWORK_TIMEOUT).await;
    settle(&repo_path, paused, stashed, true, op).await
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
    settle(&repo_path, "merge", stashed, true, op).await
}

/// Rebase the current branch onto `branch` with the uncommitted changes stashed
/// across the rebase and reapplied afterwards. Rebase refuses on ANY dirty
/// tracked file, not just one the replay would touch, so this is the arm that
/// fires most often.
#[tauri::command]
pub async fn git_rebase_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
) -> AppResult<AutostashOutcome> {
    git_rebase_autostash_core(&state, repo_path, branch).await
}

pub(crate) async fn git_rebase_autostash_core(
    state: &AppState,
    repo_path: String,
    branch: String,
) -> AppResult<AutostashOutcome> {
    validate_ref_name(&branch)?;

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    // Inlined rather than delegating to `git_rebase_core`: that one runs through
    // `run_git_mutating_raw`, which re-acquires the lock held here (module doc).
    // `core.editor=true` mirrors it so git never blocks on an editor.
    let op = run_git_raw(
        Some(&repo_path),
        &["-c", "core.editor=true", "rebase", &branch],
        DEFAULT_TIMEOUT,
    )
    .await;
    settle(&repo_path, "rebase", stashed, true, op).await
}

/// `git rebase --onto <new_base> <old_base>` — replaying only `old_base..HEAD`
/// — with the uncommitted changes stashed across it and reapplied afterwards.
#[tauri::command]
pub async fn git_rebase_onto_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    new_base: String,
    old_base: String,
) -> AppResult<AutostashOutcome> {
    git_rebase_onto_autostash_core(&state, repo_path, new_base, old_base).await
}

pub(crate) async fn git_rebase_onto_autostash_core(
    state: &AppState,
    repo_path: String,
    new_base: String,
    old_base: String,
) -> AppResult<AutostashOutcome> {
    validate_ref_name(&new_base)?;
    validate_ref_name(&old_base)?;

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;

    let stashed = autostash_push(&repo_path).await?;
    // Inlined for the same reason as `git_rebase_autostash_core` above.
    let op = run_git_raw(
        Some(&repo_path),
        &[
            "-c",
            "core.editor=true",
            "rebase",
            "--onto",
            &new_base,
            &old_base,
        ],
        DEFAULT_TIMEOUT,
    )
    .await;
    settle(&repo_path, "rebase", stashed, true, op).await
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
    // Unreachable as a label: a refused `git switch` leaves nothing unmerged, so
    // `classify_failure` always answers with a plain git error here. "merge" is the
    // closed set's spelling for the only way a checkout could ever pause one.
    settle(&repo_path, "merge", stashed, reapply, op).await
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only import: the module's own code shapes every failure through
    // `classify_failure`, so only the error assertions name the enum.
    use crate::error::AppError;

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

    /// The clone has PUSHED `V`, and the upstream has since force-pushed over it
    /// — the state a bare `git pull --rebase` replays out of existence. Returns
    /// the fixture guard, the clone's path, and V's sha.
    async fn setup_vaporize(marker: &str) -> (tempfile::TempDir, String, String) {
        let (dir, work, clone) = setup_clone(marker).await;
        let work_dir = dir.path().join("work");
        let clone_dir = dir.path().join("clone");

        write(&clone_dir, "v.txt", "v\n");
        commit_all(&clone, "V the victim").await;
        git(&clone, &["push"]).await;
        let victim = git(&clone, &["rev-parse", "HEAD"]).await.trim().to_string();

        git(&work, &["fetch"]).await;
        git(&work, &["reset", "--hard", "origin/main~1"]).await;
        write(&work_dir, "r.txt", "r\n");
        commit_all(&work, "teammate rewrite").await;
        git(&work, &["push", "--force"]).await;
        (dir, clone, victim)
    }

    /// Phase A runs BEFORE the stash, so a refused pull leaves the dirty tree
    /// exactly as it was — nothing stashed, nothing to settle.
    #[tokio::test]
    async fn pull_autostash_refuses_a_would_drop_before_stashing() {
        let (dir, clone, victim) = setup_vaporize("would-drop").await;
        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "b.txt", "dirty\n");

        let state = AppState::default();
        let err = git_pull_autostash_core(&state, clone.clone(), "rebase".into())
            .await
            .expect_err("a pull that would drop a pushed commit must refuse");
        assert!(
            matches!(&err, AppError::PullRebaseWouldDrop(d) if d.commits.len() == 1),
            "{err:?}"
        );
        assert!(
            stash_list(&clone).await.is_empty(),
            "the refusal comes before the stash"
        );
        assert_eq!(read(&clone_dir, "b.txt"), "dirty\n");
        assert_eq!(git(&clone, &["rev-parse", "HEAD"]).await.trim(), victim);
    }

    /// And with nothing being rewritten away, the compound behaves exactly as it
    /// did: stash, rebase, reapply.
    #[tokio::test]
    async fn pull_autostash_rebases_and_reapplies_when_nothing_would_drop() {
        let (dir, work, clone) = setup_clone("rebase-reapply").await;
        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        let clone_dir = dir.path().join("clone");
        write(&clone_dir, "b.txt", "local commit\n");
        commit_all(&clone, "local").await;
        write(&clone_dir, "c.txt", "dirty\n");

        let state = AppState::default();
        let outcome = git_pull_autostash_core(&state, clone.clone(), "rebase".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(read(&clone_dir, "a.txt"), "upstream\n");
        assert_eq!(read(&clone_dir, "b.txt"), "local commit\n");
        assert_eq!(read(&clone_dir, "c.txt"), "dirty\n");
        assert!(stash_list(&clone).await.is_empty());
        // The local commit was replayed on top of the upstream one.
        assert_eq!(
            git(&clone, &["log", "--format=%s"])
                .await
                .lines()
                .take(2)
                .collect::<Vec<_>>(),
            vec!["local", "upstream"]
        );
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

    // ---- rebase -----------------------------------------------------------

    #[tokio::test]
    async fn rebase_autostash_reapplies_non_overlapping_changes() {
        let (dir, repo) = setup_with_feat("rebase-reapply").await;
        // Plain `rebase` refuses on a dirty `b.txt` even though the replay never
        // touches it — the gap this compound closes.
        write(dir.path(), "b.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_rebase_autostash_core(&state, repo.clone(), "feat".into())
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
    async fn rebase_autostash_reports_a_conflicted_reapply() {
        let (dir, repo) = setup_with_feat("rebase-conflict").await;
        write(dir.path(), "a.txt", "mine\n");

        let state = AppState::default();
        let outcome = git_rebase_autostash_core(&state, repo.clone(), "feat".into())
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
    async fn rebase_autostash_on_a_clean_tree_stashes_nothing() {
        let (dir, repo) = setup_with_feat("rebase-clean").await;

        let state = AppState::default();
        let outcome = git_rebase_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::NothingStashed),
            "{outcome:?}"
        );
        assert_eq!(read(dir.path(), "a.txt"), "feat\n");
        assert!(stash_list(&repo).await.is_empty());
    }

    #[tokio::test]
    async fn rebase_autostash_restores_changes_when_the_rebase_is_rejected() {
        let (dir, repo) = setup_with_feat("rebase-restore").await;
        write(dir.path(), "b.txt", "dirty\n");

        let state = AppState::default();
        // An unknown upstream fails before any replay starts — nothing in progress.
        let outcome = git_rebase_autostash_core(&state, repo.clone(), "nope".into())
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
    async fn rebase_autostash_keeps_the_stash_when_the_rebase_conflicts() {
        let (dir, repo) = setup_with_feat("rebase-kept").await;
        write(dir.path(), "a.txt", "main\n");
        commit_all(&repo, "main side").await;
        write(dir.path(), "b.txt", "dirty\n");

        let state = AppState::default();
        let outcome = git_rebase_autostash_core(&state, repo.clone(), "feat".into())
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
        // A conflicted rebase splits its report across both streams, so the
        // combined shaping has to carry the stdout half too.
        let stderr = stderr_of(&outcome);
        assert!(stderr.contains("could not apply"), "{stderr}");
        assert!(stderr.contains("CONFLICT ("), "{stderr}");
        assert!(crate::git::ops::op_state(&repo).await.unwrap().rebasing);
        assert!(!stash_list(&repo).await.is_empty());
    }

    /// `topic` branched off `wrong` when it meant to sit on `main` — the shape
    /// `rebase --onto main wrong` fixes, replaying `topic`'s own commit only.
    async fn setup_with_wrong_base(marker: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        git(&repo, &["switch", "-c", "wrong"]).await;
        write(dir.path(), "c.txt", "wrong base\n");
        commit_all(&repo, "wrong base work").await;
        git(&repo, &["switch", "-c", "topic"]).await;
        write(dir.path(), "d.txt", "topic\n");
        commit_all(&repo, "topic work").await;
        (dir, repo)
    }

    #[tokio::test]
    async fn rebase_onto_autostash_reapplies_and_drops_the_old_base() {
        let (dir, repo) = setup_with_wrong_base("rebase-onto-reapply").await;
        write(dir.path(), "b.txt", "mine\n");

        let state = AppState::default();
        let outcome =
            git_rebase_onto_autostash_core(&state, repo.clone(), "main".into(), "wrong".into())
                .await
                .unwrap();
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        // `topic`'s own commit moved; the wrong base's did not come along.
        assert_eq!(read(dir.path(), "d.txt"), "topic\n");
        assert!(!dir.path().join("c.txt").exists());
        assert_eq!(read(dir.path(), "b.txt"), "mine\n");
        assert!(stash_list(&repo).await.is_empty());
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
        const PULL_REBASE_UNSTAGED: &str = "cannot pull with rebase: you have unstaged changes";
        const PULL_REBASE_STAGED: &str =
            "cannot pull with rebase: your index contains uncommitted changes";
        const REBASE_UNSTAGED: &str = "cannot rebase: you have unstaged changes";
        const REBASE_STAGED: &str = "cannot rebase: your index contains uncommitted changes";

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
            PULL_REBASE_UNSTAGED,
        );
        git(&clone, &["add", "b.txt"]).await;
        assert_marker(
            &refusal(&clone, &["pull", "--rebase"]).await,
            PULL_REBASE_STAGED,
        );

        // A plain `rebase` refuses on ANY dirty tracked file, overlapping or not
        // — `b.txt` is untouched by `feat` on purpose — and says it in its own
        // wording, which the "cannot pull with rebase" lines above do not cover.
        let (dir, repo) = setup_with_feat("markers-rebase-plain").await;
        write(dir.path(), "b.txt", "dirty\n");
        assert_marker(&refusal(&repo, &["rebase", "feat"]).await, REBASE_UNSTAGED);
        git(&repo, &["add", "b.txt"]).await;
        assert_marker(&refusal(&repo, &["rebase", "feat"]).await, REBASE_STAGED);

        // `--onto` refuses with the same two lines, so one marker pair covers both
        // compounds.
        let (dir, repo) = setup_with_feat("markers-rebase-onto").await;
        write(dir.path(), "b.txt", "dirty\n");
        assert_marker(
            &refusal(&repo, &["rebase", "--onto", "feat", "main"]).await,
            REBASE_UNSTAGED,
        );
        git(&repo, &["add", "b.txt"]).await;
        assert_marker(
            &refusal(&repo, &["rebase", "--onto", "feat", "main"]).await,
            REBASE_STAGED,
        );
    }

    /// The FALLBACK conflict summary in `src/lib/error-summary.ts` keys off the
    /// ANCHORED shapes of these lines — the arm that classifies any producer not
    /// carrying `AppError::Conflict`, this compound's own outcomes included — so a
    /// git release that reworded one would silently change how those present.
    /// Markers 1-2 guard live toast classification; markers 3-4 ride stdout, which
    /// only the paths shaping their error through `GitOutput::failure_text` /
    /// `full_failure_text` carry.
    ///
    /// The STREAM SPLIT each family reports on is pinned here too, because the
    /// shaping choice depends on it: a family that writes to both streams needs
    /// the combined text, and a substitution would silently drop half its report.
    #[tokio::test]
    async fn conflict_output_still_matches_the_anchored_frontend_markers() {
        // Mirrors of the four CONFLICT_MARKERS regexes, in plain string ops.
        // Splitting on a bare CR as well as LF mirrors ECMAScript `/m`, which ends
        // a line at either; git has been observed joining its `Rebasing (n/m)`
        // progress to the diagnostic that follows with one.
        fn lines(text: &str) -> std::str::Split<'_, [char; 2]> {
            text.split(['\n', '\r'])
        }
        // Mirrors CONFLICT_MARKERS[0], which covers BOTH verbs — rebase and
        // cherry-pick echo `could not apply`, revert `could not revert`, and for a
        // revert that line is the only conflict evidence the error carries. Same
        // shape as `is_subject_echo` on purpose (see the marker's comment).
        fn could_not_apply_or_revert(text: &str) -> bool {
            lines(text).any(is_subject_echo)
        }
        fn resolve_all_conflicts(text: &str) -> bool {
            lines(text).any(|line| {
                line.strip_prefix("error: ")
                    .or_else(|| line.strip_prefix("hint: "))
                    .is_some_and(|rest| rest.starts_with("Resolve all conflicts"))
            })
        }
        fn conflict_paren(text: &str) -> bool {
            lines(text).any(|line| line.starts_with("CONFLICT ("))
        }
        fn needs_merge(text: &str) -> bool {
            lines(text).any(|line| line.trim_end().ends_with(": needs merge"))
        }
        // Mirrors SUBJECT_ECHO_LINE + OP_ADVICE (error-summary.ts): the paused op
        // is read from `git <op> --continue` advice ONLY — never an `--abort`
        // remedy, and never the line that echoes the commit subject.
        fn is_subject_echo(line: &str) -> bool {
            let rest = line.strip_prefix("error: ").unwrap_or(line);
            [
                "could not apply ",
                "Could not apply ",
                "could not revert ",
                "Could not revert ",
            ]
            .iter()
            .any(|prefix| rest.starts_with(prefix))
        }
        fn advises_continue(text: &str, op: &str) -> bool {
            let advice = format!("git {op} --continue");
            lines(text).any(|line| !is_subject_echo(line) && line.contains(&advice))
        }
        fn assert_shape(matched: bool, shape: &str, output: &str) {
            assert!(
                matched,
                "git no longer emits a line shaped {shape:?} — the frontend classifier is now \
                 blind to this conflict. Actual output:\n{output}"
            );
        }

        let (dir, repo) = setup_repo("conflict-markers").await;
        git(&repo, &["switch", "-c", "feat"]).await;
        write(dir.path(), "a.txt", "theirs\n");
        // The subject names a DIFFERENT op on purpose: git echoes it onto the
        // `could not apply` line, where only the anchor keeps it from classifying.
        commit_all(&repo, "rebase the parser").await;
        git(&repo, &["switch", "main"]).await;
        write(dir.path(), "a.txt", "mine\n");
        commit_all(&repo, "local change").await;

        let cherry = run_git_raw(Some(&repo), &["cherry-pick", "feat"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(cherry.code, 0, "expected the cherry-pick to conflict");
        assert_shape(
            could_not_apply_or_revert(&cherry.stderr),
            "error: could not apply <sha>…",
            &cherry.stderr,
        );
        assert_shape(
            conflict_paren(&cherry.stdout_lossy()),
            "CONFLICT (…",
            &cherry.stdout_lossy(),
        );
        // The split itself: both halves non-empty, which is why the sequencer
        // families shape their error with `full_failure_text` rather than
        // substituting one stream for the other.
        assert!(
            !cherry.stderr.trim().is_empty() && !cherry.stdout_lossy().trim().is_empty(),
            "a conflicted cherry-pick still splits its report across both streams — \
             stderr:\n{}\nstdout:\n{}",
            cherry.stderr,
            cherry.stdout_lossy()
        );
        assert!(
            advises_continue(&cherry.stderr, "cherry-pick"),
            "git no longer advises `git cherry-pick --continue` outside the subject-echo line — \
             the frontend would name every paused cherry-pick \"Operation\". Actual stderr:\n{}",
            cherry.stderr
        );
        git(&repo, &["cherry-pick", "--abort"]).await;

        let rebase = run_git_raw(Some(&repo), &["rebase", "feat"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(rebase.code, 0, "expected the rebase to conflict");
        assert_shape(
            resolve_all_conflicts(&rebase.stderr),
            "hint: Resolve all conflicts…",
            &rebase.stderr,
        );
        assert_shape(
            could_not_apply_or_revert(&rebase.stderr),
            "Could not apply <sha>…",
            &rebase.stderr,
        );
        assert!(
            advises_continue(&rebase.stderr, "rebase"),
            "git no longer advises `git rebase --continue` outside the subject-echo line — \
             the frontend would name every paused rebase \"Operation\". Actual stderr:\n{}",
            rebase.stderr
        );

        assert!(
            !rebase.stderr.trim().is_empty() && !rebase.stdout_lossy().trim().is_empty(),
            "a conflicted rebase still splits its report across both streams — \
             stderr:\n{}\nstdout:\n{}",
            rebase.stderr,
            rebase.stdout_lossy()
        );

        // Continuing without resolving is the one sequencer case that is
        // stdout-ONLY: `core.editor` is pinned so a future git that got past the
        // check can't block on an editor. `op_continue` shapes its error through
        // the combined text, so an empty stderr here must not swallow the report.
        let cont = run_git_raw(
            Some(&repo),
            &["-c", "core.editor=true", "rebase", "--continue"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(cont.code, 0, "expected --continue to refuse unmerged files");
        assert_shape(
            needs_merge(&cont.stdout_lossy()),
            "<path>: needs merge",
            &cont.stdout_lossy(),
        );
        assert!(
            cont.stderr.trim().is_empty(),
            "a refused `rebase --continue` still reports on stdout alone — the reason \
             op_continue carries stdout into its error. Actual stderr:\n{}",
            cont.stderr
        );
        git(&repo, &["rebase", "--abort"]).await;

        // Revert: its own advice verb, the `could not revert` echo on stderr, and
        // the `CONFLICT (…` list on stdout — `git_revert_core` carries both, so
        // both are pinned. Reverting the SECOND-newest commit conflicts; the
        // newest would apply cleanly.
        write(dir.path(), "a.txt", "one\n");
        commit_all(&repo, "one").await;
        write(dir.path(), "a.txt", "two\n");
        commit_all(&repo, "two").await;
        let revert = run_git_raw(
            Some(&repo),
            &["revert", "--no-edit", "HEAD~1"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(revert.code, 0, "expected the revert to conflict");
        assert_shape(
            could_not_apply_or_revert(&revert.stderr),
            "error: could not revert <sha>…",
            &revert.stderr,
        );
        assert_shape(
            conflict_paren(&revert.stdout_lossy()),
            "CONFLICT (…",
            &revert.stdout_lossy(),
        );
        assert!(
            !revert.stderr.trim().is_empty() && !revert.stdout_lossy().trim().is_empty(),
            "a conflicted revert still splits its report across both streams — \
             stderr:\n{}\nstdout:\n{}",
            revert.stderr,
            revert.stdout_lossy()
        );
        assert!(
            advises_continue(&revert.stderr, "revert"),
            "git no longer advises `git revert --continue` outside the subject-echo line — \
             the frontend would name every paused revert \"Operation\". Actual stderr:\n{}",
            revert.stderr
        );
        git(&repo, &["revert", "--abort"]).await;

        // Merge is the one conflict family with NO `--continue` advice: it reports
        // on stdout and leaves stderr EMPTY, so the frontend reads the verdict line
        // to name it. Asserting the advice here would fail against correct git —
        // this pins the reality instead.
        let merge = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merge.code, 0, "expected the merge to conflict");
        assert_shape(
            conflict_paren(&merge.stdout_lossy()),
            "CONFLICT (…",
            &merge.stdout_lossy(),
        );
        // Line-anchored, mirroring MERGE_VERDICT (error-summary.ts) — that is the
        // only line naming the op for a merge, since there is no advice to read.
        assert_shape(
            lines(&merge.stdout_lossy()).any(|l| l.starts_with("Automatic merge failed")),
            "Automatic merge failed…",
            &merge.stdout_lossy(),
        );
        assert!(
            merge.stderr.trim().is_empty(),
            "a conflicted merge still leaves stderr empty — the reason git_merge_core \
             backfills stdout. Actual stderr:\n{}",
            merge.stderr
        );

        // A merge-mode PULL is the same conflict on stdout, but its stderr is NOT
        // empty: the fetch writes its summary there. That combination is what makes
        // a stderr-or-stdout substitution a silent no-op for pull, and the reason
        // `run_git_mutating_with_creds` shapes with `full_failure_text`.
        let (pull_dir, work, clone) = setup_clone("conflict-markers-pull").await;
        write(&pull_dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;
        write(&pull_dir.path().join("clone"), "a.txt", "mine\n");
        commit_all(&clone, "local").await;

        let pull = run_git_raw(Some(&clone), &["pull", "--no-rebase"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(pull.code, 0, "expected the pull to conflict");
        assert_shape(
            conflict_paren(&pull.stdout_lossy()),
            "CONFLICT (…",
            &pull.stdout_lossy(),
        );
        assert_shape(
            lines(&pull.stdout_lossy()).any(|l| l.starts_with("Automatic merge failed")),
            "Automatic merge failed…",
            &pull.stdout_lossy(),
        );
        assert!(
            !pull.stderr.trim().is_empty(),
            "a conflicted pull still writes its fetch summary to stderr — the reason \
             substituting stdout for an empty stderr would drop the merge verdict"
        );
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
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("conflict is in progress")),
            "{err:?}"
        );
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
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("merge, rebase, cherry-pick or revert is in progress")),
            "{err:?}"
        );
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

        let outcome = settle(&repo, "merge", true, true, op).await.unwrap();
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

        let outcome = settle(&repo, "merge", true, true, op).await.unwrap();
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

    /// The same parity in the shape that actually loses information: a conflicted
    /// merge reports on STDOUT and leaves stderr empty, and this arm is reached
    /// exactly when nothing was stashed — the clean tree a dirty-tree recovery
    /// leaves behind once the user commits or the changes are already away.
    /// Pull has its own arm below (a different stream split); switch never will,
    /// since a failing `git switch` writes no stdout to lose.
    ///
    /// The parity covers the VARIANT as well as git's text: both sides name the
    /// paused operation structurally, so the frontend cannot tell which entry
    /// point produced the error.
    #[tokio::test]
    async fn a_conflict_with_nothing_stashed_carries_the_stdout_report() {
        let (dir, repo) = setup_with_feat("plain-parity-conflict").await;
        // Diverge `main` so the merge conflicts instead of fast-forwarding, and
        // leave the tree CLEAN so `settle` takes its no-stash arm.
        write(dir.path(), "a.txt", "mine\n");
        commit_all(&repo, "local change").await;
        let state = AppState::default();

        let compound = git_merge_autostash_core(&state, repo.clone(), "feat".into())
            .await
            .unwrap_err();
        assert!(stash_list(&repo).await.is_empty(), "nothing was stashed");
        git(&repo, &["merge", "--abort"]).await;
        let plain = crate::git::ops::git_merge_core(
            &state,
            repo.clone(),
            "feat".into(),
            false,
            false,
            "none".into(),
        )
        .await
        .unwrap_err();
        git(&repo, &["merge", "--abort"]).await;

        match (&compound, &plain) {
            (
                AppError::Conflict {
                    op: a_op,
                    paths: a_paths,
                    report: a_err,
                },
                AppError::Conflict {
                    op: b_op,
                    paths: b_paths,
                    report: b_err,
                },
            ) => {
                assert_eq!(a_err, b_err);
                assert_eq!(a_op, b_op);
                assert_eq!(a_op, "merge");
                assert_eq!(a_paths, b_paths);
                assert_eq!(a_paths, &vec!["a.txt".to_string()]);
                // Mirrors the frontend's anchored CONFLICT_MARKERS: without the
                // stdout backfill both sides carry an empty report instead, which
                // renders as "git exited with code 1".
                assert!(
                    a_err.lines().any(|l| l.starts_with("CONFLICT (")),
                    "the conflict line must reach the frontend: {a_err}"
                );
                assert!(
                    a_err.contains("Automatic merge failed"),
                    "and the verdict line that names it a merge: {a_err}"
                );
            }
            other => panic!("expected two conflicts, got {other:?}"),
        }
    }

    /// Pull's version of the same parity, on the split that hides the loss: the
    /// fetch summary fills stderr while the merge verdict rides stdout, so an
    /// error carrying stderr alone looks populated and still says nothing about
    /// the conflict. Both sides must carry the whole report, identically, and both
    /// must name the operation they paused.
    #[tokio::test]
    async fn a_conflicted_pull_with_nothing_stashed_carries_the_stdout_report() {
        let (dir, work, clone) = setup_clone("pull-parity-conflict").await;
        // TWO clones, one per side: the fetch half of a pull reports
        // `<old>..<new> main -> origin/main` on stderr and only when a ref
        // actually moves, so running both pulls in ONE clone would compare a
        // fetching pull against an already-up-to-date one. Cloned before the
        // upstream push so each is behind by the same commit.
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["-c", "core.autocrlf=false", "clone", &url, "clone2"]).await;
        let clone2 = dir.path().join("clone2").to_string_lossy().into_owned();
        configure(&clone2).await;

        write(&dir.path().join("work"), "a.txt", "upstream\n");
        commit_all(&work, "upstream").await;
        git(&work, &["push"]).await;

        // A local commit on the same file diverges each branch, so `--no-rebase`
        // merges and conflicts; both trees stay CLEAN so `settle` takes its
        // no-stash arm.
        for (path, repo) in [("clone", &clone), ("clone2", &clone2)] {
            write(&dir.path().join(path), "a.txt", "mine\n");
            commit_all(repo, "local").await;
        }
        let state = AppState::default();

        let compound = git_pull_autostash_core(&state, clone.clone(), "merge".into())
            .await
            .unwrap_err();
        assert!(stash_list(&clone).await.is_empty(), "nothing was stashed");
        let plain = crate::git::remote::git_pull_core(&state, clone2.clone(), "merge".into())
            .await
            .unwrap_err();

        match (&compound, &plain) {
            (
                AppError::Conflict {
                    op: a_op,
                    paths: a_paths,
                    report: a_err,
                },
                AppError::Conflict {
                    op: b_op,
                    paths: b_paths,
                    report: b_err,
                },
            ) => {
                assert_eq!(a_err, b_err);
                assert_eq!(a_op, b_op);
                assert_eq!(a_op, "merge", "a merge-mode pull pauses a merge");
                assert_eq!(a_paths, b_paths);
                assert_eq!(a_paths, &vec!["a.txt".to_string()]);
                assert!(
                    a_err.lines().any(|l| l.starts_with("CONFLICT (")),
                    "the conflict line must reach the frontend: {a_err}"
                );
                assert!(
                    a_err.contains("Automatic merge failed"),
                    "and the verdict line that names it a merge: {a_err}"
                );
            }
            other => panic!("expected two conflicts, got {other:?}"),
        }
    }
}
