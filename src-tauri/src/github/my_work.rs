//! The cross-repo "My work" inbox: every open pull request and issue involving
//! the signed-in GitHub user, in one call.
//!
//! Shells `gh search issues` and `gh search prs`, so it rides the user's gh CLI
//! auth and never handles a token. Account-scoped — no repo path — because the
//! whole point is the items that live OUTSIDE the checked-out repo.
//!
//! Two queries, because GitHub's `involves:` qualifier does NOT cover
//! review-requested (see [`INVOLVES_ARGS`]); their results are merged into one
//! page by [`merge_my_work`].

use std::collections::HashSet;

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
/// here; only the latter is taken (both wire halves split from it). Optional
/// because the intake shape is untrusted.
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

/// One raw `gh search … --json` hit. Every field is optional so a hit that omits
/// one still deserializes and can be judged by [`item_from_intake`]; a
/// wrong-TYPED field fails the hit's own deserialize and drops it. This intake
/// shape is deliberately separate from the outgoing [`MyWorkItem`].
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

/// The `--json` field set both legs request; identical so the two parse through
/// the same intake shape.
const MY_WORK_FIELDS: &str = "number,title,isPullRequest,repository,updatedAt,url,author";

/// The whole page this surface fetches, per leg and after the merge. There is no
/// pagination, so this is also the point where the inbox truncates — the wire
/// envelope's `truncated` flag reports that to the frontend, so the number
/// itself is not mirrored there and can change on its own.
const MY_WORK_LIMIT: usize = 200;

/// Leg 1. GitHub's `involves:` is author OR assignee OR mentions OR commenter —
/// it does NOT cover review-requested, which is a separate qualifier
/// ([`REVIEW_REQUESTED_ARGS`] is the leg that adds it).
///
/// `--sort updated --order desc` is required, not cosmetic: gh defaults to
/// best-match, so a relevance-ranked `--limit 200` would drop recent items for
/// accounts with more than 200 open hits.
const INVOLVES_ARGS: &[&str] = &[
    "search",
    "issues",
    "--include-prs",
    "--involves=@me",
    "--state=open",
    "--limit",
    "200",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--json",
    MY_WORK_FIELDS,
];

/// Leg 2: the pull requests awaiting the user's review, which leg 1 cannot see.
/// Every hit here is a PR by construction — `gh search prs` cannot return an
/// issue — which is what [`my_work`] passes as this leg's `is_pull_request`
/// default.
const REVIEW_REQUESTED_ARGS: &[&str] = &[
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    "--limit",
    "200",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--json",
    MY_WORK_FIELDS,
];

/// Narrow one intake hit to a wire item, or `None` when it can't address
/// anything: a hit without number, title, url, or a splittable `owner/name` has
/// no usable link, so it is dropped rather than rendered broken.
///
/// `default_is_pull_request` applies only when gh omits the field: the
/// review-requested leg queries `gh search prs`, where every hit is a PR, so a
/// blanket `false` there would file the whole leg as issues.
fn item_from_intake(raw: GhSearchItem, default_is_pull_request: bool) -> Option<MyWorkItem> {
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
        is_pull_request: raw.is_pull_request.unwrap_or(default_is_pull_request),
        repo_full_name,
        repo_owner,
        repo_name,
        host,
        url,
        updated_at: raw.updated_at.unwrap_or_default(),
        author_login: raw.author.and_then(|a| a.login).filter(|l| !l.is_empty()),
    })
}

/// One leg's parsed result: its wire items, plus how many elements gh actually
/// returned. The raw count is the leg's own truncation signal and cannot be
/// recovered from `items` — dropped hits ([`item_from_intake`]) already shrank
/// that.
struct MyWorkLeg {
    items: Vec<MyWorkItem>,
    raw_len: usize,
}

