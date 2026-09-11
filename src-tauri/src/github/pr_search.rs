//! Server-side filtered PR and issue lists, answered by a hand-rolled
//! `gh api graphql` search rather than `gh pr list --search`.
//!
//! The type matters: `gh`'s own `--search` posts `type: ISSUE_ADVANCED` only on
//! recent builds, and on the classic `ISSUE` type an `OR` across qualifiers returns
//! zero rows with no error — a silently wrong answer. Pinning `ISSUE_ADVANCED` in
//! the document here removes that failure mode for every gh version.
//!
//! Only the FILTERED path lives here; an empty filter never reaches this module and
//! the unfiltered lists keep their `gh pr list` / `gh issue list` reads.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::forge::model::RemoteListFilter;
use crate::github::gh_unreadable;
use crate::github::issue::IssueInfo;
use crate::github::pr::{PrAuthor, PrInfo, PrListLabel};
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

/// GraphQL caps a `search(first:)` page at 100.
const SEARCH_PAGE_MAX: u32 = 100;

/// How many `reviewed-by:@me` pages the review-state map reads before reporting
/// itself truncated. Three pages = 300 reviewed PRs within the filter's scope; past
/// that the grouping degrades honestly rather than paying an unbounded walk.
const REVIEW_STATE_MAX_PAGES: u32 = 3;

// ── The search string ────────────────────────────────────────────────────────

/// Characters that would break out of an author qualifier: whitespace splits the
/// qualifier, `:` starts another one, parens regroup the boolean expression, and
/// `"`/`\` escape the label quoting. Bot logins (`app/dependabot`,
/// `dependabot[bot]`) keep `/`, `[`, and `]`, which are inert inside a qualifier.
const AUTHOR_FORBIDDEN: &[char] = &['"', '\\', ':', '(', ')'];

/// Reject an author login that couldn't survive as one search token. Rejecting is
/// the whole guard: this value arrives from UI state and is executed under the
/// user's gh identity, so a value that can't be expressed is an error, never a
/// silently dropped axis.
fn validate_author(login: &str) -> AppResult<()> {
    if login.is_empty()
        || login.chars().any(char::is_whitespace)
        || login.contains(AUTHOR_FORBIDDEN)
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid author filter: {login:?}"
        )));
    }
    Ok(())
}

/// Labels ride the query quoted (`label:"needs triage"`), so spaces are fine but a
/// quote or backslash would escape the quoting. Reject rather than invent an
/// escaping GitHub's search grammar doesn't document.
fn validate_label(label: &str) -> AppResult<()> {
    if label.is_empty()
        || label.contains('"')
        || label.contains('\\')
        || label.chars().any(char::is_control)
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid label filter: {label:?}"
        )));
    }
    Ok(())
}

/// `team-review-requested:` takes exactly `org/slug`; GitHub allows letters,
/// digits, `.`, `_`, and `-` in each half.
fn validate_team(team: &str) -> AppResult<()> {
    fn segment_ok(s: &str) -> bool {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }
    let ok = team
        .split_once('/')
        .is_some_and(|(org, slug)| segment_ok(org) && segment_ok(slug));
    if !ok {
        return Err(AppError::InvalidArgument(format!(
            "invalid team filter: {team:?} (expected \"org/slug\")"
        )));
    }
    Ok(())
}

/// The `is:` qualifier for a list state, mirroring the legacy lists' semantics:
/// closed includes merged, matching GitHub's own Closed tab.
fn state_qualifier(is_pr: bool, state: &str) -> AppResult<&'static str> {
    match state {
        "open" => Ok("is:open"),
        "closed" => Ok("is:closed"),
        _ if is_pr => Err(AppError::InvalidArgument(format!(
            "unknown PR state filter: {state}"
        ))),
        _ => Err(AppError::InvalidArgument(format!(
            "unknown issue state filter: {state}"
        ))),
    }
}

/// The repo + kind + state scope every query in this module starts from.
/// `sort:created-desc` pins newest-first pagination, matching `gh pr list`'s order.
fn base_query(slug: &str, is_pr: bool, state: &str) -> AppResult<String> {
    let kind = if is_pr { "pr" } else { "issue" };
    Ok(format!(
        "repo:{slug} type:{kind} {} sort:created-desc",
        state_qualifier(is_pr, state)?
    ))
}

