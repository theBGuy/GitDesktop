//! GitHub-only Projects v2 item creation, conversion, and membership edits.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::issue::repo_owner_name;
use crate::github::project::build_edit_projects_mutation;
use crate::github::project_items::{
    board_item_selection, parse_board_item, parse_content, BoardItem, BoardItemContent,
    DRAFT_CONTENT_SELECTION,
};
use crate::github::runner::{run_gh_input, GH_NETWORK_TIMEOUT};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCandidate {
    pub id: String,
    pub kind: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub state_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCandidates {
    pub candidates: Vec<BoardCandidate>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedDraft {
    pub number: u64,
    pub url: String,
    pub item: BoardItem,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardOrder {
    /// Item ids in the board's new project-global order, first page (100).
    pub item_ids: Vec<String>,
    /// True when the project holds more items than the payload page carries.
    pub truncated: bool,
}

const ITEM_EDITS_SCOPE_HINT: &str =
    "GitHub project item edits need the project scope. Run:  gh auth refresh -s project";

const SEARCH_QUERY: &str = "query($q:String!){ search(query:$q, type: ISSUE_ADVANCED, first:25){ pageInfo{hasNextPage} nodes{ __typename ... on Issue { id number title state stateReason repository { nameWithOwner } } ... on PullRequest { id number title state isDraft repository { nameWithOwner } } } } }";
const REPOSITORY_QUERY: &str =
    "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ id } }";
const ISSUE_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ issue(number:$number){ id } } }";
// Conversion, archive, and removal address PVTI_ item ids; updates take DI_ content ids.
// Add-board takes issue/PR content ids; add-draft returns both PVTI_ and DI_ ids.
const ARCHIVE_MUTATION: &str = "mutation($projectId:ID!,$itemId:ID!){ archiveProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){ item{ id } } }";
const REMOVE_MUTATION: &str = "mutation($projectId:ID!,$itemId:ID!){ deleteProjectV2Item(input:{projectId:$projectId,itemId:$itemId}){ deletedItemId } }";
const POSITION_MUTATION: &str = "mutation($projectId:ID!,$itemId:ID!,$afterId:ID){ updateProjectV2ItemPosition(input:{projectId:$projectId,itemId:$itemId,afterId:$afterId}){ items(first:100){ pageInfo{hasNextPage} nodes{id} } } }";

const SEARCH_POINTER: &str = "/data/search";
const CANDIDATE_REPOSITORY_POINTER: &str = "/repository/nameWithOwner";
const REPOSITORY_ID_POINTER: &str = "/data/repository/id";
const ISSUE_ID_POINTER: &str = "/data/repository/issue/id";
const DRAFT_POINTER: &str = "/data/addProjectV2DraftIssue/projectItem";
const ADD_ITEM_POINTER: &str = "/data/addProjectV2ItemById/item";
const CONVERT_POINTER: &str = "/data/convertProjectV2DraftIssueItemToIssue/item";
const UPDATE_DRAFT_POINTER: &str = "/data/updateProjectV2DraftIssue/draftIssue";
const ARCHIVE_POINTER: &str = "/data/archiveProjectV2Item";
const REMOVE_POINTER: &str = "/data/deleteProjectV2Item";
const ORDER_POINTER: &str = "/data/updateProjectV2ItemPosition/items";

fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(ITEM_EDITS_SCOPE_HINT.to_string());
        }
    }
    e
}

const GRAPHQL_INPUT_ARGS: [&str; 6] = ["api", "graphql", "--method", "POST", "--input", "-"];

// Stdin keeps bodies, titles, search text, and batched documents outside Windows'
// command-line limit. JSON variables preserve strings without gh's -F coercion.
fn graphql_input(document: &str, variables: Value) -> String {
    json!({"query": document, "variables": variables}).to_string()
}

fn search_input(owner: &str, name: &str, search: &str) -> String {
    let search = search.trim();
    let mut q = format!("repo:{owner}/{name} sort:updated-desc");
    // Convenience grouping only: user parentheses can escape the repo qualifier.
    // parse_candidate's repository check enforces that only matching rows reach the picker.
    if !search.is_empty() {
        q.push_str(&format!(" ({search})"));
    }
    graphql_input(SEARCH_QUERY, json!({"q": q}))
}

fn draft_input(project_id: &str, title: &str, body: &str) -> String {
    graphql_input(
        &add_draft_mutation(),
        json!({"projectId": project_id, "title": title, "body": body}),
    )
}

fn position_input(project_id: &str, item_id: &str, after_id: Option<&str>) -> String {
    graphql_input(
        POSITION_MUTATION,
        json!({"projectId": project_id, "itemId": item_id, "afterId": after_id}),
    )
}

fn add_draft_mutation() -> String {
    let item = board_item_selection();
    format!("mutation($projectId:ID!,$title:String!,$body:String){{ addProjectV2DraftIssue(input:{{projectId:$projectId,title:$title,body:$body}}){{ projectItem{{ {item} }} }} }}")
}

fn add_item_mutation() -> String {
    let item = board_item_selection();
    format!("mutation($projectId:ID!,$contentId:ID!){{ addProjectV2ItemById(input:{{projectId:$projectId,contentId:$contentId}}){{ item{{ {item} }} }} }}")
}

fn convert_mutation() -> String {
    let item = board_item_selection();
    format!("mutation($itemId:ID!,$repositoryId:ID!){{ convertProjectV2DraftIssueItemToIssue(input:{{itemId:$itemId,repositoryId:$repositoryId}}){{ item{{ {item} content{{ ... on Issue {{ url }} }} }} }} }}")
}

