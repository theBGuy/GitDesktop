//! The Settings → About screen's diagnostics: OS/app info and the status of the
//! external command-line tools several features shell out to (git, gh, glab, and
//! the Claude/Codex agent CLIs). Reuses agent.rs's binary resolver + capture so
//! detection behaves identically to the AI-provider setup (PATH + login-shell
//! fallback, Windows `.cmd` shims, …).

use serde::Serialize;

use crate::agent::{run_capture, resolve_named, AuthStatus, DETECT_TIMEOUT};
use crate::error::AppResult;

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

/// Detect one CLI: resolve it, read `--version`, and (when it has a login) its
/// auth state. `auth_args` is `None` for tools without a login concept (git).
async fn detect(id: &str, names: &[&str], auth_args: Option<&[&str]>) -> ToolStatus {
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

    let authed = match auth_args {
        None => AuthStatus::Unknown,
        Some(args) => match run_capture(&binary, args, DETECT_TIMEOUT).await {
            Ok((0, _)) => AuthStatus::Authed,
            Ok(_) => AuthStatus::NotAuthed,
            Err(_) => AuthStatus::Unknown,
        },
    };

    ToolStatus {
        id: id.to_string(),
        found: true,
        path: Some(binary.to_string_lossy().into_owned()),
        version,
        authed,
    }
}

/// One tool detection: id, candidate binary names, and the auth-status args for
/// tools that have a login (`None` for tools without one).
type Probe = (
    &'static str,
    &'static [&'static str],
    Option<&'static [&'static str]>,
);

/// Every CLI the About screen reports on, in the order it displays them. Copilot
/// has no non-interactive auth-status command (it authenticates via the OS
/// credential store / a token env var), so its login state stays Unknown.
static PROBES: [Probe; 7] = [
    ("git", &["git"], None),
    ("gh", &["gh"], Some(&["auth", "status"])),
    ("glab", &["glab"], Some(&["auth", "status"])),
    ("claude", &["claude"], Some(&["auth", "status"])),
    ("codex", &["codex"], Some(&["login", "status"])),
    ("copilot", &["copilot"], None),
    ("opencode", &["opencode"], None),
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
        .map(|&(id, names, auth_args)| {
            let handle = tauri::async_runtime::spawn(detect(id, names, auth_args));
            (id, handle)
        })
        // collect() drives every spawn before the first await below; awaiting
        // inside one loop would serialize seven probes, each up to three 20 s
        // subprocess legs (resolve + two captures).
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
}