/// Build the GitHub search string for one filtered list page, or `None` when the
/// filter contributes no axis on this surface — callers then take their legacy
/// gh-list path unchanged.
///
/// Axes AND together; the values inside one axis OR together in an explicit paren
/// group. The viewer-centric legs (assigned to me, review requested of me, team
/// review requested) form ONE union group, so "assigned to me OR awaiting my
/// review" is a single server-side question.
///
/// The ISSUE surface applies `assigned_to_me`, `authors`, and `labels` only:
/// `review_requested_me` and `teams` describe review state, which issues don't
/// have. They are still VALIDATED there — an unusable value is an error on every
/// surface, never a quiet no-op.
///
/// Never emits `NOT`: negation is broken on `ISSUE_ADVANCED` (it returns zero rows),
/// and nothing in this filter set negates.
pub(crate) fn search_query(
    slug: &str,
    is_pr: bool,
    state: &str,
    filter: Option<&RemoteListFilter>,
) -> AppResult<Option<String>> {
    let Some(filter) = filter.filter(|f| !f.is_empty()) else {
        return Ok(None);
    };
    for team in &filter.teams {
        validate_team(team)?;
    }
    for author in &filter.authors {
        validate_author(author)?;
    }
    for label in &filter.labels {
        validate_label(label)?;
    }

    let mut mine: Vec<String> = Vec::new();
    if filter.assigned_to_me {
        mine.push("assignee:@me".to_string());
    }
    if is_pr {
        if filter.review_requested_me {
            mine.push("review-requested:@me".to_string());
        }
        mine.extend(
            filter
                .teams
                .iter()
                .map(|t| format!("team-review-requested:{t}")),
        );
    }
    let authors: Vec<String> = filter
        .authors
        .iter()
        .map(|a| format!("author:{a}"))
        .collect();
    // Explicit quoting, not `{:?}`: Debug would also escape control characters,
    // silently rewriting the label the user picked.
    let labels: Vec<String> = filter
        .labels
        .iter()
        .map(|l| format!("label:\"{l}\""))
        .collect();
    if mine.is_empty() && authors.is_empty() && labels.is_empty() {
        return Ok(None);
    }

    let mut q = base_query(slug, is_pr, state)?;
    for group in [mine, authors, labels] {
        if !group.is_empty() {
            q.push_str(&format!(" ({})", group.join(" OR ")));
        }
    }
    Ok(Some(q))
}

// ── The GraphQL documents ────────────────────────────────────────────────────
//
// The search string always rides the `$q` variable, never the document text: it
// carries user-supplied logins and labels, and a GraphQL document is not a place
// to interpolate those.

const PR_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number url title baseRefName headRefName isDraft state author{ login } labels(first:100){ nodes{ name } } createdAt isCrossRepository } } } }";

const ISSUE_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on Issue { number url title state author{ login } labels(first:100){ nodes{ name } } createdAt updatedAt } } } }";

const MERGEABILITY_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number mergeable state } } } }";

/// `reviews(author:)` rather than `latestReviews`: the latter mirrors the Reviewers
/// sidebar and omits the PR author plus drive-by reviewers who were never requested,
/// so a PR the viewer demonstrably reviewed can come back with no review at all.
/// `reviewed-by:@me` in the query and `reviews(author:)` in the selection are the
/// complete pair.
const REVIEW_STATE_QUERY: &str = "query($q:String!,$first:Int!,$after:String,$viewer:String!){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number updatedAt reviews(author:$viewer, last:1){ nodes{ submittedAt } } } } } }";

/// One page's argv. `$q`, `$after`, and `$viewer` ride `-f` (raw string): `-F`
/// coerces an all-digit or `true`/`false`/`null`-shaped value to a JSON non-string,
/// which a `String!` variable rejects, and `-f` also closes the leading-`@`
/// file-read magic `-F` carries. `$first` is the one field that must stay `-F` —
/// `Int!` needs the typed coercion, and it only ever formats to digits. Pure, so
/// the shape is pinned without a spawn.
fn search_args(
    document: &str,
    q: &str,
    page: u32,
    cursor: Option<&str>,
    viewer: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("q={q}"),
        "-F".to_string(),
        format!("first={page}"),
    ];
    if let Some(c) = cursor {
        args.push("-f".to_string());
        args.push(format!("after={c}"));
    }
    if let Some(v) = viewer {
        args.push("-f".to_string());
        args.push(format!("viewer={v}"));
    }
    args.push("-f".to_string());
    args.push(format!("query={document}"));
    args
}

/// Remap a schema rejection of `ISSUE_ADVANCED` into a sentence that names the cause.
/// An older GitHub Enterprise Server has no such `SearchType`, and GraphQL answers with
/// a validation error naming the enum — measured shape: `gh: Argument 'type' on Field
/// 'search' has an invalid value (…). Expected type 'SearchType!'.` — which tells the
/// user nothing about the control they just used. The enum NAME is the signal; every
/// other failure is left untouched.
fn map_advanced_search_unsupported(err: AppError) -> AppError {
    match &err {
        AppError::Gh(msg) if msg.contains("ISSUE_ADVANCED") => AppError::Gh(
            "This GitHub host doesn't support the advanced search that list filters need.\n\
             Its GraphQL schema has no ISSUE_ADVANCED search type (GitHub Enterprise Server \
             gains it in a later release); clear the filters to list unfiltered."
                .into(),
        ),
        _ => err,
    }
}

/// What the walk does after one page. `Stop` carries the `truncated` verdict the
/// review-state grouping reports, so the two are decided in one place.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// Fetch another page from `end_cursor`.
    Advance,
    /// Done; `truncated` = rows remain on the server that this walk won't return.
    Stop { truncated: bool },
}

/// The paginator's whole decision, pure so its arms are testable without a spawn.
///
/// Exhaustion always wins over the budgets: a walk that reached `target` on the LAST
/// page is complete, not truncated — reporting truncation there would make the
/// review-state grouping hedge on a map it fully answered.
fn advance(
    nodes_len: u32,
    pages: u32,
    has_next: bool,
    end_cursor: &str,
    got_nodes: bool,
    target: u32,
    max_pages: u32,
) -> Step {
    // An empty page or a cursor the server declined to move also ends the walk, so a
    // stuck cursor can't spin forever.
    if !has_next || end_cursor.is_empty() || !got_nodes {
        return Step::Stop { truncated: false };
    }
    if nodes_len >= target || pages >= max_pages {
        return Step::Stop { truncated: true };
    }
    Step::Advance
}

