//! Projects v2 status updates. GitHub-only by design, like saved views: GitLab and
//! Bitbucket have no equivalent resource.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::project_item_edits::{graphql_input, GRAPHQL_INPUT_ARGS};
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusUpdates {
    pub updates: Vec<ProjectStatusUpdate>,
    pub total_count: u64,
    pub truncated: bool,
}

/// One status update, newest-first in its connection. `status` rides VERBATIM as
/// GitHub's enum spelling — a bare string rather than a Rust enum, so a value
/// GitHub adds later reaches the frontend's fallback arm instead of dropping the
/// node. GitHub's own field names are camelCase too, so one shape reads and writes.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusUpdate {
    pub id: String,
    pub body: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub creator: Option<StatusUpdateCreator>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdateCreator {
    #[serde(default)]
    pub login: String,
    #[serde(default)]
    pub avatar_url: String,
}

const READ_SCOPE_HINT: &str =
    "GitHub project status updates need the read:project (or project) scope. Run:  gh auth refresh -s project";
const WRITE_SCOPE_HINT: &str =
    "Posting GitHub project status updates needs the project scope. Run:  gh auth refresh -s project";
const UPDATES_POINTER: &str = "/data/node/statusUpdates";
const CREATE_POINTER: &str = "/data/createProjectV2StatusUpdate/statusUpdate";
const UPDATE_POINTER: &str = "/data/updateProjectV2StatusUpdate/statusUpdate";
const DELETE_POINTER: &str = "/data/deleteProjectV2StatusUpdate/deletedStatusUpdateId";
const NODE_SELECTION: &str =
    "id body status startDate targetDate createdAt updatedAt creator{ login avatarUrl }";

fn map_scope_error(e: AppError, hint: &str) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(hint.to_string());
        }
    }
    e
}

fn status_updates_query() -> String {
    // Keep first:25 paired with the history's "older updates" note: the frontend
    // reads `truncated` as "GitHub holds more than this read asked for".
    format!(
        "query($id:ID!){{ node(id:$id){{ ... on ProjectV2 {{ \
         statusUpdates(first:25, orderBy:{{field:CREATED_AT, direction:DESC}}){{ \
         totalCount pageInfo{{hasNextPage}} nodes{{ {NODE_SELECTION} }} }} }} }} }}"
    )
}

fn build_read_args(project_id: &str) -> Vec<String> {
    vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={}", status_updates_query()),
        "-f".to_string(),
        format!("id={project_id}"),
    ]
}

fn parse_node(node: &Value) -> Option<ProjectStatusUpdate> {
    let mut update: ProjectStatusUpdate = serde_json::from_value(node.clone()).ok()?;
    if update.id.trim().is_empty() {
        return None;
    }
    // A creator GitHub sent with no login (a deleted account) names no one.
    if update.creator.as_ref().is_some_and(|c| c.login.is_empty()) {
        update.creator = None;
    }
    Some(update)
}

