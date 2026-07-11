//! Local-PR and local-issue tools (writes opt-in via `--allow-write`; reads ungated).
//!
//! Local PRs and local issues are GitDesktop's own app-data records — its review
//! artifacts (mirrored from the GUI's `local-prs.json`) and its own non-forge issue
//! tracker (`local-issues.json`). They are NOT GitHub/GitLab PRs or issues, and no git
//! or remote write ever happens here.
//!
//! - **Writes** (create/amend those records) are gated on `allow_write` (via
//!   [`GitDesktopMcp::ensure_write`]) and annotated non-read-only, non-destructive.
//! - **Reads** (list/get) are UNGATED, like every other read tool — this is the user's
//!   own local app-data, not the forge.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_not_flag, json_result, GitDesktopMcp};
use crate::git::runner::{run_git_raw, DEFAULT_TIMEOUT};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateLocalPrArgs {
    /// Title of the local PR.
    title: String,
    /// Optional description/body (markdown). Defaults to empty.
    #[serde(default)]
    body: Option<String>,
    /// Base branch (the branch changes would merge INTO). Must exist in the repo.
    base: String,
    /// Head branch (the branch with the changes). Must exist in the repo.
    head: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentLocalPrArgs {
    /// The local PR's id.
    id: String,
    /// The comment body (markdown).
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetLocalPrStatusArgs {
    /// The local PR's id.
    id: String,
    /// New status: "open" or "closed". "merged" is rejected — merging happens in
    /// GitDesktop (it's a git operation this server never performs).
    status: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ApproveLocalPrArgs {
    /// The local PR's id.
    id: String,
    /// Whether the local PR is approved.
    approved: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateLocalIssueArgs {
    /// Title of the local issue.
    title: String,
    /// Optional description/body (markdown). Defaults to empty.
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentLocalIssueArgs {
    /// The local issue's id.
    id: String,
    /// The comment body (markdown).
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetLocalIssueStatusArgs {
    /// The local issue's id.
    id: String,
    /// New status: "open" or "closed". Any other value is rejected with an error listing
    /// the valid ones. (Closing stamps a `closedAt`; reopening clears it.)
    status: String,
}

/// An optional local-record status filter (the read tools accept it to narrow results).
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct LocalStatusFilterArgs {
    /// Optional status to filter by (e.g. "open" or "closed"). Omit to return all.
    #[serde(default)]
    status: Option<String>,
}

/// A single-id lookup arg for the local get-tools.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct LocalIdArg {
    /// The local record's id.
    id: String,
}

#[tool_router(router = write_local_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Create a local PR — GitDesktop's own app-data review artifact for the bound \
                       repository (NOT a GitHub/remote PR; nothing is pushed). Verifies both `base` \
                       and `head` exist as branches first. Returns the created record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_local_pr(
        &self,
        Parameters(args): Parameters<CreateLocalPrArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        // Pre-mutation guards FIRST: both refs must resolve as branches, else error
        // naming the missing one — before any app-data write.
        verify_branch(&self.repo, &args.base).await?;
        verify_branch(&self.repo, &args.head).await?;
        let repo = self.local_pr_key().await?;
        let record = crate::local_prs::create(
            &repo,
            &args.title,
            args.body.as_deref().unwrap_or(""),
            &args.base,
            &args.head,
        )
        .map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "Add a comment to a local PR (by id) in the bound repository. Returns the \
                       updated record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_local_pr(
        &self,
        Parameters(args): Parameters<CommentLocalPrArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_pr_key().await?;
        let record = crate::local_prs::add_comment(&repo, &args.id, &args.body).map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "Set a local PR's status to \"open\" or \"closed\" (by id). \"merged\" is \
                       rejected — merging a local PR happens in GitDesktop (a git operation this \
                       server never performs). Returns the updated record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn set_local_pr_status(
        &self,
        Parameters(args): Parameters<SetLocalPrStatusArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_pr_key().await?;
        let record =
            crate::local_prs::set_status(&repo, &args.id, &args.status).map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "Set a local PR's approved flag (by id) in the bound repository. Returns the \
                       updated record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn approve_local_pr(
        &self,
        Parameters(args): Parameters<ApproveLocalPrArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_pr_key().await?;
        let record =
            crate::local_prs::set_approved(&repo, &args.id, args.approved).map_err(app_err)?;
        json_result(&record)
    }

    // ---- Local ISSUES: GitDesktop's own app-data issue tracker -------------

    #[tool(
        description = "Create a local ISSUE — a record in GitDesktop's own app-data issue tracker \
                       for the bound repository (NOT a GitHub/GitLab issue; nothing is posted to any \
                       forge). Returns the created record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_local_issue(
        &self,
        Parameters(args): Parameters<CreateLocalIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_issue_key().await?;
        let record =
            crate::local_issues::create(&repo, &args.title, args.body.as_deref().unwrap_or(""))
                .map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "Add a comment to a local ISSUE (by id) in the bound repository — GitDesktop's \
                       own app-data issue tracker, not a forge issue. Returns the updated record as \
                       JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_local_issue(
        &self,
        Parameters(args): Parameters<CommentLocalIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_issue_key().await?;
        let record =
            crate::local_issues::add_comment(&repo, &args.id, &args.body).map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "Set a local ISSUE's status to \"open\" or \"closed\" (by id) in the bound \
                       repository — GitDesktop's own app-data issue tracker, not a forge issue. Any \
                       other status value is rejected with an error listing the valid ones. Returns \
                       the updated record as JSON.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn set_local_issue_status(
        &self,
        Parameters(args): Parameters<SetLocalIssueStatusArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_write()?;
        let repo = self.local_issue_key().await?;
        let record =
            crate::local_issues::set_status(&repo, &args.id, &args.status).map_err(app_err)?;
        json_result(&record)
    }

    // ---- Local READ tools (ungated — the user's own app-data) --------------

    #[tool(
        description = "List local ISSUES — records in GitDesktop's own app-data issue tracker for \
                       the bound repository (NOT GitHub/GitLab issues). Optionally filter by status \
                       (\"open\"/\"closed\"). Returns the matching records as a JSON array.",
        annotations(read_only_hint = true)
    )]
    async fn list_local_issues(
        &self,
        Parameters(args): Parameters<LocalStatusFilterArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = self.local_issue_key().await?;
        let records = crate::local_issues::list(&repo).map_err(app_err)?;
        json_result(&filter_by_status(records, args.status.as_deref()))
    }

    #[tool(
        description = "Get a single local ISSUE (by id) from GitDesktop's own app-data issue tracker \
                       for the bound repository (NOT a GitHub/GitLab issue). Returns the record as \
                       JSON.",
        annotations(read_only_hint = true)
    )]
    async fn get_local_issue(
        &self,
        Parameters(args): Parameters<LocalIdArg>,
    ) -> Result<CallToolResult, McpError> {
        let repo = self.local_issue_key().await?;
        let record = crate::local_issues::get(&repo, &args.id).map_err(app_err)?;
        json_result(&record)
    }

    #[tool(
        description = "List local PRs — GitDesktop's own app-data review artifacts for the bound \
                       repository (NOT GitHub/remote PRs). Optionally filter by status \
                       (\"open\"/\"closed\"/\"merged\"). Returns the matching records as a JSON array.",
        annotations(read_only_hint = true)
    )]
    async fn list_local_prs(
        &self,
        Parameters(args): Parameters<LocalStatusFilterArgs>,
    ) -> Result<CallToolResult, McpError> {
        let repo = self.local_pr_key().await?;
        let records = crate::local_prs::list(&repo).map_err(app_err)?;
        json_result(&filter_by_status(records, args.status.as_deref()))
    }

    #[tool(
        description = "Get a single local PR (by id) — one of GitDesktop's own app-data review \
                       artifacts for the bound repository (NOT a GitHub/remote PR). Returns the \
                       record as JSON.",
        annotations(read_only_hint = true)
    )]
    async fn get_local_pr(
        &self,
        Parameters(args): Parameters<LocalIdArg>,
    ) -> Result<CallToolResult, McpError> {
        let repo = self.local_pr_key().await?;
        let record = crate::local_prs::get(&repo, &args.id).map_err(app_err)?;
        json_result(&record)
    }
}

