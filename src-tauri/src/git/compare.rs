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
                author_email: parts.next()?.to_string(),
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
        &["log", "--format=%H%x00%s%x00%an%x00%ae%x00%cI", range],
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
/// feeding AI PR description generation. The `exclude` handling mirrors
/// `git_staged_diff` exactly — the caller's AI-ignore patterns become git pathspec
/// excludes and `excluded_files` reports how many changed files they hid, with
/// `exclude: None` behaving as an unfiltered three-dot diff. Truncation deliberately
/// differs: this cuts at a char boundary with a 1 MB default, not at a file boundary
/// with the AI budget.
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
    let range = format!("{base}...{compare}");

    // Translate ignore patterns into git pathspec excludes so matching has
    // exact gitignore-style glob semantics. ":(exclude)" needs at least one
    // inclusive pathspec alongside it, hence the leading ".".
    let mut pathspec: Vec<String> = Vec::new();
    for pattern in exclude.unwrap_or_default() {
        let pattern = pattern.trim();
        if pattern.is_empty() || pattern.starts_with('#') {
            continue;
        }
        pathspec.push(format!(":(exclude){pattern}"));
    }

    let mut diff_args: Vec<&str> = vec!["diff", "--no-color", &range];
    let mut stat_args: Vec<&str> = vec!["diff", "--numstat", "-z", &range];
    if !pathspec.is_empty() {
        for args in [&mut diff_args, &mut stat_args] {
            args.push("--");
            args.push(".");
            args.extend(pathspec.iter().map(String::as_str));
        }
    }

    let (text_out, files_out) = tokio::try_join!(
        run_git(Some(&repo_path), &diff_args, DEFAULT_TIMEOUT),
        run_git(Some(&repo_path), &stat_args, DEFAULT_TIMEOUT)
    )?;
    let (text, truncated) =
        truncate_at_char_boundary(text_out.stdout_lossy(), max_bytes.unwrap_or(1_000_000));
    let files = parse_numstat_z(&files_out.stdout_lossy());

    // Tell the caller how many changed files the excludes hid, so the AI
    // prompt can mention that the diff is not the whole story.
    let excluded_files = if pathspec.is_empty() {
        0
    } else {
        let all = run_git(
            Some(&repo_path),
            &["diff", "--numstat", "-z", &range],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let total = parse_numstat_z(&all.stdout_lossy()).len();
        total.saturating_sub(files.len()) as u32
    };

    Ok(StagedDiff {
        text,
        truncated,
        files,
        excluded_files,
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

/// Whether `path` is a `git_review_worktree`-shaped review temp dir: located
/// DIRECTLY under the OS temp dir with a basename starting `gd-review-`. This is
/// the guard for the `remove_dir_all` fallback in `git_remove_worktree` — the
/// fallback must NEVER widen that `#[tauri::command]` into an arbitrary recursive
/// delete of any caller-supplied path (git's own `worktree remove` refuses a
/// non-worktree path, so the fallback is the only unbounded-delete risk). Only
/// paths this returns `true` for get the fallback; every other path degrades to
/// git-only baseline. Comparison is component-wise (robust to trailing
/// separators) and case-insensitive on the file name to match Windows semantics.
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
    // `git worktree remove` deletes the directory itself, but on Windows that
    // recursive delete can lose a handle race (an antivirus/indexer still holding
    // the temp dir) and leave an EMPTY husk behind, and `git_remove_worktree`
    // discards every result above — so the husk leaks in %TEMP% forever. Finish
    // the delete ourselves best-effort with a short backoff. GUARDED to exactly
    // the `gd-review-*` temp shape the only caller passes: git's own remove can
    // never delete a non-worktree path, so an unguarded `remove_dir_all` here
    // would widen this command into an arbitrary recursive-delete primitive on any
    // caller-supplied path. Off the guard, behavior degrades to the git-only
    // baseline. Still returns Ok(()) regardless (best-effort; the caller swallows).
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
/// worktree (`git_review_worktree`) lives its whole life NON-empty — populated by
/// `worktree add`, then deleted whole by `git_remove_worktree` — so unlike the
/// paused-state `gd-resolve-*` worktrees (which need a keep-list), a `gd-review-*`
/// dir that is *empty* can only be a husk whose delete lost the Windows handle
/// race; there is no in-flight review it could belong to. That makes "empty" a
/// sufficient exclusion with no keep-list needed. Best-effort housekeeping, run
/// once fire-and-forget on startup; every failure is skipped conservatively.
pub fn sweep_review_worktree_husks() {
    let _ = sweep_review_husks_in(&std::env::temp_dir());
}

/// The testable core of [`sweep_review_worktree_husks`], parameterized on the
/// directory so a unit test can drive it against a real fixture dir. Deletes only
/// entries whose basename starts with exactly `gd-review-` AND are empty
/// directories: `remove_dir` HARD-FAILS on a non-empty dir, so it is the real
/// TOCTOU-safe guard (not just the name filter) — a review that repopulates
/// between the filter and the delete simply fails the `remove_dir` and is spared.
/// Returns how many husks were removed (for the test); a dir it can't list is
/// skipped, not an error.
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
///
/// One `rev-parse` spawn per ref: every current caller passes a single SHA (the PR
/// head), so batching isn't worth it yet. If a multi-SHA caller appears, switch to
/// one `git cat-file --batch-check` process (`rev-parse --verify` takes exactly one
/// revision, so it can't batch).
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
/// fixed-string (v1 is deliberately literal, not regex — a regex mode is a later
/// addition), `-I` skips binary files, `-n` prefixes line numbers, and `-m` caps
/// results PER FILE so one pathological file (a minified bundle the `-I` filter
/// didn't catch) can't dominate the captured output before we trim. The pattern
/// is passed with `-e`, so a leading `-` in it is data, not an option (a bare
/// `--` guard isn't needed for the pattern; `validate_ref` guards the rev the
/// same way the rest of this module does).
///
/// `-m` (`--max-count`) landed in git 2.38 (Oct 2022); on an older git the switch
/// is unknown and git grep hard-fails, so [`run_grep`] retries once without it
/// (same output, just an uncapped capture). Because `-m` is per-file, the true
/// total match count isn't recoverable from the output, so the truncation marker
/// is count-less.
///
/// Grepping a rev makes git prefix every hit with `<atRef>:` (output is
/// `<atRef>:path:line:content`); we strip exactly that known prefix so the model
/// sees repo-relative `path:line:content`. Only the leading `atRef:` is removed —
/// path- and content-embedded colons are preserved.
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

/// Runs the fixed-string `git grep` at a rev, returning `Some(stdout)` on a match,
/// `None` for the documented no-match (exit 1, empty output). `run_git_raw` so exit
/// 1 stays a success signal rather than an error; any OTHER non-zero is a real error.
///
/// Retries ONCE without `-m` when the first run fails with an unknown-option error,
/// so a git older than 2.38 (which lacks `--max-count`) falls back to an uncapped
/// capture instead of hard-failing. The retry shares this same match/exit handling.
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

    /// `exclude` patterns hide matching files from BOTH the diff text and the file
    /// list of the three-dot range, and `excluded_files` reports how many were
    /// hidden. `None` (and a list of only blank/comment patterns) leaves the diff
    /// unfiltered with a zero count.
    #[tokio::test]
    async fn branch_diff_applies_exclude_pathspecs() {
        let (_base, repo) = seed_repo("branchdiff-exclude").await;
        let root = std::path::Path::new(&repo);

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        let base_sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();

        // Three changed files on top of the base: one of them is the one the
        // user's ignore patterns will hide.
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(root.join("notes.md"), "notes\n").unwrap();
        std::fs::write(root.join("package-lock.json"), "{\"lock\": 1}\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "work"]).await;

        // No excludes → every file present, nothing reported hidden.
        let all = git_branch_diff(repo.clone(), base_sha.clone(), "HEAD".into(), None, None)
            .await
            .unwrap();
        assert_eq!(all.files.len(), 3, "all three changed files are listed");
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
        assert_eq!(filtered.files.len(), 2);
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
        assert_eq!(noop.files.len(), 3);
        assert_eq!(noop.excluded_files, 0);
        assert_eq!(noop.text, all.text);
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
    /// truncation marker. The marker carries NO remainder count: `-m` caps per
    /// file, so the true total match count is not recoverable from the output (a
    /// count would understate). We assert the fixed lines returned and the marker
    /// text only.
    ///
    /// The matches are spread across THREE files deliberately: `-m` is per-file, so
    /// a single file with N matches would itself be capped to `max_hits` by git and
    /// never overflow the returned-line cap. Three files × 2 matches each = 6 lines
    /// out of git, which the caller's `take(2)` then trims — the realistic path.
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
        // A non-matching empty dir → kept (name filter).
        let other = base.join("gd-resolve-xyz-1");
        std::fs::create_dir(&other).unwrap();

        let removed = super::sweep_review_husks_in(&base).unwrap();
        assert_eq!(removed, 1, "exactly the one empty gd-review-* husk is removed");
        assert!(!empty_husk.exists(), "empty gd-review-* husk was removed");
        assert!(live.exists(), "non-empty gd-review-* (live review) is kept");
        assert!(other.exists(), "non-matching name is kept");
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
