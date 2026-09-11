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
use crate::forge::gitlab::null_to_default;
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

// `author{ login __typename }`, not `author{ login }`: GraphQL returns a GitHub App's
// BARE login (`dependabot`) where `gh pr list --json author` returns the `app/`-prefixed
// form (`app/dependabot`) that gh's export layer adds for Bot actors. `__typename` is
// what lets the mapping restore that prefix — see [`RawSearchAuthor::into_author`].
const PR_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number url title baseRefName headRefName isDraft state author{ login __typename } labels(first:100){ nodes{ name } } createdAt isCrossRepository } } } }";

const ISSUE_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on Issue { number url title state author{ login __typename } labels(first:100){ nodes{ name } } createdAt updatedAt } } } }";

const MERGEABILITY_SEARCH_QUERY: &str = "query($q:String!,$first:Int!,$after:String){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number mergeable state } } } }";

/// `reviews(author:)` rather than `latestReviews`: the latter mirrors the Reviewers
/// sidebar and omits the PR author plus drive-by reviewers who were never requested,
/// so a PR the viewer demonstrably reviewed can come back with no review at all.
/// `reviewed-by:@me` in the query and `reviews(author:)` in the selection are the
/// complete pair.
///
/// `states:` excludes PENDING, and its four members are the whole rest of
/// `PullRequestReviewState` (verified by introspection). A PENDING review is one the
/// viewer STARTED and never submitted — not yet a review — and it carries a null
/// `submittedAt`; since `last: 1` takes the most RECENT review, an unsubmitted draft
/// would otherwise displace the submitted one the grouping needs, and the null
/// timestamp would then read as "not reviewed". This app's own pending-review
/// workflow makes that state common.
const REVIEW_STATE_QUERY: &str = "query($q:String!,$first:Int!,$after:String,$viewer:String!){ search(query:$q, type: ISSUE_ADVANCED, first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on PullRequest { number updatedAt reviews(author:$viewer, states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED], last:1){ nodes{ submittedAt } } } } } }";

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
/// Each stop reason owns its own `truncated` verdict — the three are NOT
/// interchangeable, and conflating them is how a short read poses as a complete one.
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
    // A page that made NO progress — no rows, or a cursor the server declined to move —
    // stops defensively so a stuck walk can't spin forever. Its verdict is the server's
    // own claim: rows we never read may still exist exactly when another page was
    // promised, and calling that complete would be the short read posing as the answer.
    if end_cursor.is_empty() || !got_nodes {
        return Step::Stop {
            truncated: has_next,
        };
    }
    // The server itself says there is nothing after this page.
    if !has_next {
        return Step::Stop { truncated: false };
    }
    // A budget we chose: rows remain on the server by construction.
    if nodes_len >= target || pages >= max_pages {
        return Step::Stop { truncated: true };
    }
    Step::Advance
}

