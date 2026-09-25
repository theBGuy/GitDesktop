//! Saved Projects v2 views. GitHub-only by design: no forge routing, since
//! GitLab/Bitbucket have no equivalent resource.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::project::{create_outcome_unknown, project_write, required_text};
use crate::github::project_item_edits::graphql_input;
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
    pub group_field_ids: Vec<String>,
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

/// One view's selection, shared by the read and every write that answers with a
/// view, so a created or edited view parses exactly as a listed one does.
const VIEW_SELECTION: &str = "id name layout filter \
     groupByFields(first:10){nodes{... on ProjectV2FieldCommon{id}}} \
     verticalGroupByFields(first:10){nodes{... on ProjectV2FieldCommon{id}}} \
     sortByFields(first:10){nodes{direction field{... on ProjectV2FieldCommon{id}}}} \
     fields(first:50){nodes{... on ProjectV2FieldCommon{id}}}";

fn project_views_query() -> String {
    // Keep views(first:50) paired with VIEWS_TRUNCATED_NOTE in ProjectsBoardPanel.tsx.
    format!(
        "query($id:ID!){{ node(id:$id){{ ... on ProjectV2 {{ \
         views(first:50){{ pageInfo{{hasNextPage}} nodes{{ {VIEW_SELECTION} }}}}}}}}}}"
    )
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

/// The app's layout word for GitHub's enum; one this build doesn't know reads as
/// `unknown` rather than dropping the view.
fn layout_from_graphql(layout: Option<&str>) -> &'static str {
    match layout {
        Some("BOARD_LAYOUT") => "board",
        Some("TABLE_LAYOUT") => "table",
        Some("ROADMAP_LAYOUT") => "roadmap",
        _ => "unknown",
    }
}

/// GitHub's enum for the app's layout word. Anything else is refused before the
/// network, so a write can never carry an enum value the server doesn't define.
fn layout_to_graphql(layout: &str) -> AppResult<&'static str> {
    match layout {
        "board" => Ok("BOARD_LAYOUT"),
        "table" => Ok("TABLE_LAYOUT"),
        "roadmap" => Ok("ROADMAP_LAYOUT"),
        _ => Err(AppError::InvalidArgument(format!(
            "Unknown view layout: {layout}"
        ))),
    }
}

/// One view node, skipped when it carries no id — the one field everything
/// downstream keys on.
fn parse_view_node(node: &Value) -> Option<ProjectViewDef> {
    let id = node["id"].as_str()?.to_string();
    Some(ProjectViewDef {
        id,
        name: node["name"].as_str().unwrap_or_default().to_string(),
        layout: layout_from_graphql(node["layout"].as_str()).to_string(),
        filter: node["filter"].as_str().map(str::to_string),
        group_field_ids: field_ids(&node["groupByFields"]),
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
}

fn parse_project_views(value: &Value) -> ProjectViews {
    let connection = value.pointer(VIEWS_POINTER).unwrap_or(&Value::Null);
    let views = array(&connection["nodes"])
        .filter_map(parse_view_node)
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

/// A view edit as the frontend sends it. `filter` is deliberately not here: the
/// app never composes one, and only a duplicate writes a filter, copied verbatim
/// from its source.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub layout: Option<String>,
    #[serde(default)]
    pub visible_field_ids: Option<Vec<String>>,
}

/// What a duplicate copies from its source view, read off the app's own
/// definition of it. Grouping and sort are absent because GitHub's view writes
/// have no input for either.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateViewSource {
    pub name: String,
    pub layout: String,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub visible_field_ids: Vec<String>,
}

/// `UpdateProjectV2ViewInput` minus the view id. An absent field is OMITTED,
/// which GitHub reads as "leave it".
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    layout: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    configuration: Option<ViewConfiguration>,
}

/// GitHub's view configuration input holds the visible field list and nothing
/// else (introspected): no grouping or sort can be written.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewConfiguration {
    visible_field_ids: Vec<String>,
}

const CREATE_VIEW_POINTER: &str = "/data/createProjectV2View/projectV2View";
const UPDATE_VIEW_POINTER: &str = "/data/updateProjectV2View/projectV2View";
const DELETE_VIEW_POINTER: &str = "/data/deleteProjectV2View";
const VIEW_NAME_REASON: &str = "Give the view a name";
/// The name a view reported with none takes in the app, reused for its copy.
const UNTITLED_VIEW: &str = "Untitled view";

