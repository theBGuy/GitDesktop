//! gh auth surface that doesn't need the network: the token's OAuth scopes (so
//! governance UI can prompt for a `gh auth refresh -s <scope>`), and a local read
//! of gh's own config for "is an account configured at all". Read-only and
//! tolerant — any failure reads as "no scopes" / "not configured" rather than
//! erroring.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::AppResult;
use crate::github::runner::{run_gh_raw, GH_TIMEOUT};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GhScopes {
    /// Granted classic OAuth scopes (e.g. ["repo", "read:org"]). Empty for a
    /// fine-grained PAT / GitHub App token, which carry none.
    pub scopes: Vec<String>,
    /// Whether this is a classic OAuth/PAT token whose scopes we can read. A
    /// fine-grained PAT / App token returns no `X-OAuth-Scopes` header → false,
    /// and the UI must NOT then treat "missing scope X" as a problem.
    pub classic: bool,
}

/// The active gh token's OAuth scopes, read from the `X-OAuth-Scopes` response
/// header of `gh api -i user` (the robust detection path — any authenticated
/// REST call returns the granted scopes in that header). `host` targets a
/// specific host (e.g. an Enterprise server) so the scopes match the repo the
/// governance UI is acting on, not gh's default host; None uses the default.
#[tauri::command]
pub async fn gh_token_scopes(host: Option<String>) -> AppResult<GhScopes> {
    let mut args = vec!["api", "-i", "user"];
    if let Some(h) = host.as_deref().filter(|h| !h.is_empty()) {
        args.push("--hostname");
        args.push(h);
    }
    let out = run_gh_raw(None, &args, GH_TIMEOUT).await?;
    if out.code != 0 {
        return Ok(GhScopes::default());
    }
    let body = out.stdout_lossy();
    // Response headers precede the JSON body and end at the first blank line.
    for line in body.lines() {
        if line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("x-oauth-scopes") {
                let scopes = value
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                return Ok(GhScopes {
                    scopes,
                    classic: true,
                });
            }
        }
    }
    // No X-OAuth-Scopes header → a fine-grained PAT / App token (no classic scopes).
    Ok(GhScopes::default())
}

// ── "Is an account configured?" from gh's own config ──────────────────────────
//
// The analogue of `forge::glab::known_hosts` for gh: a bounded local file read,
// no spawn and no network, so an availability probe can never wait on gh's
// token validation. `gh_accounts` remains the authoritative signed-in report for
// the surfaces that need identities.

/// gh's config directory, resolved exactly as gh resolves it (`gh help
/// environment`, gh 2.x): `GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh`, else
/// `$AppData/GitHub CLI` on Windows, else `$HOME/.config/gh`.
///
/// The first env var that is SET wins OUTRIGHT — gh never falls through to a
/// later directory when the chosen one is missing, so neither may we: falling
/// through would let us claim a host gh itself would ignore.
fn gh_config_dir() -> Option<PathBuf> {
    let env_dir = |var: &str| {
        std::env::var(var)
            .ok()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from)
    };
    if let Some(dir) = env_dir("GH_CONFIG_DIR") {
        return Some(dir);
    }
    if let Some(xdg) = env_dir("XDG_CONFIG_HOME") {
        return Some(xdg.join("gh"));
    }
    #[cfg(windows)]
    if let Some(app_data) = env_dir("APPDATA") {
        return Some(app_data.join("GitHub CLI"));
    }
    #[cfg(windows)]
    let home = env_dir("USERPROFILE");
    #[cfg(not(windows))]
    let home = env_dir("HOME");
    home.map(|h| h.join(".config").join("gh"))
}

/// The flow-collection nesting depth after `text`, counting bracket characters
/// only — no value is read. A trailing comment is dropped first so a `{` in prose
/// can't wedge it open. (Deliberately a local twin of the glab scanner's helper:
/// that module's is private and its config has a different shape, so coupling
/// the two would cost more than these lines.)
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

/// The key and value of a `key: value` line. A QUOTED key is unquoted before any
/// colon is looked for — a hostname in quotes may carry one (a port), where
/// splitting at the first colon would cut the key in half. An unbalanced quote
/// yields `None`: that line has no readable key.
fn split_host_key(trimmed: &str) -> Option<(&str, &str)> {
    if let Some(quote) = trimmed.chars().next().filter(|c| matches!(c, '\'' | '"')) {
        let rest = &trimmed[quote.len_utf8()..];
        let end = rest.find(quote)?;
        let after = rest[end + quote.len_utf8()..].trim_start();
        return Some((&rest[..end], after.strip_prefix(':')?));
    }
    trimmed.split_once(':')
}

