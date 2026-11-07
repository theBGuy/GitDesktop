//! Content check for branch cleanup: whether merging a branch into the default
//! branch would add anything, measured with `git merge-tree --write-tree` so a
//! squash- or rebase-merged branch reads as merged even though its commits aren't.
//!
//! A guarded run merges a tip into a commit and is clean when merge-tree exits 0
//! writing exactly that commit's tree, with one merge base, no merge driver,
//! `merge.default` or `merge.renormalize` (read at the open, and per verdict after a
//! content merge) and no content-merged `merge=union` path. Another tree or a conflict
//! reads `changes`; a clean run missing a guard, or any failed git step, `unknown`; a
//! gated key or an unreadable config at the open yields no base and no verdict, only a
//! [`ContentCheckOff`] reason the dialog names.
//!
//! Three routes, each fully guarded: (1) the tip into the base tip; (2) the landed
//! search, the tip into first-parent base commits after the single merge base: first
//! those whose own change touches every path the branch changed, then each commit where
//! a run of consecutive commits touching the branch's paths first covers them all, then
//! the rest of each such run, each group oldest first; (3) a merged pull request's head
//! when the tip is a strict ancestor of it, through (1) then (2). The verdict is
//! `clean` when any run cleared, else route 1's own verdict: routes 2 and 3 only
//! upgrade, since `unknown` pre-checks an idle row through its fallback. The search
//! caps ([`WINDOW_CAP`], [`CANDIDATE_CAP`]) bound cost, not soundness; a window past
//! the cap keeps route 1's verdict rather than search a partial one.
//!
//! Out of reach: bare repositories, `attr.tree`/`--attr-source` setups, and attribute
//! or config edits that land while a check runs (each git step reads them live; the
//! per-verdict key read is skipped when a clean run content-merged nothing). Accepted
//! gaps: a base commit that later reverts landed work still clears the branch through
//! its landing commit; a later pull-request commit that reverted something the older
//! tip added still clears the tip through the head; a pair with several merge bases
//! gets no history search; a landing that a commit touching none of the branch's paths
//! splits is no candidate (a later commit that holds the work can still clear the
//! branch, and is then the one named); a landing ranked behind [`CANDIDATE_CAP`] other
//! candidates is never tried.

use std::collections::HashSet;

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

/// Why an open has no base, so the dialog can say why it shows no verdicts.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ContentCheckOff {
    MergeDriver,
    MergeDefault,
    MergeRenormalize,
    ConfigUnreadable,
    GitTooOld,
    GitVersionUnreadable,
    NoBase,
}

/// One open's answer: exactly one of `base` and `off_reason` is Some.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentCheckBaseRead {
    pub base: Option<ContentCheckBase>,
    pub off_reason: Option<ContentCheckOff>,
}

impl ContentCheckBaseRead {
    fn off(reason: ContentCheckOff) -> Self {
        Self {
            base: None,
            off_reason: Some(reason),
        }
    }
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
    /// The base history commit a landed-search run cleared at (for the tip or the
    /// pull-request head); None for a clean at the base tip, and whenever the verdict
    /// isn't clean. The first candidate, in search order, whose tree holds the branch's
    /// changes: usually the commit they landed in, but a later commit that also holds
    /// them when the landing wasn't a candidate or ranked behind it.
    pub landed_in: Option<String>,
    /// The clean verdict came through the merged pull request's head.
    pub via_pr_head: bool,
}

/// The most first-parent base commits a landed search reads; a larger window keeps
/// route 1's verdict. Measured windows ran to 688 commits (a mirror of the owner's
/// repo, measured for PR #663).
const WINDOW_CAP: usize = 2000;

/// The most candidate runs per searched tip (the branch tip or the PR head). The first
/// candidate is the landing in practice: every branch the history search cleared from
/// the branch tip, 481, did so at the first candidate, and one more cleared through its
/// pull request's head (a mirror of the owner's repo, measured for PR #663).
const CANDIDATE_CAP: usize = 3;

fn parse_git_version(stdout: &str) -> Option<(u32, u32)> {
    let mut parts = stdout.trim().strip_prefix("git version ")?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

/// What a `git version` probe says about the content check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitVersionSupport {
    Supported,
    TooOld,
    Unreadable,
}

/// `merge-tree --write-tree`, `--name-only`, `--messages` and `-z` exist from git 2.38.
/// The guard parses the structured `-z` message records, and any output it can't parse
/// reads unknown. A failed probe or an unparseable version is Unreadable, never TooOld.
fn classify_git_version(exited_ok: bool, version_stdout: &str) -> GitVersionSupport {
    match parse_git_version(version_stdout) {
        Some(v) if exited_ok && v >= (2, 38) => GitVersionSupport::Supported,
        Some(_) if exited_ok => GitVersionSupport::TooOld,
        _ => GitVersionSupport::Unreadable,
    }
}

/// `probe`'s answer through `cell`, which caches only a parsed answer: an unreadable
/// probe is retried at the next call.
async fn cached_support<F, Fut>(cell: &tokio::sync::OnceCell<bool>, probe: F) -> GitVersionSupport
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = GitVersionSupport>,
{
    let parsed = cell
        .get_or_try_init(|| async move {
            match probe().await {
                GitVersionSupport::Supported => Ok(true),
                GitVersionSupport::TooOld => Ok(false),
                GitVersionSupport::Unreadable => Err(()),
            }
        })
        .await;
    match parsed {
        Ok(true) => GitVersionSupport::Supported,
        Ok(false) => GitVersionSupport::TooOld,
        Err(()) => GitVersionSupport::Unreadable,
    }
}

/// What the process's git supports, cached once a probe parses; an unreadable probe is
/// retried at the next open.
async fn merge_tree_write_support() -> GitVersionSupport {
    static SUPPORTED: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    cached_support(&SUPPORTED, || async {
        match run_git_raw(None, &["version"], DEFAULT_TIMEOUT).await {
            Ok(out) => classify_git_version(out.code == 0, &out.stdout_lossy()),
            Err(_) => GitVersionSupport::Unreadable,
        }
    })
    .await
}

