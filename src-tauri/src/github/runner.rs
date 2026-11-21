use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
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
/// picked up on the next call, unless only the login shell can find it: the
/// resolver remembers that shell's miss (macOS/Linux) until the process
/// restarts, or in the app until About > Re-check.
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
/// use (tiny); a stale entry is overwritten. No single-flight, matching this file's
/// other caches: concurrent misses compute the same value and the last write wins.
type StoredLoginCache = Mutex<HashMap<String, CachedLogin>>;
static STORED_LOGIN_CACHE: OnceLock<StoredLoginCache> = OnceLock::new();

fn stored_login_cache() -> &'static StoredLoginCache {
    STORED_LOGIN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stored_login_cache_get(host: &str, ttl: LoginTtl) -> Option<bool> {
    let guard = stored_login_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let entry = guard.get(host)?;
    let window = if entry.failed { ttl.failed } else { ttl.measured };
    (entry.probed_at.elapsed() < window).then_some(entry.stored)
}

/// Record a MEASURED verdict for `host`, stamped now.
fn stored_login_cache_put(host: &str, stored: bool) {
    stored_login_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
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
    stored_login_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
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

    let Some(status) = probe_exit(cmd, PROBE_TIMEOUT).await else {
        stored_login_cache_put_failure(host);
        return false;
    };
    let stored = status.success();
    stored_login_cache_put(host, stored);
    stored
}

/// Spawns `cmd` with its tree armed and waits for it inside `timeout`. `None` for a spawn
/// error, a failed wait or a timeout. Leaves the stdio the caller set: the stored-login
/// probe's stdout is the user's token and must stay null.
async fn probe_exit(mut cmd: Command, timeout: Duration) -> Option<std::process::ExitStatus> {
    crate::proc_tree::TreeGuard::prepare(&mut cmd);
    cmd.kill_on_drop(true);
    let run = async {
        let mut child = cmd.spawn()?;
        // Declared right after `child` so it drops first, while the leader is unreaped.
        let guard = crate::proc_tree::TreeGuard::arm(&child);
        let status = child.wait().await?;
        guard.disarm();
        Ok::<_, std::io::Error>(status)
    };
    tokio::time::timeout(timeout, run).await.ok()?.ok()
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
pub(crate) async fn gh_host_for_repo(repo_path: &str) -> Option<String> {
    let url = crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string())
        .await
        .ok()?;
    gh_host_for_url(&url).await
}

/// [`gh_host_for_repo`] over an `origin` URL the caller already read.
pub(crate) async fn gh_host_for_url(url: &str) -> Option<String> {
    for host in gh_host_candidates(url) {
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
    // Also gives the git gh runs underneath (`pr checkout`, `repo fork --remote`) the
    // login-shell PATH its hooks and filter drivers need.
    crate::agent::sanitize_child_env(cmd);
    // Keep gh fully non-interactive: no prompts, no pager, no update nags.
    cmd.set_var("GH_PAGER", "");
    cmd.set_var("GH_PROMPT_DISABLED", "1");
    cmd.set_var("GH_NO_UPDATE_NOTIFIER", "1");
    cmd.set_var("CLICOLOR", "0");
    cmd.set_var("NO_COLOR", "1");
    // gh's forced colour outranks NO_COLOR and paints `gh api` JSON even into a pipe.
    cmd.unset_var("CLICOLOR_FORCE");
    if let Some(host) = gh_host {
        cmd.set_var("GH_HOST", host);
    }
}

/// Bumped whenever an in-app gh command that can change the signed-in account finishes:
/// through this runner, or via [`bump_gh_auth_epoch`] from the reconnect driver. Memos
/// of account-derived values store the epoch they read before fetching and treat any
/// other epoch as stale; a terminal `gh auth switch` is invisible here, so such memos
/// also carry a TTL.
static GH_AUTH_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn gh_auth_epoch() -> u64 {
    GH_AUTH_EPOCH.load(Ordering::SeqCst)
}

pub(crate) fn gh_auth_epoch_counter() -> &'static AtomicU64 {
    &GH_AUTH_EPOCH
}

