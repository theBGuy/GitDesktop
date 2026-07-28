//! Forge session health — anti-flap classification of each hosted-git session (per
//! repo and per account), plus a cancellable `gh`/`glab` re-auth child driver.
//!
//! Anti-flap is load-bearing: a transiently-failing keyring/API makes `gh auth status`
//! report "token invalid" for a minute and then heal, so a `gh` `timeout` state is
//! NEVER Broken and a `gh` `error` must be confirmed by a second probe (~1.5s later);
//! the GitLab arm mirrors that. No probe reads a credential value, and the reconnect
//! driver truncates + redacts every line it forwards.

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
    /// A short human reason for broken/offline — NEVER token material.
    pub detail: Option<String>,
    /// `"oauth"` | `"pat"` | `"token"` | `None`.
    pub method: Option<String>,
    pub expires_at: Option<String>,
    pub days_left: Option<i64>,
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
        }
    }
}

/// A streamed event from a reconnect child. `Code` carries the device-flow one-time
/// code + URL (emitted once); `Line` is any other sanitized output line; `Finished`
/// is terminal.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ReconnectEvent {
    Code {
        code: String,
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
/// `github.com`. Deliberately no `gh repo view` — that's a network round-trip this
/// cheap health check must avoid; the origin host is enough to scope `gh auth status`.
async fn github_host_for_repo(repo_path: &str) -> String {
    match crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await {
        Ok(url) => crate::forge::remote_host(&url).unwrap_or_else(|| "github.com".to_string()),
        Err(_) => "github.com".to_string(),
    }
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
    /// Any other non-zero exit (fatal/environmental) → Offline, with a sanitized detail.
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

/// Classify the account list for one host into a state (no re-probe here — the
/// caller owns the anti-flap re-probe). Picks the active account, else the first.
fn classify_gh_host(accounts: &[GhJsonAccount]) -> SessionHealth {
    // The `host` field is filled by the caller; this pure classifier leaves it "".
    let chosen = accounts
        .iter()
        .find(|a| a.active)
        .or_else(|| accounts.first());
    let Some(acct) = chosen else {
        // No entries for this host → not connected.
        return SessionHealth::new("github", "", SessionState::NotConnected);
    };
    let state = match acct.state.as_str() {
        "success" => SessionState::Healthy,
        // A transient failure — the caller confirms with a re-probe before Broken.
        "error" => SessionState::Broken,
        // Never Broken: an inconclusive probe.
        "timeout" => SessionState::Offline,
        // Unknown/empty state → treat as inconclusive, never a false alarm.
        _ => SessionState::Offline,
    };
    let mut h = SessionHealth::new("github", "", state);
    h.login = acct.login.clone().filter(|s| !s.is_empty());
    h.active = Some(acct.active);
    if matches!(state, SessionState::Broken | SessionState::Offline) {
        h.detail = acct
            .error
            .as_ref()
            .map(|e| sanitize_detail(e))
            .filter(|s| !s.is_empty());
    }
    h
}

/// Per-repo GitHub health for `host`, with the anti-flap re-probe on `error`.
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
    if health.state == SessionState::Broken {
        tokio::time::sleep(REPROBE_DELAY).await;
        if let Ok(GhJsonProbe::Parsed(map2)) = gh_status_json(Some(host)).await {
            let accounts2 = map2.get(host).map(Vec::as_slice).unwrap_or(&[]);
            let mut health2 = classify_gh_host(accounts2);
            health2.host = host.to_string();
            health = health2;
        }
        // A failed re-probe (Err/None) leaves the first Broken standing — the
        // credential really was rejected and we couldn't disprove it.
    }

    if health.state == SessionState::Healthy {
        apply_gh_expiry(&mut health, host).await;
    }
    health
}

/// Degraded GitHub health via plain `gh auth status` (old gh without `--json`). Exit
/// 0 → Healthy (login via `parse_auth_accounts`); non-zero with no parsed accounts →
/// NotConnected; non-zero with accounts → Broken. No Offline detection is possible
/// here — plain text can't distinguish a transient failure from a real one.
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
    let accounts = crate::github::pr::parse_auth_accounts(&report);
    // Prefer the account matching this host, else any.
    let acct = accounts
        .iter()
        .find(|a| a.host == host_str)
        .or_else(|| accounts.first());
    if out.code == 0 {
        let mut h = SessionHealth::new("github", host_str, SessionState::Healthy);
        h.login = acct.map(|a| a.login.clone());
        h.active = acct.map(|a| a.active);
        h
    } else if accounts.is_empty() {
        SessionHealth::new("github", host_str, SessionState::NotConnected)
    } else {
        let mut h = SessionHealth::new("github", host_str, SessionState::Broken);
        h.login = acct.map(|a| a.login.clone());
        h.active = acct.map(|a| a.active);
        h
    }
}

