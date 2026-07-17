//! The read-only route handlers mounted by the LAN companion server.
//!
//! The allowlist is STRUCTURAL: [`crate::lan::server`] mounts exactly the 13
//! handlers below and nothing else — there is no catch-all and no static
//! serving, so any path outside the list 404s. Each handler pulls the active
//! repo from [`crate::lan::auth::RouterState`] (a `None` active repo → 409), calls
//! the existing core git/forge fn unchanged, and returns its result as JSON with
//! no shape translation. Errors map via [`crate::lan::auth::app_error_response`].

pub mod forge;
pub mod git;
pub mod reviews;

use axum::response::Response;

use crate::lan::auth::RouterState;

/// The active repo path from router state, or `None` when none is set. The 409
/// response for the `None` case is built at the call site (via [`no_active_repo`])
/// so this stays a cheap `Option` rather than a `Result` carrying a large
/// `Response` in its `Err` arm.
pub(crate) fn active_repo(state: &RouterState) -> Option<String> {
    state
        .active_repo
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

/// The 409 response returned when no repo is shared yet.
pub(crate) fn no_active_repo() -> Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::json;

    (
        StatusCode::CONFLICT,
        Json(json!({
            "kind": "noActiveRepo",
            "message": "no active repository is shared yet"
        })),
    )
        .into_response()
}

/// Convenience: fetch the active repo or short-circuit-return its 409 response.
macro_rules! repo_or_409 {
    ($state:expr) => {
        match $crate::lan::routes::active_repo(&$state) {
            Some(r) => r,
            None => return $crate::lan::routes::no_active_repo(),
        }
    };
}

pub(crate) use repo_or_409;

/// Wrap an `AppResult<T: Serialize>` into a JSON response or the mapped error.
pub(crate) fn json_or_error<T: serde::Serialize>(
    result: crate::error::AppResult<T>,
) -> Response {
    use axum::response::IntoResponse;
    use axum::Json;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(err) => crate::lan::auth::app_error_response(&err),
    }
}

pub(crate) use json_or_error as respond;