/// For account changes that spawn gh outside this runner.
pub(crate) fn bump_gh_auth_epoch() {
    GH_AUTH_EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn changes_gh_account(args: &[&str]) -> bool {
    matches!(
        args,
        ["auth", "login" | "logout" | "switch" | "refresh", ..]
    )
}

/// Bumps its epoch on drop, so a timed-out or cancelled account change still
/// invalidates: its outcome is unknown.
struct AuthEpochBump(&'static AtomicU64);

impl Drop for AuthEpochBump {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// The guard `run_gh_raw` holds for `args`; `epoch` is a parameter so tests can watch
/// a counter no other test touches. Construction must stay lazy: a guard built and
/// dropped for a read-only command would bump the epoch too.
fn auth_epoch_guard(epoch: &'static AtomicU64, args: &[&str]) -> Option<AuthEpochBump> {
    changes_gh_account(args).then(|| AuthEpochBump(epoch))
}

/// Runs the GitHub CLI and returns raw output regardless of exit code. Only a
/// missing `gh` binary or a timeout is an error here.
pub async fn run_gh_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let _epoch_bump = auth_epoch_guard(&GH_AUTH_EPOCH, args);
    let gh = gh_bin().await?;
    let gh_host = match repo_path {
        Some(repo) => gh_host_for_repo(repo).await,
        None => None,
    };
    run_gh_raw_resolved(&gh, repo_path, gh_host.as_deref(), args, timeout).await
}

async fn run_gh_raw_resolved(
    gh: &std::path::Path,
    repo_path: Option<&str>,
    gh_host: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let epoch = gh_auth_epoch();
    run_gh_raw_resolved_with(gh, repo_path, gh_host, args, timeout, rate_gate(), epoch).await
}

async fn run_gh_raw_resolved_with(
    gh: &std::path::Path,
    repo_path: Option<&str>,
    gh_host: Option<&str>,
    args: &[&str],
    timeout: Duration,
    gate: &'static Mutex<RateGate>,
    epoch: u64,
) -> AppResult<GhOutput> {
    run_gh_gated(gh, gh_host, args, gate, epoch, || {
        spawn_gh_resolved(
            gh,
            repo_path.map(std::path::Path::new),
            gh_host,
            args,
            None,
            timeout,
        )
    })
    .await
}

/// `run_gh_raw` with the child's cwd set to `cwd` instead of the repo and `input` piped
/// to its stdin; GH_HOST, the rate gate and the auth epoch still key on `repo_path` and
/// `args`, never the cwd.
pub(crate) async fn run_gh_raw_in_dir(
    repo_path: &str,
    cwd: &std::path::Path,
    args: &[&str],
    input: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    let _epoch_bump = auth_epoch_guard(&GH_AUTH_EPOCH, args);
    let gh = gh_bin().await?;
    let gh_host = gh_host_for_repo(repo_path).await;
    let host = gh_host.as_deref();
    let epoch = gh_auth_epoch();
    run_gh_gated(&gh, host, args, rate_gate(), epoch, || {
        spawn_gh_resolved(&gh, Some(cwd), host, args, Some(input), timeout)
    })
    .await
}

async fn run_gh_gated<F: std::future::Future<Output = AppResult<GhOutput>>>(
    gh: &std::path::Path,
    gh_host: Option<&str>,
    args: &[&str],
    gate: &'static Mutex<RateGate>,
    epoch: u64,
    spawn: impl FnOnce() -> F,
) -> AppResult<GhOutput> {
    let generation = gate.lock().unwrap_or_else(|p| p.into_inner()).generation;
    if let Some(held) = gate_before(gate, gh, gh_host, args, epoch) {
        return Ok(held);
    }
    let out = spawn().await?;
    gate_after(gate, gh, gh_host, args, &out, epoch, generation);
    Ok(out)
}

async fn spawn_gh_resolved(
    gh: &std::path::Path,
    cwd: Option<&std::path::Path>,
    gh_host: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GhOutput> {
    let mut cmd = Command::new(gh);
    apply_gh_env(&mut cmd, gh_host);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    crate::proc_tree::TreeGuard::prepare(&mut cmd);
    cmd.kill_on_drop(true);

    // Spawn, exchange and reap all sit inside the one timeout. The guard is declared right
    // after `child` so it drops first, killing the tree while the leader is unreaped; only
    // a reaped call disarms.
    let exchange = async {
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::GhNotFound
            } else {
                AppError::Io(e)
            }
        })?;
        let guard = crate::proc_tree::TreeGuard::arm(&child);
        let output = exchange_with_stdin(&mut child, input.map(str::as_bytes))
            .await
            .map_err(AppError::Io)?;
        guard.disarm();
        Ok::<_, AppError>(output)
    };
    let output = tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))??;

    Ok(GhOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

/// Writes `input` to the child's stdin while draining stdout and stderr, closing the
/// pipe once the write ends so the child reads EOF, then reaps the child. `Ok` means the
/// child was reaped (the caller's cue to disarm its tree guard). Once it is, its output
/// is the result at once and nothing more is awaited, so a CLI that exits before reading
/// keeps its own exit code and stderr. A write still pending is dropped; on Windows one
/// parked in the blocking pool keeps its pipe handle until the reader goes. A reaped
/// leader no longer pins its group id, which is safe because the caller awaits nothing
/// before its disarm and the disarm sends no signal. A failed drain or wait returns at
/// once, with the write's error preferred when the write had already ended. Borrows the
/// child and never kills it; takes no timeout, each caller wraps the exchange in its own.
pub(crate) async fn exchange_with_stdin(
    child: &mut tokio::process::Child,
    input: Option<&[u8]>,
) -> std::io::Result<std::process::Output> {
    use tokio::io::AsyncWriteExt;

    /// Reads one optional pipe to its end; a missing pipe reads as empty.
    async fn drain(
        pipe: &mut Option<impl tokio::io::AsyncRead + Unpin>,
    ) -> std::io::Result<Vec<u8>> {
        use tokio::io::AsyncReadExt;

        let mut buf = Vec::new();
        if let Some(pipe) = pipe {
            pipe.read_to_end(&mut buf).await?;
        }
        Ok(buf)
    }

    debug_assert!(
        input.is_none() || child.stdin.is_some(),
        "stdin text given for a child spawned without a piped stdin"
    );
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let write = async move {
        let (Some(mut pipe), Some(bytes)) = (stdin, input) else {
            return Ok(());
        };
        let written = pipe.write_all(bytes).await;
        drop(pipe);
        written
    };
    // The reap follows the drains, so the leader stays unreaped while the guard is armed,
    // and it is the last thing either branch below awaits.
    let reap = async {
        let (stdout, stderr) = tokio::try_join!(drain(&mut stdout), drain(&mut stderr))?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>(std::process::Output {
            status,
            stdout,
            stderr,
        })
    };
    tokio::pin!(write, reap);
    // A reap that ends first returns at once and drops the pending write: a descendant
    // holding the pipe unread must not keep a reaped call's guard armed, and a failed
    // reap leaves the kill to that armed guard. Biased toward the write, so when both
    // end in one poll a failed reap still reports the write's error.
    tokio::select! {
        biased;
        written = &mut write => reap.await.map_err(|e| written.err().unwrap_or(e)),
        reaped = &mut reap => reaped,
    }
}

/// Runs gh, treating any non-zero exit code as an error carrying gh's stderr.
pub async fn run_gh(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let out = run_gh_raw(repo_path, args, timeout).await?;
    gh_output_ok(out)
}

pub(crate) fn gh_output_ok(out: GhOutput) -> AppResult<GhOutput> {
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

/// The scope every Projects v2 read needs; a default `gh auth login` lacks it.
pub(crate) const PROJECT_READ_SCOPE: &str = "read:project";

/// Turn a missing-scope gh failure into `hint`, an actionable sentence. GraphQL's
/// INSUFFICIENT_SCOPES wording says "required scopes" while gh's own CLI error names
/// the scope, so either marks the gap; `scope` must be lowercase. Anything else,
/// including every non-`Gh` error, passes through untouched.
pub(crate) fn map_scope_error(e: AppError, scope: &str, hint: &str) -> AppError {
    debug_assert_eq!(scope, scope.to_lowercase(), "scope must be lowercase");
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains(scope) {
            return AppError::Gh(hint.to_string());
        }
    }
    e
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
    let out = run_gh_input_raw(repo_path, args, input, timeout).await?;
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

/// Aliased mutations return partial data and per-alias errors on a nonzero exit;
/// outcome mapping needs both, so preserve stdout alongside the exit code and stderr.
pub async fn run_gh_input_raw(
    repo_path: Option<&str>,
    args: &[&str],
    input: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    let gh = gh_bin().await?;
    let gh_host = match repo_path {
        Some(repo) => gh_host_for_repo(repo).await,
        None => None,
    };
    let host = gh_host.as_deref();
    let epoch = gh_auth_epoch();
    run_gh_gated(&gh, host, args, rate_gate(), epoch, || {
        spawn_gh_resolved(
            &gh,
            repo_path.map(std::path::Path::new),
            host,
            args,
            Some(input),
            timeout,
        )
    })
    .await
}

/// Splits `gh api -i` output into headers and body, including failed responses.
pub(crate) fn split_response(out: &str) -> (&str, &str) {
    if !out.starts_with("HTTP/") {
        return ("", out);
    }
    let mut offset = 0usize;
    for line in out.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() {
            return (&out[..offset], &out[offset..]);
        }
    }
    (out, "")
}

/// Only the HTTP status line determines the response status.
pub(crate) fn parse_status(headers: &str) -> Option<u16> {
    headers
        .lines()
        .next()?
        .strip_prefix("HTTP/")?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The first matching header wins, including a present but empty value.
pub(crate) fn response_header_line(body: &str, header: &str) -> Option<String> {
    for line in body.lines() {
        if line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case(header) {
                return Some(value.trim().to_string());
            }
        }
    }
    None
}

/// Empty matches keep scanning for a non-empty value, unlike `response_header_line`.
pub(crate) fn response_header_value(body: &str, header: &str) -> Option<String> {
    for line in body.lines() {
        if line.trim().is_empty() {
            break; // end of headers.
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case(header) {
                let v = value.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

const GH_BODY_CACHE_MAX_AGE: Duration = Duration::from_secs(600);
const GH_BODY_CACHE_CAP: usize = 64;
type GhBodyKey = (Option<String>, Option<String>, Vec<String>);

#[derive(Clone)]
struct CachedGhBody {
    etag: String,
    body: Vec<u8>,
    epoch: u64,
    touched: Instant,
}

enum BodyUpdate {
    None,
    Touch,
    Store(String),
}

struct CachedFetchOutcome {
    out: GhOutput,
    update: BodyUpdate,
}

fn body_cache_get(
    cache: &HashMap<GhBodyKey, CachedGhBody>,
    key: &GhBodyKey,
    epoch: u64,
    max_age: Duration,
    now: Instant,
) -> Option<CachedGhBody> {
    cache
        .get(key)
        .filter(|entry| entry.epoch == epoch && now.duration_since(entry.touched) < max_age)
        .cloned()
}

fn body_cache_put(
    cache: &mut HashMap<GhBodyKey, CachedGhBody>,
    key: GhBodyKey,
    entry: CachedGhBody,
) {
    if !cache.contains_key(&key) && cache.len() >= GH_BODY_CACHE_CAP {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.touched)
            .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(key, entry);
}

pub(crate) fn bypasses(args: &[&str]) -> bool {
    let mut explicit_get = false;
    let mut fields = false;
    let mut args = args.iter().copied();
    while let Some(arg) = args.next() {
        if arg.starts_with("--") {
            let flag = arg.split_once('=').map_or(arg, |(flag, _)| flag);
            if matches!(
                flag,
                "--paginate"
                    | "--jq"
                    | "--template"
                    | "--field"
                    | "--input"
                    | "--include"
                    | "--cache"
            ) {
                return true;
            }
            let method = if arg == "--method" {
                Some(args.next().unwrap_or(""))
            } else {
                arg.strip_prefix("--method=")
            };
            if let Some(method) = method {
                if !method.eq_ignore_ascii_case("GET") {
                    return true;
                }
                explicit_get = true;
            }
            fields |= flag == "--raw-field";
        } else if let Some(shorts) = arg.strip_prefix('-') {
            for (index, flag) in shorts.char_indices() {
                match flag {
                    'F' | 'q' | 't' | 'i' => return true,
                    'X' | 'f' | 'H' | 'p' => {
                        let rest = &shorts[index + 1..];
                        let value = if let Some(value) = rest.strip_prefix('=') {
                            value
                        } else if rest.is_empty() {
                            args.next().unwrap_or("")
                        } else {
                            rest
                        };
                        if flag == 'X' {
                            if !value.eq_ignore_ascii_case("GET") {
                                return true;
                            }
                            explicit_get = true;
                        }
                        fields |= flag == 'f';
                        break;
                    }
                    '=' => break,
                    _ => {}
                }
            }
        }
    }
    fields && !explicit_get
}

fn conditional_args(args: &[&str], entry: Option<&CachedGhBody>) -> Vec<String> {
    let mut args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    args.push("-i".into());
    if let Some(entry) = entry {
        args.push("-H".into());
        args.push(format!("If-None-Match: {}", entry.etag));
    }
    args
}

fn valid_etag(etag: &str) -> bool {
    let tag = etag.strip_prefix("W/").unwrap_or(etag);
    let Some(opaque) = tag.strip_prefix('"').and_then(|tag| tag.strip_suffix('"')) else {
        return false;
    };
    opaque
        .bytes()
        .all(|byte| byte == b'!' || (b'#'..=b'~').contains(&byte))
}

fn conditional_outcome(entry: Option<&CachedGhBody>, out: &GhOutput) -> CachedFetchOutcome {
    let Ok(text) = std::str::from_utf8(&out.stdout) else {
        return CachedFetchOutcome {
            out: GhOutput {
                stdout: out.stdout.clone(),
                stderr: out.stderr.clone(),
                code: out.code,
            },
            update: BodyUpdate::None,
        };
    };
    let (headers, _) = split_response(text);
    let status = parse_status(headers);
    if let (Some(304), Some(entry)) = (status, entry) {
        return CachedFetchOutcome {
            out: GhOutput {
                stdout: entry.body.clone(),
                stderr: String::new(),
                code: 0,
            },
            update: BodyUpdate::Touch,
        };
    }
    let update = if status == Some(200) && out.code == 0 {
        response_header_value(headers, "etag")
            .filter(|etag| valid_etag(etag))
            .map(BodyUpdate::Store)
            .unwrap_or(BodyUpdate::None)
    } else {
        BodyUpdate::None
    };
    CachedFetchOutcome {
        out: GhOutput {
            stdout: out.stdout[headers.len()..].to_vec(),
            stderr: out.stderr.clone(),
            code: out.code,
        },
        update,
    }
}

fn apply_body_update(
    cache: &mut HashMap<GhBodyKey, CachedGhBody>,
    key: GhBodyKey,
    entry: Option<&CachedGhBody>,
    result: &CachedFetchOutcome,
    epoch: u64,
    current_epoch: u64,
    now: Instant,
) {
    match &result.update {
        BodyUpdate::Store(etag) if epoch == current_epoch => body_cache_put(
            cache,
            key,
            CachedGhBody {
                etag: etag.clone(),
                body: result.out.stdout.clone(),
                epoch,
                touched: now,
            },
        ),
        BodyUpdate::Touch => {
            if let (Some(current), Some(fetched)) = (cache.get_mut(&key), entry) {
                if current.epoch == fetched.epoch && current.etag == fetched.etag {
                    current.touched = now;
                }
            }
        }
        BodyUpdate::None | BodyUpdate::Store(_) => {}
    }
}

static GH_BODY_CACHE: OnceLock<Mutex<HashMap<GhBodyKey, CachedGhBody>>> = OnceLock::new();

fn body_cache() -> &'static Mutex<HashMap<GhBodyKey, CachedGhBody>> {
    GH_BODY_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) async fn run_gh_cached_get_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let epoch = gh_auth_epoch();
    let host = match repo_path {
        Some(repo) => gh_host_for_repo(repo).await,
        None => None,
    };
    run_gh_cached_get_raw_on_host(repo_path, host.as_deref(), args, timeout, epoch).await
}

/// Key and request share one resolved host; a changed pre-fetch epoch discards a fill.
pub(crate) async fn run_gh_cached_get_raw_on_host(
    repo_path: Option<&str>,
    host: Option<&str>,
    args: &[&str],
    timeout: Duration,
    epoch: u64,
) -> AppResult<GhOutput> {
    let gh = gh_bin().await?;
    let bypassed = bypasses(args);
    if bypassed {
        debug_assert!(
            !bypassed,
            "conditional GET requires unshaped, single-page argv"
        );
        return run_gh_raw_resolved(&gh, repo_path, host, args, timeout).await;
    }
    let key = (
        repo_path.map(str::to_string),
        host.map(str::to_string),
        args.iter().map(|arg| (*arg).to_string()).collect(),
    );
    let entry = body_cache_get(
        &body_cache().lock().unwrap_or_else(|p| p.into_inner()),
        &key,
        gh_auth_epoch(),
        GH_BODY_CACHE_MAX_AGE,
        Instant::now(),
    );
    let args = conditional_args(args, entry.as_ref());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh_raw_resolved(&gh, repo_path, host, &refs, timeout).await?;
    let result = conditional_outcome(entry.as_ref(), &out);
    let mut cache = body_cache().lock().unwrap_or_else(|p| p.into_inner());
    apply_body_update(
        &mut cache,
        key,
        entry.as_ref(),
        &result,
        epoch,
        gh_auth_epoch(),
        Instant::now(),
    );
    Ok(result.out)
}

pub(crate) async fn run_gh_cached_get(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    gh_output_ok(run_gh_cached_get_raw(repo_path, args, timeout).await?)
}

/// Fresh form reads share their resolved host with the memo they seed.
pub(crate) async fn run_gh_on_host(
    repo_path: Option<&str>,
    host: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let _epoch_bump = auth_epoch_guard(&GH_AUTH_EPOCH, args);
    let gh = gh_bin().await?;
    gh_output_ok(run_gh_raw_resolved(&gh, repo_path, host, args, timeout).await?)
}

/// `run_gh_raw` on a host the caller resolved once, so every call of one flow reaches the
/// same host; `None` sends no `GH_HOST`.
pub(crate) async fn run_gh_raw_on_host(
    repo_path: Option<&str>,
    host: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let _epoch_bump = auth_epoch_guard(&GH_AUTH_EPOCH, args);
    let gh = gh_bin().await?;
    run_gh_raw_resolved(&gh, repo_path, host, args, timeout).await
}

/// `run_gh_input_raw` on a host the caller resolved once; `None` sends no `GH_HOST`.
pub(crate) async fn run_gh_input_raw_on_host(
    repo_path: Option<&str>,
    host: Option<&str>,
    args: &[&str],
    input: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    let _epoch_bump = auth_epoch_guard(&GH_AUTH_EPOCH, args);
    let gh = gh_bin().await?;
    let epoch = gh_auth_epoch();
    run_gh_gated(&gh, host, args, rate_gate(), epoch, || {
        spawn_gh_resolved(
            &gh,
            repo_path.map(std::path::Path::new),
            host,
            args,
            Some(input),
            timeout,
        )
    })
    .await
}

// GitHub requires waiting for the primary reset; an unknown reset gets a short hold.
const PRIMARY_FALLBACK_SECS: i64 = 60;
// GitHub requires at least a minute before retrying a secondary limit.
const SECONDARY_BASE_SECS: i64 = 60;
// GitHub calls for exponential secondary waits; bound that escalation to fifteen minutes.
const SECONDARY_MAX_SECS: i64 = 900;
// The exempt GitHub rate_limit read bounds detection of terminal account switches.
const RECHECK_SECS: i64 = 300;
// GitHub's primary window is one hour; untrusted hints cannot hold for days.
pub(crate) const MAX_HOLD_SECS: i64 = 3660;
// Waiting for GitHub's reset must tolerate small backward clock corrections.
const CLOCK_SLACK_SECS: i64 = 60;
// GitHub's advisory rate_limit read must settle even when the network stalls.
const RATE_LIMIT_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

const HELD_CORE: &str = "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.";
const HELD_GRAPHQL: &str = "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.";
const HELD_SEARCH: &str = "GitHub's search API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Bucket {
    Core,
    Graphql,
    Search,
}

impl Bucket {
    fn resource_name(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Graphql => "graphql",
            Self::Search => "search",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallClass {
    Gated(Bucket),
    Ungated,
    Exempt,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LimitKind {
    Primary,
    Secondary,
}

struct LimitEvidence {
    bucket: Bucket,
    kind: LimitKind,
    until_hint: Option<i64>,
}

type RateKey = (Option<String>, Bucket);

struct HoldEntry {
    until: i64,
    // Quota reads say nothing about Secondary limits and cannot lift their active waits.
    // The hold never ends before this floor.
    clear_floor: i64,
    recheck_at: i64,
    epoch: u64,
    // Results may clear or shorten only when their starting generation is at least this.
    // Same-epoch refusals still record.
    generation: u64,
    strikes: u32,
    kind: LimitKind,
    probe_pending: bool,
}

#[derive(Default)]
struct RateGate {
    entries: HashMap<RateKey, HoldEntry>,
    // Monotonic refusal counter captured before each call or probe starts.
    generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Verdict {
    Pass,
    Hold,
    Recheck,
}

fn api_value_flag(arg: &str) -> bool {
    matches!(
        arg,
        "-X" | "--method"
            | "-H"
            | "--header"
            | "-f"
            | "--raw-field"
            | "-F"
            | "--field"
            | "--hostname"
            | "--input"
            | "-q"
            | "--jq"
            | "-t"
            | "--template"
            | "--cache"
            | "-p"
            | "--preview"
    )
}

fn api_endpoint<'a>(args: &[&'a str]) -> Option<&'a str> {
    let mut args = args.iter().skip(1);
    while let Some(arg) = args.next() {
        if api_value_flag(arg) {
            args.next();
        } else if !arg.starts_with('-') {
            return Some(arg.strip_prefix('/').unwrap_or(arg));
        }
    }
    None
}

fn classify_call(args: &[&str]) -> CallClass {
    match args {
        ["auth", ..] => CallClass::Exempt,
        ["api", ..] => match api_endpoint(args) {
            Some(endpoint) => {
                let path = endpoint.split('?').next().unwrap_or(endpoint);
                match path {
                    "rate_limit" => CallClass::Exempt,
                    _ if endpoint == "graphql" => CallClass::Gated(Bucket::Graphql),
                    _ if path.starts_with("search/code") => CallClass::Ungated,
                    _ if path.starts_with("search/") => CallClass::Gated(Bucket::Search),
                    _ => CallClass::Gated(Bucket::Core),
                }
            }
            None => CallClass::Ungated,
        },
        ["pr", "view" | "list", ..] => CallClass::Gated(Bucket::Graphql),
        ["run", "view" | "rerun" | "cancel", ..] => CallClass::Gated(Bucket::Core),
        ["search", "prs" | "issues", ..] => CallClass::Gated(Bucket::Search),
        _ => CallClass::Ungated,
    }
}

fn gate_host(args: &[&str], pinned: Option<&str>) -> Option<String> {
    if args.first() == Some(&"api") {
        let mut args = args.iter().skip(1);
        let mut explicit = None;
        while let Some(arg) = args.next() {
            if *arg == "--hostname" {
                explicit = args.next().copied();
            } else if let Some(host) = arg.strip_prefix("--hostname=") {
                explicit = Some(host);
            } else if api_value_flag(arg) {
                args.next();
            }
        }
        if let Some(host) = explicit {
            return Some(host.to_lowercase());
        }
    }
    // None groups unpinned calls across gh's default host chain, including ambient
    // GH_HOST and token hosts; it remains separate from an explicit github.com pin.
    pinned.map(str::to_lowercase)
}

fn trailing_url_path(stderr: &str) -> Option<&str> {
    let tail = stderr.trim().strip_suffix(')')?;
    let (_, url) = tail.rsplit_once('(')?;
    let authority_path = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let slash = authority_path.find('/')?;
    if slash == 0 || authority_path[..slash].contains(char::is_whitespace) {
        return None;
    }
    let path = &authority_path[slash..];
    if path.contains(char::is_whitespace) {
        return None;
    }
    Some(path.split('?').next().unwrap_or(path))
}

fn failure_bucket(class: CallClass, headers: &str, stderr: &str) -> Option<Bucket> {
    if let Some(resource) = response_header_value(headers, "x-ratelimit-resource") {
        // An untracked resource stops classification; argv and stderr cannot override it.
        return match resource.as_str() {
            "core" => Some(Bucket::Core),
            "graphql" => Some(Bucket::Graphql),
            "search" => Some(Bucket::Search),
            _ => None,
        };
    }
    match class {
        CallClass::Gated(bucket) => Some(bucket),
        CallClass::Exempt => None,
        CallClass::Ungated => {
            if stderr.contains("graphql:") {
                return Some(Bucket::Graphql);
            }
            let path = trailing_url_path(stderr)?;
            if matches!(path, "/graphql" | "/api/graphql") {
                return Some(Bucket::Graphql);
            }
            let search = path
                .strip_prefix("/search/")
                .or_else(|| path.strip_prefix("/api/v3/search/"))?;
            (search.split('/').next() != Some("code")).then_some(Bucket::Search)
        }
    }
}

fn is_rate_limit_response(stderr: &str, headers: &str) -> bool {
    crate::forge::session::gh_error_is_rate_limit(Some(stderr))
        || parse_status(headers) == Some(429)
}

fn limit_evidence(class: CallClass, out: &GhOutput, now: i64) -> Option<LimitEvidence> {
    if class == CallClass::Exempt || out.code == 0 {
        return None;
    }
    let stdout = out.stdout_lossy();
    let (headers, _) = split_response(&stdout);
    if !is_rate_limit_response(&out.stderr, headers) {
        return None;
    }
    let lower = out.stderr.to_lowercase();
    let bucket = failure_bucket(class, headers, &lower)?;
    let empty = response_header_value(headers, "x-ratelimit-remaining").as_deref() == Some("0");
    let kind = if lower.contains("secondary rate limit") || lower.contains("abuse detection") {
        LimitKind::Secondary
    } else if lower.contains("api rate limit exceeded") || lower.contains("already exceeded") {
        LimitKind::Primary
    } else if (crate::forge::session::gh_error_has_429_signal(&lower)
        || parse_status(headers) == Some(429))
        && !empty
    {
        LimitKind::Secondary
    } else {
        LimitKind::Primary
    };
    let until_hint = response_header_value(headers, "retry-after")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|seconds| *seconds >= 0)
        .map(|seconds| now.saturating_add(seconds))
        .or_else(|| {
            if !empty {
                return None;
            }
            response_header_value(headers, "x-ratelimit-reset")
                .and_then(|value| value.parse::<i64>().ok())
                .filter(|reset| *reset > 0)
                .map(|reset| reset.max(now.saturating_add(PRIMARY_FALLBACK_SECS)))
        });
    Some(LimitEvidence {
        bucket,
        kind,
        until_hint,
    })
}

fn is_bucket_success(out: &GhOutput) -> bool {
    let stdout = out.stdout_lossy();
    let headers = split_response(&stdout).0;
    !is_rate_limit_response(&out.stderr, headers)
        && (out.code == 0 || matches!(parse_status(headers), Some(200..=299 | 304)))
}

fn is_answered_non_limit(out: &GhOutput) -> bool {
    let stdout = out.stdout_lossy();
    if out.code == 0 || is_rate_limit_response(&out.stderr, split_response(&stdout).0) {
        return false;
    }
    let lower = out.stderr.to_lowercase();
    lower.match_indices("http ").any(|(index, _)| {
        let code = &lower.as_bytes()[index + 5..];
        code.len() >= 4
            && code[0] == b'4'
            && code[1].is_ascii_digit()
            && code[2].is_ascii_digit()
            && &code[..3] != b"429"
            && (code[3] == b':'
                || (code[3] == b')' && index > 0 && lower.as_bytes()[index - 1] == b'('))
    })
}

fn held_output(bucket: Bucket) -> GhOutput {
    GhOutput {
        stdout: Vec::new(),
        stderr: match bucket {
            Bucket::Core => HELD_CORE,
            Bucket::Graphql => HELD_GRAPHQL,
            Bucket::Search => HELD_SEARCH,
        }
        .into(),
        code: 1,
    }
}

pub(crate) fn probe_reading(body: &str, bucket: Bucket) -> Option<(u64, i64)> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let resource = value.get("resources")?.get(bucket.resource_name())?;
    Some((
        resource.get("remaining")?.as_u64()?,
        resource.get("reset")?.as_i64()?,
    ))
}

impl RateGate {
    fn verdict(&mut self, key: &RateKey, now: i64, epoch: u64) -> Verdict {
        let Some(entry) = self.entries.get_mut(key) else {
            return Verdict::Pass;
        };
        // Only Primary uses recheck_at; a Secondary hold ignores it and runs to its until.
        if entry.epoch != epoch
            || entry.until > now.saturating_add(MAX_HOLD_SECS + CLOCK_SLACK_SECS)
            || (entry.kind == LimitKind::Primary
                && entry.recheck_at > now.saturating_add(RECHECK_SECS + CLOCK_SLACK_SECS))
        {
            self.entries.remove(key);
            return Verdict::Pass;
        }
        if now >= entry.until {
            return Verdict::Pass;
        }
        if entry.kind == LimitKind::Primary && now >= entry.recheck_at && !entry.probe_pending {
            entry.probe_pending = true;
            entry.recheck_at = now.saturating_add(RECHECK_SECS);
            return Verdict::Recheck;
        }
        Verdict::Hold
    }

    fn record(
        &mut self,
        key: RateKey,
        ev: LimitEvidence,
        now: i64,
        epoch: u64,
        generation: u64,
    ) -> bool {
        if self
            .entries
            .get(&key)
            .is_some_and(|entry| entry.epoch > epoch)
        {
            return false;
        }
        self.generation = self.generation.saturating_add(1);
        let mut prior = self
            .entries
            .get_mut(&key)
            .filter(|entry| entry.epoch == epoch);
        if let Some(entry) = prior.as_mut().filter(|entry| now < entry.until) {
            if let Some(until) = ev.until_hint {
                let until = until.min(now.saturating_add(MAX_HOLD_SECS));
                if generation >= entry.generation || until > entry.until {
                    entry.until = until;
                }
            }
            if ev.kind == LimitKind::Secondary {
                let strikes = entry.strikes.max(1);
                let wait = (SECONDARY_BASE_SECS << strikes.saturating_sub(1).min(4))
                    .min(SECONDARY_MAX_SECS);
                let until = ev
                    .until_hint
                    .unwrap_or(now.saturating_add(wait))
                    .min(now.saturating_add(MAX_HOLD_SECS));
                entry.clear_floor = entry.clear_floor.max(until);
                // Replacing Primary timing can shorten a hold, so only current evidence
                // may demote it.
                if entry.kind == LimitKind::Primary && generation >= entry.generation {
                    entry.kind = LimitKind::Secondary;
                    entry.strikes = strikes;
                    entry.until = until;
                    entry.recheck_at = until;
                    entry.probe_pending = false;
                }
            }
            entry.until = entry.until.max(entry.clear_floor);
            entry.generation = self.generation;
            return false;
        }
        let strikes = if ev.kind == LimitKind::Secondary {
            prior.map_or(0, |entry| entry.strikes).saturating_add(1)
        } else {
            0
        };
        let wait = match ev.kind {
            LimitKind::Primary => PRIMARY_FALLBACK_SECS,
            LimitKind::Secondary => {
                (SECONDARY_BASE_SECS << strikes.saturating_sub(1).min(4)).min(SECONDARY_MAX_SECS)
            }
        };
        let until = ev
            .until_hint
            .unwrap_or(now.saturating_add(wait))
            .min(now.saturating_add(MAX_HOLD_SECS));
        let probe_pending = ev.kind == LimitKind::Primary && ev.until_hint.is_none();
        self.entries.insert(
            key,
            HoldEntry {
                until,
                clear_floor: if ev.kind == LimitKind::Secondary {
                    until
                } else {
                    0
                },
                recheck_at: if ev.kind == LimitKind::Primary {
                    until.min(now.saturating_add(RECHECK_SECS))
                } else {
                    until
                },
                epoch,
                generation: self.generation,
                strikes,
                kind: ev.kind,
                probe_pending,
            },
        );
        probe_pending
    }

    fn apply_probe(
        &mut self,
        key: &RateKey,
        reading: Option<(u64, i64)>,
        // True for a probe started by recording a hold; a recording probe never clears.
        at_record: bool,
        now: i64,
        epoch: u64,
        generation: u64,
    ) -> bool {
        let Some(entry) = self
            .entries
            .get_mut(key)
            .filter(|entry| entry.epoch == epoch)
        else {
            return false;
        };
        entry.probe_pending = false;
        // Primary quota readings cannot settle a Secondary hold.
        if entry.kind == LimitKind::Secondary {
            return false;
        }
        // Probes predating a refusal or inside a Secondary wait may only lengthen the hold.
        if generation < entry.generation || now < entry.clear_floor {
            if let Some((0, reset)) = reading.filter(|(_, reset)| *reset > now) {
                let until = reset.min(now.saturating_add(MAX_HOLD_SECS));
                if until > entry.until {
                    entry.until = until;
                    entry.recheck_at = entry.recheck_at.min(until);
                }
            }
            return false;
        }
        match reading {
            Some((0, reset)) if reset > now => {
                entry.until = reset.min(now.saturating_add(MAX_HOLD_SECS));
                entry.recheck_at = entry.until.min(now.saturating_add(RECHECK_SECS));
            }
            // A recording probe never clears: /rate_limit has returned stale used: 0.
            Some((remaining, _)) if remaining > 0 && !at_record => {
                self.entries.remove(key);
                return true;
            }
            _ => {}
        }
        false
    }

    fn clear(&mut self, key: &RateKey) {
        self.entries.remove(key);
    }
}

static RATE_GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();

fn rate_gate() -> &'static Mutex<RateGate> {
    RATE_GATE.get_or_init(|| Mutex::new(RateGate::default()))
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

fn gate_before(
    gate: &'static Mutex<RateGate>,
    gh: &std::path::Path,
    gh_host: Option<&str>,
    args: &[&str],
    epoch: u64,
) -> Option<GhOutput> {
    gate_before_inner(
        gate,
        gh_host,
        args,
        epoch,
        now_epoch_secs(),
        |key, at_record| {
            spawn_probe(gate, gh.to_path_buf(), key, at_record, epoch);
        },
    )
}

fn gate_before_inner(
    gate: &Mutex<RateGate>,
    gh_host: Option<&str>,
    args: &[&str],
    epoch: u64,
    now: i64,
    probe: impl FnOnce(RateKey, bool),
) -> Option<GhOutput> {
    let CallClass::Gated(bucket) = classify_call(args) else {
        return None;
    };
    let key = (gate_host(args, gh_host), bucket);
    let verdict = gate
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .verdict(&key, now, epoch);
    match verdict {
        Verdict::Pass => None,
        Verdict::Hold => Some(held_output(bucket)),
        Verdict::Recheck => {
            probe(key, false);
            Some(held_output(bucket))
        }
    }
}

fn gate_after(
    gate: &'static Mutex<RateGate>,
    gh: &std::path::Path,
    gh_host: Option<&str>,
    args: &[&str],
    out: &GhOutput,
    epoch: u64,
    generation: u64,
) {
    gate_after_inner(
        gate,
        gh_host,
        args,
        out,
        (epoch, gh_auth_epoch(), generation),
        now_epoch_secs(),
        |key, at_record| {
            spawn_probe(gate, gh.to_path_buf(), key, at_record, epoch);
        },
    );
}

fn gate_after_inner(
    gate: &Mutex<RateGate>,
    gh_host: Option<&str>,
    args: &[&str],
    out: &GhOutput,
    (epoch, current_epoch, generation): (u64, u64, u64),
    now: i64,
    probe: impl FnOnce(RateKey, bool),
) {
    // Account switches retire every result from the previous epoch, including success.
    if epoch != current_epoch {
        return;
    }
    let class = classify_call(args);
    if class == CallClass::Exempt {
        return;
    }
    let host = gate_host(args, gh_host);
    if is_bucket_success(out)
        || (matches!(class, CallClass::Gated(_)) && is_answered_non_limit(out))
    {
        // An Ungated success clears nothing because its bucket is unknown.
        if let CallClass::Gated(bucket) = class {
            let mut gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            let key = (host, bucket);
            if gate
                .entries
                .get(&key)
                .is_some_and(|entry| generation >= entry.generation)
            {
                gate.clear(&key);
            }
        }
        return;
    }
    // Late refusals still record after a newer success because over-holding is safer.
    // Generation checks permit extending a newer hold, but prevent shortening it.
    if let Some(ev) = limit_evidence(class, out, now) {
        let key = (host, ev.bucket);
        let should_probe = gate.lock().unwrap_or_else(|p| p.into_inner()).record(
            key.clone(),
            ev,
            now,
            epoch,
            generation,
        );
        if should_probe {
            probe(key, true);
        }
    }
}

fn spawn_probe(
    gate: &'static Mutex<RateGate>,
    gh: PathBuf,
    key: RateKey,
    at_record: bool,
    epoch: u64,
) {
    let host = key.0.clone();
    spawn_probe_with(gate, key, at_record, epoch, async move {
        rate_limit_probe(&gh, &host).await
    });
}

fn spawn_probe_with(
    gate: &'static Mutex<RateGate>,
    key: RateKey,
    at_record: bool,
    epoch: u64,
    fut: impl std::future::Future<Output = Option<String>> + Send + 'static,
) {
    let generation = gate.lock().unwrap_or_else(|p| p.into_inner()).generation;
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        gate.lock().unwrap_or_else(|p| p.into_inner()).apply_probe(
            &key,
            None,
            at_record,
            now_epoch_secs(),
            epoch,
            generation,
        );
        return;
    };
    runtime.spawn(async move {
        let reading = fut.await.and_then(|body| probe_reading(&body, key.1));
        gate.lock().unwrap_or_else(|p| p.into_inner()).apply_probe(
            &key,
            reading,
            at_record,
            now_epoch_secs(),
            epoch,
            generation,
        );
    });
}

