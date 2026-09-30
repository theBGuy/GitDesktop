//! The Settings → About screen's diagnostics: OS/app info and the status of the
//! external command-line tools several features shell out to (git, gh, glab, and
//! the Claude/Codex agent CLIs). Reuses agent.rs's binary resolver + capture so
//! detection behaves identically to the AI-provider setup (PATH + login-shell
//! fallback, Windows `.cmd` shims, …).

use std::path::Path;

use serde::Serialize;

use crate::agent::{exit_code_auth, resolve_named, run_capture, AuthStatus, DETECT_TIMEOUT};
use crate::error::{AppError, AppResult};
use crate::forge::futures_join_all;
use crate::forge::glab::{account_hostname, account_hosts, is_addressable_host, run_glab_raw};
use crate::forge::session::{
    classify_glab_failure, gh_cli_auth_status, worst_host_auth, GlabFailure,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// OS family name, e.g. "Windows", "Mac OS", "Ubuntu".
    os: String,
    /// OS version string, or "Unknown" when it can't be determined.
    os_version: String,
    /// The build's target architecture, e.g. "x86_64", "aarch64".
    arch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    /// Stable id the frontend maps to a label + install link ("git", "gh", …).
    id: String,
    found: bool,
    path: Option<String>,
    /// First line of `--version`, or null if it didn't report one.
    version: Option<String>,
    /// Login state for tools that have one (git is always `Unknown` = N/A).
    authed: AuthStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealth {
    system: SystemInfo,
    tools: Vec<ToolStatus>,
}

fn system_info() -> SystemInfo {
    let info = os_info::get();
    SystemInfo {
        os: info.os_type().to_string(),
        os_version: info.version().to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// The "we know nothing about this tool" status: it isn't installed, or its
/// probe didn't complete.
fn undetected(id: &str) -> ToolStatus {
    ToolStatus {
        id: id.to_string(),
        found: false,
        path: None,
        version: None,
        authed: AuthStatus::Unknown,
    }
}

/// How one tool's sign-in state is read.
#[derive(Clone, Copy)]
enum AuthProbe {
    /// No login concept, or no non-interactive status command.
    None,
    /// A local status command whose exit code is the whole verdict.
    ExitCode(&'static [&'static str]),
    /// gh's per-account `--json` report, which tells an outage from a rejected token.
    Gh,
    /// `glab auth status` per configured host, each classified as session health's is.
    Glab,
}

/// One host's `glab auth status` verdict. The command validates online, so its
/// failure text decides between a rejected credential and an outage; a probe that
/// timed out is an outage too. The classifier's precedence assumes ONE host's
/// output, so a multi-host report must be split per host before it gets here.
fn glab_auth(result: AppResult<(i32, String)>) -> AuthStatus {
    match result {
        Ok((0, _)) => AuthStatus::Authed,
        Ok((_, output)) => match classify_glab_failure(&output.to_lowercase()) {
            GlabFailure::Offline | GlabFailure::RateLimited => AuthStatus::Unreachable,
            GlabFailure::NotConnected | GlabFailure::Broken => AuthStatus::NotAuthed,
        },
        Err(AppError::Timeout(_)) => AuthStatus::Unreachable,
        Err(_) => AuthStatus::Unknown,
    }
}

/// The glab sign-in probes that cover every account: `--hostname` for each host
/// that flag can address, plus ONE bare probe (the `bool`) when glab's own routing
/// target can't be addressed (a non-default port, which `--hostname` refuses) or
/// nothing else would run. The bare probe follows glab's native routing, so a
/// ported login is checked at its real authority with its own token.
fn glab_probe_plan(hosts: Vec<String>, target: &str) -> (Vec<String>, bool) {
    let pinned: Vec<String> = hosts
        .into_iter()
        .filter(|h| is_addressable_host(h))
        .collect();
    let bare = pinned.is_empty() || !is_addressable_host(target);
    (pinned, bare)
}

/// glab's sign-in across its account hosts, probed concurrently (the load waits on
/// the slowest host, not their sum) and reduced by [`worst_host_auth`], as gh's row
/// is. `account_hosts` rather than `known_hosts`: it drops the port-stripped twin
/// of a ported `GITLAB_HOST` and adds an addressable token target. The bare probe's
/// multi-host report still reads with single-host precedence for the hosts it
/// covers; a pinned host's rejection outranks it either way. Deliberately not
/// `gitlab_accounts_health`: its expiry reads and anti-flap re-probe sleep don't
/// belong in this load.
async fn glab_cli_auth(binary: &Path) -> AuthStatus {
    let (pinned, bare) = glab_probe_plan(account_hosts().await, &account_hostname().await);
    // run_glab_raw strips the environment's token for every host that isn't its
    // own target, so a pinned probe never sends one host's token to another.
    let probes = pinned.iter().map(|host| async move {
        let args = ["auth", "status", "--hostname", host.as_str()];
        let out = run_glab_raw(None, &args, DETECT_TIMEOUT).await;
        glab_auth(out.map(|o| (o.code, format!("{}\n{}", o.stdout_lossy(), o.stderr))))
    });
    // run_capture_parts already applies sanitize_child_env; only token stripping is
    // exempt here. Bare `glab auth status` follows glab's own precedence to the
    // token's target, so this probe cannot address a foreign host.
    let bare_probe = async {
        if bare {
            Some(glab_auth(
                run_capture(binary, &["auth", "status"], DETECT_TIMEOUT).await,
            ))
        } else {
            None
        }
    };
    let (pinned_readings, bare_reading) = tokio::join!(futures_join_all(probes), bare_probe);
    worst_host_auth(pinned_readings.into_iter().chain(bare_reading))
}

/// Detect one CLI: resolve it, read `--version`, and (when it has a login) its
/// auth state.
async fn detect(id: &str, names: &[&str], auth: AuthProbe) -> ToolStatus {
    let Some(binary) = resolve_named(names, None).await else {
        return undetected(id);
    };

    let version = run_capture(&binary, &["--version"], DETECT_TIMEOUT)
        .await
        .ok()
        .filter(|(code, _)| *code == 0)
        // `--version` is often multi-line (gh prints a release-notes URL); the
        // first line is the version we want.
        .and_then(|(_, out)| out.lines().next().map(|l| l.trim().to_string()))
        .filter(|s| !s.is_empty());

    let authed = match auth {
        AuthProbe::None => AuthStatus::Unknown,
        AuthProbe::ExitCode(args) => {
            exit_code_auth(run_capture(&binary, args, DETECT_TIMEOUT).await)
        }
        AuthProbe::Gh => gh_cli_auth_status().await,
        AuthProbe::Glab => glab_cli_auth(&binary).await,
    };

    ToolStatus {
        id: id.to_string(),
        found: true,
        path: Some(binary.to_string_lossy().into_owned()),
        version,
        authed,
    }
}

/// One tool detection: id, candidate binary names, and how its sign-in is read.
type Probe = (&'static str, &'static [&'static str], AuthProbe);

/// Every CLI the About screen reports on, in the order it displays them. Copilot
/// has no non-interactive auth-status command (it authenticates via the OS
/// credential store / a token env var), so its login state stays Unknown.
static PROBES: [Probe; 7] = [
    ("git", &["git"], AuthProbe::None),
    ("gh", &["gh"], AuthProbe::Gh),
    ("glab", &["glab"], AuthProbe::Glab),
    (
        "claude",
        &["claude"],
        AuthProbe::ExitCode(&["auth", "status"]),
    ),
    (
        "codex",
        &["codex"],
        AuthProbe::ExitCode(&["login", "status"]),
    ),
    ("copilot", &["copilot"], AuthProbe::None),
    ("opencode", &["opencode"], AuthProbe::None),
];

/// OS/app info + the status of every external CLI, for Settings → About. The
/// per-tool detections (each spawns subprocesses) run concurrently.
#[tauri::command]
pub async fn system_health() -> AppResult<SystemHealth> {
    // Each detection runs as its own task to keep this command's future tiny:
    // the invoke handler CONSTRUCTS a command future on the WebView2 UI-thread
    // stack before tauri's runtime polls it on a worker, and the seven detect
    // futures inlined here overflowed that stack in release builds (~721 KB
    // handler frame, v0.12.1 crash dump; the same future was 123,000 B in
    // debug and fit — why dev never crashed).
    let handles: Vec<_> = PROBES
        .iter()
        .map(|&(id, names, auth)| {
            let handle = tauri::async_runtime::spawn(detect(id, names, auth));
            (id, handle)
        })
        // collect() drives every spawn before the first await below; awaiting
        // inside one loop would serialize seven probes, each up to three timed
        // subprocess legs (resolve, version, sign-in).
        .collect();

    let mut tools = Vec::with_capacity(handles.len());
    for (id, handle) in handles {
        // A panicked or cancelled probe degrades to that one tool being unknown;
        // an advisory panel must not go blank over it.
        tools.push(handle.await.unwrap_or_else(|_| undetected(id)));
    }

    Ok(SystemHealth {
        system: system_info(),
        tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the fix in `system_health`: the command future is constructed on
    /// the WebView2 UI-thread stack (see the comment there), so it must stay
    /// small. Pre-fix, the inline 7-way join measured 123,000 bytes in this
    /// (debug) profile and ~721 KB in the release handler frame. Building the
    /// future is enough to measure it; it is never polled here.
    #[test]
    fn system_health_future_stays_small() {
        let fut = system_health();
        let size = std::mem::size_of_val(&fut);
        assert!(
            size < 16 * 1024,
            "system_health() future is {size} bytes (debug layout); keep per-tool detections spawned so it stays under 16 KiB"
        );
    }

    #[test]
    fn glab_outage_reads_unreachable_never_signed_out() {
        for output in [
            "Get \"https://gitlab.com/api/v4/user\": dial tcp: lookup gitlab.com: no such host",
            "Post \"https://gitlab.com/oauth/token\": Bad Gateway",
            "context deadline exceeded",
            "429 Too Many Requests",
        ] {
            assert_eq!(
                glab_auth(Ok((1, output.to_string()))),
                AuthStatus::Unreachable,
                "{output}"
            );
        }
        assert_eq!(
            glab_auth(Err(AppError::Timeout(20))),
            AuthStatus::Unreachable
        );
    }

    #[test]
    fn glab_rejected_or_missing_login_reads_signed_out() {
        for output in [
            "No token provided in configuration file",
            "gitlab.com: API call failed: 401 Unauthorized",
        ] {
            assert_eq!(
                glab_auth(Ok((1, output.to_string()))),
                AuthStatus::NotAuthed,
                "{output}"
            );
        }
        assert_eq!(glab_auth(Ok((0, String::new()))), AuthStatus::Authed);
        assert_eq!(glab_auth(Err(AppError::GlabNotFound)), AuthStatus::Unknown);
    }

    #[test]
    fn glab_ported_login_rides_the_bare_probe() {
        let hosts = |list: &[&str]| list.iter().map(|h| h.to_string()).collect::<Vec<_>>();
        // Env-only login at a ported authority: nothing `--hostname` can address, so
        // the bare probe (glab's native routing, token intact) is the whole verdict.
        let (pinned, bare) =
            glab_probe_plan(hosts(&["gitlab.example:8443"]), "gitlab.example:8443");
        assert!(pinned.is_empty());
        assert!(bare);
        let bare_verdict = glab_auth(Ok((0, String::new())));
        assert_eq!(worst_host_auth([bare_verdict]), AuthStatus::Authed);

        // Mixed: the addressable host is probed pinned, the ported target bare, and
        // both readings reduce together.
        let (pinned, bare) = glab_probe_plan(
            hosts(&["gitlab.com", "gitlab.example:8443"]),
            "gitlab.example:8443",
        );
        assert_eq!(pinned, ["gitlab.com"]);
        assert!(bare);
        let revoked = glab_auth(Ok((1, "401 Unauthorized".to_string())));
        assert_eq!(
            worst_host_auth([revoked, bare_verdict]),
            AuthStatus::NotAuthed
        );
        assert_eq!(
            worst_host_auth([AuthStatus::Authed, bare_verdict]),
            AuthStatus::Authed
        );

        // Every account addressable: pinned probes only; none at all: bare only.
        let (pinned, bare) = glab_probe_plan(hosts(&["gitlab.com"]), "gitlab.com");
        assert_eq!(pinned, ["gitlab.com"]);
        assert!(!bare);
        assert_eq!(
            glab_probe_plan(Vec::new(), "gitlab.com"),
            (Vec::new(), true)
        );
    }

    #[test]
    fn glab_rejected_host_outranks_an_unreachable_one() {
        let host = |output: &str| glab_auth(Ok((1, output.to_string())));
        let revoked = host("gitlab.com: API call failed: 401 Unauthorized");
        // One host rejects its token while another can't be reached: signed out.
        let offline = host("Get \"https://vpn.example/api/v4/user\": dial tcp: i/o timeout");
        assert_eq!(worst_host_auth([offline, revoked]), AuthStatus::NotAuthed);
        let throttled = host("429 Too Many Requests");
        assert_eq!(worst_host_auth([throttled, revoked]), AuthStatus::NotAuthed);
        // Every other host fine, one unreachable: can't reach.
        assert_eq!(
            worst_host_auth([AuthStatus::Authed, offline]),
            AuthStatus::Unreachable
        );
    }
}
