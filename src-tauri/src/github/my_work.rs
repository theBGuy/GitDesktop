//! The cross-repo "My work" inbox: every open pull request and issue involving
//! the signed-in GitHub user, in one call.
//!
//! Shells `gh search issues`, so it rides the user's gh CLI auth and never
//! handles a token. Account-scoped — no repo path — because the whole point is
//! the items that live OUTSIDE the checked-out repo.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

/// One open pull request or issue in the inbox, flattened for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyWorkItem {
    /// A repo-scoped counter, so it stays JS-number-safe as a `u64` — the
    /// string-over-IPC rule targets snowflake ids, which these aren't.
    pub number: u64,
    pub title: String,
    pub is_pull_request: bool,
    /// `owner/name` exactly as GitHub reports it; the split halves follow.
    pub repo_full_name: String,
    pub repo_owner: String,
    pub repo_name: String,
    /// Parsed from `url`, so Enterprise items carry their own host. Empty when
    /// the URL has no parseable authority (modelled absence, never a guess).
    pub host: String,
    pub url: String,
    /// ISO-8601 as gh emits it; the frontend validates before formatting.
    pub updated_at: String,
    pub author_login: Option<String>,
}

/// The `repository` object on a search hit. gh emits `name` and `nameWithOwner`
/// here; both stay optional because the intake shape is untrusted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepoRef {
    #[serde(default)]
    name_with_owner: Option<String>,
}

/// The `author` object on a search hit. gh also emits `id`, `type`, and a
/// snake_case `is_bot` alongside `login`; unknown fields are ignored.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhAuthorRef {
    #[serde(default)]
    login: Option<String>,
}

/// One raw `gh search issues --json …` hit. Every field is optional so a hit
/// that omits one still deserializes and can be judged by [`item_from_intake`];
/// this intake shape is deliberately separate from the outgoing [`MyWorkItem`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhSearchItem {
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    is_pull_request: Option<bool>,
    #[serde(default)]
    repository: Option<GhRepoRef>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    author: Option<GhAuthorRef>,
}

/// The inbox query. `--involves=@me` is the one predicate covering authored,
/// assigned, mentioned, and review-requested; `--limit 200` is the whole page
/// this surface fetches (no pagination).
const MY_WORK_ARGS: &[&str] = &[
    "search",
    "issues",
    "--include-prs",
    "--involves=@me",
    "--state=open",
    "--limit",
    "200",
    "--json",
    "number,title,isPullRequest,repository,updatedAt,url,author",
];

/// Narrow one intake hit to a wire item, or `None` when it can't address
/// anything: a hit without number, title, url, or a splittable `owner/name` has
/// no usable link, so it is dropped rather than rendered broken.
fn item_from_intake(raw: GhSearchItem) -> Option<MyWorkItem> {
    let number = raw.number?;
    let title = raw.title.filter(|t| !t.is_empty())?;
    let url = raw.url.filter(|u| !u.is_empty())?;
    let repo_full_name = raw
        .repository
        .and_then(|r| r.name_with_owner)
        .filter(|n| !n.is_empty())?;
    let (owner, name) = repo_full_name.split_once('/')?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    let repo_owner = owner.to_string();
    let repo_name = name.to_string();
    // The shared remote-URL host parser, so Enterprise hosts and IPv6 literals
    // are spelled the same here as everywhere else in the app.
    let host = crate::forge::remote_host(&url).unwrap_or_default();
    Some(MyWorkItem {
        number,
        title,
        is_pull_request: raw.is_pull_request.unwrap_or(false),
        repo_full_name,
        repo_owner,
        repo_name,
        host,
        url,
        updated_at: raw.updated_at.unwrap_or_default(),
        author_login: raw.author.and_then(|a| a.login).filter(|l| !l.is_empty()),
    })
}

