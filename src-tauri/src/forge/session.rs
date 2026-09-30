//! Forge session health — anti-flap classification of each hosted-git session (per
//! repo and per account), plus a cancellable `gh`/`glab` re-auth child driver.
//!
//! Anti-flap is load-bearing: a transiently-failing keyring/API makes `gh auth status`
//! report "token invalid" for a minute and then heal, so a `gh` `timeout` state is
//! NEVER Broken and a `gh` `error` must be confirmed by a second probe (~1.5s later);
//! the GitLab arm mirrors that. A rate-limit error is its own state and never
//! triggers a re-probe: another probe spends quota and can only confirm it. No
//! probe reads a credential value, and the reconnect driver truncates + redacts
//! every line it forwards.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::forge::glab::{run_glab_raw, GLAB_TIMEOUT};
use crate::forge::model::Provider;
use crate::github::runner::{run_gh_raw, GH_TIMEOUT};

/// How long to wait before the confirming re-probe of a transient `error`/failure
/// (anti-flap). A single failing probe never yields Broken without this second look.
const REPROBE_DELAY: Duration = Duration::from_millis(1500);

/// Hard ceiling on a reconnect child — a device-flow login the user never completes
/// must not leave a `gh`/`glab` subprocess running forever.
const RECONNECT_TIMEOUT: Duration = Duration::from_secs(900);

// ── Contract types (pinned — serde camelCase, tag="type") ───────────────────────

/// The classification the frontend renders per session. `Offline` is the "don't
/// alarm" state: the frontend keeps its last known state and shows no error.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Signed in + the credential validates.
    Healthy,
    /// A credential is present but rejected (gh error confirmed twice; glab
    /// auth-failure; bb 401).
    Broken,
    /// No credential for this host at all.
    NotConnected,
    /// The `gh`/`glab` binary isn't installed (never for Bitbucket — it has no CLI).
    CliMissing,
    /// The probe was inconclusive (network/timeout). The frontend never alarms on this.
    Offline,
    /// The forge's API rate limit is in effect. The credential itself is not in
    /// question, so reconnecting cannot help; access resumes at `reset_at` when known.
    RateLimited,
}

/// One session's health. Provider-neutral; the frontend keys labels on `provider`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealth {
    /// `"github"` | `"gitlab"` | `"bitbucket"`.
    pub provider: String,
    pub host: String,
    pub state: SessionState,
    pub login: Option<String>,
    /// `gh` accounts only; `None` elsewhere.
    pub active: Option<bool>,
    /// A short human reason for a broken, rate-limited, or offline session, minted in
    /// `sanitize_detail`'s register: one line, the forge's own words without CLI
    /// framing, NEVER token material.
    pub detail: Option<String>,
    /// `"oauth"` | `"pat"` | `"token"` | `None`.
    pub method: Option<String>,
    pub expires_at: Option<String>,
    pub days_left: Option<i64>,
    /// RateLimited only: when the limit resets, in epoch seconds (GitHub's
    /// `x-ratelimit-reset` header); `None` when unknown.
    pub reset_at: Option<i64>,
}

impl SessionHealth {
    /// A bare session with only provider/host/state set — the common starting point.
    fn new(provider: &str, host: impl Into<String>, state: SessionState) -> Self {
        SessionHealth {
            provider: provider.to_string(),
            host: host.into(),
            state,
            login: None,
            active: None,
            detail: None,
            method: None,
            expires_at: None,
            days_left: None,
            reset_at: None,
        }
    }
}

/// A streamed event from a reconnect child. `Code` carries the device-flow
/// verification URL and, once parsed, the one-time code. Emitted as soon as the URL is
/// known and re-emitted at most once more if the code is parsed afterwards, so a CLI
/// whose code wording we don't recognise still yields a usable URL. `Line` is any other
/// sanitized output line; `Finished` is terminal.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReconnectEvent {
    Code {
        code: Option<String>,
        url: String,
    },
    /// A sanitized output line, ≤300 chars, token material redacted.
    Line {
        text: String,
    },
    Finished {
        ok: bool,
        login: Option<String>,
        message: Option<String>,
    },
}

// ── forge_session_health (per-repo) ─────────────────────────────────────────────

/// Resolve a repo's forge session health: which provider/host, whether we're signed
/// in, and whether the credential validates — with the anti-flap rules applied.
#[tauri::command]
pub async fn forge_session_health(repo_path: String) -> AppResult<SessionHealth> {
    // Provider + host. detect_non_github covers GitLab (canonical + self-managed)
    // and Bitbucket; everything else takes the GitHub arm.
    match crate::forge::detect_non_github(&repo_path).await {
        Some((Provider::GitLab, host)) => Ok(gitlab_health(&host).await),
        Some((Provider::Bitbucket, host)) => Ok(bitbucket_health(&host).await),
        // Provider::GitHub never comes back from detect_non_github (it returns None
        // for github.com / GHE / unknown), but route it to the GitHub arm anyway.
        Some((Provider::GitHub, host)) => Ok(github_health(&host).await),
        None => {
            let host = github_host_for_repo(&repo_path).await;
            Ok(github_health(&host).await)
        }
    }
}

/// The GitHub host for a repo, from its `origin` URL when parseable, else
/// `github.com` — as gh spells it, so a ported remote resolves to the `host:port`
/// authority gh registered it under. Deliberately no `gh repo view` — that's a network
/// round-trip this cheap health check must avoid; the extra probe on a ported remote is
/// gh's local-only, memoized `auth token`.
pub(crate) async fn github_host_for_repo(repo_path: &str) -> String {
    let Ok(url) =
        crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await
    else {
        return "github.com".to_string();
    };
    let host = crate::forge::remote_host(&url).unwrap_or_else(|| "github.com".to_string());
    let authority = crate::forge::remote_authority(&url).unwrap_or_else(|| "github.com".to_string());
    // Only the ported spelling is gated — it is the one this function SYNTHESIZES, and a
    // rejected one must fall back rather than be probed. The parsed host passes through as
    // read: substituting a default would report a different host's session as this repo's.
    if authority != host
        && crate::forge::is_safe_authority(&authority)
        && crate::forge::github::gh_authenticated(&authority).await
    {
        // gh registers a ported host under its full authority, so `--hostname <bare>`
        // would report a signed-in ported GHES as signed-out. The same string then keys
        // the `auth status --json hosts` map.
        return authority;
    }
    host
}

// ── forge_accounts_health (account-scoped) ──────────────────────────────────────

/// Account-scoped health: every signed-in `gh` account, every `glab` host, and the
/// Bitbucket account — each as its own `SessionHealth`. Output order is github,
/// gitlab, bitbucket.
#[tauri::command]
pub async fn forge_accounts_health() -> AppResult<Vec<SessionHealth>> {
    let mut out = Vec::new();
    out.extend(github_accounts_health().await);
    out.extend(gitlab_accounts_health().await);
    out.push(bitbucket_health(crate::forge::http::BB_HOST).await);
    Ok(out)
}

// ── GitHub ──────────────────────────────────────────────────────────────────────

/// One host's `hosts` entry from `gh auth status --json hosts`.
#[derive(serde::Deserialize)]
struct GhJsonAccount {
    #[serde(default)]
    state: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    login: Option<String>,
    /// Present when `state` is error/timeout — detail on why. Never token material.
    #[serde(default)]
    error: Option<String>,
}

/// The outcome of a `gh auth status --json hosts` probe. `gh auth status --json` exits
/// 0 even on auth issues (per gh's own help), so a non-zero exit is NOT an auth signal:
/// it's either an old gh that doesn't know `--json` (→ text fallback) or a fatal/
/// environmental gh error (→ inconclusive, don't misclassify as an auth state).
enum GhJsonProbe {
    /// Exit 0: the parsed hosts map (`{"hosts":{}}` = logged out everywhere).
    Parsed(HashMap<String, Vec<GhJsonAccount>>),
    /// Non-zero because `--json` is an unknown flag (old gh) → use the text fallback.
    UnknownFlag,
    /// Any other non-zero exit (fatal/environmental) → Offline, with its stderr as a
    /// `sanitize_detail` detail.
    Inconclusive(Option<String>),
}

/// Classify a non-zero `gh auth status --json` result from stderr alone: an old-gh
/// unknown-flag signature vs any other failure. `code` is unused — the discriminator
/// is the stderr text.
fn classify_gh_json_nonzero(_code: i32, stderr: &str) -> GhJsonProbe {
    if stderr.to_lowercase().contains("unknown flag") {
        GhJsonProbe::UnknownFlag
    } else {
        // A fatal/environmental gh error — surface it as Offline, not a fake auth state.
        let detail = sanitize_detail(stderr.trim());
        GhJsonProbe::Inconclusive((!detail.is_empty()).then_some(detail))
    }
}

/// Run `gh auth status --json hosts [--hostname <host>]` and classify the outcome into a
/// `GhJsonProbe`. `Err(GhNotFound)` when gh isn't installed (caller → CliMissing).
async fn gh_status_json(hostname: Option<&str>) -> AppResult<GhJsonProbe> {
    let mut args: Vec<&str> = vec!["auth", "status", "--json", "hosts"];
    if let Some(h) = hostname {
        args.push("--hostname");
        args.push(h);
    }
    let out = run_gh_raw(None, &args, GH_TIMEOUT).await?;
    if out.code != 0 {
        return Ok(classify_gh_json_nonzero(out.code, &out.stderr));
    }
    #[derive(serde::Deserialize)]
    struct HostsWrapper {
        #[serde(default)]
        hosts: HashMap<String, Vec<GhJsonAccount>>,
    }
    // `{"hosts":{}}` = logged out everywhere; a parse failure degrades to the same
    // empty map rather than erroring (tolerant of untrusted JSON).
    let parsed: HostsWrapper = serde_json::from_str(&out.stdout_lossy()).unwrap_or(HostsWrapper {
        hosts: HashMap::new(),
    });
    Ok(GhJsonProbe::Parsed(parsed.hosts))
}

/// Whether gh error text (an account's `error`, or a failed command's stderr)
/// names a rate limit (primary or secondary, or older GHES's "abuse detection"
/// wording for the latter), or is a 429. Substring matches, not exact ones:
/// go-gh wraps the API message as `HTTP <code>: <message> (<url>)`, and the
/// message wording varies by limit kind.
pub(crate) fn gh_error_is_rate_limit(error: Option<&str>) -> bool {
    error.is_some_and(|e| {
        let e = e.to_lowercase();
        e.contains("rate limit") || e.contains("abuse detection") || e.contains("http 429:")
    })
}

/// Transport-failure vocabulary shared by the gh and glab classifiers. "deadline
/// exceeded" is an exhausted context budget, never a credential verdict.
const NETWORKISH: [&str; 7] = [
    "timeout",
    "connection",
    "dial",
    "lookup",
    "network",
    "tls",
    "deadline exceeded",
];

/// gh-only additions, measured from `gh auth status --json` (gh 2.94.0) behind a
/// failing proxy, whose CONNECT refusals carry only the status TEXT: a dropped stream
/// reads `unexpected EOF`, and a refusing proxy `Bad Gateway`, `Service Unavailable`,
/// or `Proxy Authentication Required` (reconnecting to GitHub can't clear any of them);
/// Go prefixes a failed proxy dial with `proxyconnect`. The 5xx codes cover the
/// server's own outage answers, `HTTP 503: … (<url>)`.
const GH_NETWORKISH_EXTRA: [&str; 9] = [
    "eof",
    "bad gateway",
    "service unavailable",
    "proxy",
    "proxyconnect",
    "500",
    "502",
    "503",
    "504",
];

/// Whether gh error text (an account's `error`, or an old gh's text report) names a
/// transport or server failure: the request never reached a verdict on the
/// credential, so the session is Offline, not Broken. Deliberately narrow, in the
/// spirit of `git::remote::is_auth_class_failure`: whole words only, and any text
/// naming a 401/403 answer is the server's credential verdict whatever its body says.
/// Callers check the rate limit first.
pub(crate) fn gh_error_is_network(error: Option<&str>) -> bool {
    error.is_some_and(|e| {
        let e = e.to_lowercase();
        if has_standalone_word(&e, "401") || has_standalone_word(&e, "403") {
            return false;
        }
        NETWORKISH
            .iter()
            .chain(GH_NETWORKISH_EXTRA.iter())
            .any(|w| has_standalone_word(&e, w))
    })
}

/// Whether a reading, on its own, earns the anti-flap re-probe: only Broken does. A
/// RateLimited reading never triggers one (it would spend another call against the
/// exhausted quota), though the accounts path's SHARED re-probe, fired by another
/// account's Broken, still re-reads every account on it.
fn needs_reprobe(state: SessionState) -> bool {
    state == SessionState::Broken
}

/// Classify the account list for one host into a state (no re-probe here — whether
/// to re-probe is the caller's policy). Picks the active account, else the first.
fn classify_gh_host(accounts: &[GhJsonAccount]) -> SessionHealth {
    // The `host` field is filled by the caller; this pure classifier leaves it "".
    let chosen = accounts
        .iter()
        .find(|a| a.active)
        .or_else(|| accounts.first());
    match chosen {
        Some(acct) => gh_account_health("", acct),
        // No entries for this host → not connected.
        None => SessionHealth::new("github", "", SessionState::NotConnected),
    }
}

/// Per-repo GitHub health for `host`, with the anti-flap re-probe on `error`, plus the
/// token expiry (Healthy) or rate-limit reset time (RateLimited).
async fn github_health(host: &str) -> SessionHealth {
    let json = match gh_status_json(Some(host)).await {
        Ok(GhJsonProbe::Parsed(map)) => map,
        Ok(GhJsonProbe::UnknownFlag) => return github_health_text_fallback(Some(host)).await,
        Ok(GhJsonProbe::Inconclusive(detail)) => {
            let mut h = SessionHealth::new("github", host, SessionState::Offline);
            h.detail = detail;
            return h;
        }
        Err(AppError::GhNotFound) => {
            return SessionHealth::new("github", host, SessionState::CliMissing)
        }
        Err(_) => return SessionHealth::new("github", host, SessionState::Offline),
    };
    let accounts = json.get(host).map(Vec::as_slice).unwrap_or(&[]);
    let mut health = classify_gh_host(accounts);
    health.host = host.to_string();

    // ANTI-FLAP: a single `error` never yields Broken. Re-probe once ~1.5s later; the
    // re-probe's state wins (so a healed session reads Healthy). Only a confirmed
    // second error stays Broken.
    let mut disproved = false;
    if needs_reprobe(health.state) {
        tokio::time::sleep(REPROBE_DELAY).await;
        if let Ok(GhJsonProbe::Parsed(map2)) = gh_status_json(Some(host)).await {
            let accounts2 = map2.get(host).map(Vec::as_slice).unwrap_or(&[]);
            let mut health2 = classify_gh_host(accounts2);
            health2.host = host.to_string();
            health = health2;
        }
        // A failed re-probe (Err/None) leaves the first Broken standing — the
        // credential really was rejected and we couldn't disprove it.
        if health.state == SessionState::Broken {
            health = disprove_broken_via_probe(health, host).await;
            disproved = health.state == SessionState::RateLimited;
        }
    }

    if health.state == SessionState::Healthy {
        apply_gh_expiry(&mut health, host).await;
    }
    // A disproved Broken already read its reset from the same response.
    if health.state == SessionState::RateLimited && !disproved {
        health.reset_at = gh_rate_limit_reset(host).await;
    }
    health
}

/// The confirmed-Broken disproof: gh words a REST secondary 403 as token-invalid.
/// `rate_limit` is exempt from the primary quota and rejects an invalid token, but it
/// also answers anonymous requests, so its success proves the credential only when gh
/// had a token to send. Anything else leaves Broken standing, the safe side.
fn disprove_broken(
    mut health: SessionHealth,
    token_present: bool,
    rate_limit: AppResult<crate::github::runner::GhOutput>,
) -> SessionHealth {
    if !token_present {
        return health;
    }
    let Ok(out) = rate_limit else {
        return health;
    };
    if out.code != 0 {
        return health;
    }
    health.state = SessionState::RateLimited;
    // gh's token-invalid wording is exactly the misdirect this reclassifies.
    health.detail = None;
    health.reset_at = rate_limit_reset_header(&out.stdout_lossy());
    health
}

/// The [`disprove_broken`] probes for `host`. The rate_limit read spawns only when gh
/// has a token to send: without one its answer proves nothing, so the verdict stays
/// Broken either way and the spawn would only delay it.
async fn disprove_broken_via_probe(health: SessionHealth, host: &str) -> SessionHealth {
    if !gh_token_present(host).await {
        return health;
    }
    disprove_broken(health, true, gh_rate_limit_probe(host).await)
}

/// Every known gh host's health from ONE `gh auth status --json hosts` spawn, keyed
/// by host as gh spells it (the active account per host, else the first). For the
/// background-sync poller, which gates each tick on it: one spawn per tick covers
/// every host gh has registered, instead of one probe per remote host. Poller-lite:
/// no expiry read, no reset fetch, no anti-flap re-probe — a transient misread costs
/// one skipped tick and heals on the next. An empty map means unknown (old gh
/// without `--json`, gh missing, an inconclusive probe, or no host signed in);
/// callers fall back rather than read it as a verdict.
pub(crate) async fn github_hosts_health_for_poller() -> HashMap<String, SessionHealth> {
    match gh_status_json(None).await {
        Ok(GhJsonProbe::Parsed(map)) => gh_hosts_health(&map),
        _ => HashMap::new(),
    }
}

