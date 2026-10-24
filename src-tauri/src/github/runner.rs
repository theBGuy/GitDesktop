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
pub(crate) async fn gh_host_for_repo(repo_path: &str) -> Option<String> {
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
    let mut cmd = Command::new(gh);
    apply_gh_env(&mut cmd, gh_host);
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

    Ok(GhOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
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
    let bypassed = bypasses(args);
    if bypassed {
        debug_assert!(
            !bypassed,
            "conditional GET requires unshaped, single-page argv"
        );
        let gh = gh_bin().await?;
        return run_gh_raw_resolved(&gh, repo_path, host, args, timeout).await;
    }
    let gh = gh_bin().await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ChildEnv;

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
}
