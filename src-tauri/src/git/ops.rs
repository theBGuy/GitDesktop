use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::diff::parse_numstat_z;
use crate::git::history::validate_hash;
use crate::git::runner::{
    run_git, run_git_mutating, run_git_raw, run_git_raw_input, DEFAULT_TIMEOUT,
};
use crate::git::types::{FileDiff, RepoOpState, RewriteStep, StashEntry, TagInfo};
use crate::state::AppState;

/// Resolves a path inside .git (worktree-safe via --git-path) to an absolute one.
async fn git_dir_path(repo: &str, name: &str) -> Option<std::path::PathBuf> {
    let out = run_git(
        Some(repo),
        &["rev-parse", "--git-path", name],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let raw = out.stdout_lossy();
    let p = Path::new(raw.trim());
    Some(if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(repo).join(p)
    })
}

/// Whether a file/dir inside .git exists (worktree-safe via --git-path).
async fn git_path_exists(repo: &str, name: &str) -> bool {
    match git_dir_path(repo, name).await {
        Some(path) => path.exists(),
        None => false,
    }
}

/// True when an interactive rebase is paused at an `edit` instruction (the last
/// executed todo line is `edit`/`e`), as opposed to a conflict.
async fn rebase_stopped_for_edit(repo: &str) -> bool {
    let Some(path) = git_dir_path(repo, "rebase-merge/done").await else {
        return false;
    };
    let Ok(done) = std::fs::read_to_string(path) else {
        return false;
    };
    done.lines()
        .filter(|l| !l.trim().is_empty())
        .next_back()
        .map(|last| {
            let cmd = last.split_whitespace().next().unwrap_or("");
            cmd == "edit" || cmd == "e"
        })
        .unwrap_or(false)
}

/// Which multi-step git operation, if any, is mid-flight â€” drives the
/// conflict-resolution banner.
#[tauri::command]
pub async fn git_op_state(repo_path: String) -> AppResult<RepoOpState> {
    let rebasing = git_path_exists(&repo_path, "rebase-merge").await
        || git_path_exists(&repo_path, "rebase-apply").await;
    let edit_paused = rebasing && rebase_stopped_for_edit(&repo_path).await;
    Ok(RepoOpState {
        merging: git_path_exists(&repo_path, "MERGE_HEAD").await,
        rebasing,
        cherry_picking: git_path_exists(&repo_path, "CHERRY_PICK_HEAD").await,
        edit_paused,
    })
}

fn validate_op(op: &str) -> AppResult<()> {
    match op {
        "merge" | "rebase" | "cherry-pick" => Ok(()),
        _ => Err(AppError::InvalidArgument(format!("unknown operation: {op}"))),
    }
}

