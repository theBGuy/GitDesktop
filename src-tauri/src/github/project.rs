//! GitHub Projects v2 membership for issues and PRs. GitHub-only by design: no
//! forge routing, since GitLab/Bitbucket have no equivalent resource.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::issue::repo_owner_name;
use crate::github::pr::validate_graphql_embed;
use crate::github::runner::{run_gh, run_gh_raw, GhOutput, GH_NETWORK_TIMEOUT};

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
}

/// One membership: the project plus the ITEM id inside it, which
/// `deleteProjectV2Item` needs alongside the project id.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemRef {
    pub item_id: String,
    pub project: ProjectV2Ref,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableProjects {
    pub projects: Vec<ProjectV2Ref>,
    /// Either arm had more than the 50 fetched — the picker says so rather than
    /// implying the list is complete.
    pub truncated: bool,
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

/// A `ProjectV2` node, skipped entirely when it carries no id (the one field the
/// mutations can't work without); the rest default rather than fail the read.
fn project_ref(node: &Value) -> Option<ProjectV2Ref> {
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
    })
}

const PROJECT_FIELDS: &str = "id title number closed viewerCanUpdate";

/// `repositoryOwner` resolves a User or an Organization and both implement
/// `ProjectV2Owner`, so one inline fragment covers owner-level projects for either.
fn available_query() -> String {
    format!(
        "query($owner:String!,$name:String!){{ \
         repository(owner:$owner,name:$name){{ projectsV2(first:50){{ pageInfo{{ hasNextPage }} nodes{{ {PROJECT_FIELDS} }} }} }} \
         repositoryOwner(login:$owner){{ ... on ProjectV2Owner{{ projectsV2(first:50){{ pageInfo{{ hasNextPage }} nodes{{ {PROJECT_FIELDS} }} }} }} }} \
         }}"
    )
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
    let (repo_linked, repo_more) = arm("/data/repository/projectsV2");
    let (owner_level, owner_more) = arm("/data/repositoryOwner/projectsV2");

    let mut seen = std::collections::HashSet::new();
    let projects = repo_linked
        .into_iter()
        .chain(owner_level)
        .filter(|p| seen.insert(p.id.clone()))
        .collect();
    AvailableProjects {
        projects,
        truncated: repo_more || owner_more,
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
/// viewer denied only the owner's boards receives. So anything recovered wins
/// over reporting the arm that failed, and only a call that yielded no projects
/// AND exited non-zero errors — keeping the scope mapping on the total failure,
/// which the frontend's scope state reads. Exit 0 with no projects is the
/// legitimate empty catalog; unparseable output at exit 0 keeps its own error.
fn available_from_output(out: &GhOutput) -> AppResult<AvailableProjects> {
    let parsed: Option<Value> = serde_json::from_str(&out.stdout_lossy()).ok();
    match parsed.as_ref().map(merge_available) {
        Some(a) if !a.projects.is_empty() => Ok(a),
        _ if out.code != 0 => Err(map_scope_error(gh_failure(out))),
        Some(a) => Ok(a),
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
         projectItems(first:20, includeArchived:true){{ nodes{{ id project{{ {PROJECT_FIELDS} }} }} }} \
         }} }} }}"
    )
}

/// Archived items are read as ordinary memberships — GitHub still shows the item
/// on the issue, and unlinking it is the same `deleteProjectV2Item` call.
fn parse_item_projects(value: &Value, field: &str) -> Vec<ProjectItemRef> {
    value
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
        .unwrap_or_default()
}

/// An issue's or PR's current project memberships. `kind` is "issue" or "pr".
#[tauri::command]
pub async fn gh_item_projects(
    repo_path: String,
    kind: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<ProjectItemRef>> {
    let field = match kind.as_str() {
        "issue" => "issue",
        "pr" => "pullRequest",
        _ => return Err(AppError::InvalidArgument(format!("unknown kind: {kind}"))),
    };
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let query = item_projects_query(field);
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
    let value: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the item's projects: {e}")))?;
    Ok(parse_item_projects(&value, field))
}

/// Builds one aliased document for the whole batch, so a multi-project edit is a
/// single gh call. Every id is embedded literally, so each passes the GraphQL
/// embed charset first; `a`/`r` prefixes keep the two alias runs disjoint.
/// Both lists empty yields an operation-less document — the caller short-circuits
/// before that can be sent.
fn build_edit_projects_mutation(
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!out.truncated);
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
    fn a_clean_exit_with_no_boards_is_an_empty_catalog_not_an_error() {
        let out = available_from_output(&gh_out(
            0,
            r#"{"data":{"repository":{"projectsV2":{"pageInfo":{"hasNextPage":false},"nodes":[]}},"repositoryOwner":null}}"#,
            "",
        ))
        .expect("no projects is a legitimate answer");
        assert!(out.projects.is_empty());
        assert!(!out.truncated);
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
        let items = parse_item_projects(&value, "pullRequest");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "PVTI_a");
        assert_eq!(items[0].project.id, "PVT_one");
        // The query field is the pointer key, so the issue arm can't read a PR's.
        assert!(parse_item_projects(&value, "issue").is_empty());
    }
}