/// One entry per host in a `gh auth status --json hosts` reading, classified like the
/// per-repo path (active account, else the first) but without any follow-up probe.
fn gh_hosts_health(map: &HashMap<String, Vec<GhJsonAccount>>) -> HashMap<String, SessionHealth> {
    map.iter()
        .map(|(host, accounts)| {
            let mut health = classify_gh_host(accounts);
            health.host = host.clone();
            (host.clone(), health)
        })
        .collect()
}

/// One gh host's sign-in verdict for `gh_status`: whether the host's session reads
/// Healthy, and its active login.
pub(crate) struct GhHostAuth {
    pub authenticated: bool,
    pub login: Option<String>,
}

/// Per-host gh auth verdict for `host`, or `Ok(None)` when per-host truth is unavailable
/// (old gh without `--json`, an inconclusive probe, or `host` absent from the map) —
/// the caller then falls back to the host-less exit-code probe. No anti-flap re-probe:
/// this backs a hot UI probe, and a transient Broken heals on its next refetch.
pub(crate) async fn github_auth_on_host(host: &str) -> AppResult<Option<GhHostAuth>> {
    gh_host_auth_from_result(gh_status_json(Some(host)).await, host)
}

/// A probe that failed to run at all (timeout, spawn error) is an error, never a
/// signed-out verdict or `None`: the caller's react-query observers keep their last
/// good status on a rejection, and the fallback probe is network-bound too, so a hung
/// network would pay the gh timeout twice on this hot path.
fn gh_host_auth_from_result(
    probe: AppResult<GhJsonProbe>,
    host: &str,
) -> AppResult<Option<GhHostAuth>> {
    match probe {
        Ok(probe) => gh_host_auth(&probe, host),
        Err(AppError::Timeout(_)) => Err(unreachable_forge_error(host, None)),
        Err(e) => Err(e),
    }
}

/// The pure step behind [`github_auth_on_host`]. Only `host`'s own entry answers —
/// never another host's, as in background.rs `github_verdict` — because in `--json`
/// mode an absent key is the only "unknown host" signal (gh still exits 0). Only
/// Healthy authenticates: a RateLimited host reads false so the UI's rate-limit arm,
/// not every panel's 403s, owns that state. An Offline host is an error: its sign-in
/// is unknown, and reading it false would unmount every hosted panel for an outage.
fn gh_host_auth(probe: &GhJsonProbe, host: &str) -> AppResult<Option<GhHostAuth>> {
    let GhJsonProbe::Parsed(map) = probe else {
        return Ok(None);
    };
    let Some(accounts) = map.get(host) else {
        return Ok(None);
    };
    // A present key with no accounts classifies NotConnected, so it reads false.
    let health = classify_gh_host(accounts);
    if health.state == SessionState::Offline {
        return Err(unreachable_forge_error(host, health.detail));
    }
    Ok(Some(GhHostAuth {
        authenticated: health.state == SessionState::Healthy,
        login: health.login,
    }))
}

/// The error a sign-in probe that couldn't reach `host` rejects with.
fn unreachable_forge_error(host: &str, detail: Option<String>) -> AppError {
    AppError::Gh(match detail {
        Some(d) => format!("Couldn't reach {host} to check the GitHub sign-in: {d}"),
        None => format!("Couldn't reach {host} to check the GitHub sign-in."),
    })
}

/// When the rate limit on `host` resets (epoch seconds), from the headers of
/// `gh api -i rate_limit`. That endpoint doesn't count against the primary limit,
/// and the headers are authoritative over the body, whose reset can disagree.
/// Headers are read even on a non-zero exit (gh prints them before erroring); any
/// failure yields `None`, never an error.
async fn gh_rate_limit_reset(host: &str) -> Option<i64> {
    let out = gh_rate_limit_probe(host).await.ok()?;
    rate_limit_reset_header(&out.stdout_lossy())
}

/// Whether gh resolves a token for `host`, from `gh auth token`'s exit code alone. A
/// probe that fails to run reads absent, so the disproof fails closed.
///
/// SECURITY: `gh auth token`'s stdout IS the user's token — only the exit code is
/// read; the output is dropped and never logged or formatted anywhere.
async fn gh_token_present(host: &str) -> bool {
    run_gh_raw(None, &["auth", "token", "--hostname", host], GH_TIMEOUT)
        .await
        .is_ok_and(|out| out.code == 0)
}

/// One `gh api -i rate_limit` call against `host`, raw.
async fn gh_rate_limit_probe(host: &str) -> AppResult<crate::github::runner::GhOutput> {
    run_gh_raw(None, &gh_api_host_args("rate_limit", host), GH_TIMEOUT).await
}

/// The argv for a host-scoped `gh api -i <endpoint>` read. `--hostname` is explicit
/// even for github.com: gh otherwise resolves its host from an ambient `GH_HOST`, and
/// the reading must describe the host it was asked about. Callers always pass a
/// resolved host; an empty one would fall back to gh's default.
fn gh_api_host_args<'a>(endpoint: &'a str, host: &'a str) -> Vec<&'a str> {
    let mut args: Vec<&str> = vec!["api", "-i", endpoint];
    if !host.is_empty() {
        args.push("--hostname");
        args.push(host);
    }
    args
}

/// The `x-ratelimit-reset` header as positive epoch seconds, kept ONLY when
/// `x-ratelimit-remaining` is exactly `0`: the headers describe the core window, and
/// a secondary limit or 429 with core quota left isn't tied to that reset. `None`
/// when either header is absent or unparseable.
fn rate_limit_reset_header(body: &str) -> Option<i64> {
    if response_header_value(body, "x-ratelimit-remaining").as_deref() != Some("0") {
        return None;
    }
    response_header_value(body, "x-ratelimit-reset")?
        .parse::<i64>()
        .ok()
        .filter(|t| *t > 0)
}

/// Degraded GitHub health via plain `gh auth status` (old gh without `--json`). Exit
/// 0 → Healthy (login via `parse_auth_accounts`); non-zero → Offline when the report
/// carries transport-failure words (a timeout line, say), else NotConnected with no
/// parsed accounts and Broken with some. No RateLimited: gh's text renderer prints the
/// same token-invalid line for every error, so no rate-limit signal exists.
async fn github_health_text_fallback(host: Option<&str>) -> SessionHealth {
    let host_str = host.unwrap_or("github.com");
    let mut args: Vec<&str> = vec!["auth", "status"];
    if let Some(h) = host {
        args.push("--hostname");
        args.push(h);
    }
    let out = match run_gh_raw(None, &args, GH_TIMEOUT).await {
        Ok(o) => o,
        Err(AppError::GhNotFound) => {
            return SessionHealth::new("github", host_str, SessionState::CliMissing)
        }
        Err(_) => return SessionHealth::new("github", host_str, SessionState::Offline),
    };
    let report = format!("{}\n{}", out.stdout_lossy(), out.stderr);
    classify_gh_text_report(out.code, &report, host_str)
}

/// The pure step behind [`github_health_text_fallback`]: one plain `gh auth status`
/// result (exit code + combined report) classified for `host_str`.
fn classify_gh_text_report(code: i32, report: &str, host_str: &str) -> SessionHealth {
    let accounts = crate::github::pr::parse_auth_accounts(report);
    // Prefer the account matching this host, else any.
    let acct = accounts
        .iter()
        .find(|a| a.host == host_str)
        .or_else(|| accounts.first());
    // Transport words outrank the account count: a failed report can carry no
    // "Logged in" line at all, and reading that as NotConnected would sign the user
    // out for an outage.
    let state = if code == 0 {
        SessionState::Healthy
    } else if gh_error_is_network(Some(report)) {
        SessionState::Offline
    } else if accounts.is_empty() {
        SessionState::NotConnected
    } else {
        SessionState::Broken
    };
    // With no parsed account (NotConnected, or an Offline report carrying none) there
    // is no login to report.
    let mut h = SessionHealth::new("github", host_str, state);
    h.login = acct.map(|a| a.login.clone());
    h.active = acct.map(|a| a.active);
    h
}

/// Account-scoped GitHub health — one entry PER account across all hosts. Uses ONE
/// shared re-probe (not per account) when any account reads Broken.
async fn github_accounts_health() -> Vec<SessionHealth> {
    let map = match gh_status_json(None).await {
        Ok(GhJsonProbe::Parsed(m)) => m,
        Ok(GhJsonProbe::UnknownFlag) => {
            // Old gh: a single degraded entry (text fallback can't enumerate per-host
            // states with anti-flap; the default-host reading is the useful signal).
            return vec![github_health_text_fallback(None).await];
        }
        // A fatal/environmental gh error → one Offline entry with the sanitized detail.
        Ok(GhJsonProbe::Inconclusive(detail)) => {
            let mut h = SessionHealth::new("github", "github.com", SessionState::Offline);
            h.detail = detail;
            return vec![h];
        }
        Err(AppError::GhNotFound) => {
            return vec![SessionHealth::new(
                "github",
                "github.com",
                SessionState::CliMissing,
            )]
        }
        Err(_) => {
            return vec![SessionHealth::new(
                "github",
                "github.com",
                SessionState::Offline,
            )]
        }
    };

    // ONE shared re-probe when anything looked transiently broken.
    let map = if gh_accounts_need_reprobe(&map) {
        tokio::time::sleep(REPROBE_DELAY).await;
        match gh_status_json(None).await {
            Ok(GhJsonProbe::Parsed(m2)) => m2,
            // A failed re-probe leaves the original reading (the error stands).
            _ => map,
        }
    } else {
        map
    };

    let mut out = Vec::new();
    // Deterministic order across hosts (HashMap iteration order is unspecified).
    let mut hosts: Vec<&String> = map.keys().collect();
    hosts.sort();
    for host in hosts {
        let accounts = &map[host];
        for acct in accounts {
            let mut h = gh_account_health(host, acct);
            match account_follow_up(h.state, acct.active) {
                AccountFollowUp::Expiry => apply_gh_expiry(&mut h, host).await,
                AccountFollowUp::ResetTime => h.reset_at = gh_rate_limit_reset(host).await,
                AccountFollowUp::Disprove => h = disprove_broken_via_probe(h, host).await,
                AccountFollowUp::None => {}
            }
            out.push(h);
        }
    }
    out
}

/// The follow-up probe one account's reading earns in the accounts list.
#[derive(Debug, PartialEq, Eq)]
enum AccountFollowUp {
    None,
    /// Healthy: read the token expiry.
    Expiry,
    /// RateLimited on its own reading: fetch the reset time.
    ResetTime,
    /// Broken after the shared re-probe: the rate_limit disproof, which reads its
    /// reset from the same response, so no separate reset fetch follows.
    Disprove,
}

/// Only the active account earns a follow-up: every probe spends the host's ACTIVE
/// token (`gh auth token` / `gh api --hostname`), so another account's result would
/// describe the wrong credential or quota.
fn account_follow_up(state: SessionState, active: bool) -> AccountFollowUp {
    if !active {
        return AccountFollowUp::None;
    }
    match state {
        SessionState::Healthy => AccountFollowUp::Expiry,
        SessionState::RateLimited => AccountFollowUp::ResetTime,
        SessionState::Broken => AccountFollowUp::Disprove,
        _ => AccountFollowUp::None,
    }
}

/// One gh account's health — the single classifier behind the per-repo path and the
/// poller's hosts map (both via `classify_gh_host`) and the accounts-scoped list. No
/// re-probe, no expiry: those are each caller's own policy.
fn gh_account_health(host: &str, acct: &GhJsonAccount) -> SessionHealth {
    let state = match acct.state.as_str() {
        "success" => SessionState::Healthy,
        "error" if gh_error_is_rate_limit(acct.error.as_deref()) => SessionState::RateLimited,
        // A request that never reached GitHub says nothing about the credential, and an
        // outage fails the anti-flap re-probe identically.
        "error" if gh_error_is_network(acct.error.as_deref()) => SessionState::Offline,
        // Possibly transient: the per-repo and accounts paths confirm it with a
        // re-probe; the poller takes it as-is and re-reads next tick.
        "error" => SessionState::Broken,
        // Never Broken: an inconclusive probe.
        "timeout" => SessionState::Offline,
        // Unknown/empty state → treat as inconclusive, never a false alarm.
        _ => SessionState::Offline,
    };
    let mut h = SessionHealth::new("github", host, state);
    h.login = acct.login.clone().filter(|s| !s.is_empty());
    h.active = Some(acct.active);
    if matches!(
        state,
        SessionState::Broken | SessionState::RateLimited | SessionState::Offline
    ) {
        h.detail = acct
            .error
            .as_ref()
            .map(|e| sanitize_detail(e))
            .filter(|s| !s.is_empty());
    }
    h
}

/// Whether any account in an accounts-scoped reading earns the shared re-probe.
fn gh_accounts_need_reprobe(map: &HashMap<String, Vec<GhJsonAccount>>) -> bool {
    map.iter().any(|(host, accounts)| {
        accounts
            .iter()
            .any(|a| needs_reprobe(gh_account_health(host, a).state))
    })
}

/// Fill `method`/`expires_at`/`days_left` for a Healthy gh session by scanning the
/// `GitHub-Authentication-Token-Expiration` response header of `gh api -i user`. The
/// header appears only for PAT-backed sessions (absent for OAuth — the common case),
/// and is known-buggy for fine-grained PATs, so absence/garbage is tolerated and
/// never flips the already-decided Healthy state.
async fn apply_gh_expiry(health: &mut SessionHealth, host: &str) {
    let Ok(out) = run_gh_raw(None, &gh_api_host_args("user", host), GH_TIMEOUT).await else {
        return; // network/timeout: don't touch the decided health.
    };
    if out.code != 0 {
        return; // don't flip state on a failed expiry probe.
    }
    let body = out.stdout_lossy();
    if let Some(raw) = expiration_header_value(&body) {
        health.expires_at = Some(raw.clone());
        health.method = Some("pat".to_string());
        health.days_left = days_left_from_date_prefix(&raw, today_civil_days());
    } else {
        // No expiration header → an OAuth token (gh's OAuth tokens never expire).
        health.method = Some("oauth".to_string());
    }
}

/// The value of the `GitHub-Authentication-Token-Expiration` header from an
/// `gh api -i` response.
fn expiration_header_value(body: &str) -> Option<String> {
    response_header_value(body, "github-authentication-token-expiration")
}

/// A response header's value from `gh api -i` output (headers precede the JSON body,
/// ending at the first blank line — same idiom as `github::auth::gh_token_scopes`).
/// The name compare is case-insensitive.
fn response_header_value(body: &str, header: &str) -> Option<String> {
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

// ── GitLab ──────────────────────────────────────────────────────────────────────

/// Which failure bucket a `glab auth status` non-zero result falls into.
#[derive(PartialEq, Eq, Debug)]
pub(crate) enum GlabFailure {
    NotConnected,
    Offline,
    /// Never re-probed: another probe spends quota and can only confirm it.
    RateLimited,
    /// Neither clearly not-connected nor network-ish → needs the confirming re-probe;
    /// still failing → Broken with the carried detail.
    Broken,
}

/// Classify combined lowercased stdout+stderr from a failed `glab auth status`.
/// Unknown text degrades to `Broken` (never a panic) so an unrecognized glab message
/// still surfaces as an actionable "reconnect" rather than being swallowed.
pub(crate) fn classify_glab_failure(combined_lower: &str) -> GlabFailure {
    const NOT_CONNECTED: [&str; 4] = ["not logged in", "no token", "no accounts", "no hosts"];
    // Proxy/server outage status text (measured via a 502 proxy: `Post "…/oauth/token":
    // Bad Gateway`) is Offline as for gh, in session health and the sign-in probe, never
    // Broken. Multi-word only: this is a bare-substring match, and hostnames carry digits.
    const OFFLINE_STATUS: [&str; 4] = [
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "proxy authentication required",
    ];
    // NETWORKISH matches as bare substrings here. Source-derived, not live-reproduced:
    // glab 1.105.0's client-go (v2.40.1) retries a 429 until its Ratelimit-Reset inside
    // the context budget, so a long throttle can surface as Go's bare "context deadline
    // exceeded" with no rate-limit wording or status digits. Offline rather than
    // RateLimited: a genuine network hang surfaces the same words.
    // Checked first as the most specific signal. glab's exact wording is unmeasured, so
    // it matches the phrases a GitLab throttle can carry (a 429 answers "Too Many
    // Requests" / "Retry later", with no "rate limit" in it).
    if combined_lower.contains("rate limit")
        || combined_lower.contains("too many requests")
        || has_standalone_429(combined_lower)
    {
        GlabFailure::RateLimited
    } else if NOT_CONNECTED.iter().any(|n| combined_lower.contains(n)) {
        GlabFailure::NotConnected
    } else if NETWORKISH
        .iter()
        .chain(OFFLINE_STATUS.iter())
        .any(|n| combined_lower.contains(n))
    {
        GlabFailure::Offline
    } else {
        GlabFailure::Broken
    }
}

/// Whether `429` appears as a standalone token, so a hash, id, or port that merely
/// contains the digits doesn't match.
fn has_standalone_429(text: &str) -> bool {
    has_standalone_word(text, "429")
}

/// Whether `word` appears with no ASCII letter or digit on either side.
fn has_standalone_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + word.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric())
            && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

