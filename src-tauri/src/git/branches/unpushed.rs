use super::*;

/// Whether a commit is reachable from any remote-tracking ref (`refs/remotes/*`) —
/// i.e. it has been pushed. Gates the History-tab comment surface and GUI Undo's
/// no-upstream check, so a failed run is an Err, never a defaulted "not pushed". The
/// sha is validated (hex) BEFORE spawning git. `--contains` exits 0 while skipping a
/// ref whose tip object is missing, so an empty answer stands only once a plain
/// listing exits 0 (nonzero on a missing tip object). Out of reach here (git 2.51.1):
/// both skip an unparseable ref file with only a warning, and a missing ANCESTOR
/// object makes `--contains` over-report, which errs toward "pushed".
#[tauri::command]
pub async fn commit_on_remote(repo_path: String, sha: String) -> AppResult<bool> {
    crate::git::history::validate_hash(&sha)?;
    let failed = |out: &crate::git::runner::GitOutput| {
        AppError::Command(format!(
            "couldn't check whether {sha} is on a remote.\n{}",
            out.full_failure_text()
        ))
    };
    let out = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/remotes",
            "--contains",
            &sha,
            "--format=%(refname)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(failed(&out));
    }
    if !out.stdout_lossy().trim().is_empty() {
        return Ok(true);
    }
    let tips = run_git_raw(
        Some(&repo_path),
        &["for-each-ref", "refs/remotes", "--format=%(objecttype)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tips.code != 0 {
        return Err(failed(&tips));
    }
    Ok(false)
}

/// What git_unpushed_count counted against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnpushedBasis {
    Remotes,
    DefaultBranch,
    OnDefaultBranch,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCount {
    pub count: u32,
    pub basis: UnpushedBasis,
    /// Some only for DefaultBranch and OnDefaultBranch.
    pub default_branch: Option<String>,
    /// The full oid HEAD resolved to when the count was taken, the identity the
    /// frontend pairs the count with its log by; `None` only on an unborn HEAD.
    pub head_oid: Option<String>,
}

