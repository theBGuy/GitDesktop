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

use crate::forge::model::Provider;
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

/// The 400 returned when a discussions route is hit on a non-GitHub repo. The
/// desktop gates discussions client-side (`forgeSupports`), so the `gh_discussion_*`
/// core fns have no server-side host guard — without this they'd emit a raw
/// `AppError::Gh` on a GitLab/Bitbucket repo. `discussionsUnavailable` is a VERBATIM
/// cross-layer contract: the companion matches this `kind` exactly to render its
/// teaching state — do not rename it. Mirrors the `bad_request`/`no_active_repo`
/// response-builder style in [`crate::lan::routes`].
fn discussions_unavailable() -> Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::json;

    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "kind": "discussionsUnavailable",
            "message": "Discussions aren't available on this repository's host."
        })),
    )
        .into_response()
}

/// Whether the repo's host supports GitHub Discussions. `detect_non_github` returns
/// `Some((GitLab | Bitbucket, _))` for a known non-GitHub host → block; `None`
/// (GitHub-or-unknown, the app's gh-default routing) or a `GitHub` arm (GHE hosts)
/// → proceed. Runs BEFORE any `gh` invocation, so a non-GitHub repo short-circuits
/// with no network call.
async fn discussions_allowed(repo: &str) -> bool {
    !matches!(
        crate::forge::detect_non_github(repo).await,
        Some((Provider::GitLab | Provider::Bitbucket, _))
    )
}

/// GET discussion metadata (alias: `/api/forge/discussions/meta`). Node id, whether
/// discussions are enabled, and the categories.
pub async fn discussions_meta(Extension(ScopedRepo(repo)): Extension<ScopedRepo>) -> Response {
    if !discussions_allowed(&repo).await {
        return discussions_unavailable();
    }
    respond(crate::github::discussion::gh_discussion_categories(repo).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionListQuery {
    category: Option<String>,
    limit: Option<u32>,
}

/// GET discussion list (alias: `/api/forge/discussions?category&limit`). `category`
/// is a category node id to filter by; absent keeps all categories.
pub async fn discussions_list(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<DiscussionListQuery>,
) -> Response {
    if !discussions_allowed(&repo).await {
        return discussions_unavailable();
    }
    respond(crate::github::discussion::gh_discussion_list(repo, q.category, q.limit).await)
}

/// GET a discussion's full thread (alias: `/api/forge/discussions/{number}`). The
/// `number` path param is read by name so the handler works under both mounts.
///
/// Route order: axum's matchit gives the static `discussions/meta` priority over
/// this `discussions/{number}` pattern, so mounting both is safe regardless of
/// registration order — don't "fix" the ordering.
pub async fn discussions_view(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    if !discussions_allowed(&repo).await {
        return discussions_unavailable();
    }
    let number = match u64_param(&params, "number") {
        Ok(n) => n,
        Err(resp) => return *resp,
    };
    respond(crate::github::discussion::gh_discussion_view(repo, number).await)
}
