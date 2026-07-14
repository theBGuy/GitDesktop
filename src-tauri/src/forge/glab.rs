//! The GitLab CLI (`glab`) runner — the GitLab analogue of `github::runner`.
//!
//! Per the locked decision (`docs/multi-provider-support.md` §0), GitLab speaks
//! through `glab`, which mirrors `gh` (same porcelain + a `glab api` escape hatch)
//! and carries auth + self-managed hosts for free. So the GitLab `Forge` impl
//! shells out to `glab` exactly the way the GitHub impl uses `gh`.
//!
//! NOTE: the exact `glab` flags/output here are a first cut and need live
//! validation against a real `glab` (the `--version` / `auth status` contracts);
//! treated as runtime-validate, like the agent-CLI integrations.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};

pub const GLAB_TIMEOUT: Duration = Duration::from_secs(30);
pub const GLAB_NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

pub struct GlabOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl GlabOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// The resolved `glab` binary, memoized for the process lifetime.
///
/// A packaged GUI app on macOS doesn't inherit the user's shell PATH, so we
/// resolve `glab` via `crate::agent::resolve_named` (PATH + known install dirs +
/// a macOS login-shell fallback / the live Windows registry PATH) rather than a
/// bare `Command::new("glab")`, which reads "not found" when launched from
/// Finder/Dock. Cached exactly like the `git`/`gh` runners
/// (`git::runner::git_bin`): the login-shell fallback isn't free, and only a
/// *successful* resolution is cached, so a glab installed after launch is still
/// picked up on the next call without a restart.
static GLAB_BIN: OnceCell<PathBuf> = OnceCell::const_new();

async fn glab_bin() -> AppResult<PathBuf> {
    GLAB_BIN
        .get_or_try_init(|| async {
            crate::agent::resolve_named(&["glab"], None)
                .await
                .ok_or(AppError::GlabNotFound)
        })
        .await
        .cloned()
}

/// Runs `glab` and returns raw output regardless of exit code. Only a missing
/// `glab` binary or a timeout is an error here (mirrors `run_gh_raw`).
pub async fn run_glab_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GlabOutput> {
    let glab = glab_bin().await?;
    let mut cmd = Command::new(&glab);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    // Keep glab non-interactive + quiet (stdin null already blocks prompts).
    cmd.env("GLAB_PAGER", "")
        .env("PAGER", "")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
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
                AppError::GlabNotFound
            } else {
                AppError::Io(e)
            }
        })?;

    Ok(GlabOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

// ── Known hosts (self-managed GitLab detection) ─────────────────────────────
//
// A repo on a custom domain is indistinguishable from GitHub Enterprise by its
// remote URL alone. glab's own config is the authority: any host the user has
// signed glab in to (`glab auth login --hostname …`) appears as a key of the
// `hosts:` section of its config.yml. Detection reads that file directly — it
// runs on every forge command, so spawning `glab auth status` here would be far
// too slow, while a small local file read is negligible next to the git-remote
// lookup that precedes it.

/// Candidate glab config files, mirroring glab's own resolution
/// (gitlab-org/cli `config_file.go`): `GLAB_CONFIG_DIR` is EXCLUSIVE when set
/// (glab uses it even when empty — falling back would make the app claim a
/// host glab itself would ignore); otherwise the legacy `~/.config/glab-cli`
/// wins whenever its config exists (first-readable gives that for free), then
/// the platform XDG config home (Windows `%LOCALAPPDATA%`, macOS
/// `~/Library/Application Support`, Linux `~/.config` — the `adrg/xdg`
/// defaults glab links).
fn glab_config_paths() -> Vec<PathBuf> {
    let env_dir = |var: &str| -> Option<PathBuf> {
        std::env::var(var)
            .ok()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
    };
    if let Some(d) = env_dir("GLAB_CONFIG_DIR") {
        return vec![d.join("config.yml")];
    }
    #[cfg(windows)]
    let home = env_dir("USERPROFILE");
    #[cfg(not(windows))]
    let home = env_dir("HOME");

    let mut dirs: Vec<PathBuf> = Vec::new();
    // Legacy dir first: glab prefers it whenever its config.yml exists, and
    // known_hosts takes the first READABLE candidate.
    if let Some(h) = &home {
        dirs.push(h.join(".config").join("glab-cli"));
    }
    if let Some(x) = env_dir("XDG_CONFIG_HOME") {
        dirs.push(x.join("glab-cli"));
    }
    #[cfg(windows)]
    if let Some(d) = env_dir("LOCALAPPDATA") {
        dirs.push(d.join("glab-cli"));
    }
    #[cfg(target_os = "macos")]
    if let Some(h) = &home {
        dirs.push(
            h.join("Library")
                .join("Application Support")
                .join("glab-cli"),
        );
    }
    dirs.into_iter().map(|d| d.join("config.yml")).collect()
}

/// A bare lowercase hostname from a config value that may carry a scheme, a
/// port, or a path (`https://gitlab.example.com:8443/` → `gitlab.example.com`).
/// Ports are stripped to match what `remote_host` yields for remote URLs.
fn normalize_host(value: &str) -> Option<String> {
    let rest = value.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, after)| after);
    let host = rest.split(['/', ':']).next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The host keys of the `hosts:` section of a glab config.yml. A minimal
