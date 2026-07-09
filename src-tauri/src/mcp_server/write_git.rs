//! Local-git WRITE tools (opt-in via `--allow-git-write`, destructive ops also need
//! `--allow-destructive`).
//!
//! Three groups live here, all in the git-ops domain:
//! - RECOVERABLE mutations (stage/commit/branch/push/pull/fetch/stash/merge/rebase/
//!   revert/cherry-pick/tag), gated on [`GitDesktopMcp::ensure_git_write`] and annotated
//!   non-destructive.
//! - UNGATED reads (list_stashes, preview_merge) — reads always available, no annotations.
//! - DESTRUCTIVE mutations (delete_branch/discard/reset/force_push/delete_remote_branch/
//!   drop_stash/delete_tag), gated on [`GitDesktopMcp::ensure_destructive`] (needs BOTH
//!   `--allow-git-write` and `--allow-destructive`) and annotated `destructive_hint`.
//!
//! Every tool delegates to the matching `git_*_core` in `crate::git::*`, which routes
//! its mutations through `self.state`'s per-repo lock (`run_git_mutating`) so concurrent
//! MCP calls don't fight over `.git/index.lock`. User-supplied branch/rev/path strings
//! are rejected with [`ensure_not_flag`] before they reach git argv; `delete_branch`,
//! `delete_remote_branch`, `checkout_branch`, `create_branch` (name), and `rename_branch`
//! (both `from` and `to`) additionally refuse `gd/session/*` agent-session branches —
//! mutating one breaks session Resume, and creating/renaming INTO that namespace would
//! yield an invisible (UI-filtered) branch.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_not_flag, json_result, GitDesktopMcp};

/// The reserved prefix for GitDesktop agent-session branches. Every branch surface
/// (GUI lists, pickers, worktree guards) filters `gd/session/*`; deleting or renaming
/// one breaks session Resume, so the branch-mutating MCP tools refuse it too. Mirrors
/// the `starts_with("gd/session/")` checks in `crate::git::worktree` / `crate::sessions`.
const SESSION_BRANCH_PREFIX: &str = "gd/session/";

/// Refuses a branch name that names a GitDesktop agent-session branch, with an
/// actionable error. Pure string logic (no repo access) so it's unit-testable.
fn ensure_not_session_branch(name: &str) -> Result<(), McpError> {
    if name.starts_with(SESSION_BRANCH_PREFIX) {
        return Err(McpError::invalid_params(
            format!(
                "\"{name}\" is a GitDesktop agent-session branch; deleting it breaks session \
                 Resume. Refusing."
            ),
            None,
        ));
    }
    Ok(())
}

/// Emits a plain-text success result for the (many) core commands that return `()`.
fn ok_text(msg: impl Into<String>) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![Content::text(msg.into())]))
}