/// The host keys of gh's `hosts.yml`. A minimal line scanner, not a YAML parser.
///
/// gh writes each host as a TOP-LEVEL key (unlike glab, which nests them under a
/// `hosts:` section), and every indented line below one is that host's own
/// config. The file holds live tokens, so only key NAMES at column 0 can leave
/// this function — no value is ever inspected. Tolerant on purpose: a dropped
/// host silently disables the GitHub source for that user.
fn gh_hosts_from_config(text: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut flow_depth = 0usize;
    for line in text.lines() {
        let content = line.trim_end();
        let trimmed = content.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // A line continuing an open flow collection is value text whatever its
        // indent, so it is never a key.
        if flow_depth > 0 {
            flow_depth = flow_depth_after(flow_depth, trimmed);
            continue;
        }
        // Only column 0 declares a host; anything indented is that host's config.
        if content.len() != trimmed.len() {
            continue;
        }
        // Stream markers open/close a document — they name no host.
        if trimmed == "---" || trimmed == "..." {
            continue;
        }
        let Some((key, value)) = split_host_key(trimmed) else {
            continue;
        };
        flow_depth = flow_depth_after(0, value);
        let host = key.trim();
        // A key carrying whitespace or a comma is no hostname — that is the one
        // shape a stray value fragment could otherwise arrive in.
        if host.is_empty() || host.contains(char::is_whitespace) || host.contains(',') {
            continue;
        }
        hosts.push(host.to_ascii_lowercase());
    }
    hosts
}

/// The environment variables gh authenticates from, in gh's documented
/// precedence order (`gh help environment`): `GH_TOKEN` then `GITHUB_TOKEN` for
/// any host, and `GH_ENTERPRISE_TOKEN` then `GITHUB_ENTERPRISE_TOKEN` when the
/// target is a GitHub Enterprise Server host. gh documents no others, and this
/// list covers exactly what it documents.
const GH_TOKEN_VARS: &[&str] = &[
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];

/// Whether gh is configured, given its `hosts.yml` text (when the file exists)
/// and whichever token variable the environment supplies.
///
/// EITHER source counts: an env token authenticates gh on its own and writes no
/// `hosts.yml` entry at all, so a config-only check would report a working inbox
/// as "no connected account". The token is examined for EMPTINESS only and never
/// leaves this function — the probe answers existence, nothing more.
///
/// The env-free core, so the arms are testable without mutating process-global
/// state (the seam `forge::glab::known_hosts_from` established).
fn gh_configured_from(hosts: Option<&str>, env_token: Option<&str>) -> bool {
    if env_token.is_some_and(|t| !t.trim().is_empty()) {
        return true;
    }
    hosts.is_some_and(|text| !gh_hosts_from_config(text).is_empty())
}

/// Whether gh has an account configured — a `hosts.yml` host entry, or a token in
/// the app's own environment.
///
/// Deliberately NOT `gh auth status`: that spawns gh and validates the token over
/// the network, so an availability probe would wait on it. Like the glab arm,
/// this proves a session EXISTS, not that it works — an expired credential still
/// reads as configured, and the resulting fetch surfaces a real error, which
/// beats silently hiding a source the user has signed in to.
pub(crate) async fn gh_has_configured_host() -> bool {
    // The app's environment is inherited by every gh child (`sanitize_child_env`
    // rewrites only PWD and the AppImage library paths), so a token here is a
    // token gh will use.
    let env_token = GH_TOKEN_VARS
        .iter()
        .find_map(|var| std::env::var(var).ok().filter(|t| !t.trim().is_empty()));
    let hosts = match gh_config_dir() {
        Some(dir) => tokio::fs::read_to_string(dir.join("hosts.yml")).await.ok(),
        None => None,
    };
    gh_configured_from(hosts.as_deref(), env_token.as_deref())
}

#[cfg(test)]
mod hosts_tests {
    use super::{gh_configured_from, gh_hosts_from_config};

