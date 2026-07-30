use tauri::State;

use crate::error::AppResult;
use crate::git::runner::{run_git, run_git_mutating, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::git::types::Submodule;
use crate::state::AppState;

/// Lists the repo's submodules with their status. Empty for a repo without any.
#[tauri::command]
pub async fn git_submodules(repo_path: String) -> AppResult<Vec<Submodule>> {
    // `git submodule status` prints "[ +-U]<sha> <path>[ (<describe>)]" per line.
    // The leading flag means: ' ' in sync, '-' not initialized, '+' the checked-
    // out commit differs from the one recorded, 'U' merge conflicts.
    let out = run_git(Some(&repo_path), &["submodule", "status"], DEFAULT_TIMEOUT).await?;
    let mut subs = Vec::new();
    for line in out.stdout_lossy().lines() {
        if line.is_empty() {
            continue;
        }
        let flag = line.as_bytes()[0];
        let rest = &line[1..];
        let mut parts = rest.splitn(2, ' ');
        let sha = parts.next().unwrap_or("").to_string();
        let remainder = parts.next().unwrap_or("");
        let (path, describe) = match remainder.rfind(" (") {
            Some(i) => (
                remainder[..i].to_string(),
                remainder[i + 2..].trim_end_matches(')').to_string(),
            ),
            None => (remainder.to_string(), String::new()),
        };
        if path.is_empty() {
            continue;
        }
        let status = match flag {
            b'-' => "uninitialized",
            b'+' => "modified",
            b'U' => "conflict",
            _ => "ok",
        };
        subs.push(Submodule {
            path,
            sha,
            describe,
            status: status.to_string(),
        });
    }
    Ok(subs)
}

/// Initializes (when needed) and updates submodules to the commit the parent
/// repo records. `path` targets one submodule; `None` updates all.
#[tauri::command]
pub async fn git_submodule_update(
    state: State<'_, AppState>,
    repo_path: String,
    path: Option<String>,
) -> AppResult<()> {
    // The path comes from `git submodule status`, so it must match itself alone:
    // the builtin honors pathspec magic, and a raw `libs/[mod]` initializes the
    // sibling `libs/m` INSTEAD — cloning the wrong repo (measured, git 2.51.1).
    let spec = path
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(crate::git::pathspec::literal);
    let mut args = vec!["submodule", "update", "--init"];
    if let Some(spec) = spec.as_deref() {
        args.push("--");
        args.push(spec);
    }
    run_git_mutating(&state, &repo_path, &args, NETWORK_TIMEOUT).await?;
    Ok(())
}