// ---- Parameter structs ----------------------------------------------------

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StagePathsArgs {
    /// Repo-relative paths to stage (or unstage). Directories and pathspecs are accepted.
    paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommitArgs {
    /// The commit message (first line / subject).
    message: String,
    /// Optional commit body (a second paragraph). Empty/whitespace is dropped.
    #[serde(default)]
    body: Option<String>,
    /// Amend the previous commit instead of creating a new one. Defaults to false.
    #[serde(default)]
    amend: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateBranchArgs {
    /// The new branch name.
    name: String,
    /// Check out the new branch after creating it. Defaults to false (create only).
    #[serde(default)]
    checkout: bool,
    /// Optional start point (a branch, tag, or commit) to create the branch from.
    /// Defaults to the current HEAD.
    #[serde(default)]
    from: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct BranchNameArgs {
    /// The branch name.
    name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RenameBranchArgs {
    /// The current branch name.
    from: String,
    /// The new branch name.
    to: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PushArgs {
    /// Set the upstream (`-u origin HEAD`) while pushing — for a branch pushed the
    /// first time. Defaults to false.
    #[serde(default)]
    set_upstream: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PullArgs {
    /// Reconcile a diverged branch: "merge" (a merge commit) or "rebase" (replay on
    /// top). Anything else (including omitted) stays the safe fast-forward-only pull.
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StashPushArgs {
    /// Optional repo-relative paths to stash. When omitted/empty, stashes ALL changes
    /// (including untracked). NOTE: stashing selected paths snapshots the WHOLE index,
    /// so already-staged files ride along (a known `git stash push -- <paths>` behavior).
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StashApplyArgs {
    /// Which stash to apply, by index (0 = most recent; see list_stashes). Defaults to 0.
    #[serde(default)]
    index: u32,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StashIndexArgs {
    /// Which stash, by index (0 = most recent; see list_stashes).
    index: u32,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct MergeBranchArgs {
    /// The branch to merge INTO the current branch.
    branch: String,
    /// Squash the merged changes into the index (no merge commit; you commit them
    /// yourself). Defaults to false.
    #[serde(default)]
    squash: bool,
    /// Force a merge commit even when a fast-forward is possible (`--no-ff`). Ignored
    /// when `squash` is set. Defaults to false.
    #[serde(default)]
    no_ff: bool,
    /// Conflict auto-resolution: "ours" or "theirs" (via `-X`); anything else (default)
    /// applies no strategy and lets real conflicts surface.
    #[serde(default)]
    strategy: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RebaseBranchArgs {
    /// The branch to rebase the current branch ONTO.
    onto: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ShaArgs {
    /// A commit SHA (hex).
    sha: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CreateTagArgs {
    /// The tag name.
    name: String,
    /// The commit (SHA) to tag. Required (this creates a lightweight tag at that commit).
    at: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct TagNameArgs {
    /// The tag name.
    name: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PreviewMergeArgs {
    /// The branch whose merge INTO the current branch to predict.
    branch: String,
    /// Conflict strategy to model: "ours"/"theirs" (via `-X`), else none. Defaults to none.
    #[serde(default)]
    strategy: Option<String>,
}

// ---- discard params -------------------------------------------------------

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DiscardPathArg {
    /// Repo-relative path to discard.
    path: String,
    /// Whether this path is untracked (a new file). Untracked files go to the OS
    /// recycle bin; tracked files are restored from the index. Defaults to false.
    #[serde(default)]
    untracked: bool,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DiscardChangesArgs {
    /// The files to discard working-tree changes for.
    paths: Vec<DiscardPathArg>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DeleteRemoteBranchArgs {
    /// The remote to delete the branch on (e.g. "origin").
    #[serde(default = "default_origin")]
    remote: String,
    /// The branch name to delete on the remote.
    name: String,
}

fn default_origin() -> String {
    "origin".to_string()
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DeleteTagArgs {
    /// The tag name to delete.
    name: String,
    /// Also delete it on origin. Defaults to false (local only).
    #[serde(default)]
    remote: bool,
}

#[tool_router(router = write_git_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    // ---- RECOVERABLE (ensure_git_write) ----------------------------------

    #[tool(
        description = "Stage files (git add) in the bound repository. Accepts repo-relative paths, \
                       directories, or pathspecs. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn stage_files(
        &self,
        Parameters(args): Parameters<StagePathsArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        for p in &args.paths {
            ensure_not_flag(p, "path")?;
        }
        crate::git::stage::git_stage_core(&self.state, self.repo.clone(), args.paths)
            .await
            .map_err(app_err)?;
        ok_text("staged")
    }

    #[tool(
        description = "Unstage files (restore from the index; drop from the index in an empty \
                       repo) in the bound repository. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn unstage_files(
        &self,
        Parameters(args): Parameters<StagePathsArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        for p in &args.paths {
            ensure_not_flag(p, "path")?;
        }
        crate::git::stage::git_unstage_core(&self.state, self.repo.clone(), args.paths)
            .await
            .map_err(app_err)?;
        ok_text("unstaged")
    }

    #[tool(
        description = "Create a commit from the staged changes in the bound repository. With \
                       `amend`, rewrites the previous commit instead. Returns the new commit hash \
                       as JSON. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn commit(
        &self,
        Parameters(args): Parameters<CommitArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        let result =
            crate::git::commit::git_commit_core(&self.state, self.repo.clone(), args.message, args.body, args.amend)
                .await
                .map_err(app_err)?;
        json_result(&result)
    }

    #[tool(
        description = "Undo the most recent commit, keeping its changes staged (a SOFT reset — no \
                       work is lost, the changes return to the index). A root commit has no parent, \
                       so its branch ref is removed instead. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn undo_last_commit(&self) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        crate::git::commit::git_undo_commit_core(&self.state, self.repo.clone())
            .await
            .map_err(app_err)?;
        ok_text("last commit undone (changes kept staged)")
    }

    #[tool(
        description = "Create a branch in the bound repository, optionally checking it out and/or \
                       starting from a given branch/tag/commit (defaults to HEAD). Refuses to \
                       create a GitDesktop agent-session branch (gd/session/*). \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_branch(
        &self,
        Parameters(args): Parameters<CreateBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.name, "branch name")?;
        // Refuse the gd/session/* prefix: every UI surface filters it, so a branch
        // created there would be invisible (namespace pollution).
        ensure_not_session_branch(&args.name)?;
        if let Some(from) = &args.from {
            ensure_not_flag(from, "start point")?;
        }
        crate::git::branches::git_create_branch_core(
            &self.state,
            self.repo.clone(),
            args.name.clone(),
            args.checkout,
            args.from,
        )
        .await
        .map_err(app_err)?;
        ok_text(format!("branch created: {}", args.name))
    }

    #[tool(
        description = "Check out (switch to) an existing local branch in the bound repository. \
                       Refuses GitDesktop agent-session branches (gd/session/*). \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn checkout_branch(
        &self,
        Parameters(args): Parameters<BranchNameArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.name, "branch name")?;
        ensure_not_session_branch(&args.name)?;
        crate::git::branches::git_checkout_branch_core(&self.state, self.repo.clone(), args.name.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("switched to {}", args.name))
    }

    #[tool(
        description = "Rename a branch in the bound repository. Refuses to rename a GitDesktop \
                       agent-session branch (gd/session/*), or to rename INTO that namespace. \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn rename_branch(
        &self,
        Parameters(args): Parameters<RenameBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.from, "branch name")?;
        ensure_not_flag(&args.to, "branch name")?;
        // Protect agent-session branches: renaming one breaks session Resume, and
        // renaming INTO gd/session/* would create an invisible (filtered) branch.
        ensure_not_session_branch(&args.from)?;
        ensure_not_session_branch(&args.to)?;
        crate::git::branches::git_rename_branch_core(
            &self.state,
            self.repo.clone(),
            args.from.clone(),
            args.to.clone(),
        )
        .await
        .map_err(app_err)?;
        ok_text(format!("renamed {} -> {}", args.from, args.to))
    }

    #[tool(
        description = "Push the current branch to its remote in the bound repository (uses git's \
                       native credential flow). With `set_upstream`, sets upstream to \
                       origin/HEAD. Never force-pushes — use force_push (destructive) for that. \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn push(
        &self,
        Parameters(args): Parameters<PushArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        crate::git::remote::git_push_core(&self.state, self.repo.clone(), args.set_upstream, false)
            .await
            .map_err(app_err)?;
        ok_text("pushed")
    }

    #[tool(
        description = "Pull from the current branch's upstream in the bound repository. `mode` \
                       reconciles a diverged branch: \"merge\" or \"rebase\"; omitted stays \
                       fast-forward-only (the safe default). Conflicts surface in the normal \
                       conflict state. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn pull(
        &self,
        Parameters(args): Parameters<PullArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        let mode = args.mode.unwrap_or_default();
        crate::git::remote::git_pull_core(&self.state, self.repo.clone(), mode)
            .await
            .map_err(app_err)?;
        ok_text("pulled")
    }

    #[tool(
        description = "Fetch from all remotes (with --prune) in the bound repository. \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn fetch(&self) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        crate::git::remote::git_fetch_core(&self.state, self.repo.clone())
            .await
            .map_err(app_err)?;
        ok_text("fetched")
    }

    #[tool(
        description = "Stash changes in the bound repository. With no `paths`, stashes ALL changes \
                       (including untracked). With `paths`, stashes only those files — but NOTE: \
                       `git stash push -- <paths>` snapshots the WHOLE index, so already-staged \
                       files ride along in the stash. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn stash_push(
        &self,
        Parameters(args): Parameters<StashPushArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        if args.paths.is_empty() {
            crate::git::ops::git_stash_all_core(&self.state, self.repo.clone())
                .await
                .map_err(app_err)?;
            ok_text("stashed all changes")
        } else {
            for p in &args.paths {
                ensure_not_flag(p, "path")?;
            }
            crate::git::ops::git_stash_paths_core(&self.state, self.repo.clone(), args.paths)
                .await
                .map_err(app_err)?;
            ok_text("stashed selected paths")
        }
    }

    #[tool(
        description = "Pop the most recent stash (apply it and drop it) in the bound repository. A \
                       conflict surfaces through the normal error path. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn stash_pop(&self) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        crate::git::ops::git_stash_pop_core(&self.state, self.repo.clone())
            .await
            .map_err(app_err)?;
        ok_text("stash popped")
    }

    #[tool(
        description = "Apply a stash by index (0 = most recent; see list_stashes) WITHOUT dropping \
                       it, in the bound repository. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn stash_apply(
        &self,
        Parameters(args): Parameters<StashApplyArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        crate::git::ops::git_stash_apply_core(&self.state, self.repo.clone(), args.index, false)
            .await
            .map_err(app_err)?;
        ok_text(format!("stash@{{{}}} applied", args.index))
    }

    #[tool(
        description = "Merge a branch INTO the current branch in the bound repository. `squash` \
                       leaves the combined changes staged (no merge commit); `no_ff` forces a \
                       merge commit; `strategy` (\"ours\"/\"theirs\") auto-resolves conflicting \
                       hunks. Real conflicts leave the repo in a normal merge-conflict state. \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn merge_branch(
        &self,
        Parameters(args): Parameters<MergeBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.branch, "branch")?;
        crate::git::ops::git_merge_core(
            &self.state,
            self.repo.clone(),
            args.branch.clone(),
            args.squash,
            args.no_ff,
            args.strategy.unwrap_or_default(),
        )
        .await
        .map_err(app_err)?;
        ok_text(format!("merged {}", args.branch))
    }

    #[tool(
        description = "Rebase the current branch ONTO another branch in the bound repository. \
                       Conflicts leave the rebase in progress (continue or abort via the app). \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn rebase_branch(
        &self,
        Parameters(args): Parameters<RebaseBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.onto, "branch")?;
        crate::git::ops::git_rebase_core(&self.state, self.repo.clone(), args.onto.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("rebased onto {}", args.onto))
    }

    #[tool(
        description = "Revert a commit by SHA in the bound repository — creates a new commit that \
                       undoes it (history is preserved, nothing is lost). Reverting a merge commit \
                       is not supported (it needs a parent choice). Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn revert_commit(
        &self,
        Parameters(args): Parameters<ShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.sha, "sha")?;
        crate::git::ops::git_revert_core(&self.state, self.repo.clone(), args.sha.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("reverted {}", args.sha))
    }

    #[tool(
        description = "Cherry-pick a commit by SHA onto the current branch in the bound \
                       repository. Returns whether a commit was created (a pick that is already \
                       present is skipped and returns false). Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn cherry_pick(
        &self,
        Parameters(args): Parameters<ShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.sha, "sha")?;
        let created = crate::git::ops::git_cherry_pick_core(&self.state, self.repo.clone(), args.sha.clone())
            .await
            .map_err(app_err)?;
        json_result(&serde_json::json!({ "sha": args.sha, "committed": created }))
    }

    #[tool(
        description = "Create a lightweight tag at a commit (`at`, a SHA) in the bound repository. \
                       Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_tag(
        &self,
        Parameters(args): Parameters<CreateTagArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.name, "tag name")?;
        ensure_not_flag(&args.at, "commit")?;
        crate::git::ops::git_tag_core(&self.state, self.repo.clone(), args.name.clone(), args.at)
            .await
            .map_err(app_err)?;
        ok_text(format!("tag created: {}", args.name))
    }

    #[tool(
        description = "Push a tag to origin in the bound repository. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn push_tag(
        &self,
        Parameters(args): Parameters<TagNameArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.name, "tag name")?;
        crate::git::ops::git_push_tag_core(&self.state, self.repo.clone(), args.name.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("tag pushed: {}", args.name))
    }

    // ---- UNGATED READS (git-ops domain; no gate, no write annotations) ---

    #[tool(
        description = "List the stash entries in the bound repository (index, message, date), \
                       most recent first. The index is what stash_apply/stash_pop/drop_stash \
                       address."
    )]
    async fn list_stashes(&self) -> Result<CallToolResult, McpError> {
        let stashes = crate::git::ops::git_stash_list(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result(&stashes)
    }

    #[tool(
        description = "Predict the outcome of merging `branch` INTO the current branch WITHOUT \
                       touching the working tree or index — an in-memory merge. Returns a status \
                       (\"up-to-date\", \"fast-forward\", \"clean\", \"conflict\", or \"unknown\") \
                       and, for a conflict, the conflicting file paths. `strategy` \
                       (\"ours\"/\"theirs\") models the auto-resolution the real merge would apply; \
                       structural conflicts still show as conflicts."
    )]
    async fn preview_merge(
        &self,
        Parameters(args): Parameters<PreviewMergeArgs>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_flag(&args.branch, "branch")?;
        let preview = crate::git::ops::git_merge_preview(
            self.repo.clone(),
            args.branch,
            args.strategy.unwrap_or_default(),
        )
        .await
        .map_err(app_err)?;
        json_result(&preview)
    }

    // ---- DESTRUCTIVE (ensure_destructive) --------------------------------

    #[tool(
        description = "Force-delete a local branch (git branch -D) in the bound repository — \
                       UNMERGED commits on it are irrecoverably lost. Refuses to delete a \
                       GitDesktop agent-session branch (gd/session/*). Requires --allow-git-write \
                       AND --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_branch(
        &self,
        Parameters(args): Parameters<BranchNameArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        ensure_not_flag(&args.name, "branch name")?;
        ensure_not_session_branch(&args.name)?;
        crate::git::branches::git_delete_branch_core(&self.state, self.repo.clone(), args.name.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("branch deleted: {}", args.name))
    }

    #[tool(
        description = "Discard working-tree changes for the given files in the bound repository — \
                       the changes are LOST (tracked files reset to the index; untracked files go \
                       to the OS recycle bin). Requires --allow-git-write AND --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn discard_changes(
        &self,
        Parameters(args): Parameters<DiscardChangesArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        for p in &args.paths {
            ensure_not_flag(&p.path, "path")?;
        }
        let paths = args
            .paths
            .into_iter()
            .map(|p| crate::git::ops::DiscardPath {
                path: p.path,
                untracked: p.untracked,
            })
            .collect();
        crate::git::ops::git_discard_paths_core(&self.state, self.repo.clone(), paths)
            .await
            .map_err(app_err)?;
        ok_text("changes discarded")
    }

    #[tool(
        description = "Discard EVERY uncommitted change in the bound repository — tracked changes \
                       are hard-reset to HEAD and untracked files go to the OS recycle bin. All \
                       uncommitted work is LOST. Requires --allow-git-write AND --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn discard_all_changes(&self) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        crate::git::ops::git_discard_all_core(&self.state, self.repo.clone())
            .await
            .map_err(app_err)?;
        ok_text("all uncommitted changes discarded")
    }

    #[tool(
        description = "Reset the current branch to a commit (SHA) in the bound repository — a MIXED \
                       reset: the branch pointer moves and the changes become unstaged in the \
                       working tree (commits after the target are removed from the branch). \
                       Requires --allow-git-write AND --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn reset_to_commit(
        &self,
        Parameters(args): Parameters<ShaArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        ensure_not_flag(&args.sha, "sha")?;
        crate::git::ops::git_reset_core(&self.state, self.repo.clone(), args.sha.clone())
            .await
            .map_err(app_err)?;
        ok_text(format!("reset to {}", args.sha))
    }

    #[tool(
        description = "Force-push the current branch to its remote in the bound repository, using \
                       --force-with-lease (refuses to clobber remote work that arrived after your \
                       last fetch). Rewrites the remote branch. Requires --allow-git-write AND \
                       --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn force_push(&self) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        crate::git::remote::git_push_core(&self.state, self.repo.clone(), false, true)
            .await
            .map_err(app_err)?;
        ok_text("force-pushed (with lease)")
    }

    #[tool(
        description = "Delete a branch on a remote (git push <remote> --delete) in the bound \
                       repository. The remote branch is removed. Refuses a GitDesktop \
                       agent-session branch (gd/session/*). Requires --allow-git-write AND \
                       --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_remote_branch(
        &self,
        Parameters(args): Parameters<DeleteRemoteBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        ensure_not_flag(&args.remote, "remote")?;
        ensure_not_flag(&args.name, "branch name")?;
        ensure_not_session_branch(&args.name)?;
        crate::git::branches::git_delete_remote_branch_core(
            &self.state,
            self.repo.clone(),
            args.remote.clone(),
            args.name.clone(),
        )
        .await
        .map_err(app_err)?;
        ok_text(format!("remote branch deleted: {}/{}", args.remote, args.name))
    }

    #[tool(
        description = "Drop a stash by index (0 = most recent; see list_stashes) in the bound \
                       repository — the stashed changes are LOST. Requires --allow-git-write AND \
                       --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn drop_stash(
        &self,
        Parameters(args): Parameters<StashIndexArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        crate::git::ops::git_stash_drop_core(&self.state, self.repo.clone(), args.index)
            .await
            .map_err(app_err)?;
        ok_text(format!("stash@{{{}}} dropped", args.index))
    }

    #[tool(
        description = "Delete a tag in the bound repository (local, and with `remote` also on \
                       origin). The tag is removed. Requires --allow-git-write AND \
                       --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_tag(
        &self,
        Parameters(args): Parameters<DeleteTagArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        ensure_not_flag(&args.name, "tag name")?;
        crate::git::ops::git_delete_tag_core(&self.state, self.repo.clone(), args.name.clone(), args.remote)
            .await
            .map_err(app_err)?;
        ok_text(format!("tag deleted: {}", args.name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::wrapper::Parameters;

    fn args_stage() -> StagePathsArgs {
        StagePathsArgs {
            paths: vec!["a.txt".into()],
        }
    }

    /// With ALL flags false, EVERY tool in this module that is gated must return its
    /// gate error before doing any work. Recoverable tools name --allow-git-write;
    /// destructive tools name --allow-git-write too (both flags missing). The two
    /// ungated reads (list_stashes, preview_merge) are intentionally NOT here — they
    /// have no gate. Params carry throwaway values — the gate fires first.
    #[tokio::test]
    async fn all_gated_tools_error_when_no_flags() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);

        macro_rules! assert_gated {
            ($call:expr, $flag:literal) => {{
                let err = $call.await.expect_err("expected the gate to fire");
                let msg = err.to_string();
                assert!(msg.contains($flag), "gate error should name {}, got: {msg}", $flag);
            }};
        }

        // Recoverable tools: gated on --allow-git-write.
        assert_gated!(h.stage_files(Parameters(args_stage())), "--allow-git-write");
        assert_gated!(h.unstage_files(Parameters(args_stage())), "--allow-git-write");
        assert_gated!(
            h.commit(Parameters(CommitArgs { message: "m".into(), body: None, amend: false })),
            "--allow-git-write"
        );
        assert_gated!(h.undo_last_commit(), "--allow-git-write");
        assert_gated!(
            h.create_branch(Parameters(CreateBranchArgs { name: "b".into(), checkout: false, from: None })),
            "--allow-git-write"
        );
        assert_gated!(
            h.checkout_branch(Parameters(BranchNameArgs { name: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.rename_branch(Parameters(RenameBranchArgs { from: "a".into(), to: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(h.push(Parameters(PushArgs { set_upstream: false })), "--allow-git-write");
        assert_gated!(h.pull(Parameters(PullArgs { mode: None })), "--allow-git-write");
        assert_gated!(h.fetch(), "--allow-git-write");
        assert_gated!(h.stash_push(Parameters(StashPushArgs { paths: vec![] })), "--allow-git-write");
        assert_gated!(h.stash_pop(), "--allow-git-write");
        assert_gated!(h.stash_apply(Parameters(StashApplyArgs { index: 0 })), "--allow-git-write");
        assert_gated!(
            h.merge_branch(Parameters(MergeBranchArgs {
                branch: "b".into(), squash: false, no_ff: false, strategy: None
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.rebase_branch(Parameters(RebaseBranchArgs { onto: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(h.revert_commit(Parameters(ShaArgs { sha: "abc".into() })), "--allow-git-write");
        assert_gated!(h.cherry_pick(Parameters(ShaArgs { sha: "abc".into() })), "--allow-git-write");
        assert_gated!(
            h.create_tag(Parameters(CreateTagArgs { name: "v1".into(), at: "abc".into() })),
            "--allow-git-write"
        );
        assert_gated!(h.push_tag(Parameters(TagNameArgs { name: "v1".into() })), "--allow-git-write");

        // Destructive tools: both flags missing, so --allow-git-write is named.
        assert_gated!(
            h.delete_branch(Parameters(BranchNameArgs { name: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.discard_changes(Parameters(DiscardChangesArgs { paths: vec![] })),
            "--allow-git-write"
        );
        assert_gated!(h.discard_all_changes(), "--allow-git-write");
        assert_gated!(h.reset_to_commit(Parameters(ShaArgs { sha: "abc".into() })), "--allow-git-write");
        assert_gated!(h.force_push(), "--allow-git-write");
        assert_gated!(
            h.delete_remote_branch(Parameters(DeleteRemoteBranchArgs { remote: "origin".into(), name: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(h.drop_stash(Parameters(StashIndexArgs { index: 0 })), "--allow-git-write");
        assert_gated!(
            h.delete_tag(Parameters(DeleteTagArgs { name: "v1".into(), remote: false })),
            "--allow-git-write"
        );
    }

    /// git_write=true, destructive=false: EVERY destructive tool must still error,
    /// naming the missing --allow-destructive flag.
    #[tokio::test]
    async fn destructive_tools_error_when_only_git_write() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, false);

        macro_rules! assert_destructive_gated {
            ($call:expr) => {{
                let err = $call.await.expect_err("expected the destructive gate to fire");
                let msg = err.to_string();
                assert!(
                    msg.contains("--allow-destructive"),
                    "destructive gate error should name --allow-destructive, got: {msg}"
                );
            }};
        }

        assert_destructive_gated!(h.delete_branch(Parameters(BranchNameArgs { name: "b".into() })));
        assert_destructive_gated!(h.discard_changes(Parameters(DiscardChangesArgs { paths: vec![] })));
        assert_destructive_gated!(h.discard_all_changes());
        assert_destructive_gated!(h.reset_to_commit(Parameters(ShaArgs { sha: "abc".into() })));
        assert_destructive_gated!(h.force_push());
        assert_destructive_gated!(h.delete_remote_branch(Parameters(DeleteRemoteBranchArgs {
            remote: "origin".into(),
            name: "b".into(),
        })));
        assert_destructive_gated!(h.drop_stash(Parameters(StashIndexArgs { index: 0 })));
        assert_destructive_gated!(h.delete_tag(Parameters(DeleteTagArgs { name: "v1".into(), remote: false })));
    }

    /// destructive=true, git_write=false: the destructive tools must error naming the
    /// missing --allow-git-write (destructive alone grants nothing).
    #[tokio::test]
    async fn destructive_tools_error_when_only_destructive() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, true);

        let err = h
            .discard_all_changes()
            .await
            .expect_err("expected the gate to fire");
        let msg = err.to_string();
        assert!(
            msg.contains("--allow-git-write"),
            "gate error should name --allow-git-write, got: {msg}"
        );

        let err = h
            .delete_branch(Parameters(BranchNameArgs { name: "b".into() }))
            .await
            .expect_err("expected the gate to fire");
        assert!(err.to_string().contains("--allow-git-write"));
    }

    /// The gd/session/* refusal is pure string logic: session branches are refused,
    /// ordinary branches pass. (No real repo needed.)
    #[test]
    fn session_branch_guard_refuses_reserved_prefix() {
        assert!(ensure_not_session_branch("gd/session/abc123").is_err());
        assert!(ensure_not_session_branch("gd/session/").is_err());
        assert!(ensure_not_session_branch("feature/x").is_ok());
        assert!(ensure_not_session_branch("main").is_ok());
        // A branch that merely CONTAINS the token but doesn't start with it is fine.
        assert!(ensure_not_session_branch("wip/gd/session/x").is_ok());
    }

    /// create_branch (name) and rename_branch (to) must also refuse the gd/session/*
    /// namespace, so an agent can't create an invisible (UI-filtered) branch. The guard
    /// fires before any repo access, so no real repo is needed.
    #[tokio::test]
    async fn session_branch_guard_refuses_creating_and_renaming_into_namespace() {
        // git_write enabled (4th positional), everything else off.
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, false);

        let err = h
            .create_branch(Parameters(CreateBranchArgs {
                name: "gd/session/fake".into(),
                checkout: false,
                from: None,
            }))
            .await
            .expect_err("create_branch into gd/session/* must be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "expected the session-branch refusal, got: {err}"
        );

        let err = h
            .rename_branch(Parameters(RenameBranchArgs {
                from: "feature/x".into(),
                to: "gd/session/fake".into(),
            }))
            .await
            .expect_err("rename_branch into gd/session/* must be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "expected the session-branch refusal, got: {err}"
        );
    }

    /// The session-branch guard is wired into the branch-mutating tools even when the
    /// gate is open: a gd/session/* target is refused with the actionable message
    /// BEFORE any git runs. Covers delete_branch, rename_branch, delete_remote_branch,
    /// and checkout_branch.
    #[tokio::test]
    async fn branch_tools_refuse_session_branch_when_gated_open() {
        // Fully-permissioned handler so the gate is open and the session guard is the
        // thing under test.
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, true);

        let err = h
            .delete_branch(Parameters(BranchNameArgs {
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session branch delete should be refused");
        assert!(err.to_string().contains("agent-session branch"), "got: {err}");

        let err = h
            .rename_branch(Parameters(RenameBranchArgs {
                from: "gd/session/xyz".into(),
                to: "renamed".into(),
            }))
            .await
            .expect_err("session branch rename should be refused");
        assert!(err.to_string().contains("agent-session branch"), "got: {err}");

        let err = h
            .delete_remote_branch(Parameters(DeleteRemoteBranchArgs {
                remote: "origin".into(),
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session remote branch delete should be refused");
        assert!(err.to_string().contains("agent-session branch"), "got: {err}");

        let err = h
            .checkout_branch(Parameters(BranchNameArgs {
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session branch checkout should be refused");
        assert!(err.to_string().contains("agent-session branch"), "got: {err}");
    }
}