/// Account-scoped GitHub health — one entry PER account across all hosts. Uses ONE
/// shared re-probe (not per account) when any account reports `error`.
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

    let any_error = map.values().flatten().any(|a| a.state.as_str() == "error");
    // ONE shared re-probe when anything looked transiently broken.
    let map = if any_error {
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
            let state = match acct.state.as_str() {
                "success" => SessionState::Healthy,
                "error" => SessionState::Broken,
                "timeout" => SessionState::Offline,
                _ => SessionState::Offline,
            };
            let mut h = SessionHealth::new("github", host.clone(), state);
            h.login = acct.login.clone().filter(|s| !s.is_empty());
            h.active = Some(acct.active);
            if matches!(state, SessionState::Broken | SessionState::Offline) {
                h.detail = acct
                    .error
                    .as_ref()
                    .map(|e| sanitize_detail(e))
                    .filter(|s| !s.is_empty());
            }
            // Expiry only for the active Healthy account on this host.
            if state == SessionState::Healthy && acct.active {
                apply_gh_expiry(&mut h, host).await;
            }
            out.push(h);
        }
    }
    out
}

/// Fill `method`/`expires_at`/`days_left` for a Healthy gh session by scanning the
/// `GitHub-Authentication-Token-Expiration` response header of `gh api -i user`. The
/// header appears only for PAT-backed sessions (absent for OAuth — the common case),
/// and is known-buggy for fine-grained PATs, so absence/garbage is tolerated and
/// never flips the already-decided Healthy state.
async fn apply_gh_expiry(health: &mut SessionHealth, host: &str) {
    let mut args: Vec<&str> = vec!["api", "-i", "user"];
    if !host.is_empty() && host != "github.com" {
        args.push("--hostname");
        args.push(host);
    }
    let Ok(out) = run_gh_raw(None, &args, GH_TIMEOUT).await else {
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
/// `gh api -i` response (headers precede the JSON body, ending at the first blank
/// line — same idiom as `github::auth::gh_token_scopes`). Case-insensitive.
fn expiration_header_value(body: &str) -> Option<String> {
    for line in body.lines() {
        if line.trim().is_empty() {
            break; // end of headers.
        }
        if let Some((name, value)) = line.split_once(':') {
            if name
                .trim()
                .eq_ignore_ascii_case("github-authentication-token-expiration")
            {
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
enum GlabFailure {
    NotConnected,
    Offline,
    /// Neither clearly not-connected nor network-ish → needs the confirming re-probe;
    /// still failing → Broken with the carried detail.
    Broken,
}

/// Classify combined lowercased stdout+stderr from a failed `glab auth status`.
/// Unknown text degrades to `Broken` (never a panic) so an unrecognized glab message
/// still surfaces as an actionable "reconnect" rather than being swallowed.
fn classify_glab_failure(combined_lower: &str) -> GlabFailure {
    const NOT_CONNECTED: [&str; 4] = ["not logged in", "no token", "no accounts", "no hosts"];
    const NETWORKISH: [&str; 6] = ["timeout", "connection", "dial", "lookup", "network", "tls"];
    if NOT_CONNECTED.iter().any(|n| combined_lower.contains(n)) {
        GlabFailure::NotConnected
    } else if NETWORKISH.iter().any(|n| combined_lower.contains(n)) {
        GlabFailure::Offline
    } else {
        GlabFailure::Broken
    }
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
    let combined = format!("{}\n{}", out.stdout_lossy(), out.stderr).to_lowercase();
    match classify_glab_failure(&combined) {
        GlabFailure::NotConnected => SessionHealth::new("gitlab", host, SessionState::NotConnected),
        GlabFailure::Offline => SessionHealth::new("gitlab", host, SessionState::Offline),
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
                    let combined2 = format!("{}\n{}", o2.stdout_lossy(), o2.stderr).to_lowercase();
                    match classify_glab_failure(&combined2) {
                        GlabFailure::NotConnected => {
                            SessionHealth::new("gitlab", host, SessionState::NotConnected)
                        }
                        GlabFailure::Offline => {
                            SessionHealth::new("gitlab", host, SessionState::Offline)
                        }
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

/// A ≤200-char, sanitized detail from glab stderr for a Broken session.
fn glab_broken_detail(stderr: &str) -> Option<String> {
    let msg = stderr.trim();
    if msg.is_empty() {
        return None;
    }
    let sanitized = sanitize_detail(msg);
    let trimmed: String = sanitized.chars().take(200).collect();
    (!trimmed.is_empty()).then_some(trimmed)
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

/// A cancellable `gh`/`glab` re-auth driver. Spawns the device-flow login/refresh
/// child, streams its stdout+stderr as sanitized `ReconnectEvent`s, and resolves when
/// the child exits or is cancelled. `session_id` is a frontend uuid; `mode` is
/// `"login"` | `"refresh"`; `provider` is `github` | `gitlab` (Bitbucket has no CLI
/// reconnect — it errors).
#[tauri::command]
pub async fn forge_reconnect(
    session_id: String,
    provider: String,
    host: String,
    mode: String,
    on_event: Channel<ReconnectEvent>,
) -> AppResult<()> {
    // ── Validate every input before spawning anything ──
    if !valid_session_id(&session_id) {
        return Err(AppError::InvalidArgument("invalid session id".into()));
    }
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(AppError::InvalidArgument(format!("invalid host: {host}")));
    }
    if !matches!(mode.as_str(), "login" | "refresh") {
        return Err(AppError::InvalidArgument(format!("invalid mode: {mode}")));
    }

    // Register BEFORE the async resolve+spawn so a cancel racing ahead of them is
    // captured (see `register_reconnect`). The guard unregisters on every exit path
    // below, including the resolve/spawn error returns.
    let guard = ReconnectGuard {
        session_id: session_id.clone(),
        notify: register_reconnect(&session_id),
    };

    let (bin_names, args): (&[&str], Vec<String>) = match provider.as_str() {
        "github" => {
            let args = match mode.as_str() {
                "refresh" => vec![
                    "auth".to_string(),
                    "refresh".to_string(),
                    "--hostname".to_string(),
                    host.clone(),
                ],
                // login
                _ => vec![
                    "auth".to_string(),
                    "login".to_string(),
                    "--hostname".to_string(),
                    host.clone(),
                    "--web".to_string(),
                    "--skip-ssh-key".to_string(),
                    "--git-protocol".to_string(),
                    "https".to_string(),
                ],
            };
            (&["gh"], args)
        }
        "gitlab" => (
            &["glab"],
            vec![
                "auth".to_string(),
                "login".to_string(),
                "--hostname".to_string(),
                host.clone(),
                "--web".to_string(),
            ],
        ),
        "bitbucket" => {
            return Err(AppError::InvalidArgument(
                "Reconnect Bitbucket in Settings → Accounts.".into(),
            ))
        }
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown provider: {other}"
            )))
        }
    };
    let is_github = provider == "github";

    let Some(binary) = crate::agent::resolve_named(bin_names, None).await else {
        return Err(if is_github {
            AppError::GhNotFound
        } else {
            AppError::GlabNotFound
        });
    };

    // The driver waits on the guard's `Notify` (which may already carry a cancel
    // permit). The guard lives across this await and unregisters on return.
    run_reconnect_child(guard.notify.clone(), &binary, &args, is_github, &on_event).await
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
/// one-time code can land on either), sanitizes every line, and emits at most one
/// `Code` event. Registry cleanup is the caller's `ReconnectGuard`, not this fn.
async fn run_reconnect_child(
    cancel: Arc<Notify>,
    binary: &PathBuf,
    args: &[String],
    is_github: bool,
    on_event: &Channel<ReconnectEvent>,
) -> AppResult<()> {
    let mut cmd = Command::new(binary);
    cmd.args(args.iter().map(String::as_str));
    // Non-interactive + quiet. Deliberately no GH_PROMPT_DISABLED — stdin-null
    // suffices and that env var's effect on the web flow is unvalidated.
    cmd.env("NO_COLOR", "1").env("CLICOLOR", "0");
    if is_github {
        cmd.env("GH_NO_UPDATE_NOTIFIER", "1");
    } else {
        cmd.env("GLAB_PAGER", "").env("PAGER", "");
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

    let mut code_emitted = false;
    let mut collected: Vec<String> = Vec::new();
    let mut last_code: Option<String> = None;
    let mut last_url: Option<String> = None;
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
                            &l, &mut code_emitted, &mut last_code, &mut last_url,
                            &mut collected, on_event,
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
                            &l, &mut code_emitted, &mut last_code, &mut last_url,
                            &mut collected, on_event,
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

/// Process one raw output line: sanitize it, try to emit a single `Code` event once
/// both code + URL are known, else emit a `Line`. Returns `false` when the channel
/// send failed (frontend gone) so the caller can tear down.
fn handle_reconnect_line(
    raw: &str,
    code_emitted: &mut bool,
    last_code: &mut Option<String>,
    last_url: &mut Option<String>,
    collected: &mut Vec<String>,
    on_event: &Channel<ReconnectEvent>,
) -> bool {
    let clean = sanitize_line(raw);
    collected.push(clean.clone());

    if last_code.is_none() {
        if let Some(c) = find_one_time_code(&clean) {
            *last_code = Some(c);
        }
    }
    if last_url.is_none() {
        if let Some(u) = find_url(&clean) {
            *last_url = Some(u);
        }
    }
    // Emit the Code event ONCE, as soon as both are known.
    if !*code_emitted {
        if let (Some(code), Some(url)) = (last_code.clone(), last_url.clone()) {
            *code_emitted = true;
            return on_event.send(ReconnectEvent::Code { code, url }).is_ok();
        }
    }
    if clean.trim().is_empty() {
        return true;
    }
    on_event.send(ReconnectEvent::Line { text: clean }).is_ok()
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

/// Sanitize a detail/reason string: redact tokens, collapse to one line, cap at 300
/// chars (the same bound as `sanitize_line`).
fn sanitize_detail(raw: &str) -> String {
    let one_line = raw.replace(['\n', '\r'], " ");
    redact_tokens(one_line.trim()).chars().take(300).collect()
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

/// Extract a device one-time code like `3285-B415` from a line matching (case-
/// insensitively) `one-time code:\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})`. Hand-rolled (no
/// regex dep).
fn find_one_time_code(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let idx = lower.find("one-time code:")?;
    let after = &line[idx + "one-time code:".len()..];
    let after = after.trim_start();
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

    #[test]
    fn gh_json_error_is_broken_before_reprobe() {
        let json = r#"{"hosts":{"github.com":[{"state":"error","active":true,"host":"github.com","login":"theBGuy","error":"token invalid"}]}}"#;
        let hosts = parse_hosts(json);
        let health = classify_gh_host(&hosts["github.com"]);
        // The classifier maps error→Broken; the anti-flap re-probe lives in the async
        // caller (never yields Broken without a confirming second probe).
        assert_eq!(health.state, SessionState::Broken);
        assert_eq!(health.detail.as_deref(), Some("token invalid"));
    }

    #[test]
    fn gh_json_timeout_is_offline_never_broken() {
        let json = r#"{"hosts":{"github.com":[{"state":"timeout","active":true,"host":"github.com","error":"context deadline exceeded"}]}}"#;
        let hosts = parse_hosts(json);
        let health = classify_gh_host(&hosts["github.com"]);
        assert_eq!(health.state, SessionState::Offline);
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

    #[test]
    fn code_and_url_emitted_once() {
        // Simulate the two live lines arriving on the stream (code line, then URL line).
        let mut code_emitted = false;
        let mut last_code = None;
        let mut last_url = None;
        let mut collected = Vec::new();
        // We can't build a real Channel here; test the state machine's harvesting
        // directly instead.
        let l1 = "! First copy your one-time code: 3285-B415";
        let clean1 = sanitize_line(l1);
        collected.push(clean1.clone());
        if last_code.is_none() {
            last_code = find_one_time_code(&clean1);
        }
        if last_url.is_none() {
            last_url = find_url(&clean1);
        }
        assert_eq!(last_code.as_deref(), Some("3285-B415"));
        assert!(last_url.is_none());
        let l2 = "Open this URL to continue in your web browser: https://github.com/login/device";
        let clean2 = sanitize_line(l2);
        collected.push(clean2.clone());
        if last_url.is_none() {
            last_url = find_url(&clean2);
        }
        assert_eq!(last_url.as_deref(), Some("https://github.com/login/device"));
        // Both known now → a Code event would fire exactly once.
        assert!(!code_emitted);
        if let (Some(_), Some(_)) = (&last_code, &last_url) {
            code_emitted = true;
        }
        assert!(code_emitted);
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
}
