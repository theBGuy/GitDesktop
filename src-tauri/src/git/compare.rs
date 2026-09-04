use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::diff::{parse_numstat_z, truncate_at_char_boundary};
use crate::git::history::{parse_commit_log, LOG_FORMAT};
use crate::git::runner::{
    run_git, run_git_raw, try_acquire_repo_lock, DEFAULT_TIMEOUT, NETWORK_TIMEOUT,
    WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{CommitSummary, DiffStatEntry, FileDiff, StagedDiff};
use crate::state::AppState;

/// Commits that distinguish two branches, from the current branch's point of
/// view: `ahead` are on `compare` but not `base`, `behind` are on `base` but
/// not `compare`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchComparison {
    pub ahead: Vec<CommitSummary>,
    pub behind: Vec<CommitSummary>,
}

/// A ref placed before `--` could be read as an option; reject the obvious
/// injection vectors. Real branch names (incl. `feature/x`) pass fine.
fn validate_ref(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') || name.contains("..") {
        return Err(AppError::InvalidArgument(format!("invalid branch: {name}")));
    }
    Ok(())
}

async fn log_range(repo_path: &str, range: &str) -> AppResult<Vec<CommitSummary>> {
    let out = run_git(
        Some(repo_path),
        &["log", LOG_FORMAT, range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_commit_log(&out.stdout_lossy()))
}

/// Commits unique to each side of `base`/`compare`. `ahead` (compare not in
/// base) is what a PR from `compare` into `base` would introduce; `behind`
/// (base not in compare) is what `compare` is missing.
#[tauri::command]
pub async fn git_compare_branches(
    repo_path: String,
    base: String,
    compare: String,
) -> AppResult<BranchComparison> {
    validate_ref(&base)?;
    validate_ref(&compare)?;
    let ahead = log_range(&repo_path, &format!("{base}..{compare}")).await?;
    let behind = log_range(&repo_path, &format!("{compare}..{base}")).await?;
    Ok(BranchComparison { ahead, behind })
}

/// Files that differ between the merge base of `base`/`compare` and `compare`
/// — i.e. the net change `compare` introduces relative to `base` (the
/// three-dot diff, the same set a PR would show).
#[tauri::command]
pub async fn git_branch_diff_files(
    repo_path: String,
    base: String,
    compare: String,
) -> AppResult<Vec<DiffStatEntry>> {
    validate_ref(&base)?;
    validate_ref(&compare)?;
    let out = run_git(
        Some(&repo_path),
        &[
            "diff",
            "--numstat",
            "-z",
            &format!("{base}...{compare}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_numstat_z(&out.stdout_lossy()))
}

/// Both refs resolved to SHAs in ONE spawn, so the AI-ignore filter's two passes
/// read the same trees — trees are immutable once named. Only a caller whose
/// patterns make filtering certain pays for the spawn; an inert list keeps the
/// ref names and rechecks instead, since it still reaches two passes when a
/// changed name is unreadable.
///
/// `^{commit}` peels an annotated tag to its commit, and turns a multi-line rev
/// expansion (`HEAD^!`, `HEAD^@`) into a git error rather than an argument whose
/// line count silently misaligns with the two SHAs expected below.
async fn pinned_range(repo_path: &str, base: &str, compare: &str) -> AppResult<String> {
    let base_rev = format!("{base}^{{commit}}");
    let compare_rev = format!("{compare}^{{commit}}");
    let out = run_git(
        Some(repo_path),
        &["rev-parse", &base_rev, &compare_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let shas: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let [base_sha, compare_sha] = shas[..] else {
        return Err(AppError::InvalidArgument(format!(
            "could not resolve {base} and {compare}"
        )));
    };
    let is_sha = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    if !is_sha(base_sha) || !is_sha(compare_sha) {
        return Err(AppError::InvalidArgument(format!(
            "could not resolve {base} and {compare}"
        )));
    }
    Ok(format!("{base_sha}...{compare_sha}"))
}

/// The full combined `base...compare` diff text plus its file summary, for
/// feeding AI PR description generation. `exclude` mirrors `git_staged_diff`:
/// AI-ignore patterns hide changed files and `excluded_files` reports how many.
/// Truncation deliberately differs — char boundary at a 1 MB default, not file
/// boundary at the AI budget.
#[tauri::command]
pub async fn git_branch_diff(
    repo_path: String,
    base: String,
    compare: String,
    max_bytes: Option<usize>,
    exclude: Option<Vec<String>>,
) -> AppResult<StagedDiff> {
    validate_ref(&base)?;
    validate_ref(&compare)?;
    let exclude = exclude.unwrap_or_default();

    let pinned = crate::git::ai_ignore::has_positive_pattern(&exclude);
    let range = if pinned {
        pinned_range(&repo_path, &base, &compare).await?
    } else {
        format!("{base}...{compare}")
    };

    // Pinned, the range names immutable trees and needs no recheck. Unpinned, the
    // two-pass flow is still reachable — an unreadable changed name takes it with
    // no patterns at all — and these refs can move between its passes, so that arm
    // rechecks. The fast path never reads the flag, so the common case is unchanged.
    let filtered = crate::git::ai_ignore::filtered_diff(
        &repo_path,
        &["diff", "--no-color", &range],
        &["diff", "--numstat", "-z", &range],
        &exclude,
        !pinned,
    )
    .await?;

    let (text, truncated) =
        truncate_at_char_boundary(filtered.text, max_bytes.unwrap_or(1_000_000));

    Ok(StagedDiff {
        text,
        truncated,
        files: filtered.files,
        excluded_files: filtered.excluded_files,
    })
}

#[tauri::command]
pub async fn git_branch_file_diff(
    repo_path: String,
    base: String,
    compare: String,
    file_path: String,
) -> AppResult<FileDiff> {
    validate_ref(&base)?;
    validate_ref(&compare)?;
    // Literal pathspec: a raw `[slug]`-style path pulls a glob-sibling's hunks
    // into this file's branch diff (measured).
    let spec = crate::git::pathspec::literal(&file_path);
    let out = run_git(
        Some(&repo_path),
        &[
            "diff",
            "--no-color",
            &format!("{base}...{compare}"),
            "--",
            &spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = truncate_at_char_boundary(text, 1_000_000);
    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

/// What `git_diff_between_refs` could determine about the relationship between
/// the two refs — drives how the frontend frames (or omits) the delta.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeltaReason {
    /// `from..to` is a clean append; `text`/`files` carry the delta.
    Ok,
    /// One or both refs aren't local objects (e.g. a remote SHA never fetched).
    Missing,
    /// `from` is not an ancestor of `to` — branch was rebased / force-pushed.
    Rewritten,
    /// Ancestry couldn't be determined (e.g. a shallow clone).
    Indeterminate,
}

/// The literal two-dot `from_ref..to_ref` diff ("what changed since"). Unlike
/// `git_branch_diff` (three-dot, merge-base relative), this is the exact delta
/// between two commits. Carries enough context for the caller to fall back
/// gracefully — `reason` says why the delta is absent — rather than surfacing a
/// raw git failure for what is soft, best-effort context.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaDiff {
    /// Both refs present locally and ancestry determinable.
    pub resolvable: bool,
    /// `from` is an ancestor of `to` (a clean append — the delta is meaningful).
    pub is_ancestor: bool,
    pub reason: DeltaReason,
    pub text: String,
    pub truncated: bool,
    pub files: Vec<DiffStatEntry>,
}

fn empty_delta(resolvable: bool, reason: DeltaReason) -> DeltaDiff {
    DeltaDiff {
        resolvable,
        is_ancestor: false,
        reason,
        text: String::new(),
        truncated: false,
        files: Vec::new(),
    }
}

#[tauri::command]
pub async fn git_diff_between_refs(
    repo_path: String,
    from_ref: String,
    to_ref: String,
    max_bytes: Option<usize>,
) -> AppResult<DeltaDiff> {
    validate_ref(&from_ref)?;
    validate_ref(&to_ref)?;

    // 1. Presence — both must be local objects. `cat-file -e` exits 0 iff the
    //    object resolves locally; a remote SHA never fetched exits non-zero.
    for r in [from_ref.as_str(), to_ref.as_str()] {
        let present = run_git_raw(Some(&repo_path), &["cat-file", "-e", r], DEFAULT_TIMEOUT)
            .await?
            .code
            == 0;
        if !present {
            return Ok(empty_delta(false, DeltaReason::Missing));
        }
    }

    // 2. Ancestry — exit 0 = ancestor (clean append), 1 = not (rebase/force-push),
    //    anything else (e.g. 128 on a shallow clone) = couldn't determine. Only a
    //    definite exit-1 means the history was actually rewritten, which is why
    //    "rewritten" and "indeterminate" are distinct.
    let anc = run_git_raw(
        Some(&repo_path),
        &["merge-base", "--is-ancestor", &from_ref, &to_ref],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match anc.code {
        0 => {}
        1 => return Ok(empty_delta(true, DeltaReason::Rewritten)),
        _ => return Ok(empty_delta(false, DeltaReason::Indeterminate)),
    }

    // 3. The delta itself — two-dot, so genuinely "what changed from..to".
    let range = format!("{from_ref}..{to_ref}");
    let text_out = run_git(
        Some(&repo_path),
        &["diff", "--no-color", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let (text, truncated) =
        truncate_at_char_boundary(text_out.stdout_lossy(), max_bytes.unwrap_or(1_000_000));
    let files_out = run_git(
        Some(&repo_path),
        &["diff", "--numstat", "-z", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(DeltaDiff {
        resolvable: true,
        is_ancestor: true,
        reason: DeltaReason::Ok,
        text,
        truncated,
        files: parse_numstat_z(&files_out.stdout_lossy()),
    })
}

/// Current tip SHA of each requested local branch — one `for-each-ref` call,
/// so watching N open local PRs' heads for new commits is a single git
/// invocation. Branches that don't exist are simply absent from the map.
#[tauri::command]
pub async fn git_branch_tips(
    repo_path: String,
    branches: Vec<String>,
) -> AppResult<std::collections::HashMap<String, String>> {
    let wanted: std::collections::HashSet<&str> =
        branches.iter().map(String::as_str).collect();
    let out = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
            "refs/heads/",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut map = std::collections::HashMap::new();
    for line in out.stdout_lossy().lines() {
        if let Some((name, sha)) = line.split_once(' ') {
            if wanted.contains(name) {
                map.insert(name.to_string(), sha.to_string());
            }
        }
    }
    Ok(map)
}

/// Basename of the single review worktree each repo reuses across reviews.
const PERSISTENT_REVIEW_DIR: &str = "gd-review-persistent";

/// In-process test override for the persistent review worktree's PARENT dir,
/// consulted by [`persistent_review_path`] before the real app-data resolution
/// (mirrors [`crate::git::update_marker`]'s; never process env, which races
/// parallel tests' env reads).
#[cfg(test)]
static TEST_ROOT_DIR: std::sync::Mutex<Option<std::path::PathBuf>> = std::sync::Mutex::new(None);

/// Serializes the tests that install [`TEST_ROOT_DIR`], since the override is
/// process-wide. Test-only.
#[cfg(test)]
static TEST_ROOT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Installs (or clears) the in-process override, returning the previous value so a
/// caller can restore it. Test-only.
#[cfg(test)]
fn swap_test_root_dir(dir: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    let mut slot = TEST_ROOT_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, dir)
}

/// Takes the serializing guard for the process-wide root override. Test-only.
#[cfg(test)]
fn test_root_lock() -> std::sync::MutexGuard<'static, ()> {
    TEST_ROOT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Points the persistent review root at `dir` for as long as it is held, restoring
/// the prior override on drop — panics included, so a failing test cannot leave one
/// standing for whichever test is next through the lock. Test-only.
#[cfg(test)]
struct TestRootOverride(Option<std::path::PathBuf>);

#[cfg(test)]
impl TestRootOverride {
    fn set(dir: &std::path::Path) -> Self {
        Self(swap_test_root_dir(Some(dir.to_path_buf())))
    }
}

#[cfg(test)]
impl Drop for TestRootOverride {
    fn drop(&mut self) {
        swap_test_root_dir(self.0.take());
    }
}

/// This repo's reused review worktree, or `None` when no root resolves — in which
/// case the caller mints an ephemeral one rather than failing a review.
///
/// Keyed by repo IDENTITY (the common git dir), so every checkout of a repository —
/// the main one and each linked worktree — shares a single warm review copy instead
/// of minting one apiece.
///
/// The app-data worktrees root is the required placement: `is_session_worktree`'s
/// app-data arm hides the checkout from every user-facing worktree surface, the
/// OS-temp husk sweeper never scans app data, and [`is_review_worktree_temp_path`]
/// still refuses it — so `git_remove_worktree`'s `remove_dir_all` fallback can
/// never reach it either.
///
/// Under `cfg(test)` an installed override is the ONLY resolution: with none, this
/// answers `None` so a test neither reads nor writes the developer's real app data.
async fn persistent_review_path(repo_path: &str) -> Option<std::path::PathBuf> {
    #[cfg(test)]
    {
        let _ = repo_path;
        TEST_ROOT_DIR
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .map(|root| root.join(PERSISTENT_REVIEW_DIR))
    }
    #[cfg(not(test))]
    {
        let identity = crate::git::repo::repo_identity(repo_path).await;
        crate::git::ops::identity_worktree_root_dir(&identity)
            .ok()
            .map(|root| root.join(PERSISTENT_REVIEW_DIR))
    }
}

/// The sidecar whose OS lock claims the review worktree at `dir`, named for it and
/// placed BESIDE it — inside the directory it would be destroyed by the demolish
/// that precedes a rebuild, and the claim has to outlive that.
fn persistent_review_lock_path(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let name = dir.file_name()?.to_str()?;
    Some(dir.with_file_name(format!("{name}.lock")))
}

/// The persistent review worktrees THIS process holds, keyed by normalized path with
/// the locked sidecar handle as the value — the map owns the handles, the OS lock
/// does the excluding. A dev build beside a release build resolves the same app-data
/// path, so the claim has to be visible across processes; on a crash the OS drops the
/// lock, which is what makes a leaked claim self-healing.
static REVIEW_WORKTREE_CLAIMS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::fs::File>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Claims the persistent worktree at `dir` for one review. `false` when another
/// review holds it — in this process or another — or when the sidecar is unusable,
/// in which case the caller mints an ephemeral worktree instead.
fn try_claim_review_worktree(dir: &std::path::Path) -> bool {
    let Some(lock_path) = persistent_review_lock_path(dir) else {
        return false;
    };
    let Some(parent) = lock_path.parent() else {
        return false;
    };
    let key = crate::git::worktree::normalize_wt_path(&dir.to_string_lossy());
    let mut claims = REVIEW_WORKTREE_CLAIMS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if claims.contains_key(&key) {
        return false;
    }
    if std::fs::create_dir_all(parent).is_err() {
        return false;
    }
    // `create`, never `create_new`: the sidecar outlives every claim, so a leftover
    // from an earlier review has to be re-lockable rather than fatal. No truncate —
    // the file's CONTENT is nothing; its lock is the whole signal.
    let Ok(file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    else {
        return false;
    };
    if file.try_lock().is_err() {
        return false;
    }
    claims.insert(key, file);
    true
}

/// Drops this process's claim on `path`, releasing the OS lock. `true` when a claim
/// was actually held — the authoritative answer for a release, since it needs no
/// path resolution to succeed.
fn release_review_worktree(path: &str) -> bool {
    let key = crate::git::worktree::normalize_wt_path(path);
    REVIEW_WORKTREE_CLAIMS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&key)
        .is_some()
}

/// Whether `path` is exactly this repo's persistent review worktree. Normalized on
/// both sides: git prints forward slashes while the app carries native separators.
async fn is_persistent_review_path(repo_path: &str, path: &str) -> bool {
    let Some(persistent) = persistent_review_path(repo_path).await else {
        return false;
    };
    crate::git::worktree::normalize_wt_path(&persistent.to_string_lossy())
        == crate::git::worktree::normalize_wt_path(path)
}

/// Re-points an existing persistent review worktree at `sha`. `false` when it is
/// absent, is no longer a worktree, the forcing checkout failed, or the tree
/// could not be cleaned — the caller then rebuilds it.
///
/// The checkout runs UNCONDITIONALLY, even when HEAD already names `sha`: only a
/// forcing checkout restores a tracked file a previous run left modified, and a
/// review that reads content the PR does not contain is worse than a redundant
/// near-free checkout. `checkout --detach`, never `reset --hard`: a reset would move
/// a branch if HEAD ever ended up attached here, while a detaching checkout cannot
/// move a ref.
async fn reuse_persistent_review_worktree(path_str: &str, sha: &str) -> bool {
    if !std::path::Path::new(path_str).exists() {
        return false;
    }
    let git_dir = run_git_raw(Some(path_str), &["rev-parse", "--git-dir"], DEFAULT_TIMEOUT).await;
    if !matches!(&git_dir, Ok(out) if out.code == 0) {
        return false;
    }
    // Same budget as the `add` — a big tree is the same order of work.
    let out = run_git_raw(
        Some(path_str),
        &["checkout", "--detach", "--force", sha],
        NETWORK_TIMEOUT,
    )
    .await;
    if !matches!(&out, Ok(out) if out.code == 0) {
        return false;
    }
    // The forcing checkout restores tracked files; this clears the untracked ones a
    // CLI agent may have strayed into the previous review's tree. `-ff`, not `-f`:
    // single-force SKIPS an untracked nested git repository (a repo the agent cloned
    // in) and still exits 0, so it would survive every reuse and contaminate later
    // reviews. A tree we failed to clean is one we cannot vouch for — refusing here
    // sends the caller to a full rebuild, which is the cheap safe direction.
    let cleaned = run_git_raw(Some(path_str), &["clean", "-ffdx", "-q"], WORKTREE_OP_TIMEOUT).await;
    matches!(&cleaned, Ok(out) if out.code == 0)
}

/// Tears down an unusable persistent review worktree so a fresh `worktree add` can
/// take its path. The unguarded delete is last and narrow — only a path that still
/// exists AND is exactly this repo's persistent review dir.
async fn demolish_persistent_review_worktree(repo_path: &str, path: &std::path::Path) {
    let path_str = path.to_string_lossy().into_owned();
    let _ = run_git_raw(
        Some(repo_path),
        &["worktree", "remove", "--force", &path_str],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    if path.exists() && is_persistent_review_path(repo_path, &path_str).await {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Brings this repo's persistent review worktree to `sha`, rebuilding it when it is
/// missing or unusable. `false` ⇒ the caller falls back to an ephemeral mint.
///
/// Only the rebuild takes the worktree-admin domain — `worktree add`/`remove`/`prune`
/// write the shared registry a branch update also writes. The re-point above stays
/// outside it: `checkout` in our own detached checkout is working-tree work on a tree
/// nothing else owns. A busy domain answers `false` rather than queueing, so a review
/// never waits behind a multi-minute removal.
async fn prepare_persistent_review_worktree(
    state: &AppState,
    repo_path: &str,
    path: &std::path::Path,
    sha: &str,
) -> bool {
    let path_str = path.to_string_lossy().into_owned();
    if reuse_persistent_review_worktree(&path_str, sha).await {
        return true;
    }
    let domain = state.worktree_admin_lock(repo_path).await;
    // Lock-free runners only from here down — the domain is not reentrant.
    let Some(_admin) = try_acquire_repo_lock(&domain, "a worktree operation") else {
        return false;
    };
    demolish_persistent_review_worktree(repo_path, path).await;
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    matches!(
        run_git_raw(
            Some(repo_path),
            &["worktree", "add", "--detach", &path_str, sha],
            NETWORK_TIMEOUT,
        )
        .await,
        Ok(out) if out.code == 0
    )
}

/// A throwaway detached worktree in the OS temp dir, deleted whole by
/// `git_remove_worktree`. The fallback whenever the persistent one is unavailable
/// or already hosting a review.
async fn ephemeral_review_worktree(repo_path: &str, sha: &str) -> AppResult<Option<String>> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let short = &sha[..sha.len().min(8)];
    let path = std::env::temp_dir().join(format!("gd-review-{short}-{nanos}"));
    let path_str = path.to_string_lossy().into_owned();
    let out = run_git_raw(
        Some(repo_path),
        &["worktree", "add", "--detach", &path_str, sha],
        NETWORK_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(path_str))
}

/// Hands a repo-aware CLI review a DETACHED checkout of `sha`, so it reads the PR
/// head's files without moving the user's active branch. One worktree per repository
/// — shared by all its checkouts — is reused across reviews: a later run re-points it
/// with `checkout --detach --force`, which rewrites only the files that differ. A
/// review that finds it claimed gets a throwaway OS-temp mint instead. Returns `None`
/// when a worktree isn't needed or possible — the repo is already on that commit (its
/// own working tree matches), the object isn't local (an un-fetched remote PR), or
/// both checkouts fail — so the caller falls back to the repo root. Best-effort:
/// never the source of a review failure.
///
/// The claim taken here is released by `git_remove_worktree`, which the caller runs
/// when the review settles.
#[tauri::command]
pub async fn git_review_worktree(
    state: State<'_, AppState>,
    repo_path: String,
    sha: String,
) -> AppResult<Option<String>> {
    git_review_worktree_core(state.inner(), repo_path, sha).await
}

/// [`git_review_worktree`] over a bare state, so tests drive it without a Tauri app.
async fn git_review_worktree_core(
    state: &AppState,
    repo_path: String,
    sha: String,
) -> AppResult<Option<String>> {
    validate_ref(&sha)?;
    // Already on this commit → the repo's own working tree already matches.
    let head = run_git_raw(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    if head.code == 0 && head.stdout_lossy().trim() == sha {
        return Ok(None);
    }
    // The commit must be a local object (a remote PR may not be fetched).
    let present = run_git_raw(Some(&repo_path), &["cat-file", "-e", &sha], DEFAULT_TIMEOUT)
        .await?
        .code
        == 0;
    if !present {
        return Ok(None);
    }
    if let Some(persistent) = persistent_review_path(&repo_path).await {
        let path_str = persistent.to_string_lossy().into_owned();
        if try_claim_review_worktree(&persistent) {
            if prepare_persistent_review_worktree(state, &repo_path, &persistent, &sha).await {
                return Ok(Some(path_str));
            }
            release_review_worktree(&path_str);
        }
    }
    ephemeral_review_worktree(&repo_path, &sha).await
}

/// Whether `path` is a `git_review_worktree`-shaped review temp dir: DIRECTLY under
/// the OS temp dir with a basename starting `gd-review-`. This is the guard for the
/// `remove_dir_all` fallback in `git_remove_worktree` — git's own `worktree remove`
/// refuses a non-worktree path, so that fallback is the only unbounded-delete risk
/// and must never widen the command into an arbitrary recursive delete. Comparison
/// is component-wise (trailing-separator safe) and case-insensitive on the file
/// name, to match Windows.
fn is_review_worktree_temp_path(path: &std::path::Path) -> bool {
    let temp = std::env::temp_dir();
    // The path's parent must be exactly the temp dir. Compare component sequences
    // rather than raw strings so a trailing separator on either side can't matter.
    let Some(parent) = path.parent() else {
        return false;
    };
    if parent.components().collect::<Vec<_>>() != temp.components().collect::<Vec<_>>() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    // Windows temp paths are case-insensitive; a lowercased compare is safe here
    // because the prefix is pure ASCII.
    name.to_ascii_lowercase().starts_with("gd-review-")
}

/// Releases the review workspace `git_review_worktree` handed out. The persistent
/// per-repo worktree is only unclaimed — its checkout and registration stay in place
/// for the next review to re-point — while an ephemeral mint is removed and its
/// administrative entry pruned. Best-effort and idempotent.
#[tauri::command]
pub async fn git_remove_worktree(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
) -> AppResult<()> {
    git_remove_worktree_core(state.inner(), repo_path, worktree_path).await
}

/// [`git_remove_worktree`] over a bare state, so tests drive it without a Tauri app.
async fn git_remove_worktree_core(
    state: &AppState,
    repo_path: String,
    worktree_path: String,
) -> AppResult<()> {
    // A held claim is the authoritative answer: this process handed the path out, so
    // releasing it needs no path resolution that a git failure could spoil.
    if release_review_worktree(&worktree_path) {
        return Ok(());
    }
    // Unclaimed but still ours — a claim lost to a restart. Keep the checkout anyway;
    // the next review re-points it.
    if is_persistent_review_path(&repo_path, &worktree_path).await {
        return Ok(());
    }
    // Admin work on the shared registry: serialized against a branch update's own
    // add/remove, with the same bounded wait every other worktree command takes.
    let removal = crate::git::runner::run_git_worktree_admin(
        state,
        &repo_path,
        &["worktree", "remove", "--force", &worktree_path],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    // Skipped when the removal already read `Busy`: the same held domain would charge
    // this prune a second full bounded wait, and the lock-free arm below re-runs both.
    if !matches!(removal, Err(AppError::Busy { .. })) {
        let _ = crate::git::runner::run_git_worktree_admin(
            state,
            &repo_path,
            &["worktree", "prune"],
            DEFAULT_TIMEOUT,
        )
        .await;
    }
    // A `Busy` removal never reached git — the domain was held past the bounded wait.
    // Retry WITHOUT the domain rather than leave the mint registered: nothing else
    // would ever reclaim it (the husk sweep takes only EMPTY dirs, prune only absent
    // ones), and an OS-temp worktree passes every session filter, so it would render
    // as one of the user's own worktrees forever. A lock-free run cannot report Busy.
    if matches!(removal, Err(AppError::Busy { .. })) {
        let _ = run_git_raw(
            Some(&repo_path),
            &["worktree", "remove", "--force", &worktree_path],
            WORKTREE_OP_TIMEOUT,
        )
        .await;
        let _ = run_git_raw(Some(&repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    }
    // `git worktree remove` deletes the directory itself, but on Windows that
    // recursive delete can lose a handle race (antivirus/indexer still holding the
    // dir) and leave an EMPTY husk behind — and the results above are discarded, so
    // it would leak in %TEMP% forever. Finish the delete ourselves, best-effort with
    // a short backoff, GUARDED to the `gd-review-*` temp shape: an unguarded
    // `remove_dir_all` would turn this command into an arbitrary recursive-delete
    // primitive on any caller-supplied path. Off the guard, git-only baseline.
    if is_review_worktree_temp_path(std::path::Path::new(&worktree_path)) {
        for _ in 0..2 {
            if !std::path::Path::new(&worktree_path).exists() {
                break;
            }
            let _ = std::fs::remove_dir_all(&worktree_path);
            if !std::path::Path::new(&worktree_path).exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(75)).await;
        }
    }
    Ok(())
}

/// Sweep leaked empty `gd-review-*` worktree husks from the OS temp dir. A review
/// worktree lives its whole life NON-empty — populated by `worktree add`, deleted
/// whole by `git_remove_worktree` — so an *empty* one can only be a husk whose
/// delete lost the Windows handle race. That makes "empty" a sufficient exclusion,
/// unlike the paused `gd-resolve-*` worktrees which need a keep-list. Best-effort,
/// fire-and-forget on startup.
pub fn sweep_review_worktree_husks() {
    let _ = sweep_review_husks_in(&std::env::temp_dir());
}

/// The testable core of [`sweep_review_worktree_husks`], parameterized on the
/// directory so a unit test can drive a real fixture. Deletes only `gd-review-*`
/// entries that are EMPTY dirs: `remove_dir` HARD-FAILS on a non-empty dir, so it —
/// not the name filter — is the real TOCTOU-safe guard (a review that repopulates
/// between filter and delete is spared). Returns the husk count; an unlistable dir
/// is skipped, not an error.
fn sweep_review_husks_in(dir: &std::path::Path) -> std::io::Result<usize> {
    let mut removed = 0;
    // "Can't list it" ⇒ skip the whole sweep conservatively.
    let entries = std::fs::read_dir(dir)?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("gd-review-") {
            continue;
        }
        // NEVER remove_dir_all here: `remove_dir` refuses a non-empty dir, which is
        // exactly the guard that keeps a live review's populated worktree safe.
        if std::fs::remove_dir(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// How long a persistent review worktree may sit untouched before the startup sweep
/// reclaims its disk. Generous on purpose: a repo reviewed weekly keeps its warm
/// checkout, and the cost of being wrong is one slow review, not lost work.
const PERSISTENT_REVIEW_MAX_IDLE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Reclaim persistent review worktrees that no review has touched in a week — the
/// only lifecycle they have, since nothing prunes them per repo (one bounded
/// directory per repository, recreated on demand). Best-effort, fire-and-forget on
/// startup.
pub(crate) fn sweep_stale_persistent_review_worktrees() {
    let Some(data) = dirs::data_dir() else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // An unreadable clock authorizes no deletion at all.
    let Ok(now_ms) = i64::try_from(now) else {
        return;
    };
    let roots = data
        .join(crate::local_prs::APP_IDENTIFIER)
        .join("worktrees");
    let _ = sweep_stale_persistent_reviews_in(&roots, now_ms);
}

/// Whether the sidecar at `lock_path` shows NO live claim. SHARED like
/// `update_marker::probe_lock`, so two concurrent probes never read each other as a
/// holder. Every doubt — an unreadable file, a lock error — answers `false`: this
/// verdict authorizes a delete, so it fails toward leaving bytes on disk.
fn persistent_review_lock_is_free(lock_path: &std::path::Path) -> bool {
    match std::fs::File::open(lock_path) {
        // The probe's own shared hold is released when `file` closes at end of scope,
        // which also has to happen before any caller unlinks it on Windows.
        Ok(file) => matches!(file.try_lock_shared(), Ok(())),
        // No sidecar at all: nothing can be holding a claim.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

/// The testable core of [`sweep_stale_persistent_review_worktrees`], over an explicit
/// worktrees root so a test never scans real app data. Only `<hash>/gd-review-persistent`
/// is ever considered — the exact basename, one level down — and only when its git
/// activity is older than [`PERSISTENT_REVIEW_MAX_IDLE_MS`] AND its sidecar carries no
/// live claim.
///
/// Age comes from git activity, falling back to the `.git` pointer file's mtime and
/// finally to the directory's own. Each fallback covers a shape that would otherwise
/// read unknown forever and could never age out: a checkout whose SOURCE REPO was
/// deleted has an unresolvable admin dir, and a bare wreck (a half-finished add, no
/// `.git` at all) answers neither probe. A live workspace answers from index/HEAD
/// first, and a mid-review checkout is spared by its claim regardless.
///
/// No git runs here: the source repo's stale registration is cleaned by its own
/// `prune_worktrees_if_free`, the same division every other app-data checkout uses.
/// Returns how many were reclaimed.
fn sweep_stale_persistent_reviews_in(
    worktrees_root: &std::path::Path,
    now_ms: i64,
) -> std::io::Result<usize> {
    let mut removed = 0;
    // "Can't list it" ⇒ skip the whole sweep conservatively.
    for entry in std::fs::read_dir(worktrees_root)?.flatten() {
        let dir = entry.path().join(PERSISTENT_REVIEW_DIR);
        if !dir.is_dir() {
            continue;
        }
        let Some(last_ms) = crate::git::worktree::worktree_last_activity_ms(&dir.to_string_lossy())
            .or_else(|| crate::git::worktree::file_mtime_ms(&dir.join(".git")))
            .or_else(|| crate::git::worktree::file_mtime_ms(&dir))
        else {
            continue;
        };
        if now_ms.saturating_sub(last_ms) < PERSISTENT_REVIEW_MAX_IDLE_MS {
            continue;
        }
        let Some(lock_path) = persistent_review_lock_path(&dir) else {
            continue;
        };
        if !persistent_review_lock_is_free(&lock_path) {
            continue;
        }
        if std::fs::remove_dir_all(&dir).is_ok() {
            let _ = std::fs::remove_file(&lock_path);
            removed += 1;
        }
    }
    Ok(removed)
}

/// Best-effort fetch of specific commit objects from `origin`, so a remote PR's
/// prior-review delta can be computed even when the PR was never checked out
/// (its head SHA isn't a local object). Returns whether the fetch succeeded;
/// never the source of a hard failure for the caller — a `false` (or error)
/// simply means "no delta" and the review falls back to a full pass. GitHub
/// permits fetching arbitrary reachable SHAs this way.
#[tauri::command]
pub async fn git_fetch_objects(repo_path: String, refs: Vec<String>) -> AppResult<bool> {
    for r in &refs {
        validate_ref(r)?;
    }
    if refs.is_empty() {
        return Ok(false);
    }
    // Short-circuit when every requested object is already local: this runs before
    // every repo-aware review worktree, and a PR already checked out (or fetched
    // earlier) needs no network round-trip. Any missing object falls through.
    if all_objects_present(&repo_path, &refs).await {
        return Ok(true);
    }
    let mut args: Vec<&str> = vec!["fetch", "--no-tags", "origin"];
    args.extend(refs.iter().map(String::as_str));
    let out = run_git_raw(Some(&repo_path), &args, NETWORK_TIMEOUT).await?;
    Ok(out.code == 0)
}

/// Whether every ref resolves to a commit object already in `repo_path` (no
/// network). Any spawn/timeout error or non-zero exit ⇒ `false`, so the caller
/// fetches — this only ever SKIPS a provably unnecessary fetch, never suppresses a
/// needed one.
///
/// One `rev-parse` spawn per ref: `rev-parse --verify` takes exactly one revision,
/// so it can't batch. If a multi-SHA caller appears, switch to one
/// `git cat-file --batch-check` process.
async fn all_objects_present(repo_path: &str, refs: &[String]) -> bool {
    for r in refs {
        let spec = format!("{r}^{{commit}}");
        match run_git_raw(
            Some(repo_path),
            &["rev-parse", "--verify", "--quiet", &spec],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Ok(out) if out.code == 0 => {}
            _ => return false,
        }
    }
    true
}

/// Default cap on matching lines returned by `git_grep_at_ref`.
const GREP_DEFAULT_MAX_HITS: u32 = 200;
/// Hard cap on total output bytes, so a pathological line (a minified bundle the
/// `-I` binary filter didn't catch) can't blow past the model's context.
const GREP_MAX_BYTES: usize = 100_000;

/// Search the repository at a given rev for a fixed string, returning matching
/// `path:line:content` lines — the repo-search tool an HTTP review model calls
/// against a PR head, with NO checkout/worktree (it greps the rev directly).
///
/// `git grep -I -n -F -m <max_hits> --no-color -e <pattern> <atRef>`: `-F` is
/// fixed-string (deliberately literal, not regex), `-I` skips binary files, and `-m`
/// caps results PER FILE so one pathological file (a minified bundle `-I` missed)
/// can't dominate the capture. The pattern goes through `-e`, so a leading `-` in it
/// is data, not an option.
///
/// `-m` (`--max-count`) landed in git 2.38; on an older git the switch is unknown and
/// git grep hard-fails, so [`run_grep`] retries once without it. Because `-m` is
/// per-file, the true total match count isn't recoverable — the truncation marker is
/// count-less.
///
/// Grepping a rev makes git prefix every hit with `<atRef>:`; we strip exactly that
/// known prefix, leaving path- and content-embedded colons intact.
#[tauri::command]
pub async fn git_grep_at_ref(
    repo_path: String,
    pattern: String,
    at_ref: String,
    max_hits: Option<u32>,
) -> AppResult<String> {
    validate_ref(&at_ref)?;
    if pattern.trim().is_empty() {
        return Err(AppError::InvalidArgument("empty search pattern".into()));
    }
    let max_hits = max_hits.unwrap_or(GREP_DEFAULT_MAX_HITS) as usize;

    let Some(stdout) = run_grep(&repo_path, &pattern, &at_ref, max_hits).await? else {
        // No match (git grep's documented exit 1 with empty output).
        return Ok(String::new());
    };

    let prefix = format!("{at_ref}:");
    let kept: Vec<String> = stdout
        .lines()
        .take(max_hits)
        // git prefixes each hit with `<atRef>:`; normalize to repo-relative.
        .map(|l| l.strip_prefix(&prefix).unwrap_or(l).to_string())
        .collect();
    // With `-m` the true total is unknowable, so the marker carries no count —
    // it only signals that more lines existed than we returned.
    let over = stdout.lines().count() > max_hits;

    let mut result = kept.join("\n");
    if over {
        result.push_str("\n[... additional matches truncated]");
    }

    // Byte hard-cap on top of the line cap, char-boundary safe.
    if result.len() > GREP_MAX_BYTES {
        let (head, _) = truncate_at_char_boundary(result, GREP_MAX_BYTES);
        result = format!("{head}\n[... output truncated at {GREP_MAX_BYTES} bytes]");
    }
    Ok(result)
}

/// Runs the fixed-string `git grep` at a rev: `Some(stdout)` on a match, `None` for
/// git's documented no-match (exit 1, empty output) — `run_git_raw` so exit 1 stays
/// a signal, not an error. Any OTHER non-zero is a real error, except an
/// unknown-option failure, which retries ONCE without `-m` (git < 2.38).
async fn run_grep(
    repo_path: &str,
    pattern: &str,
    at_ref: &str,
    max_hits: usize,
) -> AppResult<Option<String>> {
    let max_hits_arg = max_hits.to_string();
    let with_m = [
        "grep", "-I", "-n", "-F", "-m", &max_hits_arg, "--no-color", "-e", pattern, at_ref,
    ];
    let out = run_git_raw(Some(repo_path), &with_m, DEFAULT_TIMEOUT).await?;
    match out.code {
        0 => return Ok(Some(out.stdout_lossy())),
        1 if out.stdout.is_empty() => return Ok(None),
        _ if is_unknown_option(&out.stderr) => {} // fall through to the -m-less retry
        _ => {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            })
        }
    }

    // git < 2.38: retry without `-m`. Same args minus the `-m <n>` pair — output is
    // identical, just an uncapped capture (still trimmed by the caller's line/byte caps).
    let without_m = [
        "grep", "-I", "-n", "-F", "--no-color", "-e", pattern, at_ref,
    ];
    let out = run_git_raw(Some(repo_path), &without_m, DEFAULT_TIMEOUT).await?;
    match out.code {
        0 => Ok(Some(out.stdout_lossy())),
        1 if out.stdout.is_empty() => Ok(None),
        _ => Err(AppError::Git {
            code: out.code,
            stderr: out.stderr,
        }),
    }
}

/// Whether git's stderr indicates it rejected an unknown command-line option —
/// the signal that this git predates `-m`/`--max-count` (2.38). Matched
/// case-insensitively on git's phrasings ("unknown switch"/"unknown option") plus
/// the `usage: git grep` banner it prints on an option error.
fn is_unknown_option(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown switch")
        || lower.contains("unknown option")
        || lower.contains("usage: git grep")
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git_raw(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A locally-present SHA short-circuits `git_fetch_objects`: it returns true with
    /// NO remote configured (a fetch would fail), proving the network path was skipped.
    #[tokio::test]
    async fn fetch_objects_short_circuits_when_all_present() {
        let _base = tempfile::Builder::new()
            .prefix("gd-fetchobj-test-")
            .tempdir()
            .expect("create temp dir");
        let base = _base.path().to_path_buf();
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        let head = run(&repo_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        // No `origin` remote exists, so a real fetch would error/fail — a `true`
        // result can only mean the local-presence short-circuit fired.
        let ok = git_fetch_objects(repo_s.clone(), vec![head])
            .await
            .expect("present-object path never errors");
        assert!(ok, "a locally-present sha skips the fetch and reports success");

        // A never-seen sha is NOT local, so it falls through to the fetch, which fails
        // with no origin — returning false (not an error).
        let missing = "0".repeat(40);
        let ok = git_fetch_objects(repo_s, vec![missing])
            .await
            .expect("a failed fetch is Ok(false), not an error");
        assert!(!ok, "an absent object falls through to the (failing) fetch");
    }

    /// Seeds a fresh repo and returns `(base_guard, repo_path)`. The `TempDir`
    /// guard removes the base dir on Drop, so a panicking run cannot leak it.
    async fn seed_repo(tag: &str) -> (tempfile::TempDir, String) {
        let base = tempfile::Builder::new()
            .prefix(&format!("gd-{tag}-test-"))
            .tempdir()
            .expect("create temp dir");
        let repo = base.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        (base, repo_s)
    }

    /// The comparison shares History's log format + parser, so its rows carry the
    /// `%D` tag decorations rather than an empty list.
    #[tokio::test]
    async fn compare_branches_carries_tag_decorations() {
        let (_base, repo) = seed_repo("compare-tags").await;
        let root = std::path::Path::new(&repo);

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        // `git init` picks the default branch name from the host's config.
        let base_branch = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo, &["checkout", "-qb", "feature"]).await;
        std::fs::write(root.join("feature.txt"), "feature\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "feature work"]).await;

        run(&repo, &["checkout", "-q", &base_branch]).await;
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "base work"]).await;
        run(&repo, &["tag", "v1.0"]).await;

        let cmp = git_compare_branches(repo.clone(), base_branch, "feature".into())
            .await
            .unwrap();

        assert_eq!(cmp.ahead.len(), 1, "one commit on feature only");
        assert_eq!(cmp.behind.len(), 1, "one commit on the base branch only");
        assert_eq!(
            cmp.behind[0].tags,
            vec!["v1.0".to_string()],
            "a tagged commit reports its tag"
        );
        assert!(
            cmp.ahead[0].tags.is_empty(),
            "an untagged commit reports no tags"
        );
    }

    /// `exclude` hides matching files from BOTH the diff text and the file list, and
    /// `excluded_files` counts them; `None` (or only blank/`#` patterns) filters nothing.
    #[tokio::test]
    async fn branch_diff_applies_exclude_pathspecs() {
        let (_base, repo) = seed_repo("branchdiff-exclude").await;
        let root = std::path::Path::new(&repo);

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        let base_sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        // Six changed files covering the three AI-ignore pattern kinds — bare name,
        // glob, directory — the glob and directory cases each with a NESTED member.
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("tools")).unwrap();
        std::fs::create_dir_all(root.join("vendor").join("sub")).unwrap();
        std::fs::write(root.join("src").join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(root.join("notes.md"), "notes\n").unwrap();
        std::fs::write(root.join("package-lock.json"), "{\"lock\": 1}\n").unwrap();
        std::fs::write(root.join("tools").join("build.lock"), "locked\n").unwrap();
        std::fs::write(root.join("vendor").join("lib.txt"), "vendored\n").unwrap();
        std::fs::write(root.join("vendor").join("sub").join("x.txt"), "deep\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "work"]).await;

        // No excludes → every file present, nothing reported hidden.
        let all = git_branch_diff(repo.clone(), base_sha.clone(), "HEAD".into(), None, None)
            .await
            .unwrap();
        assert_eq!(all.files.len(), 6, "all six changed files are listed");
        assert!(all.text.contains("package-lock.json"));
        assert_eq!(all.excluded_files, 0);

        // Excluding one file drops it from both the text and the file list, and
        // the hidden count is the real difference for this range.
        let filtered = git_branch_diff(
            repo.clone(),
            base_sha.clone(),
            "HEAD".into(),
            None,
            Some(vec!["package-lock.json".into()]),
        )
        .await
        .unwrap();
        assert_eq!(filtered.files.len(), 5);
        assert!(
            !filtered.files.iter().any(|f| f.path.contains("package-lock")),
            "the excluded file is absent from the file list"
        );
        assert!(
            !filtered.text.contains("package-lock.json"),
            "the excluded file is absent from the diff text"
        );
        assert!(filtered.text.contains("src/a.rs"), "other files survive");
        assert_eq!(filtered.excluded_files, 1);

        // A GLOB pattern — `package-lock.json` survives, it doesn't end in `.lock`.
        let globbed = git_branch_diff(
            repo.clone(),
            base_sha.clone(),
            "HEAD".into(),
            None,
            Some(vec!["*.lock".into()]),
        )
        .await
        .unwrap();
        assert!(
            !globbed.files.iter().any(|f| f.path.ends_with(".lock")),
            "the nested .lock is hidden — pathspec `*` reaches into subdirectories"
        );
        assert!(!globbed.text.contains("tools/build.lock"));
        assert!(
            globbed.files.iter().any(|f| f.path == "package-lock.json"),
            "a non-matching lock-ish name survives"
        );
        assert_eq!(globbed.files.len(), 5);
        assert_eq!(globbed.excluded_files, 1);

        // A DIRECTORY pattern hides the whole subtree, nested files included.
        let dir = git_branch_diff(
            repo.clone(),
            base_sha.clone(),
            "HEAD".into(),
            None,
            Some(vec!["vendor/".into()]),
        )
        .await
        .unwrap();
        assert!(
            !dir.files.iter().any(|f| f.path.starts_with("vendor/")),
            "every file under the excluded directory is hidden, at any depth"
        );
        assert!(!dir.text.contains("vendor/sub/x.txt"));
        assert_eq!(dir.files.len(), 4);
        assert_eq!(dir.excluded_files, 2);

        // Blank and `#`-comment patterns are skipped, leaving no pathspec at all —
        // identical to the unfiltered call, including the zero count.
        let noop = git_branch_diff(
            repo.clone(),
            base_sha,
            "HEAD".into(),
            None,
            Some(vec!["   ".into(), "# a comment".into()]),
        )
        .await
        .unwrap();
        assert_eq!(noop.files.len(), 6);
        assert_eq!(noop.excluded_files, 0);
        assert_eq!(noop.text, all.text);
    }

    /// The diff pane discards a rendered body whose `file_path` doesn't match the
    /// path it asked for (that mismatch is how it detects a stale placeholder), so
    /// the echo must stay verbatim — including a `[slug]`-style name, which only
    /// survives because the pathspec is quoted literally.
    #[tokio::test]
    async fn branch_file_diff_echoes_the_requested_path() {
        let (_base, repo) = seed_repo("branchfilediff-echo").await;
        let root = std::path::Path::new(&repo);

        std::fs::create_dir_all(root.join("[slug]")).unwrap();
        std::fs::write(root.join("plain.txt"), "one\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        let base_sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        std::fs::write(root.join("plain.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\ntwo\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "work"]).await;

        for path in ["plain.txt", "[slug]/a.txt"] {
            let diff = git_branch_file_diff(
                repo.clone(),
                base_sha.clone(),
                "HEAD".into(),
                path.to_string(),
            )
            .await
            .unwrap();
            assert_eq!(diff.file_path, path);
            assert!(
                diff.text.contains("+two"),
                "no hunk for {path}: {}",
                diff.text
            );
        }
    }

    /// AI-ignore patterns are gitignore-style, so a bare NAME matches at any
    /// depth (not just the repo root), a bare DIRECTORY name hides that
    /// directory's contents wherever it sits, and a leading `/` anchors to the
    /// root instead of blanking the whole diff.
    #[tokio::test]
    async fn branch_diff_bare_name_matches_at_any_depth() {
        let (_base, repo) = seed_repo("branchdiff-anydepth").await;
        let root = std::path::Path::new(&repo);

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        let base_sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join("src").join("node_modules")).unwrap();
        std::fs::write(root.join("notes.md"), "root\n").unwrap();
        std::fs::write(root.join("docs").join("notes.md"), "nested\n").unwrap();
        std::fs::write(root.join("keep.txt"), "keep\n").unwrap();
        std::fs::write(root.join("src").join("node_modules").join("j.js"), "dep\n").unwrap();
        // `-f`: a user's GLOBAL excludes file may ignore node_modules.
        run(&repo, &["add", "-A", "-f"]).await;
        run(&repo, &["commit", "-qm", "work"]).await;

        let bare = git_branch_diff(
            repo.clone(),
            base_sha.clone(),
            "HEAD".into(),
            None,
            Some(vec!["notes.md".into()]),
        )
        .await
        .unwrap();
        assert!(
            !bare.files.iter().any(|f| f.path == "docs/notes.md"),
            "a bare name hides the NESTED copy, not just the root one"
        );
        assert!(!bare.files.iter().any(|f| f.path == "notes.md"));
        assert!(bare.files.iter().any(|f| f.path == "keep.txt"));
        assert_eq!(bare.excluded_files, 2);

        // A leading `/` anchors to the repo root — the nested copy survives, and
        // the diff is not silently emptied (git used to read it as an abs path).
        let anchored = git_branch_diff(
            repo.clone(),
            base_sha.clone(),
            "HEAD".into(),
            None,
            Some(vec!["/notes.md".into()]),
        )
        .await
        .unwrap();
        assert!(
            anchored.files.iter().any(|f| f.path == "docs/notes.md"),
            "the anchored pattern spares the nested copy"
        );
        assert!(!anchored.files.iter().any(|f| f.path == "notes.md"));
        assert_eq!(anchored.excluded_files, 1);

        // A bare DIRECTORY name (no trailing slash) hides its contents at depth.
        let dir = git_branch_diff(
            repo,
            base_sha,
            "HEAD".into(),
            None,
            Some(vec!["node_modules".into()]),
        )
        .await
        .unwrap();
        assert!(
            !dir.files.iter().any(|f| f.path.contains("node_modules")),
            "`node_modules` hides src/node_modules/j.js"
        );
        assert_eq!(dir.excluded_files, 1);
    }

    /// A match at a rev is found even after the working tree (and later commits)
    /// no longer contain the needle — grep reads the rev's tree, not the checkout.
    #[tokio::test]
    async fn grep_at_ref_reads_the_rev_not_the_worktree() {
        let (_base, repo) = seed_repo("grep-rev").await;

        std::fs::write(
            std::path::Path::new(&repo).join("a.txt"),
            "the SECRET_NEEDLE lives here\nplain line\n",
        )
        .unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "add needle"]).await;
        let sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        // Change the working tree so the needle is gone from disk (unstaged edit).
        std::fs::write(
            std::path::Path::new(&repo).join("a.txt"),
            "the needle is gone now\nplain line\n",
        )
        .unwrap();

        // Grep at the commit → still found (reads the committed tree).
        let hit = git_grep_at_ref(repo.clone(), "SECRET_NEEDLE".into(), sha.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            hit, "a.txt:1:the SECRET_NEEDLE lives here",
            "match found at the rev, ref-prefix stripped to repo-relative path"
        );

        // Commit the removal, then grep at HEAD → empty (needle no longer in tree).
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "remove needle"]).await;
        let gone = git_grep_at_ref(repo.clone(), "SECRET_NEEDLE".into(), "HEAD".into(), None)
            .await
            .unwrap();
        assert_eq!(gone, "", "no match at HEAD → Ok(empty), not an error");
    }

    /// The `<ref>:` prefix git prepends when grepping a rev is stripped, while
    /// colons embedded in the path/content are preserved.
    #[tokio::test]
    async fn grep_at_ref_strips_only_the_ref_prefix() {
        let (_base, repo) = seed_repo("grep-prefix").await;

        std::fs::write(
            std::path::Path::new(&repo).join("cfg.txt"),
            "endpoint: http://host:8080/path FINDME\n",
        )
        .unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;

        let hit = git_grep_at_ref(repo.clone(), "FINDME".into(), "HEAD".into(), None)
            .await
            .unwrap();
        // Only the leading `HEAD:` is gone; every content colon survives.
        assert_eq!(hit, "cfg.txt:1:endpoint: http://host:8080/path FINDME");
    }

    /// More returned lines than `max_hits` → the kept lines plus a count-less
    /// truncation marker (`-m` caps per file, so the true total isn't recoverable).
    /// The matches are spread across THREE files deliberately: with `-m` per-file, a
    /// single file with N matches would be capped by git itself and never overflow
    /// the caller's line cap. 3 files × 2 matches → 6 lines, trimmed by `take(2)`.
    #[tokio::test]
    async fn grep_at_ref_caps_hits_with_marker() {
        let (_base, repo) = seed_repo("grep-cap").await;

        // 2 matching lines in each of 3 files (a.txt, b.txt, c.txt).
        for name in ["a.txt", "b.txt", "c.txt"] {
            std::fs::write(
                std::path::Path::new(&repo).join(name),
                "hit MATCHME one\nhit MATCHME two\n",
            )
            .unwrap();
        }
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;

        let out = git_grep_at_ref(repo.clone(), "MATCHME".into(), "HEAD".into(), Some(2))
            .await
            .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3, "2 kept lines + 1 marker line");
        // git grep orders by path, so the first two lines are a.txt's two matches.
        assert_eq!(lines[0], "a.txt:1:hit MATCHME one");
        assert_eq!(lines[1], "a.txt:2:hit MATCHME two");
        assert_eq!(
            lines[2], "[... additional matches truncated]",
            "count-less marker: -m makes the true total unknowable"
        );
    }

    /// The unknown-option matcher recognizes git's real phrasings (so a git < 2.38
    /// lacking `-m` triggers the fallback), while leaving unrelated grep failures
    /// (e.g. a bad rev) to surface as real errors.
    #[test]
    fn is_unknown_option_matches_gits_phrasings() {
        // git 2.51's actual banner for an unknown option (captured verbatim).
        assert!(is_unknown_option(
            "error: unknown option `max-count'\nusage: git grep [<options>] [-e] <pattern>"
        ));
        // Older/alternate phrasing.
        assert!(is_unknown_option("error: unknown switch `m'"));
        assert!(is_unknown_option("USAGE: GIT GREP ...")); // case-insensitive
        // A genuine grep failure must NOT be mistaken for a version issue.
        assert!(!is_unknown_option(
            "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree"
        ));
    }

    /// A ref that looks like an option is rejected before any git runs.
    #[tokio::test]
    async fn grep_at_ref_rejects_option_like_ref() {
        let (_base, repo) = seed_repo("grep-badref").await;

        let err = git_grep_at_ref(repo.clone(), "x".into(), "-oops".into(), None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::InvalidArgument(_)),
            "leading-dash ref rejected as invalid argument"
        );

        // An empty/whitespace pattern is likewise rejected.
        let err = git_grep_at_ref(repo.clone(), "   ".into(), "HEAD".into(), None)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
    }

    /// The review-husk sweep removes only EMPTY `gd-review-*` dirs: a non-empty
    /// `gd-review-*` (a live review's populated worktree) and a non-matching name
    /// are both spared.
    #[test]
    fn sweep_review_husks_removes_only_empty_gd_review_dirs() {
        let _base = tempfile::Builder::new()
            .prefix("gd-sweep-test-")
            .tempdir()
            .expect("create temp dir");
        let base = _base.path().to_path_buf();

        // An empty gd-review-* husk → removed.
        let empty_husk = base.join("gd-review-abc123-42");
        std::fs::create_dir(&empty_husk).unwrap();
        // A non-empty gd-review-* (live review worktree) → kept.
        let live = base.join("gd-review-def456-7");
        std::fs::create_dir(&live).unwrap();
        std::fs::write(live.join("file.txt"), b"content").unwrap();
        // The reused per-repo review worktree matches the `gd-review-` prefix too, so
        // the NAME filter does NOT spare it — being non-empty does, exactly as for any
        // live review. (In production it is unreachable anyway: this sweep only ever
        // scans the OS temp dir, and that worktree lives under app data.)
        let persistent = base.join(super::PERSISTENT_REVIEW_DIR);
        std::fs::create_dir(&persistent).unwrap();
        std::fs::write(persistent.join("file.txt"), b"content").unwrap();
        // A non-matching empty dir → kept (name filter).
        let other = base.join("gd-resolve-xyz-1");
        std::fs::create_dir(&other).unwrap();

        let removed = super::sweep_review_husks_in(&base).unwrap();
        assert_eq!(removed, 1, "exactly the one empty gd-review-* husk is removed");
        assert!(!empty_husk.exists(), "empty gd-review-* husk was removed");
        assert!(live.exists(), "non-empty gd-review-* (live review) is kept");
        assert!(persistent.exists(), "the reused review worktree is kept");
        assert!(other.exists(), "non-matching name is kept");
    }

    /// Seeds a repo whose HEAD is on NEITHER review target — a commit on the default
    /// branch, two more on a side branch, then back to the default — so
    /// `git_review_worktree`'s "already on this commit" short-circuit never fires.
    /// Returns `(guard, repo, sha1, sha2)`.
    async fn seed_review_repo(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (base, repo) = seed_repo(tag).await;
        let root = std::path::Path::new(&repo).to_path_buf();

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        // `git init` picks the default branch name from the host's config.
        let default_branch = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo, &["checkout", "-qb", "feature"]).await;
        std::fs::write(root.join("one.txt"), "one\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "one"]).await;
        let sha1 = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        std::fs::write(root.join("two.txt"), "two\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "two"]).await;
        let sha2 = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        run(&repo, &["checkout", "-q", &default_branch]).await;
        (base, repo, sha1, sha2)
    }

    /// Epoch ms now — the clock the sweep's age gate subtracts a fixture's mtime from.
    fn now_epoch_ms() -> i64 {
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("the clock is past the epoch")
                .as_millis(),
        )
        .expect("epoch ms fits an i64")
    }

    /// Backdates a worktree's recorded git activity. `worktree_last_activity_ms` reads
    /// its admin `index` and falls back to `HEAD`, so both move.
    async fn age_worktree(worktree: &str, when: std::time::SystemTime) {
        let admin = run(worktree, &["rev-parse", "--absolute-git-dir"]).await;
        let admin = std::path::PathBuf::from(admin.trim());
        for name in ["index", "HEAD"] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(admin.join(name))
                .expect("the worktree's admin file is writable")
                .set_modified(when)
                .expect("the mtime is settable");
        }
    }

    /// Whether `path` is currently registered as a worktree of `repo`, compared in
    /// BOTH spellings like `update_marker::is_managed_update_worktree_in`: porcelain
    /// prints RESOLVED paths, so an app-built path never matches on its own where the
    /// temp root is a symlink (macOS `/var` → `/private/var`) or carries an 8.3 short
    /// component. The normalized form is the fallback for a path git can't resolve.
    async fn is_registered_worktree(repo: &str, path: &str) -> bool {
        use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
        let listed = run(repo, &["worktree", "list", "--porcelain"]).await;
        let (want_canon, want_norm) = (canonical_wt_path(path), normalize_wt_path(path));
        listed
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .map(str::trim)
            .any(|p| canonical_wt_path(p) == want_canon || normalize_wt_path(p) == want_norm)
    }

    /// The review workspace is ONE persistent per-repo checkout: a second review at a
    /// DIFFERENT sha gets the same path re-pointed in place, with no add and no
    /// removal in between. (Before reuse, every call minted a fresh nanos path.)
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn review_worktree_reuses_one_persistent_checkout() {
        let (base, repo, sha1, sha2) = seed_review_repo("review-reuse").await;
        let root = base.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        let first = git_review_worktree_core(&state, repo.clone(), sha1.clone())
            .await
            .unwrap()
            .expect("a repo checked out elsewhere gets a review worktree");
        assert_eq!(
            std::path::Path::new(&first),
            root.join(PERSISTENT_REVIEW_DIR),
            "the review worktree is the per-repo persistent one"
        );
        assert_eq!(run(&first, &["rev-parse", "HEAD"]).await.trim(), sha1);
        assert_eq!(
            run(&first, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "HEAD",
            "the review checkout is detached"
        );
        assert!(is_registered_worktree(&repo, &first).await);

        // Settling the review releases the claim without touching the checkout.
        git_remove_worktree_core(&state, repo.clone(), first.clone())
            .await
            .unwrap();
        assert!(std::path::Path::new(&first).exists());

        let second = git_review_worktree_core(&state, repo.clone(), sha2.clone())
            .await
            .unwrap()
            .expect("the released worktree is handed out again");
        assert_eq!(second, first, "the same path, re-pointed rather than re-minted");
        assert_eq!(run(&second, &["rev-parse", "HEAD"]).await.trim(), sha2);
        assert!(is_registered_worktree(&repo, &second).await);
        git_remove_worktree_core(&state, repo, second).await.unwrap();
    }

    /// A re-review of the SAME sha re-checks the tree out rather than trusting it: a
    /// tracked file a previous run left modified is restored, so a review can never
    /// read content the PR does not contain. The untracked stray beside it is cleaned.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn re_reviewing_the_same_sha_restores_the_prs_content() {
        let (base, repo, _sha1, sha2) = seed_review_repo("review-samesha").await;
        let root = base.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        let first = git_review_worktree_core(&state, repo.clone(), sha2.clone())
            .await
            .unwrap()
            .expect("a review worktree is handed out");
        let tracked = std::path::Path::new(&first).join("one.txt");
        // EOL-normalized: `core.autocrlf` checks the file out CRLF on this host.
        let content = |p: &std::path::Path| std::fs::read_to_string(p).unwrap().replace("\r\n", "\n");
        assert_eq!(content(&tracked), "one\n");
        git_remove_worktree_core(&state, repo.clone(), first.clone())
            .await
            .unwrap();

        // What a strayed agent run leaves behind between reviews. The nested repo is
        // the case single-force `clean` skips while still exiting 0 — it has to be
        // gone whether the reuse cleaned it or the caller rebuilt the workspace.
        std::fs::write(&tracked, "tampered\n").unwrap();
        let stray = std::path::Path::new(&first).join("stray.txt");
        std::fs::write(&stray, "stray\n").unwrap();
        // A REAL nested repo, not a bare `.git` folder: git only skips a subdirectory
        // it recognizes as a repository, so an empty `.git` would be swept by plain
        // `-fdx` and the case would go untested.
        let nested = std::path::Path::new(&first).join("cloned-repo");
        std::fs::create_dir_all(&nested).unwrap();
        run(&nested.to_string_lossy(), &["init", "-q"]).await;
        std::fs::write(nested.join("README.md"), "cloned by an agent\n").unwrap();

        let second = git_review_worktree_core(&state, repo.clone(), sha2.clone())
            .await
            .unwrap()
            .expect("the same head reuses the worktree");
        assert_eq!(second, first, "still the same reused path");
        assert_eq!(
            content(&tracked),
            "one\n",
            "the modified TRACKED file is restored to the PR's content"
        );
        assert!(!stray.exists(), "the untracked stray is cleaned");
        assert!(
            !nested.exists(),
            "an untracked nested git repo is cleaned too — single-force `clean` skips it"
        );
        git_remove_worktree_core(&state, repo, second).await.unwrap();
    }

    /// Releasing the persistent worktree leaves the checkout AND its registration on
    /// disk — the whole point of reusing it.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn removing_the_persistent_review_worktree_only_releases_it() {
        let (base, repo, sha1, _sha2) = seed_review_repo("review-release").await;
        let root = base.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        let path = git_review_worktree_core(&state, repo.clone(), sha1)
            .await
            .unwrap()
            .expect("a review worktree is handed out");
        git_remove_worktree_core(&state, repo.clone(), path.clone())
            .await
            .unwrap();

        assert!(std::path::Path::new(&path).exists(), "the directory survives");
        let git_dir = run_git_raw(Some(&path), &["rev-parse", "--git-dir"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(git_dir.code, 0, "it is still a worktree: {}", git_dir.stderr);
        assert!(
            is_registered_worktree(&repo, &path).await,
            "its administrative entry is left intact"
        );
    }

    /// While one review holds the persistent worktree, a concurrent review gets a
    /// throwaway OS-temp mint — which `git_remove_worktree` still deletes whole.
    /// Once the first review settles, the persistent worktree is handed out again.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn review_worktree_falls_back_to_a_temp_mint_while_busy() {
        let (base, repo, sha1, sha2) = seed_review_repo("review-busy").await;
        let root = base.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        // Acquired and deliberately never released — a review is running in it.
        let held = git_review_worktree_core(&state, repo.clone(), sha1)
            .await
            .unwrap()
            .expect("the first review takes the persistent worktree");

        let fallback = git_review_worktree_core(&state, repo.clone(), sha2.clone())
            .await
            .unwrap()
            .expect("a busy persistent worktree falls back to a mint");
        assert_ne!(fallback, held, "the two reviews get different workspaces");
        assert!(
            is_review_worktree_temp_path(std::path::Path::new(&fallback)),
            "the fallback is a gd-review-* mint in the OS temp dir: {fallback}"
        );
        assert_eq!(run(&fallback, &["rev-parse", "HEAD"]).await.trim(), sha2);

        git_remove_worktree_core(&state, repo.clone(), fallback.clone())
            .await
            .unwrap();
        assert!(
            !std::path::Path::new(&fallback).exists(),
            "the ephemeral mint is still deleted whole"
        );

        git_remove_worktree_core(&state, repo.clone(), held.clone())
            .await
            .unwrap();
        let again = git_review_worktree_core(&state, repo.clone(), sha2)
            .await
            .unwrap()
            .expect("the released worktree is available again");
        assert_eq!(again, held, "the freed persistent worktree is reused");
        git_remove_worktree_core(&state, repo, again).await.unwrap();
    }

    /// The claim is keyed on the exact path, so the release arms can't reach past
    /// their own worktree: a same-BASENAME checkout under another parent still takes
    /// the real removal path, and another root's persistent path never frees this
    /// one's claim.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn review_worktree_release_is_scoped_to_its_own_path() {
        let (base, repo, sha1, sha2) = seed_review_repo("review-scope").await;
        let root = base.path().join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        let held = git_review_worktree_core(&state, repo.clone(), sha1.clone())
            .await
            .unwrap()
            .expect("the review takes the persistent worktree");

        // (a) Same basename, DIFFERENT parent — not this repo's persistent worktree,
        // so the removal runs and the checkout is gone.
        let elsewhere = base.path().join("elsewhere").join(PERSISTENT_REVIEW_DIR);
        std::fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        let elsewhere_s = elsewhere.to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "--detach", &elsewhere_s, &sha2]).await;
        assert!(elsewhere.exists(), "the decoy worktree was created");
        git_remove_worktree_core(&state, repo.clone(), elsewhere_s)
            .await
            .unwrap();
        assert!(
            !elsewhere.exists(),
            "a same-named checkout elsewhere still takes the removal path"
        );

        // (b) Another root's persistent path — the release-and-keep arm answers it,
        // but it must not free THIS root's claim.
        {
            let other_root = base.path().join("worktrees-other");
            let _other = TestRootOverride::set(&other_root);
            let other_path = other_root.join(PERSISTENT_REVIEW_DIR);
            git_remove_worktree_core(
                &state,
                repo.clone(),
                other_path.to_string_lossy().into_owned(),
            )
            .await
            .unwrap();
        }
        let still_busy = git_review_worktree_core(&state, repo.clone(), sha2.clone())
            .await
            .unwrap()
            .expect("a review still gets a workspace");
        assert_ne!(
            still_busy, held,
            "the claim survived another root's release, so this review is a mint"
        );
        git_remove_worktree_core(&state, repo.clone(), still_busy)
            .await
            .unwrap();

        git_remove_worktree_core(&state, repo.clone(), held.clone())
            .await
            .unwrap();
        let reused = git_review_worktree_core(&state, repo.clone(), sha2)
            .await
            .unwrap()
            .expect("its own release frees it");
        assert_eq!(reused, held);
        git_remove_worktree_core(&state, repo, reused).await.unwrap();
    }

    /// A persistent path that EXISTS but is not a worktree — a plain directory a
    /// crash or a half-finished `worktree add` left behind — is torn down and rebuilt
    /// in place. This is the only route through the demolish arm's `remove_dir_all`.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_non_worktree_at_the_persistent_path_is_rebuilt() {
        let (base, repo, sha1, _sha2) = seed_review_repo("review-rebuild").await;
        let root = base.path().join("worktrees");
        let planted = root.join(PERSISTENT_REVIEW_DIR);
        std::fs::create_dir_all(&planted).unwrap();
        let debris = planted.join("debris.txt");
        std::fs::write(&debris, b"not a worktree").unwrap();
        let _serialized = test_root_lock();
        let _override = TestRootOverride::set(&root);
        let state = AppState::default();

        let path = git_review_worktree_core(&state, repo.clone(), sha1.clone())
            .await
            .unwrap()
            .expect("a wreck at the persistent path is rebuilt, not refused");
        assert_eq!(
            std::path::Path::new(&path),
            planted,
            "rebuilt in place rather than falling back to a mint"
        );
        assert_eq!(run(&path, &["rev-parse", "HEAD"]).await.trim(), sha1);
        assert!(!debris.exists(), "the planted debris was cleared by the rebuild");
        assert!(is_registered_worktree(&repo, &path).await);
        git_remove_worktree_core(&state, repo, path).await.unwrap();
    }

    /// With no root override installed, `cfg(test)` resolves NO persistent path, so a
    /// test can never read or write real app data — the review falls open to an
    /// ephemeral OS-temp mint rather than erroring.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn review_worktree_without_a_root_override_mints_in_temp() {
        let (_base, repo, sha1, _sha2) = seed_review_repo("review-noroot").await;
        let _serialized = test_root_lock();
        let state = AppState::default();

        let path = git_review_worktree_core(&state, repo.clone(), sha1.clone())
            .await
            .unwrap()
            .expect("a review still gets a workspace with no root resolved");
        assert!(
            is_review_worktree_temp_path(std::path::Path::new(&path)),
            "no override ⇒ the OS-temp mint: {path}"
        );
        assert_eq!(run(&path, &["rev-parse", "HEAD"]).await.trim(), sha1);

        git_remove_worktree_core(&state, repo, path.clone())
            .await
            .unwrap();
        assert!(!std::path::Path::new(&path).exists());
    }

    /// The idle sweep reclaims only what it can prove is idle AND unclaimed: a
    /// week-old unclaimed checkout goes, sidecar included, and so does one whose
    /// source repo was deleted (its age comes from the dangling `.git` pointer). A
    /// fresh checkout, one a live review still holds, and a differently-named sibling
    /// in the SAME hash dir all survive.
    #[tokio::test]
    async fn stale_review_worktree_sweep_is_age_and_claim_gated() {
        let (base, repo, sha1, _sha2) = seed_review_repo("review-sweep").await;
        let scan = base.path().join("scan");

        // Checkouts under their own hash dirs, as the real root holds them — plus a
        // differently-named sibling INSIDE the aged one, which the sweep must leave
        // standing while it reclaims its neighbour.
        let mut made = Vec::new();
        for (hash, name) in [
            ("aged", PERSISTENT_REVIEW_DIR),
            ("fresh", PERSISTENT_REVIEW_DIR),
            ("locked", PERSISTENT_REVIEW_DIR),
            ("dangling", PERSISTENT_REVIEW_DIR),
            ("aged", "gd-review-something-else"),
        ] {
            let dir = scan.join(hash).join(name);
            std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
            let dir_s = dir.to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "--detach", &dir_s, &sha1]).await;
            assert!(dir.exists(), "fixture worktree {hash}/{name} was created");
            made.push(dir);
        }
        let (aged, fresh, locked, dangling, sibling) =
            (&made[0], &made[1], &made[2], &made[3], &made[4]);

        // Age all but `fresh` by eight days.
        let eight_days_ago =
            std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86_400);
        for dir in [aged, locked, sibling] {
            age_worktree(&dir.to_string_lossy(), eight_days_ago).await;
        }
        // `dangling` loses its source repo: the admin dir behind the pointer is gone,
        // so only the pointer FILE's own mtime can age it.
        std::fs::write(dangling.join(".git"), b"gitdir: /nonexistent/gd-gone\n").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(dangling.join(".git"))
            .unwrap()
            .set_modified(eight_days_ago)
            .unwrap();
        assert!(
            crate::git::worktree::worktree_last_activity_ms(&dangling.to_string_lossy()).is_none(),
            "the fixture's activity probe really is unreadable"
        );

        // A live review holds `locked`'s sidecar for the whole sweep.
        let locked_sidecar = persistent_review_lock_path(locked).unwrap();
        let claim = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&locked_sidecar)
            .unwrap();
        claim.try_lock().expect("the fixture takes the claim");
        // The aged one gets an UNCLAIMED sidecar, which the sweep must delete with it.
        let aged_sidecar = persistent_review_lock_path(aged).unwrap();
        std::fs::write(&aged_sidecar, b"").unwrap();

        let removed = sweep_stale_persistent_reviews_in(&scan, now_epoch_ms()).unwrap();

        assert_eq!(removed, 2, "the idle unclaimed checkout and the dangling one");
        assert!(!aged.exists(), "a week-idle unclaimed review worktree is reclaimed");
        assert!(!aged_sidecar.exists(), "its sidecar goes with it");
        assert!(
            !dangling.exists(),
            "a checkout whose source repo is gone still ages out"
        );
        assert!(fresh.exists(), "a recently used review worktree is kept");
        assert!(locked.exists(), "a live claim outranks age");
        assert!(
            sibling.exists(),
            "only the exact `gd-review-persistent` name is swept, even beside one that is"
        );
        drop(claim);

        // A bare wreck — a half-finished add with no `.git` at all — answers neither
        // git probe, so only the directory's own mtime can age it. Its own scan root
        // and an advanced clock, because setting a DIRECTORY mtime is not portable in
        // std; the gate subtracts the same either way.
        let bare_scan = base.path().join("scan-bare");
        let bare = bare_scan.join("wreck").join(PERSISTENT_REVIEW_DIR);
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join("debris.txt"), b"not a worktree").unwrap();
        assert!(
            crate::git::worktree::worktree_last_activity_ms(&bare.to_string_lossy()).is_none(),
            "the fixture really has no git activity to read"
        );
        // Read the clock AFTER planting it, so the fixture's own mtime can't outrun it.
        let later_ms = now_epoch_ms() + PERSISTENT_REVIEW_MAX_IDLE_MS + 1;
        assert_eq!(
            sweep_stale_persistent_reviews_in(&bare_scan, later_ms).unwrap(),
            1,
            "a `.git`-less wreck still ages out on the directory's own mtime"
        );
        assert!(!bare.exists());
    }

    /// The `remove_dir_all` fallback guard admits only `gd-review-*` dirs directly
    /// under the OS temp dir, so the command can't become an arbitrary recursive
    /// delete of any caller-supplied path.
    #[test]
    fn is_review_worktree_temp_path_admits_only_temp_gd_review() {
        let temp = std::env::temp_dir();
        // A real review-worktree-shaped husk path → true (need not exist on disk).
        assert!(super::is_review_worktree_temp_path(
            &temp.join("gd-review-abc123-42")
        ));
        // A temp dir but the wrong prefix (e.g. a resolve worktree, or anything
        // else) → false.
        assert!(!super::is_review_worktree_temp_path(
            &temp.join("gd-resolve-abc123-42")
        ));
        assert!(!super::is_review_worktree_temp_path(&temp.join("random-dir")));
        // A gd-review-* name OUTSIDE the temp dir → false (a user's Documents, say).
        assert!(!super::is_review_worktree_temp_path(std::path::Path::new(
            "C:\\Users\\me\\Documents\\gd-review-evil"
        )));
        assert!(!super::is_review_worktree_temp_path(std::path::Path::new(
            "/home/me/gd-review-evil"
        )));
        // NESTED under temp (not a direct child) → false: the fallback must not
        // reach a path a level below the temp root.
        assert!(!super::is_review_worktree_temp_path(
            &temp.join("sub").join("gd-review-abc123-42")
        ));
    }
}