/// Parse one leg's `gh search … --json` stdout into wire items. Per-hit
/// tolerance: each element is deserialized on its own so one malformed hit is
/// skipped rather than sinking the batch. A top-level parse failure IS an error —
/// an empty inbox and unreadable output must not look alike to the caller.
fn parse_my_work(stdout: &str, default_is_pull_request: bool) -> AppResult<MyWorkLeg> {
    let raw: Vec<Value> = serde_json::from_str(stdout)
        .map_err(|e| AppError::Gh(format!("could not parse your GitHub work items: {e}")))?;
    let raw_len = raw.len();
    Ok(MyWorkLeg {
        items: raw
            .into_iter()
            .filter_map(|v| serde_json::from_value::<GhSearchItem>(v).ok())
            .filter_map(|raw| item_from_intake(raw, default_is_pull_request))
            .collect(),
        raw_len,
    })
}

/// One page of the inbox, and whether anything was left off it: `truncated` is
/// true when either search leg hit its own server-side cap or the merged union
/// overshot the page — so it can be true on a page that arrives short.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyWorkPage {
    pub items: Vec<MyWorkItem>,
    pub truncated: bool,
}

/// Merge the two legs into one page: dedupe by URL (a PR can be both involving
/// and review-requested), newest first, truncated to [`MY_WORK_LIMIT`] so the
/// wire contract stays one page however much the union overshoots.
///
/// A leg that came back with as many elements as it ASKED for is itself a
/// truncation: gh may have had more, and the page can still land short of the
/// limit once dedupe and dropped hits take their cut, so the union's length
/// alone can't see it. The reverse error — a leg holding exactly the limit with
/// nothing more on the server — reports a cap that isn't there, and that is the
/// safe direction: an inbox that hides items must never look complete.
///
/// The sort is a plain string compare because gh emits `updatedAt` as
/// Z-suffixed RFC 3339 — fixed width, one offset, so lexical order IS
/// chronological order. An item with no timestamp sorts last rather than
/// claiming to be the newest.
fn merge_my_work(involves: MyWorkLeg, review_requested: MyWorkLeg) -> MyWorkPage {
    let leg_capped =
        involves.raw_len >= MY_WORK_LIMIT || review_requested.raw_len >= MY_WORK_LIMIT;
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<MyWorkItem> = Vec::new();
    for item in involves.items.into_iter().chain(review_requested.items) {
        if seen.insert(item.url.clone()) {
            merged.push(item);
        }
    }
    merged.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let truncated = leg_capped || merged.len() > MY_WORK_LIMIT;
    merged.truncate(MY_WORK_LIMIT);
    MyWorkPage {
        items: merged,
        truncated,
    }
}

/// Every open pull request and issue involving the signed-in GitHub user,
/// across every repo they can see, plus the ones awaiting their review.
///
/// Sequential rather than concurrent: two `gh` spawns keep the failure mode
/// simple, and either leg failing fails the call rather than half-filling the
/// inbox.
pub async fn my_work() -> AppResult<MyWorkPage> {
    let involves = run_gh(None, INVOLVES_ARGS, GH_NETWORK_TIMEOUT).await?;
    let involves = parse_my_work(&involves.stdout_lossy(), false)?;
    let review_requested = run_gh(None, REVIEW_REQUESTED_ARGS, GH_NETWORK_TIMEOUT).await?;
    // Leg 2 is `gh search prs`: an omitted `isPullRequest` still means PR.
    let review_requested = parse_my_work(&review_requested.stdout_lossy(), true)?;
    Ok(merge_my_work(involves, review_requested))
}

#[cfg(test)]
mod tests {
    use super::{
        merge_my_work, parse_my_work, MyWorkItem, MyWorkLeg, MyWorkPage, INVOLVES_ARGS,
        MY_WORK_FIELDS, MY_WORK_LIMIT, REVIEW_REQUESTED_ARGS,
    };
    use serde_json::{json, Value};

