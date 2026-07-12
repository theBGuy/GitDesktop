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

use crate::error::AppError;

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
struct LogWorkJiraIssueArgs {
    /// The Jira issue key, e.g. "PROJ-123".
    key: String,
    /// The time spent as a Jira duration ("Nw Nd Nh Nm", e.g. "2d 4h 30m"; units are
    /// weeks/days/hours/minutes). Validated before any network call.
    time_spent: String,
    /// Optional worklog note (markdown; converted to Jira's ADF). Omit for none. The server
    /// times the entry at "now" (no start time is sent).
    #[serde(default)]
    comment: Option<String>,
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
    /// Optional ORIGINAL time estimate as a Jira duration ("Nw Nd Nh Nm", e.g. "2d 4h") to
    /// set it, or the empty string "" to CLEAR it. Omit to leave the original estimate
    /// unchanged.
    #[serde(default)]
    original_estimate: Option<String>,
    /// Optional REMAINING time estimate as a Jira duration ("Nw Nd Nh Nm", e.g. "1d 5h") to
    /// set it, or the empty string "" to CLEAR it. Omit to leave the remaining estimate
    /// unchanged.
    #[serde(default)]
    remaining_estimate: Option<String>,
}

/// Reject an `update_jira_issue` call that changes nothing — at least one of `due_date`,
/// `priority`, or `labels` must be present. Pure (unit-tested): the local guard that runs
/// after the remote-write gate and before any network call.
fn ensure_update_has_a_field(args: &UpdateJiraIssueArgs) -> Result<(), McpError> {
    if args.due_date.is_none()
        && args.priority.is_none()
        && args.labels.is_none()
        && args.original_estimate.is_none()
        && args.remaining_estimate.is_none()
    {
        return Err(McpError::invalid_params(
            "Provide at least one of due_date, priority, labels, original_estimate, or \
             remaining_estimate to update.",
            None,
        ));
    }
    Ok(())
}

/// Resolve a requested priority NAME to the matching priority in `available`,
/// case-insensitively (trimming the request). An unknown name yields the actionable
/// `invalid_params` error listing the valid names. Pure (unit-tested) so the
/// no-writes-before-error contract is provable at the resolution layer without a network
/// call — the caller runs this BEFORE any write, so an unknown name performs zero writes.
fn resolve_priority<'a>(
    available: &'a [crate::forge::jira::JiraPriority],
    name: &str,
) -> Result<&'a crate::forge::jira::JiraPriority, McpError> {
    available
        .iter()
        .find(|p| p.name.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| {
            let valid = available
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            McpError::invalid_params(
                format!("Unknown priority {name:?}. Valid priorities: {valid}."),
                None,
            )
        })
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
                       can't contain spaces, and an empty array clears all labels); \
                       `original_estimate` / `remaining_estimate` (a Jira duration like \"2d 4h\" \
                       — units w/d/h/m — to set, or \"\" to clear). Editing or \
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

        // Resolve the priority NAME → id FIRST, before ANY write. `GET /priority` is an
        // idempotent read, and resolution can fail on an unknown name — doing it up front
        // (a pre-mutation guard) means a bad priority name performs ZERO writes rather than
        // leaving a half-applied due date behind. The canonical name is kept for the result.
        let resolved_priority: Option<(String, String)> = match args.priority.as_deref() {
            Some(name) => {
                let priorities = crate::forge::jira::priorities(&link.site_host)
                    .await
                    .map_err(app_err)?;
                let matched = resolve_priority(&priorities, name)?;
                Some((matched.id.clone(), matched.name.clone()))
            }
            None => None,
        };

        // Later writes can still fail AFTER an earlier one succeeded (the writes hit
        // distinct field PUTs — e.g. a screen-scheme 400 on labels after the due date was
        // already set). The app's write model is non-transactional single-field PUTs, so we
        // don't roll back; instead we DISCLOSE what was already applied when a later step
        // fails. `applied` accumulates human phrases in write order for that prefix.
        let mut applied: Vec<&str> = Vec::new();

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
                .map_err(|e| partial_write_err(&applied, e))?;
            applied.push("due date was already updated");
        }

        // Priority: apply the pre-resolved id (resolution already happened above).
        let applied_priority = match &resolved_priority {
            Some((id, canonical_name)) => {
                crate::forge::jira::issue_set_priority(&link.site_host, &args.key, id)
                    .await
                    .map_err(|e| partial_write_err(&applied, e))?;
                applied.push("priority was already updated");
                Some(canonical_name.clone())
            }
            None => None,
        };

        // Labels: full replacement (the core rejects whitespace/empty labels).
        if let Some(labels) = args.labels.as_deref() {
            crate::forge::jira::issue_set_labels(&link.site_host, &args.key, labels)
                .await
                .map_err(|e| partial_write_err(&applied, e))?;
            applied.push("labels were already updated");
        }

        // Original estimate: an empty string clears (→ None → send ""); a non-empty string
        // sets (grammar-checked in the core). Serde `Option` distinguishes omitted from
        // present.
        if let Some(raw) = args.original_estimate.as_deref() {
            let estimate = if raw.trim().is_empty() {
                None
            } else {
                Some(raw)
            };
            crate::forge::jira::issue_set_original_estimate(&link.site_host, &args.key, estimate)
                .await
                .map_err(|e| partial_write_err(&applied, e))?;
            applied.push("original estimate was already updated");
        }

        // Remaining estimate: same empty-clears / non-empty-sets convention.
        if let Some(raw) = args.remaining_estimate.as_deref() {
            let estimate = if raw.trim().is_empty() {
                None
            } else {
                Some(raw)
            };
            crate::forge::jira::issue_set_remaining_estimate(&link.site_host, &args.key, estimate)
                .await
                .map_err(|e| partial_write_err(&applied, e))?;
            applied.push("remaining estimate was already updated");
        }

        json_result(&serde_json::json!({
            "key": args.key,
            "dueDate": args.due_date,
            "priority": applied_priority,
            "labels": args.labels,
            "originalEstimate": args.original_estimate,
            "remainingEstimate": args.remaining_estimate,
        }))
    }

    #[tool(
        description = "Log work on an issue (by key, e.g. \"PROJ-123\") in the repository's LINKED \
                       Jira project, under the stored Atlassian identity. `time_spent` is a Jira \
                       duration (\"Nw Nd Nh Nm\", e.g. \"2d 4h 30m\"; units w/d/h/m) — validated \
                       before any network call. `comment` is optional markdown (converted to \
                       Jira's ADF). The entry is timed at \"now\" (no start time is sent); the \
                       server decrements the remaining estimate automatically. Editing or deleting \
                       worklogs is deliberately NOT offered here (use View in Jira). Jira is a \
                       per-repo linked provider (configured in GitDesktop; errors with a link hint \
                       when the repo has none) and takes no site/project param (the key must belong \
                       to the linked project). Requires --allow-remote-write. Returns the created \
                       worklog as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn jira_log_work(
        &self,
        Parameters(args): Parameters<LogWorkJiraIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let link = self.jira_link().await?;
        ensure_key_in_project(&args.key, &link)?;
        let worklog = crate::forge::jira::worklog_add(
            &link.site_host,
            &args.key,
            &args.time_spent,
            args.comment.as_deref(),
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "key": args.key,
            "worklog": worklog,
            "message": format!(
                "Logged {} on {} (started {}).",
                worklog.time_spent, args.key, worklog.started
            ),
        }))
    }
}