/// Parse `gh search issues --json …` stdout into wire items. Per-hit tolerance:
/// each element is deserialized on its own so one malformed hit is skipped
/// rather than sinking the batch. A top-level parse failure IS an error —
/// an empty inbox and unreadable output must not look alike to the caller.
fn parse_my_work(stdout: &str) -> AppResult<Vec<MyWorkItem>> {
    let raw: Vec<Value> = serde_json::from_str(stdout)
        .map_err(|e| AppError::Gh(format!("could not parse your GitHub work items: {e}")))?;
    Ok(raw
        .into_iter()
        .filter_map(|v| serde_json::from_value::<GhSearchItem>(v).ok())
        .filter_map(item_from_intake)
        .collect())
}

/// Every open pull request and issue involving the signed-in GitHub user,
/// across every repo they can see.
pub async fn my_work() -> AppResult<Vec<MyWorkItem>> {
    let out = run_gh(None, MY_WORK_ARGS, GH_NETWORK_TIMEOUT).await?;
    parse_my_work(&out.stdout_lossy())
}

#[cfg(test)]
mod tests {
    use super::{parse_my_work, MY_WORK_ARGS};
    use serde_json::{json, Value};

    /// A real `gh search issues --include-prs --involves=@me --state=open
    /// --limit 3 --json …` response (gh 2.x), structure byte-faithful; the
    /// third-party author logins are stand-ins.
    const GH_FIXTURE: &str = r#"[{"author":{"id":"U_kgDODHf_mg","is_bot":false,"login":"octo-cat","type":"User","url":"https://github.com/octo-cat"},"isPullRequest":true,"number":309,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"feat(settings): accent colour and UI font appearance","updatedAt":"2026-09-05T23:21:02Z","url":"https://github.com/theBGuy/GitDesktop/pull/309"},{"author":{"id":"MDM6Qm90NDk2OTkzMzM=","is_bot":false,"login":"dependabot[bot]","type":"Bot","url":"https://github.com/apps/dependabot"},"isPullRequest":true,"number":300,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"chore(deps): bump astro from 6.4.8 to 7.1.6","updatedAt":"2026-09-04T15:30:38Z","url":"https://github.com/theBGuy/GitDesktop/pull/300"},{"author":{"id":"MDQ6VXNlcjY4Nzc1OTU=","is_bot":false,"login":"octo-dev","type":"User","url":"https://github.com/octo-dev"},"isPullRequest":false,"number":262,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"feat: Markdown preview view for md files present in diffs","updatedAt":"2026-09-05T07:06:45Z","url":"https://github.com/theBGuy/GitDesktop/issues/262"}]"#;

    #[test]
    fn args_carry_the_whole_inbox_query() {
        assert!(MY_WORK_ARGS.starts_with(&["search", "issues"]));
        for flag in ["--include-prs", "--involves=@me", "--state=open"] {
            assert!(MY_WORK_ARGS.contains(&flag), "missing {flag}");
        }
        assert!(
            MY_WORK_ARGS.contains(&"number,title,isPullRequest,repository,updatedAt,url,author")
        );
    }

