use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};

pub const GH_TIMEOUT: Duration = Duration::from_secs(30);
pub const GH_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

pub struct GhOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl GhOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// The resolved `gh` binary, memoized for the process lifetime.
///
/// A packaged GUI app on macOS doesn't inherit the user's shell PATH, so we
/// resolve `gh` the way the About screen does (`crate::agent::resolve_named`:
/// PATH + known install dirs + a macOS login-shell fallback / the live Windows
/// registry PATH) rather than a bare `Command::new("gh")`, which reads "not
/// found" when launched from Finder/Dock — the reason every gh-backed surface
/// failed while About showed gh installed. Cached like `git` (see
/// `git::runner::git_bin`): the login-shell fallback isn't free, and only a
/// *successful* resolution is cached, so a gh installed after launch is still
/// picked up on the next call.
static GH_BIN: OnceCell<PathBuf> = OnceCell::const_new();

async fn gh_bin() -> AppResult<PathBuf> {
    GH_BIN
        .get_or_try_init(|| async {
            crate::agent::resolve_named(&["gh"], None)
                .await
                .ok_or(AppError::GhNotFound)
        })
        .await
        .cloned()
}

/// Ambient token variables stripped from the stored-login probe's child. gh accepts any
/// of these as an answer for a host it has no login for, which is exactly what the probe
/// must not count.
const AMBIENT_TOKEN_VARS: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

/// Deadline for one stored-login probe. `gh auth token` reads gh's config and the OS
/// keyring — local work that answers in milliseconds — so seconds already mean something
/// is wedged, and the generous [`GH_TIMEOUT`] is the wrong bound here: this probe runs
/// during host RESOLUTION, before any caller's own timeout starts, and a ported remote
/// probes two spellings in sequence. A stalled keyring must not add a minute ahead of
/// every gh call.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// TTL bounding how long a stored-login verdict stays trusted before we re-probe, per
/// direction. A MEASURED verdict holds for a minute, so a sign-in or sign-out takes
/// effect promptly. A probe that never answered — a wedged keyring is the case that
/// matters — caches its `false` far more briefly: long enough that a persistent stall
/// costs one probe per window instead of one per call, short enough that a transient
/// hiccup self-heals.
const STORED_LOGIN_TTL: LoginTtl = LoginTtl {
    measured: Duration::from_secs(60),
    failed: Duration::from_secs(30),
};

/// The two windows [`STORED_LOGIN_CACHE`] serves, picked by whether the stored verdict
/// was measured or is a failed probe's `false`.
#[derive(Debug, Clone, Copy)]
struct LoginTtl {
    measured: Duration,
    failed: Duration,
}

/// A cached verdict and whether the probe that produced it FAILED (spawn error or
/// timeout) rather than answering. The flag picks the window and keeps a stalled probe's
/// `false` distinguishable from a measured "no login here", which is a real answer.
struct CachedLogin {
    probed_at: Instant,
    stored: bool,
    failed: bool,
}

/// Per-host-spelling cache. Bounded by the number of distinct spellings the open repos
/// use (tiny); a stale entry is overwritten.
type StoredLoginCache = Mutex<HashMap<String, CachedLogin>>;
static STORED_LOGIN_CACHE: OnceLock<StoredLoginCache> = OnceLock::new();

fn stored_login_cache() -> &'static StoredLoginCache {
    STORED_LOGIN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stored_login_cache_get(host: &str, ttl: LoginTtl) -> Option<bool> {
    let guard = stored_login_cache().lock().unwrap();
    let entry = guard.get(host)?;
    let window = if entry.failed { ttl.failed } else { ttl.measured };
    (entry.probed_at.elapsed() < window).then_some(entry.stored)
}

/// Record a MEASURED verdict for `host`, stamped now.
fn stored_login_cache_put(host: &str, stored: bool) {
    stored_login_cache().lock().unwrap().insert(
        host.to_string(),
        CachedLogin {
            probed_at: Instant::now(),
            stored,
            failed: false,
        },
    );
}

