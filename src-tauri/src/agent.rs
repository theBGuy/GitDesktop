//! Drives a locally-installed coding-agent CLI (Claude Code, and later Codex)
//! as a non-interactive subprocess to produce a code review, streaming its
//! output back to the frontend over a Tauri channel.
//!
//! The whole point is to reuse the user's existing CLI auth (a Claude/ChatGPT
//! subscription) so a review can run without an API key. Reviews run read-only:
//! Tier 1 disables all tools, so the agent physically can't edit or commit.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub(crate) const DETECT_TIMEOUT: Duration = Duration::from_secs(20);
const REVIEW_TIMEOUT: Duration = Duration::from_secs(300);
/// Repo-aware (Tier 2) runs explore the tree with tools and take longer.
const REVIEW_TIMEOUT_AGENTIC: Duration = Duration::from_secs(600);
/// A write-capable agent session implements a real task, so it gets a much
/// longer budget than a review. Generous for the slice; configurable later.
const SESSION_TIMEOUT: Duration = Duration::from_secs(1800);

/// Which agent CLI to drive. Frontend sends `"claude"` / `"codex"` / `"copilot"` /
/// `"opencode"`. All four are fully wired for sessions + reviews; opencode runs
/// host-only for now (its container tier is a follow-up).
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
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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
    /// Terminal success: the full final review text plus run metadata.
    Done {
        text: String,
        is_error: bool,
        cost_usd: Option<f64>,
    },
    /// Terminal failure with a message to surface to the user.
    Error { message: String },
    /// The CLI's own generated resume id, captured on turn 1 — Codex's thread id
    /// (`thread.started`) or opencode's `sessionID`. The frontend persists it so a
    /// **host** session resumes the *right* conversation (Codex `exec resume <id>`,
    /// opencode `--session <id>`) instead of "continue last", which could grab a
    /// concurrent session sharing the CLI's home. Ignored for reviews / Claude / container.
    NativeSession { id: String },
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

/// Windows analog of `resolve_via_login_shell`: a packaged GUI app captures its
/// PATH once at launch, and Windows never pushes a later PATH edit into a
/// running process — so a CLI installed (or added to PATH) AFTER GitDesktop
/// started is invisible to a process-PATH search until the app is relaunched
/// with a fresh environment. Re-read the *current* user + system PATH straight
/// from the registry (the source of truth Windows itself broadcasts edits from)
/// and feed those directories into the search. This recovers an after-launch
/// PATH addition without a restart and makes Settings → About's "Re-check"
/// button actually find a freshly-installed tool (e.g. glab, or an agent CLI).
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
        // Prefer extension variants first. On Windows this picks `codex.cmd`
        // over the extension-less `codex` (a bash shim CreateProcess can't run);
        // on Unix `exts` is just [""], so this loop no-ops and we use the bare
        // name below.
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
    // Windows: also search the *live* registry PATH, so a tool added to PATH
    // after launch is found without a relaunch. Appended after the process PATH
    // (the common case) but before probing — both the `.exe`-preference pass and
    // the general pass below iterate `dirs`, so a registry-only `.exe` still wins
    // over an earlier `.cmd` shim.
    #[cfg(windows)]
    dirs.extend(registry_path_dirs());

    // Windows: prefer a real `.exe`/`.com` found ANYWHERE over a `.cmd`/`.bat`
    // shim that sits earlier on PATH. Two reasons: Rust refuses to pass a
    // newline-bearing argument to a batch file ("batch file arguments are
    // invalid"), which our multi-line agent prompts are; and a wrapper shim is the
    // wrong target anyway — e.g. the VS Code Copilot extension injects a
    // `copilot.bat` ahead of the real `copilot.exe` on the integrated-terminal
    // PATH (`pnpm tauri dev` inherits it), so without this we'd spawn the wrapper.
    // CLIs that ship ONLY a `.cmd` shim (e.g. codex) still resolve in the second
    // pass below. (Unix `exts` is just `[""]`, so this pass is a no-op there.)
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

