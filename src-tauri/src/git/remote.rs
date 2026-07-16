use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::state::AppState;

fn validate_remote_arg(value: &str, what: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid {what}: {value}"
        )));
    }
    Ok(())
}

/// Prefix one-shot credential `-c` entries before a git subcommand's args.
fn with_credentials(cred: &[String], sub: &[&str]) -> Vec<String> {
    let mut v = Vec::with_capacity(cred.len() * 2 + sub.len());
    for c in cred {
        v.push("-c".to_string());
        v.push(c.clone());
    }
    v.extend(sub.iter().map(|s| s.to_string()));
    v
}

/// How long a resolved remote URL stays trusted before we re-shell to `git`. A few seconds
/// is enough to collapse the burst of concurrent `forge_*` queries a single forge view fires
/// (each of which otherwise spawns `git remote get-url origin` twice), while staying short
/// enough that an external `git remote set-url` run in a terminal is picked up promptly. An
/// in-app `git_remote_set_url` invalidates eagerly, so the TTL is only the backstop for
/// out-of-band changes.
const REMOTE_URL_TTL: Duration = Duration::from_secs(5);

/// Cache map keyed by `(repo_path, remote_name)`; value is `(fetch time, resolved url)`.
type RemoteUrlCache = Mutex<HashMap<(String, String), (Instant, String)>>;

/// Per-`(repo_path, remote_name)` cache of the last resolved remote URL and when it was
/// fetched. Bounded by (#repos × #remote names) — tiny, so a stale entry is simply
/// overwritten on the next fetch rather than evicted. Only successful lookups are cached.
static REMOTE_URL_CACHE: OnceLock<RemoteUrlCache> = OnceLock::new();

fn remote_url_cache() -> &'static RemoteUrlCache {
    REMOTE_URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached URL for `(repo, name)` only if an entry exists AND it was fetched less
/// than `ttl` ago. Pure over the module-level cache; the lock is held only long enough to
/// clone the value out.
fn cache_get(repo: &str, name: &str, ttl: Duration) -> Option<String> {
    let guard = remote_url_cache().lock().unwrap();
    let (fetched_at, url) = guard.get(&(repo.to_string(), name.to_string()))?;
    if fetched_at.elapsed() < ttl {
        Some(url.clone())
    } else {
        None
    }
}

/// Record `url` as the current value for `(repo, name)`, stamped with the fetch time.
fn cache_put(repo: &str, name: &str, url: &str) {
    remote_url_cache().lock().unwrap().insert(
        (repo.to_string(), name.to_string()),
        (Instant::now(), url.to_string()),
    );
}

/// Drop any cached entry for `(repo, name)` so the next read re-resolves immediately.
fn cache_invalidate(repo: &str, name: &str) {
    remote_url_cache()
        .lock()
        .unwrap()
        .remove(&(repo.to_string(), name.to_string()));
}

/// Invalidate the cached URL for `(repo, name)` from another module. Call this after any
/// out-of-band mutation of a remote's URL that bypasses [`git_remote_set_url`] — e.g. a
/// forge rename that rewrites `origin` or a repo delete that removes it — so a forge query
/// firing within the TTL re-resolves the now-changed remote instead of serving the stale
/// value. Idempotent: a no-op when nothing is cached.
pub(crate) fn invalidate_remote_url_cache(repo: &str, name: &str) {
    cache_invalidate(repo, name);
}

#[tauri::command]
pub async fn git_remote_url(repo_path: String, name: String) -> AppResult<String> {
    validate_remote_arg(&name, "remote name")?;
    if let Some(url) = cache_get(&repo_path, &name, REMOTE_URL_TTL) {
        return Ok(url);
    }
    let out = run_git(
        Some(&repo_path),
        &["remote", "get-url", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let url = out.stdout_lossy().trim().to_string();
    cache_put(&repo_path, &name, &url);
    Ok(url)
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
    // The URL changed under us — drop the cached entry so the next read re-resolves
    // immediately instead of waiting out the TTL.
    cache_invalidate(&repo_path, &name);
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
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    let args = with_credentials(&cred, &["fetch", "--prune"]);
    run_git_mutating(
        state,
        &repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Error unless `remote` is one of the repo's configured remotes. We never
/// interpolate a caller-supplied remote name into a git invocation without
/// confirming it exists first — `validate_remote_arg` rejects the `-flag`
/// injection shape, but a bare unknown name would still shell out to a
/// confusing `git fetch <typo>` error; this turns it into an honest one.
async fn ensure_remote_exists(repo_path: &str, remote: &str) -> AppResult<()> {
    validate_remote_arg(remote, "remote name")?;
    let names = git_remotes(repo_path.to_string()).await?;
    if names.iter().any(|n| n == remote) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "remote does not exist: {remote}"
        )))
    }
}

