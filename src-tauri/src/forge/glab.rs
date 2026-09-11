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
    run_glab_raw_scoped(repo_path, args, &[], timeout).await
}

/// [`run_glab_raw`] with `strip_env` removed from the child's environment. The
/// one seam that can keep an inherited variable off a glab child, used by
/// [`run_glab_api_for_host`] to scope environment tokens to their own instance.
async fn run_glab_raw_scoped(
    repo_path: Option<&str>,
    args: &[&str],
    strip_env: &[&str],
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
    for var in strip_env {
        cmd.env_remove(var);
    }
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
/// Ports are stripped to match what `remote_host` yields for remote URLs — a
/// bracketed IPv6 literal keeps its brackets for the same reason, and shares
/// `remote_host`'s span parser so the two spellings can compare equal. A malformed
/// bracket falls through to the plain split: the key then simply never matches.
fn normalize_host(value: &str) -> Option<String> {
    let rest = value.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, after)| after);
    if let Some((span, _)) = crate::forge::bracketed_split(rest) {
        return Some(span.to_ascii_lowercase());
    }
    let host = rest.split(['/', ':']).next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// [`normalize_host`] with the PORT KEPT: a lowercase `host[:port]` with the scheme
/// and path removed (`https://GitLab.example:8443/x` → `gitlab.example:8443`).
///
/// The account layer identifies an instance by its authority, not by its host: a
/// token issued for `gitlab.example:8443` is not a credential for `gitlab.example`,
/// and resolving the two to one string would send it to an authority the user never
/// configured. Detection keeps using the port-blind [`normalize_host`], which is
/// what it wants — a `:8443` remote must still match a port-stripped saved key.
fn normalize_authority(value: &str) -> Option<String> {
    let rest = value.trim();
    let rest = rest.split_once("://").map_or(rest, |(_, after)| after);
    // A bracketed IPv6 literal carries its own `:`s, so its span resolves first and
    // the port slot is whatever follows it, up to the path.
    let authority = match crate::forge::bracketed_split(rest) {
        Some((span, after)) => {
            let port = after.split('/').next().unwrap_or("");
            format!("{span}{port}")
        }
        None => rest.split('/').next().unwrap_or("").to_string(),
    };
    (!authority.is_empty()).then(|| authority.to_ascii_lowercase())
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
    hosts.retain(|h| is_gitlab_eligible_host(h));
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

// ── Account-scoped host enumeration (My work) ────────────────────────────────
//
// Detection asks "which host is THIS repo on" and answers from `known_hosts`.
// The account-scoped surfaces ask "which hosts should I fetch the signed-in
// user's work from", and a token in the environment authenticates glab with NO
// saved host at all — so they need their own enumeration, below.

/// The token variables glab authenticates from, per `glab auth login --help`:
/// they "take precedence over the stored credentials". `CI_JOB_TOKEN` is
/// deliberately absent — glab honors it only under CI auto-login, a runner mode
/// a desktop app is never in, and treating it as a credential here would light
/// the source up for a shell that merely inherited one.
const GLAB_TOKEN_VARS: &[&str] = &["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

/// The host glab targets when nothing else names one.
const GLAB_DEFAULT_HOST: &str = "gitlab.com";

/// Whether a host may be claimed as GitLab at all. The canonical hosts of the
/// other two providers never are, whatever a config key or env var says — shared
/// by [`known_hosts_from`]'s filter and the token-target append so the two can't
/// drift into disagreeing about what counts as a GitLab host.
fn is_gitlab_eligible_host(host: &str) -> bool {
    host != "github.com" && host != "bitbucket.org"
}

/// Whether an account-scoped glab call can actually address `host`: a bare
/// authority this repo is willing to put in argv. A port disqualifies it — glab
/// rejects `--hostname host:8443` outright ("Error parsing --hostname: invalid
/// hostname", measured on 1.105) — as does a leading `-`, which glab would read as
/// a flag, and anything outside [`crate::forge::is_safe_authority`]'s charset. THE
/// addressability rule for this surface: `gitlab::my_work_hostname` gates its argv
/// on it and [`addressable_token_target`] gates the token on it, so a host the
/// fan-out cannot reach can never be one the token is kept for.
pub(crate) fn is_addressable_host(host: &str) -> bool {
    if !crate::forge::is_safe_authority(host) || host.starts_with('-') {
        return false;
    }
    // Bare authority only. A bracketed IPv6 literal carries its own `:`s, so the
    // port slot is whatever follows the span; everything else has a port iff it has
    // a colon at all (the charset gate already rejected any other use of one).
    match crate::forge::bracketed_split(host) {
        Some((_, after)) => after.is_empty(),
        None => !host.contains(':'),
    }
}

/// The instance an environment token authenticates against, in GLAB'S OWN routing
/// precedence: `GITLAB_HOST`, then the config file's top-level `host:`, then
/// gitlab.com. Both arms carry the PORT ([`normalize_authority`]) — the token
/// belongs to one authority, and a port-stripped spelling names a different one.
fn env_token_target<'a>(env_host: Option<&'a str>, config_default: Option<&'a str>) -> &'a str {
    env_host.or(config_default).unwrap_or(GLAB_DEFAULT_HOST)
}

/// The one host an environment token may be sent to, or `None` when there isn't
/// one. The single resolution [`account_hosts_from`] and [`token_vars_to_strip`]
/// both read, so the host the token is ENUMERATED for can never disagree with the
/// host it is SENT to.
///
/// `None` for a target this surface can't address — a PORTED `GITLAB_HOST` or
/// config `host:`, say. The instance is then simply not fetchable here, which is
/// the honest answer: resolving it to its port-stripped spelling would hand the
/// credential to a stand-in authority the user never configured. `None` likewise
/// for another provider's canonical host, which `known_hosts` already refuses to
/// claim.
fn addressable_token_target<'a>(
    env_host: Option<&'a str>,
    config_default: Option<&'a str>,
) -> Option<&'a str> {
    let target = env_token_target(env_host, config_default);
    (is_gitlab_eligible_host(target) && is_addressable_host(target)).then_some(target)
}

