//! Local-git WRITE tools (opt-in via `--allow-git-write`; destructive ops also need
//! `--allow-destructive`).
//!
//! Three groups: RECOVERABLE mutations gated on [`GitDesktopMcp::ensure_git_write`];
//! two UNGATED reads (list_stashes, preview_merge); and DESTRUCTIVE mutations gated on
//! [`GitDesktopMcp::ensure_destructive`], which requires BOTH flags.
//!
//! The `destructive_hint` annotation and that gate answer DIFFERENT questions and don't
//! track 1:1: the hint states what a call can silently discard, the ladder is the
//! server-side capability the operator granted. `merge_branch` is hint-destructive
//! without being ladder-destructive — its "ours"/"theirs" strategy drops one side of
//! every conflicting hunk, across files the caller never named.
//!
//! Mutations delegate to the matching `git_*_core`, which routes through `self.state`'s
//! per-repo lock (`run_git_mutating`) so concurrent MCP calls don't fight over
//! `.git/index.lock`. User-supplied branch/rev/path strings go through
//! [`ensure_not_flag`] before reaching git argv, and the branch-TARGETING tools —
//! create_branch (name), checkout_branch, rename_branch (from AND to), push (branch),
//! delete_branch, delete_remote_branch — additionally refuse `gd/session/*`: mutating or
//! publishing one breaks session Resume, and creating or renaming INTO that namespace
//! yields an invisible (UI-filtered) branch. (merge_branch / rebase_branch take a branch
//! name but only READ it, so they carry no such guard.)

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_not_flag, json_result, GitDesktopMcp, SESSION_BRANCH_PREFIX};
use crate::error::AppError;
use crate::git::pull_guard::{DroppedCommit, WouldDrop};
use crate::git::remote::PushGuard;

/// Refuses a branch name that names a GitDesktop agent-session branch, with an
/// actionable error. Pure string logic (no repo access) so it's unit-testable.
fn ensure_not_session_branch(name: &str) -> Result<(), McpError> {
    if name.starts_with(SESSION_BRANCH_PREFIX) {
        return Err(McpError::invalid_params(
            format!(
                "\"{name}\" is a GitDesktop agent-session branch; refusing to operate on it \
                 (breaks session Resume)."
            ),
            None,
        ));
    }
    Ok(())
}

/// Emits a plain-text success result for the (many) core commands that return `()`.
fn ok_text(msg: impl Into<String>) -> Result<CallToolResult, McpError> {
    Ok(CallToolResult::success(vec![ContentBlock::text(msg.into())]))
}

// ---- Parameter structs ----------------------------------------------------

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StagePathsArgs {
    /// Repo-relative paths to stage (or unstage). Files and directories are
    /// matched exactly. Set `literal: false` to pass git pathspecs/globs instead.
    paths: Vec<String>,
    /// Whether each entry names one exact file or directory (the default). Set
    /// false only to pass a git pathspec or glob such as `*.log`.
    #[serde(default = "default_true")]
    literal: bool,
}

/// `serde(default)` yields `false` for a bool; these flags default to ON.
fn default_true() -> bool {
    true
}

/// Tool-supplied paths as git pathspecs, honoring the tool's `literal` flag.
///
/// Defaults to literal because the dominant caller shape is "act on the concrete
/// paths repo_status just listed", where a raw `src/app/[slug]/page.tsx` also
/// matches its glob-siblings — silently, with no way to tell from the result.
/// `:(literal)` still recurses directories, so only a deliberate glob needs
/// `literal: false`. Getting that wrong fails loudly for stage/unstage
/// ("did not match any files", measured exit 128) — but NOT for `stash_push`:
/// `git stash push` with a matched-nothing pathspec no-ops at exit 0
/// ("No local changes to save", measured), so `git_stash_paths_core` reports
/// whether an entry was created and the tool answers "nothing was stashed"
/// rather than letting the exit code speak.
///
/// Used by `stage_files`, `unstage_files` and `stash_push` — not staging alone:
/// `stash_push` sweeps the files it matches OUT of the working tree, so an
/// over-match there costs a sibling's uncommitted work.
///
/// `discard_changes` deliberately does NOT route through this. It hands paths to
/// `git_discard_paths_core`, which literalizes the tracked half itself and must
/// keep the untracked half a plain filesystem name for `trash::delete`. Applying
/// this helper there would corrupt that half.
fn literal_pathspecs(paths: Vec<String>, literal: bool) -> Vec<String> {
    if !literal {
        return paths;
    }
    paths
        .into_iter()
        .map(|p| crate::git::pathspec::literal(&p))
        .collect()
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
    /// Create the branch with no upstream (git --no-track). Recommended when
    /// `from` is a remote-tracking ref (e.g. origin/epic/x) and this branch is a
    /// NEW line of work: without it the branch tracks that ref, and a later push
    /// would fast-forward the tracked branch instead of publishing under this
    /// branch's own name. Defaults to false (git's normal tracking behavior).
    // The struct has no `rename_all`, so the wire name is spelled explicitly to
    // match the documented `noTrack` flag (and the Tauri UI's camelCase key).
    #[serde(default, rename = "noTrack")]
    no_track: bool,
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
    /// Local branch to push instead of the current one (pushed by name — no
    /// checkout, no working-tree changes; an untracked branch is published with
    /// `-u origin <branch>`). Defaults to the current branch.
    branch: Option<String>,
    /// Remote to push to; defaults to the branch's own upstream remote (or origin
    /// when publishing). Requires branch.
    // Single word, so camelCase == snake_case — no rename attr needed.
    #[serde(default)]
    remote: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PullArgs {
    /// Reconcile a diverged branch: "merge" (a merge commit) or "rebase" (replay on
    /// top). Anything else (including omitted) stays the safe fast-forward-only pull.
    #[serde(default)]
    mode: Option<String>,
    /// Answer to the rebase guard's keep-or-drop question: "keep" or "drop".
    /// Only acted on when a rebase-mode pull's fork-point guard fires — but it is
    /// always validated, and "drop" always requires --allow-destructive, even on a
    /// pull the guard never reaches. Omit it on the first call: the guard's report
    /// names the commits at stake and spells out the re-call. Must travel with
    /// `expectedDropShas`.
    #[serde(default)]
    decision: Option<String>,
    /// The commits the answer is answering about — the 7-character shas the guard's
    /// report printed (full shas are accepted too). Required whenever `decision` is
    /// set, and checked against the guard's fresh verdict before anything runs: an
    /// upstream that rewrote again in between yields a different set, and the answer
    /// is refused with the new report rather than applied to commits nobody saw.
    // The struct has no `rename_all`, so the wire name is spelled explicitly to match
    // the documented `expectedDropShas` field (as `noTrack` is on CreateBranchArgs).
    #[serde(default, rename = "expectedDropShas")]
    expected_drop_shas: Option<Vec<String>>,
}

/// The only two answers the guard's report offers. Checked at the tool boundary so a
/// misspelled one is refused rather than silently ignored on the (far more common)
/// pull where the guard never fires. Pure string logic, like the session-branch guard.
fn ensure_pull_decision(decision: &str) -> Result<(), McpError> {
    if decision != "keep" && decision != "drop" {
        return Err(McpError::invalid_params(
            format!("unknown pull decision {decision:?}; the rebase guard takes \"keep\" or \"drop\""),
            None,
        ));
    }
    Ok(())
}

/// The echoed shas an answered pull must carry, or an error naming the re-call. An
/// empty list counts as missing: the guard only ever fires with commits to name, so
/// no report can produce one, and the recipe is the more useful thing to say back.
fn ensure_expected_drop_shas(shas: Option<Vec<String>>) -> Result<Vec<String>, McpError> {
    let shas = shas.filter(|s| !s.is_empty()).ok_or_else(|| {
        McpError::invalid_params(
            "an answered pull must name the commits it is answering about: pass \
             expectedDropShas, the sha list from the report you are answering — e.g. pull \
             {\"mode\": \"rebase\", \"decision\": \"keep\", \"expectedDropShas\": [\"1111111\"]}.",
            None,
        )
    })?;
    for sha in &shas {
        // Non-hex is refused here rather than left to the comparison, where it could
        // only ever miss — and a miss reports that the UPSTREAM moved, blaming the
        // wrong thing for what is a malformed argument.
        if !(4..=40).contains(&sha.len()) || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(McpError::invalid_params(
                format!(
                    "expectedDropShas entry {sha:?} is not a commit sha (4 to 40 hex characters)"
                ),
                None,
            ));
        }
    }
    Ok(shas)
}

