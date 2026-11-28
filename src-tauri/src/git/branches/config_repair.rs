use super::*;

/// git's text when a tracking setup (`switch --track`, a tracked `switch -c`/`branch`,
/// `push -u`) lost the config lock after its ref work landed.
pub(crate) const UPSTREAM_WRITE_FAILED: &str = "unable to write upstream branch configuration";

/// Redoes one `branch.<name>` section edit whose ref change already landed, counting
/// "no such section" as done: the branch had no settings, or another writer already
/// handled them. `false` (logged) leaves the caller's own verdict to speak.
pub(super) async fn repair_branch_section(held: &ConfigWriteHeld, repo_path: &str, args: &[&str]) -> bool {
    match run_git_config_write_held(held, repo_path, args, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 || out.stderr.contains("no such section") => true,
        Ok(out) => {
            eprintln!(
                "gitdesktop: branch config repair failed: {}",
                out.stderr.trim()
            );
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: branch config repair failed: {e}");
            false
        }
    }
}

/// Drops `branch.<name>.*` after the ref itself was deleted, so it can't resurface on
/// the next branch of that name: `update-ref -d` never touches it. Best-effort, since
/// the delete itself succeeded.
pub(crate) async fn remove_deleted_branch_section(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
) {
    let section = format!("branch.{name}");
    repair_branch_section(held, repo_path, &["config", "--remove-section", &section]).await;
}

/// Re-establishes `branch` → `upstream` tracking after a tracking setup lost the config
/// lock, never re-running the command that set it up. `upstream` is the fully
/// qualified ref git itself would have tracked; callers that can't pin it don't call.
pub(crate) async fn restore_upstream(
    held: &ConfigWriteHeld,
    repo_path: &str,
    branch: &str,
    upstream: &str,
) -> bool {
    let flag = format!("--set-upstream-to={upstream}");
    match run_git_config_write_held(
        held,
        repo_path,
        &["branch", &flag, "--", branch],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => true,
        Ok(out) => {
            eprintln!("gitdesktop: upstream repair failed: {}", out.stderr.trim());
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: upstream repair failed: {e}");
            false
        }
    }
}

/// What decided a tracking setup's upstream, and so what a repair may re-set.
#[derive(Clone, Copy)]
pub(crate) enum TrackedBy {
    /// An explicit `--track`: always the start ref itself.
    ExplicitTrack,
    /// `branch.autoSetupMerge`, whose mode decides (see [`direct_tracking_target`]).
    AutoSetupMerge,
}

/// What [`finish_tracking_setup`] left behind.
pub(crate) struct FinishedSetup {
    /// The output to report: success once both legs landed, else git's own failure.
    pub(crate) out: GitOutput,
    /// The repair's switch leg landed, so HEAD is on the new branch whatever `out`
    /// says — a caller that treats a failure as "HEAD never moved" must check this.
    pub(crate) switched: bool,
}

/// A tracking setup (`switch --track`, or `switch -c`/`branch` that set tracking up)
/// that loses the config lock has CREATED `branch` and, for a switch, moved the index
/// and working tree to it, yet left HEAD on the old branch and the upstream unwritten
/// (measured, git 2.51.1: exit 1). Finishes both legs, the switch first and whatever
/// the upstream does: the moved tree under the old HEAD reads as staged changes a
/// commit would land on the old branch. An upstream git's own choice can't be pinned
/// for, or that loses again, keeps git's failure in `out`, never a guessed upstream.
pub(crate) async fn finish_tracking_setup(
    held: &ConfigWriteHeld,
    repo_path: &str,
    out: GitOutput,
    branch: &str,
    start: &str,
    tracked_by: TrackedBy,
    switch: bool,
) -> AppResult<FinishedSetup> {
    if out.code == 0 || !out.stderr.contains(UPSTREAM_WRITE_FAILED) {
        return Ok(FinishedSetup {
            out,
            switched: false,
        });
    }
    // Resolved BEFORE the switch leg: a `HEAD` start must name the branch the create
    // started from, never the one the leg is about to check out.
    let upstream = direct_tracking_target(repo_path, start, tracked_by).await;
    if switch {
        let switched = run_git_raw(Some(repo_path), &["switch", branch], DEFAULT_TIMEOUT).await?;
        if switched.code != 0 {
            return Ok(FinishedSetup {
                out: switched,
                switched: false,
            });
        }
    }
    let restored = match upstream {
        Some(upstream) => restore_upstream(held, repo_path, branch, &upstream).await,
        None => false,
    };
    let out = if restored {
        GitOutput { code: 0, ..out }
    } else {
        out
    };
    Ok(FinishedSetup {
        out,
        switched: switch,
    })
}