/// Parse a `Logged in to <host> as <login>` line from `glab auth status` output,
/// tolerating a leading marker (`✓`, `-`, whitespace). `None` when unparseable.
fn parse_glab_login(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some((_, after)) = line.split_once("Logged in to ") {
            // after = "<host> as <login> (...)"
            if let Some((_, rest)) = after.split_once(" as ") {
                let login = rest
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                    .to_string();
                if !login.is_empty() {
                    return Some(login);
                }
            }
        }
    }
    None
}

/// Per-host GitLab health, with the anti-flap re-probe on an ambiguous failure.
async fn gitlab_health(host: &str) -> SessionHealth {
    let out = match run_glab_raw(None, &["auth", "status", "--hostname", host], GLAB_TIMEOUT).await
    {
        Ok(o) => o,
        Err(AppError::GlabNotFound) => {
            return SessionHealth::new("gitlab", host, SessionState::CliMissing)
        }
        Err(_) => return SessionHealth::new("gitlab", host, SessionState::Offline),
    };
    if out.code == 0 {
        let combined = format!("{}\n{}", out.stdout_lossy(), out.stderr);
        let mut h = SessionHealth::new("gitlab", host, SessionState::Healthy);
        h.login = parse_glab_login(&combined);
        apply_glab_expiry(&mut h, host).await;
        return h;
    }
    let raw = format!("{}\n{}", out.stdout_lossy(), out.stderr);
    match classify_glab_failure(&raw.to_lowercase()) {
        GlabFailure::NotConnected => SessionHealth::new("gitlab", host, SessionState::NotConnected),
        GlabFailure::Offline => SessionHealth::new("gitlab", host, SessionState::Offline),
        GlabFailure::RateLimited => glab_rate_limited(host, &raw),
        GlabFailure::Broken => {
            // ANTI-FLAP: confirm an ambiguous failure with a second probe before Broken.
            tokio::time::sleep(REPROBE_DELAY).await;
            match run_glab_raw(None, &["auth", "status", "--hostname", host], GLAB_TIMEOUT).await {
                Ok(o2) if o2.code == 0 => {
                    let combined2 = format!("{}\n{}", o2.stdout_lossy(), o2.stderr);
                    let mut h = SessionHealth::new("gitlab", host, SessionState::Healthy);
                    h.login = parse_glab_login(&combined2);
                    apply_glab_expiry(&mut h, host).await;
                    h
                }
                Ok(o2) => {
                    let raw2 = format!("{}\n{}", o2.stdout_lossy(), o2.stderr);
                    match classify_glab_failure(&raw2.to_lowercase()) {
                        GlabFailure::NotConnected => {
                            SessionHealth::new("gitlab", host, SessionState::NotConnected)
                        }
                        GlabFailure::Offline => {
                            SessionHealth::new("gitlab", host, SessionState::Offline)
                        }
                        GlabFailure::RateLimited => glab_rate_limited(host, &raw2),
                        GlabFailure::Broken => {
                            let mut h = SessionHealth::new("gitlab", host, SessionState::Broken);
                            h.detail = glab_broken_detail(&o2.stderr);
                            h
                        }
                    }
                }
                // A re-probe that couldn't even run (CLI vanished / timeout) → Offline.
                Err(_) => SessionHealth::new("gitlab", host, SessionState::Offline),
            }
        }
    }
}

/// A RateLimited GitLab session. The detail comes from `combined` (stdout + stderr),
/// the same text the classifier matched, so the reason shown is the one that fired.
/// `reset_at` stays `None`: GitLab's reset time is not probed.
fn glab_rate_limited(host: &str, combined: &str) -> SessionHealth {
    let mut h = SessionHealth::new("gitlab", host, SessionState::RateLimited);
    h.detail = glab_broken_detail(combined);
    h
}

/// A ≤200-char detail in `sanitize_detail`'s register from glab `output`: stderr for a
/// Broken session, the combined stdout + stderr the classifier matched for a
/// RateLimited one.
fn glab_broken_detail(output: &str) -> Option<String> {
    let detail = normalize_detail(output, 200);
    (!detail.is_empty()).then_some(detail)
}

/// GitLab token expiry for a Healthy session: `glab api personal_access_tokens/self`.
/// A 404 under an OAuth token is EXPECTED (that endpoint 404s for OAuth) → `method =
/// "oauth"`, no expiry. A `--hostname` rejection (runtime-validate) retries once
/// without it.
async fn apply_glab_expiry(health: &mut SessionHealth, host: &str) {
    let with_host = run_glab_raw(
        None,
        &["api", "personal_access_tokens/self", "--hostname", host],
        GLAB_TIMEOUT,
    )
    .await;
    let out = match with_host {
        Ok(o) if o.code == 0 => o,
        Ok(o) => {
            // Non-zero. If `--hostname` was rejected as unknown, retry without it.
            if o.stderr.to_lowercase().contains("unknown flag")
                || o.stderr.to_lowercase().contains("unknown shorthand")
            {
                match run_glab_raw(None, &["api", "personal_access_tokens/self"], GLAB_TIMEOUT)
                    .await
                {
                    Ok(o2) if o2.code == 0 => o2,
                    // Any other non-zero (notably a 404 under OAuth) → oauth, no expiry.
                    _ => {
                        health.method = Some("oauth".to_string());
                        return;
                    }
                }
            } else {
                // 404 under OAuth is the expected non-zero here.
                health.method = Some("oauth".to_string());
                return;
            }
        }
        Err(_) => return, // transport/timeout: leave the decided health untouched.
    };
    #[derive(serde::Deserialize)]
    struct GlabPat {
        #[serde(default)]
        expires_at: Option<String>,
        #[serde(default)]
        #[allow(dead_code)]
        active: Option<bool>,
    }
    match serde_json::from_str::<GlabPat>(&out.stdout_lossy()) {
        Ok(pat) => {
            health.method = Some("pat".to_string());
            if let Some(exp) = pat.expires_at.filter(|s| !s.is_empty()) {
                health.days_left = days_left_from_date_prefix(&exp, today_civil_days());
                health.expires_at = Some(exp);
            }
        }
        // Unparseable body: still authenticated (we got here from a Healthy session),
        // just no expiry info. Don't overwrite state.
        Err(_) => {
            health.method = Some("pat".to_string());
        }
    }
}

/// Account-scoped GitLab health — one entry per host `glab` is signed in to, probed
/// concurrently. Installed but zero known hosts → a single NotConnected entry;
/// `glab` missing → a single CliMissing entry.
async fn gitlab_accounts_health() -> Vec<SessionHealth> {
    let hosts = crate::forge::glab::known_hosts().await;
    if hosts.is_empty() {
        // Distinguish "glab missing" from "installed, no hosts" with a cheap probe:
        // if a status probe reports glab missing, it's CliMissing.
        match run_glab_raw(None, &["auth", "status"], GLAB_TIMEOUT).await {
            Err(AppError::GlabNotFound) => {
                return vec![SessionHealth::new(
                    "gitlab",
                    "gitlab.com",
                    SessionState::CliMissing,
                )]
            }
            _ => {
                return vec![SessionHealth::new(
                    "gitlab",
                    "gitlab.com",
                    SessionState::NotConnected,
                )]
            }
        }
    }
    let futures = hosts.iter().map(|h| gitlab_health(h));
    crate::forge::futures_join_all(futures).await
}

// ── Bitbucket ───────────────────────────────────────────────────────────────────

/// Bitbucket health: the keyring token + a `GET /user` probe. No CLI, so never
/// CliMissing; no expiry (API tokens carry none we can read). `method = "token"`.
async fn bitbucket_health(host: &str) -> SessionHealth {
    let creds = match crate::forge::http::load_credentials().await {
        Ok(c) => c,
        // No token stored → not connected.
        Err(AppError::BitbucketNotConfigured) => {
            return SessionHealth::new("bitbucket", host, SessionState::NotConnected)
        }
        // A keyring/transport error is inconclusive, not "broken".
        Err(_) => return SessionHealth::new("bitbucket", host, SessionState::Offline),
    };
    let mut health = match crate::forge::http::bb_get_text_status(&creds, "user").await {
        Ok((status, _body)) => {
            let state = match status {
                s if (200..300).contains(&s) => SessionState::Healthy,
                401 => SessionState::Broken,
                // Authenticated but scope-limited — still a valid credential.
                403 => SessionState::Healthy,
                _ => SessionState::Offline,
            };
            SessionHealth::new("bitbucket", host, state)
        }
        // Transport failure → inconclusive.
        Err(_) => SessionHealth::new("bitbucket", host, SessionState::Offline),
    };
    health.method = Some("token".to_string());
    if health.state == SessionState::Healthy {
        // Login = the stored keyring username, else email. A blocking keyring read on
        // a blocking thread (like http.rs). The response body is never parsed.
        health.login = bitbucket_login().await;
    }
    health
}

/// The stored Bitbucket display login (username, else email) from the keyring.
async fn bitbucket_login() -> Option<String> {
    use crate::forge::http::{BB_HOST, KEY_EMAIL, KEY_USERNAME};
    tauri::async_runtime::spawn_blocking(|| {
        let username = crate::secrets::read_forge_secret(BB_HOST, KEY_USERNAME)
            .ok()
            .flatten()
            .filter(|s| !s.is_empty());
        username.or_else(|| {
            crate::secrets::read_forge_secret(BB_HOST, KEY_EMAIL)
                .ok()
                .flatten()
                .filter(|s| !s.is_empty())
        })
    })
    .await
    .ok()
    .flatten()
}

// ── Reconnect driver ────────────────────────────────────────────────────────────

/// The process-wide cancel registry: `session_id` → a `Notify` the cancel command
/// fires. The `session_id` is generated by the frontend (a uuid), so cancel needs no
/// round-trip to learn an id. Entries are removed on EVERY exit path (a leaked entry
/// per attempt would be a bug).
static RECONNECT_REGISTRY: LazyLock<Mutex<HashMap<String, Arc<Notify>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Register (or adopt) the cancel `Notify` for `session_id`. Uses
/// `entry().or_insert_with(...)`, NOT `insert`: a cancel that landed FIRST left a
/// tombstone holding a `notify_one` permit, and replacing it would orphan the child
/// (React StrictMode fires reconnect→cancel faster than resolve+spawn can register).
/// The adopted permit is consumed on the driver's first `.notified()` poll.
fn register_reconnect(session_id: &str) -> Arc<Notify> {
    RECONNECT_REGISTRY
        .lock()
        .expect("reconnect registry poisoned")
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Notify::new()))
        .clone()
}

/// Remove `session_id` from the registry (idempotent — safe on every exit path).
fn unregister_reconnect(session_id: &str) {
    RECONNECT_REGISTRY
        .lock()
        .expect("reconnect registry poisoned")
        .remove(session_id);
}

/// RAII cleanup for a registered reconnect: unregisters on drop, so every exit path
/// out of `forge_reconnect` after registration (including a panic) removes the entry.
/// Carries the `Notify` the driver waits on.
struct ReconnectGuard {
    session_id: String,
    notify: Arc<Notify>,
}

impl Drop for ReconnectGuard {
    fn drop(&mut self) {
        unregister_reconnect(&self.session_id);
    }
}

/// A reconnect host is a hostname, or a bracketed IPv6 literal, with an optional
/// numeric port — no scheme, no path, no shell syntax. The port is allowed because
/// `gh auth login --hostname host:8443` is exactly how a ported instance registers,
/// and the value becomes a `--hostname` argument the CLIs key their stored
/// credentials by. One grammar, shared with the credential-key guard so the two
/// can't drift.
fn valid_reconnect_host(host: &str) -> bool {
    crate::forge::is_safe_authority(host)
}

/// The most extra scopes one reconnect may request — a scope hint asks for one, and
/// a caller sending a long list is malformed rather than ambitious.
const MAX_RECONNECT_SCOPES: usize = 4;

/// The argv for a reconnect child, pure so the flag spelling and the scope rules are
/// pinned by tests rather than by a live CLI. `scopes` ride a GitHub *refresh* only:
/// that is the one gh flow that widens an existing token's grants (`gh auth refresh
/// -s <scope>`), while `auth login` re-runs the whole OAuth flow and glab has no
/// equivalent — so a scope arriving on any other arm is refused, never dropped
/// silently, since dropping it would hand back a session still missing the scope.
fn reconnect_args(
    provider: &str,
    mode: &str,
    host: &str,
    scopes: &[String],
) -> AppResult<Vec<String>> {
    if !scopes.is_empty() {
        if provider != "github" || mode != "refresh" {
            return Err(AppError::InvalidArgument(
                "scopes apply only to a GitHub refresh".into(),
            ));
        }
        if scopes.len() > MAX_RECONNECT_SCOPES {
            return Err(AppError::InvalidArgument(format!(
                "too many scopes: {}",
                scopes.len()
            )));
        }
        // `[a-z0-9_:]+` — the whole shape of an OAuth scope (`repo`,
        // `admin:repo_hook`, `delete_repo`); anything else can't be one.
        if let Some(bad) = scopes.iter().find(|s| {
            s.is_empty()
                || !s
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == ':')
        }) {
            return Err(AppError::InvalidArgument(format!("invalid scope: {bad}")));
        }
    }
    let mut args: Vec<String> = match (provider, mode) {
        ("github", "refresh") => vec!["auth", "refresh", "--hostname", host],
        ("github", _) => vec![
            "auth",
            "login",
            "--hostname",
            host,
            "--web",
            "--skip-ssh-key",
            "--git-protocol",
            "https",
        ],
        // glab has no `refresh` subcommand — login re-runs OAuth in both modes.
        ("gitlab", _) => vec!["auth", "login", "--hostname", host, "--web"],
        ("bitbucket", _) => {
            return Err(AppError::InvalidArgument(
                "Reconnect Bitbucket in Settings → Accounts.".into(),
            ))
        }
        (other, _) => {
            return Err(AppError::InvalidArgument(format!(
                "unknown provider: {other}"
            )))
        }
    }
    .into_iter()
    .map(String::from)
    .collect();
    for scope in scopes {
        args.push("-s".to_string());
        args.push(scope.clone());
    }
    Ok(args)
}

/// A cancellable `gh`/`glab` re-auth driver. Spawns the device-flow login/refresh
/// child, streams its stdout+stderr as sanitized `ReconnectEvent`s, and resolves when
/// the child exits or is cancelled. `session_id` is a frontend uuid; `mode` is
/// `"login"` | `"refresh"`; `provider` is `github` | `gitlab` (Bitbucket has no CLI
/// reconnect — it errors). `scopes` widen a GitHub refresh (see `reconnect_args`).
///
/// gh refreshes the host's ACTIVE account: on a multi-account host the granted scopes
/// land on whichever account `gh auth switch` last selected, not necessarily the one
/// whose missing scope prompted the call.
#[tauri::command]
pub async fn forge_reconnect(
    session_id: String,
    provider: String,
    host: String,
    mode: String,
    scopes: Option<Vec<String>>,
    on_event: Channel<ReconnectEvent>,
) -> AppResult<()> {
    // ── Validate every input before spawning anything ──
    if !valid_session_id(&session_id) {
        return Err(AppError::InvalidArgument("invalid session id".into()));
    }
    if !valid_reconnect_host(&host) {
        return Err(AppError::InvalidArgument(format!("invalid host: {host}")));
    }
    if !matches!(mode.as_str(), "login" | "refresh") {
        return Err(AppError::InvalidArgument(format!("invalid mode: {mode}")));
    }
    // Built before registering: a rejected provider/scope must not seed a registry
    // entry, and the build is sync — nothing can race in ahead of the registration.
    let args = reconnect_args(&provider, &mode, &host, scopes.as_deref().unwrap_or(&[]))?;
    let is_github = provider == "github";
    let bin_names: &[&str] = if is_github { &["gh"] } else { &["glab"] };

    // Register BEFORE the async resolve+spawn so a cancel racing ahead of them is
    // captured (see `register_reconnect`). The guard unregisters on every exit path
    // below, including the resolve/spawn error returns.
    let guard = ReconnectGuard {
        session_id: session_id.clone(),
        notify: register_reconnect(&session_id),
    };

    let Some(binary) = crate::agent::resolve_named(bin_names, None).await else {
        return Err(if is_github {
            AppError::GhNotFound
        } else {
            AppError::GlabNotFound
        });
    };

    // The driver waits on the guard's `Notify` (which may already carry a cancel
    // permit). The guard lives across this await and unregisters on return.
    run_reconnect_child(
        guard.notify.clone(),
        &binary,
        &args,
        is_github,
        &host,
        &on_event,
    )
    .await
}

/// Cancel an in-flight reconnect by its frontend-generated `session_id`. Fires the
/// registered `Notify`; an id that isn't registered yet gets a tombstone the later
/// registration adopts (see `cancel_reconnect`).
#[tauri::command]
pub async fn forge_reconnect_cancel(session_id: String) -> AppResult<()> {
    // Validate before touching the registry — same grammar gate as `forge_reconnect`,
    // so a malformed id can't seed a tombstone.
    if !valid_session_id(&session_id) {
        return Err(AppError::InvalidArgument("invalid session id".into()));
    }
    cancel_reconnect(&session_id);
    Ok(())
}

