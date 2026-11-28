use super::*;

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    repo_path: String,
    mode: String,
) -> AppResult<()> {
    git_pull_core(&state, repo_path, mode).await
}

pub(crate) async fn git_pull_core(
    state: &AppState,
    repo_path: String,
    mode: String,
) -> AppResult<()> {
    // "rebase"/"merge" reconcile a diverged branch; the default stays the safe
    // fast-forward-only. A conflicted rebase/merge surfaces in the conflict UI.
    let flag = match mode.as_str() {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    // The paused operation a conflicted pull leaves behind is the mode it RAN, so
    // it is named here rather than inside the runner: `run_git_mutating_with_creds`
    // also carries fetch and push, whose failures are never a paused conflict and
    // would each pay for an unmerged probe that can only come back empty.
    // A refused `--ff-only` leaves nothing unmerged, so its label never surfaces.
    let op = if mode == "rebase" { "rebase" } else { "merge" };
    // Every mode splits into a network phase and a local one (git::pull_guard), so the
    // transfer holds the network domain alone and staging stays available across it.
    // Rebase mode additionally runs the fork-point guard there — bare
    // `git pull --rebase` computes its own fork point and can silently drop a pushed
    // commit a force-push rewrote away.
    if mode == "rebase" {
        if crate::git::pull_guard::guarded_pull(state, &repo_path).await? {
            return Ok(());
        }
    } else if let Some(plain) =
        crate::git::pull_guard::pin_plain_pull(state, &repo_path, mode != "merge").await?
    {
        return crate::git::pull_guard::merge_pinned(state, &repo_path, &plain).await;
    }
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    // The fall-through, for every state the split phases stand down on (each listed at
    // `pin_plain_pull` / `guarded_pull`): bare `git pull` is a transfer AND a merge in
    // one command, so it needs both domains — the working tree here, the network inside
    // `run_git_mutating_with_creds` — that order only (see `run_git_mutating`). The
    // split phases above take their own locks and must stay outside this hold.
    let wt = state.working_tree_lock(&repo_path).await;
    let _wt_guard = acquire_repo_lock(&wt, LOCK_WAIT_TIMEOUT, "a pull").await?;
    let already_unmerged = crate::git::ops::unmerged_paths(&repo_path).await;
    // Commits the pull's own transfer brings are not checked.
    if mode != "rebase"
        && !ignored_guard::merge_is_blocked(&repo_path, &already_unmerged)
            .await
            .map_err(|e| ignored_guard::check_failed("Pull", e))?
    {
        if let Some(target) = ignored_guard::upstream_commit(&repo_path).await? {
            if ignored_guard::pull_can_merge(&repo_path, &target, mode != "merge").await? {
                let paths = ignored_files_in_the_way(&repo_path, &target, WORKTREE_OP_TIMEOUT)
                    .await
                    .map_err(|e| ignored_guard::check_failed("Pull", e))?;
                if !paths.is_empty() {
                    return Err(ignored_guard::pull_refusal(&paths));
                }
            }
        }
    }
    if let Err(err) =
        run_git_mutating_with_creds(state, &repo_path, &cred, &["pull", flag], NETWORK_TIMEOUT).await
    {
        // The runner already folded both streams into `stderr`, so the report is
        // relabeled here rather than re-running git.
        return Err(match err {
            AppError::Git { code, stderr } => {
                crate::git::ops::classify_failure(
                    &repo_path,
                    op,
                    &already_unmerged,
                    code,
                    stderr,
                )
                .await
            }
            other => other,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{init_repo, run, seeded_origin, temp_base};
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    /// A clone diverged from its origin on `a.txt`, so a reconciling pull in
    /// either mode conflicts. Returns the temp guard (drop removes the fixture)
    /// and the clone's path.
    async fn diverged_clone(tag: &str) -> (tempfile::TempDir, String) {
        let (guard, base) = temp_base(tag);
        let origin = base.join("origin.git");
        let work = base.join("work");
        let clone = base.join("clone");
        std::fs::create_dir_all(&work).unwrap();
        let base_s = base.to_string_lossy().into_owned();
        let work_s = work.to_string_lossy().into_owned();
        let clone_s = clone.to_string_lossy().into_owned();
        let url = format!("file://{}", origin.to_string_lossy().replace('\\', "/"));

        run(&base_s, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        init_repo(&work_s, "a.txt").await;
        run(&work_s, &["branch", "-M", "main"]).await;
        run(&work_s, &["remote", "add", "origin", &url]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "main"]).await;
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream"]).await;
        run(&work_s, &["push", "-q"]).await;
        std::fs::write(clone.join("a.txt"), "mine\n").unwrap();
        run(&clone_s, &["commit", "-qam", "local"]).await;
        (guard, clone_s)
    }

    /// A pull that conflicts leaves a PAUSED merge/rebase, and `git_pull_core` is
    /// where that gets named — the runner it goes through also carries fetch and
    /// push, whose failures are never paused.
    #[tokio::test]
    async fn a_conflicted_pull_reports_a_paused_merge() {
        let (_guard, clone_s) = diverged_clone("pull-conflict-op").await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "merge".into())
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "merge", "a merge-mode pull pauses a merge");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        // Both halves: the fetch summary fills stderr while the merge verdict and
        // its file list ride stdout, so either alone loses the conflict.
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            report.contains("Automatic merge failed"),
            "and the verdict line with it: {report}"
        );
    }

    /// The other half of the mode→op branch: the same divergence pulled with
    /// `--rebase` leaves a paused REBASE, and the frontend's copy for the two
    /// differs (a merge finishes with a commit, a rebase with `--continue`).
    #[tokio::test]
    async fn a_conflicted_rebase_pull_reports_a_paused_rebase() {
        let (_guard, clone_s) = diverged_clone("pull-conflict-rebase").await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "rebase", "a rebase-mode pull pauses a rebase");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "and the rebase really is the operation left in progress"
        );
    }

    /// Pulling on a tree already paused on a MERGE: git refuses without touching
    /// the index ("Pulling is not possible because you have unmerged files",
    /// measured on git 2.51.1), so the only unmerged path belongs to that merge.
    /// Attributing it to the pull would toast "Rebase paused…" over a tree whose
    /// conflict banner reads *merge*.
    #[tokio::test]
    async fn a_pull_refused_over_someone_elses_conflict_is_not_a_paused_rebase() {
        let (_guard, clone_s) = diverged_clone("pull-refused-misattrib").await;
        // Pause a merge from a side branch, so the tree is unmerged before the pull.
        run(&clone_s, &["switch", "-q", "-c", "side", "HEAD~1"]).await;
        std::fs::write(
            std::path::Path::new(&clone_s).join("a.txt"),
            "side\n",
        )
        .unwrap();
        run(&clone_s, &["commit", "-qam", "side"]).await;
        run(&clone_s, &["switch", "-q", "main"]).await;
        let merged = run_git(
            Some(&clone_s),
            &["merge", "--no-edit", "side"],
            TEST_GIT_HANG_GUARD,
        )
        .await;
        assert!(merged.is_err(), "the fixture's merge must conflict");
        assert!(crate::git::ops::op_state(&clone_s).await.unwrap().merging);

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .unwrap_err();
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a plain git error, got {err:?}");
        };
        assert!(
            stderr.contains("unmerged files"),
            "git's own refusal must reach the user: {stderr}"
        );
        assert!(
            !crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "no rebase was ever started — naming one would contradict the banner"
        );
    }

    // --- The rebase fork-point guard, merge mode, and the fall-through's ignored guard. ---

    /// A clone whose PUSHED commit `V` the upstream then force-pushed away — the
    /// state a bare `git pull --rebase` replays out of existence. Returns the
    /// fixture guard, the clone's path, V's sha, and the rewritten origin tip.
    ///
    /// The push is what arms it: it writes V into the clone's
    /// `refs/remotes/origin/main` reflog, which is where fork-point reads it.
    async fn vaporize_clone(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, base, _origin_s, url) = seeded_origin(tag).await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(clone.join("v.txt"), "v\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "V the victim"]).await;
        run(&clone_s, &["push", "-q"]).await;
        let victim = run(&clone_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        run(&work_s, &["fetch", "-q"]).await;
        run(&work_s, &["reset", "-q", "--hard", "origin/main~1"]).await;
        std::fs::write(work.join("r.txt"), "r\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "teammate rewrite"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;
        let rewritten = run(&work_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        (guard, clone_s, victim, rewritten)
    }

    async fn head_of(repo: &str, rev: &str) -> String {
        run(repo, &["rev-parse", rev]).await.trim().to_string()
    }

    async fn subjects(repo: &str) -> Vec<String> {
        run(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The whole point: a teammate's force-push over a commit the user already
    /// pushed makes bare `git pull --rebase` drop it silently ("Successfully
    /// rebased", no conflict). The guard refuses instead, naming the commit — and
    /// leaves the branch and the working tree exactly where it found them.
    #[tokio::test]
    async fn a_rebase_pull_refuses_to_vaporize_a_force_pushed_commit() {
        let (_guard, clone_s, victim, rewritten) = vaporize_clone("vaporize").await;
        assert_eq!(
            head_of(&clone_s, "refs/remotes/origin/main").await,
            victim,
            "the clone has not seen the rewrite yet — the guard's own fetch must"
        );

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("a pull that would drop a pushed commit must refuse");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.branch, "main");
        assert_eq!(drop.upstream, "origin/main");
        assert_eq!(drop.branch_tip, victim);
        assert_eq!(
            drop.fork_point, victim,
            "V is the fork point the reflog remembers"
        );
        assert_eq!(drop.new_tip, rewritten);
        assert_eq!(
            drop.merge_base,
            head_of(&clone_s, &format!("{victim}~1")).await,
            "the merge base is V's parent — the last commit both sides share"
        );
        assert_eq!(drop.commits.len(), 1, "{:?}", drop.commits);
        assert_eq!(drop.commits[0].sha, victim);
        assert_eq!(drop.commits[0].subject, "V the victim");
        assert_eq!(drop.commits[0].author, "T");
        assert!(
            drop.commits[0].author_date.starts_with("20"),
            "the ISO author date must be populated: {:?}",
            drop.commits[0].author_date
        );

        // The guard fetched (that is how it learned of the rewrite) and then
        // touched nothing else.
        assert_eq!(head_of(&clone_s, "refs/remotes/origin/main").await, rewritten);
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
        assert_eq!(subjects(&clone_s).await.first().unwrap(), "V the victim");
        assert!(
            run(&clone_s, &["status", "--porcelain"]).await.trim().is_empty(),
            "the working tree is untouched"
        );
        assert!(run(&clone_s, &["stash", "list"]).await.trim().is_empty());
        assert!(!crate::git::ops::op_state(&clone_s).await.unwrap().rebasing);
    }

    /// A rewrite can take more than one commit with it, and the decision UI lists
    /// them — newest first, the order `git log` walks the range in.
    #[tokio::test]
    async fn a_rebase_pull_names_every_commit_a_rewrite_would_take() {
        let (_guard, base, _origin_s, url) = seeded_origin("multi-drop").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // Two commits, both PUSHED — so both sit in the tracking ref's reflog.
        for (file, subject) in [("v1.txt", "V1 the first"), ("v2.txt", "V2 the second")] {
            std::fs::write(clone.join(file), "v\n").unwrap();
            run(&clone_s, &["add", "-A"]).await;
            run(&clone_s, &["commit", "-qm", subject]).await;
        }
        run(&clone_s, &["push", "-q"]).await;
        let v1 = head_of(&clone_s, "HEAD~1").await;
        let v2 = head_of(&clone_s, "HEAD").await;

        run(&work_s, &["fetch", "-q"]).await;
        run(&work_s, &["reset", "-q", "--hard", "origin/main~2"]).await;
        std::fs::write(work.join("r.txt"), "r\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "teammate rewrite"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("two doomed commits must refuse just as one does");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.commits.len(), 2, "{:?}", drop.commits);
        assert_eq!(
            drop.commits.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(),
            vec![v2.as_str(), v1.as_str()],
            "newest first"
        );
        assert_eq!(drop.commits[0].subject, "V2 the second");
        assert_eq!(drop.commits[1].subject, "V1 the first");
        assert!(
            drop.message.contains("2 commits"),
            "the summary counts them: {}",
            drop.message
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, v2, "nothing was touched");
    }

    /// A tree left mid-merge has a CLEAN index (`git merge --no-commit` stages
    /// without conflicting), so only the in-progress probe catches it. The guard
    /// stands down and git's own refusal — which names the unfinished merge —
    /// reaches the user, instead of `rebase --onto`'s "you have unstaged changes",
    /// which the frontend would offer to stash-recover over a live merge.
    #[tokio::test]
    async fn a_rebase_pull_mid_merge_stands_down_to_bare_pull() {
        let (_guard, clone_s, victim, _rewritten) = vaporize_clone("mid-op").await;
        run(&clone_s, &["switch", "-q", "-c", "side", "HEAD~1"]).await;
        std::fs::write(std::path::Path::new(&clone_s).join("s.txt"), "s\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "side"]).await;
        run(&clone_s, &["switch", "-q", "main"]).await;
        run(&clone_s, &["merge", "--no-commit", "--no-ff", "side"]).await;
        assert!(
            run(&clone_s, &["ls-files", "--unmerged"]).await.trim().is_empty(),
            "the fixture's merge must be paused with a CLEAN index"
        );
        assert!(crate::git::ops::op_state(&clone_s).await.unwrap().merging);

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses to pull over an unfinished merge");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.contains("MERGE_HEAD exists"),
            "bare pull's own refusal must survive: {stderr}"
        );
        assert!(
            !crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "and no rebase was started over the paused merge"
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
    }

    /// A detached HEAD has no upstream to compare against, so the guard stands
    /// down and git says so in its own words.
    #[tokio::test]
    async fn a_rebase_pull_on_a_detached_head_stands_down_to_bare_pull() {
        let (_guard, clone_s, victim, _rewritten) = vaporize_clone("detached").await;
        run(&clone_s, &["switch", "-q", "--detach"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses a pull with no branch to rebase");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.to_lowercase().contains("not currently on a branch"),
            "bare pull's own refusal must survive: {stderr}"
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
    }

    /// A branch tracking another LOCAL branch has no remote to fetch from, so the
    /// guard runs its verdict and skips phase A's fetch. The repo has no remote at
    /// all, which is what makes a skipped fetch provable: any attempt would fail.
    #[tokio::test]
    async fn a_rebase_pull_tracking_a_local_branch_never_fetches() {
        let (_base, base) = temp_base("local-upstream");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "-M", "main"]).await;
        run(&repo_s, &["switch", "-q", "-c", "dev"]).await;
        std::fs::write(repo.join("dev.txt"), "dev\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "dev work"]).await;
        run(&repo_s, &["switch", "-q", "main"]).await;
        run(&repo_s, &["branch", "--set-upstream-to=dev", "main"]).await;
        assert!(
            run(&repo_s, &["remote"]).await.trim().is_empty(),
            "no remote exists, so a fetch could only fail"
        );

        let state = AppState::default();
        git_pull_core(&state, repo_s.clone(), "rebase".into())
            .await
            .expect("a local-branch upstream pulls without any network step");
        assert_eq!(
            head_of(&repo_s, "refs/heads/main").await,
            head_of(&repo_s, "refs/heads/dev").await,
            "main fast-forwarded onto its local upstream"
        );
    }

    /// Fork-point's protective face, which is why this is a question and not a
    /// silent policy: the upstream deliberately amended its OWN commit, so
    /// replaying the local copy would duplicate it. The guard still asks — the
    /// user is the one who knows which happened.
    #[tokio::test]
    async fn a_rebase_pull_reports_a_deliberate_upstream_amend() {
        let (_guard, base, _origin_s, url) = seeded_origin("amend").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // X lands upstream first, so the clone starts with it.
        std::fs::write(work.join("x.txt"), "x\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "X the amended"]).await;
        run(&work_s, &["push", "-q"]).await;
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;
        let old_x = head_of(&clone_s, "HEAD").await;

        // A local, unpushed commit on top of X.
        std::fs::write(clone.join("v.txt"), "v\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "my local work"]).await;

        // Upstream amends X and force-pushes.
        std::fs::write(work.join("x.txt"), "x amended\n").unwrap();
        run(&work_s, &["commit", "-q", "--amend", "-am", "X the amended"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("an upstream rewrite is always the user's call");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.commits.len(), 1, "{:?}", drop.commits);
        assert_eq!(
            drop.commits[0].sha, old_x,
            "the stale copy of X is what would go"
        );
        assert_eq!(drop.commits[0].subject, "X the amended");
    }

    /// The case that must stay promptless: with nothing being rewritten away, a
    /// guarded pull has to land in the same state bare `git pull --rebase` did —
    /// both when the branch is merely behind and when it has diverged.
    #[tokio::test]
    async fn a_rebase_pull_with_nothing_to_drop_matches_bare_pull() {
        for diverged in [false, true] {
            let tag = if diverged { "same-diverged" } else { "same-behind" };
            let (_guard, base, _origin_s, url) = seeded_origin(tag).await;
            let base_s = base.to_string_lossy().into_owned();
            let work = base.join("work");
            let work_s = work.to_string_lossy().into_owned();

            let mut clones = Vec::new();
            for name in ["guarded", "bare"] {
                run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
                let c = base.join(name).to_string_lossy().into_owned();
                run(&c, &["config", "core.autocrlf", "false"]).await;
                run(&c, &["config", "user.email", "t@t.local"]).await;
                run(&c, &["config", "user.name", "T"]).await;
                if diverged {
                    // A different file from upstream's, so the replay is clean.
                    std::fs::write(base.join(name).join("mine.txt"), "mine\n").unwrap();
                    run(&c, &["add", "-A"]).await;
                    run(&c, &["commit", "-qm", "my local work"]).await;
                }
                clones.push(c);
            }

            // Ordinary upstream progress — no rewrite anywhere.
            std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
            run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
            run(&work_s, &["push", "-q"]).await;

            let state = AppState::default();
            git_pull_core(&state, clones[0].clone(), "rebase".into())
                .await
                .expect("a pull with nothing to drop must not prompt");
            run(&clones[1], &["pull", "--rebase", "-q"]).await;

            assert_eq!(
                subjects(&clones[0]).await,
                subjects(&clones[1]).await,
                "diverged={diverged}: the guarded pull's history must match bare pull's"
            );
            assert_eq!(
                run(&clones[0], &["ls-files"]).await,
                run(&clones[1], &["ls-files"]).await,
                "diverged={diverged}: and so must the tree"
            );
            if !diverged {
                assert_eq!(
                    head_of(&clones[0], "HEAD").await,
                    head_of(&clones[0], "refs/remotes/origin/main").await,
                    "a behind-only pull still fast-forwards onto the upstream tip"
                );
            }
        }
    }

    /// No upstream to compare against is no fork-point question, so the guard
    /// stands down and git's own tracking-information error reaches the user
    /// unchanged.
    #[tokio::test]
    async fn a_rebase_pull_without_an_upstream_falls_back_to_bare_pull() {
        let (_guard, clone_s, _victim, _rewritten) = vaporize_clone("no-upstream").await;
        run(&clone_s, &["switch", "-q", "-c", "untracked-branch"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses a pull with nothing to pull from");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.to_lowercase().contains("no tracking information"),
            "bare pull's own refusal must survive: {stderr}"
        );
    }

    /// An upstream branch deleted on the forge. Without a pruning fetch the stale
    /// tracking ref survives, every rev in the probe resolves against it, and the
    /// rebase onto that stale tip succeeds — reporting a pull that bare git
    /// refuses outright. The prune is what turns this back into git's own error.
    #[tokio::test]
    async fn a_rebase_pull_whose_upstream_branch_was_deleted_falls_back_to_bare_pull() {
        let (_guard, base, origin_s, url) = seeded_origin("upstream-deleted").await;
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // The branch goes away on the remote, as a merged-and-deleted PR head does.
        run(&origin_s, &["update-ref", "-d", "refs/heads/main"]).await;
        assert!(
            !head_of(&clone_s, "refs/remotes/origin/main").await.is_empty(),
            "the clone still holds a tracking ref, which is what makes this silent"
        );

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("a branch that no longer exists upstream cannot be pulled");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.contains("no such ref was fetched"),
            "bare pull's own refusal must reach the user: {stderr}"
        );
        assert!(
            run_git(
                Some(&clone_s),
                &["rev-parse", "--verify", "refs/remotes/origin/main"],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .is_err(),
            "and the guard's fetch pruned the stale tracking ref on its way out"
        );
    }

    /// git's refusal wording for a dirty-tree rebase, which `isDirtyTreeRefusal`
    /// (src/lib/error-summary.ts) matches to offer the stash-and-retry recovery.
    /// The explicit rebase says "cannot rebase" where bare pull said "cannot pull
    /// with rebase" — both are in that list, and this is what keeps them there.
    /// Twin of `refusal_stderr_still_matches_the_frontend_markers` (autostash.rs).
    const REBASE_UNSTAGED: &str = "cannot rebase: you have unstaged changes";
    const REBASE_STAGED: &str = "cannot rebase: your index contains uncommitted changes";

    /// A clone one commit behind its upstream, with a dirty TRACKED file the
    /// upstream's commit does not touch. Non-overlapping on purpose: rebase
    /// refuses on any dirty tracked file, so the refusal arm still fires, while an
    /// autostash arm can reapply cleanly instead of conflicting on the same lines.
    /// Returns the guard and the clone's path.
    async fn behind_clone_with_dirty_tree(tag: &str) -> (tempfile::TempDir, String) {
        let (guard, base, _origin_s, url) = seeded_origin(tag).await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // A second tracked file, published BEFORE the clone so the clone has one
        // to dirty that the upstream commit below leaves alone.
        std::fs::write(work.join("b.txt"), "b\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "add b"]).await;
        run(&work_s, &["push", "-q"]).await;

        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
        run(&work_s, &["push", "-q"]).await;

        std::fs::write(clone.join("b.txt"), "dirty\n").unwrap();
        (guard, clone_s)
    }

    #[tokio::test]
    async fn a_guarded_rebase_pull_still_refuses_a_dirty_tree_recoverably() {
        let (_guard, clone_s) = behind_clone_with_dirty_tree("dirty-refusal").await;
        // Both autostash keys off, pinned locally so the machine's own git config
        // can't decide this test's outcome. `pull.autoStash` stays unset, which is
        // the arm that passes NO flag and lets `rebase.autoStash` govern.
        run(&clone_s, &["config", "rebase.autoStash", "false"]).await;

        let state = AppState::default();
        for (stage, marker) in [(false, REBASE_UNSTAGED), (true, REBASE_STAGED)] {
            if stage {
                run(&clone_s, &["add", "b.txt"]).await;
            }
            let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
                .await
                .expect_err("git must not clobber uncommitted work");
            let AppError::Git { stderr, .. } = &err else {
                panic!("expected a plain git error, got {err:?}");
            };
            assert!(
                stderr.to_lowercase().contains(marker),
                "git no longer emits {marker:?} — the frontend's stash-and-retry recovery is \
                 now blind to this refusal. Actual stderr:\n{stderr}"
            );
        }
    }

    /// Bare `git pull --rebase` honors `pull.autoStash`, and falls back to
    /// `rebase.autoStash` when it is unset. The guarded pull replaced that one
    /// command with a fetch plus a rebase, so it has to translate the first key
    /// (a bare rebase ignores it) and stay out of the way of the second.
    #[tokio::test]
    async fn a_guarded_rebase_pull_honors_the_autostash_config() {
        for (tag, key) in [("autostash-pull", "pull.autoStash"), ("autostash-rebase", "rebase.autoStash")] {
            let (_guard, clone_s) = behind_clone_with_dirty_tree(tag).await;
            run(&clone_s, &["config", key, "true"]).await;

            let state = AppState::default();
            git_pull_core(&state, clone_s.clone(), "rebase".into())
                .await
                .unwrap_or_else(|e| panic!("{key}=true must let the pull through: {e}"));

            assert_eq!(
                head_of(&clone_s, "HEAD").await,
                head_of(&clone_s, "refs/remotes/origin/main").await,
                "{key}: the pull landed"
            );
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&clone_s).join("b.txt")).unwrap(),
                "dirty\n",
                "{key}: and git put the uncommitted change back"
            );
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&clone_s).join("a.txt")).unwrap(),
                "upstream\n",
                "{key}: with the upstream's own change applied under it"
            );
            assert!(
                run(&clone_s, &["stash", "list"]).await.trim().is_empty(),
                "{key}: the autostash entry is not left behind"
            );
        }
    }

    /// A merge-mode pull runs its own `git merge` rather than `git pull`, so it has
    /// to spell pull's own merge subject — the line the user reads in their history,
    /// and the one place git's URL rendering (a stripped trailing `.git`, anonymized
    /// credentials) and its `into <branch>` rule show through. Compared against a
    /// real bare pull in a twin clone, so no wording is asserted from memory.
    #[tokio::test]
    async fn a_merge_mode_pull_writes_bare_pulls_merge_subject() {
        let (_guard, base, _origin_s, url) = seeded_origin("merge-subject").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        let mut clones = Vec::new();
        for name in ["guarded", "bare"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
            // A local commit on a file upstream never touches: the branch has to have
            // DIVERGED, since a fast-forward writes no merge commit to compare.
            std::fs::write(base.join(name).join("mine.txt"), "mine\n").unwrap();
            run(&c, &["add", "-A"]).await;
            run(&c, &["commit", "-qm", "my local work"]).await;
            clones.push(c);
        }

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
        run(&work_s, &["push", "-q"]).await;

        let state = AppState::default();
        git_pull_core(&state, clones[0].clone(), "merge".into())
            .await
            .expect("a non-overlapping divergence merges cleanly");
        run(&clones[1], &["pull", "--no-rebase", "-q"]).await;

        let ours = subjects(&clones[0]).await.first().cloned().unwrap();
        let theirs = subjects(&clones[1]).await.first().cloned().unwrap();
        assert_eq!(ours, theirs, "the merge subject must be pull's own");
        assert!(
            ours.starts_with("Merge branch 'main' of "),
            "and it names the upstream branch it merged: {ours}"
        );
    }

    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_sensitivity_plain() {
        assert_pull_fallthrough_ignored_guard_sensitivity(false).await;
    }

    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_sensitivity_autostash() {
        assert_pull_fallthrough_ignored_guard_sensitivity(true).await;
    }

    async fn assert_pull_fallthrough_ignored_guard_sensitivity(autostash: bool) {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape};
        for shape in [
            Shape::IgnoredFile,
            Shape::ModifyDelete,
            Shape::IgnoredDirVsFile,
        ] {
            for mode in ["ff-only", "merge"] {
                if shape == Shape::ModifyDelete && mode == "ff-only" {
                    continue;
                }
                let mut f = Fixture::new(shape, mode == "merge").await;
                f.with_remote().await;
                run(&f.repo, &["fetch", "origin"]).await;
                run(&f.repo, &["config", "submodule.recurse", "true"]).await;
                let tracked = std::path::Path::new(&f.repo).join("tracked.txt");
                if autostash {
                    std::fs::write(&tracked, "dirty tracked edit\n").unwrap();
                }
                f.snapshot().await;
                let state = AppState::default();
                assert!(
                    crate::git::pull_guard::pin_plain_pull(&state, &f.repo, mode != "merge")
                        .await
                        .unwrap()
                        .is_none()
                );
                let result = if autostash {
                    crate::git::autostash::git_pull_autostash_core(
                        &state,
                        f.repo.clone(),
                        mode.into(),
                    )
                    .await
                    .map(|_| ())
                } else {
                    super::git_pull_core(&state, f.repo.clone(), mode.into()).await
                };
                f.assert_unchanged(&result.unwrap_err()).await;
                if autostash {
                    assert_eq!(
                        std::fs::read_to_string(&tracked).unwrap(),
                        "dirty tracked edit\n"
                    );
                }
                f.remove_ignored();
                if shape == Shape::ModifyDelete {
                    // Without ignored data the native modify/delete conflict is allowed to pause.
                    if autostash {
                        let outcome = crate::git::autostash::git_pull_autostash_core(
                            &state,
                            f.repo.clone(),
                            mode.into(),
                        )
                        .await
                        .unwrap();
                        assert!(
                            matches!(
                                outcome,
                                crate::git::autostash::AutostashOutcome::OpFailedStashKept {
                                    in_progress: true,
                                    ..
                                }
                            ),
                            "{outcome:?}"
                        );
                    } else {
                        let err =
                            crate::git::remote::git_pull_core(&state, f.repo.clone(), mode.into())
                                .await
                                .unwrap_err();
                        assert!(matches!(err, AppError::Conflict { .. }), "{err:?}");
                    }
                    assert_eq!(
                        std::fs::read_to_string(std::path::Path::new(&f.repo).join("seed.txt"))
                            .unwrap(),
                        "incoming bytes\n"
                    );
                    continue;
                }
                if autostash {
                    crate::git::autostash::git_pull_autostash_core(
                        &state,
                        f.repo.clone(),
                        mode.into(),
                    )
                    .await
                    .unwrap();
                } else {
                    super::git_pull_core(&state, f.repo.clone(), mode.into())
                        .await
                        .unwrap();
                }
                f.assert_landed().await;
            }
        }
    }

    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_matches_native_operation_states() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape, MERGE_STATES};
        for state in MERGE_STATES {
            let mut f = Fixture::new(Shape::IgnoredFile, true).await;
            f.with_remote().await;
            run(&f.repo, &["fetch", "origin"]).await;
            state.install(&f).await;
            f.snapshot().await;
            let expected = if state.blocks_merge() {
                Some(
                    run_git_raw(Some(&f.repo), &["pull", "--no-rebase"], TEST_GIT_HANG_GUARD)
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            let err = git_pull_core(&AppState::default(), f.repo.clone(), "merge".into())
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
    async fn pull_unborn_fast_forwards_and_protects_ignored_files() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape, SENTINEL};
        for ignored in [false, true] {
            let f = Fixture::new(Shape::IgnoredFile, false).await;
            f.with_remote().await;
            let remote = f
                .dir
                .path()
                .join("remote.git")
                .to_string_lossy()
                .into_owned();
            let clone = f.dir.path().join("empty").to_string_lossy().into_owned();
            run(&f.repo, &["clone", "--no-checkout", &remote, &clone]).await;
            run(&clone, &["config", "core.autocrlf", "false"]).await;
            run(&clone, &["switch", "--orphan", "empty"]).await;
            run(&clone, &["config", "branch.empty.remote", "origin"]).await;
            run(
                &clone,
                &["config", "branch.empty.merge", "refs/heads/incoming"],
            )
            .await;
            run(&clone, &["fetch", "origin"]).await;
            std::fs::create_dir_all(std::path::Path::new(&clone).join(".git/info")).unwrap();
            std::fs::write(
                std::path::Path::new(&clone).join(".git/info/exclude"),
                "local.cfg\n",
            )
            .unwrap();
            if ignored {
                std::fs::write(std::path::Path::new(&clone).join("local.cfg"), SENTINEL).unwrap();
            }
            assert!(crate::git::branches::head_is_unborn(&clone).await.unwrap());
            let index = run(&clone, &["ls-files", "-s"]).await;
            let status = run(&clone, &["status", "--porcelain=v1"]).await;
            let result = git_pull_core(&AppState::default(), clone.clone(), "ff-only".into()).await;
            if ignored {
                let err = result.unwrap_err();
                let AppError::Command(message) = err else {
                    panic!("{err:?}")
                };
                assert!(
                    message.contains("ignored files in your working tree: local.cfg"),
                    "{message}"
                );
                assert!(crate::git::branches::head_is_unborn(&clone).await.unwrap());
                assert_eq!(
                    std::fs::read(std::path::Path::new(&clone).join("local.cfg")).unwrap(),
                    SENTINEL
                );
                assert_eq!(run(&clone, &["ls-files", "-s"]).await, index);
                assert_eq!(run(&clone, &["status", "--porcelain=v1"]).await, status);
                for marker in ["MERGE_HEAD", "SQUASH_MSG", "ORIG_HEAD"] {
                    assert!(
                        !std::path::Path::new(&clone)
                            .join(".git")
                            .join(marker)
                            .exists(),
                        "{marker}"
                    );
                }
                assert!(run(&clone, &["stash", "list"]).await.is_empty());
            } else {
                result.unwrap();
                assert_eq!(run(&clone, &["rev-parse", "HEAD"]).await, f.target);
                assert_eq!(
                    std::fs::read_to_string(std::path::Path::new(&clone).join("local.cfg"))
                        .unwrap(),
                    "incoming bytes\n"
                );
            }
        }
    }
}
