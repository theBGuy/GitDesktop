//! Content check for branch cleanup: whether merging a branch into the default
//! branch would add anything, measured with `git merge-tree --write-tree` so a
//! squash- or rebase-merged branch reads as merged even though its commits aren't.

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::branches::{branch_tip_sha, validate_branch_name};
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentCheckBase {
    /// The ref the verdicts compare against, as the UI names it: "main" or "origin/main".
    pub ref_name: String,
    pub sha: String,
    /// `sha`'s tree OID, resolved once per dialog open so each verdict compares
    /// merge-tree's written tree against it without a per-row spawn.
    pub tree: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContentVerdict {
    Clean,
    Changes,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchContentMerged {
    pub branch: String,
    pub verdict: ContentVerdict,
    /// The branch tip the verdict was computed for; None when it didn't resolve.
    pub head_sha: Option<String>,
}

fn parse_git_version(stdout: &str) -> Option<(u32, u32)> {
    let mut parts = stdout.trim().strip_prefix("git version ")?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// `merge-tree --write-tree` and `--name-only` both landed in git 2.38; an
/// unparseable version reads as unsupported.
fn supports_write_tree(version_stdout: &str) -> bool {
    parse_git_version(version_stdout).is_some_and(|v| v >= (2, 38))
}

async fn merge_tree_write_supported() -> bool {
    static SUPPORTED: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    match SUPPORTED
        .get_or_try_init(|| async {
            let out = run_git_raw(None, &["version"], DEFAULT_TIMEOUT).await?;
            Ok::<bool, AppError>(out.code == 0 && supports_write_tree(&out.stdout_lossy()))
        })
        .await
    {
        Ok(supported) => *supported,
        Err(_) => false,
    }
}

/// A full object id, lowercase as git prints it. Never starts with `-`, so it is
/// safe in any argv position.
fn validate_oid(oid: &str, what: &str) -> AppResult<()> {
    let hex = oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex || !(40..=64).contains(&oid.len()) {
        return Err(AppError::InvalidArgument(format!("invalid {what}: {oid}")));
    }
    Ok(())
}

/// The commit `full_ref` points at, or None when it doesn't resolve.
async fn resolve_commit(repo_path: &str, full_ref: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{full_ref}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(out.stdout_lossy().trim().to_string()))
}

/// The default branch's remote-tracking counterpart as `(full ref, sha)`: its
/// configured upstream when that is a remote-tracking ref that resolves (a local
/// upstream, remote `.`, is not one), else `refs/remotes/origin/<default>`.
async fn remote_side(repo_path: &str, default_branch: &str) -> AppResult<Option<(String, String)>> {
    // `<branch>@{upstream}` stays bare: git refuses the `refs/heads/` spelling there.
    let upstream = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--symbolic-full-name",
            &format!("{default_branch}@{{upstream}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if upstream.code == 0 {
        let full = upstream.stdout_lossy().trim().to_string();
        if full.starts_with("refs/remotes/") {
            if let Some(sha) = resolve_commit(repo_path, &full).await? {
                return Ok(Some((full, sha)));
            }
        }
    }
    let origin = format!("refs/remotes/origin/{default_branch}");
    Ok(resolve_commit(repo_path, &origin)
        .await?
        .map(|sha| (origin, sha)))
}

/// The base the cleanup dialog's verdicts compare against, resolved once per open:
/// the newer of the local default branch and its remote-tracking counterpart.
/// Remote wins when local is an ancestor of it (equal included); ahead, diverged,
/// or a failed ancestry probe keep local, since an older base can only add
/// "changes", never a false clean. Ok(None) on git older than 2.38 or when
/// neither side resolves.
#[tauri::command]
pub async fn git_content_check_base(
    repo_path: String,
    default_branch: String,
) -> AppResult<Option<ContentCheckBase>> {
    validate_branch_name(&default_branch)?;
    if !merge_tree_write_supported().await {
        return Ok(None);
    }
    let local = branch_tip_sha(&repo_path, &default_branch).await?;
    let remote = remote_side(&repo_path, &default_branch).await?;
    let (ref_name, sha) = match (local, remote) {
        (None, None) => return Ok(None),
        (Some(local), None) => (default_branch, local),
        (None, Some((full, sha))) => (display_remote(&full), sha),
        (Some(local), Some((full, remote_sha))) => {
            let ancestor = run_git_raw(
                Some(&repo_path),
                &["merge-base", "--is-ancestor", &local, &remote_sha],
                DEFAULT_TIMEOUT,
            )
            .await;
            if matches!(ancestor, Ok(ref out) if out.code == 0) {
                (display_remote(&full), remote_sha)
            } else {
                (default_branch, local)
            }
        }
    };
    let tree = run_git(
        Some(&repo_path),
        &["rev-parse", "--verify", &format!("{sha}^{{tree}}")],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    Ok(Some(ContentCheckBase {
        ref_name,
        sha,
        tree,
    }))
}

fn display_remote(full_ref: &str) -> String {
    full_ref
        .strip_prefix("refs/remotes/")
        .unwrap_or(full_ref)
        .to_string()
}

/// Whether `branch` carries anything `base_sha` lacks: `clean` when merging its tip
/// into the base cleanly writes exactly `base_tree`, `changes` on a different tree
/// or a conflict (never read as merged), `unknown` on any other outcome. Every git
/// failure after validation is `unknown` rather than Err, because consumers gate on
/// the verdict; Err is reserved for invalid input, refused before any spawn.
#[tauri::command]
pub async fn git_branch_content_merged(
    repo_path: String,
    base_sha: String,
    base_tree: String,
    branch: String,
) -> AppResult<BranchContentMerged> {
    validate_branch_name(&branch)?;
    validate_oid(&base_sha, "base commit")?;
    validate_oid(&base_tree, "base tree")?;
    let verdict = |verdict, head_sha| BranchContentMerged {
        branch: branch.clone(),
        verdict,
        head_sha,
    };
    // The merge runs on the resolved tip, never the name, so the verdict belongs to
    // exactly the sha reported as `head_sha`.
    let Ok(Some(tip)) = branch_tip_sha(&repo_path, &branch).await else {
        return Ok(verdict(ContentVerdict::Unknown, None));
    };
    let Ok(mt) = run_git_raw(
        Some(&repo_path),
        &["merge-tree", "--write-tree", "--name-only", &base_sha, &tip],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return Ok(verdict(ContentVerdict::Unknown, Some(tip)));
    };
    let stdout = mt.stdout_lossy();
    let written = stdout.lines().next().map(str::trim).unwrap_or_default();
    let outcome = match (mt.code, written.is_empty()) {
        (_, true) => ContentVerdict::Unknown,
        (0, false) if written == base_tree => ContentVerdict::Clean,
        (0 | 1, false) => ContentVerdict::Changes,
        _ => ContentVerdict::Unknown,
    };
    Ok(verdict(outcome, Some(tip)))
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

    async fn commit_file(repo: &str, dir: &std::path::Path, file: &str, content: &str, msg: &str) {
        std::fs::write(dir.join(file), content).unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-m", msg]).await;
    }

    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-content-merged-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-b", "main"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit_file(&repo, dir.path(), "a.txt", "v0\n", "base").await;
        (dir, repo)
    }

    async fn rev(repo: &str, r: &str) -> String {
        git(repo, &["rev-parse", r]).await.trim().to_string()
    }

    /// A new commit on `parent`'s tree, made without touching refs or the worktree.
    async fn child_of(repo: &str, parent: &str, msg: &str) -> String {
        let tree = format!("{parent}^{{tree}}");
        git(repo, &["commit-tree", &tree, "-p", parent, "-m", msg])
            .await
            .trim()
            .to_string()
    }

    async fn set_ref(repo: &str, full_ref: &str, sha: &str) {
        git(repo, &["update-ref", full_ref, sha]).await;
    }

    /// The verdict for `branch` against local `main`, as the dialog would ask for it.
    async fn check(repo: &str, branch: &str) -> BranchContentMerged {
        let sha = rev(repo, "refs/heads/main").await;
        let tree = rev(repo, "refs/heads/main^{tree}").await;
        git_branch_content_merged(repo.to_string(), sha, tree, branch.to_string())
            .await
            .unwrap()
    }

    /// The raw merge-tree exit code, pinning each matrix row's premise.
    async fn merge_tree_code(repo: &str, branch: &str) -> i32 {
        let tip = branch_tip_sha(repo, branch).await.unwrap().unwrap();
        run_git_raw(
            Some(repo),
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "refs/heads/main",
                &tip,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .code
    }

    #[tokio::test]
    async fn squash_merged_branch_reads_clean() {
        let (dir, repo) = setup_repo("squash").await;
        git(&repo, &["checkout", "-b", "cm-squash"]).await;
        commit_file(&repo, dir.path(), "s.txt", "one\n", "s1").await;
        commit_file(&repo, dir.path(), "s.txt", "one\ntwo\n", "s2").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-squash"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;

        let got = check(&repo, "cm-squash").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.head_sha, Some(rev(&repo, "refs/heads/cm-squash").await));
        assert_eq!(got.branch, "cm-squash");
    }

    #[tokio::test]
    async fn rebase_merged_branch_reads_clean() {
        let (dir, repo) = setup_repo("rebase").await;
        git(&repo, &["checkout", "-b", "cm-rebase"]).await;
        commit_file(&repo, dir.path(), "r.txt", "r\n", "r1").await;
        let picked = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "m.txt", "m\n", "main moves").await;
        git(&repo, &["cherry-pick", &picked]).await;

        assert_eq!(
            check(&repo, "cm-rebase").await.verdict,
            ContentVerdict::Clean
        );
    }

    #[tokio::test]
    async fn tip_already_in_base_reads_clean() {
        let (dir, repo) = setup_repo("ancestor").await;
        git(&repo, &["branch", "cm-ancestor"]).await;
        commit_file(&repo, dir.path(), "m.txt", "m\n", "main moves").await;

        assert_eq!(
            check(&repo, "cm-ancestor").await.verdict,
            ContentVerdict::Clean
        );
    }

    #[tokio::test]
    async fn later_commit_after_squash_reads_changes() {
        let (dir, repo) = setup_repo("later").await;
        git(&repo, &["checkout", "-b", "cm-later"]).await;
        commit_file(&repo, dir.path(), "s.txt", "one\n", "s1").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-later"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;
        git(&repo, &["checkout", "cm-later"]).await;
        commit_file(&repo, dir.path(), "t.txt", "unmerged\n", "after squash").await;
        git(&repo, &["checkout", "main"]).await;

        assert_eq!(merge_tree_code(&repo, "cm-later").await, 0);
        assert_eq!(
            check(&repo, "cm-later").await.verdict,
            ContentVerdict::Changes
        );
    }

    /// The known false negative: an adjacent edit on the base conflicts with the
    /// already-squashed change, which must read as changes, never as merged.
    #[tokio::test]
    async fn adjacent_base_edit_after_squash_conflicts_as_changes() {
        let (dir, repo) = setup_repo("adjacent").await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nl2\nl3\nl4\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-adjacent"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nl3\nl4\n", "edit l2").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-adjacent"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nL3\nl4\n", "edit l3").await;

        assert_eq!(merge_tree_code(&repo, "cm-adjacent").await, 1);
        assert_eq!(
            check(&repo, "cm-adjacent").await.verdict,
            ContentVerdict::Changes
        );
    }

    #[tokio::test]
    async fn unresolvable_branch_reads_unknown_without_head() {
        let (_dir, repo) = setup_repo("missing").await;
        let got = check(&repo, "cm-no-such-branch").await;
        assert_eq!(got.verdict, ContentVerdict::Unknown);
        assert_eq!(got.head_sha, None);
    }

    #[tokio::test]
    async fn same_named_tag_never_shadows_the_branch_tip() {
        let (dir, repo) = setup_repo("shadow").await;
        git(&repo, &["checkout", "-b", "cm-shadow"]).await;
        commit_file(&repo, dir.path(), "x.txt", "unmerged\n", "branch work").await;
        git(&repo, &["checkout", "main"]).await;
        // The tag sits on main, where it alone would read clean.
        git(&repo, &["tag", "cm-shadow", "main"]).await;

        let got = check(&repo, "cm-shadow").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.head_sha, Some(rev(&repo, "refs/heads/cm-shadow").await));
    }

    #[tokio::test]
    async fn hostile_input_is_refused_before_any_spawn() {
        // A path that is no repository: any spawn would answer `unknown`/a git
        // error, so an InvalidArgument proves the refusal came first.
        let nowhere = std::env::temp_dir()
            .join("gd-content-merged-no-such-repo")
            .to_string_lossy()
            .into_owned();
        let oid = "a".repeat(40);
        let names = [
            "",
            "-x",
            "--upload-pack=x",
            "a*b",
            "a?b",
            "a[b",
            "a:b",
            "main~1",
            "a^",
            "a..b",
            "x@{1}",
            "@",
        ];
        for name in names {
            let merged =
                git_branch_content_merged(nowhere.clone(), oid.clone(), oid.clone(), name.into())
                    .await;
            assert!(
                matches!(merged, Err(AppError::InvalidArgument(_))),
                "branch {name:?}"
            );
            let base = git_content_check_base(nowhere.clone(), name.into()).await;
            assert!(
                matches!(base, Err(AppError::InvalidArgument(_))),
                "default {name:?}"
            );
        }
        let bad_oids = [
            String::new(),
            "a".repeat(39),
            "a".repeat(65),
            "A".repeat(40),
            "g".repeat(40),
            format!("-{}", "a".repeat(39)),
            "HEAD".to_string(),
        ];
        for bad in &bad_oids {
            let sha =
                git_branch_content_merged(nowhere.clone(), bad.clone(), oid.clone(), "b".into())
                    .await;
            assert!(
                matches!(sha, Err(AppError::InvalidArgument(_))),
                "sha {bad:?}"
            );
            let tree =
                git_branch_content_merged(nowhere.clone(), oid.clone(), bad.clone(), "b".into())
                    .await;
            assert!(
                matches!(tree, Err(AppError::InvalidArgument(_))),
                "tree {bad:?}"
            );
        }
        // Well-formed input against no repository is an answer, not an error.
        let fine = git_branch_content_merged(nowhere, oid.clone(), "b".repeat(64), "b".into())
            .await
            .unwrap();
        assert_eq!(fine.verdict, ContentVerdict::Unknown);
    }

    async fn expect_base(repo: &str, default: &str, ref_name: &str, sha: &str) {
        let base = git_content_check_base(repo.to_string(), default.to_string())
            .await
            .unwrap()
            .expect("a base resolves");
        assert_eq!(base.ref_name, ref_name);
        assert_eq!(base.sha, sha);
        assert_eq!(base.tree, rev(repo, &format!("{sha}^{{tree}}")).await);
    }

    #[tokio::test]
    async fn base_prefers_origin_when_local_is_behind_or_equal() {
        let (_dir, repo) = setup_repo("base-behind").await;
        let a = rev(&repo, "HEAD").await;
        set_ref(&repo, "refs/remotes/origin/main", &a).await;
        expect_base(&repo, "main", "origin/main", &a).await;

        let b = child_of(&repo, &a, "remote moves").await;
        set_ref(&repo, "refs/remotes/origin/main", &b).await;
        expect_base(&repo, "main", "origin/main", &b).await;
    }

    #[tokio::test]
    async fn base_keeps_local_when_ahead_or_diverged() {
        let (_dir, repo) = setup_repo("base-ahead").await;
        let a = rev(&repo, "HEAD").await;
        let b = child_of(&repo, &a, "local moves").await;
        set_ref(&repo, "refs/heads/main", &b).await;
        set_ref(&repo, "refs/remotes/origin/main", &a).await;
        expect_base(&repo, "main", "main", &b).await;

        let c = child_of(&repo, &a, "remote diverges").await;
        set_ref(&repo, "refs/remotes/origin/main", &c).await;
        expect_base(&repo, "main", "main", &b).await;
    }

    #[tokio::test]
    async fn base_without_remote_tracking_ref_is_local() {
        let (_dir, repo) = setup_repo("base-local").await;
        let a = rev(&repo, "HEAD").await;
        expect_base(&repo, "main", "main", &a).await;

        // A local upstream (remote ".") is not a remote side.
        let other = child_of(&repo, &a, "other").await;
        set_ref(&repo, "refs/heads/cm-other", &other).await;
        git(&repo, &["config", "branch.main.remote", "."]).await;
        git(
            &repo,
            &["config", "branch.main.merge", "refs/heads/cm-other"],
        )
        .await;
        expect_base(&repo, "main", "main", &a).await;
    }

    #[tokio::test]
    async fn base_follows_a_non_origin_upstream_first() {
        let (_dir, repo) = setup_repo("base-upstream").await;
        let a = rev(&repo, "HEAD").await;
        let b = child_of(&repo, &a, "upstream moves").await;
        git(&repo, &["config", "remote.up.url", "../nowhere"]).await;
        git(
            &repo,
            &[
                "config",
                "remote.up.fetch",
                "+refs/heads/*:refs/remotes/up/*",
            ],
        )
        .await;
        git(&repo, &["config", "branch.main.remote", "up"]).await;
        git(&repo, &["config", "branch.main.merge", "refs/heads/main"]).await;
        set_ref(&repo, "refs/remotes/up/main", &b).await;
        set_ref(&repo, "refs/remotes/origin/main", &a).await;
        expect_base(&repo, "main", "up/main", &b).await;
    }

    #[tokio::test]
    async fn base_uses_remote_when_local_default_is_missing() {
        let (_dir, repo) = setup_repo("base-remote-only").await;
        let a = rev(&repo, "HEAD").await;
        set_ref(&repo, "refs/remotes/origin/cm-trunk", &a).await;
        expect_base(&repo, "cm-trunk", "origin/cm-trunk", &a).await;
    }

    #[tokio::test]
    async fn base_is_none_when_neither_side_resolves() {
        let (_dir, repo) = setup_repo("base-none").await;
        let got = git_content_check_base(repo, "cm-nonesuch".to_string())
            .await
            .unwrap();
        assert!(got.is_none(), "{got:?}");
    }

    #[test]
    fn write_tree_support_starts_at_git_2_38() {
        assert_eq!(
            parse_git_version("git version 2.51.1.windows.1\n"),
            Some((2, 51))
        );
        assert!(!supports_write_tree("git version 2.37.9"));
        assert!(supports_write_tree("git version 2.38.0"));
        assert!(supports_write_tree("git version 3.0.0"));
        assert!(!supports_write_tree("garbage"));
        assert!(!supports_write_tree(""));
    }

    #[test]
    fn wire_shapes_are_camel_case_with_lowercase_verdicts() {
        let base = serde_json::to_value(ContentCheckBase {
            ref_name: "origin/main".into(),
            sha: "s".into(),
            tree: "t".into(),
        })
        .unwrap();
        let keys: Vec<&str> = base
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys.len(), 3, "{base}");
        for key in ["refName", "sha", "tree"] {
            assert!(base.get(key).is_some(), "{key} in {base}");
        }
        assert!(base.get("ref_name").is_none());

        let row = serde_json::to_value(BranchContentMerged {
            branch: "b".into(),
            verdict: ContentVerdict::Changes,
            head_sha: None,
        })
        .unwrap();
        assert_eq!(
            row,
            serde_json::json!({ "branch": "b", "verdict": "changes", "headSha": null })
        );
        assert!(row.get("head_sha").is_none());
        for (verdict, wire) in [
            (ContentVerdict::Clean, "clean"),
            (ContentVerdict::Changes, "changes"),
            (ContentVerdict::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), wire);
        }
    }
}