/// Walk the search connection until `target` nodes are collected, the server
/// reports no further page, or `max_pages` is spent. Returns the typed nodes plus
/// whether the walk stopped with more rows still on the server.
///
/// Runs through `run_gh(Some(repo_path), …)` so `GH_HOST` resolves from the repo's
/// own remote — what makes the call host-correct on Enterprise.
async fn search_nodes<T: serde::de::DeserializeOwned>(
    repo_path: &str,
    document: &str,
    q: &str,
    viewer: Option<&str>,
    target: u32,
    max_pages: u32,
    subject: &str,
) -> AppResult<(Vec<T>, bool)> {
    let mut nodes: Vec<T> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0u32;
    let truncated = loop {
        let remaining = target.saturating_sub(nodes.len() as u32);
        let page = remaining.min(SEARCH_PAGE_MAX);
        let args = search_args(document, q, page, cursor.as_deref(), viewer);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run_gh(Some(repo_path), &arg_refs, GH_NETWORK_TIMEOUT)
            .await
            .map_err(map_advanced_search_unsupported)?;
        let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| gh_unreadable(subject, format!("could not parse search: {e}")))?;
        // An absent connection is a SHAPE failure, never "nothing matched": defaulting
        // it to an empty page would present a broken read as an empty filter result,
        // the exact silent-narrowing class this module exists to remove.
        let search = value.pointer("/data/search").ok_or_else(|| {
            gh_unreadable(
                subject,
                "the search response carried no data.search connection".to_string(),
            )
        })?;
        // A parse failure propagates rather than yielding a silently short list.
        let page_nodes: Vec<Option<T>> = search
            .get("nodes")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| gh_unreadable(subject, format!("could not parse search: {e}")))?
            .unwrap_or_default();
        let got_nodes = !page_nodes.is_empty();
        nodes.extend(page_nodes.into_iter().flatten());
        pages += 1;

        let has_next = search
            .pointer("/pageInfo/hasNextPage")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let end_cursor = search
            .pointer("/pageInfo/endCursor")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        match advance(
            nodes.len() as u32,
            pages,
            has_next,
            end_cursor,
            got_nodes,
            target,
            max_pages,
        ) {
            Step::Stop { truncated } => break truncated,
            Step::Advance => cursor = Some(end_cursor.to_string()),
        }
    };
    Ok((nodes, truncated))
}

// ── Raw parse trees ──────────────────────────────────────────────────────────
//
// Connection layers are doubly nullable (`nodes: [T]` — the list and each element),
// and a `... on X` fragment over a node of another type yields an empty object, so
// every node's identity field is an `Option` and a node without one is dropped.