/// Fire the cancel for `session_id` — adopting the registered `Notify` when present,
/// else creating a tombstone the later-registering flow adopts. `notify_one` stores a
/// permit, so a cancel is never lost whether it arrives mid-loop or pre-registration.
///
/// A tombstone this call CREATES may never be adopted (nothing ever registers, or the
/// session already finished), which would grow the map unbounded — so in that case
/// only, schedule `sweep_unadopted_tombstone` to reclaim it if it stays unadopted.
fn cancel_reconnect(session_id: &str) {
    use std::collections::hash_map::Entry;
    let mut map = RECONNECT_REGISTRY
        .lock()
        .expect("reconnect registry poisoned");
    let (notify, created) = match map.entry(session_id.to_string()) {
        // A live flow already registered here → adopt its Notify (do NOT sweep — the
        // flow's RAII guard removes the entry on drop).
        Entry::Occupied(e) => (e.get().clone(), false),
        // Absent → insert a tombstone the later-registering flow will adopt (or that
        // the sweep below reclaims if nothing ever does).
        Entry::Vacant(e) => (e.insert(Arc::new(Notify::new())).clone(), true),
    };
    drop(map);
    notify.notify_one();
    if created {
        let id = session_id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(TOMBSTONE_SWEEP_DELAY).await;
            sweep_unadopted_tombstone(&id);
        });
    }
}

/// How long a cancel-created tombstone is kept before the sweep reclaims it if unadopted.
/// Comfortably longer than the resolve+spawn window a racing flow needs to adopt it.
const TOMBSTONE_SWEEP_DELAY: Duration = Duration::from_secs(60);

/// Remove `session_id` ONLY IF it's still an unadopted tombstone — i.e. the map holds
/// the sole `Arc` (`strong_count == 1` under the lock). A flow that adopted the entry
/// holds a clone via its RAII guard and removes it itself on drop, so any count above
/// 1 means the sweep must not touch it.
fn sweep_unadopted_tombstone(session_id: &str) {
    let mut map = RECONNECT_REGISTRY
        .lock()
        .expect("reconnect registry poisoned");
    if let Some(n) = map.get(session_id) {
        if Arc::strong_count(n) == 1 {
            map.remove(session_id);
        }
    }
}

/// Spawn + drive the reconnect child. Reads stdout AND stderr concurrently (the
/// one-time code can land on either), sanitizes every line, and emits at most two
/// `Code` events (see [`ReconnectParse::step`]). `host` is the already-validated flow
/// host every extracted URL is pinned to. Registry cleanup is the caller's
/// `ReconnectGuard`, not this fn.
async fn run_reconnect_child(
    cancel: Arc<Notify>,
    binary: &PathBuf,
    args: &[String],
    is_github: bool,
    host: &str,
    on_event: &Channel<ReconnectEvent>,
) -> AppResult<()> {
    let mut cmd = Command::new(binary);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args.iter().map(String::as_str));
    // Non-interactive + quiet. Deliberately no GH_PROMPT_DISABLED — stdin-null
    // suffices and that env var's effect on the web flow is unvalidated.
    cmd.env("NO_COLOR", "1").env("CLICOLOR", "0");
    if is_github {
        cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
    } else {
        // Share glab's runner seam for token scoping and quiet CLI settings;
        // see glab::configure_child_env for the update switch's measured contract.
        super::glab::configure_reconnect_child(&mut cmd, args).await;
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            if is_github {
                AppError::GhNotFound
            } else {
                AppError::GlabNotFound
            }
        } else {
            AppError::Io(e)
        }
    })?;

    // Merge stdout + stderr line streams — the one-time code can land on either.
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();

    let mut parse = ReconnectParse::default();
    let mut collected: Vec<String> = Vec::new();
    let mut cancelled = false;
    let mut timed_out = false;
    let mut send_failed = false;
    let mut out_done = false;
    let mut err_done = false;

    let deadline = tokio::time::sleep(RECONNECT_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        if out_done && err_done {
            break;
        }
        tokio::select! {
            _ = &mut deadline => {
                timed_out = true;
                let _ = child.start_kill();
                break;
            }
            _ = cancel.notified() => {
                cancelled = true;
                let _ = child.start_kill();
                break;
            }
            line = out_lines.next_line(), if !out_done => {
                match line {
                    Ok(Some(l)) => {
                        if !handle_reconnect_line(
                            &l, host, &mut parse, &mut collected, on_event,
                        ) {
                            send_failed = true;
                            let _ = child.start_kill();
                            break;
                        }
                    }
                    _ => out_done = true,
                }
            }
            line = err_lines.next_line(), if !err_done => {
                match line {
                    Ok(Some(l)) => {
                        if !handle_reconnect_line(
                            &l, host, &mut parse, &mut collected, on_event,
                        ) {
                            send_failed = true;
                            let _ = child.start_kill();
                            break;
                        }
                    }
                    _ => err_done = true,
                }
            }
        }
    }

    // Registry cleanup is owned by `ReconnectGuard` in `forge_reconnect` (it drops on
    // every return path, including this one).

    if cancelled || timed_out || send_failed {
        // Ensure the child is gone (kill_on_drop is a backstop; be explicit).
        let _ = child.kill().await;
        if send_failed {
            // The frontend is gone — nothing to emit to.
            return Ok(());
        }
        let message = if cancelled { "cancelled" } else { "timed out" };
        let _ = on_event.send(ReconnectEvent::Finished {
            ok: false,
            login: None,
            message: Some(message.to_string()),
        });
        return Ok(());
    }

    let status = child.wait().await;
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if ok {
        let login = parse_reconnect_login(&collected);
        let _ = on_event.send(ReconnectEvent::Finished {
            ok: true,
            login,
            message: None,
        });
    } else {
        // The last non-empty (already-sanitized) line as the failure message.
        let message = collected
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .cloned();
        let _ = on_event.send(ReconnectEvent::Finished {
            ok: false,
            login: None,
            message,
        });
    }
    Ok(())
}

/// What one reconnect flow has parsed out of its output so far, and what it has
/// already told the frontend. Carried across every line of both streams.
#[derive(Default)]
struct ReconnectParse {
    code: Option<String>,
    url: Option<String>,
    url_emitted: bool,
    code_emitted: bool,
}

impl ReconnectParse {
    /// Fold one output line into the parse state and decide what it emits, in order:
    /// a `Code` event when known state improved, then the sanitized `Line`. `clean` is
    /// the sanitized (redacted, ≤300-char) text the `Line` carries; `raw` is the
    /// untruncated original, which only URL extraction reads. Empty lines emit nothing.
    ///
    /// A `Code` carrying the parsed code swallows its line — the code renders instead.
    /// A URL-ONLY `Code` does not: with no code parsed, the CLI's raw output is the
    /// primary UI, and the URL-bearing line is the one that explains what happened.
    ///
    /// `Code` re-emits only when known state IMPROVES — the URL as soon as it is known,
    /// then once more if the code's wording is recognised afterwards — so a flow emits
    /// at most two of them.
    fn step(&mut self, raw: &str, clean: &str, host: &str) -> Vec<ReconnectEvent> {
        if self.code.is_none() {
            self.code = find_one_time_code(clean);
        }
        if self.url.is_none() {
            self.url = find_flow_url(raw, host);
        }
        let mut out = Vec::new();
        let mut swallow_line = false;
        if let Some(url) = self.url.clone() {
            let have_code = self.code.is_some();
            if !self.url_emitted || (have_code && !self.code_emitted) {
                self.url_emitted = true;
                self.code_emitted = have_code;
                swallow_line = have_code;
                out.push(ReconnectEvent::Code {
                    code: self.code.clone(),
                    url,
                });
            }
        }
        if !swallow_line && !clean.trim().is_empty() {
            out.push(ReconnectEvent::Line {
                text: clean.to_string(),
            });
        }
        out
    }
}

/// Process one raw output line: sanitize it, fold it into `parse`, and send whatever
/// that step decided to emit, in order. Returns `false` when a channel send failed
/// (frontend gone) so the caller can tear down.
fn handle_reconnect_line(
    raw: &str,
    host: &str,
    parse: &mut ReconnectParse,
    collected: &mut Vec<String>,
    on_event: &Channel<ReconnectEvent>,
) -> bool {
    let clean = sanitize_line(raw);
    collected.push(clean.clone());
    // `all` short-circuits, so a failed send stops the rest of this line's events.
    parse
        .step(raw, &clean, host)
        .into_iter()
        .all(|event| on_event.send(event).is_ok())
}

/// A best-effort login from the collected reconnect output
/// (`Logged in as <login>` / `account <login>`).
fn parse_reconnect_login(lines: &[String]) -> Option<String> {
    for line in lines {
        let after = line
            .split_once("Logged in as ")
            .or_else(|| line.split_once(" account "))
            .map(|(_, rest)| rest);
        if let Some(rest) = after {
            let login = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_')
                .to_string();
            if !login.is_empty() {
                return Some(login);
            }
        }
    }
    None
}

// ── Sanitization / parsing helpers (pure — unit-tested) ─────────────────────────

/// A `session_id` must match `[A-Za-z0-9-]{8,64}` (accommodates a uuid).
fn valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Sanitize a line for forwarding to the frontend: redact token-ish runs, then
/// truncate to ≤300 chars. Also used to bound a `detail` string.
fn sanitize_line(raw: &str) -> String {
    let redacted = redact_tokens(raw);
    // Truncate to 300 chars (char-boundary safe).
    redacted.chars().take(300).collect()
}

/// The register every `SessionHealth.detail` is minted in, capped at 300 chars (the
/// same bound as `sanitize_line`). See `normalize_detail`.
fn sanitize_detail(raw: &str) -> String {
    normalize_detail(raw, 300)
}

/// CLI wrappers that precede the forge's own message: glab's API-failure framing and
/// Go's oauth2 error prefix.
const DETAIL_WRAPPERS: [&str; 2] = ["API call failed:", "oauth2:"];

/// glab's styled failure banner, once trimmed of its padding.
const GLAB_ERROR_BANNER: &str = "ERROR";

/// glab's closing summary across every configured host, after its status glyph.
const GLAB_AGGREGATE_SUMMARY: &str =
    "could not authenticate to one or more of the configured GitLab instances";

/// glab's trailing banner and host-wide summary: they say THAT something failed,
/// never why, so they give way to any specific failure line.
fn is_aggregate_failure(text: &str) -> bool {
    text == GLAB_ERROR_BANNER
        || text
            .get(..GLAB_AGGREGATE_SUMMARY.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(GLAB_AGGREGATE_SUMMARY))
}

/// Redacts tokens, then reduces CLI output to the forge's own words on one line: host
/// header lines, status glyphs, announced `<host>:` prefixes and `DETAIL_WRAPPERS`
/// go, success (✓) lines and aggregate failure lines go while a specific failure
/// line remains, and an over-`cap` result is cut at a word with an ellipsis, never
/// leaving an unbalanced quote. At most `cap` chars.
fn normalize_detail(raw: &str, cap: usize) -> String {
    let redacted = redact_tokens(raw).replace('\r', "\n");
    let mut failures = Vec::new();
    let mut successes = Vec::new();
    let mut hosts = Vec::new();
    for line in redacted.lines().map(str::trim) {
        if line.is_empty() {
            continue;
        }
        if host_token_len(line) == Some(line.len()) {
            hosts.push(line.to_string());
            continue;
        }
        let (success, text) = strip_detail_framing(line, &mut hosts);
        match (text.is_empty(), success) {
            (true, _) => {}
            (false, true) => successes.push(text),
            (false, false) => failures.push(text),
        }
    }
    // Aggregate lines give way to a specific failure, then the bare banner to the summary.
    if failures.iter().any(|text| !is_aggregate_failure(text)) {
        failures.retain(|text| !is_aggregate_failure(text));
    } else if failures.iter().any(|text| text != GLAB_ERROR_BANNER) {
        failures.retain(|text| text != GLAB_ERROR_BANNER);
    }
    let kept = if failures.is_empty() {
        successes
    } else {
        failures
    };
    let mut joined = String::new();
    for text in kept {
        if !joined.is_empty() {
            if !joined.ends_with(['.', '!', '?', ':', ';']) {
                joined.push('.');
            }
            joined.push(' ');
        }
        joined.push_str(&text);
    }
    drop_unbalanced_quote(&truncate_at_word(&joined, cap))
}

/// One output line without its CLI framing, and whether it carried a success glyph.
/// `hosts` holds the hosts this output names as its own (a header line, or a host
/// leading a status glyph); only those lose a `<host>:` prefix, so a file name such as
/// `config.yml:` keeps its place in the message.
fn strip_detail_framing(line: &str, hosts: &mut Vec<String>) -> (bool, String) {
    let mut s = line;
    let mut success = false;
    loop {
        let before = s.len();
        if let Some(n) = host_token_len(s) {
            let (host, rest) = s.split_at(n);
            if rest.starts_with(char::is_whitespace) && status_glyph(rest.trim_start()).is_some() {
                // glab's host header run together with the status line under it.
                hosts.push(host.to_string());
                s = rest.trim_start();
            } else if let Some(after) = rest
                .strip_prefix(':')
                .filter(|a| a.starts_with(char::is_whitespace))
                .filter(|_| hosts.iter().any(|h| h.eq_ignore_ascii_case(host)))
            {
                s = after.trim_start();
            }
        }
        if let Some((ok, n)) = status_glyph(s) {
            success |= ok;
            s = s[n..].trim_start();
        }
        for wrapper in DETAIL_WRAPPERS {
            if s.get(..wrapper.len())
                .is_some_and(|head| head.eq_ignore_ascii_case(wrapper))
            {
                s = s[wrapper.len()..].trim_start();
            }
        }
        if s.len() == before {
            return (success, unwrap_quoted_detail(s));
        }
    }
}

/// A leading CLI status glyph followed by whitespace: `(is_success, byte length)`.
fn status_glyph(s: &str) -> Option<(bool, usize)> {
    let mut chars = s.chars();
    let c = chars.next()?;
    if !chars.next().is_some_and(char::is_whitespace) {
        return None;
    }
    match c {
        '✓' | '✔' => Some((true, c.len_utf8())),
        '✗' | '✘' | '×' | 'x' | 'X' | '!' | '-' | '*' | '•' => Some((false, c.len_utf8())),
        _ => None,
    }
}

/// The byte length of a leading hostname (`gitlab.com`, `ghes.example:8443`): dotted
/// labels ending in an alphabetic TLD, so a version or decimal never reads as one.
fn host_token_len(s: &str) -> Option<usize> {
    let mut n = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .unwrap_or(s.len());
    let host = &s[..n];
    let tld = host.rsplit('.').next().unwrap_or("");
    if !host.contains('.') || tld.is_empty() || !tld.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if let Some(port) = s[n..].strip_prefix(':') {
        let digits = port
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(port.len());
        if digits > 0 {
            n += 1 + digits;
        }
    }
    Some(n)
}

/// Go's oauth2 errors print as `"code" "description"` (`%q %q`): the description is the
/// forge's own sentence, the snake_case code is not. Text that isn't wholly quoted
/// segments passes through; an unterminated last segment (upstream truncation) keeps
/// what it holds.
fn unwrap_quoted_detail(s: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    let mut rest = s;
    while let Some(body) = rest.strip_prefix('"') {
        let mut segment = String::new();
        let mut end = None;
        let mut chars = body.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '\\' => segment.extend(chars.next().map(|(_, escaped)| escaped)),
                '"' => {
                    end = Some(i + 1);
                    break;
                }
                _ => segment.push(c),
            }
        }
        segments.push(segment);
        rest = end.map_or("", |e| body[e..].trim_start());
    }
    if segments.is_empty() || !rest.is_empty() {
        return s.to_string();
    }
    let sentence = segments
        .iter()
        .find(|seg| seg.contains(char::is_whitespace));
    sentence.or(segments.first()).cloned().unwrap_or_default()
}

/// `s` in at most `cap` chars: whole when it fits, else cut at the last word boundary
/// in the back half (a hard cut for one unbroken run) with an ellipsis.
fn truncate_at_word(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let head: String = s.chars().take(cap.saturating_sub(1)).collect();
    let cut = head
        .rfind(char::is_whitespace)
        .filter(|&i| head[..i].chars().count() >= cap / 2)
        .map_or(head.as_str(), |i| &head[..i]);
    let mut out = cut
        .trim_end_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | ':'))
        .to_string();
    out.push('…');
    out
}

/// `s` without its last `"` when the quotes don't pair — the opening of a quoted span
/// a cut ended inside.
fn drop_unbalanced_quote(s: &str) -> String {
    match s.rfind('"') {
        Some(i) if s.matches('"').count() % 2 == 1 => format!("{}{}", &s[..i], &s[i + 1..]),
        _ => s.to_string(),
    }
}

/// Replace any token-ish substring with `[redacted]`. Covers gh (`gho_`, `ghp_`,
/// `github_pat_`) and glab (`glpat-`) prefixes and the run of token characters that
/// follows. Defense-in-depth: no token material may ever reach an event, detail, or
/// log.
fn redact_tokens(input: &str) -> String {
    const PREFIXES: [&str; 4] = ["gho_", "ghp_", "github_pat_", "glpat-"];
    let mut result = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    'outer: while i < input.len() {
        // Only attempt a match at a char boundary.
        if input.is_char_boundary(i) {
            for pfx in PREFIXES {
                if input[i..].starts_with(pfx) {
                    // Consume the prefix + the following token run
                    // ([A-Za-z0-9_-]) as one redacted unit.
                    let mut j = i + pfx.len();
                    while j < bytes.len() {
                        let c = bytes[j];
                        if c.is_ascii_alphanumeric() || c == b'_' || c == b'-' {
                            j += 1;
                        } else {
                            break;
                        }
                    }
                    result.push_str("[redacted]");
                    i = j;
                    continue 'outer;
                }
            }
        }
        // Copy this byte's char through unchanged.
        let ch_len = utf8_char_len(bytes[i]);
        let end = (i + ch_len).min(input.len());
        result.push_str(&input[i..end]);
        i = end;
    }
    result
}

