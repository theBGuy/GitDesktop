//! Projects v2 field values and definitions for issue and PR sidebars.

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::issue::repo_owner_name;
use crate::github::project::{ProjectV2Ref, PROJECT_FIELDS};
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjectFieldValues {
    pub item_id: String,
    pub project: ProjectV2Ref,
    pub values: Vec<ProjectFieldValue>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectFieldValue {
    SingleSelect {
        field_id: String,
        field_name: String,
        option_id: String,
        name: String,
        color: String,
        is_issue_field: bool,
    },
    MultiSelect {
        field_id: String,
        field_name: String,
        options: Vec<SelectOptionRef>,
        is_issue_field: bool,
    },
    Text {
        field_id: String,
        field_name: String,
        text: String,
        is_issue_field: bool,
    },
    Number {
        field_id: String,
        field_name: String,
        number: f64,
        is_issue_field: bool,
    },
    Date {
        field_id: String,
        field_name: String,
        date: String,
        is_issue_field: bool,
    },
    Iteration {
        field_id: String,
        field_name: String,
        title: String,
        start_date: String,
        duration: u32,
        is_issue_field: bool,
    },
    Unknown {
        field_name: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOptionRef {
    pub id: String,
    pub name: String,
    pub color: String,
}

const FIELDS_SCOPE_HINT: &str =
    "GitHub project fields need the read:project scope. Run:  gh auth refresh -s project";

fn map_scope_error(e: AppError) -> AppError {
    if let AppError::Gh(ref msg) = e {
        let lower = msg.to_lowercase();
        if lower.contains("required scopes") || lower.contains("read:project") {
            return AppError::Gh(FIELDS_SCOPE_HINT.to_string());
        }
    }
    e
}

const FIELD_COMMON: &str = "... on ProjectV2FieldCommon { id name dataType isIssueField }";

// The IssueField*Value arms alias their `value` scalar (`text: value`, …) so
// classic and bridge values parse by the same keys and String/Float response
// names stay disjoint.
fn item_field_values_query(field: &str) -> String {
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{ \
         repository(owner:$owner,name:$name){{ {field}(number:$number){{ \
         projectItems(first:20, includeArchived:true){{ nodes{{ id project{{ {PROJECT_FIELDS} }} \
         fieldValues(first:50){{ nodes{{ __typename \
         ... on ProjectV2ItemFieldSingleSelectValue{{ field{{ {FIELD_COMMON} }} name optionId color }} \
         ... on ProjectV2ItemFieldMultiSelectValue{{ field{{ {FIELD_COMMON} }} options{{ id name color }} }} \
         ... on ProjectV2ItemFieldTextValue{{ field{{ {FIELD_COMMON} }} text }} \
         ... on ProjectV2ItemFieldNumberValue{{ field{{ {FIELD_COMMON} }} number }} \
         ... on ProjectV2ItemFieldDateValue{{ field{{ {FIELD_COMMON} }} date }} \
         ... on ProjectV2ItemFieldIterationValue{{ field{{ {FIELD_COMMON} }} title startDate duration }} \
         ... on ProjectV2ItemIssueFieldValue{{ field{{ {FIELD_COMMON} }} issueFieldValue{{ __typename \
           ... on IssueFieldSingleSelectValue{{ name optionId color }} \
           ... on IssueFieldMultiSelectValue{{ options{{ id name color }} }} \
           ... on IssueFieldTextValue{{ text: value }} \
           ... on IssueFieldNumberValue{{ number: value }} \
           ... on IssueFieldDateValue{{ date: value }} \
         }} }} \
         }} }} }} }} }} }} }}"
    )
}

fn text(node: &Value, key: &str) -> String {
    node.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn duration(node: &Value) -> u32 {
    node.get("duration")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn parse_field_value(node: &Value) -> ProjectFieldValue {
    let field = &node["field"];
    let field_id = text(field, "id");
    let field_name = text(field, "name");
    let bridge = node["__typename"] == "ProjectV2ItemIssueFieldValue";
    let is_issue_field = bridge || field["isIssueField"].as_bool().unwrap_or(false);
    let value = if bridge {
        &node["issueFieldValue"]
    } else {
        node
    };
    match (
        value["__typename"].as_str().unwrap_or_default(),
        field["dataType"].as_str().unwrap_or_default(),
    ) {
        (
            "ProjectV2ItemFieldSingleSelectValue" | "IssueFieldSingleSelectValue",
            "SINGLE_SELECT",
        ) => ProjectFieldValue::SingleSelect {
            field_id,
            field_name,
            option_id: text(value, "optionId"),
            name: text(value, "name"),
            color: text(value, "color"),
            is_issue_field,
        },
        ("ProjectV2ItemFieldMultiSelectValue" | "IssueFieldMultiSelectValue", "MULTI_SELECT") => {
            ProjectFieldValue::MultiSelect {
                field_id,
                field_name,
                options: array(&value["options"])
                    .map(|option| SelectOptionRef {
                        id: text(option, "id"),
                        name: text(option, "name"),
                        color: text(option, "color"),
                    })
                    .collect(),
                is_issue_field,
            }
        }
        ("ProjectV2ItemFieldTextValue" | "IssueFieldTextValue", "TEXT") => {
            ProjectFieldValue::Text {
                field_id,
                field_name,
                text: text(value, "text"),
                is_issue_field,
            }
        }
        ("ProjectV2ItemFieldNumberValue" | "IssueFieldNumberValue", "NUMBER") => {
            let Some(number) = value["number"].as_f64() else {
                return ProjectFieldValue::Unknown { field_name };
            };
            ProjectFieldValue::Number {
                field_id,
                field_name,
                number,
                is_issue_field,
            }
        }
        ("ProjectV2ItemFieldDateValue" | "IssueFieldDateValue", "DATE") => {
            ProjectFieldValue::Date {
                field_id,
                field_name,
                date: text(value, "date"),
                is_issue_field,
            }
        }
        ("ProjectV2ItemFieldIterationValue", "ITERATION") => ProjectFieldValue::Iteration {
            field_id,
            field_name,
            title: text(value, "title"),
            start_date: text(value, "startDate"),
            duration: duration(value),
            is_issue_field,
        },
        _ => ProjectFieldValue::Unknown { field_name },
    }
}

fn parse_item_field_values(value: &Value, field: &str) -> Vec<ItemProjectFieldValues> {
    value
        .pointer(&format!("/data/repository/{field}/projectItems/nodes"))
        .into_iter()
        .flat_map(array)
        .filter_map(|node| {
            let project = node.get("project")?;
            Some(ItemProjectFieldValues {
                item_id: node.get("id")?.as_str()?.to_string(),
                project: ProjectV2Ref {
                    id: project.get("id")?.as_str()?.to_string(),
                    title: text(project, "title"),
                    number: project["number"].as_u64().unwrap_or(0),
                    closed: project["closed"].as_bool().unwrap_or(false),
                    viewer_can_update: project["viewerCanUpdate"].as_bool().unwrap_or(false),
                },
                values: array(&node["fieldValues"]["nodes"])
                    .map(parse_field_value)
                    .collect(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn gh_item_field_values(
    repo_path: String,
    kind: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<ItemProjectFieldValues>> {
    let field = match kind.as_str() {
        "issue" => "issue",
        "pr" => "pullRequest",
        _ => return Err(AppError::InvalidArgument(format!("unknown kind: {kind}"))),
    };
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    let query = item_field_values_query(field);
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
            "the project field values",
            format!("could not parse the item's project field values: {e}"),
        )
    })?;
    Ok(parse_item_field_values(&value, field))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn custom_values() -> Value {
        json!([
            {"__typename":"ProjectV2ItemFieldSingleSelectValue", "field":{"id":"status","name":"Status","dataType":"SINGLE_SELECT","isIssueField":false}, "optionId":"done","name":"Done","color":"GREEN"},
            {"__typename":"ProjectV2ItemFieldMultiSelectValue", "field":{"id":"teams","name":"Teams","dataType":"MULTI_SELECT","isIssueField":false}, "options":[{"id":"web","name":"Web","color":"BLUE"}]},
            {"__typename":"ProjectV2ItemFieldTextValue", "field":{"id":"notes","name":"Notes","dataType":"TEXT","isIssueField":false}, "text":"Ship it"},
            {"__typename":"ProjectV2ItemFieldNumberValue", "field":{"id":"points","name":"Points","dataType":"NUMBER","isIssueField":false}, "number":2.5},
            {"__typename":"ProjectV2ItemFieldDateValue", "field":{"id":"due","name":"Due","dataType":"DATE","isIssueField":false}, "date":"2026-09-12"},
            {"__typename":"ProjectV2ItemFieldIterationValue", "field":{"id":"sprint","name":"Sprint","dataType":"ITERATION","isIssueField":false}, "title":"Sprint 1","startDate":"2026-09-01","duration":14}
        ])
    }

    fn assert_keys(value: &Value, expected: &[&str]) {
        let obj = value.as_object().expect("wire value is an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, expected);
    }

    #[test]
    fn field_value_wire_shapes_are_camel_case() {
        let fixtures = custom_values();
        let mut values: Vec<ProjectFieldValue> = array(&fixtures).map(parse_field_value).collect();
        values.push(ProjectFieldValue::Unknown {
            field_name: "Future".into(),
        });
        assert_eq!(values.len(), 7);
        let expected: [(&str, &[&str]); 7] = [
            (
                "singleSelect",
                &[
                    "color",
                    "fieldId",
                    "fieldName",
                    "isIssueField",
                    "kind",
                    "name",
                    "optionId",
                ],
            ),
            (
                "multiSelect",
                &["fieldId", "fieldName", "isIssueField", "kind", "options"],
            ),
            (
                "text",
                &["fieldId", "fieldName", "isIssueField", "kind", "text"],
            ),
            (
                "number",
                &["fieldId", "fieldName", "isIssueField", "kind", "number"],
            ),
            (
                "date",
                &["date", "fieldId", "fieldName", "isIssueField", "kind"],
            ),
            (
                "iteration",
                &[
                    "duration",
                    "fieldId",
                    "fieldName",
                    "isIssueField",
                    "kind",
                    "startDate",
                    "title",
                ],
            ),
            ("unknown", &["fieldName", "kind"]),
        ];
        for (value, (kind, keys)) in values.iter().zip(expected) {
            let wire = serde_json::to_value(value).expect("field value serializes");
            assert_keys(&wire, keys);
            assert_eq!(wire["kind"], kind);
        }
    }

    #[test]
    fn all_custom_values_keep_their_display_data() {
        let fixtures = custom_values();
        let values: Vec<_> = array(&fixtures).map(parse_field_value).collect();
        let wire = serde_json::to_value(values).expect("values serialize");
        assert_eq!(
            wire,
            json!([
                {"kind":"singleSelect","fieldId":"status","fieldName":"Status","optionId":"done","name":"Done","color":"GREEN","isIssueField":false},
                {"kind":"multiSelect","fieldId":"teams","fieldName":"Teams","options":[{"id":"web","name":"Web","color":"BLUE"}],"isIssueField":false},
                {"kind":"text","fieldId":"notes","fieldName":"Notes","text":"Ship it","isIssueField":false},
                {"kind":"number","fieldId":"points","fieldName":"Points","number":2.5,"isIssueField":false},
                {"kind":"date","fieldId":"due","fieldName":"Due","date":"2026-09-12","isIssueField":false},
                {"kind":"iteration","fieldId":"sprint","fieldName":"Sprint","title":"Sprint 1","startDate":"2026-09-01","duration":14,"isIssueField":false}
            ])
        );
    }

    #[test]
    fn issue_field_bridges_use_the_wrapper_identity() {
        let cases = [
            (
                "SINGLE_SELECT",
                json!({"__typename":"IssueFieldSingleSelectValue","name":"High","optionId":"high","color":"RED","value":"High"}),
                json!({"kind":"singleSelect","optionId":"high","name":"High","color":"RED"}),
            ),
            (
                "MULTI_SELECT",
                json!({"__typename":"IssueFieldMultiSelectValue","options":[{"id":"web","name":"Web","color":"BLUE"}]}),
                json!({"kind":"multiSelect","options":[{"id":"web","name":"Web","color":"BLUE"}]}),
            ),
            (
                "TEXT",
                json!({"__typename":"IssueFieldTextValue","text":"Notes"}),
                json!({"kind":"text","text":"Notes"}),
            ),
            (
                "NUMBER",
                json!({"__typename":"IssueFieldNumberValue","number":3.5}),
                json!({"kind":"number","number":3.5}),
            ),
            (
                "DATE",
                json!({"__typename":"IssueFieldDateValue","date":"2026-09-12"}),
                json!({"kind":"date","date":"2026-09-12"}),
            ),
        ];
        for (data_type, inner, mut expected) in cases {
            let node = json!({"__typename":"ProjectV2ItemIssueFieldValue","field":{"id":"org-field","name":"Org field","dataType":data_type,"isIssueField":false},"issueFieldValue":inner});
            expected["fieldId"] = json!("org-field");
            expected["fieldName"] = json!("Org field");
            expected["isIssueField"] = json!(true);
            assert_eq!(
                serde_json::to_value(parse_field_value(&node)).expect("bridge serializes"),
                expected
            );
        }
    }

    #[test]
    fn system_and_future_values_are_unknown() {
        for node in [
            json!({"__typename":"ProjectV2ItemFieldLabelValue"}),
            json!({"__typename":"ProjectV2ItemFieldTextValue","field":{"name":"Title","dataType":"TITLE"},"text":"An item's own title"}),
            json!({"__typename":"FutureProjectValue","field":{"name":"Future"}}),
            json!({"__typename":"FutureProjectValue"}),
            json!({"__typename":"ProjectV2ItemIssueFieldValue","field":{"name":"Org"},"issueFieldValue":{"__typename":"FutureIssueValue"}}),
            json!({"__typename":"ProjectV2ItemIssueFieldValue","field":{"name":"Priority","dataType":"TEXT"},"issueFieldValue":{"__typename":"IssueFieldSingleSelectValue","optionId":"high","name":"High","color":"RED"}}),
        ] {
            let expected_name = text(&node["field"], "name");
            assert_eq!(
                serde_json::to_value(parse_field_value(&node)).expect("unknown serializes"),
                json!({"kind":"unknown","fieldName":expected_name})
            );
        }
    }

    #[test]
    fn custom_values_require_matching_data_types() {
        for node in array(&custom_values()) {
            let mismatched_type = if node["field"]["dataType"] == "TEXT" {
                "NUMBER"
            } else {
                "TEXT"
            };
            for field in [
                json!({"name":"Custom","dataType":mismatched_type}),
                json!({"name":"Custom","dataType":"FUTURE_TYPE"}),
                json!({"name":"Custom","dataType":null}),
                json!({"name":"Custom"}),
            ] {
                let mut node = node.clone();
                node["field"] = field;
                assert_eq!(
                    serde_json::to_value(parse_field_value(&node)).expect("unknown serializes"),
                    json!({"kind":"unknown","fieldName":"Custom"})
                );
            }
        }
    }

    #[test]
    fn item_in_two_projects_preserves_memberships_and_values() {
        for field in ["issue", "pullRequest"] {
            let response = json!({"data":{"repository":{field:{"projectItems":{"nodes":[
                {"id":"item-a","project":{"id":"project-a","title":"Roadmap","number":3,"closed":false,"viewerCanUpdate":true},"fieldValues":{"nodes":custom_values()}},
                {"id":"item-b","project":{"id":"project-b","title":"Backlog","number":4,"closed":true,"viewerCanUpdate":false},"fieldValues":{"nodes":[]}}
            ]}}}}});
            let items = parse_item_field_values(&response, field);
            assert_eq!(items.len(), 2);
            assert_eq!(items[0].item_id, "item-a");
            assert_eq!(items[0].project.id, "project-a");
            assert_eq!(items[0].values.len(), 6);
            assert!(items[0].project.viewer_can_update);
            assert_eq!(items[1].item_id, "item-b");
            assert_eq!(items[1].project.id, "project-b");
            assert!(items[1].project.closed);
            assert!(items[1].values.is_empty());
            let wire = serde_json::to_value(&items[0]).expect("membership serializes");
            assert_keys(&wire, &["itemId", "project", "values"]);
            assert_keys(
                &wire["project"],
                &["closed", "id", "number", "title", "viewerCanUpdate"],
            );
        }
    }

    #[test]
    fn empty_and_absent_connections_are_empty() {
        for response in [
            json!({"data":{"repository":{"issue":{"projectItems":{"nodes":[]}}}}}),
            json!({"data":{"repository":{"issue":{"projectItems":null}}}}),
            json!({"data":{"repository":null}}),
            Value::Null,
        ] {
            assert!(parse_item_field_values(&response, "issue").is_empty());
        }
    }

    #[test]
    fn numbers_distinguish_explicit_zero_from_unset_values() {
        for bridge in [false, true] {
            let typename = if bridge {
                "IssueFieldNumberValue"
            } else {
                "ProjectV2ItemFieldNumberValue"
            };
            for (payload, expected) in [
                (
                    json!({"number":0.0}),
                    json!({"kind":"number","fieldId":"points","fieldName":"Points","number":0.0,"isIssueField":bridge}),
                ),
                (
                    json!({"number":null}),
                    json!({"kind":"unknown","fieldName":"Points"}),
                ),
                (json!({}), json!({"kind":"unknown","fieldName":"Points"})),
            ] {
                let mut value = payload;
                value["__typename"] = json!(typename);
                let mut node = if bridge {
                    json!({"__typename":"ProjectV2ItemIssueFieldValue","issueFieldValue":value})
                } else {
                    value
                };
                node["field"] = json!({"id":"points","name":"Points","dataType":"NUMBER"});
                assert_eq!(
                    serde_json::to_value(parse_field_value(&node))
                        .expect("numeric value serializes"),
                    expected
                );
            }
        }
    }

    #[test]
    fn absent_optional_subfields_are_tolerated() {
        let response = json!({"data":{"repository":{"issue":{"projectItems":{"nodes":[
            {"id":"item","project":{"id":"project","title":null}},
            {"id":"missing-project"}, {"project":{"id":"missing-item"}}, null
        ]}}}}});
        let items = parse_item_field_values(&response, "issue");
        assert_eq!(items.len(), 1);
        assert!(items[0].project.title.is_empty());
        assert!(items[0].values.is_empty());
        for typename in [
            "ProjectV2ItemFieldSingleSelectValue",
            "ProjectV2ItemFieldMultiSelectValue",
            "ProjectV2ItemFieldTextValue",
            "ProjectV2ItemFieldNumberValue",
            "ProjectV2ItemFieldDateValue",
            "ProjectV2ItemFieldIterationValue",
            "ProjectV2ItemIssueFieldValue",
        ] {
            let wire = serde_json::to_value(parse_field_value(
                &json!({"__typename":typename,"field":null,"options":null,"issueFieldValue":null}),
            ))
            .expect("partial field serializes");
            assert_eq!(wire, json!({"kind":"unknown","fieldName":""}));
        }
        assert!(matches!(
            parse_field_value(
                &json!({"__typename":"ProjectV2ItemFieldNumberValue","field":{"dataType":"NUMBER"},"number":null})
            ),
            ProjectFieldValue::Unknown { .. }
        ));
    }

    fn assert_query_fields(query: &str, paths: &[&str]) {
        let tokens: Vec<_> = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .filter(|s| !s.is_empty())
            .collect();
        for path in paths {
            for segment in path.split('/').filter(|s| !s.is_empty() && *s != "data") {
                assert!(
                    tokens.contains(&segment),
                    "query no longer asks for `{segment}` (pointer {path})"
                );
            }
        }
    }

    #[test]
    fn every_item_pointer_names_a_field_the_query_actually_asks_for() {
        for field in ["issue", "pullRequest"] {
            let query = item_field_values_query(field);
            for segment in ["repository", field, "projectItems", "fieldValues"] {
                assert!(
                    query.contains(&format!("{segment}(")),
                    "query no longer asks for `{segment}`"
                );
            }
            assert_query_fields(
                &query,
                &[
                    &format!("/data/repository/{field}/projectItems/nodes"),
                    "/id",
                    "/project/id",
                    "/project/title",
                    "/project/number",
                    "/project/closed",
                    "/project/viewerCanUpdate",
                    "/fieldValues/nodes/__typename",
                    "/field/id",
                    "/field/name",
                    "/field/dataType",
                    "/field/isIssueField",
                    "/optionId",
                    "/name",
                    "/color",
                    "/options/id",
                    "/options/name",
                    "/options/color",
                    "/text",
                    "/number",
                    "/date",
                    "/title",
                    "/startDate",
                    "/duration",
                    "/issueFieldValue/__typename",
                ],
            );
            assert!(query.contains(PROJECT_FIELDS));
            assert!(query.contains("projectItems(first:20, includeArchived:true)"));
            assert!(query.contains("fieldValues(first:50)"));
            for fragment in [
                "... on IssueFieldTextValue{ text: value }",
                "... on IssueFieldNumberValue{ number: value }",
                "... on IssueFieldDateValue{ date: value }",
            ] {
                assert!(query.contains(fragment));
            }
        }
    }

    #[test]
    fn scope_failures_get_the_family_hint_and_other_errors_survive() {
        for raw in [
            "GraphQL: Your token has not been granted the required scopes to execute this query.",
            "missing scope read:project",
        ] {
            let AppError::Gh(message) = map_scope_error(AppError::Gh(raw.into())) else {
                panic!("expected Gh error");
            };
            assert_eq!(message, FIELDS_SCOPE_HINT);
        }
        let AppError::Gh(message) = map_scope_error(AppError::Gh("connection reset".into())) else {
            panic!("expected Gh error");
        };
        assert_eq!(message, "connection reset");
        assert!(matches!(
            map_scope_error(AppError::InvalidArgument("required scopes".into())),
            AppError::InvalidArgument(_)
        ));
    }
}