fn parse_status_updates(value: &Value) -> ProjectStatusUpdates {
    let connection = value.pointer(UPDATES_POINTER).unwrap_or(&Value::Null);
    let updates: Vec<_> = connection["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_node)
        .collect();
    ProjectStatusUpdates {
        // The server's figure when it sent one; otherwise the only count this read
        // can vouch for is what it holds.
        total_count: connection["totalCount"]
            .as_u64()
            .unwrap_or(updates.len() as u64),
        truncated: connection["pageInfo"]["hasNextPage"]
            .as_bool()
            .unwrap_or(false),
        updates,
    }
}

/// An empty or blank value is no value: the editor's cleared fields arrive as `""`.
fn present(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

fn validate_status(status: &str) -> AppResult<()> {
    // An uppercase GraphQL enum name: the Name grammar (no leading digit) cut to the
    // uppercase spelling enums use. Digits stay legal after the first character, so
    // an edit can keep a future value like `PHASE2`. Variables already isolate it
    // from the document; this fails a malformed value here, not at the server.
    let mut bytes = status.bytes();
    let well_formed = bytes
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == b'_')
        && bytes.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_');
    if !well_formed {
        return Err(AppError::InvalidArgument(
            "Invalid project status update status".into(),
        ));
    }
    Ok(())
}

fn validate_date(date: &str) -> AppResult<()> {
    let bytes = date.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    if !shaped {
        return Err(AppError::InvalidArgument(
            "Project status update dates must be YYYY-MM-DD".into(),
        ));
    }
    Ok(())
}

/// The four content fields, normalized and validated once for both writes.
struct StatusContent {
    status: Option<String>,
    body: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
}

impl StatusContent {
    fn new(
        status: Option<String>,
        body: Option<String>,
        start_date: Option<String>,
        target_date: Option<String>,
    ) -> AppResult<Self> {
        let content = Self {
            status: present(status),
            body: present(body),
            start_date: present(start_date),
            target_date: present(target_date),
        };
        if let Some(status) = &content.status {
            validate_status(status)?;
        }
        for date in [&content.start_date, &content.target_date]
            .into_iter()
            .flatten()
        {
            validate_date(date)?;
        }
        Ok(content)
    }

    /// Refuses content with none of the four fields. GitHub rejects a create that
    /// is that empty, and an all-null edit is unprobed, so the edit is held to the
    /// same rule here, before the network, in the dialog's own words.
    fn require_any(self) -> AppResult<Self> {
        if self.status.is_none()
            && self.body.is_none()
            && self.start_date.is_none()
            && self.target_date.is_none()
        {
            return Err(AppError::InvalidArgument(
                "Keep a status, a note or a date on the update".into(),
            ));
        }
        Ok(self)
    }
}

/// The create sends only the fields that are present, since a new update has
/// nothing to clear. Status is REQUIRED here, which is also what satisfies
/// GitHub's rule that a create carry at least one content field.
fn create_input(project_id: &str, status: &str, content: &StatusContent) -> AppResult<String> {
    validate_status(status)?;
    let mut variables = json!({"projectId": project_id, "status": status});
    let mut declarations = vec![
        "$projectId:ID!".to_string(),
        "$status:ProjectV2StatusUpdateStatus".to_string(),
    ];
    let mut fields = vec![
        "projectId:$projectId".to_string(),
        "status:$status".to_string(),
    ];
    for (name, graphql_type, value) in [
        ("body", "String", &content.body),
        ("startDate", "Date", &content.start_date),
        ("targetDate", "Date", &content.target_date),
    ] {
        if let Some(value) = value {
            variables[name] = json!(value);
            declarations.push(format!("${name}:{graphql_type}"));
            fields.push(format!("{name}:${name}"));
        }
    }
    let document = format!(
        "mutation({}){{ createProjectV2StatusUpdate(input:{{{}}}){{ statusUpdate{{ {NODE_SELECTION} }} }} }}",
        declarations.join(","),
        fields.join(",")
    );
    Ok(graphql_input(&document, variables))
}

/// The update sends ALL FOUR content fields every time. GitHub reads an omitted
/// field as "leave it" and an explicit null as "clear it" (probed), and the editor
/// always holds the whole current state — so `None` has to reach the server as
/// null, or clearing a field in the editor would silently keep it.
fn update_input(status_update_id: &str, content: &StatusContent) -> String {
    graphql_input(
        &format!(
            "mutation($statusUpdateId:ID!,$status:ProjectV2StatusUpdateStatus,$body:String,$startDate:Date,$targetDate:Date){{ \
             updateProjectV2StatusUpdate(input:{{statusUpdateId:$statusUpdateId,status:$status,body:$body,startDate:$startDate,targetDate:$targetDate}}){{ \
             statusUpdate{{ {NODE_SELECTION} }} }} }}"
        ),
        json!({
            "statusUpdateId": status_update_id,
            "status": content.status,
            "body": content.body,
            "startDate": content.start_date,
            "targetDate": content.target_date,
        }),
    )
}

fn delete_input(status_update_id: &str) -> String {
    graphql_input(
        "mutation($statusUpdateId:ID!){ deleteProjectV2StatusUpdate(input:{statusUpdateId:$statusUpdateId}){ deletedStatusUpdateId } }",
        json!({"statusUpdateId": status_update_id}),
    )
}

fn response_update(value: &Value, pointer: &str, surface: &str) -> AppResult<ProjectStatusUpdate> {
    value
        .pointer(pointer)
        .and_then(parse_node)
        .ok_or_else(|| gh_unreadable(surface, format!("missing status update at {pointer}")))
}

async fn write(repo_path: &str, input: &str, surface: &str) -> AppResult<Value> {
    let out = run_gh_input(
        Some(repo_path),
        &GRAPHQL_INPUT_ARGS,
        input,
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| map_scope_error(e, WRITE_SCOPE_HINT))?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable(surface, format!("could not parse the response: {e}")))
}

