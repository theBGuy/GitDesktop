use super::*;

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
/// nesting direction (see `run_git_mutating`). Every other caller in `git::remote` —
/// fetch, push, set-head — holds nothing but the network domain this takes.
///
/// A `push -u` whose upstream write lost `.git/config.lock` still exits 0 (measured,
/// git 2.51.1), so every same-name publish gets its upstream re-set here, once the
/// network hold is released; the push itself is never re-run.
///
/// Outside `git::remote`, an argv that pushes a named local branch goes through
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
pub(super) async fn run_git_mutating_with_creds_checked(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{
        assert_kept_local, feat_x_tip, git_push_core_unpinned, init_repo, keep_local_origin, pins,
        run, seeded_origin, temp_base,
    };
    use crate::git::runner::{TestGitEnv, TEST_GIT_HANG_GUARD};

    // --- The credential runner: auth-class fallback, rechecks, upstream repair, roster. ---

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

    /// A module's production text, CRLF-normalized: all before the first column-0 pair of lines
    /// `#[cfg(test)]`, `mod tests {`; a pair at byte 0 or a `pub(crate) mod tests` keeps it whole.
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
        let ops = production_text(include_str!("../ops.rs"));
        let pr = production_text(include_str!("../../github/pr.rs"));
        let gitlab = production_text(include_str!("../../forge/gitlab.rs"));
        let bitbucket = production_text(include_str!("../../forge/bitbucket.rs"));
        let files = [
            ("ops.rs", ops.clone()),
            (
                "branches/config_repair.rs",
                production_text(include_str!("../branches/config_repair.rs")),
            ),
            (
                "branches/create_checkout.rs",
                production_text(include_str!("../branches/create_checkout.rs")),
            ),
            (
                "branches/default_branch.rs",
                production_text(include_str!("../branches/default_branch.rs")),
            ),
            (
                "branches/delete.rs",
                production_text(include_str!("../branches/delete.rs")),
            ),
            (
                "branches/divergence.rs",
                production_text(include_str!("../branches/divergence.rs")),
            ),
            (
                "branches/in_use.rs",
                production_text(include_str!("../branches/in_use.rs")),
            ),
            (
                "branches/listing.rs",
                production_text(include_str!("../branches/listing.rs")),
            ),
            (
                "branches/marks.rs",
                production_text(include_str!("../branches/marks.rs")),
            ),
            (
                "branches/mod.rs",
                production_text(include_str!("../branches/mod.rs")),
            ),
            (
                "branches/names.rs",
                production_text(include_str!("../branches/names.rs")),
            ),
            (
                "branches/refs.rs",
                production_text(include_str!("../branches/refs.rs")),
            ),
            (
                "branches/remote_branch.rs",
                production_text(include_str!("../branches/remote_branch.rs")),
            ),
            (
                "branches/rename.rs",
                production_text(include_str!("../branches/rename.rs")),
            ),
            (
                "branches/renamed_copy.rs",
                production_text(include_str!("../branches/renamed_copy.rs")),
            ),
            (
                "branches/spelling.rs",
                production_text(include_str!("../branches/spelling.rs")),
            ),
            (
                "branches/unpushed.rs",
                production_text(include_str!("../branches/unpushed.rs")),
            ),
            (
                "branches/update.rs",
                production_text(include_str!("../branches/update.rs")),
            ),
            (
                "branches/upstream_rewrite.rs",
                production_text(include_str!("../branches/upstream_rewrite.rs")),
            ),
            ("remote/creds.rs", production_text(include_str!("creds.rs"))),
            (
                "remote/default_branch.rs",
                production_text(include_str!("default_branch.rs")),
            ),
            ("remote/fetch.rs", production_text(include_str!("fetch.rs"))),
            (
                "remote/publish.rs",
                production_text(include_str!("publish.rs")),
            ),
            ("remote/pull.rs", production_text(include_str!("pull.rs"))),
            ("remote/push.rs", production_text(include_str!("push.rs"))),
            (
                "remote/redact.rs",
                production_text(include_str!("redact.rs")),
            ),
            (
                "remote/remotes.rs",
                production_text(include_str!("remotes.rs")),
            ),
            (
                "remote/tracking.rs",
                production_text(include_str!("tracking.rs")),
            ),
            (
                "autostash.rs",
                production_text(include_str!("../autostash.rs")),
            ),
            (
                "pr_checkout.rs",
                production_text(include_str!("../pr_checkout.rs")),
            ),
            (
                "pull_guard.rs",
                production_text(include_str!("../pull_guard.rs")),
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
                !entry.path().is_dir(),
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
        // remote/ entries plus EXCLUDED must name every file there. A column-0 fn added above an
        // excluded file's test module fails this: move that file from EXCLUDED into the roster.
        let listed_remote = |files: &[(&str, String)]| -> std::collections::BTreeSet<String> {
            files
                .iter()
                .filter_map(|(file, _)| file.strip_prefix("remote/"))
                .map(str::to_string)
                .collect()
        };
        const EXCLUDED: [&str; 2] = ["mod.rs", "stderr_canaries.rs"];
        let excluded = std::collections::BTreeSet::from(EXCLUDED.map(str::to_string));
        let covered = |files: &[(&str, String)]| -> std::collections::BTreeSet<String> {
            listed_remote(files).union(&excluded).cloned().collect()
        };
        let mut on_disk_remote = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(git_dir.join("remote")).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().into_string().unwrap();
            assert!(
                !entry.path().is_dir(),
                "src/git/remote/{name} is a folder the roster cannot list"
            );
            if name.ends_with(".rs") {
                on_disk_remote.insert(name);
            }
        }
        assert!(
            listed_remote(&files).is_disjoint(&excluded),
            "the roster lists an EXCLUDED file of src/git/remote"
        );
        assert_eq!(
            covered(&files),
            on_disk_remote,
            "the roster's remote/ entries plus EXCLUDED differ from the files in src/git/remote"
        );
        let excluded_clean = |text: &str| column0_fns(&production_text(text)).is_empty();
        for name in EXCLUDED {
            let text = std::fs::read_to_string(git_dir.join("remote").join(name)).unwrap();
            assert!(
                excluded_clean(&text),
                "src/git/remote/{name} holds a column-0 fn: move {name} from EXCLUDED to the roster"
            );
        }
        // Each branches/ and remote/ label must carry its own file's text, so a mislabeled
        // include_str! cannot hide the seam it should have read.
        let mislabeled = |files: &[(&str, String)]| -> Vec<String> {
            let mut wrong = Vec::new();
            for (file, text) in files {
                if file.starts_with("branches/") || file.starts_with("remote/") {
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
        let m8: Vec<(&str, String)> = files
            .iter()
            .filter(|(file, _)| *file != "remote/fetch.rs")
            .cloned()
            .collect();
        assert_ne!(covered(&m8), on_disk_remote, "m8");
        let mut m9 = files.clone();
        for (file, text) in &mut m9 {
            if *file == "remote/push.rs" {
                text.push_str(PLANTED);
            }
        }
        assert!(flag(&m9).contains(&"planted".to_string()), "m9");
        let mod_text = std::fs::read_to_string(git_dir.join("remote/mod.rs")).unwrap();
        let m10 = format!("fn planted() {{}}\n{mod_text}");
        assert_ne!(m10, mod_text, "m10 changed nothing");
        assert!(!excluded_clean(&m10), "m10");
        let mut m11 = files.clone();
        let (push, creds) = (at("remote/push.rs"), at("remote/creds.rs"));
        let text = std::mem::take(&mut m11[push].1);
        m11[push].1 = std::mem::replace(&mut m11[creds].1, text);
        assert_eq!(
            mislabeled(&m11),
            ["remote/creds.rs", "remote/push.rs"],
            "m11"
        );
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
}