    /// The frontend mirrors this wire shape field-for-field, so the serialized
    /// key set is pinned here rather than trusted to the `rename_all` attribute.
    #[test]
    fn fixture_serializes_to_the_camel_case_wire_shape() {
        let items = parse_my_work(GH_FIXTURE).unwrap();
        assert_eq!(items.len(), 3);

        let wire = serde_json::to_value(&items[0]).unwrap();
        let obj = wire.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "authorLogin",
                "host",
                "isPullRequest",
                "number",
                "repoFullName",
                "repoName",
                "repoOwner",
                "title",
                "updatedAt",
                "url",
            ]
        );
        assert_eq!(
            wire,
            json!({
                "number": 309,
                "title": "feat(settings): accent colour and UI font appearance",
                "isPullRequest": true,
                "repoFullName": "theBGuy/GitDesktop",
                "repoOwner": "theBGuy",
                "repoName": "GitDesktop",
                "host": "github.com",
                "url": "https://github.com/theBGuy/GitDesktop/pull/309",
                "updatedAt": "2026-09-05T23:21:02Z",
                "authorLogin": "octo-cat",
            })
        );

        // An issue keeps `isPullRequest: false`, and a bracketed bot login rides
        // through unchanged.
        assert!(!items[2].is_pull_request);
        assert_eq!(items[1].author_login.as_deref(), Some("dependabot[bot]"));
    }

    #[test]
    fn my_work_derives_owner_name_and_host() {
        let raw = json!([
            // A dotted owner is a legal GitHub login and must survive the split.
            {
                "number": 1, "title": "dotted", "isPullRequest": false,
                "repository": {"nameWithOwner": "my.org/repo"},
                "url": "https://github.com/my.org/repo/issues/1",
                "updatedAt": "2026-01-01T00:00:00Z", "author": {"login": "a"}
            },
            // Enterprise: the host comes from the item URL, not a constant.
            {
                "number": 2, "title": "enterprise", "isPullRequest": true,
                "repository": {"nameWithOwner": "acme/tools"},
                "url": "https://github.acme.com:8443/acme/tools/pull/2",
                "updatedAt": "2026-01-02T00:00:00Z", "author": {"login": "b"}
            },
        ])
        .to_string();
        let items = parse_my_work(&raw).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].repo_owner, "my.org");
        assert_eq!(items[0].repo_name, "repo");
        assert_eq!(items[0].host, "github.com");
        assert_eq!(items[1].repo_owner, "acme");
        assert_eq!(items[1].repo_name, "tools");
        assert_eq!(items[1].host, "github.acme.com");
    }

    #[test]
    fn my_work_drops_unaddressable_hits_without_sinking_the_batch() {
        let good = json!({
            "number": 7, "title": "keeper", "isPullRequest": true,
            "repository": {"nameWithOwner": "octo/repo"},
            "url": "https://github.com/octo/repo/pull/7",
            "updatedAt": "2026-01-01T00:00:00Z", "author": {"login": "octo"}
        });
        let drops = [
            // No `/` in nameWithOwner: nothing to address the repo with.
            json!({"number": 1, "title": "t", "repository": {"nameWithOwner": "noslash"},
                   "url": "https://github.com/x/y/issues/1"}),
            json!({"number": 2, "title": "t", "repository": {"nameWithOwner": ""},
                   "url": "https://github.com/x/y/issues/2"}),
            json!({"number": 3, "title": "t", "url": "https://github.com/x/y/issues/3"}),
            // Missing number / title / url.
            json!({"title": "t", "repository": {"nameWithOwner": "x/y"},
                   "url": "https://github.com/x/y/issues/4"}),
            json!({"number": 5, "repository": {"nameWithOwner": "x/y"},
                   "url": "https://github.com/x/y/issues/5"}),
            json!({"number": 6, "title": "t", "repository": {"nameWithOwner": "x/y"}}),
            // A field of the wrong type sinks only its own hit.
            json!({"number": "eight", "title": "t", "repository": {"nameWithOwner": "x/y"},
                   "url": "https://github.com/x/y/issues/8"}),
        ];

        for drop in &drops {
            let batch = Value::Array(vec![drop.clone(), good.clone()]);
            let items = parse_my_work(&batch.to_string()).unwrap();
            assert_eq!(items.len(), 1, "should have dropped only {drop}");
            assert_eq!(items[0].number, 7);
        }
    }

    #[test]
    fn my_work_models_a_missing_author_as_absent() {
        // A ghost author and no `updatedAt` — neither is required to address the
        // item, so both degrade instead of dropping the hit.
        let raw = json!([{
            "number": 1, "title": "ghost", "isPullRequest": false,
            "repository": {"nameWithOwner": "octo/repo"},
            "url": "https://github.com/octo/repo/issues/1",
            "author": null
        }])
        .to_string();
        let items = parse_my_work(&raw).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].author_login, None);
        // Absent, not a fabricated timestamp.
        assert_eq!(items[0].updated_at, "");
    }

    #[test]
    fn my_work_distinguishes_an_empty_inbox_from_unreadable_output() {
        assert!(parse_my_work("[]").unwrap().is_empty());
        assert!(parse_my_work("not json").is_err());
        assert!(parse_my_work("{\"items\":[]}").is_err());
    }
}