/// Validates a frontend patch into the wire update. An empty field list is
/// refused: a view showing nothing is unprobed, and the editor always keeps Title.
fn view_update(patch: ViewPatch) -> AppResult<ViewUpdate> {
    let update = ViewUpdate {
        name: patch
            .name
            .map(|n| required_text(&n, VIEW_NAME_REASON))
            .transpose()?,
        layout: patch.layout.as_deref().map(layout_to_graphql).transpose()?,
        filter: None,
        configuration: match patch.visible_field_ids {
            Some(ids) if ids.is_empty() => {
                return Err(AppError::InvalidArgument(
                    "Keep at least one field visible".into(),
                ))
            }
            ids => ids.map(|visible_field_ids| ViewConfiguration { visible_field_ids }),
        },
    };
    if update.name.is_none() && update.layout.is_none() && update.configuration.is_none() {
        return Err(AppError::InvalidArgument(
            "Nothing to change on the view".into(),
        ));
    }
    Ok(update)
}

fn create_view_input(project_id: &str, name: &str, layout: &str) -> AppResult<String> {
    let input = json!({
        "projectId": project_id,
        "name": required_text(name, VIEW_NAME_REASON)?,
        "layout": layout_to_graphql(layout)?,
    });
    Ok(graphql_input(
        &format!(
            "mutation($input:CreateProjectV2ViewInput!){{ createProjectV2View(input:$input){{ projectV2View{{ {VIEW_SELECTION} }} }} }}"
        ),
        json!({ "input": input }),
    ))
}

fn update_view_input(view_id: &str, update: &ViewUpdate) -> AppResult<String> {
    let mut input = serde_json::to_value(update)
        .map_err(|e| AppError::InvalidArgument(format!("unserializable view update: {e}")))?;
    input["viewId"] = json!(view_id);
    Ok(graphql_input(
        &format!(
            "mutation($input:UpdateProjectV2ViewInput!){{ updateProjectV2View(input:$input){{ projectV2View{{ {VIEW_SELECTION} }} }} }}"
        ),
        json!({ "input": input }),
    ))
}

fn delete_view_input(view_id: &str) -> String {
    graphql_input(
        "mutation($input:DeleteProjectV2ViewInput!){ deleteProjectV2View(input:$input){ clientMutationId } }",
        json!({ "input": { "viewId": view_id } }),
    )
}

fn response_view(value: &Value, pointer: &str, surface: &str) -> AppResult<ProjectViewDef> {
    value
        .pointer(pointer)
        .and_then(parse_view_node)
        .ok_or_else(|| gh_unreadable(surface, format!("missing view at {pointer}")))
}

/// The copy's name, from the source's own (or the app's name for an unnamed one).
fn duplicate_name(source: &str) -> String {
    let name = source.trim();
    format!(
        "Copy of {}",
        if name.is_empty() { UNTITLED_VIEW } else { name }
    )
}

/// The follow-up write a duplicate needs after its create: the source's filter
/// (VERBATIM, the server's grammar) and its visible fields. None when the source
/// has neither, so the duplicate is a single create.
fn duplicate_followup(source: &DuplicateViewSource) -> Option<ViewUpdate> {
    let filter = source
        .filter
        .as_ref()
        .filter(|f| !f.trim().is_empty())
        .cloned();
    let configuration = (!source.visible_field_ids.is_empty()).then(|| ViewConfiguration {
        visible_field_ids: source.visible_field_ids.clone(),
    });
    if filter.is_none() && configuration.is_none() {
        return None;
    }
    Some(ViewUpdate {
        filter,
        configuration,
        ..ViewUpdate::default()
    })
}

async fn write_view_update(
    repo_path: &str,
    view_id: &str,
    update: &ViewUpdate,
) -> AppResult<ProjectViewDef> {
    let input = update_view_input(view_id, update)?;
    let value = project_write(repo_path, &input, "the updated view").await?;
    response_view(&value, UPDATE_VIEW_POINTER, "the updated view")
}

/// Adds a saved view to the project and answers with it as GitHub stored it.
#[tauri::command]
pub async fn gh_create_view(
    repo_path: String,
    project_id: String,
    name: String,
    layout: String,
) -> AppResult<ProjectViewDef> {
    let input = create_view_input(&project_id, &name, &layout)?;
    let value = project_write(&repo_path, &input, "the new view")
        .await
        .map_err(|e| create_outcome_unknown(e, "view"))?;
    response_view(&value, CREATE_VIEW_POINTER, "the new view")
}

