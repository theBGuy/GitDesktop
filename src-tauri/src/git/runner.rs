use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);

pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl GitOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// The resolved `git` binary, memoized for the process lifetime.
///
/// `run_git_raw_input` is the base of the whole git call stack (status, diffs,
/// history, staging — all firing continuously as the user works), and a packaged
/// GUI app on macOS doesn't inherit the user's shell PATH. So we resolve `git`
/// the way the About screen does (`crate::agent::resolve_named`: PATH + known
/// install dirs + a macOS login-shell fallback / the live Windows registry PATH)
/// rather than a bare `Command::new("git")`, which finds nothing when the app is
/// launched from Finder/Dock.
///
/// The result is cached because resolving isn't free: the login-shell fallback
/// (for a git install outside `candidate_dirs()`, e.g. MacPorts `/opt/local/bin`)
/// spawns `$SHELL -lic` with a 20s timeout, and re-running it on every git call
/// would serialize the whole app behind it. Only a *successful* resolution is
/// cached — `get_or_try_init` leaves the cell empty on error — so a git installed
/// after launch is still picked up on the next call without a restart.
static GIT_BIN: OnceCell<PathBuf> = OnceCell::const_new();

async fn git_bin() -> AppResult<PathBuf> {
    GIT_BIN
        .get_or_try_init(|| async {
            crate::agent::resolve_named(&["git"], None)
                .await
                .ok_or(AppError::GitNotFound)
        })
        .await
        .cloned()
}

/// Runs git and returns the raw output regardless of exit code.
/// Only spawn failures and timeouts are errors.
pub async fn run_git_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_raw_input(repo_path, args, None, timeout).await
}

/// Like `run_git_raw`, but optionally feeds `input` to git's stdin
/// (e.g. a patch for `git apply -`).
pub async fn run_git_raw_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    let git = git_bin().await?;
    let mut cmd = Command::new(&git);
    // Also covers the credential helpers git spawns in turn.
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(["-c", "core.quotePath=false", "-c", "color.ui=false"]);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.kill_on_drop(true);

    // `git_bin()` already confirmed the binary exists, so a spawn-time NotFound
    // means the memoized path went stale mid-session (git moved/removed) — still
    // "git not found" to the user; anything else is a genuine I/O error.
    let spawn_err = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::GitNotFound
        } else {
            AppError::Io(e)
        }
    };
    let run = async {
        let mut child = cmd.spawn().map_err(spawn_err)?;
        if let Some(text) = input {
            use tokio::io::AsyncWriteExt;
            // Dropping the handle closes the pipe so git sees EOF.
            let mut stdin = child.stdin.take().expect("stdin was piped");
            stdin.write_all(text.as_bytes()).await.map_err(AppError::Io)?;
        }
        child.wait_with_output().await.map_err(AppError::Io)
    };
    let output = tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))??;

    Ok(GitOutput {
        stdout: output.stdout,
        stderr: strip_eol_warnings(&String::from_utf8_lossy(&output.stderr)),
        code: output.status.code().unwrap_or(-1),
    })
}

/// With core.autocrlf on, git emits a "LF will be replaced by CRLF the next
/// time Git touches it" advisory for every touched file. It's harmless noise
/// that bloats error toasts (and rides along when a command genuinely fails),
/// so drop those lines — and the CRLF→LF variant — from captured stderr.
fn strip_eol_warnings(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !is_eol_warning(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_eol_warning(line: &str) -> bool {
    line.contains("will be replaced by CRLF")
        || line.contains("will be replaced by LF")
        || line.contains("original line endings in your working directory")
}

/// Runs git, treating any non-zero exit code as an error carrying stderr.
pub async fn run_git(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_input(repo_path, args, None, timeout).await
}

/// `run_git` with optional stdin input.
pub async fn run_git_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    let out = run_git_raw_input(repo_path, args, input, timeout).await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.stderr,
        });
    }
    Ok(out)
}

/// The working tree's toplevel for `repo_path`, which may be any directory
/// inside it.
///
/// Anything that reads repo-relative NAMES out of git, or hands git pathspecs
/// meant to match them, has to bind to this rather than to the path it was
/// given: git prints and resolves both relative to the cwd, so a subdirectory
/// silently re-scopes the answer while still looking well-formed. The MCP server
/// takes `--repo` verbatim, so that subdirectory is reachable.
pub(crate) async fn worktree_toplevel(repo_path: &str) -> AppResult<String> {
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let stdout = out.stdout_lossy();
    // Line endings ONLY: a trailing space can be part of the directory name, and
    // `trim()` would strip it into a path that does not exist.
    let toplevel = stdout.trim_end_matches(['\r', '\n']).to_string();
    if toplevel.is_empty() {
        return Err(AppError::NotARepo(repo_path.to_string()));
    }
    Ok(toplevel)
}

/// Runs a mutating git command under the per-repo lock, retrying once on
/// index.lock contention caused by external tools (editors, other clients).
pub async fn run_git_mutating(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_mutating_input(state, repo_path, args, None, timeout).await
}

/// `run_git_mutating` with optional stdin input.
pub async fn run_git_mutating_input(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    let lock = state.repo_lock(repo_path).await;
    let _guard = lock.lock().await;
    match run_git_input(Some(repo_path), args, input, timeout).await {
        Err(AppError::Git { ref stderr, .. }) if stderr.contains("index.lock") => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            run_git_input(Some(repo_path), args, input, timeout).await
        }
        other => other,
    }
}