/// Why the content check is off for a version probe's answer; None when it can run.
fn version_off_reason(support: GitVersionSupport) -> Option<ContentCheckOff> {
    match support {
        GitVersionSupport::Supported => None,
        GitVersionSupport::TooOld => Some(ContentCheckOff::GitTooOld),
        GitVersionSupport::Unreadable => Some(ContentCheckOff::GitVersionUnreadable),
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A full object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. Never
/// starts with `-`, so it is safe in any argv position.
fn is_full_oid(oid: &str) -> bool {
    is_lower_hex(oid) && matches!(oid.len(), 40 | 64)
}

fn validate_oid(oid: &str, what: &str) -> AppResult<()> {
    if !is_full_oid(oid) {
        return Err(AppError::InvalidArgument(format!("invalid {what}: {oid}")));
    }
    Ok(())
}

/// A pull-request head hint in the form forge lists carry: lowercase hex of 7 to 64
/// characters (Bitbucket lists short hashes).
fn is_head_hint(hint: &str) -> bool {
    (7..=64).contains(&hint.len()) && is_lower_hex(hint)
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
/// `merge.<name>.driver`, `merge.default`, or `merge.renormalize`, each with any value
/// (parsing git's boolean spellings risks a missed one). Renormalize re-runs all three
/// stages through a virtual check-out and check-in, so a filter that drops a branch's
/// line writes the base tree. Stricter on purpose than [`merge_attr_has_union`], which
/// demotes only the built-in `union`.
const MERGE_DRIVER_KEYS: &str = r"^merge\.(.+\.driver|default|renormalize)$";

/// The key class a `--get-regexp --name-only` [`MERGE_DRIVER_KEYS`] listing names, by
/// priority: any driver, then `merge.default`, then `merge.renormalize`. A listing with
/// none of them can't be read as a match, so it reads [`ContentCheckOff::ConfigUnreadable`].
fn merge_keys_off_reason(names: &str) -> ContentCheckOff {
    let names: Vec<&str> = names.lines().map(str::trim).collect();
    if names
        .iter()
        .any(|n| n.starts_with("merge.") && n.ends_with(".driver"))
    {
        ContentCheckOff::MergeDriver
    } else if names.contains(&"merge.default") {
        ContentCheckOff::MergeDefault
    } else if names.contains(&"merge.renormalize") {
        ContentCheckOff::MergeRenormalize
    } else {
        ContentCheckOff::ConfigUnreadable
    }
}

/// Which [`MERGE_DRIVER_KEYS`] key class is configured, in any scope git reads here;
/// None when none is. merge-tree runs such a driver and trusts its result, so one that
/// keeps a side writes the base tree with the branch's edit dropped. A failed read
/// counts as one ([`ContentCheckOff::ConfigUnreadable`]).
async fn merge_driver_off_reason(repo_path: &str) -> Option<ContentCheckOff> {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "--get-regexp", "--name-only", MERGE_DRIVER_KEYS],
        DEFAULT_TIMEOUT,
    )
    .await;
    // Exit 1 is git config's "no key matched"; 0 listed one.
    match out {
        Ok(out) if out.code == 1 => None,
        Ok(out) if out.code == 0 => Some(merge_keys_off_reason(&out.stdout_lossy())),
        _ => Some(ContentCheckOff::ConfigUnreadable),
    }
}

async fn merge_driver_configured(repo_path: &str) -> bool {
    merge_driver_off_reason(repo_path).await.is_some()
}

/// The base the cleanup dialog's verdicts compare against, resolved once per open, or
/// why there is none: a merge driver, `merge.default` or `merge.renormalize` configured
/// or an unreadable config, then git older than 2.38 or a version that can't be read,
/// then neither side resolving. The config gate lives here because only a verdict's
/// merge-tree can run a driver or a filter, and the dialog never asks for verdicts
/// without a base.
#[tauri::command]
pub async fn git_content_check_base(
    repo_path: String,
    default_branch: String,
) -> AppResult<ContentCheckBaseRead> {
    validate_branch_name(&default_branch)?;
    if let Some(reason) = merge_driver_off_reason(&repo_path).await {
        return Ok(ContentCheckBaseRead::off(reason));
    }
    if let Some(reason) = version_off_reason(merge_tree_write_support().await) {
        return Ok(ContentCheckBaseRead::off(reason));
    }
    Ok(
        match resolve_check_base(&repo_path, default_branch).await? {
            Some(base) => ContentCheckBaseRead {
                base: Some(base),
                off_reason: None,
            },
            None => ContentCheckBaseRead::off(ContentCheckOff::NoBase),
        },
    )
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

/// The one merge base of `a` and `b`; None when they have several or the read fails.
/// With several, merge-tree content-merges inside a virtual base and suppresses those
/// messages, so `union` or a driver could shape the result unrecorded.
async fn sole_merge_base(repo_path: &str, a: &str, b: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["merge-base", "--all", a, b],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let stdout = out.stdout_lossy();
    let mut bases = stdout.split_whitespace();
    match (out.code, bases.next(), bases.next()) {
        (0, Some(base), None) if is_full_oid(base) => Some(base.to_string()),
        _ => None,
    }
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

/// One guarded run: `clean` when merging `tip` into `into` cleanly writes exactly
/// `into_tree` under the module's trust contract, `changes` on a different tree or a
/// conflict (never read as merged), `unknown` on any other outcome.
async fn guarded_merge(repo_path: &str, into: &str, into_tree: &str, tip: &str) -> ContentVerdict {
    let Ok(mt) = run_git_raw(
        Some(repo_path),
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--messages",
            "-z",
            into,
            tip,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return ContentVerdict::Unknown;
    };
    let stdout = mt.stdout_lossy();
    let written = stdout.split('\0').next().map(str::trim).unwrap_or_default();
    let outcome = match (mt.code, written.is_empty()) {
        (_, true) => ContentVerdict::Unknown,
        (0, false) if written == into_tree => ContentVerdict::Clean,
        (0 | 1, false) => ContentVerdict::Changes,
        _ => ContentVerdict::Unknown,
    };
    // Only a clean verdict pays for the guards: the others are already safe. The
    // merge-base read goes first because a criss-cross run's records are incomplete.
    match outcome {
        ContentVerdict::Clean if sole_merge_base(repo_path, into, tip).await.is_none() => {
            ContentVerdict::Unknown
        }
        ContentVerdict::Clean => clean_unless_driver_merged(repo_path, &mt.stdout).await,
        other => other,
    }
}

/// The names `diff --name-only -z` printed; None when unreadable or empty, since an
/// empty set would make every window commit a candidate.
fn changed_paths(stdout: &[u8]) -> Option<Vec<&[u8]>> {
    let mut names: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    // `-z` terminates every name, so the split's last element must be empty.
    if names.pop() != Some(&[][..]) || names.is_empty() || names.iter().any(|n| n.is_empty()) {
        return None;
    }
    Some(names)
}

/// A first-parent base commit from the window log, with the paths its first-parent
/// change touched.
struct WindowCommit<'a> {
    oid: &'a str,
    tree: &'a str,
    paths: Vec<&'a [u8]>,
}

/// Whether the parsed headers name exactly `rev_list`'s commits, in its order (newest
/// first, as the log lists them) and count.
fn headers_match(window: &[WindowCommit<'_>], rev_list: &str) -> bool {
    window.iter().map(|c| c.oid).eq(rev_list.lines())
}

/// Reads the window log's `-z` stream: per commit a `\x01<oid> <tree>` header token,
/// then its names, the first led by `\n` (an empty change prints none). A path can
/// start with `\x01` too, so every such token must read as a header, else the whole
/// stream is unreadable (None).
fn parse_window(stdout: &[u8]) -> Option<Vec<WindowCommit<'_>>> {
    let mut tokens: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    if tokens.pop() != Some(&[][..]) {
        return None;
    }
    let mut commits: Vec<WindowCommit> = Vec::new();
    for token in tokens {
        if let Some(header) = token.strip_prefix(b"\x01") {
            let (oid, tree) = std::str::from_utf8(header).ok()?.split_once(' ')?;
            if !is_full_oid(oid) || !is_full_oid(tree) {
                return None;
            }
            commits.push(WindowCommit {
                oid,
                tree,
                paths: Vec::new(),
            });
            continue;
        }
        let commit = commits.last_mut()?;
        let path = if commit.paths.is_empty() {
            token.strip_prefix(b"\n")?
        } else {
            token
        };
        if path.is_empty() {
            return None;
        }
        commit.paths.push(path);
    }
    Some(commits)
}

/// Route 2, the landed search: the first of the first `candidate_cap` candidates whose
/// guarded run of `tip` clears. Candidates come from the first-parent base commits
/// after the sole merge base of `base_sha` and `tip`, excluding `base_sha` (route 1's
/// run): first those whose own change touches every path the branch changed, then each
/// commit where a run of consecutive commits touching the branch's paths first covers
/// them all, then the rest of each such run, each group oldest first, each commit once.
/// None when none of those clears, or on several merge bases, an empty or unreadable
/// path set or window, or a window past `window_cap`.
async fn landed_search(
    repo_path: &str,
    base_sha: &str,
    tip: &str,
    window_cap: usize,
    candidate_cap: usize,
) -> Option<String> {
    let mb = sole_merge_base(repo_path, base_sha, tip).await?;
    let diff = run_git_raw(
        Some(repo_path),
        &["diff", "--name-only", "--no-renames", "-z", &mb, tip],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if diff.code != 0 {
        return None;
    }
    let branch_paths: HashSet<&[u8]> = changed_paths(&diff.stdout)?.into_iter().collect();
    // First-parent only, because a side branch merged with `-s ours` holds content the
    // base's own tree never received. The cheap oid list is read first: it sizes the
    // window before any name-only walk, and paths can't reach its output.
    let max_count = format!("--max-count={}", window_cap + 1);
    let revs = run_git_raw(
        Some(repo_path),
        &[
            "rev-list",
            "--first-parent",
            &max_count,
            base_sha,
            "--not",
            &mb,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if revs.code != 0 {
        return None;
    }
    let revs = revs.stdout_lossy();
    // The lists run newest first, so a capped window would drop the oldest commits,
    // exactly where landings sit.
    if revs.lines().count() > window_cap {
        return None;
    }
    // Never pathspec-limited: with `--first-parent` a pathspec simplifies history away,
    // so the names are filtered here.
    let log = run_git_raw(
        Some(repo_path),
        &[
            "log",
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-renames",
            "--name-only",
            "-z",
            "--no-color",
            "--no-show-signature",
            "--format=%x01%H %T",
            &max_count,
            base_sha,
            "--not",
            &mb,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if log.code != 0 {
        return None;
    }
    let window = parse_window(&log.stdout)?;
    // A path spelled like a header passes the parser, so the headers must be exactly
    // the window's commits as rev-list lists them.
    if !headers_match(&window, &revs) {
        return None;
    }
    // Oldest first, each with the branch paths its own change touches.
    let commits: Vec<(&WindowCommit, HashSet<&[u8]>)> = window
        .iter()
        .rev()
        .filter(|c| c.oid != base_sha)
        .map(|c| {
            let touched = c
                .paths
                .iter()
                .copied()
                .filter(|p| branch_paths.contains(p))
                .collect();
            (c, touched)
        })
        .collect();
    let full_cover = commits
        .iter()
        .filter(|(_, touched)| touched.len() == branch_paths.len())
        .map(|(c, _)| *c);
    // A landing split across commits, per maximal run of consecutive commits that
    // touch a branch path: the commit where the run's union first covers them all, then
    // the rest of the run, since unrelated edits may complete the cover early. Every
    // run's first cover ranks ahead of any run's rest, so only full-cover commits rank
    // ahead of a run's first cover.
    let mut first_covers = Vec::new();
    let mut run_rests = Vec::new();
    let mut covered: HashSet<&[u8]> = HashSet::new();
    for (c, touched) in &commits {
        if touched.is_empty() {
            covered.clear();
        } else if covered.len() == branch_paths.len() {
            run_rests.push(*c);
        } else {
            covered.extend(touched.iter().copied());
            if covered.len() == branch_paths.len() {
                first_covers.push(*c);
            }
        }
    }
    let mut seen = HashSet::new();
    let candidates: Vec<&WindowCommit> = full_cover
        .chain(first_covers)
        .chain(run_rests)
        .filter(|c| seen.insert(c.oid))
        .take(candidate_cap)
        .collect();
    for c in candidates {
        if guarded_merge(repo_path, c.oid, c.tree, tip).await == ContentVerdict::Clean {
            return Some(c.oid.to_string());
        }
    }
    None
}

/// Routes 1 and 2 for `tip`: Ok(None) when the base tip cleared it, Ok(Some(c)) when
/// history commit `c` did, else Err with route 1's own verdict.
async fn clear(
    repo_path: &str,
    base_sha: &str,
    base_tree: &str,
    tip: &str,
) -> Result<Option<String>, ContentVerdict> {
    match guarded_merge(repo_path, base_sha, base_tree, tip).await {
        ContentVerdict::Clean => Ok(None),
        verdict => landed_search(repo_path, base_sha, tip, WINDOW_CAP, CANDIDATE_CAP)
            .await
            .map(Some)
            .ok_or(verdict),
    }
}

/// Route 3's head: `hint` resolved to a commit whose oid extends it (a ref named like
/// the prefix resolves to its own target instead) and that `tip` is a strict ancestor
/// of. None on any miss or failed read.
async fn pr_head_commit(repo_path: &str, hint: &str, tip: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{hint}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let head_oid = out.stdout_lossy().trim().to_string();
    if out.code != 0 || !is_full_oid(&head_oid) || !head_oid.starts_with(hint) || head_oid == tip {
        return None;
    }
    let ancestor = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", tip, &head_oid],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (ancestor.code == 0).then_some(head_oid)
}

/// Whether `branch` carries anything `base_sha` lacks, through the module's routes:
/// `clean` when any guarded run cleared, else route 1's own verdict. Every git failure
/// after validation reads `unknown` or `changes` rather than Err, because consumers gate
/// on the verdict; Err is reserved for invalid input, refused before any spawn.
/// `pr_head` sits outside that surface: a malformed, unresolvable, shadowed or diverged
/// hint is ignored.
#[tauri::command]
pub async fn git_branch_content_merged(
    repo_path: String,
    base_sha: String,
    base_tree: String,
    branch: String,
    pr_head: Option<String>,
) -> AppResult<BranchContentMerged> {
    validate_branch_name(&branch)?;
    validate_oid(&base_sha, "base commit")?;
    validate_oid(&base_tree, "base tree")?;
    let pr_head = pr_head.filter(|hint| is_head_hint(hint));
    let row = |verdict, head_sha, landed_in, via_pr_head| BranchContentMerged {
        branch: branch.clone(),
        verdict,
        head_sha,
        landed_in,
        via_pr_head,
    };
    // The merge runs on the resolved tip, never the name, so the verdict belongs to
    // exactly the sha reported as `head_sha`.
    let Ok(Some(tip)) = branch_tip_sha(&repo_path, &branch).await else {
        return Ok(row(ContentVerdict::Unknown, None, None, false));
    };
    let tip_verdict = match clear(&repo_path, &base_sha, &base_tree, &tip).await {
        Ok(landed_in) => return Ok(row(ContentVerdict::Clean, Some(tip), landed_in, false)),
        Err(verdict) => verdict,
    };
    if let Some(hint) = pr_head {
        if let Some(head) = pr_head_commit(&repo_path, &hint, &tip).await {
            if let Ok(landed_in) = clear(&repo_path, &base_sha, &base_tree, &head).await {
                return Ok(row(ContentVerdict::Clean, Some(tip), landed_in, true));
            }
        }
    }
    Ok(row(tip_verdict, Some(tip), None, false))
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
        check_with_head(repo, branch, None).await
    }

    async fn check_with_head(
        repo: &str,
        branch: &str,
        pr_head: Option<&str>,
    ) -> BranchContentMerged {
        let sha = rev(repo, "refs/heads/main").await;
        let tree = rev(repo, "refs/heads/main^{tree}").await;
        git_branch_content_merged(
            repo.to_string(),
            sha,
            tree,
            branch.to_string(),
            pr_head.map(str::to_string),
        )
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

    /// An adjacent edit on the base conflicts with the already-squashed change at the
    /// base tip, so the squash commit in base history is what clears the branch.
    #[tokio::test]
    async fn adjacent_base_edit_after_squash_lands_through_history() {
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
        let squash = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nL3\nl4\n", "edit l3").await;

        assert_eq!(merge_tree_code(&repo, "cm-adjacent").await, 1);
        let got = check(&repo, "cm-adjacent").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in, Some(squash));
        assert!(!got.via_pr_head);
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
            let merged = git_branch_content_merged(
                nowhere.clone(),
                oid.clone(),
                oid.clone(),
                name.into(),
                None,
            )
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
            let sha = git_branch_content_merged(
                nowhere.clone(),
                bad.clone(),
                oid.clone(),
                "b".into(),
                None,
            )
            .await;
            assert!(
                matches!(sha, Err(AppError::InvalidArgument(_))),
                "sha {bad:?}"
            );
            let tree = git_branch_content_merged(
                nowhere.clone(),
                oid.clone(),
                bad.clone(),
                "b".into(),
                None,
            )
            .await;
            assert!(
                matches!(tree, Err(AppError::InvalidArgument(_))),
                "tree {bad:?}"
            );
        }
        // Well-formed input against no repository is an answer, not an error.
        let fine =
            git_branch_content_merged(nowhere, oid.clone(), "b".repeat(64), "b".into(), None)
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
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        let read = git_content_check_base(repo.clone(), "cm-nonesuch".to_string())
            .await
            .unwrap();
        assert!(read.base.is_none(), "{read:?}");
        assert_eq!(read.off_reason, Some(ContentCheckOff::NoBase));
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
            .unwrap();
        assert_eq!(got.off_reason, None, "{got:?}");
        let base = got.base.expect("a base resolves");
        assert_eq!((base.ref_name.as_str(), base.sha.as_str()), ("main", sha));
    }

    /// The gate alone answers `reason` with no base: the resolver below it still finds
    /// one. An inherited key can outrank the repo's own, so then any reason passes.
    async fn expect_gated(repo: &str, sha: &str, reason: ContentCheckOff) {
        let got = git_content_check_base(repo.to_string(), "main".to_string())
            .await
            .unwrap();
        assert!(got.base.is_none(), "{got:?}");
        if inherited_merge_keys(repo).await.is_none() {
            assert_eq!(got.off_reason, Some(reason));
        } else {
            assert!(got.off_reason.is_some(), "{got:?}");
        }
        expect_base(repo, "main", "main", sha).await;
    }

    #[tokio::test]
    async fn base_is_none_when_a_merge_driver_is_configured() {
        let (_dir, repo) = setup_repo("base-driver").await;
        let a = rev(&repo, "HEAD").await;
        expect_command_base_unless_inherited(&repo, &a).await;

        configure_ours_driver(&repo).await;
        expect_gated(&repo, &a, ContentCheckOff::MergeDriver).await;
        // A driver outranks the other keys.
        git(&repo, &["config", "merge.default", "union"]).await;
        git(&repo, &["config", "merge.renormalize", "true"]).await;
        expect_gated(&repo, &a, ContentCheckOff::MergeDriver).await;
    }

    #[tokio::test]
    async fn base_is_none_when_merge_default_is_configured() {
        let (_dir, repo) = setup_repo("base-merge-default").await;
        let a = rev(&repo, "HEAD").await;
        expect_command_base_unless_inherited(&repo, &a).await;

        git(&repo, &["config", "merge.default", "union"]).await;
        expect_gated(&repo, &a, ContentCheckOff::MergeDefault).await;
        // merge.default outranks renormalize.
        git(&repo, &["config", "merge.renormalize", "true"]).await;
        expect_gated(&repo, &a, ContentCheckOff::MergeDefault).await;
    }

    /// Presence gates: renormalize turns the check off whatever its value.
    #[tokio::test]
    async fn base_is_none_when_merge_renormalize_is_configured() {
        for value in ["true", "false"] {
            let (_dir, repo) = setup_repo(&format!("base-renormalize-{value}")).await;
            let a = rev(&repo, "HEAD").await;
            expect_command_base_unless_inherited(&repo, &a).await;

            git(&repo, &["config", "merge.renormalize", value]).await;
            expect_gated(&repo, &a, ContentCheckOff::MergeRenormalize).await;
        }
    }

    /// A config git can't parse fails the key read, and the open names that.
    #[tokio::test]
    async fn base_is_none_when_the_config_is_unreadable() {
        let (dir, repo) = setup_repo("base-config-unreadable").await;
        let config = dir.path().join(".git").join("config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[[[ not a section\n");
        std::fs::write(&config, text).unwrap();
        let got = git_content_check_base(repo.clone(), "main".to_string())
            .await
            .unwrap();
        assert!(got.base.is_none(), "{got:?}");
        assert_eq!(got.off_reason, Some(ContentCheckOff::ConfigUnreadable));
        assert!(merge_driver_configured(&repo).await);
    }

    #[test]
    fn merge_key_listings_name_their_class_by_priority() {
        for (names, want) in [
            ("merge.x.driver\n", ContentCheckOff::MergeDriver),
            (
                "merge.default\nmerge.renormalize\nmerge.ours.driver\n",
                ContentCheckOff::MergeDriver,
            ),
            ("merge.default.driver\n", ContentCheckOff::MergeDriver),
            (
                "merge.renormalize\nmerge.default\n",
                ContentCheckOff::MergeDefault,
            ),
            ("merge.renormalize\n", ContentCheckOff::MergeRenormalize),
            ("merge.renormalize\r\n", ContentCheckOff::MergeRenormalize),
            ("", ContentCheckOff::ConfigUnreadable),
            ("merge.renormalizex\n", ContentCheckOff::ConfigUnreadable),
        ] {
            assert_eq!(merge_keys_off_reason(names), want, "{names:?}");
        }
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

    /// The base read's gate ran before this key existed, but the squash commit holds
    /// the tip's `f.txt` verbatim: its run content-merges nothing, so no key read
    /// applies and it clears.
    #[tokio::test]
    async fn driver_configured_after_the_base_read_skips_a_clean_without_content_merge() {
        let (_dir, repo) = auto_merged_clean_repo("late-driver", "* merge=lfs\n").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        git(&repo, &["config", "merge.lfs.driver", "true"]).await;
        let got = check(&repo, "cm-auto").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in, Some(rev(&repo, "refs/heads/main~1").await));
    }

    /// The verdict re-reads the driver key the base read's gate ran before: with no
    /// base commit holding the tip's `f.txt` verbatim, every clean run content-merges
    /// it, so the tip run's demotion stands.
    #[tokio::test]
    async fn driver_configured_after_the_base_read_keeps_the_tip_demotion() {
        let (dir, repo) = setup_repo("late-driver-tip").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(
            &repo,
            dir.path(),
            ".gitattributes",
            "* merge=lfs\n",
            "attrs",
        )
        .await;
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
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            "l1\nL2\nl3\nL4\nl5\nl6\n",
            "l2 with l4",
        )
        .await;
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            "l1\nL2\nl3\nL4\nl5\nL6\n",
            "edit l6",
        )
        .await;
        assert_eq!(auto_merged(&repo, "cm-auto").await, ["f.txt"]);
        assert_eq!(check(&repo, "cm-auto").await.verdict, ContentVerdict::Clean);

        git(&repo, &["config", "merge.lfs.driver", "true"]).await;
        let got = check(&repo, "cm-auto").await;
        assert_eq!(got.verdict, ContentVerdict::Unknown);
        assert_eq!((got.landed_in, got.via_pr_head), (None, false));
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

    /// Exactly the driver, default and renormalize keys turn the check off, renormalize
    /// even when false, whatever the developer's own config holds: `--file` reads only
    /// the given file.
    #[tokio::test]
    async fn merge_driver_keys_match_only_driver_default_and_renormalize() {
        let dir = tempfile::Builder::new()
            .prefix("gd-content-merged-keys-")
            .tempdir()
            .expect("create temp dir");
        let file = dir.path().join("config");
        std::fs::write(
            &file,
            "[merge]\n\tdefault = union\n\trenormalize = false\n\trenormalizeX = true\n[merge \"x\"]\n\tdriver = true\n\tname = x\n[mergetool \"x\"]\n\tcmd = x\n",
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
            ["merge.default", "merge.renormalize", "merge.x.driver"]
        );
    }

    #[test]
    fn write_tree_support_starts_at_git_2_38() {
        assert_eq!(
            parse_git_version("git version 2.51.1.windows.1\n"),
            Some((2, 51))
        );
        use GitVersionSupport::{Supported, TooOld, Unreadable};
        for (exited_ok, stdout, want) in [
            (true, "git version 2.37.0", TooOld),
            (true, "git version 2.37.9", TooOld),
            (true, "git version 2.38.0", Supported),
            (true, "git version 3.0.0", Supported),
            (true, "garbage", Unreadable),
            (true, "", Unreadable),
            (true, "git version x.y", Unreadable),
            (false, "git version 2.38.0", Unreadable),
            (false, "git version 2.37.0", Unreadable),
            (false, "", Unreadable),
        ] {
            assert_eq!(
                classify_git_version(exited_ok, stdout),
                want,
                "{exited_ok} {stdout:?}"
            );
        }
    }

    #[test]
    fn version_probe_maps_to_its_off_reason() {
        for (support, want) in [
            (GitVersionSupport::Supported, None),
            (GitVersionSupport::TooOld, Some(ContentCheckOff::GitTooOld)),
            (
                GitVersionSupport::Unreadable,
                Some(ContentCheckOff::GitVersionUnreadable),
            ),
        ] {
            assert_eq!(version_off_reason(support), want, "{support:?}");
        }
    }

    #[tokio::test]
    async fn version_support_caches_only_a_parsed_answer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use GitVersionSupport::{Supported, TooOld, Unreadable};
        for answer in [Supported, TooOld] {
            let cell = tokio::sync::OnceCell::new();
            let calls = AtomicUsize::new(0);
            let probe = |support: GitVersionSupport| {
                let calls = &calls;
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    support
                }
            };
            assert_eq!(cached_support(&cell, probe(Unreadable)).await, Unreadable);
            assert_eq!(cached_support(&cell, probe(answer)).await, answer);
            assert_eq!(cached_support(&cell, probe(Unreadable)).await, answer);
            assert_eq!(calls.load(Ordering::SeqCst), 2, "{answer:?}");
        }
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
            landed_in: None,
            via_pr_head: false,
        })
        .unwrap();
        assert_eq!(
            row,
            serde_json::json!({
                "branch": "b",
                "verdict": "changes",
                "headSha": null,
                "landedIn": null,
                "viaPrHead": false,
            })
        );
        let landed = serde_json::to_value(BranchContentMerged {
            branch: "b".into(),
            verdict: ContentVerdict::Clean,
            head_sha: Some("h".into()),
            landed_in: Some("c".into()),
            via_pr_head: true,
        })
        .unwrap();
        assert_eq!(landed["landedIn"], "c");
        assert_eq!(landed["viaPrHead"], true);
        for row in [&row, &landed] {
            for snake in ["head_sha", "landed_in", "via_pr_head"] {
                assert!(row.get(snake).is_none(), "{snake} in {row}");
            }
        }
        for (verdict, wire) in [
            (ContentVerdict::Clean, "clean"),
            (ContentVerdict::Changes, "changes"),
            (ContentVerdict::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(verdict).unwrap(), wire);
        }

        let ready = serde_json::to_value(ContentCheckBaseRead {
            base: Some(ContentCheckBase {
                ref_name: "main".into(),
                sha: "s".into(),
                tree: "t".into(),
            }),
            off_reason: None,
        })
        .unwrap();
        assert_eq!(
            ready,
            serde_json::json!({
                "base": { "refName": "main", "sha": "s", "tree": "t" },
                "offReason": null,
            })
        );
        for (reason, wire) in [
            (ContentCheckOff::MergeDriver, "mergeDriver"),
            (ContentCheckOff::MergeDefault, "mergeDefault"),
            (ContentCheckOff::MergeRenormalize, "mergeRenormalize"),
            (ContentCheckOff::ConfigUnreadable, "configUnreadable"),
            (ContentCheckOff::GitTooOld, "gitTooOld"),
            (
                ContentCheckOff::GitVersionUnreadable,
                "gitVersionUnreadable",
            ),
            (ContentCheckOff::NoBase, "noBase"),
        ] {
            let off = serde_json::to_value(ContentCheckBaseRead::off(reason)).unwrap();
            assert_eq!(
                off,
                serde_json::json!({ "base": null, "offReason": wire }),
                "{reason:?}"
            );
            assert!(off.get("off_reason").is_none(), "{off}");
        }
        assert!(ready.get("off_reason").is_none(), "{ready}");
    }

    /// A commit on `tree_of`'s tree with `parents`, touching no ref or worktree.
    async fn commit_on(repo: &str, tree_of: &str, parents: &[&str], msg: &str) -> String {
        let tree = format!("{tree_of}^{{tree}}");
        let mut args = vec!["commit-tree", tree.as_str()];
        for parent in parents {
            args.extend(["-p", parent]);
        }
        args.extend(["-m", msg]);
        git(repo, &args).await.trim().to_string()
    }

    async fn guarded_at(repo: &str, into: &str, tip: &str) -> ContentVerdict {
        let tree = rev(repo, &format!("{into}^{{tree}}")).await;
        guarded_merge(repo, into, &tree, tip).await
    }

    #[tokio::test]
    async fn partial_landing_across_two_commits_reads_changes() {
        let (dir, repo) = setup_repo("partial").await;
        commit_file(&repo, dir.path(), "f1.txt", "one\n", "f1").await;
        commit_file(&repo, dir.path(), "f2.txt", "two\n", "f2").await;
        git(&repo, &["checkout", "-b", "cm-partial"]).await;
        commit_file(&repo, dir.path(), "f1.txt", "ONE\n", "b1").await;
        commit_file(&repo, dir.path(), "f2.txt", "TWO\n", "b2").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f1.txt", "ONE\n", "lands f1").await;
        std::fs::write(dir.path().join("f1.txt"), "one\n").unwrap();
        commit_file(&repo, dir.path(), "f2.txt", "TWO\n", "lands f2, reverts f1").await;
        commit_file(&repo, dir.path(), "g.txt", "g\n", "moves on").await;

        let got = check(&repo, "cm-partial").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// The content reached main only through a side branch merged with `-s ours`, so no
    /// first-parent tree ever held it; the side branch's squash alone would clear it.
    #[tokio::test]
    async fn content_only_on_an_ours_merged_side_branch_reads_changes() {
        let (dir, repo) = setup_repo("ours").await;
        git(&repo, &["checkout", "-b", "cm-ours"]).await;
        commit_file(&repo, dir.path(), "s.txt", "one\n", "s1").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "-b", "cm-dev", "main"]).await;
        git(&repo, &["merge", "--squash", "cm-ours"]).await;
        git(&repo, &["commit", "-m", "squashed into dev"]).await;
        let dev_squash = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        git(&repo, &["merge", "-s", "ours", "--no-edit", "cm-dev"]).await;
        commit_file(&repo, dir.path(), "g.txt", "g\n", "moves on").await;

        assert_eq!(
            guarded_at(&repo, &dev_squash, &tip).await,
            ContentVerdict::Clean
        );
        let got = check(&repo, "cm-ours").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// `c1` holds the tip's tree but shares two merge bases with it, so its clean run
    /// is unreadable and the search moves on to `m3`. Base history: c1 (x + y), m2
    /// merging the branch's base, k dropping `s.txt`, m3 restoring it, then a reword
    /// that keeps the tip run from clearing.
    #[tokio::test]
    async fn criss_cross_candidate_is_skipped_for_a_later_one() {
        let (dir, repo) = setup_repo("cc-candidate").await;
        let root = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "-b", "cm-x"]).await;
        commit_file(&repo, dir.path(), "p.txt", "p\n", "x").await;
        let x = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "-b", "cm-cc", &root]).await;
        commit_file(&repo, dir.path(), "q.txt", "q\n", "y").await;
        let y = rev(&repo, "HEAD").await;
        git(&repo, &["merge", "--no-edit", "cm-x"]).await;
        let y2 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "s.txt", "landed\n", "branch work").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "-b", "cm-reword", &y2]).await;
        commit_file(&repo, dir.path(), "s.txt", "other\n", "reword").await;
        let reword = rev(&repo, "HEAD").await;
        let c1 = commit_on(&repo, &tip, &[&x, &y], "c1").await;
        let m2 = commit_on(&repo, &tip, &[&c1, &y2], "m2").await;
        let k = commit_on(&repo, &y2, &[&m2], "drops s").await;
        let m3 = commit_on(&repo, &tip, &[&k], "m3").await;
        let base_tip = commit_on(&repo, &reword, &[&m3], "rewords s").await;
        set_ref(&repo, "refs/heads/main", &base_tip).await;

        let bases = git(&repo, &["merge-base", "--all", &c1, &tip]).await;
        assert_eq!(bases.split_whitespace().count(), 2, "{bases}");
        let bases = git(&repo, &["merge-base", "--all", &base_tip, &tip]).await;
        assert_eq!(bases.split_whitespace().count(), 1, "{bases}");
        assert_eq!(merge_tree_code(&repo, "cm-cc").await, 1);
        let raw = run_git_raw(
            Some(&repo),
            &["merge-tree", "--write-tree", "--name-only", &c1, &tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(raw.code, 0, "{}", raw.stdout_lossy());
        assert_eq!(
            raw.stdout_lossy().lines().next().unwrap_or_default().trim(),
            rev(&repo, &format!("{c1}^{{tree}}")).await
        );

        let got = check(&repo, "cm-cc").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in, Some(m3));
    }

    /// The candidate's run content-merges `f.txt` under an uncommitted `union`
    /// attribute, so its clean doesn't count; the tip run's own `changes` stands.
    #[tokio::test]
    async fn union_on_a_candidate_run_keeps_the_tip_verdict() {
        let (dir, repo) = setup_repo("union-candidate").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f.txt", "a\nX\nb\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-union-candidate"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nb\n", "delete X").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f.txt", "a\nY\nb\n", "reword X").await;
        let candidate = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "f.txt", "a\nX\nb\n", "restore X").await;
        std::fs::write(dir.path().join(".gitattributes"), "f.txt merge=union\n").unwrap();

        assert_eq!(merge_attr(&repo, "f.txt").await, "union");
        assert_eq!(merge_tree_code(&repo, "cm-union-candidate").await, 0);
        assert!(auto_merged(&repo, "cm-union-candidate").await.is_empty());
        let raw = run_git_raw(
            Some(&repo),
            &[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--messages",
                "-z",
                &candidate,
                &tip,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(raw.code, 0, "{}", raw.stdout_lossy());
        assert_eq!(
            raw.stdout_lossy().split('\0').next().unwrap_or_default(),
            rev(&repo, &format!("{candidate}^{{tree}}")).await
        );
        assert_eq!(auto_merged_paths(&raw.stdout), Some(vec![&b"f.txt"[..]]));

        let got = check(&repo, "cm-union-candidate").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// With renormalize the clean filter drops the branch's line before the merge, so
    /// merge-tree writes main's tree though no base commit holds `SECRET`.
    #[tokio::test]
    async fn renormalize_with_a_dropping_filter_reads_no_verdict() {
        let (dir, repo) = setup_repo("renormalize").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f", "l1\nl2\nl3\nl4\n", "m0").await;
        git(&repo, &["checkout", "-b", "cm-renormalize"]).await;
        commit_file(&repo, dir.path(), "f", "l1\nl2\nl3\nl4\nSECRET\n", "b1").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f", "L1\nl2\nl3\nl4\n", "m1").await;
        git(&repo, &["config", "merge.renormalize", "true"]).await;
        git(&repo, &["config", "filter.drop.clean", "sed /SECRET/d"]).await;
        let info = dir.path().join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("attributes"), "f filter=drop\n").unwrap();

        let mt = merge_tree_run(&repo, "cm-renormalize").await;
        assert_eq!(mt.code, 0, "{}", mt.stdout_lossy());
        let written = mt
            .stdout_lossy()
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        assert_eq!(written, rev(&repo, "refs/heads/main^{tree}").await);

        expect_gated(
            &repo,
            &rev(&repo, "refs/heads/main").await,
            ContentCheckOff::MergeRenormalize,
        )
        .await;
        assert_eq!(
            check(&repo, "cm-renormalize").await.verdict,
            ContentVerdict::Unknown
        );
    }

    /// Lines l1..l8 of `f.txt`, with `edits` replacing lines by 1-based number.
    fn lines8(edits: &[(usize, &str)]) -> String {
        (1..=8)
            .map(|i| {
                edits
                    .iter()
                    .find(|(n, _)| *n == i)
                    .map_or_else(|| format!("l{i}"), |(_, s)| (*s).to_string())
            })
            .map(|line| line + "\n")
            .collect()
    }

    /// The squash and a later far edit of the same file both clear; the older wins.
    #[tokio::test]
    async fn landed_search_names_the_first_clearing_full_cover_commit() {
        let (dir, repo) = setup_repo("oldest").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f.txt", &lines8(&[]), "lines").await;
        git(&repo, &["checkout", "-b", "cm-oldest"]).await;
        commit_file(&repo, dir.path(), "f.txt", &lines8(&[(2, "L2")]), "edit l2").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            &lines8(&[(2, "L2")]),
            "squashed",
        )
        .await;
        let squash = rev(&repo, "HEAD").await;
        let far = lines8(&[(2, "L2"), (8, "L8")]);
        commit_file(&repo, dir.path(), "f.txt", &far, "edit l8").await;
        let later = rev(&repo, "HEAD").await;
        let adjacent = lines8(&[(2, "L2"), (3, "L3"), (8, "L8")]);
        commit_file(&repo, dir.path(), "f.txt", &adjacent, "edit l3").await;

        assert_eq!(merge_tree_code(&repo, "cm-oldest").await, 1);
        assert_eq!(guarded_at(&repo, &later, &tip).await, ContentVerdict::Clean);
        assert_eq!(check(&repo, "cm-oldest").await.landed_in, Some(squash));
    }

    /// Four candidates touch `f.txt`; only the fourth lands the branch's line, past the
    /// cost bound of three runs.
    #[tokio::test]
    async fn candidates_past_the_cap_are_not_run() {
        let (dir, repo) = setup_repo("candidate-cap").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f.txt", &lines8(&[]), "lines").await;
        git(&repo, &["checkout", "-b", "cm-cap"]).await;
        commit_file(&repo, dir.path(), "f.txt", &lines8(&[(2, "L2")]), "edit l2").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        for word in ["a", "b", "c"] {
            commit_file(&repo, dir.path(), "f.txt", &lines8(&[(6, word)]), word).await;
        }
        commit_file(
            &repo,
            dir.path(),
            "f.txt",
            &lines8(&[(2, "L2"), (6, "c")]),
            "lands",
        )
        .await;
        let lands = rev(&repo, "HEAD").await;
        let adjacent = lines8(&[(2, "L2"), (3, "L3"), (6, "c")]);
        commit_file(&repo, dir.path(), "f.txt", &adjacent, "edit l3").await;
        let base = rev(&repo, "HEAD").await;

        assert_eq!(
            landed_search(&repo, &base, &tip, WINDOW_CAP, 4).await,
            Some(lands)
        );
        let got = check(&repo, "cm-cap").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// One base commit for `split_landing_repo`: file, `lines8` edits, message.
    type BaseEdit<'a> = (&'a str, &'a [(usize, &'a str)], &'a str);

    /// Base history for a branch editing line 2 of `f1.txt` then of `f2.txt`: `before`
    /// commits, then `f2.txt`'s landing, then an edit of the line beside it that keeps
    /// the tip run from clearing. Returns (TempDir, repo, tip, b2', base tip).
    async fn split_landing_repo(
        marker: &str,
        before: &[BaseEdit<'_>],
    ) -> (tempfile::TempDir, String, String, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        std::fs::write(dir.path().join("f1.txt"), lines8(&[])).unwrap();
        commit_file(&repo, dir.path(), "f2.txt", &lines8(&[]), "lines").await;
        git(&repo, &["checkout", "-b", "cm-split"]).await;
        commit_file(&repo, dir.path(), "f1.txt", &lines8(&[(2, "F1")]), "b1").await;
        commit_file(&repo, dir.path(), "f2.txt", &lines8(&[(2, "F2")]), "b2").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        for (file, edits, msg) in before {
            commit_file(&repo, dir.path(), file, &lines8(edits), msg).await;
        }
        commit_file(&repo, dir.path(), "f2.txt", &lines8(&[(2, "F2")]), "b2'").await;
        let b2 = rev(&repo, "HEAD").await;
        let adjacent = lines8(&[(2, "F2"), (3, "ADJ")]);
        commit_file(&repo, dir.path(), "f2.txt", &adjacent, "edit l3").await;
        let base = rev(&repo, "HEAD").await;
        (dir, repo, tip, b2, base)
    }

    /// No base commit touches both files, so the run's candidates start at `b2'`, where
    /// it first covers both; the search names `b2'` ahead of the run's later commit.
    #[tokio::test]
    async fn split_landing_clears_at_the_commit_completing_it() {
        let before: &[BaseEdit<'_>] = &[
            ("f1.txt", &[(6, "other")], "far f1 edit"),
            ("f1.txt", &[(2, "F1"), (6, "other")], "b1'"),
        ];
        let (dir, repo, tip, b2, _) = split_landing_repo("split", before).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "g.txt", "g\n", "moves on").await;

        assert_eq!(merge_tree_code(&repo, "cm-split").await, 1);
        assert_eq!(guarded_at(&repo, &b2, &tip).await, ContentVerdict::Clean);
        let got = check(&repo, "cm-split").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in, Some(b2));
        assert!(!got.via_pr_head);
    }

    /// The run first covers both files at `b2'`, but a revert inside it took `f1.txt`'s
    /// line back out, so the guarded run of `b2'`, the run's only candidate (the
    /// adjacent edit is the base tip), decides against it.
    #[tokio::test]
    async fn split_landing_with_a_reverted_half_reads_changes() {
        let before: &[BaseEdit<'_>] = &[
            ("f1.txt", &[(2, "F1")], "b1'"),
            ("f1.txt", &[], "reverts b1'"),
        ];
        let (_dir, repo, tip, b2, base) = split_landing_repo("split-revert", before).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(guarded_at(&repo, &b2, &tip).await, ContentVerdict::Changes);
        assert_eq!(
            landed_search(&repo, &base, &tip, WINDOW_CAP, CANDIDATE_CAP).await,
            None
        );
        let got = check(&repo, "cm-split").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// One commit's files, each with its full [`lines8`] edits.
    type FileEdits<'a> = &'a [(&'a str, &'a [(usize, &'a str)])];

    /// Branch `cm-run` makes `branch`'s commits and `main` then makes `main`'s, both
    /// from `f1.txt` and `f2.txt` at their [`lines8`] start. Returns (TempDir, repo,
    /// tip, each main commit's oid in order).
    async fn run_repo(
        marker: &str,
        branch: &[FileEdits<'_>],
        main: &[FileEdits<'_>],
    ) -> (tempfile::TempDir, String, String, Vec<String>) {
        let (dir, repo) = setup_repo(marker).await;
        std::fs::write(dir.path().join("f1.txt"), lines8(&[])).unwrap();
        commit_file(&repo, dir.path(), "f2.txt", &lines8(&[]), "lines").await;
        let commit = |files: FileEdits<'_>| {
            for (file, edits) in files {
                std::fs::write(dir.path().join(file), lines8(edits)).unwrap();
            }
        };
        git(&repo, &["checkout", "-b", "cm-run"]).await;
        for files in branch {
            commit(files);
            git(&repo, &["add", "-A"]).await;
            git(&repo, &["commit", "-m", "branch"]).await;
        }
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        let mut oids = Vec::new();
        for files in main {
            commit(files);
            git(&repo, &["add", "."]).await;
            git(&repo, &["commit", "-m", "main"]).await;
            oids.push(rev(&repo, "HEAD").await);
        }
        (dir, repo, tip, oids)
    }

    /// `k1'` touches both files but lacks `k2'`'s line, so the run's later commit is
    /// the one that clears.
    #[tokio::test]
    async fn rebase_landing_clears_after_a_first_commit_touching_every_path() {
        let k1: FileEdits = &[("f1.txt", &[(2, "K1")]), ("f2.txt", &[(2, "K1")])];
        let k2: FileEdits = &[("f1.txt", &[(2, "K1"), (4, "K2")])];
        let adjacent: FileEdits = &[("f1.txt", &[(2, "K1"), (4, "K2"), (5, "ADJ")])];
        let unrelated: FileEdits = &[("g.txt", &[])];
        let main = [unrelated, k1, k2, adjacent];
        let (_dir, repo, _, oids) = run_repo("rebase-first-covers", &[k1, k2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(merge_tree_code(&repo, "cm-run").await, 1);
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in.as_ref(), Some(&oids[2]));
    }

    /// Unrelated edits of both files open the run and cover it before the landing.
    #[tokio::test]
    async fn landing_after_unrelated_edits_in_its_run_clears() {
        let b1: FileEdits = &[("f1.txt", &[(2, "F1")])];
        let b2: FileEdits = &[("f2.txt", &[(2, "F2")])];
        let main: [FileEdits; 5] = [
            &[("f1.txt", &[(8, "U")])],
            &[("f2.txt", &[(8, "U")])],
            &[("f1.txt", &[(2, "F1"), (8, "U")])],
            &[("f2.txt", &[(2, "F2"), (8, "U")])],
            &[("f2.txt", &[(2, "F2"), (3, "ADJ"), (8, "U")])],
        ];
        let (_dir, repo, _, oids) = run_repo("unrelated-in-run", &[b1, b2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(merge_tree_code(&repo, "cm-run").await, 1);
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in.as_ref(), Some(&oids[3]));
    }

    /// A commit touching neither file splits the landing into two runs, neither of which
    /// covers both files.
    #[tokio::test]
    async fn a_landing_split_by_an_unrelated_commit_gets_no_candidate() {
        let b1: FileEdits = &[("f1.txt", &[(2, "F1")])];
        let b2: FileEdits = &[("f2.txt", &[(2, "F2")])];
        let main: [FileEdits; 4] = [
            b1,
            &[("g.txt", &[])],
            b2,
            &[("f2.txt", &[(2, "F2"), (3, "ADJ")])],
        ];
        let (_dir, repo, tip, oids) = run_repo("split-by-unrelated", &[b1, b2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(
            guarded_at(&repo, &oids[2], &tip).await,
            ContentVerdict::Clean
        );
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }

    /// An older run of far edits covers both files with a tail of its own before the
    /// branch's split landing; that run's first cover and the landing's both run ahead
    /// of the older tail.
    #[tokio::test]
    async fn a_split_landing_after_an_older_covering_run_still_runs() {
        let b1: FileEdits = &[("f1.txt", &[(2, "F1")])];
        let b2: FileEdits = &[("f2.txt", &[(2, "F2")])];
        let main: [FileEdits; 8] = [
            &[("f1.txt", &[(8, "U")])],
            &[("f2.txt", &[(8, "U")])],
            &[("f1.txt", &[(6, "V"), (8, "U")])],
            &[("f2.txt", &[(6, "V"), (8, "U")])],
            &[("g.txt", &[])],
            &[("f1.txt", &[(2, "F1"), (6, "V"), (8, "U")])],
            &[("f2.txt", &[(2, "F2"), (6, "V"), (8, "U")])],
            &[("f2.txt", &[(2, "F2"), (3, "ADJ"), (6, "V"), (8, "U")])],
        ];
        let (_dir, repo, _, oids) = run_repo("split-after-old-run", &[b1, b2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(merge_tree_code(&repo, "cm-run").await, 1);
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in.as_ref(), Some(&oids[6]));
    }

    /// A squash touching both files ranks ahead of an older covering run's tail.
    #[tokio::test]
    async fn a_squash_landing_outranks_an_older_runs_tail() {
        let b1: FileEdits = &[("f1.txt", &[(2, "F1")])];
        let b2: FileEdits = &[("f2.txt", &[(2, "F2")])];
        let main: [FileEdits; 7] = [
            &[("f1.txt", &[(8, "U")])],
            &[("f2.txt", &[(8, "U")])],
            &[("f1.txt", &[(6, "V"), (8, "U")])],
            &[("f2.txt", &[(6, "V"), (8, "U")])],
            &[("g.txt", &[])],
            &[
                ("f1.txt", &[(2, "F1"), (6, "V"), (8, "U")]),
                ("f2.txt", &[(2, "F2"), (6, "V"), (8, "U")]),
            ],
            &[("f2.txt", &[(2, "F2"), (3, "ADJ"), (6, "V"), (8, "U")])],
        ];
        let (_dir, repo, tip, oids) = run_repo("squash-after-old-run", &[b1, b2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(merge_tree_code(&repo, "cm-run").await, 1);
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in.as_ref(), Some(&oids[5]));
        // The squash is also its own run's first cover; one candidate pins that the
        // full-cover group comes first.
        assert_eq!(
            landed_search(&repo, &oids[6], &tip, WINDOW_CAP, 1).await,
            Some(oids[5].clone())
        );
    }

    /// The two full-cover commits are each also their own run's first cover; each is
    /// tried once, so the landing's first cover still fits under the cap.
    #[tokio::test]
    async fn duplicate_candidates_do_not_use_up_the_cap() {
        let b1: FileEdits = &[("f1.txt", &[(2, "F1")])];
        let b2: FileEdits = &[("f2.txt", &[(2, "F2")])];
        let main: [FileEdits; 7] = [
            &[("f1.txt", &[(8, "N1")]), ("f2.txt", &[(8, "N1")])],
            &[("g.txt", &[(1, "g1")])],
            &[
                ("f1.txt", &[(6, "N2"), (8, "N1")]),
                ("f2.txt", &[(6, "N2"), (8, "N1")]),
            ],
            &[("g.txt", &[(1, "g2")])],
            &[("f1.txt", &[(2, "F1"), (6, "N2"), (8, "N1")])],
            &[("f2.txt", &[(2, "F2"), (6, "N2"), (8, "N1")])],
            &[("f2.txt", &[(2, "F2"), (3, "ADJ"), (6, "N2"), (8, "N1")])],
        ];
        let (_dir, repo, _, oids) = run_repo("duplicate-candidates", &[b1, b2], &main).await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }

        assert_eq!(merge_tree_code(&repo, "cm-run").await, 1);
        let got = check(&repo, "cm-run").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in.as_ref(), Some(&oids[5]));
    }

    /// A window one commit past the cap keeps the tip verdict rather than search part
    /// of it.
    #[tokio::test]
    async fn a_window_past_the_cap_is_not_searched() {
        let (dir, repo) = setup_repo("window-cap").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f.txt", "l1\nl2\nl3\nl4\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-window"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nl3\nl4\n", "edit l2").await;
        let tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "main"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nl3\nl4\n", "squashed").await;
        let squash = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nL3\nl4\n", "edit l3").await;
        let base = rev(&repo, "HEAD").await;

        let search = |cap| landed_search(&repo, &base, &tip, cap, CANDIDATE_CAP);
        assert_eq!(search(2).await, Some(squash));
        assert_eq!(search(1).await, None);
    }

    /// Empty-change commits (no names after their header) at both ends and inside the
    /// window, and a path with a space, must not desynchronize the record stream.
    #[tokio::test]
    async fn landed_search_reads_past_empty_commits_and_spaced_paths() {
        let (dir, repo) = setup_repo("framing").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "f.txt", "l1\nl2\nl3\nl4\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-framing"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nl3\nl4\n", "edit l2").await;
        commit_file(&repo, dir.path(), "s p.txt", "spaced\n", "spaced").await;
        git(&repo, &["checkout", "main"]).await;
        let empty = |msg: &'static str| {
            let repo = repo.clone();
            async move { git(&repo, &["commit", "--allow-empty", "-m", msg]).await }
        };
        empty("oldest empty").await;
        git(&repo, &["merge", "--squash", "cm-framing"]).await;
        git(&repo, &["commit", "-m", "squashed"]).await;
        let squash = rev(&repo, "HEAD").await;
        empty("inner empty").await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nL3\nl4\n", "edit l3").await;
        empty("newest empty").await;

        assert_eq!(merge_tree_code(&repo, "cm-framing").await, 1);
        let got = check(&repo, "cm-framing").await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert_eq!(got.landed_in, Some(squash));
    }

    #[test]
    fn parse_window_reads_records_and_refuses_forged_headers() {
        let (c1, t1) = ("1".repeat(40), "2".repeat(40));
        let (c2, t2) = ("3".repeat(64), "4".repeat(64));
        let stream = format!("\x01{c1} {t1}\0\nf.txt\0s p.txt\0\x01{c2} {t2}\0");
        let got = parse_window(stream.as_bytes()).expect("a readable stream");
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].oid, got[0].tree), (c1.as_str(), t1.as_str()));
        assert_eq!(got[0].paths, vec![&b"f.txt"[..], &b"s p.txt"[..]]);
        assert_eq!((got[1].oid, got[1].tree), (c2.as_str(), t2.as_str()));
        assert!(got[1].paths.is_empty());
        assert_eq!(parse_window(b"").map(|w| w.len()), Some(0));
        for malformed in [
            format!("\x01{c1} {t1}\0\nf.txt\0\x01evil path\0"),
            format!("\x01{c1} {t1}\0\nf.txt\0\x01{c2}\0"),
            format!("\x01{c1} {t1}\0f.txt\0"),
            "\nf.txt\0".to_string(),
            format!("\x01{c1} {t1}"),
            format!("\x01{} {t1}\0", "A".repeat(40)),
            format!("\x01{c1} {t1}\0\nf.txt\0\0"),
        ] {
            assert!(
                parse_window(malformed.as_bytes()).is_none(),
                "{malformed:?}"
            );
        }
    }

    #[test]
    fn changed_paths_refuses_an_empty_or_unreadable_set() {
        assert_eq!(
            changed_paths(b"a\0s p\0"),
            Some(vec![&b"a"[..], &b"s p"[..]])
        );
        assert_eq!(changed_paths(b""), None);
        assert_eq!(changed_paths(b"a"), None);
        assert_eq!(changed_paths(b"a\0\0"), None);
    }

    /// `cm-behind` edits l2; the pull request's head is a later commit reworking that
    /// line, so only the head's version can land. Returns (tip, head), main checked out.
    async fn behind_head_repo(marker: &str) -> (tempfile::TempDir, String, String, String) {
        let (dir, repo) = setup_repo(marker).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nl2\nl3\nl4\n", "lines").await;
        git(&repo, &["checkout", "-b", "cm-pr"]).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nL2\nl3\nl4\n", "edit l2").await;
        let tip = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nM2\nl3\nl4\n", "rework l2").await;
        let head = rev(&repo, "HEAD").await;
        set_ref(&repo, "refs/heads/cm-behind", &tip).await;
        git(&repo, &["checkout", "main"]).await;
        (dir, repo, tip, head)
    }

    /// Squash-lands the head's `f.txt` on main.
    async fn land_head(repo: &str, dir: &std::path::Path) -> String {
        commit_file(repo, dir, "f.txt", "l1\nM2\nl3\nl4\n", "squashed head").await;
        rev(repo, "HEAD").await
    }

    #[tokio::test]
    async fn behind_head_landed_in_history_reads_clean_via_the_head() {
        let (dir, repo, _tip, head) = behind_head_repo("head-history").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        let squash = land_head(&repo, dir.path()).await;
        commit_file(&repo, dir.path(), "f.txt", "l1\nM2\nL3\nl4\n", "edit l3").await;

        assert_eq!(
            check(&repo, "cm-behind").await.verdict,
            ContentVerdict::Changes
        );
        let got = check_with_head(&repo, "cm-behind", Some(&head)).await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert!(got.via_pr_head);
        assert_eq!(got.landed_in, Some(squash));
    }

    #[tokio::test]
    async fn behind_head_clean_at_the_base_tip_names_no_landing() {
        let (dir, repo, tip, head) = behind_head_repo("head-tip").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        land_head(&repo, dir.path()).await;

        let got = check_with_head(&repo, "cm-behind", Some(&head)).await;
        assert_eq!(got.verdict, ContentVerdict::Clean);
        assert!(got.via_pr_head);
        assert_eq!(got.landed_in, None);
        assert_eq!(got.head_sha, Some(tip));
        let short = check_with_head(&repo, "cm-behind", Some(&head[..12])).await;
        assert_eq!(
            (short.verdict, short.via_pr_head),
            (ContentVerdict::Clean, true)
        );
    }

    #[tokio::test]
    async fn behind_unlanded_head_reads_changes() {
        let (dir, repo, _tip, head) = behind_head_repo("head-unlanded").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        commit_file(&repo, dir.path(), "g.txt", "g\n", "moves on").await;

        let got = check_with_head(&repo, "cm-behind", Some(&head)).await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!((got.landed_in, got.via_pr_head), (None, false));
    }

    /// The head is a sibling of the tip, not a descendant: it would read clean, but it
    /// says nothing about the tip's own change.
    #[tokio::test]
    async fn a_head_the_tip_diverged_from_is_ignored() {
        let (dir, repo, tip, head) = behind_head_repo("head-diverged").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        let parent = rev(&repo, &format!("{tip}~1")).await;
        let diverged = commit_on(&repo, &head, &[&parent], "sibling").await;
        land_head(&repo, dir.path()).await;
        set_ref(&repo, "refs/heads/cm-diverged", &diverged).await;

        assert_eq!(
            check(&repo, "cm-diverged").await.verdict,
            ContentVerdict::Clean
        );
        let got = check_with_head(&repo, "cm-behind", Some(&diverged)).await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert!(!got.via_pr_head);
    }

    /// A tag named like the hint's prefix makes rev-parse answer the tag's target, a
    /// commit that would clear; its oid doesn't extend the hint, so the hint is ignored.
    #[tokio::test]
    async fn a_hint_shadowed_by_a_same_named_ref_is_ignored() {
        let (dir, repo, tip, head) = behind_head_repo("head-shadow").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        land_head(&repo, dir.path()).await;
        let decoy = commit_on(&repo, &head, &[&tip], "same tree, another commit").await;
        let prefix = &head[..12];
        assert!(!decoy.starts_with(prefix));
        git(&repo, &["tag", prefix, &decoy]).await;

        assert_eq!(rev(&repo, &format!("{prefix}^{{commit}}")).await, decoy);
        let used = check_with_head(&repo, "cm-behind", Some(&decoy)).await;
        assert_eq!(
            (used.verdict, used.via_pr_head),
            (ContentVerdict::Clean, true)
        );
        let got = check_with_head(&repo, "cm-behind", Some(prefix)).await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert!(!got.via_pr_head);
    }

    /// Hints that are malformed (dropped before any spawn), unresolvable, or the tip
    /// itself all leave the verdict as it was, never an error.
    #[tokio::test]
    async fn unusable_hints_leave_the_verdict_unchanged() {
        let (dir, repo, tip, head) = behind_head_repo("head-forms").await;
        if skip_for_inherited_merge_keys(&repo).await {
            return;
        }
        land_head(&repo, dir.path()).await;
        let hints = [
            "g".repeat(40),
            head[..6].to_string(),
            format!("{head}{}", "0".repeat(25)),
            head.to_uppercase(),
            "main".to_string(),
            "-x".to_string(),
            "a".repeat(64),
            "0".repeat(40),
            tip.clone(),
        ];
        for hint in &hints {
            let got = check_with_head(&repo, "cm-behind", Some(hint)).await;
            assert_eq!(got.verdict, ContentVerdict::Changes, "{hint}");
            assert!(!got.via_pr_head, "{hint}");
        }
    }

    #[test]
    fn headers_must_be_exactly_the_rev_list_window() {
        fn window<'a>(oids: &[&'a str]) -> Vec<WindowCommit<'a>> {
            oids.iter()
                .map(|&oid| WindowCommit {
                    oid,
                    tree: oid,
                    paths: Vec::new(),
                })
                .collect()
        }
        let (c1, c2, t) = ("1".repeat(40), "2".repeat(40), "f".repeat(40));
        let listed = format!("{c1}\n{c2}\n");
        assert!(headers_match(&window(&[&c1, &c2]), &listed));
        assert!(headers_match(&window(&[]), ""));
        // A forged header adds a record, reorders, or replaces one: all refused.
        assert!(!headers_match(&window(&[&c1, &t, &c2]), &listed));
        assert!(!headers_match(&window(&[&c2, &c1]), &listed));
        assert!(!headers_match(&window(&[&c1]), &listed));
        assert!(!headers_match(&window(&[&c1, &t]), &listed));
    }

    /// A base commit carries paths that make the log stream forge a header naming
    /// the branch tip itself, with the following path as its first name: the parser
    /// reads a candidate that would clear, and only the rev-list cross-check refuses it.
    /// Built with mktree, since no checkout filesystem needs to hold those names.
    #[tokio::test]
    async fn a_path_forging_a_window_header_is_refused() {
        let (dir, repo) = setup_repo("forged-header").await;
        git(&repo, &["checkout", "-b", "cm-forged"]).await;
        commit_file(&repo, dir.path(), "s.txt", "unlanded\n", "branch work").await;
        let tip = rev(&repo, "HEAD").await;
        let tip_tree = rev(&repo, "HEAD^{tree}").await;
        git(&repo, &["checkout", "main"]).await;
        let main = rev(&repo, "refs/heads/main").await;

        let blob = run_git_raw_input_bytes(
            Some(&repo),
            &["hash-object", "-w", "--stdin"],
            Some(b"x\n"),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .trim()
        .to_string();
        let mut entries = run_git_raw(Some(&repo), &["ls-tree", "-z", &main], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout;
        // Byte order: the decoy name comes first (so the forged one isn't led by
        // `\n`), then the forged header, then the forged header's first name.
        for name in [
            "\x01!".to_string(),
            format!("\x01{tip} {tip_tree}"),
            "\ns.txt".to_string(),
        ] {
            entries.extend(format!("100644 blob {blob}\t{name}\0").into_bytes());
        }
        let tree = run_git_raw_input_bytes(
            Some(&repo),
            &["mktree", "-z"],
            Some(&entries),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(tree.code, 0, "{}", tree.stderr);
        let tree = tree.stdout_lossy().trim().to_string();
        let forged = git(
            &repo,
            &["commit-tree", &tree, "-p", &main, "-m", "forged names"],
        )
        .await
        .trim()
        .to_string();
        set_ref(&repo, "refs/heads/main", &forged).await;

        // Premise: the parser alone reads the forged record, a candidate that clears.
        let log = run_git_raw(
            Some(&repo),
            &[
                "log",
                "--first-parent",
                "--diff-merges=first-parent",
                "--no-renames",
                "--name-only",
                "-z",
                "--format=%x01%H %T",
                &forged,
                "--not",
                &main,
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let window = parse_window(&log.stdout).expect("the forged stream parses");
        let oids: Vec<&str> = window.iter().map(|c| c.oid).collect();
        assert_eq!(oids, [forged.as_str(), tip.as_str()]);
        assert_eq!(window[1].paths, vec![&b"s.txt"[..]]);
        assert_eq!(guarded_at(&repo, &tip, &tip).await, ContentVerdict::Clean);

        let got = check(&repo, "cm-forged").await;
        assert_eq!(got.verdict, ContentVerdict::Changes);
        assert_eq!(got.landed_in, None);
    }
}
