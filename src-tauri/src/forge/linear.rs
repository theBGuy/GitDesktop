use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_plugin_http::reqwest::{self, Client};

use crate::error::{AppError, AppResult};
use crate::forge::model::ForgeUserRef;

// ── HTTP transport ──────────────────────────────────────────────────────────────

const KEYRING_HOST: &str = "linear.app";
const KEY_TOKEN: &str = "token";
const KEY_EMAIL: &str = "email";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const API_URL: &str = "https://api.linear.app/graphql";

static CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("GitDesktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

// ── Validation ──────────────────────────────────────────────────────────────────

pub fn is_valid_team_key(s: &str) -> bool {
    let mut bytes = s.bytes();
    match bytes.next() {
        Some(b) if b.is_ascii_uppercase() => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

pub fn is_valid_identifier(s: &str) -> bool {
    let Some((team, number)) = s.rsplit_once('-') else {
        return false;
    };
    is_valid_team_key(team) && !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
}

// ── Data types ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearAccountInfo {
    pub name: String,
    pub email: String,
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearStoredAccount {
    pub email: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueInfo {
    pub identifier: String,
    pub title: String,
    pub status_name: String,
    pub status_type: String,
    pub priority_label: String,
    pub assignee: Option<ForgeUserRef>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub estimate: Option<f64>,
    pub cycle_name: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearComment {
    pub id: String,
    pub body_md: String,
    pub author: Option<ForgeUserRef>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearIssueDetails {
    pub id: String,
    pub identifier: String,
    pub title: String,
    pub status_name: String,
    pub status_type: String,
    pub priority_label: String,
    pub assignee: Option<ForgeUserRef>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub url: String,
    pub estimate: Option<f64>,
    pub cycle_name: Option<String>,
    pub project_name: Option<String>,
    pub description_md: String,
    pub comments: Vec<LinearComment>,
    pub viewer_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCreatedIssue {
    pub identifier: String,
    pub url: String,
}

// ── GraphQL transport ───────────────────────────────────────────────────────────

async fn graphql(token: &str, query: &str, variables: Value) -> AppResult<Value> {
    let body = serde_json::to_string(&json!({ "query": query, "variables": variables }))
        .unwrap_or_default();
    let resp = client()
        .post(API_URL)
        .header(reqwest::header::AUTHORIZATION, token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Command(format!("Linear request failed: {e}")))?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Command(format!("could not read Linear response: {e}")))?;

    if !(200..300).contains(&status) {
        return Err(linear_error_from_body(&text, status));
    }

    let payload: Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Command(format!("could not parse Linear response: {e}")))?;

    if let Some(errors) = payload.get("errors").and_then(Value::as_array) {
        if let Some(msg) = errors
            .first()
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            return Err(AppError::Command(format!("Linear API: {msg}")));
        }
    }

    match payload.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ => Err(AppError::Command(
            "Linear returned no data (authentication may have failed)".to_string(),
        )),
    }
}

fn linear_error_from_body(body: &str, status: u16) -> AppError {
    #[derive(Deserialize)]
    struct ErrorEnvelope {
        #[serde(default)]
        errors: Vec<ErrorItem>,
    }
    #[derive(Deserialize)]
    struct ErrorItem {
        #[serde(default)]
        message: String,
    }

    if let Ok(envelope) = serde_json::from_str::<ErrorEnvelope>(body) {
        if let Some(item) = envelope.errors.first() {
            if !item.message.is_empty() {
                return AppError::Command(item.message.clone());
            }
        }
    }

    let snippet = if body.len() > 200 { &body[..200] } else { body };
    AppError::Command(format!("Linear API error (HTTP {status}): {snippet}"))
}

// ── Keyring helpers ─────────────────────────────────────────────────────────────

fn read_token_blocking() -> AppResult<Option<String>> {
    crate::secrets::read_forge_secret(KEYRING_HOST, KEY_TOKEN)
}

fn read_email_blocking() -> AppResult<Option<String>> {
    crate::secrets::read_forge_secret(KEYRING_HOST, KEY_EMAIL)
}

async fn require_token() -> AppResult<String> {
    let token = tauri::async_runtime::spawn_blocking(read_token_blocking)
        .await
        .map_err(|e| AppError::Command(format!("keyring task failed: {e}")))?;
    match token? {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err(AppError::Command(
            "No Linear account is connected. Add your API key in Settings → Accounts.".to_string(),
        )),
    }
}

// ── Credential management ───────────────────────────────────────────────────────

pub async fn validate_token(token: &str) -> AppResult<LinearAccountInfo> {
    let query = r#"query { viewer { id name email } }"#;
    let data = graphql(token, query, json!({})).await?;
    let viewer = data
        .get("viewer")
        .ok_or_else(|| AppError::Command("Linear returned no viewer".to_string()))?;

    Ok(LinearAccountInfo {
        id: viewer
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: viewer
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        email: viewer
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

pub async fn stored_account() -> AppResult<Option<LinearStoredAccount>> {
    let email = tauri::async_runtime::spawn_blocking(read_email_blocking)
        .await
        .map_err(|e| AppError::Command(format!("keyring task failed: {e}")))?;
    match email? {
        Some(e) if !e.is_empty() => Ok(Some(LinearStoredAccount { email: e })),
        _ => Ok(None),
    }
}

pub async fn set_account(token: &str) -> AppResult<LinearAccountInfo> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(AppError::InvalidArgument("an API key is required".into()));
    }

    let info = validate_token(&token).await?;

    let kr_token = token.clone();
    let kr_email = info.email.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::secrets::set_forge_secret(KEYRING_HOST, KEY_TOKEN, &kr_token)?;
        crate::secrets::set_forge_secret(KEYRING_HOST, KEY_EMAIL, &kr_email)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Command(format!("keyring task failed: {e}")))??;

    Ok(info)
}

pub async fn clear_account() -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::delete_forge_secret(KEYRING_HOST, KEY_TOKEN)?;
        crate::secrets::delete_forge_secret(KEYRING_HOST, KEY_EMAIL)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Command(format!("keyring task failed: {e}")))?
}

// ── Team queries ────────────────────────────────────────────────────────────────

pub async fn team_list(token_override: Option<&str>) -> AppResult<Vec<LinearTeam>> {
    let token = match token_override {
        Some(t) => t.to_string(),
        None => require_token().await?,
    };

    let query = r#"query { teams { nodes { id key name } } }"#;
    let data = graphql(&token, query, json!({})).await?;

    let nodes = data
        .get("teams")
        .and_then(|t| t.get("nodes"))
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Command("Linear returned no teams".to_string()))?;

    Ok(nodes
        .iter()
        .filter_map(|node| {
            Some(LinearTeam {
                id: node.get("id").and_then(Value::as_str)?.to_string(),
                key: node.get("key").and_then(Value::as_str)?.to_string(),
                name: node.get("name").and_then(Value::as_str)?.to_string(),
            })
        })
        .collect())
}