async fn rate_limit_probe(gh: &std::path::Path, host: &Option<String>) -> Option<String> {
    let mut args = vec!["api", "rate_limit"];
    if let Some(host) = host {
        args.extend(["--hostname", host]);
    }
    let out = spawn_gh_resolved(gh, None, None, &args, None, RATE_LIMIT_PROBE_TIMEOUT)
        .await
        .ok()?;
    if out.code == 0 {
        String::from_utf8(out.stdout).ok()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::tree_fixture::Wrapper;
    use super::*;
    use crate::agent::ChildEnv;
    use crate::proc_tree::test_support::{
        remove_when_free, started_within, wait_until, Holder, Keeps, HANG_GUARD,
    };

    const RATE_NOW: i64 = 1_800_000_000;

    fn rate_key() -> (Option<String>, Bucket) {
        (Some("github.com".into()), Bucket::Core)
    }

    fn rate_ev(kind: LimitKind, until_hint: Option<i64>) -> LimitEvidence {
        LimitEvidence {
            bucket: Bucket::Core,
            kind,
            until_hint,
        }
    }

    fn rate_out(stderr: &str, headers: &str) -> GhOutput {
        GhOutput {
            stdout: headers.as_bytes().to_vec(),
            stderr: stderr.into(),
            code: 1,
        }
    }

    #[test]
    fn rate_call_classes() {
        use Bucket::*;
        use CallClass::*;
        let cases: &[(&[&str], CallClass)] = &[
            (&["api", "graphql"], Gated(Graphql)),
            (&["api", "-X", "POST", "graphql"], Gated(Graphql)),
            (&["api", "--method=GET", "repos/o/r"], Gated(Core)),
            (&["api", "/repos/o/r", "-H", "x", "-f", "a=b"], Gated(Core)),
            (&["api", "search/issues?q=x"], Gated(Search)),
            (&["api", "search/code?q=x"], Ungated),
            (&["api", "rate_limit"], Exempt),
            (&["api", "-i", "rate_limit", "--hostname", "h"], Exempt),
            (&["api", "/rate_limit?x=y"], Exempt),
            (&["api"], Ungated),
            (&["pr", "view", "1"], Gated(Graphql)),
            (&["pr", "list"], Gated(Graphql)),
            (&["pr", "diff", "1"], Ungated),
            (&["run", "view", "5", "-R", "o/r"], Gated(Core)),
            (&["run", "rerun", "5"], Gated(Core)),
            (&["run", "cancel", "5"], Gated(Core)),
            (&["search", "prs", "x"], Gated(Search)),
            (&["search", "issues", "x"], Gated(Search)),
            (&["issue", "view", "1"], Ungated),
            (&["auth", "status", "--json", "hosts"], Exempt),
            (&["auth", "token", "--hostname", "h"], Exempt),
            (&["release", "view", "v1"], Ungated),
            (&[], Ungated),
        ];
        for (args, expected) in cases {
            assert_eq!(classify_call(args), *expected, "{args:?}");
        }
        for flag in [
            "-X",
            "--method",
            "-H",
            "--header",
            "-f",
            "--raw-field",
            "-F",
            "--field",
            "--hostname",
            "--input",
            "-q",
            "--jq",
            "-t",
            "--template",
            "--cache",
            "-p",
            "--preview",
        ] {
            assert_eq!(
                classify_call(&["api", flag, "value", "graphql"]),
                Gated(Graphql)
            );
        }
        for flag in [
            "-XGET",
            "-fa=b",
            "--header=x",
            "-i",
            "--include",
            "--paginate",
            "--slurp",
            "--silent",
            "--verbose",
        ] {
            assert_eq!(classify_call(&["api", flag, "graphql"]), Gated(Graphql));
        }
    }

    #[test]
    fn rate_hosts_follow_explicit_api_host_then_pin() {
        assert_eq!(
            gate_host(&["api", "user", "--hostname", "H"], Some("PIN")),
            Some("h".into())
        );
        assert_eq!(
            gate_host(&["api", "--hostname=H", "user"], Some("PIN")),
            Some("h".into())
        );
        assert_eq!(gate_host(&["api", "user"], Some("PIN")), Some("pin".into()));
        assert_eq!(gate_host(&["api", "user"], None), None);
        assert_eq!(
            gate_host(&["pr", "view", "--hostname", "H"], Some("PIN")),
            Some("pin".into())
        );
    }

    #[test]
    fn rate_evidence_uses_bucket_priority_and_kind_wording() {
        use Bucket::*;
        use LimitKind::*;
        type EvidenceCase<'a> = (&'a [&'a str], &'a str, Option<(Bucket, LimitKind)>);
        let cases: &[EvidenceCase<'_>] = &[
            (&["api", "user"], "HTTP 403: API rate limit exceeded for user ID 12345 (https://api.github.com/)", Some((Core, Primary))),
            (&["issue", "view", "1"], "GraphQL: API rate limit exceeded for user ID 12345.", Some((Graphql, Primary))),
            (&["issue", "view", "1"], "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (https://api.github.com/graphql)", Some((Graphql, Secondary))),
            (&["issue", "view", "1"], "HTTP 429: Too Many Requests (https://api.github.com/search/issues?q=x)", Some((Search, Secondary))),
            (&["api", "repos/o/r"], "gh: API rate limit exceeded for user ID 1. (HTTP 403)", Some((Core, Primary))),
            (&["issue", "view", "1"], "API rate limit exceeded", None),
            (&["api", "repos/graphql/graphql-js"], "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/repos/graphql/graphql-js)", Some((Core, Primary))),
            (&["api", "repos/o/search"], "HTTP 403: API rate limit exceeded (https://api.github.com/repos/o/search)", Some((Core, Primary))),
            (&["issue", "view", "1"], "HTTP 403: API rate limit exceeded (https://api.github.com/repos/graphql/graphql-js)", None),
            (&["issue", "view", "1"], "HTTP 403: API rate limit exceeded (https://api.github.com/repos/o/search)", None),
            (&["issue", "view", "1"], "HTTP 403: API rate limit exceeded (https://ghe.example.com/api/graphql)", Some((Graphql, Primary))),
            (&["issue", "view", "1"], "HTTP 403: API rate limit exceeded (https://ghe.example.com/api/v3/search/issues?q=x)", Some((Search, Primary))),
            (&["issue", "view", "1"], "HTTP 403: API rate limit exceeded (https://api.github.com/search/code?q=x)", None),
            (&["issue", "view", "1"], "HTTP 429: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)", Some((Graphql, Primary))),
            (&["api", "repos/o/r"], "gh: API rate limit exceeded for user ID 1. (HTTP 429)", Some((Core, Primary))),
            (&["api", "repos/o/r"], "HTTP 429: Too Many Requests (https://api.github.com/repos/o/r)", Some((Core, Secondary))),
            (&["api", "repos/o/r"], "gh: Too Many Requests (HTTP 429)", Some((Core, Secondary))),
            (&["api", "repos/o/r"], "HTTP 403: Forbidden (https://api.github.com/repos/o/r)", None),
            (&["api", "user"], "gh: Resource not accessible by integration (HTTP 403)", None),
            (&["auth", "status"], "GraphQL: API rate limit exceeded", None),
            (&["api", "rate_limit"], "API rate limit exceeded", None),
            (&["api", "user"], "abuse detection", Some((Core, Secondary))),
            (&["api", "user"], "rate limit already exceeded (HTTP 429)", Some((Core, Primary))),
        ];
        for (args, stderr, expected) in cases {
            let out = rate_out(stderr, "");
            let actual = limit_evidence(classify_call(args), &out, RATE_NOW);
            assert_eq!(
                actual.map(|ev| (ev.bucket, ev.kind)),
                *expected,
                "{args:?}: {stderr}"
            );
        }
        let mut out = rate_out("API rate limit exceeded", "");
        out.code = 0;
        assert!(limit_evidence(classify_call(&["api", "user"]), &out, RATE_NOW).is_none());
    }

    #[test]
    fn rate_headers_set_resource_and_until() {
        let class = classify_call(&["api", "-i", "user"]);
        for (headers, bucket, until) in [
            (
                "Retry-After: 30\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1800000900"
                    .to_string(),
                Bucket::Core,
                RATE_NOW + 30,
            ),
            (
                format!(
                    "X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: {}",
                    RATE_NOW + 900
                ),
                Bucket::Core,
                RATE_NOW + 900,
            ),
            (
                format!(
                    "X-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: {}",
                    RATE_NOW - 120
                ),
                Bucket::Core,
                RATE_NOW + 60,
            ),
            (
                "X-Ratelimit-Resource: graphql\r\nRetry-After: 30".into(),
                Bucket::Graphql,
                RATE_NOW + 30,
            ),
        ] {
            let out = rate_out(
                "API rate limit exceeded",
                &format!("HTTP/2.0 403 Forbidden\r\n{headers}\r\n\r\n"),
            );
            let ev = limit_evidence(class, &out, RATE_NOW).unwrap();
            assert_eq!((ev.bucket, ev.until_hint), (bucket, Some(until)));
        }
        let out = rate_out(
            "GraphQL: API rate limit exceeded",
            "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Resource: code_search\r\n\r\n",
        );
        assert!(limit_evidence(class, &out, RATE_NOW).is_none());
        let out = rate_out(
            "HTTP 429: rate limit",
            "HTTP/2.0 429 Too Many Requests\r\nX-Ratelimit-Remaining: 0\r\n\r\n",
        );
        assert_eq!(
            limit_evidence(class, &out, RATE_NOW).unwrap().kind,
            LimitKind::Primary
        );
    }

    #[test]
    fn rate_primary_probes_and_rechecks() {
        let mut gate = RateGate::default();
        let key = rate_key();
        assert!(gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 60);
        assert_eq!(gate.entries[&key].clear_floor, 0);
        assert!(gate.entries[&key].probe_pending);
        assert!(!gate.apply_probe(
            &key,
            Some((0, RATE_NOW + 1800)),
            true,
            RATE_NOW,
            7,
            gate.generation
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 1800);
        assert_eq!(gate.entries[&key].recheck_at, RATE_NOW + 300);
        assert_eq!(gate.verdict(&key, RATE_NOW + 10, 7), Verdict::Hold);
        assert_eq!(gate.verdict(&key, RATE_NOW + 300, 7), Verdict::Recheck);
        assert_eq!(gate.verdict(&key, RATE_NOW + 300, 7), Verdict::Hold);
        assert!(gate.apply_probe(
            &key,
            Some((4000, 0)),
            false,
            RATE_NOW + 300,
            7,
            gate.generation
        ));
        assert!(!gate.entries.contains_key(&key));
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0,
        );
        assert!(!gate.apply_probe(&key, Some((4000, 0)), true, RATE_NOW, 7, gate.generation));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 60);
        for at_record in [true, false] {
            assert!(!gate.apply_probe(&key, None, at_record, RATE_NOW, 7, gate.generation));
            assert_eq!(gate.entries[&key].until, RATE_NOW + 60);
        }
        assert_eq!(gate.verdict(&key, RATE_NOW + 60, 7), Verdict::Pass);
    }

    #[test]
    fn rate_held_copy_keeps_existing_failure_class() {
        for (bucket, expected) in [
            (Bucket::Core, "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts."),
            (Bucket::Graphql, "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts."),
            (Bucket::Search, "GitHub's search API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts."),
        ] {
            let out = held_output(bucket);
            assert_eq!(out.code, 1);
            assert!(out.stdout.is_empty());
            assert_eq!(out.stderr, expected);
            let lower = out.stderr.to_lowercase();
            assert!(lower.contains("rate limit"));
            assert!(crate::forge::session::gh_error_is_rate_limit(Some(&out.stderr)));
            assert!(matches!(crate::forge::session::classify_gh_failure(&out.stderr), crate::forge::session::GhFailure::RateLimited));
            assert!(!out.stderr.bytes().any(|b| b.is_ascii_digit()));
            assert!(!out.stderr.split_whitespace().any(|word| {
                let labels: Vec<_> = word.split('.').collect();
                labels.len() >= 2 && labels.iter().all(|label| !label.is_empty())
            }));
            for forbidden in ["not found", "404", "401", "403", "429", "timeout", "connection", "network", "proxy", "eof", "required scopes"] {
                assert!(!lower.contains(forbidden), "{forbidden}");
            }
            assert!(!(lower.contains("limit reached") && lower.contains("resets")));
            assert!(matches!(conditional_outcome(None, &out).update, BodyUpdate::None));
        }
    }

    #[test]
    fn rate_secondary_strikes_expire_and_clear() {
        let mut gate = RateGate::default();
        let key = rate_key();
        let mut now = RATE_NOW;
        for (index, wait) in [60, 120, 240, 480, 900, 900].into_iter().enumerate() {
            assert!(!gate.record(key.clone(), rate_ev(LimitKind::Secondary, None), now, 7, 0));
            assert_eq!(gate.entries[&key].until, now + wait);
            assert_eq!(gate.entries[&key].strikes, index as u32 + 1);
            assert_eq!(gate.verdict(&key, now, 7), Verdict::Hold);
            now += wait;
            assert_eq!(gate.verdict(&key, now, 7), Verdict::Pass);
        }
        gate.clear(&key);
        gate.record(key.clone(), rate_ev(LimitKind::Secondary, None), now, 7, 0);
        assert_eq!(gate.entries[&key].until, now + 60);
    }

    #[test]
    fn rate_epoch_invalidates_and_ignores_old_probe() {
        let mut gate = RateGate::default();
        let key = rate_key();
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0,
        );
        assert_eq!(gate.verdict(&key, RATE_NOW, 8), Verdict::Pass);
        assert!(!gate.entries.contains_key(&key));
        assert!(!gate.apply_probe(
            &key,
            Some((0, RATE_NOW + 900)),
            true,
            RATE_NOW,
            7,
            gate.generation
        ));
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            8,
            0,
        );
        assert!(!gate.apply_probe(
            &key,
            Some((0, RATE_NOW + 900)),
            true,
            RATE_NOW,
            7,
            gate.generation
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 60);
    }

    #[test]
    fn rate_until_is_bounded() {
        let mut gate = RateGate::default();
        let key = rate_key();
        for kind in [LimitKind::Primary, LimitKind::Secondary] {
            gate.clear(&key);
            gate.record(
                key.clone(),
                rate_ev(kind, Some(RATE_NOW + 86400)),
                RATE_NOW,
                7,
                0,
            );
            assert_eq!(gate.entries[&key].until, RATE_NOW + 3660);
        }
        gate.apply_probe(
            &key,
            Some((0, RATE_NOW + 86400)),
            true,
            RATE_NOW,
            7,
            gate.generation,
        );
        assert_eq!(gate.entries[&key].until, RATE_NOW + 3660);
    }

    #[test]
    fn rate_buckets_and_hosts_are_independent() {
        let mut gate = RateGate::default();
        gate.record(
            rate_key(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0,
        );
        for key in [
            (Some("github.com".into()), Bucket::Graphql),
            (Some("github.com".into()), Bucket::Search),
            (Some("ghe.example.com".into()), Bucket::Core),
            (None, Bucket::Core),
        ] {
            assert_eq!(gate.verdict(&key, RATE_NOW, 7), Verdict::Pass);
        }
    }

    #[test]
    fn rate_active_record_keeps_strikes_and_accepts_header_hint() {
        let mut gate = RateGate::default();
        let key = rate_key();
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, None),
            RATE_NOW,
            7,
            0,
        );
        assert!(!gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, None),
            RATE_NOW + 1,
            7,
            0
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 61);
        assert_eq!(gate.entries[&key].strikes, 1);
        assert!(!gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, Some(RATE_NOW + 900)),
            RATE_NOW + 1,
            7,
            0
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 900);
        assert_eq!(gate.entries[&key].strikes, 1);
    }

    #[test]
    fn rate_success_accepts_exit_zero_and_http_success() {
        let mut out = rate_out("", "");
        out.code = 0;
        assert!(is_bucket_success(&out));
        for status in [200, 299, 304] {
            assert!(is_bucket_success(&rate_out(
                "",
                &format!("HTTP/2.0 {status} Response\r\n\r\n")
            )));
        }
        assert!(!is_bucket_success(&rate_out(
            "",
            "HTTP/2.0 403 Forbidden\r\n\r\n"
        )));
        let mut limited = rate_out(
            "GraphQL: API rate limit exceeded for user ID 1.",
            "HTTP/2.0 200 OK\r\n\r\n",
        );
        for code in [1, 0] {
            limited.code = code;
            assert!(
                !is_bucket_success(&limited),
                "rate-limit evidence outranks HTTP success"
            );
        }
    }

    #[test]
    fn rate_stale_secondary_without_headers_holds_for_its_full_wait() {
        let mut gate = RateGate::default();
        let key = rate_key();
        assert!(gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0
        ));
        assert!(!gate.apply_probe(&key, None, true, RATE_NOW + 1, 7, gate.generation));
        assert!(!gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, None),
            RATE_NOW + 45,
            7,
            0,
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 105);
        assert_eq!(gate.entries[&key].kind, LimitKind::Primary);
        assert_eq!(gate.entries[&key].recheck_at, RATE_NOW + 60);
        assert_eq!(gate.verdict(&key, RATE_NOW + 60, 7), Verdict::Recheck);
        assert_eq!(gate.verdict(&key, RATE_NOW + 105, 7), Verdict::Pass);
    }

    #[test]
    fn rate_secondary_demotion_preserves_all_recorded_secondary_waits() {
        let mut gate = RateGate::default();
        let key = rate_key();
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0,
        );
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, Some(RATE_NOW + 900)),
            RATE_NOW + 1,
            7,
            0,
        );
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, None),
            RATE_NOW + 2,
            7,
            gate.generation,
        );
        assert_eq!(gate.entries[&key].kind, LimitKind::Secondary);
        assert_eq!(gate.entries[&key].clear_floor, RATE_NOW + 900);
        assert_eq!(gate.entries[&key].until, RATE_NOW + 900);
        assert_eq!(gate.verdict(&key, RATE_NOW + 899, 7), Verdict::Hold);
    }

    #[test]
    fn rate_record_sequences_preserve_the_clear_floor() {
        let steps = [
            (LimitKind::Primary, None, true, 0),
            (LimitKind::Primary, Some(15), true, 15),
            (LimitKind::Primary, Some(86_400), false, 60),
            (LimitKind::Primary, None, false, 0),
            (LimitKind::Secondary, None, false, 45),
            (LimitKind::Secondary, None, true, 60),
            (LimitKind::Secondary, Some(15), true, 0),
            (LimitKind::Secondary, Some(900), false, 1),
        ];
        for length in 1..=4 {
            for sequence in 0..steps.len().pow(length) {
                let mut gate = RateGate::default();
                let key = rate_key();
                let mut now = RATE_NOW;
                let mut choices = sequence;
                for step in 0..length {
                    let (kind, hint, current, elapsed) = steps[choices % steps.len()];
                    choices /= steps.len();
                    now += elapsed;
                    let generation = if current { gate.generation } else { 0 };
                    gate.record(
                        key.clone(),
                        rate_ev(kind, hint.map(|wait| now + wait)),
                        now,
                        7,
                        generation,
                    );
                    let entry = &gate.entries[&key];
                    assert!(
                        entry.until >= entry.clear_floor,
                        "length {length}, sequence {sequence}, step {step}: until {} < floor {}",
                        entry.until,
                        entry.clear_floor
                    );
                    assert!(entry.until <= now + MAX_HOLD_SECS + CLOCK_SLACK_SECS);
                    if entry.kind == LimitKind::Primary {
                        assert!(entry.recheck_at <= now + RECHECK_SECS + CLOCK_SLACK_SECS);
                    }
                }
            }
        }
    }

    #[test]
    fn rate_secondary_evidence_blocks_quota_clear_until_its_wait_ends() {
        for hint in [Some(RATE_NOW + 121), Some(RATE_NOW + 901), None] {
            let mut gate = RateGate::default();
            let key = rate_key();
            assert!(gate.record(
                key.clone(),
                rate_ev(LimitKind::Primary, None),
                RATE_NOW,
                7,
                0,
            ));
            let probe_generation = gate.generation;
            assert!(!gate.record(
                key.clone(),
                rate_ev(LimitKind::Secondary, hint),
                RATE_NOW + 1,
                7,
                0,
            ));
            assert_eq!(gate.entries[&key].kind, LimitKind::Primary);
            assert_eq!(
                gate.entries[&key].clear_floor,
                hint.unwrap_or(RATE_NOW + 61)
            );
            assert_eq!(gate.entries[&key].recheck_at, RATE_NOW + 60);
            assert!(!gate.apply_probe(
                &key,
                Some((4000, 0)),
                true,
                RATE_NOW + 2,
                7,
                probe_generation,
            ));
            let now = if hint.is_some() {
                RATE_NOW + 60
            } else {
                RATE_NOW + 2
            };
            let verdict = if hint.is_some() {
                Verdict::Recheck
            } else {
                Verdict::Hold
            };
            assert_eq!(gate.verdict(&key, now, 7), verdict);
            let until = gate.entries[&key].until;
            for reading in [Some((4000, 0)), Some((0, now + 1))] {
                assert!(!gate.apply_probe(&key, reading, false, now, 7, gate.generation));
                assert_eq!(gate.entries[&key].until, until);
                assert!(!gate.entries[&key].probe_pending);
                assert!(gate.entries[&key].recheck_at <= now + RECHECK_SECS + CLOCK_SLACK_SECS);
                assert_eq!(gate.verdict(&key, now, 7), Verdict::Hold);
            }
            assert!(gate.apply_probe(
                &key,
                Some((4000, 0)),
                false,
                hint.unwrap_or(RATE_NOW + 61) + 1,
                7,
                gate.generation,
            ));
            assert!(!gate.entries.contains_key(&key));
        }
    }

    #[test]
    fn rate_secondary_refusal_demotes_an_active_primary_hold() {
        for hint in [Some(RATE_NOW + 121), None, Some(RATE_NOW + 2)] {
            let mut gate = RateGate::default();
            let key = rate_key();
            assert!(gate.record(
                key.clone(),
                rate_ev(LimitKind::Primary, None),
                RATE_NOW,
                7,
                0
            ));
            let probe_generation = gate.generation;
            assert!(!gate.record(
                key.clone(),
                rate_ev(LimitKind::Secondary, hint),
                RATE_NOW + 1,
                7,
                probe_generation,
            ));
            let until = hint.unwrap_or(RATE_NOW + 61);
            assert_eq!(gate.entries[&key].kind, LimitKind::Secondary);
            assert_eq!(gate.entries[&key].strikes, 1);
            assert_eq!(gate.entries[&key].until, until);
            assert_eq!(gate.entries[&key].clear_floor, until);
            assert_eq!(gate.entries[&key].recheck_at, until);
            assert!(!gate.entries[&key].probe_pending);
            assert_eq!(gate.verdict(&key, RATE_NOW + 1, 7), Verdict::Hold);
            for generation in [probe_generation, gate.generation] {
                for reading in [Some((4000, 0)), Some((0, RATE_NOW + 62))] {
                    assert!(!gate.apply_probe(&key, reading, false, RATE_NOW + 1, 7, generation));
                    assert_eq!(gate.entries[&key].until, until);
                }
            }
            assert!(!gate.record(
                key.clone(),
                rate_ev(LimitKind::Primary, None),
                RATE_NOW + 1,
                7,
                0
            ));
            assert_eq!(gate.entries[&key].kind, LimitKind::Secondary);
            assert_eq!(gate.entries[&key].strikes, 1);
        }
    }

    #[test]
    fn rate_secondary_demotion_replaces_only_a_current_generation_primary_hold() {
        for current_generation in [true, false] {
            for hint in [None, Some(RATE_NOW + 131)] {
                let mut gate = RateGate::default();
                let key = rate_key();
                assert!(!gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Primary, Some(RATE_NOW + 2400)),
                    RATE_NOW,
                    7,
                    0,
                ));
                let generation = gate.generation;
                assert!(!gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Secondary, hint),
                    RATE_NOW + 10,
                    7,
                    if current_generation { generation } else { 0 },
                ));
                let entry = &gate.entries[&key];
                assert!(entry.generation > generation);
                if current_generation {
                    let until = hint.unwrap_or(RATE_NOW + 70);
                    assert_eq!(entry.until, until);
                    assert_eq!(entry.kind, LimitKind::Secondary);
                    assert_eq!(entry.strikes, 1);
                    assert_eq!(entry.recheck_at, until);
                    assert!(!entry.probe_pending);
                    assert_eq!(gate.verdict(&key, until + 1, 7), Verdict::Pass);
                    assert!(gate.record(
                        key.clone(),
                        rate_ev(LimitKind::Primary, None),
                        until + 1,
                        7,
                        gate.generation,
                    ));
                    assert_eq!(gate.entries[&key].kind, LimitKind::Primary);
                } else {
                    assert_eq!(entry.until, RATE_NOW + 2400);
                    assert_eq!(entry.kind, LimitKind::Primary);
                    assert_eq!(entry.strikes, 0);
                    assert_eq!(entry.recheck_at, RATE_NOW + 300);
                    assert_eq!(gate.verdict(&key, RATE_NOW + 71, 7), Verdict::Hold);
                }
            }
        }
    }

    #[test]
    fn rate_probe_reads_only_integer_bucket_fields() {
        let body = r#"{"resources":{"core":{"limit":5000,"used":22,"remaining":4978,"reset":1792907736}}}"#;
        assert_eq!(probe_reading(body, Bucket::Core), Some((4978, 1792907736)));
        assert_eq!(probe_reading(body, Bucket::Graphql), None);
        for body in [
            "no json",
            r#"{"resources":{"core":{"remaining":"0","reset":1}}}"#,
            r#"{"resources":{"core":{"remaining":0,"reset":1.5}}}"#,
            r#"{"resources":{"core":{"remaining":-1,"reset":1}}}"#,
            r#"{"resources":{"core":{"remaining":0}}}"#,
        ] {
            assert_eq!(probe_reading(body, Bucket::Core), None);
        }
    }

    fn seed_rate_hold(gate: &Mutex<RateGate>, host: &str) {
        let now = now_epoch_secs();
        gate.lock().unwrap_or_else(|p| p.into_inner()).record(
            (Some(host.into()), Bucket::Core),
            rate_ev(LimitKind::Primary, Some(now + 3600)),
            now,
            7,
            0,
        );
    }

    #[tokio::test]
    async fn rate_held_core_never_spawns() {
        static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
        let gate = GATE.get_or_init(|| Mutex::new(RateGate::default()));
        seed_rate_hold(gate, "zp-held-1.invalid");
        let out = run_gh_raw_resolved_with(
            std::path::Path::new("Z:/zp-nonexistent-gh/gh.exe"),
            None,
            Some("zp-held-1.invalid"),
            &["api", "repos/o/r"],
            Duration::from_secs(1),
            gate,
            7,
        )
        .await
        .unwrap();
        assert_eq!(out.stderr, HELD_CORE);
        assert_eq!(out.code, 1);
        assert!(out.stdout.is_empty());
    }

    #[tokio::test]
    async fn rate_gated_helper_holds_without_invoking_spawn() {
        static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
        let gate = GATE.get_or_init(|| Mutex::new(RateGate::default()));
        seed_rate_hold(gate, "zp-held-input.invalid");
        let out = run_gh_gated(
            std::path::Path::new("Z:/zp-nonexistent-gh/gh.exe"),
            Some("zp-held-input.invalid"),
            &["api", "repos/o/r/issues", "--input", "-"],
            gate,
            7,
            || -> std::future::Ready<AppResult<GhOutput>> {
                panic!("a held call must not invoke its spawn closure");
            },
        )
        .await
        .unwrap();
        assert_eq!(out.stderr, HELD_CORE);
        assert_eq!(out.code, 1);
        assert!(out.stdout.is_empty());
    }

    #[tokio::test]
    async fn rate_other_bucket_still_spawns() {
        static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
        let gate = GATE.get_or_init(|| Mutex::new(RateGate::default()));
        seed_rate_hold(gate, "zp-held-2.invalid");
        assert!(run_gh_raw_resolved_with(
            std::path::Path::new("Z:/zp-nonexistent-gh/gh.exe"),
            None,
            Some("zp-held-2.invalid"),
            &["api", "graphql"],
            Duration::from_secs(1),
            gate,
            7,
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn rate_detached_probe_survives_caller_abort() {
        static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
        let gate = GATE.get_or_init(|| Mutex::new(RateGate::default()));
        let key = rate_key();
        let now = now_epoch_secs();
        let reset = now + 1800;
        gate.lock().unwrap_or_else(|p| p.into_inner()).record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            now,
            7,
            0,
        );
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = notify.clone();
        let probe_key = key.clone();
        let (sent, received) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            spawn_probe_with(gate, probe_key, true, 7, async move {
                release.notified().await;
                Some(format!(
                    r#"{{"resources":{{"core":{{"remaining":0,"reset":{reset}}}}}}}"#
                ))
            });
            sent.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        tokio::time::timeout(Duration::from_secs(3), received)
            .await
            .expect("probe dispatch must return before its result is available")
            .expect("initiating caller must signal probe dispatch");
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        notify.notify_one();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let settled = {
                    let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
                    !guard.entries[&key].probe_pending && guard.entries[&key].until == reset
                };
                if settled {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn rate_clock_rollback_has_slack_and_secondary_bound() {
        let key = rate_key();
        for (rollback, expected) in [(600, Verdict::Pass), (5, Verdict::Hold), (1, Verdict::Hold)] {
            let mut gate = RateGate::default();
            gate.record(
                key.clone(),
                rate_ev(LimitKind::Primary, Some(RATE_NOW + 1800)),
                RATE_NOW,
                7,
                0,
            );
            assert_eq!(gate.verdict(&key, RATE_NOW - rollback, 7), expected);
            assert_eq!(gate.entries.contains_key(&key), expected != Verdict::Pass);
        }
        let mut gate = RateGate::default();
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Secondary, Some(RATE_NOW + 900)),
            RATE_NOW,
            7,
            0,
        );
        assert_eq!(gate.verdict(&key, RATE_NOW, 7), Verdict::Hold);
        assert_eq!(gate.verdict(&key, RATE_NOW - 4000, 7), Verdict::Pass);
    }

    #[test]
    fn rate_answered_non_limit_resets_secondary_strikes() {
        let key = rate_key();
        for (stderr, clears, expected_until) in [
            ("gh: Not Found (HTTP 404)", true, RATE_NOW + 121),
            ("HTTP 403: Resource not accessible", true, RATE_NOW + 121),
            (
                "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
                false,
                RATE_NOW + 180,
            ),
            ("HTTP 429: Too Many Requests", false, RATE_NOW + 181),
            ("gh: Too Many Requests (HTTP 429)", false, RATE_NOW + 181),
            ("HTTP 4040: odd", false, RATE_NOW + 180),
            ("(HTTP 4040)", false, RATE_NOW + 180),
            ("HTTP 40: odd", false, RATE_NOW + 180),
            ("HTTP 4ab: odd", false, RATE_NOW + 180),
            ("HTTP 500: failed", false, RATE_NOW + 180),
            ("connection failed", false, RATE_NOW + 180),
        ] {
            let mut gate = RateGate::default();
            gate.record(
                key.clone(),
                rate_ev(LimitKind::Secondary, None),
                RATE_NOW,
                7,
                0,
            );
            gate.record(
                key.clone(),
                rate_ev(LimitKind::Secondary, None),
                RATE_NOW + 60,
                7,
                0,
            );
            assert_eq!(gate.entries[&key].strikes, 2);
            let out = rate_out(stderr, "");
            assert_eq!(is_answered_non_limit(&out), clears, "{stderr}");
            let gate = Mutex::new(gate);
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "user"],
                &out,
                (7, 7, 2),
                RATE_NOW + 61,
                |_, _| panic!("an active secondary hold must not start a probe"),
            );
            let mut gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(gate.entries.contains_key(&key), !clears);
            if !clears {
                assert_eq!(gate.entries[&key].strikes, 2);
                assert_eq!(gate.entries[&key].until, expected_until, "{stderr}");
            }
            if clears {
                gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Secondary, None),
                    RATE_NOW + 61,
                    7,
                    0,
                );
                assert_eq!(gate.entries[&key].until, expected_until, "{stderr}");
            }
        }
        let mut out = rate_out("HTTP 404: Not Found", "");
        out.code = 0;
        assert!(!is_answered_non_limit(&out));
    }

    #[test]
    fn rate_wiring_stale_failure_never_records_or_probes() {
        let gate = Mutex::new(RateGate::default());
        let mut probes = 0;
        gate_after_inner(
            &gate,
            Some("github.com"),
            &["issue", "view", "1"],
            &rate_out("GraphQL: API rate limit exceeded", ""),
            (7, 8, 0),
            RATE_NOW,
            |_, _| {
                probes += 1;
            },
        );
        assert_eq!(probes, 0, "stale failures must not dispatch a probe");
        assert!(gate
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .is_empty());
    }

    #[test]
    fn rate_wiring_stale_results_preserve_current_hold() {
        for (args, out) in [
            (
                &["issue", "view", "1"][..],
                rate_out("GraphQL: API rate limit exceeded", ""),
            ),
            (
                &["pr", "view", "1"][..],
                GhOutput {
                    stdout: Vec::new(),
                    stderr: String::new(),
                    code: 0,
                },
            ),
            (
                &["pr", "view", "1"][..],
                rate_out("gh: Not Found (HTTP 404)", ""),
            ),
            (
                &["pr", "view", "1"][..],
                rate_out("", "HTTP/2.0 304 Not Modified\r\n\r\n"),
            ),
        ] {
            let key = (Some("github.com".into()), Bucket::Graphql);
            let mut gate = RateGate::default();
            for now in [RATE_NOW, RATE_NOW + 60] {
                gate.record(
                    key.clone(),
                    LimitEvidence {
                        bucket: Bucket::Graphql,
                        kind: LimitKind::Secondary,
                        until_hint: None,
                    },
                    now,
                    8,
                    0,
                );
            }
            let gate = Mutex::new(gate);
            let mut probes = 0;
            gate_after_inner(
                &gate,
                Some("github.com"),
                args,
                &out,
                (7, 8, 2),
                RATE_NOW + 61,
                |_, _| {
                    probes += 1;
                },
            );
            assert_eq!(probes, 0, "stale results must not dispatch a probe");
            let mut gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            let entry = gate
                .entries
                .get(&key)
                .expect("stale results must keep the current hold");
            assert_eq!(entry.epoch, 8);
            assert_eq!(entry.kind, LimitKind::Secondary);
            assert_eq!(entry.strikes, 2);
            assert_eq!(entry.until, RATE_NOW + 180);
            assert_eq!(entry.recheck_at, RATE_NOW + 180);
            assert!(!entry.probe_pending);
            assert_eq!(gate.verdict(&key, RATE_NOW + 61, 8), Verdict::Hold);
        }
    }

    #[test]
    fn rate_record_never_overwrites_a_newer_epoch() {
        let key = (Some("github.com".into()), Bucket::Graphql);
        let mut gate = RateGate::default();
        for now in [RATE_NOW, RATE_NOW + 60] {
            gate.record(
                key.clone(),
                LimitEvidence {
                    bucket: Bucket::Graphql,
                    kind: LimitKind::Secondary,
                    until_hint: None,
                },
                now,
                8,
                0,
            );
        }
        for now in [RATE_NOW + 61, RATE_NOW + 181] {
            for (kind, until_hint) in [
                (LimitKind::Primary, None),
                (LimitKind::Secondary, Some(now + 900)),
            ] {
                assert!(
                    !gate.record(
                        key.clone(),
                        LimitEvidence {
                            bucket: Bucket::Graphql,
                            kind,
                            until_hint,
                        },
                        now,
                        7,
                        0
                    ),
                    "an older epoch must not request a probe"
                );
                let entry = &gate.entries[&key];
                assert_eq!(entry.epoch, 8);
                assert_eq!(entry.kind, LimitKind::Secondary);
                assert_eq!(entry.strikes, 2);
                assert_eq!(entry.until, RATE_NOW + 180);
                assert_eq!(entry.recheck_at, RATE_NOW + 180);
                assert!(!entry.probe_pending);
            }
        }
    }

    #[test]
    fn rate_wiring_success_clears_only_a_gated_bucket() {
        for (args, clears_core) in [
            (&["api", "user"][..], true),
            (&["issue", "view", "1"][..], false),
        ] {
            let gate = Mutex::new(RateGate::default());
            for bucket in [Bucket::Core, Bucket::Graphql] {
                gate.lock().unwrap_or_else(|p| p.into_inner()).record(
                    (Some("github.com".into()), bucket),
                    LimitEvidence {
                        bucket,
                        kind: LimitKind::Primary,
                        until_hint: Some(RATE_NOW + 900),
                    },
                    RATE_NOW,
                    7,
                    0,
                );
            }
            let mut out = rate_out("", "");
            out.code = 0;
            gate_after_inner(
                &gate,
                Some("github.com"),
                args,
                &out,
                (7, 7, 2),
                RATE_NOW,
                |_, _| panic!("success must not start a probe"),
            );
            let gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(gate.entries.contains_key(&rate_key()), !clears_core);
            assert!(gate
                .entries
                .contains_key(&(Some("github.com".into()), Bucket::Graphql)));
        }
    }

    #[test]
    fn rate_wiring_exempt_calls_never_record() {
        let gate = Mutex::new(RateGate::default());
        let out = rate_out(
            "API rate limit exceeded",
            "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Resource: core\r\n\r\n",
        );
        for args in [&["auth", "status"][..], &["api", "rate_limit"][..]] {
            gate_after_inner(
                &gate,
                Some("github.com"),
                args,
                &out,
                (7, 7, 0),
                RATE_NOW,
                |_, _| panic!("exempt calls must not start a probe"),
            );
            assert!(gate
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .entries
                .is_empty());
        }
    }

    #[test]
    fn rate_wiring_recheck_holds_and_dispatches_once() {
        let gate = Mutex::new(RateGate::default());
        let key = rate_key();
        gate.lock().unwrap_or_else(|p| p.into_inner()).record(
            key.clone(),
            rate_ev(LimitKind::Primary, Some(RATE_NOW + 1800)),
            RATE_NOW,
            7,
            0,
        );
        let mut probes = 0;
        for _ in 0..2 {
            let held = gate_before_inner(
                &gate,
                Some("github.com"),
                &["api", "user"],
                7,
                RATE_NOW + 300,
                |probe_key, at_record| {
                    assert_eq!(probe_key, key);
                    assert!(!at_record);
                    assert!(
                        gate.lock().unwrap_or_else(|p| p.into_inner()).entries[&key].probe_pending
                    );
                    probes += 1;
                },
            )
            .expect("the call starting a recheck must still be held");
            assert_eq!(held.stderr, HELD_CORE);
            assert_eq!(held.code, 1);
            assert!(held.stdout.is_empty());
        }
        assert_eq!(probes, 1);
        for args in [
            &["issue", "view", "1"][..],
            &["auth", "status"][..],
            &["api", "rate_limit"][..],
        ] {
            assert!(gate_before_inner(
                &gate,
                Some("github.com"),
                args,
                7,
                RATE_NOW + 300,
                |_, _| panic!("ungated and exempt calls must not start a recheck")
            )
            .is_none());
        }
    }

    #[test]
    fn rate_bodyless_429_records_secondary_hold() {
        for (headers, wait) in [
            ("", 60),
            (
                "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n",
                120,
            ),
        ] {
            let gate = Mutex::new(RateGate::default());
            let mut probes = 0;
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "-i", "user"],
                &rate_out("gh: Too Many Requests (HTTP 429)", headers),
                (7, 7, 0),
                RATE_NOW,
                |_, _| {
                    probes += 1;
                },
            );
            let gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            let entry = gate
                .entries
                .get(&rate_key())
                .expect("a body-less 429 must record a hold");
            assert_eq!(entry.kind, LimitKind::Secondary);
            assert_eq!(entry.until, RATE_NOW + wait);
            assert_eq!(entry.strikes, 1);
            assert_eq!(probes, 0);
        }
    }

    #[test]
    fn rate_status_or_phrase_is_evidence_but_bare_403_is_not() {
        let class = classify_call(&["api", "-i", "user"]);
        for out in [
            rate_out(
                "",
                "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 120\r\n\r\n",
            ),
            rate_out("gh: TOO MANY REQUESTS (HTTP 403)", ""),
            rate_out("gh: rejected (HTTP 429)", ""),
        ] {
            assert!(limit_evidence(class, &out, RATE_NOW).is_some());
            assert!(!is_answered_non_limit(&out));
        }
        let permission = rate_out(
            "HTTP 403: Forbidden (https://api.github.com/repos/o/r)",
            "HTTP/2.0 403 Forbidden\r\n\r\n",
        );
        assert!(limit_evidence(class, &permission, RATE_NOW).is_none());
        assert!(is_answered_non_limit(&permission));
        let not_status = rate_out("gh: rejected (HTTP 4290)", "");
        assert!(limit_evidence(class, &not_status, RATE_NOW).is_none());
    }

    fn generation_five_hold() -> Mutex<RateGate> {
        let mut gate = RateGate {
            generation: 5,
            ..RateGate::default()
        };
        gate.entries.insert(
            rate_key(),
            HoldEntry {
                until: RATE_NOW + 180,
                clear_floor: RATE_NOW + 180,
                recheck_at: RATE_NOW + 180,
                epoch: 7,
                generation: 5,
                strikes: 2,
                kind: LimitKind::Secondary,
                probe_pending: false,
            },
        );
        Mutex::new(gate)
    }

    #[test]
    fn rate_success_cannot_clear_a_newer_generation() {
        for status in [200, 304] {
            for generation in [4, 5, 6] {
                let gate = generation_five_hold();
                let mut out = rate_out("", &format!("HTTP/2.0 {status} Response\r\n\r\n"));
                out.code = if status == 200 { 0 } else { 1 };
                gate_after_inner(
                    &gate,
                    Some("github.com"),
                    &["api", "user"],
                    &out,
                    (7, 7, generation),
                    RATE_NOW + 61,
                    |_, _| panic!("success must not start a probe"),
                );
                let gate = gate.lock().unwrap_or_else(|p| p.into_inner());
                assert_eq!(
                    gate.entries.contains_key(&rate_key()),
                    generation < 5,
                    "a success may only clear a hold that predates its call"
                );
                if generation < 5 {
                    let entry = &gate.entries[&rate_key()];
                    assert_eq!(entry.generation, 5);
                    assert_eq!(entry.strikes, 2);
                    assert_eq!(entry.until, RATE_NOW + 180);
                }
            }
        }
    }

    #[test]
    fn rate_answered_404_cannot_clear_a_newer_generation() {
        for generation in [4, 5, 6] {
            let gate = generation_five_hold();
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "user"],
                &rate_out("gh: Not Found (HTTP 404)", ""),
                (7, 7, generation),
                RATE_NOW + 61,
                |_, _| panic!("an answered 404 must not start a probe"),
            );
            let gate = gate.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(
                gate.entries.contains_key(&rate_key()),
                generation < 5,
                "an answered 404 may only clear a hold that predates its call"
            );
            if generation < 5 {
                let entry = &gate.entries[&rate_key()];
                assert_eq!(entry.generation, 5);
                assert_eq!(entry.strikes, 2);
                assert_eq!(entry.until, RATE_NOW + 180);
            }
        }
    }

    #[test]
    fn rate_old_generation_failures_still_record_and_extend() {
        let gate = generation_five_hold();
        let key = rate_key();
        for (headers, expected_generation) in [
            ("HTTP/2.0 403 Forbidden\r\nRetry-After: 900\r\n\r\n", 6),
            ("", 7),
        ] {
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "user"],
                &rate_out("secondary rate limit", headers),
                (7, 7, 4),
                RATE_NOW + 61,
                |_, _| panic!("secondary limits must not start a probe"),
            );
            let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(
                guard.generation, expected_generation,
                "each refusal must advance the generation"
            );
            assert_eq!(guard.entries[&key].generation, expected_generation);
            assert_eq!(guard.entries[&key].until, RATE_NOW + 961);
            assert_eq!(guard.entries[&key].strikes, 2);
        }
        gate.lock().unwrap_or_else(|p| p.into_inner()).clear(&key);
        let mut probes = 0;
        gate_after_inner(
            &gate,
            Some("github.com"),
            &["api", "user"],
            &rate_out("API rate limit exceeded", ""),
            (7, 7, 4),
            RATE_NOW + 62,
            |_, at_record| {
                assert!(at_record);
                probes += 1;
            },
        );
        let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(guard.generation, 8);
        assert_eq!(guard.entries[&key].generation, 8);
        assert_eq!(guard.entries[&key].until, RATE_NOW + 122);
        assert_eq!(probes, 1);
    }

    #[test]
    fn rate_stale_probe_can_lengthen_a_repeated_refusal() {
        for at_record in [true, false] {
            for reset in [RATE_NOW + 3000, RATE_NOW + 86400] {
                let mut gate = RateGate::default();
                let key = rate_key();
                gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Primary, None),
                    RATE_NOW,
                    7,
                    0,
                );
                let generation = gate.generation;
                gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Primary, None),
                    RATE_NOW + 1,
                    7,
                    0,
                );
                assert!(!gate.apply_probe(
                    &key,
                    Some((0, reset)),
                    at_record,
                    RATE_NOW + 2,
                    7,
                    generation,
                ));
                let entry = &gate.entries[&key];
                assert_eq!(
                    entry.until,
                    reset.min(RATE_NOW + 2 + MAX_HOLD_SECS),
                    "a stale probe must retain a later exhausted-bucket reset"
                );
                assert_eq!(entry.recheck_at, RATE_NOW + 60);
                assert_eq!(entry.generation, generation + 1);
                assert_eq!(entry.strikes, 0);
                assert!(!entry.probe_pending);
            }
        }
    }

    #[test]
    fn rate_probe_results_respect_generation() {
        let key = rate_key();
        for at_record in [false, true] {
            for reading in [Some((4000, 0)), Some((0, RATE_NOW + 120)), None] {
                let gate = generation_five_hold();
                let mut gate = gate.lock().unwrap_or_else(|p| p.into_inner());
                gate.entries.get_mut(&key).unwrap().probe_pending = true;
                let generation = gate.generation;
                gate.record(
                    key.clone(),
                    rate_ev(LimitKind::Secondary, Some(RATE_NOW + 900)),
                    RATE_NOW + 1,
                    7,
                    generation,
                );
                assert!(
                    !gate.apply_probe(&key, reading, at_record, RATE_NOW + 2, 7, generation,),
                    "a stale probe must not remove a newer hold"
                );
                let entry = &gate.entries[&key];
                assert_eq!(
                    entry.until,
                    RATE_NOW + 900,
                    "a stale probe must not shorten a newer hold"
                );
                assert_eq!(entry.recheck_at, RATE_NOW + 180);
                assert_eq!(entry.strikes, 2);
                assert_eq!(entry.kind, LimitKind::Secondary);
                assert_eq!(entry.epoch, 7);
                assert_eq!(entry.generation, 6);
                assert!(!entry.probe_pending);
            }
        }

        let mut gate = RateGate::default();
        gate.record(
            key.clone(),
            rate_ev(LimitKind::Primary, None),
            RATE_NOW,
            7,
            0,
        );
        let generation = gate.generation;
        assert!(!gate.apply_probe(
            &key,
            Some((0, RATE_NOW + 1800)),
            true,
            RATE_NOW,
            7,
            generation,
        ));
        assert_eq!(gate.entries[&key].until, RATE_NOW + 1800);
        assert_eq!(gate.entries[&key].recheck_at, RATE_NOW + 300);
        assert_eq!(gate.verdict(&key, RATE_NOW + 300, 7), Verdict::Recheck);
        assert!(gate.apply_probe(&key, Some((4000, 0)), false, RATE_NOW + 300, 7, generation,));
        assert!(!gate.entries.contains_key(&key));
    }

    #[tokio::test]
    async fn rate_probe_captures_generation_before_await() {
        static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
        let gate = GATE.get_or_init(|| Mutex::new(RateGate::default()));
        let key = rate_key();
        for at_record in [true, false] {
            let now = now_epoch_secs();
            {
                let mut guard = gate.lock().unwrap_or_else(|p| p.into_inner());
                guard.clear(&key);
                guard.record(key.clone(), rate_ev(LimitKind::Primary, None), now, 7, 0);
            }
            let (sent, received) = tokio::sync::oneshot::channel();
            spawn_probe_with(gate, key.clone(), at_record, 7, async move {
                received.await.unwrap();
                Some(format!(
                    r#"{{"resources":{{"core":{{"remaining":4000,"reset":{now}}}}}}}"#
                ))
            });
            gate.lock().unwrap_or_else(|p| p.into_inner()).record(
                key.clone(),
                rate_ev(LimitKind::Primary, Some(now + 900)),
                now,
                7,
                0,
            );
            sent.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let settled = gate
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .entries
                        .get(&key)
                        .is_none_or(|entry| !entry.probe_pending);
                    if settled {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("the detached probe must finish within the test deadline");
            let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
            let entry = guard
                .entries
                .get(&key)
                .expect("a detached stale probe must keep the newer hold");
            assert_eq!(entry.until, now + 900);
            assert!(!entry.probe_pending);
        }
    }

    #[test]
    fn rate_refusal_header_cannot_shorten_a_secondary_wait() {
        for generation in [4, 5, 6] {
            let gate = generation_five_hold();
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "user"],
                &rate_out(
                    "secondary rate limit",
                    "HTTP/2.0 429 Too Many Requests\r\nRetry-After: 60\r\n\r\n",
                ),
                (7, 7, generation),
                RATE_NOW + 60,
                |_, _| panic!("a secondary refusal must not start a probe"),
            );
            let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
            let entry = &guard.entries[&rate_key()];
            assert_eq!(
                entry.until,
                RATE_NOW + 180,
                "no refusal may shorten the hold below its recorded secondary wait"
            );
            assert_eq!(entry.strikes, 2);
            assert_eq!(entry.generation, 6);
        }
    }

    #[test]
    fn rate_429_signal_forms_agree_on_evidence_and_kind() {
        for (stderr, headers, stderr_signal, evidence) in [
            ("http 429:", "", true, true),
            ("(http 429)", "", true, true),
            ("too many requests", "", true, true),
            ("gh: Too Many Requests (HTTP 429)", "", true, true),
            ("", "HTTP/2.0 429 Too Many Requests\r\n\r\n", false, true),
            ("(http 4290)", "", false, false),
            ("429 too many", "", false, false),
        ] {
            assert_eq!(
                crate::forge::session::gh_error_has_429_signal(stderr),
                stderr_signal,
                "{stderr}"
            );
            assert_eq!(
                crate::forge::session::gh_error_is_rate_limit(Some(stderr)),
                stderr_signal,
                "{stderr}"
            );
            assert_eq!(
                is_rate_limit_response(stderr, headers),
                evidence,
                "{stderr}"
            );
            assert_eq!(
                limit_evidence(
                    CallClass::Gated(Bucket::Core),
                    &rate_out(stderr, headers),
                    RATE_NOW,
                )
                .map(|ev| ev.kind),
                evidence.then_some(LimitKind::Secondary),
                "{stderr}"
            );
        }
    }

    #[test]
    fn rate_new_429_signals_use_secondary_backoff() {
        for (stderr, headers, kind) in [
            (
                "",
                "HTTP/2.0 429 Too Many Requests\r\n\r\n",
                LimitKind::Secondary,
            ),
            ("too many requests", "", LimitKind::Secondary),
            (
                "API rate limit exceeded",
                "HTTP/2.0 429 Too Many Requests\r\n\r\n",
                LimitKind::Primary,
            ),
            (
                "",
                "HTTP/2.0 429 Too Many Requests\r\nX-Ratelimit-Remaining: 0\r\n\r\n",
                LimitKind::Primary,
            ),
            (
                "too many requests",
                "HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 0\r\n\r\n",
                LimitKind::Primary,
            ),
        ] {
            let gate = Mutex::new(RateGate::default());
            let mut probes = 0;
            gate_after_inner(
                &gate,
                Some("github.com"),
                &["api", "-i", "user"],
                &rate_out(stderr, headers),
                (7, 7, 0),
                RATE_NOW,
                |_, _| {
                    probes += 1;
                },
            );
            let guard = gate.lock().unwrap_or_else(|p| p.into_inner());
            let entry = &guard.entries[&rate_key()];
            assert_eq!(
                entry.kind, kind,
                "429 evidence without primary signals must be secondary"
            );
            assert_eq!(probes, usize::from(kind == LimitKind::Primary));
            assert_eq!(entry.until, RATE_NOW + 60);
        }
    }

    fn body_key(n: usize) -> GhBodyKey {
        (
            Some("repo".into()),
            Some("github.com".into()),
            vec!["api".into(), format!("repos/o/r/actions/runs?page={n}")],
        )
    }

    fn cached_body(now: Instant) -> CachedGhBody {
        CachedGhBody {
            etag: "W/\"abc\"".into(),
            body: b"{\"runs\":[]}".to_vec(),
            epoch: 7,
            touched: now,
        }
    }

    #[test]
    fn conditional_304_uses_status_and_keeps_weak_etag() {
        let entry = cached_body(Instant::now());
        for stderr in ["gh: HTTP 304", "unexpected end of JSON input"] {
            let out = GhOutput {
                stdout: b"HTTP/2.0 304 Not Modified\r\nEtag: \"abc\"\r\n\r\n".to_vec(),
                stderr: stderr.into(),
                code: 1,
            };
            let result = conditional_outcome(Some(&entry), &out);
            assert_eq!(result.out.code, 0);
            assert_eq!(result.out.stdout, entry.body);
            assert!(result.out.stderr.is_empty());
            assert!(matches!(result.update, BodyUpdate::Touch));
        }
    }

    #[test]
    fn conditional_200_strips_headers_and_stores_verbatim_etag() {
        let etag = format!("W/\"{}\"", "a".repeat(64));
        let out = GhOutput {
            stdout: format!("HTTP/2.0 200 OK\r\nEtag: {etag}\r\nCache-Control: private, max-age=60\r\n\r\n{{\"changed\":true}}").into_bytes(),
            stderr: "note".into(),
            code: 0,
        };
        let result = conditional_outcome(None, &out);
        assert_eq!(result.out.stdout, b"{\"changed\":true}");
        assert_eq!(result.out.stderr, "note");
        assert!(matches!(result.update, BodyUpdate::Store(token) if token == etag));
    }

    #[test]
    fn conditional_failures_and_missing_etags_never_store() {
        let mut cache = HashMap::new();
        for (stdout, code, body) in [
            (
                "HTTP/2.0 404 Not Found\r\nEtag: abc\r\n\r\n{\"message\":\"Not Found\"}",
                1,
                "{\"message\":\"Not Found\"}",
            ),
            ("HTTP/2.0 403 Forbidden\r\n\r\n{}", 1, "{}"),
            ("HTTP/2.0 500 Error\r\n\r\n{}", 1, "{}"),
            ("HTTP/2.0 304 Not Modified\r\n\r\n", 1, ""),
            ("HTTP/2.0 200 OK\r\n\r\n{}", 0, "{}"),
            ("HTTP/2.0 200 OK\r\nEtag: abc\r\n\r\n{}", 1, "{}"),
            ("plain body", 1, "plain body"),
        ] {
            let out = GhOutput {
                stdout: stdout.as_bytes().to_vec(),
                stderr: "gh: Not Found (HTTP 404)".into(),
                code,
            };
            let result = conditional_outcome(None, &out);
            assert_eq!(result.out.stdout, body.as_bytes());
            assert_eq!(result.out.code, code);
            assert_eq!(result.out.stderr, out.stderr);
            apply_body_update(&mut cache, body_key(0), None, &result, 7, 7, Instant::now());
            assert!(body_cache_get(
                &cache,
                &body_key(0),
                7,
                GH_BODY_CACHE_MAX_AGE,
                Instant::now(),
            )
            .is_none());
        }
    }

    #[test]
    fn conditional_epoch_key_and_retention_gate_the_header() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        body_cache_put(&mut cache, body_key(0), cached_body(now));
        let entry = body_cache_get(&cache, &body_key(0), 8, GH_BODY_CACHE_MAX_AGE, now);
        assert!(entry.is_none());
        assert_eq!(
            conditional_args(&["api", "repos/o/r"], entry.as_ref()),
            ["api", "repos/o/r", "-i"],
        );
        let mut next = cached_body(now);
        next.epoch = 8;
        body_cache_put(&mut cache, body_key(0), next);
        let entry = body_cache_get(&cache, &body_key(0), 8, GH_BODY_CACHE_MAX_AGE, now).unwrap();
        assert_eq!(entry.epoch, 8);
        assert_eq!(
            conditional_args(&["api", "repos/o/r"], Some(&entry)),
            ["api", "repos/o/r", "-i", "-H", "If-None-Match: W/\"abc\""],
        );
        for key in [
            (None, body_key(0).1, body_key(0).2),
            (body_key(0).0, None, body_key(0).2),
            body_key(1),
        ] {
            assert!(body_cache_get(&cache, &key, 8, GH_BODY_CACHE_MAX_AGE, now).is_none());
        }
        assert!(body_cache_get(
            &cache,
            &body_key(0),
            8,
            GH_BODY_CACHE_MAX_AGE,
            now + GH_BODY_CACHE_MAX_AGE,
        )
        .is_none());
    }

    #[test]
    fn conditional_cap_evicts_only_oldest_and_refresh_keeps_neighbors() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        for n in 0..GH_BODY_CACHE_CAP {
            body_cache_put(
                &mut cache,
                body_key(n),
                cached_body(now + Duration::from_secs(n as u64)),
            );
        }
        body_cache_put(
            &mut cache,
            body_key(0),
            cached_body(now + Duration::from_secs(100)),
        );
        assert_eq!(cache.len(), GH_BODY_CACHE_CAP);
        assert!(cache.contains_key(&body_key(1)));
        body_cache_put(
            &mut cache,
            body_key(64),
            cached_body(now + Duration::from_secs(101)),
        );
        assert_eq!(cache.len(), GH_BODY_CACHE_CAP);
        assert!(!cache.contains_key(&body_key(1)));
        for n in [0, 2, 63, 64] {
            assert!(cache.contains_key(&body_key(n)));
        }
    }

    #[test]
    fn conditional_host_bypass_delegates_before_cache_work() {
        let body = crate::github::repo_meta::tests::wiring_body(
            include_str!("runner.rs"),
            "run_gh_cached_get_raw_on_host",
        );
        let fallback = body
            .find("return run_gh_raw_resolved(&gh, repo_path, host, args, timeout).await;")
            .expect("bypass must delegate with the caller's resolved host");
        assert!(body.find("if bypassed {").unwrap() < fallback);
        assert!(fallback < body.find("let key =").unwrap());
    }

    #[test]
    fn conditional_bypass_flags_are_explicit() {
        for flag in [
            "--paginate",
            "--paginate=true",
            "--jq",
            "--jq=.id",
            "-q",
            "-q=.id",
            "--template",
            "--template={{.id}}",
            "-F",
            "-F=k=v",
            "-Fk=v",
            "-q.login",
            "-t{{.id}}",
            "-iXPOST",
            "--input",
            "--input=body",
            "-t",
            "--field",
            "--field=k=v",
            "-i",
            "--include",
            "--cache",
            "--cache=1m",
        ] {
            assert!(bypasses(&["api", "repos/o/r", flag]), "{flag}");
        }
        let cases: &[(&[&str], bool)] = &[
            (&[], false),
            (&["api", "repos/o/r"], false),
            (&["api", "repos/o/r", "-iF", "k=v"], true),
            (&["api", "repos/o/r", "-XGET"], false),
            (&["api", "--method", "GET", "repos/o/r", "-fk=v"], false),
            (&["api", "repos/o/r", "-X=GET"], false),
            (&["api", "repos/o/r", "-hXgEt", "-fk=v"], false),
            (&["api", "repos/o/r", "-hfkey=i", "-XGET"], false),
            (&["api", "repos/o/r", "-f", "-XGET"], true),
            (&["api", "repos/o/r", "-H", "-XGET", "-fk=v"], true),
            (&["api", "repos/o/r", "-HIf-Match:abc"], false),
            (&["api", "repos/o/r", "-pgraphql"], false),
            (&["api", "repos/o/r", "-h=false"], false),
            (&["api", "repos/o/r", "-XGETi"], true),
            (&["api", "repos/o/r", "-XGET", "-fkey=-q.login"], false),
            (&["api", "--method", "POST", "repos/o/r"], true),
            (&["api", "-X", "PATCH", "repos/o/r"], true),
            (&["api", "--method=DELETE", "repos/o/r"], true),
            (&["api", "-XPOST", "repos/o/r"], true),
            (&["api", "--method", "GET", "repos/o/r", "-f", "k=v"], false),
            (&["api", "-X", "get", "repos/o/r", "-f", "k=v"], false),
            (
                &["api", "--method=gEt", "repos/o/r", "--raw-field", "k=v"],
                false,
            ),
            (&["api", "-XGET", "repos/o/r", "-f", "k=v"], false),
            (&["api", "repos/o/r", "-f", "k=v"], true),
            (&["api", "repos/o/r", "--raw-field", "k=v"], true),
            (&["api", "repos/o/r", "--raw-field=k=v"], true),
            (&["api", "repos/o/r", "-fk=v"], true),
            (&["api", "-XGET", "repos/o/r", "-fk=v"], false),
            (&["api", "-XGET", "repos/o/r", "--raw-field=k=v"], false),
            (&["api", "-XGET", "repos/o/r", "-F", "k=v"], true),
            (&["api", "-XGET", "repos/o/r", "--field=k=v"], true),
        ];
        for (args, expected) in cases {
            assert_eq!(bypasses(args), *expected, "{args:?}");
        }
    }

    #[test]
    fn conditional_etags_accept_only_quoted_ascii_tokens() {
        for (etag, valid) in [
            ("\"abc\"", true),
            ("W/\"abc\"", true),
            ("\"\"", true),
            ("\"!#~\"", true),
            ("abc", false),
            ("\"ab\"c\"", false),
            ("\"a b\"", false),
            ("\"a\u{1}b\"", false),
            ("\"a\u{e9}b\"", false),
        ] {
            assert_eq!(valid_etag(etag), valid, "{etag:?}");
            let out = GhOutput {
                stdout: format!("HTTP/2.0 200 OK\r\nEtag: {etag}\r\n\r\nbody").into_bytes(),
                stderr: String::new(),
                code: 0,
            };
            let result = conditional_outcome(None, &out);
            assert_eq!(
                matches!(result.update, BodyUpdate::Store(_)),
                valid,
                "{etag:?}"
            );
            assert_eq!(result.out.stdout, b"body");
        }
    }

    #[test]
    fn conditional_invalid_utf8_headers_pass_through_without_caching() {
        let out = GhOutput {
            stdout: b"HTTP/2.0 200 OK\r\nEtag: \"abc\"\r\nX-Bad: \xff".to_vec(),
            stderr: "original stderr".into(),
            code: 1,
        };
        let result = conditional_outcome(None, &out);
        assert_eq!(result.out.stdout, out.stdout);
        assert_eq!(result.out.stderr, out.stderr);
        assert_eq!(result.out.code, out.code);
        assert!(matches!(result.update, BodyUpdate::None));
    }

    #[test]
    fn conditional_late_epoch_fill_preserves_current_entry() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        let mut current = cached_body(now);
        current.epoch = 8;
        body_cache_put(&mut cache, body_key(0), current.clone());
        let late = conditional_outcome(
            None,
            &GhOutput {
                stdout: b"HTTP/2.0 200 OK\r\nEtag: \"old\"\r\n\r\nold account".to_vec(),
                stderr: String::new(),
                code: 0,
            },
        );
        apply_body_update(&mut cache, body_key(0), None, &late, 7, 8, now);
        let hit = body_cache_get(&cache, &body_key(0), 8, GH_BODY_CACHE_MAX_AGE, now)
            .expect("late fill must preserve the current epoch entry");
        assert_eq!(hit.body, current.body);
        assert_eq!(hit.etag, current.etag);
    }

    #[test]
    fn shared_headers_preserve_both_empty_match_contracts() {
        let headers = "X-Test:\r\nX-Test: value\r\n\r\n";
        assert_eq!(
            response_header_value(headers, "x-test"),
            Some("value".into())
        );
        assert_eq!(response_header_line(headers, "x-test"), Some(String::new()));
        assert_eq!(
            response_header_value("X-Test:\r\n\r\nX-Test: body", "x-test"),
            None
        );
        assert_eq!(split_response("plain"), ("", "plain"));
        assert_eq!(
            split_response("HTTP/2.0 200 OK\r\nEtag: x"),
            ("HTTP/2.0 200 OK\r\nEtag: x", ""),
        );
    }

    #[test]
    fn conditional_cache_revalidates_and_replaces_bodies() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        let entry = cached_body(now);
        body_cache_put(&mut cache, body_key(0), entry.clone());
        let revalidated = conditional_outcome(
            Some(&entry),
            &GhOutput {
                stdout: b"HTTP/2.0 304 Not Modified\r\nEtag: \"abc\"\r\n\r\n".to_vec(),
                stderr: "gh: HTTP 304".into(),
                code: 1,
            },
        );
        let touched = now + Duration::from_secs(1);
        apply_body_update(
            &mut cache,
            body_key(0),
            Some(&entry),
            &revalidated,
            7,
            7,
            touched,
        );
        let hit = body_cache_get(&cache, &body_key(0), 7, GH_BODY_CACHE_MAX_AGE, touched).unwrap();
        assert_eq!(hit.etag, entry.etag);
        assert_eq!(hit.body, entry.body);
        assert_eq!(hit.touched, touched);
        let changed = conditional_outcome(
            Some(&hit),
            &GhOutput {
                stdout: b"HTTP/2.0 200 OK\r\nEtag: W/\"new\"\r\n\r\nchanged".to_vec(),
                stderr: String::new(),
                code: 0,
            },
        );
        apply_body_update(&mut cache, body_key(0), Some(&hit), &changed, 8, 8, touched);
        let hit = body_cache_get(&cache, &body_key(0), 8, GH_BODY_CACHE_MAX_AGE, touched).unwrap();
        assert_eq!(hit.body, b"changed");
        assert_eq!(hit.etag, "W/\"new\"");
        assert_eq!(hit.epoch, 8);
    }

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
    fn account_changing_commands_bump_the_auth_epoch() {
        // Owned by this test alone, so exact counts hold under parallel tests.
        static EPOCH: AtomicU64 = AtomicU64::new(0);
        let read = || EPOCH.load(Ordering::SeqCst);
        for args in [
            &["auth", "status", "--json", "hosts"][..],
            &["auth", "token", "--hostname", "github.com"][..],
            &["api", "user", "-q", ".login"][..],
            &["auth"][..],
            &[][..],
        ] {
            assert!(!changes_gh_account(args), "{args:?}");
            drop(auth_epoch_guard(&EPOCH, args));
            assert_eq!(read(), 0, "a read-only {args:?} must leave the epoch alone");
        }
        for (n, args) in [
            &["auth", "switch", "--user", "octocat"][..],
            &["auth", "login", "--web"][..],
            &["auth", "logout"][..],
            &["auth", "refresh", "-s", "project"][..],
        ]
        .into_iter()
        .enumerate()
        {
            assert!(changes_gh_account(args), "{args:?}");
            let guard = auth_epoch_guard(&EPOCH, args);
            assert_eq!(read(), n as u64, "the bump lands when the command ends");
            drop(guard);
            assert_eq!(read(), n as u64 + 1, "{args:?}");
        }
        let before = gh_auth_epoch();
        bump_gh_auth_epoch();
        assert!(gh_auth_epoch() > before);
    }

    #[test]
    fn scope_errors_match_either_marker_and_only_the_named_scope() {
        for raw in [
            "GraphQL: Your token has not been granted the REQUIRED SCOPES.",
            "missing scope Read:Project",
        ] {
            assert_eq!(
                map_scope_error(AppError::Gh(raw.into()), PROJECT_READ_SCOPE, "hint").to_string(),
                "hint"
            );
        }
        // Another family's scope name is not this family's gap.
        assert_eq!(
            map_scope_error(
                AppError::Gh("missing write:discussion".into()),
                PROJECT_READ_SCOPE,
                "hint"
            )
            .to_string(),
            "missing write:discussion"
        );
        assert!(matches!(
            map_scope_error(
                AppError::InvalidArgument("required scopes".into()),
                "x",
                "hint"
            ),
            AppError::InvalidArgument(_)
        ));
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

    #[test]
    fn a_gh_child_never_inherits_forced_colour() {
        let mut env = RecordingEnv::default();
        apply_gh_env(&mut env, None);
        assert_eq!(env.get("NO_COLOR"), Some("1"), "{env:?}");
        assert!(
            env.unset.iter().any(|k| k == "CLICOLOR_FORCE"),
            "{env:?}"
        );
    }

    /// Stand-in children for the stdin exchange: unix runs `sh`, Windows a `.cmd` in
    /// `dir`, so the Windows arm also takes std's batch-file path a wrapper gh takes.
    #[derive(Clone, Copy)]
    enum Shape {
        /// Copies stdin to stdout (findstr normalizes line ends on Windows).
        Echo,
        /// Prints `refused` to stderr and exits 3 without reading stdin.
        Refuse,
        /// Exits 0 without reading stdin or printing anything.
        QuietExit,
        /// Never reads stdin and lives about 3 s.
        Sleeper,
    }

    #[cfg(unix)]
    fn shape(_dir: &std::path::Path, shape: Shape) -> (PathBuf, Vec<&'static str>) {
        let script = match shape {
            Shape::Echo => "cat",
            Shape::Refuse => "echo refused >&2; exit 3",
            Shape::QuietExit => "exit 0",
            Shape::Sleeper => "exec sleep 3",
        };
        (PathBuf::from("sh"), vec!["-c", script])
    }

    #[cfg(windows)]
    fn shape(dir: &std::path::Path, shape: Shape) -> (PathBuf, Vec<&'static str>) {
        let (name, body) = match shape {
            Shape::Echo => (
                "echo.cmd",
                "@\"%SystemRoot%\\System32\\findstr.exe\" /R \"^\"\r\n",
            ),
            Shape::Refuse => ("refuse.cmd", "@echo refused 1>&2\r\n@exit /b 3\r\n"),
            Shape::QuietExit => ("quiet.cmd", "@exit /b 0\r\n"),
            Shape::Sleeper => ("sleeper.cmd", "@ping -n 4 127.0.0.1 >nul\r\n"),
        };
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        (path, Vec::new())
    }

    /// At least 4 MiB over short lines: past tokio's 2 MiB Windows staging buffer and
    /// any unix pipe buffer, so a write the child never reads really fails.
    fn big_text() -> (String, usize) {
        use std::fmt::Write as _;
        let mut text = String::with_capacity(5 << 20);
        let mut lines = 0usize;
        while text.len() < 4 << 20 {
            writeln!(text, "line {lines:07} {}", "x".repeat(100)).unwrap();
            lines += 1;
        }
        (text, lines)
    }

    /// The exchange tests bound their elapsed time well under any budget they pass.
    fn assert_quick(started: Instant) {
        let took = started.elapsed();
        assert!(took < Duration::from_secs(10), "{took:?}");
    }

    async fn run_shape(
        dir: &std::path::Path,
        which: Shape,
        input: Option<&str>,
        timeout: Duration,
    ) -> AppResult<GhOutput> {
        let (program, args) = shape(dir, which);
        spawn_gh_resolved(&program, None, None, &args, input, timeout).await
    }

    #[tokio::test]
    async fn a_large_multi_line_stdin_text_reaches_the_child_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (text, lines) = big_text();
        let budget = Duration::from_secs(60);
        let out = run_shape(dir.path(), Shape::Echo, Some(&text), budget)
            .await
            .expect("the echo child runs");
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        let echoed = String::from_utf8_lossy(&out.stdout);
        let got: Vec<&str> = echoed.lines().collect();
        let sent: Vec<&str> = text.lines().collect();
        assert_eq!(got.len(), lines);
        assert_eq!(got.first(), sent.first());
        assert_eq!(got.last(), sent.last());
    }

    #[tokio::test]
    async fn a_child_that_exits_unread_keeps_its_exit_code_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let (text, _) = big_text();
        let started = Instant::now();
        let budget = Duration::from_secs(30);
        let out = run_shape(dir.path(), Shape::Refuse, Some(&text), budget)
            .await
            .expect("a reaped child is Ok whatever the write returned");
        assert_quick(started);
        assert_eq!(out.code, 3);
        assert!(out.stderr.contains("refused"), "stderr: {}", out.stderr);
    }

    /// Each argument's trimmed byte span in the first `callee` call (`callee` ends in `(`),
    /// split at top-level commas so the call's line layout doesn't matter.
    fn call_arg_spans(body: &str, callee: &str) -> Option<Vec<(usize, usize)>> {
        let start = body.find(callee)? + callee.len();
        let (mut depth, mut spans) = (0usize, vec![(start, start)]);
        for (i, c) in body[start..].char_indices() {
            let at = start + i;
            match c {
                ')' if depth == 0 => {
                    spans.last_mut()?.1 = at;
                    let trimmed = spans.into_iter().map(|(a, b)| {
                        let lead = body[a..b].len() - body[a..b].trim_start().len();
                        (a + lead, a + lead + body[a..b].trim().len())
                    });
                    return Some(trimmed.filter(|(a, b)| a < b).collect());
                }
                ',' if depth == 0 => {
                    spans.last_mut()?.1 = at;
                    spans.push((at + 1, at + 1));
                }
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
        }
        None
    }

    /// The host-pinned runners hand the caller's `host`, and every other argument, to the
    /// gate and the spawn under the auth-epoch guard, and never resolve a host of their own.
    #[test]
    fn the_on_host_runners_forward_the_pinned_host() {
        let source = include_str!("runner.rs");
        let args = |body: &str, callee: &str| -> Vec<String> {
            let spans = call_arg_spans(body, callee).unwrap_or_default();
            spans
                .iter()
                .map(|&(a, b)| body[a..b].split_whitespace().collect())
                .collect()
        };
        let with_arg = |body: &str, callee: &str, n: usize, to: &str| {
            let (a, b) = call_arg_spans(body, callee).expect(callee)[n];
            format!("{}{to}{}", &body[..a], &body[b..])
        };
        let resolves =
            |body: &str| body.contains("gh_host_for_repo(") || body.contains("gh_host_for_url(");
        const SPAWN: &str = "spawn_gh_resolved(";
        const GATE: &str = "run_gh_gated(";
        const RAW: &str = "run_gh_raw_resolved(";
        const GUARD: &str = "let _epoch_bump = auth_epoch_guard(";
        // Bound to a name so the bump lives for the whole call, not just its statement.
        let guarded = |body: &str| args(body, GUARD) == ["&GH_AUTH_EPOCH", "args"];
        let unguarded = |body: &str| body.replacen(GUARD, "let _epoch_bump = (", 1);

        let input =
            crate::github::repo_meta::tests::wiring_body(source, "run_gh_input_raw_on_host");
        let input_routed = |body: &str| {
            let (spawn, gate) = (args(body, SPAWN), args(body, GATE));
            spawn
                == [
                    "&gh",
                    "repo_path.map(std::path::Path::new)",
                    "host",
                    "args",
                    "Some(input)",
                    "timeout",
                ]
                && gate.len() == 6
                && gate[..5] == ["&gh", "host", "args", "rate_gate()", "epoch"]
                && gate[5].starts_with("||")
                && gate[5].contains(SPAWN)
                && body.contains("let epoch = gh_auth_epoch();")
                && guarded(body)
                && !body.contains("write_all")
                && !resolves(body)
        };
        assert!(input_routed(&input), "{input}");
        for (what, mutant) in [
            ("dropped cwd", with_arg(&input, SPAWN, 1, "None")),
            ("dropped spawn host", with_arg(&input, SPAWN, 2, "None")),
            ("dropped input", with_arg(&input, SPAWN, 4, "None")),
            ("spawn timeout", with_arg(&input, SPAWN, 5, "GH_TIMEOUT")),
            ("dropped gate host", with_arg(&input, GATE, 1, "None")),
            ("other gate", with_arg(&input, GATE, 3, "&OTHER_GATE")),
            ("gate epoch", with_arg(&input, GATE, 4, "0")),
            ("no guard", unguarded(&input)),
            (
                "inline write",
                format!("{input}\nstdin.write_all(input.as_bytes())"),
            ),
            ("own resolve", format!("{input}\ngh_host_for_url(url)")),
        ] {
            assert_ne!(mutant, input, "{what}");
            assert!(!input_routed(&mutant), "{what} must flip");
        }

        let raw = crate::github::repo_meta::tests::wiring_body(source, "run_gh_raw_on_host");
        let raw_routed = |body: &str| {
            args(body, RAW) == ["&gh", "repo_path", "host", "args", "timeout"]
                && guarded(body)
                && !resolves(body)
        };
        assert!(raw_routed(&raw), "{raw}");
        for (what, mutant) in [
            ("dropped host", with_arg(&raw, RAW, 2, "None")),
            ("raw timeout", with_arg(&raw, RAW, 4, "GH_TIMEOUT")),
            ("no guard", unguarded(&raw)),
            ("own resolve", format!("{raw}\ngh_host_for_repo(repo)")),
        ] {
            assert_ne!(mutant, raw, "{what}");
            assert!(!raw_routed(&mutant), "{what} must flip");
        }
    }

    /// The stdin runner resolves the real gh, so it is pinned to the seam the stand-in
    /// children above exercise rather than run.
    #[test]
    fn the_stdin_runner_exchanges_through_the_shared_seam() {
        let arg_spans = |body: &str| call_arg_spans(body, "spawn_gh_resolved(");
        let args = |body: &str| -> Vec<String> {
            let spans = arg_spans(body).unwrap_or_default();
            let text = spans.iter().map(|&(a, b)| &body[a..b]);
            text.map(|a| a.split_whitespace().collect::<String>())
                .collect()
        };
        // The repository is the working directory and its resolved host is passed on.
        let routed = |body: &str| {
            let a = args(body);
            a.len() == 6
                && a[1] == "repo_path.map(std::path::Path::new)"
                && a[2] == "host"
                && a[4] == "Some(input)"
                && body.contains("let host = gh_host.as_deref();")
                && !body.contains("write_all")
        };
        let with_arg = |body: &str, n: usize, to: &str| {
            let (a, b) = arg_spans(body).expect("a spawn_gh_resolved( call")[n];
            format!("{}{to}{}", &body[..a], &body[b..])
        };
        let body = crate::github::repo_meta::tests::wiring_body(
            include_str!("runner.rs"),
            "run_gh_input_raw",
        );
        let spans = arg_spans(&body).expect("run_gh_input_raw calls spawn_gh_resolved(");
        let (first, last) = (spans[0].0, spans[spans.len() - 1].1);
        let one_line = format!(
            "{}{}{}",
            &body[..first],
            args(&body).join(", "),
            &body[last..]
        );
        assert_ne!(one_line, body);
        for body in [&body, &one_line] {
            assert!(routed(body), "{body}");
            let inline = body.replace("spawn_gh_resolved(", "spawn_inline(");
            assert!(!routed(&inline), "the control must flip");
            let written = format!("{body}\nstdin.write_all(input.as_bytes())");
            assert!(!routed(&written), "the control must flip");
            assert!(
                !routed(&with_arg(body, 1, "None")),
                "a dropped cwd must flip"
            );
            assert!(
                !routed(&with_arg(body, 2, "None")),
                "a dropped host must flip"
            );
            assert!(
                !routed(&with_arg(body, 4, "None")),
                "a dropped input must flip"
            );
        }
    }

    #[tokio::test]
    async fn a_child_that_exits_zero_unread_is_ok_not_a_write_error() {
        let dir = tempfile::tempdir().unwrap();
        let (text, _) = big_text();
        let started = Instant::now();
        let budget = Duration::from_secs(30);
        let out = run_shape(dir.path(), Shape::QuietExit, Some(&text), budget)
            .await
            .expect("exit 0 after a failed write is still Ok");
        assert_quick(started);
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        assert!(out.stdout.is_empty());
    }

    #[tokio::test]
    async fn the_stdin_exchange_sits_inside_the_one_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let text = "y".repeat(1024);
        let started = Instant::now();
        let budget = Duration::from_secs(1);
        let res = run_shape(dir.path(), Shape::Sleeper, Some(&text), budget).await;
        assert!(matches!(res, Err(AppError::Timeout(1))), "{:?}", res.err());
        assert_quick(started);
    }

    #[tokio::test]
    async fn a_missing_program_with_stdin_text_is_gh_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-gh");
        let res = spawn_gh_resolved(
            &missing,
            None,
            None,
            &[],
            Some("text"),
            Duration::from_secs(10),
        )
        .await;
        assert!(matches!(res, Err(AppError::GhNotFound)), "{:?}", res.err());
    }

    #[tokio::test]
    async fn no_input_leaves_stdin_at_end_of_input() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let out = run_shape(dir.path(), Shape::Echo, None, Duration::from_secs(30))
            .await
            .expect("the echo child runs");
        assert_quick(started);
        assert!(out.stdout.is_empty(), "{}", out.stdout_lossy());
    }

    /// An empty text reaches the child as an immediate end of input.
    #[tokio::test]
    async fn an_empty_stdin_text_ends_the_input_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let budget = Duration::from_secs(30);
        let res = run_shape(dir.path(), Shape::Echo, Some(""), budget).await;
        assert_quick(started);
        let out = res.expect("the echo child runs");
        // findstr, the Windows echo, exits 1 when no line matched.
        let no_lines = if cfg!(windows) { 1 } else { 0 };
        assert_eq!(out.code, no_lines, "stderr: {}", out.stderr);
        assert!(out.stdout.is_empty(), "{}", out.stdout_lossy());
    }

    /// Text for a child whose stdin isn't piped would be dropped, so a debug build stops.
    /// The child's stdin is null and it exits on its own, so nothing waits on a pipe.
    #[cfg(debug_assertions)]
    #[tokio::test]
    #[should_panic(expected = "without a piped stdin")]
    async fn stdin_text_for_an_unpiped_child_fails_a_debug_build() {
        let mut command = if cfg!(windows) {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", "exit 0"]);
            c
        } else {
            tokio::process::Command::new("true")
        };
        let mut child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let _ = exchange_with_stdin(&mut child, Some(b"text")).await;
    }

    /// A wrapper-only gh: multi-line text fails at spawn as an argument (std refuses a
    /// line break in a batch-file argument) and travels whole on stdin.
    #[cfg(windows)]
    #[tokio::test]
    async fn a_cmd_wrapper_takes_multi_line_text_on_stdin_but_not_as_an_argument() {
        use std::fmt::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let special = "%PATH% \"q\" & ^ |";
        let mut text = String::new();
        for i in 0..1000 {
            if i == 500 {
                // Padded to the same 40 characters as every other line.
                writeln!(text, "{special:<39}").unwrap();
            } else {
                writeln!(text, "{i:04} {}", "z".repeat(34)).unwrap();
            }
        }
        assert_eq!(text.chars().count(), 40_000);

        let (program, _) = shape(dir.path(), Shape::Echo);
        let args = [
            "issue",
            "comment",
            "1",
            "--repo",
            "o/r",
            "--attach",
            "image-1.png",
            "--body-file",
            "-",
        ];
        let timeout = Duration::from_secs(30);
        let out = spawn_gh_resolved(&program, None, None, &args, Some(&text), timeout)
            .await
            .expect("the wrapper spawns with the text on stdin");
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        let echoed = String::from_utf8_lossy(&out.stdout);
        let got: Vec<&str> = echoed.lines().collect();
        assert_eq!(got.len(), 1000);
        assert_eq!(got[500].trim_end(), special);

        let as_arg = ["issue", "comment", "1", "--body", text.as_str()];
        let res = spawn_gh_resolved(&program, None, None, &as_arg, None, timeout).await;
        match res {
            Err(AppError::Io(e)) => assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput),
            other => panic!("expected a spawn refusal, got {:?}", other.err()),
        }
    }

    /// The armed-spawn pin over this file. Each control mutates the real text in memory:
    /// the first group must add the violation it names, the second must leave the verdict.
    #[test]
    fn every_gh_spawn_is_tree_armed() {
        use super::tree_fixture::unarmed_spawns;
        // The byte range of the first line of fn `name` that contains `needle`.
        fn line_in(src: &str, name: &str, needle: &str) -> std::ops::Range<usize> {
            let start = src.find(&format!("fn {name}(")).expect(name);
            let end = start + src[start..].find("\n}").expect("a closing line");
            let at = start
                + src[start..end]
                    .find(needle)
                    .unwrap_or_else(|| panic!("`{needle}` in {name}"));
            let from = src[..at].rfind('\n').map_or(0, |n| n + 1);
            let to = src[at..].find('\n').map_or(src.len(), |n| at + n + 1);
            from..to
        }
        fn swap(src: &str, name: &str, needle: &str, with: &str) -> String {
            let line = line_in(src, name, needle);
            format!("{}{with}{}", &src[..line.start], &src[line.end..])
        }
        fn rename(src: &str, name: &str, from: &str, to: &str) -> String {
            let line = line_in(src, name, from);
            let text = src[line.clone()].replacen(from, to, 1);
            format!("{}{text}{}", &src[..line.start], &src[line.end..])
        }
        // Moves fn `name`'s `moved` line above its `anchor` line.
        fn hoist(src: &str, name: &str, moved: &str, anchor: &str) -> String {
            let line = src[line_in(src, name, moved)].to_string();
            let without = swap(src, name, moved, "");
            let at = line_in(&without, name, anchor).start;
            format!("{}{line}{}", &without[..at], &without[at..])
        }
        fn above(src: &str, item: &str, text: &str) -> String {
            let at = src.find(item).expect(item);
            let at = src[..at].rfind('\n').map_or(0, |n| n + 1);
            format!("{}{text}{}", &src[..at], &src[at..])
        }
        // Inserts `text` below fn `name`'s first line that contains `needle`.
        fn below(src: &str, name: &str, needle: &str, text: &str) -> String {
            let line = line_in(src, name, needle);
            format!("{}{text}{}", &src[..line.end], &src[line.end..])
        }
        // Inserts `text` above fn `name`'s first line that contains `needle`.
        fn above_line(src: &str, name: &str, needle: &str, text: &str) -> String {
            let line = line_in(src, name, needle);
            format!("{}{text}{}", &src[..line.start], &src[line.start..])
        }

        let src = include_str!("runner.rs").replace("\r\n", "\n");
        let (violations, roster) = unarmed_spawns(&src);
        assert!(violations.is_empty(), "{violations:#?}");
        assert_eq!(
            roster,
            ["probe_exit", "spawn_gh_resolved"],
            "a new correctly armed spawning fn: add its name to this roster"
        );

        let next = "async fn spawn_gh_resolved(";
        let rogue = "fn rogue(cmd: &mut Command) {\n    let _ = cmd.spawn();\n}\n";
        let one_line = "fn rogue(cmd: &mut Command) { let _ = cmd.spawn(); }\n";
        let in_impl = "impl Rogue {\n    fn go(cmd: &mut Command) {\n        let _ = cmd.spawn();\n    }\n}\n";
        let seam = "#[cfg(test)]\nstatic X: u8 = 0;\n";
        let kill = "cmd.kill_on_drop(true);";
        let untested = src
            .lines()
            .filter(|l| l.trim_end() != "#[cfg(test)]")
            .collect::<Vec<_>>()
            .join("\n");
        let mut trips = vec![
            (above(&src, next, rogue), "`rogue`"),
            (above(&src, next, one_line), "was not read"),
            (
                swap(
                    &src,
                    "spawn_gh_resolved",
                    kill,
                    &format!("    cmd.output();\n    {kill}\n"),
                ),
                "`.output()`",
            ),
            (above(&src, next, in_impl), "outside"),
            (above(&src, next, &format!("{seam}{rogue}")), "`rogue`"),
            (untested.clone(), "no test module"),
            (untested, "outside"),
        ];
        for name in ["probe_exit", "spawn_gh_resolved"] {
            let arm = "TreeGuard::arm(";
            trips.extend([
                (rename(&src, name, arm, "TreeGuard::arm_tree("), name),
                (swap(&src, name, "guard.disarm();", ""), name),
                (swap(&src, name, kill, ""), name),
                (swap(&src, name, "TreeGuard::prepare(&mut cmd);", ""), name),
                (hoist(&src, name, "guard.disarm();", arm), name),
                (hoist(&src, name, arm, ".spawn()"), name),
                // A removed statement kept alive by a comment line still trips.
                (
                    swap(
                        &src,
                        name,
                        "guard.disarm();",
                        "        // guard.disarm();\n",
                    ),
                    name,
                ),
            ]);
        }
        for (text, mark) in &trips {
            assert_ne!(text, &src, "the {mark} control must change the text");
            let (found, _) = unarmed_spawns(text);
            assert!(
                found.iter().any(|v| v.contains(mark)),
                "a control left no {mark} violation: {found:#?}"
            );
        }
        // One control per body rule, each tripping that rule's own message.
        for name in ["probe_exit", "spawn_gh_resolved"] {
            let arm = "TreeGuard::arm(";
            let (spawns, disarm, moves, awaits) = (
                format!("`{name}` spawns"),
                format!("`{name}`'s disarm"),
                format!("`{name}` moves or rebinds"),
                format!("`{name}` awaits between"),
            );
            let controls = [
                (
                    above_line(&src, name, arm, "        tokio::task::yield_now().await;\n"),
                    &awaits,
                ),
                (
                    above_line(&src, name, "guard.disarm();", "        settle().await?;\n"),
                    &disarm,
                ),
                (
                    below(&src, name, arm, "        let _ = cmd.spawn();\n"),
                    &spawns,
                ),
                (
                    below(&src, name, arm, "        let _ = TreeGuard::arm(&child);\n"),
                    &spawns,
                ),
                (
                    swap(
                        &src,
                        name,
                        "guard.disarm();",
                        "        if ok { guard.disarm(); }\n",
                    ),
                    &disarm,
                ),
                (
                    below(&src, name, "guard.disarm();", "        guard.disarm();\n"),
                    &disarm,
                ),
                (
                    below(&src, name, arm, "        let mut child = child;\n"),
                    &moves,
                ),
                (below(&src, name, arm, "        consume(child);\n"), &moves),
            ];
            for (text, mark) in &controls {
                assert_ne!(text, &src, "the {mark} control must change the text");
                let (found, _) = unarmed_spawns(text);
                assert!(
                    found.iter().any(|v| v.contains(mark.as_str())),
                    "a control left no {mark} violation: {found:#?}"
                );
            }
        }

        let gone = rename(&src, "probe_exit", "probe_exit(", "probe_exit_gone(");
        assert_ne!(
            unarmed_spawns(&gone).1,
            roster,
            "a renamed fn must move the roster"
        );

        let reflowed = rename(
            &src,
            "spawn_gh_resolved",
            "cmd.spawn()",
            "cmd\n        .spawn()",
        );
        let keeps = [
            above(&src, next, seam),
            above(&src, kill, "    // cmd.output(); cmd.spawn();\n"),
            below(
                &src,
                "spawn_gh_resolved",
                "TreeGuard::arm(",
                "        // let mut child = cmd.spawn()?; TreeGuard::arm(&child); guard.disarm(); f(child);\n",
            ),
            rename(
                &reflowed,
                "probe_exit",
                kill,
                "cmd\n        .kill_on_drop(true);",
            ),
        ];
        for text in &keeps {
            assert_ne!(text, &src, "the control must change the text");
            assert_eq!(unarmed_spawns(text), (vec![], roster.clone()));
        }
    }

    /// The stored-login probe's stdout is the user's token: gh_stored_login sends it to
    /// null in its one `.stdout(` call (a later one would win) and reaches the child only
    /// through probe_exit, which sets no stdio. Matches these literal spellings only, over
    /// whitespace-stripped bodies.
    #[test]
    fn the_stored_login_probe_never_captures_stdout() {
        const CAPTURES: [&str; 9] = [
            "Stdio::piped",
            "Stdio::inherit",
            ".output(",
            "wait_with_output",
            "child.stdout",
            ".stdout.take(",
            "spawn_gh_resolved(",
            "exchange_with_stdin(",
            "run_gh",
        ];
        let body = |name: &str| -> String {
            crate::github::repo_meta::tests::wiring_body(include_str!("runner.rs"), name)
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect()
        };
        let holds = |login: &str, probe: &str| {
            login.contains(".stdout(Stdio::null())")
                && login.matches(".stdout(").count() == 1
                && login.contains("probe_exit(")
                && CAPTURES
                    .iter()
                    .all(|c| !login.contains(c) && !probe.contains(c))
                && [".stdout(", ".stderr(", ".stdin("]
                    .iter()
                    .all(|c| !probe.contains(c))
        };
        let (login, probe) = (body("gh_stored_login"), body("probe_exit"));
        assert!(holds(&login, &probe), "{login}\n{probe}");

        let piped = login.replace(".stdout(Stdio::null())", ".stdout(Stdio::piped())");
        let routed = login.replace("probe_exit(", "spawn_gh_resolved(");
        assert_ne!(piped, login);
        assert_ne!(routed, login);
        assert!(!holds(&piped, &probe), "a piped stdout must flip");
        assert!(!holds(&routed, &probe), "a capturing runner must flip");
        let set = format!("{probe}cmd.stdout(Stdio::null());");
        assert!(!holds(&login, &set), "stdio set in probe_exit must flip");
        let reset = format!("{login}cmd.stdout(sink);");
        assert!(
            !holds(&reset, &probe),
            "a second stdout, which would win, must flip"
        );
        for capture in CAPTURES {
            assert!(!holds(&format!("{login}{capture}"), &probe), "{capture}");
            assert!(!holds(&login, &format!("{probe}{capture}")), "{capture}");
        }
    }

    fn tree_dir(prefix: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("create temp dir")
    }

    /// The wrapper's command as gh_stored_login builds its own: null stdio, no console.
    fn login_probe_command(wrapper: &Wrapper) -> Command {
        let mut cmd = wrapper.command();
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }

    /// Dropping an armed gh call, which is all a timeout or a cancel does, kills
    /// everything its wrapper started. The holder is a descendant of the spawned shell
    /// and keeps both of the runner's pipes, and the stdin text is never read, so the drop
    /// lands on an unfinished write. The test drops the call itself once the holder has
    /// started, so no budget races startup.
    #[tokio::test]
    async fn an_abandoned_gh_call_kills_its_wrappers_whole_tree() {
        let dir = tree_dir("gd-gh-tree-");
        let holder = Holder::new(dir.path());
        let wrapper = Wrapper::new(dir.path(), "gh", &holder, Keeps::Both);
        let (program, args) = (wrapper.program(), wrapper.args());
        let (text, _) = big_text();
        let mut run = Box::pin(spawn_gh_resolved(
            program,
            None,
            None,
            &args,
            Some(&text),
            HANG_GUARD,
        ));
        // The first poll spawns and arms; only then may the wrapper start the holder.
        tokio::select! {
            biased;
            r = &mut run => panic!("the call settled before its gate: {:?}", r.map(|o| o.code)),
            () = std::future::ready(()) => {}
        }
        wrapper.mark_armed();
        tokio::select! {
            biased;
            r = &mut run => panic!("the call settled under its holder: {:?}", r.map(|o| o.code)),
            ok = started_within(&holder, HANG_GUARD) => assert!(ok, "the holder never started"),
        }
        drop(run);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the abandoned gh call"
        );
        remove_when_free(dir);
    }

    /// The control for the kill test above: the same wrapper spawned the runner's way but
    /// never armed, killed directly with its read ends dropped, leaves the holder running.
    #[tokio::test]
    async fn a_direct_kill_alone_leaves_the_gh_wrappers_child_running() {
        let dir = tree_dir("gd-gh-direct-");
        let holder = Holder::new(dir.path());
        let wrapper = Wrapper::new(dir.path(), "gh", &holder, Keeps::Both);
        let mut cmd = wrapper.command();
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        crate::proc_tree::TreeGuard::prepare(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn the wrapper");
        wrapper.mark_armed();
        assert!(
            started_within(&holder, HANG_GUARD).await,
            "the holder never started"
        );
        child.kill().await.expect("kill the wrapper");
        drop(child.stdout.take());
        drop(child.stderr.take());
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with a wrapper killed alone"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }

    /// A reaped gh call disarms, so what it started keeps running. The holder keeps
    /// neither of the runner's pipes, so both reach EOF and the wrapper is reaped while
    /// the holder lives.
    #[tokio::test]
    async fn a_reaped_gh_call_leaves_what_it_started_running() {
        let dir = tree_dir("gd-gh-reaped-");
        let holder = Holder::new(dir.path());
        let wrapper = Wrapper::new(dir.path(), "gh", &holder, Keeps::Neither);
        let (program, args) = (wrapper.program(), wrapper.args());
        let mut run = Box::pin(spawn_gh_resolved(
            program, None, None, &args, None, HANG_GUARD,
        ));
        tokio::select! {
            biased;
            r = &mut run => panic!("the call settled before its gate: {:?}", r.map(|o| o.code)),
            () = std::future::ready(()) => {}
        }
        wrapper.mark_armed();
        tokio::select! {
            biased;
            r = &mut run => panic!("the call settled under its holder: {:?}", r.map(|o| o.code)),
            ok = started_within(&holder, HANG_GUARD) => assert!(ok, "the holder never started"),
        }
        wrapper.let_finish();
        let out = run.await.unwrap_or_else(|e| {
            let why = "the holder kept one of the runner's pipes (a Keeps::Neither failure)";
            panic!("{e:?}: {why}, or the wrapper never saw its finish gate")
        });
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        assert!(out.stdout.is_empty(), "stdout: {}", out.stdout_lossy());
        assert!(out.stderr.is_empty(), "stderr: {}", out.stderr);
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with the reaped gh call"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }

    /// A reaped leader's output is the result at once, while a background job keeps its
    /// stdin open unread and more than a pipe's worth of text is still unwritten. The
    /// guard is then dropped armed: the group still has members, so its id still names
    /// them, and the kill takes the holder. Unix only: on Windows a helper cmd starts
    /// directly inherits every pipe (only proc_tree's holder launcher sheds its handles),
    /// so the drains would not end while it lives.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_reaped_call_does_not_wait_for_a_write_a_descendant_blocks() {
        use crate::proc_tree::test_support::HostShell;
        let dir = tree_dir("gd-gh-blocked-");
        let holder = Holder::new(dir.path());
        let leave = dir.path().join("leave").display().to_string();
        let reading = dir.path().join("job-holds-stdin");
        let job = reading.display().to_string();
        assert!(!leave.contains('\''), "a quote in the gate's path: {leave}");
        let snippet = holder.launch_snippet(HostShell::Sh, Keeps::Neither);
        // fd 9 carries the leader's stdin past the null stdin a background job defaults to;
        // the job marks itself started once that stdin is its own.
        let script = format!(
            "{snippet}\nexec 9<&0\n{{ : > '{job}'; exec sleep 3600; }} <&9 9<&- >/dev/null 2>&1 &\nexec 9<&-\ni=0; while [ ! -e '{leave}' ] && [ \"$i\" -lt 9000 ]; do sleep 0.1; i=$((i+1)); done\nexit 0\n"
        );
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::proc_tree::TreeGuard::prepare(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn the leader");
        let guard = crate::proc_tree::TreeGuard::arm(&child);
        assert!(guard.is_armed(), "the guard armed");
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder never started"
        );
        assert!(
            wait_until(|| reading.exists(), HANG_GUARD),
            "the stdin-holding job never started"
        );
        std::fs::write(&leave, "").expect("let the leader exit");
        let (text, _) = big_text();
        let exchange = exchange_with_stdin(&mut child, Some(text.as_bytes()));
        let out = tokio::time::timeout(HANG_GUARD, exchange)
            .await
            .expect("the reaped call waited on the write its background job blocks")
            .expect("a reaped call is Ok");
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        assert_eq!(out.status.code(), Some(0), "stderr: {stderr}");
        drop(guard);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the armed guard's drop"
        );
        drop(child);
        remove_when_free(dir);
    }

    /// The stored-login probe's twin of the gh kill test: a dropped probe kills its
    /// wrapper's whole tree. Its stdio is null, so there is no pipe to keep.
    #[tokio::test]
    async fn an_abandoned_login_probe_kills_its_wrappers_whole_tree() {
        let dir = tree_dir("gd-gh-probe-");
        let holder = Holder::new(dir.path());
        let wrapper = Wrapper::new(dir.path(), "gh", &holder, Keeps::Both);
        let mut run = Box::pin(probe_exit(login_probe_command(&wrapper), HANG_GUARD));
        tokio::select! {
            biased;
            r = &mut run => panic!("the probe settled before its gate: {r:?}"),
            () = std::future::ready(()) => {}
        }
        wrapper.mark_armed();
        tokio::select! {
            biased;
            r = &mut run => panic!("the probe settled under its holder: {r:?}"),
            ok = started_within(&holder, HANG_GUARD) => assert!(ok, "the holder never started"),
        }
        drop(run);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the abandoned probe"
        );
        remove_when_free(dir);
    }

    /// A reaped stored-login probe disarms, so what it started keeps running.
    #[tokio::test]
    async fn a_reaped_login_probe_leaves_what_it_started_running() {
        let dir = tree_dir("gd-gh-probed-");
        let holder = Holder::new(dir.path());
        let wrapper = Wrapper::new(dir.path(), "gh", &holder, Keeps::Neither);
        let mut run = Box::pin(probe_exit(login_probe_command(&wrapper), HANG_GUARD));
        tokio::select! {
            biased;
            r = &mut run => panic!("the probe settled before its gate: {r:?}"),
            () = std::future::ready(()) => {}
        }
        wrapper.mark_armed();
        tokio::select! {
            biased;
            r = &mut run => panic!("the probe settled under its holder: {r:?}"),
            ok = started_within(&holder, HANG_GUARD) => assert!(ok, "the holder never started"),
        }
        wrapper.let_finish();
        let status = run
            .await
            .expect("the probe reaps the wrapper once it passes its finish gate");
        assert!(status.success(), "{status:?}");
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with the reaped probe"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }
}

