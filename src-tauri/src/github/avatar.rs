//! Resolving GitHub **bot** avatars, which the login-derived `<host>/<login>.png`
//! shortcut can't reach.
//!
//! The app derives GitHub user avatars from the login (`<host>/<login>.png`), but
//! that shortcut does not exist for bot accounts: `gh` returns bot logins as
//! `app/dependabot` (→ `github.com/app/dependabot.png` 404) and even the plain
//! `github.com/dependabot[bot].png` 404s. The real avatar is reachable only via
//! the API — `gh api users/dependabot%5Bbot%5D -q .avatar_url` →
//! `https://avatars.githubusercontent.com/in/29110?v=4` — a stable URL keyed by
//! the app's id, which isn't derivable from the login. This command resolves it
//! once per bot; the frontend caches the result and falls back to initials on any
//! failure (offline / no gh / unknown bot), so a decoration never surfaces an error.
//!
//! github.com only: `gh api users/…` targets github.com, so Enterprise bots stay
//! on the initials fallback.

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::github::runner::{run_gh, run_gh_raw, GH_NETWORK_TIMEOUT, GH_TIMEOUT};

/// The bare bot name for a bot login, or `None` if `login` isn't a valid bot
/// handle. Accepts three shapes gh emits or callers hold — `app/<name>`,
/// `<name>[bot]`, or a bare `<name>` — strips the `app/` prefix and any `[bot]`
/// suffix, and requires the remaining name to match GitHub's username grammar
/// `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`. That grammar check is the security gate:
/// the name goes into a process argument, so a leading `-` (flag injection), a
/// slash, or brackets must be rejected.
fn normalize_bot_login(login: &str) -> Option<String> {
    let trimmed = login.trim();
    // Strip the `app/` owner prefix gh emits for bot logins, then the `[bot]`
    // suffix if present. Either shape (or a bare name) is accepted.
    let name = trimmed.strip_prefix("app/").unwrap_or(trimmed);
    let name = name.strip_suffix("[bot]").unwrap_or(name);
    if is_valid_username(name) {
        Some(name.to_string())
    } else {
        None
    }
}

/// GitHub's username grammar: a leading alphanumeric then up to 38 more
/// alphanumerics-or-hyphens (39 chars total). Rejects empty, over-long, a
/// leading `-`, and any other character (slash, brackets, `.`).
fn is_valid_username(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.len() <= 39 && chars.all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Whether a resolved avatar URL is a plain https URL on a host we trust to load
/// under the null CSP — `avatars.githubusercontent.com` (and its subdomains) or
/// `github.com`. The `.avatar_url` value comes from untrusted JSON, so an
/// attacker-shaped host must not reach an `<img src>`.
fn is_trusted_avatar_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    // The host is everything up to the first `/`, `?`, or `#`.
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    host == "github.com"
        || host == "githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

/// The real avatar URL for a GitHub bot account (dependabot, renovate,
/// github-actions, …), or `""` when it can't be resolved (invalid login,
/// unknown bot, offline, or no gh). Read-only and repo-independent — the
/// `users/<name>[bot]` API is global, so no repo dir is passed. Never errors on
/// a lookup miss: an empty string tells the caller to fall back to initials, and
/// a decoration must not raise a toast.
#[tauri::command]
pub async fn gh_bot_avatar(login: String) -> AppResult<String> {
    // Normalize + grammar-validate FIRST — the name goes into a process arg.
    let Some(name) = normalize_bot_login(&login) else {
        return Ok(String::new());
    };
    // Percent-encoded brackets (`%5B`/`%5D`) — verified live that gh resolves
    // `users/dependabot%5Bbot%5D`; literal brackets are shell-fragile.
    let path = format!("users/{name}%5Bbot%5D");
    let args = ["api", &path, "-q", ".avatar_url"];
    // `run_gh_raw` never turns a 404 (unknown bot) into an error; a missing gh or
    // timeout does return Err, which we swallow to "" — decorations never toast.
    let out = match run_gh_raw(None, &args, GH_TIMEOUT).await {
        Ok(out) => out,
        Err(_) => return Ok(String::new()),
    };
    if out.code != 0 {
        return Ok(String::new());
    }
    let url = out.stdout_lossy().trim().to_string();
    if is_trusted_avatar_url(&url) {
        Ok(url)
    } else {
        // Empty, a null (`gh -q` prints nothing), or an untrusted host → no avatar.
        Ok(String::new())
    }
}

/// A `commit.author.email → avatar_url` pairing the History surfaces use to
/// upgrade a commit author's initials to their real GitHub avatar. Only pairs
/// whose email matches a GitHub account (so the API returns a non-null `author`)
/// and whose avatar host we trust survive; everyone else keeps initials.
#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitAuthorAvatar {
    pub email: String,
    pub avatar_url: String,
}