/// The ref git itself tracked from `start`, fully qualified, or `None` when that can't
/// be pinned. git tracks the start ref directly under an explicit `--track` and under
/// every `branch.autoSetupMerge` value that sets tracking up at all except `inherit`,
/// which copies the START's own upstream (possibly several merge entries) instead
/// (measured, git 2.51.1). The start resolves the way git's create resolved it.
pub(crate) async fn direct_tracking_target(
    repo_path: &str,
    start: &str,
    tracked_by: TrackedBy,
) -> Option<String> {
    if let TrackedBy::AutoSetupMerge = tracked_by {
        let mode = run_git_raw(
            Some(repo_path),
            &["config", "--get", "branch.autoSetupMerge"],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()?;
        // Exit 1 is unset, git's default `true`. `inherit` is matched as git does,
        // case-sensitively; the last value wins in both readers.
        let direct = match mode.code {
            0 => mode.stdout_lossy().trim() != "inherit",
            1 => true,
            _ => false,
        };
        if !direct {
            return None;
        }
    }
    let resolved = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--symbolic-full-name",
            start,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let full = resolved.stdout_lossy().trim().to_string();
    (resolved.code == 0 && (full.starts_with("refs/remotes/") || full.starts_with("refs/heads/")))
        .then_some(full)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        branch_exists, branch_section, repo_with_branch_settings, run, tracking_of, upstream_of,
    };
    use crate::git::runner::{
        hold_config_lock, release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK,
        TEST_GIT_HANG_GUARD,
    };

    /// `git status --porcelain`, so a test can tell staged leftovers from a clean switch.
    async fn porcelain(repo: &str) -> String {
        run(repo, &["status", "--porcelain"]).await
    }

    /// `a.txt` as the working tree holds it, line endings aside.
    fn seed_file(repo: &std::path::Path) -> String {
        std::fs::read_to_string(repo.join("a.txt"))
            .unwrap()
            .trim()
            .to_string()
    }

    /// The premise the rename and tracking repairs rest on (git 2.51.1): each command
    /// finishes its ref change BEFORE losing `.git/config.lock`, so re-running it is
    /// never the fix. The `branch -D` row (it even exits 0) is a git-behaviour canary
    /// only: no production path runs `branch -D`. A git that changes any shape fails
    /// here first.
    #[tokio::test]
    async fn git_lands_the_ref_change_before_losing_the_config_lock() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-shapes", "shape", "shape-remote").await;
        run(&repo_s, &["branch", "shape-gone"]).await;
        run(
            &repo_s,
            &["config", "branch.shape-gone.gitdesktopArchived", "true"],
        )
        .await;
        let lock = hold_config_lock(&repo);
        let raw = |args: &'static [&'static str]| {
            let repo_s = repo_s.clone();
            async move {
                run_git_raw(Some(&repo_s), args, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap()
            }
        };

        let deleted = raw(&["branch", "-D", "--", "shape-gone"]).await;
        assert_eq!(deleted.code, 0, "{}", deleted.stderr);
        assert!(
            is_config_lock_contention(&deleted.stderr),
            "{}",
            deleted.stderr
        );
        assert!(!branch_exists(&repo_s, "shape-gone").await);
        assert!(!branch_section(&repo_s, "shape-gone").await.is_empty());

        let renamed = raw(&["branch", "-m", "--", "shape", "shape-moved"]).await;
        assert_eq!(renamed.code, 128);
        assert!(
            renamed.stderr.contains(RENAMED_CONFIG_LEFT_BEHIND),
            "{}",
            renamed.stderr
        );
        assert!(branch_exists(&repo_s, "shape-moved").await);
        assert!(!branch_section(&repo_s, "shape").await.is_empty());

        // Both switch forms: the branch is created AND the index and working tree move
        // to its tip, but HEAD stays put, so the move reads as staged changes on the
        // old branch. A plain `branch` from the same start point leaves the tree alone.
        let head = run(&repo_s, &["symbolic-ref", "HEAD"]).await;
        let cases: [(&'static [&'static str], &str); 3] = [
            (
                &[
                    "switch",
                    "--track",
                    "-c",
                    "shape-remote",
                    "origin/shape-remote",
                ],
                "shape-remote",
            ),
            (
                &["switch", "-c", "shape-create", "origin/shape-remote"],
                "shape-create",
            ),
            (
                &["branch", "shape-plain", "origin/shape-remote"],
                "shape-plain",
            ),
        ];
        for (args, created) in cases {
            let out = raw(args).await;
            assert_eq!(out.code, 1, "{args:?}: {}", out.stderr);
            assert!(out.stderr.contains(UPSTREAM_WRITE_FAILED), "{}", out.stderr);
            assert!(branch_exists(&repo_s, created).await, "{args:?} created");
            assert_eq!(
                run(&repo_s, &["symbolic-ref", "HEAD"]).await,
                head,
                "{args:?}"
            );
            if args[0] == "switch" {
                assert_eq!(seed_file(&repo), "remote", "{args:?} moved the tree");
                let staged = porcelain(&repo_s).await;
                assert!(
                    staged.contains("M  a.txt") && staged.contains("A  remote.txt"),
                    "{args:?} left the move staged on the old branch: {staged}"
                );
                run(&repo_s, &["reset", "-q", "--hard"]).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "{args:?} left the tree alone");
                assert_eq!(porcelain(&repo_s).await, "", "{args:?}");
            }
        }
        std::fs::remove_file(&lock).unwrap();
    }

    /// A tracking switch that loses the config lock ends where an uncontended one
    /// does: on the new branch, tracking the remote one.
    #[tokio::test]
    async fn a_tracking_switch_that_loses_the_config_lock_still_tracks_and_switches() {
        let remote_branch = "cfg-lock-track";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track", "unrelated", remote_branch).await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_checkout_remote_branch_core(
                    &state,
                    repo_s.clone(),
                    "origin".into(),
                    remote_branch.into(),
                ),
            )
            .await
            .expect("the switch succeeds");
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(
            upstream_of(&repo_s, remote_branch).await.as_deref(),
            Some(format!("origin/{remote_branch}").as_str())
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// HEAD on `branch` with the working tree at its tip and nothing staged — where an
    /// uncontended switch ends, and never the moved-tree-under-old-HEAD half state.
    async fn assert_cleanly_on(repo: &std::path::Path, repo_s: &str, branch: &str) {
        assert_eq!(
            run(repo_s, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim(),
            branch
        );
        assert_eq!(seed_file(repo), "remote");
        assert_eq!(porcelain(repo_s).await, "", "nothing left staged");
    }

    /// The switch leg runs even when the upstream repair loses again: the branch is
    /// checked out cleanly and git's upstream error is what the caller hears.
    #[tokio::test]
    async fn a_tracking_switch_whose_upstream_repair_also_loses_still_switches() {
        let remote_branch = "cfg-lock-track-held";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track-held", "unrelated", remote_branch).await;
        let lock = hold_config_lock(&repo);

        let state = AppState::default();
        let err = git_checkout_remote_branch_core(
            &state,
            repo_s.clone(),
            "origin".into(),
            remote_branch.into(),
        )
        .await
        .expect_err("the lost upstream is reported");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's error, got {err:?}")
        };
        assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
        std::fs::remove_file(&lock).unwrap();
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(upstream_of(&repo_s, remote_branch).await, None);
    }

    /// Every `branch.autoSetupMerge` mode × start kind in which git attempts tracking
    /// (measured, git 2.51.1). Repaired exactly where git's own choice is the start ref
    /// itself, to what an uncontended twin create writes; `inherit` copies the START's
    /// upstream instead, which the repair can't pin, so it surfaces git's error with no
    /// upstream rather than a wrong one, and the switch leg still runs. A create with no
    /// start point starts from HEAD, which `always` tracks like any local start.
    #[tokio::test]
    async fn a_tracked_create_repairs_only_what_git_itself_would_write() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-modes", "local-start", "same-name").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        let state = AppState::default();
        // (mode, start, new branch, checkout, repaired). `simple` tracks only a
        // same-named remote branch, so its row creates `same-name` itself.
        type Case<'a> = (Option<&'a str>, Option<&'a str>, &'a str, bool, bool);
        let cases: [Case<'_>; 7] = [
            (None, Some("origin/same-name"), "mode-default", false, true),
            (
                Some("always"),
                Some("local-start"),
                "mode-always-local",
                false,
                true,
            ),
            (Some("always"), None, "mode-always-nostart", false, true),
            (Some("always"), None, "mode-always-nostart-co", true, true),
            (
                Some("simple"),
                Some("origin/same-name"),
                "same-name",
                false,
                true,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-local",
                false,
                false,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-co",
                true,
                false,
            ),
        ];
        for (mode, start, name, checkout, repaired) in cases {
            run(&repo_s, &["switch", "-q", main.trim()]).await;
            let _ = run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", "branch.autoSetupMerge"],
                TEST_GIT_HANG_GUARD,
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

            let lock = hold_config_lock(&repo);
            let (hook, _) = release_config_lock_before_attempt(lock.clone(), 2);
            let created = CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        start.map(str::to_string),
                        false,
                    ),
                )
                .await;
            let _ = std::fs::remove_file(&lock);
            let got = tracking_of(&repo_s, name).await;
            if repaired {
                created.unwrap_or_else(|e| panic!("{mode:?} × {start:?}: {e}"));
                assert_eq!(
                    got, want,
                    "{mode:?} × {start:?}: what git would have written"
                );
            } else {
                let err = created.expect_err("an unpinnable upstream surfaces git's error");
                let AppError::Git { stderr, .. } = &err else {
                    panic!("expected git's error, got {err:?}")
                };
                assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
                assert_eq!(
                    got,
                    (None, None),
                    "{mode:?} × {start:?}: no guessed upstream"
                );
                assert_ne!(want.1.as_deref(), Some("refs/heads/local-start"));
            }
            assert!(branch_exists(&repo_s, name).await);
            if checkout {
                assert_eq!(
                    run(&repo_s, &["symbolic-ref", "--short", "HEAD"])
                        .await
                        .trim(),
                    name
                );
                assert_eq!(porcelain(&repo_s).await, "", "the switch leg still ran");
            }
        }
    }

    /// A create from a tracked start point that loses the config lock ends where an
    /// uncontended one does, in both modes: switched (or not) and tracking.
    #[tokio::test]
    async fn a_tracked_create_that_loses_the_config_lock_still_tracks() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-create", "unrelated", "cfg-lock-start").await;
        let state = AppState::default();
        for (name, checkout) in [("cfg-lock-made", false), ("cfg-lock-made-co", true)] {
            let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);
            CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        Some("origin/cfg-lock-start".into()),
                        false,
                    ),
                )
                .await
                .expect("the create succeeds");
            assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
            assert_eq!(
                upstream_of(&repo_s, name).await.as_deref(),
                Some("origin/cfg-lock-start")
            );
            if checkout {
                assert_cleanly_on(&repo, &repo_s, name).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "a plain create leaves the tree");
                assert_eq!(porcelain(&repo_s).await, "");
            }
        }
    }
}
