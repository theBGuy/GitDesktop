//! Read-only git routes — thin adapters over the existing `crate::git::*` core
//! fns. Each reads its scoped repo from the `Extension<ScopedRepo>` a resolver
//! middleware inserts, calls the core fn with no shape translation, and returns its
//! result as JSON. No new git logic lives here. Handlers with a path param read it
//! by name (see [`crate::lan::routes`]) so they work under both the alias and the
//! scoped mounts.

use std::collections::HashMap;

use axum::extract::{Path, Query};
use axum::response::Response;
use axum::Extension;
use serde::Deserialize;

use crate::lan::routes::{bad_request, is_safe_relative_path, path_param, respond, ScopedRepo};

/// GET status — for the shared repo (alias: `/api/repo/status`).
pub async fn status(Extension(ScopedRepo(repo)): Extension<ScopedRepo>) -> Response {
    respond(crate::git::status::status_core(&repo).await)
}

/// GET branches (alias: `/api/repo/branches`).
pub async fn branches(Extension(ScopedRepo(repo)): Extension<ScopedRepo>) -> Response {
    respond(crate::git::branches::git_branches(repo).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogQuery {
    limit: Option<u32>,
    skip: Option<u32>,
    search: Option<String>,
}

/// GET log (alias: `/api/repo/log?limit&skip&search`).
pub async fn log(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<LogQuery>,
) -> Response {
    let limit = q.limit.unwrap_or(50);
    let skip = q.skip.unwrap_or(0);
    respond(crate::git::history::git_log(repo, limit, skip, q.search).await)
}

/// GET commit details (alias: `/api/repo/commits/{hash}`). The `hash` path param
/// is read by name so the handler works under BOTH the alias (`{hash}`) and scoped
/// (`{repoId}` + `{hash}`) mounts (see [`crate::lan::routes`]).
pub async fn commit_details(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let hash = match path_param(&params, "hash") {
        Ok(h) => h,
        Err(resp) => return *resp,
    };
    respond(crate::git::history::git_commit_details(repo, hash).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaxBytesQuery {
    max_bytes: Option<usize>,
}

/// GET commit diff (alias: `/api/repo/commits/{hash}/diff?maxBytes`).
pub async fn commit_diff(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Path(params): Path<HashMap<String, String>>,
    Query(q): Query<MaxBytesQuery>,
) -> Response {
    let hash = match path_param(&params, "hash") {
        Ok(h) => h,
        Err(resp) => return *resp,
    };
    respond(crate::git::history::git_commit_diff(repo, hash, q.max_bytes).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingDiffQuery {
    max_bytes: Option<usize>,
    worktree: Option<bool>,
}

/// GET working diff (alias: `/api/repo/diff/working?maxBytes&worktree`).
pub async fn diff_working(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<WorkingDiffQuery>,
) -> Response {
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

/// GET tags (alias: `/api/repo/tags`). Every tag, newest first — annotated tags
/// carry their own message + date, lightweight ones fall back to the commit.
pub async fn tags(Extension(ScopedRepo(repo)): Extension<ScopedRepo>) -> Response {
    respond(crate::git::ops::git_list_tags(repo).await)
}

/// The default comment markers scanned when the request omits `markers` (or it
/// parses empty). Three copies of this set exist BY DESIGN — keep them in sync:
/// the desktop's `DEFAULT_MARKERS` in `src/features/code-todos/markers.ts`, the
/// companion's marker chip row, and this server-side fallback.
const DEFAULT_TODO_MARKERS: &[&str] = &["TODO", "FIXME", "HACK", "BUG", "XXX"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoQuery {
    markers: Option<String>,
    max_hits: Option<u32>,
}

/// GET code-TODO scan (alias: `/api/repo/todos?markers=TODO,FIXME&maxHits=2000`).
/// `markers` is a comma-separated list (split on `,`, trimmed, empties dropped);
/// absent or empty-after-parse falls back to [`DEFAULT_TODO_MARKERS`]. The core
/// fn validates the marker charset (injection guard) and caps hits at 2000, so no
/// validation is duplicated here.
pub async fn todos(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<TodoQuery>,
) -> Response {
    let markers: Vec<String> = q
        .markers
        .as_deref()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_TODO_MARKERS.iter().map(|m| m.to_string()).collect());
    respond(crate::git::todos::git_todo_scan(repo, markers, q.max_hits).await)
}

/// GET file diff (alias: `/api/repo/diff/file?path&staged&untracked`).
pub async fn diff_file(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    Query(q): Query<FileDiffQuery>,
) -> Response {
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
    //
    // Both the containment AND the `.git`-guard below run on the CANONICALIZED
    // path, not the raw input: `std::fs::canonicalize` returns the real
    // long-name path, so Windows 8.3 short names (`GIT~1`) and case tricks on
    // case-insensitive filesystems (`.GIT`) resolve to their true form before
    // we inspect the components.
    if q.untracked {
        let repo_root = match std::fs::canonicalize(&repo) {
            Ok(p) => p,
            Err(_) => return bad_request("path is outside the shared repository"),
        };
        let target = match std::fs::canonicalize(std::path::Path::new(&repo).join(&q.path)) {
            Ok(target) if target.starts_with(&repo_root) => target,
            _ => return bad_request("path is outside the shared repository"),
        };
        // Reject anything inside the repo's git directory: `.git` is a `Normal`
        // component, so containment alone lets `?path=.git/config` reach
        // `git diff --no-index` and leak `.git/` internals (a `[remote "origin"]`
        // url can embed credentials). Match ANY component (not just the first),
        // mirroring git's own refusal to track paths containing a `.git`
        // component (submodule gitdirs etc.).
        let rel = match target.strip_prefix(&repo_root) {
            Ok(rel) => rel,
            Err(_) => return bad_request("path is outside the shared repository"),
        };
        if rel
            .components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
        {
            return bad_request("path is inside the repository's git directory");
        }
    }
    respond(crate::git::diff::git_diff_file(repo, q.path, q.staged, q.untracked).await)
}