#[tauri::command]
pub async fn gh_project_status_updates(
    repo_path: String,
    project_id: String,
) -> AppResult<ProjectStatusUpdates> {
    let args = build_read_args(&project_id);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT)
        .await
        .map_err(|e| map_scope_error(e, READ_SCOPE_HINT))?;
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the project status updates",
            format!("could not parse the project's status updates: {e}"),
        )
    })?;
    Ok(parse_status_updates(&value))
}

#[tauri::command]
pub async fn gh_create_project_status_update(
    repo_path: String,
    project_id: String,
    status: String,
    body: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
) -> AppResult<ProjectStatusUpdate> {
    let content = StatusContent::new(None, body, start_date, target_date)?;
    let input = create_input(&project_id, &status, &content)?;
    let value = write(&repo_path, &input, "the new status update").await?;
    response_update(&value, CREATE_POINTER, "the new status update")
}

#[tauri::command]
pub async fn gh_update_project_status_update(
    repo_path: String,
    status_update_id: String,
    status: Option<String>,
    body: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
) -> AppResult<ProjectStatusUpdate> {
    let content = StatusContent::new(status, body, start_date, target_date)?.require_any()?;
    let input = update_input(&status_update_id, &content);
    let value = write(&repo_path, &input, "the updated status update").await?;
    response_update(&value, UPDATE_POINTER, "the updated status update")
}

