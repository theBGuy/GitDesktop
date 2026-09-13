//! Projects v2 field values and definitions for issue and PR sidebars.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::issue::repo_owner_name;
use crate::github::pr::validate_graphql_embed;
use crate::github::project::{project_ref, ProjectV2Ref, PROJECT_FIELDS};
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
        iteration_id: String,
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

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectFieldDef {
    SingleSelect {
        id: String,
        name: String,
        options: Vec<FieldOptionDef>,
        is_issue_field: bool,
    },
    MultiSelect {
        id: String,
        name: String,
        options: Vec<FieldOptionDef>,
        is_issue_field: bool,
    },
    Iteration {
        id: String,
        name: String,
        iterations: Vec<IterationDef>,
        completed_iterations: Vec<IterationDef>,
    },
    Text {
        id: String,
        name: String,
        is_issue_field: bool,
    },
    Number {
        id: String,
        name: String,
        is_issue_field: bool,
    },
    Date {
        id: String,
        name: String,
        is_issue_field: bool,
    },
    System {
        id: String,
        name: String,
        data_type: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFieldDefs {
    pub fields: Vec<ProjectFieldDef>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOptionDef {
    pub id: String,
    pub name: String,
    pub color: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationDef {
    pub id: String,
    pub title: String,
    pub start_date: String,
    pub duration: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FieldValueUpdate {
    Text {
        field_id: String,
        text: String,
    },
    Number {
        field_id: String,
        number: f64,
    },
    Date {
        field_id: String,
        date: String,
    },
    SingleSelect {
        field_id: String,
        option_id: String,
    },
    MultiSelect {
        field_id: String,
        option_ids: Vec<String>,
    },
    Iteration {
        field_id: String,
        iteration_id: String,
    },
}

fn build_set_item_field_values_args(
    project_id: &str,
    item_id: &str,
    updates: &[FieldValueUpdate],
    clears: &[String],
) -> AppResult<Vec<String>> {
    validate_graphql_embed(project_id, "project id")?;
    validate_graphql_embed(item_id, "project item id")?;
    let mut variables = vec!["$p:ID!".to_string(), "$i:ID!".to_string()];
    let mut parts = Vec::with_capacity(updates.len() + clears.len());
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("p={project_id}"),
        "-f".to_string(),
        format!("i={item_id}"),
    ];
    for (n, update) in updates.iter().enumerate() {
        let (field_id, key, value_type, values) = match update {
            FieldValueUpdate::Text { field_id, text } => {
                (field_id, "text", Some("String!"), vec![text.clone()])
            }
            FieldValueUpdate::Number { field_id, number } => {
                if !number.is_finite() {
                    return Err(AppError::InvalidArgument(
                        "field number must be finite".into(),
                    ));
                }
                (field_id, "number", None, vec![number.to_string()])
            }
            FieldValueUpdate::Date { field_id, date } => {
                (field_id, "date", Some("Date!"), vec![date.clone()])
            }
            FieldValueUpdate::SingleSelect {
                field_id,
                option_id,
            } => {
                validate_graphql_embed(option_id, "option id")?;
                (
                    field_id,
                    "singleSelectOptionId",
                    Some("String!"),
                    vec![option_id.clone()],
                )
            }
            FieldValueUpdate::MultiSelect {
                field_id,
                option_ids,
            } => {
                for option_id in option_ids {
                    validate_graphql_embed(option_id, "option id")?;
                }
                (
                    field_id,
                    "multiSelectOptionIds",
                    Some("[String!]!"),
                    option_ids.clone(),
                )
            }
            FieldValueUpdate::Iteration {
                field_id,
                iteration_id,
            } => {
                validate_graphql_embed(iteration_id, "iteration id")?;
                (
                    field_id,
                    "iterationId",
                    Some("String!"),
                    vec![iteration_id.clone()],
                )
            }
        };
        validate_graphql_embed(field_id, "field id")?;
        variables.push(format!("$f{n}:ID!"));
        args.extend(["-f".to_string(), format!("f{n}={field_id}")]);
        let value = if let Some(value_type) = value_type {
            variables.push(format!("$v{n}:{value_type}"));
            let value_name = if matches!(update, FieldValueUpdate::MultiSelect { .. }) {
                format!("v{n}[]")
            } else {
                format!("v{n}")
            };
            if matches!(update, FieldValueUpdate::MultiSelect { .. }) && values.is_empty() {
                // gh's bracket key without '=' represents an empty array.
                args.extend(["-f".to_string(), value_name]);
            } else {
                for value in values {
                    args.extend(["-f".to_string(), format!("{value_name}={value}")]);
                }
            }
            format!("$v{n}")
        } else {
            // The is_finite gate above is required: finite f64 Display produces only
            // a valid GraphQL numeric literal, so this splice cannot inject structure.
            values[0].clone()
        };
        parts.push(format!(
            "s{n}: updateProjectV2ItemFieldValue(input:{{projectId:$p,itemId:$i,fieldId:$f{n},value:{{{key}:{value}}}}}){{projectV2Item{{id}}}}"
        ));
    }
    for (n, field_id) in clears.iter().enumerate() {
        validate_graphql_embed(field_id, "field id")?;
        variables.push(format!("$g{n}:ID!"));
        args.extend(["-f".to_string(), format!("g{n}={field_id}")]);
        parts.push(format!(
            "c{n}: clearProjectV2ItemFieldValue(input:{{projectId:$p,itemId:$i,fieldId:$g{n}}}){{projectV2Item{{id}}}}"
        ));
    }
    args.extend([
        "-f".to_string(),
        format!(
            "query=mutation({}){{ {} }}",
            variables.join(","),
            parts.join(" ")
        ),
    ]);
    Ok(args)
}

fn map_field_write_error(error: AppError) -> AppError {
    // run_gh exposes nonzero GraphQL responses as stderr, where gh lists errors in order.
    let error = match error {
        AppError::Gh(message) if message.starts_with("gh: ") => AppError::Gh(
            message
                .strip_prefix("gh: ")
                .unwrap_or(&message)
                .lines()
                .next()
                .unwrap_or(&message)
                .to_string(),
        ),
        other => other,
    };
    map_scope_error(error)
}

fn parse_field_write_response(stdout: &str) -> AppResult<()> {
    let value: Value = serde_json::from_str(stdout).map_err(|e| {
        gh_unreadable(
            "the project field update",
            format!("could not parse the field update: {e}"),
        )
    })?;
    if let Some(error) = array(&value["errors"]).next() {
        let message = error["message"]
            .as_str()
            .unwrap_or("GitHub could not update the project fields.");
        return Err(map_scope_error(AppError::Gh(message.to_string())));
    }
    Ok(())
}

/// A batch can partially apply; the first error is returned and callers must refetch even on failure.
#[tauri::command]
pub async fn gh_set_item_field_values(
    repo_path: String,
    project_id: String,
    item_id: String,
    updates: Vec<FieldValueUpdate>,
    clears: Vec<String>,
) -> AppResult<()> {
    if updates.is_empty() && clears.is_empty() {
        return Ok(());
    }
    let args = build_set_item_field_values_args(&project_id, &item_id, &updates, &clears)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT)
        .await
        .map_err(map_field_write_error)?;
    parse_field_write_response(&out.stdout_lossy())
}

const FIELDS_SCOPE_HINT: &str =
    "GitHub project fields need the read:project (or project) scope. Run:  gh auth refresh -s project";

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
         ... on ProjectV2ItemFieldIterationValue{{ field{{ {FIELD_COMMON} }} iterationId title startDate duration }} \
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

fn project_fields_query() -> String {
    format!(
        "query($id:ID!){{ node(id:$id){{ ... on ProjectV2{{ fields(first:50){{ pageInfo{{ hasNextPage }} nodes{{ \
         __typename {FIELD_COMMON} \
         ... on ProjectV2SingleSelectField{{ options{{ id name color description }} }} \
         ... on ProjectV2MultiSelectField{{ multiSelectOptions{{ id name color description }} }} \
         ... on ProjectV2IterationField{{ configuration{{ \
           iterations{{ id title startDate duration }} \
           completedIterations{{ id title startDate duration }} \
         }} }} \
         }} }} }} }} }}"
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
        ("ProjectV2ItemFieldIterationValue", "ITERATION") => {
            let Some(iteration_id) = value["iterationId"].as_str() else {
                return ProjectFieldValue::Unknown { field_name };
            };
            ProjectFieldValue::Iteration {
                field_id,
                field_name,
                iteration_id: iteration_id.to_string(),
                title: text(value, "title"),
                start_date: text(value, "startDate"),
                duration: duration(value),
                is_issue_field,
            }
        }
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
                project: project_ref(project)?,
                values: array(&node["fieldValues"]["nodes"])
                    .map(parse_field_value)
                    .collect(),
            })
        })
        .collect()
}

