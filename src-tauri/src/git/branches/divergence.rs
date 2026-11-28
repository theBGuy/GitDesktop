use super::*;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePair {
    pub base: String,
    pub head: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMergeState {
    /// `head` is fully contained in `base` — nothing left to merge.
    pub merged: bool,
    /// The `head` branch still exists locally.
    pub head_exists: bool,
}

/// For each (base, head) pair, whether `head` is merged into `base` and whether
/// the `head` branch still exists. Reconciles local PRs whose branch was merged
/// (→ merged) or deleted (→ closed) outside the app.
#[tauri::command]
pub async fn git_branch_merge_states(
    repo_path: String,
    pairs: Vec<MergePair>,
) -> AppResult<Vec<BranchMergeState>> {
    let mut result = Vec::with_capacity(pairs.len());
    for pair in pairs {
        // The branch-name gate, not the ref gate: this reconciles LOCAL PR records,
        // and a record persisted with a rev expression (`feature~1`) would pass the
        // probe below and auto-transition the PR against a commit no branch is at.
        let valid_head = validate_branch_name(&pair.head).is_ok();
        let head_exists = if valid_head {
            run_git_raw(
                Some(&repo_path),
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", pair.head),
                ],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        let merged = if valid_head && validate_branch_name(&pair.base).is_ok() {
            // Both are branch names: read as the branches, never same-named tags.
            let head = branch_first_rev(&repo_path, &pair.head).await;
            let base = branch_first_rev(&repo_path, &pair.base).await;
            run_git_raw(
                Some(&repo_path),
                &["merge-base", "--is-ancestor", &head, &base],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        result.push(BranchMergeState {
            merged,
            head_exists,
        });
    }
    Ok(result)
}

// %(ahead-behind:<base>) prints ahead first; the rev-list loop below prints behind
// first, so the atom's counts must keep their own order.
fn parse_ahead_behind(base: &str, stdout: &str) -> Option<Vec<BranchDivergence>> {
    let mut rows = Vec::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let mut tokens = line.rsplitn(3, ' ');
        let behind = tokens.next()?.parse::<u32>().ok()?;
        let ahead = tokens.next()?.parse::<u32>().ok()?;
        let name = tokens.next()?.strip_prefix("refs/heads/")?;
        if name.is_empty() || name.contains(' ') {
            return None;
        }
        rows.push(BranchDivergence {
            name: name.to_string(),
            ahead: if name == base { 0 } else { ahead },
            behind: if name == base { 0 } else { behind },
        });
    }
    Some(rows)
}

fn parse_git_version(stdout: &str) -> Option<(u32, u32)> {
    let mut parts = stdout.trim().strip_prefix("git version ")?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

async fn ahead_behind_supported() -> bool {
    static SUPPORTED: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    match SUPPORTED
        .get_or_try_init(|| async {
            let out = run_git_raw(None, &["version"], DEFAULT_TIMEOUT).await?;
            Ok::<bool, AppError>(
                out.code == 0
                    && parse_git_version(&out.stdout_lossy()).is_some_and(|v| v >= (2, 41)),
            )
        })
        .await
    {
        Ok(supported) => *supported,
        Err(_) => false,
    }
}

async fn divergence_single_spawn(
    repo_path: &str,
    base: &str,
    base_rev: &str,
) -> AppResult<Option<Vec<BranchDivergence>>> {
    // These characters can change the for-each-ref format string's meaning, so
    // such a base must skip the fast path.
    if base_rev.contains([')', '%']) {
        return Ok(None);
    }
    let out = run_git_raw(
        Some(repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            &format!("--format=%(refname) %(ahead-behind:{base_rev})"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(parse_ahead_behind(base, &out.stdout_lossy()))
}

/// Compare branches to one base rev (default branch or compare base); the base itself reports 0/0.
/// Git >= 2.41 uses one for-each-ref. Refused bases, unreadable output, or any non-zero exit
/// (unsupported atom, unresolvable base) use per-branch rev-list; spawn errors/timeouts propagate.
#[tauri::command]
pub async fn git_branch_divergence(
    repo_path: String,
    base: String,
) -> AppResult<Vec<BranchDivergence>> {
    validate_ref_name(&base)?;
    let base_rev = branch_first_rev(&repo_path, &base).await;
    if ahead_behind_supported().await {
        if let Some(rows) = divergence_single_spawn(&repo_path, &base, &base_rev).await? {
            return Ok(rows);
        }
    }
    divergence_per_branch(&repo_path, &base, &base_rev).await
}

async fn divergence_per_branch(
    repo_path: &str,
    base: &str,
    base_rev: &str,
) -> AppResult<Vec<BranchDivergence>> {
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", "refs/heads", "--format=%(refname)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // (full ref, name): the payload and the base comparison take the name, stripped of
    // exactly `refs/heads/` as `git_branches` strips it, and the range takes the full
    // ref (and the base its branch-first rev), which a bare name would lose to a
    // same-named tag.
    let refs: Vec<(String, String)> = out
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter_map(|full| {
            let name = full.strip_prefix("refs/heads/").filter(|n| !n.is_empty())?;
            Some((full.to_string(), name.to_string()))
        })
        .collect();

    let mut result = Vec::with_capacity(refs.len());
    for (full, name) in refs {
        if name == base {
            result.push(BranchDivergence {
                name,
                ahead: 0,
                behind: 0,
            });
            continue;
        }
        // `base...name` left/right: left = on base only (behind), right = on
        // name only (ahead). A bad/unrelated ref just yields 0/0.
        let range = format!("{base_rev}...{full}");
        let counts = run_git_raw(
            Some(repo_path),
            &["rev-list", "--left-right", "--count", &range],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let (mut behind, mut ahead) = (0u32, 0u32);
        if counts.code == 0 {
            let text = counts.stdout_lossy();
            let mut nums = text.split_whitespace();
            behind = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        result.push(BranchDivergence {
            name,
            ahead,
            behind,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{init_repo, run, temp_base};

    fn branch_divergence_tuples(rows: &[super::BranchDivergence]) -> Vec<(String, u32, u32)> {
        rows.iter()
            .map(|d| (d.name.clone(), d.ahead, d.behind))
            .collect()
    }

    #[test]
    fn branch_divergence_parses_ahead_behind() {
        let Some(rows) = super::parse_ahead_behind(
            "base",
            "refs/heads/x 3 5\n\nrefs/heads/base 7 9\nrefs/heads/feat/x 0 0\n",
        ) else {
            panic!("valid ahead/behind rows must parse");
        };
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![
                ("x".to_string(), 3, 5),
                ("base".to_string(), 0, 0),
                ("feat/x".to_string(), 0, 0),
            ]
        );
        assert!(super::parse_ahead_behind("base", "").is_some_and(|rows| rows.is_empty()));
    }

    #[test]
    fn branch_divergence_preserves_non_ascii_whitespace_in_names() {
        let Some(rows) = super::parse_ahead_behind(
            "base",
            "refs/heads/nb\u{a0}sp 3 5\nrefs/heads/tr\u{a0} 7 9\n",
        ) else {
            panic!("branch names with non-ASCII whitespace must parse");
        };
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![
                ("nb\u{a0}sp".to_string(), 3, 5),
                ("tr\u{a0}".to_string(), 7, 9)
            ]
        );
    }

    #[test]
    fn branch_divergence_rejects_malformed_ahead_behind() {
        for invalid in [
            "refs/heads/x 3",
            "refs/heads/x 3 5 extra",
            "refs/heads/x 3 5 7",
            "refs/heads/x nope 5",
            "refs/heads/x 3 nope",
            "refs/tags/x 3 5",
            "refs/heads/ 3 5",
            "refs/heads/x 4294967296 5",
            "refs/heads/x 3 4294967296",
            "refs/heads/base nope 5",
        ] {
            let stdout = format!("refs/heads/valid 1 2\n{invalid}\n");
            assert!(
                super::parse_ahead_behind("base", &stdout).is_none(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn branch_divergence_parses_git_version() {
        for (stdout, expected) in [
            ("git version 2.51.1.windows.1\n", Some((2, 51))),
            ("git version 2.39.5 (Apple Git-154)", Some((2, 39))),
            ("git version 2.40.0.123.gabc", Some((2, 40))),
            ("git version 2.41.0", Some((2, 41))),
            ("", None),
            ("not git", None),
        ] {
            assert_eq!(super::parse_git_version(stdout), expected, "{stdout}");
        }
    }

    #[tokio::test]
    async fn branch_divergence_single_spawn_matches_per_branch() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-single-spawn");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "base"]).await;
        run(&repo, &["branch", "behind"]).await;
        run(&repo, &["branch", "diverged"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base one"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base two"]).await;
        run(&repo, &["branch", "at-tip"]).await;
        run(&repo, &["switch", "-qc", "ahead"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "ahead work"]).await;
        run(&repo, &["branch", "feat/x"]).await;
        run(&repo, &["switch", "-q", "diverged"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "diverged work"]).await;

        let expected = vec![
            ("ahead".to_string(), 1, 0),
            ("at-tip".to_string(), 0, 0),
            ("base".to_string(), 0, 0),
            ("behind".to_string(), 0, 2),
            ("diverged".to_string(), 1, 2),
            ("feat/x".to_string(), 1, 0),
        ];
        let base_rev = super::branch_first_rev(&repo, "base").await;
        let fallback = super::divergence_per_branch(&repo, "base", &base_rev).await?;
        let rows = super::git_branch_divergence(repo.clone(), "base".into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            branch_divergence_tuples(&fallback)
        );
        assert_eq!(branch_divergence_tuples(&fallback), expected);

        if super::ahead_behind_supported().await {
            let fast = super::divergence_single_spawn(&repo, "base", &base_rev).await?;
            assert!(
                fast.is_some(),
                "supported git must use the single-spawn path"
            );
            if let Some(rows) = fast {
                assert_eq!(branch_divergence_tuples(&rows), expected);
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_unresolvable_base_falls_back_to_all_zero() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-missing-base");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "base"]).await;
        run(&repo, &["branch", "sibling"]).await;

        let base = "missing-base";
        super::validate_ref_name(base)?;
        let base_rev = super::branch_first_rev(&repo, base).await;
        assert!(super::divergence_single_spawn(&repo, base, &base_rev)
            .await?
            .is_none());
        let rows = super::git_branch_divergence(repo, base.into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![("base".to_string(), 0, 0), ("sibling".to_string(), 0, 0)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_percent_base_refuses_fast_path() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-percent-base");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let base = "odd%base";
        run(&repo, &["branch", "-m", base]).await;
        run(&repo, &["branch", "sibling"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base one"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base two"]).await;
        run(&repo, &["switch", "-q", "sibling"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "sibling work"]).await;

        super::validate_ref_name(base)?;
        let base_rev = super::branch_first_rev(&repo, base).await;
        assert!(super::divergence_single_spawn(&repo, base, &base_rev)
            .await?
            .is_none());
        let fallback = super::divergence_per_branch(&repo, base, &base_rev).await?;
        let rows = super::git_branch_divergence(repo, base.into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            branch_divergence_tuples(&fallback)
        );
        assert_eq!(
            branch_divergence_tuples(&fallback),
            vec![
                ("odd%base".to_string(), 0, 0),
                ("sibling".to_string(), 1, 2)
            ]
        );
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_empty_repo_reports_no_rows() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-empty-repo");
        let repo = path.to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        let rows = super::git_branch_divergence(repo, "base".into()).await?;
        assert!(rows.is_empty());
        Ok(())
    }

    /// Rows are named by the real branch and measured through its full ref, and the
    /// base is read as a branch too: a bare `feature` or base name would resolve to the
    /// same-named tag (gitrevisions checks tags first) and report the tag's counts.
    #[tokio::test]
    async fn branch_divergence_names_and_measures_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("divergence-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Both tags stay on the seed while both branches move past it.
        run(&repo_s, &["tag", &main]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        run(&repo_s, &["tag", "feature"]).await;
        std::fs::write(repo.join("f.txt"), "f\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "feature work"]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("m.txt"), "m\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work"]).await;

        let rows = super::git_branch_divergence(repo_s.clone(), main.clone())
            .await
            .expect("measure divergence");
        let mut got: Vec<(String, u32, u32)> = rows
            .into_iter()
            .map(|d| (d.name, d.ahead, d.behind))
            .collect();
        got.sort();
        let mut want = vec![("feature".to_string(), 1, 1), (main.clone(), 0, 0)];
        want.sort();
        assert_eq!(got, want);
    }

    /// `git_branch_merge_states` answers a SHAPE, never an error: a name the branch
    /// gate refuses reads as `merged: false, head_exists: false`. The rows that
    /// discriminate are the ones `rev-parse --verify refs/heads/<name>` RESOLVES
    /// (`feature~1`, `<base>^`, `feature^{commit}`) — ungated, those report a live
    /// branch and an ancestor-merged verdict for a ref no branch is at.
    #[tokio::test]
    async fn branch_merge_states_refuse_rev_expressions_as_unmerged_and_absent() {
        let (_base, base_dir) = temp_base("merge-states-revs");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        // Two commits on the base branch, so `<base>^` resolves; `landed` sits at
        // that tip (merged), `feature` one commit past it (not merged).
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        std::fs::write(repo.join("a.txt"), "second\n").unwrap();
        run(&repo_s, &["commit", "-qam", "second"]).await;
        run(&repo_s, &["branch", "landed"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let pair = |b: &str, h: &str| MergePair {
            base: b.to_string(),
            head: h.to_string(),
        };
        // The probe itself works: a merged branch and an unmerged one, both live.
        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![pair(&base, "landed"), pair(&base, "feature")],
        )
        .await
        .expect("real pairs resolve");
        assert_eq!((states[0].merged, states[0].head_exists), (true, true));
        assert_eq!((states[1].merged, states[1].head_exists), (false, true));

        // HEAD side: every rev shape and refspec metacharacter reads absent.
        for head in [
            "feature~1",
            &format!("{base}^"),
            "feature^{commit}",
            "HEAD@{1}",
            &format!("{base}..feature"),
            "@",
            "a*b",
            "a:b",
        ] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(&base, head)])
                .await
                .expect("a refused name is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, false),
                "head {head:?}"
            );
        }

        // BASE side: the head stays live, but nothing may be reported merged INTO a
        // rev expression. `feature~1` and `feature^{commit}` both have `landed` as
        // an ancestor, so an ungated base flips `merged` to true.
        for bad_base in ["feature~1", "feature^{commit}", "@", "a*b"] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(bad_base, "landed")])
                .await
                .expect("a refused base is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, true),
                "base {bad_base:?}"
            );
        }
    }

    /// A local PR's head is measured as the BRANCH: a same-named tag already merged
    /// into the base must not report an unmerged branch as merged.
    #[tokio::test]
    async fn branch_merge_states_measure_a_head_shadowed_by_a_tag() {
        let (_base, base_dir) = temp_base("merge-states-shadow");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["tag", "feature"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![MergePair {
                base: base.clone(),
                head: "feature".into(),
            }],
        )
        .await
        .unwrap();
        assert_eq!((states[0].merged, states[0].head_exists), (false, true));
    }
}
