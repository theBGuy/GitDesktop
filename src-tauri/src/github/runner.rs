use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

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

/// Runs the GitHub CLI and returns raw output regardless of exit code. Only a
/// missing `gh` binary or a timeout is an error here.
pub async fn run_gh_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GhOutput> {
    // Resolve `gh` the way the About screen and the glab runner do
    // (`resolve_named`: PATH + known install dirs + a macOS login-shell fallback /
    // the live Windows registry PATH). A packaged GUI app launched from Finder,
    // the Dock, or a desktop launcher does NOT inherit the user's shell PATH, so a
    // bare `Command::new("gh")` misses a Homebrew-installed gh (`/opt/homebrew/bin`)
    // — which is why every gh-backed surface read "not found" while About, which
    // uses resolve_named, showed gh installed.
    let Some(gh) = crate::agent::resolve_named(&["gh"], None).await else {
        return Err(AppError::GhNotFound);
    };
    let mut cmd = Command::new(&gh);
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

    // Resolve `gh` via `resolve_named` (see `run_gh_raw` for why a bare
    // `Command::new("gh")` fails in a packaged GUI app on macOS).
    let Some(gh) = crate::agent::resolve_named(&["gh"], None).await else {
        return Err(AppError::GhNotFound);
    };
    let mut cmd = Command::new(&gh);
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
