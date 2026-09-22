//! Project-global board items, ordered by position and paged in bounded batches.

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::project_fields::{field_value_selection, parse_field_value, ProjectFieldValue};
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItems {
    pub items: Vec<BoardItem>,
    pub total_count: u64,
    /// True when paging stopped with more remaining (page cap hit).
    pub truncated: bool,
    /// Cursor to continue from when `truncated`; null otherwise.
    pub end_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardItem {
    pub item_id: String,
    pub added_at: String,
    pub is_archived: bool,
    pub content: BoardItemContent,
    pub field_values: Vec<ProjectFieldValue>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BoardItemContent {
    Issue {
        id: String,
        number: u64,
        title: String,
        state: String,
        state_reason: Option<String>,
        repo_name_with_owner: String,
        assignees: Vec<AssigneeRef>,
        created_at: String,
        updated_at: String,
    },
    PullRequest {
        id: String,
        number: u64,
        title: String,
        state: String,
        is_draft: bool,
        repo_name_with_owner: String,
        assignees: Vec<AssigneeRef>,
        created_at: String,
        updated_at: String,
    },
    Draft {
        id: String,
        title: String,
        body: String,
        assignees: Vec<AssigneeRef>,
        created_at: String,
        updated_at: String,
    },
    /// A REDACTED item or content the parser could not read.
    Redacted {},
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssigneeRef {
    pub login: String,
    pub avatar_url: String,
}

const ITEMS_SCOPE_HINT: &str =
    "GitHub project items need the read:project (or project) scope. Run:  gh auth refresh -s project";
const ITEMS_POINTER: &str = "/data/node/items";
const PAGE_CAP: usize = 5;

fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(ITEMS_SCOPE_HINT.to_string());
        }
    }
    e
}

pub(crate) const DRAFT_CONTENT_SELECTION: &str = "id title body createdAt updatedAt assignees(first:20){ nodes{ login avatarUrl } }";

pub(crate) fn board_item_selection() -> String {
    let values = field_value_selection();
    format!(
        "id createdAt isArchived type content{{ __typename \
         ... on Issue {{ id number title state stateReason createdAt updatedAt \
           repository{{ nameWithOwner }} assignees(first:8){{ nodes{{ login avatarUrl }} }} }} \
         ... on PullRequest {{ id number title state isDraft createdAt updatedAt \
           repository{{ nameWithOwner }} assignees(first:8){{ nodes{{ login avatarUrl }} }} }} \
         ... on DraftIssue {{ {DRAFT_CONTENT_SELECTION} }} }} \
         fieldValues(first:50){{ nodes{{ {values} }} }}"
    )
}

fn project_items_query(include_archived: bool) -> String {
    let item = board_item_selection();
    let archived_states = if include_archived {
        "archivedStates:[ARCHIVED, NOT_ARCHIVED], "
    } else {
        ""
    };
    format!(
        "query($id:ID!,$after:String,$q:String){{ node(id:$id){{ ... on ProjectV2 {{ \
         items({archived_states}first:100, after:$after, orderBy:{{field:POSITION,direction:ASC}}, query:$q){{ \
         totalCount pageInfo{{ hasNextPage endCursor }} \
         nodes{{ {item} }} }} }} }} }}"
    )
}