fn field_options(value: &Value) -> Vec<FieldOptionDef> {
    array(value)
        .map(|node| FieldOptionDef {
            id: text(node, "id"),
            name: text(node, "name"),
            color: text(node, "color"),
            description: text(node, "description"),
        })
        .collect()
}

fn iterations(value: &Value) -> Vec<IterationDef> {
    array(value)
        .map(|node| IterationDef {
            id: text(node, "id"),
            title: text(node, "title"),
            start_date: text(node, "startDate"),
            duration: duration(node),
        })
        .collect()
}

const PROJECT_FIELDS_POINTER: &str = "/data/node/fields/nodes";
const PROJECT_FIELDS_TRUNCATED_POINTER: &str = "/data/node/fields/pageInfo/hasNextPage";

fn parse_project_fields(value: &Value) -> ProjectFieldDefs {
    let fields = value
        .pointer(PROJECT_FIELDS_POINTER)
        .into_iter()
        .flat_map(array)
        .filter_map(|node| {
            let id = node.get("id")?.as_str()?.to_string();
            let name = text(node, "name");
            let is_issue_field = node["isIssueField"].as_bool().unwrap_or(false);
            Some(match node["dataType"].as_str().unwrap_or_default() {
                "SINGLE_SELECT" => ProjectFieldDef::SingleSelect {
                    id,
                    name,
                    options: field_options(&node["options"]),
                    is_issue_field,
                },
                "MULTI_SELECT" => ProjectFieldDef::MultiSelect {
                    id,
                    name,
                    options: field_options(&node["multiSelectOptions"]),
                    is_issue_field,
                },
                "ITERATION" => ProjectFieldDef::Iteration {
                    id,
                    name,
                    iterations: iterations(&node["configuration"]["iterations"]),
                    completed_iterations: iterations(&node["configuration"]["completedIterations"]),
                },
                "TEXT" => ProjectFieldDef::Text {
                    id,
                    name,
                    is_issue_field,
                },
                "NUMBER" => ProjectFieldDef::Number {
                    id,
                    name,
                    is_issue_field,
                },
                "DATE" => ProjectFieldDef::Date {
                    id,
                    name,
                    is_issue_field,
                },
                _ => ProjectFieldDef::System {
                    id,
                    name,
                    data_type: text(node, "dataType"),
                },
            })
        })
        .collect();
    ProjectFieldDefs {
        fields,
        truncated: value
            .pointer(PROJECT_FIELDS_TRUNCATED_POINTER)
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
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

#[tauri::command]
pub async fn gh_project_fields(
    repo_path: String,
    project_id: String,
) -> AppResult<ProjectFieldDefs> {
    let query = project_fields_query();
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            &format!("id={project_id}"),
            "-f",
            &format!("query={query}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(map_scope_error)?;
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the project fields",
            format!("could not parse the project's fields: {e}"),
        )
    })?;
    Ok(parse_project_fields(&value))
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
            {"__typename":"ProjectV2ItemFieldIterationValue", "field":{"id":"sprint","name":"Sprint","dataType":"ITERATION","isIssueField":false}, "iterationId":"sprint-1","title":"Sprint 1","startDate":"2026-09-01","duration":14}
        ])
    }

    fn field_defs() -> Value {
        json!({"data":{"node":{"fields":{"nodes":[
            {"__typename":"ProjectV2SingleSelectField","id":"status","name":"Status","dataType":"SINGLE_SELECT","isIssueField":true,"options":[{"id":"done","name":"Done","color":"GREEN","description":"Delivered"}]},
            {"__typename":"ProjectV2MultiSelectField","id":"teams","name":"Teams","dataType":"MULTI_SELECT","isIssueField":false,"multiSelectOptions":[{"id":"web","name":"Web","color":"BLUE","description":"Browser"}]},
            {"__typename":"ProjectV2IterationField","id":"sprint","name":"Sprint","dataType":"ITERATION","configuration":{"iterations":[{"id":"next","title":"Next","startDate":"2026-09-15","duration":14}],"completedIterations":[{"id":"past","title":"Past","startDate":"2026-09-01","duration":14}]}},
            {"__typename":"ProjectV2Field","id":"notes","name":"Notes","dataType":"TEXT","isIssueField":false},
            {"__typename":"ProjectV2Field","id":"points","name":"Points","dataType":"NUMBER","isIssueField":false},
            {"__typename":"ProjectV2Field","id":"due","name":"Due","dataType":"DATE","isIssueField":true},
            {"__typename":"ProjectV2Field","id":"labels","name":"Labels","dataType":"LABELS"}
        ]}}}})
    }

    fn assert_keys(value: &Value, expected: &[&str]) {
        let obj = value.as_object().expect("wire value is an object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, expected);
    }

    fn field_updates() -> Vec<FieldValueUpdate> {
        vec![
            FieldValueUpdate::Text {
                field_id: "notes".into(),
                text: "@secret\n\"quoted\" {repo}".into(),
            },
            FieldValueUpdate::Number {
                field_id: "points".into(),
                number: 0.0001,
            },
            FieldValueUpdate::Date {
                field_id: "due".into(),
                date: "2027-01-01".into(),
            },
            FieldValueUpdate::SingleSelect {
                field_id: "status".into(),
                option_id: "done".into(),
            },
            FieldValueUpdate::MultiSelect {
                field_id: "teams".into(),
                option_ids: vec!["web".into(), "api".into()],
            },
            FieldValueUpdate::Iteration {
                field_id: "sprint".into(),
                iteration_id: "past".into(),
            },
        ]
    }

    #[test]
    fn field_update_serialization_pins_every_camel_case_key() {
        let expected: [(&str, &[&str]); 6] = [
            ("text", &["fieldId", "kind", "text"]),
            ("number", &["fieldId", "kind", "number"]),
            ("date", &["date", "fieldId", "kind"]),
            ("singleSelect", &["fieldId", "kind", "optionId"]),
            ("multiSelect", &["fieldId", "kind", "optionIds"]),
            ("iteration", &["fieldId", "iterationId", "kind"]),
        ];
        for (update, (kind, keys)) in field_updates().iter().zip(expected) {
            let wire = serde_json::to_value(update).expect("update serializes");
            assert_keys(&wire, keys);
            assert_eq!(wire["kind"], kind);
        }
    }

    #[test]
    fn field_updates_deserialize_from_the_typescript_contract() {
        let updates: Vec<FieldValueUpdate> = serde_json::from_value(json!([
            {"kind":"text","fieldId":"notes","text":"@secret\n\"quoted\" {repo}"},
            {"kind":"number","fieldId":"points","number":0.0001},
            {"kind":"date","fieldId":"due","date":"2027-01-01"},
            {"kind":"singleSelect","fieldId":"status","optionId":"done"},
            {"kind":"multiSelect","fieldId":"teams","optionIds":["web","api"]},
            {"kind":"iteration","fieldId":"sprint","iterationId":"past"}
        ]))
        .expect("TS-shaped updates deserialize");
        assert_eq!(updates.len(), 6);
        for (actual, expected) in updates.iter().zip(field_updates()) {
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap(),
            );
        }
    }

    #[test]
    fn two_updates_and_a_clear_share_one_graphql_request() {
        let args = build_set_item_field_values_args(
            "PVT_project",
            "PVTI_item",
            &field_updates()[..2],
            &["due".into()],
        )
        .expect("valid batch");
        assert_eq!(&args[..2], &["api", "graphql"]);
        let query = args.last().unwrap();
        assert_eq!(query.matches("updateProjectV2ItemFieldValue(").count(), 2);
        assert_eq!(query.matches("clearProjectV2ItemFieldValue(").count(), 1);
        for alias in ["s0:", "s1:", "c0:"] {
            assert_eq!(query.matches(alias).count(), 1);
        }
        assert!(!query.contains("s2:"));
        assert!(!query.contains("c1:"));
        assert!(query.contains("$f0:ID!,$v0:String!,$f1:ID!,$g0:ID!"));
        assert!(query.contains("value:{number:0.0001}"));
        assert!(!query.contains("$v1"));
        for scalar in [
            "PVT_project",
            "PVTI_item",
            "notes",
            "points",
            "due",
            "@secret",
        ] {
            assert!(
                !query.contains(scalar),
                "data must stay outside the document: {scalar}"
            );
        }
        let fields: Vec<_> = args[2..args.len() - 2]
            .chunks_exact(2)
            .map(|pair| (pair[0].as_str(), pair[1].as_str()))
            .collect();
        assert_eq!(
            fields,
            [
                ("-f", "p=PVT_project"),
                ("-f", "i=PVTI_item"),
                ("-f", "f0=notes"),
                ("-f", "v0=@secret\n\"quoted\" {repo}"),
                ("-f", "f1=points"),
                ("-f", "g0=due"),
            ]
        );
    }

    #[test]
    fn every_update_kind_uses_its_value_key_and_scalar_transport() {
        let args =
            build_set_item_field_values_args("PVT_project", "PVTI_item", &field_updates(), &[])
                .expect("valid full-spread batch");
        let query = args.last().unwrap();
        for (n, key) in [
            "text",
            "number",
            "date",
            "singleSelectOptionId",
            "multiSelectOptionIds",
            "iterationId",
        ]
        .iter()
        .enumerate()
        {
            let value = if *key == "number" {
                "0.0001".to_string()
            } else {
                format!("$v{n}")
            };
            assert!(query.contains(&format!("value:{{{key}:{value}}}")));
        }
        assert!(query.contains("$v2:Date!"));
        assert!(query.contains("$v4:[String!]!"));
        let fields: Vec<_> = args[2..].chunks_exact(2).collect();
        for pair in &fields {
            assert_eq!(pair[0], "-f");
        }
        for scalar in [
            "v2=2027-01-01",
            "v3=done",
            "v4[]=web",
            "v4[]=api",
            "v5=past",
        ] {
            assert!(args.iter().any(|arg| arg == scalar));
        }
    }

    #[test]
    fn double_digit_update_aliases_and_variables_are_distinct() {
        let updates: Vec<_> = (0..11)
            .map(|n| FieldValueUpdate::Text {
                field_id: format!("field-{n}"),
                text: format!("text-{n}"),
            })
            .collect();
        let args = build_set_item_field_values_args("project", "item", &updates, &[]).unwrap();
        let query = args.last().unwrap();
        let declarations: Vec<_> = query
            .strip_prefix("query=mutation(")
            .unwrap()
            .split_once(')')
            .unwrap()
            .0
            .split(',')
            .collect();
        for declaration in ["$f1:ID!", "$f10:ID!", "$v1:String!", "$v10:String!"] {
            assert_eq!(
                declarations.iter().filter(|d| **d == declaration).count(),
                1
            );
        }
        assert_eq!(query.matches("updateProjectV2ItemFieldValue(").count(), 11);
        for n in 0..11 {
            assert_eq!(query.matches(&format!("s{n}: ")).count(), 1);
        }
        assert!(query.contains("s10: updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f10,value:{text:$v10}})"));
        let pairs: Vec<_> = args[2..]
            .chunks_exact(2)
            .map(|pair| (pair[0].as_str(), pair[1].as_str()))
            .collect();
        for pair in [
            ("-f", "f1=field-1"),
            ("-f", "f10=field-10"),
            ("-f", "v10=text-10"),
        ] {
            assert!(pairs.contains(&pair));
        }
    }

    #[test]
    fn empty_text_uses_an_empty_value_argument() {
        let args = build_set_item_field_values_args(
            "project",
            "item",
            &[FieldValueUpdate::Text {
                field_id: "notes".into(),
                text: String::new(),
            }],
            &[],
        )
        .unwrap();
        assert!(args[2..].chunks_exact(2).any(|pair| pair == ["-f", "v0="]));
        assert!(!args.iter().any(|arg| arg == "v0" || arg == "v0[]"));
        assert!(args.last().unwrap().contains("value:{text:$v0}"));
    }

    #[tokio::test]
    async fn field_write_errors_keep_their_serialized_kind() {
        let result: AppResult<()> = gh_set_item_field_values(
            String::new(),
            String::new(),
            "item".into(),
            vec![],
            vec!["field".into()],
        )
        .await;
        let wire = serde_json::to_value(result.unwrap_err()).unwrap();
        assert_eq!(wire["kind"], "invalidArgument");
        let wire = serde_json::to_value(map_field_write_error(AppError::GhNotFound)).unwrap();
        assert_eq!(wire["kind"], "ghNotFound");
    }

    #[test]
    fn finite_numbers_are_document_literals_without_value_variables() {
        for (number, literal) in [
            (0.0001, "0.0001"),
            (1e-7, "0.0000001"),
            (-1e-7, "-0.0000001"),
            (3.0, "3"),
            (-0.0, "-0"),
        ] {
            let args = build_set_item_field_values_args(
                "project",
                "item",
                &[FieldValueUpdate::Number {
                    field_id: "points".into(),
                    number,
                }],
                &[],
            )
            .unwrap();
            let query = args.last().unwrap();
            assert!(query.contains(&format!("value:{{number:{literal}}}")));
            assert!(!query.contains("$v0"));
            assert!(!query.contains("Float!"));
            assert_eq!(
                &args[..args.len() - 2],
                &[
                    "api",
                    "graphql",
                    "-f",
                    "p=project",
                    "-f",
                    "i=item",
                    "-f",
                    "f0=points"
                ]
            );
        }
    }

    #[test]
    fn empty_multi_select_and_clear_only_batches_are_supported() {
        let args = build_set_item_field_values_args(
            "PVT_project",
            "PVTI_item",
            &[FieldValueUpdate::MultiSelect {
                field_id: "teams".into(),
                option_ids: vec![],
            }],
            &[],
        )
        .unwrap();
        assert!(args.windows(2).any(|pair| pair == ["-f", "v0[]"]));
        let args =
            build_set_item_field_values_args("PVT_project", "PVTI_item", &[], &["teams".into()])
                .unwrap();
        let query = args.last().unwrap();
        assert!(query.contains("c0: clearProjectV2ItemFieldValue"));
        assert!(!query.contains("updateProjectV2ItemFieldValue"));
    }

    #[tokio::test]
    async fn empty_field_writes_need_neither_a_repo_nor_ids() {
        assert!(gh_set_item_field_values(
            String::new(),
            String::new(),
            String::new(),
            vec![],
            vec![]
        )
        .await
        .is_ok());
    }

    #[test]
    fn every_variable_id_passes_the_embed_gate() {
        for bad in ["", "@secret", "bad\"}", "bad\n", "bad&value"] {
            let mut cases = vec![
                build_set_item_field_values_args(bad, "item", &[], &["field".into()]),
                build_set_item_field_values_args("project", bad, &[], &["field".into()]),
                build_set_item_field_values_args("project", "item", &[], &[bad.into()]),
            ];
            for mut update in field_updates() {
                let field_id = match &mut update {
                    FieldValueUpdate::Text { field_id, .. }
                    | FieldValueUpdate::Number { field_id, .. }
                    | FieldValueUpdate::Date { field_id, .. }
                    | FieldValueUpdate::SingleSelect { field_id, .. }
                    | FieldValueUpdate::MultiSelect { field_id, .. }
                    | FieldValueUpdate::Iteration { field_id, .. } => field_id,
                };
                *field_id = bad.into();
                cases.push(build_set_item_field_values_args(
                    "project",
                    "item",
                    &[update],
                    &[],
                ));
            }
            for update in [
                FieldValueUpdate::SingleSelect {
                    field_id: "field".into(),
                    option_id: bad.into(),
                },
                FieldValueUpdate::MultiSelect {
                    field_id: "field".into(),
                    option_ids: vec!["valid".into(), bad.into()],
                },
                FieldValueUpdate::Iteration {
                    field_id: "field".into(),
                    iteration_id: bad.into(),
                },
            ] {
                cases.push(build_set_item_field_values_args(
                    "project",
                    "item",
                    &[update],
                    &[],
                ));
            }
            for case in cases {
                assert!(matches!(case, Err(AppError::InvalidArgument(_))));
            }
        }
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(build_set_item_field_values_args(
                "project",
                "item",
                &[FieldValueUpdate::Number {
                    field_id: "points".into(),
                    number
                },],
                &[]
            )
            .is_err());
        }
    }

    #[test]
    fn partial_field_write_failures_return_the_first_error_and_map_scopes() {
        let response = json!({"data":{"s0":{"projectV2Item":{"id":"item"}},"s1":null},
            "errors":[{"message":"first failure","path":["s1"]},{"message":"second failure"}]})
        .to_string();
        assert_eq!(
            parse_field_write_response(&response)
                .unwrap_err()
                .to_string(),
            "first failure"
        );
        assert_eq!(
            map_field_write_error(AppError::Gh("gh: first failure\nsecond failure".into()))
                .to_string(),
            "first failure"
        );
        assert_eq!(
            map_field_write_error(AppError::Gh("connection reset".into())).to_string(),
            "connection reset"
        );
        for message in [
            "Your token has not been granted the required scopes to execute this query.",
            "missing scope read:project",
        ] {
            let response = json!({"errors":[{"message":message}]}).to_string();
            assert_eq!(
                parse_field_write_response(&response)
                    .unwrap_err()
                    .to_string(),
                FIELDS_SCOPE_HINT
            );
            assert_eq!(
                map_field_write_error(AppError::Gh(format!("gh: {message}\nsecond failure")))
                    .to_string(),
                FIELDS_SCOPE_HINT
            );
        }
        assert!(
            parse_field_write_response(r#"{"data":{"s0":{"projectV2Item":{"id":"item"}}}}"#)
                .is_ok()
        );
        assert!(parse_field_write_response("not JSON").is_err());
    }

    #[test]
    fn definitions_cover_builtins_empty_options_and_completed_only_iterations() {
        let builtins = json!({"data":{"node":{"fields":{"nodes":[
            {"id":"title","name":"Title","dataType":"TITLE"},
            {"id":"labels","name":"Labels","dataType":"LABELS"}
        ]}}}});
        let defs = parse_project_fields(&builtins).fields;
        assert_eq!(defs.len(), 2);
        assert!(defs
            .iter()
            .all(|def| matches!(def, ProjectFieldDef::System { .. })));
        let response = json!({"data":{"node":{"fields":{"nodes":[
            {"id":"status","dataType":"SINGLE_SELECT","options":[]},
            {"id":"sprint","dataType":"ITERATION","configuration":{"iterations":[],"completedIterations":[{"id":"past","title":"Past","startDate":"2026-09-01","duration":14}]}},
            {"id":"teams","dataType":"MULTI_SELECT","isIssueField":true,"multiSelectOptions":[{"id":"web","name":"Web","color":"BLUE"}]}
        ]}}}});
        let defs = serde_json::to_value(parse_project_fields(&response).fields).unwrap();
        assert_eq!(defs[0]["options"], json!([]));
        assert_eq!(defs[1]["iterations"], json!([]));
        assert_eq!(defs[1]["completedIterations"][0]["id"], "past");
        assert_eq!(defs[2]["kind"], "multiSelect");
        assert_eq!(defs[2]["isIssueField"], true);
        assert_eq!(defs[2]["options"][0]["id"], "web");
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
                    "iterationId",
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
    fn field_definition_wrapper_reports_truncation_tolerantly() {
        for (page_info, truncated) in [
            (None, false),
            (Some(Value::Null), false),
            (Some(json!({})), false),
            (Some(json!({"hasNextPage": null})), false),
            (Some(json!({"hasNextPage": "true"})), false),
            (Some(json!({"hasNextPage": false})), false),
            (Some(json!({"hasNextPage": true})), true),
        ] {
            let mut response = field_defs();
            if let Some(page_info) = page_info {
                response["data"]["node"]["fields"]["pageInfo"] = page_info;
            }
            let defs = parse_project_fields(&response);
            assert_eq!(defs.truncated, truncated);
            assert_eq!(defs.fields.len(), 7);
            let wire = serde_json::to_value(defs).unwrap();
            assert_keys(&wire, &["fields", "truncated"]);
            assert_eq!(wire["truncated"], truncated);
            assert_eq!(wire["fields"][0]["id"], "status");
        }
        let defs = parse_project_fields(&Value::Null);
        assert!(defs.fields.is_empty());
        assert!(!defs.truncated);
    }

    #[test]
    fn field_definition_wire_shapes_are_camel_case() {
        let defs = parse_project_fields(&field_defs()).fields;
        assert_eq!(defs.len(), 7);
        let expected: [(&str, &[&str]); 7] = [
            (
                "singleSelect",
                &["id", "isIssueField", "kind", "name", "options"],
            ),
            (
                "multiSelect",
                &["id", "isIssueField", "kind", "name", "options"],
            ),
            (
                "iteration",
                &["completedIterations", "id", "iterations", "kind", "name"],
            ),
            ("text", &["id", "isIssueField", "kind", "name"]),
            ("number", &["id", "isIssueField", "kind", "name"]),
            ("date", &["id", "isIssueField", "kind", "name"]),
            ("system", &["dataType", "id", "kind", "name"]),
        ];
        for (def, (kind, keys)) in defs.iter().zip(expected) {
            let wire = serde_json::to_value(def).expect("field definition serializes");
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
                {"kind":"iteration","fieldId":"sprint","fieldName":"Sprint","iterationId":"sprint-1","title":"Sprint 1","startDate":"2026-09-01","duration":14,"isIssueField":false}
            ])
        );
    }

    #[test]
    fn iteration_values_without_a_string_id_are_unknown() {
        for iteration_id in [None, Some(Value::Null), Some(json!(7))] {
            let mut node = custom_values()[5].clone();
            node.as_object_mut().unwrap().remove("iterationId");
            if let Some(iteration_id) = iteration_id {
                node["iterationId"] = iteration_id;
            }
            assert_eq!(
                serde_json::to_value(parse_field_value(&node)).unwrap(),
                json!({"kind":"unknown","fieldName":"Sprint"})
            );
        }
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
        for response in [
            json!({"data":{"node":{"fields":{"nodes":[]}}}}),
            json!({"data":{"node":{"fields":null}}}),
            json!({"data":{"node":null}}),
            Value::Null,
        ] {
            assert!(parse_project_fields(&response).fields.is_empty());
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
        let response = json!({"data":{"node":{"fields":{"nodes":[
            {"id":"select","dataType":"SINGLE_SELECT","options":[{"id":"option","description":null}]},
            {"id":"multi","dataType":"MULTI_SELECT","multiSelectOptions":null},
            {"id":"iteration","dataType":"ITERATION","configuration":null},
            {"id":"unknown"}, {"id":null}, null
        ]}}}});
        let defs = serde_json::to_value(parse_project_fields(&response).fields)
            .expect("partial definitions serialize");
        assert_eq!(defs.as_array().expect("definitions array").len(), 4);
        assert_eq!(defs[0]["options"][0]["description"], "");
        assert_eq!(defs[1]["options"], json!([]));
        assert_eq!(defs[2]["iterations"], json!([]));
        assert_eq!(defs[2]["completedIterations"], json!([]));
        assert_eq!(defs[3]["dataType"], "");
    }

    #[test]
    fn definitions_keep_options_and_both_iteration_lists() {
        let defs = serde_json::to_value(parse_project_fields(&field_defs()).fields)
            .expect("definitions serialize");
        assert_eq!(
            defs[0]["options"],
            json!([{"id":"done","name":"Done","color":"GREEN","description":"Delivered"}])
        );
        assert_eq!(defs[0]["isIssueField"], true);
        assert_eq!(
            defs[1]["options"],
            json!([{"id":"web","name":"Web","color":"BLUE","description":"Browser"}])
        );
        assert_eq!(
            defs[2]["iterations"],
            json!([{"id":"next","title":"Next","startDate":"2026-09-15","duration":14}])
        );
        assert_eq!(
            defs[2]["completedIterations"],
            json!([{"id":"past","title":"Past","startDate":"2026-09-01","duration":14}])
        );
        assert_keys(
            &defs[0]["options"][0],
            &["color", "description", "id", "name"],
        );
        assert_keys(
            &defs[2]["iterations"][0],
            &["duration", "id", "startDate", "title"],
        );
    }

    #[test]
    fn system_and_future_data_types_stay_readable() {
        for data_type in [
            "ASSIGNEES",
            "LABELS",
            "MILESTONE",
            "REPOSITORY",
            "TITLE",
            "TRACKS",
            "TRACKED_BY",
            "ISSUE_TYPE",
            "PARENT_ISSUE",
            "SUB_ISSUES_PROGRESS",
            "CREATED",
            "UPDATED",
            "CLOSED",
            "LINKED_PULL_REQUESTS",
            "REVIEWERS",
            "FUTURE_TYPE",
        ] {
            let response = json!({"data":{"node":{"fields":{"nodes":[{"__typename":"ProjectV2Field","id":"field","name":"System","dataType":data_type}]}}}});
            let defs = serde_json::to_value(parse_project_fields(&response).fields)
                .expect("system field serializes");
            assert_eq!(
                defs,
                json!([{"kind":"system","id":"field","name":"System","dataType":data_type}])
            );
        }
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
                    "/iterationId",
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
    fn every_definition_pointer_names_a_field_the_query_actually_asks_for() {
        let query = project_fields_query();
        assert_query_fields(
            &query,
            &[
                PROJECT_FIELDS_POINTER,
                PROJECT_FIELDS_TRUNCATED_POINTER,
                "/id",
                "/name",
                "/dataType",
                "/isIssueField",
                "/options/id",
                "/options/name",
                "/options/color",
                "/options/description",
                "/multiSelectOptions/id",
                "/multiSelectOptions/name",
                "/multiSelectOptions/color",
                "/multiSelectOptions/description",
                "/configuration/iterations/id",
                "/configuration/iterations/title",
                "/configuration/iterations/startDate",
                "/configuration/iterations/duration",
                "/configuration/completedIterations/id",
                "/configuration/completedIterations/title",
                "/configuration/completedIterations/startDate",
                "/configuration/completedIterations/duration",
            ],
        );
        assert!(query.starts_with("query($id:ID!)"));
        assert!(query.contains("node(id:$id)"));
        assert!(query.contains("fields(first:50)"));
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