/// The tree-test fixture and source pins over the gh and glab runners, shared with
/// forge/glab.rs's tests.
#[cfg(test)]
pub(crate) mod tree_fixture {
    use crate::proc_tree::test_support::{Holder, HostShell, Keeps};
    use std::path::{Path, PathBuf};

    /// The wrapper's two gates, in the holder's directory beside its reserved names.
    const ARMED: &str = "tree-armed";
    const FINISH: &str = "tree-finish";

    /// A stand-in gh or glab whose spawned program is a shell running a script file that
    /// never `exec`s, so the holder it launches is a descendant of the spawned process.
    pub(crate) struct Wrapper {
        program: PathBuf,
        args: Vec<String>,
        armed: PathBuf,
        finish: PathBuf,
    }

    impl Wrapper {
        /// Writes the wrapper script for `name` under `dir`: Windows `<name>.cmd` (so the
        /// spawned program is cmd.exe), unix `<name>-wrapper.sh` run as `sh <file>`. The
        /// script waits for gate 1, runs `holder`'s launch snippet on a line of its own,
        /// waits for gate 2 and exits 0. It writes nothing to stdout or stderr, and each
        /// gate loop exits non-zero after about 15 minutes (a leak cap, never a wait).
        pub(crate) fn new(dir: &Path, name: &str, holder: &Holder, keeps: Keeps) -> Self {
            #[cfg(windows)]
            let (program, args) =
                cmd_script(dir, name, &holder.launch_snippet(HostShell::Cmd, keeps));
            #[cfg(unix)]
            let (program, args) =
                sh_script(dir, name, &holder.launch_snippet(HostShell::Sh, keeps));
            Self {
                program,
                args,
                armed: dir.join(ARMED),
                finish: dir.join(FINISH),
            }
        }

