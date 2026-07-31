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

/// Refuses when the working tree has **tracked** changes (staged or unstaged).
///
/// Compound ops whose failure path does `reset --hard` (local-PR merge,
/// cherry-pick-onto) MUST call this before their first mutation: a protective
/// `switch <target>` is a no-op when target IS the current branch, so a dirty
/// tree would otherwise flow into the destructive reset. Untracked files are
/// deliberately allowed — `reset --hard` never removes them, and a merge that
/// would clobber one is refused by git itself.
async fn ensure_clean_tree(repo: &str) -> AppResult<()> {
    let status = run_git(
        Some(repo),
        &["status", "--porcelain", "--untracked-files=no"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
        ));
    }
    Ok(())
}

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
        .rfind(|l| !l.trim().is_empty())
        .map(|last| {
            let cmd = last.split_whitespace().next().unwrap_or("");
            cmd == "edit" || cmd == "e"
        })
        .unwrap_or(false)
}

/// Which multi-step git operation, if any, is mid-flight — drives the
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

/// Discards selected 1-based lines from an untracked (new) file by deleting them
/// in place. A new file's diff is all additions, so there is no index/patch to
/// reverse-apply (reverse-applying a new-file patch would delete the whole file).
/// The file stays untracked; discarding every line leaves it empty (whole-file
/// removal is `git_discard_paths`' recycle-bin path).
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
    git_reset_core(&state, repo_path, hash).await
}

pub(crate) async fn git_reset_core(
    state: &AppState,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    run_git_mutating(state, &repo_path, &["reset", "--mixed", &hash], DEFAULT_TIMEOUT).await?;
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
    git_revert_core(&state, repo_path, hash).await
}

pub(crate) async fn git_revert_core(
    state: &AppState,
    repo_path: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    // -m is not supported here; reverting merge commits needs a parent choice
    run_git_mutating(state, &repo_path, &["revert", "--no-edit", &hash], DEFAULT_TIMEOUT)
        .await?;
    Ok(())
}

/// Returns true when a commit was created. Cherry-picking changes that are
/// already present makes git stop with an in-progress empty pick; that's not
/// an error worth surfacing raw — clean up with --skip and report false.
#[tauri::command]
pub async fn git_cherry_pick(
    state: State<'_, AppState>,
    repo_path: String,
    hash: String,
) -> AppResult<bool> {
    git_cherry_pick_core(&state, repo_path, hash).await
}

