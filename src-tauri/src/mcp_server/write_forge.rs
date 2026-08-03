//! Forge remote-WRITE tools (opt-in via `--allow-remote-write`).
//!
//! REAL, publicly visible writes, routed through `crate::forge::forge_*`, which
//! dispatches by the repo's git host (GitHub `gh`, GitLab `glab`, Bitbucket a stored
//! token). Coverage varies by provider; the forge layer returns an actionable error
//! where a provider can't do the thing rather than failing silently.
//!
//! Gated on `allow_remote_write` ([`GitDesktopMcp::ensure_remote_write`]) — a SEPARATE
//! opt-in from `--allow-write`; enabling one never grants the other. A tool is annotated
//! destructive when it can drop state the caller never named, OR when its outcome isn't
//! trivially recoverable: the set-style tools whose payload REPLACES a whole collection
//! or clears a field by omission (`request_reviewers`, `set_issue_assignees`,
//! `set_pull_request_assignees`, `set_issue_milestone`) fall in the first class,
//! `merge_pull_request` and `update_release` in the second.

use std::collections::HashMap;

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, json_result, GitDesktopMcp, NumberArg, RunIdArg, GD_COMMENT_FOOTER};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateIssueArgs {
    /// The issue title.
    title: String,
    /// Optional issue body (markdown). Defaults to empty.
    #[serde(default)]
    body: String,
    /// Optional labels to apply by name (must already exist in the repo).
    #[serde(default)]
    labels: Vec<String>,
    /// Optional assignees to apply by login (must have repo access).
    #[serde(default)]
    assignees: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentIssueArgs {
    /// The issue number.
    number: u64,
    /// The comment body (markdown).
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CloseIssueArgs {
    /// The issue number.
    number: u64,
    /// Close reason: "completed" (default) or "not_planned". Empty defaults to "completed".
    #[serde(default)]
    reason: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReopenIssueArgs {
    /// The issue number.
    number: u64,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentPullRequestArgs {
    /// The pull request number.
    number: u64,
    /// The comment body (markdown).
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreatePullRequestArgs {
    /// The base branch the PR merges INTO (e.g. "main").
    base: String,
    /// The head branch the PR merges FROM. It is pushed to origin first.
    head: String,
    /// The PR title.
    title: String,
    /// Optional PR body (markdown). Defaults to empty.
    #[serde(default)]
    body: String,
    /// Open as a draft. Defaults to false.
    #[serde(default)]
    draft: bool,
    /// Optional labels by name (GitHub/GitLab only; Bitbucket PRs have none).
    #[serde(default)]
    labels: Option<Vec<String>>,
    /// Optional assignees by login (GitHub/GitLab only; Bitbucket PRs have none).
    #[serde(default)]
    assignees: Option<Vec<String>>,
    /// Optional reviewers by login (Bitbucket only at create time; GitHub/GitLab reject
    /// a non-empty list here — request them after creation via request_reviewers).
    #[serde(default)]
    reviewers: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct MergePullRequestArgs {
    /// The pull request number.
    number: u64,
    /// Merge strategy: "merge" (default), "squash", or "rebase" (rebase is GitHub-only;
    /// the GitLab arm rejects it).
    #[serde(default)]
    strategy: Option<String>,
    /// Delete the head branch after merging. Defaults to false.
    #[serde(default)]
    delete_branch: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdatePullRequestArgs {
    /// The pull request number.
    number: u64,
    /// New title. Omit to keep the current title.
    #[serde(default)]
    title: Option<String>,
    /// New body (markdown). Omit to keep the current body.
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetPullRequestDraftArgs {
    /// The pull request number.
    number: u64,
    /// True to mark it a draft, false to mark it ready. Works both ways on all three
    /// providers (Bitbucket PUT, GitLab `glab mr update`, GitHub `gh pr ready [--undo]`).
    draft: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RequestReviewersArgs {
    /// The pull request number.
    number: u64,
    /// The FULL desired reviewer set, by login. This replaces the current reviewers
    /// (an empty list clears them); it is not additive.
    reviewers: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct EditLabelsArgs {
    /// "pr" or "issue" — which kind of item `number` refers to.
    kind: String,
    /// The pull request or issue number.
    number: u64,
    /// Labels to add, by name (must already exist in the repo — see list_labels).
    #[serde(default)]
    add: Vec<String>,
    /// Labels to remove, by name.
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetAssigneesArgs {
    /// The issue or pull request number.
    number: u64,
    /// The FULL desired assignee set, by login. This replaces the current assignees
    /// (an empty list clears them); it is not additive.
    assignees: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReplyToReviewThreadArgs {
    /// The pull request number the thread belongs to.
    number: u64,
    /// The review thread id (as carried by list_pull_request_comments' review_threads).
    thread_id: String,
    /// The reply body (markdown). A "Posted by GitDesktop" attribution footer is
    /// appended automatically.
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ResolveReviewThreadArgs {
    /// The pull request number the thread belongs to.
    number: u64,
    /// The review thread id (as carried by list_pull_request_comments' review_threads).
    thread_id: String,
    /// True to resolve the thread, false to unresolve it.
    resolved: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DispatchWorkflowArgs {
    /// The workflow to dispatch (id or file name, e.g. "ci.yml"). GitLab ignores this
    /// (it runs a whole pipeline on the ref); on Bitbucket a non-empty value names a
    /// custom pipeline. Defaults to empty.
    #[serde(default)]
    workflow: String,
    /// The git ref (branch or tag) to run on. Defaults to empty (the provider's default,
    /// typically the default branch).
    #[serde(default, rename = "ref")]
    git_ref: String,
    /// Optional inputs — GitHub workflow_dispatch inputs; GitLab CI/CD variables;
    /// Bitbucket pipeline variables.
    #[serde(default)]
    inputs: HashMap<String, String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateReleaseArgs {
    /// The git tag for the release (e.g. "v1.2.0"). Created if it doesn't exist.
    tag: String,
    /// Optional release title. Defaults to empty (the provider derives one).
    #[serde(default)]
    title: String,
    /// Optional release notes (markdown). Defaults to empty.
    #[serde(default)]
    notes: String,
    /// Create as a draft (GitHub only; GitLab has no draft). Defaults to false.
    #[serde(default)]
    draft: bool,
    /// Mark as a prerelease (GitHub only). Defaults to false.
    #[serde(default)]
    prerelease: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateReleaseArgs {
    /// The git tag identifying the release to edit.
    tag: String,
    /// New title. Omit to keep the current title.
    #[serde(default)]
    title: Option<String>,
    /// New notes (markdown). Omit to keep the current notes.
    #[serde(default)]
    notes: Option<String>,
    /// New draft state (GitHub only). Omit to keep the current state.
    #[serde(default)]
    draft: Option<bool>,
    /// New prerelease state (GitHub only). Omit to keep the current state.
    #[serde(default)]
    prerelease: Option<bool>,
    /// Whether to also point the release's `latest.json` Tauri updater manifest at
    /// the new notes (GitHub only, and only when the release carries that asset).
    /// Defaults to true, and only applies when `notes` are given; set false to leave
    /// the manifest alone.
    #[serde(default)]
    sync_updater_notes: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateReviewThreadArgs {
    /// The pull request number.
    number: u64,
    /// The repo-relative file path the thread anchors to.
    path: String,
    /// The line number in the file the thread anchors to.
    line: u64,
    /// Which side of the diff: "new" (the added/right side, default) or "old" (the
    /// removed/left side). Empty defaults to "new".
    #[serde(default)]
    side: String,
    /// Optional start line for a multi-line comment range (honored on GitHub and
    /// GitLab; Bitbucket has no range API and anchors at `line`).
    #[serde(default)]
    start_line: Option<u64>,
    /// The comment body (markdown). A "Posted by GitDesktop" attribution footer is
    /// appended automatically.
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RequestChangesArgs {
    /// The pull request number.
    number: u64,
    /// The blocking review comment (markdown). Defaults to empty.
    #[serde(default)]
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct UpdateIssueArgs {
    /// The issue number.
    number: u64,
    /// New title. Omit to keep the current title.
    #[serde(default)]
    title: Option<String>,
    /// New body (markdown). Omit to keep the current body.
    #[serde(default)]
    body: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SetIssueMilestoneArgs {
    /// The issue number.
    number: u64,
    /// The milestone to set, as the `number` field of the chosen entry from
    /// list_milestones. Omit (or null) to CLEAR the issue's milestone.
    #[serde(default)]
    milestone: Option<u64>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReactionArgs {
    /// "issue" or "pr" — which kind of item `number` refers to.
    kind: String,
    /// The issue or pull request number.
    number: u64,
    /// The reaction to add/remove. One of: THUMBS_UP, THUMBS_DOWN, LAUGH, HOORAY,
    /// CONFUSED, HEART, ROCKET, EYES.
    content: String,
    /// Optional comment node id (from the item's comments) to react to a specific
    /// comment instead of the issue/PR body. Omit to react to the body.
    #[serde(default)]
    subject_id: String,
}

/// GitHub's ReactionContent vocabulary — the neutral set both forge arms accept (GitLab
/// maps each onto an award emoji). Validated here so an unknown value is rejected before
/// any network call. Mirrors `github::issue::validate_reaction_content` and gitlab's
/// `reaction_to_award`.
const VALID_REACTIONS: &[&str] = &[
    "THUMBS_UP",
    "THUMBS_DOWN",
    "LAUGH",
    "HOORAY",
    "CONFUSED",
    "HEART",
    "ROCKET",
    "EYES",
];

/// Validate a reaction against [`VALID_REACTIONS`], erroring with the full valid set.
fn validate_reaction(content: &str) -> Result<(), McpError> {
    if VALID_REACTIONS.contains(&content) {
        Ok(())
    } else {
        Err(McpError::invalid_params(
            format!(
                "unknown reaction: {content}. Valid reactions: {}",
                VALID_REACTIONS.join(", ")
            ),
            None,
        ))
    }
}

/// Map the tool's `kind` ("issue"/"pr") to the forge reaction target vocabulary
/// ("issue"/"mr"), erroring on anything else.
fn reaction_target(kind: &str) -> Result<&'static str, McpError> {
    match kind {
        "issue" => Ok("issue"),
        "pr" => Ok("mr"),
        other => Err(McpError::invalid_params(
            format!("kind must be \"issue\" or \"pr\", got: {other}"),
            None,
        )),
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateDiscussionArgs {
    /// The discussion title.
    title: String,
    /// Optional discussion body (markdown). Defaults to empty.
    #[serde(default)]
    body: String,
    /// The category to open the discussion in, by NAME (see list_discussion_categories).
    /// Required — a discussion must have a category.
    category: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommentDiscussionArgs {
    /// The discussion number.
    number: u64,
    /// The comment body (markdown). A "Posted by GitDesktop" attribution footer is
    /// appended automatically.
    body: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct MarkDiscussionAnswerArgs {
    /// The node id of the comment to mark/unmark as the answer (from get_discussion's
    /// `comments[].id`).
    comment_id: String,
    /// True to mark the comment as the answer, false to unmark it. Defaults to true.
    #[serde(default = "default_true")]
    answer: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CloseDiscussionArgs {
    /// The discussion number.
    number: u64,
    /// Close reason: "RESOLVED" (default), "OUTDATED", or "DUPLICATE". Empty defaults
    /// to "RESOLVED".
    #[serde(default)]
    reason: String,
}

/// Tauri's updater manifest, attached to a release as an asset of this exact name.
/// Mirrors `github::release`'s own constant (private to that module) and the
/// frontend's `UPDATER_MANIFEST_NAME`.
const UPDATER_MANIFEST: &str = "latest.json";

/// The notes an updater-manifest sync should carry, or `None` when it must not run.
/// Empty/whitespace notes leave the release body untouched (the edit trims and skips
/// `--notes`), so syncing them would blank a live manifest; `Some(false)` is the
/// caller's opt-out. The text is TRIMMED, matching what the edit wrote to the body.
fn updater_notes_to_sync(notes: Option<&str>, sync: Option<bool>) -> Option<String> {
    if sync == Some(false) {
        return None;
    }
    notes
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

/// Point a just-edited release's updater manifest at `notes`, mirroring the in-app
/// editor's gate: GitHub only, and only when the release ships a `latest.json` asset.
/// `None` = a gate skipped it, `Some(Err)` = a ready-to-report sentence for the caller
/// to disclose alongside the successful edit (each failure arm words its own, so
/// neither asserts a manifest exists when that is what went unverified). `current` is
/// the pre-edit release read when the tool already needed one — an edit can't change
/// the asset list.
async fn sync_release_updater_notes(
    repo: &str,
    tag: &str,
    notes: &str,
    current: Option<&crate::github::release::ReleaseDetails>,
) -> Option<Result<(), String>> {
    // `detect_non_github` returning None IS the GitHub arm (forge's resilient
    // default); GitLab/Bitbucket releases carry no Tauri updater manifest.
    if crate::forge::detect_non_github(repo).await.is_some() {
        return None;
    }
    let fetched;
    let release = match current {
        Some(r) => r,
        None => {
            match crate::forge::forge_release_view(repo.to_string(), tag.to_string()).await {
                Ok(r) => {
                    fetched = r;
                    &fetched
                }
                // Can't tell whether a manifest is attached — report rather than
                // let silence read as "this release has none".
                Err(e) => {
                    return Some(Err(format!(
                        "The release was updated, but whether it carries a \
                         {UPDATER_MANIFEST} updater manifest could not be checked: {e}"
                    )))
                }
            }
        }
    };
    if !release.assets.iter().any(|a| a.name == UPDATER_MANIFEST) {
        return None;
    }
    Some(
        crate::github::release::gh_release_sync_updater_notes(repo, tag, notes)
            .await
            .map_err(|e| {
                format!(
                    "The release was updated, but its {UPDATER_MANIFEST} updater manifest \
                     was not: {e}"
                )
            }),
    )
}

#[tool_router(router = write_forge_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Create a real issue in the bound repository's forge (GitHub or GitLab, per \
                       its remote; Bitbucket issues aren't supported — its native tracker is \
                       deprecated; for a repo with a linked Jira project, use create_jira_issue \
                       instead), under the authenticated forge user. NOT reversible without \
                       deleting it. Optional labels/assignees are applied by name/login (must \
                       already exist). Returns the created issue ref (number + URL) as JSON. \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_issue(
        &self,
        Parameters(args): Parameters<CreateIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let pr_ref = crate::forge::forge_issue_create(
            self.repo.clone(),
            args.title,
            args.body,
            args.labels,
            args.assignees,
            None,
            None,
            // Lens: MCP stays origin-pinned in v1 (documented gap). Same below.
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&pr_ref)
    }

    #[tool(
        description = "Post a comment to an issue (by number) in the bound repository's forge \
                       (GitHub or GitLab, per its remote; Bitbucket issues aren't supported — its \
                       native tracker is deprecated; for a repo with a linked Jira project, use \
                       comment_jira_issue instead), under the authenticated forge user. \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_issue(
        &self,
        Parameters(args): Parameters<CommentIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        crate::forge::forge_issue_comment(self.repo.clone(), args.number, body, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "issue": args.number, "action": "commented" }))
    }

    #[tool(
        description = "Close an issue (by number) in the bound repository's forge (GitHub or \
                       GitLab, per its remote; Bitbucket issues aren't supported — its native \
                       tracker is deprecated; for a repo with a linked Jira project, use \
                       transition_jira_issue instead). Reversible via reopen_issue. `reason` is \
                       \"completed\" (default) or \"not_planned\" (GitHub; GitLab has no close \
                       reason and ignores it). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn close_issue(
        &self,
        Parameters(args): Parameters<CloseIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // Empty resolves to "completed" in the GitHub core; mirror that in the confirmation.
        let resolved = if args.reason.is_empty() {
            "completed"
        } else {
            args.reason.as_str()
        };
        crate::forge::forge_issue_close(self.repo.clone(), args.number, args.reason.clone(), None)
            .await
            .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "issue": args.number, "status": "closed", "reason": resolved }),
        )
    }

    #[tool(
        description = "Reopen a closed issue (by number) in the bound repository's forge (GitHub or \
                       GitLab, per its remote; Bitbucket issues aren't supported — its native \
                       tracker is deprecated; for a repo with a linked Jira project, use \
                       transition_jira_issue instead). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn reopen_issue(
        &self,
        Parameters(args): Parameters<ReopenIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_issue_reopen(self.repo.clone(), args.number, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "issue": args.number, "status": "open" }))
    }

    #[tool(
        description = "Post a comment to a pull request (by number) in the bound repository's forge \
                       (GitHub, GitLab, or Bitbucket, per its remote), under the authenticated \
                       forge user — e.g. an agent posting its review. A short \"Posted by \
                       GitDesktop\" attribution footer is appended automatically. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_pull_request(
        &self,
        Parameters(args): Parameters<CommentPullRequestArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        crate::forge::forge_pr_comment(self.repo.clone(), args.number, body, None, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "action": "commented" }))
    }

    #[tool(
        description = "Open a pull request in the bound repository's forge (GitHub, GitLab, or \
                       Bitbucket, per its remote), under the authenticated forge user. Pushes \
                       `head` to origin first, then opens `head` → `base`. Labels/assignees are \
                       GitHub/GitLab-only; create-time reviewers are Bitbucket-only (elsewhere use \
                       request_reviewers after creation) — the forge layer rejects an unsupported \
                       combination. Returns the created PR ref (number + URL) as JSON. Requires \
                       BOTH --allow-remote-write AND --allow-git-write, because it pushes `head` to \
                       origin first.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_pull_request(
        &self,
        Parameters(args): Parameters<CreatePullRequestArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // The intrinsic `git push -u origin <head>` every provider arm runs is an
        // --allow-git-write-tier action, so require that tier too (a tier never
        // grants another).
        self.ensure_git_write()?;
        // Branch names reach a git/CLI argv position, but every provider arm already
        // rejects an empty or '-'-leading branch, so no extra guard is needed here.
        let pr_ref = crate::forge::forge_pr_create_core(
            &self.state,
            self.repo.clone(),
            args.base,
            args.head,
            args.title,
            args.body,
            args.draft,
            args.reviewers,
            args.labels,
            args.assignees,
            // Lens: MCP always creates on origin in v1 (no upstream-PR affordance yet).
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&pr_ref)
    }

    #[tool(
        description = "Merge a pull request (by number) in the bound repository's forge (GitHub, \
                       GitLab, or Bitbucket, per its remote), under the authenticated forge user. \
                       `strategy` is \"merge\" (default), \"squash\", or \"rebase\" (rebase is \
                       GitHub-only). A merge is NOT trivially reversible. Optionally deletes the \
                       head branch. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn merge_pull_request(
        &self,
        Parameters(args): Parameters<MergePullRequestArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let strategy = args.strategy.unwrap_or_else(|| "merge".to_string());
        let outcome = crate::forge::forge_pr_merge(
            self.repo.clone(),
            args.number,
            strategy.clone(),
            args.delete_branch,
            None,
            None,
        )
        .await
        .map_err(app_err)?;
        let mut result = serde_json::json!({
            "pull_request": args.number,
            "action": "merged",
            "strategy": strategy,
            "deleted_branch": args.delete_branch,
        });
        // The merge succeeded; a cleanup_warning means only the branch deletion failed —
        // surface it as a caveat, not a tool error (the merge isn't reversible from here).
        if let Some(warning) = outcome.cleanup_warning {
            result["cleanup_warning"] = serde_json::Value::String(warning);
        }
        json_result(&result)
    }

    #[tool(
        description = "Edit a pull request's title and/or body (by number) in the bound \
                       repository's forge (GitHub, GitLab, or Bitbucket, per its remote). Omitted \
                       fields keep their current value (the current PR is read first to preserve \
                       them). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn update_pull_request(
        &self,
        Parameters(args): Parameters<UpdatePullRequestArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // forge_pr_edit replaces BOTH title and body, so fetch the current PR to fill
        // whichever the caller omitted — otherwise an omitted field would be wiped.
        let (title, body) = if args.title.is_none() || args.body.is_none() {
            let pr = crate::forge::forge_pr_view(self.repo.clone(), args.number, None)
                .await
                .map_err(app_err)?;
            (args.title.unwrap_or(pr.title), args.body.unwrap_or(pr.body))
        } else {
            (args.title.unwrap(), args.body.unwrap())
        };
        crate::forge::forge_pr_edit(self.repo.clone(), args.number, title, body, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "action": "updated" }))
    }

    #[tool(
        description = "Set a pull request's draft state (by number) in the bound repository's forge \
                       (GitHub, GitLab, or Bitbucket, per its remote). Works on all three: Bitbucket \
                       toggles the `draft` field both ways; GitLab shells `glab mr update --ready|\
                       --draft`; GitHub shells `gh pr ready` (and `gh pr ready --undo` to convert an \
                       open PR back to a draft) under the authenticated CLI. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn set_pull_request_draft(
        &self,
        Parameters(args): Parameters<SetPullRequestDraftArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // The MCP tool has no fork-lens concept — pass `None` (GitHub arm only reads it).
        crate::forge::forge_pr_set_draft(self.repo.clone(), args.number, args.draft, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "draft": args.draft }))
    }

    #[tool(
        description = "Close a pull request (by number) in the bound repository's forge (GitHub, \
                       GitLab, or Bitbucket, per its remote) WITHOUT merging it. Reversible via \
                       reopen_pull_request (except a declined Bitbucket PR, which can't be \
                       reopened). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn close_pull_request(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_close(self.repo.clone(), args.number, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "status": "closed" }))
    }

    #[tool(
        description = "Reopen a closed (not merged) pull request (by number) in the bound \
                       repository's forge (GitHub or GitLab, per its remote). A declined Bitbucket \
                       PR can't be reopened (BCLOUD-4954) — the forge layer surfaces that. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn reopen_pull_request(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_reopen(self.repo.clone(), args.number, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "status": "open" }))
    }

    #[tool(
        description = "Set a pull request's reviewers (by number) in the bound repository's forge \
                       (GitHub, GitLab, or Bitbucket, per its remote). `reviewers` is the FULL \
                       desired set of logins — it REPLACES the current reviewers (an empty list \
                       clears them), it is not additive. See list_assignable_users for candidate \
                       logins. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn request_reviewers(
        &self,
        Parameters(args): Parameters<RequestReviewersArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_set_reviewers(
            self.repo.clone(),
            args.number,
            args.reviewers.clone(),
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "pull_request": args.number,
            "reviewers": args.reviewers,
        }))
    }

    #[tool(
        description = "Add and/or remove labels on a pull request or issue (by number) in the \
                       bound repository's forge (GitHub or GitLab, per its remote; Bitbucket labels \
                       aren't supported). `kind` is \"pr\" or \"issue\". Labels are given by name \
                       and must already exist (see list_labels) — an unknown name is an error on \
                       GitHub. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn edit_labels(
        &self,
        Parameters(args): Parameters<EditLabelsArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let target = match args.kind.as_str() {
            "pr" => "mr",
            "issue" => "issue",
            other => {
                return Err(McpError::invalid_params(
                    format!("kind must be \"pr\" or \"issue\", got: {other}"),
                    None,
                ));
            }
        };
        // The forge layer is a SHARED control keyed differently per provider: GitHub by
        // GraphQL node id (on the item's node id), GitLab by name. The agent supplies
        // only names, so resolve the item's node id + each name→id here; GitLab ignores
        // the id side and takes the names. (GitLab RepoLabels carry no id, so the id
        // maps come back empty there — harmless, since GitLab uses the name side.)
        let labelable_id = match target {
            "mr" => {
                crate::forge::forge_pr_view(self.repo.clone(), args.number, None)
                    .await
                    .map_err(app_err)?
                    .id
            }
            _ => {
                crate::forge::forge_issue_view(self.repo.clone(), args.number, None)
                    .await
                    .map_err(app_err)?
                    .id
            }
        };
        let repo_labels = crate::forge::forge_repo_labels(self.repo.clone(), None)
            .await
            .map_err(app_err)?;
        let id_for = |name: &str| -> Option<String> {
            repo_labels
                .iter()
                .find(|l| l.name == name)
                .map(|l| l.id.clone())
        };
        // GitLab labels carry no id, so treat only a missing NAME as an error — a known
        // name with an empty id still proceeds by name.
        let mut add_ids = Vec::new();
        let mut remove_ids = Vec::new();
        for name in &args.add {
            match id_for(name) {
                Some(id) if !id.is_empty() => add_ids.push(id),
                Some(_) => {} // known label, no id (GitLab) — name side carries it
                None => {
                    return Err(McpError::invalid_params(
                        format!("no such label in this repo: {name}"),
                        None,
                    ));
                }
            }
        }
        for name in &args.remove {
            match id_for(name) {
                Some(id) if !id.is_empty() => remove_ids.push(id),
                Some(_) => {}
                None => {
                    return Err(McpError::invalid_params(
                        format!("no such label in this repo: {name}"),
                        None,
                    ));
                }
            }
        }
        crate::forge::forge_edit_labels(
            self.repo.clone(),
            target.to_string(),
            args.number,
            labelable_id,
            add_ids,
            remove_ids,
            args.add.clone(),
            args.remove.clone(),
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "kind": args.kind,
            "number": args.number,
            "added": args.add,
            "removed": args.remove,
        }))
    }

    #[tool(
        description = "Set an issue's assignees (by number) in the bound repository's forge (GitHub \
                       or GitLab, per its remote; Bitbucket issues aren't supported; for a repo \
                       with a linked Jira project, use assign_jira_issue instead). `assignees` \
                       is the FULL desired set of logins — it REPLACES the current assignees (an \
                       empty list clears them). See list_assignable_users. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn set_issue_assignees(
        &self,
        Parameters(args): Parameters<SetAssigneesArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_issue_set_assignees(
            self.repo.clone(),
            args.number,
            args.assignees.clone(),
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({ "issue": args.number, "assignees": args.assignees }))
    }

    #[tool(
        description = "Set a pull request's assignees (by number) in the bound repository's forge \
                       (GitHub or GitLab, per its remote; Bitbucket assignees aren't supported). \
                       `assignees` is the FULL desired set of logins — it REPLACES the current \
                       assignees (an empty list clears them). See list_assignable_users. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn set_pull_request_assignees(
        &self,
        Parameters(args): Parameters<SetAssigneesArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_mr_set_assignees(
            self.repo.clone(),
            args.number,
            args.assignees.clone(),
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "pull_request": args.number, "assignees": args.assignees }),
        )
    }

    #[tool(
        description = "Approve a pull request (by number) in the bound repository's forge — works on \
                       GitHub, GitLab, and Bitbucket, per its remote (GitHub goes through \
                       `gh pr review --approve`). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn approve_pull_request(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_approve(self.repo.clone(), args.number, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "action": "approved" }))
    }

    #[tool(
        description = "Withdraw the viewer's approval of a pull request (by number) in the bound \
                       repository's forge (GitLab or Bitbucket, per its remote). GitHub approvals \
                       go through the review flow — the forge layer returns an actionable error \
                       there. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn withdraw_pull_request_approval(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_unapprove(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "pull_request": args.number, "action": "approval_withdrawn" }),
        )
    }

    #[tool(
        description = "Reply to a pull request's file:line review thread in the bound repository's \
                       forge (GitHub, GitLab, or Bitbucket, per its remote). The `thread_id` comes \
                       from list_pull_request_comments' review_threads. A \"Posted by GitDesktop\" \
                       attribution footer is appended automatically. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn reply_to_review_thread(
        &self,
        Parameters(args): Parameters<ReplyToReviewThreadArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        crate::forge::forge_pr_thread_reply(self.repo.clone(), args.number, args.thread_id, body)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "action": "replied" }))
    }

    #[tool(
        description = "Resolve or unresolve a pull request's review thread in the bound \
                       repository's forge (GitHub or GitLab, per its remote; Bitbucket has no \
                       thread-resolution surface). The `thread_id` comes from \
                       list_pull_request_comments' review_threads. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn resolve_review_thread(
        &self,
        Parameters(args): Parameters<ResolveReviewThreadArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_thread_resolve(
            self.repo.clone(),
            args.number,
            args.thread_id,
            args.resolved,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "pull_request": args.number,
            "resolved": args.resolved,
        }))
    }

    #[tool(
        description = "Re-run a CI run's FAILED jobs (by run id) in the bound repository's forge \
                       (GitHub Actions, GitLab CI, or Bitbucket Pipelines, per its remote). On \
                       GitLab/Bitbucket, which have no failed-only retry, this re-triggers the run. \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn rerun_workflow_run(
        &self,
        Parameters(args): Parameters<RunIdArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_ci_run_rerun(self.repo.clone(), args.run_id.as_u64(), true)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "run_id": args.run_id.as_string(), "action": "rerun" }))
    }

    #[tool(
        description = "Cancel an in-flight CI run (by run id) in the bound repository's forge \
                       (GitHub Actions, GitLab CI, or Bitbucket Pipelines, per its remote). \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn cancel_workflow_run(
        &self,
        Parameters(args): Parameters<RunIdArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_ci_run_cancel(self.repo.clone(), args.run_id.as_u64())
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "run_id": args.run_id.as_string(), "action": "cancelled" }))
    }

    #[tool(
        description = "Manually start a CI run in the bound repository's forge (GitHub Actions, \
                       GitLab CI, or Bitbucket Pipelines, per its remote). GitHub dispatches the \
                       named `workflow` on `ref` with `inputs`; GitLab runs a pipeline on the ref \
                       (ignoring `workflow`, with `inputs` as CI/CD variables); Bitbucket triggers \
                       the branch pipeline (a non-empty `workflow` names a custom one). Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn dispatch_workflow(
        &self,
        Parameters(args): Parameters<DispatchWorkflowArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_ci_dispatch(
            self.repo.clone(),
            args.workflow,
            args.git_ref,
            args.inputs,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({ "action": "dispatched" }))
    }

    #[tool(
        description = "Publish a release in the bound repository's forge (GitHub or GitLab, per its \
                       remote; Bitbucket releases aren't supported). Creates the `tag` if needed. \
                       `draft`/`prerelease` are GitHub-only (GitLab ignores them). Returns the new \
                       release's web URL as JSON. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_release(
        &self,
        Parameters(args): Parameters<CreateReleaseArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // `target` empty = the provider's default branch; `latest` false = let the
        // provider apply its automatic "latest" logic rather than forcing it.
        let url = crate::forge::forge_release_create(
            self.repo.clone(),
            args.tag.clone(),
            args.title,
            args.notes,
            String::new(),
            args.prerelease,
            args.draft,
            false,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({ "tag": args.tag, "url": url }))
    }

    #[tool(
        description = "Edit a release's title and/or notes (and, on GitHub, its draft/prerelease \
                       state) by tag in the bound repository's forge (GitHub or GitLab, per its \
                       remote; Bitbucket releases aren't supported). Omitted fields keep their \
                       current value (the current release is read first to preserve them). When \
                       `notes` are given and the release carries a `latest.json` Tauri updater \
                       manifest (GitHub only), the manifest's notes are synced to match, so \
                       installed apps show the same \"what's new\" as the release page — pass \
                       `sync_updater_notes: false` to leave it alone. Releases without that asset \
                       are unaffected. Syncing REPLACES the `latest.json` asset \
                       (delete-then-upload), so a failed upload can leave the release without a \
                       manifest; `updater_manifest_error` then carries the recovery details, \
                       including the patched copy's path when one could be parked. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn update_release(
        &self,
        Parameters(args): Parameters<UpdateReleaseArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // Decided before the fallbacks below consume `args.notes`.
        let notes_to_sync = updater_notes_to_sync(args.notes.as_deref(), args.sync_updater_notes);
        // forge_release_edit sends title/notes AND applies prerelease/draft explicitly
        // (gh's `--flag=<bool>` form), so an omitted flag would otherwise be forced to its
        // param default. Read the current release to preserve whatever the caller didn't
        // set. `latest` is tri-state and we always pass `None` here: omitting `--latest`
        // lets GitHub keep/decide Latest natively (a draft's Latest is structurally false,
        // so round-tripping it would strip Latest when the update publishes the release).
        let needs_current = args.title.is_none()
            || args.notes.is_none()
            || args.draft.is_none()
            || args.prerelease.is_none();
        let current = if needs_current {
            Some(
                crate::forge::forge_release_view(self.repo.clone(), args.tag.clone())
                    .await
                    .map_err(app_err)?,
            )
        } else {
            None
        };
        let title = args
            .title
            .or_else(|| current.as_ref().map(|r| r.name.clone()))
            .unwrap_or_default();
        let notes = args
            .notes
            .or_else(|| current.as_ref().map(|r| r.body.clone()))
            .unwrap_or_default();
        let draft = args
            .draft
            .or_else(|| current.as_ref().map(|r| r.is_draft))
            .unwrap_or(false);
        let prerelease = args
            .prerelease
            .or_else(|| current.as_ref().map(|r| r.is_prerelease))
            .unwrap_or(false);
        crate::forge::forge_release_edit(
            self.repo.clone(),
            args.tag.clone(),
            title,
            notes,
            prerelease,
            draft,
            None,
        )
        .await
        .map_err(app_err)?;
        let mut result = serde_json::json!({ "tag": args.tag, "action": "updated" });
        // The edit already landed, so a manifest-sync failure is a caveat on a
        // successful result, never a tool error — and its text carries the recovery
        // path for a clobbered manifest, so it ships verbatim.
        if let Some(sync_notes) = notes_to_sync {
            match sync_release_updater_notes(&self.repo, &args.tag, &sync_notes, current.as_ref())
                .await
            {
                Some(Ok(())) => {
                    result["updater_manifest"] = serde_json::Value::String(format!(
                        "Updater manifest ({UPDATER_MANIFEST}) synced to the edited notes."
                    ));
                }
                Some(Err(disclosure)) => {
                    result["updater_manifest_error"] = serde_json::Value::String(disclosure);
                }
                None => {}
            }
        }
        json_result(&result)
    }

    #[tool(
        description = "Start a NEW file:line-anchored review thread on a pull request in the bound \
                       repository's forge (GitHub, GitLab, or Bitbucket, per its remote). `side` is \
                       \"new\" (added/right side, default) or \"old\" (removed/left side); \
                       `start_line` opens a multi-line range (GitHub/GitLab; Bitbucket anchors at \
                       `line`). To reply to an EXISTING thread use reply_to_review_thread. A \
                       \"Posted by GitDesktop\" attribution footer is appended automatically. \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_review_thread(
        &self,
        Parameters(args): Parameters<CreateReviewThreadArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        let side = if args.side.is_empty() {
            "new".to_string()
        } else {
            args.side
        };
        crate::forge::forge_pr_thread_create(
            self.repo.clone(),
            args.number,
            args.path,
            args.line,
            side,
            args.start_line,
            body,
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({ "pull_request": args.number, "action": "thread_created" }))
    }

    #[tool(
        description = "Request changes on a pull request (the blocking reviewer state) in the bound \
                       repository's forge — works on GitHub, GitLab, and Bitbucket, per its remote \
                       (GitHub goes through `gh pr review --request-changes`, which requires a \
                       non-empty body; the error surfaces if it's omitted). Reversible via \
                       withdraw_change_request on Bitbucket. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn request_changes(
        &self,
        Parameters(args): Parameters<RequestChangesArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_request_changes(self.repo.clone(), args.number, args.body, None)
            .await
            .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "pull_request": args.number, "action": "changes_requested" }),
        )
    }

    #[tool(
        description = "Withdraw the viewer's requested-changes state on a pull request in the bound \
                       repository's forge (Bitbucket only, per its remote). GitLab can only revoke a \
                       change request on Premium, and GitHub can't withdraw a requested-changes \
                       review via gh — the forge layer returns an actionable error there. Requires \
                       --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn withdraw_change_request(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_pr_unrequest_changes(self.repo.clone(), args.number)
            .await
            .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "pull_request": args.number, "action": "change_request_withdrawn" }),
        )
    }

    #[tool(
        description = "Edit an issue's title and/or body (by number) in the bound repository's forge \
                       (GitHub or GitLab, per its remote; Bitbucket issues aren't supported). Omitted \
                       fields keep their current value (the current issue is read first to preserve \
                       them). Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn update_issue(
        &self,
        Parameters(args): Parameters<UpdateIssueArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        // forge_issue_edit replaces BOTH title and body, so fetch the current issue to
        // fill whichever the caller omitted — otherwise an omitted field would be wiped
        // (same fetch-and-preserve as update_pull_request).
        let (title, body) = if args.title.is_none() || args.body.is_none() {
            let issue = crate::forge::forge_issue_view(self.repo.clone(), args.number, None)
                .await
                .map_err(app_err)?;
            (
                args.title.unwrap_or(issue.title),
                args.body.unwrap_or(issue.body),
            )
        } else {
            (args.title.unwrap(), args.body.unwrap())
        };
        crate::forge::forge_issue_edit(self.repo.clone(), args.number, title, body, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "issue": args.number, "action": "updated" }))
    }

    #[tool(
        description = "Set (or clear) an issue's milestone (by number) in the bound repository's \
                       forge (GitHub or GitLab, per its remote; Bitbucket issues aren't supported). \
                       `milestone` is the `number` of the chosen entry from list_milestones; omit \
                       it to CLEAR the milestone. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn set_issue_milestone(
        &self,
        Parameters(args): Parameters<SetIssueMilestoneArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        crate::forge::forge_issue_set_milestone(self.repo.clone(), args.number, args.milestone, None)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "issue": args.number, "milestone": args.milestone }))
    }

    #[tool(
        description = "Add the viewer's reaction to an issue or pull request (or one of its \
                       comments) in the bound repository's forge (GitHub or GitLab, per its remote; \
                       Bitbucket Cloud has no reactions). `kind` is \"issue\" or \"pr\". `content` \
                       is one of THUMBS_UP, THUMBS_DOWN, LAUGH, HOORAY, CONFUSED, HEART, ROCKET, \
                       EYES. Pass `subject_id` (a comment node id) to react to a specific comment; \
                       omit it to react to the body. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn add_reaction(
        &self,
        Parameters(args): Parameters<ReactionArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        validate_reaction(&args.content)?;
        let target = reaction_target(&args.kind)?;
        crate::forge::forge_add_reaction(
            self.repo.clone(),
            target.to_string(),
            args.number,
            args.subject_id,
            args.content.clone(),
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "kind": args.kind,
            "number": args.number,
            "reaction": args.content,
            "action": "added",
        }))
    }

    #[tool(
        description = "Remove the viewer's reaction from an issue or pull request (or one of its \
                       comments) in the bound repository's forge (GitHub or GitLab, per its remote; \
                       Bitbucket Cloud has no reactions). `kind` is \"issue\" or \"pr\". `content` \
                       is one of THUMBS_UP, THUMBS_DOWN, LAUGH, HOORAY, CONFUSED, HEART, ROCKET, \
                       EYES. Pass `subject_id` (a comment node id) to target a specific comment; \
                       omit it for the body. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn remove_reaction(
        &self,
        Parameters(args): Parameters<ReactionArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        validate_reaction(&args.content)?;
        let target = reaction_target(&args.kind)?;
        crate::forge::forge_remove_reaction(
            self.repo.clone(),
            target.to_string(),
            args.number,
            args.subject_id,
            args.content.clone(),
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({
            "kind": args.kind,
            "number": args.number,
            "reaction": args.content,
            "action": "removed",
        }))
    }

    #[tool(
        description = "Open a discussion in the bound repository (GitHub only — GitLab/Bitbucket \
                       have no discussions; the tool errors on those remotes), under the \
                       authenticated forge user. `category` is a category NAME (see \
                       list_discussion_categories) — required. Returns the created discussion's \
                       number + URL as JSON. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_discussion(
        &self,
        Parameters(args): Parameters<CreateDiscussionArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        super::read_forge::ensure_github(&self.repo).await?;
        // Resolve the category NAME → node id (and the repo node id create needs) from
        // the categories metadata.
        let meta = crate::github::discussion::gh_discussion_categories(self.repo.clone())
            .await
            .map_err(app_err)?;
        let category = meta
            .categories
            .iter()
            .find(|c| c.name == args.category)
            .ok_or_else(|| {
                let available = meta
                    .categories
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                McpError::invalid_params(
                    format!(
                        "no such discussion category: {}. Available: {available}",
                        args.category
                    ),
                    None,
                )
            })?;
        let pr_ref = crate::github::discussion::gh_discussion_create(
            self.repo.clone(),
            meta.repo_id.clone(),
            category.id.clone(),
            args.title,
            args.body,
        )
        .await
        .map_err(app_err)?;
        json_result(&pr_ref)
    }

    #[tool(
        description = "Post a comment to a discussion (by number) in the bound repository (GitHub \
                       only — GitLab/Bitbucket have no discussions; the tool errors on those \
                       remotes), under the authenticated forge user. A \"Posted by GitDesktop\" \
                       attribution footer is appended automatically. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn comment_discussion(
        &self,
        Parameters(args): Parameters<CommentDiscussionArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        super::read_forge::ensure_github(&self.repo).await?;
        // add_comment is keyed by the discussion's node id, not its number — resolve it.
        let discussion =
            crate::github::discussion::gh_discussion_view(self.repo.clone(), args.number)
                .await
                .map_err(app_err)?;
        let body = format!("{}{GD_COMMENT_FOOTER}", args.body);
        crate::github::discussion::gh_discussion_add_comment(
            self.repo.clone(),
            discussion.id,
            body,
            None,
        )
        .await
        .map_err(app_err)?;
        json_result(&serde_json::json!({ "discussion": args.number, "action": "commented" }))
    }

    #[tool(
        description = "Mark (or unmark) a discussion comment as the accepted answer in the bound \
                       repository (GitHub only — GitLab/Bitbucket have no discussions; the tool \
                       errors on those remotes). `comment_id` is a comment's node id from \
                       get_discussion; `answer` is true to mark (default) or false to unmark. Only \
                       Q&A-category discussions accept an answer. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn mark_discussion_answer(
        &self,
        Parameters(args): Parameters<MarkDiscussionAnswerArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        super::read_forge::ensure_github(&self.repo).await?;
        if args.answer {
            crate::github::discussion::gh_discussion_mark_answer(
                self.repo.clone(),
                args.comment_id.clone(),
            )
            .await
            .map_err(app_err)?;
        } else {
            crate::github::discussion::gh_discussion_unmark_answer(
                self.repo.clone(),
                args.comment_id.clone(),
            )
            .await
            .map_err(app_err)?;
        }
        json_result(&serde_json::json!({
            "comment_id": args.comment_id,
            "answer": args.answer,
        }))
    }

    #[tool(
        description = "Close a discussion (by number) in the bound repository (GitHub only — \
                       GitLab/Bitbucket have no discussions; the tool errors on those remotes). \
                       `reason` is \"RESOLVED\" (default), \"OUTDATED\", or \"DUPLICATE\". \
                       Reversible via reopen_discussion. Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn close_discussion(
        &self,
        Parameters(args): Parameters<CloseDiscussionArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        super::read_forge::ensure_github(&self.repo).await?;
        let discussion =
            crate::github::discussion::gh_discussion_view(self.repo.clone(), args.number)
                .await
                .map_err(app_err)?;
        // Empty resolves to "RESOLVED" in the github core; mirror that in the reply.
        let resolved = if args.reason.is_empty() {
            "RESOLVED"
        } else {
            args.reason.as_str()
        };
        crate::github::discussion::gh_discussion_close(
            self.repo.clone(),
            discussion.id,
            args.reason.clone(),
        )
        .await
        .map_err(app_err)?;
        json_result(
            &serde_json::json!({ "discussion": args.number, "status": "closed", "reason": resolved }),
        )
    }

    #[tool(
        description = "Reopen a closed discussion (by number) in the bound repository (GitHub only \
                       — GitLab/Bitbucket have no discussions; the tool errors on those remotes). \
                       Requires --allow-remote-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn reopen_discussion(
        &self,
        Parameters(args): Parameters<NumberArg>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_remote_write()?;
        super::read_forge::ensure_github(&self.repo).await?;
        // reopen is keyed by the discussion's node id — resolve it from the number.
        let discussion =
            crate::github::discussion::gh_discussion_view(self.repo.clone(), args.number)
                .await
                .map_err(app_err)?;
        crate::github::discussion::gh_discussion_reopen(self.repo.clone(), discussion.id)
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "discussion": args.number, "status": "open" }))
    }
}

