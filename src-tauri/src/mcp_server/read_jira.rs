//! Jira issue READ tools (always available; no opt-in flag).
//!
//! The read half of the Jira `jira_*` tool surface — list and get issues for the
//! repository's LINKED Jira project. Unlike the `forge_*` issue tools (which dispatch by
//! the repo's git host), Jira is a per-repo LINKED provider: the linked project
//! (`{siteHost, projectKey}`) is read server-side from `jira-links.json` via
//! [`GitDesktopMcp::jira_link`] and is the single source of truth — these tools take NO
//! `site`/`projectKey` param, so an agent can't point them at an arbitrary Jira site. A
//! repo with no link returns an actionable "link one in GitDesktop" error. Results wrap
//! in [`json_result_untrusted`] because Jira summaries, descriptions, and comments are
//! third-party prose. Credentials are read headlessly from the OS keyring by the shared
//! [`crate::forge::jira`] cores (never the `#[tauri::command]` wrappers).

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_key_in_project, json_result_untrusted, GitDesktopMcp};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct JiraIssueListArgs {
    /// Which issues to list: "open" (default), "closed", or "all". Mapped through Jira's
    /// `statusCategory` (open = not Done; closed = Done).
    #[serde(default)]
    state: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct JiraIssueKeyArg {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
}

#[tool_router(router = read_jira_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "List issues from the repository's LINKED Jira project. Jira is a per-repo \
                       linked issue provider (configured in GitDesktop — repo menu → Link Jira \
                       project), independent of the repo's git host — so this works on ANY repo \
                       with a Jira link (GitHub, GitLab, or Bitbucket), and errors with a link \
                       hint when the repo has none. It never takes a site or project — the stored \
                       link is the single source of truth. `state` is \"open\" (default), \
                       \"closed\", or \"all\". Each issue also carries agile fields when the \
                       project uses them: story points, active sprint (name + state), parent \
                       (epic), components, and fix versions. Returns one page (up to 50, \
                       newest-updated first) as JSON."
    )]
    async fn list_jira_issues(
        &self,
        Parameters(args): Parameters<JiraIssueListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let link = self.jira_link().await?;
        let issues = crate::forge::jira::issue_list(
            &link.site_host,
            &link.project_key,
            &args.state.unwrap_or_else(|| "open".to_string()),
        )
        .await
        .map_err(app_err)?;
        json_result_untrusted(&issues)
    }

    #[tool(
        description = "Get a Jira issue's full details (summary, status, type, priority, assignee, \
                       reporter, labels, description, and comments — bodies converted to markdown) \
                       by key, e.g. \"PROJ-123\", from the repository's LINKED Jira project \
                       (configured in GitDesktop; errors with a link hint when the repo has none). \
                       When the project uses them, agile fields are included too: story points, \
                       active sprint (name + state), parent (epic), components, and fix versions. \
                       Never takes a site or project — the stored link is the single source of \
                       truth (the key must belong to the linked project). Returns JSON."
    )]
    async fn get_jira_issue(
        &self,
        Parameters(args): Parameters<JiraIssueKeyArg>,
    ) -> Result<CallToolResult, McpError> {
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;
        let issue = crate::forge::jira::issue_view(&link.site_host, &args.key)
            .await
            .map_err(app_err)?;
        json_result_untrusted(&issue)
    }
}