pub(crate) async fn git_cherry_pick_core(
    state: &AppState,
    repo_path: String,
    hash: String,
) -> AppResult<bool> {
    validate_hash(&hash)?;
    match run_git_mutating(state, &repo_path, &["cherry-pick", &hash], DEFAULT_TIMEOUT).await {
        Ok(_) => Ok(true),
        Err(AppError::Git { stderr, .. })
            if stderr.contains("is now empty") || stderr.contains("--allow-empty") =>
        {
            let _ = run_git_mutating(
                state,
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
/// rolled back — the target branch is reset to its prior tip and you return to
/// where you started — so the repo is never left mid-conflict.
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
    // The failure path hard-resets `target` to its prior tip, which would discard
    // uncommitted work when target is the current branch — refuse first.
    ensure_clean_tree(&repo_path).await?;

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

    // Journal a pending entry AFTER the guards + state capture, BEFORE the first
    // mutation. Best-effort: a journal failure returns None and the op proceeds.
    let original_sha = run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await
        .ok()
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_default();
    let label = format!(
        "Cherry-pick {} commit(s) onto {target_branch}",
        hashes.len()
    );
    let original_ref_label = if detached {
        "HEAD".to_string()
    } else {
        original_restore.clone()
    };
    let op_id = crate::oplog::begin(
        &repo_path,
        "cherry_pick_onto",
        &label,
        Some(original_ref_label),
        &original_sha,
        Some(&target_tip),
    )
    .await;

    let result: AppResult<CherryPickRangeResult> = async {
        run_git_mutating(&state, &repo_path, &["switch", &target_branch], DEFAULT_TIMEOUT).await?;

        let mut applied = 0usize;
        let mut skipped = 0usize;
        for hash in &hashes {
            match run_git_mutating(&state, &repo_path, &["cherry-pick", hash], DEFAULT_TIMEOUT).await
            {
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
                    let _ =
                        run_git_mutating(&state, &repo_path, &restore_args, DEFAULT_TIMEOUT).await;
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
    .await;

    crate::oplog::finish(
        &repo_path,
        &op_id,
        result.as_ref().err().map(|e| e.to_string()),
    )
    .await;
    result
}

/// Discards every uncommitted change: untracked files go to the recycle bin,
/// tracked changes are hard-reset to HEAD.
#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_discard_all_core(&state, repo_path).await
}

pub(crate) async fn git_discard_all_core(state: &AppState, repo_path: String) -> AppResult<()> {
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
        run_git_mutating(state, &repo_path, &["reset", "--hard", "HEAD"], DEFAULT_TIMEOUT)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_stash_all(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_stash_all_core(&state, repo_path).await
}

pub(crate) async fn git_stash_all_core(state: &AppState, repo_path: String) -> AppResult<()> {
    run_git_mutating(
        state,
        &repo_path,
        &["stash", "push", "--include-untracked"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// One selected file to discard, paired with whether it's untracked (which
/// decides recycle-bin vs. `git restore`).
#[derive(serde::Deserialize)]
pub struct DiscardPath {
    pub path: String,
    pub untracked: bool,
}

/// Discards working-tree changes for a selection of files: tracked files are
/// restored from the index, untracked files go to the OS recycle bin. The
/// scoped analogue of `git_discard_all`.
#[tauri::command]
pub async fn git_discard_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<DiscardPath>,
) -> AppResult<()> {
    git_discard_paths_core(&state, repo_path, paths).await
}

pub(crate) async fn git_discard_paths_core(
    state: &AppState,
    repo_path: String,
    paths: Vec<DiscardPath>,
) -> AppResult<()> {
    let untracked: Vec<String> = paths
        .iter()
        .filter(|p| p.untracked)
        .map(|p| p.path.clone())
        .collect();
    // Literal pathspecs: a `[slug]`-style path would otherwise also restore its
    // glob-siblings, discarding edits the user never selected. The untracked half
    // below takes the path as a filesystem name instead, so it must stay raw.
    let tracked: Vec<String> = paths
        .iter()
        .filter(|p| !p.untracked)
        .map(|p| crate::git::pathspec::literal(&p.path))
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
        run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

/// Stashes only the selected files (their tracked changes plus any untracked
/// matches), leaving the rest of the working tree in place. Creates a single
/// stash entry; `git stash push` with a pathspec no-ops cleanly if nothing
/// matches. `true` means an entry was actually created.
#[tauri::command]
pub async fn git_stash_paths(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<bool> {
    git_stash_paths_core(&state, repo_path, paths).await
}

/// `Ok(false)` when the selection matched nothing and no stash entry was
/// created — the caller decides how to report that, since `git stash push`
/// itself exits 0 either way.
pub(crate) async fn git_stash_paths_core(
    state: &AppState,
    repo_path: String,
    mut paths: Vec<String>,
) -> AppResult<bool> {
    // An empty-string entry is not a valid pathspec (`fatal: empty string is not a
    // valid pathspec`) and would fail every git call below; drop those. Do NOT trim
    // whitespace — space-prefixed/suffixed filenames are legal and GUI paths arrive
    // verbatim from `git status`, so trimming would corrupt them.
    paths.retain(|p| !p.is_empty());
    if paths.is_empty() {
        return Ok(false);
    }

    // A native `git stash push -- <paths>` always snapshots the WHOLE index into
    // the stash's index-commit (`^2`), so any OTHER staged file rides along and can
    // resurrect on `pop --index`. To capture only the selection, hold the per-repo
    // lock across the whole compound sequence and use the lock-free `run_git` for
    // every step while holding it — `repo_lock` is a non-reentrant
    // `tokio::sync::Mutex`, so `run_git_mutating` would re-acquire it and deadlock.
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;

    // Refuse during a merge (unmerged index): a native `git stash push` can't write
    // the index mid-conflict, and the selective slow path can't snapshot it either
    // (`git write-tree` fails on unmerged entries). Guarding both paths here is what
    // keeps us from leaving a partial mutation or a stash.
    let unmerged = run_git(
        Some(&repo_path),
        &["ls-files", "--unmerged"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !unmerged.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "Can't stash while a merge conflict is in progress — resolve the conflicts first."
                .into(),
        ));
    }

    // Enumerate EVERY path staged vs HEAD, NUL-safe. `--no-renames` decomposes a
    // staged rename into delete+add so the subtraction sees stable per-path names
    // (an unselected half is preserved via reset/restore like any other staged path).
    let all_out = run_git(
        Some(&repo_path),
        &["diff", "--cached", "--no-renames", "-z", "--name-only"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let all_staged: Vec<String> = all_out
        .stdout_lossy()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();

    // Enumerate the staged files MATCHED by the selection via git's own pathspec
    // resolution (`diff --cached -- <paths>`), so `unselected_staged` is
    // definitionally consistent with what `stash push -- <paths>` will sweep —
    // directory args, globs and case-insensitive filesystems all resolve identically
    // (an exact string match against the enumeration would misclassify them).
    // Chunked at 100 for the Windows argv limit; a pathspec matching nothing staged
    // contributes nothing and still exits 0 (so `run_git`'s error-on-nonzero doesn't trip).
    let mut selected_staged: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in paths.chunks(100) {
        let mut args = vec!["diff", "--cached", "--no-renames", "-z", "--name-only", "--"];
        args.extend(chunk.iter().map(String::as_str));
        let matched = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
        selected_staged.extend(
            matched
                .stdout_lossy()
                .split('\0')
                .filter(|p| !p.is_empty())
                .map(str::to_string),
        );
    }

    // Literal pathspecs for the re-feed below: these are concrete paths git just
    // enumerated, and steps (a)/(c) hand them BACK to git as patterns. A raw
    // `src/app/[slug]/page.tsx` would reset and re-stage its glob-siblings too —
    // including selected ones this compound op is mid-way through stashing.
    let unselected_staged: Vec<String> = all_staged
        .iter()
        .filter(|p| !selected_staged.contains(*p))
        .map(|p| crate::git::pathspec::literal(p))
        .collect();

    let mut stash_args = vec!["stash", "push", "--include-untracked", "--"];
    stash_args.extend(paths.iter().map(String::as_str));

    // A pathspec matching nothing still exits 0, so this stdout line is the only
    // signal that no entry was created; `run_git` pins `LC_ALL=C` to keep it stable.
    fn created_entry(out: &crate::git::runner::GitOutput) -> bool {
        !out.stdout_lossy()
            .trim_start()
            .starts_with("No local changes to save")
    }

    // Fast path: no other staged file to protect, so the native pathspec stash is
    // already exact.
    if unselected_staged.is_empty() {
        let out = run_git(Some(&repo_path), &stash_args, DEFAULT_TIMEOUT).await?;
        return Ok(created_entry(&out));
    }

    // Snapshot the full index so the unselected files' exact staged blobs can be
    // restored afterward. A `write-tree` failure aborts pre-mutation and propagates
    // RAW: the `ls-files --unmerged` guard above already reported the merge case, so
    // a failure reaching here is something else (corruption/permissions) and must
    // not be mislabeled as a merge.
    let full_tree = run_git(Some(&repo_path), &["write-tree"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    // Do the mutation, then ALWAYS restore the unselected index — even if the stash
    // step errors, else the unselected staged files are left unstaged. The chaining
    // below lets the primary (mutate) error win; otherwise the restore error surfaces.
    let mutate: AppResult<bool> = async {
        // a. Unstage the unselected staged paths (index only; worktree untouched).
        //    Chunk at 100 for the Windows argv limit (mirror git_discard_paths_core).
        for chunk in unselected_staged.chunks(100) {
            let mut args = vec!["reset", "-q", "--"];
            args.extend(chunk.iter().map(String::as_str));
            run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
        }
        // b. Native pathspec stash of the selection — EXACTLY ONE call (chunking
        //    would create multiple stash entries). The `^2` index-commit is now
        //    clean: the index holds only the selected staged changes.
        let out = run_git(Some(&repo_path), &stash_args, DEFAULT_TIMEOUT).await?;
        Ok(created_entry(&out))
    }
    .await;

    // c. Restore the exact staged blobs for the unselected paths (index only, no
    //    worktree). An unselected staged NEW file became untracked after its
    //    `reset`; the stash's selection-only pathspec did not sweep it, and this
    //    re-adds it.
    let source_arg = format!("--source={full_tree}");
    let mut restore: AppResult<()> = Ok(());
    for chunk in unselected_staged.chunks(100) {
        let mut args = vec!["restore", "--staged", source_arg.as_str(), "--"];
        args.extend(chunk.iter().map(String::as_str));
        if let Err(e) = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await {
            restore = Err(e);
            break;
        }
    }

    mutate.and_then(|created| restore.map(|()| created))
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
    git_stash_pop_core(&state, repo_path).await
}

pub(crate) async fn git_stash_pop_core(state: &AppState, repo_path: String) -> AppResult<()> {
    run_git_mutating(state, &repo_path, &["stash", "pop"], DEFAULT_TIMEOUT).await?;
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
///
/// Trimming is git's own (`trim_ignore_pattern`), not `str::trim`: a blanket trim
/// collapses `/notes\ ` and `/notes\` to the same key, so unignoring either rule
/// would delete both lines.
#[tauri::command]
pub async fn git_unignore_rules(repo_path: String, rules: Vec<UnignoreRule>) -> AppResult<()> {
    let mut by_source: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in rules {
        let pat = crate::fsops::trim_ignore_pattern(&r.pattern).to_string();
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
        // Strip a leading UTF-8 BOM for processing (it is not whitespace, so it
        // rides on the first line and breaks the pattern match), and restore it
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
            .filter(|l| {
                !patterns
                    .iter()
                    .any(|p| crate::fsops::trim_ignore_pattern(l) == p)
            })
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

/// Outcome of an applied suggestion — what actually happened, for honest toasts.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLinesResult {
    /// True when the file was staged after the edit (only when it had no other
    /// local changes before the apply, so the index gains exactly this edit).
    pub staged: bool,
    /// Whether the file already had local changes (staged or unstaged) BEFORE
    /// the apply — when true we never auto-stage (it would sweep those in too).
    pub had_local_changes: bool,
}

/// Applies a reviewer `suggestion` to the local working tree: replaces the
/// `expected_lines` at `start_line` with `replacement_lines`, but only after
/// verifying the file still holds exactly `expected_lines` there (so an Apply
/// on a drifted/outdated file is refused rather than corrupting it). The
/// suggestion semantics (which lines, what replacement) live in the frontend;
/// this is the provider-agnostic git-working-tree primitive behind them.
#[tauri::command]
pub async fn git_replace_file_lines(
    state: State<'_, AppState>,
    repo_path: String,
    file_path: String,
    start_line: u32,
    expected_lines: Vec<String>,
    replacement_lines: Vec<String>,
    stage_when_clean: bool,
) -> AppResult<ApplyLinesResult> {
    replace_file_lines(
        &state,
        &repo_path,
        &file_path,
        start_line,
        &expected_lines,
        &replacement_lines,
        stage_when_clean,
    )
    .await
}

/// Testable core of [`git_replace_file_lines`] — takes a plain `&AppState` so
/// the real-repo tokio tests can drive it (mirrors `rewrite_commits`).
pub(crate) async fn replace_file_lines(
    state: &AppState,
    repo_path: &str,
    file_path: &str,
    start_line: u32,
    expected_lines: &[String],
    replacement_lines: &[String],
    stage_when_clean: bool,
) -> AppResult<ApplyLinesResult> {
    // Pre-mutation validation: every locally-checkable precondition before we
    // touch the file, each with a specific message.
    if start_line < 1 {
        return Err(AppError::InvalidArgument(
            "start_line must be 1-based (>= 1)".into(),
        ));
    }
    if expected_lines.is_empty() {
        return Err(AppError::InvalidArgument(
            "expected_lines must not be empty — a suggestion replaces at least one line".into(),
        ));
    }
    let rel = Path::new(file_path);
    if rel.is_absolute() || file_path.is_empty() {
        return Err(AppError::InvalidArgument(format!(
            "file_path must be repo-relative: {file_path}"
        )));
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::InvalidArgument(format!(
            "file_path must not contain '..' traversal: {file_path}"
        )));
    }

    // Hold the repo's mutating lock across the WHOLE dirty-check → read → verify →
    // write → stage sequence, not just the final `git add`: otherwise two concurrent
    // Apply calls on different ranges of one file interleave and the second silently
    // overwrites the first's write. `repo_lock` is a `tokio::sync::Mutex` (safe to
    // hold across `.await`) but non-reentrant — use the lock-free `run_git` below,
    // never `run_git_mutating`, which would deadlock.
    let lock = state.repo_lock(repo_path).await;
    let _guard = lock.lock().await;

    let repo_root = std::path::Path::new(repo_path);
    let target = repo_root.join(rel);
    // Resolve the repo root and target, then confirm the target stays inside the
    // repo (defends against symlink/`..` escapes the string check can miss).
    let canon_root = tokio::fs::canonicalize(repo_root)
        .await
        .map_err(|_| AppError::InvalidArgument(format!("repo_path does not exist: {repo_path}")))?;
    let canon_target = tokio::fs::canonicalize(&target).await.map_err(|_| {
        AppError::InvalidArgument(format!("file does not exist: {file_path}"))
    })?;
    if !canon_target.starts_with(&canon_root) {
        return Err(AppError::InvalidArgument(format!(
            "file_path resolves outside the repository: {file_path}"
        )));
    }
    let meta = tokio::fs::metadata(&canon_target).await.map_err(AppError::Io)?;
    if !meta.is_file() {
        return Err(AppError::InvalidArgument(format!(
            "file_path is not a regular file: {file_path}"
        )));
    }

    // Dirty check BEFORE the edit: any porcelain output for this path means the
    // file already had staged/unstaged changes, so we must not auto-stage. Literal
    // pathspec — a glob-sibling's dirtiness must not decide this file's fate.
    let spec = crate::git::pathspec::literal(file_path);
    let status = run_git(
        Some(repo_path),
        &["status", "--porcelain", "--", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let had_local_changes = !status.stdout_lossy().trim().is_empty();

    // Read the file and verify the range still matches the suggestion's anchor.
    let raw = tokio::fs::read_to_string(&canon_target)
        .await
        .map_err(AppError::Io)?;
    // Same BOM/EOL idiom as `git_unignore_rules`: strip a leading BOM and restore
    // it, and preserve the file's line ending (`lines()` drops both \n and \r\n).
    let (has_bom, content) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => (true, rest),
        None => (false, raw.as_str()),
    };
    let ending = if content.contains("\r\n") { "\r\n" } else { "\n" };

    let existing: Vec<&str> = content.lines().collect();
    let start = (start_line - 1) as usize;
    let end = start + expected_lines.len();
    // Range beyond EOF, or any line differing, is a mismatch — the file drifted.
    let matches = end <= existing.len()
        && existing[start..end]
            .iter()
            .zip(expected_lines.iter())
            .all(|(have, want)| *have == want.as_str());
    if !matches {
        // Drift is a legitimate state, not a caller bug — use `Command` so its
        // bare Display surfaces cleanly in the UI toast (InvalidArgument's
        // "invalid argument: " prefix would leak into user-facing copy).
        return Err(AppError::Command(format!(
            "{file_path} has changed since the suggestion was made — the lines to replace no longer match"
        )));
    }

    let mut next_lines: Vec<&str> = Vec::with_capacity(
        existing.len() - expected_lines.len() + replacement_lines.len(),
    );
    next_lines.extend_from_slice(&existing[..start]);
    next_lines.extend(replacement_lines.iter().map(String::as_str));
    next_lines.extend_from_slice(&existing[end..]);
    let mut next = next_lines.join(ending);
    // Preserve the file's trailing-newline presence (even if the edit emptied it).
    if content.ends_with('\n') {
        next.push_str(ending);
    }
    if has_bom {
        next.insert(0, '\u{feff}');
    }
    tokio::fs::write(&canon_target, next)
        .await
        .map_err(AppError::Io)?;

    // Stage only when asked AND the file was otherwise clean, so the index gains
    // exactly this edit. Lock-free `run_git` — we already hold the repo lock.
    let staged = stage_when_clean && !had_local_changes;
    if staged {
        run_git(Some(repo_path), &["add", "--", &spec], DEFAULT_TIMEOUT).await?;
    }

    Ok(ApplyLinesResult {
        staged,
        had_local_changes,
    })
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
            // %gd is "stash@{N}" — the N is the index every other stash
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

/// A stash commit that has fallen out of `git stash list` (dropped, or
/// orphaned by an interrupted operation) but still holds recoverable work,
/// found by walking dangling commits.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanedStash {
    pub sha: String,
    pub message: String,
    pub date: String,
    pub file_count: u32,
}

/// The files a stash-shaped ref holds, including untracked ones, keyed by a
/// ref spec (`stash@{N}` for a live stash, or a raw sha for a dangling one).
async fn stash_files_at(repo: &str, spec: &str) -> AppResult<Vec<StashFile>> {
    let out = run_git(
        Some(repo),
        &[
            "stash",
            "show",
            "--numstat",
            "-z",
            "--include-untracked",
            spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let entries = parse_numstat_z(&out.stdout_lossy());

    // Paths in the untracked parent (^3, present only when untracked files
    // were stashed) need their "new" content read from there.
    let untracked_ref = format!("{spec}^3");
    let mut untracked = std::collections::HashSet::new();
    if let Ok(o) = run_git(
        Some(repo),
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

/// One file's diff from a stash-shaped ref. Tracked changes diff the stash
/// against its base (`^1`); untracked files live in the stash's third parent
/// (`^3`, created by `--include-untracked`), so an empty tracked diff falls
/// back to that. `spec` is `stash@{N}` for a live stash or a raw sha.
async fn stash_file_diff_at(repo: &str, spec: &str, file_path: &str) -> AppResult<FileDiff> {
    let base = format!("{spec}^1");
    // Literal pathspec: the path comes from the stash's own file list, so a
    // `[slug]`-style name would splice a glob-sibling's hunks into this file's diff.
    let path_spec = crate::git::pathspec::literal(file_path);
    let out = run_git(
        Some(repo),
        &["diff", "--no-color", &base, spec, "--", &path_spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();
    if text.trim().is_empty() {
        // Not a tracked change — try the untracked-files parent if present.
        let untracked = format!("{spec}^3");
        if let Ok(o) = run_git(
            Some(repo),
            &["diff", "--no-color", &base, &untracked, "--", &path_spec],
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
        file_path: file_path.to_string(),
        is_binary,
        is_truncated,
        text,
    })
}

/// The files a stash holds, including untracked ones, so it can be browsed
/// file by file instead of as one combined diff (where a single binary file
/// would mark the whole preview unreadable).
#[tauri::command]
pub async fn git_stash_files(repo_path: String, index: u32) -> AppResult<Vec<StashFile>> {
    stash_files_at(&repo_path, &format!("stash@{{{index}}}")).await
}

/// One file's diff from a stash — see [`stash_file_diff_at`] for the `^1`/`^3`
/// tracked-vs-untracked resolution.
#[tauri::command]
pub async fn git_stash_file_diff(
    repo_path: String,
    index: u32,
    file_path: String,
) -> AppResult<FileDiff> {
    stash_file_diff_at(&repo_path, &format!("stash@{{{index}}}"), &file_path).await
}

/// Find dangling stash commits — work a `git stash` created that has since
/// fallen out of `git stash list` (dropped, or abandoned by an interrupted
/// operation). Walks `git fsck` dangling commits, keeps only stash-shaped
/// ones not already live, and reports each with its file count, newest first.
#[tauri::command]
pub async fn git_orphaned_stashes(repo_path: String) -> AppResult<Vec<OrphanedStash>> {
    let fsck = run_git(
        Some(&repo_path),
        &["fsck", "--no-progress"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let candidates: Vec<String> = fsck
        .stdout_lossy()
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next(), parts.next()) {
                (Some("dangling"), Some("commit"), Some(sha)) => Some(sha.to_string()),
                _ => None,
            }
        })
        .collect();

    // Shas already live in `git stash list` — don't double-list them.
    let live = run_git(
        Some(&repo_path),
        &["stash", "list", "--format=%H"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let live: std::collections::HashSet<String> = live
        .stdout_lossy()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    let mut out: Vec<OrphanedStash> = Vec::new();
    for sha in candidates {
        if live.contains(&sha) {
            continue;
        }
        // Tolerant: a candidate whose metadata won't parse is simply skipped
        // rather than failing the whole list.
        let Ok(meta) = run_git(
            Some(&repo_path),
            &["log", "-1", "--format=%s%x00%cI%x00%P", &sha],
            DEFAULT_TIMEOUT,
        )
        .await
        else {
            continue;
        };
        let meta = meta.stdout_lossy();
        let mut parts = meta.trim_end_matches('\n').splitn(3, '\0');
        let (Some(subject), Some(date), Some(parents)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        // Stash-shaped: a `WIP on <branch>:`/`On <branch>:` subject and at
        // least two parents (base + index; a third holds untracked files).
        if !(subject.starts_with("WIP on ") || subject.starts_with("On ")) {
            continue;
        }
        if parents.split_whitespace().count() < 2 {
            continue;
        }
        let file_count = stash_files_at(&repo_path, &sha)
            .await
            .map(|f| f.len() as u32)
            .unwrap_or(0);
        out.push(OrphanedStash {
            sha,
            message: subject.to_string(),
            date: date.to_string(),
            file_count,
        });
    }

    // Newest first by committer date (ISO 8601 sorts lexically).
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

/// The files a dangling (orphaned) stash holds, browsed by sha.
#[tauri::command]
pub async fn git_orphaned_stash_files(
    repo_path: String,
    sha: String,
) -> AppResult<Vec<StashFile>> {
    validate_hash(&sha)?;
    stash_files_at(&repo_path, &sha).await
}

/// One file's diff from a dangling (orphaned) stash, by sha.
#[tauri::command]
pub async fn git_orphaned_stash_file_diff(
    repo_path: String,
    sha: String,
    file_path: String,
) -> AppResult<FileDiff> {
    validate_hash(&sha)?;
    stash_file_diff_at(&repo_path, &sha, &file_path).await
}

/// Restore a dangling (orphaned) stash into the working tree. Applies (never
/// drops or commits); a conflict surfaces through the normal error path.
#[tauri::command]
pub async fn git_restore_orphaned(
    state: State<'_, AppState>,
    repo_path: String,
    sha: String,
) -> AppResult<()> {
    validate_hash(&sha)?;
    run_git_mutating(&state, &repo_path, &["stash", "apply", &sha], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_apply(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
    pop: bool,
) -> AppResult<()> {
    git_stash_apply_core(&state, repo_path, index, pop).await
}

pub(crate) async fn git_stash_apply_core(
    state: &AppState,
    repo_path: String,
    index: u32,
    pop: bool,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    run_git_mutating(state, &repo_path, &["stash", sub, &spec], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_stash_drop(
    state: State<'_, AppState>,
    repo_path: String,
    index: u32,
) -> AppResult<()> {
    git_stash_drop_core(&state, repo_path, index).await
}

pub(crate) async fn git_stash_drop_core(
    state: &AppState,
    repo_path: String,
    index: u32,
) -> AppResult<()> {
    let spec = format!("stash@{{{index}}}");
    run_git_mutating(
        state,
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

/// Merges a branch into the current one. With `squash` the combined changes are
/// left staged so the user writes the commit. Otherwise `no_ff` forces a merge
/// commit even when a fast-forward is possible, and `strategy` ("ours"/"theirs",
/// anything else = none) auto-resolves conflicting hunks toward the current /
/// incoming side via `-X`. Unresolved conflicts leave a normal merge-conflict state.
#[tauri::command]
pub async fn git_merge(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    squash: bool,
    no_ff: bool,
    strategy: String,
) -> AppResult<()> {
    git_merge_core(&state, repo_path, branch, squash, no_ff, strategy).await
}

pub(crate) async fn git_merge_core(
    state: &AppState,
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
    run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
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

/// Predicts merging `branch` into the current branch **without touching the
/// working tree or index**: merge-base for the up-to-date / fast-forward cases,
/// then `git merge-tree --write-tree` (needs git 2.38+; file names need 2.40+) for
/// a real in-memory merge, honoring `strategy` ("ours"/"theirs" → `-X`) so the
/// prediction matches the real merge — content conflicts auto-resolve, structural
/// ones still report as conflicts. Older git or any error degrades to "unknown"
/// so the UI hides the preview.
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
/// progress — the changes panel's conflict banner takes it from there
/// (continue or abort).
#[tauri::command]
pub async fn git_rebase(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
) -> AppResult<()> {
    git_rebase_core(&state, repo_path, branch).await
}

pub(crate) async fn git_rebase_core(
    state: &AppState,
    repo_path: String,
    branch: String,
) -> AppResult<()> {
    validate_branch_arg(&branch)?;
    run_git_mutating(
        state,
        &repo_path,
        &["-c", "core.editor=true", "rebase", &branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Rebases the current branch onto `new_base`, replaying **only** the commits
/// after `old_base` (`old_base..HEAD`). This is the "I branched off the wrong
/// branch" fix: `git rebase --onto <new_base> <old_base>` excludes `old_base`'s
/// own commits, whereas a plain `git rebase <new_base>` would drag them along.
/// Conflicts leave the rebase in progress — the changes panel's conflict banner
/// (driven by `git_op_state`) takes it from there via continue/abort.
async fn rebase_onto(
    state: &AppState,
    repo_path: &str,
    new_base: &str,
    old_base: &str,
) -> AppResult<()> {
    validate_branch_arg(new_base)?;
    validate_branch_arg(old_base)?;
    run_git_mutating(
        state,
        repo_path,
        &[
            "-c",
            "core.editor=true",
            "rebase",
            "--onto",
            new_base,
            old_base,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn git_rebase_onto(
    state: State<'_, AppState>,
    repo_path: String,
    new_base: String,
    old_base: String,
) -> AppResult<()> {
    rebase_onto(&state, &repo_path, &new_base, &old_base).await
}

/// The outcome of a local-PR merge attempt (`git_merge_local_pr` /
/// `git_finish_local_pr_merge`). The frontend consumes this verbatim, so the
/// `#[serde(rename_all = "camelCase")]` shape is a frozen contract.
///
/// Conflicts are resolved in an isolated DETACHED worktree (GitHub-style): the
/// user's current branch and uncommitted work are never touched, so on a conflict
/// the tree lives in a throwaway worktree (`worktree_id` / `worktree_path`) that
/// the frontend points its conflict editor at.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPrMergeOutcome {
    /// `"merged"` (the merge landed and `base` was advanced) or `"conflicts"`
    /// (the merge is paused in the resolve worktree for the user to resolve).
    pub status: String,
    /// Unmerged paths **in the resolve worktree** (empty when merged). From
    /// `diff --name-only --diff-filter=U` run with cwd = the worktree.
    pub conflicts: Vec<String>,
    /// A commit sha for display only: base's tip at the start of the op on the
    /// initial call, the resolved/merged commit on finish.
    pub base_tip: String,
    /// The resolve worktree's id — set only on `"conflicts"`, threaded to
    /// finish/abort so they can find and tear it down. `None` when merged.
    pub worktree_id: Option<String>,
    /// Absolute path to the resolve worktree — set only on `"conflicts"`. The
    /// frontend points its conflict editor here. `None` when merged.
    pub worktree_path: Option<String>,
    /// The oplog entry id, threaded to finish/abort so they can close it.
    pub op_id: Option<String>,
}

/// The current unmerged (conflicted) paths in `repo`'s working tree, via
/// `diff --name-only --diff-filter=U`. Uses `run_git_raw` so a non-zero exit
/// (e.g. mid-operation) is treated as "no readable conflicts" rather than an
/// error. Empty ⇒ no conflicts / a clean tree.
async fn unmerged_paths(repo_path: &str) -> Vec<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["diff", "--name-only", "--diff-filter=U"],
        DEFAULT_TIMEOUT,
    )
    .await;
    match out {
        Ok(o) if o.code == 0 => o
            .stdout_lossy()
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// A short, stable hash of the repo path, kept in sync BY HAND with
/// `worktree.rs::repo_hash` (both hash the lower-cased path with `DefaultHasher`).
/// Resolve worktrees must land under the same `<app_data>/worktrees/<repo-hash>`
/// root, because that placement is what makes `git_worktree_list_user` hide them
/// from the user-facing worktree manager (`is_session_worktree`'s app-data check).
fn repo_hash(repo_path: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    repo_path.to_lowercase().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// The app-data worktree root for a repo — `<data_dir>/<identifier>/worktrees/
/// <repo-hash>`. Mirrors `worktree.rs::worktree_root`, but resolved via
/// `dirs::data_dir()` (as `local_prs.rs` / `oplog.rs` do) since the local-PR
/// merge commands carry no `AppHandle`. Tauri's `app_data_dir()` is exactly
/// `dirs::data_dir()/<identifier>`, so this points at the same directory.
fn worktree_root_dir(repo_path: &str) -> AppResult<std::path::PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data
        .join("com.thebguy.gitdesktop")
        .join("worktrees")
        .join(repo_hash(repo_path)))
}

/// Tears down a resolve worktree: `git worktree remove --force <path>` then
/// `git worktree prune`, both in the MAIN repo, both best-effort (a resolve
/// worktree is detached and holds no branch, so nothing else needs cleanup).
async fn remove_resolve_worktree(state: &AppState, repo_path: &str, worktree_path: &str) {
    let _ = run_git_mutating(
        state,
        repo_path,
        &["worktree", "remove", "--force", worktree_path],
        DEFAULT_TIMEOUT,
    )
    .await;
    let _ = run_git_mutating(state, repo_path, &["worktree", "prune"], DEFAULT_TIMEOUT).await;
}

/// Parses `git worktree list --porcelain` into the checked-out branch name of
/// each stanza — the only field `finalize_base` needs. Each stanza starts with a
/// `worktree <path>` line and carries a `branch refs/heads/<name>` line unless it
/// is `detached`; a detached stanza (like our resolve worktree) yields an empty
/// string, so it never matches `base`. Blank lines separate stanzas.
pub(crate) fn parse_worktree_branches(porcelain: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in porcelain.lines() {
        let line = line.trim_end();
        if line.starts_with("worktree ") {
            // A new stanza — default its branch to empty (detached) until a
            // `branch` line fills it in.
            out.push(String::new());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(cur) = out.last_mut() {
                *cur = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
            }
        }
    }
    out
}

/// The `worktree <path>` line of every stanza in `git worktree list --porcelain`,
/// in list order.
pub(crate) fn parse_worktree_paths(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter_map(|line| line.trim_end().strip_prefix("worktree "))
        .map(str::to_string)
        .collect()
}

/// Whether a worktree path is one of our resolve worktrees — its final path
/// segment starts with `gd-resolve-`. The basename is the reliable signal:
/// `git_merge_local_pr` names them `gd-resolve-<uuid>`, and porcelain may
/// normalize the leading path so an app-data-root prefix check is less robust.
fn is_resolve_worktree_path(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|name| name.starts_with("gd-resolve-"))
        .unwrap_or(false)
}

/// Pure decision for [`git_cleanup_orphaned_resolve_worktrees`]: from all
/// worktree paths, pick the resolve worktrees (basename `gd-resolve-*`) whose
/// normalized path is NOT among `keep`. Normalization matches how the app
/// compares worktree paths elsewhere (`normalize_wt_path`: forward-slashed +
/// lower-cased), so a kept path git prints with slashes still matches a kept
/// path the frontend stored with back-slashes.
fn orphaned_resolve_worktrees(all_paths: &[String], keep: &[String]) -> Vec<String> {
    use crate::git::worktree::normalize_wt_path;
    let keep_norm: std::collections::HashSet<String> =
        keep.iter().map(|p| normalize_wt_path(p)).collect();
    all_paths
        .iter()
        .filter(|p| is_resolve_worktree_path(p))
        .filter(|p| !keep_norm.contains(&normalize_wt_path(p)))
        .cloned()
        .collect()
}

/// Advances `base` to `new_sha` after the merge landed in the resolve worktree,
/// picking the safe mechanic for wherever `base` is checked out:
/// - the MAIN repo's current branch → `merge --ff-only` there (the tree was gated
///   clean upfront); a failure propagates as commit-or-stash.
/// - checked out in ANOTHER worktree → run the ff-only INSIDE that worktree so its
///   index and working tree advance too. A bare `update-ref` would desync it
///   (phantom reverts). A dirty one fails cleanly and `base` stays unchanged.
/// - checked out nowhere → `update-ref`, no working tree touched.
async fn finalize_base(
    state: &AppState,
    repo_path: &str,
    base: &str,
    new_sha: &str,
    current: &str,
) -> AppResult<()> {
    if base == current {
        // `base` is the main repo's current branch — fast-forward its working
        // tree to the merged commit. (Guaranteed a fast-forward: `new_sha` was
        // built from base's tip in the resolve worktree.)
        run_git_mutating(
            state,
            repo_path,
            &["merge", "--ff-only", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(());
    }

    // Is `base` checked out in some OTHER worktree? `paths` and `branches` come
    // from the same porcelain stanzas in list order, so they line up per stanza.
    // Our resolve worktree is detached, so it never carries `base` as a branch and
    // is safely excluded.
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let porcelain = listed.stdout_lossy();
    let owning_worktree = parse_worktree_paths(&porcelain)
        .into_iter()
        .zip(parse_worktree_branches(&porcelain))
        .find(|(_, branch)| branch == base)
        .map(|(path, _)| path);

    if let Some(worktree) = owning_worktree {
        // Route the fast-forward INTO the worktree holding `base` so its index and
        // working tree advance too; fails cleanly (base untouched) if it's dirty.
        return run_git_mutating(
            state,
            &worktree,
            &["merge", "--ff-only", new_sha],
            DEFAULT_TIMEOUT,
        )
        .await
        .map(|_| ())
        .map_err(|e| match e {
            AppError::Git { stderr, .. } => AppError::Command(format!(
                "{base} is checked out at {worktree}; couldn't fast-forward it there \
                 (its working tree may be dirty, or its history has diverged). {base} is unchanged.\n{stderr}"
            )),
            other => other,
        });
    }

    // Not checked out anywhere — move the ref directly, no working tree touched.
    run_git_mutating(
        state,
        repo_path,
        &["update-ref", &format!("refs/heads/{base}"), new_sha],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Merges `head` into `base` for a local PR, matching GitHub's merge options:
/// - "merge"  → a `--no-ff` merge commit carrying `message`
/// - "squash" → head's commits squashed into one commit with `message`
/// - "rebase" → head's commits replayed onto base (cherry-pick range, no merge
///   commit), preserving their individual messages — `message` is unused
///
/// The merge runs in a hidden DETACHED worktree at `base`'s tip, so the user's
/// branch and uncommitted work are NEVER touched. Clean ⇒ `base` is advanced
/// (`finalize_base`), the worktree torn down, `status: "merged"`. Conflict ⇒ the
/// worktree is kept and returned so the frontend drives resolution there, then
/// calls `git_finish_local_pr_merge` / `git_abort_local_pr_merge`. A clean main
/// tree is required ONLY when `base` IS the current branch (advancing it
/// unavoidably touches the tree).
#[tauri::command]
pub async fn git_merge_local_pr(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    head: String,
    message: String,
    strategy: String,
) -> AppResult<LocalPrMergeOutcome> {
    validate_branch_arg(&base)?;
    validate_branch_arg(&head)?;
    let root = worktree_root_dir(&repo_path)?;
    merge_local_pr(&state, &repo_path, &base, &head, &message, &strategy, &root).await
}

/// Testable core of [`git_merge_local_pr`] — takes a plain `&AppState` and an
/// explicit worktree-root dir so real-repo tokio tests can drive it against a
/// temp dir (mirrors `rewrite_commits` / `replace_file_lines`). The command
/// resolves `root` to the app-data worktrees dir.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn merge_local_pr(
    state: &AppState,
    repo_path: &str,
    base: &str,
    head: &str,
    message: &str,
    strategy: &str,
    root: &Path,
) -> AppResult<LocalPrMergeOutcome> {
    use crate::git::runner::run_git;

    let message = if message.trim().is_empty() {
        format!("Merge {head} into {base}")
    } else {
        message.to_string()
    };

    // Where the main tree is now, and base's tip — captured before any mutation.
    let current = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    let base_tip = run_git(Some(repo_path), &["rev-parse", base], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    // Only advancing the CURRENT branch touches the main tree — gate that one
    // case on a clean tree (finalize_base's `merge --ff-only` would otherwise
    // fail, or clobber uncommitted work). Merging into any other branch leaves
    // the main tree alone, so no clean-tree requirement.
    if base == current {
        ensure_clean_tree(repo_path).await?;
    }

    // Journal a pending entry AFTER the state capture, BEFORE the first mutation.
    // Best-effort: a journal failure returns None and the op proceeds unchanged.
    let verb = match strategy {
        "squash" => "Squash-merge",
        "rebase" => "Rebase-merge",
        _ => "Merge",
    };
    let label = format!("{verb} {head} → {base}");
    let op_id = crate::oplog::begin(
        repo_path,
        "merge_local_pr",
        &label,
        Some(base.to_string()),
        &base_tip,
        Some(&base_tip),
    )
    .await;

    // Create the isolated DETACHED resolve worktree at base's tip.
    let worktree_id = uuid::Uuid::new_v4().to_string();
    let worktree_path = root.join(format!("gd-resolve-{worktree_id}"));
    let worktree_path = worktree_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::create_dir_all(root) {
        crate::oplog::finish(repo_path, &op_id, Some(e.to_string())).await;
        return Err(AppError::Io(e));
    }
    let add = run_git_mutating(
        state,
        repo_path,
        &["worktree", "add", "--detach", &worktree_path, &base_tip],
        DEFAULT_TIMEOUT,
    )
    .await;
    if let Err(err) = add {
        // The worktree was never created — nothing to tear down.
        crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
        return Err(err);
    }

    // Run the strategy IN the worktree (cwd = worktree_path). Squash/merge write
    // a commit; rebase cherry-picks the range. Conflicts leave unmerged paths.
    let range = format!("{base_tip}..{head}");
    let result: AppResult<()> = match strategy {
        "squash" => {
            match run_git_raw(
                Some(&worktree_path),
                &["merge", "--squash", head],
                DEFAULT_TIMEOUT,
            )
            .await
            {
                Ok(o) if o.code == 0 => run_git_raw(
                    Some(&worktree_path),
                    &["commit", "-m", &message],
                    DEFAULT_TIMEOUT,
                )
                .await
                .and_then(check_code),
                Ok(o) => Err(AppError::Git {
                    code: o.code,
                    stderr: o.stderr,
                }),
                Err(e) => Err(e),
            }
        }
        "rebase" => run_git_raw(
            Some(&worktree_path),
            &["cherry-pick", &range],
            DEFAULT_TIMEOUT,
        )
        .await
        .and_then(check_code),
        _ => run_git_raw(
            Some(&worktree_path),
            &["merge", "--no-ff", "-m", &message, head],
            DEFAULT_TIMEOUT,
        )
        .await
        .and_then(check_code),
    };

    match result {
        Ok(()) => {
            // Clean: the worktree HEAD is the merged commit.
            let new_sha = run_git(Some(&worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
                .await?
                .stdout_lossy()
                .trim()
                .to_string();
            if let Err(err) = finalize_base(state, repo_path, base, &new_sha, &current).await {
                // base couldn't be advanced (e.g. checked out elsewhere, or the
                // ff-only failed) — clean up the worktree and surface the cause.
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
                return Err(err);
            }
            remove_resolve_worktree(state, repo_path, &worktree_path).await;
            crate::oplog::finish(repo_path, &op_id, None).await;
            Ok(LocalPrMergeOutcome {
                status: "merged".to_string(),
                conflicts: Vec::new(),
                base_tip,
                worktree_id: None,
                worktree_path: None,
                op_id,
            })
        }
        Err(err) => {
            // Conflict vs. genuine error: unmerged paths in the WORKTREE is the
            // conflict signal (covers merge/squash/cherry-pick alike — squash
            // never writes MERGE_HEAD, so this is more reliable than op markers).
            let conflicts = unmerged_paths(&worktree_path).await;
            if !conflicts.is_empty() {
                // Keep the worktree + leave the oplog pending; the frontend drives
                // resolution there, then finish/abort close it.
                Ok(LocalPrMergeOutcome {
                    status: "conflicts".to_string(),
                    conflicts,
                    base_tip,
                    worktree_id: Some(worktree_id),
                    worktree_path: Some(worktree_path),
                    op_id,
                })
            } else {
                // Genuine (non-conflict) failure: tear the worktree down (the main
                // tree and base were never touched) and propagate.
                remove_resolve_worktree(state, repo_path, &worktree_path).await;
                crate::oplog::finish(repo_path, &op_id, Some(err.to_string())).await;
                match err {
                    AppError::Git { code, stderr } => Err(AppError::Git {
                        code,
                        stderr: format!(
                            "{strategy} merge failed; {base} is unchanged.\n{stderr}"
                        ),
                    }),
                    other => Err(other),
                }
            }
        }
    }
}

/// Completes a local-PR merge that `git_merge_local_pr` left conflicted, once the
/// user has resolved (and staged) every conflict IN THE RESOLVE WORKTREE. Refuses
/// while any unmerged path remains there. On success `base` is advanced to the
/// resolved commit (`finalize_base`), the worktree is removed, and it reports
/// `status: "merged"`. For a `rebase` strategy a *later* commit in the range can
/// re-conflict — it then stays in the worktree and reports `status: "conflicts"`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per field, IPC-shaped
pub async fn git_finish_local_pr_merge(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    strategy: String,
    message: String,
    worktree_path: String,
    worktree_id: String,
    op_id: Option<String>,
) -> AppResult<LocalPrMergeOutcome> {
    validate_branch_arg(&base)?;

    // When `base` IS the current branch, `finalize_base` ends in a `merge --ff-only`
    // into the main tree — re-guard clean HERE, since the user may have dirtied it
    // during resolution (after `git_merge_local_pr`'s upfront check). Otherwise base
    // moves by `update-ref` and the main tree is never touched.
    let current = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    if base == current {
        ensure_clean_tree(&repo_path).await?;
    }

    // Guard: every conflict in the worktree must be resolved first.
    let remaining = unmerged_paths(&worktree_path).await;
    if !remaining.is_empty() {
        return Err(AppError::Command("Resolve every conflict first".to_string()));
    }

    match strategy.as_str() {
        "rebase" => {
            // Continue the cherry-pick in the worktree with a non-interactive
            // editor so git never blocks (mirrors git_op_continue / git_rebase).
            let out = run_git_raw(
                Some(&worktree_path),
                &["-c", "core.editor=true", "cherry-pick", "--continue"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // A later commit in the range may re-conflict; if so, stay in the
            // worktree and re-report conflicts (do NOT finalize or remove).
            let conflicts = unmerged_paths(&worktree_path).await;
            if !conflicts.is_empty() {
                let tip = run_git(Some(&worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
                    .await
                    .ok()
                    .map(|o| o.stdout_lossy().trim().to_string())
                    .unwrap_or_default();
                return Ok(LocalPrMergeOutcome {
                    status: "conflicts".to_string(),
                    conflicts,
                    base_tip: tip,
                    worktree_id: Some(worktree_id),
                    worktree_path: Some(worktree_path),
                    op_id,
                });
            }
            // A non-conflict, non-zero exit means something genuinely failed
            // (e.g. "no cherry-pick in progress" when nothing was staged). Surface
            // it rather than silently reporting success.
            if out.code != 0 && !out.stderr.trim().is_empty() {
                return Err(AppError::Git {
                    code: out.code,
                    stderr: out.stderr,
                });
            }
        }
        _ => {
            // squash / merge → conclude with a commit in the worktree. If the user
            // committed the resolution by hand there is nothing staged; tolerate
            // git's "nothing to commit" instead of erroring.
            let staged = run_git_raw(
                Some(&worktree_path),
                &["diff", "--cached", "--quiet"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // exit 0 ⇒ nothing staged ⇒ already committed (or empty) ⇒ skip commit.
            if staged.code != 0 {
                let commit = run_git_raw(
                    Some(&worktree_path),
                    &["commit", "-m", &message],
                    DEFAULT_TIMEOUT,
                )
                .await?;
                if commit.code != 0 {
                    let lower = commit.stderr.to_lowercase();
                    let already = lower.contains("nothing to commit")
                        || lower.contains("no changes added");
                    if !already {
                        return Err(AppError::Git {
                            code: commit.code,
                            stderr: commit.stderr,
                        });
                    }
                }
            }
        }
    }

    // Completed with no remaining conflicts: advance base, tear down, close oplog.
    // `current` was resolved up top (and re-guarded clean when base == current).
    let new_sha = run_git(Some(&worktree_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
    finalize_base(&state, &repo_path, &base, &new_sha, &current).await?;
    remove_resolve_worktree(&state, &repo_path, &worktree_path).await;
    crate::oplog::finish(&repo_path, &op_id, None).await;
    Ok(LocalPrMergeOutcome {
        status: "merged".to_string(),
        conflicts: Vec::new(),
        base_tip: new_sha,
        worktree_id: None,
        worktree_path: None,
        op_id,
    })
}

/// Abandons a local-PR merge that `git_merge_local_pr` left conflicted: removes
/// the resolve worktree (`--force`) and prunes. The user's main tree and branch
/// were never touched, so there is nothing else to roll back. Best-effort, then
/// closes the oplog entry as failed ("aborted by user").
#[tauri::command]
pub async fn git_abort_local_pr_merge(
    state: State<'_, AppState>,
    repo_path: String,
    worktree_path: String,
    op_id: Option<String>,
) -> AppResult<()> {
    remove_resolve_worktree(&state, &repo_path, &worktree_path).await;
    crate::oplog::finish(&repo_path, &op_id, Some("aborted by user".to_string())).await;
    Ok(())
}

/// Sweeps orphaned resolve worktrees (`gd-resolve-<uuid>`) left under the app-data
/// root by a paused local-PR merge. The only live handle to one is a local PR's
/// `pendingMerge`, so a crash mid-resolve (or a lost PR) orphans it with no UI path
/// to remove it — being detached, the user-facing worktree manager excludes it. The
/// frontend calls this on repo open with every STILL-ACTIVE `pendingMerge` path as
/// `keep_paths`; every other `gd-resolve-*` worktree is torn down. Best-effort per
/// worktree; always returns `Ok(())`.
#[tauri::command]
pub async fn git_cleanup_orphaned_resolve_worktrees(
    state: State<'_, AppState>,
    repo_path: String,
    keep_paths: Vec<String>,
) -> AppResult<()> {
    let listed = run_git(
        Some(&repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let all = parse_worktree_paths(&listed.stdout_lossy());
    for path in orphaned_resolve_worktrees(&all, &keep_paths) {
        // remove_resolve_worktree is itself best-effort (both git calls swallow
        // errors), so one stuck worktree can't stop the rest.
        remove_resolve_worktree(&state, &repo_path, &path).await;
    }
    Ok(())
}

/// Maps a raw git output into a `Result`, turning a non-zero exit into
/// `AppError::Git` (so `run_git_raw` calls in the worktree can distinguish a
/// clean commit from a conflict via the returned `Err`, while still surfacing the
/// unmerged-paths signal for the conflict branch).
fn check_code(o: crate::git::runner::GitOutput) -> AppResult<()> {
    if o.code == 0 {
        Ok(())
    } else {
        Err(AppError::Git {
            code: o.code,
            stderr: o.stderr,
        })
    }
}

/// Predicts whether merging `head` into `base` would conflict, **without touching
/// the working tree or index** — the read-only precheck for a local-PR merge.
/// Reuses `git merge-tree --write-tree --name-only` (git 2.38+, file names need
/// 2.40+): exit 0 ⇒ `"clean"`; exit 1 ⇒ `"conflict"` with the conflicted names;
/// anything else / old git ⇒ `"unknown"`. Up-to-date and fast-forward cases are
/// short-circuited via merge-base and reported as `"clean"` (the merge would
/// succeed).
#[tauri::command]
pub async fn git_conflict_preview(
    repo_path: String,
    base: String,
    head: String,
) -> AppResult<MergePreview> {
    validate_branch_arg(&base)?;
    validate_branch_arg(&head)?;
    let unknown = || MergePreview {
        status: "unknown".to_string(),
        conflicts: Vec::new(),
    };

    let base_sha = run_git_raw(Some(&repo_path), &["rev-parse", &base], DEFAULT_TIMEOUT).await?;
    let head_sha = run_git_raw(Some(&repo_path), &["rev-parse", &head], DEFAULT_TIMEOUT).await?;
    if base_sha.code != 0 || head_sha.code != 0 {
        return Ok(unknown());
    }
    let base_sha = base_sha.stdout_lossy().trim().to_string();
    let head_sha = head_sha.stdout_lossy().trim().to_string();

    // Already-merged (head reachable from base) or fast-forward (base reachable
    // from head): both merge cleanly.
    let mb = run_git_raw(
        Some(&repo_path),
        &["merge-base", &base, &head],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if mb.code == 0 {
        let mbase = mb.stdout_lossy().trim().to_string();
        if mbase == head_sha || mbase == base_sha {
            return Ok(MergePreview {
                status: "clean".to_string(),
                conflicts: Vec::new(),
            });
        }
    }

    let mt = run_git_raw(
        Some(&repo_path),
        &["merge-tree", "--write-tree", "--name-only", &base, &head],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match mt.code {
        0 => Ok(MergePreview {
            status: "clean".to_string(),
            conflicts: Vec::new(),
        }),
        1 => {
            // Same output shape as `git_merge_preview`: line 1 is the tree OID, then
            // the conflicted names. Empty stdout ⇒ git refused ⇒ "unknown".
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

/// Rewrites the unpushed tip of the current branch (`base..HEAD`) — one commit per
/// step, in step order. The interactive-rebase vocabulary maps onto step shape: one
/// hash + no message = **pick**; one hash + message = **reword**; many hashes +
/// message = **squash**; many hashes + no message = **fixup** (reuses the leader
/// commit's message and authorship via `commit -C`). Omitting a commit **drops** it.
/// Refuses on a dirty tree or merge commits in range; any conflict rolls everything
/// back untouched.
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

    // reset --hard would destroy uncommitted work — refuse instead.
    let status = run_git(
        Some(repo_path),
        &["status", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if !status.stdout_lossy().trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "the working tree has uncommitted changes — commit or stash them first".into(),
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

    // Journal a pending entry AFTER the guards + `orig` capture, BEFORE the first
    // mutation (`reset --hard`). Best-effort: a journal failure returns None and
    // the op proceeds unchanged.
    let original_ref = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|s| !s.is_empty());
    let label = format!("Rewrite {} commit(s)", steps.len());
    let op_id = crate::oplog::begin(
        repo_path,
        "rewrite_commits",
        &label,
        original_ref,
        &orig,
        Some(&orig),
    )
    .await;

    let op_result: AppResult<()> = async {
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
            let _ = run_git_mutating(
                state,
                repo_path,
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
    .await;

    crate::oplog::finish(
        repo_path,
        &op_id,
        op_result.as_ref().err().map(|e| e.to_string()),
    )
    .await;
    op_result
}

/// Rewrites the unpushed tip via a **real, resumable** `git rebase -i` — used when
/// the plan contains an `edit` (the atomic replay engine can't pause). Generates
/// the todo (pick/edit the leader, fixup the folds, reword/squash messages via a
/// non-interactive `exec … commit --amend -F`) and injects it with
/// `sequence.editor`, so no editor ever opens. Stopping at an `edit` (or at a
/// conflict before one) leaves the rebase in progress for the banner to take over —
/// a normal outcome, not an error.
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

    // Journal a pending entry AFTER the guards, BEFORE the first side effect
    // (scratch-dir setup / the rebase itself). Best-effort: a journal failure
    // returns None and the op proceeds unchanged. A paused rebase returns Ok, so
    // `finish` marks it "done" (git tracks the paused state); only a real Err is
    // "failed". `git_oplog_check` sees `rebasing` true only if the PROCESS died.
    let original_sha = run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
        .await
        .ok()
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_default();
    let original_ref = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|s| !s.is_empty());
    let label = format!("Interactive rebase onto {base}");
    let op_id = crate::oplog::begin(
        &repo_path,
        "rebase_edit",
        &label,
        original_ref,
        &original_sha,
        Some(&original_sha),
    )
    .await;

    let op_result: AppResult<()> = async {
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
                std::fs::write(&msg_path, message).map_err(|e| {
                    AppError::InvalidArgument(format!("couldn't write message: {e}"))
                })?;
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
    .await;

    crate::oplog::finish(
        &repo_path,
        &op_id,
        op_result.as_ref().err().map(|e| e.to_string()),
    )
    .await;
    op_result
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
    git_tag_core(&state, repo_path, name, hash).await
}

pub(crate) async fn git_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
    hash: String,
) -> AppResult<()> {
    validate_hash(&hash)?;
    validate_tag_name(&name)?;
    run_git_mutating(state, &repo_path, &["tag", "--", &name, &hash], DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_push_tag(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_push_tag_core(&state, repo_path, name).await
}

pub(crate) async fn git_push_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    let spec = format!("refs/tags/{name}");
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    crate::git::remote::run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
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
    git_delete_tag_core(&state, repo_path, name, on_remote).await
}

pub(crate) async fn git_delete_tag_core(
    state: &AppState,
    repo_path: String,
    name: String,
    on_remote: bool,
) -> AppResult<()> {
    validate_tag_name(&name)?;
    run_git_mutating(
        state,
        &repo_path,
        &["tag", "-d", "--", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if on_remote {
        let spec = format!(":refs/tags/{name}");
        let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
        crate::git::remote::run_git_mutating_with_creds(
            state,
            &repo_path,
            &cred,
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

    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-rewrite-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        commit_file(&repo, dir.path(), "a.txt", "v0\n", "base").await;
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
    async fn ensure_clean_tree_allows_clean_and_untracked_but_refuses_tracked() {
        let (dir, repo) = setup_repo("clean-tree").await;
        // Clean tree → Ok.
        assert!(ensure_clean_tree(&repo).await.is_ok());
        // Untracked file → still Ok (`reset --hard` never removes it).
        std::fs::write(dir.path().join("scratch.txt"), "x\n").unwrap();
        assert!(ensure_clean_tree(&repo).await.is_ok());
        // Unstaged tracked change → refused (this is the reset --hard loss surface).
        std::fs::write(dir.path().join("a.txt"), "v1\n").unwrap();
        assert!(ensure_clean_tree(&repo).await.is_err());
        // Staged tracked change → refused (the exact incident state).
        git(&repo, &["add", "a.txt"]).await;
        assert!(ensure_clean_tree(&repo).await.is_err());

    }

    #[tokio::test]
    async fn reorder_swaps_independent_commits() {
        let (dir, repo) = setup_repo("reorder").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // Oldest-first steps: "two" lands at the bottom, "one" on top.
        rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)])
            .await
            .unwrap();
        assert_eq!(subjects(&repo).await, vec!["one", "two", "base"]);

    }

    #[tokio::test]
    async fn squash_combines_commits() {
        let (dir, repo) = setup_repo("squash").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "two").await;
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
        assert!(dir.path().join("b.txt").exists());
        assert!(dir.path().join("c.txt").exists());

    }

    #[tokio::test]
    async fn fixup_keeps_leader_message() {
        let (dir, repo) = setup_repo("fixup").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "b.txt", "b\n", "keep this message").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "c.txt", "c\n", "discard me").await;
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
        assert!(dir.path().join("b.txt").exists());
        assert!(dir.path().join("c.txt").exists());

    }

    #[tokio::test]
    async fn conflicting_rewrite_rolls_back() {
        let (dir, repo) = setup_repo("conflict").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "one").await;
        let c1 = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "a.txt", "v2\n", "two").await;
        let c2 = rev(&repo, "HEAD").await;
        let orig = rev(&repo, "HEAD").await;

        let state = AppState::default();
        // "two"'s patch (v1→v2) can't apply onto v0 — conflict, then rollback.
        let result = rewrite_commits(&state, &repo, &base, &[pick(&c2), pick(&c1)]).await;
        assert!(result.is_err());
        assert_eq!(rev(&repo, "HEAD").await, orig);
        let status = git(&repo, &["status", "--porcelain"]).await;
        assert!(status.trim().is_empty(), "tree should be clean: {status}");

    }

    #[tokio::test]
    async fn rebase_edit_refuses_a_concurrent_op() {
        let (dir, repo) = setup_repo("reentry").await;
        let base = rev(&repo, "HEAD").await;
        commit_file(&repo, dir.path(), "x.txt", "x\n", "one").await;
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

    }

    #[tokio::test]
    async fn rebase_onto_moves_only_its_own_commits() {
        // The "branched off the wrong branch" scenario: `fix` was branched off
        // `feature` (the wrong base), which itself branched off the default
        // branch. Rebasing `fix` --onto default from `feature` must replay ONLY
        // fix's own commits and drop feature's.
        let (dir, repo) = setup_repo("rebase-onto").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&repo, &["checkout", "-b", "feature"]).await;
        commit_file(&repo, dir.path(), "f.txt", "f\n", "feature one").await;
        git(&repo, &["checkout", "-b", "fix"]).await;
        commit_file(&repo, dir.path(), "x.txt", "x\n", "fix one").await;
        commit_file(&repo, dir.path(), "x.txt", "x2\n", "fix two").await;
        // Advance the default branch so it diverges from feature.
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "v1\n", "main advance").await;
        let main_tip = rev(&repo, "HEAD").await;
        git(&repo, &["checkout", "fix"]).await;

        let state = AppState::default();
        rebase_onto(&state, &repo, &main, "feature").await.unwrap();

        // `fix` now carries only its own two commits, replayed onto the default
        // branch's tip — feature's commit is excluded.
        assert_eq!(
            subjects(&repo).await,
            vec!["fix two", "fix one", "main advance", "base"],
            "only fix's own commits replay onto the new base; feature's excluded"
        );
        assert_eq!(
            rev(&repo, "fix~2").await,
            main_tip,
            "fix's commits sit directly on the new base's tip"
        );

    }

    #[tokio::test]
    async fn merge_preview_reports_outcomes() {
        let (dir, repo) = setup_repo("preview").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        commit_file(&repo, dir.path(), "shared.txt", "base\n", "base shared").await;

        // up-to-date: a branch pinned at an ancestor of HEAD.
        git(&repo, &["branch", "old"]).await;
        commit_file(&repo, dir.path(), "shared.txt", "main2\n", "advance main").await;
        let up = git_merge_preview(repo.clone(), "old".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(up.status, "up-to-date");

        // fast-forward: a branch strictly ahead of HEAD.
        git(&repo, &["checkout", "-b", "ahead"]).await;
        commit_file(&repo, dir.path(), "ahead.txt", "a\n", "ahead only").await;
        git(&repo, &["checkout", &main]).await;
        let ff = git_merge_preview(repo.clone(), "ahead".to_string(), "none".to_string())
            .await
            .unwrap();
        assert_eq!(ff.status, "fast-forward");

        // conflict: divergent edits to shared.txt (needs git merge-tree, 2.38+).
        git(&repo, &["checkout", "-b", "feat"]).await;
        commit_file(&repo, dir.path(), "shared.txt", "feat\n", "feat edit").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "shared.txt", "main3\n", "main edit").await;
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

    }

    #[tokio::test]
    async fn conflict_preview_reports_clean_and_conflict() {
        let (dir, repo) = setup_repo("conflict-preview").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // A non-conflicting feature: touches a different file than base advances.
        git(&repo, &["checkout", "-b", "clean-feat"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feat\n", "feat only").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "base-only.txt", "b\n", "base only").await;
        let clean = git_conflict_preview(repo.clone(), main.clone(), "clean-feat".to_string())
            .await
            .unwrap();
        assert_eq!(clean.status, "clean", "conflicts: {:?}", clean.conflicts);

        // A conflicting feature: divergent edits to the same file as base.
        git(&repo, &["checkout", "-b", "bad-feat"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feat-edit\n", "feat edit a").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "main-edit\n", "main edit a").await;
        let conflict = git_conflict_preview(repo.clone(), main.clone(), "bad-feat".to_string())
            .await
            .unwrap();
        assert_eq!(
            conflict.status, "conflict",
            "conflicts: {:?}",
            conflict.conflicts
        );
        assert!(
            conflict.conflicts.iter().any(|f| f.contains("a.txt")),
            "{:?}",
            conflict.conflicts
        );

    }

    #[tokio::test]
    async fn unmerged_paths_lists_conflicts_only_when_present() {
        // Drives the conflict-vs-clean detection that git_merge_local_pr relies on
        // to decide between "leave it for the user" and "roll back".
        let (dir, repo) = setup_repo("unmerged").await;
        let main = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Clean tree ⇒ no unmerged paths.
        assert!(unmerged_paths(&repo).await.is_empty());

        // Manufacture a real conflicted merge on `main`.
        git(&repo, &["checkout", "-b", "feat"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feat\n", "feat edit").await;
        git(&repo, &["checkout", &main]).await;
        commit_file(&repo, dir.path(), "a.txt", "main\n", "main edit").await;
        // A conflicting merge exits non-zero and leaves unmerged paths in place.
        let merged = run_git_raw(
            Some(&repo),
            &["merge", "--no-ff", "-m", "m", "feat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merged.code, 0, "the merge should conflict");
        let paths = unmerged_paths(&repo).await;
        assert!(
            paths.iter().any(|p| p == "a.txt"),
            "expected a.txt among {paths:?}"
        );

    }

    /// Makes a throwaway dir and writes `.gitignore` with the given raw bytes.
    fn gitignore_dir(marker: &str, content: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-unignore-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        std::fs::write(dir.path().join(".gitignore"), content).unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
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
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        // CRLF kept, comment + the untouched rule kept, trailing CRLF kept.
        assert_eq!(out, "# build artifacts\r\nbuild/\r\n");
    }

    #[tokio::test]
    async fn unignore_last_rule_keeps_trailing_newline() {
        let (dir, repo) = gitignore_dir("last", "*.log\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        // Removing the only rule leaves a single newline, not a 0-byte file.
        assert_eq!(out, "\n");
    }

    /// Two rules that a blanket `trim()` collapses into one key — `/notes\ `
    /// names a file whose name ends in a space, `/notes\` one ending in a
    /// backslash — must be removable independently. Trimming the escape away
    /// deletes the wrong line as well as the right one.
    #[tokio::test]
    async fn unignore_removes_only_the_targeted_escaped_rule() {
        let body = "/notes\\ \n/notes\\\nkeep\n";

        let (dir, repo) = gitignore_dir("escaped-space", body);
        git_unignore_rules(repo, vec![rule("/notes\\ ")]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
            "/notes\\\nkeep\n"
        );

        let (dir2, repo2) = gitignore_dir("escaped-slash", body);
        git_unignore_rules(repo2, vec![rule("/notes\\")]).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir2.path().join(".gitignore")).unwrap(),
            "/notes\\ \nkeep\n"
        );
    }

    #[tokio::test]
    async fn unignore_strips_and_restores_bom() {
        // A UTF-8 BOM ahead of the first (targeted) rule must not block the match.
        let (dir, repo) = gitignore_dir("bom", "\u{feff}*.log\nbuild/\n");
        git_unignore_rules(repo, vec![rule("*.log")]).await.unwrap();
        let out = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert_eq!(out, "\u{feff}build/\n");
    }

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn replace_lines_clean_file_stages_exactly_the_edit() {
        let (dir, repo) = setup_repo("replace-clean").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B1", "B2"]),
            true,
        )
        .await
        .unwrap();
        assert!(res.staged);
        assert!(!res.had_local_changes);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nB1\nB2\nc\n"
        );
        // The index holds exactly this edit — the staged blob matches the file,
        // so there is no unstaged remainder for src.txt.
        let porcelain = git(&repo, &["status", "--porcelain", "--", "src.txt"]).await;
        assert_eq!(porcelain, "M  src.txt\n", "unexpected status: {porcelain:?}");

    }

    #[tokio::test]
    async fn replace_lines_dirty_file_does_not_stage() {
        let (dir, repo) = setup_repo("replace-dirty").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;
        // A pre-existing unstaged edit elsewhere in the same file.
        std::fs::write(dir.path().join("src.txt"), "a\nb\nCHANGED\n").unwrap();

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B"]),
            true,
        )
        .await
        .unwrap();
        assert!(!res.staged, "must not stage a file with pre-existing changes");
        assert!(res.had_local_changes);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nB\nCHANGED\n"
        );
        // Nothing staged: the change is unstaged-only (" M").
        let porcelain = git(&repo, &["status", "--porcelain", "--", "src.txt"]).await;
        assert_eq!(porcelain, " M src.txt\n", "unexpected status: {porcelain:?}");

    }

    #[tokio::test]
    async fn replace_lines_mismatch_leaves_file_untouched() {
        let (dir, repo) = setup_repo("replace-mismatch").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\n", "seed").await;
        let before = std::fs::read(dir.path().join("src.txt")).unwrap();

        let state = AppState::default();
        // Expected "X" at line 2 but the file has "b" — drift, must be refused.
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["X"]),
            &lines(&["B"]),
            true,
        )
        .await;
        assert!(res.is_err());
        // File is byte-identical to before the attempted apply.
        assert_eq!(std::fs::read(dir.path().join("src.txt")).unwrap(), before);

    }

    #[tokio::test]
    async fn replace_lines_beyond_eof_is_a_mismatch() {
        let (dir, repo) = setup_repo("replace-eof").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\n", "seed").await;
        let before = std::fs::read(dir.path().join("src.txt")).unwrap();

        let state = AppState::default();
        // start_line 2 with two expected lines runs past EOF → mismatch.
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b", "c"]),
            &lines(&["B"]),
            true,
        )
        .await;
        assert!(res.is_err());
        assert_eq!(std::fs::read(dir.path().join("src.txt")).unwrap(), before);

    }

    #[tokio::test]
    async fn replace_lines_preserves_crlf() {
        let (dir, repo) = setup_repo("replace-crlf").await;
        commit_file(&repo, dir.path(), "src.txt", "a\r\nb\r\nc\r\n", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b"]),
            &lines(&["B1", "B2"]),
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        // Read as bytes to prove the CRLF flavor survived (no LF conversion).
        assert_eq!(
            std::fs::read(dir.path().join("src.txt")).unwrap(),
            b"a\r\nB1\r\nB2\r\nc\r\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_pure_deletion_removes_the_range() {
        let (dir, repo) = setup_repo("replace-delete").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\nd\n", "seed").await;

        let state = AppState::default();
        // Empty replacement = delete lines 2..3 ("b","c").
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            2,
            &lines(&["b", "c"]),
            &[],
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nd\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_preserves_missing_trailing_newline() {
        let (dir, repo) = setup_repo("replace-notrail").await;
        // No trailing newline on the seed file.
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc", "seed").await;

        let state = AppState::default();
        let res = replace_file_lines(
            &state,
            &repo,
            "src.txt",
            3,
            &lines(&["c"]),
            &lines(&["C"]),
            false,
        )
        .await
        .unwrap();
        assert!(!res.staged);
        // Still no trailing newline after the edit.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "a\nb\nC"
        );

    }

    #[tokio::test]
    async fn replace_lines_sequential_applies_both_survive() {
        // The sequential form of the concurrency guard: two applies to DIFFERENT
        // ranges of one file, each verifying against the other's post-edit state,
        // both succeed and both edits survive (a race would clobber the first).
        let (dir, repo) = setup_repo("replace-seq").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\nc\nd\n", "seed").await;
        let state = AppState::default();

        replace_file_lines(&state, &repo, "src.txt", 1, &lines(&["a"]), &lines(&["A"]), false)
            .await
            .unwrap();
        // Second apply anchors on line 4 ("d"), which must still match after the
        // first edit (only line 1 changed) — proving it saw the first's write.
        replace_file_lines(&state, &repo, "src.txt", 4, &lines(&["d"]), &lines(&["D"]), false)
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("src.txt")).unwrap(),
            "A\nb\nc\nD\n"
        );

    }

    #[tokio::test]
    async fn replace_lines_rejects_invalid_arguments() {
        let (dir, repo) = setup_repo("replace-invalid").await;
        commit_file(&repo, dir.path(), "src.txt", "a\nb\n", "seed").await;
        let state = AppState::default();

        // start_line 0 is not 1-based.
        assert!(replace_file_lines(&state, &repo, "src.txt", 0, &lines(&["a"]), &[], false)
            .await
            .is_err());
        // Empty expected_lines.
        assert!(replace_file_lines(&state, &repo, "src.txt", 1, &[], &[], false)
            .await
            .is_err());
        // Traversal outside the repo.
        assert!(replace_file_lines(
            &state,
            &repo,
            "../escape.txt",
            1,
            &lines(&["a"]),
            &[],
            false
        )
        .await
        .is_err());
        // Nonexistent file.
        assert!(replace_file_lines(&state, &repo, "missing.txt", 1, &lines(&["a"]), &[], false)
            .await
            .is_err());

    }

    #[tokio::test]
    async fn orphaned_stashes_finds_a_dropped_stash() {
        let (dir, repo) = setup_repo("orphaned-stash").await;
        // Make a tracked change plus an untracked file, then stash both.
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        git(&repo, &["stash", "push", "-u", "-m", "rescue me"]).await;
        let sha = rev(&repo, "stash@{0}").await;
        // Drop it → the commit becomes dangling but still reachable by sha.
        git(&repo, &["stash", "drop"]).await;

        let found = git_orphaned_stashes(repo.clone()).await.unwrap();
        let entry = found
            .iter()
            .find(|o| o.sha == sha)
            .expect("dropped stash should appear as orphaned");
        assert!(
            entry.message.starts_with("On ") || entry.message.contains("rescue me"),
            "message was {:?}",
            entry.message
        );
        assert!(entry.file_count > 0, "file_count was {}", entry.file_count);

        // A live stash must NOT be reported as orphaned.
        std::fs::write(dir.path().join("a.txt"), "changed again\n").unwrap();
        git(&repo, &["stash", "push", "-m", "still live"]).await;
        let live_sha = rev(&repo, "stash@{0}").await;
        let found2 = git_orphaned_stashes(repo.clone()).await.unwrap();
        assert!(
            !found2.iter().any(|o| o.sha == live_sha),
            "live stash should be excluded"
        );

    }

    #[test]
    fn parse_worktree_branches_reads_path_and_branch_and_detached() {
        // Main worktree on a branch, a linked worktree on another branch, and a
        // DETACHED worktree (no `branch` line → empty branch, like our resolve wt).
        let porcelain = "\
worktree C:/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/master

worktree C:/repos/app-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature

worktree C:/data/worktrees/h/gd-resolve-abc
HEAD 3333333333333333333333333333333333333333
detached
";
        let got = parse_worktree_branches(porcelain);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], "master");
        assert_eq!(got[1], "feature");
        // Detached stanza carries no branch — must not match `base` in finalize_base.
        assert_eq!(got[2], "");
        // Membership check mirrors finalize_base's "checked out elsewhere" test.
        assert!(got.iter().any(|b| b == "feature"));
        assert!(!got.iter().any(|b| b == "nope"));
    }

    #[test]
    fn parse_worktree_paths_reads_every_stanza_path() {
        let porcelain = "\
worktree C:/repos/app
HEAD 1111
branch refs/heads/master

worktree C:/data/worktrees/h/gd-resolve-abc
HEAD 2222
detached
";
        assert_eq!(
            parse_worktree_paths(porcelain),
            vec![
                "C:/repos/app".to_string(),
                "C:/data/worktrees/h/gd-resolve-abc".to_string(),
            ]
        );
    }

    #[test]
    fn orphaned_resolve_worktrees_picks_gd_resolve_paths_not_kept() {
        let all = vec![
            // Main worktree — not a resolve worktree, never swept.
            "C:/repos/app".to_string(),
            // A user worktree that merely contains "gd-resolve-" mid-path but whose
            // BASENAME doesn't start with it — must NOT be swept.
            "C:/repos/gd-resolve-ish/feature".to_string(),
            // The kept (active) resolve worktree — frontend passed it in keep_paths,
            // but with back-slashes and different case (as the store holds it).
            "C:/data/worktrees/h/gd-resolve-keep".to_string(),
            // An orphaned resolve worktree — swept.
            "C:/data/worktrees/h/gd-resolve-orphan".to_string(),
        ];
        let keep = vec!["c:\\data\\worktrees\\h\\gd-resolve-keep".to_string()];

        let got = orphaned_resolve_worktrees(&all, &keep);
        assert_eq!(got, vec!["C:/data/worktrees/h/gd-resolve-orphan".to_string()]);

        // The basename test is the gate: a mid-path "gd-resolve-" is not a match.
        assert!(!is_resolve_worktree_path("C:/repos/gd-resolve-ish/feature"));
        assert!(is_resolve_worktree_path("C:/data/worktrees/h/gd-resolve-orphan"));
        // Empty keep list → every resolve worktree is orphaned.
        let all_orphans = orphaned_resolve_worktrees(&all, &[]);
        assert_eq!(all_orphans.len(), 2);
    }

    #[test]
    fn repo_hash_is_case_insensitive_and_16_hex() {
        // Mirrors worktree.rs::repo_hash's contract: case-insensitive (Windows
        // paths) and a stable 16-hex string, so resolve worktrees land under the
        // identical app-data root worktree.rs uses (and are hidden by the
        // user-facing manager's app-data-root filter).
        assert_eq!(super::repo_hash("C:/Repos/App"), super::repo_hash("c:/repos/app"));
        assert_ne!(super::repo_hash("C:/Repos/App"), super::repo_hash("C:/Repos/Other"));
        assert_eq!(super::repo_hash("C:/Repos/App").len(), 16);
    }

    /// A clean local-PR merge where `base` is NOT the current branch: the main
    /// tree stays on its branch with its uncommitted work intact, and `base`
    /// advances to the merged commit via `update-ref` (never checked out).
    #[tokio::test]
    async fn merge_local_pr_clean_leaves_main_tree_untouched_and_advances_base() {
        let (dir, repo) = setup_repo("lpr-clean").await;
        let base_start = rev(&repo, "HEAD").await;
        // The base branch is whatever `git init` created (main/master varies by
        // config) — capture it rather than hardcoding.
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // Add a feature branch off base with one non-conflicting commit, then
        // return to base and DIRTY the tree + move onto another branch.
        git(&repo, &["branch", "feature"]).await;
        git(&repo, &["switch", "feature"]).await;
        commit_file(&repo, dir.path(), "feat.txt", "feature\n", "feat commit").await;
        git(&repo, &["switch", &base]).await;
        // Move the main tree OFF base onto `work`, and leave uncommitted changes.
        git(&repo, &["switch", "-c", "work"]).await;
        std::fs::write(dir.path().join("wip.txt"), "uncommitted\n").unwrap();
        std::fs::write(dir.path().join("a.txt"), "dirty\n").unwrap();

        // The root dir is deliberately NOT pre-created here — production
        // `merge_local_pr` is relied on to create it. The holder's TempDir is the
        // dir ABOVE `root`, so `root` itself stays absent until the code makes it.
        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        let state = AppState::default();
        let outcome = merge_local_pr(
            &state,
            &repo,
            &base,
            "feature",
            "merge it",
            "merge",
            &root,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, "merged");
        assert!(outcome.conflicts.is_empty());
        assert!(outcome.worktree_path.is_none());
        assert_eq!(outcome.base_tip, base_start);

        // Main tree is untouched: still on `work`, dirty files intact.
        assert_eq!(
            git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await.trim(),
            "work"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "dirty\n"
        );
        assert!(dir.path().join("wip.txt").exists(), "untracked WIP survives");

        // base advanced: it now contains feature's commit. `cat-file -e` exits 0
        // only when the blob is reachable; `git()` unwraps, so a missing file
        // would panic the test.
        let base_tip = rev(&repo, &base).await;
        assert_ne!(base_tip, base_start, "base moved");
        git(&repo, &["cat-file", "-e", &format!("{base}:feat.txt")]).await;

        // No resolve worktree left behind.
        let wts = git(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !wts.contains("gd-resolve-"),
            "resolve worktree removed: {wts}"
        );
    }

    /// A conflicting local-PR merge keeps the resolve worktree and reports the
    /// conflicted paths + the worktree id/path; the main tree and `base` are
    /// untouched. Aborting then removes the worktree.
    #[tokio::test]
    async fn merge_local_pr_conflict_keeps_worktree_then_abort_removes_it() {
        let (dir, repo) = setup_repo("lpr-conflict").await;
        let base_start = rev(&repo, "HEAD").await; // base @ a.txt="v0\n"
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // feature edits a.txt one way; base edits it another → conflict on merge.
        git(&repo, &["switch", "-c", "feature"]).await;
        commit_file(&repo, dir.path(), "a.txt", "feature-side\n", "feat edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "a.txt", "base-side\n", "base edit").await;
        let base_before = rev(&repo, &base).await;

        let root_holder = tempfile::tempdir().expect("create temp dir");
        let root = root_holder.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let state = AppState::default();
        let outcome = merge_local_pr(
            &state,
            &repo,
            &base,
            "feature",
            "merge it",
            "merge",
            &root,
        )
        .await
        .unwrap();

        assert_eq!(outcome.status, "conflicts");
        assert!(
            outcome.conflicts.iter().any(|p| p == "a.txt"),
            "a.txt conflicts: {:?}",
            outcome.conflicts
        );
        let wt_path = outcome.worktree_path.clone().expect("worktree path set");
        assert!(outcome.worktree_id.is_some());
        assert!(std::path::Path::new(&wt_path).exists(), "worktree kept");

        // Main tree + base untouched during the conflict.
        assert_eq!(rev(&repo, &base).await, base_before);
        assert_ne!(base_before, base_start);

        // Abort: `git_abort_local_pr_merge` is a thin wrapper over
        // `remove_resolve_worktree` (+ oplog finish, which no-ops on op_id None
        // here). Call the shared helper directly — the command form needs a real
        // `tauri::State`, not constructible in a unit test.
        remove_resolve_worktree(&state, &repo, &wt_path).await;
        assert!(
            !std::path::Path::new(&wt_path).exists(),
            "worktree removed after abort"
        );
    }

    /// Discarding a path holding glob metacharacters touches ONLY that path.
    /// Pathspecs glob, so a raw `src/app/[slug]/page.tsx` also restores the
    /// character-class sibling `src/app/s/page.tsx` — silently destroying
    /// uncommitted work the user never selected (measured, git 2.51.1).
    #[tokio::test]
    async fn discard_paths_does_not_restore_glob_siblings() {
        let (dir, repo) = setup_repo("discard-glob-sibling").await;
        std::fs::create_dir_all(dir.path().join("src/app/[slug]")).unwrap();
        std::fs::create_dir_all(dir.path().join("src/app/s")).unwrap();
        commit_file(&repo, dir.path(), "src/app/[slug]/page.tsx", "v0\n", "add route").await;
        commit_file(&repo, dir.path(), "src/app/s/page.tsx", "v0\n", "add sibling").await;

        std::fs::write(dir.path().join("src/app/[slug]/page.tsx"), "throw away\n").unwrap();
        std::fs::write(dir.path().join("src/app/s/page.tsx"), "PRECIOUS\n").unwrap();

        let state = AppState::default();
        git_discard_paths_core(
            &state,
            repo.clone(),
            vec![DiscardPath {
                path: "src/app/[slug]/page.tsx".into(),
                untracked: false,
            }],
        )
        .await
        .unwrap();

        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("src/app/[slug]/page.tsx")).unwrap()),
            "v0\n",
            "the selected file is discarded"
        );
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("src/app/s/page.tsx")).unwrap()),
            "PRECIOUS\n",
            "the glob-sibling keeps its uncommitted work"
        );
    }

    // --- git_stash_paths_core: selective stash must not leak unselected staged files ---

    /// Strip CRLF → LF so content assertions are line-ending-agnostic: on Windows
    /// with `core.autocrlf=true` git checks blobs out CRLF, so a worktree read (or a
    /// `git show :f` of a text blob) comes back with `\r\n`.
    fn nlf(s: impl AsRef<str>) -> String {
        s.as_ref().replace("\r\n", "\n")
    }

    /// Names listed in a stash entry (`^2` index + `^3` untracked), one per line.
    async fn stash_names(repo: &str) -> Vec<String> {
        git(
            repo,
            &[
                "stash",
                "show",
                "--include-untracked",
                "--name-only",
                "stash@{0}",
            ],
        )
        .await
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// Count of stash entries.
    async fn stash_count(repo: &str) -> usize {
        git(repo, &["stash", "list"])
            .await
            .lines()
            .filter(|l| !l.is_empty())
            .count()
    }

    #[tokio::test]
    async fn directory_selection_matches_pathspec_semantics() {
        let (dir, repo) = setup_repo("stash-dir-selection").await;
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        commit_file(&repo, dir.path(), "src/a.txt", "a0\n", "add src/a").await;
        commit_file(&repo, dir.path(), "src/b.txt", "b0\n", "add src/b").await;
        commit_file(&repo, dir.path(), "other.txt", "o0\n", "add other").await;
        // Stage changes to src/a.txt AND other.txt; leave src/b.txt unstaged.
        std::fs::write(dir.path().join("src/a.txt"), "a1\n").unwrap();
        std::fs::write(dir.path().join("other.txt"), "o1\n").unwrap();
        git(&repo, &["add", "src/a.txt", "other.txt"]).await;
        std::fs::write(dir.path().join("src/b.txt"), "b1\n").unwrap();

        let state = AppState::default();
        // A directory pathspec: git stashes src/* recursively, so the classification
        // must treat both src files as selected (not misclassify them as unselected).
        git_stash_paths_core(&state, repo.clone(), vec!["src".into()])
            .await
            .unwrap();

        // Stash lists exactly the two src files (order-insensitive).
        let mut names = stash_names(&repo).await;
        names.sort();
        assert_eq!(names, vec!["src/a.txt".to_string(), "src/b.txt".to_string()]);
        // other.txt still staged with its full change.
        assert_eq!(nlf(git(&repo, &["show", ":other.txt"]).await), "o1\n");
        // Both src files reverted to HEAD in the worktree.
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("src/a.txt")).unwrap()), "a0\n");
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("src/b.txt")).unwrap()), "b0\n");
        // No split-brain: neither src file is left staged (which would mean its
        // change lives in BOTH the stash and the index).
        let cached = git(&repo, &["diff", "--cached", "--name-only"]).await;
        assert!(!cached.contains("src/a.txt"), "src/a.txt not staged: {cached:?}");
        assert!(!cached.contains("src/b.txt"), "src/b.txt not staged: {cached:?}");
    }

    #[tokio::test]
    async fn stashes_only_selected_leaves_unselected_fully_staged() {
        let (dir, repo) = setup_repo("stash-only-selected").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // A fully staged, B unstaged working-tree change.
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        // Stash lists ONLY B — A did not ride along.
        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // A is still staged with its full change.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
        // B was reverted to HEAD in the worktree.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("B")).unwrap()),
            "b0\n"
        );
    }

    #[tokio::test]
    async fn fast_path_stashes_selection_when_nothing_else_staged() {
        // Fast path: nothing staged at all, so the native pathspec stash is exact.
        let (dir, repo) = setup_repo("stash-fast-nothing-staged").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // Only an UNSTAGED change to B; index is clean.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // B reverted to HEAD in the worktree.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("B")).unwrap()),
            "b0\n"
        );
        // No staged entries appeared (the fast path staged nothing).
        assert!(
            git(&repo, &["diff", "--cached", "--name-only"]).await.trim().is_empty(),
            "no staged entries after fast-path stash"
        );
        assert_eq!(stash_count(&repo).await, 1);
    }

    #[tokio::test]
    async fn fast_path_when_selection_is_the_only_staged_file() {
        // Fast path: the selection IS the only staged file, so nothing else needs
        // protecting.
        let (dir, repo) = setup_repo("stash-fast-only-staged").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["A".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["A".to_string()]);
        // A reverted to HEAD in the worktree; A's staged change went into the stash.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a0\n"
        );
        assert!(
            git(&repo, &["diff", "--cached", "--name-only"]).await.trim().is_empty(),
            "no staged entries after fast-path stash"
        );
        // Popping restores A's change to the worktree.
        git(&repo, &["stash", "pop"]).await;
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a1\n"
        );
    }

    // Helper: overwrite `f` with `staged`, `git add f`, then overwrite the worktree
    // with `worktree` — the index now holds `staged`, the worktree holds `worktree`
    // (deterministic hunk-level partial staging).
    async fn partial_stage(repo: &str, dir: &std::path::Path, f: &str, staged: &str, worktree: &str) {
        std::fs::write(dir.join(f), staged).unwrap();
        git(repo, &["add", f]).await;
        std::fs::write(dir.join(f), worktree).unwrap();
    }

    #[tokio::test]
    async fn preserves_unselected_partial_staging() {
        let (dir, repo) = setup_repo("stash-partial-unselected").await;
        let full = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
        commit_file(&repo, dir.path(), "A2", full, "add A2").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // A2 partially staged: index gets line2 edited, worktree also edits line9.
        let staged = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
        let worktree = "l1\nL2\nl3\nl4\nl5\nl6\nl7\nl8\nL9\n";
        partial_stage(&repo, dir.path(), "A2", staged, worktree).await;
        // B unstaged.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        // Stash lists only B.
        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // A2's index blob (partial hunk) and worktree are both unchanged.
        assert_eq!(nlf(git(&repo, &["show", ":A2"]).await), staged);
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A2")).unwrap()),
            worktree
        );
    }

    #[tokio::test]
    async fn preserves_unselected_staged_new_and_deletion() {
        let (dir, repo) = setup_repo("stash-new-and-delete").await;
        commit_file(&repo, dir.path(), "D", "d0\n", "add D").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        // N staged-new.
        std::fs::write(dir.path().join("N"), "n0\n").unwrap();
        git(&repo, &["add", "N"]).await;
        // D staged-delete.
        git(&repo, &["rm", "D"]).await;
        // B unstaged.
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert_eq!(stash_names(&repo).await, vec!["B".to_string()]);
        // N still staged as an addition; D still staged as a deletion.
        let staged_status = git(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(staged_status.contains("A\tN"), "N staged-new: {staged_status:?}");
        assert!(staged_status.contains("D\tD"), "D staged-delete: {staged_status:?}");

        // After popping the (B-only) stash, N/D states are intact.
        git(&repo, &["stash", "pop"]).await;
        let after = git(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(after.contains("A\tN"), "N intact after pop: {after:?}");
        assert!(after.contains("D\tD"), "D intact after pop: {after:?}");
    }

    #[tokio::test]
    async fn selected_partially_staged_file_fully_stashed_and_reverts() {
        let (dir, repo) = setup_repo("stash-selected-partial").await;
        let full = "p1\np2\np3\n";
        commit_file(&repo, dir.path(), "P", full, "add P").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        // P partially staged (selected): index edits p1, worktree also edits p3.
        let staged = "P1\np2\np3\n";
        let worktree = "P1\np2\nP3\n";
        partial_stage(&repo, dir.path(), "P", staged, worktree).await;
        // A fully staged (unselected).
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["P".into()])
            .await
            .unwrap();

        // Stash lists only P; A stayed staged.
        assert_eq!(stash_names(&repo).await, vec!["P".to_string()]);
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
        // P reverted to HEAD in the worktree.
        assert_eq!(nlf(std::fs::read_to_string(dir.path().join("P")).unwrap()), full);

        // Popping restores P's FULL change into the worktree — both the staged and
        // unstaged hunks (p1→P1 AND p3→P3). A plain `stash pop` (no --index) restores
        // to the worktree only, so we assert the file content, not the index split.
        git(&repo, &["stash", "pop"]).await;
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("P")).unwrap()),
            worktree
        );
    }

    #[tokio::test]
    async fn selected_untracked_file_stashed_and_removed() {
        let (dir, repo) = setup_repo("stash-selected-untracked").await;
        // Another staged file so we exercise the index-protecting path.
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;
        // U untracked, selected.
        std::fs::write(dir.path().join("U"), "u0\n").unwrap();

        let state = AppState::default();
        git_stash_paths_core(&state, repo.clone(), vec!["U".into()])
            .await
            .unwrap();

        // U gone from the worktree, and listed in the stash's untracked parent.
        assert!(!dir.path().join("U").exists(), "U removed from worktree");
        assert_eq!(stash_names(&repo).await, vec!["U".to_string()]);
        // A left staged, untouched.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
    }

    #[tokio::test]
    async fn refuses_selective_stash_during_merge() {
        let (dir, repo) = setup_repo("stash-merge-refuse").await;
        commit_file(&repo, dir.path(), "x", "base\n", "add x").await;
        let base = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Two branches editing x divergently → conflicting merge.
        git(&repo, &["switch", "-c", "other"]).await;
        commit_file(&repo, dir.path(), "x", "other\n", "other edit").await;
        git(&repo, &["switch", &base]).await;
        commit_file(&repo, dir.path(), "x", "main\n", "main edit").await;
        // Conflicting merge leaves an unmerged index (merge in progress). Use
        // run_git_raw — a conflicting `git merge` exits non-zero, which run_git
        // would surface as an Err.
        let merge = run_git_raw(Some(&repo), &["merge", "other"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(merge.code, 0, "merge should conflict");

        let state = AppState::default();
        let err = git_stash_paths_core(&state, repo.clone(), vec!["x".into()])
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        // No stash created.
        assert_eq!(stash_count(&repo).await, 0);
    }

    #[tokio::test]
    async fn empty_selection_is_noop() {
        let (dir, repo) = setup_repo("stash-empty").await;
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec![])
            .await
            .unwrap();

        assert!(!created);
        assert_eq!(stash_count(&repo).await, 0);
    }

    /// A selection that matches nothing reports `false`. `git stash push` exits 0
    /// on that path, so without the return the MCP tool answers "stashed" for a
    /// no-op and the agent believes work was put away.
    #[tokio::test]
    async fn selection_matching_nothing_reports_no_stash() {
        let (dir, repo) = setup_repo("stash-no-match").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        // An unrelated uncommitted change, so the repo is NOT clean overall.
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["nonexistent.txt".into()])
            .await
            .unwrap();

        assert!(!created, "nothing matched, so no stash entry was created");
        assert_eq!(stash_count(&repo).await, 0);
        // The unrelated change is untouched.
        assert_eq!(
            nlf(std::fs::read_to_string(dir.path().join("A")).unwrap()),
            "a1\n"
        );
    }

    /// The index-protecting slow path reports the same way: the selection matches
    /// nothing while another file stays staged.
    #[tokio::test]
    async fn slow_path_selection_matching_nothing_reports_no_stash() {
        let (dir, repo) = setup_repo("stash-no-match-slow").await;
        commit_file(&repo, dir.path(), "A", "a0\n", "add A").await;
        std::fs::write(dir.path().join("A"), "a1\n").unwrap();
        git(&repo, &["add", "A"]).await;

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["nonexistent.txt".into()])
            .await
            .unwrap();

        assert!(!created);
        assert_eq!(stash_count(&repo).await, 0);
        // A survived the reset/restore round trip with its staged blob intact.
        assert_eq!(nlf(git(&repo, &["show", ":A"]).await), "a1\n");
    }

    #[tokio::test]
    async fn real_selection_reports_a_stash_was_created() {
        let (dir, repo) = setup_repo("stash-reports-created").await;
        commit_file(&repo, dir.path(), "B", "b0\n", "add B").await;
        std::fs::write(dir.path().join("B"), "b1\n").unwrap();

        let state = AppState::default();
        let created = git_stash_paths_core(&state, repo.clone(), vec!["B".into()])
            .await
            .unwrap();

        assert!(created);
        assert_eq!(stash_count(&repo).await, 1);
    }
}
