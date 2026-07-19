//! The read-only route handlers mounted by the LAN companion server.
//!
//! The allowlist is STRUCTURAL: [`crate::lan::server`] mounts exactly the 17
//! handlers below and nothing else — there is no catch-all and no static serving,
//! so any path outside the list 404s. Every handler operates on ONE resolved repo
//! it reads from the `Extension<ScopedRepo>` a resolver middleware inserts, calls
//! the existing core git/forge fn unchanged, and returns its result as JSON with
//! no shape translation. Errors map via [`crate::lan::auth::app_error_response`].
//!
//! ## Two mounts, one handler set (alias ↔ scoped)
//!
//! [`crate::lan::server`] mounts each handler TWICE, sharing the same fns:
//!
//! * The **alias** subtree — the frozen surface the shipped companion consumes,
//!   scoped to the desktop's *active* repo. A resolver reads `active_repo` from
//!   state and inserts the `ScopedRepo`; a `None` active repo → 409 `noActiveRepo`.
//! * The **scoped** subtree under `/api/repos/{repoId}/…` with FLAT paths (the
//!   alias's `repo`/`forge` grouping segments drop out). A resolver looks
//!   `{repoId}` up in the repo registry → hit inserts the `ScopedRepo`; miss → 404
//!   `noSuchRepo` (404 not 403, so an unknown id and an unshared repo are
//!   indistinguishable — no probe oracle).
//!
//! | alias (active-repo)                   | scoped (`/api/repos/{repoId}/…`)      |
//! |---------------------------------------|---------------------------------------|
//! | `/api/repo/status`                    | `status`                              |
//! | `/api/repo/branches`                  | `branches`                            |
//! | `/api/repo/log`                       | `log`                                 |
//! | `/api/repo/commits/{hash}`            | `commits/{hash}`                      |
//! | `/api/repo/commits/{hash}/diff`       | `commits/{hash}/diff`                 |
//! | `/api/repo/diff/working`              | `diff/working`                        |
//! | `/api/repo/diff/file`                 | `diff/file`                           |
//! | `/api/forge/prs`                      | `prs`                                 |
//! | `/api/forge/prs/{number}`             | `prs/{number}`                        |
//! | `/api/forge/prs/{number}/timeline`    | `prs/{number}/timeline`               |
//! | `/api/forge/prs/{number}/threads`     | `prs/{number}/threads`                |
//! | `/api/forge/issues`                   | `issues`                              |
//! | `/api/forge/issues/{number}`          | `issues/{number}`                     |
//! | `/api/forge/ci/runs`                  | `ci/runs`                             |
//! | `/api/forge/ci/runs/{id}`             | `ci/runs/{id}`                        |
//! | `/api/reviews`                        | `reviews`                             |
//! | `/api/reviews/{id}/stream`            | `reviews/{id}/stream`                 |
//!
//! Plus `GET /api/repos` (protected) → the registered repos (active ∪ shared) as
//! `[{ id, name, active }]`.
//!
//! ## The shared-handler extraction trap
//!
//! A handler mounted under BOTH subtrees sees different path-param sets: `{hash}`
//! alone on the alias mount, `{repoId}` + `{hash}` on the scoped mount. A
//! `Path<String>` extractor would fail on the two-param mount, so every shared
//! handler (and the resolver middleware) that reads a path param extracts
//! `Path<HashMap<String, String>>` and reads the param BY NAME via [`path_param`].

pub mod forge;
pub mod git;
pub mod reviews;

use std::collections::HashMap;

use axum::response::Response;

/// The single repo a request is scoped to, resolved by a resolver middleware and
/// inserted as a request extension. Both the alias subtree (from `active_repo`)
/// and the scoped subtree (from a `{repoId}` registry lookup) produce this, so the
/// handlers are identical under either mount. A newtype around the repo path
/// String; the path is used only server-side (git/forge calls) and never returned.
#[derive(Clone)]
pub(crate) struct ScopedRepo(pub String);

