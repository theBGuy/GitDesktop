use super::*;

/// Refuses publishing a branch reserved for agent-session work.
pub(super) fn refuse_publishing_session_branch(name: &str) -> AppResult<()> {
    if crate::git::branches::is_session_branch_name(name) {
        return Err(AppError::BranchIsAgentSession {
            branch: name.to_string(),
        });
    }
    Ok(())
}

/// The one publishing refusal every push, Publish and Create PR route runs on the branch
/// it sends: the gd/session/ prefix, then the Keep local mark, failing closed on an
/// unreadable mark. It sees only the branch a route names or HEAD's branch, so a bare
/// push sending more (`push.default=matching`, a push remote's own push refspecs) can
/// carry another marked branch: out of reach by decision (0 of 109 owner repos use
/// either), and the optional pre-push hook stops it. An unmarked spelling that git
/// stores as a marked case variant refuses under the stored name, failing closed on an
/// unreadable spelling.
pub(crate) async fn refuse_publishing_branch(repo_path: &str, name: &str) -> AppResult<()> {
    refuse_publishing_session_branch(name)?;
    if crate::git::branches::branch_keep_local(repo_path, name).await? {
        return Err(AppError::BranchKeptLocal {
            branch: name.to_string(),
        });
    }
    let stored = crate::git::branches::stored_branch_spelling(repo_path, name).await?;
    if stored != name && crate::git::branches::branch_keep_local(repo_path, &stored).await? {
        return Err(AppError::BranchKeptLocal { branch: stored });
    }
    Ok(())
}

/// The refusals a resolve or forge-publish push can raise at or before spawn (Keep local,
/// an agent-session branch and, on the resolve, a mirror remote): the remote-PR resolve
/// passes them through and the three publish routes disclose them without retry advice.
pub(crate) fn is_publishing_refusal(err: &AppError) -> bool {
    matches!(
        err,
        AppError::BranchKeptLocal { .. }
            | AppError::PushRemoteIsMirror { .. }
            | AppError::BranchIsAgentSession { .. }
    )
}

/// Refuses a push whose DESTINATION on a named remote is in gd/session/, whatever the
/// local branch is called; the local name is [`refuse_publishing_branch`]'s.
pub(super) fn refuse_session_destination(branch: &str, remote: &str, dest: &str) -> AppResult<()> {
    if crate::git::branches::is_session_branch_name(dest) {
        return Err(AppError::PushDestinationIsAgentSession {
            branch: branch.to_string(),
            remote: redact_url_userinfo(remote),
            dest: dest.to_string(),
        });
    }
    Ok(())
}

/// The branch a forge publish pushes: HEAD's branch NAME, validated for the publish
/// refspec. Every provider's publish runs it BEFORE it creates the remote project — a
/// refusal after the create would orphan it. The two refusal strings are the publish
/// dialog's contract.
pub(crate) async fn publish_branch(repo_path: &str) -> AppResult<String> {
    let Some(branch) = crate::git::branches::current_branch_name(repo_path).await? else {
        return Err(AppError::InvalidArgument(
            "check out a branch before publishing (detached HEAD)".into(),
        ));
    };
    if crate::git::branches::head_is_unborn(repo_path).await? {
        return Err(AppError::InvalidArgument(
            "make an initial commit before publishing (this repository has none yet)".into(),
        ));
    }
    crate::git::branches::validate_ref_name(&branch)?;
    // The dispatch refused HEAD's branch as it read it then; this is the name the
    // provider pushes, so a checkout between the two reads can't publish past the guard.
    refuse_publishing_branch(repo_path, &branch).await?;
    Ok(branch)
}

/// Refuses a publish when `origin` already exists, since the post-create `remote add`
/// would fail and strand the new project. Fails closed: only git's "No such remote"
/// proceeds; any other failure refuses with git's own text.
pub(crate) async fn refuse_existing_origin(repo_path: &str) -> AppResult<()> {
    existing_origin_verdict(repo_path, &[]).await
}

