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

/// A 400 response with the app's standard `{ kind, message }` shape (mirrors
/// [`crate::lan::auth::bad_request`], reused by routes that validate client input
/// before touching the git core).
pub(crate) fn bad_request(message: &str) -> Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::json;

    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "kind": "invalidArgument",
            "message": message
        })),
    )
        .into_response()
}

/// Whether `path` is a safe repo-relative path: non-empty and built only from
/// `Normal`/`CurDir` components. Any `RootDir` (a leading `/`), `Prefix` (a
/// Windows drive like `C:`), or `ParentDir` (`..`) component rejects it — those
/// are the ways a client could escape the repo. This is a purely lexical check;
/// callers that also need on-disk containment (the untracked `--no-index` path)
/// must additionally canonicalize + `starts_with` the repo root.
pub(crate) fn is_safe_relative_path(path: &str) -> bool {
    use std::path::{Component, Path};
    if path.is_empty() {
        return false;
    }
    Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
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

#[cfg(test)]
mod tests {
    use super::is_safe_relative_path;

    #[test]
    fn safe_relative_paths_accepted() {
        assert!(is_safe_relative_path("src/main.rs"));
        assert!(is_safe_relative_path("./src/main.rs"));
        assert!(is_safe_relative_path("file.txt"));
    }

    #[test]
    fn escaping_paths_rejected() {
        assert!(!is_safe_relative_path("")); // empty
        assert!(!is_safe_relative_path("../x")); // ParentDir
        assert!(!is_safe_relative_path("a/../b")); // ParentDir mid-path
        assert!(!is_safe_relative_path("/etc/passwd")); // RootDir (leading /)
        #[cfg(windows)]
        assert!(!is_safe_relative_path("C:/x")); // Prefix (drive), Windows only
    }
}