// ── Issue operations ────────────────────────────────────────────────────────────

pub async fn issue_list(team_key: &str, state: &str) -> AppResult<Vec<LinearIssueInfo>> {
    if !is_valid_team_key(team_key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Linear team key: {team_key}"
        )));
    }

    let token = require_token().await?;

    let filter = match state {
        "open" => json!({ "state": { "type": { "nin": ["completed", "cancelled"] } } }),
        "closed" => json!({ "state": { "type": { "in": ["completed", "cancelled"] } } }),
        _ => json!({}),
    };

    let query = r#"
        query($teamId: String!, $filter: IssueFilter) {
          team(id: $teamId) {
            issues(first: 50, filter: $filter, orderBy: updatedAt) {
              nodes {
                identifier title url createdAt updatedAt estimate
                state { name type }
                priority priorityLabel
                assignee { id name email avatarUrl }
                labels { nodes { name } }
                cycle { name }
                project { name }
              }
            }
          }
        }
    "#;

    let variables = json!({ "teamId": team_key, "filter": filter });
    let data = graphql(&token, query, variables).await?;

    let team = data.get("team").filter(|v| !v.is_null()).ok_or_else(|| {
        AppError::Command(format!(
            "Linear team '{team_key}' not found — check the linked team key"
        ))
    })?;

    let nodes = team
        .get("issues")
        .and_then(|i| i.get("nodes"))
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Command("Linear returned no issues for this team".to_string()))?;

    Ok(nodes.iter().filter_map(parse_issue_info).collect())
}

