//! Content check for branch cleanup: whether merging a branch into the default
//! branch would add anything, measured with `git merge-tree --write-tree` so a
//! squash- or rebase-merged branch reads as merged even though its commits aren't.
//! `clean` needs merge-tree to exit 0 writing exactly the base tree, one merge base, no
//! merge driver or `merge.default` (read at the open, and per verdict after a content
//! merge) and no content-merged `merge=union` path. Another tree or a conflict reads
//! `changes`; a clean run missing one, or any failed git step, `unknown`; a driver,
//! `merge.default` or an unreadable config at the open yields no verdict. `unknown`
//! pre-checks a row only via its idle fallback, never on a pull-request match alone. Out
//! of reach: bare repositories, `attr.tree`/`--attr-source` setups, and attribute or
//! config edits that land while a check runs (each git step reads them live).

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::branches::{branch_tip_sha, validate_branch_name};
use crate::git::runner::{run_git, run_git_raw, run_git_raw_input_bytes, DEFAULT_TIMEOUT};

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

/// `merge-tree --write-tree`, `--name-only`, `--messages` and `-z` exist from git 2.38.
/// The guard parses the structured `-z` message records, and any output it can't parse
/// reads unknown. An unparseable version reads as unsupported.
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

/// A full object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. Never
/// starts with `-`, so it is safe in any argv position.
fn validate_oid(oid: &str, what: &str) -> AppResult<()> {
    let hex = oid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !hex || !matches!(oid.len(), 40 | 64) {
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

/// Config keys that can put a merge other than git's text merge in play: any
/// `merge.<name>.driver`, or `merge.default` with any value. Stricter on purpose
/// than [`merge_attr_has_union`], which demotes only the built-in `union`.
const MERGE_DRIVER_KEYS: &str = r"^merge\.(.+\.driver|default)$";

/// Whether any [`MERGE_DRIVER_KEYS`] key is configured, in any scope git reads here.
/// merge-tree runs such a driver and trusts its result, so one that keeps a side
/// writes the base tree with the branch's edit dropped. A failed read counts as one.
async fn merge_driver_configured(repo_path: &str) -> bool {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "--get-regexp", "--name-only", MERGE_DRIVER_KEYS],
        DEFAULT_TIMEOUT,
    )
    .await;
    // Exit 1 is git config's "no key matched"; 0 listed one.
    !matches!(out, Ok(ref out) if out.code == 1)
}

/// The base the cleanup dialog's verdicts compare against, resolved once per open.
/// Ok(None) on git older than 2.38 (or a version that can't be read), when neither side
/// resolves, or when a merge driver or `merge.default` is configured or the config can't
/// be read. That gate lives here because only a verdict's merge-tree can run a driver,
/// and the dialog never asks for verdicts without a base.
#[tauri::command]
pub async fn git_content_check_base(
    repo_path: String,
    default_branch: String,
) -> AppResult<Option<ContentCheckBase>> {
    validate_branch_name(&default_branch)?;
    if merge_driver_configured(&repo_path).await {
        return Ok(None);
    }
    if !merge_tree_write_supported().await {
        return Ok(None);
    }
    resolve_check_base(&repo_path, default_branch).await
}

