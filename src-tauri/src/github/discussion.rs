use serde::{Deserialize, Serialize};

use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::github::issue::{map_reaction_groups, IssueReactions};
use crate::github::pr::{PrAuthor, PrRef, RepoLabel};
use crate::github::runner::{run_gh, GhOutput, GH_NETWORK_TIMEOUT};

/// Discussions are Labelable, so labels come back as a `{ nodes: [...] }`
/// connection (name + color; id stays empty, like PR-embedded labels).
#[derive(Deserialize, Default)]
struct RawLabels {
    #[serde(default)]
    nodes: Vec<RepoLabel>,
}

// Discussions have no `gh discussion` command and no REST surface — everything
// goes through `gh api graphql`. GraphQL needs explicit owner/name (no
// {owner}/{repo} substitution), so each call resolves them first.

/// `emojiHTML` comes back as `<div>🏎️</div>`; keep just the glyph.
fn strip_html(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// The repo's GraphQL `owner`/`name`, pinned to the ORIGIN slug (via
/// `gh_origin_slug`), NOT a bare `gh repo view`: on a fork with an `upstream`
/// remote a bare `gh repo view` auto-resolves to the PARENT, so every discussion
/// read built on this pair (categories/list/view/reactions) would answer for the
/// upstream instead of the fork. On a non-fork the slug equals gh's resolution,
/// so behavior is unchanged. (The discussion MUTATIONS below are node-id
/// addressed and carry no repo argument, so they're already fork-safe.)
async fn owner_name(repo_path: &str) -> AppResult<(String, String)> {
    let slug = crate::github::gh_origin_slug(repo_path).await?;
    slug.split_once('/')
        .map(|(o, n)| (o.to_string(), n.to_string()))
        .ok_or_else(|| AppError::Gh("could not determine the repository owner".into()))
}

fn login(a: Option<PrAuthor>) -> String {
    a.map(|x| x.login).unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionCategory {
    pub id: String,
    pub name: String,
    /// The category glyph (extracted from emojiHTML), e.g. "🏎️".
    pub emoji: String,
    pub is_answerable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionMeta {
    /// GraphQL node id of the repository — needed to create a discussion.
    pub repo_id: String,
    pub has_discussions_enabled: bool,
    pub categories: Vec<DiscussionCategory>,
}

const META_QUERY: &str = "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id hasDiscussionsEnabled discussionCategories(first:50){ nodes{ id name emojiHTML isAnswerable } } } }";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCategory {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    emoji_html: String,
    #[serde(default)]
    is_answerable: bool,
}

/// Repo discussion metadata: node id (for create), whether discussions are
/// enabled, and the categories (for the filter + create picker).
#[tauri::command]
pub async fn gh_discussion_categories(repo_path: String) -> AppResult<DiscussionMeta> {
    let (owner, name) = owner_name(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "-f",
            &format!("query={META_QUERY}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse discussion categories: {e}")))?;
    let repo = value.pointer("/data/repository");
    let repo_id = repo
        .and_then(|r| r.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let has_discussions_enabled = repo
        .and_then(|r| r.get("hasDiscussionsEnabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let categories = repo
        .and_then(|r| r.pointer("/discussionCategories/nodes"))
        .cloned()
        .map(|nodes| serde_json::from_value::<Vec<RawCategory>>(nodes).unwrap_or_default())
        .unwrap_or_default()
        .into_iter()
        .map(|c| DiscussionCategory {
            id: c.id,
            name: c.name,
            emoji: strip_html(&c.emoji_html),
            is_answerable: c.is_answerable,
        })
        .collect();
    Ok(DiscussionMeta {
        repo_id,
        has_discussions_enabled,
        categories,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionInfo {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub created_at: String,
    pub is_answered: bool,
    pub closed: bool,
    pub state_reason: Option<String>,
    pub category_name: String,
    pub category_emoji: String,
    pub author: String,
    pub comment_count: u64,
    pub upvote_count: u64,
    pub labels: Vec<RepoLabel>,
}

const LIST_QUERY: &str = "query($owner:String!,$name:String!,$category:ID,$first:Int!,$after:String){ repository(owner:$owner,name:$name){ discussions(first:$first, after:$after, categoryId:$category, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number title url createdAt isAnswered closed stateReason upvoteCount category{ name emojiHTML } author{ login } comments{ totalCount } labels(first:10){ nodes{ name color } } } } } }";

/// GraphQL caps `discussions(first:)` at 100 per page; larger limits paginate.
const DISCUSSION_PAGE_MAX: u32 = 100;

/// The historical single-page size, and the default when no explicit limit is
/// given (preserves the MCP `list_discussions` ceiling and pre-pagination
/// behavior for any caller that passes `None`).
const DISCUSSION_DEFAULT_LIMIT: u32 = 50;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawListCategory {
    #[serde(default)]
    name: String,
    #[serde(default)]
    emoji_html: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawCommentCount {
    #[serde(default)]
    total_count: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscussionNode {
    #[serde(default)]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    created_at: String,
    // Nullable: `isAnswered` is null for non-answerable (non-Q&A) categories.
    #[serde(default)]
    is_answered: Option<bool>,
    #[serde(default)]
    closed: bool,
    #[serde(default)]
    state_reason: Option<String>,
    category: Option<RawListCategory>,
    author: Option<PrAuthor>,
    #[serde(default)]
    comments: RawCommentCount,
    #[serde(default)]
    upvote_count: u64,
    #[serde(default)]
    labels: RawLabels,
}

/// Discussions for the list, newest-updated first. `category` is a category
/// node id to filter by, or empty for all categories. (Discussions have no
/// open/closed tabs — they're filtered by category; `closed`/`stateReason`
/// surface as a badge.) `limit` caps the total; `None` keeps the historical
/// single page of [`DISCUSSION_DEFAULT_LIMIT`]. Larger limits page the GraphQL
/// connection (≤[`DISCUSSION_PAGE_MAX`] per request) until the limit is met or
/// GitHub reports no further page.
#[tauri::command]
pub async fn gh_discussion_list(
    repo_path: String,
    category: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<DiscussionInfo>> {
    let (owner, name) = owner_name(&repo_path).await?;
    let target = limit.unwrap_or(DISCUSSION_DEFAULT_LIMIT).max(1);
    let mut raw_nodes: Vec<RawDiscussionNode> = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        // Ask for only what's still needed, capped at GraphQL's per-page max.
        let remaining = target.saturating_sub(raw_nodes.len() as u32);
        let page = remaining.min(DISCUSSION_PAGE_MAX);
        let mut args = vec![
            "api".to_string(),
            "graphql".to_string(),
            "-F".to_string(),
            format!("owner={owner}"),
            "-F".to_string(),
            format!("name={name}"),
            "-F".to_string(),
            format!("first={page}"),
        ];
        // Only pass categoryId when filtering; absent leaves the variable null.
        if let Some(cat) = category.as_deref().filter(|c| !c.is_empty()) {
            args.push("-F".to_string());
            args.push(format!("category={cat}"));
        }
        // The `after` cursor is server-opaque text, so it travels as a String
        // variable; omitted on the first request (a missing GraphQL variable is
        // null → the first page).
        if let Some(c) = &cursor {
            args.push("-f".to_string());
            args.push(format!("after={c}"));
        }
        args.push("-f".to_string());
        args.push(format!("query={LIST_QUERY}"));
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT).await?;
        let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Gh(format!("could not parse discussions: {e}")))?;
        let discussions = value.pointer("/data/repository/discussions");
        // Propagate parse errors instead of silently yielding an empty list.
        let page_nodes: Vec<RawDiscussionNode> = discussions
            .and_then(|d| d.get("nodes"))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| AppError::Gh(format!("could not parse discussions: {e}")))?
            .unwrap_or_default();
        let got_nodes = !page_nodes.is_empty();
        raw_nodes.extend(page_nodes);

        // Advance only while under the limit AND GitHub reports another page
        // with a cursor; a page that yielded nothing also ends the loop so a
        // stuck cursor can't spin forever.
        let has_next = discussions
            .and_then(|d| d.pointer("/pageInfo/hasNextPage"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let end_cursor = discussions
            .and_then(|d| d.pointer("/pageInfo/endCursor"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if raw_nodes.len() as u32 >= target
            || !has_next
            || end_cursor.is_empty()
            || !got_nodes
        {
            break;
        }
        cursor = Some(end_cursor.to_string());
    }

    Ok(raw_nodes
        .into_iter()
        .map(|d| {
            let category = d.category.unwrap_or_default();
            DiscussionInfo {
                number: d.number,
                title: d.title,
                url: d.url,
                created_at: d.created_at,
                is_answered: d.is_answered.unwrap_or(false),
                closed: d.closed,
                state_reason: d.state_reason,
                category_name: category.name,
                category_emoji: strip_html(&category.emoji_html),
                author: login(d.author),
                comment_count: d.comments.total_count,
                upvote_count: d.upvote_count,
                labels: d.labels.nodes,
            }
        })
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionReply {
    pub id: String,
    pub author: String,
    pub body: String,
    pub date: String,
    pub url: String,
    pub viewer_did_author: bool,
    pub is_minimized: bool,
    pub minimized_reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub date: String,
    pub url: String,
    pub viewer_did_author: bool,
    pub is_minimized: bool,
    pub minimized_reason: String,
    pub upvote_count: u64,
    pub viewer_has_upvoted: bool,
    /// Whether this comment is the discussion's accepted answer.
    pub is_answer: bool,
    pub replies: Vec<DiscussionReply>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscussionDetails {
    pub id: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub author: String,
    pub created_at: String,
    pub category_name: String,
    pub category_emoji: String,
    /// Whether the category accepts answers (Q&A) — gates "Mark as answer".
    pub is_answerable: bool,
    pub is_answered: bool,
    pub upvote_count: u64,
    pub viewer_has_upvoted: bool,
    pub locked: bool,
    pub active_lock_reason: Option<String>,
    pub closed: bool,
    pub state_reason: Option<String>,
    pub labels: Vec<RepoLabel>,
    pub comments: Vec<DiscussionComment>,
}

const VIEW_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ discussion(number:$number){ id number title body url createdAt isAnswered upvoteCount viewerHasUpvoted locked activeLockReason closed stateReason author{login} category{ name emojiHTML isAnswerable } labels(first:20){ nodes{ name color } } comments(first:100){ nodes{ id body createdAt isAnswer isMinimized minimizedReason viewerDidAuthor upvoteCount viewerHasUpvoted url author{login} replies(first:100){ nodes{ id body createdAt isMinimized minimizedReason viewerDidAuthor url author{login} } } } } } } }";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawViewCategory {
    #[serde(default)]
    name: String,
    #[serde(default)]
    emoji_html: String,
    #[serde(default)]
    is_answerable: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    #[serde(default)]
    id: String,
    author: Option<PrAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_minimized: bool,
    #[serde(default)]
    minimized_reason: Option<String>,
    #[serde(default)]
    viewer_did_author: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawReplies {
    #[serde(default)]
    nodes: Vec<RawReply>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscussionComment {
    #[serde(default)]
    id: String,
    author: Option<PrAuthor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_answer: bool,
    #[serde(default)]
    is_minimized: bool,
    #[serde(default)]
    minimized_reason: Option<String>,
    #[serde(default)]
    viewer_did_author: bool,
    #[serde(default)]
    upvote_count: u64,
    #[serde(default)]
    viewer_has_upvoted: bool,
    #[serde(default)]
    replies: RawReplies,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawComments {
    #[serde(default)]
    nodes: Vec<RawDiscussionComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDiscussion {
    #[serde(default)]
    id: String,
    #[serde(default)]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    created_at: String,
    // Nullable for non-answerable categories (see the list node).
    #[serde(default)]
    is_answered: Option<bool>,
    author: Option<PrAuthor>,
    category: Option<RawViewCategory>,
    #[serde(default)]
    upvote_count: u64,
    #[serde(default)]
    viewer_has_upvoted: bool,
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    active_lock_reason: Option<String>,
    #[serde(default)]
    closed: bool,
    #[serde(default)]
    state_reason: Option<String>,
    #[serde(default)]
    labels: RawLabels,
    #[serde(default)]
    comments: RawComments,
}

/// A discussion's full thread: body + top-level comments, each with its nested
/// replies (GitHub discussions are exactly two levels deep).
#[tauri::command]
pub async fn gh_discussion_view(
    repo_path: String,
    number: u64,
) -> AppResult<DiscussionDetails> {
    let (owner, name) = owner_name(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
            "-f",
            &format!("query={VIEW_QUERY}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse discussion: {e}")))?;
    let raw: RawDiscussion = value
        .pointer("/data/repository/discussion")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| AppError::Gh(format!("could not parse discussion: {e}")))?
        .ok_or_else(|| AppError::Gh("discussion not found".into()))?;

    let category = raw.category.unwrap_or_default();
    let comments = raw
        .comments
        .nodes
        .into_iter()
        .map(|c| DiscussionComment {
            id: c.id,
            author: login(c.author),
            body: c.body,
            date: c.created_at,
            url: c.url,
            viewer_did_author: c.viewer_did_author,
            is_minimized: c.is_minimized,
            minimized_reason: c.minimized_reason.unwrap_or_default(),
            upvote_count: c.upvote_count,
            viewer_has_upvoted: c.viewer_has_upvoted,
            is_answer: c.is_answer,
            replies: c
                .replies
                .nodes
                .into_iter()
                .map(|r| DiscussionReply {
                    id: r.id,
                    author: login(r.author),
                    body: r.body,
                    date: r.created_at,
                    url: r.url,
                    viewer_did_author: r.viewer_did_author,
                    is_minimized: r.is_minimized,
                    minimized_reason: r.minimized_reason.unwrap_or_default(),
                })
                .collect(),
        })
        .collect();

    Ok(DiscussionDetails {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        body: raw.body,
        url: raw.url,
        author: login(raw.author),
        created_at: raw.created_at,
        category_name: category.name,
        category_emoji: strip_html(&category.emoji_html),
        is_answerable: category.is_answerable,
        is_answered: raw.is_answered.unwrap_or(false),
        upvote_count: raw.upvote_count,
        viewer_has_upvoted: raw.viewer_has_upvoted,
        locked: raw.locked,
        active_lock_reason: raw.active_lock_reason,
        closed: raw.closed,
        state_reason: raw.state_reason,
        labels: raw.labels.nodes,
        comments,
    })
}

const DISCUSSION_SCOPE_HINT: &str = "Writing discussions needs the write:discussion scope. Run:  gh auth refresh -s write:discussion";

/// Discussion mutations need the `write:discussion` OAuth scope, which a default
/// `gh auth login` often lacks — turn that failure into an actionable hint.
fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("write:discussion") || lower.contains("required scopes") {
            return AppError::Gh(DISCUSSION_SCOPE_HINT.to_string());
        }
    }
    e
}

async fn run_mutation(repo_path: &str, args: &[&str]) -> AppResult<GhOutput> {
    run_gh(Some(repo_path), args, GH_NETWORK_TIMEOUT)
        .await
        .map_err(map_scope_error)
}

const CREATE_MUTATION: &str = "mutation($repoId:ID!,$categoryId:ID!,$title:String!,$body:String!){ createDiscussion(input:{repositoryId:$repoId, categoryId:$categoryId, title:$title, body:$body}){ discussion{ number url } } }";

/// Opens a discussion in the given category. Returns its number + URL.
#[tauri::command]
pub async fn gh_discussion_create(
    repo_path: String,
    repo_id: String,
    category_id: String,
    title: String,
    body: String,
) -> AppResult<PrRef> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument(
            "a discussion title is required".into(),
        ));
    }
    if category_id.is_empty() {
        return Err(AppError::InvalidArgument("a category is required".into()));
    }
    let out = run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={CREATE_MUTATION}"),
            "-f",
            &format!("repoId={repo_id}"),
            "-f",
            &format!("categoryId={category_id}"),
            "-f",
            &format!("title={title}"),
            "-f",
            &format!("body={body}"),
        ],
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse created discussion: {e}")))?;
    let d = value.pointer("/data/createDiscussion/discussion");
    Ok(PrRef {
        number: d
            .and_then(|x| x.get("number"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        url: d
            .and_then(|x| x.get("url"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

const ADD_COMMENT_MUTATION: &str = "mutation($discussionId:ID!,$body:String!,$replyToId:ID){ addDiscussionComment(input:{discussionId:$discussionId, body:$body, replyToId:$replyToId}){ comment{ id } } }";

/// Adds a comment to a discussion. A non-empty `reply_to_id` (a top-level
/// comment's node id) makes it a threaded reply instead.
#[tauri::command]
pub async fn gh_discussion_add_comment(
    repo_path: String,
    discussion_id: String,
    body: String,
    reply_to_id: Option<String>,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={ADD_COMMENT_MUTATION}"),
        "-f".to_string(),
        format!("discussionId={discussion_id}"),
        "-f".to_string(),
        format!("body={body}"),
    ];
    if let Some(reply) = reply_to_id.as_deref().filter(|r| !r.is_empty()) {
        args.push("-f".to_string());
        args.push(format!("replyToId={reply}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_mutation(&repo_path, &arg_refs).await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_mark_answer(
    repo_path: String,
    comment_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ markDiscussionCommentAsAnswer(input:{id:$id}){ clientMutationId } }",
            "-f",
            &format!("id={comment_id}"),
        ],
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_unmark_answer(
    repo_path: String,
    comment_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ unmarkDiscussionCommentAsAnswer(input:{id:$id}){ clientMutationId } }",
            "-f",
            &format!("id={comment_id}"),
        ],
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_update_comment(
    repo_path: String,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$body:String!){ updateDiscussionComment(input:{commentId:$id, body:$body}){ comment{ id } } }",
            "-f",
            &format!("id={comment_id}"),
            "-f",
            &format!("body={body}"),
        ],
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_delete_comment(
    repo_path: String,
    comment_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ deleteDiscussionComment(input:{id:$id}){ clientMutationId } }",
            "-f",
            &format!("id={comment_id}"),
        ],
    )
    .await?;
    Ok(())
}

/// Adds or removes the viewer's upvote on a discussion or comment (both are
/// Votable) by its node id.
#[tauri::command]
pub async fn gh_discussion_set_upvote(
    repo_path: String,
    subject_id: String,
    up: bool,
) -> AppResult<()> {
    let mutation = if up {
        "query=mutation($id:ID!){ addUpvote(input:{subjectId:$id}){ clientMutationId } }"
    } else {
        "query=mutation($id:ID!){ removeUpvote(input:{subjectId:$id}){ clientMutationId } }"
    };
    run_mutation(
        &repo_path,
        &["api", "graphql", "-f", mutation, "-f", &format!("id={subject_id}")],
    )
    .await?;
    Ok(())
}

const REACTIONS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ discussion(number:$number){ reactionGroups{ content viewerHasReacted reactors{ totalCount } } comments(first:100){ nodes{ id reactionGroups{ content viewerHasReacted reactors{ totalCount } } replies(first:100){ nodes{ id reactionGroups{ content viewerHasReacted reactors{ totalCount } } } } } } } } }";

/// Reactions for a discussion's body + every comment and reply (keyed by node
/// id). Reuses the issue reaction shape so the same ReactionBar + add/remove
/// mutations apply.
#[tauri::command]
pub async fn gh_discussion_reactions(
    repo_path: String,
    number: u64,
) -> AppResult<IssueReactions> {
    let (owner, name) = owner_name(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
            "-f",
            &format!("query={REACTIONS_QUERY}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse reactions: {e}")))?;
    let discussion = value.pointer("/data/repository/discussion");

    let body = map_reaction_groups(discussion.and_then(|d| d.get("reactionGroups")));
    let mut comments: HashMap<String, Vec<crate::github::issue::Reaction>> =
        HashMap::new();
    let mut record = |node: &serde_json::Value| {
        if let Some(id) = node.get("id").and_then(serde_json::Value::as_str) {
            let reactions = map_reaction_groups(node.get("reactionGroups"));
            if !reactions.is_empty() {
                comments.insert(id.to_string(), reactions);
            }
        }
    };
    if let Some(nodes) = discussion
        .and_then(|d| d.pointer("/comments/nodes"))
        .and_then(|n| n.as_array())
    {
        for node in nodes {
            record(node);
            if let Some(replies) = node
                .pointer("/replies/nodes")
                .and_then(|n| n.as_array())
            {
                for reply in replies {
                    record(reply);
                }
            }
        }
    }

    Ok(IssueReactions { body, comments })
}

/// Locks a discussion's conversation. `reason`, if given, is one of GitHub's
/// GraphQL LockReason values: OFF_TOPIC, TOO_HEATED, RESOLVED, SPAM.
#[tauri::command]
pub async fn gh_discussion_lock(
    repo_path: String,
    discussion_id: String,
    reason: Option<String>,
) -> AppResult<()> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        "query=mutation($id:ID!,$reason:LockReason){ lockLockable(input:{lockableId:$id, lockReason:$reason}){ clientMutationId } }".to_string(),
        "-f".to_string(),
        format!("id={discussion_id}"),
    ];
    if let Some(r) = reason.as_deref().filter(|r| !r.is_empty()) {
        if !matches!(r, "OFF_TOPIC" | "TOO_HEATED" | "RESOLVED" | "SPAM") {
            return Err(AppError::InvalidArgument(format!(
                "unknown lock reason: {r}"
            )));
        }
        args.push("-f".to_string());
        args.push(format!("reason={r}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_mutation(&repo_path, &arg_refs).await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_unlock(
    repo_path: String,
    discussion_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ unlockLockable(input:{lockableId:$id}){ clientMutationId } }",
            "-f",
            &format!("id={discussion_id}"),
        ],
    )
    .await?;
    Ok(())
}

/// Closes a discussion. `reason` is RESOLVED, OUTDATED, or DUPLICATE.
#[tauri::command]
pub async fn gh_discussion_close(
    repo_path: String,
    discussion_id: String,
    reason: String,
) -> AppResult<()> {
    let reason = match reason.as_str() {
        "" | "RESOLVED" => "RESOLVED",
        "OUTDATED" => "OUTDATED",
        "DUPLICATE" => "DUPLICATE",
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unknown close reason: {reason}"
            )));
        }
    };
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$reason:DiscussionCloseReason!){ closeDiscussion(input:{discussionId:$id, reason:$reason}){ clientMutationId } }",
            "-f",
            &format!("id={discussion_id}"),
            "-f",
            &format!("reason={reason}"),
        ],
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_discussion_reopen(
    repo_path: String,
    discussion_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ reopenDiscussion(input:{discussionId:$id}){ clientMutationId } }",
            "-f",
            &format!("id={discussion_id}"),
        ],
    )
    .await?;
    Ok(())
}

/// Permanently deletes a discussion.
#[tauri::command]
pub async fn gh_discussion_delete(
    repo_path: String,
    discussion_id: String,
) -> AppResult<()> {
    run_mutation(
        &repo_path,
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){ deleteDiscussion(input:{id:$id}){ clientMutationId } }",
            "-f",
            &format!("id={discussion_id}"),
        ],
    )
    .await?;
    Ok(())
}