pub async fn issue_view(identifier: &str) -> AppResult<LinearIssueDetails> {
    if !is_valid_identifier(identifier) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Linear issue identifier: {identifier}"
        )));
    }

    let token = require_token().await?;

    let query = r#"
        query($id: String!) {
          issue(id: $id) {
            id identifier title url createdAt updatedAt estimate description
            state { name type }
            priority priorityLabel
            assignee { id name email avatarUrl }
            labels { nodes { name } }
            cycle { name }
            project { name }
            comments { nodes { id body createdAt updatedAt user { id name email avatarUrl } } }
          }
        }
    "#;

    let variables = json!({ "id": identifier });
    let data = graphql(&token, query, variables).await?;

    let issue = data
        .get("issue")
        .ok_or_else(|| AppError::Command(format!("issue {identifier} not found")))?;

    if issue.is_null() {
        return Err(AppError::Command(format!("issue {identifier} not found")));
    }

    let viewer_id = resolve_viewer_id(&token).await;

    let comments = issue
        .get("comments")
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_comment).collect())
        .unwrap_or_default();

    Ok(LinearIssueDetails {
        id: str_field(issue, "id"),
        identifier: str_field(issue, "identifier"),
        title: str_field(issue, "title"),
        status_name: issue
            .get("state")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status_type: issue
            .get("state")
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        priority_label: str_field(issue, "priorityLabel"),
        assignee: issue.get("assignee").and_then(parse_user_ref),
        labels: parse_labels(issue),
        created_at: str_field(issue, "createdAt"),
        updated_at: str_field(issue, "updatedAt"),
        url: str_field(issue, "url"),
        estimate: issue.get("estimate").and_then(Value::as_f64),
        cycle_name: issue
            .get("cycle")
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
            .map(String::from),
        project_name: issue
            .get("project")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .map(String::from),
        description_md: str_field(issue, "description"),
        comments,
        viewer_id,
    })
}

pub async fn issue_comment(issue_id: &str, body_md: &str) -> AppResult<LinearComment> {
    let token = require_token().await?;

    let query = r#"
        mutation($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) {
            success
            comment { id body createdAt updatedAt user { id name email avatarUrl } }
          }
        }
    "#;

    let variables = json!({ "issueId": issue_id, "body": body_md });
    let data = graphql(&token, query, variables).await?;

    let comment = data
        .get("commentCreate")
        .and_then(|c| c.get("comment"))
        .ok_or_else(|| {
            AppError::Command("Linear did not return the created comment".to_string())
        })?;

    parse_comment(comment)
        .ok_or_else(|| AppError::Command("could not parse Linear comment".to_string()))
}

pub async fn issue_create(
    team_id: &str,
    title: &str,
    description_md: Option<&str>,
) -> AppResult<LinearCreatedIssue> {
    let token = require_token().await?;

    let mut input = json!({ "teamId": team_id, "title": title });
    if let Some(desc) = description_md {
        input
            .as_object_mut()
            .unwrap()
            .insert("description".to_string(), Value::String(desc.to_string()));
    }

    let query = r#"
        mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { identifier url }
          }
        }
    "#;

    let variables = json!({ "input": input });
    let data = graphql(&token, query, variables).await?;

    let issue = data
        .get("issueCreate")
        .and_then(|c| c.get("issue"))
        .ok_or_else(|| AppError::Command("Linear did not return the created issue".to_string()))?;

    Ok(LinearCreatedIssue {
        identifier: str_field(issue, "identifier"),
        url: str_field(issue, "url"),
    })
}

