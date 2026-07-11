//! Jira issue remote-WRITE tools (opt-in via `--allow-remote-write`).
//!
//! The write half of the Jira `jira_*` tool surface — comment, transition (close/reopen),
//! create, and assign — against the repository's LINKED Jira project. REAL writes to
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

use super::{app_err, json_result, GitDesktopMcp, GD_COMMENT_FOOTER};

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

#[tool_router(router = write_jira_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Post a comment to an issue (by key, e.g. \"PROJ-123\") in the repository's \
                       LINKED Jira project, under the stored Atlassian identity. The body is \
                       markdown (converted to Jira's ADF); a \"Posted by GitDesktop\" attribution \
                       footer is appended automatically. Jira is a per-repo linked provider \
                       (configured in GitDesktop; errors with a link hint when the repo has none) \
                       and takes no site/project param. Requires --allow-remote-write. Returns the \
                       created comment as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_jira_issue(
        &self,
        Parameters(args): Parameters<CommentJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
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
                       link hint when the repo has none) and takes no site/project param. Requires \
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
                       hint when the repo has none) and takes no site/project param. Requires \
                       --allow-remote-write. Returns a confirmation as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn assign_jira_issue(
        &self,
        Parameters(args): Parameters<AssignJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
        let account_id = args.account_id.filter(|s| !s.trim().is_empty());
        crate::forge::jira::issue_assign(&link.site_host, &args.key, account_id.as_deref())
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({
            "key": args.key,
            "assigned": account_id.is_some(),
        }))
    }
}