/// Fetch a single named remote (`git fetch --prune <remote>`), unlike
/// [`git_fetch`] which fetches only the default remote. Powers "Update from
/// upstream" for forks: `git fetch --prune` alone never touches an `upstream`
/// remote, so a fork needs this to see upstream's new commits at all. The
/// remote is validated to exist before use.
#[tauri::command]
pub async fn git_fetch_remote(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
) -> AppResult<()> {
    ensure_remote_exists(&repo_path, &remote).await?;
    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    let args = with_credentials(&cred, &["fetch", "--prune", &remote]);
    run_git_mutating(
        &state,
        &repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Resolve a remote's default branch name (e.g. `"master"` / `"main"`) — the
/// branch a fork's `upstream` sync targets.
///
/// Phase 1 — validate the remote exists.
/// Phase 2 — read the LOCAL `refs/remotes/<remote>/HEAD` symbolic ref
///   (`refs/remotes/<remote>/<branch>`) and strip the prefix. This is offline
///   and set by the initial `git clone`, so it usually answers immediately.
/// Phase 3 — if that ref is unset (e.g. the remote was added by hand, as an
///   `upstream` typically is), one network call `git remote set-head
///   <remote> --auto` asks the remote for its HEAD, then we re-read the local
///   ref. Returns just the branch name (no `<remote>/` prefix).
#[tauri::command]
pub async fn git_remote_default_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
) -> AppResult<String> {
    ensure_remote_exists(&repo_path, &remote).await?;

    // `refs/remotes/<remote>/HEAD` → its target `refs/remotes/<remote>/<branch>`.
    let head_ref = format!("refs/remotes/{remote}/HEAD");
    let ref_prefix = format!("refs/remotes/{remote}/");

    if let Some(branch) = read_symbolic_ref(&repo_path, &head_ref, &ref_prefix).await? {
        return Ok(branch);
    }

    // The local ref is unset — ask the remote for its HEAD (one network call),
    // then re-read. `set-head --auto` writes `refs/remotes/<remote>/HEAD`.
    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    let args = with_credentials(&cred, &["remote", "set-head", &remote, "--auto"]);
    run_git_mutating(
        &state,
        &repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;

    read_symbolic_ref(&repo_path, &head_ref, &ref_prefix)
        .await?
        .ok_or_else(|| {
            AppError::InvalidArgument(format!(
                "could not resolve default branch for remote: {remote}"
            ))
        })
}

/// Read a symbolic ref and strip `prefix` off its target, returning the tail
/// (the branch name). `None` when the ref is unset — `git symbolic-ref` exits
/// non-zero — or its target doesn't start with `prefix`.
async fn read_symbolic_ref(
    repo_path: &str,
    symref: &str,
    prefix: &str,
) -> AppResult<Option<String>> {
    let out = run_git(
        Some(repo_path),
        &["symbolic-ref", "--quiet", symref],
        DEFAULT_TIMEOUT,
    )
    .await;
    // An unset ref makes `symbolic-ref` exit non-zero; run_git surfaces that as
    // an error, which here means "not resolved yet", not a hard failure.
    let Ok(out) = out else {
        return Ok(None);
    };
    let target = out.stdout_lossy().trim().to_string();
    Ok(target
        .strip_prefix(prefix)
        .filter(|b| !b.is_empty())
        .map(str::to_string))
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
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    let args = with_credentials(&cred, &["pull", flag]);
    run_git_mutating(
        state,
        &repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;
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
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    let args = with_credentials(&cred, &args);
    run_git_mutating(
        state,
        &repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cache_get, cache_invalidate, cache_put};
    use std::time::Duration;

    // Distinct keys per test — the cache is a process-wide static shared across all tests.
    const BIG: Duration = Duration::from_secs(3600);

    #[test]
    fn put_then_get_within_ttl_hits() {
        cache_put("/repo/a", "origin", "git@example.com:a.git");
        assert_eq!(
            cache_get("/repo/a", "origin", BIG),
            Some("git@example.com:a.git".to_string())
        );
    }

    #[test]
    fn zero_ttl_is_always_expired() {
        cache_put("/repo/b", "origin", "https://example.com/b.git");
        // Zero TTL: any elapsed time (however small) is >= the TTL, so the entry reads as expired.
        assert_eq!(cache_get("/repo/b", "origin", Duration::ZERO), None);
    }

    #[test]
    fn invalidate_drops_the_entry() {
        cache_put("/repo/c", "origin", "https://example.com/c.git");
        assert!(cache_get("/repo/c", "origin", BIG).is_some());
        cache_invalidate("/repo/c", "origin");
        assert_eq!(cache_get("/repo/c", "origin", BIG), None);
    }

    #[test]
    fn distinct_keys_do_not_collide() {
        cache_put("/repo/d", "origin", "url-origin");
        cache_put("/repo/d", "upstream", "url-upstream");
        cache_put("/repo/e", "origin", "url-e-origin");
        assert_eq!(
            cache_get("/repo/d", "origin", BIG),
            Some("url-origin".to_string())
        );
        assert_eq!(
            cache_get("/repo/d", "upstream", BIG),
            Some("url-upstream".to_string())
        );
        assert_eq!(
            cache_get("/repo/e", "origin", BIG),
            Some("url-e-origin".to_string())
        );
        // Invalidating one key leaves the others intact.
        cache_invalidate("/repo/d", "origin");
        assert_eq!(cache_get("/repo/d", "origin", BIG), None);
        assert_eq!(
            cache_get("/repo/d", "upstream", BIG),
            Some("url-upstream".to_string())
        );
    }

    #[test]
    fn miss_returns_none() {
        assert_eq!(cache_get("/repo/never-written", "origin", BIG), None);
    }
}
