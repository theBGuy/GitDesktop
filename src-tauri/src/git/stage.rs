use tauri::State;

use crate::error::AppResult;
use crate::git::runner::{run_git_mutating, run_git_raw, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Keep each git invocation comfortably under the Windows ~32K command-line
/// limit when staging/unstaging many files at once.
const PATHS_PER_BATCH: usize = 100;

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    git_stage_core(&state, repo_path, paths).await
}

pub(crate) async fn git_stage_core(
    state: &AppState,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    for batch in paths.chunks(PATHS_PER_BATCH) {
        let mut args = vec!["add", "--"];
        args.extend(batch.iter().map(String::as_str));
        run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    git_unstage_core(&state, repo_path, paths).await
}

pub(crate) async fn git_unstage_core(
    state: &AppState,
    repo_path: String,
    paths: Vec<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;

    for batch in paths.chunks(PATHS_PER_BATCH) {
        let mut args: Vec<&str> = if head_exists {
            vec!["restore", "--staged", "--"]
        } else {
            // No HEAD to restore from (empty repo): drop from the index instead.
            vec!["rm", "--cached", "-r", "--quiet", "--"]
        };
        args.extend(batch.iter().map(String::as_str));
        run_git_mutating(state, &repo_path, &args, DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}