#[tauri::command]
pub async fn gh_delete_project_status_update(
    repo_path: String,
    status_update_id: String,
) -> AppResult<()> {
    let value = write(
        &repo_path,
        &delete_input(&status_update_id),
        "the deleted status update",
    )
    .await?;
    match value.pointer(DELETE_POINTER).and_then(Value::as_str) {
        Some(id) if !id.trim().is_empty() => Ok(()),
        _ => Err(gh_unreadable(
            "the deleted status update",
            format!("missing id at {DELETE_POINTER}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn content(
        status: Option<&str>,
        body: Option<&str>,
        start: Option<&str>,
        target: Option<&str>,
    ) -> StatusContent {
        StatusContent::new(
            status.map(str::to_string),
            body.map(str::to_string),
            start.map(str::to_string),
            target.map(str::to_string),
        )
        .expect("valid content")
    }

    fn input_json(input: &str) -> Value {
        serde_json::from_str(input).expect("input is JSON")
    }

    #[test]
    fn probe_payload_deserializes_with_null_and_unknown_statuses() {
        // Captured from the fixture project (2026-09-24), plus one node carrying an
        // enum value this build doesn't know and one with every field populated.
        let response = json!({"data":{"node":{"statusUpdates":{
            "nodes":[
                {"body":null,"createdAt":"2026-09-24T15:56:42Z","id":"PVTSU_lAHOA5g8vs4AIsECzgAEBog","status":"COMPLETE"},
                {"body":"probe body v2","createdAt":"2026-09-24T15:56:07Z","id":"PVTSU_lAHOA5g8vs4AIsECzgAEBoc","status":null},
                {"body":"later","createdAt":"2026-09-23T10:00:00Z","id":"PVTSU_future","status":"PAUSED_FOR_REVIEW"},
                {"body":"full","createdAt":"2026-09-22T10:00:00Z","updatedAt":"2026-09-22T11:00:00Z",
                    "id":"PVTSU_full","status":"AT_RISK","startDate":"2026-09-01","targetDate":"2026-10-08",
                    "creator":{"login":"octocat","avatarUrl":"https://example.com/a.png"}}
            ],
            "pageInfo":{"endCursor":"Mg","hasNextPage":false},
            "totalCount":2
        }}}});
        let parsed = parse_status_updates(&response);
        assert_eq!(parsed.total_count, 2);
        assert!(!parsed.truncated);
        let wire = serde_json::to_value(&parsed).unwrap();
        assert_keys(&wire, &["updates", "totalCount", "truncated"]);
        let updates = wire["updates"].as_array().unwrap();
        assert_eq!(updates.len(), 4);
        for update in updates {
            assert_keys(
                update,
                &[
                    "id",
                    "body",
                    "status",
                    "startDate",
                    "targetDate",
                    "creator",
                    "createdAt",
                    "updatedAt",
                ],
            );
        }
        assert_eq!(updates[0]["status"], "COMPLETE");
        assert_eq!(updates[0]["body"], Value::Null);
        assert_eq!(updates[0]["creator"], Value::Null);
        assert_eq!(updates[0]["updatedAt"], Value::Null);
        assert_eq!(updates[1]["status"], Value::Null);
        assert_eq!(updates[1]["body"], "probe body v2");
        // Verbatim, never dropped or coerced: the frontend owns the fallback arm.
        assert_eq!(updates[2]["status"], "PAUSED_FOR_REVIEW");
        assert_eq!(updates[3]["startDate"], "2026-09-01");
        assert_eq!(updates[3]["targetDate"], "2026-10-08");
        assert_eq!(updates[3]["updatedAt"], "2026-09-22T11:00:00Z");
        assert_eq!(
            updates[3]["creator"],
            json!({"login":"octocat","avatarUrl":"https://example.com/a.png"})
        );
        assert_keys(&updates[3]["creator"], &["login", "avatarUrl"]);
    }

    #[test]
    fn partial_connections_and_nodes_are_tolerated() {
        let response = json!({"data":{"node":{"statusUpdates":{"nodes":[
            null,
            {},
            {"id":"  ","createdAt":"2026-09-24T00:00:00Z"},
            {"id":"no-date"},
            {"id":"ghost","createdAt":"2026-09-24T00:00:00Z","creator":{}},
            {"id":"no-avatar","createdAt":"2026-09-24T00:00:00Z","creator":{"login":"a"}}
        ],"pageInfo":{"hasNextPage":true}}}}});
        let parsed = parse_status_updates(&response);
        assert!(parsed.truncated);
        let ids: Vec<_> = parsed.updates.iter().map(|u| u.id.as_str()).collect();
        assert_eq!(ids, ["ghost", "no-avatar"]);
        assert!(parsed.updates[0].creator.is_none());
        assert_eq!(parsed.updates[1].creator.as_ref().unwrap().avatar_url, "");
        // No server figure: the count falls back to what the read holds.
        assert_eq!(parsed.total_count, 2);
        for response in [
            Value::Null,
            json!({"data":{"node":null}}),
            json!({"data":{"node":{"statusUpdates":{"nodes":null}}}}),
        ] {
            let parsed = parse_status_updates(&response);
            assert!(parsed.updates.is_empty());
            assert_eq!(parsed.total_count, 0);
            assert!(!parsed.truncated);
        }
    }

    #[test]
    fn read_query_pins_order_page_size_and_fields() {
        let query = status_updates_query();
        assert!(query.starts_with("query($id:ID!)"));
        assert!(query.contains("node(id:$id){ ... on ProjectV2 {"));
        assert!(
            query.contains("statusUpdates(first:25, orderBy:{field:CREATED_AT, direction:DESC})")
        );
        assert!(query.contains("totalCount pageInfo{hasNextPage}"));
        // By whole TOKEN over the node selection alone: a substring test would let
        // `id` pass on `$id` and `status` on `statusUpdates` with either dropped.
        let tokens: Vec<_> = NODE_SELECTION
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|token| !token.is_empty())
            .collect();
        for field in [
            "id",
            "body",
            "status",
            "startDate",
            "targetDate",
            "createdAt",
            "updatedAt",
            "creator",
            "login",
            "avatarUrl",
        ] {
            assert!(
                tokens.contains(&field),
                "node selection no longer asks for `{field}`"
            );
        }
        // The two creator fields are the creator's, not the update's.
        assert!(NODE_SELECTION.contains("creator{ login avatarUrl }"));
        assert!(query.contains(&format!("nodes{{ {NODE_SELECTION} }}")));
        assert!(!query.contains("bodyHTML"));
        assert_eq!(query.matches('{').count(), query.matches('}').count());
    }

    #[test]
    fn project_id_is_a_raw_graphql_variable() {
        let id = "@project\"}";
        let args = build_read_args(id);
        assert_eq!(&args[..2], &["api", "graphql"]);
        assert_eq!(args.len(), 6);
        assert_eq!(args[3], format!("query={}", status_updates_query()));
        assert_eq!(args[5], format!("id={id}"));
        for pair in args[2..].chunks_exact(2) {
            assert_eq!(pair[0], "-f");
        }
    }

    #[test]
    fn update_serializes_every_absent_field_as_explicit_null() {
        let input = input_json(&update_input(
            "PVTSU_one",
            &content(None, Some(""), None, Some("   ")),
        ));
        assert_eq!(
            input["variables"],
            json!({"statusUpdateId":"PVTSU_one","status":null,"body":null,
                "startDate":null,"targetDate":null})
        );
        // Present keys with null values — an omitted key would mean "leave as is".
        assert_keys(
            &input["variables"],
            &[
                "statusUpdateId",
                "status",
                "body",
                "startDate",
                "targetDate",
            ],
        );
        let document = input["query"].as_str().unwrap();
        assert!(document
            .contains("status:$status,body:$body,startDate:$startDate,targetDate:$targetDate"));
        assert!(document.contains("$status:ProjectV2StatusUpdateStatus,"));

        let input = input_json(&update_input(
            "PVTSU_one",
            &content(
                Some("ON_TRACK"),
                Some("Body"),
                Some("2026-09-01"),
                Some("2026-10-08"),
            ),
        ));
        assert_eq!(
            input["variables"],
            json!({"statusUpdateId":"PVTSU_one","status":"ON_TRACK","body":"Body",
                "startDate":"2026-09-01","targetDate":"2026-10-08"})
        );
    }

    #[test]
    fn create_always_carries_status_and_only_present_fields() {
        let input = input_json(
            &create_input("PVT_one", "INACTIVE", &content(None, Some(""), None, None)).unwrap(),
        );
        assert_eq!(
            input["variables"],
            json!({"projectId":"PVT_one","status":"INACTIVE"})
        );
        let document = input["query"].as_str().unwrap();
        assert!(document.starts_with(
            "mutation($projectId:ID!,$status:ProjectV2StatusUpdateStatus){ createProjectV2StatusUpdate(input:{projectId:$projectId,status:$status}){"
        ));
        assert!(!document.contains("$body"));

        let input = input_json(
            &create_input(
                "PVT_one",
                "OFF_TRACK",
                &content(
                    None,
                    Some("**Blocked** on review"),
                    Some("2026-09-01"),
                    Some("2026-10-08"),
                ),
            )
            .unwrap(),
        );
        assert_eq!(
            input["variables"],
            json!({"projectId":"PVT_one","status":"OFF_TRACK","body":"**Blocked** on review",
                "startDate":"2026-09-01","targetDate":"2026-10-08"})
        );
        let document = input["query"].as_str().unwrap();
        assert!(document.contains("$body:String,$startDate:Date,$targetDate:Date"));
        assert!(document.contains(
            "projectId:$projectId,status:$status,body:$body,startDate:$startDate,targetDate:$targetDate"
        ));
    }

    #[test]
    fn create_without_a_status_is_refused_before_the_network() {
        // GitHub refuses a create with no content field at all; requiring the status
        // at this boundary means a create can never be that empty request.
        for status in ["", "on_track", "ON TRACK", "ON_TRACK\"){x}"] {
            assert!(matches!(
                create_input("PVT_one", status, &content(None, Some("Body"), None, None)),
                Err(AppError::InvalidArgument(_))
            ));
        }
    }

    #[test]
    fn malformed_statuses_and_dates_are_refused() {
        for (status, start) in [
            (Some("on_track"), None),
            (None, Some("2026-9-1")),
            (None, Some("20260901xx")),
            (None, Some("2026/09/01")),
        ] {
            assert!(StatusContent::new(
                status.map(str::to_string),
                None,
                start.map(str::to_string),
                None
            )
            .is_err());
        }
        // Blank fields are absent, never validated as values.
        assert!(StatusContent::new(Some(String::new()), None, Some(" ".into()), None).is_ok());
        // Statuses follow the uppercase enum-name grammar. Digits after the first
        // character are legal, so a value GitHub adds later stays editable.
        for status in ["ON_TRACK", "PHASE2", "SHA256", "_PRIVATE", "A1_B2"] {
            assert!(validate_status(status).is_ok(), "{status} should pass");
            assert!(StatusContent::new(Some(status.into()), None, None, None).is_ok());
        }
        for status in ["", "2PHASE", "9", "Phase2", "ON-TRACK", "ON TRACK", "ÉTAT"] {
            assert!(
                matches!(validate_status(status), Err(AppError::InvalidArgument(_))),
                "{status} should be refused"
            );
        }
    }

    #[tokio::test]
    async fn an_all_empty_edit_is_refused_before_the_network() {
        // A repo path that doesn't exist: a gh invocation would fail with some
        // OTHER error, so InvalidArgument proves the refusal came first.
        for (status, body, start, target) in [
            (None, None, None, None),
            (Some(""), Some("  "), Some(""), Some(" ")),
        ] {
            let result = gh_update_project_status_update(
                "missing-repo".into(),
                "PVTSU_one".into(),
                status.map(str::to_string),
                body.map(str::to_string),
                start.map(str::to_string),
                target.map(str::to_string),
            )
            .await;
            // The dialog's held reason, word for word (ProjectStatusStrip.tsx).
            assert!(matches!(
                result,
                Err(AppError::InvalidArgument(ref m))
                    if m == "Keep a status, a note or a date on the update"
            ));
        }
        // Any one field is enough content.
        for fields in [
            content(Some("ON_TRACK"), None, None, None),
            content(None, Some("Note"), None, None),
            content(None, None, Some("2026-09-01"), None),
            content(None, None, None, Some("2026-10-08")),
        ] {
            assert!(fields.require_any().is_ok());
        }
    }

    #[test]
    fn delete_addresses_the_update_by_variable() {
        let input = input_json(&delete_input("PVTSU_\"x"));
        assert_eq!(input["variables"], json!({"statusUpdateId":"PVTSU_\"x"}));
        assert!(!input["query"].as_str().unwrap().contains("PVTSU_"));
    }

    #[test]
    fn mutation_payloads_parse_or_fail_closed() {
        let node = json!({"id":"PVTSU_new","status":"ON_TRACK","body":null,
            "createdAt":"2026-09-24T00:00:00Z","updatedAt":"2026-09-24T00:00:00Z",
            "creator":{"login":"octocat","avatarUrl":""}});
        let value = json!({"data":{"createProjectV2StatusUpdate":{"statusUpdate":node}}});
        let update = response_update(&value, CREATE_POINTER, "x").unwrap();
        assert_eq!(update.id, "PVTSU_new");
        assert_eq!(update.status.as_deref(), Some("ON_TRACK"));
        for value in [
            json!({"data":{"createProjectV2StatusUpdate":{"statusUpdate":null}}}),
            json!({"data":{"createProjectV2StatusUpdate":{"statusUpdate":{"id":""}}}}),
            json!({"data":null}),
        ] {
            assert!(response_update(&value, CREATE_POINTER, "x").is_err());
        }
    }

    #[test]
    fn scope_errors_map_to_each_hint_and_other_errors_survive() {
        for (hint, raw) in [
            (READ_SCOPE_HINT, "GraphQL: Your token has not been granted the required scopes to execute this query."),
            (WRITE_SCOPE_HINT, "missing scope read:project"),
        ] {
            let AppError::Gh(message) = map_scope_error(AppError::Gh(raw.into()), hint) else {
                panic!("expected Gh error");
            };
            assert_eq!(message, hint);
        }
        assert_eq!(
            map_scope_error(AppError::Gh("connection reset".into()), READ_SCOPE_HINT).to_string(),
            "connection reset"
        );
    }
}