/// The verdict over one `remote get-url origin` run. git before 2.30 answers a missing
/// remote with exit 128 and "No such remote" (2.30.0 release notes: `git remote` exit
/// codes made scriptable); the runner pins LC_ALL=C, so that text is stable.
fn existing_origin_decision(out: &GitOutput) -> AppResult<()> {
    match out.code {
        0 => Err(AppError::InvalidArgument(
            "this repository already has an origin remote — push to it instead".into(),
        )),
        2 => Ok(()),
        128 if out.stderr.contains("No such remote") => Ok(()),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// `remote get-url` counts only repository-scope config, the same test `remote add`
/// makes: a url-less local `[remote "origin"]` exits 0, a global-only `remote.origin.*`
/// key exits 2 (measured, git 2.51.1). `envs` is the tests' per-spawn config seam.
async fn existing_origin_verdict(repo_path: &str, envs: &[(&str, &str)]) -> AppResult<()> {
    let out = crate::git::runner::run_git_raw_env(
        Some(repo_path),
        &["remote", "get-url", "origin"],
        envs,
        DEFAULT_TIMEOUT,
    )
    .await?;
    existing_origin_decision(&out)
}

/// Fully-qualified same-name push refspec. Qualification alone only stops a
/// leading `+`/`-` from reading as a force/delete marker at refspec position 0;
/// the metacharacters that could reshape the refspec (`* ? [ : \`) are rejected
/// by [`crate::git::branches::validate_ref_name`], which every caller runs first.
pub(crate) fn publish_refspec(branch: &str) -> String {
    format!("refs/heads/{branch}:refs/heads/{branch}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{
        assert_kept_local, git_push_core_unpinned, init_repo, keep_local_origin, run,
        seeded_origin_unpinned_push_default, temp_base,
    };
    use crate::git::runner::{TestGitEnv, TEST_GIT_HANG_GUARD};

    /// The guard reads git's own bool, failing closed: marked spellings refuse, unmarked
    /// ones pass, a junk value is an error, the key is case-sensitive, and the session
    /// prefix answers first, before any spawn.
    #[tokio::test]
    async fn keep_local_guard_reads_every_flag_spelling() {
        let (_guard, work, _origin) = keep_local_origin("keep-local-spellings").await;
        let config = std::path::Path::new(&work).join(".git").join("config");
        let set = |values: &[&str]| {
            let _ = std::process::Command::new("git")
                .test_git_env()
                .current_dir(&work)
                .args([
                    "config",
                    "--unset-all",
                    "branch.rel/1.2.gitdesktopLocalOnly",
                ])
                .output();
            for v in values {
                let mut text = std::fs::read_to_string(&config).unwrap();
                match *v {
                    "<valueless>" => text.push_str("[branch \"rel/1.2\"]\n\tgitdesktopLocalOnly\n"),
                    _ => text.push_str(&format!(
                        "[branch \"rel/1.2\"]\n\tgitdesktopLocalOnly = {v}\n"
                    )),
                }
                std::fs::write(&config, text).unwrap();
            }
        };
        for values in [
            &["true"][..],
            &["<valueless>"],
            &["yes"],
            &["false", "true"],
        ] {
            set(values);
            assert_kept_local(
                super::refuse_publishing_branch(&work, "rel/1.2").await,
                "rel/1.2",
                &format!("{values:?}"),
            );
        }
        for values in [&[][..], &["false"], &["\"\""], &["0"], &["true", "false"]] {
            set(values);
            super::refuse_publishing_branch(&work, "rel/1.2")
                .await
                .unwrap_or_else(|e| panic!("{values:?} must read unmarked: {e:?}"));
        }
        // A junk value anywhere on the key makes git refuse the read, so the guard refuses
        // with git's own error, even when the last value is a valid bool.
        for values in [&["maybe"][..], &["maybe", "true"], &["maybe", "false"]] {
            set(values);
            match super::refuse_publishing_branch(&work, "rel/1.2").await {
                Err(AppError::Git { stderr, .. }) => {
                    assert!(
                        stderr.contains("bad boolean config value"),
                        "{values:?}: {stderr}"
                    )
                }
                other => panic!("{values:?}: expected git's refusal, got {other:?}"),
            }
        }
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        // A case variant git reads as the marked loose ref refuses under the stored name,
        // only where the store's names can alias.
        let variant = super::refuse_publishing_branch(&work, "Feat/X").await;
        if crate::git::branches::refs_can_alias(&work).await {
            match variant {
                Err(AppError::BranchKeptLocal { branch }) => assert_eq!(branch, "feat/x"),
                other => panic!("a folding store refuses the variant: {other:?}"),
            }
        } else {
            variant.expect("a case-sensitive store refuses only the marked spelling");
        }
        super::refuse_publishing_branch(&work, "no/such/branch")
            .await
            .expect("a name with no ref answers Ok");
        match super::refuse_publishing_branch("C:/gd-no-such-repo", "gd/session/x").await {
            Err(AppError::BranchIsAgentSession { branch }) => assert_eq!(branch, "gd/session/x"),
            other => panic!("expected the session refusal, got {other:?}"),
        }
        let outside = tempfile::tempdir().unwrap();
        let outside_s = outside.path().to_string_lossy().into_owned();
        assert!(
            super::refuse_publishing_branch(&outside_s, "feat/x")
                .await
                .is_err(),
            "outside a repository the spelling read errs, so a non-session name refuses"
        );
    }

    /// Keep local does not reach remote-branch delete: a marked branch's remote copy is
    /// deleted.
    #[tokio::test]
    async fn keep_local_leaves_remote_branch_delete_allowed() {
        let (_guard, work, _origin) = keep_local_origin("keep-local-delete").await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        crate::git::branches::git_delete_remote_branch_core(
            &AppState::default(),
            work.clone(),
            "origin".into(),
            "feat/x".into(),
        )
        .await
        .expect("the remote copy of a marked branch can be deleted");
        assert!(!run(&work, &["ls-remote", "origin"])
            .await
            .contains("refs/heads/feat/x"));
    }

    /// Unpinned, so the untracked HEAD reads no push remote, the shape most repos take.
    #[tokio::test]
    async fn session_publish_guard_lets_feature_publish() {
        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("session-publish-feature").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "feature/y"]).await;
        git_push_core_unpinned(
            &AppState::default(),
            work.clone(),
            true,
            false,
            None,
            None,
            None,
        )
        .await
        .expect("ordinary feature HEAD publishes");
        assert!(run(&work, &["ls-remote", "origin"])
            .await
            .contains("refs/heads/feature/y"));
    }

    /// The forge publishes push HEAD's branch by NAME, so a tag sharing it (or a branch
    /// taking its `heads/` form) can't send the push to `refs/heads/heads/<name>` after
    /// the remote project already exists. Unborn and detached HEADs keep their
    /// refusals, word for word.
    #[tokio::test]
    async fn publish_branch_names_the_branch_and_refuses_unborn_and_detached() {
        let (_base, base) = temp_base("publish-branch");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        let refusal = |e: AppError| match e {
            AppError::InvalidArgument(m) => m,
            other => panic!("expected the worded refusal, got {other:?}"),
        };
        assert_eq!(
            refusal(super::publish_branch(&repo_s).await.unwrap_err()),
            "make an initial commit before publishing (this repository has none yet)"
        );

        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        run(&repo_s, &["switch", "-q", "-c", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "shadowed");
        run(
            &repo_s,
            &["update-ref", "refs/heads/heads/shadowed", "HEAD"],
        )
        .await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "shadowed");

        run(&repo_s, &["switch", "-q", "--detach"]).await;
        assert_eq!(
            refusal(super::publish_branch(&repo_s).await.unwrap_err()),
            "check out a branch before publishing (detached HEAD)"
        );
    }

    /// The branch every provider pushes is re-checked where it is read, so a HEAD switched
    /// to a session or Keep local branch after the dispatch's read is still refused.
    #[tokio::test]
    async fn head_switch_publish_branch_refuses_session_and_keep_local() {
        let (_base, base) = temp_base("head-switch");
        let repo_s = base.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["switch", "-q", "-c", "feat/x"]).await;
        run(&repo_s, &["branch", "gd/session/x"]).await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "feat/x");
        crate::git::branches::set_branch_keep_local_core(&repo_s, "feat/x", true)
            .await
            .unwrap();
        assert_kept_local(super::publish_branch(&repo_s).await, "feat/x", "kept local");
        run(&repo_s, &["switch", "-q", "gd/session/x"]).await;
        match super::publish_branch(&repo_s).await {
            Err(AppError::BranchIsAgentSession { branch }) => assert_eq!(branch, "gd/session/x"),
            other => panic!("expected the session refusal, got {other:?}"),
        }
    }

    /// Only git's "No such remote" lets a publish proceed: a url, a url-less section and
    /// a failed read (not a repository) all refuse before anything is created, while
    /// `remote.origin.*` keys from a global file alone do not.
    #[tokio::test]
    async fn existing_origin_refusal_fails_closed() {
        let copy = "this repository already has an origin remote — push to it instead";
        let (_base, base) = temp_base("existing-origin");
        let repo = base.join("repo");
        let other = base.join("not-a-repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        super::refuse_existing_origin(&repo_s)
            .await
            .expect("no origin: the publish proceeds");

        let global = base.join("global.gitconfig");
        std::fs::write(
            &global,
            "[remote \"origin\"]\n\turl = file:///C:/nowhere.git\n\tprune = true\n\tmirror = true\n",
        )
        .unwrap();
        let global_s = global.to_string_lossy().into_owned();
        let envs = [("GIT_CONFIG_GLOBAL", global_s.as_str())];
        let seen = crate::git::runner::run_git_raw_env(
            Some(&repo_s),
            &["config", "--get", "remote.origin.url"],
            &envs,
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(seen.code, 0, "the seam reads the global file");
        super::existing_origin_verdict(&repo_s, &envs)
            .await
            .expect("global-only origin keys: the publish proceeds");

        run(&repo_s, &["config", "remote.origin.mirror", "false"]).await;
        match super::refuse_existing_origin(&repo_s).await {
            Err(AppError::InvalidArgument(m)) => assert_eq!(m, copy, "url-less section"),
            other => panic!("url-less section: expected the origin copy, got {other:?}"),
        }
        run(
            &repo_s,
            &["config", "remote.origin.url", "file:///C:/nowhere.git"],
        )
        .await;
        match super::refuse_existing_origin(&repo_s).await {
            Err(AppError::InvalidArgument(m)) => assert_eq!(m, copy, "origin url"),
            other => panic!("origin url: expected the origin copy, got {other:?}"),
        }

        let other_s = other.to_string_lossy().into_owned();
        match super::refuse_existing_origin(&other_s).await {
            Err(AppError::Git { code, stderr }) => {
                assert_ne!(code, 2, "{stderr}");
                assert!(stderr.contains("not a git repository"), "{stderr}");
            }
            other => panic!("not a repository: expected git's failure, got {other:?}"),
        }
    }

    /// The verdict over git's answer, old git's exit-128 "No such remote" included.
    #[test]
    fn existing_origin_decision_reads_old_and_new_missing_remote_exits() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let decide = super::existing_origin_decision;
        decide(&out(2, "", "error: No such remote 'origin'\n")).expect("exit 2: no origin");
        decide(&out(128, "", "fatal: No such remote 'origin'\n"))
            .expect("old git's exit 128: no origin");
        match decide(&out(0, "file:///C:/nowhere.git\n", "")) {
            Err(AppError::InvalidArgument(m)) => assert!(m.contains("already has an origin")),
            other => panic!("exit 0: expected the origin copy, got {other:?}"),
        }
        let repo = "fatal: not a git repository (or any of the parent directories): .git\n";
        match decide(&out(128, "", repo)) {
            Err(AppError::Git { code: 128, stderr }) => {
                assert!(stderr.contains("not a git repository"), "{stderr}")
            }
            other => panic!("not a repository: expected git's failure, got {other:?}"),
        }
    }

    #[test]
    fn publish_refspec_is_fully_qualified_on_both_sides() {
        assert_eq!(
            publish_refspec("feature"),
            "refs/heads/feature:refs/heads/feature"
        );
        // A `+` lands INSIDE the ref path, never at refspec position 0 where git
        // would read it as the force marker.
        assert_eq!(publish_refspec("+x"), "refs/heads/+x:refs/heads/+x");
    }

    #[test]
    fn a_session_destination_refusal_redacts_a_url_remote() {
        const URL: &str = "https://user:secret@host/o/r";
        let Err(err) = super::refuse_session_destination("topic", URL, "gd/session/x") else {
            panic!("a session destination is refused");
        };
        assert!(
            matches!(&err, AppError::PushDestinationIsAgentSession { branch, remote, dest } if branch == "topic" && remote == "https://***@host/o/r" && dest == "gd/session/x"),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "\"topic\" would push to https://***@host/o/r/gd/session/x, which is in gd/session/ — reserved for agent sessions, so GitDesktop won't push to it."
        );
        let Err(err) = super::refuse_session_destination("topic", "origin", "gd/session/x") else {
            panic!("a session destination on a named remote is refused");
        };
        assert!(
            matches!(&err, AppError::PushDestinationIsAgentSession { remote, .. } if remote == "origin"),
            "{err:?}"
        );
        assert!(super::refuse_session_destination("topic", URL, "feature").is_ok());
    }
}