/// Record that the probe for `host` never answered: `false` (no pin) under the short
/// window, so a wedged keyring costs bounded time per window instead of per call.
fn stored_login_cache_put_failure(host: &str) {
    stored_login_cache().lock().unwrap().insert(
        host.to_string(),
        CachedLogin {
            probed_at: Instant::now(),
            stored: false,
            failed: true,
        },
    );
}

/// Whether gh holds a login for `host` STORED in its own config or keyring — the gate on
/// pinning `GH_HOST`. Memoized both directions for [`STORED_LOGIN_TTL`].
///
/// The four ambient token variables are stripped from the probe child: with
/// `GH_ENTERPRISE_TOKEN` exported, `gh auth token --hostname <anything>` exits 0 for any
/// enterprise spelling (measured, gh 2.94.0), so counting it would let a hostile `origin`
/// aim the user's token at a host of its choosing. That is the first of two deliberate
/// differences from [`crate::forge::github::gh_authenticated`], which counts env tokens
/// because an env token is a legitimate answer for the credential-helper injection it
/// gates. The second is the error arm: a failed or timed-out probe pins nothing, leaving
/// gh's own host chain in charge, where that helper fails optimistic — and caches that
/// `false` only for [`STORED_LOGIN_TTL`]'s short failure window, so a wedged keyring
/// can't re-stall every call while a transient hiccup still self-heals.
///
/// SECURITY: `gh auth token`'s stdout IS the user's token. Only the exit code is read and
/// the stream goes to null, so no code path can capture or log it.
async fn gh_stored_login(host: &str) -> bool {
    if let Some(hit) = stored_login_cache_get(host, STORED_LOGIN_TTL) {
        return hit;
    }
    // A missing gh is not a probe failure: it's re-resolved (and re-cached) by `gh_bin`
    // itself, and caching a verdict for it here would outlive an install.
    let Ok(gh) = gh_bin().await else { return false };
    let mut cmd = Command::new(&gh);
    apply_probe_env(&mut cmd);
    cmd.args(["auth", "token", "--hostname", host]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let Ok(Ok(status)) = tokio::time::timeout(PROBE_TIMEOUT, cmd.status()).await else {
        stored_login_cache_put_failure(host);
        return false;
    };
    let stored = status.success();
    stored_login_cache_put(host, stored);
    stored
}

/// The host spellings to offer gh for a remote URL, most specific first: the authority,
/// then the bare host when they differ. gh's registry is port-SENSITIVE, so a
/// `--hostname host:8443` login answers only to the authority while an unported one
/// answers only to the bare host. Both spellings pass [`crate::forge::is_safe_authority`]
/// first: the parsers only split on `/`, `:` and the bracket span, so a crafted remote
/// can carry `=`, `;`, `$`, or a space through them, and these strings reach `gh` argv
/// and — on a successful probe — `GH_HOST`. Pure.
fn gh_host_candidates(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(authority) =
        crate::forge::remote_authority(url).filter(|a| crate::forge::is_safe_authority(a))
    {
        out.push(authority);
    }
    if let Some(host) = crate::forge::remote_host(url)
        .filter(|h| !out.contains(h) && crate::forge::is_safe_authority(h))
    {
        out.push(host);
    }
    out
}

/// The host a repo's gh calls run against: the `origin` remote's spelling gh holds a
/// STORED login for, authority before bare host. No stored login means no pin, so an SSH
/// host alias, an `insteadOf` rewrite, or any host gh cannot serve keeps gh's own default
/// chain rather than a dead call, and no ambient enterprise token is ever aimed at a host
/// the user never signed into. Upstream-lens calls ride the origin host: cross-forge
/// origin/upstream pairs exist, and mis-targeting them is the price of one chokepoint.
async fn gh_host_for_repo(repo_path: &str) -> Option<String> {
    let url = crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string())
        .await
        .ok()?;
    for host in gh_host_candidates(&url) {
        if gh_stored_login(&host).await {
            return Some(host);
        }
    }
    None
}

