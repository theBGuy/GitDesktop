//! Saved Projects v2 views. GitHub-only by design: no forge routing, since
//! GitLab/Bitbucket have no equivalent resource.

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectViews {
    pub views: Vec<ProjectViewDef>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectViewDef {
    pub id: String,
    pub name: String,
    pub layout: String,
    pub filter: Option<String>,
    pub vertical_group_field_ids: Vec<String>,
    pub sort_by: Vec<ProjectViewSort>,
    pub visible_field_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectViewSort {
    pub field_id: String,
    pub direction: String,
}

const VIEWS_SCOPE_HINT: &str =
    "GitHub project views need the read:project (or project) scope. Run:  gh auth refresh -s project";
const VIEWS_POINTER: &str = "/data/node/views";

fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(VIEWS_SCOPE_HINT.to_string());
        }
    }
    e
}

fn project_views_query() -> &'static str {
    // Keep views(first:50) paired with VIEWS_TRUNCATED_NOTE in ProjectsBoardPanel.tsx.
    "query($id:ID!){ node(id:$id){ ... on ProjectV2 { \
     views(first:50){ pageInfo{hasNextPage} nodes{ \
     id name layout filter \
     verticalGroupByFields(first:10){nodes{... on ProjectV2FieldCommon{id}}} \
     sortByFields(first:10){nodes{direction field{... on ProjectV2FieldCommon{id}}}} \
     fields(first:50){nodes{... on ProjectV2FieldCommon{id}}} \
     }}}}}"
}

fn build_views_args(project_id: &str) -> Vec<String> {
    vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={}", project_views_query()),
        "-f".to_string(),
        format!("id={project_id}"),
    ]
}

fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn field_ids(connection: &Value) -> Vec<String> {
    array(&connection["nodes"])
        .filter_map(|node| node["id"].as_str().map(str::to_string))
        .collect()
}

fn parse_project_views(value: &Value) -> ProjectViews {
    let connection = value.pointer(VIEWS_POINTER).unwrap_or(&Value::Null);
    let views = array(&connection["nodes"])
        .filter_map(|node| {
            let id = node["id"].as_str()?.to_string();
            Some(ProjectViewDef {
                id,
                name: node["name"].as_str().unwrap_or_default().to_string(),
                layout: match node["layout"].as_str() {
                    Some("BOARD_LAYOUT") => "board",
                    Some("TABLE_LAYOUT") => "table",
                    Some("ROADMAP_LAYOUT") => "roadmap",
                    _ => "unknown",
                }
                .to_string(),
                filter: node["filter"].as_str().map(str::to_string),
                vertical_group_field_ids: field_ids(&node["verticalGroupByFields"]),
                sort_by: array(&node["sortByFields"]["nodes"])
                    .filter_map(|sort| {
                        Some(ProjectViewSort {
                            field_id: sort["field"]["id"].as_str()?.to_string(),
                            direction: match sort["direction"].as_str() {
                                Some("DESC") => "desc",
                                _ => "asc",
                            }
                            .to_string(),
                        })
                    })
                    .collect(),
                visible_field_ids: field_ids(&node["fields"]),
            })
        })
        .collect();
    ProjectViews {
        views,
        truncated: connection["pageInfo"]["hasNextPage"]
            .as_bool()
            .unwrap_or(false),
    }
}