fn build_items_args(
    project_id: &str,
    after: Option<&str>,
    query: Option<&str>,
    include_archived: Option<bool>,
) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!(
            "query={}",
            project_items_query(include_archived.unwrap_or(false))
        ),
        "-f".to_string(),
        format!("id={project_id}"),
    ];
    for (key, value) in [("after", after), ("q", query)] {
        if let Some(value) = value {
            args.extend(["-f".to_string(), format!("{key}={value}")]);
        }
    }
    args
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemsPage {
    total_count: u64,
    page_info: PageInfo,
    nodes: Option<Vec<Option<Value>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemResponse {
    id: String,
    created_at: Option<String>,
    is_archived: bool,
    #[serde(rename = "type")]
    item_type: String,
    content: Option<Value>,
    field_values: Option<FieldValuesResponse>,
}

#[derive(Deserialize)]
struct FieldValuesResponse {
    nodes: Option<Vec<Option<Value>>>,
}

#[derive(Deserialize)]
#[serde(tag = "__typename", rename_all_fields = "camelCase")]
enum ContentResponse {
    Issue {
        id: String,
        number: u64,
        title: String,
        state: String,
        state_reason: Option<String>,
        repository: RepositoryRef,
        assignees: Option<AssigneesResponse>,
        created_at: Option<String>,
        updated_at: Option<String>,
    },
    PullRequest {
        id: String,
        number: u64,
        title: String,
        state: String,
        is_draft: bool,
        repository: RepositoryRef,
        assignees: Option<AssigneesResponse>,
        created_at: Option<String>,
        updated_at: Option<String>,
    },
    DraftIssue {
        id: String,
        title: String,
        body: Option<String>,
        assignees: Option<AssigneesResponse>,
        created_at: Option<String>,
        updated_at: Option<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRef {
    name_with_owner: String,
}

#[derive(Deserialize)]
struct AssigneesResponse {
    nodes: Option<Vec<Option<AssigneeRef>>>,
}

fn assignee_refs(response: Option<AssigneesResponse>) -> Vec<AssigneeRef> {
    response
        .and_then(|response| response.nodes)
        .into_iter()
        .flatten()
        .flatten()
        .collect()
}

fn unreadable(detail: impl ToString) -> AppError {
    gh_unreadable("the project items", detail.to_string())
}

pub(crate) fn parse_content(item_type: &str, content: Option<Value>) -> BoardItemContent {
    let Some(content) = content else {
        return BoardItemContent::Redacted {};
    };
    if !matches!(
        (item_type, content["__typename"].as_str()),
        ("ISSUE", Some("Issue"))
            | ("PULL_REQUEST", Some("PullRequest"))
            | ("DRAFT_ISSUE", Some("DraftIssue"))
    ) {
        return BoardItemContent::Redacted {};
    }
    let Ok(content) = serde_json::from_value::<ContentResponse>(content) else {
        return BoardItemContent::Redacted {};
    };
    match content {
        ContentResponse::Issue {
            id,
            number,
            title,
            state,
            state_reason,
            repository,
            assignees,
            created_at,
            updated_at,
        } => BoardItemContent::Issue {
            id,
            number,
            title,
            state,
            state_reason,
            repo_name_with_owner: repository.name_with_owner,
            assignees: assignee_refs(assignees),
            created_at: created_at.unwrap_or_default(),
            updated_at: updated_at.unwrap_or_default(),
        },
        ContentResponse::PullRequest {
            id,
            number,
            title,
            state,
            is_draft,
            repository,
            assignees,
            created_at,
            updated_at,
        } => BoardItemContent::PullRequest {
            id,
            number,
            title,
            state,
            is_draft,
            repo_name_with_owner: repository.name_with_owner,
            assignees: assignee_refs(assignees),
            created_at: created_at.unwrap_or_default(),
            updated_at: updated_at.unwrap_or_default(),
        },
        ContentResponse::DraftIssue {
            id,
            title,
            body,
            assignees,
            created_at,
            updated_at,
        } => BoardItemContent::Draft {
            id,
            title,
            body: body.unwrap_or_default(),
            assignees: assignee_refs(assignees),
            created_at: created_at.unwrap_or_default(),
            updated_at: updated_at.unwrap_or_default(),
        },
    }
}

pub(crate) fn parse_board_item(value: Value) -> Result<BoardItem, String> {
    let node: ItemResponse = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if node.id.trim().is_empty() {
        return Err("missing project item id".into());
    }
    Ok(BoardItem {
        item_id: node.id,
        added_at: node.created_at.unwrap_or_default(),
        is_archived: node.is_archived,
        content: parse_content(&node.item_type, node.content),
        field_values: node
            .field_values
            .and_then(|values| values.nodes)
            .into_iter()
            .flatten()
            .flatten()
            .map(|value| parse_field_value(&value))
            .collect(),
    })
}

fn parse_page(output: &str) -> AppResult<BoardItems> {
    let mut value: Value = serde_json::from_str(output).map_err(unreadable)?;
    let connection = value
        .pointer_mut(ITEMS_POINTER)
        .ok_or_else(|| unreadable("missing project items connection"))?
        .take();
    let page: ItemsPage = serde_json::from_value(connection).map_err(unreadable)?;
    // A continuation without a cursor would refetch page one and duplicate cards.
    if page.page_info.has_next_page && page.page_info.end_cursor.is_none() {
        return Err(unreadable("missing cursor for the next project items page"));
    }
    let items = page
        .nodes
        .into_iter()
        .flatten()
        .flatten()
        .map(|node| parse_board_item(node).map_err(unreadable))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(BoardItems {
        items,
        total_count: page.total_count,
        truncated: page.page_info.has_next_page,
        end_cursor: if page.page_info.has_next_page {
            page.page_info.end_cursor
        } else {
            None
        },
    })
}

async fn load_items<F, Fut>(
    project_id: &str,
    mut after: Option<String>,
    query: Option<&str>,
    include_archived: Option<bool>,
    mut fetch: F,
) -> AppResult<BoardItems>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = AppResult<String>>,
{
    let mut board = BoardItems {
        items: Vec::new(),
        total_count: 0,
        truncated: false,
        end_cursor: None,
    };
    for _ in 0..PAGE_CAP {
        let args = build_items_args(project_id, after.as_deref(), query, include_archived);
        let output = fetch(args).await.map_err(map_scope_error)?;
        let page = parse_page(&output)?;
        board.items.extend(page.items);
        board.total_count = page.total_count;
        board.truncated = page.truncated;
        board.end_cursor = page.end_cursor;
        if !board.truncated {
            break;
        }
        after.clone_from(&board.end_cursor);
    }
    Ok(board)
}

#[tauri::command]
pub async fn gh_project_items(
    repo_path: String,
    project_id: String,
    after: Option<String>,
    query: Option<String>,
    include_archived: Option<bool>,
) -> AppResult<BoardItems> {
    let repo_path = &repo_path;
    load_items(
        &project_id,
        after,
        query.as_deref(),
        include_archived,
        |args| async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let out = run_gh(Some(repo_path), &args, GH_NETWORK_TIMEOUT).await?;
            Ok(out.stdout_lossy())
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::future::ready;

    fn content(typename: &str) -> Value {
        json!({
            "__typename": typename, "id": "content-id", "number": 42,
            "title": "Board card", "state": "OPEN", "stateReason": "REOPENED",
            "isDraft": true, "body": "**Draft**\n\nMarkdown",
            "repository": {"nameWithOwner": "owner/repo"},
            "assignees": {"nodes": [{"login": "octocat", "avatarUrl": "https://example.com/avatar"}]}
        })
    }

    fn item(id: &str, item_type: &str, content: Value) -> Value {
        json!({"id": id, "type": item_type, "isArchived": false,
            "content": content, "fieldValues": {"nodes": []}})
    }

    fn page(nodes: Value, has_next_page: bool, cursor: Option<&str>) -> String {
        json!({"data": {"node": {"items": {
            "nodes": nodes, "totalCount": 612,
            "pageInfo": {"hasNextPage": has_next_page, "endCursor": cursor}
        }}}})
        .to_string()
    }

    fn assert_keys(value: &Value, expected: &[&str]) {
        let mut actual: Vec<_> = value
            .as_object()
            .expect("wire object")
            .keys()
            .map(String::as_str)
            .collect();
        actual.sort_unstable();
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(actual, expected);
    }

    #[test]
    fn canned_content_and_all_wire_shapes() {
        let mut issue_without_reason = content("Issue");
        issue_without_reason
            .as_object_mut()
            .unwrap()
            .remove("stateReason");
        let mut merged_pr = content("PullRequest");
        merged_pr["state"] = json!("MERGED");
        merged_pr["isDraft"] = json!(false);
        let board = parse_page(&page(
            json!([
                item("issue", "ISSUE", content("Issue")),
                item("issue-no-reason", "ISSUE", issue_without_reason),
                item("pr-draft", "PULL_REQUEST", content("PullRequest")),
                item("pr-merged", "PULL_REQUEST", merged_pr),
                item("draft", "DRAFT_ISSUE", content("DraftIssue")),
                item("redacted", "REDACTED", Value::Null)
            ]),
            false,
            Some("last"),
        ))
        .unwrap();
        let wire = serde_json::to_value(board).unwrap();
        assert_keys(&wire, &["items", "totalCount", "truncated", "endCursor"]);
        assert_eq!(wire["totalCount"], 612);
        assert_eq!(wire["truncated"], false);
        assert_eq!(wire["endCursor"], Value::Null);
        let items = wire["items"].as_array().unwrap();
        assert_eq!(items.len(), 6);
        for item in items {
            assert_keys(
                item,
                &["itemId", "addedAt", "isArchived", "content", "fieldValues"],
            );
            assert_eq!(item["isArchived"], false);
            assert_eq!(item["fieldValues"], json!([]));
        }
        for index in [0, 1] {
            let issue = &items[index]["content"];
            assert_keys(
                issue,
                &[
                    "kind",
                    "id",
                    "number",
                    "title",
                    "state",
                    "stateReason",
                    "repoNameWithOwner",
                    "assignees",
                    "createdAt",
                    "updatedAt",
                ],
            );
            assert_eq!(issue["kind"], "issue");
            assert_eq!(issue["number"], 42);
            assert_eq!(issue["state"], "OPEN");
            assert_eq!(issue["repoNameWithOwner"], "owner/repo");
        }
        assert_eq!(items[0]["content"]["stateReason"], "REOPENED");
        assert_eq!(items[1]["content"]["stateReason"], Value::Null);
        for index in [2, 3] {
            let pr = &items[index]["content"];
            assert_keys(
                pr,
                &[
                    "kind",
                    "id",
                    "number",
                    "title",
                    "state",
                    "isDraft",
                    "repoNameWithOwner",
                    "assignees",
                    "createdAt",
                    "updatedAt",
                ],
            );
            assert_eq!(pr["kind"], "pullRequest");
            assert_eq!(pr["number"], 42);
            assert_eq!(pr["repoNameWithOwner"], "owner/repo");
        }
        assert_eq!(items[2]["content"]["state"], "OPEN");
        assert_eq!(items[2]["content"]["isDraft"], true);
        assert_eq!(items[3]["content"]["state"], "MERGED");
        assert_eq!(items[3]["content"]["isDraft"], false);
        let draft = &items[4]["content"];
        assert_keys(
            draft,
            &["kind", "id", "title", "body", "assignees", "createdAt", "updatedAt"],
        );
        assert_eq!(draft["kind"], "draft");
        assert_eq!(draft["body"], "**Draft**\n\nMarkdown");
        for item in &items[..5] {
            let content = &item["content"];
            assert_eq!(content["id"], "content-id");
            assert_eq!(content["title"], "Board card");
            let assignee = &content["assignees"][0];
            assert_keys(assignee, &["login", "avatarUrl"]);
            assert_eq!(
                assignee,
                &json!({"login": "octocat", "avatarUrl": "https://example.com/avatar"})
            );
        }
        assert_keys(&items[5]["content"], &["kind"]);
        assert_eq!(items[5]["content"], json!({"kind": "redacted"}));
    }

    #[test]
    fn item_parse_errors_keep_the_board_read_surface() {
        for (node, detail) in [
            (item("  ", "ISSUE", content("Issue")), "missing project item id"),
            (json!({}), "missing field `id`"),
        ] {
            let error = parse_page(&page(json!([node]), false, None)).err().unwrap();
            assert_eq!(
                error.to_string(),
                format!("Couldn't read the project items from GitHub.\n{detail}"),
            );
        }
    }

    #[test]
    fn item_and_content_dates_tolerate_absent_and_null_values() {
        for (item_type, typename) in [
            ("ISSUE", "Issue"),
            ("PULL_REQUEST", "PullRequest"),
            ("DRAFT_ISSUE", "DraftIssue"),
        ] {
            for dates in [
                None,
                Some(Value::Null),
                Some(json!("2026-09-16T12:00:00Z")),
            ] {
                let mut node = item("one", item_type, content(typename));
                if let Some(date) = &dates {
                    node["createdAt"] = date.clone();
                    node["content"]["createdAt"] = date.clone();
                    node["content"]["updatedAt"] = date.clone();
                }
                let board = parse_page(&page(json!([node]), false, None)).unwrap();
                let wire = serde_json::to_value(&board.items[0]).unwrap();
                let expected = dates.as_ref().and_then(Value::as_str).unwrap_or_default();
                assert_eq!(wire["addedAt"], expected);
                assert_eq!(wire["content"]["createdAt"], expected);
                assert_eq!(wire["content"]["updatedAt"], expected);
                assert_ne!(wire["content"]["kind"], "redacted");
            }
        }
    }

    #[test]
    fn unknown_null_and_mismatched_content_is_retained_as_redacted() {
        for (item_type, content) in [
            ("ISSUE", content("FutureContent")),
            ("REDACTED", content("Issue")),
            ("PULL_REQUEST", content("Issue")),
            ("ISSUE", content("PullRequest")),
            ("ISSUE", content("DraftIssue")),
            ("FUTURE_TYPE", content("Issue")),
            ("ISSUE", Value::Null),
        ] {
            let board = parse_page(&page(
                json!([item("keep", item_type, content)]),
                false,
                None,
            ))
            .unwrap();
            assert_eq!(board.items.len(), 1);
            assert_eq!(board.items[0].item_id, "keep");
            assert!(matches!(
                board.items[0].content,
                BoardItemContent::Redacted {}
            ));
        }
    }

    #[test]
    fn archived_items_and_shared_field_values_flow_through() {
        let fields = json!([
            {"__typename": "ProjectV2ItemFieldTextValue", "text": "Notes",
                "field": {"id": "notes", "name": "Notes", "dataType": "TEXT", "isIssueField": false}},
            {"__typename": "ProjectV2ItemIssueFieldValue", "field": {"id": "estimate", "name": "Estimate", "dataType": "NUMBER"},
                "issueFieldValue": {"__typename": "IssueFieldNumberValue", "number": 2.5}},
            {"__typename": "FutureField", "field": {"name": "Future"}}
        ]);
        let mut archived = item("archived", "ISSUE", content("Issue"));
        archived["isArchived"] = json!(true);
        archived["fieldValues"]["nodes"] = fields.clone();
        let board = parse_page(&page(json!([archived]), false, None)).unwrap();
        assert_eq!(board.items.len(), 1);
        assert!(board.items[0].is_archived);
        assert_eq!(board.total_count, 612);
        let expected: Vec<_> = fields
            .as_array()
            .unwrap()
            .iter()
            .map(parse_field_value)
            .collect();
        assert_eq!(
            serde_json::to_value(&board.items[0].field_values).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn nullable_fields_are_tolerated_and_issue_reasons_are_verbatim() {
        for reason in [
            Value::Null,
            json!("COMPLETED"),
            json!("NOT_PLANNED"),
            json!("REOPENED"),
        ] {
            let mut issue = content("Issue");
            issue["stateReason"] = reason.clone();
            issue["state"] = json!("CLOSED");
            issue["assignees"]["nodes"] = json!([null]);
            let parsed = parse_content("ISSUE", Some(issue));
            let wire = serde_json::to_value(parsed).unwrap();
            assert_eq!(wire["stateReason"], reason);
            assert_eq!(wire["state"], "CLOSED");
            assert_eq!(wire["assignees"], json!([]));
        }
        let mut draft = content("DraftIssue");
        draft["body"] = Value::Null;
        draft["assignees"] = Value::Null;
        let mut node = item("draft", "DRAFT_ISSUE", draft);
        node["fieldValues"] = Value::Null;
        let board = parse_page(&page(json!([node, null]), false, None)).unwrap();
        let wire = serde_json::to_value(board).unwrap();
        assert_eq!(wire["items"][0]["content"]["body"], "");
        assert_eq!(wire["items"][0]["content"]["assignees"], json!([]));
        assert_eq!(wire["items"][0]["fieldValues"], json!([]));
        assert!(parse_page(&page(Value::Null, false, None))
            .unwrap()
            .items
            .is_empty());
    }

    #[tokio::test]
    async fn two_pages_concatenate_and_exhaust_with_cursor_cleared() {
        let first = page(
            json!([item("one", "REDACTED", Value::Null)]),
            true,
            Some("next"),
        );
        let first_parsed = parse_page(&first).unwrap();
        assert!(first_parsed.truncated);
        assert_eq!(first_parsed.end_cursor.as_deref(), Some("next"));
        let mut pages = vec![
            first,
            page(
                json!([item("two", "REDACTED", Value::Null)]),
                false,
                Some("end"),
            ),
        ]
        .into_iter();
        let mut requests = Vec::new();
        let board = load_items(
            "project",
            Some("start".into()),
            Some("  status:Todo  "),
            Some(true),
            |args| {
                requests.push(args);
                ready(Ok(pages.next().expect("at most two pages")))
            },
        )
        .await
        .unwrap();
        assert_eq!(
            board
                .items
                .iter()
                .map(|item| item.item_id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        assert_eq!(board.total_count, 612);
        assert!(!board.truncated);
        assert!(board.end_cursor.is_none());
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains(&"after=start".into()));
        assert!(requests[1].contains(&"after=next".into()));
        for args in requests {
            assert!(args.contains(&format!("query={}", project_items_query(true))));
            assert!(args.contains(&"q=  status:Todo  ".into()));
        }
    }

    #[tokio::test]
    async fn five_page_cap_reports_more_remaining_or_exhaustion() {
        for more_remaining in [false, true] {
            let mut calls = 0;
            let board = load_items("project", None, None, None, |args| {
                if calls == 0 {
                    assert!(!args.iter().any(|arg| arg.starts_with("after=")));
                } else {
                    assert!(args.contains(&format!("after=cursor-{calls}")));
                }
                calls += 1;
                assert!(calls <= 5);
                ready(Ok(page(
                    json!([item(&calls.to_string(), "REDACTED", Value::Null)]),
                    calls < 5 || more_remaining,
                    Some(&format!("cursor-{calls}")),
                )))
            })
            .await
            .unwrap();
            assert_eq!(calls, 5);
            assert_eq!(
                board
                    .items
                    .iter()
                    .map(|item| item.item_id.as_str())
                    .collect::<Vec<_>>(),
                ["1", "2", "3", "4", "5"]
            );
            assert_eq!(board.truncated, more_remaining);
            assert_eq!(
                board.end_cursor.as_deref(),
                if more_remaining {
                    Some("cursor-5")
                } else {
                    None
                }
            );
            let wire = serde_json::to_value(board).unwrap();
            assert_eq!(
                wire["endCursor"],
                if more_remaining {
                    json!("cursor-5")
                } else {
                    Value::Null
                }
            );
        }
    }

    #[tokio::test]
    async fn empty_connection_stops_after_one_fetch() {
        let mut calls = 0;
        let board = load_items("project", None, None, None, |_| {
            calls += 1;
            ready(Ok(page(json!([]), false, None)))
        })
        .await
        .unwrap();
        assert_eq!(calls, 1);
        assert!(board.items.is_empty());
        assert!(!board.truncated);
        assert!(board.end_cursor.is_none());
    }

    #[test]
    fn runtime_strings_are_raw_variables_and_optional_query_is_verbatim() {
        for include_archived in [None, Some(false), Some(true)] {
            let query = project_items_query(include_archived.unwrap_or(false));
            for filter in [
                None,
                Some(""),
                Some("  unknown:qualifier \"quoted\"\n@file  "),
            ] {
                let args =
                    build_items_args("@project", Some("@cursor\"}"), filter, include_archived);
                assert_eq!(&args[..2], &["api", "graphql"]);
                assert!(args.contains(&format!("query={query}")));
                assert!(args.contains(&"id=@project".into()));
                assert!(args.contains(&"after=@cursor\"}".into()));
                assert_eq!(
                    args.iter().filter(|arg| arg.starts_with("q=")).count(),
                    usize::from(filter.is_some())
                );
                if let Some(filter) = filter {
                    assert!(args.contains(&format!("q={filter}")));
                }
                for pair in args[2..].chunks_exact(2) {
                    assert_eq!(pair[0], "-f");
                }
            }
        }
    }

    #[test]
    fn query_pins_pointers_shared_selection_order_and_limits() {
        let query = project_items_query(false);
        let values = field_value_selection();
        let expected = format!(
            "query($id:ID!,$after:String,$q:String){{ node(id:$id){{ ... on ProjectV2 {{ \
             items(first:100, after:$after, orderBy:{{field:POSITION,direction:ASC}}, query:$q){{ \
             totalCount pageInfo{{ hasNextPage endCursor }} \
             nodes{{ id createdAt isArchived type content{{ __typename \
             ... on Issue {{ id number title state stateReason createdAt updatedAt \
               repository{{ nameWithOwner }} assignees(first:8){{ nodes{{ login avatarUrl }} }} }} \
             ... on PullRequest {{ id number title state isDraft createdAt updatedAt \
               repository{{ nameWithOwner }} assignees(first:8){{ nodes{{ login avatarUrl }} }} }} \
             ... on DraftIssue {{ {DRAFT_CONTENT_SELECTION} }} }} \
             fieldValues(first:50){{ nodes{{ {values} }} }} }} }} }} }} }}"
        );
        assert_eq!(query, expected);
        let archived_query = project_items_query(true);
        assert_eq!(
            archived_query,
            expected.replacen(
                "items(first:100",
                "items(archivedStates:[ARCHIVED, NOT_ARCHIVED], first:100",
                1
            )
        );
        assert_eq!(
            archived_query
                .matches("archivedStates:[ARCHIVED, NOT_ARCHIVED], ")
                .count(),
            1
        );
        let tokens: Vec<_> = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|token| !token.is_empty())
            .collect();
        for path in [
            ITEMS_POINTER,
            "/totalCount",
            "/pageInfo/hasNextPage",
            "/pageInfo/endCursor",
            "/nodes/id",
            "/nodes/createdAt",
            "/nodes/isArchived",
            "/nodes/type",
            "/content/__typename",
            "/content/id",
            "/content/number",
            "/content/title",
            "/content/state",
            "/content/stateReason",
            "/content/isDraft",
            "/content/body",
            "/content/createdAt",
            "/content/updatedAt",
            "/content/repository/nameWithOwner",
            "/content/assignees/nodes/login",
            "/content/assignees/nodes/avatarUrl",
            "/fieldValues/nodes",
        ] {
            for segment in path
                .split('/')
                .filter(|segment| !segment.is_empty() && *segment != "data")
            {
                assert!(
                    tokens.contains(&segment),
                    "query no longer asks for `{segment}` (pointer {path})"
                );
            }
        }
        assert!(query.starts_with("query($id:ID!,$after:String,$q:String)"));
        assert!(query.contains("node(id:$id)"));
        assert!(query.contains(
            "items(first:100, after:$after, orderBy:{field:POSITION,direction:ASC}, query:$q)"
        ));
        assert_eq!(query.matches("assignees(first:8)").count(), 2);
        assert_eq!(query.matches("assignees(first:20)").count(), 1);
        assert!(DRAFT_CONTENT_SELECTION.contains("assignees(first:20)"));
        assert_eq!(query.matches("createdAt").count(), 4);
        assert_eq!(query.matches("updatedAt").count(), 3);
        assert!(query.contains(&format!(
            "fieldValues(first:50){{ nodes{{ {} }} }}",
            field_value_selection()
        )));
        for typename in ["Issue", "PullRequest", "DraftIssue"] {
            assert!(query.contains(&format!("... on {typename} {{ id")));
        }
    }

    #[tokio::test]
    async fn scope_errors_map_to_hint_and_other_errors_survive() {
        for raw in [
            "GraphQL: Your token has not been granted the required scopes to execute this query.",
            "missing scope read:project",
        ] {
            let result = load_items("project", None, None, None, |_| {
                ready(Err(AppError::Gh(raw.into())))
            })
            .await;
            let Err(AppError::Gh(message)) = result else {
                panic!("expected Gh error")
            };
            assert_eq!(message, ITEMS_SCOPE_HINT);
        }
        assert_eq!(
            map_scope_error(AppError::Gh("connection reset".into())).to_string(),
            "connection reset"
        );
        assert!(matches!(
            map_scope_error(AppError::InvalidArgument("required scopes".into())),
            AppError::InvalidArgument(_)
        ));
    }

    #[tokio::test]
    async fn malformed_matched_content_keeps_the_item_and_healthy_neighbors() {
        for (item_type, typename, malformed_key) in [
            ("ISSUE", "Issue", "number"),
            ("PULL_REQUEST", "PullRequest", "number"),
            ("DRAFT_ISSUE", "DraftIssue", "title"),
        ] {
            let mut malformed_item = item("broken", item_type, content(typename));
            malformed_item["content"][malformed_key] = json!([]);
            let output = page(
                json!([
                    item("before", "ISSUE", content("Issue")),
                    malformed_item,
                    item("after", "PULL_REQUEST", content("PullRequest"))
                ]),
                false,
                None,
            );
            let board = load_items("project", None, None, None, |_| ready(Ok(output.clone())))
                .await
                .unwrap();
            assert_eq!(board.total_count, 612);
            assert_eq!(
                board
                    .items
                    .iter()
                    .map(|item| item.item_id.as_str())
                    .collect::<Vec<_>>(),
                ["before", "broken", "after"]
            );
            assert!(matches!(
                board.items[0].content,
                BoardItemContent::Issue { .. }
            ));
            assert!(matches!(
                board.items[1].content,
                BoardItemContent::Redacted {}
            ));
            assert!(matches!(
                board.items[2].content,
                BoardItemContent::PullRequest { .. }
            ));
            assert!(!board.truncated);
            assert!(board.end_cursor.is_none());
        }
    }

    #[tokio::test]
    async fn unreadable_output_and_incomplete_paging_metadata_are_errors() {
        for output in [
            "not JSON".into(),
            "{}".into(),
            json!({"data": {"node": null}}).to_string(),
            json!({"data": {"node": {"items": {"nodes": []}}}}).to_string(),
            page(json!([]), true, None),
        ] {
            let result =
                load_items("project", None, None, None, |_| ready(Ok(output.clone()))).await;
            let Err(AppError::Gh(message)) = result else {
                panic!("expected unreadable error")
            };
            assert!(
                message.starts_with("Couldn't read the project items from GitHub.\n"),
                "{message}"
            );
        }
    }
}