    /// gh authenticates from a token variable WITHOUT writing any `hosts.yml`
    /// entry, so the config file alone can't answer "is GitHub configured". A
    /// config-only probe would hide a working inbox from an env-token session.
    #[test]
    fn an_env_token_counts_even_with_no_hosts_file() {
        // The regression this guards: no config at all, token in the environment.
        assert!(gh_configured_from(None, Some("t")));
        // …and the same with an empty or host-less config file present.
        assert!(gh_configured_from(Some(""), Some("t")));
        assert!(gh_configured_from(Some("# no hosts\n"), Some("t")));
    }

    /// The config arm still stands on its own, and neither source means false.
    #[test]
    fn config_alone_counts_and_neither_source_is_not_configured() {
        assert!(gh_configured_from(Some("github.com:\n    user: x\n"), None));

        // Both absent — the genuine "no connected account".
        assert!(!gh_configured_from(None, None));
        assert!(!gh_configured_from(Some(""), None));
        assert!(!gh_configured_from(Some("# only a comment\n"), None));

        // An empty or whitespace-only variable is NOT a credential: gh treats it
        // as unset, so it must not light the source up on its own.
        for blank in ["", " ", "\t", "\n", "   \t "] {
            assert!(
                !gh_configured_from(None, Some(blank)),
                "{blank:?} is not a token",
            );
            // …but it must not mask a real config entry either.
            assert!(gh_configured_from(
                Some("github.com:\n    user: x\n"),
                Some(blank)
            ));
        }
    }

    /// The shape gh actually writes (verified against a real `hosts.yml`: hosts
    /// at column 0, `user` / `git_protocol` / `users` nested beneath, tokens in
    /// the nested block or in the OS keyring). Enterprise hosts sit alongside.
    #[test]
    fn reads_top_level_host_keys_only() {
        let config = "\
github.com:
    user: octo-cat
    git_protocol: https
    users:
        octo-cat:
            oauth_token: not-a-real-token
ghe.example.com:
    user: someone
    oauth_token: also-not-real
";
        assert_eq!(
            gh_hosts_from_config(config),
            vec!["github.com".to_string(), "ghe.example.com".to_string()],
            "hosts are the column-0 keys; nested config lines are not hosts",
        );
        // Nothing nested may escape — `users`, the per-user key and the token key
        // all live below column 0.
        for leaked in ["users", "octo-cat", "oauth_token", "not-a-real-token"] {
            assert!(
                !gh_hosts_from_config(config).iter().any(|h| h == leaked),
                "{leaked} must never be reported as a host",
            );
        }
    }

    #[test]
    fn tolerates_the_hand_written_forms() {
        let cases: &[(&str, &str, &[&str])] = &[
            ("empty file", "", &[]),
            ("only comments", "# nothing here\n\n", &[]),
            ("an empty flow map", "{}\n", &[]),
            (
                "document markers",
                "---\ngithub.com:\n    user: x\n...\n",
                &["github.com"],
            ),
            (
                "quoted key",
                "\"github.com\":\n    user: x\n'ghe.example.com':\n",
                &["github.com", "ghe.example.com"],
            ),
            (
                "a port inside the quotes — the colon is the key's",
                "\"ghe.example.com:8443\":\n    user: x\n",
                &["ghe.example.com:8443"],
            ),
            (
                "case is normalized so the key compares like a host",
                "GitHub.COM:\n    user: x\n",
                &["github.com"],
            ),
            (
                "trailing comment on the key line",
                "github.com: # work account\n    user: x\n",
                &["github.com"],
            ),
            (
                "an inline flow map value",
                "github.com: {user: x}\nghe.example.com:\n",
                &["github.com", "ghe.example.com"],
            ),
            (
                "a wrapped flow map's continuation is a value, not a key",
                "github.com: {user: x,\ngit_protocol: https}\nghe.example.com:\n",
                &["github.com", "ghe.example.com"],
            ),
            (
                "CRLF line endings",
                "github.com:\r\n    user: x\r\n",
                &["github.com"],
            ),
            (
                "an unbalanced quote has no readable key",
                "\"github.com:\n    user: x\nghe.example.com:\n",
                &["ghe.example.com"],
            ),
        ];
        for (label, config, expected) in cases {
            assert_eq!(gh_hosts_from_config(config), *expected, "case: {label}");
        }
    }
}
