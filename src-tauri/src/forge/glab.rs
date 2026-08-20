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
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    // Keep glab non-interactive + quiet (stdin null already blocks prompts).
    // GLAB_CHECK_UPDATE is glab's update-notice switch and its polarity is
    // inverted from gh's GH_NO_UPDATE_NOTIFIER — glab gates on the value being
    // TRUE (cmd/glab/main.go `isUpdateCheckEnabled`, verified against v1.105.0).
    // The value is `strconv.ParseBool`'d, so it must be a bool literal: an empty
    // string logs a parse warning to stderr instead of disabling anything, and
    // the notice it suppresses writes to stderr, where it would ride along in
    // AppError::Glab and in the reconnect child's merged line scan.
    cmd.env("GLAB_PAGER", "")
        .env("PAGER", "")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GLAB_CHECK_UPDATE", "false");
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

/// True for the `hosts:` section header. Only a trailing comment may follow the
/// colon: `hosts2:` is a different key, and a flow-form `hosts: {…}` holds no
/// line-scannable entries.
fn is_hosts_header(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("hosts:") else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    // YAML opens a comment only after whitespace, so `hosts:#x` is a plain
    // scalar value — a section header with a value holds no scannable entries.
    rest.starts_with(char::is_whitespace) && rest.trim_start().starts_with('#')
}

/// The line with a leading `<scheme>://` removed, so the first colon left is the
/// key's own. Guarded on the scheme's own shape: a bare `://` search would also
/// hit a URL in the line's VALUE (a trailing comment, a flow map) and eat the key.
fn strip_scheme(trimmed: &str) -> &str {
    match trimmed.split_once("://") {
        Some((scheme, after))
            if !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) =>
        {
            after
        }
        _ => trimmed,
    }
}

/// The flow-collection nesting depth after `text`, counting bracket characters
/// only — no value is read. Only ever runs on text already known to sit inside a
/// flow collection: the value that opened it, or a later continuation line. A
/// trailing comment is dropped first so a `{` in prose can't wedge it open.
fn flow_depth_after(depth: usize, text: &str) -> usize {
    let code = text
        .char_indices()
        .find(|&(i, c)| c == '#' && text[..i].ends_with(char::is_whitespace))
        .map_or(text, |(i, _)| &text[..i]);
    code.chars().fold(depth, |d, c| match c {
        '{' | '[' => d + 1,
        '}' | ']' => d.saturating_sub(1),
        _ => d,
    })
}

/// The key and value of a `key: value` line. A QUOTED key is unquoted here,
/// before any colon is looked for: YAML puts a colon inside the quotes (a port,
/// a scheme), where splitting at the first colon cuts the key in half and bakes a
/// quote into the hostname. An unbalanced quote yields None — the module's bias is
/// never to drop a host, but a line whose quoting is broken has no readable key,
/// and a corrupted entry (a junk account row Settings then probes) is worse than
/// one dropped hand-mangled line. Both readers of a key line share this split, so
/// a well-formed key ends in the same place for host extraction and for flow-depth
/// tracking. None means BOTH stand down: an unbalanced-quote line that also opens a
/// flow map has its depth left untracked, so its wrapped continuation can still be
/// scanned as a key — accepted, since only triple-mangled input reaches it.
///
/// Quote handling is YAML-spec-grounded (a reader unquotes keys) rather than
/// glab-source-verified: glab's own writer never emits a quoted key, so only a
/// hand-edited config reaches this branch.
fn split_key_value(trimmed: &str) -> Option<(&str, &str)> {
    if let Some(quote) = trimmed.chars().next().filter(|c| matches!(c, '\'' | '"')) {
        let rest = &trimmed[quote.len_utf8()..];
        let end = rest.find(quote)?;
        let after = rest[end + quote.len_utf8()..].trim_start();
        return Some((&rest[..end], after.strip_prefix(':')?));
    }
    // Unquoted: the FIRST colon, scheme term included — without it a
    // `https://host: {…}` line splits at the scheme and its flow map goes unseen,
    // so the wrapped continuation is read back as a host key.
    strip_scheme(trimmed).split_once(':')
}

