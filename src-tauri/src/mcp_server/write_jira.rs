//! Jira issue remote-WRITE tools (opt-in via `--allow-remote-write`).
//!
//! The write half of the Jira `jira_*` tool surface — comment, transition (close/reopen),
//! create, assign, and update (due date / priority / labels) — against the repository's
//! LINKED Jira project. REAL writes to
//! Jira Cloud under the stored Atlassian credential, so every tool is gated on
//! `allow_remote_write` (via [`GitDesktopMcp::ensure_remote_write`]) FIRST, then resolves
//! the linked project server-side (via [`GitDesktopMcp::jira_link`] — the single source
//! of truth; no `site`/`projectKey` param) and calls the shared [`crate::forge::jira`]
//! cores (never the `#[tauri::command]` wrappers). All are annotated non-read-only and
//! non-destructive (mirroring the forge issue-write tools — a Jira write is a mutation,
//! but none is a trivially-irreversible destructive op). `comment_jira_issue` appends the
//! shared `GD_COMMENT_FOOTER` attribution.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_key_in_project, json_result, GitDesktopMcp, GD_COMMENT_FOOTER};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentJiraIssueArgs {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
    /// The comment body (markdown; converted to Jira's ADF).
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TransitionJiraIssueArgs {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
    /// "close" moves the issue to a Done-category status; "reopen" moves it back to a
    /// To-Do (or In-Progress) status. The concrete transition is chosen from the
    /// project's workflow — ids are never hardcoded.
    direction: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateJiraIssueArgs {
    /// The issue summary (title).
    summary: String,
    /// Optional issue description (markdown; converted to Jira's ADF). Omit for none.
    #[serde(default)]
    description_md: Option<String>,
    /// Optional issue-type id (from the project's create metadata). Omit to use the
    /// project's first non-subtask issue type.
    #[serde(default)]
    issue_type_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct AssignJiraIssueArgs {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
    /// The Atlassian accountId to assign. Omit (or null) to UNASSIGN the issue.
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateJiraIssueArgs {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
    /// Optional due date as "YYYY-MM-DD" to set it, or the empty string "" to CLEAR it.
    /// Omit to leave the due date unchanged.
    #[serde(default)]
    due_date: Option<String>,
    /// Optional priority NAME (e.g. "High"), resolved case-insensitively to its id. An
    /// unknown name returns an error listing the valid names. Omit to leave the priority
    /// unchanged.
    #[serde(default)]
    priority: Option<String>,
    /// Optional full REPLACEMENT set of labels (labels can't contain spaces; an empty
    /// array clears all labels). Omit to leave labels unchanged.
    #[serde(default)]
    labels: Option<Vec<String>>,
}

/// Reject an `update_jira_issue` call that changes nothing — at least one of `due_date`,
/// `priority`, or `labels` must be present. Pure (unit-tested): the local guard that runs
/// after the remote-write gate and before any network call.
fn ensure_update_has_a_field(args: &UpdateJiraIssueArgs) -> Result<(), McpError> {
    if args.due_date.is_none() && args.priority.is_none() && args.labels.is_none() {
        return Err(McpError::invalid_params(
            "Provide at least one of due_date, priority, or labels to update.",
            None,
        ));
    }
    Ok(())
}

#[tool_router(router = write_jira_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Post a comment to an issue (by key, e.g. \"PROJ-123\") in the repository's \
                       LINKED Jira project, under the stored Atlassian identity. The body is \
                       markdown (converted to Jira's ADF); a \"Posted by GitDesktop\" attribution \
                       footer is appended automatically. Jira is a per-repo linked provider \
                       (configured in GitDesktop; errors with a link hint when the repo has none) \
                       and takes no site/project param (the key must belong to the linked \
                       project). Requires --allow-remote-write. Returns the created comment as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_jira_issue(
        &self,
        Parameters(args): Parameters<CommentJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        let comment = crate::forge::jira::issue_comment(&link.site_host, &args.key, &body)
            .await
            .map_err(app_err)?;
        json_result(&comment)
    }

    #[tool(
        description = "Close or reopen an issue (by key, e.g. \"PROJ-123\") in the repository's \
                       LINKED Jira project via its workflow, under the stored Atlassian identity. \
                       `direction` is \"close\" or \"reopen\"; the concrete workflow transition is \
                       chosen from the project (ids are never hardcoded), and an actionable error \
                       is returned when the workflow/permissions offer no suitable transition. \
                       Jira is a per-repo linked provider (configured in GitDesktop; errors with a \
                       link hint when the repo has none) and takes no site/project param (the key \
                       must belong to the linked project). Requires \
                       --allow-remote-write. Returns the issue's resulting status \
                       (name + category) as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn transition_jira_issue(
        &self,
        Parameters(args): Parameters<TransitionJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;
        let result =
            crate::forge::jira::issue_transition(&link.site_host, &args.key, &args.direction)
                .await
                .map_err(app_err)?;
        json_result(&result)
    }

    #[tool(
        description = "Create an issue in the repository's LINKED Jira project, under the stored \
                       Atlassian identity. Needs a `summary`; `description_md` is optional markdown \
                       (converted to Jira's ADF). `issue_type_id` is optional — omit it to use the \
                       project's first non-subtask issue type. Jira is a per-repo linked provider \
                       (configured in GitDesktop; errors with a link hint when the repo has none) \
                       and takes no site/project param. NOT reversible without deleting the issue. \
                       Requires --allow-remote-write. Returns the created issue's key + URL as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_jira_issue(
        &self,
        Parameters(args): Parameters<CreateJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;

        // Resolve the issue type: an explicit id when given, else the project's first
        // non-subtask type from its create metadata (the CreateJiraIssueDialog default).
        let issue_type_id = match args.issue_type_id.filter(|s| !s.trim().is_empty()) {
            Some(id) => id,
            None => {
                let types = crate::forge::jira::issue_types(&link.site_host, &link.project_key)
                    .await
                    .map_err(app_err)?;
                types
                    .into_iter()
                    .find(|t| !t.subtask)
                    .map(|t| t.id)
                    .ok_or_else(|| {
                        McpError::invalid_request(
                            "This Jira project has no creatable (non-subtask) issue type — pass \
                             an issue_type_id explicitly.",
                            None,
                        )
                    })?
            }
        };

        let created = crate::forge::jira::issue_create(
            &link.site_host,
            &link.project_key,
            &issue_type_id,
            &args.summary,
            args.description_md.as_deref(),
        )
        .await
        .map_err(app_err)?;
        json_result(&created)
    }

    #[tool(
        description = "Assign (or unassign) an issue (by key, e.g. \"PROJ-123\") in the \
                       repository's LINKED Jira project, under the stored Atlassian identity. Pass \
                       `account_id` (an Atlassian accountId) to assign; omit it to UNASSIGN. Jira \
                       is a per-repo linked provider (configured in GitDesktop; errors with a link \
                       hint when the repo has none) and takes no site/project param (the key must \
                       belong to the linked project). Requires \
                       --allow-remote-write. Returns a confirmation as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn assign_jira_issue(
        &self,
        Parameters(args): Parameters<AssignJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;
        let account_id = args.account_id.filter(|s| !s.trim().is_empty());
        crate::forge::jira::issue_assign(&link.site_host, &args.key, account_id.as_deref())
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({
            "key": args.key,
            "assigned": account_id.is_some(),
        }))
    }

    #[tool(
        description = "Update fields of an issue (by key, e.g. \"PROJ-123\") in the repository's \
                       LINKED Jira project, under the stored Atlassian identity. Provide at least \
                       one of: `due_date` (\"YYYY-MM-DD\" to set, or \"\" to clear); `priority` (a \
                       priority NAME like \"High\", resolved case-insensitively — an unknown name \
                       errors with the valid names); `labels` (the full REPLACEMENT set — labels \
                       can't contain spaces, and an empty array clears all labels). Editing or \
                       deleting comments is deliberately NOT offered here (use View in Jira). Jira \
                       is a per-repo linked provider (configured in GitDesktop; errors with a link \
                       hint when the repo has none) and takes no site/project param (the key must \
                       belong to the linked project). Requires --allow-remote-write. Returns the \
                       applied changes as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn update_jira_issue(
        &self,
        Parameters(args): Parameters<UpdateJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        ensure_update_has_a_field(&args)?;
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;

        // Due date: an empty string clears; a non-empty string sets (grammar-checked in the
        // core). Serde `Option` distinguishes "omitted" (None → don't touch) from present.
        if let Some(raw) = args.due_date.as_deref() {
            let due = if raw.trim().is_empty() {
                None
            } else {
                Some(raw)
            };
            crate::forge::jira::issue_set_due_date(&link.site_host, &args.key, due)
                .await
                .map_err(app_err)?;
        }

        // Priority: resolve the NAME to its id case-insensitively via GET /priority; an
        // unknown name is an actionable error listing the valid names.
        let mut applied_priority: Option<String> = None;
        if let Some(name) = args.priority.as_deref() {
            let priorities = crate::forge::jira::priorities(&link.site_host)
                .await
                .map_err(app_err)?;
            let matched = priorities
                .iter()
                .find(|p| p.name.eq_ignore_ascii_case(name.trim()))
                .ok_or_else(|| {
                    let valid = priorities
                        .iter()
                        .map(|p| p.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    McpError::invalid_params(
                        format!("Unknown priority {name:?}. Valid priorities: {valid}."),
                        None,
                    )
                })?;
            crate::forge::jira::issue_set_priority(&link.site_host, &args.key, &matched.id)
                .await
                .map_err(app_err)?;
            applied_priority = Some(matched.name.clone());
        }

        // Labels: full replacement (the core rejects whitespace/empty labels).
        if let Some(labels) = args.labels.as_deref() {
            crate::forge::jira::issue_set_labels(&link.site_host, &args.key, labels)
                .await
                .map_err(app_err)?;
        }

        json_result(&serde_json::json!({
            "key": args.key,
            "dueDate": args.due_date,
            "priority": applied_priority,
            "labels": args.labels,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::wrapper::Parameters;

    /// With ALL flags false, `update_jira_issue` must return the `--allow-remote-write`
    /// gate error before touching the link or the network (the gate fires first).
    #[tokio::test]
    async fn update_jira_issue_gated_on_allow_remote_write() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);
        let err = h
            .update_jira_issue(Parameters(UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: Some("2026-07-11".into()),
                priority: None,
                labels: None,
            }))
            .await
            .expect_err("expected the remote-write gate to fire");
        assert!(
            err.to_string().contains("--allow-remote-write"),
            "gate error should name --allow-remote-write, got: {err}"
        );
    }

    /// With the gate OPEN, an `update_jira_issue` that changes nothing (all optional args
    /// omitted) is rejected by the argument guard before any link/network call.
    #[tokio::test]
    async fn update_jira_issue_rejects_no_op_args() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, true, false, false);
        let err = h
            .update_jira_issue(Parameters(UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: None,
                labels: None,
            }))
            .await
            .expect_err("expected a no-op-args rejection");
        let msg = err.to_string();
        assert!(
            msg.contains("at least one of due_date, priority, or labels"),
            "got: {msg}"
        );
    }

    /// The pure no-op guard: at least one field present passes; all absent fails.
    #[test]
    fn ensure_update_has_a_field_requires_one() {
        let none = UpdateJiraIssueArgs {
            key: "MYT-1".into(),
            due_date: None,
            priority: None,
            labels: None,
        };
        assert!(ensure_update_has_a_field(&none).is_err());

        // Any single field present is enough — including a due_date of "" (clear) and an
        // empty labels vec (clear all).
        for args in [
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: Some(String::new()),
                priority: None,
                labels: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: Some("High".into()),
                labels: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: None,
                labels: Some(Vec::new()),
            },
        ] {
            assert!(ensure_update_has_a_field(&args).is_ok());
        }
    }
}
