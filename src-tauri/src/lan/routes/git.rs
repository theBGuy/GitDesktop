//! Read-only git routes — thin adapters over the existing `crate::git::*` core
//! fns. Each pulls the active repo from state, calls the core fn with no shape
//! translation, and returns its result as JSON. No new git logic lives here.

use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;

use crate::lan::auth::RouterState;
use crate::lan::routes::{bad_request, is_safe_relative_path, repo_or_409, respond};

/// GET /api/repo/status
pub async fn status(State(state): State<RouterState>) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::git::status::status_core(&repo).await)
}

/// GET /api/repo/branches
pub async fn branches(State(state): State<RouterState>) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::git::branches::git_branches(repo).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    limit: Option<u32>,
    skip: Option<u32>,
    search: Option<String>,
}

/// GET /api/repo/log?limit&skip&search
pub async fn log(State(state): State<RouterState>, Query(q): Query<LogQuery>) -> Response {
    let repo = repo_or_409!(state);
    let limit = q.limit.unwrap_or(50);
    let skip = q.skip.unwrap_or(0);
    respond(crate::git::history::git_log(repo, limit, skip, q.search).await)
}

/// GET /api/repo/commits/{hash}
pub async fn commit_details(
    State(state): State<RouterState>,
    Path(hash): Path<String>,
) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::git::history::git_commit_details(repo, hash).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaxBytesQuery {
    max_bytes: Option<usize>,
}

/// GET /api/repo/commits/{hash}/diff?maxBytes
pub async fn commit_diff(
    State(state): State<RouterState>,
    Path(hash): Path<String>,
    Query(q): Query<MaxBytesQuery>,
) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::git::history::git_commit_diff(repo, hash, q.max_bytes).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffQuery {
    max_bytes: Option<usize>,
    worktree: Option<bool>,
}

/// GET /api/repo/diff/working?maxBytes&worktree
pub async fn diff_working(
    State(state): State<RouterState>,
    Query(q): Query<WorkingDiffQuery>,
) -> Response {
    let repo = repo_or_409!(state);
    // `exclude` has no HTTP surface in this slice — always None.
    respond(crate::git::diff::git_staged_diff(repo, q.max_bytes, None, q.worktree).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffQuery {
    path: String,
    #[serde(default)]
    staged: bool,
    #[serde(default)]
    untracked: bool,
}

/// GET /api/repo/diff/file?path&staged&untracked
pub async fn diff_file(
    State(state): State<RouterState>,
    Query(q): Query<FileDiffQuery>,
) -> Response {
    let repo = repo_or_409!(state);
    // Path containment: this is a paired LAN device supplying `path`, and the
    // untracked branch of `git_diff_file` runs `git diff --no-index` (NOT
    // repo-confined). Reject anything that isn't a safe repo-relative path so a
    // device can't read arbitrary files (e.g. `?path=/etc/passwd&untracked=true`).
    if !is_safe_relative_path(&q.path) {
        return bad_request("path must be a repo-relative path");
    }
    // For the untracked (`--no-index`, on-disk) branch, also require that the
    // resolved file actually lives inside the repo — closes the symlink-that-
    // points-outside case that a purely lexical check can't. (Untracked files
    // exist on disk, so canonicalize succeeds for legitimate requests. The
    // tracked branch is skipped: git confines its own pathspecs, and a
    // deleted-but-tracked file isn't on disk to canonicalize.)
    if q.untracked {
        let repo_root = match std::fs::canonicalize(&repo) {
            Ok(p) => p,
            Err(_) => return bad_request("path is outside the shared repository"),
        };
        match std::fs::canonicalize(std::path::Path::new(&repo).join(&q.path)) {
            Ok(target) if target.starts_with(&repo_root) => {}
            _ => return bad_request("path is outside the shared repository"),
        }
    }
    respond(crate::git::diff::git_diff_file(repo, q.path, q.staged, q.untracked).await)
}
