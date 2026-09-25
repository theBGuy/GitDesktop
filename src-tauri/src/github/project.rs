//! GitHub Projects v2 membership for issues and PRs. GitHub-only by design: no
//! forge routing, since GitLab/Bitbucket have no equivalent resource.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::issue::repo_owner_name;
use crate::github::pr::validate_graphql_embed;
use crate::github::project_item_edits::{graphql_input, GRAPHQL_INPUT_ARGS};
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GhOutput, GH_NETWORK_TIMEOUT};

/// A project the signed-in user can see. `viewer_can_update` decides whether the
/// picker may offer it as a link target; closed projects are returned too so the
/// frontend can render an existing membership in a closed project.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectV2Ref {
    pub id: String,
    pub title: String,
    pub number: u64,
    pub closed: bool,
    pub viewer_can_update: bool,
    /// GitHub's own verdicts for the close and reopen writes, which gate apart
    /// from `viewer_can_update`. False when a read didn't carry them.
    pub viewer_can_close: bool,
    pub viewer_can_reopen: bool,
    /// Absent (not null) when the project has none, so a descriptionless project
    /// keeps its wire shape. `PROJECT_FIELDS` is shared, so the membership reads
    /// carry it too when present; their consumers accept the extra key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
}

/// One membership: the project plus the ITEM id inside it, which
/// `deleteProjectV2Item` needs alongside the project id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemRef {
    pub item_id: String,
    pub project: ProjectV2Ref,
}

/// One issue/PR's board memberships, plus whether the capped read left some out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjects {
    pub items: Vec<ProjectItemRef>,
    /// The item's `projectItems(first:20)` connection reported another page.
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableProjects {
    pub projects: Vec<ProjectV2Ref>,
    /// The list is known to be incomplete — either arm had more than the 50
    /// fetched, or one arm didn't answer at all (denied). The picker says so
    /// rather than implying these are all of them.
    pub truncated: bool,
    /// The repository's and its owner's node ids, which a create addresses: the
    /// owner holds the new project and the repository is linked to it. The
    /// repository id is None when its arm didn't answer; the owner id falls back to
    /// the owner arm's, and is None only when neither arm named it.
    pub repository_id: Option<String>,
    /// The names a create dialog shows for those two ids, each from the same arm
    /// as its id.
    pub repository_name_with_owner: Option<String>,
    pub owner_id: Option<String>,
    pub owner_login: Option<String>,
}

/// The editable details of a project. Every field is optional and an absent one
/// is OMITTED from the mutation, which GitHub reads as "leave it".
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemRemove {
    pub project_id: String,
    pub item_id: String,
}

const PROJECT_SCOPE_HINT: &str =
    "GitHub Projects need the project scope. Run:  gh auth refresh -s project";

/// Projects v2 needs the `read:project` scope to read and `project` to write,
/// neither of which a default `gh auth login` grants — turn both the GraphQL
/// `INSUFFICIENT_SCOPES` wording and gh's own CLI scope error into one hint.
fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(PROJECT_SCOPE_HINT.to_string());
        }
    }
    e
}

/// A `ProjectV2` node, skipped entirely when it carries no id (the one field
/// every caller keys on: mutations address a board by it, and the rail matches
/// its field lines to the memberships by it); the rest default rather than fail
/// the read.
pub(super) fn project_ref(node: &Value) -> Option<ProjectV2Ref> {
    Some(ProjectV2Ref {
        id: node.get("id")?.as_str()?.to_string(),
        title: node
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        number: node.get("number").and_then(Value::as_u64).unwrap_or(0),
        closed: node.get("closed").and_then(Value::as_bool).unwrap_or(false),
        viewer_can_update: node
            .get("viewerCanUpdate")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        viewer_can_close: node
            .get("viewerCanClose")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        viewer_can_reopen: node
            .get("viewerCanReopen")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        short_description: node
            .get("shortDescription")
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty())
            .map(str::to_string),
    })
}

pub(super) const PROJECT_FIELDS: &str =
    "id title number closed viewerCanUpdate viewerCanClose viewerCanReopen shortDescription";

/// `repositoryOwner` resolves a User or an Organization and both implement
/// `ProjectV2Owner`, so one inline fragment covers owner-level projects for either.
fn available_query() -> String {
    format!(
        "query($owner:String!,$name:String!){{ \
         repository(owner:$owner,name:$name){{ id nameWithOwner owner{{ id login }} projectsV2(first:50){{ pageInfo{{ hasNextPage }} nodes{{ {PROJECT_FIELDS} }} }} }} \
         repositoryOwner(login:$owner){{ id login ... on ProjectV2Owner{{ projectsV2(first:50){{ pageInfo{{ hasNextPage }} nodes{{ {PROJECT_FIELDS} }} }} }} }} \
         }}"
    )
}

/// The two `projectsV2` connections [`available_query`] asks for, repo-linked
/// first — the order the merge preserves.
const AVAILABLE_ARMS: [&str; 2] = [
    "/data/repository/projectsV2",
    "/data/repositoryOwner/projectsV2",
];

/// Whether this arm came back as a connection object rather than null.
fn arm_present(value: &Value, base: &str) -> bool {
    value.pointer(base).is_some_and(Value::is_object)
}

/// Whether either arm answered. That — not a non-empty list — is the evidence
/// that the read partly succeeded: a repo with no boards answers with an empty
/// `nodes`, which is a legitimate empty catalog rather than a failure to report.
fn any_arm_present(value: &Value) -> bool {
    AVAILABLE_ARMS.iter().any(|base| arm_present(value, base))
}

