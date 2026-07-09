use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::state::AppState;

fn validate_remote_arg(value: &str, what: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid {what}: {value}")));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_remote_url(repo_path: String, name: String) -> AppResult<String> {
    validate_remote_arg(&name, "remote name")?;
    let out = run_git(
        Some(&repo_path),
        &["remote", "get-url", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy().trim().to_string())
}

#[tauri::command]
pub async fn git_remote_set_url(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<()> {
    validate_remote_arg(&name, "remote name")?;
    validate_remote_arg(url.trim(), "remote URL")?;
    run_git_mutating(
        &state,
        &repo_path,
        &["remote", "set-url", &name, url.trim()],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Names of the configured remotes (e.g. `["origin"]`), empty for a local repo.
#[tauri::command]
pub async fn git_remotes(repo_path: String) -> AppResult<Vec<String>> {
    let out = run_git(Some(&repo_path), &["remote"], DEFAULT_TIMEOUT).await?;
    Ok(out
        .stdout_lossy()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_fetch_core(&state, repo_path).await
}

pub(crate) async fn git_fetch_core(state: &AppState, repo_path: String) -> AppResult<()> {
    run_git_mutating(state, &repo_path, &["fetch", "--prune"], NETWORK_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    repo_path: String,
    mode: String,
) -> AppResult<()> {
    git_pull_core(&state, repo_path, mode).await
}

pub(crate) async fn git_pull_core(
    state: &AppState,
    repo_path: String,
    mode: String,
) -> AppResult<()> {
    // "rebase"/"merge" reconcile a diverged branch; the default stays the safe
    // fast-forward-only. A conflicted rebase/merge surfaces in the conflict UI.
    let flag = match mode.as_str() {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        _ => "--ff-only",
    };
    run_git_mutating(state, &repo_path, &["pull", flag], NETWORK_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    repo_path: String,
    set_upstream: bool,
    force: bool,
) -> AppResult<()> {
    git_push_core(&state, repo_path, set_upstream, force).await
}

pub(crate) async fn git_push_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
) -> AppResult<()> {
    let mut args = vec!["push"];
    if force {
        // refuses to clobber remote work that arrived after our last fetch
        args.push("--force-with-lease");
    }
    if set_upstream {
        args.extend(["-u", "origin", "HEAD"]);
    }
    run_git_mutating(state, &repo_path, &args, NETWORK_TIMEOUT).await?;
    Ok(())
}