/// Read a path parameter by NAME from the extracted `Path<HashMap<…>>` map. Shared
/// handlers are mounted under two subtrees with different param sets, so params are
/// always read by name rather than positionally. Returns the app's standard 400 on
/// a missing key — which can't happen through the router (the route pattern names
/// the param), but we never unwrap on request-derived data. The `Err` `Response` is
/// boxed so the (impossible) error path doesn't bloat every handler's `Result`.
pub(crate) fn path_param(
    params: &HashMap<String, String>,
    name: &str,
) -> Result<String, Box<Response>> {
    params
        .get(name)
        .cloned()
        .ok_or_else(|| Box::new(bad_request(&format!("missing path parameter: {name}"))))
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

/// Alias-subtree resolver middleware: scope the request to the desktop's ACTIVE
/// repo. Reads `active_repo` from state and inserts a [`ScopedRepo`] extension the
/// handlers read; a `None` active repo short-circuits with the frozen 409
/// `noActiveRepo` (the same response the shipped companion's read routes returned
/// before the scoped mount existed — its body moved here from the old per-handler
/// macro).
pub(crate) async fn resolve_active_repo(
    axum::extract::State(state): axum::extract::State<crate::lan::auth::RouterState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let active = state
        .active_repo
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let Some(repo) = active else {
        return no_active_repo();
    };
    req.extensions_mut().insert(ScopedRepo(repo));
    next.run(req).await
}

/// Scoped-subtree resolver middleware: scope the request to the repo named by the
/// `{repoId}` path param. Looks the id up in the repo registry → hit inserts a
/// [`ScopedRepo`] extension; miss → 404 `noSuchRepo`. 404 (not 403) so an unknown
/// id and an unshared repo are indistinguishable — no probe oracle for which repos
/// exist. Extractors precede `req`/`next` in the `from_fn` signature, as axum
/// requires.
pub(crate) async fn resolve_scoped_repo(
    axum::extract::State(state): axum::extract::State<crate::lan::auth::RouterState>,
    axum::extract::Path(params): axum::extract::Path<HashMap<String, String>>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let repo_id = match path_param(&params, "repoId") {
        Ok(id) => id,
        Err(resp) => return *resp,
    };
    let path = state
        .repos
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&repo_id)
        .map(|r| r.path.clone());
    let Some(path) = path else {
        return no_such_repo();
    };
    req.extensions_mut().insert(ScopedRepo(path));
    next.run(req).await
}

/// The frozen 409 returned by the alias subtree when no repo is shared yet.
fn no_active_repo() -> Response {
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

/// The 404 returned by the scoped subtree for an unknown/unshared `{repoId}`.
fn no_such_repo() -> Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::json;

    (
        StatusCode::NOT_FOUND,
        Json(json!({
            "kind": "noSuchRepo",
            "message": "no shared repository with that id"
        })),
    )
        .into_response()
}

/// GET /api/repos — the registered repos as `[{ id, name, active }]` (camelCase):
/// the desktop's ACTIVE repo ∪ the persisted SHARED set. `active` is `true` for the
/// entry whose opaque id equals the desktop's current active id — at most one, and
/// none when no repo is active. Flagging BY ID (not by path) matches the id-based
/// identity the registry dedups on: a repo shared under one worktree path while the
/// desktop is open on another occupies one entry (same id) whose stored path may
/// differ from the active path, so a path compare would wrongly report `active:
/// false`. Only the opaque id + display name + `active` flag reach the wire — never a
/// filesystem path. (An id compare also avoids a filesystem `canonicalize` under the
/// `repos` lock.)
///
/// The active id and the entries are read under separate short locks (never nested).
/// Any transient skew between `active_repo_id` and the registry during a slow install
/// is the same eventual-consistency of a UI bool that exists across the feature — a
/// switch settles it within one install; nothing keys correctness on the flag.
pub(crate) async fn list_repos(
    axum::extract::State(state): axum::extract::State<crate::lan::auth::RouterState>,
) -> Response {
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::Json;
    use serde_json::json;

    // Snapshot the active id once under its own lock (dropped before locking `repos`,
    // never nested) so every entry's `active` flag is computed against one value.
    let active_id = state
        .active_repo_id
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let items: Vec<_> = state
        .repos
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|(id, repo)| {
            let is_active = active_id.as_deref() == Some(id.as_str());
            json!({ "id": id, "name": repo.name, "active": is_active })
        })
        .collect();
    (StatusCode::OK, Json(items)).into_response()
}

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