/// The flow-collection depth a key line OPENS. Zero unless its value BEGINS with
/// `{`/`[` — that is the only place YAML starts a flow collection, so a bracket
/// inside a plain scalar (`token: abc[def`) must not latch the scanner shut.
fn flow_open_depth(trimmed: &str) -> usize {
    let Some((_, value)) = split_key_value(trimmed) else {
        return 0;
    };
    let value = value.trim_start();
    if value.starts_with(['{', '[']) {
        flow_depth_after(0, value)
    } else {
        0
    }
}

/// The host a line at host-key indent declares, if it declares one. Whatever
/// follows the colon is a value — an anchor, alias, flow map, or comment — and
/// is never inspected, so any `key:`-shaped line names a host except the YAML
/// merge key `<<`, which is a mapping directive. A key carrying whitespace or a
/// comma is never a hostname and is refused: that is the one shape a stray value
/// fragment (a mis-indented flow continuation) could otherwise arrive in.
fn host_from_key_line(trimmed: &str) -> Option<String> {
    let key = split_key_value(trimmed)?.0.trim();
    if key == "<<" || key.contains(char::is_whitespace) || key.contains(',') {
        return None;
    }
    // A quoted key arrives already unquoted; `normalize_host` strips whatever
    // scheme, port, or path the quotes were protecting.
    normalize_host(key)
}

/// The host keys of the `hosts:` section of a glab config.yml. A minimal line
/// scanner, not a YAML parser: it accepts the hand-written forms glab's own
/// writer never emits (anchors, aliases, comments, quoted keys) because a
/// dropped host silently disables GitLab detection for that config. The file
/// also holds live tokens — only key NAMES may leave this function, so values
/// are never inspected at all. A non-host key under `hosts:` (an anchor-definition
/// block, an alias key) is therefore reported as a host — parity with glab, which
/// unmarshals the section as host→config and reads that key as a host too.
fn hosts_from_config(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut in_hosts = false;
    let mut key_indent: Option<usize> = None;
    let mut flow_depth = 0usize;
    for line in text.lines() {
        let content = line.trim_end();
        let trimmed = content.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let indent = content.len() - trimmed.len();
        if !in_hosts {
            in_hosts = indent == 0 && is_hosts_header(trimmed);
            continue;
        }
        // A line continuing an open flow collection is value text whatever its
        // indent, so it is never a key and never ends the section.
        if flow_depth > 0 {
            flow_depth = flow_depth_after(flow_depth, trimmed);
            continue;
        }
        // Any top-level key (or a dedent past the host level) ends the section.
        if indent == 0 {
            break;
        }
        let level = *key_indent.get_or_insert(indent);
        if indent > level {
            // A host's own sub-keys (token, api_host, …) — not hosts, but their
            // values can open a flow collection that wraps onto later lines.
            flow_depth = flow_open_depth(trimmed);
            continue;
        }
        if indent < level {
            break;
        }
        if let Some(host) = host_from_key_line(trimmed) {
            hosts.push(host);
        }
        flow_depth = flow_open_depth(trimmed);
    }
    hosts
}