/// The byte length of a UTF-8 char from its lead byte (1..=4).
fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead >> 5 == 0b110 {
        2
    } else if lead >> 4 == 0b1110 {
        3
    } else if lead >> 3 == 0b11110 {
        4
    } else {
        1 // invalid lead — advance one byte to make progress.
    }
}

/// Extract a device one-time code like `3285-B415`. Requires the literal `one-time
/// code` (case-insensitive), then reads the next token across a run of `:`, `(`, and
/// whitespace, then gates it on the `<4+ alnum>-<4+ alnum>` shape — so gh's two known
/// punctuations both parse (`one-time code: XXXX-YYYY`, and with its clipboard default
/// on, `One-time code (XXXX-YYYY) copied to clipboard`) while prose following the
/// phrase does not. Deliberately narrow: the code is the ADJACENT token, never a
/// shape-match found elsewhere in the line. Hand-rolled (no regex dep).
fn find_one_time_code(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let idx = lower.find("one-time code")?;
    let after = &line[idx + "one-time code".len()..];
    let after = after.trim_start_matches(|c: char| c == ':' || c == '(' || c.is_whitespace());
    // Read the first token: [A-Za-z0-9-] run.
    let token: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    // Must be `<4+ alnum>-<4+ alnum>` (a single hyphen splitting two groups).
    let mut parts = token.split('-');
    let (a, b, rest) = (parts.next(), parts.next(), parts.next());
    match (a, b, rest) {
        (Some(a), Some(b), None)
            if a.len() >= 4
                && b.len() >= 4
                && a.chars().all(|c| c.is_ascii_alphanumeric())
                && b.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            Some(token)
        }
        _ => None,
    }
}

/// The longest a verification URL may be. glab's OAuth authorize URL measured 377
/// chars, so the bound is generous; past it the candidate is REFUSED rather than
/// truncated — half a URL is worse than none.
const MAX_FLOW_URL: usize = 2048;

/// The verification URL carried by one output line, host-pinned to the flow's own
/// authority. Extracted from the REDACTED but UNTRUNCATED line, so a URL longer than
/// the 300-char `Line` cap survives intact (glab prints its 377-char authorize URL
/// inside a 405-char line). The pin is what makes the URL safe to open without a
/// click: a docs link in a CLI error message must never qualify, and
/// `ReconnectParse::url` being first-match-sticky means a stray URL would also block
/// the real one. The compare elides the scheme's default web port from both sides —
/// the rule [`crate::forge::web_authority`] pins — so a host registered `h:443` still
/// matches the portless URL gh prints for it; any other port stays, being the
/// instance's identity.
fn find_flow_url(raw: &str, host: &str) -> Option<String> {
    let url = find_url(&redact_tokens(raw))?;
    // Content gates run on the candidate AS FOUND: the punctuation trim below strips
    // a `]`, which would otherwise carry a redacted URL past this check.
    if url.chars().count() > MAX_FLOW_URL || url.contains("[redacted]") {
        return None;
    }
    // Prose punctuation around a URL rides the whitespace-terminated run into
    // `openUrl`, which now fires without a click.
    let url = url.trim_end_matches(['.', ',', ';', ':', ')', ']']);
    let authority = url_authority(url)?;
    // `user:pass@host` reads as the host to a human, and this URL is both displayed
    // and opened.
    if authority.contains('@') {
        return None;
    }
    let https = url.starts_with("https://");
    if !without_default_web_port(authority, https)
        .eq_ignore_ascii_case(without_default_web_port(host, https))
    {
        return None;
    }
    Some(url.to_string())
}

/// A `host[:port]` with the scheme's default web port elided (`:443` https, `:80`
/// http) — [`crate::forge::web_authority`]'s rule, applied to a bare authority.
fn without_default_web_port(authority: &str, https: bool) -> &str {
    let default_port = if https { ":443" } else { ":80" };
    authority.strip_suffix(default_port).unwrap_or(authority)
}

/// A URL's authority — everything between `://` and the first `/`, `?`, or `#`.
/// `None` for anything that isn't an `https`/`http` URL with a non-empty authority.
fn url_authority(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    (!authority.is_empty()).then_some(authority)
}

/// Extract the first `http://` / `https://` URL from a line (runs until whitespace).
fn find_url(line: &str) -> Option<String> {
    for scheme in ["https://", "http://"] {
        if let Some(idx) = line.find(scheme) {
            let url: String = line[idx..]
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            if url.len() > scheme.len() {
                return Some(url);
            }
        }
    }
    None
}

