//! Projects v2 field values and definitions for issue and PR sidebars.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::issue::repo_owner_name;
use crate::github::pr::validate_graphql_embed;
use crate::github::project::{item_projects_truncated, project_ref, ProjectV2Ref, PROJECT_FIELDS};
use crate::github::project_item_edits::{
    bulk_document, bulk_outcomes, graphql_input, run_bulk_documents, strip_gh_prefix, BulkDocument,
    BulkItemOutcomes, BULK_ALIAS_CAP, GRAPHQL_INPUT_ARGS,
};
use crate::github::project_items::AssigneeRef;
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjectFieldValues {
    pub item_id: String,
    pub project: ProjectV2Ref,
    pub values: Vec<ProjectFieldValue>,
}

/// Per-board field values for one issue/PR, plus whether the capped read left some out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemFieldValues {
    pub items: Vec<ItemProjectFieldValues>,
    /// The item's `projectItems(first:20)` connection reported another page.
    pub truncated: bool,
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
    Users {
        field_id: String,
        field_name: String,
        total_count: u64,
        users: Vec<AssigneeRef>,
        is_issue_field: bool,
    },
    Labels {
        field_id: String,
        field_name: String,
        total_count: u64,
        labels: Vec<LabelLite>,
        is_issue_field: bool,
    },
    Milestone {
        field_id: String,
        field_name: String,
        title: String,
        /// GitHub's nullable `dueOn` timestamp verbatim; absent (not null) when the
        /// milestone has no due date, so a reader never meets a fabricated one.
        #[serde(skip_serializing_if = "Option::is_none")]
        due_on: Option<String>,
        is_issue_field: bool,
    },
    Repository {
        field_id: String,
        field_name: String,
        name_with_owner: String,
        is_issue_field: bool,
    },
    Reviewers {
        field_id: String,
        field_name: String,
        total_count: u64,
        reviewers: Vec<String>,
        is_issue_field: bool,
    },
    PullRequests {
        field_id: String,
        field_name: String,
        total_count: u64,
        pull_requests: Vec<LinkedPrLite>,
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
#[serde(rename_all = "camelCase")]
pub struct LabelLite {
    pub name: String,
    pub color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPrLite {
    pub number: u64,
    pub repo_name_with_owner: String,
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

fn build_field_value_literal(
    n: usize,
    update: &FieldValueUpdate,
    variables: &mut Vec<String>,
    args: &mut Vec<String>,
) -> AppResult<String> {
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
    Ok(format!("fieldId:$f{n},value:{{{key}:{value}}}"))
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
        let input = build_field_value_literal(n, update, &mut variables, &mut args)?;
        parts.push(format!(
            "s{n}: updateProjectV2ItemFieldValue(input:{{projectId:$p,itemId:$i,{input}}}){{projectV2Item{{id}}}}"
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

// Field builders emit raw -f strings and bracket arrays only. Preserve those types
// in JSON so both write paths can use stdin without duplicating the literal builder.
fn field_write_input(args: &[String]) -> String {
    let mut variables = json!({});
    let mut document = None;
    for pair in args[2..].as_chunks::<2>().0 {
        debug_assert_eq!(pair[0], "-f");
        let (key, value) = pair[1]
            .split_once('=')
            .map_or((pair[1].as_str(), None), |(key, value)| (key, Some(value)));
        if key == "query" {
            document = value;
        } else if let Some(key) = key.strip_suffix("[]") {
            let values = variables
                .as_object_mut()
                .expect("variables object")
                .entry(key)
                .or_insert_with(|| json!([]));
            if let Some(value) = value {
                values
                    .as_array_mut()
                    .expect("array variable")
                    .push(json!(value));
            }
        } else {
            variables[key] = json!(value.expect("scalar variable"));
        }
    }
    graphql_input(document.expect("field mutation document"), variables)
}

fn build_bulk_field_documents(
    project_id: &str,
    item_ids: &[String],
    updates: &[FieldValueUpdate],
    clears: &[String],
) -> AppResult<Vec<BulkDocument>> {
    if item_ids.is_empty() {
        return Err(AppError::InvalidArgument(
            "project item ids must not be empty".into(),
        ));
    }
    validate_graphql_embed(project_id, "project id")?;
    let mut documents = Vec::new();
    let mut declarations = vec!["$p:ID!".into()];
    let mut args = vec![
        "api".into(), "graphql".into(), "-f".into(), format!("p={project_id}"),
    ];
    let mut parts = Vec::new();
    let mut item_indices = Vec::new();
    for (item_index, item_id) in item_ids.iter().enumerate() {
        validate_graphql_embed(item_id, "project item id")?;
        for op in 0..updates.len() + clears.len() {
            let n = parts.len();
            declarations.push(format!("$i{n}:ID!"));
            args.extend(["-f".into(), format!("i{n}={item_id}")]);
            let part = if let Some(update) = updates.get(op) {
                let input = build_field_value_literal(n, update, &mut declarations, &mut args)?;
                format!("updateProjectV2ItemFieldValue(input:{{projectId:$p,itemId:$i{n},{input}}}){{projectV2Item{{id}}}}")
            } else {
                let field_id = &clears[op - updates.len()];
                validate_graphql_embed(field_id, "field id")?;
                declarations.push(format!("$g{n}:ID!"));
                args.extend(["-f".into(), format!("g{n}={field_id}")]);
                format!("clearProjectV2ItemFieldValue(input:{{projectId:$p,itemId:$i{n},fieldId:$g{n}}}){{projectV2Item{{id}}}}")
            };
            parts.push(part);
            item_indices.push(item_index);
            if parts.len() == BULK_ALIAS_CAP {
                documents.push(bulk_document(
                    std::mem::replace(&mut declarations, vec!["$p:ID!".into()]),
                    std::mem::take(&mut parts),
                    std::mem::replace(
                        &mut args,
                        vec!["api".into(), "graphql".into(), "-f".into(), format!("p={project_id}")],
                    ),
                    std::mem::take(&mut item_indices),
                    "/projectV2Item/id",
                ));
            }
        }
    }
    if !parts.is_empty() {
        documents.push(bulk_document(
            declarations, parts, args, item_indices, "/projectV2Item/id",
        ));
    }
    for document in &mut documents {
        document.input = Some(field_write_input(&document.args));
        document.args = GRAPHQL_INPUT_ARGS
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
    }
    Ok(documents)
}

fn map_field_write_error(error: AppError) -> AppError {
    map_scope_error(strip_gh_prefix(error))
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
    let input = field_write_input(&args);
    let out = run_gh_input(
        Some(&repo_path),
        &GRAPHQL_INPUT_ARGS,
        &input,
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(map_field_write_error)?;
    parse_field_write_response(&out.stdout_lossy())
}

/// Duplicate ids execute independently in input order. Each item keeps its first
/// failed field-op error; fields may partially apply, so callers must refetch on failure.
/// Empty updates and clears succeed without a request when item_ids is nonempty.
#[tauri::command]
pub async fn gh_set_items_field_values(
    repo_path: String,
    project_id: String,
    item_ids: Vec<String>,
    updates: Vec<FieldValueUpdate>,
    clears: Vec<String>,
) -> AppResult<BulkItemOutcomes> {
    let outcomes = bulk_outcomes(&item_ids)?;
    let documents = build_bulk_field_documents(&project_id, &item_ids, &updates, &clears)?;
    Ok(run_bulk_documents(&repo_path, outcomes, documents, map_field_write_error).await)
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
pub(super) fn field_value_selection(rich: bool) -> String {
    let connections = if rich {
        format!(
            "... on ProjectV2ItemFieldUserValue{{ field{{ {FIELD_COMMON} }} users(first:20){{ totalCount nodes{{ login avatarUrl }} }} }} \
             ... on ProjectV2ItemFieldLabelValue{{ field{{ {FIELD_COMMON} }} labels(first:20){{ totalCount nodes{{ name color }} }} }} \
             ... on ProjectV2ItemFieldReviewerValue{{ field{{ {FIELD_COMMON} }} reviewers(first:20){{ totalCount nodes{{ __typename \
               ... on User{{ login }} ... on Team{{ name }} ... on Mannequin{{ login }} \
               ... on Bot{{ login }} ... on EnterpriseTeam{{ name }} }} }} }} \
             ... on ProjectV2ItemFieldPullRequestValue{{ field{{ {FIELD_COMMON} }} pullRequests(first:20){{ totalCount nodes{{ number repository{{ nameWithOwner }} }} }} }}"
        )
    } else {
        String::new()
    };
    format!(
        "__typename \
         ... on ProjectV2ItemFieldSingleSelectValue{{ field{{ {FIELD_COMMON} }} name optionId color }} \
         ... on ProjectV2ItemFieldMultiSelectValue{{ field{{ {FIELD_COMMON} }} options{{ id name color }} }} \
         ... on ProjectV2ItemFieldTextValue{{ field{{ {FIELD_COMMON} }} text }} \
         ... on ProjectV2ItemFieldNumberValue{{ field{{ {FIELD_COMMON} }} number }} \
         ... on ProjectV2ItemFieldDateValue{{ field{{ {FIELD_COMMON} }} date }} \
         ... on ProjectV2ItemFieldIterationValue{{ field{{ {FIELD_COMMON} }} iterationId title startDate duration }} \
         ... on ProjectV2ItemFieldMilestoneValue{{ field{{ {FIELD_COMMON} }} milestone{{ title dueOn }} }} \
         ... on ProjectV2ItemFieldRepositoryValue{{ field{{ {FIELD_COMMON} }} repository{{ nameWithOwner }} }} \
         {connections} \
         ... on ProjectV2ItemIssueFieldValue{{ field{{ {FIELD_COMMON} }} issueFieldValue{{ __typename \
           ... on IssueFieldSingleSelectValue{{ name optionId color }} \
           ... on IssueFieldMultiSelectValue{{ options{{ id name color }} }} \
           ... on IssueFieldTextValue{{ text: value }} \
           ... on IssueFieldNumberValue{{ number: value }} \
           ... on IssueFieldDateValue{{ date: value }} \
         }} }}"
    )
}

fn item_field_values_query(field: &str) -> String {
    let values = field_value_selection(true);
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{ \
         repository(owner:$owner,name:$name){{ {field}(number:$number){{ \
         projectItems(first:20, includeArchived:true){{ pageInfo{{ hasNextPage }} nodes{{ id project{{ {PROJECT_FIELDS} }} \
         fieldValues(first:50){{ nodes{{ {values} \
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

pub(super) fn parse_field_value(node: &Value) -> ProjectFieldValue {
    let field = &node["field"];
    let field_id = text(field, "id");
    let field_name = text(field, "name");
    // Every fragment either selection includes selects FIELD_COMMON, so a node with
    // no field id matched no fragment (a bare `__typename`): nothing to parse.
    if field_id.is_empty() {
        return ProjectFieldValue::Unknown { field_name };
    }
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
        ("ProjectV2ItemFieldUserValue", _) => ProjectFieldValue::Users {
            field_id,
            field_name,
            total_count: value["users"]["totalCount"].as_u64().unwrap_or(0),
            users: array(&value["users"]["nodes"])
                .filter_map(|user| {
                    Some(AssigneeRef {
                        login: user["login"].as_str()?.to_string(),
                        avatar_url: text(user, "avatarUrl"),
                    })
                })
                .collect(),
            is_issue_field,
        },
        ("ProjectV2ItemFieldLabelValue", _) => ProjectFieldValue::Labels {
            field_id,
            field_name,
            total_count: value["labels"]["totalCount"].as_u64().unwrap_or(0),
            labels: array(&value["labels"]["nodes"])
                .filter_map(|label| {
                    Some(LabelLite {
                        name: label["name"].as_str()?.to_string(),
                        color: text(label, "color"),
                    })
                })
                .collect(),
            is_issue_field,
        },
        ("ProjectV2ItemFieldMilestoneValue", _) => ProjectFieldValue::Milestone {
            field_id,
            field_name,
            title: text(&value["milestone"], "title"),
            due_on: value["milestone"]["dueOn"]
                .as_str()
                .filter(|due| !due.is_empty())
                .map(str::to_string),
            is_issue_field,
        },
        ("ProjectV2ItemFieldRepositoryValue", _) => ProjectFieldValue::Repository {
            field_id,
            field_name,
            name_with_owner: text(&value["repository"], "nameWithOwner"),
            is_issue_field,
        },
        ("ProjectV2ItemFieldReviewerValue", _) => ProjectFieldValue::Reviewers {
            field_id,
            field_name,
            total_count: value["reviewers"]["totalCount"].as_u64().unwrap_or(0),
            reviewers: array(&value["reviewers"]["nodes"])
                .filter_map(|reviewer| match reviewer["__typename"].as_str()? {
                    "User" | "Mannequin" | "Bot" => reviewer["login"].as_str(),
                    "Team" | "EnterpriseTeam" => reviewer["name"].as_str(),
                    _ => None,
                })
                .map(str::to_string)
                .collect(),
            is_issue_field,
        },
        ("ProjectV2ItemFieldPullRequestValue", _) => ProjectFieldValue::PullRequests {
            field_id,
            field_name,
            total_count: value["pullRequests"]["totalCount"].as_u64().unwrap_or(0),
            pull_requests: array(&value["pullRequests"]["nodes"])
                .filter_map(|pr| {
                    Some(LinkedPrLite {
                        number: pr["number"].as_u64()?,
                        repo_name_with_owner: text(&pr["repository"], "nameWithOwner"),
                    })
                })
                .collect(),
            is_issue_field,
        },
        _ => ProjectFieldValue::Unknown { field_name },
    }
}

fn parse_item_field_values(value: &Value, field: &str) -> ItemFieldValues {
    let items = value
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
        .collect();
    ItemFieldValues {
        items,
        truncated: item_projects_truncated(value, field),
    }
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
) -> AppResult<ItemFieldValues> {
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

    #[test]
    fn item_field_values_envelope_serializes_with_camel_case_keys() {
        for truncated in [false, true] {
            let response = serde_json::json!({"data":{"repository":{"issue":{"projectItems":{
                "nodes":[], "pageInfo":{"hasNextPage":truncated}
            }}}}});
            let wire = serde_json::to_value(parse_item_field_values(&response, "issue"))
                .expect("envelope serializes");
            assert_eq!(wire, serde_json::json!({"items":[], "truncated":truncated}));
        }
    }

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
    fn table_field_values_preserve_payloads_counts_and_wire_keys() {
        let users: Vec<_> = (0..20)
            .map(|n| json!({"login":format!("user{n}"),"avatarUrl":format!("https://avatars/{n}")}))
            .collect();
        let cases: [(&str, Value, Value, &[&str]); 6] = [
            (
                "ProjectV2ItemFieldUserValue",
                json!({"users":{"totalCount":25,"nodes":users}}),
                json!({"kind":"users","totalCount":25,"users":users}),
                &["fieldId", "fieldName", "isIssueField", "kind", "totalCount", "users"],
            ),
            (
                "ProjectV2ItemFieldLabelValue",
                json!({"labels":{"totalCount":3,"nodes":[{"name":"bug","color":"ff0000"}]}}),
                json!({"kind":"labels","totalCount":3,"labels":[{"name":"bug","color":"ff0000"}]}),
                &["fieldId", "fieldName", "isIssueField", "kind", "labels", "totalCount"],
            ),
            (
                "ProjectV2ItemFieldMilestoneValue",
                json!({"milestone":{"title":"Release","dueOn":"2026-10-05T07:00:00Z"}}),
                json!({"kind":"milestone","title":"Release","dueOn":"2026-10-05T07:00:00Z"}),
                &["dueOn", "fieldId", "fieldName", "isIssueField", "kind", "title"],
            ),
            (
                "ProjectV2ItemFieldRepositoryValue",
                json!({"repository":{"nameWithOwner":"org/repo"}}),
                json!({"kind":"repository","nameWithOwner":"org/repo"}),
                &["fieldId", "fieldName", "isIssueField", "kind", "nameWithOwner"],
            ),
            (
                "ProjectV2ItemFieldReviewerValue",
                json!({"reviewers":{"totalCount":9,"nodes":[
                    {"__typename":"User","login":"alice"},
                    {"__typename":"Team","name":"Web"},
                    {"__typename":"FutureReviewer","login":"skip","name":"Skip"},
                    {"__typename":"Mannequin","login":"imported"},
                    {"__typename":"Bot","login":"automation"},
                    {"__typename":"EnterpriseTeam","name":"Platform"}
                ]}}),
                json!({"kind":"reviewers","totalCount":9,"reviewers":["alice","Web","imported","automation","Platform"]}),
                &["fieldId", "fieldName", "isIssueField", "kind", "reviewers", "totalCount"],
            ),
            (
                "ProjectV2ItemFieldPullRequestValue",
                json!({"pullRequests":{"totalCount":4,"nodes":[{"number":42,"repository":{"nameWithOwner":"org/repo"}}]}}),
                json!({"kind":"pullRequests","totalCount":4,"pullRequests":[{"number":42,"repoNameWithOwner":"org/repo"}]}),
                &["fieldId", "fieldName", "isIssueField", "kind", "pullRequests", "totalCount"],
            ),
        ];
        for (typename, mut node, mut expected, keys) in cases {
            node["__typename"] = json!(typename);
            node["field"] = json!({"id":"field","name":"Field","isIssueField":true});
            expected["fieldId"] = json!("field");
            expected["fieldName"] = json!("Field");
            expected["isIssueField"] = json!(true);
            let wire = serde_json::to_value(parse_field_value(&node)).unwrap();
            assert_keys(&wire, keys);
            assert_eq!(wire, expected);
            match wire["kind"].as_str().unwrap() {
                "users" => {
                    assert_eq!(wire["users"].as_array().unwrap().len(), 20);
                    assert_keys(&wire["users"][0], &["avatarUrl", "login"]);
                }
                "labels" => assert_keys(&wire["labels"][0], &["color", "name"]),
                "pullRequests" => {
                    assert_keys(&wire["pullRequests"][0], &["number", "repoNameWithOwner"]);
                }
                _ => {}
            }
        }
    }

    #[test]
    fn milestone_without_a_due_date_omits_the_key() {
        for milestone in [
            json!({"title":"Someday"}),
            json!({"title":"Someday","dueOn":null}),
            json!({"title":"Someday","dueOn":""}),
            json!({"title":"Someday","dueOn":42}),
        ] {
            let node = json!({
                "__typename":"ProjectV2ItemFieldMilestoneValue",
                "field":{"id":"field","name":"Milestone"},
                "milestone":milestone,
            });
            let wire = serde_json::to_value(parse_field_value(&node)).unwrap();
            assert_keys(
                &wire,
                &["fieldId", "fieldName", "isIssueField", "kind", "title"],
            );
            assert_eq!(wire["title"], "Someday");
        }
    }

    #[test]
    fn table_connections_tolerate_empty_absent_and_partial_nodes() {
        for (typename, key) in [
            ("ProjectV2ItemFieldUserValue", "users"),
            ("ProjectV2ItemFieldLabelValue", "labels"),
            ("ProjectV2ItemFieldReviewerValue", "reviewers"),
            ("ProjectV2ItemFieldPullRequestValue", "pullRequests"),
        ] {
            for connection in [
                json!({"totalCount":0,"nodes":[]}),
                Value::Null,
                json!({}),
                json!({"nodes":[null, {}]}),
            ] {
                let mut node = json!({"__typename":typename,"field":{"id":"field","name":"Field"}});
                node[key] = connection;
                let wire = serde_json::to_value(parse_field_value(&node)).unwrap();
                assert_eq!(wire["kind"], key);
                assert_eq!(wire["totalCount"], 0);
                assert_eq!(wire[key], json!([]));
            }
            // The lean selection omits these kinds' fragments, leaving a bare node.
            let bare = parse_field_value(&json!({"__typename":typename}));
            assert!(
                matches!(bare, ProjectFieldValue::Unknown { .. }),
                "{typename}"
            );
        }
    }

    #[test]
    fn table_value_selection_pins_payloads_and_shared_page_caps() {
        for rich in [false, true] {
            let selection = field_value_selection(rich);
            for (typename, payload, connection) in [
                ("ProjectV2ItemFieldUserValue", "users(first:20){ totalCount nodes{ login avatarUrl } }", true),
                ("ProjectV2ItemFieldLabelValue", "labels(first:20){ totalCount nodes{ name color } }", true),
                ("ProjectV2ItemFieldMilestoneValue", "milestone{ title dueOn }", false),
                ("ProjectV2ItemFieldRepositoryValue", "repository{ nameWithOwner }", false),
                ("ProjectV2ItemFieldReviewerValue", "reviewers(first:20){ totalCount nodes{ __typename ... on User{ login } ... on Team{ name } ... on Mannequin{ login } ... on Bot{ login } ... on EnterpriseTeam{ name } } }", true),
                ("ProjectV2ItemFieldPullRequestValue", "pullRequests(first:20){ totalCount nodes{ number repository{ nameWithOwner } } }", true),
            ] {
                if rich || !connection {
                    assert!(selection.contains(&format!(
                        "... on {typename}{{ field{{ {FIELD_COMMON} }} {payload} }}"
                    )));
                } else {
                    assert!(
                        !selection.contains(typename),
                        "lean selection contains {typename}"
                    );
                }
            }
            let query = crate::github::project_items::board_item_selection(rich);
            assert!(query.contains("fieldValues(first:50)"));
            assert!(query.contains(&selection));
        }
        for query in [
            item_field_values_query("issue"),
            item_field_values_query("pullRequest"),
        ] {
            assert!(query.contains("fieldValues(first:50)"));
            assert!(query.contains(&field_value_selection(true)));
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
            json!({"__typename":"ProjectV2ItemFieldTextValue","field":{"id":"title","name":"Title","dataType":"TITLE"},"text":"An item's own title"}),
            json!({"__typename":"FutureProjectValue","field":{"id":"future","name":"Future"}}),
            json!({"__typename":"FutureProjectValue"}),
            json!({"__typename":"ProjectV2ItemIssueFieldValue","field":{"id":"org","name":"Org"},"issueFieldValue":{"__typename":"FutureIssueValue"}}),
            json!({"__typename":"ProjectV2ItemIssueFieldValue","field":{"id":"priority","name":"Priority","dataType":"TEXT"},"issueFieldValue":{"__typename":"IssueFieldSingleSelectValue","optionId":"high","name":"High","color":"RED"}}),
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
                json!({"id":"custom","name":"Custom","dataType":mismatched_type}),
                json!({"id":"custom","name":"Custom","dataType":"FUTURE_TYPE"}),
                json!({"id":"custom","name":"Custom","dataType":null}),
                json!({"id":"custom","name":"Custom"}),
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
            let out = parse_item_field_values(&response, field);
            assert!(!out.truncated);
            let items = out.items;
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
            let out = parse_item_field_values(&response, "issue");
            assert!(out.items.is_empty());
            assert!(!out.truncated);
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
        let out = parse_item_field_values(&response, "issue");
        assert!(!out.truncated);
        let items = out.items;
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
                &json!({"__typename":"ProjectV2ItemFieldNumberValue","field":{"id":"points","dataType":"NUMBER"},"number":null})
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
                    &format!("/data/repository/{field}/projectItems/pageInfo/hasNextPage"),
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
            assert!(query.contains(
                "projectItems(first:20, includeArchived:true){ pageInfo{ hasNextPage }"
            ));
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
    #[test]
    fn bulk_field_document_pins_two_items_by_two_operations() {
        let ids = vec!["PVTI_z".into(), "PVTI_a".into()];
        let docs = build_bulk_field_documents("PVT_p", &ids, &[
            FieldValueUpdate::Text { field_id: "notes".into(), text: "@file\n\"hello\"".into() },
        ], &["due".into()]).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].item_indices, [0, 0, 1, 1]);
        assert_eq!(docs[0].payload_pointer, "/projectV2Item/id");
        assert_eq!(docs[0].args, GRAPHQL_INPUT_ARGS);
        let input: Value = serde_json::from_str(docs[0].input.as_deref().unwrap()).unwrap();
        assert_eq!(input["query"], "mutation($p:ID!,$i0:ID!,$f0:ID!,$v0:String!,$i1:ID!,$g1:ID!,$i2:ID!,$f2:ID!,$v2:String!,$i3:ID!,$g3:ID!){ a0: updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i0,fieldId:$f0,value:{text:$v0}}){projectV2Item{id}} a1: clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i1,fieldId:$g1}){projectV2Item{id}} a2: updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i2,fieldId:$f2,value:{text:$v2}}){projectV2Item{id}} a3: clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i3,fieldId:$g3}){projectV2Item{id}} }");
        assert_eq!(input["variables"], json!({
            "p":"PVT_p", "i0":"PVTI_z", "f0":"notes", "v0":"@file\n\"hello\"",
            "i1":"PVTI_z", "g1":"due", "i2":"PVTI_a", "f2":"notes", "v2":"@file\n\"hello\"",
            "i3":"PVTI_a", "g3":"due",
        }));
    }

    #[test]
    fn bulk_field_chunks_split_an_items_operations_at_the_cap() {
        for (count, sizes) in [(1, vec![2]), (13, vec![25, 1])] {
            let ids: Vec<_> = (0..count).map(|n| format!("PVTI_{n}")).collect();
            let docs = build_bulk_field_documents("PVT_p", &ids, &[], &["notes".into(), "due".into()]).unwrap();
            assert_eq!(docs.iter().map(|doc| doc.item_indices.len()).collect::<Vec<_>>(), sizes);
            assert_eq!(docs.iter().flat_map(|doc| doc.item_indices.iter().copied()).collect::<Vec<_>>(), (0..count).flat_map(|n| [n, n]).collect::<Vec<_>>());
            for doc in &docs {
                let input: Value = serde_json::from_str(doc.input.as_deref().unwrap()).unwrap();
                assert_eq!(doc.args, GRAPHQL_INPUT_ARGS);
                assert_eq!(input["query"].as_str().unwrap().matches("(input:").count(), doc.item_indices.len());
            }
            if count == 13 {
                assert_eq!(docs[0].item_indices[24], 12);
                assert_eq!(docs[1].item_indices, [12]);
                let input: Value = serde_json::from_str(docs[1].input.as_deref().unwrap()).unwrap();
                assert_eq!(input["variables"]["i0"], "PVTI_12");
                assert_eq!(input["variables"]["g0"], "due");
            }
        }
        assert!(build_bulk_field_documents("PVT_p", &[], &[], &["notes".into()]).is_err());
    }

    #[tokio::test]
    async fn bulk_field_failure_aggregates_ops_and_keeps_duplicate_inputs_independent() {
        use crate::github::project_item_edits::run_bulk_documents_with;
        use crate::github::runner::GhOutput;

        let ids = vec!["PVTI_z".into(), "PVTI_a".into(), "PVTI_z".into()];
        let docs = build_bulk_field_documents("PVT_p", &ids, &field_updates()[..2], &[]).unwrap();
        let outcomes = run_bulk_documents_with(bulk_outcomes(&ids).unwrap(), docs, map_field_write_error, |args, input| {
            assert_eq!(args, GRAPHQL_INPUT_ARGS);
            assert!(input.is_some());
            let mut data = json!({});
            for n in 0..6 {
                data[format!("a{n}")] = json!({"projectV2Item":{"id":"PVTI_ok"}});
            }
            data["a1"] = Value::Null;
            std::future::ready(Ok(GhOutput {
                stdout: serde_json::to_vec(&json!({"data":data,"errors":[
                    {"path":["a1","projectV2Item"],"message":"gh: first failure"},
                    {"path":["a1"],"message":"later failure"}
                ]})).unwrap(),
                stderr: "gh: first failure".into(), code: 1,
            }))
        }).await;
        assert_eq!(serde_json::to_value(outcomes).unwrap(), json!({"outcomes":[
            {"itemId":"PVTI_z","error":"first failure"},
            {"itemId":"PVTI_a","error":null},
            {"itemId":"PVTI_z","error":null}
        ]}));
    }

    #[tokio::test]
    async fn bulk_field_split_item_keeps_first_error_across_requests() {
        use crate::github::project_item_edits::run_bulk_documents_with;
        use crate::github::runner::GhOutput;

        let ids: Vec<_> = (0..14).map(|n| format!("PVTI_{n}")).collect();
        for transport_failure in [false, true] {
            let docs = build_bulk_field_documents("PVT_p", &ids, &field_updates()[..2], &[]).unwrap();
            let mut calls = 0;
            let outcomes = run_bulk_documents_with(bulk_outcomes(&ids).unwrap(), docs, map_field_write_error, |args, input| {
                assert_eq!(args, GRAPHQL_INPUT_ARGS);
                assert!(input.is_some());
                let call = calls;
                calls += 1;
                std::future::ready(if transport_failure && call == 0 {
                    Err(AppError::Gh("gh: connection reset".into()))
                } else {
                    let mut data = json!({});
                    for n in 0..if call == 0 { 25 } else { 3 } {
                        data[format!("a{n}")] = json!({"projectV2Item":{"id":"PVTI_ok"}});
                    }
                    let mut value = json!({"data":data});
                    if !transport_failure {
                        let alias = if call == 0 { "a24" } else { "a0" };
                        value["errors"] = json!([{"path":[alias],"message":if call == 0 { "first" } else { "second" }}]);
                        value["data"][alias] = Value::Null;
                    }
                    Ok(GhOutput { stdout: serde_json::to_vec(&value).unwrap(), stderr: String::new(), code: 0 })
                })
            }).await;
            assert_eq!(calls, 2);
            for (n, outcome) in outcomes.outcomes.iter().enumerate() {
                let expected = if transport_failure && n <= 12 { Some("connection reset") }
                    else if !transport_failure && n == 12 { Some("first") } else { None };
                assert_eq!(outcome.item_id, ids[n]);
                assert_eq!(outcome.error.as_deref(), expected);
            }
        }
    }

    #[test]
    fn bulk_field_values_share_literal_builder_and_id_validation() {
        let id = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.=+/";
        let docs = build_bulk_field_documents(id, &[id.into()], &field_updates(), &[id.into()]).unwrap();
        assert_eq!(docs[0].item_indices.len(), 7);
        let input: Value = serde_json::from_str(docs[0].input.as_deref().unwrap()).unwrap();
        assert!(!input["query"].as_str().unwrap().contains(id));
        let single = build_set_item_field_values_args(id, id, &field_updates(), &[id.into()]).unwrap();
        let single: Value = serde_json::from_str(&field_write_input(&single)).unwrap();
        for (key, value) in single["variables"].as_object().unwrap() {
            if key != "i" && key != "g0" {
                assert_eq!(input["variables"][key], *value, "{key}");
            }
        }
        assert_eq!(input["variables"]["g6"], id);
        assert!(input["query"].as_str().unwrap().contains("value:{number:0.0001}"));
        for invalid in ["", "bad\"id", "bad\\id", "bad\nid"] {
            assert!(build_bulk_field_documents(invalid, &[id.into()], &[], &["notes".into()]).is_err());
            assert!(build_bulk_field_documents(id, &[invalid.into()], &[], &["notes".into()]).is_err());
            assert!(build_bulk_field_documents(id, &[id.into()], &[], &[invalid.into()]).is_err());
        }
        for number in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(build_bulk_field_documents(id, &[id.into()], &[
                FieldValueUpdate::Number { field_id: "points".into(), number },
            ], &[]).is_err());
        }
    }

    #[tokio::test]
    async fn bulk_field_empty_items_reject_and_empty_ops_skip_network() {
        assert!(gh_set_items_field_values("missing".into(), "PVT_p".into(), vec![], vec![], vec![]).await.is_err());
        let outcomes = gh_set_items_field_values("missing".into(), "PVT_p".into(), vec!["PVTI_z".into()], vec![], vec![]).await.unwrap();
        assert_eq!(serde_json::to_value(outcomes).unwrap(), json!({"outcomes":[{"itemId":"PVTI_z","error":null}]}));
        assert!(build_bulk_field_documents("PVT_p", &["PVTI_z".into()], &[], &[]).unwrap().is_empty());
    }

    #[tokio::test]
    async fn long_bulk_field_text_stays_on_stdin_and_preserves_partial_outcomes() {
        use crate::github::project_item_edits::run_bulk_documents_with;
        use crate::github::runner::GhOutput;

        let text = "@file\n\"quoted\" \\path=value ".repeat(70);
        let ids: Vec<_> = (0..25).map(|n| format!("PVTI_{n}")).collect();
        let docs = build_bulk_field_documents(
            "PVT_p",
            &ids,
            &[FieldValueUpdate::Text { field_id: "notes".into(), text: text.clone() }],
            &[],
        ).unwrap();
        assert_eq!(docs.len(), 1);
        assert!(docs[0].input.as_ref().unwrap().encode_utf16().count() > 32_767);
        let mut calls = 0;
        let outcomes = run_bulk_documents_with(
            bulk_outcomes(&ids).unwrap(), docs, map_field_write_error,
            |args, input| {
                calls += 1;
                assert_eq!(args, ["api", "graphql", "--method", "POST", "--input", "-"]);
                let input: Value = serde_json::from_str(input.as_deref().unwrap()).unwrap();
                assert!(!input["query"].as_str().unwrap().contains(&text));
                let mut data = json!({});
                for (n, id) in ids.iter().enumerate() {
                    assert_eq!(input["variables"][format!("v{n}")], text);
                    assert_eq!(input["variables"][format!("i{n}")], *id);
                    data[format!("a{n}")] = json!({"projectV2Item":{"id":id}});
                }
                data["a1"] = Value::Null;
                std::future::ready(Ok(GhOutput {
                    stdout: serde_json::to_vec(&json!({"data":data,"errors":[
                        {"path":["a1"],"message":"denied"}
                    ]})).unwrap(),
                    stderr: "gh: denied".into(),
                    code: 1,
                }))
            },
        ).await;
        assert_eq!(calls, 1);
        for (n, outcome) in outcomes.outcomes.iter().enumerate() {
            assert_eq!(outcome.item_id, ids[n]);
            assert_eq!(outcome.error.as_deref(), (n == 1).then_some("denied"));
        }
    }

    #[test]
    fn field_stdin_preserves_all_variable_types_and_empty_values() {
        for text in ["", "true", "123", "@file\n\"quoted\"=\\path"] {
            for options in [vec![], vec!["web".into(), "api".into()]] {
                let mut updates = field_updates();
                updates[0] = FieldValueUpdate::Text { field_id: "notes".into(), text: text.into() };
                updates[4] = FieldValueUpdate::MultiSelect { field_id: "teams".into(), option_ids: options.clone() };
                let args = build_set_item_field_values_args("PVT_p", "PVTI_z", &updates, &["clear".into()]).unwrap();
                let input: Value = serde_json::from_str(&field_write_input(&args)).unwrap();
                assert_eq!(input["query"], args.last().unwrap().strip_prefix("query=").unwrap());
                assert_eq!(input["variables"], json!({
                    "p":"PVT_p", "i":"PVTI_z", "f0":"notes", "v0":text,
                    "f1":"points", "f2":"due", "v2":"2027-01-01",
                    "f3":"status", "v3":"done", "f4":"teams", "v4":options,
                    "f5":"sprint", "v5":"past", "g0":"clear",
                }));
                let docs = build_bulk_field_documents("PVT_p", &["PVTI_z".into()], &updates, &[]).unwrap();
                let bulk: Value = serde_json::from_str(docs[0].input.as_deref().unwrap()).unwrap();
                assert_eq!(docs[0].args, GRAPHQL_INPUT_ARGS);
                for n in 0..updates.len() {
                    assert_eq!(bulk["variables"][format!("f{n}")], input["variables"][format!("f{n}")]);
                    assert_eq!(bulk["variables"][format!("v{n}")], input["variables"][format!("v{n}")]);
                }
            }
        }
    }

    #[test]
    fn long_single_item_field_text_round_trips_through_stdin() {
        let text = "@file\n\"quoted\" \\path=value ".repeat(2000);
        assert!(text.encode_utf16().count() > 32_767);
        let args = build_set_item_field_values_args(
            "PVT_p", "PVTI_z",
            &[FieldValueUpdate::Text { field_id: "notes".into(), text: text.clone() }],
            &[],
        ).unwrap();
        let input: Value = serde_json::from_str(&field_write_input(&args)).unwrap();
        assert_eq!(input["variables"]["v0"], text);
        assert_eq!(input["query"], args.last().unwrap().strip_prefix("query=").unwrap());
        assert_eq!(GRAPHQL_INPUT_ARGS, ["api", "graphql", "--method", "POST", "--input", "-"]);
    }

}