/// Merges the two arms repo-linked-first, deduped by id: an owner-level project
/// that is also linked to the repo must keep the repo-linked position. A null arm
/// contributes nothing — GraphQL nulls the arm it couldn't resolve (a missing
/// owner at exit 0, a per-arm permission denial alongside an `errors` entry) while
/// still answering the other.
fn merge_available(value: &Value) -> AvailableProjects {
    let arm = |base: &str| -> (Vec<ProjectV2Ref>, bool) {
        let nodes = value
            .pointer(&format!("{base}/nodes"))
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(project_ref).collect())
            .unwrap_or_default();
        let has_next = value
            .pointer(&format!("{base}/pageInfo/hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        (nodes, has_next)
    };
    let (repo_linked, repo_more) = arm(AVAILABLE_ARMS[0]);
    let (owner_level, owner_more) = arm(AVAILABLE_ARMS[1]);
    // One arm answering while the other stayed silent is a partial catalog, and
    // rides the same flag as the 50-cap: "no projects" would otherwise speak for
    // an arm that refused to answer.
    let half_answered =
        arm_present(value, AVAILABLE_ARMS[0]) != arm_present(value, AVAILABLE_ARMS[1]);

    let mut seen = std::collections::HashSet::new();
    let projects = repo_linked
        .into_iter()
        .chain(owner_level)
        .filter(|p| seen.insert(p.id.clone()))
        .collect();
    let id_at = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    };
    // The repository arm's owner first; the owner arm's own id keeps a create
    // possible when only the repository arm was denied. The login rides with the
    // id from the SAME arm, so the name a dialog shows is the account written to.
    let (owner_id, owner_login) = match id_at("/data/repository/owner/id") {
        Some(id) => (Some(id), id_at("/data/repository/owner/login")),
        None => (
            id_at("/data/repositoryOwner/id"),
            id_at("/data/repositoryOwner/login"),
        ),
    };
    AvailableProjects {
        projects,
        truncated: repo_more || owner_more || half_answered,
        repository_id: id_at("/data/repository/id"),
        repository_name_with_owner: id_at("/data/repository/nameWithOwner"),
        owner_id,
        owner_login,
    }
}

/// Rebuilds the error `run_gh` would have raised for a non-zero exit, for the
/// paths that read the body first and only then decide the call failed.
fn gh_failure(out: &GhOutput) -> AppError {
    let msg = out.stderr.trim();
    AppError::Gh(if msg.is_empty() {
        format!("gh exited with code {}", out.code)
    } else {
        msg.to_string()
    })
}

/// Decides the catalog from a raw gh result, tolerating a partial failure:
/// `gh api graphql` exits non-zero whenever the response carries an `errors`
/// array even when `data` is populated (measured), which is exactly what a
/// viewer denied only the owner's boards receives. An arm that answered at all
/// wins over reporting the arm that didn't, so only a read where NEITHER arm
/// came back errors — and that error keeps the scope mapping's actionable
/// wording, which the picker renders verbatim. Unparseable output at exit 0
/// keeps its own error.
fn available_from_output(out: &GhOutput) -> AppResult<AvailableProjects> {
    let parsed: Option<Value> = serde_json::from_str(&out.stdout_lossy()).ok();
    match parsed {
        Some(ref v) if any_arm_present(v) => Ok(merge_available(v)),
        _ if out.code != 0 => Err(map_scope_error(gh_failure(out))),
        // A clean exit is an answer even with both arms absent (owner not found).
        Some(ref v) => Ok(merge_available(v)),
        None => Err(AppError::Gh(
            "could not parse the projects query".to_string(),
        )),
    }
}

/// The projects an issue/PR in this repo can be linked to: the repo's own linked
/// projects first, then the owner's (user or org) project boards. Reads the body
/// even on a non-zero exit — see [`available_from_output`].
#[tauri::command]
pub async fn gh_projects_available(
    repo_path: String,
    lens: Option<String>,
) -> AppResult<AvailableProjects> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let query = available_query();
    // `-f` (raw string), never `-F`: gh's typed form treats a leading `@` as
    // "read this host file", and owner/name come from the remote URL.
    let out = run_gh_raw(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-f",
            &format!("query={query}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    available_from_output(&out)
}

fn item_projects_query(field: &str) -> String {
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{ \
         repository(owner:$owner,name:$name){{ {field}(number:$number){{ \
         projectItems(first:20, includeArchived:true){{ pageInfo{{ hasNextPage }} nodes{{ id project{{ {PROJECT_FIELDS} }} }} }} \
         }} }} }}"
    )
}

