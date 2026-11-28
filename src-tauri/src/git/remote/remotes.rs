use super::*;

fn validate_remote_arg(value: &str, what: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid {what}: {value}"
        )));
    }
    Ok(())
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

/// Error unless `remote` is one of the repo's configured remotes. We never
/// interpolate a caller-supplied remote name into a git invocation without
/// confirming it exists first — `validate_remote_arg` rejects the `-flag`
/// injection shape, but a bare unknown name would still shell out to a
/// confusing `git fetch <typo>` error; this turns it into an honest one.
pub(super) async fn ensure_remote_exists(repo_path: &str, remote: &str) -> AppResult<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{
        init_repo, run, seeded_origin_unpinned_push_default, temp_base,
    };
    use crate::git::runner::{hold_config_lock, TEST_GIT_HANG_GUARD};

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
}