#[derive(Deserialize)]
struct RawLabelName {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct RawLabels {
    #[serde(default)]
    nodes: Vec<Option<RawLabelName>>,
}

impl RawLabels {
    fn into_list(self) -> Vec<PrListLabel> {
        self.nodes
            .into_iter()
            .flatten()
            .map(|l| PrListLabel { name: l.name })
            .collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPrSearchNode {
    number: Option<u64>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    state: String,
    #[serde(default)]
    author: Option<PrAuthor>,
    #[serde(default)]
    labels: RawLabels,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    is_cross_repository: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssueSearchNode {
    number: Option<u64>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    author: Option<PrAuthor>,
    #[serde(default)]
    labels: RawLabels,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMergeabilityNode {
    number: Option<u64>,
    /// `MergeableState` is nullable on the search connection, and an absent value
    /// must read as "still computing", never as mergeable.
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSubmittedAt {
    #[serde(default)]
    submitted_at: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawReviewNodes {
    #[serde(default)]
    nodes: Vec<Option<RawSubmittedAt>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReviewStateNode {
    number: Option<u64>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    reviews: RawReviewNodes,
}

// ── The filtered reads ───────────────────────────────────────────────────────

/// gh's own list range, mirrored so a filtered list and an unfiltered one page to
/// the same depth.
fn target_rows(limit: Option<u32>) -> u32 {
    limit.unwrap_or(30).clamp(1, 1000)
}

/// The filtered PR page, newest-created first. Stack membership is NOT joined here
/// — the caller owns that, so the filtered and unfiltered lists decorate rows the
/// same way.
pub(crate) async fn filtered_pr_list(
    repo_path: &str,
    q: &str,
    limit: Option<u32>,
) -> AppResult<Vec<PrInfo>> {
    let (nodes, _) = search_nodes::<RawPrSearchNode>(
        repo_path,
        PR_SEARCH_QUERY,
        q,
        None,
        target_rows(limit),
        u32::MAX,
        "pull requests",
    )
    .await?;
    Ok(nodes
        .into_iter()
        .filter_map(|n| {
            Some(PrInfo {
                number: n.number?,
                url: n.url,
                title: n.title,
                base_ref_name: n.base_ref_name,
                head_ref_name: n.head_ref_name,
                is_draft: n.is_draft,
                state: n.state,
                author: n.author,
                labels: n.labels.into_list(),
                created_at: n.created_at,
                head_sha: String::new(),
                stack: None,
                stack_unknown: false,
                cross_repository: n.is_cross_repository,
            })
        })
        .collect())
}

/// The filtered issue page, newest-created first.
pub(crate) async fn filtered_issue_list(
    repo_path: &str,
    q: &str,
    limit: Option<u32>,
) -> AppResult<Vec<IssueInfo>> {
    let (nodes, _) = search_nodes::<RawIssueSearchNode>(
        repo_path,
        ISSUE_SEARCH_QUERY,
        q,
        None,
        target_rows(limit),
        u32::MAX,
        "issues",
    )
    .await?;
    Ok(nodes
        .into_iter()
        .filter_map(|n| {
            Some(IssueInfo {
                number: n.number?,
                url: n.url,
                title: n.title,
                state: n.state,
                created_at: n.created_at,
                updated_at: n.updated_at,
                author: n.author,
                labels: n.labels.into_list(),
            })
        })
        .collect())
}

/// Mergeability for a FILTERED PR page, keyed by number. It re-runs the same search
/// rather than re-reading the unfiltered list: the unfiltered page's first rows can
/// miss the filtered rows entirely, so the map would come back empty for exactly
/// the PRs on screen.
pub(crate) async fn filtered_mergeability(
    repo_path: &str,
    q: &str,
    limit: Option<u32>,
) -> AppResult<HashMap<u64, String>> {
    let (nodes, _) = search_nodes::<RawMergeabilityNode>(
        repo_path,
        MERGEABILITY_SEARCH_QUERY,
        q,
        None,
        target_rows(limit),
        u32::MAX,
        "pull requests",
    )
    .await?;
    Ok(nodes
        .into_iter()
        .filter_map(|n| {
            let number = n.number?;
            let mergeable = n.mergeable.unwrap_or_default();
            Some((
                number,
                crate::github::pr::map_gh_mergeability(&n.state, &mergeable, "").state,
            ))
        })
        .collect())
}

/// The viewer's own review state for one PR, as the grouping reads it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStateEntry {
    /// ISO-8601 `submittedAt` of the viewer's most recent review.
    pub last_reviewed_at: String,
    /// The PR's `updatedAt` at query time — compared against `last_reviewed_at` to
    /// separate "reviewed" from "updated since my review".
    pub updated_at: String,
}

/// The viewer's review state across a filtered PR page.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReviewStatePage {
    /// PR number → the viewer's review state. A number ABSENT from the map means the
    /// viewer has not reviewed that PR; subtracting the map from the list is the
    /// caller's job.
    pub entries: HashMap<u64, ReviewStateEntry>,
    /// The reviewed-by walk stopped with more rows on the server, so an absent
    /// number may still have been reviewed.
    pub truncated: bool,
}

impl ReviewStatePage {
    /// Nothing to say — a non-open list, or a provider with no reviewed-by search.
    pub fn empty() -> Self {
        ReviewStatePage {
            entries: HashMap::new(),
            truncated: false,
        }
    }
}

/// The viewer's review state across the PR list the same `state` + `filter` would
/// produce. The grouping is available with or without a filter, so an empty filter
/// scopes to the whole list rather than short-circuiting.
pub async fn gh_pr_review_state(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
    lens: Option<&str>,
    filter: Option<&RemoteListFilter>,
) -> AppResult<ReviewStatePage> {
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let scope = match search_query(&slug, true, state, filter)? {
        Some(q) => q,
        None => base_query(&slug, true, state)?,
    };
    review_state(repo_path, &scope, limit).await
}

/// The viewer's review state for the PRs in `scope_query`'s result set. `scope_query`
/// is the SAME search string the list ran, narrowed by ` reviewed-by:@me`, so the map
/// describes exactly the rows on screen.
async fn review_state(
    repo_path: &str,
    scope_query: &str,
    limit: Option<u32>,
) -> AppResult<ReviewStatePage> {
    let viewer = run_gh(
        Some(repo_path),
        &["api", "user", "-q", ".login"],
        GH_NETWORK_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    if viewer.is_empty() {
        return Err(AppError::Gh(
            "could not determine the signed-in GitHub user".into(),
        ));
    }
    let q = format!("{scope_query} reviewed-by:@me");
    let target = target_rows(limit).max(SEARCH_PAGE_MAX * REVIEW_STATE_MAX_PAGES);
    let (nodes, truncated) = search_nodes::<RawReviewStateNode>(
        repo_path,
        REVIEW_STATE_QUERY,
        &q,
        Some(&viewer),
        target,
        REVIEW_STATE_MAX_PAGES,
        "pull requests",
    )
    .await?;
    let entries = nodes
        .into_iter()
        .filter_map(|n| {
            let number = n.number?;
            // Inside `reviewed-by:` scope every node should carry a review; one that
            // doesn't is SKIPPED rather than defaulted, so a missing timestamp can't
            // pose as a review submitted at the epoch.
            let last_reviewed_at = n
                .reviews
                .nodes
                .into_iter()
                .flatten()
                .find_map(|r| r.submitted_at)
                .filter(|s| !s.is_empty())?;
            Some((
                number,
                ReviewStateEntry {
                    last_reviewed_at,
                    updated_at: n.updated_at,
                },
            ))
        })
        .collect();
    Ok(ReviewStatePage { entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::{
        advance, map_advanced_search_unsupported, search_args, search_query, ReviewStateEntry,
        ReviewStatePage, Step, ISSUE_SEARCH_QUERY, MERGEABILITY_SEARCH_QUERY, PR_SEARCH_QUERY,
        REVIEW_STATE_QUERY,
    };
    use crate::error::AppError;
    use crate::forge::model::RemoteListFilter;

    fn filter_of(
        assigned_to_me: bool,
        review_requested_me: bool,
        teams: &[&str],
        authors: &[&str],
        labels: &[&str],
    ) -> RemoteListFilter {
        let own = |v: &[&str]| v.iter().map(|s| (*s).to_string()).collect();
        RemoteListFilter {
            assigned_to_me,
            review_requested_me,
            teams: own(teams),
            authors: own(authors),
            labels: own(labels),
        }
    }

    fn q(filter: &RemoteListFilter, is_pr: bool, state: &str) -> String {
        search_query("octo/hello", is_pr, state, Some(filter))
            .expect("valid filter")
            .expect("non-empty filter yields a query")
    }

    fn err(filter: &RemoteListFilter) -> String {
        match search_query("octo/hello", true, "open", Some(filter)) {
            Err(AppError::InvalidArgument(msg)) => msg,
            Err(e) => panic!("expected InvalidArgument, got {e:?}"),
            Ok(q) => panic!("expected a rejection, got {q:?}"),
        }
    }

    #[test]
    fn an_empty_or_absent_filter_keeps_the_legacy_path() {
        assert!(search_query("octo/hello", true, "open", None)
            .unwrap()
            .is_none());
        assert!(search_query(
            "octo/hello",
            true,
            "open",
            Some(&RemoteListFilter::default())
        )
        .unwrap()
        .is_none());
        // Review-only axes contribute nothing on the ISSUE surface, so that list
        // stays on its legacy read instead of paying for an unnarrowed search.
        let review_only = filter_of(false, true, &["octo/reviewers"], &[], &[]);
        assert!(
            search_query("octo/hello", false, "open", Some(&review_only))
                .unwrap()
                .is_none()
        );
        assert!(search_query("octo/hello", true, "open", Some(&review_only))
            .unwrap()
            .is_some());
    }

    #[test]
    fn the_mine_axes_form_one_or_group() {
        let f = filter_of(true, true, &["octo/reviewers", "octo/docs"], &[], &[]);
        assert_eq!(
            q(&f, true, "open"),
            "repo:octo/hello type:pr is:open sort:created-desc \
             (assignee:@me OR review-requested:@me OR team-review-requested:octo/reviewers \
             OR team-review-requested:octo/docs)"
        );
        // One leg alone still gets its parens, so the shape never varies by arity.
        let one = filter_of(true, false, &[], &[], &[]);
        assert_eq!(
            q(&one, true, "open"),
            "repo:octo/hello type:pr is:open sort:created-desc (assignee:@me)"
        );
    }

    #[test]
    fn axes_and_together_and_values_or_within_an_axis() {
        let f = filter_of(
            true,
            false,
            &[],
            &["octocat", "dependabot[bot]"],
            &["bug", "needs triage"],
        );
        assert_eq!(
            q(&f, true, "closed"),
            "repo:octo/hello type:pr is:closed sort:created-desc (assignee:@me) \
             (author:octocat OR author:dependabot[bot]) \
             (label:\"bug\" OR label:\"needs triage\")"
        );
    }

    #[test]
    fn the_issue_surface_drops_the_review_axes() {
        let f = filter_of(true, true, &["octo/reviewers"], &["octocat"], &["bug"]);
        assert_eq!(
            q(&f, false, "open"),
            "repo:octo/hello type:issue is:open sort:created-desc (assignee:@me) \
             (author:octocat) (label:\"bug\")"
        );
    }

    /// `NOT` returns zero rows on `ISSUE_ADVANCED`, so the builder must never be able
    /// to emit it — a silently empty list is the failure this pins shut.
    #[test]
    fn the_builder_never_emits_a_negation() {
        for is_pr in [true, false] {
            for state in ["open", "closed"] {
                let f = filter_of(
                    true,
                    true,
                    &["octo/reviewers"],
                    &["octocat", "dependabot[bot]"],
                    &["bug", "wont fix"],
                );
                let query = q(&f, is_pr, state);
                assert!(
                    !query.split_whitespace().any(|t| t == "NOT"),
                    "query must not negate: {query}"
                );
                // The other negation spelling is a leading `-` on a qualifier.
                assert!(
                    !query
                        .split_whitespace()
                        .any(|t| t.starts_with('-') || t.starts_with("(-")),
                    "query must not negate: {query}"
                );
            }
        }
    }

    #[test]
    fn an_unknown_state_is_rejected_like_the_legacy_lists() {
        let f = filter_of(true, false, &[], &[], &[]);
        assert!(matches!(
            search_query("octo/hello", true, "merged", Some(&f)),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            search_query("octo/hello", false, "all", Some(&f)),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn bot_logins_pass_and_breakout_authors_are_rejected() {
        // Bot logins keep `/`, `[`, `]` — all inert inside a qualifier.
        for ok in ["app/dependabot", "dependabot[bot]", "octo-cat", "a.b_c"] {
            let f = filter_of(false, false, &[], &[ok], &[]);
            assert!(
                q(&f, true, "open").contains(&format!("author:{ok}")),
                "{ok} should pass"
            );
        }
        for bad in [
            "octo cat",
            "octo\tcat",
            "octo:cat",
            "octo(cat",
            "octo)cat",
            "octo\"cat",
            "octo\\cat",
            "",
        ] {
            let f = filter_of(false, false, &[], &[bad], &[]);
            assert!(err(&f).starts_with("invalid author filter"), "{bad:?}");
        }
    }

    #[test]
    fn labels_are_quoted_and_quote_breakouts_are_rejected() {
        let f = filter_of(false, false, &[], &[], &["needs triage"]);
        assert!(q(&f, true, "open").contains("(label:\"needs triage\")"));
        for bad in ["say \"hi\"", "back\\slash", ""] {
            let f = filter_of(false, false, &[], &[], &[bad]);
            assert!(err(&f).starts_with("invalid label filter"), "{bad:?}");
        }
    }

    #[test]
    fn teams_must_be_org_qualified() {
        for ok in ["octo/reviewers", "my-org/a.b_c", "o1/t2"] {
            let f = filter_of(false, false, &[ok], &[], &[]);
            assert!(q(&f, true, "open").contains(&format!("team-review-requested:{ok}")));
        }
        for bad in [
            "reviewers",
            "octo/",
            "/reviewers",
            "octo/rev iewers",
            "octo/rev/iewers",
            "octo/rev:iewers",
            "",
        ] {
            let f = filter_of(false, false, &[bad], &[], &[]);
            assert!(err(&f).starts_with("invalid team filter"), "{bad:?}");
        }
        // Validated even where they're unused: an unusable value is never a quiet
        // no-op, on any surface.
        let f = filter_of(true, false, &["reviewers"], &[], &[]);
        assert!(matches!(
            search_query("octo/hello", false, "open", Some(&f)),
            Err(AppError::InvalidArgument(_))
        ));
    }

    /// The type is the whole point of hand-rolling these documents: classic `ISSUE`
    /// silently returns zero rows for an OR across qualifiers.
    #[test]
    fn every_document_pins_the_advanced_search_type() {
        for doc in [
            PR_SEARCH_QUERY,
            ISSUE_SEARCH_QUERY,
            MERGEABILITY_SEARCH_QUERY,
            REVIEW_STATE_QUERY,
        ] {
            assert!(doc.contains("type: ISSUE_ADVANCED"), "{doc}");
            // The search string is a variable, never document text.
            assert!(doc.contains("query:$q"), "{doc}");
        }
        // The review-state selection reads the viewer's OWN reviews, not the
        // sidebar-shaped `latestReviews`.
        assert!(REVIEW_STATE_QUERY.contains("reviews(author:$viewer, last:1)"));
        assert!(!REVIEW_STATE_QUERY.contains("latestReviews"));
    }

    #[test]
    fn the_search_string_rides_a_variable_and_first_rides_the_typed_flag() {
        let args = search_args(PR_SEARCH_QUERY, "repo:octo/hello type:pr", 100, None, None);
        let pos = |v: &str| args.iter().position(|a| a == v).expect("present");
        assert_eq!(args[pos("q=repo:octo/hello type:pr") - 1], "-f");
        assert_eq!(args[pos("first=100") - 1], "-F");
        // Cursor and viewer are omitted entirely when absent (a missing GraphQL
        // variable is null, which is the first page / no author filter).
        assert!(!args.iter().any(|a| a.starts_with("after=")));
        assert!(!args.iter().any(|a| a.starts_with("viewer=")));
        let paged = search_args(
            REVIEW_STATE_QUERY,
            "repo:octo/hello type:pr",
            100,
            Some("Y3Vyc29yOjI="),
            Some("octocat"),
        );
        let pos = |v: &str| paged.iter().position(|a| a == v).expect("present");
        assert_eq!(paged[pos("after=Y3Vyc29yOjI=") - 1], "-f");
        assert_eq!(paged[pos("viewer=octocat") - 1], "-f");
    }

    /// The paginator's arms, decided by one pure fn: `target`/`max_pages` are budgets,
    /// and only a budget stop with rows left on the server counts as truncated.
    #[test]
    fn the_paginator_advances_stops_and_reports_truncation() {
        // Normal advance: room left, server has more, cursor moved.
        assert_eq!(
            advance(100, 1, true, "cur", true, 300, 3),
            Step::Advance,
            "under both budgets with another page waiting"
        );
        // Target reached with more on the server — a genuine truncation.
        assert_eq!(
            advance(300, 3, true, "cur", true, 300, 10),
            Step::Stop { truncated: true }
        );
        // Page budget spent before the row budget — also truncated.
        assert_eq!(
            advance(150, 3, true, "cur", true, 300, 3),
            Step::Stop { truncated: true }
        );
        // Exhaustion beats the budgets: `hasNextPage: false` is COMPLETE even when the
        // walk happens to have filled `target` on that same page.
        assert_eq!(
            advance(300, 3, false, "cur", true, 300, 3),
            Step::Stop { truncated: false }
        );
        assert_eq!(
            advance(42, 1, false, "cur", true, 300, 3),
            Step::Stop { truncated: false }
        );
        // An empty page ends the walk rather than paging forever on a server that
        // keeps promising more.
        assert_eq!(
            advance(100, 1, true, "cur", false, 300, 3),
            Step::Stop { truncated: false }
        );
        // A cursor the server declined to move is the other stuck-walk shape.
        assert_eq!(
            advance(100, 1, true, "", true, 300, 3),
            Step::Stop { truncated: false }
        );
        // The list reads pass `max_pages: u32::MAX`, so only `target` can stop them.
        assert_eq!(
            advance(30, 1, true, "cur", true, 30, u32::MAX),
            Step::Stop { truncated: true }
        );
        assert_eq!(
            advance(29, 1, true, "cur", true, 30, u32::MAX),
            Step::Advance
        );
    }

    /// An older GitHub Enterprise Server schema has no `ISSUE_ADVANCED`; the raw
    /// GraphQL validation error names a type, not the control the user touched.
    #[test]
    fn a_schema_rejection_of_the_advanced_type_is_remapped_to_a_readable_error() {
        // Both the wording GitHub actually emits (measured against a bad enum value)
        // and the shorter validation phrasing carry the enum NAME, which is the signal.
        for raw in [
            "gh: Argument 'type' on Field 'search' has an invalid value (ISSUE_ADVANCED). \
             Expected type 'SearchType!'.",
            "GraphQL: Expected type SearchType, found ISSUE_ADVANCED. (search)",
        ] {
            let mapped = map_advanced_search_unsupported(AppError::Gh(raw.to_string())).to_string();
            let mut lines = mapped.lines();
            // Line 1 is what the toast and banner summarize; line 2 rides the Details
            // dialog (the two-line contract `gh_unreadable` also follows).
            assert_eq!(
                lines.next(),
                Some(
                    "This GitHub host doesn't support the advanced search that list filters need."
                )
            );
            assert!(lines.next().is_some_and(|l| l.contains("ISSUE_ADVANCED")));
        }
        // Every other failure rides through untouched — no swallowing a real error
        // behind a host-capability story.
        for other in [
            "HTTP 401: Bad credentials",
            "dial tcp: lookup api.github.com: no such host",
            "GraphQL: Could not resolve to a Repository with the name 'octo/nope'.",
        ] {
            assert_eq!(
                map_advanced_search_unsupported(AppError::Gh(other.to_string())).to_string(),
                other
            );
        }
        // A non-Gh variant is never rewritten either.
        assert!(matches!(
            map_advanced_search_unsupported(AppError::InvalidArgument("ISSUE_ADVANCED".into())),
            AppError::InvalidArgument(_)
        ));
    }

    #[test]
    fn the_review_state_page_serializes_to_the_camel_case_wire_shape() {
        let mut page = ReviewStatePage::empty();
        page.entries.insert(
            332,
            ReviewStateEntry {
                last_reviewed_at: "2026-09-11T00:15:16Z".to_string(),
                updated_at: "2026-09-11T00:26:19Z".to_string(),
            },
        );
        let wire = serde_json::to_value(&page).expect("ReviewStatePage serializes");
        assert_eq!(
            wire,
            serde_json::json!({
                "entries": {
                    "332": {
                        "lastReviewedAt": "2026-09-11T00:15:16Z",
                        "updatedAt": "2026-09-11T00:26:19Z",
                    }
                },
                "truncated": false,
            })
        );
        let empty = serde_json::to_value(ReviewStatePage::empty()).expect("serializes");
        assert_eq!(
            empty,
            serde_json::json!({"entries": {}, "truncated": false})
        );
    }
}

#[cfg(test)]
mod parse_tests {
    use super::{RawIssueSearchNode, RawMergeabilityNode, RawPrSearchNode, RawReviewStateNode};

    /// Captured verbatim from `gh api graphql` against `repo:theBGuy/GitDesktop
    /// type:pr is:closed sort:created-desc` — the shape the parse tree must survive.
    const PR_SEARCH_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjI="},"nodes":[{"number":336,"url":"https://github.com/theBGuy/GitDesktop/pull/336","title":"fix(agent): heap-allocate the capture read buffers","baseRefName":"master","headRefName":"fix/agent-capture-heap-buffers","isDraft":false,"state":"MERGED","author":{"login":"theBGuy"},"labels":{"nodes":[{"name":"bug"},{"name":"no-changelog"}]},"createdAt":"2026-09-10T23:20:15Z","isCrossRepository":false},{"number":335,"url":"https://github.com/theBGuy/GitDesktop/pull/335","title":"fix(about,health): spawn tool probes off the command future","baseRefName":"master","headRefName":"fix/about-health-stack-overflow","isDraft":false,"state":"MERGED","author":{"login":"theBGuy"},"labels":{"nodes":[{"name":"bug"}]},"createdAt":"2026-09-10T18:19:41Z","isCrossRepository":false}]}}}"#;

    const ISSUE_SEARCH_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjI="},"nodes":[{"number":334,"url":"https://github.com/theBGuy/GitDesktop/issues/334","title":"bug: GitDesktop is crashing at menu Settings / About on Windows","state":"OPEN","author":{"login":"batagy"},"labels":{"nodes":[{"name":"bug"}]},"createdAt":"2026-09-10T11:32:52Z","updatedAt":"2026-09-10T22:06:34Z"},{"number":333,"url":"https://github.com/theBGuy/GitDesktop/issues/333","title":"feat: Make zooming possible in GUI","state":"OPEN","author":{"login":"batagy"},"labels":{"nodes":[{"name":"enhancement"}]},"createdAt":"2026-09-10T11:20:42Z","updatedAt":"2026-09-10T11:20:42Z"}]}}}"#;

    const MERGEABILITY_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":false,"endCursor":"Y3Vyc29yOjM="},"nodes":[{"number":332,"mergeable":"MERGEABLE","state":"OPEN"},{"number":325,"mergeable":"MERGEABLE","state":"OPEN"},{"number":237,"mergeable":"MERGEABLE","state":"OPEN"}]}}}"#;

    const REVIEW_STATE_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjM="},"nodes":[{"number":335,"updatedAt":"2026-09-10T20:34:22Z","reviews":{"nodes":[{"submittedAt":"2026-09-10T19:47:35Z"}]}},{"number":332,"updatedAt":"2026-09-11T00:26:19Z","reviews":{"nodes":[{"submittedAt":"2026-09-11T00:15:16Z"}]}}]}}}"#;

    fn nodes<T: serde::de::DeserializeOwned>(fixture: &str) -> Vec<Option<T>> {
        let v: serde_json::Value = serde_json::from_str(fixture).expect("fixture is JSON");
        serde_json::from_value(v.pointer("/data/search/nodes").cloned().expect("nodes"))
            .expect("nodes parse")
    }

    #[test]
    fn a_real_pr_search_page_parses() {
        let parsed: Vec<Option<RawPrSearchNode>> = nodes(PR_SEARCH_FIXTURE);
        let rows: Vec<RawPrSearchNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].number, Some(336));
        assert_eq!(rows[0].base_ref_name, "master");
        assert_eq!(rows[0].head_ref_name, "fix/agent-capture-heap-buffers");
        assert_eq!(rows[0].state, "MERGED");
        assert!(!rows[0].is_draft && !rows[0].is_cross_repository);
        assert_eq!(
            rows[0].author.as_ref().map(|a| a.login.as_str()),
            Some("theBGuy")
        );
        let labels: Vec<String> = rows[0]
            .labels
            .nodes
            .iter()
            .filter_map(|l| l.as_ref().map(|l| l.name.clone()))
            .collect();
        assert_eq!(labels, ["bug", "no-changelog"]);
        assert_eq!(rows[0].created_at, "2026-09-10T23:20:15Z");
    }

    #[test]
    fn a_real_issue_search_page_parses() {
        let parsed: Vec<Option<RawIssueSearchNode>> = nodes(ISSUE_SEARCH_FIXTURE);
        let rows: Vec<RawIssueSearchNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].number, Some(334));
        assert_eq!(rows[0].state, "OPEN");
        assert_eq!(rows[0].updated_at, "2026-09-10T22:06:34Z");
        assert_eq!(rows[1].number, Some(333));
    }

    #[test]
    fn a_real_mergeability_page_parses() {
        let parsed: Vec<Option<RawMergeabilityNode>> = nodes(MERGEABILITY_FIXTURE);
        let rows: Vec<RawMergeabilityNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].number, Some(332));
        assert_eq!(rows[0].mergeable.as_deref(), Some("MERGEABLE"));
        assert_eq!(rows[0].state, "OPEN");
    }

    #[test]
    fn a_real_review_state_page_parses() {
        let parsed: Vec<Option<RawReviewStateNode>> = nodes(REVIEW_STATE_FIXTURE);
        let rows: Vec<RawReviewStateNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].number, Some(335));
        assert_eq!(rows[0].updated_at, "2026-09-10T20:34:22Z");
        assert_eq!(
            rows[0]
                .reviews
                .nodes
                .first()
                .and_then(|r| r.as_ref())
                .and_then(|r| r.submitted_at.as_deref()),
            Some("2026-09-10T19:47:35Z")
        );
    }

    /// A node of another type answers a `... on PullRequest` fragment with `{}`, and
    /// a connection's elements are nullable — neither may become a row numbered 0.
    #[test]
    fn typeless_and_null_nodes_drop_rather_than_becoming_row_zero() {
        let parsed: Vec<Option<RawPrSearchNode>> =
            nodes(r#"{"data":{"search":{"nodes":[{},null,{"number":7}]}}}"#);
        let numbered: Vec<u64> = parsed
            .into_iter()
            .flatten()
            .filter_map(|n| n.number)
            .collect();
        assert_eq!(numbered, [7]);
        // A null review connection and a review with no timestamp both survive the
        // parse (the caller skips them).
        let reviews: Vec<Option<RawReviewStateNode>> = nodes(
            r#"{"data":{"search":{"nodes":[{"number":9,"updatedAt":"2026-01-01T00:00:00Z","reviews":{"nodes":[]}},{"number":10,"updatedAt":"2026-01-01T00:00:00Z","reviews":{"nodes":[{"submittedAt":null}]}}]}}}"#,
        );
        let rows: Vec<RawReviewStateNode> = reviews.into_iter().flatten().collect();
        assert!(rows[0].reviews.nodes.is_empty());
        assert!(rows[1].reviews.nodes[0]
            .as_ref()
            .is_some_and(|r| r.submitted_at.is_none()));
    }
}