/// The token variables a call addressing `hostname` must NOT inherit: all of
/// [`GLAB_TOKEN_VARS`] for any host other than the token's own target, nothing
/// otherwise.
///
/// glab applies an environment token to whatever host `--hostname` names rather
/// than to the host the token resolves to (measured on 1.105: with a placeholder
/// `GITLAB_TOKEN` and `GITLAB_HOST` naming an unrelated instance,
/// `glab api --hostname gitlab.com user` still 401'd over a working saved
/// gitlab.com credential). So a fan-out that asks every account host would both
/// disclose the token to instances it isn't meant for and shadow their stored
/// credentials. Every host here is lowercased at its source
/// (`normalize_host`/[`normalize_authority`], and the constant), so a plain compare
/// matches [`account_hosts_from`]'s dedupe.
fn token_vars_to_strip(
    hostname: &str,
    env_host: Option<&str>,
    config_default: Option<&str>,
    env_token: Option<&str>,
) -> &'static [&'static str] {
    if env_token.is_none_or(|t| t.trim().is_empty()) {
        return &[];
    }
    if addressable_token_target(env_host, config_default) == Some(hostname) {
        return &[];
    }
    GLAB_TOKEN_VARS
}

/// A non-empty token from the environment, or `None`. Examined for EMPTINESS
/// only — the value never leaves this function.
fn env_token() -> Option<String> {
    GLAB_TOKEN_VARS
        .iter()
        .find_map(|var| std::env::var(var).ok().filter(|t| !t.trim().is_empty()))
}

/// A config VALUE, trimmed of a trailing comment and surrounding quotes. `None`
/// when nothing is left. Only ever applied to the top-level `host:` scalar, never
/// to anything inside the token-bearing `hosts:` section.
fn config_scalar(raw: &str) -> Option<&str> {
    let value = raw.trim();
    // A comment opens at `#` only after whitespace — or at the very start, which
    // means the key carries no value at all.
    let code = value
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 || value[..i].ends_with(char::is_whitespace)))
        .map_or(value, |(i, _)| &value[..i])
        .trim();
    let bytes = code.as_bytes();
    let unquoted = match (bytes.first(), bytes.last()) {
        (Some(b'"'), Some(b'"')) | (Some(b'\''), Some(b'\'')) if code.len() >= 2 => {
            &code[1..code.len() - 1]
        }
        _ => code,
    };
    (!unquoted.is_empty()).then_some(unquoted)
}