/// Map an [`AppError`] from a `update_jira_issue` field write into an [`McpError`],
/// PREFIXING it with what earlier writes in the same call already applied (so the agent
/// learns the issue is in a partial state, since the app doesn't roll back). With nothing
/// applied yet, it's the plain [`app_err`] mapping. Pure over `applied` (unit-tested).
fn partial_write_err(applied: &[&str], e: AppError) -> McpError {
    let base = app_err(e);
    if applied.is_empty() {
        return base;
    }
    // e.g. "due date and priority were already updated before this failure — <error>".
    let joined = join_applied(applied);
    McpError::internal_error(
        format!("{joined} before this failure — {}", base.message),
        None,
    )
}

/// Join the applied-write phrases for the partial-state prefix: "A", "A and B", or
/// "A, B, and C". Each phrase already ends in "was/were already updated"; we normalize to a
/// single "were already updated" tail so the sentence reads naturally regardless of count.
/// Pure (unit-tested).
fn join_applied(applied: &[&str]) -> String {
    // Strip the shared "… already updated" tail to recover the subject phrases, then
    // rebuild one clause. The phrases are the fixed strings pushed in the handler, so this
    // stays a small, closed vocabulary.
    let subjects: Vec<&str> = applied
        .iter()
        .map(|p| {
            p.trim_end_matches(" was already updated")
                .trim_end_matches(" were already updated")
        })
        .collect();
    let list = match subjects.as_slice() {
        [] => String::new(),
        [a] => (*a).to_string(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    };
    format!("{list} {} already updated", verb_for(subjects.len()))
}

/// "was" for a single applied write, "were" for several — subject/verb agreement in the
/// partial-state prefix. Pure.
fn verb_for(count: usize) -> &'static str {
    if count == 1 {
        "was"
    } else {
        "were"
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
                original_estimate: None,
                remaining_estimate: None,
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
                original_estimate: None,
                remaining_estimate: None,
            }))
            .await
            .expect_err("expected a no-op-args rejection");
        let msg = err.to_string();
        assert!(
            msg.contains("at least one of due_date, priority, labels, original_estimate, or"),
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
            original_estimate: None,
            remaining_estimate: None,
        };
        assert!(ensure_update_has_a_field(&none).is_err());

        // Any single field present is enough — including a due_date of "" (clear), an empty
        // labels vec (clear all), and an estimate of "" (clear).
        for args in [
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: Some(String::new()),
                priority: None,
                labels: None,
                original_estimate: None,
                remaining_estimate: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: Some("High".into()),
                labels: None,
                original_estimate: None,
                remaining_estimate: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: None,
                labels: Some(Vec::new()),
                original_estimate: None,
                remaining_estimate: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: None,
                labels: None,
                original_estimate: Some("2d 4h".into()),
                remaining_estimate: None,
            },
            UpdateJiraIssueArgs {
                key: "MYT-1".into(),
                due_date: None,
                priority: None,
                labels: None,
                original_estimate: None,
                remaining_estimate: Some(String::new()),
            },
        ] {
            assert!(ensure_update_has_a_field(&args).is_ok());
        }
    }

    fn priorities() -> Vec<crate::forge::jira::JiraPriority> {
        vec![
            crate::forge::jira::JiraPriority {
                id: "1".into(),
                name: "Highest".into(),
                icon_url: String::new(),
            },
            crate::forge::jira::JiraPriority {
                id: "3".into(),
                name: "Medium".into(),
                icon_url: String::new(),
            },
        ]
    }

    /// The pure priority resolver: a known name (case-insensitively, trimmed) resolves to
    /// its id + canonical name; an unknown name returns the actionable error listing the
    /// valid names. Because resolution is pure and the handler runs it BEFORE any write, an
    /// unknown name performs ZERO writes.
    #[test]
    fn resolve_priority_matches_or_lists_valid_names() {
        let list = priorities();
        // Case-insensitive, whitespace-tolerant match → canonical id + name.
        let m =
            resolve_priority(&list, "  medium ").unwrap_or_else(|_| panic!("should match Medium"));
        assert_eq!(m.id, "3");
        assert_eq!(m.name, "Medium");

        // Unknown name → invalid_params listing every valid name; no id is produced, so the
        // caller performs no priority write (and, being first, no writes at all).
        let err = match resolve_priority(&list, "NotReal") {
            Ok(_) => panic!("unknown name must error"),
            Err(e) => e,
        };
        let msg = err.to_string();
        assert!(msg.contains("Unknown priority"), "got: {msg}");
        assert!(
            msg.contains("Highest"),
            "should list valid names, got: {msg}"
        );
        assert!(
            msg.contains("Medium"),
            "should list valid names, got: {msg}"
        );
    }

    /// `partial_write_err` maps a field-write failure into an MCP error, prefixing it with
    /// what earlier writes in the same call already applied — the disclosure the
    /// non-transactional write model requires. With nothing applied, it's the plain mapping.
    #[test]
    fn partial_write_err_discloses_applied_writes() {
        let boom = || AppError::Jira("Field 'labels' cannot be set (screen scheme).".into());

        // Nothing applied yet → no partial-state prefix, just the mapped error.
        let plain = partial_write_err(&[], boom()).to_string();
        assert!(plain.contains("screen scheme"), "got: {plain}");
        assert!(
            !plain.contains("already updated"),
            "no prefix when nothing applied: {plain}"
        );

        // One earlier write applied → singular "was already updated" prefix.
        let one = partial_write_err(&["due date was already updated"], boom()).to_string();
        assert!(
            one.contains("due date was already updated before this failure —"),
            "got: {one}"
        );
        assert!(
            one.contains("screen scheme"),
            "keeps the original error: {one}"
        );

        // Two earlier writes → plural "were", joined with "and".
        let two = partial_write_err(
            &[
                "due date was already updated",
                "priority was already updated",
            ],
            boom(),
        )
        .to_string();
        assert!(
            two.contains("due date and priority were already updated before this failure —"),
            "got: {two}"
        );
    }

    /// `join_applied` reads naturally for one / two / three applied writes (subject/verb
    /// agreement and the Oxford-comma list).
    #[test]
    fn join_applied_reads_naturally() {
        assert_eq!(
            join_applied(&["due date was already updated"]),
            "due date was already updated"
        );
        assert_eq!(
            join_applied(&[
                "due date was already updated",
                "priority was already updated"
            ]),
            "due date and priority were already updated"
        );
        assert_eq!(
            join_applied(&[
                "a was already updated",
                "b was already updated",
                "c was already updated"
            ]),
            "a, b, and c were already updated"
        );
        // A plural phrase ("labels were …") must strip like the singular ones — the
        // labels + estimate combination garbled before the dual-form strip.
        assert_eq!(
            join_applied(&[
                "labels were already updated",
                "original estimate was already updated"
            ]),
            "labels and original estimate were already updated"
        );
    }
}