/// The hosts of the first readable config in `paths`, plus `env_host` when set,
/// with the canonical non-GitLab hosts dropped. The env-free core of
/// [`known_hosts`]: every environment read lives in that wrapper, so this stays
/// testable without mutating process-global state.
async fn known_hosts_from(paths: &[PathBuf], env_host: Option<&str>) -> Vec<String> {
    let mut hosts = Vec::new();
    for path in paths {
        if let Ok(text) = tokio::fs::read_to_string(path).await {
            hosts = hosts_from_config(&text);
            break;
        }
    }
    if let Some(host) = env_host.and_then(normalize_host) {
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts.retain(|h| h != "github.com" && h != "bitbucket.org");
    hosts
}

/// The GitLab hosts glab is configured for: the `hosts:` keys of the first
/// readable config.yml, plus `GITLAB_HOST` when set. Canonical non-GitLab hosts
/// are never claimed, whatever the config says. Missing/unreadable config →
/// just the env var (or empty), so the GitHub default stays authoritative.
pub async fn known_hosts() -> Vec<String> {
    let env_host = std::env::var("GITLAB_HOST").ok();
    known_hosts_from(&glab_config_paths(), env_host.as_deref()).await
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
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GLAB_PAGER", "")
        .env("PAGER", "")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GLAB_CHECK_UPDATE", "false"); // see run_glab_raw for the polarity
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
    // The write runs INSIDE the timeout: a stalled stdin write is unbounded, so
    // outside it a stall hangs the caller forever instead of failing at the
    // deadline. It still precedes the drain rather than running concurrently the
    // way the git runner has to — one API body in, one small JSON document back —
    // and the timeout now bounds the exchange whatever a caller sends.
    let exchange = async move {
        if let Some(body) = input {
            // Dropping the handle after the write closes the pipe so glab reads EOF.
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(body.as_bytes())
                    .await
                    .map_err(AppError::Io)?;
                stdin.shutdown().await.ok();
            }
        }
        child.wait_with_output().await.map_err(AppError::Io)
    };
    let output = tokio::time::timeout(timeout, exchange)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))??;
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
    use super::{hosts_from_config, known_hosts_from, normalize_host};

    /// Table driver: `(label, config, expected hosts)`.
    fn check(cases: &[(&str, &str, &[&str])]) {
        for (label, config, expected) in cases {
            assert_eq!(hosts_from_config(config), *expected, "case: {label}");
        }
    }

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

    #[test]
    fn structural_forms_keep_scanning() {
        // The forms that already worked: they must survive the key-grammar
        // widening, which is otherwise free to swallow non-host lines.
        check(&[
            (
                "plain key",
                "hosts:\n  gitlab.example.com:\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "port in the key — split at the first colon, then normalized away",
                "hosts:\n  gitlab.example.com:443:\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "scheme on the key",
                "hosts:\n  https://gitlab.example.com:\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "scheme and port on the key",
                "hosts:\n  https://gitlab.example.com:8443:\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "a URL in the value must not be mistaken for the key's scheme",
                "hosts:\n  gitlab.example.com: # see https://docs.example.com\n",
                &["gitlab.example.com"],
            ),
            (
                "CRLF line endings",
                "hosts:\r\n  gitlab.example.com:\r\n    token: secret\r\n",
                &["gitlab.example.com"],
            ),
            (
                "document marker ahead of the section",
                "---\nhosts:\n  gitlab.example.com:\n",
                &["gitlab.example.com"],
            ),
            (
                "trailing whitespace on the header",
                "hosts:  \n  gitlab.example.com:\n",
                &["gitlab.example.com"],
            ),
            ("empty section", "hosts:\ncheck_update: true\n", &[]),
            (
                "the YAML merge key is a directive, not a host",
                "hosts:\n  <<: *defaults\n  gitlab.example.com:\n",
                &["gitlab.example.com"],
            ),
            (
                "a wrapped flow map's continuation lines are values, not keys",
                "hosts:\n  gitlab.example.com: {token: secret,\n  api_host: https://gitlab.example.com}\n",
                &["gitlab.example.com"],
            ),
            (
                "a sub-key's flow value wrapping onto later lines",
                "hosts:\n  gitlab.example.com:\n    custom_headers: {a: [1,\n  b: 2]}\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a scheme'd key opening a wrapped flow map",
                "hosts:\n  https://gitlab.example.com: {token: secret,\n  api_host: x}\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a bracket in a plain scalar is not a flow collection",
                "hosts:\n  gitlab.example.com:\n    token: abc[def\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a brace in a comment trailing a flow map must not wedge it open",
                "hosts:\n  gitlab.example.com: {token: secret} # a { brace\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a brace in a comment is not a flow collection either",
                "hosts:\n  gitlab.example.com: # a { brace\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a mis-indented value fragment is not a key",
                "hosts:\n  gitlab.example.com: >\n  a folded, continued: line\n",
                &["gitlab.example.com"],
            ),
            (
                "a host's own sub-keys",
                "hosts:\n  gitlab.example.com:\n    api_host: nested.example.com\n",
                &["gitlab.example.com"],
            ),
            (
                "a dedent past host level ends the section",
                "hosts:\n    gitlab.example.com:\n  stray.example.com:\n",
                &["gitlab.example.com"],
            ),
            (
                "a top-level key ends the section",
                "hosts:\n  gitlab.example.com:\ncheck_update: true\nstray.example.com:\n",
                &["gitlab.example.com"],
            ),
        ]);
    }

    #[test]
    fn reads_decorated_host_keys() {
        // glab's writer emits a bare `<host>:`, but a hand-edited config can
        // decorate the key or hang any value off it — dropping those hosts
        // disables GitLab detection silently.
        check(&[
            (
                "anchor",
                "hosts:\n  gitlab.example.com: &defaults\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "alias",
                "hosts:\n  gitlab.example.com: *defaults\n",
                &["gitlab.example.com"],
            ),
            (
                "trailing comment",
                "hosts:\n  gitlab.example.com: # work instance\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "flow map",
                "hosts:\n  gitlab.example.com: {token: secret}\n",
                &["gitlab.example.com"],
            ),
            (
                "quoted keys",
                "hosts:\n  \"gitlab.example.com\":\n  'other.example.com':\n",
                &["gitlab.example.com", "other.example.com"],
            ),
            (
                "a port inside the quotes — the colon is the key's, not a separator",
                "hosts:\n  \"gitlab.example.com:8443\":\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "a scheme inside the quotes",
                "hosts:\n  \"https://gitlab.example.com\":\n    token: secret\n",
                &["gitlab.example.com"],
            ),
            (
                "single quotes carry a port too",
                "hosts:\n  'gitlab.example.com:443':\n",
                &["gitlab.example.com"],
            ),
            (
                "an unbalanced quote has no readable key — skip the line",
                "hosts:\n  \"gitlab.example.com:\n  other.example.com:\n",
                &["other.example.com"],
            ),
            (
                "a quoted key opening a wrapped flow map",
                "hosts:\n  \"gitlab.example.com:8443\": {token: secret,\n  api_host: x}\n  other.example.com:\n",
                &["gitlab.example.com", "other.example.com"],
            ),
        ]);
    }

    #[test]
    fn reads_a_commented_hosts_header() {
        check(&[(
            "a comment on the header must not hide the whole section",
            "hosts: # my instances\n  gitlab.example.com:\n    token: secret\n",
            &["gitlab.example.com"],
        )]);
    }

    #[test]
    fn lookalike_headers_open_nothing() {
        check(&[
            ("a longer key", "hosts2:\n  stray.example.com:\n", &[]),
            (
                "a value, not a section",
                "hosts: mine\n  stray.example.com:\n",
                &[],
            ),
            (
                "`#` without leading whitespace is a scalar, not a comment",
                "hosts:#mine\n  stray.example.com:\n",
                &[],
            ),
            (
                "flow-form mapping",
                "hosts: {}\n  stray.example.com:\n",
                &[],
            ),
            (
                "not at top level",
                "  hosts:\n    stray.example.com:\n",
                &[],
            ),
        ]);
    }

    /// A config.yml in a throwaway dir, returned as the candidate-path list
    /// `known_hosts_from` takes — the seam that keeps this off process env.
    fn fixture_paths(body: &str) -> (tempfile::TempDir, Vec<std::path::PathBuf>) {
        let dir = tempfile::Builder::new()
            .prefix("gd-glab-cfg")
            .tempdir()
            .expect("tempdir");
        let path = dir.path().join("config.yml");
        std::fs::write(&path, body).expect("write config");
        (dir, vec![path])
    }

    #[tokio::test]
    async fn known_hosts_never_claims_github_or_bitbucket() {
        let (_dir, paths) =
            fixture_paths("hosts:\n  github.com:\n  bitbucket.org:\n  gitlab.example.com:\n");
        assert_eq!(
            known_hosts_from(&paths, None).await,
            vec!["gitlab.example.com"]
        );
        // GITLAB_HOST joins the list but is filtered by the same rule.
        assert_eq!(
            known_hosts_from(&paths, Some("https://GitLab.Other.dev:8443")).await,
            vec!["gitlab.example.com", "gitlab.other.dev"]
        );
        assert_eq!(
            known_hosts_from(&paths, Some("github.com")).await,
            vec!["gitlab.example.com"]
        );
    }

    #[tokio::test]
    async fn known_hosts_falls_back_past_unreadable_candidates() {
        let (_dir, paths) = fixture_paths("hosts:\n  gitlab.example.com:\n");
        let mut candidates = vec![std::path::PathBuf::from("no-such-dir/config.yml")];
        candidates.extend(paths);
        assert_eq!(
            known_hosts_from(&candidates, None).await,
            vec!["gitlab.example.com"]
        );
        // No readable config at all → just the env host, so GitHub stays default.
        assert!(known_hosts_from(&[], None).await.is_empty());
    }
}