/// The default instance glab targets when nothing else names one: the TOP-LEVEL
/// `host:` key of its config. `None` when absent, unreadable, or not a safe
/// authority.
///
/// This is the same key a bare `glab` call resolves — measured on 1.105, a config
/// carrying `host: bogus-b.invalid` made `glab api user` (no cwd repo, no
/// `--hostname`) dial `https://bogus-b.invalid/api/v4/user` — so reading it here
/// makes the token-only enumeration match glab's OWN routing rather than assuming
/// gitlab.com.
///
/// Value-reading is confined to this one key: the `hosts:` section holds live
/// tokens and is never descended into. The result keeps its PORT
/// ([`normalize_authority`]: scheme and path stripped, lowercased) because it names
/// the instance a token belongs to; whether it is also ADDRESSABLE is
/// [`addressable_token_target`]'s call, so a ported default reports itself honestly
/// instead of collapsing onto a host the user never configured. Junk still yields
/// `None` here — [`crate::forge::is_safe_authority`] plus the leading-`-` rejection
/// the argv guard applies — so the caller falls back rather than building a request
/// around it.
fn default_host_from_config(text: &str) -> Option<String> {
    let mut flow_depth = 0usize;
    for line in text.lines() {
        let content = line.trim_end();
        let trimmed = content.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // A line continuing an open flow collection is value text whatever its
        // indent, so it can never be the top-level key.
        if flow_depth > 0 {
            flow_depth = flow_depth_after(flow_depth, trimmed);
            continue;
        }
        // Only column 0 carries the default; `hosts:` entries are indented.
        if content.len() != trimmed.len() {
            continue;
        }
        flow_depth = flow_open_depth(trimmed);
        let Some((key, value)) = split_key_value(trimmed) else {
            continue;
        };
        // `hosts` starts with `host`, so the key must match exactly.
        if key.trim() != "host" {
            continue;
        }
        let host = config_scalar(value).and_then(normalize_authority)?;
        return (crate::forge::is_safe_authority(&host) && !host.starts_with('-')).then_some(host);
    }
    None
}

/// The hosts an ACCOUNT-scoped surface should ask, given glab's saved hosts, the
/// config's default host, and whichever token variable the environment supplies.
/// The env-free core, so every arm is testable without mutating process-global
/// state.
///
/// A token's instance JOINS the saved hosts rather than replacing them: a user
/// signed in to a self-managed instance who also exports a token for the cloud
/// has work on BOTH, and enumerating only the saved list hides one of them
/// silently. Saved hosts keep their order and come first, so the fold's
/// "last error" stays deterministic; the default is appended once, never
/// duplicating a host already saved. `GITLAB_HOST` continues to arrive through
/// [`known_hosts`], so it lands in the saved half as before.
///
/// The token's target resolves in GLAB'S OWN routing precedence — `GITLAB_HOST`,
/// then the config file's `host:` key, then gitlab.com — because the token is
/// sent to wherever a bare glab call would go, and guessing a different host
/// would mail the user's credential to an instance they never configured
/// (measured on 1.105: a config naming `host: bogus-file.invalid` routes there,
/// and adding `GITLAB_HOST=bogus-env.invalid` re-routes to the env host, so env
/// beats file). `GITLAB_HOST` also joins [`known_hosts`], so when it is set the
/// target is already saved and the append is a no-op — no third host is contacted.
///
/// gitlab.com is the last resort, and the safe direction for an unreadable config:
/// a junk `host:` must not disable a source the user holds a working token for.
/// Measured: with an empty config dir and any one of the three variables set,
/// `glab api user --hostname gitlab.com` reaches gitlab.com and 401s on a
/// placeholder token, where the same call with none set refuses before any
/// request. A target that this surface cannot address — another provider's
/// canonical host, or a PORTED authority glab's `--hostname` refuses — is never
/// appended ([`addressable_token_target`]): the instance is unreachable here, and
/// substituting a spelling we CAN address would send the token somewhere else.
///
/// THE COST, so the trade is legible: the appended target is the ONLY host the
/// environment token reaches — [`token_vars_to_strip`] removes those variables
/// from every other host's call, so each saved host still authenticates from its
/// own stored credential. When the token fails against its own target, that one
/// host 401s, which the column isolates and reports through `truncated` — a quiet
/// partial rather than a lost column, and strictly better than never asking.
pub(crate) fn account_hosts_from(
    known: Vec<String>,
    env_host: Option<&str>,
    config_default: Option<&str>,
    env_token: Option<&str>,
) -> Vec<String> {
    let mut hosts = known;
    if env_token.is_some_and(|t| !t.trim().is_empty()) {
        // The append set and the keep-the-token set are the SAME resolution, so a
        // host can never be fetched with a credential it wasn't enumerated for.
        // Every host here is lowercased at its source (`normalize_host` /
        // `normalize_authority`, and the constant), so a plain compare dedupes.
        if let Some(target) = addressable_token_target(env_host, config_default) {
            if !hosts.iter().any(|h| h == target) {
                hosts.push(target.to_string());
            }
        }
    }
    hosts
}

/// The text of the first readable glab config, mirroring [`known_hosts_from`]'s
/// first-readable candidate walk.
async fn read_config_text(paths: &[PathBuf]) -> Option<String> {
    for path in paths {
        if let Ok(text) = tokio::fs::read_to_string(path).await {
            return Some(text);
        }
    }
    None
}

