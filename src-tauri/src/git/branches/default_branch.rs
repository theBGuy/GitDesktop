use super::*;

/// The repository's default branch: the HEAD a remote points at — `origin` first,
/// then every other remote in `git remote` order, so a clone made with `-o <name>`
/// resolves too — otherwise a local "main"/"master" if one exists.
///
/// Local refs only, no network: this runs in read paths and takes no `State`, so a
/// remote whose `refs/remotes/<remote>/HEAD` symref was never written (a hand-added
/// one) falls through to the local-name fallback.
#[tauri::command]
pub async fn git_default_branch(repo_path: String) -> AppResult<Option<String>> {
    // Origin answers almost every repo, so probe it before paying for a remote
    // listing — the common case stays at one git spawn.
    if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, "origin").await? {
        return Ok(Some(name));
    }
    // Only now list, and sweep the OTHER remotes in `git remote` order — a clone made
    // with `-o <name>` keeps its HEAD there. Best-effort: an unlistable remote set
    // just leaves no remote HEAD to consult, which the fallback below already covers.
    let remotes = crate::git::remote::git_remotes(repo_path.clone())
        .await
        .unwrap_or_default();
    for remote in remotes.iter().filter(|r| r.as_str() != "origin") {
        if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, remote).await? {
            return Ok(Some(name));
        }
    }
    for candidate in ["main", "master"] {
        let exists = run_git_raw(
            Some(&repo_path),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ],
            DEFAULT_TIMEOUT,
        )
        .await?
        .code
            == 0;
        if exists {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

/// The target of the `ref: <target>\tHEAD` line of `ls-remote --symref` output: the first
/// line starting `ref: ` must split at its tab into a non-empty target and exactly `HEAD`.
pub(crate) fn parse_symref_head(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|line| line.starts_with("ref: "))?;
    let (target, name) = line.strip_prefix("ref: ")?.split_once('\t')?;
    (!target.is_empty() && name == "HEAD").then(|| target.to_string())
}

