//! Drives a locally-installed coding-agent CLI (Claude / Codex / Copilot /
//! opencode) as a non-interactive subprocess — reviews and write-capable
//! sessions — streaming output to the frontend over a Tauri channel.
//!
//! Reuses the user's existing CLI subscription auth, so no API key is needed.
//! Reviews are read-only. Tier 1 (diff-only): Claude exposes no builtin tools, opencode
//! a read tool that denies every path, and Copilot denies only write and shell (its read
//! tools stay); Codex has no diff-only mode and always explores. A self-MCP server's
//! tools stay callable.

use std::collections::{HashMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub(crate) const DETECT_TIMEOUT: Duration = Duration::from_secs(20);
/// A warm `opencode models` returns in ~1.5s (measured); the catalog resolves
/// from opencode's disk cache or its binary-bundled snapshot, so the sync HTTP
/// leg is a last resort — 20s is a bound on a hung CLI, not an expected wait.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
const REVIEW_TIMEOUT: Duration = Duration::from_secs(300);
/// Repo-aware (Tier 2) runs explore the tree with tools and take longer — a
/// self-MCP review pulling the full diff routinely runs past ten minutes, so
/// the default budget is twenty. Users can override it in Settings.
const REVIEW_TIMEOUT_AGENTIC: Duration = Duration::from_secs(1200);
/// A write-capable agent session implements a real task, so it gets a much
/// longer budget than a review. Generous for the slice; configurable later.
const SESSION_TIMEOUT: Duration = Duration::from_secs(1800);

/// Effective kill timeout for a review run: the user's override (clamped to
/// 1–120 minutes) when set and non-zero, else the tier default.
fn review_timeout(agentic: bool, override_secs: Option<u64>) -> Duration {
    match override_secs {
        Some(s) if s > 0 => Duration::from_secs(s.clamp(60, 7200)),
        _ => {
            if agentic {
                REVIEW_TIMEOUT_AGENTIC
            } else {
                REVIEW_TIMEOUT
            }
        }
    }
}

/// Human-readable duration for timeout copy: whole minutes when it divides
/// evenly ("20 minutes"), else seconds ("90 seconds").
fn human_duration(secs: u64) -> String {
    if secs >= 60 && secs.is_multiple_of(60) {
        let mins = secs / 60;
        if mins == 1 {
            "1 minute".to_string()
        } else {
            format!("{mins} minutes")
        }
    } else {
        format!("{secs} seconds")
    }
}

/// Copy for a run killed by its deadline. `hint` points at the setting that
/// governs the limit — set only by the review flows the "Review timeout"
/// setting actually reaches, so generation / Debug-with-AI (which share the
/// "review" noun) and sessions never advertise a knob that can't help them.
fn timeout_message(noun: &str, timeout: Duration, hint: bool) -> String {
    let mut msg = format!(
        "The {noun} timed out after {}.",
        human_duration(timeout.as_secs())
    );
    if hint {
        // "Adjust", not "raise" — a run that already used the largest offered
        // option can only go down, and the hint must never be a dead end.
        msg.push_str(" You can adjust the limit in Settings → AI.");
    }
    msg
}

/// Which agent CLI to drive. Frontend sends `"claude"` / `"codex"` / `"copilot"` /
/// `"opencode"`; all four run reviews (host) and sessions (host or container).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Claude,
    Codex,
    Copilot,
    Opencode,
}

impl AgentKind {
    fn binary_names(self) -> &'static [&'static str] {
        match self {
            AgentKind::Claude => &["claude"],
            AgentKind::Codex => &["codex"],
            AgentKind::Copilot => &["copilot"],
            AgentKind::Opencode => &["opencode"],
        }
    }

    /// Args for a non-interactive "am I logged in?" check (exit 0 = authed), or
    /// `None` for a CLI with no such command — Copilot authenticates via the OS
    /// credential store / a token env var, with no status subcommand.
    fn auth_status_args(self) -> Option<&'static [&'static str]> {
        match self {
            AgentKind::Claude => Some(&["auth", "status"]),
            AgentKind::Codex => Some(&["login", "status"]),
            AgentKind::Copilot | AgentKind::Opencode => None,
        }
    }

    /// argv for the CLI's own model-catalog listing; None = no such surface.
    fn models_args(self) -> Option<&'static [&'static str]> {
        match self {
            AgentKind::Codex => Some(&["debug", "models"]),
            AgentKind::Copilot => Some(&["help", "config"]),
            AgentKind::Opencode => Some(&["models"]),
            AgentKind::Claude => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
            AgentKind::Copilot => "GitHub Copilot",
            AgentKind::Opencode => "opencode",
        }
    }

    /// This kind's index into [`RESOLVE_SLOTS`]-wide caches. Spelled out rather than
    /// derived, so adding a kind is a compile error here instead of a silent collision.
    fn slot(self) -> usize {
        match self {
            AgentKind::Claude => 0,
            AgentKind::Codex => 1,
            AgentKind::Copilot => 2,
            AgentKind::Opencode => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthStatus {
    Authed,
    NotAuthed,
    /// The sign-in check never reached a verdict on the credential (an outage).
    /// Only the forge CLI legs of `system_health` produce it; `agent_detect`'s
    /// probes are local and never do.
    Unreachable,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub authed: AuthStatus,
    /// Why GitDesktop will not run this binary, as the sentence a run would be refused
    /// with. `None` when it is supported, is not opencode, or the `--version` check could
    /// not run.
    pub unsupported: Option<String>,
}

/// Streaming events sent to the frontend over the review channel.
///
/// `rename_all` renames VARIANT tags only, so `rename_all_fields` is load-bearing
/// for the TS mirror (`src/lib/ai/agent.ts`): without it a multi-word field like
/// `Done.is_error` reaches TS as `undefined`, silently — a failure reported through
/// `Done` then reads as a success. `review_event_wire_shape_is_camel_case` pins it.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ReviewEvent {
    /// A chunk of assistant text to append to the rendered review.
    Delta { text: String },
    /// Transient progress note (Tier 2 tool activity, e.g. "Reading files…").
    // Reserved for Tier-2 progress notes; declared but not emitted yet.
    #[allow(dead_code)]
    Status { text: String },
    /// One structured tool step for the activity timeline — a normalized `tool`
    /// category (read/search/list/edit/write/run/web-fetch/web-search/other) plus
    /// the thing it acted on (`target`: a file path, command, URL, or query), when
    /// extractable. The frontend accumulates these into a per-turn step list.
    Tool {
        tool: String,
        target: Option<String>,
    },
    /// Terminal event, success or failure: on success `text` is the full final
    /// answer; on `is_error` it carries what the CLI reported at termination — an
    /// error message when the CLI gave one (copilot `session.error`, claude API /
    /// limit text), possibly run output on cap-style stops, which is why consumers
    /// surface it as the reason only when error-shaped (`terminalErrorMessage`).
    Done {
        text: String,
        is_error: bool,
        cost_usd: Option<f64>,
    },
    /// Terminal failure with a message to surface to the user. `partial_text` carries
    /// output a whole-message CLI accumulated but never streamed as deltas (Codex), so a
    /// killed run keeps its work; `timed_out` marks OUR deadline kill, which the frontend
    /// persists as the reason the kept output is partial.
    Error {
        message: String,
        partial_text: Option<String>,
        timed_out: bool,
    },
    /// The CLI's own generated resume id, captured on turn 1 — Codex's thread id
    /// (`thread.started`) or opencode's `sessionID`. The frontend persists it so a
    /// **host** session resumes the *right* conversation (Codex `exec resume <id>`,
    /// opencode `--session <id>`) instead of "continue last", which could grab a
    /// concurrent session sharing the CLI's home. Ignored for reviews / Claude / container.
    /// For opencode the id is an opaque token: it is passed back verbatim, and nothing but
    /// `parse_native_ref` and `opencode1_must_restart` may parse, trim, compare, display or
    /// put it in a command.
    NativeSession { id: String },
    /// A one-line note for the turn's timeline that is not the agent's output. `code` lets a
    /// consumer act on it; `text` is the finished sentence.
    Notice { code: &'static str, text: String },
}

impl ReviewEvent {
    /// A failure carrying nothing but its reason — every source except the deadline
    /// kill, whose partial output is the whole point of the two fields above.
    pub(crate) fn error(message: impl Into<String>) -> Self {
        ReviewEvent::Error {
            message: message.into(),
            partial_text: None,
            timed_out: false,
        }
    }
}

/// Sink for streaming agent events — one emitter, N consumers (the Tauri
/// channel today; a LAN broadcast fan-out later).
pub trait EventSink: Send + Sync {
    fn send(&self, ev: ReviewEvent);
}

impl EventSink for Channel<ReviewEvent> {
    fn send(&self, ev: ReviewEvent) {
        // Fully qualified so this forwards to the inherent method instead of
        // recursing into the trait impl.
        let _ = Channel::send(self, ev);
    }
}

// --- child environment -----------------------------------------------------
//
// Inside the Linux AppImage, AppRun and its GTK hook point loader/toolkit vars
// into the bundle, so any spawned HOST binary loads the bundle's libraries
// instead of the host's and dies. Subtract per child only: never clear
// (SSH_AUTH_SOCK inherits), never touch our own env (WebKit helpers, the
// dlopen'd tray). The tables track the bundle's startup exports (the GTK hook
// the Tauri CLI embeds, and the AppRun binary it downloads); together they
// exactly mirror appimage-guard.sh's allowed list, checked by
// check-appimage-env-twins.mjs.

/// `PATH`-style lists the bundle prepends itself to; `$APPDIR` entries are
/// dropped and the variable is unset when nothing survives — except `PATH`,
/// which is replaced with a minimal host PATH, and `XDG_DATA_DIRS`, whose
/// pre-launch value is restored when the exact launch-chain prefix matches,
/// also removing the hook's `/usr/share` entry.
/// Together with `APPDIR_SCALAR_VARS`, exactly mirrors the guard's
/// `allowed` list.
const APPDIR_PATHLIST_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GTK_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GI_TYPELIB_PATH",
    // Only the bundle's AppRun.wrapped launcher sets these three.
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
];

/// Single-path variables the bundle owns outright — unset when they point into
/// `$APPDIR`. Deliberately left alone: `GTK_THEME` (hook-set, but not
/// `$APPDIR`-derived), `PYTHONDONTWRITEBYTECODE` (the AppRun launcher sets a
/// harmless constant `1`, preventing `.pyc` writes), and `GDK_BACKEND` and
/// `LD_PRELOAD` (the AppImage never sets them, so any value is the user's).
/// Together with `APPDIR_PATHLIST_VARS`, exactly mirrors the guard's
/// `allowed` list.
const APPDIR_SCALAR_VARS: &[&str] = &[
    // An extracted AppImage child would adopt our APPDIR via its GTK hook's
    // `export APPDIR="${APPDIR:-...}"` (a mounted child's type-2 runtime
    // overwrites it).
    "APPDIR",
    // Only the bundle's AppRun.wrapped launcher sets PYTHONHOME.
    "PYTHONHOME",
    "GSETTINGS_SCHEMA_DIR",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_EXTRA_MODULES",
    "GIO_MODULE_DIR",
];

/// Where a child's `PATH` lands when every entry it inherited was bundle-derived.
const FALLBACK_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Whether `entry` is `appdir` itself or a path beneath it. Matches on a path
/// boundary so a sibling mount (`/tmp/.mount_gdX`) isn't stripped by a prefix.
fn is_under_appdir(entry: &str, appdir: &str) -> bool {
    if appdir.is_empty() {
        return false;
    }
    entry == appdir
        || (entry.len() > appdir.len()
            && entry.starts_with(appdir)
            && entry.as_bytes()[appdir.len()] == b'/')
}

/// Drops `$APPDIR` entries (and empty ones) from a `:`-separated list. Returns
/// the survivors — `None` meaning "unset the variable" — plus whether any
/// `$APPDIR` entry was actually dropped, which is what makes an override
/// warranted: a host-only list must be left exactly as the child inherited it.
fn strip_appdir_pathlist(value: &str, appdir: &str) -> (Option<String>, bool) {
    let appdir = appdir.trim_end_matches('/');
    let mut dropped = false;
    let kept: Vec<&str> = value
        .split(':')
        .filter(|entry| {
            if is_under_appdir(entry, appdir) {
                dropped = true;
                return false;
            }
            !entry.is_empty()
        })
        .collect();
    ((!kept.is_empty()).then(|| kept.join(":")), dropped)
}

/// Builds the override plan from an `appdir` and an environment lookup; `Some`
/// sets the variable on the child, `None` removes it. Pure so the rules are
/// testable off-Linux.
fn compute_child_env_overrides(
    appdir: &str,
    var: impl Fn(&str) -> Option<String>,
) -> Vec<(&'static str, Option<String>)> {
    if appdir.is_empty() {
        return Vec::new();
    }
    let mut plan = Vec::new();
    for name in APPDIR_PATHLIST_VARS {
        let Some(value) = var(name) else { continue };
        if *name == "XDG_DATA_DIRS" {
            // The exact AppRun + GTK prefix preserves the pre-launch value;
            // generic stripping would lose the trailing-colon unset marker.
            let a = appdir.trim_end_matches('/');
            let prefix = format!("{a}/usr/share/:{a}/usr/share:/usr/share:");
            if let Some(original) = value.strip_prefix(&prefix) {
                plan.push((*name, (!original.is_empty()).then(|| original.to_string())));
                continue;
            }
        }
        let (kept, dropped) = strip_appdir_pathlist(&value, appdir);
        if !dropped {
            continue;
        }
        // A child always needs a PATH, and an EMPTY element means "the current
        // directory" to POSIX exec — so an all-bundle PATH falls back to a
        // minimal host PATH rather than being unset or left empty.
        let kept = if *name == "PATH" {
            Some(kept.unwrap_or_else(|| FALLBACK_PATH.to_string()))
        } else {
            kept
        };
        plan.push((*name, kept));
    }
    for name in APPDIR_SCALAR_VARS {
        if var(name).is_some_and(|value| is_under_appdir(&value, appdir.trim_end_matches('/'))) {
            plan.push((*name, None));
        }
    }
    plan
}

/// The AppImage mount this process runs from (`$APPDIR`), or None off-AppImage.
fn appimage_appdir() -> Option<String> {
    // AppImage is Linux-only, and `APPDIR` alone gates it: an extracted run
    // (`--appimage-extract`, the no-FUSE path) sets `APPDIR` but never `APPIMAGE`.
    if !cfg!(all(unix, not(target_os = "macos"))) {
        return None;
    }
    std::env::var("APPDIR").ok().filter(|dir| !dir.is_empty())
}

/// The process-wide override plan, computed once from the live environment.
/// Empty (so every applier is a no-op) unless we're running from an AppImage.
fn child_env_overrides() -> &'static [(&'static str, Option<String>)] {
    static PLAN: std::sync::OnceLock<Vec<(&'static str, Option<String>)>> =
        std::sync::OnceLock::new();
    PLAN.get_or_init(|| match appimage_appdir() {
        Some(appdir) => compute_child_env_overrides(&appdir, |key| std::env::var(key).ok()),
        None => Vec::new(),
    })
}

/// Env sink for [`sanitize_child_env`], implemented for every command builder the
/// app spawns through (std, tokio, portable-pty).
pub(crate) trait ChildEnv {
    fn set_var(&mut self, key: &str, value: &str);
    fn unset_var(&mut self, key: &str);
}

impl ChildEnv for Command {
    fn set_var(&mut self, key: &str, value: &str) {
        self.env(key, value);
    }
    fn unset_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl ChildEnv for std::process::Command {
    fn set_var(&mut self, key: &str, value: &str) {
        self.env(key, value);
    }
    fn unset_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

impl ChildEnv for portable_pty::CommandBuilder {
    fn set_var(&mut self, key: &str, value: &str) {
        self.env(key, value);
    }
    fn unset_var(&mut self, key: &str) {
        self.env_remove(key);
    }
}

/// Removes the AppImage bundle's paths and an inherited `PWD` from a child's
/// environment and, on macOS/Linux once a capture has landed, puts the login shell's
/// PATH first. Call it FIRST, before a site's own `.env()` calls, so explicitly-set
/// variables always win.
pub(crate) fn sanitize_child_env<C: ChildEnv>(cmd: &mut C) {
    sanitize_child_env_with(cmd, child_env_overrides(), merged_shell_path().as_deref());
}

/// Set on a child whose PATH is the merged shell PATH, to that same value: a process
/// that finds it equal to its own PATH needn't capture again, and one whose PATH was
/// rewritten on the way down sees a mismatch and captures for itself.
pub(crate) const SHELL_PATH_MERGED_MARKER: &str = "GITDESKTOP_SHELL_PATH_MERGED";

/// [`sanitize_child_env`] with the override plan and the merged PATH passed in;
/// `None` leaves PATH as inherited and sets no marker.
fn sanitize_child_env_with<C: ChildEnv>(
    cmd: &mut C,
    overrides: &[(&str, Option<String>)],
    merged_path: Option<&str>,
) {
    // An inherited `PWD` (a shell-launched app exports one) names the LAUNCHER's
    // directory, never this child's — and a tool that prefers `PWD` over its real
    // cwd (opencode's run root does) would run against that stale path.
    cmd.unset_var("PWD");
    for (name, value) in overrides {
        match value {
            Some(v) => cmd.set_var(name, v),
            None => cmd.unset_var(name),
        }
    }
    // After the overrides: the merge already started from the plan's PATH.
    if let Some(path) = merged_path {
        cmd.set_var("PATH", path);
        cmd.set_var(SHELL_PATH_MERGED_MARKER, path);
    }
}

// --- binary resolution -----------------------------------------------------
//
// A GUI app does not reliably inherit the user's shell PATH, and npm-installed
// CLIs ship a `.cmd` shim on Windows that bare `Command::new("claude")` won't
// resolve. So we search PATH ourselves (honoring PATHEXT) plus the known
// per-tool install dirs, and let the user override with an explicit path.

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Pretty-print an MCP config `Value` to the string body written into a container's
/// mounted home, with a uniform error (the host writers use the same message).
fn json_to_string(v: &serde_json::Value) -> AppResult<String> {
    serde_json::to_string_pretty(v).map_err(|e| AppError::Command(format!("serialize mcp config: {e}")))
}

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("bin"));
        dirs.push(home.join(".codex").join("bin"));
        // opencode's native installer (curl | bash) defaults here; its npm/scoop/
        // winget installs land on PATH, but this covers the standalone binary.
        dirs.push(home.join(".opencode").join("bin"));
        #[cfg(not(windows))]
        {
            // npm with a custom prefix, plus the package/version managers that
            // expose a *stable* bin dir. nvm/fnm don't (their PATH is managed by
            // a shell hook), so those are covered by the login-shell probe.
            dirs.push(home.join(".npm-global").join("bin"));
            dirs.push(home.join(".volta").join("bin"));
            dirs.push(home.join(".asdf").join("shims"));
            dirs.push(home.join(".bun").join("bin"));
            dirs.push(home.join(".linuxbrew").join("bin"));
            // pnpm global bin: ~/Library/pnpm on macOS, ~/.local/share/pnpm on Linux.
            dirs.push(home.join("Library").join("pnpm"));
            dirs.push(home.join(".local").join("share").join("pnpm"));
        }
    }
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm")); // npm global shims
    }
    #[cfg(not(windows))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin")); // Apple Silicon Homebrew
        dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")); // Linuxbrew
        dirs.push(PathBuf::from("/usr/bin"));
    }
    dirs
}

/// Windows analog of `resolve_via_login_shell`. A process captures PATH at
/// launch and Windows never pushes later edits into it, so a CLI installed
/// after GitDesktop started is invisible to a process-PATH search. Read the
/// current user + system PATH straight from the registry instead, so a
/// freshly-installed tool resolves without relaunching the app.
#[cfg(windows)]
pub(crate) fn registry_path_dirs() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    // (root, subkey) — the user PATH overrides/extends the system PATH, so read
    // HKCU first; both are merged into the search either way.
    let sources = [
        (HKEY_CURRENT_USER, "Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ];
    let mut dirs = Vec::new();
    for (root, subkey) in sources {
        let Ok(key) = RegKey::predef(root).open_subkey(subkey) else {
            continue;
        };
        // "Path" is usually REG_EXPAND_SZ; winreg decodes it but does NOT expand
        // %VARS%, so we expand below. (Value-name lookup is case-insensitive.)
        let Ok(raw) = key.get_value::<String, _>("Path") else {
            continue;
        };
        for entry in raw.split(';') {
            let expanded = expand_env_vars(entry.trim());
            if !expanded.is_empty() {
                dirs.push(PathBuf::from(expanded));
            }
        }
    }
    dirs
}

/// Expand `%VAR%` references in a registry PATH entry using the process
/// environment (Windows env-var names are case-insensitive; `std::env::var`
/// honors that). An unknown or unbalanced `%VAR%` is left literal rather than
/// dropped, so we never fabricate a truncated path.
#[cfg(windows)]
fn expand_env_vars(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(val) => out.push_str(&val),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // Unbalanced '%' — emit the remainder literally and stop.
                out.push('%');
                out.push_str(after);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Executable suffixes to try. On Windows this is PATHEXT (`.EXE` before
/// `.CMD`); elsewhere just the bare name.
fn exe_exts() -> Vec<String> {
    #[cfg(windows)]
    {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![String::new()]
    }
}

fn probe_dir(dir: &Path, names: &[&str], exts: &[String]) -> Option<PathBuf> {
    for name in names {
        // Extension variants first: on Windows this picks `codex.cmd` over a bare
        // `codex` (a bash shim CreateProcess can't run).
        for ext in exts {
            if ext.is_empty() {
                continue;
            }
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let bare = dir.join(name);
        if bare.is_file() {
            return Some(bare);
        }
    }
    None
}

pub(crate) fn find_executable(names: &[&str]) -> Option<PathBuf> {
    let exts = exe_exts();
    // PATH first, then the known per-tool install dirs.
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(candidate_dirs());
    // Windows: also search the LIVE registry PATH so a tool added after launch is
    // found without a relaunch. Appended after the process PATH, before probing —
    // the `.exe`-preference pass below still beats an earlier `.cmd` shim.
    #[cfg(windows)]
    dirs.extend(registry_path_dirs());

    // Windows: prefer a real `.exe`/`.com` found ANYWHERE over a `.cmd`/`.bat` shim
    // earlier on PATH. Rust refuses to pass newline-bearing args to a batch file
    // ("batch file arguments are invalid") and our prompts are multi-line; and the
    // VS Code Copilot extension injects a `copilot.bat` ahead of the real
    // `copilot.exe` on the integrated-terminal PATH. CLIs shipping ONLY a `.cmd`
    // (codex) still resolve in the pass below; no-op on Unix.
    #[cfg(windows)]
    {
        let exe_only: Vec<&String> = exts
            .iter()
            .filter(|e| {
                let u = e.to_ascii_uppercase();
                u == ".EXE" || u == ".COM"
            })
            .collect();
        for dir in &dirs {
            for name in names {
                for ext in &exe_only {
                    // No bare-name fallback here: a bare `copilot` next to the
                    // `.bat` is a bash shim CreateProcess can't run.
                    let candidate = dir.join(format!("{name}{ext}"));
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    for dir in &dirs {
        if let Some(found) = probe_dir(dir, names, &exts) {
            return Some(found);
        }
    }
    None
}

/// macOS/Linux fallback: a packaged GUI app inherits launchd's minimal PATH, so
/// a version-manager-installed CLI (nvm/fnm/asdf) is on neither PATH nor in
/// `candidate_dirs`. Ask the user's login+interactive shell to resolve it; the
/// shell's misses are remembered per [`LoginShellMisses`], its hits never.
#[cfg(not(windows))]
async fn resolve_via_login_shell(names: &[&str]) -> Option<PathBuf> {
    resolve_via_login_shell_with(
        names,
        login_shell_misses(),
        || SHELL_PATH.get().cloned(),
        Instant::now,
        probe_login_shell,
    )
    .await
}

/// How long a FAILED probe (spawn error, EOF, the byte cap, the timeout) stands in
/// for an answer: it measured nothing, so it is retried, unlike a measured miss.
#[cfg(any(not(windows), test))]
const FAILED_PROBE_TTL: Duration = Duration::from_secs(60);

/// Most names [`LoginShellMisses`] keeps entries or gates for; a new name past it
/// empties the entry map, or drops the idle gates, first. The gate map can exceed it
/// by the gates in use, since a gate someone holds or waits on is never dropped.
#[cfg(any(not(windows), test))]
const LOGIN_SHELL_CACHE_CAP: usize = 64;

/// One login-shell probe of one name. `Missing` is a closed marker pair with no
/// match; `Failed` is no pair at all, which measured nothing.
#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, PartialEq)]
enum LoginShellProbe {
    Found(PathBuf),
    Missing,
    Failed,
}

#[cfg(any(not(windows), test))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum MissEntry {
    Measured,
    Failed { at: Instant },
}

/// A name's single-flight gate. Its slot holds the hit of the flight holding it (or
/// last holding it) with the generation that flight started in, read only by callers
/// that found the gate held and whose own ticket is that generation.
#[cfg(any(not(windows), test))]
type ProbeGate = Arc<tokio::sync::Mutex<Option<(u64, PathBuf)>>>;

/// The login shell's misses per name, valid only for the captured PATH they were
/// measured under. A probe stores its miss, and shares its hit, only under the
/// generation it started in: after a capture change or a clear during a probe, only
/// that probe's own caller gets what it measured.
#[cfg(any(not(windows), test))]
#[derive(Default)]
struct LoginShellMisses {
    capture: Option<String>,
    generation: u64,
    entries: HashMap<String, MissEntry>,
    gates: HashMap<String, ProbeGate>,
}

#[cfg(any(not(windows), test))]
impl LoginShellMisses {
    /// Drops every entry when `capture` differs from the one they were measured under.
    fn follow(&mut self, capture: Option<String>) {
        if self.capture != capture {
            self.entries.clear();
            self.capture = capture;
            self.generation += 1;
        }
    }

    fn fresh(&mut self, name: &str, capture: Option<String>, now: Instant) -> bool {
        self.follow(capture);
        match self.entries.get(name) {
            Some(MissEntry::Measured) => true,
            Some(MissEntry::Failed { at }) => {
                crate::agent_sandbox::cache_entry_fresh(*at, now, FAILED_PROBE_TTL)
            }
            None => false,
        }
    }

    /// At the cap, drops only the idle gates, so a name's gate is never replaced while a
    /// caller holds or waits on it and the map may exceed the cap by those gates. Clones
    /// are made only here, under the cache mutex: a count above one means in use.
    fn gate(&mut self, name: &str) -> ProbeGate {
        if !self.gates.contains_key(name) && self.gates.len() >= LOGIN_SHELL_CACHE_CAP {
            self.gates.retain(|_, g| Arc::strong_count(g) > 1);
        }
        self.gates.entry(name.to_owned()).or_default().clone()
    }

    fn ticket(&mut self, capture: Option<String>) -> u64 {
        self.follow(capture);
        self.generation
    }

    /// A hit removes the name's entry: hits are never cached.
    fn store(
        &mut self,
        name: &str,
        ticket: u64,
        capture: Option<String>,
        outcome: &LoginShellProbe,
        now: Instant,
    ) {
        self.follow(capture);
        if self.generation != ticket {
            return;
        }
        let entry = match outcome {
            LoginShellProbe::Found(_) => {
                self.entries.remove(name);
                return;
            }
            LoginShellProbe::Missing => MissEntry::Measured,
            LoginShellProbe::Failed => MissEntry::Failed { at: now },
        };
        if !self.entries.contains_key(name) && self.entries.len() >= LOGIN_SHELL_CACHE_CAP {
            self.entries.clear();
        }
        self.entries.insert(name.to_owned(), entry);
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.generation += 1;
    }
}

/// [`resolve_via_login_shell`] over an injected cache, capture, clock and probe;
/// `capture` and `now` are read at every cache access. One probe per name at a time,
/// the cap included: a caller queued on a name's gate takes the flight's miss from
/// the cache while it is still there, or its hit from its slot when its ticket is the
/// flight's generation, and otherwise probes in its turn. A name's gate is released
/// before the next name is tried, and the std mutex is never held across an await; a
/// poisoned one reads as cold and shares no hit.
#[cfg(any(not(windows), test))]
async fn resolve_via_login_shell_with<Fut>(
    names: &[&str],
    cache: &Mutex<LoginShellMisses>,
    capture: impl Fn() -> Option<String>,
    now: impl Fn() -> Instant,
    probe: impl Fn(String, String) -> Fut,
) -> Option<PathBuf>
where
    Fut: std::future::Future<Output = LoginShellProbe>,
{
    for name in names {
        let Some(body) = command_v_body(name) else {
            continue;
        };
        let gate = match cache.lock() {
            Ok(mut misses) => {
                if misses.fresh(name, capture(), now()) {
                    continue;
                }
                Some(misses.gate(name))
            }
            Err(_) => None,
        };
        let Some(gate) = gate else {
            match probe((*name).to_owned(), body).await {
                LoginShellProbe::Found(found) => return Some(found),
                _ => continue,
            }
        };
        let (mut slot, joined) = match gate.try_lock() {
            Ok(slot) => (slot, false),
            Err(_) => (gate.lock().await, true),
        };
        let ticket = match cache.lock() {
            Ok(mut misses) => {
                if misses.fresh(name, capture(), now()) {
                    continue;
                }
                Some(misses.ticket(capture()))
            }
            Err(_) => None,
        };
        if let (true, Some(ticket), Some((generation, found))) = (joined, ticket, slot.as_ref()) {
            if *generation == ticket {
                return Some(found.clone());
            }
        }
        *slot = None;
        let outcome = probe((*name).to_owned(), body).await;
        if let (Some(ticket), Ok(mut misses)) = (ticket, cache.lock()) {
            misses.store(name, ticket, capture(), &outcome, now());
        }
        if let LoginShellProbe::Found(found) = outcome {
            if let Some(ticket) = ticket {
                *slot = Some((ticket, found.clone()));
            }
            return Some(found);
        }
    }
    None
}

/// The process-wide [`LoginShellMisses`].
#[cfg(not(windows))]
fn login_shell_misses() -> &'static Mutex<LoginShellMisses> {
    static CACHE: OnceLock<Mutex<LoginShellMisses>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LoginShellMisses::default()))
}

/// One real login-shell probe of `name`, whose `command -v` line is `body`.
#[cfg(not(windows))]
async fn probe_login_shell(name: String, body: String) -> LoginShellProbe {
    let marker = capture_marker();
    let script = marker_wrapped_script(&marker, &body);
    let Some(stdout) = run_login_shell(&script, &marker).await else {
        return LoginShellProbe::Failed;
    };
    match command_v_match(&stdout, &marker, &name, Path::is_file) {
        Some(found) => LoginShellProbe::Found(found),
        None => LoginShellProbe::Missing,
    }
}

/// Forgets every remembered login-shell miss (About > Re-check), so each absent name
/// is probed again; a probe already in flight stores nothing.
#[cfg(not(windows))]
fn clear_login_shell_misses() {
    if let Ok(mut misses) = login_shell_misses().lock() {
        misses.clear();
    }
}

/// Windows has no login-shell probe; the stub keeps call sites cfg-free.
#[cfg(windows)]
fn clear_login_shell_misses() {}

/// The resolver's `command -v` line with the name single-quoted, or None for a name
/// holding a quote, a backslash or a control character: a user-configured launcher
/// token reaches it, and fish reads `\` escapes inside single quotes where sh doesn't.
#[cfg(any(not(windows), test))]
fn command_v_body(name: &str) -> Option<String> {
    let quotable = !name
        .chars()
        .any(|c| c == '\'' || c == '\\' || c.is_control());
    quotable.then(|| format!("command -v '{name}'"))
}

/// The first line between the `marker` pair that is an absolute path to a file named
/// `name` (per `is_file`). rc files may print banners and `command -v` may report an
/// alias or function, so every line is scanned rather than the first one trusted.
#[cfg(any(not(windows), test))]
fn command_v_match(
    stdout: &[u8],
    marker: &str,
    name: &str,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    String::from_utf8_lossy(between_markers(stdout, marker.as_bytes())?)
        .lines()
        .map(|line| PathBuf::from(line.trim()))
        .find(|candidate| {
            // A unix absolute path; `Path::is_absolute` would misread it on Windows tests.
            candidate.to_str().is_some_and(|c| c.starts_with('/'))
                && candidate.file_name().and_then(|f| f.to_str()) == Some(name)
                && is_file(candidate.as_path())
        })
}

/// The no-spawn arms of [`resolve_named`] in their order: the process PATH and known
/// dirs win over the captured shell PATH, so a landing capture only fills misses and
/// never re-points a tool already found. None leaves only the login-shell fallback.
fn resolve_without_spawn(
    names: &[&str],
    find_executable: impl FnOnce(&[&str]) -> Option<PathBuf>,
    on_shell_path: impl Fn(&str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    find_executable(names).or_else(|| names.iter().find_map(|name| on_shell_path(name)))
}

/// Resolves a binary by candidate `names`: an explicit override if it exists,
/// else a static search of PATH + known dirs, else the captured login-shell PATH,
/// else (non-Windows) the user's login shell. Shared by the agent CLIs and the
/// health-screen tool detection.
pub(crate) async fn resolve_named(names: &[&str], bin_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = bin_path.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        return pb.is_file().then_some(pb);
    }
    if let Some(found) = resolve_without_spawn(names, find_executable, find_on_shell_path) {
        return Some(found);
    }
    #[cfg(not(windows))]
    {
        resolve_via_login_shell(names).await
    }
    #[cfg(windows)]
    {
        // No login-shell probe on Windows; the after-launch-PATH recovery is
        // handled inside `find_executable` via the live registry PATH instead.
        None
    }
}

// --- login-shell PATH --------------------------------------------------------
//
// A Finder/Dock launch inherits launchd's minimal PATH, so hooks, filter drivers,
// ssh and by-name credential helpers that git runs miss the user's tools. The login
// shell's PATH is captured once and merged into every child `sanitize_child_env` sets
// up, agent CLIs and their hooks included.

/// The login shell's PATH; set only by a capture that succeeded, so a failed one is
/// retried by the next `prime_shell_path` caller.
#[cfg(not(windows))]
static SHELL_PATH: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

/// Most bytes a capture reads; reaching it is a failed capture.
#[cfg(not(windows))]
const SHELL_PATH_CAPTURE_CAP: usize = 1024 * 1024;

/// Captures the login shell's PATH once (single-flight; a failure caches nothing).
/// Tests never call this: the cell is process-global, so a captured PATH would leak
/// into every later git spawn in the test binary.
#[cfg(not(windows))]
pub(crate) async fn prime_shell_path() {
    // Boxed: a `#[tauri::command]` awaits this, and command futures must stay small.
    let _ = Box::pin(init_holding_flag(
        &SHELL_PATH,
        shell_capture_in_flight(),
        || async {
            let captured = capture_shell_path().await;
            if captured.is_none() {
                if let Ok(mut stamp) = SHELL_RETRY_STAMP.lock() {
                    *stamp = Some(Instant::now());
                }
            }
            captured
        },
    ))
    .await;
}

/// `cell.get_or_try_init(init)` with `flag`'s count raised while THIS caller's init runs.
/// The guard is parked in a slot this frame drops only after the call returns, so a
/// successful init lowers the count only once the cell is set. A failed init frees the
/// cell before that drop, so a queued waiter can start its own init (filling its own
/// slot) first; counting keeps that overlap in flight, so a reader seeing 0 finds no
/// init running. A dropped future drops its slot too; a waiter whose init never runs
/// leaves the count alone.
#[cfg(any(not(windows), test))]
async fn init_holding_flag<'c, T, Fut>(
    cell: &'c tokio::sync::OnceCell<T>,
    flag: &tokio::sync::watch::Sender<usize>,
    init: impl FnOnce() -> Fut,
) -> Option<&'c T>
where
    Fut: std::future::Future<Output = Option<T>>,
{
    let slot = OnceLock::new();
    let value = cell
        .get_or_try_init(|| async {
            let _ = slot.set(InFlightGuard::enter(flag));
            init().await.ok_or(())
        })
        .await
        .ok();
    drop(slot);
    value
}

/// Windows children keep the inherited PATH; the stub keeps call sites cfg-free.
#[cfg(windows)]
pub(crate) async fn prime_shell_path() {}

/// How long a failed capture waits before `merged_shell_path` re-primes.
#[cfg(any(not(windows), test))]
const SHELL_RETRY_COOLDOWN: Duration = Duration::from_secs(60);

/// When the last capture failed, or the last re-prime was spawned; None until a
/// capture fails, so a session whose capture landed never re-primes.
#[cfg(not(windows))]
static SHELL_RETRY_STAMP: Mutex<Option<Instant>> = Mutex::new(None);

/// Counted holds: above 0 while any capture or claimed re-prime is live, not an exact
/// capture count. A count, since a capture taking over after a failed one can start
/// before the failed one's guard drops. A watch, so a reader that subscribes and then
/// waits for 0 can't miss the edge.
#[cfg(not(windows))]
fn shell_capture_in_flight() -> &'static tokio::sync::watch::Sender<usize> {
    static IN_FLIGHT: OnceLock<tokio::sync::watch::Sender<usize>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| tokio::sync::watch::Sender::new(0))
}

/// Counts one executing capture for its lifetime. Released on drop, so a capture that
/// panics or whose future is dropped mid-run can't leave the count stuck above 0.
#[cfg(any(not(windows), test))]
struct InFlightGuard<'a>(&'a tokio::sync::watch::Sender<usize>);

#[cfg(any(not(windows), test))]
impl<'a> InFlightGuard<'a> {
    fn enter(flag: &'a tokio::sync::watch::Sender<usize>) -> Self {
        // `send_modify`, not `send`: it updates the value even with no receiver.
        flag.send_modify(|n| *n += 1);
        Self(flag)
    }
}

#[cfg(any(not(windows), test))]
impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.send_modify(|n| *n = n.saturating_sub(1));
    }
}

/// Whether a re-prime is due: armed by a failure at least `SHELL_RETRY_COOLDOWN` ago,
/// with no capture executing (a prime stacked behind one would run the rc files twice).
#[cfg(any(not(windows), test))]
fn retry_due(last_failed: Option<Instant>, in_flight: bool, now: Instant) -> bool {
    !in_flight
        && last_failed.is_some_and(|t| now.saturating_duration_since(t) >= SHELL_RETRY_COOLDOWN)
}

/// Claims the retry window under the stamp's lock: true, restamped, when due and the
/// caller can spawn. A caller that can't leaves the window armed for the next one.
#[cfg(any(not(windows), test))]
fn claim_shell_retry(
    stamp: &mut Option<Instant>,
    in_flight: bool,
    can_spawn: bool,
    now: Instant,
) -> bool {
    if !can_spawn || !retry_due(*stamp, in_flight, now) {
        return false;
    }
    *stamp = Some(now);
    true
}

/// Spawns one background re-prime when the retry window is due; never awaits, since
/// `merged_shell_path` sits on the status/diff hot path.
#[cfg(not(windows))]
fn reprime_shell_path_if_due() {
    // Not `tauri::async_runtime::spawn`: in a process tauri never set up (the MCP
    // server) it would start a second tokio runtime beside the one already running.
    reprime_if_due(
        &SHELL_RETRY_STAMP,
        shell_capture_in_flight(),
        tokio::runtime::Handle::try_current().ok(),
        Instant::now(),
        prime_shell_path,
    );
}

/// `reprime_shell_path_if_due` over its stamp, count, runtime, clock and prime. The
/// capture is counted before the stamp lock drops, so the caller that triggered the
/// re-prime, and any caller that takes the lock after it, sees it in flight
/// (`send_modify` takes no stamp lock). Returns the task when one was spawned. The
/// wrapper is compiled only off Windows, so `reprime_seam_violations` pins its body
/// and this fn's guard-before-unlock order by source.
#[cfg(any(not(windows), test))]
fn reprime_if_due<F, Fut>(
    stamp: &Mutex<Option<Instant>>,
    flag: &'static tokio::sync::watch::Sender<usize>,
    handle: Option<tokio::runtime::Handle>,
    now: Instant,
    prime: F,
) -> Option<tokio::task::JoinHandle<()>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut stamp = stamp.lock().ok()?;
    if stamp.is_none() {
        return None;
    }
    let in_flight = *flag.borrow() > 0;
    if !claim_shell_retry(&mut stamp, in_flight, handle.is_some(), now) {
        return None;
    }
    let handle = handle?;
    let counted = InFlightGuard::enter(flag);
    drop(stamp);
    Some(spawn_counted(&handle, counted, prime()))
}

/// Spawns `prime` holding `counted` until the task ends, so the count it raised
/// before the spawn stays up through the capture.
#[cfg(any(not(windows), test))]
fn spawn_counted<F>(
    handle: &tokio::runtime::Handle,
    counted: InFlightGuard<'static>,
    prime: F,
) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    handle.spawn(async move {
        let _counted = counted;
        prime.await;
    })
}

/// Longest an agent spawn waits for a capture that is already executing.
#[cfg(any(not(windows), test))]
const SHELL_CAPTURE_WAIT: Duration = Duration::from_secs(3);

/// How a wait on an executing capture ended.
#[cfg(any(not(windows), test))]
#[derive(Debug, PartialEq, Eq)]
enum CaptureWait {
    NothingInFlight,
    Finished,
    TimedOut,
    Cancelled,
}

/// Waits up to `limit` for the in-flight count behind `rx` to reach 0. Only joins a
/// capture another caller is executing, never runs one: a timed-out executor would
/// drop a capture other callers still want.
#[cfg(any(not(windows), test))]
async fn wait_out_capture(
    rx: &mut tokio::sync::watch::Receiver<usize>,
    cancel: &Notify,
    limit: Duration,
) -> CaptureWait {
    if *rx.borrow() == 0 {
        return CaptureWait::NothingInFlight;
    }
    // The `Ref` drops inside the block: one held across the wait would block the
    // guard's send.
    let cleared = async {
        let _ = rx.wait_for(|in_flight| *in_flight == 0).await;
    };
    tokio::select! {
        biased;
        () = cancel.notified() => CaptureWait::Cancelled,
        done = tokio::time::timeout(limit, cleared) => match done {
            Ok(()) => CaptureWait::Finished,
            Err(_) => CaptureWait::TimedOut,
        },
    }
}

/// Holds an agent spawn briefly for a capture already executing, so the CLI and the
/// hooks it runs start on the merged PATH; true when the run was cancelled meanwhile.
#[cfg(not(windows))]
async fn wait_for_executing_capture(cancel: &Notify) -> bool {
    if merged_shell_path().is_some() {
        return false;
    }
    let mut rx = shell_capture_in_flight().subscribe();
    wait_out_capture(&mut rx, cancel, SHELL_CAPTURE_WAIT).await == CaptureWait::Cancelled
}

/// Windows children keep the inherited PATH, so there is nothing to wait for.
#[cfg(windows)]
async fn wait_for_executing_capture(_cancel: &Notify) -> bool {
    false
}

/// The PATH to set on a spawned child: the captured shell PATH merged
/// with the one the child would otherwise get. None (leave the child's PATH as is)
/// until a capture lands, or when the inherited PATH is not valid UTF-8.
#[cfg(not(windows))]
pub(crate) fn merged_shell_path() -> Option<String> {
    let Some(shell) = SHELL_PATH.get() else {
        reprime_shell_path_if_due();
        return None;
    };
    let plan_path = plan_path_entry(child_env_overrides());
    let env_path = std::env::var_os("PATH");
    let inherited = inherited_path_value(plan_path, env_path.as_deref())?;
    Some(merge_path_lists(shell, &inherited))
}

/// The PATH value an AppImage override plan sets, if it carries one.
#[cfg(any(not(windows), test))]
fn plan_path_entry<'a>(plan: &'a [(&'static str, Option<String>)]) -> Option<&'a str> {
    plan.iter()
        .find(|(name, _)| *name == "PATH")
        .and_then(|(_, value)| value.as_deref())
}

/// Windows children keep the inherited PATH; the stub keeps call sites cfg-free.
#[cfg(windows)]
pub(crate) fn merged_shell_path() -> Option<String> {
    None
}

/// The first executable regular file named `name` on the merged login-shell PATH, so
/// a tool run on git's behalf is the same install git's own children find. None
/// before a capture lands or when no entry has it.
#[cfg(unix)]
pub(crate) fn find_on_shell_path(name: &str) -> Option<PathBuf> {
    let path = merged_shell_path()?;
    first_on_path(&path, name, executable_by_us).map(PathBuf::from)
}

/// Whether `path` is a regular file (symlinks followed) this process may execute.
/// `access` checks the REAL ids, which match the effective ones in a GUI app; a mode
/// bit test would accept a file only its owner or group can run.
#[cfg(unix)]
fn executable_by_us(path: &str) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path) else {
        return false;
    };
    // SAFETY: `c_path` is a valid NUL-terminated string that outlives the call.
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file())
        && unsafe { libc::access(c_path.as_ptr(), libc::X_OK) } == 0
}

/// No merged PATH off unix; the stub keeps call sites cfg-free.
#[cfg(not(unix))]
pub(crate) fn find_on_shell_path(_name: &str) -> Option<PathBuf> {
    None
}

/// The first `<entry>/<name>` that `is_exe` accepts, walking the `:`-separated `path`
/// in order. Empty and relative entries are skipped, as the merge drops them.
#[cfg(any(not(windows), test))]
fn first_on_path(path: &str, name: &str, is_exe: impl Fn(&str) -> bool) -> Option<String> {
    path.split(':')
        .filter(|entry| entry.starts_with('/'))
        .map(|entry| format!("{}/{name}", entry.trim_end_matches('/')))
        .find(|candidate| is_exe(candidate))
}

/// Shell entries first, then inherited ones not already present (exact-string
/// dedupe, first occurrence wins). Empty and relative entries are dropped from both
/// sides: git runs in the open repo, where a relative entry would resolve inside it.
#[cfg(any(not(windows), test))]
fn merge_path_lists(shell: &str, inherited: &str) -> String {
    let mut seen = HashSet::new();
    shell
        .split(':')
        .chain(inherited.split(':'))
        // A unix absolute path; `Path::is_absolute` would misread it on Windows tests.
        .filter(|entry| entry.starts_with('/') && seen.insert(*entry))
        .collect::<Vec<_>>()
        .join(":")
}

/// The bytes between the first `marker` pair in `stdout`; None without a closed pair.
#[cfg(any(not(windows), test))]
fn between_markers<'a>(stdout: &'a [u8], marker: &[u8]) -> Option<&'a [u8]> {
    let after_open = &stdout[find_bytes(stdout, marker)? + marker.len()..];
    Some(&after_open[..find_bytes(after_open, marker)?])
}

/// The PATH between the first `marker` pair in a capture's stdout, minus printenv's
/// trailing newline, AppImage-stripped when `appdir` is set. None (a failed capture)
/// for a missing pair, a non-UTF-8 value, any control character, or no absolute
/// entry. Only the value is decoded, so non-UTF-8 rc noise around it never fails it.
#[cfg(any(not(windows), test))]
fn finalize_capture(stdout: &[u8], marker: &str, appdir: Option<&str>) -> Option<String> {
    let value = std::str::from_utf8(between_markers(stdout, marker.as_bytes())?).ok()?;
    let value = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    if value.chars().any(char::is_control) {
        return None;
    }
    let value = match appdir {
        Some(appdir) => strip_appdir_pathlist(value, appdir).0?,
        None => value.to_string(),
    };
    value
        .split(':')
        .any(|entry| entry.starts_with('/'))
        .then_some(value)
}

/// The inherited side of the merge: the AppImage override plan's PATH when it carries
/// one, else the process PATH. None (no merge) when that value is not valid UTF-8.
#[cfg(any(not(windows), test))]
fn inherited_path_value(
    plan_path: Option<&str>,
    env_path: Option<&std::ffi::OsStr>,
) -> Option<String> {
    match (plan_path, env_path) {
        (Some(plan), _) => Some(plan.to_string()),
        (None, Some(env)) => env.to_str().map(str::to_string),
        (None, None) => Some(String::new()),
    }
}

/// Whether `buf` holds both halves of the `marker` pair, so reading can stop.
#[cfg(any(not(windows), test))]
fn capture_pair_closed(buf: &[u8], marker: &[u8]) -> bool {
    find_bytes(buf, marker)
        .is_some_and(|open| find_bytes(&buf[open + marker.len()..], marker).is_some())
}

/// Offset of the first `needle` in `hay`; `needle` is a non-empty capture marker.
#[cfg(any(not(windows), test))]
fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A fresh marker for one login-shell run; unique per process and instant, so no
/// rc output can know it in advance.
#[cfg(not(windows))]
fn capture_marker() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("GDPATH{:x}x{nanos:x}", std::process::id())
}

/// `body` between two prints of `marker`. Each print splits the marker across printf
/// arguments, so an xtrace echo of the command line never contains it whole.
#[cfg(any(not(windows), test))]
fn marker_wrapped_script(marker: &str, body: &str) -> String {
    let (head, tail) = marker.split_at(marker.len() / 2);
    let print_marker = format!("printf '%s%s' '{head}' '{tail}'");
    format!("{print_marker}; {body}; {print_marker}")
}

/// Reads `stdout` until it holds a closed `marker` pair, returning everything read.
/// None on EOF first, a read error, or reaching `cap` bytes. It never waits for EOF:
/// an rc-started background process can hold the pipe open long past the shell's exit.
#[cfg(any(not(windows), test))]
async fn read_until_marker_pair<R: AsyncRead + Unpin>(
    stdout: &mut R,
    marker: &[u8],
    cap: usize,
) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    // Heap, not an inline array: this lives across the read await.
    let mut chunk = vec![0u8; 8192];
    loop {
        let room = cap - buf.len();
        if room == 0 {
            return None;
        }
        let take = chunk.len().min(room);
        let n = stdout.read(&mut chunk[..take]).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if capture_pair_closed(&buf, marker) {
            return Some(buf);
        }
    }
}

/// The login shell to run: `$SHELL` unless unset or empty, else `/bin/sh`.
#[cfg(not(windows))]
fn login_shell_program() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// Runs `script` (from [`marker_wrapped_script`]) under `$SHELL -lic` and returns its
/// stdout up to the closing `marker`, or None on a spawn failure, EOF before the pair,
/// the byte cap, or `DETECT_TIMEOUT`. The one runner for every login-shell probe.
#[cfg(not(windows))]
async fn run_login_shell(script: &str, marker: &str) -> Option<Vec<u8>> {
    let mut cmd = Command::new(login_shell_program());
    sanitize_child_env(&mut cmd);
    run_probe_shell(cmd, script, marker, tokio::time::sleep(DETECT_TIMEOUT)).await
}

/// The login-shell probe's spawn settings for `cmd`: `-lic script`, stdin closed,
/// stdout piped, stderr discarded, and a new session, so the shell leads its own
/// process group.
#[cfg(not(windows))]
fn configure_probe_shell(cmd: &mut Command, script: &str) {
    // -l sources the profile and -i the rc files, where zsh/bash users commonly set
    // PATH (nvm, `brew shellenv`, …); stdin is closed so the shell never waits on it.
    cmd.arg("-lic")
        .arg(script)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // A new session: an interactive shell must never take over a launching terminal
    // (`tauri dev`, an AppImage run from one), and this runs on every startup. Never
    // also put it in a group (`TreeGuard::prepare`): std runs setpgid before pre_exec
    // closures, so setsid would then fail.
    #[cfg(unix)]
    // SAFETY: the hook runs between fork and exec and calls only `setsid`, which is
    // async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// [`run_login_shell`] over a prepared `cmd`, with `deadline` in place of
/// `DETECT_TIMEOUT`. Every exit kills the shell's process group, so a job an rc file
/// started in it dies with the probe. A job outside that group escapes: one that calls
/// setsid itself, or any job started after an rc file turns job control on (`set -m`),
/// which gives each job a group of its own.
#[cfg(not(windows))]
async fn run_probe_shell(
    mut cmd: Command,
    script: &str,
    marker: &str,
    deadline: impl std::future::Future<Output = ()>,
) -> Option<Vec<u8>> {
    configure_probe_shell(&mut cmd, script);
    // The guard is declared right after `child` so it drops first: the unreaped shell
    // still pins the group id when the kill lands, also when this future is dropped.
    let mut child = cmd.spawn().ok()?;
    let _tree = crate::proc_tree::TreeGuard::arm(&child);
    let mut stdout = child.stdout.take()?;
    let read = read_until_marker_pair(&mut stdout, marker.as_bytes(), SHELL_PATH_CAPTURE_CAP);
    tokio::select! {
        biased;
        got = read => got,
        () = deadline => None,
    }
}

/// Runs `$SHELL -lic` to print PATH between random markers, so rc-file banners can't
/// corrupt it.
#[cfg(not(windows))]
async fn capture_shell_path() -> Option<String> {
    let marker = capture_marker();
    // `printenv` is an external program, so the line parses alike in sh, bash, zsh
    // and fish (fish rejects `${PATH}`); `command` skips aliases an -i shell defines.
    let script = marker_wrapped_script(&marker, "command printenv PATH");
    let buf = run_login_shell(&script, &marker).await?;
    finalize_capture(&buf, &marker, appimage_appdir().as_deref())
}

/// One cache slot per [`AgentKind`].
const RESOLVE_SLOTS: usize = 4;

type ResolveCache = [Option<(Instant, Option<PathBuf>)>; RESOLVE_SLOTS];

/// Per-kind memo of the no-override resolution, held for
/// [`crate::agent_sandbox::CANDIDATE_TTL`]. It spares a login-shell spawn per resolution
/// for a CLI only that shell finds (macOS/Linux; the resolver remembers the shell's
/// misses, never its hits). A just-installed CLI can read "not installed" until the entry
/// expires, on the same cadence as the container runtimes' recovery; one only the login
/// shell would find reads so until About > Re-check or a restart.
fn resolve_cache() -> &'static Mutex<ResolveCache> {
    static CACHE: OnceLock<Mutex<ResolveCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::array::from_fn(|_| None)))
}

/// Per-slot single-flight gate. Per SLOT, never one shared gate: a resolve that runs to
/// `DETECT_TIMEOUT` for one agent must not queue another agent's detection behind it.
fn resolve_lock(i: usize) -> &'static tokio::sync::Mutex<()> {
    static LOCKS: OnceLock<[tokio::sync::Mutex<()>; RESOLVE_SLOTS]> = OnceLock::new();
    &LOCKS.get_or_init(|| std::array::from_fn(|_| tokio::sync::Mutex::new(())))[i]
}

/// The slot's still-fresh cached resolution. The nesting is meaningful: the outer `None`
/// is "cold or expired", the inner one a cached "not installed". A poisoned cache reads
/// as cold, so resolution falls through rather than failing.
fn cached_resolve(i: usize) -> Option<Option<PathBuf>> {
    let entry = {
        let guard = resolve_cache().lock().ok();
        guard.and_then(|c| c[i].clone())
    };
    let (at, value) = entry?;
    crate::agent_sandbox::cache_entry_fresh(
        at,
        Instant::now(),
        crate::agent_sandbox::CANDIDATE_TTL,
    )
    .then_some(value)
}

/// Resolves the agent CLI's binary (override → PATH → login shell). The override arm
/// bypasses the cache in both directions — it is a bare `is_file()`, and a Settings path
/// edit must take effect on the next call rather than after a TTL.
async fn resolve(kind: AgentKind, bin_path: Option<&str>) -> Option<PathBuf> {
    let override_path = bin_path.map(str::trim).filter(|s| !s.is_empty());
    if override_path.is_some() {
        return resolve_named(kind.binary_names(), override_path).await;
    }
    let i = kind.slot();
    if let Some(value) = cached_resolve(i) {
        return value;
    }
    // Cold or expired: hold this slot's gate across the resolve and re-check, so N
    // racing callers spend one resolution rather than N login-shell spawns.
    let _flight = resolve_lock(i).lock().await;
    if let Some(value) = cached_resolve(i) {
        return value;
    }
    let resolved = resolve_named(kind.binary_names(), None).await;
    if let Ok(mut c) = resolve_cache().lock() {
        c[i] = Some((Instant::now(), resolved.clone()));
    }
    resolved
}

/// Forgets every cached lookup that can read "not installed" (About > Re-check): the
/// remembered login-shell misses, then the per-kind resolutions and the facts remembered
/// about each opencode binary, then the container-runtime slots. The misses go first, so
/// a COLD lookup that starts afterwards asks a resolver that has already forgotten. A
/// lookup already in flight may still store its answer, and one queued behind it takes
/// that answer: a resolution is held for at most one
/// [`crate::agent_sandbox::CANDIDATE_TTL`], an opencode fact until the next forget.
pub(crate) fn forget_cli_lookups() {
    clear_login_shell_misses();
    if let Ok(mut c) = resolve_cache().lock() {
        c.fill(None);
    }
    if let Ok(mut facts) = opencode_facts().lock() {
        facts.clear();
    }
    crate::agent_sandbox::forget_runtime_candidates();
}

// --- opencode version ------------------------------------------------------

/// The file an opencode fact was learned from. `metadata` follows links, so an npm shim
/// is the identity, not the executable behind it; a fact changes only when this file
/// does.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct BinaryIdentity {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
}

/// `None` when the metadata can't be read: such a binary is probed on every call.
fn binary_identity(path: &Path) -> Option<BinaryIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    Some(BinaryIdentity {
        path: path.to_path_buf(),
        len: meta.len(),
        modified: meta.modified().ok(),
    })
}

/// What GitDesktop remembers about opencode binaries, per identity, until the next
/// [`forget_cli_lookups`] or a restart.
#[derive(Default)]
struct OpencodeFacts {
    /// Supported verdicts, each with when it was read and the version text it printed:
    /// reused for `OPENCODE_VERDICT_TTL`, then kept only to tell whether the next probe
    /// changed the answer. A refusal is never remembered, since its sentence tells the
    /// user to upgrade and try again.
    cli: HashMap<BinaryIdentity, (crate::opencode2::Cli, Instant, String)>,
    /// Binaries whose DiffOnly lock a read-back confirmed, each with the version it was
    /// confirmed on; their later DiffOnly runs on that version skip the read-back. A
    /// probe answering anything but the remembered version drops the binary's entry.
    diff_only_proven: HashMap<BinaryIdentity, crate::opencode2::Version>,
    /// The last model catalog read, with its binary, the version its reader's verdict
    /// held and when it was read. A lookup takes it only for that binary and that
    /// version, within `OPENCODE2_CATALOG_TTL`; a probe answering another version drops it.
    catalog: Option<(
        BinaryIdentity,
        crate::opencode2::Version,
        Instant,
        Arc<crate::opencode2::ModelCatalog>,
    )>,
}

impl OpencodeFacts {
    fn clear(&mut self) {
        self.cli.clear();
        self.diff_only_proven.clear();
        self.catalog = None;
    }
}

/// Whether a review on `version` may skip its DiffOnly read-back: only a proof made on
/// that same version of the binary counts.
fn diff_only_proven(
    facts: &OpencodeFacts,
    identity: Option<&BinaryIdentity>,
    version: crate::opencode2::Version,
) -> bool {
    identity.is_some_and(|id| facts.diff_only_proven.get(id) == Some(&version))
}

/// Remembered binaries are forgotten before an insert past this many.
const OPENCODE_FACTS_MAX: usize = 16;

/// How long a supported verdict is reused before the binary is asked again. An unchanging
/// shim (npm's `.cmd`, mise, volta, scoop) hides an upgrade from the identity, and a
/// `--version` answers before any command handler, so asking again is cheap.
const OPENCODE_VERDICT_TTL: Duration = Duration::from_secs(60);

fn opencode_facts() -> &'static Mutex<OpencodeFacts> {
    static FACTS: OnceLock<Mutex<OpencodeFacts>> = OnceLock::new();
    FACTS.get_or_init(Mutex::default)
}

/// Single-flight gate for version probes: racing callers spend one `--version` spawn.
fn opencode_verdict_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// What one `--version` probe produced; the seam tests drive without a process.
enum VersionProbe {
    /// Exit 0, with its stdout.
    Printed(String),
    /// Why no version was read: the clause that follows `"opencode --version"`.
    Failed(String),
}

/// One binary's answer to "which opencode is this".
#[derive(Clone, Debug, PartialEq, Eq)]
enum OpencodeVerdict {
    Supported(crate::opencode2::Cli),
    Refused(crate::opencode2::VersionRefusal),
    /// The probe could not run, which says nothing about the version.
    ProbeFailed(String),
}

/// A bare `opencode --version`: 1.x rejects `--standalone`, and on 2.x `--version`
/// answers before any command handler, so no server starts. Only stdout is read: every
/// measured release prints its version there, with exit 0.
async fn opencode_verdict_probe(binary: &Path) -> VersionProbe {
    // A child started before the login-shell PATH lands finds no `node`. Nothing cancels a
    // version probe, so the wait watches a cancel that never fires.
    let _ = wait_for_executing_capture(&Notify::new()).await;
    match run_capture_parts(binary, &["--version"], DETECT_TIMEOUT).await {
        Ok((0, stdout, _)) => VersionProbe::Printed(stdout),
        Ok((code, _, _)) => VersionProbe::Failed(format!("exited with code {code}")),
        Err(AppError::Timeout(secs)) => VersionProbe::Failed(format!("timed out after {secs}s")),
        Err(_) => VersionProbe::Failed("could not be started".to_string()),
    }
}

async fn opencode_verdict(binary: &Path) -> (OpencodeVerdict, Option<BinaryIdentity>) {
    let (verdict, identity, _) =
        opencode_verdict_with(binary, opencode_facts(), Instant::now(), || {
            opencode_verdict_probe(binary)
        })
        .await;
    (verdict, identity)
}

fn opencode_verdict_of(
    known: Result<crate::opencode2::Cli, crate::opencode2::VersionRefusal>,
) -> OpencodeVerdict {
    match known {
        Ok(cli) => OpencodeVerdict::Supported(cli),
        Err(refusal) => OpencodeVerdict::Refused(refusal),
    }
}

/// The verdict for `binary` at `now`, remembered under the identity read BEFORE the
/// probe, so a file replaced mid-probe can only file a verdict no later lookup uses. Only
/// a supported verdict is remembered; a refusal, a failed probe and an unreadable
/// identity are asked again on every call. The facts lock is never held across an await.
/// The third member is the trimmed text the verdict was read from (the remembered one for
/// a remembered verdict); `None` for a failed probe or an empty print.
async fn opencode_verdict_with<F, Fut>(
    binary: &Path,
    facts: &Mutex<OpencodeFacts>,
    now: Instant,
    probe: F,
) -> (OpencodeVerdict, Option<BinaryIdentity>, Option<String>)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = VersionProbe>,
{
    let identity = binary_identity(binary);
    let remembered = || {
        let id = identity.as_ref()?;
        let store = facts.lock().ok()?;
        let (cli, read_at, text) = store.cli.get(id)?;
        (now.saturating_duration_since(*read_at) < OPENCODE_VERDICT_TTL)
            .then(|| (*cli, text.clone()))
    };
    if let Some((cli, text)) = remembered() {
        return (OpencodeVerdict::Supported(cli), identity, Some(text));
    }
    let _flight = opencode_verdict_gate().lock().await;
    if let Some((cli, text)) = remembered() {
        return (OpencodeVerdict::Supported(cli), identity, Some(text));
    }
    let (verdict, printed) = match probe().await {
        VersionProbe::Printed(text) => (
            opencode_verdict_of(crate::opencode2::classify_version(&text)),
            Some(text.trim().to_string()).filter(|text| !text.is_empty()),
        ),
        VersionProbe::Failed(clause) => (OpencodeVerdict::ProbeFailed(clause), None),
    };
    if let (Some(id), Ok(mut store)) = (identity.clone(), facts.lock()) {
        let unchanged = matches!(
            (store.cli.get(&id), &verdict),
            (Some((known, ..)), OpencodeVerdict::Supported(cli)) if known == cli
        );
        // A DiffOnly proof and a model catalog are facts about one version of the binary,
        // so a probe answering another version forgets both.
        if !unchanged {
            store.diff_only_proven.remove(&id);
            if matches!(&store.catalog, Some((known, ..)) if *known == id) {
                store.catalog = None;
            }
        }
        match &verdict {
            OpencodeVerdict::Supported(cli) => {
                if store.cli.len() >= OPENCODE_FACTS_MAX && !store.cli.contains_key(&id) {
                    store.cli.clear();
                    store.diff_only_proven.clear();
                }
                let text = printed.clone().unwrap_or_default();
                store.cli.insert(id, (*cli, now, text));
            }
            OpencodeVerdict::Refused(_) | OpencodeVerdict::ProbeFailed(_) => {
                store.cli.remove(&id);
            }
        }
    }
    (verdict, identity, printed)
}

/// The run paths' map: a refusal, or a version check that could not run, is the run's
/// error.
fn opencode_verdict_cli(verdict: OpencodeVerdict) -> AppResult<crate::opencode2::Cli> {
    match verdict {
        OpencodeVerdict::Supported(cli) => Ok(cli),
        OpencodeVerdict::Refused(refusal) => Err(AppError::Command(refusal.message())),
        OpencodeVerdict::ProbeFailed(clause) => Err(AppError::Command(format!(
            "GitDesktop could not check which opencode this is (\"opencode --version\" {clause}). Try again, or pick another binary in Settings."
        ))),
    }
}

/// The detect paths' map: only a verdict about the version is reported, as a standing
/// state rather than a failed run's sentence.
fn opencode_verdict_unsupported(verdict: &OpencodeVerdict) -> Option<String> {
    match verdict {
        OpencodeVerdict::Refused(refusal) => Some(refusal.standing_message()),
        OpencodeVerdict::Supported(_) | OpencodeVerdict::ProbeFailed(_) => None,
    }
}

/// `agent_effort_levels`' map: its answer is a line that stays under the effort control,
/// so a refusal reads as a standing state; a probe that could not run keeps the run
/// paths' sentence.
fn opencode_verdict_effort(verdict: OpencodeVerdict) -> AppResult<crate::opencode2::Cli> {
    match verdict {
        OpencodeVerdict::Refused(refusal) => Err(AppError::Command(refusal.standing_message())),
        other => opencode_verdict_cli(other),
    }
}

/// Run paths: `Refused` and `ProbeFailed` become the `AppError::Command` sentence.
async fn opencode_cli(binary: &Path) -> AppResult<(crate::opencode2::Cli, Option<BinaryIdentity>)> {
    let (verdict, identity) = opencode_verdict(binary).await;
    Ok((opencode_verdict_cli(verdict)?, identity))
}

/// A detect row for opencode: the version text and the refusal a run would meet, both
/// from one `--version` observation (or the remembered one).
pub(crate) struct OpencodeDetection {
    /// The trimmed version text; `None` when the probe failed or printed nothing.
    pub(crate) printed: Option<String>,
    /// `Some(refusal.standing_message())` only for a refused version; never an error.
    pub(crate) unsupported: Option<String>,
}

/// Detect paths: never an error, and a failed probe shows neither a version nor a refusal.
pub(crate) async fn opencode_detection(binary: &Path) -> OpencodeDetection {
    opencode_detection_with(binary, opencode_facts(), Instant::now(), || {
        opencode_verdict_probe(binary)
    })
    .await
}

/// `opencode_detection` with its facts, clock and probe injected, so a test runs this body.
async fn opencode_detection_with<F, Fut>(
    binary: &Path,
    facts: &Mutex<OpencodeFacts>,
    now: Instant,
    probe: F,
) -> OpencodeDetection
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = VersionProbe>,
{
    let (verdict, _, printed) = opencode_verdict_with(binary, facts, now, probe).await;
    opencode_detection_of(&verdict, printed)
}

fn opencode_detection_of(verdict: &OpencodeVerdict, printed: Option<String>) -> OpencodeDetection {
    OpencodeDetection {
        printed,
        unsupported: opencode_verdict_unsupported(verdict),
    }
}

/// Whether a 1.x binary must start a new conversation instead of resuming: the stored
/// id is an `oc2:` token, which only an opencode 2 turn hands out.
fn opencode1_must_restart(resume: bool, raw: Option<&str>) -> bool {
    resume && raw.is_some_and(|id| id.trim().starts_with("oc2:"))
}

/// Code of the notice that the turn's conversation was restarted.
const NOTICE_SESSION_RESET: &str = "nativeSessionReset";

const NOTICE_RESET_V1: &str = "This conversation has turns from opencode 2, and the opencode installed now is 1.x, which cannot continue it. This turn started a new opencode conversation, so the agent does not remember the earlier turns.";

const NOTICE_RESET_GENERIC: &str = "GitDesktop could not continue the earlier opencode conversation, so this turn started a new one. The agent does not remember the earlier turns.";

/// The reset note for a host turn that starts fresh; one template with
/// `NOTICE_RESET_GENERIC` and the frontend's `resumeMissNote`.
fn fresh_start_note(kind: AgentKind) -> String {
    format!(
        "GitDesktop could not continue the earlier {} conversation, so this turn started a new one. The agent does not remember the earlier turns.",
        kind.label()
    )
}

/// Whether a resume turn must start a new conversation: a host Codex or opencode 1.x
/// turn with no captured id would otherwise ask for "the latest" one, which can be
/// another conversation of the repository. A container home holds only this session's.
fn resume_starts_fresh(
    kind: AgentKind,
    container: bool,
    resume: bool,
    native: Option<&str>,
) -> bool {
    resume
        && !container
        && matches!(kind, AgentKind::Codex | AgentKind::Opencode)
        && native.is_none_or(|id| id.trim().is_empty())
}

/// A turn-1 prompt on stdin or `-p`: the system prompt ahead of the user's, or the
/// user's alone when the system prompt is blank.
fn turn_one_prompt(system: &str, user: &str) -> String {
    if system.trim().is_empty() {
        user.to_string()
    } else {
        format!("{system}\n\n{user}")
    }
}

/// Code of the notice sent right before a re-keyed turn's first `NativeSession`; its
/// text is empty.
const NOTICE_SESSION_REKEY: &str = "nativeSessionRekey";

/// Codes of the notices on whether the host's opencode sign-ins reached a container
/// session's home.
const NOTICE_SIGN_INS_COPIED: &str = "signInsCopied";
const NOTICE_SIGN_INS_NOT_COPIED: &str = "signInsNotCopied";
const NOTICE_NO_SIGN_INS: &str = "noSignIns";

const SIGN_INS_COPIED: &str = "Copied your opencode sign-ins into this session's container. Sign-ins you add later reach new sessions only.";

const SIGN_INS_NOT_COPIED: &str = "Your opencode sign-ins couldn't be copied into the container. This session can use opencode's free models. Start a new session to try the copy again.";

const SIGN_INS_LEFTOVER_KEPT: &str = "GitDesktop couldn't replace the sign-in file copied into this session's container earlier, so this session may use those sign-ins instead of your current ones. Start a new session to try the copy again.";

const SIGN_INS_RETRY_HINT: &str = "Start a new session to try the copy again.";

const NO_SIGN_INS: &str = "This computer's opencode has no sign-ins to copy into the container. The session can use opencode's free models.";

const SIGN_INS_UNCHECKED: &str = "GitDesktop could not check this computer's opencode version, so this session has only the sign-ins from opencode 1.x's sign-in file, if there is one. Start a new session to try the copy again.";

const SIGN_INS_HOST_REFUSED: &str = "GitDesktop can't run this computer's opencode version, so this session has only the sign-ins from opencode 1.x's sign-in file, if there is one. After you change opencode, start a new session to try the copy again.";

/// How a container turn brings the host's sign-ins into its home.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignInRoute {
    /// The host's opencode 2 exports them into an import container.
    Export,
    /// The legacy `auth.json` is copied, with the notice the turn sends first, if any.
    Copy(Option<&'static str>),
}

/// Only an opencode 2 host exports; any other verdict, or no host binary, copies. A
/// version check that could not run also copies, and says so on a fresh home: that
/// turn's database fixes the session's sign-ins, so no later turn exports. A refused
/// version copies and says so on a fresh home for the same reason.
fn opencode2_sign_in_route(verdict: Option<&OpencodeVerdict>, fresh: bool) -> SignInRoute {
    match verdict {
        Some(OpencodeVerdict::Supported(crate::opencode2::Cli::V2(_))) => SignInRoute::Export,
        Some(OpencodeVerdict::ProbeFailed(_)) if fresh => {
            SignInRoute::Copy(Some(SIGN_INS_UNCHECKED))
        }
        Some(OpencodeVerdict::Refused(_)) if fresh => {
            SignInRoute::Copy(Some(SIGN_INS_HOST_REFUSED))
        }
        _ => SignInRoute::Copy(None),
    }
}

/// The notice a container turn sends after its sign-in copy answered `copied` (`None`:
/// cancelled), and whether the turn goes on. A cancelled import can leave a database
/// behind, and no later turn copies into a home that is no longer fresh, so that case
/// still reports the copy as failed; a still-fresh home stays silent for the next turn.
fn opencode2_after_copy(
    copied: Option<(&'static str, String)>,
    fresh_after: impl FnOnce() -> bool,
) -> (Option<(&'static str, String)>, bool) {
    match copied {
        Some(notice) => (Some(notice), true),
        None if fresh_after() => (None, false),
        None => (
            Some((NOTICE_SIGN_INS_NOT_COPIED, SIGN_INS_NOT_COPIED.to_string())),
            false,
        ),
    }
}

/// The notice that replaces a fresh home's export when removing the leftover sign-in
/// file failed (`None`: removed or absent, so the export runs). A file that stays would
/// be imported first and stay the active sign-in, so exporting would change nothing.
fn opencode2_leftover_notice(removed: &std::io::Result<()>) -> Option<(&'static str, String)> {
    match removed {
        Ok(()) => None,
        Err(_) => Some((
            NOTICE_SIGN_INS_NOT_COPIED,
            SIGN_INS_LEFTOVER_KEPT.to_string(),
        )),
    }
}

// --- opencode 2 runs ---------------------------------------------------------

/// One captured command whose whole tree dies on a timeout or a cancel.
struct CaptureRequest<'a> {
    program: &'a Path,
    args: Vec<String>,
    cwd: Option<&'a str>,
    env: Vec<(&'static str, String)>,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cancel: Option<&'a Notify>,
}

/// How a captured command ended. stdout stays raw bytes: the sign-in export is handed
/// on undecoded.
enum Captured {
    Exited {
        code: i32,
        stdout: Vec<u8>,
        stderr: String,
    },
    TimedOut,
    Cancelled,
}

/// Whether a runtime client's container may outlive this capture. A client's own non-negative
/// exit code means its container ended or never started; a negative one (a signal death, `-1`
/// on unix, or a crash status) may leave it running: `--rm` acts on the container's exit.
fn container_may_remain(captured: &AppResult<Captured>) -> bool {
    !matches!(captured, Ok(Captured::Exited { code, .. }) if *code >= 0)
}

/// The command `capture_tree` spawns: the base env of every agent spawn, then the
/// request's pairs. stdin is piped only when there are bytes to write.
fn capture_command(req: &CaptureRequest<'_>) -> Command {
    let mut cmd = Command::new(req.program);
    sanitize_child_env(&mut cmd);
    cmd.env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .envs(req.env.iter().map(|(k, v)| (*k, v.as_str())))
        .args(&req.args)
        .stdin(if req.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = req.cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    crate::proc_tree::TreeGuard::prepare(&mut cmd);
    cmd.kill_on_drop(true);
    cmd
}

/// Runs `req` to its exit, timeout or cancel. An exit disarms the guard; anything else
/// kills the whole tree, and on unix a leader reaped after the kill disarms too, since an
/// armed guard could signal a recycled group. Neither stream reaches an error.
async fn capture_tree(req: CaptureRequest<'_>) -> AppResult<Captured> {
    // The run that follows sanitizes against the same landed shell PATH; a request without
    // a cancel waits watching one that never fires.
    let never = Notify::new();
    let cancel = req.cancel.unwrap_or(&never);
    if wait_for_executing_capture(cancel).await {
        return Ok(Captured::Cancelled);
    }
    // Armed before the spawn and awaited in the select below, so a cancel landing between
    // this check and the select still ends the run; one already fired spawns nothing.
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);
    if cancelled.as_mut().enable() {
        return Ok(Captured::Cancelled);
    }
    let mut cmd = capture_command(&req);
    let mut child = cmd.spawn().map_err(AppError::Io)?;
    // Declared right after `child` so it drops first: on unix an unreaped leader pins the
    // group id the guard's kill names.
    let tree = crate::proc_tree::TreeGuard::arm(&child);
    if let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), req.stdin) {
        // Dropping the pipe once written closes the child's stdin.
        tokio::spawn(async move {
            let _ = pipe.write_all(&bytes).await;
        });
    }
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let ended = {
        let run = async {
            let (out, err, overflowed) =
                capture_capped(&mut stdout, &mut stderr, MAX_CAPTURE_BYTES).await?;
            if overflowed {
                return Ok(None);
            }
            let status = child.wait().await.map_err(AppError::Io)?;
            Ok::<_, AppError>(Some((status, out, err)))
        };
        tokio::select! {
            ended = run => Ok(ended),
            _ = tokio::time::sleep(req.timeout) => Err(Captured::TimedOut),
            () = &mut cancelled => Err(Captured::Cancelled),
        }
    };
    let failed = match ended {
        Ok(Ok(Some((status, stdout, stderr)))) => {
            tree.disarm();
            return Ok(Captured::Exited {
                code: status.code().unwrap_or(-1),
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
            });
        }
        Ok(Ok(None)) => Err(AppError::Command(format!(
            "{} produced more than {MAX_CAPTURE_BYTES} bytes on stdout or stderr",
            req.program.display()
        ))),
        Ok(Err(error)) => Err(error),
        Err(forced) => Ok(forced),
    };
    kill_process_tree(&mut child, &tree);
    let _ = tokio::time::timeout(CHILD_REAP_GRACE, child.wait()).await;
    if tree_guard_disarms(cfg!(unix), child.id().is_none(), true, true) {
        tree.disarm();
    }
    failed
}

/// Whether the turn's cancel already fired, checked right before a 2.x turn spawns its
/// run.
fn opencode2_cancel_fired(cancel: &Notify) -> bool {
    turn_cancel_fired(cancel)
}

/// Whether a session turn's cancel already fired, checked right before a spawn. A fired
/// permit is spent here, so the caller ends the turn; a cancel that lands after the
/// check stays stored for the run's own wait.
fn turn_cancel_fired(cancel: &Notify) -> bool {
    std::pin::pin!(cancel.notified()).enable()
}

/// Bound on one host read-back; measured read-backs take 2 to 3 s.
const OPENCODE2_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound on one container read-back; one on a fresh session home measured 6.8 s.
const OPENCODE2_CONTAINER_PROBE_TIMEOUT: Duration = Duration::from_secs(60);

/// Bounds on the host's sign-in export and on the container's import of it.
const OPENCODE2_AUTH_EXPORT_TIMEOUT: Duration = Duration::from_secs(30);
const OPENCODE2_AUTH_IMPORT_TIMEOUT: Duration = Duration::from_secs(60);

/// The host command whose stdout carries the user's opencode sign-ins.
const OPENCODE2_AUTH_EXPORT_ARGS: &[&str] = &["auth", "export", "--standalone"];

/// What one read-back spawn produced, as the lock protocol reads it.
enum ProbeAnswer {
    /// Exit 0, with its stdout.
    Stdout(String),
    Exit {
        code: i32,
        stderr_line: Option<String>,
    },
    TimedOut {
        secs: u64,
    },
    /// The spawn itself failed; the text says why.
    Failed(String),
    Cancelled,
}

/// A read-back capture as the lock protocol reads it; `timeout` is the bound it ran
/// under. Only the first non-blank stderr line is kept, for the refusal sentence.
fn opencode2_probe_answer(captured: AppResult<Captured>, timeout: Duration) -> ProbeAnswer {
    match captured {
        Ok(Captured::Exited {
            code: 0, stdout, ..
        }) => ProbeAnswer::Stdout(String::from_utf8_lossy(&stdout).into_owned()),
        Ok(Captured::Exited { code, stderr, .. }) => ProbeAnswer::Exit {
            code,
            stderr_line: stderr
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(String::from),
        },
        Ok(Captured::TimedOut) => ProbeAnswer::TimedOut {
            secs: timeout.as_secs(),
        },
        Ok(Captured::Cancelled) => ProbeAnswer::Cancelled,
        Err(error) => ProbeAnswer::Failed(error.to_string()),
    }
}

/// The longest stretch of opencode's own text a GitDesktop sentence quotes.
fn opencode2_clip(text: &str) -> String {
    text.chars().take(200).collect()
}

/// Why a 2.x run was refused before it started.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LockRefusal {
    Lock(crate::opencode2::LockError),
    Readback(crate::opencode2::ReadbackError),
    ProbeExit {
        code: i32,
        stderr_line: Option<String>,
    },
    ProbeTimedOut {
        secs: u64,
    },
    ProbeFailed(String),
}

impl LockRefusal {
    fn message(&self) -> String {
        let lead = crate::opencode2::READBACK_REFUSAL_LEAD;
        match self {
            Self::Lock(error) => error.message(),
            Self::Readback(error) => error.message(),
            Self::ProbeExit { code, stderr_line } => {
                let line = stderr_line
                    .as_deref()
                    .map(|line| format!(": {}", opencode2_clip(line)))
                    .unwrap_or_default();
                format!(
                    "{lead} opencode's check command failed (exit code {code}{line}). Check your opencode config with \"opencode debug config\", or update opencode, then try again."
                )
            }
            Self::ProbeTimedOut { secs } => format!(
                "{lead} opencode did not answer the check within {secs} seconds. Try again; if it keeps happening, run \"opencode debug agents --standalone\" in a terminal to see what it is waiting for."
            ),
            Self::ProbeFailed(text) => {
                format!("{lead} opencode's check command could not be started ({text}).")
            }
        }
    }
}

#[derive(Debug)]
enum LockOutcome {
    Locked {
        lock: crate::opencode2::LockDocument,
        /// Whether a read-back confirmed this lock's rules land last.
        read_back: bool,
    },
    Cancelled,
}

/// The read-only lock protocol, the only producer of a lock that reaches a run. Each
/// read-back runs `probe` under a freshly minted probe document and must find that
/// document's rules last; a miss that came back is retried once with a new document,
/// while a timeout or a failed spawn refuses at once. Only a DiffOnly lock already
/// confirmed for this binary (`diff_only_proven`) skips the read-back: ReadOnly and
/// Research mirror the user's current rules, so they read back every run.
async fn opencode2_lock<F, Fut>(
    pin: crate::opencode2::Pin,
    servers: &[&str],
    inherited_content: Option<&str>,
    case: crate::opencode2::MatchCase,
    diff_only_proven: bool,
    mut probe: F,
) -> Result<LockOutcome, LockRefusal>
where
    F: FnMut(crate::opencode2::LockDocument) -> Fut,
    Fut: std::future::Future<Output = ProbeAnswer>,
{
    let mirror = if pin == crate::opencode2::Pin::DiffOnly && diff_only_proven {
        None
    } else {
        let mut attempt = 0;
        Some(loop {
            attempt += 1;
            let document = crate::opencode2::probe_document(pin, servers, inherited_content)
                .map_err(LockRefusal::Lock)?;
            let miss = match probe(document.clone()).await {
                ProbeAnswer::Stdout(stdout) => {
                    match crate::opencode2::read_back(&stdout, &document, pin, case) {
                        Ok(mirror) => break mirror,
                        Err(error) => LockRefusal::Readback(error),
                    }
                }
                ProbeAnswer::Exit { code, stderr_line } => {
                    LockRefusal::ProbeExit { code, stderr_line }
                }
                ProbeAnswer::TimedOut { secs } => return Err(LockRefusal::ProbeTimedOut { secs }),
                ProbeAnswer::Failed(text) => return Err(LockRefusal::ProbeFailed(text)),
                ProbeAnswer::Cancelled => return Ok(LockOutcome::Cancelled),
            };
            if attempt == 2 {
                return Err(miss);
            }
        })
    };
    let access = match (pin, mirror.as_ref()) {
        (crate::opencode2::Pin::ReadOnly, Some(mirror)) => {
            crate::opencode2::Access::ReadOnly(mirror)
        }
        (crate::opencode2::Pin::Research, Some(mirror)) => {
            crate::opencode2::Access::Research(mirror)
        }
        // The tightest lock; a proven DiffOnly is the only pin that arrives without a mirror.
        _ => crate::opencode2::Access::DiffOnly,
    };
    let lock = crate::opencode2::lock_document(access, servers).map_err(LockRefusal::Lock)?;
    Ok(LockOutcome::Locked {
        lock,
        read_back: mirror.is_some(),
    })
}

/// A review's lock: a repo-aware review reads the repository, any other sees the diff
/// it was handed and nothing else.
fn opencode2_review_pin(repo_aware: bool) -> crate::opencode2::Pin {
    if repo_aware {
        crate::opencode2::Pin::ReadOnly
    } else {
        crate::opencode2::Pin::DiffOnly
    }
}

/// A session turn's lock: none for a write turn; a Plan turn reads the repository, and a
/// Research turn the web too.
fn opencode2_session_pin(read_only: bool, web: bool) -> Option<crate::opencode2::Pin> {
    match (read_only, web) {
        (false, _) => None,
        (true, false) => Some(crate::opencode2::Pin::ReadOnly),
        (true, true) => Some(crate::opencode2::Pin::Research),
    }
}

/// The `OPENCODE_CONFIG_CONTENT` a host spawn would inherit, read through the same
/// child-env view as the 1.x read mirror (the spawn's own edits over the app's env).
fn opencode2_inherited_content(config_path: Option<&str>) -> Option<String> {
    // `std::env::var_os` may panic on an empty key or one holding `=` or NUL.
    let inherited = |key: &str| {
        (!key.is_empty() && !key.contains(['=', '\0']))
            .then(|| std::env::var_os(key))
            .flatten()
    };
    let env = opencode_child_env(
        config_path,
        child_env_overrides(),
        merged_shell_path().as_deref(),
        cfg!(windows),
        &inherited,
    );
    env(crate::opencode2::CONTENT_ENV)
}

/// One spawn as data: what to run, where, and with which extra environment.
#[derive(Clone, Debug, PartialEq, Eq)]
struct SpawnPlan {
    args: Vec<String>,
    cwd: String,
    env: Vec<(&'static str, String)>,
}

/// What a 2.x turn is. A review cannot be described without a pin; a session's `None`
/// pin is a write turn.
enum Opencode2Turn<'a> {
    Review {
        version: crate::opencode2::Version,
        pin: crate::opencode2::Pin,
    },
    Session {
        pin: Option<crate::opencode2::Pin>,
        /// `Some` only when the turn resumes a conversation.
        session_id: Option<&'a str>,
    },
}

struct Opencode2Inputs<'a> {
    turn: Opencode2Turn<'a>,
    servers: &'a [&'a str],
    config_path: Option<&'a str>,
    cwd: &'a str,
    model: &'a str,
    inherited_content: Option<&'a str>,
    case: crate::opencode2::MatchCase,
    diff_only_proven: bool,
}

#[derive(Debug)]
enum TurnPlan {
    Run {
        run: SpawnPlan,
        lock: Option<crate::opencode2::LockDocument>,
        read_back: bool,
    },
    Cancelled,
}

/// Plans one 2.x turn. The only caller of `opencode2_lock` and of core's argv and env
/// builders, so no plan for a pinned run exists without its lock; a pinned turn's
/// read-back and run share one working directory and one env builder, with only the
/// document swapped. The variant is read first, so a cancel during its catalog read
/// spawns nothing further. Residual: rules another client attached to a resumed
/// opencode session apply after the lock's, out of the read-back's sight.
async fn opencode2_compose<V, VFut, P, PFut>(
    inputs: &Opencode2Inputs<'_>,
    variant: V,
    mut probe: P,
) -> Result<TurnPlan, LockRefusal>
where
    V: FnOnce() -> VFut,
    VFut: std::future::Future<Output = VariantPick>,
    P: FnMut(SpawnPlan) -> PFut,
    PFut: std::future::Future<Output = ProbeAnswer>,
{
    let config_path = inputs.config_path;
    let VariantPick::Send(picked) = variant().await else {
        return Ok(TurnPlan::Cancelled);
    };
    let variant = picked.as_deref();
    match inputs.turn {
        Opencode2Turn::Review { version, pin } => {
            let env_for = |doc: &crate::opencode2::LockDocument| {
                crate::opencode2::review_env(config_path, doc)
            };
            let outcome = opencode2_lock(
                pin,
                inputs.servers,
                inputs.inherited_content,
                inputs.case,
                inputs.diff_only_proven,
                |doc| {
                    probe(SpawnPlan {
                        args: crate::opencode2::READBACK_ARGS
                            .iter()
                            .map(|arg| arg.to_string())
                            .collect(),
                        cwd: inputs.cwd.to_string(),
                        env: env_for(&doc),
                    })
                },
            )
            .await?;
            let LockOutcome::Locked { lock, read_back } = outcome else {
                return Ok(TurnPlan::Cancelled);
            };
            let run = SpawnPlan {
                args: crate::opencode2::review_args(version, &lock, inputs.model, variant),
                cwd: inputs.cwd.to_string(),
                env: env_for(&lock),
            };
            Ok(TurnPlan::Run {
                run,
                lock: Some(lock),
                read_back,
            })
        }
        Opencode2Turn::Session {
            pin: Some(pin),
            session_id,
        } => {
            let env_for = |doc: &crate::opencode2::LockDocument| {
                crate::opencode2::session_env(config_path.map(String::from), Some(doc))
            };
            let outcome = opencode2_lock(
                pin,
                inputs.servers,
                inputs.inherited_content,
                inputs.case,
                inputs.diff_only_proven,
                |doc| {
                    probe(SpawnPlan {
                        args: crate::opencode2::READBACK_ARGS
                            .iter()
                            .map(|arg| arg.to_string())
                            .collect(),
                        cwd: inputs.cwd.to_string(),
                        env: env_for(&doc),
                    })
                },
            )
            .await?;
            let LockOutcome::Locked { lock, read_back } = outcome else {
                return Ok(TurnPlan::Cancelled);
            };
            let run = SpawnPlan {
                args: crate::opencode2::session_args(
                    crate::opencode2::SessionAgent::Locked(&lock),
                    inputs.model,
                    variant,
                    session_id,
                ),
                cwd: inputs.cwd.to_string(),
                env: env_for(&lock),
            };
            Ok(TurnPlan::Run {
                run,
                lock: Some(lock),
                read_back,
            })
        }
        Opencode2Turn::Session {
            pin: None,
            session_id,
        } => Ok(TurnPlan::Run {
            run: SpawnPlan {
                args: crate::opencode2::session_args(
                    crate::opencode2::SessionAgent::Write,
                    inputs.model,
                    variant,
                    session_id,
                ),
                cwd: inputs.cwd.to_string(),
                env: crate::opencode2::session_env(config_path.map(String::from), None),
            },
            lock: None,
            read_back: false,
        }),
    }
}

/// Extra env pairs of one spawn, in the order they are set.
type EnvPairs = Vec<(&'static str, String)>;

/// A container turn's env, split for the runtime client: every pair rides its argv as
/// `-e K=V` except the lock document, which stays in the client's own env and is
/// forwarded by name. argv shows in `docker inspect`, and Windows caps a command line
/// near 32,767 characters. Returns the `-e` pairs, then the client's env.
fn split_container_env(pairs: EnvPairs) -> (EnvPairs, EnvPairs) {
    pairs
        .into_iter()
        .partition(|(key, _)| *key != crate::opencode2::CONTENT_ENV)
}

/// The kind of turn that created or last continued a 2.x conversation. One opencode
/// session never serves both kinds: an agent named with `--agent` sticks to the session,
/// so a write turn resumed into a pinned one would stay locked, and fail once the lock's
/// id is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnKind {
    Write,
    Pinned,
}

/// A stored opencode conversation id as the 2.x path reads it: a token (`oc2:w:<id>`,
/// `oc2:p:<id>`) was handed out by an opencode 2 turn of that kind, a raw id was created
/// by opencode 1.x.
#[derive(Clone, Debug, PartialEq, Eq)]
enum NativeRef {
    Absent,
    V1 { id: String },
    V2 { id: String, kind: TurnKind },
    Unusable,
}

/// Whether a conversation id may become the value of `--session`: it was read from a
/// CLI's stream.
fn native_id_ok(id: &str) -> bool {
    id.len() <= 128
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The token's one parser, beside `opencode1_must_restart`.
fn parse_native_ref(raw: Option<&str>) -> NativeRef {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return NativeRef::Absent;
    };
    let Some(token) = raw.strip_prefix("oc2:") else {
        return if native_id_ok(raw) {
            NativeRef::V1 {
                id: raw.to_string(),
            }
        } else {
            NativeRef::Unusable
        };
    };
    let (kind, id) = if let Some(id) = token.strip_prefix("w:") {
        (TurnKind::Write, id)
    } else if let Some(id) = token.strip_prefix("p:") {
        (TurnKind::Pinned, id)
    } else {
        return NativeRef::Unusable;
    };
    if native_id_ok(id) {
        NativeRef::V2 {
            id: id.to_string(),
            kind,
        }
    } else {
        NativeRef::Unusable
    }
}

fn native_token(kind: TurnKind, id: &str) -> String {
    let tag = match kind {
        TurnKind::Write => "w",
        TurnKind::Pinned => "p",
    };
    format!("oc2:{tag}:{id}")
}

/// How a 2.x turn continues its conversation: `session_id` is empty unless `resumed`,
/// and `reset` asks for the note that the stored conversation could not be continued.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ResumePlan {
    session_id: String,
    resumed: bool,
    reset: bool,
}

/// A resume with no stored id starts a new conversation with a note, since 2.x is never
/// asked for "the latest" one, which can be another conversation. A raw id is resumed as
/// it is; a token of the other turn kind, or one that does not parse, also starts a new
/// conversation with a note.
fn opencode2_resume_plan(resume: bool, native: &NativeRef, turn: TurnKind) -> ResumePlan {
    let fresh = |reset| ResumePlan {
        session_id: String::new(),
        resumed: false,
        reset,
    };
    let resumed = |id: &str| ResumePlan {
        session_id: id.to_string(),
        resumed: true,
        reset: false,
    };
    if !resume {
        return fresh(false);
    }
    match native {
        NativeRef::Absent => fresh(true),
        NativeRef::V1 { id } => resumed(id),
        NativeRef::V2 { id, kind } if *kind == turn => resumed(id),
        NativeRef::V2 { .. } | NativeRef::Unusable => fresh(true),
    }
}

/// How a session turn hands its conversation id back to the store.
#[derive(Clone, Debug)]
struct NativeTag {
    kind: TurnKind,
    /// The id the turn resumed, and the stored value (trimmed) it was read from.
    resumed: Option<(String, String)>,
    /// The turn resumed an id opencode 1.x created. Its first `NativeSession` follows the
    /// re-key notice and carries a token, so a later 1.x binary starts a new conversation
    /// instead of resuming one that silently lacks this turn. Cleared once sent.
    rekey: bool,
}

impl NativeTag {
    /// The stored value goes back unchanged for the id it named, unless that id is being
    /// re-keyed; any other id goes back as this turn's token.
    fn token_for(&self, id: &str) -> String {
        match &self.resumed {
            Some((resumed, stored)) if resumed == id && !self.rekey => stored.clone(),
            _ => native_token(self.kind, id),
        }
    }
}

/// The stream state of an opencode 2 run.
struct Opencode2Stream {
    parser: crate::opencode2::StreamParser,
    /// A session turn's id hand-back; `None` for a review, whose id nothing reads.
    native: Option<NativeTag>,
}

/// The events one 2.x stream line yields, in send order: slot 0 is the re-key notice, only
/// ahead of a re-keyed turn's first `NativeSession`; slot 1 is the line's `NativeSession`,
/// its id handed back through the turn's tag (raw for a review); slot 2 is the line's own
/// event. No line is terminal.
fn opencode2_stream_event(stream: &mut Opencode2Stream, line: &str) -> [Option<ReviewEvent>; 3] {
    let [native, event] = stream.parser.line(line);
    match (stream.native.as_mut(), native) {
        (Some(tag), Some(ReviewEvent::NativeSession { id })) => {
            let notice = if tag.rekey {
                // The notice arms the store to replace its stored id with this run's
                // next `NativeSession`; every later step of the turn carries the token too.
                tag.rekey = false;
                tag.resumed = None;
                Some(ReviewEvent::Notice {
                    code: NOTICE_SESSION_REKEY,
                    text: String::new(),
                })
            } else {
                None
            };
            let id = tag.token_for(&id);
            [notice, Some(ReviewEvent::NativeSession { id }), event]
        }
        (_, native) => [None, native, event],
    }
}

/// The exit code a 2.x run's end is read from: none for a run GitDesktop killed (a
/// cancel, a timeout, an expired exit grace), so a kill never reads as success.
fn opencode2_exit_code(forced: bool, status: Option<i32>) -> Option<i32> {
    if forced {
        None
    } else {
        status
    }
}

/// A timeout's message. On a 2.x run (`parser` set) opencode's recorded error replaces the
/// deadline sentence, mapped as at EOF; with none, the sentence names the retry opencode was
/// still making when it recorded one.
fn opencode2_timeout_message(
    message: String,
    parser: Option<&crate::opencode2::StreamParser>,
) -> String {
    let Some(parser) = parser else {
        return message;
    };
    if let Some(error) = parser.last_error() {
        return error;
    }
    match parser.last_retry() {
        Some(retry) => format!(
            "{message} opencode was still retrying: {}",
            opencode2_clip(retry)
        ),
        None => message,
    }
}

/// What a 2.x run reports when reading its stdout failed.
const OPENCODE2_OUTPUT_LOST: &str = "GitDesktop lost opencode's output before the run finished.";

/// A 2.x run's terminal event when its stream ended uncancelled and in time. A read error
/// fails the run whatever the exit, since the text read before it may be cut short; else
/// the parser concludes from the exit code and stderr's first non-empty line, clipped.
fn opencode2_conclusion(
    parser: crate::opencode2::StreamParser,
    read_failed: bool,
    code: Option<i32>,
    stderr: &str,
) -> Option<ReviewEvent> {
    if read_failed {
        return Some(ReviewEvent::error(OPENCODE2_OUTPUT_LOST));
    }
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(opencode2_clip);
    parser.finish(code, line.as_deref())
}

// --- detection -------------------------------------------------------------

/// Per-stream cap on captured output. `Command::output` buffers without limit,
/// so a runaway or compromised child could exhaust memory before the timeout
/// (which bounds duration, not bytes). No legitimate capture here approaches it:
/// the largest, `codex debug models`, measured ~354 KB (codex-cli 0.153.3).
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

/// Drains `stdout` and `stderr` concurrently into capped buffers, returning the
/// captured bytes and whether either stream exceeded `cap`. Reading both at once
/// is what keeps a full pipe from deadlocking the child; this stays a pure reader
/// (no child handle), so the caller kills on overflow and any `AsyncRead` drives
/// it in a unit test.
async fn capture_capped<O, E>(
    stdout: &mut O,
    stderr: &mut E,
    cap: usize,
) -> AppResult<(Vec<u8>, Vec<u8>, bool)>
where
    O: AsyncRead + Unpin,
    E: AsyncRead + Unpin,
{
    let mut out = Vec::new();
    let mut err = Vec::new();
    // Heap, not inline arrays: these live across the select awaits, so arrays would
    // bloat every caller's future by 16 KiB — and release builds construct
    // `#[tauri::command]` futures on the WebView2 UI thread's stack.
    let mut obuf = vec![0u8; 8192];
    let mut ebuf = vec![0u8; 8192];
    let (mut odone, mut edone) = (false, false);
    let mut overflowed = false;
    loop {
        tokio::select! {
            r = stdout.read(&mut obuf), if !odone => {
                let n = r.map_err(AppError::Io)?;
                if n == 0 {
                    odone = true;
                } else {
                    let room = cap - out.len();
                    out.extend_from_slice(&obuf[..n.min(room)]);
                    // `>` not `>=`: output landing exactly on the cap is within the
                    // limit — a later non-empty read (room == 0) flags real overflow.
                    if n > room {
                        overflowed = true;
                        break;
                    }
                }
            }
            r = stderr.read(&mut ebuf), if !edone => {
                let n = r.map_err(AppError::Io)?;
                if n == 0 {
                    edone = true;
                } else {
                    let room = cap - err.len();
                    err.extend_from_slice(&ebuf[..n.min(room)]);
                    if n > room {
                        overflowed = true;
                        break;
                    }
                }
            }
            else => break,
        }
    }
    Ok((out, err, overflowed))
}

/// Runs a short command and returns (exit code, stdout, stderr) as separate
/// streams — what a line parser needs, since a banner on stderr must not
/// interleave into the data being parsed. Each stream is capped at
/// `MAX_CAPTURE_BYTES`: a child that writes past it is killed and the call
/// fails with `AppError::Command` rather than returning a truncated capture.
pub(crate) async fn run_capture_parts(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> AppResult<(i32, String, String)> {
    let mut cmd = Command::new(program);
    sanitize_child_env(&mut cmd);
    cmd.args(args)
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(AppError::Io)?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let (status, out, err, overflowed) = tokio::time::timeout(timeout, async {
        let (out, err, overflowed) =
            capture_capped(&mut stdout, &mut stderr, MAX_CAPTURE_BYTES).await?;
        // On overflow the child is still writing to a now-unread pipe, so kill it
        // before waiting; otherwise wait reaps the process that closed its streams.
        if overflowed {
            let _ = child.start_kill();
        }
        let status = child.wait().await.map_err(AppError::Io)?;
        Ok::<_, AppError>((status, out, err, overflowed))
    })
    .await
    .map_err(|_| AppError::Timeout(timeout.as_secs()))??;
    if overflowed {
        // Past the cap the capture is truncated, so its exit code and partial
        // output are meaningless — fail deterministically rather than let a caller
        // parse a fragment (or a racing exit 0) as a complete, successful result.
        return Err(AppError::Command(format!(
            "{} produced more than {MAX_CAPTURE_BYTES} bytes on stdout or stderr",
            program.display()
        )));
    }
    Ok((
        status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    ))
}

/// Runs a short command and returns (exit code, stdout+stderr).
pub(crate) async fn run_capture(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> AppResult<(i32, String)> {
    let (code, mut text, stderr) = run_capture_parts(program, args, timeout).await?;
    text.push_str(&stderr);
    Ok((code, text))
}

/// The verdict of a LOCAL auth-status command, whose exit code is the whole answer;
/// shared by `agent_detect` and the About screen's agent-CLI rows.
pub(crate) fn exit_code_auth(result: AppResult<(i32, String)>) -> AuthStatus {
    match result {
        Ok((0, _)) => AuthStatus::Authed,
        Ok(_) => AuthStatus::NotAuthed,
        Err(_) => AuthStatus::Unknown,
    }
}

#[tauri::command]
pub async fn agent_detect(kind: AgentKind, bin_path: Option<String>) -> AppResult<AgentInfo> {
    let Some(binary) = resolve(kind, bin_path.as_deref()).await else {
        return Ok(AgentInfo {
            found: false,
            path: None,
            version: None,
            authed: AuthStatus::Unknown,
            unsupported: None,
        });
    };

    // For opencode the row's version and the refusal a run would meet are one `--version`
    // observation, shown before the first run.
    let (printed, unsupported) = if kind == AgentKind::Opencode {
        let detection = Box::pin(opencode_detection(&binary)).await;
        (detection.printed, detection.unsupported)
    } else {
        let printed = run_capture(&binary, &["--version"], DETECT_TIMEOUT)
            .await
            .ok()
            .filter(|(code, _)| *code == 0)
            .map(|(_, out)| out);
        (printed, None)
    };
    let version = printed
        .map(|out| out.trim().to_string())
        .filter(|s| !s.is_empty());

    let authed = match kind.auth_status_args() {
        None => AuthStatus::Unknown,
        Some(args) => exit_code_auth(run_capture(&binary, args, DETECT_TIMEOUT).await),
    };

    Ok(AgentInfo {
        found: true,
        path: Some(binary.to_string_lossy().into_owned()),
        version,
        authed,
        unsupported,
    })
}

/// Upper bound on ids handed to the (non-virtualized) model pickers; a
/// credentialed opencode catalog measured 423, so this only bounds pathological
/// output.
const MODELS_LIMIT: usize = 2000;

/// Picks model ids out of a catalog listing: one bare `provider/model` id per
/// line, everything else dropped. The whitespace, control-character, and
/// empty-segment gates reject banners, warnings, `--verbose` JSON, URLs, and
/// ANSI-wrapped ids from a wrapper that ignores `NO_COLOR`. Input order is the
/// CLI's deliberate sort (opencode-own providers first), so it is preserved.
fn parse_models_output(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for line in stdout.split('\n') {
        let id = line.trim();
        if id.is_empty()
            || id.chars().any(|c| c.is_whitespace() || c < '\x20' || c == '\x7f')
            || !id.contains('/')
            || id.split('/').any(|seg| seg.is_empty())
        {
            continue;
        }
        if seen.insert(id) {
            out.push(id.to_string());
        }
        if out.len() == MODELS_LIMIT {
            break;
        }
    }
    out
}

/// A catalog id safe to offer as `--model`: non-empty, no whitespace or control
/// characters.
fn plain_model_id(id: &str) -> bool {
    !id.is_empty()
        && !id
            .chars()
            .any(|c| c.is_whitespace() || c < '\x20' || c == '\x7f')
}

/// One entry of `codex debug models`; an entry that fails to deserialize is
/// skipped without losing the rest.
#[derive(Deserialize)]
struct CodexCatalogEntry {
    slug: String,
    visibility: String,
    priority: f64,
    supported_in_api: bool,
}

/// Picks the picker-visible ids out of `codex debug models` JSON, in codex's own
/// priority order. Mirrors codex's picker: a ChatGPT login offers every
/// `visibility: "list"` model, API-key mode only those `supported_in_api`.
/// Unparseable output yields no ids, so the caller's static fallback serves.
fn parse_codex_models(stdout: &str, chatgpt_auth: bool) -> Vec<String> {
    #[derive(Deserialize)]
    struct Catalog {
        #[serde(default)]
        models: Vec<serde_json::Value>,
    }
    let Ok(catalog) = serde_json::from_str::<Catalog>(stdout) else {
        return Vec::new();
    };
    let mut entries: Vec<CodexCatalogEntry> = catalog
        .models
        .into_iter()
        .filter_map(|v| serde_json::from_value::<CodexCatalogEntry>(v).ok())
        .filter(|e| e.visibility == "list" && (chatgpt_auth || e.supported_in_api))
        .filter(|e| plain_model_id(&e.slug))
        .collect();
    // `sort_by` is stable, so equal priorities keep the CLI's order.
    entries.sort_by(|a, b| a.priority.total_cmp(&b.priority));
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for e in entries {
        if seen.insert(e.slug.clone()) {
            out.push(e.slug);
        }
        if out.len() == MODELS_LIMIT {
            break;
        }
    }
    out
}

/// The quoted token of one `    - "<id>"` enum line of `copilot help config`;
/// None when the line isn't in that shape.
fn copilot_enum_item(line: &str) -> Option<&str> {
    let quoted = line.trim().strip_prefix('-')?.trim_start();
    quoted.strip_prefix('"')?.strip_suffix('"')
}

/// Reads the id block under `copilot help config`'s `` `model`: `` entry: the run
/// of `- "<id>"` lines right after it, stopping at the first other line (the help
/// lists other settings' enums in the same shape). `auto` is a valid `--model`
/// the block never lists, so it leads. No marker or an empty block yields no ids.
fn parse_copilot_models(stdout: &str) -> Vec<String> {
    let mut lines = stdout.split('\n');
    if !lines
        .by_ref()
        .any(|l| l.trim_start().starts_with("`model`:"))
    {
        return Vec::new();
    }
    let mut out: Vec<String> = vec!["auto".to_string()];
    let mut seen: HashSet<&str> = HashSet::from(["auto"]);
    for line in lines {
        let Some(id) = copilot_enum_item(line) else {
            break;
        };
        if out.len() == MODELS_LIMIT {
            break;
        }
        // An unsafe id is dropped but stays inside the block: it is still an item.
        if plain_model_id(id) && seen.insert(id) {
            out.push(id.to_string());
        }
    }
    if out.len() == 1 {
        return Vec::new();
    }
    out
}

/// The verdict of `codex login status` (stdout+stderr): a ChatGPT login widens
/// codex's catalog. Any failure answers false: the API-key filter is valid in both
/// modes.
fn codex_status_is_chatgpt(result: AppResult<(i32, String)>) -> bool {
    match result {
        Ok((0, text)) => text.to_ascii_lowercase().contains("chatgpt"),
        _ => false,
    }
}

/// Whether codex is signed in with ChatGPT (vs an API key).
async fn codex_chatgpt_auth(binary: &Path) -> bool {
    let Some(args) = AgentKind::Codex.auth_status_args() else {
        return false;
    };
    codex_status_is_chatgpt(run_capture(binary, args, MODELS_TIMEOUT).await)
}

/// Names the CLI on a catalog listing's timeout, whose `AppError::Timeout` copy
/// would blame a git operation; every other error passes through unchanged.
fn catalog_listing_error(kind: AgentKind, e: AppError) -> AppError {
    match e {
        AppError::Timeout(secs) => AppError::Command(format!(
            "{} model catalog timed out after {secs}s",
            kind.label()
        )),
        other => other,
    }
}

/// Lists the model ids the CLI itself reports, for the model pickers. Kinds with
/// no catalog surface answer with an empty list rather than an error, so a caller
/// can ask about any agent unconditionally.
#[tauri::command]
pub async fn agent_models(kind: AgentKind, bin_path: Option<String>) -> AppResult<Vec<String>> {
    let Some(args) = kind.models_args() else {
        return Ok(Vec::new());
    };
    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
        AppError::Command(format!(
            "{} CLI not found. Install it or set its path in Settings.",
            kind.label()
        ))
    })?;
    let v2 = kind == AgentKind::Opencode
        && matches!(
            Box::pin(opencode_cli(&binary)).await?,
            (crate::opencode2::Cli::V2(_), _)
        );
    // A 2.x listing runs standalone, so it leaves no background server behind.
    let listed = if v2 {
        let captured = Box::pin(capture_tree(opencode2_read_request(
            &binary,
            crate::opencode2::MODELS_ARGS,
            None,
        )))
        .await;
        opencode2_listing(captured)
    } else {
        run_capture_parts(&binary, args, MODELS_TIMEOUT).await
    };
    let (code, stdout, stderr) = listed.map_err(|e| catalog_listing_error(kind, e))?;
    if code != 0 {
        let reason = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} models exited with code {code}", kind.label()));
        return Err(AppError::Command(reason));
    }
    // Each CLI has its own listing shape; opencode's `/`-gated line parser would
    // drop every codex and copilot id.
    Ok(match kind {
        AgentKind::Codex => parse_codex_models(&stdout, codex_chatgpt_auth(&binary).await),
        AgentKind::Copilot => parse_copilot_models(&stdout),
        AgentKind::Claude | AgentKind::Opencode => parse_models_output(&stdout),
    })
}

// --- opencode 2 models and effort ------------------------------------------------

/// A 2.x model listing in `run_capture_parts`' shape. It runs with no cancel, so only its
/// timeout ends it early.
fn opencode2_listing(captured: AppResult<Captured>) -> AppResult<(i32, String, String)> {
    match captured? {
        Captured::Exited {
            code,
            stdout,
            stderr,
        } => Ok((code, String::from_utf8_lossy(&stdout).into_owned(), stderr)),
        Captured::TimedOut | Captured::Cancelled => {
            Err(AppError::Timeout(MODELS_TIMEOUT.as_secs()))
        }
    }
}

/// A standalone 2.x read of `program`'s models: no cwd, and no env of ours but the
/// project-disable pair, so a repository's own opencode config never applies to it.
fn opencode2_read_request<'a>(
    program: &'a Path,
    args: &[&str],
    cancel: Option<&'a Notify>,
) -> CaptureRequest<'a> {
    CaptureRequest {
        program,
        args: args.iter().map(|arg| arg.to_string()).collect(),
        cwd: None,
        env: crate::opencode2::project_disable_env().into(),
        stdin: None,
        timeout: MODELS_TIMEOUT,
        cancel,
    }
}

/// How long one binary's model catalog is reused: variants are model metadata, and a
/// sign-in changes which models exist.
const OPENCODE2_CATALOG_TTL: Duration = Duration::from_secs(600);

/// A catalog read's outcome. A cancel stays apart from "no catalog": the read consumed
/// the run's single cancel permit, so nothing later would see it.
#[derive(Debug)]
enum CatalogFetch {
    Ready(Arc<crate::opencode2::ModelCatalog>),
    Unavailable,
    Cancelled,
}

/// The variant a 2.x run sends, or the turn's cancel.
#[derive(Clone, Debug, PartialEq, Eq)]
enum VariantPick {
    Send(Option<String>),
    Cancelled,
}

/// Single-flight gate for catalog reads: racing callers spend one spawn.
fn opencode2_catalog_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// The model catalog of `binary`, read as `opencode2_read_request` builds it, so a
/// repository's own opencode config never applies to it.
async fn opencode2_catalog(
    binary: &Path,
    identity: Option<&BinaryIdentity>,
    version: crate::opencode2::Version,
    cancel: Option<&Notify>,
) -> CatalogFetch {
    opencode2_catalog_with(identity, version, opencode_facts(), || {
        capture_tree(opencode2_read_request(
            binary,
            crate::opencode2::CATALOG_ARGS,
            cancel,
        ))
    })
    .await
}

/// The catalog remembered for `identity` on `version` while younger than
/// `OPENCODE2_CATALOG_TTL`, else what `read` returns, remembered under `version`, so a
/// read that finishes after a version change is never served to the new version. Only a
/// parsed catalog is remembered (one binary at a time): a failed read is advisory, so it
/// sends no variant and is asked again. The facts lock is never held across an await.
async fn opencode2_catalog_with<F, Fut>(
    identity: Option<&BinaryIdentity>,
    version: crate::opencode2::Version,
    facts: &Mutex<OpencodeFacts>,
    read: F,
) -> CatalogFetch
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Captured>>,
{
    let remembered = || {
        let id = identity?;
        let store = facts.lock().ok()?;
        let (known, known_version, read_at, catalog) = store.catalog.as_ref()?;
        (known == id && *known_version == version && read_at.elapsed() < OPENCODE2_CATALOG_TTL)
            .then(|| Arc::clone(catalog))
    };
    if let Some(catalog) = remembered() {
        return CatalogFetch::Ready(catalog);
    }
    let _flight = opencode2_catalog_gate().lock().await;
    if let Some(catalog) = remembered() {
        return CatalogFetch::Ready(catalog);
    }
    let stdout = match read().await {
        Ok(Captured::Exited {
            code: 0, stdout, ..
        }) => stdout,
        Ok(Captured::Cancelled) => return CatalogFetch::Cancelled,
        _ => return CatalogFetch::Unavailable,
    };
    let Ok(catalog) = crate::opencode2::parse_model_catalog(&String::from_utf8_lossy(&stdout))
    else {
        return CatalogFetch::Unavailable;
    };
    let catalog = Arc::new(catalog);
    if let (Some(id), Ok(mut store)) = (identity, facts.lock()) {
        store.catalog = Some((id.clone(), version, Instant::now(), Arc::clone(&catalog)));
    }
    CatalogFetch::Ready(catalog)
}

/// Whether an effort level can become a variant of `model`: not without a level or a
/// model, and not for a model typed with its own `#variant`, which `-m` passes as typed.
fn opencode2_effort_applies(model: &str, effort: &str) -> bool {
    let model = model.trim();
    !effort.is_empty() && !model.is_empty() && !model.contains('#')
}

/// The variant a 2.x run sends for `effort`, read from the catalog of `source` (`None`:
/// no opencode 2 binary to read it from). A variant is sent only when the model
/// declares it, since an undeclared one fails the run.
async fn opencode2_variant(
    source: Option<(&Path, Option<&BinaryIdentity>, crate::opencode2::Version)>,
    model: &str,
    effort: &str,
    cancel: Option<&Notify>,
) -> VariantPick {
    match source {
        Some((binary, identity, version)) if opencode2_effort_applies(model, effort) => pick_from(
            opencode2_catalog(binary, identity, version, cancel).await,
            model,
            effort,
        ),
        _ => VariantPick::Send(None),
    }
}

/// The pure half of `opencode2_variant`, over an already fetched catalog.
fn pick_from(fetch: CatalogFetch, model: &str, effort: &str) -> VariantPick {
    match fetch {
        CatalogFetch::Ready(catalog) => VariantPick::Send(
            crate::opencode2::pick_variant(effort, catalog.variants(model.trim()))
                .map(String::from),
        ),
        CatalogFetch::Unavailable => VariantPick::Send(None),
        CatalogFetch::Cancelled => VariantPick::Cancelled,
    }
}

/// One effort level of a model: selectable exactly when `variant` is set, which is the
/// variant a run sends for it; otherwise `reason` says why not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortLevel {
    pub level: String,
    pub variant: Option<String>,
    pub reason: Option<String>,
}

/// The effort control for one model. `per_model` false leaves the control as every other
/// CLI has it (no levels, no reason); true offers each level only with a variant, and
/// `reason` is set exactly when no level has one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortSupport {
    pub per_model: bool,
    pub levels: Vec<EffortLevel>,
    pub reason: Option<String>,
}

const EFFORT_NO_MODEL: &str =
    "Pick a model to set effort. opencode 2 offers effort settings per model.";

const EFFORT_MODEL_HAS_VARIANT: &str = "This model name already picks a variant, so effort is off.";

const EFFORT_CATALOG_UNREADABLE: &str =
    "GitDesktop could not read opencode's model list, so effort is off. Try again in a moment.";

/// `{model}` stands for the model's id in this sentence and the next two.
const EFFORT_NONE_DECLARED: &str = "{model} has no effort settings in opencode.";

const EFFORT_VARIANTS_UNNAMED: &str = "{model} names its effort settings differently in opencode. Add one to the model id as #name to use it.";

const EFFORT_LEVEL_UNAVAILABLE: &str = "Not offered by {model} in opencode.";

const EFFORT_CONTAINER_NEEDS_HOST: &str = "Effort isn't available for this container session. GitDesktop reads each model's effort settings from the opencode installed on this computer, and that needs opencode 2.2 or later here.";

/// The control every CLI but opencode 2 has: one set of levels for all models.
fn effort_not_per_model() -> EffortSupport {
    EffortSupport {
        per_model: false,
        levels: Vec::new(),
        reason: None,
    }
}

/// Every level unavailable, each for the one reason the whole control is off.
fn effort_withheld(reason: String) -> EffortSupport {
    EffortSupport {
        per_model: true,
        levels: crate::opencode2::EFFORT_LEVELS
            .iter()
            .map(|level| EffortLevel {
                level: level.to_string(),
                variant: None,
                reason: Some(reason.clone()),
            })
            .collect(),
        reason: Some(reason),
    }
}

/// The effort control for `model` under an opencode 2 catalog (`None`: it could not be
/// read). Each level offers the variant `opencode2_variant` sends for it.
fn effort_support(model: &str, catalog: Option<&crate::opencode2::ModelCatalog>) -> EffortSupport {
    let model = model.trim();
    let catalog = match catalog {
        _ if model.is_empty() => return effort_withheld(EFFORT_NO_MODEL.to_string()),
        _ if model.contains('#') => return effort_withheld(EFFORT_MODEL_HAS_VARIANT.to_string()),
        None => return effort_withheld(EFFORT_CATALOG_UNREADABLE.to_string()),
        Some(catalog) => catalog,
    };
    let declared = catalog.variants(model);
    let levels: Vec<EffortLevel> = crate::opencode2::EFFORT_LEVELS
        .iter()
        .map(|level| {
            let variant = crate::opencode2::pick_variant(level, declared).map(String::from);
            EffortLevel {
                level: level.to_string(),
                reason: variant
                    .is_none()
                    .then(|| EFFORT_LEVEL_UNAVAILABLE.replace("{model}", model)),
                variant,
            }
        })
        .collect();
    if levels.iter().all(|level| level.variant.is_none()) {
        // Also a model the catalog does not list: it declares nothing either.
        let reason = if declared.is_empty() {
            EFFORT_NONE_DECLARED
        } else {
            EFFORT_VARIANTS_UNNAMED
        };
        return effort_withheld(reason.replace("{model}", model));
    }
    EffortSupport {
        per_model: true,
        levels,
        reason: None,
    }
}

/// Which effort levels `model` offers. Only opencode 2 has per-model levels, read from
/// the model catalog of the opencode on this computer; a container session's are read
/// there too, so a host without opencode 2 leaves a container session without effort.
#[tauri::command]
pub async fn agent_effort_levels(
    kind: AgentKind,
    bin_path: Option<String>,
    model: String,
    isolation: Option<String>,
) -> AppResult<EffortSupport> {
    if kind != AgentKind::Opencode {
        return Ok(effort_not_per_model());
    }
    let found = Box::pin(resolve(kind, bin_path.as_deref())).await;
    let (binary, identity, version) = if isolation.as_deref() == Some("container") {
        let host = match found {
            Some(host) => match Box::pin(opencode_cli(&host)).await {
                Ok((crate::opencode2::Cli::V2(version), identity)) => {
                    Some((host, identity, version))
                }
                _ => None,
            },
            None => None,
        };
        let Some(host) = host else {
            return Ok(effort_withheld(EFFORT_CONTAINER_NEEDS_HOST.to_string()));
        };
        host
    } else {
        let binary = found.ok_or_else(|| {
            AppError::Command(format!(
                "{} CLI not found. Install it or set its path in Settings.",
                kind.label()
            ))
        })?;
        let (verdict, identity) = Box::pin(opencode_verdict(&binary)).await;
        match opencode_verdict_effort(verdict)? {
            crate::opencode2::Cli::V1(_) => return Ok(effort_not_per_model()),
            crate::opencode2::Cli::V2(version) => (binary, identity, version),
        }
    };
    let catalog = match Box::pin(opencode2_catalog(&binary, identity.as_ref(), version, None)).await
    {
        CatalogFetch::Ready(catalog) => Some(catalog),
        // No cancel was passed, so there is none to tell apart.
        CatalogFetch::Unavailable | CatalogFetch::Cancelled => None,
    };
    Ok(effort_support(&model, catalog.as_deref()))
}

// --- review ----------------------------------------------------------------

/// Claude Code review invocation. The diff-bearing user prompt is fed on stdin;
/// this builds everything else. Read-only either way: Tier 1 (`repo_aware =
/// false`) exposes no builtin tools (a self-MCP server's tools stay callable);
/// Tier 2 exposes only read tools so the agent can read surrounding code for
/// context but still can't edit, run commands, or hang waiting on a permission
/// prompt. Both load user settings only, so the reviewed repository's own Claude
/// settings and hooks never apply.
fn claude_review_args(
    model: &str,
    system_prompt: &str,
    repo_aware: bool,
    mcp_config: Option<&str>,
    // `mcp__<server>` allowlist entries for servers loaded via `mcp_config`.
    // Two layers gate an MCP call: `--tools` = availability, `--allowedTools` =
    // permission (headless `-p` auto-denies every ungranted MCP call). Both are
    // appended below. Empty when no self-MCP is attached.
    mcp_tools: &[String],
) -> Vec<String> {
    // Diff-only exposes no base tools; MCP patterns are still appended so a loaded
    // self-server is callable.
    let mut tools = if repo_aware {
        "Read,Grep,Glob".to_string()
    } else {
        String::new()
    };
    for pattern in mcp_tools {
        if !tools.is_empty() {
            tools.push(',');
        }
        tools.push_str(pattern);
    }
    let mut args = vec![
        "-p".into(),
        "--system-prompt".into(),
        system_prompt.into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(), // required alongside stream-json in print mode
        "--tools".into(),
        tools,
        // `--strict-mcp-config` ignores every OTHER MCP source (global ~/.claude,
        // the repo's .mcp.json). With no `--mcp-config` that means zero servers
        // (also trims token cost); with one it means EXACTLY our file's servers.
        "--strict-mcp-config".into(),
        // User settings only: a repository's settings and hooks are not the user's,
        // and `-p` runs hooks without a trust prompt (measured, Claude Code 2.1.311).
        "--setting-sources".into(),
        "user".into(),
        "--no-session-persistence".into(),
    ];
    if let Some(path) = mcp_config {
        args.push("--mcp-config".into());
        args.push(path.into());
    }
    // Permission layer (see the `mcp_tools` param note) — grant exactly the
    // self-server's tools; it is spawned read-only.
    if !mcp_tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(mcp_tools.join(","));
    }
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    args
}

/// Claude write-capable *session* invocation: write toolset +
/// `bypassPermissions` so it never hangs on a mid-run permission prompt — safe
/// because the session runs in a throwaway worktree (`docs/agent-sessions.md`).
/// Prompt on stdin; worktree is the process cwd. Read-only (Plan/Research) sessions
/// load user settings only, so the repository's own Claude settings and hooks never apply.
///
/// Multi-turn: turn 1 starts a persisted session under `session_id`, follow-ups
/// `--resume` it. Persistence stays ON so `--resume` finds the transcript; the
/// system prompt is set on turn 1 only. `fork` (resume-only) branches to a new
/// throwaway id via `--fork-session`, so the distill turn never appends to the
/// original transcript.
#[allow(clippy::too_many_arguments)]
fn claude_session_args(
    model: &str,
    system_prompt: &str,
    session_id: &str,
    resume: bool,
    fork: bool,
    read_only: bool,
    // Research profile: adds WebSearch/WebFetch to the read tools — still no
    // Edit/Write/Bash. Only meaningful when `read_only`.
    web: bool,
    mcp_config: Option<&str>,
    mcp_tools: &[String],
) -> Vec<String> {
    // Read-only profiles get read tools only. Plan needs no bypass (read tools are
    // auto-approved in `-p`); Research does, because the WEB tools are NOT
    // auto-approved and a headless run reports "Web search isn't authorized".
    // Bypass can't widen it: `--tools` is a strict allowlist with no Edit/Write/
    // Bash. MCP tools (`mcp__<server>`) must be appended or the server is uncallable.
    let mut tools = if read_only {
        if web {
            "Read,Grep,Glob,WebSearch,WebFetch".to_string()
        } else {
            "Read,Grep,Glob".to_string()
        }
    } else {
        "Read,Grep,Glob,Edit,Write,Bash".to_string()
    };
    for pattern in mcp_tools {
        tools.push(',');
        tools.push_str(pattern);
    }
    let mut args = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--tools".into(),
        tools,
        // Strict = ignore every other MCP source; pair with `--mcp-config` below
        // to allow EXACTLY the session's opted-in servers, nothing inherited.
        "--strict-mcp-config".into(),
    ];
    // Read-only sessions load user settings only, as reviews do: the repository's
    // settings and hooks are not the user's. Write sessions keep the user's project
    // setup.
    if read_only {
        args.push("--setting-sources".into());
        args.push("user".into());
    }
    if let Some(path) = mcp_config {
        args.push("--mcp-config".into());
        args.push(path.into());
    }
    // Permission layer for the opted-in MCP tools. Redundant under bypass, but it
    // is what makes a Plan session's MCP servers callable (no bypass there).
    if !mcp_tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(mcp_tools.join(","));
    }
    // Write sessions bypass; Research bypasses for its web tools. Plan stays
    // prompt-gated (see the toolset comment above).
    if !read_only || web {
        args.push("--permission-mode".into());
        args.push("bypassPermissions".into());
    }
    if resume {
        args.push("--resume".into());
        args.push(session_id.into());
        // Fork: branch to a throwaway id so this turn never appends to the original.
        if fork {
            args.push("--fork-session".into());
        }
    } else {
        args.push("--session-id".into());
        args.push(session_id.into());
        // A blank prompt keeps Claude's default rather than replacing it with nothing.
        if !system_prompt.trim().is_empty() {
            args.push("--system-prompt".into());
            args.push(system_prompt.into());
        }
    }
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    args
}

/// Codex write-capable *session* invocation. Two confinement shapes:
///
/// - **Host:** Codex's own OS sandbox, `-s workspace-write` (Seatbelt/Landlock;
///   Windows needs `-c windows.sandbox="unelevated"`, which needs no admin).
///   `exec` is non-interactive so approval is already "never".
/// - **Container:** the kernel is the boundary, so full-bypass is safe there.
///
/// Task on stdin (`-`); `--skip-git-repo-check` because the worktree's `.git` is
/// a pointer file. A container session has its own home, so `exec resume --last`
/// continues it; a host resume always names the thread captured on turn 1.
fn codex_session_args(
    model: &str,
    resume: bool,
    container: bool,
    thread_id: Option<&str>,
    effort: &str,
    read_only: bool,
    // Research profile: force Codex's first-party web_search to LIVE (on by
    // default but cached). Hosted, so it works under the read-only sandbox.
    web: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if resume {
        args.push("resume".into());
        // A container session has a dedicated home, so `--last` is unambiguous. A
        // host session shares `~/.codex`, so it resumes the thread captured on turn 1;
        // a host turn without one starts fresh (`resume_starts_fresh`) and never gets here.
        match (container, thread_id) {
            (false, Some(id)) => args.push(id.into()),
            _ => args.push("--last".into()),
        }
    }
    if read_only {
        // A Plan / Research conversation: the read-only sandbox denies every write
        // (the hard guarantee). Never the container full-bypass, which would allow writes.
        args.push("-s".into());
        args.push("read-only".into());
        if cfg!(target_os = "windows") && !container {
            // Windows read-only WITHOUT a sandbox profile blocks process creation, so
            // Codex can't even run its read commands and degrades to "web-grounded
            // only". The unelevated restricted token allows reads; the read-only
            // policy still denies every write.
            args.push("-c".into());
            args.push("windows.sandbox=\"unelevated\"".into());
        }
    } else if container {
        args.push("--dangerously-bypass-approvals-and-sandbox".into());
    } else {
        // Host: confine writes to the worktree via Codex's own OS sandbox. `exec`
        // is non-interactive, so approval is already "never" (no `-a` flag exists).
        args.push("-s".into());
        args.push("workspace-write".into());
        // Allow network for shell commands (npm/pip/git fetch); filesystem confinement
        // is the property we enforce. Default-on also keeps platforms consistent —
        // Windows's `unelevated` sandbox is filesystem-only, so network is open there
        // regardless.
        args.push("-c".into());
        args.push("sandbox_workspace_write.network_access=true".into());
        if cfg!(target_os = "windows") {
            // Select the unelevated restricted-token sandbox, else `workspace-write`
            // silently degrades to read-only on Windows.
            args.push("-c".into());
            args.push("windows.sandbox=\"unelevated\"".into());
        }
    }
    if web {
        // Research: fresh web results, not the default cached snapshot.
        args.push("-c".into());
        args.push("web_search=\"live\"".into());
    }
    args.push("--skip-git-repo-check".into());
    args.push("--json".into());
    if let Some(e) = codex_effort(effort) {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{e}\""));
    }
    if !model.trim().is_empty() {
        args.push("-m".into());
        args.push(model.into());
    }
    args.push("-".into());
    args
}

/// The session's worktree as the CLI will see it FOR THIS RUN: `/workspace` in a
/// container (the bind-mount target — the host path names nothing inside), the real
/// host path otherwise.
fn run_dir(container: bool, worktree_path: &str) -> &str {
    if container {
        "/workspace"
    } else {
        worktree_path
    }
}

/// GitHub Copilot CLI write-capable *session* invocation. Unlike Claude/Codex
/// the prompt is an **argument** (`-p <text>`), not stdin, so the caller passes
/// it here and feeds empty stdin.
///
/// Confinement: `--add-dir <worktree>` with NO `--allow-all-paths` restricts the
/// file tools to the worktree; `--allow-all-tools` is required for `-p` runs. A
/// shell command could still escape, so the host tier is "soft" (like Claude) —
/// the worktree's git isolation is the hard guarantee. Multi-turn is
/// deterministic: `--session-id <uuid>` then `--resume <uuid>`.
#[allow(clippy::too_many_arguments)]
fn copilot_session_args(
    model: &str,
    session_id: &str,
    resume: bool,
    worktree: &str,
    prompt: &str,
    effort: &str,
    read_only: bool,
    // Research profile: keep the web tools + GitHub MCP (neither is `write` nor
    // `shell`, so the read-only guarantee holds). Plan drops the builtin MCPs.
    web: bool,
    mcp_config: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "json".into(),
        "--no-color".into(),
        "--allow-all-tools".into(),
    ];
    if let Some(path) = mcp_config {
        // Per-session MCP servers, augmenting (never mutating) the user's
        // ~/.copilot/mcp-config.json. `@` marks a file path; `--allow-all-tools`
        // above auto-approves the loaded tools for this non-interactive run.
        args.push("--additional-mcp-config".into());
        args.push(format!("@{path}"));
    }
    if read_only {
        // Read-only conversation (Plan or Research): deny every write path (denial
        // takes precedence over allow-all), so reads/search auto-approve but writes
        // are impossible — no worktree write-dir needed.
        args.push("--deny-tool=write".into());
        args.push("--deny-tool=shell".into());
        // Plan stays repo-local (drop the builtin GitHub MCP); Research keeps the
        // builtin MCP + web tools so it can reach GitHub and the web.
        if !web {
            args.push("--disable-builtin-mcps".into());
        }
    } else {
        args.push("--add-dir".into());
        args.push(worktree.into());
    }
    if resume {
        args.push("--resume".into());
        args.push(session_id.into());
    } else {
        args.push("--session-id".into());
        args.push(session_id.into());
    }
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(e) = copilot_effort(effort) {
        args.push("--effort".into());
        args.push(e.into());
    }
    args
}

/// App effort level → Codex `model_reasoning_effort` config value. "" / unknown =
/// provider default (omit). Codex tops out at "high".
fn codex_effort(level: &str) -> Option<&'static str> {
    match level {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" => Some("high"),
        _ => None,
    }
}

/// App effort level → Copilot CLI `--effort` value (it supports the full scale).
fn copilot_effort(level: &str) -> Option<&'static str> {
    match level {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        _ => None,
    }
}

/// App effort level → a Claude "thinking" keyword. The Claude CLI does ship
/// `--effort` (2.1.227), but this app deliberately stays on the keyword
/// mechanism, which works on every installed version: one of these phrases in
/// the user turn raises the thinking budget
/// (think < think hard < think harder < ultrathink). "" = none.
fn claude_thinking_keyword(level: &str) -> Option<&'static str> {
    match level {
        "low" => Some("think"),
        "medium" => Some("think hard"),
        "high" => Some("think harder"),
        "xhigh" => Some("ultrathink"),
        _ => None,
    }
}

/// GitHub Copilot CLI **read-only** review invocation. The prompt (system +
/// diff) is an argument (`-p`), not stdin — Copilot has no stdin prompt form,
/// and `copilot.exe` is a real binary, so it's exempt from the batch-file
/// newline-arg limit.
///
/// Every arm `--deny-tool`s `write` + `shell`, and denial takes precedence over
/// allow-all, so writes stay impossible even in the live repo. Diff-only passes
/// `--allow-all-tools` only with self-MCP (the server needs tools enabled).
/// Repo-aware (Tier 2): `--allow-all-tools` avoids a permission hang, so reads
/// are auto-approved (path-allowed — the review runs with the repo as cwd).
/// `--disable-builtin-mcps` keeps it to local repo reads.
fn copilot_review_args(
    model: &str,
    prompt: &str,
    repo_aware: bool,
    effort: &str,
    // Per-review MCP config (GitDesktop's own self-server), passed via
    // `--additional-mcp-config @<path>` — AUGMENTS the user's
    // `~/.copilot/mcp-config.json`, never mutates it. `None` = no self-MCP.
    mcp_config: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        prompt.into(),
        "--output-format".into(),
        "json".into(),
        "--no-color".into(),
    ];
    if let Some(path) = mcp_config {
        // `@` marks a file path. The server needs tools enabled to be reachable, so a
        // diff-only review must carry allow-all itself.
        args.push("--additional-mcp-config".into());
        args.push(format!("@{path}"));
        if !repo_aware {
            args.push("--allow-all-tools".into());
        }
    }
    if !repo_aware {
        // With or without self-MCP, so the user's own env or config allowing all
        // tools can't let a diff-only review write or shell either.
        args.push("--deny-tool=write".into());
        args.push("--deny-tool=shell".into());
    } else {
        args.push("--allow-all-tools".into());
        args.push("--deny-tool=write".into());
        args.push("--deny-tool=shell".into());
        // Drops Copilot's BUILTIN GitHub MCP so a repo-aware review stays repo-local.
        // Our `--additional-mcp-config` is a DIFFERENT mechanism and survives this flag
        // (verified on Copilot CLI 1.0.70) — do not make it conditional on `mcp_config`.
        args.push("--disable-builtin-mcps".into());
    }
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(e) = copilot_effort(effort) {
        args.push("--effort".into());
        args.push(e.into());
    }
    args
}

/// opencode write-capable *session* invocation. The prompt goes on **stdin**
/// (`opencode run` with no positional message reads it), not as an argument — a
/// large turn would blow the Windows ~32 KB argv limit.
///
/// Confinement is "soft" (like Claude): `--dangerously-skip-permissions` avoids
/// a permission hang; the worktree's git isolation is the hard guarantee.
/// opencode generates its OWN `sessionID` (no flag to set it), so turn 1 omits
/// `--session`, we capture the id from the stream, and resume passes it back —
/// the host-Codex thread-id dance. Naming the id resumes exactly the conversation
/// we started, rather than whichever one opencode considers most recent.
fn opencode_session_args(
    model: &str,
    session_id: &str,
    resume: bool,
    effort: &str,
    read_only: bool,
    // Research profile: use our generated `gd-research` agent instead of the
    // builtin `plan`. The pin denies web to every agent, so only an agent's own
    // `permission` can re-allow it; opencode has no permission CLI flags, so the
    // agent is defined in `OPENCODE_CONFIG` (see mcp.rs).
    web: bool,
    dir: &str,
) -> Vec<String> {
    // `--dir` pins opencode's run root (it resolves `PWD` before cwd) and is stamped
    // into the persisted session row, so resumes stay pinned too.
    let mut args: Vec<String> = vec![
        "run".into(),
        "--format".into(),
        "json".into(),
        "--dangerously-skip-permissions".into(),
        "--dir".into(),
        dir.into(),
    ];
    if read_only {
        // The read-only control is `opencode_session_env`'s `OPENCODE_PERMISSION`
        // pin; `--agent` (`plan`, or Research's `gd-research`, which re-allows web) is
        // a second layer that fails open to the default agent on an unknown name.
        // Sessions keep the repo's opencode config, which can re-enable tools here.
        args.push("--agent".into());
        args.push(if web { crate::mcp::GD_RESEARCH_AGENT } else { "plan" }.into());
    }
    if resume && !session_id.trim().is_empty() {
        // opencode generated the id on turn 1; we captured it from the stream.
        args.push("--session".into());
        args.push(session_id.into());
    }
    if !model.trim().is_empty() {
        args.push("-m".into());
        args.push(model.into());
    }
    if let Some(v) = opencode_variant(effort) {
        args.push("--variant".into());
        args.push(v.into());
    }
    args
}

/// opencode **read-only** review invocation. Prompt on **stdin**: besides the
/// argv ceiling, on Windows `opencode` is a `.cmd` and Rust refuses to pass a
/// newline-bearing argument to a batch file — which every diff prompt is.
///
/// The read-only control is `review_env`'s `OPENCODE_PERMISSION` pin, with
/// project config disabled so the repo's own opencode config can't re-enable a
/// tool. `--agent plan` on `repo_aware` is a second layer only: `plan` denies
/// edits alone, and an unresolved agent name falls back to the full-access
/// default. The pin carries no `ask` rule, so `--dangerously-skip-permissions`
/// can approve only an `ask` a global config layer puts on a key the pin leaves
/// unnamed (the residual `opencode_permission_json` documents).
fn opencode_review_args(model: &str, repo_aware: bool, effort: &str, dir: &str) -> Vec<String> {
    // `--dir` pins opencode's run root (it resolves `PWD` before cwd).
    let mut args: Vec<String> = vec![
        "run".into(),
        "--format".into(),
        "json".into(),
        "--dir".into(),
        dir.into(),
    ];
    if repo_aware {
        args.push("--agent".into());
        args.push("plan".into());
        args.push("--dangerously-skip-permissions".into());
    }
    if !model.trim().is_empty() {
        args.push("-m".into());
        args.push(model.into());
    }
    if let Some(v) = opencode_variant(effort) {
        args.push("--variant".into());
        args.push(v.into());
    }
    args
}

/// Which `OPENCODE_PERMISSION` pin a read-only opencode run carries. `DiffOnly`
/// (every non-repo-aware review run: diff-only reviews, commit/PR/branch generation)
/// keeps the read tool on with every path denied, so a diff-only run reads nothing, and
/// denies `grep`/`glob`/`list`; `ReadOnly` (every repo-aware run, Debug with AI and AI
/// conflict resolve under Agentic review included, plus Plan/Research sessions) mirrors
/// the user's read rules and allows the other three unless the user's config denies the
/// tool outright.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpencodePin {
    DiffOnly,
    ReadOnly,
}

/// The compact `OPENCODE_PERMISSION` JSON for a read-only opencode run. Rules
/// resolve last-match-wins over wildcard keys, so the emitted ORDER is the
/// policy: `*` and the MCP-shaped `*_*` deny first, per-server `<name>_*` allows,
/// the `read` rule and the pin's `grep`/`glob`/`list` rules (ReadOnly allows each
/// unless the user's config denies it outright; DiffOnly denies them), then the deny
/// tail last so a server wildcard (`external_*`, `doom_*`, `plan_*`) can't re-enable a
/// builtin the tail names (but see the residual). Never `{"*":"deny"}` alone: with every
/// tool disabled `opencode run` hangs with no output (measured, opencode 1.18.18).
///
/// Merged config layers keep each key at its FIRST position with the last layer's
/// value (measured). A global layer naming a key the pin DENIES moves that deny ahead
/// of our `*`, which still denies it unless a server allow after `*` matches it too.
/// One naming a key the pin ALLOWS moves the allow ahead of our `*`, which would deny
/// it, so each allow is followed by an alias no config names, keeping that allow after
/// `*`. A builtin's alias is its id plus ` *` (`read *`, `grep *`, `glob *`, `list *`):
/// opencode's matcher (regex flags "si") lets a trailing ` *` match the bare prefix,
/// so it matches that tool. Never a `?` alias: it matches any same-length id sharing
/// the prefix, case-insensitively, custom tools included. A server's alias `<name>_?*`
/// matches only a subset of `<name>_*`. One naming `*` ahead of its own allows keeps
/// `*` early, so those allows outrank our `*` but not a key new to the merge: `*_*`
/// denies its `<server>_*` allows and the tail names each builtin we know.
///
/// The `read *` alias's `*` allow comes after every other read rule, so it would undo
/// a config layer's own nested read rules. A DiffOnly pin ignores `mirror` and emits
/// `*` and the `.env` carve-out keys all `deny` in both read rule sets, so the user's
/// read rules never open a diff-only run's reads (but see the residual). A ReadOnly
/// pin's `mirror` (from `opencode_read_mirror`) restores those nested read rules in
/// both read rule sets, in this order: `*` (`deny` when the user's last catch-all read
/// rule, `*`, `**` or `* *`, is anything but allow), the user's live allows, the `.env`
/// carve-out (`*.env.example` takes `*`'s action), then the user's denies and asks as
/// `deny`. An allow that some rule also denies is dropped, so denies win and every deny
/// lands after every allow: an allow carved out of a narrower deny (`secret/**` denied,
/// `secret/public/**` allowed) stays denied. Keys stay unique: a user allow equal to a
/// carve-out key is dropped, and a carve-out key the user denies moves to its place
/// among the denies, since left in place `*.env.*` would precede `*.env.example`'s
/// allow. `*` stays first, denied through its own value, so the last read rule is never
/// a bare `*` deny, which would disable the tool. A user's outright read deny (`"read":
/// "deny"`, a string `permission`, legacy `tools: {"read": false}`) therefore keeps the
/// tool on with every read denied. A user deny whose pattern is an array index (`2024`)
/// is emitted as `2024 *`, which matches it and more: `JSON.parse` would hoist the bare
/// key ahead of `*`. An index-shaped allow is hoisted that way, which only narrows the
/// pin. A ReadOnly pin denies `grep`, `glob` and `list`, each key and its ` *` alias in
/// place, when the user's config denies that tool outright, so read stays the one tool
/// left on. Otherwise they stay allowed, so a grep returns lines of files the read rules
/// deny and a glob or list names them; nested `grep`/`glob`/`list` patterns are not mirrored.
/// Residual: a config layer's `agent.<name>.permission` merges after this env pin, so
/// its allows re-open tools the pin denies (the agent a run uses: the default agent,
/// `build` unless `default_agent` names another, for DiffOnly reviews and generation
/// runs; `plan` for repo-aware reviews and Plan sessions; `gd-research` for Research).
/// Under a layer naming keys, an allow for any tool key we don't name still wins,
/// custom or plugin tools without an underscore (a global `deploy`) included; one that
/// also names `*_*` early re-opens `<x>_*` keys; one naming an alias spelling itself
/// moves that alias ahead of `*` as well; a picked server whose sanitized name plus `_`
/// prefixes a denied builtin (`external`, `doom`, `plan`) re-opens that builtin when a
/// global layer names it. A ` *` alias also admits a custom or plugin tool whose id is
/// its builtin's id, a space and more (`read all`). `<name>_*` also admits any loaded
/// server whose sanitized name starts with `<name>_`. The builtin MCP resource tools
/// (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) are
/// governed by `read`, so a ReadOnly run can read the resources of any connected MCP
/// server (read-only). Built by hand because the crate's `serde_json` map sorts keys.
fn opencode_permission_json(
    pin: OpencodePin,
    mcp_servers: &[&str],
    mirror: &OpencodeReadMirror,
) -> String {
    let mut out = String::from(r#"{"*":"deny","*_*":"deny","#);
    for name in mcp_servers {
        // opencode's tool-key sanitizer: every UTF-16 unit outside
        // `[A-Za-z0-9_-]` becomes `_`.
        let sanitized: String = name
            .encode_utf16()
            .map(|u| match char::from_u32(u32::from(u)) {
                Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
                _ => '_',
            })
            .collect();
        // Each allow, then its alias (see the doc).
        for key in [format!("{sanitized}_*"), format!("{sanitized}_?*")] {
            out.push_str(&serde_json::Value::String(key).to_string());
            out.push_str(r#":"allow","#);
        }
    }
    // DiffOnly ignores the user's read rules and denies every path (but see the
    // doc's residual).
    let deny_all = OpencodeReadMirror {
        star_denied: true,
        ..OpencodeReadMirror::default()
    };
    let mirror = match pin {
        OpencodePin::DiffOnly => &deny_all,
        OpencodePin::ReadOnly => mirror,
    };
    // `*.env` reads stay denied, mirroring opencode's own default carve-out
    // with its `ask` hardened to `deny`; the user's allows precede it and the
    // user's denies follow it. A carve-out key the user denies leaves the
    // carve-out for its place among the denies, so it follows every allow, as
    // plain opencode's appended user rules do.
    let respelled: Vec<String> = mirror
        .denies
        .iter()
        .map(|pattern| match js_array_index(pattern) {
            Some(_) => format!("{pattern} *"),
            None => pattern.clone(),
        })
        .collect();
    let denied: HashSet<&str> = mirror
        .denies
        .iter()
        .chain(&respelled)
        .map(String::as_str)
        .collect();
    let star = if mirror.star_denied || denied.contains("*") {
        "deny"
    } else {
        "allow"
    };
    let carve_out = [
        ("*.env", "deny"),
        ("*.env.*", "deny"),
        ("*.env.example", star),
    ];
    let mut read_rules = vec![("*", star)];
    // `*` stays first, its deny carried by `star`, so it is never the last rule.
    let mut keys: HashSet<&str> = HashSet::from(["*"]);
    for pattern in &mirror.allows {
        let pattern = pattern.as_str();
        let taken = carve_out.iter().any(|(key, _)| *key == pattern)
            || denied.contains(pattern)
            || keys.contains(pattern);
        if !taken {
            keys.insert(pattern);
            read_rules.push((pattern, "allow"));
        }
    }
    for rule in carve_out {
        if !denied.contains(rule.0) {
            keys.insert(rule.0);
            read_rules.push(rule);
        }
    }
    for pattern in &respelled {
        if keys.insert(pattern.as_str()) {
            read_rules.push((pattern.as_str(), "deny"));
        }
    }
    let read_rules: Vec<String> = read_rules
        .into_iter()
        .map(|(key, action)| {
            format!(
                r#"{}:"{action}""#,
                serde_json::Value::String(key.to_string())
            )
        })
        .collect();
    let read_rules = format!("{{{}}}", read_rules.join(","));
    for key in [r#""read":"#, r#""read *":"#] {
        out.push_str(key);
        out.push_str(&read_rules);
        out.push(',');
    }
    match pin {
        OpencodePin::DiffOnly => out.push_str(r#""grep":"deny","glob":"deny","list":"deny","#),
        OpencodePin::ReadOnly => {
            for tool in MIRRORED_TOOLS {
                let action = if mirror.denied_tools.contains(&tool) {
                    "deny"
                } else {
                    "allow"
                };
                out.push_str(&format!(r#""{tool}":"{action}","{tool} *":"{action}","#));
            }
        }
    }
    // Explicit keys, because a key an earlier config layer named keeps that
    // layer's position in the merged ruleset and would otherwise outrank `*`.
    out.push_str(concat!(
        r#""skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","#,
        r#""webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","#,
        r#""external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
    ));
    out
}

/// One config source an opencode run loads: a file, or `OPENCODE_CONFIG_CONTENT`.
#[derive(Debug, PartialEq, Eq)]
enum OpencodeConfigSource {
    File(PathBuf),
    Inline(String),
}

/// The local config sources an opencode 1.18.18 run loads given its env, in its load
/// order (`Config.loadInstanceState`): the global dir (`$XDG_CONFIG_HOME`, else
/// `<home>/.config`, joined with `opencode` on every OS) with `config.json`,
/// `opencode.json`, `opencode.jsonc`; the `OPENCODE_CONFIG` file (the app's
/// `config_path` when it passes one, else the inherited value); `opencode.json` and
/// `opencode.jsonc` in `<home>/.opencode` (home is `OPENCODE_TEST_HOME` when set) and
/// in `OPENCODE_CONFIG_DIR`; `OPENCODE_CONFIG_CONTENT`; then the managed dir's
/// `opencode.json` and `opencode.jsonc` (`OPENCODE_TEST_MANAGED_CONFIG_DIR`, else
/// `%ProgramData%\opencode`, `/Library/Application Support/opencode` or
/// `/etc/opencode`). The two dirs replay `ConfigPaths.directories`, a string-unique list
/// of the global dir and `<home>/.opencode` (both spelled as `path.join` spells them)
/// and `OPENCODE_CONFIG_DIR` (compared as written): an `OPENCODE_CONFIG_DIR` equal to
/// the global dir loads its pair right after `OPENCODE_CONFIG`, and one equal to
/// `<home>/.opencode` loads once. One equal to a project `.opencode` dir loads at that
/// dir's place, which isn't modeled. An empty variable reads as unset, as opencode's
/// truthy checks do, except `OPENCODE_TEST_HOME`, which opencode tests with `??`. A
/// relative path resolves against the child's spawn cwd, which is the `dir` passed here
/// (opencode loads config before `opencode run` chdirs into `--dir`), and so does a
/// drive-relative one (`C:cfg`) on `dir`'s own drive. One on another drive is skipped
/// and logged once, so its denies are lost.
/// Out of reach, not emulated: a global dir under a `\\` (UNC or device) root is never
/// deemed equal to `OPENCODE_CONFIG_DIR`, so that pair loads last; on POSIX a source is
/// read at its raw joined spelling, which the kernel resolves through symlinks before
/// `..`, while opencode normalizes lexically; a non-UTF-8 env value decodes lossily,
/// matching opencode only if Bun decodes it the same way (unverified); a bare-drive `X:`
/// base stays drive-relative, as Node's `path.join` keeps it, and maps like any
/// same-drive drive-relative path; the child's cwd for another drive (`=X:`) isn't
/// modeled.
/// Not listed: project config (`opencode.json(c)` and `.opencode/` dirs from the run
/// dir up), which reviews disable and Plan/Research sessions keep; remote sources (an
/// auth entry's `.well-known/opencode`, the console org config); macOS managed
/// preferences; and a legacy TOML `config`, which opencode folds into `config.json`.
fn opencode_config_sources(
    config_path: Option<&str>,
    dir: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> Vec<OpencodeConfigSource> {
    let var = |key: &str| env(key).filter(|value| !value.is_empty());
    let mut files: Vec<PathBuf> = Vec::new();
    let windows = cfg!(windows);
    let xdg = var("XDG_CONFIG_HOME");
    let global = xdg
        .clone()
        .map(PathBuf::from)
        .or_else(|| home.map(|h| h.join(".config")));
    if let Some(global) = global {
        let dir = global.join("opencode");
        files.extend(["config.json", "opencode.json", "opencode.jsonc"].map(|f| dir.join(f)));
    }
    let config = config_path
        .map(str::to_string)
        .or_else(|| var("OPENCODE_CONFIG"));
    files.extend(config.map(PathBuf::from));
    let test_home = env("OPENCODE_TEST_HOME");
    let dot_home = test_home
        .clone()
        .map(PathBuf::from)
        .or_else(|| home.map(Path::to_path_buf));
    // opencode's own spellings of the global dir and `<home>/.opencode`.
    let global_spelled = match &xdg {
        Some(xdg) => node_path_join(&[xdg, "opencode"], windows),
        None => home
            .and_then(Path::to_str)
            .and_then(|h| node_path_join(&[h, ".config", "opencode"], windows)),
    };
    let dot_spelled = test_home
        .as_deref()
        .or_else(|| home.and_then(Path::to_str))
        .and_then(|h| node_path_join(&[h, ".opencode"], windows));
    let config_dir = var("OPENCODE_CONFIG_DIR");
    let at_global = config_dir.is_some() && config_dir == global_spelled;
    let mut dirs = Vec::new();
    dirs.extend(config_dir.clone().filter(|_| at_global).map(PathBuf::from));
    dirs.extend(dot_home.map(|h| h.join(".opencode")));
    if !at_global && config_dir != dot_spelled {
        dirs.extend(config_dir.map(PathBuf::from));
    }
    for dir in dirs {
        files.extend(["opencode.json", "opencode.jsonc"].map(|f| dir.join(f)));
    }
    let drive = |path: &Path| match path.components().next() {
        Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
            std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => {
                Some(letter.to_ascii_uppercase())
            }
            _ => None,
        },
        _ => None,
    };
    let file = |path: PathBuf| {
        let drive_relative = !path.has_root()
            && matches!(
                path.components().next(),
                Some(std::path::Component::Prefix(_))
            );
        if !drive_relative {
            return Some(OpencodeConfigSource::File(dir.join(path)));
        }
        // The child resolves `C:cfg` against its cwd when that sits on drive C.
        if drive(&path).is_some() && drive(&path) == drive(dir) {
            let rest: PathBuf = path.components().skip(1).collect();
            return Some(OpencodeConfigSource::File(dir.join(rest)));
        }
        log_mirror_once(format!(
            "opencode config path {} is drive-relative; its read rules are not mirrored",
            path.display()
        ));
        None
    };
    let mut sources: Vec<OpencodeConfigSource> = files.into_iter().filter_map(&file).collect();
    sources.extend(var("OPENCODE_CONFIG_CONTENT").map(OpencodeConfigSource::Inline));
    let managed = var("OPENCODE_TEST_MANAGED_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                let data = var("ProgramData").unwrap_or_else(|| r"C:\ProgramData".into());
                PathBuf::from(data).join("opencode")
            } else if cfg!(target_os = "macos") {
                PathBuf::from("/Library/Application Support/opencode")
            } else {
                PathBuf::from("/etc/opencode")
            }
        });
    sources.extend(
        ["opencode.json", "opencode.jsonc"]
            .into_iter()
            .filter_map(|f| file(managed.join(f))),
    );
    sources
}

/// Node's `path.join`, which Bun's matches, as opencode's `===` compares its results:
/// empty parts drop, the rest join on the platform separator, and the result
/// normalizes (`/` reads as a separator on Windows too, empty and `.` segments drop, `..`
/// pops a segment). None for a Windows path under a `\\` root (UNC or device), whose
/// normalization isn't modeled.
fn node_path_join(parts: &[&str], windows: bool) -> Option<String> {
    let sep = if windows { "\\" } else { "/" };
    let is_sep = |c: char| c == '/' || (windows && c == '\\');
    let parts: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    let joined = parts.join(sep);
    if joined.is_empty() {
        return Some(".".to_string());
    }
    let mut chars = joined.chars();
    let (first, second, third) = (chars.next(), chars.next(), chars.next());
    let (device, absolute, rest) = match (first, second) {
        (Some(a), Some(b)) if windows && is_sep(a) && is_sep(b) => return None,
        (Some(a), _) if is_sep(a) => ("", true, &joined[1..]),
        (Some(a), Some(':')) if windows && a.is_ascii_alphabetic() => {
            match third.is_some_and(is_sep) {
                true => (&joined[..2], true, &joined[3..]),
                false => (&joined[..2], false, &joined[2..]),
            }
        }
        _ => ("", false, joined.as_str()),
    };
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split(is_sep) {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if absolute => {}
            _ => segments.push(segment),
        }
    }
    let mut tail = segments.join(sep);
    if tail.is_empty() && !absolute {
        tail.push('.');
    }
    if !tail.is_empty() && joined.ends_with(is_sep) {
        tail.push_str(sep);
    }
    let root = if absolute { sep } else { "" };
    Some(format!("{device}{root}{tail}"))
}

/// Parses config text the way opencode's loader does (jsonc-parser, trailing commas
/// allowed): `//` and `/* */` comments and trailing commas outside strings drop
/// before a strict parse; a `//` comment ends at CR or LF. None when it still isn't
/// JSON.
fn parse_jsonc<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    // Index in `out` of a comma that only whitespace has followed so far, and the
    // indexes of trailing commas, dropped in one pass at the end.
    let mut comma: Option<usize> = None;
    let mut trailing: Vec<usize> = Vec::new();
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            match c {
                '\\' => out.extend(chars.next()),
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '/' if chars.peek() == Some(&'/') => {
                while chars
                    .next_if(|&next| next != '\n' && next != '\r')
                    .is_some()
                {}
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = None;
                loop {
                    match chars.next() {
                        Some('/') if prev == Some('*') => break,
                        Some(next) => prev = Some(next),
                        None => return None,
                    }
                }
                out.push(' ');
            }
            c if c.is_whitespace() => out.push(c),
            c => {
                if let Some(at) = comma.take() {
                    if c == '}' || c == ']' {
                        trailing.push(at);
                    }
                }
                if c == ',' {
                    comma = Some(out.len());
                }
                in_string = c == '"';
                out.push(c);
            }
        }
    }
    let mut out = out.into_bytes();
    let mut trailing = trailing.into_iter().peekable();
    let mut at = 0;
    out.retain(|_| {
        let keep = trailing.next_if_eq(&at).is_none();
        at += 1;
        keep
    });
    serde_json::from_slice(&out).ok()
}

/// A config value as opencode's JS parse holds it: an object's entries in JS property
/// order (array-index keys ascending, then the rest in first-seen order; a repeated key
/// keeps its first position and takes its last value, as `JSON.parse` and jsonc-parser
/// do), a string, or any other value by its JS truthiness (all a legacy `tools` flag
/// needs). serde_json's own map sorts keys, which would hide rule order.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ConfigValue {
    Object(Vec<(String, ConfigValue)>),
    String(String),
    Other(bool),
}

/// `key`'s value as a JS array index, the keys JS property order puts first.
fn js_array_index(key: &str) -> Option<u32> {
    let canonical = key == "0"
        || (!key.is_empty() && !key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    canonical
        .then(|| key.parse::<u32>().ok())
        .flatten()
        .filter(|&index| index != u32::MAX)
}

/// Puts first-seen-ordered entries in JS property order (a stable sort).
fn js_order(entries: &mut [(String, ConfigValue)]) {
    entries.sort_by_key(|(key, _)| js_array_index(key).map_or((1, 0), |index| (0, index)));
}

/// Sets `key` as a JS assignment does: an existing key keeps its position.
fn js_set(
    entries: &mut Vec<(String, ConfigValue)>,
    at: &mut HashMap<String, usize>,
    key: String,
    value: ConfigValue,
) {
    match at.get(&key) {
        Some(&index) => entries[index].1 = value,
        None => {
            at.insert(key.clone(), entries.len());
            entries.push((key, value));
        }
    }
}

impl<'de> Deserialize<'de> for ConfigValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ConfigValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<ConfigValue, E> {
                Ok(ConfigValue::Other(v))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<ConfigValue, E> {
                Ok(ConfigValue::Other(v != 0))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<ConfigValue, E> {
                Ok(ConfigValue::Other(v != 0))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<ConfigValue, E> {
                Ok(ConfigValue::Other(v != 0.0 && !v.is_nan()))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<ConfigValue, E> {
                Ok(ConfigValue::String(v.to_string()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<ConfigValue, E> {
                Ok(ConfigValue::Other(false))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<ConfigValue, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(ConfigValue::Other(true))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<ConfigValue, A::Error> {
                let (mut entries, mut at) = (Vec::new(), HashMap::new());
                while let Some((key, value)) = map.next_entry::<String, ConfigValue>()? {
                    js_set(&mut entries, &mut at, key, value);
                }
                js_order(&mut entries);
                Ok(ConfigValue::Object(entries))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

/// remeda's `mergeDeep`, which opencode 1.18.18 merges config layers with: `dest`'s keys
/// keep their positions, `src`'s new keys follow, and a key both hold takes `src`'s
/// value, merged recursively when both are objects.
fn merge_deep(
    mut dest: Vec<(String, ConfigValue)>,
    src: Vec<(String, ConfigValue)>,
) -> Vec<(String, ConfigValue)> {
    let mut at: HashMap<String, usize> = dest
        .iter()
        .enumerate()
        .map(|(index, (key, _))| (key.clone(), index))
        .collect();
    for (key, value) in src {
        let Some(&index) = at.get(&key) else {
            at.insert(key.clone(), dest.len());
            dest.push((key, value));
            continue;
        };
        let slot = &mut dest[index].1;
        *slot = match (std::mem::replace(slot, ConfigValue::Other(false)), value) {
            (ConfigValue::Object(old), ConfigValue::Object(new)) => {
                ConfigValue::Object(merge_deep(old, new))
            }
            (_, value) => value,
        };
    }
    js_order(&mut dest);
    dest
}

/// opencode's `Wildcard.match` (1.18.18): `\` reads as `/` on both sides, `*` matches
/// any run and `?` one character, anything else matches itself case-insensitively
/// (regex flags "si"; exact for ASCII keys, as JS folds no non-ASCII character to
/// ASCII), and a trailing ` *` also matches the bare prefix.
fn wildcard_matches(pattern: &str, key: &str) -> bool {
    // Greedy match, backtracking to the last `*`, so no pattern costs more than
    // pattern length times key length.
    fn glob(p: &[char], k: &[char]) -> bool {
        let (mut pi, mut ki) = (0, 0);
        let mut star: Option<(usize, usize)> = None;
        while ki < k.len() {
            match p.get(pi) {
                Some('*') => {
                    star = Some((pi, ki));
                    pi += 1;
                }
                Some(&c) if c == '?' || c.eq_ignore_ascii_case(&k[ki]) => {
                    pi += 1;
                    ki += 1;
                }
                _ => match star {
                    Some((sp, sk)) => {
                        star = Some((sp, sk + 1));
                        pi = sp + 1;
                        ki = sk + 1;
                    }
                    None => return false,
                },
            }
        }
        p[pi..].iter().all(|&c| c == '*')
    }
    let chars = |s: &str| s.replace('\\', "/").chars().collect::<Vec<char>>();
    let (p, k) = (chars(pattern), chars(key));
    p.strip_suffix(&[' ', '*'])
        .is_some_and(|bare| glob(bare, &k))
        || glob(&p, &k)
}

/// The user's read rules a ReadOnly pin mirrors (see `opencode_permission_json`), read
/// from the merged `permission` the way opencode's `fromConfig` flattens it: top-level
/// keys in merged order, a string value as one rule on pattern `*`, an object's rules in
/// its order, kept when the key matches the tool under opencode's matcher (`*`, `r*`,
/// `READ` for read). A catch-all is any pattern matching every input (`*`, `**`, `* *`,
/// `** *`; see `catch_all`), and one whose action is not allow, deny or ask counts as a
/// deny (failing closed); any other rule with such an action is skipped. `star_denied`:
/// the last catch-all read rule closes (no catch-all rule allows). `allows`: the allow
/// patterns after the last closing catch-all; one before it is dead in plain opencode.
/// `denies`: every deny or ask pattern wherever it sits, so a deny a later rule allows
/// is still mirrored. Both deduped, first-seen order, catch-alls left out.
/// `denied_tools`: each of grep, glob and list whose last catch-all rule closes it.
/// Approximate: the pin emits every deny after every allow, so it can be narrower than
/// plain opencode but never wider, for the rules mirrored.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct OpencodeReadMirror {
    star_denied: bool,
    allows: Vec<String>,
    denies: Vec<String>,
    denied_tools: Vec<&'static str>,
}

/// The tools besides read whose outright deny a ReadOnly pin mirrors.
const MIRRORED_TOOLS: [&str; 3] = ["grep", "glob", "list"];

/// Whether `pattern` matches every input: a non-empty run of `*`, alone or followed by
/// one ` *` (opencode's matcher makes a trailing ` *` optional).
fn catch_all(pattern: &str) -> bool {
    let run = pattern.strip_suffix(" *").unwrap_or(pattern);
    !run.is_empty() && run.bytes().all(|b| b == b'*')
}

impl OpencodeReadMirror {
    fn from_permission(permission: &[(String, ConfigValue)]) -> Self {
        let rules_for = |tool: &str| {
            let mut rules: Vec<(&str, &str)> = Vec::new();
            for (key, value) in permission {
                if !wildcard_matches(key, tool) {
                    continue;
                }
                match value {
                    ConfigValue::String(action) => rules.push(("*", action)),
                    ConfigValue::Object(patterns) => {
                        for (pattern, action) in patterns {
                            if let ConfigValue::String(action) = action {
                                rules.push((pattern, action));
                            }
                        }
                    }
                    ConfigValue::Other(_) => {}
                }
            }
            rules
        };
        let closes = |&(pattern, action): &(&str, &str)| catch_all(pattern) && action != "allow";
        let closed = |rules: &[(&str, &str)]| {
            let last = rules.iter().rev().find(|(pattern, _)| catch_all(pattern));
            last.is_some_and(closes)
        };
        let rules = rules_for("read");
        let last_star_deny = rules.iter().rposition(closes);
        let mut mirror = Self {
            star_denied: closed(&rules),
            denied_tools: MIRRORED_TOOLS
                .into_iter()
                .filter(|tool| closed(&rules_for(tool)))
                .collect(),
            ..Self::default()
        };
        let mut seen: HashSet<(bool, &str)> = HashSet::new();
        for (index, &(pattern, action)) in rules.iter().enumerate() {
            let (set, deny) = match action {
                "allow" if last_star_deny.is_none_or(|at| index > at) => {
                    (&mut mirror.allows, false)
                }
                "deny" | "ask" => (&mut mirror.denies, true),
                _ => continue,
            };
            if !catch_all(pattern) && seen.insert((deny, pattern)) {
                set.push(pattern.to_string());
            }
        }
        mirror
    }
}

/// What reading one config file gave the resolver.
#[derive(Debug, PartialEq, Eq)]
enum ConfigRead {
    Missing,
    TooLarge,
    Bytes(Vec<u8>),
}

/// The largest config file the resolver reads; a larger one is skipped (logged once).
const OPENCODE_CONFIG_CAP: usize = 4 << 20;

/// Reads a config file for the resolver: anything but a regular file (a directory, a
/// FIFO) is missing, and the read stops past the cap. The type check reads the opened
/// handle, never the path, so nothing swapped in between can reach the read; Unix
/// opens with `O_NONBLOCK`, because a FIFO's open otherwise waits for a writer (it
/// doesn't change regular-file reads).
fn read_config_file(path: &Path) -> ConfigRead {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flags: libc::c_int = libc::O_NONBLOCK;
        options.custom_flags(flags);
    }
    let Ok(file) = options.open(path) else {
        return ConfigRead::Missing;
    };
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return ConfigRead::Missing;
    }
    let mut bytes = Vec::new();
    match file
        .take(OPENCODE_CONFIG_CAP as u64 + 1)
        .read_to_end(&mut bytes)
    {
        Ok(_) if bytes.len() > OPENCODE_CONFIG_CAP => ConfigRead::TooLarge,
        Ok(_) => ConfigRead::Bytes(bytes),
        Err(_) => ConfigRead::Missing,
    }
}

/// opencode's `{env:NAME}` substitution over raw config text (`ConfigVariable`'s
/// `/\{env:([^}]+)\}/g`): unset or empty gives "". `{file:...}` is not substituted,
/// so a pattern built from one is mirrored literally.
fn substitute_env(text: &str, env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("{env:") {
        let after = &rest[at + "{env:".len()..];
        match after.find('}') {
            None => break,
            Some(0) => {
                out.push_str(&rest[..=at]);
                rest = &rest[at + 1..];
            }
            Some(end) => {
                out.push_str(&rest[..at]);
                out.push_str(&env(&after[..end]).unwrap_or_default());
                rest = &after[end + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Logs `message` once per process: names only, never config content.
fn log_mirror_once(message: String) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let first = LOGGED
        .get_or_init(Mutex::default)
        .lock()
        .is_ok_and(|mut logged| logged.insert(message.clone()));
    if first {
        eprintln!("gitdesktop: {message}");
    }
}

/// The home opencode 1.18.18 resolves (Bun's `os.homedir()`): `USERPROFILE` on Windows,
/// `HOME` elsewhere; unset asks the OS (`os_home`). An empty `USERPROFILE` gives None,
/// so the home sources are skipped: opencode exits at startup on one (measured,
/// Windows). An empty `HOME` asks the OS like an unset one (measured on Linux; macOS,
/// unprobed, shares Bun's POSIX path).
fn opencode_home(
    env: &dyn Fn(&str) -> Option<String>,
    windows: bool,
    os_home: &dyn Fn() -> Option<PathBuf>,
) -> Option<PathBuf> {
    match env(if windows { "USERPROFILE" } else { "HOME" }) {
        Some(home) if home.is_empty() && windows => None,
        Some(home) if !home.is_empty() => Some(PathBuf::from(home)),
        _ => os_home(),
    }
}

/// [`opencode_read_mirror`] over its env, home and file reads, replaying opencode
/// 1.18.18's `Config.loadInstanceState`: each source's text is decoded lossily (as
/// opencode's decoder does), `{env:}`-substituted and JSONC-parsed in source order, and
/// its `permission` (a string reads as `{"*": <it>}`, as opencode's schema decodes it)
/// and `tools` merged into the layers before it (`merge_deep`). An inherited
/// `OPENCODE_PERMISSION`, which the pin replaces on the child, merges after the files as
/// strict JSON (opencode uses `JSON.parse`); then the legacy `tools` map, each flag as
/// its key's `allow` or `deny` (`write`/`edit`/`patch` as `edit`), has the merged
/// `permission` merged onto it: the map's keys keep their positions and take
/// permission's values, and permission's other keys follow. A missing, unreadable or
/// empty source contributes nothing; an over-cap or unparseable one is logged once by
/// name. Residuals: such a skipped source's read rules don't bind ReadOnly-pinned runs, and so
/// are lost: a file over the cap, and JSON that `JSON.parse` and jsonc-parser accept but
/// serde_json rejects (a lone surrogate escape, nesting deeper than 128, a float such
/// as `1e400`).
fn opencode_read_mirror_with(
    config_path: Option<&str>,
    dir: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
    read: &dyn Fn(&Path) -> ConfigRead,
) -> OpencodeReadMirror {
    let mut permission: Vec<(String, ConfigValue)> = Vec::new();
    let mut tools: Option<Vec<(String, ConfigValue)>> = None;
    for source in opencode_config_sources(config_path, dir, env, home) {
        let (name, text) = match source {
            OpencodeConfigSource::File(path) => match read(&path) {
                ConfigRead::Bytes(bytes) => (
                    path.display().to_string(),
                    String::from_utf8_lossy(&bytes).into_owned(),
                ),
                ConfigRead::TooLarge => {
                    log_mirror_once(format!(
                        "opencode config {} is over 4 MiB; its read rules are not mirrored",
                        path.display()
                    ));
                    continue;
                }
                ConfigRead::Missing => continue,
            },
            OpencodeConfigSource::Inline(text) => ("OPENCODE_CONFIG_CONTENT".to_string(), text),
        };
        if text.trim().is_empty() {
            continue;
        }
        let Some(config) = parse_jsonc::<ConfigValue>(&substitute_env(&text, env)) else {
            log_mirror_once(format!(
                "opencode config {name} is not valid JSONC; its read rules are not mirrored"
            ));
            continue;
        };
        let ConfigValue::Object(config) = config else {
            continue;
        };
        for (key, value) in config {
            match (key.as_str(), value) {
                ("permission", ConfigValue::String(action)) => {
                    let star = vec![("*".to_string(), ConfigValue::String(action))];
                    permission = merge_deep(permission, star);
                }
                ("permission", ConfigValue::Object(layer)) => {
                    permission = merge_deep(permission, layer);
                }
                ("tools", ConfigValue::Object(layer)) => {
                    tools = Some(merge_deep(tools.unwrap_or_default(), layer));
                }
                _ => {}
            }
        }
    }
    if let Some(inherited) = env("OPENCODE_PERMISSION").filter(|value| !value.is_empty()) {
        match serde_json::from_str::<ConfigValue>(&inherited) {
            Ok(ConfigValue::Object(layer)) => permission = merge_deep(permission, layer),
            // opencode spreads a non-object into index keys, which `read` never matches.
            Ok(_) => {}
            Err(_) => log_mirror_once(
                "inherited OPENCODE_PERMISSION is not valid JSON; its read rules are not mirrored"
                    .to_string(),
            ),
        }
    }
    if let Some(tools) = tools {
        let (mut legacy, mut at) = (Vec::new(), HashMap::new());
        for (tool, enabled) in tools {
            let on = match &enabled {
                ConfigValue::String(value) => !value.is_empty(),
                ConfigValue::Object(_) => true,
                ConfigValue::Other(truthy) => *truthy,
            };
            let key = match tool.as_str() {
                "write" | "edit" | "patch" => "edit".to_string(),
                _ => tool,
            };
            let action = if on { "allow" } else { "deny" };
            js_set(
                &mut legacy,
                &mut at,
                key,
                ConfigValue::String(action.to_string()),
            );
        }
        js_order(&mut legacy);
        permission = merge_deep(legacy, permission);
    }
    OpencodeReadMirror::from_permission(&permission)
}

/// The env edits a spawn makes, keyed as the platform compares names (`fold`: Windows
/// folds case).
struct ChildEnvEdits {
    fold: bool,
    vars: HashMap<String, Option<String>>,
}

impl ChildEnvEdits {
    fn key(&self, name: &str) -> String {
        if self.fold {
            name.to_ascii_uppercase()
        } else {
            name.to_string()
        }
    }
}

impl ChildEnv for ChildEnvEdits {
    fn set_var(&mut self, key: &str, value: &str) {
        self.vars.insert(self.key(key), Some(value.to_string()));
    }
    fn unset_var(&mut self, key: &str) {
        self.vars.insert(self.key(key), None);
    }
}

/// The env an opencode child sees, for the read mirror: `inherited` (the app's env)
/// under the edits every opencode spawn makes (`sanitize_child_env_with` over
/// `overrides` and `merged_path`, `NO_COLOR`, `CLICOLOR`, `OPENCODE_CONFIG`,
/// `OPENCODE_DISABLE_MODELS_FETCH`), names compared case-folded when `fold`. An edit's
/// set value wins and its unset reads None. An inherited value that isn't valid Unicode
/// decodes lossily, so its slot stays taken (a path from it names no file) and never
/// falls back to the slot's default; only an unset value does.
fn opencode_child_env<'a>(
    config_path: Option<&str>,
    overrides: &[(&str, Option<String>)],
    merged_path: Option<&str>,
    fold: bool,
    inherited: &'a dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> impl Fn(&str) -> Option<String> + 'a {
    let mut edits = ChildEnvEdits {
        fold,
        vars: HashMap::new(),
    };
    sanitize_child_env_with(&mut edits, overrides, merged_path);
    for (key, value) in [
        ("NO_COLOR", "1"),
        ("CLICOLOR", "0"),
        ("OPENCODE_DISABLE_MODELS_FETCH", "1"),
    ] {
        edits.set_var(key, value);
    }
    if let Some(path) = config_path {
        edits.set_var("OPENCODE_CONFIG", path);
    }
    move |key: &str| match edits.vars.get(&edits.key(key)) {
        Some(value) => value.clone(),
        None => inherited(key).map(|value| value.to_string_lossy().into_owned()),
    }
}

/// The read rules the user's local opencode config sets, for a ReadOnly-pinned run's mirror (see
/// `opencode_config_sources` for the sources). `config_path` is the `OPENCODE_CONFIG`
/// the app passes the run and `dir` its `--dir` and spawn cwd. Sources and `{env:}`
/// read the child's env (`opencode_child_env`). Residuals: the pin itself, a review's
/// `OPENCODE_DISABLE_PROJECT_CONFIG` and Research's `OPENCODE_ENABLE_EXA` read the app's
/// values; `PATH` and the shell-PATH marker are read before the spawn waits on an
/// in-flight shell capture, so they can differ from the child's; and opencode's
/// well-known auth tokens, which outrank the env for `{env:}`, aren't consulted. Empty
/// under test, so no test reads the real user config: tests drive
/// [`opencode_read_mirror_with`] and [`opencode_child_env`].
fn opencode_read_mirror(config_path: Option<&str>, dir: &Path) -> OpencodeReadMirror {
    if cfg!(test) {
        return OpencodeReadMirror::default();
    }
    // `std::env::var_os` may panic on an empty key or one holding `=` or NUL.
    let inherited = |key: &str| {
        (!key.is_empty() && !key.contains(['=', '\0']))
            .then(|| std::env::var_os(key))
            .flatten()
    };
    let env = opencode_child_env(
        config_path,
        child_env_overrides(),
        merged_shell_path().as_deref(),
        cfg!(windows),
        &inherited,
    );
    let home = opencode_home(&env, cfg!(windows), &std::env::home_dir);
    opencode_read_mirror_with(config_path, dir, &env, home.as_deref(), &read_config_file)
}

/// The whole extra env of an `agent_review` spawn. Every opencode review is
/// pinned read-only with project config disabled, so neither a hostile diff nor
/// the repo's `opencode.json`/`.opencode/`/AGENTS.md can widen it; `OPENCODE_CONFIG`
/// (the self-MCP config) still loads under that flag. `COPILOT_ALLOW_ALL=false`
/// rides only the diff-only arm without self-MCP: that arm never passes
/// `--allow-all-tools`, so no env-vs-flag precedence is involved. `mirror` is the
/// user's mirrored read rules (`opencode_read_mirror`), empty for a DiffOnly run,
/// whose pin ignores it.
fn review_env(
    kind: AgentKind,
    repo_aware: bool,
    mcp_config_path: Option<&str>,
    self_mcp_servers: &[&str],
    mirror: &OpencodeReadMirror,
) -> Vec<(&'static str, String)> {
    match kind {
        AgentKind::Opencode => {
            let mut env = Vec::new();
            if let Some(path) = mcp_config_path {
                env.push(("OPENCODE_CONFIG", path.to_string()));
            }
            // Long-lived app-managed runs must not fork opencode's detached catalog
            // refresh (stray-grandchild churn); the `agent_models` probe refreshes it.
            env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
            let pin = if repo_aware {
                OpencodePin::ReadOnly
            } else {
                OpencodePin::DiffOnly
            };
            env.push((
                "OPENCODE_PERMISSION",
                opencode_permission_json(pin, self_mcp_servers, mirror),
            ));
            env.push(("OPENCODE_DISABLE_PROJECT_CONFIG", "1".to_string()));
            env
        }
        AgentKind::Copilot if !repo_aware && mcp_config_path.is_none() => {
            vec![("COPILOT_ALLOW_ALL", "false".to_string())]
        }
        AgentKind::Copilot | AgentKind::Claude | AgentKind::Codex => Vec::new(),
    }
}

/// The whole opencode env of an `agent_session` spawn (host and container). A
/// read-only session carries the `ReadOnly` pin (its `<name>_*` allows only for
/// servers it passes, and Plan/Research pass none today), but keeps the repo's
/// project config, so the repo's own opencode config (agent `permission`,
/// `.opencode/agent/*.md`, plugins) can re-enable tools there, and its read rules
/// aren't mirrored: `mirror` holds those of the run's other local config sources
/// (`opencode_read_mirror`). A container passes none: its opencode loads none of the
/// host's files, and configs baked into its image aren't mirrored either.
/// A write-capable session carries no pin: its worktree confines it.
fn opencode_session_env(
    read_only: bool,
    research: bool,
    config_path: Option<String>,
    mcp_servers: &[&str],
    mirror: &OpencodeReadMirror,
) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    if let Some(path) = config_path {
        env.push(("OPENCODE_CONFIG", path));
    }
    env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
    if research {
        // Enable opencode's Exa-backed websearch tool (webfetch works regardless).
        env.push(("OPENCODE_ENABLE_EXA", "1".to_string()));
    }
    if read_only {
        env.push((
            "OPENCODE_PERMISSION",
            opencode_permission_json(OpencodePin::ReadOnly, mcp_servers, mirror),
        ));
    }
    env
}

/// App effort level → opencode `--variant` (provider-specific reasoning effort).
/// opencode documents `minimal` / `high` / `max`; "medium" / "" use the model's
/// default (omit).
fn opencode_variant(level: &str) -> Option<&'static str> {
    match level {
        "low" => Some("minimal"),
        "high" => Some("high"),
        "xhigh" => Some("max"),
        _ => None,
    }
}

/// Normalize a Claude/opencode-style tool NAME to a timeline category. Unknown
/// names fall through to "other" so the step still shows (just generically). The
/// frontend maps each category to an icon + verb.
pub(crate) fn normalize_tool(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "read" => "read",
        "grep" | "search" => "search",
        "glob" | "list" | "ls" => "list",
        "edit" | "multiedit" | "patch" | "apply_patch" | "applypatch" => "edit",
        "write" | "create" => "write",
        "bash" | "shell" | "run" | "execute" => "run",
        "webfetch" | "fetch" => "web-fetch",
        "websearch" => "web-search",
        "task" | "agent" => "task",
        _ => "other",
    }
}

/// Pull the most useful "target" out of a tool-call input object: the file path,
/// command, URL, or query — whatever the tool acted on. None when nothing fits.
pub(crate) fn tool_target(input: &serde_json::Value) -> Option<String> {
    // Path keys first. The FULL path is kept un-clipped: the UI uses it as a git
    // pathspec for the inline edit-step diff, so any clipping would corrupt it.
    // Display shortening happens via relativize + CSS.
    const PATH_KEYS: &[&str] = &["file_path", "filePath", "path", "notebook_path"];
    // Free-text keys (command / URL / query / prompt) are display-only: clipped to
    // a sane payload size, newlines preserved.
    const TEXT_KEYS: &[&str] = &["command", "cmd", "url", "query", "pattern", "prompt"];
    for k in PATH_KEYS {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    for k in TEXT_KEYS {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(clip_target(t));
            }
        }
    }
    None
}

/// Bound a free-text target to a sane payload size. NOT whitespace-collapsed:
/// the UI renders the row single-line via CSS and an expandable view shows the
/// command verbatim, so newlines must survive.
fn clip_target(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > 2000 {
        let truncated: String = t.chars().take(2000).collect();
        format!("{truncated}…")
    } else {
        t.to_string()
    }
}

/// Codex `exec` runs as a read-only agent — there is no diff-only mode, it
/// always explores via shell read commands. Globals (`--cd`/`-a`/`-s`/`-m`)
/// must precede `exec`; the prompt is read from stdin via the `-` sentinel.
fn codex_review_args(model: &str, repo_path: &str, effort: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--cd".into(),
        repo_path.into(),
        "--ask-for-approval".into(),
        "never".into(), // no approval path ⇒ writes/network denied, never prompts
        "--sandbox".into(),
        "read-only".into(),
    ];
    if !model.trim().is_empty() {
        args.push("-m".into());
        args.push(model.into());
    }
    args.push("exec".into());
    args.push("--json".into());
    if let Some(e) = codex_effort(effort) {
        args.push("-c".into());
        args.push(format!("model_reasoning_effort=\"{e}\""));
    }
    args.push("-".into());
    args
}

/// Classify a Codex shell command into a timeline category (it reads/searches by
/// running `Get-Content`/`cat`/`rg`/… in its sandbox, and edits via `apply_patch`).
fn codex_command_kind(cmd: &str) -> &'static str {
    let lower = cmd.to_lowercase();
    if lower.contains("apply_patch") {
        "edit"
    } else if lower.contains("get-content") || lower.contains("cat ") || lower.contains("type ") {
        "read"
    } else if lower.contains("rg ") || lower.contains("grep") || lower.contains("select-string") {
        "search"
    } else if lower.contains("get-childitem") || lower.contains("ls ") || lower.contains("dir ") {
        "list"
    } else {
        "run"
    }
}

/// Parses one line of Codex `exec --json` (JSONL). Accumulates the latest
/// `agent_message` into `last_message` (the final one is the review) and emits
/// `Done` at the terminal `turn.completed`.
fn parse_codex_line(line: &str, last_message: &mut String) -> Option<ReviewEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "thread.started" => v
            .get("thread_id")
            .and_then(|t| t.as_str())
            .map(|id| ReviewEvent::NativeSession { id: id.to_string() }),
        "item.started" => {
            let item = v.get("item")?;
            if item.get("type")?.as_str()? == "command_execution" {
                let cmd = item.get("command").and_then(|c| c.as_str()).unwrap_or("");
                return Some(ReviewEvent::Tool {
                    tool: codex_command_kind(cmd).to_string(),
                    target: if cmd.is_empty() {
                        None
                    } else {
                        Some(clip_target(cmd))
                    },
                });
            }
            None
        }
        "item.completed" => {
            let item = v.get("item")?;
            if item.get("type")?.as_str()? == "agent_message" {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    *last_message = text.to_string();
                }
            }
            None // codex emits whole messages, not deltas; surface at turn end
        }
        "turn.completed" => Some(ReviewEvent::Done {
            text: std::mem::take(last_message),
            is_error: false,
            cost_usd: None,
        }),
        "turn.failed" => Some(ReviewEvent::error(
            "Codex review failed — see the Codex CLI for details.",
        )),
        "error" => Some(ReviewEvent::error(
            v.get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Codex reported an error."),
        )),
        _ => None,
    }
}

/// Parses one line of Copilot CLI `--output-format json` (JSONL). Streams
/// `message_delta.deltaContent` as narration, keeps the latest
/// `assistant.message.content` as the final text, emits `Done` at `result` — a
/// `session.error` (whose message becomes the failure reason) or a non-zero
/// `exitCode` fails the run. Setup/MCP/skills/reasoning events ignored.
///
/// A `\n\n` is lazily PREPENDED to the first non-empty delta after a completed
/// message, so the delta buffer still ENDS WITH `Done.text` (frontend invariant —
/// success path only; an errored `Done` carries the failure reason instead).
fn parse_copilot_line(
    line: &str,
    last_message: &mut String,
    emitted_text: &mut bool,
    pending_sep: &mut bool,
    error_message: &mut Option<String>,
) -> Option<ReviewEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "assistant.message_delta" => {
            let t = v
                .get("data")
                .and_then(|d| d.get("deltaContent"))
                .and_then(|t| t.as_str())?;
            // Empty deltas are dropped (Claude's parser still emits an empty Delta).
            // Both leave `pending_sep` armed — the separator belongs on the first
            // REAL text.
            if t.is_empty() {
                return None;
            }
            let text = if *pending_sep {
                *pending_sep = false;
                format!("\n\n{t}")
            } else {
                t.to_string()
            };
            *emitted_text = true;
            Some(ReviewEvent::Delta { text })
        }
        "assistant.message" => {
            if let Some(text) = v
                .get("data")
                .and_then(|d| d.get("content"))
                .and_then(|t| t.as_str())
            {
                *last_message = text.to_string();
            }
            // A completed message: separate the next message's narration from this one.
            if *emitted_text {
                *pending_sep = true;
            }
            None
        }
        "tool.execution_start" => {
            let data = v.get("data");
            let name = data
                .and_then(|d| d.get("name").or_else(|| d.get("tool")))
                .and_then(|t| t.as_str())
                .unwrap_or("a tool");
            // Copilot's argument shape isn't documented; try a nested `arguments`
            // object, then the data object itself — best-effort, None if neither fits.
            let target = data
                .and_then(|d| d.get("arguments"))
                .and_then(tool_target)
                .or_else(|| data.and_then(tool_target));
            Some(ReviewEvent::Tool {
                tool: normalize_tool(name).to_string(),
                target,
            })
        }
        "session.error" => {
            // The CLI still exits 0 after a session error, so this message is the only
            // failure reason there is — keep it whole, whatever prose already streamed.
            // A later genuine recovery now fails the run too; acceptable for a CLI whose
            // only other verdict is the exit code.
            *error_message = Some(
                v.get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Copilot reported an error.")
                    .to_string(),
            );
            None // surfaced at the terminal `result`
        }
        "result" => {
            // An errored `Done` carries the REASON, not the prose (which stays in the
            // delta stream): the buffer-ends-with-`Done.text` peel runs only on a
            // successful settle — both frontend consumers reject on `is_error` first.
            let (text, is_error) = match error_message.take() {
                Some(msg) => (msg, true),
                None => (
                    std::mem::take(last_message),
                    v.get("exitCode").and_then(|c| c.as_i64()).unwrap_or(0) != 0,
                ),
            };
            Some(ReviewEvent::Done {
                text,
                is_error,
                cost_usd: None,
            })
        }
        _ => None,
    }
}

/// Parses one line of opencode `run --format json` (JSONL). There is **no**
/// single terminal event: `step_finish` with `reason == "stop"` ends the turn
/// (`"tool-calls"` means another step follows). It emits whole `text` parts, not
/// token deltas, so we stream them as deltas AND accumulate.
///
/// `Done` carries only the FINAL step's text (`step_text`) — earlier narration
/// stays in the delta stream; `last_message` is the fallback for a final step
/// with no text. The `sessionID` is surfaced as `NativeSession` (store de-dups).
fn parse_opencode_line(
    line: &str,
    last_message: &mut String,
    step_text: &mut String,
) -> Option<ReviewEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        // First event of the run carries the session id we need for resume. A new
        // step starts here — reset the per-step accumulator so `Done` reflects only
        // the final step's text.
        "step_start" => {
            step_text.clear();
            v.get("sessionID")
                .and_then(|s| s.as_str())
                .map(|id| ReviewEvent::NativeSession { id: id.to_string() })
        }
        "text" => {
            let text = v.get("part")?.get("text")?.as_str()?;
            if text.is_empty() {
                return None;
            }
            // Separate consecutive segments so multi-step narration stays readable.
            let chunk = if last_message.is_empty() {
                text.to_string()
            } else {
                format!("\n\n{text}")
            };
            last_message.push_str(&chunk);
            // Mirror into the per-step accumulator (join parts within a step the same
            // way) so `Done.text` can carry the final step verbatim as the buffer tail.
            if step_text.is_empty() {
                step_text.push_str(text);
            } else {
                step_text.push_str(&format!("\n\n{text}"));
            }
            Some(ReviewEvent::Delta { text: chunk })
        }
        "tool_use" => {
            let part = v.get("part");
            let tool = part
                .and_then(|p| p.get("tool"))
                .and_then(|t| t.as_str())
                .unwrap_or("a tool");
            let target = part
                .and_then(|p| p.get("state"))
                .and_then(|s| s.get("input"))
                .and_then(tool_target);
            Some(ReviewEvent::Tool {
                tool: normalize_tool(tool).to_string(),
                target,
            })
        }
        "step_finish" => {
            let reason = v
                .get("part")
                .and_then(|p| p.get("reason"))
                .and_then(|r| r.as_str())
                .unwrap_or("stop");
            // More steps follow a tool call; only a non-tool finish ends the turn.
            if reason == "tool-calls" {
                return None;
            }
            // Final step's text is the answer; fall back to the accumulation only when
            // the final step produced none (never emit an empty Done when text existed).
            let text = std::mem::take(step_text);
            let text = if text.is_empty() {
                std::mem::take(last_message)
            } else {
                text
            };
            Some(ReviewEvent::Done {
                text,
                is_error: false,
                cost_usd: None,
            })
        }
        "error" => Some(ReviewEvent::error(
            v.get("error")
                .and_then(|e| e.get("message").or(Some(e)))
                .and_then(|m| m.as_str())
                .unwrap_or("opencode reported an error."),
        )),
        _ => None,
    }
}

/// Parses one NDJSON line of Claude `--output-format stream-json`; the terminal
/// `result` emits `Done`. `tool_inputs` accumulates each in-flight tool call's
/// streamed input JSON by block index (input arrives as `input_json_delta`
/// fragments); the block's stop emits one `Tool` event.
///
/// A `\n\n` is lazily PREPENDED to the first non-empty `text_delta` after a
/// completed TEXT block, so the delta buffer still ENDS WITH `Done.text` (the
/// raw `result`, never separator-prefixed) — the frontend's suffix-strip relies
/// on that.
///
/// `synthetic_error` carries the text of a synthetic API-error assistant message
/// forward to the terminal line; see `claude_result_is_error` for why the CLI's
/// own `is_error` flag can't be trusted alone.
fn parse_claude_line(
    line: &str,
    tool_inputs: &mut std::collections::HashMap<i64, (String, String)>,
    emitted_text: &mut bool,
    pending_sep: &mut bool,
    synthetic_error: &mut Option<String>,
) -> Option<ReviewEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    match v.get("type")?.as_str()? {
        "stream_event" => {
            let event = v.get("event")?;
            match event.get("type")?.as_str()? {
                // A tool call begins: record its name + index so the input fragments
                // that follow can be accumulated and emitted as one step at stop.
                "content_block_start" => {
                    let block = event.get("content_block")?;
                    if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                        if let Some(idx) = event.get("index").and_then(|i| i.as_i64()) {
                            let name = block
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("a tool")
                                .to_string();
                            tool_inputs.insert(idx, (name, String::new()));
                        }
                    }
                    None
                }
                "content_block_delta" => {
                    let delta = event.get("delta")?;
                    match delta.get("type")?.as_str()? {
                        "text_delta" => {
                            let t = delta.get("text")?.as_str()?;
                            // Empty deltas keep today's behavior and must NOT consume
                            // the pending separator (it belongs on the first REAL text).
                            if t.is_empty() {
                                return Some(ReviewEvent::Delta {
                                    text: String::new(),
                                });
                            }
                            let text = if *pending_sep {
                                *pending_sep = false;
                                format!("\n\n{t}")
                            } else {
                                t.to_string()
                            };
                            *emitted_text = true;
                            Some(ReviewEvent::Delta { text })
                        }
                        // A tool's input streams as JSON fragments — append to its buffer.
                        "input_json_delta" => {
                            if let (Some(idx), Some(frag)) = (
                                event.get("index").and_then(|i| i.as_i64()),
                                delta.get("partial_json").and_then(|p| p.as_str()),
                            ) {
                                if let Some(entry) = tool_inputs.get_mut(&idx) {
                                    entry.1.push_str(frag);
                                }
                            }
                            None
                        }
                        _ => None,
                    }
                }
                // Block stop: a tool block emits its Tool step; a TEXT block arms the
                // lazy separator (only once some text has been emitted).
                "content_block_stop" => {
                    let idx = event.get("index").and_then(|i| i.as_i64())?;
                    let Some((name, json)) = tool_inputs.remove(&idx) else {
                        if *emitted_text {
                            *pending_sep = true;
                        }
                        return None;
                    };
                    let input = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
                    Some(ReviewEvent::Tool {
                        tool: normalize_tool(&name).to_string(),
                        target: tool_target(&input),
                    })
                }
                _ => None,
            }
        }
        // A synthetic API-error message (no stream_event deltas back it, so nothing
        // was streamed): stash its text — the terminal line repeats it as `result`.
        "assistant" => {
            let msg = v.get("message")?;
            let synthetic = v
                .get("is_api_error_message")
                .and_then(|b| b.as_bool())
                .unwrap_or(false)
                || msg.get("model").and_then(|m| m.as_str()) == Some("<synthetic>");
            if synthetic {
                let text: String = msg
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                            .collect()
                    })
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    *synthetic_error = Some(text.trim().to_string());
                }
            }
            None
        }
        "result" => {
            let text = v
                .get("result")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            let is_error = claude_result_is_error(&v, &text, synthetic_error.as_deref());
            Some(ReviewEvent::Done {
                text: claude_result_text(&v, text, is_error),
                is_error,
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
            })
        }
        _ => None,
    }
}

/// A failed `result` line with a blank `result` carries its reason in `errors`
/// (a resume of an unknown session id does), joined one per line; strings only.
fn claude_result_text(v: &serde_json::Value, text: String, is_error: bool) -> String {
    if !is_error || !text.trim().is_empty() {
        return text;
    }
    v.get("errors")
        .and_then(|e| e.as_array())
        .map(|errors| {
            errors
                .iter()
                .filter_map(|e| e.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or(text)
}

/// Longest body the error-shape net will judge. Three copies must agree: this one,
/// `ERROR_SHAPE_MAX_CHARS` (automations runner) and `MAX_ERROR_TEXT` (terminal-error).
const ERROR_TEXT_MAX_CHARS: usize = 300;

/// Whether a Claude terminal `result` line reports a FAILED run.
///
/// The CLI exits 0 and reports `subtype: "success"` even on an API error, and
/// some versions ship usage-limit / API-error text as the `result` with
/// `is_error: false` — the flag alone cannot be trusted. Structural signals
/// first, then a narrow text net.
fn claude_result_is_error(v: &serde_json::Value, text: &str, synthetic_error: Option<&str>) -> bool {
    if v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false) {
        return true;
    }
    if v.get("api_error_status").is_some_and(|s| !s.is_null()) {
        return true;
    }
    // Absent on older CLIs — only a PRESENT, non-"completed" reason is a signal.
    if v.get("terminal_reason")
        .and_then(|r| r.as_str())
        .is_some_and(|r| r != "completed")
    {
        return true;
    }
    let trimmed = text.trim();
    if synthetic_error.is_some_and(|s| s == trimmed) {
        return true;
    }
    // Best-effort net behind the structural signals above, for limit / API-error
    // bodies that arrive with none of them. Deliberately narrow — a real review
    // that merely mentions limits is multi-paragraph and far longer.
    !trimmed.is_empty()
        && trimmed.chars().count() <= ERROR_TEXT_MAX_CHARS
        && !has_blank_line(trimmed)
        && (trimmed.starts_with("API Error")
            || trimmed.starts_with("Claude AI usage limit reached")
            || (trimmed.contains("limit reached") && trimmed.contains("resets")))
}

/// Whether `text` contains a paragraph break — two newlines separated only by
/// blanks, so CRLF bodies count. Mirrors `/\n[ \t\r]*\n/` in the TS twins
/// (`looksLikeProviderError` in `src/lib/automations/runner.ts`,
/// `terminalErrorMessage` in `src/lib/ai/terminal-error.ts`); all three
/// predicates must stay semantically aligned.
fn has_blank_line(text: &str) -> bool {
    text.match_indices('\n').any(|(i, _)| {
        text[i + 1..]
            .trim_start_matches([' ', '\t', '\r'])
            .starts_with('\n')
    })
}

/// Kills a run's process tree from its leader: on cancel or timeout, when the exit
/// grace runs out, and on unix at every review run's end. Unix signals the leader's
/// process group (it leads one, see `TreeGuard::prepare` at the spawn). Windows
/// terminates the run's job and leaves the guard armed for the caller's decision; only
/// a run whose job failed to arm walks the tree with `taskkill /T`, unwaited. The
/// direct kill of the leader follows on every platform.
fn kill_process_tree(child: &mut tokio::process::Child, tree: &crate::proc_tree::TreeGuard) {
    #[cfg(not(windows))]
    let _ = tree;
    let Some(pid) = child.id() else {
        // Already reaped — nothing to signal.
        let _ = child.start_kill();
        return;
    };

    #[cfg(windows)]
    {
        if tree.is_armed() {
            tree.terminate();
        } else {
            // Fallback for a run whose job failed to arm: `taskkill /T`,
            // fire-and-forget; CREATE_NO_WINDOW suppresses the console flash.
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn();
        }
    }

    // The child leads its own group (pgid == pid), so this reaches every descendant.
    #[cfg(unix)]
    crate::proc_tree::kill_process_group(pid);

    // The direct kill of the leader, on every platform: it covers a failed terminate
    // and the unwaited `taskkill` fallback.
    let _ = child.start_kill();
}

/// Whether a run's tree guard disarms at its end; otherwise it kills the tree. Only a
/// reaped leader disarms. Unix disarms whenever the leader was reaped: the group kill,
/// where one is due, already ran before the reap. Windows disarms only a session turn
/// that ended cleanly; a review, a cancel, a timeout and an expired exit grace close
/// the job.
fn tree_guard_disarms(unix: bool, reaped: bool, kill_tree_on_exit: bool, forced: bool) -> bool {
    reaped && (unix || (!kill_tree_on_exit && !forced))
}

/// Bounds each trailing wait once the pump loop ends — first the child's exit, then the
/// stderr drain's join. On a clean EOF both finish at once, but a grandchild (node
/// worker, MCP server) can hold the pipes open, and unbounded that means the command
/// never returns: the frontend never sees `backendDone` and the run's UI stays stuck.
const CHILD_EXIT_GRACE: Duration = Duration::from_secs(10);
/// Second, shorter grace after a tree-kill: the child is being force-killed, so this
/// only covers reaping it.
const CHILD_REAP_GRACE: Duration = Duration::from_secs(5);
/// The non-reaping exit wait's first re-probe delay: a leader that exits just after
/// EOF is caught within a few ms instead of a whole poll interval.
#[cfg(any(unix, test))]
const CHILD_EXIT_POLL_START: Duration = Duration::from_millis(2);
/// The longest the non-reaping exit wait sleeps between re-probes of the leader.
#[cfg(any(unix, test))]
const CHILD_EXIT_POLL: Duration = Duration::from_millis(100);

/// The re-probe delay after `prev`: doubling, held at `CHILD_EXIT_POLL`.
#[cfg(any(unix, test))]
fn next_exit_poll(prev: Duration) -> Duration {
    prev.saturating_mul(2).min(CHILD_EXIT_POLL)
}

/// Whether a `waitid` `si_code` reports a terminated child. `WEXITED` alone should
/// exclude stops, but older macOS returned on a stopped child too.
#[cfg(unix)]
fn si_code_is_exit(code: libc::c_int) -> bool {
    matches!(code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED)
}

/// Whether process `pid` (our unreaped child) has exited, probed WITHOUT reaping it
/// (`WNOWAIT`), so its pid and process group stay pinned for a following `killpg`.
#[cfg(unix)]
fn exited_unreaped(pid: u32) -> bool {
    // SAFETY: an all-zero `siginfo_t` is a valid value (integers, a raw pointer and
    // padding), and `waitid` only writes into the struct we hand it.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
        )
    };
    if rc == -1 {
        // ECHILD: nothing left to wait for. Anything else: not yet, poll again.
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD);
    }
    // Under WNOHANG a child that hasn't exited leaves `si_pid` zero. The accessor, not
    // the field: linux-gnu keeps `si_pid` inside a union.
    // SAFETY: `info` was zeroed above and filled by a successful `waitid`.
    unsafe { info.si_pid() != 0 && si_code_is_exit(info.si_code) }
}

/// Waits up to `grace` for our child `pid` to exit, leaving it unreaped.
#[cfg(unix)]
async fn wait_exit_unreaped(pid: u32, grace: Duration) {
    let deadline = tokio::time::Instant::now() + grace;
    let mut poll = CHILD_EXIT_POLL_START;
    while !exited_unreaped(pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(poll).await;
        poll = next_exit_poll(poll);
    }
}

/// Sends `ev`, keeping it as the run's outcome when it is the FIRST terminal
/// (`Done`/`Error`) sent: the one the frontend settles on, whatever follows it.
fn send_noting_terminal(
    on_event: &dyn EventSink,
    terminal: &mut Option<ReviewEvent>,
    ev: ReviewEvent,
) {
    if terminal.is_none() && matches!(ev, ReviewEvent::Done { .. } | ReviewEvent::Error { .. }) {
        *terminal = Some(ev.clone());
    }
    on_event.send(ev);
}

/// Whether `id` is an acceptable cancel-registry key. Every id is minted by
/// `crypto.randomUUID()` on the frontend — an RFC 4122 v4 uuid, 36 lowercase
/// hex-and-dash chars (`src/lib/ai/stream.ts`, `cli-client.ts`, and the plan /
/// research / sessions stores). The gate is deliberately a superset of that: it only
/// has to bound the key space, since an unvalidated id would let a cancel seed an
/// unbounded number of tombstones. Same bound as the forge reconnect registry's.
fn valid_cancel_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// RAII cleanup for a registered agent cancel: removes the registry entry on drop, so
/// every exit path out of `agent_review` / `agent_session` after registration — the
/// `?` returns of the pre-stream setup included — releases it. Carries the `Notify`
/// the run waits on, which may already hold a cancel permit.
struct AgentCancelGuard<'a> {
    state: &'a AppState,
    id: String,
    notify: Arc<Notify>,
}

impl<'a> AgentCancelGuard<'a> {
    fn register(state: &'a AppState, id: &str) -> Self {
        Self {
            state,
            id: id.to_string(),
            notify: state.register_agent_cancel(id),
        }
    }
}

impl Drop for AgentCancelGuard<'_> {
    fn drop(&mut self) {
        self.state.clear_agent_cancel(&self.id);
    }
}

/// Holds the session's container gate, waiting out a previous turn that still owns
/// the shared container name; `None` once the turn is stopped, including by a permit
/// stored before the wait (the cancel arm is polled first).
async fn wait_for_session_container<'a>(
    state: &'a AppState,
    session_id: &str,
    cancel: &Notify,
) -> Option<crate::state::SessionContainerHold<'a>> {
    tokio::select! {
        biased;
        () = cancel.notified() => None,
        hold = state.hold_session_container(session_id) => Some(hold),
    }
}

/// Spawns an agent CLI, streams its stdout as `ReviewEvent`s until a terminal
/// event / EOF / cancel / timeout, then emits a final `Error` if no terminal
/// result arrived. Shared by `agent_review` (read-only) and `agent_session`
/// (write-enabled, run in a worktree). `cwd` is the process working directory,
/// `cancel` is the caller's registered cancel handle (registered at command entry,
/// so a cancel racing the setup below is never lost), and `noun` colors the failure
/// copy.
///
/// Returns the first terminal event it sent, after sending it, so the frontend can
/// settle a run whose channel copy hasn't arrived; `None` only when the run was
/// cancelled.
#[allow(clippy::too_many_arguments)]
async fn stream_agent(
    cancel: Arc<Notify>,
    kind: AgentKind,
    binary: &Path,
    args: Vec<String>,
    stdin_text: String,
    cwd: &str,
    timeout: Duration,
    noun: &str,
    // Whether a timeout message may point at the "Review timeout" setting — true
    // only for the review flows that setting governs (see `timeout_message`).
    timeout_hint: bool,
    // When the run is wrapped in a container (`binary` = docker/podman), the
    // `(runtime, container name)` to force-remove after every forced end (cancel,
    // timeout, expired exit grace): killing the `run` client alone leaves the engine's
    // container running.
    container_kill: Option<(PathBuf, String)>,
    // Whether the run's whole tree dies at EVERY exit, the clean one included: true for
    // reviews. A session passes false and keeps what its turn started when the turn ends
    // cleanly; cancel, timeout and an expired exit grace still take the tree.
    kill_tree_on_exit: bool,
    // Extra environment for the spawned process — used to pass a Copilot container's
    // `COPILOT_GITHUB_TOKEN` to the docker/podman client by name (the run args carry
    // `-e COPILOT_GITHUB_TOKEN` with no value, so the token is inherited here and
    // never appears in argv / `docker inspect`).
    extra_env: &[(&str, String)],
    on_event: &dyn EventSink,
    // An opencode 2 run's parser state; `None` for every other run.
    mut opencode2: Option<Opencode2Stream>,
) -> AppResult<Option<ReviewEvent>> {
    // Before the sanitize below, which reads whatever that capture landed.
    if wait_for_executing_capture(&cancel).await {
        return Ok(None);
    }
    let mut cmd = Command::new(binary);
    sanitize_child_env(&mut cmd);
    cmd.args(args)
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .envs(extra_env.iter().map(|(k, v)| (*k, v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // The child leads its own process group on unix, and `tree` below holds its job on
    // Windows: together they are how a kill reaches what the CLI spawned.
    crate::proc_tree::TreeGuard::prepare(&mut cmd);
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            AppError::Command(format!("{} CLI not found.", kind.label()))
        } else {
            AppError::Io(e)
        }
    })?;
    // Armed with nothing between spawn and arm (no await, no early exit), and declared
    // right after `child` so it drops first: on unix an unreaped leader pins the group
    // id the guard's kill names.
    let tree = crate::proc_tree::TreeGuard::arm(&child);

    // Write the prompt on a detached task so a large diff can't deadlock
    // against stdout filling its pipe while we're still writing stdin.
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(stdin_text.as_bytes()).await;
            // Dropping `stdin` here closes the pipe so the CLI sees EOF.
        });
    }

    // Drain stderr concurrently; surfaced only if no terminal result arrives.
    let stderr = child.stderr.take();
    let mut stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(s) = stderr {
            let _ = BufReader::new(s).read_to_string(&mut buf).await;
        }
        buf
    });

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut lines = BufReader::new(stdout).lines();

    let mut last_message = String::new(); // codex: accumulates the final message
    // claude: per-tool-call streamed input JSON, keyed by content-block index.
    let mut claude_tool_inputs: std::collections::HashMap<i64, (String, String)> =
        std::collections::HashMap::new();
    // opencode: the final step's text, so `Done` carries the answer, not narration.
    let mut opencode_step_text = String::new();
    // claude/copilot: lazy `\n\n` between successive text blocks/messages.
    let mut emitted_text = false;
    let mut pending_sep = false;
    // claude: text of a synthetic API-error message, matched against the terminal
    // `result`. copilot: a `session.error`'s message — the run's failure reason,
    // since its exit code lies.
    let mut claude_synthetic_error: Option<String> = None;
    let mut copilot_error: Option<String> = None;
    let mut cancelled = false;
    let mut timed_out = false;
    // Only an opencode 2 run reads it: the other parsers keep a read error as EOF.
    let mut read_failed = false;
    let mut terminal: Option<ReviewEvent> = None;

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                timed_out = true;
                kill_process_tree(&mut child, &tree);
                break;
            }
            _ = cancel.notified() => {
                cancelled = true;
                kill_process_tree(&mut child, &tree);
                break;
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        let ev = match kind {
                            AgentKind::Claude => parse_claude_line(
                                &l,
                                &mut claude_tool_inputs,
                                &mut emitted_text,
                                &mut pending_sep,
                                &mut claude_synthetic_error,
                            ),
                            AgentKind::Codex => parse_codex_line(&l, &mut last_message),
                            AgentKind::Copilot => parse_copilot_line(
                                &l,
                                &mut last_message,
                                &mut emitted_text,
                                &mut pending_sep,
                                &mut copilot_error,
                            ),
                            AgentKind::Opencode => match opencode2.as_mut() {
                                Some(stream) => {
                                    let events = opencode2_stream_event(stream, &l);
                                    for ev in events.into_iter().flatten() {
                                        send_noting_terminal(on_event, &mut terminal, ev);
                                    }
                                    None
                                }
                                None => parse_opencode_line(
                                    &l,
                                    &mut last_message,
                                    &mut opencode_step_text,
                                ),
                            },
                        };
                        if let Some(ev) = ev {
                            send_noting_terminal(on_event, &mut terminal, ev);
                        }
                    }
                    Ok(None) => break, // EOF: process closed stdout
                    Err(_) => {
                        read_failed = true;
                        break;
                    }
                }
            }
        }
    }

    // Unix, review run (`kill_tree_on_exit`): wait (bounded) for the leader WITHOUT
    // reaping it, kill its process group, then reap. Kill-before-reap is the invariant:
    // an unreaped zombie pins its pid and pgid, so the `killpg` can't land on a recycled
    // group. The non-reaping wait still lets a cleanly exiting leader flush stderr first.
    #[cfg(unix)]
    let group_killed = match child.id() {
        Some(pid) if kill_tree_on_exit => {
            wait_exit_unreaped(pid, CHILD_EXIT_GRACE).await;
            kill_process_tree(&mut child, &tree);
            let _ = tokio::time::timeout(CHILD_REAP_GRACE, child.wait()).await;
            true
        }
        _ => false,
    };
    #[cfg(not(unix))]
    let group_killed = false;
    // Every other run waits here, bounded. A leader still alive when the grace ends is
    // killed with its tree by `kill_process_tree`, before the reap: on unix it signals
    // the group, on Windows it terminates the job (an unarmed guard walks the tree with
    // `taskkill /T` instead).
    let grace_expired = !group_killed
        && tokio::time::timeout(CHILD_EXIT_GRACE, child.wait())
            .await
            .is_err();
    if grace_expired {
        kill_process_tree(&mut child, &tree);
        let _ = tokio::time::timeout(CHILD_REAP_GRACE, child.wait()).await;
    }
    // The guard's one decision, with no await since the last `child.wait()`: on unix a
    // guard still armed after the reap could signal a recycled group. It precedes the
    // `rm -f` and the stderr join: on Windows closing an armed job is what lets a cleanly
    // ended review's stderr reach EOF. `grace_expired` feeds `forced`, so on Windows a
    // leader that outlived the grace never disarms; on unix its group was already
    // signalled above, and once the leader is reaped its guard disarms.
    let forced = cancelled || timed_out || grace_expired;
    let reaped = child.id().is_none();
    if tree_guard_disarms(cfg!(unix), reaped, kill_tree_on_exit, forced) {
        tree.disarm();
    } else {
        tree.kill();
    }
    // A killed `docker/podman run` client doesn't stop its container, so every forced
    // end (cancel, timeout, expired exit grace) force-removes it.
    if forced {
        if let Some((runtime, name)) = &container_kill {
            let _ = run_capture(runtime, &["rm", "-f", name], DETECT_TIMEOUT).await;
        }
    }
    let stderr_text = match tokio::time::timeout(CHILD_EXIT_GRACE, &mut stderr_task).await {
        Ok(joined) => joined.unwrap_or_default(),
        // The read never ended (something still holds the pipe open) — abandon it and
        // report with no stderr, which only weakens the no-result message below.
        Err(_) => {
            stderr_task.abort();
            String::new()
        }
    };

    if cancelled {
        // The frontend tore down its UI on cancel; nothing to emit.
        return Ok(None);
    }
    if timed_out {
        // Codex accumulates whole messages and only surfaces them at `turn.completed`, so
        // a kill at the deadline would drop everything it wrote; the streaming CLIs already
        // sent theirs as deltas and carry none.
        let partial_text = match kind {
            AgentKind::Codex if !last_message.trim().is_empty() => {
                Some(std::mem::take(&mut last_message))
            }
            _ => None,
        };
        send_noting_terminal(
            on_event,
            &mut terminal,
            ReviewEvent::Error {
                message: opencode2_timeout_message(
                    timeout_message(noun, timeout, timeout_hint),
                    opencode2.as_ref().map(|stream| &stream.parser),
                ),
                partial_text,
                timed_out: true,
            },
        );
        return Ok(terminal);
    }
    // An opencode 2 run concludes only here, at EOF, from its exit code.
    if let Some(stream) = opencode2 {
        let code = opencode2_exit_code(
            forced,
            child
                .try_wait()
                .ok()
                .flatten()
                .and_then(|status| status.code()),
        );
        if let Some(ev) = opencode2_conclusion(stream.parser, read_failed, code, &stderr_text) {
            send_noting_terminal(on_event, &mut terminal, ev);
        }
    }
    if terminal.is_none() {
        // No terminal result event — surface stderr. Covers auth/quota
        // failures and the empty-stdout-without-a-TTY class of CLI bugs.
        let msg = stderr_text.trim();
        send_noting_terminal(
            on_event,
            &mut terminal,
            ReviewEvent::error(if msg.is_empty() {
                format!("The {noun} process ended without producing any output.")
            } else {
                msg.to_string()
            }),
        );
    }
    Ok(terminal)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_review(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    kind: AgentKind,
    bin_path: Option<String>,
    model: String,
    // Reasoning/effort level ("" = provider default; else low/medium/high/xhigh).
    // Mapped per-CLI: Codex `-c model_reasoning_effort`, Copilot `--effort`,
    // opencode `--variant`, Claude a "thinking" keyword appended to the prompt.
    effort: String,
    system_prompt: String,
    user_prompt: String,
    repo_path: String,
    repo_aware: bool,
    // Attach GitDesktop ITSELF as a read-only MCP server (`gitdesktop mcp --repo
    // <repo_path>`) so the review agent can pull the full PR diff / read files at
    // any ref / blame, instead of the budget-truncated diff in the prompt. Honored
    // for Claude / Copilot / opencode; Codex is exempt (see below).
    mcp_self: bool,
    // User's "Review timeout" override in seconds, clamped to 1–120 minutes here.
    // `None` / `0` = the tier defaults below.
    timeout_secs: Option<u64>,
    // Whether that setting governs THIS run — true for the AI-review flows, absent
    // (false) for generation / Debug-with-AI, which share the command but not the
    // setting. Only gates the timeout message's "adjust the limit" hint.
    timeout_configurable: Option<bool>,
    review_id: String,
    on_event: Channel<ReviewEvent>,
) -> AppResult<Option<ReviewEvent>> {
    if !valid_cancel_id(&review_id) {
        return Err(AppError::InvalidArgument("invalid review id".into()));
    }
    // Register BEFORE the setup below (binary resolve, MCP config writes): a racing
    // cancel then lands its permit on this entry — or leaves a tombstone this
    // register adopts. The guard clears the entry on every exit path.
    let cancel = AgentCancelGuard::register(&state, &review_id);

    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
        AppError::Command(format!(
            "{} CLI not found. Install it or set its path in Settings.",
            kind.label()
        ))
    })?;
    if kind == AgentKind::Opencode {
        if let (crate::opencode2::Cli::V2(version), identity) = opencode_cli(&binary).await? {
            return Box::pin(opencode2_review(
                app,
                cancel.notify.clone(),
                &binary,
                version,
                identity,
                model,
                effort,
                system_prompt,
                user_prompt,
                repo_path,
                repo_aware,
                mcp_self,
                timeout_secs,
                timeout_configurable,
                review_id,
                on_event,
            ))
            .await;
        }
    }

    // Per-review MCP config exposing EXACTLY one server — GitDesktop itself,
    // read-only against `repo_path`. Written under `<app_data>/mcp` keyed by
    // `review_id`, same lifecycle as sessions; removed after the run on every path.
    // Codex is excluded: host `codex exec` cancels every MCP tool call (stdin EOF →
    // "declined", upstream), and its reviews self-explore anyway.
    let self_mcp_wanted = mcp_self && !matches!(kind, AgentKind::Codex);
    let self_specs = if self_mcp_wanted {
        vec![crate::mcp::self_server_spec(&repo_path)?]
    } else {
        Vec::new()
    };
    // `mcp__gitdesktop` for Claude's strict `--tools` allowlist (empty otherwise).
    let mcp_tools = crate::mcp::tool_allow_patterns(&self_specs);
    // The generated config path for whichever CLI applies: Claude `--mcp-config`,
    // Copilot `--additional-mcp-config @<path>`, opencode `OPENCODE_CONFIG` env.
    let mcp_config_path: Option<String> = if self_specs.is_empty() {
        None
    } else {
        match kind {
            AgentKind::Claude => crate::mcp::write_host_config(&app, &review_id, &self_specs)?,
            AgentKind::Copilot => crate::mcp::write_copilot_config(&app, &review_id, &self_specs)?,
            AgentKind::Opencode => {
                crate::mcp::write_opencode_config(&app, &review_id, &self_specs, false)?
            }
            // Codex was filtered out of `self_specs` above; unreachable in practice.
            AgentKind::Codex => None,
        }
        .map(|p| p.to_string_lossy().into_owned())
    };

    // Per-kind invocation: Claude carries the system prompt as a flag and the
    // diff on stdin; Codex has no system-prompt flag, so both go on stdin.
    let (args, stdin_text) = match kind {
        AgentKind::Claude => {
            // Claude's own `--effort` is deliberately unused: the thinking keyword
            // appended to the user turn works on every installed CLI version
            // (same as a session).
            let prompt = match claude_thinking_keyword(&effort) {
                Some(kw) => format!("{user_prompt}\n\n{kw}"),
                None => user_prompt,
            };
            (
                claude_review_args(
                    &model,
                    &system_prompt,
                    repo_aware,
                    mcp_config_path.as_deref(),
                    &mcp_tools,
                ),
                prompt,
            )
        }
        AgentKind::Codex => (
            codex_review_args(&model, &repo_path, &effort),
            format!("{system_prompt}\n\n{user_prompt}"),
        ),
        // Copilot takes the prompt as an argument, not stdin (see copilot_review_args).
        AgentKind::Copilot => (
            copilot_review_args(
                &model,
                &format!("{system_prompt}\n\n{user_prompt}"),
                repo_aware,
                &effort,
                mcp_config_path.as_deref(),
            ),
            String::new(),
        ),
        // opencode review: prompt on stdin (no positional message), so a large or
        // newline-bearing diff prompt doesn't hit the argv / batch-file-arg limits.
        // A review always runs on the host, so `--dir` names the repo we spawn it in.
        AgentKind::Opencode => (
            opencode_review_args(&model, repo_aware, &effort, &repo_path),
            format!("{system_prompt}\n\n{user_prompt}"),
        ),
    };

    // opencode reads its MCP config from `OPENCODE_CONFIG` (no flag); the others carry
    // it in argv. `review_env` also carries the read-only pins.
    let self_names: Vec<&str> = self_specs.iter().map(|s| s.name.as_str()).collect();
    // Only a repo-aware run's ReadOnly pin mirrors the user's read rules; DiffOnly
    // ignores them, so its config files go unread.
    let read_mirror = if kind == AgentKind::Opencode && repo_aware {
        opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&repo_path))
    } else {
        OpencodeReadMirror::default()
    };
    let extra_env = review_env(
        kind,
        repo_aware,
        mcp_config_path.as_deref(),
        &self_names,
        &read_mirror,
    );

    // Codex always explores the repo, so it gets the longer agentic budget too — and
    // a self-MCP review is agentic regardless of `repo_aware` (the agent pulls the
    // full diff / reads files via the server), so it gets the agentic budget too.
    let timeout = review_timeout(
        repo_aware || self_mcp_wanted || matches!(kind, AgentKind::Codex),
        timeout_secs,
    );
    let result = stream_agent(
        cancel.notify.clone(),
        kind,
        &binary,
        args,
        stdin_text,
        &repo_path,
        timeout,
        "review",
        timeout_configurable.unwrap_or(false),
        None,
        true,
        &extra_env,
        &on_event,
        None,
    )
    .await;
    // Remove the generated config on EVERY path, mirroring the session lifecycle.
    if mcp_config_path.is_some() {
        crate::mcp::cleanup_host_config(&app, &review_id);
    }
    result
}

#[tauri::command]
pub async fn agent_review_cancel(
    state: tauri::State<'_, AppState>,
    review_id: String,
) -> AppResult<()> {
    // Validate before touching the registry — same gate as the run commands, so a
    // malformed id can't seed a tombstone (see `valid_cancel_id`).
    if !valid_cancel_id(&review_id) {
        return Err(AppError::InvalidArgument("invalid review id".into()));
    }
    state.cancel_agent(&review_id);
    Ok(())
}

/// Runs one turn of a write-capable agent session: the CLI implements
/// `user_prompt` full-auto inside `worktree_path` (a throwaway worktree — the
/// sandbox boundary). `resume = false` starts, `true` continues. Streams the
/// same `ReviewEvent`s as a review; cancel via `agent_review_cancel` with this
/// turn's `run_id`, fresh per turn because the registry assumes single-use keys
/// (the frontend's resume retry reuses it for a second call only after the first
/// call's entry is gone). `session_id` still names the conversation (Claude's
/// `--session-id` / `--resume`), the container and the MCP config file.
///
/// `agent` picks the CLI; each runs worktree-confined on the **host** (see its
/// `*_session_args` doc for the mechanism) or in a **container** (kernel
/// boundary — and for Codex the only mode where MCP works). Copilot's container
/// authenticates from a `gh auth token` passed by env.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    bin_path: Option<String>,
    // "claude" (default), "codex", "copilot", or "opencode".
    agent: String,
    model: String,
    // Reasoning/effort level ("" = provider default; else low/medium/high/xhigh).
    // Mapped per-CLI: Codex `-c model_reasoning_effort`, Copilot `--effort`, Claude
    // a "thinking" keyword appended to the user turn.
    effort: String,
    system_prompt: String,
    user_prompt: String,
    worktree_path: String,
    session_id: String,
    // This turn's cancel-registry key, minted per call by the frontend.
    run_id: String,
    resume: bool,
    // Claude-only: forks a resumed conversation to a throwaway session id
    // (`--fork-session`) so this turn never pollutes the original transcript. Used by
    // the research→plan distill handoff; ignored by the other agents (no equivalent).
    fork: bool,
    // Read-only mode: a Plan conversation. Swaps every CLI's write toolset/sandbox
    // for its read-only one (Claude read tools + no bypass, Codex `-s read-only`,
    // Copilot deny-write/shell, opencode its `OPENCODE_PERMISSION` pin), so the turn
    // can explore but never write, even in the live repo (for opencode, unless the
    // repo's own opencode config re-enables a tool; see `opencode_session_env`).
    read_only: bool,
    // Research profile: each CLI gains its native web tools while still never
    // writing (see each `*_session_args`). Only meaningful alongside `read_only`.
    web: bool,
    // "container" runs the turn inside a Docker/Podman container (worktree-
    // confined); anything else (incl. None) runs it on the host (worktree-only).
    isolation: Option<String>,
    // The CLI's native resume id captured from turn 1 (Codex thread / opencode
    // sessionID), so a *host* session resumes the right conversation; None on turn
    // 1 / Claude / Copilot / container. For opencode an opaque token, read only by
    // `parse_native_ref` and `opencode1_must_restart`.
    native_session_id: Option<String>,
    // The session's opted-in MCP servers (resolved from the settings registry by
    // the frontend). None/empty = MCP stays off. Honored for host Claude/Copilot/
    // opencode and container Claude/Copilot/opencode/Codex (the composer gates it).
    mcp_servers: Option<Vec<crate::mcp::McpServerSpec>>,
    on_event: Channel<ReviewEvent>,
) -> AppResult<Option<ReviewEvent>> {
    if !valid_cancel_id(&session_id) {
        return Err(AppError::InvalidArgument("invalid session id".into()));
    }
    if !valid_cancel_id(&run_id) {
        return Err(AppError::InvalidArgument("invalid run id".into()));
    }
    // Register BEFORE the setup below (the container path runs several runtime
    // probes): a racing cancel then lands its permit on this entry — or leaves a
    // tombstone this register adopts. The guard clears the entry on every exit path.
    let cancel = AgentCancelGuard::register(&state, &run_id);

    // Strict: reject an unknown agent rather than silently coercing it.
    let kind = match agent.as_str() {
        "claude" => AgentKind::Claude,
        "codex" => AgentKind::Codex,
        "copilot" => AgentKind::Copilot,
        "opencode" => AgentKind::Opencode,
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown agent: {other:?}"
            )));
        }
    };
    let agent_name = match kind {
        AgentKind::Codex => "codex",
        AgentKind::Claude => "claude",
        AgentKind::Copilot => "copilot",
        AgentKind::Opencode => "opencode",
    };
    let container = isolation.as_deref() == Some("container");
    // opencode Research: it needs its generated read-only-web agent in OPENCODE_CONFIG
    // (the pin denies web to every agent, so only gd-research's own permission
    // re-allows it), written even with no MCP servers.
    let opencode_research = kind == AgentKind::Opencode && web;

    // Resolve the session's opted-in MCP servers into a generated config file, passed
    // to whichever CLI this is in its own form. The composer gates selection to the
    // supported (agent, isolation) combos, so an unsupported one arriving here with
    // servers is an error, not a silent drop.
    let mcp_specs = mcp_servers.unwrap_or_default();
    // `mcp__<server>` allowlist entries — loading a server via `--mcp-config` does
    // NOT admit its tools past `--tools`. Claude only (host and container).
    let mcp_tools = crate::mcp::tool_allow_patterns(&mcp_specs);
    // opencode's read-only pin admits each opted-in server's `<name>_*` tools.
    let mcp_names: Vec<&str> = mcp_specs.iter().map(|s| s.name.as_str()).collect();
    // A host opencode 2 turn leaves here for its own path. A 1.x binary asked to resume
    // a conversation opencode 2 created or re-keyed starts a new one, with a note.
    let (opencode_v1_restart, opencode_v1_binary) = if kind == AgentKind::Opencode && !container {
        let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
            AppError::Command(format!(
                "{} CLI not found. Install it or set its path in Settings.",
                kind.label()
            ))
        })?;
        match opencode_cli(&binary).await? {
            (crate::opencode2::Cli::V2(version), identity) => {
                return Box::pin(opencode2_host_session(
                    app,
                    cancel.notify.clone(),
                    &binary,
                    version,
                    identity,
                    model,
                    effort,
                    system_prompt,
                    user_prompt,
                    worktree_path,
                    session_id,
                    resume,
                    read_only,
                    web,
                    native_session_id,
                    &mcp_specs,
                    on_event,
                ))
                .await;
            }
            (crate::opencode2::Cli::V1(_), _) => (
                opencode1_must_restart(resume, native_session_id.as_deref()),
                Some(binary),
            ),
        }
    } else {
        (false, None)
    };
    if opencode_v1_restart {
        EventSink::send(
            &on_event,
            ReviewEvent::Notice {
                code: NOTICE_SESSION_RESET,
                text: NOTICE_RESET_V1.to_string(),
            },
        );
    }
    let (resume, native_session_id) = if opencode_v1_restart {
        (false, None)
    } else {
        (resume, native_session_id)
    };
    let fresh_start = resume_starts_fresh(kind, container, resume, native_session_id.as_deref());
    let resume = resume && !fresh_start;
    // Per-CLI MCP config plumbing (`mcp_config_path` holds whatever this CLI needs):
    //  - Claude: JSON via `--mcp-config` (strict) + a `mcp__<server>` allowlist;
    //    host = a host path, container = the mounted `/home/node/.claude/mcp.json`.
    //  - Copilot: host `--additional-mcp-config @<path>`; container = the auto-loaded
    //    `~/.copilot/mcp-config.json` in the mounted home. No allowlist needed.
    //  - opencode: the `OPENCODE_CONFIG` env var (host spawn env / container `-e`).
    //  - Codex: container ONLY (host Codex cancels every MCP tool call — stdin EOF →
    //    "declined", upstream), stdio servers only, via `~/.codex/config.toml`.
    // Host configs are written here; container ones in the container branch below.
    let mut mcp_config_path: Option<String> = None;
    if !mcp_specs.is_empty() {
        crate::mcp::validate_specs(&mcp_specs)?;
        match (kind, container) {
            // Host: write the generated file now; the flag/env value is its host path.
            (AgentKind::Claude, false) => {
                mcp_config_path = crate::mcp::write_host_config(&app, &session_id, &mcp_specs)?
                    .map(|p| p.to_string_lossy().into_owned());
            }
            (AgentKind::Copilot, false) => {
                mcp_config_path = crate::mcp::write_copilot_config(&app, &session_id, &mcp_specs)?
                    .map(|p| p.to_string_lossy().into_owned());
            }
            (AgentKind::Opencode, false) => {
                mcp_config_path =
                    crate::mcp::write_opencode_config(&app, &session_id, &mcp_specs, opencode_research)?
                        .map(|p| p.to_string_lossy().into_owned());
            }
            // Container: the file is written into the mounted home in the container branch
            // below (uniform). Only Claude carries a path here, for its `--mcp-config` flag;
            // Copilot/Codex read their dotdir file implicitly, opencode gets `OPENCODE_CONFIG`.
            (AgentKind::Claude, true) => {
                mcp_config_path =
                    crate::agent_sandbox::container_mcp_config("claude").map(|(_, p)| p);
            }
            (AgentKind::Copilot, true) | (AgentKind::Opencode, true) => {}
            (AgentKind::Codex, true) => {
                // stdio only — reject a remote server pre-flight (Codex's remote-MCP config
                // can't carry our arbitrary headers). The config.toml is written below.
                if let Some(remote) = mcp_specs.iter().find(|s| s.transport != "stdio") {
                    return Err(AppError::Command(format!(
                        "Codex sessions support local (stdio) MCP servers only right now; \
                         \"{}\" is a remote server.",
                        remote.name
                    )));
                }
            }
            (AgentKind::Codex, false) => {
                return Err(AppError::Command(
                    "Codex runs MCP servers in container sessions only — host Codex can't \
                     approve MCP tool calls. Turn on container isolation in Settings → AI, \
                     or start a new session with Isolation set to Container (composer → Options)."
                        .into(),
                ));
            }
        }
    }
    // A host opencode Research session with NO MCP servers still needs its generated
    // read-only-web agent config (the `!mcp_specs.is_empty()` pass above skipped it).
    if opencode_research && !container && mcp_config_path.is_none() {
        mcp_config_path = crate::mcp::write_opencode_config(&app, &session_id, &[], true)?
            .map(|p| p.to_string_lossy().into_owned());
    }

    // The inner CLI invocation + the stdin for this turn. Claude carries the
    // system prompt as a flag; Codex has none, so it's prepended on stdin (turn
    // 1 only — a resumed Codex session already has it in context).
    let (inner, stdin_text) = match kind {
        AgentKind::Claude => {
            // Claude's own `--effort` is deliberately unused: the thinking keyword
            // appended to the user turn works on every installed CLI version, and
            // applies per-turn, so on resume too.
            let prompt = match claude_thinking_keyword(&effort) {
                Some(kw) => format!("{user_prompt}\n\n{kw}"),
                None => user_prompt,
            };
            (
                claude_session_args(
                    &model,
                    &system_prompt,
                    &session_id,
                    resume,
                    fork,
                    read_only,
                    web,
                    mcp_config_path.as_deref(),
                    &mcp_tools,
                ),
                prompt,
            )
        }
        AgentKind::Codex => (
            codex_session_args(
                &model,
                resume,
                container,
                native_session_id.as_deref(),
                &effort,
                read_only,
                web,
            ),
            if resume {
                user_prompt
            } else {
                turn_one_prompt(&system_prompt, &user_prompt)
            },
        ),
        // Copilot takes the prompt as an arg (`-p`), not stdin, so stdin is empty.
        AgentKind::Copilot => {
            let prompt = if resume {
                user_prompt
            } else {
                turn_one_prompt(&system_prompt, &user_prompt)
            };
            let add_dir = run_dir(container, &worktree_path);
            (
                copilot_session_args(
                    &model,
                    &session_id,
                    resume,
                    add_dir,
                    &prompt,
                    &effort,
                    read_only,
                    web,
                    // Host Copilot only — a container session errored out above, so a
                    // path here always names the host `--additional-mcp-config` file.
                    mcp_config_path.as_deref(),
                ),
                String::new(),
            )
        }
        // opencode reads the prompt on stdin (no positional message), avoiding the
        // argv / batch-file-arg limits. It generates its own session id, so on
        // resume we pass the captured one.
        AgentKind::Opencode => {
            let prompt = if resume {
                user_prompt
            } else {
                turn_one_prompt(&system_prompt, &user_prompt)
            };
            let dir = run_dir(container, &worktree_path);
            (
                opencode_session_args(
                    &model,
                    native_session_id.as_deref().unwrap_or(""),
                    resume,
                    &effort,
                    read_only,
                    web,
                    dir,
                ),
                prompt,
            )
        }
    };

    // Container isolation: wrap the same invocation in an ephemeral,
    // worktree-confined container. The agent CLI lives in the image, so we don't
    // resolve a host binary; the runtime drives it.
    if container {
        // This branch runs on EVERY turn, so one candidate holding the image settles the
        // choice in ONE subprocess — `image inspect` needs the daemon, so it also proves
        // the engine is up. That candidate is the engine a recent fallback walk settled
        // on when there is one (a stopped preferred engine would otherwise re-probe to
        // its timeout every turn), else the preferred one. Only its failure pays for the
        // wider walk, which tells "wrong engine" / "engine stopped" / "never built" apart.
        let preferred = match crate::agent_sandbox::settled_runtime() {
            Some(engine) => Some(engine),
            None => crate::agent_sandbox::preferred_runtime().await,
        };
        let preferred_has_image = match &preferred {
            Some((bin, _)) => crate::agent_sandbox::image_present(bin).await,
            None => false,
        };
        let (runtime, runtime_name) = match preferred.filter(|_| preferred_has_image) {
            Some(pair) => pair,
            None => match crate::agent_sandbox::pick_runtime().await {
                crate::agent_sandbox::RuntimePick::WithImage(bin, name) => {
                    // Only the fallback outcome is memoized: the happy path above needs no
                    // memo, so its behavior stays exactly one subprocess either way.
                    crate::agent_sandbox::remember_settled_runtime(&bin, &name);
                    (bin, name)
                }
                crate::agent_sandbox::RuntimePick::ReadyNoImage(..) => {
                    return Err(AppError::Command(
                        "The agent container image isn't built yet. Open Settings → AI and click \"Build image\", then try again.".to_string(),
                    ));
                }
                crate::agent_sandbox::RuntimePick::NotReady(_, name) => {
                    return Err(AppError::Command(format!(
                        "{} is installed but its engine isn't running. Start it, then try again.",
                        crate::agent_sandbox::runtime_label(&name)
                    )));
                }
                crate::agent_sandbox::RuntimePick::Missing => {
                    return Err(AppError::Command("Container isolation is on for this session, but Docker/Podman isn't available. Install and start it — or start a new session with Isolation set to Worktree (composer → Options), or turn container isolation off in Settings → AI.".to_string()));
                }
            },
        };
        // The image may have been built without this agent (provider selection) —
        // fail clearly instead of a cryptic in-container "command not found".
        if !crate::agent_sandbox::image_has_agent(&runtime, agent_name).await {
            return Err(AppError::Command(format!(
                "The agent image wasn't built with {}. Open Settings → AI, add it under the image's agents, and rebuild.",
                kind.label()
            )));
        }
        // Fail early if the agent isn't logged in on the host (its creds are what we
        // mount). opencode is exempt (free hosted models, keyless) and so is Copilot
        // (no creds file — it authenticates from the env token fetched below).
        if !matches!(kind, AgentKind::Opencode | AgentKind::Copilot)
            && !crate::agent_sandbox::host_logged_in(agent_name)
        {
            return Err(AppError::Command(format!(
                "{} isn't logged in on this machine. Sign in with its CLI first, then start the session.",
                kind.label()
            )));
        }
        // Copilot authenticates from a GitHub token (`gh auth token`) instead of a
        // mounted creds file. Passed by-name to the runtime client (`extra_env`) so it
        // never lands in argv / `docker inspect`.
        let extra_env: Vec<(&str, String)> = if kind == AgentKind::Copilot {
            let token = crate::github::runner::run_gh(
                None,
                &["auth", "token"],
                crate::github::runner::GH_TIMEOUT,
            )
            .await
            .ok()
            .map(|o| o.stdout_lossy().trim().to_string())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| {
                AppError::Command(
                    "Copilot in a container authenticates with your GitHub CLI token, but `gh auth token` returned nothing. Run `gh auth login` (or turn isolation off in Settings → AI to use the host Copilot login).".to_string(),
                )
            })?;
            vec![("COPILOT_GITHUB_TOKEN", token)]
        } else {
            Vec::new()
        };
        // Defense-in-depth: the worktree is bind-mounted, so never let a `..` in
        // its path widen the mount beyond the intended directory.
        if Path::new(&worktree_path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(AppError::InvalidArgument(
                "worktree path must not contain '..'".to_string(),
            ));
        }
        // Every turn of a session runs under one container name: wait for the previous
        // turn's container to be gone, held until this call returns.
        let Some(_container_hold) =
            wait_for_session_container(&state, &session_id, &cancel.notify).await
        else {
            return Ok(None);
        };
        // A container opencode turn always leaves here: the image gate admits only an
        // image labelled for opencode 2, so the opencode arms further down this branch are
        // never reached.
        if kind == AgentKind::Opencode {
            return Box::pin(opencode2_container_session(
                app,
                cancel.notify.clone(),
                runtime,
                runtime_name,
                bin_path,
                model,
                effort,
                &system_prompt,
                stdin_text,
                worktree_path,
                session_id,
                resume,
                read_only,
                web,
                native_session_id,
                &mcp_specs,
                on_event,
            ))
            .await;
        }
        let home = crate::agent_sandbox::seed_session_home(&app, &session_id, agent_name)?;
        // Write the opted-in MCP servers into the mounted home — the seeded home is
        // clean, so this file is the ONLY MCP source (secrets resolved into the file,
        // never argv). REMOVE a stale file when this turn has none: the CLIs read it
        // implicitly, with no host-style `--strict-mcp-config` to ignore a leftover.
        if let Some((filename, _)) = crate::agent_sandbox::container_mcp_config(agent_name) {
            let config_path = home.join(filename);
            // opencode Research also needs its generated read-only-web agent in the
            // file even with no MCP servers; every other case writes only for servers.
            if mcp_specs.is_empty() && !opencode_research {
                let _ = std::fs::remove_file(&config_path);
            } else {
                let body = match kind {
                    AgentKind::Codex => crate::mcp::build_codex_config(&mcp_specs)?,
                    AgentKind::Claude => json_to_string(&crate::mcp::build_claude_config(&mcp_specs)?)?,
                    AgentKind::Copilot => {
                        json_to_string(&crate::mcp::build_copilot_config(&mcp_specs)?)?
                    }
                    AgentKind::Opencode => json_to_string(
                        &crate::mcp::build_opencode_config(&mcp_specs, opencode_research)?,
                    )?,
                };
                std::fs::write(&config_path, body)?;
            }
        }
        let name = crate::agent_sandbox::container_name(&session_id);
        // Mount the user's global skills read-only so a skill nudged by name resolves
        // in-container (the worktree only carries project skills). None if absent.
        let skills = crate::agent_sandbox::global_skills_dir();
        // Persistent npm cache so an npx MCP server downloads once, not every turn.
        let npm_cache = crate::agent_sandbox::npm_cache_dir(&app);
        // opencode reads its MCP config from `OPENCODE_CONFIG` (no flag) — point it at the
        // file mounted in the home. Other agents read their dotdir file implicitly.
        let container_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {
            let config_path = crate::agent_sandbox::container_mcp_config("opencode")
                .map(|(_, path)| path)
                .filter(|_| !mcp_specs.is_empty() || opencode_research);
            opencode_session_env(
                read_only,
                opencode_research,
                config_path,
                &mcp_names,
                &OpencodeReadMirror::default(),
            )
        } else {
            Vec::new()
        };
        // Use the repo's per-repo custom image when it's built, else the managed base.
        let image = crate::agent_sandbox::resolve_session_image(&runtime, &worktree_path).await;
        let args = crate::agent_sandbox::build_run_args(
            &runtime_name,
            agent_name,
            &worktree_path,
            &home,
            &name,
            &image,
            skills.as_deref().and_then(Path::to_str),
            npm_cache.as_deref().and_then(Path::to_str),
            &container_env,
            &inner,
        );
        return stream_agent(
            cancel.notify.clone(),
            kind,
            &runtime,
            args,
            stdin_text,
            &worktree_path,
            SESSION_TIMEOUT,
            "session",
            false,
            Some((runtime.clone(), name)),
            false,
            &extra_env,
            &on_event,
            None,
        )
        .await;
    }

    // Host: every CLI runs worktree-confined — see each `*_session_args` doc for
    // the mechanism (Claude bypass = soft; Codex `-s workspace-write` = enforced).
    // A 1.x opencode runs the binary its version check classified.
    let binary = match opencode_v1_binary {
        Some(binary) => binary,
        None => resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
            AppError::Command(format!(
                "{} CLI not found. Install it or set its path in Settings.",
                kind.label()
            ))
        })?,
    };
    // opencode has no config-file flag: it reads `OPENCODE_CONFIG`, and merges
    // config layers, so ours adds to the user's rather than replacing it.
    let host_extra_env: Vec<(&str, String)> = if kind == AgentKind::Opencode {
        let read_mirror = if read_only {
            opencode_read_mirror(mcp_config_path.as_deref(), Path::new(&worktree_path))
        } else {
            OpencodeReadMirror::default()
        };
        opencode_session_env(
            read_only,
            opencode_research,
            mcp_config_path,
            &mcp_names,
            &read_mirror,
        )
    } else {
        Vec::new()
    };
    // A stopped turn tells of nothing, so the cancel check comes first.
    if fresh_start {
        if turn_cancel_fired(&cancel.notify) {
            return Ok(None);
        }
        EventSink::send(
            &on_event,
            ReviewEvent::Notice {
                code: NOTICE_SESSION_RESET,
                text: fresh_start_note(kind),
            },
        );
    }
    stream_agent(
        cancel.notify.clone(),
        kind,
        &binary,
        inner,
        stdin_text,
        &worktree_path,
        SESSION_TIMEOUT,
        "session",
        false,
        None,
        false,
        &host_extra_env,
        &on_event,
        None,
    )
    .await
}

/// An opencode 2 review or generation run, entered from `agent_review`'s dispatch. It
/// runs only under its lock, and its generated MCP file is removed on every path out,
/// a refusal and a cancel included.
#[allow(clippy::too_many_arguments)]
async fn opencode2_review(
    app: tauri::AppHandle,
    cancel: Arc<Notify>,
    binary: &Path,
    version: crate::opencode2::Version,
    identity: Option<BinaryIdentity>,
    model: String,
    effort: String,
    system_prompt: String,
    user_prompt: String,
    repo_path: String,
    repo_aware: bool,
    mcp_self: bool,
    timeout_secs: Option<u64>,
    timeout_configurable: Option<bool>,
    review_id: String,
    on_event: Channel<ReviewEvent>,
) -> AppResult<Option<ReviewEvent>> {
    let self_specs = if mcp_self {
        vec![crate::mcp::self_server_spec(&repo_path)?]
    } else {
        Vec::new()
    };
    let mcp_config_path = crate::mcp::write_opencode2_config(&app, &review_id, &self_specs)?
        .map(|path| path.to_string_lossy().into_owned());
    let result = async {
        let servers: Vec<&str> = self_specs.iter().map(|s| s.name.as_str()).collect();
        let inherited_content = opencode2_inherited_content(mcp_config_path.as_deref());
        let diff_only_proven = opencode_facts()
            .lock()
            .is_ok_and(|facts| diff_only_proven(&facts, identity.as_ref(), version));
        let inputs = Opencode2Inputs {
            turn: Opencode2Turn::Review {
                version,
                pin: opencode2_review_pin(repo_aware),
            },
            servers: &servers,
            config_path: mcp_config_path.as_deref(),
            cwd: &repo_path,
            model: &model,
            inherited_content: inherited_content.as_deref(),
            case: if cfg!(windows) {
                crate::opencode2::MatchCase::Insensitive
            } else {
                crate::opencode2::MatchCase::Sensitive
            },
            diff_only_proven,
        };
        let notify: &Notify = &cancel;
        let variant = || {
            opencode2_variant(
                Some((binary, identity.as_ref(), version)),
                &model,
                &effort,
                Some(notify),
            )
        };
        let plan = opencode2_compose(&inputs, variant, |plan: SpawnPlan| async move {
            let captured = capture_tree(CaptureRequest {
                program: binary,
                args: plan.args,
                cwd: Some(plan.cwd.as_str()),
                env: plan.env,
                stdin: None,
                timeout: OPENCODE2_PROBE_TIMEOUT,
                cancel: Some(notify),
            })
            .await;
            opencode2_probe_answer(captured, OPENCODE2_PROBE_TIMEOUT)
        })
        .await
        .map_err(|refusal| AppError::Command(refusal.message()))?;
        let TurnPlan::Run {
            run,
            lock,
            read_back,
        } = plan
        else {
            return Ok(None);
        };
        let diff_only = matches!(
            inputs.turn,
            Opencode2Turn::Review {
                pin: crate::opencode2::Pin::DiffOnly,
                ..
            }
        );
        if read_back && diff_only {
            if let (Some(id), Ok(mut facts)) = (identity, opencode_facts().lock()) {
                facts.diff_only_proven.insert(id, version);
            }
        }
        if opencode2_cancel_fired(&cancel) {
            return Ok(None);
        }
        stream_agent(
            cancel.clone(),
            AgentKind::Opencode,
            binary,
            run.args,
            format!("{system_prompt}\n\n{user_prompt}"),
            &run.cwd,
            review_timeout(repo_aware || mcp_self, timeout_secs),
            "review",
            timeout_configurable.unwrap_or(false),
            None,
            true,
            &run.env,
            &on_event,
            Some(Opencode2Stream {
                parser: crate::opencode2::StreamParser::new(lock.as_ref()),
                native: None,
            }),
        )
        .await
    }
    .await;
    if mcp_config_path.is_some() {
        crate::mcp::cleanup_host_config(&app, &review_id);
    }
    result
}

/// One host turn of an opencode 2 session, entered from `agent_session`'s host dispatch.
/// A write turn names no agent; a Plan or Research turn runs only under its lock.
#[allow(clippy::too_many_arguments)]
async fn opencode2_host_session(
    app: tauri::AppHandle,
    cancel: Arc<Notify>,
    binary: &Path,
    // The catalog of this version picks the turn's variant.
    version: crate::opencode2::Version,
    identity: Option<BinaryIdentity>,
    model: String,
    effort: String,
    system_prompt: String,
    user_prompt: String,
    worktree_path: String,
    session_id: String,
    resume: bool,
    read_only: bool,
    web: bool,
    native_session_id: Option<String>,
    mcp_specs: &[crate::mcp::McpServerSpec],
    on_event: Channel<ReviewEvent>,
) -> AppResult<Option<ReviewEvent>> {
    let pin = opencode2_session_pin(read_only, web);
    let turn = if pin.is_some() {
        TurnKind::Pinned
    } else {
        TurnKind::Write
    };
    let stored = parse_native_ref(native_session_id.as_deref());
    let resume_plan = opencode2_resume_plan(resume, &stored, turn);
    let mcp_config_path = crate::mcp::write_opencode2_config(&app, &session_id, mcp_specs)?
        .map(|path| path.to_string_lossy().into_owned());
    // A new conversation has no context yet.
    let stdin_text = if resume_plan.resumed {
        user_prompt
    } else {
        turn_one_prompt(&system_prompt, &user_prompt)
    };
    let servers: Vec<&str> = mcp_specs.iter().map(|s| s.name.as_str()).collect();
    let inherited_content = opencode2_inherited_content(mcp_config_path.as_deref());
    let inputs = Opencode2Inputs {
        turn: Opencode2Turn::Session {
            pin,
            session_id: resume_plan
                .resumed
                .then_some(resume_plan.session_id.as_str()),
        },
        servers: &servers,
        config_path: mcp_config_path.as_deref(),
        cwd: &worktree_path,
        model: &model,
        inherited_content: inherited_content.as_deref(),
        case: if cfg!(windows) {
            crate::opencode2::MatchCase::Insensitive
        } else {
            crate::opencode2::MatchCase::Sensitive
        },
        diff_only_proven: false,
    };
    let notify: &Notify = &cancel;
    let variant = || {
        opencode2_variant(
            Some((binary, identity.as_ref(), version)),
            &model,
            &effort,
            Some(notify),
        )
    };
    let plan = opencode2_compose(&inputs, variant, |plan: SpawnPlan| async move {
        let captured = capture_tree(CaptureRequest {
            program: binary,
            args: plan.args,
            cwd: Some(plan.cwd.as_str()),
            env: plan.env,
            stdin: None,
            timeout: OPENCODE2_PROBE_TIMEOUT,
            cancel: Some(notify),
        })
        .await;
        opencode2_probe_answer(captured, OPENCODE2_PROBE_TIMEOUT)
    })
    .await
    .map_err(|refusal| AppError::Command(refusal.message()))?;
    let TurnPlan::Run { run, lock, .. } = plan else {
        return Ok(None);
    };
    let tag = NativeTag {
        kind: turn,
        resumed: resume_plan.resumed.then(|| {
            let given = native_session_id.as_deref().unwrap_or_default().trim();
            (resume_plan.session_id.clone(), given.to_string())
        }),
        rekey: resume_plan.resumed && matches!(stored, NativeRef::V1 { .. }),
    };
    if opencode2_cancel_fired(&cancel) {
        return Ok(None);
    }
    // Only a turn about to spawn tells of the reset: a refused or cancelled one changed
    // nothing.
    if resume_plan.reset {
        EventSink::send(
            &on_event,
            ReviewEvent::Notice {
                code: NOTICE_SESSION_RESET,
                text: NOTICE_RESET_GENERIC.to_string(),
            },
        );
    }
    stream_agent(
        cancel.clone(),
        AgentKind::Opencode,
        binary,
        run.args,
        stdin_text,
        &run.cwd,
        SESSION_TIMEOUT,
        "session",
        false,
        None,
        false,
        &run.env,
        &on_event,
        Some(Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(lock.as_ref()),
            native: Some(tag),
        }),
    )
    .await
}

/// One container turn of an opencode session, entered from `agent_session`'s container
/// dispatch. Only an image labelled for opencode 2 passes its gate; the gate reads the
/// base image's label, so a repository's derived image (`.gitdesktop/agent.Dockerfile`)
/// can still replace the opencode binary after it passed. A home opencode has never run in
/// first receives the host's opencode 2 sign-ins, one attempt per home. A Plan or
/// Research turn is read back in its own probe container, with the run's mounts, env and
/// working directory, and the lock document reaches both containers by name.
/// `stdin_text` is the 1.x arm's prompt, the system prompt already prepended unless the
/// turn asked to resume.
#[allow(clippy::too_many_arguments)]
async fn opencode2_container_session(
    app: tauri::AppHandle,
    cancel: Arc<Notify>,
    runtime: PathBuf,
    runtime_name: String,
    bin_path: Option<String>,
    model: String,
    effort: String,
    system_prompt: &str,
    stdin_text: String,
    worktree_path: String,
    session_id: String,
    resume: bool,
    read_only: bool,
    web: bool,
    native_session_id: Option<String>,
    mcp_specs: &[crate::mcp::McpServerSpec],
    on_event: Channel<ReviewEvent>,
) -> AppResult<Option<ReviewEvent>> {
    match crate::agent_sandbox::image_opencode_state(&runtime).await {
        crate::agent_sandbox::OpencodeImage::Current => {}
        crate::agent_sandbox::OpencodeImage::Outdated => {
            return Err(AppError::Command(
                "The agent image has an older opencode. Open Settings → AI and rebuild the image, then try again.".into(),
            ));
        }
        crate::agent_sandbox::OpencodeImage::Unreadable => {
            return Err(AppError::Command(
                "Couldn't read the agent image's details. Try again; if it keeps failing, rebuild the image in Settings → AI.".into(),
            ));
        }
    }
    if !mcp_specs.is_empty() {
        crate::mcp::validate_specs(mcp_specs)?;
    }
    let pin = opencode2_session_pin(read_only, web);
    let turn = if pin.is_some() {
        TurnKind::Pinned
    } else {
        TurnKind::Write
    };
    let stored = parse_native_ref(native_session_id.as_deref());
    let resume_plan = opencode2_resume_plan(resume, &stored, turn);
    // A new conversation has no context yet; the 1.x arm left it out of a turn that
    // asked to resume.
    let stdin_text = if resume && !resume_plan.resumed {
        turn_one_prompt(system_prompt, &stdin_text)
    } else {
        stdin_text
    };
    let home = crate::agent_sandbox::prepare_session_home(&app, &session_id, "opencode")?;
    // Read before any container command of the turn: the sign-ins are copied once per
    // home, on the turn that finds no opencode database in it.
    let fresh = crate::agent_sandbox::opencode_home_is_fresh(&home);
    // Only an opencode 2 host can export its sign-ins, and only its model catalog gives
    // the turn's effort a variant. Any other host gets the copied auth.json, which the
    // image's opencode imports when it creates its database.
    let host = resolve(AgentKind::Opencode, bin_path.as_deref()).await;
    let verdict = match host.as_deref() {
        Some(host) => Some(opencode_verdict(host).await),
        None => None,
    };
    let route = opencode2_sign_in_route(verdict.as_ref().map(|(verdict, _)| verdict), fresh);
    let export_host = match (route, host, verdict) {
        (
            SignInRoute::Export,
            Some(host),
            Some((OpencodeVerdict::Supported(crate::opencode2::Cli::V2(version)), identity)),
        ) => Some((host, identity, version)),
        _ => None,
    };
    if export_host.is_none() {
        if let SignInRoute::Copy(Some(text)) = route {
            EventSink::send(
                &on_event,
                ReviewEvent::Notice {
                    code: NOTICE_SIGN_INS_NOT_COPIED,
                    text: text.to_string(),
                },
            );
        }
        crate::agent_sandbox::seed_session_home(&app, &session_id, "opencode")?;
    }
    // opencode reads a leftover file too, so a turn with no servers removes it.
    if let Some((filename, _)) = crate::agent_sandbox::container_mcp_config("opencode") {
        let config_file = home.join(filename);
        if mcp_specs.is_empty() {
            let _ = std::fs::remove_file(&config_file);
        } else {
            std::fs::write(&config_file, crate::mcp::build_opencode2_config(mcp_specs)?)?;
        }
    }
    let image = crate::agent_sandbox::resolve_session_image(&runtime, &worktree_path).await;
    let skills = crate::agent_sandbox::global_skills_dir();
    let npm_cache = crate::agent_sandbox::npm_cache_dir(&app);
    let name = crate::agent_sandbox::container_name(&session_id);
    let probe_name = crate::agent_sandbox::probe_container_name(&session_id);
    let notify: &Notify = &cancel;
    if let Some((host, ..)) = export_host.as_ref().filter(|_| fresh) {
        // A sign-in file an earlier copy-route turn left would be imported first and
        // stay the active sign-in, so a failed removal skips the export.
        let removed = crate::agent_sandbox::remove_seeded_creds(&home, "opencode");
        let copied = match opencode2_leftover_notice(&removed) {
            Some(notice) => Some(notice),
            None => {
                opencode2_copy_sign_ins(
                    host,
                    &runtime,
                    crate::agent_sandbox::auth_import_run_args(
                        &runtime_name,
                        &worktree_path,
                        &home,
                        &session_id,
                        &image,
                    ),
                    &crate::agent_sandbox::auth_import_container_name(&session_id),
                    &worktree_path,
                    notify,
                )
                .await
            }
        };
        let (notice, go_on) = opencode2_after_copy(copied, || {
            crate::agent_sandbox::opencode_home_is_fresh(&home)
        });
        if let Some((code, text)) = notice {
            EventSink::send(&on_event, ReviewEvent::Notice { code, text });
        }
        if !go_on {
            return Ok(None);
        }
    }
    // The mounted path of the file written above.
    let config_path = crate::agent_sandbox::container_mcp_config("opencode")
        .map(|(_, path)| path)
        .filter(|_| !mcp_specs.is_empty());
    let servers: Vec<&str> = mcp_specs.iter().map(|s| s.name.as_str()).collect();
    let inputs = Opencode2Inputs {
        turn: Opencode2Turn::Session {
            pin,
            session_id: resume_plan
                .resumed
                .then_some(resume_plan.session_id.as_str()),
        },
        servers: &servers,
        config_path: config_path.as_deref(),
        cwd: &worktree_path,
        model: &model,
        // The container's opencode never sees the host's variable: it is forwarded by
        // name, carrying GitDesktop's document.
        inherited_content: None,
        case: crate::opencode2::MatchCase::Sensitive,
        diff_only_proven: false,
    };
    let runtime_bin: &Path = &runtime;
    let runtime_kind: &str = &runtime_name;
    let worktree: &str = &worktree_path;
    let home_dir: &Path = &home;
    let image_tag: &str = &image;
    let probe_container: &str = &probe_name;
    let skills_src = skills.as_deref().and_then(Path::to_str);
    let npm_cache_src = npm_cache.as_deref().and_then(Path::to_str);
    let variant = || {
        opencode2_variant(
            export_host
                .as_ref()
                .map(|(host, identity, version)| (host.as_path(), identity.as_ref(), *version)),
            &model,
            &effort,
            Some(notify),
        )
    };
    let plan = opencode2_compose(&inputs, variant, |plan: SpawnPlan| async move {
        // Killing the runtime client does not stop its container, and every attempt
        // reuses the name.
        let _ = run_capture(runtime_bin, &["rm", "-f", probe_container], DETECT_TIMEOUT).await;
        let (container_env, client_env) = split_container_env(plan.env);
        let probe_args = crate::agent_sandbox::build_run_args_full(
            runtime_kind,
            "opencode",
            worktree,
            home_dir,
            probe_container,
            image_tag,
            skills_src,
            npm_cache_src,
            &container_env,
            &[crate::opencode2::CONTENT_ENV],
            &plan.args,
        );
        let captured = capture_tree(CaptureRequest {
            program: runtime_bin,
            args: probe_args,
            cwd: Some(plan.cwd.as_str()),
            env: client_env,
            stdin: None,
            timeout: OPENCODE2_CONTAINER_PROBE_TIMEOUT,
            cancel: Some(notify),
        })
        .await;
        if container_may_remain(&captured) {
            let _ = run_capture(runtime_bin, &["rm", "-f", probe_container], DETECT_TIMEOUT).await;
        }
        opencode2_probe_answer(captured, OPENCODE2_CONTAINER_PROBE_TIMEOUT)
    })
    .await
    .map_err(|refusal| AppError::Command(refusal.message()))?;
    let TurnPlan::Run { run, lock, .. } = plan else {
        return Ok(None);
    };
    let tag = NativeTag {
        kind: turn,
        resumed: resume_plan.resumed.then(|| {
            let given = native_session_id.as_deref().unwrap_or_default().trim();
            (resume_plan.session_id.clone(), given.to_string())
        }),
        rekey: resume_plan.resumed && matches!(stored, NativeRef::V1 { .. }),
    };
    let (container_env, client_env) = split_container_env(run.env);
    let env_by_name: &[&'static str] = if lock.is_some() {
        &[crate::opencode2::CONTENT_ENV]
    } else {
        &[]
    };
    let run_args = crate::agent_sandbox::build_run_args_full(
        &runtime_name,
        "opencode",
        &worktree_path,
        &home,
        &name,
        &image,
        skills_src,
        npm_cache_src,
        &container_env,
        env_by_name,
        &run.args,
    );
    if opencode2_cancel_fired(&cancel) {
        return Ok(None);
    }
    // Only a turn about to spawn tells of the reset: a refused or cancelled one changed
    // nothing.
    if resume_plan.reset {
        EventSink::send(
            &on_event,
            ReviewEvent::Notice {
                code: NOTICE_SESSION_RESET,
                text: NOTICE_RESET_GENERIC.to_string(),
            },
        );
    }
    stream_agent(
        cancel.clone(),
        AgentKind::Opencode,
        &runtime,
        run_args,
        stdin_text,
        &run.cwd,
        SESSION_TIMEOUT,
        "session",
        false,
        Some((runtime.clone(), name)),
        false,
        &client_env,
        &on_event,
        Some(Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(lock.as_ref()),
            native: Some(tag),
        }),
    )
    .await
}

/// Copies the host's opencode sign-ins into a fresh container home: the host's export is
/// piped on stdin into a one-shot import container. The export holds secrets, so it
/// stays in memory, moved from the export into the import's stdin, and never reaches a
/// log, a file, argv, an env var, a notice or an error. Both commands' stderr is dropped
/// unread, and of the import only its exit code is read. Returns the notice for the
/// turn's timeline, or `None` for a cancelled turn.
async fn opencode2_copy_sign_ins(
    host: &Path,
    runtime: &Path,
    import_args: Vec<String>,
    import_container: &str,
    worktree_path: &str,
    cancel: &Notify,
) -> Option<(&'static str, String)> {
    let not_copied = || Some((NOTICE_SIGN_INS_NOT_COPIED, SIGN_INS_NOT_COPIED.to_string()));
    // No cwd and no project config: the process holding the secrets loads no
    // repository's plugins.
    let export = capture_tree(CaptureRequest {
        program: host,
        args: OPENCODE2_AUTH_EXPORT_ARGS
            .iter()
            .map(|arg| arg.to_string())
            .collect(),
        cwd: None,
        env: crate::opencode2::project_disable_env()
            .into_iter()
            .chain([("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string())])
            .collect(),
        stdin: None,
        timeout: OPENCODE2_AUTH_EXPORT_TIMEOUT,
        cancel: Some(cancel),
    })
    .await;
    let export_stdout = match export {
        Ok(Captured::Exited {
            code: 0, stdout, ..
        }) => stdout,
        Ok(Captured::Cancelled) => return None,
        _ => return not_copied(),
    };
    match crate::agent_sandbox::credential_export_count(&export_stdout) {
        Ok(0) => return Some((NOTICE_NO_SIGN_INS, NO_SIGN_INS.to_string())),
        Ok(_) => {}
        // The error is fixed text that never quotes the export.
        Err(error) => {
            return Some((
                NOTICE_SIGN_INS_NOT_COPIED,
                format!("{error} {SIGN_INS_RETRY_HINT}"),
            ))
        }
    }
    // A container left by an earlier, killed attempt would fail the import on its name.
    let _ = run_capture(runtime, &["rm", "-f", import_container], DETECT_TIMEOUT).await;
    let import = capture_tree(CaptureRequest {
        program: runtime,
        args: import_args,
        cwd: Some(worktree_path),
        env: Vec::new(),
        stdin: Some(export_stdout),
        timeout: OPENCODE2_AUTH_IMPORT_TIMEOUT,
        cancel: Some(cancel),
    })
    .await;
    if container_may_remain(&import) {
        // Killing the runtime client does not stop its container.
        let _ = run_capture(runtime, &["rm", "-f", import_container], DETECT_TIMEOUT).await;
    }
    match import {
        Ok(Captured::Exited { code: 0, .. }) => {
            Some((NOTICE_SIGN_INS_COPIED, SIGN_INS_COPIED.to_string()))
        }
        Ok(Captured::Cancelled) => None,
        _ => not_copied(),
    }
}

#[cfg(test)]
mod child_env_tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_gdAbc";

    /// Look up a var from a fixture table, so these run identically on every OS.
    fn lookup(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    /// Records what an applier did to a child's environment, so the scrub is
    /// assertable on Windows/macOS too, where the override plan is empty.
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

    #[test]
    fn sanitize_child_env_drops_an_inherited_pwd() {
        let mut env = RecordingEnv::default();
        sanitize_child_env(&mut env);
        assert!(
            env.unset.iter().any(|k| k == "PWD"),
            "PWD must be dropped on every platform: {env:?}"
        );
        assert!(
            !env.set.iter().any(|(k, _)| k == "PWD"),
            "PWD must be dropped, never re-set: {env:?}"
        );
    }

    /// The values `env` set for `key`, in order.
    fn set_values<'a>(env: &'a RecordingEnv, key: &str) -> Vec<&'a str> {
        env.set
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .collect()
    }

    #[test]
    fn sanitize_child_env_sets_path_and_the_marker_to_the_same_merged_value() {
        let merged = "/Users/me/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/bin:/bin";
        let mut env = RecordingEnv::default();
        sanitize_child_env_with(&mut env, &[], Some(merged));
        assert_eq!(set_values(&env, "PATH").last(), Some(&merged), "{env:?}");
        assert_eq!(
            set_values(&env, SHELL_PATH_MERGED_MARKER),
            vec![merged],
            "the marker carries the PATH value verbatim: {env:?}"
        );
        assert!(env.unset.iter().any(|k| k == "PWD"), "{env:?}");
    }

    #[test]
    fn sanitize_child_env_sets_the_merged_path_after_the_override_plan() {
        // An AppImage plan rewrites PATH too; the merge started from that value, so
        // the merged PATH must be the last PATH set and the marker must equal it.
        let plan = [
            ("PATH", Some("/usr/local/bin:/usr/bin".to_string())),
            ("LD_LIBRARY_PATH", None),
        ];
        let merged = "/home/me/.local/bin:/usr/local/bin:/usr/bin";
        let mut env = RecordingEnv::default();
        sanitize_child_env_with(&mut env, &plan, Some(merged));
        assert_eq!(
            set_values(&env, "PATH"),
            vec!["/usr/local/bin:/usr/bin", merged],
            "{env:?}"
        );
        assert_eq!(set_values(&env, SHELL_PATH_MERGED_MARKER), vec![merged]);
        assert!(env.unset.iter().any(|k| k == "LD_LIBRARY_PATH"), "{env:?}");
    }

    #[test]
    fn sanitize_child_env_without_a_merge_sets_neither_path_nor_the_marker() {
        let mut env = RecordingEnv::default();
        sanitize_child_env_with(&mut env, &[], None);
        assert!(
            set_values(&env, SHELL_PATH_MERGED_MARKER).is_empty(),
            "{env:?}"
        );
        assert!(!env.unset.iter().any(|k| k == SHELL_PATH_MERGED_MARKER));
        assert!(set_values(&env, "PATH").is_empty(), "{env:?}");
        assert!(env.unset.iter().any(|k| k == "PWD"), "{env:?}");
    }

    #[test]
    fn sanitize_child_env_in_tests_never_sees_a_captured_path() {
        // Tests never prime the process-global cell (on Windows there is none), so the
        // real entry point takes the no-merge arm; a merge here means a test primed it.
        assert_eq!(merged_shell_path(), None);
        let mut env = RecordingEnv::default();
        sanitize_child_env(&mut env);
        assert!(
            set_values(&env, SHELL_PATH_MERGED_MARKER).is_empty(),
            "{env:?}"
        );
    }

    /// Expected `strip_appdir_pathlist` result when `list` survived a real strip.
    fn stripped_to(list: &str) -> (Option<String>, bool) {
        (Some(list.to_string()), true)
    }

    /// Expected result when nothing `$APPDIR`-derived was there to drop.
    fn no_strip(list: &str) -> (Option<String>, bool) {
        (Some(list.to_string()), false)
    }

    #[test]
    fn a_list_without_bundle_entries_is_untouched() {
        assert_eq!(
            strip_appdir_pathlist("/usr/bin:/bin", APPDIR),
            no_strip("/usr/bin:/bin")
        );
    }

    #[test]
    fn an_all_bundle_list_strips_to_nothing() {
        assert_eq!(
            strip_appdir_pathlist(
                "/tmp/.mount_gdAbc/usr/lib:/tmp/.mount_gdAbc:/tmp/.mount_gdAbc/usr/lib/x86_64-linux-gnu",
                APPDIR
            ),
            (None, true)
        );
    }

    #[test]
    fn bundle_entries_are_dropped_in_place_and_host_order_survives() {
        assert_eq!(
            strip_appdir_pathlist(
                "/tmp/.mount_gdAbc/usr/bin:/usr/local/bin:/tmp/.mount_gdAbc/usr/lib:/usr/bin",
                APPDIR
            ),
            stripped_to("/usr/local/bin:/usr/bin")
        );
    }

    #[test]
    fn a_trailing_slash_on_appdir_is_equivalent() {
        let value = "/tmp/.mount_gdAbc/usr/lib:/usr/lib";
        assert_eq!(
            strip_appdir_pathlist(value, "/tmp/.mount_gdAbc/"),
            strip_appdir_pathlist(value, APPDIR),
            "a trailing slash must not change the outcome"
        );
        // The bare directory itself matches with or without the trailing slash.
        assert_eq!(
            strip_appdir_pathlist("/tmp/.mount_gdAbc", "/tmp/.mount_gdAbc//"),
            (None, true)
        );
    }

    #[test]
    fn a_prefix_that_is_not_a_path_boundary_survives() {
        // A sibling mount whose name merely starts with ours must not be stripped —
        // and nothing was dropped, so no override is warranted either.
        assert_eq!(
            strip_appdir_pathlist("/tmp/.mount_gdAbcX/lib:/usr/lib", APPDIR),
            no_strip("/tmp/.mount_gdAbcX/lib:/usr/lib")
        );
    }

    #[test]
    fn a_host_only_list_collapses_empty_segments_but_emits_no_override() {
        // The helper always collapses empty segments; the child keeps its original
        // value only because a host-only list produces no override at all.
        assert_eq!(
            strip_appdir_pathlist("/usr/local/bin::/usr/bin", APPDIR),
            no_strip("/usr/local/bin:/usr/bin")
        );
        assert!(compute_child_env_overrides(
            APPDIR,
            lookup(&[("PATH", "/usr/local/bin::/usr/bin")])
        )
        .is_empty());
    }

    #[test]
    fn empty_segments_collapse_and_a_list_with_no_survivors_unsets() {
        assert_eq!(
            strip_appdir_pathlist(":/tmp/.mount_gdAbc/bin::/usr/bin:", APPDIR),
            stripped_to("/usr/bin")
        );
        assert_eq!(strip_appdir_pathlist("", APPDIR), (None, false));
        assert_eq!(strip_appdir_pathlist("::", APPDIR), (None, false));
        // An empty appdir strips nothing (the plan never asks for one).
        assert_eq!(strip_appdir_pathlist("/usr/bin", ""), no_strip("/usr/bin"));
    }

    #[test]
    fn vars_outside_the_two_tables_never_enter_the_plan() {
        // GDK_BACKEND/GTK_THEME aren't `$APPDIR`-derived and LD_PRELOAD is the
        // user's, so even bundle-looking values must come through untouched.
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[
                ("GDK_BACKEND", "/tmp/.mount_gdAbc/wayland"),
                ("GTK_THEME", "/tmp/.mount_gdAbc/Adwaita"),
                ("LD_PRELOAD", "/tmp/.mount_gdAbc/usr/lib/libfoo.so"),
            ]),
        );
        assert!(plan.is_empty(), "unexpected overrides: {plan:?}");
    }

    #[test]
    fn a_scalar_equal_to_appdir_is_unset_and_respects_the_path_boundary() {
        let expected = vec![("GTK_DATA_PREFIX", None)];
        assert_eq!(
            compute_child_env_overrides(
                APPDIR,
                lookup(&[("GTK_DATA_PREFIX", "/tmp/.mount_gdAbc")])
            ),
            expected
        );
        // Same directory, appdir spelled with a trailing slash.
        assert_eq!(
            compute_child_env_overrides(
                "/tmp/.mount_gdAbc/",
                lookup(&[("GTK_DATA_PREFIX", "/tmp/.mount_gdAbc")])
            ),
            expected
        );
        // A sibling directory sharing the prefix belongs to the host — leave it.
        assert!(compute_child_env_overrides(
            APPDIR,
            lookup(&[("GTK_DATA_PREFIX", "/tmp/.mount_gdAbcX")])
        )
        .is_empty());
    }

    #[test]
    fn appdir_itself_is_unset_and_a_sibling_mount_is_untouched() {
        assert_eq!(
            compute_child_env_overrides(APPDIR, lookup(&[("APPDIR", APPDIR)])),
            vec![("APPDIR", None)]
        );
        let sibling_plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[("APPDIR", "/tmp/.mount_gdAbcX")]),
        );
        assert!(sibling_plan.is_empty());
    }

    #[test]
    fn an_unset_pre_launch_xdg_data_dirs_is_unset_again() {
        let raw = format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:");
        assert_eq!(
            compute_child_env_overrides(APPDIR, |name| {
                (name == "XDG_DATA_DIRS").then(|| raw.clone())
            }),
            vec![("XDG_DATA_DIRS", None)]
        );
    }

    #[test]
    fn a_custom_pre_launch_xdg_data_dirs_is_restored_verbatim() {
        for original in ["/opt/share", ":/opt/share::/usr/share:"] {
            let raw = format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:{original}");
            assert_eq!(
                compute_child_env_overrides(APPDIR, |name| {
                    (name == "XDG_DATA_DIRS").then(|| raw.clone())
                }),
                vec![("XDG_DATA_DIRS", Some(original.to_string()))]
            );
        }
    }

    #[test]
    fn a_pre_launch_system_xdg_data_dirs_is_restored_once() {
        let raw = format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:/usr/share");
        assert_eq!(
            compute_child_env_overrides(APPDIR, |name| {
                (name == "XDG_DATA_DIRS").then(|| raw.clone())
            }),
            vec![("XDG_DATA_DIRS", Some("/usr/share".to_string()))]
        );
    }

    #[test]
    fn an_apprun_only_xdg_data_dirs_uses_generic_stripping() {
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[("XDG_DATA_DIRS", "/tmp/.mount_gdAbc/usr/share/:/usr/share")]),
        );
        assert_eq!(
            plan,
            vec![("XDG_DATA_DIRS", Some("/usr/share".to_string()))]
        );
    }

    #[test]
    fn xdg_data_dirs_restoration_accepts_a_trailing_slash_on_appdir() {
        for original in ["", "/opt/share"] {
            let raw = format!("{APPDIR}/usr/share/:{APPDIR}/usr/share:/usr/share:{original}");
            let expected = vec![(
                "XDG_DATA_DIRS",
                (!original.is_empty()).then(|| original.to_string()),
            )];
            assert_eq!(
                compute_child_env_overrides(&format!("{APPDIR}/"), |name| {
                    (name == "XDG_DATA_DIRS").then(|| raw.clone())
                }),
                expected
            );
            assert_eq!(
                compute_child_env_overrides(APPDIR, |name| {
                    (name == "XDG_DATA_DIRS").then(|| raw.clone())
                }),
                expected
            );
        }
    }

    #[test]
    fn bundle_pythonhome_is_unset_and_host_pythonhome_is_untouched() {
        assert_eq!(
            compute_child_env_overrides(
                APPDIR,
                lookup(&[("PYTHONHOME", "/tmp/.mount_gdAbc/usr/")])
            ),
            vec![("PYTHONHOME", None)]
        );
        assert!(
            compute_child_env_overrides(APPDIR, lookup(&[("PYTHONHOME", "/opt/python3.12")]))
                .is_empty()
        );
    }

    #[test]
    fn bundle_pythonpath_is_unset_or_keeps_the_host_path() {
        assert_eq!(
            compute_child_env_overrides(
                APPDIR,
                lookup(&[("PYTHONPATH", "/tmp/.mount_gdAbc/usr/share/pyshared/:")])
            ),
            vec![("PYTHONPATH", None)]
        );
        assert_eq!(
            compute_child_env_overrides(
                APPDIR,
                lookup(&[(
                    "PYTHONPATH",
                    "/tmp/.mount_gdAbc/usr/share/pyshared/:/home/me/lib",
                )])
            ),
            vec![("PYTHONPATH", Some("/home/me/lib".to_string()))]
        );
    }

    #[test]
    fn bundle_perllib_is_unset_or_keeps_the_host_path() {
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[(
                "PERLLIB",
                "/tmp/.mount_gdAbc/usr/share/perl5/:/tmp/.mount_gdAbc/usr/lib/perl5/:",
            )]),
        );
        assert_eq!(plan, vec![("PERLLIB", None)]);
        assert_eq!(
            compute_child_env_overrides(
                APPDIR,
                lookup(&[(
                    "PERLLIB",
                    "/tmp/.mount_gdAbc/usr/share/perl5/:/home/me/perl5",
                )])
            ),
            vec![("PERLLIB", Some("/home/me/perl5".to_string()))]
        );
    }

    #[test]
    fn qt_plugin_path_keeps_only_host_plugins() {
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[(
                "QT_PLUGIN_PATH",
                "/tmp/.mount_gdAbc/usr/lib/qt4/plugins/:/tmp/.mount_gdAbc/usr/lib/qt5/plugins/:/usr/lib64/qt5/plugins",
            )]),
        );
        assert_eq!(
            plan,
            vec![("QT_PLUGIN_PATH", Some("/usr/lib64/qt5/plugins".to_string()))]
        );
    }

    #[test]
    fn no_appdir_means_no_overrides_at_all() {
        assert!(
            compute_child_env_overrides("", lookup(&[("PATH", "/tmp/.mount_gdAbc/usr/bin")]))
                .is_empty()
        );
    }

    #[test]
    fn the_plan_rewrites_lists_removes_bundle_scalars_and_skips_clean_vars() {
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[
                ("LD_LIBRARY_PATH", "/tmp/.mount_gdAbc/usr/lib"),
                ("PATH", "/tmp/.mount_gdAbc/usr/bin:/usr/bin"),
                ("XDG_DATA_DIRS", "/usr/share"),
                (
                    "GI_TYPELIB_PATH",
                    "/tmp/.mount_gdAbc/usr/lib/girepository-1.0:/usr/lib/girepository-1.0",
                ),
                (
                    "GDK_PIXBUF_MODULE_FILE",
                    "/tmp/.mount_gdAbc/usr/lib/loaders.cache",
                ),
                ("GTK_IM_MODULE_FILE", "/etc/gtk/immodules.cache"),
            ]),
        );
        assert_eq!(
            plan,
            vec![
                ("LD_LIBRARY_PATH", None),
                ("PATH", Some("/usr/bin".to_string())),
                ("GI_TYPELIB_PATH", Some("/usr/lib/girepository-1.0".to_string())),
                ("GDK_PIXBUF_MODULE_FILE", None),
            ]
        );
    }

    #[test]
    fn path_is_never_unset_even_when_every_entry_is_bundle_derived() {
        let plan = compute_child_env_overrides(
            APPDIR,
            lookup(&[("PATH", "/tmp/.mount_gdAbc/usr/bin:/tmp/.mount_gdAbc/bin")]),
        );
        assert_eq!(
            plan,
            vec![("PATH", Some("/usr/local/bin:/usr/bin:/bin".to_string()))]
        );
        // An already-empty PATH is left alone rather than re-set to itself.
        assert!(compute_child_env_overrides(APPDIR, lookup(&[("PATH", "")])).is_empty());
    }

    #[test]
    fn portable_pty_env_remove_drops_an_inherited_var() {
        // The PTY applier strips inherited bundle paths through `env_remove`, so
        // `CommandBuilder` must snapshot the parent environment into its own map: an
        // `env_remove` that only cleared caller overrides would leave them in place.
        let mut cmd = portable_pty::CommandBuilder::new("x");
        assert!(
            cmd.get_env("PATH").is_some(),
            "portable-pty must snapshot the parent environment"
        );
        cmd.env_remove("PATH");
        assert!(
            cmd.get_env("PATH").is_none(),
            "portable-pty must drop inherited vars, not just caller overrides"
        );
    }

    /// A capture marker shaped like the production one.
    const MARK: &str = "GDPATH1fx2e";

    /// `value` between a marker pair, the way the capture's stdout frames it.
    fn framed(value: &str) -> Vec<u8> {
        format!("{MARK}{value}{MARK}").into_bytes()
    }

    #[test]
    fn login_path_merge_puts_shell_entries_first() {
        // Shell list a superset of inherited, the reverse, and disjoint lists.
        assert_eq!(merge_path_lists("/a:/b:/c", "/b"), "/a:/b:/c");
        assert_eq!(merge_path_lists("/b", "/a:/b:/c"), "/b:/a:/c");
        assert_eq!(merge_path_lists("/a", "/b"), "/a:/b");
    }

    #[test]
    fn login_path_merge_of_identical_lists_is_idempotent() {
        let list = "/opt/homebrew/bin:/usr/bin:/bin";
        let once = merge_path_lists(list, list);
        assert_eq!(once, list);
        assert_eq!(merge_path_lists(&once, list), list);
    }

    #[test]
    fn login_path_merge_collapses_duplicates_within_each_side() {
        // The first occurrence keeps its position.
        assert_eq!(merge_path_lists("/a:/b:/a", "/c:/c:/b"), "/a:/b:/c");
    }

    #[test]
    fn login_path_merge_drops_relative_entries_on_both_sides() {
        // git runs in the open repo, where a relative entry would resolve.
        assert_eq!(
            merge_path_lists(
                "./ssh:/a:node_modules/.bin:bin",
                "bin:/b:./x:node_modules/.bin"
            ),
            "/a:/b"
        );
    }

    #[test]
    fn login_path_merge_dedupes_by_exact_string_so_trailing_slash_twins_survive() {
        // `/usr/bin/` and `/usr/bin` name one dir, but the dedupe is exact-string.
        assert_eq!(
            merge_path_lists("/usr/bin/", "/usr/bin"),
            "/usr/bin/:/usr/bin"
        );
    }

    #[test]
    fn login_path_merge_keeps_entries_containing_spaces() {
        assert_eq!(
            merge_path_lists(
                "/Applications/My Tools/bin",
                "/usr/bin:/Applications/My Tools/bin"
            ),
            "/Applications/My Tools/bin:/usr/bin"
        );
    }

    #[test]
    fn login_path_merge_drops_empty_entries_and_tolerates_empty_sides() {
        assert_eq!(merge_path_lists(":/a::", "::/b:"), "/a:/b");
        assert_eq!(merge_path_lists("", "/b:/c"), "/b:/c");
        assert_eq!(merge_path_lists("/a", ""), "/a");
        assert_eq!(merge_path_lists("", ""), "");
    }

    #[test]
    fn login_path_capture_reads_between_markers_despite_banner_noise() {
        let mut out = b"Welcome back!\nnvm: using node 22\n".to_vec();
        out.extend(framed("/usr/local/bin:/usr/bin:/bin\n"));
        out.extend_from_slice(b"\nlogout banner\n");
        assert_eq!(
            finalize_capture(&out, MARK, None).as_deref(),
            Some("/usr/local/bin:/usr/bin:/bin")
        );
    }

    #[test]
    fn login_path_capture_without_a_marker_pair_fails() {
        // The negative control: no marker at all, then only the opening one.
        assert_eq!(finalize_capture(b"/usr/bin:/bin\n", MARK, None), None);
        let opened = format!("{MARK}/usr/bin:/bin\n");
        assert_eq!(finalize_capture(opened.as_bytes(), MARK, None), None);
    }

    #[test]
    fn login_path_capture_skips_a_partial_marker_prefix_in_the_noise() {
        let mut out = format!("banner {} more\n", &MARK[..6]).into_bytes();
        out.extend(framed("/usr/bin:/bin\n"));
        assert_eq!(
            finalize_capture(&out, MARK, None).as_deref(),
            Some("/usr/bin:/bin")
        );
    }

    #[test]
    fn login_path_capture_trims_exactly_one_trailing_newline() {
        let lf = framed("/usr/bin:/bin\n");
        assert_eq!(
            finalize_capture(&lf, MARK, None).as_deref(),
            Some("/usr/bin:/bin")
        );
        let crlf = framed("/usr/bin:/bin\r\n");
        assert_eq!(
            finalize_capture(&crlf, MARK, None).as_deref(),
            Some("/usr/bin:/bin")
        );
        // A second newline survives the trim and is rejected as a control character.
        assert_eq!(finalize_capture(&framed("/usr/bin\n\n"), MARK, None), None);
    }

    #[test]
    fn login_path_capture_of_an_empty_value_fails() {
        assert_eq!(finalize_capture(&framed(""), MARK, None), None);
        // Empty only after the newline trim: still a failed capture.
        assert_eq!(finalize_capture(&framed("\n"), MARK, None), None);
        assert_eq!(finalize_capture(&framed("\r\n"), MARK, None), None);
    }

    #[test]
    fn login_path_capture_with_only_relative_entries_fails() {
        assert_eq!(
            finalize_capture(&framed("bin:./ssh:node_modules/.bin\n"), MARK, None),
            None
        );
    }

    #[test]
    fn login_path_capture_rejects_control_characters() {
        for value in [
            "/usr/bin:\x1b[0m/bin\n",
            "/usr/bin\x07:/bin\n",
            "/usr/bin\r:/bin\n",
        ] {
            assert_eq!(
                finalize_capture(&framed(value), MARK, None),
                None,
                "{value:?}"
            );
        }
    }

    #[test]
    fn login_path_capture_rejects_a_non_utf8_value_rather_than_decoding_lossily() {
        let mut out = MARK.as_bytes().to_vec();
        out.extend_from_slice(b"/usr/bin:/opt/\xff/bin\n");
        out.extend_from_slice(MARK.as_bytes());
        assert_eq!(finalize_capture(&out, MARK, None), None);
    }

    #[test]
    fn login_path_capture_tolerates_non_utf8_noise_outside_the_markers() {
        // A Latin-1 motd before the pair and after it.
        let mut out = b"Bienvenue \xe0 bord\n".to_vec();
        out.extend(framed("/usr/bin:/bin\n"));
        out.extend_from_slice(b"\xff\xfe bye\n");
        assert_eq!(
            finalize_capture(&out, MARK, None).as_deref(),
            Some("/usr/bin:/bin")
        );
    }

    #[test]
    fn login_path_capture_strips_only_true_appdir_entries() {
        let captured = framed(
            "/tmp/.mount_gdAbc/usr/bin:/usr/local/bin:/tmp/.mount_gdAbcde/bin:/tmp/.mount_gdAbc:/usr/bin\n",
        );
        assert_eq!(
            finalize_capture(&captured, MARK, Some(APPDIR)).as_deref(),
            Some("/usr/local/bin:/tmp/.mount_gdAbcde/bin:/usr/bin")
        );
        // Nothing but bundle entries leaves nothing to cache.
        let all_bundle = framed("/tmp/.mount_gdAbc/usr/bin:/tmp/.mount_gdAbc/bin\n");
        assert_eq!(finalize_capture(&all_bundle, MARK, Some(APPDIR)), None);
    }

    #[test]
    fn login_path_inherited_side_prefers_the_plan_entry() {
        let env = std::ffi::OsStr::new("/env/bin");
        assert_eq!(
            inherited_path_value(Some("/plan/bin"), Some(env)).as_deref(),
            Some("/plan/bin")
        );
        assert_eq!(
            inherited_path_value(None, Some(env)).as_deref(),
            Some("/env/bin")
        );
        // Both absent: an empty inherited side, so the merge is the shell list alone.
        assert_eq!(inherited_path_value(None, None).as_deref(), Some(""));
    }

    #[cfg(unix)]
    #[test]
    fn login_path_inherited_side_refuses_a_non_utf8_process_path() {
        use std::os::unix::ffi::OsStrExt;
        let env = std::ffi::OsStr::from_bytes(b"/usr/bin:\xff");
        assert_eq!(inherited_path_value(None, Some(env)), None);
        // The plan's entry still wins over an unreadable process value.
        assert_eq!(
            inherited_path_value(Some("/usr/bin"), Some(env)).as_deref(),
            Some("/usr/bin")
        );
    }

    #[test]
    fn login_path_appimage_merge_never_carries_a_bundle_entry() {
        const ENV_PATH: &str = "/tmp/.mount_gdAbc/usr/bin:/usr/bin:/bin";
        let plan = compute_child_env_overrides(APPDIR, lookup(&[("PATH", ENV_PATH)]));
        let plan_path = plan_path_entry(&plan);
        let shell = finalize_capture(
            &framed("/tmp/.mount_gdAbc/usr/bin:/home/u/.nvm/bin:/usr/bin\n"),
            MARK,
            Some(APPDIR),
        )
        .expect("a host entry survives the strip");
        let inherited = inherited_path_value(plan_path, Some(std::ffi::OsStr::new(ENV_PATH)))
            .expect("the plan's PATH is UTF-8");
        assert_eq!(
            inherited, "/usr/bin:/bin",
            "the inherited side is the plan's stripped PATH"
        );
        let merged = merge_path_lists(&shell, &inherited);
        assert_eq!(merged, "/home/u/.nvm/bin:/usr/bin:/bin");
        assert!(merged
            .split(':')
            .all(|entry| !is_under_appdir(entry, APPDIR)));
    }

    #[test]
    fn login_path_capture_reading_stops_only_once_the_pair_closes() {
        let open = format!("noise{MARK}/usr/bin");
        assert!(!capture_pair_closed(open.as_bytes(), MARK.as_bytes()));
        let partial = format!("{MARK}/usr/bin\n{}", &MARK[..4]);
        assert!(!capture_pair_closed(partial.as_bytes(), MARK.as_bytes()));
        assert!(capture_pair_closed(&framed("/usr/bin\n"), MARK.as_bytes()));
    }

    #[test]
    fn login_path_lookup_takes_the_first_match_in_path_order() {
        // A shim earlier on the shell PATH beats an older copy later on it.
        let installed = [
            "/usr/local/bin/pre-commit",
            "/home/u/.pyenv/shims/pre-commit",
        ];
        let is_exe = |c: &str| installed.contains(&c);
        assert_eq!(
            first_on_path("/home/u/.pyenv/shims:/usr/local/bin", "pre-commit", is_exe).as_deref(),
            Some("/home/u/.pyenv/shims/pre-commit")
        );
        assert_eq!(
            first_on_path("/usr/local/bin:/home/u/.pyenv/shims", "pre-commit", is_exe).as_deref(),
            Some("/usr/local/bin/pre-commit")
        );
    }

    #[test]
    fn login_path_lookup_skips_relative_and_empty_entries() {
        // Every candidate "exists", so only the entry filter decides.
        let any = |_: &str| true;
        assert_eq!(
            first_on_path(":bin:./x:node_modules/.bin:/opt/bin", "lefthook", any).as_deref(),
            Some("/opt/bin/lefthook")
        );
        assert_eq!(first_on_path("bin::./x", "lefthook", any), None);
        assert_eq!(first_on_path("", "lefthook", any), None);
    }

    #[test]
    fn login_path_lookup_joins_a_trailing_slash_entry_and_misses_cleanly() {
        let is_exe = |c: &str| c == "/opt/bin/lefthook";
        assert_eq!(
            first_on_path("/usr/bin:/opt/bin/", "lefthook", is_exe).as_deref(),
            Some("/opt/bin/lefthook")
        );
        assert_eq!(first_on_path("/usr/bin:/bin", "lefthook", is_exe), None);
    }

    #[cfg(unix)]
    #[test]
    fn login_path_lookup_passes_over_a_copy_we_cannot_execute() {
        use std::os::unix::fs::PermissionsExt;
        // Root passes access(X_OK) whenever any execute bit is set, so the
        // owner-cannot-run fixture proves nothing there.
        // SAFETY: geteuid has no preconditions and cannot fail.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let root = std::env::temp_dir().join(format!("gd-login-path-exec-{}", std::process::id()));
        let (first, second) = (root.join("a"), root.join("b"));
        for (dir, mode) in [(&first, 0o011), (&second, 0o755)] {
            std::fs::create_dir_all(dir).unwrap();
            let tool = dir.join("gd-tool");
            std::fs::write(&tool, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(mode)).unwrap();
        }
        let path = format!("{}:{}", first.display(), second.display());
        let found = first_on_path(&path, "gd-tool", executable_by_us);
        // Negative control: an any-execute-bit test would have taken the first copy.
        let by_mode_bits = first_on_path(&path, "gd-tool", |c| {
            std::fs::metadata(c).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        });
        let _ = std::fs::remove_dir_all(&root);
        let expected = |dir: &PathBuf| format!("{}/gd-tool", dir.display());
        assert_eq!(found, Some(expected(&second)));
        assert_eq!(by_mode_bits, Some(expected(&first)));
    }

    #[test]
    fn login_path_resolve_takes_the_process_path_before_the_shell_path() {
        let on_shell = |name: &str| {
            first_on_path("/home/u/.nvm/bin:/usr/bin", name, |c| {
                c == "/home/u/.nvm/bin/opencode" || c == "/home/u/.nvm/bin/claude"
            })
            .map(PathBuf::from)
        };
        // On the process PATH only, and on both: the process side wins either way.
        let process = |_: &[&str]| Some(PathBuf::from("/usr/local/bin/claude"));
        assert_eq!(
            resolve_without_spawn(&["claude"], process, on_shell),
            Some(PathBuf::from("/usr/local/bin/claude"))
        );
        // On the shell PATH only, under the second candidate name.
        assert_eq!(
            resolve_without_spawn(&["oc", "opencode"], |_| None, on_shell),
            Some(PathBuf::from("/home/u/.nvm/bin/opencode"))
        );
        // On neither: only the login-shell fallback is left.
        assert_eq!(resolve_without_spawn(&["codex"], |_| None, on_shell), None);
    }

    #[test]
    fn login_path_resolver_single_quotes_the_name() {
        assert_eq!(
            command_v_body("lefthook").as_deref(),
            Some("command -v 'lefthook'")
        );
        assert_eq!(
            command_v_body("a; rm -rf ~").as_deref(),
            Some("command -v 'a; rm -rf ~'")
        );
        // Names no single-quoting is safe for in every shell (fish included) are refused.
        for name in ["it's", r"a\b", r"x\'; id #", "a\nb", "a\u{7}b"] {
            assert_eq!(command_v_body(name), None, "{name:?}");
        }
    }

    #[test]
    fn login_path_shared_script_never_spells_the_marker_whole() {
        let script = marker_wrapped_script(MARK, "command printenv PATH");
        assert_eq!(
            script,
            "printf '%s%s' 'GDPAT' 'H1fx2e'; command printenv PATH; printf '%s%s' 'GDPAT' 'H1fx2e'"
        );
        assert!(!script.contains(MARK));
    }

    #[test]
    fn login_path_resolver_reads_the_value_between_markers_despite_noise() {
        // A decoy outside the pair and non-UTF-8 noise around it must not matter.
        let mut out = b"/usr/bin/lefthook\nBienvenue \xe0 bord\n".to_vec();
        out.extend(framed("/opt/bin/lefthook\n"));
        out.extend_from_slice(b"\xff /usr/bin/lefthook\n");
        let any = |_: &Path| true;
        assert_eq!(
            command_v_match(&out, MARK, "lefthook", any),
            Some(PathBuf::from("/opt/bin/lefthook"))
        );
        // Negative control: no closed pair finds nothing, even with a match outside.
        assert_eq!(
            command_v_match(b"/usr/bin/lefthook\n", MARK, "lefthook", any),
            None
        );
    }

    #[test]
    fn login_path_resolver_skips_lines_that_are_not_the_named_file() {
        let value = framed(
            "lefthook: aliased to npx lefthook\nbin/lefthook\n/usr/bin/lefthooks\n/opt/bin/lefthook\n",
        );
        assert_eq!(
            command_v_match(&value, MARK, "lefthook", |_| true),
            Some(PathBuf::from("/opt/bin/lefthook"))
        );
        // A named path that is not a file is passed over too.
        assert_eq!(command_v_match(&value, MARK, "lefthook", |_| false), None);
        assert_eq!(
            command_v_match(&framed(""), MARK, "lefthook", |_| true),
            None
        );
    }

    #[tokio::test]
    async fn login_path_shared_runner_read_stops_at_the_closing_marker_without_eof() {
        // The writer stays open, as an rc-started background process holds the pipe.
        let (mut tx, mut rx) = tokio::io::duplex(1024);
        let mut sent = b"banner\n".to_vec();
        sent.extend(framed("/usr/bin\n"));
        tx.write_all(&sent).await.unwrap();
        let read = read_until_marker_pair(&mut rx, MARK.as_bytes(), 1024);
        let got = tokio::time::timeout(Duration::from_secs(5), read)
            .await
            .expect("the read returns once the pair closes");
        assert_eq!(got, Some(sent));
        drop(tx);
    }

    #[tokio::test]
    async fn login_path_shared_runner_read_fails_on_eof_or_the_cap() {
        let opened = format!("noise{MARK}/usr/bin\n");
        let mut eof: &[u8] = opened.as_bytes();
        assert_eq!(
            read_until_marker_pair(&mut eof, MARK.as_bytes(), 1024).await,
            None
        );
        // The pair lands past the cap, so the read gives up first.
        let late = [vec![b'x'; 64], framed("/usr/bin\n")].concat();
        let mut capped: &[u8] = &late;
        assert_eq!(
            read_until_marker_pair(&mut capped, MARK.as_bytes(), 32).await,
            None
        );
        // Negative control: the same bytes under a roomy cap succeed.
        let mut roomy: &[u8] = &late;
        assert_eq!(
            read_until_marker_pair(&mut roomy, MARK.as_bytes(), 1024).await,
            Some(late.clone())
        );
    }

    /// `secs` after `t0`, for the retry-window fixtures.
    fn after(t0: Instant, secs: u64) -> Instant {
        t0 + Duration::from_secs(secs)
    }

    #[test]
    fn shell_retry_is_never_due_while_unarmed() {
        let t0 = Instant::now();
        assert!(!retry_due(None, false, after(t0, 3600)));
        let mut stamp = None;
        assert!(!claim_shell_retry(&mut stamp, false, true, after(t0, 3600)));
        assert_eq!(stamp, None, "an unarmed gate stays unarmed");
    }

    #[test]
    fn shell_retry_is_due_from_exactly_the_cooldown() {
        let t0 = Instant::now();
        assert_eq!(SHELL_RETRY_COOLDOWN, Duration::from_secs(60));
        assert!(!retry_due(Some(t0), false, after(t0, 1)));
        assert!(!retry_due(Some(t0), false, after(t0, 59)));
        assert!(retry_due(Some(t0), false, after(t0, 60)));
        assert!(retry_due(Some(t0), false, after(t0, 61)));
    }

    #[test]
    fn shell_retry_never_stacks_on_a_capture_in_flight() {
        let t0 = Instant::now();
        assert!(!retry_due(Some(t0), true, after(t0, 61)));
        let mut stamp = Some(t0);
        assert!(!claim_shell_retry(&mut stamp, true, true, after(t0, 61)));
        assert_eq!(stamp, Some(t0), "a skipped claim keeps the window armed");
    }

    #[test]
    fn shell_retry_claim_restamps_so_a_window_spawns_once() {
        let t0 = Instant::now();
        let mut stamp = Some(t0);
        assert!(claim_shell_retry(&mut stamp, false, true, after(t0, 61)));
        assert_eq!(stamp, Some(after(t0, 61)));
        // A second caller right behind the first finds the window restamped.
        assert!(!claim_shell_retry(&mut stamp, false, true, after(t0, 61)));
        assert!(!claim_shell_retry(&mut stamp, false, true, after(t0, 120)));
        assert!(claim_shell_retry(&mut stamp, false, true, after(t0, 121)));
    }

    #[test]
    fn shell_retry_without_a_runtime_keeps_the_window_for_the_next_caller() {
        let t0 = Instant::now();
        let mut stamp = Some(t0);
        assert!(!claim_shell_retry(&mut stamp, false, false, after(t0, 61)));
        assert_eq!(stamp, Some(t0), "no spawn, so no restamp");
        assert!(claim_shell_retry(&mut stamp, false, true, after(t0, 62)));
    }

    #[tokio::test]
    async fn init_holding_flag_holds_the_flag_until_the_cell_is_settled() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let cell = tokio::sync::OnceCell::new();
        let got = init_holding_flag(&cell, &flag, || async {
            assert_eq!(*flag.borrow(), 1, "held while the init runs");
            Some(7)
        })
        .await;
        assert_eq!(got, Some(&7));
        assert_eq!(*flag.borrow(), 0);
        // A set cell never runs the init again, so the flag stays down.
        let again = init_holding_flag(&cell, &flag, || async { unreachable!() }).await;
        assert_eq!(again, Some(&7));
        assert_eq!(*flag.borrow(), 0);

        let failed = tokio::sync::OnceCell::<u32>::new();
        assert_eq!(
            init_holding_flag(&failed, &flag, || async { None }).await,
            None
        );
        assert_eq!(*flag.borrow(), 0);
        assert!(!failed.initialized());
    }

    #[tokio::test]
    async fn init_holding_flag_clears_when_dropped_and_a_waiter_never_touches_it() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let cell = tokio::sync::OnceCell::<u32>::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let mut owner = Box::pin(init_holding_flag(&cell, &flag, || async {
            let _ = rx.await;
            Some(1)
        }));
        assert!(futures_poll_once(owner.as_mut()).await.is_none());
        assert_eq!(*flag.borrow(), 1);
        // A waiter queued behind the executing init holds no guard of its own.
        let mut waiter = Box::pin(init_holding_flag(&cell, &flag, || async { Some(2) }));
        assert!(futures_poll_once(waiter.as_mut()).await.is_none());
        drop(waiter);
        assert_eq!(
            *flag.borrow(),
            1,
            "a dropped waiter leaves the executing init's count"
        );
        // Dropping the executing init mid-run clears it.
        drop(owner);
        assert_eq!(*flag.borrow(), 0);
        assert!(!cell.initialized());
        drop(tx);
    }

    #[tokio::test]
    async fn init_holding_flag_counts_a_waiter_that_takes_over_after_a_failure() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let cell = tokio::sync::OnceCell::<u32>::new();
        let (fail, fail_rx) = tokio::sync::oneshot::channel::<()>();
        let (finish, finish_rx) = tokio::sync::oneshot::channel::<()>();
        let mut owner = Box::pin(init_holding_flag(&cell, &flag, || async {
            let _ = fail_rx.await;
            None
        }));
        assert!(futures_poll_once(owner.as_mut()).await.is_none());
        let mut waiter = Box::pin(init_holding_flag(&cell, &flag, || async {
            let _ = finish_rx.await;
            Some(2)
        }));
        assert!(futures_poll_once(waiter.as_mut()).await.is_none());
        let _ = fail.send(());
        assert_eq!(futures_poll_once(owner.as_mut()).await, Some(None));
        // The waiter now runs its own init, under its own count.
        assert!(futures_poll_once(waiter.as_mut()).await.is_none());
        assert_eq!(*flag.borrow(), 1);
        let _ = finish.send(());
        assert_eq!(futures_poll_once(waiter.as_mut()).await, Some(Some(&2)));
        assert_eq!(*flag.borrow(), 0);
    }

    #[tokio::test]
    async fn shell_capture_wait_holds_until_every_overlapping_capture_ends() {
        // A failed init's permit frees before its guard drops, so the next init's guard
        // can enter first: the count stays above 0 until both are gone.
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        let failed = InFlightGuard::enter(&flag);
        let next = InFlightGuard::enter(&flag);
        assert_eq!(*flag.borrow(), 2);
        let mut wait = Box::pin(wait_out_capture(
            &mut rx,
            &cancel,
            Duration::from_secs(3600),
        ));
        assert!(futures_poll_once(wait.as_mut()).await.is_none());
        drop(failed);
        assert_eq!(*flag.borrow(), 1);
        assert!(
            futures_poll_once(wait.as_mut()).await.is_none(),
            "one capture still runs"
        );
        drop(next);
        assert_eq!(wait.await, CaptureWait::Finished);
        assert_eq!(*flag.borrow(), 0);
    }

    #[test]
    fn shell_capture_in_flight_release_saturates_at_zero() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        drop(InFlightGuard(&flag));
        assert_eq!(*flag.borrow(), 0);
    }

    #[tokio::test]
    async fn shell_reprime_counts_its_capture_before_the_task_runs() {
        let flag: &'static _ = Box::leak(Box::new(tokio::sync::watch::Sender::new(0usize)));
        let handle = || Some(tokio::runtime::Handle::current());
        let unused = || async {};
        let due = Instant::now();
        let now = due + SHELL_RETRY_COOLDOWN;
        // Unarmed, cooling down, or with no runtime: nothing spawns or counts, and a
        // window the caller couldn't spawn for stays armed.
        assert!(reprime_if_due(&Mutex::new(None), flag, handle(), now, unused).is_none());
        let cooling = Mutex::new(Some(now));
        assert!(reprime_if_due(&cooling, flag, handle(), now, unused).is_none());
        let stamp = Mutex::new(Some(due));
        assert!(reprime_if_due(&stamp, flag, None, now, unused).is_none());
        assert_eq!(*stamp.lock().unwrap(), Some(due));
        assert_eq!(*flag.borrow(), 0);

        let release = std::sync::Arc::new(Notify::new());
        let gate = std::sync::Arc::clone(&release);
        let task = reprime_if_due(&stamp, flag, handle(), now, || async move {
            gate.notified().await;
        })
        .expect("a due window spawns");
        assert_eq!(*stamp.lock().unwrap(), Some(now), "restamped");
        // A current-thread runtime hasn't polled the task yet: only the claim counts it,
        // so the spawn that triggered the re-prime waits for it.
        assert_eq!(*flag.borrow(), 1);
        // A second caller sees it in flight and spawns nothing.
        *stamp.lock().unwrap() = Some(due);
        assert!(reprime_if_due(&stamp, flag, handle(), now, unused).is_none());
        let mut rx = flag.subscribe();
        release.notify_one();
        let cancel = Notify::new();
        assert_eq!(
            wait_out_capture(&mut rx, &cancel, Duration::from_secs(5)).await,
            CaptureWait::Finished
        );
        task.await.unwrap();
        assert_eq!(*flag.borrow(), 0);
    }

    /// Source-order breaches of the re-prime seam. The off-Windows wrapper's body must
    /// be exactly the seam call, and the seam must enter its guard after the claim and
    /// before the stamp lock drops: the wrapper isn't compiled on Windows, and only a
    /// racing reader could see the order, so no runtime test reaches either.
    fn reprime_seam_violations(src: &str) -> Vec<String> {
        let src = src.replace("\r\n", "\n");
        let body = |header: &str| -> Option<String> {
            let start = src.find(header)?;
            let open = start + src[start..].find("{\n")? + 2;
            let close = open + src[open..].find("\n}\n")?;
            let code: String = src[open..close]
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect();
            Some(code.split_whitespace().collect())
        };
        let seam_call = concat!(
            "reprime_if_due(&SHELL_RETRY_STAMP,shell_capture_in_flight(),",
            "tokio::runtime::Handle::try_current().ok(),Instant::now(),prime_shell_path,);",
        );
        let mut bad = Vec::new();
        match body("fn reprime_shell_path_if_due() {") {
            Some(b) if b == seam_call => {}
            Some(b) => bad.push(format!("wrapper body is not the seam call: {b}")),
            None => bad.push("no reprime_shell_path_if_due".into()),
        }
        let Some(seam) = body("fn reprime_if_due<") else {
            bad.push("no reprime_if_due".into());
            return bad;
        };
        let mut at = Vec::new();
        for step in [
            "claim_shell_retry(",
            "InFlightGuard::enter(flag)",
            "drop(stamp)",
            "spawn_counted(",
        ] {
            match seam.matches(step).count() {
                1 => at.push(seam.find(step).unwrap()),
                n => bad.push(format!("{step} appears {n} times")),
            }
        }
        if at.len() == 4 && !at.windows(2).all(|w| w[0] < w[1]) {
            bad.push("seam order is not claim, guard, unlock, spawn".into());
        }
        bad
    }

    #[test]
    fn reprime_seam_source_order_is_pinned() {
        let src = include_str!("agent.rs").replace("\r\n", "\n");
        assert_eq!(reprime_seam_violations(&src), Vec::<String>::new());
        let guard_then_unlock = "    let counted = InFlightGuard::enter(flag);\n    drop(stamp);\n";
        assert!(src.contains(guard_then_unlock));
        let unlock_first = src.replacen(
            guard_then_unlock,
            "    drop(stamp);\n    let counted = InFlightGuard::enter(flag);\n",
            1,
        );
        assert_eq!(
            reprime_seam_violations(&unlock_first),
            ["seam order is not claim, guard, unlock, spawn"]
        );
        let seam_call = "    reprime_if_due(\n        &SHELL_RETRY_STAMP,";
        assert!(src.contains(seam_call));
        let bare_spawn = src.replacen(
            seam_call,
            "    if let Ok(h) = tokio::runtime::Handle::try_current() {\n        h.spawn(prime_shell_path());\n    }\n    let _ = (\n        &SHELL_RETRY_STAMP,",
            1,
        );
        let bad = reprime_seam_violations(&bare_spawn);
        assert_eq!(bad.len(), 1, "{bad:?}");
        assert!(
            bad[0].starts_with("wrapper body is not the seam call"),
            "{bad:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn init_holding_flag_lowers_the_flag_only_after_the_cell_is_set() {
        let flag: &'static _ = Box::leak(Box::new(tokio::sync::watch::Sender::new(0usize)));
        let cell: &'static _ = Box::leak(Box::new(tokio::sync::OnceCell::<u32>::new()));
        let mut rx = flag.subscribe();
        let (go, wait) = tokio::sync::oneshot::channel::<()>();
        let watcher = tokio::spawn(async move {
            // Subscribed before the init starts, so a late watcher still sees the edge.
            while rx.changed().await.is_ok() {
                if *rx.borrow_and_update() == 0 {
                    return cell.initialized();
                }
            }
            false
        });
        let owner = tokio::spawn(init_holding_flag(cell, flag, || async {
            let _ = wait.await;
            Some(3)
        }));
        flag.subscribe().wait_for(|v| *v > 0).await.unwrap();
        let _ = go.send(());
        assert_eq!(owner.await.unwrap(), Some(&3));
        assert!(watcher.await.unwrap(), "a count of 0 must imply a set cell");
    }

    /// Polls `fut` once: `Some` if it finished, `None` if it is still pending.
    async fn futures_poll_once<F: std::future::Future + Unpin>(fut: F) -> Option<F::Output> {
        let mut fut = fut;
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(
                match std::future::Future::poll(std::pin::Pin::new(&mut fut), cx) {
                    std::task::Poll::Ready(v) => Some(v),
                    std::task::Poll::Pending => None,
                },
            )
        })
        .await
    }

    #[tokio::test]
    async fn shell_retry_in_flight_flag_clears_when_the_capture_is_dropped_or_panics() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let capture = async {
            let _in_flight = InFlightGuard::enter(&flag);
            std::future::pending::<()>().await;
        };
        // The capture never finishes; the select drops it once the flag is seen set.
        tokio::select! {
            () = capture => unreachable!("the capture future never completes"),
            seen = async { rx.wait_for(|v| *v > 0).await.is_ok() } => assert!(seen),
        }
        assert_eq!(
            *flag.borrow(),
            0,
            "a dropped capture future clears the flag"
        );

        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _in_flight = InFlightGuard::enter(&flag);
            assert_eq!(*flag.borrow(), 1);
            panic!("the capture panicked");
        }));
        assert!(panicked.is_err());
        assert_eq!(*flag.borrow(), 0, "a panicking capture clears the flag");
    }

    #[test]
    fn shell_capture_wait_is_bounded_at_three_seconds() {
        assert_eq!(SHELL_CAPTURE_WAIT, Duration::from_secs(3));
    }

    #[test]
    fn shell_capture_wait_future_is_send() {
        // Spawned agent futures await it on macOS/Linux, where the call never compiles
        // on a Windows host: no watch `Ref` may live across one of its awaits.
        fn assert_send<T: Send>(_: &T) {}
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        let wait = wait_out_capture(&mut rx, &cancel, SHELL_CAPTURE_WAIT);
        assert_send(&wait);
    }

    #[tokio::test]
    async fn shell_capture_wait_returns_at_once_with_nothing_in_flight() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        cancel.notify_one();
        assert_eq!(
            wait_out_capture(&mut rx, &cancel, Duration::from_secs(3600)).await,
            CaptureWait::NothingInFlight
        );
        // The pending cancel is left for the run's own loop to consume.
        assert!(tokio::time::timeout(Duration::ZERO, cancel.notified())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn shell_capture_wait_ends_when_the_capture_finishes() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        let guard = InFlightGuard::enter(&flag);
        let (waited, ()) = tokio::join!(
            wait_out_capture(&mut rx, &cancel, Duration::from_secs(3600)),
            async move { drop(guard) },
        );
        assert_eq!(waited, CaptureWait::Finished);
    }

    #[tokio::test]
    async fn shell_capture_wait_gives_up_at_its_limit() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        let _in_flight = InFlightGuard::enter(&flag);
        assert_eq!(
            wait_out_capture(&mut rx, &cancel, Duration::from_millis(10)).await,
            CaptureWait::TimedOut
        );
        assert_eq!(*flag.borrow(), 1, "the waiter never touches the count");
    }

    #[tokio::test]
    async fn shell_capture_wait_yields_to_a_cancel() {
        let flag = tokio::sync::watch::Sender::new(0usize);
        let mut rx = flag.subscribe();
        let cancel = Notify::new();
        let _in_flight = InFlightGuard::enter(&flag);
        cancel.notify_one();
        assert_eq!(
            wait_out_capture(&mut rx, &cancel, Duration::from_secs(3600)).await,
            CaptureWait::Cancelled
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether a parser's returned event ends the run: the parsers return
    /// `Done`/`Error` on exactly the lines that are terminal.
    fn ends_turn(ev: &ReviewEvent) -> bool {
        matches!(ev, ReviewEvent::Done { .. } | ReviewEvent::Error { .. })
    }

    #[test]
    fn exit_poll_ramp_doubles_from_its_start_up_to_the_cap() {
        let mut seq = vec![CHILD_EXIT_POLL_START];
        while *seq.last().unwrap() < CHILD_EXIT_POLL {
            seq.push(next_exit_poll(*seq.last().unwrap()));
        }
        let ms: Vec<u128> = seq.iter().map(Duration::as_millis).collect();
        assert_eq!(ms, [2, 4, 8, 16, 32, 64, 100]);
    }

    #[test]
    fn exit_poll_ramp_holds_at_the_cap() {
        let mut poll = CHILD_EXIT_POLL;
        for _ in 0..200 {
            poll = next_exit_poll(poll);
            assert_eq!(poll, CHILD_EXIT_POLL);
        }
    }

    #[cfg(unix)]
    #[test]
    fn exit_poll_si_code_counts_only_a_terminated_child() {
        for code in [libc::CLD_EXITED, libc::CLD_KILLED, libc::CLD_DUMPED] {
            assert!(si_code_is_exit(code), "{code}");
        }
        for code in [libc::CLD_STOPPED, libc::CLD_TRAPPED, libc::CLD_CONTINUED] {
            assert!(!si_code_is_exit(code), "{code}");
        }
    }

    #[test]
    fn every_agent_kind_owns_a_distinct_cache_slot() {
        let kinds = [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Copilot,
            AgentKind::Opencode,
        ];
        let mut slots: Vec<usize> = kinds.iter().map(|k| k.slot()).collect();
        assert!(slots.iter().all(|&i| i < RESOLVE_SLOTS));
        slots.sort_unstable();
        slots.dedup();
        assert_eq!(slots.len(), kinds.len(), "two kinds share a cache slot");
    }

    #[tokio::test]
    async fn resolve_serves_the_cache_but_an_override_bypasses_it() {
        let _memos = crate::agent_sandbox::LOOKUP_MEMO_TEST_LOCK.lock().await;
        // A planted path that no real resolution could produce (it doesn't exist), so
        // getting it back proves the cached value was served without re-resolving.
        let kind = AgentKind::Opencode;
        let planted = std::env::temp_dir().join("gd-planted-opencode-never-resolved");
        {
            let mut cache = resolve_cache().lock().unwrap();
            cache[kind.slot()] = Some((Instant::now(), Some(planted.clone())));
        }
        assert_eq!(resolve(kind, None).await, Some(planted));
        // An override is a bare `is_file()` check that never reads the cache, so a
        // Settings path edit takes effect immediately.
        let override_file =
            std::env::temp_dir().join(format!("gd-override-cli-{}.bin", std::process::id()));
        std::fs::write(&override_file, b"x").unwrap();
        let found = resolve(kind, override_file.to_str()).await;
        let _ = std::fs::remove_file(&override_file);
        {
            let mut cache = resolve_cache().lock().unwrap();
            cache[kind.slot()] = None;
        }
        assert_eq!(found, Some(override_file));
    }

    /// About > Re-check's forget empties every resolve slot, fresh misses and hits alike.
    /// Every read is of the raw slots, so no TTL decides either side of the forget.
    #[test]
    fn forgetting_the_cli_lookups_leaves_every_resolve_slot_cold() {
        let _memos = crate::agent_sandbox::LOOKUP_MEMO_TEST_LOCK.blocking_lock();
        let seeded: Vec<Option<bool>> = {
            let mut cache = resolve_cache().lock().unwrap();
            for (i, slot) in cache.iter_mut().enumerate() {
                let hit = (i % 2 == 1).then(|| PathBuf::from(format!("gd-planted-{i}")));
                *slot = Some((Instant::now(), hit));
            }
            cache
                .iter()
                .map(|s| s.as_ref().map(|(_, v)| v.is_some()))
                .collect()
        };
        let expected: Vec<Option<bool>> = (0..RESOLVE_SLOTS).map(|i| Some(i % 2 == 1)).collect();
        assert_eq!(seeded, expected, "each slot holds its seeded miss or hit");
        forget_cli_lookups();
        let all_empty = resolve_cache().lock().unwrap().iter().all(Option::is_none);
        assert!(all_empty, "a resolve slot stayed cached");
    }

    /// The same forget reaches the container-runtime slots.
    #[test]
    fn forgetting_the_cli_lookups_empties_the_runtime_candidates() {
        use crate::agent_sandbox::{runtime_candidates_empty, seed_runtime_candidate};
        let _memos = crate::agent_sandbox::LOOKUP_MEMO_TEST_LOCK.blocking_lock();
        seed_runtime_candidate(0, None);
        seed_runtime_candidate(1, Some((PathBuf::from("pm"), "podman".to_string())));
        assert!(!runtime_candidates_empty(), "the seeded slots");
        forget_cli_lookups();
        assert!(runtime_candidates_empty(), "a runtime slot stayed cached");
    }

    #[tokio::test]
    async fn capture_capped_round_trips_both_streams_under_cap() {
        let (mut o, mut e): (&[u8], &[u8]) = (b"hello stdout", b"a banner line");
        let (out, err, overflowed) = capture_capped(&mut o, &mut e, 64).await.unwrap();
        assert_eq!(out.as_slice(), b"hello stdout");
        assert_eq!(err.as_slice(), b"a banner line");
        assert!(!overflowed);
    }

    #[tokio::test]
    async fn capture_capped_truncates_and_flags_over_cap() {
        let big = vec![b'x'; 100];
        let (mut o, mut e): (&[u8], &[u8]) = (big.as_slice(), b"");
        let (out, err, overflowed) = capture_capped(&mut o, &mut e, 16).await.unwrap();
        assert_eq!(out.len(), 16);
        assert!(err.is_empty());
        assert!(overflowed);
    }

    #[tokio::test]
    async fn capture_capped_truncates_and_flags_over_cap_on_stderr() {
        // The stderr arm is a twin of the stdout arm — cover its boundary
        // independently so a drift there can't hide behind stdout-only tests.
        let big = vec![b'x'; 100];
        let (mut o, mut e): (&[u8], &[u8]) = (b"", big.as_slice());
        let (out, err, overflowed) = capture_capped(&mut o, &mut e, 16).await.unwrap();
        assert!(out.is_empty());
        assert_eq!(err.len(), 16);
        assert!(overflowed);
    }

    #[tokio::test]
    async fn capture_capped_allows_output_exactly_at_cap() {
        // Output landing exactly on the cap is within the limit, not truncation
        // — on either stream (each arm carries its own boundary comparison, so
        // an over-cap test alone can't tell `>` from `>=`).
        let exact = vec![b'y'; 16];
        let (mut o, mut e): (&[u8], &[u8]) = (exact.as_slice(), b"");
        let (out, err, overflowed) = capture_capped(&mut o, &mut e, 16).await.unwrap();
        assert_eq!(out.len(), 16);
        assert!(!overflowed);
        assert!(err.is_empty());

        let (mut o, mut e): (&[u8], &[u8]) = (b"", exact.as_slice());
        let (out, err, overflowed) = capture_capped(&mut o, &mut e, 16).await.unwrap();
        assert_eq!(err.len(), 16);
        assert!(!overflowed);
        assert!(out.is_empty());
    }

    /// Guards the read buffers staying off the capture futures: every `run_capture_parts`
    /// caller is reachable from a `#[tauri::command]`, whose future is built on the
    /// WebView2 UI-thread stack in release builds, so inline arrays here would ride
    /// that stack. Building the future is enough to measure it; it is never polled.
    /// The composite `run_capture_parts` future is what a command actually holds, so
    /// it carries its own bound.
    #[test]
    fn capture_futures_stay_small() {
        let (mut o, mut e): (&[u8], &[u8]) = (b"", b"");
        let fut = capture_capped(&mut o, &mut e, 16);
        let size = std::mem::size_of_val(&fut);
        assert!(
            size < 1024,
            "capture_capped() future is {size} bytes (debug layout); keep the read buffers heap-allocated so it stays under 1 KiB"
        );

        let fut = run_capture_parts(Path::new("x"), &[], Duration::from_secs(1));
        let size = std::mem::size_of_val(&fut);
        assert!(
            size < 2 * 1024,
            "run_capture_parts() future is {size} bytes (debug layout); keep the capture read buffers heap-allocated so it stays under 2 KiB"
        );
    }

    // Real opencode `run --format json` lines (captured 2026-06-23, v1.17.9).
    const STEP_START: &str = r#"{"type":"step_start","sessionID":"ses_abc","part":{"type":"step-start"}}"#;
    const TEXT_A: &str = r#"{"type":"text","sessionID":"ses_abc","part":{"id":"p1","type":"text","text":"First."}}"#;
    const TOOL: &str = r#"{"type":"tool_use","sessionID":"ses_abc","part":{"type":"tool","tool":"write","state":{"status":"completed"}}}"#;
    const TEXT_B: &str = r#"{"type":"text","sessionID":"ses_abc","part":{"id":"p2","type":"text","text":"Second."}}"#;
    const FINISH_TOOLS: &str = r#"{"type":"step_finish","sessionID":"ses_abc","part":{"type":"step-finish","reason":"tool-calls"}}"#;
    const FINISH_STOP: &str = r#"{"type":"step_finish","sessionID":"ses_abc","part":{"type":"step-finish","reason":"stop"}}"#;

    /// Real `opencode models` stdout (captured 2026-08-23, v1.18.18, uncredentialed;
    /// the free catalog rotates within days). rustc normalizes CRLF to LF inside
    /// string literals, so this const is LF whatever autocrlf checked the file out
    /// as — which is what lets the cases below vary the EOLs from a known baseline.
    const OPENCODE_MODELS_OUTPUT: &str = "opencode/big-pickle
opencode/hy3-free
opencode/mimo-v2.5-free
opencode/muse-spark-1.2-contributor-free
opencode/nemotron-3-ultra-free
opencode/nemotron-3.5-lightning-free
opencode/x-preview-f-free
";

    const OPENCODE_MODEL_IDS: [&str; 7] = [
        "opencode/big-pickle",
        "opencode/hy3-free",
        "opencode/mimo-v2.5-free",
        "opencode/muse-spark-1.2-contributor-free",
        "opencode/nemotron-3-ultra-free",
        "opencode/nemotron-3.5-lightning-free",
        "opencode/x-preview-f-free",
    ];

    #[test]
    fn models_output_parses_to_the_cli_ids_in_order() {
        assert_eq!(
            parse_models_output(OPENCODE_MODELS_OUTPUT),
            OPENCODE_MODEL_IDS
        );
    }

    #[test]
    fn models_output_parses_identically_with_crlf_endings() {
        // Pins the lexer's CRLF normalization: were the fixture to reach runtime
        // with its own CR, this would build `\r\r\n` and the real CRLF case would
        // go untested on a CRLF checkout.
        assert!(!OPENCODE_MODELS_OUTPUT.contains('\r'));
        let crlf = OPENCODE_MODELS_OUTPUT.replace('\n', "\r\n");
        assert_eq!(parse_models_output(&crlf), OPENCODE_MODEL_IDS);
    }

    #[test]
    fn models_output_parses_identically_without_a_trailing_newline() {
        let unterminated = OPENCODE_MODELS_OUTPUT.trim_end_matches('\n');
        assert!(!unterminated.ends_with(['\n', '\r']));
        assert_eq!(parse_models_output(unterminated), OPENCODE_MODEL_IDS);
    }

    #[test]
    fn models_output_drops_noise_and_keeps_its_neighbours() {
        // Each reject carries a `/` except the last, so the warning and JSON lines
        // are rejected by the whitespace gate and the wrapped id by the control gate
        // — one line per branch rather than three that all fail the same check.
        let out = concat!(
            "opencode/keep-one\n",
            "Warning: 2 providers unavailable, showing opencode/free models only\n",
            r#"{"level":"debug","msg":"refreshed opencode/catalog"}"#,
            "\n",
            "\x1b[32mopencode/ansi-wrapped\x1b[0m\n",
            "not-an-id\n",
            "opencode/keep-two\n",
        );
        assert_eq!(
            parse_models_output(out),
            ["opencode/keep-one", "opencode/keep-two"]
        );
    }

    #[test]
    fn models_output_rejects_ids_with_empty_segments() {
        // A URL splits to an empty middle segment. Multi-slash ids whose segments
        // are all non-empty stay accepted — custom providers may nest.
        let out = concat!(
            "/model\n",
            "provider/\n",
            "https://host\n",
            "//\n",
            "a/b-c\n",
            "a/b/c\n",
        );
        assert_eq!(parse_models_output(out), ["a/b-c", "a/b/c"]);
    }

    #[test]
    fn models_output_is_empty_for_empty_input() {
        assert!(parse_models_output("").is_empty());
        assert!(parse_models_output("\n\n  \n").is_empty());
    }

    #[test]
    fn models_output_dedupes_to_the_first_occurrence() {
        assert_eq!(
            parse_models_output("b/two\na/one\nb/two\na/one\n"),
            ["b/two", "a/one"]
        );
    }

    #[test]
    fn models_output_truncates_at_the_cap() {
        let mut input = String::new();
        for i in 0..(MODELS_LIMIT + 500) {
            input.push_str(&format!("p/m{i}\n"));
        }
        let ids = parse_models_output(&input);
        let last = format!("p/m{}", MODELS_LIMIT - 1);
        assert_eq!(ids.len(), MODELS_LIMIT);
        assert_eq!(ids.first().map(String::as_str), Some("p/m0"));
        assert_eq!(ids.last().map(String::as_str), Some(last.as_str()));
    }

    #[test]
    fn models_args_name_each_clis_catalog_command() {
        assert_eq!(AgentKind::Claude.models_args(), None);
        assert_eq!(
            AgentKind::Codex.models_args(),
            Some(&["debug", "models"][..])
        );
        assert_eq!(
            AgentKind::Copilot.models_args(),
            Some(&["help", "config"][..])
        );
        assert_eq!(AgentKind::Opencode.models_args(), Some(&["models"][..]));
    }

    /// `codex debug models` trimmed to the fields the parser reads plus an unread
    /// one, in the CLI's own order (measured 2026-10-05, codex-cli 0.153.3).
    /// `gpt-api-less` is synthetic: listed but unavailable to API-key auth, and
    /// appended out of priority order so the sort is exercised.
    const CODEX_MODELS_OUTPUT: &str = r#"{"models":[
        {"slug":"gpt-6-astra","display_name":"GPT-6 Astra","visibility":"list","priority":2,"supported_in_api":true},
        {"slug":"gpt-reserve","visibility":"hide","priority":4,"supported_in_api":true},
        {"slug":"gpt-5.6-sol","visibility":"list","priority":5,"supported_in_api":true},
        {"slug":"gpt-5.6-terra","visibility":"list","priority":8,"supported_in_api":true},
        {"slug":"gpt-5.6-luna","visibility":"list","priority":9,"supported_in_api":true},
        {"slug":"gpt-5.5","visibility":"list","priority":13,"supported_in_api":true},
        {"slug":"codex-auto-review","visibility":"hide","priority":43,"supported_in_api":true},
        {"slug":"gpt-api-less","visibility":"list","priority":7,"supported_in_api":false}
    ]}"#;

    #[test]
    fn codex_models_under_chatgpt_auth_keep_every_listed_id_by_priority() {
        assert_eq!(
            parse_codex_models(CODEX_MODELS_OUTPUT, true),
            [
                "gpt-6-astra",
                "gpt-5.6-sol",
                "gpt-api-less",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
            ]
        );
    }

    #[test]
    fn codex_models_under_api_key_auth_drop_ids_unsupported_in_the_api() {
        assert_eq!(
            parse_codex_models(CODEX_MODELS_OUTPUT, false),
            [
                "gpt-6-astra",
                "gpt-5.6-sol",
                "gpt-5.6-terra",
                "gpt-5.6-luna",
                "gpt-5.5",
            ]
        );
    }

    #[test]
    fn codex_models_keep_input_order_on_equal_priority() {
        let out = r#"{"models":[
            {"slug":"b","visibility":"list","priority":1,"supported_in_api":true},
            {"slug":"a","visibility":"list","priority":1,"supported_in_api":true},
            {"slug":"first","visibility":"list","priority":0,"supported_in_api":true}
        ]}"#;
        assert_eq!(parse_codex_models(out, false), ["first", "b", "a"]);
    }

    #[test]
    fn codex_models_skip_an_incomplete_entry_without_losing_the_rest() {
        let out = r#"{"models":[
            {"visibility":"list","priority":1,"supported_in_api":true},
            {"slug":"no-priority","visibility":"list","supported_in_api":true},
            {"slug":"bad-priority","visibility":"list","priority":"1","supported_in_api":true},
            "not-an-object",
            {"slug":"kept","visibility":"list","priority":3,"supported_in_api":true}
        ]}"#;
        assert_eq!(parse_codex_models(out, true), ["kept"]);
    }

    #[test]
    fn codex_models_dedupe_to_the_first_by_priority() {
        let out = r#"{"models":[
            {"slug":"twin","visibility":"list","priority":1,"supported_in_api":true},
            {"slug":"other","visibility":"list","priority":2,"supported_in_api":true},
            {"slug":"twin","visibility":"list","priority":3,"supported_in_api":true}
        ]}"#;
        assert_eq!(parse_codex_models(out, true), ["twin", "other"]);
    }

    #[test]
    fn codex_models_drop_slugs_unsafe_as_an_argument() {
        let out = r#"{"models":[
            {"slug":"keep-one","visibility":"list","priority":1,"supported_in_api":true},
            {"slug":"has space","visibility":"list","priority":2,"supported_in_api":true},
            {"slug":"bell\u0007","visibility":"list","priority":3,"supported_in_api":true},
            {"slug":"","visibility":"list","priority":4,"supported_in_api":true},
            {"slug":"keep-two","visibility":"list","priority":5,"supported_in_api":true}
        ]}"#;
        assert_eq!(parse_codex_models(out, true), ["keep-one", "keep-two"]);
    }

    #[test]
    fn codex_models_truncate_at_the_cap() {
        let entries: Vec<String> = (0..(MODELS_LIMIT + 500))
            .map(|i| {
                format!(
                    r#"{{"slug":"m{i}","visibility":"list","priority":{i},"supported_in_api":true}}"#
                )
            })
            .collect();
        let input = format!(r#"{{"models":[{}]}}"#, entries.join(","));
        let ids = parse_codex_models(&input, true);
        let last = format!("m{}", MODELS_LIMIT - 1);
        assert_eq!(ids.len(), MODELS_LIMIT);
        assert_eq!(ids.first().map(String::as_str), Some("m0"));
        assert_eq!(ids.last().map(String::as_str), Some(last.as_str()));
    }

    #[test]
    fn codex_models_are_empty_for_unreadable_output() {
        for out in [
            "",
            "{}",
            "not json",
            r#"{"models":"#,
            r#"{"models":{}}"#,
            "[]",
        ] {
            assert!(parse_codex_models(out, true).is_empty(), "{out:?}");
        }
    }

    /// `copilot help config` around its `model` entry (measured 2026-10-05,
    /// Copilot CLI 1.0.75; the real block lists 23 ids), then a later section in
    /// the same enum shape that must not be read as models.
    const COPILOT_HELP_CONFIG: &str = r#"Configuration Settings:

  `logLevel`: log level for CLI; defaults to "default". Set to "all" for debug logging.

  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-sonnet-5"
    - "claude-haiku-4.5"
    - "gpt-5.6-sol"
    - "gemini-3.1-pro-preview"
    - "kimi-k2.7-code"

  `contextTier`: context window tier for tiered-pricing models (e.g., "default" or "long_context").
    - Can also be set with --context flag (overrides persisted setting)
    - "late-id"
"#;

    const COPILOT_MODEL_IDS: [&str; 6] = [
        "auto",
        "claude-sonnet-5",
        "claude-haiku-4.5",
        "gpt-5.6-sol",
        "gemini-3.1-pro-preview",
        "kimi-k2.7-code",
    ];

    #[test]
    fn copilot_models_read_the_model_block_in_order_with_auto_first() {
        assert_eq!(parse_copilot_models(COPILOT_HELP_CONFIG), COPILOT_MODEL_IDS);
    }

    #[test]
    fn copilot_models_parse_identically_with_crlf_endings() {
        assert!(!COPILOT_HELP_CONFIG.contains('\r'));
        let crlf = COPILOT_HELP_CONFIG.replace('\n', "\r\n");
        assert_eq!(parse_copilot_models(&crlf), COPILOT_MODEL_IDS);
    }

    #[test]
    fn copilot_models_stop_at_the_first_line_outside_the_block() {
        // Prose straight after the ids ends the block just as a blank line does.
        let out = "  `model`: AI model\n    - \"one\"\n  `next`: other\n    - \"late-id\"\n";
        assert_eq!(parse_copilot_models(out), ["auto", "one"]);
    }

    #[test]
    fn copilot_models_are_empty_without_the_marker_or_its_ids() {
        assert!(parse_copilot_models("").is_empty());
        assert!(parse_copilot_models("    - \"orphan\"\n").is_empty());
        // A marker whose block drifted out of the quoted shape is no catalog either.
        assert!(parse_copilot_models("  `model`: AI model\n    - claude-sonnet-5\n").is_empty());
    }

    #[test]
    fn copilot_models_drop_ids_unsafe_as_an_argument() {
        let out = "`model`: AI model\n - \"keep-one\"\n - \"has space\"\n - \"bell\x07\"\n - \"\"\n - \"keep-two\"\n";
        assert_eq!(parse_copilot_models(out), ["auto", "keep-one", "keep-two"]);
    }

    #[test]
    fn copilot_models_truncate_at_the_cap() {
        let mut input = String::from("  `model`: AI model\n");
        for i in 0..(MODELS_LIMIT + 500) {
            input.push_str(&format!("    - \"m{i}\"\n"));
        }
        let ids = parse_copilot_models(&input);
        let last = format!("m{}", MODELS_LIMIT - 2);
        assert_eq!(ids.len(), MODELS_LIMIT);
        assert_eq!(ids.first().map(String::as_str), Some("auto"));
        assert_eq!(ids.last().map(String::as_str), Some(last.as_str()));
    }

    /// `codex login status` wording (codex-cli 0.153.3: the ChatGPT line measured
    /// live, the rest read from the binary's strings; the API-key line ends in a
    /// masked key).
    #[test]
    fn codex_status_is_chatgpt_only_for_a_successful_chatgpt_login() {
        const CHATGPT: &str = "Logged in using ChatGPT";
        const API_KEY: &str = "Logged in using an API key - ****WXYZ";
        const SIGNED_OUT: &str = "Not logged in";
        let status = |code: i32, text: &str| Ok((code, format!("{text}\n")));
        assert!(codex_status_is_chatgpt(status(0, CHATGPT)));
        assert!(!codex_status_is_chatgpt(status(0, API_KEY)));
        assert!(!codex_status_is_chatgpt(status(1, SIGNED_OUT)));
        assert!(!codex_status_is_chatgpt(status(1, CHATGPT)));
        assert!(!codex_status_is_chatgpt(Err(AppError::Timeout(20))));
    }

    #[test]
    fn catalog_listing_timeout_names_the_cli_and_other_errors_pass_through() {
        let timed_out = catalog_listing_error(AgentKind::Copilot, AppError::Timeout(20));
        assert!(matches!(timed_out, AppError::Command(_)));
        assert_eq!(
            timed_out.to_string(),
            "GitHub Copilot model catalog timed out after 20s"
        );
        let other = catalog_listing_error(AgentKind::Codex, AppError::Command("boom".into()));
        assert!(matches!(other, AppError::Command(ref m) if m == "boom"));
    }

    #[test]
    fn copilot_models_dedupe_auto_and_repeats() {
        let out = "`model`: AI model\n - \"auto\"\n - \"one\"\n - \"one\"\n";
        assert_eq!(parse_copilot_models(out), ["auto", "one"]);
    }

    #[test]
    fn cancel_id_gate_accepts_uuids_and_rejects_the_rest() {
        // What the frontend actually mints (`crypto.randomUUID()`).
        assert!(valid_cancel_id("3f2a1c7e-9b4d-4a61-8f0c-2d5e7a91b3c4"));
        // Bounded and charset-limited, so no id can smuggle a path or a huge key.
        assert!(!valid_cancel_id(""));
        assert!(!valid_cancel_id("short"));
        assert!(!valid_cancel_id("../../etc/passwd"));
        assert!(!valid_cancel_id("has spaces in it"));
        assert!(!valid_cancel_id(&"a".repeat(65)));
    }

    #[test]
    fn opencode_step_start_yields_native_session_id() {
        let (mut msg, mut step) = (String::new(), String::new());
        let ev = parse_opencode_line(STEP_START, &mut msg, &mut step).unwrap();
        assert!(!ends_turn(&ev));
        match ev {
            ReviewEvent::NativeSession { id } => assert_eq!(id, "ses_abc"),
            other => panic!("expected NativeSession, got {other:?}"),
        }
    }

    #[test]
    fn opencode_text_parts_stream_as_separated_deltas() {
        let (mut msg, mut step) = (String::new(), String::new());
        // First segment: emitted verbatim, no leading separator.
        let ev = parse_opencode_line(TEXT_A, &mut msg, &mut step).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "First."));
        // Second segment: separated so multi-step narration stays readable, and the
        // delta mirrors exactly what we appended (buffer == last_message).
        let ev = parse_opencode_line(TEXT_B, &mut msg, &mut step).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "\n\nSecond."));
        assert_eq!(msg, "First.\n\nSecond.");
    }

    #[test]
    fn opencode_tool_use_emits_a_tool_step() {
        let (mut msg, mut step) = (String::new(), String::new());
        let ev = parse_opencode_line(TOOL, &mut msg, &mut step).unwrap();
        assert!(!ends_turn(&ev), "a tool call doesn't end the turn");
        match ev {
            ReviewEvent::Tool { tool, target } => {
                assert_eq!(tool, "write");
                assert_eq!(target, None); // this event carries no state.input
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    const OC_TOOL_WITH_INPUT: &str = r#"{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"src/main.rs"}}}}"#;

    #[test]
    fn opencode_tool_use_extracts_target_from_input() {
        let (mut msg, mut step) = (String::new(), String::new());
        let ev = parse_opencode_line(OC_TOOL_WITH_INPUT, &mut msg, &mut step).unwrap();
        match ev {
            ReviewEvent::Tool { tool, target } => {
                assert_eq!(tool, "read");
                assert_eq!(target.as_deref(), Some("src/main.rs"));
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn normalize_tool_maps_known_names_and_falls_back() {
        assert_eq!(normalize_tool("Read"), "read");
        assert_eq!(normalize_tool("MultiEdit"), "edit");
        assert_eq!(normalize_tool("WebFetch"), "web-fetch");
        assert_eq!(normalize_tool("bash"), "run");
        assert_eq!(normalize_tool("SomethingNew"), "other");
    }

    #[test]
    fn tool_target_keeps_paths_full_but_clips_free_text() {
        let v: serde_json::Value =
            serde_json::from_str(r#"{"file_path":"a/b.ts","command":"x"}"#).unwrap();
        assert_eq!(tool_target(&v).as_deref(), Some("a/b.ts"));
        let cmd: serde_json::Value =
            serde_json::from_str(r#"{"command":"pnpm   build\n--flag"}"#).unwrap();
        // Free text is kept VERBATIM (newlines preserved) so the expandable view
        // shows the real command; only the outer edges are trimmed.
        assert_eq!(tool_target(&cmd).as_deref(), Some("pnpm   build\n--flag"));
        // …but it's length-bounded for the payload (long command → clipped + …).
        let long_cmd = serde_json::json!({ "command": "echo ".to_string() + &"x".repeat(2500) });
        let clipped = tool_target(&long_cmd).unwrap();
        assert!(clipped.ends_with('…'));
        assert!(clipped.chars().count() <= 2001);
        let none: serde_json::Value = serde_json::from_str(r#"{"foo":"bar"}"#).unwrap();
        assert_eq!(tool_target(&none), None);

        // A path is load-bearing (relativized + used as a git pathspec for the
        // inline diff), so it is NEVER clipped or whitespace-collapsed — even a long
        // absolute path (Windows worktree paths routinely exceed 200 chars) or one
        // with spaces must survive verbatim.
        let long = format!("/very/long/worktree/path/{}/src/main.rs", "x".repeat(300));
        let lv = serde_json::json!({ "file_path": long });
        assert_eq!(tool_target(&lv).as_deref(), Some(long.as_str()));
        let spaced = serde_json::json!({ "path": "my dir/a b.ts" });
        assert_eq!(tool_target(&spaced).as_deref(), Some("my dir/a b.ts"));
    }

    #[test]
    fn claude_tool_input_accumulates_across_blocks() {
        // The three-line lifecycle of a Claude tool call: start (name), input
        // fragments, stop — only the stop emits a Tool, carrying the joined input.
        let mut acc = std::collections::HashMap::new();
        let (mut emitted, mut pending) = (false, false);
        let mut syn = None;
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read","input":{}}}}"#;
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_pa"}}}"#;
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\":\"src/x.ts\"}"}}}"#;
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#;
        assert!(parse_claude_line(start, &mut acc, &mut emitted, &mut pending, &mut syn).is_none());
        assert!(parse_claude_line(d1, &mut acc, &mut emitted, &mut pending, &mut syn).is_none());
        assert!(parse_claude_line(d2, &mut acc, &mut emitted, &mut pending, &mut syn).is_none());
        let ev = parse_claude_line(stop, &mut acc, &mut emitted, &mut pending, &mut syn).unwrap();
        match ev {
            ReviewEvent::Tool { tool, target } => {
                assert_eq!(tool, "read");
                assert_eq!(target.as_deref(), Some("src/x.ts"));
            }
            other => panic!("expected Tool, got {other:?}"),
        }
        assert!(acc.is_empty(), "the completed block is removed from the buffer");
        // A tool block's stop must NOT arm the separator (no text emitted yet).
        assert!(!pending, "a tool block does not arm the paragraph separator");
    }

    #[test]
    fn claude_lazy_separator_between_text_blocks_across_a_tool() {
        // Two text blocks separated by a tool call: the second block's first delta is
        // prefixed `\n\n`; the first block's first delta is NOT. `Done.text` is the raw
        // `result` string, with no separator prepended — and the delta buffer, once
        // concatenated, ENDS WITH `Done.text` (the frontend's suffix-strip invariant).
        let mut acc = std::collections::HashMap::new();
        let (mut emitted, mut pending) = (false, false);
        let mut syn = None;
        let mut buffer = String::new();

        // Text block 1: "Looking at the code." then its stop.
        let t1a = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking at "}}}"#;
        let t1b = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the code."}}}"#;
        let stop1 = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        // A tool block (start + stop) — its stop must not add a separator.
        let tstart = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read","input":{}}}}"#;
        let tstop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#;
        // Text block 2: the final answer.
        let t2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"The fix is X."}}}"#;
        let stop2 = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":2}}"#;
        let result = r#"{"type":"result","result":"The fix is X.","is_error":false}"#;

        for (line, expect) in [
            (t1a, Some("Looking at ")),
            (t1b, Some("the code.")),
        ] {
            let ev =
                parse_claude_line(line, &mut acc, &mut emitted, &mut pending, &mut syn).unwrap();
            match ev {
                ReviewEvent::Delta { text } => {
                    assert_eq!(text, expect.unwrap());
                    buffer.push_str(&text);
                }
                other => panic!("expected Delta, got {other:?}"),
            }
        }
        // Block-1 stop arms the separator; the tool block's stop leaves it armed.
        parse_claude_line(stop1, &mut acc, &mut emitted, &mut pending, &mut syn);
        assert!(pending, "a text block's stop arms the separator");
        parse_claude_line(tstart, &mut acc, &mut emitted, &mut pending, &mut syn);
        parse_claude_line(tstop, &mut acc, &mut emitted, &mut pending, &mut syn);
        assert!(pending, "a tool block's stop leaves the pending separator intact");

        // Block-2's first delta is prefixed `\n\n`.
        let ev = parse_claude_line(t2, &mut acc, &mut emitted, &mut pending, &mut syn).unwrap();
        match ev {
            ReviewEvent::Delta { text } => {
                assert_eq!(text, "\n\nThe fix is X.");
                buffer.push_str(&text);
            }
            other => panic!("expected Delta, got {other:?}"),
        }
        parse_claude_line(stop2, &mut acc, &mut emitted, &mut pending, &mut syn);

        let done =
            parse_claude_line(result, &mut acc, &mut emitted, &mut pending, &mut syn).unwrap();
        assert!(ends_turn(&done));
        match done {
            ReviewEvent::Done { text, .. } => {
                assert_eq!(text, "The fix is X.", "Done.text is the raw result, no separator");
                // Load-bearing: concatenated deltas END WITH Done.text.
                assert_eq!(buffer, "Looking at the code.\n\nThe fix is X.");
                assert!(buffer.ends_with(&text));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    // Real Claude CLI terminal lines (probed 2026-08-01, v2.1.220, with the app's
    // flags), abridged to the fields the parser reads plus a few real neighbours.
    const CL_SUCCESS: &str = r#"{"is_error":false,"stop_reason":"end_turn","terminal_reason":"completed","subtype":"success","api_error_status":null,"result":"OK","type":"result","total_cost_usd":0.036494}"#;
    const CL_API_ERROR: &str = r#"{"is_error":true,"terminal_reason":"api_error","subtype":"success","api_error_status":404,"result":"There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it.","type":"result","total_cost_usd":0}"#;
    const CL_SYNTHETIC: &str = r#"{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it."}]},"error":"model_not_found","is_api_error_message":true}"#;

    /// Feeds fixture lines through one parser state and returns the terminal `Done`.
    fn claude_done(lines: &[&str]) -> (String, bool) {
        let mut acc = std::collections::HashMap::new();
        let (mut emitted, mut pending) = (false, false);
        let mut syn = None;
        let mut last = None;
        for line in lines {
            last = parse_claude_line(line, &mut acc, &mut emitted, &mut pending, &mut syn);
        }
        match last.expect("the terminal result emits Done") {
            ReviewEvent::Done { text, is_error, .. } => (text, is_error),
            other => panic!("expected Done, got {other:?}"),
        }
    }

    /// Claude 2.1.311's answer to `--resume <unknown id>` (probed 2026-11-22), abridged:
    /// no `result` key, the reason only in `errors`.
    const CL_RESUME_MISS: &str = r#"{"type":"result","subtype":"error_during_execution","duration_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"d81ccead-3501-4eb3-bf30-7ee29543d3b2","total_cost_usd":0,"errors":["No conversation found with session ID: d81ccead-3501-4eb3-bf30-7ee29543d3b2"],"result_index":0}"#;

    #[test]
    fn claude_result_carries_errors_without_a_result() {
        assert_eq!(
            claude_done(&[CL_RESUME_MISS]),
            (
                "No conversation found with session ID: d81ccead-3501-4eb3-bf30-7ee29543d3b2"
                    .to_string(),
                true
            )
        );
        let two = r#"{"type":"result","is_error":true,"errors":["first",7,"second"]}"#;
        assert_eq!(claude_done(&[two]), ("first\nsecond".to_string(), true));
        let with_result =
            r#"{"type":"result","is_error":true,"result":"the reason","errors":["other"]}"#;
        assert_eq!(
            claude_done(&[with_result]),
            ("the reason".to_string(), true)
        );
        let blank_result = r#"{"type":"result","is_error":true,"result":"  ","errors":["other"]}"#;
        assert_eq!(claude_done(&[blank_result]), ("other".to_string(), true));
        let not_error = r#"{"type":"result","is_error":false,"terminal_reason":"completed","errors":["ignored"]}"#;
        assert_eq!(claude_done(&[not_error]), (String::new(), false));
    }

    #[test]
    fn turn_one_omits_a_blank_system_prompt() {
        assert_eq!(turn_one_prompt("", "u"), "u");
        assert_eq!(turn_one_prompt("  ", "u"), "u");
        assert_eq!(turn_one_prompt("sys", "u"), "sys\n\nu");
        for blank in ["", "  "] {
            let args = claude_session_args("", blank, "sid", false, false, false, false, None, &[]);
            assert!(!args.iter().any(|a| a == "--system-prompt"), "{args:?}");
            assert!(
                args.windows(2).any(|w| w == ["--session-id", "sid"]),
                "{args:?}"
            );
        }
        let args = claude_session_args("", "sys", "sid", false, false, false, false, None, &[]);
        assert!(
            args.windows(4)
                .any(|w| w == ["--session-id", "sid", "--system-prompt", "sys"]),
            "{args:?}"
        );
        // A resume never carries the system prompt, blank or not.
        for prompt in ["", "sys"] {
            let args = claude_session_args("", prompt, "sid", true, false, false, false, None, &[]);
            assert!(!args.iter().any(|a| a == "--system-prompt"), "{args:?}");
            assert!(
                args.windows(2).any(|w| w == ["--resume", "sid"]),
                "{args:?}"
            );
        }
    }

    #[test]
    fn host_resume_without_native_id_starts_fresh() {
        for kind in [AgentKind::Codex, AgentKind::Opencode] {
            for container in [false, true] {
                for native in [None, Some(""), Some("  "), Some("id")] {
                    for resume in [false, true] {
                        let want =
                            resume && !container && native.is_none_or(|n| n.trim().is_empty());
                        assert_eq!(
                            resume_starts_fresh(kind, container, resume, native),
                            want,
                            "{kind:?} container={container} native={native:?} resume={resume}"
                        );
                    }
                }
            }
        }
        for kind in [AgentKind::Claude, AgentKind::Copilot] {
            for container in [false, true] {
                for native in [None, Some(""), Some("id")] {
                    assert!(!resume_starts_fresh(kind, container, true, native));
                }
            }
        }
        let args = opencode_session_args("m", "", true, "", false, false, "C:/wt/gd-session-1");
        assert!(
            !args.iter().any(|a| a == "--session" || a == "--continue"),
            "{args:?}"
        );
    }

    #[test]
    fn fresh_start_note_reads_like_the_reset_note() {
        assert_eq!(fresh_start_note(AgentKind::Opencode), NOTICE_RESET_GENERIC);
        assert_eq!(
            fresh_start_note(AgentKind::Codex),
            NOTICE_RESET_GENERIC.replace("opencode", "Codex")
        );
    }

    #[test]
    fn claude_probed_success_line_is_not_an_error() {
        let (text, is_error) = claude_done(&[CL_SUCCESS]);
        assert_eq!(text, "OK");
        assert!(!is_error);
    }

    #[test]
    fn claude_probed_api_error_line_is_an_error() {
        let (text, is_error) = claude_done(&[CL_API_ERROR]);
        assert!(is_error);
        assert!(text.starts_with("There's an issue with the selected model"));
    }

    #[test]
    fn auth_status_wire_strings_match_the_ts_union() {
        // Pins the TS mirror `AuthStatus` in src/lib/ai/agent.ts, value for value.
        let wire = |s: AuthStatus| serde_json::to_value(s).expect("AuthStatus serializes");
        assert_eq!(wire(AuthStatus::Authed), "authed");
        assert_eq!(wire(AuthStatus::NotAuthed), "notAuthed");
        assert_eq!(wire(AuthStatus::Unreachable), "unreachable");
        assert_eq!(wire(AuthStatus::Unknown), "unknown");
    }

    #[test]
    fn exit_code_auth_keeps_its_local_verdicts() {
        assert_eq!(exit_code_auth(Ok((0, String::new()))), AuthStatus::Authed);
        assert_eq!(
            exit_code_auth(Ok((1, String::new()))),
            AuthStatus::NotAuthed
        );
        // A local probe never claims an outage.
        assert_eq!(
            exit_code_auth(Err(AppError::Timeout(20))),
            AuthStatus::Unknown
        );
    }

    #[test]
    fn review_event_wire_shape_is_camel_case() {
        // Pins the IPC contract with the TS mirror (src/lib/ai/agent.ts): the fields
        // the frontend reads by name must be exactly these, in camelCase.
        let done = serde_json::to_value(ReviewEvent::Done {
            text: "body".to_string(),
            is_error: true,
            cost_usd: Some(0.5),
        })
        .expect("Done serializes");
        let obj = done.as_object().expect("Done is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["costUsd", "isError", "kind", "text"]);
        assert_eq!(obj["kind"], "done");
        assert_eq!(obj["isError"], true);
        assert_eq!(obj["costUsd"], 0.5);
        assert!(obj.get("is_error").is_none(), "snake_case field must not ship");
        assert!(obj.get("cost_usd").is_none(), "snake_case field must not ship");

        // Variant tags are camelCase too (single-word ones are casing-identical).
        let err = serde_json::to_value(ReviewEvent::Error {
            message: "boom".to_string(),
            partial_text: Some("half a review".to_string()),
            timed_out: true,
        })
        .expect("Error serializes");
        assert_eq!(err["kind"], "error");
        let err_obj = err.as_object().expect("Error is a JSON object");
        let mut err_keys: Vec<&str> = err_obj.keys().map(String::as_str).collect();
        err_keys.sort_unstable();
        assert_eq!(err_keys, ["kind", "message", "partialText", "timedOut"]);
        assert_eq!(err_obj["partialText"], "half a review");
        assert_eq!(err_obj["timedOut"], true);
        assert!(
            err_obj.get("partial_text").is_none(),
            "snake_case field must not ship"
        );
        assert!(
            err_obj.get("timed_out").is_none(),
            "snake_case field must not ship"
        );
        // A failure with nothing kept still ships both keys — the TS mirror types them
        // as always-present (`string | null` / `boolean`), like `Done.costUsd`.
        let bare = serde_json::to_value(ReviewEvent::error("boom")).expect("Error serializes");
        assert_eq!(bare["partialText"], serde_json::Value::Null);
        assert_eq!(bare["timedOut"], false);
        let native = serde_json::to_value(ReviewEvent::NativeSession {
            id: "ses_1".to_string(),
        })
        .expect("NativeSession serializes");
        assert_eq!(native["kind"], "nativeSession");
        assert_eq!(native["id"], "ses_1");
        let notice = serde_json::to_value(ReviewEvent::Notice {
            code: NOTICE_SESSION_RESET,
            text: "note".to_string(),
        })
        .expect("Notice serializes");
        let notice_obj = notice.as_object().expect("Notice is a JSON object");
        let mut notice_keys: Vec<&str> = notice_obj.keys().map(String::as_str).collect();
        notice_keys.sort_unstable();
        assert_eq!(notice_keys, ["code", "kind", "text"]);
        assert_eq!(notice_obj["kind"], "notice");
        assert_eq!(notice_obj["code"], "nativeSessionReset");
        assert_eq!(notice_obj["text"], "note");
    }

    #[test]
    fn agent_info_wire_shape_carries_unsupported() {
        let info = |unsupported: Option<String>| {
            serde_json::to_value(AgentInfo {
                found: true,
                path: Some("/bin/opencode".to_string()),
                version: Some("opencode v3.0.0".to_string()),
                authed: AuthStatus::Unknown,
                unsupported,
            })
            .expect("AgentInfo serializes")
        };
        let absent = info(None);
        let obj = absent.as_object().expect("AgentInfo is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["authed", "found", "path", "unsupported", "version"]);
        assert_eq!(obj["unsupported"], serde_json::Value::Null);
        assert_eq!(info(Some("refused".to_string()))["unsupported"], "refused");
    }

    /// Both maps over every verdict row: a run is refused with the version text, a detect
    /// reports only a verdict about the version.
    #[test]
    fn opencode_verdict_maps_split_runs_from_detection() {
        let supported = |text: &str| crate::opencode2::classify_version(text).expect(text);
        let refused = |text: &str| match crate::opencode2::classify_version(text) {
            Err(refusal) => refusal,
            Ok(cli) => panic!("{text} classified as {cli:?}"),
        };
        let v1 = supported("1.19.6");
        let v2 = supported("opencode v2.3.2");
        assert!(matches!(v1, crate::opencode2::Cli::V1(_)));
        assert!(matches!(v2, crate::opencode2::Cli::V2(_)));
        for cli in [v1, v2] {
            let verdict = OpencodeVerdict::Supported(cli);
            assert_eq!(opencode_verdict_cli(verdict.clone()).expect("runs"), cli);
            assert_eq!(opencode_verdict_unsupported(&verdict), None);
        }
        assert!(matches!(
            refused("banana"),
            crate::opencode2::VersionRefusal::Unparseable { .. }
        ));
        assert!(matches!(
            refused("opencode v2.1.9"),
            crate::opencode2::VersionRefusal::TooOld { .. }
        ));
        assert!(matches!(
            refused("opencode v3.0.0"),
            crate::opencode2::VersionRefusal::TooNew { .. }
        ));
        assert!(matches!(
            refused("opencode v0.0.0-beta-12"),
            crate::opencode2::VersionRefusal::Preview { .. }
        ));
        for text in [
            "banana",
            "opencode v2.1.9",
            "opencode v3.0.0",
            "opencode v0.0.0-beta-12",
        ] {
            let refusal = refused(text);
            let verdict = OpencodeVerdict::Refused(refusal.clone());
            match opencode_verdict_cli(verdict.clone()) {
                Err(AppError::Command(message)) => {
                    assert_eq!(message, refusal.message());
                    assert!(message.contains(text), "{message}");
                }
                other => panic!("{text}: {other:?}"),
            }
            assert_eq!(
                opencode_verdict_unsupported(&verdict),
                Some(refusal.standing_message())
            );
        }
        // A run is told to try again; a standing detect state is not.
        let old = OpencodeVerdict::Refused(refused("opencode v2.1.9"));
        let Err(AppError::Command(run)) = opencode_verdict_cli(old.clone()) else {
            panic!("refused");
        };
        assert!(run.ends_with(", then try again."), "{run}");
        let standing = opencode_verdict_unsupported(&old).expect("unsupported");
        assert!(!standing.contains("try again"), "{standing}");
        assert!(
            standing.ends_with("(run \"opencode upgrade\")."),
            "{standing}"
        );
        let failed = OpencodeVerdict::ProbeFailed("timed out after 20s".to_string());
        match opencode_verdict_cli(failed.clone()) {
            Err(AppError::Command(message)) => assert_eq!(
                message,
                "GitDesktop could not check which opencode this is (\"opencode --version\" timed out after 20s). Try again, or pick another binary in Settings."
            ),
            other => panic!("probe failure: {other:?}"),
        }
        assert_eq!(opencode_verdict_unsupported(&failed), None);
    }

    /// The effort control's map: a version refusal is a standing line under the control,
    /// while a probe that could not run keeps the run paths' sentence.
    #[test]
    fn opencode_verdict_effort_reports_a_standing_refusal() {
        for text in [
            "opencode v2.1.9",
            "opencode v3.0.0",
            "opencode v0.0.0-beta-12",
            "banana",
        ] {
            let Err(refusal) = crate::opencode2::classify_version(text) else {
                panic!("{text} was not refused");
            };
            match opencode_verdict_effort(OpencodeVerdict::Refused(refusal.clone())) {
                Err(AppError::Command(line)) => {
                    assert_eq!(line, refusal.standing_message(), "{text}");
                    assert!(!line.ends_with(", then try again."), "{line}");
                }
                other => panic!("{text}: {other:?}"),
            }
        }
        let failed = OpencodeVerdict::ProbeFailed("timed out after 20s".to_string());
        match (
            opencode_verdict_effort(failed.clone()),
            opencode_verdict_cli(failed),
        ) {
            (Err(AppError::Command(effort)), Err(AppError::Command(run))) => {
                assert_eq!(effort, run)
            }
            other => panic!("probe failure: {other:?}"),
        }
        let v2 = crate::opencode2::classify_version("opencode v2.3.2").expect("2.x");
        let supported = opencode_verdict_effort(OpencodeVerdict::Supported(v2));
        assert_eq!(supported.expect("supported"), v2);
    }

    /// One `opencode_verdict_with` call at `now` over a counting probe that answers
    /// `answer`.
    async fn verdict_probing(
        bin: &Path,
        facts: &Mutex<OpencodeFacts>,
        now: Instant,
        probes: &std::sync::atomic::AtomicUsize,
        answer: VersionProbe,
    ) -> OpencodeVerdict {
        opencode_verdict_with(bin, facts, now, || {
            probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { answer }
        })
        .await
        .0
    }

    /// A supported verdict is remembered per binary identity for `OPENCODE_VERDICT_TTL`
    /// and asked again once it lapses; a refusal, a failed probe and an unreadable
    /// identity are asked again on every call.
    #[tokio::test]
    async fn opencode_verdict_is_remembered_per_binary_identity() {
        let printed = |text: &str| VersionProbe::Printed(text.to_string());
        let dir = tempfile::tempdir().expect("temp dir");
        let bin = dir.path().join("opencode");
        let facts = Mutex::new(OpencodeFacts::default());
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let count = || probes.load(std::sync::atomic::Ordering::SeqCst);
        let start = Instant::now();
        let lapsed = start + OPENCODE_VERDICT_TTL;

        std::fs::write(&bin, b"1").unwrap();
        let v1 = verdict_probing(&bin, &facts, start, &probes, printed("1.19.6")).await;
        assert!(matches!(
            v1,
            OpencodeVerdict::Supported(crate::opencode2::Cli::V1(_))
        ));
        assert_eq!(count(), 1);
        // Within the TTL the second ask never reaches the probe.
        let within = lapsed - Duration::from_millis(1);
        let again = verdict_probing(&bin, &facts, within, &probes, printed("banana")).await;
        assert_eq!((again, count()), (v1, 1));
        // Once it lapses the binary is asked again, and the new answer is remembered.
        let v2 = verdict_probing(&bin, &facts, lapsed, &probes, printed("opencode v2.3.2")).await;
        assert!(matches!(
            v2,
            OpencodeVerdict::Supported(crate::opencode2::Cli::V2(_))
        ));
        let again = verdict_probing(&bin, &facts, lapsed, &probes, printed("1.19.6")).await;
        assert_eq!((again, count()), (v2, 2));

        // Rewritten with another length: another binary, probed afresh.
        std::fs::write(&bin, b"22").unwrap();
        let other = verdict_probing(&bin, &facts, start, &probes, printed("1.19.6")).await;
        assert!(matches!(other, OpencodeVerdict::Supported(_)));
        assert_eq!(count(), 3);

        // No refusal is remembered: the user told to upgrade is asked again next call.
        std::fs::write(&bin, b"333").unwrap();
        for text in [
            "opencode v2.1.9",
            "opencode v3.0.0",
            "opencode v0.0.0-beta-12",
            "banana",
        ] {
            for _ in 0..2 {
                let before = count();
                let verdict = verdict_probing(&bin, &facts, start, &probes, printed(text)).await;
                assert!(matches!(verdict, OpencodeVerdict::Refused(_)), "{text}");
                assert_eq!(count(), before + 1, "{text}");
            }
        }
        assert_eq!(count(), 11);
        for _ in 0..2 {
            let failed = VersionProbe::Failed("exited with code 1".to_string());
            let verdict = verdict_probing(&bin, &facts, start, &probes, failed).await;
            assert_eq!(
                verdict,
                OpencodeVerdict::ProbeFailed("exited with code 1".to_string())
            );
        }
        assert_eq!(count(), 13);

        // No metadata, no identity: probed on every call, never remembered.
        let missing = dir.path().join("absent");
        for _ in 0..2 {
            let (verdict, identity, _) =
                opencode_verdict_with(&missing, &facts, start, || async { printed("1.19.6") })
                    .await;
            assert!(identity.is_none());
            assert!(matches!(verdict, OpencodeVerdict::Supported(_)));
        }
        let remembered = facts.lock().unwrap().cli.len();
        assert_eq!(remembered, 2, "the two supported binaries");

        facts.lock().unwrap().clear();
        assert!(facts.lock().unwrap().cli.is_empty());
    }

    /// A DiffOnly proof lives only as long as the answer it was made on: a re-probe
    /// answering the same version keeps it; another version, a refusal or a failed probe
    /// drops it.
    #[tokio::test]
    async fn opencode_verdict_change_drops_the_diff_only_proof() {
        let printed = |text: &str| VersionProbe::Printed(text.to_string());
        let dir = tempfile::tempdir().expect("temp dir");
        let bin = dir.path().join("opencode");
        std::fs::write(&bin, b"1").unwrap();
        let id = binary_identity(&bin).expect("an identity");
        let facts = Mutex::new(OpencodeFacts::default());
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let Ok(crate::opencode2::Cli::V2(version)) =
            crate::opencode2::classify_version("opencode v2.3.2")
        else {
            panic!("2.x");
        };
        let proven = || facts.lock().unwrap().diff_only_proven.contains_key(&id);
        let prove = || {
            facts
                .lock()
                .unwrap()
                .diff_only_proven
                .insert(id.clone(), version)
        };

        let mut now = Instant::now();
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.3.2")).await;
        prove();
        now += OPENCODE_VERDICT_TTL;
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.3.2")).await;
        assert!(proven(), "the same version keeps the proof");
        for answer in [
            printed("opencode v2.4.0"),
            printed("opencode v2.1.9"),
            VersionProbe::Failed("exited with code 1".to_string()),
        ] {
            prove();
            now += OPENCODE_VERDICT_TTL;
            let verdict = verdict_probing(&bin, &facts, now, &probes, answer).await;
            assert!(!proven(), "{verdict:?} kept the proof");
        }
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 5);
    }

    /// A catalog is a fact about one version too: a probe answering another version of
    /// its binary forgets it, the same version keeps it, and another binary's survives.
    #[tokio::test]
    async fn opencode_verdict_change_drops_its_binarys_catalog() {
        let printed = |text: &str| VersionProbe::Printed(text.to_string());
        let dir = tempfile::tempdir().expect("temp dir");
        let bin = dir.path().join("opencode");
        let other_bin = dir.path().join("opencode-other");
        std::fs::write(&bin, b"1").unwrap();
        std::fs::write(&other_bin, b"22").unwrap();
        let id = binary_identity(&bin).expect("an identity");
        let other = binary_identity(&other_bin).expect("an identity");
        let facts = Mutex::new(OpencodeFacts::default());
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let remember = |of: &BinaryIdentity| {
            facts.lock().unwrap().catalog =
                Some((of.clone(), v2_version(), Instant::now(), Arc::default()));
        };
        let remembered = || {
            let store = facts.lock().unwrap();
            store.catalog.as_ref().map(|(known, ..)| known.clone())
        };

        let mut now = Instant::now();
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.3.2")).await;
        remember(&id);
        now += OPENCODE_VERDICT_TTL;
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.3.2")).await;
        assert_eq!(remembered(), Some(id.clone()), "the same version keeps it");
        now += OPENCODE_VERDICT_TTL;
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.4.0")).await;
        assert_eq!(remembered(), None, "another version forgets it");
        remember(&other);
        now += OPENCODE_VERDICT_TTL;
        verdict_probing(&bin, &facts, now, &probes, printed("opencode v2.3.2")).await;
        assert_eq!(remembered(), Some(other), "another binary's survives");
        assert_eq!(probes.load(std::sync::atomic::Ordering::SeqCst), 4);
    }

    /// One detect row over a counting probe that answers `answer`.
    async fn detection_probing(
        bin: &Path,
        facts: &Mutex<OpencodeFacts>,
        now: Instant,
        probes: &std::sync::atomic::AtomicUsize,
        answer: VersionProbe,
    ) -> OpencodeDetection {
        opencode_detection_with(bin, facts, now, || {
            probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { answer }
        })
        .await
    }

    /// A detect row's version and refusal are the verdict's own observation: a remembered
    /// verdict brings the text it was read from, a refusal shows its text and sentence, and
    /// a failed probe shows neither.
    #[tokio::test]
    async fn opencode_detection_reads_one_observation() {
        let printed = |text: &str| VersionProbe::Printed(text.to_string());
        let dir = tempfile::tempdir().expect("temp dir");
        let bin = dir.path().join("opencode");
        let facts = Mutex::new(OpencodeFacts::default());
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let count = || probes.load(std::sync::atomic::Ordering::SeqCst);
        let start = Instant::now();

        std::fs::write(&bin, b"1").unwrap();
        let answer = printed("opencode v2.3.2\n");
        let found = detection_probing(&bin, &facts, start, &probes, answer).await;
        assert_eq!(found.printed.as_deref(), Some("opencode v2.3.2"));
        assert_eq!((found.unsupported, count()), (None, 1));
        // Within the TTL the remembered verdict answers, with the text it was read from.
        let found = detection_probing(&bin, &facts, start, &probes, printed("banana")).await;
        assert_eq!(found.printed.as_deref(), Some("opencode v2.3.2"));
        assert_eq!((found.unsupported, count()), (None, 1));

        // Rewritten: a refused version shows what it printed and the standing sentence.
        std::fs::write(&bin, b"22").unwrap();
        let Err(refusal) = crate::opencode2::classify_version("opencode v3.0.0") else {
            panic!("3.x is refused");
        };
        let answer = printed("opencode v3.0.0");
        let found = detection_probing(&bin, &facts, start, &probes, answer).await;
        assert_eq!(found.printed.as_deref(), Some("opencode v3.0.0"));
        assert_eq!(found.unsupported, Some(refusal.standing_message()));
        assert_eq!(count(), 2);

        let failed = VersionProbe::Failed("exited with code 1".to_string());
        let found = detection_probing(&bin, &facts, start, &probes, failed).await;
        assert_eq!((found.printed, found.unsupported, count()), (None, None, 3));
    }

    /// A proof names the version it was made on: a run on another version of the same
    /// binary reads it as unproven, whatever the verdict cache holds.
    #[test]
    fn diff_only_proof_holds_only_for_its_version() {
        let version = |text: &str| match crate::opencode2::classify_version(text) {
            Ok(crate::opencode2::Cli::V2(version)) => version,
            other => panic!("{other:?}"),
        };
        let (old, new) = (version("opencode v2.3.2"), version("opencode v2.4.0"));
        let id = BinaryIdentity {
            path: PathBuf::from("opencode"),
            len: 1,
            modified: None,
        };
        let other = BinaryIdentity {
            len: 2,
            ..id.clone()
        };
        let mut facts = OpencodeFacts::default();
        assert!(!diff_only_proven(&facts, Some(&id), old));
        facts.diff_only_proven.insert(id.clone(), old);
        assert!(diff_only_proven(&facts, Some(&id), old));
        assert!(!diff_only_proven(&facts, Some(&id), new));
        assert!(!diff_only_proven(&facts, Some(&other), old));
        assert!(!diff_only_proven(&facts, None, old));
    }

    #[test]
    fn opencode1_restarts_only_a_resumed_opencode2_token() {
        for (resume, raw, restart) in [
            (true, Some("oc2:w:ses_abc"), true),
            (true, Some("  oc2:p:ses_abc "), true),
            (true, Some("oc2:"), true),
            (true, Some("ses_abc"), false),
            (true, Some("   "), false),
            (true, None, false),
            (false, Some("oc2:w:ses_abc"), false),
            (false, None, false),
        ] {
            assert_eq!(
                opencode1_must_restart(resume, raw),
                restart,
                "{resume} {raw:?}"
            );
        }
    }

    // --- opencode 2 lock and reviews ------------------------------------------------

    #[test]
    fn opencode_facts_clear_forgets_every_member() {
        let mut facts = OpencodeFacts::default();
        let id = BinaryIdentity {
            path: PathBuf::from("opencode"),
            len: 1,
            modified: None,
        };
        let cli = crate::opencode2::classify_version("opencode v2.3.2").expect("2.x");
        let text = "opencode v2.3.2".to_string();
        facts.cli.insert(id.clone(), (cli, Instant::now(), text));
        let crate::opencode2::Cli::V2(version) = cli else {
            panic!("2.x");
        };
        facts.diff_only_proven.insert(id.clone(), version);
        facts.catalog = Some((id, version, Instant::now(), Arc::default()));
        facts.clear();
        assert!(facts.cli.is_empty());
        assert!(facts.diff_only_proven.is_empty());
        assert!(facts.catalog.is_none());
    }

    /// opencode's own trailing denies, which a read-back lists after the lock's rules.
    const TRAILING_DENIES: &[(&str, &str, &str)] =
        &[("browser", "*", "deny"), ("skill", "browser", "deny")];

    /// A `debug agents` answer listing the one agent `document` defines: its rules, then
    /// `extra`.
    fn readback_listing(document: &str, extra: &[(&str, &str, &str)]) -> String {
        let doc: serde_json::Value = serde_json::from_str(document).expect("a lock document");
        let (id, agent) = doc["agents"]
            .as_object()
            .and_then(|agents| agents.iter().next())
            .expect("one agent");
        let mut permissions = agent["permissions"].as_array().expect("its rules").clone();
        for (action, resource, effect) in extra {
            permissions.push(serde_json::json!({
                "action": action, "resource": resource, "effect": effect
            }));
        }
        serde_json::json!([{ "id": id, "permissions": permissions }]).to_string()
    }

    fn v2_version() -> crate::opencode2::Version {
        match crate::opencode2::classify_version("opencode v2.3.2") {
            Ok(crate::opencode2::Cli::V2(version)) => version,
            other => panic!("not a 2.x verdict: {other:?}"),
        }
    }

    type Answer = fn(&crate::opencode2::LockDocument) -> ProbeAnswer;

    fn answer_listed(doc: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::Stdout(readback_listing(doc.json(), TRAILING_DENIES))
    }

    fn answer_absent(_: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::Stdout("[]".to_string())
    }

    fn answer_exit(_: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::Exit {
            code: 1,
            stderr_line: None,
        }
    }

    fn answer_timed_out(_: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::TimedOut { secs: 30 }
    }

    fn answer_failed(_: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::Failed("no such file".to_string())
    }

    fn answer_cancelled(_: &crate::opencode2::LockDocument) -> ProbeAnswer {
        ProbeAnswer::Cancelled
    }

    /// `opencode2_lock` over scripted answers, one per probe: its result and the probe
    /// documents it was handed.
    async fn lock_with(
        pin: crate::opencode2::Pin,
        inherited: Option<&str>,
        proven: bool,
        answers: &[Answer],
    ) -> (
        Result<LockOutcome, LockRefusal>,
        Vec<crate::opencode2::LockDocument>,
    ) {
        let probed = std::cell::RefCell::new(Vec::new());
        let result = opencode2_lock(
            pin,
            &["gitdesktop"],
            inherited,
            crate::opencode2::MatchCase::Sensitive,
            proven,
            |doc| {
                let answer = answers[probed.borrow().len()](&doc);
                probed.borrow_mut().push(doc);
                async move { answer }
            },
        )
        .await;
        (result, probed.into_inner())
    }

    /// `Some(read_back)` for a lock, `None` for anything else.
    fn locked(result: &Result<LockOutcome, LockRefusal>) -> Option<bool> {
        match result {
            Ok(LockOutcome::Locked { read_back, .. }) => Some(*read_back),
            _ => None,
        }
    }

    #[tokio::test]
    async fn opencode2_lock_retries_a_returned_miss_once() {
        let read_only = crate::opencode2::Pin::ReadOnly;
        let diff_only = crate::opencode2::Pin::DiffOnly;
        // A miss that came back is retried once, under a freshly minted probe.
        for first in [answer_exit as Answer, answer_absent] {
            let (result, probed) = lock_with(read_only, None, false, &[first, answer_listed]).await;
            assert_eq!(locked(&result), Some(true));
            assert_eq!(probed.len(), 2);
            assert_ne!(probed[0].agent(), probed[1].agent(), "one id per probe");
        }
        // Two misses refuse with the second.
        let (result, probed) = lock_with(diff_only, None, false, &[answer_exit, answer_exit]).await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::ProbeExit {
                code: 1,
                stderr_line: None
            }
        );
        assert_eq!(probed.len(), 2);
        let (result, _) = lock_with(read_only, None, false, &[answer_exit, answer_absent]).await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::Readback(crate::opencode2::ReadbackError::AgentAbsent)
        );
        // A timeout or a failed spawn refuses at once.
        let (result, probed) = lock_with(read_only, None, false, &[answer_timed_out]).await;
        assert_eq!(result.unwrap_err(), LockRefusal::ProbeTimedOut { secs: 30 });
        assert_eq!(probed.len(), 1);
        let (result, probed) = lock_with(read_only, None, false, &[answer_failed]).await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::ProbeFailed("no such file".to_string())
        );
        assert_eq!(probed.len(), 1);
        // A cancel on either attempt ends the turn.
        let cancels: [&[Answer]; 2] = [&[answer_cancelled], &[answer_exit, answer_cancelled]];
        for answers in cancels {
            let (result, probed) = lock_with(read_only, None, false, answers).await;
            assert!(matches!(result, Ok(LockOutcome::Cancelled)));
            assert_eq!(probed.len(), answers.len());
        }
        // Only a proven DiffOnly skips the read-back.
        let (result, probed) = lock_with(diff_only, None, true, &[]).await;
        assert_eq!(locked(&result), Some(false));
        assert!(probed.is_empty());
        for pin in [read_only, crate::opencode2::Pin::Research] {
            let (result, probed) = lock_with(pin, None, true, &[answer_listed]).await;
            assert_eq!(locked(&result), Some(true), "{pin:?}");
            assert_eq!(probed.len(), 1, "{pin:?}");
        }
        // An inherited document refuses ReadOnly and Research before any probe.
        for pin in [read_only, crate::opencode2::Pin::Research] {
            let (result, probed) = lock_with(pin, Some("{}"), false, &[]).await;
            assert_eq!(
                result.unwrap_err(),
                LockRefusal::Lock(crate::opencode2::LockError::InheritedContent),
                "{pin:?}"
            );
            assert!(probed.is_empty(), "{pin:?}");
        }
        let (result, probed) = lock_with(diff_only, Some("{}"), false, &[answer_listed]).await;
        assert_eq!(locked(&result), Some(true));
        assert_eq!(probed.len(), 1);
        let (result, _) = lock_with(read_only, Some(""), false, &[answer_listed]).await;
        assert_eq!(locked(&result), Some(true), "an empty value is no document");
    }

    fn env_value<'p>(plan: &'p SpawnPlan, key: &str) -> Option<&'p str> {
        plan.env
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_str())
    }

    /// A plan's env with the lock document's value masked, so a probe and its run compare.
    fn masked_env(plan: &SpawnPlan) -> Vec<(&'static str, String)> {
        plan.env
            .iter()
            .map(|(name, value)| {
                let shown = if *name == crate::opencode2::CONTENT_ENV {
                    "<document>".to_string()
                } else {
                    value.clone()
                };
                (*name, shown)
            })
            .collect()
    }

    /// `opencode2_compose` over a fake read-back that gets the attempt number and the
    /// document in the probe plan's env, sending no variant: the result and every plan
    /// the probe was handed.
    async fn compose_with(
        inputs: &Opencode2Inputs<'_>,
        answer: impl Fn(usize, &str) -> ProbeAnswer,
    ) -> (Result<TurnPlan, LockRefusal>, Vec<SpawnPlan>) {
        compose_picking(inputs, VariantPick::Send(None), answer).await
    }

    /// `compose_with` under a variant runner that answers `pick`.
    async fn compose_picking(
        inputs: &Opencode2Inputs<'_>,
        pick: VariantPick,
        answer: impl Fn(usize, &str) -> ProbeAnswer,
    ) -> (Result<TurnPlan, LockRefusal>, Vec<SpawnPlan>) {
        let plans = std::cell::RefCell::new(Vec::new());
        let result = opencode2_compose(
            inputs,
            || async move { pick },
            |plan: SpawnPlan| {
                let document = env_value(&plan, crate::opencode2::CONTENT_ENV).unwrap_or_default();
                let reply = answer(plans.borrow().len(), document);
                plans.borrow_mut().push(plan);
                async move { reply }
            },
        )
        .await;
        (result, plans.into_inner())
    }

    /// A review's inputs, its turn built as `opencode2_review` builds it.
    fn review_inputs<'a>(
        repo_aware: bool,
        servers: &'a [&'a str],
        config_path: Option<&'a str>,
    ) -> Opencode2Inputs<'a> {
        Opencode2Inputs {
            turn: Opencode2Turn::Review {
                version: v2_version(),
                pin: opencode2_review_pin(repo_aware),
            },
            servers,
            config_path,
            cwd: "/repo",
            model: "openai/gpt-5",
            inherited_content: None,
            case: crate::opencode2::MatchCase::Sensitive,
            diff_only_proven: false,
        }
    }

    /// A session turn's inputs, its turn built as `opencode2_host_session` builds it.
    fn session_inputs<'a>(
        read_only: bool,
        web: bool,
        servers: &'a [&'a str],
        config_path: Option<&'a str>,
        session_id: Option<&'a str>,
    ) -> Opencode2Inputs<'a> {
        Opencode2Inputs {
            turn: Opencode2Turn::Session {
                pin: opencode2_session_pin(read_only, web),
                session_id,
            },
            servers,
            config_path,
            cwd: "/worktree",
            model: "openai/gpt-5",
            inherited_content: None,
            case: crate::opencode2::MatchCase::Sensitive,
            diff_only_proven: false,
        }
    }

    #[test]
    fn opencode2_model_reads_load_no_project_config() {
        let binary = Path::new("opencode");
        for args in [
            crate::opencode2::MODELS_ARGS,
            crate::opencode2::CATALOG_ARGS,
        ] {
            let request = opencode2_read_request(binary, args, None);
            assert_eq!(request.args, args);
            assert_eq!(request.cwd, None);
            assert_eq!(request.env, crate::opencode2::project_disable_env());
            assert!(request.stdin.is_none());
            assert_eq!(request.timeout, MODELS_TIMEOUT);
        }
    }

    #[test]
    fn opencode2_review_pin_is_diff_only_unless_repo_aware() {
        assert_eq!(opencode2_review_pin(false), crate::opencode2::Pin::DiffOnly);
        assert_eq!(opencode2_review_pin(true), crate::opencode2::Pin::ReadOnly);
    }

    /// The user's rules a `plan` agent lists, worth mirroring: a deny, an `ask` the lock
    /// reads as a deny, and a web rule only Research keeps.
    const PLAN_RULES: &[(&str, &str, &str)] = &[
        ("read", "*.env", "deny"),
        ("read", "*.key", "ask"),
        ("webfetch", "*.internal/*", "ask"),
    ];

    /// `readback_listing` with a `plan` agent listing `PLAN_RULES` after the probe's.
    fn readback_listing_with_plan(document: &str) -> String {
        let listed = readback_listing(document, TRAILING_DENIES);
        let mut agents: Vec<serde_json::Value> = serde_json::from_str(&listed).expect("a listing");
        let rules: Vec<serde_json::Value> = PLAN_RULES
            .iter()
            .map(|(action, resource, effect)| {
                serde_json::json!({ "action": action, "resource": resource, "effect": effect })
            })
            .collect();
        agents.push(serde_json::json!({ "id": "plan", "permissions": rules }));
        serde_json::Value::Array(agents).to_string()
    }

    /// The lock a composed turn carries, read back under `readback_listing_with_plan`,
    /// with its rules as `action resource effect` lines.
    async fn composed_lock(
        inputs: &Opencode2Inputs<'_>,
    ) -> (crate::opencode2::LockDocument, Vec<String>) {
        let listed = |_: usize, doc: &str| ProbeAnswer::Stdout(readback_listing_with_plan(doc));
        let lock = match compose_with(inputs, listed).await.0 {
            Ok(TurnPlan::Run {
                lock: Some(lock), ..
            }) => lock,
            other => panic!("no lock: {other:?}"),
        };
        let lines = lock
            .rules()
            .iter()
            .map(|rule| format!("{} {} {:?}", rule.action, rule.resource, rule.effect))
            .collect();
        (lock, lines)
    }

    /// Each turn's lock is the one its own pin names, with the user's mirrored rules in
    /// place: ReadOnly reads without the web, Research adds it, DiffOnly reads nothing.
    #[tokio::test]
    async fn opencode2_compose_locks_each_turn_by_its_own_pin() {
        let read_only = [
            ("repo-aware review", review_inputs(true, &[], None)),
            ("Plan turn", session_inputs(true, false, &[], None, None)),
        ];
        for (row, inputs) in read_only {
            let (lock, lines) = composed_lock(&inputs).await;
            for web in ["webfetch * Allow", "websearch * Allow"] {
                assert!(!lines.iter().any(|line| line == web), "{row}: {lines:?}");
            }
            assert!(!lock.json().contains("websearch"), "{row}");
            let read_all = lines.iter().position(|line| line == "read * Allow");
            let read_all = read_all.unwrap_or_else(|| panic!("{row}: {lines:?}"));
            for mirrored in ["read *.env Deny", "read *.key Deny"] {
                let at = lines.iter().position(|line| line == mirrored);
                assert!(at > Some(read_all), "{row}: {mirrored} in {lines:?}");
            }
        }
        let (research, lines) = composed_lock(&session_inputs(true, true, &[], None, None)).await;
        for rule in [
            "webfetch * Allow",
            "websearch * Allow",
            "webfetch *.internal/* Deny",
            "read *.env Deny",
        ] {
            assert!(
                lines.iter().any(|line| line == rule),
                "Research: {rule} in {lines:?}"
            );
        }
        assert!(
            research
                .json()
                .ends_with(r#","websearch":{"provider":"exa"}}"#),
            "{}",
            research.json()
        );
        let (_, lines) = composed_lock(&review_inputs(false, &[], None)).await;
        assert_eq!(lines, ["* * Deny", "read * Deny", "read ?* Deny"]);
    }

    #[test]
    fn opencode2_session_pin_locks_every_read_only_turn() {
        for (read_only, web, pin) in [
            (false, false, None),
            (false, true, None),
            (true, false, Some(crate::opencode2::Pin::ReadOnly)),
            (true, true, Some(crate::opencode2::Pin::Research)),
        ] {
            assert_eq!(
                opencode2_session_pin(read_only, web),
                pin,
                "{read_only} {web}"
            );
        }
    }

    #[tokio::test]
    async fn opencode2_pinned_turns_always_carry_the_lock() {
        let content = crate::opencode2::CONTENT_ENV;
        let listed =
            |_: usize, doc: &str| ProbeAnswer::Stdout(readback_listing(doc, TRAILING_DENIES));
        let rows: [(&[&str], Option<&str>); 2] = [
            (&[], None),
            (&["gitdesktop"], Some("/data/mcp/review.opencode.json")),
        ];
        for repo_aware in [false, true] {
            for (servers, config_path) in rows {
                let row = format!("repo_aware {repo_aware}, servers {servers:?}");
                let inputs = review_inputs(repo_aware, servers, config_path);
                let (result, plans) = compose_with(&inputs, listed).await;
                let (run, lock) = match result {
                    Ok(TurnPlan::Run {
                        run,
                        lock: Some(lock),
                        read_back: true,
                    }) => (run, lock),
                    other => panic!("{row}: {other:?}"),
                };
                let [probe] = &plans[..] else {
                    panic!("{row}: {} plans", plans.len());
                };
                let agent = lock.agent().as_str();
                let at = run.args.iter().position(|arg| arg == "--agent");
                assert_eq!(at.map(|at| run.args[at + 1].as_str()), Some(agent), "{row}");
                assert!(!run.args.iter().any(|arg| arg == "--auto"), "{row}");
                assert_eq!(env_value(&run, content), Some(lock.json()), "{row}");
                let first = &lock.rules()[0];
                assert_eq!(
                    (first.action.as_str(), first.resource.as_str(), first.effect),
                    ("*", "*", crate::opencode2::Effect::Deny),
                    "{row}"
                );
                assert_eq!(env_value(&run, "OPENCODE_CONFIG"), config_path, "{row}");
                // The read-back runs where and as the run does, under another id.
                assert_eq!(probe.args, crate::opencode2::READBACK_ARGS, "{row}");
                assert_eq!(probe.cwd, run.cwd, "{row}");
                assert_eq!(masked_env(probe), masked_env(&run), "{row}");
                let probe_document = env_value(probe, content).expect("the probe's document");
                assert!(!probe_document.contains(agent), "{row}");
            }
        }
        // Session turns: Plan and Research are pinned, a write turn is not.
        let flags = [(true, false), (true, true), (false, false), (false, true)];
        for (read_only, web) in flags {
            for (servers, config_path) in rows {
                for session_id in [None, Some("ses_abc")] {
                    let row = format!(
                        "session ({read_only}, {web}), servers {servers:?}, {session_id:?}"
                    );
                    let inputs = session_inputs(read_only, web, servers, config_path, session_id);
                    let (result, plans) = compose_with(&inputs, listed).await;
                    let (run, lock, read_back) = match result {
                        Ok(TurnPlan::Run {
                            run,
                            lock,
                            read_back,
                        }) => (run, lock, read_back),
                        other => panic!("{row}: {other:?}"),
                    };
                    let at = run.args.iter().position(|arg| arg == "--session");
                    let resumed = at.map(|at| run.args[at + 1].as_str());
                    assert_eq!(resumed, session_id, "{row}");
                    assert_eq!(env_value(&run, "OPENCODE_CONFIG"), config_path, "{row}");
                    // A session keeps the repository's own opencode config.
                    assert_eq!(
                        env_value(&run, "OPENCODE_DISABLE_PROJECT_CONFIG"),
                        None,
                        "{row}"
                    );
                    if !read_only {
                        assert!(plans.is_empty(), "{row}: a write turn reads nothing back");
                        assert!(lock.is_none() && !read_back, "{row}");
                        assert!(run.args.iter().any(|arg| arg == "--auto"), "{row}");
                        assert!(!run.args.iter().any(|arg| arg == "--agent"), "{row}");
                        assert_eq!(env_value(&run, content), None, "{row}");
                        continue;
                    }
                    let lock = lock.unwrap_or_else(|| panic!("{row}: no lock"));
                    assert!(read_back, "{row}");
                    let [probe] = &plans[..] else {
                        panic!("{row}: {} plans", plans.len());
                    };
                    let agent = lock.agent().as_str();
                    let at = run.args.iter().position(|arg| arg == "--agent");
                    assert_eq!(at.map(|at| run.args[at + 1].as_str()), Some(agent), "{row}");
                    assert!(!run.args.iter().any(|arg| arg == "--auto"), "{row}");
                    assert_eq!(env_value(&run, content), Some(lock.json()), "{row}");
                    let first = &lock.rules()[0];
                    assert_eq!(
                        (first.action.as_str(), first.resource.as_str(), first.effect),
                        ("*", "*", crate::opencode2::Effect::Deny),
                        "{row}"
                    );
                    assert_eq!(probe.args, crate::opencode2::READBACK_ARGS, "{row}");
                    assert_eq!(probe.cwd, run.cwd, "{row}");
                    assert_eq!(masked_env(probe), masked_env(&run), "{row}");
                    let probe_document = env_value(probe, content).expect("the probe's document");
                    assert!(!probe_document.contains(agent), "{row}");
                }
            }
        }
        // A pinned session refuses a miss the way a review does.
        let inputs = session_inputs(true, true, &["gitdesktop"], None, Some("ses_abc"));
        let (result, plans) =
            compose_with(&inputs, |_, _| ProbeAnswer::Stdout("[]".to_string())).await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::Readback(crate::opencode2::ReadbackError::AgentAbsent)
        );
        assert_eq!(plans.len(), 2);
        // Controls, on a repo-aware review with a server.
        let inputs = review_inputs(
            true,
            &["gitdesktop"],
            Some("/data/mcp/review.opencode.json"),
        );
        let (result, plans) =
            compose_with(&inputs, |_, _| ProbeAnswer::Stdout("[]".to_string())).await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::Readback(crate::opencode2::ReadbackError::AgentAbsent)
        );
        assert_eq!(plans.len(), 2);
        let (result, plans) = compose_with(&inputs, |_, doc| {
            ProbeAnswer::Stdout(readback_listing(doc, &[("shell", "*", "allow")]))
        })
        .await;
        assert_eq!(
            result.unwrap_err(),
            LockRefusal::Readback(crate::opencode2::ReadbackError::NotLast)
        );
        assert_eq!(plans.len(), 2);
        let (result, plans) = compose_with(&inputs, |attempt, doc| {
            if attempt == 0 {
                ProbeAnswer::Exit {
                    code: 1,
                    stderr_line: None,
                }
            } else {
                listed(attempt, doc)
            }
        })
        .await;
        assert!(matches!(
            result,
            Ok(TurnPlan::Run {
                lock: Some(_),
                read_back: true,
                ..
            })
        ));
        let [first, second] = &plans[..] else {
            panic!("{} plans", plans.len());
        };
        assert_ne!(env_value(first, content), env_value(second, content));
        assert_eq!(first.cwd, second.cwd);
        assert_eq!(masked_env(first), masked_env(second));
    }

    #[test]
    fn opencode2_probe_answer_reads_a_capture() {
        let exited = |code: i32, stdout: &str, stderr: &str| {
            Ok::<_, AppError>(Captured::Exited {
                code,
                stdout: stdout.as_bytes().to_vec(),
                stderr: stderr.to_string(),
            })
        };
        let bound = OPENCODE2_PROBE_TIMEOUT;
        assert!(matches!(
            opencode2_probe_answer(exited(0, "[]", "a warning"), bound),
            ProbeAnswer::Stdout(stdout) if stdout == "[]"
        ));
        assert!(matches!(
            opencode2_probe_answer(exited(1, "", "\n  Agent not found: gd1 \nmore"), bound),
            ProbeAnswer::Exit { code: 1, stderr_line: Some(line) } if line == "Agent not found: gd1"
        ));
        assert!(matches!(
            opencode2_probe_answer(exited(2, "[]", " \n"), bound),
            ProbeAnswer::Exit {
                code: 2,
                stderr_line: None
            }
        ));
        assert!(matches!(
            opencode2_probe_answer(Ok(Captured::TimedOut), bound),
            ProbeAnswer::TimedOut { secs: 30 }
        ));
        assert!(matches!(
            opencode2_probe_answer(Ok(Captured::Cancelled), bound),
            ProbeAnswer::Cancelled
        ));
        assert!(matches!(
            opencode2_probe_answer(Err(AppError::Command("gone".into())), bound),
            ProbeAnswer::Failed(text) if text.contains("gone")
        ));
    }

    #[test]
    fn lock_refusal_sentences_start_with_the_core_lead() {
        let lead = crate::opencode2::READBACK_REFUSAL_LEAD;
        let tail = "Check your opencode config with \"opencode debug config\", or update opencode, then try again.";
        let long = LockRefusal::ProbeExit {
            code: 1,
            stderr_line: Some("y".repeat(300)),
        };
        assert_eq!(
            long.message(),
            format!(
                "{lead} opencode's check command failed (exit code 1: {}). {tail}",
                "y".repeat(200)
            )
        );
        let bare = LockRefusal::ProbeExit {
            code: 3,
            stderr_line: None,
        };
        assert_eq!(
            bare.message(),
            format!("{lead} opencode's check command failed (exit code 3). {tail}")
        );
        assert!(LockRefusal::ProbeTimedOut { secs: 30 }
            .message()
            .starts_with(&format!(
                "{lead} opencode did not answer the check within 30 seconds."
            )));
        assert_eq!(
            LockRefusal::ProbeFailed("denied".to_string()).message(),
            format!("{lead} opencode's check command could not be started (denied).")
        );
        let inherited = crate::opencode2::LockError::InheritedContent;
        assert_eq!(
            LockRefusal::Lock(inherited.clone()).message(),
            inherited.message()
        );
        let absent = crate::opencode2::ReadbackError::AgentAbsent;
        assert_eq!(
            LockRefusal::Readback(absent.clone()).message(),
            absent.message()
        );
    }

    #[test]
    fn opencode2_exit_code_is_none_whenever_forced() {
        for (forced, status, code) in [
            (false, Some(0), Some(0)),
            (false, Some(1), Some(1)),
            (false, None, None),
            (true, Some(0), None),
            (true, Some(1), None),
            (true, None, None),
        ] {
            assert_eq!(
                opencode2_exit_code(forced, status),
                code,
                "{forced} {status:?}"
            );
        }
    }

    /// A 2.x stream fed `lines` through the stream wiring, as a run's loop feeds it.
    fn opencode2_streamed(lines: &[serde_json::Value]) -> Opencode2Stream {
        let mut stream = Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(None),
            native: None,
        };
        for line in lines {
            opencode2_stream_event(&mut stream, &line.to_string());
        }
        stream
    }

    fn opencode2_retry(message: &str) -> serde_json::Value {
        serde_json::json!({"type": "retry", "attempt": 2, "error": {"message": message}})
    }

    fn opencode2_text(text: &str) -> serde_json::Value {
        serde_json::json!({"type": "text", "part": {"id": "prt_t1", "messageID": "msg_t1",
            "text": text}})
    }

    #[test]
    fn opencode2_timeout_names_a_recorded_retry_only() {
        let base = || "The review timed out.".to_string();
        let parser = |lines: &[serde_json::Value]| opencode2_streamed(lines).parser;
        assert_eq!(opencode2_timeout_message(base(), None), base());
        assert_eq!(
            opencode2_timeout_message(base(), Some(&parser(&[]))),
            base()
        );
        assert_eq!(
            opencode2_timeout_message(base(), Some(&parser(&[opencode2_retry("Rate limited")]))),
            "The review timed out. opencode was still retrying: Rate limited"
        );
        assert_eq!(
            opencode2_timeout_message(base(), Some(&parser(&[opencode2_retry(&"x".repeat(300))]))),
            format!(
                "The review timed out. opencode was still retrying: {}",
                "x".repeat(200)
            )
        );
        // A retry opencode recovered from is not named.
        assert_eq!(
            opencode2_timeout_message(
                base(),
                Some(&parser(&[
                    opencode2_retry("Rate limited"),
                    opencode2_text("Back.")
                ]))
            ),
            base()
        );
    }

    #[test]
    fn opencode2_timeout_reports_a_recorded_error_first() {
        let base = || "The review timed out.".to_string();
        let error = serde_json::json!({"type": "error", "error": {"message": "Model not found"}});
        let stream = opencode2_streamed(&[opencode2_retry("Rate limited"), error]);
        assert_eq!(
            opencode2_timeout_message(base(), Some(&stream.parser)),
            "Model not found"
        );
        // The lock-dropped mapping applies at the deadline too.
        let lock =
            crate::opencode2::lock_document(crate::opencode2::Access::DiffOnly, &[]).expect("lock");
        let mut stream = Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(Some(&lock)),
            native: None,
        };
        let dropped = serde_json::json!({"type": "error", "error": {"message":
            format!("Agent not found: \"{}\"", lock.agent().as_str())}});
        opencode2_stream_event(&mut stream, &dropped.to_string());
        let message = opencode2_timeout_message(base(), Some(&stream.parser));
        assert!(
            message.starts_with("opencode did not load GitDesktop's read-only lock"),
            "{message}"
        );
    }

    #[test]
    fn opencode2_failed_exit_quotes_stderr_only_without_an_error_line() {
        let text = || opencode2_text("Partial.");
        let stderr = "\n  \nfatal: socket closed\nsecond line\n";
        let event =
            opencode2_conclusion(opencode2_streamed(&[text()]).parser, false, Some(1), stderr);
        assert!(
            matches!(&event, Some(ReviewEvent::Error { message, .. })
                if message == "opencode exited with code 1 before it finished. opencode printed: fatal: socket closed"),
            "{event:?}"
        );
        let long = format!("{}\n", "y".repeat(300));
        let event = opencode2_conclusion(opencode2_streamed(&[text()]).parser, false, None, &long);
        assert!(
            matches!(&event, Some(ReviewEvent::Error { message, .. })
                if *message == format!("opencode stopped before it finished. opencode printed: {}", "y".repeat(200))),
            "{event:?}"
        );
        let error = serde_json::json!({"type": "error", "error": {"message": "boom"}});
        let event = opencode2_conclusion(
            opencode2_streamed(&[text(), error]).parser,
            false,
            Some(1),
            stderr,
        );
        assert!(
            matches!(&event, Some(ReviewEvent::Error { message, .. }) if message == "boom"),
            "{event:?}"
        );
        // No stderr: the exit sentence alone.
        let event =
            opencode2_conclusion(opencode2_streamed(&[text()]).parser, false, Some(1), " \n");
        assert!(
            matches!(&event, Some(ReviewEvent::Error { message, .. })
                if message == "opencode exited with code 1 before it finished."),
            "{event:?}"
        );
    }

    #[test]
    fn opencode2_lost_output_fails_even_on_exit_zero() {
        let lines = [opencode2_text("Half an answer")];
        let event = opencode2_conclusion(opencode2_streamed(&lines).parser, true, Some(0), "");
        assert!(
            matches!(&event, Some(ReviewEvent::Error { message, timed_out: false, .. })
                if message == OPENCODE2_OUTPUT_LOST),
            "{event:?}"
        );
        assert_eq!(
            OPENCODE2_OUTPUT_LOST,
            "GitDesktop lost opencode's output before the run finished."
        );
        // The same stream read to its end succeeds.
        let event = opencode2_conclusion(opencode2_streamed(&lines).parser, false, Some(0), "");
        assert!(
            matches!(&event, Some(ReviewEvent::Done { text, .. }) if text == "Half an answer"),
            "{event:?}"
        );
    }

    #[test]
    fn opencode2_stream_lines_never_end_the_run() {
        let session = "ses_2f7a1c";
        let lines = [
            serde_json::json!({"type": "step_start", "timestamp": 1, "sessionID": session,
                "part": {"id": "prt_a1", "sessionID": session, "messageID": "msg_a1",
                "type": "step-start"}}),
            serde_json::json!({"type": "text", "timestamp": 2, "sessionID": session,
                "part": {"id": "prt_a2", "sessionID": session, "messageID": "msg_a1",
                "type": "text", "text": "Looks fine.", "time": {"start": 1, "end": 2}}}),
            serde_json::json!({"type": "step_finish", "timestamp": 3, "sessionID": session,
                "part": {"id": "prt_a3", "sessionID": session, "messageID": "msg_a1",
                "type": "step-finish", "reason": "stop"}}),
            serde_json::json!({"type": "error", "timestamp": 4, "sessionID": session,
                "error": {"type": "unknown", "message": "boom"}}),
        ];
        let sink = collector();
        let mut terminal = None;
        let mut stream = Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(None),
            native: None,
        };
        for line in &lines {
            let [notice, native, event] = opencode2_stream_event(&mut stream, &line.to_string());
            assert!(notice.is_none(), "{line}");
            for ev in [native, event].into_iter().flatten() {
                send_noting_terminal(&sink, &mut terminal, ev);
            }
        }
        assert!(terminal.is_none(), "no stream line is terminal");
        let events = sink.events.into_inner().unwrap();
        assert!(
            matches!(events.first(), Some(ReviewEvent::NativeSession { id }) if id == session),
            "{events:?}"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, ReviewEvent::Delta { text } if text == "Looks fine.")),
            "{events:?}"
        );
        // The error line after a `stop` is the run's outcome, read at the end.
        assert!(matches!(
            stream.parser.finish(Some(1), None),
            Some(ReviewEvent::Error { message, .. }) if message == "boom"
        ));
    }

    // --- opencode 2 models and effort --------------------------------------------

    /// The measured catalog shape (`oc-bin/probe8.txt`): no variants, `low high max`,
    /// the full set, and `none high`; the last row, a user-declared model whose one
    /// variant no level names, is not from the probe.
    const CATALOG: &str = r#"{"location": "/tmp/x", "data": [
        {"id": "big-pickle", "providerID": "opencode", "variants": []},
        {"id": "deepseek-v4.1-flash-free", "providerID": "opencode", "variants": [
            {"id": "low", "settings": {"reasoningEffort": "low"}},
            {"id": "high", "settings": {"reasoningEffort": "high"}},
            {"id": "max", "settings": {"reasoningEffort": "max"}}]},
        {"id": "tidepool-alpha-free", "providerID": "opencode", "variants": [
            {"id": "minimal"}, {"id": "low"}, {"id": "medium"}, {"id": "high"},
            {"id": "xhigh"}, {"id": "max"}]},
        {"id": "hy4-flash-free", "providerID": "opencode", "variants": [
            {"id": "none"}, {"id": "high"}]},
        {"id": "custom-deep", "providerID": "opencode", "variants": [{"id": "deep"}]}
    ]}"#;

    fn catalog() -> crate::opencode2::ModelCatalog {
        crate::opencode2::parse_model_catalog(CATALOG).expect("fixture catalog")
    }

    fn effort_reasons(support: &EffortSupport) -> Vec<Option<&str>> {
        support
            .levels
            .iter()
            .map(|level| level.reason.as_deref())
            .collect()
    }

    #[test]
    fn effort_support_offers_only_declared_variants() {
        let catalog = catalog();
        let variants = |support: &EffortSupport| -> Vec<Option<String>> {
            support
                .levels
                .iter()
                .map(|level| level.variant.clone())
                .collect()
        };
        let some = |name: &str| Some(name.to_string());
        let nothing: Vec<Option<String>> = vec![None; 4];

        let none = effort_support("opencode/big-pickle", Some(&catalog));
        assert!(none.per_model);
        assert_eq!(variants(&none), nothing);
        let sentence = "opencode/big-pickle has no effort settings in opencode.";
        assert_eq!(none.reason.as_deref(), Some(sentence));
        assert_eq!(effort_reasons(&none), [Some(sentence); 4]);

        let three = effort_support(" opencode/deepseek-v4.1-flash-free ", Some(&catalog));
        assert!(three.per_model);
        let levels: Vec<&str> = three.levels.iter().map(|l| l.level.as_str()).collect();
        assert_eq!(levels, ["low", "medium", "high", "xhigh"]);
        assert_eq!(
            variants(&three),
            [some("low"), None, some("high"), some("max")]
        );
        assert_eq!(three.reason, None);
        assert_eq!(
            effort_reasons(&three),
            [
                None,
                Some("Not offered by opencode/deepseek-v4.1-flash-free in opencode."),
                None,
                None
            ]
        );

        let full = effort_support("opencode/tidepool-alpha-free", Some(&catalog));
        assert_eq!(
            variants(&full),
            [some("low"), some("medium"), some("high"), some("xhigh")]
        );
        // `none` switches reasoning off, so no level picks it.
        let off = effort_support("opencode/hy4-flash-free", Some(&catalog));
        assert_eq!(variants(&off), [None, None, some("high"), some("high")]);

        // Every variant offered is one the model declares.
        for model in [
            "opencode/big-pickle",
            "opencode/deepseek-v4.1-flash-free",
            "opencode/tidepool-alpha-free",
            "opencode/hy4-flash-free",
        ] {
            let declared = catalog.variants(model);
            for level in effort_support(model, Some(&catalog)).levels {
                if let Some(variant) = level.variant {
                    assert!(declared.contains(&variant), "{model} {variant}");
                }
            }
        }

        // When nothing is selectable, the whole control and each level say why.
        for (model, catalog, reason) in [
            ("", Some(&catalog), EFFORT_NO_MODEL.to_string()),
            ("  ", Some(&catalog), EFFORT_NO_MODEL.to_string()),
            (
                "a/b#c",
                Some(&catalog),
                EFFORT_MODEL_HAS_VARIANT.to_string(),
            ),
            (
                "opencode/deepseek-v4.1-flash-free",
                None,
                EFFORT_CATALOG_UNREADABLE.to_string(),
            ),
            (
                "openai/unlisted",
                Some(&catalog),
                "openai/unlisted has no effort settings in opencode.".to_string(),
            ),
            (
                "opencode/custom-deep",
                Some(&catalog),
                "opencode/custom-deep names its effort settings differently in opencode. Add one to the model id as #name to use it.".to_string(),
            ),
        ] {
            let support = effort_support(model, catalog);
            assert!(support.per_model, "{model:?}");
            assert_eq!(variants(&support), nothing, "{model:?}");
            assert_eq!(
                support.reason.as_deref(),
                Some(reason.as_str()),
                "{model:?}"
            );
            assert_eq!(
                effort_reasons(&support),
                [Some(reason.as_str()); 4],
                "{model:?}"
            );
        }
        let container = effort_withheld(EFFORT_CONTAINER_NEEDS_HOST.to_string());
        assert_eq!(variants(&container), nothing);
        assert_eq!(
            container.reason.as_deref(),
            Some(EFFORT_CONTAINER_NEEDS_HOST)
        );
    }

    #[test]
    fn effort_support_wire_shape_is_camel_case() {
        let value = serde_json::to_value(effort_support(
            "opencode/deepseek-v4.1-flash-free",
            Some(&catalog()),
        ))
        .expect("EffortSupport serializes");
        let obj = value.as_object().expect("EffortSupport is a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["levels", "perModel", "reason"]);
        assert!(
            obj.get("per_model").is_none(),
            "snake_case field must not ship"
        );
        assert_eq!(obj["perModel"], true);
        assert_eq!(obj["reason"], serde_json::Value::Null);
        let medium = obj["levels"][1]
            .as_object()
            .expect("a level is a JSON object");
        let mut level_keys: Vec<&str> = medium.keys().map(String::as_str).collect();
        level_keys.sort_unstable();
        assert_eq!(level_keys, ["level", "reason", "variant"]);
        assert_eq!(medium["level"], "medium");
        assert_eq!(medium["variant"], serde_json::Value::Null);
        assert_eq!(obj["levels"][0]["variant"], "low");
        assert_eq!(obj["levels"][0]["reason"], serde_json::Value::Null);

        let fixed = serde_json::to_value(effort_not_per_model()).expect("serializes");
        assert_eq!(
            fixed,
            serde_json::json!({"perModel": false, "levels": [], "reason": null})
        );
    }

    #[tokio::test]
    async fn agent_effort_levels_is_per_model_for_opencode_only() {
        for kind in [AgentKind::Claude, AgentKind::Codex, AgentKind::Copilot] {
            for isolation in [None, Some("container".to_string())] {
                let support = agent_effort_levels(kind, None, "a/b".to_string(), isolation).await;
                assert_eq!(support.unwrap(), effort_not_per_model(), "{kind:?}");
            }
        }
    }

    #[test]
    fn opencode2_effort_applies_only_to_a_level_on_a_plain_model() {
        for (model, effort, applies) in [
            ("openai/gpt-5", "high", true),
            ("  openai/gpt-5 ", "low", true),
            ("openai/gpt-5", "", false),
            ("", "high", false),
            ("   ", "high", false),
            ("openai/gpt-5#max", "high", false),
        ] {
            assert_eq!(
                opencode2_effort_applies(model, effort),
                applies,
                "{model:?} {effort:?}"
            );
        }
    }

    #[tokio::test]
    async fn opencode2_variant_without_a_source_sends_none() {
        let pick = opencode2_variant(None, "opencode/deepseek-v4.1-flash-free", "high", None).await;
        assert_eq!(pick, VariantPick::Send(None));
    }

    #[test]
    fn pick_from_keeps_a_cancel_apart_from_no_catalog() {
        let model = "opencode/deepseek-v4.1-flash-free";
        let ready = || CatalogFetch::Ready(Arc::new(catalog()));
        assert_eq!(
            pick_from(CatalogFetch::Cancelled, model, "high"),
            VariantPick::Cancelled
        );
        assert_eq!(
            pick_from(CatalogFetch::Unavailable, model, "high"),
            VariantPick::Send(None)
        );
        assert_eq!(
            pick_from(ready(), &format!(" {model} "), "xhigh"),
            VariantPick::Send(Some("max".to_string()))
        );
        assert_eq!(pick_from(ready(), model, "medium"), VariantPick::Send(None));
        assert_eq!(
            pick_from(ready(), "openai/unlisted", "high"),
            VariantPick::Send(None)
        );
    }

    /// A catalog read that answers `captured` and counts itself.
    async fn catalog_reading(
        identity: Option<&BinaryIdentity>,
        version: crate::opencode2::Version,
        facts: &Mutex<OpencodeFacts>,
        reads: &std::sync::atomic::AtomicUsize,
        captured: AppResult<Captured>,
    ) -> CatalogFetch {
        opencode2_catalog_with(identity, version, facts, || {
            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move { captured }
        })
        .await
    }

    fn catalog_exit(code: i32, stdout: &str) -> AppResult<Captured> {
        Ok(Captured::Exited {
            code,
            stdout: stdout.as_bytes().to_vec(),
            stderr: String::new(),
        })
    }

    #[tokio::test]
    async fn opencode2_catalog_is_remembered_per_binary_for_its_ttl() {
        let facts = Mutex::new(OpencodeFacts::default());
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let count = || reads.load(std::sync::atomic::Ordering::SeqCst);
        let binary = |len| BinaryIdentity {
            path: PathBuf::from("opencode"),
            len,
            modified: None,
        };
        let (one, two) = (binary(1), binary(2));
        let v2 = v2_version();
        let ready = |fetch: &CatalogFetch| match fetch {
            CatalogFetch::Ready(catalog) => catalog.variants("opencode/hy4-flash-free").len(),
            other => panic!("not a catalog: {other:?}"),
        };

        let first = catalog_reading(Some(&one), v2, &facts, &reads, catalog_exit(0, CATALOG)).await;
        assert_eq!((ready(&first), count()), (2, 1));
        // Remembered: a second ask, even one whose read would fail, never reads.
        let again = catalog_reading(Some(&one), v2, &facts, &reads, catalog_exit(1, "")).await;
        assert_eq!((ready(&again), count()), (2, 1));
        // Another binary is read, and takes the one slot.
        let other = catalog_reading(Some(&two), v2, &facts, &reads, catalog_exit(0, "[]")).await;
        assert_eq!((ready(&other), count()), (0, 2));
        let back = catalog_reading(Some(&one), v2, &facts, &reads, catalog_exit(0, CATALOG)).await;
        assert_eq!((ready(&back), count()), (2, 3));
        // Past the TTL the same binary is read again.
        let aged = Instant::now()
            .checked_sub(OPENCODE2_CATALOG_TTL + Duration::from_secs(1))
            .expect("an instant older than the TTL");
        facts.lock().unwrap().catalog.as_mut().unwrap().2 = aged;
        let fresh = catalog_reading(Some(&one), v2, &facts, &reads, catalog_exit(0, "[]")).await;
        assert_eq!((ready(&fresh), count()), (0, 4));

        // A failed read is advisory: no catalog, nothing remembered.
        facts.lock().unwrap().clear();
        for failed in [
            catalog_exit(1, CATALOG),
            catalog_exit(0, "not json"),
            Ok(Captured::TimedOut),
            Err(AppError::Command("spawn failed".to_string())),
        ] {
            let fetch = catalog_reading(Some(&one), v2, &facts, &reads, failed).await;
            assert!(matches!(fetch, CatalogFetch::Unavailable), "{fetch:?}");
            assert!(facts.lock().unwrap().catalog.is_none());
        }
        // A cancel stays a cancel and is not remembered either.
        let cancelled =
            catalog_reading(Some(&one), v2, &facts, &reads, Ok(Captured::Cancelled)).await;
        assert!(matches!(cancelled, CatalogFetch::Cancelled));
        assert!(facts.lock().unwrap().catalog.is_none());
        assert_eq!(count(), 9);

        // No identity: read on every call, never remembered.
        for _ in 0..2 {
            let fetch = catalog_reading(None, v2, &facts, &reads, catalog_exit(0, CATALOG)).await;
            assert_eq!(ready(&fetch), 2);
        }
        assert_eq!(count(), 11);
        assert!(facts.lock().unwrap().catalog.is_none());
    }

    /// A catalog names the version its reader's verdict held: a read that finishes after
    /// the binary answered another version is served only to the version it was read for.
    #[tokio::test]
    async fn opencode2_catalog_names_its_version() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bin = dir.path().join("opencode");
        std::fs::write(&bin, b"1").unwrap();
        let id = binary_identity(&bin).expect("an identity");
        let facts = Mutex::new(OpencodeFacts::default());
        let probes = std::sync::atomic::AtomicUsize::new(0);
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let count = || reads.load(std::sync::atomic::Ordering::SeqCst);
        let version = |text: &str| match crate::opencode2::classify_version(text) {
            Ok(crate::opencode2::Cli::V2(version)) => version,
            other => panic!("{other:?}"),
        };
        let (old, new) = (version("opencode v2.3.2"), version("opencode v2.4.0"));
        let ready = |fetch: &CatalogFetch| match fetch {
            CatalogFetch::Ready(catalog) => catalog.variants("opencode/hy4-flash-free").len(),
            other => panic!("not a catalog: {other:?}"),
        };

        // The binary answers 2.4.0 while the read for 2.3.2 is in flight.
        let (bin, facts_ref, probes, reads_ref) = (&bin, &facts, &probes, &reads);
        let interleaved = opencode2_catalog_with(Some(&id), old, facts_ref, move || {
            reads_ref.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                let newer = VersionProbe::Printed("opencode v2.4.0".to_string());
                verdict_probing(bin, facts_ref, Instant::now(), probes, newer).await;
                catalog_exit(0, CATALOG)
            }
        })
        .await;
        assert_eq!((ready(&interleaved), count()), (2, 1));
        let served = catalog_reading(Some(&id), old, &facts, &reads, catalog_exit(1, "")).await;
        assert_eq!((ready(&served), count()), (2, 1));
        let other = catalog_reading(Some(&id), new, &facts, &reads, catalog_exit(0, "[]")).await;
        assert_eq!((ready(&other), count()), (0, 2));
    }

    #[tokio::test]
    async fn opencode2_compose_reads_the_variant_before_any_probe() {
        let listed =
            |_: usize, doc: &str| ProbeAnswer::Stdout(readback_listing(doc, TRAILING_DENIES));
        let turns = [
            ("review", review_inputs(false, &[], None)),
            ("pinned", session_inputs(true, false, &[], None, None)),
            ("write", session_inputs(false, false, &[], None, None)),
        ];
        for (row, inputs) in &turns {
            // A cancel during the catalog read spawns nothing further.
            let (result, plans) = compose_picking(inputs, VariantPick::Cancelled, listed).await;
            assert!(
                matches!(result, Ok(TurnPlan::Cancelled)),
                "{row}: {result:?}"
            );
            assert!(plans.is_empty(), "{row}");

            // A picked variant rides `-m`; the read-back's argv is untouched.
            let pick = VariantPick::Send(Some("high".to_string()));
            let (result, plans) = compose_picking(inputs, pick, listed).await;
            let Ok(TurnPlan::Run { run, .. }) = result else {
                panic!("{row}: {result:?}");
            };
            let model = run.args.iter().position(|arg| arg == "-m").expect(row);
            assert_eq!(run.args[model + 1], "openai/gpt-5#high", "{row}");
            for probe in &plans {
                assert_eq!(probe.args, crate::opencode2::READBACK_ARGS, "{row}");
            }
            let (result, _) = compose_with(inputs, listed).await;
            let Ok(TurnPlan::Run { run, .. }) = result else {
                panic!("{row}: {result:?}");
            };
            assert!(run.args.iter().any(|arg| arg == "openai/gpt-5"), "{row}");
        }
        // A cancel during the read-back ends the turn there, with no run.
        for (row, inputs) in &turns[..2] {
            let (result, plans) = compose_with(inputs, |_, _| ProbeAnswer::Cancelled).await;
            assert!(
                matches!(result, Ok(TurnPlan::Cancelled)),
                "{row}: {result:?}"
            );
            assert_eq!(plans.len(), 1, "{row}");
        }
    }

    #[test]
    fn opencode2_listing_reads_like_the_1x_capture() {
        let listed = opencode2_listing(catalog_exit(0, "opencode/big-pickle\n")).unwrap();
        assert_eq!(
            listed,
            (0, "opencode/big-pickle\n".to_string(), String::new())
        );
        let timed_out = opencode2_listing(Ok(Captured::TimedOut)).unwrap_err();
        assert_eq!(
            catalog_listing_error(AgentKind::Opencode, timed_out).to_string(),
            AppError::Command("opencode model catalog timed out after 20s".to_string()).to_string()
        );
        let failed = opencode2_listing(Err(AppError::Command("no such file".to_string())));
        assert!(matches!(failed, Err(AppError::Command(text)) if text == "no such file"));
    }

    // --- opencode 2 sessions ------------------------------------------------------

    #[test]
    fn parse_native_ref_reads_each_stored_shape() {
        let v1 = |id: &str| NativeRef::V1 { id: id.to_string() };
        let v2 = |id: &str, kind| NativeRef::V2 {
            id: id.to_string(),
            kind,
        };
        let longest = "a".repeat(128);
        let too_long = "a".repeat(129);
        let cases = [
            (None, NativeRef::Absent),
            (Some(""), NativeRef::Absent),
            (Some("  "), NativeRef::Absent),
            (Some("ses_abc"), v1("ses_abc")),
            (Some(" ses_abc "), v1("ses_abc")),
            (Some("ses-1_x"), v1("ses-1_x")),
            (Some(longest.as_str()), v1(&longest)),
            (Some("oc2:w:ses_abc"), v2("ses_abc", TurnKind::Write)),
            (Some(" oc2:p:ses_abc "), v2("ses_abc", TurnKind::Pinned)),
            (Some("oc2:x:ses_abc"), NativeRef::Unusable),
            (Some("oc2:w:"), NativeRef::Unusable),
            (Some("oc2:ses_abc"), NativeRef::Unusable),
            (Some("oc2:w:--auto"), NativeRef::Unusable),
            (Some("oc2:p:ses abc"), NativeRef::Unusable),
            (Some("--auto"), NativeRef::Unusable),
            (Some("_ses"), NativeRef::Unusable),
            (Some("ses abc"), NativeRef::Unusable),
            (Some(too_long.as_str()), NativeRef::Unusable),
        ];
        for (raw, parsed) in cases {
            assert_eq!(parse_native_ref(raw), parsed, "{raw:?}");
        }
        for kind in [TurnKind::Write, TurnKind::Pinned] {
            let token = native_token(kind, "ses_abc");
            assert_eq!(parse_native_ref(Some(&token)), v2("ses_abc", kind));
        }
        assert_eq!(native_token(TurnKind::Write, "ses_abc"), "oc2:w:ses_abc");
        assert_eq!(native_token(TurnKind::Pinned, "ses_abc"), "oc2:p:ses_abc");
    }

    #[test]
    fn opencode2_resume_plan_never_crosses_turn_kinds() {
        let fresh = |reset| ResumePlan {
            session_id: String::new(),
            resumed: false,
            reset,
        };
        let resumed = || ResumePlan {
            session_id: "ses_abc".to_string(),
            resumed: true,
            reset: false,
        };
        let (write, pinned) = (TurnKind::Write, TurnKind::Pinned);
        // What a resumed turn does with each stored value; a turn that does not resume is
        // always fresh.
        let cases = [
            (None, write, fresh(true)),
            (None, pinned, fresh(true)),
            (Some(""), write, fresh(true)),
            (Some(""), pinned, fresh(true)),
            (Some("ses_abc"), write, resumed()),
            (Some("ses_abc"), pinned, resumed()),
            (Some("oc2:w:ses_abc"), write, resumed()),
            (Some("oc2:w:ses_abc"), pinned, fresh(true)),
            (Some("oc2:p:ses_abc"), write, fresh(true)),
            (Some("oc2:p:ses_abc"), pinned, resumed()),
            (Some("oc2:x:ses_abc"), write, fresh(true)),
            (Some("oc2:x:ses_abc"), pinned, fresh(true)),
        ];
        for (raw, turn, plan) in cases {
            let native = parse_native_ref(raw);
            assert_eq!(
                opencode2_resume_plan(true, &native, turn),
                plan,
                "{raw:?} {turn:?}"
            );
            assert_eq!(
                opencode2_resume_plan(false, &native, turn),
                fresh(false),
                "{raw:?} {turn:?}"
            );
        }
    }

    #[test]
    fn native_tag_hands_back_a_token() {
        let tag = |kind, resumed: Option<(&str, &str)>, rekey| NativeTag {
            kind,
            resumed: resumed.map(|(id, stored)| (id.to_string(), stored.to_string())),
            rekey,
        };
        let (write, pinned) = (TurnKind::Write, TurnKind::Pinned);
        // A resumed id goes back as the value it was read from.
        let token = tag(pinned, Some(("ses_abc", "oc2:p:ses_abc")), false);
        assert_eq!(token.token_for("ses_abc"), "oc2:p:ses_abc");
        let raw = tag(write, Some(("ses_abc", "ses_abc")), false);
        assert_eq!(raw.token_for("ses_abc"), "ses_abc");
        // A re-keyed id, and any other id, go back as this turn's token.
        let rekeyed = tag(write, Some(("ses_abc", "ses_abc")), true);
        assert_eq!(rekeyed.token_for("ses_abc"), "oc2:w:ses_abc");
        let rekeyed = tag(pinned, Some(("ses_abc", "ses_abc")), true);
        assert_eq!(rekeyed.token_for("ses_abc"), "oc2:p:ses_abc");
        assert_eq!(token.token_for("ses_new"), "oc2:p:ses_new");
        assert_eq!(
            tag(write, None, false).token_for("ses_new"),
            "oc2:w:ses_new"
        );
    }

    /// The stores' side of the id contract, folding one turn's events: a reset or re-key
    /// notice arms the turn, so its next `NativeSession` replaces the stored id; a turn with
    /// no `NativeSession` leaves the stored id as it was; without a notice a
    /// `NativeSession` id is kept only while none is held.
    fn fold_native(mut stored: Option<String>, events: &[ReviewEvent]) -> Option<String> {
        let mut armed = false;
        for event in events {
            match event {
                ReviewEvent::Notice { code, .. }
                    if *code == NOTICE_SESSION_RESET || *code == NOTICE_SESSION_REKEY =>
                {
                    armed = true;
                }
                ReviewEvent::NativeSession { id } if armed || stored.is_none() => {
                    stored = Some(id.clone());
                    armed = false;
                }
                _ => {}
            }
        }
        stored
    }

    /// The events a 2.x session turn sends for `lines`, through the collector; none is
    /// terminal.
    fn session_turn_events(tag: NativeTag, lines: &[String]) -> Vec<ReviewEvent> {
        let sink = collector();
        let mut terminal = None;
        let mut stream = Opencode2Stream {
            parser: crate::opencode2::StreamParser::new(None),
            native: Some(tag),
        };
        for line in lines {
            for ev in opencode2_stream_event(&mut stream, line)
                .into_iter()
                .flatten()
            {
                send_noting_terminal(&sink, &mut terminal, ev);
            }
        }
        assert!(terminal.is_none(), "no stream line is terminal");
        sink.events.into_inner().unwrap()
    }

    /// One line per event, for comparing whole turns.
    fn brief(events: &[ReviewEvent]) -> Vec<String> {
        events
            .iter()
            .map(|event| match event {
                ReviewEvent::Notice { code, text } => format!("notice {code} {text:?}"),
                ReviewEvent::NativeSession { id } => format!("native {id}"),
                ReviewEvent::Delta { text } => format!("delta {text}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn session_step(session: &str, message: &str) -> String {
        serde_json::json!({"type": "step_start", "timestamp": 1, "sessionID": session,
            "part": {"id": format!("prt_{message}"), "sessionID": session,
            "messageID": message, "type": "step-start"}})
        .to_string()
    }

    fn session_text(session: &str, message: &str, text: &str) -> String {
        serde_json::json!({"type": "text", "timestamp": 2, "sessionID": session,
            "part": {"id": format!("prt_{message}_t"), "sessionID": session,
            "messageID": message, "type": "text", "text": text,
            "time": {"start": 1, "end": 2}}})
        .to_string()
    }

    #[test]
    fn opencode2_rekeys_a_resumed_raw_id_at_its_first_step() {
        let raw = "ses_abc";
        let stored = Some(raw.to_string());
        let lines = [
            session_step(raw, "msg_a1"),
            session_text(raw, "msg_a1", "Looks fine."),
            session_step(raw, "msg_a2"),
        ];
        let rekey_tag = |kind, rekey| NativeTag {
            kind,
            resumed: Some((raw.to_string(), raw.to_string())),
            rekey,
        };
        // A raw id resumed under opencode 2: one notice, right before the first id.
        for (kind, token) in [
            (TurnKind::Write, "oc2:w:ses_abc"),
            (TurnKind::Pinned, "oc2:p:ses_abc"),
        ] {
            let events = session_turn_events(rekey_tag(kind, true), &lines);
            assert_eq!(
                brief(&events),
                [
                    format!("notice {NOTICE_SESSION_REKEY} \"\""),
                    format!("native {token}"),
                    "delta Looks fine.".to_string(),
                    format!("native {token}"),
                ],
                "{kind:?}"
            );
            assert_eq!(
                fold_native(stored.clone(), &events),
                Some(token.to_string())
            );
            // The token it ends with sends a later 1.x binary to a new conversation.
            assert!(opencode1_must_restart(true, Some(token)));
        }
        // Control: without the re-key the store keeps the raw id.
        let events = session_turn_events(rekey_tag(TurnKind::Write, false), &lines);
        assert_eq!(fold_native(stored.clone(), &events), stored);

        // A resumed token is never re-keyed and goes back unchanged.
        let token = "oc2:p:ses_abc";
        let resumed_token = NativeTag {
            kind: TurnKind::Pinned,
            resumed: Some((raw.to_string(), token.to_string())),
            rekey: false,
        };
        let events = session_turn_events(resumed_token, &lines);
        assert_eq!(
            brief(&events),
            [
                format!("native {token}"),
                "delta Looks fine.".to_string(),
                format!("native {token}"),
            ]
        );
        assert_eq!(
            fold_native(Some(token.to_string()), &events),
            Some(token.to_string())
        );

        // A new conversation: no notice, and the store takes the minted token.
        let fresh = NativeTag {
            kind: TurnKind::Write,
            resumed: None,
            rekey: false,
        };
        let new_lines = [session_step("ses_new", "msg_b1")];
        let events = session_turn_events(fresh.clone(), &new_lines);
        assert_eq!(brief(&events), ["native oc2:w:ses_new"]);
        assert_eq!(
            fold_native(None, &events),
            Some("oc2:w:ses_new".to_string())
        );

        // A reset, sent ahead of the spawn, then a new id: no re-key notice in the turn.
        let reset = ReviewEvent::Notice {
            code: NOTICE_SESSION_RESET,
            text: NOTICE_RESET_GENERIC.to_string(),
        };
        let mut turn = vec![reset];
        turn.extend(session_turn_events(fresh, &new_lines));
        assert_eq!(
            fold_native(Some("oc2:p:ses_abc".to_string()), &turn),
            Some("oc2:w:ses_new".to_string())
        );
        assert!(!brief(&turn)
            .iter()
            .any(|e| e.contains(NOTICE_SESSION_REKEY)));
    }

    #[test]
    fn opencode2_rekey_waits_for_the_new_id() {
        let raw = "ses_abc";
        let stored = Some(raw.to_string());
        let tag = NativeTag {
            kind: TurnKind::Write,
            resumed: Some((raw.to_string(), raw.to_string())),
            rekey: true,
        };
        // A turn that fails before its first step sends neither, so the raw id stays.
        let failed = [
            serde_json::json!({"type": "retry", "timestamp": 1, "sessionID": raw,
            "attempt": 2, "error": {"message": "Rate limited"}})
            .to_string(),
            serde_json::json!({"type": "background_wait", "timestamp": 2, "sessionID": raw,
            "jobs": [{"id": "job_1", "kind": "shell", "title": "build"}]})
            .to_string(),
            serde_json::json!({"type": "error", "timestamp": 3, "sessionID": raw,
            "error": {"type": "unknown", "message": "Model not found"}})
            .to_string(),
        ];
        let events = session_turn_events(tag, &failed);
        assert!(events.is_empty(), "{:?}", brief(&events));
        assert_eq!(fold_native(stored.clone(), &events), stored);
        // A lone notice only arms its turn: with no id to replace it, the raw id stays.
        let early = ReviewEvent::Notice {
            code: NOTICE_SESSION_REKEY,
            text: String::new(),
        };
        assert_eq!(fold_native(stored.clone(), &[early]), stored);
    }

    #[test]
    fn opencode2_rekeys_on_a_reconcile_only_turn() {
        let raw = "ses_abc";
        let tag = NativeTag {
            kind: TurnKind::Write,
            resumed: Some((raw.to_string(), raw.to_string())),
            rekey: true,
        };
        // opencode 2.2.0 can answer with reconcile lines alone: the id rides the text line.
        let events = session_turn_events(tag, &[session_text(raw, "msg_b1", "Answer.")]);
        assert_eq!(
            brief(&events),
            [
                format!("notice {NOTICE_SESSION_REKEY} \"\""),
                "native oc2:w:ses_abc".to_string(),
                "delta Answer.".to_string(),
            ]
        );
        assert_eq!(
            fold_native(Some(raw.to_string()), &events),
            Some("oc2:w:ses_abc".to_string())
        );
    }

    #[test]
    fn opencode2_store_fold_arms_per_turn() {
        let stored = Some("oc2:w:ses_old".to_string());
        let reset = ReviewEvent::Notice {
            code: NOTICE_SESSION_RESET,
            text: NOTICE_RESET_GENERIC.to_string(),
        };
        let native = |id: &str| ReviewEvent::NativeSession { id: id.to_string() };
        // A reset turn that failed before its first step keeps the stored id.
        let after_failed = fold_native(stored.clone(), std::slice::from_ref(&reset));
        assert_eq!(after_failed, stored);
        // The next reset turn's id replaces it, and a repeat of that id changes nothing.
        let second = [reset, native("oc2:w:ses_new"), native("oc2:w:ses_new")];
        assert_eq!(
            fold_native(after_failed, &second),
            Some("oc2:w:ses_new".to_string())
        );
        // Without a notice a held id stays.
        assert_eq!(
            fold_native(stored.clone(), &[native("oc2:w:ses_other")]),
            stored
        );
    }

    // --- opencode 2 container sessions

    #[tokio::test]
    async fn split_container_env_forwards_only_the_lock_document_by_name() {
        let content = crate::opencode2::CONTENT_ENV;
        let listed =
            |_: usize, doc: &str| ProbeAnswer::Stdout(readback_listing(doc, TRAILING_DENIES));
        let config = "/home/node/.local/share/opencode/opencode-mcp.json";
        let argv = |env: &[(&'static str, String)], by_name: &[&'static str], inner: &[String]| {
            crate::agent_sandbox::build_run_args_full(
                "docker",
                "opencode",
                "/worktree",
                Path::new("/data/agent-home/s1/opencode"),
                "gd-agent-s1",
                "gitdesktop-agent:test",
                None,
                None,
                env,
                by_name,
                inner,
            )
        };
        // Plan and Research: the probe and the run each carry their document by name only.
        for web in [false, true] {
            let inputs = session_inputs(true, web, &["gitdesktop"], Some(config), None);
            let (result, plans) = compose_with(&inputs, listed).await;
            let (run, lock) = match result {
                Ok(TurnPlan::Run {
                    run,
                    lock: Some(lock),
                    ..
                }) => (run, lock),
                other => panic!("web {web}: {other:?}"),
            };
            let [probe] = &plans[..] else {
                panic!("web {web}: {} plans", plans.len());
            };
            let probe_document = env_value(probe, content).expect("the probe's document");
            for (plan, document) in [(probe, probe_document), (&run, lock.json())] {
                let (container_env, client_env) = split_container_env(plan.env.clone());
                assert_eq!(client_env, [(content, document.to_string())], "web {web}");
                let rest: Vec<_> = plan
                    .env
                    .iter()
                    .filter(|(key, _)| *key != content)
                    .cloned()
                    .collect();
                assert_eq!(container_env, rest, "web {web}");
                let args = argv(&container_env, &[content], &plan.args);
                assert!(
                    !args.iter().any(|arg| arg.contains(&format!("{content}="))),
                    "web {web}: {args:?}"
                );
                assert!(
                    args.windows(2)
                        .any(|pair| pair[0] == "-e" && pair[1] == content),
                    "web {web}: {args:?}"
                );
                assert!(
                    args.contains(&format!("OPENCODE_CONFIG={config}")),
                    "web {web}: {args:?}"
                );
            }
        }
        // A write turn has no document: nothing stays with the client, nothing goes by name.
        let inputs = session_inputs(false, false, &["gitdesktop"], Some(config), None);
        let run = match compose_with(&inputs, listed).await.0 {
            Ok(TurnPlan::Run {
                run, lock: None, ..
            }) => run,
            other => panic!("write: {other:?}"),
        };
        let (container_env, client_env) = split_container_env(run.env.clone());
        assert!(client_env.is_empty());
        assert_eq!(container_env, run.env);
        let args = argv(&container_env, &[], &run.args);
        assert!(!args.iter().any(|arg| arg.contains(content)), "{args:?}");
    }

    #[test]
    fn sign_in_notices_carry_the_wire_codes() {
        // The frontend compares these codes as literals.
        assert_eq!(
            [
                NOTICE_SIGN_INS_COPIED,
                NOTICE_SIGN_INS_NOT_COPIED,
                NOTICE_NO_SIGN_INS
            ],
            ["signInsCopied", "signInsNotCopied", "noSignIns"]
        );
        assert!(SIGN_INS_NOT_COPIED.ends_with(SIGN_INS_RETRY_HINT));
        assert!(SIGN_INS_LEFTOVER_KEPT.ends_with(SIGN_INS_RETRY_HINT));
        assert!(SIGN_INS_UNCHECKED.ends_with(SIGN_INS_RETRY_HINT));
        let notice = ReviewEvent::Notice {
            code: NOTICE_SIGN_INS_COPIED,
            text: SIGN_INS_COPIED.to_string(),
        };
        assert_eq!(
            serde_json::to_value(&notice).expect("a notice serializes"),
            serde_json::json!({
                "kind": "notice",
                "code": "signInsCopied",
                "text": SIGN_INS_COPIED,
            })
        );
    }

    #[test]
    fn opencode2_sign_in_route_exports_only_from_opencode_2() {
        let v2 = crate::opencode2::classify_version("opencode v2.3.2").expect("2.x");
        let v1 = crate::opencode2::classify_version("1.19.6").expect("1.x");
        let refusal =
            crate::opencode2::classify_version("opencode v0.0.0-dev").expect_err("a preview build");
        let failed = OpencodeVerdict::ProbeFailed("timed out after 20s".to_string());
        for fresh in [true, false] {
            let route = |verdict: Option<&OpencodeVerdict>| opencode2_sign_in_route(verdict, fresh);
            assert_eq!(
                route(Some(&OpencodeVerdict::Supported(v2))),
                SignInRoute::Export
            );
            assert_eq!(
                route(Some(&OpencodeVerdict::Supported(v1))),
                SignInRoute::Copy(None)
            );
            // A refused version copies, and tells only a fresh home why.
            assert_eq!(
                route(Some(&OpencodeVerdict::Refused(refusal.clone()))),
                SignInRoute::Copy(fresh.then_some(SIGN_INS_HOST_REFUSED)),
                "{fresh}"
            );
            assert_eq!(route(None), SignInRoute::Copy(None));
            // A probe that could not run copies, and tells only a fresh home why.
            let unchecked = fresh.then_some(SIGN_INS_UNCHECKED);
            assert_eq!(
                route(Some(&failed)),
                SignInRoute::Copy(unchecked),
                "{fresh}"
            );
        }
    }

    #[test]
    fn opencode2_after_copy_reports_a_cancel_that_spent_the_home() {
        let copied = (NOTICE_SIGN_INS_COPIED, SIGN_INS_COPIED.to_string());
        let not_copied = (NOTICE_SIGN_INS_NOT_COPIED, SIGN_INS_NOT_COPIED.to_string());
        // An answered copy goes on with its own notice, whatever the home holds now.
        assert_eq!(
            opencode2_after_copy(Some(copied.clone()), || panic!("not read")),
            (Some(copied), true)
        );
        // A cancel ends the turn: silent while the home is still fresh, so the next turn
        // copies again, and with the not-copied notice once it is not.
        assert_eq!(opencode2_after_copy(None, || true), (None, false));
        assert_eq!(
            opencode2_after_copy(None, || false),
            (Some(not_copied), false)
        );
    }

    #[test]
    fn opencode2_leftover_notice_skips_the_export_only_on_a_failed_removal() {
        assert_eq!(opencode2_leftover_notice(&Ok(())), None);
        let kept = (
            NOTICE_SIGN_INS_NOT_COPIED,
            SIGN_INS_LEFTOVER_KEPT.to_string(),
        );
        for failed in [
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            std::io::Error::other("x"),
        ] {
            assert_eq!(opencode2_leftover_notice(&Err(failed)), Some(kept.clone()));
        }
        // The notice goes out and the turn goes on, whatever the home holds.
        assert_eq!(
            opencode2_after_copy(Some(kept.clone()), || true),
            (Some(kept), true)
        );
    }

    #[test]
    fn container_may_remain_unless_the_client_exited() {
        let exited = |code| {
            Ok(Captured::Exited {
                code,
                stdout: Vec::new(),
                stderr: String::new(),
            })
        };
        let cases: [(AppResult<Captured>, bool); 9] = [
            (exited(0), false),
            (exited(1), false),
            (exited(137), false),
            // A client killed by a signal.
            (exited(-1), true),
            // Any other negative code.
            (exited(-1073741819), true),
            (Ok(Captured::TimedOut), true),
            (Ok(Captured::Cancelled), true),
            // An output overflow.
            (Err(AppError::Command("too much output".to_string())), true),
            (Err(AppError::Io(std::io::Error::other("pipe"))), true),
        ];
        for (captured, want) in &cases {
            assert_eq!(container_may_remain(captured), *want);
        }
    }

    #[test]
    fn capture_command_carries_the_base_env_then_the_request() {
        let req = CaptureRequest {
            program: Path::new("opencode"),
            args: vec!["debug".to_string(), "agents".to_string()],
            cwd: Some("/repo"),
            env: vec![
                ("OC_PAIR_ONE", "1".to_string()),
                ("OC_PAIR_TWO", "two".to_string()),
            ],
            stdin: None,
            timeout: Duration::from_secs(1),
            cancel: None,
        };
        let cmd = capture_command(&req);
        let std_cmd = cmd.as_std();
        let envs: Vec<(String, Option<String>)> = std_cmd
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for (key, value) in [
            ("PWD", None),
            ("NO_COLOR", Some("1")),
            ("CLICOLOR", Some("0")),
            ("OC_PAIR_ONE", Some("1")),
            ("OC_PAIR_TWO", Some("two")),
        ] {
            assert!(
                envs.contains(&(key.to_string(), value.map(String::from))),
                "{key}: {envs:?}"
            );
        }
        assert_eq!(std_cmd.get_current_dir(), Some(Path::new("/repo")));
        let args: Vec<String> = std_cmd
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["debug", "agents"]);
    }

    #[tokio::test]
    async fn capture_tree_reports_an_exit_and_kills_a_forced_run() {
        let request = |program: &'static str, args: &[&str], timeout: Duration| CaptureRequest {
            program: Path::new(program),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            cwd: None,
            env: Vec::new(),
            stdin: None,
            timeout,
            cancel: None,
        };
        let echo = if cfg!(windows) {
            request("cmd", &["/C", "echo", "captured"], Duration::from_secs(60))
        } else {
            request("sh", &["-c", "echo captured"], Duration::from_secs(60))
        };
        match capture_tree(echo).await {
            Ok(Captured::Exited {
                code: 0, stdout, ..
            }) => assert_eq!(String::from_utf8_lossy(&stdout).trim(), "captured"),
            Ok(Captured::Exited { code, .. }) => panic!("exit {code}"),
            Ok(_) => panic!("the echo did not exit"),
            Err(error) => panic!("{error}"),
        }
        let long = |timeout: Duration| {
            if cfg!(windows) {
                request("ping", &["-n", "30", "127.0.0.1"], timeout)
            } else {
                request("sleep", &["30"], timeout)
            }
        };
        let started = Instant::now();
        let timed_out = capture_tree(long(Duration::from_millis(500))).await;
        assert!(matches!(timed_out, Ok(Captured::TimedOut)));
        // Fired once the run is waiting: `biased` polls the capture to its select first.
        let cancel = Notify::new();
        let (cancelled, ()) = tokio::join!(
            biased;
            capture_tree(CaptureRequest {
                cancel: Some(&cancel),
                ..long(Duration::from_secs(60))
            }),
            async { cancel.notify_one() },
        );
        assert!(matches!(cancelled, Ok(Captured::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_secs(25),
            "the forced runs were killed, not waited out"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capture_tree_reads_a_signal_death_as_a_container_that_may_remain() {
        // `$$` is the shell itself, so the child dies by SIGKILL with no exit code.
        let captured = capture_tree(CaptureRequest {
            program: Path::new("sh"),
            args: vec!["-c".to_string(), "kill -9 $$".to_string()],
            cwd: None,
            env: Vec::new(),
            stdin: None,
            timeout: Duration::from_secs(60),
            cancel: None,
        })
        .await;
        match &captured {
            Ok(Captured::Exited { code: -1, .. }) => {}
            Ok(Captured::Exited { code, .. }) => panic!("exit {code}"),
            Ok(_) => panic!("the shell did not exit"),
            Err(error) => panic!("{error}"),
        }
        assert!(container_may_remain(&captured));
    }

    /// A request whose cancel already fired answers `Cancelled` without spawning, stdin
    /// or not: its program does not exist, so a spawn would answer the spawn error.
    #[tokio::test]
    async fn capture_tree_spawns_nothing_after_a_fired_cancel() {
        fn missing(cancel: Option<&Notify>, stdin: Option<Vec<u8>>) -> CaptureRequest<'_> {
            CaptureRequest {
                program: Path::new("gd-test-no-such-program"),
                args: Vec::new(),
                cwd: None,
                env: Vec::new(),
                stdin,
                timeout: Duration::from_secs(60),
                cancel,
            }
        }
        let idle = Notify::new();
        for cancel in [None, Some(&idle)] {
            let spawned = capture_tree(missing(cancel, None)).await;
            assert!(matches!(spawned, Err(AppError::Io(_))), "{cancel:?}");
        }
        for stdin in [None, Some(b"GD-SENTINEL-NOT-A-KEY\n".to_vec())] {
            let cancel = Notify::new();
            cancel.notify_one();
            let captured = capture_tree(missing(Some(&cancel), stdin)).await;
            assert!(matches!(captured, Ok(Captured::Cancelled)));
        }
    }

    #[tokio::test]
    async fn opencode2_cancel_fired_spends_only_a_fired_permit() {
        let cancel = Notify::new();
        assert!(!opencode2_cancel_fired(&cancel));
        cancel.notify_one();
        assert!(opencode2_cancel_fired(&cancel));
        assert!(!opencode2_cancel_fired(&cancel), "the permit was spent");
        // A cancel after an unfired check stays stored for the run's own wait.
        cancel.notify_one();
        let kept = tokio::time::timeout(Duration::from_secs(5), cancel.notified()).await;
        assert!(kept.is_ok());
    }

    #[tokio::test]
    async fn capture_tree_writes_its_stdin_to_the_child() {
        // `sort` echoes its one input line on both platforms.
        let program = if cfg!(windows) { "sort" } else { "cat" };
        let captured = capture_tree(CaptureRequest {
            program: Path::new(program),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            stdin: Some(b"GD-SENTINEL-NOT-A-KEY\n".to_vec()),
            timeout: Duration::from_secs(60),
            cancel: None,
        })
        .await;
        match captured {
            Ok(Captured::Exited {
                code: 0, stdout, ..
            }) => assert_eq!(
                String::from_utf8_lossy(&stdout).trim(),
                "GD-SENTINEL-NOT-A-KEY"
            ),
            Ok(Captured::Exited { code, .. }) => panic!("exit {code}"),
            Ok(_) => panic!("{program} did not exit"),
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn agent_command_return_is_the_event_or_null() {
        // `agent_review` / `agent_session` return `Option<ReviewEvent>`, which the TS
        // mirror reads as `ReviewEvent | null`: Some is the event's own object, None null.
        let done = ReviewEvent::Done {
            text: "body".to_string(),
            is_error: false,
            cost_usd: Some(0.5),
        };
        let own = serde_json::to_value(&done).expect("Done serializes");
        let returned = serde_json::to_value(Some(done)).expect("Some(Done) serializes");
        assert_eq!(returned, own);
        assert_eq!(returned["kind"], "done");
        assert_eq!(returned["costUsd"], 0.5);
        assert_eq!(
            serde_json::to_value(None::<ReviewEvent>).expect("None serializes"),
            serde_json::Value::Null
        );
    }

    #[test]
    fn claude_is_error_flag_alone_is_decisive() {
        // The flag pinned in ISOLATION: no api_error_status, no terminal_reason, and
        // result text no other signal can catch.
        let line = r#"{"type":"result","subtype":"success","is_error":true,"result":"The run stopped early."}"#;
        let (text, is_error) = claude_done(&[line]);
        assert!(is_error);
        assert_eq!(text, "The run stopped early.");
    }

    #[test]
    fn claude_structural_signals_outrank_is_error_false() {
        // Both shapes claim success in `is_error`; the structural fields say otherwise.
        let status = r#"{"type":"result","subtype":"success","is_error":false,"api_error_status":529,"result":"Overloaded"}"#;
        assert!(claude_done(&[status]).1, "api_error_status is decisive");
        let reason = r#"{"type":"result","subtype":"success","is_error":false,"terminal_reason":"api_error","result":"Something went wrong."}"#;
        assert!(claude_done(&[reason]).1, "a non-completed terminal_reason is decisive");
    }

    #[test]
    fn claude_result_echoing_a_synthetic_error_is_an_error() {
        // The live-bug shape: an API failure reported with no structural signal at all,
        // caught only because the synthetic assistant message repeated the same text.
        let result = r#"{"type":"result","subtype":"success","is_error":false,"result":"There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it."}"#;
        assert!(claude_done(&[CL_SYNTHETIC, result]).1);
        // Without the synthetic message ahead of it, that same line has no signal.
        assert!(!claude_done(&[result]).1);
        // The `<synthetic>` model is the fallback when the flag is absent.
        let by_model = r#"{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"There's an issue with the selected model (bogus-model-xyz). It may not exist or you may not have access to it."}]}}"#;
        assert!(claude_done(&[by_model, result]).1);
    }

    #[test]
    fn claude_limit_messages_are_caught_without_structural_signals() {
        let usage = r#"{"type":"result","subtype":"success","is_error":false,"result":"Claude AI usage limit reached|1753980000"}"#;
        assert!(claude_done(&[usage]).1);
        let session = r#"{"type":"result","subtype":"success","is_error":false,"result":"5-hour limit reached ∙ resets 3am"}"#;
        assert!(claude_done(&[session]).1);
    }

    #[test]
    fn claude_a_real_review_mentioning_limits_stays_successful() {
        // The net must never fire on a genuine review body: it is multi-paragraph and
        // far past the length bound even though it says "limit reached" mid-prose.
        let review = r#"{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"Review of the retry path.\n\nIt swallows the 429 response, so a caller that hits the rate limit reached state never learns why the request failed. That matters here because the surrounding code assumes a thrown error, and the silent None flows into the cache as if it were a successful empty result, which later reads cannot tell apart from real data.\n\nSuggest surfacing the status instead.","total_cost_usd":0.02}"#;
        let (text, is_error) = claude_done(&[review]);
        assert!(text.chars().count() > 300, "fixture must exceed the net's bound");
        assert!(!is_error);
    }

    #[test]
    fn claude_long_single_paragraph_clears_the_net_on_length_alone() {
        // The length bound pinned in ISOLATION: this body matches a net pattern and has
        // no paragraph break, so only its size keeps a real long answer out of the net.
        let body = format!(
            "API Error handling is the subject of this answer, {}",
            "which runs on in a single paragraph without a blank line anywhere. ".repeat(5)
        );
        assert!(body.chars().count() > 300, "fixture must exceed the bound");
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": body,
        })
        .to_string();
        assert!(!claude_done(&[&line]).1);
    }

    #[test]
    fn claude_crlf_paragraph_break_clears_the_net() {
        // CRLF bodies are multi-paragraph too — the blank-line check must see
        // `\r\n\r\n`, matching the runner-side twin's /\n[ \t\r]*\n/.
        let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"API Error: 500 while fetching the diff.\r\n\r\nRetried once, then the review completed."}"#;
        let (text, is_error) = claude_done(&[line]);
        assert!(text.chars().count() <= 300, "length must not be what clears it");
        assert!(!is_error);
    }

    #[test]
    fn claude_absent_terminal_reason_stays_successful() {
        // Back-compat: older CLIs emit neither `terminal_reason` nor `api_error_status`.
        let old = r#"{"type":"result","subtype":"success","is_error":false,"result":"OK"}"#;
        let (text, is_error) = claude_done(&[old]);
        assert_eq!(text, "OK");
        assert!(!is_error);
    }

    #[test]
    fn copilot_lazy_separator_between_assistant_messages() {
        // Deltas across two assistant messages get exactly one `\n\n` between them.
        let mut msg = String::new();
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let d1 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"First."}}"#;
        let m1 = r#"{"type":"assistant.message","data":{"content":"First."}}"#;
        let d2 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Second."}}"#;

        let ev = parse_copilot_line(d1, &mut msg, &mut emitted, &mut pending, &mut err).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "First."));
        // A completed message arms the separator; the next delta is prefixed once.
        assert!(parse_copilot_line(m1, &mut msg, &mut emitted, &mut pending, &mut err).is_none());
        assert!(pending);
        let ev = parse_copilot_line(d2, &mut msg, &mut emitted, &mut pending, &mut err).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "\n\nSecond."));
        assert!(!pending, "the separator is consumed by the first following delta");
    }

    #[test]
    fn copilot_first_delta_has_no_separator() {
        // The very first delta of a run must not be prefixed (nothing emitted before).
        let mut msg = String::new();
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let d = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Hello."}}"#;
        let ev = parse_copilot_line(d, &mut msg, &mut emitted, &mut pending, &mut err).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "Hello."));
        assert!(emitted);
    }

    // Real Copilot CLI `--output-format json` terminal lines.
    const CP_SESSION_ERROR: &str = r#"{"type":"session.error","data":{"message":"API rate limit exceeded for this session."}}"#;
    const CP_RESULT_OK: &str = r#"{"type":"result","exitCode":0}"#;

    #[test]
    fn copilot_session_error_fails_the_run_despite_exit_zero() {
        // The CLI exits 0 after a session error, so exit code alone would report the
        // error text as a successful answer; the stash makes `result` report failure.
        let mut msg = String::new();
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        assert!(parse_copilot_line(
            CP_SESSION_ERROR,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err
        )
        .is_none());
        assert_eq!(err.as_deref(), Some("API rate limit exceeded for this session."));
        let ev = parse_copilot_line(CP_RESULT_OK, &mut msg, &mut emitted, &mut pending, &mut err)
            .unwrap();
        assert!(ends_turn(&ev));
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert!(is_error, "a session.error fails the run whatever the exit code");
                // The error message is the failure reason the frontend shows.
                assert_eq!(text, "API rate limit exceeded for this session.");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn copilot_session_error_after_prose_reports_the_reason_not_the_prose() {
        // Prose already streamed when the session errors: `Done.text` must still be the
        // REASON — the frontend refuses run output as an error message, and the prose
        // survives in the delta stream regardless.
        let mut msg = String::new();
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let prose = r#"{"type":"assistant.message","data":{"content":"Here is my review of the retry path."}}"#;
        parse_copilot_line(prose, &mut msg, &mut emitted, &mut pending, &mut err);
        assert_eq!(msg, "Here is my review of the retry path.");
        parse_copilot_line(
            CP_SESSION_ERROR,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err,
        );
        let ev = parse_copilot_line(CP_RESULT_OK, &mut msg, &mut emitted, &mut pending, &mut err)
            .unwrap();
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert!(is_error);
                assert_eq!(text, "API rate limit exceeded for this session.");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn copilot_clean_run_stays_successful() {
        let mut msg = String::new();
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let m = r#"{"type":"assistant.message","data":{"content":"All good."}}"#;
        parse_copilot_line(m, &mut msg, &mut emitted, &mut pending, &mut err);
        let ev = parse_copilot_line(CP_RESULT_OK, &mut msg, &mut emitted, &mut pending, &mut err)
            .unwrap();
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert!(!is_error);
                assert_eq!(text, "All good.");
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn opencode_tool_calls_finish_is_not_terminal_but_stop_is() {
        // Degenerate: the final step produced no text (step accumulator empty), so
        // `Done` falls back to the full accumulation rather than emitting empty.
        let (mut msg, mut step) = ("hello".to_string(), String::new());
        // `reason: tool-calls` means another step follows — not the turn's end.
        assert!(parse_opencode_line(FINISH_TOOLS, &mut msg, &mut step).is_none());
        // `reason: stop` ends the turn and carries the fallback text.
        let ev = parse_opencode_line(FINISH_STOP, &mut msg, &mut step).unwrap();
        assert!(ends_turn(&ev));
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert_eq!(text, "hello");
                assert!(!is_error);
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn opencode_done_carries_only_the_final_step_text() {
        // A run of [step1 text "A", tool, step2 text "B"]: both stream as deltas ("A"
        // then "\n\nB"), but `Done.text` is the FINAL step's text only — the step-1
        // narration is stripped off the body.
        let (mut msg, mut step) = (String::new(), String::new());
        let s1 = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let a = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"A"}}"#;
        let tool = r#"{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"read","state":{"status":"completed"}}}"#;
        let fin_tool = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"tool-calls"}}"#;
        let s2 = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let b = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"B"}}"#;
        let fin_stop = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}"#;

        let mut buffer = String::new();
        parse_opencode_line(s1, &mut msg, &mut step); // NativeSession
        if let Some(ReviewEvent::Delta { text }) = parse_opencode_line(a, &mut msg, &mut step) {
            buffer.push_str(&text);
        }
        parse_opencode_line(tool, &mut msg, &mut step); // Tool
        parse_opencode_line(fin_tool, &mut msg, &mut step); // not terminal
        parse_opencode_line(s2, &mut msg, &mut step); // NativeSession, clears step
        if let Some(ReviewEvent::Delta { text }) = parse_opencode_line(b, &mut msg, &mut step) {
            buffer.push_str(&text);
        }
        let done = parse_opencode_line(fin_stop, &mut msg, &mut step).unwrap();
        match done {
            ReviewEvent::Done { text, .. } => {
                assert_eq!(text, "B");
                // Load-bearing frontend invariant: the delta buffer ENDS WITH Done.text.
                assert_eq!(buffer, "A\n\nB");
                assert!(buffer.ends_with(&text));
            }
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[test]
    fn opencode_final_step_joins_multiple_text_parts() {
        // A final step with several text parts joins them with `\n\n` — so Done.text
        // (the buffer tail) matches exactly what streamed within the final step.
        let (mut msg, mut step) = (String::new(), String::new());
        let s = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let p1 = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"one"}}"#;
        let p2 = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"two"}}"#;
        let fin_stop = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}"#;
        parse_opencode_line(s, &mut msg, &mut step);
        parse_opencode_line(p1, &mut msg, &mut step);
        parse_opencode_line(p2, &mut msg, &mut step);
        let done = parse_opencode_line(fin_stop, &mut msg, &mut step).unwrap();
        match done {
            ReviewEvent::Done { text, .. } => assert_eq!(text, "one\n\ntwo"),
            other => panic!("expected Done, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn expand_env_vars_resolves_known_and_keeps_unknown() {
        // SAFETY: test-local env var, single-threaded within this test.
        std::env::set_var("GD_TEST_ROOT", r"C:\tools");
        // Known %VAR% is expanded; surrounding literals are preserved.
        assert_eq!(expand_env_vars(r"%GD_TEST_ROOT%\bin"), r"C:\tools\bin");
        // A plain path (the common installer case, e.g. glab) is untouched.
        assert_eq!(
            expand_env_vars(r"C:\Program Files (x86)\glab"),
            r"C:\Program Files (x86)\glab"
        );
        // An unknown var is left literal, not silently dropped to a partial path.
        assert_eq!(expand_env_vars(r"%GD_NOPE%\bin"), r"%GD_NOPE%\bin");
        // An unbalanced '%' is emitted literally.
        assert_eq!(expand_env_vars("50%done"), "50%done");
        std::env::remove_var("GD_TEST_ROOT");
    }

    // Live-registry validation (not just the expander): HKLM's Session Manager Path
    // always exists and always contains an expandable system32 dir, so a working
    // read returns a non-empty list with at least one real directory.
    #[cfg(windows)]
    #[test]
    fn registry_path_dirs_reads_the_live_system_path() {
        let dirs = registry_path_dirs();
        assert!(!dirs.is_empty(), "expected the system PATH from the registry");
        assert!(
            dirs.iter().any(|d| d.is_dir()),
            "expected at least one real directory among: {dirs:?}"
        );
    }

    /// Pull the `--tools` allowlist out of a built Claude arg vector.
    fn tools_of(args: &[String]) -> &str {
        let i = args.iter().position(|a| a == "--tools").expect("--tools");
        args.get(i + 1).expect("a tools value").as_str()
    }

    #[test]
    fn claude_read_only_web_adds_web_tools_but_no_write_tools() {
        // The web-enabled read-only profile (Research / deep research): web search +
        // fetch are added, but Edit/Write/Bash stay out — live-repo safety holds.
        let args =
            claude_session_args("", "sys", "sid", false, false, true, true, None, &[]);
        assert_eq!(tools_of(&args), "Read,Grep,Glob,WebSearch,WebFetch");
        // Bypass IS set so the (non-auto-approved) web tools are authorized in
        // non-interactive mode; the strict allowlist above keeps the run read-only.
        assert!(args.iter().any(|a| a == "bypassPermissions"));
    }

    #[test]
    fn claude_read_only_without_web_is_plan_toolset() {
        // Plan with web off: the original read-only toolset, no web, and NO bypass
        // (read tools are auto-approved; the prompt gate stays for plan).
        let args =
            claude_session_args("", "sys", "sid", false, false, true, false, None, &[]);
        assert_eq!(tools_of(&args), "Read,Grep,Glob");
        assert!(!args.iter().any(|a| a == "bypassPermissions"));
    }

    #[test]
    fn claude_write_session_ignores_web_flag() {
        // A write session is never web-gated here: even with web=true it gets the
        // full write toolset and no web tools (web is a read-only-profile concept).
        let args =
            claude_session_args("", "sys", "sid", false, false, false, true, None, &[]);
        assert_eq!(tools_of(&args), "Read,Grep,Glob,Edit,Write,Bash");
    }

    #[test]
    fn claude_forked_resume_adds_fork_session() {
        // A forked resume (the distill handoff): `--fork-session` branches to a new
        // throwaway session so the turn never appends to the original transcript.
        let args =
            claude_session_args("", "sys", "sid", true, true, true, true, None, &[]);
        assert!(args.iter().any(|a| a == "--fork-session"));
        assert!(args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn claude_unforked_resume_has_no_fork_session() {
        // A normal follow-up resume must NOT fork — it continues the real conversation.
        let args =
            claude_session_args("", "sys", "sid", true, false, true, true, None, &[]);
        assert!(!args.iter().any(|a| a == "--fork-session"));
        assert!(args.iter().any(|a| a == "--resume"));
    }

    #[test]
    fn claude_turn_one_never_forks() {
        // `--fork-session` only has meaning with `--resume`; a turn-1 start (resume
        // false) must never emit it, even if fork were somehow set.
        let args =
            claude_session_args("", "sys", "sid", false, true, true, true, None, &[]);
        assert!(!args.iter().any(|a| a == "--fork-session"));
        assert!(args.iter().any(|a| a == "--session-id"));
    }

    // --- review args: self-MCP wiring (mcp_self) -----------------------------

    /// The value following a flag in an arg vector, if present.
    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let i = args.iter().position(|a| a == flag)?;
        args.get(i + 1).map(String::as_str)
    }

    #[test]
    fn claude_session_grants_mcp_tools_when_attached() {
        let patterns = vec!["mcp__gitdesktop".to_string()];
        // Read-only (Plan) profile with self-MCP: no bypass, so the permission grant
        // is what actually makes the loaded server callable in headless `-p` mode.
        let plan = claude_session_args("", "sys", "sid", false, false, true, false, None, &patterns);
        assert!(!plan.iter().any(|a| a == "bypassPermissions"));
        assert_eq!(flag_value(&plan, "--allowedTools"), Some("mcp__gitdesktop"));

        // Write session with self-MCP: the grant is emitted ALONGSIDE bypass — it is
        // never gated on the bypass being absent.
        let write = claude_session_args("", "sys", "sid", false, false, false, false, None, &patterns);
        assert!(write.iter().any(|a| a == "bypassPermissions"));
        assert_eq!(flag_value(&write, "--allowedTools"), Some("mcp__gitdesktop"));

        // An empty mcp_tools slice grants nothing — the flag is absent.
        let plan_none = claude_session_args("", "sys", "sid", false, false, true, false, None, &[]);
        assert!(!plan_none.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn claude_review_without_mcp_is_unchanged() {
        // No self-MCP: no `--mcp-config`, plain repo-aware/diff-only toolset, and
        // `--strict-mcp-config` still present.
        let aware = claude_review_args("m", "sys", true, None, &[]);
        assert_eq!(tools_of(&aware), "Read,Grep,Glob");
        assert!(!aware.iter().any(|a| a == "--mcp-config"));
        assert!(aware.iter().any(|a| a == "--strict-mcp-config"));
        assert!(!aware.iter().any(|a| a == "--allowedTools"));

        let diff_only = claude_review_args("m", "sys", false, None, &[]);
        assert_eq!(tools_of(&diff_only), ""); // empty toolset for diff-only
        assert!(!diff_only.iter().any(|a| a == "--mcp-config"));
        assert!(!diff_only.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn claude_review_with_mcp_adds_config_and_tool_pattern() {
        let patterns = vec!["mcp__gitdesktop".to_string()];
        // Repo-aware: read tools PLUS the mcp pattern; config path wired.
        let aware = claude_review_args("m", "sys", true, Some("C:/cfg/r.json"), &patterns);
        assert_eq!(tools_of(&aware), "Read,Grep,Glob,mcp__gitdesktop");
        assert_eq!(flag_value(&aware, "--mcp-config"), Some("C:/cfg/r.json"));
        assert!(aware.iter().any(|a| a == "--strict-mcp-config"));
        // Permission is granted for exactly the self-server's tools, or a headless
        // `-p` review auto-denies every MCP call.
        assert_eq!(flag_value(&aware, "--allowedTools"), Some("mcp__gitdesktop"));

        // Diff-only: base toolset is empty, so the pattern stands alone (no leading
        // comma) — the server stays callable even without repo-aware read tools.
        let diff_only = claude_review_args("m", "sys", false, Some("C:/cfg/r.json"), &patterns);
        assert_eq!(tools_of(&diff_only), "mcp__gitdesktop");
        assert_eq!(flag_value(&diff_only, "--mcp-config"), Some("C:/cfg/r.json"));
        assert_eq!(flag_value(&diff_only, "--allowedTools"), Some("mcp__gitdesktop"));
    }

    #[test]
    fn claude_read_only_runs_load_user_settings_only() {
        // Every review and read-only session carries `--setting-sources user` right
        // after `--strict-mcp-config`, so the repository's own settings and hooks never
        // load; a write session keeps them.
        let pair = |args: &[String]| {
            let at = args.iter().position(|a| a == "--strict-mcp-config")?;
            Some(args.get(at + 1..at + 3)?.to_vec())
        };
        let user = Some(vec!["--setting-sources".to_string(), "user".to_string()]);
        for (tools, aware) in [("Read,Grep,Glob", true), ("", false)] {
            let args = claude_review_args("m", "sys", aware, None, &[]);
            assert_eq!(
                args,
                [
                    "-p",
                    "--system-prompt",
                    "sys",
                    "--output-format",
                    "stream-json",
                    "--include-partial-messages",
                    "--verbose",
                    "--tools",
                    tools,
                    "--strict-mcp-config",
                    "--setting-sources",
                    "user",
                    "--no-session-persistence",
                    "--model",
                    "m",
                ]
            );
            let patterns = vec!["mcp__gitdesktop".to_string()];
            let with_mcp = claude_review_args("m", "sys", aware, Some("C:/cfg/r.json"), &patterns);
            assert_eq!(pair(&with_mcp), user, "{with_mcp:?}");
        }
        for (resume, web) in [(false, false), (false, true), (true, false), (true, true)] {
            let args = claude_session_args("", "sys", "sid", resume, false, true, web, None, &[]);
            assert_eq!(pair(&args), user, "{args:?}");
            let count = args.iter().filter(|a| *a == "--setting-sources").count();
            assert_eq!(count, 1, "{args:?}");
            let write = claude_session_args("", "sys", "sid", resume, false, false, web, None, &[]);
            assert!(!write.iter().any(|a| a == "--setting-sources"), "{write:?}");
        }
    }

    #[test]
    fn copilot_review_without_mcp_denies_write_and_shell() {
        // No self-MCP: no `--additional-mcp-config`. Repo-aware carries the
        // allow-all/deny pair + `--disable-builtin-mcps`.
        let aware = copilot_review_args("m", "prompt", true, "", None);
        assert_eq!(
            aware,
            [
                "-p",
                "prompt",
                "--output-format",
                "json",
                "--no-color",
                "--allow-all-tools",
                "--deny-tool=write",
                "--deny-tool=shell",
                "--disable-builtin-mcps",
                "--model",
                "m",
            ]
        );

        // Diff-only denies write + shell even though it never enables tools, so a
        // user-level allow-all can't widen it.
        let diff_only = copilot_review_args("m", "prompt", false, "", None);
        assert!(!diff_only.iter().any(|a| a == "--additional-mcp-config"));
        assert!(!diff_only.iter().any(|a| a == "--allow-all-tools"));
        assert!(diff_only.iter().any(|a| a == "--deny-tool=write"));
        assert!(diff_only.iter().any(|a| a == "--deny-tool=shell"));
        assert!(!diff_only.iter().any(|a| a == "--disable-builtin-mcps"));
    }

    #[test]
    fn copilot_review_with_mcp_adds_additional_config_flag() {
        // Repo-aware + self-MCP: the `@file` additional-config flag is present, and the
        // existing tool-permission pair + builtin-MCP disable are retained.
        let aware = copilot_review_args("m", "prompt", true, "", Some("C:/cfg/r.copilot.json"));
        assert_eq!(
            flag_value(&aware, "--additional-mcp-config"),
            Some("@C:/cfg/r.copilot.json")
        );
        assert!(aware.iter().any(|a| a == "--disable-builtin-mcps"));

        // Diff-only + self-MCP: the flag is present AND the tools are enabled (so the
        // server is reachable) even though it's not repo-aware; no builtin-MCP disable.
        let diff_only = copilot_review_args("m", "prompt", false, "", Some("C:/cfg/r.copilot.json"));
        assert_eq!(
            flag_value(&diff_only, "--additional-mcp-config"),
            Some("@C:/cfg/r.copilot.json")
        );
        assert!(diff_only.iter().any(|a| a == "--allow-all-tools"));
        assert!(diff_only.iter().any(|a| a == "--deny-tool=write"));
        assert!(!diff_only.iter().any(|a| a == "--disable-builtin-mcps"));
    }

    // --- opencode run directory ----------------------------------------------

    #[test]
    fn run_dir_is_the_mount_point_in_a_container_and_the_host_path_otherwise() {
        // Both call sites (Copilot `--add-dir`, opencode `--dir`) hand the CLI a path
        // it can actually resolve, so the container arm must not leak the host path.
        assert_eq!(run_dir(true, "C:/wt/gd-session-1"), "/workspace");
        assert_eq!(run_dir(false, "C:/wt/gd-session-1"), "C:/wt/gd-session-1");
    }

    #[test]
    fn opencode_session_pins_the_run_directory_on_every_turn() {
        // opencode reads `PWD` before its real cwd, so the directory has to be in argv
        // on turn 1 and on resume alike.
        let turn_one =
            opencode_session_args("m", "", false, "", false, false, "C:/wt/gd-session-1");
        assert_eq!(flag_value(&turn_one, "--dir"), Some("C:/wt/gd-session-1"));
        let resumed =
            opencode_session_args("m", "ses_abc", true, "", false, false, "C:/wt/gd-session-1");
        assert_eq!(flag_value(&resumed, "--dir"), Some("C:/wt/gd-session-1"));
        assert!(resumed.iter().any(|a| a == "--session"));
    }

    #[test]
    fn opencode_session_dir_is_the_container_mount_point() {
        // The builder forwards whatever `dir` it's handed verbatim into `--dir`; the
        // container-vs-host choice is `run_dir`'s job, asserted separately.
        let args = opencode_session_args("m", "", false, "", true, true, "/workspace");
        assert_eq!(flag_value(&args, "--dir"), Some("/workspace"));
    }

    #[test]
    fn opencode_review_pins_the_repo_directory() {
        let aware = opencode_review_args("m", true, "", "C:/repos/gd");
        assert_eq!(flag_value(&aware, "--dir"), Some("C:/repos/gd"));
        // The diff-only arm still resolves its root via `--dir`; its pin is tested in
        // `review_env_pins_every_mode`.
        let diff_only = opencode_review_args("m", false, "", "C:/repos/gd");
        assert_eq!(flag_value(&diff_only, "--dir"), Some("C:/repos/gd"));
    }

    // --- opencode / Copilot read-only pins -----------------------------------

    const DENY_TAIL: &str = r#""skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#;
    const PIN_HEAD: &str = r#"{"*":"deny","*_*":"deny","#;
    /// Every DiffOnly pin without servers, whatever the mirror.
    const DIFF_ONLY_PIN: &str = r#"{"*":"deny","*_*":"deny","read":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"read *":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"grep":"deny","glob":"deny","list":"deny","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#;
    const NO_MIRROR: OpencodeReadMirror = OpencodeReadMirror {
        star_denied: false,
        allows: Vec::new(),
        denies: Vec::new(),
        denied_tools: Vec::new(),
    };

    /// A read mirror from its three sets.
    fn mirror(star_denied: bool, allows: &[&str], denies: &[&str]) -> OpencodeReadMirror {
        let owned = |set: &[&str]| set.iter().map(|p| p.to_string()).collect();
        OpencodeReadMirror {
            star_denied,
            allows: owned(allows),
            denies: owned(denies),
            denied_tools: Vec::new(),
        }
    }

    /// `found` with `tools` denied outright.
    fn closing(mut found: OpencodeReadMirror, tools: &[&'static str]) -> OpencodeReadMirror {
        found.denied_tools = tools.to_vec();
        found
    }
    const DENIED_BUILTINS: [&str; 14] = [
        "skill",
        "todowrite",
        "question",
        "edit",
        "bash",
        "webfetch",
        "websearch",
        "codesearch",
        "lsp",
        "task",
        "external_directory",
        "doom_loop",
        "plan_enter",
        "plan_exit",
    ];

    #[test]
    fn opencode_permission_pins_are_exact() {
        assert_eq!(
            opencode_permission_json(OpencodePin::DiffOnly, &[], &NO_MIRROR),
            r#"{"*":"deny","*_*":"deny","read":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"read *":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"grep":"deny","glob":"deny","list":"deny","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#
        );
        assert_eq!(
            opencode_permission_json(OpencodePin::ReadOnly, &[], &NO_MIRROR),
            r#"{"*":"deny","*_*":"deny","read":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"},"read *":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"},"grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#
        );
        for pin in [OpencodePin::DiffOnly, OpencodePin::ReadOnly] {
            let bare = opencode_permission_json(pin, &[], &NO_MIRROR);
            let rest = bare.strip_prefix(PIN_HEAD).unwrap();
            // Server allows, each with its alias, sit right after `*_*`, in input
            // order, sanitized.
            assert_eq!(
                opencode_permission_json(pin, &["gitdesktop"], &NO_MIRROR),
                format!(r#"{PIN_HEAD}"gitdesktop_*":"allow","gitdesktop_?*":"allow",{rest}"#)
            );
            assert_eq!(
                opencode_permission_json(pin, &["a.b", "x"], &NO_MIRROR),
                format!(
                    r#"{PIN_HEAD}"a_b_*":"allow","a_b_?*":"allow","x_*":"allow","x_?*":"allow",{rest}"#
                )
            );
            for servers in [&[][..], &["gitdesktop"][..], &["a.b", "x"][..]] {
                let out = opencode_permission_json(pin, servers, &NO_MIRROR);
                assert!(
                    serde_json::from_str::<serde_json::Value>(&out).is_ok(),
                    "{out}"
                );
                assert!(out.starts_with(PIN_HEAD), "{out}");
                assert!(out.ends_with(DENY_TAIL), "{out}");
            }
        }
    }

    /// The `read` rule set of a pin, asserting `read *` carries the same one.
    fn read_rule_set(out: &str) -> &str {
        let start = out.find(r#""read":"#).unwrap() + r#""read":"#.len();
        let end = out.find(r#","read *":"#).unwrap();
        let rules = &out[start..end];
        assert!(
            out.contains(&format!(r#""read *":{rules},"grep""#)),
            "{out}"
        );
        rules
    }

    /// The read rule set every DiffOnly pin carries, whatever the mirror.
    const DENY_ALL_READS: &str =
        r#"{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#;

    /// Asserts that a DiffOnly pin under `found`, with or without a server, denies every
    /// read path in both read rule sets and carries the fixed set.
    fn assert_diff_only_reads_nothing(found: &OpencodeReadMirror) {
        for servers in [&[][..], &["gitdesktop"][..]] {
            let out = opencode_permission_json(OpencodePin::DiffOnly, servers, found);
            for rules in read_rule_sets(&out) {
                for path in [
                    "src/main.rs",
                    "README.md",
                    ".env",
                    ".env.example",
                    "x.env.example",
                    "2024",
                    "C:/repo/a.rs",
                ] {
                    assert_eq!(read_verdict(&rules, path), "deny", "{path}: {out}");
                }
            }
            assert_eq!(read_rule_set(&out), DENY_ALL_READS, "{found:?}");
        }
    }

    /// Both read rule sets of `out` in emitted order, `read` first.
    fn read_rule_sets(out: &str) -> [Vec<(String, ConfigValue)>; 2] {
        let Ok(ConfigValue::Object(top)) = serde_json::from_str::<ConfigValue>(out) else {
            panic!("{out}");
        };
        ["read", "read *"].map(|read| match top.iter().find(|(key, _)| key == read) {
            Some((_, ConfigValue::Object(rules))) => rules.clone(),
            _ => panic!("no {read} rule set: {out}"),
        })
    }

    /// The action of the last rule in `rules` matching `path`, as opencode resolves it.
    fn read_verdict<'a>(rules: &'a [(String, ConfigValue)], path: &str) -> &'a str {
        match rules
            .iter()
            .rev()
            .find(|(key, _)| wildcard_matches(key, path))
        {
            Some((_, ConfigValue::String(action))) => action.as_str(),
            other => panic!("{path}: {other:?}"),
        }
    }

    /// Asserts that in both read rule sets every key spelling one of `found`'s denies
    /// (index-shaped ones respelled) is a `deny` after every `allow` rule. `*` is
    /// exempt: it stays first, denied through its own value. Also checks the DiffOnly
    /// pin under `found` reads nothing.
    fn assert_denies_follow_allows(out: &str, found: &OpencodeReadMirror) {
        assert_diff_only_reads_nothing(found);
        let denied: Vec<String> = found
            .denies
            .iter()
            .map(|pattern| match js_array_index(pattern) {
                Some(_) => format!("{pattern} *"),
                None => pattern.clone(),
            })
            .collect();
        for rules in read_rule_sets(out) {
            let is = |value: &ConfigValue, action: &str| matches!(value, ConfigValue::String(a) if a == action);
            let last_allow = rules.iter().rposition(|(_, value)| is(value, "allow"));
            for (index, (key, value)) in rules.iter().enumerate() {
                if key != "*" && denied.contains(key) {
                    assert!(is(value, "deny"), "{key} not denied: {out}");
                    assert!(
                        last_allow.is_none_or(|at| index > at),
                        "{key} precedes an allow: {out}"
                    );
                }
            }
        }
    }

    #[test]
    fn opencode_permission_pins_mirror_the_read_allows_before_the_env_carve_out() {
        // An allow-list config plus a deny: `*` denied, the allow, the carve-out with
        // `*.env.example` closed (the user's `*` deny covers it), then the deny.
        let list = mirror(true, &["src/**"], &["*.pem"]);
        assert_eq!(
            opencode_permission_json(OpencodePin::DiffOnly, &[], &list),
            DIFF_ONLY_PIN
        );
        assert_eq!(
            opencode_permission_json(OpencodePin::ReadOnly, &[], &list),
            r#"{"*":"deny","*_*":"deny","read":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny","*.pem":"deny"},"read *":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny","*.pem":"deny"},"grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#
        );
        for pin in [OpencodePin::DiffOnly, OpencodePin::ReadOnly] {
            assert_denies_follow_allows(&opencode_permission_json(pin, &[], &list), &list);
        }
        for (found, want) in [
            // A pattern both allowed and denied is denied, after the carve-out.
            (
                mirror(false, &["src/**", "secret/**", "src/**"], &["secret/**"]),
                r#"{"*":"allow","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow","secret/**":"deny"}"#,
            ),
            // An allow equal to a carve-out key is dropped, so the carve-out stands; a
            // carve-out key the user denies moves to the deny tail.
            (
                mirror(
                    false,
                    &["*.env", "*.env.*", "*.env.example", "*"],
                    &["*.env.example"],
                ),
                r#"{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#,
            ),
            (
                mirror(false, &["*.env.example"], &[]),
                r#"{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"}"#,
            ),
            // `*` denied with no allows: every read rule present, and the last one isn't
            // a bare `*` deny, which would disable the tool.
            (
                mirror(true, &[], &[]),
                r#"{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#,
            ),
        ] {
            for pin in [OpencodePin::DiffOnly, OpencodePin::ReadOnly] {
                let out = opencode_permission_json(pin, &["gitdesktop"], &found);
                let want = match pin {
                    OpencodePin::DiffOnly => DENY_ALL_READS,
                    OpencodePin::ReadOnly => want,
                };
                assert_eq!(read_rule_set(&out), want, "{found:?}");
                assert_eq!(pin_alias_violations(&out), Vec::<String>::new(), "{out}");
                assert_denies_follow_allows(&out, &found);
            }
        }
    }

    #[test]
    fn opencode_permission_pins_mirror_the_read_denies_after_the_env_carve_out() {
        let pem = mirror(false, &[], &["*.pem"]);
        assert_eq!(
            opencode_permission_json(OpencodePin::DiffOnly, &[], &pem),
            DIFF_ONLY_PIN
        );
        assert_eq!(
            opencode_permission_json(OpencodePin::ReadOnly, &[], &pem),
            r#"{"*":"deny","*_*":"deny","read":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow","*.pem":"deny"},"read *":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow","*.pem":"deny"},"grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#
        );
        for pin in [OpencodePin::DiffOnly, OpencodePin::ReadOnly] {
            assert_denies_follow_allows(&opencode_permission_json(pin, &[], &pem), &pem);
        }
        // A carve-out key the user denies leaves the carve-out for the deny tail, so
        // it follows `*.env.example`'s allow as plain opencode's user rules do; `*`
        // stays first and the last rule is never a bare `*` deny. (allows, denies,
        // ReadOnly read rules, the verdict for `x.env.example` and `.env.example`)
        for (allows, denies, want, example) in [
            (
                &[][..],
                &["*.env.*"][..],
                r#"{"*":"allow","*.env":"deny","*.env.example":"allow","*.env.*":"deny"}"#,
                "deny",
            ),
            (
                &["src/**"][..],
                &["*.env.*"][..],
                r#"{"*":"allow","src/**":"allow","*.env":"deny","*.env.example":"allow","*.env.*":"deny"}"#,
                "deny",
            ),
            (
                &[][..],
                &["*.env"][..],
                r#"{"*":"allow","*.env.*":"deny","*.env.example":"allow","*.env":"deny"}"#,
                "allow",
            ),
            (
                &[][..],
                &["*.env.example"][..],
                r#"{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#,
                "deny",
            ),
            (
                &[][..],
                &["*"][..],
                r#"{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#,
                "deny",
            ),
            (
                &[][..],
                &["*", "*.env.*"][..],
                r#"{"*":"deny","*.env":"deny","*.env.example":"deny","*.env.*":"deny"}"#,
                "deny",
            ),
            (
                &[][..],
                &["*.env.example", "*.env.*", "*.env", "*"][..],
                r#"{"*":"deny","*.env.example":"deny","*.env.*":"deny","*.env":"deny"}"#,
                "deny",
            ),
        ] {
            let found = mirror(false, allows, denies);
            let out = opencode_permission_json(OpencodePin::ReadOnly, &["gitdesktop"], &found);
            assert_eq!(read_rule_set(&out), want, "{found:?}");
            assert_eq!(pin_alias_violations(&out), Vec::<String>::new(), "{out}");
            assert_denies_follow_allows(&out, &found);
            for rules in read_rule_sets(&out) {
                for path in ["x.env.example", ".env.example"] {
                    assert_eq!(read_verdict(&rules, path), example, "{path}: {out}");
                }
                assert_eq!(read_verdict(&rules, "x.env.local"), "deny", "{out}");
                assert_ne!(
                    rules.last().map(|(key, _)| key.as_str()),
                    Some("*"),
                    "{out}"
                );
            }
        }
        // Arbitrary text is escaped as a JSON string; a repeat or a pin key's own
        // spelling adds no key, and the carve-out keys the user denies follow the
        // other denies in the user's order.
        let uni = "\u{43a}\u{43b}\u{44e}\u{447}.pem";
        let denies = [
            "*.pem",
            r#"a"b\c"#,
            uni,
            "*.env.example",
            "*",
            "*.env",
            "*.pem",
        ];
        let denies = mirror(false, &[], &denies);
        let rules = format!(
            r#"{{"*":"deny","*.env.*":"deny","*.pem":"deny","a\"b\\c":"deny","{uni}":"deny","*.env.example":"deny","*.env":"deny"}}"#
        );
        let out = opencode_permission_json(OpencodePin::ReadOnly, &[], &denies);
        let tools = r#""grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","#;
        assert_eq!(
            out,
            format!(r#"{PIN_HEAD}"read":{rules},"read *":{rules},{tools}{DENY_TAIL}"#)
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["read *"][r#"a"b\c"#], "deny");
        assert_eq!(v["read *"][uni], "deny");
        let out = opencode_permission_json(OpencodePin::ReadOnly, &["gitdesktop"], &denies);
        assert_eq!(pin_alias_violations(&out), Vec::<String>::new(), "{out}");
        assert_denies_follow_allows(&out, &denies);
        for read in [r#""read":{"#, r#""read *":{"#] {
            // No pattern here holds a `}`, so the first one closes the rule set.
            let start = out.find(read).unwrap() + read.len();
            let body = &out[start..start + out[start..].find('}').unwrap()];
            let at = |k: &str| body.find(&format!(r#""{k}":"#)).unwrap();
            assert!(at("*.env.*") < at("*.pem"), "{body}");
            assert!(at(uni) < at("*.env.example"), "{body}");
            assert!(at("*.env.example") < at("*.env"), "{body}");
            assert!(body.ends_with(r#""*.env":"deny""#), "{body}");
        }
    }

    /// A temp tree of opencode config files the resolver seam reads, and the env it
    /// sees: nothing outside the tree, and no process env.
    struct ConfigFixture {
        root: tempfile::TempDir,
        env: std::collections::HashMap<&'static str, String>,
    }

    impl ConfigFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let mut env = std::collections::HashMap::new();
            let managed = root.path().join("managed").display().to_string();
            env.insert("OPENCODE_TEST_MANAGED_CONFIG_DIR", managed);
            Self { root, env }
        }

        fn home(&self) -> PathBuf {
            self.root.path().join("home")
        }

        fn write(&self, rel: &str, body: &str) -> PathBuf {
            let path = self.root.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
            path
        }

        /// Writes a config whose `permission.read` denies `pattern` alone.
        fn deny(&self, rel: &str, pattern: &str) -> PathBuf {
            let body = format!(r#"{{"permission":{{"read":{{"{pattern}":"deny"}}}}}}"#);
            self.write(rel, &body)
        }

        /// Points `key` at a path inside the fixture.
        fn set_path(&mut self, key: &'static str, rel: &str) {
            let path = self.root.path().join(rel).display().to_string();
            self.env.insert(key, path);
        }

        fn holds_all(&self, paths: &[PathBuf]) -> bool {
            paths.iter().all(|p| p.starts_with(self.root.path()))
        }

        /// The mirror and every path the seam asked to read; the run's `--dir` is
        /// `<root>/run`.
        fn resolve(&self, config_path: Option<&str>) -> (OpencodeReadMirror, Vec<PathBuf>) {
            let asked = std::cell::RefCell::new(Vec::new());
            let env = |key: &str| self.env.get(key).cloned();
            let read = |path: &Path| {
                asked.borrow_mut().push(path.to_path_buf());
                // Never touch a path outside the fixture, even when asked.
                if !path.starts_with(self.root.path()) {
                    return ConfigRead::Missing;
                }
                read_config_file(path)
            };
            let home = self.home();
            let dir = self.root.path().join("run");
            let found = opencode_read_mirror_with(config_path, &dir, &env, Some(&home), &read);
            (found, asked.into_inner())
        }
    }

    #[test]
    fn opencode_read_mirror_reads_every_local_source() {
        let mut fx = ConfigFixture::new();
        // Nothing on disk: nothing mirrored, and every read stays in the fixture.
        let (found, asked) = fx.resolve(None);
        assert_eq!(found, NO_MIRROR);
        assert!(fx.holds_all(&asked), "{asked:?}");
        fx.write(
            "home/.config/opencode/opencode.json",
            r#"{"permission":{"read":{"*":"allow","*.pem":"deny","*.key":"ask","*.md":"allow"}}}"#,
        );
        fx.write(
            "home/.config/opencode/opencode.jsonc",
            "{\n  // a comment with \"quotes\" and a , before }\n  \"permission\": {\n    /* block */ \"read\": {\"secret//x\": \"deny\", \"a/*b\": \"ask\",},\n  },\n}\n",
        );
        let string_form = r#"{"permission":{"read":"deny"}}"#;
        fx.write("home/.config/opencode/config.json", string_form);
        fx.deny("home/.opencode/opencode.json", "*.p12");
        fx.deny("managed/opencode.jsonc", "*.kdbx");
        // Rules keep source order; config.json's string-form `read` is replaced by
        // opencode.json's object (a non-object never merges), and `*` stays allowed.
        let want = ["*.pem", "*.key", "secret//x", "a/*b", "*.p12", "*.kdbx"];
        assert_eq!(fx.resolve(None).0, mirror(false, &["*.md"], &want));

        // XDG_CONFIG_HOME replaces `<home>/.config`.
        fx.deny("xdg/opencode/opencode.json", "*.xdg");
        fx.set_path("XDG_CONFIG_HOME", "xdg");
        assert_eq!(fx.resolve(None).0.denies, ["*.xdg", "*.p12", "*.kdbx"]);

        // OPENCODE_CONFIG: the app's path outranks an inherited one; the inherited one
        // loads when the app passes none.
        let app = fx.deny("app.json", "*.app").display().to_string();
        fx.deny("elsewhere/user.json", "*.usr");
        fx.set_path("OPENCODE_CONFIG", "elsewhere/user.json");
        let want = ["*.xdg", "*.app", "*.p12", "*.kdbx"];
        assert_eq!(fx.resolve(Some(&app)).0.denies, want);
        assert_eq!(
            fx.resolve(None).0.denies,
            ["*.xdg", "*.usr", "*.p12", "*.kdbx"]
        );

        // OPENCODE_CONFIG_DIR and OPENCODE_CONFIG_CONTENT; an empty variable is unset.
        let trailing = r#"{"permission":{"read":{"*.dir":"deny",},},}"#;
        fx.write("cfgdir/opencode.jsonc", trailing);
        fx.set_path("OPENCODE_CONFIG_DIR", "cfgdir");
        let inline = r#"{"permission":{"read":{"*.inline":"ask"}}}"#;
        fx.env.insert("OPENCODE_CONFIG_CONTENT", inline.into());
        fx.env.insert("OPENCODE_CONFIG", String::new());
        let want = ["*.xdg", "*.p12", "*.dir", "*.inline", "*.kdbx"];
        assert_eq!(fx.resolve(None).0.denies, want);

        // Relative paths, the managed dir's included, resolve against the run's spawn
        // cwd (`dir`); an empty OPENCODE_TEST_HOME is kept (opencode tests it with `??`).
        fx.deny("run/rel/opencode/opencode.json", "*.rel");
        fx.env.insert("XDG_CONFIG_HOME", "rel".into());
        fx.deny("run/.opencode/opencode.jsonc", "*.th");
        fx.env.insert("OPENCODE_TEST_HOME", String::new());
        fx.deny("run/mgd/opencode.json", "*.mgd");
        fx.env
            .insert("OPENCODE_TEST_MANAGED_CONFIG_DIR", "mgd".into());
        fx.env.remove("OPENCODE_CONFIG_DIR");
        fx.env.remove("OPENCODE_CONFIG_CONTENT");
        let (found, asked) = fx.resolve(None);
        assert_eq!(found.denies, ["*.rel", "*.th", "*.mgd"]);
        assert!(fx.holds_all(&asked), "{asked:?}");

        // A drive-relative path on another drive than `dir`'s names that drive's cwd on
        // Windows, so it is never read there; elsewhere it is an ordinary relative
        // path under `dir`.
        let root = fx.root.path().display().to_string();
        let other = if root.starts_with(['Q', 'q']) {
            "R"
        } else {
            "Q"
        };
        fx.env.insert("XDG_CONFIG_HOME", format!("{other}:rel"));
        let (_, asked) = fx.resolve(None);
        assert!(fx.holds_all(&asked), "{asked:?}");
        assert_eq!(asked.len(), if cfg!(windows) { 4 } else { 7 }, "{asked:?}");
        // On `dir`'s own drive it resolves against `dir`, as the child's cwd.
        if cfg!(windows) {
            let drive = &root[..1].to_ascii_lowercase();
            fx.env.insert("XDG_CONFIG_HOME", format!("{drive}:rel"));
            assert_eq!(fx.resolve(None).0.denies, ["*.rel", "*.th", "*.mgd"]);
        }
    }

    #[test]
    fn opencode_read_mirror_dedupes_the_config_dir_as_opencode_does() {
        let mut fx = ConfigFixture::new();
        let home = fx.home();
        let global = home.join(".config").join("opencode");
        fx.write(
            "home/.config/opencode/opencode.json",
            r#"{"permission":{"read":{"*":"deny"}}}"#,
        );
        let app = fx.write("app.json", r#"{"permission":{"read":{"*":"allow"}}}"#);
        let app = app.display().to_string();
        let allow = r#"{"permission":{"read":{"*":"allow"}}}"#;
        fx.write("home/.opencode/opencode.json", allow);
        // Equal to the global dir: its pair reloads right after OPENCODE_CONFIG, before
        // `<home>/.opencode`, whose `*` allow is then the last `*` rule.
        fx.env
            .insert("OPENCODE_CONFIG_DIR", global.display().to_string());
        let (found, asked) = fx.resolve(Some(&app));
        assert!(!found.star_denied, "{asked:?}");
        let pair = [global.join("opencode.json"), global.join("opencode.jsonc")];
        let dot = home.join(".opencode").join("opencode.json");
        assert_eq!(asked[4..6], pair);
        assert_eq!(asked[6], dot);
        assert_eq!(asked.iter().filter(|p| **p == pair[0]).count(), 2);
        // Spelled another way it is another string, loaded at its own slot, last.
        let spelled = format!("{}{}", global.display(), std::path::MAIN_SEPARATOR);
        fx.env.insert("OPENCODE_CONFIG_DIR", spelled);
        let (found, asked) = fx.resolve(Some(&app));
        assert!(found.star_denied, "{asked:?}");
        assert_eq!(asked[4], dot);
        assert_eq!(asked[6..8], pair);
        // Equal to `<home>/.opencode`: loaded once.
        let dot_dir = home.join(".opencode");
        fx.env
            .insert("OPENCODE_CONFIG_DIR", dot_dir.display().to_string());
        let (_, asked) = fx.resolve(None);
        assert_eq!(asked.iter().filter(|p| **p == dot).count(), 1, "{asked:?}");
        assert_eq!(asked.len(), 7, "{asked:?}");
        fx.env.remove("OPENCODE_CONFIG_DIR");
        assert_eq!(fx.resolve(None).1.len(), 7);
        // A test home spells `<home>/.opencode` from itself.
        fx.set_path("OPENCODE_TEST_HOME", "th");
        let th = fx.root.path().join("th").join(".opencode");
        fx.env
            .insert("OPENCODE_CONFIG_DIR", th.display().to_string());
        let (_, asked) = fx.resolve(None);
        assert_eq!(asked.len(), 7, "{asked:?}");
    }

    #[test]
    fn node_path_join_spells_paths_as_node_does() {
        for (parts, windows, want) in [
            (&["/a", "opencode"][..], false, Some("/a/opencode")),
            (
                &["/a/", ".config", "opencode"][..],
                false,
                Some("/a/.config/opencode"),
            ),
            (&["/a//b/./c/..", "x"][..], false, Some("/a/b/x")),
            (&["a", "../..", "x"][..], false, Some("../x")),
            (&["/..", "x"][..], false, Some("/x")),
            (&["", ".opencode"][..], false, Some(".opencode")),
            (&["", ""][..], false, Some(".")),
            (&["a\\b", "x"][..], false, Some("a\\b/x")),
            (
                &["C:/u/x/", "opencode"][..],
                true,
                Some("C:\\u\\x\\opencode"),
            ),
            (
                &["C:\\u", ".config", "opencode"][..],
                true,
                Some("C:\\u\\.config\\opencode"),
            ),
            (&["c:rel", "opencode"][..], true, Some("c:rel\\opencode")),
            (&["\\u\\..\\..", "x"][..], true, Some("\\x")),
            (&["rel", "opencode"][..], true, Some("rel\\opencode")),
            (&["\\\\srv\\share", "opencode"][..], true, None),
            (&["//srv/share", "opencode"][..], true, None),
        ] {
            assert_eq!(
                node_path_join(parts, windows).as_deref(),
                want,
                "{parts:?} {windows}"
            );
        }
    }

    #[test]
    fn opencode_child_env_reads_the_spawns_edits_over_the_apps_env() {
        let inherited = |key: &str| {
            let value = match key {
                "NO_COLOR" | "OPENCODE_CONFIG" | "PWD" | "APPDIR" | "KEEP" => "app",
                _ => return None,
            };
            Some(std::ffi::OsString::from(value))
        };
        let overrides = [("APPDIR", None), ("LD_LIBRARY_PATH", Some("/lib".into()))];
        for fold in [false, true] {
            let env = opencode_child_env(
                Some("/cfg.json"),
                &overrides,
                Some("/bin"),
                fold,
                &inherited,
            );
            // A set edit wins; an unset edit reads None; the rest is the app's.
            assert_eq!(env("NO_COLOR").as_deref(), Some("1"));
            assert_eq!(env("CLICOLOR").as_deref(), Some("0"));
            assert_eq!(env("OPENCODE_CONFIG").as_deref(), Some("/cfg.json"));
            assert_eq!(env("OPENCODE_DISABLE_MODELS_FETCH").as_deref(), Some("1"));
            assert_eq!(env("LD_LIBRARY_PATH").as_deref(), Some("/lib"));
            assert_eq!(env("PATH").as_deref(), Some("/bin"));
            assert_eq!(env(SHELL_PATH_MERGED_MARKER).as_deref(), Some("/bin"));
            assert_eq!(env("PWD"), None);
            assert_eq!(env("APPDIR"), None);
            assert_eq!(env("KEEP").as_deref(), Some("app"));
            assert_eq!(env("UNSET"), None);
            // Windows compares names case-folded: an edit then covers every spelling.
            let want = if fold { Some("1") } else { None };
            assert_eq!(env("no_color").as_deref(), want);
            assert_eq!(env("pwd"), None);
        }
        // Without a config path or a merged PATH, those read the app's env.
        let env = opencode_child_env(None, &[], None, false, &inherited);
        assert_eq!(env("OPENCODE_CONFIG").as_deref(), Some("app"));
        assert_eq!(env("PATH"), None);
        // A value that isn't valid Unicode decodes lossily: still set, so its slot
        // never falls back (a home stays taken).
        #[cfg(unix)]
        let odd: std::ffi::OsString =
            std::os::unix::ffi::OsStringExt::from_vec(b"/h\xff".to_vec());
        #[cfg(windows)]
        let odd: std::ffi::OsString =
            std::os::windows::ffi::OsStringExt::from_wide(&[0x43, 0x3a, 0xd800]);
        let odd_env = move |key: &str| (key == "HOME" || key == "USERPROFILE").then(|| odd.clone());
        let env = opencode_child_env(None, &[], None, false, &odd_env);
        let lossy = env("HOME").unwrap();
        assert!(lossy.ends_with('\u{fffd}'), "{lossy}");
        let os = || Some(PathBuf::from("/os"));
        for windows in [false, true] {
            assert_eq!(
                opencode_home(&env, windows, &os),
                Some(PathBuf::from(&lossy))
            );
        }
    }

    #[test]
    fn opencode_read_mirror_follows_opencodes_loader() {
        let mut fx = ConfigFixture::new();
        let global = "home/.config/opencode/opencode.json";
        // Every permission key matching `read` mirrors, in source order: a string value
        // is a `*` rule, so `rea*`'s deny is the last `*` rule and kills `c`'s allow.
        // Keys that don't match (`re`, `edit`) don't mirror.
        fx.write(
            global,
            r#"{"permission":{"*":{"a":"deny"},"r*":{"b":"ask"},"read*":{"c":"allow"},"READ":{"*":"allow","d":"deny"},"read *":{"g":"deny"},"re":{"e":"deny"},"rea*":"deny","edit":{"f":"deny"}}}"#,
        );
        assert_eq!(fx.resolve(None).0, mirror(true, &[], &["a", "b", "d", "g"]));

        // `{env:NAME}` substitutes before the parse: set, unset and empty.
        fx.env.insert("GD_PAT", "*.secret".into());
        fx.env.insert("GD_EMPTY", String::new());
        fx.write(
            global,
            r#"{"permission":{"read":{"{env:GD_PAT}":"deny","x{env:GD_UNSET}y":"deny","p{env:GD_EMPTY}q":"ask","{env:}":"deny"}}}"#,
        );
        let want = ["*.secret", "xy", "pq", "{env:}"];
        assert_eq!(fx.resolve(None).0, mirror(false, &[], &want));

        // A `//` comment ends at a bare CR too.
        fx.write(
            global,
            "{\"permission\": { // c\r\"read\": {\"*.cr\": \"deny\"}}}",
        );
        assert_eq!(fx.resolve(None).0.denies, ["*.cr"]);

        // Non-UTF-8 bytes decode lossily, as opencode's decoder does.
        let path = fx.root.path().join(global);
        std::fs::write(
            &path,
            b"{\"permission\":{\"read\":{\"*.bin\":\"deny\"}},\"x\":\"\xff\"}",
        )
        .unwrap();
        assert_eq!(fx.resolve(None).0.denies, ["*.bin"]);

        // A file at the cap is read; one byte over is skipped.
        let head = r#"{"permission":{"read":{"*.big":"deny"}},"pad":""#;
        let pad = "x".repeat(OPENCODE_CONFIG_CAP - head.len() - 2);
        fx.write(global, &format!("{head}{pad}\"}}"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            OPENCODE_CONFIG_CAP as u64
        );
        assert_eq!(fx.resolve(None).0.denies, ["*.big"]);
        fx.write(global, &format!("{head}{pad}x\"}}"));
        assert_eq!(read_config_file(&path), ConfigRead::TooLarge);
        assert_eq!(fx.resolve(None).0, NO_MIRROR);
        // A directory reads as missing.
        assert_eq!(read_config_file(fx.root.path()), ConfigRead::Missing);

        // An inherited OPENCODE_PERMISSION mirrors through the same key walk; garbage
        // or a non-object contributes nothing.
        fx.write(global, "{}");
        let inherited = r#"{"r*":{"*":"ask"},"read":{"*.inh":"deny","ok/**":"allow"}}"#;
        fx.env.insert("OPENCODE_PERMISSION", inherited.into());
        assert_eq!(fx.resolve(None).0, mirror(true, &["ok/**"], &["*.inh"]));
        for garbage in [r#"{"read":{"*.inh":"deny"},}"#, r#""deny""#, "{"] {
            fx.env.insert("OPENCODE_PERMISSION", garbage.into());
            assert_eq!(fx.resolve(None).0, NO_MIRROR, "{garbage}");
        }
    }

    #[test]
    fn opencode_read_mirror_replays_opencodes_order() {
        let mut fx = ConfigFixture::new();
        let global = "home/.config/opencode/opencode.json";
        let managed = "managed/opencode.json";
        let star = mirror(true, &[], &[]);
        // (global, managed, mirror): one source's own order, then the merge across two.
        for (global_body, managed_body, want) in [
            // A repeated key keeps its first position and takes its last value.
            (
                r#"{"permission":{"read":{"x":"deny","*":"deny","y":"allow","x":"allow"}}}"#,
                "{}",
                mirror(true, &["y"], &[]),
            ),
            // Array-index keys come first, as in any JS object.
            (
                r#"{"permission":{"read":{"*":"deny","b":"allow","1":"allow"}}}"#,
                "{}",
                mirror(true, &["b"], &[]),
            ),
            // A later layer's value keeps the earlier position, behind its `*` deny.
            (
                r#"{"permission":{"read":{"docs/**":"deny","*":"deny"}}}"#,
                r#"{"permission":{"read":{"docs/**":"allow"}}}"#,
                star.clone(),
            ),
            (
                r#"{"permission":{"read":{"docs/**":"allow"}}}"#,
                r#"{"permission":{"read":{"*":"deny"}}}"#,
                star.clone(),
            ),
            // The last `*` rule decides, across layers and across keys.
            (
                r#"{"permission":{"read":{"*":"deny"}}}"#,
                r#"{"permission":{"read":{"*":"allow"}}}"#,
                NO_MIRROR,
            ),
            (
                r#"{"permission":{"read":{"*":"deny"},"r*":{"*":"allow"}}}"#,
                "{}",
                NO_MIRROR,
            ),
            (
                r#"{"permission":{"*":"deny","read":"allow"}}"#,
                "{}",
                closing(NO_MIRROR, &MIRRORED_TOOLS),
            ),
            // A deny a later `*` allow overrides is still mirrored.
            (
                r#"{"permission":{"read":{"*.pem":"deny"},"r*":{"*":"allow"}}}"#,
                "{}",
                mirror(false, &[], &["*.pem"]),
            ),
            // String forms are `*` rules: `read`, a whole `permission`, legacy tools.
            (r#"{"permission":{"read":"deny"}}"#, "{}", star.clone()),
            (
                r#"{"permission":"ask"}"#,
                "{}",
                closing(star.clone(), &MIRRORED_TOOLS),
            ),
            (r#"{"tools":{"read":false}}"#, "{}", star.clone()),
            (
                r#"{"tools":{"read":true}}"#,
                r#"{"tools":{"read":false}}"#,
                star.clone(),
            ),
            // The merged `permission` overrides the legacy map's values.
            (
                r#"{"tools":{"read":false},"permission":{"read":{"src/**":"allow"}}}"#,
                "{}",
                mirror(false, &["src/**"], &[]),
            ),
            (
                r#"{"tools":{"read":false},"permission":{"*":"allow"}}"#,
                "{}",
                NO_MIRROR,
            ),
            // A string `read` replaces an earlier object, and an object a string.
            (
                r#"{"permission":{"read":{"*.a":"deny"}}}"#,
                r#"{"permission":{"read":"ask"}}"#,
                star.clone(),
            ),
            (
                r#"{"permission":{"read":"deny","*":"allow"}}"#,
                r#"{"permission":{"read":{"*.b":"deny"}}}"#,
                mirror(false, &[], &["*.b"]),
            ),
        ] {
            fx.write(global, global_body);
            fx.write(managed, managed_body);
            assert_eq!(fx.resolve(None).0, want, "{global_body} + {managed_body}");
        }
        // The inherited OPENCODE_PERMISSION merges after the files.
        fx.write(global, r#"{"permission":{"read":{"*":"deny"}}}"#);
        fx.write(managed, "{}");
        let inherited = r#"{"read":{"src/**":"allow"}}"#;
        fx.env.insert("OPENCODE_PERMISSION", inherited.into());
        assert_eq!(fx.resolve(None).0, mirror(true, &["src/**"], &[]));
    }

    #[test]
    fn opencode_read_mirror_pins_end_to_end() {
        let fx = ConfigFixture::new();
        let global = "home/.config/opencode/opencode.json";
        let pins = |fx: &ConfigFixture| {
            let found = fx.resolve(None).0;
            let out = [OpencodePin::DiffOnly, OpencodePin::ReadOnly]
                .map(|pin| opencode_permission_json(pin, &[], &found));
            for pin in &out {
                assert_denies_follow_allows(pin, &found);
            }
            out
        };
        fx.write(
            global,
            r#"{"permission":{"read":{"*":"deny","src/**":"allow","*.pem":"deny"}}}"#,
        );
        assert_eq!(
            pins(&fx),
            [
                DIFF_ONLY_PIN,
                r#"{"*":"deny","*_*":"deny","read":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny","*.pem":"deny"},"read *":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny","*.pem":"deny"},"grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
            ]
        );
        // The dead allow, a string-form deny, a legacy flag and a cross-layer `*` deny
        // all pin `*` denied with no allow, and the last read rule isn't `*`, so the
        // read tool stays on.
        let denied = [
            r#"{"*":"deny","*_*":"deny","read":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"read *":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"grep":"deny","glob":"deny","list":"deny","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
            r#"{"*":"deny","*_*":"deny","read":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"read *":{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"grep":"allow","grep *":"allow","glob":"allow","glob *":"allow","list":"allow","list *":"allow","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
        ];
        for (body, managed) in [
            (
                r#"{"permission":{"read":{"docs/**":"allow","*":"deny"}}}"#,
                "{}",
            ),
            (r#"{"permission":{"read":"deny"}}"#, "{}"),
            (r#"{"tools":{"read":false}}"#, "{}"),
            (
                r#"{"permission":{"read":{"docs/**":"allow"}}}"#,
                r#"{"permission":{"read":{"*":"deny"}}}"#,
            ),
        ] {
            fx.write(global, body);
            fx.write("managed/opencode.json", managed);
            let found = pins(&fx);
            assert_eq!(found, denied, "{body} + {managed}");
            assert!(!read_rule_set(&found[0]).ends_with(r#""*":"deny"}"#));
        }
        // The common lockdown keeps reads open (its later `read` allow is the last `*`
        // rule) and denies grep, glob and list, aliases included.
        fx.write(global, r#"{"permission":{"*":"deny","read":"allow"}}"#);
        fx.write("managed/opencode.json", "{}");
        assert_eq!(
            pins(&fx),
            [
                DIFF_ONLY_PIN,
                r#"{"*":"deny","*_*":"deny","read":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"},"read *":{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"},"grep":"deny","grep *":"deny","glob":"deny","glob *":"deny","list":"deny","list *":"deny","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
            ]
        );
        // A read allow-list under a `*` deny: grep, glob and list denied too.
        fx.write(
            global,
            r#"{"permission":{"*":"deny","read":{"*":"deny","src/**":"allow"}}}"#,
        );
        assert_eq!(
            pins(&fx),
            [
                DIFF_ONLY_PIN,
                r#"{"*":"deny","*_*":"deny","read":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"read *":{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny"},"grep":"deny","grep *":"deny","glob":"deny","glob *":"deny","list":"deny","list *":"deny","skill":"deny","todowrite":"deny","question":"deny","edit":"deny","bash":"deny","webfetch":"deny","websearch":"deny","codesearch":"deny","lsp":"deny","task":"deny","external_directory":"deny","doom_loop":"deny","plan_enter":"deny","plan_exit":"deny"}"#,
            ]
        );
        // (config, ReadOnly's read rules and grep/glob/list); DiffOnly is fixed.
        let pin = |rules: &str, tools: &str| {
            format!(r#"{PIN_HEAD}"read":{rules},"read *":{rules},{tools}{DENY_TAIL}"#)
        };
        let tools = |[grep, glob, list]: [&str; 3]| {
            format!(
                r#""grep":"{grep}","grep *":"{grep}","glob":"{glob}","glob *":"{glob}","list":"{list}","list *":"{list}","#
            )
        };
        let open = r#"{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow"}"#;
        let src = r#"{"*":"deny","src/**":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#;
        let index = r#"{"*":"allow","*.env":"deny","*.env.*":"deny","*.env.example":"allow","0 *":"deny","2024 *":"deny","01":"deny"}"#;
        let env_any = r#"{"*":"allow","*.env":"deny","*.env.example":"allow","*.env.*":"deny"}"#;
        for (body, rules, readonly) in [
            (
                r#"{"permission":{"*":"deny","grep":{"*":"allow"},"read":"allow"}}"#,
                open,
                ["allow", "deny", "deny"],
            ),
            (
                r#"{"permission":{"grep":"deny"}}"#,
                open,
                ["deny", "allow", "allow"],
            ),
            // `**` and `***` are catch-alls.
            (
                r#"{"permission":{"grep":{"***":"deny"},"read":{"**":"deny","src/**":"allow"}}}"#,
                src,
                ["deny", "allow", "allow"],
            ),
            // A trailing ` *` is optional, so `* *` and `** *` are catch-alls too; read
            // stays on, its last rule not a bare `*` deny.
            (
                r#"{"permission":{"read":{"* *":"deny"}}}"#,
                r#"{"*":"deny","*.env":"deny","*.env.*":"deny","*.env.example":"deny"}"#,
                ["allow", "allow", "allow"],
            ),
            (
                r#"{"permission":{"grep":{"** *":"deny"}}}"#,
                open,
                ["deny", "allow", "allow"],
            ),
            // An unknown catch-all action closes, and ends the dead-allow window; an
            // unknown action on any other pattern is skipped.
            (
                r#"{"permission":{"read":{"docs/**":"allow","*":"block","src/**":"allow","*.pem":"block"},"glob":"block"}}"#,
                src,
                ["allow", "deny", "allow"],
            ),
            // A deny or ask on a carve-out key follows `*.env.example`'s allow.
            (
                r#"{"permission":{"read":{"*.env.*":"deny"}}}"#,
                env_any,
                ["allow", "allow", "allow"],
            ),
            (
                r#"{"permission":{"read":{"*.env.*":"ask"}}}"#,
                env_any,
                ["allow", "allow", "allow"],
            ),
            // Index-shaped denies are respelled `<digits> *`, deduped; `01` isn't one.
            // Last, so the JS-order check below reads this row.
            (
                r#"{"permission":{"read":{"2024":"deny","*":"allow","0":"ask","01":"deny","2024 *":"deny"}}}"#,
                index,
                ["allow", "allow", "allow"],
            ),
        ] {
            fx.write(global, body);
            assert_eq!(
                pins(&fx),
                [DIFF_ONLY_PIN.to_string(), pin(rules, &tools(readonly))],
                "{body}"
            );
        }
        // JS property order keeps the emitted read order: no key is an array index.
        let found = pins(&fx);
        for out in &found {
            let Ok(ConfigValue::Object(top)) = serde_json::from_str::<ConfigValue>(out) else {
                panic!("{out}");
            };
            for (key, value) in &top {
                if let ConfigValue::Object(rules) = value {
                    assert_eq!(rules[0].0, "*", "{key}");
                    assert!(
                        rules.iter().all(|(k, _)| js_array_index(k).is_none()),
                        "{out}"
                    );
                }
            }
            assert_eq!(pin_alias_violations(out), Vec::<String>::new(), "{out}");
        }
        let lockdown = r#"{"permission":{"*":"deny","read":"allow"}}"#;
        fx.write(global, lockdown);
        let found = pins(&fx);
        assert_eq!(pin_alias_violations(&found[1]), Vec::<String>::new());
        // A deny that a later `*` allow overrides stays mirrored.
        fx.write(
            global,
            r#"{"permission":{"read":{"*.pem":"deny"},"r*":{"*":"allow"}}}"#,
        );
        let pem = mirror(false, &[], &["*.pem"]);
        let want = [OpencodePin::DiffOnly, OpencodePin::ReadOnly]
            .map(|pin| opencode_permission_json(pin, &[], &pem));
        assert_eq!(pins(&fx), want);
        // A user deny or ask on `*.env.*` denies `.env.example` files, as in plain
        // opencode (ReadOnly; DiffOnly denies every path).
        for action in ["deny", "ask"] {
            fx.write(
                global,
                &format!(r#"{{"permission":{{"read":{{"*.env.*":"{action}"}}}}}}"#),
            );
            let [_, out] = pins(&fx);
            for rules in read_rule_sets(&out) {
                for path in ["x.env.example", ".env.example"] {
                    assert_eq!(read_verdict(&rules, path), "deny", "{path}: {out}");
                }
                assert_eq!(read_verdict(&rules, "src/main.rs"), "allow", "{out}");
            }
        }
    }

    /// Fails instead of hanging when the resolver blocks on a FIFO at a config path.
    #[cfg(unix)]
    #[test]
    fn opencode_read_mirror_skips_a_fifo_without_blocking() {
        let fx = ConfigFixture::new();
        let path = fx.root.path().join("home/.config/opencode/opencode.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let made = std::process::Command::new("mkfifo").arg(&path).status();
        assert!(made.is_ok_and(|status| status.success()), "mkfifo");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let _ = tx.send(fx.resolve(None).0);
            });
            let found = rx.recv_timeout(Duration::from_secs(10));
            if found == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                // A read-write open never blocks on a FIFO and releases the blocked
                // reader, whose read then sees EOF, so the scope joins.
                let release = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path);
                drop(release);
            }
            assert_eq!(found, Ok(NO_MIRROR));
        });
    }

    #[test]
    fn opencode_home_tracks_bun_os_homedir() {
        let env = |home: &'static str| {
            move |key: &str| match key {
                "USERPROFILE" => Some("C:/Users/u".to_string()),
                "HOME" => Some(home.to_string()),
                _ => None,
            }
        };
        let os = || Some(PathBuf::from("/os"));
        assert_eq!(
            opencode_home(&env("/h"), true, &os),
            Some(PathBuf::from("C:/Users/u"))
        );
        assert_eq!(
            opencode_home(&env("/h"), false, &os),
            Some(PathBuf::from("/h"))
        );
        // An empty USERPROFILE gives none; an empty HOME asks the OS, as unset does.
        let no_profile = |key: &str| (key == "USERPROFILE").then(String::new);
        assert_eq!(opencode_home(&no_profile, true, &os), None);
        assert_eq!(
            opencode_home(&env(""), false, &os),
            Some(PathBuf::from("/os"))
        );
        assert_eq!(
            opencode_home(&|_: &str| None, false, &os),
            Some(PathBuf::from("/os"))
        );
        assert_eq!(
            opencode_home(&|_: &str| None, true, &os),
            Some(PathBuf::from("/os"))
        );
        assert_eq!(opencode_home(&|_: &str| None, false, &|| None), None);
    }

    #[test]
    fn opencode_read_mirror_skips_unreadable_and_garbage_sources() {
        let fx = ConfigFixture::new();
        fx.write("home/.config/opencode/config.json", "{ not json");
        fx.write("home/.config/opencode/opencode.json", "/* never closed");
        fx.write("home/.config/opencode/opencode.jsonc", "");
        // A directory where a file belongs reads as nothing.
        let dir = fx.root.path().join("home/.opencode/opencode.json");
        std::fs::create_dir_all(dir).unwrap();
        fx.deny("home/.opencode/opencode.jsonc", "*.ok");
        fx.write("managed/opencode.json", r#"[1, 2]"#);
        assert_eq!(fx.resolve(None).0.denies, ["*.ok"]);
        // A string-form `permission` is a `*` rule; a non-string action contributes
        // nothing.
        fx.write("home/.opencode/opencode.jsonc", r#"{"permission":"deny"}"#);
        let nested = r#"{"permission":{"read":{"*.x":{"y":"deny"}}}}"#;
        fx.write("managed/opencode.jsonc", nested);
        let want = closing(mirror(true, &[], &[]), &MIRRORED_TOOLS);
        assert_eq!(fx.resolve(None).0, want);
    }

    #[test]
    fn opencode_read_mirror_never_reads_outside_its_seam() {
        // Hermetic by construction: the production entry returns nothing under test,
        // and the seam reads only the paths its env and home name.
        assert_eq!(opencode_read_mirror(None, Path::new(".")), NO_MIRROR);
        let mut fx = ConfigFixture::new();
        let (_, asked) = fx.resolve(None);
        assert!(!asked.is_empty());
        assert!(fx.holds_all(&asked), "{asked:?}");
        // Negative control: without the managed-dir override the seam names the real
        // per-OS managed dir, and the fixture's recorder sees the escape.
        fx.env.remove("OPENCODE_TEST_MANAGED_CONFIG_DIR");
        let (_, asked) = fx.resolve(None);
        assert!(!fx.holds_all(&asked), "{asked:?}");
    }

    #[test]
    fn parse_jsonc_keeps_comment_and_comma_text_inside_strings() {
        type Json = serde_json::Value;
        let v: Json =
            parse_jsonc("{\"a\": \"x // y /* z */, }\", // c\n \"b\": [1, 2,], }").unwrap();
        assert_eq!(v["a"], "x // y /* z */, }");
        assert_eq!(v["b"], serde_json::json!([1, 2]));
        assert_eq!(
            parse_jsonc::<Json>("\u{feff}{\"q\": \"\\\"\"}").unwrap()["q"],
            "\""
        );
        assert!(parse_jsonc::<Json>("{\"a\": 1,,}").is_none());
        assert!(parse_jsonc::<Json>("{\"a\": 1} /* open").is_none());
    }

    #[test]
    fn opencode_permission_pins_deny_the_write_surface() {
        for pin in [OpencodePin::DiffOnly, OpencodePin::ReadOnly] {
            let out = opencode_permission_json(pin, &["external", "doom", "plan"], &NO_MIRROR);
            let v: serde_json::Value = serde_json::from_str(&out).unwrap();
            for key in DENIED_BUILTINS {
                assert_eq!(v[key], "deny", "{pin:?} {key}");
            }
            assert_eq!(v["*"], "deny");
            assert_eq!(v["*_*"], "deny");
            let star = match pin {
                OpencodePin::DiffOnly => "deny",
                OpencodePin::ReadOnly => "allow",
            };
            assert_eq!(v["read"]["*"], star, "{pin:?}");
            assert_eq!(v["read"]["*.env"], "deny");
            assert_eq!(v["read"]["*.env.*"], "deny");
            for key in ["grep", "glob", "list"] {
                match pin {
                    OpencodePin::DiffOnly => assert_eq!(v[key], "deny", "{key}"),
                    OpencodePin::ReadOnly => assert_eq!(v[key], "allow", "{key}"),
                }
            }
            // Last match wins, so a server wildcard or its alias that also matches a
            // builtin must precede that builtin's deny, and every server allow sits
            // between the `*_*` catch-all and `read`.
            let at = |needle: &str| out.find(needle).unwrap_or_else(|| panic!("{needle}"));
            let read = at(r#""read":"#);
            let catch_all = at(r#""*_*":"deny""#);
            for (server, denies) in [
                ("external", &[r#""external_directory":"deny""#][..]),
                ("doom", &[r#""doom_loop":"deny""#][..]),
                (
                    "plan",
                    &[r#""plan_enter":"deny""#, r#""plan_exit":"deny""#][..],
                ),
            ] {
                for allow in [
                    format!(r#""{server}_*":"allow""#),
                    format!(r#""{server}_?*":"allow""#),
                ] {
                    assert!(catch_all < at(&allow) && at(&allow) < read, "{allow}");
                    for deny in denies {
                        assert!(at(&allow) < at(deny), "{allow} vs {deny}");
                    }
                }
            }
        }
    }

    /// A pin's top-level entries in emitted order, duplicates kept (a
    /// `serde_json::Value` map would sort and dedupe them).
    fn pin_entries(json: &str) -> Vec<(String, serde_json::Value)> {
        struct Entries(Vec<(String, serde_json::Value)>);
        impl<'de> serde::Deserialize<'de> for Entries {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct Visit;
                impl<'de> serde::de::Visitor<'de> for Visit {
                    type Value = Entries;
                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        f.write_str("a permission object")
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(
                        self,
                        mut map: A,
                    ) -> Result<Entries, A::Error> {
                        let mut out = Vec::new();
                        while let Some(entry) = map.next_entry()? {
                            out.push(entry);
                        }
                        Ok(Entries(out))
                    }
                }
                d.deserialize_map(Visit)
            }
        }
        serde_json::from_str::<Entries>(json).unwrap().0
    }

    /// Same-length custom tool ids a `?` alias of a builtin would admit, plus one that
    /// differs from a builtin only by case.
    const CUSTOM_IDS: [&str; 5] = ["real", "lisp", "grey", "glow", "READ"];

    /// Custom ids made of a builtin's id, a space and more: the documented residual a
    /// ` *` alias admits.
    const SPACED_IDS: [&str; 5] = ["read x", "grep x", "glob x", "list x", "read"];

    /// The ids among the builtins and `CUSTOM_IDS` that `alias` matches and `key`
    /// doesn't.
    fn alias_overreach(alias: &str, key: &str) -> Vec<&'static str> {
        DENIED_BUILTINS
            .into_iter()
            .chain(["read", "grep", "glob", "list"])
            .chain(CUSTOM_IDS)
            .filter(|id| wildcard_matches(alias, id) && !wildcard_matches(key, id))
            .collect()
    }

    /// Whether a pin key is an alias spelling: a server's `<name>_?*`, a builtin's
    /// `<id> *`, or a stray `?` form.
    fn is_alias_key(key: &str) -> bool {
        key.contains('?') || key.ends_with(" *")
    }

    /// Every breach of the alias rule: each allow-valued key but `*` needs its alias
    /// (`<name>_?*` for a server's `<name>_*`, `<id> *` for a builtin) with the same
    /// value, after both `*` and the key, matching the key's own tool and no builtin or
    /// custom id the key doesn't; a server's alias also precedes the first tail deny;
    /// every alias-shaped key must be such an alias.
    fn pin_alias_violations(json: &str) -> Vec<String> {
        let entries = pin_entries(json);
        let pos = |k: &str| entries.iter().position(|(n, _)| n == k);
        let (Some(star), Some(tail)) = (pos("*"), pos(DENIED_BUILTINS[0])) else {
            return vec!["no `*` or no tail".into()];
        };
        let mut bad = Vec::new();
        let mut aliases = Vec::new();
        for (i, (key, value)) in entries.iter().enumerate() {
            if key == "*" || is_alias_key(key) {
                continue;
            }
            if *value == "deny" {
                // A denied builtin may keep its alias, denied too.
                let alias = format!("{key} *");
                if pos(&alias).is_some_and(|at| entries[at].1 == "deny") {
                    aliases.push(alias);
                }
                continue;
            }
            let server = key.strip_suffix('*');
            let (alias, tool) = match server {
                Some(prefix) => (format!("{prefix}?*"), format!("{prefix}tool")),
                None => (format!("{key} *"), key.clone()),
            };
            aliases.push(alias.clone());
            let Some(at) = pos(&alias) else {
                bad.push(format!("{key}: no {alias}"));
                continue;
            };
            if at < star || at < i {
                bad.push(format!("{alias} precedes `*` or {key}"));
            }
            if server.is_some() && at > tail {
                bad.push(format!("{alias} follows the tail"));
            }
            if entries[at].1 != *value {
                bad.push(format!("{alias} differs from {key}"));
            }
            if !wildcard_matches(&alias, &tool) {
                bad.push(format!("{alias} misses {tool}"));
            }
            for other in alias_overreach(&alias, key) {
                bad.push(format!("{alias} also matches {other}"));
            }
        }
        for (key, _) in &entries {
            if is_alias_key(key) && !aliases.contains(key) {
                bad.push(format!("stray {key}"));
            }
        }
        bad
    }

    #[test]
    fn opencode_permission_pins_alias_every_allow_after_the_catch_all() {
        // The model of opencode's matcher the alias rule rests on.
        for (pattern, key, hit) in [
            ("read *", "read", true),
            ("read *", "READ", true),
            ("read *", "read x", true),
            ("read *", "reads", false),
            ("read *", "real", false),
            ("rea?", "real", true),
            ("rea?", "REAL", true),
            ("rea?", "read", true),
            ("x_?*", "x_tool", true),
            ("x_?*", "x_", false),
            ("x_*", "x_", true),
            ("*", "read", true),
            ("r*", "read", true),
            ("READ*", "read", true),
            ("re", "read", false),
            ("?ead", "read", true),
            ("a\\b", "a/b", true),
            ("a/b", "a\\b", true),
            ("a.b", "axb", false),
        ] {
            assert_eq!(wildcard_matches(pattern, key), hit, "{pattern} vs {key}");
        }
        // Many `*`s cost no backtracking blow-up.
        assert!(!wildcard_matches(
            &format!("{}x", "*?".repeat(500)),
            &"r".repeat(400)
        ));
        // The documented residual: each ` *` alias admits exactly its builtin's spaced id
        // beyond what the builtin's own key matches.
        for id in ["read", "grep", "glob", "list"] {
            let spaced: Vec<&str> = SPACED_IDS
                .into_iter()
                .filter(|s| wildcard_matches(&format!("{id} *"), s) && !wildcard_matches(id, s))
                .collect();
            assert_eq!(spaced, [format!("{id} x")], "{id}");
        }
        let rebuild = |entries: &[(String, serde_json::Value)]| {
            let body: Vec<String> = entries
                .iter()
                .map(|(k, v)| format!("{}:{v}", serde_json::Value::String(k.clone())))
                .collect();
            format!("{{{}}}", body.join(","))
        };
        let mut variants = 0;
        let mirrored = mirror(true, &["src/**", "*.md"], &["*.pem", "*.md"]);
        for (pin, read_mirror) in [
            (OpencodePin::DiffOnly, &NO_MIRROR),
            (OpencodePin::ReadOnly, &NO_MIRROR),
            (OpencodePin::DiffOnly, &mirrored),
            (OpencodePin::ReadOnly, &mirrored),
        ] {
            for servers in [
                &[][..],
                &["gitdesktop"][..],
                &["a.b", "x"][..],
                &["external", "doom", "plan"][..],
            ] {
                variants += 1;
                let out = opencode_permission_json(pin, servers, read_mirror);
                assert_eq!(pin_alias_violations(&out), Vec::<String>::new(), "{out}");
                assert_denies_follow_allows(&out, read_mirror);
                let entries = pin_entries(&out);
                let alias_count = entries.iter().filter(|(k, _)| is_alias_key(k)).count();
                // DiffOnly's grep/glob/list stay denied, so they take no alias.
                let builtin_aliases = match pin {
                    OpencodePin::DiffOnly => 1,
                    OpencodePin::ReadOnly => 4,
                };
                assert_eq!(alias_count, builtin_aliases + servers.len(), "{out}");
                // The rebuild is faithful, so each mutant below differs only by its edit.
                assert_eq!(
                    pin_alias_violations(&rebuild(&entries)),
                    Vec::<String>::new()
                );
                for (i, (key, _)) in entries.iter().enumerate() {
                    if !is_alias_key(key) {
                        continue;
                    }
                    if let Some(id) = key.strip_suffix(" *") {
                        // A `?` alias in its place admits a custom id, so it must fail.
                        let question = format!("{}?", &id[..id.len() - 1]);
                        assert!(!alias_overreach(&question, id).is_empty(), "{question}");
                        let mut swapped = entries.clone();
                        swapped[i].0 = question;
                        assert!(
                            !pin_alias_violations(&rebuild(&swapped)).is_empty(),
                            "{} in place of {key} must fail: {out}",
                            swapped[i].0
                        );
                    }
                    let mut dropped = entries.clone();
                    dropped.remove(i);
                    assert!(
                        !pin_alias_violations(&rebuild(&dropped)).is_empty(),
                        "dropping {key} must fail: {out}"
                    );
                    let mut hoisted = entries.clone();
                    let alias = hoisted.remove(i);
                    hoisted.insert(0, alias);
                    assert!(
                        !pin_alias_violations(&rebuild(&hoisted)).is_empty(),
                        "{key} ahead of `*` must fail: {out}"
                    );
                    if key.ends_with("_?*") {
                        let mut sunk = entries.clone();
                        let alias = sunk.remove(i);
                        sunk.push(alias);
                        assert!(
                            !pin_alias_violations(&rebuild(&sunk)).is_empty(),
                            "{key} after the tail must fail: {out}"
                        );
                    }
                }
            }
        }
        assert_eq!(variants, 16);
    }

    #[test]
    fn review_env_pins_every_mode() {
        let kinds = [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Copilot,
            AgentKind::Opencode,
        ];
        let mut rows = 0;
        for kind in kinds {
            for repo_aware in [false, true] {
                for self_mcp in [false, true] {
                    rows += 1;
                    let (path, servers): (Option<&str>, &[&str]) = if self_mcp {
                        (Some("C:/cfg/r.opencode.json"), &["gitdesktop"])
                    } else {
                        (None, &[])
                    };
                    let denies = mirror(true, &["src/**"], &["*.pem"]);
                    let env = review_env(kind, repo_aware, path, servers, &denies);
                    let get = |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
                    match kind {
                        AgentKind::Opencode => {
                            let pin = if repo_aware {
                                OpencodePin::ReadOnly
                            } else {
                                OpencodePin::DiffOnly
                            };
                            let want = opencode_permission_json(pin, servers, &denies);
                            // Only ReadOnly mirrors the user's rules.
                            let mirrored = want.contains(r#""*.pem":"deny""#);
                            assert_eq!(mirrored, repo_aware, "{want}");
                            assert_eq!(get("OPENCODE_PERMISSION"), Some(want.as_str()));
                            assert_eq!(get("OPENCODE_DISABLE_PROJECT_CONFIG"), Some("1"));
                            assert_eq!(get("OPENCODE_DISABLE_MODELS_FETCH"), Some("1"));
                            assert_eq!(get("OPENCODE_CONFIG"), path);
                            assert_eq!(env.len(), 3 + usize::from(path.is_some()));
                        }
                        AgentKind::Copilot if !repo_aware && !self_mcp => {
                            assert_eq!(env, [("COPILOT_ALLOW_ALL", "false".to_string())]);
                        }
                        _ => assert!(env.is_empty(), "{kind:?} aware={repo_aware} mcp={self_mcp}"),
                    }
                }
            }
        }
        assert_eq!(rows, 16);
    }

    #[test]
    fn opencode_session_env_pins_read_only_sessions() {
        let denies = mirror(true, &["src/**"], &["*.pem"]);
        let read_only_pin =
            |servers: &[&str]| opencode_permission_json(OpencodePin::ReadOnly, servers, &denies);
        for read_only in [false, true] {
            for research in [false, true] {
                for path in [
                    None,
                    Some("/home/node/.local/share/opencode/opencode-mcp.json"),
                    Some("C:/cfg/x.json"),
                ] {
                    for servers in [&[][..], &["docs"][..]] {
                        let env = opencode_session_env(
                            read_only,
                            research,
                            path.map(str::to_string),
                            servers,
                            &denies,
                        );
                        let get =
                            |k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
                        let want = read_only.then(|| read_only_pin(servers));
                        assert_eq!(get("OPENCODE_PERMISSION"), want.as_deref());
                        if read_only && !servers.is_empty() {
                            assert!(want.unwrap().contains(r#""docs_*":"allow""#));
                        }
                        assert_eq!(get("OPENCODE_ENABLE_EXA"), research.then_some("1"));
                        assert_eq!(get("OPENCODE_CONFIG"), path);
                        assert_eq!(get("OPENCODE_DISABLE_MODELS_FETCH"), Some("1"));
                        // Sessions keep the repo's project config.
                        assert_eq!(get("OPENCODE_DISABLE_PROJECT_CONFIG"), None);
                    }
                }
            }
        }
    }

    // --- EventSink seam ------------------------------------------------------

    /// A second `EventSink` implementation (the Tauri `Channel` is the first),
    /// proving the seam takes a non-channel sink — the substrate the LAN
    /// broadcast fan-out will reuse. Collects every event into a `Vec`.
    struct CollectorSink {
        events: std::sync::Mutex<Vec<ReviewEvent>>,
    }

    impl EventSink for CollectorSink {
        fn send(&self, ev: ReviewEvent) {
            self.events.lock().unwrap().push(ev);
        }
    }

    #[test]
    fn event_sink_collects_events_through_dyn_object() {
        let sink = CollectorSink {
            events: std::sync::Mutex::new(Vec::new()),
        };
        // Drive it through `&dyn EventSink` to exercise object safety — the same
        // coercion `stream_agent`'s callers rely on.
        let dyn_sink: &dyn EventSink = &sink;
        dyn_sink.send(ReviewEvent::Delta {
            text: "hello".to_string(),
        });
        dyn_sink.send(ReviewEvent::error("boom"));

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], ReviewEvent::Delta { text } if text == "hello"));
        assert!(matches!(&events[1], ReviewEvent::Error { message, .. } if message == "boom"));
    }

    // --- stream_agent end of run ----------------------------------------------

    fn collector() -> CollectorSink {
        CollectorSink {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[tokio::test]
    async fn stream_agent_returns_the_first_terminal_it_sent() {
        let dir = std::env::temp_dir().join(format!("gd-stream-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("fixture dir");
        let jsonl = concat!(
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The review."}}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"The review.","total_cost_usd":0.25}"#,
            "\n",
            // A second terminal after the first: the return must stay the first.
            r#"{"type":"result","subtype":"success","is_error":false,"result":"A later answer.","total_cost_usd":0.5}"#,
            "\n",
        );
        std::fs::write(dir.join("run.jsonl"), jsonl).expect("fixture file");
        // Prints the fixture as the CLI's stdout, run from its directory.
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) {
            ("cmd", vec!["/C".into(), "type".into(), "run.jsonl".into()])
        } else {
            ("cat", vec!["run.jsonl".into()])
        };
        let sink = collector();
        let result = stream_agent(
            Arc::new(Notify::new()),
            AgentKind::Claude,
            Path::new(bin),
            args,
            String::new(),
            dir.to_str().expect("utf-8 temp dir"),
            Duration::from_secs(60),
            "review",
            false,
            None,
            true,
            &[],
            &sink,
            None,
        )
        .await;
        let _ = std::fs::remove_dir_all(&dir);

        let returned = result
            .expect("the run streams")
            .expect("a terminal is returned");
        assert!(
            matches!(&returned, ReviewEvent::Done { is_error: false, text, .. } if text == "The review."),
            "the return is the first terminal, got {returned:?}"
        );
        // The pump keeps reading after a terminal, so both reach the sink in order.
        let events = sink.events.into_inner().unwrap();
        let terminals: Vec<&ReviewEvent> = events
            .iter()
            .filter(|e| matches!(e, ReviewEvent::Done { .. } | ReviewEvent::Error { .. }))
            .collect();
        assert_eq!(terminals.len(), 2, "both terminals are forwarded");
        assert_eq!(
            serde_json::to_value(&returned).unwrap(),
            serde_json::to_value(terminals[0]).unwrap()
        );
        assert!(
            matches!(terminals[1], ReviewEvent::Done { text, .. } if text == "A later answer.")
        );
    }

    #[tokio::test]
    async fn stream_agent_returns_none_only_for_a_cancelled_run() {
        // The permit is stored before the call, so the cancel arm wins as soon as the
        // select polls it; the fixture blocks so stdout can't reach EOF first.
        let cancel = Arc::new(Notify::new());
        cancel.notify_one();
        let (bin, args): (&str, Vec<String>) = if cfg!(windows) {
            (
                "cmd",
                vec![
                    "/C".into(),
                    "ping".into(),
                    "-n".into(),
                    "6".into(),
                    "127.0.0.1".into(),
                ],
            )
        } else {
            ("sleep", vec!["5".into()])
        };
        let dir = std::env::temp_dir();
        let sink = collector();
        let result = stream_agent(
            cancel,
            AgentKind::Claude,
            Path::new(bin),
            args,
            String::new(),
            dir.to_str().expect("utf-8 temp dir"),
            Duration::from_secs(60),
            "review",
            false,
            None,
            true,
            &[],
            &sink,
            None,
        )
        .await;
        assert!(
            matches!(result, Ok(None)),
            "a cancelled run returns no terminal"
        );
        let events = sink.events.into_inner().unwrap();
        assert!(!events
            .iter()
            .any(|e| matches!(e, ReviewEvent::Done { .. } | ReviewEvent::Error { .. })));
    }

    // A run's process tree: a fake agent CLI that starts a holder (proc_tree's test
    // support) and then waits for `go`. Each test starts its run the same way
    // (`start_run`), so no Windows holder is born before its job assignment.

    use crate::proc_tree::test_support::{
        remove_when_free, started_within, wait_until, Holder, HostShell, Keeps, HANG_GUARD,
    };
    use crate::proc_tree::TreeGuard;

    /// What the fake CLI writes to its stderr as it ends; shares no text with the
    /// holder's release marker.
    const MARKER: &str = "RUN-TREE-STDERR-MARKER";

    /// The Claude `result` line: the smallest stdout that ends a run with `Done`.
    const RESULT_LINE: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"The review.","total_cost_usd":0.25}"#;

    fn tree_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("gd-agent-tree-")
            .tempdir()
            .expect("create temp dir")
    }

    /// The fake CLI, a batch root (the shape of a `.cmd` shim) run as
    /// `cmd /d /c .\agent.cmd`: it launches the holder only once `armed` exists, then
    /// waits for `go`, writes MARKER to stderr and, given `emit`, prints `out.jsonl`.
    /// Each loop steps with a one-second ping, 900 passes in all (a leak cap).
    #[cfg(windows)]
    fn fake_agent(dir: &Path, holder: &Holder, keeps: Keeps, emit: bool) -> (PathBuf, Vec<String>) {
        let step = r#""%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul"#;
        let lines = [
            "@echo off".to_string(),
            "set n=0".into(),
            ":armed".into(),
            "if exist armed goto launch".into(),
            "set /a n+=1 >nul".into(),
            "if %n% geq 900 goto done".into(),
            step.into(),
            "goto armed".into(),
            ":launch".into(),
            holder.launch_snippet(HostShell::Cmd, keeps),
            ":wait".into(),
            "if exist go goto done".into(),
            "set /a n+=1 >nul".into(),
            "if %n% geq 900 goto done".into(),
            step.into(),
            "goto wait".into(),
            ":done".into(),
            format!("echo {MARKER} 1>&2"),
            r#"if "%~1"=="emit" type out.jsonl"#.into(),
        ];
        std::fs::write(dir.join("agent.cmd"), lines.join("\r\n") + "\r\n")
            .expect("write agent.cmd");
        // `.\`: cmd skips the current directory for a bare name when
        // NoDefaultCurrentDirectoryInExePath is set.
        let mut args = vec!["/d".to_string(), "/c".into(), r".\agent.cmd".into()];
        if emit {
            std::fs::write(dir.join("out.jsonl"), format!("{RESULT_LINE}\n"))
                .expect("write out.jsonl");
            args.push("emit".into());
        }
        (PathBuf::from("cmd"), args)
    }

    /// The fake CLI as an sh script run as `sh agent.sh`: it launches the holder, then
    /// waits for `go`, writes MARKER to stderr and, given `emit`, prints `out.jsonl`.
    /// No `armed` gate: the process group exists before exec. The loop's cap is a leak
    /// cap (about 15 minutes).
    #[cfg(unix)]
    fn fake_agent(dir: &Path, holder: &Holder, keeps: Keeps, emit: bool) -> (PathBuf, Vec<String>) {
        let lines = [
            holder.launch_snippet(HostShell::Sh, keeps),
            r#"i=0; while [ ! -e go ] && [ "$i" -lt 18000 ]; do sleep 0.05; i=$((i+1)); done"#
                .to_string(),
            format!("echo {MARKER} >&2"),
            r#"if [ "$1" = emit ]; then cat out.jsonl; fi"#.into(),
            "exit 0".into(),
        ];
        std::fs::write(dir.join("agent.sh"), lines.join("\n") + "\n").expect("write agent.sh");
        let mut args = vec!["agent.sh".to_string()];
        if emit {
            std::fs::write(dir.join("out.jsonl"), format!("{RESULT_LINE}\n"))
                .expect("write out.jsonl");
            args.push("emit".into());
        }
        (PathBuf::from("sh"), args)
    }

    /// stream_agent over the fake CLI in `dir`: a review when `kill_tree_on_exit`, else
    /// a session. Its 600 s timeout is a failure-only ceiling.
    fn fake_run<'a>(
        cancel: Arc<Notify>,
        bin: &'a Path,
        args: Vec<String>,
        dir: &'a Path,
        kill_tree_on_exit: bool,
        sink: &'a CollectorSink,
    ) -> impl std::future::Future<Output = AppResult<Option<ReviewEvent>>> + 'a {
        let noun = if kill_tree_on_exit {
            "review"
        } else {
            "session"
        };
        stream_agent(
            cancel,
            AgentKind::Claude,
            bin,
            args,
            String::new(),
            dir.to_str().expect("utf-8 temp dir"),
            Duration::from_secs(600),
            noun,
            false,
            None,
            kill_tree_on_exit,
            &[],
            sink,
            None,
        )
    }

    /// Polls `run` once, only then opens the `armed` gate, and keeps polling it until
    /// the holder has started. On Windows the spawn and the guard's arm happen in that
    /// first poll; elsewhere a wait for an executing PATH capture may come before them.
    async fn start_run<F>(run: &mut std::pin::Pin<Box<F>>, dir: &Path, holder: &Holder)
    where
        F: std::future::Future<Output = AppResult<Option<ReviewEvent>>>,
    {
        tokio::select! {
            biased;
            r = run.as_mut() => panic!("the run ended at once: {r:?}"),
            () = std::future::ready(()) => {}
        }
        std::fs::write(dir.join("armed"), "").expect("open the armed gate");
        tokio::select! {
            r = run.as_mut() => panic!("the run ended before its holder started: {r:?}"),
            s = started_within(holder, HANG_GUARD) => assert!(s, "the holder never started"),
        }
    }

    /// Lets the fake CLI end.
    fn let_go(dir: &Path) {
        std::fs::write(dir.join("go"), "").expect("let the fake CLI end");
    }

    /// The error message a run that streamed no result ends with.
    fn no_result_message(result: &AppResult<Option<ReviewEvent>>) -> String {
        match result {
            Ok(Some(ReviewEvent::Error { message, .. })) => message.clone(),
            other => panic!("expected the no-result Error, got {other:?}"),
        }
    }

    /// A review's clean end kills a holder that keeps only the CLI's stderr, so the
    /// stderr join reaches EOF and the CLI's own stderr text becomes the message. What
    /// this rests on is the product's behaviour, not a test margin: after the tree kill
    /// the read must end inside the product's own stderr-join grace, or the product
    /// reports no stderr and the marker is missing. The test reads no clock.
    #[tokio::test]
    async fn run_tree_review_end_kills_a_stderr_holder() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::StderrOnly, false);
        let sink = collector();
        let cancel = Arc::new(Notify::new());
        let mut run = Box::pin(fake_run(cancel, &bin, args, dir.path(), true, &sink));
        start_run(&mut run, dir.path(), &holder).await;
        let_go(dir.path());
        let result = run.await;
        let died = wait_until(|| !holder.alive(), HANG_GUARD);
        let message = no_result_message(&result);
        assert!(
            message.contains(MARKER),
            "the stderr text never arrived (holder died: {died}): {message:?}"
        );
        assert!(died, "the stderr holder outlived the review");
        remove_when_free(dir);
    }

    /// The control for the test above: a session's clean end keeps the holder, so the
    /// stderr join gives up and the marker cannot arrive.
    #[tokio::test]
    async fn run_tree_session_end_keeps_a_stderr_holder() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::StderrOnly, false);
        let sink = collector();
        let cancel = Arc::new(Notify::new());
        let mut run = Box::pin(fake_run(cancel, &bin, args, dir.path(), false, &sink));
        start_run(&mut run, dir.path(), &holder).await;
        let_go(dir.path());
        let result = run.await;
        let message = no_result_message(&result);
        assert!(
            !message.contains(MARKER),
            "the marker arrived while the holder kept stderr: {message:?}"
        );
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the session's clean end killed its holder"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }

    /// One clean end, with a result streamed and no pipe kept: a review kills the
    /// holder, a session keeps it.
    async fn clean_end(kill_tree_on_exit: bool) {
        let kind = if kill_tree_on_exit {
            "review"
        } else {
            "session"
        };
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::Neither, true);
        let sink = collector();
        let cancel = Arc::new(Notify::new());
        let mut run = Box::pin(fake_run(
            cancel,
            &bin,
            args,
            dir.path(),
            kill_tree_on_exit,
            &sink,
        ));
        start_run(&mut run, dir.path(), &holder).await;
        let_go(dir.path());
        let result = run.await;
        assert!(
            matches!(
                result,
                Ok(Some(ReviewEvent::Done {
                    is_error: false,
                    ..
                }))
            ),
            "{kind}: expected a clean Done, got {result:?}"
        );
        if kill_tree_on_exit {
            assert!(
                wait_until(|| !holder.alive(), HANG_GUARD),
                "{kind}: the holder outlived the run"
            );
        } else {
            assert!(
                holder.confirm_alive(HANG_GUARD),
                "{kind}: the clean end killed the holder"
            );
            holder.release();
            assert!(
                wait_until(|| !holder.alive(), HANG_GUARD),
                "{kind}: the released holder never exited"
            );
        }
        remove_when_free(dir);
    }

    /// Each arm is the other's control.
    #[tokio::test]
    async fn run_tree_clean_end_by_run_kind() {
        clean_end(true).await;
        clean_end(false).await;
    }

    #[tokio::test]
    async fn run_tree_cancelled_session_kills_its_holder() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::Both, false);
        let sink = collector();
        let cancel = Arc::new(Notify::new());
        let mut run = Box::pin(fake_run(
            cancel.clone(),
            &bin,
            args,
            dir.path(),
            false,
            &sink,
        ));
        start_run(&mut run, dir.path(), &holder).await;
        cancel.notify_one();
        let result = run.await;
        assert!(
            matches!(result, Ok(None)),
            "a cancelled run returns no terminal, got {result:?}"
        );
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the cancelled session"
        );
        remove_when_free(dir);
    }

    #[tokio::test]
    async fn run_tree_dropped_run_kills_its_holder() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::Both, false);
        let sink = collector();
        let cancel = Arc::new(Notify::new());
        let mut run = Box::pin(fake_run(cancel, &bin, args, dir.path(), false, &sink));
        start_run(&mut run, dir.path(), &holder).await;
        drop(run);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the dropped run"
        );
        remove_when_free(dir);
    }

    /// The negative control for the two kill tests above: the same fake CLI spawned
    /// the product's way, its guard disarmed, then the CLI killed directly, leaves the
    /// holder running.
    #[tokio::test]
    async fn run_tree_control_disarmed_guard_keeps_the_holder() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::Both, false);
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        TreeGuard::prepare(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn the fake CLI");
        let guard = TreeGuard::arm(&child);
        std::fs::write(dir.path().join("armed"), "").expect("open the armed gate");
        assert!(guard.is_armed(), "the guard armed");
        assert!(
            started_within(&holder, HANG_GUARD).await,
            "the holder never started"
        );
        guard.disarm();
        child.kill().await.expect("kill and reap the fake CLI");
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with a disarmed guard and a direct kill"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }

    /// A forced end's kill takes the whole tree at once, while the run still holds its
    /// armed guard and has yet to reap the leader: the job's terminate on Windows, the
    /// group signal on unix.
    #[tokio::test]
    async fn run_tree_kill_takes_the_holder_while_the_guard_is_held() {
        let dir = tree_dir();
        let holder = Holder::new(dir.path());
        let (bin, args) = fake_agent(dir.path(), &holder, Keeps::Both, false);
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        TreeGuard::prepare(&mut cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn the fake CLI");
        let guard = TreeGuard::arm(&child);
        std::fs::write(dir.path().join("armed"), "").expect("open the armed gate");
        assert!(guard.is_armed(), "the guard armed");
        assert!(
            started_within(&holder, HANG_GUARD).await,
            "the holder never started"
        );
        kill_process_tree(&mut child, &guard);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived the kill while the guard was held"
        );
        drop(guard);
        let _ = child.wait().await;
        remove_when_free(dir);
    }

    /// The guard's decision over all 16 inputs: unix disarms exactly when the leader
    /// was reaped; Windows only when reaped, a session and not forced; an unreaped
    /// leader never disarms.
    #[test]
    fn run_tree_guard_disarm_table() {
        // ((unix, reaped, kill_tree_on_exit, forced), disarms)
        let table = [
            ((true, true, true, true), true),
            ((true, true, true, false), true),
            ((true, true, false, true), true),
            ((true, true, false, false), true),
            ((true, false, true, true), false),
            ((true, false, true, false), false),
            ((true, false, false, true), false),
            ((true, false, false, false), false),
            ((false, true, true, true), false),
            ((false, true, true, false), false),
            ((false, true, false, true), false),
            ((false, true, false, false), true),
            ((false, false, true, true), false),
            ((false, false, true, false), false),
            ((false, false, false, true), false),
            ((false, false, false, false), false),
        ];
        let inputs: HashSet<_> = table.iter().map(|(input, _)| *input).collect();
        assert_eq!(inputs.len(), 16, "every input combination, once");
        for ((unix, reaped, kill_tree_on_exit, forced), disarms) in table {
            assert_eq!(
                tree_guard_disarms(unix, reaped, kill_tree_on_exit, forced),
                disarms,
                "unix {unix}, reaped {reaped}, kill_tree_on_exit {kill_tree_on_exit}, forced {forced}"
            );
        }
    }

    /// The body of the first fn whose header starts at `head`, as the wiring pins read
    /// it: CRLF normalised, whole comment lines dropped, all whitespace stripped, and a
    /// comma directly before `)` dropped (rustfmt adds one when it breaks a call across
    /// lines).
    pub(super) fn stripped_fn_body(src: &str, head: &str) -> Option<String> {
        let src = src.replace("\r\n", "\n");
        let start = src.find(head)?;
        let open = start + src[start..].find("{\n")? + 2;
        let close = open + src[open..].find("\n}\n")?;
        let code: String = src[open..close]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect();
        let stripped: String = code.split_whitespace().collect();
        Some(stripped.replace(",)", ")"))
    }

    /// stream_agent's body as the wiring pin reads it.
    fn stream_agent_body(src: &str) -> Option<String> {
        stripped_fn_body(src, "async fn stream_agent(")
    }

    /// The statement of `body` that starts with `head`, through its `;`, when exactly
    /// one statement does (a statement starts after `;`, `{`, `}` or an attribute's `]`).
    fn sole_statement<'b>(body: &'b str, head: &str) -> Result<&'b str, String> {
        let starts: Vec<usize> = body
            .match_indices(head)
            .map(|(i, _)| i)
            .filter(|&i| body[..i].ends_with([';', '{', '}', ']']))
            .collect();
        let [i] = starts[..] else {
            return Err(format!("{} statements start `{head}`", starts.len()));
        };
        match body[i..].find(';') {
            Some(end) => Ok(&body[i..=i + end]),
            None => Err(format!("`{head}` has no `;`")),
        }
    }

    const DECISION_CALL: &str = "tree_guard_disarms(cfg!(unix),reaped,kill_tree_on_exit,forced)";
    const DECISION: &str = "iftree_guard_disarms(cfg!(unix),reaped,kill_tree_on_exit,forced){tree.disarm();}else{tree.kill();}";
    const GRACE_KILL: &str = "ifgrace_expired{kill_process_tree(&mutchild,&tree);let_=tokio::time::timeout(CHILD_REAP_GRACE,child.wait()).await;}";
    const CONTAINER_RM: &str = "ifforced{ifletSome((runtime,name))=&container_kill{let_=run_capture(runtime,&[\"rm\",\"-f\",name],DETECT_TIMEOUT).await;}}";

    /// Breaches of the guard decision's wiring in stream_agent's stripped body, one
    /// message per broken rule, each led by its number. No process test reaches them:
    /// no fixture outlives the exit grace, and `let reaped = true;` passes every one.
    fn run_tree_wiring_violations(body: &str) -> Vec<String> {
        let mut bad = Vec::new();
        match sole_statement(body, "letgrace_expired=") {
            Ok(s)
                if ["CHILD_EXIT_GRACE", "child.wait()", ".is_err()"]
                    .iter()
                    .all(|n| s.contains(n)) => {}
            Ok(s) => bad.push(format!(
                "1: grace_expired is not the bounded wait's result: {s}"
            )),
            Err(e) => bad.push(format!("1: {e}")),
        }
        match sole_statement(body, "letforced=") {
            Ok(s)
                if ["cancelled", "timed_out", "grace_expired"]
                    .iter()
                    .all(|n| s.contains(n))
                    && !s.contains("&&")
                    && !s.contains('!') => {}
            Ok(s) => bad.push(format!(
                "2: forced is not cancelled || timed_out || grace_expired: {s}"
            )),
            Err(e) => bad.push(format!("2: {e}")),
        }
        match sole_statement(body, "letreaped=") {
            Ok("letreaped=child.id().is_none();") => {}
            Ok(s) => bad.push(format!("3: reaped is not asked of the child: {s}")),
            Err(e) => bad.push(format!("3: {e}")),
        }
        let calls = body.matches("tree_guard_disarms(").count();
        if calls != 1 || !body.contains(DECISION) {
            bad.push(format!(
                "4: {calls} decision calls, expected one `{DECISION}`"
            ));
        }
        let reap = "child.wait()).await";
        let at = [
            body.rfind(reap).map(|i| i + reap.len()),
            body.find("letforced="),
            body.find(DECISION_CALL),
            body.find("tree.kill()"),
            body.find("\"rm\""),
            body.find("&mutstderr_task"),
        ];
        match at {
            [Some(w), Some(f), Some(d), Some(k), Some(r), Some(j)] => {
                if !(w < f && f < d && d < k && k < r && r < j) {
                    bad.push(
                        "5: the order is not reap, forced, decision, kill, rm, stderr join".into(),
                    );
                } else if body[w..k].contains(".await") {
                    bad.push("5: an await sits between the last reap and the decision".into());
                }
            }
            _ => bad.push(format!("5: a step is missing: {at:?}")),
        }
        let after_spawn = body
            .find("cmd.spawn()")
            .and_then(|s| body[s..].find("?;").map(|q| &body[s + q + 2..]));
        match after_spawn {
            Some(rest)
                if rest.starts_with("lettree=")
                    && rest[..rest.find(';').unwrap_or(rest.len())]
                        .contains("TreeGuard::arm(&child)") => {}
            Some(rest) => bad.push(format!(
                "6: the spawn is not followed by the arm: {}",
                rest.chars().take(80).collect::<String>()
            )),
            None => bad.push("6: no `cmd.spawn()` followed by `?;`".into()),
        }
        // From the first `group_killed` to the last reap: the unix non-reaping wait, the
        // two bounded reaps and the grace wait, so a dropped future between them can only
        // land on an unreaped leader. Rule 5 covers the rest of the way to the decision.
        let span = body
            .find("letgroup_killed=")
            .zip(body.rfind(reap).map(|i| i + reap.len()));
        match span {
            Some((g, w)) if g < w => {
                let awaits = body[g..w].matches(".await").count();
                if awaits != 4 {
                    bad.push(format!(
                        "7: {awaits} awaits from group_killed to the last reap, expected 4"
                    ));
                }
            }
            _ => bad.push(format!("7: no group_killed before the last reap: {span:?}")),
        }
        for (arm, flag) in [
            ("_=&mutdeadline=>{", "timed_out=true;"),
            ("_=cancel.notified()=>{", "cancelled=true;"),
        ] {
            let pinned = format!("{arm}{flag}kill_process_tree(&mutchild,&tree);break;}}");
            if !body.contains(&pinned) {
                bad.push(format!("8: the `{arm}` arm does not set its flag and kill"));
            }
        }
        if body.matches(GRACE_KILL).count() != 1 {
            bad.push("9: an expired grace does not kill the tree, then reap".into());
        }
        if body.matches(CONTAINER_RM).count() != 1 {
            bad.push("10: a forced end does not remove the session container".into());
        }
        bad
    }

    #[test]
    fn run_tree_decision_wiring_is_pinned() {
        let body = stream_agent_body(include_str!("agent.rs")).expect("stream_agent's body");
        assert_eq!(run_tree_wiring_violations(&body), Vec::<String>::new());
        let mutate = |needle: &str, with: &str| {
            assert!(
                body.contains(needle),
                "`{needle}` is not in the stripped body"
            );
            body.replacen(needle, with, 1)
        };
        let breaks = |mutated: &str, rule: &str| {
            let bad = run_tree_wiring_violations(mutated);
            assert!(
                bad.len() == 1 && bad[0].starts_with(rule),
                "expected one violation of rule {rule}: {bad:?}"
            );
        };
        breaks(&mutate("||grace_expired;", ";"), "2");
        let grace = sole_statement(&body, "letgrace_expired=").expect("the grace statement");
        breaks(&mutate(grace, &grace.replace(".is_err()", ".is_ok()")), "1");
        // Dropping the bounded wait altogether also drops one of rule 7's awaits.
        let unbounded = run_tree_wiring_violations(&mutate(grace, "letgrace_expired=false;"));
        let rules: Vec<char> = unbounded.iter().filter_map(|v| v.chars().next()).collect();
        assert_eq!(rules, ['1', '7'], "{unbounded:?}");
        breaks(
            &mutate("letreaped=child.id().is_none();", "letreaped=true;"),
            "3",
        );
        breaks(
            &mutate("letforced=", "tokio::task::yield_now().await;letforced="),
            "5",
        );
        // The decision moved to directly after the container removal, before the join.
        let end = "else{tree.kill();}";
        let from = body.find("letforced=").expect("the decision's start");
        let to = body.find(end).expect("the decision's end") + end.len();
        let lifted = format!("{}{}", &body[..from], &body[to..]);
        let join = lifted.find("letstderr_text=").expect("the stderr join");
        let moved = format!("{}{}{}", &lifted[..join], &body[from..to], &lifted[join..]);
        breaks(&moved, "5");
        breaks(
            &mutate("lettree=", "tokio::task::yield_now().await;lettree="),
            "6",
        );
        let yield_now = "tokio::task::yield_now().await;";
        breaks(
            &mutate("ifgrace_expired{", &format!("{yield_now}ifgrace_expired{{")),
            "7",
        );
        breaks(
            &mutate(
                "letgrace_expired=",
                &format!("{yield_now}letgrace_expired="),
            ),
            "7",
        );
        let kill = "kill_process_tree(&mutchild,&tree);break;}";
        for (arm, flag) in [
            ("_=&mutdeadline=>{", "timed_out=true;"),
            ("_=cancel.notified()=>{", "cancelled=true;"),
        ] {
            let whole = format!("{arm}{flag}{kill}");
            breaks(&mutate(&whole, &format!("{arm}{kill}")), "8");
            breaks(&mutate(&whole, &format!("{arm}{flag}break;}}")), "8");
        }
        breaks(
            &mutate("iftree_guard_disarms(", "if!tree_guard_disarms("),
            "4",
        );
        breaks(
            &mutate(
                "ifgrace_expired{kill_process_tree(&mutchild,&tree);",
                "ifgrace_expired{",
            ),
            "9",
        );
        breaks(
            &mutate("ifforced{iflet", "ifcancelled||timed_out{iflet"),
            "10",
        );
    }

    /// capture_tree's forced end: the tree kill, the bounded reap, then the guard's one
    /// decision with no await since the reap, so a reaped unix leader disarms.
    const CAPTURE_FORCED_END: &str = "kill_process_tree(&mutchild,&tree);let_=tokio::time::timeout(CHILD_REAP_GRACE,child.wait()).await;iftree_guard_disarms(cfg!(unix),child.id().is_none(),true,true){tree.disarm();}failed";

    #[test]
    fn capture_tree_forced_end_is_pinned() {
        let body = stripped_fn_body(include_str!("agent.rs"), "async fn capture_tree(")
            .expect("capture_tree's body");
        let pinned = |b: &str| {
            b.ends_with(CAPTURE_FORCED_END) && b.matches("tree_guard_disarms(").count() == 1
        };
        assert!(pinned(&body), "{body}");
        let decision =
            "iftree_guard_disarms(cfg!(unix),child.id().is_none(),true,true){tree.disarm();}";
        for mutant in [
            body.replacen(decision, "", 1),
            body.replacen(
                decision,
                &format!("tokio::task::yield_now().await;{decision}"),
                1,
            ),
            body.replacen("child.id().is_none()", "true", 1),
        ] {
            assert_ne!(mutant, body);
            assert!(!pinned(&mutant), "{mutant}");
        }
    }

    const SESSION_ID_CHECK: &str = "if!valid_cancel_id(&session_id){returnErr(AppError::InvalidArgument(\"invalidsessionid\".into()));}";
    const RUN_ID_CHECK: &str = "if!valid_cancel_id(&run_id){returnErr(AppError::InvalidArgument(\"invalidrunid\".into()));}";
    const RUN_ID_REGISTER: &str = "letcancel=AgentCancelGuard::register(&state,&run_id);";

    /// agent_session opens with both id checks and then its one registration, keyed on
    /// the per-turn `run_id`: a session id is reused across turns, so a re-sent turn would
    /// share the stopped turn's entry, whose guard then clears it and loses the next Stop.
    #[test]
    fn agent_session_registers_its_run_id() {
        let body = stripped_fn_body(include_str!("agent.rs"), "pub async fn agent_session(")
            .expect("agent_session's body");
        let opening = format!("{SESSION_ID_CHECK}{RUN_ID_CHECK}{RUN_ID_REGISTER}");
        let pinned = |b: &str| {
            b.starts_with(&opening) && b.matches("AgentCancelGuard::register(").count() == 1
        };
        assert!(pinned(&body), "{body}");
        let session_register = RUN_ID_REGISTER.replace("&run_id", "&session_id");
        for mutant in [
            body.replacen(RUN_ID_REGISTER, &session_register, 1),
            body.replacen(RUN_ID_CHECK, "", 1),
            body.replacen(SESSION_ID_CHECK, "", 1),
            body.replacen(
                &format!("{RUN_ID_CHECK}{RUN_ID_REGISTER}"),
                &format!("{RUN_ID_REGISTER}{RUN_ID_CHECK}"),
                1,
            ),
            format!("{body}{session_register}"),
        ] {
            assert_ne!(mutant, body);
            assert!(!pinned(&mutant), "{mutant}");
        }
    }

    /// A container turn's wait for the session gate ends on a Stop, fired during the
    /// wait or stored before it, without disturbing the holder or the next waiter.
    #[tokio::test]
    async fn container_wait_ends_on_a_stop() {
        const LONG: Duration = Duration::from_secs(5);
        let state = Arc::new(AppState::default());
        let waiter = |notify: Arc<Notify>| {
            let state = Arc::clone(&state);
            tokio::spawn(async move {
                wait_for_session_container(&state, "s1", &notify)
                    .await
                    .is_some()
            })
        };

        // (i) A Stop fired mid-wait ends the wait while the holder still holds.
        let holder = state.hold_session_container("s1").await;
        let stop = Arc::new(Notify::new());
        let stopped = waiter(Arc::clone(&stop));
        state.until_session_container_refs("s1", 2).await;
        assert!(!stopped.is_finished(), "(i) the waiter parks");
        stop.notify_one();
        let acquired = tokio::time::timeout(LONG, stopped)
            .await
            .expect("(i) the stopped wait ends")
            .expect("(i) the waiter's task");
        assert!(!acquired, "(i)");

        // (iv) The next waiter still waits for the holder.
        let next = waiter(Arc::new(Notify::new()));
        state.until_session_container_refs("s1", 2).await;
        assert!(!next.is_finished(), "(iv)");
        drop(holder);
        let acquired = tokio::time::timeout(LONG, next)
            .await
            .expect("(iv) the next wait ends once the holder drops")
            .expect("(iv) the waiter's task");
        assert!(acquired, "(iv)");

        // (ii) A free gate with a stored permit: the turn was stopped. Both arms are
        // ready at once, so the repeats make an unbiased select lose with near certainty.
        for round in 0..64 {
            let stored = Notify::new();
            stored.notify_one();
            assert!(
                wait_for_session_container(&state, "s2", &stored)
                    .await
                    .is_none(),
                "(ii) round {round}"
            );
        }
        // (iii) A free gate and no Stop.
        assert!(
            wait_for_session_container(&state, "s2", &Notify::new())
                .await
                .is_some(),
            "(iii)"
        );
    }

    const CONTAINER_WAIT: &str = "letSome(_container_hold)=wait_for_session_container(&state,&session_id,&cancel.notify).awaitelse{returnOk(None);};";
    const OPENCODE_CONTAINER_DISPATCH: &str =
        "ifkind==AgentKind::Opencode{returnBox::pin(opencode2_container_session(";

    /// A container turn takes the session gate once, after the `..` refusal and before
    /// the opencode dispatch and the home seeding, bound to a name so it is held until
    /// agent_session returns; the host part never takes it.
    #[test]
    fn container_turns_wait_for_the_session_container() {
        let body = stripped_fn_body(include_str!("agent.rs"), "pub async fn agent_session(")
            .expect("agent_session's body");
        let pinned = |b: &str| {
            let (Some(at), Some(parent), Some(dispatch)) = (
                b.find(CONTAINER_WAIT),
                b.find("std::path::Component::ParentDir"),
                b.find(OPENCODE_CONTAINER_DISPATCH),
            ) else {
                return false;
            };
            b.matches(CONTAINER_WAIT).count() == 1
                && b.matches("wait_for_session_container(").count() == 1
                && b.matches("_container_hold").count() == 1
                && parent < at
                && at < dispatch
        };
        assert!(pinned(&body), "{body}");
        let seed = "lethome=crate::agent_sandbox::seed_session_home(";
        let host = "letbinary=matchopencode_v1_binary";
        assert!(body.contains(seed) && body.contains(host));
        for mutant in [
            body.replacen(CONTAINER_WAIT, "", 1).replacen(
                seed,
                &format!("{CONTAINER_WAIT}{seed}"),
                1,
            ),
            body.replacen("letSome(_container_hold)=", "letSome(_)=", 1),
            body.replacen(
                CONTAINER_WAIT,
                &format!("{CONTAINER_WAIT}drop(_container_hold);"),
                1,
            ),
            body.replacen(CONTAINER_WAIT, "", 1),
            body.replacen(host, &format!("{CONTAINER_WAIT}{host}"), 1),
        ] {
            assert_ne!(mutant, body);
            assert!(!pinned(&mutant), "{mutant}");
        }
    }

    /// A fresh turn (agent_session's own first-turn joins and both opencode 2 paths)
    /// joins its prompts through `turn_one_prompt`, so a blank system prompt sends no
    /// leading blank lines.
    #[test]
    fn fresh_session_prompts_join_through_turn_one_prompt() {
        let src = include_str!("agent.rs");
        let join = "format!(\"{system_prompt}\\n\\n";
        for (head, calls) in [
            ("pub async fn agent_session(", 3),
            ("async fn opencode2_host_session(", 1),
            ("async fn opencode2_container_session(", 1),
        ] {
            let pinned =
                |b: &str| b.matches("turn_one_prompt(").count() == calls && !b.contains(join);
            let body = stripped_fn_body(src, head).expect(head);
            assert!(pinned(&body), "{head}: {body}");
            for mutant in [
                // One call swapped for the bare user prompt.
                {
                    let at = body.find("turn_one_prompt(").expect(head);
                    let end = at + body[at..].find(')').expect(head) + 1;
                    format!("{}user_prompt{}", &body[..at], &body[end..])
                },
                body.replacen(
                    "turn_one_prompt(",
                    "format!(\"{system_prompt}\\n\\n{}{}\",",
                    1,
                ),
                format!("{body}{join}{{x}}\")"),
            ] {
                assert_ne!(mutant, body);
                assert!(!pinned(&mutant), "{head}: {mutant}");
            }
        }
    }

    const RESTART_REBIND_TEXT: &str = "let(resume,native_session_id)=ifopencode_v1_restart{(false,None)}else{(resume,native_session_id)};";
    const FRESH_START: &str =
        "letfresh_start=resume_starts_fresh(kind,container,resume,native_session_id.as_deref());";
    const FRESH_REBIND: &str = "letresume=resume&&!fresh_start;";
    const FRESH_CANCEL: &str = "ifturn_cancel_fired(&cancel.notify){returnOk(None);}";
    const FRESH_NOTE: &str = "EventSink::send(&on_event,ReviewEvent::Notice{code:NOTICE_SESSION_RESET,text:fresh_start_note(kind),});";

    /// A host turn that starts fresh decides so right after the 1.x restart rebinding,
    /// before the argv is built, and tells of it after the host env and right before the
    /// host spawn, unless its cancel already fired.
    #[test]
    fn host_fresh_start_is_noted_before_its_spawn() {
        let body = stripped_fn_body(include_str!("agent.rs"), "pub async fn agent_session(")
            .expect("agent_session's body");
        let block = format!("iffresh_start{{{FRESH_CANCEL}{FRESH_NOTE}}}");
        let pinned = |b: &str| {
            let (
                Some(rebind),
                Some(start),
                Some(again),
                Some(inner),
                Some(env),
                Some(at),
                Some(spawn),
            ) = (
                b.find(RESTART_REBIND_TEXT),
                b.find(FRESH_START),
                b.find(FRESH_REBIND),
                b.find("let(inner,stdin_text)"),
                b.find("lethost_extra_env"),
                b.find(&block),
                b.rfind("stream_agent("),
            )
            else {
                return false;
            };
            b.matches(FRESH_START).count() == 1
                && b.matches(FRESH_REBIND).count() == 1
                && b.matches(&block).count() == 1
                && rebind < start
                && start < again
                && again < inner
                && env < at
                && at < spawn
        };
        assert!(pinned(&body), "{body}");
        let host = "letbinary=matchopencode_v1_binary";
        assert!(body.contains(host));
        for mutant in [
            body.replacen(&block, "", 1)
                .replacen(host, &format!("{block}{host}"), 1),
            body.replacen(FRESH_CANCEL, "", 1),
            body.replacen(FRESH_START, "", 1).replacen(
                RESTART_REBIND_TEXT,
                &format!("{FRESH_START}{RESTART_REBIND_TEXT}"),
                1,
            ),
        ] {
            assert_ne!(mutant, body);
            assert!(!pinned(&mutant), "{mutant}");
        }
    }

    /// kill_process_tree's body as its pin reads it.
    fn kill_process_tree_body(src: &str) -> Option<String> {
        stripped_fn_body(src, "\nfn kill_process_tree(")
    }

    /// kill_process_tree's whole stripped body. Before updating it, re-check the three
    /// effects: the Windows block (an armed guard terminates the job, an unarmed one spawns
    /// `taskkill /F /T /PID`), the unix group kill under `#[cfg(unix)]`, and the leader's
    /// direct kill as the last statement.
    const KILL_TREE_BODY: &str = "#[cfg(not(windows))]let_=tree;letSome(pid)=child.id()else{let_=child.start_kill();return;};#[cfg(windows)]{iftree.is_armed(){tree.terminate();}else{usestd::os::windows::process::CommandExt;let_=std::process::Command::new(\"taskkill\").args([\"/F\",\"/T\",\"/PID\",&pid.to_string()]).creation_flags(0x0800_0000)//CREATE_NO_WINDOW.spawn();}}#[cfg(unix)]crate::proc_tree::kill_process_group(pid);let_=child.start_kill();";
    const KILL_LEADER: &str = "let_=child.start_kill();";

    /// An equality pin over the whole body, so it needs no mutation controls (there is no
    /// scanner to evade); the asserts on the const's own text keep an update from dropping
    /// an effect.
    #[test]
    fn run_tree_kill_wiring_is_pinned() {
        let body = kill_process_tree_body(include_str!("agent.rs")).expect("its body");
        assert_eq!(
            body, KILL_TREE_BODY,
            "kill_process_tree changed: before updating KILL_TREE_BODY, re-check that an armed \
             Windows guard terminates the job and an unarmed one spawns `taskkill /F /T /PID`, \
             that the unix group kill sits under `#[cfg(unix)]`, and that the leader's direct \
             kill is the last statement"
        );
        for effect in [
            "#[cfg(windows)]{iftree.is_armed(){tree.terminate();}else{",
            "let_=std::process::Command::new(\"taskkill\").args([\"/F\",\"/T\",\"/PID\",&pid.to_string()]).creation_flags(0x0800_0000)//CREATE_NO_WINDOW.spawn();}}",
            "#[cfg(unix)]crate::proc_tree::kill_process_group(pid);",
        ] {
            assert!(
                KILL_TREE_BODY.contains(effect),
                "the pinned body lost `{effect}`"
            );
        }
        assert_eq!(
            KILL_TREE_BODY.matches(KILL_LEADER).count(),
            2,
            "the early return's direct kill and the last statement's"
        );
        assert!(
            KILL_TREE_BODY.ends_with(KILL_LEADER),
            "the leader's direct kill ends the body"
        );
    }

    /// Each `stream_agent(` call in `text` (definitions skipped): the column-0 fn it sits
    /// in, and its arguments' trimmed byte ranges, split at top-level commas.
    fn stream_agent_calls(text: &str) -> Vec<(String, Vec<std::ops::Range<usize>>)> {
        let mut fn_at = Vec::new();
        let mut offset = 0;
        for line in text.split('\n') {
            if let Some(name) = crate::github::runner::tree_fixture::fn_name(line) {
                fn_at.push((offset, name));
            }
            offset += line.len() + 1;
        }
        let mut calls = Vec::new();
        for (at, call) in text.match_indices("stream_agent(") {
            let before = &text[..at];
            if before.ends_with(|c: char| c.is_alphanumeric() || c == '_')
                || before.ends_with("fn ")
            {
                continue;
            }
            let caller = fn_at.iter().rev().find(|(start, _)| *start < at);
            let caller = caller.map_or("?", |(_, name)| name).to_string();
            let open = at + call.len();
            let (mut depth, mut args, mut from) = (0usize, Vec::new(), open);
            for (i, c) in text[open..].char_indices() {
                match c {
                    '(' | '[' | '{' => depth += 1,
                    ')' | ']' | '}' if depth == 0 => {
                        args.push(from..open + i);
                        break;
                    }
                    ')' | ']' | '}' => depth -= 1,
                    ',' if depth == 0 => {
                        args.push(from..open + i);
                        from = open + i + 1;
                    }
                    _ => {}
                }
            }
            let trimmed = args.into_iter().map(|r| {
                let lead = text[r.clone()].len() - text[r.clone()].trim_start().len();
                r.start + lead..r.start + lead + text[r].trim().len()
            });
            calls.push((caller, trimmed.collect()));
        }
        calls
    }

    /// stream_agent's run-kind argument (its eleventh) at each production call: reviews
    /// kill the tree at every exit, sessions keep it on a clean end. A flip keeps every
    /// process test green, since those call stream_agent directly. The bare name appears
    /// only in its definition and those calls, so an alias can't add an unread call.
    fn run_kind_violations(text: &str) -> Vec<String> {
        let mut bad = Vec::new();
        let found: Vec<String> = stream_agent_calls(text)
            .into_iter()
            .map(|(caller, args)| {
                let kind = args.get(10).map_or("", |r| &text[r.clone()]);
                format!("{caller}:{kind}")
            })
            .collect();
        let expected = [
            "agent_review:true",
            "agent_session:false",
            "agent_session:false",
            "opencode2_review:true",
            "opencode2_host_session:false",
            "opencode2_container_session:false",
        ];
        if found != expected {
            bad.push(format!(
                "the run kinds are {found:?}, expected {expected:?}"
            ));
        }
        let ident = |c: char| c.is_alphanumeric() || c == '_';
        let named = text
            .match_indices("stream_agent")
            .filter(|(at, name)| {
                !text[..*at].ends_with(ident) && !text[at + name.len()..].starts_with(ident)
            })
            .count();
        if named != 1 + expected.len() {
            bad.push(format!(
                "`stream_agent` is named {named} times, not in its definition and {} calls only",
                expected.len()
            ));
        }
        bad
    }

    #[test]
    fn run_tree_callers_pass_their_run_kind() {
        let src = include_str!("agent.rs").replace("\r\n", "\n");
        let mut misread = Vec::new();
        let text = crate::github::runner::tree_fixture::production_text(&src, &mut misread);
        assert_eq!(misread, Vec::<String>::new());
        assert_eq!(run_kind_violations(&text), Vec::<String>::new());
        let calls = stream_agent_calls(&text);
        for (n, (caller, args)) in calls.iter().enumerate() {
            let span = args[10].clone();
            let flipped = if &text[span.clone()] == "true" {
                "false"
            } else {
                "true"
            };
            let text = format!("{}{flipped}{}", &text[..span.start], &text[span.end..]);
            let bad = run_kind_violations(&text);
            assert_eq!(bad.len(), 1, "flipping call {n} in {caller}: {bad:?}");
        }
        // An added or dropped call also moves the name count.
        let extra = format!("{text}\nfn extra() {{\n    stream_agent(a, b, c, d, e, f, g, h, i, None, false, j, k);\n}}\n");
        assert_eq!(run_kind_violations(&extra).len(), 2, "an extra call");
        let missing = text.replacen("return stream_agent(", "return other_agent(", 1);
        assert_ne!(missing, text);
        assert_eq!(run_kind_violations(&missing).len(), 2, "a missing call");
        let alias = format!("{text}\nfn extra() {{\n    let run = stream_agent;\n}}\n");
        let bad = run_kind_violations(&alias);
        assert!(
            bad.len() == 1 && bad[0].starts_with("`stream_agent` is named 8 times"),
            "an alias: {bad:?}"
        );
    }

    #[test]
    fn review_timeout_falls_back_to_the_tier_default() {
        assert_eq!(review_timeout(false, None), Duration::from_secs(300));
        assert_eq!(review_timeout(true, None), Duration::from_secs(1200));
        // A zero override is "no override", not an instant kill.
        assert_eq!(review_timeout(true, Some(0)), Duration::from_secs(1200));
        assert_eq!(review_timeout(false, Some(0)), Duration::from_secs(300));
    }

    #[test]
    fn review_timeout_clamps_and_overrides_both_tiers() {
        assert_eq!(review_timeout(true, Some(30)), Duration::from_secs(60));
        assert_eq!(review_timeout(true, Some(999_999)), Duration::from_secs(7200));
        // The override wins regardless of tier — even below the agentic default.
        assert_eq!(review_timeout(false, Some(1500)), Duration::from_secs(1500));
    }

    #[test]
    fn timeout_message_hints_only_when_the_flag_is_set() {
        let msg = timeout_message("review", Duration::from_secs(1200), true);
        assert_eq!(
            msg,
            "The review timed out after 20 minutes. You can adjust the limit in Settings → AI."
        );
        assert!(msg.contains("Settings → AI."));
        // Same noun, no flag — generation / Debug-with-AI also run `agent_review`,
        // and the setting doesn't reach them.
        let plain = timeout_message("review", Duration::from_secs(300), false);
        assert_eq!(plain, "The review timed out after 5 minutes.");
        assert!(!plain.contains("Settings"));
        assert_eq!(
            timeout_message("session", Duration::from_secs(1800), false),
            "The session timed out after 30 minutes."
        );
    }

    #[test]
    fn human_duration_prefers_whole_minutes() {
        assert_eq!(human_duration(60), "1 minute");
        assert_eq!(human_duration(1200), "20 minutes");
        assert_eq!(human_duration(90), "90 seconds");
        assert_eq!(human_duration(7200), "120 minutes");
    }
}

/// The login-shell probe's group kill on a real `/bin/sh`: a fixture HOME whose
/// `.profile` starts a holder in the background, and a script that blocks until the
/// test creates `go`, so every event under test lands after the holder started.
#[cfg(all(test, unix))]
mod login_shell_probe_tests {
    use super::{
        capture_marker, capture_pair_closed, configure_probe_shell, marker_wrapped_script,
        read_until_marker_pair, run_probe_shell, SHELL_PATH_CAPTURE_CAP,
    };
    use crate::proc_tree::test_support::{wait_until, Holder, HostShell, Keeps, HANG_GUARD};
    use std::path::Path;
    use tokio::process::Command;

    /// Blocks until `$HOME/go` exists, polling with a real delay step; gives up after
    /// about 15 minutes so a failed test leaks no shell for long.
    const WAIT_FOR_GO: &str =
        r#"n=0; until [ -e "$HOME/go" ] || [ "$n" -ge 9000 ]; do sleep 0.1; n=$((n+1)); done"#;

    fn temp(case: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("gd-probe-{case}-"))
            .tempdir()
            .expect("create temp dir")
    }

    /// `/bin/sh` with `dir` as HOME and no `ENV`, whose `.profile` starts `holder`.
    fn probe_shell(dir: &Path, holder: &Holder, keeps: Keeps) -> Command {
        let snippet = holder.launch_snippet(HostShell::Sh, keeps);
        std::fs::write(dir.join(".profile"), format!("{snippet}\n")).expect("write .profile");
        let mut cmd = Command::new("/bin/sh");
        cmd.env("HOME", dir).env_remove("ENV");
        cmd
    }

    fn go(dir: &Path) {
        std::fs::write(dir.join("go"), "").expect("create the go file");
    }

    fn assert_started(holder: &Holder) {
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder never started"
        );
    }

    fn assert_dies(holder: &Holder, what: &str) {
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder outlived {what}"
        );
    }

    /// A probe that reads its pair returns the bytes, then kills the rc job, which
    /// keeps the probe's stdout pipe open.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_probe_that_reads_its_pair_kills_what_its_rc_files_started() {
        let dir = temp("success");
        let holder = Holder::new(dir.path());
        let cmd = probe_shell(dir.path(), &holder, Keeps::Both);
        let marker = capture_marker();
        let script = marker_wrapped_script(&marker, WAIT_FOR_GO);
        let probe = tokio::spawn({
            let marker = marker.clone();
            async move { run_probe_shell(cmd, &script, &marker, std::future::pending()).await }
        });
        assert_started(&holder);
        go(dir.path());
        let got = tokio::time::timeout(HANG_GUARD, probe)
            .await
            .expect("the probe returns once its pair closes")
            .expect("the probe task");
        let buf = got.expect("the probe read its pair");
        assert!(capture_pair_closed(&buf, marker.as_bytes()), "{buf:?}");
        assert_dies(&holder, "a probe that read its pair");
    }

    /// The deadline is a future the test completes once the holder runs, so no budget
    /// races the shell's startup.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_probe_at_its_deadline_kills_what_its_rc_files_started() {
        let dir = temp("timeout");
        let holder = Holder::new(dir.path());
        let cmd = probe_shell(dir.path(), &holder, Keeps::Both);
        let marker = capture_marker();
        let script = marker_wrapped_script(&marker, WAIT_FOR_GO);
        let (fire, fired) = tokio::sync::oneshot::channel::<()>();
        let probe = tokio::spawn(async move {
            let deadline = async move {
                let _ = fired.await;
            };
            run_probe_shell(cmd, &script, &marker, deadline).await
        });
        assert_started(&holder);
        fire.send(())
            .expect("the probe still waits on its deadline");
        let got = tokio::time::timeout(HANG_GUARD, probe)
            .await
            .expect("the probe returns at its deadline")
            .expect("the probe task");
        assert_eq!(got, None);
        assert_dies(&holder, "a probe past its deadline");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_probe_kills_what_its_rc_files_started() {
        let dir = temp("drop");
        let holder = Holder::new(dir.path());
        let cmd = probe_shell(dir.path(), &holder, Keeps::Both);
        let marker = capture_marker();
        let script = marker_wrapped_script(&marker, WAIT_FOR_GO);
        let probe = tokio::spawn(async move {
            run_probe_shell(cmd, &script, &marker, std::future::pending()).await
        });
        assert_started(&holder);
        probe.abort();
        let ended = tokio::time::timeout(HANG_GUARD, probe)
            .await
            .expect("the aborted probe ends");
        assert!(
            ended.is_err_and(|e| e.is_cancelled()),
            "the probe was cancelled"
        );
        assert_dies(&holder, "a dropped probe");
    }

    /// The shell prints only the pair's opening marker and exits; the holder keeps
    /// neither pipe, so the read meets EOF while the holder lives.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_probe_that_meets_eof_kills_what_its_rc_files_started() {
        let dir = temp("eof");
        let holder = Holder::new(dir.path());
        let cmd = probe_shell(dir.path(), &holder, Keeps::Neither);
        let marker = capture_marker();
        let script = format!("{WAIT_FOR_GO}; printf '%s' '{marker}'");
        let probe = tokio::spawn(async move {
            run_probe_shell(cmd, &script, &marker, std::future::pending()).await
        });
        assert_started(&holder);
        go(dir.path());
        let got = tokio::time::timeout(HANG_GUARD, probe)
            .await
            .expect("the probe returns at EOF")
            .expect("the probe task");
        assert_eq!(got, None);
        assert_dies(&holder, "a probe that met EOF");
    }

    #[tokio::test]
    async fn a_probe_that_cannot_spawn_returns_none() {
        let cmd = Command::new("/nonexistent/gd-probe-shell");
        let marker = capture_marker();
        let script = marker_wrapped_script(&marker, ":");
        let got = run_probe_shell(cmd, &script, &marker, std::future::pending()).await;
        assert_eq!(got, None);
    }

    /// The control that proves the kill is the guard's: the same fixture spawned with no
    /// guard, its shell killed alone and reaped, leaves the rc job running.
    #[tokio::test]
    async fn an_unguarded_probe_shell_killed_alone_leaves_its_rc_job_running() {
        let dir = temp("control");
        let holder = Holder::new(dir.path());
        let mut cmd = probe_shell(dir.path(), &holder, Keeps::Both);
        let marker = capture_marker();
        configure_probe_shell(&mut cmd, &marker_wrapped_script(&marker, WAIT_FOR_GO));
        let mut child = cmd.spawn().expect("spawn the probe shell");
        let mut stdout = child.stdout.take().expect("a piped stdout");
        assert_started(&holder);
        go(dir.path());
        let read = read_until_marker_pair(&mut stdout, marker.as_bytes(), SHELL_PATH_CAPTURE_CAP);
        let got = tokio::time::timeout(HANG_GUARD, read)
            .await
            .expect("the read returns once the pair closes");
        assert!(got.is_some(), "the shell printed its pair");
        child.kill().await.expect("kill and reap the shell");
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with the shell killed alone"
        );
        holder.release();
        assert_dies(&holder, "its release");
    }
}

/// Source pins over the login-shell probe, and the resolver's miss cache driven with
/// an injected capture, clock and probe.
#[cfg(test)]
mod login_shell_tests {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::fmt::Debug;
    use std::future::Future;
    use std::path::PathBuf;
    use std::pin::{pin, Pin};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tokio::sync::{mpsc, watch};

    use super::LoginShellProbe::{Failed, Found, Missing};
    use super::{
        resolve_via_login_shell_with, LoginShellMisses, LoginShellProbe, MissEntry,
        LOGIN_SHELL_CACHE_CAP,
    };
    use super::tests::stripped_fn_body;
    use crate::proc_tree::test_support::HANG_GUARD;

    /// Breaches of the probe's guard shape in `src` (this file's text). Each body is
    /// found by its header at a line start, so the indented test text never stands in
    /// for a production fn, and read through [`stripped_fn_body`]. No test runs the
    /// wrapper, so this is its only guard.
    fn probe_guard_violations(src: &str) -> Vec<String> {
        let mut bad = Vec::new();
        let mut core = None;
        for (name, header) in [
            ("run_login_shell", "\nasync fn run_login_shell("),
            ("configure_probe_shell", "\nfn configure_probe_shell("),
            ("run_probe_shell", "\nasync fn run_probe_shell("),
        ] {
            let Some(code) = stripped_fn_body(src, header) else {
                bad.push(format!("no {name} at a line start"));
                continue;
            };
            for token in ["prepare(", "process_group("] {
                if code.contains(token) {
                    bad.push(format!("{name} calls {token}"));
                }
            }
            // The group kill relies on the shell leading a session of its own, and the
            // wrapper reaches the shell only through the guarded core.
            let required = match name {
                "configure_probe_shell" => "libc::setsid()",
                "run_probe_shell" => "configure_probe_shell(",
                _ => "run_probe_shell(",
            };
            if !code.contains(required) {
                bad.push(format!("{name} does not call {required}"));
            }
            if name == "run_login_shell" && code.contains(".spawn()") {
                bad.push("run_login_shell spawns a child of its own".into());
            }
            if name == "run_probe_shell" {
                core = Some(code);
            }
        }
        if let Some(core) = core {
            let armed = concat!(
                "letmutchild=cmd.spawn().ok()?;",
                "let_tree=crate::proc_tree::TreeGuard::arm(&child);",
            );
            if !core.contains(armed) {
                bad.push("run_probe_shell does not arm its guard right after the spawn".into());
            }
            if core.contains("disarm(") {
                bad.push("run_probe_shell disarms its guard".into());
            }
        }
        bad
    }

    /// The probe runs only through its core, which configures a setsid shell, arms a tree
    /// guard on it and never groups or disarms it. Each control mutates the real text in
    /// memory and must add exactly the violation it names.
    #[test]
    fn the_login_shell_probe_arms_its_tree_guard() {
        let src = include_str!("agent.rs").replace("\r\n", "\n");
        assert_eq!(probe_guard_violations(&src), Vec::<String>::new());

        // Replaces the first `from` inside the fn headed `header`.
        let edit = |header: &str, from: &str, to: &str| -> String {
            let start = src.find(header).unwrap_or_else(|| panic!("{header:?}"));
            let end = start + src[start..].find("\n}\n").expect("the fn's closing line");
            let at = start
                + src[start..end]
                    .find(from)
                    .unwrap_or_else(|| panic!("{from:?} in {header:?}"));
            format!("{}{to}{}", &src[..at], &src[at + from.len()..])
        };
        let core = "\nasync fn run_probe_shell(";
        let helper = "\nfn configure_probe_shell(";
        let wrapper = "\nasync fn run_login_shell(";
        let spawn = "    let mut child = cmd.spawn().ok()?;\n";
        let arm = "    let _tree = crate::proc_tree::TreeGuard::arm(&child);\n";
        let lic = "    cmd.arg(\"-lic\")";
        let sanitize = "    sanitize_child_env(&mut cmd);\n";
        let group = "    cmd.process_group(0);\n";
        let prepare_mut = "    crate::proc_tree::TreeGuard::prepare(&mut cmd);\n";
        let prepare_ref = "    crate::proc_tree::TreeGuard::prepare(cmd);\n";
        let not_armed = "does not arm its guard";
        let controls = [
            (
                edit(core, &format!("{spawn}{arm}"), &format!("{arm}{spawn}")),
                not_armed,
            ),
            (edit(core, "let _tree =", "let _ ="), not_armed),
            (
                edit(
                    core,
                    arm,
                    "    // let _tree = crate::proc_tree::TreeGuard::arm(&child);\n",
                ),
                not_armed,
            ),
            (
                edit(core, arm, &format!("{arm}    _tree.disarm();\n")),
                "disarms its guard",
            ),
            (
                edit(core, spawn, &format!("{group}{spawn}")),
                "run_probe_shell calls process_group(",
            ),
            (
                edit(core, spawn, &format!("{prepare_mut}{spawn}")),
                "run_probe_shell calls prepare(",
            ),
            (
                edit(helper, lic, &format!("{group}{lic}")),
                "configure_probe_shell calls process_group(",
            ),
            (
                edit(helper, lic, &format!("{prepare_ref}{lic}")),
                "configure_probe_shell calls prepare(",
            ),
            (
                edit(wrapper, sanitize, &format!("{sanitize}{prepare_mut}")),
                "run_login_shell calls prepare(",
            ),
            (
                edit(wrapper, sanitize, &format!("{sanitize}{group}")),
                "run_login_shell calls process_group(",
            ),
            (
                src.replacen(core, "\nasync fn run_probe_shell_renamed(", 1),
                "no run_probe_shell at a line start",
            ),
            (
                edit(helper, "libc::setsid()", "libc::getpid()"),
                "configure_probe_shell does not call libc::setsid()",
            ),
            (
                edit(core, "    configure_probe_shell(&mut cmd, script);\n", ""),
                "run_probe_shell does not call configure_probe_shell(",
            ),
            (
                edit(wrapper, "run_probe_shell(", "run_other_shell("),
                "run_login_shell does not call run_probe_shell(",
            ),
            (
                edit(
                    wrapper,
                    sanitize,
                    &format!("{sanitize}    let _ = cmd.spawn();\n"),
                ),
                "run_login_shell spawns a child of its own",
            ),
        ];
        for (text, mark) in &controls {
            assert_ne!(text, &src, "the `{mark}` control must change the text");
            let bad = probe_guard_violations(text);
            assert!(
                bad.len() == 1 && bad[0].contains(mark),
                "the `{mark}` control: {bad:?}"
            );
        }
    }

    /// One test's cache, capture and clock, and a probe that counts its runs, reports
    /// each start on the receiver [`rig`] returns, and parks until its name is answered.
    struct Rig {
        cache: Mutex<LoginShellMisses>,
        capture: RefCell<Option<String>>,
        t0: Instant,
        clock: Cell<Instant>,
        runs: RefCell<Vec<String>>,
        entered: mpsc::UnboundedSender<String>,
        answers: watch::Sender<HashMap<String, LoginShellProbe>>,
    }

    fn rig(capture: Option<&str>) -> (Rig, mpsc::UnboundedReceiver<String>) {
        let (entered, started) = mpsc::unbounded_channel();
        let t0 = Instant::now();
        let rig = Rig {
            cache: Mutex::default(),
            capture: RefCell::new(capture.map(str::to_owned)),
            t0,
            clock: Cell::new(t0),
            runs: RefCell::default(),
            entered,
            answers: watch::channel(HashMap::new()).0,
        };
        (rig, started)
    }

    impl Rig {
        fn call<'a>(&'a self, names: &'a [&'a str]) -> impl Future<Output = Option<PathBuf>> + 'a {
            resolve_via_login_shell_with(
                names,
                &self.cache,
                move || self.capture.borrow().clone(),
                move || self.clock.get(),
                move |name, _body| self.probe(name),
            )
        }

        fn probe(&self, name: String) -> Pin<Box<dyn Future<Output = LoginShellProbe>>> {
            self.runs.borrow_mut().push(name.clone());
            let _ = self.entered.send(name.clone());
            let mut answers = self.answers.subscribe();
            Box::pin(async move {
                let answered = answers.wait_for(|a| a.contains_key(&name)).await;
                answered.expect("the rig outlives its probes")[&name].clone()
            })
        }

        fn answer(&self, name: &str, outcome: LoginShellProbe) {
            self.answers.send_modify(|a| {
                a.insert(name.to_owned(), outcome);
            });
        }

        fn unanswer(&self, name: &str) {
            self.answers.send_modify(|a| {
                a.remove(name);
            });
        }

        fn runs(&self, name: &str) -> usize {
            self.runs.borrow().iter().filter(|n| *n == name).count()
        }

        fn at(&self, secs: u64) {
            self.clock.set(self.t0 + Duration::from_secs(secs));
        }

        fn set_capture(&self, capture: Option<&str>) {
            *self.capture.borrow_mut() = capture.map(str::to_owned);
        }

        fn entry(&self, name: &str) -> Option<MissEntry> {
            self.cache.lock().unwrap().entries.get(name).copied()
        }
    }

    fn path(p: &str) -> PathBuf {
        PathBuf::from(p)
    }

    async fn within<F: std::future::IntoFuture>(fut: F) -> F::Output {
        tokio::time::timeout(HANG_GUARD, fut)
            .await
            .expect("a wait hung to HANG_GUARD")
    }

    /// Polls `fut` until its probe of `name` has started; it is then parked in it.
    async fn park<F>(fut: &mut F, started: &mut mpsc::UnboundedReceiver<String>, name: &str)
    where
        F: Future + Unpin,
        F::Output: Debug,
    {
        within(async {
            loop {
                tokio::select! {
                    biased;
                    out = &mut *fut => panic!("finished with {out:?} before probing {name}"),
                    got = started.recv() => if got.as_deref() == Some(name) {
                        return;
                    },
                }
            }
        })
        .await;
    }

    /// Polls `fut` once and requires it to wait.
    async fn waits<F>(fut: &mut F, who: &str)
    where
        F: Future + Unpin,
        F::Output: Debug,
    {
        tokio::select! {
            biased;
            out = fut => panic!("{who} did not wait: {out:?}"),
            () = std::future::ready(()) => {}
        }
    }

    #[tokio::test]
    async fn a_measured_miss_is_probed_once_per_capture() {
        let (rig, _started) = rig(Some("/a:/b"));
        rig.answer("a", Missing);
        assert_eq!(within(rig.call(&["a"])).await, None);
        assert_eq!(within(rig.call(&["a"])).await, None);
        assert_eq!(rig.runs("a"), 1);
        assert_eq!(rig.entry("a"), Some(MissEntry::Measured));
    }

    #[tokio::test]
    async fn a_changed_capture_drops_the_remembered_misses() {
        let (rig, _started) = rig(None);
        rig.answer("a", Missing);
        within(rig.call(&["a"])).await;
        rig.set_capture(Some("/a:/b"));
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 2, "None -> Some");
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 2, "an unchanged capture keeps the miss");
        rig.set_capture(Some("/c"));
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 3, "Some(a) -> Some(b)");
    }

    #[tokio::test]
    async fn a_failed_probe_retries_60s_after_its_store_and_a_measured_miss_never_expires() {
        let (rig, mut started) = rig(Some("/a:/b"));
        // The probe takes 20 s, so a window counted from the call would close 20 s early.
        let mut x = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        rig.at(20);
        rig.answer("a", Failed);
        assert_eq!(within(&mut x).await, None);
        rig.at(20 + 59);
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 1, "59 s after the store");
        rig.at(20 + 60);
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 2, "60 s after the store");

        rig.answer("m", Missing);
        within(rig.call(&["m"])).await;
        rig.at(20 + 60 + 86_400);
        within(rig.call(&["m"])).await;
        assert_eq!(rig.runs("m"), 1, "a measured miss a day later");
    }

    #[tokio::test]
    async fn a_clear_forgets_a_measured_miss() {
        let (rig, _started) = rig(Some("/a:/b"));
        rig.answer("a", Missing);
        within(rig.call(&["a"])).await;
        rig.cache.lock().unwrap().clear();
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 2);
    }

    #[tokio::test]
    async fn a_probe_straddling_a_capture_change_or_a_clear_stores_nothing() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        rig.set_capture(Some("/c"));
        rig.answer("a", Missing);
        assert_eq!(within(&mut x).await, None);
        assert_eq!(rig.entry("a"), None, "the capture changed mid-probe");
        within(rig.call(&["a"])).await;
        within(rig.call(&["a"])).await;
        assert_eq!(rig.runs("a"), 2, "probed again, then remembered");

        let mut y = pin!(rig.call(&["b"]));
        park(&mut y, &mut started, "b").await;
        rig.cache.lock().unwrap().clear();
        rig.answer("b", Missing);
        assert_eq!(within(&mut y).await, None);
        assert_eq!(rig.entry("b"), None, "cleared mid-probe");
        within(rig.call(&["b"])).await;
        within(rig.call(&["b"])).await;
        assert_eq!(rig.runs("b"), 2, "probed again, then remembered");
    }

    #[tokio::test]
    async fn a_hit_is_never_remembered_and_the_first_hit_wins() {
        let (rig, _started) = rig(Some("/a:/b"));
        rig.answer("a", Failed);
        within(rig.call(&["a"])).await;
        assert!(matches!(rig.entry("a"), Some(MissEntry::Failed { .. })));
        rig.at(60);
        rig.answer("a", Found(path("/x/a")));
        rig.answer("b", Found(path("/x/b")));
        assert_eq!(within(rig.call(&["a", "b"])).await, Some(path("/x/a")));
        assert_eq!(rig.entry("a"), None, "the hit removed the failed entry");
        assert_eq!(rig.runs("b"), 0, "the first hit wins");
    }

    #[tokio::test]
    async fn a_name_is_released_and_its_miss_stored_before_the_next_name_is_probed() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a", "b"]));
        park(&mut x, &mut started, "a").await;
        let mut y = pin!(rig.call(&["a"]));
        waits(&mut y, "Y behind a's probe").await;
        rig.answer("a", Missing);
        park(&mut x, &mut started, "b").await;
        assert_eq!(rig.entry("a"), Some(MissEntry::Measured));
        let shared = within(async {
            tokio::select! {
                biased;
                out = &mut x => panic!("X left b's probe with {out:?}"),
                out = &mut y => out,
            }
        })
        .await;
        assert_eq!(shared, None);
        assert_eq!(rig.runs("a"), 1, "Y took a's stored miss");
        rig.answer("b", Found(path("/x/b")));
        assert_eq!(within(&mut x).await, Some(path("/x/b")));
    }

    #[tokio::test]
    async fn an_unquotable_name_is_never_probed_or_remembered() {
        let (rig, _started) = rig(Some("/a:/b"));
        rig.answer("a'b", Missing);
        assert_eq!(within(rig.call(&["a'b"])).await, None);
        assert_eq!(rig.runs("a'b"), 0);
        let misses = rig.cache.lock().unwrap();
        assert!(misses.entries.is_empty() && misses.gates.is_empty());
    }

    #[tokio::test]
    async fn queued_callers_share_one_flights_hit_and_it_ends_with_the_flight() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        let mut y = pin!(rig.call(&["a"]));
        let mut z = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        waits(&mut y, "Y").await;
        waits(&mut z, "Z").await;
        rig.answer("a", Found(path("/x/a")));
        let hit = Some(path("/x/a"));
        let all = within(async move { tokio::join!(x, y, z) }).await;
        assert_eq!(all, (hit.clone(), hit.clone(), hit.clone()));
        assert_eq!(rig.runs("a"), 1, "one flight");

        assert_eq!(within(rig.call(&["a"])).await, hit);
        assert_eq!(rig.runs("a"), 2, "a shared hit is not a cache");

        // A flier dropped mid-probe: one queued caller probes, and both take its answer.
        rig.unanswer("a");
        let mut flier = Box::pin(rig.call(&["a"]));
        park(&mut flier, &mut started, "a").await;
        let mut q1 = pin!(rig.call(&["a"]));
        let mut q2 = pin!(rig.call(&["a"]));
        waits(&mut q1, "Q1").await;
        waits(&mut q2, "Q2").await;
        drop(flier);
        park(&mut q1, &mut started, "a").await;
        rig.answer("a", Found(path("/y/a")));
        let both = within(async move { tokio::join!(q1, q2) }).await;
        assert_eq!(both, (Some(path("/y/a")), Some(path("/y/a"))));
        assert_eq!(rig.runs("a"), 4, "the dropped flight's probe and one more");
    }

    #[tokio::test]
    async fn queued_callers_share_one_flights_miss() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        let mut y = pin!(rig.call(&["a"]));
        let mut z = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        waits(&mut y, "Y").await;
        waits(&mut z, "Z").await;
        rig.answer("a", Missing);
        let all = within(async move { tokio::join!(x, y, z) }).await;
        assert_eq!(all, (None, None, None));
        assert_eq!(rig.runs("a"), 1);
    }

    /// Parks X's probe, runs `bump`, then queues Y behind it: X's hit belongs to the
    /// generation before the bump, so Y probes again and keeps its own answer.
    async fn a_hit_from_before(bump: impl Fn(&Rig), what: &str) {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        bump(&rig);
        let mut y = pin!(rig.call(&["a"]));
        waits(&mut y, "Y").await;
        assert_eq!(rig.runs("a"), 1, "{what}: Y waits on X's gate");
        rig.answer("a", Found(path("/old/a")));
        assert_eq!(within(&mut x).await, Some(path("/old/a")));
        rig.unanswer("a");
        park(&mut y, &mut started, "a").await;
        rig.answer("a", Found(path("/new/a")));
        assert_eq!(within(&mut y).await, Some(path("/new/a")), "{what}");
        assert_eq!(rig.runs("a"), 2, "{what}: Y probed again");
    }

    #[tokio::test]
    async fn a_hit_measured_before_a_clear_is_not_shared_after_it() {
        a_hit_from_before(|rig| rig.cache.lock().unwrap().clear(), "a clear").await;
    }

    #[tokio::test]
    async fn a_hit_measured_before_a_capture_change_is_not_shared_after_it() {
        a_hit_from_before(|rig| rig.set_capture(Some("/c")), "a capture change").await;
    }

    #[tokio::test]
    async fn another_name_never_waits_on_a_parked_probe() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        rig.answer("e", Missing);
        let other = within(async {
            tokio::select! {
                biased;
                out = &mut x => panic!("X left its probe with {out:?}"),
                out = rig.call(&["e"]) => out,
            }
        })
        .await;
        assert_eq!(other, None);
        assert_eq!(rig.runs("e"), 1);
    }

    #[tokio::test]
    async fn the_name_past_the_cap_empties_the_map() {
        let (rig, _started) = rig(Some("/a:/b"));
        let names: Vec<String> = (0..=LOGIN_SHELL_CACHE_CAP)
            .map(|i| format!("n{i}"))
            .collect();
        for name in &names {
            rig.answer(name, Missing);
            within(rig.call(&[name.as_str()])).await;
        }
        {
            let misses = rig.cache.lock().unwrap();
            assert_eq!((misses.entries.len(), misses.gates.len()), (1, 1));
        }
        within(rig.call(&["n0"])).await;
        assert_eq!(rig.runs("n0"), 2, "the first name probes again");
    }

    /// The cap drops only idle gates: a caller arriving for a name whose flight is parked
    /// across the cap waits on that flight, and the map stays bounded by the cap plus the
    /// gates in use.
    #[tokio::test]
    async fn the_gate_cap_keeps_a_gate_in_use() {
        let (rig, mut started) = rig(Some("/a:/b"));
        let mut x = pin!(rig.call(&["a"]));
        park(&mut x, &mut started, "a").await;
        for i in 0..LOGIN_SHELL_CACHE_CAP {
            let name = format!("n{i}");
            rig.answer(&name, Missing);
            within(rig.call(&[name.as_str()])).await;
        }
        let mut y = pin!(rig.call(&["a"]));
        waits(&mut y, "Y behind a's parked flight").await;
        assert_eq!(rig.runs("a"), 1, "Y probed a itself");
        {
            let misses = rig.cache.lock().unwrap();
            let mut names: Vec<&str> = misses.gates.keys().map(String::as_str).collect();
            names.sort_unstable();
            let last = format!("n{}", LOGIN_SHELL_CACHE_CAP - 1);
            assert_eq!(names, ["a", last.as_str()], "the idle gates were dropped");
        }
        rig.answer("a", Found(path("/x/a")));
        let both = within(async move { tokio::join!(x, y) }).await;
        assert_eq!(both, (Some(path("/x/a")), Some(path("/x/a"))));
        assert_eq!(rig.runs("a"), 1, "one flight");

        rig.answer("z", Missing);
        within(rig.call(&["z"])).await;
        let gates = rig.cache.lock().unwrap().gates.len();
        assert!(
            gates <= LOGIN_SHELL_CACHE_CAP,
            "{gates} gates with none in use"
        );
    }

    /// About > Re-check's clear reaches the process-wide cache: the miss is gone and the
    /// generation moved, so a probe in flight stores nothing.
    #[cfg(not(windows))]
    #[test]
    fn the_recheck_clear_empties_the_process_wide_cache() {
        let _memos = crate::agent_sandbox::LOOKUP_MEMO_TEST_LOCK.blocking_lock();
        let name = "gd-test-no-such-tool-recheck";
        // Every assert runs after its guard drops: a failure while holding the
        // process-wide mutex would poison it for the rest of the test process.
        let (stored, before) = {
            let mut misses = super::login_shell_misses().lock().unwrap();
            let capture = misses.capture.clone();
            let ticket = misses.ticket(capture.clone());
            misses.store(name, ticket, capture, &Missing, Instant::now());
            (misses.entries.get(name).copied(), misses.generation)
        };
        assert_eq!(stored, Some(MissEntry::Measured));
        super::clear_login_shell_misses();
        let (kept, after) = {
            let misses = super::login_shell_misses().lock().unwrap();
            (misses.entries.get(name).copied(), misses.generation)
        };
        assert_eq!(kept, None, "the clear kept the miss");
        assert!(after > before, "the clear kept the generation");
    }

    /// The Re-check's one entry point still forgets the remembered misses.
    #[cfg(not(windows))]
    #[test]
    fn forgetting_the_cli_lookups_clears_the_remembered_misses() {
        let _memos = crate::agent_sandbox::LOOKUP_MEMO_TEST_LOCK.blocking_lock();
        let name = "gd-test-no-such-tool-forget";
        // Asserts run after the guard drops, as in the test above.
        let stored = {
            let mut misses = super::login_shell_misses().lock().unwrap();
            let capture = misses.capture.clone();
            let ticket = misses.ticket(capture.clone());
            misses.store(name, ticket, capture, &Missing, Instant::now());
            misses.entries.get(name).copied()
        };
        assert_eq!(stored, Some(MissEntry::Measured));
        super::forget_cli_lookups();
        let kept = super::login_shell_misses()
            .lock()
            .unwrap()
            .entries
            .get(name)
            .copied();
        assert_eq!(kept, None, "the forget kept the miss");
    }
}
