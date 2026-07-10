use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::diff::{parse_numstat_z, truncate_at_char_boundary};
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::git::types::{CommitSummary, DiffStatEntry, FileDiff, StagedDiff};

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

fn parse_log(text: &str) -> Vec<CommitSummary> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            Some(CommitSummary {
                hash: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                tags: Vec::new(),
                is_merge: false,
            })
        })
        .collect()
}

async fn log_range(repo_path: &str, range: &str) -> AppResult<Vec<CommitSummary>> {
    let out = run_git(
        Some(repo_path),
        &["log", "--format=%H%x00%s%x00%an%x00%cI", range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_log(&out.stdout_lossy()))
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

/// The full combined `base...compare` diff text plus its file summary, for
/// feeding AI PR description generation. Mirrors `git_staged_diff`.
#[tauri::command]
pub async fn git_branch_diff(
    repo_path: String,
    base: String,
    compare: String,
    max_bytes: Option<usize>,
) -> AppResult<StagedDiff> {
    validate_ref(&base)?;
    validate_ref(&compare)?;
    let range = format!("{base}...{compare}");
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
    Ok(StagedDiff {
        text,
        truncated,
        files: parse_numstat_z(&files_out.stdout_lossy()),
        excluded_files: 0,
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
    let out = run_git(
        Some(&repo_path),
        &[
            "diff",
            "--no-color",
            &format!("{base}...{compare}"),
            "--",
            &file_path,
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
    //    anything else (e.g. 128 on a shallow clone) = couldn't determine. This is
    //    why "rewritten" and "indeterminate" are distinct (N4): only a definite
    //    exit-1 means the history was actually rewritten.
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

/// Creates a throwaway DETACHED worktree pinned at `sha`, so a repo-aware CLI
/// review can read the PR head's files without moving the user's active branch.
/// Returns `None` when a worktree isn't needed or possible — the repo is already
/// on that commit (its own working tree matches), the object isn't local (an
/// un-fetched remote PR), or the checkout fails — so the caller falls back to the
/// repo root. Best-effort: never the source of a review failure.
#[tauri::command]
pub async fn git_review_worktree(repo_path: String, sha: String) -> AppResult<Option<String>> {
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
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let short = &sha[..sha.len().min(8)];
    let path = std::env::temp_dir().join(format!("gd-review-{short}-{nanos}"));
    let path_str = path.to_string_lossy().into_owned();
    let out = run_git_raw(
        Some(&repo_path),
        &["worktree", "add", "--detach", &path_str, &sha],
        NETWORK_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(path_str))
}

/// Removes a review worktree created by `git_review_worktree` and prunes stale
/// administrative entries. Best-effort and idempotent.
#[tauri::command]
pub async fn git_remove_worktree(repo_path: String, worktree_path: String) -> AppResult<()> {
    let _ = run_git_raw(
        Some(&repo_path),
        &["worktree", "remove", "--force", &worktree_path],
        DEFAULT_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(&repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
    Ok(())
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
    // Short-circuit when every requested object is already present locally — this
    // runs before every repo-aware review worktree, and a PR that was already
    // checked out (or fetched earlier) needs no network round-trip. If ALL SHAs
    // resolve to a local commit, skip the fetch and report success. Any missing (or
    // unresolvable) object falls through to the real fetch below, preserving prior
    // behavior. `git rev-parse --verify --quiet <sha>^{commit}` exits non-zero when
    // the object is absent, so a clean exit across all refs means "all local".
    if all_objects_present(&repo_path, &refs).await {
        return Ok(true);
    }
    let mut args: Vec<&str> = vec!["fetch", "--no-tags", "origin"];
    args.extend(refs.iter().map(String::as_str));
    let out = run_git_raw(Some(&repo_path), &args, NETWORK_TIMEOUT).await?;
    Ok(out.code == 0)
}

/// Whether every ref in `refs` resolves to a commit object already in `repo_path`
/// (no network). A spawn/timeout error or a non-zero exit for any ref ⇒ `false`,
/// so the caller fetches — this only ever SKIPS the fetch when it's provably
/// unnecessary, never suppresses a needed one.
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
        let base = std::env::temp_dir().join(format!(
            "gd-fetchobj-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
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

        let _ = std::fs::remove_dir_all(&base);
    }
}