/// Whether the caller's echoed shas still describe the set this guard run found.
///
/// Prefix matching, because the report prints 7 characters. Each prefix must land on
/// its OWN fresh commit and on only one of them: a set that grew, shrank, or was
/// replaced can then never pass by matching a survivor twice, which is the whole
/// point — the answer authorized THAT list, not this one.
fn echo_matches(expected: &[String], fresh: &[DroppedCommit]) -> bool {
    if expected.len() != fresh.len() {
        return false;
    }
    let mut claimed = vec![false; fresh.len()];
    for prefix in expected {
        let prefix = prefix.to_ascii_lowercase();
        let mut hits = fresh
            .iter()
            .enumerate()
            .filter(|(_, c)| c.sha.to_ascii_lowercase().starts_with(&prefix));
        let Some((idx, _)) = hits.next() else {
            return false;
        };
        if hits.next().is_some() || claimed[idx] {
            return false;
        }
        claimed[idx] = true;
    }
    true
}

/// The commit's sha as the report prints it. The full one stays a `get` away in case
/// a sha is somehow shorter than 7 characters.
fn short_sha(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// The re-call the guard's report ends on, carrying the shas to echo back. A literal
/// argument object rather than prose: the caller is an agent, the second call has to
/// name `mode` again or it drops back to a fast-forward-only pull that never reaches
/// the guard, and the echo is what ties the answer to this exact list.
fn pull_decision_recipe(shorts: &[&str]) -> String {
    let echo = shorts
        .iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Call pull again with your answer, echoing those shas:\n  \
         pull {{\"mode\": \"rebase\", \"decision\": \"keep\", \"expectedDropShas\": [{echo}]}}\n  \
         pull {{\"mode\": \"rebase\", \"decision\": \"drop\", \"expectedDropShas\": [{echo}]}}    \
         (drop also requires --allow-destructive)"
    )
}

/// The guard's refusal as tool text: the commits at stake, what each answer does to
/// them, and the exact re-call. A SUCCESS result rather than an MCP error — the
/// question IS this call's output, and an error reads as a pull that failed.
fn would_drop_report(drop: &WouldDrop) -> String {
    let message = &drop.message;
    let upstream = &drop.upstream;
    let shorts = drop
        .commits
        .iter()
        .map(|c| short_sha(&c.sha))
        .collect::<Vec<_>>();
    let commits = drop
        .commits
        .iter()
        .zip(&shorts)
        .map(|(c, short)| format!("  {short} {} — {}", c.subject, c.author))
        .collect::<Vec<_>>()
        .join("\n");
    let recipe = pull_decision_recipe(&shorts);
    format!(
        "{message}\n\n{commits}\n\n\
         Your branch and working tree are untouched — only the fetch this check needed has \
         run.\n\n\
         keep: the commits are replayed on top of {upstream}'s new tip, so the branch keeps \
         them (an ordinary rebase).\n\
         drop: the commits leave the branch, replaced by the rewrite {upstream} already \
         published.\n\n\
         {recipe}"
    )
}

/// The refusal when the echoed shas no longer describe what the guard just found.
/// Leads with why the answer went unused, then hands over the current report — an
/// agent that re-reads the list and re-echoes is exactly the loop this wants.
fn stale_echo_report(drop: &WouldDrop) -> String {
    format!(
        "The at-risk commits changed since the report you answered, so your answer was not \
         applied.\n\n{}",
        would_drop_report(drop)
    )
}

/// The decided pull's success text, naming what the answer did to the commits.
fn decided_pull_text(decision: &str, drop: &WouldDrop) -> String {
    let count = drop.commits.len();
    let noun = if count == 1 { "commit" } else { "commits" };
    let upstream = &drop.upstream;
    if decision == "keep" {
        format!(
            "pulled with rebase; kept {count} {noun} {upstream} no longer contains (replayed on \
             top of its new tip)"
        )
    } else {
        format!(
            "pulled with rebase; dropped {count} {noun} {upstream} replaced (recorded in \
             Operation history)"
        )
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct StashPushArgs {
    /// Optional repo-relative paths to stash. When omitted/empty, stashes ALL changes
    /// (including untracked). With `paths`, only those files are stashed; every other
    /// file's staged and unstaged changes are left exactly as they were. Files and
    /// directories are matched exactly; set `literal: false` to pass a pathspec/glob.
    #[serde(default)]
    paths: Vec<String>,
    /// Whether each entry names one exact file or directory (the default). Set
    /// false only to pass a git pathspec or glob such as `*.log`.
    #[serde(default = "default_true")]
    literal: bool,
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
        description = "Stage files (git add) in the bound repository. Repo-relative paths and \
                       directories match exactly; set literal=false to pass a pathspec or glob. \
                       Requires --allow-git-write.",
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
        let paths = literal_pathspecs(args.paths, args.literal);
        crate::git::stage::git_stage_core(&self.state, self.repo.clone(), paths)
            .await
            .map_err(app_err)?;
        ok_text("staged")
    }

    #[tool(
        description = "Unstage files (restore from the index; drop from the index in an empty \
                       repo) in the bound repository. Repo-relative paths and directories match \
                       exactly; set literal=false to pass a pathspec or glob. Requires \
                       --allow-git-write.",
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
        let paths = literal_pathspecs(args.paths, args.literal);
        crate::git::stage::git_unstage_core(&self.state, self.repo.clone(), paths)
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
        // A session that predates canonicalization journaled its paused picks under the
        // RAW `--repo` spelling, which `git_commit_core`'s close — keyed on the canonical
        // path — cannot reach. Mirror that close's gate here for the second spelling,
        // reading the marker BEFORE the commit clears it. Skipped when the two already
        // resolve to one journal key, which is what keeps this from closing a second
        // paused record under the same key.
        let legacy_repo = self
            .raw_repo
            .clone()
            .filter(|raw| !crate::oplog::same_repo(raw, &self.repo));
        let was_picking =
            legacy_repo.is_some() && crate::git::ops::cherry_pick_marker_present(&self.repo);
        let result = crate::git::commit::git_commit_core(
            &self.state,
            self.repo.clone(),
            args.message,
            args.body,
            args.amend,
        )
        .await
        .map_err(app_err)?;
        if was_picking && !crate::git::ops::cherry_pick_marker_present(&self.repo) {
            if let Some(raw) = legacy_repo {
                crate::oplog::close_paused_pick(&raw, crate::oplog::PausedOutcome::Continued).await;
            }
        }
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
                       starting from a given branch/tag/commit (defaults to HEAD), optionally with \
                       no upstream (noTrack — recommended when starting a new branch from a \
                       remote-tracking ref). Refuses to create a GitDesktop agent-session branch \
                       (gd/session/*). Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn create_branch(
        &self,
        Parameters(args): Parameters<CreateBranchArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        ensure_not_flag(&args.name, "branch name")?;
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
            args.no_track,
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
        crate::git::branches::git_checkout_branch_core(
            &self.state,
            self.repo.clone(),
            args.name.clone(),
        )
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
        description = "Push the current branch (default) or a named local `branch` in the bound \
                       repository — pushing a named branch never switches to it or touches the \
                       working tree; an untracked branch is published with `-u`. A named branch \
                       targets its own upstream remote (or origin when publishing) unless `remote` \
                       overrides it. Uses git's native credential flow. Never force-pushes — use \
                       force_push (destructive) for that. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn push(
        &self,
        Parameters(args): Parameters<PushArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        if let Some(b) = &args.branch {
            ensure_not_flag(b, "branch name")?;
            // Pushing a gd/session/* branch would publish a branch every UI surface hides.
            ensure_not_session_branch(b)?;
        }
        if let Some(r) = &args.remote {
            ensure_not_flag(r, "remote")?;
        }
        crate::git::remote::git_push_core(
            &self.state,
            self.repo.clone(),
            args.set_upstream,
            false,
            args.branch.clone(),
            args.remote.clone(),
            // The MCP push tool has no cross-name destination — the local branch's
            // own name is always the target.
            None,
        )
        .await
        .map_err(app_err)?;
        ok_text("pushed")
    }

    #[tool(
        description = "Pull from the current branch's upstream in the bound repository. `mode` \
                       reconciles a diverged branch: \"merge\" or \"rebase\"; omitted stays \
                       fast-forward-only (the safe default). A rebase-mode pull is guarded: when \
                       the upstream's history was rewritten past commits still on your branch \
                       (git's fork-point rule would replay those away with no conflict and no \
                       warning), the pull stops after fetching, without touching your branch or \
                       working tree, and returns them, plus the re-call that keeps or drops \
                       them. That re-call passes `decision` together with `expectedDropShas` \
                       (the sha list from the report you are answering), and is refused with a \
                       fresh report if the at-risk set changed in between; \"drop\" additionally \
                       requires --allow-destructive. Conflicts surface in the normal conflict \
                       state. Requires --allow-git-write.",
        annotations(read_only_hint = false, destructive_hint = false)
    )]
    async fn pull(
        &self,
        Parameters(args): Parameters<PullArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.ensure_git_write()?;
        // The answer and the shas it answers about are validated as ONE thing, so no
        // later step has to hold "the echo is present because the decision was".
        let answer = match args.decision {
            Some(decision) => {
                ensure_pull_decision(&decision)?;
                // A decided drop rewrites commits off the branch, so the ladder is
                // checked here — before the pull runs — rather than after the guard
                // has already fetched on a call that can't be allowed to finish.
                if decision == "drop" {
                    self.ensure_destructive()?;
                }
                Some((decision, ensure_expected_drop_shas(args.expected_drop_shas)?))
            }
            None => None,
        };
        let mode = args.mode.unwrap_or_default();
        // Only a rebase-mode pull runs the guard at all, so only it can report that
        // the guard found nothing — the other modes never asked.
        let rebasing = mode == "rebase";
        let drop = match crate::git::remote::git_pull_core(&self.state, self.repo.clone(), mode)
            .await
        {
            Ok(()) => {
                return ok_text(match (&answer, rebasing) {
                    (None, _) => "pulled",
                    (Some(_), true) => {
                        "pulled — no decision was needed (the rebase guard found nothing at risk)"
                    }
                    (Some(_), false) => {
                        "pulled — this wasn't a rebase-mode pull, so the guard never ran and your \
                         answer was not used."
                    }
                })
            }
            Err(AppError::PullRebaseWouldDrop(drop)) => drop,
            Err(other) => return Err(app_err(other)),
        };
        let Some((decision, echoed)) = answer else {
            return ok_text(would_drop_report(&drop));
        };
        // The guard re-probed just now, so the answer is checked against THIS run's
        // verdict: an upstream that rewrote again since the report produces a
        // different set, and acting would spend consent given for other commits.
        if !echo_matches(&echoed, &drop.commits) {
            return ok_text(stale_echo_report(&drop));
        }
        // Every SHA comes from THIS guard run: re-resolving HEAD or the upstream
        // here would decide about a state the caller was never shown.
        crate::git::pull_guard::git_pull_rebase_decided_core(
            &self.state,
            self.repo.clone(),
            drop.branch.clone(),
            decision.clone(),
            drop.new_tip.clone(),
            drop.merge_base.clone(),
            drop.fork_point.clone(),
            drop.branch_tip.clone(),
        )
        .await
        .map_err(app_err)?;
        ok_text(decided_pull_text(&decision, &drop))
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
                       (including untracked). With `paths`, stashes only those files, leaving every \
                       other file's staged and unstaged changes exactly as they were; paths and \
                       directories match exactly, set literal=false to pass a pathspec or glob. \
                       Refused while conflicts are unresolved, or while a merge, rebase, \
                       cherry-pick or revert is in progress (finish or abort it first — \
                       retrying won't help). Requires --allow-git-write.",
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
            let paths = literal_pathspecs(args.paths, args.literal);
            let stashed = crate::git::ops::git_stash_paths_core(
                &self.state,
                self.repo.clone(),
                paths,
            )
            .await
            .map_err(app_err)?;
            if stashed {
                ok_text("stashed selected paths")
            } else {
                ok_text("no changes matched the given paths — nothing was stashed")
            }
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
        annotations(read_only_hint = false, destructive_hint = true)
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
        let created =
            crate::git::ops::git_cherry_pick_core(&self.state, self.repo.clone(), args.sha.clone())
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
        crate::git::branches::git_delete_branch_core(
            &self.state,
            self.repo.clone(),
            args.name.clone(),
        )
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
        crate::git::ops::git_reset_core(&self.state, self.repo.clone(), args.sha.clone(), None)
            .await
            .map_err(app_err)?;
        ok_text(format!("reset to {}", args.sha))
    }

    #[tool(
        description = "Force-push the current branch to its remote in the bound repository, using \
                       --force-with-lease --force-if-includes (refuses to overwrite remote work \
                       that isn't already incorporated into your local branch, even when a \
                       background fetch has updated the remote-tracking ref; on a Git older than \
                       2.30, or a branch with no reflog for the check to read, the push falls back \
                       to the lease alone). Rewrites the remote branch. Requires --allow-git-write \
                       AND --allow-destructive.",
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn force_push(&self) -> Result<CallToolResult, McpError> {
        self.ensure_destructive()?;
        let guard = crate::git::remote::git_push_core(
            &self.state,
            self.repo.clone(),
            false,
            true,
            None,
            None,
            None,
        )
        .await
        .map_err(app_err)?;
        // The tool's result text names the guarantee the push ACTUALLY ran under —
        // a static "with lease + if-includes" overclaims on either fallback.
        ok_text(match guard {
            PushGuard::LeaseAndIncludes => "force-pushed (with lease + if-includes)",
            PushGuard::LeaseOnlyOldGit => {
                "force-pushed (with lease; this Git predates --force-if-includes)"
            }
            PushGuard::LeaseOnlyNoReflog => {
                "force-pushed (with lease; the branch has no reflog for --force-if-includes to \
                 check)"
            }
        })
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
        ok_text(format!(
            "remote branch deleted: {}/{}",
            args.remote, args.name
        ))
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
        crate::git::ops::git_delete_tag_core(
            &self.state,
            self.repo.clone(),
            args.name.clone(),
            args.remote,
        )
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
            literal: true,
        }
    }

    #[test]
    fn literal_pathspecs_literalizes_only_when_asked() {
        let paths = || vec!["src/app/[slug]/page.tsx".to_string(), "*.log".to_string()];
        assert_eq!(
            literal_pathspecs(paths(), true),
            vec![":(literal)src/app/[slug]/page.tsx", ":(literal)*.log"]
        );
        // literal:false is the escape hatch for a caller that means the glob.
        assert_eq!(literal_pathspecs(paths(), false), paths());
    }

    /// With ALL flags false, every gated tool must error before doing work. Destructive
    /// tools name --allow-git-write (both flags missing). The two ungated reads
    /// (list_stashes, preview_merge) are deliberately absent. Params are throwaway.
    #[tokio::test]
    async fn all_gated_tools_error_when_no_flags() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, false, false);

        macro_rules! assert_gated {
            ($call:expr, $flag:literal) => {{
                let err = $call.await.expect_err("expected the gate to fire");
                let msg = err.to_string();
                assert!(
                    msg.contains($flag),
                    "gate error should name {}, got: {msg}",
                    $flag
                );
            }};
        }

        assert_gated!(h.stage_files(Parameters(args_stage())), "--allow-git-write");
        assert_gated!(
            h.unstage_files(Parameters(args_stage())),
            "--allow-git-write"
        );
        assert_gated!(
            h.commit(Parameters(CommitArgs {
                message: "m".into(),
                body: None,
                amend: false
            })),
            "--allow-git-write"
        );
        assert_gated!(h.undo_last_commit(), "--allow-git-write");
        assert_gated!(
            h.create_branch(Parameters(CreateBranchArgs {
                name: "b".into(),
                checkout: false,
                from: None,
                no_track: false
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.checkout_branch(Parameters(BranchNameArgs { name: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.rename_branch(Parameters(RenameBranchArgs {
                from: "a".into(),
                to: "b".into()
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.push(Parameters(PushArgs {
                set_upstream: false,
                branch: None,
                remote: None
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.pull(Parameters(PullArgs {
                mode: None,
                decision: None,
                expected_drop_shas: None
            })),
            "--allow-git-write"
        );
        // A decided drop is destructive, and with BOTH flags missing the git-write
        // gate is still the first one it meets.
        assert_gated!(
            h.pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: None
            })),
            "--allow-git-write"
        );
        assert_gated!(h.fetch(), "--allow-git-write");
        assert_gated!(
            h.stash_push(Parameters(StashPushArgs { paths: vec![], literal: true })),
            "--allow-git-write"
        );
        assert_gated!(h.stash_pop(), "--allow-git-write");
        assert_gated!(
            h.stash_apply(Parameters(StashApplyArgs { index: 0 })),
            "--allow-git-write"
        );
        assert_gated!(
            h.merge_branch(Parameters(MergeBranchArgs {
                branch: "b".into(),
                squash: false,
                no_ff: false,
                strategy: None
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.rebase_branch(Parameters(RebaseBranchArgs { onto: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.revert_commit(Parameters(ShaArgs { sha: "abc".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.cherry_pick(Parameters(ShaArgs { sha: "abc".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.create_tag(Parameters(CreateTagArgs {
                name: "v1".into(),
                at: "abc".into()
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.push_tag(Parameters(TagNameArgs { name: "v1".into() })),
            "--allow-git-write"
        );

        // Destructive tools: with BOTH flags missing, --allow-git-write is the one named.
        assert_gated!(
            h.delete_branch(Parameters(BranchNameArgs { name: "b".into() })),
            "--allow-git-write"
        );
        assert_gated!(
            h.discard_changes(Parameters(DiscardChangesArgs { paths: vec![] })),
            "--allow-git-write"
        );
        assert_gated!(h.discard_all_changes(), "--allow-git-write");
        assert_gated!(
            h.reset_to_commit(Parameters(ShaArgs { sha: "abc".into() })),
            "--allow-git-write"
        );
        assert_gated!(h.force_push(), "--allow-git-write");
        assert_gated!(
            h.delete_remote_branch(Parameters(DeleteRemoteBranchArgs {
                remote: "origin".into(),
                name: "b".into()
            })),
            "--allow-git-write"
        );
        assert_gated!(
            h.drop_stash(Parameters(StashIndexArgs { index: 0 })),
            "--allow-git-write"
        );
        assert_gated!(
            h.delete_tag(Parameters(DeleteTagArgs {
                name: "v1".into(),
                remote: false
            })),
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
                let err = $call
                    .await
                    .expect_err("expected the destructive gate to fire");
                let msg = err.to_string();
                assert!(
                    msg.contains("--allow-destructive"),
                    "destructive gate error should name --allow-destructive, got: {msg}"
                );
            }};
        }

        assert_destructive_gated!(h.delete_branch(Parameters(BranchNameArgs { name: "b".into() })));
        assert_destructive_gated!(
            h.discard_changes(Parameters(DiscardChangesArgs { paths: vec![] }))
        );
        assert_destructive_gated!(h.discard_all_changes());
        assert_destructive_gated!(h.reset_to_commit(Parameters(ShaArgs { sha: "abc".into() })));
        assert_destructive_gated!(h.force_push());
        // `pull` is destructive only for a decided DROP, and the gate fires before
        // the pull runs — this handler is bound to a path that isn't a repo at all.
        assert_destructive_gated!(h.pull(Parameters(PullArgs {
            mode: Some("rebase".into()),
            decision: Some("drop".into()),
            expected_drop_shas: None,
        })));
        assert_destructive_gated!(h.delete_remote_branch(Parameters(DeleteRemoteBranchArgs {
            remote: "origin".into(),
            name: "b".into(),
        })));
        assert_destructive_gated!(h.drop_stash(Parameters(StashIndexArgs { index: 0 })));
        assert_destructive_gated!(h.delete_tag(Parameters(DeleteTagArgs {
            name: "v1".into(),
            remote: false
        })));
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

    /// create_branch (name) and rename_branch (to) must refuse the gd/session/* namespace
    /// so an agent can't create an invisible branch. The guard fires before any repo access.
    #[tokio::test]
    async fn session_branch_guard_refuses_creating_and_renaming_into_namespace() {
        // git_write enabled (4th positional), everything else off.
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, false);

        let err = h
            .create_branch(Parameters(CreateBranchArgs {
                name: "gd/session/fake".into(),
                checkout: false,
                from: None,
                no_track: false,
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

    /// `noTrack` is optional on the wire (#[serde(default)]): absent → false so
    /// existing agents keep git's normal tracking, and an explicit true opts into
    /// --no-track. Guards the default that keeps MCP behavior byte-identical.
    #[test]
    fn create_branch_args_no_track_defaults_false_and_parses_true() {
        let absent: CreateBranchArgs =
            serde_json::from_value(serde_json::json!({ "name": "b" })).unwrap();
        assert!(!absent.no_track);

        let explicit: CreateBranchArgs = serde_json::from_value(
            serde_json::json!({ "name": "b", "from": "origin/epic/x", "noTrack": true }),
        )
        .unwrap();
        assert!(explicit.no_track);
    }

    /// `remote` is optional on the wire (#[serde(default)]): absent → None so a
    /// bare `push {branch}` keeps resolving to the branch's own upstream remote,
    /// and an explicit value parses through. Single word, so no rename attr.
    #[test]
    fn push_args_remote_defaults_none_and_parses_value() {
        let absent: PushArgs = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(absent.remote, None);

        let explicit: PushArgs =
            serde_json::from_value(serde_json::json!({ "branch": "feature", "remote": "upstream" }))
                .unwrap();
        assert_eq!(explicit.remote.as_deref(), Some("upstream"));
    }

    /// `decision` is optional on the wire (#[serde(default)]): absent → None, so an
    /// existing agent's `pull {mode}` keeps behaving exactly as before.
    #[test]
    fn pull_args_decision_defaults_none_and_parses_value() {
        let absent: PullArgs = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(absent.decision, None);
        assert_eq!(absent.expected_drop_shas, None);

        let explicit: PullArgs = serde_json::from_value(serde_json::json!({
            "mode": "rebase",
            "decision": "keep",
            "expectedDropShas": ["1111111", "2222222"],
        }))
        .unwrap();
        assert_eq!(explicit.decision.as_deref(), Some("keep"));
        assert_eq!(
            explicit.expected_drop_shas,
            Some(vec!["1111111".to_string(), "2222222".to_string()]),
            "the wire name is camelCase, as the recipe prints it"
        );
    }

    /// Only the two words the report offers decide anything — a near-miss is refused
    /// rather than ignored, which on a non-firing pull would look like it worked.
    #[test]
    fn pull_decision_guard_takes_only_keep_and_drop() {
        assert!(ensure_pull_decision("keep").is_ok());
        assert!(ensure_pull_decision("drop").is_ok());
        for bad in ["", "Keep", "keep ", "kepe", "vaporize"] {
            let err = ensure_pull_decision(bad).expect_err("a near-miss decides nothing");
            assert!(err.to_string().contains("keep"), "{bad:?} → {err}");
        }
    }

    /// The report an agent acts on: the count and upstream, one line per commit, both
    /// faces of the question, and the exact re-call. Pure string shaping, so it is
    /// pinned here rather than inferred from a fixture's SHAs.
    #[test]
    fn would_drop_report_names_the_commits_and_the_recall() {
        use crate::git::pull_guard::{DroppedCommit, WouldDrop};

        let report = would_drop_report(&WouldDrop {
            message: "Pulling with rebase would drop 2 commits that origin/main no longer contains."
                .into(),
            branch: "main".into(),
            upstream: "origin/main".into(),
            branch_tip: "1111111111111111111111111111111111111111".into(),
            new_tip: "3333333333333333333333333333333333333333".into(),
            merge_base: "4444444444444444444444444444444444444444".into(),
            fork_point: "1111111111111111111111111111111111111111".into(),
            commits: vec![
                DroppedCommit {
                    sha: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                    subject: "V the victim".into(),
                    author: "Ada".into(),
                    author_date: "2026-08-28T23:37:38-04:00".into(),
                },
                DroppedCommit {
                    sha: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                    subject: "also doomed".into(),
                    author: "Bob".into(),
                    author_date: "2026-08-27T10:00:00+00:00".into(),
                },
            ],
        });

        assert_eq!(
            report,
            "Pulling with rebase would drop 2 commits that origin/main no longer contains.\n\
             \n\
             \x20 1111111 V the victim — Ada\n\
             \x20 2222222 also doomed — Bob\n\
             \n\
             Your branch and working tree are untouched — only the fetch this check needed has run.\n\
             \n\
             keep: the commits are replayed on top of origin/main's new tip, so the branch keeps them (an ordinary rebase).\n\
             drop: the commits leave the branch, replaced by the rewrite origin/main already published.\n\
             \n\
             Call pull again with your answer, echoing those shas:\n\
             \x20 pull {\"mode\": \"rebase\", \"decision\": \"keep\", \"expectedDropShas\": [\"1111111\", \"2222222\"]}\n\
             \x20 pull {\"mode\": \"rebase\", \"decision\": \"drop\", \"expectedDropShas\": [\"1111111\", \"2222222\"]}    (drop also requires --allow-destructive)"
        );
    }

    /// The echo is a bijection onto the fresh set: same count, each prefix landing on
    /// its own commit. The arms below are the ones a real upstream can produce
    /// between a report and its answer, plus the two a hand-written echo can.
    #[test]
    fn echo_matches_only_a_one_to_one_prefix_mapping() {
        let commit = |sha: &str| DroppedCommit {
            sha: sha.into(),
            subject: "s".into(),
            author: "a".into(),
            author_date: "2026-08-28T23:37:38-04:00".into(),
        };
        let fresh = vec![commit("1111111aaaa"), commit("2222222bbbb")];

        assert!(echo_matches(
            &["1111111".to_string(), "2222222".to_string()],
            &fresh
        ));
        // Order is the caller's to choose; the mapping is what matters.
        assert!(echo_matches(
            &["2222222".to_string(), "1111111".to_string()],
            &fresh
        ));
        // Full shas and upper case are both accepted spellings of the same commit.
        assert!(echo_matches(
            &["1111111AAAA".to_string(), "2222222bbbb".to_string()],
            &fresh
        ));

        // The set shrank, or grew, since the report.
        assert!(!echo_matches(&["1111111".to_string()], &fresh));
        assert!(!echo_matches(
            &[
                "1111111".to_string(),
                "2222222".to_string(),
                "3333333".to_string()
            ],
            &fresh
        ));
        // A prefix that names nothing here.
        assert!(!echo_matches(
            &["1111111".to_string(), "9999999".to_string()],
            &fresh
        ));
        // One commit claimed twice can never stand in for two.
        assert!(!echo_matches(
            &["1111111".to_string(), "1111111".to_string()],
            &fresh
        ));

        // Two commits that collide at seven characters: the shared prefix names no
        // ONE of them, so it names none, and only the full shas can answer.
        let twins = vec![commit("1111111aaaa"), commit("1111111bbbb")];
        assert!(!echo_matches(
            &["1111111".to_string(), "1111111bbbb".to_string()],
            &twins
        ));
        assert!(echo_matches(
            &["1111111aaaa".to_string(), "1111111bbbb".to_string()],
            &twins
        ));
    }

    /// The echo is required with an answer and has to look like shas — a malformed
    /// one is refused here rather than reported as an upstream that moved.
    #[test]
    fn expected_drop_shas_are_required_and_hex() {
        assert_eq!(
            ensure_expected_drop_shas(Some(vec!["1111111".into()])).unwrap(),
            vec!["1111111".to_string()]
        );

        for missing in [None, Some(vec![])] {
            let err = ensure_expected_drop_shas(missing)
                .expect_err("an answer without its shas is not an answer");
            assert!(err.to_string().contains("expectedDropShas"), "{err}");
        }
        for bad in ["", "abc", "zzzzzzz", "1111111 ", &"a".repeat(41)] {
            let err = ensure_expected_drop_shas(Some(vec![bad.to_string()]))
                .expect_err("only a sha can name a commit");
            assert!(err.to_string().contains("hex characters"), "{bad:?} → {err}");
        }
    }

    // --- The rebase guard, end to end through the tool (temp repos, git on PATH). ---

    async fn git(repo: &str, args: &[&str]) -> String {
        crate::git::runner::run_git(Some(repo), args, crate::git::runner::DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    async fn subjects(repo: &str) -> Vec<String> {
        git(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    async fn configure(repo: &str) {
        git(repo, &["config", "core.autocrlf", "false"]).await;
        git(repo, &["config", "user.email", "t@t.local"]).await;
        git(repo, &["config", "user.name", "T"]).await;
    }

    /// The one text block a tool result carries.
    fn text_of(result: &CallToolResult) -> String {
        result
            .content
            .first()
            .and_then(ContentBlock::as_text)
            .expect("the tool returns one text block")
            .text
            .clone()
    }

    /// A bare origin, a teammate's `work` clone, and the clone the handler binds to —
    /// in which the user has PUSHED a commit the teammate then force-pushed away.
    /// That push is what arms the trap: it writes the commit into the clone's
    /// `refs/remotes/origin/main` reflog, which is where fork-point finds it.
    async fn vaporize_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-mcp-pull-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );

        git(&root, &["init", "-q", "-b", "main", "work"]).await;
        let work_dir = dir.path().join("work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        std::fs::write(work_dir.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "base"]).await;
        git(&work, &["remote", "add", "origin", &url]).await;
        git(&work, &["push", "-q", "-u", "origin", "main"]).await;

        git(
            &root,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"],
        )
        .await;
        let clone_dir = dir.path().join("clone");
        let clone = clone_dir.to_string_lossy().into_owned();
        configure(&clone).await;

        // The user commits and PUSHES V.
        std::fs::write(clone_dir.join("v.txt"), "v\n").unwrap();
        git(&clone, &["add", "-A"]).await;
        git(&clone, &["commit", "-qm", "V the victim"]).await;
        git(&clone, &["push", "-q"]).await;

        // The teammate rewrites origin's history over it.
        git(&work, &["fetch", "-q"]).await;
        git(&work, &["reset", "-q", "--hard", "origin/main~1"]).await;
        std::fs::write(work_dir.join("r.txt"), "r\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "teammate rewrite"]).await;
        git(&work, &["push", "-q", "--force"]).await;

        (dir, clone)
    }

    /// A clone that is merely BEHIND its upstream — the rebase pull the guard has to
    /// stay out of the way of.
    async fn behind_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-mcp-pull-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );

        git(&root, &["init", "-q", "-b", "main", "work"]).await;
        let work_dir = dir.path().join("work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        std::fs::write(work_dir.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "base"]).await;
        git(&work, &["remote", "add", "origin", &url]).await;
        git(&work, &["push", "-q", "-u", "origin", "main"]).await;

        git(
            &root,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"],
        )
        .await;
        let clone = dir.path().join("clone").to_string_lossy().into_owned();
        configure(&clone).await;

        // Upstream moves ahead; the clone has nothing of its own.
        std::fs::write(work_dir.join("b.txt"), "b\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "upstream work"]).await;
        git(&work, &["push", "-q"]).await;

        (dir, clone)
    }

    /// The MCP caller is an agent, so the guard's refusal has to arrive as readable
    /// TEXT it can act on — not an error — and the repo must be exactly as it was.
    #[tokio::test]
    async fn pull_rebase_guard_reports_the_dropped_commits_as_text() {
        let (_dir, clone) = vaporize_repo("report").await;
        let before = git(&clone, &["rev-parse", "HEAD"]).await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, false);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: None,
                expected_drop_shas: None,
            }))
            .await
            .expect("the guard's question is this call's output, not a failure");
        let text = text_of(&result);

        let victim = git(&clone, &["rev-parse", "--short=7", "HEAD"]).await;
        let victim = victim.trim();
        assert!(
            text.contains("would drop 1 commit that origin/main no longer contains"),
            "{text}"
        );
        assert!(
            text.contains(&format!("{victim} V the victim — T")),
            "every dropped commit is named `sha7 subject — author`: {text}"
        );
        assert!(
            text.contains("Your branch and working tree are untouched"),
            "{text}"
        );
        assert!(text.contains("keep: the commits are replayed"), "{text}");
        assert!(text.contains("drop: the commits leave the branch"), "{text}");
        assert!(
            text.contains(&format!(
                r#"pull {{"mode": "rebase", "decision": "keep", "expectedDropShas": ["{victim}"]}}"#
            )),
            "the re-call must be copyable, echo included: {text}"
        );
        assert!(
            text.contains(&format!(
                r#"pull {{"mode": "rebase", "decision": "drop", "expectedDropShas": ["{victim}"]}}"#
            )),
            "{text}"
        );

        assert_eq!(git(&clone, &["rev-parse", "HEAD"]).await, before);
        assert_eq!(
            subjects(&clone).await,
            vec!["V the victim", "base"],
            "the refusal touched nothing"
        );
        assert!(git(&clone, &["status", "--porcelain"]).await.trim().is_empty());
    }

    /// The at-risk commit as the guard's report would print it — what an answering
    /// call has to echo back.
    async fn at_risk_sha(repo: &str) -> String {
        git(repo, &["rev-parse", "--short=7", "HEAD"])
            .await
            .trim()
            .to_string()
    }

    /// Keeping replays the commit on top of the new upstream tip. It rewrites nothing
    /// away, so it stays at the pull tool's own tier (no --allow-destructive).
    #[tokio::test]
    async fn pull_rebase_decision_keep_replays_the_commit() {
        let (_dir, clone) = vaporize_repo("keep").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, false);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("keep".into()),
                expected_drop_shas: Some(vec![at_risk_sha(&clone).await]),
            }))
            .await
            .expect("keeping rebases cleanly");
        assert_eq!(
            text_of(&result),
            "pulled with rebase; kept 1 commit origin/main no longer contains (replayed on top \
             of its new tip)"
        );
        assert_eq!(
            subjects(&clone).await,
            vec!["V the victim", "teammate rewrite", "base"]
        );
    }

    /// Dropping is the answer that rewrites commits away, so it needs the destructive
    /// tier — and with it, the commit really does leave the branch.
    #[tokio::test]
    async fn pull_rebase_decision_drop_removes_the_commit_once_the_tier_is_granted() {
        let (_dir, clone) = vaporize_repo("drop").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: Some(vec![at_risk_sha(&clone).await]),
            }))
            .await
            .expect("dropping rebases cleanly");
        assert_eq!(
            text_of(&result),
            "pulled with rebase; dropped 1 commit origin/main replaced (recorded in Operation \
             history)"
        );
        assert_eq!(subjects(&clone).await, vec!["teammate rewrite", "base"]);
        assert!(
            crate::oplog::git_oplog_list(clone.clone())
                .await
                .expect("the journal must be readable")
                .iter()
                .any(|e| e.op == "pull_rebase_drop"),
            "the destructive answer is the one the journal records"
        );
    }

    /// The tier is checked BEFORE the pull runs: a refused drop never fetches, and the
    /// commit it was aimed at is still on the branch. The echo is well-formed here, so
    /// the refusal can only be the tier's.
    #[tokio::test]
    async fn pull_rebase_decision_drop_is_refused_without_the_destructive_tier() {
        let (_dir, clone) = vaporize_repo("drop-gated").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, false);

        let err = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: Some(vec![at_risk_sha(&clone).await]),
            }))
            .await
            .expect_err("dropping commits needs the destructive tier");
        assert!(
            err.to_string().contains("--allow-destructive"),
            "got: {err}"
        );
        assert_eq!(subjects(&clone).await, vec!["V the victim", "base"]);
    }

    /// An answer with no echoed shas is refused at the boundary — before the pull —
    /// and told what to send. Consent has to name what it is consenting to.
    #[tokio::test]
    async fn pull_refuses_an_answer_that_echoes_no_shas() {
        let (_dir, clone) = vaporize_repo("no-echo").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

        let err = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: None,
            }))
            .await
            .expect_err("an answer must name the commits it answers about");
        assert!(err.to_string().contains("expectedDropShas"), "got: {err}");
        assert_eq!(subjects(&clone).await, vec!["V the victim", "base"]);
    }

    /// The echo counts have to agree: an answer written against a two-commit report
    /// never lands on a one-commit verdict, whichever way the set moved.
    #[tokio::test]
    async fn pull_refuses_an_echo_whose_count_disagrees() {
        let (_dir, clone) = vaporize_repo("echo-count").await;
        let victim = at_risk_sha(&clone).await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: Some(vec![victim.clone(), "9999999".into()]),
            }))
            .await
            .expect("a changed set is a question, not a failure");
        let text = text_of(&result);
        assert!(
            text.starts_with("The at-risk commits changed since the report you answered"),
            "{text}"
        );
        assert!(
            text.contains(&format!("{victim} V the victim — T")),
            "the fresh report has to come back with it: {text}"
        );
        assert_eq!(
            subjects(&clone).await,
            vec!["V the victim", "base"],
            "a refused answer changes nothing"
        );
    }

    /// A prefix that names none of the fresh commits is refused the same way — the
    /// count alone can agree while the commits behind it are different ones.
    #[tokio::test]
    async fn pull_refuses_an_echoed_sha_that_matches_nothing() {
        let (_dir, clone) = vaporize_repo("echo-miss").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: Some(vec!["dead".into()]),
            }))
            .await
            .expect("a changed set is a question, not a failure");
        let text = text_of(&result);
        assert!(
            text.starts_with("The at-risk commits changed since the report you answered"),
            "{text}"
        );
        assert_eq!(subjects(&clone).await, vec!["V the victim", "base"]);
    }

    /// A malformed echo is an argument error, not an upstream that moved: saying "the
    /// commits changed" there would blame the wrong thing.
    #[tokio::test]
    async fn pull_refuses_a_non_hex_echoed_sha() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, true);

        let err = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("keep".into()),
                expected_drop_shas: Some(vec!["not-a-sha".into()]),
            }))
            .await
            .expect_err("only a sha can name a commit");
        assert!(err.to_string().contains("hex characters"), "got: {err}");
    }

    /// A decision on a rebase pull with nothing at risk is a no-op, and says so — an
    /// agent that re-calls with an answer must not be left guessing whether it applied.
    #[tokio::test]
    async fn pull_reports_when_no_decision_was_needed() {
        let (_dir, clone) = behind_repo("no-decision").await;
        let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

        let result = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("drop".into()),
                expected_drop_shas: Some(vec!["1111111".into()]),
            }))
            .await
            .expect("a clean rebase pull is unaffected by the guard");
        assert_eq!(
            text_of(&result),
            "pulled — no decision was needed (the rebase guard found nothing at risk)"
        );
        assert_eq!(subjects(&clone).await, vec!["upstream work", "base"]);
    }

    /// Only a rebase-mode pull ever runs the guard, so only it can report on what the
    /// guard found. Merge and fast-forward answer for themselves: the question was
    /// never asked, and claiming "nothing at risk" would be a verdict nobody reached.
    #[tokio::test]
    async fn pull_says_a_non_rebase_pull_never_consulted_the_guard() {
        for mode in [None, Some("merge".to_string())] {
            let tag = format!("no-guard-{}", mode.as_deref().unwrap_or("ff"));
            let (_dir, clone) = behind_repo(&tag).await;
            let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, true);

            let result = h
                .pull(Parameters(PullArgs {
                    mode,
                    decision: Some("drop".into()),
                    expected_drop_shas: Some(vec!["1111111".into()]),
                }))
                .await
                .expect("the answer is unused, not an error");
            assert_eq!(
                text_of(&result),
                "pulled — this wasn't a rebase-mode pull, so the guard never ran and your answer \
                 was not used."
            );
            assert_eq!(subjects(&clone).await, vec!["upstream work", "base"]);
        }
    }

    /// Every pull with nothing at risk keeps its old one-word result — the
    /// fast-forward default, an explicit merge, and a clean rebase alike.
    #[tokio::test]
    async fn pulls_with_nothing_at_risk_are_unchanged() {
        for mode in [None, Some("merge".to_string()), Some("rebase".to_string())] {
            let tag = mode.clone().unwrap_or_else(|| "ff".into());
            let (_dir, clone) = behind_repo(&tag).await;
            let h = GitDesktopMcp::with_options(clone.clone(), false, false, true, false);

            let result = h
                .pull(Parameters(PullArgs {
                    mode,
                    decision: None,
                    expected_drop_shas: None,
                }))
                .await
                .expect("a clone that is merely behind pulls cleanly");
            assert_eq!(text_of(&result), "pulled");
            assert_eq!(subjects(&clone).await, vec!["upstream work", "base"]);
        }
    }

    /// A decision word the guard doesn't take is refused at the boundary, before any
    /// git runs — silently ignoring it would look like the answer was applied.
    #[tokio::test]
    async fn pull_refuses_an_unknown_decision_word() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, true);

        let err = h
            .pull(Parameters(PullArgs {
                mode: Some("rebase".into()),
                decision: Some("vaporize".into()),
                expected_drop_shas: Some(vec!["1111111".into()]),
            }))
            .await
            .expect_err("only keep and drop decide anything");
        assert!(err.to_string().contains("unknown pull decision"), "got: {err}");
    }

    /// With the gates OPEN, a gd/session/* target is still refused BEFORE any git runs —
    /// delete_branch, rename_branch, delete_remote_branch, checkout_branch.
    #[tokio::test]
    async fn branch_tools_refuse_session_branch_when_gated_open() {
        let h = GitDesktopMcp::with_options("/tmp/x".to_string(), false, false, true, true);

        let err = h
            .delete_branch(Parameters(BranchNameArgs {
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session branch delete should be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "got: {err}"
        );

        let err = h
            .rename_branch(Parameters(RenameBranchArgs {
                from: "gd/session/xyz".into(),
                to: "renamed".into(),
            }))
            .await
            .expect_err("session branch rename should be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "got: {err}"
        );

        let err = h
            .delete_remote_branch(Parameters(DeleteRemoteBranchArgs {
                remote: "origin".into(),
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session remote branch delete should be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "got: {err}"
        );

        let err = h
            .checkout_branch(Parameters(BranchNameArgs {
                name: "gd/session/xyz".into(),
            }))
            .await
            .expect_err("session branch checkout should be refused");
        assert!(
            err.to_string().contains("agent-session branch"),
            "got: {err}"
        );
    }
}