/// The GitHub *account* attached to a commit in the commits-list response — null
/// whenever the commit's author email matches no GitHub user (common: any
/// non-GitHub email, a since-changed address). Mirrors the `Option<…>` account
/// shape the PR file/commit parses use (see `pr.rs`), but with its own struct so
/// it can also read `avatar_url` (which `RawLogin` doesn't carry, and which the
/// PR parses reuse — don't touch that type).
#[derive(Deserialize)]
struct GhCommitsListAuthor {
    // Only `avatar_url` is consumed; the account's `login` is deliberately not
    // deserialized (serde ignores unknown JSON fields).
    #[serde(default)]
    avatar_url: String,
}

#[derive(Deserialize, Default)]
struct GhCommitsListCommitAuthor {
    #[serde(default)]
    email: String,
}

#[derive(Deserialize, Default)]
struct GhCommitsListCommitInner {
    #[serde(default)]
    author: GhCommitsListCommitAuthor,
}

/// One entry of `repos/{owner}/{repo}/commits`. `commit.author.email` is the git
/// author email (always present); the top-level `author` is the GitHub account,
/// null when the email maps to no user.
#[derive(Deserialize)]
struct GhCommitsListItem {
    #[serde(default)]
    commit: GhCommitsListCommitInner,
    #[serde(default)]
    author: Option<GhCommitsListAuthor>,
}

/// Parse a commits-list JSON body into the trusted `email → avatar_url` pairs.
/// Pure (no I/O), so it's unit-tested directly: skips entries with a null GitHub
/// account (email matches no user), an empty email, or an empty/untrusted avatar
/// URL; lowercases emails; and dedupes on email (first occurrence wins — the
/// list is newest-first, so the freshest avatar for an email is kept).
fn parse_commit_author_avatars(body: &str) -> Vec<CommitAuthorAvatar> {
    let items: Vec<GhCommitsListItem> = match serde_json::from_str(body) {
        Ok(items) => items,
        // A malformed/empty body (or the object an error response returns) yields
        // no avatars — a decoration never errors.
        Err(_) => return Vec::new(),
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let Some(author) = item.author else { continue };
        let email = item.commit.author.email.trim().to_ascii_lowercase();
        if email.is_empty() {
            continue;
        }
        let avatar_url = author.avatar_url.trim();
        if avatar_url.is_empty() || !is_trusted_avatar_url(avatar_url) {
            continue;
        }
        if seen.insert(email.clone()) {
            out.push(CommitAuthorAvatar {
                email,
                avatar_url: avatar_url.to_string(),
            });
        }
    }
    out
}

/// Resolve `commit-author email → GitHub avatar URL` for one recent-commits page
/// of a GitHub repo — the History surfaces' fourth avatar tier, for human
/// authors whose email is neither a GitHub no-reply nor has a Gravatar. This is a
/// **decoration with deliberately partial coverage**: a single non-paginated
/// commits-API call (the most recent 100 commits), NOT the completion pagination
/// `gh_pr_commits_paginated` needs — emails outside that window simply keep their
/// initials, matching this module's existing silent-miss philosophy.
///
/// github.com only: `is_trusted_avatar_url` filters every returned URL to
/// https + github.com/githubusercontent hosts, so a GitHub Enterprise repo's
/// GHE-hosted avatars are dropped and GHE repos keep initials — the same
/// github.com-only stance `gh_bot_avatar` takes, by design.
///
/// Never errors: any gh failure — no gh, offline, or the 409 an EMPTY repo's
/// commits endpoint returns — resolves to an empty list, because a decoration
/// must not raise a toast.
#[tauri::command]
pub async fn gh_commit_author_avatars(repo_path: String) -> AppResult<Vec<CommitAuthorAvatar>> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to keep this on the user's own fork (precedent:
    // `gh_rulesets_list`). An unparseable/missing origin resolves to the empty
    // list — every OTHER gh_origin_slug caller is a user-initiated command where
    // propagating is right; this one is a decoration bound by the "never errors"
    // contract above.
    let Ok(slug) = crate::github::gh_origin_slug(&repo_path).await else {
        return Ok(Vec::new());
    };
    // One non-paginated call — intentionally NOT `--paginate`: this is a partial
    // decoration, not the exhaustive completion `gh_pr_commits_paginated` does.
    let out = match run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/commits?per_page=100")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(out) => out,
        // gh failed (offline / no auth / the 409 an empty repo returns) → no
        // avatars, no error.
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_commit_author_avatars(&out.stdout_lossy()))
}

#[cfg(test)]
mod tests {
    use super::{is_trusted_avatar_url, normalize_bot_login, parse_commit_author_avatars};