/// Live `ls-remote --symref <remote> HEAD`: the remote's default as a full ref; `Ok(None)`
/// when it printed no symref line. A spawn error, timeout or non-zero exit is the `Err`.
pub(crate) async fn live_remote_default(
    repo_path: &str,
    remote: &str,
) -> AppResult<Option<String>> {
    validate_ref_name(remote)?;
    if !crate::git::remote::is_named_remote(remote) {
        return Err(AppError::InvalidArgument(format!(
            "invalid remote: {remote}"
        )));
    }
    let cred = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    let out = crate::git::remote::run_git_with_creds_once(
        repo_path,
        &cred,
        &["ls-remote", "--symref", remote, "HEAD"],
        REMOTE_READ_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(parse_symref_head(&out.stdout_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{init_repo, keep_local_repo, run, temp_base};
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    #[test]
    fn parse_symref_head_reads_only_the_head_symref_line() {
        use super::parse_symref_head;
        let sha = "a".repeat(40);
        let f1 = format!(
            "ref: refs/heads/main\tHEAD\n{sha}\tHEAD\n{sha}\trefs/heads/old\n{sha}\trefs/heads/x/refs/heads/old\n"
        );
        assert_eq!(parse_symref_head(&f1).as_deref(), Some("refs/heads/main"));
        assert_eq!(parse_symref_head(&format!("{sha}\tHEAD\n")), None);
        assert_eq!(
            parse_symref_head("ref: refs/heads/main\trefs/heads/x\n"),
            None
        );
        assert_eq!(parse_symref_head("ref: \tHEAD\n"), None);
    }

    /// `git clone -o upstream` writes `refs/remotes/upstream/HEAD` and no origin ref
    /// at all, so resolution has to consult whatever remotes the repo actually has.
    /// The source branch is named `trunk` — a name the local main/master fallback
    /// can never produce, so only the remote HEAD can satisfy this.
    #[tokio::test]
    async fn default_branch_resolves_a_clone_whose_remote_isnt_origin() {
        let (_base, base) = temp_base("default-branch-upstream");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let src_s = src.to_string_lossy().into_owned();
        init_repo(&src_s, "r.txt").await;
        run(&src_s, &["branch", "-m", "trunk"]).await;

        let clone_s = base.join("clone").to_string_lossy().into_owned();
        run_git(
            None,
            &["clone", "-q", "-o", "upstream", &src_s, &clone_s],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("local clone succeeds");

        assert_eq!(
            git_default_branch(clone_s).await.expect("resolves"),
            Some("trunk".to_string()),
            "the only remote's HEAD answers even when it isn't named origin"
        );
    }

    /// With several remotes, origin still wins — it is tried before the others
    /// regardless of where `git remote` lists it.
    #[tokio::test]
    async fn default_branch_prefers_origin_over_other_remotes() {
        let (_base, base) = temp_base("default-branch-origin-wins");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // URLs are the repo's own path — nothing is ever fetched; the HEAD symrefs
        // are written by hand, exactly as a clone would leave them. `canonical` sorts
        // before `origin`, so it is the remote a naive "first listed wins" would pick.
        for remote in ["canonical", "origin"] {
            run(&repo_s, &["remote", "add", remote, &repo_s]).await;
            let head = format!("refs/remotes/{remote}/{remote}-head");
            run(&repo_s, &["update-ref", &head, "HEAD"]).await;
            run(
                &repo_s,
                &[
                    "symbolic-ref",
                    &format!("refs/remotes/{remote}/HEAD"),
                    &head,
                ],
            )
            .await;
        }
        assert!(
            run(&repo_s, &["remote"])
                .await
                .trim()
                .starts_with("canonical"),
            "fixture must list a non-origin remote first for this to discriminate"
        );

        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            Some("origin-head".to_string()),
            "origin's HEAD wins over another remote's"
        );
    }

    /// No remote HEAD to read: local `main`/`master` answer, anything else is `None`.
    /// A remote whose HEAD symref was never written (a hand-added one) must fall
    /// through here rather than reaching for the network.
    #[tokio::test]
    async fn default_branch_falls_back_to_local_names() {
        let (_base, base) = temp_base("default-branch-fallback");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "-m", "master"]).await;
        assert_eq!(
            git_default_branch(repo_s.clone()).await.expect("resolves"),
            Some("master".to_string()),
            "a remote-less repo falls back to its local master"
        );

        run(&repo_s, &["remote", "add", "upstream", &repo_s]).await;
        run(&repo_s, &["branch", "-m", "topic"]).await;
        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            None,
            "a remote with no HEAD symref and no main/master resolves to nothing"
        );
    }

    /// Every remote-default shape, from the one list spawn: default, non-default, a
    /// slash-named remote, no HEAD symref, a dangling one, gone, local `.`, a non-branch
    /// upstream, untracked; a remote branch named `feat/HEAD` and the remote HEAD rows
    /// never become branch rows.
    #[tokio::test]
    async fn remote_default_flag_matches_each_probe_row() {
        let (_guard, _base, repo_s) = keep_local_repo("remote-default").await;
        for remote in ["origin", "team/fork", "nohead", "dangle"] {
            run(&repo_s, &["remote", "add", remote, &repo_s]).await;
        }
        for tracking in [
            "refs/remotes/origin/main",
            "refs/remotes/origin/dev",
            "refs/remotes/origin/feat/HEAD",
            "refs/remotes/team/fork/trunk",
            "refs/remotes/nohead/main",
        ] {
            run(&repo_s, &["update-ref", tracking, "HEAD"]).await;
        }
        for (head, target) in [
            ("refs/remotes/origin/HEAD", "refs/remotes/origin/main"),
            (
                "refs/remotes/team/fork/HEAD",
                "refs/remotes/team/fork/trunk",
            ),
            ("refs/remotes/dangle/HEAD", "refs/remotes/dangle/gone"),
        ] {
            run(&repo_s, &["symbolic-ref", head, target]).await;
        }
        let rows = [
            ("on-default", Some(("origin", "refs/heads/main")), true),
            ("on-dev", Some(("origin", "refs/heads/dev")), false),
            ("slash", Some(("team/fork", "refs/heads/trunk")), true),
            ("gone-b", Some(("origin", "refs/heads/deleted")), false),
            ("nohead-b", Some(("nohead", "refs/heads/main")), false),
            ("dangle-b", Some(("dangle", "refs/heads/gone")), false),
            ("local-up", Some((".", "refs/heads/main")), false),
            ("pr-b", Some(("origin", "refs/pull/1/head")), false),
            ("untracked", None, false),
        ];
        for (name, upstream, _) in rows {
            run(&repo_s, &["branch", name]).await;
            if let Some((remote, merge)) = upstream {
                run(
                    &repo_s,
                    &["config", &format!("branch.{name}.remote"), remote],
                )
                .await;
                run(&repo_s, &["config", &format!("branch.{name}.merge"), merge]).await;
            }
        }

        let branches = git_branches(repo_s.clone()).await.unwrap();
        let mut names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        names.sort_unstable();
        let mut expected: Vec<&str> = rows.iter().map(|(n, _, _)| *n).collect();
        expected.push("main");
        expected.sort_unstable();
        assert_eq!(names, expected, "only refs/heads rows");
        for (name, _, default) in rows {
            let row = branches.iter().find(|b| b.name == name).unwrap();
            assert_eq!(row.upstream_is_remote_default, default, "{row:?}");
        }
        assert!(
            branches
                .iter()
                .find(|b| b.name == "gone-b")
                .unwrap()
                .upstream_gone
        );

        // No remotes at all: nothing is a remote default.
        let (_guard2, _base2, bare_s) = keep_local_repo("remote-default-none").await;
        let only = git_branches(bare_s).await.unwrap();
        assert_eq!(only.len(), 1);
        assert!(!only[0].upstream_is_remote_default && !only[0].keep_local);
    }
}