    /// A real `gh search issues --include-prs --involves=@me --state=open
    /// --limit 3 --json …` response (gh 2.x), structure byte-faithful; the
    /// third-party author logins are stand-ins.
    const GH_FIXTURE: &str = r#"[{"author":{"id":"U_kgDODHf_mg","is_bot":false,"login":"octo-cat","type":"User","url":"https://github.com/octo-cat"},"isPullRequest":true,"number":309,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"feat(settings): accent colour and UI font appearance","updatedAt":"2026-09-05T23:21:02Z","url":"https://github.com/theBGuy/GitDesktop/pull/309"},{"author":{"id":"MDM6Qm90NDk2OTkzMzM=","is_bot":false,"login":"dependabot[bot]","type":"Bot","url":"https://github.com/apps/dependabot"},"isPullRequest":true,"number":300,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"chore(deps): bump astro from 6.4.8 to 7.1.6","updatedAt":"2026-09-04T15:30:38Z","url":"https://github.com/theBGuy/GitDesktop/pull/300"},{"author":{"id":"MDQ6VXNlcjY4Nzc1OTU=","is_bot":false,"login":"octo-dev","type":"User","url":"https://github.com/octo-dev"},"isPullRequest":false,"number":262,"repository":{"name":"GitDesktop","nameWithOwner":"theBGuy/GitDesktop"},"title":"feat: Markdown preview view for md files present in diffs","updatedAt":"2026-09-05T07:06:45Z","url":"https://github.com/theBGuy/GitDesktop/issues/262"}]"#;

    /// Both legs are pinned here because each carries a correctness constraint,
    /// not just a preference: without `--sort updated`, gh's best-match default
    /// makes `--limit 200` a relevance subset that can omit recent items.
    #[test]
    fn args_carry_the_whole_inbox_query() {
        assert!(INVOLVES_ARGS.starts_with(&["search", "issues"]));
        for flag in ["--include-prs", "--involves=@me", "--state=open"] {
            assert!(INVOLVES_ARGS.contains(&flag), "involves leg missing {flag}");
        }

        // `involves:` doesn't cover review-requested, so the second leg exists.
        assert!(REVIEW_REQUESTED_ARGS.starts_with(&["search", "prs"]));
        assert!(REVIEW_REQUESTED_ARGS.contains(&"--review-requested=@me"));
        assert!(REVIEW_REQUESTED_ARGS.contains(&"--state=open"));
        // `--include-prs` is an issues-search flag; `gh search prs` rejects it.
        assert!(!REVIEW_REQUESTED_ARGS.contains(&"--include-prs"));

        let limit = MY_WORK_LIMIT.to_string();
        for args in [INVOLVES_ARGS, REVIEW_REQUESTED_ARGS] {
            let has_pair = |pair: &[&str; 2]| args.windows(2).any(|w| w == pair.as_slice());
            assert!(
                args.contains(&MY_WORK_FIELDS),
                "{args:?} lost the field set"
            );
            // Newest-first, or the limit truncates by relevance instead of age.
            assert!(
                has_pair(&["--sort", "updated"]),
                "{args:?} lost --sort updated"
            );
            assert!(has_pair(&["--order", "desc"]), "{args:?} lost --order desc");
            assert!(
                has_pair(&["--limit", limit.as_str()]),
                "{args:?} limit must match MY_WORK_LIMIT",
            );
        }
    }

