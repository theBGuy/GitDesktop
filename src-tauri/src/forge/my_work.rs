//! The provider-neutral "My work" inbox model: every open pull/merge request and
//! issue involving the signed-in user, from any provider, in one page.
//!
//! Account-scoped rather than repo-scoped — the point of the surface is the items
//! that live OUTSIDE the checked-out repo — so each provider arm produces
//! [`MyWorkLeg`]s and [`merge_legs`] folds them into the single wire page. Item
//! shapes are neutral so the frontend renders one row type whatever answered.

use std::collections::HashSet;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::forge::model::Provider;

/// The whole page this surface fetches, after the merge. There is no pagination,
/// so this is also the point where the inbox truncates — the wire envelope's
/// `truncated` flag reports that to the frontend, so the number itself is not
/// mirrored there and can change on its own.
///
/// Each arm's PER-LEG cap is its own API's, not this: GitHub asks for 200, GitLab
/// 100, Bitbucket 50. A leg reports `capped` against that number, never this one.
pub const MY_WORK_LIMIT: usize = 200;

/// One open pull/merge request or issue in the inbox, flattened for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyWorkItem {
    /// Which provider answered — the row's badge, and what the open path
    /// dispatches its head-ref lookup on.
    pub provider: Provider,
    /// A repo-scoped counter, so it stays JS-number-safe as a `u64` — the
    /// string-over-IPC rule targets snowflake ids, which these aren't.
    pub number: u64,
    pub title: String,
    pub is_pull_request: bool,
    /// The repo's full path as its provider spells it. On GitHub and Bitbucket
    /// that is `owner/name`; on GitLab a nested group path
    /// (`group/subgroup/name`) makes it LONGER than `repo_owner`/`repo_name`
    /// rejoined — those two carry the local-match spelling, this one the
    /// display and head-repo-comparison spelling.
    pub repo_full_name: String,
    /// The namespace segment immediately before the repo name — the spelling
    /// `git::repo::parse_owner_host` persists on `RecentRepo`, which the
    /// frontend's local-repo match compares against.
    pub repo_owner: String,
    pub repo_name: String,
    /// Parsed from `url`, so Enterprise and self-managed items carry their own
    /// host. Empty when the URL has no parseable authority (modelled absence,
    /// never a guess).
    pub host: String,
    pub url: String,
    /// RFC 3339 UTC at second precision, via [`normalize_updated_at`] — the
    /// merge sorts on this as a STRING, so every arm must normalize or mixed
    /// spellings mis-order silently.
    pub updated_at: String,
    pub author_login: Option<String>,
}

/// One page of the inbox, and whether anything was left off it: `truncated` is
/// true when any leg hit its own server-side cap or the merged union overshot the
/// page — so it can be true on a page that arrives short.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyWorkPage {
    pub items: Vec<MyWorkItem>,
    pub truncated: bool,
}

/// One producer's parsed result: its wire items, plus whether that producer hit
/// its OWN cap. Each arm computes `capped` where it can see the raw response —
/// dropped and deduped items already shrank `items`, so the count there can never
/// recover it.
pub struct MyWorkLeg {
    pub items: Vec<MyWorkItem>,
    pub capped: bool,
}

impl MyWorkPage {
    /// The empty page a provider with nothing configured answers with — benign,
    /// and distinct from an error only because the caller already knows the
    /// provider isn't wired up.
    pub fn empty() -> Self {
        Self {
            items: Vec::new(),
            truncated: false,
        }
    }
}

/// A timestamp in the exact form [`normalize_updated_at`] emits. The merge's sort
/// is a lexical string compare, which is chronological order ONLY across this one
/// fixed-width UTC spelling; anything else sorts last rather than claiming a
/// position it hasn't earned.
fn is_canonical(ts: &str) -> bool {
    ts.len() == 20 && ts.ends_with('Z') && DateTime::parse_from_rfc3339(ts).is_ok()
}

/// The sort key: the timestamp when it is canonical, else `""` — which sorts LAST
/// under the descending compare, the same place an item with no timestamp lands.
fn sort_key(item: &MyWorkItem) -> &str {
    if is_canonical(&item.updated_at) {
        &item.updated_at
    } else {
        ""
    }
}

/// An RFC 3339 timestamp normalized to `YYYY-MM-DDTHH:MM:SSZ`, or the input
/// unchanged when it doesn't parse. Fractional seconds truncate and a non-UTC
/// offset is applied, because the merge orders items by comparing these as
/// STRINGS: GitHub emits `…Z`, GitLab `…123Z`, Bitbucket `…+00:00`, and mixing
/// those widths in one lexical sort silently interleaves the page.
///
/// Returning the input unchanged on garbage is deliberate — an unparseable
/// timestamp is data we can't improve, and dropping it would cost the frontend
/// the raw value it may still be able to show.
pub fn normalize_updated_at(raw: &str) -> String {
    match DateTime::parse_from_rfc3339(raw) {
        Ok(dt) => dt
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true),
        Err(_) => raw.to_string(),
    }
}