/// The newer of the local default branch and its remote-tracking counterpart.
/// Remote wins when local is an ancestor of it (equal included); ahead, diverged,
/// or a failed ancestry probe keep local, by preference rather than proof.
/// Ok(None) when neither side resolves.
async fn resolve_check_base(
    repo_path: &str,
    default_branch: String,
) -> AppResult<Option<ContentCheckBase>> {
    let local = branch_tip_sha(repo_path, &default_branch).await?;
    let remote = remote_side(repo_path, &default_branch).await?;
    let (ref_name, sha) = match (local, remote) {
        (None, None) => return Ok(None),
        (Some(local), None) => (default_branch, local),
        (None, Some((full, sha))) => (display_remote(&full), sha),
        (Some(local), Some((full, remote_sha))) => {
            let ancestor = run_git_raw(
                Some(repo_path),
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
        Some(repo_path),
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

/// The paths merge-tree content-merged, from its `--name-only --messages -z` output:
/// the tree, NUL-terminated conflicted names, an empty token, then records of
/// `<N> NUL <path>xN NUL <type> NUL <message> NUL`. None on a shape this can't read.
fn auto_merged_paths(stdout: &[u8]) -> Option<Vec<&[u8]>> {
    let mut tokens: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    // `-z` terminates every token, so the split's last element must be empty.
    if tokens.pop() != Some(&[][..]) {
        return None;
    }
    let names_end = 1 + tokens.get(1..)?.iter().position(|t| t.is_empty())?;
    let mut records = &tokens[names_end + 1..];
    let mut paths = Vec::new();
    while let Some((count, rest)) = records.split_first() {
        let n: usize = std::str::from_utf8(count).ok()?.parse().ok()?;
        if n == 0 || rest.len() < n + 2 {
            return None;
        }
        if rest[n] == b"Auto-merging" {
            paths.extend_from_slice(&rest[..n]);
        }
        records = &rest[n + 2..];
    }
    Some(paths)
}

/// Reads `check-attr -z` triples (`path NUL attr NUL value NUL`) for `merge`: true
/// when any value is `union`. `binary` and an unset attribute select git's binary merge,
/// which reports a conflict (one side kept as the tentative result), so merge-tree exits 1
/// and the verdict is changes; any other name is git's text merge unless a driver is
/// configured ([`MERGE_DRIVER_KEYS`]). None on an unreadable stream.
fn merge_attr_has_union(stdout: &str) -> Option<bool> {
    let mut tokens: Vec<&str> = stdout.split('\0').collect();
    // `-z` terminates every token, so the split's last element is empty.
    if tokens.last() == Some(&"") {
        tokens.pop();
    }
    if !tokens.len().is_multiple_of(3) {
        return None;
    }
    let mut union = false;
    for triple in tokens.as_chunks::<3>().0 {
        if triple[1] != "merge" {
            return None;
        }
        union |= triple[2] == "union";
    }
    Some(union)
}

/// Whether `base_sha` and `tip` share exactly one merge base. With several,
/// merge-tree content-merges inside a virtual base and suppresses those messages, so
/// `union` or a driver could shape the result unrecorded. A failed read counts as no.
async fn single_merge_base(repo_path: &str, base_sha: &str, tip: &str) -> bool {
    let out = run_git_raw(
        Some(repo_path),
        &["merge-base", "--all", base_sha, tip],
        DEFAULT_TIMEOUT,
    )
    .await;
    matches!(out, Ok(ref out) if out.code == 0
        && out.stdout_lossy().split_whitespace().count() == 1)
}

/// A clean merge-tree run stands only if git's text merge did each content merge:
/// with any, a driver key configured since the base read or a `union` path demotes
/// it, as does any unreadable step. Paths reach check-attr through stdin, never argv.
async fn clean_unless_driver_merged(repo_path: &str, merge_tree_stdout: &[u8]) -> ContentVerdict {
    let Some(paths) = auto_merged_paths(merge_tree_stdout) else {
        return ContentVerdict::Unknown;
    };
    if paths.is_empty() {
        return ContentVerdict::Clean;
    }
    if merge_driver_configured(repo_path).await {
        return ContentVerdict::Unknown;
    }
    let stdin: Vec<u8> = paths
        .iter()
        .flat_map(|path| path.iter().copied().chain([0]))
        .collect();
    match run_git_raw_input_bytes(
        Some(repo_path),
        &["check-attr", "-z", "--stdin", "merge"],
        Some(&stdin),
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 && merge_attr_has_union(&out.stdout_lossy()) == Some(false) => {
            ContentVerdict::Clean
        }
        _ => ContentVerdict::Unknown,
    }
}

/// Whether `branch` carries anything `base_sha` lacks: `clean` when merging its tip
/// into the base cleanly writes exactly `base_tree`, `changes` on a different tree
/// or a conflict (never read as merged), `unknown` on any other outcome. Every git
/// failure after validation is `unknown` rather than Err, because consumers gate on
/// the verdict; Err is reserved for invalid input, refused before any spawn.
/// `clean` additionally needs the module's trust contract: one merge base
/// ([`single_merge_base`]) and [`clean_unless_driver_merged`]; otherwise `unknown`.
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
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--messages",
            "-z",
            &base_sha,
            &tip,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return Ok(verdict(ContentVerdict::Unknown, Some(tip)));
    };
    let stdout = mt.stdout_lossy();
    let written = stdout.split('\0').next().map(str::trim).unwrap_or_default();
    let outcome = match (mt.code, written.is_empty()) {
        (_, true) => ContentVerdict::Unknown,
        (0, false) if written == base_tree => ContentVerdict::Clean,
        (0 | 1, false) => ContentVerdict::Changes,
        _ => ContentVerdict::Unknown,
    };
    // Only a clean verdict pays for the guards: the others are already safe. The
    // merge-base read goes first because a criss-cross run's records are incomplete.
    let outcome = match outcome {
        ContentVerdict::Clean if !single_merge_base(&repo_path, &base_sha, &tip).await => {
            ContentVerdict::Unknown
        }
        ContentVerdict::Clean => clean_unless_driver_merged(&repo_path, &mt.stdout).await,
        other => other,
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
        // A missing file in place of the user-level attributes file: a developer's
        // global `merge=union` must not reach these verdicts.
        let no_attrs = dir.path().join(".git").join("no-attributes");
        let no_attrs = no_attrs.to_string_lossy().replace('\\', "/");
        git(&repo, &["config", "core.attributesFile", &no_attrs]).await;
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

    /// The raw merge-tree run of `branch` into local `main`, pinning each matrix
    /// row's premise.
    async fn merge_tree_run(repo: &str, branch: &str) -> crate::git::runner::GitOutput {
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
    }

    async fn merge_tree_code(repo: &str, branch: &str) -> i32 {
        merge_tree_run(repo, branch).await.code
    }

    /// The paths merge-tree content-merges for `branch` into local `main`, as the
    /// verdict's guard reads them.
    async fn auto_merged(repo: &str, branch: &str) -> Vec<String> {
        let tip = branch_tip_sha(repo, branch).await.unwrap().unwrap();
        let out = run_git_raw(
            Some(repo),
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--messages",
                "-z",
                "refs/heads/main",
                &tip,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        auto_merged_paths(&out.stdout)
            .expect("a readable messages section")
            .iter()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect()
    }

    /// Merge driver keys every test repo inherits from outside it (the runner skips
    /// only the system config), read once from a fresh repo before it sets its own.
    async fn inherited_merge_keys(repo: &str) -> Option<String> {
        static INHERITED: tokio::sync::OnceCell<Option<String>> =
            tokio::sync::OnceCell::const_new();
        INHERITED
            .get_or_init(|| async {
                let out = run_git_raw(
                    Some(repo),
                    &["config", "--get-regexp", "--name-only", MERGE_DRIVER_KEYS],
                    DEFAULT_TIMEOUT,
                )
                .await
                .unwrap();
                (out.code != 1).then(|| out.stdout_lossy().trim().to_string())
            })
            .await
            .clone()
    }

    /// Whether to skip a test that runs a content merge: an inherited driver key or
    /// `merge.default` would change its merge or its verdict.
    async fn skip_for_inherited_merge_keys(repo: &str) -> bool {
        let Some(keys) = inherited_merge_keys(repo).await else {
            return false;
        };
        eprintln!("skipping: merge keys are configured outside this repo ({keys})");
        true
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

    /// Two merges of the same pair of commits, made in opposite parent order: their
    /// histories share two merge bases, and merge-tree's clean result can't be read
    /// through its records, so it reads unknown.
    #[tokio::test]
    async fn criss_cross_clean_merge_reads_unknown() {
        let (dir, repo) = setup_repo("criss-cross").await;
        let base = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "-b", "cm-x"]).await;
        commit_file(&repo, dir.path(), "p.txt", "p\n", "x").await;
        git(&repo, &["checkout", "-b", "cm-y", &base]).await;
        commit_file(&repo, dir.path(), "q.txt", "q\n", "y").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--no-edit", "cm-x", "cm-y"]).await;
        let (x, y) = (rev(&repo, "cm-x").await, rev(&repo, "cm-y").await);
        let tree = format!("{}^{{tree}}", rev(&repo, "HEAD").await);
        let merge = |first: String, second: String| {
            let (repo, tree) = (repo.clone(), tree.clone());
            async move {
                let args = [
                    "commit-tree",
                    &tree,
                    "-p",
                    &first,
                    "-p",
                    &second,
                    "-m",
                    "merge",
                ];
                git(&repo, &args).await.trim().to_string()
            }
        };
        let main_tip = merge(x.clone(), y.clone()).await;
        let branch_tip = merge(y, x).await;
        set_ref(&repo, "refs/heads/main", &main_tip).await;
        set_ref(&repo, "refs/heads/cm-criss", &branch_tip).await;

        let bases = git(&repo, &["merge-base", "--all", &main_tip, &branch_tip]).await;
        assert_eq!(bases.split_whitespace().count(), 2, "{bases}");
        let mt = merge_tree_run(&repo, "cm-criss").await;
        assert_eq!(mt.code, 0, "{}", mt.stdout_lossy());
        let written = mt
            .stdout_lossy()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        assert_eq!(written, rev(&repo, "refs/heads/main^{tree}").await);

        assert_eq!(
            check(&repo, "cm-criss").await.verdict,
            ContentVerdict::Unknown
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
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
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
    async fn hostile_input_is_an_invalid_argument() {
        // Each hostile input answers InvalidArgument; validation precedes every
        // spawn by code order. Against no repository, well-formed input reads unknown.
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
            "a".repeat(41),
            "a".repeat(63),
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

    /// Calls the resolver below the merge-driver gate, so a developer's global
    /// driver can't fail or vacuously pass the base-resolution tests.
    async fn expect_base(repo: &str, default: &str, ref_name: &str, sha: &str) {
        let base = resolve_check_base(repo, default.to_string())
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
        let got = resolve_check_base(&repo, "cm-nonesuch".to_string())
            .await
            .unwrap();
        assert!(got.is_none(), "{got:?}");
    }

    /// A driver that keeps the base's side of every file, as `merge=ours` with
    /// `driver = true` does.
    async fn configure_ours_driver(repo: &str) {
        git(repo, &["config", "merge.ours.driver", "true"]).await;
    }

    /// The command's driverless arm resolves `main` at `sha`, unless a driver key is
    /// inherited from outside the repo: the test runner skips only the system
    /// config, so a developer's global key already turns the check off.
    async fn expect_command_base_unless_inherited(repo: &str, sha: &str) {
        if let Some(keys) = inherited_merge_keys(repo).await {
            eprintln!(
                "skipping the driverless arm: a merge driver is configured outside this repo ({keys})"
            );
            return;
        }
        let got = git_content_check_base(repo.to_string(), "main".to_string())
            .await
            .unwrap()
            .expect("a base resolves");
        assert_eq!((got.ref_name.as_str(), got.sha.as_str()), ("main", sha));
    }

    /// The gate alone answers None: the resolver below it still finds a base.
    async fn expect_gated(repo: &str, sha: &str) {
        let got = git_content_check_base(repo.to_string(), "main".to_string())
            .await
            .unwrap();
        assert!(got.is_none(), "{got:?}");
        expect_base(repo, "main", "main", sha).await;
    }

    #[tokio::test]
    async fn base_is_none_when_a_merge_driver_is_configured() {
        let (_dir, repo) = setup_repo("base-driver").await;
        let a = rev(&repo, "HEAD").await;
        expect_command_base_unless_inherited(&repo, &a).await;

        configure_ours_driver(&repo).await;
        expect_gated(&repo, &a).await;
    }

    #[tokio::test]
    async fn base_is_none_when_merge_default_is_configured() {
        let (_dir, repo) = setup_repo("base-merge-default").await;
        let a = rev(&repo, "HEAD").await;
        expect_command_base_unless_inherited(&repo, &a).await;

        git(&repo, &["config", "merge.default", "union"]).await;
        expect_gated(&repo, &a).await;
    }

    /// Why the gate exists: with a driver that keeps one side, merge-tree reports a
    /// clean merge whose tree is the base's, though the branch edited the file.
    #[tokio::test]
    async fn a_keep_ours_driver_makes_merge_tree_write_the_base_tree() {
        let (dir, repo) = setup_repo("driver-premise").await;
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "* merge=ours\n",
            "attrs",
        )
        .await;
        configure_ours_driver(&repo).await;
        git(&repo, &["checkout", "-b", "cm-driver"]).await;
        commit_file(&repo, dir.path(), "a.txt", "branch\n", "branch edit").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "a.txt", "main\n", "main edit").await;

        let mt = merge_tree_run(&repo, "cm-driver").await;
        assert_eq!(mt.code, 0, "{}", mt.stdout_lossy());
        let written = mt
            .stdout_lossy()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        assert_eq!(written, rev(&repo, "refs/heads/main^{tree}").await);
        assert_ne!(
            rev(&repo, "refs/heads/cm-driver:a.txt").await,
            rev(&repo, "refs/heads/main:a.txt").await
        );
    }

    /// `path`'s `merge` attribute as `check-attr` answers it.
    async fn merge_attr(repo: &str, path: &str) -> String {
        let out = git(repo, &["check-attr", "-z", "merge", "--", path]).await;
        out.split('\0').nth(2).unwrap_or_default().to_string()
    }

    /// The built-in `union` needs no driver key: a branch deleting a line main
    /// reworded merges cleanly to main's tree, so clean can't be trusted there.
    #[tokio::test]
    async fn union_attribute_on_a_changed_path_reads_unknown() {
        let (dir, repo) = setup_repo("union-drop").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "* merge=union\n",
            "attrs",
        )
        .await;
        commit_file(&repo, dir.path(), "f.txt", "a\nX\nb\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-union-drop"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nb\n", "delete X").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nY\nb\n", "reword X").await;

        assert_eq!(merge_attr(&repo, "f.txt").await, "union");
        let mt = merge_tree_run(&repo, "cm-union-drop").await;
        assert_eq!(mt.code, 0, "{}", mt.stdout_lossy());
        let written = mt
            .stdout_lossy()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        assert_eq!(written, rev(&repo, "refs/heads/main^{tree}").await);
        assert_eq!(auto_merged(&repo, "cm-union-drop").await, ["f.txt"]);

        let got = check(&repo, "cm-union-drop").await;
        assert_eq!(got.verdict, ContentVerdict::Unknown);
        assert_eq!(
            got.head_sha,
            Some(rev(&repo, "refs/heads/cm-union-drop").await)
        );
    }

    #[tokio::test]
    async fn union_attribute_on_an_unchanged_path_keeps_clean() {
        let (dir, repo) = setup_repo("union-elsewhere").await;
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "u.txt merge=union\n",
            "attrs",
        )
        .await;
        commit_file(&repo, dir.path(), "u.txt", "u\n", "union file").await;
        git(&repo, &["checkout", "-b", "cm-union-elsewhere"]).await;
        commit_file(&repo, dir.path(), "s.txt", "one\n", "s1").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-union-elsewhere"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;

        assert_eq!(merge_attr(&repo, "u.txt").await, "union");
        assert_eq!(merge_attr(&repo, "s.txt").await, "unspecified");
        assert!(auto_merged(&repo, "cm-union-elsewhere").await.is_empty());
        assert_eq!(
            check(&repo, "cm-union-elsewhere").await.verdict,
            ContentVerdict::Clean
        );
    }

    /// A rename on main carries the branch's edit to a path the branch never named,
    /// so the guard keys on merge-tree's own records, never the branch's diff.
    #[tokio::test]
    async fn union_attribute_on_a_rename_destination_reads_unknown() {
        let (dir, repo) = setup_repo("union-rename").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        // The premise needs rename detection, whatever the developer's own config says.
        git(&repo, &["config", "merge.renames", "true"]).await;
        git(&repo, &["config", "diff.renames", "true"]).await;
        let lines = |mid: &str| {
            let mut v: Vec<String> = (1..=5).map(|i| format!("l{i}")).collect();
            v.extend(mid.split_terminator('\n').map(str::to_string));
            v.extend((6..=10).map(|i| format!("l{i}")));
            v.join("\n") + "\n"
        };
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "new.txt merge=union\n",
            "attrs",
        )
        .await;
        commit_file(&repo, dir.path(), "old.txt", &lines("X\n"), "lines").await;
        git(&repo, &["checkout", "-b", "cm-union-rename"]).await;
        commit_file(&repo, dir.path(), "old.txt", &lines(""), "delete X").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["mv", "old.txt", "new.txt"]).await;
        commit_file(
            &repo,
            dir.path(),
            "new.txt",
            &lines("Y\n"),
            "rename + reword",
        )
        .await;

        assert_eq!(merge_attr(&repo, "old.txt").await, "unspecified");
        assert_eq!(merge_attr(&repo, "new.txt").await, "union");
        let mt = merge_tree_run(&repo, "cm-union-rename").await;
        assert_eq!(mt.code, 0, "{}", mt.stdout_lossy());
        let written = mt
            .stdout_lossy()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        assert_eq!(written, rev(&repo, "refs/heads/main^{tree}").await);
        assert_eq!(auto_merged(&repo, "cm-union-rename").await, ["new.txt"]);

        assert_eq!(
            check(&repo, "cm-union-rename").await.verdict,
            ContentVerdict::Unknown
        );
    }

    /// A squash-merged edit, then a non-adjacent edit on main: merge-tree
    /// content-merges `f.txt` back to main's tree.
    async fn auto_merged_clean_repo(marker: &str, attrs: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = setup_repo(marker).await;
        commit_file(&repo, dir.path(), ".gitattributes", attrs, "attrs").await;
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            "l1\nl2\nl3\nl4\nl5\nl6\n",
            "lines",
        )
        .await;
        git(&repo, &["checkout", "-b", "cm-auto"]).await;
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            "l1\nL2\nl3\nl4\nl5\nl6\n",
            "edit l2",
        )
        .await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-auto"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            "l1\nL2\nl3\nl4\nl5\nL6\n",
            "edit l6",
        )
        .await;
        assert_eq!(auto_merged(&repo, "cm-auto").await, ["f.txt"]);
        (dir, repo)
    }

    /// git-lfs writes `merge=lfs` with no driver: git's text merge runs, so clean stands.
    #[tokio::test]
    async fn driverless_custom_merge_attribute_keeps_clean() {
        let (_dir, repo) = auto_merged_clean_repo("lfs", "* merge=lfs\n").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        assert_eq!(merge_attr(&repo, "f.txt").await, "lfs");
        assert_eq!(check(&repo, "cm-auto").await.verdict, ContentVerdict::Clean);
    }

    /// The base read's gate ran before this key existed; the verdict re-reads it.
    #[tokio::test]
    async fn driver_configured_after_the_base_read_demotes_clean() {
        let (_dir, repo) = auto_merged_clean_repo("late-driver", "* merge=lfs\n").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        git(&repo, &["config", "merge.lfs.driver", "true"]).await;
        assert_eq!(
            check(&repo, "cm-auto").await.verdict,
            ContentVerdict::Unknown
        );
    }

    /// No content merge ran (main and the branch hold the same `s.txt`), so the
    /// `union` on it never acted and clean stands without an attribute read.
    #[tokio::test]
    async fn clean_without_a_content_merge_ignores_union() {
        let (dir, repo) = setup_repo("no-records").await;
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "s.txt merge=union\n",
            "attrs",
        )
        .await;
        git(&repo, &["checkout", "-b", "cm-no-records"]).await;
        commit_file(&repo, dir.path(), "s.txt", "one\n", "s1").await;
        commit_file(&repo, dir.path(), "s.txt", "one\ntwo\n", "s2").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-no-records"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;

        assert_eq!(merge_attr(&repo, "s.txt").await, "union");
        assert!(auto_merged(&repo, "cm-no-records").await.is_empty());
        assert_eq!(
            check(&repo, "cm-no-records").await.verdict,
            ContentVerdict::Clean
        );
    }

    #[tokio::test]
    async fn union_attribute_still_reads_an_added_line_as_changes() {
        let (dir, repo) = setup_repo("union-add").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "* merge=union\n",
            "attrs",
        )
        .await;
        commit_file(&repo, dir.path(), "f.txt", "a\nX\nb\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-union-add"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nX\nZ\nb\n", "add Z").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nY\nb\n", "reword X").await;

        assert_eq!(merge_tree_code(&repo, "cm-union-add").await, 0);
        assert_eq!(
            check(&repo, "cm-union-add").await.verdict,
            ContentVerdict::Changes
        );
    }

    #[test]
    fn merge_attr_reads_only_union() {
        let read = |values: &[&str]| {
            let stream: String = values.iter().map(|v| format!("p\0merge\0{v}\0")).collect();
            merge_attr_has_union(&stream)
        };
        assert_eq!(read(&[]), Some(false));
        assert_eq!(
            read(&["set", "unset", "unspecified", "text", "binary", "lfs"]),
            Some(false)
        );
        assert_eq!(read(&["unspecified", "union"]), Some(true));
        assert_eq!(merge_attr_has_union("p\0merge\0"), None);
        assert_eq!(merge_attr_has_union("p\0diff\0union\0"), None);
    }

    #[test]
    fn auto_merged_paths_reads_merge_tree_messages() {
        let tree = "d".repeat(40);
        let read = |tail: &str| {
            auto_merged_paths(format!("{tree}\0{tail}").as_bytes())
                .map(|paths| paths.iter().map(|p| p.to_vec()).collect::<Vec<_>>())
        };
        // The three outputs measured on git 2.51.1.
        assert_eq!(
            read("\x001\0new.txt\0Auto-merging\0Auto-merging new.txt\n\0"),
            Some(vec![b"new.txt".to_vec()])
        );
        assert_eq!(
            read("\x001\0f.txt\0Auto-merging\0Auto-merging f.txt\n\0"),
            Some(vec![b"f.txt".to_vec()])
        );
        assert_eq!(read("\0"), Some(vec![]));
        // Conflicted names come before the separator; other record types and
        // multi-path records are walked past.
        assert_eq!(
            read("c.txt\0\x002\0a\0b\0CONFLICT (rename/delete)\0m\x001\0g\0Auto-merging\0m\0"),
            Some(vec![b"g".to_vec()])
        );
        for malformed in [
            "",
            "c.txt\0",
            "\0x\0f\0Auto-merging\0m\0",
            "\x000\0Auto-merging\0m\0",
            "\x002\0f\0Auto-merging\0m\0",
            "\x001\0f\0Auto-merging\0m",
        ] {
            assert_eq!(read(malformed), None, "{malformed:?}");
        }
        assert_eq!(auto_merged_paths(b""), None);
    }

    /// Exactly the driver and default keys turn the check off, whatever the
    /// developer's own config holds: `--file` reads only the given file.
    #[tokio::test]
    async fn merge_driver_keys_match_only_driver_and_default() {
        let dir = tempfile::Builder::new()
            .prefix("gd-content-merged-keys-")
            .tempdir()
            .expect("create temp dir");
        let file = dir.path().join("config");
        std::fs::write(
            &file,
            "[merge]\n\tdefault = union\n[merge \"x\"]\n\tdriver = true\n\tname = x\n[mergetool \"x\"]\n\tcmd = x\n",
        )
        .unwrap();
        let file = file.to_string_lossy().into_owned();
        let out = run_git_raw(
            None,
            &[
                "config",
                "--file",
                &file,
                "--get-regexp",
                "--name-only",
                MERGE_DRIVER_KEYS,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(
            out.stdout_lossy().lines().collect::<Vec<_>>(),
            ["merge.default", "merge.x.driver"]
        );
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