/// Abandons an in-progress merge/rebase/cherry-pick, restoring the
/// pre-operation state.
#[tauri::command]
pub async fn git_op_abort(
    state: State<'_, AppState>,
    repo_path: String,
    op: String,
) -> AppResult<()> {
    validate_op(&op)?;
    run_git_mutating(
        &state,
        &repo_path,
        &[op.as_str(), "--abort"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Finishes an in-progress operation once every conflict is resolved and
/// staged. A merge concludes with its commit; rebase/cherry-pick continue
/// with `core.editor=true` so git never tries to open an editor.
#[tauri::command]
pub async fn git_op_continue(
    state: State<'_, AppState>,
    repo_path: String,
    op: String,
) -> AppResult<()> {
    validate_op(&op)?;
    let args: Vec<&str> = match op.as_str() {
        "merge" => vec!["commit", "--no-edit"],
        other => vec!["-c", "core.editor=true", other, "--continue"],
    };
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Discards working-tree changes for one file. Tracked files are restored
/// from the index; untracked files go to the OS recycle bin.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    untracked: bool,
) -> AppResult<()> {
    if untracked {
        let full = Path::new(&repo_path).join(&path);
        tauri::async_runtime::spawn_blocking(move || {
            trash::delete(&full).map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
        return Ok(());
    }
    run_git_mutating(&state, &repo_path, &["restore", "--", &path], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Discards selected lines from an untracked (new) file by removing just those
/// 1-based line numbers and rewriting the file in place. A new file's diff is
/// all additions, so "discard line N" means "delete physical line N" — there's
/// no index/patch to reverse-apply (reverse-applying a new-file patch would
/// delete the whole file). The file stays untracked; discarding every line
/// leaves it empty (whole-file removal is `git_discard`'s recycle-bin path).
/// `split_inclusive('\n')` keeps each kept line's exact terminator, so CRLF and
/// a missing final newline are preserved.
#[tauri::command]
pub async fn git_discard_untracked_lines(
    repo_path: String,
    path: String,
    lines: Vec<u32>,
) -> AppResult<()> {
    if lines.is_empty() {
        return Err(AppError::InvalidArgument("no lines selected".into()));
    }
    let full = Path::new(&repo_path).join(&path);
    tauri::async_runtime::spawn_blocking(move || -> AppResult<()> {
        let content = std::fs::read_to_string(&full)?;
        let drop: std::collections::HashSet<u32> = lines.into_iter().collect();
        std::fs::write(&full, remove_lines(&content, &drop))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(())
}

/// Removes the given 1-based line numbers from `content`, keeping every other
/// line byte-for-byte. `split_inclusive('\n')` keeps each line's terminator
/// attached, so CRLF endings and a missing final newline are preserved.
fn remove_lines(content: &str, drop: &std::collections::HashSet<u32>) -> String {
    content
        .split_inclusive('\n')
        .enumerate()
        .filter(|(i, _)| !drop.contains(&(*i as u32 + 1)))
        .map(|(_, line)| line)
        .collect()
}

/// Mixed reset: moves the branch pointer, keeps the working tree.
#[tauri::command]
pub async fn git_reset(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    run_git_mutating(&state, &repo_path, &["reset", "--mixed", &hash], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_checkout_commit(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    run_git_mutating(&state, &repo_path, &["switch", "--detach", &hash], DEFAULT_TIMEOUT)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn git_revert(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    // -m is not supported here; reverting merge commits needs a parent choice
    run_git_mutating(&state, &repo_path, &["revert", "--no-edit", &hash], DEFAULT_TIMEOUT)
        .await?;
    Ok(())
}

/// Returns true when a commit was created. Cherry-picking changes that are
/// already present makes git stop with an in-progress empty pick; that's not
/// an error worth surfacing raw â€” clean up with --skip and report false.
#[tauri::command]
pub async fn git_cherry_pick(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<bool> {
    validate_hash(&hash)?;
    match run_git_mutating(&state, &repo_path, &["cherry-pick", &hash], DEFAULT_TIMEOUT).await {
        Ok(_) => Ok(true),
        Err(AppError::Git { stderr, .. })
            if stderr.contains("is now empty") || stderr.contains("--allow-empty") =>
        {
            let _ = run_git_mutating(
                &state,
                &repo_path,
                &["cherry-pick", "--skip"],
                DEFAULT_TIMEOUT,
            )
            .await;
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickRangeResult {
    pub applied: usize,
    pub skipped: usize,
}

/// Copies the given commits (oldest-first) onto `target_branch`, then leaves
/// you on that branch. Commits whose changes already exist there are skipped
/// rather than erroring. If any commit conflicts, the whole operation is
/// rolled back â€” the target branch is reset to its prior tip and you return to
/// where you started â€” so the repo is never left mid-conflict.
#[tauri::command]
pub async fn git_cherry_pick_onto(
    state: State<'_, AppState>,
    repo_path: String,
    hashes: Vec<String>,
    target_branch: String,
) -> AppResult<CherryPickRangeResult> {
    use crate::git::runner::run_git;

    validate_branch_arg(&target_branch)?;
    for h in &hashes {
        validate_hash(h)?;
    }
    if hashes.is_empty() {
        return Ok(CherryPickRangeResult {
            applied: 0,
            skipped: 0,
        });
    }

    // Where we are now, so we can return on failure. A detached HEAD has no
    // branch name, so fall back to restoring its commit directly.
    let original_ref = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let detached = original_ref == "HEAD";
    let original_restore = if detached {
        run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .trim()
            .to_string()
    } else {
        original_ref
    };

    // The target's tip before we touch it, so we can roll back cleanly.
    let target_tip = run_git(
        Some(&repo_path),
        &["rev-parse", &target_branch],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();

    run_git_mutating(&state, &repo_path, &["switch", &target_branch], DEFAULT_TIMEOUT).await?;

    let mut applied = 0usize;
    let mut skipped = 0usize;
    for hash in &hashes {
        match run_git_mutating(&state, &repo_path, &["cherry-pick", hash], DEFAULT_TIMEOUT).await {
            Ok(_) => applied += 1,
            Err(AppError::Git { stderr, .. })
                if stderr.contains("is now empty") || stderr.contains("--allow-empty") =>
            {
                let _ = run_git_mutating(
                    &state,
                    &repo_path,
                    &["cherry-pick", "--skip"],
                    DEFAULT_TIMEOUT,
                )
                .await;
                skipped += 1;
            }
            Err(AppError::Git { code, stderr }) => {
                // Roll everything back: abort the in-progress pick, drop the
                // commits already applied in this batch, and return home.
                let _ = run_git_mutating(
                    &state,
                    &repo_path,
                    &["cherry-pick", "--abort"],
                    DEFAULT_TIMEOUT,
                )
                .await;
                let _ = run_git_mutating(
                    &state,
                    &repo_path,
                    &["reset", "--hard", &target_tip],
                    DEFAULT_TIMEOUT,
                )
                .await;
                let restore_args: Vec<&str> = if detached {
                    vec!["switch", "--detach", &original_restore]
                } else {
                    vec!["switch", &original_restore]
                };
                let _ = run_git_mutating(&state, &repo_path, &restore_args, DEFAULT_TIMEOUT).await;
                let short = &hash[..hash.len().min(7)];
                return Err(AppError::Git {
                    code,
                    stderr: format!(
                        "Cherry-pick hit conflicts on {short} and was rolled back; {target_branch} is unchanged.\n{stderr}"
                    ),
                });
            }
            Err(e) => return Err(e),
        }
    }

    Ok(CherryPickRangeResult { applied, skipped })
}

/// Discards every uncommitted change: untracked files go to the recycle bin,
/// tracked changes are hard-reset to HEAD.
#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    use crate::git::runner::{run_git, run_git_raw};

    let status_out = run_git(
        Some(&repo_path),
        &[
            "status",
            "--porcelain=v2",
            "--untracked-files=all",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let status = crate::git::status::parse_status_v2(&status_out.stdout_lossy());
    let untracked: Vec<String> = status
        .entries
        .iter()
        .filter(|e| e.unstaged == Some(crate::git::types::ChangeKind::Untracked))
        .map(|e| e.path.clone())
        .collect();

    if !untracked.is_empty() {
        let repo = repo_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for path in untracked {
                let full = Path::new(&repo).join(&path);
                trash::delete(&full)
                    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            }
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    }

    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if head_exists {
        run_git_mutating(&state, &repo_path, &["reset", "--hard", "HEAD"], DEFAULT_TIMEOUT)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    run_git_mutating(
        &state,
        &repo_path,
        &["stash", "push", "--include-untracked"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// One selected file to discard, paired with whether it's untracked (which
/// decides recycle-bin vs. `git restore`). Mirrors the per-file `git_discard`.
#[derive(serde::Deserialize)]
pub struct DiscardPath {
    pub path: String,
    pub untracked: bool,
}

/// Discards working-tree changes for a selection of files: tracked files are
/// restored from the index, untracked files go to the OS recycle bin. The
/// scoped analogue of `git_discard` / `git_discard_all`.
#[tauri::command]
pub async fn git_discard_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<DiscardPath>,
) -> AppResult<()> {
    let untracked: Vec<String> = paths
        .iter()
        .filter(|p| p.untracked)
        .map(|p| p.path.clone())
        .collect();
    let tracked: Vec<String> = paths
        .iter()
        .filter(|p| !p.untracked)
        .map(|p| p.path.clone())
        .collect();

    if !untracked.is_empty() {
        let repo = repo_path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for path in untracked {
                let full = Path::new(&repo).join(&path);
                trash::delete(&full)
                    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
            }
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    }

    // Chunked to stay under the Windows ~32K command-line limit on big selections.
    for batch in tracked.chunks(100) {
        let mut args = vec!["restore", "--"];
        args.extend(batch.iter().map(String::as_str));
        run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

/// Stashes only the selected files (their tracked changes plus any untracked
/// matches), leaving the rest of the working tree in place. Creates a single
/// stash entry; `git stash push` with a pathspec no-ops cleanly if nothing matches.
#[tauri::command]
pub async fn git_stash_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["stash", "push", "--include-untracked", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Stops tracking the files matching `pathspecs` (each a file, a folder, or a
/// glob like "*.log") via one `git rm --cached`, so they stay on disk but leave
/// the index, then appends `ignore_patterns` to .gitignore so they aren't
/// re-added. The "untrack" counterpart to the ignore menu — one or many files.
/// `--force` covers files with staged changes (content preserved on disk).
#[tauri::command]
pub async fn git_untrack(
    state: State<'_, AppState>,
    repo_path: String,
    pathspecs: Vec<String>,
    ignore_patterns: Vec<String>,
) -> AppResult<()> {
    let specs: Vec<&str> = pathspecs
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["rm", "--cached", "--force", "-r", "--"];
    args.extend(specs);
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    crate::fsops::append_to_gitignore(repo_path, ignore_patterns).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_pop(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    run_git_mutating(&state, &repo_path, &["stash", "pop"], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Every file git currently tracks (`git ls-files`), so the user can untrack one
/// that isn't showing pending changes (e.g. accidentally committed). Read-only.
#[tauri::command]
pub async fn git_list_tracked(repo_path: String) -> AppResult<Vec<String>> {
    let out = run_git(Some(&repo_path), &["ls-files", "-z"], DEFAULT_TIMEOUT).await?;
    Ok(out
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

/// An ignored file and the .gitignore rule responsible for ignoring it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredFile {
    /// Repo-relative path; a trailing "/" marks a collapsed ignored directory.
    path: String,
    /// The gitignore file the rule lives in (".gitignore", ".git/info/exclude", …).
    source: String,
    /// 1-based line of the rule in `source` (0 if it couldn't be parsed).
    line: u32,
    /// The matching pattern text.
    pattern: String,
}

/// Files git ignores (untracked + matched by a gitignore rule), each with the
/// rule responsible — surfaced nowhere else (git_status drops ignored entries).
/// Fully-ignored directories are collapsed (e.g. "node_modules/"). Read-only.
#[tauri::command]
pub async fn git_ignored_files(repo_path: String) -> AppResult<Vec<IgnoredFile>> {
    let listed = run_git(
        Some(&repo_path),
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "--no-empty-directory",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let paths: Vec<String> = listed
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    // Attach the responsible rule via `check-ignore -v` (NUL output, four tokens
    // per match: source, line, pattern, path). `-z` requires the paths on stdin,
    // not as args, so feed them NUL-delimited.
    let input: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let checked = run_git_raw_input(
        Some(&repo_path),
        &["check-ignore", "--verbose", "-z", "--stdin"],
        Some(&input),
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = checked.stdout_lossy();
    let tokens: Vec<&str> = text.split('\0').collect();

    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 < tokens.len() {
        let (source, line, pattern, path) =
            (tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3]);
        i += 4;
        if path.is_empty() {
            continue;
        }
        out.push(IgnoredFile {
            path: path.to_string(),
            source: source.to_string(),
            line: line.parse().unwrap_or(0),
            pattern: pattern.to_string(),
        });
    }
    Ok(out)
}

/// Force-adds the given pathspecs (`git add --force`), tracking files a gitignore
/// rule would otherwise exclude. A directory tracks its whole (ignored) content,
/// so callers should confirm first.
#[tauri::command]
pub async fn git_force_add(
    state: State<'_, AppState>,
    repo_path: String,
    pathspecs: Vec<String>,
) -> AppResult<()> {
    let specs: Vec<&str> = pathspecs
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if specs.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--force", "--"];
    args.extend(specs);
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// A gitignore rule to delete: the file it lives in + its exact pattern line.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnignoreRule {
    source: String,
    pattern: String,
}

/// Removes gitignore rule lines (matched by exact trimmed content) from their
/// source files — the "remove rule" / stop-ignoring action. Matching by content
/// (not line number) keeps it safe if the file shifted since it was read.
#[tauri::command]
pub async fn git_unignore_rules(repo_path: String, rules: Vec<UnignoreRule>) -> AppResult<()> {
    // Group the patterns to remove by their source gitignore file.
    let mut by_source: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in rules {
        let pat = r.pattern.trim().to_string();
        if r.source.trim().is_empty() || pat.is_empty() {
            continue;
        }
        by_source.entry(r.source).or_default().push(pat);
    }

    for (source, patterns) in by_source {
        let path = {
            let p = Path::new(&source);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&repo_path).join(&source)
            }
        };
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(AppError::Io(e)),
        };
        // Strip a leading UTF-8 BOM for processing (otherwise it rides on the
        // first line and breaks the `trim() == pattern` match), and restore it
        // on write. Preserve the file's existing line-ending convention — `lines()`
        // drops both \n and \r\n, so a naive `join("\n")` would silently rewrite a
        // Windows CRLF .gitignore to LF.
        let (has_bom, content) = match raw.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        let ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
        let kept: Vec<&str> = content
            .lines()
            .filter(|l| !patterns.iter().any(|p| l.trim() == p))
            .collect();
        let mut next = kept.join(ending);
        // Keep the trailing newline if the original had one, even when every
        // line was removed (so the file's convention is preserved, not truncated).
        if content.ends_with('\n') {
            next.push_str(ending);
        }
        if has_bom {
            next.insert(0, '\u{feff}');
        }
        tokio::fs::write(&path, next).await.map_err(AppError::Io)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_count(repo_path: String) -> AppResult<u32> {
    let out = crate::git::runner::run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%H"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy().lines().count() as u32)
}

#[tauri::command]
pub async fn git_stash_list(repo_path: String) -> AppResult<Vec<StashEntry>> {
    let out = run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%gd%x00%s%x00%cI"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let entries = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\0');
            let (Some(refname), Some(message), Some(date)) =
                (parts.next(), parts.next(), parts.next())
            else {
                return None;
            };
            // %gd is "stash@{N}" â€” the N is the index every other stash
            // command addresses.
            let index: u32 = refname
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(StashEntry {
                index,
                message: message.to_string(),
                date: date.to_string(),
            })
        })
        .collect();
    Ok(entries)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashFile {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
    pub is_binary: bool,
    /// Lives in the stash's untracked-files parent (^3), so its content reads
    /// from there rather than the stash commit itself.
    pub untracked: bool,
}

/// The files a stash holds, including untracked ones, so it can be browsed
/// file by file instead of as one combined diff (where a single binary file
/// would mark the whole preview unreadable).
#[tauri::command]
pub async fn git_stash_files(repo_path: String, index: u32) -> AppResult<Vec<StashFile>> {
    let spec = format!("stash@{{{index}}}");
    let out = run_git(
        Some(&repo_path),
        &[
            "stash",
            "show",
            "--numstat",
            "-z",
            "--include-untracked",
            &spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let entries = parse_numstat_z(&out.stdout_lossy());

    // Paths in the untracked parent (^3, present only when untracked files
    // were stashed) need their "new" content read from there.
    let untracked_ref = format!("stash@{{{index}}}^3");
    let mut untracked = std::collections::HashSet::new();
    if let Ok(o) = run_git(
        Some(&repo_path),
        &["ls-tree", "-r", "--name-only", "-z", &untracked_ref],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        for p in o.stdout_lossy().split('\0').filter(|s| !s.is_empty()) {
            untracked.insert(p.to_string());
        }
    }

    Ok(entries
        .into_iter()
        .map(|e| StashFile {
            untracked: untracked.contains(&e.path),
            path: e.path,
            added: e.added,
            deleted: e.deleted,
            is_binary: e.is_binary,
        })
        .collect())
}

/// One file's diff from a stash. Tracked changes diff the stash against its
/// base; untracked files live in the stash's third parent (`^3`, created by
/// `--include-untracked`), so an empty tracked diff falls back to that.
#[tauri::command]
pub async fn git_stash_file_diff(
    repo_path: String,
    index: u32,
    file_path: String,
) -> AppResult<FileDiff> {
    let base = format!("stash@{{{index}}}^1");
    let stash = format!("stash@{{{index}}}");
    let out = run_git(
        Some(&repo_path),
        &["diff", "--no-color", &base, &stash, "--", &file_path],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();
    if text.trim().is_empty() {
        // Not a tracked change — try the untracked-files parent if present.
        let untracked = format!("stash@{{{index}}}^3");
        if let Ok(o) = run_git(
            Some(&repo_path),
            &["diff", "--no-color", &base, &untracked, "--", &file_path],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            text = o.stdout_lossy();
        }
    }
    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = crate::git::diff::truncate_at_char_boundary(text, 1_000_000);
    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

#[tauri::command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
    pop: bool,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    run_git_mutating(&state, &repo_path, &["stash", sub, &spec], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    run_git_mutating(
        &state,
        &repo_path,
        &["stash", "drop", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

fn validate_branch_arg(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// Merges a branch into the current one. With `squash`, the combined changes
/// are left staged so the user writes the commit themselves. Otherwise `no_ff`
/// forces a merge commit even when a fast-forward is possible, and `strategy`
/// ("ours"/"theirs", anything else = none) auto-resolves conflicting hunks in
/// favor of the current/incoming side via `-X`. Conflicts (when not
/// auto-resolved) leave the repo in a normal merge-conflict state visible in
/// the changes list.
#[tauri::command]
pub async fn git_merge(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    squash: bool,
    no_ff: bool,
    strategy: String,
) -> AppResult<()> {
    validate_branch_arg(&branch)?;
    let mut args: Vec<&str> = vec!["merge"];
    if squash {
        args.push("--squash");
    } else {
        args.push("--no-edit");
        if no_ff {
            args.push("--no-ff");
        }
        match strategy.as_str() {
            "ours" => args.extend(["-X", "ours"]),
            "theirs" => args.extend(["-X", "theirs"]),
            _ => {}
        }
    }
    args.push(&branch);
    run_git_mutating(&state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    /// "up-to-date" | "fast-forward" | "clean" | "conflict" | "unknown".
    pub status: String,
    /// Conflicting file paths when status is "conflict" (may be empty if the
    /// git version doesn't report them).
    pub conflicts: Vec<String>,
}

/// Predicts the outcome of merging `branch` into the current branch **without
/// touching the working tree or index**. Uses merge-base for the
/// already-merged and fast-forward cases, then `git merge-tree --write-tree`
/// (git 2.38+, file names need 2.40+) for a real in-memory merge — honoring
/// `strategy` ("ours"/"theirs" → `-X`) so the prediction matches what the merge
/// will actually do (content conflicts auto-resolve; structural ones still show
/// as conflicts). Degrades to "unknown" (so the UI hides the preview) on older
/// git or any error.
#[tauri::command]
pub async fn git_merge_preview(
    repo_path: String,
    branch: String,
    strategy: String,
) -> AppResult<MergePreview> {
    validate_branch_arg(&branch)?;
    let unknown = || MergePreview {
        status: "unknown".to_string(),
        conflicts: Vec::new(),
    };

    let head = run_git_raw(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    let tip = run_git_raw(Some(&repo_path), &["rev-parse", &branch], DEFAULT_TIMEOUT).await?;
    if head.code != 0 || tip.code != 0 {
        return Ok(unknown());
    }
    let head = head.stdout_lossy().trim().to_string();
    let tip = tip.stdout_lossy().trim().to_string();

    let base_out =
        run_git_raw(Some(&repo_path), &["merge-base", "HEAD", &branch], DEFAULT_TIMEOUT).await?;
    if base_out.code == 0 {
        let base = base_out.stdout_lossy().trim().to_string();
        if base == tip {
            return Ok(MergePreview {
                status: "up-to-date".to_string(),
                conflicts: Vec::new(),
            });
        }
        if base == head {
            return Ok(MergePreview {
                status: "fast-forward".to_string(),
                conflicts: Vec::new(),
            });
        }
    }

    // Diverged (or unrelated histories) — do the merge in memory, honoring the
    // chosen strategy so the prediction matches what the real merge will do.
    let mut args: Vec<&str> = vec!["merge-tree", "--write-tree", "--name-only"];
    match strategy.as_str() {
        "ours" => args.extend(["-X", "ours"]),
        "theirs" => args.extend(["-X", "theirs"]),
        _ => {}
    }
    args.extend(["HEAD", &branch]);
    let mt = run_git_raw(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    match mt.code {
        0 => Ok(MergePreview {
            status: "clean".to_string(),
            conflicts: Vec::new(),
        }),
        1 => {
            // Line 1 is the merged-tree OID; the conflicted file names follow,
            // ending at the blank line before any informational messages. Empty
            // stdout means git refused the merge (no tree OID) — that's an
            // "unknown", not a zero-file conflict.
            let text = mt.stdout_lossy();
            if text.trim().is_empty() {
                return Ok(unknown());
            }
            let conflicts: Vec<String> = text
                .lines()
                .skip(1)
                .take_while(|l| !l.trim().is_empty())
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            Ok(MergePreview {
                status: "conflict".to_string(),
                conflicts,
            })
        }
        _ => Ok(unknown()),
    }
}

/// Rebases the current branch onto another. Conflicts leave the rebase in
/// progress â€” the changes panel's conflict banner takes it from there
/// (continue or abort).
#[tauri::command]
pub async fn git_rebase(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
) -> AppResult<()> {
    validate_branch_arg(&branch)?;
    run_git_mutating(
        &state,
        &repo_path,
        &["-c", "core.editor=true", "rebase", &branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Merges `head` into `base` for a local PR using one of three strategies,
/// matching GitHub's merge options:
/// - "merge"  â†’ a `--no-ff` merge commit carrying `message`
/// - "squash" â†’ squash all of head's commits into one commit with `message`
/// - "rebase" â†’ replay head's commits onto base (cherry-pick range, no merge
///   commit), preserving their individual messages
///
/// Checks out `base` to perform the merge, then returns you to the branch (or
/// detached commit) you started on. Any failure (conflict, etc.) is rolled back:
/// base is reset to its prior tip and your original branch restored, so nothing
/// is left half-merged.
#[tauri::command]
pub async fn git_merge_local_pr(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    head: String,
    message: String,
    strategy: String,
) -> AppResult<()> {
    use crate::git::runner::run_git;

    validate_branch_arg(&base)?;
    validate_branch_arg(&head)?;
    let message = if message.trim().is_empty() {
        format!("Merge {head} into {base}")
    } else {
        message
    };

    // Remember where we are + base's tip so any failure can be undone.
    let original = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let detached = original == "HEAD";
    let original_restore = if detached {
        run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .trim()
            .to_string()
    } else {
        original
    };
    let base_tip = run_git(Some(&repo_path), &["rev-parse", &base], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    run_git_mutating(&state, &repo_path, &["switch", &base], DEFAULT_TIMEOUT).await?;

    let range = format!("{base}..{head}");
    let result: AppResult<()> = match strategy.as_str() {
        "squash" => {
            match run_git_mutating(
                &state,
                &repo_path,
                &["merge", "--squash", &head],
                DEFAULT_TIMEOUT,
            )
            .await
            {
                Ok(_) => run_git_mutating(
                    &state,
                    &repo_path,
                    &["commit", "-m", &message],
                    DEFAULT_TIMEOUT,
                )
                .await
                .map(|_| ()),
                Err(e) => Err(e),
            }
        }
        "rebase" => run_git_mutating(&state, &repo_path, &["cherry-pick", &range], DEFAULT_TIMEOUT)
            .await
            .map(|_| ()),
        _ => run_git_mutating(
            &state,
            &repo_path,
            &["merge", "--no-ff", "-m", &message, &head],
            DEFAULT_TIMEOUT,
        )
        .await
        .map(|_| ()),
    };

    match result {
        Ok(()) => {
            // The merge landed on `base`; return the user to the branch (or
            // detached commit) they started on, unless they were already there.
            // Best-effort and always safe: the merge went *into* base, so the
            // original ref is untouched and still exists, and the tree is clean
            // after the commit, so the switch-back can't be blocked. A failure
            // here at worst leaves them on `base` — no worse than before.
            if original_restore != base {
                let restore: Vec<&str> = if detached {
                    vec!["switch", "--detach", &original_restore]
                } else {
                    vec!["switch", &original_restore]
                };
                let _ = run_git_mutating(&state, &repo_path, &restore, DEFAULT_TIMEOUT).await;
            }
            Ok(())
        }
        Err(err) => {
            // Roll back any half-applied state, then return home. The aborts
            // are best-effort (only one applies); the hard reset is the
            // guarantee that base is left exactly as it was.
            let _ = run_git_mutating(&state, &repo_path, &["merge", "--abort"], DEFAULT_TIMEOUT).await;
            let _ = run_git_mutating(
                &state,
                &repo_path,
                &["cherry-pick", "--abort"],
                DEFAULT_TIMEOUT,
            )
            .await;
            let _ = run_git_mutating(
                &state,
                &repo_path,
                &["reset", "--hard", &base_tip],
                DEFAULT_TIMEOUT,
            )
            .await;
            let restore: Vec<&str> = if detached {
                vec!["switch", "--detach", &original_restore]
            } else {
                vec!["switch", &original_restore]
            };
            let _ = run_git_mutating(&state, &repo_path, &restore, DEFAULT_TIMEOUT).await;
            match err {
                AppError::Git { code, stderr } => Err(AppError::Git {
                    code,
                    stderr: format!(
                        "{strategy} merge hit conflicts and was rolled back; {base} is unchanged.\n{stderr}"
                    ),
                }),
                other => Err(other),
            }
        }
    }
}

/// Rewrites the unpushed tip of the current branch (`base..HEAD`): each step
/// becomes one commit. The full interactive-rebase vocabulary maps onto steps:
/// a single-hash step with no message is a **pick** (plain cherry-pick,
/// original message kept); a single-hash step with a message is a **reword**; a
/// multi-hash step *with* a message is a **squash** (those commits collapse into
/// one with that message); a multi-hash step *without* a message is a **fixup**
/// (collapse but reuse the first/leader commit's message and authorship via
/// `commit -C`). Omitting a commit from every step **drops** it; the step order
/// is the new history order. Drives reorder, squash, and the Edit-history
/// editor. Refuses on a dirty tree or merge commits in range; any conflict rolls
/// everything back untouched.
#[tauri::command]
pub async fn git_rewrite_commits(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
) -> AppResult<()> {
    rewrite_commits(&state, &repo_path, &base, &steps).await
}

pub(crate) async fn rewrite_commits(
    state: &AppState,
    repo_path: &str,
    base: &str,
    steps: &[RewriteStep],
) -> AppResult<()> {
    validate_hash(base)?;
    if steps.is_empty() {
        return Err(AppError::InvalidArgument("no rewrite steps".into()));
    }
    for step in steps {
        if step.hashes.is_empty() {
            return Err(AppError::InvalidArgument("empty rewrite step".into()));
        }
        for h in &step.hashes {
            validate_hash(h)?;
        }
        // A multi-hash step with no message is a valid fixup (reuse the leader's
        // message), so no message requirement here — pick/reword/squash/fixup
        // are all expressible.
    }

    // reset --hard would destroy uncommitted work â€” refuse instead.
    let status = run_git(
        Some(repo_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes â€” commit or stash them first".into(),
        ));
    }

    let range = format!("{base}..HEAD");
    let merges = run_git(
        Some(repo_path),
        &["rev-list", "--merges", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !merges.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the range contains merge commits, which can't be rewritten".into(),
        ));
    }
    let in_range: std::collections::HashSet<String> =
        run_git(Some(repo_path), &["rev-list", &range], DEFAULT_TIMEOUT)
            .await?
            .stdout_lossy()
            .lines()
            .map(str::to_string)
            .collect();
    for step in steps {
        for h in &step.hashes {
            if !in_range.contains(h) {
                return Err(AppError::InvalidArgument(format!(
                    "{h} is not an unpushed commit on this branch"
                )));
            }
        }
    }

    let orig = run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    run_git_mutating(state, repo_path, &["reset", "--hard", base], DEFAULT_TIMEOUT).await?;
    let mut failure: Option<AppError> = None;
    'steps: for step in steps {
        let single_pick = step.hashes.len() == 1 && step.message.is_none();
        if single_pick {
            let args = ["cherry-pick", step.hashes[0].as_str()];
            if let Err(e) = run_git_mutating(state, repo_path, &args, DEFAULT_TIMEOUT).await {
                failure = Some(e);
                break 'steps;
            }
        } else {
            let mut args = vec!["cherry-pick", "-n"];
            args.extend(step.hashes.iter().map(String::as_str));
            if let Err(e) = run_git_mutating(state, repo_path, &args, DEFAULT_TIMEOUT).await {
                failure = Some(e);
                break 'steps;
            }
            let message = step.message.as_deref().map(str::trim).unwrap_or("");
            // With a message → squash/reword. Without → fixup: reuse the first
            // (leader) commit's message and authorship.
            let commit_args: Vec<&str> = if message.is_empty() {
                vec!["commit", "-C", step.hashes[0].as_str()]
            } else {
                vec!["commit", "-m", message]
            };
            if let Err(e) =
                run_git_mutating(state, repo_path, &commit_args, DEFAULT_TIMEOUT).await
            {
                failure = Some(e);
                break 'steps;
            }
        }
    }

    if let Some(err) = failure {
        let _ = run_git_mutating(state, repo_path,
            &["cherry-pick", "--abort"],
            DEFAULT_TIMEOUT,
        )
        .await;
        let _ =
            run_git_mutating(state, repo_path, &["reset", "--hard", &orig], DEFAULT_TIMEOUT)
                .await;
        return Err(match err {
            AppError::Git { code, stderr } => AppError::Git {
                code,
                stderr: format!(
                    "The rewrite couldn't be applied (usually a conflict, or a squash/fixup that left nothing to commit) and was rolled back; your branch is unchanged.\n{stderr}"
                ),
            },
            other => other,
        });
    }
    Ok(())
}

/// Rewrites the unpushed tip via a **real, resumable** `git rebase -i` — used
/// when the plan contains an `edit` (the atomic replay engine can't pause).
/// Generates a todo (pick/edit the leader, fixup the folds, and set
/// reword/squash messages with a non-interactive `exec ... commit --amend -F`),
/// injects it with `sequence.editor`, and never opens an editor. When git stops
/// at an `edit` (or a conflict before one) the rebase is left in progress and
/// the conflict/op banner takes over (continue/abort); that's a normal outcome,
/// not an error.
#[tauri::command]
pub async fn git_rebase_edit(
    repo_path: String,
    base: String,
    steps: Vec<RewriteStep>,
) -> AppResult<()> {
    validate_hash(&base)?;
    if steps.is_empty() {
        return Err(AppError::InvalidArgument("no rebase steps".into()));
    }
    for step in &steps {
        if step.hashes.is_empty() {
            return Err(AppError::InvalidArgument("empty rebase step".into()));
        }
        for h in &step.hashes {
            validate_hash(h)?;
        }
    }
    // CRITICAL: refuse if a sequencer op is already mid-flight, BEFORE the
    // scratch-dir clear below — otherwise it would delete the in-flight rebase's
    // pending message files (its `exec ... -F msg` lines would then fail on
    // --continue, losing the message), and the post-run check would mask it as
    // success.
    if git_path_exists(&repo_path, "rebase-merge").await
        || git_path_exists(&repo_path, "rebase-apply").await
        || git_path_exists(&repo_path, "MERGE_HEAD").await
        || git_path_exists(&repo_path, "CHERRY_PICK_HEAD").await
    {
        return Err(AppError::InvalidArgument(
            "a rebase, merge, or cherry-pick is already in progress — finish or abort it from the banner first".into(),
        ));
    }
    // git rebase refuses a dirty tree too, but a clear message here is nicer.
    let status = run_git(
        Some(&repo_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }

    // Scratch dir inside .git for the generated todo + message files. The
    // message files are referenced by `exec` lines that run on each --continue,
    // so they must outlive this call — clear stale ones up front instead.
    let dir = git_dir_path(&repo_path, "gd-rebase-edit")
        .await
        .ok_or_else(|| AppError::InvalidArgument("couldn't resolve the git dir".into()))?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::InvalidArgument(format!("couldn't create scratch dir: {e}")))?;

    let mut todo = String::new();
    for (i, step) in steps.iter().enumerate() {
        todo.push_str(if step.edit { "edit " } else { "pick " });
        todo.push_str(&step.hashes[0]);
        todo.push('\n');
        for fold in &step.hashes[1..] {
            todo.push_str("fixup ");
            todo.push_str(fold);
            todo.push('\n');
        }
        let message = step.message.as_deref().map(str::trim).unwrap_or("");
        if !message.is_empty() {
            let msg_path = dir.join(format!("msg-{i}"));
            std::fs::write(&msg_path, message)
                .map_err(|e| AppError::InvalidArgument(format!("couldn't write message: {e}")))?;
            let msg_fwd = msg_path.to_string_lossy().replace('\\', "/");
            // --no-verify: the message is already composed; don't let a
            // pre-commit/commit-msg hook stall the rebase mid-flight.
            todo.push_str(&format!(
                "exec git commit --amend --no-verify -F \"{msg_fwd}\"\n"
            ));
        }
    }
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, &todo)
        .map_err(|e| AppError::InvalidArgument(format!("couldn't write todo: {e}")))?;
    let todo_fwd = todo_path.to_string_lossy().replace('\\', "/");
    // `sequence.editor` swaps git's generated todo for ours (a plain copy);
    // `core.editor=true` guarantees nothing ever blocks waiting for an editor.
    let seq_editor = format!("sequence.editor=cp \"{todo_fwd}\"");

    let out = run_git_raw(
        Some(&repo_path),
        &[
            "-c",
            "core.editor=true",
            "-c",
            &seq_editor,
            "rebase",
            "-i",
            &base,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;

    // A paused rebase leaves rebase-merge in place — that's the hand-off to the
    // banner, not a failure. Only error when nothing's in progress.
    let rebasing = git_path_exists(&repo_path, "rebase-merge").await
        || git_path_exists(&repo_path, "rebase-apply").await;
    if !rebasing && out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: format!("Couldn't start the rebase.\n{}", out.stderr),
        });
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMessage {
    pub hash: String,
    /// The full commit message (subject + body), so the Edit-history editor can
    /// pre-fill reword/squash fields without truncating multi-line bodies.
    pub message: String,
}

/// Full messages for the unpushed commits `base..HEAD`. NUL-delimited so
/// multi-line bodies survive intact.
#[tauri::command]
pub async fn git_unpushed_messages(
    repo_path: String,
    base: String,
) -> AppResult<Vec<CommitMessage>> {
    validate_hash(&base)?;
    let range = format!("{base}..HEAD");
    let out = run_git(
        Some(&repo_path),
        &["log", "-z", "--format=%H%n%B", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let mut messages = Vec::new();
    for record in text.split('\0') {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        match record.split_once('\n') {
            Some((hash, message)) => messages.push(CommitMessage {
                hash: hash.trim().to_string(),
                message: message.trim_end().to_string(),
            }),
            None => messages.push(CommitMessage {
                hash: record.trim().to_string(),
                message: String::new(),
            }),
        }
    }
    Ok(messages)
}

fn validate_tag_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid tag name: {name}")));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    validate_tag_name(&name)?;
    run_git_mutating(&state, &repo_path, &["tag", "--", &name, &hash], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_push_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    let spec = format!("refs/tags/{name}");
    run_git_mutating(
        &state,
        &repo_path,
        &["push", "origin", &spec],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Deletes a tag locally, and (optionally) from origin too.
#[tauri::command]
pub async fn git_delete_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    on_remote: bool,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    run_git_mutating(
        &state,
        &repo_path,
        &["tag", "-d", "--", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if on_remote {
        let spec = format!(":refs/tags/{name}");
        run_git_mutating(
            &state,
            &repo_path,
            &["push", "origin", &spec],
            crate::git::runner::NETWORK_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

/// Every tag in the repo, newest first. Annotated tags carry their own message
/// + date; lightweight tags fall back to the commit they point at.
#[tauri::command]
pub async fn git_list_tags(repo_path: String) -> AppResult<Vec<TagInfo>> {
    // %(*objectname) is the dereferenced commit for annotated tags (empty for
    // lightweight, where %(objectname) already IS the commit).
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "refs/tags",
            "--format=%(refname:short)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents:subject)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let tags = out
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let object_type = parts.next().unwrap_or("");
            let object_name = parts.next().unwrap_or("");
            let deref = parts.next().unwrap_or("");
            let date = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            Some(TagInfo {
                name,
                target: if deref.is_empty() {
                    object_name.to_string()
                } else {
                    deref.to_string()
                },
                date,
                annotated: object_type == "tag",
                subject,
            })
        })
        .collect();
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dropping(content: &str, lines: &[u32]) -> String {
        remove_lines(content, &lines.iter().copied().collect())
    }

    #[test]
    fn remove_lines_drops_only_selected_and_keeps_the_rest() {
        // 1-based line numbers; line 2 ("b") removed, others byte-identical.
        assert_eq!(dropping("a\nb\nc\n", &[2]), "a\nc\n");
        assert_eq!(dropping("a\nb\nc\n", &[1, 3]), "b\n");
    }

    #[test]
    fn remove_lines_preserves_crlf_and_missing_final_newline() {
        // CRLF: each kept line keeps its "\r\n".
        assert_eq!(dropping("a\r\nb\r\nc\r\n", &[2]), "a\r\nc\r\n");
        // No trailing newline: the last line ("c") has no terminator; removing a
        // middle line leaves the rest exactly as they were.
        assert_eq!(dropping("a\nb\nc", &[2]), "a\nc");
        // Removing the unterminated last line keeps the prior line's "\n".
        assert_eq!(dropping("a\nb\nc", &[3]), "a\nb\n");
    }

    #[test]
    fn remove_lines_can_empty_the_file_and_ignores_unknown_numbers() {
        // Discarding every line leaves an empty file (whole-file delete is a
        // separate path), and out-of-range numbers are simply ignored.
        assert_eq!(dropping("a\nb\n", &[1, 2]), "");
        assert_eq!(dropping("a\nb\n", &[9]), "a\nb\n");
    }

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

    async fn setup_repo(marker: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "gd-rewrite-{marker}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_string_lossy().into_owned();
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit_file(&repo, &dir, "a.txt", "v0\n", "base").await;
        (dir, repo)
    }

    async fn rev(repo: &str, r: &str) -> String {
        git(repo, &["rev-parse", r]).await.trim().to_string()
    }

    async fn subjects(repo: &str) -> Vec<String> {
        git(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn pick(hash: &str) -> RewriteStep {
        RewriteStep {
            hashes: vec![hash.to_string()],
            message: None,
            edit: false,
        }
    }

    #[tokio::test]
    async fn reorder_swaps_independent_commits() {
        let (dir, repo) = setup_repo("reorder").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Oldest-first steps: "two" lands at the bottom, "one" on top.
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn squash_combines_commits() {
        let (dir, repo) = setup_repo("squash").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1, c2],
                message: Some("combined".into()),
                edit: false,
            }],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["combined", "base"]);
        assert!(dir.join("b.txt").exists());
        assert!(dir.join("c.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn fixup_keeps_leader_message() {
        let (dir, repo) = setup_repo("fixup").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "b.txt", "b\n", "keep this message").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "c.txt", "c\n", "discard me").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Multi-hash step with NO message = fixup: collapse c1+c2 but reuse c1's
        // message ("keep this message"), dropping c2's.
        rewrite_commits(
            &state,
            &repo,
            &base,
            &[RewriteStep {
                hashes: vec![c1, c2],
                message: None,
                edit: false,
            }],
        )
        .await
        .unwrap();
        assert_eq!(subjects(&repo).await, vec!["keep this message", "base"]);
        assert!(dir.join("b.txt").exists());
        assert!(dir.join("c.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn conflicting_rewrite_rolls_back() {
        let (dir, repo) = setup_repo("conflict").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // "two"'s patch (v1→v2) can't apply onto v0 — conflict, then rollback.
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)]).await;
        assert!(result.is_err());
        assert_eq!(rev(&repo, "HEAD").await, orig);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rebase_edit_refuses_a_concurrent_op() {
        let (dir, repo) = setup_repo("reentry").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, &dir, "x.txt", "x\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        // Simulate an in-progress rebase via its marker dir.
        std::fs::create_dir_all(std::path::Path::new(&repo).join(".git/rebase-merge"))
            .unwrap();
        let step = RewriteStep {
            hashes: vec![c1],
            message: None,
            edit: true,
        };
        let result = git_rebase_edit(repo.clone(), base, vec![step]).await;
        assert!(
            result.is_err(),
            "must refuse a new edit-rebase while one is in progress"
        );
        // The guard runs before the scratch-dir clear, so it's never created —
        // the in-flight rebase's message files are left untouched.
        assert!(
            !std::path::Path::new(&repo)
                .join(".git/gd-rebase-edit")
                .exists(),
            "scratch dir must not be touched when refused"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn merge_preview_reports_outcomes() {
        let (dir, repo) = setup_repo("preview").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        commit_file(&repo, &dir, "shared.txt", "base\n", "base shared").await;

        // up-to-date: a branch pinned at an ancestor of HEAD.
        git(&repo, &["branch", "old"]).await;
        commit_file(&repo, &dir, "shared.txt", "main2\n", "advance main").await;
        let up = git_merge_preview(repo.clone(), "old".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(up.status, "up-to-date");

        // fast-forward: a branch strictly ahead of HEAD.
        git(&repo, &["checkout", "-b", "ahead"]).await;
        commit_file(&repo, &dir, "ahead.txt", "a\n", "ahead only").await;
        git(&repo, &["checkout", &main]).await;
        let ff = git_merge_preview(repo.clone(), "ahead".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(ff.status, "fast-forward");

        // conflict: divergent edits to shared.txt (needs git merge-tree, 2.38+).
        git(&repo, &["checkout", "-b", "feat"]).await;
        commit_file(&repo, &dir, "shared.txt", "feat\n", "feat edit").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, &dir, "shared.txt", "main3\n", "main edit").await;
        let cf = git_merge_preview(repo.clone(), "feat".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(cf.status, "conflict", "conflicts: {:?}", cf.conflicts);
        assert!(
            cf.conflicts.iter().any(|f| f.contains("shared.txt")),
            "{:?}",
            cf.conflicts
        );

        // A content conflict auto-resolves with -X (strategy-aware preview) →
        // the same merge predicts "clean" once a side is chosen.
        let resolved =
            git_merge_preview(repo.clone(), "feat".to_string(), "theirs".to_string())
                .await
                .unwrap();
        assert_eq!(resolved.status, "clean", "{:?}", resolved.conflicts);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Makes a throwaway dir and writes `.gitignore` with the given raw bytes.
    fn gitignore_dir(marker: &str, content: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!(
            "gd-unignore-{marker}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), content).unwrap();
        let repo = dir.to_string_lossy().into_owned();
        (dir, repo)
    }

    fn rule(pattern: &str) -> UnignoreRule {
        UnignoreRule {
            source: ".gitignore".into(),
            pattern: pattern.into(),
        }
    }

    #[tokio::test]
    async fn unignore_preserves_crlf_and_comments() {
        // A Windows .gitignore (CRLF) with a comment and two rules.
        let (dir, repo) = gitignore_dir("crlf", "# build artifacts\r\n*.log\r\nbuild/\r\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        // CRLF kept, comment + the untouched rule kept, trailing CRLF kept.
        assert_eq!(out, "# build artifacts\r\nbuild/\r\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unignore_last_rule_keeps_trailing_newline() {
        let (dir, repo) = gitignore_dir("last", "*.log\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        // Removing the only rule leaves a single newline, not a 0-byte file.
        assert_eq!(out, "\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unignore_strips_and_restores_bom() {
        // A UTF-8 BOM ahead of the first (targeted) rule must not block the match.
        let (dir, repo) = gitignore_dir("bom", "\u{feff}*.log\nbuild/\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.join(".gitignore")).unwrap();
        assert_eq!(out, "\u{feff}build/\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