/// macOS/Linux fallback: a packaged GUI app inherits launchd's (or a desktop
/// launcher's) minimal PATH, not the user's shell PATH — so a CLI installed by a
/// Node version manager (nvm/fnm/asdf) or under a non-standard prefix is neither
/// on PATH nor in `candidate_dirs`. Ask the user's login+interactive shell to
/// resolve it the way their terminal would. Assumes a POSIX-ish shell
/// (bash/zsh/sh, the overwhelming default); fish and others simply fall back to
/// the explicit-path override in Settings.
#[cfg(not(windows))]
async fn resolve_via_login_shell(names: &[&str]) -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    for name in names {
        let mut cmd = Command::new(&shell);
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

/// Runs a short command and returns (exit code, stdout+stderr).
pub(crate) async fn run_capture(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> AppResult<(i32, String)> {
    let mut cmd = Command::new(program);
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
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    Ok((out.status.code().unwrap_or(-1), text))
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
    // `mcp__<server>` allowlist entries for any server loaded via `mcp_config`.
    // Two separate layers gate an MCP call: `--tools` is AVAILABILITY (a loaded
    // server's tools stay invisible to the model unless its pattern is appended),
    // and `--allowedTools` is PERMISSION (without it, headless `-p` mode auto-denies
    // every MCP call — no one is there to answer the approval prompt). Both are
    // appended below. Empty when no self-MCP is attached, so the diff-only / plain
    // repo-aware toolset is byte-identical to before.
    mcp_tools: &[String],
) -> Vec<String> {
    // Base toolset: repo-aware exposes the read tools; diff-only exposes none. Any
    // MCP tool patterns are appended so a loaded self-server is actually callable —
    // even in the diff-only case, where the base is otherwise empty.
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
    // `--tools` only makes an MCP tool AVAILABLE to the model; permission is a
    // separate layer. In headless `-p` mode there is no one to answer an approval
    // prompt, so every ungranted MCP call is auto-denied. `--allowedTools` grants
    // exactly the self-server's tools (safe: the self server is spawned read-only,
    // no write flags), so the loaded server is actually callable.
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

/// Claude write-capable *session* invocation. Same streaming shape as a review,
/// but with the write toolset and `bypassPermissions` so it runs full-auto and
/// never hangs on a mid-run permission prompt — safe because the session runs in
/// a throwaway worktree (the sandbox boundary; see `docs/agent-sessions.md`).
/// The task prompt is fed on stdin; the worktree is the process `current_dir`.
///
/// Sessions are multi-turn: turn 1 (`resume = false`) starts a persisted session
/// under `session_id`; each follow-up (`resume = true`) resumes it, so the agent
/// keeps the full conversation AND the worktree's evolving state. Persistence is
/// ON (no `--no-session-persistence`) so `--resume` can find the transcript; the
/// system prompt is set only on turn 1 (the resumed session already carries it).
///
/// `fork` (resume-only): branch the resumed conversation to a NEW throwaway session
/// id via `--fork-session`, so this turn reads the full transcript as context but
/// never appends to the original. Used by the research→plan distill so a later
/// follow-up resumes a clean conversation with no distill turn in it.
#[allow(clippy::too_many_arguments)]
fn claude_session_args(
    model: &str,
    system_prompt: &str,
    session_id: &str,
    resume: bool,
    fork: bool,
    read_only: bool,
    // Web-enabled read-only profile (a Research conversation): add WebSearch/WebFetch
    // to the read tools so the agent can investigate the web while STILL being unable
    // to write (no Edit/Write/Bash). Only meaningful when `read_only` is true; ignored
    // for write sessions (which already have the full toolset). Plan passes false.
    web: bool,
    mcp_config: Option<&str>,
    mcp_tools: &[String],
) -> Vec<String> {
    // Read-only (a Plan / Research conversation): only read tools. Plan needs no
    // bypass — the read tools (Read/Grep/Glob) are auto-approved even in `-p`
    // non-interactive mode. Research additionally gets the WEB tools, which are NOT
    // auto-approved (they hit the network), so a non-interactive run reports
    // "Web search isn't authorized" without a permission grant — hence bypass is
    // added below for the web profile too. It stays read-only regardless: the strict
    // `--tools` allowlist has no Edit/Write/Bash, so bypass only skips the approval
    // prompt there's no one to answer. Write sessions get the full toolset + bypass.
    // `--tools` is a strict allowlist, so any opted-in MCP servers' tools
    // (`mcp__<server>`) must be appended or the loaded server stays uncallable.
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
    // Grant permission to the opted-in MCP tools (a separate layer from `--tools`
    // availability). Write/Research sessions already run `bypassPermissions` below,
    // which skips this layer entirely — the grant is redundant but harmless there.
    // It matters for a read-only no-web session (Plan) with MCP attached: that
    // profile has no bypass, so it would hit the same headless auto-denial as a
    // review; `--allowedTools` closes the hole uniformly across profiles.
    if !mcp_tools.is_empty() {
        args.push("--allowedTools".into());
        args.push(mcp_tools.join(","));
    }
    // Write sessions always bypass; a read-only Research run bypasses too so its web
    // tools are authorized (see the toolset comment above). Plan (read-only, no web)
    // stays prompt-gated — its built-in read tools need no grant, and its opted-in
    // MCP tools are covered by the `--allowedTools` grant above.
    if !read_only || web {
        args.push("--permission-mode".into());
        args.push("bypassPermissions".into());
    }
    if resume {
        args.push("--resume".into());
        args.push(session_id.into());
        // A forked resume: branch the conversation to a NEW (throwaway) session id so
        // this turn never appends to the original transcript. Used by the distill
        // handoff so a subsequent follow-up resumes a clean conversation.
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
/// - **Host (`container=false`):** confine the agent's writes to the worktree with
///   Codex's *own* OS sandbox — `-s workspace-write` (macOS/Linux enforce it via
///   Seatbelt/Landlock; Windows needs the unelevated restricted-token sandbox, so
///   `-c windows.sandbox="unelevated"`, which needs no admin/reboot). `exec` is
///   non-interactive so approval is already "never". Verified 2026-06-22:
///   in-worktree writes land, out-of-worktree escapes are denied.
/// - **Container (`container=true`):** the kernel is the boundary, so the full-bypass
///   flag is safe and is the only mode that writes (the host workspace-write sandbox
///   inside the container would just confine to the bind-mount anyway).
///
/// The task goes on stdin (`-`); `--skip-git-repo-check` because the worktree's
/// `.git` is a pointer file (in-container it's dangling; on host the main repo
/// drives git either way). Multi-turn: each session has its own dedicated home +
/// cwd, so `exec resume --last` continues it without us tracking a thread id.
fn codex_session_args(
    model: &str,
    resume: bool,
    container: bool,
    thread_id: Option<&str>,
    effort: &str,
    read_only: bool,
    // Web-enabled read-only profile (a Research conversation): force Codex's
    // first-party web_search tool to LIVE mode (it's on-by-default but cached). The
    // tool is hosted, so it works under the read-only sandbox. Only meaningful with
    // read_only; Plan/Delegate pass false.
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
            // On Windows, read-only WITHOUT a sandbox profile blocks shell process
            // creation entirely — so Codex (which explores the repo by running read
            // commands like `ls`/`Get-ChildItem`) can't read it at all and falls back
            // to "web-grounded only". The unelevated restricted token lets read
            // commands run while the read-only policy still denies every write
            // (same sandbox the host write profile uses, just read-only).
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
        // Let the agent's shell commands reach the network (npm/pip/git fetch);
        // filesystem confinement is the property we enforce here. Default-on also
        // keeps platforms consistent (Windows `unelevated` is filesystem-only, so
        // network is open there regardless).
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

/// GitHub Copilot CLI write-capable *session* invocation (host only for now —
/// Copilot's creds live in the OS keychain, not a mountable file, so the container
/// tier is a follow-up). Unlike Claude/Codex the prompt is an **argument**
/// (`-p <text>`), not stdin, so the caller passes it here and feeds empty stdin.
///
/// Confinement: `--add-dir <worktree>` (with NO `--allow-all-paths`) restricts the
/// file tools to the worktree — verified: in-worktree writes land, escapes denied.
/// `--allow-all-tools` is required for non-interactive (`-p`) runs. A shell command
/// could still escape, so the host tier is "soft" (like Claude); the worktree's git
/// isolation is the hard guarantee. Multi-turn is deterministic: `--session-id
/// <uuid>` sets the id on turn 1, `--resume <uuid>` continues it (context retained).
#[allow(clippy::too_many_arguments)]
fn copilot_session_args(
    model: &str,
    session_id: &str,
    resume: bool,
    worktree: &str,
    prompt: &str,
    effort: &str,
    read_only: bool,
    // Web-enabled read-only profile (a Research conversation): keep Copilot's web
    // tools (web_fetch + web search) and the GitHub MCP available — `--allow-all-tools`
    // already admits them and they're neither `write` nor `shell`, so the read-only
    // guarantee holds. A plain Plan run (web=false) drops the builtin MCPs to stay
    // repo-local. Only meaningful with read_only.
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

/// App effort level → a Claude "thinking" keyword. The Claude CLI has no effort
/// flag; including one of these phrases in the user turn raises the thinking
/// budget (think < think hard < think harder < ultrathink). "" = none.
fn claude_thinking_keyword(level: &str) -> Option<&'static str> {
    match level {
        "low" => Some("think"),
        "medium" => Some("think hard"),
        "high" => Some("think harder"),
        "xhigh" => Some("ultrathink"),
        _ => None,
    }
}

/// GitHub Copilot CLI **read-only** review invocation. The prompt (system + diff) is
/// an argument (`-p`), not stdin (Copilot has no stdin prompt form; `copilot.exe` is a
/// real binary, exempt from the batch-file-arg limit).
///
/// Diff-only (`repo_aware = false`): no tool flags, so the agent just analyzes the diff
/// carried in the prompt without invoking tools — verified clean.
///
/// Repo-aware (`repo_aware = true`, Tier 2): the agent may read surrounding files for
/// context. `--allow-all-tools` auto-approves tools so the non-interactive run doesn't
/// hang on a permission prompt, but `--deny-tool` denies the write paths — `write` (all
/// file create/modify tools) and `shell` (arbitrary commands, incl. redirects). Denial
/// takes precedence over allow-all (per `copilot help permissions`), so reads/search are
/// auto-approved while writes stay impossible: a hard read-only guarantee even in the
/// live repo — the same shape as opencode's `plan` agent. `--disable-builtin-mcps` drops
/// the GitHub MCP server too, keeping it to local repo reads (no remote GitHub calls).
/// Reads are path-allowed because the review runs with the repo as cwd.
fn copilot_review_args(
    model: &str,
    prompt: &str,
    repo_aware: bool,
    effort: &str,
    // Per-review MCP config (GitDesktop's own self-server), passed via
    // `--additional-mcp-config @<path>` exactly as `copilot_session_args` does — it
    // AUGMENTS (never mutates) the user's `~/.copilot/mcp-config.json`. `None` = no
    // self-MCP, and the args are byte-identical to before.
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
        // `@` marks a file path. Needs tools enabled to be reachable, so ensure the
        // allow-all/deny-write pair is present even when a diff-only (non-repo-aware)
        // review attaches the self-server (the `if repo_aware` block below only runs
        // for repo-aware). `--allow-all-tools` auto-approves the loaded tools for
        // this non-interactive run.
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
        // Drop Copilot's BUILTIN GitHub MCP so a repo-aware review stays repo-local.
        // Our explicitly-passed `--additional-mcp-config` is a DIFFERENT mechanism and
        // SURVIVES this flag — probe-validated 2026-07-10 on Copilot CLI 1.0.70 with
        // this exact flag set: the agent enumerated every `gitdesktop-*` tool from the
        // additional config while the builtin GitHub MCP stayed disabled. Do not make
        // this conditional on `mcp_config` — the two flags compose as intended.
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

/// opencode write-capable *session* invocation (host only for now — its creds
/// live in a file, `~/.local/share/opencode/auth.json`, so a container tier is
/// feasible later but unbuilt). The prompt goes on **stdin** (`opencode run` with no
/// positional message reads it), not as an argument — a large turn (with prior
/// context / @file mentions) would otherwise blow the Windows ~32 KB argv limit
/// ("Argument list too long"). This also matches Claude/Codex.
///
/// Confinement is "soft" (like Claude): `--dangerously-skip-permissions` auto-approves
/// tools so the non-interactive run doesn't hang on a permission prompt; the worktree's
/// git isolation is the hard guarantee. opencode generates its **own** `sessionID`
/// (there's no flag to set it on turn 1), so turn 1 omits `--session` and we capture
/// the id from the stream; resume passes it back as `--session <id>` — exactly the
/// host-Codex thread-id dance, since opencode shares `~/.local/share/opencode` too.
fn opencode_session_args(
    model: &str,
    session_id: &str,
    resume: bool,
    effort: &str,
    read_only: bool,
    // Web-enabled read-only profile (a Research conversation): use our generated
    // read-only agent (`gd-research`) instead of the builtin `plan`, because `plan`
    // has NO web tools and opencode has no permission CLI flags — the agent is
    // defined in the `OPENCODE_CONFIG` file (see mcp::build_opencode_config) with
    // edit/bash denied + webfetch/websearch allowed. Only meaningful with read_only.
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

/// opencode **read-only** review invocation. The prompt (system + diff) goes on
/// **stdin**, not as an argument — besides the argv-length ceiling, on Windows
/// `opencode` is a `.cmd` and Rust refuses to pass a newline-bearing argument to a
/// batch file ("batch file arguments are invalid"), which every diff prompt is.
///
/// `repo_aware` (Tier 2) lets it read surrounding files for context via opencode's
/// built-in read-only **`plan`** agent — it can glob/read but has no write/edit/bash
/// tools, so it's a hard read-only guarantee even when the review runs in the live
/// repo. `--dangerously-skip-permissions` only auto-approves the *reads* (writes stay
/// impossible in plan mode), so an in-project read doesn't hang or auto-reject.
/// Verified live 2026-06-23. The plain (diff-only) mode invokes no tools at all.
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
    // Path-type keys come first (a tool acting on a file). The FULL path is kept
    // un-clipped: it's load-bearing — the UI relativizes it and uses it as a git
    // pathspec for the inline edit-step diff, so clipping (200-char cut or
    // whitespace-collapse) would corrupt the pathspec. The display is shortened by
    // relativize + CSS truncation instead. (A path is naturally bounded in length.)
    const PATH_KEYS: &[&str] = &["file_path", "filePath", "path", "notebook_path"];
    // Free-text keys (a command / URL / query / prompt) are display-only, so clip
    // them to a sane payload size and collapse newlines to a single line.
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

/// Bound a free-text target (command / URL / query / prompt) to a sane payload
/// size. NOT whitespace-collapsed: the UI renders the row single-line via CSS and
/// an expandable view shows the command verbatim (newlines preserved), so the full
/// command stays readable when expanded — a 200-char clip used to hide the rest.
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
            Some(ReviewEvent::Error {
                message: "Codex review failed — see the Codex CLI for details.".to_string(),
            })
        }
        "error" => {
            *saw_terminal = true;
            Some(ReviewEvent::Error {
                message: v
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("Codex reported an error.")
                    .to_string(),
            })
        }
        _ => None,
    }
}

/// Parses one line of GitHub Copilot CLI `--output-format json` (JSONL). Streams
/// `assistant.message_delta.deltaContent` as narration, keeps the latest
/// `assistant.message.content` as the authoritative final text, and emits `Done` at
/// the terminal `result` (whose `exitCode` decides success). Setup / MCP / skills /
/// reasoning / turn-marker events are ignored.
///
/// Successive assistant messages would otherwise concatenate with no separator
/// ("…real context.Let me check…"), so a paragraph break is lazily PREPENDED to the
/// first non-empty delta after a completed message (`emitted_text`/`pending_sep`).
/// The separator lands before the delta text, so the delta buffer still ends with
/// `Done.text` (which stays verbatim, never separator-prefixed).
fn parse_copilot_line(
    line: &str,
    saw_terminal: &mut bool,
    last_message: &mut String,
    emitted_text: &mut bool,
    pending_sep: &mut bool,
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
            // Empty deltas are dropped here, while the Claude parser still emits
            // `Delta { text: "" }` for them (its pre-separator behavior, kept
            // byte-identical). Both deliberately leave `pending_sep` armed — the
            // separator belongs on the first REAL text.
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
            let msg = v
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Copilot reported an error.");
            if last_message.is_empty() {
                *last_message = msg.to_string();
            }
            None // the terminal `result` carries the exit code; surface there
        }
        "result" => {
            *saw_terminal = true;
            let is_error = v.get("exitCode").and_then(|c| c.as_i64()).unwrap_or(0) != 0;
            Some(ReviewEvent::Done {
                text: std::mem::take(last_message),
                is_error,
                cost_usd: None,
            })
        }
        _ => None,
    }
}

/// Parses one line of opencode `run --format json` (JSONL). opencode has **no**
/// single terminal event — a turn is a sequence of steps; `step_finish` with
/// `reason == "stop"` ends it (`"tool-calls"` means another step follows). It emits
/// whole `text` parts (not token deltas), each a distinct segment, so we stream them
/// as deltas *and* accumulate them. The agent narrates as it works, so the final
/// `Done` carries only the FINAL step's text (the actual answer, in `step_text`) —
/// the earlier steps' narration stays in the `Delta` stream but is stripped off the
/// final body. `last_message` accumulates every step for the degenerate fallback (a
/// final step that produced no text). The generated `sessionID` (on every event) is
/// surfaced once as `NativeSession` so a host resume targets the right session — the
/// store de-dups, so re-emitting is fine.
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
            // Separate consecutive segments so multi-step narration stays readable;
            // the delta mirrors what we append, so the buffer == last_message and its
            // tail == the current step's text.
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
            // The final answer is the final step's text; earlier steps were narration
            // and stay in the delta stream only. Fall back to the full accumulation
            // only for a degenerate final step that produced no text — never emit an
            // empty Done when text existed.
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
            Some(ReviewEvent::Error {
                message: v
                    .get("error")
                    .and_then(|e| e.get("message").or(Some(e)))
                    .and_then(|m| m.as_str())
                    .unwrap_or("opencode reported an error.")
                    .to_string(),
            })
        }
        _ => None,
    }
}