    /// The frontend mirrors this wire shape field-for-field, so the serialized
    /// key set is pinned here rather than trusted to the `rename_all` attribute.
    #[test]
    fn fixture_serializes_to_the_camel_case_wire_shape() {
        let items = parse_my_work(GH_FIXTURE, false).unwrap().items;
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

        // The items ride inside the page envelope, whose own two keys the
        // frontend reads by name.
        let page = serde_json::to_value(MyWorkPage {
            items,
            truncated: true,
        })
        .unwrap();
        let mut page_keys: Vec<&str> = page
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        page_keys.sort_unstable();
        assert_eq!(page_keys, ["items", "truncated"]);
        assert_eq!(page.get("truncated").and_then(Value::as_bool), Some(true));
        assert_eq!(page.pointer("/items/0"), Some(&wire));
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
        let items = parse_my_work(&raw, false).unwrap().items;
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
            let items = parse_my_work(&batch.to_string(), false).unwrap().items;
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
        let items = parse_my_work(&raw, false).unwrap().items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].author_login, None);
        // Absent, not a fabricated timestamp.
        assert_eq!(items[0].updated_at, "");
    }

    #[test]
    fn my_work_distinguishes_an_empty_inbox_from_unreadable_output() {
        let empty = parse_my_work("[]", false).unwrap();
        assert!(empty.items.is_empty());
        assert_eq!(empty.raw_len, 0);
        assert!(parse_my_work("not json", false).is_err());
        assert!(parse_my_work("{\"items\":[]}", false).is_err());
    }

    /// `gh search prs` hits are PRs by construction, so an omitted
    /// `isPullRequest` on that leg must NOT fall back to "issue" — that would
    /// file every review-requested PR under the wrong kind.
    #[test]
    fn my_work_classifies_the_review_requested_leg_as_pull_requests() {
        let raw = json!([
            // gh 2.94.0 does emit `isPullRequest` on `gh search prs` (measured),
            // so the leg default is a belt-and-braces path — pin both.
            {"number": 1, "title": "explicit", "isPullRequest": true,
             "repository": {"nameWithOwner": "octo/repo"},
             "url": "https://github.com/octo/repo/pull/1",
             "updatedAt": "2026-01-01T00:00:00Z"},
            {"number": 2, "title": "omitted",
             "repository": {"nameWithOwner": "octo/repo"},
             "url": "https://github.com/octo/repo/pull/2",
             "updatedAt": "2026-01-02T00:00:00Z"},
        ])
        .to_string();

        let review_leg = parse_my_work(&raw, true).unwrap().items;
        assert!(
            review_leg.iter().all(|i| i.is_pull_request),
            "{review_leg:?}"
        );

        // The involves leg keeps the opposite default: there an omitted flag
        // really can mean an issue.
        let involves_leg = parse_my_work(&raw, false).unwrap().items;
        assert!(involves_leg[0].is_pull_request);
        assert!(!involves_leg[1].is_pull_request);
    }

    #[test]
    fn merge_dedupes_by_url_and_orders_newest_first() {
        let item = |n: u64, url: &str, updated: &str| {
            let raw = json!([{
                "number": n, "title": "t", "isPullRequest": true,
                "repository": {"nameWithOwner": "octo/repo"},
                "url": url, "updatedAt": updated
            }])
            .to_string();
            parse_my_work(&raw, true).unwrap().items.pop().unwrap()
        };

        let shared = "https://github.com/octo/repo/pull/300";
        let involves = vec![
            item(
                309,
                "https://github.com/octo/repo/pull/309",
                "2026-09-05T23:21:02Z",
            ),
            item(300, shared, "2026-09-04T15:30:38Z"),
        ];
        // #300 is in BOTH legs (review-requested AND involving) — the real
        // overlap observed against gh; #2 is review-requested only, the whole
        // reason the second leg exists.
        let review_requested = vec![
            item(300, shared, "2026-09-04T15:30:38Z"),
            item(
                2,
                "https://github.com/octo/other/pull/2",
                "2026-09-06T00:00:00Z",
            ),
        ];

        // Neither leg came near its cap, so nothing here is truncation.
        let leg = |items: Vec<MyWorkItem>| MyWorkLeg {
            raw_len: items.len(),
            items,
        };
        let page = merge_my_work(leg(involves), leg(review_requested));
        assert_eq!(page.items.len(), 3, "the shared URL should appear once");
        assert_eq!(
            page.items.iter().map(|i| i.number).collect::<Vec<_>>(),
            [2, 309, 300],
            "merged page must be newest-first ACROSS both legs",
        );
        assert_eq!(page.items.iter().filter(|i| i.url == shared).count(), 1);
        // A union well under the cap is the whole inbox.
        assert!(!page.truncated);
    }

    /// The union can overshoot the per-leg limit, so the merge is where the wire
    /// contract's one-page promise is actually kept.
    #[test]
    fn merge_truncates_the_union_to_one_page() {
        let leg = |prefix: &str, count: usize, base: u32| {
            let raw: Vec<Value> = (0..count)
                .map(|i| {
                    json!({
                        "number": i + 1, "title": "t", "isPullRequest": true,
                        "repository": {"nameWithOwner": "octo/repo"},
                        "url": format!("https://github.com/octo/{prefix}/pull/{i}"),
                        // Descending within the leg, and the `a` leg is newer.
                        "updatedAt": format!("2026-{base:02}-01T00:{:02}:00Z", 59 - i % 60),
                    })
                })
                .collect();
            parse_my_work(&Value::Array(raw).to_string(), true).unwrap()
        };
        let empty = || parse_my_work("[]", true).unwrap();

        let page = merge_my_work(leg("a", MY_WORK_LIMIT, 9), leg("b", MY_WORK_LIMIT, 1));
        assert_eq!(
            page.items.len(),
            MY_WORK_LIMIT,
            "400 distinct hits must cap at 200"
        );
        assert!(page.truncated, "an over-limit union must report truncation");
        // Truncation keeps the NEWEST page, not the first leg wholesale.
        assert!(
            page.items
                .windows(2)
                .all(|w| w[0].updated_at >= w[1].updated_at),
            "truncated page must still be newest-first",
        );
        assert_eq!(page.items[0].updated_at, "2026-09-01T00:59:00Z");

        // A leg that filled its own `--limit` IS the truncation event, even
        // though the page lands exactly on the cap and never overshoots it —
        // gh had no way to tell us what it left behind.
        let at_limit = merge_my_work(leg("a", MY_WORK_LIMIT, 9), empty());
        assert_eq!(at_limit.items.len(), MY_WORK_LIMIT);
        assert!(
            at_limit.truncated,
            "a leg that came back full may have had more"
        );

        // The review-requested leg's cap is its own truncation event — the
        // disjunction's second arm must hold without the first.
        let b_capped = merge_my_work(empty(), leg("b", MY_WORK_LIMIT, 1));
        assert!(b_capped.truncated, "either leg's full page reports the cap");

        // One short of the cap, gh returned everything it had.
        let under = merge_my_work(leg("a", MY_WORK_LIMIT - 1, 9), empty());
        assert_eq!(under.items.len(), MY_WORK_LIMIT - 1);
        assert!(!under.truncated);
    }

    /// The reachable arm the union's length can never see: a leg fills its cap,
    /// dropped hits shrink it below the limit, and the merged page arrives short
    /// while items are still missing from the server.
    #[test]
    fn merge_reports_a_capped_leg_whose_page_arrives_short() {
        let mut raw: Vec<Value> = (0..MY_WORK_LIMIT - 5)
            .map(|i| {
                json!({
                    "number": i + 1, "title": "t", "isPullRequest": true,
                    "repository": {"nameWithOwner": "octo/repo"},
                    "url": format!("https://github.com/octo/repo/pull/{i}"),
                    "updatedAt": "2026-09-01T00:00:00Z",
                })
            })
            .collect();
        // Five unaddressable hits: gh still counted them against the limit.
        raw.extend((0..5).map(|_| json!({"number": 1, "title": "t"})));
        assert_eq!(raw.len(), MY_WORK_LIMIT);

        let capped = parse_my_work(&Value::Array(raw).to_string(), true).unwrap();
        assert_eq!(capped.items.len(), MY_WORK_LIMIT - 5, "five hits dropped");

        let page = merge_my_work(capped, parse_my_work("[]", true).unwrap());
        assert_eq!(page.items.len(), MY_WORK_LIMIT - 5);
        assert!(
            page.truncated,
            "a short page from a capped leg still hides items"
        );
    }
}