pub async fn issue_transition(issue_id: &str, state_id: &str) -> AppResult<()> {
    let token = require_token().await?;

    let query = r#"
        mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) {
            success
          }
        }
    "#;

    let variables = json!({ "id": issue_id, "stateId": state_id });
    let data = graphql(&token, query, variables).await?;

    let success = data
        .get("issueUpdate")
        .and_then(|u| u.get("success"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !success {
        return Err(AppError::Command(
            "Linear issue transition failed".to_string(),
        ));
    }
    Ok(())
}

pub async fn issue_assign(issue_id: &str, assignee_id: Option<&str>) -> AppResult<()> {
    let token = require_token().await?;

    let query = r#"
        mutation($id: String!, $assigneeId: String) {
          issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
            success
          }
        }
    "#;

    let variables = json!({ "id": issue_id, "assigneeId": assignee_id });
    let data = graphql(&token, query, variables).await?;

    let success = data
        .get("issueUpdate")
        .and_then(|u| u.get("success"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !success {
        return Err(AppError::Command(
            "Linear issue assignment failed".to_string(),
        ));
    }
    Ok(())
}

// ── Viewer cache ────────────────────────────────────────────────────────────────

static VIEWER_ID: OnceLock<std::sync::Mutex<Option<String>>> = OnceLock::new();

fn viewer_id_cache() -> &'static std::sync::Mutex<Option<String>> {
    VIEWER_ID.get_or_init(|| std::sync::Mutex::new(None))
}

async fn resolve_viewer_id(token: &str) -> Option<String> {
    if let Ok(guard) = viewer_id_cache().lock() {
        if let Some(ref id) = *guard {
            return Some(id.clone());
        }
    }
    let query = r#"query { viewer { id } }"#;
    let data = graphql(token, query, json!({})).await.ok()?;
    let id = data.get("viewer")?.get("id")?.as_str()?.to_string();
    if let Ok(mut guard) = viewer_id_cache().lock() {
        *guard = Some(id.clone());
    }
    Some(id)
}

// ── Parsing helpers ─────────────────────────────────────────────────────────────

fn str_field(obj: &Value, key: &str) -> String {
    obj.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn parse_user_ref(val: &Value) -> Option<ForgeUserRef> {
    if val.is_null() {
        return None;
    }
    Some(ForgeUserRef {
        id: val.get("id").and_then(Value::as_str)?.to_string(),
        label: val
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        avatar_url: val
            .get("avatarUrl")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        is_bot: false,
    })
}

fn parse_labels(issue: &Value) -> Vec<String> {
    issue
        .get("labels")
        .and_then(|l| l.get("nodes"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|n| n.get("name").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_issue_info(node: &Value) -> Option<LinearIssueInfo> {
    Some(LinearIssueInfo {
        identifier: node.get("identifier").and_then(Value::as_str)?.to_string(),
        title: str_field(node, "title"),
        status_name: node
            .get("state")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status_type: node
            .get("state")
            .and_then(|s| s.get("type"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        priority_label: str_field(node, "priorityLabel"),
        assignee: node.get("assignee").and_then(parse_user_ref),
        labels: parse_labels(node),
        created_at: str_field(node, "createdAt"),
        updated_at: str_field(node, "updatedAt"),
        url: str_field(node, "url"),
        estimate: node.get("estimate").and_then(Value::as_f64),
        cycle_name: node
            .get("cycle")
            .and_then(|c| c.get("name"))
            .and_then(Value::as_str)
            .map(String::from),
        project_name: node
            .get("project")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .map(String::from),
    })
}

fn parse_comment(node: &Value) -> Option<LinearComment> {
    Some(LinearComment {
        id: node.get("id").and_then(Value::as_str)?.to_string(),
        body_md: str_field(node, "body"),
        author: node.get("user").and_then(parse_user_ref),
        created_at: str_field(node, "createdAt"),
        updated_at: node
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_team_keys() {
        assert!(is_valid_team_key("ENG"));
        assert!(is_valid_team_key("A"));
        assert!(is_valid_team_key("ENG2"));
        assert!(!is_valid_team_key(""));
        assert!(!is_valid_team_key("eng"));
        assert!(!is_valid_team_key("2ENG"));
        assert!(!is_valid_team_key("ENG-"));
    }

    #[test]
    fn valid_identifiers() {
        assert!(is_valid_identifier("ENG-123"));
        assert!(is_valid_identifier("A-1"));
        assert!(is_valid_identifier("AB2-99"));
        assert!(!is_valid_identifier(""));
        assert!(!is_valid_identifier("ENG"));
        assert!(!is_valid_identifier("eng-123"));
        assert!(!is_valid_identifier("ENG-"));
        assert!(!is_valid_identifier("-123"));
    }
}
