use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    run_git, run_git_mutating, run_git_raw, GitOutput, DEFAULT_TIMEOUT, NETWORK_TIMEOUT,
};
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
/// `pub(crate)` so provider-side pushes (e.g. Bitbucket `create_pr`) can build
/// funnel-identical args.
pub(crate) fn with_credentials(cred: &[String], sub: &[&str]) -> Vec<String> {
    let mut v = Vec::with_capacity(cred.len() * 2 + sub.len());
    for c in cred {
        v.push("-c".to_string());
        v.push(c.clone());
    }
    v.extend(sub.iter().map(|s| s.to_string()));
    v
}

/// Whether a git network failure's `stderr` looks like an auth-class failure — the
/// gate for the ambient-credential fallback in [`run_git_with_creds_once`].
/// Case-insensitive substring match on three signatures:
///
/// 1. `"authentication failed"` — the helper-provided token was rejected (401).
/// 2. `"could not read username"` — no helper answered and `GIT_TERMINAL_PROMPT=0`
///    blocks the prompt (covers the ≤60s stale-cache window after `gh auth logout`,
///    where the cached auth gate still injects a helper that no longer answers).
/// 3. `"repository not found"` — GitHub 404s (sideband `remote: Repository not
///    found.`) for a VALID identity that merely lacks access to a private repo: it
///    hides existence rather than 403ing, so a wrong-identity CLI token surfaces as
///    not-found, not as an auth error.
///
/// Deliberately narrow: network/DNS failures (e.g. `"could not resolve hostname"`)
/// and merge conflicts must NOT match — retrying those can't help and would double
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

/// Run a git network op with one-shot credential `-c` entries prefixed, taking NO
/// lock — so it is callable from inside a held `repo_lock` (the autostash
/// compounds). Returns the raw output: a non-zero exit is not an error here.
///
/// When `cred` is non-empty and the injected run fails with an auth-class git error
/// ([`is_auth_class_failure`]), retries EXACTLY ONCE with NO injected config (the
/// same sub-args, plain) and returns that result — on a double failure the RETRY's
/// output is surfaced, because the ambient attempt's error names the true end
/// state. Empty `cred` ⇒ behavior unchanged.
///
/// The auth gates that produce `cred` only prove a credential EXISTS locally
/// (`gh auth token` is a local read; glab's `hosts:` entry outlives PAT expiry) —
/// not that it WORKS. Without this fallback, a revoked/expired CLI token would
/// hard-fail a user whose ambient credential (git-credential-manager, OS keychain)
/// is perfectly valid.
///
/// The retry is safe because HTTPS auth happens at ref negotiation BEFORE any
/// server-side ref update: a failed-auth push mutated nothing on the remote, so it
/// can't double-apply. Only a non-zero git exit is classified; spawn failures and
/// timeouts return as-is with no retry.
pub(crate) async fn run_git_with_creds_once(
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let args = with_credentials(cred, sub);
    let out = run_git_raw(
        Some(repo_path),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        timeout,
    )
    .await?;

    // Injected credentials present but rejected → one-shot ambient retry.
    if !cred.is_empty() && out.code != 0 && is_auth_class_failure(&out.stderr) {
        return run_git_raw(Some(repo_path), sub, timeout).await;
    }
    Ok(out)
}

/// [`run_git_with_creds_once`] under the per-repo lock, surfacing a non-zero exit
/// as [`AppError::Git`] — the mutating-command contract every network caller
/// (fetch/pull/push) is written against.
pub(crate) async fn run_git_mutating_with_creds(
    state: &AppState,
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let lock = state.repo_lock(repo_path).await;
    let _guard = lock.lock().await;

    // index.lock contention from an external tool (editor, other client) is
    // transient — retry once. Expressed here rather than via `run_git_mutating`
    // because the injection half must stay lock-free.
    let mut out = run_git_with_creds_once(repo_path, cred, sub, timeout).await?;
    if out.code != 0 && out.stderr.contains("index.lock") {
        tokio::time::sleep(Duration::from_millis(300)).await;
        out = run_git_with_creds_once(repo_path, cred, sub, timeout).await?;
    }
    if out.code != 0 {
        // Both streams: a merge-mode `pull` that conflicts puts the fetch summary
        // on stderr and the whole merge verdict (`CONFLICT (…`, `Automatic merge
        // failed`) on stdout, so substituting one for the other would drop the
        // verdict. Inert for fetch/set-head/push, whose failures write no stdout.
        // The classifier above reads raw `out.stderr` on purpose — keep it there.
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out)
}

/// How long a resolved remote URL stays trusted before re-shelling to `git`. A few
/// seconds collapses the burst of concurrent `forge_*` queries one forge view fires
/// (each otherwise spawns `git remote get-url` twice) while still picking up an
/// out-of-band `git remote set-url` promptly; in-app changes invalidate eagerly.
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
    git_remote_add_core(&state, repo_path, name, url).await
}