/// Fold every producer's leg into one page: union in leg order, dedupe by URL (an
/// item can be authored AND review-requested, or reachable from two repos),
/// newest first, truncated to `limit` so the wire contract stays one page however
/// much the union overshoots.
///
/// A leg that came back at its own cap is itself a truncation: the server may
/// have had more, and the page can still land short of `limit` once dedupe and
/// dropped items take their cut, so the union's length alone can't see it. The
/// reverse error — a leg holding exactly its cap with nothing more on the server —
/// reports a cap that isn't there, and that is the safe direction: an inbox that
/// hides items must never look complete.
pub fn merge_legs(legs: Vec<MyWorkLeg>, limit: usize) -> MyWorkPage {
    let leg_capped = legs.iter().any(|l| l.capped);
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<MyWorkItem> = Vec::new();
    for item in legs.into_iter().flat_map(|l| l.items) {
        if seen.insert(item.url.clone()) {
            merged.push(item);
        }
    }
    merged.sort_by(|a, b| sort_key(b).cmp(sort_key(a)));
    let truncated = leg_capped || merged.len() > limit;
    merged.truncate(limit);
    MyWorkPage {
        items: merged,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::{merge_legs, normalize_updated_at, MyWorkItem, MyWorkLeg, MY_WORK_LIMIT};
    use crate::forge::model::Provider;
    use serde_json::json;

    fn item(number: u64, url: &str, updated: &str) -> MyWorkItem {
        MyWorkItem {
            provider: Provider::GitLab,
            number,
            title: "t".into(),
            is_pull_request: true,
            repo_full_name: "group/proj".into(),
            repo_owner: "group".into(),
            repo_name: "proj".into(),
            host: "gitlab.com".into(),
            url: url.into(),
            updated_at: updated.into(),
            author_login: Some("someone".into()),
        }
    }

    fn leg(items: Vec<MyWorkItem>) -> MyWorkLeg {
        MyWorkLeg {
            items,
            capped: false,
        }
    }

    /// The frontend mirrors this wire shape field-for-field, and a `rename_all`
    /// that stopped applying would surface as `undefined` reads rather than a
    /// type error — so both the key set and the provider tag are pinned.
    #[test]
    fn item_serializes_to_the_camel_case_wire_shape() {
        let wire = serde_json::to_value(item(
            7,
            "https://gitlab.com/group/proj/-/merge_requests/7",
            "2026-09-05T23:21:02Z",
        ))
        .unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "authorLogin",
                "host",
                "isPullRequest",
                "number",
                "provider",
                "repoFullName",
                "repoName",
                "repoOwner",
                "title",
                "updatedAt",
                "url",
            ]
        );
        // The provider tag the frontend keys its badge and head-ref dispatch on.
        assert_eq!(wire.get("provider"), Some(&json!("gitlab")));
        assert_eq!(
            serde_json::to_value(Provider::Bitbucket).unwrap(),
            json!("bitbucket")
        );
        assert_eq!(
            serde_json::to_value(Provider::GitHub).unwrap(),
            json!("github")
        );
    }

    #[test]
    fn normalize_folds_every_provider_spelling_to_one_width() {
        // GitHub's spelling is already canonical.
        assert_eq!(
            normalize_updated_at("2026-09-05T23:21:02Z"),
            "2026-09-05T23:21:02Z"
        );
        // GitLab's fractional seconds truncate rather than round.
        assert_eq!(
            normalize_updated_at("2026-09-05T23:21:02.987Z"),
            "2026-09-05T23:21:02Z"
        );
        // Bitbucket spells UTC as an explicit zero offset.
        assert_eq!(
            normalize_updated_at("2026-09-05T23:21:02+00:00"),
            "2026-09-05T23:21:02Z"
        );
        assert_eq!(
            normalize_updated_at("2026-09-05T23:21:02.123456+00:00"),
            "2026-09-05T23:21:02Z"
        );
        // A real offset is APPLIED, not dropped — here it rolls the date over.
        assert_eq!(
            normalize_updated_at("2026-09-05T20:00:00-04:00"),
            "2026-09-06T00:00:00Z"
        );
        assert_eq!(
            normalize_updated_at("2026-09-06T02:30:00+05:30"),
            "2026-09-05T21:00:00Z"
        );
        // Garbage and absence ride through untouched.
        assert_eq!(normalize_updated_at("not a date"), "not a date");
        assert_eq!(normalize_updated_at(""), "");
        assert_eq!(normalize_updated_at("2026-09-05"), "2026-09-05");
    }

    #[test]
    fn merge_unions_in_leg_order_dedupes_by_url_and_sorts_newest_first() {
        let shared = "https://gitlab.com/g/p/-/merge_requests/300";
        let a = leg(vec![
            item(
                309,
                "https://gitlab.com/g/p/-/merge_requests/309",
                "2026-09-05T23:21:02Z",
            ),
            item(300, shared, "2026-09-04T15:30:38Z"),
        ]);
        let b = leg(vec![
            // The same MR from a second scope — first leg's copy wins.
            item(300, shared, "2026-09-04T15:30:38Z"),
            item(
                2,
                "https://gitlab.com/g/other/-/merge_requests/2",
                "2026-09-06T00:00:00Z",
            ),
        ]);
        let page = merge_legs(vec![a, b], MY_WORK_LIMIT);
        assert_eq!(page.items.len(), 3, "the shared URL should appear once");
        assert_eq!(
            page.items.iter().map(|i| i.number).collect::<Vec<_>>(),
            [2, 309, 300],
            "merged page must be newest-first ACROSS legs",
        );
        assert_eq!(page.items.iter().filter(|i| i.url == shared).count(), 1);
        assert!(!page.truncated, "a union under the cap is the whole inbox");
    }

    /// N legs, not two: the GitLab arm alone produces five per host.
    #[test]
    fn merge_generalizes_past_two_legs() {
        let legs: Vec<MyWorkLeg> = (0..5)
            .map(|i| {
                leg(vec![item(
                    i,
                    &format!("https://gitlab.com/g/p/-/issues/{i}"),
                    &format!("2026-09-0{}T00:00:00Z", i + 1),
                )])
            })
            .collect();
        let page = merge_legs(legs, MY_WORK_LIMIT);
        assert_eq!(
            page.items.iter().map(|i| i.number).collect::<Vec<_>>(),
            [4, 3, 2, 1, 0]
        );
        assert!(!page.truncated);
    }

    #[test]
    fn merge_truncates_an_over_limit_union_to_one_page() {
        let items: Vec<MyWorkItem> = (0..12)
            .map(|i| {
                item(
                    i,
                    &format!("https://gitlab.com/g/p/-/merge_requests/{i}"),
                    &format!("2026-09-05T00:{:02}:00Z", 59 - i),
                )
            })
            .collect();
        let page = merge_legs(vec![leg(items)], 10);
        assert_eq!(page.items.len(), 10);
        assert!(page.truncated, "an over-limit union must report truncation");
        // Truncation keeps the NEWEST page.
        assert_eq!(page.items[0].updated_at, "2026-09-05T00:59:00Z");
        assert!(page
            .items
            .windows(2)
            .all(|w| w[0].updated_at >= w[1].updated_at));
    }

    /// The arm the union's length can never see: a leg hit its cap, dropped items
    /// shrank it below the limit, and the page arrives short while items are still
    /// missing from the server.
    #[test]
    fn merge_reports_a_capped_leg_whose_page_arrives_short() {
        let short = MyWorkLeg {
            items: vec![item(
                1,
                "https://gitlab.com/g/p/-/issues/1",
                "2026-09-05T00:00:00Z",
            )],
            capped: true,
        };
        let page = merge_legs(vec![short], 10);
        assert_eq!(page.items.len(), 1);
        assert!(
            page.truncated,
            "a short page from a capped leg still hides items"
        );

        // Any leg's cap is a sole sufficient cause — the disjunction's later arms
        // must hold without the first.
        let capped_last = merge_legs(
            vec![
                leg(vec![item(
                    1,
                    "https://gitlab.com/g/p/-/issues/1",
                    "2026-09-05T00:00:00Z",
                )]),
                MyWorkLeg {
                    items: Vec::new(),
                    capped: true,
                },
            ],
            10,
        );
        assert!(capped_last.truncated);
        // Nothing capped and nothing over the limit → the whole inbox.
        assert!(!merge_legs(vec![leg(Vec::new())], 10).truncated);
        assert!(merge_legs(Vec::new(), 10).items.is_empty());
    }

    /// An unparseable timestamp must not claim the top of the page: it sorts with
    /// the absent ones, at the bottom.
    #[test]
    fn merge_sorts_unparseable_and_empty_timestamps_last() {
        let page = merge_legs(
            vec![leg(vec![
                // Lexically ABOVE any digit-leading timestamp, so a naive string
                // sort would float it to the top.
                item(1, "https://gitlab.com/g/p/-/issues/1", "yesterday"),
                item(2, "https://gitlab.com/g/p/-/issues/2", ""),
                item(
                    3,
                    "https://gitlab.com/g/p/-/issues/3",
                    "2026-09-01T00:00:00Z",
                ),
                item(
                    4,
                    "https://gitlab.com/g/p/-/issues/4",
                    "2026-09-05T00:00:00Z",
                ),
            ])],
            10,
        );
        assert_eq!(
            page.items.iter().map(|i| i.number).collect::<Vec<_>>(),
            [4, 3, 1, 2],
            "real timestamps first, then the unusable ones in leg order",
        );
    }
}