        pub(crate) fn program(&self) -> &Path {
            &self.program
        }

        pub(crate) fn args(&self) -> Vec<&str> {
            self.args.iter().map(String::as_str).collect()
        }

        /// A Command over program and args with nothing else set.
        pub(crate) fn command(&self) -> tokio::process::Command {
            let mut cmd = tokio::process::Command::new(&self.program);
            cmd.args(&self.args);
            cmd
        }

        /// Opens gate 1. Before it the wrapper has started no child besides its foreground
        /// gate poller. Call it only after the run under test has been polled once, so a
        /// Windows holder is born after the Job Object assignment.
        pub(crate) fn mark_armed(&self) {
            std::fs::write(&self.armed, "").expect("open gate 1");
        }

        /// Opens gate 2: the wrapper exits 0. A test that never calls it has a wrapper that
        /// blocks until it is killed (or until its leak cap).
        pub(crate) fn let_finish(&self) {
            std::fs::write(&self.finish, "").expect("open gate 2");
        }
    }

    /// The batch arm. Gates are named relative to the script and quoted, so the gate
    /// lines splice no absolute path into batch text (the holder's snippet line carries
    /// its own); CRLF line ends, as cmd can miss a label in an LF file. Each loop steps
    /// with a one-second ping and stops after 900 passes.
    #[cfg(windows)]
    fn cmd_script(dir: &Path, name: &str, snippet: &str) -> (PathBuf, Vec<String>) {
        let step = r#""%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul"#;
        let lines = [
            "@echo off".to_string(),
            "set n=0".into(),
            ":armed".into(),
            format!("if exist \"%~dp0{ARMED}\" goto launch"),
            "set /a n+=1".into(),
            "if %n% geq 900 exit /b 1".into(),
            step.into(),
            "goto armed".into(),
            ":launch".into(),
            snippet.into(),
            "set n=0".into(),
            ":finish".into(),
            format!("if exist \"%~dp0{FINISH}\" exit /b 0"),
            "set /a n+=1".into(),
            "if %n% geq 900 exit /b 1".into(),
            step.into(),
            "goto finish".into(),
        ];
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, lines.join("\r\n") + "\r\n").expect("write the wrapper");
        (path, Vec::new())
    }

    /// The sh arm: gates as single-quoted absolute paths, each loop stepping with
    /// `sleep 0.1` and stopping after 9000 passes.
    #[cfg(unix)]
    fn sh_script(dir: &Path, name: &str, snippet: &str) -> (PathBuf, Vec<String>) {
        let shown = dir.display().to_string();
        assert!(
            !shown.contains('\''),
            "a quote in the wrapper's dir: {shown}"
        );
        let wait = |gate: &str| {
            let gate = format!("'{}'", dir.join(gate).display());
            format!(
                "i=0; while [ ! -e {gate} ] && [ \"$i\" -lt 9000 ]; do sleep 0.1; i=$((i+1)); done; [ -e {gate} ] || exit 1"
            )
        };
        let lines = [
            wait(ARMED),
            snippet.to_string(),
            wait(FINISH),
            "exit 0".into(),
        ];
        let path = dir.join(format!("{name}-wrapper.sh"));
        std::fs::write(&path, lines.join("\n") + "\n").expect("write the wrapper");
        (PathBuf::from("sh"), vec![path.display().to_string()])
    }

    /// The armed-spawn property over one source file: (violations, sorted names of the
    /// column-0 fns that spawn). Its reach is github/runner.rs and forge/glab.rs, matched
    /// by literal spelling over whitespace-stripped production text: column-0 test
    /// modules and whole comment lines are dropped, and a fn body runs from its column-0
    /// `fn` line to the next column-0 `}`. A spawning fn spawns and arms once with no
    /// `.await` between them, disarms in one statement right after its reap (see
    /// `ends_with_reap`), and binds `child` once and only borrows it after that. Out of
    /// its sight: the UFCS spelling `Command::spawn(&mut cmd)`, a spawn behind a helper
    /// in another file or a macro, an aliased `TreeGuard`, and a guard bound to `_`.
    /// `.status()` and `.output()` match by name, whatever their receiver.
    pub(crate) fn unarmed_spawns(source: &str) -> (Vec<String>, Vec<String>) {
        let source = source.replace("\r\n", "\n");
        let mut violations = Vec::new();
        let text = production_text(&source, &mut violations);
        let strip = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();

        let mut starts = Vec::new();
        let mut offset = 0;
        for line in text.split('\n') {
            if let Some(name) = fn_name(line) {
                starts.push((offset, name));
            }
            offset += line.len() + 1;
        }
        let mut roster = Vec::new();
        let mut outside = String::new();
        let mut cursor = 0;
        for &(start, name) in &starts {
            let end = text[start..].find("\n}").map_or(text.len(), |n| start + n);
            if let Some((_, inner)) = starts.iter().find(|(s, _)| start < *s && *s < end) {
                violations.push(format!(
                    "fn `{name}` was not read: its body runs into fn `{inner}` (a one-line fn \
                     has no closing line of its own)"
                ));
            }
            if start > cursor {
                outside.push_str(&text[cursor..start]);
            }
            cursor = cursor.max(end);
            let body = strip(&text[start..end]);
            if !body.contains(".spawn()") {
                continue;
            }
            roster.push(name.to_string());
            let at = |token: &str| body.find(token);
            let armed = match (
                at("TreeGuard::prepare("),
                at("kill_on_drop(true)"),
                at(".spawn()"),
                at("TreeGuard::arm("),
                at(".disarm()"),
            ) {
                (Some(p), Some(k), Some(s), Some(a), Some(d)) => p < s && k < s && s < a && a < d,
                _ => false,
            };
            if !armed {
                violations.push(format!(
                    "fn `{name}` spawns without TreeGuard::prepare( and kill_on_drop(true), \
                     then .spawn(), then TreeGuard::arm(, then .disarm()"
                ));
            }
            let (spawns, arms) = (
                body.matches(".spawn()").count(),
                body.matches("TreeGuard::arm(").count(),
            );
            if (spawns, arms) != (1, 1) {
                violations.push(format!(
                    "fn `{name}` spawns {spawns} times and arms {arms} times, not once each"
                ));
            }
            // A future dropped at an await between the two would leave the child unguarded.
            if let (Some(s), Some(a)) = (at(".spawn()"), at("TreeGuard::arm(")) {
                if s < a && body[s..a].contains(".await") {
                    violations.push(format!("fn `{name}` awaits between its spawn and its arm"));
                }
            }
            // Disarm on any exit code: one unconditional statement right after the reap.
            let disarms: Vec<usize> = body
                .match_indices("guard.disarm();")
                .map(|(i, _)| i)
                .collect();
            if !matches!(disarms[..], [d] if ends_with_reap(&body[..d])) {
                violations.push(format!(
                    "fn `{name}`'s disarm is not one `guard.disarm();` right after its reap"
                ));
            }
            // The guard must drop before the Child, so `child` is bound once and only
            // borrowed after that: never rebound, moved into a call or handed on by value.
            let binding = "letmutchild=";
            let moved = body.find(binding).is_some_and(|at| {
                let rest = &body[at + binding.len()..];
                ["(child,", "(child)", ",child)", ",child,", "=child;"]
                    .iter()
                    .any(|m| rest.contains(m))
            });
            if body.matches(binding).count() != 1 || moved {
                violations.push(format!(
                    "fn `{name}` moves or rebinds `child` after its one `let mut child =`"
                ));
            }
        }
        outside.push_str(&text[cursor..]);

        let scanned = strip(&text);
        for token in [".output()", ".status()", "wait_with_output"] {
            if scanned.contains(token) {
                violations.push(format!("`{token}` hides the Child from the tree guard"));
            }
        }
        if strip(&outside).contains(".spawn()") {
            violations.push(
                "a `.spawn()` outside every column-0 fn body (an impl method, a nested module, \
                 an initializer)"
                    .into(),
            );
        }
        roster.sort();
        (violations, roster)
    }

    /// Whether stripped `before` ends with a reap: `child.wait().await?;`, or an
    /// `exchange_with_stdin(` call followed directly by `.await.map_err(AppError::Io)?;`.
    fn ends_with_reap(before: &str) -> bool {
        if before.ends_with("child.wait().await?;") {
            return true;
        }
        let call = "exchange_with_stdin(";
        let Some(open) = before.rfind(call).map(|at| at + call.len()) else {
            return false;
        };
        let mut depth = 1;
        let close = before[open..].char_indices().find_map(|(i, c)| {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            (depth == 0).then_some(open + i)
        });
        close.is_some_and(|c| &before[c + 1..] == ".await.map_err(AppError::Io)?;")
    }

    /// `source` minus each column-0 test module and every whole comment line. A test-gated
    /// item that is not a module stays, and the test modules after it are still removed.
    pub(crate) fn production_text(source: &str, violations: &mut Vec<String>) -> String {
        let lines: Vec<&str> = source.lines().collect();
        let mut kept = Vec::new();
        let mut modules = 0;
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            if line.starts_with("#[cfg(test)]") || line.starts_with("#[cfg(all(test,") {
                let mut j = i + 1;
                while lines.get(j).is_some_and(|l| {
                    let t = l.trim_start();
                    t.is_empty() || t.starts_with("#[") || t.starts_with("//")
                }) {
                    j += 1;
                }
                if let Some(name) = lines.get(j).and_then(|l| module_name(l)) {
                    modules += 1;
                    let Some(close) = lines[j + 1..].iter().position(|l| l.starts_with('}')) else {
                        violations.push(format!("test module `{name}` has no column-0 close"));
                        break;
                    };
                    i = j + 2 + close;
                    continue;
                }
            }
            if !line.trim_start().starts_with("//") {
                kept.push(line);
            }
            i += 1;
        }
        if modules == 0 {
            violations.push("no test module found, so the file was misread".into());
        }
        kept.join("\n")
    }

    /// The name on a column-0 fn line, after optional `pub`, `pub(...)`, `const`,
    /// `unsafe` and `async`.
    pub(crate) fn fn_name(line: &str) -> Option<&str> {
        let mut rest = line;
        loop {
            if let Some(r) = rest.strip_prefix("pub(") {
                rest = r.split_once(") ")?.1;
            } else if let Some(r) = ["pub ", "const ", "unsafe ", "async "]
                .iter()
                .find_map(|p| rest.strip_prefix(p))
            {
                rest = r;
            } else {
                break;
            }
        }
        let rest = rest.strip_prefix("fn ")?;
        let end = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        if end == 0 {
            None
        } else {
            Some(&rest[..end])
        }
    }

    /// The name on a column-0 `mod <name> {` or `pub(...) mod <name> {` line.
    fn module_name(line: &str) -> Option<&str> {
        let rest = match line.strip_prefix("pub(") {
            Some(r) => r.split_once(") ")?.1,
            None => line,
        };
        Some(
            rest.strip_prefix("mod ")?
                .trim_end()
                .strip_suffix('{')?
                .trim_end(),
        )
    }
}