/// Commits on `HEAD` the History tab marks "not pushed" on a branch with NO upstream,
/// and what they were counted against. With any object-resolving remote-tracking ref,
/// or any configured remote, it counts `HEAD --not --remotes` (`Remotes`; every
/// commit while nothing was fetched). With no configured remote it counts past the
/// verified local default branch (`DefaultBranch`, detached HEAD included); on that
/// branch itself, or with no verifiable default, every `HEAD` commit counts
/// (`OnDefaultBranch` hides the arrows only; `Unresolved` keeps them). Only an unborn
/// `HEAD` answers 0; any failed run, the remote listing included, is an Err. Spawns:
/// the ref probe, the HEAD read and rev-list, plus the remote listing when no remote
/// ref resolved.
/// The no-remote paths add git_default_branch's up to 4 (no remote to sweep), run
/// concurrently with the HEAD-branch read, then the verify (only when a default
/// resolved).
#[tauri::command]
pub async fn git_unpushed_count(repo_path: String) -> AppResult<UnpushedCount> {
    let failed =
        |text: String| AppError::Command(format!("couldn't count the unpushed commits.\n{text}"));
    // A dangling refs/remotes/*/HEAD symref prints nothing here, matching what
    // `--remotes` can exclude; `--count` applies after that skip (git 2.51.1).
    let probe = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(objectname)",
            "refs/remotes",
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_err(|e| failed(e.to_string()))?;
    if probe.code != 0 {
        return Err(failed(probe.full_failure_text()));
    }
    let has_remote_refs = probe.stdout_lossy().lines().any(|l| !l.trim().is_empty());
    // A configured remote with nothing fetched yet has received none of HEAD, so it
    // keeps the remotes basis; a failed listing errs rather than reading as none.
    let has_remote = has_remote_refs
        || !crate::git::remote::git_remotes(repo_path.clone())
            .await
            .map_err(|e| failed(e.to_string()))?
            .is_empty();

    let mut default_ref = None;
    let (basis, default_branch) = if has_remote {
        (UnpushedBasis::Remotes, None)
    } else {
        // Independent reads, joined so the count's latency after a commit isn't
        // their sum; boxed to keep the command future small.
        let (default, head) = tokio::join!(
            Box::pin(git_default_branch(repo_path.clone())),
            Box::pin(current_branch_name(&repo_path)),
        );
        let default = default.map_err(|e| failed(e.to_string()))?;
        let head = head.map_err(|e| failed(e.to_string()))?;
        match default {
            None => (UnpushedBasis::Unresolved, None),
            Some(name) => {
                // Only git_default_branch's main/master fallback verifies its ref; a
                // remote HEAD's target can name a branch with no local ref.
                let full = format!("refs/heads/{name}");
                let verify = run_git_raw(
                    Some(&repo_path),
                    &["rev-parse", "--verify", "--quiet", &full],
                    DEFAULT_TIMEOUT,
                )
                .await
                .map_err(|e| failed(e.to_string()))?;
                match verify.code {
                    0 => {
                        if head.as_deref() == Some(name.as_str()) {
                            (UnpushedBasis::OnDefaultBranch, Some(name))
                        } else {
                            default_ref = Some(full);
                            (UnpushedBasis::DefaultBranch, Some(name))
                        }
                    }
                    1 => (UnpushedBasis::Unresolved, None),
                    _ => return Err(failed(verify.full_failure_text())),
                }
            }
        }
    };

    // HEAD resolves ONCE and the count runs from that oid, so the oid returned is the
    // commit counted from even when HEAD moves mid-read. Only an unborn HEAD answers 0.
    let resolved = match crate::git::history::read_unless_unborn(
        &repo_path,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(Some(out)) => out,
        Ok(None) => {
            return Ok(UnpushedCount {
                count: 0,
                basis,
                default_branch,
                head_oid: None,
            })
        }
        Err(e) => return Err(failed(e.to_string())),
    };
    let head_oid = resolved.stdout_lossy().trim().to_string();
    if head_oid.is_empty() {
        return Err(failed("HEAD resolved to nothing".into()));
    }
    let mut args = vec!["rev-list", "--count", head_oid.as_str()];
    match (&basis, &default_ref) {
        (UnpushedBasis::Remotes, _) => args.extend(["--not", "--remotes"]),
        (_, Some(full)) => args.extend(["--not", full.as_str()]),
        _ => {}
    }
    let out = run_git_raw(Some(&repo_path), &args, DEFAULT_TIMEOUT)
        .await
        .map_err(|e| failed(e.to_string()))?;
    if out.code != 0 {
        return Err(failed(out.full_failure_text()));
    }
    let stdout = out.stdout_lossy();
    let count = stdout
        .trim()
        .parse()
        .map_err(|_| failed(format!("unexpected rev-list output: {}", stdout.trim())))?;
    Ok(UnpushedCount {
        count,
        basis,
        default_branch,
        head_oid: Some(head_oid),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{init_repo, run, temp_base};
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    /// Pins the measured exit of `for-each-ref --contains` on a well-formed oid
    /// the repo lacks, which decides how `commit_on_remote` reads an empty answer.
    #[tokio::test]
    async fn commit_on_remote_errs_for_an_unknown_oid() {
        let (_base, base) = temp_base("on-remote-unknown");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        let unknown = "0123456789abcdef0123456789abcdef01234567";
        let raw = run_git_raw(
            Some(&repo),
            &[
                "for-each-ref",
                "refs/remotes",
                "--contains",
                unknown,
                "--format=%(refname)",
            ],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(
            raw.code, 0,
            "for-each-ref answered an unknown oid with exit 0"
        );
        let result = super::commit_on_remote(repo.clone(), unknown.into()).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }

    #[tokio::test]
    async fn commit_on_remote_answers_from_remote_tracking_refs() {
        let (_base, base) = temp_base("on-remote-answers");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let pushed = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]).await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert!(super::commit_on_remote(repo.clone(), pushed).await.unwrap());
        assert!(!super::commit_on_remote(repo.clone(), local).await.unwrap());
    }

    /// `--contains` skips a remote-tracking ref whose tip object is missing and still
    /// exits 0, so the empty answer must not read as "not on a remote".
    #[tokio::test]
    async fn commit_on_remote_errs_when_a_remote_tip_is_missing() {
        let (_base, base) = temp_base("on-remote-missing-tip");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        // update-ref refuses a missing object, so the loose ref is written directly.
        let refs = base
            .join(".git")
            .join("refs")
            .join("remotes")
            .join("origin");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(
            refs.join("main"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        let result = super::commit_on_remote(repo.clone(), local).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }

    /// A stale `origin/HEAD` symref to a deleted branch is common and names no tip, so
    /// it leaves an empty answer standing.
    #[tokio::test]
    async fn commit_on_remote_reads_past_a_dangling_remote_head_symref() {
        let (_base, base) = temp_base("on-remote-dangling-head");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]).await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        let refs = base
            .join(".git")
            .join("refs")
            .join("remotes")
            .join("origin");
        std::fs::write(refs.join("HEAD"), "ref: refs/remotes/origin/gone\n").unwrap();
        assert!(!super::commit_on_remote(repo.clone(), local).await.unwrap());
    }

    /// Expected `git_unpushed_count` answer: (count, basis, default branch), with the
    /// head oid read here (`None` where HEAD doesn't verify: unborn).
    async fn assert_unpushed(repo: &str, count: u32, basis: UnpushedBasis, default: Option<&str>) {
        let head = run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        let head_oid = (head.code == 0).then(|| head.stdout_lossy().trim().to_string());
        let got = super::git_unpushed_count(repo.to_string()).await.unwrap();
        assert_eq!(
            got,
            UnpushedCount {
                count,
                basis,
                default_branch: default.map(str::to_string),
                head_oid,
            }
        );
    }

    async fn commit_empty(repo: &str, message: &str) {
        run(repo, &["commit", "-q", "--allow-empty", "-m", message]).await;
    }

    /// A seed commit plus one more, on a branch named `master`.
    async fn init_master_repo(repo: &str) {
        init_repo(repo, "r.txt").await;
        run(repo, &["branch", "-m", "master"]).await;
        commit_empty(repo, "two").await;
    }

    #[tokio::test]
    async fn unpushed_count_reads_zero_on_an_unborn_head() {
        let (_base, base) = temp_base("unpushed-unborn");
        let repo = base.to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        // No main/master ref exists before the first commit.
        assert_unpushed(&repo, 0, UnpushedBasis::Unresolved, None).await;
        let got = super::git_unpushed_count(repo).await.unwrap();
        assert_eq!(got.head_oid, None);
    }

    /// The count carries the commit it was counted from: the detached commit on a
    /// detached HEAD, the branch tip otherwise, on the remotes basis too.
    #[tokio::test]
    async fn unpushed_count_returns_the_head_oid_it_counted_from() {
        let (_base, base) = temp_base("unpushed-head-oid");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        let tip = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["checkout", "-q", "--detach", "HEAD~1"]).await;
        let detached = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert_ne!(detached, tip, "fixture: the detached commit is not the tip");
        let got = super::git_unpushed_count(repo.clone()).await.unwrap();
        assert_eq!(got.head_oid.as_deref(), Some(detached.as_str()));
        assert_eq!(got.basis, UnpushedBasis::DefaultBranch);
        assert_eq!(got.count, 0);

        run(&repo, &["switch", "-q", "master"]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD~1"]).await;
        let got = super::git_unpushed_count(repo).await.unwrap();
        assert_eq!(got.head_oid.as_deref(), Some(tip.as_str()));
        assert_eq!((got.basis, got.count), (UnpushedBasis::Remotes, 1));
    }

    #[tokio::test]
    async fn unpushed_count_excludes_remote_tracking_refs() {
        let (_base, base) = temp_base("unpushed-remotes");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        commit_empty(&repo, "local").await;
        assert_unpushed(&repo, 1, UnpushedBasis::Remotes, None).await;
    }

    /// The probe's `--count=1` must apply after for-each-ref skips the dangling
    /// symref that sorts ahead of the real remote ref.
    #[tokio::test]
    async fn unpushed_count_probe_sees_a_remote_ref_behind_a_dangling_head() {
        let (_base, base) = temp_base("unpushed-dangling-first");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/aaa/HEAD",
                "refs/remotes/aaa/master",
            ],
        )
        .await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        commit_empty(&repo, "local").await;
        assert_unpushed(&repo, 1, UnpushedBasis::Remotes, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_stops_at_the_default_branch_fork_point_without_a_remote() {
        let (_base, base) = temp_base("unpushed-fork-point");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        for message in ["f1", "f2", "f3"] {
            commit_empty(&repo, message).await;
        }
        assert_unpushed(&repo, 3, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_reaches_every_commit_on_the_default_branch() {
        let (_base, base) = temp_base("unpushed-on-default");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        commit_empty(&repo, "three").await;
        assert_unpushed(&repo, 3, UnpushedBasis::OnDefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_every_commit_without_a_default_branch() {
        let (_base, base) = temp_base("unpushed-unresolved");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "topic"]).await;
        commit_empty(&repo, "two").await;
        assert_unpushed(&repo, 2, UnpushedBasis::Unresolved, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_a_whole_orphan_branch() {
        let (_base, base) = temp_base("unpushed-orphan");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "--orphan", "lone"]).await;
        commit_empty(&repo, "o1").await;
        commit_empty(&repo, "o2").await;
        assert_unpushed(&repo, 2, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_a_detached_head_past_the_default_branch() {
        let (_base, base) = temp_base("unpushed-detached");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        commit_empty(&repo, "f1").await;
        let sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["checkout", "-q", "--detach", &sha]).await;
        assert_unpushed(&repo, 1, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    /// A dangling `refs/remotes/origin/HEAD` resolves no ref, so the no-remote arms
    /// answer; its target names a default that verifies locally.
    #[tokio::test]
    async fn unpushed_count_treats_a_dangling_remote_head_as_no_remote() {
        let (_base, base) = temp_base("unpushed-dangling-verified");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/master",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::OnDefaultBranch, Some("master")).await;
    }

    /// The dangling symref's target has no local branch, so the default doesn't
    /// verify and every commit counts, even though a local master exists.
    #[tokio::test]
    async fn unpushed_count_is_unresolved_when_the_default_does_not_verify() {
        let (_base, base) = temp_base("unpushed-dangling-unverified");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::Unresolved, None).await;
    }

    /// A configured remote nothing was fetched from or pushed to yet.
    async fn add_unfetched_origin(repo: &str) {
        run(repo, &["remote", "add", "origin", "../unfetched.git"]).await;
    }

    /// With a remote configured, the default-branch basis never applies: nothing has
    /// reached that remote, so every commit counts and keeps its arrow.
    #[tokio::test]
    async fn unpushed_count_counts_every_commit_on_the_default_branch_of_an_unfetched_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-default");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        commit_empty(&repo, "three").await;
        assert_unpushed(&repo, 3, UnpushedBasis::Remotes, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_every_commit_on_a_feature_branch_of_an_unfetched_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-feature");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        commit_empty(&repo, "f1").await;
        assert_unpushed(&repo, 3, UnpushedBasis::Remotes, None).await;
    }

    /// A dangling remote HEAD beside a configured remote still leaves the remote's
    /// basis in charge, even though its target names a local branch.
    #[tokio::test]
    async fn unpushed_count_keeps_the_remote_basis_behind_a_dangling_head_of_a_configured_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-dangling");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/master",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::Remotes, None).await;
    }

    #[test]
    fn unpushed_count_wire_shape() {
        let cases = [
            (
                UnpushedBasis::Remotes,
                None,
                Some("abc"),
                r#"{"count":4,"basis":"remotes","defaultBranch":null,"headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::DefaultBranch,
                Some("main"),
                Some("abc"),
                r#"{"count":4,"basis":"default-branch","defaultBranch":"main","headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::OnDefaultBranch,
                Some("main"),
                Some("abc"),
                r#"{"count":4,"basis":"on-default-branch","defaultBranch":"main","headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::Unresolved,
                None,
                Some("abc"),
                r#"{"count":4,"basis":"unresolved","defaultBranch":null,"headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::Unresolved,
                None,
                None,
                r#"{"count":4,"basis":"unresolved","defaultBranch":null,"headOid":null}"#,
            ),
        ];
        for (basis, default, head, want) in cases {
            let json = serde_json::to_string(&UnpushedCount {
                count: 4,
                basis,
                default_branch: default.map(str::to_string),
                head_oid: head.map(str::to_string),
            })
            .unwrap();
            assert_eq!(json, want);
            for snake in [
                "default_branch",
                "on_default_branch",
                "OnDefaultBranch",
                "head_oid",
            ] {
                assert!(!json.contains(snake), "{json}");
            }
        }
    }

    #[tokio::test]
    async fn unpushed_count_errs_outside_a_repository() {
        let (_base, base) = temp_base("unpushed-broken");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        std::fs::rename(base.join(".git"), base.join("git-moved")).unwrap();
        let result = super::git_unpushed_count(repo).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }
}