/// line scanner, not a YAML parser: glab writes plain unquoted keys, and the
/// file also holds live tokens — only key NAMES may leave this function, so
/// values are never inspected at all.
fn hosts_from_config(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut in_hosts = false;
    let mut key_indent: Option<usize> = None;
    for line in text.lines() {
        let content = line.trim_end();
        if content.trim_start().starts_with('#') || content.trim().is_empty() {
            continue;
        }
        let indent = content.len() - content.trim_start().len();
        if !in_hosts {
            in_hosts = indent == 0 && content == "hosts:";
            continue;
        }
        // Any top-level key (or a dedent past the host level) ends the section.
        if indent == 0 {
            break;
        }
        let level = *key_indent.get_or_insert(indent);
        if indent > level {
            continue; // a host's own sub-keys (token, api_host, …)
        }
        if indent < level {
            break;
        }
        // A host entry is `<host>:` with nothing after the colon.
        if let Some(key) = content.trim_start().strip_suffix(':') {
            if let Some(host) = normalize_host(key) {
                hosts.push(host);
            }
        }
    }
    hosts
}

/// The GitLab hosts glab is configured for: the `hosts:` keys of the first
/// readable config.yml, plus `GITLAB_HOST` when set. Canonical non-GitLab hosts
/// are never claimed, whatever the config says. Missing/unreadable config →
/// just the env var (or empty), so the GitHub default stays authoritative.
pub async fn known_hosts() -> Vec<String> {
    let mut hosts = Vec::new();
    for path in glab_config_paths() {
        if let Ok(text) = tokio::fs::read_to_string(&path).await {
            hosts = hosts_from_config(&text);
            break;
        }
    }
    if let Ok(env_host) = std::env::var("GITLAB_HOST") {
        if let Some(host) = normalize_host(&env_host) {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    }
    hosts.retain(|h| h != "github.com" && h != "bitbucket.org");
    hosts
}

/// Runs glab, treating any non-zero exit as an error carrying glab's stderr
/// (mirrors `run_gh`). For read ops where a failure should surface, not be empty.
pub async fn run_glab(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GlabOutput> {
    let out = run_glab_raw(repo_path, args, timeout).await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(AppError::Glab(if msg.is_empty() {
            format!("glab exited with code {}", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(out)
}

/// Runs glab with optional stdin `input` and optional extra environment variables,
/// treating a non-zero exit as an error (like `run_glab`). The additive variant
/// backing two needs the base `run_glab` signature can't serve without churning
/// every call site:
///  - `input` feeds a nested-JSON body to `glab api --input -` (flat `-f
///    position[x]=y` is SILENTLY IGNORED by GitLab — the known nested-JSON trap).
///  - `envs` carries a bot `GITLAB_TOKEN` (+ `GITLAB_HOST`) so a note is authored by
///    the project bot rather than the signed-in user (env overrides glab's config,
///    probe-proven). NEVER logged.
pub async fn run_glab_ex(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    envs: &[(&str, &str)],
    timeout: Duration,
) -> AppResult<GlabOutput> {
    let glab = glab_bin().await?;
    let mut cmd = Command::new(&glab);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GLAB_PAGER", "")
        .env("PAGER", "")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0");
    for (k, v) in envs {
        cmd.env(k, v);
    }
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

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::GlabNotFound
        } else {
            AppError::Io(e)
        }
    })?;
    if let Some(body) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(body.as_bytes())
                .await
                .map_err(AppError::Io)?;
            stdin.shutdown().await.ok();
        }
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
        .map_err(AppError::Io)?;
    let out = GlabOutput {
        stdout: output.stdout,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    };
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(AppError::Glab(if msg.is_empty() {
            format!("glab exited with code {}", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod known_hosts_tests {
    use super::{hosts_from_config, normalize_host};

    #[test]
    fn extracts_host_keys_only() {
        // Mirrors the real config shape: comments, top-level scalars, host
        // entries with their own nested keys (including token values that must
        // never be returned).
        let config = "\
# What protocol to use.
git_protocol: ssh
host: gitlab.com
hosts:
    gitlab.com:
        api_protocol: https
        token: !!null secret-token-value
        user: someone
    # an interspersed comment
    GitLab.ACME.dev:
        token: another-secret
check_update: true
";
        assert_eq!(
            hosts_from_config(config),
            vec!["gitlab.com".to_string(), "gitlab.acme.dev".to_string()]
        );
    }

    #[test]
    fn empty_or_missing_hosts_section() {
        assert!(hosts_from_config("git_protocol: ssh\n").is_empty());
        // An empty `hosts:` followed by another top-level key.
        assert!(hosts_from_config("hosts:\ncheck_update: true\n").is_empty());
    }

    #[test]
    fn never_treats_values_or_deep_keys_as_hosts() {
        let config = "\
hosts:
    gitlab.example.com:
        custom_headers:
            evil.example.com:
        api_host: gitlab.example.com
";
        assert_eq!(hosts_from_config(config), vec!["gitlab.example.com"]);
    }

    #[test]
    fn normalizes_schemes_ports_and_case() {
        assert_eq!(
            normalize_host("https://GitLab.Example.com:8443/gitlab"),
            Some("gitlab.example.com".into())
        );
        assert_eq!(
            normalize_host("gitlab.example.com"),
            Some("gitlab.example.com".into())
        );
        assert_eq!(normalize_host("  "), None);
    }
}
