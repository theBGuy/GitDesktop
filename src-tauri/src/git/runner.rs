use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

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
    // Resolve `git` the way the About screen does (`resolve_named`: PATH + known
    // install dirs + a macOS login-shell fallback / the live Windows registry
    // PATH). A packaged GUI app launched from Finder/Dock doesn't inherit the
    // user's shell PATH, so a bare `Command::new("git")` misses a Homebrew-only
    // git (no Xcode command-line tools at `/usr/bin/git`) — mirroring the gh and
    // glab runners.
    let Some(git) = crate::agent::resolve_named(&["git"], None).await else {
        return Err(AppError::GitNotFound);
    };
    let mut cmd = Command::new(&git);
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