    #[test]
    fn normalize_accepts_the_three_bot_login_shapes() {
        assert_eq!(normalize_bot_login("app/dependabot").as_deref(), Some("dependabot"));
        assert_eq!(normalize_bot_login("dependabot[bot]").as_deref(), Some("dependabot"));
        assert_eq!(normalize_bot_login("dependabot").as_deref(), Some("dependabot"));
        // Both prefix and suffix together.
        assert_eq!(normalize_bot_login("app/renovate[bot]").as_deref(), Some("renovate"));
        // Hyphens are valid mid-name (github-actions).
        assert_eq!(
            normalize_bot_login("github-actions[bot]").as_deref(),
            Some("github-actions")
        );
        // Surrounding whitespace is trimmed.
        assert_eq!(normalize_bot_login("  dependabot[bot]  ").as_deref(), Some("dependabot"));
    }

    #[test]
    fn normalize_rejects_invalid_names() {
        // A leading hyphen (flag-injection guard).
        assert_eq!(normalize_bot_login("-evil"), None);
        assert_eq!(normalize_bot_login("app/-evil[bot]"), None);
        // A slash inside the name (path traversal / extra API segments).
        assert_eq!(normalize_bot_login("foo/bar"), None);
        // Empty / whitespace only.
        assert_eq!(normalize_bot_login(""), None);
        assert_eq!(normalize_bot_login("   "), None);
        assert_eq!(normalize_bot_login("app/"), None);
        assert_eq!(normalize_bot_login("[bot]"), None);
        // Over-long (>39 chars after stripping).
        assert_eq!(normalize_bot_login(&"a".repeat(40)), None);
        // 39 is the boundary and allowed.
        assert_eq!(normalize_bot_login(&"a".repeat(39)).as_deref(), Some("a".repeat(39).as_str()));
    }

    #[test]
    fn trusted_url_gate_accepts_only_https_github_hosts() {
        assert!(is_trusted_avatar_url("https://avatars.githubusercontent.com/in/29110?v=4"));
        assert!(is_trusted_avatar_url("https://github.com/dependabot.png?size=48"));
        assert!(is_trusted_avatar_url("https://githubusercontent.com/x"));
        // Wrong scheme.
        assert!(!is_trusted_avatar_url("http://avatars.githubusercontent.com/in/1"));
        // Look-alike / attacker host (suffix without the dot boundary).
        assert!(!is_trusted_avatar_url("https://evilgithubusercontent.com/x"));
        assert!(!is_trusted_avatar_url("https://github.com.evil.com/x"));
        assert!(!is_trusted_avatar_url("https://evil.com/x"));
        // Empty.
        assert!(!is_trusted_avatar_url(""));
    }

    #[test]
    fn parse_keeps_only_valid_first_entries_lowercased() {
        // Newest-first, with: a valid entry; a null-account entry (no GitHub
        // user); an empty-avatar entry (account present but blank URL); a
        // duplicate email (later, older — must lose to the first); an
        // untrusted-host avatar (GHE-style) that must be filtered; and an
        // empty-email entry.
        let body = r#"[
            {
                "commit": { "author": { "email": "Alice@Example.com" } },
                "author": { "login": "alice", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4" }
            },
            {
                "commit": { "author": { "email": "nomatch@example.com" } },
                "author": null
            },
            {
                "commit": { "author": { "email": "blank@example.com" } },
                "author": { "login": "blank", "avatar_url": "" }
            },
            {
                "commit": { "author": { "email": "alice@example.com" } },
                "author": { "login": "alice2", "avatar_url": "https://avatars.githubusercontent.com/u/999?v=4" }
            },
            {
                "commit": { "author": { "email": "ghe@example.com" } },
                "author": { "login": "ghe", "avatar_url": "https://ghe.corp.example.com/avatars/u/2" }
            },
            {
                "commit": { "author": { "email": "" } },
                "author": { "login": "noemail", "avatar_url": "https://avatars.githubusercontent.com/u/3?v=4" }
            }
        ]"#;
        let got = parse_commit_author_avatars(body);
        // Only Alice survives: lowercased, and the FIRST (newest) avatar wins over
        // the later duplicate.
        assert_eq!(
            got,
            vec![super::CommitAuthorAvatar {
                email: "alice@example.com".to_string(),
                avatar_url: "https://avatars.githubusercontent.com/u/1?v=4".to_string(),
            }]
        );
    }

    #[test]
    fn parse_tolerates_a_malformed_body() {
        // The 409/empty-repo body (an object, not an array) or any junk → no avatars.
        assert!(parse_commit_author_avatars("").is_empty());
        assert!(parse_commit_author_avatars(r#"{"message":"Git Repository is empty."}"#).is_empty());
    }
}