fn update_draft_input(
    draft_id: &str,
    title: &str,
    body: &str,
    assignee_ids: Option<&[String]>,
) -> String {
    let mut variables = json!({"draftIssueId": draft_id, "title": title, "body": body});
    let (declaration, field) = if let Some(ids) = assignee_ids {
        variables["assigneeIds"] = json!(ids);
        (",$assigneeIds:[ID!]!", ",assigneeIds:$assigneeIds")
    } else {
        ("", "")
    };
    let document = format!("mutation($draftIssueId:ID!,$title:String!,$body:String!{declaration}){{ updateProjectV2DraftIssue(input:{{draftIssueId:$draftIssueId,title:$title,body:$body{field}}}){{ draftIssue{{ __typename {DRAFT_CONTENT_SELECTION} }} }} }}");
    graphql_input(&document, variables)
}

fn assignee_lookup_input(logins: &[String]) -> AppResult<Option<String>> {
    // Variables isolate login text from the document; this gate is input sanity
    // and defense in depth, including underscores in Enterprise Managed User logins.
    for login in logins {
        if login.is_empty()
            || !login
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return Err(AppError::InvalidArgument(
                "Invalid GitHub assignee login".into(),
            ));
        }
    }
    if logins.is_empty() {
        return Ok(None);
    }
    let mut declarations = Vec::new();
    let mut fields = String::new();
    let mut variables = json!({});
    for (index, login) in logins.iter().enumerate() {
        let variable = format!("l{index}");
        declarations.push(format!("${variable}:String!"));
        fields.push_str(&format!("u{index}:user(login:${variable}){{id}} "));
        variables[&variable] = json!(login);
    }
    let document = format!("query({}){{ {fields} }}", declarations.join(","));
    Ok(Some(graphql_input(&document, variables)))
}

fn parse_assignee_ids(value: &Value, logins: &[String]) -> AppResult<Vec<String>> {
    logins
        .iter()
        .enumerate()
        .map(|(index, login)| {
            response_id(value, &format!("/data/u{index}/id"), "the draft assignees")
                .map_err(|_| {
                    gh_unreadable(
                        "the draft assignees",
                        format!("could not resolve assignee '{login}'"),
                    )
                })
        })
        .collect()
}

// Preserve CLI failures verbatim; project mutation callers own scope-hint mapping.
async fn request(repo_path: &str, input: &str, surface: &str) -> AppResult<Value> {
    let out = run_gh_input(
        Some(repo_path),
        &GRAPHQL_INPUT_ARGS,
        input,
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable(surface, format!("could not parse the response: {e}")))
}

fn response_id(value: &Value, pointer: &str, surface: &str) -> AppResult<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| gh_unreadable(surface, format!("missing id at {pointer}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCandidate {
    id: String,
    number: u64,
    title: String,
    state: String,
    state_reason: Option<String>,
    is_draft: Option<bool>,
}

fn parse_candidate(node: &Value, expected_repository: &str) -> Option<BoardCandidate> {
    // Search syntax can widen scope; only a matching repository may reach the picker.
    let repository = node.pointer(CANDIDATE_REPOSITORY_POINTER)?.as_str()?;
    if !repository.eq_ignore_ascii_case(expected_repository) {
        return None;
    }
    let kind = match node["__typename"].as_str()? {
        "Issue" => "issue",
        "PullRequest" => "pr",
        _ => return None,
    };
    let raw: RawCandidate = serde_json::from_value(node.clone()).ok()?;
    Some(BoardCandidate {
        id: raw.id,
        kind: kind.into(),
        number: raw.number,
        title: raw.title,
        state: raw.state,
        is_draft: if kind == "pr" { raw.is_draft? } else { false },
        state_reason: if kind == "issue" {
            raw.state_reason
        } else {
            None
        },
    })
}

fn parse_candidates(value: &Value, expected_repository: &str) -> AppResult<BoardCandidates> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PageInfo {
        has_next_page: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        nodes: Option<Vec<Value>>,
        page_info: PageInfo,
    }
    let page: Page = serde_json::from_value(
        value
            .pointer(SEARCH_POINTER)
            .cloned()
            .unwrap_or(Value::Null),
    )
    .map_err(|e| {
        gh_unreadable(
            "the board candidates",
            format!("could not parse search: {e}"),
        )
    })?;
    Ok(BoardCandidates {
        candidates: page
            .nodes
            .into_iter()
            .flatten()
            .filter_map(|node| parse_candidate(&node, expected_repository))
            .collect(),
        truncated: page.page_info.has_next_page,
    })
}

// The command must pass its UNMAPPED result so search retains GitHub's scope errors.
// This helper's tests cannot detect mapping done upstream before it receives the result.
fn search_candidates_from_response(
    response: AppResult<Value>,
    expected_repository: &str,
) -> AppResult<BoardCandidates> {
    parse_candidates(&response?, expected_repository)
}

fn parse_converted(value: &Value) -> AppResult<ConvertedDraft> {
    let item = response_item(value, CONVERT_POINTER, "the converted draft")?;
    let BoardItemContent::Issue { number, .. } = &item.content else {
        return Err(gh_unreadable(
            "the converted draft",
            "conversion did not return an issue".into(),
        ));
    };
    let url = value
        .pointer(&format!("{CONVERT_POINTER}/content/url"))
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| gh_unreadable("the converted draft", "missing the issue's url".into()))?
        .to_string();
    Ok(ConvertedDraft {
        number: *number,
        url,
        item,
    })
}

fn parse_board_order(value: &Value) -> AppResult<BoardOrder> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PageInfo {
        has_next_page: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        nodes: Option<Vec<Value>>,
        page_info: PageInfo,
    }
    let page: Page =
        serde_json::from_value(value.pointer(ORDER_POINTER).cloned().unwrap_or(Value::Null))
            .map_err(|e| {
                gh_unreadable("the board's new order", format!("could not parse items: {e}"))
            })?;
    Ok(BoardOrder {
        item_ids: page
            .nodes
            .into_iter()
            .flatten()
            .filter_map(|node| {
                node["id"]
                    .as_str()
                    .filter(|id| !id.trim().is_empty())
                    .map(str::to_string)
            })
            .collect(),
        truncated: page.page_info.has_next_page,
    })
}