/// Parses one NDJSON line of Claude `--output-format stream-json`. Sets
/// `saw_result` when the terminal `result` event arrives. `tool_inputs`
/// accumulates each in-flight tool call's streamed input JSON, keyed by block
/// index (the input arrives as `input_json_delta` fragments after the block
/// starts); a completed block emits one `Tool` event with the extracted target.
///
/// Consecutive text blocks/messages would otherwise concatenate with no separator
/// ("…real context.Let me check…"), so a paragraph break is lazily PREPENDED to the
/// first non-empty `text_delta` following a completed TEXT block (every text block
/// ends with `content_block_stop`), gated on some text already having been emitted
/// (`emitted_text`/`pending_sep`). The separator lands before the delta text, so the
/// delta buffer still ends with `Done.text` (the raw `result`, never separator-prefixed).
fn parse_claude_line(
    line: &str,
    saw_result: &mut bool,
    tool_inputs: &mut std::collections::HashMap<i64, (String, String)>,
    emitted_text: &mut bool,
    pending_sep: &mut bool,
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
                // A block finished. A tool block (idx in `tool_inputs`) emits one
                // structured Tool step. A TEXT block (idx absent) ends a paragraph:
                // arm the lazy separator so the next message/block's first text delta
                // is prefixed — but only once some text has actually been emitted.
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
        "result" => {
            *saw_result = true;
            Some(ReviewEvent::Done {
                text: v
                    .get("result")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                is_error: v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false),
                cost_usd: v.get("total_cost_usd").and_then(|c| c.as_f64()),
            })
        }
        _ => None,
    }
}

