use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating, GitOutput, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
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

/// Whether a git network failure's `stderr` looks like an auth-class failure — the
/// gate for the ambient-credential fallback in [`run_git_mutating_with_creds`].
/// Case-insensitive substring match on three signatures:
///
/// 1. `"authentication failed"` — git exhausted a 401 retry with the
///    helper-provided credentials (the injected CLI helper's token was rejected).
/// 2. `"could not read username"` — every helper returned nothing and
///    `GIT_TERMINAL_PROMPT=0` blocks the interactive prompt (covers the ≤60s
///    stale-cache window after `gh auth logout`, where the cached auth gate still
///    injects a helper that no longer answers).
/// 3. `"repository not found"` — GitHub answers 404 (the sideband line
///    `remote: Repository not found.`) for a VALID identity that lacks access to a
///    private repo: it hides existence rather than 403ing, so a wrong-identity CLI
///    token surfaces as not-found, not as an auth error. This is the exact
///    motivating symptom, now inverted — a stale CLI token that shadows a working
///    ambient credential.
///
/// Deliberately narrow: network/DNS failures (e.g. `"could not resolve hostname"`)
/// and merge conflicts do NOT match — retrying those can't help and would double
/// the network timeout.
fn is_auth_class_failure(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("authentication failed")
        || s.contains("could not read username")
        // 404 tradeoff: on a transient not-found for the CORRECT CLI identity, the
        // ambient retry can complete the op under a DIFFERENT identity than the
        // severed CLI one — accepted (push identity ≠ commit authorship); don't
        // widen this classifier further.
        || s.contains("repository not found")
}