#[cfg(test)]
mod tests {
    use super::super::CiId;
    use super::*;
    use rmcp::handler::server::wrapper::Parameters;

    /// With ALL flags false, EVERY forge remote-write tool must return the
    /// `--allow-remote-write` gate error before touching the network. Params carry
    /// throwaway values — the gate fires first, so they are never read.
    #[tokio::test]
    async fn all_write_tools_gated_on_allow_remote_write() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);

        macro_rules! assert_gated {
            ($call:expr) => {{
                let err = $call
                    .await
                    .expect_err("expected the remote-write gate to fire");
                let msg = err.to_string();
                assert!(
                    msg.contains("--allow-remote-write"),
                    "gate error should name --allow-remote-write, got: {msg}"
                );
            }};
        }

        assert_gated!(h.create_issue(Parameters(CreateIssueArgs {
            title: "t".into(),
            body: String::new(),
            labels: Vec::new(),
            assignees: Vec::new(),
        })));
        assert_gated!(h.comment_issue(Parameters(CommentIssueArgs {
            number: 1,
            body: "b".into(),
        })));
        assert_gated!(h.close_issue(Parameters(CloseIssueArgs {
            number: 1,
            reason: String::new(),
        })));
        assert_gated!(h.reopen_issue(Parameters(ReopenIssueArgs { number: 1 })));
        assert_gated!(h.comment_pull_request(Parameters(CommentPullRequestArgs {
            number: 1,
            body: "b".into(),
        })));
        assert_gated!(h.create_pull_request(Parameters(CreatePullRequestArgs {
            base: "main".into(),
            head: "feature".into(),
            title: "t".into(),
            body: String::new(),
            draft: false,
            labels: None,
            assignees: None,
            reviewers: None,
        })));
        assert_gated!(h.merge_pull_request(Parameters(MergePullRequestArgs {
            number: 1,
            strategy: None,
            delete_branch: false,
        })));
        assert_gated!(h.update_pull_request(Parameters(UpdatePullRequestArgs {
            number: 1,
            title: Some("t".into()),
            body: Some("b".into()),
        })));
        assert_gated!(
            h.set_pull_request_draft(Parameters(SetPullRequestDraftArgs {
                number: 1,
                draft: true,
            }))
        );
        assert_gated!(h.close_pull_request(Parameters(NumberArg { number: 1 })));
        assert_gated!(h.reopen_pull_request(Parameters(NumberArg { number: 1 })));
        assert_gated!(h.request_reviewers(Parameters(RequestReviewersArgs {
            number: 1,
            reviewers: vec!["octocat".into()],
        })));
        assert_gated!(h.edit_labels(Parameters(EditLabelsArgs {
            kind: "pr".into(),
            number: 1,
            add: vec!["bug".into()],
            remove: Vec::new(),
        })));
        assert_gated!(h.set_issue_assignees(Parameters(SetAssigneesArgs {
            number: 1,
            assignees: vec!["octocat".into()],
        })));
        assert_gated!(h.set_pull_request_assignees(Parameters(SetAssigneesArgs {
            number: 1,
            assignees: vec!["octocat".into()],
        })));
        assert_gated!(h.approve_pull_request(Parameters(NumberArg { number: 1 })));
        assert_gated!(h.withdraw_pull_request_approval(Parameters(NumberArg { number: 1 })));
        assert_gated!(
            h.reply_to_review_thread(Parameters(ReplyToReviewThreadArgs {
                number: 1,
                thread_id: "t".into(),
                body: "b".into(),
            }))
        );
        assert_gated!(h.resolve_review_thread(Parameters(ResolveReviewThreadArgs {
            number: 1,
            thread_id: "t".into(),
            resolved: true,
        })));
        assert_gated!(h.rerun_workflow_run(Parameters(RunIdArg { run_id: CiId(1) })));
        assert_gated!(h.cancel_workflow_run(Parameters(RunIdArg { run_id: CiId(1) })));
        assert_gated!(h.dispatch_workflow(Parameters(DispatchWorkflowArgs {
            workflow: "ci.yml".into(),
            git_ref: "main".into(),
            inputs: HashMap::new(),
        })));
        assert_gated!(h.create_release(Parameters(CreateReleaseArgs {
            tag: "v1.0.0".into(),
            title: String::new(),
            notes: String::new(),
            draft: false,
            prerelease: false,
        })));
        assert_gated!(h.update_release(Parameters(UpdateReleaseArgs {
            tag: "v1.0.0".into(),
            title: Some("t".into()),
            notes: Some("n".into()),
            draft: Some(false),
            prerelease: Some(false),
            sync_updater_notes: None,
        })));
        assert_gated!(h.create_review_thread(Parameters(CreateReviewThreadArgs {
            number: 1,
            path: "src/x.rs".into(),
            line: 1,
            side: "new".into(),
            start_line: None,
            body: "b".into(),
        })));
        assert_gated!(h.request_changes(Parameters(RequestChangesArgs {
            number: 1,
            body: "b".into(),
        })));
        assert_gated!(h.withdraw_change_request(Parameters(NumberArg { number: 1 })));
        assert_gated!(h.update_issue(Parameters(UpdateIssueArgs {
            number: 1,
            title: Some("t".into()),
            body: Some("b".into()),
        })));
        assert_gated!(h.set_issue_milestone(Parameters(SetIssueMilestoneArgs {
            number: 1,
            milestone: Some(1),
        })));
        assert_gated!(h.add_reaction(Parameters(ReactionArgs {
            kind: "issue".into(),
            number: 1,
            content: "THUMBS_UP".into(),
            subject_id: String::new(),
        })));
        assert_gated!(h.remove_reaction(Parameters(ReactionArgs {
            kind: "pr".into(),
            number: 1,
            content: "HEART".into(),
            subject_id: String::new(),
        })));
        assert_gated!(h.create_discussion(Parameters(CreateDiscussionArgs {
            title: "t".into(),
            body: String::new(),
            category: "General".into(),
        })));
        assert_gated!(h.comment_discussion(Parameters(CommentDiscussionArgs {
            number: 1,
            body: "b".into(),
        })));
        assert_gated!(
            h.mark_discussion_answer(Parameters(MarkDiscussionAnswerArgs {
                comment_id: "c".into(),
                answer: true,
            }))
        );
        assert_gated!(h.close_discussion(Parameters(CloseDiscussionArgs {
            number: 1,
            reason: String::new(),
        })));
        assert_gated!(h.reopen_discussion(Parameters(NumberArg { number: 1 })));
    }

    /// The reaction tools reject an unknown `content` with an actionable error that
    /// lists the valid vocabulary — before any network call. (The gate is open here so
    /// validation, which runs after it, is what fires.)
    #[tokio::test]
    async fn reaction_rejects_unknown_content() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, true, false, false);
        let err = h
            .add_reaction(Parameters(ReactionArgs {
                kind: "issue".into(),
                number: 1,
                content: "PARTY".into(),
                subject_id: String::new(),
            }))
            .await
            .expect_err("expected an unknown-reaction rejection");
        let msg = err.to_string();
        assert!(msg.contains("unknown reaction: PARTY"), "got: {msg}");
        assert!(
            msg.contains("THUMBS_UP"),
            "should list valid values, got: {msg}"
        );
    }

    /// The reaction tools reject an unknown `kind` (not issue/pr) with an actionable
    /// error before any network call.
    #[tokio::test]
    async fn reaction_rejects_unknown_kind() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, true, false, false);
        let err = h
            .remove_reaction(Parameters(ReactionArgs {
                kind: "discussion".into(),
                number: 1,
                content: "EYES".into(),
                subject_id: String::new(),
            }))
            .await
            .expect_err("expected an unknown-kind rejection");
        assert!(err.to_string().contains("kind must be"), "got: {}", err);
    }

    /// The updater-sync gate: a sync only fires for notes the edit actually wrote,
    /// and never against the caller's opt-out. Syncing empty notes would blank a
    /// live manifest, since the edit itself skips `--notes` for them.
    #[test]
    fn updater_notes_to_sync_gates_empty_notes_and_the_opt_out() {
        assert_eq!(updater_notes_to_sync(None, None), None, "no notes, no sync");
        assert_eq!(
            updater_notes_to_sync(Some("   "), None),
            None,
            "whitespace-only notes leave the body untouched, so nothing to sync"
        );
        assert_eq!(
            updater_notes_to_sync(Some("n"), Some(false)),
            None,
            "the caller's opt-out wins over real notes"
        );
        assert_eq!(
            updater_notes_to_sync(Some(" n "), None),
            Some("n".to_string()),
            "the synced text is trimmed, like the text the edit wrote"
        );
    }
}