/// One page's nodes out of a `search` connection. `nodes` is nullable, and GraphQL may
/// spell an empty result set as an explicit `null` rather than omit the key or send
/// `[]` — all three are the same empty page, and rejecting the null would fail a read
/// the server answered. A list that IS present but unparseable still errors: that's a
/// shape failure, never a silently short page. Pure, so both arms test without a spawn.
fn parse_page_nodes<T: serde::de::DeserializeOwned>(
    search: &serde_json::Value,
) -> Result<Vec<Option<T>>, serde_json::Error> {
    search
        .get("nodes")
        .filter(|v| !v.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map(Option::unwrap_or_default)
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
        let page_nodes: Vec<Option<T>> = parse_page_nodes(search)
            .map_err(|e| gh_unreadable(subject, format!("could not parse search: {e}")))?;
        // An empty page — including a null `nodes` — ends the walk in `advance` so a
        // server promising another page while returning no rows can't spin it, and is
        // reported TRUNCATED when that promise stands, never as a complete read.
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
// Connection layers are independently nullable at three levels — the connection
// object, its `nodes` list, and each element — and a nullable field can arrive as an
// explicit `null` rather than an absent key, which `#[serde(default)]` alone rejects;
// every such layer takes `null_to_default` so one sparse node can't fail the page.
// A `... on X` fragment over a node of another type yields an empty object, so every
// node's identity field is an `Option` and a node without one is dropped.

/// A search node's author, carrying the actor TYPE alongside the login.
///
/// GraphQL and the gh CLI disagree on how a GitHub App author is spelled: GraphQL
/// answers `dependabot`, `gh pr list --json author` answers `app/dependabot` (its
/// export layer prefixes Bot-typed actors). Both shapes reach the same frontend, so
/// the filtered list has to speak the CLI's — `displayLogin` only recognizes
/// `app/<name>` / `<name>[bot]` as a bot, and a bare login would render a bot as an
/// ordinary user AND round-trip into an author qualifier that silently matches
/// nothing (`author:dependabot` → 0 hits; `author:app/dependabot` → 64, measured).
#[derive(Deserialize)]
struct RawSearchAuthor {
    #[serde(default)]
    login: String,
    /// Actor type. Only `Bot` takes the prefix — a `User`, `Organization`, or
    /// `Mannequin` login is already spelled the way the CLI spells it.
    #[serde(default, rename = "__typename")]
    typename: String,
}

impl RawSearchAuthor {
    fn into_author(self) -> PrAuthor {
        // Idempotent: GraphQL never sends the prefix today, so re-prefixing an
        // already-prefixed login would be a silent `app/app/x` if that ever changes.
        // An empty login passes through untouched — absence is the `Option` around
        // this struct, never a synthesized name.
        let login = if self.typename == "Bot"
            && !self.login.is_empty()
            && !self.login.starts_with("app/")
        {
            format!("app/{}", self.login)
        } else {
            self.login
        };
        PrAuthor { login }
    }
}

#[derive(Deserialize)]
struct RawLabelName {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct RawLabels {
    #[serde(default, deserialize_with = "null_to_default")]
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
    author: Option<RawSearchAuthor>,
    #[serde(default, deserialize_with = "null_to_default")]
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
    author: Option<RawSearchAuthor>,
    #[serde(default, deserialize_with = "null_to_default")]
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
    /// `Option` despite the schema marking this `MergeableState!` — deliberate
    /// over-tolerance against schema drift and GHES variants. An absent or
    /// unrecognized value must read as "still computing", never as mergeable.
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
    #[serde(default, deserialize_with = "null_to_default")]
    nodes: Vec<Option<RawSubmittedAt>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReviewStateNode {
    number: Option<u64>,
    #[serde(default)]
    updated_at: String,
    #[serde(default, deserialize_with = "null_to_default")]
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
                author: n.author.map(RawSearchAuthor::into_author),
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
                author: n.author.map(RawSearchAuthor::into_author),
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
    /// The walk couldn't cover the list's own page, so an absent number may still have
    /// been reviewed and the grouping can't be trusted. A capped walk alone does NOT
    /// set this — see [`review_map_truncated`].
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

/// Whether the review-state map has to warn that it may be incomplete — which a capped
/// walk alone does not prove.
///
/// The list and the reviewed-by search run the SAME scope under the SAME
/// `sort:created-desc`, and the reviewed set is a SUBSET of that scope. So a reviewed
/// row visible in the newest `page_depth` rows of the scope has at most
/// `page_depth - 1` scope rows newer than it, hence at most that many REVIEWED rows
/// newer than it — putting it inside the newest `page_depth` of the reviewed subset.
/// A walk that fetched at least `page_depth` reviewed rows therefore holds every
/// reviewed row on screen, and the grouping must NOT degrade to the flat list. Only a
/// walk that stopped short of the page's own depth leaves a visible row unaccounted
/// for.
fn review_map_truncated(walk_truncated: bool, covered: u32, page_depth: u32) -> bool {
    walk_truncated && covered < page_depth
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
    let page_depth = target_rows(limit);
    let target = page_depth.max(SEARCH_PAGE_MAX * REVIEW_STATE_MAX_PAGES);
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
    // How deep into the REVIEWED set the walk actually reached — counted before the
    // mapping, because a node the mapping skips still proves the walk got that far.
    let covered = nodes.len() as u32;
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
    Ok(ReviewStatePage {
        entries,
        truncated: review_map_truncated(truncated, covered, page_depth),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        advance, map_advanced_search_unsupported, review_map_truncated, search_args, search_query,
        target_rows, ReviewStateEntry, ReviewStatePage, Step, ISSUE_SEARCH_QUERY,
        MERGEABILITY_SEARCH_QUERY, PR_SEARCH_QUERY, REVIEW_STATE_QUERY,
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
        // Both LIST documents must ask for the actor type: without it every GitHub App
        // author silently loses its `app/` prefix and stops reading as a bot.
        for doc in [PR_SEARCH_QUERY, ISSUE_SEARCH_QUERY] {
            assert!(doc.contains("author{ login __typename }"), "{doc}");
        }
        // The review-state selection reads the viewer's OWN reviews, not the
        // sidebar-shaped `latestReviews`.
        assert!(REVIEW_STATE_QUERY.contains(
            "reviews(author:$viewer, states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED], \
             last:1)"
        ));
        assert!(!REVIEW_STATE_QUERY.contains("latestReviews"));
        // PENDING must never be selectable: `last: 1` takes the most recent review, so
        // an unsubmitted draft would displace the submitted one AND carry a null
        // `submittedAt` the mapper drops — the PR would read as "not reviewed yet"
        // despite a real earlier review.
        assert!(!REVIEW_STATE_QUERY.contains("PENDING"));
        // The listed states are the complete remainder of `PullRequestReviewState`
        // (PENDING, COMMENTED, APPROVED, CHANGES_REQUESTED, DISMISSED — introspected),
        // so narrowing the connection drops nothing but the drafts.
        for state in ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] {
            assert!(
                REVIEW_STATE_QUERY.contains(state),
                "{state} must stay selected"
            );
        }
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
        // An empty page ends the walk rather than paging forever on a server that keeps
        // promising more — and because that promise stands, the walk is TRUNCATED: rows
        // it never read may exist, so an unproven map must not pose as a complete one.
        assert_eq!(
            advance(100, 1, true, "cur", false, 300, 3),
            Step::Stop { truncated: true }
        );
        // A cursor the server declined to move is the other stuck-walk shape.
        assert_eq!(
            advance(100, 1, true, "", true, 300, 3),
            Step::Stop { truncated: true }
        );
        // The defensive stop takes its verdict from the server's own claim, so the same
        // no-progress page with NO further page promised is complete, not truncated.
        assert_eq!(
            advance(0, 1, true, "cur", false, 300, 3),
            Step::Stop { truncated: true },
            "no rows read while the server still promises a page"
        );
        assert_eq!(
            advance(0, 1, false, "cur", false, 300, 3),
            Step::Stop { truncated: false },
            "no rows and no further page is an honestly empty result"
        );
        assert_eq!(
            advance(100, 1, false, "", true, 300, 3),
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

    /// A capped reviewed-by walk is not the same as an uncovered page. Same scope, same
    /// `sort:created-desc`, reviewed ⊆ scope — so once the walk has fetched as many
    /// reviewed rows as the list's page is deep, every reviewed row on screen is in the
    /// map and the grouping must stay up.
    #[test]
    fn a_capped_walk_only_reports_truncated_when_it_missed_the_visible_page() {
        // The real default: 3 pages × 100 walked against a 30-row list page. Capped,
        // but provably covering the screen — this is the case that used to drop the
        // panel to the flat list for no reason.
        assert!(!review_map_truncated(true, 300, target_rows(None)));
        assert_eq!(target_rows(None), 30);
        // Exactly at the page depth still covers it (the rank bound is `<`, not `<=`).
        assert!(!review_map_truncated(true, 30, 30));
        // One short of it does not.
        assert!(review_map_truncated(true, 29, 30));
        // A page deeper than the walk can reach: 3 pages cap at 300 reviewed rows, so a
        // 1000-row list page is genuinely unproven.
        assert!(review_map_truncated(true, 300, target_rows(Some(1000))));
        assert_eq!(target_rows(Some(1000)), 1000);
        // An UNCAPPED walk is complete by construction, whatever it fetched — including
        // a viewer who has reviewed nothing in scope.
        assert!(!review_map_truncated(false, 0, 30));
        assert!(!review_map_truncated(false, 5, 1000));
        // …and a capped walk that fetched nothing cannot vouch for a non-empty page.
        assert!(review_map_truncated(true, 0, 30));
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
    use super::{
        advance, parse_page_nodes, RawIssueSearchNode, RawMergeabilityNode, RawPrSearchNode,
        RawReviewStateNode, RawSearchAuthor, Step,
    };

    /// Captured verbatim from `gh api graphql` against `repo:theBGuy/GitDesktop
    /// type:pr is:closed sort:created-desc` — the shape the parse tree must survive.
    const PR_SEARCH_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjI="},"nodes":[{"number":336,"url":"https://github.com/theBGuy/GitDesktop/pull/336","title":"fix(agent): heap-allocate the capture read buffers","baseRefName":"master","headRefName":"fix/agent-capture-heap-buffers","isDraft":false,"state":"MERGED","author":{"login":"theBGuy","__typename":"User"},"labels":{"nodes":[{"name":"bug"},{"name":"no-changelog"}]},"createdAt":"2026-09-10T23:20:15Z","isCrossRepository":false},{"number":335,"url":"https://github.com/theBGuy/GitDesktop/pull/335","title":"fix(about,health): spawn tool probes off the command future","baseRefName":"master","headRefName":"fix/about-health-stack-overflow","isDraft":false,"state":"MERGED","author":{"login":"theBGuy","__typename":"User"},"labels":{"nodes":[{"name":"bug"}]},"createdAt":"2026-09-10T18:19:41Z","isCrossRepository":false}]}}}"#;

    /// A GitHub App author, captured verbatim from the same document over
    /// `author:app/dependabot`. GraphQL spells the Bot's login BARE here; the CLI list
    /// spells the identical PR's author `app/dependabot`.
    const BOT_PR_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjE="},"nodes":[{"number":340,"url":"https://github.com/theBGuy/GitDesktop/pull/340","title":"chore(deps): bump motion from 12.43.0 to 13.1.0","baseRefName":"master","headRefName":"dependabot/npm_and_yarn/motion-13.1.0","isDraft":false,"state":"OPEN","author":{"login":"dependabot","__typename":"Bot"},"labels":{"nodes":[{"name":"dependencies"},{"name":"javascript"}]},"createdAt":"2026-09-11T11:23:00Z","isCrossRepository":false}]}}}"#;

    const ISSUE_SEARCH_FIXTURE: &str = r#"{"data":{"search":{"pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOjI="},"nodes":[{"number":334,"url":"https://github.com/theBGuy/GitDesktop/issues/334","title":"bug: GitDesktop is crashing at menu Settings / About on Windows","state":"OPEN","author":{"login":"batagy","__typename":"User"},"labels":{"nodes":[{"name":"bug"}]},"createdAt":"2026-09-10T11:32:52Z","updatedAt":"2026-09-10T22:06:34Z"},{"number":333,"url":"https://github.com/theBGuy/GitDesktop/issues/333","title":"feat: Make zooming possible in GUI","state":"OPEN","author":{"login":"batagy","__typename":"User"},"labels":{"nodes":[{"name":"enhancement"}]},"createdAt":"2026-09-10T11:20:42Z","updatedAt":"2026-09-10T11:20:42Z"}]}}}"#;

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

    /// A GitHub App author must reach the frontend spelled the way the CLI list spells
    /// it. GraphQL says `dependabot`; `gh pr list --json author` says `app/dependabot`
    /// for the same PR, and only the prefixed form is recognized as a bot downstream
    /// (`displayLogin`) or accepted back as an author qualifier (`author:dependabot`
    /// matched 0, `author:app/dependabot` matched 64 — measured).
    #[test]
    fn a_bot_author_is_normalized_to_the_cli_spelling() {
        let bot: Vec<Option<RawPrSearchNode>> = nodes(BOT_PR_FIXTURE);
        let row = bot.into_iter().flatten().next().expect("one bot row");
        assert_eq!(row.number, Some(340));
        // The raw node carries the BARE login…
        let raw = row.author.expect("the bot author is present");
        assert_eq!(raw.login, "dependabot");
        assert_eq!(raw.typename, "Bot");
        // …and the mapping restores the CLI's prefix.
        assert_eq!(raw.into_author().login, "app/dependabot");

        // A User-typed author is already spelled the CLI's way and must stay bare —
        // prefixing a human would make `displayLogin` render them as `theBGuy[bot]`.
        let user: Vec<Option<RawPrSearchNode>> = nodes(PR_SEARCH_FIXTURE);
        let row = user.into_iter().flatten().next().expect("one user row");
        let raw = row.author.expect("the user author is present");
        assert_eq!(raw.typename, "User");
        assert_eq!(raw.into_author().login, "theBGuy");

        // Idempotent, so a future GraphQL that starts sending the prefix can't yield
        // `app/app/dependabot`.
        let prefixed = RawSearchAuthor {
            login: "app/dependabot".to_string(),
            typename: "Bot".to_string(),
        };
        assert_eq!(prefixed.into_author().login, "app/dependabot");
        // Other actor types pass through untouched, and an absent login is never
        // turned into a synthesized `app/` name.
        for (login, typename, want) in [
            ("github", "Organization", "github"),
            ("ghost", "Mannequin", "ghost"),
            ("", "Bot", ""),
            ("someone", "", "someone"),
        ] {
            let a = RawSearchAuthor {
                login: login.to_string(),
                typename: typename.to_string(),
            };
            assert_eq!(a.into_author().login, want, "{typename}/{login}");
        }
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
        // An empty review connection and a review with no timestamp both survive the
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

    /// `labels` is nullable on both search types, and GraphQL may spell an absent
    /// connection as an explicit `null` — at the connection OR at its `nodes` list.
    /// `#[serde(default)]` covers only a missing key, so without the null tolerance one
    /// unlabelled PR would fail its element and reject the whole page.
    #[test]
    fn an_explicitly_null_pr_labels_connection_parses_as_no_labels() {
        let parsed: Vec<Option<RawPrSearchNode>> = nodes(
            r#"{"data":{"search":{"nodes":[{"number":1,"labels":null},{"number":2,"labels":{"nodes":null}},{"number":3,"labels":{"nodes":[{"name":"bug"}]}}]}}}"#,
        );
        let rows: Vec<RawPrSearchNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 3, "a sparse node must not blank the page");
        // Read through `into_list`, the mapping the list read itself uses. The labelled
        // sibling proves the tolerance absorbs the nulls rather than dropping labels.
        let labels: Vec<Vec<String>> = rows
            .into_iter()
            .map(|r| r.labels.into_list().into_iter().map(|l| l.name).collect())
            .collect();
        assert_eq!(labels, [vec![], vec![], vec!["bug".to_string()]]);
    }

    #[test]
    fn an_explicitly_null_issue_labels_connection_parses_as_no_labels() {
        let parsed: Vec<Option<RawIssueSearchNode>> = nodes(
            r#"{"data":{"search":{"nodes":[{"number":11,"labels":null},{"number":12,"labels":{"nodes":null}},{"number":13,"labels":{"nodes":[{"name":"enhancement"}]}}]}}}"#,
        );
        let rows: Vec<RawIssueSearchNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 3, "a sparse node must not blank the page");
        let labels: Vec<Vec<String>> = rows
            .into_iter()
            .map(|r| r.labels.into_list().into_iter().map(|l| l.name).collect())
            .collect();
        assert_eq!(labels, [vec![], vec![], vec!["enhancement".to_string()]]);
    }

    /// An explicitly null review connection must read as NOT reviewed — the grouping's
    /// absent-from-map meaning — rather than rejecting the page it shares with the rows
    /// that do carry reviews.
    #[test]
    fn an_explicitly_null_reviews_connection_parses_as_not_reviewed() {
        let parsed: Vec<Option<RawReviewStateNode>> = nodes(
            r#"{"data":{"search":{"nodes":[{"number":21,"updatedAt":"2026-01-01T00:00:00Z","reviews":null},{"number":22,"updatedAt":"2026-01-01T00:00:00Z","reviews":{"nodes":null}},{"number":23,"updatedAt":"2026-01-01T00:00:00Z","reviews":{"nodes":[{"submittedAt":"2026-01-02T00:00:00Z"}]}}]}}}"#,
        );
        let rows: Vec<RawReviewStateNode> = parsed.into_iter().flatten().collect();
        assert_eq!(rows.len(), 3, "a sparse node must not blank the page");
        // The exact expression `review_state` uses to decide reviewed-vs-not.
        let last_reviewed: Vec<Option<String>> = rows
            .into_iter()
            .map(|n| {
                n.reviews
                    .nodes
                    .into_iter()
                    .flatten()
                    .find_map(|r| r.submitted_at)
                    .filter(|s| !s.is_empty())
            })
            .collect();
        assert_eq!(
            last_reviewed,
            [None, None, Some("2026-01-02T00:00:00Z".to_string())]
        );
    }

    /// The connection's OWN `nodes` list is nullable too, one layer above the per-node
    /// connections. A null there is an empty page, never a failed read — but a list
    /// that's present and malformed must still propagate, or a broken response would
    /// pose as an empty filter result.
    #[test]
    fn an_explicitly_null_nodes_list_reads_as_an_empty_page() {
        let parse = |s: &str| -> Result<Vec<Option<RawPrSearchNode>>, serde_json::Error> {
            parse_page_nodes(
                &serde_json::from_str::<serde_json::Value>(s).expect("fixture is JSON"),
            )
        };
        // All three spellings of "no rows" agree.
        for empty in [
            r#"{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":null}"#,
            r#"{"pageInfo":{"hasNextPage":false,"endCursor":""}}"#,
            r#"{"pageInfo":{"hasNextPage":false,"endCursor":""},"nodes":[]}"#,
        ] {
            assert!(
                parse(empty)
                    .expect("an empty page, not a failed read")
                    .is_empty(),
                "{empty}"
            );
        }
        // A present-but-wrong list is still a SHAPE failure: the null tolerance must not
        // have widened into swallowing every unreadable response.
        for broken in [r#"{"nodes":{"not":"a list"}}"#, r#"{"nodes":7}"#] {
            assert!(parse(broken).is_err(), "{broken}");
        }
        // A real page still reads through the same seam.
        let real: serde_json::Value =
            serde_json::from_str(PR_SEARCH_FIXTURE).expect("fixture is JSON");
        let rows = parse_page_nodes::<RawPrSearchNode>(
            real.pointer("/data/search").expect("search connection"),
        )
        .expect("the captured page parses");
        assert_eq!(rows.len(), 2);

        // The empty page must also END the walk: a degenerate payload that returns no
        // rows while still promising another page would otherwise page forever on a
        // cursor that can never yield anything — and it stops TRUNCATED, so the review
        // grouping hedges rather than vouching for a map built from rows it never saw.
        assert_eq!(
            advance(0, 1, true, "cur", false, 300, 3),
            Step::Stop { truncated: true }
        );
    }
}
