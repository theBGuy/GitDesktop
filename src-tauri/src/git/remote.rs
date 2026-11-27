use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::branches::{restore_upstream, UPSTREAM_ATOM_INDEX, UPSTREAM_WRITE_FAILED};
use crate::git::ignored_guard::{self, ignored_files_in_the_way};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, holder_label, is_config_lock_contention, run_git,
    run_git_config_write_held, run_git_mutating_config_write, run_git_raw, subcommand_of,
    with_config_write_lock, ConfigWriteHeld, GitOutput, CONFIG_LOCK_BUSY_LEAD, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
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
/// lock — so it is callable from inside a held domain: a pull's network phase
/// (`git::pull_guard`) holds the network lock around it, and the autostash pull's
/// bare fall-through holds the working tree and takes the network lock around it.
/// Returns the raw output: a non-zero exit is not an error here.
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
    run_git_with_creds_rechecked(repo_path, cred, sub, timeout, None).await
}

/// [`run_git_with_creds_once`], running `recheck` right before each of its spawns, the
/// ambient retry included: that retry is a second push of the same argv.
async fn run_git_with_creds_rechecked(
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
    recheck: Option<SpawnRecheck<'_>>,
) -> AppResult<GitOutput> {
    if let Some(recheck) = recheck {
        recheck.run(repo_path).await?;
    }
    let args = with_credentials(cred, sub);
    let out = run_git_raw(
        Some(repo_path),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        timeout,
    )
    .await?;

    // Injected credentials present but rejected → one-shot ambient retry.
    if !cred.is_empty() && out.code != 0 && is_auth_class_failure(&out.stderr) {
        if let Some(recheck) = recheck {
            recheck.run(repo_path).await?;
        }
        return run_git_raw(Some(repo_path), sub, timeout).await;
    }
    Ok(out)
}

/// [`run_git_with_creds_once`] under the repo's NETWORK lock, surfacing a non-zero
/// exit as [`AppError::Git`] — the mutating-command contract every network caller
/// (fetch/pull/push) is written against.
///
/// The network domain rather than the working tree: a transfer runs for up to
/// `NETWORK_TIMEOUT` and must not stall staging or a commit for that long. The pull
/// cores' bare fall-through is the one caller whose command also touches the working
/// tree: it holds the working-tree lock across this call, which is the only sanctioned
/// nesting direction (see `run_git_mutating`). Every other caller here — fetch, push,
/// set-head — holds nothing but the network domain this takes.
///
/// A `push -u` whose upstream write lost `.git/config.lock` still exits 0 (measured,
/// git 2.51.1), so every same-name publish gets its upstream re-set here, once the
/// network hold is released; the push itself is never re-run.
///
/// Outside this module, an argv that pushes a named local branch goes through
/// [`run_git_mutating_with_creds_for_branch`] instead, so its refusal is re-read at spawn.
pub(crate) async fn run_git_mutating_with_creds(
    state: &AppState,
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_mutating_with_creds_checked(state, repo_path, cred, sub, timeout, None).await
}

/// [`run_git_mutating_with_creds`] for an argv that pushes the local `branch`: its
/// publishing refusal re-runs under the network lock before each spawn, the
/// ambient-credential retry included.
pub(crate) async fn run_git_mutating_with_creds_for_branch(
    state: &AppState,
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
    branch: &str,
) -> AppResult<GitOutput> {
    let recheck = Some(SpawnRecheck::named(branch));
    run_git_mutating_with_creds_checked(state, repo_path, cred, sub, timeout, recheck).await
}

/// [`run_git_mutating_with_creds`], running `recheck` right before each spawn, so a
/// checkout or a Keep local mark made during the credential and lock waits is refused.
/// A change between that read and git's own is out of reach.
async fn run_git_mutating_with_creds_checked(
    state: &AppState,
    repo_path: &str,
    cred: &[String],
    sub: &[&str],
    timeout: Duration,
    recheck: Option<SpawnRecheck<'_>>,
) -> AppResult<GitOutput> {
    let tracked = push_upstream_branch(sub);
    let domain = state.network_lock(repo_path).await;
    #[cfg(test)]
    let _ = NETWORK_LOCK_WAIT_HOOK.try_with(|hook| hook());
    let guard = acquire_repo_lock(
        &domain,
        NETWORK_LOCK_WAIT_TIMEOUT,
        holder_label(subcommand_of(sub)),
    )
    .await?;

    let spawn = || run_git_with_creds_rechecked(repo_path, cred, sub, timeout, recheck);
    // index.lock contention from an external tool (editor, other client) is
    // transient — retry once. Expressed here rather than via `run_git_mutating`
    // because the injection half must stay lock-free.
    let mut out = spawn().await?;
    if out.code != 0 && out.stderr.contains("index.lock") {
        tokio::time::sleep(Duration::from_millis(300)).await;
        out = spawn().await?;
    }
    drop(guard);
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
    if let Some((remote, branch)) = tracked {
        repair_lost_upstream(repo_path, &remote, &branch, &out).await;
    }
    Ok(out)
}

#[cfg(test)]
tokio::task_local! {
    /// Runs just before a network-domain acquire, so a test can act while a command
    /// is provably queued on the domain it holds. Raised by
    /// `run_git_mutating_with_creds_checked` and `pr_checkout::fetch_pr_tip`.
    pub(crate) static NETWORK_LOCK_WAIT_HOOK: std::sync::Arc<dyn Fn() + Send + Sync>;
}

/// The `(remote, refspec)` a `push -u` argv publishes, read past any leading `-c`
/// pairs; `None` for every other argv, a `push -u` without exactly one refspec included.
fn push_upstream_target<'a>(sub: &[&'a str]) -> Option<(&'a str, &'a str)> {
    let mut rest = sub.iter().copied();
    loop {
        match rest.next()? {
            "-c" => {
                rest.next()?;
            }
            "push" => break,
            _ => return None,
        }
    }
    let mut set_upstream = false;
    let mut positional = Vec::new();
    for arg in rest {
        match arg {
            "-u" | "--set-upstream" => set_upstream = true,
            flag if flag.starts_with('-') => {}
            other => positional.push(other),
        }
    }
    match (set_upstream, positional.as_slice()) {
        (true, [remote, refspec]) => Some((*remote, *refspec)),
        _ => None,
    }
}

/// The `(remote, local branch)` a `push -u` will track, read from the argv alone and
/// only for `publish_refspec`'s same-name pair. A literal `HEAD` gets no repair: git
/// resolves it at spawn, so no earlier reading can be proven to name the branch that
/// was pushed (`git_push_with_policy` pins its HEAD publishes to the explicit pair instead).
fn push_upstream_branch(sub: &[&str]) -> Option<(String, String)> {
    let (remote, refspec) = push_upstream_target(sub)?;
    let (src, dst) = refspec.split_once(':')?;
    let branch = src.strip_prefix("refs/heads/")?;
    (dst.strip_prefix("refs/heads/")? == branch).then(|| (remote.to_string(), branch.to_string()))
}

/// Re-sets the upstream a successful `push -u` failed to write, under the config-write
/// mutex alone; its verdict never changes the push's.
async fn repair_lost_upstream(repo_path: &str, remote: &str, branch: &str, out: &GitOutput) {
    if !is_config_lock_contention(&out.stderr) || !out.stderr.contains(UPSTREAM_WRITE_FAILED) {
        return;
    }
    let upstream = format!("refs/remotes/{remote}/{branch}");
    with_config_write_lock(repo_path, |held| async move {
        restore_upstream(&held, repo_path, branch, &upstream).await
    })
    .await;
}

/// How long a resolved remote URL stays trusted before re-shelling to `git`. A few
/// seconds collapses the burst of concurrent `forge_*` queries one forge view fires
/// (each otherwise spawns `git remote get-url` twice) while still picking up an
/// out-of-band `git remote set-url` promptly; in-app changes invalidate eagerly.
const REMOTE_URL_TTL: Duration = Duration::from_secs(5);

/// Cache map keyed by `(repo_path, remote_name, push)` — `push` picks the
/// `get-url --push` variant, so the two never answer for each other; value is
/// `(fetch time, resolved url)`.
type RemoteUrlCache = Mutex<HashMap<(String, String, bool), (Instant, String)>>;

/// Per-`(repo_path, remote_name, push)` cache of the last resolved remote URL and when it
/// was fetched. Bounded by (#repos × #remote names × 2, the fetch and push variants) —
/// tiny, so a stale entry is simply overwritten on the next fetch rather than evicted.
/// Only successful lookups are cached.
/// A poisoned lock is recovered rather than propagated: every entry is TTL-bounded, so
/// a value a panicking holder left behind ages out on its own.
static REMOTE_URL_CACHE: OnceLock<RemoteUrlCache> = OnceLock::new();

fn remote_url_cache() -> &'static RemoteUrlCache {
    REMOTE_URL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached URL for `(repo, name, push)` only if an entry exists AND it was
/// fetched less than `ttl` ago. Pure over the module-level cache; the lock is held only
/// long enough to clone the value out.
fn cache_get(repo: &str, name: &str, push: bool, ttl: Duration) -> Option<String> {
    let guard = remote_url_cache().lock().unwrap_or_else(|p| p.into_inner());
    let (fetched_at, url) = guard.get(&(repo.to_string(), name.to_string(), push))?;
    if fetched_at.elapsed() < ttl {
        Some(url.clone())
    } else {
        None
    }
}

/// Record `url` as the current value for `(repo, name, push)`, stamped with the fetch
/// time.
fn cache_put(repo: &str, name: &str, push: bool, url: &str) {
    remote_url_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            (repo.to_string(), name.to_string(), push),
            (Instant::now(), url.to_string()),
        );
}

/// Drop both cached variants for `(repo, name)` so the next read re-resolves immediately:
/// `set-url` moves what `--push` resolves too (git falls back to the fetch URL when no
/// pushurl is set), so every URL write invalidates the pair.
fn cache_invalidate(repo: &str, name: &str) {
    let mut guard = remote_url_cache().lock().unwrap_or_else(|p| p.into_inner());
    for push in [false, true] {
        guard.remove(&(repo.to_string(), name.to_string(), push));
    }
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
    remote_url(&repo_path, &name, false).await
}

/// Where a push to `name` goes (`git remote get-url --push`): the remote's pushurl when
/// one is set, else its fetch URL. A sibling of [`git_remote_url`], whose signature its
/// many in-crate callers pin.
#[tauri::command]
pub async fn git_remote_push_url(repo_path: String, name: String) -> AppResult<String> {
    remote_url(&repo_path, &name, true).await
}

/// The shared core of the two URL commands; `push` selects `get-url --push` and its own
/// cache entry.
async fn remote_url(repo_path: &str, name: &str, push: bool) -> AppResult<String> {
    validate_remote_arg(name, "remote name")?;
    if let Some(url) = cache_get(repo_path, name, push, REMOTE_URL_TTL) {
        return Ok(url);
    }
    let argv: &[&str] = if push {
        &["remote", "get-url", "--push", name]
    } else {
        &["remote", "get-url", name]
    };
    let out = run_git(Some(repo_path), argv, DEFAULT_TIMEOUT).await?;
    let url = out.stdout_lossy().trim().to_string();
    cache_put(repo_path, name, push, &url);
    Ok(url)
}

/// A `remote` verb whose lost config lock leaves nothing changed — `set-url` and
/// `add` both lose at their FIRST write (measured, git 2.51.1) — so the repair re-runs
/// it whole under the held mutex. `add` writes `.url` then `.fetch`, and a loss
/// between the two (a real race, never the held-lock seam) fails the re-run as
/// "already exists", which git's error then reports.
async fn run_remote_config_verb(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
) -> AppResult<GitOutput> {
    run_git_mutating_config_write(
        state,
        repo_path,
        args,
        DEFAULT_TIMEOUT,
        |_, held| async move {
            run_git_config_write_held(&held, repo_path, args, DEFAULT_TIMEOUT).await
        },
    )
    .await
}

/// `git remote set-url <name> <url>`, recovered from a lost config lock. It neither
/// validates its arguments nor invalidates the URL cache; callers own both.
pub(crate) async fn set_remote_url(
    state: &AppState,
    repo_path: &str,
    name: &str,
    url: &str,
) -> AppResult<()> {
    run_remote_config_verb(state, repo_path, &["remote", "set-url", name, url])
        .await
        .map_err(|e| busy_if_lost_again(e, |_| REMOTE_UNCHANGED))?;
    Ok(())
}

/// `git remote add <name> <url>`, recovered from a lost config lock. It neither
/// validates its arguments nor invalidates the URL cache; [`git_remote_add_core`], its
/// only caller, owns both.
async fn add_remote(state: &AppState, repo_path: &str, name: &str, url: &str) -> AppResult<()> {
    run_remote_config_verb(state, repo_path, &["remote", "add", name, url])
        .await
        .map_err(|e| busy_if_lost_again(e, |_| REMOTE_UNCHANGED))?;
    Ok(())
}

/// Under a held lock both verbs lose at their first write, so a second loss changed
/// nothing; a real race splitting `add`'s two writes is the residual, whose retry git
/// refuses as "already exists".
const REMOTE_UNCHANGED: &str = "the remote wasn't changed — try again.";

/// A `remote` verb whose repair also lost the config lock, as [`config_lock_busy`]'s
/// refusal with the tail `tail` picks from git's text; every other failure keeps git's
/// own error, which callers match on.
fn busy_if_lost_again(e: AppError, tail: impl FnOnce(&str) -> &'static str) -> AppError {
    match e {
        AppError::Git { ref stderr, .. } if is_config_lock_contention(stderr) => {
            config_lock_busy(tail(stderr))
        }
        e => e,
    }
}

/// A busy refusal from these chokepoints re-tailed with `tail`, for a caller whose own
/// message names the next step and must not be undercut by a bare "try again"; any
/// other error passes through untouched.
pub(crate) fn with_busy_tail(e: AppError, tail: &str) -> AppError {
    match e {
        AppError::Command(ref message) if message.starts_with(CONFIG_LOCK_BUSY_LEAD) => {
            config_lock_busy(tail)
        }
        e => e,
    }
}

/// Whether `e` is the refusal of a removal that dropped the remote but left
/// `remote.pushDefault` naming it, so a wrapping caller can say the remote is gone.
pub(crate) fn is_push_default_left(e: &AppError) -> bool {
    matches!(
        e,
        AppError::Command(message)
            if message.strip_prefix(CONFIG_LOCK_BUSY_LEAD) == Some(REMOTE_PUSH_DEFAULT_LEFT)
    )
}

/// The busy tail once a removal's section went but its push-default unset lost: a retry
/// would refuse the remote as missing and could never clear the leftover.
const REMOTE_PUSH_DEFAULT_LEFT: &str = "the remote was removed but is still recorded as the \
                                        push default — clear remote.pushDefault to finish.";

/// The busy tail for a `remote remove` whose own run lost the config lock again.
fn remove_busy_tail(stderr: &str) -> &'static str {
    if stderr.contains(REMOTE_PUSH_DEFAULT_LOST) && !stderr.contains(REMOTE_SECTION_LOST) {
        REMOTE_PUSH_DEFAULT_LEFT
    } else {
        "the remote wasn't fully removed — try again."
    }
}

/// How `remote remove` reports a lost `.git/config.lock` (measured, git 2.51.1). It
/// unsets the tracking branches' keys first and dies on a lost one before deleting any
/// ref, so it re-runs cleanly; once the refs are gone, it fails removing the
/// `remote.<name>` section (exit 1) and leaves that and `remote.pushDefault` behind.
const REMOTE_BRANCH_UNSET_LOST: &str = "could not unset 'branch.";
const REMOTE_SECTION_LOST: &str = "Could not remove config section";
/// git's die when the section went but the `remote.pushDefault` unset lost, read from
/// git's source: the held-lock seam always loses the section first.
const REMOTE_PUSH_DEFAULT_LOST: &str = "could not unset 'remote.pushDefault'";

/// `git remote remove <name>`, recovered from a lost config lock: a loss before any
/// ref was deleted re-runs the command, a loss after finishes only its config legs.
/// No existence check; callers map git's "No such remote" themselves. A real race
/// losing a branch's `.merge` unset after its `.remote` one landed is beyond the
/// held-lock seam: the re-run, like a manual one, no longer sees that branch as
/// tracking and leaves its `branch.<b>.merge` orphaned.
pub(crate) async fn remove_remote(state: &AppState, repo_path: &str, name: &str) -> AppResult<()> {
    let args = ["remote", "remove", name];
    run_git_mutating_config_write(
        state,
        repo_path,
        &args,
        DEFAULT_TIMEOUT,
        |out, held| async move {
            let out = if out.stderr.contains(REMOTE_BRANCH_UNSET_LOST) {
                run_git_config_write_held(&held, repo_path, &args, DEFAULT_TIMEOUT).await?
            } else {
                out
            };
            let refs_gone = out.stderr.contains(REMOTE_SECTION_LOST)
                || out.stderr.contains(REMOTE_PUSH_DEFAULT_LOST);
            if out.code != 0 && refs_gone {
                match finish_remote_removal(&held, repo_path, name).await {
                    RemovalFinish::Done => return Ok(GitOutput { code: 0, ..out }),
                    // git's own text still names the section it lost, which is now gone.
                    RemovalFinish::PushDefaultLost => {
                        return Err(config_lock_busy(REMOTE_PUSH_DEFAULT_LEFT))
                    }
                    RemovalFinish::Failed => {}
                }
            }
            Ok(out)
        },
    )
    .await
    .map_err(|e| busy_if_lost_again(e, remove_busy_tail))?;
    Ok(())
}

/// The config legs a `remote remove` left after deleting the refs: the `remote.<name>`
/// section (already gone counts as done), then a local `remote.pushDefault` naming the
/// remote, which git unsets the same way, a multi-valued one included (exit 5, kept).
async fn finish_remote_removal(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
) -> RemovalFinish {
    let section = format!("remote.{name}");
    let removed = run_git_config_write_held(
        held,
        repo_path,
        &["config", "--remove-section", &section],
        DEFAULT_TIMEOUT,
    )
    .await;
    match &removed {
        Ok(out) if out.code == 0 || out.stderr.contains("no such section") => {}
        Ok(out) => {
            eprintln!(
                "gitdesktop: remote removal repair failed: {}",
                out.stderr.trim()
            );
            return RemovalFinish::Failed;
        }
        Err(e) => {
            eprintln!("gitdesktop: remote removal repair failed: {e}");
            return RemovalFinish::Failed;
        }
    }
    let push_default = run_git_raw(
        Some(repo_path),
        &["config", "--local", "--get-all", "remote.pushDefault"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let names_it = match &push_default {
        Ok(out) => out.code == 0 && out.stdout_lossy().lines().any(|v| v.trim() == name),
        Err(e) => {
            eprintln!("gitdesktop: remote removal repair failed: {e}");
            return RemovalFinish::Failed;
        }
    };
    if !names_it {
        return RemovalFinish::Done;
    }
    let unset = run_git_config_write_held(
        held,
        repo_path,
        &["config", "--local", "--unset", "remote.pushDefault"],
        DEFAULT_TIMEOUT,
    )
    .await;
    match unset {
        Ok(out) if out.code == 0 || out.code == 5 => RemovalFinish::Done,
        Ok(out) if is_config_lock_contention(&out.stderr) => RemovalFinish::PushDefaultLost,
        Ok(out) => {
            eprintln!(
                "gitdesktop: remote removal repair failed: {}",
                out.stderr.trim()
            );
            RemovalFinish::Failed
        }
        Err(e) => {
            eprintln!("gitdesktop: remote removal repair failed: {e}");
            RemovalFinish::Failed
        }
    }
}

/// How [`finish_remote_removal`] ended.
enum RemovalFinish {
    /// Both legs landed, or had nothing to do.
    Done,
    /// A leg failed for another reason (logged), so git's own error speaks.
    Failed,
    /// The section went, but the push-default unset lost the config lock again.
    PushDefaultLost,
}

#[tauri::command]
pub async fn git_remote_set_url(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<()> {
    git_remote_set_url_core(&state, repo_path, name, url).await
}

pub(crate) async fn git_remote_set_url_core(
    state: &AppState,
    repo_path: String,
    name: String,
    url: String,
) -> AppResult<()> {
    validate_remote_arg(&name, "remote name")?;
    validate_remote_arg(url.trim(), "remote URL")?;
    set_remote_url(state, &repo_path, &name, url.trim()).await?;
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
    add_remote(state, &repo_path, &name, url.trim()).await?;
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
    let removed = remove_remote(state, &repo_path, &name).await;
    // Dropped even on failure: a removal can fail after the remote is gone (a lost
    // push-default unset), and a stale cached URL would outlive it for the whole TTL.
    cache_invalidate(&repo_path, &name);
    removed
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

/// The shared fetch. It prunes BRANCHES — clearing tracking refs for branches the
/// forge no longer has is the action's whole point — and keeps the local tags a
/// `fetch.pruneTags` / `remote.<name>.pruneTags` config would prune: the background
/// auto-fetch runs this on a timer, and a transfer the user never asked for must
/// not delete their refs. The flag reaches only the IMPLICIT tag refspec — a remote
/// spelling `refs/tags/*` out in its own fetch config still prunes them here (the
/// pull side stands down for that shape; this always-prune action has no stand-down).
pub(crate) async fn git_fetch_core(state: &AppState, repo_path: String) -> AppResult<()> {
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &["fetch", "--prune", "--no-prune-tags"],
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

/// Fetch a single named remote, unlike [`git_fetch`] which fetches only the
/// default remote. Powers "Update from upstream" for forks: a default-remote fetch
/// never touches an `upstream` remote, so a fork needs this to see upstream's new
/// commits at all. The remote is validated to exist before use; the flags are
/// [`git_fetch_core`]'s, for the same reasons.
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
        &["fetch", "--prune", "--no-prune-tags", &remote],
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

/// The full ref `refs/remotes/<remote>/HEAD` points at; None when unset or unreadable
/// (unmeasured).
pub(crate) async fn remote_head_target(repo_path: &str, remote: &str) -> AppResult<Option<String>> {
    read_symbolic_ref(repo_path, &format!("refs/remotes/{remote}/HEAD"), "").await
}

/// Whether an upstream is its remote's default branch, comparing FULL tracking refs so
/// a remapped fetch refspec answers the same as the default one. Some only from a
/// remote HEAD that answered; None = unmeasured (no name fallback).
pub(crate) fn upstream_is_remote_default(
    remote_head_target: Option<&str>,
    upstream_tracking_ref: &str,
) -> Option<bool> {
    let target = remote_head_target.filter(|t| !t.is_empty())?;
    if upstream_tracking_ref.is_empty() {
        return None;
    }
    Some(target == upstream_tracking_ref)
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
    // Every mode splits into a network phase and a local one (git::pull_guard), so the
    // transfer holds the network domain alone and staging stays available across it.
    // Rebase mode additionally runs the fork-point guard there — bare
    // `git pull --rebase` computes its own fork point and can silently drop a pushed
    // commit a force-push rewrote away.
    if mode == "rebase" {
        if crate::git::pull_guard::guarded_pull(state, &repo_path).await? {
            return Ok(());
        }
    } else if let Some(plain) =
        crate::git::pull_guard::pin_plain_pull(state, &repo_path, mode != "merge").await?
    {
        return crate::git::pull_guard::merge_pinned(state, &repo_path, &plain).await;
    }
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    // The fall-through, for every state the split phases stand down on (each listed at
    // `pin_plain_pull` / `guarded_pull`): bare `git pull` is a transfer AND a merge in
    // one command, so it needs both domains — the working tree here, the network inside
    // `run_git_mutating_with_creds` — that order only (see `run_git_mutating`). The
    // split phases above take their own locks and must stay outside this hold.
    let wt = state.working_tree_lock(&repo_path).await;
    let _wt_guard = acquire_repo_lock(&wt, LOCK_WAIT_TIMEOUT, "a pull").await?;
    let already_unmerged = crate::git::ops::unmerged_paths(&repo_path).await;
    // Commits the pull's own transfer brings are not checked.
    if mode != "rebase"
        && !ignored_guard::merge_is_blocked(&repo_path, &already_unmerged)
            .await
            .map_err(|e| ignored_guard::check_failed("Pull", e))?
    {
        if let Some(target) = ignored_guard::upstream_commit(&repo_path).await? {
            if ignored_guard::pull_can_merge(&repo_path, &target, mode != "merge").await? {
                let paths = ignored_files_in_the_way(&repo_path, &target, WORKTREE_OP_TIMEOUT)
                    .await
                    .map_err(|e| ignored_guard::check_failed("Pull", e))?;
                if !paths.is_empty() {
                    return Err(ignored_guard::pull_refusal(&paths));
                }
            }
        }
    }
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

/// `expected_branch` / `expected_head` pin the push to the branch it was pressed on (the
/// short name, or `HEAD` for a detached HEAD) and the tip its confirm showed; `creates`
/// says the caller's own check found the destination absent. All absent is unpinned.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the push inputs plus the three optional pins
pub async fn git_push(
    state: State<'_, AppState>,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    expected_branch: Option<String>,
    expected_head: Option<String>,
    creates: Option<bool>,
) -> AppResult<PushGuardWire> {
    let pins = PushPins::from_wire(expected_branch, expected_head)?;
    // Boxed: the invoke handler builds a command's future on the UI-thread stack.
    Box::pin(git_push_core(
        &state,
        repo_path,
        set_upstream,
        force,
        branch,
        remote,
        remote_branch,
        pins,
        creates.unwrap_or(false),
    ))
    .await
}

/// `git_push`'s return value: [`PushGuard`] plus the one outcome only the GUI's pinned
/// force push can reach. The camelCase wire strings mirror the `PushGuard` union in
/// `src/lib/git/api/sync.ts`, pinned by `push_guard_wire_serializes_to_the_camel_case_wire_values`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // the shared `Lease` prefix IS the shared guarantee
pub(crate) enum PushGuardWire {
    LeaseAndIncludes,
    LeaseOnlyOldGit,
    LeaseOnlyNoReflog,
    /// `--force-if-includes` refused a clone with no fetch history for the tracking ref;
    /// the retry ran under a lease pinned to the tracking tip read before the first try.
    LeasePinnedNoTrackingReflog,
}

impl From<PushGuard> for PushGuardWire {
    fn from(guard: PushGuard) -> Self {
        match guard {
            PushGuard::LeaseAndIncludes => Self::LeaseAndIncludes,
            PushGuard::LeaseOnlyOldGit => Self::LeaseOnlyOldGit,
            PushGuard::LeaseOnlyNoReflog => Self::LeaseOnlyNoReflog,
        }
    }
}

/// What a GUI push is pinned to: HEAD's branch (never [`ExpectedRef::Any`]) and,
/// optionally, its tip. Compared after the early HEAD read and before every spawn.
#[derive(Debug, Clone)]
struct PushPins {
    branch: crate::git::commit::ExpectedRef,
    head: Option<String>,
}

impl PushPins {
    /// The IPC form: `expected_head` is a full object id and needs `expected_branch`.
    fn from_wire(
        expected_branch: Option<String>,
        expected_head: Option<String>,
    ) -> AppResult<Option<Self>> {
        use crate::git::commit::ExpectedRef;
        let branch = ExpectedRef::from_wire(expected_branch)?;
        if let Some(head) = &expected_head {
            let hex = head.bytes().all(|b| b.is_ascii_hexdigit());
            if !(matches!(head.len(), 40 | 64) && hex) {
                return Err(AppError::InvalidArgument(format!(
                    "expected head must be a full commit id: {head}"
                )));
            }
            if branch == ExpectedRef::Any {
                return Err(AppError::InvalidArgument(
                    "expected head requires an expected branch".to_string(),
                ));
            }
        }
        Ok((branch != ExpectedRef::Any).then_some(PushPins {
            branch,
            head: expected_head,
        }))
    }

    /// The pinned branch in its wire form: the short name, or `HEAD` when detached.
    fn expected(&self) -> String {
        match &self.branch {
            crate::git::commit::ExpectedRef::Branch(b) => b.clone(),
            _ => "HEAD".to_string(),
        }
    }

    /// Compares HEAD (`head_ref`, git's full ref; None when detached) with the pinned
    /// branch. Spawns nothing.
    fn check_branch(&self, head_ref: Option<&str>) -> AppResult<()> {
        use crate::git::commit::ExpectedRef;
        let on = head_ref.map(|r| r.strip_prefix("refs/heads/").unwrap_or(r));
        let same = match &self.branch {
            ExpectedRef::Branch(b) => on == Some(b.as_str()),
            ExpectedRef::Detached => head_ref.is_none(),
            ExpectedRef::Any => true,
        };
        if !same {
            return Err(AppError::PushHeadMoved {
                expected: self.expected(),
            });
        }
        Ok(())
    }

    /// [`Self::check_branch`], then HEAD's commit with the pinned tip. A failed tip read
    /// is that read's error.
    async fn check(&self, repo_path: &str, head_ref: Option<&str>) -> AppResult<()> {
        self.check_branch(head_ref)?;
        if let Some(want) = &self.head {
            let out = run_git(
                Some(repo_path),
                &["rev-parse", "--verify", "HEAD^{commit}"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if !out.stdout_lossy().trim().eq_ignore_ascii_case(want) {
                return Err(AppError::PushTipMoved {
                    branch: self.expected(),
                });
            }
        }
        Ok(())
    }

    /// [`Self::check`] against HEAD read now.
    async fn check_now(&self, repo_path: &str) -> AppResult<()> {
        let head_ref = crate::git::branches::current_branch_ref(repo_path).await?;
        self.check(repo_path, head_ref.as_deref()).await
    }
}

/// A force push's lease pinned to an explicit expected tip: only [`git_push_core`]'s
/// tracking-reflog degrade retry passes one. The tip was read for `remote`, so a retry
/// that git would now route elsewhere returns `refusal` (the first attempt's `code` and
/// `stderr`) instead of spawning.
#[derive(Debug, Clone, PartialEq)]
struct LeasePin {
    remote: String,
    dest: String,
    sha: String,
    refusal: (i32, String),
}

/// The degrade retry's routing check, run early and again at spawn: `remote` is where git
/// routes the push now.
fn refuse_moved_lease_route(pin: &LeasePin, remote: Option<&str>) -> AppResult<()> {
    if remote == Some(pin.remote.as_str()) {
        return Ok(());
    }
    let (code, stderr) = pin.refusal.clone();
    Err(AppError::Git { code, stderr })
}

/// Which guarantee a completed push actually ran under. Only meaningful for a
/// FORCE push: a non-force push has no lease to degrade, and reports
/// [`PushGuard::LeaseAndIncludes`] as the neutral value.
///
/// Crosses the IPC boundary as `git_push`'s return value, so the caller's
/// success toast can name a degraded guarantee instead of overclaiming. The
/// camelCase wire strings mirror the `PushGuard` union in `src/lib/git/api/sync.ts`
/// and are pinned by `push_guard_serializes_to_the_camel_case_wire_values`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // the shared `Lease` prefix IS the shared guarantee
pub(crate) enum PushGuard {
    /// `--force-with-lease --force-if-includes`, the intended pair.
    LeaseAndIncludes,
    /// This git predates `--force-if-includes` (2.30) — the lease alone.
    LeaseOnlyOldGit,
    /// The branch has no reflog for `--force-if-includes` to walk, so the check
    /// could never pass — the lease alone.
    LeaseOnlyNoReflog,
}

/// `remote_branch` names the DESTINATION branch when it differs from the local one
/// (pushing a maintainer's local work back to a contributor's fork head). It only
/// means anything alongside an explicit `branch` and `remote`, so any other
/// combination is rejected rather than silently ignored.
///
/// Private to this module on purpose: MCP tools push only through
/// [`git_push_same_name_core`] (refuses a named push onto a differently named
/// branch of a named remote) and [`git_force_push_head_core`] (HEAD only, so git's
/// push.default applies), never through this pinned, follow-the-routing-rule entry.
///
/// A force push of HEAD pinned to a branch and its tip carries one more fallback: on a
/// clone whose tracking ref has no reflog `--force-if-includes` refuses although nothing
/// moved, so the push is retried once under a lease pinned to the tracking tip read
/// before the first attempt, when [`tracking_reflog_retry_allowed`] proves all three legs.
#[allow(clippy::too_many_arguments)] // the push inputs plus the GUI's pins
async fn git_push_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    pins: Option<PushPins>,
    creates: bool,
) -> AppResult<PushGuardWire> {
    let degrade = match (&pins, force, &branch, set_upstream) {
        (Some(p), true, None, false) if p.head.is_some() => {
            tracking_degrade_preread(&repo_path, p).await
        }
        _ => None,
    };
    let first = git_push_with_policy(
        state,
        repo_path.clone(),
        set_upstream,
        force,
        branch.clone(),
        remote.clone(),
        remote_branch.clone(),
        CrossNameUpstream::Follow,
        pins.as_ref(),
        creates,
        false,
        None,
    )
    .await;
    match (first, degrade) {
        (Err(AppError::Git { code, stderr }), Some(pre))
            if stderr.contains(IF_INCLUDES_REJECTION) =>
        {
            let allowed =
                tracking_reflog_retry_allowed(&repo_path, &pre.branch_ref, &pre.tracking, &pre.sha)
                    .await;
            if !allowed {
                return Err(AppError::Git { code, stderr });
            }
            let lease = LeasePin {
                remote: pre.remote,
                dest: pre.dest,
                sha: pre.sha,
                refusal: (code, stderr),
            };
            git_push_with_policy(
                state,
                repo_path,
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
                CrossNameUpstream::Follow,
                pins.as_ref(),
                creates,
                false,
                Some(&lease),
            )
            .await?;
            Ok(PushGuardWire::LeasePinnedNoTrackingReflog)
        }
        (result, _) => result.map(PushGuardWire::from),
    }
}

/// The values the tracking-reflog degrade retry is decided on, read before the first
/// attempt for the PINNED branch, never HEAD.
#[derive(Debug)]
struct DegradePreread {
    /// `refs/heads/<pinned branch>`.
    branch_ref: String,
    /// The destination's remote-tracking ref: git's own `%(push)`, or for a triangular
    /// `simple` push the standard `refs/remotes/<push remote>/<branch>`.
    tracking: String,
    /// The push remote, the destination branch and the tracking ref's commit id when read.
    remote: String,
    dest: String,
    sha: String,
}

/// Position of `%(push)` among the push-destination atoms.
const PUSH_TRACKING_ATOM_INDEX: usize = 2;

/// Reads [`DegradePreread`] for a pinned branch; None (the arm off) when the pin is not
/// a branch or the destination, its tracking ref or that ref's id doesn't resolve. Where
/// `%(push)` resolves nothing, a triangular `simple` push still lands on its push remote
/// under the local name, so that destination is read when the remote keeps git's
/// standard fetch layout (any other layout leaves the arm off); matching never gets here
/// with a pin, since its pinned force push is refused first.
async fn tracking_degrade_preread(repo_path: &str, pins: &PushPins) -> Option<DegradePreread> {
    use crate::git::commit::{CasRef, ExpectedRef};
    let ExpectedRef::Branch(name) = &pins.branch else {
        return None;
    };
    let CasRef::Branch(branch_ref) = pins.branch.cas_ref(repo_path).await.ok()? else {
        return None;
    };
    let text = crate::git::branches::read_refs_with_push_destination(
        repo_path,
        &branch_ref,
        UPSTREAM_TRACKING_FORMAT,
    )
    .await
    .ok()?;
    let line = tracking_line(&text, &branch_ref)?;
    let (remote, dest, tracking) = match bare_push_destination(&text, &branch_ref, name) {
        (Some(remote), Some(dest)) => {
            let tracking = line
                .atoms()
                .get(PUSH_TRACKING_ATOM_INDEX)
                .copied()
                .filter(|t| t.starts_with("refs/"))?
                .to_string();
            (remote, dest, tracking)
        }
        _ => {
            let config = crate::git::status::push_config_strict(repo_path)
                .await
                .ok()?;
            let (Some(remote), Some(dest)) =
                config.triangular_simple_destination(name, line.upstream_remote())
            else {
                return None;
            };
            if !config.has_standard_fetch_refspec(&remote) {
                return None;
            }
            let tracking = format!("refs/remotes/{remote}/{dest}");
            (remote, dest, tracking)
        }
    };
    crate::git::branches::validate_ref_name(&dest).ok()?;
    let sha = ref_commit(repo_path, &tracking).await?;
    Some(DegradePreread {
        branch_ref,
        tracking,
        remote,
        dest,
        sha,
    })
}

/// `full_ref`'s commit id, None when it doesn't resolve or the read fails.
async fn ref_commit(repo_path: &str, full_ref: &str) -> Option<String> {
    let peeled = format!("{full_ref}^{{commit}}");
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "--quiet", &peeled],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let id = out.stdout_lossy().trim().to_string();
    (out.code == 0 && !id.is_empty()).then_some(id)
}

/// Whether the degrade retry may run, on three proofs; any other answer (entries
/// present, a non-zero exit, a failed spawn) keeps git's refusal:
/// 1. `tracking` has zero reflog entries (`reflog show -n 1` exits 0 and prints nothing);
/// 2. `tracking` still points at `pre_id`;
/// 3. `pre_id` is reachable from an entry of `branch_ref`'s reflog: `--force-if-includes`'s
///    test, made on the pushed branch, where git uses the destination-named local ref
///    (the two differ for a cross-name push): one `rev-list --stdin` fed `pre_id` and a
///    `^<entry>` line per entry prints nothing (`--not --stdin` does not negate stdin
///    lines on git 2.51.1, measured).
async fn tracking_reflog_retry_allowed(
    repo_path: &str,
    branch_ref: &str,
    tracking: &str,
    pre_id: &str,
) -> bool {
    let reflog = |full_ref: &str, limit: bool| {
        let mut args = vec!["reflog", "show"];
        if limit {
            args.extend(["-n", "1"]);
        }
        args.extend(["--format=%H", full_ref]);
        let args: Vec<String> = args.into_iter().map(str::to_string).collect();
        async move {
            let argv: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_raw(Some(repo_path), &argv, DEFAULT_TIMEOUT)
                .await
                .ok()
                .filter(|out| out.code == 0)
                .map(|out| out.stdout_lossy())
        }
    };
    match reflog(tracking, true).await {
        Some(text) if text.trim().is_empty() => {}
        _ => return false,
    }
    if ref_commit(repo_path, tracking).await.as_deref() != Some(pre_id) {
        return false;
    }
    let Some(entries) = reflog(branch_ref, false).await else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    let mut input = format!("{pre_id}\n");
    for id in entries.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if seen.insert(id) {
            input.push('^');
            input.push_str(id);
            input.push('\n');
        }
    }
    crate::git::runner::run_git_raw_input(
        Some(repo_path),
        &["rev-list", "-n", "1", "--stdin"],
        Some(&input),
        DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|out| out.code == 0 && out.stdout_lossy().trim().is_empty())
}

/// The MCP `push` tool's entry. A named push whose tracking would land it on a
/// differently named branch of a real remote is refused before any push runs: an
/// agent cannot see where a named push lands. `set_upstream` publishes under the
/// local name instead.
pub(crate) async fn git_push_same_name_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    branch: Option<String>,
    remote: Option<String>,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        set_upstream,
        false,
        branch,
        remote,
        None,
        CrossNameUpstream::Refuse,
        None,
        false,
        false,
        None,
    )
    .await
}

/// The remote rename's push of its new name: the same-name `-u` publish of `branch` to
/// `remote`, always under the create-only lease (a fetch that re-created the tracking ref
/// can't disarm it) and with `--no-follow-tags`, so `push.followTags` can't turn a refused
/// tag into a failed push of a branch that landed.
pub(crate) async fn git_push_creating_core(
    state: &AppState,
    repo_path: String,
    branch: String,
    remote: String,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        true,
        false,
        Some(branch),
        Some(remote),
        None,
        CrossNameUpstream::Refuse,
        None,
        true,
        true,
        None,
    )
    .await
}

/// The MCP `force_push` tool's entry: HEAD only, so git's own push.default applies.
pub(crate) async fn git_force_push_head_core(
    state: &AppState,
    repo_path: String,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        false,
        true,
        None,
        None,
        None,
        CrossNameUpstream::Refuse,
        None,
        false,
        false,
        None,
    )
    .await
}

#[derive(Clone, Copy, PartialEq)]
enum CrossNameUpstream {
    Follow,
    Refuse,
}

/// Refuses publishing a branch reserved for agent-session work.
fn refuse_publishing_session_branch(name: &str) -> AppResult<()> {
    if crate::git::branches::is_session_branch_name(name) {
        return Err(AppError::BranchIsAgentSession {
            branch: name.to_string(),
        });
    }
    Ok(())
}

/// The one publishing refusal every push, Publish and Create PR route runs on the branch
/// it sends: the gd/session/ prefix, then the Keep local mark, failing closed on an
/// unreadable mark. It sees only the branch a route names or HEAD's branch, so a bare
/// push sending more (`push.default=matching`, a push remote's own push refspecs) can
/// carry another marked branch: out of reach by decision (0 of 109 owner repos use
/// either), and the optional pre-push hook stops it. An unmarked spelling that git
/// stores as a marked case variant refuses under the stored name, failing closed on an
/// unreadable spelling.
pub(crate) async fn refuse_publishing_branch(repo_path: &str, name: &str) -> AppResult<()> {
    refuse_publishing_session_branch(name)?;
    if crate::git::branches::branch_keep_local(repo_path, name).await? {
        return Err(AppError::BranchKeptLocal {
            branch: name.to_string(),
        });
    }
    let stored = crate::git::branches::stored_branch_spelling(repo_path, name).await?;
    if stored != name && crate::git::branches::branch_keep_local(repo_path, &stored).await? {
        return Err(AppError::BranchKeptLocal { branch: stored });
    }
    Ok(())
}

/// The refusals a resolve or forge-publish push can raise at or before spawn (Keep local,
/// an agent-session branch and, on the resolve, a mirror remote): the remote-PR resolve
/// passes them through and the three publish routes disclose them without retry advice.
pub(crate) fn is_publishing_refusal(err: &AppError) -> bool {
    matches!(
        err,
        AppError::BranchKeptLocal { .. }
            | AppError::PushRemoteIsMirror { .. }
            | AppError::BranchIsAgentSession { .. }
    )
}

/// Refuses a push whose DESTINATION on a named remote is in gd/session/, whatever the
/// local branch is called; the local name is [`refuse_publishing_branch`]'s.
fn refuse_session_destination(branch: &str, remote: &str, dest: &str) -> AppResult<()> {
    if crate::git::branches::is_session_branch_name(dest) {
        return Err(AppError::PushDestinationIsAgentSession {
            branch: branch.to_string(),
            remote: redact_url_userinfo(remote),
            dest: dest.to_string(),
        });
    }
    Ok(())
}

/// Where a bare push of `local` lands, off the first line of a HEAD tracking read
/// ([`UPSTREAM_TRACKING_FORMAT`]'s fields, then the push atoms): None/None when the
/// line is missing (an unborn HEAD), names another ref, or carries no atoms. Out of
/// reach: an upstream remote with no fetch refspec leaves `%(upstream)` and `%(push)`
/// empty while push.default=upstream still pushes to `branch.<b>.merge` (git 2.51.1).
fn bare_push_destination(
    text: &str,
    refname: &str,
    local: &str,
) -> (Option<String>, Option<String>) {
    let Some(line) = tracking_line(text, refname) else {
        return (None, None);
    };
    crate::git::branches::push_destination_fields(
        local,
        line.atoms(),
        line.upstream_remote(),
        line.upstream_remoteref(),
    )
}

/// The local branch a bare push would update in this repository, off the same line as
/// [`bare_push_destination`]: a BRANCH upstream whose push remote (`%(push:remotename)`)
/// is `.`. A line read without the atoms falls back to the upstream's own remote, so an
/// old git refuses rather than guesses; non-branch and untracked upstreams never answer.
fn bare_push_local_upstream(text: &str, refname: &str) -> Option<String> {
    let (Upstream::Branch(up), remotename, _) = parse_upstream_tracking(text, refname)? else {
        return None;
    };
    let push_remote = tracking_line(text, refname)?
        .push_remotename()
        .unwrap_or(&remotename);
    (push_remote == ".").then_some(up)
}

/// Where a HEAD push goes: `Bare` resolves the remote from HEAD at spawn, and `Publish`
/// is the `-u` publish to HEAD's configured push remote, else origin (a detached or
/// invalidly named HEAD always publishes the literal `-u origin HEAD`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum HeadRoute {
    Bare,
    Publish,
}

/// What a push re-reads under the network lock before each spawn: the route's own reads,
/// then the pins last, when the push carries any, so only the two pin reads separate
/// the final compare from the spawn.
#[derive(Clone, Copy, Debug)]
struct SpawnRecheck<'a> {
    route: RecheckRoute<'a>,
    pins: Option<&'a PushPins>,
    /// A HEAD route's force flag and degrade lease, which [`refuse_head_push`] and
    /// [`refuse_moved_lease_route`] re-read; a named route ignores both.
    force: bool,
    lease: Option<&'a LeasePin>,
}

/// `Head` re-runs every HEAD read; `Named` is an argv pinned to a branch, remote and
/// destination, so it re-runs only the branch's publishing refusal (the remote's mirror
/// flag is read once, early).
#[derive(Clone, Copy, Debug)]
enum RecheckRoute<'a> {
    Head(HeadRoute),
    Named(&'a str),
}

impl<'a> SpawnRecheck<'a> {
    /// An unpinned recheck of a named branch's argv.
    fn named(branch: &'a str) -> Self {
        SpawnRecheck {
            route: RecheckRoute::Named(branch),
            pins: None,
            force: false,
            lease: None,
        }
    }

    async fn run(self, repo_path: &str) -> AppResult<()> {
        match self.route {
            RecheckRoute::Head(route) => {
                let head = refuse_head_push(repo_path, route, self.pins, self.force).await?;
                if let Some(pin) = self.lease {
                    refuse_moved_lease_route(pin, head.remote.as_deref())?;
                }
            }
            RecheckRoute::Named(branch) => refuse_publishing_branch(repo_path, branch).await?,
        }
        #[cfg(test)]
        let _ = RECHECK_PINS_HOOK.try_with(|hook| hook());
        if let Some(pins) = self.pins {
            pins.check_now(repo_path).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
tokio::task_local! {
    /// Runs in [`SpawnRecheck::run`] between the route's reads and the final pin check.
    static RECHECK_PINS_HOOK: std::sync::Arc<dyn Fn() + Send + Sync>;
}

/// What [`refuse_head_push`] read: HEAD's full ref and branch (None when detached), and
/// the remote the route pushes to (None for a bare push git has no destination for).
#[derive(Debug)]
struct HeadPush {
    head_ref: Option<String>,
    branch: Option<String>,
    remote: Option<String>,
}

/// The remote a HEAD push authenticates against and is mirror-checked on. `Bare` is
/// git's own routing ([`PushConfig::bare_push_remote`]), None when the winning value is
/// empty; `Publish` is HEAD's configured push remote (unusable refuses), else origin.
/// `remotes` is consulted only for a validly named HEAD. With no push remote configured,
/// `tracking` (HEAD's upstream read) refuses an Untracked HEAD as the named route does
/// ([`untracked_branch_remote`]); it never picks the destination.
fn head_push_remote(
    config: &crate::git::status::PushConfig,
    route: HeadRoute,
    head: Option<&str>,
    remotes: &[String],
    tracking: Option<(&Upstream, &str)>,
) -> AppResult<Option<String>> {
    match route {
        HeadRoute::Bare => Ok(config.bare_push_remote(head).map(str::to_string)),
        HeadRoute::Publish => {
            let valid = head.filter(|b| crate::git::branches::validate_ref_name(b).is_ok());
            let configured = match valid {
                Some(b) => configured_push_remote_checked(config, remotes, b)?,
                None => None,
            };
            if let (None, Some(b), Some((upstream, remotename))) = (configured, valid, tracking) {
                untracked_branch_remote(config, remotes, b, upstream, remotename)?;
            }
            Ok(Some(configured.unwrap_or("origin").to_string()))
        }
    }
}

/// `branch`'s configured push remote ([`PushConfig::push_remote_setting`]), validated:
/// empty, an invalid name or not one of `remotes` is
/// [`PushRemoteUnusable`](AppError::PushRemoteUnusable), naming the key that won.
fn configured_push_remote_checked<'c>(
    config: &'c crate::git::status::PushConfig,
    remotes: &[String],
    branch: &str,
) -> AppResult<Option<&'c str>> {
    let Some((key, value)) = config.push_remote_setting(branch) else {
        return Ok(None);
    };
    let usable = !value.is_empty()
        && crate::git::branches::validate_ref_name(value).is_ok()
        && remotes.iter().any(|r| r == value);
    if !usable {
        return Err(AppError::PushRemoteUnusable {
            branch: branch.to_string(),
            key,
            value: redact_url_userinfo(value),
        });
    }
    Ok(Some(value))
}

/// A push-remote value with its login replaced by `***`, to keep a user name or password
/// written into a URL or scp-style address out of messages. The mask ends at the last `@`
/// (after a scheme, `%40` too) before the first `/` that can end the host, so it can also
/// take part of a path, of a `?` or `#` part, or of a name that holds `@` and `:`; a value
/// with no `:`, and a `X:\` drive path with no `@[`, come back as they are.
pub(crate) fn redact_url_userinfo(value: &str) -> String {
    if !value.contains(':') {
        return value.to_string();
    }
    let scheme = value.find("://").map(|i| i + 3);
    // A `X:\` value with no `@[` holds no login: git reads it as a drive path or as the
    // scp-style host `X`.
    let bytes = value.as_bytes();
    if scheme.is_none()
        && bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
        && !value.contains("@[")
    {
        return value.to_string();
    }
    let start = scheme.unwrap_or(0);
    let host = &value[start..];
    // The search runs to the first `/`, counted from the `]` when the host starts with `[`
    // or follows `@[` (git's `host_end`): read without url-decoding, git's ssh, scp-style
    // and http readers each end the host there or sooner. After a scheme git's ssh reader
    // decodes first; of the encoded marks only `%40` is followed, as `@`.
    let open = [
        host.find("@[").map(|i| (i, i + 1)),
        scheme.and(host.find("%40[")).map(|i| (i, i + 3)),
    ]
    .into_iter()
    .flatten()
    .min()
    .map_or(0, |(_, after)| after);
    let from = host[open..]
        .strip_prefix('[')
        .and_then(|rest| rest.find(']'))
        .map_or(0, |i| open + 1 + i);
    let end = host[from..].find('/').map_or(host.len(), |i| from + i);
    let part = &host[..end];
    match part.rfind('@').max(scheme.and(part.rfind("%40"))) {
        Some(at) => format!("{}***{}", &value[..start], &host[at..]),
        None => value.to_string(),
    }
}

/// Every pre-spawn read of a HEAD push, run early and again at spawn for an argv that
/// resolves HEAD there: HEAD's branch (`None` when detached), its publishing refusal,
/// and one config listing for the push remote and its mirror refusal. `pins`' branch is
/// compared first, so a moved HEAD answers that and never the other branch's refusal. A
/// pinned bare FORCE push (the sync bar's) is refused where git's routing would send more
/// refs than the pinned one ([`PushForceMultiRef`](AppError::PushForceMultiRef)); a plain
/// or unpinned push keeps git's configured routing.
async fn refuse_head_push(
    repo_path: &str,
    route: HeadRoute,
    pins: Option<&PushPins>,
    force: bool,
) -> AppResult<HeadPush> {
    use crate::git::status::{mirror_refusal, push_config_strict, PushRemote};
    // git's own full ref, so the destination read's pattern is never rebuilt from a name.
    let head_ref = crate::git::branches::current_branch_ref(repo_path).await?;
    if let Some(pins) = pins {
        pins.check_branch(head_ref.as_deref())?;
    }
    let head = head_ref
        .as_deref()
        .and_then(|r| r.strip_prefix("refs/heads/"))
        .map(str::to_string);
    if let Some(b) = &head {
        refuse_publishing_branch(repo_path, b).await?;
    }
    let config = push_config_strict(repo_path).await?;
    let publish_head = head.as_deref().filter(|_| route == HeadRoute::Publish);
    let configured = publish_head.is_some_and(|b| config.push_remote_setting(b).is_some());
    // Only an unconfigured HEAD with `branch.<b>.remote` set can meet the untracked refusal.
    let branch_remote = !configured
        && publish_head.is_some_and(|b| config.branch_remote(b).is_some_and(|n| !n.is_empty()));
    let remotes = if configured || branch_remote {
        git_remotes(repo_path.to_string()).await?
    } else {
        Vec::new()
    };
    let tracking = match (branch_remote, head_ref.as_deref()) {
        (true, Some(refname)) => {
            let out = run_git(
                Some(repo_path),
                &["for-each-ref", refname, UPSTREAM_TRACKING_FORMAT],
                DEFAULT_TIMEOUT,
            )
            .await?;
            parse_upstream_tracking(&out.stdout_lossy(), refname)
        }
        _ => None,
    };
    let tracking = tracking.as_ref().map(|(up, name, _)| (up, name.as_str()));
    let remote = head_push_remote(&config, route, head.as_deref(), &remotes, tracking)?;
    // A bare push git has no destination for is git's own failure, never a mirror push.
    match (route, remote.as_deref()) {
        (HeadRoute::Bare, Some(_)) => mirror_refusal(
            &config,
            PushRemote::Bare {
                head: head.as_deref(),
            },
        )?,
        (HeadRoute::Publish, Some(r)) => mirror_refusal(&config, PushRemote::Named(r))?,
        (_, None) => {}
    }
    if let (HeadRoute::Bare, true, Some(_), Some(r)) = (route, force, pins, remote.as_deref()) {
        if let Some(cause) = config.multi_ref_cause(r) {
            return Err(AppError::PushForceMultiRef {
                branch: head.clone().unwrap_or_else(|| "HEAD".to_string()),
                remote: redact_url_userinfo(r),
                cause,
            });
        }
    }
    // A bare push of a non-session HEAD lands on a session branch only under
    // push.default=upstream, which the push atoms resolve; matching and a push remote's
    // own refspecs send refs the user configured and stay out of reach. The atom's push
    // remote agrees with the mirror verdict's for every tracked HEAD; an untracked one
    // reads empty, which resolves nothing here.
    if let (HeadRoute::Bare, Some(refname), Some(b)) = (route, head_ref.as_deref(), head.as_deref())
    {
        let text = crate::git::branches::read_refs_with_push_destination(
            repo_path,
            refname,
            UPSTREAM_TRACKING_FORMAT,
        )
        .await?;
        // A push remote of `.` beside a branch upstream pushes into this repository, under
        // every push.default; a push remote configured beside it sends the push there.
        // A GONE `.` upstream is refused too: the named arm retargets it at origin, git doesn't.
        if let Some(upstream) = bare_push_local_upstream(&text, refname) {
            return Err(AppError::PushUpstreamIsLocal {
                branch: b.to_string(),
                upstream,
            });
        }
        if let (Some(remote), Some(dest)) = bare_push_destination(&text, refname, b) {
            refuse_session_destination(b, &remote, &dest)?;
        }
    }
    Ok(HeadPush {
        head_ref,
        branch: head,
        remote,
    })
}

#[allow(clippy::too_many_arguments)] // push inputs, the caller's policy, pins and leases
async fn git_push_with_policy(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    cross_name: CrossNameUpstream,
    pins: Option<&PushPins>,
    creates: bool,
    no_follow_tags: bool,
    lease_pin: Option<&LeasePin>,
) -> AppResult<PushGuard> {
    if remote_branch.is_some() && (branch.is_none() || remote.is_none()) {
        return Err(AppError::InvalidArgument(
            "remote branch requires an explicit branch and remote".to_string(),
        ));
    }
    // The credential config is scoped to the remote we actually push to, resolved
    // below; None (a bare push git has no destination for) builds none.
    let cred_remote: Option<String>;
    // The HEAD path's `-u` publish names its branch explicitly (see that arm).
    let mut head_branch: Option<String> = None;
    // `(branch, remote, dest)` when the argv carries the create-only lease, so its
    // `(stale info)` refusal can be named.
    let mut create_lease: Option<(String, String, String)> = None;
    // Owned Strings: a named-branch push interpolates the branch into a refspec,
    // which can't borrow from a temporary.
    let args: Vec<String> = match &branch {
        None => {
            // A remote can only be chosen for an explicit branch: the HEAD path follows
            // git's own routing, or publishes to HEAD's push remote (see `HeadRoute`).
            if remote.is_some() {
                return Err(AppError::InvalidArgument(
                    "remote requires an explicit branch".to_string(),
                ));
            }
            // Bare and force pushes resolve HEAD at spawn, after the credential and lock
            // waits, so the spawn re-checks too, pins included. This early read is the
            // fast failure.
            let route = if set_upstream {
                HeadRoute::Publish
            } else {
                HeadRoute::Bare
            };
            let head = refuse_head_push(&repo_path, route, pins, force).await?;
            if let Some(pin) = lease_pin {
                refuse_moved_lease_route(pin, head.remote.as_deref())?;
            }
            if let Some(pins) = pins {
                pins.check(&repo_path, head.head_ref.as_deref()).await?;
            }
            if set_upstream && crate::git::branches::head_is_unborn(&repo_path).await? {
                return Err(crate::git::branches::unborn_head_error());
            }
            cred_remote = head.remote.clone();
            let mut a = head_push_argv(force, lease_pin);
            if set_upstream {
                // Pin the branch read above as an explicit same-name pair so the push and
                // upstream repair agree after the lock wait. Detached HEAD or a name
                // failing validate_ref_name keeps the literal `-u origin HEAD`, unleased.
                head_branch = head
                    .branch
                    .filter(|b| crate::git::branches::validate_ref_name(b).is_ok());
                match head_branch.as_deref() {
                    Some(b) => {
                        let target = head.remote.unwrap_or_else(|| "origin".to_string());
                        if !force
                            && (creates || !tracking_ref_present(&repo_path, &target, b).await)
                        {
                            a.push(create_lease_arg(b));
                            create_lease = Some((b.to_string(), target.clone(), b.to_string()));
                        }
                        a.extend(["-u".to_string(), target, publish_refspec(b)]);
                    }
                    None => a.extend(["-u", "origin", "HEAD"].map(str::to_string)),
                }
            }
            a
        }
        Some(b) => {
            crate::git::branches::validate_ref_name(b)?;
            refuse_publishing_branch(&repo_path, b).await?;
            if let Some(pins) = pins {
                pins.check_now(&repo_path).await?;
            }
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
            }
            let remotes = git_remotes(repo_path.clone()).await?;
            if let Some(r) = &remote {
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
                    UPSTREAM_TRACKING_FORMAT,
                ],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // No exact-refname line ⇒ no such local branch (an *untracked* branch
            // still emits `refs/heads/<b>\0\0\0`).
            let Some((upstream, remotename, gone)) =
                parse_upstream_tracking(&out.stdout_lossy(), &format!("refs/heads/{b}"))
            else {
                if crate::git::branches::head_is_unborn(&repo_path).await?
                    && crate::git::branches::current_branch_name(&repo_path)
                        .await?
                        .as_deref()
                        == Some(b.as_str())
                {
                    return Err(crate::git::branches::unborn_head_error());
                }
                return Err(AppError::InvalidArgument(format!("no such branch: {b}")));
            };
            let config = crate::git::status::push_config_strict(&repo_path).await?;
            // Phase 1: the MCP policy's cross-name refusal is decided against the
            // upstream's own remote first; when it holds, the push config is not consulted
            // and the flow below is the one that policy always had.
            let mcp_refuses = cross_name == CrossNameUpstream::Refuse
                && cross_name_refusal(
                    b,
                    &upstream,
                    &remotename,
                    gone,
                    set_upstream,
                    None,
                    None,
                    remote_branch.as_deref(),
                )
                .is_some();
            // Phase 2: an explicit remote always wins and the push config is never read
            // for it; otherwise the configured push remote, validated.
            let configured = if remote.is_none() && !mcp_refuses {
                configured_push_remote_checked(&config, &remotes, b)?
            } else {
                None
            };
            let remotename = if remote.is_none() && configured.is_none() {
                untracked_branch_remote(&config, &remotes, b, &upstream, &remotename)?
            } else {
                remotename
            };
            let route = NamedRoute {
                branch: b,
                upstream: &upstream,
                remotename: &remotename,
                gone,
                set_upstream,
                requested: remote.as_deref(),
                configured,
                remote_branch: remote_branch.as_deref(),
            };
            // The credential config targets the remote the push goes to.
            let target = route.refuse(&config, &remotes, cross_name)?;
            let dest = route.dest();
            let tracked =
                force || !route.publishes() || tracking_ref_present(&repo_path, &target, b).await;
            let lease = CreateLease {
                creates,
                dest_tracked: tracked,
            };
            let args = route.argv(force, lease);
            if args.contains(&create_lease_arg(dest)) {
                create_lease = Some((b.clone(), target.clone(), dest.to_string()));
            }
            cred_remote = Some(target);
            args
        }
    };
    let mut args = args;
    if no_follow_tags {
        args.insert(1, "--no-follow-tags".to_string());
    }
    let cred = match &cred_remote {
        Some(r) => crate::forge::credential_config_for_remote(&repo_path, r).await?,
        None => Vec::new(),
    };
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    // Only an argv naming no branch resolves HEAD at spawn; a pinned one re-reads its mark.
    let route = match (branch.as_deref().or(head_branch.as_deref()), set_upstream) {
        (Some(pinned), _) => RecheckRoute::Named(pinned),
        (None, false) => RecheckRoute::Head(HeadRoute::Bare),
        (None, true) => RecheckRoute::Head(HeadRoute::Publish),
    };
    let recheck = Some(SpawnRecheck {
        route,
        pins,
        force,
        lease: lease_pin,
    });
    let (repo, timeout) = (repo_path.as_str(), NETWORK_TIMEOUT);
    match run_git_mutating_with_creds_checked(state, repo, &cred, &argv, timeout, recheck).await {
        Ok(_) => Ok(PushGuard::LeaseAndIncludes),
        Err(AppError::Git { stderr, .. })
            if argv.contains(&FORCE_IF_INCLUDES) && is_unknown_push_option(&stderr) =>
        {
            // git < 2.30 doesn't know `--force-if-includes`. Unknown options are
            // rejected while parsing argv, before any network I/O, so this retry
            // can't push twice; it degrades to the lease alone.
            let retry = without_force_if_includes(&argv);
            run_git_mutating_with_creds_checked(state, repo, &cred, &retry, timeout, recheck)
                .await?;
            Ok(PushGuard::LeaseOnlyOldGit)
        }
        Err(AppError::Git { code, stderr })
            if argv.contains(&FORCE_IF_INCLUDES) && stderr.contains(IF_INCLUDES_REJECTION) =>
        {
            // The flag proves inclusion by walking the local branch's reflog, so
            // with no reflog it can never pass: an amend with the remote left
            // untouched is rejected (measured) under core.logAllRefUpdates=false.
            // The lease still guards the retry — at worst, pre-change behavior.
            // Left standing on purpose: a PRESENT reflog with expired entries
            // (gc.reflogExpire), and a cross-name push colliding with a stale
            // local branch named like the destination (git walks THAT branch's
            // reflog — measured); neither can prove inclusion, so both reject.
            let pinned = branch.as_deref().or(head_branch.as_deref());
            let Some(b) = pushed_branch(&repo_path, pinned).await else {
                return Err(AppError::Git { code, stderr });
            };
            if branch_has_reflog(&repo_path, &b).await {
                return Err(AppError::Git { code, stderr });
            }
            let retry = without_force_if_includes(&argv);
            run_git_mutating_with_creds_checked(state, repo, &cred, &retry, timeout, recheck)
                .await?;
            Ok(PushGuard::LeaseOnlyNoReflog)
        }
        // The create-only lease refuses only a destination that exists at another commit.
        // Several `To` blocks (one per push URL) may have created it on another URL first,
        // so only a one-destination report is named; the rest keeps git's text.
        Err(AppError::Git { stderr, .. })
            if create_lease.is_some()
                && is_stale_lease_rejection(&stderr)
                && stderr
                    .lines()
                    .filter(|l| l.trim().starts_with("To "))
                    .count()
                    == 1 =>
        {
            let (branch, remote, dest) = create_lease.unwrap_or_default();
            Err(AppError::PushDestinationExists {
                branch,
                remote,
                dest,
            })
        }
        // Only the bare HEAD push reaches git's push.default=simple name check: every
        // named arm passes an explicit refspec.
        Err(AppError::Git { code, stderr })
            if branch.is_none() && !set_upstream && is_push_simple_name_refusal(&stderr) =>
        {
            Err(confirmed_name_mismatch(&repo_path)
                .await
                .unwrap_or(AppError::Git { code, stderr }))
        }
        Err(other) => Err(other),
    }
}

/// Whether git's push report refuses a ref for a stale lease: a line whose status start
/// ([`rejection_status_line`]) is `! [rejected]` and whose end is `(stale info)` (`<src>
/// -> <dest>` and `(delete) -> <dest>` alike). Server text arrives behind `remote:`, so it
/// never matches.
pub(crate) fn is_stale_lease_rejection(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        let line = rejection_status_line(line);
        line.starts_with("! [rejected]") && line.ends_with("(stale info)")
    })
}

/// One push-report line, trimmed and without its leading SGR color sequences: under
/// `color.transport=always` git colors the status flag even though the runner pins
/// `color.ui=false`.
pub(crate) fn rejection_status_line(line: &str) -> &str {
    let mut rest = line.trim();
    while let Some(after) = rest.strip_prefix("\x1b[") {
        match after.find(|c: char| !(c.is_ascii_digit() || c == ';')) {
            Some(end) if after[end..].starts_with('m') => rest = &after[end + 1..],
            _ => break,
        }
    }
    rest
}

/// git's `push.default=simple` refusal for an upstream with a different name
/// (`die_push_simple`). git wraps it across lines, so it is matched with every
/// whitespace run collapsed; the runner's `LC_ALL=C` keeps it English.
const PUSH_SIMPLE_NAME_REFUSAL: &str = "does not match the name of your current branch";

fn is_push_simple_name_refusal(stderr: &str) -> bool {
    stderr
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains(PUSH_SIMPLE_NAME_REFUSAL)
}

/// The typed refusal for HEAD's branch, built only from tracking re-read now: a live
/// BRANCH upstream on a real remote whose name differs. Anything unconfirmed (detached,
/// a failed read, a non-branch or local `.` upstream) is `None`, so the caller keeps
/// git's own error rather than naming unverified refs.
async fn confirmed_name_mismatch(repo_path: &str) -> Option<AppError> {
    // git's own full ref for HEAD, so the lookup pattern is never rebuilt from a name.
    let refname = crate::git::branches::current_branch_ref(repo_path)
        .await
        .ok()
        .flatten()?;
    let head = refname.strip_prefix("refs/heads/")?.to_string();
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", &refname, UPSTREAM_TRACKING_FORMAT],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    match parse_upstream_tracking(&out.stdout_lossy(), &refname)? {
        (Upstream::Branch(up), remote, false) if up != head && is_named_remote(&remote) => {
            Some(AppError::PushUpstreamNameMismatch {
                branch: head,
                remote,
                remote_branch: up,
            })
        }
        _ => None,
    }
}

/// Whether `%(upstream:remotename)` names a real remote: empty is untracked, and `.`
/// is a local upstream (measured, git 2.51.1), neither of which has a remote to push to.
pub(crate) fn is_named_remote(remotename: &str) -> bool {
    !remotename.is_empty() && remotename != "."
}

/// Companion to `--force-with-lease`: git refuses the push unless the remote tip
/// is already incorporated into the local branch, so a background fetch can't
/// satisfy the lease on a teammate's unseen work. Git 2.30+.
const FORCE_IF_INCLUDES: &str = "--force-if-includes";

/// git's per-ref reason when `--force-if-includes` finds the remote tip missing
/// from the local branch's reflog — verbatim from `! [rejected] … (…)`.
const IF_INCLUDES_REJECTION: &str = "remote ref updated since checkout";

/// The local branch a push targeted: the caller's explicit name, else HEAD's own
/// branch. `None` on a detached HEAD (and on a spawn failure) — no branch means
/// no reflog to reason about, so callers must not retry. Git itself walks the
/// local ref named after the DESTINATION when one exists (measured); the source
/// name probed here covers the app's same-name default — see the arm's comment.
/// Every consumer here rebuilds `refs/heads/<name>` from the result.
async fn pushed_branch(repo_path: &str, branch: Option<&str>) -> Option<String> {
    if let Some(b) = branch {
        return Some(b.to_string());
    }
    crate::git::branches::current_branch_name(repo_path)
        .await
        .ok()
        .flatten()
}

/// Whether `refs/heads/<branch>` has a reflog (`git reflog exists`, exit 0/1). An
/// unrunnable probe counts as "has one": the degrading retry only fires on
/// positive proof that `--force-if-includes` had nothing to walk.
async fn branch_has_reflog(repo_path: &str, branch: &str) -> bool {
    run_git_raw(
        Some(repo_path),
        &["reflog", "exists", &format!("refs/heads/{branch}")],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_or(true, |out| out.code == 0)
}

/// Whether git rejected an unknown command-line option — for a push, the signal
/// that this git predates `--force-if-includes` (2.30). The matched text is the
/// runner's `full_failure_text`, which can carry remote-relayed lines, so a
/// server-echoed phrase triggers the retry too; that only degrades to the lease.
fn is_unknown_push_option(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown switch")
        || lower.contains("unknown option")
        || lower.contains("usage: git push")
}

/// The push argv minus `--force-if-includes`, everything else kept in order.
fn without_force_if_includes<'a>(argv: &[&'a str]) -> Vec<&'a str> {
    argv.iter()
        .copied()
        .filter(|a| *a != FORCE_IF_INCLUDES)
        .collect()
}

/// The `for-each-ref` format [`parse_upstream_tracking`] reads. The upstream rides
/// `%(upstream:remoteref)` (`branch.<b>.merge`, the branch's name ON the remote),
/// never `%(upstream:short)`: the short form disambiguates against local refs, so a
/// tag named `origin/<x>` turns it into `remotes/origin/<x>`, which the push would
/// then create as a new remote branch. The remote-side name also needs no knowledge
/// of the remote's fetch-refspec layout, and covers a local (`.`) upstream.
pub(crate) const UPSTREAM_TRACKING_FORMAT: &str =
    "--format=%(refname)%00%(upstream:remoteref)%00%(upstream:remotename)%00%(upstream:track)";

/// How many fields [`UPSTREAM_TRACKING_FORMAT`] writes, so the push atoms a read appends
/// start at this index.
pub(crate) const UPSTREAM_TRACKING_FIELDS: usize = 4;

/// The first line of a tracking read split once: [`UPSTREAM_TRACKING_FORMAT`]'s fields,
/// then the push-destination atoms (none when the read fell back without them).
pub(super) struct TrackingLine<'a> {
    fields: Vec<&'a str>,
}

/// Position of `%(push:remotename)` among the push-destination atoms; the whole atom
/// order is pinned against git by `tracking_line_reads_each_push_atom_by_name`.
const PUSH_REMOTENAME_ATOM_INDEX: usize = 0;

/// None when there is no line or it names another ref (for-each-ref matches a prefix).
pub(super) fn tracking_line<'a>(text: &'a str, refname: &str) -> Option<TrackingLine<'a>> {
    let fields: Vec<&str> = text.lines().next()?.split('\0').collect();
    (fields.first() == Some(&refname)).then_some(TrackingLine { fields })
}

impl<'a> TrackingLine<'a> {
    /// `%(upstream:remoteref)`, empty when untracked.
    pub(super) fn upstream_remoteref(&self) -> &'a str {
        self.fields.get(1).copied().unwrap_or("")
    }

    /// `%(upstream:remotename)`, empty when untracked.
    pub(super) fn upstream_remote(&self) -> &'a str {
        self.fields.get(2).copied().unwrap_or("")
    }

    /// The push-destination atoms, in `PUSH_DESTINATION_ATOMS` order.
    pub(super) fn atoms(&self) -> &[&'a str] {
        self.fields.get(UPSTREAM_TRACKING_FIELDS..).unwrap_or(&[])
    }

    /// None when the line carries no atoms; `Some("")` when the atom is empty.
    pub(super) fn push_remotename(&self) -> Option<&'a str> {
        self.atoms().get(PUSH_REMOTENAME_ATOM_INDEX).copied()
    }

    /// `%(upstream)`, the upstream's full tracking ref; None when the line carries no atoms.
    pub(super) fn upstream_atom(&self) -> Option<&'a str> {
        self.atoms().get(UPSTREAM_ATOM_INDEX).copied()
    }
}

/// What a local branch tracks, as [`build_push_args`] needs it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Upstream {
    /// No upstream configured.
    Untracked,
    /// A branch on the upstream remote, by its name there.
    Branch(String),
    /// A ref that is no branch (`refs/pull/<n>/head`, `refs/tags/<x>`): nothing to
    /// push INTO, and nothing a push may retrack away from.
    NotABranch,
}

/// Parse one [`UPSTREAM_TRACKING_FORMAT`] line into `(upstream, remotename, gone)`,
/// but ONLY when its `%(refname)` equals `expected_ref`. `for-each-ref` matches a
/// pattern as a prefix up to a slash (`refs/heads/feat` also matches
/// `refs/heads/feat/sub`), so the exact refname check is what enforces "no such
/// branch" for a non-exact name. Returns `None` when there is no line, or the first
/// line's refname isn't `expected_ref`. An *untracked* branch still emits
/// `refs/heads/<b>\0\0\0`, which (refname matches) parses to
/// `Some((Upstream::Untracked, "", false))`.
pub(crate) fn parse_upstream_tracking(
    stdout: &str,
    expected_ref: &str,
) -> Option<(Upstream, String, bool)> {
    let line = stdout.lines().next()?;
    let mut parts = line.split('\0');
    let refname = parts.next().unwrap_or("");
    if refname != expected_ref {
        return None;
    }
    let upstream = upstream_from_remoteref(parts.next().unwrap_or(""));
    let remotename = parts.next().unwrap_or("").to_string();
    let track = parts.next().unwrap_or("");
    // Mirror branches/listing.rs's gone detection: `[gone]` in %(upstream:track).
    Some((upstream, remotename, track.contains("[gone]")))
}

/// An `%(upstream:remoteref)` value as an [`Upstream`]. Three shapes of
/// `branch.<b>.merge`: `refs/heads/<x>` is branch `<x>`; any other `refs/` ref
/// (`refs/pull/<n>/head` from a pull fetch refspec) is NOT a branch, pushed under the
/// local name with its tracking config left alone; a bare name (hand-edited config,
/// which git DWIMs) is the branch name itself. Empty is untracked.
pub(crate) fn upstream_from_remoteref(remoteref: &str) -> Upstream {
    match remoteref {
        "" => Upstream::Untracked,
        remoteref => match remoteref.strip_prefix("refs/heads/") {
            Some(name) => Upstream::Branch(name.to_string()),
            None if remoteref.starts_with("refs/") => Upstream::NotABranch,
            None => Upstream::Branch(remoteref.to_string()),
        },
    }
}

/// The push-destination contract, the one routing rule every named push follows: an
/// explicit remote always wins and the push configuration is never read for it; else
/// `branch.<b>.pushRemote`, else `remote.pushDefault` (a set, unusable value is
/// [`PushRemoteUnusable`](AppError::PushRemoteUnusable), never a fallback); else the
/// LIVE upstream's remote; else `origin`. The destination branch is the upstream's name
/// only when the push goes to the upstream's own remote; anywhere else it is the local
/// name. The HEAD `-u` publish takes the configured push remote, else origin, never the
/// upstream's remote. The bare and force HEAD pushes follow git's own routing instead,
/// pinned to the branch (and, for a force push, the tip) they were pressed on.
///
/// Out of the contract, with their status (counts are of the owner's 109 repos, measured
/// when the status read's destination claim shipped):
/// 1. a push remote with its own push refspecs (0): documented, git's bare push sends them;
/// 2. several pushurls (0): documented;
/// 3. a narrow or remapped fetch refspec (1, a fixture): documented;
/// 4. a git without the `%(push)` atoms (unmeasured): documented, destinations read unknown;
/// 5. force pushes: closed by the branch and tip pins;
/// 6. presence as last-fetch remote-tracking state: open, no network read before a push;
///    the create-only lease bounds its damage on the arms that set the upstream. A single
///    pushurl naming another repository than the fetch URL is this class too: the
///    presence read describes the fetch side.
///
/// The lease's presence probe can misread two shapes: a remote whose name contains a
/// slash (`refs/remotes/a/b/c` is both remote `a/b` branch `c` and remote `a` branch
/// `b/c`, so a present answer may belong to the other and the lease is not armed), and a
/// remapped fetch refspec (the tracking ref lives elsewhere, so the probe reads absent
/// and the lease arms, which can only refuse).
///
/// Pure so the decision table stays unit-testable; shared by the argv builder, the
/// policy's refusals and [`NamedPushRouting::destination`], so there is one resolver.
fn resolve_push_target<'a>(
    requested_remote: Option<&'a str>,
    configured: Option<&'a str>,
    remotename: &'a str,
    gone: bool,
) -> &'a str {
    match requested_remote.or(configured) {
        Some(r) => r,
        None if !remotename.is_empty() && !gone => remotename,
        None => "origin",
    }
}

/// The upstream remote a named push naming no remote, with no configured push remote,
/// routes by; the argv builder and [`NamedPushRouting::destination`] both read it, so the
/// row and the push agree. It is `remotename` except on an untracked read, which publishes
/// by D2 (the empty answer: the configured push remote, else origin) when
/// `branch.<b>.remote` names a listed remote, or holds a value with a leading `.`, or one
/// holding `/`, a backslash or `:`; any other unlisted name is `unknown remote` (never a
/// silent retarget at origin). The HEAD publish applies the same refusal
/// ([`head_push_remote`]).
fn untracked_branch_remote(
    config: &crate::git::status::PushConfig,
    remotes: &[String],
    branch: &str,
    upstream: &Upstream,
    remotename: &str,
) -> AppResult<String> {
    if !matches!(upstream, Upstream::Untracked) || !remotename.is_empty() {
        return Ok(remotename.to_string());
    }
    let Some(name) = config.branch_remote(branch).filter(|n| !n.is_empty()) else {
        return Ok(String::new());
    };
    let url_or_path =
        name.starts_with('.') || name.contains('/') || name.contains(':') || name.contains('\\');
    if remotes.iter().any(|r| r == name) || url_or_path {
        return Ok(String::new());
    }
    Err(AppError::InvalidArgument(format!("unknown remote: {name}")))
}

/// The tracked arm's destination, shared by the argv builder and the MCP policy: the
/// upstream's branch, only when the push goes to the upstream's own remote.
fn tracked_push_upstream<'a>(
    upstream: &'a Upstream,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    requested_remote: Option<&str>,
    configured: Option<&str>,
    remote_branch: Option<&str>,
) -> Option<&'a str> {
    match upstream {
        Upstream::Branch(up)
            if !gone
                && !set_upstream
                && remote_branch.is_none()
                && resolve_push_target(requested_remote, configured, remotename, gone)
                    == remotename =>
        {
            Some(up)
        }
        _ => None,
    }
}

/// Refuse only cross-name tracked destinations on named remotes; local tracking
/// has no remote destination for the MCP remedy to offer.
#[allow(clippy::too_many_arguments)] // the tracking inputs plus the push's routing
fn cross_name_refusal<'a>(
    branch: &str,
    upstream: &'a Upstream,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    requested_remote: Option<&str>,
    configured: Option<&str>,
    remote_branch: Option<&str>,
) -> Option<&'a str> {
    if !is_named_remote(remotename) {
        return None;
    }
    tracked_push_upstream(
        upstream,
        remotename,
        gone,
        set_upstream,
        requested_remote,
        configured,
        remote_branch,
    )
    .filter(|up| *up != branch)
}

/// One named-branch push's routing inputs, from its tracking read and the caller.
///
/// - `upstream`: what the branch tracks, see [`parse_upstream_tracking`];
/// - `remotename`: `%(upstream:remotename)` (the tracked upstream's remote);
/// - `gone`: the tracked ref was deleted (`[gone]`);
/// - `requested`: an explicit push target, which always wins;
/// - `configured`: the validated configured push remote, consulted only without one;
/// - `remote_branch`: an explicit DESTINATION branch name, only ever with `requested`.
#[derive(Clone, Copy, Debug)]
struct NamedRoute<'a> {
    branch: &'a str,
    upstream: &'a Upstream,
    remotename: &'a str,
    gone: bool,
    set_upstream: bool,
    requested: Option<&'a str>,
    configured: Option<&'a str>,
    remote_branch: Option<&'a str>,
}

impl<'a> NamedRoute<'a> {
    /// The remote `T` the push goes to ([`resolve_push_target`]).
    fn target(&self) -> &'a str {
        resolve_push_target(self.requested, self.configured, self.remotename, self.gone)
    }

    fn tracked(&self) -> Option<&'a str> {
        tracked_push_upstream(
            self.upstream,
            self.remotename,
            self.gone,
            self.set_upstream,
            self.requested,
            self.configured,
            self.remote_branch,
        )
    }

    /// Whether the push publishes and tracks (`-u`): untracked, gone, or asked to, never
    /// with an explicit destination; a non-branch upstream retracks only on request.
    fn publishes(&self) -> bool {
        self.remote_branch.is_none()
            && match self.upstream {
                Upstream::Untracked => true,
                Upstream::Branch(_) => self.gone || self.set_upstream,
                Upstream::NotABranch => self.set_upstream,
            }
    }

    /// The destination branch: the named one, else the tracked upstream's, else the
    /// local name.
    fn dest(&self) -> &'a str {
        self.remote_branch
            .or_else(|| self.tracked())
            .unwrap_or(self.branch)
    }

    /// The routing refusals, in order, against `T`: a mirror remote, a local `.`
    /// upstream, a destination in gd/session/, the MCP policy's cross-name refusal, a
    /// remote that is not one of `remotes` or fails `validate_ref_name`, and a destination
    /// that would fail it as the full ref `refs/heads/<dest>`. Answers `T`.
    fn refuse(
        &self,
        config: &crate::git::status::PushConfig,
        remotes: &[String],
        cross_name: CrossNameUpstream,
    ) -> AppResult<String> {
        let target = self.target();
        crate::git::status::mirror_refusal(config, crate::git::status::PushRemote::Named(target))?;
        // A live `.` upstream targets this repository (an explicit remote never is `.`),
        // set_upstream included.
        if let (".", Upstream::Branch(up)) = (target, self.upstream) {
            return Err(AppError::PushUpstreamIsLocal {
                branch: self.branch.to_string(),
                upstream: up.clone(),
            });
        }
        // The local name is already checked; before the cross-name refusal, so both
        // policies answer with the session copy.
        if is_named_remote(target) {
            refuse_session_destination(self.branch, target, self.dest())?;
        }
        if cross_name == CrossNameUpstream::Refuse {
            if let Some(up) = cross_name_refusal(
                self.branch,
                self.upstream,
                self.remotename,
                self.gone,
                self.set_upstream,
                self.requested,
                self.configured,
                self.remote_branch,
            ) {
                return Err(AppError::PushUpstreamNameMismatch {
                    branch: self.branch.to_string(),
                    remote: self.remotename.to_string(),
                    remote_branch: up.to_string(),
                });
            }
        }
        // Both names can come from config and reach argv: the remote bare, where `-x` would
        // read as an option; the destination only behind `refs/heads/`, where a leading dash
        // is valid, so it passes exactly where that full ref passes `validate_ref_name`.
        if !remotes.iter().any(|r| r == target) {
            return Err(AppError::InvalidArgument(format!(
                "unknown remote: {target}"
            )));
        }
        if crate::git::branches::validate_ref_name(target).is_err() {
            return Err(AppError::InvalidArgument(format!(
                "invalid remote name: {target}"
            )));
        }
        let dest = self.dest();
        let body = dest.trim_start_matches('-');
        let bad = !body.is_empty() && crate::git::branches::validate_ref_name(body).is_err();
        if dest.is_empty() || bad {
            return Err(AppError::InvalidArgument(format!(
                "invalid branch name: {dest}"
            )));
        }
        Ok(target.to_string())
    }

    fn argv(&self, force: bool, lease: CreateLease) -> Vec<String> {
        build_push_args(self, force, lease)
    }
}

/// When a non-force named push carries the create-only lease: on the caller's `creates`
/// on any arm, and on an arm that sets the upstream whenever the destination's tracking
/// ref is not proven present (`dest_tracked`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct CreateLease {
    creates: bool,
    dest_tracked: bool,
}

impl CreateLease {
    /// Never leased: no create recorded, the destination proven tracked.
    #[cfg(test)]
    const NONE: Self = CreateLease {
        creates: false,
        dest_tracked: true,
    };
}

/// `--force-with-lease=refs/heads/<dest>:` (empty expected value): git refuses the push
/// unless `dest` is absent on the remote or already at the pushed commit.
fn create_lease_arg(dest: &str) -> String {
    format!("--force-with-lease=refs/heads/{dest}:")
}

/// `--force-with-lease=refs/heads/<dest>:<sha>`, the lease pinned to an explicit tip.
fn pinned_lease_arg(dest: &str, sha: &str) -> String {
    format!("--force-with-lease=refs/heads/{dest}:{sha}")
}

/// A HEAD push's argv up to its `-u` part: a force push takes the lease pinned to
/// `lease_pin` alone, else the lease plus `--force-if-includes`, which refuses to clobber
/// remote work this branch hasn't integrated (a bare lease is satisfied by any fetch).
fn head_push_argv(force: bool, lease_pin: Option<&LeasePin>) -> Vec<String> {
    let mut a = vec!["push".to_string()];
    match (force, lease_pin) {
        (true, Some(pin)) => a.push(pinned_lease_arg(&pin.dest, &pin.sha)),
        (true, None) => {
            a.push("--force-with-lease".to_string());
            a.push(FORCE_IF_INCLUDES.to_string());
        }
        (false, _) => {}
    }
    a
}

/// Whether `refs/remotes/<remote>/<branch>` exists (`show-ref --verify --quiet` exit 0).
/// Any other answer, a failed spawn included, reads absent: that arms the create-only
/// lease, which can only refuse a destination that differs.
async fn tracking_ref_present(repo_path: &str, remote: &str, branch: &str) -> bool {
    let tracking = format!("refs/remotes/{remote}/{branch}");
    run_git_raw(
        Some(repo_path),
        &["show-ref", "--verify", "--quiet", &tracking],
        DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|out| out.code == 0)
}

/// Decide the `git push` args for pushing a NAMED local branch, from its
/// [`NamedRoute`]. Pure — no git calls — so the decision table is unit-testable.
///
/// The target `T` is [`resolve_push_target`]. Rules:
/// - `remote_branch` = `rb` → `push T refs/heads/<branch>:refs/heads/<rb>`, no `-u`:
///   an explicitly named destination pins the refspec and leaves tracking alone.
/// - untracked / gone branch / `set_upstream` → `-u T
///   refs/heads/<branch>:refs/heads/<branch>` (publish + track). A *gone* upstream
///   publishes under the LOCAL name, deliberately not resurrecting a differently-named
///   deleted ref.
/// - tracked branch `up` and `T == remotename`: `push T
///   refs/heads/<branch>:refs/heads/<up>` (a bare `push T <branch>` would advance the
///   WRONG remote ref when the names differ).
/// - tracked and `T != remotename` (a configured push remote, or an explicit copy
///   elsewhere), or a non-branch upstream: `push T refs/heads/<branch>:refs/heads/<branch>`
///   with NO `-u` — the local name, upstream config untouched.
///
/// Refspecs are fully qualified so a branch named `+x`/`-x` can't be read as a
/// force/delete indicator; the remote is only ever the bare `push <remote>` arg.
/// `force` prepends `--force-with-lease --force-if-includes` in every arm and never
/// takes the create-only lease, which otherwise sits ahead of `-u` and the remote.
fn build_push_args(route: &NamedRoute<'_>, force: bool, lease: CreateLease) -> Vec<String> {
    let branch = route.branch;
    let publish = route.publishes();
    let dest = route.dest();
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
        args.push(FORCE_IF_INCLUDES.to_string());
    } else if lease.creates || (publish && !lease.dest_tracked) {
        args.push(create_lease_arg(dest));
    }
    if publish {
        args.push("-u".to_string());
    }
    args.push(route.target().to_string());
    args.push(format!("refs/heads/{branch}:refs/heads/{dest}"));
    args
}

/// Where a named push of a branch goes under the routing rule, for the branch list.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NamedPushDestination {
    To {
        remote: String,
        branch: String,
    },
    /// Refused for a routing reason (see [`NamedPushRouting::destination`]).
    Refused,
}

/// The two reads [`NamedPushRouting::destination`] decides on, read once per listing.
pub(crate) struct NamedPushRouting {
    config: crate::git::status::PushConfig,
    remotes: Vec<String>,
}

/// One push-config listing plus the repository's remotes.
pub(crate) async fn named_push_routing(repo_path: &str) -> AppResult<NamedPushRouting> {
    Ok(NamedPushRouting {
        config: crate::git::status::push_config_strict(repo_path).await?,
        remotes: git_remotes(repo_path.to_string()).await?,
    })
}

impl NamedPushRouting {
    /// Where a GUI push of `branch` naming no remote and asking no retrack lands, through
    /// the same functions that build its argv. `Refused` exactly where that push refuses
    /// for a routing reason: an unusable configured push remote, a `.` remote beside a
    /// branch upstream, a mirror remote, a remote that is not configured, a remote name
    /// that fails `validate_ref_name` or a destination that would fail it as `refs/heads/<dest>`,
    /// a destination in gd/session/, a `branch.<b>.remote` no remote has
    /// ([`untracked_branch_remote`]), or a branch name that fails it or is itself a session
    /// branch. Keep local and an unborn branch are not routing refusals.
    pub(crate) fn destination(
        &self,
        branch: &str,
        upstream: &Upstream,
        remotename: &str,
        gone: bool,
    ) -> NamedPushDestination {
        if crate::git::branches::validate_ref_name(branch).is_err()
            || crate::git::branches::is_session_branch_name(branch)
        {
            return NamedPushDestination::Refused;
        }
        let Ok(configured) = configured_push_remote_checked(&self.config, &self.remotes, branch)
        else {
            return NamedPushDestination::Refused;
        };
        let remotename = match configured {
            Some(_) => remotename.to_string(),
            None => match untracked_branch_remote(
                &self.config,
                &self.remotes,
                branch,
                upstream,
                remotename,
            ) {
                Ok(r) => r,
                Err(_) => return NamedPushDestination::Refused,
            },
        };
        let route = NamedRoute {
            branch,
            upstream,
            remotename: &remotename,
            gone,
            set_upstream: false,
            requested: None,
            configured,
            remote_branch: None,
        };
        match route.refuse(&self.config, &self.remotes, CrossNameUpstream::Follow) {
            Ok(remote) => NamedPushDestination::To {
                remote,
                branch: route.dest().to_string(),
            },
            Err(_) => NamedPushDestination::Refused,
        }
    }
}

/// The branch a forge publish pushes: HEAD's branch NAME, validated for the publish
/// refspec. Every provider's publish runs it BEFORE it creates the remote project — a
/// refusal after the create would orphan it. The two refusal strings are the publish
/// dialog's contract.
pub(crate) async fn publish_branch(repo_path: &str) -> AppResult<String> {
    let Some(branch) = crate::git::branches::current_branch_name(repo_path).await? else {
        return Err(AppError::InvalidArgument(
            "check out a branch before publishing (detached HEAD)".into(),
        ));
    };
    if crate::git::branches::head_is_unborn(repo_path).await? {
        return Err(AppError::InvalidArgument(
            "make an initial commit before publishing (this repository has none yet)".into(),
        ));
    }
    crate::git::branches::validate_ref_name(&branch)?;
    // The dispatch refused HEAD's branch as it read it then; this is the name the
    // provider pushes, so a checkout between the two reads can't publish past the guard.
    refuse_publishing_branch(repo_path, &branch).await?;
    Ok(branch)
}

/// Refuses a publish when `origin` already exists, since the post-create `remote add`
/// would fail and strand the new project. Fails closed: only git's "No such remote"
/// proceeds; any other failure refuses with git's own text.
pub(crate) async fn refuse_existing_origin(repo_path: &str) -> AppResult<()> {
    existing_origin_verdict(repo_path, &[]).await
}

/// The verdict over one `remote get-url origin` run. git before 2.30 answers a missing
/// remote with exit 128 and "No such remote" (2.30.0 release notes: `git remote` exit
/// codes made scriptable); the runner pins LC_ALL=C, so that text is stable.
fn existing_origin_decision(out: &GitOutput) -> AppResult<()> {
    match out.code {
        0 => Err(AppError::InvalidArgument(
            "this repository already has an origin remote — push to it instead".into(),
        )),
        2 => Ok(()),
        128 if out.stderr.contains("No such remote") => Ok(()),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// `remote get-url` counts only repository-scope config, the same test `remote add`
/// makes: a url-less local `[remote "origin"]` exits 0, a global-only `remote.origin.*`
/// key exits 2 (measured, git 2.51.1). `envs` is the tests' per-spawn config seam.
async fn existing_origin_verdict(repo_path: &str, envs: &[(&str, &str)]) -> AppResult<()> {
    let out = crate::git::runner::run_git_raw_env(
        Some(repo_path),
        &["remote", "get-url", "origin"],
        envs,
        DEFAULT_TIMEOUT,
    )
    .await?;
    existing_origin_decision(&out)
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
        cache_get, cache_invalidate, cache_put, cross_name_refusal, git_fetch_core, git_pull_core,
        git_push_same_name_core, git_remote_add_core, git_remote_remove_core,
        git_remote_set_url_core, is_auth_class_failure, is_push_default_left,
        is_push_simple_name_refusal,
        is_unknown_push_option, parse_upstream_tracking, publish_refspec, push_upstream_branch,
        push_upstream_target, remove_busy_tail, remove_remote, resolve_push_target,
        run_git_mutating_with_creds, tracked_push_upstream, with_busy_tail,
        without_force_if_includes, PushGuard,
        Upstream, FORCE_IF_INCLUDES, IF_INCLUDES_REJECTION, NETWORK_LOCK_WAIT_HOOK,
        REMOTE_BRANCH_UNSET_LOST, REMOTE_PUSH_DEFAULT_LEFT, REMOTE_PUSH_DEFAULT_LOST,
        REMOTE_SECTION_LOST, REMOTE_UNCHANGED, UPSTREAM_TRACKING_FORMAT,
    };
    use crate::error::AppError;
    use crate::git::branches::UPSTREAM_WRITE_FAILED;
    use crate::git::runner::{
        config_lock_busy, hold_config_lock, is_config_lock_contention, run_git, run_git_raw,
        TestGitEnv, DEFAULT_TIMEOUT, NETWORK_TIMEOUT, TEST_GIT_HANG_GUARD,
    };
    use crate::state::AppState;
    use std::time::Duration;

    // Distinct keys per test — the cache is a process-wide static shared across all tests.
    const BIG: Duration = Duration::from_secs(3600);

    #[test]
    fn put_then_get_within_ttl_hits() {
        cache_put("/repo/a", "origin", false, "git@example.com:a.git");
        assert_eq!(
            cache_get("/repo/a", "origin", false, BIG),
            Some("git@example.com:a.git".to_string())
        );
    }

    #[test]
    fn zero_ttl_is_always_expired() {
        cache_put("/repo/b", "origin", false, "https://example.com/b.git");
        // Zero TTL: any elapsed time (however small) is >= the TTL, so the entry reads as expired.
        assert_eq!(cache_get("/repo/b", "origin", false, Duration::ZERO), None);
    }

    #[test]
    fn invalidate_drops_the_entry() {
        cache_put("/repo/c", "origin", false, "https://example.com/c.git");
        assert!(cache_get("/repo/c", "origin", false, BIG).is_some());
        cache_invalidate("/repo/c", "origin");
        assert_eq!(cache_get("/repo/c", "origin", false, BIG), None);
    }

    #[test]
    fn distinct_keys_do_not_collide() {
        cache_put("/repo/d", "origin", false, "url-origin");
        cache_put("/repo/d", "upstream", false, "url-upstream");
        cache_put("/repo/e", "origin", false, "url-e-origin");
        assert_eq!(
            cache_get("/repo/d", "origin", false, BIG),
            Some("url-origin".to_string())
        );
        assert_eq!(
            cache_get("/repo/d", "upstream", false, BIG),
            Some("url-upstream".to_string())
        );
        assert_eq!(
            cache_get("/repo/e", "origin", false, BIG),
            Some("url-e-origin".to_string())
        );
        // Invalidating one key leaves the others intact.
        cache_invalidate("/repo/d", "origin");
        assert_eq!(cache_get("/repo/d", "origin", false, BIG), None);
        assert_eq!(
            cache_get("/repo/d", "upstream", false, BIG),
            Some("url-upstream".to_string())
        );
    }

    /// The fetch and push variants of one remote are separate entries, and an
    /// invalidation drops both.
    #[test]
    fn push_and_fetch_urls_cache_apart_and_invalidate_together() {
        cache_put("/repo/f", "origin", false, "https://fetch.example/f.git");
        cache_put("/repo/f", "origin", true, "https://push.example/f.git");
        assert_eq!(
            cache_get("/repo/f", "origin", false, BIG),
            Some("https://fetch.example/f.git".to_string())
        );
        assert_eq!(
            cache_get("/repo/f", "origin", true, BIG),
            Some("https://push.example/f.git".to_string())
        );
        cache_invalidate("/repo/f", "origin");
        assert_eq!(cache_get("/repo/f", "origin", false, BIG), None);
        assert_eq!(cache_get("/repo/f", "origin", true, BIG), None);
    }

    /// `--push` reads a separate pushurl, and falls back to the fetch URL without one.
    #[tokio::test]
    async fn the_push_url_command_reads_the_pushurl_or_falls_back() {
        let dir = tempfile::Builder::new()
            .prefix("gd-remote-pushurl-")
            .tempdir()
            .unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        run_git(Some(&repo), &["init", "-q"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        let add = ["remote", "add", "origin", "https://fetch.example/o/r.git"];
        run_git(Some(&repo), &add, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        let url = |push: bool| {
            let (repo, name) = (repo.clone(), "origin".to_string());
            async move {
                if push {
                    super::git_remote_push_url(repo, name).await.unwrap()
                } else {
                    super::git_remote_url(repo, name).await.unwrap()
                }
            }
        };
        assert_eq!(url(true).await, "https://fetch.example/o/r.git");
        let set = [
            "remote",
            "set-url",
            "--push",
            "origin",
            "https://push.example/me/r.git",
        ];
        run_git(Some(&repo), &set, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        // An out-of-band write: the in-app writers evict, this one waits out the TTL.
        cache_invalidate(&repo, "origin");
        assert_eq!(url(true).await, "https://push.example/me/r.git");
        assert_eq!(url(false).await, "https://fetch.example/o/r.git");
    }

    #[test]
    fn miss_returns_none() {
        assert_eq!(cache_get("/repo/never-written", "origin", false, BIG), None);
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
            TEST_GIT_HANG_GUARD,
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

    // --- The fork-point guard on a rebase-mode pull. ---

    /// A clone whose PUSHED commit `V` the upstream then force-pushed away — the
    /// state a bare `git pull --rebase` replays out of existence. Returns the
    /// fixture guard, the clone's path, V's sha, and the rewritten origin tip.
    ///
    /// The push is what arms it: it writes V into the clone's
    /// `refs/remotes/origin/main` reflog, which is where fork-point reads it.
    async fn vaporize_clone(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, base, _origin_s, url) = seeded_origin(tag).await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(clone.join("v.txt"), "v\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "V the victim"]).await;
        run(&clone_s, &["push", "-q"]).await;
        let victim = run(&clone_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        run(&work_s, &["fetch", "-q"]).await;
        run(&work_s, &["reset", "-q", "--hard", "origin/main~1"]).await;
        std::fs::write(work.join("r.txt"), "r\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "teammate rewrite"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;
        let rewritten = run(&work_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        (guard, clone_s, victim, rewritten)
    }

    async fn head_of(repo: &str, rev: &str) -> String {
        run(repo, &["rev-parse", rev]).await.trim().to_string()
    }

    async fn subjects(repo: &str) -> Vec<String> {
        run(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The whole point: a teammate's force-push over a commit the user already
    /// pushed makes bare `git pull --rebase` drop it silently ("Successfully
    /// rebased", no conflict). The guard refuses instead, naming the commit — and
    /// leaves the branch and the working tree exactly where it found them.
    #[tokio::test]
    async fn a_rebase_pull_refuses_to_vaporize_a_force_pushed_commit() {
        let (_guard, clone_s, victim, rewritten) = vaporize_clone("vaporize").await;
        assert_eq!(
            head_of(&clone_s, "refs/remotes/origin/main").await,
            victim,
            "the clone has not seen the rewrite yet — the guard's own fetch must"
        );

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("a pull that would drop a pushed commit must refuse");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.branch, "main");
        assert_eq!(drop.upstream, "origin/main");
        assert_eq!(drop.branch_tip, victim);
        assert_eq!(
            drop.fork_point, victim,
            "V is the fork point the reflog remembers"
        );
        assert_eq!(drop.new_tip, rewritten);
        assert_eq!(
            drop.merge_base,
            head_of(&clone_s, &format!("{victim}~1")).await,
            "the merge base is V's parent — the last commit both sides share"
        );
        assert_eq!(drop.commits.len(), 1, "{:?}", drop.commits);
        assert_eq!(drop.commits[0].sha, victim);
        assert_eq!(drop.commits[0].subject, "V the victim");
        assert_eq!(drop.commits[0].author, "T");
        assert!(
            drop.commits[0].author_date.starts_with("20"),
            "the ISO author date must be populated: {:?}",
            drop.commits[0].author_date
        );

        // The guard fetched (that is how it learned of the rewrite) and then
        // touched nothing else.
        assert_eq!(head_of(&clone_s, "refs/remotes/origin/main").await, rewritten);
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
        assert_eq!(subjects(&clone_s).await.first().unwrap(), "V the victim");
        assert!(
            run(&clone_s, &["status", "--porcelain"]).await.trim().is_empty(),
            "the working tree is untouched"
        );
        assert!(run(&clone_s, &["stash", "list"]).await.trim().is_empty());
        assert!(!crate::git::ops::op_state(&clone_s).await.unwrap().rebasing);
    }

    /// A rewrite can take more than one commit with it, and the decision UI lists
    /// them — newest first, the order `git log` walks the range in.
    #[tokio::test]
    async fn a_rebase_pull_names_every_commit_a_rewrite_would_take() {
        let (_guard, base, _origin_s, url) = seeded_origin("multi-drop").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // Two commits, both PUSHED — so both sit in the tracking ref's reflog.
        for (file, subject) in [("v1.txt", "V1 the first"), ("v2.txt", "V2 the second")] {
            std::fs::write(clone.join(file), "v\n").unwrap();
            run(&clone_s, &["add", "-A"]).await;
            run(&clone_s, &["commit", "-qm", subject]).await;
        }
        run(&clone_s, &["push", "-q"]).await;
        let v1 = head_of(&clone_s, "HEAD~1").await;
        let v2 = head_of(&clone_s, "HEAD").await;

        run(&work_s, &["fetch", "-q"]).await;
        run(&work_s, &["reset", "-q", "--hard", "origin/main~2"]).await;
        std::fs::write(work.join("r.txt"), "r\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "teammate rewrite"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("two doomed commits must refuse just as one does");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.commits.len(), 2, "{:?}", drop.commits);
        assert_eq!(
            drop.commits.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(),
            vec![v2.as_str(), v1.as_str()],
            "newest first"
        );
        assert_eq!(drop.commits[0].subject, "V2 the second");
        assert_eq!(drop.commits[1].subject, "V1 the first");
        assert!(
            drop.message.contains("2 commits"),
            "the summary counts them: {}",
            drop.message
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, v2, "nothing was touched");
    }

    /// A tree left mid-merge has a CLEAN index (`git merge --no-commit` stages
    /// without conflicting), so only the in-progress probe catches it. The guard
    /// stands down and git's own refusal — which names the unfinished merge —
    /// reaches the user, instead of `rebase --onto`'s "you have unstaged changes",
    /// which the frontend would offer to stash-recover over a live merge.
    #[tokio::test]
    async fn a_rebase_pull_mid_merge_stands_down_to_bare_pull() {
        let (_guard, clone_s, victim, _rewritten) = vaporize_clone("mid-op").await;
        run(&clone_s, &["switch", "-q", "-c", "side", "HEAD~1"]).await;
        std::fs::write(std::path::Path::new(&clone_s).join("s.txt"), "s\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "side"]).await;
        run(&clone_s, &["switch", "-q", "main"]).await;
        run(&clone_s, &["merge", "--no-commit", "--no-ff", "side"]).await;
        assert!(
            run(&clone_s, &["ls-files", "--unmerged"]).await.trim().is_empty(),
            "the fixture's merge must be paused with a CLEAN index"
        );
        assert!(crate::git::ops::op_state(&clone_s).await.unwrap().merging);

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses to pull over an unfinished merge");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.contains("MERGE_HEAD exists"),
            "bare pull's own refusal must survive: {stderr}"
        );
        assert!(
            !crate::git::ops::op_state(&clone_s).await.unwrap().rebasing,
            "and no rebase was started over the paused merge"
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
    }

    /// A detached HEAD has no upstream to compare against, so the guard stands
    /// down and git says so in its own words.
    #[tokio::test]
    async fn a_rebase_pull_on_a_detached_head_stands_down_to_bare_pull() {
        let (_guard, clone_s, victim, _rewritten) = vaporize_clone("detached").await;
        run(&clone_s, &["switch", "-q", "--detach"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses a pull with no branch to rebase");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.to_lowercase().contains("not currently on a branch"),
            "bare pull's own refusal must survive: {stderr}"
        );
        assert_eq!(head_of(&clone_s, "HEAD").await, victim);
    }

    /// A branch tracking another LOCAL branch has no remote to fetch from, so the
    /// guard runs its verdict and skips phase A's fetch. The repo has no remote at
    /// all, which is what makes a skipped fetch provable: any attempt would fail.
    #[tokio::test]
    async fn a_rebase_pull_tracking_a_local_branch_never_fetches() {
        let (_base, base) = temp_base("local-upstream");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "-M", "main"]).await;
        run(&repo_s, &["switch", "-q", "-c", "dev"]).await;
        std::fs::write(repo.join("dev.txt"), "dev\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "dev work"]).await;
        run(&repo_s, &["switch", "-q", "main"]).await;
        run(&repo_s, &["branch", "--set-upstream-to=dev", "main"]).await;
        assert!(
            run(&repo_s, &["remote"]).await.trim().is_empty(),
            "no remote exists, so a fetch could only fail"
        );

        let state = AppState::default();
        git_pull_core(&state, repo_s.clone(), "rebase".into())
            .await
            .expect("a local-branch upstream pulls without any network step");
        assert_eq!(
            head_of(&repo_s, "refs/heads/main").await,
            head_of(&repo_s, "refs/heads/dev").await,
            "main fast-forwarded onto its local upstream"
        );
    }

    /// Fork-point's protective face, which is why this is a question and not a
    /// silent policy: the upstream deliberately amended its OWN commit, so
    /// replaying the local copy would duplicate it. The guard still asks — the
    /// user is the one who knows which happened.
    #[tokio::test]
    async fn a_rebase_pull_reports_a_deliberate_upstream_amend() {
        let (_guard, base, _origin_s, url) = seeded_origin("amend").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // X lands upstream first, so the clone starts with it.
        std::fs::write(work.join("x.txt"), "x\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "X the amended"]).await;
        run(&work_s, &["push", "-q"]).await;
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;
        let old_x = head_of(&clone_s, "HEAD").await;

        // A local, unpushed commit on top of X.
        std::fs::write(clone.join("v.txt"), "v\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-qm", "my local work"]).await;

        // Upstream amends X and force-pushes.
        std::fs::write(work.join("x.txt"), "x amended\n").unwrap();
        run(&work_s, &["commit", "-q", "--amend", "-am", "X the amended"]).await;
        run(&work_s, &["push", "-q", "--force"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("an upstream rewrite is always the user's call");
        let AppError::PullRebaseWouldDrop(drop) = &err else {
            panic!("expected a would-drop refusal, got {err:?}");
        };
        assert_eq!(drop.commits.len(), 1, "{:?}", drop.commits);
        assert_eq!(
            drop.commits[0].sha, old_x,
            "the stale copy of X is what would go"
        );
        assert_eq!(drop.commits[0].subject, "X the amended");
    }

    /// The case that must stay promptless: with nothing being rewritten away, a
    /// guarded pull has to land in the same state bare `git pull --rebase` did —
    /// both when the branch is merely behind and when it has diverged.
    #[tokio::test]
    async fn a_rebase_pull_with_nothing_to_drop_matches_bare_pull() {
        for diverged in [false, true] {
            let tag = if diverged { "same-diverged" } else { "same-behind" };
            let (_guard, base, _origin_s, url) = seeded_origin(tag).await;
            let base_s = base.to_string_lossy().into_owned();
            let work = base.join("work");
            let work_s = work.to_string_lossy().into_owned();

            let mut clones = Vec::new();
            for name in ["guarded", "bare"] {
                run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
                let c = base.join(name).to_string_lossy().into_owned();
                run(&c, &["config", "core.autocrlf", "false"]).await;
                run(&c, &["config", "user.email", "t@t.local"]).await;
                run(&c, &["config", "user.name", "T"]).await;
                if diverged {
                    // A different file from upstream's, so the replay is clean.
                    std::fs::write(base.join(name).join("mine.txt"), "mine\n").unwrap();
                    run(&c, &["add", "-A"]).await;
                    run(&c, &["commit", "-qm", "my local work"]).await;
                }
                clones.push(c);
            }

            // Ordinary upstream progress — no rewrite anywhere.
            std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
            run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
            run(&work_s, &["push", "-q"]).await;

            let state = AppState::default();
            git_pull_core(&state, clones[0].clone(), "rebase".into())
                .await
                .expect("a pull with nothing to drop must not prompt");
            run(&clones[1], &["pull", "--rebase", "-q"]).await;

            assert_eq!(
                subjects(&clones[0]).await,
                subjects(&clones[1]).await,
                "diverged={diverged}: the guarded pull's history must match bare pull's"
            );
            assert_eq!(
                run(&clones[0], &["ls-files"]).await,
                run(&clones[1], &["ls-files"]).await,
                "diverged={diverged}: and so must the tree"
            );
            if !diverged {
                assert_eq!(
                    head_of(&clones[0], "HEAD").await,
                    head_of(&clones[0], "refs/remotes/origin/main").await,
                    "a behind-only pull still fast-forwards onto the upstream tip"
                );
            }
        }
    }

    /// No upstream to compare against is no fork-point question, so the guard
    /// stands down and git's own tracking-information error reaches the user
    /// unchanged.
    #[tokio::test]
    async fn a_rebase_pull_without_an_upstream_falls_back_to_bare_pull() {
        let (_guard, clone_s, _victim, _rewritten) = vaporize_clone("no-upstream").await;
        run(&clone_s, &["switch", "-q", "-c", "untracked-branch"]).await;

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("git refuses a pull with nothing to pull from");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.to_lowercase().contains("no tracking information"),
            "bare pull's own refusal must survive: {stderr}"
        );
    }

    /// An upstream branch deleted on the forge. Without a pruning fetch the stale
    /// tracking ref survives, every rev in the probe resolves against it, and the
    /// rebase onto that stale tip succeeds — reporting a pull that bare git
    /// refuses outright. The prune is what turns this back into git's own error.
    #[tokio::test]
    async fn a_rebase_pull_whose_upstream_branch_was_deleted_falls_back_to_bare_pull() {
        let (_guard, base, origin_s, url) = seeded_origin("upstream-deleted").await;
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // The branch goes away on the remote, as a merged-and-deleted PR head does.
        run(&origin_s, &["update-ref", "-d", "refs/heads/main"]).await;
        assert!(
            !head_of(&clone_s, "refs/remotes/origin/main").await.is_empty(),
            "the clone still holds a tracking ref, which is what makes this silent"
        );

        let state = AppState::default();
        let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
            .await
            .expect_err("a branch that no longer exists upstream cannot be pulled");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}");
        };
        assert!(
            stderr.contains("no such ref was fetched"),
            "bare pull's own refusal must reach the user: {stderr}"
        );
        assert!(
            run_git(
                Some(&clone_s),
                &["rev-parse", "--verify", "refs/remotes/origin/main"],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .is_err(),
            "and the guard's fetch pruned the stale tracking ref on its way out"
        );
    }

    /// git's refusal wording for a dirty-tree rebase, which `isDirtyTreeRefusal`
    /// (src/lib/error-summary.ts) matches to offer the stash-and-retry recovery.
    /// The explicit rebase says "cannot rebase" where bare pull said "cannot pull
    /// with rebase" — both are in that list, and this is what keeps them there.
    /// Twin of `refusal_stderr_still_matches_the_frontend_markers` (autostash.rs).
    const REBASE_UNSTAGED: &str = "cannot rebase: you have unstaged changes";
    const REBASE_STAGED: &str = "cannot rebase: your index contains uncommitted changes";

    /// A clone one commit behind its upstream, with a dirty TRACKED file the
    /// upstream's commit does not touch. Non-overlapping on purpose: rebase
    /// refuses on any dirty tracked file, so the refusal arm still fires, while an
    /// autostash arm can reapply cleanly instead of conflicting on the same lines.
    /// Returns the guard and the clone's path.
    async fn behind_clone_with_dirty_tree(tag: &str) -> (tempfile::TempDir, String) {
        let (guard, base, _origin_s, url) = seeded_origin(tag).await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // A second tracked file, published BEFORE the clone so the clone has one
        // to dirty that the upstream commit below leaves alone.
        std::fs::write(work.join("b.txt"), "b\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "add b"]).await;
        run(&work_s, &["push", "-q"]).await;

        run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"]).await;
        let clone = base.join("clone");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
        run(&work_s, &["push", "-q"]).await;

        std::fs::write(clone.join("b.txt"), "dirty\n").unwrap();
        (guard, clone_s)
    }

    #[tokio::test]
    async fn a_guarded_rebase_pull_still_refuses_a_dirty_tree_recoverably() {
        let (_guard, clone_s) = behind_clone_with_dirty_tree("dirty-refusal").await;
        // Both autostash keys off, pinned locally so the machine's own git config
        // can't decide this test's outcome. `pull.autoStash` stays unset, which is
        // the arm that passes NO flag and lets `rebase.autoStash` govern.
        run(&clone_s, &["config", "rebase.autoStash", "false"]).await;

        let state = AppState::default();
        for (stage, marker) in [(false, REBASE_UNSTAGED), (true, REBASE_STAGED)] {
            if stage {
                run(&clone_s, &["add", "b.txt"]).await;
            }
            let err = git_pull_core(&state, clone_s.clone(), "rebase".into())
                .await
                .expect_err("git must not clobber uncommitted work");
            let AppError::Git { stderr, .. } = &err else {
                panic!("expected a plain git error, got {err:?}");
            };
            assert!(
                stderr.to_lowercase().contains(marker),
                "git no longer emits {marker:?} — the frontend's stash-and-retry recovery is \
                 now blind to this refusal. Actual stderr:\n{stderr}"
            );
        }
    }

    /// Bare `git pull --rebase` honors `pull.autoStash`, and falls back to
    /// `rebase.autoStash` when it is unset. The guarded pull replaced that one
    /// command with a fetch plus a rebase, so it has to translate the first key
    /// (a bare rebase ignores it) and stay out of the way of the second.
    #[tokio::test]
    async fn a_guarded_rebase_pull_honors_the_autostash_config() {
        for (tag, key) in [("autostash-pull", "pull.autoStash"), ("autostash-rebase", "rebase.autoStash")] {
            let (_guard, clone_s) = behind_clone_with_dirty_tree(tag).await;
            run(&clone_s, &["config", key, "true"]).await;

            let state = AppState::default();
            git_pull_core(&state, clone_s.clone(), "rebase".into())
                .await
                .unwrap_or_else(|e| panic!("{key}=true must let the pull through: {e}"));

            assert_eq!(
                head_of(&clone_s, "HEAD").await,
                head_of(&clone_s, "refs/remotes/origin/main").await,
                "{key}: the pull landed"
            );
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&clone_s).join("b.txt")).unwrap(),
                "dirty\n",
                "{key}: and git put the uncommitted change back"
            );
            assert_eq!(
                std::fs::read_to_string(std::path::Path::new(&clone_s).join("a.txt")).unwrap(),
                "upstream\n",
                "{key}: with the upstream's own change applied under it"
            );
            assert!(
                run(&clone_s, &["stash", "list"]).await.trim().is_empty(),
                "{key}: the autostash entry is not left behind"
            );
        }
    }

    /// A merge-mode pull runs its own `git merge` rather than `git pull`, so it has
    /// to spell pull's own merge subject — the line the user reads in their history,
    /// and the one place git's URL rendering (a stripped trailing `.git`, anonymized
    /// credentials) and its `into <branch>` rule show through. Compared against a
    /// real bare pull in a twin clone, so no wording is asserted from memory.
    #[tokio::test]
    async fn a_merge_mode_pull_writes_bare_pulls_merge_subject() {
        let (_guard, base, _origin_s, url) = seeded_origin("merge-subject").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        let mut clones = Vec::new();
        for name in ["guarded", "bare"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
            // A local commit on a file upstream never touches: the branch has to have
            // DIVERGED, since a fast-forward writes no merge commit to compare.
            std::fs::write(base.join(name).join("mine.txt"), "mine\n").unwrap();
            run(&c, &["add", "-A"]).await;
            run(&c, &["commit", "-qm", "my local work"]).await;
            clones.push(c);
        }

        std::fs::write(work.join("a.txt"), "upstream\n").unwrap();
        run(&work_s, &["commit", "-qam", "upstream moves on"]).await;
        run(&work_s, &["push", "-q"]).await;

        let state = AppState::default();
        git_pull_core(&state, clones[0].clone(), "merge".into())
            .await
            .expect("a non-overlapping divergence merges cleanly");
        run(&clones[1], &["pull", "--no-rebase", "-q"]).await;

        let ours = subjects(&clones[0]).await.first().cloned().unwrap();
        let theirs = subjects(&clones[1]).await.first().cloned().unwrap();
        assert_eq!(ours, theirs, "the merge subject must be pull's own");
        assert!(
            ours.starts_with("Merge branch 'main' of "),
            "and it names the upstream branch it merged: {ours}"
        );
    }

    // --- Pure arg-building for a named-branch push. ---

    /// The upstream a decision-table row tracks: `""` is none, else that branch.
    fn up(name: &str) -> Upstream {
        if name.is_empty() {
            Upstream::Untracked
        } else {
            Upstream::Branch(name.to_string())
        }
    }

    #[test]
    fn push_untracked_publishes_with_upstream() {
        // Empty upstream → first-time publish + track.
        assert_eq!(
            build_push_args_today("feature", &up(""), "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_gone_upstream_publishes_with_upstream() {
        // A deleted upstream ref (still named by %(upstream:remoteref)) republishes.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                true,
                false,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_tracked_same_name_plain_push() {
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_tracked_different_name_uses_refspec() {
        // Local `feature` tracks `origin/feat` → explicit refspec so we advance
        // the right remote ref, not `origin/feature`.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_tracked_non_origin_default_targets_own_remote() {
        // No requested remote + a branch tracking a fork's `upstream/main` targets
        // its OWN remote: T == remotename → the refspec-to-`up` arm.
        assert_eq!(
            build_push_args_today(
                "main",
                &up("main"),
                "upstream",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "upstream", "refs/heads/main:refs/heads/main"]
        );
    }

    #[test]
    fn push_requested_remote_matches_tracked_remote() {
        // Explicitly requesting the branch's OWN tracked remote is the same arm:
        // T == remotename → advance the tracked remote-branch name explicitly.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                Some("origin"),
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_requested_remote_differs_from_tracked_remote() {
        // A tracked-on-origin branch pushed explicitly to `upstream` → a copy under
        // the LOCAL name, no `-u`, upstream config untouched.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                Some("upstream"),
                None
            ),
            vec!["push", "upstream", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_requested_remote_on_untracked_publish() {
        // Publishing an untracked branch to a chosen remote: `-u <remote>` under
        // the local name.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up(""),
                "",
                false,
                false,
                false,
                Some("fork"),
                None
            ),
            vec![
                "push",
                "-u",
                "fork",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_set_upstream_forces_upstream_form_even_when_tracked() {
        // An explicit set_upstream request retracks even a tracked branch.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                false,
                true,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_args() {
        // The force pair sits right after `push`, before the refspec.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                true,
                None,
                None
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "origin",
                "refs/heads/feature:refs/heads/feat"
            ]
        );
        assert_eq!(
            build_push_args_today("feature", &up(""), "", false, false, true, None, None),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_on_requested_remote() {
        // Force + a requested non-tracked remote: the force pair still sits right
        // after `push`, then the bare remote, then the fully-qualified refspec.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                true,
                Some("upstream"),
                None
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "upstream",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn unknown_push_option_matches_gits_phrasings_only() {
        assert!(is_unknown_push_option("error: unknown option `force-if-includes'"));
        assert!(is_unknown_push_option(
            "fatal: unknown switch `force-if-includes'"
        ));
        assert!(is_unknown_push_option(
            "usage: git push [<options>] [<repository> [<refspec>...]]"
        ));
        // A real rejection must NOT trigger the pre-2.30 retry.
        assert!(!is_unknown_push_option(
            " ! [rejected]        feature -> feature (stale info)\nerror: failed to push some refs to 'C:/temp/remote.git'"
        ));
    }

    #[test]
    fn strip_removes_only_the_if_includes_flag() {
        assert_eq!(
            without_force_if_includes(&[
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature",
            ]),
            vec![
                "push",
                "--force-with-lease",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
        // Nothing to strip: the argv survives untouched.
        assert_eq!(
            without_force_if_includes(&["push", "-u", "origin", "HEAD"]),
            vec!["push", "-u", "origin", "HEAD"]
        );
    }

    #[test]
    fn named_push_policy_agrees_with_every_destination_arm() {
        use Upstream::{Branch, NotABranch, Untracked};

        let cases = [
            (
                "default remote", Branch("main".into()), "origin", false, false, None, None,
                Some("main"), Some("main"), vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit equal remote", Branch("main".into()), "origin", false, false,
                Some("origin"), None, Some("main"), Some("main"),
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "same name", Branch("x".into()), "origin", false, false, None, None,
                Some("x"), None, vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "gone", Branch("main".into()), "origin", true, false, None, None,
                None, None, vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "publish", Branch("main".into()), "origin", false, true, None, None,
                None, None, vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "different remote", Branch("main".into()), "upstream", false, false,
                Some("origin"), None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "untracked", Untracked, "", false, false, None, None, None, None,
                vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "non-branch", NotABranch, "origin", false, false, None, None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "gone non-branch", NotABranch, "origin", true, false, None, None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "publish non-branch", NotABranch, "origin", false, true, None, None, None, None,
                vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "local upstream", Branch("main".into()), ".", false, false, None, None,
                Some("main"), None, vec!["push", ".", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit destination", Branch("main".into()), "origin", false, false,
                Some("origin"), Some("main"), None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit destination overrides publish", Branch("main".into()), "origin",
                true, true, Some("origin"), Some("main"), None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
        ];
        for (label, upstream, remote, gone, set, requested, destination, tracked, refuse, argv)
            in cases
        {
            let actual =
                tracked_push_upstream(&upstream, remote, gone, set, requested, None, destination);
            assert_eq!(actual, tracked, "{label}");
            assert_eq!(
                cross_name_refusal(
                    "x",
                    &upstream,
                    remote,
                    gone,
                    set,
                    requested,
                    None,
                    destination
                ),
                refuse,
                "{label}",
            );
            assert_eq!(
                build_push_args_today(
                    "x",
                    &upstream,
                    remote,
                    gone,
                    set,
                    false,
                    requested,
                    destination
                ),
                argv,
                "{label}",
            );
        }
    }

    #[tokio::test]
    async fn named_push_refuses_cross_name_upstream_but_follow_keeps_destination() {
        let (_guard, base, origin, _url) = seeded_origin("named-push-policy").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "x", "origin/main"]).await;
        run(&work, &["commit", "-qm", "on x", "--allow-empty"]).await;
        let old_main = run(&origin, &["rev-parse", "refs/heads/main"]).await;
        let tip = run(&work, &["rev-parse", "refs/heads/x"]).await;
        assert_ne!(old_main, tip);
        let state = AppState::default();

        for remote in [None, Some("origin".to_string())] {
            let result = git_push_same_name_core(
                &state,
                work.clone(),
                false,
                Some("x".into()),
                remote,
            )
            .await;
            let main = run(&origin, &["rev-parse", "refs/heads/main"]).await;
            assert!(result.is_err(), "named push must refuse a cross-name upstream");
            assert_eq!(main, old_main);
            let err = result.unwrap_err();
            assert!(
                matches!(
                    &err,
                    AppError::PushUpstreamNameMismatch { branch, remote, remote_branch }
                        if branch == "x" && remote == "origin" && remote_branch == "main"
                ),
                "{err:?}",
            );
        }

        git_push_core_unpinned(&state, work, false, false, Some("x".into()), None, None)
            .await
            .expect("Follow pushes to the tracked destination");
        assert_eq!(run(&origin, &["rev-parse", "refs/heads/main"]).await, tip);
    }

    /// Set up a bare origin seeded with one commit on `main`, and return the temp
    /// guard, the base dir, and the origin's path plus its `file://` URL. The work
    /// repo pins `remote.origin.mirror=false` and `remote.pushDefault=origin` locally,
    /// so a hostile global config can't turn its pushes into mirror pushes or route
    /// them elsewhere.
    async fn seeded_origin(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        seeded_origin_pinned(tag, true).await
    }

    /// [`seeded_origin`] without the `remote.pushDefault` pin, for tests that assert
    /// that key starts absent locally; a global `remote.pushDefault` stays out of reach.
    async fn seeded_origin_unpinned_push_default(
        tag: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        seeded_origin_pinned(tag, false).await
    }

    async fn seeded_origin_pinned(
        tag: &str,
        pin_push_default: bool,
    ) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        let (guard, base) = temp_base(tag);
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let base_s = base.to_string_lossy().into_owned();
        let work_s = work.to_string_lossy().into_owned();
        let url = format!("file://{}", origin.to_string_lossy().replace('\\', "/"));

        run(&base_s, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        init_repo(&work_s, "a.txt").await;
        run(&work_s, &["branch", "-M", "main"]).await;
        run(&work_s, &["remote", "add", "origin", &url]).await;
        run(&work_s, &["config", "remote.origin.mirror", "false"]).await;
        if pin_push_default {
            run(&work_s, &["config", "remote.pushDefault", "origin"]).await;
        }
        run(&work_s, &["push", "-q", "-u", "origin", "main"]).await;
        (guard, base, origin.to_string_lossy().into_owned(), url)
    }

    /// Reads `key` in `repo` with a hostile global config file pointed at by
    /// `GIT_CONFIG_GLOBAL` on this one spawn; `local` restricts it to the repo's own file.
    async fn config_under_hostile_global(
        repo: &str,
        global: &str,
        key: &str,
        local: bool,
    ) -> crate::git::runner::GitOutput {
        let mut args = vec!["config"];
        if local {
            args.push("--local");
        }
        args.extend(["--get", key]);
        crate::git::runner::run_git_raw_env(
            Some(repo),
            &args,
            &[("GIT_CONFIG_GLOBAL", global)],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn seeded_origin_holds_under_a_hostile_global_config() {
        let (_g, scratch) = temp_base("hostile-global");
        let global = scratch.join("hostile.gitconfig");
        std::fs::write(
            &global,
            "[remote \"origin\"]\n\tmirror = true\n[remote]\n\tpushDefault = elsewhere\n",
        )
        .unwrap();
        let global = global.to_string_lossy().into_owned();
        let read =
            |out: crate::git::runner::GitOutput| (out.code, out.stdout_lossy().trim().to_string());
        // The hostile file is live: a repo without the pins reads its values.
        let control_dir = scratch.join("control");
        run(&scratch.to_string_lossy(), &["init", "-q", "control"]).await;
        let control = control_dir.to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&control, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "true".into()), "control");

        let (_guard, base, _origin, _url) = seeded_origin("hostile-pinned").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&work, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "false".into()));
        let push = config_under_hostile_global(&work, &global, "remote.pushDefault", false);
        assert_eq!(read(push.await), (0, "origin".into()));

        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("hostile-unpinned").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&work, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "false".into()));
        let local_push = config_under_hostile_global(&work, &global, "remote.pushDefault", true);
        assert_eq!(read(local_push.await).0, 1, "no local remote.pushDefault");
    }

    #[test]
    fn upstream_is_remote_default_table() {
        let full = "refs/remotes/origin/mirror/main";
        for (target, upstream, want) in [
            (None, full, None),
            (Some(""), full, None),
            (Some(full), full, Some(true)),
            (Some("refs/remotes/origin/main"), full, Some(false)),
            (Some(full), "", None),
        ] {
            assert_eq!(
                super::upstream_is_remote_default(target, upstream),
                want,
                "{target:?} vs {upstream:?}"
            );
        }
    }

    #[tokio::test]
    async fn head_push_refuses_session_publish_in_core() {
        let (_guard, base, _origin, _url) = seeded_origin("session-publish").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "GD/Session/Mixed"]).await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        let state = AppState::default();
        for (set_upstream, force, mcp_core) in [
            (true, false, false),
            (false, false, false),
            (false, true, false),
            (false, true, true),
        ] {
            let result = if mcp_core {
                super::git_force_push_head_core(&state, work.clone())
                    .await
                    .map(super::PushGuardWire::from)
            } else {
                git_push_core_unpinned(&state, work.clone(), set_upstream, force, None, None, None)
                    .await
            };
            match result.expect_err("session HEAD must not publish") {
                e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                    e.to_string(),
                    "\"GD/Session/Mixed\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it."
                ),
                other => panic!("expected the publishing refusal, got {other:?}"),
            }
            assert!(!run(&work, &["ls-remote", "origin"])
                .await
                .to_ascii_lowercase()
                .contains("gd/session/"));
        }
    }

    #[tokio::test]
    async fn named_push_refuses_session_publish_in_core() {
        let (_guard, base, _origin, _url) = seeded_origin("session-publish-named").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "gd/session/abc"]).await;
        let error = git_push_core_unpinned(
            &AppState::default(),
            work.clone(),
            true,
            false,
            Some("gd/session/abc".into()),
            None,
            None,
        )
        .await
        .expect_err("named session branch must not publish");
        match error {
            e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                e.to_string(),
                "\"gd/session/abc\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it."
            ),
            other => panic!("expected the publishing refusal, got {other:?}"),
        }
        assert!(!run(&work, &["ls-remote", "origin"])
            .await
            .to_ascii_lowercase()
            .contains("gd/session/"));
    }

    /// A work repo pinned against a hostile global config, with a local bare `origin`
    /// holding `main` and `feat/x` (tracked), HEAD on `feat/x` one commit ahead of it.
    /// Returns (guard, work, origin).
    async fn keep_local_origin(tag: &str) -> (tempfile::TempDir, String, String) {
        let (guard, base) = temp_base(tag);
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        let origin = base.join("origin.git").to_string_lossy().replace('\\', "/");
        run(
            &base_s,
            &["init", "-q", "--bare", "-b", "main", "origin.git"],
        )
        .await;
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "true"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        run(&work, &["remote", "add", "origin", &origin]).await;
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        run(&work, &["config", "remote.pushDefault", "origin"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(&work, &["push", "-q", "-u", "origin", "main"]).await;
        run(&work, &["switch", "-q", "-c", "feat/x"]).await;
        run(&work, &["push", "-q", "-u", "origin", "feat/x"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        (guard, work, origin)
    }

    fn assert_kept_local(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        branch: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            AppError::BranchKeptLocal { branch: b } => assert_eq!(b, branch, "{row}"),
            other => panic!("{row}: expected the Keep local refusal, got {other:?}"),
        }
    }

    /// The guard reads git's own bool, failing closed: marked spellings refuse, unmarked
    /// ones pass, a junk value is an error, the key is case-sensitive, and the session
    /// prefix answers first, before any spawn.
    #[tokio::test]
    async fn keep_local_guard_reads_every_flag_spelling() {
        let (_guard, work, _origin) = keep_local_origin("keep-local-spellings").await;
        let config = std::path::Path::new(&work).join(".git").join("config");
        let set = |values: &[&str]| {
            let _ = std::process::Command::new("git")
                .test_git_env()
                .current_dir(&work)
                .args([
                    "config",
                    "--unset-all",
                    "branch.rel/1.2.gitdesktopLocalOnly",
                ])
                .output();
            for v in values {
                let mut text = std::fs::read_to_string(&config).unwrap();
                match *v {
                    "<valueless>" => text.push_str("[branch \"rel/1.2\"]\n\tgitdesktopLocalOnly\n"),
                    _ => text.push_str(&format!(
                        "[branch \"rel/1.2\"]\n\tgitdesktopLocalOnly = {v}\n"
                    )),
                }
                std::fs::write(&config, text).unwrap();
            }
        };
        for values in [
            &["true"][..],
            &["<valueless>"],
            &["yes"],
            &["false", "true"],
        ] {
            set(values);
            assert_kept_local(
                super::refuse_publishing_branch(&work, "rel/1.2").await,
                "rel/1.2",
                &format!("{values:?}"),
            );
        }
        for values in [&[][..], &["false"], &["\"\""], &["0"], &["true", "false"]] {
            set(values);
            super::refuse_publishing_branch(&work, "rel/1.2")
                .await
                .unwrap_or_else(|e| panic!("{values:?} must read unmarked: {e:?}"));
        }
        // A junk value anywhere on the key makes git refuse the read, so the guard refuses
        // with git's own error, even when the last value is a valid bool.
        for values in [&["maybe"][..], &["maybe", "true"], &["maybe", "false"]] {
            set(values);
            match super::refuse_publishing_branch(&work, "rel/1.2").await {
                Err(AppError::Git { stderr, .. }) => {
                    assert!(
                        stderr.contains("bad boolean config value"),
                        "{values:?}: {stderr}"
                    )
                }
                other => panic!("{values:?}: expected git's refusal, got {other:?}"),
            }
        }
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        // A case variant git reads as the marked loose ref refuses under the stored name,
        // only where the store's names can alias.
        let variant = super::refuse_publishing_branch(&work, "Feat/X").await;
        if crate::git::branches::refs_can_alias(&work).await {
            match variant {
                Err(AppError::BranchKeptLocal { branch }) => assert_eq!(branch, "feat/x"),
                other => panic!("a folding store refuses the variant: {other:?}"),
            }
        } else {
            variant.expect("a case-sensitive store refuses only the marked spelling");
        }
        super::refuse_publishing_branch(&work, "no/such/branch")
            .await
            .expect("a name with no ref answers Ok");
        match super::refuse_publishing_branch("C:/gd-no-such-repo", "gd/session/x").await {
            Err(AppError::BranchIsAgentSession { branch }) => assert_eq!(branch, "gd/session/x"),
            other => panic!("expected the session refusal, got {other:?}"),
        }
        let outside = tempfile::tempdir().unwrap();
        let outside_s = outside.path().to_string_lossy().into_owned();
        assert!(
            super::refuse_publishing_branch(&outside_s, "feat/x")
                .await
                .is_err(),
            "outside a repository the spelling read errs, so a non-session name refuses"
        );
    }

    /// Every GUI push arm refuses a marked branch before git runs and lands nothing; with
    /// the mark off, the same push lands.
    #[tokio::test]
    async fn keep_local_refuses_every_push_arm_and_the_unmarked_twin_lands() {
        let (_guard, work, origin) = keep_local_origin("keep-local-arms").await;
        let state = AppState::default();
        let published = run(&origin, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string();
        let some = |s: &str| Some(s.to_string());
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        for (row, set_upstream, force, branch, remote, remote_branch) in [
            ("HEAD bare", false, false, None, None, None),
            ("HEAD forced", false, true, None, None, None),
            ("HEAD -u", true, false, None, None, None),
            ("named", false, false, some("feat/x"), None, None),
            (
                "named + remote",
                false,
                false,
                some("feat/x"),
                some("origin"),
                None,
            ),
            (
                "named + remote branch",
                true,
                false,
                some("feat/x"),
                some("origin"),
                some("other"),
            ),
        ] {
            let result = git_push_core_unpinned(
                &state,
                work.clone(),
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
            )
            .await;
            assert_kept_local(result, "feat/x", row);
        }
        assert_kept_local(
            super::git_force_push_head_core(&state, work.clone()).await,
            "feat/x",
            "MCP force core",
        );
        assert_kept_local(
            git_push_same_name_core(&state, work.clone(), false, Some("feat/x".into()), None).await,
            "feat/x",
            "MCP named core",
        );
        // The remote default, marked and pushed by name from another branch.
        crate::git::branches::set_branch_keep_local_core(&work, "main", true)
            .await
            .unwrap();
        assert_kept_local(
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("main".into()),
                None,
                None,
            )
            .await,
            "main",
            "remote default",
        );
        let refs = run(&work, &["ls-remote", "origin"]).await;
        assert!(
            refs.contains(&format!("{published}\trefs/heads/feat/x")),
            "{refs}"
        );
        assert!(!refs.contains("refs/heads/other"), "{refs}");

        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false)
            .await
            .unwrap();
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("the unmarked twin lands");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/feat/x"]).await,
            run(&work, &["rev-parse", "refs/heads/feat/x"]).await
        );
    }

    /// Keep local does not reach remote-branch delete: a marked branch's remote copy is
    /// deleted.
    #[tokio::test]
    async fn keep_local_leaves_remote_branch_delete_allowed() {
        let (_guard, work, _origin) = keep_local_origin("keep-local-delete").await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        crate::git::branches::git_delete_remote_branch_core(
            &AppState::default(),
            work.clone(),
            "origin".into(),
            "feat/x".into(),
        )
        .await
        .expect("the remote copy of a marked branch can be deleted");
        assert!(!run(&work, &["ls-remote", "origin"])
            .await
            .contains("refs/heads/feat/x"));
    }

    /// A bare or forced HEAD push pressed on an unmarked branch re-reads the mark at spawn:
    /// a switch to a marked branch during the lock wait refuses, and nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_queued_head_push_rechecks_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, origin) = keep_local_origin("keep-local-queued").await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        let published = run(&origin, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string();
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "feat/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_kept_local(result, "feat/x", &format!("force={force}"));
            let pushed = run(&work, &["ls-remote", "origin"]).await;
            assert!(!pushed.contains("pressed"), "force={force}: {pushed}");
            assert!(
                pushed.contains(&format!("{published}\trefs/heads/feat/x")),
                "force={force}: {pushed}"
            );
        }
    }

    /// A marked HEAD is refused by the early check, before the network lock: with the
    /// domain held, a bare and a forced push return the refusal without ever queueing.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_early_head_check_refuses_before_the_network_lock() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, _origin) = keep_local_origin("keep-local-early").await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work).await;
        let _held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");
        for force in [false, true] {
            let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let queued = std::sync::Arc::clone(&queued);
                move || queued.store(true, std::sync::atomic::Ordering::SeqCst)
            });
            let (state, work) = (std::sync::Arc::clone(&state), work.clone());
            let push = async move {
                if force {
                    super::git_force_push_head_core(&state, work)
                        .await
                        .map(super::PushGuardWire::from)
                } else {
                    git_push_core_unpinned(&state, work, false, false, None, None, None).await
                }
            };
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                NETWORK_LOCK_WAIT_HOOK.scope(hook, push),
            )
            .await
            .unwrap_or_else(|_| panic!("force={force}: the refusal waited on the held lock"));
            assert_kept_local(result, "feat/x", &format!("force={force}"));
            assert!(
                !queued.load(std::sync::atomic::Ordering::SeqCst),
                "force={force}: the push reached the network lock"
            );
        }
    }

    /// A push pinned to a branch (named, a named publish, a HEAD publish pinned to its
    /// branch) re-reads the mark at spawn: a mark set while it waits on the network lock
    /// refuses and nothing lands; with no mark set, the same push lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_pinned_push_rechecks_the_mark_at_spawn() {
        let (_guard, work, origin) = keep_local_origin("keep-local-pinned").await;
        let state = AppState::default();
        let tip = |repo: String| async move {
            run(&repo, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim()
                .to_string()
        };
        for (row, set_upstream, branch, remote) in [
            ("named", false, Some("feat/x"), None),
            ("named publish", true, Some("feat/x"), Some("origin")),
            ("pinned HEAD publish", true, None, None),
        ] {
            run(&work, &["commit", "-q", "--allow-empty", "-m", row]).await;
            let published = tip(origin.clone()).await;
            for mark in [true, false] {
                let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                    let (fired, work) = (std::sync::Arc::clone(&fired), work.clone());
                    move || {
                        fired.store(true, std::sync::atomic::Ordering::SeqCst);
                        if mark {
                            let key = crate::git::branches::keep_local_key("feat/x");
                            let set = std::process::Command::new("git")
                                .test_git_env()
                                .current_dir(&work)
                                .args(["config", &key, "true"])
                                .status()
                                .unwrap();
                            assert!(set.success(), "the mark is set during the wait");
                        }
                    }
                });
                let push = git_push_core_unpinned(
                    &state,
                    work.clone(),
                    set_upstream,
                    false,
                    branch.map(str::to_string),
                    remote.map(str::to_string),
                    None,
                );
                let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
                let row = format!("{row}, mark={mark}");
                assert!(fired.load(std::sync::atomic::Ordering::SeqCst), "{row}");
                if mark {
                    assert_kept_local(result, "feat/x", &row);
                    assert_eq!(tip(origin.clone()).await, published, "{row}");
                    crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false)
                        .await
                        .unwrap();
                } else {
                    result.unwrap_or_else(|e| panic!("{row}: the unmarked twin lands: {e:?}"));
                    assert_eq!(tip(origin.clone()).await, tip(work.clone()).await, "{row}");
                }
            }
        }
    }

    /// The ambient-credential retry spawns the push again, so it re-reads the mark first:
    /// a mark set while the injected run is rejected refuses the retry, and nothing
    /// lands. The rejection is a pre-push hook in the injected config only.
    #[tokio::test]
    async fn keep_local_ambient_retry_rechecks_the_mark() {
        let (_guard, work, origin) = keep_local_origin("keep-local-ambient").await;
        let (marking, rejecting) = auth_rejecting_hooks(&work);
        let tip = |repo: String| async move { feat_x_tip(&repo).await };
        let published = tip(origin.clone()).await;
        let argv = ["push", "origin", "feat/x"];
        let recheck = Some(super::SpawnRecheck::named("feat/x"));
        let result =
            super::run_git_with_creds_rechecked(&work, &marking, &argv, NETWORK_TIMEOUT, recheck)
                .await;
        assert_kept_local(
            result.map(|out| out.code),
            "feat/x",
            "marked before the retry",
        );
        assert_eq!(tip(origin.clone()).await, published);

        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false)
            .await
            .unwrap();
        let out =
            super::run_git_with_creds_rechecked(&work, &rejecting, &argv, NETWORK_TIMEOUT, recheck)
                .await
                .unwrap();
        assert_eq!(out.code, 0, "ambient retry: {}", out.full_failure_text());
        assert_eq!(tip(origin.clone()).await, tip(work.clone()).await);
    }

    /// `feat/x`'s tip in `repo`.
    async fn feat_x_tip(repo: &str) -> String {
        run(repo, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string()
    }

    /// Injected-credential configs whose pre-push hook fakes an auth rejection, so only
    /// the ambient retry (which drops them) can push: (marking, rejecting), the first also
    /// marking `feat/x` Keep local before it rejects. Each lives beside `work`.
    fn auth_rejecting_hooks(work: &str) -> (Vec<String>, Vec<String>) {
        let hooks = |name: &str, body: &str| {
            let dir = std::path::Path::new(work).with_file_name(name);
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("pre-push");
            std::fs::write(&file, body).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            vec![format!(
                "core.hooksPath={}",
                dir.to_string_lossy().replace('\\', "/")
            )]
        };
        let reject = "echo 'fatal: Authentication failed for origin' >&2\nexit 1\n";
        let marking = hooks(
            "reject-and-mark",
            &format!("#!/bin/sh\ngit config branch.feat/x.gitdesktopLocalOnly true\n{reject}"),
        );
        let rejecting = hooks("reject", &format!("#!/bin/sh\n{reject}"));
        (marking, rejecting)
    }

    /// The branch runner re-reads the mark at both spawns: a mark set during the
    /// network-lock wait refuses the push, a mark set while the injected run is rejected
    /// refuses the ambient retry, and nothing lands; the unmarked twins land.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_branch_runner_rechecks_the_mark_at_spawn() {
        let (_guard, work, origin) = keep_local_origin("keep-local-branch-runner").await;
        let state = AppState::default();
        let argv = ["push", "origin", "feat/x"];
        let clear = || crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false);
        for mark in [true, false] {
            let row = format!("lock wait, mark={mark}");
            run(&work, &["commit", "-q", "--allow-empty", "-m", &row]).await;
            let published = feat_x_tip(&origin).await;
            let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let (fired, work) = (std::sync::Arc::clone(&fired), work.clone());
                move || {
                    fired.store(true, std::sync::atomic::Ordering::SeqCst);
                    if mark {
                        let key = crate::git::branches::keep_local_key("feat/x");
                        let set = std::process::Command::new("git")
                            .test_git_env()
                            .current_dir(&work)
                            .args(["config", &key, "true"])
                            .status()
                            .unwrap();
                        assert!(set.success(), "the mark is set during the wait");
                    }
                }
            });
            let push = super::run_git_mutating_with_creds_for_branch(
                &state,
                &work,
                &[],
                &argv,
                NETWORK_TIMEOUT,
                "feat/x",
            );
            let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
            assert!(fired.load(std::sync::atomic::Ordering::SeqCst), "{row}");
            if mark {
                assert_kept_local(result.map(|out| out.code), "feat/x", &row);
                assert_eq!(feat_x_tip(&origin).await, published, "{row}");
                clear().await.unwrap();
            } else {
                result.unwrap_or_else(|e| panic!("{row}: the unmarked twin lands: {e:?}"));
                assert_eq!(feat_x_tip(&origin).await, feat_x_tip(&work).await, "{row}");
            }
        }

        let (marking, rejecting) = auth_rejecting_hooks(&work);
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ambient"]).await;
        let published = feat_x_tip(&origin).await;
        let result = super::run_git_mutating_with_creds_for_branch(
            &state,
            &work,
            &marking,
            &argv,
            NETWORK_TIMEOUT,
            "feat/x",
        )
        .await;
        assert_kept_local(
            result.map(|out| out.code),
            "feat/x",
            "marked before the retry",
        );
        assert_eq!(feat_x_tip(&origin).await, published);
        clear().await.unwrap();
        super::run_git_mutating_with_creds_for_branch(
            &state,
            &work,
            &rejecting,
            &argv,
            NETWORK_TIMEOUT,
            "feat/x",
        )
        .await
        .unwrap_or_else(|e| panic!("the unmarked ambient retry lands: {e:?}"));
        assert_eq!(feat_x_tip(&origin).await, feat_x_tip(&work).await);
    }

    /// The production text of a module: CRLF-normalized, cut before its `mod tests`.
    fn production_text(source: &str) -> String {
        let source = source.replace("\r\n", "\n");
        match source.split_once("\n#[cfg(test)]\nmod tests {") {
            Some((production, _)) => production.to_string(),
            None => source,
        }
    }

    /// Each column-0 fn in `text` (any visibility, async or not) with its body up to its
    /// column-0 close, comment lines dropped as `wiring_body` drops them.
    fn column0_fns(text: &str) -> Vec<(String, String)> {
        let mut fns = Vec::new();
        let mut offset = 0;
        for line in text.split_inclusive('\n') {
            let start = offset;
            offset += line.len();
            if line.starts_with(char::is_whitespace) || line.starts_with("//") {
                continue;
            }
            let Some(at) = line.find("fn ") else {
                continue;
            };
            if at > 0 && !line[..at].ends_with(' ') {
                continue;
            }
            let rest = &line[at + 3..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if name.is_empty() || !rest[name.len()..].starts_with(['(', '<']) {
                continue;
            }
            let body = text[start..]
                .split("\n}")
                .next()
                .unwrap()
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            fns.push((name, body));
        }
        fns
    }

    /// The final argument of each branch-runner call in `body`.
    fn branch_runner_finals(body: &str) -> Vec<String> {
        const CALL: &str = "run_git_mutating_with_creds_for_branch(";
        let mut finals = Vec::new();
        for (at, _) in body.match_indices(CALL) {
            let (mut depth, mut quoted, mut args, mut arg) = (0, false, Vec::new(), String::new());
            for c in body[at + CALL.len()..].chars() {
                match c {
                    '"' => quoted = !quoted,
                    '(' | '[' | '{' if !quoted => depth += 1,
                    ')' | ']' | '}' if !quoted && depth == 0 => break,
                    ')' | ']' | '}' if !quoted => depth -= 1,
                    ',' if !quoted && depth == 0 => {
                        args.push(std::mem::take(&mut arg));
                        continue;
                    }
                    _ => {}
                }
                arg.push(c);
            }
            args.push(arg);
            let last = args
                .into_iter()
                .map(|a| a.trim().to_string())
                .rfind(|a| !a.is_empty());
            finals.push(last.unwrap_or_default());
        }
        finals
    }

    /// R1 over one fn body: `count` branch-runner calls, each naming `branch` last, and
    /// no plain credentialed runner.
    fn roster_holds(body: &str, branch: &str, count: usize) -> bool {
        let finals = branch_runner_finals(body);
        finals.len() == count
            && finals.iter().all(|last| last == branch)
            && !body.contains("run_git_mutating_with_creds(")
    }

    /// R2's predicate: a body naming `"push"` that spawns through a runner which never
    /// re-reads a branch's refusal.
    fn pushes_unrechecked(body: &str) -> bool {
        body.contains("\"push\"")
            && (body.contains("run_git_mutating_with_creds(")
                || body.contains("run_git_with_creds_once("))
    }

    fn unrechecked_pushes(text: &str) -> Vec<String> {
        column0_fns(text)
            .into_iter()
            .filter(|(_, body)| pushes_unrechecked(body))
            .map(|(name, _)| name)
            .collect()
    }

    /// Every route that pushes a named branch spawns through the branch runner naming that
    /// branch, and every other fn pairing `"push"` with a plain credentialed runner is one
    /// of the four `EXEMPT` ref pushes no branch refusal governs, over the production text
    /// of each file that calls one. Out of reach: a push in a file outside this list, an
    /// argv built in a helper the scanned fn calls, and any indented fn (an impl-block
    /// method, or one in an inline module such as gitlab.rs's and bitbucket.rs's
    /// `mod my_work_tests`, which sits above `mod tests` and so inside the cut text).
    #[test]
    fn branch_pushes_rerun_the_publishing_refusal_at_spawn() {
        use crate::github::repo_meta::tests::wiring_body;
        const EXEMPT: [&str; 4] = [
            "git_push_tag_core",
            "git_delete_tag_core",
            "git_delete_remote_branch_core",
            "delete_remote_branch_leased",
        ];
        let ops = production_text(include_str!("ops.rs"));
        let pr = production_text(include_str!("../github/pr.rs"));
        let gitlab = production_text(include_str!("../forge/gitlab.rs"));
        let bitbucket = production_text(include_str!("../forge/bitbucket.rs"));
        let files = [
            ("ops.rs", ops.clone()),
            (
                "branches/config_repair.rs",
                production_text(include_str!("branches/config_repair.rs")),
            ),
            (
                "branches/create_checkout.rs",
                production_text(include_str!("branches/create_checkout.rs")),
            ),
            (
                "branches/default_branch.rs",
                production_text(include_str!("branches/default_branch.rs")),
            ),
            (
                "branches/delete.rs",
                production_text(include_str!("branches/delete.rs")),
            ),
            (
                "branches/divergence.rs",
                production_text(include_str!("branches/divergence.rs")),
            ),
            (
                "branches/in_use.rs",
                production_text(include_str!("branches/in_use.rs")),
            ),
            (
                "branches/listing.rs",
                production_text(include_str!("branches/listing.rs")),
            ),
            (
                "branches/marks.rs",
                production_text(include_str!("branches/marks.rs")),
            ),
            (
                "branches/mod.rs",
                production_text(include_str!("branches/mod.rs")),
            ),
            (
                "branches/names.rs",
                production_text(include_str!("branches/names.rs")),
            ),
            (
                "branches/refs.rs",
                production_text(include_str!("branches/refs.rs")),
            ),
            (
                "branches/remote_branch.rs",
                production_text(include_str!("branches/remote_branch.rs")),
            ),
            (
                "branches/rename.rs",
                production_text(include_str!("branches/rename.rs")),
            ),
            (
                "branches/renamed_copy.rs",
                production_text(include_str!("branches/renamed_copy.rs")),
            ),
            (
                "branches/spelling.rs",
                production_text(include_str!("branches/spelling.rs")),
            ),
            (
                "branches/unpushed.rs",
                production_text(include_str!("branches/unpushed.rs")),
            ),
            (
                "branches/update.rs",
                production_text(include_str!("branches/update.rs")),
            ),
            (
                "branches/upstream_rewrite.rs",
                production_text(include_str!("branches/upstream_rewrite.rs")),
            ),
            ("remote.rs", production_text(include_str!("remote.rs"))),
            (
                "autostash.rs",
                production_text(include_str!("autostash.rs")),
            ),
            (
                "pr_checkout.rs",
                production_text(include_str!("pr_checkout.rs")),
            ),
            (
                "pull_guard.rs",
                production_text(include_str!("pull_guard.rs")),
            ),
            ("pr.rs", pr.clone()),
            ("gitlab.rs", gitlab.clone()),
            ("bitbucket.rs", bitbucket.clone()),
        ];
        let roster = [
            (&ops, "push_pr_head", "head", 1),
            (&pr, "gh_publish_push", "branch", 1),
            (&pr, "gh_pr_create_core", "&head", 2),
            (&gitlab, "publish_repo", "&branch", 1),
            (&gitlab, "create_mr", "head", 1),
            (&bitbucket, "create_pr", "head", 1),
            (&bitbucket, "publish_repo", "&branch", 1),
        ];
        for (text, name, branch, count) in roster {
            let body = wiring_body(text, name);
            assert!(roster_holds(&body, branch, count), "{name}:\n{body}");
        }
        // The branches/ entries must name every file in that folder, so a new seam cannot
        // escape the scan; this runs before the scan so a missed file is the first failure.
        let listed = |files: &[(&str, String)]| -> std::collections::BTreeSet<String> {
            files
                .iter()
                .filter_map(|(file, _)| file.strip_prefix("branches/"))
                .map(str::to_string)
                .collect()
        };
        let git_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/git");
        let mut on_disk = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(git_dir.join("branches")).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().into_string().unwrap();
            assert!(
                !entry.file_type().unwrap().is_dir(),
                "src/git/branches/{name} is a folder the roster cannot list"
            );
            if name.ends_with(".rs") {
                on_disk.insert(name);
            }
        }
        assert_eq!(
            listed(&files),
            on_disk,
            "the roster's branches/ entries differ from the files in src/git/branches"
        );
        // Each branches/ label must carry its own file's text, so a mislabeled include_str!
        // cannot hide the seam it should have read.
        let mislabeled = |files: &[(&str, String)]| -> Vec<String> {
            let mut wrong = Vec::new();
            for (file, text) in files {
                if file.starts_with("branches/") {
                    let disk = std::fs::read_to_string(git_dir.join(file)).unwrap();
                    if *text != production_text(&disk) {
                        wrong.push(file.to_string());
                    }
                }
            }
            wrong
        };
        let wrong = mislabeled(&files);
        assert!(
            wrong.is_empty(),
            "roster texts differ from their labels' files: {wrong:?}"
        );
        let flag = |files: &[(&str, String)]| {
            let mut flagged = Vec::new();
            for (file, text) in files {
                assert!(!column0_fns(text).is_empty(), "{file}: no fn read");
                flagged.extend(unrechecked_pushes(text));
            }
            flagged
        };
        let mut flagged = flag(&files);
        flagged.sort();
        let mut exempt = EXEMPT.map(str::to_string).to_vec();
        exempt.sort();
        assert_eq!(
            flagged, exempt,
            "only the exempt ref pushes take the plain runner"
        );

        // m1: the resolve push back on the plain runner reddens both scans.
        let m1 = ops.replace(
            "run_git_mutating_with_creds_for_branch(",
            "run_git_mutating_with_creds(",
        );
        assert_ne!(m1, ops, "m1 changed nothing");
        assert!(
            !roster_holds(&wiring_body(&m1, "push_pr_head"), "head", 1),
            "m1: R1"
        );
        assert!(
            unrechecked_pushes(&m1).contains(&"push_pr_head".to_string()),
            "m1: R2"
        );
        // m2: a PR create re-checking the base instead of the head.
        let body = wiring_body(&pr, "gh_pr_create_core");
        let m2 = body.replacen(
            "NETWORK_TIMEOUT,\n        &head,",
            "NETWORK_TIMEOUT,\n        &base,",
            1,
        );
        assert_ne!(m2, body, "m2 changed nothing");
        assert!(!roster_holds(&m2, "&head", 2), "m2: R1");
        // m3: a new push on the plain runner.
        let m3 =
            "async fn x() { run_git_mutating_with_creds(s, r, &[], &[\"push\", \"o\", \"b\"], T).await }";
        assert_eq!(unrechecked_pushes(m3), ["x"], "m3: R2");
        // m4: an exempt body alone reads as exempt.
        let m4 = format!("{}\n}}\n", wiring_body(&ops, "git_push_tag_core"));
        let m4_flagged = unrechecked_pushes(&m4);
        assert_eq!(m4_flagged, ["git_push_tag_core"], "m4");
        assert!(
            m4_flagged
                .iter()
                .all(|name| EXEMPT.contains(&name.as_str())),
            "m4"
        );
        // m5: a roster missing one branches/ file fails the set comparison.
        let m5: Vec<(&str, String)> = files
            .iter()
            .filter(|(file, _)| *file != "branches/update.rs")
            .cloned()
            .collect();
        assert_ne!(listed(&m5), on_disk, "m5");
        // m6: a plain-runner push planted in one seam's text is flagged.
        const PLANTED: &str =
            "\nasync fn planted() { run_git_mutating_with_creds(s, r, &[], &[\"push\", \"o\", \"b\"], T).await }\n";
        let mut m6 = files.clone();
        for (file, text) in &mut m6 {
            if *file == "branches/update.rs" {
                text.push_str(PLANTED);
            }
        }
        assert!(flag(&m6).contains(&"planted".to_string()), "m6");
        // m7: two seams' texts swapped under their labels are both reported.
        let at = |name: &str| files.iter().position(|(file, _)| *file == name).unwrap();
        let mut m7 = files.clone();
        let (update, refs) = (at("branches/update.rs"), at("branches/refs.rs"));
        let text = std::mem::take(&mut m7[update].1);
        m7[update].1 = std::mem::replace(&mut m7[refs].1, text);
        assert_eq!(
            mislabeled(&m7),
            ["branches/refs.rs", "branches/update.rs"],
            "m7"
        );
    }

    /// [`keep_local_origin`] plus a second bare remote, both pinned non-mirror, with
    /// `extra` on origin, a branch the clone lacks (a mirror push would delete it).
    /// Returns (guard, work, origin, second).
    async fn mirror_origin(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, work, origin) = keep_local_origin(tag).await;
        let second = guard
            .path()
            .join("second.git")
            .to_string_lossy()
            .replace('\\', "/");
        run(
            &guard.path().to_string_lossy(),
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        run(&work, &["remote", "add", "second", &second]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["push", "-q", "second", "main"]).await;
        run(&work, &["push", "-q", "origin", "main:refs/heads/extra"]).await;
        run(&work, &["update-ref", "-d", "refs/remotes/origin/extra"]).await;
        (guard, work, origin, second)
    }

    fn assert_mirror(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        remote: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            AppError::PushRemoteIsMirror { remote: r } => assert_eq!(r, remote, "{row}"),
            other => panic!("{row}: expected the mirror refusal, got {other:?}"),
        }
    }

    /// Every GUI and MCP push arm refuses a mirror remote before git runs, the remote's
    /// refs untouched (`extra` survives); a mirror on a remote the push doesn't use never
    /// refuses, and the push lands.
    #[tokio::test]
    async fn mirror_refusal_on_every_push_arm_and_the_twin_lands() {
        let (_guard, work, origin, second) = mirror_origin("mirror-arms").await;
        let state = AppState::default();
        let refs_before = run(&origin, &["for-each-ref"]).await;
        let some = |s: &str| Some(s.to_string());
        run(&work, &["config", "remote.origin.mirror", "true"]).await;
        for (row, set_upstream, force, branch, remote, remote_branch) in [
            ("HEAD bare", false, false, None, None, None),
            ("HEAD forced", false, true, None, None, None),
            ("HEAD -u", true, false, None, None, None),
            ("named", false, false, some("feat/x"), None, None),
            (
                "named + remote",
                false,
                false,
                some("feat/x"),
                some("origin"),
                None,
            ),
            (
                "named + remote branch",
                true,
                false,
                some("feat/x"),
                some("origin"),
                some("other"),
            ),
        ] {
            let result = git_push_core_unpinned(
                &state,
                work.clone(),
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
            )
            .await;
            assert_mirror(result, "origin", row);
        }
        assert_mirror(
            super::git_force_push_head_core(&state, work.clone()).await,
            "origin",
            "MCP force core",
        );
        assert_mirror(
            git_push_same_name_core(&state, work.clone(), false, Some("feat/x".into()), None).await,
            "origin",
            "MCP named core",
        );
        // A detached bare push routes by remote.pushDefault: a mirror there refuses.
        run(&work, &["config", "remote.second.mirror", "true"]).await;
        run(&work, &["config", "remote.pushDefault", "second"]).await;
        run(&work, &["switch", "-q", "--detach", "feat/x"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "second",
            "detached pushDefault",
        );
        run(&work, &["switch", "-q", "feat/x"]).await;
        run(&work, &["config", "remote.pushDefault", "origin"]).await;
        assert_eq!(run(&origin, &["for-each-ref"]).await, refs_before);
        assert!(!run(&second, &["for-each-ref"]).await.contains("feat/x"));

        // The twin: the mirror only on `second`, which this push doesn't use.
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        assert_mirror(
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                some("feat/x"),
                some("second"),
                None,
            )
            .await,
            "second",
            "named on the mirror second",
        );
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("a mirror on another remote doesn't refuse");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/feat/x"]).await,
            run(&work, &["rev-parse", "refs/heads/feat/x"]).await
        );
        assert!(run(&origin, &["for-each-ref"])
            .await
            .contains("refs/heads/extra"));
    }

    /// Remote-branch delete, tag push and tag delete refuse a mirror `origin` before git
    /// runs: the remote branch and tag stay, and the refused tag delete keeps the LOCAL
    /// tag. With the mirror off, each lands.
    #[tokio::test]
    async fn mirror_refusal_on_remote_delete_and_tag_routes() {
        let (_guard, work, origin, _second) = mirror_origin("mirror-delete-tags").await;
        let state = AppState::default();
        run(&work, &["tag", "v1"]).await;
        run(&work, &["push", "-q", "origin", "refs/tags/v1"]).await;
        run(&work, &["tag", "v2"]).await;
        run(&work, &["config", "remote.origin.mirror", "true"]).await;
        assert_mirror(
            crate::git::branches::git_delete_remote_branch_core(
                &state,
                work.clone(),
                "origin".into(),
                "extra".into(),
            )
            .await,
            "origin",
            "remote branch delete",
        );
        assert_mirror(
            crate::git::ops::git_push_tag_core(&state, work.clone(), "v2".into()).await,
            "origin",
            "tag push",
        );
        assert_mirror(
            crate::git::ops::git_delete_tag_core(&state, work.clone(), "v1".into(), true).await,
            "origin",
            "tag delete",
        );
        assert!(
            !run(&work, &["tag", "--list", "v1"]).await.trim().is_empty(),
            "the refused tag delete keeps the local tag"
        );
        let refs = run(&origin, &["for-each-ref"]).await;
        assert!(refs.contains("refs/heads/extra"), "{refs}");
        assert!(refs.contains("refs/tags/v1"), "{refs}");
        assert!(!refs.contains("refs/tags/v2"), "{refs}");

        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        crate::git::branches::git_delete_remote_branch_core(
            &state,
            work.clone(),
            "origin".into(),
            "extra".into(),
        )
        .await
        .expect("the delete lands");
        crate::git::ops::git_push_tag_core(&state, work.clone(), "v2".into())
            .await
            .expect("the tag push lands");
        crate::git::ops::git_delete_tag_core(&state, work.clone(), "v1".into(), true)
            .await
            .expect("the tag delete lands");
        let refs = run(&origin, &["for-each-ref"]).await;
        assert!(!refs.contains("refs/heads/extra"), "{refs}");
        assert!(refs.contains("refs/tags/v2"), "{refs}");
        assert!(!refs.contains("refs/tags/v1"), "{refs}");
    }

    /// A bare or forced HEAD push pressed on a branch that routes to a plain remote
    /// re-reads the route at spawn: a switch during the lock wait to a branch whose
    /// pushRemote is a mirror refuses, and nothing lands there.
    #[tokio::test(flavor = "multi_thread")]
    async fn mirror_refusal_queued_head_push_rechecks_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, _origin, second) = mirror_origin("mirror-queued").await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["config", "remote.second.mirror", "true"]).await;
        run(&work, &["config", "branch.feat/x.pushRemote", "second"]).await;
        let second_before = run(&second, &["for-each-ref"]).await;
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "feat/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_mirror(result, "second", &format!("force={force}"));
            assert_eq!(
                run(&second, &["for-each-ref"]).await,
                second_before,
                "force={force}"
            );
        }
    }

    /// git's last resort for a bare push is the ONLY remote when there is one, whatever its
    /// name: a mirror `up` with no `origin` refuses naming `up`, on a branch and detached,
    /// with `extra` (a branch only `up` holds) kept. Skips when a global config adds a
    /// remote or a push remote, since either moves git's route.
    #[tokio::test]
    async fn mirror_refusal_routes_a_bare_push_to_the_only_remote() {
        let (_guard, base) = temp_base("mirror-only-remote");
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        let up = base.join("up.git").to_string_lossy().replace('\\', "/");
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "up.git"]).await;
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        run(&work, &["remote", "add", "up", &up]).await;
        run(&work, &["config", "remote.up.mirror", "false"]).await;
        let leaked = run(
            &work,
            &["config", "--name-only", "--get-regexp", "^remote\\."],
        )
        .await;
        if leaked.lines().any(|k| !k.starts_with("remote.up.")) {
            eprintln!("skipping: a global config sets {leaked:?}");
            return;
        }
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(
            &work,
            &["push", "-q", "up", "main", "main:refs/heads/extra"],
        )
        .await;
        run(&work, &["update-ref", "-d", "refs/remotes/up/extra"]).await;
        run(&work, &["switch", "-q", "-c", "loose"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        let state = AppState::default();
        let before = run(&up, &["for-each-ref"]).await;

        run(&work, &["config", "remote.up.mirror", "true"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "up",
            "untracked bare",
        );
        assert_mirror(
            super::git_force_push_head_core(&state, work.clone()).await,
            "up",
            "untracked forced",
        );
        run(&work, &["switch", "-q", "--detach"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "up",
            "detached bare",
        );
        assert_eq!(run(&up, &["for-each-ref"]).await, before);

        // Two remotes, neither `origin`: git routes to `origin`, which is no mirror, and
        // refuses on its own; nothing lands.
        run(&work, &["remote", "add", "second", &up]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["switch", "-q", "loose"]).await;
        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => {
                assert!(
                    stderr.contains("No configured push destination"),
                    "{stderr}"
                )
            }
            other => panic!("two remotes: expected git's own refusal, got {other:?}"),
        }
        run(&work, &["remote", "remove", "second"]).await;
        assert_eq!(run(&up, &["for-each-ref"]).await, before);

        // The twins, mirror off: the bare push lands on `up`; detached, git refuses on its own.
        run(&work, &["config", "remote.up.mirror", "false"]).await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["switch", "-q", "--detach"]).await;
        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => {
                assert!(stderr.contains("not currently on a branch"), "{stderr}")
            }
            other => panic!("detached twin: expected git's own refusal, got {other:?}"),
        }
        run(&work, &["switch", "-q", "loose"]).await;
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("the bare push lands on the only remote");
        assert_eq!(
            run(&up, &["rev-parse", "refs/heads/loose"]).await,
            run(&work, &["rev-parse", "refs/heads/loose"]).await
        );
        assert!(run(&up, &["for-each-ref"])
            .await
            .contains("refs/heads/extra"));
    }

    /// A bare or force HEAD push re-reads HEAD after its lock wait: a switch to a
    /// session branch while it queues refuses the push, and nothing is published.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_head_push_rechecks_session_publish_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, base, _origin, _url) = seeded_origin("session-publish-queued").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["branch", "gd/session/x"]).await;
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            // Past the early check; the push waits on the domain the test holds.
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "gd/session/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            match result.expect_err("a session HEAD at spawn must not publish") {
                e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                    e.to_string(),
                    "\"gd/session/x\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it.",
                    "force={force}"
                ),
                other => panic!("force={force}: expected the publishing refusal, got {other:?}"),
            }
            let pushed = run(&work, &["ls-remote", "origin"]).await;
            assert!(
                !pushed.contains("gd/session/") && !pushed.contains("pressed"),
                "force={force}: {pushed}"
            );
        }
    }

    /// Whether every key reads unset (git exits 1); otherwise logs the skip.
    async fn unset_outside(repo: &str, what: &str, keys: &[&str]) -> bool {
        for key in keys {
            let out = run_git_raw(Some(repo), &["config", "--get", key], TEST_GIT_HANG_GUARD)
                .await
                .unwrap();
            if out.code != 1 {
                eprintln!("skipping {what}: {key} is set outside the fixture");
                return false;
            }
        }
        true
    }

    /// A work repo pinned against a hostile global config: a bare `origin` behind a
    /// three-slash `file:///` URL (mirror off, `remote.pushDefault` pinned to it) holding
    /// `main`, `feature` and the full ref `dest_ref`; HEAD on `topic`, one commit ahead,
    /// tracking `dest_ref`. `None` when `branch.topic.pushRemote` is set outside the
    /// fixture. Returns (guard, work, origin).
    async fn session_destination_origin(
        tag: &str,
        dest_ref: &str,
    ) -> Option<(tempfile::TempDir, String, String)> {
        let (guard, base) = temp_base(tag);
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        let origin = base.join("origin.git").to_string_lossy().replace('\\', "/");
        run(
            &base_s,
            &["init", "-q", "--bare", "-b", "main", "origin.git"],
        )
        .await;
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        if !unset_outside(&work, "session destination", &["branch.topic.pushRemote"]).await {
            return None;
        }
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "false"),
            ("remote.pushDefault", "origin"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        let url = format!("file:///{}", origin.trim_start_matches('/'));
        run(&work, &["remote", "add", "origin", &url]).await;
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(
            &work,
            &["push", "-q", "origin", "main", "main:refs/heads/feature"],
        )
        .await;
        run(&origin, &["update-ref", dest_ref, "refs/heads/main"]).await;
        run(&work, &["fetch", "-q", "origin"]).await;
        run(&work, &["switch", "-q", "-c", "topic"]).await;
        run(&work, &["config", "branch.topic.remote", "origin"]).await;
        run(&work, &["config", "branch.topic.merge", dest_ref]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        Some((guard, work, origin))
    }

    fn session_destination_copy(branch: &str, remote: &str, dest: &str) -> String {
        format!(
            "\"{branch}\" would push to {remote}/{dest}, which is in gd/session/ — reserved for agent sessions, so GitDesktop won't push to it."
        )
    }

    fn assert_session_destination(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        expected: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            e @ AppError::PushDestinationIsAgentSession { .. } => {
                assert_eq!(e.to_string(), expected, "{row}")
            }
            other => panic!("{row}: expected the session-destination refusal, got {other:?}"),
        }
    }

    /// A named push whose tracked or explicit destination is a session branch is refused on
    /// both policies, in any case spelling, and nothing lands; a cross-name non-session
    /// upstream still pushes under Follow.
    #[tokio::test]
    async fn session_destination_refuses_named_pushes_onto_a_session_branch() {
        for dest_ref in ["refs/heads/gd/session/x", "refs/heads/GD/Session/X"] {
            let dest = dest_ref.strip_prefix("refs/heads/").unwrap();
            let Some((_guard, work, origin)) =
                session_destination_origin("session-dest-named", dest_ref).await
            else {
                return;
            };
            let state = AppState::default();
            let before = run(&origin, &["for-each-ref"]).await;
            let refused = session_destination_copy("topic", "origin", dest);
            let topic = || Some("topic".to_string());
            for (row, force) in [("tracked", false), ("tracked, forced", true)] {
                let result =
                    git_push_core_unpinned(&state, work.clone(), false, force, topic(), None, None)
                        .await;
                assert_session_destination(result, &refused, &format!("{dest}: {row}"));
            }
            assert_session_destination(
                git_push_same_name_core(&state, work.clone(), false, topic(), None).await,
                &refused,
                &format!("{dest}: MCP same-name"),
            );
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/feature"],
            )
            .await;
            let explicit = git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                topic(),
                Some("origin".into()),
                Some(dest.into()),
            )
            .await;
            assert_session_destination(explicit, &refused, &format!("{dest}: explicit"));
            assert_eq!(run(&origin, &["for-each-ref"]).await, before, "{dest}");

            git_push_core_unpinned(&state, work.clone(), false, false, topic(), None, None)
                .await
                .expect("a cross-name non-session upstream pushes under Follow");
            assert_eq!(
                run(&origin, &["rev-parse", "refs/heads/feature"]).await,
                run(&work, &["rev-parse", "refs/heads/topic"]).await,
                "{dest}"
            );
        }
    }

    /// Under push.default=upstream a bare or forced HEAD push resolves to the tracked session
    /// branch and is refused by the early check, before the network lock; under `current`
    /// the same push resolves to HEAD's own name and lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_destination_refuses_bare_and_forced_head_pushes_under_upstream() {
        use crate::git::runner::acquire_repo_lock;
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-bare", "refs/heads/gd/session/x").await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "gd/session/x");
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work).await;
        let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");
        for force in [false, true] {
            let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let queued = std::sync::Arc::clone(&queued);
                move || queued.store(true, std::sync::atomic::Ordering::SeqCst)
            });
            let (state, work) = (std::sync::Arc::clone(&state), work.clone());
            let push = async move {
                if force {
                    super::git_force_push_head_core(&state, work)
                        .await
                        .map(super::PushGuardWire::from)
                } else {
                    git_push_core_unpinned(&state, work, false, false, None, None, None).await
                }
            };
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                NETWORK_LOCK_WAIT_HOOK.scope(hook, push),
            )
            .await
            .unwrap_or_else(|_| panic!("force={force}: the refusal waited on the held lock"));
            assert_session_destination(result, &refused, &format!("force={force}"));
            assert!(
                !queued.load(std::sync::atomic::Ordering::SeqCst),
                "force={force}: the push reached the network lock"
            );
        }
        drop(held);
        assert_eq!(run(&origin, &["for-each-ref"]).await, before);

        run(&work, &["config", "push.default", "current"]).await;
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("under current the bare push lands on topic");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/topic"]).await,
            run(&work, &["rev-parse", "refs/heads/topic"]).await
        );
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/gd/session/x"]).await,
            run(&work, &["rev-parse", "refs/heads/main"]).await
        );
    }

    /// The bare arm's destination check is case-insensitive too; its own bare repository,
    /// since two case spellings of one ref can't share one on Windows.
    #[tokio::test]
    async fn session_destination_refuses_a_mixed_case_bare_push() {
        let dest_ref = "refs/heads/GD/Session/X";
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-bare-case", dest_ref).await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "GD/Session/X");
        let state = AppState::default();
        let bare =
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await;
        assert_session_destination(bare, &refused, "bare, mixed case");
        let forced = super::git_force_push_head_core(&state, work.clone()).await;
        assert_session_destination(forced, &refused, "forced, mixed case");
        assert_eq!(run(&origin, &["for-each-ref"]).await, before);
    }

    /// A bare or forced push queued behind the network lock re-reads HEAD's destination at
    /// spawn: an upstream re-pointed at a session branch during the wait refuses, and
    /// nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_destination_rechecks_a_queued_bare_push_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-queued", "refs/heads/gd/session/x").await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "gd/session/x");
        for force in [false, true] {
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/feature"],
            )
            .await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/gd/session/x"],
            )
            .await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_session_destination(result, &refused, &format!("force={force}"));
            assert_eq!(
                run(&origin, &["for-each-ref"]).await,
                before,
                "force={force}"
            );
        }
    }

    /// The atom's push remote and the mirror verdict's agree beside a session upstream: a
    /// `pushRemote` naming `second` makes the atom read `second`, so nothing resolves to the
    /// session branch on origin and nothing lands; marking `second` a mirror refuses naming
    /// `second` on the identical config.
    #[tokio::test]
    async fn session_destination_push_remote_agreement_rows() {
        let Some((guard, work, origin)) =
            session_destination_origin("session-dest-agree", "refs/heads/gd/session/x").await
        else {
            return;
        };
        let second = guard
            .path()
            .join("second.git")
            .to_string_lossy()
            .replace('\\', "/");
        run(
            &guard.path().to_string_lossy(),
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        let url = format!("file:///{}", second.trim_start_matches('/'));
        run(&work, &["remote", "add", "second", &url]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["push", "-q", "second", "main"]).await;
        run(&work, &["config", "push.default", "upstream"]).await;
        run(&work, &["config", "branch.topic.pushRemote", "second"]).await;
        let state = AppState::default();
        let (origin_before, second_before) = (
            run(&origin, &["for-each-ref"]).await,
            run(&second, &["for-each-ref"]).await,
        );
        let atom = run(
            &work,
            &[
                "for-each-ref",
                "refs/heads/topic",
                "--format=%(push:remotename)",
            ],
        )
        .await;
        assert_eq!(atom.trim(), "second");

        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(e @ AppError::PushDestinationIsAgentSession { .. }) => {
                panic!("row a: refused as a session destination: {e:?}")
            }
            Err(e @ AppError::PushUpstreamIsLocal { .. }) => {
                panic!("row a: refused as a local upstream: {e:?}")
            }
            _ => {}
        }
        assert_eq!(run(&origin, &["for-each-ref"]).await, origin_before);
        assert_eq!(run(&second, &["for-each-ref"]).await, second_before);

        run(&work, &["config", "remote.second.mirror", "true"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "second",
            "row b",
        );
        assert_eq!(run(&origin, &["for-each-ref"]).await, origin_before);
        assert_eq!(run(&second, &["for-each-ref"]).await, second_before);
    }

    /// A work repo pinned against a hostile global config, with three bare remotes
    /// (`origin` holding `main`, `up`, `second`) behind three-slash `file:///` URLs, mirror
    /// off; HEAD on `feat`, one commit ahead of local `main`, which it tracks (remote `.`).
    /// `None` when a push remote is set outside the fixture. Returns (guard, work, remotes
    /// by name).
    async fn local_upstream_repo(
        tag: &str,
    ) -> Option<(tempfile::TempDir, String, Vec<(&'static str, String)>)> {
        let (guard, base) = temp_base(tag);
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        let keys = ["remote.pushDefault", "branch.feat.pushRemote"];
        if !unset_outside(&work, "local upstream", &keys).await {
            return None;
        }
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "false"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        let mut remotes = Vec::new();
        for name in ["origin", "up", "second"] {
            let dir = format!("{name}.git");
            run(&base_s, &["init", "-q", "--bare", "-b", "main", &dir]).await;
            let path = base.join(&dir).to_string_lossy().replace('\\', "/");
            let url = format!("file:///{}", path.trim_start_matches('/'));
            run(&work, &["remote", "add", name, &url]).await;
            let mirror = format!("remote.{name}.mirror");
            run(&work, &["config", &mirror, "false"]).await;
            remotes.push((name, path));
        }
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(&work, &["push", "-q", "origin", "main"]).await;
        run(&work, &["switch", "-q", "-c", "feat"]).await;
        run(&work, &["config", "branch.feat.remote", "."]).await;
        run(&work, &["config", "branch.feat.merge", "refs/heads/main"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        Some((guard, work, remotes))
    }

    fn assert_local_upstream(result: crate::error::AppResult<impl std::fmt::Debug>, row: &str) {
        match result.expect_err(row) {
            AppError::PushUpstreamIsLocal { branch, upstream } => {
                let got = (branch.as_str(), upstream.as_str());
                assert_eq!(got, ("feat", "main"), "{row}")
            }
            other => panic!("{row}: expected the local-upstream refusal, got {other:?}"),
        }
    }

    async fn tip(repo: &str, refname: &str) -> String {
        run(repo, &["rev-parse", refname]).await
    }

    async fn push_remote_atom(work: &str) -> String {
        let format = "--format=%(push:remotename)";
        let atom = run(work, &["for-each-ref", "refs/heads/feat", format]).await;
        atom.trim().to_string()
    }

    /// Named pushes (Follow, MCP same-name, set_upstream) and bare / forced HEAD pushes of a
    /// branch tracking a local branch refuse with the typed error under push.default simple
    /// and upstream, and local `main` never moves; an explicit remote and a GONE `.`
    /// upstream still push to origin.
    #[tokio::test]
    async fn local_upstream_refuses_named_and_bare_pushes() {
        let Some((_guard, work, remotes)) = local_upstream_repo("local-upstream").await else {
            return;
        };
        let origin = &remotes[0].1;
        let state = AppState::default();
        let main_before = run(&work, &["rev-parse", "refs/heads/main"]).await;
        let feat = || Some("feat".to_string());
        for force in [false, true] {
            let row = format!("named, force={force}");
            let result =
                git_push_core_unpinned(&state, work.clone(), false, force, feat(), None, None);
            assert_local_upstream(result.await, &row);
        }
        for set_upstream in [false, true] {
            let row = format!("MCP same-name, set_upstream={set_upstream}");
            let result = git_push_same_name_core(&state, work.clone(), set_upstream, feat(), None);
            assert_local_upstream(result.await, &row);
        }
        for push_default in ["simple", "upstream"] {
            run(&work, &["config", "push.default", push_default]).await;
            assert_eq!(push_remote_atom(&work).await, ".", "{push_default}");
            let bare = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
            assert_local_upstream(bare.await, &format!("bare, {push_default}"));
            let forced = super::git_force_push_head_core(&state, work.clone());
            assert_local_upstream(forced.await, &format!("forced, {push_default}"));
        }
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);
        assert!(!run(origin, &["for-each-ref"]).await.contains("feat"));

        run(&work, &["config", "push.default", "simple"]).await;
        let explicit = Some("origin".to_string());
        git_push_core_unpinned(&state, work.clone(), false, false, feat(), explicit, None)
            .await
            .expect("an explicit remote pushes to it");
        let feat_tip = run(&work, &["rev-parse", "refs/heads/feat"]).await;
        assert_eq!(tip(origin, "refs/heads/feat").await, feat_tip);
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);

        run(&work, &["commit", "-q", "--allow-empty", "-m", "more"]).await;
        run(&work, &["branch", "-q", "-D", "main"]).await;
        // The bare arm refuses a gone `.` upstream; the named arm then publishes it.
        let pushed = tip(origin, "refs/heads/feat").await;
        let bare = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        assert_local_upstream(bare.await, "bare, gone `.` upstream");
        let forced = super::git_force_push_head_core(&state, work.clone());
        assert_local_upstream(forced.await, "forced, gone `.` upstream");
        assert_eq!(tip(origin, "refs/heads/feat").await, pushed);
        assert!(!run(&work, &["for-each-ref"])
            .await
            .contains("refs/heads/main"));

        git_push_core_unpinned(&state, work.clone(), false, false, feat(), None, None)
            .await
            .expect("a gone local upstream publishes to origin");
        let feat_tip = run(&work, &["rev-parse", "refs/heads/feat"]).await;
        assert_eq!(tip(origin, "refs/heads/feat").await, feat_tip);
    }

    /// Beside a `.` upstream the bare push follows the push remote git resolves: a
    /// configured one (`remote.pushDefault`, a `pushRemote` outranking it) sends the push
    /// there and it lands, while `remote.pushDefault=.` refuses. Each allowed row pairs
    /// the atom it read with its mirror twin, where 1a's config order names the same remote.
    #[tokio::test]
    async fn local_upstream_bare_push_follows_the_push_remote() {
        let Some((_guard, work, remotes)) = local_upstream_repo("local-upstream-remote").await
        else {
            return;
        };
        let path = |name: &str| remotes.iter().find(|(n, _)| *n == name).unwrap().1.clone();
        let state = AppState::default();
        let main_before = run(&work, &["rev-parse", "refs/heads/main"]).await;
        let bare = || git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        let rows = [
            (
                "pushDefault",
                vec![("remote.pushDefault", "second")],
                "second",
            ),
            (
                "pushRemote over pushDefault",
                vec![
                    ("remote.pushDefault", "second"),
                    ("branch.feat.pushRemote", "up"),
                ],
                "up",
            ),
        ];
        for (row, config, lands_on) in rows {
            for (key, value) in config {
                run(&work, &["config", key, value]).await;
            }
            assert_eq!(push_remote_atom(&work).await, lands_on, "{row}");
            bare().await.unwrap_or_else(|e| panic!("{row}: {e:?}"));
            assert_eq!(
                run(&path(lands_on), &["rev-parse", "refs/heads/feat"]).await,
                run(&work, &["rev-parse", "refs/heads/feat"]).await,
                "{row}"
            );
            let mirror = format!("remote.{lands_on}.mirror");
            run(&work, &["config", &mirror, "true"]).await;
            assert_mirror(bare().await, lands_on, &format!("{row}: mirror twin"));
            run(&work, &["config", &mirror, "false"]).await;
            run(&work, &["commit", "-q", "--allow-empty", "-m", row]).await;
        }
        run(&work, &["config", "--unset", "branch.feat.pushRemote"]).await;
        run(&work, &["config", "remote.pushDefault", "."]).await;
        assert_eq!(push_remote_atom(&work).await, ".");
        assert_local_upstream(bare().await, "pushDefault=.");
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);

        // A non-branch `.` upstream and an untracked HEAD are never this refusal.
        run(&work, &["config", "--unset", "remote.pushDefault"]).await;
        run(&work, &["tag", "v1", "refs/heads/main"]).await;
        run(&work, &["config", "branch.feat.merge", "refs/tags/v1"]).await;
        let result = bare().await;
        assert!(
            !matches!(result, Err(AppError::PushUpstreamIsLocal { .. })),
            "not a branch: {result:?}"
        );
        run(&work, &["config", "--unset", "branch.feat.merge"]).await;
        run(&work, &["config", "--unset", "branch.feat.remote"]).await;
        let result = bare().await;
        assert!(
            !matches!(result, Err(AppError::PushUpstreamIsLocal { .. })),
            "untracked: {result:?}"
        );
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);
    }

    /// The bare arm's verdict off one tracking line: the push-remote atom decides, and a
    /// line read without the atoms falls back to the upstream's own remote.
    #[test]
    fn local_upstream_bare_line_reads_the_push_remote_atom() {
        use super::bare_push_local_upstream as local;
        let r = "refs/heads/feat";
        let line = |rest: &str| format!("{r}\0refs/heads/main\0.\0{rest}");
        let main = Some("main".to_string());
        assert_eq!(local(&line("\0.\0\0\0"), r), main);
        assert_eq!(local(&line(""), r), main, "no atoms");
        assert_eq!(local(&line("\0up\0\0\0"), r), None);
        let tag = format!("{r}\0refs/tags/v1\0.\0\0.\0\0\0");
        assert_eq!(local(&tag, r), None, "not a branch");
        assert_eq!(local(&format!("{r}\0\0\0"), r), None);
        assert_eq!(local("", r), None, "unborn");
    }

    /// The parser and both bare readers take each push atom by name: every atom they
    /// consume is compared with git's own single-atom read, so a reordered or inserted
    /// atom goes red here.
    #[tokio::test]
    async fn tracking_line_reads_each_push_atom_by_name() {
        use super::{bare_push_destination, bare_push_local_upstream, tracking_line};
        use crate::git::branches::{push_destination_fields, read_refs_with_push_destination};
        let (_guard, base, _origin, _url) = seeded_origin("atom-order").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let refname = "refs/heads/feat";
        // In the order `push_destination_fields` destructures them.
        macro_rules! single_reads {
            () => {{
                let mut reads = Vec::new();
                for atom in [
                    "%(push:remotename)",
                    "%(push:remoteref)",
                    "%(push)",
                    "%(upstream)",
                ] {
                    let format = format!("--format={atom}");
                    let out = run(&work, &["for-each-ref", refname, &format]).await;
                    reads.push(out.trim_end().to_string());
                }
                reads
            }};
        }
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["branch", "-q", "--set-upstream-to=origin/main"]).await;
        run(&work, &["config", "branch.feat.pushRemote", "origin"]).await;
        let refspec = "refs/heads/feat:refs/heads/dest";
        run(&work, &["config", "remote.origin.push", refspec]).await;

        let single = single_reads!();
        let single_strs: Vec<&str> = single.iter().map(String::as_str).collect();
        for (i, a) in single.iter().enumerate() {
            assert!(!a.is_empty(), "atom {i} empty: {single:?}");
            assert!(
                !single[i + 1..].contains(a),
                "atoms not distinct: {single:?}"
            );
        }
        let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
            .await
            .unwrap();
        let line = tracking_line(&text, refname).expect("the branch's own line");
        assert_eq!(line.atoms(), single_strs.as_slice(), "{text:?}");
        assert_eq!(
            line.atoms()[super::PUSH_TRACKING_ATOM_INDEX],
            single_strs[2],
            "%(push)"
        );
        assert_eq!(line.push_remotename(), Some(single_strs[0]));
        assert_eq!(line.upstream_atom(), Some(single_strs[3]));
        assert_eq!(line.upstream_remoteref(), "refs/heads/main");
        let (_, upstream_remote, _) = parse_upstream_tracking(&text, refname).unwrap();
        assert_eq!(line.upstream_remote(), upstream_remote);
        assert_eq!(
            bare_push_destination(&text, refname, "feat"),
            push_destination_fields("feat", &single_strs, "origin", "refs/heads/main")
        );
        assert_eq!(bare_push_local_upstream(&text, refname), None);

        // One extra base field shifts every atom, as an inserted atom shifts the rest.
        let shifted_format = format!("{UPSTREAM_TRACKING_FORMAT}%00%(objectname)");
        let shifted = read_refs_with_push_destination(&work, refname, &shifted_format)
            .await
            .unwrap();
        let shifted_line = tracking_line(&shifted, refname).expect("the branch's own line");
        assert_ne!(shifted_line.atoms(), single_strs.as_slice(), "{shifted:?}");

        // By value, never through `push_destination_fields`: what each atom MEANS.
        run(&work, &["config", "--unset", "remote.origin.push"]).await;
        for mode in ["current", "upstream"] {
            run(&work, &["config", "push.default", mode]).await;
            let single = single_reads!();
            let remote = single[0].as_str();
            assert_eq!(single[1], "", "{mode}: {single:?}");
            let expected_branch = if mode == "current" {
                let track_prefix = format!("refs/remotes/{remote}/");
                assert_eq!(
                    single[2],
                    format!("{track_prefix}feat"),
                    "{mode}: {single:?}"
                );
                single[2].strip_prefix(&track_prefix).unwrap().to_string()
            } else {
                assert_eq!(single[2], single[3], "{mode}: {single:?}");
                "refs/heads/main"
                    .strip_prefix("refs/heads/")
                    .unwrap()
                    .to_string()
            };
            let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
                .await
                .unwrap();
            assert_eq!(
                bare_push_destination(&text, refname, "feat"),
                (Some(remote.to_string()), Some(expected_branch)),
                "{mode}: {text:?}"
            );
        }

        run(&work, &["config", "branch.feat.pushRemote", "."]).await;
        assert_eq!(single_reads!()[0], ".");
        let text = read_refs_with_push_destination(&work, refname, UPSTREAM_TRACKING_FORMAT)
            .await
            .unwrap();
        assert_eq!(
            bare_push_local_upstream(&text, refname),
            Some("main".to_string()),
            "{text:?}"
        );
    }

    /// Unpinned, so the untracked HEAD reads no push remote, the shape most repos take.
    #[tokio::test]
    async fn session_publish_guard_lets_feature_publish() {
        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("session-publish-feature").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "feature/y"]).await;
        git_push_core_unpinned(
            &AppState::default(),
            work.clone(),
            true,
            false,
            None,
            None,
            None,
        )
        .await
        .expect("ordinary feature HEAD publishes");
        assert!(run(&work, &["ls-remote", "origin"])
            .await
            .contains("refs/heads/feature/y"));
    }

    /// The forge publishes push HEAD's branch by NAME, so a tag sharing it (or a branch
    /// taking its `heads/` form) can't send the push to `refs/heads/heads/<name>` after
    /// the remote project already exists. Unborn and detached HEADs keep their
    /// refusals, word for word.
    #[tokio::test]
    async fn publish_branch_names_the_branch_and_refuses_unborn_and_detached() {
        let (_base, base) = temp_base("publish-branch");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        let refusal = |e: AppError| match e {
            AppError::InvalidArgument(m) => m,
            other => panic!("expected the worded refusal, got {other:?}"),
        };
        assert_eq!(
            refusal(super::publish_branch(&repo_s).await.unwrap_err()),
            "make an initial commit before publishing (this repository has none yet)"
        );

        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        run(&repo_s, &["switch", "-q", "-c", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "shadowed");
        run(
            &repo_s,
            &["update-ref", "refs/heads/heads/shadowed", "HEAD"],
        )
        .await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "shadowed");

        run(&repo_s, &["switch", "-q", "--detach"]).await;
        assert_eq!(
            refusal(super::publish_branch(&repo_s).await.unwrap_err()),
            "check out a branch before publishing (detached HEAD)"
        );
    }

    /// The branch every provider pushes is re-checked where it is read, so a HEAD switched
    /// to a session or Keep local branch after the dispatch's read is still refused.
    #[tokio::test]
    async fn head_switch_publish_branch_refuses_session_and_keep_local() {
        let (_base, base) = temp_base("head-switch");
        let repo_s = base.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["switch", "-q", "-c", "feat/x"]).await;
        run(&repo_s, &["branch", "gd/session/x"]).await;
        assert_eq!(super::publish_branch(&repo_s).await.unwrap(), "feat/x");
        crate::git::branches::set_branch_keep_local_core(&repo_s, "feat/x", true)
            .await
            .unwrap();
        assert_kept_local(super::publish_branch(&repo_s).await, "feat/x", "kept local");
        run(&repo_s, &["switch", "-q", "gd/session/x"]).await;
        match super::publish_branch(&repo_s).await {
            Err(AppError::BranchIsAgentSession { branch }) => assert_eq!(branch, "gd/session/x"),
            other => panic!("expected the session refusal, got {other:?}"),
        }
    }

    /// Only git's "No such remote" lets a publish proceed: a url, a url-less section and
    /// a failed read (not a repository) all refuse before anything is created, while
    /// `remote.origin.*` keys from a global file alone do not.
    #[tokio::test]
    async fn existing_origin_refusal_fails_closed() {
        let copy = "this repository already has an origin remote — push to it instead";
        let (_base, base) = temp_base("existing-origin");
        let repo = base.join("repo");
        let other = base.join("not-a-repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        super::refuse_existing_origin(&repo_s)
            .await
            .expect("no origin: the publish proceeds");

        let global = base.join("global.gitconfig");
        std::fs::write(
            &global,
            "[remote \"origin\"]\n\turl = file:///C:/nowhere.git\n\tprune = true\n\tmirror = true\n",
        )
        .unwrap();
        let global_s = global.to_string_lossy().into_owned();
        let envs = [("GIT_CONFIG_GLOBAL", global_s.as_str())];
        let seen = crate::git::runner::run_git_raw_env(
            Some(&repo_s),
            &["config", "--get", "remote.origin.url"],
            &envs,
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(seen.code, 0, "the seam reads the global file");
        super::existing_origin_verdict(&repo_s, &envs)
            .await
            .expect("global-only origin keys: the publish proceeds");

        run(&repo_s, &["config", "remote.origin.mirror", "false"]).await;
        match super::refuse_existing_origin(&repo_s).await {
            Err(AppError::InvalidArgument(m)) => assert_eq!(m, copy, "url-less section"),
            other => panic!("url-less section: expected the origin copy, got {other:?}"),
        }
        run(
            &repo_s,
            &["config", "remote.origin.url", "file:///C:/nowhere.git"],
        )
        .await;
        match super::refuse_existing_origin(&repo_s).await {
            Err(AppError::InvalidArgument(m)) => assert_eq!(m, copy, "origin url"),
            other => panic!("origin url: expected the origin copy, got {other:?}"),
        }

        let other_s = other.to_string_lossy().into_owned();
        match super::refuse_existing_origin(&other_s).await {
            Err(AppError::Git { code, stderr }) => {
                assert_ne!(code, 2, "{stderr}");
                assert!(stderr.contains("not a git repository"), "{stderr}");
            }
            other => panic!("not a repository: expected git's failure, got {other:?}"),
        }
    }

    /// The verdict over git's answer, old git's exit-128 "No such remote" included.
    #[test]
    fn existing_origin_decision_reads_old_and_new_missing_remote_exits() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let decide = super::existing_origin_decision;
        decide(&out(2, "", "error: No such remote 'origin'\n")).expect("exit 2: no origin");
        decide(&out(128, "", "fatal: No such remote 'origin'\n"))
            .expect("old git's exit 128: no origin");
        match decide(&out(0, "file:///C:/nowhere.git\n", "")) {
            Err(AppError::InvalidArgument(m)) => assert!(m.contains("already has an origin")),
            other => panic!("exit 0: expected the origin copy, got {other:?}"),
        }
        let repo = "fatal: not a git repository (or any of the parent directories): .git\n";
        match decide(&out(128, "", repo)) {
            Err(AppError::Git { code: 128, stderr }) => {
                assert!(stderr.contains("not a git repository"), "{stderr}")
            }
            other => panic!("not a repository: expected git's failure, got {other:?}"),
        }
    }

    fn assert_unborn_push_refusal(error: AppError) {
        let AppError::InvalidArgument(expected) = crate::git::branches::unborn_head_error() else {
            panic!("unborn HEAD refusal must be an invalid argument");
        };
        match error {
            AppError::InvalidArgument(message) => assert_eq!(message, expected),
            other => panic!("expected the unborn HEAD refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn named_push_refuses_fresh_unborn_head() {
        for with_origin in [false, true] {
            let (_guard, base) = temp_base("named-push-unborn");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_origin {
                run(
                    &repo_s,
                    &["remote", "add", "origin", "./missing-origin.git"],
                )
                .await;
            }
            let state = AppState::default();
            for set_upstream in [false, true] {
                let error = git_push_core_unpinned(
                    &state,
                    repo_s.clone(),
                    set_upstream,
                    false,
                    Some("main".into()),
                    None,
                    None,
                )
                .await
                .unwrap_err();
                assert_unborn_push_refusal(error);
            }
        }
    }

    #[tokio::test]
    async fn head_publish_refuses_fresh_unborn_head() {
        for with_origin in [false, true] {
            let (_guard, base) = temp_base("head-publish-unborn");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_origin {
                run(
                    &repo_s,
                    &["remote", "add", "origin", "./missing-origin.git"],
                )
                .await;
            }
            let state = AppState::default();
            let error = git_push_core_unpinned(&state, repo_s, true, false, None, None, None)
                .await
                .unwrap_err();
            assert_unborn_push_refusal(error);
        }
    }

    #[tokio::test]
    async fn named_push_refuses_orphan_head() {
        let (_guard, base) = temp_base("named-push-orphan");
        let repo_s = base.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        run(&repo_s, &["switch", "--orphan", "fresh"]).await;
        let state = AppState::default();
        let error = git_push_core_unpinned(
            &state,
            repo_s,
            true,
            false,
            Some("fresh".into()),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_unborn_push_refusal(error);
    }

    #[tokio::test]
    async fn named_push_preserves_missing_branch_refusal() {
        for with_commits in [false, true] {
            let (_guard, base) = temp_base("named-push-missing");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_commits {
                init_repo(&repo_s, "seed.txt").await;
            }
            let state = AppState::default();
            let error = git_push_core_unpinned(
                &state,
                repo_s,
                true,
                false,
                Some("missing".into()),
                None,
                None,
            )
            .await
            .unwrap_err();
            match error {
                AppError::InvalidArgument(message) => {
                    assert_eq!(message, "no such branch: missing")
                }
                other => panic!("expected the missing branch refusal, got {other:?}"),
            }
        }
    }

    /// A tracked branch pushes to its upstream's real branch when a tag named
    /// `origin/<branch>` shortens the upstream to `remotes/origin/<branch>` — never to a
    /// brand-new `remotes/origin/<branch>` branch on the remote.
    #[tokio::test]
    async fn push_targets_the_upstream_branch_shadowed_by_a_tag() {
        let (_guard, base, origin_s, _url) = seeded_origin("push-upstream-tag-shadow").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&work_s, &["switch", "-q", "-c", "feat"]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "feat"]).await;
        run(&work_s, &["tag", "origin/feat"]).await;
        std::fs::write(work.join("f.txt"), "f\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "feat work"]).await;
        let tip = run(&work_s, &["rev-parse", "HEAD"]).await;

        let state = AppState::default();
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            false,
            false,
            Some("feat".into()),
            None,
            None,
        )
        .await
        .expect("the push succeeds");
        assert_eq!(run(&origin_s, &["rev-parse", "refs/heads/feat"]).await, tip);
        let published = run(
            &origin_s,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await;
        assert!(!published.contains("refs/heads/remotes/"), "{published}");
    }

    /// `push -u` that loses `.git/config.lock` exits 0 with the push landed and the
    /// upstream unwritten (measured, git 2.51.1) — the canary half. Through
    /// `git_push_with_policy`'s two `-u` arms (named branch, HEAD) and a forge-shaped argv
    /// straight into the runner, every publish still ends tracking.
    #[tokio::test]
    async fn a_publish_that_loses_the_config_lock_still_sets_the_upstream() {
        use crate::git::runner::{release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK};
        use std::sync::atomic::Ordering;
        let (_guard, base, origin_s, _url) = seeded_origin("push-config-lock").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        let lock = work.join(".git").join("config.lock");
        let upstream_of = |b: &str| {
            let (work_s, spec) = (work_s.clone(), format!("{b}@{{upstream}}"));
            async move {
                run_git(
                    Some(&work_s),
                    &["rev-parse", "--abbrev-ref", &spec],
                    TEST_GIT_HANG_GUARD,
                )
                .await
                .map(|o| o.stdout_lossy().trim().to_string())
                .ok()
            }
        };
        for b in ["canary", "named", "current", "forge"] {
            run(&work_s, &["branch", b]).await;
        }

        std::fs::write(&lock, b"").unwrap();
        let raw = run_git_raw(
            Some(&work_s),
            &[
                "push",
                "-u",
                "origin",
                "refs/heads/canary:refs/heads/canary",
            ],
            NETWORK_TIMEOUT,
        )
        .await
        .unwrap();
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(raw.code, 0, "{}", raw.stderr);
        assert!(raw.stderr.contains(UPSTREAM_WRITE_FAILED), "{}", raw.stderr);
        assert!(is_config_lock_contention(&raw.stderr));
        run(&origin_s, &["rev-parse", "--verify", "refs/heads/canary"]).await;
        assert_eq!(upstream_of("canary").await, None, "git left it untracked");

        let state = AppState::default();
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 2);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_push_core_unpinned(
                    &state,
                    work_s.clone(),
                    false,
                    false,
                    Some("named".into()),
                    None,
                    None,
                ),
            )
            .await
            .expect("the push succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(upstream_of("named").await.as_deref(), Some("origin/named"));

        run(&work_s, &["switch", "-q", "current"]).await;
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 1);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_push_core_unpinned(&state, work_s.clone(), true, false, None, None, None),
            )
            .await
            .expect("the push succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(
            upstream_of("current").await.as_deref(),
            Some("origin/current")
        );
        run(&origin_s, &["rev-parse", "--verify", "refs/heads/current"]).await;

        // A branch shadowed by a same-named tag, with a real `heads/shadowed` branch
        // beside it: the HEAD publish and its repair still name `refs/heads/shadowed`,
        // never the `heads/shadowed` that `symbolic-ref --short` would answer.
        run(&work_s, &["switch", "-q", "-c", "shadowed"]).await;
        run(&work_s, &["tag", "shadowed"]).await;
        run(
            &work_s,
            &["update-ref", "refs/heads/heads/shadowed", "refs/heads/main"],
        )
        .await;
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 2);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_push_core_unpinned(&state, work_s.clone(), true, false, None, None, None),
            )
            .await
            .expect("the push succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let published = run(
            &origin_s,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await;
        assert!(
            published.lines().any(|r| r == "refs/heads/shadowed"),
            "{published}"
        );
        assert!(!published.contains("refs/heads/heads/"), "{published}");
        assert_eq!(
            run(&work_s, &["config", "--get", "branch.shadowed.merge"])
                .await
                .trim(),
            "refs/heads/shadowed"
        );

        // The forge publishes' shape: `-c` entries ahead of the subcommand, empty `cred`,
        // straight into the runner.
        let spec = publish_refspec("forge");
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 2);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                run_git_mutating_with_creds(
                    &state,
                    &work_s,
                    &[],
                    &[
                        "-c",
                        "credential.interactive=false",
                        "push",
                        "-u",
                        "origin",
                        &spec,
                    ],
                    NETWORK_TIMEOUT,
                ),
            )
            .await
            .expect("the push succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(upstream_of("forge").await.as_deref(), Some("origin/forge"));
    }

    /// This repo's `remote.*` and `branch.*` keys, so a test can tell what a run wrote.
    async fn remote_config(repo: &str) -> String {
        run_git_raw(
            Some(repo),
            &["config", "--local", "--get-regexp", r"^(remote|branch)\."],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .stdout_lossy()
    }

    /// The canary the remote repairs rest on (git 2.51.1): `set-url` and `add` lose
    /// their FIRST write with nothing changed, so a re-run is the fix; `remove` loses
    /// either before any ref (a tracking branch's unset) or after the refs are gone
    /// (the section, leaving it and `remote.pushDefault`). A loss between `add`'s two
    /// writes is beyond the held-lock seam; its url-only state fails a re-run.
    #[tokio::test]
    async fn git_loses_each_remote_verbs_config_write_at_a_measured_point() {
        let (_guard, base, _origin_s, url) =
            seeded_origin_unpinned_push_default("remote-verb-shapes").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        let lock = work.join(".git").join("config.lock");
        let raw = |args: Vec<&str>| {
            let work_s = work_s.clone();
            let args: Vec<String> = args.into_iter().map(str::to_string).collect();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                run_git_raw(Some(&work_s), &args, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap()
            }
        };
        let tracking_refs = || run(&work_s, &["for-each-ref", "refs/remotes/origin/"]);

        let before = remote_config(&work_s).await;
        assert!(before.contains("branch.main.remote origin"), "{before}");
        hold_config_lock(&work);
        for args in [
            vec!["remote", "set-url", "origin", "../elsewhere"],
            vec!["remote", "add", "extra", &url],
            vec!["remote", "remove", "origin"],
        ] {
            let out = raw(args.clone()).await;
            assert_eq!(out.code, 128, "{args:?}: {}", out.stderr);
            assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
            assert_eq!(
                remote_config(&work_s).await,
                before,
                "{args:?} changed nothing"
            );
        }
        let out = raw(vec!["remote", "remove", "origin"]).await;
        assert!(
            out.stderr.contains(REMOTE_BRANCH_UNSET_LOST),
            "{}",
            out.stderr
        );
        assert!(
            !tracking_refs().await.trim().is_empty(),
            "no ref was deleted"
        );
        std::fs::remove_file(&lock).unwrap();

        run(&work_s, &["config", "remote.half.url", &url]).await;
        let out = raw(vec!["remote", "add", "half", &url]).await;
        assert_eq!(out.code, 3, "{}", out.stderr);
        assert!(out.stderr.contains("already exists"), "{}", out.stderr);

        run(&work_s, &["branch", "--unset-upstream", "main"]).await;
        run(&work_s, &["config", "remote.pushDefault", "origin"]).await;
        hold_config_lock(&work);
        let out = raw(vec!["remote", "remove", "origin"]).await;
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(out.code, 1, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert!(out.stderr.contains(REMOTE_SECTION_LOST), "{}", out.stderr);
        assert_eq!(tracking_refs().await.trim(), "", "the refs went first");
        let left = remote_config(&work_s).await;
        assert!(left.contains("remote.origin.url "), "{left}");
        assert!(left.contains("remote.pushdefault origin"), "{left}");
    }

    /// Each `remote` verb that loses the config lock ends where an uncontended one
    /// does, through the repair's retry; its uncontended twin never reaches a repair.
    /// `remove` covers both measured losses: before any ref (re-run) and after the refs
    /// (the section and `remote.pushDefault` finished).
    #[tokio::test]
    async fn remote_verbs_that_lose_the_config_lock_still_land() {
        use crate::git::runner::{release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK};
        use std::sync::atomic::Ordering;
        let (_guard, base, origin_s, url) =
            seeded_origin_unpinned_push_default("remote-verb-repairs").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        let lock = work.join(".git").join("config.lock");
        let state = AppState::default();
        let contended = || {
            hold_config_lock(&work);
            release_config_lock_before_attempt(lock.clone(), 2)
        };
        // Counts attempts without ever deleting anything.
        let uncontended = || release_config_lock_before_attempt(lock.clone(), usize::MAX);

        let (hook, attempts) = contended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_set_url_core(&state, work_s.clone(), "origin".into(), origin_s.clone()),
            )
            .await
            .expect("the set-url succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            run(&work_s, &["config", "--get", "remote.origin.url"])
                .await
                .trim(),
            origin_s
        );

        let (hook, attempts) = contended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_add_core(&state, work_s.clone(), "extra".into(), url.clone()),
            )
            .await
            .expect("the add succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let (hook, attempts) = uncontended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_add_core(&state, work_s.clone(), "twin".into(), url.clone()),
            )
            .await
            .expect("the twin add succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 0, "no repair uncontended");
        let config = remote_config(&work_s).await;
        assert_eq!(
            config
                .lines()
                .filter(|l| l.starts_with("remote.extra."))
                .collect::<Vec<_>>()
                .join("\n"),
            config
                .lines()
                .filter(|l| l.starts_with("remote.twin."))
                .collect::<Vec<_>>()
                .join("\n")
                .replace("twin", "extra"),
            "what git itself writes: {config}"
        );

        // Loses before any ref: `main` tracks `extra`, so the first unset dies.
        run(&work_s, &["fetch", "-q", "extra"]).await;
        run(&work_s, &["branch", "--set-upstream-to=extra/main", "main"]).await;
        let (hook, attempts) = contended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_remove_core(&state, work_s.clone(), "extra".into()),
            )
            .await
            .expect("the tracked remove succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let config = remote_config(&work_s).await;
        assert!(!config.contains("remote.extra."), "{config}");
        assert!(!config.contains("branch.main."), "untracked: {config}");
        assert_eq!(
            run(&work_s, &["for-each-ref", "refs/remotes/extra/"]).await,
            ""
        );

        // Loses after the refs: nothing tracks `twin`, and it is the push default.
        run(&work_s, &["fetch", "-q", "twin"]).await;
        run(&work_s, &["config", "remote.pushDefault", "twin"]).await;
        let (hook, attempts) = contended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_remove_core(&state, work_s.clone(), "twin".into()),
            )
            .await
            .expect("the untracked remove succeeds");
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            3,
            "section, retry, push default"
        );
        let config = remote_config(&work_s).await;
        assert!(!config.contains("remote.twin."), "{config}");
        assert!(!config.contains("pushdefault"), "{config}");
        assert_eq!(
            run(&work_s, &["for-each-ref", "refs/remotes/twin/"]).await,
            ""
        );

        // Uncontended twins of set-url and remove: the repair never fires, and they end
        // where the contended runs above did.
        let (hook, attempts) = uncontended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_set_url_core(&state, work_s.clone(), "origin".into(), url.clone()),
            )
            .await
            .expect("the twin set-url succeeds");
        assert_eq!(
            run(&work_s, &["config", "--get", "remote.origin.url"])
                .await
                .trim(),
            url
        );
        let (hook, removes) = uncontended();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_remote_remove_core(&state, work_s.clone(), "origin".into()),
            )
            .await
            .expect("the twin remove succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 0, "no set-url repair");
        assert_eq!(removes.load(Ordering::SeqCst), 0, "no remove repair");
        let config = remote_config(&work_s).await;
        assert!(!config.contains("remote."), "{config}");
        assert_eq!(run(&work_s, &["for-each-ref", "refs/remotes/"]).await, "");

        // The forge delete's "already absent" mapping still sees git's own text.
        let err = remove_remote(&state, &work_s, "twin")
            .await
            .expect_err("a missing remote fails");
        assert!(
            matches!(&err, AppError::Git { stderr, .. } if stderr.contains("No such remote")),
            "{err:?}"
        );
    }

    /// A lock held through every retry fails each verb with what happened and the next
    /// step, never git's lock-file text nor a success over partial state; each verb
    /// changed nothing beyond what git itself did, and trying again finishes.
    #[tokio::test]
    async fn remote_verbs_whose_repair_also_loses_say_try_again() {
        let (_guard, base, _origin_s, url) =
            seeded_origin_unpinned_push_default("remote-verb-held").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&work_s, &["branch", "--unset-upstream", "main"]).await;
        let before = remote_config(&work_s).await;
        let lock = hold_config_lock(&work);
        let state = AppState::default();

        let busy = |err: AppError, tail: &str| {
            assert!(matches!(err, AppError::Command(_)), "{err:?}");
            assert_eq!(err.to_string(), config_lock_busy(tail).to_string());
            assert!(
                !err.to_string().contains("could not lock config file"),
                "{err}"
            );
        };
        busy(
            git_remote_set_url_core(&state, work_s.clone(), "origin".into(), "../x".into())
                .await
                .expect_err("set-url fails"),
            "the remote wasn't changed — try again.",
        );
        busy(
            git_remote_add_core(&state, work_s.clone(), "extra".into(), url)
                .await
                .expect_err("add fails"),
            "the remote wasn't changed — try again.",
        );
        assert_eq!(remote_config(&work_s).await, before);
        busy(
            git_remote_remove_core(&state, work_s.clone(), "origin".into())
                .await
                .expect_err("remove fails"),
            "the remote wasn't fully removed — try again.",
        );
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(
            run(&work_s, &["for-each-ref", "refs/remotes/origin/"]).await,
            "",
            "lost after the refs went"
        );
        assert!(remote_config(&work_s).await.contains("remote.origin.url "));
        git_remote_remove_core(&state, work_s.clone(), "origin".into())
            .await
            .expect("trying again removes it");
        assert!(!remote_config(&work_s).await.contains("remote."));
    }

    /// A removal whose repair lands the section but loses both push-default unsets says
    /// so, never git's "try again" over the section it lost first: that section is gone,
    /// and a retry would refuse the remote as missing.
    #[tokio::test]
    async fn a_removal_whose_push_default_repair_loses_says_what_is_left() {
        use crate::git::runner::CONFIG_WRITE_ATTEMPT_HOOK;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let (_guard, base, _origin_s, _url) =
            seeded_origin_unpinned_push_default("remote-push-default-held").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&work_s, &["branch", "--unset-upstream", "main"]).await;
        run(&work_s, &["config", "remote.pushDefault", "origin"]).await;
        let lock = hold_config_lock(&work);
        // Held attempts: the section and its retry (released before 2, so it lands),
        // then the push-default unset and its retry (re-held before 3, so both lose).
        let attempts = Arc::new(AtomicUsize::new(0));
        let hook = {
            let (attempts, lock) = (Arc::clone(&attempts), lock.clone());
            move || match attempts.fetch_add(1, Ordering::SeqCst) + 1 {
                2 => std::fs::remove_file(&lock).expect("the held config.lock is released"),
                3 => std::fs::write(&lock, b"").expect("the config.lock is held again"),
                _ => {}
            }
        };
        let state = AppState::default();
        for push in [false, true] {
            cache_put(&work_s, "origin", push, "https://stale.example/old.git");
        }
        let err = CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                Arc::new(hook),
                git_remote_remove_core(&state, work_s.clone(), "origin".into()),
            )
            .await
            .expect_err("the push-default leg is lost");
        assert_eq!(
            [false, true].map(|push| cache_get(&work_s, "origin", push, BIG)),
            [None, None],
            "the removed remote's URL is not served"
        );
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            4,
            "section, retry, unset, retry"
        );
        assert!(matches!(err, AppError::Command(_)), "{err:?}");
        assert_eq!(
            err.to_string(),
            config_lock_busy(REMOTE_PUSH_DEFAULT_LEFT).to_string()
        );
        assert!(
            !err.to_string().contains("could not lock config file"),
            "{err}"
        );
        let left = remote_config(&work_s).await;
        assert!(!left.contains("remote.origin."), "the section went: {left}");
        assert!(left.contains("remote.pushdefault origin"), "{left}");
    }

    /// A removal lost at the push-default unset already dropped the section, so its
    /// refusal never offers the retry that would now fail as "No such remote"; every
    /// other second loss keeps it. Synthetic: that race is beyond the held-lock seam.
    #[test]
    fn a_lost_removal_offers_try_again_only_while_the_section_remains() {
        let lock = "error: could not lock config file .git/config: File exists";
        let retry = "the remote wasn't fully removed — try again.";
        for (marker, want) in [
            (
                format!("fatal: {REMOTE_PUSH_DEFAULT_LOST}"),
                "the remote was removed but is still recorded as the push default — clear \
                 remote.pushDefault to finish.",
            ),
            (
                format!("error: {REMOTE_SECTION_LOST} 'remote.origin'"),
                retry,
            ),
            (
                format!("fatal: {REMOTE_BRANCH_UNSET_LOST}main.remote'"),
                retry,
            ),
            (
                format!(
                    "error: {REMOTE_SECTION_LOST} 'remote.origin'\n\
                     fatal: {REMOTE_PUSH_DEFAULT_LOST}"
                ),
                retry,
            ),
        ] {
            assert_eq!(
                remove_busy_tail(&format!("{lock}\n{marker}")),
                want,
                "{marker}"
            );
        }
    }

    /// Only the busy refusal is re-tailed for a wrapping forge caller; git's own error,
    /// whose text callers match on, and any other message pass through unchanged.
    #[test]
    fn only_the_busy_refusal_takes_a_callers_tail() {
        let tail = "it wasn't updated.";
        let busy = with_busy_tail(
            config_lock_busy("the remote wasn't changed — try again."),
            tail,
        );
        assert_eq!(busy.to_string(), config_lock_busy(tail).to_string());
        assert!(!busy.to_string().contains("try again"), "{busy}");
        let git = with_busy_tail(
            AppError::Git {
                code: 2,
                stderr: "error: No such remote: 'origin'".into(),
            },
            tail,
        );
        assert!(
            matches!(&git, AppError::Git { stderr, .. } if stderr.contains("No such remote")),
            "{git:?}"
        );
        let other = with_busy_tail(AppError::Command("something else".into()), tail);
        assert_eq!(other.to_string(), "something else");
    }

    /// Only a removal that dropped the remote but kept `remote.pushDefault` reads as one,
    /// so the repo delete can say origin is gone; every other refusal or git error doesn't.
    #[test]
    fn only_the_push_default_leftover_reads_as_a_removed_remote() {
        assert!(is_push_default_left(&config_lock_busy(
            REMOTE_PUSH_DEFAULT_LEFT
        )));
        assert!(!is_push_default_left(&config_lock_busy(REMOTE_UNCHANGED)));
        assert!(!is_push_default_left(&AppError::Git {
            code: 2,
            stderr: "error: No such remote: 'origin'".into(),
        }));
    }

    /// The publish paths' add: option-shaped and empty URLs are refused before git
    /// runs, and a stale cached URL for the name never outlives the add.
    #[tokio::test]
    async fn remote_add_validates_the_url_and_drops_a_stale_cached_one() {
        let (_guard, base) = temp_base("remote-add-core");
        let work_s = base.to_string_lossy().into_owned();
        init_repo(&work_s, "a.txt").await;
        let state = AppState::default();
        for url in ["-x", "", "  "] {
            let err = git_remote_add_core(&state, work_s.clone(), "origin".into(), url.into())
                .await
                .expect_err("refused");
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{url:?}: {err:?}"
            );
        }
        assert_eq!(run(&work_s, &["remote"]).await, "", "nothing added");

        for push in [false, true] {
            cache_put(&work_s, "origin", push, "https://stale.example/old.git");
        }
        git_remote_add_core(
            &state,
            work_s.clone(),
            "origin".into(),
            " https://example.com/new.git ".into(),
        )
        .await
        .expect("the add lands");
        assert_eq!(
            [false, true].map(|push| cache_get(&work_s, "origin", push, BIG)),
            [None, None],
            "the stale entry is gone"
        );
        assert_eq!(
            run(&work_s, &["remote", "get-url", "origin"]).await.trim(),
            "https://example.com/new.git"
        );
    }

    /// Only a `push -u` with one refspec names an upstream to repair, read past any
    /// leading `-c` pairs and the force flags.
    #[test]
    fn the_upstream_repair_reads_only_a_single_refspec_push_u() {
        let spec = "refs/heads/b:refs/heads/b";
        for (argv, want) in [
            (
                vec!["push", "-u", "origin", "HEAD"],
                Some(("origin", "HEAD")),
            ),
            (
                vec!["-c", "a=b", "push", "-u", "fork", spec],
                Some(("fork", spec)),
            ),
            (
                vec![
                    "push",
                    "--force-with-lease",
                    FORCE_IF_INCLUDES,
                    "-u",
                    "origin",
                    spec,
                ],
                Some(("origin", spec)),
            ),
            (vec!["push", "origin", spec], None),
            (vec!["push", "-u", "origin"], None),
            (
                vec!["push", "-u", "origin", spec, "refs/heads/c:refs/heads/c"],
                None,
            ),
            (vec!["fetch", "-u", "origin", spec], None),
            (vec!["-c", "x=-u", "pull", "--ff-only"], None),
        ] {
            assert_eq!(push_upstream_target(&argv), want, "{argv:?}");
        }
        // Of those, only the explicit same-name pair names a branch to repair; a literal
        // HEAD resolves at spawn, so it never does.
        let pair = |r: &str, b: &str| Some((r.to_string(), b.to_string()));
        for (argv, want) in [
            (
                vec!["-c", "a=b", "push", "-u", "fork", spec],
                pair("fork", "b"),
            ),
            (vec!["push", "-u", "origin", "HEAD"], None),
            (
                vec!["push", "-u", "origin", "refs/heads/b:refs/heads/c"],
                None,
            ),
            (vec!["push", "-u", "origin", "b"], None),
        ] {
            assert_eq!(push_upstream_branch(&argv), want, "{argv:?}");
        }
    }

    /// A HEAD-path publish names the branch checked out when it was asked for, in the
    /// argv AND the repair: switched away while the push queues behind the network
    /// lock, it still publishes and tracks that branch, never the one checked out at
    /// spawn.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_head_publish_queued_behind_the_network_lock_keeps_its_branch() {
        use crate::git::runner::{
            acquire_repo_lock, release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK,
        };
        let (_guard, base, origin_s, _url) = seeded_origin("push-head-pin").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        for b in ["pressed", "later"] {
            run(&work_s, &["branch", b]).await;
        }
        run(&work_s, &["switch", "-q", "pressed"]).await;
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work_s).await;
        let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");

        let lock = work.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock, 2);
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
        let queued_tx = std::sync::Mutex::new(Some(queued_tx));
        let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
            if let Some(tx) = queued_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        });
        let push = tokio::spawn({
            let (state, work_s) = (std::sync::Arc::clone(&state), work_s.clone());
            let run = async move {
                git_push_core_unpinned(&state, work_s, true, false, None, None, None).await
            };
            NETWORK_LOCK_WAIT_HOOK.scope(queued, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, run))
        });
        // The push is about to wait on the domain the test holds; only now does the
        // user switch away.
        queued_rx.await.expect("the push reached the network lock");
        run(&work_s, &["switch", "-q", "later"]).await;
        drop(held);
        tokio::time::timeout(Duration::from_secs(60), push)
            .await
            .expect("the push finishes once the domain frees")
            .unwrap()
            .expect("the push succeeds");

        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        let pushed = run(
            &origin_s,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        )
        .await;
        assert!(pushed.lines().any(|l| l == "pressed"), "{pushed}");
        assert!(!pushed.lines().any(|l| l == "later"), "{pushed}");
        let upstream = run_git(
            Some(&work_s),
            &["rev-parse", "--abbrev-ref", "pressed@{upstream}"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("the pressed branch tracks");
        assert_eq!(upstream.stdout_lossy().trim(), "origin/pressed");
    }

    /// git's per-ref reason when `--force-with-lease` finds the remote-tracking ref
    /// behind the real remote — verbatim from `! [rejected] … (…)`. The prod-side
    /// twin is [`IF_INCLUDES_REJECTION`]; this one only ever appears in git's report.
    const STALE_LEASE_REJECTION: &str = "stale info";

    /// Assert git's failure report still carries a `! [rejected] … (<reason>)` line
    /// — the exact shape `PUSH_REJECTION_SUMMARIES` (src/lib/error-summary.ts)
    /// anchors on to turn a blocked force push into one human line. Keep the two
    /// lists in step: a reason git renames goes back to raw stderr in the toast.
    fn assert_rejection_reason(report: &str, reason: &str) {
        let marked = format!("({reason})");
        assert!(
            report
                .lines()
                .any(|l| l.trim_start().starts_with("! [rejected]") && l.contains(&marked)),
            "git no longer emits `! [rejected] … {marked}` — the frontend summary is now blind \
             to this rejection. Actual report:\n{report}"
        );
    }

    /// The bare lease's own refusal, driven end to end: with the remote moved and
    /// never fetched, the remote-tracking ref is stale and git rejects before
    /// `--force-if-includes` has anything to say. Canary for the frontend's
    /// `(stale info)` marker — the counterpart of
    /// `refusal_stderr_still_matches_the_frontend_markers` (autostash.rs).
    #[tokio::test]
    async fn force_push_rejection_stderr_still_matches_the_frontend_markers() {
        let (_guard, base, origin_s, url) = seeded_origin("stale-info").await;
        let base_s = base.to_string_lossy().into_owned();

        for name in ["clone1", "clone2"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 moves the shared branch; clone1 never learns of it, so its
        // remote-tracking ref — the lease's expectation — is stale.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["push", "-q"]).await;
        let theirs = run(&clone2_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
            .await
            .expect_err("a stale lease must not clobber the remote");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a git error, got {err:?}")
        };
        assert_rejection_reason(stderr, STALE_LEASE_REJECTION);
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            theirs,
            "clone2's commit is still origin's tip"
        );
    }

    /// A bare push from a renamed tracking branch: git's push.default=simple refusal maps
    /// to the typed error carrying the re-read names, forced or not, and nothing moves on
    /// the remote. Then the two explicit destinations the sync bar's menu offers land
    /// exactly where they say: the tracked branch with tracking untouched, and the new
    /// name on the SAME remote, retracked.
    #[tokio::test]
    async fn a_bare_push_refused_for_a_name_mismatch_names_both_branches() {
        let (_guard, base, origin_s, _url) = seeded_origin("name-mismatch").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        run(&work_s, &["config", "push.default", "simple"]).await;
        for key in ["branch.feat/y.pushRemote", "remote.origin.push"] {
            let out = run_git_raw(
                Some(&work_s),
                &["config", "--get", key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            if out.code != 1 {
                eprintln!("skipping: {key} is set outside the fixture");
                return;
            }
        }
        run(&work_s, &["push", "-q", "origin", "main:refs/heads/feat/x"]).await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        run(
            &work_s,
            &["switch", "-q", "-c", "feat/x", "--track", "origin/feat/x"],
        )
        .await;
        run(&work_s, &["branch", "-m", "feat/x", "feat/y"]).await;
        std::fs::write(base.join("work").join("y.txt"), "y\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "on feat/y"]).await;
        let tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let main_tip = run(&origin_s, &["rev-parse", "refs/heads/main"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        for force in [false, true] {
            let err =
                git_push_core_unpinned(&state, work_s.clone(), false, force, None, None, None)
                    .await
                    .expect_err("git refuses the bare push");
            let AppError::PushUpstreamNameMismatch {
                branch,
                remote,
                remote_branch,
            } = &err
            else {
                panic!("force={force}: expected the typed refusal, got {err:?}")
            };
            assert_eq!(
                (branch.as_str(), remote.as_str(), remote_branch.as_str()),
                ("feat/y", "origin", "feat/x")
            );
        }
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim(),
            main_tip
        );

        // "Push to origin/feat/x": the named destination, tracking untouched.
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            false,
            false,
            Some("feat/y".into()),
            Some("origin".into()),
            Some("feat/x".into()),
        )
        .await
        .expect("push to the tracked branch");
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim(),
            tip
        );
        let upstream = || {
            let work_s = work_s.clone();
            async move {
                run(
                    &work_s,
                    &["rev-parse", "--symbolic-full-name", "feat/y@{upstream}"],
                )
                .await
                .trim()
                .to_string()
            }
        };
        assert_eq!(upstream().await, "refs/remotes/origin/feat/x");

        // "Publish as origin/feat/y": the same remote, retracked to the new name.
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            true,
            false,
            Some("feat/y".into()),
            Some("origin".into()),
            None,
        )
        .await
        .expect("publish under the new name");
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/y"])
                .await
                .trim(),
            tip
        );
        assert_eq!(upstream().await, "refs/remotes/origin/feat/y");
        git_push_core_unpinned(&state, work_s.clone(), false, false, None, None, None)
            .await
            .expect("a bare push works again once the names match");
    }

    /// "Push to origin/<new> and track it" when that branch already exists: the publish
    /// arm fast-forwards it, and refuses rather than overwrite one holding other work.
    #[tokio::test]
    async fn publishing_onto_an_existing_remote_branch_fast_forwards_or_refuses() {
        let (_guard, base, origin_s, _url) = seeded_origin("publish-existing").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        let main_tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let seeds = [
            "HEAD:refs/heads/feat/x",
            "HEAD:refs/heads/feat/y",
            "HEAD:refs/heads/feat/z",
        ];
        run(
            &work_s,
            &[&["push", "-q", "origin"][..], &seeds[..]].concat(),
        )
        .await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        // feat/z on the remote gets work the local branch never saw.
        run(
            &work_s,
            &["switch", "-q", "-c", "other", "--no-track", "origin/feat/z"],
        )
        .await;
        std::fs::write(base.join("work").join("z.txt"), "z\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "remote-only"]).await;
        run(&work_s, &["push", "-q", "origin", "HEAD:refs/heads/feat/z"]).await;
        let z_tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        for (local, full, existing_tip) in [
            ("feat/y", "refs/heads/feat/y", &main_tip),
            ("feat/z", "refs/heads/feat/z", &z_tip),
        ] {
            run(
                &work_s,
                &["switch", "-q", "-c", local, "--track", "origin/feat/x"],
            )
            .await;
            std::fs::write(base.join("work").join("w.txt"), local).unwrap();
            run(&work_s, &["add", "-A"]).await;
            run(&work_s, &["commit", "-qm", local]).await;
            let tip = run(&work_s, &["rev-parse", "HEAD"])
                .await
                .trim()
                .to_string();
            let published = git_push_core_unpinned(
                &state,
                work_s.clone(),
                true,
                false,
                Some(local.to_string()),
                Some("origin".into()),
                None,
            )
            .await;
            let remote_tip = run(&origin_s, &["rev-parse", full])
                .await
                .trim()
                .to_string();
            if existing_tip == &main_tip {
                published.expect("an ancestor fast-forwards");
                assert_eq!(remote_tip, tip);
            } else {
                assert!(published.is_err(), "a diverged remote branch is refused");
                assert_eq!(&remote_tip, existing_tip, "never overwritten");
            }
        }
    }

    /// git refuses a pull-request upstream's bare push with the same message, but there
    /// is no branch to name, so the error passes through untouched. Canary for the
    /// whitespace-collapsed match against git's real, line-wrapped text.
    #[tokio::test]
    async fn a_name_refusal_without_a_branch_upstream_keeps_gits_own_error() {
        let (_guard, base, origin_s, _url) = seeded_origin("pull-upstream").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        run(&work_s, &["config", "push.default", "simple"]).await;
        for key in ["branch.pr-7.pushRemote", "remote.origin.push"] {
            let out = run_git_raw(
                Some(&work_s),
                &["config", "--get", key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            if out.code != 1 {
                eprintln!("skipping: {key} is set outside the fixture");
                return;
            }
        }
        run(
            &origin_s,
            &["update-ref", "refs/pull/7/head", "refs/heads/main"],
        )
        .await;
        run(
            &work_s,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/pull/*/head:refs/remotes/origin/pr/*",
            ],
        )
        .await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        run(
            &work_s,
            &["switch", "-q", "--no-track", "-c", "pr-7", "origin/pr/7"],
        )
        .await;
        run(&work_s, &["config", "branch.pr-7.remote", "origin"]).await;
        run(
            &work_s,
            &["config", "branch.pr-7.merge", "refs/pull/7/head"],
        )
        .await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, work_s.clone(), false, false, None, None, None)
            .await
            .expect_err("git refuses the bare push");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}")
        };
        assert!(is_push_simple_name_refusal(stderr), "{stderr}");
        assert!(!is_push_simple_name_refusal(
            "does not match\nthe name of another branch"
        ));
    }

    /// A push GitHub's secret push protection refused, from a real GH013
    /// rejection measured on this machine (github.com over HTTPS, 2026-08-11).
    /// The flagged secret's own value never appears in the block, and the
    /// unblock id is a placeholder here; two purely informational `(?)` notes
    /// GitHub prints between the violation list and the locations are trimmed.
    /// GitHub pads every one of these lines with trailing spaces, dropped here
    /// because an editor would strip them back out anyway — which is the reason
    /// the frontend markers, and `has_remote_bullet` below, never end-anchor.
    const PUSH_PROTECTION_STDERR: &str = "\
remote: error: GH013: Repository rule violations found for refs/heads/feat/security-findings-phase-3.
remote:
remote: - GITHUB PUSH PROTECTION
remote:   —————————————————————————————————————————
remote:     Resolve the following violations before pushing again
remote:
remote:     - Push cannot contain secrets
remote:
remote:
remote:       —— GitLab Access Token ———————————————————————————————
remote:        locations:
remote:          - commit: 64a012e497764a53e38949a968553daa2d8f51a3
remote:            path: src-tauri/src/forge/gitlab_findings.rs:1151
remote:
remote:        (?) To push, remove secret from commit(s) or follow this URL to allow the secret.
remote:        https://github.com/theBGuy/GitDesktop/security/secret-scanning/unblock-secret/<id>
remote:
remote:
To https://github.com/theBGuy/GitDesktop.git
 ! [remote rejected] feat/security-findings-phase-3 -> feat/security-findings-phase-3 (push declined due to repository rule violations)
error: failed to push some refs to 'https://github.com/theBGuy/GitDesktop.git'
";

    /// A branch simply behind its remote: the negative control for the block
    /// above. It shares the `failed to push some refs` tail, so anything the
    /// frontend anchors on has to come from the push-protection block itself.
    const NON_FAST_FORWARD_STDERR: &str = "\
To https://github.com/theBGuy/GitDesktop.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'https://github.com/theBGuy/GitDesktop.git'
hint: Updates were rejected because the tip of your current branch is behind
";

    /// Whether `report` carries a `remote:` bullet whose text opens with
    /// `label`, matching `PUSH_PROTECTION_MARKERS` (src/lib/error-summary.ts)
    /// exactly: space/tab indent only, the `remote:` prefix, the `-` bullet,
    /// the label at a word boundary — and no end anchor, since git pads the
    /// line. Looser matching here would let the canary pass stderr the
    /// frontend rejects, which is the one direction it must not be loose in.
    fn has_remote_bullet(report: &str, label: &str) -> bool {
        fn eat(s: &str) -> &str {
            s.trim_start_matches([' ', '\t'])
        }
        report.lines().any(|l| {
            eat(l)
                .strip_prefix("remote:")
                .and_then(|r| eat(r).strip_prefix('-'))
                .and_then(|r| eat(r).strip_prefix(label))
                .is_some_and(|rest| {
                    !rest
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_alphanumeric() || c == '_')
                })
        })
    }

    /// Canary for the frontend's push-protection markers: `pushProtectionSummary`
    /// (src/lib/error-summary.ts) can only turn a blocked push into one human
    /// line while GitHub still prints these two bullets, so the measured stderr
    /// and the marker shapes are pinned together here. `GH013` is asserted apart
    /// from them on purpose — it heads every repository rule violation, not just
    /// secrets, so the frontend must never classify on it alone.
    #[test]
    fn push_protection_stderr_still_matches_the_frontend_markers() {
        for label in ["GITHUB PUSH PROTECTION", "Push cannot contain secrets"] {
            assert!(
                has_remote_bullet(PUSH_PROTECTION_STDERR, label),
                "the `{label}` bullet is gone — the frontend summary is now blind to a \
                 blocked push. Actual stderr:\n{PUSH_PROTECTION_STDERR}"
            );
            assert!(
                !has_remote_bullet(NON_FAST_FORWARD_STDERR, label),
                "`{label}` matched a plain non-fast-forward rejection, which must keep its \
                 own presentation"
            );
        }
        assert!(
            !has_remote_bullet(
                "remote: - GITHUB PUSH PROTECTIONAL",
                "GITHUB PUSH PROTECTION"
            ),
            "the label matched past its word boundary — the frontend's \\b would refuse \
             this line, so the canary must too"
        );
        assert!(
            PUSH_PROTECTION_STDERR
                .lines()
                .any(|l| l.trim_start().starts_with("remote: error: GH013:")),
            "the fixture no longer carries the GH013 code it was measured from"
        );
    }

    /// git asked for a username with prompting disabled and nothing in the
    /// credential helper — measured against github.com on git 2.51.1.windows.1,
    /// 2026-09.
    const NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Username for 'https://github.com': terminal prompts disabled
";

    /// Credentials github.com refused, same provenance. The sideband line names
    /// the cause; the `fatal:` line is the one the frontend anchors on.
    const REJECTED_CREDENTIALS_STDERR: &str = "\
remote: Invalid username or token. Password authentication is not supported for Git operations.
fatal: Authentication failed for 'https://github.com/octocat/Hello-World.git/'
";

    /// A push to a repository the authenticated account cannot write, same
    /// provenance: the account is recognized, the permission is not there.
    const FORBIDDEN_STDERR: &str = "\
remote: Permission to octocat/Hello-World.git denied to theBGuy.
fatal: unable to access 'https://github.com/octocat/Hello-World.git/': The requested URL returned error: 403
";

    /// A push dry-run against an archived GitHub repository, same provenance.
    /// Only the `remote:` line is measured verbatim; the `fatal:` line under it is
    /// git's standard curl-error shape, written out rather than captured — hence a
    /// placeholder URL, so this blob makes no claim about a repository another
    /// fixture presents differently.
    const ARCHIVED_STDERR: &str = "\
remote: This repository was archived so it is read-only.
fatal: unable to access 'https://github.com/example/archived.git/': The requested URL returned error: 403
";

    /// A push to a Gitea pull-mirror over plain HTTP, from the user report the
    /// read-only marker was written for (GitDesktop 0.10.0 on Linux, self-hosted
    /// Gitea). The marker-bearing `remote:` line is verbatim; the report's paste
    /// wraps the `fatal:` line after the colon, which git emits on one line, and
    /// the `99xx` port is the reporter's own masking.
    const GITEA_MIRROR_STDERR: &str = "\
remote: mirror repository is read-only
fatal: unable to access 'http://192.168.1.10:99xx/gituser1/GitDesktop/': The requested URL returned error: 403
";

    /// A push dry-run against an archived GitLab project — measured against
    /// gitlab.com on git 2.51.1.windows.1, 2026-09 (`theBGuy/gitdesktop-gitlab-demo`,
    /// archived via the API for this capture and unarchived immediately after).
    /// GitLab's wording carries neither "read-only" nor "repository", so it needs
    /// its own marker rather than widening the generic one.
    const GITLAB_ARCHIVED_STDERR: &str = "\
remote: You can't push code to an archived project.
fatal: unable to access 'https://gitlab.com/theBGuy/gitdesktop-gitlab-demo.git/': The requested URL returned error: 403
";

    /// git asked for a username with prompting disabled and nothing in the
    /// credential helper — measured against gitlab.com, same provenance as the
    /// GitHub fixture above. Same `fatal:` shape: this is git's own wording, not
    /// the host's.
    const GITLAB_NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled
";

    /// The Bitbucket counterpart, from a remote URL carrying an embedded username
    /// (`https://user@bitbucket.org/...` — this app's own Bitbucket remotes are
    /// shaped this way, see `strip_https_userinfo`). Git already has a username, so
    /// it asks for the missing half instead: "Password", not "Username". Measured
    /// against bitbucket.org, same provenance; the account name itself is
    /// immaterial to the shape, so it's swapped for a placeholder here.
    const BITBUCKET_NO_CREDENTIALS_STDERR: &str = "\
fatal: could not read Password for 'https://user@bitbucket.org': terminal prompts disabled
";

    /// Credentials gitlab.com refused, same provenance as the GitHub fixture. The
    /// sideband wording differs by host; the `fatal:` line the frontend anchors on
    /// does not.
    const GITLAB_REJECTED_CREDENTIALS_STDERR: &str = "\
remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password. If a token was provided, it was either incorrect, expired, or improperly scoped. See https://gitlab.com/help/topics/git/troubleshooting_git.md#error-on-git-fetch-http-basic-access-denied
fatal: Authentication failed for 'https://gitlab.com/theBGuy/gitdesktop-gitlab-demo.git/'
";

    /// The Bitbucket counterpart, same provenance.
    const BITBUCKET_REJECTED_CREDENTIALS_STDERR: &str = "\
remote: You may not have access to this repository or it no longer exists in this workspace. If you think this repository exists and you have access, make sure you are authenticated.
fatal: Authentication failed for 'https://bitbucket.org/thebguy1/dispatch-demo.git/'
";

    /// A push to a GitLab project the authenticated account cannot write
    /// (`gitlab-org/gitlab`, a real project this account has read-only access to),
    /// same provenance as the GitHub fixture.
    const GITLAB_FORBIDDEN_STDERR: &str = "\
remote: You are not allowed to push code to this project.
fatal: unable to access 'https://gitlab.com/gitlab-org/gitlab.git/': The requested URL returned error: 403
";

    /// The Bitbucket counterpart, against a repository this account cannot write.
    /// Bitbucket returns the same 403 shape for "no access" and "doesn't exist" —
    /// deliberately, so a probe can't distinguish a private repo from a missing one.
    const BITBUCKET_FORBIDDEN_STDERR: &str = "\
remote: The requested repository either does not exist or you do not have access. If you believe this repository exists and you have access, make sure you're authenticated.
fatal: unable to access 'https://bitbucket.org/atlassian/python-bitbucket.git/': The requested URL returned error: 403
";

    /// `git ls-remote` over SSH with no usable key — measured against gitlab.com
    /// on git 2.51.1.windows.1, 2026-09. The ssh client ends its line with CRLF
    /// while git's own lines use LF; the `\r` is kept byte-exact.
    const GITLAB_SSH_NO_ACCESS_STDERR: &str = "\
git@gitlab.com: Permission denied (publickey).\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// The github.com counterpart, same provenance: identical but for the host.
    const GITHUB_SSH_NO_ACCESS_STDERR: &str = "\
git@github.com: Permission denied (publickey).\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// `git ls-remote` against a local path that doesn't exist, same git,
    /// 2026-09-24. It ends on the same `fatal:` tail as the SSH refusals above.
    const LOCAL_MISSING_PATH_STDERR: &str = "\
fatal: 'C:/definitely-not-a-repo-x7q9z' does not appear to be a git repository
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// `git ls-remote` against an SSH host that doesn't resolve, same provenance;
    /// the ssh line ends in CRLF like the key refusals'.
    const UNRESOLVABLE_HOST_STDERR: &str = "\
ssh: Could not resolve hostname definitely-not-a-host-x7q9z.invalid: Name or service not known\r
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.
";

    /// The chunks the frontend's `/m` regexes see as lines. JS `.` refuses every
    /// LineTerminator and `^` re-anchors after each, while `str::lines` splits on
    /// `\n` alone — and git's sideband re-emits `remote: ` after a BARE `\r` when
    /// it overwrites a progress line, so `lines` would hand two sideband chunks to
    /// one marker as a single matchable line.
    fn js_lines(report: &str) -> impl Iterator<Item = &str> {
        report.split(['\n', '\r', '\u{2028}', '\u{2029}'])
    }

    /// Whether `text` carries `word` at JS `\b` boundaries — `[A-Za-z0-9_]` on
    /// either flank refuses the hit, which is what keeps `read-onlyish` and
    /// `repositoryX` out. `-` is outside that set, so `read-only`'s own hyphen
    /// never ends the word.
    fn contains_word(text: &str, word: &str) -> bool {
        fn is_word_char(c: char) -> bool {
            c.is_ascii_alphanumeric() || c == '_'
        }
        text.match_indices(word).any(|(start, _)| {
            text[..start].chars().next_back().is_none_or(|c| !is_word_char(c))
                && text[start + word.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !is_word_char(c))
        })
    }

    /// Entry one: a `remote:` line naming both a repository and a read-only state.
    /// The JS lookahead makes the two order-independent within the line, and `.`
    /// never crosses a line terminator, so both tokens must sit on the SAME line.
    /// The case tolerance is `[Rr]` only, not a case-insensitive match.
    fn marks_read_only_repository(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.trim_start_matches([' ', '\t'])
                .strip_prefix("remote: ")
                .is_some_and(|rest| {
                    ["repository", "Repository", "repositories", "Repositories"]
                        .iter()
                        .any(|w| contains_word(rest, w))
                        && ["read-only", "Read-only"]
                            .iter()
                            .any(|w| contains_word(rest, w))
                })
        })
    }

    /// Entry two: GitLab's archived-project refusal. Plain substring, not a word
    /// scan — GitLab's own wording is fixed copy, unlike the generic entry above
    /// which has to tolerate a repository name or state description around it.
    fn marks_gitlab_archived_project(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.trim_start_matches([' ', '\t'])
                .starts_with("remote: You can't push code to an archived project.")
        })
    }

    /// Entry three. Line-anchored with no indent tolerance, exactly like the
    /// regex. Covers both halves of git's credential-fill prompt: "Username" when
    /// the remote URL carries none, "Password" when it already has one embedded
    /// (this app's own Bitbucket remotes are shaped that way).
    fn marks_missing_credentials(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.starts_with("fatal: could not read Username for ")
                || l.starts_with("fatal: could not read Password for ")
        })
    }

    /// Entry four, anchored the same way.
    fn marks_rejected_credentials(report: &str) -> bool {
        js_lines(report).any(|l| l.starts_with("fatal: Authentication failed for "))
    }

    /// Entry five: git's curl-level 403. The regex's `[^'\n]*` cannot cross a
    /// quote, so the URL runs to the FIRST `'` on the line and the tail has to
    /// follow immediately. A bare `\r` inside the quotes ends the chunk here while
    /// JS would keep reading — stricter than the frontend, the safe direction.
    fn marks_forbidden_403(report: &str) -> bool {
        js_lines(report).any(|l| {
            l.strip_prefix("fatal: unable to access '")
                .and_then(|r| r.split_once('\''))
                .is_some_and(|(_url, tail)| {
                    tail.starts_with(": The requested URL returned error: 403")
                })
        })
    }

    /// Entry six, `^\S+@\S+: Permission denied \((?=[^)\n]*publickey)`. The
    /// regex's `\S` runs can't cross whitespace, so its `user@host:` token is the
    /// line's whole first word: that word must end in `:` and hold an `@` with a
    /// character on each side before that colon. `is_js_space` is JS's `\s`, which
    /// differs from `char::is_whitespace` on U+0085 and U+FEFF. The method list up
    /// to the first `)` must name `publickey`; a bare `\r`, U+2028, or U+2029
    /// inside it ends the chunk here while JS keeps reading, stricter like entry
    /// five.
    fn marks_ssh_key_refused(report: &str) -> bool {
        fn is_js_space(c: char) -> bool {
            (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
        }
        js_lines(report).any(|l| {
            let (word, rest) = l.split_at(l.find(is_js_space).unwrap_or(l.len()));
            rest.strip_prefix(" Permission denied (")
                .is_some_and(|methods| {
                    methods
                        .split_once(')')
                        .map_or(methods, |(list, _)| list)
                        .contains("publickey")
                })
                && word.strip_suffix(':').is_some_and(|user_host| {
                    user_host
                        .char_indices()
                        .any(|(i, c)| c == '@' && i > 0 && i + 1 < user_host.len())
                })
        })
    }

    /// Rust mirrors of `REMOTE_ACCESS_SUMMARIES` (src/lib/error-summary.ts), in
    /// the frontend's table order.
    const REMOTE_ACCESS_MARKERS: [fn(&str) -> bool; 6] = [
        marks_read_only_repository,
        marks_gitlab_archived_project,
        marks_missing_credentials,
        marks_rejected_credentials,
        marks_forbidden_403,
        marks_ssh_key_refused,
    ];

    /// Positions in [`REMOTE_ACCESS_MARKERS`], named for the pattern each entry
    /// matches — not a 1:1 verdict: `READ_ONLY` and `GITLAB_ARCHIVED` are
    /// different patterns that both resolve to the same toast text
    /// (`READ_ONLY_REPOSITORY_SUMMARY`, error-summary.ts), since GitLab's
    /// archived-project wording is exactly the case that summary describes.
    const READ_ONLY: usize = 0;
    const GITLAB_ARCHIVED: usize = 1;
    const NO_CREDENTIALS: usize = 2;
    const REJECTED_CREDENTIALS: usize = 3;
    const FORBIDDEN_403: usize = 4;
    const SSH_KEY_REFUSED: usize = 5;

    /// The entry `remoteAccessSummary` would pick: the FIRST match in table order,
    /// mirroring its `.find()`. The index is the table POSITION, so order is
    /// precedence — not a unique verdict, since two positions can share one.
    fn first_remote_access_match(report: &str) -> Option<usize> {
        REMOTE_ACCESS_MARKERS.iter().position(|m| m(report))
    }

    /// Canary for the frontend's remote-access markers: `remoteAccessSummary`
    /// (src/lib/error-summary.ts) can only turn a transport or sideband refusal
    /// into one human line while these measured stderr shapes still land on the
    /// entry whose wording was written for them, so the blobs and Rust mirrors of
    /// `REMOTE_ACCESS_SUMMARIES` are pinned together here. Keep the two lists in
    /// step, ORDER INCLUDED — the table's order is precedence, not just layout.
    /// GitLab's credential/permission/archived shapes and Bitbucket's
    /// credential/permission shapes are measured live (gitlab.com, bitbucket.org,
    /// 2026-09); Bitbucket's read-only wording stays absent on purpose — grown
    /// from captured stderr when it's reachable, never from a guess.
    #[test]
    fn remote_access_stderr_still_matches_the_frontend_markers() {
        for (stderr, entry, what) in [
            (NO_CREDENTIALS_STDERR, NO_CREDENTIALS, "no stored credentials"),
            (
                GITLAB_NO_CREDENTIALS_STDERR,
                NO_CREDENTIALS,
                "no stored credentials, on GitLab",
            ),
            (
                BITBUCKET_NO_CREDENTIALS_STDERR,
                NO_CREDENTIALS,
                "no stored password, on a Bitbucket remote with an embedded username",
            ),
            (
                REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials",
            ),
            (
                GITLAB_REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials, on GitLab",
            ),
            (
                BITBUCKET_REJECTED_CREDENTIALS_STDERR,
                REJECTED_CREDENTIALS,
                "rejected credentials, on Bitbucket",
            ),
            (FORBIDDEN_STDERR, FORBIDDEN_403, "a permission refusal"),
            (
                GITLAB_FORBIDDEN_STDERR,
                FORBIDDEN_403,
                "a permission refusal, on GitLab",
            ),
            (
                BITBUCKET_FORBIDDEN_STDERR,
                FORBIDDEN_403,
                "a permission refusal, on Bitbucket",
            ),
            (ARCHIVED_STDERR, READ_ONLY, "an archived repository"),
            (GITEA_MIRROR_STDERR, READ_ONLY, "a read-only mirror"),
            (
                GITLAB_ARCHIVED_STDERR,
                GITLAB_ARCHIVED,
                "an archived GitLab project",
            ),
            (
                GITLAB_SSH_NO_ACCESS_STDERR,
                SSH_KEY_REFUSED,
                "an SSH key refusal, on GitLab",
            ),
            (
                GITHUB_SSH_NO_ACCESS_STDERR,
                SSH_KEY_REFUSED,
                "an SSH key refusal, on GitHub",
            ),
        ] {
            assert_eq!(
                first_remote_access_match(stderr),
                Some(entry),
                "{what} no longer reaches entry {entry} — the toast would explain \
                 something else, or nothing. Actual stderr:\n{stderr}"
            );
        }

        // The TS regex has no `$` anchor, so it matches a line carrying trailing
        // text after the period too (a version banner, a self-managed instance's
        // appended hint) — the Rust mirror must match the SAME set, not a
        // stricter one, or the canary could pass while under-approximating what
        // the frontend actually classifies.
        assert!(
            REMOTE_ACCESS_MARKERS[GITLAB_ARCHIVED](
                "remote: You can't push code to an archived project. Contact an admin.\n"
            ),
            "a trailing-text variant of the archived-project line must still match"
        );

        // All three read-only-family blobs also carry git's generic 403 line, so
        // the read-only/archived verdicts above rest on the table's ORDER rather
        // than on exclusivity.
        for stderr in [ARCHIVED_STDERR, GITEA_MIRROR_STDERR, GITLAB_ARCHIVED_STDERR] {
            assert!(
                REMOTE_ACCESS_MARKERS[FORBIDDEN_403](stderr),
                "a read-only blob lost its 403 line — the fixture no longer exercises \
                 the precedence entry one depends on. Actual stderr:\n{stderr}"
            );
        }

        // The permission blob reaches entry five on its own merits: its `remote:`
        // line reports no repository state, and no earlier entry claims it.
        for earlier in [READ_ONLY, GITLAB_ARCHIVED, NO_CREDENTIALS, REJECTED_CREDENTIALS] {
            assert!(
                !REMOTE_ACCESS_MARKERS[earlier](FORBIDDEN_STDERR),
                "entry {earlier} claimed a plain permission refusal, which has its own \
                 summary"
            );
        }

        // The ssh line's CRLF joint is part of the measured shape; a fixture that
        // lost it would stop exercising the `\r` the frontend regex must tolerate.
        for stderr in [GITLAB_SSH_NO_ACCESS_STDERR, GITHUB_SSH_NO_ACCESS_STDERR] {
            assert!(
                stderr.contains("(publickey).\r\nfatal: "),
                "an SSH fixture lost its measured CRLF joint. Actual stderr:\n{stderr}"
            );
        }

        // These end on the same shared `fatal:` tail as the key refusals, but their
        // own first lines say more than any mapped summary, so no entry may claim
        // them.
        for stderr in [LOCAL_MISSING_PATH_STDERR, UNRESOLVABLE_HOST_STDERR] {
            assert_eq!(
                first_remote_access_match(stderr),
                None,
                "a first-contact failure with a specific first line was claimed by \
                 a remote-access entry. Actual stderr:\n{stderr}"
            );
        }

        // Constructed, not measured: ssh's method list varies, and entry six only
        // needs it to name `publickey`.
        assert_eq!(
            first_remote_access_match("git@example.com: Permission denied (publickey,password).\n"),
            Some(SSH_KEY_REFUSED),
            "a key refusal listing more methods than publickey must still match"
        );

        // Shapes the line anchor, word boundaries, and exact wording refuse.
        // Looser matching here would let the canary pass stderr the frontend
        // leaves raw, which is the one direction it must not be loose in.
        for line in [
            "Add read-only repository guard",          // a commit subject echoed back
            "remote: repository is readonly",          // no hyphen
            "remote: branch main is read-only",        // no repository token
            "remote: this repository is read-onlyish", // past the word boundary
            // Two sideband chunks a bare `\r` separates: neither carries both
            // tokens, and JS `.` cannot span the `\r` to join them.
            "remote: repository access\rremote: mirror is read-only\n",
            // Entry three is anchored at the line start with no indent tolerance.
            "  fatal: could not read Username for 'https://x'",
            // Entry five's quoted run stops at the first `'`, so the tail has to
            // follow that quote and not a later one.
            "fatal: unable to access 'a': 'b': The requested URL returned error: 403",
            // Entry two's wording is GitLab's exact copy — a paraphrase must not
            // borrow its verdict.
            "remote: You cannot push code to an archived project.",
            // Entry six's `user@host:` token must open the line, so ssh's
            // refusal quoted after other text is not ssh's.
            "warning: git@gitlab.com: Permission denied (publickey).",
            // Constructed: a refusal that never involved a key must not get key
            // advice.
            "git@example.com: Permission denied (password).",
            "git@example.com: Permission denied (keyboard-interactive).",
        ] {
            assert_eq!(
                first_remote_access_match(line),
                None,
                "`{line}` matched a remote-access marker the frontend would refuse"
            );
        }
    }

    /// Mirror of `PUSH_TRANSFER_HEADER` / `FETCH_TRANSFER_HEADER`
    /// (src/lib/error-summary.ts), on the trimmed line like the frontend: the
    /// keyword, one space, then ONE token of an optional `[\w.-]+@`, a `[\w.+-]+`
    /// run, `:`, and a non-empty tail. Each class excludes the separator after it,
    /// so the first `@` and the first `:` are the only splits the regex can take.
    fn is_transfer_header(line: &str, keyword: &str) -> bool {
        fn run_then_tail(s: &str) -> bool {
            s.split_once(':').is_some_and(|(run, tail)| {
                !run.is_empty()
                    && run
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
                    && !tail.is_empty()
            })
        }
        let Some(token) = line
            .trim()
            .strip_prefix(keyword)
            .and_then(|r| r.strip_prefix(' '))
        else {
            return false;
        };
        !token.chars().any(char::is_whitespace)
            && (run_then_tail(token)
                || token.split_once('@').is_some_and(|(user, rest)| {
                    !user.is_empty()
                        && user
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
                        && run_then_tail(rest)
                }))
    }

    /// Mirror of `TRANSFER_REF_LINE` (src/lib/error-summary.ts), on the UNTRIMMED
    /// line: a space, one of the documented success flags ` +-*=t`, a space, a
    /// `[…]` status, a lowercase hex range (`..` or `...`), or the bare `branch` /
    /// `tag` / `remote-tracking branch` words, a space run, then a non-space
    /// character with a ` -> ` arrow somewhere after it that a non-space character
    /// follows.
    fn is_transfer_ref_noise(line: &str) -> bool {
        let Some(rest) = line.strip_prefix(' ') else {
            return false;
        };
        let mut chars = rest.chars();
        if !chars.next().is_some_and(|flag| " +-*=t".contains(flag)) {
            return false;
        }
        let Some(rest) = chars.as_str().strip_prefix(' ') else {
            return false;
        };
        let tail = if let Some(status) = rest.strip_prefix('[') {
            match status.split_once(']') {
                Some((inner, tail)) if !inner.is_empty() => tail,
                _ => return false,
            }
        } else if let Some(tail) = rest.strip_prefix("remote-tracking branch") {
            tail
        } else {
            let is_hex =
                |s: &str| !s.is_empty() && s.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'));
            let (word, tail) = rest.split_at(rest.find(' ').unwrap_or(rest.len()));
            if word != "branch" && word != "tag" {
                let Some((old, new)) = word.split_once("..") else {
                    return false;
                };
                if !(is_hex(old) && is_hex(new.strip_prefix('.').unwrap_or(new))) {
                    return false;
                }
            }
            tail
        };
        let after = tail.trim_start_matches(' ');
        let mut rest = after.chars();
        after.len() < tail.len()
            && rest.next().is_some_and(|c| !c.is_whitespace())
            && rest.as_str().match_indices(" -> ").any(|(i, _)| {
                rest.as_str()[i + 4..]
                    .chars()
                    .next()
                    .is_some_and(|c| !c.is_whitespace())
            })
    }

    /// Mirror of `TRANSFER_DELETED_LINE` (src/lib/error-summary.ts), on the
    /// UNTRIMMED line: ` - [deleted]`, a space run, then exactly one non-space
    /// token (an optional trailing `\r` aside) running to the end.
    fn is_transfer_deleted_noise(line: &str) -> bool {
        let Some(rest) = line.strip_prefix(" - [deleted]") else {
            return false;
        };
        let after = rest.trim_start_matches(' ');
        let token = after.strip_suffix('\r').unwrap_or(after);
        after.len() < rest.len() && !token.is_empty() && !token.chars().any(char::is_whitespace)
    }

    /// Mirror of `isNoiseLine` (src/lib/error-summary.ts), minus its
    /// `Rebasing (x/y)` arm, which no transfer report carries.
    fn is_summary_noise(line: &str) -> bool {
        let t = line.trim();
        t.is_empty()
            || t.starts_with("hint:")
            || is_transfer_header(t, "To")
            || is_transfer_header(t, "From")
            || is_transfer_ref_noise(line)
            || is_transfer_deleted_noise(line)
    }

    /// The line `firstMeaningfulLine` would summarize, before its prefix strip and
    /// space collapse.
    fn first_meaningful(report: &str) -> Option<&str> {
        report.lines().find(|l| !is_summary_noise(l))
    }

    /// `line` with git's column padding collapsed, as the summary shows it.
    fn collapsed(line: &str) -> String {
        line.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// stderr of a git call that must fail, run the way the app's runner runs it.
    async fn failing_stderr(repo: &str, args: &[&str]) -> String {
        match run_git(Some(repo), args, TEST_GIT_HANG_GUARD).await {
            Err(AppError::Git { stderr, .. }) => stderr,
            Err(other) => panic!("expected `git {args:?}` to fail with a git error, got {other:?}"),
            Ok(_) => panic!("expected `git {args:?}` to fail, but it succeeded"),
        }
    }

    /// Canary for the frontend's transfer-report noise family: `firstMeaningfulLine`
    /// (src/lib/error-summary.ts) skips git's `To`/`From` headers and the per-ref
    /// lines carrying a documented success flag, while a `!` line stays meaningful,
    /// so a failed push, pull, or fetch summarizes git's reason rather than a ref
    /// that moved fine. Real repos re-derive the measured shapes against Rust
    /// mirrors of `PUSH_TRANSFER_HEADER`, `FETCH_TRANSFER_HEADER`,
    /// `TRANSFER_REF_LINE`, and `TRANSFER_DELETED_LINE`, in both directions — keep
    /// the two lists in step. The `remote-tracking branch` form needs a
    /// `refs/remotes/*` ref on the remote to reproduce, so it is pinned from its
    /// measured line only.
    #[tokio::test]
    async fn transfer_report_stderr_still_matches_the_frontend_markers() {
        let (_guard, base, _origin_s, url) = seeded_origin("transfer-report").await;
        let base_s = base.to_string_lossy().into_owned();
        for name in ["clone1", "clone2"] {
            run(
                &base_s,
                &["-c", "core.autocrlf=false", "clone", "-q", &url, name],
            )
            .await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 moves main, tags its new tip, and publishes a branch for clone1 to
        // delete later; clone1 commits on the old tip, so the two have diverged.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["tag", "v1"]).await;
        run(
            &clone2_s,
            &[
                "push",
                "-q",
                "origin",
                "main",
                "v1",
                "HEAD:refs/heads/doomed",
            ],
        )
        .await;
        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-qm", "from clone1"]).await;

        // The app's default pull mode, on its fall-through path: the fetch half's
        // report leads, and git's refusal is the reason.
        let pull = failing_stderr(&clone1_s, &["pull", "--ff-only"]).await;
        assert!(
            pull.trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "From")),
            "a refused pull no longer leads with the `From` header. Actual stderr:\n{pull}"
        );
        assert!(
            pull.lines()
                .any(|l| l.contains("-> origin/main") && is_transfer_ref_noise(l)),
            "the pull's fast-forward table line is gone or no longer reads as noise. \
             Actual stderr:\n{pull}"
        );
        assert!(
            first_meaningful(&pull)
                .is_some_and(|l| l.starts_with("fatal: Not possible to fast-forward")),
            "the refused pull would no longer summarize git's reason. Actual stderr:\n{pull}"
        );

        // A local tag the remote's disagrees with: `fetch --tags` refuses to move it,
        // and that `!` line is the reason. Naming `main` adds fetch's bare-word
        // `* branch … -> FETCH_HEAD` line to the same report.
        run(&clone1_s, &["tag", "-f", "v1"]).await;
        let fetch = failing_stderr(&clone1_s, &["fetch", "--tags", "origin", "main"]).await;
        assert!(
            fetch
                .trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "From")),
            "a refused fetch no longer leads with the `From` header. Actual stderr:\n{fetch}"
        );
        assert!(
            fetch.lines().any(|l| l.starts_with(" * branch")
                && collapsed(l).contains("main -> FETCH_HEAD")
                && is_transfer_ref_noise(l)),
            "the fetch's `* branch` line is gone or no longer reads as noise. \
             Actual stderr:\n{fetch}"
        );
        assert!(
            first_meaningful(&fetch).is_some_and(|l| {
                l.trim_start().starts_with("! [rejected]")
                    && collapsed(l).contains("v1 -> v1")
                    && l.contains("(would clobber existing tag)")
            }),
            "the tag-clobber refusal would no longer summarize its `!` line. \
             Actual stderr:\n{fetch}"
        );

        // A rejected branch pushed alongside a new tag and a deletion: neither success
        // line may headline the failure.
        run(&clone1_s, &["tag", "v2"]).await;
        let push = failing_stderr(
            &clone1_s,
            &[
                "push",
                "origin",
                ":refs/heads/doomed",
                "main",
                "refs/tags/v2",
            ],
        )
        .await;
        assert!(
            push.trim()
                .lines()
                .next()
                .is_some_and(|l| is_transfer_header(l, "To")),
            "a rejected push no longer leads with the `To` header. Actual stderr:\n{push}"
        );
        assert!(
            push.lines().any(|l| l.starts_with(" * [new tag]")
                && collapsed(l).contains("v2 -> v2")
                && is_transfer_ref_noise(l)),
            "the new tag's report line is gone or no longer reads as noise. \
             Actual stderr:\n{push}"
        );
        assert!(
            push.lines().any(|l| l.starts_with(" - [deleted]")
                && collapsed(l) == "- [deleted] doomed"
                && is_transfer_deleted_noise(l)),
            "the deletion's report line is gone or no longer reads as noise. \
             Actual stderr:\n{push}"
        );
        assert!(
            first_meaningful(&push).is_some_and(|l| {
                l.trim_start().starts_with("! [rejected]")
                    && collapsed(l).contains("main -> main")
                    && l.contains("(non-fast-forward)")
            }),
            "the rejected push would no longer summarize its `!` line. Actual stderr:\n{push}"
        );

        // Measured on git 2.51.1.windows.1 (a fetch of a `refs/remotes/*` ref): the
        // two-word summary column, followed by a single space.
        assert!(
            is_summary_noise(" * remote-tracking branch mirror/main -> FETCH_HEAD"),
            "the remote-tracking fetch line no longer reads as noise"
        );

        // Shapes the mirrors refuse, as the frontend's own boundary tests do.
        // Looser matching here would let the canary pass a report the frontend
        // summarizes differently.
        for line in [
            " ! [rejected]        main -> main (non-fast-forward)",
            " - make sure the remote still exists",
            " - [deleted]         feat and the rest",
            "Renamed main -> trunk on the remote.",
            "   Fix the parser -> faster builds",
            " * note: main -> trunk",
            " * branches main -> trunk",
            "From /home/u/origin",
            "From here on, retry the fetch.",
        ] {
            assert!(
                !is_summary_noise(line),
                "`{line}` reads as noise here, but the frontend keeps it meaningful"
            );
        }
    }

    /// The wire values the TS `PushGuard` union (src/lib/git/api/sync.ts) mirrors: the
    /// success toast keys on these exact strings, so a variant rename that skips
    /// the mirror would silently stop reporting a degraded force push.
    #[test]
    fn push_guard_serializes_to_the_camel_case_wire_values() {
        for (guard, wire) in [
            (PushGuard::LeaseAndIncludes, "leaseAndIncludes"),
            (PushGuard::LeaseOnlyOldGit, "leaseOnlyOldGit"),
            (PushGuard::LeaseOnlyNoReflog, "leaseOnlyNoReflog"),
        ] {
            assert_eq!(
                serde_json::to_value(&guard).unwrap(),
                serde_json::Value::String(wire.to_string()),
                "{guard:?} must stay on the wire as {wire:?}"
            );
        }
    }

    /// The gap `--force-if-includes` closes, driven end to end: a plain `fetch`
    /// alone satisfies the bare lease, so with the lease only, clone1's amend would
    /// clobber a commit clone2 pushed and clone1 never integrated. Integrating it
    /// (`pull --rebase`) is what lets the same force push land.
    #[tokio::test]
    async fn force_push_refuses_fetched_but_unintegrated_remote_work() {
        let (_guard, base, origin_s, url) = seeded_origin("if-includes").await;
        let base_s = base.to_string_lossy().into_owned();

        for name in ["clone1", "clone2"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 lands a commit of its own on the shared branch.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["push", "-q"]).await;
        let theirs = run(&clone2_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        // clone1 only FETCHES it — the whole point: that alone used to satisfy the
        // lease. Its amend adds a NEW file so the later replay stays conflict-free.
        run(&clone1_s, &["fetch", "-q"]).await;
        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
            .await
            .expect_err("a merely-fetched remote commit must not be clobbered");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a git error, got {err:?}")
        };
        assert_rejection_reason(stderr, IF_INCLUDES_REJECTION);
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            theirs,
            "clone2's commit is still origin's tip"
        );

        // Integrating the remote work unblocks the very same push.
        run(&clone1_s, &["pull", "--rebase", "-q"]).await;
        assert_eq!(
            git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
                .await
                .expect("an integrated branch force-pushes"),
            super::PushGuardWire::LeaseAndIncludes
        );
        let landed = run(&origin_s, &["ls-tree", "--name-only", "refs/heads/main"]).await;
        assert!(
            landed.contains("b.txt") && landed.contains("c.txt"),
            "both sides' work is on the new tip: {landed}"
        );
    }

    /// `--force-if-includes` walks the local branch's REFLOG, so a repo with
    /// reflogs off rejects every force push — even with the remote untouched and
    /// nothing to clobber. The push must still land, degraded to the lease alone
    /// and reported as such.
    #[tokio::test]
    async fn force_push_falls_back_to_the_lease_when_the_branch_has_no_reflog() {
        let (_guard, base, origin_s, url) = seeded_origin("no-reflog").await;
        let base_s = base.to_string_lossy().into_owned();

        // Reflogs off at CLONE time: set afterwards, `.git/logs/` already exists and
        // the check would pass. This is `git clone`'s OWN `-c`, which writes the key
        // into the new repo's config — git's one-shot `-c` (before the subcommand)
        // would not persist, and the first ref update would re-enable reflogs.
        run(
            &base_s,
            &[
                "-c",
                "core.autocrlf=false",
                "clone",
                "-q",
                "-c",
                "core.logAllRefUpdates=false",
                &url,
                "nolog",
            ],
        )
        .await;
        let clone = base.join("nolog");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // Rewrite the tip; the remote is untouched, so the lease has no complaint.
        std::fs::write(clone.join("c.txt"), "mine\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;
        let amended = run(&clone_s, &["rev-parse", "HEAD"]).await.trim().to_string();
        // The discriminating state, in the retry gate's own terms — asserted AFTER
        // the amend, since a ref update would otherwise create the reflog.
        assert!(
            run_git(
                Some(&clone_s),
                &["reflog", "exists", "refs/heads/main"],
                TEST_GIT_HANG_GUARD
            )
            .await
            .is_err(),
            "the fixture's branch must have no reflog for the flag to walk"
        );

        let state = AppState::default();
        assert_eq!(
            git_push_core_unpinned(&state, clone_s.clone(), false, true, None, None, None)
                .await
                .expect("a no-reflog rejection is spurious; the push must still land"),
            super::PushGuardWire::LeaseOnlyNoReflog
        );
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            amended,
            "the amended commit is origin's tip"
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
            build_push_args_today("+main", &up(""), "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/+main:refs/heads/+main"]
        );
    }

    #[test]
    fn push_gone_different_name_publishes_under_local_name() {
        // Deliberate: a gone upstream publishes under the LOCAL name (a fresh
        // `origin/feature`), not the deleted `feat` — matching the "Publish"
        // affordance and toast.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                true,
                false,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_explicit_remote_branch_pins_the_destination_refspec() {
        // Untracked local branch, explicit remote + destination.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A destination name never re-tracks, so `set_upstream` can't add `-u`.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                true,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A gone upstream likewise can't drag the publish arm back in.
        assert_eq!(
            build_push_args_today(
                "local",
                &up("local"),
                "origin",
                true,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // Tracked elsewhere: the refspec still targets `contrib`, upstream untouched.
        assert_eq!(
            build_push_args_today(
                "local",
                &up("local"),
                "origin",
                false,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // `force` keeps its position ahead of the target, as in every other arm.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                false,
                true,
                Some("fork"),
                Some("contrib")
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "fork",
                "refs/heads/local:refs/heads/contrib"
            ]
        );
    }

    /// The routing rule: explicit, else configured, else the live upstream's remote, else
    /// origin.
    #[test]
    fn resolve_push_target_prefers_request_then_configured_then_tracked_then_origin() {
        for (requested, configured, remotename, gone, want) in [
            (Some("x"), Some("fork"), "upstream", false, "x"),
            (Some("x"), None, "upstream", false, "x"),
            (None, Some("fork"), "upstream", false, "fork"),
            (None, Some("fork"), "upstream", true, "fork"),
            (None, Some("fork"), "", false, "fork"),
            (None, None, "upstream", false, "upstream"),
            (None, None, "", false, "origin"),
            (None, None, "upstream", true, "origin"),
        ] {
            assert_eq!(
                resolve_push_target(requested, configured, remotename, gone),
                want,
                "{requested:?} {configured:?} {remotename:?} gone={gone}"
            );
        }
    }

    #[test]
    fn upstream_tracking_fields_counts_the_format_atoms() {
        let atoms = UPSTREAM_TRACKING_FORMAT
            .strip_prefix("--format=")
            .expect("the format is a --format= argument");
        assert_eq!(atoms.split("%00").count(), super::UPSTREAM_TRACKING_FIELDS);
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
            Some((Upstream::Untracked, "".into(), false))
        );
    }

    #[test]
    fn parse_upstream_tracking_gone() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0refs/heads/feat\0origin\0[gone]", "refs/heads/feature"),
            Some((up("feat"), "origin".into(), true))
        );
    }

    #[test]
    fn parse_upstream_tracking_normal() {
        assert_eq!(
            parse_upstream_tracking("refs/heads/feature\0refs/heads/feature\0origin\0[ahead 2]", "refs/heads/feature"),
            Some((up("feature"), "origin".into(), false))
        );
    }

    /// The upstream is its name ON the remote, so a remote-side branch name that looks
    /// like a remote-tracking path stays whole, and a local (`.`) upstream reads the
    /// same way.
    #[test]
    fn parse_upstream_tracking_reads_the_remote_side_name() {
        assert_eq!(
            parse_upstream_tracking(
                "refs/heads/x\0refs/heads/remotes/origin/x\0origin\0",
                "refs/heads/x"
            ),
            Some((up("remotes/origin/x"), "origin".into(), false))
        );
        assert_eq!(
            parse_upstream_tracking("refs/heads/x\0refs/heads/main\0.\0", "refs/heads/x"),
            Some((up("main"), ".".into(), false))
        );
    }

    /// A non-branch upstream (`refs/pull/<n>/head`, which a pull fetch refspec makes
    /// trackable) is pushed under the local name with NO `-u`: there is no branch to
    /// push into, and retracking would drop the branch's pull request association.
    #[test]
    fn parse_upstream_tracking_routes_a_non_branch_upstream_to_a_local_name_copy() {
        let parsed = parse_upstream_tracking(
            "refs/heads/pr-7\0refs/pull/7/head\0origin\0",
            "refs/heads/pr-7",
        );
        assert_eq!(parsed, Some((Upstream::NotABranch, "origin".into(), false)));
        let (upstream, remotename, gone) = parsed.unwrap();
        assert_eq!(
            build_push_args_today(
                "pr-7",
                &upstream,
                &remotename,
                gone,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/pr-7:refs/heads/pr-7"]
        );
    }

    /// A hand-edited bare `branch.<b>.merge = main` on a local (`.`) upstream comes
    /// back raw from `%(upstream:remoteref)`; git DWIMs it to the branch, and so does
    /// the push.
    #[test]
    fn parse_upstream_tracking_reads_a_bare_merge_value_as_the_branch() {
        let parsed = parse_upstream_tracking("refs/heads/x\0main\0.\0", "refs/heads/x");
        assert_eq!(parsed, Some((up("main"), ".".into(), false)));
        let (upstream, remotename, gone) = parsed.unwrap();
        assert_eq!(
            build_push_args_today("x", &upstream, &remotename, gone, false, false, None, None),
            vec!["push", ".", "refs/heads/x:refs/heads/main"]
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

    // --- Push routing, pins and leases (the push package). ---

    /// Today's 8-input argv: no configured push remote, never the create-only lease.
    #[allow(clippy::too_many_arguments)] // the decision table's flat inputs
    fn build_push_args_today(
        branch: &str,
        upstream: &Upstream,
        remotename: &str,
        gone: bool,
        set_upstream: bool,
        force: bool,
        requested: Option<&str>,
        remote_branch: Option<&str>,
    ) -> Vec<String> {
        let route = super::NamedRoute {
            branch,
            upstream,
            remotename,
            gone,
            set_upstream,
            requested,
            configured: None,
            remote_branch,
        };
        super::build_push_args(&route, force, super::CreateLease::NONE)
    }

    /// `git_push_core` with today's seven inputs: no pins, no recorded create.
    async fn git_push_core_unpinned(
        state: &AppState,
        repo_path: String,
        set_upstream: bool,
        force: bool,
        branch: Option<String>,
        remote: Option<String>,
        remote_branch: Option<String>,
    ) -> crate::error::AppResult<super::PushGuardWire> {
        super::git_push_core(
            state,
            repo_path,
            set_upstream,
            force,
            branch,
            remote,
            remote_branch,
            None,
            false,
        )
        .await
    }

    fn pins(branch: &str, head: Option<&str>) -> super::PushPins {
        super::PushPins::from_wire(Some(branch.to_string()), head.map(str::to_string))
            .unwrap()
            .expect("a branch pin")
    }

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The named-push routing table. Mark `u`: the create-only lease when the destination's
    /// tracking ref is unproven or on `creates`; `c`: only on `creates`; `-`: never.
    /// Each row also runs [`super::NamedPushRouting::destination`] against the argv.
    #[test]
    fn named_push_routing_table_and_its_destination_agree() {
        use super::NamedPushDestination::{Refused, To};
        let b = |n: &str| Upstream::Branch(n.to_string());
        let lease = "--force-with-lease=refs/heads/b:";
        #[rustfmt::skip]
        #[allow(clippy::type_complexity)] // one flat tuple per table row
        let rows: Vec<(&str, Upstream, &str, bool, bool, bool, Option<&str>, Option<&str>, Option<&str>, Vec<&str>, char)> = vec![
            ("tracked same, none", b("b"), "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked same, fork", b("b"), "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked other, fork", b("other"), "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked other, origin", b("other"), "origin", false, false, false, None, Some("origin"), None, vec!["push", "origin", "refs/heads/b:refs/heads/other"], 'c'),
            ("tracked other, none", b("other"), "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/other"], 'c'),
            ("untracked, fork", Upstream::Untracked, "", false, false, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("untracked, none", Upstream::Untracked, "", false, false, false, None, None, None, vec!["push", "-u", "origin", "refs/heads/b:refs/heads/b"], 'u'),
            ("gone, none", b("b"), "fork", true, false, false, None, None, None, vec!["push", "-u", "origin", "refs/heads/b:refs/heads/b"], 'u'),
            ("gone, fork", b("b"), "origin", true, false, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("set_upstream up/main", b("main"), "up", false, true, false, None, None, None, vec!["push", "-u", "up", "refs/heads/b:refs/heads/b"], 'u'),
            ("set_upstream same, fork", b("b"), "origin", false, true, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("non-branch, fork", Upstream::NotABranch, "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("non-branch, none", Upstream::NotABranch, "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit X", b("b"), "origin", false, false, false, Some("up"), None, None, vec!["push", "up", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit = configured", b("b"), "origin", false, false, false, Some("fork"), None, None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit + rb", b("b"), "origin", false, false, false, Some("fork"), None, Some("rb"), vec!["push", "fork", "refs/heads/b:refs/heads/rb"], 'c'),
            ("local ., fork", b("main"), ".", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("force", b("b"), "origin", false, false, true, None, None, None, vec!["push", "--force-with-lease", "--force-if-includes", "origin", "refs/heads/b:refs/heads/b"], '-'),
            ("force publish", Upstream::Untracked, "", false, false, true, None, Some("fork"), None, vec!["push", "--force-with-lease", "--force-if-includes", "-u", "fork", "refs/heads/b:refs/heads/b"], '-'),
        ];
        let remotes = sv(&["origin", "fork", "up"]);
        for (
            label,
            upstream,
            remotename,
            gone,
            set,
            force,
            requested,
            configured,
            rb,
            want,
            mark,
        ) in rows
        {
            let route = super::NamedRoute {
                branch: "b",
                upstream: &upstream,
                remotename,
                gone,
                set_upstream: set,
                requested,
                configured,
                remote_branch: rb,
            };
            let with_lease = |argv: &[&str]| {
                let mut v = sv(argv);
                v.insert(1, lease.to_string());
                v
            };
            let leased = with_lease(&want);
            let lease_of = |creates, dest_tracked| {
                route.argv(
                    force,
                    super::CreateLease {
                        creates,
                        dest_tracked,
                    },
                )
            };
            let leased = if rb.is_some() {
                let mut v = sv(&want);
                v.insert(1, "--force-with-lease=refs/heads/rb:".to_string());
                v
            } else if label.starts_with("tracked other, origin") || label == "tracked other, none" {
                let mut v = sv(&want);
                v.insert(1, "--force-with-lease=refs/heads/other:".to_string());
                v
            } else {
                leased
            };
            assert_eq!(lease_of(false, true), sv(&want), "{label}: no lease");
            let untracked = lease_of(false, false);
            let created = lease_of(true, true);
            match mark {
                'u' => {
                    assert_eq!(untracked, leased, "{label}: unproven tracking");
                    assert_eq!(created, leased, "{label}: creates");
                }
                'c' => {
                    assert_eq!(untracked, sv(&want), "{label}: unproven tracking");
                    assert_eq!(created, leased, "{label}: creates");
                }
                _ => {
                    assert_eq!(untracked, sv(&want), "{label}: force");
                    assert_eq!(created, sv(&want), "{label}: force");
                }
            }
            // The destination answers only for no explicit remote, no retrack.
            if requested.is_some() || set {
                continue;
            }
            let listing = match configured {
                Some(c) => format!("branch.b.pushremote\n{c}\0"),
                None => String::new(),
            };
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(&listing),
                remotes: remotes.clone(),
            };
            let target = want[want.len() - 2].to_string();
            let dest = want[want.len() - 1]
                .rsplit_once(":refs/heads/")
                .unwrap()
                .1
                .to_string();
            assert_eq!(
                routing.destination("b", &upstream, remotename, gone),
                To {
                    remote: target,
                    branch: dest
                },
                "{label}: destination"
            );
        }

        // The routing refusals, each answered `Refused` and refused by the call the push
        // makes there: `v` validate_ref_name, `s` the session check, `c` the configured
        // push remote's check, `r` the route's own refusals.
        let mirror = "remote.fork.mirror\ntrue\0branch.b.pushremote\nfork\0";
        #[rustfmt::skip]
        let refused: Vec<(&str, &str, &str, Upstream, &str, char)> = vec![
            ("local . upstream", "b", "", b("main"), ".", 'r'),
            ("mirror push remote", "b", mirror, Upstream::Untracked, "", 'r'),
            ("unusable push remote", "b", "branch.b.pushremote\nnope\0", Upstream::Untracked, "", 'c'),
            ("unlisted upstream remote", "b", "", b("b"), "ghost", 'r'),
            ("dash-named upstream remote", "b", "", b("b"), "-x", 'r'),
            ("branch remote no remote has", "b", "branch.b.remote\nmissing\0", Upstream::Untracked, "", 'u'),
            ("destination holding a colon", "b", "", b("a:b"), "origin", 'r'),
            ("session destination", "b", "", b("gd/session/x"), "origin", 'r'),
            ("invalid branch name", "bad:name", "", Upstream::Untracked, "", 'v'),
            ("session branch", "gd/session/x", "", Upstream::Untracked, "", 's'),
        ];
        let remotes = sv(&["origin", "fork", "up", "-x"]);
        for (label, branch, listing, upstream, remotename, push_side) in refused {
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(listing),
                remotes: remotes.clone(),
            };
            assert_eq!(
                routing.destination(branch, &upstream, remotename, false),
                Refused,
                "{label}"
            );
            let config = &routing.config;
            let refusal = match push_side {
                'v' => crate::git::branches::validate_ref_name(branch).err(),
                's' => super::refuse_publishing_session_branch(branch).err(),
                'c' => super::configured_push_remote_checked(config, &remotes, branch).err(),
                'u' => {
                    super::untracked_branch_remote(config, &remotes, branch, &upstream, remotename)
                        .err()
                }
                _ => {
                    let configured =
                        super::configured_push_remote_checked(config, &remotes, branch).unwrap();
                    let route = super::NamedRoute {
                        branch,
                        upstream: &upstream,
                        remotename,
                        gone: false,
                        set_upstream: false,
                        requested: None,
                        configured,
                        remote_branch: None,
                    };
                    route
                        .refuse(config, &remotes, super::CrossNameUpstream::Follow)
                        .err()
                }
            };
            assert!(refusal.is_some(), "{label}: the push's own check");
        }

        // An untracked read publishes by D2 whatever `branch.<b>.remote` holds: a listed
        // remote (no merge key, or no fetch refspec, reads untracked), `.`, a URL or a path
        // goes to the configured push remote, else origin, on the row and the push alike.
        for (listing, remote) in [
            ("branch.b.remote\nfork\0", "origin"),
            ("branch.b.remote\nfork\0remote.pushdefault\nup\0", "up"),
            ("branch.b.remote\n.\0", "origin"),
            ("branch.b.remote\nhttps://example.invalid/r.git\0", "origin"),
            ("branch.b.remote\n../r.git\0", "origin"),
            ("branch.b.remote\nmirrors/fork.git\0", "origin"),
        ] {
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(listing),
                remotes: remotes.clone(),
            };
            assert_eq!(
                routing.destination("b", &Upstream::Untracked, "", false),
                To {
                    remote: remote.to_string(),
                    branch: "b".to_string()
                },
                "{listing:?}"
            );
            assert_eq!(
                super::untracked_branch_remote(
                    &routing.config,
                    &remotes,
                    "b",
                    &Upstream::Untracked,
                    ""
                )
                .unwrap(),
                "",
                "{listing:?}: the push"
            );
        }

        // A destination with a leading dash is a valid ref behind `refs/heads/`: it routes.
        let dashed = b("-x");
        let routing = super::NamedPushRouting {
            config: crate::git::status::PushConfig::from_listing(""),
            remotes: remotes.clone(),
        };
        assert_eq!(
            routing.destination("b", &dashed, "origin", false),
            To {
                remote: "origin".to_string(),
                branch: "-x".to_string()
            }
        );
        let route = super::NamedRoute {
            branch: "b",
            upstream: &dashed,
            remotename: "origin",
            gone: false,
            set_upstream: false,
            requested: None,
            configured: None,
            remote_branch: None,
        };
        assert_eq!(
            route.argv(false, super::CreateLease::NONE),
            sv(&["push", "origin", "refs/heads/b:refs/heads/-x"])
        );
    }

    /// An unusable configured push remote names the key that won, for each key and shape.
    #[test]
    fn an_unusable_configured_push_remote_names_its_key() {
        let remotes = sv(&["origin", "fork"]);
        let own = "branch.b.pushRemote";
        let pd = "remote.pushDefault";
        #[rustfmt::skip]
        let rows = [
            ("branch.b.pushremote\n\0", own, ""),
            ("branch.b.pushremote\nbad:name\0", own, "bad:name"),
            ("branch.b.pushremote\nghost\0", own, "ghost"),
            ("remote.pushdefault\n\0", pd, ""),
            ("remote.pushdefault\nbad:name\0", pd, "bad:name"),
            ("remote.pushdefault\nghost\0", pd, "ghost"),
            ("remote.pushdefault\nfork\0branch.b.pushremote\n\0", own, ""),
            // A URL's userinfo is redacted; scheme, host and path still name the value.
            ("branch.b.pushremote\nhttps://user:token@host/o/r\0", own, "https://***@host/o/r"),
            ("remote.pushdefault\nhttps://token@host/o/r\0", pd, "https://***@host/o/r"),
            ("branch.b.pushremote\nuser:pass@host:o/r.git\0", own, "***@host:o/r.git"),
            ("branch.b.pushremote\nssh://git@host:22/o/r\0", own, "ssh://***@host:22/o/r"),
            ("branch.b.pushremote\nhttps://host/o/r\0", own, "https://host/o/r"),
            ("remote.pushdefault\nme@work\0", pd, "me@work"),
        ];
        for (listing, key, value) in rows {
            let config = crate::git::status::PushConfig::from_listing(listing);
            match super::configured_push_remote_checked(&config, &remotes, "b") {
                Err(AppError::PushRemoteUnusable {
                    branch,
                    key: k,
                    value: v,
                }) => {
                    assert_eq!((branch.as_str(), k.as_str(), v.as_str()), ("b", key, value))
                }
                other => panic!("{listing:?}: {other:?}"),
            }
        }
        let config = crate::git::status::PushConfig::from_listing("remote.pushdefault\nfork\0");
        assert_eq!(
            super::configured_push_remote_checked(&config, &remotes, "b").unwrap(),
            Some("fork")
        );
        let none = crate::git::status::PushConfig::from_listing("");
        assert_eq!(
            super::configured_push_remote_checked(&none, &remotes, "b").unwrap(),
            None
        );
    }

    /// The remote a HEAD push authenticates against: git's own routing for the bare push
    /// (None for an empty winner), the configured push remote else origin for `-u`.
    #[test]
    fn head_push_remote_follows_the_route() {
        use super::HeadRoute::{Bare, Publish};
        let remotes = sv(&["origin", "fork"]);
        let read = |listing: &str, route, head: Option<&str>, tracking| {
            let config = crate::git::status::PushConfig::from_listing(listing);
            super::head_push_remote(&config, route, head, &remotes, tracking)
        };
        let on = |listing: &str, route, head: Option<&str>| read(listing, route, head, None);
        let some = |r: &str| Some(r.to_string());
        assert_eq!(
            on("remote.solo.url\nu\0", Bare, Some("feat")).unwrap(),
            some("solo")
        );
        for push_default in ["simple", "current", "upstream", "matching"] {
            let triangular = format!(
                "push.default\n{push_default}\0branch.feat.remote\norigin\0branch.feat.pushremote\nfork\0"
            );
            assert_eq!(
                on(&triangular, Bare, Some("feat")).unwrap(),
                some("fork"),
                "{push_default}"
            );
        }
        assert_eq!(
            on(
                "remote.pushdefault\nfork\0branch.feat.remote\norigin\0",
                Bare,
                Some("feat")
            )
            .unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\n\0", Bare, Some("feat")).unwrap(),
            None
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Bare, None).unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Publish, Some("feat")).unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Publish, None).unwrap(),
            some("origin")
        );
        assert_eq!(on("", Publish, Some("feat")).unwrap(), some("origin"));
        assert!(matches!(
            on("branch.feat.pushremote\nnope\0", Publish, Some("feat")),
            Err(AppError::PushRemoteUnusable { .. })
        ));

        // An Untracked HEAD publishes by D2 whatever `branch.<b>.remote` holds, except an
        // unlisted plain name with no push remote configured, refused as the named route
        // refuses it; a tracked HEAD and a configured push remote are not.
        let untracked = Some((&Upstream::Untracked, ""));
        let ghost = "branch.feat.remote\nghost\0";
        assert!(matches!(
            read(ghost, Publish, Some("feat"), untracked),
            Err(AppError::InvalidArgument(m)) if m == "unknown remote: ghost"
        ));
        for listing in [
            "branch.feat.remote\nfork\0",
            "branch.feat.remote\nmirrors/fork.git\0",
            "",
        ] {
            assert_eq!(
                read(listing, Publish, Some("feat"), untracked).unwrap(),
                some("origin"),
                "{listing:?}"
            );
        }
        let pushdefault = format!("{ghost}remote.pushdefault\nfork\0");
        assert_eq!(
            read(&pushdefault, Publish, Some("feat"), untracked).unwrap(),
            some("fork")
        );
        let tracked = Upstream::Branch("feat".to_string());
        assert_eq!(
            read(ghost, Publish, Some("feat"), Some((&tracked, "ghost"))).unwrap(),
            some("origin")
        );
    }

    #[test]
    fn push_guard_wire_serializes_to_the_camel_case_wire_values() {
        use super::PushGuardWire;
        for (guard, wire) in [
            (PushGuardWire::LeaseAndIncludes, "leaseAndIncludes"),
            (PushGuardWire::LeaseOnlyOldGit, "leaseOnlyOldGit"),
            (PushGuardWire::LeaseOnlyNoReflog, "leaseOnlyNoReflog"),
            (
                PushGuardWire::LeasePinnedNoTrackingReflog,
                "leasePinnedNoTrackingReflog",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(&guard).unwrap(),
                serde_json::Value::String(wire.to_string()),
            );
        }
        assert_eq!(
            PushGuardWire::from(PushGuard::LeaseOnlyOldGit),
            PushGuardWire::LeaseOnlyOldGit
        );
    }

    #[test]
    fn push_pins_parse_the_wire_form() {
        use super::PushPins;
        let hex40 = "A".repeat(40);
        let hex64 = "b".repeat(64);
        assert!(PushPins::from_wire(None, None).unwrap().is_none());
        assert!(PushPins::from_wire(Some("HEAD".into()), None)
            .unwrap()
            .is_some());
        assert!(PushPins::from_wire(Some("feat".into()), Some(hex40))
            .unwrap()
            .is_some());
        assert!(
            PushPins::from_wire(Some("feat".into()), Some(hex64.clone()))
                .unwrap()
                .is_some()
        );
        for (branch, head) in [
            (None, Some(hex64)),
            (Some("feat".to_string()), Some("abc".to_string())),
            (Some("feat".to_string()), Some("g".repeat(40))),
        ] {
            assert!(matches!(
                PushPins::from_wire(branch, head),
                Err(AppError::InvalidArgument(_))
            ));
        }
        assert_eq!(
            super::create_lease_arg("feat"),
            "--force-with-lease=refs/heads/feat:"
        );
        assert_eq!(
            super::pinned_lease_arg("a", "0123"),
            "--force-with-lease=refs/heads/a:0123"
        );
    }

    /// Adds a bare `fork` remote beside `seeded_origin`'s origin; returns its path.
    async fn add_fork(base: &std::path::Path, work: &str) -> String {
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "fork.git"]).await;
        let fork = base.join("fork.git").to_string_lossy().into_owned();
        let url = format!("file://{}", fork.replace('\\', "/"));
        run(work, &["remote", "add", "fork", &url]).await;
        run(work, &["config", "remote.fork.mirror", "false"]).await;
        fork
    }

    async fn tip_of(repo: &str, full_ref: &str) -> Option<String> {
        run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", full_ref],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout_lossy().trim().to_string())
    }

    /// The MCP core follows the configured push remote for a same-name push, and keeps the
    /// cross-name refusal when its push remote is another remote or a mirror.
    #[tokio::test]
    async fn mcp_named_push_follows_the_push_remote_but_keeps_the_cross_name_refusal() {
        let (_guard, base, origin, _url) = seeded_origin("mcp-push-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "x"]).await;
        run(&work, &["push", "-q", "-u", "origin", "x"]).await;
        run(&work, &["commit", "-qm", "on x", "--allow-empty"]).await;
        run(&work, &["config", "branch.x.pushRemote", "fork"]).await;
        let origin_x = tip_of(&origin, "refs/heads/x").await;
        git_push_same_name_core(&state, work.clone(), false, Some("x".into()), None)
            .await
            .expect("a same-name push follows the push remote");
        assert_eq!(
            tip_of(&fork, "refs/heads/x").await,
            tip_of(&work, "refs/heads/x").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/x").await, origin_x);
        assert_eq!(
            run(&work, &["config", "branch.x.remote"]).await.trim(),
            "origin"
        );

        run(&work, &["checkout", "-q", "-b", "y", "origin/main"]).await;
        run(&work, &["commit", "-qm", "on y", "--allow-empty"]).await;
        run(&work, &["config", "branch.y.pushRemote", "fork"]).await;
        let main = tip_of(&origin, "refs/heads/main").await;
        for mirror in [false, true] {
            run(
                &work,
                &["config", "remote.fork.mirror", &mirror.to_string()],
            )
            .await;
            let err = git_push_same_name_core(&state, work.clone(), false, Some("y".into()), None)
                .await
                .expect_err("a cross-name push refuses");
            assert!(
                matches!(&err, AppError::PushUpstreamNameMismatch { remote_branch, .. } if remote_branch == "main"),
                "mirror={mirror}: {err:?}"
            );
            assert_eq!(tip_of(&origin, "refs/heads/main").await, main);
            assert_eq!(tip_of(&fork, "refs/heads/y").await, None);
        }
    }

    /// The HEAD `-u` publish goes to the configured push remote and tracks it; an
    /// unusable one refuses with nothing pushed anywhere.
    #[tokio::test]
    async fn head_publish_follows_the_configured_push_remote() {
        let (_guard, base, origin, _url) = seeded_origin("head-publish-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "b"]).await;
        run(&work, &["commit", "-qm", "on b", "--allow-empty"]).await;
        run(&work, &["config", "remote.pushDefault", "fork"]).await;
        git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect("the HEAD publish lands on the push remote");
        assert_eq!(
            tip_of(&fork, "refs/heads/b").await,
            tip_of(&work, "refs/heads/b").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/b").await, None);
        assert_eq!(
            run(&work, &["config", "branch.b.remote"]).await.trim(),
            "fork"
        );

        run(&work, &["checkout", "-q", "-b", "c"]).await;
        run(&work, &["config", "branch.c.pushRemote", "nope"]).await;
        let err = git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("an unusable push remote refuses");
        assert!(
            matches!(&err, AppError::PushRemoteUnusable { key, value, .. } if key == "branch.c.pushRemote" && value == "nope"),
            "{err:?}"
        );
        assert_eq!(tip_of(&fork, "refs/heads/c").await, None);
        assert_eq!(tip_of(&origin, "refs/heads/c").await, None);
    }

    /// The HEAD publish of an untracked branch with no push remote: an unlisted
    /// `branch.<b>.remote` refuses with nothing pushed; a listed one publishes to origin.
    #[tokio::test]
    async fn head_publish_refuses_an_unlisted_branch_remote() {
        let (_guard, base, origin, _url) =
            seeded_origin_unpinned_push_default("head-publish-ghost").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "on feat", "--allow-empty"]).await;
        run(&work, &["config", "branch.feat.remote", "ghost"]).await;
        let err = git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("an unlisted branch remote refuses");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m == "unknown remote: ghost"),
            "{err:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/feat").await, None);
        assert_eq!(tip_of(&fork, "refs/heads/feat").await, None);

        run(&work, &["config", "branch.feat.remote", "fork"]).await;
        git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect("a listed branch remote publishes to origin");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await,
            tip_of(&work, "refs/heads/feat").await
        );
        assert_eq!(tip_of(&fork, "refs/heads/feat").await, None);
    }

    /// An empty `remote.pushDefault` leaves a bare push no destination: no credentials
    /// are built and git's own refusal stands.
    #[tokio::test]
    async fn an_empty_push_default_bare_push_is_gits_refusal() {
        let (_guard, base, _origin, _url) = seeded_origin_unpinned_push_default("empty-pd").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "remote.pushDefault", ""]).await;
        run(&work, &["commit", "-qm", "more", "--allow-empty"]).await;
        let state = AppState::default();
        match git_push_core_unpinned(&state, work, false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => assert!(
                stderr.contains("No configured push destination"),
                "{stderr}"
            ),
            other => panic!("expected git's refusal, got {other:?}"),
        }
    }

    /// Runs `git <args>` in `repo` synchronously, for a hook.
    fn git_sync(repo: &str, args: &[&str]) {
        let status = std::process::Command::new("git")
            .test_git_env()
            .current_dir(repo)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A pinned push re-reads HEAD at spawn: HEAD moved to another branch while the push
    /// waits on the network lock refuses the bare and the force push; one more commit on
    /// the same branch lands the plain push and refuses the force push's tip pin. Unpinned,
    /// the moved-HEAD bare push still runs (the negative control).
    #[tokio::test(flavor = "multi_thread")]
    async fn pinned_pushes_recheck_head_and_tip_at_spawn() {
        let (_guard, base, origin, _url) = seeded_origin("pinned-recheck").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "other"]).await;
        let state = AppState::default();
        for force in [false, true] {
            run(&work, &["commit", "-qm", "next", "--allow-empty"]).await;
            let tip = tip_of(&work, "refs/heads/main").await.unwrap();
            let published = tip_of(&origin, "refs/heads/main").await;
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let work = work.clone();
                move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
            });
            let head = force.then_some(tip.as_str());
            let push = super::git_push_core(
                &state,
                work.clone(),
                false,
                force,
                None,
                None,
                None,
                Some(pins("main", head)),
                false,
            );
            let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "main"),
                "force={force}: {result:?}"
            );
            assert_eq!(tip_of(&origin, "refs/heads/main").await, published);
            run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        }

        // One more commit on the same branch during the wait.
        let hook = || -> std::sync::Arc<dyn Fn() + Send + Sync> {
            let work = work.clone();
            std::sync::Arc::new(move || {
                git_sync(&work, &["commit", "-qm", "late", "--allow-empty"])
            })
        };
        let tip = tip_of(&work, "refs/heads/main").await.unwrap();
        let published = tip_of(&origin, "refs/heads/main").await;
        let push = super::git_push_core(
            &state,
            work.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("main", Some(&tip))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook(), push).await;
        assert!(
            matches!(&result, Err(AppError::PushTipMoved { branch }) if branch == "main"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, published);
        let push = super::git_push_core(
            &state,
            work.clone(),
            false,
            false,
            None,
            None,
            None,
            Some(pins("main", None)),
            false,
        );
        NETWORK_LOCK_WAIT_HOOK
            .scope(hook(), push)
            .await
            .expect("a branch-only pin lands a commit made on the same branch");
        assert_eq!(
            tip_of(&origin, "refs/heads/main").await,
            tip_of(&work, "refs/heads/main").await
        );

        // Negative control: unpinned, the moved-HEAD push runs and pushes `other`, which
        // tracks a same-named branch so `simple` sends it.
        run(&work, &["push", "-q", "-u", "origin", "other"]).await;
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/other"]).await;
        run(&work, &["commit", "-qm", "on other", "--allow-empty"]).await;
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        let main_published = tip_of(&origin, "refs/heads/main").await;
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let work = work.clone();
            move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
        });
        let push = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        NETWORK_LOCK_WAIT_HOOK
            .scope(hook, push)
            .await
            .expect("an unpinned push follows the moved HEAD");
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await,
            tip_of(&work, "refs/heads/other").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_published);
    }

    /// The no-local-reflog degrade retry is a second spawn, so it re-checks the pins: HEAD
    /// moved on the hook's SECOND firing refuses it and nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_rechecks_the_pins() {
        let (_guard, base, origin_s, url) = seeded_origin("degrade-recheck").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &[
                "-c",
                "core.autocrlf=false",
                "clone",
                "-q",
                "-c",
                "core.logAllRefUpdates=false",
                &url,
                "nolog",
            ],
        )
        .await;
        let clone_s = base.join("nolog").to_string_lossy().into_owned();
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;
        run(&clone_s, &["branch", "other"]).await;
        run(
            &clone_s,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "amended"],
        )
        .await;
        let amended = tip_of(&clone_s, "refs/heads/main").await.unwrap();
        let published = tip_of(&origin_s, "refs/heads/main").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, clone_s) = (std::sync::Arc::clone(&fired), clone_s.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&clone_s, &["symbolic-ref", "HEAD", "refs/heads/other"]);
                }
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            clone_s.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("main", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        assert_eq!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "{result:?}"
        );
        assert!(
            matches!(&result, Err(AppError::PushHeadMoved { .. })),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin_s, "refs/heads/main").await, published);
    }

    /// The ambient-credential retry re-checks the pins: the injected run's rejecting hook
    /// moves HEAD, so the retry refuses; unpinned (the negative control) it lands.
    #[tokio::test]
    async fn the_ambient_retry_rechecks_the_pins() {
        let (_guard, work, origin) = keep_local_origin("pinned-ambient").await;
        run(&work, &["branch", "other"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "next"]).await;
        let dir = std::path::Path::new(&work).with_file_name("reject-and-move");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pre-push");
        std::fs::write(
            &file,
            "#!/bin/sh\ngit symbolic-ref HEAD refs/heads/other\necho 'fatal: Authentication failed for origin' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let moving = vec![format!(
            "core.hooksPath={}",
            dir.to_string_lossy().replace('\\', "/")
        )];
        let argv = ["push", "origin", "refs/heads/feat/x:refs/heads/feat/x"];
        let published = feat_x_tip(&origin).await;
        let pinned = pins("feat/x", None);
        let recheck = Some(super::SpawnRecheck {
            route: super::RecheckRoute::Named("feat/x"),
            pins: Some(&pinned),
            force: false,
            lease: None,
        });
        let result =
            super::run_git_with_creds_rechecked(&work, &moving, &argv, NETWORK_TIMEOUT, recheck)
                .await;
        assert!(
            matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "feat/x"),
            "{:?}",
            result.map(|o| o.code)
        );
        assert_eq!(feat_x_tip(&origin).await, published);

        run(&work, &["symbolic-ref", "HEAD", "refs/heads/feat/x"]).await;
        let recheck = Some(super::SpawnRecheck::named("feat/x"));
        let out =
            super::run_git_with_creds_rechecked(&work, &moving, &argv, NETWORK_TIMEOUT, recheck)
                .await
                .unwrap();
        assert_eq!(
            out.code,
            0,
            "unpinned ambient retry: {}",
            out.full_failure_text()
        );
        assert_eq!(feat_x_tip(&origin).await, feat_x_tip(&work).await);
    }

    /// Puts `sha` on `remote`'s `refs/heads/feat` and drops this clone's tracking ref, so
    /// the destination exists unfetched.
    async fn plant_unfetched(work: &str, remote: &str, sha: &str) {
        run(work, &["branch", "-f", "plant", sha]).await;
        run(work, &["push", "-q", "-f", remote, "plant:feat"]).await;
        let tracking = format!("refs/remotes/{remote}/feat");
        let _ = run_git_raw(
            Some(work),
            &["update-ref", "-d", &tracking],
            TEST_GIT_HANG_GUARD,
        )
        .await;
        assert_eq!(tip_of(work, &tracking).await, None);
    }

    /// The `-u` arm's create-only lease, one row per remote state: absent creates; the
    /// same commit is clean; an unfetched ancestor or unrelated tip is refused with the
    /// remote unchanged (and, as the negative control, the same push without the lease
    /// fast-forwards the ancestor); a fetched branch takes no lease.
    #[tokio::test]
    async fn the_publish_arm_carries_the_create_only_lease() {
        let (_guard, base, origin, _url) = seeded_origin("create-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let feat = tip_of(&work, "refs/heads/feat").await.unwrap();
        let tree = run(&work, &["rev-parse", "feat^{tree}"])
            .await
            .trim()
            .to_string();
        let unrelated = run(&work, &["commit-tree", &tree, "-m", "unrelated"])
            .await
            .trim()
            .to_string();
        let publish = || {
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                None,
                None,
            )
        };
        let reset = |work: String| async move {
            let _ = run_git_raw(
                Some(&work),
                &["config", "--unset", "branch.feat.remote"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["config", "--unset", "branch.feat.merge"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["push", "-q", "origin", ":refs/heads/feat"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["update-ref", "-d", "refs/remotes/origin/feat"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
        };

        publish().await.expect("an absent destination is created");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );
        assert_eq!(
            run(&work, &["config", "branch.feat.remote"]).await.trim(),
            "origin"
        );

        reset(work.clone()).await;
        plant_unfetched(&work, "origin", &feat).await;
        publish().await.expect("the same commit exits clean");
        assert_eq!(
            run(&work, &["config", "branch.feat.remote"]).await.trim(),
            "origin"
        );

        for (row, planted) in [("ancestor", &main), ("unrelated", &unrelated)] {
            reset(work.clone()).await;
            plant_unfetched(&work, "origin", planted).await;
            let err = publish().await.expect_err(row);
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "{row}: {err:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(planted.as_str()),
                "{row}"
            );
        }
        // Negative control: the same argv without the lease fast-forwards the ancestor.
        reset(work.clone()).await;
        plant_unfetched(&work, "origin", &main).await;
        run(
            &work,
            &[
                "push",
                "-q",
                "-u",
                "origin",
                "refs/heads/feat:refs/heads/feat",
            ],
        )
        .await;
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );

        // A fetched existing branch: no lease, a fast-forward.
        reset(work.clone()).await;
        run(&work, &["branch", "-f", "plant", &main]).await;
        run(&work, &["push", "-q", "origin", "plant:feat"]).await;
        assert!(tip_of(&work, "refs/remotes/origin/feat").await.is_some());
        publish().await.expect("a fetched branch fast-forwards");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );
    }

    /// The copy arm leases only on `creates`: without it an unfetched ancestor on the
    /// other remote fast-forwards (the recorded consequence); with it, it is refused.
    #[tokio::test]
    async fn the_copy_arm_leases_only_on_creates() {
        let (_guard, base, _origin, _url) = seeded_origin("copy-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["push", "-q", "-u", "origin", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let feat = tip_of(&work, "refs/heads/feat").await.unwrap();
        for creates in [true, false] {
            plant_unfetched(&work, "fork", &main).await;
            let result = super::git_push_core(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                Some("fork".into()),
                None,
                None,
                creates,
            )
            .await;
            if creates {
                assert!(
                    matches!(&result, Err(AppError::PushDestinationExists { remote, .. }) if remote == "fork"),
                    "{result:?}"
                );
                assert_eq!(
                    tip_of(&fork, "refs/heads/feat").await.as_deref(),
                    Some(main.as_str())
                );
            } else {
                result.expect("no create recorded: the copy fast-forwards");
                assert_eq!(
                    tip_of(&fork, "refs/heads/feat").await.as_deref(),
                    Some(feat.as_str())
                );
            }
        }
    }

    /// A bare origin whose `a` is one commit past `main`, cloned fresh, `a` switched to and
    /// amended: (guard, base, origin, url, clone, amended tip).
    async fn fresh_clone_amended(
        tag: &str,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        String,
        String,
        String,
        String,
    ) {
        let (guard, base, origin, url) = seeded_origin(tag).await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "a"]).await;
        run(&work, &["commit", "-qm", "on a", "--allow-empty"]).await;
        run(&work, &["push", "-q", "origin", "a"]).await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "fresh"],
        )
        .await;
        let fresh = base.join("fresh").to_string_lossy().into_owned();
        run(&fresh, &["config", "user.email", "t@t.local"]).await;
        run(&fresh, &["config", "user.name", "T"]).await;
        run(&fresh, &["config", "remote.origin.mirror", "false"]).await;
        run(&fresh, &["switch", "-q", "a"]).await;
        run(
            &fresh,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "--amend",
                "-m",
                "rewritten",
            ],
        )
        .await;
        let amended = tip_of(&fresh, "refs/heads/a").await.unwrap();
        (guard, base, origin, url, fresh, amended)
    }

    /// The three legs of the tracking-reflog degrade retry, on fixtures, independent of
    /// whether this git reproduces the false refusal.
    #[tokio::test]
    async fn the_tracking_reflog_retry_needs_all_three_legs() {
        let (_guard, _base, _origin, _url, fresh, _amended) = fresh_clone_amended("fii-legs").await;
        let tracking = "refs/remotes/origin/a";
        let pre = tip_of(&fresh, tracking).await.unwrap();
        let main = tip_of(&fresh, "refs/remotes/origin/main").await.unwrap();
        let allowed = |pre: String| {
            let fresh = fresh.clone();
            async move {
                super::tracking_reflog_retry_allowed(&fresh, "refs/heads/a", tracking, &pre).await
            }
        };
        let entries = run(
            &fresh,
            &["reflog", "show", "-n", "1", "--format=%H", tracking],
        )
        .await;
        if entries.trim().is_empty() {
            assert!(allowed(pre.clone()).await, "fresh clone + amend");
        } else {
            eprintln!(
                "this git writes a reflog for a cloned tracking ref; the fresh-clone row is moot"
            );
        }
        assert!(
            !allowed(main.clone()).await,
            "tracking ref moved since the pre-read"
        );

        // A branch re-pointed at a tip its reflog never held.
        run(&fresh, &["branch", "c", "origin/main"]).await;
        run(&fresh, &["branch", "-q", "--set-upstream-to=origin/a", "c"]).await;
        assert!(
            !super::tracking_reflog_retry_allowed(&fresh, "refs/heads/c", tracking, &pre).await,
            "--set-upstream-to at an unheld tip"
        );

        run(
            &fresh,
            &[
                "update-ref",
                "--create-reflog",
                "-m",
                "away",
                tracking,
                &main,
            ],
        )
        .await;
        run(&fresh, &["update-ref", "-m", "back", tracking, &pre]).await;
        assert!(
            !allowed(pre.clone()).await,
            "a tracking reflog with one entry"
        );
        run(&fresh, &["reflog", "expire", "--expire=now", tracking]).await;
        assert!(
            run(&fresh, &["reflog", "show", "--format=%H", tracking])
                .await
                .trim()
                .is_empty(),
            "the expired reflog has no entries"
        );
        assert!(allowed(pre).await, "a tracking reflog with zero entries");
    }

    /// The pinned force push lands on a fresh clone whatever this git does about the
    /// missing tracking reflog; a remote moved by another clone and not fetched is still
    /// refused; the MCP core, on a fixture of its own, never takes the arm.
    #[tokio::test]
    async fn a_pinned_force_push_lands_on_a_fresh_clone() {
        let state = AppState::default();
        let (_mcp_guard, _, mcp_origin, _, mcp_fresh, mcp_amended) =
            fresh_clone_amended("fii-mcp").await;
        match super::git_force_push_head_core(&state, mcp_fresh).await {
            Ok(guard) => {
                eprintln!("the MCP core landed with {guard:?}: this git no longer refuses");
                assert_eq!(
                    tip_of(&mcp_origin, "refs/heads/a").await.as_deref(),
                    Some(mcp_amended.as_str())
                );
            }
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(&stderr, IF_INCLUDES_REJECTION)
            }
            Err(other) => panic!("the MCP core: {other:?}"),
        }

        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-e2e").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let fired = std::sync::Arc::clone(&fired);
            move || {
                fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let guard = NETWORK_LOCK_WAIT_HOOK
            .scope(hook, push)
            .await
            .expect("the pinned force push lands");
        eprintln!("the pinned force push reported {guard:?}");
        // One lock wait is the first attempt landing; two is the degrade retry, which
        // must say so.
        match fired.load(std::sync::atomic::Ordering::SeqCst) {
            1 => assert_eq!(guard, super::PushGuardWire::LeaseAndIncludes),
            2 => assert_eq!(guard, super::PushGuardWire::LeasePinnedNoTrackingReflog),
            n => panic!("{n} lock waits: {guard:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(amended.as_str())
        );

        // Moved by another clone, not fetched: the first attempt's own lease is stale and
        // refuses it, so the degrade arm never runs; the remote is unchanged.
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "other"],
        )
        .await;
        let other = base.join("other").to_string_lossy().into_owned();
        run(&other, &["config", "user.email", "t@t.local"]).await;
        run(&other, &["config", "user.name", "T"]).await;
        run(&other, &["switch", "-q", "a"]).await;
        run(&other, &["commit", "-qm", "theirs", "--allow-empty"]).await;
        run(&other, &["push", "-q", "origin", "a"]).await;
        let theirs = tip_of(&origin, "refs/heads/a").await;
        run(
            &fresh,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "again"],
        )
        .await;
        let again = tip_of(&fresh, "refs/heads/a").await.unwrap();
        let result = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&again))),
            false,
        )
        .await;
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, STALE_LEASE_REJECTION)
            }
            other => panic!("the moved remote: {other:?}"),
        }
        assert_eq!(tip_of(&origin, "refs/heads/a").await, theirs);
    }

    /// The degrade retry's argv is the pinned lease alone; every other HEAD force push
    /// takes the bare lease plus `--force-if-includes`.
    #[test]
    fn the_head_force_argv_takes_one_lease_or_the_pair() {
        let sha = "c".repeat(40);
        let pin = super::LeasePin {
            remote: "origin".to_string(),
            dest: "a".to_string(),
            sha: sha.clone(),
            refusal: (1, String::new()),
        };
        let pinned = format!("--force-with-lease=refs/heads/a:{sha}");
        assert_eq!(
            super::head_push_argv(true, Some(&pin)),
            sv(&["push", &pinned])
        );
        assert_eq!(
            super::head_push_argv(true, None),
            sv(&["push", "--force-with-lease", FORCE_IF_INCLUDES])
        );
        assert_eq!(super::head_push_argv(false, Some(&pin)), sv(&["push"]));
        assert_eq!(super::head_push_argv(false, None), sv(&["push"]));
    }

    /// The degrade retry runs under the lease pinned to the pre-read tracking tip: a
    /// commit another clone pushes between the first attempt and the retry (the hook's
    /// SECOND firing), fetched into this clone's tracking ref so an implicit lease would
    /// pass, refuses the retry and stays on the remote.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_keeps_its_pinned_lease() {
        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-race").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "other"],
        )
        .await;
        let other = base.join("other").to_string_lossy().into_owned();
        run(&other, &["config", "user.email", "t@t.local"]).await;
        run(&other, &["config", "user.name", "T"]).await;
        run(&other, &["switch", "-q", "a"]).await;
        run(&other, &["commit", "-qm", "theirs", "--allow-empty"]).await;
        let theirs = tip_of(&other, "refs/heads/a").await.unwrap();
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, other, fresh) =
                (std::sync::Arc::clone(&fired), other.clone(), fresh.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&other, &["push", "-q", "origin", "a"]);
                    git_sync(
                        &fresh,
                        &["fetch", "-q", "origin", "a:refs/remotes/origin/a"],
                    );
                }
            }
        });
        assert!(
            super::branch_has_reflog(&fresh, "a").await,
            "the degrade arm needs a branch reflog"
        );
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        // A git whose `--force-if-includes` accepts a tracking ref with no reflog lands the
        // first attempt (one firing); one that refuses it runs the degrade retry (two).
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            return;
        }
        // Two firings: the first attempt is refused and the degrade retry runs.
        assert_eq!(firings, 2, "{result:?}");
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, STALE_LEASE_REJECTION)
            }
            other => panic!("the retry over a moved remote: {other:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(theirs.as_str())
        );
    }

    /// The degrade retry's tip was read for origin: a `remote.pushDefault` switched to
    /// another remote before the retry (the hook's SECOND firing) repeats the first
    /// attempt's refusal, and that remote's branch, sitting at exactly the pinned tip,
    /// keeps it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_refuses_a_moved_route() {
        let (_guard, base, origin, _url, fresh, amended) = fresh_clone_amended("fii-route").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        let second = base.join("second.git").to_string_lossy().into_owned();
        let second_url = format!("file://{}", second.replace('\\', "/"));
        run(&fresh, &["remote", "add", "second", &second_url]).await;
        run(&fresh, &["config", "remote.second.mirror", "false"]).await;
        run(
            &fresh,
            &["push", "-q", "second", "refs/remotes/origin/a:refs/heads/a"],
        )
        .await;
        let pinned_tip = tip_of(&second, "refs/heads/a").await;
        let published = tip_of(&origin, "refs/heads/a").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, fresh) = (std::sync::Arc::clone(&fired), fresh.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&fresh, &["config", "remote.pushDefault", "second"]);
                }
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            assert_eq!(tip_of(&second, "refs/heads/a").await, pinned_tip);
            return;
        }
        // Two firings: the first attempt is refused and the degrade retry runs.
        assert_eq!(firings, 2, "{result:?}");
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, IF_INCLUDES_REJECTION)
            }
            other => panic!("the retry over a moved route: {other:?}"),
        }
        assert_eq!(tip_of(&second, "refs/heads/a").await, pinned_tip);
        assert_eq!(tip_of(&origin, "refs/heads/a").await, published);
    }

    /// The fresh-clone fallback also covers a triangular `simple` push (upstream on one
    /// remote, `remote.pushDefault` another), where `%(push)` resolves nothing: the pinned
    /// force push lands on the push remote and the upstream's remote is untouched.
    #[tokio::test]
    async fn a_pinned_triangular_force_push_lands_on_a_fresh_clone() {
        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-tri").await;
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["clone", "-q", "--bare", &url, "upstream.git"]).await;
        let upstream = base.join("upstream.git").to_string_lossy().into_owned();
        let upstream_url = format!("file://{}", upstream.replace('\\', "/"));
        run(&fresh, &["remote", "add", "upstream", &upstream_url]).await;
        run(&fresh, &["config", "remote.upstream.mirror", "false"]).await;
        run(&fresh, &["fetch", "-q", "upstream"]).await;
        run(
            &fresh,
            &["branch", "-q", "--set-upstream-to=upstream/a", "a"],
        )
        .await;
        run(&fresh, &["config", "remote.pushDefault", "origin"]).await;
        let upstream_tip = tip_of(&upstream, "refs/heads/a").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let fired = std::sync::Arc::clone(&fired);
            move || {
                fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            assert_eq!(tip_of(&upstream, "refs/heads/a").await, upstream_tip);
            return;
        }
        let guard = result.expect("the pinned triangular force push lands");
        // Two lock waits: the first attempt is refused and the triangular fallback retries.
        assert_eq!(firings, 2);
        assert_eq!(guard, super::PushGuardWire::LeasePinnedNoTrackingReflog);
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(amended.as_str())
        );
        assert_eq!(tip_of(&upstream, "refs/heads/a").await, upstream_tip);
    }

    /// A pinned bare FORCE push is refused where git's routing sends more than HEAD's
    /// branch: under `push.default=matching` nothing lands, `other`'s rewrite included,
    /// while the pinned PLAIN push still runs as git routes it; a push remote with push
    /// refspecs is refused the same way. Unpinned (the MCP shape), the force push keeps
    /// git's routing and rewrites `other`, the control that the fixture reaches it.
    #[tokio::test]
    async fn a_pinned_force_push_refuses_a_multi_ref_route() {
        use crate::error::PushMultiRefCause;
        let (_guard, base, origin, _url) = seeded_origin("force-multi-ref").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        run(&work, &["branch", "other"]).await;
        run(&work, &["push", "-q", "origin", "other"]).await;
        run(&work, &["config", "push.default", "matching"]).await;
        run(&work, &["checkout", "-q", "other"]).await;
        run(&work, &["commit", "-qm", "plain other", "--allow-empty"]).await;
        run(&work, &["checkout", "-q", "main"]).await;
        run(&work, &["commit", "-qm", "plain", "--allow-empty"]).await;
        super::git_push_core(
            &state,
            work.clone(),
            false,
            false,
            None,
            None,
            None,
            Some(pins("main", None)),
            false,
        )
        .await
        .expect("a pinned plain push under matching runs");
        assert_eq!(
            tip_of(&origin, "refs/heads/main").await,
            tip_of(&work, "refs/heads/main").await
        );
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await,
            tip_of(&work, "refs/heads/other").await,
            "the plain push keeps git's matching routing"
        );

        let tree = run(&work, &["rev-parse", "HEAD^{tree}"]).await;
        let root = run(
            &work,
            &["commit-tree", tree.trim(), "-m", "rewritten other"],
        )
        .await;
        run(&work, &["branch", "-f", "other", root.trim()]).await;
        run(
            &work,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "amended"],
        )
        .await;
        let tip = tip_of(&work, "refs/heads/main").await.unwrap();
        let main_before = tip_of(&origin, "refs/heads/main").await;
        let other_before = tip_of(&origin, "refs/heads/other").await;
        let force = || {
            super::git_push_core(
                &state,
                work.clone(),
                false,
                true,
                None,
                None,
                None,
                Some(pins("main", Some(&tip))),
                false,
            )
        };
        let result = force().await;
        assert!(
            matches!(&result, Err(AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Matching }) if branch == "main" && remote == "origin"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);
        assert_eq!(tip_of(&origin, "refs/heads/other").await, other_before);

        run(&work, &["config", "--unset", "push.default"]).await;
        run(
            &work,
            &[
                "config",
                "remote.origin.push",
                "refs/heads/main:refs/heads/main",
            ],
        )
        .await;
        let result = force().await;
        assert!(
            matches!(&result, Err(AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Refspecs }) if branch == "main" && remote == "origin"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);

        // Matching set between the early check and the spawn: the spawn recheck refuses.
        run(&work, &["config", "--unset", "remote.origin.push"]).await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, work) = (std::sync::Arc::clone(&fired), work.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    git_sync(&work, &["config", "push.default", "matching"]);
                }
            }
        });
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, force()).await;
        assert_eq!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "{result:?}"
        );
        assert!(
            matches!(
                &result,
                Err(AppError::PushForceMultiRef {
                    cause: PushMultiRefCause::Matching,
                    ..
                })
            ),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);
        assert_eq!(tip_of(&origin, "refs/heads/other").await, other_before);

        run(&work, &["config", "push.default", "matching"]).await;
        git_push_core_unpinned(&state, work.clone(), false, true, None, None, None)
            .await
            .expect("an unpinned force push keeps git's routing");
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await.as_deref(),
            Some(root.trim())
        );
    }

    /// A URL push remote's userinfo never reaches the multi-ref refusal, field or message.
    #[tokio::test]
    async fn a_multi_ref_refusal_redacts_a_url_push_remote() {
        use crate::error::PushMultiRefCause;
        const URL: &str = "https://user:secret@example.invalid/o/r.git";
        const REDACTED: &str = "https://***@example.invalid/o/r.git";
        let (_guard, base, _origin, _url) = seeded_origin("force-multi-ref-redact").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "remote.pushDefault", URL]).await;
        run(&work, &["config", "push.default", "matching"]).await;
        let Err(err) = super::refuse_head_push(
            &work,
            super::HeadRoute::Bare,
            Some(&pins("main", None)),
            true,
        )
        .await
        else {
            panic!("a forced matching push to a URL remote is refused");
        };
        assert!(
            matches!(&err, AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Matching } if branch == "main" && remote == REDACTED),
            "{err:?}"
        );
        assert!(!format!("{err:?}").contains("secret"), "{err:?}");
        assert!(!serde_json::to_string(&err).unwrap().contains("secret"));

        run(&work, &["config", "--unset", "push.default"]).await;
        run(
            &work,
            &[
                "config",
                "remote.https://user:secret@example.invalid/o/r.git.push",
                "refs/heads/main:refs/heads/main",
            ],
        )
        .await;
        let Err(err) = super::refuse_head_push(
            &work,
            super::HeadRoute::Bare,
            Some(&pins("main", None)),
            true,
        )
        .await
        else {
            panic!("a forced push to a URL remote with push refspecs is refused");
        };
        assert!(
            matches!(&err, AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Refspecs } if branch == "main" && remote == REDACTED),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "https://***@example.invalid/o/r.git has push refspecs of its own, so a force push could rewrite other branches too. Nothing was pushed. Force-push main from a terminal, naming the branch."
        );
        assert!(!format!("{err:?}").contains("secret"), "{err:?}");
        assert!(!serde_json::to_string(&err).unwrap().contains("secret"));
    }

    #[test]
    fn a_session_destination_refusal_redacts_a_url_remote() {
        const URL: &str = "https://user:secret@host/o/r";
        let Err(err) = super::refuse_session_destination("topic", URL, "gd/session/x") else {
            panic!("a session destination is refused");
        };
        assert!(
            matches!(&err, AppError::PushDestinationIsAgentSession { branch, remote, dest } if branch == "topic" && remote == "https://***@host/o/r" && dest == "gd/session/x"),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "\"topic\" would push to https://***@host/o/r/gd/session/x, which is in gd/session/ — reserved for agent sessions, so GitDesktop won't push to it."
        );
        let Err(err) = super::refuse_session_destination("topic", "origin", "gd/session/x") else {
            panic!("a session destination on a named remote is refused");
        };
        assert!(
            matches!(&err, AppError::PushDestinationIsAgentSession { remote, .. } if remote == "origin"),
            "{err:?}"
        );
        assert!(super::refuse_session_destination("topic", URL, "feature").is_ok());
    }

    /// Where the host part ends (the first `/`, counted from a bracket's `]`), which mark ends
    /// the login (the last `@`, or after a scheme a later `%40`), and what comes back
    /// untouched: a value with no `:`, a `X:\` path with no `@[`, and a host part with no
    /// login mark.
    #[test]
    fn redact_url_userinfo_masks_through_the_last_at_of_the_host_part() {
        let rows = [
            ("origin", "origin"),
            ("me@work", "me@work"),
            ("git@host:o/r.git", "***@host:o/r.git"),
            ("https://user@host/o/r", "https://***@host/o/r"),
            ("https://user:pw@host/o/r", "https://***@host/o/r"),
            ("ssh://git@h:22/r", "ssh://***@h:22/r"),
            (r"C:\repos\x.git", r"C:\repos\x.git"),
            (r"C:\d@v\r", r"C:\d@v\r"),
            ("file:///C:/r.git", "file:///C:/r.git"),
            (r"https://host/a\b@c", r"https://host/a\b@c"),
            (r"https://host\x@evil/p", "https://***@evil/p"),
            (
                r"https://user:p\w@example.invalid/o/r",
                "https://***@example.invalid/o/r",
            ),
            (
                r"CORP\jdoe@example.invalid:o/r.git",
                "***@example.invalid:o/r.git",
            ),
            (
                r"[CORP\jdoe@example.invalid]:o/r.git",
                "***@example.invalid]:o/r.git",
            ),
            ("[a:b/c@example.invalid]:p", "***@example.invalid]:p"),
            (
                "ssh://[a/b@example.invalid]/p",
                "ssh://***@example.invalid]/p",
            ),
            (
                "ssh://ho%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
            (
                "ssh://user@ho%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
            ("ssh://a@b@example.invalid/r", "ssh://***@example.invalid/r"),
            (
                "ssh://us?er@example.invalid/r",
                "ssh://***@example.invalid/r",
            ),
            (
                "https://user:pw@example.invalid/p?u=ssh://x",
                "https://***@example.invalid/p?u=ssh://x",
            ),
            ("https://user:pw@[::1]:8080/r", "https://***@[::1]:8080/r"),
            ("https::user:pw@example.invalid/r", "***@example.invalid/r"),
            ("u:pw@example.invalid/r", "***@example.invalid/r"),
            ("://", "://"),
            ("https://user@", "https://***@"),
            ("x:@[", "***@["),
            (r"C:\u@[example.invalid]:p", "***@[example.invalid]:p"),
            (
                "ssh://user%40[x/y@example.invalid]/p",
                "ssh://***@example.invalid]/p",
            ),
            (
                "ssh://u@h/x@[example.invalid]/z",
                "ssh://***@[example.invalid]/z",
            ),
            (
                "ssh://ho%40x%40example.invalid/p",
                "ssh://***%40example.invalid/p",
            ),
        ];
        let wrong: Vec<String> = rows
            .iter()
            .filter_map(|(value, want)| {
                let got = super::redact_url_userinfo(value);
                (got != *want).then(|| format!("{value}: {got}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// The rename's push always arms the create-only lease, even with the destination's
    /// tracking ref present, and never follows tags; the same-name core, under the same
    /// `push.followTags`, does follow them (the control that the setting is live).
    #[tokio::test]
    async fn the_creating_core_always_leases_and_never_follows_tags() {
        let (_guard, base, origin, _url) = seeded_origin("creating-core").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        run(&work, &["push", "-q", "origin", "main:feat"]).await;
        assert!(tip_of(&work, "refs/remotes/origin/feat").await.is_some());
        let err =
            super::git_push_creating_core(&state, work.clone(), "feat".into(), "origin".into())
                .await
                .expect_err("an ancestor already at the name");
        assert!(
            matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
            "{err:?}"
        );
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(main.as_str())
        );

        run(&work, &["config", "push.followTags", "true"]).await;
        run(&work, &["checkout", "-q", "-b", "fresh"]).await;
        run(&work, &["commit", "-qm", "fresh", "--allow-empty"]).await;
        run(&work, &["tag", "-a", "v-fresh", "-m", "t"]).await;
        super::git_push_creating_core(&state, work.clone(), "fresh".into(), "origin".into())
            .await
            .expect("the new name publishes");
        assert_eq!(
            tip_of(&origin, "refs/heads/fresh").await,
            tip_of(&work, "refs/heads/fresh").await
        );
        assert_eq!(tip_of(&origin, "refs/tags/v-fresh").await, None);
        assert_eq!(
            run(&work, &["config", "--get", "branch.fresh.remote"])
                .await
                .trim(),
            "origin"
        );

        run(&work, &["checkout", "-q", "-b", "tagged"]).await;
        run(&work, &["commit", "-qm", "tagged", "--allow-empty"]).await;
        run(&work, &["tag", "-a", "v-tagged", "-m", "t"]).await;
        super::git_push_same_name_core(&state, work.clone(), true, Some("tagged".into()), None)
            .await
            .expect("the same-name core publishes");
        assert!(
            tip_of(&origin, "refs/tags/v-tagged").await.is_some(),
            "push.followTags is live in this fixture"
        );
    }

    /// The stale-lease predicate reads git's own ref status line, the create and delete
    /// shapes measured on git 2.51.1; `remote:` text and other rejections never match.
    #[test]
    fn the_stale_lease_predicate_reads_only_gits_status_line() {
        use super::is_stale_lease_rejection as stale;
        assert!(stale(
            " ! [rejected]        feature -> feature (stale info)\nerror: failed to push some refs to 'C:/temp/remote.git'"
        ));
        assert!(stale(
            "To ../o.git\n ! [rejected]        (delete) -> old (stale info)\nerror: failed to push some refs to '../o.git'"
        ));
        assert!(stale(
            "To x\r\n ! [rejected]        a -> a (stale info)\r\n"
        ));
        assert!(!stale(
            "remote: ! [rejected] a -> a (stale info)\nTo x\n ! [remote rejected] a -> a (pre-receive hook declined)"
        ));
        assert!(!stale(
            "remote: hook text (stale info)\nTo x\n ! [rejected]        a -> a (non-fast-forward)"
        ));
        assert!(!stale(" ! [rejected]        a -> a (fetch first)"));
        assert!(!stale(""));
        // color.transport=always colors the flag; the status line reads through it.
        assert!(stale(
            "To x\n \x1b[31m! [rejected]        \x1b[m a -> a (stale info)\n"
        ));
        assert!(stale(" \x1b[1m\x1b[31;1m! [rejected] a -> a (stale info)"));
        assert!(!stale("remote: \x1b[31m! [rejected] a -> a (stale info)"));
        assert_eq!(super::rejection_status_line(" \x1b[31m! x "), "! x");
        assert_eq!(super::rejection_status_line("\x1b[31x! x"), "\x1b[31x! x");
    }

    /// The HEAD `-u` publish carries the create-only lease: an unfetched ancestor on the
    /// destination is refused and the remote is unchanged.
    #[tokio::test]
    async fn the_head_publish_carries_the_create_only_lease() {
        let (_guard, base, origin, _url) = seeded_origin("head-create-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        plant_unfetched(&work, "origin", &main).await;
        // The same refusal under color.transport=always, which colors git's status line.
        for color in ["false", "always"] {
            run(&work, &["config", "color.transport", color]).await;
            let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
                .await
                .expect_err("an unfetched ancestor");
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "color.transport={color}: {err:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(main.as_str())
            );
        }
    }

    /// A followed tag lands beside the branch the create-only lease refuses: the refusal
    /// still names the destination, and its text says only the branch wasn't pushed.
    #[tokio::test]
    async fn a_followed_tag_beside_a_stale_lease_still_names_the_destination() {
        let (_guard, base, origin, _url) = seeded_origin("followed-tag-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["config", "push.followTags", "true"]).await;
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        plant_unfetched(&work, "origin", &main).await;
        let rows = [
            ("false", "v-plain", "refs/tags/v-plain"),
            ("always", "v-color", "refs/tags/v-color"),
        ];
        for (color, tag, tag_ref) in rows {
            run(&work, &["config", "color.transport", color]).await;
            run(&work, &["commit", "-qm", tag, "--allow-empty"]).await;
            run(&work, &["tag", "-a", tag, "-m", "t"]).await;
            let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
                .await
                .expect_err("an unfetched ancestor");
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "color.transport={color}: {err:?}"
            );
            assert!(
                !err.to_string().contains("nothing was pushed"),
                "color.transport={color}: {err}"
            );
            assert!(tip_of(&origin, tag_ref).await.is_some(), "{tag_ref} landed");
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(main.as_str())
            );
        }
    }

    /// A remote with two push URLs reports one `To` block per URL, and the first may have
    /// created the branch: a stale lease on the second keeps git's own text, never
    /// "nothing was pushed".
    #[tokio::test]
    async fn a_two_push_url_publish_keeps_gits_report() {
        let (_guard, base, origin, url) = seeded_origin("two-push-urls").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let base_s = base.to_string_lossy().into_owned();
        let state = AppState::default();
        run(&base_s, &["clone", "-q", "--bare", &url, "second.git"]).await;
        let second = base.join("second.git").to_string_lossy().into_owned();
        let second_url = format!("file://{}", second.replace('\\', "/"));
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&second, &["update-ref", "refs/heads/feat", &main]).await;
        run(&work, &["config", "--add", "remote.origin.pushurl", &url]).await;
        run(
            &work,
            &["config", "--add", "remote.origin.pushurl", &second_url],
        )
        .await;
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("the second URL holds the name");
        match &err {
            AppError::Git { stderr, .. } => assert_rejection_reason(stderr, STALE_LEASE_REJECTION),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await,
            tip_of(&work, "refs/heads/feat").await
        );
        assert_eq!(
            tip_of(&second, "refs/heads/feat").await.as_deref(),
            Some(main.as_str())
        );
    }

    /// A pinned push whose HEAD moved to a branch carrying a refusal of its own (Keep
    /// local) answers `PushHeadMoved`, never the other branch's refusal.
    #[tokio::test]
    async fn a_moved_head_outranks_the_other_branch_refusal() {
        let (_guard, work, origin) = keep_local_origin("pin-precedence").await;
        run(&work, &["branch", "other"]).await;
        crate::git::branches::set_branch_keep_local_core(&work, "other", true)
            .await
            .unwrap();
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/other"]).await;
        let published = feat_x_tip(&origin).await;
        let state = AppState::default();
        for force in [false, true] {
            let result = super::git_push_core(
                &state,
                work.clone(),
                false,
                force,
                None,
                None,
                None,
                Some(pins("feat/x", None)),
                false,
            )
            .await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "feat/x"),
                "force={force}: {result:?}"
            );
            assert_eq!(feat_x_tip(&origin).await, published);
        }
    }

    /// The spawn recheck compares the pins after the route's reads, on both routes (the
    /// bare push rechecks HEAD, the `-u` publish its named branch): HEAD moved between
    /// them (the hook) refuses the push and nothing lands.
    #[tokio::test]
    async fn the_spawn_recheck_compares_the_pins_last() {
        let (_guard, base, origin, _url) = seeded_origin("pin-order").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "other"]).await;
        run(&work, &["commit", "-qm", "next", "--allow-empty"]).await;
        let published = tip_of(&origin, "refs/heads/main").await;
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let work = work.clone();
            move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
        });
        let state = AppState::default();
        for set_upstream in [false, true] {
            run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
            let push = super::git_push_core(
                &state,
                work.clone(),
                set_upstream,
                false,
                None,
                None,
                None,
                Some(pins("main", None)),
                false,
            );
            let result = super::RECHECK_PINS_HOOK.scope(hook.clone(), push).await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "main"),
                "set_upstream={set_upstream}: {result:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/main").await,
                published,
                "set_upstream={set_upstream}"
            );
        }
    }

    /// A named push of a branch tracking a remote named `-x` (a live upstream through its
    /// fetch refspec) is refused as an invalid remote name before anything is spawned toward
    /// it; a branch whose `branch.<b>.remote` names no remote at all is refused as unknown.
    #[tokio::test]
    async fn a_dash_named_upstream_remote_is_refused() {
        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("dash-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "dash.git"]).await;
        let dash = base.join("dash.git").to_string_lossy().into_owned();
        let url = format!("file://{}", dash.replace('\\', "/"));
        run(&work, &["remote", "add", "--", "-x", &url]).await;
        run(&work, &["config", "remote.-x.mirror", "false"]).await;
        assert_eq!(
            run(&work, &["config", "--get", "remote.-x.fetch"])
                .await
                .trim(),
            "+refs/heads/*:refs/remotes/-x/*"
        );
        run(&work, &["branch", "feat"]).await;
        run(
            &work,
            &["update-ref", "refs/remotes/-x/feat", "refs/heads/feat"],
        )
        .await;
        run(
            &work,
            &["config", "--replace-all", "branch.feat.remote", "-x"],
        )
        .await;
        run(&work, &["config", "branch.feat.merge", "refs/heads/feat"]).await;
        let format = "--format=%(upstream:remotename)|%(upstream:remoteref)";
        assert_eq!(
            run(&work, &["for-each-ref", format, "refs/heads/feat"])
                .await
                .trim(),
            "-x|refs/heads/feat",
            "a live upstream on the dash-named remote"
        );
        let state = AppState::default();
        let push = || {
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                None,
                None,
            )
        };
        let result = push().await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(m)) if m == "invalid remote name: -x"),
            "{result:?}"
        );
        assert_eq!(tip_of(&dash, "refs/heads/feat").await, None);

        // A missing remote empties every upstream atom: refused, never published to origin.
        let origin = base.join("origin.git").to_string_lossy().into_owned();
        run(&work, &["branch", "topic"]).await;
        run(&work, &["config", "branch.topic.remote", "missing"]).await;
        run(&work, &["config", "branch.topic.merge", "refs/heads/topic"]).await;
        let format = "--format=%(upstream:remotename)|%(upstream:remoteref)";
        assert_eq!(
            run(&work, &["for-each-ref", format, "refs/heads/topic"])
                .await
                .trim(),
            "|",
            "the atoms read empty"
        );
        let result = git_push_core_unpinned(
            &state,
            work.clone(),
            false,
            false,
            Some("topic".into()),
            None,
            None,
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(m)) if m == "unknown remote: missing"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/topic").await, None);
        assert_eq!(
            run(&work, &["config", "--get", "branch.topic.remote"])
                .await
                .trim(),
            "missing",
            "tracking is left alone"
        );
    }

    /// A `HEAD` pin matches only a detached HEAD and a branch pin never does; over an
    /// unborn HEAD the pinned tip's read is that read's error.
    #[tokio::test]
    async fn push_pins_compare_a_detached_head() {
        let moved = |result: crate::error::AppResult<()>, want: &str| {
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == want),
                "{want}: {result:?}"
            );
        };
        let head = pins("HEAD", None);
        moved(head.check("", Some("refs/heads/main")).await, "HEAD");
        head.check("", None).await.expect("detached, as pinned");
        moved(pins("main", None).check("", None).await, "main");

        let (_guard, base) = temp_base("pins-unborn");
        let repo = base.to_string_lossy().into_owned();
        run(&repo, &["init", "-q", "-b", "main"]).await;
        let tip = "a".repeat(40);
        let result = pins("main", Some(&tip)).check_now(&repo).await;
        assert!(
            matches!(&result, Err(AppError::Git { .. })),
            "an unborn HEAD's tip read: {result:?}"
        );
    }

    // --- Real-repo tests for git_remote_remove (temp_dir, git on PATH). ---

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
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
                TEST_GIT_HANG_GUARD,
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
    /// The MESSAGE is the assertion: the remote-without-branch row would ALSO be
    /// satisfied by the next guard's "remote requires an explicit branch", so a
    /// variant-only match cannot tell which one refused it.
    #[tokio::test]
    async fn remote_branch_requires_both_branch_and_remote() {
        let state = AppState::default();
        for (branch, remote) in [
            (None, None),
            (Some("local".to_string()), None),
            (None, Some("fork".to_string())),
        ] {
            let err = git_push_core_unpinned(
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
                matches!(&err, AppError::InvalidArgument(m) if m.contains("remote branch requires")),
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
            let err = git_push_core_unpinned(
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

        git_push_core_unpinned(
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
                TEST_GIT_HANG_GUARD
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
                TEST_GIT_HANG_GUARD
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

        // Shortens the upstream past `origin/<def>`, which the parse must not read.
        run(&repo_s, &["tag", &format!("origin/{def}")]).await;

        // Run the real `for-each-ref` and parse it exactly as the caller does.
        let track = |b: &str| {
            let repo_s = repo_s.clone();
            let refspec = format!("refs/heads/{b}");
            async move {
                let out = run(
                    &repo_s,
                    &["for-each-ref", &refspec, UPSTREAM_TRACKING_FORMAT],
                )
                .await;
                parse_upstream_tracking(&out, &refspec)
            }
        };

        // Untracked branch → non-empty refname line with empty upstream fields.
        assert_eq!(
            track("feature").await,
            Some((Upstream::Untracked, String::new(), false))
        );
        // Tracked branch → the remote-side branch name + remote name; gone=false
        // (ahead/behind are ignored by the parser, so divergent histories are fine).
        assert_eq!(track(&def).await, Some((up(&def), "origin".into(), false)));
        // Prefix: `for-each-ref refs/heads/feat` matches `feat/sub`, whose refname
        // isn't `refs/heads/feat` → None (the exact-match guard, end to end).
        assert_eq!(track("feat").await, None);

        // Gone upstream: track origin/<def>, then delete the remote-tracking ref so
        // `%(upstream:track)` becomes `[gone]`. Do this LAST — it also makes <def> gone.
        // The full ref: the tag above makes the bare `origin/<def>` ambiguous.
        run(
            &repo_s,
            &[
                "branch",
                "--track",
                "goner",
                &format!("refs/remotes/origin/{def}"),
            ],
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

    /// A tag-pruning user keeps their local tags through the Fetch action, and the
    /// BRANCH half of the prune still runs — that half is what the action exists
    /// for, and the auto-fetch timer is what makes the tag half matter. A sibling
    /// clone under the same config is the negative control: there a raw pruning
    /// fetch deletes the tag, so the config is proven to bite before the flag is
    /// credited with anything.
    #[tokio::test]
    async fn fetch_keeps_local_tags_and_still_prunes_branches() {
        let (_guard, base, _origin_s, url) = seeded_origin("prune-tags").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // A branch both clones track, deleted on the origin afterwards — the stale
        // tracking ref the prune has to take.
        run(&work_s, &["switch", "-q", "-c", "doomed"]).await;
        std::fs::write(work.join("d.txt"), "d\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "doomed"]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "doomed"]).await;

        for name in ["clone", "control"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "fetch.pruneTags", "true"]).await;
            // A tag the origin does not carry, which is what makes it prunable.
            run(&c, &["tag", "keep-me"]).await;
        }
        run(&work_s, &["push", "-q", "origin", "--delete", "doomed"]).await;

        let clone_s = base.join("clone").to_string_lossy().into_owned();
        let control_s = base.join("control").to_string_lossy().into_owned();

        // Both preconditions, asserted before the fetch: without them the two
        // assertions below would pass on an empty starting state.
        assert_eq!(run(&clone_s, &["tag"]).await.trim(), "keep-me");
        assert!(
            !run(&clone_s, &["for-each-ref", "refs/remotes/origin/doomed"])
                .await
                .trim()
                .is_empty(),
            "the clone must start with the tracking ref the prune is meant to clear"
        );

        // The config has to bite, or retention below proves nothing.
        run(&control_s, &["fetch", "--prune", "origin"]).await;
        assert!(
            run(&control_s, &["tag"]).await.trim().is_empty(),
            "fetch.pruneTags must delete the tag on the control's raw pruning fetch"
        );

        git_fetch_core(&AppState::default(), clone_s.clone())
            .await
            .expect("the fetch action succeeds");
        assert_eq!(
            run(&clone_s, &["tag"]).await.trim(),
            "keep-me",
            "the Fetch action deleted a tag the user still holds"
        );
        assert!(
            run(&clone_s, &["for-each-ref", "refs/remotes/origin/doomed"])
                .await
                .trim()
                .is_empty(),
            "the deleted upstream branch's tracking ref must still be pruned"
        );
    }
    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_sensitivity_plain() {
        assert_pull_fallthrough_ignored_guard_sensitivity(false).await;
    }

    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_sensitivity_autostash() {
        assert_pull_fallthrough_ignored_guard_sensitivity(true).await;
    }

    async fn assert_pull_fallthrough_ignored_guard_sensitivity(autostash: bool) {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape};
        for shape in [
            Shape::IgnoredFile,
            Shape::ModifyDelete,
            Shape::IgnoredDirVsFile,
        ] {
            for mode in ["ff-only", "merge"] {
                if shape == Shape::ModifyDelete && mode == "ff-only" {
                    continue;
                }
                let mut f = Fixture::new(shape, mode == "merge").await;
                f.with_remote().await;
                run(&f.repo, &["fetch", "origin"]).await;
                run(&f.repo, &["config", "submodule.recurse", "true"]).await;
                let tracked = std::path::Path::new(&f.repo).join("tracked.txt");
                if autostash {
                    std::fs::write(&tracked, "dirty tracked edit\n").unwrap();
                }
                f.snapshot().await;
                let state = AppState::default();
                assert!(
                    crate::git::pull_guard::pin_plain_pull(&state, &f.repo, mode != "merge")
                        .await
                        .unwrap()
                        .is_none()
                );
                let result = if autostash {
                    crate::git::autostash::git_pull_autostash_core(
                        &state,
                        f.repo.clone(),
                        mode.into(),
                    )
                    .await
                    .map(|_| ())
                } else {
                    super::git_pull_core(&state, f.repo.clone(), mode.into()).await
                };
                f.assert_unchanged(&result.unwrap_err()).await;
                if autostash {
                    assert_eq!(
                        std::fs::read_to_string(&tracked).unwrap(),
                        "dirty tracked edit\n"
                    );
                }
                f.remove_ignored();
                if shape == Shape::ModifyDelete {
                    // Without ignored data the native modify/delete conflict is allowed to pause.
                    if autostash {
                        let outcome = crate::git::autostash::git_pull_autostash_core(
                            &state,
                            f.repo.clone(),
                            mode.into(),
                        )
                        .await
                        .unwrap();
                        assert!(
                            matches!(
                                outcome,
                                crate::git::autostash::AutostashOutcome::OpFailedStashKept {
                                    in_progress: true,
                                    ..
                                }
                            ),
                            "{outcome:?}"
                        );
                    } else {
                        let err =
                            crate::git::remote::git_pull_core(&state, f.repo.clone(), mode.into())
                                .await
                                .unwrap_err();
                        assert!(matches!(err, AppError::Conflict { .. }), "{err:?}");
                    }
                    assert_eq!(
                        std::fs::read_to_string(std::path::Path::new(&f.repo).join("seed.txt"))
                            .unwrap(),
                        "incoming bytes\n"
                    );
                    continue;
                }
                if autostash {
                    crate::git::autostash::git_pull_autostash_core(
                        &state,
                        f.repo.clone(),
                        mode.into(),
                    )
                    .await
                    .unwrap();
                } else {
                    super::git_pull_core(&state, f.repo.clone(), mode.into())
                        .await
                        .unwrap();
                }
                f.assert_landed().await;
            }
        }
    }

    #[tokio::test]
    async fn pull_fallthrough_ignored_guard_matches_native_operation_states() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape, MERGE_STATES};
        for state in MERGE_STATES {
            let mut f = Fixture::new(Shape::IgnoredFile, true).await;
            f.with_remote().await;
            run(&f.repo, &["fetch", "origin"]).await;
            state.install(&f).await;
            f.snapshot().await;
            let expected = if state.blocks_merge() {
                Some(
                    run_git_raw(Some(&f.repo), &["pull", "--no-rebase"], TEST_GIT_HANG_GUARD)
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            let err = git_pull_core(&AppState::default(), f.repo.clone(), "merge".into())
                .await
                .unwrap_err();
            if let Some(expected) = expected {
                let AppError::Git { code, stderr } = err else {
                    panic!("{state:?}: {err:?}")
                };
                assert_ne!(expected.code, 0);
                assert_eq!(code, expected.code);
                assert_eq!(stderr, expected.full_failure_text(), "{state:?}");
                f.assert_snapshot().await;
            } else {
                f.assert_unchanged(&err).await;
            }
        }
    }

    #[tokio::test]
    async fn pull_unborn_fast_forwards_and_protects_ignored_files() {
        use crate::git::ignored_guard::tests::{run, Fixture, Shape, SENTINEL};
        for ignored in [false, true] {
            let f = Fixture::new(Shape::IgnoredFile, false).await;
            f.with_remote().await;
            let remote = f
                .dir
                .path()
                .join("remote.git")
                .to_string_lossy()
                .into_owned();
            let clone = f.dir.path().join("empty").to_string_lossy().into_owned();
            run(&f.repo, &["clone", "--no-checkout", &remote, &clone]).await;
            run(&clone, &["config", "core.autocrlf", "false"]).await;
            run(&clone, &["switch", "--orphan", "empty"]).await;
            run(&clone, &["config", "branch.empty.remote", "origin"]).await;
            run(
                &clone,
                &["config", "branch.empty.merge", "refs/heads/incoming"],
            )
            .await;
            run(&clone, &["fetch", "origin"]).await;
            std::fs::create_dir_all(std::path::Path::new(&clone).join(".git/info")).unwrap();
            std::fs::write(
                std::path::Path::new(&clone).join(".git/info/exclude"),
                "local.cfg\n",
            )
            .unwrap();
            if ignored {
                std::fs::write(std::path::Path::new(&clone).join("local.cfg"), SENTINEL).unwrap();
            }
            assert!(crate::git::branches::head_is_unborn(&clone).await.unwrap());
            let index = run(&clone, &["ls-files", "-s"]).await;
            let status = run(&clone, &["status", "--porcelain=v1"]).await;
            let result = git_pull_core(&AppState::default(), clone.clone(), "ff-only".into()).await;
            if ignored {
                let err = result.unwrap_err();
                let AppError::Command(message) = err else {
                    panic!("{err:?}")
                };
                assert!(
                    message.contains("ignored files in your working tree: local.cfg"),
                    "{message}"
                );
                assert!(crate::git::branches::head_is_unborn(&clone).await.unwrap());
                assert_eq!(
                    std::fs::read(std::path::Path::new(&clone).join("local.cfg")).unwrap(),
                    SENTINEL
                );
                assert_eq!(run(&clone, &["ls-files", "-s"]).await, index);
                assert_eq!(run(&clone, &["status", "--porcelain=v1"]).await, status);
                for marker in ["MERGE_HEAD", "SQUASH_MSG", "ORIG_HEAD"] {
                    assert!(
                        !std::path::Path::new(&clone)
                            .join(".git")
                            .join(marker)
                            .exists(),
                        "{marker}"
                    );
                }
                assert!(run(&clone, &["stash", "list"]).await.is_empty());
            } else {
                result.unwrap();
                assert_eq!(run(&clone, &["rev-parse", "HEAD"]).await, f.target);
                assert_eq!(
                    std::fs::read_to_string(std::path::Path::new(&clone).join("local.cfg"))
                        .unwrap(),
                    "incoming bytes\n"
                );
            }
        }
    }
}