pub(crate) async fn git_remote_add_core(
    state: &AppState,
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<()> {
    validate_remote_arg(&name, "remote name")?;
    validate_remote_arg(url.trim(), "remote URL")?;
    run_git_mutating(
        state,
        &repo_path,
        &["remote", "add", &name, url.trim()],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // Drop any cached URL for this name: an out-of-band `git remote remove` (in a
    // terminal, bypassing git_remote_remove_core's invalidate) can leave a stale
    // POSITIVE entry that would be served for the re-added remote until the TTL.
    cache_invalidate(&repo_path, &name);
    Ok(())
}

/// Remove a remote (`git remote remove <name>`) — the "Detach from fork" action,
/// dropping the `upstream` remote a fork was given so the fork/upstream lens stops
/// treating the repo as a fork. Generic over the remote name.
///
/// What git does (git-remote(1)): deletes the whole `remote.<name>` config section,
/// unsets `branch.<b>.remote` / `.merge` for every branch tracking it — those
/// branches end up with **no** upstream, they are NOT re-pointed at another remote —
/// and deletes `refs/remotes/<name>/`. [`ensure_remote_exists`] turns an unknown
/// name into an honest `InvalidArgument` (and rejects the `-flag` shape) first.
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

/// Resolve a remote's default branch name (e.g. `"master"` / `"main"`) — the branch
/// a fork's `upstream` sync targets. Reads the LOCAL `refs/remotes/<remote>/HEAD`
/// symbolic ref first: offline, written by the initial `git clone`, so it usually
/// answers immediately. If that ref is unset — as it is for a hand-added `upstream`
/// — one network call (`git remote set-head <remote> --auto`) writes it and we
/// re-read. Returns the bare branch name (no `<remote>/` prefix).
#[tauri::command]
pub async fn git_remote_default_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
) -> AppResult<String> {
    ensure_remote_exists(&repo_path, &remote).await?;

    if let Some(branch) = remote_head_branch(&repo_path, &remote).await? {
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

    remote_head_branch(&repo_path, &remote)
        .await?
        .ok_or_else(|| {
            AppError::InvalidArgument(format!(
                "could not resolve default branch for remote: {remote}"
            ))
        })
}

/// The branch `refs/remotes/<remote>/HEAD` points at, or `None` when that symref
/// is unset (never written for a hand-added remote). Local read, no network.
pub(crate) async fn remote_head_branch(repo_path: &str, remote: &str) -> AppResult<Option<String>> {
    read_symbolic_ref(
        repo_path,
        &format!("refs/remotes/{remote}/HEAD"),
        &format!("refs/remotes/{remote}/"),
    )
    .await
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
    // The paused operation a conflicted pull leaves behind is the mode it RAN, so
    // it is named here rather than inside the runner: `run_git_mutating_with_creds`
    // also carries fetch and push, whose failures are never a paused conflict and
    // would each pay for an unmerged probe that can only come back empty.
    // A refused `--ff-only` leaves nothing unmerged, so its label never surfaces.
    let op = if mode == "rebase" { "rebase" } else { "merge" };
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    let already_unmerged = crate::git::ops::unmerged_paths(&repo_path).await;
    if let Err(err) =
        run_git_mutating_with_creds(state, &repo_path, &cred, &["pull", flag], NETWORK_TIMEOUT).await
    {
        // The runner already folded both streams into `stderr`, so the report is
        // relabeled here rather than re-running git.
        return Err(match err {
            AppError::Git { code, stderr } => {
                crate::git::ops::classify_failure(
                    &repo_path,
                    op,
                    &already_unmerged,
                    code,
                    stderr,
                )
                .await
            }
            other => other,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, AppState>,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
) -> AppResult<()> {
    git_push_core(
        &state,
        repo_path,
        set_upstream,
        force,
        branch,
        remote,
        remote_branch,
    )
    .await
}

/// `remote_branch` names the DESTINATION branch when it differs from the local one
/// (pushing a maintainer's local work back to a contributor's fork head). It only
/// means anything alongside an explicit `branch` and `remote`, so any other
/// combination is rejected rather than silently ignored.
pub(crate) async fn git_push_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
) -> AppResult<()> {
    if remote_branch.is_some() && (branch.is_none() || remote.is_none()) {
        return Err(AppError::InvalidArgument(
            "remote branch requires an explicit branch and remote".to_string(),
        ));
    }
    // The credential config is scoped to the remote we actually push to, resolved
    // below. Defaults to origin (the HEAD path and the origin-tracked cases).
    let mut cred_remote = "origin".to_string();
    // Owned Strings: a named-branch push interpolates the branch into a refspec,
    // which can't borrow from a temporary.
    let args: Vec<String> = match &branch {
        None => {
            // A remote can only be chosen for an explicit branch — the HEAD path
            // pushes to HEAD's own upstream and stays byte-identical.
            if remote.is_some() {
                return Err(AppError::InvalidArgument(
                    "remote requires an explicit branch".to_string(),
                ));
            }
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
            // A caller-chosen remote is validated for shape AND verified to exist
            // BEFORE any mutation: the existence check is the primary guard (a URL
            // can never appear in `git remote` output — and it requires `:`, which
            // validate_ref_name's blocklist already rejects). We never interpolate
            // the remote into a refspec — it's the bare `push <remote>` argument.
            if let Some(r) = &remote {
                // `validate_ref_name` is the checker, but its message speaks of a
                // "branch name" — remap it so an invalid remote reads accurately.
                crate::git::branches::validate_ref_name(r).map_err(|_| {
                    AppError::InvalidArgument(format!("invalid remote name: {r}"))
                })?;
                let remotes = git_remotes(repo_path.clone()).await?;
                if !remotes.iter().any(|n| n == r) {
                    return Err(AppError::InvalidArgument(format!("unknown remote: {r}")));
                }
            }
            // The destination name IS interpolated into the refspec's right-hand
            // side, so it takes the same blocklist as the local branch (`*` would
            // mirror-push, `:` would add a refspec field).
            if let Some(rb) = &remote_branch {
                crate::git::branches::validate_ref_name(rb).map_err(|_| {
                    AppError::InvalidArgument(format!("invalid remote branch name: {rb}"))
                })?;
            }
            // Resolve b's tracking state in one read-only call. `for-each-ref`
            // matches a pattern as a prefix up to a slash (`refs/heads/feat` also
            // matches `refs/heads/feat/sub`), so emitting `%(refname)` and requiring
            // an exact match (in `parse_upstream_tracking`) is what makes this an
            // exact-name lookup. `%(upstream:track)` carries `[gone]`.
            let out = run_git(
                Some(&repo_path),
                &[
                    "for-each-ref",
                    &format!("refs/heads/{b}"),
                    "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)",
                ],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // No exact-refname line ⇒ no such local branch (an *untracked* branch
            // still emits `refs/heads/<b>\0\0\0`).
            let Some((upstream_short, remotename, gone)) =
                parse_upstream_tracking(&out.stdout_lossy(), &format!("refs/heads/{b}"))
            else {
                return Err(AppError::InvalidArgument(format!("no such branch: {b}")));
            };
            // The credential config must target the remote we actually push to, not
            // always origin — a branch tracking a fork's `upstream` (or an explicit
            // `remote`) authenticates against THAT host, not origin's.
            cred_remote = resolve_push_target(remote.as_deref(), &remotename, gone).to_string();
            build_push_args(
                b,
                &upstream_short,
                &remotename,
                gone,
                set_upstream,
                force,
                remote.as_deref(),
                remote_branch.as_deref(),
            )
        }
    };
    let cred = crate::forge::credential_config_for_remote(&repo_path, &cred_remote).await?;
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

/// Parse one `for-each-ref … --format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)`
/// line into `(upstream_short, remotename, gone)`, but ONLY when its `%(refname)`
/// equals `expected_ref`. `for-each-ref` matches a pattern as a prefix up to a
/// slash (`refs/heads/feat` also matches `refs/heads/feat/sub`), so the exact
/// refname check is what enforces "no such branch" for a non-exact name.
/// Returns `None` when there is no line, or the first line's refname isn't
/// `expected_ref`. An *untracked* branch still emits `refs/heads/<b>\0\0\0`,
/// which (refname matches) parses to `Some(("","",false))`.
fn parse_upstream_tracking(stdout: &str, expected_ref: &str) -> Option<(String, String, bool)> {
    let line = stdout.lines().next()?;
    let mut parts = line.split('\0');
    let refname = parts.next().unwrap_or("");
    if refname != expected_ref {
        return None;
    }
    let upstream_short = parts.next().unwrap_or("").to_string();
    let remotename = parts.next().unwrap_or("").to_string();
    let track = parts.next().unwrap_or("");
    // Mirror branches.rs's gone detection: `[gone]` in %(upstream:track).
    Some((upstream_short, remotename, track.contains("[gone]")))
}

/// Resolve the remote a named-branch push targets. Pure so the decision table
/// stays unit-testable, and shared by `git_push_core` (for the credential
/// config) and [`build_push_args`] (for the argv) so there's one source of truth.
///
/// - An explicit `requested_remote` always wins.
/// - Otherwise a branch tracked (and not gone) targets its OWN upstream remote;
///   an untracked / gone branch falls back to `origin` (the publish destination).
fn resolve_push_target<'a>(
    requested_remote: Option<&'a str>,
    remotename: &'a str,
    gone: bool,
) -> &'a str {
    match requested_remote {
        Some(r) => r,
        None if !remotename.is_empty() && !gone => remotename,
        None => "origin",
    }
}

/// Decide the `git push` args for pushing a NAMED local branch, from its resolved
/// tracking state and an optional caller-chosen `requested_remote`. Pure — no git
/// calls — so the decision table is unit-testable.
///
/// - `upstream_short`: `%(upstream:short)` (e.g. `origin/feat`), empty when untracked.
/// - `remotename`: `%(upstream:remotename)` (the tracked upstream's remote).
/// - `gone`: the tracked ref was deleted (`[gone]`).
/// - `requested_remote`: an explicit push target (the switcher's per-remote Publish
///   items, or MCP's `remote`); `None` resolves the default.
/// - `remote_branch`: an explicit DESTINATION branch name; only ever `Some` with an
///   explicit `requested_remote` (the caller enforces it).
///
/// The target `T` is [`resolve_push_target`]. Rules:
/// - `remote_branch` = `rb` → `push T refs/heads/<branch>:refs/heads/<rb>`, no `-u`:
///   an explicitly named destination pins the refspec and leaves tracking alone.
/// - untracked / gone / `set_upstream` → `-u T refs/heads/<branch>:refs/heads/<branch>`
///   (publish + track). A *gone* upstream publishes under the LOCAL name, deliberately
///   not resurrecting a differently-named deleted ref.
/// - tracked and `T == remotename`: strip the `remotename/` prefix off
///   `upstream_short` to get the remote branch name `up`;
///   `push T refs/heads/<branch>:refs/heads/<up>` (a bare `push T <branch>` would
///   advance the WRONG remote ref when the names differ).
/// - tracked and `T != remotename` (a copy elsewhere, e.g. a fork's `origin` snapshot
///   of an `upstream`-tracked branch): `push T refs/heads/<branch>:refs/heads/<branch>`
///   with NO `-u` — publishes under the LOCAL name, upstream config untouched.
///
/// Refspecs are fully qualified so a branch named `+x`/`-x` can't be read as a
/// force/delete indicator; the remote is only ever the bare `push <remote>` arg.
/// `force` prepends `--force-with-lease` before the refspec in every arm.
#[allow(clippy::too_many_arguments)] // one flat arg per decision-table input
fn build_push_args(
    branch: &str,
    upstream_short: &str,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    force: bool,
    requested_remote: Option<&str>,
    remote_branch: Option<&str>,
) -> Vec<String> {
    let target = resolve_push_target(requested_remote, remotename, gone);
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
    }
    if let Some(rb) = remote_branch {
        // Destination named outright: never `-u` and never the tracking-derived
        // name — the local branch's upstream is a different question from where
        // this one push lands.
        args.push(target.to_string());
        args.push(format!("refs/heads/{branch}:refs/heads/{rb}"));
        return args;
    }
    let untracked = upstream_short.is_empty();
    if untracked || gone || set_upstream {
        // Publish + track, under the LOCAL name.
        args.extend(["-u", target].map(str::to_string));
        args.push(publish_refspec(branch));
    } else if target == remotename {
        // Tracked → its own remote: target the remote branch name explicitly (it
        // may differ from the local one).
        let up = upstream_short
            .strip_prefix(&format!("{remotename}/"))
            .unwrap_or(upstream_short);
        args.push(target.to_string());
        args.push(format!("refs/heads/{branch}:refs/heads/{up}"));
    } else {
        // Tracked, but pushing to a DIFFERENT remote than the upstream — a copy
        // under the local name, no `-u`, upstream config untouched (never retrack).
        args.push(target.to_string());
        args.push(publish_refspec(branch));
    }
    args
}

/// Fully-qualified same-name push refspec. Qualification alone only stops a
/// leading `+`/`-` from reading as a force/delete marker at refspec position 0;
/// the metacharacters that could reshape the refspec (`* ? [ : \`) are rejected
/// by [`crate::git::branches::validate_ref_name`], which every caller runs first.
pub(crate) fn publish_refspec(branch: &str) -> String {
    format!("refs/heads/{branch}:refs/heads/{branch}")
}

#[cfg(test)]
mod tests {
    use super::{
        build_push_args, cache_get, cache_invalidate, cache_put, git_pull_core, git_push_core,
        git_remote_remove_core, is_auth_class_failure, parse_upstream_tracking, publish_refspec,
        resolve_push_target, run_git_mutating_with_creds,
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

    /// The failure contract every caller (fetch/pull/push) branches on: a non-zero
    /// sub-command surfaces as `AppError::Git` carrying git's OWN exit code and
    /// stderr, not a synthesized message.
    #[tokio::test]
    async fn mutating_with_creds_surfaces_gits_own_code_and_stderr() {
        let (_base, base) = temp_base("creds-error");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        let state = AppState::default();
        let result = run_git_mutating_with_creds(
            &state,
            &repo_s,
            &[],
            &["merge", "nonexistent-ref-xyz"],
            DEFAULT_TIMEOUT,
        )
        .await;
        match result {
            Err(AppError::Git { code, stderr }) => {
                assert_eq!(code, 1);
                assert!(
                    stderr.contains("nonexistent-ref-xyz - not something we can merge"),
                    "expected git's own stderr, got: {stderr}"
                );
            }
            Err(other) => panic!("expected AppError::Git, got {other:?}"),
            Ok(_) => panic!("merging a missing ref should fail"),
        }
    }

    /// The half that stderr alone cannot carry: a merge-mode pull that conflicts
    /// writes only its fetch summary to stderr and the whole merge verdict to
    /// stdout, so an error shaped from stderr looks populated while saying
    /// nothing about the conflict the user now has to resolve.
    #[tokio::test]
    async fn a_conflicted_pull_surfaces_gits_merge_verdict() {
        let (_base, base) = temp_base("pull-conflict");
        let origin = base.join("origin.git");
        let work = base.join("work");
        let clone = base.join("clone");
        std::fs::create_dir_all(&work).unwrap();
        let base_s = base.to_string_lossy().into_owned();
        let work_s = work.to_string_lossy().into_owned();
        let clone_s = clone.to_string_lossy().into_owned();
        let url = format!("file://{}", origin.to_string_lossy().replace('\\', "/"));

        run(&base_s, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        init_repo(&work_s, "a.txt").await;
        run(&work_s, &["branch", "-M", "main"]).await;
        run(&work_s, &["remote", "add", "origin", &url]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "main"]).await;
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // Both sides rewrite the same file, so `--no-rebase` merges and conflicts.
        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream"]).await;
        run(&work_s, &["push", "-q"]).await;
        std::fs::write(clone.join("a.txt"), "mine\n").unwrap();
        run(&clone_s, &["commit", "-qam", "local"]).await;

        let state = AppState::default();
        let result = run_git_mutating_with_creds(
            &state,
            &clone_s,
            &[],
            &["pull", "--no-rebase"],
            DEFAULT_TIMEOUT,
        )
        .await;
        match result {
            Err(AppError::Git { code, stderr }) => {
                assert_eq!(code, 1);
                assert!(
                    stderr.contains("Automatic merge failed"),
                    "the merge verdict rides stdout and must reach the error, got: {stderr}"
                );
                assert!(
                    stderr.contains("CONFLICT (content): Merge conflict in a.txt"),
                    "and the conflicted-file list with it, got: {stderr}"
                );
            }
            Err(other) => panic!("expected AppError::Git, got {other:?}"),
            Ok(_) => panic!("a diverged pull with an overlapping edit should conflict"),
        }
    }

    /// A clone diverged from its origin on `a.txt`, so a reconciling pull in
    /// either mode conflicts. Returns the temp guard (drop removes the fixture)
    /// and the clone's path.
    async fn diverged_clone(tag: &str) -> (tempfile::TempDir, String) {
        let (guard, base) = temp_base(tag);
        let origin = base.join("origin.git");
        let work = base.join("work");
        let clone = base.join("clone");
        std::fs::create_dir_all(&work).unwrap();
        let base_s = base.to_string_lossy().into_owned();
        let work_s = work.to_string_lossy().into_owned();
        let clone_s = clone.to_string_lossy().into_owned();
        let url = format!("file://{}", origin.to_string_lossy().replace('\\', "/"));

        run(&base_s, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        init_repo(&work_s, "a.txt").await;
        run(&work_s, &["branch", "-M", "main"]).await;
        run(&work_s, &["remote", "add", "origin", &url]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "main"]).await;
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream"]).await;
        run(&work_s, &["push", "-q"]).await;
        std::fs::write(clone.join("a.txt"), "mine\n").unwrap();
        run(&clone_s, &["commit", "-qam", "local"]).await;
        (guard, clone_s)
    }

    /// A pull that conflicts leaves a PAUSED merge/rebase, and `git_pull_core` is
    /// where that gets named — the runner it goes through also carries fetch and
    /// push, whose failures are never paused.
    #[tokio::test]
    async fn a_conflicted_pull_reports_a_paused_merge() {
        let (_guard, clone_s) = diverged_clone("pull-conflict-op").await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "merge".into())
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "merge", "a merge-mode pull pauses a merge");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        // Both halves: the fetch summary fills stderr while the merge verdict and
        // its file list ride stdout, so either alone loses the conflict.
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            report.contains("Automatic merge failed"),
            "and the verdict line with it: {report}"
        );
    }

    /// The other half of the mode→op branch: the same divergence pulled with
    /// `--rebase` leaves a paused REBASE, and the frontend's copy for the two
    /// differs (a merge finishes with a commit, a rebase with `--continue`).
    #[tokio::test]
    async fn a_conflicted_rebase_pull_reports_a_paused_rebase() {
        let (_guard, clone_s) = diverged_clone("pull-conflict-rebase").await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "rebase", "a rebase-mode pull pauses a rebase");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "and the rebase really is the operation left in progress"
        );
    }

    /// Pulling on a tree already paused on a MERGE: git refuses without touching
    /// the index ("Pulling is not possible because you have unmerged files",
    /// measured on git 2.51.1), so the only unmerged path belongs to that merge.
    /// Attributing it to the pull would toast "Rebase paused…" over a tree whose
    /// conflict banner reads *merge*.
    #[tokio::test]
    async fn a_pull_refused_over_someone_elses_conflict_is_not_a_paused_rebase() {
        let (_guard, clone_s) = diverged_clone("pull-refused-misattrib").await;
        // Pause a merge from a side branch, so the tree is unmerged before the pull.
        run(&clone_s, &["switch", "-q", "-c", "side", "HEAD~1"]).await;
        std::fs::write(
            std::path::Path::new(&clone_s).join("a.txt"),
            "side\n",
        )
        .unwrap();
        run(&clone_s, &["commit", "-qam", "side"]).await;
        run(&clone_s, &["switch", "-q", "main"]).await;
        let merged = run_git(
            Some(&clone_s),
            &["merge", "--no-edit", "side"],
            DEFAULT_TIMEOUT,
        )
        .await;
        assert!(merged.is_err(), "the fixture's merge must conflict");
        assert!(crate::git::ops::op_state(&clone_s).await.unwrap().merging);

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .unwrap_err();
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a plain git error, got {err:?}");
        };
        assert!(
            stderr.contains("unmerged files"),
            "git's own refusal must reach the user: {stderr}"
        );
        assert!(
            !crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "no rebase was ever started — naming one would contradict the banner"
        );
    }

    // --- Pure arg-building for a named-branch push. ---

    #[test]
    fn push_untracked_publishes_with_upstream() {
        // Empty upstream → first-time publish + track.
        assert_eq!(
            build_push_args("feature", "", "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_gone_upstream_publishes_with_upstream() {
        // A deleted upstream ref (still named by %(upstream:short)) republishes.
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", true, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_tracked_same_name_plain_push() {
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", false, false, false, None, None),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_tracked_different_name_uses_refspec() {
        // Local `feature` tracks `origin/feat` → explicit refspec so we advance
        // the right remote ref, not `origin/feature`.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, false, None, None),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_tracked_non_origin_default_targets_own_remote() {
        // No requested remote + a branch tracking a fork's `upstream/main` targets
        // its OWN remote: T == remotename → the refspec-to-`up` arm.
        assert_eq!(
            build_push_args("main", "upstream/main", "upstream", false, false, false, None, None),
            vec!["push", "upstream", "refs/heads/main:refs/heads/main"]
        );
    }

    #[test]
    fn push_requested_remote_matches_tracked_remote() {
        // Explicitly requesting the branch's OWN tracked remote is the same arm:
        // T == remotename → advance the tracked remote-branch name explicitly.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, false, Some("origin"), None),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_requested_remote_differs_from_tracked_remote() {
        // A tracked-on-origin branch pushed explicitly to `upstream` → a copy under
        // the LOCAL name, no `-u`, upstream config untouched.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, false, Some("upstream"), None),
            vec!["push", "upstream", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_requested_remote_on_untracked_publish() {
        // Publishing an untracked branch to a chosen remote: `-u <remote>` under
        // the local name.
        assert_eq!(
            build_push_args("feature", "", "", false, false, false, Some("fork"), None),
            vec!["push", "-u", "fork", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_set_upstream_forces_upstream_form_even_when_tracked() {
        // An explicit set_upstream request retracks even a tracked branch.
        assert_eq!(
            build_push_args("feature", "origin/feature", "origin", false, true, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_args() {
        // --force-with-lease sits right after `push`, before the refspec.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, true, None, None),
            vec![
                "push",
                "--force-with-lease",
                "origin",
                "refs/heads/feature:refs/heads/feat"
            ]
        );
        assert_eq!(
            build_push_args("feature", "", "", false, false, true, None, None),
            vec![
                "push",
                "--force-with-lease",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_on_requested_remote() {
        // Force + a requested non-tracked remote: `--force-with-lease` still sits
        // right after `push`, then the bare remote, then the fully-qualified refspec.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", false, false, true, Some("upstream"), None),
            vec![
                "push",
                "--force-with-lease",
                "upstream",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn publish_refspec_is_fully_qualified_on_both_sides() {
        assert_eq!(
            publish_refspec("feature"),
            "refs/heads/feature:refs/heads/feature"
        );
        // A `+` lands INSIDE the ref path, never at refspec position 0 where git
        // would read it as the force marker.
        assert_eq!(publish_refspec("+x"), "refs/heads/+x:refs/heads/+x");
    }

    #[test]
    fn push_plus_prefixed_branch_is_not_a_force() {
        // Security regression guard: a branch named `+main` is a VALID git ref,
        // and as a BARE refspec source `+` is git's force indicator. Fully
        // qualifying the refspec embeds the `+` inside `refs/heads/+main`, never
        // as its leading char, so git can't read it as a force-push.
        assert_eq!(
            build_push_args("+main", "", "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/+main:refs/heads/+main"]
        );
    }

    #[test]
    fn push_gone_different_name_publishes_under_local_name() {
        // Deliberate: a gone upstream publishes under the LOCAL name (a fresh
        // `origin/feature`), not the deleted `feat` — matching the "Publish"
        // affordance and toast.
        assert_eq!(
            build_push_args("feature", "origin/feat", "origin", true, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_explicit_remote_branch_pins_the_destination_refspec() {
        // Untracked local branch, explicit remote + destination.
        assert_eq!(
            build_push_args("local", "", "", false, false, false, Some("fork"), Some("contrib")),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A destination name never re-tracks, so `set_upstream` can't add `-u`.
        assert_eq!(
            build_push_args("local", "", "", false, true, false, Some("fork"), Some("contrib")),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A gone upstream likewise can't drag the publish arm back in.
        assert_eq!(
            build_push_args("local", "origin/local", "origin", true, false, false, Some("fork"), Some("contrib")),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // Tracked elsewhere: the refspec still targets `contrib`, upstream untouched.
        assert_eq!(
            build_push_args("local", "origin/local", "origin", false, false, false, Some("fork"), Some("contrib")),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // `force` keeps its position ahead of the target, as in every other arm.
        assert_eq!(
            build_push_args("local", "", "", false, false, true, Some("fork"), Some("contrib")),
            vec!["push", "--force-with-lease", "fork", "refs/heads/local:refs/heads/contrib"]
        );
    }

    #[test]
    fn resolve_push_target_prefers_request_then_tracked_then_origin() {
        // Explicit request wins; else the tracked-and-not-gone remote; else origin
        // (untracked, or gone).
        assert_eq!(resolve_push_target(Some("fork"), "upstream", false), "fork");
        assert_eq!(resolve_push_target(None, "upstream", false), "upstream");
        assert_eq!(resolve_push_target(None, "", false), "origin");
        assert_eq!(resolve_push_target(None, "upstream", true), "origin");
    }

    #[test]
    fn parse_upstream_tracking_missing_branch_is_none() {
        assert_eq!(parse_upstream_tracking("", "refs/heads/feature"), None);
    }

    #[test]
    fn parse_upstream_tracking_untracked_is_some_empty() {
        // An untracked branch: refname present, empty upstream fields → valid publish.
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0\0\0\n", "refs/heads/feature"),
            Some(("".into(), "".into(), false))
        );
    }

    #[test]
    fn parse_upstream_tracking_gone() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0origin/feat\0origin\0[gone]", "refs/heads/feature"),
            Some(("origin/feat".into(), "origin".into(), true))
        );
    }

    #[test]
    fn parse_upstream_tracking_normal() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0origin/feature\0origin\0[ahead 2]", "refs/heads/feature"),
            Some(("origin/feature".into(), "origin".into(), false))
        );
    }

    #[test]
    fn parse_upstream_tracking_prefix_match_is_rejected() {
        // `for-each-ref refs/heads/feat` also matches `refs/heads/feat/sub`; the
        // exact-refname check must reject it so the caller returns "no such branch"
        // instead of reading feat/sub's tracking.
        assert_eq!(
            parse_upstream_tracking("refs/heads/feat/sub\0\0\0\n", "refs/heads/feat"),
            None
        );
    }

    // --- Real-repo tests for git_remote_remove (temp_dir, git on PATH). ---

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test — the returned `TempDir` guard removes it
    /// (and every subdir under it) on Drop, so a panicking or killed run cannot
    /// leak the fixture.
    fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-remote-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
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
        let (_base, base) = temp_base("remove");
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
    }

    /// A destination branch name is meaningless without both an explicit branch and
    /// an explicit remote, so those combinations are refused rather than silently
    /// dropping the destination. Guarded before any git call — no repo needed.
    #[tokio::test]
    async fn remote_branch_requires_both_branch_and_remote() {
        let state = AppState::default();
        for (branch, remote) in [
            (None, None),
            (Some("local".to_string()), None),
            (None, Some("fork".to_string())),
        ] {
            let err = git_push_core(
                &state,
                "/definitely/not/a/repo".into(),
                false,
                false,
                branch.clone(),
                remote.clone(),
                Some("contrib".into()),
            )
            .await
            .expect_err("a lone remote_branch is refused");
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "branch={branch:?} remote={remote:?} → {err:?}"
            );
        }
    }

    /// The destination name is interpolated into the refspec's right-hand side, so
    /// it takes the same refspec-injection blocklist as the local branch: `*` would
    /// mirror-push, `:` would add a refspec field. Then the accepted arm is driven
    /// end to end against a real bare remote.
    #[tokio::test]
    async fn push_to_a_named_remote_branch_validates_then_lands_on_that_ref() {
        let (_base, base) = temp_base("remote-branch");
        let repo = base.join("repo");
        let fork = base.join("fork.git");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&fork).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        let fork_s = fork.to_string_lossy().into_owned();

        run(&fork_s, &["init", "-q", "--bare"]).await;
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "local"]).await;
        run(&repo_s, &["remote", "add", "fork", &fork_s]).await;

        let state = AppState::default();
        for bad in ["a*b", "a?b", "a[b", "a:b", "a b"] {
            let err = git_push_core(
                &state,
                repo_s.clone(),
                false,
                false,
                Some("local".into()),
                Some("fork".into()),
                Some(bad.into()),
            )
            .await
            .expect_err("refspec metacharacters are rejected");
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{bad:?} → {err:?}"
            );
        }
        // Nothing was pushed while validating.
        assert!(run(&fork_s, &["for-each-ref", "refs/heads/"])
            .await
            .trim()
            .is_empty());

        git_push_core(
            &state,
            repo_s.clone(),
            false,
            false,
            Some("local".into()),
            Some("fork".into()),
            Some("contrib".into()),
        )
        .await
        .expect("push to the named destination succeeds");

        // The commit landed under the DESTINATION name, not the local one.
        assert_eq!(
            run(&fork_s, &["rev-parse", "refs/heads/contrib"]).await.trim(),
            run(&repo_s, &["rev-parse", "refs/heads/local"]).await.trim()
        );
        assert!(
            run_git(
                Some(&fork_s),
                &["rev-parse", "refs/heads/local"],
                DEFAULT_TIMEOUT
            )
            .await
            .is_err(),
            "the local name must not be published"
        );
        // And no `-u`: the local branch is still untracked.
        assert!(
            run_git(
                Some(&repo_s),
                &["rev-parse", "--abbrev-ref", "local@{upstream}"],
                DEFAULT_TIMEOUT
            )
            .await
            .is_err(),
            "a named destination must not set upstream"
        );
    }

    /// Removing a remote that doesn't exist is an honest `InvalidArgument`, not a
    /// raw git error — the `ensure_remote_exists` gate.
    #[tokio::test]
    async fn remove_nonexistent_remote_errors_invalid_argument() {
        let (_base, base) = temp_base("missing");
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
    }

    /// The real `for-each-ref` output shape feeding `parse_upstream_tracking` — the
    /// format assumption is otherwise only checked against hand-written strings.
    #[tokio::test]
    async fn parse_upstream_tracking_matches_real_for_each_ref_output() {
        let (_base, base) = temp_base("track");
        let origin = base.join("origin");
        let repo = base.join("repo");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        let origin_s = origin.to_string_lossy().into_owned();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&origin_s, "o.txt").await;
        // The default branch name (main/master) is whatever git is configured for.
        let def = run(&origin_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &origin_s]).await;
        run(&repo_s, &["fetch", "-q", "origin"]).await;
        run(
            &repo_s,
            &["branch", &format!("--set-upstream-to=origin/{def}"), &def],
        )
        .await;
        run(&repo_s, &["branch", "feature"]).await; // untracked
        run(&repo_s, &["branch", "feat/sub"]).await; // prefix sibling; no exact `feat`

        let fmt = "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)";
        // Run the real `for-each-ref` and parse it exactly as the caller does.
        let track = |b: &str| {
            let repo_s = repo_s.clone();
            let refspec = format!("refs/heads/{b}");
            async move {
                let out = run(&repo_s, &["for-each-ref", &refspec, fmt]).await;
                parse_upstream_tracking(&out, &refspec)
            }
        };

        // Untracked branch → non-empty refname line with empty upstream fields.
        assert_eq!(
            track("feature").await,
            Some((String::new(), String::new(), false))
        );
        // Tracked branch → upstream short + remote name; gone=false (ahead/behind are
        // ignored by the parser, so divergent histories are fine).
        assert_eq!(
            track(&def).await,
            Some((format!("origin/{def}"), "origin".into(), false))
        );
        // Prefix: `for-each-ref refs/heads/feat` matches `feat/sub`, whose refname
        // isn't `refs/heads/feat` → None (the exact-match guard, end to end).
        assert_eq!(track("feat").await, None);

        // Gone upstream: track origin/<def>, then delete the remote-tracking ref so
        // `%(upstream:track)` becomes `[gone]`. Do this LAST — it also makes <def> gone.
        run(
            &repo_s,
            &["branch", "--track", "goner", &format!("origin/{def}")],
        )
        .await;
        run(
            &repo_s,
            &["update-ref", "-d", &format!("refs/remotes/origin/{def}")],
        )
        .await;
        let g = track("goner").await;
        assert!(
            matches!(g, Some((_, _, true))),
            "goner upstream should read gone: {g:?}"
        );
    }
}
