//! Forge / CI READ tools (always available; no opt-in flag).
//!
//! The 10 read-only tools that hit the repository's forge — PRs, issues, and CI runs
//! /logs — routed through the forge abstraction (`crate::forge::forge_*`), which
//! dispatches by the repo's git host, so one tool set serves GitHub, GitLab, and
//! Bitbucket. Each requires the matching authenticated CLI/credential (GitHub `gh`,
//! GitLab `glab`, Bitbucket a stored API token) and hits the network. GitHub behavior
//! and serialized JSON are unchanged from the prior `gh_*`-only surface. Bitbucket's
//! native issue tracker is deprecated, so the issue tools return an actionable error
//! there (GitHub and GitLab only).

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{
    app_err, cap_head, cap_hunk_lines, cap_tail, json_result, json_result_untrusted, GitDesktopMcp,
    JobIdArg, NumberArg, RunIdArg, GH_TEXT_MAX_BYTES, HUNK_MAX_LINES,
};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RunListArgs {
    /// Max runs to return (default 20).
    #[serde(default)]
    limit: Option<u32>,
    /// Limit to a branch name.
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PrListArgs {
    /// "open" (default) or "closed".
    #[serde(default)]
    state: Option<String>,
    /// Max pull requests to return. Omit for the provider default (GitHub ~30; GitLab
    /// and Bitbucket a full page).
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct IssueListArgs {
    /// "open" (default) or "closed".
    #[serde(default)]
    state: Option<String>,
    /// Max issues to return. Omit for the provider default (GitHub ~30; GitLab a full page).
    #[serde(default)]
    limit: Option<u32>,
}

/// Default for `PrCommentsArgs::include_diff_hunk`: include the (capped) hunk.
fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PrCommentsArgs {
    /// The pull request number.
    number: u64,
    /// Include each review thread's `diffHunk` code-context excerpt, capped to the
    /// last few lines (default true). Set false to drop hunks entirely — useful when
    /// you only need the threads' structure (path, line, resolution, replies).
    #[serde(default = "default_true")]
    include_diff_hunk: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TagArg {
    /// The release's git tag (e.g. "v1.2.0"), as returned by list_releases.
    tag: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DiscussionListArgs {
    /// Optional category node id (from list_discussion_categories) to filter by;
    /// omit for all categories.
    #[serde(default)]
    category: Option<String>,
}

/// Classify a git host into the neutral provider tag, GitHub-or-not being all that
/// the discussion gate cares about. Pure so it's unit-testable without a repo —
/// mirrors the classification `generate::provider_tag` runs (host →
/// `provider_tag_for_host`), returning whether the host is GitHub.
///
/// `None` from `provider_tag_for_host` means an unrecognized host, which the app
/// treats as GitHub throughout — so it's GitHub here too (the `gh` discussion calls
/// surface their own actionable error if that guess is wrong).
fn host_is_github(host: &str, glab_hosts: &[String]) -> bool {
    matches!(
        crate::forge::provider_tag_for_host(host, glab_hosts),
        Some("github") | None
    )
}

/// Guard for the GitHub-only discussion tools: resolve the bound repo's provider the
/// same network-light way `generate::provider_tag` does (origin remote URL → host →
/// tag) and error honestly on a non-GitHub remote. Every discussion tool calls this
/// first (write tools AFTER their `--allow-remote-write` gate). Shared by both the
/// read (`read_forge`) and write (`write_forge`) discussion tools.
pub(super) async fn ensure_github(repo: &str) -> Result<(), McpError> {
    // No remote / unparseable URL / unrecognized host → treated as GitHub (the app's
    // resilient default), so the tool proceeds and the `gh` layer surfaces any real
    // mismatch. Only a POSITIVELY-identified GitLab/Bitbucket host is refused here.
    let url = crate::git::remote::git_remote_url(repo.to_string(), "origin".to_string())
        .await
        .ok();
    let host = url.as_deref().and_then(crate::forge::remote_host);
    if let Some(host) = host {
        let glab_hosts = crate::forge::glab::known_hosts().await;
        if !host_is_github(&host, &glab_hosts) {
            let provider = match crate::forge::provider_tag_for_host(&host, &glab_hosts) {
                Some("gitlab") => "GitLab",
                Some("bitbucket") => "Bitbucket",
                _ => "another provider",
            };
            return Err(McpError::invalid_request(
                format!(
                    "Discussions are a GitHub feature — this repository's remote is {provider}."
                ),
                None,
            ));
        }
    }
    Ok(())
}

#[tool_router(router = read_forge_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "List pull requests from the repository's forge (GitHub, GitLab, or \
                       Bitbucket, per its remote). `state` is \"open\" (default) or \"closed\". \
                       Without `limit`, returns the provider default (GitHub ~30; GitLab and \
                       Bitbucket a full page); pass `limit` to raise or lower that cap. Per-call \
                       ceiling: GitHub 1000, GitLab 100, Bitbucket 50 — a larger `limit` returns \
                       the ceiling (no pagination). Requires the forge's authenticated \
                       CLI/credential. Returns JSON."
    )]
    async fn list_pull_requests(
        &self,
        Parameters(args): Parameters<PrListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let prs = crate::forge::forge_pr_list(
            self.repo.clone(),
            args.state.unwrap_or_else(|| "open".to_string()),
            args.limit,
        )
        .await
        .map_err(app_err)?;
        json_result_untrusted(&prs)
    }

    #[tool(
        description = "Get a pull request's full details (title, body, state, reviews, comments, \
                       files) by number from the repository's forge (GitHub, GitLab, or Bitbucket, \
                       per its remote). For just the conversation — including file:line review \
                       threads — see list_pull_request_comments. Returns JSON."
    )]
    async fn get_pull_request(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        let pr = crate::forge::forge_pr_view(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        json_result_untrusted(&pr)
    }

    #[tool(
        description = "Get the unified diff of a pull request by number from the repository's forge \
                       (GitHub, GitLab, or Bitbucket, per its remote). Large diffs are truncated."
    )]
    async fn pull_request_diff(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        let diff = crate::forge::forge_pr_diff(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        Ok(CallToolResult::success(vec![Content::text(cap_head(
            diff,
            GH_TEXT_MAX_BYTES,
        ))]))
    }

    #[tool(
        description = "List a pull request's comments (by number) from the repository's forge \
                       (GitHub, GitLab, or Bitbucket, per its remote): `comments` (the top-level \
                       conversation), `reviews` (review summaries), and `review_threads` (file:line \
                       -anchored threads, each with its full reply chain) — every entry carries the \
                       author, date, and the original markdown body. Each thread's `diffHunk` \
                       code-context excerpt (GitHub only) is capped to its last few lines; set \
                       `include_diff_hunk` false to drop hunks entirely (default true). Read-only; \
                       returns JSON. (For the PR's metadata + changed files use get_pull_request; \
                       for its diff, pull_request_diff.)"
    )]
    async fn list_pull_request_comments(
        &self,
        Parameters(args): Parameters<PrCommentsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let pr = crate::forge::forge_pr_view(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        let mut review_threads =
            crate::forge::forge_pr_review_threads(self.repo.clone(), args.number)
                .await
                .map_err(app_err)?;
        // Bound each thread's diffHunk so a comment on a new file can't drag the
        // whole file into the payload (GitHub-only; GitLab/Bitbucket set it ""),
        // or drop it entirely when the caller opts out. Mutating this OWNED Vec
        // never touches the shared IPC struct's serialized shape.
        for t in &mut review_threads {
            t.diff_hunk = if args.include_diff_hunk {
                cap_hunk_lines(std::mem::take(&mut t.diff_hunk), HUNK_MAX_LINES)
            } else {
                String::new()
            };
        }
        // KEEP IN SYNC: src/lib/ai/review-tools.ts (`list_pull_request_comments`)
        // mirrors this composed shape (and the diffHunk cap) for the HTTP review
        // tool loop.
        json_result_untrusted(&serde_json::json!({
            "number": args.number,
            "comments": pr.comments,
            "reviews": pr.reviews,
            "review_threads": review_threads,
        }))
    }

    #[tool(
        description = "List issues from the repository's forge (GitHub or GitLab, per its remote; \
                       Bitbucket issues aren't supported — its native tracker is deprecated; for a \
                       repo with a linked Jira project, use list_jira_issues instead). \
                       `state` is \"open\" (default) or \"closed\". Without `limit`, returns the \
                       provider default (GitHub ~30; GitLab a full page); pass `limit` to raise or \
                       lower that cap. Per-call ceiling: GitHub 1000, GitLab 100 — a larger \
                       `limit` returns the ceiling (no pagination). Requires the forge's \
                       authenticated CLI/credential. Returns JSON."
    )]
    async fn list_issues(
        &self,
        Parameters(args): Parameters<IssueListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let issues = crate::forge::forge_issue_list(
            self.repo.clone(),
            args.state.unwrap_or_else(|| "open".to_string()),
            args.limit,
        )
        .await
        .map_err(app_err)?;
        json_result_untrusted(&issues)
    }

    #[tool(
        description = "Get an issue's full details (title, body, comments, labels, assignees) by \
                       number from the repository's forge (GitHub or GitLab, per its remote; \
                       Bitbucket issues aren't supported — its native tracker is deprecated; for a \
                       repo with a linked Jira project, use get_jira_issue instead). \
                       Returns JSON."
    )]
    async fn get_issue(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        let issue = crate::forge::forge_issue_view(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        json_result_untrusted(&issue)
    }

    #[tool(
        description = "List recent CI runs from the repository's forge (GitHub Actions, GitLab CI, \
                       or Bitbucket Pipelines, per its remote), optionally filtered to a branch. \
                       Returns JSON."
    )]
    async fn list_workflow_runs(
        &self,
        Parameters(args): Parameters<RunListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let runs = crate::forge::forge_ci_run_list(
            self.repo.clone(),
            args.limit.unwrap_or(20),
            args.branch,
        )
        .await
        .map_err(app_err)?;
        json_result(&runs)
    }

    #[tool(
        description = "Get a CI run's details (status, conclusion, jobs) by run id from the \
                       repository's forge (GitHub Actions, GitLab CI, or Bitbucket Pipelines, per \
                       its remote). Returns JSON."
    )]
    async fn get_workflow_run(
        &self,
        Parameters(args): Parameters<RunIdArg>,
    ) -> Result<CallToolResult, McpError> {
        let run = crate::forge::forge_ci_run_view(self.repo.clone(), args.run_id)
            .await
            .map_err(app_err)?;
        json_result(&run)
    }

    #[tool(
        description = "Get the logs of the FAILED steps of a CI run by run id from the repository's \
                       forge (GitHub Actions, GitLab CI, or Bitbucket Pipelines, per its remote) — \
                       the most useful view for diagnosing a CI failure. Large logs are truncated \
                       to the tail."
    )]
    async fn workflow_failed_logs(
        &self,
        Parameters(args): Parameters<RunIdArg>,
    ) -> Result<CallToolResult, McpError> {
        let logs = crate::forge::forge_ci_run_failed_logs(self.repo.clone(), args.run_id)
            .await
            .map_err(app_err)?;
        Ok(CallToolResult::success(vec![Content::text(cap_tail(
            logs,
            GH_TEXT_MAX_BYTES,
        ))]))
    }

    #[tool(
        description = "Get the FULL log of a single CI job by job id (from a run's `jobs[].id`, as \
                       returned by get_workflow_run) — the whole job's output, not just its failed \
                       steps. Works for GitHub Actions and GitLab CI; Bitbucket step logs aren't \
                       addressable by numeric id (use the run's web URL instead). Large logs are \
                       truncated to the tail."
    )]
    async fn workflow_job_logs(
        &self,
        Parameters(args): Parameters<JobIdArg>,
    ) -> Result<CallToolResult, McpError> {
        let logs = crate::forge::forge_ci_job_logs(self.repo.clone(), args.job_id)
            .await
            .map_err(app_err)?;
        Ok(CallToolResult::success(vec![Content::text(cap_tail(
            logs,
            GH_TEXT_MAX_BYTES,
        ))]))
    }

    #[tool(
        description = "List the repository's labels (name, color, description) from its forge \
                       (GitHub or GitLab, per its remote; Bitbucket labels aren't supported). Use \
                       these names when applying labels via edit_labels. Returns JSON."
    )]
    async fn list_labels(&self) -> Result<CallToolResult, McpError> {
        let labels = crate::forge::forge_repo_labels(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result(&labels)
    }

    #[tool(
        description = "List the repository's milestones from its forge (GitHub or GitLab, per its \
                       remote; Bitbucket milestones aren't supported). Returns JSON."
    )]
    async fn list_milestones(&self) -> Result<CallToolResult, McpError> {
        let milestones = crate::forge::forge_milestones(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result_untrusted(&milestones)
    }

    #[tool(
        description = "List the repository's releases from its forge (GitHub or GitLab, per its \
                       remote; Bitbucket releases aren't supported). Returns JSON. For one \
                       release's full notes, use get_release."
    )]
    async fn list_releases(&self) -> Result<CallToolResult, McpError> {
        let releases = crate::forge::forge_release_list(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result_untrusted(&releases)
    }

    #[tool(
        description = "Get one release's full details (title, notes, assets) by its git tag from \
                       the repository's forge (GitHub or GitLab, per its remote; Bitbucket releases \
                       aren't supported). Returns JSON."
    )]
    async fn get_release(
        &self,
        Parameters(args): Parameters<TagArg>,
    ) -> Result<CallToolResult, McpError> {
        let release = crate::forge::forge_release_view(self.repo.clone(), args.tag)
            .await
            .map_err(app_err)?;
        json_result_untrusted(&release)
    }

    #[tool(
        description = "List users assignable to issues/pull requests in the repository, from its \
                       forge (GitHub or GitLab, per its remote; Bitbucket assignees aren't \
                       supported). Use these logins with set_issue_assignees / \
                       set_pull_request_assignees. Returns JSON."
    )]
    async fn list_assignable_users(&self) -> Result<CallToolResult, McpError> {
        let users = crate::forge::forge_assignable_users(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result(&users)
    }

    #[tool(
        description = "Get a pull request's activity timeline (by number) from the repository's \
                       forge (GitHub, GitLab, or Bitbucket, per its remote) — state changes, label \
                       edits, approvals, and review events, oldest first. Returns JSON."
    )]
    async fn get_pull_request_timeline(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        let timeline = crate::forge::forge_pr_timeline(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        json_result_untrusted(&timeline)
    }

    #[tool(
        description = "List the repository's discussion categories (GitHub only — GitLab/Bitbucket \
                       have no discussions; the tool errors on those remotes). Returns each \
                       category's node id, name, emoji, and whether it accepts answers, plus the \
                       repo's node id — the category id is required to create_discussion. Returns \
                       JSON."
    )]
    async fn list_discussion_categories(&self) -> Result<CallToolResult, McpError> {
        ensure_github(&self.repo).await?;
        let meta = crate::github::discussion::gh_discussion_categories(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result(&meta)
    }

    #[tool(
        description = "List the repository's discussions, newest-updated first (GitHub only — \
                       GitLab/Bitbucket have no discussions; the tool errors on those remotes). \
                       Optionally filter by a category node id (see list_discussion_categories). \
                       Returns JSON."
    )]
    async fn list_discussions(
        &self,
        Parameters(args): Parameters<DiscussionListArgs>,
    ) -> Result<CallToolResult, McpError> {
        ensure_github(&self.repo).await?;
        let discussions =
            crate::github::discussion::gh_discussion_list(self.repo.clone(), args.category)
                .await
                .map_err(app_err)?;
        json_result_untrusted(&discussions)
    }

    #[tool(
        description = "Get a discussion's full thread by number (GitHub only — GitLab/Bitbucket \
                       have no discussions; the tool errors on those remotes): body, category, \
                       answer/lock/close state, and every comment with its nested replies (each \
                       carrying its node id, author, and body). Use a comment's id with \
                       mark_discussion_answer. Returns JSON."
    )]
    async fn get_discussion(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        ensure_github(&self.repo).await?;
        let discussion =
            crate::github::discussion::gh_discussion_view(self.repo.clone(), args.number)
                .await
                .map_err(app_err)?;
        json_result_untrusted(&discussion)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The discussion gate's host classification: github.com passes; a known GitLab
    /// or Bitbucket host is refused; an unrecognized host defaults to GitHub (the
    /// app's resilient default). Mirrors how `generate::provider_tag` classifies a
    /// host, minus the live remote read.
    #[test]
    fn host_is_github_classifies_by_host() {
        // No self-managed GitLab hosts configured for this classification.
        let no_glab_hosts: Vec<String> = Vec::new();
        assert!(host_is_github("github.com", &no_glab_hosts));
        // Canonical non-GitHub hosts are refused.
        assert!(!host_is_github("gitlab.com", &no_glab_hosts));
        assert!(!host_is_github("bitbucket.org", &no_glab_hosts));
        // An unrecognized host → treated as GitHub (matches the app-wide default).
        assert!(host_is_github("git.example.com", &no_glab_hosts));
        // A host present in glab's known-hosts is a self-managed GitLab → refused.
        let glab_hosts = vec!["gitlab.acme.com".to_string()];
        assert!(!host_is_github("gitlab.acme.com", &glab_hosts));
    }
}