/// Renames a view, changes its layout, or sets its visible fields; absent patch
/// fields are left as they are.
#[tauri::command]
pub async fn gh_update_view(
    repo_path: String,
    view_id: String,
    patch: ViewPatch,
) -> AppResult<ProjectViewDef> {
    let update = view_update(patch)?;
    write_view_update(&repo_path, &view_id, &update).await
}

/// Deletes a saved view. GitHub has no undelete for views.
#[tauri::command]
pub async fn gh_delete_view(repo_path: String, view_id: String) -> AppResult<()> {
    let value = project_write(&repo_path, &delete_view_input(&view_id), "the deleted view").await?;
    if value
        .pointer(DELETE_VIEW_POINTER)
        .is_some_and(Value::is_object)
    {
        return Ok(());
    }
    Err(gh_unreadable(
        "the deleted view",
        format!("missing payload at {DELETE_VIEW_POINTER}"),
    ))
}

/// Copies a view: GitHub has no copy mutation, so this creates one in the
/// source's layout, then writes the source's filter and visible fields onto it.
/// Two writes, not one: a failed second write says the copy exists without them
/// rather than pretending nothing happened.
#[tauri::command]
pub async fn gh_duplicate_view(
    repo_path: String,
    project_id: String,
    source: DuplicateViewSource,
) -> AppResult<ProjectViewDef> {
    let name = duplicate_name(&source.name);
    let input = create_view_input(&project_id, &name, &source.layout)?;
    let followup = duplicate_followup(&source);
    let value = project_write(&repo_path, &input, "the new view")
        .await
        .map_err(|e| create_outcome_unknown(e, "copy"))?;
    let created = response_view(&value, CREATE_VIEW_POINTER, "the new view")?;
    let Some(update) = followup else {
        return Ok(created);
    };
    write_view_update(&repo_path, &created.id, &update)
        .await
        .map_err(|e| AppError::Gh(partial_duplicate_message(&name, &update, &e)))
}