/// Shared by both per-item reads: the picker and the field-values row render the
/// same partial-list note, so the two must agree on when the connection was capped.
pub(super) fn item_projects_truncated(value: &Value, field: &str) -> bool {
    value
        .pointer(&format!(
            "/data/repository/{field}/projectItems/pageInfo/hasNextPage"
        ))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Archived items are read as ordinary memberships — GitHub still shows the item
/// on the issue, and unlinking it is the same `deleteProjectV2Item` call.
fn parse_item_projects(value: &Value, field: &str) -> ItemProjects {
    let items = value
        .pointer(&format!("/data/repository/{field}/projectItems/nodes"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|n| {
                    Some(ProjectItemRef {
                        item_id: n.get("id")?.as_str()?.to_string(),
                        project: project_ref(n.get("project")?)?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ItemProjects {
        items,
        truncated: item_projects_truncated(value, field),
    }
}

/// An issue's or PR's current project memberships. `kind` is "issue" or "pr".
#[tauri::command]
pub async fn gh_item_projects(
    repo_path: String,
    kind: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<ItemProjects> {
    let field = match kind.as_str() {
        "issue" => "issue",
        "pr" => "pullRequest",
        _ => return Err(AppError::InvalidArgument(format!("unknown kind: {kind}"))),
    };
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let query = item_projects_query(field);
    // Strings take `-f` (raw), never `-F`: gh's typed form reads a leading `@` as
    // a host file path. `number` is the one `-F` here because `Int!` needs the
    // typed form, and a `u64` can only ever format to digits.
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
            "-f",
            &format!("query={query}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(map_scope_error)?;
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the assigned projects",
            format!("could not parse the item's projects: {e}"),
        )
    })?;
    Ok(parse_item_projects(&value, field))
}

/// Builds one aliased document for the whole batch, so a multi-project edit is a
/// single gh call. Every id is embedded literally, so each passes the GraphQL
/// embed charset first; `a`/`r` prefixes keep the two alias runs disjoint.
/// Both lists empty yields an operation-less document — the caller short-circuits
/// before that can be sent.
pub(crate) fn build_edit_projects_mutation(
    content_id: &str,
    add_project_ids: &[String],
    removes: &[ProjectItemRemove],
) -> AppResult<String> {
    validate_graphql_embed(content_id, "item id")?;
    let mut parts = Vec::with_capacity(add_project_ids.len() + removes.len());
    for (i, project_id) in add_project_ids.iter().enumerate() {
        validate_graphql_embed(project_id, "project id")?;
        parts.push(format!(
            r#"a{i}: addProjectV2ItemById(input:{{projectId:"{project_id}",contentId:"{content_id}"}}){{item{{id}}}}"#
        ));
    }
    for (i, remove) in removes.iter().enumerate() {
        validate_graphql_embed(&remove.project_id, "project id")?;
        validate_graphql_embed(&remove.item_id, "project item id")?;
        parts.push(format!(
            r#"r{i}: deleteProjectV2Item(input:{{projectId:"{}",itemId:"{}"}}){{deletedItemId}}"#,
            remove.project_id, remove.item_id
        ));
    }
    Ok(format!("mutation{{ {} }}", parts.join(" ")))
}

/// Links the issue/PR (`content_id` is its GraphQL node id) to every project in
/// `add_project_ids` and unlinks every membership in `removes`, in one call.
#[tauri::command]
pub async fn gh_edit_item_projects(
    repo_path: String,
    content_id: String,
    add_project_ids: Vec<String>,
    removes: Vec<ProjectItemRemove>,
) -> AppResult<()> {
    if add_project_ids.is_empty() && removes.is_empty() {
        return Ok(());
    }
    let doc = build_edit_projects_mutation(&content_id, &add_project_ids, &removes)?;
    run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={doc}")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(map_scope_error)?;
    Ok(())
}

const CREATE_PROJECT_POINTER: &str = "/data/createProjectV2/projectV2";
const UPDATE_PROJECT_POINTER: &str = "/data/updateProjectV2/projectV2";
const DELETE_PROJECT_POINTER: &str = "/data/deleteProjectV2";

/// One project or view write, sent over stdin: titles and names ride as JSON
/// variables, never through argv or spliced into the document.
pub(super) async fn project_write(repo_path: &str, input: &str, surface: &str) -> AppResult<Value> {
    let out = run_gh_input(
        Some(repo_path),
        &GRAPHQL_INPUT_ARGS,
        input,
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(map_scope_error)?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable(surface, format!("could not parse the response: {e}")))
}

/// A title or name the server would refuse as blank, refused here in the
/// dialog's own words. Trimmed, since a padded name is never what was meant.
pub(super) fn required_text(value: &str, reason: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidArgument(reason.to_string()));
    }
    Ok(trimmed.to_string())
}

/// Creating under the owner AND linking the repository in one call, so the new
/// board lands in this repository's catalog arm.
fn create_project_input(
    owner_id: &str,
    title: &str,
    repository_id: Option<&str>,
) -> AppResult<String> {
    let mut input = json!({
        "ownerId": owner_id,
        "title": required_text(title, "Give the project a title")?,
    });
    if let Some(repository_id) = repository_id.filter(|id| !id.is_empty()) {
        input["repositoryId"] = json!(repository_id);
    }
    Ok(graphql_input(
        &format!(
            "mutation($input:CreateProjectV2Input!){{ createProjectV2(input:$input){{ projectV2{{ {PROJECT_FIELDS} }} }} }}"
        ),
        json!({ "input": input }),
    ))
}

/// Only the patch's PRESENT fields reach the mutation. A patch with none of them
/// is refused: an all-absent update is unprobed, and it would change nothing.
fn update_project_input(project_id: &str, patch: ProjectPatch) -> AppResult<String> {
    let patch = ProjectPatch {
        title: patch
            .title
            .map(|t| required_text(&t, "Give the project a title"))
            .transpose()?,
        short_description: patch.short_description.map(|d| d.trim().to_string()),
        closed: patch.closed,
    };
    if patch.title.is_none() && patch.short_description.is_none() && patch.closed.is_none() {
        return Err(AppError::InvalidArgument(
            "Nothing to change on the project".into(),
        ));
    }
    let mut input = serde_json::to_value(&patch)
        .map_err(|e| AppError::InvalidArgument(format!("unserializable project patch: {e}")))?;
    input["projectId"] = json!(project_id);
    Ok(graphql_input(
        &format!(
            "mutation($input:UpdateProjectV2Input!){{ updateProjectV2(input:$input){{ projectV2{{ {PROJECT_FIELDS} }} }} }}"
        ),
        json!({ "input": input }),
    ))
}

fn delete_project_input(project_id: &str) -> String {
    graphql_input(
        "mutation($input:DeleteProjectV2Input!){ deleteProjectV2(input:$input){ clientMutationId } }",
        json!({ "input": { "projectId": project_id } }),
    )
}

fn response_project(value: &Value, pointer: &str, surface: &str) -> AppResult<ProjectV2Ref> {
    value
        .pointer(pointer)
        .and_then(project_ref)
        .ok_or_else(|| gh_unreadable(surface, format!("missing project at {pointer}")))
}

/// A create that timed out may still have landed on GitHub, so its error says so
/// rather than inviting a retry that would make a second one. Any other error
/// passes through untouched.
pub(super) fn create_outcome_unknown(e: AppError, what: &str) -> AppError {
    if matches!(e, AppError::Timeout(_)) {
        return AppError::Gh(format!(
            "GitHub didn't answer in time, so the {what} may still have been created. Check for it before trying again.\n{e}"
        ));
    }
    e
}

/// Creates a project under `owner_id`, linked to `repository_id` when one is
/// given, and answers with it as GitHub stored it.
#[tauri::command]
pub async fn gh_create_project(
    repo_path: String,
    owner_id: String,
    title: String,
    repository_id: Option<String>,
) -> AppResult<ProjectV2Ref> {
    let input = create_project_input(&owner_id, &title, repository_id.as_deref())?;
    let value = project_write(&repo_path, &input, "the new project")
        .await
        .map_err(|e| create_outcome_unknown(e, "project"))?;
    response_project(&value, CREATE_PROJECT_POINTER, "the new project")
}

/// Renames, describes, closes or reopens a project; absent patch fields are left
/// as they are.
#[tauri::command]
pub async fn gh_update_project(
    repo_path: String,
    project_id: String,
    patch: ProjectPatch,
) -> AppResult<ProjectV2Ref> {
    let input = update_project_input(&project_id, patch)?;
    let value = project_write(&repo_path, &input, "the updated project").await?;
    response_project(&value, UPDATE_PROJECT_POINTER, "the updated project")
}

/// Deletes a project and every item on it. GitHub has no undelete.
#[tauri::command]
pub async fn gh_delete_project(repo_path: String, project_id: String) -> AppResult<()> {
    let value = project_write(
        &repo_path,
        &delete_project_input(&project_id),
        "the deleted project",
    )
    .await?;
    if value
        .pointer(DELETE_PROJECT_POINTER)
        .is_some_and(Value::is_object)
    {
        return Ok(());
    }
    Err(gh_unreadable(
        "the deleted project",
        format!("missing payload at {DELETE_PROJECT_POINTER}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_projects_truncation_follows_the_selected_entity_page_info() {
        for field in ["issue", "pullRequest"] {
            let other = if field == "issue" {
                "pullRequest"
            } else {
                "issue"
            };
            for (connection, expected) in [
                (
                    serde_json::json!({"nodes":[], "pageInfo":{"hasNextPage":true}}),
                    true,
                ),
                (
                    serde_json::json!({"nodes":[], "pageInfo":{"hasNextPage":false}}),
                    false,
                ),
                (serde_json::json!({"nodes":[]}), false),
                (serde_json::json!({"nodes":[], "pageInfo":null}), false),
                (
                    serde_json::json!({"nodes":[], "pageInfo":{"hasNextPage":"true"}}),
                    false,
                ),
                (Value::Null, false),
            ] {
                let response = serde_json::json!({"data":{"repository":{
                    field:{"projectItems":connection},
                    other:{"projectItems":{"pageInfo":{"hasNextPage":!expected}}}
                }}});
                let out = parse_item_projects(&response, field);
                assert!(out.items.is_empty());
                assert_eq!(out.truncated, expected, "{field}: {response}");
            }
        }
    }

    #[test]
    fn item_projects_envelope_serializes_with_camel_case_keys() {
        for truncated in [false, true] {
            let response = serde_json::json!({"data":{"repository":{"issue":{"projectItems":{
                "nodes":[], "pageInfo":{"hasNextPage":truncated}
            }}}}});
            let wire = serde_json::to_value(parse_item_projects(&response, "issue"))
                .expect("envelope serializes");
            assert_eq!(wire, serde_json::json!({"items":[], "truncated":truncated}));
        }
    }

    fn remove(project_id: &str, item_id: &str) -> ProjectItemRemove {
        ProjectItemRemove {
            project_id: project_id.into(),
            item_id: item_id.into(),
        }
    }

    #[test]
    fn an_empty_edit_builds_no_operations() {
        let doc = build_edit_projects_mutation("I_kwDOA", &[], &[]).expect("valid ids");
        assert!(!doc.contains("addProjectV2ItemById"));
        assert!(!doc.contains("deleteProjectV2Item"));
    }

    #[test]
    fn adds_alias_from_zero_and_carry_the_content_id() {
        let doc = build_edit_projects_mutation(
            "I_kwDOA",
            &["PVT_one".to_string(), "PVT_two".to_string()],
            &[],
        )
        .expect("valid ids");
        assert!(doc.contains(
            r#"a0: addProjectV2ItemById(input:{projectId:"PVT_one",contentId:"I_kwDOA"})"#
        ));
        assert!(doc.contains(
            r#"a1: addProjectV2ItemById(input:{projectId:"PVT_two",contentId:"I_kwDOA"})"#
        ));
        assert!(!doc.contains("deleteProjectV2Item"));
    }

    #[test]
    fn removes_name_both_the_project_and_the_item() {
        // deleteProjectV2Item needs BOTH ids; the item id is not the content id.
        let doc = build_edit_projects_mutation("I_kwDOA", &[], &[remove("PVT_one", "PVTI_item")])
            .expect("valid ids");
        assert!(doc.contains(
            r#"r0: deleteProjectV2Item(input:{projectId:"PVT_one",itemId:"PVTI_item"})"#
        ));
        assert!(!doc.contains("addProjectV2ItemById"));
    }

    #[test]
    fn adds_and_removes_share_one_document_with_disjoint_aliases() {
        let doc = build_edit_projects_mutation(
            "I_kwDOA",
            &["PVT_add".to_string()],
            &[remove("PVT_one", "PVTI_a"), remove("PVT_two", "PVTI_b")],
        )
        .expect("valid ids");
        assert!(doc.starts_with("mutation{ "));
        for alias in ["a0:", "r0:", "r1:"] {
            assert_eq!(doc.matches(alias).count(), 1, "alias {alias} once");
        }
        assert!(!doc.contains("a1:"));
    }

    #[test]
    fn an_id_outside_the_embed_charset_is_rejected() {
        for bad in [
            build_edit_projects_mutation(r#"I_"}"#, &["PVT_one".to_string()], &[]),
            build_edit_projects_mutation("I_kwDOA", &[r#"PVT_"}"#.to_string()], &[]),
            build_edit_projects_mutation("I_kwDOA", &[], &[remove("PVT_one", r#"PVTI_"}"#)]),
            build_edit_projects_mutation("I_kwDOA", &[], &[remove("", "PVTI_a")]),
        ] {
            assert!(matches!(bad, Err(AppError::InvalidArgument(_))));
        }
    }

    #[test]
    fn a_missing_scope_becomes_the_actionable_hint() {
        for raw in [
            "GraphQL: Your token has not been granted the required scopes to execute this query. \
             The 'id' field requires one of the following scopes: ['read:project'] (repository.projectsV2)",
            "error: your authentication token is missing required scopes [read:project]",
        ] {
            let AppError::Gh(msg) = map_scope_error(AppError::Gh(raw.into())) else {
                panic!("expected the Gh variant");
            };
            assert_eq!(msg, PROJECT_SCOPE_HINT);
        }
    }

    #[test]
    fn unrelated_failures_pass_through_untouched() {
        let AppError::Gh(msg) = map_scope_error(AppError::Gh(
            "GraphQL: Could not resolve to an Issue with the number 999.".into(),
        )) else {
            panic!("expected the Gh variant");
        };
        assert_eq!(
            msg,
            "GraphQL: Could not resolve to an Issue with the number 999."
        );
        assert!(matches!(
            map_scope_error(AppError::InvalidArgument("required scopes".into())),
            AppError::InvalidArgument(_)
        ));
    }

    #[test]
    fn repo_linked_projects_lead_and_the_owner_arm_dedupes_against_them() {
        let value: Value = serde_json::from_str(
            r#"{"data":{
                "repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[
                    {"id":"PVT_shared","title":"Roadmap","number":3,"closed":false,"viewerCanUpdate":true},
                    {"id":null,"title":"idless"}
                ]}},
                "repositoryOwner":{"projectsV2":{"pageInfo":{"hasNextPage":true},"nodes":[
                    {"id":"PVT_shared","title":"Roadmap","number":3,"closed":false,"viewerCanUpdate":true},
                    {"id":"PVT_owner","title":"Backlog","number":9,"closed":true,"viewerCanUpdate":false}
                ]}}
            }}"#,
        )
        .expect("valid JSON");
        let out = merge_available(&value);
        let ids: Vec<&str> = out.projects.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["PVT_shared", "PVT_owner"]);
        // Closed projects survive the merge; the frontend decides how to render them.
        assert!(out.projects[1].closed);
        assert!(!out.projects[1].viewer_can_update);
        assert!(out.truncated);
    }

    #[test]
    fn a_null_owner_arm_reads_as_empty_rather_than_failing() {
        let value: Value =
            serde_json::from_str(r#"{"data":{"repository":null,"repositoryOwner":null}}"#)
                .expect("valid JSON");
        let out = merge_available(&value);
        assert!(out.projects.is_empty());
        assert!(!out.truncated);
    }

    fn gh_out(code: i32, stdout: &str, stderr: &str) -> GhOutput {
        GhOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.into(),
            code,
        }
    }

    /// The measured partial-failure body: the denied arm nulled, its sibling
    /// answered, an `errors` entry alongside — and gh exiting non-zero for it.
    const PARTIAL_BODY: &str = r#"{"data":{
        "repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[
            {"id":"PVT_repo","title":"Roadmap","number":3,"closed":false,"viewerCanUpdate":true}
        ]}},
        "repositoryOwner":null
    },"errors":[{"type":"FORBIDDEN","path":["repositoryOwner"],
        "message":"Resource not accessible by integration"}]}"#;

    #[test]
    fn a_denied_owner_arm_still_yields_the_repo_linked_catalog() {
        let value: Value = serde_json::from_str(PARTIAL_BODY).expect("valid JSON");
        let out = merge_available(&value);
        let ids: Vec<&str> = out.projects.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["PVT_repo"]);
        // The silent arm makes this a partial catalog, not "these are all of them".
        assert!(out.truncated);
    }

    #[test]
    fn a_non_zero_exit_that_still_carried_projects_is_not_an_error() {
        let out = available_from_output(&gh_out(
            1,
            PARTIAL_BODY,
            "gh: Resource not accessible by integration",
        ))
        .expect("the repo-linked arm survives the owner arm's denial");
        let ids: Vec<&str> = out.projects.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["PVT_repo"]);
    }

    #[test]
    fn a_total_scope_failure_still_maps_to_the_hint() {
        // The measured shape when the token lacks read:project outright: gh exits
        // non-zero and the body carries `errors` with no `data` at all.
        let out = available_from_output(&gh_out(
            1,
            r#"{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query. The 'projectsV2' field requires one of the following scopes: ['read:project']"}]}"#,
            "gh: Your token has not been granted the required scopes to execute this query.",
        ));
        let Err(AppError::Gh(msg)) = out else {
            panic!("expected the Gh variant");
        };
        assert_eq!(msg, PROJECT_SCOPE_HINT);
    }

    #[test]
    fn an_empty_repo_arm_beside_a_denied_owner_arm_is_an_empty_catalog_not_an_error() {
        // A repo with no boards whose owner arm is forbidden: the repo arm still
        // ANSWERED (empty `nodes`), so this is the "No projects" state, not a
        // failure — even though the `errors` entry exits gh non-zero.
        let out = available_from_output(&gh_out(
            1,
            r#"{"data":{
                "repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}},
                "repositoryOwner":null
            },"errors":[{"type":"FORBIDDEN","path":["repositoryOwner"],
                "message":"Resource not accessible by integration"}]}"#,
            "gh: Resource not accessible by integration",
        ))
        .expect("an arm that answered empty is an answer");
        assert!(out.projects.is_empty());
        // Empty, but not "there are none": the denied arm never spoke.
        assert!(out.truncated);
    }

    #[test]
    fn a_clean_exit_with_no_boards_is_an_empty_catalog_not_an_error() {
        // BOTH arms answered empty — the only shape that can honestly claim the
        // catalog is complete and empty.
        let out = available_from_output(&gh_out(
            0,
            r#"{"data":{"repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}},"repositoryOwner":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}"#,
            "",
        ))
        .expect("no projects is a legitimate answer");
        assert!(out.projects.is_empty());
        assert!(!out.truncated);
    }

    #[test]
    fn truncation_covers_a_silent_arm_as_well_as_the_page_cap() {
        let merged = |raw: &str| {
            merge_available(&serde_json::from_str::<Value>(raw).expect("valid JSON")).truncated
        };
        const EMPTY_ARM: &str = r#"{"pageInfo":{"hasNextPage":false},"nodes":[]}"#;
        const CAPPED_ARM: &str = r#"{"pageInfo":{"hasNextPage":true},"nodes":[]}"#;
        let body = |repo: &str, owner: &str| {
            format!(
                r#"{{"data":{{"repository":{{"projectsV2":{repo}}},"repositoryOwner":{{"projectsV2":{owner}}}}}}}"#
            )
        };

        // Both arms answered and neither is capped: the catalog is complete.
        assert!(!merged(&body(EMPTY_ARM, EMPTY_ARM)));
        // Either arm hitting the 50-cap truncates, as before.
        assert!(merged(&body(CAPPED_ARM, EMPTY_ARM)));
        assert!(merged(&body(EMPTY_ARM, CAPPED_ARM)));
        // Exactly one arm silent truncates from either side.
        assert!(merged(
            r#"{"data":{"repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}},"repositoryOwner":null}}"#
        ));
        assert!(merged(
            r#"{"data":{"repository":null,"repositoryOwner":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}"#
        ));
        // Both silent is the not-found read, which claims nothing.
        assert!(!merged(
            r#"{"data":{"repository":null,"repositoryOwner":null}}"#
        ));
    }

    #[test]
    fn every_arm_pointer_names_a_field_the_queries_actually_ask_for() {
        // Tripwire: response pointers and query text are independent literals, so a
        // renamed field would make every arm read absent — all reads erroring — with
        // nothing else going red. `data` is the response envelope, not a field.
        let available = available_query();
        for base in AVAILABLE_ARMS {
            for field in base.split('/').filter(|s| !s.is_empty() && *s != "data") {
                // Match the call parenthesis so `repository(` can't be satisfied by
                // `repositoryOwner(`.
                assert!(
                    available.contains(&format!("{field}(")),
                    "available_query() no longer asks for `{field}` (pointer {base})"
                );
            }
        }
        // Same drift risk on the item read, whose pointer is built per `kind`.
        for field in ["issue", "pullRequest"] {
            let query = item_projects_query(field);
            assert!(query.contains(
                "projectItems(first:20, includeArchived:true){ pageInfo{ hasNextPage }"
            ));
            for segment in ["repository", field, "projectItems"] {
                assert!(
                    query.contains(&format!("{segment}(")),
                    "item_projects_query({field}) no longer asks for `{segment}`"
                );
            }
        }
    }

    #[test]
    fn a_failure_that_recovered_nothing_carries_ghs_own_message() {
        let Err(AppError::Gh(msg)) = available_from_output(&gh_out(1, "", "gh: connection reset"))
        else {
            panic!("expected the Gh variant");
        };
        assert_eq!(msg, "gh: connection reset");
        // A silent non-zero exit still has to say something.
        let Err(AppError::Gh(msg)) = available_from_output(&gh_out(3, "", "   ")) else {
            panic!("expected the Gh variant");
        };
        assert_eq!(msg, "gh exited with code 3");
        // Garbage at exit 0 is not an empty catalog.
        assert!(available_from_output(&gh_out(0, "not json", "")).is_err());
    }

    #[test]
    fn item_memberships_carry_the_item_id_beside_the_project() {
        let value: Value = serde_json::from_str(
            r#"{"data":{"repository":{"pullRequest":{"projectItems":{"nodes":[
                {"id":"PVTI_a","project":{"id":"PVT_one","title":"Roadmap","number":3,"closed":false,"viewerCanUpdate":true}},
                {"id":"PVTI_b","project":{"id":null}},
                {"id":"PVTI_c"}
            ]}}}}}"#,
        )
        .expect("valid JSON");
        let out = parse_item_projects(&value, "pullRequest");
        assert!(!out.truncated);
        let items = out.items;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "PVTI_a");
        assert_eq!(items[0].project.id, "PVT_one");
        // The query field is the pointer key, so the issue arm can't read a PR's.
        let out = parse_item_projects(&value, "issue");
        assert!(out.items.is_empty());
        assert!(!out.truncated);
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

    fn input_json(input: &str) -> Value {
        serde_json::from_str(input).expect("input is JSON")
    }

    #[test]
    fn the_catalog_carries_the_ids_a_create_addresses() {
        let merged = |raw: &str| {
            serde_json::to_value(merge_available(
                &serde_json::from_str::<Value>(raw).expect("valid JSON"),
            ))
            .expect("serializes")
        };
        const KEYS: &[&str] = &[
            "projects",
            "truncated",
            "repositoryId",
            "repositoryNameWithOwner",
            "ownerId",
            "ownerLogin",
        ];
        // Both arms answer: the repository arm's owner wins over the owner arm's,
        // and its login rides with it.
        let wire = merged(
            r#"{"data":{
                "repository":{"id":"R_repo","nameWithOwner":"octo/app",
                    "owner":{"id":"U_owner","login":"octo"},
                    "projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}},
                "repositoryOwner":{"id":"U_other","login":"other",
                    "projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}}
            }}"#,
        );
        assert_keys(&wire, KEYS);
        assert_eq!(wire["repositoryId"], "R_repo");
        assert_eq!(wire["repositoryNameWithOwner"], "octo/app");
        assert_eq!(wire["ownerId"], "U_owner");
        assert_eq!(wire["ownerLogin"], "octo");
        // A denied repository arm: the owner arm's own id and login keep a create
        // possible, while the repository stays unknown rather than guessed.
        let wire = merged(
            r#"{"data":{"repository":null,
                "repositoryOwner":{"id":"U_owner","login":"octo",
                    "projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}"#,
        );
        assert_keys(&wire, KEYS);
        assert_eq!(wire["repositoryId"], Value::Null);
        assert_eq!(wire["repositoryNameWithOwner"], Value::Null);
        assert_eq!(wire["ownerId"], "U_owner");
        assert_eq!(wire["ownerLogin"], "octo");
        // Neither arm names them: every key still PRESENT, as explicit nulls.
        for raw in [
            r#"{"data":{"repository":null,"repositoryOwner":null}}"#,
            r#"{"data":{"repository":{"id":"","owner":null},"repositoryOwner":{"id":""}}}"#,
        ] {
            let wire = merged(raw);
            assert_keys(&wire, KEYS);
            for key in [
                "repositoryId",
                "repositoryNameWithOwner",
                "ownerId",
                "ownerLogin",
            ] {
                assert!(wire[key].is_null(), "{key} in {raw}");
            }
        }
        let query = available_query();
        assert!(query.contains(
            "repository(owner:$owner,name:$name){ id nameWithOwner owner{ id login } projectsV2("
        ));
        assert!(query.contains("repositoryOwner(login:$owner){ id login ... on ProjectV2Owner{"));
    }

    #[test]
    fn a_short_description_rides_only_when_the_project_has_one() {
        let described = project_ref(&serde_json::json!({
            "id":"PVT_a","title":"Roadmap","number":1,"closed":false,
            "viewerCanUpdate":true,"shortDescription":"Q3 launch"
        }))
        .expect("has an id");
        let wire = serde_json::to_value(&described).expect("serializes");
        assert_eq!(wire["shortDescription"], "Q3 launch");
        for node in [
            serde_json::json!({"id":"PVT_b","shortDescription":null}),
            serde_json::json!({"id":"PVT_c","shortDescription":""}),
            serde_json::json!({"id":"PVT_d"}),
        ] {
            let wire =
                serde_json::to_value(project_ref(&node).expect("has an id")).expect("serializes");
            assert_keys(
                &wire,
                &[
                    "id",
                    "title",
                    "number",
                    "closed",
                    "viewerCanUpdate",
                    "viewerCanClose",
                    "viewerCanReopen",
                ],
            );
        }
        assert!(PROJECT_FIELDS.split(' ').any(|f| f == "shortDescription"));
    }

    #[test]
    fn close_and_reopen_verdicts_ride_as_github_sends_them() {
        for field in ["viewerCanClose", "viewerCanReopen"] {
            assert!(PROJECT_FIELDS.split(' ').any(|f| f == field));
        }
        let node = serde_json::json!({"id":"PVT_a","viewerCanUpdate":true,
            "viewerCanClose":true,"viewerCanReopen":false});
        let project = project_ref(&node).expect("has an id");
        assert!(project.viewer_can_close);
        assert!(!project.viewer_can_reopen);
        // A read that didn't carry them holds both verbs rather than offering them.
        let bare = project_ref(&serde_json::json!({"id":"PVT_b"})).expect("has an id");
        assert!(!bare.viewer_can_close && !bare.viewer_can_reopen);
    }

    #[test]
    fn create_links_the_repository_when_given_one() {
        let input = input_json(
            &create_project_input("U_owner", "  Launch  ", Some("R_repo")).expect("valid"),
        );
        assert_eq!(
            input["variables"],
            serde_json::json!({"input":{"ownerId":"U_owner","title":"Launch","repositoryId":"R_repo"}})
        );
        let document = input["query"].as_str().unwrap();
        assert!(document.starts_with(
            "mutation($input:CreateProjectV2Input!){ createProjectV2(input:$input){ projectV2{ "
        ));
        assert!(document.contains(PROJECT_FIELDS));
        // No repository: the key is ABSENT, never a null or an empty id.
        for repository_id in [None, Some("")] {
            let input = input_json(
                &create_project_input("U_owner", "Launch", repository_id).expect("valid"),
            );
            assert_keys(&input["variables"]["input"], &["ownerId", "title"]);
        }
        for title in ["", "   "] {
            assert!(matches!(
                create_project_input("U_owner", title, None),
                Err(AppError::InvalidArgument(ref m)) if m == "Give the project a title"
            ));
        }
    }

    #[test]
    fn update_sends_only_the_present_fields() {
        let input = |patch: ProjectPatch| {
            input_json(&update_project_input("PVT_one", patch).expect("valid patch"))
        };
        let closed = input(ProjectPatch {
            closed: Some(true),
            ..Default::default()
        });
        assert_eq!(
            closed["variables"],
            serde_json::json!({"input":{"projectId":"PVT_one","closed":true}})
        );
        let details = input(ProjectPatch {
            title: Some(" Renamed ".into()),
            short_description: Some("".into()),
            closed: None,
        });
        // An emptied description is a present field that CLEARS, never an omission.
        assert_eq!(
            details["variables"],
            serde_json::json!({"input":{"projectId":"PVT_one","title":"Renamed","shortDescription":""}})
        );
        assert_keys(
            &details["variables"]["input"],
            &["projectId", "title", "shortDescription"],
        );
        assert!(details["query"].as_str().unwrap().starts_with(
            "mutation($input:UpdateProjectV2Input!){ updateProjectV2(input:$input){ projectV2{ "
        ));
        // The frontend's patch deserializes with missing keys as absent.
        let patch: ProjectPatch = serde_json::from_str(r#"{"closed":false}"#).expect("parses");
        assert_keys(&serde_json::to_value(&patch).unwrap(), &["closed"]);
    }

    #[test]
    fn an_empty_or_blank_titled_update_is_refused() {
        assert!(matches!(
            update_project_input("PVT_one", ProjectPatch::default()),
            Err(AppError::InvalidArgument(ref m)) if m == "Nothing to change on the project"
        ));
        assert!(matches!(
            update_project_input(
                "PVT_one",
                ProjectPatch {
                    title: Some("  ".into()),
                    ..Default::default()
                }
            ),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn a_timed_out_create_says_it_may_have_landed() {
        let AppError::Gh(message) = create_outcome_unknown(AppError::Timeout(120), "project")
        else {
            panic!("expected the Gh variant");
        };
        assert!(message.starts_with(
            "GitHub didn't answer in time, so the project may still have been created."
        ));
        // Anything else is the write's own failure, and keeps its own words.
        assert!(matches!(
            create_outcome_unknown(AppError::Gh("denied".into()), "project"),
            AppError::Gh(ref m) if m == "denied"
        ));
    }

    #[test]
    fn delete_addresses_the_project_by_variable() {
        let input = input_json(&delete_project_input("PVT_\"x"));
        assert_eq!(
            input["variables"],
            serde_json::json!({"input":{"projectId":"PVT_\"x"}})
        );
        assert!(!input["query"].as_str().unwrap().contains("PVT_"));
    }

    #[test]
    fn mutation_answers_parse_or_fail_closed() {
        let value = serde_json::json!({"data":{"createProjectV2":{"projectV2":{
            "id":"PVT_new","title":"Launch","number":14,"closed":false,"viewerCanUpdate":true
        }}}});
        let project = response_project(&value, CREATE_PROJECT_POINTER, "x").expect("parses");
        assert_eq!(project.id, "PVT_new");
        assert_eq!(project.number, 14);
        for value in [
            serde_json::json!({"data":{"createProjectV2":{"projectV2":null}}}),
            serde_json::json!({"data":{"createProjectV2":{"projectV2":{"title":"no id"}}}}),
            serde_json::json!({"data":null}),
        ] {
            assert!(response_project(&value, CREATE_PROJECT_POINTER, "x").is_err());
        }
    }
}