/// Run a mutating git network op with one-shot credential `-c` entries prefixed.
///
/// When `cred` is non-empty and the injected run fails with an auth-class git
/// error ([`is_auth_class_failure`]), this retries EXACTLY ONCE with NO injected
/// config (plain [`run_git_mutating`] on the same sub-args) and returns that
/// retry's result — on a double failure the RETRY's error is surfaced, because the
/// ambient attempt's error names the true end state. When `cred` is empty there is
/// nothing to fall back from, so behavior is unchanged.
///
/// The auth gates that produce `cred` prove a credential EXISTS locally
/// (`gh auth token` is a local read; glab's `hosts:` entry persists past PAT
/// expiry) — not that it WORKS. Severing the ambient chain for a user whose CLI
/// token is revoked/expired but whose ambient credential (git-credential-manager,
/// OS keychain) is valid would hard-fail an op that worked before this change (the
/// additive helper let the ambient one answer first) — the exact inverse of the
/// motivating bug. This one-shot fallback restores pre-change behavior for those
/// users; an authenticated CLI never reaches it (its helper answers and the run
/// succeeds).
///
/// The retry is safe because HTTPS auth happens at ref negotiation BEFORE any
/// server-side ref update: a failed-auth push has mutated nothing on the remote, so
/// re-running with different credentials can't double-apply. Only Git-kind errors
/// are classified; every other error kind (timeout, IO, …) returns as-is with no
/// retry.
pub(crate) async fn run_git_mutating_with_creds(
    state: &AppState,
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let args = with_credentials(cred, sub);
    let result = run_git_mutating(
        state,
        repo_path,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        timeout,
    )
    .await;

    // Fall back to git's ambient credential helpers exactly once when injected
    // credentials are present but rejected — the CLI token may be stale while an
    // ambient credential still works.
    if !cred.is_empty() {
        if let Err(AppError::Git { stderr, .. }) = &result {
            if is_auth_class_failure(stderr) {
                return run_git_mutating(state, repo_path, sub, timeout).await;
            }
        }
    }
    result
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

/// Add a new remote (`git remote add <name> <url>`) — used to give a fork the
/// `upstream` remote it was cloned without, so the fork/upstream lens and
/// create-on-parent path light up. Mirrors [`git_remote_set_url`]'s validation
/// and cache handling; git itself errors (surfaced readably) if the remote name
/// already exists.
#[tauri::command]
pub async fn git_remote_add(
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
        &["remote", "add", &name, url.trim()],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // A stale negative entry (a prior get-url miss for this name) would otherwise
    // linger until the TTL — drop it so the next read resolves the new remote.
    cache_invalidate(&repo_path, &name);
    Ok(())
}

/// Remove a remote (`git remote remove <name>`) — the "Detach from fork"
/// action, dropping the `upstream` remote a fork was given so the fork/upstream
/// lens stops treating the repo as a fork. Generic over the remote name.
///
/// What git does on remove (git-remote(1) / `builtin/remote.c`): it deletes the
/// entire `remote.<name>` config section, unsets `branch.<b>.remote` /
/// `branch.<b>.merge` for every branch that was tracking this remote (leaving
/// those branches with **no** upstream — they are not re-pointed at another
/// remote), and deletes the remote-tracking refs under
/// `refs/remotes/<name>/`. The remote must exist first — [`ensure_remote_exists`]
/// turns an unknown name into an honest `InvalidArgument` (and rejects the
/// `-flag` injection shape) rather than a confusing raw-git error.
#[tauri::command]
pub async fn git_remote_remove(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_remote_remove_core(&state, repo_path, name).await
}

pub(crate) async fn git_remote_remove_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    ensure_remote_exists(&repo_path, &name).await?;
    run_git_mutating(
        state,
        &repo_path,
        &["remote", "remove", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // The remote (and its URL) no longer exists — drop any cached URL so a forge
    // query firing within the TTL doesn't serve the removed remote's stale value.
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
    run_git_mutating_with_creds(state, &repo_path, &cred, &["fetch", "--prune"], NETWORK_TIMEOUT)
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
    run_git_mutating_with_creds(
        &state,
        &repo_path,
        &cred,
        &["fetch", "--prune", &remote],
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
    run_git_mutating_with_creds(
        &state,
        &repo_path,
        &cred,
        &["remote", "set-head", &remote, "--auto"],
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
    run_git_mutating_with_creds(state, &repo_path, &cred, &["pull", flag], NETWORK_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
) -> AppResult<()> {
    git_push_core(&state, repo_path, set_upstream, force, branch).await
}

pub(crate) async fn git_push_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
) -> AppResult<()> {
    // Build the git args as owned Strings — a named-branch push interpolates the
    // branch/refspec, which can't borrow from a temporary. `None` reproduces the
    // original HEAD-relative args exactly (bare `push`, `--force-with-lease` on
    // force, `-u origin HEAD` on set_upstream).
    let args: Vec<String> = match &branch {
        None => {
            let mut a = vec!["push".to_string()];
            if force {
                // refuses to clobber remote work that arrived after our last fetch
                a.push("--force-with-lease".to_string());
            }
            if set_upstream {
                a.extend(["-u", "origin", "HEAD"].map(str::to_string));
            }
            a
        }
        Some(b) => {
            crate::git::branches::validate_ref_name(b)?;
            // Resolve b's tracking state with one read-only call: its upstream's
            // short name (e.g. `origin/feature`), the upstream's remote name, and
            // git's `%(upstream:track)` (which carries `[gone]` when the tracked
            // ref was deleted). Empty stdout means no such local branch.
            let out = run_git(
                Some(&repo_path),
                &[
                    "for-each-ref",
                    &format!("refs/heads/{b}"),
                    "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)",
                ],
                DEFAULT_TIMEOUT,
            )
            .await?;
            let text = out.stdout_lossy();
            let line = text.lines().next().unwrap_or("");
            if line.is_empty() {
                return Err(AppError::InvalidArgument(format!("no such branch: {b}")));
            }
            let mut parts = line.split('\0');
            let upstream_short = parts.next().unwrap_or("");
            let remotename = parts.next().unwrap_or("");
            let track = parts.next().unwrap_or("");
            // Mirror branches.rs's gone detection: `[gone]` in %(upstream:track).
            let gone = track.contains("[gone]");
            build_push_args(b, upstream_short, remotename, gone, set_upstream, force)
        }
    };
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Decide the `git push` args for pushing a NAMED local branch `branch` to
/// origin, from its resolved tracking state. Pure — no git calls — so the
/// decision table is unit-testable.
///
/// - `upstream_short`: `%(upstream:short)` (e.g. `origin/feat`), empty when the
///   branch is untracked.
/// - `remotename`: `%(upstream:remotename)` (the tracked upstream's remote).
/// - `gone`: the tracked ref was deleted (`[gone]`).
///
/// Rules (origin-centric v1 — we only ever push to origin):
/// - untracked / gone / `set_upstream` → `-u origin <branch>` (publish + track).
/// - tracked on `origin`: strip `origin/` off `upstream_short` to get the remote
///   name `up`; `push origin <branch>` when `up == branch`, else the explicit
///   `push origin <branch>:<up>` refspec (plain `push origin <branch>` would
///   advance the WRONG remote ref when the names differ).
/// - tracked on a NON-origin remote (e.g. a fork's `upstream/main`): plain
///   `push origin <branch>` with NO `-u` — publishes/advances `origin/<branch>`
///   and leaves the existing tracking config untouched (never retrack).
///
/// `force` prepends `--force-with-lease` before the refspec in every arm.
fn build_push_args(
    branch: &str,
    upstream_short: &str,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    force: bool,
) -> Vec<String> {
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
    }
    let untracked = upstream_short.is_empty();
    if untracked || gone || set_upstream {
        // Publish + track: first push of a branch (or a resurrected gone one), or
        // an explicit retrack request.
        args.extend(["-u", "origin", branch].map(str::to_string));
    } else if remotename == "origin" {
        // Tracked on origin. Strip the `origin/` prefix to recover the remote
        // branch name; when it matches the local name a bare push suffices,
        // otherwise an explicit refspec targets the right remote ref.
        let up = upstream_short
            .strip_prefix("origin/")
            .unwrap_or(upstream_short);
        if up == branch {
            args.extend(["origin", branch].map(str::to_string));
        } else {
            args.push("origin".to_string());
            args.push(format!("{branch}:{up}"));
        }
    } else {
        // Tracked on a non-origin remote — plain push to origin, no retrack.
        args.extend(["origin", branch].map(str::to_string));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::{
        build_push_args, cache_get, cache_invalidate, cache_put, git_remote_remove_core,
        is_auth_class_failure,
    };
    use crate::error::AppError;
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
    use crate::state::AppState;
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

    // --- Auth-class classifier for the ambient-credential fallback. ---

    #[test]
    fn auth_class_matches_rejected_credentials() {
        assert!(is_auth_class_failure(
            "fatal: Authentication failed for 'https://github.com/x/y.git/'"
        ));
    }

    #[test]
    fn auth_class_matches_prompt_disabled_no_username() {
        assert!(is_auth_class_failure(
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
        ));
    }

    #[test]
    fn auth_class_matches_repository_not_found_sideband() {
        // The 404 sideband line is what identifies a wrong-identity token.
        assert!(is_auth_class_failure(
            "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found"
        ));
    }

    #[test]
    fn auth_class_ignores_merge_conflict() {
        assert!(!is_auth_class_failure(
            "CONFLICT (content): Merge conflict in file.txt\nAutomatic merge failed; fix conflicts"
        ));
    }

    #[test]
    fn auth_class_ignores_network_dns_error() {
        // A DNS/network failure must NOT trigger the fallback — retrying can't help
        // and would double the timeout.
        assert!(!is_auth_class_failure(
            "ssh: Could not resolve hostname github.com"
        ));
    }

    // --- Pure arg-building for a named-branch push. ---

    #[test]
    fn push_untracked_publishes_with_upstream() {
        // Empty upstream → first-time publish + track.
        assert_eq!(
            build_push_args("feature", "", "", false, false, false),
            vec!["push", "-u", "origin", "feature"]
        );
    }

    #[test]
    fn push_gone_upstream_publishes_with_upstream() {
        // A deleted upstream ref (still named by %(upstream:short)) republishes.
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", true, false, false),
            vec!["push", "-u", "origin", "feature"]
        );
    }

    #[test]
    fn push_tracked_same_name_plain_push() {
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", false, false, false),
            vec!["push", "origin", "feature"]
        );
    }

    #[test]
    fn push_tracked_different_name_uses_refspec() {
        // Local `feature` tracks `origin/feat` → explicit refspec so we advance
        // the right remote ref, not `origin/feature`.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, false),
            vec!["push", "origin", "feature:feat"]
        );
    }

    #[test]
    fn push_tracked_non_origin_plain_push_no_upstream() {
        // Tracks a fork's `upstream/main` → publish to origin, never retrack.
        assert_eq!(
            build_push_args("main", "upstream/main", "upstream", false, false, false),
            vec!["push", "origin", "main"]
        );
    }

    #[test]
    fn push_set_upstream_forces_upstream_form_even_when_tracked() {
        // An explicit set_upstream request retracks even a tracked branch.
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", false, true, false),
            vec!["push", "-u", "origin", "feature"]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_args() {
        // --force-with-lease sits right after `push`, before the refspec.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, true),
            vec!["push", "--force-with-lease", "origin", "feature:feat"]
        );
        assert_eq!(
            build_push_args("feature", "", "", false, false, true),
            vec!["push", "--force-with-lease", "-u", "origin", "feature"]
        );
    }

    // --- Real-repo tests for git_remote_remove (temp_dir, git on PATH). ---

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test, cleaned up by the caller.
    fn temp_base(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "gd-remote-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    async fn init_repo(repo_s: &str, seed_file: &str) {
        run(repo_s, &["init", "-q"]).await;
        run(repo_s, &["config", "user.email", "t@t.local"]).await;
        run(repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(std::path::Path::new(repo_s).join(seed_file), "hello\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "seed"]).await;
    }

    /// Add an `upstream` remote (a second local repo), fetch it, point a branch's
    /// upstream at it, then remove it via `git_remote_remove_core` and assert git
    /// tore down everything: the remote is gone from `git remote`, the branch's
    /// `branch.<b>.remote` config is unset, and `refs/remotes/upstream/` is empty.
    #[tokio::test]
    async fn remove_drops_remote_tracking_and_branch_upstream() {
        let base = temp_base("remove");
        let repo = base.join("repo");
        let up = base.join("upstream");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&up).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        let up_s = up.to_string_lossy().into_owned();

        // The upstream repo, with a commit so it has a branch to fetch.
        init_repo(&up_s, "u.txt").await;
        let up_branch = run(&up_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // The consuming repo, with its own branch.
        init_repo(&repo_s, "a.txt").await;
        let branch = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        // Add + fetch upstream by file path, then track upstream/<branch>.
        run(&repo_s, &["remote", "add", "upstream", &up_s]).await;
        run(&repo_s, &["fetch", "-q", "upstream"]).await;
        run(
            &repo_s,
            &[
                "branch",
                &format!("--set-upstream-to=upstream/{up_branch}"),
                &branch,
            ],
        )
        .await;

        // Preconditions: the remote is listed, the branch tracks it, refs exist.
        assert!(run(&repo_s, &["remote"]).await.contains("upstream"));
        assert_eq!(
            run(&repo_s, &["config", &format!("branch.{branch}.remote")])
                .await
                .trim(),
            "upstream"
        );
        assert!(!run(&repo_s, &["for-each-ref", "refs/remotes/upstream/"])
            .await
            .trim()
            .is_empty());

        // Remove via the command core.
        let state = AppState::default();
        git_remote_remove_core(&state, repo_s.clone(), "upstream".into())
            .await
            .expect("remove succeeds");

        // The remote is gone.
        assert!(!run(&repo_s, &["remote"]).await.contains("upstream"));
        // The branch's upstream config is unset — `git config` exits non-zero.
        assert!(
            run_git(
                Some(&repo_s),
                &["config", &format!("branch.{branch}.remote")],
                DEFAULT_TIMEOUT,
            )
            .await
            .is_err(),
            "branch.<b>.remote is unset after removal"
        );
        // The remote-tracking refs are gone.
        assert!(
            run(&repo_s, &["for-each-ref", "refs/remotes/upstream/"])
                .await
                .trim()
                .is_empty(),
            "refs/remotes/upstream/ is empty after removal"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Removing a remote that doesn't exist is an honest `InvalidArgument`, not a
    /// raw git error — the `ensure_remote_exists` gate.
    #[tokio::test]
    async fn remove_nonexistent_remote_errors_invalid_argument() {
        let base = temp_base("missing");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        let state = AppState::default();
        let err = git_remote_remove_core(&state, repo_s.clone(), "upstream".into())
            .await
            .expect_err("removing a missing remote errors");
        match err {
            AppError::InvalidArgument(msg) => {
                assert_eq!(msg, "remote does not exist: upstream");
            }
            other => panic!("expected InvalidArgument, got {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&base);
    }
}