/// What a duplicate's failed follow-up says: the copy exists, and exactly which
/// of its source's parts didn't make it, read off the update that carried them.
fn partial_duplicate_message(name: &str, update: &ViewUpdate, error: &AppError) -> String {
    let missing = match (update.filter.is_some(), update.configuration.is_some()) {
        (true, true) => "its filter and fields",
        (true, false) => "its filter",
        _ => "its fields",
    };
    // A timeout's write may still have landed: say the outcome is unknown.
    let outcome = if matches!(error, AppError::Timeout(_)) {
        "may not have been copied"
    } else {
        "could not be copied"
    };
    format!("The view \"{name}\" was created, but {missing} {outcome}.\n{error}")
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
                        "groupByFields":{"nodes":[]},
                        "verticalGroupByFields":{"nodes":[]},
                        "sortByFields":{"nodes":[]},"fields":{"nodes":[]}},
                    {"id":"table","number":2,"name":"Table","layout":"TABLE_LAYOUT","filter":"  status:Todo  ",
                        "groupByFields":{"nodes":[{"id":"team"},{"id":"priority"}]},
                        "verticalGroupByFields":{"nodes":[{"id":"status"},{"id":"team"}]},
                        "sortByFields":{"nodes":[
                            {"direction":"DESC","field":{"id":"priority"}},
                            {"direction":"ASC","field":{"id":"title"}},
                            {"direction":"FUTURE_DIRECTION","field":{"id":"estimate"}}]},
                        "fields":{"nodes":[{"id":"title"},{"id":"priority"}]}},
                    {"id":"roadmap","number":3,"name":"Roadmap","layout":"ROADMAP_LAYOUT","filter":"",
                        "groupByFields":null,
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
                        "groupFieldIds",
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
                for key in ["groupFieldIds", "verticalGroupFieldIds", "sortBy", "visibleFieldIds"] {
                    assert_eq!(views[index][key], json!([]));
                }
            }
            assert_eq!(views[1]["verticalGroupFieldIds"], json!(["status", "team"]));
            assert_eq!(views[1]["groupFieldIds"], json!(["team", "priority"]));
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
                "groupByFields":connection,
                "sortByFields":connection,"fields":connection
            }]}}}});
            let views = parse_project_views(&response);
            assert!(!views.truncated);
            assert_eq!(views.views.len(), 1);
            let view = &views.views[0];
            assert_eq!(view.layout, "unknown");
            assert!(view.filter.is_none());
            assert!(view.vertical_group_field_ids.is_empty());
            assert!(view.group_field_ids.is_empty());
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
            "/nodes/groupByFields/nodes/id",
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
            "groupByFields(first:10){nodes{... on ProjectV2FieldCommon{id}}}",
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

    fn input_json(input: &str) -> Value {
        serde_json::from_str(input).expect("input is JSON")
    }

    #[test]
    fn layouts_round_trip_and_unknown_words_are_refused() {
        for (app, graphql) in [
            ("board", "BOARD_LAYOUT"),
            ("table", "TABLE_LAYOUT"),
            ("roadmap", "ROADMAP_LAYOUT"),
        ] {
            assert_eq!(layout_to_graphql(app).unwrap(), graphql);
            assert_eq!(layout_from_graphql(Some(graphql)), app);
        }
        assert_eq!(layout_from_graphql(Some("FUTURE_LAYOUT")), "unknown");
        assert_eq!(layout_from_graphql(None), "unknown");
        // `unknown` is the READ side's fallback, never a value a write may send.
        for bad in ["unknown", "", "Board", "BOARD_LAYOUT", "kanban"] {
            assert!(matches!(
                layout_to_graphql(bad),
                Err(AppError::InvalidArgument(_))
            ));
        }
    }

    #[test]
    fn create_carries_name_and_enum_layout_by_variable() {
        let input = input_json(&create_view_input("PVT_one", "  Sprint  ", "roadmap").unwrap());
        assert_eq!(
            input["variables"],
            json!({"input":{"projectId":"PVT_one","name":"Sprint","layout":"ROADMAP_LAYOUT"}})
        );
        let document = input["query"].as_str().unwrap();
        assert!(document.starts_with(
            "mutation($input:CreateProjectV2ViewInput!){ createProjectV2View(input:$input){ projectV2View{ "
        ));
        assert!(document.contains(VIEW_SELECTION));
        assert!(!document.contains("Sprint"));
        assert!(matches!(
            create_view_input("PVT_one", " ", "table"),
            Err(AppError::InvalidArgument(ref m)) if m == VIEW_NAME_REASON
        ));
        assert!(create_view_input("PVT_one", "Sprint", "unknown").is_err());
    }

    #[test]
    fn update_sends_only_the_present_fields() {
        let wire = |patch: ViewPatch| {
            input_json(&update_view_input("PVTV_one", &view_update(patch).unwrap()).unwrap())
        };
        let renamed = wire(ViewPatch {
            name: Some(" Triage ".into()),
            ..ViewPatch::default()
        });
        assert_eq!(
            renamed["variables"],
            json!({"input":{"viewId":"PVTV_one","name":"Triage"}})
        );
        let relaid = wire(ViewPatch {
            layout: Some("board".into()),
            ..ViewPatch::default()
        });
        assert_eq!(
            relaid["variables"],
            json!({"input":{"viewId":"PVTV_one","layout":"BOARD_LAYOUT"}})
        );
        let fields = wire(ViewPatch {
            visible_field_ids: Some(vec!["PVTF_title".into(), "PVTF_status".into()]),
            ..ViewPatch::default()
        });
        assert_eq!(
            fields["variables"],
            json!({"input":{"viewId":"PVTV_one",
                "configuration":{"visibleFieldIds":["PVTF_title","PVTF_status"]}}})
        );
        assert!(fields["query"].as_str().unwrap().starts_with(
            "mutation($input:UpdateProjectV2ViewInput!){ updateProjectV2View(input:$input){ projectV2View{ "
        ));
        // A frontend patch never carries a filter: the key doesn't deserialize.
        let patch: ViewPatch =
            serde_json::from_str(r#"{"name":"A","filter":"is:open"}"#).expect("parses");
        let input =
            input_json(&update_view_input("PVTV_one", &view_update(patch).unwrap()).unwrap());
        assert_eq!(
            input["variables"],
            json!({"input":{"viewId":"PVTV_one","name":"A"}})
        );
    }

    #[test]
    fn empty_blank_and_invalid_view_patches_are_refused() {
        for (patch, reason) in [
            (ViewPatch::default(), "Nothing to change on the view"),
            (
                ViewPatch {
                    name: Some("  ".into()),
                    ..ViewPatch::default()
                },
                VIEW_NAME_REASON,
            ),
            (
                ViewPatch {
                    visible_field_ids: Some(vec![]),
                    ..ViewPatch::default()
                },
                "Keep at least one field visible",
            ),
        ] {
            assert!(matches!(
                view_update(patch),
                Err(AppError::InvalidArgument(ref m)) if m == reason
            ));
        }
        assert!(view_update(ViewPatch {
            layout: Some("unknown".into()),
            ..ViewPatch::default()
        })
        .is_err());
    }

    #[test]
    fn delete_addresses_the_view_by_variable() {
        let input = input_json(&delete_view_input("PVTV_\"x"));
        assert_eq!(input["variables"], json!({"input":{"viewId":"PVTV_\"x"}}));
        assert!(!input["query"].as_str().unwrap().contains("PVTV_"));
    }

    fn source(filter: Option<&str>, visible: &[&str]) -> DuplicateViewSource {
        DuplicateViewSource {
            name: "Triage".into(),
            layout: "table".into(),
            filter: filter.map(str::to_string),
            visible_field_ids: visible.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn a_duplicate_skips_its_follow_up_when_the_source_has_nothing_to_copy() {
        for bare in [
            source(None, &[]),
            source(Some(""), &[]),
            source(Some("   "), &[]),
        ] {
            assert!(duplicate_followup(&bare).is_none());
        }
        let filtered = serde_json::to_value(
            duplicate_followup(&source(Some("  status:Todo  "), &[])).unwrap(),
        )
        .unwrap();
        // The filter rides verbatim, padding and all: the grammar is the server's.
        assert_eq!(filtered, json!({"filter":"  status:Todo  "}));
        let fields =
            serde_json::to_value(duplicate_followup(&source(None, &["a", "b"])).unwrap()).unwrap();
        assert_eq!(
            fields,
            json!({"configuration":{"visibleFieldIds":["a","b"]}})
        );
        let both =
            serde_json::to_value(duplicate_followup(&source(Some("is:open"), &["a"])).unwrap())
                .unwrap();
        assert_eq!(
            both,
            json!({"filter":"is:open","configuration":{"visibleFieldIds":["a"]}})
        );
    }

    #[test]
    fn a_failed_follow_up_names_only_what_it_was_copying() {
        let error = AppError::Gh("boom".into());
        for (source, missing) in [
            (source(Some("is:open"), &["a"]), "its filter and fields"),
            (source(Some("is:open"), &[]), "its filter"),
            (source(None, &["a"]), "its fields"),
        ] {
            let update = duplicate_followup(&source).expect("has something to copy");
            assert_eq!(
                partial_duplicate_message("Copy of Triage", &update, &error),
                format!("The view \"Copy of Triage\" was created, but {missing} could not be copied.\nboom")
            );
        }
        // A timeout leaves the follow-up's outcome unknown, and says so.
        let update = duplicate_followup(&source(Some("is:open"), &[])).unwrap();
        let message = partial_duplicate_message("Copy of Triage", &update, &AppError::Timeout(30));
        assert!(message.starts_with(
            "The view \"Copy of Triage\" was created, but its filter may not have been copied.\n"
        ));
    }

    #[test]
    fn a_duplicate_is_named_after_its_source() {
        assert_eq!(duplicate_name("Triage"), "Copy of Triage");
        assert_eq!(duplicate_name("  Triage "), "Copy of Triage");
        assert_eq!(duplicate_name(""), "Copy of Untitled view");
    }

    #[test]
    fn a_created_view_parses_like_a_listed_one() {
        let node = json!({"id":"PVTV_new","name":"Sprint","layout":"BOARD_LAYOUT","filter":null,
            "groupByFields":{"nodes":[]},
            "verticalGroupByFields":{"nodes":[{"id":"PVTF_status"}]},
            "sortByFields":{"nodes":[{"direction":"DESC","field":{"id":"PVTF_prio"}}]},
            "fields":{"nodes":[{"id":"PVTF_title"},{"id":"PVTF_status"}]}});
        let value = json!({"data":{"createProjectV2View":{"projectV2View":node}}});
        let created = response_view(&value, CREATE_VIEW_POINTER, "x").unwrap();
        let listed = parse_project_views(&json!({"data":{"node":{"views":{"nodes":[node]}}}}));
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::to_value(&listed.views[0]).unwrap()
        );
        assert_eq!(created.layout, "board");
        assert_eq!(created.vertical_group_field_ids, ["PVTF_status"]);
        for value in [
            json!({"data":{"createProjectV2View":{"projectV2View":null}}}),
            json!({"data":{"createProjectV2View":{"projectV2View":{"name":"no id"}}}}),
            json!({"data":null}),
        ] {
            assert!(response_view(&value, CREATE_VIEW_POINTER, "x").is_err());
        }
        let updated = json!({"data":{"updateProjectV2View":{"projectV2View":{"id":"PVTV_one"}}}});
        assert_eq!(
            response_view(&updated, UPDATE_VIEW_POINTER, "x")
                .unwrap()
                .id,
            "PVTV_one"
        );
    }
}