/// The stored-login probe's child environment: the standard gh environment with NO
/// `GH_HOST` (the probe names its host by argument, and pinning one here would be
/// circular) plus every ambient token variable removed. Split out from the spawn so the
/// token-stripping this design rests on is assertable without a process.
fn apply_probe_env<C: crate::agent::ChildEnv>(cmd: &mut C) {
    apply_gh_env(cmd, None);
    for var in AMBIENT_TOKEN_VARS {
        cmd.unset_var(var);
    }
}

/// The environment every gh child gets. `sanitize_child_env` runs first so these
/// explicit sets win over it, per that function's ordering contract.
fn apply_gh_env<C: crate::agent::ChildEnv>(cmd: &mut C, gh_host: Option<&str>) {
    crate::agent::sanitize_child_env(cmd);
    // Keep gh fully non-interactive: no prompts, no pager, no update nags.
    cmd.set_var("GH_PAGER", "");
    cmd.set_var("GH_PROMPT_DISABLED", "1");
    cmd.set_var("GH_NO_UPDATE_NOTIFIER", "1");
    cmd.set_var("CLICOLOR", "0");
    cmd.set_var("NO_COLOR", "1");
    if let Some(host) = gh_host {
        cmd.set_var("GH_HOST", host);
    }
}

/// Runs the GitHub CLI and returns raw output regardless of exit code. Only a
/// missing `gh` binary or a timeout is an error here.
pub async fn run_gh_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let gh = gh_bin().await?;
    let gh_host = match repo_path {
        Some(repo) => gh_host_for_repo(repo).await,
        None => None,
    };
    let mut cmd = Command::new(&gh);
    apply_gh_env(&mut cmd, gh_host.as_deref());
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let output = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::GhNotFound
            } else {
                AppError::Io(e)
            }
        })?;

    Ok(GhOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

/// Runs gh, treating any non-zero exit code as an error carrying gh's stderr.
pub async fn run_gh(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let out = run_gh_raw(repo_path, args, timeout).await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(AppError::Gh(if msg.is_empty() {
            format!("gh exited with code {}", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(out)
}

/// Like `run_gh`, but pipes `input` to gh's stdin — for `gh api --input -` with
/// a JSON body (webhook create/update), where nested `config`/`events` don't
/// fit the flat `-f key=value` form. Non-zero exit is an error carrying stderr.
/// gh sets `Content-Type: application/json` on an `--input` body itself; glab
/// does NOT (both measured), which is why the GitLab side sends it explicitly.
pub async fn run_gh_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    use tokio::io::AsyncWriteExt;

    let gh = gh_bin().await?;
    let gh_host = match repo_path {
        Some(repo) => gh_host_for_repo(repo).await,
        None => None,
    };
    let mut cmd = Command::new(&gh);
    apply_gh_env(&mut cmd, gh_host.as_deref());
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::GhNotFound
        } else {
            AppError::Io(e)
        }
    })?;
    // The write runs INSIDE the timeout: a stalled stdin write is unbounded, so
    // outside it a stall hangs the caller forever instead of failing at the
    // deadline. It still precedes the drain rather than running concurrently the
    // way the git runner has to — one API body in, one small JSON document back —
    // and the timeout now bounds the exchange whatever a caller sends.
    let exchange = async move {
        // Dropping the handle after the write closes the pipe so gh reads EOF.
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input.as_bytes()).await.map_err(AppError::Io)?;
            stdin.shutdown().await.ok();
        }
        child.wait_with_output().await.map_err(AppError::Io)
    };
    let output = tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))??;

    let out = GhOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    };
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(AppError::Gh(if msg.is_empty() {
            format!("gh exited with code {}", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ChildEnv;

    /// Records what [`apply_gh_env`] did to a child's environment, so the pin is
    /// assertable without spawning gh.
    #[derive(Debug, Default)]
    struct RecordingEnv {
        set: Vec<(String, String)>,
        unset: Vec<String>,
    }

    impl ChildEnv for RecordingEnv {
        fn set_var(&mut self, key: &str, value: &str) {
            self.set.push((key.to_string(), value.to_string()));
        }
        fn unset_var(&mut self, key: &str) {
            self.unset.push(key.to_string());
        }
    }

    impl RecordingEnv {
        fn get(&self, key: &str) -> Option<&str> {
            self.set.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
        }
    }

    #[test]
    fn an_unported_remote_offers_its_host_once() {
        assert_eq!(gh_host_candidates("https://github.com/o/r.git"), ["github.com"]);
        assert_eq!(gh_host_candidates("git@ghe.acme.com:o/r.git"), ["ghe.acme.com"]);
        assert_eq!(gh_host_candidates("ssh://git@ghe.acme.com/o/r.git"), ["ghe.acme.com"]);
    }

    /// gh registers a ported instance under its full authority but an unported one under
    /// the bare host, and only one of the two answers — so both are offered, in that order.
    #[test]
    fn a_ported_remote_offers_the_authority_before_the_bare_host() {
        assert_eq!(
            gh_host_candidates("https://ghe.acme.com:8443/o/r.git"),
            ["ghe.acme.com:8443", "ghe.acme.com"],
        );
    }

    #[test]
    fn an_unparseable_remote_offers_nothing() {
        assert!(gh_host_candidates("/local/path").is_empty());
        assert!(gh_host_candidates("").is_empty());
    }

    /// The parsers split only on `/`, `:` and the bracket span, so config and shell
    /// syntax rides through them intact. These strings would otherwise reach `gh` argv
    /// as `--hostname <authority>` and, on a successful probe, `GH_HOST`.
    #[test]
    fn a_crafted_authority_offers_nothing() {
        for url in [
            "https://a b$c/o/r.git",
            "https://host;rm -rf/o/r.git",
            "https://a=b/o/r.git",
            "https://h$(whoami)/o/r.git",
        ] {
            assert!(
                gh_host_candidates(url).is_empty(),
                "must offer nothing for {url:?}, got {:?}",
                gh_host_candidates(url)
            );
        }
        // The gate is a charset filter, not a URL rejection: ordinary hosts, ports, and
        // IPv6 literals still come through.
        assert_eq!(
            gh_host_candidates("https://ghe.acme.com:8443/o/r.git"),
            ["ghe.acme.com:8443", "ghe.acme.com"]
        );
        assert_eq!(
            gh_host_candidates("https://[2001:db8::1]:8443/o/r.git"),
            ["[2001:db8::1]:8443", "[2001:db8::1]"]
        );
    }

    /// The probe's whole security property: gh must answer from its STORED config, never
    /// from an ambient token, because `GH_ENTERPRISE_TOKEN` makes `gh auth token
    /// --hostname <anything>` exit 0 for any enterprise spelling.
    #[test]
    fn the_stored_login_probe_strips_every_ambient_token() {
        let mut env = RecordingEnv::default();
        apply_probe_env(&mut env);
        for var in AMBIENT_TOKEN_VARS {
            assert!(
                env.unset.iter().any(|k| k == var),
                "{var} must be removed from the probe child: {env:?}"
            );
            assert_eq!(env.get(var), None, "{var} must not be re-set: {env:?}");
        }
        // The probe names its host by argument; pinning GH_HOST here would be circular,
        // and UNSETTING it would break a deliberate GH_HOST setup.
        assert_eq!(env.get("GH_HOST"), None, "{env:?}");
        assert!(!env.unset.iter().any(|k| k == "GH_HOST"), "{env:?}");
        // Still the standard gh child otherwise.
        assert_eq!(env.get("GH_PAGER"), Some(""), "{env:?}");
    }

    /// Both windows zero — every login entry reads as expired whatever its direction.
    const EXPIRED_LOGIN: LoginTtl = LoginTtl {
        measured: Duration::ZERO,
        failed: Duration::ZERO,
    };

    /// Both verdicts round-trip and both expire: a sign-out must stop pinning within the
    /// window, and a sign-in must start.
    #[test]
    fn stored_login_verdicts_are_served_within_the_ttl_and_expire_after_it() {
        // The cache is process-wide and shared by every test in this binary, so each
        // verdict gets its own host spelling.
        let (yes, no) = ("ghe.stored.example", "ghe.absent.example");

        assert_eq!(stored_login_cache_get(yes, STORED_LOGIN_TTL), None);

        stored_login_cache_put(yes, true);
        assert_eq!(stored_login_cache_get(yes, STORED_LOGIN_TTL), Some(true));
        assert_eq!(stored_login_cache_get(yes, EXPIRED_LOGIN), None);

        // `false` is a real verdict, not an absence — otherwise every unauthenticated
        // host would re-spawn a probe per call.
        stored_login_cache_put(no, false);
        assert_eq!(stored_login_cache_get(no, STORED_LOGIN_TTL), Some(false));
        assert_eq!(stored_login_cache_get(no, EXPIRED_LOGIN), None);

        assert_eq!(STORED_LOGIN_TTL.measured, Duration::from_secs(60));
        assert_eq!(STORED_LOGIN_TTL.failed, Duration::from_secs(30));
        assert!(STORED_LOGIN_TTL.failed < STORED_LOGIN_TTL.measured);
    }

    /// A probe that never answered caches `false` so a wedged keyring can't re-stall
    /// every gh call — but under the short window, and never mistaken for a MEASURED
    /// "no login here", which is a real answer and holds the full minute.
    #[test]
    fn a_failed_probe_caches_false_briefly_and_separately() {
        let host = "ghe.wedged.example";
        stored_login_cache_put_failure(host);

        // Inside the short window it serves, so the next call spawns nothing.
        assert_eq!(stored_login_cache_get(host, STORED_LOGIN_TTL), Some(false));

        // Same age, same entry — only the failed flag picks the window. This one is past
        // the failure window and still inside the measured one.
        let past_the_failure_window = LoginTtl {
            measured: Duration::from_secs(60),
            failed: Duration::ZERO,
        };
        assert_eq!(
            stored_login_cache_get(host, past_the_failure_window),
            None,
            "a failed probe must expire on the SHORT window, not the long one"
        );

        // A MEASURED false at the same age keeps the long window under that same read.
        let measured = "ghe.measured-no.example";
        stored_login_cache_put(measured, false);
        assert_eq!(
            stored_login_cache_get(measured, past_the_failure_window),
            Some(false),
            "a measured verdict must not inherit the failure window"
        );

        // Recovery replaces the failure entry in place.
        stored_login_cache_put(host, true);
        assert_eq!(
            stored_login_cache_get(host, past_the_failure_window),
            Some(true)
        );
    }

    #[test]
    fn a_repo_scoped_child_is_pinned_to_its_host() {
        let mut env = RecordingEnv::default();
        apply_gh_env(&mut env, Some("ghe.acme.com:8443"));
        assert_eq!(env.get("GH_HOST"), Some("ghe.acme.com:8443"), "{env:?}");
        assert_eq!(env.get("GH_PAGER"), Some(""), "{env:?}");
    }

    #[test]
    fn a_child_with_no_host_leaves_gh_host_alone() {
        let mut env = RecordingEnv::default();
        apply_gh_env(&mut env, None);
        assert_eq!(env.get("GH_HOST"), None, "{env:?}");
        assert!(!env.unset.iter().any(|k| k == "GH_HOST"), "{env:?}");
        // The sanitize pass still ran, and it precedes our sets so ours win.
        assert!(env.unset.iter().any(|k| k == "PWD"), "{env:?}");
    }
}