#[tauri::command]
pub async fn gh_project_views(repo_path: String, project_id: String) -> AppResult<ProjectViews> {
    let args = build_views_args(&project_id);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT)
        .await
        .map_err(map_scope_error)?;
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the project views",
            format!("could not parse the project's views: {e}"),
        )
    })?;
    Ok(parse_project_views(&value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn canned_views_preserve_layouts_filters_connections_and_wire_keys() {
        for truncated in [false, true] {
            let response = json!({"data":{"node":{"views":{
                "pageInfo":{"hasNextPage":truncated},
                "nodes":[
                    {"id":"board","number":1,"name":"Board","layout":"BOARD_LAYOUT","filter":null,
                        "verticalGroupByFields":{"nodes":[]},
                        "sortByFields":{"nodes":[]},"fields":{"nodes":[]}},
                    {"id":"table","number":2,"name":"Table","layout":"TABLE_LAYOUT","filter":"  status:Todo  ",
                        "verticalGroupByFields":{"nodes":[{"id":"status"},{"id":"team"}]},
                        "sortByFields":{"nodes":[
                            {"direction":"DESC","field":{"id":"priority"}},
                            {"direction":"ASC","field":{"id":"title"}},
                            {"direction":"FUTURE_DIRECTION","field":{"id":"estimate"}}]},
                        "fields":{"nodes":[{"id":"title"},{"id":"priority"}]}},
                    {"id":"roadmap","number":3,"name":"Roadmap","layout":"ROADMAP_LAYOUT","filter":"",
                        "verticalGroupByFields":null,"sortByFields":null,"fields":null},
                    {"id":"future","number":4,"name":"Future","layout":"FUTURE_LAYOUT","filter":null}
                ]
            }}}});
            let wire = serde_json::to_value(parse_project_views(&response)).unwrap();
            assert_keys(&wire, &["views", "truncated"]);
            assert_eq!(wire["truncated"], truncated);
            let views = wire["views"].as_array().unwrap();
            assert_eq!(views.len(), 4);
            for (index, (id, name)) in [
                ("board", "Board"),
                ("table", "Table"),
                ("roadmap", "Roadmap"),
                ("future", "Future"),
            ]
            .into_iter()
            .enumerate()
            {
                assert_keys(
                    &views[index],
                    &[
                        "id",
                        "name",
                        "layout",
                        "filter",
                        "verticalGroupFieldIds",
                        "sortBy",
                        "visibleFieldIds",
                    ],
                );
                assert_eq!(views[index]["id"], id);
                assert_eq!(views[index]["name"], name);
            }
            for (index, layout) in ["board", "table", "roadmap", "unknown"].iter().enumerate() {
                assert_eq!(views[index]["layout"], *layout);
            }
            assert_eq!(views[0]["filter"], Value::Null);
            assert_eq!(views[1]["filter"], "  status:Todo  ");
            assert_eq!(views[2]["filter"], "");
            assert_eq!(views[3]["filter"], Value::Null);
            for index in [0, 2, 3] {
                for key in ["verticalGroupFieldIds", "sortBy", "visibleFieldIds"] {
                    assert_eq!(views[index][key], json!([]));
                }
            }
            assert_eq!(views[1]["verticalGroupFieldIds"], json!(["status", "team"]));
            assert_eq!(views[1]["visibleFieldIds"], json!(["title", "priority"]));
            assert_eq!(
                views[1]["sortBy"],
                json!([
                    {"fieldId":"priority","direction":"desc"},
                    {"fieldId":"title","direction":"asc"},
                    {"fieldId":"estimate","direction":"asc"}
                ])
            );
            for sort in views[1]["sortBy"].as_array().unwrap() {
                assert_keys(sort, &["fieldId", "direction"]);
            }
        }
    }

    #[test]
    fn null_absent_and_partial_nodes_are_tolerated() {
        for connection in [
            json!({}),
            json!({"nodes":null}),
            json!({"nodes":[null, {}]}),
        ] {
            let response = json!({"data":{"node":{"views":{"nodes":[null, {}, {
                "id":"partial","verticalGroupByFields":connection,
                "sortByFields":connection,"fields":connection
            }]}}}});
            let views = parse_project_views(&response);
            assert!(!views.truncated);
            assert_eq!(views.views.len(), 1);
            let view = &views.views[0];
            assert_eq!(view.layout, "unknown");
            assert!(view.filter.is_none());
            assert!(view.vertical_group_field_ids.is_empty());
            assert!(view.sort_by.is_empty());
            assert!(view.visible_field_ids.is_empty());
        }
        for response in [Value::Null, json!({"data":{"node":{"views":{"nodes":[]}}}})] {
            let views = parse_project_views(&response);
            assert!(views.views.is_empty());
            assert!(!views.truncated);
        }
    }

    #[test]
    fn query_pins_every_pointer_and_connection_limit() {
        let query = project_views_query();
        let tokens: Vec<_> = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|token| !token.is_empty())
            .collect();
        for path in [
            VIEWS_POINTER,
            "/pageInfo/hasNextPage",
            "/nodes/id",
            "/nodes/name",
            "/nodes/layout",
            "/nodes/filter",
            "/nodes/verticalGroupByFields/nodes/id",
            "/nodes/sortByFields/nodes/direction",
            "/nodes/sortByFields/nodes/field/id",
            "/nodes/fields/nodes/id",
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
        assert!(query.starts_with("query($id:ID!)"));
        assert!(query.contains("node(id:$id){ ... on ProjectV2 {"));
        assert!(query.contains("views(first:50){ pageInfo{hasNextPage} nodes{"));
        for selection in [
            "verticalGroupByFields(first:10){nodes{... on ProjectV2FieldCommon{id}}}",
            "sortByFields(first:10){nodes{direction field{... on ProjectV2FieldCommon{id}}}}",
            "fields(first:50){nodes{... on ProjectV2FieldCommon{id}}}",
        ] {
            assert!(query.contains(selection));
        }
    }

    #[test]
    fn project_id_is_a_raw_graphql_variable() {
        let id = "@project\"}";
        let args = build_views_args(id);
        assert_eq!(&args[..2], &["api", "graphql"]);
        assert_eq!(args.len(), 6);
        assert_eq!(args[3], format!("query={}", project_views_query()));
        assert_eq!(args[5], format!("id={id}"));
        assert!(!project_views_query().contains(id));
        for pair in args[2..].chunks_exact(2) {
            assert_eq!(pair[0], "-f");
        }
    }

    #[test]
    fn scope_errors_map_to_hint_and_other_errors_survive() {
        for raw in [
            "GraphQL: Your token has not been granted the required scopes to execute this query.",
            "missing scope read:project",
        ] {
            let AppError::Gh(message) = map_scope_error(AppError::Gh(raw.into())) else {
                panic!("expected Gh error");
            };
            assert_eq!(message, VIEWS_SCOPE_HINT);
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
}