/// Kills the entire process tree of a host-mode agent child on cancel/timeout.
///
/// `child.start_kill()` maps to `TerminateProcess` (Windows) / `SIGKILL`
/// (Unix), which reach only the direct child. The agent CLI is a shim
/// (`claude`, `codex.cmd`→node, `copilot.exe`, `opencode`) that spawns node
/// workers, MCP-server children, and tool subprocesses; killing the shim alone
/// orphans that tree, which keeps consuming tokens, appending to the
/// transcript, and holding worktree file handles. This traverses the tree:
/// `taskkill /T` on Windows, a process-group kill on Unix (the child leads its
/// own group — see the `process_group(0)` at the spawn site).
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
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .spawn();
    }

    // Belt-and-braces: the tree-kill can race the child exiting, and this is
    // the last-resort direct kill on any platform.
    let _ = child.start_kill();
}

/// Spawns an agent CLI, streams its stdout as `ReviewEvent`s until a terminal
/// event / EOF / cancel / timeout, then emits a final `Error` if no terminal
/// result arrived. Shared by `agent_review` (read-only) and `agent_session`
/// (write-enabled, run in a worktree). `cwd` is the process working directory,
/// `cancel_id` keys the cancel registry, and `noun` colors the failure copy.
#[allow(clippy::too_many_arguments)]
async fn stream_agent(
    state: &AppState,
    kind: AgentKind,
    binary: &Path,
    args: Vec<String>,
    stdin_text: String,
    cwd: &str,
    timeout: Duration,
    cancel_id: &str,
    noun: &str,
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
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        if let Some(s) = stderr {
            let _ = BufReader::new(s).read_to_string(&mut buf).await;
        }
        buf
    });

    let stdout = child.stdout.take().expect("stdout was piped");
    let mut lines = BufReader::new(stdout).lines();

    let cancel = state.register_agent_cancel(cancel_id).await;

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

    state.clear_agent_cancel(cancel_id).await;
    let _ = child.wait().await;
    // A killed `docker/podman run` client doesn't stop the container — force-
    // remove it so a cancelled/timed-out agent isn't left running detached.
    if cancelled || timed_out {
        if let Some((runtime, name)) = &container_kill {
            let _ = run_capture(runtime, &["rm", "-f", name], DETECT_TIMEOUT).await;
        }
    }
    let stderr_text = stderr_task.await.unwrap_or_default();

    if cancelled {
        // The frontend tore down its UI on cancel; nothing to emit.
        return Ok(());
    }
    if timed_out {
        on_event.send(ReviewEvent::Error {
            message: format!("The {noun} timed out after {}s.", timeout.as_secs()),
        });
        return Ok(());
    }
    if !saw_result {
        // No terminal result event — surface stderr. Covers auth/quota
        // failures and the empty-stdout-without-a-TTY class of CLI bugs.
        let msg = stderr_text.trim();
        on_event.send(ReviewEvent::Error {
            message: if msg.is_empty() {
                format!("The {noun} process ended without producing any output.")
            } else {
                msg.to_string()
            },
        });
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
    // any ref / blame / list PR comments, instead of relying on the budget-truncated
    // diff in the prompt. Honored for Claude / Copilot / opencode (Codex is exempt —
    // see below). `false` = today's behavior, byte-for-byte.
    mcp_self: bool,
    review_id: String,
    on_event: Channel<ReviewEvent>,
) -> AppResult<()> {
    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
        AppError::Command(format!(
            "{} CLI not found. Install it or set its path in Settings.",
            kind.label()
        ))
    })?;

    // When mcp_self is on and the CLI supports it, generate a per-review MCP config
    // exposing EXACTLY one server — GitDesktop itself, read-only against `repo_path`.
    // Written into `<app_data>/mcp` keyed by `review_id` (a UUID, so `validate_id`
    // passes), the SAME lifecycle sessions use; removed after the run on every path.
    // Codex is excluded: host `codex exec` cancels every MCP tool call (stdin EOF →
    // "declined", upstream — the same wall `agent_session` documents for host Codex),
    // and Codex reviews already self-explore the repo, so mcp_self is ignored for it.
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
            // Claude has no effort flag — raise the thinking budget by appending a
            // keyword to the user turn (same as a session).
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
        // Copilot: read-only review. The prompt (system + diff) is an argument, not
        // stdin. `repo_aware` adds a deny-write/deny-shell tool allowlist so it can
        // read surrounding files without being able to modify the repo.
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
    let extra_env: Vec<(&str, String)> = match (kind, &mcp_config_path) {
        (AgentKind::Opencode, Some(path)) => vec![("OPENCODE_CONFIG", path.clone())],
        _ => Vec::new(),
    };

    // Codex always explores the repo, so it gets the longer agentic budget too — and
    // a self-MCP review is agentic regardless of `repo_aware` (the agent pulls the
    // full diff / reads files via the server), so it gets the agentic budget too.
    let timeout = if repo_aware || self_mcp_wanted || matches!(kind, AgentKind::Codex) {
        REVIEW_TIMEOUT_AGENTIC
    } else {
        REVIEW_TIMEOUT
    };
    let result = stream_agent(
        &state, kind, &binary, args, stdin_text, &repo_path, timeout, &review_id, "review", None,
        &extra_env, &on_event,
    )
    .await;
    // Remove the generated config on EVERY path (success, error), mirroring the
    // session lifecycle — even though the self-spec carries no secrets. No-op when
    // nothing was written.
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
    state.cancel_agent(&review_id).await;
    Ok(())
}