/// The hosts the "My work" inbox fetches from — the ONE enumeration its
/// availability probe and its fetch both read, so the two can never disagree
/// about whether GitLab has anything to offer.
///
/// Unlike [`known_hosts`] this keeps the PORT on `GITLAB_HOST` and admits it only
/// when addressable, so a ported env host is left out entirely rather than joining
/// as its port-stripped stand-in. RESIDUAL: a ported `hosts:` KEY still arrives
/// port-stripped from the config (`hosts_from_config`, which detection needs that
/// way), so the fan-out may query a host the user only has a ported login for. It
/// goes out with no environment token — glab's own store has no entry for that
/// spelling — so it 401s in isolation and lands in `truncated`.
pub async fn account_hosts() -> Vec<String> {
    let token = env_token();
    // `GITLAB_HOST` outranks the config file for the token's target, and it keeps
    // its port: the token belongs to one authority, not to its host half.
    let env_host = std::env::var("GITLAB_HOST")
        .ok()
        .and_then(|h| normalize_authority(&h));
    // `known_hosts` is bypassed for the env half only — it port-strips, which is
    // right for detection and wrong here. Feeding it the addressable spelling (or
    // nothing) leaves detection's view untouched while keeping the phantom out.
    let env_known = env_host.as_deref().filter(|h| is_addressable_host(h));
    let known = known_hosts_from(&glab_config_paths(), env_known).await;
    // The file default is only consulted when a token exists AND no env host
    // outranks it, so an ordinary session never pays for the read.
    let config_default = if token.is_some() && env_host.is_none() {
        read_config_text(&glab_config_paths())
            .await
            .and_then(|text| default_host_from_config(&text))
    } else {
        None
    };
    account_hosts_from(
        known,
        env_host.as_deref(),
        config_default.as_deref(),
        token.as_deref(),
    )
}

/// [`token_vars_to_strip`] against the live environment: which variables a call
/// addressing `hostname` must not inherit. The config read is skipped whenever the
/// decision is already settled without it — no token, or a `GITLAB_HOST` that
/// outranks the file — so an ordinary session never pays for it.
///
/// A token session with no `GITLAB_HOST` does pay it PER CALL (six small local
/// reads per host per fetch). Deliberate: resolving once per fan-out would have to
/// thread the target through every leg, and a target passed in is one a caller can
/// get wrong — deriving it here is what makes the argv and the scrub decision
/// provably the same resolution, and the read sits behind a process spawn and a
/// network round trip either way.
async fn token_vars_to_strip_for(hostname: &str) -> &'static [&'static str] {
    let Some(token) = env_token() else {
        return &[];
    };
    // Normalized exactly as `account_hosts` normalizes it — port and all — so the
    // two agree on which authority the token's target is.
    let env_host = std::env::var("GITLAB_HOST")
        .ok()
        .and_then(|h| normalize_authority(&h));
    let config_default = if env_host.is_none() {
        read_config_text(&glab_config_paths())
            .await
            .and_then(|text| default_host_from_config(&text))
    } else {
        None
    };
    token_vars_to_strip(
        hostname,
        env_host.as_deref(),
        config_default.as_deref(),
        Some(&token),
    )
}

