//! Read-only forge routes — thin adapters over the existing `crate::forge::*`
//! core fns (which fan out to GitHub/GitLab/Bitbucket by the repo's remote). Each
//! pulls the active repo from state and calls the core fn unchanged. The `lens`
//! param is deliberately omitted from the HTTP surface (always `None`).
//!
//! Note: the forge issue fns hard-error on Bitbucket ("Bitbucket issues aren't
//! supported yet."); that surfaces as the mapped `InvalidArgument` → 400. It is
//! NOT special-cased here — the error propagates like any other.

use axum::extract::{Path, Query, State};
use axum::response::Response;
use serde::Deserialize;

use crate::lan::auth::RouterState;
use crate::lan::routes::{repo_or_409, respond};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    state: Option<String>,
    limit: Option<u32>,
}

/// GET /api/forge/prs?state&limit
pub async fn pr_list(State(state): State<RouterState>, Query(q): Query<ListQuery>) -> Response {
    let repo = repo_or_409!(state);
    let pr_state = q.state.unwrap_or_else(|| "open".to_string());
    respond(crate::forge::forge_pr_list(repo, pr_state, q.limit, None).await)
}

/// GET /api/forge/prs/{number}
pub async fn pr_view(State(state): State<RouterState>, Path(number): Path<u64>) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::forge::forge_pr_view(repo, number, None).await)
}

/// GET /api/forge/issues?state&limit
pub async fn issue_list(State(state): State<RouterState>, Query(q): Query<ListQuery>) -> Response {
    let repo = repo_or_409!(state);
    let issue_state = q.state.unwrap_or_else(|| "open".to_string());
    respond(crate::forge::forge_issue_list(repo, issue_state, q.limit, None).await)
}

/// GET /api/forge/issues/{number}
pub async fn issue_view(State(state): State<RouterState>, Path(number): Path<u64>) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::forge::forge_issue_view(repo, number, None).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiListQuery {
    limit: Option<u32>,
    branch: Option<String>,
}

/// GET /api/forge/ci/runs?limit&branch
pub async fn ci_run_list(
    State(state): State<RouterState>,
    Query(q): Query<CiListQuery>,
) -> Response {
    let repo = repo_or_409!(state);
    let limit = q.limit.unwrap_or(20);
    respond(crate::forge::forge_ci_run_list(repo, limit, q.branch).await)
}

/// GET /api/forge/ci/runs/{id}
pub async fn ci_run_view(State(state): State<RouterState>, Path(id): Path<u64>) -> Response {
    let repo = repo_or_409!(state);
    respond(crate::forge::forge_ci_run_view(repo, id.to_string()).await)
}