fn response_item(value: &Value, pointer: &str, surface: &str) -> AppResult<BoardItem> {
    let node = value.pointer(pointer).cloned().unwrap_or(Value::Null);
    parse_board_item(node).map_err(|detail| gh_unreadable(surface, detail))
}

fn parse_updated_draft(value: &Value) -> AppResult<BoardItemContent> {
    let content = value.pointer(UPDATE_DRAFT_POINTER).cloned();
    let draft = parse_content("DRAFT_ISSUE", content);
    if let BoardItemContent::Draft { ref id, .. } = draft {
        if !id.trim().is_empty() {
            return Ok(draft);
        }
    }
    Err(gh_unreadable(
        "the updated draft",
        "missing draft content".into(),
    ))
}

fn require_payload(value: &Value, pointer: &str, surface: &str) -> AppResult<()> {
    if value.pointer(pointer).is_some_and(Value::is_object) {
        Ok(())
    } else {
        Err(gh_unreadable(
            surface,
            format!("missing payload at {pointer}"),
        ))
    }
}

#[tauri::command]
pub async fn gh_search_board_candidates(
    repo_path: String,
    search: String,
    lens: Option<String>,
) -> AppResult<BoardCandidates> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let response = request(
        &repo_path,
        &search_input(&owner, &name, &search),
        "the board candidates",
    )
    .await;
    search_candidates_from_response(response, &format!("{owner}/{name}"))
}

#[tauri::command]
pub async fn gh_add_draft_item(
    repo_path: String,
    project_id: String,
    title: String,
    body: String,
) -> AppResult<BoardItem> {
    let value = request(
        &repo_path,
        &draft_input(&project_id, &title, &body),
        "the new project draft",
    )
    .await
    .map_err(map_scope_error)?;
    response_item(&value, DRAFT_POINTER, "the new project draft")
}

#[tauri::command]
pub async fn gh_add_board_item(
    repo_path: String,
    project_id: String,
    content_id: String,
) -> AppResult<BoardItem> {
    let input = graphql_input(
        &add_item_mutation(),
        json!({"projectId": project_id, "contentId": content_id}),
    );
    let value = request(&repo_path, &input, "the added project item")
        .await
        .map_err(map_scope_error)?;
    response_item(&value, ADD_ITEM_POINTER, "the added project item")
}

#[tauri::command]
pub async fn gh_update_draft_item(
    repo_path: String,
    draft_id: String,
    title: String,
    body: String,
    assignee_logins: Option<Vec<String>>,
) -> AppResult<BoardItemContent> {
    let assignee_ids = if let Some(logins) = assignee_logins {
        let ids = if let Some(input) = assignee_lookup_input(&logins)? {
            let value = request(&repo_path, &input, "the draft assignees").await?;
            parse_assignee_ids(&value, &logins)?
        } else {
            Vec::new()
        };
        Some(ids)
    } else {
        None
    };
    let input = update_draft_input(&draft_id, &title, &body, assignee_ids.as_deref());
    let value = request(&repo_path, &input, "the updated draft")
        .await
        .map_err(map_scope_error)?;
    parse_updated_draft(&value)
}

#[tauri::command]
pub async fn gh_convert_draft_item(
    repo_path: String,
    item_id: String,
    lens: Option<String>,
) -> AppResult<ConvertedDraft> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let input = graphql_input(REPOSITORY_QUERY, json!({"owner": owner, "name": name}));
    let value = request(&repo_path, &input, "the draft's destination repository").await?;
    // Resolve and parse the destination before issuing any mutation.
    let repository_id = response_id(
        &value,
        REPOSITORY_ID_POINTER,
        "the draft's destination repository",
    )?;
    let input = graphql_input(
        &convert_mutation(),
        json!({"itemId": item_id, "repositoryId": repository_id}),
    );
    let value = request(&repo_path, &input, "the converted draft")
        .await
        .map_err(map_scope_error)?;
    parse_converted(&value)
}

#[tauri::command]
pub async fn gh_archive_board_item(
    repo_path: String,
    project_id: String,
    item_id: String,
) -> AppResult<()> {
    let input = graphql_input(
        ARCHIVE_MUTATION,
        json!({"projectId": project_id, "itemId": item_id}),
    );
    let value = request(&repo_path, &input, "the archived project item")
        .await
        .map_err(map_scope_error)?;
    require_payload(&value, ARCHIVE_POINTER, "the archived project item")
}

#[tauri::command]
pub async fn gh_remove_board_item(
    repo_path: String,
    project_id: String,
    item_id: String,
) -> AppResult<()> {
    let input = graphql_input(
        REMOVE_MUTATION,
        json!({"projectId": project_id, "itemId": item_id}),
    );
    let value = request(&repo_path, &input, "the removed project item")
        .await
        .map_err(map_scope_error)?;
    require_payload(&value, REMOVE_POINTER, "the removed project item")
}

#[tauri::command]
pub async fn gh_set_item_position(
    repo_path: String,
    project_id: String,
    item_id: String,
    after_id: Option<String>,
) -> AppResult<BoardOrder> {
    let input = position_input(&project_id, &item_id, after_id.as_deref());
    let value = request(&repo_path, &input, "the board's new order")
        .await
        .map_err(map_scope_error)?;
    parse_board_order(&value)
}

