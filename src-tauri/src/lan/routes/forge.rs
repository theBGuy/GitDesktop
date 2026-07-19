//! Read-only forge routes — thin adapters over the existing `crate::forge::*`
//! core fns (which fan out to GitHub/GitLab/Bitbucket by the repo's remote). Each
//! reads its scoped repo from the `Extension<ScopedRepo>` a resolver middleware
//! inserts and calls the core fn unchanged. The `lens` param is deliberately
//! omitted from the HTTP surface (always `None`).
//!
//! Note: the forge issue fns hard-error on Bitbucket ("Bitbucket issues aren't
//! supported yet."); that surfaces as the mapped `InvalidArgument` → 400. It is
//! NOT special-cased here — the error propagates like any other.

use std::collections::HashMap;

use axum::extract::{Path, Query};
use axum::response::Response;
use axum::Extension;
use serde::Deserialize;

use crate::lan::routes::{bad_request, path_param, respond, ScopedRepo};

/// Read a `u64` path param by name (`number`/`id`), returning the app's standard
/// 400 when it's absent or not a non-negative integer. Shared across both mounts,
/// so the param is read by name (see [`crate::lan::routes`]). The `Err` `Response`
/// is boxed to keep the `Result` small (the `result_large_err` lint).
fn u64_param(params: &HashMap<String, String>, name: &str) -> Result<u64, Box<Response>> {
    let raw = path_param(params, name)?;
    raw.parse::<u64>()
        .map_err(|_| Box::new(bad_request(&format!("{name} must be a non-negative integer"))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    state: Option<String>,
    limit: Option<u32>,
}

/// GET PR list (alias: `/api/forge/prs?state&limit`).
pub async fn pr_list(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<ListQuery>,
) -> Response {
    let pr_state = q.state.unwrap_or_else(|| "open".to_string());
    respond(crate::forge::forge_pr_list(repo, pr_state, q.limit, None).await)
}

/// GET PR view (alias: `/api/forge/prs/{number}`).
pub async fn pr_view(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let number = match u64_param(&params, "number") {
        Ok(n) => n,
        Err(resp) => return *resp,
    };
    respond(crate::forge::forge_pr_view(repo, number, None).await)
}

/// GET PR activity timeline (alias: `/api/forge/prs/{number}/timeline`).
pub async fn pr_timeline(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let number = match u64_param(&params, "number") {
        Ok(n) => n,
        Err(resp) => return *resp,
    };
    respond(crate::forge::forge_pr_timeline(repo, number, None).await)
}

/// GET PR review threads (alias: `/api/forge/prs/{number}/threads`).
pub async fn pr_threads(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let number = match u64_param(&params, "number") {
        Ok(n) => n,
        Err(resp) => return *resp,
    };
    respond(crate::forge::forge_pr_review_threads(repo, number, None).await)
}

/// GET issue list (alias: `/api/forge/issues?state&limit`).
pub async fn issue_list(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<ListQuery>,
) -> Response {
    let issue_state = q.state.unwrap_or_else(|| "open".to_string());
    respond(crate::forge::forge_issue_list(repo, issue_state, q.limit, None).await)
}

/// GET issue view (alias: `/api/forge/issues/{number}`).
pub async fn issue_view(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let number = match u64_param(&params, "number") {
        Ok(n) => n,
        Err(resp) => return *resp,
    };
    respond(crate::forge::forge_issue_view(repo, number, None).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiListQuery {
    limit: Option<u32>,
    branch: Option<String>,
}

/// GET CI run list (alias: `/api/forge/ci/runs?limit&branch`).
pub async fn ci_run_list(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<CiListQuery>,
) -> Response {
    let limit = q.limit.unwrap_or(20);
    respond(crate::forge::forge_ci_run_list(repo, limit, q.branch).await)
}

/// GET CI run view (alias: `/api/forge/ci/runs/{id}`).
pub async fn ci_run_view(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let id = match u64_param(&params, "id") {
        Ok(i) => i,
        Err(resp) => return *resp,
    };
    respond(crate::forge::forge_ci_run_view(repo, id.to_string()).await)
}
