//! Drives a locally-installed coding-agent CLI (Claude / Codex / Copilot /
//! opencode) as a non-interactive subprocess — reviews and write-capable
//! sessions — streaming output to the frontend over a Tauri channel.
//!
//! Reuses the user's existing CLI subscription auth, so no API key is needed.
//! Reviews are read-only: Tier 1 exposes no tools at all.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
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
            AgentKind::Opencode => Some(&["models"]),
            AgentKind::Claude | AgentKind::Codex | AgentKind::Copilot => None,
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
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthStatus {
    Authed,
    NotAuthed,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub authed: AuthStatus,
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
    NativeSession { id: String },
}

impl ReviewEvent {
    /// A failure carrying nothing but its reason — every source except the deadline
    /// kill, whose partial output is the whole point of the two fields above.
    fn error(message: impl Into<String>) -> Self {
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
// into the bundle, so any spawned HOST binary loads the bundle's Ubuntu 22.04
// libraries and dies. Subtract per child only: never clear (SSH_AUTH_SOCK
// inherits), never touch our own env (WebKit helpers, the dlopen'd tray). The
// list/scalar split tracks Tauri's linuxdeploy-plugin-gtk fork, which appends
// to the lists but overwrites the scalars; upstream's adds GI_TYPELIB_PATH.

/// `PATH`-style lists the bundle prepends itself to; `$APPDIR` entries are
/// dropped and the variable is unset when nothing survives — except `PATH`,
/// which is replaced with a minimal host PATH.
/// Twin of the `export` allowlist in `.github/scripts/appimage-guard.sh`.
const APPDIR_PATHLIST_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "PATH",
    "XDG_DATA_DIRS",
    "GTK_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
];

/// Single-path variables the bundle owns outright — unset when they point into
/// `$APPDIR`. Deliberately left alone: `GDK_BACKEND` and `GTK_THEME` (set by the
/// hook but not `$APPDIR`-derived, and a child may legitimately want them), and
/// `LD_PRELOAD` (the AppImage never sets it, so any value is the user's).
/// Twin of the `export` allowlist in `.github/scripts/appimage-guard.sh`.
const APPDIR_SCALAR_VARS: &[&str] = &[
    "GSETTINGS_SCHEMA_DIR",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_EXTRA_MODULES",
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

/// The process-wide override plan, computed once from the live environment.
/// Empty (so every applier is a no-op) unless we're running from an AppImage.
fn child_env_overrides() -> &'static [(&'static str, Option<String>)] {
    // AppImage is Linux-only, and `APPDIR` alone gates it: an extracted run
    // (`--appimage-extract`, the no-FUSE path) sets `APPDIR` but never `APPIMAGE`.
    if !cfg!(all(unix, not(target_os = "macos"))) {
        return &[];
    }
    static PLAN: std::sync::OnceLock<Vec<(&'static str, Option<String>)>> =
        std::sync::OnceLock::new();
    PLAN.get_or_init(|| {
        let appdir = std::env::var("APPDIR").unwrap_or_default();
        compute_child_env_overrides(&appdir, |key| std::env::var(key).ok())
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

/// Removes the AppImage bundle's paths from a child's environment. Call it FIRST,
/// before a site's own `.env()` calls, so explicitly-set variables always win.
pub(crate) fn sanitize_child_env<C: ChildEnv>(cmd: &mut C) {
    for (name, value) in child_env_overrides() {
        match value {
            Some(v) => cmd.set_var(name, v),
            None => cmd.unset_var(name),
        }
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
/// `candidate_dirs`. Ask the user's login+interactive shell to resolve it.
/// POSIX-ish shells only; fish users fall back to the Settings path override.
#[cfg(not(windows))]
async fn resolve_via_login_shell(names: &[&str]) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    for name in names {
        let mut cmd = Command::new(&shell);
        sanitize_child_env(&mut cmd);
        // -l sources the profile; -i sources the rc files, where zsh/bash users
        // commonly set PATH (nvm, `brew shellenv`, …). stdin is closed so the
        // shell runs the one command and exits rather than waiting for input.
        cmd.arg("-lic")
            .arg(format!("command -v {name}"))
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let Ok(Ok(out)) = tokio::time::timeout(DETECT_TIMEOUT, cmd.output()).await else {
            continue;
        };
        // rc files may print banners, so scan every line for an absolute path to
        // a real file named like the binary, rather than trusting the first line.
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let candidate = PathBuf::from(line.trim());
            if candidate.is_absolute()
                && candidate.file_name().and_then(|f| f.to_str()) == Some(*name)
                && candidate.is_file()
            {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolves a binary by candidate `names`: an explicit override if it exists,
/// else a static search of PATH + known dirs, else (non-Windows) the user's
/// login shell. Shared by the agent CLIs and the health-screen tool detection.
pub(crate) async fn resolve_named(names: &[&str], bin_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = bin_path.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        return pb.is_file().then_some(pb);
    }
    if let Some(found) = find_executable(names) {
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

/// Resolves the agent CLI's binary (override → PATH → login shell).
async fn resolve(kind: AgentKind, bin_path: Option<&str>) -> Option<PathBuf> {
    resolve_named(kind.binary_names(), bin_path).await
}

// --- detection -------------------------------------------------------------

/// Runs a short command and returns (exit code, stdout, stderr) as separate
/// streams — what a line parser needs, since a banner on stderr must not
/// interleave into the data being parsed.
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

    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
        .map_err(AppError::Io)?;
    Ok((
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
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

#[tauri::command]
pub async fn agent_detect(kind: AgentKind, bin_path: Option<String>) -> AppResult<AgentInfo> {
    let Some(binary) = resolve(kind, bin_path.as_deref()).await else {
        return Ok(AgentInfo {
            found: false,
            path: None,
            version: None,
            authed: AuthStatus::Unknown,
        });
    };

    let version = run_capture(&binary, &["--version"], DETECT_TIMEOUT)
        .await
        .ok()
        .filter(|(code, _)| *code == 0)
        .map(|(_, out)| out.trim().to_string())
        .filter(|s| !s.is_empty());

    let authed = match kind.auth_status_args() {
        None => AuthStatus::Unknown,
        Some(args) => match run_capture(&binary, args, DETECT_TIMEOUT).await {
            Ok((0, _)) => AuthStatus::Authed,
            Ok(_) => AuthStatus::NotAuthed,
            Err(_) => AuthStatus::Unknown,
        },
    };

    Ok(AgentInfo {
        found: true,
        path: Some(binary.to_string_lossy().into_owned()),
        version,
        authed,
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
    let (code, stdout, stderr) = run_capture_parts(&binary, args, MODELS_TIMEOUT).await?;
    if code != 0 {
        let reason = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} models exited with code {code}", kind.label()));
        return Err(AppError::Command(reason));
    }
    Ok(parse_models_output(&stdout))
}

// --- review ----------------------------------------------------------------

/// Claude Code review invocation. The diff-bearing user prompt is fed on stdin;
/// this builds everything else. Read-only either way: Tier 1 (`repo_aware =
/// false`) exposes no tools at all; Tier 2 exposes only read tools so the agent
/// can read surrounding code for context but still can't edit, run commands, or
/// hang waiting on a permission prompt.
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
/// Prompt on stdin; worktree is the process cwd.
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
        args.push("--system-prompt".into());
        args.push(system_prompt.into());
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
/// a pointer file. Each session has its own home + cwd, so `exec resume --last`
/// continues it without tracking a thread id.
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
        // host session shares `~/.codex`, so resume the *specific* thread captured
        // from turn 1 — `--last` could grab a concurrent session.
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
/// Diff-only: no tool flags, so it just analyzes the prompt's diff. Repo-aware
/// (Tier 2): `--allow-all-tools` avoids a permission hang while `--deny-tool`ing
/// `write` + `shell`; denial takes precedence over allow-all, so reads are
/// auto-approved (path-allowed — the review runs with the repo as cwd) and
/// writes stay impossible even in the live repo. `--disable-builtin-mcps` keeps
/// it to local repo reads.
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
        // diff-only review must carry the allow-all/deny-write pair itself.
        args.push("--additional-mcp-config".into());
        args.push(format!("@{path}"));
        if !repo_aware {
            args.push("--allow-all-tools".into());
            args.push("--deny-tool=write".into());
            args.push("--deny-tool=shell".into());
        }
    }
    if repo_aware {
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
/// the host-Codex thread-id dance, because host sessions share one opencode home
/// (`~/.local/share/opencode`), so an implicit "continue last" could grab a
/// concurrent session.
fn opencode_session_args(
    model: &str,
    session_id: &str,
    resume: bool,
    effort: &str,
    read_only: bool,
    // Research profile: use our generated `gd-research` agent instead of the
    // builtin `plan` — `plan` has NO web tools and opencode has no permission CLI
    // flags, so the agent is defined in `OPENCODE_CONFIG` (see mcp.rs).
    web: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "run".into(),
        "--format".into(),
        "json".into(),
        "--dangerously-skip-permissions".into(),
    ];
    if read_only {
        // A read-only conversation: a hard read-only guarantee via an agent with no
        // write/edit/bash tools — the builtin `plan` (Plan; glob/read only), or our
        // `gd-research` (Research; adds webfetch/websearch). See the `web` doc above.
        args.push("--agent".into());
        args.push(if web { crate::mcp::GD_RESEARCH_AGENT } else { "plan" }.into());
    }
    if resume && !session_id.trim().is_empty() {
        // opencode generated the id on turn 1; we captured it from the stream.
        // (If capture somehow failed, fall through to "continue last" rather than
        // passing an empty `--session`.)
        args.push("--session".into());
        args.push(session_id.into());
    } else if resume {
        args.push("--continue".into());
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
/// `repo_aware` uses the builtin read-only `plan` agent (glob/read, no
/// write/edit/bash — a hard guarantee even in the live repo);
/// `--dangerously-skip-permissions` only auto-approves those reads. Diff-only
/// invokes no tools at all.
fn opencode_review_args(model: &str, repo_aware: bool, effort: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["run".into(), "--format".into(), "json".into()];
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
fn normalize_tool(name: &str) -> &'static str {
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
fn tool_target(input: &serde_json::Value) -> Option<String> {
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
fn parse_codex_line(
    line: &str,
    saw_terminal: &mut bool,
    last_message: &mut String,
) -> Option<ReviewEvent> {
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
        "turn.completed" => {
            *saw_terminal = true;
            Some(ReviewEvent::Done {
                text: std::mem::take(last_message),
                is_error: false,
                cost_usd: None,
            })
        }
        "turn.failed" => {
            *saw_terminal = true;
            Some(ReviewEvent::error(
                "Codex review failed — see the Codex CLI for details.",
            ))
        }
        "error" => {
            *saw_terminal = true;
            Some(ReviewEvent::error(
                v.get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Codex reported an error."),
            ))
        }
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
    saw_terminal: &mut bool,
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
            *saw_terminal = true;
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
    saw_terminal: &mut bool,
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
            *saw_terminal = true;
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
        "error" => {
            *saw_terminal = true;
            Some(ReviewEvent::error(
                v.get("error")
                    .and_then(|e| e.get("message").or(Some(e)))
                    .and_then(|m| m.as_str())
                    .unwrap_or("opencode reported an error."),
            ))
        }
        _ => None,
    }
}

/// Parses one NDJSON line of Claude `--output-format stream-json`. Sets
/// `saw_result` at the terminal `result`. `tool_inputs` accumulates each
/// in-flight tool call's streamed input JSON by block index (input arrives as
/// `input_json_delta` fragments); the block's stop emits one `Tool` event.
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
    saw_result: &mut bool,
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
            *saw_result = true;
            let text = v
                .get("result")
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            Some(ReviewEvent::Done {
                is_error: claude_result_is_error(&v, &text, synthetic_error.as_deref()),
                text,
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
            })
        }
        _ => None,
    }
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

/// Kills the entire process tree of a host-mode agent child on cancel/timeout.
///
/// `child.start_kill()` reaches only the direct child, but the agent CLI is a
/// shim that spawns node workers, MCP servers and tool subprocesses — killing
/// the shim orphans them (they keep burning tokens and holding worktree file
/// handles). `taskkill /T` on Windows; a process-group kill on Unix (the child
/// leads its own group — see `process_group(0)` at the spawn site).
fn kill_process_tree(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        // Already reaped — nothing to signal.
        let _ = child.start_kill();
        return;
    };

    #[cfg(windows)]
    {
        // taskkill is always present on Windows and kills the whole tree.
        // Fire-and-forget; CREATE_NO_WINDOW suppresses the console flash.
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn();
    }

    #[cfg(unix)]
    {
        // Negative PID targets the process group (pgid == pid for a group
        // leader), so `kill -KILL` reaches every descendant.
        let mut cmd = std::process::Command::new("kill");
        sanitize_child_env(&mut cmd);
        let _ = cmd.args(["-KILL", &format!("-{pid}")]).spawn();
    }

    // Belt-and-braces: the tree-kill can race the child exiting, and this is
    // the last-resort direct kill on any platform.
    let _ = child.start_kill();
}

/// Bounds each trailing wait once the pump loop ends — first the child's exit, then the
/// stderr drain's join. On a clean EOF both finish at once, but a grandchild (node
/// worker, MCP server) can hold the pipes open, and unbounded that means the command
/// never returns: the frontend never sees `backendDone` and the run's UI stays stuck.
const CHILD_EXIT_GRACE: Duration = Duration::from_secs(10);
/// Second, shorter grace after a tree-kill: the child is being force-killed, so this
/// only covers reaping it.
const CHILD_REAP_GRACE: Duration = Duration::from_secs(5);

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

/// Spawns an agent CLI, streams its stdout as `ReviewEvent`s until a terminal
/// event / EOF / cancel / timeout, then emits a final `Error` if no terminal
/// result arrived. Shared by `agent_review` (read-only) and `agent_session`
/// (write-enabled, run in a worktree). `cwd` is the process working directory,
/// `cancel` is the caller's registered cancel handle (registered at command entry,
/// so a cancel racing the setup below is never lost), and `noun` colors the failure
/// copy.
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
    // `(runtime, container name)` to force-remove on cancel/timeout — killing the
    // `run` client alone leaves the engine's container running.
    container_kill: Option<(PathBuf, String)>,
    // Extra environment for the spawned process — used to pass a Copilot container's
    // `COPILOT_GITHUB_TOKEN` to the docker/podman client by name (the run args carry
    // `-e COPILOT_GITHUB_TOKEN` with no value, so the token is inherited here and
    // never appears in argv / `docker inspect`).
    extra_env: &[(&str, String)],
    on_event: &dyn EventSink,
) -> AppResult<()> {
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
    // Put the child in its own process group so a group-kill on cancel/timeout
    // reaches the whole tree (the CLI shim spawns node workers, MCP-server
    // children, and tool subprocesses). See `kill_process_tree`.
    #[cfg(unix)]
    cmd.process_group(0);
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == ErrorKind::NotFound {
            AppError::Command(format!("{} CLI not found.", kind.label()))
        } else {
            AppError::Io(e)
        }
    })?;

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

    let mut saw_result = false;
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

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                timed_out = true;
                kill_process_tree(&mut child);
                break;
            }
            _ = cancel.notified() => {
                cancelled = true;
                kill_process_tree(&mut child);
                break;
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        let ev = match kind {
                            AgentKind::Claude => parse_claude_line(
                                &l,
                                &mut saw_result,
                                &mut claude_tool_inputs,
                                &mut emitted_text,
                                &mut pending_sep,
                                &mut claude_synthetic_error,
                            ),
                            AgentKind::Codex => {
                                parse_codex_line(&l, &mut saw_result, &mut last_message)
                            }
                            AgentKind::Copilot => parse_copilot_line(
                                &l,
                                &mut saw_result,
                                &mut last_message,
                                &mut emitted_text,
                                &mut pending_sep,
                                &mut copilot_error,
                            ),
                            AgentKind::Opencode => parse_opencode_line(
                                &l,
                                &mut saw_result,
                                &mut last_message,
                                &mut opencode_step_text,
                            ),
                        };
                        if let Some(ev) = ev {
                            on_event.send(ev);
                        }
                    }
                    Ok(None) => break, // EOF: process closed stdout
                    Err(_) => break,
                }
            }
        }
    }

    // The EOF / read-error breaks reach here with nothing having killed the child, so
    // both waits below are bounded: a surviving grandchild holding the pipes must cost
    // a bounded delay, never a hung command. Nothing is killed on the timeout-free
    // path until this grace actually elapses — a clean EOF normally exits at once.
    if tokio::time::timeout(CHILD_EXIT_GRACE, child.wait())
        .await
        .is_err()
    {
        kill_process_tree(&mut child);
        let _ = tokio::time::timeout(CHILD_REAP_GRACE, child.wait()).await;
    }
    // A killed `docker/podman run` client doesn't stop the container — force-
    // remove it so a cancelled/timed-out agent isn't left running detached.
    if cancelled || timed_out {
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
        return Ok(());
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
        on_event.send(ReviewEvent::Error {
            message: timeout_message(noun, timeout, timeout_hint),
            partial_text,
            timed_out: true,
        });
        return Ok(());
    }
    if !saw_result {
        // No terminal result event — surface stderr. Covers auth/quota
        // failures and the empty-stdout-without-a-TTY class of CLI bugs.
        let msg = stderr_text.trim();
        on_event.send(ReviewEvent::error(if msg.is_empty() {
            format!("The {noun} process ended without producing any output.")
        } else {
            msg.to_string()
        }));
    }
    Ok(())
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
) -> AppResult<()> {
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
        AgentKind::Opencode => (
            opencode_review_args(&model, repo_aware, &effort),
            format!("{system_prompt}\n\n{user_prompt}"),
        ),
    };

    // opencode reads its MCP config from `OPENCODE_CONFIG` (no flag); the others carry
    // it in argv. Set the env only when we actually wrote an opencode config.
    let mut extra_env: Vec<(&str, String)> = match (kind, &mcp_config_path) {
        (AgentKind::Opencode, Some(path)) => vec![("OPENCODE_CONFIG", path.clone())],
        _ => Vec::new(),
    };
    if kind == AgentKind::Opencode {
        // Long-lived app-managed runs must not fork opencode's detached catalog
        // refresh (stray-grandchild churn). The short-lived probes keep opencode's
        // default behavior — the `agent_models` probe is what refreshes the cache.
        extra_env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
    }

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
        &extra_env,
        &on_event,
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
/// same `ReviewEvent`s as a review; cancel via `agent_review_cancel` with the
/// same `session_id`.
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
    resume: bool,
    // Claude-only: forks a resumed conversation to a throwaway session id
    // (`--fork-session`) so this turn never pollutes the original transcript. Used by
    // the research→plan distill handoff; ignored by the other agents (no equivalent).
    fork: bool,
    // Read-only mode: a Plan conversation. Swaps every CLI's write toolset/sandbox
    // for its read-only one (Claude read tools + no bypass, Codex `-s read-only`,
    // Copilot deny-write/shell, opencode `--agent plan`), so the turn can explore
    // but can NEVER write — even though it runs in the live repo, not a worktree.
    read_only: bool,
    // Research profile: each CLI gains its native web tools while still never
    // writing (see each `*_session_args`). Only meaningful alongside `read_only`.
    web: bool,
    // "container" runs the turn inside a Docker/Podman container (worktree-
    // confined); anything else (incl. None) runs it on the host (worktree-only).
    isolation: Option<String>,
    // The CLI's native resume id captured from turn 1 (Codex thread / opencode
    // sessionID), so a *host* session resumes the right conversation; None on turn
    // 1 / Claude / Copilot / container.
    native_session_id: Option<String>,
    // The session's opted-in MCP servers (resolved from the settings registry by
    // the frontend). None/empty = MCP stays off. Honored for host Claude/Copilot/
    // opencode and container Claude/Copilot/opencode/Codex (the composer gates it).
    mcp_servers: Option<Vec<crate::mcp::McpServerSpec>>,
    on_event: Channel<ReviewEvent>,
) -> AppResult<()> {
    if !valid_cancel_id(&session_id) {
        return Err(AppError::InvalidArgument("invalid session id".into()));
    }
    // Register BEFORE the setup below (the container path runs several runtime
    // probes): a racing cancel then lands its permit on this entry — or leaves a
    // tombstone this register adopts. The guard clears the entry on every exit path.
    let cancel = AgentCancelGuard::register(&state, &session_id);

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
    // (the builtin `plan` agent has no web tools), written even with no MCP servers.
    let opencode_research = kind == AgentKind::Opencode && web;

    // Resolve the session's opted-in MCP servers into a generated config file, passed
    // to whichever CLI this is in its own form. The composer gates selection to the
    // supported (agent, isolation) combos, so an unsupported one arriving here with
    // servers is an error, not a silent drop.
    let mcp_specs = mcp_servers.unwrap_or_default();
    // `mcp__<server>` allowlist entries — loading a server via `--mcp-config` does
    // NOT admit its tools past `--tools`. Claude only (host and container).
    let mcp_tools = crate::mcp::tool_allow_patterns(&mcp_specs);
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
                format!("{system_prompt}\n\n{user_prompt}")
            },
        ),
        // Copilot takes the prompt as an arg (`-p`), not stdin, so stdin is empty.
        AgentKind::Copilot => {
            let prompt = if resume {
                user_prompt
            } else {
                format!("{system_prompt}\n\n{user_prompt}")
            };
            // `--add-dir` must name the path as it exists FOR THIS RUN: `/workspace` in
            // a container, the real host path otherwise — the host path names nothing
            // inside.
            let add_dir = if container {
                "/workspace"
            } else {
                worktree_path.as_str()
            };
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
                format!("{system_prompt}\n\n{user_prompt}")
            };
            (
                opencode_session_args(
                    &model,
                    native_session_id.as_deref().unwrap_or(""),
                    resume,
                    &effort,
                    read_only,
                    web,
                ),
                prompt,
            )
        }
    };

    // Container isolation: wrap the same invocation in an ephemeral,
    // worktree-confined container. The agent CLI lives in the image, so we don't
    // resolve a host binary; the runtime drives it.
    if container {
        let (runtime, runtime_name) = crate::agent_sandbox::detect_runtime().await.ok_or_else(|| {
            AppError::Command("Container isolation is on for this session, but Docker/Podman isn't available. Install and start it — or start a new session with Isolation set to Worktree (composer → Options), or turn container isolation off in Settings → AI.".to_string())
        })?;
        if !crate::agent_sandbox::image_present(&runtime).await {
            // `image inspect` needs the daemon, so a stopped engine fails here too — but
            // this whole branch runs on EVERY turn, so the daemon probe is deliberately on
            // the failure path only: a healthy session pays nothing, and a failing one
            // still tells "engine stopped" apart from "image never built".
            if !crate::agent_sandbox::runtime_ready(&runtime).await {
                let label = if runtime_name == "podman" {
                    "Podman"
                } else {
                    "Docker"
                };
                return Err(AppError::Command(format!(
                    "{label} is installed but its engine isn't running. Start it, then try again."
                )));
            }
            return Err(AppError::Command(
                "The agent container image isn't built yet. Open Settings → AI and click \"Build image\", then try again.".to_string(),
            ));
        }
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
        let mut container_env: Vec<(&str, String)> =
            match crate::agent_sandbox::container_mcp_config("opencode") {
                Some((_, path))
                    if kind == AgentKind::Opencode
                        && (!mcp_specs.is_empty() || opencode_research) =>
                {
                    vec![("OPENCODE_CONFIG", path)]
                }
                _ => Vec::new(),
            };
        if kind == AgentKind::Opencode {
            container_env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
        }
        if opencode_research {
            // Enable opencode's Exa-backed websearch tool (webfetch works regardless).
            container_env.push(("OPENCODE_ENABLE_EXA", "1".to_string()));
        }
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
            &extra_env,
            &on_event,
        )
        .await;
    }

    // Host: every CLI runs worktree-confined — see each `*_session_args` doc for
    // the mechanism (Claude bypass = soft; Codex `-s workspace-write` = enforced).
    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
        AppError::Command(format!(
            "{} CLI not found. Install it or set its path in Settings.",
            kind.label()
        ))
    })?;
    // opencode has no config-file flag: it reads `OPENCODE_CONFIG`, and merges
    // config layers, so ours adds to the user's rather than replacing it.
    let mut host_extra_env: Vec<(&str, String)> = match (kind, &mcp_config_path) {
        (AgentKind::Opencode, Some(path)) => vec![("OPENCODE_CONFIG", path.clone())],
        _ => Vec::new(),
    };
    if kind == AgentKind::Opencode {
        host_extra_env.push(("OPENCODE_DISABLE_MODELS_FETCH", "1".to_string()));
    }
    if opencode_research {
        // Enable opencode's Exa-backed websearch tool (webfetch works regardless).
        host_extra_env.push(("OPENCODE_ENABLE_EXA", "1".to_string()));
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
        &host_extra_env,
        &on_event,
    )
    .await
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
        // The PTY applier only subtracts, so `CommandBuilder` must snapshot the
        // parent environment into its own map — an `env_remove` that only cleared
        // caller overrides would leave the bundle paths in place for the terminal.
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        let ev = parse_opencode_line(STEP_START, &mut term, &mut msg, &mut step).unwrap();
        match ev {
            ReviewEvent::NativeSession { id } => assert_eq!(id, "ses_abc"),
            other => panic!("expected NativeSession, got {other:?}"),
        }
        assert!(!term);
    }

    #[test]
    fn opencode_text_parts_stream_as_separated_deltas() {
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        // First segment: emitted verbatim, no leading separator.
        let ev = parse_opencode_line(TEXT_A, &mut term, &mut msg, &mut step).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "First."));
        // Second segment: separated so multi-step narration stays readable, and the
        // delta mirrors exactly what we appended (buffer == last_message).
        let ev = parse_opencode_line(TEXT_B, &mut term, &mut msg, &mut step).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "\n\nSecond."));
        assert_eq!(msg, "First.\n\nSecond.");
    }

    #[test]
    fn opencode_tool_use_emits_a_tool_step() {
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        let ev = parse_opencode_line(TOOL, &mut term, &mut msg, &mut step).unwrap();
        match ev {
            ReviewEvent::Tool { tool, target } => {
                assert_eq!(tool, "write");
                assert_eq!(target, None); // this event carries no state.input
            }
            other => panic!("expected Tool, got {other:?}"),
        }
        assert!(!term, "a tool call doesn't end the turn");
    }

    const OC_TOOL_WITH_INPUT: &str = r#"{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"src/main.rs"}}}}"#;

    #[test]
    fn opencode_tool_use_extracts_target_from_input() {
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        let ev = parse_opencode_line(OC_TOOL_WITH_INPUT, &mut term, &mut msg, &mut step).unwrap();
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
        let mut saw = false;
        let mut acc = std::collections::HashMap::new();
        let (mut emitted, mut pending) = (false, false);
        let mut syn = None;
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read","input":{}}}}"#;
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_pa"}}}"#;
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\":\"src/x.ts\"}"}}}"#;
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#;
        assert!(
            parse_claude_line(start, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
                .is_none()
        );
        assert!(
            parse_claude_line(d1, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
                .is_none()
        );
        assert!(
            parse_claude_line(d2, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
                .is_none()
        );
        let ev = parse_claude_line(stop, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
            .unwrap();
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
        let mut saw = false;
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
                parse_claude_line(line, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
                    .unwrap();
            match ev {
                ReviewEvent::Delta { text } => {
                    assert_eq!(text, expect.unwrap());
                    buffer.push_str(&text);
                }
                other => panic!("expected Delta, got {other:?}"),
            }
        }
        // Block-1 stop arms the separator; the tool block's stop leaves it armed.
        parse_claude_line(stop1, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn);
        assert!(pending, "a text block's stop arms the separator");
        parse_claude_line(tstart, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn);
        parse_claude_line(tstop, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn);
        assert!(pending, "a tool block's stop leaves the pending separator intact");

        // Block-2's first delta is prefixed `\n\n`.
        let ev =
            parse_claude_line(t2, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn).unwrap();
        match ev {
            ReviewEvent::Delta { text } => {
                assert_eq!(text, "\n\nThe fix is X.");
                buffer.push_str(&text);
            }
            other => panic!("expected Delta, got {other:?}"),
        }
        parse_claude_line(stop2, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn);

        let done =
            parse_claude_line(result, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn)
                .unwrap();
        match done {
            ReviewEvent::Done { text, .. } => {
                assert_eq!(text, "The fix is X.", "Done.text is the raw result, no separator");
                assert!(saw);
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
        let mut saw = false;
        let mut acc = std::collections::HashMap::new();
        let (mut emitted, mut pending) = (false, false);
        let mut syn = None;
        let mut last = None;
        for line in lines {
            last = parse_claude_line(line, &mut saw, &mut acc, &mut emitted, &mut pending, &mut syn);
        }
        assert!(saw, "the fixture must end with a terminal result");
        match last.expect("the terminal result emits Done") {
            ReviewEvent::Done { text, is_error, .. } => (text, is_error),
            other => panic!("expected Done, got {other:?}"),
        }
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
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let d1 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"First."}}"#;
        let m1 = r#"{"type":"assistant.message","data":{"content":"First."}}"#;
        let d2 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Second."}}"#;

        let ev = parse_copilot_line(d1, &mut term, &mut msg, &mut emitted, &mut pending, &mut err)
            .unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "First."));
        // A completed message arms the separator; the next delta is prefixed once.
        assert!(
            parse_copilot_line(m1, &mut term, &mut msg, &mut emitted, &mut pending, &mut err)
                .is_none()
        );
        assert!(pending);
        let ev = parse_copilot_line(d2, &mut term, &mut msg, &mut emitted, &mut pending, &mut err)
            .unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "\n\nSecond."));
        assert!(!pending, "the separator is consumed by the first following delta");
    }

    #[test]
    fn copilot_first_delta_has_no_separator() {
        // The very first delta of a run must not be prefixed (nothing emitted before).
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let d = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Hello."}}"#;
        let ev =
            parse_copilot_line(d, &mut term, &mut msg, &mut emitted, &mut pending, &mut err)
                .unwrap();
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
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        assert!(
            parse_copilot_line(
                CP_SESSION_ERROR,
                &mut term,
                &mut msg,
                &mut emitted,
                &mut pending,
                &mut err
            )
            .is_none()
        );
        assert_eq!(err.as_deref(), Some("API rate limit exceeded for this session."));
        let ev = parse_copilot_line(
            CP_RESULT_OK,
            &mut term,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err,
        )
        .unwrap();
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert!(is_error, "a session.error fails the run whatever the exit code");
                // The error message is the failure reason the frontend shows.
                assert_eq!(text, "API rate limit exceeded for this session.");
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert!(term);
    }

    #[test]
    fn copilot_session_error_after_prose_reports_the_reason_not_the_prose() {
        // Prose already streamed when the session errors: `Done.text` must still be the
        // REASON — the frontend refuses run output as an error message, and the prose
        // survives in the delta stream regardless.
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let prose = r#"{"type":"assistant.message","data":{"content":"Here is my review of the retry path."}}"#;
        parse_copilot_line(prose, &mut term, &mut msg, &mut emitted, &mut pending, &mut err);
        assert_eq!(msg, "Here is my review of the retry path.");
        parse_copilot_line(
            CP_SESSION_ERROR,
            &mut term,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err,
        );
        let ev = parse_copilot_line(
            CP_RESULT_OK,
            &mut term,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err,
        )
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
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let mut err: Option<String> = None;
        let m = r#"{"type":"assistant.message","data":{"content":"All good."}}"#;
        parse_copilot_line(m, &mut term, &mut msg, &mut emitted, &mut pending, &mut err);
        let ev = parse_copilot_line(
            CP_RESULT_OK,
            &mut term,
            &mut msg,
            &mut emitted,
            &mut pending,
            &mut err,
        )
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
        let (mut term, mut msg, mut step) = (false, "hello".to_string(), String::new());
        // `reason: tool-calls` means another step follows — not the turn's end.
        assert!(parse_opencode_line(FINISH_TOOLS, &mut term, &mut msg, &mut step).is_none());
        assert!(!term);
        // `reason: stop` ends the turn and carries the fallback text.
        let ev = parse_opencode_line(FINISH_STOP, &mut term, &mut msg, &mut step).unwrap();
        match ev {
            ReviewEvent::Done { text, is_error, .. } => {
                assert_eq!(text, "hello");
                assert!(!is_error);
            }
            other => panic!("expected Done, got {other:?}"),
        }
        assert!(term);
    }

    #[test]
    fn opencode_done_carries_only_the_final_step_text() {
        // A run of [step1 text "A", tool, step2 text "B"]: both stream as deltas ("A"
        // then "\n\nB"), but `Done.text` is the FINAL step's text only — the step-1
        // narration is stripped off the body.
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        let s1 = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let a = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"A"}}"#;
        let tool = r#"{"type":"tool_use","sessionID":"s","part":{"type":"tool","tool":"read","state":{"status":"completed"}}}"#;
        let fin_tool = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"tool-calls"}}"#;
        let s2 = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let b = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"B"}}"#;
        let fin_stop = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}"#;

        let mut buffer = String::new();
        parse_opencode_line(s1, &mut term, &mut msg, &mut step); // NativeSession
        if let Some(ReviewEvent::Delta { text }) =
            parse_opencode_line(a, &mut term, &mut msg, &mut step)
        {
            buffer.push_str(&text);
        }
        parse_opencode_line(tool, &mut term, &mut msg, &mut step); // Tool
        parse_opencode_line(fin_tool, &mut term, &mut msg, &mut step); // not terminal
        parse_opencode_line(s2, &mut term, &mut msg, &mut step); // NativeSession, clears step
        if let Some(ReviewEvent::Delta { text }) =
            parse_opencode_line(b, &mut term, &mut msg, &mut step)
        {
            buffer.push_str(&text);
        }
        let done = parse_opencode_line(fin_stop, &mut term, &mut msg, &mut step).unwrap();
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
        let (mut term, mut msg, mut step) = (false, String::new(), String::new());
        let s = r#"{"type":"step_start","sessionID":"s","part":{"type":"step-start"}}"#;
        let p1 = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"one"}}"#;
        let p2 = r#"{"type":"text","sessionID":"s","part":{"type":"text","text":"two"}}"#;
        let fin_stop = r#"{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}"#;
        parse_opencode_line(s, &mut term, &mut msg, &mut step);
        parse_opencode_line(p1, &mut term, &mut msg, &mut step);
        parse_opencode_line(p2, &mut term, &mut msg, &mut step);
        let done = parse_opencode_line(fin_stop, &mut term, &mut msg, &mut step).unwrap();
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
    fn copilot_review_without_mcp_is_unchanged() {
        // No self-MCP: no `--additional-mcp-config`. Repo-aware still carries the
        // allow-all/deny pair + `--disable-builtin-mcps`; diff-only carries none.
        let aware = copilot_review_args("m", "prompt", true, "", None);
        assert!(!aware.iter().any(|a| a == "--additional-mcp-config"));
        assert!(aware.iter().any(|a| a == "--allow-all-tools"));
        assert!(aware.iter().any(|a| a == "--disable-builtin-mcps"));

        let diff_only = copilot_review_args("m", "prompt", false, "", None);
        assert!(!diff_only.iter().any(|a| a == "--additional-mcp-config"));
        assert!(!diff_only.iter().any(|a| a == "--allow-all-tools"));
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