/// Runs a HOST-ADDRESSED `glab api` call — the runner every account-scoped fan-out
/// leg goes through. It builds the `--hostname` flag itself so the host the argv
/// addresses and the host the token decision is made for cannot drift apart, and
/// drops the environment's token variables for any host that isn't the token's own
/// target ([`token_vars_to_strip`]). `args` carries the endpoint and any further
/// flags; there is no repo cwd, so glab routes on `--hostname` alone.
pub async fn run_glab_api_for_host(
    hostname: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GlabOutput> {
    let mut argv: Vec<&str> = vec!["api", "--hostname", hostname];
    argv.extend_from_slice(args);
    let strip = token_vars_to_strip_for(hostname).await;
    require_success(run_glab_raw_scoped(None, &argv, strip, timeout).await?)
}

/// A non-zero exit turned into an error carrying glab's stderr.
fn require_success(out: GlabOutput) -> AppResult<GlabOutput> {
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

/// Runs glab, treating any non-zero exit as an error carrying glab's stderr
/// (mirrors `run_gh`). For read ops where a failure should surface, not be empty.
pub async fn run_glab(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GlabOutput> {
    require_success(run_glab_raw(repo_path, args, timeout).await?)
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
mod account_hosts_tests {
    use super::{
        account_hosts_from, default_host_from_config, normalize_authority, token_vars_to_strip,
        GLAB_TOKEN_VARS,
    };

    fn saved(hosts: &[&str]) -> Vec<String> {
        hosts.iter().map(|h| h.to_string()).collect()
    }

    /// One precedence-table row: label, `GITLAB_HOST`, the config default, and the
    /// host the enumeration is expected to append (`None` = nothing appended).
    type TargetCase = (
        &'static str,
        Option<&'static str>,
        Option<&'static str>,
        Option<&'static str>,
    );

    /// The regression this closes: glab authenticates from a token variable with
    /// NO saved host, so a saved-hosts-only enumeration hides every GitLab row.
    /// The probe and the fetch share this function, so both learn about it at
    /// once — a boolean that disagreed with the enumeration would offer a source
    /// that then answered empty.
    #[test]
    fn a_token_with_no_saved_host_enumerates_the_default_host() {
        // Config names a default → that instance, matching glab's own routing.
        assert_eq!(
            account_hosts_from(Vec::new(), None, Some("gitlab.acme.dev"), Some("t")),
            vec!["gitlab.acme.dev".to_string()],
        );
        // No default to read → glab's ultimate default.
        assert_eq!(
            account_hosts_from(Vec::new(), None, None, Some("t")),
            vec!["gitlab.com".to_string()],
        );
    }

    /// `GITLAB_HOST` names where a bare glab call routes, so it is where the
    /// token goes — it outranks the config file, matching glab's own precedence.
    ///
    /// Without this the append lands on gitlab.com and the inherited company
    /// token is mailed to an instance the user never named; the cloud 401 would
    /// then mark an otherwise-complete inbox truncated. Because `GITLAB_HOST`
    /// already joins `known_hosts`, the correct target is ALREADY saved and the
    /// append is a no-op — no third host is contacted at all.
    #[test]
    fn gitlab_host_is_the_token_target_and_outranks_the_config_default() {
        let env_saved = saved(&["gitlab.company.example"]);

        let hosts = account_hosts_from(
            env_saved.clone(),
            Some("gitlab.company.example"),
            None,
            Some("t"),
        );
        assert_eq!(
            hosts, env_saved,
            "the env host is already saved — no append"
        );
        assert!(
            !hosts.iter().any(|h| h == "gitlab.com"),
            "the company token must never be sent to the cloud",
        );

        let hosts = account_hosts_from(
            env_saved.clone(),
            Some("gitlab.company.example"),
            Some("gitlab.file.example"),
            Some("t"),
        );
        assert_eq!(
            hosts, env_saved,
            "env host outranks the config-file default"
        );
        assert!(
            !hosts.iter().any(|h| h == "gitlab.file.example"),
            "the outranked file default must not be appended",
        );
    }

    /// A target that is another provider's canonical host is never appended —
    /// `known_hosts` already refuses to claim those, and re-introducing one here
    /// would send the token to it.
    #[test]
    fn a_non_gitlab_target_is_never_appended() {
        for canonical in ["github.com", "bitbucket.org"] {
            assert!(
                account_hosts_from(Vec::new(), Some(canonical), None, Some("t")).is_empty(),
                "{canonical} must not be enumerated as GitLab",
            );
            let one = saved(&["gitlab.acme.dev"]);
            assert_eq!(
                account_hosts_from(one.clone(), None, Some(canonical), Some("t")),
                one,
                "{canonical} as a config default must not be appended either",
            );
        }
    }

    /// Without a token the saved list is returned untouched — the no-token
    /// session must be bit-identical to what it always was.
    #[test]
    fn saved_hosts_alone_are_returned_unchanged() {
        let one = saved(&["gitlab.acme.dev"]);
        assert_eq!(account_hosts_from(one.clone(), None, None, None), one);
        assert_eq!(
            account_hosts_from(one.clone(), None, Some("gitlab.com"), None),
            one,
            "a config default is inert without a token to use it",
        );
        assert_eq!(
            account_hosts_from(one.clone(), Some("gitlab.env.example"), None, None),
            one,
            "an env host is inert without a token to use it",
        );

        let many = saved(&["gitlab.acme.dev", "gitlab.other.dev"]);
        assert_eq!(account_hosts_from(many.clone(), None, None, None), many);
    }

    /// The cell this closes: signed in to a self-managed instance AND holding a
    /// token for another. Enumerating only the saved list hides the token's work
    /// entirely — so the token's instance JOINS the list rather than being
    /// skipped, saved hosts first so the fold's last-error stays deterministic.
    #[test]
    fn a_token_appends_its_instance_to_the_saved_hosts() {
        assert_eq!(
            account_hosts_from(saved(&["gitlab.acme.dev"]), None, None, Some("t")),
            saved(&["gitlab.acme.dev", "gitlab.com"]),
            "saved host kept and ordered first, token's default appended",
        );
        assert_eq!(
            account_hosts_from(
                saved(&["gitlab.acme.dev", "gitlab.other.dev"]),
                None,
                Some("gitlab.third.dev"),
                Some("t"),
            ),
            saved(&["gitlab.acme.dev", "gitlab.other.dev", "gitlab.third.dev"]),
            "the config default is what gets appended when one is readable",
        );
    }

    /// Appended ONCE: a saved list that already names the token's instance must
    /// not fetch it twice (the merge would dedupe the items, but the second fetch
    /// is wasted and doubles that host's failure weight in the fold).
    #[test]
    fn the_default_is_never_duplicated_into_the_saved_hosts() {
        let with_default = saved(&["gitlab.com", "gitlab.acme.dev"]);
        assert_eq!(
            account_hosts_from(with_default.clone(), None, None, Some("t")),
            with_default,
        );

        let with_config_default = saved(&["gitlab.acme.dev", "gitlab.other.dev"]);
        assert_eq!(
            account_hosts_from(
                with_config_default.clone(),
                None,
                Some("gitlab.other.dev"),
                Some("t"),
            ),
            with_config_default,
            "already-saved config default appends nothing",
        );
    }

    /// Neither source configured, and the blank-token boundary: an empty or
    /// whitespace-only variable is not a credential, so it must not conjure a
    /// host to fetch from — not even when the config names a default.
    #[test]
    fn neither_source_enumerates_nothing() {
        assert!(account_hosts_from(Vec::new(), None, None, None).is_empty());
        assert!(account_hosts_from(Vec::new(), None, Some("gitlab.acme.dev"), None).is_empty());
        for blank in ["", " ", "\t", "\n", "   \t "] {
            assert!(
                account_hosts_from(Vec::new(), None, None, Some(blank)).is_empty(),
                "{blank:?} is not a token",
            );
            assert!(
                account_hosts_from(Vec::new(), None, Some("gitlab.acme.dev"), Some(blank))
                    .is_empty(),
                "{blank:?} must not activate the config default either",
            );
            assert!(
                account_hosts_from(Vec::new(), Some("gitlab.env.example"), None, Some(blank))
                    .is_empty(),
                "{blank:?} must not activate the env host either",
            );
            // …and must not append anything to a saved list either.
            let one = saved(&["gitlab.acme.dev"]);
            assert_eq!(
                account_hosts_from(one.clone(), None, None, Some(blank)),
                one,
                "{blank:?} must not append the default to saved hosts",
            );
        }
    }

    /// The top-level `host:` scalar — the same key a bare glab call resolves.
    /// Never the `hosts:` section, which holds tokens.
    #[test]
    fn reads_the_top_level_default_host() {
        let cases: &[(&str, &str, Option<&str>)] = &[
            (
                "the real config shape",
                "git_protocol: ssh\nhost: gitlab.acme.dev\nhosts:\n    gitlab.acme.dev:\n        token: secret\n",
                Some("gitlab.acme.dev"),
            ),
            ("absent", "git_protocol: ssh\ncheck_update: true\n", None),
            (
                "`hosts:` must not satisfy the `host` key",
                "hosts:\n    gitlab.acme.dev:\n        token: secret\n",
                None,
            ),
            (
                "a nested `host:` is a host's own sub-key, not the default",
                "hosts:\n    gitlab.acme.dev:\n        host: nested.example.com\n",
                None,
            ),
            (
                "scheme and path normalize away, the PORT stays — it names the instance",
                "host: https://GitLab.Acme.dev:8443/gitlab\n",
                Some("gitlab.acme.dev:8443"),
            ),
            ("quoted", "host: \"gitlab.acme.dev\"\n", Some("gitlab.acme.dev")),
            (
                "trailing comment",
                "host: gitlab.acme.dev # work\n",
                Some("gitlab.acme.dev"),
            ),
            ("no value at all", "host:\n", None),
            ("value is only a comment", "host: # nothing\n", None),
            (
                "a wrapped flow map's continuation is a value, not the key",
                "custom: {a: 1,\nhost: evil.example.com}\n",
                None,
            ),
            ("CRLF", "host: gitlab.acme.dev\r\n", Some("gitlab.acme.dev")),
            // Unaddressable values yield None so the caller falls back to
            // gitlab.com rather than building a request around junk.
            ("a leading dash would be read as a flag", "host: -evil\n", None),
            ("config syntax", "host: evil.dev;rm -rf /\n", None),
        ];
        for (label, text, expected) in cases {
            assert_eq!(
                default_host_from_config(text).as_deref(),
                *expected,
                "case: {label}",
            );
        }
    }

    /// The disclosure this closes: glab applies an environment token to whatever
    /// host `--hostname` names, so a fan-out over every account host would mail one
    /// instance's credential to all the others AND shadow their stored logins
    /// (those hosts 401 and their work vanishes into `truncated`). Only the token's
    /// own target keeps the variables.
    #[test]
    fn only_the_token_target_keeps_the_environment_token() {
        // `GITLAB_HOST` names the target: the corporate instance keeps it, the
        // user's saved cloud login is not shadowed by it.
        let env = Some("gitlab.corp.example");
        assert!(token_vars_to_strip("gitlab.corp.example", env, None, Some("t")).is_empty());
        assert_eq!(
            token_vars_to_strip("gitlab.com", env, None, Some("t")),
            GLAB_TOKEN_VARS,
        );
        // Config default is the target when no env host outranks it.
        let cfg = Some("gitlab.file.example");
        assert!(token_vars_to_strip("gitlab.file.example", None, cfg, Some("t")).is_empty());
        assert_eq!(
            token_vars_to_strip("gitlab.acme.dev", None, cfg, Some("t")),
            GLAB_TOKEN_VARS,
        );
        // Neither source: the target is glab's ultimate default, and the
        // token-only session's single call must keep authenticating.
        assert!(token_vars_to_strip("gitlab.com", None, None, Some("t")).is_empty());
        assert_eq!(
            token_vars_to_strip("gitlab.acme.dev", None, None, Some("t")),
            GLAB_TOKEN_VARS,
        );
        // The env host outranks the file for the scrub exactly as it does for the
        // enumeration — otherwise the leg that keeps the token is the wrong one.
        assert!(token_vars_to_strip("gitlab.corp.example", env, cfg, Some("t")).is_empty());
        assert_eq!(
            token_vars_to_strip("gitlab.file.example", env, cfg, Some("t")),
            GLAB_TOKEN_VARS,
        );
    }

    /// No token in the environment means nothing to scope: the no-token session
    /// must spawn a bit-identical child to the one it always did. A blank variable
    /// is not a credential, matching the enumeration's own boundary.
    #[test]
    fn without_a_token_nothing_is_stripped() {
        assert!(token_vars_to_strip("gitlab.acme.dev", None, None, None).is_empty());
        assert!(
            token_vars_to_strip("gitlab.acme.dev", Some("gitlab.corp.example"), None, None)
                .is_empty()
        );
        for blank in ["", " ", "\t", "\n", "   \t "] {
            assert!(
                token_vars_to_strip("gitlab.acme.dev", None, None, Some(blank)).is_empty(),
                "{blank:?} is not a token",
            );
            assert!(
                token_vars_to_strip("gitlab.acme.dev", None, Some("gitlab.com"), Some(blank))
                    .is_empty(),
                "{blank:?} must not activate the config default either",
            );
        }
    }

    /// A stripped call drops EVERY variable glab authenticates from — leaving one
    /// behind would scope nothing, since glab reads whichever is set.
    #[test]
    fn a_stripped_call_drops_every_variable_glab_authenticates_from() {
        let stripped = token_vars_to_strip("gitlab.acme.dev", None, None, Some("t"));
        for var in ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] {
            assert!(
                stripped.contains(&var),
                "{var} must be removed from a foreign host's child",
            );
        }
        assert_eq!(
            stripped, GLAB_TOKEN_VARS,
            "the scrub list is the credential list, not a copy that can drift",
        );
    }

    /// The scrub and the enumeration must name the SAME target, or the fan-out
    /// strips the token from the one leg that needed it. Both read
    /// `addressable_token_target`, and this pins the agreement across the precedence
    /// table: the set of hosts the enumeration APPENDS equals the set that KEEPS the
    /// token, in every case including the ones that append nothing.
    ///
    /// Case spelling rides along: hosts are lowercased at every source, so an
    /// unlowercased host is a different host to BOTH functions, never a silent match
    /// in one and a miss in the other.
    #[test]
    fn the_scrub_target_agrees_with_the_enumerated_target() {
        let cases: &[TargetCase] = &[
            ("neither source", None, None, Some("gitlab.com")),
            (
                "config default",
                None,
                Some("gitlab.file.example"),
                Some("gitlab.file.example"),
            ),
            (
                "env host",
                Some("gitlab.env.example"),
                None,
                Some("gitlab.env.example"),
            ),
            (
                "env host outranks the file",
                Some("gitlab.env.example"),
                Some("gitlab.file.example"),
                Some("gitlab.env.example"),
            ),
            (
                "an unlowercased host is its own host",
                None,
                Some("GitLab.COM"),
                Some("GitLab.COM"),
            ),
            // Unaddressable targets append nothing, so nothing keeps the token.
            (
                "a ported env host",
                Some("gitlab.env.example:8443"),
                None,
                None,
            ),
            (
                "a ported config default",
                None,
                Some("gitlab.file.example:8443"),
                None,
            ),
            ("another provider's host", Some("github.com"), None, None),
        ];
        // Every spelling a leg could plausibly address, so "keeps the token" is
        // checked as a SET rather than only at the expected target.
        let probes = [
            "gitlab.acme.dev",
            "gitlab.com",
            "gitlab.env.example",
            "gitlab.env.example:8443",
            "gitlab.file.example",
            "gitlab.file.example:8443",
            "GitLab.COM",
            "github.com",
        ];
        for (label, env_host, config_default, target) in cases {
            let mut expected = saved(&["gitlab.acme.dev"]);
            expected.extend(target.map(str::to_string));
            assert_eq!(
                account_hosts_from(
                    saved(&["gitlab.acme.dev"]),
                    *env_host,
                    *config_default,
                    Some("t"),
                ),
                expected,
                "case: {label} — enumerated hosts",
            );
            for probe in probes {
                let keeps =
                    token_vars_to_strip(probe, *env_host, *config_default, Some("t")).is_empty();
                assert_eq!(
                    keeps,
                    *target == Some(probe),
                    "case: {label} — {probe} keeping the token must match its being enumerated",
                );
            }
        }
    }

    /// The redirect this closes: `normalize_host` strips ports, so a ported
    /// `GITLAB_HOST` or config `host:` used to resolve to a DIFFERENT authority —
    /// one the user never configured — which the enumeration then appended and the
    /// scrub then handed the token to. glab can't address a ported host at all, so
    /// the honest answer is that the instance is unreachable here: nothing is
    /// appended, and every leg runs without the token.
    #[test]
    fn a_ported_token_target_is_unaddressable_and_never_holds_the_token() {
        let saved_hosts = saved(&["gitlab.acme.dev", "gitlab.example"]);
        for (label, env_host, config_default) in [
            ("env host", Some("gitlab.example:8443"), None),
            ("config default", None, Some("gitlab.example:8443")),
        ] {
            assert_eq!(
                account_hosts_from(saved_hosts.clone(), env_host, config_default, Some("t")),
                saved_hosts,
                "case: {label} — a ported target must not be enumerated",
            );
            for probe in [
                "gitlab.example",
                "gitlab.example:8443",
                "gitlab.acme.dev",
                "gitlab.com",
            ] {
                assert_eq!(
                    token_vars_to_strip(probe, env_host, config_default, Some("t")),
                    GLAB_TOKEN_VARS,
                    "case: {label} — {probe} must not inherit a ported target's token",
                );
            }
        }
        // The regression guard: drop the port and the same inputs behave exactly as
        // they did — the instance is addressable, so it is enumerated and keeps the
        // token.
        assert_eq!(
            account_hosts_from(
                saved(&["gitlab.acme.dev"]),
                Some("gitlab.example"),
                None,
                Some("t"),
            ),
            saved(&["gitlab.acme.dev", "gitlab.example"]),
        );
        assert!(
            token_vars_to_strip("gitlab.example", Some("gitlab.example"), None, Some("t"))
                .is_empty()
        );
    }

    /// The account layer identifies an instance by its AUTHORITY: scheme and path
    /// go, case folds, the port stays. (`normalize_host`'s port-stripping is what
    /// detection wants and what this must not repeat.)
    #[test]
    fn the_account_normalizer_keeps_the_port() {
        let cases: &[(&str, Option<&str>)] = &[
            ("gitlab.com", Some("gitlab.com")),
            ("GitLab.Acme.dev", Some("gitlab.acme.dev")),
            (
                "https://GitLab.Acme.dev:8443/gitlab",
                Some("gitlab.acme.dev:8443"),
            ),
            ("https://gitlab.acme.dev/", Some("gitlab.acme.dev")),
            ("  gitlab.acme.dev:8443  ", Some("gitlab.acme.dev:8443")),
            // A bracketed IPv6 literal keeps its brackets AND its port; its own
            // colons must not be read as one.
            ("[2001:DB8::1]", Some("[2001:db8::1]")),
            ("https://[2001:db8::1]:8443/x", Some("[2001:db8::1]:8443")),
            ("", None),
            ("https://", None),
            ("/just/a/path", None),
        ];
        for (value, expected) in cases {
            assert_eq!(
                normalize_authority(value).as_deref(),
                *expected,
                "case: {value:?}",
            );
        }
    }
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
        // A bracketed IPv6 key keeps its brackets, so it can compare equal to what
        // `remote_host` yields; a port after `]` still drops.
        assert_eq!(
            normalize_host("[2001:DB8::1]"),
            Some("[2001:db8::1]".into())
        );
        assert_eq!(
            normalize_host("[2001:db8::1]:8443"),
            Some("[2001:db8::1]".into())
        );
        // A malformed bracket folds exactly as it does today — it just never matches.
        assert_eq!(normalize_host("[2001"), Some("[2001".into()));
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