/// Filter a list of local records (as `Value`s) by their `status` field. `None` returns
/// everything; a `Some(s)` keeps only records whose `status` equals `s`. Records with no
/// `status` field are dropped by an active filter (they can't match a requested status).
fn filter_by_status(
    records: Vec<serde_json::Value>,
    status: Option<&str>,
) -> Vec<serde_json::Value> {
    match status {
        None => records,
        Some(want) => records
            .into_iter()
            .filter(|r| r.get("status").and_then(serde_json::Value::as_str) == Some(want))
            .collect(),
    }
}

/// Verifies that `branch` resolves to an existing LOCAL branch (`refs/heads/<branch>`)
/// in the repo, erroring clearly by name if not. Used as a pre-mutation guard for
/// `create_local_pr` so a typo'd base/head is rejected before any app-data write.
///
/// Local branches ONLY — a remote-tracking ref (`origin/main`) is deliberately
/// rejected: the GUI's local-PR paths assume local branches (the create dialog only
/// offers local names, and `git_merge_local_pr` does `git switch <base>` + cherry-pick,
/// which errors or DWIM-creates a branch for a remote-tracking ref), so a record with
/// a remote-tracking ref would be a latent trap at merge time.
async fn verify_branch(repo: &str, branch: &str) -> Result<(), McpError> {
    ensure_not_flag(branch, "branch")?;
    let out = run_git_raw(
        Some(repo),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_err(app_err)?;
    if !out.stdout_lossy().trim().is_empty() {
        return Ok(());
    }
    Err(McpError::invalid_params(
        format!("branch not found in this repository: {branch}"),
        None,
    ))
}

impl GitDesktopMcp {
    /// The worktree-stable store key for this server's local ISSUES, after folding any
    /// records still stored under the raw `--repo` checkout path onto it — the direct
    /// parallel of `local_pr_key` (in `mod.rs`) for the separate `local-issues.json`
    /// store. Every local-issue read/write tool routes through this so the MCP and the
    /// GUI agree on the key no matter which checkout (main or a worktree) `--repo`
    /// points at. Uses the SAME shared resolver (`git::repo::repo_identity`) the GUI's
    /// `git_repo_identity` command uses.
    ///
    /// Unlike `local_pr_key`, this folds on EVERY call rather than once-per-session:
    /// the session's once-flag (`consolidated`) is owned by `mod.rs` and reserved for
    /// the local-PR store, and adding a second flag field would mean editing `mod.rs`
    /// (out of scope for this store). `local_issues::consolidate` is idempotent and a
    /// no-op read once folded, so the only cost is one extra small store read per
    /// call — acceptable given how infrequent local-issue mutations are.
    async fn local_issue_key(&self) -> Result<String, McpError> {
        let identity = crate::git::repo::repo_identity(&self.repo).await;
        crate::local_issues::consolidate(&identity, &self.repo).map_err(app_err)?;
        Ok(identity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::wrapper::Parameters;

    /// Table-driven gate check: with ALL flags false, EVERY local-PR write tool must
    /// return the `--allow-write` gate error before doing any work. Structured so a
    /// Wave-2 module can copy this shape: one async closure per tool, each invoked on a
    /// fully-locked handler, asserting the error names the module's flag.
    ///
    /// Params carry throwaway values — the gate fires first, so they are never read.
    #[tokio::test]
    async fn all_write_tools_gated_on_allow_write() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);

        macro_rules! assert_gated {
            ($call:expr) => {{
                let err = $call.await.expect_err("expected the write gate to fire");
                let msg = err.to_string();
                assert!(
                    msg.contains("--allow-write"),
                    "gate error should name --allow-write, got: {msg}"
                );
            }};
        }

        assert_gated!(h.create_local_pr(Parameters(CreateLocalPrArgs {
            title: "t".into(),
            body: None,
            base: "main".into(),
            head: "feat".into(),
        })));
        assert_gated!(h.comment_local_pr(Parameters(CommentLocalPrArgs {
            id: "1".into(),
            body: "b".into(),
        })));
        assert_gated!(h.set_local_pr_status(Parameters(SetLocalPrStatusArgs {
            id: "1".into(),
            status: "open".into(),
        })));
        assert_gated!(h.approve_local_pr(Parameters(ApproveLocalPrArgs {
            id: "1".into(),
            approved: true,
        })));
        assert_gated!(h.create_local_issue(Parameters(CreateLocalIssueArgs {
            title: "t".into(),
            body: None,
        })));
        assert_gated!(h.comment_local_issue(Parameters(CommentLocalIssueArgs {
            id: "1".into(),
            body: "b".into(),
        })));
        assert_gated!(
            h.set_local_issue_status(Parameters(SetLocalIssueStatusArgs {
                id: "1".into(),
                status: "open".into(),
            }))
        );
    }

    /// The local READ tools are UNGATED (the user's own app-data) — with all flags off
    /// they must NOT return the write-gate error. They resolve the repo identity and hit
    /// the store, so against a throwaway `/tmp/x` repo they simply return an empty/`Ok`
    /// or a "no local … with id" error — never the `--allow-write` gate message.
    #[tokio::test]
    async fn local_read_tools_are_ungated() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);

        macro_rules! assert_not_gated {
            ($call:expr) => {{
                if let Err(err) = $call.await {
                    assert!(
                        !err.to_string().contains("--allow-write"),
                        "read tool must not be write-gated, got: {}",
                        err
                    );
                }
            }};
        }

        assert_not_gated!(h.list_local_issues(Parameters(LocalStatusFilterArgs { status: None })));
        assert_not_gated!(h.get_local_issue(Parameters(LocalIdArg { id: "nope".into() })));
        assert_not_gated!(h.list_local_prs(Parameters(LocalStatusFilterArgs { status: None })));
        assert_not_gated!(h.get_local_pr(Parameters(LocalIdArg { id: "nope".into() })));
    }

    #[test]
    fn filter_by_status_keeps_only_matches() {
        use serde_json::json;
        let records = vec![
            json!({ "id": "a", "status": "open" }),
            json!({ "id": "b", "status": "closed" }),
            json!({ "id": "c" }), // no status field
        ];
        // No filter → everything.
        assert_eq!(filter_by_status(records.clone(), None).len(), 3);
        // "open" → only a.
        let open = filter_by_status(records.clone(), Some("open"));
        assert_eq!(open.len(), 1);
        assert_eq!(open[0]["id"], "a");
        // "closed" → only b.
        assert_eq!(filter_by_status(records.clone(), Some("closed")).len(), 1);
        // Unknown status → nothing (records with no status can't match).
        assert!(filter_by_status(records, Some("merged")).is_empty());
    }
}
