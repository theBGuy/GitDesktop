use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

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

/// Runs the GitHub CLI and returns raw output regardless of exit code. Only a
/// missing `gh` binary or a timeout is an error here.
pub async fn run_gh_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    let gh = gh_bin().await?;
    let mut cmd = Command::new(&gh);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    // Keep gh fully non-interactive: no prompts, no pager, no update nags.
    cmd.env("GH_PAGER", "")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("CLICOLOR", "0")
        .env("NO_COLOR", "1");
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

/// Like `run_gh`, but pipes `input` to gh's stdin — for `gh api --input -` with
/// a JSON body (webhook create/update), where nested `config`/`events` don't
/// fit the flat `-f key=value` form. Non-zero exit is an error carrying stderr.
pub async fn run_gh_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    use tokio::io::AsyncWriteExt;

    let gh = gh_bin().await?;
    let mut cmd = Command::new(&gh);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GH_PAGER", "")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("CLICOLOR", "0")
        .env("NO_COLOR", "1");
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
    // Write the body and close stdin so gh reads EOF (body is small — no
    // deadlock risk from not draining stdout concurrently).
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(AppError::Io)?;
        stdin.shutdown().await.ok();
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
        .map_err(AppError::Io)?;

    let out = GhOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    };
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