/// The number of days a `YYYY-MM-DD`-prefixed date string is from `today` (given as
/// days since the civil epoch). `None` when the leading date can't be parsed. A
/// trailing time / timezone after the date prefix is ignored.
fn days_left_from_date_prefix(value: &str, today_days: i64) -> Option<i64> {
    let date = value.trim();
    // Take the leading `YYYY-MM-DD`.
    let bytes = date.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let is_digit = |b: u8| b.is_ascii_digit();
    if !(is_digit(bytes[0])
        && is_digit(bytes[1])
        && is_digit(bytes[2])
        && is_digit(bytes[3])
        && bytes[4] == b'-'
        && is_digit(bytes[5])
        && is_digit(bytes[6])
        && bytes[7] == b'-'
        && is_digit(bytes[8])
        && is_digit(bytes[9]))
    {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[5..7].parse().ok()?;
    let day: i64 = date[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let target = days_from_civil(year, month, day);
    Some(target - today_days)
}

/// Days since the civil epoch (1970-01-01) for a proleptic-Gregorian date — Howard
/// Hinnant's `days_from_civil` algorithm (well-known, bounded, no external deps).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// Today as days since the civil epoch, from the wall clock (UTC).
fn today_civil_days() -> i64 {
    use chrono::Datelike;
    let now = chrono::Utc::now().date_naive();
    days_from_civil(now.year() as i64, now.month() as i64, now.day() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── gh JSON parse fixtures ──
    fn parse_hosts(json: &str) -> HashMap<String, Vec<GhJsonAccount>> {
        #[derive(serde::Deserialize)]
        struct W {
            #[serde(default)]
            hosts: HashMap<String, Vec<GhJsonAccount>>,
        }
        serde_json::from_str::<W>(json).unwrap().hosts
    }

    #[test]
    fn gh_json_success_is_healthy() {
        // The exact live JSON a real `gh auth status --json hosts` returns.
        let json = r#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"theBGuy","tokenSource":"keyring","scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}"#;
        let hosts = parse_hosts(json);
        let health = classify_gh_host(&hosts["github.com"]);
        assert_eq!(health.state, SessionState::Healthy);
        assert_eq!(health.login.as_deref(), Some("theBGuy"));
        assert_eq!(health.active, Some(true));
    }

    /// One `gh auth status --json hosts` reading for github.com whose single active
    /// account carries `state` and (when given) `error`.
    fn one_account(state: &str, error: Option<&str>) -> HashMap<String, Vec<GhJsonAccount>> {
        let error = error
            .map(|e| format!(r#","error":{}"#, serde_json::to_string(e).unwrap()))
            .unwrap_or_default();
        parse_hosts(&format!(
            r#"{{"hosts":{{"github.com":[{{"state":"{state}","active":true,"host":"github.com","login":"theBGuy"{error}}}]}}}}"#
        ))
    }

    /// Both classifier paths — per-repo and accounts-scoped — for one reading, with
    /// each path's re-probe decision.
    fn classify_both(map: &HashMap<String, Vec<GhJsonAccount>>) -> [(SessionHealth, bool); 2] {
        let accounts = &map["github.com"];
        let repo = classify_gh_host(accounts);
        let repo_reprobe = needs_reprobe(repo.state);
        let acct = gh_account_health("github.com", &accounts[0]);
        [(repo, repo_reprobe), (acct, gh_accounts_need_reprobe(map))]
    }

    // go-gh renders an API failure as `HTTP %d: %s (%s)`. The 401 wording is gh's
    // real output; the rate-limit wordings are GitHub's documented messages, not
    // observed through gh live, which is why the classifier matches a substring.
    const GH_401: &str = "HTTP 401: Bad credentials (https://api.github.com/)";
    const GH_403_PRIMARY: &str =
        "HTTP 403: API rate limit exceeded for user ID 12345 (https://api.github.com/)";
    const GH_403_SECONDARY: &str = "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (https://api.github.com/)";
    const GH_429: &str = "HTTP 429: Too Many Requests (https://api.github.com/)";
    /// Older GHES's wording for a secondary limit.
    const GH_403_ABUSE: &str = "HTTP 403: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again. (https://ghes.example/api/v3/)";

    #[test]
    fn gh_json_error_is_broken_before_reprobe() {
        let map = one_account("error", Some(GH_401));
        for (health, reprobe) in classify_both(&map) {
            // error→Broken, and the async callers confirm it with the anti-flap
            // re-probe before it stands.
            assert_eq!(health.state, SessionState::Broken);
            assert_eq!(health.detail.as_deref(), Some(GH_401));
            assert!(reprobe, "a Broken reading must earn the re-probe");
        }
    }

    #[test]
    fn gh_json_rate_limit_is_rate_limited_without_reprobe() {
        for error in [GH_403_PRIMARY, GH_403_SECONDARY, GH_429, GH_403_ABUSE] {
            let map = one_account("error", Some(error));
            for (health, reprobe) in classify_both(&map) {
                assert_eq!(health.state, SessionState::RateLimited, "{error}");
                assert_eq!(health.detail.as_deref(), Some(error));
                assert_eq!(health.login.as_deref(), Some("theBGuy"));
                // A re-probe spends another call against the exhausted quota.
                assert!(!reprobe, "RateLimited must not re-probe: {error}");
                assert_eq!(health.reset_at, None, "the pure classifier never fetches");
            }
        }
    }

    #[test]
    fn gh_json_rate_limit_match_is_case_insensitive() {
        let map = one_account("error", Some("HTTP 403: API RATE LIMIT EXCEEDED"));
        for (health, _) in classify_both(&map) {
            assert_eq!(health.state, SessionState::RateLimited);
        }
    }

    #[test]
    fn gh_json_error_without_detail_stays_broken() {
        let map = one_account("error", None);
        for (health, reprobe) in classify_both(&map) {
            assert_eq!(health.state, SessionState::Broken);
            assert_eq!(health.detail, None);
            assert!(reprobe);
        }
    }

    #[test]
    fn gh_json_timeout_is_offline_never_broken() {
        let json = r#"{"hosts":{"github.com":[{"state":"timeout","active":true,"host":"github.com","error":"context deadline exceeded"}]}}"#;
        let map = parse_hosts(json);
        for (health, reprobe) in classify_both(&map) {
            assert_eq!(health.state, SessionState::Offline);
            assert!(!reprobe);
        }
    }

    #[test]
    fn gh_accounts_reprobe_fires_when_any_account_is_broken() {
        // One rate-limited host beside one broken host: the Broken one still earns
        // the shared re-probe.
        let json = format!(
            r#"{{"hosts":{{"github.com":[{{"state":"error","active":true,"login":"a","error":{}}}],"ghes.example":[{{"state":"error","active":true,"login":"b","error":{}}}]}}}}"#,
            serde_json::to_string(GH_403_PRIMARY).unwrap(),
            serde_json::to_string(GH_401).unwrap(),
        );
        assert!(gh_accounts_need_reprobe(&parse_hosts(&json)));
    }

    #[test]
    fn poller_hosts_map_has_one_entry_per_host_from_its_active_account() {
        // The shape the default-host probe returns: every known host at once.
        let json = format!(
            r#"{{"hosts":{{"github.com":[{{"state":"error","active":false,"login":"alt","error":{}}},{{"state":"success","active":true,"login":"main"}}],"ghes.example":[{{"state":"error","active":true,"login":"b","error":{}}}],"ghes.other":[{{"state":"error","active":true,"login":"c","error":{}}}]}}}}"#,
            serde_json::to_string(GH_401).unwrap(),
            serde_json::to_string(GH_403_PRIMARY).unwrap(),
            serde_json::to_string(GH_401).unwrap(),
        );
        let health = gh_hosts_health(&parse_hosts(&json));
        assert_eq!(health.len(), 3);
        let main = &health["github.com"];
        assert_eq!(main.host, "github.com");
        assert_eq!(main.state, SessionState::Healthy);
        assert_eq!(main.login.as_deref(), Some("main"));
        // Poller-lite: classified as-is, with no reset fetch and no expiry read.
        let limited = &health["ghes.example"];
        assert_eq!(limited.state, SessionState::RateLimited);
        assert_eq!(limited.reset_at, None);
        assert_eq!(health["ghes.other"].state, SessionState::Broken);
        assert_eq!(main.method, None);
    }

    // ── transport-failure wording (Offline, never Broken) ──
    /// Every NETWORKISH token, the gh-only additions, and realistic gh phrasings.
    /// MEASURED from `gh auth status --json` (gh 2.94.0): the `Get "https://…"` lines
    /// behind a local proxy that reset, closed, or refused the CONNECT (502/503/504/407),
    /// and the `HTTP 5xx: … (http://api.github.localhost/)` lines from a local origin
    /// answering 500/503. INFERRED (not reproduced): the `no such host`, `connection
    /// refused`, TLS-handshake, and `proxyconnect` lines, and the `non-200 OK status
    /// code: 503` shape, extrapolated from the measured 401 in that shape.
    const GH_NETWORK_ERRORS: [&str; 30] = [
        "timeout",
        "connection",
        "dial",
        "lookup",
        "network",
        "tls",
        "deadline exceeded",
        "EOF",
        "Bad Gateway",
        "Service Unavailable",
        "proxy",
        "proxyconnect",
        "500",
        "502",
        "503",
        "504",
        "Get \"https://api.github.com/\": dial tcp: lookup api.github.com: no such host",
        "Get \"https://api.github.com/\": dial tcp 140.82.112.6:443: connect: connection refused",
        "Get \"https://api.github.com/\": net/http: TLS handshake timeout",
        "Get \"https://api.github.com/\": proxyconnect tcp: dial tcp 10.0.0.1:8080: i/o timeout",
        "Get \"https://api.github.com/\": context deadline exceeded",
        "Get \"https://api.github.com/\": read tcp 127.0.0.1:50615->127.0.0.1:9902: wsarecv: An existing connection was forcibly closed by the remote host.",
        "Get \"https://api.github.com/\": unexpected EOF",
        "Get \"https://api.github.com/\": Bad Gateway",
        "Get \"https://api.github.com/\": Service Unavailable",
        "Get \"https://api.github.com/\": Gateway Timeout",
        "Get \"https://api.github.com/\": Proxy Authentication Required",
        "HTTP 503: Service Unavailable (http://api.github.localhost/)",
        "HTTP 500: Server Error (http://api.github.localhost/)",
        "non-200 OK status code: 503 Service Unavailable body: \"{}\"",
    ];

    #[test]
    fn gh_json_network_error_is_offline_never_broken() {
        for error in GH_NETWORK_ERRORS {
            assert!(gh_error_is_network(Some(error)), "{error}");
            let map = one_account("error", Some(error));
            for (health, reprobe) in classify_both(&map) {
                assert_eq!(health.state, SessionState::Offline, "{error}");
                assert!(
                    !reprobe,
                    "an outage fails the re-probe identically: {error}"
                );
                assert_eq!(health.login.as_deref(), Some("theBGuy"));
            }
        }
    }

    #[test]
    fn gh_json_auth_refusal_stays_broken_despite_network_words() {
        // gh 2.94.0's live wording for a rejected token, measured with a bogus GH_TOKEN.
        let live_401 = "non-200 OK status code: 401 Unauthorized body: \"{\\r\\n  \\\"message\\\": \\\"Bad credentials\\\",\\r\\n  \\\"documentation_url\\\": \\\"https://docs.github.com/rest\\\",\\r\\n  \\\"status\\\": \\\"401\\\"\\r\\n}\"";
        for error in [
            GH_401,
            live_401,
            "The token in keyring is invalid.",
            // An answered 401/403 is a credential verdict whatever its body says.
            "HTTP 401: token revoked after a network policy change (https://api.github.com/)",
            "HTTP 403: Resource protected by organization SAML enforcement; connection denied",
            // Measured origin 401 (local `github.localhost` origin, gh 2.94.0).
            "HTTP 401: Bad credentials (http://api.github.localhost/)",
            // The 401/403 check runs before the 5xx and proxy words.
            "HTTP 401: Bad credentials from proxy 503 retry",
        ] {
            assert!(!gh_error_is_network(Some(error)), "{error}");
            for (health, reprobe) in classify_both(&one_account("error", Some(error))) {
                assert_eq!(health.state, SessionState::Broken, "{error}");
                assert!(
                    reprobe,
                    "Broken still earns the anti-flap re-probe: {error}"
                );
            }
        }
    }

    #[test]
    fn gh_network_match_is_whole_word_only() {
        for error in [
            "connections are fine but the token was rejected",
            "reconnection required",
            "a cordial refusal",
            "thereof",
            "networked credential store rejected the token",
            "port 5030 rejected the token",
            "request id 1503-a rejected",
        ] {
            assert!(!gh_error_is_network(Some(error)), "{error}");
        }
        assert!(!gh_error_is_network(None));
        assert!(
            gh_error_is_network(Some("i/o TIMEOUT")),
            "matching is case-insensitive"
        );
    }

    #[test]
    fn old_gh_text_report_reads_offline_only_on_transport_words() {
        // Inferred old-gh wording (from gh's source, not a live old gh).
        let timed_out = "\
  ✓ Logged in to github.com as alice (oauth_token)
  X Timeout trying to log in to github.acme.com account bob (keyring)";
        let h = classify_gh_text_report(1, timed_out, "github.com");
        assert_eq!(h.state, SessionState::Offline);
        assert_eq!(h.login.as_deref(), Some("alice"));
        let invalid = "\
  ✓ Logged in to github.com as alice (oauth_token)
  X Failed to log in to github.acme.com account bob (keyring)
  - The token in keyring is invalid.";
        assert_eq!(
            classify_gh_text_report(1, invalid, "github.com").state,
            SessionState::Broken
        );
        assert_eq!(
            classify_gh_text_report(0, timed_out, "github.com").state,
            SessionState::Healthy
        );
        assert_eq!(
            classify_gh_text_report(1, "You are not logged into any GitHub hosts.", "github.com")
                .state,
            SessionState::NotConnected
        );
        // A transport failure can leave no account line to parse; it still reads
        // Offline, with no login to carry. Inferred wording, not a live old gh.
        let unreachable = "\
error connecting to api.github.com
check your internet connection or https://githubstatus.com";
        let h = classify_gh_text_report(1, unreachable, "github.com");
        assert_eq!(h.state, SessionState::Offline);
        assert_eq!(h.login, None);
        assert_eq!(h.active, None);
    }

    #[test]
    fn gh_rate_limit_outranks_network_words() {
        let error =
            "HTTP 403: API rate limit exceeded; connection throttled (https://api.github.com/)";
        for (health, _) in classify_both(&one_account("error", Some(error))) {
            assert_eq!(health.state, SessionState::RateLimited);
        }
    }

    // ── gh_status's per-host auth read ──
    fn host_auth(json: &str, host: &str) -> Option<GhHostAuth> {
        gh_host_auth(&GhJsonProbe::Parsed(parse_hosts(json)), host).expect("no Offline host")
    }

    #[test]
    fn host_auth_reads_the_repo_host_despite_a_broken_other_host() {
        let json = format!(
            r#"{{"hosts":{{"github.com":[{{"state":"success","active":true,"login":"main"}}],"ghes.example":[{{"state":"error","active":true,"login":"b","error":{}}}]}}}}"#,
            serde_json::to_string(GH_401).unwrap(),
        );
        let auth = host_auth(&json, "github.com").expect("github.com is in the map");
        assert!(auth.authenticated);
        assert_eq!(auth.login.as_deref(), Some("main"));
        // The broken host still reads false for its own repos.
        let other = host_auth(&json, "ghes.example").expect("ghes.example is in the map");
        assert!(!other.authenticated);
        assert_eq!(other.login.as_deref(), Some("b"));
    }

    #[test]
    fn host_auth_rate_limited_reads_false() {
        // Deliberate: the UI's rate-limit arm owns this state; reading true would mount
        // every GitHub panel straight into 403s.
        let auth = host_auth_of(one_account("error", Some(GH_403_PRIMARY)));
        assert!(!auth.authenticated);
        assert_eq!(auth.login.as_deref(), Some("theBGuy"));
    }

    #[test]
    fn host_auth_broken_and_empty_accounts_read_false() {
        assert!(!host_auth_of(one_account("error", Some(GH_401))).authenticated);
        let empty = host_auth(r#"{"hosts":{"github.com":[]}}"#, "github.com")
            .expect("a present key answers even with no accounts");
        assert!(!empty.authenticated);
        assert_eq!(empty.login, None);
    }

    #[test]
    fn host_auth_offline_host_is_an_error_never_signed_out() {
        for map in [
            one_account("timeout", None),
            one_account(
                "error",
                Some("Get \"https://api.github.com/\": unexpected EOF"),
            ),
            one_account("", None),
        ] {
            let err = gh_host_auth(&GhJsonProbe::Parsed(map), "github.com")
                .err()
                .expect("an Offline host rejects");
            assert!(
                err.to_string().starts_with("Couldn't reach github.com"),
                "{err}"
            );
        }
    }

    /// `gh_host_auth` for github.com over a reading that contains it.
    fn host_auth_of(map: HashMap<String, Vec<GhJsonAccount>>) -> GhHostAuth {
        gh_host_auth(&GhJsonProbe::Parsed(map), "github.com")
            .expect("no Offline host")
            .expect("github.com is in the map")
    }

    #[test]
    fn host_auth_is_unknown_when_the_host_is_absent() {
        let json = r#"{"hosts":{"github.com":[{"state":"success","active":true,"login":"main"}]}}"#;
        assert!(host_auth(json, "ghes.example").is_none());
    }

    #[test]
    fn host_auth_is_unknown_over_an_empty_map() {
        // gh prints this for an unregistered `--hostname` and still exits 0.
        assert!(host_auth(r#"{"hosts":{}}"#, "github.com").is_none());
    }

    #[test]
    fn host_auth_is_unknown_on_old_gh() {
        assert!(gh_host_auth(&GhJsonProbe::UnknownFlag, "github.com")
            .unwrap()
            .is_none());
    }

    #[test]
    fn host_auth_probe_error_rejects_without_a_fallback() {
        let timeout = gh_host_auth_from_result(Err(AppError::Timeout(15)), "github.com")
            .err()
            .expect("a timed-out probe rejects");
        assert_eq!(
            timeout.to_string(),
            "Couldn't reach github.com to check the GitHub sign-in."
        );
        for err in [
            AppError::Io(std::io::Error::other("spawn failed")),
            AppError::GhNotFound,
        ] {
            let expected = err.to_string();
            let got = gh_host_auth_from_result(Err(err), "github.com")
                .err()
                .expect("a failed probe rejects, so the fallback never spawns");
            assert_eq!(got.to_string(), expected);
        }
        // An Ok probe with no per-host truth still defers to the fallback.
        assert!(
            gh_host_auth_from_result(Ok(GhJsonProbe::UnknownFlag), "github.com")
                .unwrap()
                .is_none()
        );
        let healthy = gh_host_auth_from_result(
            Ok(GhJsonProbe::Parsed(one_account("success", None))),
            "github.com",
        )
        .unwrap()
        .expect("github.com is in the map");
        assert!(healthy.authenticated);
    }

    #[test]
    fn host_auth_is_unknown_on_an_inconclusive_probe() {
        let probe = GhJsonProbe::Inconclusive(Some("could not read config".into()));
        assert!(gh_host_auth(&probe, "github.com").unwrap().is_none());
        assert!(gh_host_auth(&GhJsonProbe::Inconclusive(None), "github.com")
            .unwrap()
            .is_none());
    }

    // ── github_health's confirmed-Broken disproof ──
    /// gh's auth probe words a REST secondary 403 like a dead token.
    const GH_TOKEN_INVALID: &str = "The token in keyring is invalid.";

    /// The per-repo reading after the anti-flap re-probe also came back Broken.
    fn confirmed_broken() -> SessionHealth {
        let first = classify_gh_host(&one_account("error", Some(GH_TOKEN_INVALID))["github.com"]);
        assert!(needs_reprobe(first.state));
        let second = classify_gh_host(&one_account("error", Some(GH_TOKEN_INVALID))["github.com"]);
        assert_eq!(second.state, SessionState::Broken);
        second
    }

    fn gh_out(code: i32, stdout: &str) -> crate::github::runner::GhOutput {
        crate::github::runner::GhOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: String::new(),
            code,
        }
    }

    #[test]
    fn disproof_reclassifies_broken_when_rate_limit_succeeds() {
        let exhausted = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1790000000\r\n\r\n{}";
        let health = disprove_broken(confirmed_broken(), true, Ok(gh_out(0, exhausted)));
        assert_eq!(health.state, SessionState::RateLimited);
        assert_eq!(health.reset_at, Some(1_790_000_000));
        assert_eq!(health.login.as_deref(), Some("theBGuy"));
        assert_eq!(
            health.detail, None,
            "the token-invalid wording must not ride along"
        );
        // A secondary limit leaves core quota, so no reset time is claimed.
        let secondary = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 4999\r\nX-Ratelimit-Reset: 1790000000\r\n\r\n{}";
        let health = disprove_broken(confirmed_broken(), true, Ok(gh_out(0, secondary)));
        assert_eq!(health.state, SessionState::RateLimited);
        assert_eq!(health.reset_at, None);
    }

    #[test]
    fn disproof_keeps_broken_when_no_token_was_sent() {
        // rate_limit answers anonymously, so a 200 without a token proves nothing.
        let anonymous = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 60\r\nX-Ratelimit-Remaining: 59\r\nX-Ratelimit-Reset: 1790000000\r\n\r\n{}";
        let health = disprove_broken(confirmed_broken(), false, Ok(gh_out(0, anonymous)));
        assert_eq!(health.state, SessionState::Broken);
        assert_eq!(health.detail.as_deref(), Some(GH_TOKEN_INVALID));
        assert_eq!(health.reset_at, None);
    }

    #[test]
    fn gh_api_reads_pin_the_host_even_for_github_com() {
        // An ambient GH_HOST must never redirect the disproof or the expiry read to
        // another host's token.
        for endpoint in ["rate_limit", "user"] {
            let hostname = |host| {
                let args = gh_api_host_args(endpoint, host);
                assert_eq!(args[..3], ["api", "-i", endpoint]);
                args.windows(2)
                    .find(|w| w[0] == "--hostname")
                    .map(|w| w[1].to_string())
            };
            assert_eq!(hostname("github.com").as_deref(), Some("github.com"));
            assert_eq!(hostname("ghes.example").as_deref(), Some("ghes.example"));
            assert_eq!(
                hostname("ghes.example:8443").as_deref(),
                Some("ghes.example:8443")
            );
            assert_eq!(gh_api_host_args(endpoint, ""), ["api", "-i", endpoint]);
        }
    }

    #[test]
    fn disproof_keeps_broken_when_rate_limit_fails() {
        let revoked = "HTTP/2.0 401 Unauthorized\r\n\r\n{\"message\":\"Bad credentials\"}";
        for probe in [
            Ok(gh_out(1, revoked)),
            Err(AppError::Timeout(15)),
            Err(AppError::GhNotFound),
        ] {
            let health = disprove_broken(confirmed_broken(), true, probe);
            assert_eq!(health.state, SessionState::Broken);
            assert_eq!(health.detail.as_deref(), Some(GH_TOKEN_INVALID));
            assert_eq!(health.reset_at, None);
        }
    }

    // ── github_accounts_health's per-account follow-up ──
    /// Each account's reading in the accounts list, paired with its follow-up.
    fn accounts_follow_ups(json: &str) -> Vec<(SessionHealth, AccountFollowUp)> {
        let map = parse_hosts(json);
        map["github.com"]
            .iter()
            .map(|a| {
                let h = gh_account_health("github.com", a);
                let follow_up = account_follow_up(h.state, a.active);
                (h, follow_up)
            })
            .collect()
    }

    #[test]
    fn accounts_disprove_only_the_active_accounts_broken_reading() {
        let json = format!(
            r#"{{"hosts":{{"github.com":[{{"state":"error","active":false,"login":"alt","error":{e}}},{{"state":"error","active":true,"login":"main","error":{e}}}]}}}}"#,
            e = serde_json::to_string(GH_TOKEN_INVALID).unwrap(),
        );
        let [(alt, alt_follow_up), (main, main_follow_up)] =
            <[_; 2]>::try_from(accounts_follow_ups(&json)).ok().unwrap();
        // The probes would spend main's token, so alt's Broken stands unprobed.
        assert_eq!(alt.state, SessionState::Broken);
        assert_eq!(alt_follow_up, AccountFollowUp::None);
        assert_eq!(main.state, SessionState::Broken);
        assert_eq!(main_follow_up, AccountFollowUp::Disprove);

        let exhausted = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1790000000\r\n\r\n{}";
        let limited = disprove_broken(main.clone(), true, Ok(gh_out(0, exhausted)));
        assert_eq!(limited.state, SessionState::RateLimited);
        assert_eq!(limited.detail, None);
        assert_eq!(limited.reset_at, Some(1_790_000_000));
        let no_token = disprove_broken(main.clone(), false, Ok(gh_out(0, exhausted)));
        assert_eq!(no_token.state, SessionState::Broken);
        let failed = disprove_broken(main, true, Err(AppError::Timeout(15)));
        assert_eq!(failed.state, SessionState::Broken);
    }

    #[test]
    fn accounts_follow_up_is_one_probe_per_active_reading() {
        let json = format!(
            r#"{{"hosts":{{"github.com":[{{"state":"error","active":true,"login":"main","error":{}}}]}}}}"#,
            serde_json::to_string(GH_403_PRIMARY).unwrap(),
        );
        let (limited, follow_up) = accounts_follow_ups(&json).remove(0);
        assert_eq!(limited.state, SessionState::RateLimited);
        assert_eq!(follow_up, AccountFollowUp::ResetTime);

        assert_eq!(
            account_follow_up(SessionState::Healthy, true),
            AccountFollowUp::Expiry
        );
        for state in [
            SessionState::Healthy,
            SessionState::RateLimited,
            SessionState::Broken,
            SessionState::Offline,
        ] {
            assert_eq!(account_follow_up(state, false), AccountFollowUp::None);
        }
        assert_eq!(
            account_follow_up(SessionState::Offline, true),
            AccountFollowUp::None
        );
    }

    #[test]
    fn poller_hosts_map_is_empty_when_no_host_is_known() {
        assert!(gh_hosts_health(&parse_hosts(r#"{"hosts":{}}"#)).is_empty());
    }

    #[test]
    fn session_health_wire_shape_pins_rate_limited() {
        let mut h = SessionHealth::new("github", "github.com", SessionState::RateLimited);
        h.reset_at = Some(1_790_000_000);
        let v = serde_json::to_value(&h).unwrap();
        assert_eq!(v["state"], "rateLimited");
        assert_eq!(v["resetAt"], 1_790_000_000_i64);
        assert!(v.get("reset_at").is_none(), "fields serialize camelCase");
        // Absent reset time: the key is still present, as null (like `expiresAt`).
        let bare = serde_json::to_value(SessionHealth::new(
            "gitlab",
            "gitlab.com",
            SessionState::RateLimited,
        ))
        .unwrap();
        assert_eq!(bare["state"], "rateLimited");
        assert!(bare.get("resetAt").is_some());
        assert_eq!(bare["resetAt"], serde_json::Value::Null);
        assert_eq!(bare["expiresAt"], serde_json::Value::Null);
    }

    // ── rate-limit reset header ──
    #[test]
    fn rate_limit_reset_from_header() {
        let out = "HTTP/2.0 200 OK\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Reset: 1790000000\r\n\r\n{\"resources\":{}}";
        assert_eq!(rate_limit_reset_header(out), Some(1_790_000_000));
        // Lowercase (HTTP/2) spelling, as printed ahead of a failing request.
        let lower = "HTTP/2.0 403 Forbidden\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 1790000123\n\n{\"message\":\"API rate limit exceeded\"}";
        assert_eq!(rate_limit_reset_header(lower), Some(1_790_000_123));
    }

    #[test]
    fn rate_limit_reset_needs_an_exhausted_core_window() {
        // Core quota left means the limit in force is a secondary one or a 429, which
        // this reset doesn't describe.
        let left =
            "HTTP/2.0 200 OK\nx-ratelimit-remaining: 4000\nx-ratelimit-reset: 1790000000\n\n{}";
        assert_eq!(rate_limit_reset_header(left), None);
        let missing = "HTTP/2.0 200 OK\nx-ratelimit-reset: 1790000000\n\n{}";
        assert_eq!(rate_limit_reset_header(missing), None);
        let exhausted =
            "HTTP/2.0 200 OK\nx-ratelimit-reset: 1790000000\nx-ratelimit-remaining: 0\n\n{}";
        assert_eq!(rate_limit_reset_header(exhausted), Some(1_790_000_000));
    }

    #[test]
    fn rate_limit_reset_ignores_the_body() {
        // The body's reset is never read — only the header is authoritative.
        let out = "HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 0\r\nContent-Type: application/json\r\n\r\n{\"rate\":{\"reset\":1790000000}}\nx-ratelimit-reset: 1790000000";
        assert_eq!(rate_limit_reset_header(out), None);
    }

    #[test]
    fn rate_limit_reset_garbage_is_none() {
        assert_eq!(rate_limit_reset_header(""), None);
        for reset in ["soon", "-5", "0", ""] {
            let out = format!("x-ratelimit-remaining: 0\nx-ratelimit-reset: {reset}\n\n");
            assert_eq!(rate_limit_reset_header(&out), None, "{reset:?}");
        }
    }

    #[test]
    fn gh_json_empty_hosts_is_not_connected() {
        let hosts = parse_hosts(r#"{"hosts":{}}"#);
        let accounts = hosts.get("github.com").map(Vec::as_slice).unwrap_or(&[]);
        let health = classify_gh_host(accounts);
        assert_eq!(health.state, SessionState::NotConnected);
    }

    #[test]
    fn gh_json_multi_account_picks_active() {
        let json = r#"{"hosts":{"github.com":[{"state":"success","active":false,"login":"alt"},{"state":"success","active":true,"login":"main"}]}}"#;
        let hosts = parse_hosts(json);
        let health = classify_gh_host(&hosts["github.com"]);
        assert_eq!(health.login.as_deref(), Some("main"));
        assert_eq!(health.active, Some(true));
    }

    // ── expiration header parse ──
    #[test]
    fn expiration_header_present() {
        let body = "HTTP/2.0 200 OK\r\nGitHub-Authentication-Token-Expiration: 2026-08-01 00:00:00 +0000\r\n\r\n{\"login\":\"x\"}";
        assert_eq!(
            expiration_header_value(body).as_deref(),
            Some("2026-08-01 00:00:00 +0000")
        );
    }

    #[test]
    fn expiration_header_absent() {
        let body = "HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo\r\n\r\n{\"login\":\"x\"}";
        assert_eq!(expiration_header_value(body), None);
    }

    #[test]
    fn expiration_header_case_insensitive() {
        let body = "github-authentication-token-expiration: 2026-01-02\n\nbody";
        assert_eq!(expiration_header_value(body).as_deref(), Some("2026-01-02"));
    }

    // ── days_left derivation ──
    #[test]
    fn days_left_from_prefix_basic() {
        // 2026-01-11 is 10 days after 2026-01-01.
        let today = days_from_civil(2026, 1, 1);
        assert_eq!(days_left_from_date_prefix("2026-01-11", today), Some(10));
        // A trailing time is ignored.
        assert_eq!(
            days_left_from_date_prefix("2026-01-11 12:00:00 +0000", today),
            Some(10)
        );
        // A past date is negative.
        assert_eq!(days_left_from_date_prefix("2025-12-31", today), Some(-1));
    }

    #[test]
    fn days_left_garbage_is_none() {
        let today = days_from_civil(2026, 1, 1);
        assert_eq!(days_left_from_date_prefix("not-a-date", today), None);
        assert_eq!(days_left_from_date_prefix("2026/01/11", today), None);
        assert_eq!(days_left_from_date_prefix("2026-13-40", today), None);
        assert_eq!(days_left_from_date_prefix("", today), None);
    }

    #[test]
    fn days_from_civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(2000, 3, 1), 11017);
    }

    // ── glab failure classifier ──
    #[test]
    fn glab_classifier_buckets() {
        assert_eq!(
            classify_glab_failure("x: not logged in to gitlab.com"),
            GlabFailure::NotConnected
        );
        assert_eq!(
            classify_glab_failure("no token found"),
            GlabFailure::NotConnected
        );
        assert_eq!(
            classify_glab_failure("dial tcp: lookup gitlab.com: no such host"),
            GlabFailure::Offline
        );
        assert_eq!(
            classify_glab_failure("connection refused"),
            GlabFailure::Offline
        );
        assert_eq!(
            classify_glab_failure("tls handshake failure"),
            GlabFailure::Offline
        );
        // Unknown text degrades to Broken.
        assert_eq!(
            classify_glab_failure("401 unauthorized: bad credentials"),
            GlabFailure::Broken
        );
        assert_eq!(
            classify_glab_failure("something we've never seen"),
            GlabFailure::Broken
        );
        // SYNTHETIC fixtures: glab's real throttle wording is unmeasured, so these pin
        // the phrases the arm keys on, not a captured glab line. The arm wins over the
        // network-ish words a throttle message may share a line with.
        for throttled in [
            "get https://gitlab.com/api/v4/user: 429 rate limit exceeded",
            "retry later: connection rate limited",
            "get https://gitlab.com/api/v4/user: 429 {message: retry later}",
            "api call failed: too many requests",
            "http 429",
            "status (429)",
        ] {
            assert_eq!(
                classify_glab_failure(throttled),
                GlabFailure::RateLimited,
                "{throttled}"
            );
        }
        // `429` inside a hash, id, or port is not a status code.
        for not_throttled in [
            "token a429f0 rejected: 401 unauthorized",
            "project 14290 not found",
            "dial tcp 10.0.0.1:4290: refused",
        ] {
            assert_ne!(
                classify_glab_failure(not_throttled),
                GlabFailure::RateLimited,
                "{not_throttled}"
            );
        }
    }

    #[test]
    fn glab_proxy_and_server_outage_status_text_is_offline() {
        for outage in [
            // Measured verbatim through a local 502 proxy.
            r#"Post "https://gitlab.com/oauth/token": Bad Gateway"#,
            // SYNTHETIC: the same shape for the sibling statuses.
            r#"Post "https://gitlab.com/oauth/token": Service Unavailable"#,
            r#"Get "https://gitlab.com/api/v4/user": Gateway Timeout"#,
            r#"Get "https://gitlab.com/api/v4/user": Proxy Authentication Required"#,
        ] {
            assert_eq!(
                classify_glab_failure(&outage.to_lowercase()),
                GlabFailure::Offline,
                "{outage}"
            );
        }
        // Negative controls: a revoked session still earns the reconnect prompt, and a
        // status number inside a hostname is not an outage.
        for credential in [
            r#"Post "https://gitlab.com/oauth/token": oauth2: "invalid_grant" "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.""#,
            "x gitlab502.example.com: 401 unauthorized",
            "x gitlab503.example.com: api call failed",
        ] {
            assert_eq!(
                classify_glab_failure(&credential.to_lowercase()),
                GlabFailure::Broken,
                "{credential}"
            );
        }
    }

    #[test]
    fn glab_deadline_exceeded_is_offline_never_broken() {
        // SYNTHETIC fixture: Go's context-budget wording, not a captured glab line. It
        // carries none of the network-ish words, so only its own match keeps it out of
        // Broken.
        for timed_out in [
            "get https://gitlab.com/api/v4/user: context deadline exceeded",
            "Context Deadline Exceeded",
        ] {
            assert_eq!(
                classify_glab_failure(&timed_out.to_lowercase()),
                GlabFailure::Offline,
                "{timed_out}"
            );
        }
    }

    #[test]
    fn glab_rate_limited_detail_comes_from_the_matched_text() {
        // The arm matched stdout here, so the detail must carry it even though stderr
        // holds only the generic trailer.
        let combined =
            "GET https://gitlab.com/api/v4/user: 429 Too Many Requests\nerror: request failed";
        let h = glab_rate_limited("gitlab.com", combined);
        assert_eq!(h.state, SessionState::RateLimited);
        assert_eq!(h.reset_at, None);
        let detail = h.detail.expect("a detail");
        assert!(detail.contains("429 Too Many Requests"), "{detail}");
    }

    #[test]
    fn glab_login_parse() {
        assert_eq!(
            parse_glab_login("✓ Logged in to gitlab.com as octocat (config)"),
            Some("octocat".to_string())
        );
        assert_eq!(
            parse_glab_login("  - Logged in to gitlab.example.com as some_user"),
            Some("some_user".to_string())
        );
        assert_eq!(parse_glab_login("not authenticated"), None);
    }

    // ── code / URL regex against the EXACT live lines ──
    #[test]
    fn one_time_code_from_live_line() {
        let line = "! First copy your one-time code: 3285-B415";
        assert_eq!(find_one_time_code(line).as_deref(), Some("3285-B415"));
    }

    #[test]
    fn one_time_code_rejects_non_matches() {
        assert_eq!(find_one_time_code("no code here"), None);
        // Too short a group.
        assert_eq!(find_one_time_code("one-time code: 32-B4"), None);
    }

    #[test]
    fn url_from_live_line() {
        let line = "Open this URL to continue in your web browser: https://github.com/login/device";
        assert_eq!(
            find_url(line).as_deref(),
            Some("https://github.com/login/device")
        );
    }

    // ── the measured CLI fixtures every arm below is driven with ──

    /// gh 2.94.0, one-time code with a colon.
    const GH_CODE_LINE_COLON: &str = "! First copy your one-time code: 5EF0-8E5F";
    /// gh 2.101.0, which ships `clipboard: enabled` as a config default and drops the
    /// colon from the wording entirely.
    const GH_CODE_LINE_CLIPBOARD: &str = "! One-time code (8155-C4E1) copied to clipboard";
    const GH_URL_LINE: &str =
        "Open this URL to continue in your web browser: https://github.com/login/device";
    const GH_DEVICE_URL: &str = "https://github.com/login/device";
    /// glab 1.105.0's browser-open failure: 405 chars carrying a 377-char authorize
    /// URL. The client-id and code-challenge values are stand-ins at their measured
    /// lengths (64 hex / 43 base64url); every other byte is as captured.
    const GLAB_BROWSER_FAIL_LINE: &str = "Failed opening a browser at https://gitlab.com/oauth/authorize?client_id=41d48f94c9b5e0a7d2f318b64e0cd5a913f7be2d84c06915ab73e2c8d140f6b9&code_challenge=Hs9Qk2Lm4Tz1XbPvR7aYcN0dFgJiKoWu3SeQxZlTyAB&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A7171%2Fauth%2Fredirect&response_type=code&scope=openid+profile+read_user+write_repository+api&state=sK4JTZBSHCVWtNQYXl0TE0fbQZUq1VHXlSvJRBRPsFA";

    #[test]
    fn one_time_code_from_gh_clipboard_wording() {
        // gh ≥ 2.101.0 — the wording that stranded the dialog with no code at all.
        assert_eq!(
            find_one_time_code(GH_CODE_LINE_CLIPBOARD).as_deref(),
            Some("8155-C4E1")
        );
    }

    #[test]
    fn one_time_code_from_gh_colon_wording() {
        assert_eq!(
            find_one_time_code(GH_CODE_LINE_COLON).as_deref(),
            Some("5EF0-8E5F")
        );
    }

    #[test]
    fn one_time_code_rejects_prose_after_the_phrase() {
        // The trim set crosses punctuation, not words: the next TOKEN is the code or
        // there is none.
        assert_eq!(
            find_one_time_code("could not read your one-time code from the clipboard"),
            None
        );
    }

    // ── the emission state machine, driven through the production fold ──

    /// Drive `ReconnectParse` exactly as `handle_reconnect_line` does — sanitize, then
    /// step — and collect what each line emitted. Only the Channel send is left out.
    fn drive(lines: &[&str], host: &str) -> Vec<ReconnectEvent> {
        let mut parse = ReconnectParse::default();
        lines
            .iter()
            .flat_map(|raw| parse.step(raw, &sanitize_line(raw), host))
            .collect()
    }

    fn line_texts(events: &[ReconnectEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|e| match e {
                ReconnectEvent::Line { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn code_events(events: &[ReconnectEvent]) -> Vec<(Option<String>, String)> {
        events
            .iter()
            .filter_map(|e| match e {
                ReconnectEvent::Code { code, url } => Some((code.clone(), url.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn code_then_url_emits_one_code_event_carrying_the_code() {
        // The mainline: gh prints the code line before the URL line.
        let events = drive(&[GH_CODE_LINE_CLIPBOARD, GH_URL_LINE], "github.com");
        let codes = code_events(&events);
        assert_eq!(codes.len(), 1, "one Code event, not a URL-only one first");
        assert_eq!(codes[0].0.as_deref(), Some("8155-C4E1"));
        assert_eq!(codes[0].1, GH_DEVICE_URL);
        // The code line reaches the frontend as progress output; the URL-bearing line
        // is swallowed, its content now rendering as the code + link.
        assert_eq!(
            line_texts(&events),
            vec![GH_CODE_LINE_CLIPBOARD.to_string()]
        );
    }

    #[test]
    fn a_url_alone_emits_a_code_event_with_no_code() {
        let events = drive(
            &["! wording we do not recognise", GH_URL_LINE],
            "github.com",
        );
        let codes = code_events(&events);
        assert_eq!(codes.len(), 1);
        assert_eq!(codes[0].0, None);
        assert_eq!(codes[0].1, GH_DEVICE_URL);
        // With no code parsed the raw output is the primary UI, so the URL-bearing
        // line is NOT swallowed — it is the one that says what the CLI was doing.
        assert_eq!(
            line_texts(&events),
            vec![
                "! wording we do not recognise".to_string(),
                GH_URL_LINE.to_string(),
            ]
        );
    }

    #[test]
    fn a_code_after_a_url_only_emit_upgrades_exactly_once() {
        let events = drive(
            &[
                GH_URL_LINE,
                GH_CODE_LINE_COLON,
                "still waiting",
                GH_URL_LINE,
            ],
            "github.com",
        );
        let codes = code_events(&events);
        assert_eq!(codes.len(), 2, "at most two Code events per flow, ever");
        assert_eq!(codes[0].0, None);
        assert_eq!(codes[1].0.as_deref(), Some("5EF0-8E5F"));
        assert_eq!(codes[1].1, GH_DEVICE_URL);
    }

    #[test]
    fn a_mismatched_host_emits_no_code_event_at_all() {
        // The pin's cost, stated: with no URL for this flow's host there is nothing
        // safe to show or open, so the lines pass through as progress output.
        let events = drive(&[GH_CODE_LINE_COLON, GH_URL_LINE], "ghes.example");
        assert!(code_events(&events).is_empty());
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ReconnectEvent::Line { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn empty_lines_emit_nothing() {
        assert!(drive(&["", "   "], "github.com").is_empty());
    }

    // ── URL extraction: over-cap survival + the host pin ──

    #[test]
    fn an_over_cap_url_reaches_the_event_intact() {
        assert_eq!(GLAB_BROWSER_FAIL_LINE.chars().count(), 405);
        let codes = code_events(&drive(&[GLAB_BROWSER_FAIL_LINE], "gitlab.com"));
        assert_eq!(codes.len(), 1);
        assert_eq!(codes[0].0, None);
        assert_eq!(codes[0].1.chars().count(), 377);
        assert!(
            codes[0]
                .1
                .ends_with("&state=sK4JTZBSHCVWtNQYXl0TE0fbQZUq1VHXlSvJRBRPsFA"),
            "the trailing query params must survive the Line cap"
        );
        // The `Line` text's own 300-char bound is untouched.
        assert_eq!(sanitize_line(GLAB_BROWSER_FAIL_LINE).chars().count(), 300);
    }

    /// Drives the production call site, not just the fold: `drive()` shares
    /// `ReconnectParse::step` but passes `raw` itself, so only this pins that
    /// `handle_reconnect_line` hands URL extraction the UNTRUNCATED line.
    #[test]
    fn the_line_handler_sends_the_untruncated_url() {
        use tauri::ipc::InvokeResponseBody;

        let sent: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&sent);
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(json) = body {
                captured.lock().expect("capture poisoned").push(json);
            }
            Ok(())
        });
        let mut parse = ReconnectParse::default();
        let mut collected = Vec::new();
        assert!(handle_reconnect_line(
            GLAB_BROWSER_FAIL_LINE,
            "gitlab.com",
            &mut parse,
            &mut collected,
            &channel,
        ));

        let wire = sent.lock().expect("capture poisoned");
        // The Code event, then the line itself (no code parsed → the output is the UI).
        assert_eq!(wire.len(), 2, "code event then its line");
        let event: serde_json::Value = serde_json::from_str(&wire[0]).unwrap();
        assert_eq!(event["type"], "code");
        let url = event["url"].as_str().expect("a url on the wire");
        assert_eq!(url.chars().count(), 377);
        assert!(url.ends_with("&state=sK4JTZBSHCVWtNQYXl0TE0fbQZUq1VHXlSvJRBRPsFA"));
    }

    #[test]
    fn a_url_off_the_flows_host_is_not_extracted() {
        assert_eq!(find_flow_url(GLAB_BROWSER_FAIL_LINE, "example.com"), None);
        // A docs link in an error message must never become the auto-opened URL.
        assert_eq!(
            find_flow_url("see https://cli.github.com/manual for help", "github.com"),
            None
        );
        // A ported instance matches on its full authority, and the compare is
        // ASCII-case-insensitive.
        assert_eq!(
            find_flow_url(
                "go to https://GHES.example:8443/login/device",
                "ghes.example:8443"
            )
            .as_deref(),
            Some("https://GHES.example:8443/login/device")
        );
        // A host registered with the scheme's default port is the same host the CLI
        // prints portless — either spelling, both directions.
        assert_eq!(
            find_flow_url(
                "go to https://ghes.example/login/device",
                "ghes.example:443"
            )
            .as_deref(),
            Some("https://ghes.example/login/device")
        );
        assert_eq!(
            find_flow_url(
                "go to https://ghes.example:443/login/device",
                "ghes.example"
            )
            .as_deref(),
            Some("https://ghes.example:443/login/device")
        );
        // The elision is that ONE port, not any-port-matches.
        assert_eq!(
            find_flow_url(
                "go to https://ghes.example:8443/login/device",
                "ghes.example"
            ),
            None
        );
        assert_eq!(
            find_flow_url(
                "go to https://ghes.example/login/device",
                "ghes.example:8443"
            ),
            None
        );
        // http has its own default, and https must not elide it.
        assert_eq!(
            find_flow_url("go to http://ghes.example:80/login/device", "ghes.example").as_deref(),
            Some("http://ghes.example:80/login/device")
        );
        assert_eq!(
            find_flow_url("go to https://ghes.example:80/login/device", "ghes.example"),
            None
        );
    }

    #[test]
    fn trailing_prose_punctuation_is_trimmed_off_the_url() {
        // The trimmed URL is what gets opened without a click, so a sentence-ending
        // period must not ride along.
        assert_eq!(
            find_flow_url("open https://github.com/login/device. now", "github.com").as_deref(),
            Some(GH_DEVICE_URL)
        );
        assert_eq!(
            find_flow_url("(see https://github.com/login/device).", "github.com").as_deref(),
            Some(GH_DEVICE_URL)
        );
    }

    #[test]
    fn a_credential_embedding_authority_is_refused() {
        assert_eq!(
            find_flow_url(
                "open https://github.com@evil.example/login/device",
                "github.com"
            ),
            None
        );
    }

    #[test]
    fn an_absurdly_long_url_is_refused_not_truncated() {
        let line = format!(
            "go to https://github.com/login/device?q={}",
            "x".repeat(2048)
        );
        assert_eq!(find_flow_url(&line, "github.com"), None);
    }

    #[test]
    fn an_empty_authority_is_refused() {
        // `find_url` only requires something after the scheme, so `https:///x` reaches
        // here with nothing to compare against the host.
        assert_eq!(find_flow_url("see https:///x now", "github.com"), None);
    }

    #[test]
    fn a_url_with_redaction_spliced_in_is_refused() {
        // Redaction lands inside the URL → the link is dead; offering to open it is
        // worse than offering nothing.
        let line = "open https://github.com/login/device?t=ghp_SECRETTOKEN0000 now";
        assert!(redact_tokens(line).contains("[redacted]"));
        assert_eq!(find_flow_url(line, "github.com"), None);
    }

    #[test]
    fn code_event_serializes_a_null_code() {
        // An omitted key reads as `undefined` on the TS side, which the dialog's
        // `code === null` check would miss.
        let v = serde_json::to_value(ReconnectEvent::Code {
            code: None,
            url: GH_DEVICE_URL.to_string(),
        })
        .unwrap();
        assert_eq!(v["type"], "code");
        assert!(v.get("code").is_some(), "the `code` key must be present");
        assert_eq!(v["code"], serde_json::Value::Null);
        assert_eq!(v["url"], GH_DEVICE_URL);
        let parsed = serde_json::to_value(ReconnectEvent::Code {
            code: Some("8155-C4E1".to_string()),
            url: GH_DEVICE_URL.to_string(),
        })
        .unwrap();
        assert_eq!(parsed["code"], "8155-C4E1");
    }

    // ── token redaction ──
    #[test]
    fn redact_all_token_prefixes() {
        assert_eq!(
            redact_tokens("token gho_ABCDEF1234567890 done"),
            "token [redacted] done"
        );
        assert_eq!(redact_tokens("ghp_deadBEEF00"), "[redacted]");
        assert_eq!(
            redact_tokens("using github_pat_11ABCDE_secretpart here"),
            "using [redacted] here"
        );
        assert_eq!(redact_tokens("glpat-xxxxxYYYYY"), "[redacted]");
        // No token → unchanged.
        assert_eq!(redact_tokens("plain harmless line"), "plain harmless line");
    }

    #[test]
    fn sanitize_line_truncates_to_300() {
        let long = "a".repeat(500);
        let out = sanitize_line(&long);
        assert_eq!(out.chars().count(), 300);
    }

    #[test]
    fn sanitize_line_redacts_before_truncating() {
        let line = "prefix gho_SECRETTOKEN suffix";
        let out = sanitize_line(line);
        assert!(!out.contains("gho_"));
        assert!(out.contains("[redacted]"));
    }

    // ── login parse from reconnect output ──
    #[test]
    fn reconnect_login_parse() {
        let lines = vec![
            "some noise".to_string(),
            "✓ Logged in as theBGuy".to_string(),
        ];
        assert_eq!(parse_reconnect_login(&lines).as_deref(), Some("theBGuy"));
    }

    // ── cancel-before-register race ──
    #[tokio::test]
    async fn cancel_before_register_delivers_permit() {
        // A unique id so this test can't collide with the shared global registry.
        let id = "race-test-cancel-before-register-0001";
        // Cancel FIRST, before any registration — the StrictMode double-mount /
        // fast-Esc race that orphaned the child live.
        cancel_reconnect(id);
        // The flow must ADOPT the cancel's tombstone (and its permit), not replace it.
        let notify = register_reconnect(id);
        // A zero-duration timeout still resolves ⇒ the permit was waiting.
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(
            got.is_ok(),
            "the cancel permit must be waiting for the later-registering flow"
        );
        // Cleanup (mirrors the guard's Drop).
        unregister_reconnect(id);
    }

    #[tokio::test]
    async fn register_then_cancel_delivers_permit() {
        // The ordinary order: register, then cancel — the permit is delivered too.
        let id = "race-test-register-then-cancel-0002";
        let notify = register_reconnect(id);
        cancel_reconnect(id);
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(got.is_ok(), "a post-register cancel must still deliver");
        unregister_reconnect(id);
    }

    // ── gh --json non-zero classification ──
    #[test]
    fn gh_json_nonzero_unknown_flag_is_unknown_flag() {
        // Old gh rejects `--json` on `auth status` → text fallback.
        assert!(matches!(
            classify_gh_json_nonzero(1, "unknown flag: --json"),
            GhJsonProbe::UnknownFlag
        ));
        // Case-insensitive.
        assert!(matches!(
            classify_gh_json_nonzero(2, "Error: Unknown Flag --json"),
            GhJsonProbe::UnknownFlag
        ));
    }

    #[test]
    fn gh_json_nonzero_other_is_inconclusive() {
        // Any other non-zero → Inconclusive with the sanitized detail (→ Offline).
        match classify_gh_json_nonzero(1, "could not connect to keyring service") {
            GhJsonProbe::Inconclusive(Some(detail)) => {
                assert_eq!(detail, "could not connect to keyring service");
            }
            _ => panic!("expected Inconclusive(Some), got a different variant"),
        }
        // Empty stderr → Inconclusive(None).
        assert!(matches!(
            classify_gh_json_nonzero(1, "   "),
            GhJsonProbe::Inconclusive(None)
        ));
    }

    // ── sanitize_detail bound ──
    #[test]
    fn sanitize_detail_caps_at_300() {
        let long = "a".repeat(500);
        assert_eq!(sanitize_detail(&long).chars().count(), 300);
        // Still redacts + collapses newlines within the bound.
        let with_token = format!("line1\nghp_SECRETTOKEN {}", "b".repeat(400));
        let out = sanitize_detail(&with_token);
        assert!(!out.contains("ghp_"));
        assert!(out.contains("[redacted]"));
        assert!(!out.contains('\n'));
        assert_eq!(out.chars().count(), 300);
    }

    // ── detail register ──

    /// The oauth2 description GitLab (Doorkeeper) returns for a dead grant.
    const GLAB_GRANT_DESCRIPTION: &str = "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.";

    fn assert_detail_register(detail: &str) {
        assert!(
            detail.matches('"').count() % 2 == 0,
            "unbalanced quote: {detail}"
        );
        assert!(!detail.contains('\n'), "{detail}");
        for framing in [
            "✓",
            "API call failed",
            "oauth2",
            "gitlab.com:",
            "invalid_grant",
        ] {
            assert!(!detail.contains(framing), "{framing} survived: {detail}");
        }
        assert!(!detail.starts_with("x "), "{detail}");
    }

    #[test]
    fn glab_grant_failure_reads_as_the_forge_sentence() {
        // Drive-measured chip text: the host header, a status glyph, the host prefix,
        // and two wrappers run together ahead of the quoted oauth2 pair.
        let measured = format!(
            r#"gitlab.com x gitlab.com: API call failed: oauth2: "invalid_grant" "{GLAB_GRANT_DESCRIPTION}""#
        );
        // A live `glab auth status --hostname gitlab.com` stderr (exit 1): success
        // lines, then a styled ERROR banner and a host-wide summary, both padded with
        // trailing spaces by glab's terminal styling.
        let pad = " ".repeat(40);
        let captured = [
            "gitlab.com".to_string(),
            format!(
                r#"  x gitlab.com: API call failed: oauth2: "invalid_grant" "{GLAB_GRANT_DESCRIPTION}""#
            ),
            "  ✓ Git operations for gitlab.com configured to use https protocol.".to_string(),
            "  ✓ API calls for gitlab.com are made over https protocol.".to_string(),
            "  ✓ REST API Endpoint: https://gitlab.com/api/v4/".to_string(),
            "  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/".to_string(),
            "  ✓ Token found: **************************".to_string(),
            String::new(),
            format!("   ERROR{pad}"),
            String::new(),
            format!(
                "  X could not authenticate to one or more of the configured GitLab instances.{pad}"
            ),
            String::new(),
        ]
        .join("\n");
        for raw in [measured.as_str(), captured.as_str()] {
            let detail = glab_broken_detail(raw).expect("a detail");
            assert_detail_register(&detail);
            assert_eq!(detail, GLAB_GRANT_DESCRIPTION);
        }
    }

    #[test]
    fn glab_aggregate_lines_stand_when_nothing_specific_remains() {
        let raw = "   ERROR   \n\n  X could not authenticate to one or more of the configured GitLab instances.  \n";
        assert_eq!(
            glab_broken_detail(raw).as_deref(),
            Some("could not authenticate to one or more of the configured GitLab instances.")
        );
    }

    #[test]
    fn glab_detail_cut_upstream_keeps_the_sentence_without_its_quote() {
        // A detail cut at 200 chars inside the quoted description.
        let cut: String = format!(
            r#"gitlab.com x gitlab.com: API call failed: oauth2: "invalid_grant" "{GLAB_GRANT_DESCRIPTION}""#
        )
        .chars()
        .take(200)
        .collect();
        let detail = glab_broken_detail(&cut).expect("a detail");
        assert_detail_register(&detail);
        assert!(
            detail.starts_with("The provided authorization grant is invalid, expired"),
            "{detail}"
        );
    }

    #[test]
    fn over_cap_detail_cuts_at_a_word_and_never_leaves_an_open_quote() {
        let raw = format!(r#"request rejected: "{}""#, "denied again ".repeat(30));
        let detail = normalize_detail(&raw, 60);
        assert!(detail.chars().count() <= 60, "{detail}");
        assert!(detail.ends_with('…'), "{detail}");
        assert!(detail.matches('"').count() % 2 == 0, "{detail}");
        // A word boundary, not a mid-word cut.
        let body = detail.trim_end_matches('…');
        assert!(
            body.ends_with("again") || body.ends_with("denied"),
            "{detail}"
        );
    }

    #[test]
    fn gh_details_keep_their_single_line_messages() {
        // The `--json` probe exits non-zero only on an environmental failure, whose
        // stderr is one line plus gh's trailing newline.
        let config = r"failed to read configuration: open C:\Users\me\AppData\Roaming\GitHub CLI\config.yml: Access is denied.";
        match classify_gh_json_nonzero(1, &format!("{config}\n")) {
            GhJsonProbe::Inconclusive(Some(detail)) => {
                assert_detail_register(&detail);
                assert_eq!(detail, config);
            }
            _ => panic!("expected Inconclusive(Some), got a different variant"),
        }
        // A Broken account's reason is its `error` field, already the forge's words.
        let map = one_account("error", Some(GH_TOKEN_INVALID));
        for (health, _) in classify_both(&map) {
            assert_eq!(health.detail.as_deref(), Some(GH_TOKEN_INVALID));
        }
        assert_eq!(sanitize_detail(GH_401), GH_401);
    }

    #[test]
    fn only_announced_hosts_lose_their_prefix() {
        // A dotted file name is not a host the output named, so it keeps its place.
        for raw in [
            "config.yml: permission denied",
            "hosts.yml: permission denied",
        ] {
            assert_eq!(sanitize_detail(raw), raw);
        }
        // A host the output announced as a header still loses its prefix.
        assert_eq!(
            sanitize_detail("gitlab.com\n  x gitlab.com: token expired"),
            "token expired"
        );
        // The match ignores case and takes a `:port` as part of the host.
        assert_eq!(
            sanitize_detail("GHES.Example:8443\n  x ghes.example:8443: token expired"),
            "token expired"
        );
    }

    // ── tombstone sweep ──
    #[test]
    fn sweep_removes_unadopted_tombstone() {
        // A cancel for an id nothing registered creates a tombstone (map-only Arc).
        let id = "sweep-test-unadopted-tombstone-000001";
        cancel_reconnect(id);
        assert!(RECONNECT_REGISTRY.lock().unwrap().contains_key(id));
        // Unadopted (strong_count == 1 under the lock) → the sweep reclaims it.
        sweep_unadopted_tombstone(id);
        assert!(!RECONNECT_REGISTRY.lock().unwrap().contains_key(id));
    }

    #[test]
    fn sweep_spares_adopted_entry() {
        // A flow registered (adopted) the entry — it holds a clone of the Arc, so the
        // sweep must be a no-op while that clone lives.
        let id = "sweep-test-adopted-entry-000002";
        let held = register_reconnect(id); // the flow's guard would hold this clone
        assert!(RECONNECT_REGISTRY.lock().unwrap().contains_key(id));
        sweep_unadopted_tombstone(id);
        // Still present — strong_count > 1 (map + `held`).
        assert!(RECONNECT_REGISTRY.lock().unwrap().contains_key(id));
        // Once the flow's clone drops, the entry is a bare tombstone again and can be
        // swept (mirrors the guard's own Drop, which unregisters directly).
        drop(held);
        sweep_unadopted_tombstone(id);
        assert!(!RECONNECT_REGISTRY.lock().unwrap().contains_key(id));
    }

    // ── session id validation ──
    #[test]
    fn session_id_grammar() {
        assert!(valid_session_id("550e8400-e29b-41d4-a716-446655440000"));
        assert!(valid_session_id("abcdefgh")); // exactly 8
        assert!(!valid_session_id("short")); // < 8
        assert!(!valid_session_id("has space in it here")); // space
        assert!(!valid_session_id(&"a".repeat(65))); // > 64
    }

    // ── reconnect argv seam ──
    fn args_of(provider: &str, mode: &str, scopes: &[&str]) -> Vec<String> {
        let scopes: Vec<String> = scopes.iter().map(|s| (*s).to_string()).collect();
        reconnect_args(provider, mode, "github.com", &scopes).unwrap()
    }

    #[test]
    fn reconnect_args_per_provider_and_mode() {
        assert_eq!(
            args_of("github", "refresh", &[]),
            ["auth", "refresh", "--hostname", "github.com"]
        );
        assert_eq!(
            args_of("github", "login", &[]),
            [
                "auth",
                "login",
                "--hostname",
                "github.com",
                "--web",
                "--skip-ssh-key",
                "--git-protocol",
                "https"
            ]
        );
        // glab has no refresh — both modes are the same `--web` login.
        for mode in ["login", "refresh"] {
            assert_eq!(
                args_of("gitlab", mode, &[]),
                ["auth", "login", "--hostname", "github.com", "--web"]
            );
        }
    }

    #[test]
    fn reconnect_args_emit_repeated_scope_flags() {
        assert_eq!(
            args_of("github", "refresh", &["admin:repo_hook", "delete_repo"]),
            [
                "auth",
                "refresh",
                "--hostname",
                "github.com",
                "-s",
                "admin:repo_hook",
                "-s",
                "delete_repo"
            ]
        );
    }

    #[test]
    fn reconnect_args_reject_scopes_off_the_github_refresh_arm() {
        let scopes = vec!["repo".to_string()];
        // Refused, never silently dropped — a dropped scope hands back a session
        // still missing it.
        assert!(reconnect_args("github", "login", "github.com", &scopes).is_err());
        assert!(reconnect_args("gitlab", "login", "gitlab.com", &scopes).is_err());
        assert!(reconnect_args("gitlab", "refresh", "gitlab.com", &scopes).is_err());
    }

    #[test]
    fn reconnect_args_reject_malformed_scopes() {
        let bad = [
            "Repo",           // uppercase
            "read-org",       // dash
            "repo workflow",  // space
            "",               // empty
            "repo;rm -rf /",  // shell-ish
            "--reset-scopes", // a flag posing as a scope
        ];
        for scope in bad {
            assert!(
                reconnect_args("github", "refresh", "github.com", &[scope.to_string()]).is_err(),
                "scope should be refused: {scope:?}"
            );
        }
        let too_many: Vec<String> = (0..MAX_RECONNECT_SCOPES + 1)
            .map(|i| format!("scope{i}"))
            .collect();
        assert!(reconnect_args("github", "refresh", "github.com", &too_many).is_err());
        let at_cap = &too_many[..MAX_RECONNECT_SCOPES];
        assert!(reconnect_args("github", "refresh", "github.com", at_cap).is_ok());
    }

    #[test]
    fn reconnect_args_reject_unsupported_providers() {
        assert!(reconnect_args("bitbucket", "login", "bitbucket.org", &[]).is_err());
        assert!(reconnect_args("codeberg", "login", "codeberg.org", &[]).is_err());
    }

    #[test]
    fn reconnect_host_grammar_allows_a_numeric_port_only() {
        assert!(valid_reconnect_host("github.com"));
        assert!(valid_reconnect_host("gitlab.example-corp.com"));
        // A ported instance registers with gh/glab under `host:port`, so the reconnect
        // flow must accept the same spelling the health check reports.
        assert!(valid_reconnect_host("gitlab.example.com:8443"));
        // A bracketed IPv6 literal is what the health check reports for such a remote.
        assert!(valid_reconnect_host("[2001:db8::1]:8443"));
        assert!(!valid_reconnect_host("[::1")); // unterminated bracket
        assert!(!valid_reconnect_host("")); // empty
        assert!(!valid_reconnect_host("gitlab.example.com:8443x")); // not a port
        assert!(!valid_reconnect_host("https://gitlab.example.com")); // scheme
        assert!(!valid_reconnect_host("gitlab.example.com/path")); // path
        assert!(!valid_reconnect_host("host --flag")); // argv injection
    }
}