/// Runs one turn of a write-capable agent session: the CLI implements
/// `user_prompt` full-auto inside `worktree_path` (a throwaway worktree — the
/// sandbox boundary). `resume = false` starts the session; `resume = true`
/// continues it (keeping context). Streams the same `ReviewEvent`s as a review;
/// cancel via `agent_review_cancel` with the same `session_id`.
///
/// `agent` picks the CLI. Each runs worktree-confined on the **host** (Claude full-
/// auto via `bypassPermissions` — soft until its permission prompt lands; Codex via
/// its own OS sandbox, `-s workspace-write`; Copilot via `--add-dir`; opencode via
/// `--dangerously-skip-permissions`) or in a **container** (kernel boundary; Codex is
/// container-only). Copilot's container authenticates from a `gh auth token` passed by
/// env, since its login isn't a mountable creds file like the others'.
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
    // Web-enabled read-only profile (a Research conversation): each CLI gains its
    // native web tools while still never writing — Claude WebSearch/WebFetch, Codex
    // live web_search, Copilot web_fetch + GitHub MCP, opencode a generated
    // read-only-web agent (webfetch/websearch). Only meaningful alongside `read_only`;
    // Plan/Delegate pass false, so they're untouched.
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
    // `mcp__<server>` allowlist entries so the opted-in servers' tools are usable:
    // loading them via `--mcp-config` does NOT admit them past `--tools` (proven by
    // live testing — the server connected but its tools stayed uncallable without this).
    // (Claude only — host AND container; the others need no allowlist.)
    let mcp_tools = crate::mcp::tool_allow_patterns(&mcp_specs);
    // Each CLI takes its MCP config differently — `mcp_config_path` holds the value for
    // whichever CLI's config flag applies here (consumed by the inner builders below):
    //  - Claude: a JSON file via `--mcp-config` (strict) + a `mcp__<server>` tool allowlist;
    //    HOST = a host file path, CONTAINER = the mounted `/home/node/.claude/mcp.json`.
    //  - Copilot: HOST = `--additional-mcp-config @<path>`; CONTAINER = none (the file is
    //    written to `~/.copilot/mcp-config.json` in the mounted home, which Copilot auto-loads).
    //    `--allow-all-tools` auto-approves the tools — no allowlist, no host-Codex wall.
    //  - opencode: the `OPENCODE_CONFIG` env var (HOST = via the spawn env; CONTAINER = `-e`
    //    on the run, set in the container branch). `--dangerously-skip-permissions` approves.
    //  - Codex: container ONLY — a `config.toml` in the mounted `~/.codex` (host Codex cancels
    //    every MCP tool call, stdin EOF → "declined", upstream). stdio servers only.
    // The config FILE is written HERE for host sessions and in the container branch below
    // (uniform, all agents) for container ones. Codex-on-host is the only rejected combo.
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
                     approve MCP tool calls. Turn on container isolation in Settings → AI."
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
            // Claude has no effort flag — raise the thinking budget by appending a
            // keyword to the user turn (applies per-turn, so on resume too).
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
            // `--add-dir` must point at where the worktree actually is for this run:
            // the bind-mount `/workspace` in a container, or the real host path on the
            // host. Passing the host path into the container would name a nonexistent
            // dir (live-verified: the container confines to /workspace either way).
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
            AppError::Command(if matches!(kind, AgentKind::Codex) {
                // Codex is container-only, so "turn isolation off" isn't an option.
                "Codex sessions need Docker or Podman (they run only in a container). Install and start it, then build the image in Settings → AI — or use Claude instead.".to_string()
            } else {
                "Container isolation is on, but Docker/Podman isn't available. Install/start it or turn isolation off in Settings.".to_string()
            })
        })?;
        if !crate::agent_sandbox::image_present(&runtime).await {
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
        // Fail early with a clear message if the agent isn't logged in on the host
        // (its creds are what we mount into the container). opencode is exempt — its
        // free hosted models need no credentials, so a container runs keyless. Copilot
        // is exempt too: it has no mountable creds file, so it authenticates from a
        // GitHub token passed by env (sourced from `gh auth token`, fetched below).
        if !matches!(kind, AgentKind::Opencode | AgentKind::Copilot)
            && !crate::agent_sandbox::host_logged_in(agent_name)
        {
            return Err(AppError::Command(format!(
                "{} isn't logged in on this machine. Sign in with its CLI first, then start the session.",
                kind.label()
            )));
        }
        // Copilot's login lives in the OS keychain (not a mountable file), so a
        // containerized session authenticates with a GitHub token instead. The CLI
        // reads `COPILOT_GITHUB_TOKEN`; we source it from the GitHub CLI the app
        // already drives. Passed by-name to the runtime client (see `extra_env`) so
        // the token never lands in argv / `docker inspect`.
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
        // Write the opted-in MCP servers into the mounted home so the in-container CLI
        // loads them. The seeded home is clean (only the agent's creds), so the file is
        // the ONLY MCP source — strict, regardless of CLI. Each CLI's filename + format
        // differ (`container_mcp_config` maps them); the body is the per-CLI config
        // (secrets resolved into the file, never argv). REMOVE a stale file when this
        // turn has none, so a de-selected server stops loading — the CLIs read the file
        // implicitly (no host-style `--strict-mcp-config` to ignore a leftover).
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
            &state,
            kind,
            &runtime,
            args,
            stdin_text,
            &worktree_path,
            SESSION_TIMEOUT,
            &session_id,
            "session",
            Some((runtime.clone(), name)),
            &extra_env,
            &on_event,
        )
        .await;
    }

    // Host: both agents run worktree-confined — Claude via `bypassPermissions`
    // (soft FS boundary until its permission prompt lands), Codex via its own OS
    // sandbox (`-s workspace-write`; really confines writes — see codex_session_args).
    let binary = resolve(kind, bin_path.as_deref()).await.ok_or_else(|| {
        AppError::Command(format!(
            "{} CLI not found. Install it or set its path in Settings.",
            kind.label()
        ))
    })?;
    // opencode takes its MCP config (and our Research agent) via the `OPENCODE_CONFIG`
    // env var (it has no config-file flag); set it whenever we wrote a config file.
    // opencode merges config layers, so this adds ours without replacing the user's.
    // (Claude/Copilot carry their config in argv, so they need no extra env.)
    let mut host_extra_env: Vec<(&str, String)> = match (kind, &mcp_config_path) {
        (AgentKind::Opencode, Some(path)) => vec![("OPENCODE_CONFIG", path.clone())],
        _ => Vec::new(),
    };
    if opencode_research {
        // Enable opencode's Exa-backed websearch tool (webfetch works regardless).
        host_extra_env.push(("OPENCODE_ENABLE_EXA", "1".to_string()));
    }
    stream_agent(
        &state,
        kind,
        &binary,
        inner,
        stdin_text,
        &worktree_path,
        SESSION_TIMEOUT,
        &session_id,
        "session",
        None,
        &host_extra_env,
        &on_event,
    )
    .await
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
        let start = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read","input":{}}}}"#;
        let d1 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_pa"}}}"#;
        let d2 = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"th\":\"src/x.ts\"}"}}}"#;
        let stop = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#;
        assert!(parse_claude_line(start, &mut saw, &mut acc, &mut emitted, &mut pending).is_none());
        assert!(parse_claude_line(d1, &mut saw, &mut acc, &mut emitted, &mut pending).is_none());
        assert!(parse_claude_line(d2, &mut saw, &mut acc, &mut emitted, &mut pending).is_none());
        let ev = parse_claude_line(stop, &mut saw, &mut acc, &mut emitted, &mut pending).unwrap();
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
            let ev = parse_claude_line(line, &mut saw, &mut acc, &mut emitted, &mut pending).unwrap();
            match ev {
                ReviewEvent::Delta { text } => {
                    assert_eq!(text, expect.unwrap());
                    buffer.push_str(&text);
                }
                other => panic!("expected Delta, got {other:?}"),
            }
        }
        // Block-1 stop arms the separator; the tool block's stop leaves it armed.
        parse_claude_line(stop1, &mut saw, &mut acc, &mut emitted, &mut pending);
        assert!(pending, "a text block's stop arms the separator");
        parse_claude_line(tstart, &mut saw, &mut acc, &mut emitted, &mut pending);
        parse_claude_line(tstop, &mut saw, &mut acc, &mut emitted, &mut pending);
        assert!(pending, "a tool block's stop leaves the pending separator intact");

        // Block-2's first delta is prefixed `\n\n`.
        let ev = parse_claude_line(t2, &mut saw, &mut acc, &mut emitted, &mut pending).unwrap();
        match ev {
            ReviewEvent::Delta { text } => {
                assert_eq!(text, "\n\nThe fix is X.");
                buffer.push_str(&text);
            }
            other => panic!("expected Delta, got {other:?}"),
        }
        parse_claude_line(stop2, &mut saw, &mut acc, &mut emitted, &mut pending);

        let done = parse_claude_line(result, &mut saw, &mut acc, &mut emitted, &mut pending).unwrap();
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

    #[test]
    fn copilot_lazy_separator_between_assistant_messages() {
        // Deltas across two assistant messages get exactly one `\n\n` between them.
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let d1 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"First."}}"#;
        let m1 = r#"{"type":"assistant.message","data":{"content":"First."}}"#;
        let d2 = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Second."}}"#;

        let ev = parse_copilot_line(d1, &mut term, &mut msg, &mut emitted, &mut pending).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "First."));
        // A completed message arms the separator; the next delta is prefixed once.
        assert!(parse_copilot_line(m1, &mut term, &mut msg, &mut emitted, &mut pending).is_none());
        assert!(pending);
        let ev = parse_copilot_line(d2, &mut term, &mut msg, &mut emitted, &mut pending).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "\n\nSecond."));
        assert!(!pending, "the separator is consumed by the first following delta");
    }

    #[test]
    fn copilot_first_delta_has_no_separator() {
        // The very first delta of a run must not be prefixed (nothing emitted before).
        let (mut term, mut msg) = (false, String::new());
        let (mut emitted, mut pending) = (false, false);
        let d = r#"{"type":"assistant.message_delta","data":{"deltaContent":"Hello."}}"#;
        let ev = parse_copilot_line(d, &mut term, &mut msg, &mut emitted, &mut pending).unwrap();
        assert!(matches!(ev, ReviewEvent::Delta { text } if text == "Hello."));
        assert!(emitted);
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

    // Runtime validation of the actual registry read (not just the expander):
    // HKLM's Session Manager Environment Path always exists on Windows and always
    // contains the (expandable) system32 dir, so a working read returns a
    // non-empty list with at least one real directory in it. This is what proves
    // the open_subkey + get_value + %VAR% expansion path works against the live
    // registry on the build machine — the bit a pure-logic test can't cover.
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
        // No self-MCP: no `--mcp-config`, tools are the plain repo-aware/diff-only set,
        // and `--strict-mcp-config` is still present. This locks the mcp_self=false path
        // to today's behavior.
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
        dyn_sink.send(ReviewEvent::Error {
            message: "boom".to_string(),
        });

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], ReviewEvent::Delta { text } if text == "hello"));
        assert!(matches!(&events[1], ReviewEvent::Error { message } if message == "boom"));
    }
}