#[tauri::command]
pub async fn gh_add_issue_to_projects(
    repo_path: String,
    number: u64,
    add_project_ids: Vec<String>,
    lens: Option<String>,
) -> AppResult<()> {
    if add_project_ids.is_empty() {
        return Ok(());
    }
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let input = graphql_input(
        ISSUE_QUERY,
        json!({"owner": owner, "name": name, "number": number}),
    );
    let value = request(&repo_path, &input, "the issue to add to projects").await?;
    let issue_id = response_id(&value, ISSUE_ID_POINTER, "the issue to add to projects")?;
    let document = build_edit_projects_mutation(&issue_id, &add_project_ids, &[])?;
    request(
        &repo_path,
        &graphql_input(&document, json!({})),
        "the added project memberships",
    )
    .await
    .map_err(map_scope_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn issue(reason: Value) -> Value {
        json!({"__typename":"Issue","id":"I_one","number":1,"title":"Issue","state":"CLOSED","stateReason":reason,"repository":{"nameWithOwner":"owner/repo"}})
    }

    fn pr() -> Value {
        json!({"__typename":"PullRequest","id":"PR_two","number":2,"title":"PR","state":"OPEN","isDraft":true,"repository":{"nameWithOwner":"owner/repo"}})
    }

    fn draft_content(assignees: Value) -> Value {
        json!({"__typename":"DraftIssue", "id":"DI_one", "title":"Draft title",
            "body":"**Draft**\nBody", "assignees":{"nodes":assignees},
            "createdAt":"2026-09-15T12:00:00Z", "updatedAt":"2026-09-16T13:00:00Z"})
    }

    fn board_item(item_type: &str, mut content: Value) -> Value {
        if content.is_object() {
            content["createdAt"] = json!("2026-09-15T12:00:00Z");
            content["updatedAt"] = json!("2026-09-16T13:00:00Z");
        }
        json!({"id":"PVTI_one", "type":item_type, "isArchived":false,
            "createdAt":"2026-09-16T12:00:00Z", "content":content,
            "fieldValues":{"nodes":[{"__typename":"ProjectV2ItemFieldTextValue",
                "text":"Keep me", "field":{"id":"notes", "name":"Notes",
                    "dataType":"TEXT", "isIssueField":false}}]}})
    }

    #[test]
    fn draft_updates_round_trip_content_and_replace_assignees() {
        for assignees in [
            json!([]),
            json!([{"login":"octocat","avatarUrl":"https://example.com/one"},
                {"login":"hubot","avatarUrl":"https://example.com/two"}]),
        ] {
            let content = draft_content(assignees.clone());
            let value = json!({"data":{"updateProjectV2DraftIssue":{"draftIssue":content}}});
            let wire = serde_json::to_value(parse_updated_draft(&value).unwrap()).unwrap();
            assert_keys(
                wire.clone(),
                &["kind", "id", "title", "body", "assignees", "createdAt", "updatedAt"],
            );
            assert_eq!(wire["kind"], "draft");
            assert_eq!(wire["id"], "DI_one");
            for key in ["title", "body", "createdAt", "updatedAt"] {
                assert_eq!(wire[key], content[key]);
            }
            assert_eq!(wire["assignees"], assignees);
            let ids: Vec<String> = (0..assignees.as_array().unwrap().len())
                .map(|index| format!("U_{index}"))
                .collect();
            let input: Value = serde_json::from_str(&update_draft_input(
                "DI_one",
                wire["title"].as_str().unwrap(),
                wire["body"].as_str().unwrap(),
                Some(&ids),
            ))
            .unwrap();
            assert_eq!(input["variables"], json!({"draftIssueId":"DI_one",
                "title":wire["title"], "body":wire["body"], "assigneeIds":ids}));
            let added = parse_board_item(board_item("DRAFT_ISSUE", content)).unwrap();
            assert_eq!(serde_json::to_value(added.content).unwrap(), wire);
        }
        for content in [Value::Null, json!({}), draft_content(json!([]))] {
            let mut value = json!({"data":{"updateProjectV2DraftIssue":{"draftIssue":content}}});
            if content.is_object() {
                value.pointer_mut(UPDATE_DRAFT_POINTER).unwrap()["id"] = json!("  ");
            }
            assert!(parse_updated_draft(&value).is_err());
        }
    }

    #[test]
    fn omitted_assignees_preserve_the_set_and_empty_assignees_clear_it() {
        let input: Value =
            serde_json::from_str(&update_draft_input("DI_one", "Title", "Body", None)).unwrap();
        assert_eq!(
            input["variables"],
            json!({"draftIssueId":"DI_one", "title":"Title", "body":"Body"}),
        );
        assert!(input["variables"].get("assigneeIds").is_none());
        assert!(!input["query"].as_str().unwrap().contains("assigneeIds"));

        let logins = Vec::new();
        assert!(assignee_lookup_input(&logins).unwrap().is_none());
        let input: Value = serde_json::from_str(&update_draft_input(
            "DI_one", "Title", "Body", Some(&[]),
        ))
        .unwrap();
        assert_eq!(input["variables"]["assigneeIds"], json!([]));
        assert!(input["query"].as_str().unwrap().contains("assigneeIds:$assigneeIds"));
    }

    #[test]
    fn assignees_resolve_in_one_query_and_empty_lists_skip_lookup() {
        assert!(assignee_lookup_input(&[]).unwrap().is_none());
        let logins = vec!["Octo-cat2".into(), "alice_acme".into()];
        let input: Value =
            serde_json::from_str(&assignee_lookup_input(&logins).unwrap().unwrap()).unwrap();
        let document = input["query"].as_str().unwrap();
        assert_eq!(
            document,
            "query($l0:String!,$l1:String!){ u0:user(login:$l0){id} u1:user(login:$l1){id}  }",
        );
        assert_eq!(input["variables"], json!({"l0":"Octo-cat2", "l1":"alice_acme"}));
        for login in &logins {
            assert!(!document.contains(login));
            assert!(GRAPHQL_INPUT_ARGS.iter().all(|arg| !arg.contains(login)));
        }
        assert_eq!(
            GRAPHQL_INPUT_ARGS,
            ["api", "graphql", "--method", "POST", "--input", "-"],
        );
        let value = json!({"data":{"u0":{"id":"U_one"},"u1":{"id":"U_two"}}});
        assert_eq!(parse_assignee_ids(&value, &logins).unwrap(), ["U_one", "U_two"]);
        for user in [Value::Null, json!({}), json!({"id":" "})] {
            let error = parse_assignee_ids(
                &json!({"data":{"u0":{"id":"U_one"},"u1":user}}),
                &logins,
            )
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Couldn't read the draft assignees from GitHub.\ncould not resolve assignee 'alice_acme'",
            );
        }
    }

    #[tokio::test]
    async fn hostile_logins_fail_at_command_boundary_before_network() {
        for login in ["a&b", "a\"b", "a b", "", "é", "a\nb"] {
            let result = gh_update_draft_item(
                "missing-repo".into(),
                "DI_one".into(),
                "Title".into(),
                "Body".into(),
                Some(vec!["valid-login".into(), login.into()]),
            )
            .await;
            assert!(matches!(result, Err(AppError::InvalidArgument(_))));
        }
    }

    #[test]
    fn new_mutations_keep_user_text_in_stdin() {
        let hostile = "@file\n\"a&b\"\\path".repeat(4000);
        assert!(hostile.encode_utf16().count() > 32_767);
        for input in [
            graphql_input(
                &add_item_mutation(),
                json!({"projectId":hostile,"contentId":hostile}),
            ),
            update_draft_input(&hostile, &hostile, &hostile, Some(&[hostile.clone()])),
            position_input(&hostile, &hostile, Some(&hostile)),
        ] {
            let payload: Value = serde_json::from_str(&input).unwrap();
            assert!(!payload["query"].as_str().unwrap().contains(&hostile));
            for value in payload["variables"].as_object().unwrap().values() {
                assert!(value == &json!(hostile) || value == &json!([hostile]));
            }
            assert_eq!(
                GRAPHQL_INPUT_ARGS,
                ["api", "graphql", "--method", "POST", "--input", "-"],
            );
        }
    }

    fn page(nodes: Value, truncated: bool) -> Value {
        json!({"data":{"search":{"nodes":nodes,"pageInfo":{"hasNextPage":truncated}}}})
    }

    fn order_page(nodes: Value, truncated: bool) -> Value {
        json!({"data":{"updateProjectV2ItemPosition":{"items":{
            "nodes":nodes,"pageInfo":{"hasNextPage":truncated}
        }}}})
    }

    #[test]
    fn position_variables_use_null_for_top_and_an_id_for_after() {
        for after_id in [None, Some("PVTI_after")] {
            let input: Value =
                serde_json::from_str(&position_input("PVT_one", "PVTI_one", after_id)).unwrap();
            assert_eq!(
                input,
                json!({"query": POSITION_MUTATION, "variables": {
                    "projectId":"PVT_one", "itemId":"PVTI_one", "afterId":after_id
                }}),
            );
        }
    }

    #[test]
    fn board_order_preserves_payload_order_and_truncation() {
        for truncated in [false, true] {
            let value = order_page(json!([{"id":"PVTI_two"}, {"id":"PVTI_one"}]), truncated);
            let order = parse_board_order(&value).unwrap();
            assert_eq!(order.item_ids, ["PVTI_two", "PVTI_one"]);
            assert_eq!(order.truncated, truncated);
        }
    }

    #[test]
    fn board_order_skips_malformed_nodes() {
        let order = parse_board_order(&order_page(
            json!([{"id":"PVTI_two"}, null, {}, {"id":42}, {"id":" "},
                "bad", {"id":"PVTI_one"}]),
            false,
        ))
        .unwrap();
        assert_eq!(order.item_ids, ["PVTI_two", "PVTI_one"]);
        for nodes in [json!([]), Value::Null] {
            assert!(parse_board_order(&order_page(nodes, false))
                .unwrap()
                .item_ids
                .is_empty());
        }
    }

    #[test]
    fn board_order_requires_items_and_page_info() {
        for value in [
            Value::Null,
            json!({"data":{"updateProjectV2ItemPosition":{}}}),
            json!({"data":{"updateProjectV2ItemPosition":{"items":null}}}),
            json!({"data":{"updateProjectV2ItemPosition":{"items":{"nodes":[]}}}}),
            order_page(json!({"bad":"shape"}), false),
        ] {
            let error = parse_board_order(&value).err().unwrap();
            assert_single_read_error(&error, "the board's new order");
        }
    }

    #[test]
    fn board_order_wire_keys_are_camel_case() {
        assert_keys(
            serde_json::to_value(BoardOrder {
                item_ids: vec![],
                truncated: false,
            })
            .unwrap(),
            &["itemIds", "truncated"],
        );
    }

    fn assert_keys(value: Value, expected: &[&str]) {
        let mut keys: Vec<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        let mut expected = expected.to_vec();
        expected.sort_unstable();
        assert_eq!(keys, expected);
    }

    fn assert_pointer(document: &str, pointer: &str) {
        let compact: String = document.chars().filter(|c| !c.is_whitespace()).collect();
        for field in pointer.split('/').filter(|s| !s.is_empty() && *s != "data") {
            assert!(
                compact.contains(&format!("{field}("))
                    || compact.contains(&format!("{field}{{"))
                    || compact.contains(&format!("{field}}}")),
                "{document} must select {field} for {pointer}"
            );
        }
    }

    #[test]
    fn query_payload_pointers_match_selected_fields() {
        for (doc, pointer) in [
            (SEARCH_QUERY, SEARCH_POINTER),
            (REPOSITORY_QUERY, REPOSITORY_ID_POINTER),
            (ISSUE_QUERY, ISSUE_ID_POINTER),
        ] {
            assert_pointer(doc, pointer);
        }
        assert!(SEARCH_QUERY.contains("type: ISSUE_ADVANCED, first:25"));
        assert!(SEARCH_QUERY.contains("pageInfo{hasNextPage}"));
        for kind in ["Issue", "PullRequest"] {
            let arm = SEARCH_QUERY
                .split_once(&format!("... on {kind} {{"))
                .unwrap()
                .1
                .split("... on ")
                .next()
                .unwrap();
            assert_pointer(arm, CANDIDATE_REPOSITORY_POINTER);
        }
    }

    #[test]
    fn mutation_payload_pointers_match_selected_fields() {
        for (doc, pointer) in [
            (add_draft_mutation().as_str(), DRAFT_POINTER),
            (add_item_mutation().as_str(), ADD_ITEM_POINTER),
            (convert_mutation().as_str(), CONVERT_POINTER),
            (ARCHIVE_MUTATION, ARCHIVE_POINTER),
            (REMOVE_MUTATION, REMOVE_POINTER),
            (POSITION_MUTATION, ORDER_POINTER),
        ] {
            assert_pointer(doc, pointer);
        }
        for suffix in ["/nodes/id", "/pageInfo/hasNextPage"] {
            assert_pointer(POSITION_MUTATION, &format!("{ORDER_POINTER}{suffix}"));
        }
        assert!(POSITION_MUTATION.contains("items(first:100)"));
        assert!(POSITION_MUTATION.contains("afterId:$afterId"));
        assert!(!POSITION_MUTATION.contains("orderBy"));
        for doc in [convert_mutation().as_str(), ARCHIVE_MUTATION, REMOVE_MUTATION] {
            assert!(doc.contains("itemId:$itemId"));
            assert!(!doc.contains("draftIssueId"));
        }
        assert!(!add_draft_mutation().contains("assigneeIds"));
        for doc in [add_draft_mutation(), add_item_mutation(), convert_mutation()] {
            assert!(doc.contains(&board_item_selection()));
        }
        let update: Value =
            serde_json::from_str(&update_draft_input("DI_one", "", "", Some(&[]))).unwrap();
        let doc = update["query"].as_str().unwrap();
        assert_pointer(doc, UPDATE_DRAFT_POINTER);
        assert!(doc.contains(DRAFT_CONTENT_SELECTION));
        assert!(doc.contains("draftIssueId:$draftIssueId"));
        assert!(doc.contains("assigneeIds:$assigneeIds"));
    }

    #[test]
    fn search_mixed_page_skips_unknown_nodes() {
        let result = parse_candidates(
            &page(
                json!([issue(Value::Null), pr(), {"__typename":"FutureType"}]),
                false,
            ),
            "owner/repo",
        )
        .unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(result.candidates[0].kind, "issue");
        assert!(!result.candidates[0].is_draft);
        assert!(result.candidates[0].state_reason.is_none());
        assert_eq!(result.candidates[1].kind, "pr");
        assert!(result.candidates[1].is_draft);
        assert!(result.candidates[1].state_reason.is_none());
        assert!(!result.truncated);
    }

    #[test]
    fn search_skips_malformed_nodes_without_losing_valid_rows() {
        let mut missing_draft = pr();
        missing_draft.as_object_mut().unwrap().remove("isDraft");
        let result = parse_candidates(&page(json!([issue(json!("COMPLETED")), missing_draft, {"__typename":"Issue","number":"bad","repository":{"nameWithOwner":"owner/repo"}}, null, pr()]), true), "owner/repo").unwrap();
        assert_eq!(result.candidates.len(), 2);
        assert_eq!(
            result.candidates[0].state_reason.as_deref(),
            Some("COMPLETED")
        );
        assert!(result.truncated);
    }

    #[test]
    fn search_empty_and_nullable_nodes_preserve_truncation() {
        for nodes in [json!([]), Value::Null] {
            for truncated in [false, true] {
                let result =
                    parse_candidates(&page(nodes.clone(), truncated), "owner/repo").unwrap();
                assert!(result.candidates.is_empty());
                assert_eq!(result.truncated, truncated);
            }
        }
    }

    #[test]
    fn unreadable_search_is_an_error_with_a_human_surface() {
        for value in [Value::Null, page(json!({"bad":"shape"}), false)] {
            let error = parse_candidates(&value, "owner/repo").unwrap_err();
            assert!(error
                .to_string()
                .starts_with("Couldn't read the board candidates from GitHub.\n"));
        }
    }

    #[test]
    fn search_is_repo_scoped_and_trims_empty_text() {
        for text in ["", " \n "] {
            let input: Value = serde_json::from_str(&search_input("owner", "repo", text)).unwrap();
            assert_eq!(input["variables"]["q"], "repo:owner/repo sort:updated-desc");
        }
        for text in [
            "label:bug",
            "bug OR regression",
            "repo:other/x",
            "a) OR (repo:other/x",
        ] {
            let input: Value =
                serde_json::from_str(&search_input("owner", "repo", &format!("  {text}  ")))
                    .unwrap();
            assert_eq!(
                input["variables"]["q"],
                format!("repo:owner/repo sort:updated-desc ({text})")
            );
        }
    }

    #[test]
    fn search_keeps_only_matching_repositories_case_insensitively() {
        let mut foreign_issue = issue(Value::Null);
        foreign_issue["repository"]["nameWithOwner"] = json!("other/repo");
        let mut foreign_pr = pr();
        foreign_pr["repository"]["nameWithOwner"] = json!("owner/elsewhere");
        let mut case_issue = issue(Value::Null);
        case_issue["id"] = json!("I_case");
        case_issue["repository"]["nameWithOwner"] = json!("OWNER/Repo");
        let mut case_pr = pr();
        case_pr["id"] = json!("PR_case");
        case_pr["repository"]["nameWithOwner"] = json!("Owner/REPO");
        let result = parse_candidates(
            &page(
                json!([
                    foreign_issue,
                    issue(Value::Null),
                    case_issue,
                    foreign_pr,
                    pr(),
                    case_pr
                ]),
                true,
            ),
            "owner/repo",
        )
        .unwrap();
        let ids: Vec<_> = result
            .candidates
            .iter()
            .map(|candidate| candidate.id.as_str())
            .collect();
        assert_eq!(ids, ["I_one", "I_case", "PR_two", "PR_case"]);
        assert!(result.truncated);

        for repository in [
            Value::Null,
            json!({}),
            json!({"nameWithOwner":null}),
            json!({"nameWithOwner":42}),
        ] {
            let mut node = issue(Value::Null);
            node["repository"] = repository;
            assert!(parse_candidate(&node, "owner/repo").is_none());
        }
        let mut node = pr();
        node.as_object_mut().unwrap().remove("repository");
        assert!(parse_candidate(&node, "owner/repo").is_none());
    }

    #[test]
    fn repository_filter_enforces_scope_after_parenthesis_escape() {
        let mut foreign = issue(Value::Null);
        foreign["repository"]["nameWithOwner"] = json!("other/x");
        let result = parse_candidates(
            &page(json!([foreign, issue(Value::Null)]), false),
            "owner/repo",
        )
        .unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].id, "I_one");
    }

    #[test]
    fn hostile_user_text_stays_in_stdin_variables() {
        assert_eq!(
            GRAPHQL_INPUT_ARGS,
            ["api", "graphql", "--method", "POST", "--input", "-"]
        );
        for hostile in [
            "@host-file",
            "true",
            "123",
            "\"} mutation { hostile }\n\\text",
        ] {
            for (input, document, variables) in [
                (
                    search_input("owner", "repo", hostile),
                    SEARCH_QUERY,
                    json!({"q": format!("repo:owner/repo sort:updated-desc ({hostile})")}),
                ),
                (
                    draft_input(hostile, hostile, hostile),
                    add_draft_mutation().as_str(),
                    json!({"projectId": hostile, "title": hostile, "body": hostile}),
                ),
            ] {
                let payload: Value = serde_json::from_str(&input).unwrap();
                assert_eq!(payload, json!({"query": document, "variables": variables}));
                assert!(!document.contains(hostile));
                assert!(GRAPHQL_INPUT_ARGS.iter().all(|arg| !arg.contains(hostile)));
            }
        }
        assert!(SEARCH_QUERY.contains("query:$q"));
        assert!(add_draft_mutation().contains("title:$title,body:$body"));
    }

    #[test]
    fn long_draft_and_search_text_round_trip_through_stdin() {
        let text = "# Markdown\n\"quoted\" \\path @file\n".repeat(3000);
        assert!(text.encode_utf16().count() > 32_767);
        let draft: Value = serde_json::from_str(&draft_input("PVT_one", &text, &text)).unwrap();
        assert_eq!(
            draft,
            json!({"query": add_draft_mutation(), "variables": {"projectId": "PVT_one", "title": text, "body": text}})
        );
        let search: Value = serde_json::from_str(&search_input("owner", "repo", &text)).unwrap();
        assert_eq!(
            search,
            json!({"query": SEARCH_QUERY, "variables": {"q": format!("repo:owner/repo sort:updated-desc ({})", text.trim())}})
        );
        assert_eq!(
            GRAPHQL_INPUT_ARGS,
            ["api", "graphql", "--method", "POST", "--input", "-"]
        );
        assert!(GRAPHQL_INPUT_ARGS.iter().all(|arg| !arg.contains(&text)));
    }

    #[test]
    fn add_responses_return_full_items_and_reject_missing_ids() {
        for (pointer, item_type, content) in [
            (DRAFT_POINTER, "DRAFT_ISSUE", draft_content(json!([]))),
            (ADD_ITEM_POINTER, "ISSUE", issue(Value::Null)),
            (ADD_ITEM_POINTER, "PULL_REQUEST", pr()),
        ] {
            let surface = if pointer == DRAFT_POINTER {
                "the new project draft"
            } else {
                "the added project item"
            };
            let node = board_item(item_type, content);
            let mut value = json!({"data": {
                "addProjectV2DraftIssue": {"projectItem": node},
                "addProjectV2ItemById": {"item": node}
            }});
            let wire =
                serde_json::to_value(response_item(&value, pointer, surface).unwrap())
                    .unwrap();
            assert_eq!(wire["itemId"], "PVTI_one");
            assert_eq!(wire["addedAt"], "2026-09-16T12:00:00Z");
            assert_eq!(wire["content"]["createdAt"], "2026-09-15T12:00:00Z");
            assert_eq!(wire["content"]["updatedAt"], "2026-09-16T13:00:00Z");
            assert_eq!(wire["fieldValues"][0]["text"], "Keep me");
            for id in ["", "  ", "\t\n"] {
                value.pointer_mut(pointer).unwrap()["id"] = json!(id);
                let error = response_item(&value, pointer, surface).err().unwrap();
                assert_single_read_error(&error, surface);
                assert_eq!(
                    error.to_string(),
                    format!("Couldn't read {surface} from GitHub.\nmissing project item id"),
                );
            }
            for node in [Value::Null, json!({})] {
                *value.pointer_mut(pointer).unwrap() = node;
                let error = response_item(&value, pointer, surface).err().unwrap();
                assert_single_read_error(&error, surface);
            }
            let error = response_item(&Value::Null, pointer, surface).err().unwrap();
            assert_single_read_error(&error, surface);
        }
    }

    #[test]
    fn repository_and_issue_resolution_require_ids() {
        let value = json!({"data":{"repository":{"id":"R_repo","issue":{"id":"I_issue"}}}});
        assert_eq!(
            response_id(&value, REPOSITORY_ID_POINTER, "the repository").unwrap(),
            "R_repo"
        );
        assert_eq!(
            response_id(&value, ISSUE_ID_POINTER, "the issue").unwrap(),
            "I_issue"
        );
        for pointer in [REPOSITORY_ID_POINTER, ISSUE_ID_POINTER] {
            assert!(response_id(
                &json!({"data":{"repository":null}}),
                pointer,
                "the repository"
            )
            .is_err());
        }
    }

    #[test]
    fn convert_payload_parses_issue_and_rejects_other_content() {
        let payload = |content: Value| json!({"data":{"convertProjectV2DraftIssueItemToIssue":{"item":board_item("ISSUE", content)}}});
        let error = parse_converted(&payload(issue(Value::Null))).err().unwrap();
        assert_eq!(
            error.to_string(),
            "Couldn't read the converted draft from GitHub.\nmissing the issue's url",
        );
        let mut content = issue(Value::Null);
        content["number"] = json!(42);
        content["url"] = json!("https://github.com/o/r/issues/42");
        let result = parse_converted(&payload(content)).unwrap();
        assert_eq!(result.number, 42);
        assert_eq!(result.url, "https://github.com/o/r/issues/42");
        let wire = serde_json::to_value(result).unwrap();
        assert_keys(wire.clone(), &["number", "url", "item"]);
        assert_eq!(wire["item"]["fieldValues"][0]["text"], "Keep me");
        assert_eq!(wire["item"]["addedAt"], "2026-09-16T12:00:00Z");
        assert_eq!(wire["item"]["content"]["createdAt"], "2026-09-15T12:00:00Z");
        assert_eq!(wire["item"]["content"]["updatedAt"], "2026-09-16T13:00:00Z");
        for content in [
            Value::Null,
            json!({"__typename":"DraftIssue","id":"DI_one"}),
            json!({"__typename":"PullRequest","number":42,"url":"url"}),
            json!({"__typename":"Issue","number":42}),
        ] {
            assert!(parse_converted(&payload(content)).is_err());
        }
        for id in ["", "  ", "\t\n"] {
            let mut value = payload(issue(Value::Null));
            value.pointer_mut(CONVERT_POINTER).unwrap()["id"] = json!(id);
            let error = parse_converted(&value).err().unwrap();
            assert_single_read_error(&error, "the converted draft");
            assert_eq!(
                error.to_string(),
                "Couldn't read the converted draft from GitHub.\nmissing project item id",
            );
        }
        for node in [Value::Null, json!({})] {
            let value = json!({"data":{"convertProjectV2DraftIssueItemToIssue":{"item":node}}});
            let error = parse_converted(&value).err().unwrap();
            assert_single_read_error(&error, "the converted draft");
        }
        let error = parse_converted(&Value::Null).err().unwrap();
        assert_single_read_error(&error, "the converted draft");
    }

    fn assert_single_read_error(error: &AppError, surface: &str) {
        let message = error.to_string();
        assert_eq!(message.matches("Couldn't read").count(), 1, "{message}");
        assert_eq!(
            message.lines().next().unwrap(),
            format!("Couldn't read {surface} from GitHub."),
        );
    }

    #[test]
    fn archive_and_remove_require_mutation_payloads() {
        let value = json!({"data":{"archiveProjectV2Item":{"item":{"id":"PVTI_one"}},"deleteProjectV2Item":{"deletedItemId":"PVTI_one"}}});
        for pointer in [ARCHIVE_POINTER, REMOVE_POINTER] {
            assert!(require_payload(&value, pointer, "the project item").is_ok());
            assert!(require_payload(&Value::Null, pointer, "the project item").is_err());
        }
    }

    #[test]
    fn candidate_wire_keys_are_camel_case() {
        // These are structs, not tagged unions: rename_all_fields does not apply.
        let candidate = parse_candidate(&issue(Value::Null), "owner/repo").unwrap();
        let wire = serde_json::to_value(candidate).unwrap();
        assert_eq!(wire["stateReason"], Value::Null);
        assert_keys(
            wire,
            &[
                "id",
                "kind",
                "number",
                "title",
                "state",
                "isDraft",
                "stateReason",
            ],
        );
    }

    #[test]
    fn page_wire_keys_are_camel_case() {
        assert_keys(
            serde_json::to_value(BoardCandidates {
                candidates: vec![],
                truncated: false,
            })
            .unwrap(),
            &["candidates", "truncated"],
        );
    }

    #[tokio::test]
    async fn empty_adds_return_before_repo_resolution_or_network() {
        gh_add_issue_to_projects(
            "missing-repo".into(),
            1,
            vec![],
            Some("invalid-lens".into()),
        )
        .await
        .unwrap();
    }

    #[test]
    fn scope_mapping_preserves_unrelated_errors() {
        for message in [
            "gh: required scopes: ['repo']",
            "gh: requires one of the following scopes: ['repo']",
        ] {
            let error =
                search_candidates_from_response(Err(AppError::Gh(message.into())), "owner/repo")
                    .unwrap_err();
            assert_eq!(error.to_string(), message);
        }
        for message in ["gh: required scopes: project", "Missing READ:PROJECT"] {
            assert_eq!(
                map_scope_error(AppError::Gh(message.into())).to_string(),
                ITEM_EDITS_SCOPE_HINT
            );
        }
        assert_eq!(
            map_scope_error(AppError::Gh("connection reset".into())).to_string(),
            "connection reset"
        );
        assert!(matches!(
            map_scope_error(AppError::InvalidArgument("read:project".into())),
            AppError::InvalidArgument(_)
        ));
    }
}
