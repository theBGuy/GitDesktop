//! The GitHub [`Forge`](super::Forge) implementation.
//!
//! `gh` already handles Enterprise hosts and multi-account auth, so this is a **thin
//! adapter** over the existing `github::*` (gh-CLI-backed) code, never a rewrite —
//! each function delegates to the matching `gh_*`.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::forge::model::{
    Capabilities, ForgeForkResult, ForgeRepo, ForgeRepoList, ForgeSearchList, ForgeSearchRepo,
    ForgeStatus, Implemented, Provider,
};
use crate::forge::{validate_owner, validate_repo_name, Forge};
use crate::github::pr::{gh_list_repos, gh_status, GhRepo, GhStatus};
use crate::github::runner::{run_gh, run_gh_raw, GH_NETWORK_TIMEOUT, GH_TIMEOUT};

/// GitHub via the `gh` CLI. Unit struct — `gh` carries all the state (auth, host).
pub struct GitHubForge;

/// Map the GitHub-shaped `GhStatus` onto the neutral `ForgeStatus`. Pure (no I/O)
/// so it's unit-testable: a repo `gh` recognizes is a GitHub repo with the full
/// capability set; an unrecognized one carries no provider and no capabilities,
/// matching `gh_status`'s own `repo: None`.
pub(crate) fn from_gh_status(gh: GhStatus) -> ForgeStatus {
    let provider = gh.repo.as_ref().map(|_| Provider::GitHub);
    ForgeStatus {
        provider,
        installed: gh.installed,
        authenticated: gh.authenticated,
        repo: gh.repo,
        host: gh.host,
        login: gh.login,
        capabilities: match provider {
            Some(p) => Capabilities::for_provider(p),
            None => Capabilities::none(),
        },
        implemented: match provider {
            Some(p) => Implemented::for_provider(p),
            None => Implemented::none(),
        },
    }
}

impl Forge for GitHubForge {
    async fn status(&self, repo_path: &str) -> AppResult<ForgeStatus> {
        Ok(from_gh_status(gh_status(repo_path.to_string()).await?))
    }
}

/// Map a GitHub repo (gh shape) onto the neutral [`ForgeRepo`] — 1:1, since the
/// neutral model was sized from `GhRepo`.
fn from_gh_repo(r: GhRepo) -> ForgeRepo {
    ForgeRepo {
        full_name: r.name_with_owner,
        owner: r.owner,
        name: r.name,
        private: r.private,
        archived: r.archived,
        fork: r.fork,
        clone_url: r.clone_url,
        ssh_url: r.ssh_url,
        description: r.description,
        pushed_at: r.pushed_at,
    }
}

/// The signed-in GitHub user's repositories, for the clone browser.
pub async fn list_repos() -> AppResult<ForgeRepoList> {
    let gh = gh_list_repos().await?;
    Ok(ForgeRepoList {
        viewer: gh.viewer,
        repos: gh.repos.into_iter().map(from_gh_repo).collect(),
    })
}

// ── Pull requests ────────────────────────────────────────────────────────────
//
// Thin delegates to the existing gh-backed `gh_pr_*` commands.

pub async fn list_prs(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    crate::github::pr::gh_pr_list(repo_path.to_string(), state.to_string(), limit, lens).await
}

pub async fn list_ci(
    repo_path: &str,
    prs: &[crate::github::pr::PrCiRefIn],
    sample_url: &str,
) -> AppResult<Vec<crate::github::pr::PrCiStatus>> {
    // GitHub queries by PR number (its precomputed rollup); head_sha is unused here.
    let numbers: Vec<u64> = prs.iter().map(|p| p.number).collect();
    crate::github::pr::gh_pr_list_ci(repo_path, numbers, sample_url).await
}

pub async fn view_pr(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrDetails> {
    crate::github::pr::gh_pr_view(repo_path.to_string(), number, lens).await
}

pub async fn pr_timeline(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<crate::github::pr::PrTimelineEventOut>> {
    crate::github::pr::pr_timeline(repo_path, number, lens).await
}

pub async fn diff_pr(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<String> {
    crate::github::pr::gh_pr_diff(repo_path.to_string(), number, lens).await
}

pub async fn commit_diff(repo_path: &str, oid: &str) -> AppResult<String> {
    crate::github::pr::commit_diff(repo_path, oid).await
}

pub async fn commit_comments(
    repo_path: &str,
    sha: &str,
    lens: Option<&str>,
) -> AppResult<Vec<crate::github::pr::CommitCommentOut>> {
    crate::github::pr::commit_comments(repo_path, sha, lens).await
}

/// Create a commit comment. GitHub anchored comments use `path` + `position`; `line`
/// is ignored (the frontend computes the diff-position).
pub async fn commit_comment_create(
    repo_path: &str,
    sha: &str,
    body: &str,
    path: Option<&str>,
    position: Option<u64>,
    lens: Option<&str>,
) -> AppResult<()> {
    crate::github::pr::commit_comment_create(repo_path, sha, body, path, position, lens).await
}

pub async fn commit_comment_edit(repo_path: &str, comment_id: &str, body: &str) -> AppResult<()> {
    crate::github::pr::commit_comment_edit(repo_path, comment_id, body).await
}

pub async fn commit_comment_delete(repo_path: &str, comment_id: &str) -> AppResult<()> {
    crate::github::pr::commit_comment_delete(repo_path, comment_id).await
}

#[allow(clippy::too_many_arguments)]
pub async fn thread_create(
    repo_path: &str,
    number: u64,
    path: &str,
    line: u64,
    side: &str,
    start_line: Option<u64>,
    body: &str,
    lens: Option<&str>,
) -> AppResult<()> {
    crate::github::pr::thread_create(repo_path, number, path, line, side, start_line, body, lens)
        .await
}

pub async fn review_submit(
    repo_path: &str,
    number: u64,
    verdict: &str,
    summary: Option<&str>,
    comments: &[crate::github::pr::DraftCommentIn],
    lens: Option<&str>,
) -> AppResult<crate::github::pr::ReviewSubmitOut> {
    crate::github::pr::review_submit(repo_path, number, verdict, summary, comments, lens).await
}

pub async fn external_reviews(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::ExternalReviewItem>> {
    crate::github::pr::gh_pr_external_reviews(repo_path.to_string(), number, lens).await
}

pub async fn review_threads(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::ReviewThreadOut>> {
    crate::github::pr::gh_pr_review_threads(repo_path.to_string(), number, lens).await
}

pub async fn reply_thread(repo_path: &str, thread_id: &str, body: &str) -> AppResult<()> {
    crate::github::pr::gh_pr_reply_review_thread(
        repo_path.to_string(),
        thread_id.to_string(),
        body.to_string(),
    )
    .await
}

pub async fn resolve_thread(repo_path: &str, thread_id: &str, resolved: bool) -> AppResult<()> {
    crate::github::pr::gh_pr_resolve_review_thread(
        repo_path.to_string(),
        thread_id.to_string(),
        resolved,
    )
    .await
}

pub async fn poll_prs(repo_path: &str) -> AppResult<Vec<crate::github::pr::PrPollInfo>> {
    crate::github::pr::gh_pr_poll(repo_path.to_string()).await
}

// ── Merge requests (write) ───────────────────────────────────────────────────
//
// Thin delegates to the gh-backed PR mutations. Merge has no delegate here —
// `forge_pr_merge` dispatches straight to `gh_pr_merge`.

pub async fn edit_pr(
    repo_path: &str,
    number: u64,
    title: &str,
    body: &str,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::pr::gh_pr_edit(
        repo_path.to_string(),
        number,
        title.to_string(),
        body.to_string(),
        lens,
    )
    .await
}

pub async fn prs_for_branch(
    repo_path: &str,
    head: &str,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    crate::github::pr::gh_prs_for_branch(repo_path.to_string(), head.to_string(), lens).await
}

pub async fn comment_pr(
    repo_path: &str,
    number: u64,
    body: &str,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::pr::gh_pr_comment(repo_path.to_string(), number, body.to_string(), lens).await
}

/// Edit a conversation comment's body. GitHub's `updateIssueComment` mutation
/// backs both PR and issue conversation comments, so PR + issue forge arms share
/// this delegate.
pub async fn edit_comment(repo_path: &str, comment_id: &str, body: &str) -> AppResult<()> {
    crate::github::pr::edit_comment(repo_path, comment_id, body).await
}

/// Delete a conversation comment by node id — shared by the PR + issue forge arms
/// (the `deleteIssueComment` mutation serves both).
pub async fn delete_comment(repo_path: &str, comment_id: &str) -> AppResult<()> {
    crate::github::pr::delete_comment(repo_path, comment_id).await
}

/// Edit a file:line-anchored review-thread comment's body (a
/// `PullRequestReviewComment` node — distinct from conversation comments).
pub async fn edit_review_comment(repo_path: &str, comment_id: &str, body: &str) -> AppResult<()> {
    crate::github::pr::edit_review_comment(repo_path, comment_id, body).await
}

/// Delete a review-thread comment by node id.
pub async fn delete_review_comment(repo_path: &str, comment_id: &str) -> AppResult<()> {
    crate::github::pr::delete_review_comment(repo_path, comment_id).await
}

pub async fn close_pr(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<()> {
    crate::github::pr::gh_pr_close(repo_path.to_string(), number, lens).await
}

pub async fn reopen_pr(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<()> {
    crate::github::pr::gh_pr_reopen(repo_path.to_string(), number, lens).await
}

// ── Issues (read) ────────────────────────────────────────────────────────────

pub async fn list_issues(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::issue::IssueInfo>> {
    crate::github::issue::gh_issue_list(repo_path.to_string(), state.to_string(), limit, lens).await
}

pub async fn view_issue(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueDetails> {
    crate::github::issue::gh_issue_view(repo_path.to_string(), number, lens).await
}

// ── CI / Actions ─────────────────────────────────────────────────────────────

pub async fn list_runs(
    repo_path: &str,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<crate::github::actions::WorkflowRun>> {
    crate::github::actions::gh_run_list(repo_path.to_string(), limit, branch).await
}

pub async fn view_run(
    repo_path: &str,
    run_id: u64,
) -> AppResult<crate::github::actions::RunDetail> {
    crate::github::actions::gh_run_view(repo_path.to_string(), run_id).await
}

pub async fn run_failed_logs(repo_path: &str, run_id: u64) -> AppResult<String> {
    crate::github::actions::gh_run_failed_logs(repo_path.to_string(), run_id).await
}

pub async fn job_logs(repo_path: &str, job_id: u64) -> AppResult<String> {
    crate::github::actions::gh_job_logs(repo_path.to_string(), job_id).await
}

pub async fn rerun_run(repo_path: &str, run_id: u64, failed: bool) -> AppResult<()> {
    crate::github::actions::gh_run_rerun(repo_path.to_string(), run_id, failed).await
}

pub async fn cancel_run(repo_path: &str, run_id: u64) -> AppResult<()> {
    crate::github::actions::gh_run_cancel(repo_path.to_string(), run_id).await
}

pub async fn dispatch_ci(
    repo_path: &str,
    workflow: &str,
    git_ref: &str,
    inputs: std::collections::HashMap<String, String>,
) -> AppResult<()> {
    crate::github::actions::gh_workflow_run(
        repo_path.to_string(),
        workflow.to_string(),
        git_ref.to_string(),
        inputs,
    )
    .await
}

// ── Releases ─────────────────────────────────────────────────────────────────
//
// Notes generation and asset download stay GitHub-only `gh_*` commands — GitLab has
// no analogue, so they are deliberately not fronted here.

pub async fn list_releases(repo_path: &str) -> AppResult<Vec<crate::github::release::ReleaseInfo>> {
    crate::github::release::gh_release_list(repo_path.to_string()).await
}

pub async fn view_release(
    repo_path: &str,
    tag: &str,
) -> AppResult<crate::github::release::ReleaseDetails> {
    crate::github::release::gh_release_view(repo_path.to_string(), tag.to_string()).await
}

#[allow(clippy::too_many_arguments)]
pub async fn create_release(
    repo_path: &str,
    tag: &str,
    title: &str,
    notes: &str,
    target: &str,
    prerelease: bool,
    draft: bool,
    latest: bool,
) -> AppResult<String> {
    crate::github::release::gh_release_create(
        repo_path.to_string(),
        tag.to_string(),
        title.to_string(),
        notes.to_string(),
        target.to_string(),
        prerelease,
        draft,
        latest,
    )
    .await
}

pub async fn edit_release(
    repo_path: &str,
    tag: &str,
    title: &str,
    notes: &str,
    prerelease: bool,
    draft: bool,
    latest: Option<bool>,
) -> AppResult<()> {
    crate::github::release::gh_release_edit(
        repo_path.to_string(),
        tag.to_string(),
        title.to_string(),
        notes.to_string(),
        prerelease,
        draft,
        latest,
    )
    .await
}

pub async fn delete_release(repo_path: &str, tag: &str, cleanup_tag: bool) -> AppResult<()> {
    crate::github::release::gh_release_delete(repo_path.to_string(), tag.to_string(), cleanup_tag)
        .await
}

pub async fn upload_release_asset(repo_path: &str, tag: &str, file_path: &str) -> AppResult<()> {
    crate::github::release::gh_release_upload_asset(
        repo_path.to_string(),
        tag.to_string(),
        file_path.to_string(),
    )
    .await
}

pub async fn delete_release_asset(repo_path: &str, tag: &str, asset_name: &str) -> AppResult<()> {
    crate::github::release::gh_release_delete_asset(
        repo_path.to_string(),
        tag.to_string(),
        asset_name.to_string(),
    )
    .await
}

// ── Issues (write) ───────────────────────────────────────────────────────────
//
// The still-unfronted remainder of the issue write surface (pin, sub-issues, close
// reason, …) stays GitHub-only.

pub async fn comment_issue(
    repo_path: &str,
    number: u64,
    body: &str,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_comment(repo_path.to_string(), number, body.to_string(), lens)
        .await
}

pub async fn close_issue(
    repo_path: &str,
    number: u64,
    reason: &str,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_close(repo_path.to_string(), number, reason.to_string(), lens)
        .await
}

pub async fn reopen_issue(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<()> {
    crate::github::issue::gh_issue_reopen(repo_path.to_string(), number, lens).await
}

pub async fn edit_issue(
    repo_path: &str,
    number: u64,
    title: &str,
    body: &str,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_edit(
        repo_path.to_string(),
        number,
        title.to_string(),
        body.to_string(),
        lens,
    )
    .await
}

pub async fn lock_issue(
    repo_path: &str,
    number: u64,
    reason: Option<String>,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_lock(repo_path.to_string(), number, reason, lens).await
}

pub async fn unlock_issue(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<()> {
    crate::github::issue::gh_issue_unlock(repo_path.to_string(), number, lens).await
}

pub async fn transfer_issue(
    repo_path: &str,
    number: u64,
    destination: &str,
    lens: Option<String>,
) -> AppResult<String> {
    crate::github::issue::gh_issue_transfer(
        repo_path.to_string(),
        number,
        destination.to_string(),
        lens,
    )
    .await
}

pub async fn delete_issue(repo_path: &str, number: u64, lens: Option<String>) -> AppResult<()> {
    crate::github::issue::gh_issue_delete(repo_path.to_string(), number, lens).await
}

// ── Milestones (read) ──────────────────────────────────────────────────────────
//
// GitHub keys on the milestone number, the GitLab impl on its global milestone id —
// both travel as the neutral `Milestone.number`. (The write, `set_issue_milestone`,
// lives below under Reactions.)

pub async fn milestones(
    repo_path: &str,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::issue::Milestone>> {
    crate::github::issue::gh_milestones(repo_path.to_string(), lens).await
}

// ── Repository actions & publish ───────────────────────────────────────────────
//
// Fork keeps calling `gh_repo_fork` directly (its remote-rewiring flow is GitHub-only;
// GitLab forks via a web link-out), and the admin/branch-rule sub-surfaces stay on
// their own gh_* commands.

pub async fn repo_url(repo_path: &str) -> AppResult<String> {
    crate::github::pr::gh_repo_url(repo_path.to_string()).await
}

pub async fn repo_star_status(repo_path: &str) -> AppResult<bool> {
    crate::github::pr::gh_repo_star_status(repo_path.to_string()).await
}

pub async fn repo_set_star(repo_path: &str, starred: bool) -> AppResult<()> {
    crate::github::pr::gh_repo_set_star(repo_path.to_string(), starred).await
}

pub async fn repo_visibility(repo_path: &str) -> AppResult<crate::forge::RepoVisibilityRaw> {
    crate::github::repo_settings::gh_repo_visibility(repo_path.to_string()).await
}

pub async fn publish_repo(
    repo_path: &str,
    name: &str,
    private: bool,
    description: &str,
    homepage: &str,
    topics: Vec<String>,
) -> AppResult<String> {
    crate::github::pr::gh_publish_repo(
        repo_path.to_string(),
        name.to_string(),
        private,
        description.to_string(),
        homepage.to_string(),
        topics,
    )
    .await
}

// ── Reactions ──────────────────────────────────────────────────────────────────
//
// GitHub subjects are GraphQL node ids, so the add/remove delegates ignore the
// target/number the GitLab arm needs — the frontend carries both (the shared-control
// different-identifiers pattern).

pub async fn issue_reactions(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueReactions> {
    crate::github::issue::gh_issue_reactions(repo_path.to_string(), number, lens).await
}

pub async fn pr_reactions(
    repo_path: &str,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueReactions> {
    crate::github::pr::gh_pr_reactions(repo_path.to_string(), number, lens).await
}

pub async fn add_reaction(repo_path: &str, subject_id: &str, content: &str) -> AppResult<()> {
    crate::github::issue::gh_add_reaction(
        repo_path.to_string(),
        subject_id.to_string(),
        content.to_string(),
    )
    .await
}

pub async fn remove_reaction(repo_path: &str, subject_id: &str, content: &str) -> AppResult<()> {
    crate::github::issue::gh_remove_reaction(
        repo_path.to_string(),
        subject_id.to_string(),
        content.to_string(),
    )
    .await
}

pub async fn set_issue_milestone(
    repo_path: &str,
    number: u64,
    milestone: Option<u64>,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_set_milestone(repo_path.to_string(), number, milestone, lens)
        .await
}

// ── Labels & assignees (read + write) ─────────────────────────────────────────
//
// Labels are a shared control on both issues and MRs (GitHub keys them by GraphQL
// node id); issue assignees are a shared issue control.

pub async fn repo_labels(
    repo_path: &str,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::RepoLabel>> {
    crate::github::pr::gh_repo_labels(repo_path.to_string(), lens).await
}

pub async fn assignable_users(
    repo_path: &str,
    lens: Option<String>,
) -> AppResult<Vec<crate::forge::model::ForgeUserRef>> {
    // GitHub carries no avatar in the assignees endpoint; the picker derives it
    // from the login (id), so leave `avatar_url` empty and let the frontend fill it.
    Ok(
        crate::github::issue::gh_assignable_users(repo_path.to_string(), lens)
            .await?
            .into_iter()
            .map(|l| crate::forge::model::ForgeUserRef {
                id: l.clone(),
                label: l,
                avatar_url: String::new(),
                is_bot: false,
            })
            .collect(),
    )
}

pub async fn set_pr_reviewers(
    repo_path: &str,
    number: u64,
    reviewers: &[String],
    lens: Option<&str>,
) -> AppResult<()> {
    crate::github::pr::set_pr_reviewers(repo_path, number, reviewers, lens).await
}

pub async fn reviewer_candidates(
    repo_path: &str,
    number: Option<u64>,
    lens: Option<&str>,
) -> AppResult<Vec<crate::forge::model::ForgeUserRef>> {
    crate::github::pr::reviewer_candidates(repo_path, number, lens).await
}

pub async fn edit_labels(
    repo_path: &str,
    labelable_id: &str,
    add_ids: Vec<String>,
    remove_ids: Vec<String>,
) -> AppResult<()> {
    crate::github::pr::gh_pr_edit_labels(
        repo_path.to_string(),
        labelable_id.to_string(),
        add_ids,
        remove_ids,
    )
    .await
}

pub async fn set_issue_assignees(
    repo_path: &str,
    number: u64,
    assignees: Vec<String>,
    lens: Option<String>,
) -> AppResult<()> {
    crate::github::issue::gh_issue_set_assignees(repo_path.to_string(), number, assignees, lens)
        .await
}

/// Create an issue — delegates to the gh-backed REST create with the full GitHub
/// field set (labels/assignees/milestone/org issue type). (PR create has no delegate
/// here: `forge_pr_create`'s GitHub arm calls `gh_pr_create_core` directly, since the
/// push needs an `AppState`, like `forge_pr_merge`.)
#[allow(clippy::too_many_arguments)]
pub async fn create_issue(
    repo_path: &str,
    title: &str,
    body: &str,
    labels: Vec<String>,
    assignees: Vec<String>,
    milestone: Option<u64>,
    issue_type: Option<String>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrRef> {
    crate::github::issue::gh_issue_create(
        repo_path.to_string(),
        title.to_string(),
        body.to_string(),
        labels,
        assignees,
        milestone,
        issue_type,
        lens,
    )
    .await
}

/// One-shot `git -c` credential entries that authenticate a private GitHub repo with
/// gh's token via an ABSOLUTE gh path — works even when git's ambient `!gh` helper
/// can't find gh (macOS launchd's minimal GUI PATH) or gh never installed the HTTPS
/// helper. Nothing is written to git config; no token enters the URL. Returns the
/// `[reset, helper]` pair ONLY when gh has a STORED token for `host` — otherwise an
/// empty Vec, so ambient helpers (keychain, git-credential-manager) still run. That
/// check proves the token EXISTS, not that it's valid; the ambient fallback in
/// [`crate::git::remote::run_git_mutating_with_creds`] covers a revoked one. Missing
/// gh → `Err(GhNotFound)`, so `.unwrap_or_default()` callers stay fail-open.
/// Mirrors `gitlab::clone_credential_config`.
pub async fn clone_credential_config(clone_url: &str) -> AppResult<Vec<String>> {
    let gh = crate::agent::resolve_named(&["gh"], None)
        .await
        .ok_or(AppError::GhNotFound)?;
    let host = crate::forge::remote_host(clone_url).unwrap_or_else(|| "github.com".to_string());
    if !gh_authenticated(&host).await {
        return Ok(Vec::new());
    }
    Ok(github_credential_entries(&host, &gh.display().to_string()))
}

/// The one-shot `-c` credential entries for an authenticated GitHub host — a
/// `[reset, helper]` pair. Pure/format-only.
///
/// entry[0] SEVERS git's accumulated helper chain for this URL: `-c
/// credential.https://<host>.helper=` sets the EMPTY string, which git treats as
/// "clear the helpers so far" (gitcredentials(7)). The trailing `=` is load-bearing —
/// `-c name` without it sets boolean true and breaks the reset. entry[1] installs gh
/// as the sole helper so an ambient one earlier in the chain (macOS `osxkeychain`)
/// can't shadow it. Order matters: reset FIRST — consumers prefix `-c` in Vec order.
fn github_credential_entries(host: &str, gh_path: &str) -> Vec<String> {
    vec![
        format!("credential.https://{host}.helper="),
        github_credential_entry(host, gh_path),
    ]
}

/// The one-shot `-c` credential-helper config value for a GitHub host. Pure/format-only.
fn github_credential_entry(host: &str, gh_path: &str) -> String {
    format!("credential.https://{host}.helper=!\"{gh_path}\" auth git-credential")
}

/// Whether gh has a STORED token for `host` — the gate deciding whether to inject the
/// credential helper. `gh auth token --hostname <host>` is local-only (no network):
/// exit 0 iff a token exists in gh's config, the keyring, or `GH_TOKEN` — the same
/// sources `gh auth git-credential` answers from. It proves the token EXISTS, not that
/// it's valid. Memoized per host for 60s to bound staleness after a sign-in/out.
///
/// SECURITY: `gh auth token`'s stdout IS the user's token — only the exit code is
/// read; the output is dropped and never logged or formatted anywhere.
async fn gh_authenticated(host: &str) -> bool {
    if let Some(hit) = auth_cache_get(host, GH_AUTH_TTL) {
        return hit;
    }
    match crate::github::runner::run_gh_raw(
        None,
        &["auth", "token", "--hostname", host],
        crate::github::runner::GH_TIMEOUT,
    )
    .await
    {
        // Successful spawn: exit 0 ⇔ a token exists. Cache both outcomes.
        Ok(out) => {
            let authed = out.code == 0;
            auth_cache_put(host, authed);
            authed
        }
        // A spawn/timeout hiccup, NOT absence: `resolve_named` already proved gh
        // exists. Inject optimistically (uncached) — on the network path
        // `run_git_mutating_with_creds`'s ambient fallback makes it safe either way,
        // whereas a pessimistic `false` would reopen the stale-keychain bug. The CLONE
        // path (repo.rs extra_config) takes this UNPROTECTED: a signed-out gh plus a
        // transient probe error there severs ambient and the clone hard-fails —
        // accepted, since it self-heals on re-clone.
        Err(_) => true,
    }
}

/// TTL bounding how long a per-host gh auth result stays trusted before we re-probe.
const GH_AUTH_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Per-host cache of `(probe time, authenticated)` for [`gh_authenticated`]. Bounded
/// by the number of distinct hosts (tiny) — a stale entry is overwritten, not evicted.
type GhAuthCache =
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, bool)>>;
static GH_AUTH_CACHE: std::sync::OnceLock<GhAuthCache> = std::sync::OnceLock::new();

fn gh_auth_cache() -> &'static GhAuthCache {
    GH_AUTH_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The cached auth result for `host`, only if an entry exists AND was probed less
/// than `ttl` ago.
fn auth_cache_get(host: &str, ttl: std::time::Duration) -> Option<bool> {
    let guard = gh_auth_cache().lock().unwrap();
    let (probed_at, authed) = guard.get(host)?;
    if probed_at.elapsed() < ttl {
        Some(*authed)
    } else {
        None
    }
}

/// Record `authed` as the current result for `host`, stamped with the probe time.
fn auth_cache_put(host: &str, authed: bool) {
    gh_auth_cache()
        .lock()
        .unwrap()
        .insert(host.to_string(), (std::time::Instant::now(), authed));
}

// ── Explore: repo search / fork-by-name / star / README ───────────────────────
//
// The Explore view's GitHub backend, over `gh api`. All owner/name values are
// grammar-validated before interpolation (argv/path injection guard), and search
// payloads are parsed tolerantly via `serde_json::Value` (a malformed item is
// skipped, not fatal).

/// GitHub caps its search result set at 1000 items regardless of the client, and
/// this backend requests 30 per page.
const GH_SEARCH_PER_PAGE: u64 = 30;
const GH_SEARCH_CAP: u64 = 1000;

/// Map the neutral `sort` (`"best" | "stars" | "updated"`) onto the extra `gh api`
/// `-f` args for `search/repositories`. `"best"` omits sort (GitHub's best-match
/// default); the others pin `order=desc`. Unknown values fall back to no sort.
fn github_sort_args(sort: &str) -> Vec<&'static str> {
    match sort {
        "stars" => vec!["-f", "sort=stars", "-f", "order=desc"],
        "updated" => vec!["-f", "sort=updated", "-f", "order=desc"],
        // "best" (and, defensively, anything else) → best-match default, no sort.
        _ => Vec::new(),
    }
}

/// Whether another search page exists after the 1-based `page` just fetched. GitHub
/// hard-caps search at 1000 results, so the effective end is `min(total, 1000)`.
fn github_has_more(page: u32, total_count: u64) -> bool {
    let consumed = u64::from(page) * GH_SEARCH_PER_PAGE;
    consumed < total_count.min(GH_SEARCH_CAP)
}

/// One search-result repo from a `serde_json::Value` item of GitHub's
/// `search/repositories` response. Tolerant: a missing `full_name` skips the item
/// (returns `None`); every other field defaults gracefully.
fn search_repo_from_value(item: &Value) -> Option<ForgeSearchRepo> {
    let full_name = item.get("full_name").and_then(Value::as_str)?.to_string();
    if full_name.is_empty() {
        return None;
    }
    let str_field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
    Some(ForgeSearchRepo {
        owner: item
            .get("owner")
            .and_then(|o| o.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        name: item.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
        full_name,
        private: item.get("private").and_then(Value::as_bool).unwrap_or(false),
        archived: item.get("archived").and_then(Value::as_bool).unwrap_or(false),
        fork: item.get("fork").and_then(Value::as_bool).unwrap_or(false),
        clone_url: str_field("clone_url").unwrap_or_default(),
        ssh_url: str_field("ssh_url").unwrap_or_default(),
        description: str_field("description"),
        updated_at: str_field("pushed_at"),
        stars: item.get("stargazers_count").and_then(Value::as_u64),
        language: str_field("language"),
        web_url: str_field("html_url"),
        default_branch: str_field("default_branch"),
    })
}

/// Search GitHub repositories for the Explore view. An empty `query` is the
/// Popular/Discover feed (`stars:>1000` sorted by stars). Uses `gh api -X GET
/// search/repositories -f q=… -f per_page=30 -f page=…` (gh URL-encodes the `-f`
/// query params). GitHub's search bucket is 30 req/min — a rate-limit error
/// surfaces rather than being retried.
pub async fn search_repos(query: &str, sort: &str, page: u32) -> AppResult<ForgeSearchList> {
    // Popular mode: no query → high-star discovery feed, forced to star order.
    let (q, sort) = if query.trim().is_empty() {
        ("stars:>1000".to_string(), "stars")
    } else {
        (query.to_string(), sort)
    };
    let per_page = GH_SEARCH_PER_PAGE.to_string();
    let page_s = page.to_string();
    let q_arg = format!("q={q}");
    let per_page_arg = format!("per_page={per_page}");
    let page_arg = format!("page={page_s}");
    let mut args: Vec<&str> = vec![
        "api",
        "-X",
        "GET",
        "search/repositories",
        "-f",
        &q_arg,
        "-f",
        &per_page_arg,
        "-f",
        &page_arg,
    ];
    args.extend(github_sort_args(sort));
    let out = run_gh(None, &args, GH_NETWORK_TIMEOUT).await?;
    let value: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse GitHub search results: {e}")))?;
    let total_count = value.get("total_count").and_then(Value::as_u64).unwrap_or(0);
    let repos = value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(search_repo_from_value).collect())
        .unwrap_or_default();
    Ok(ForgeSearchList {
        repos,
        has_more: github_has_more(page, total_count),
        total: Some(total_count),
    })
}

/// Fork a GitHub repo by `owner/name` into the caller's account. Idempotent: an
/// existing fork makes `gh repo fork` exit 0 with an "already exists" note, which we
/// treat as success. `--clone=false --remote=false` skips the non-TTY clone prompt.
/// Resolves the real fork nwo with PARENT VERIFICATION (GitHub renames on a
/// name-collision — `login/name` may be an unrelated pre-existing repo, and the real
/// fork is `login/name-1`), then polls the fork's commits until it's cloneable
/// (bounded — a timeout returns `ready: false`, never an error).
pub async fn fork_repo(owner: &str, name: &str) -> AppResult<ForgeForkResult> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let source = format!("{owner}/{name}");
    run_gh(
        None,
        &["repo", "fork", &source, "--clone=false", "--remote=false"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // The fork owner is the signed-in user.
    let login = run_gh(None, &["api", "user", "-q", ".login"], GH_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
    if login.is_empty() {
        return Err(AppError::Gh("could not resolve your GitHub login".into()));
    }
    // First attempt: `repos/{login}/{name}`. VERIFY it's actually a fork of the
    // source before trusting it — a caller who already owns an unrelated
    // `login/name` would otherwise get that repo back (and clone the wrong thing).
    let candidate_slug = format!("{login}/{name}");
    let verified = match run_gh_raw(
        None,
        &["api", &format!("repos/{candidate_slug}")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => serde_json::from_str::<Value>(&out.stdout_lossy())
            .ok()
            .filter(|repo| repo_is_fork_of(repo, &source)),
        // 404 (no such repo) or a transient error: fall through to the forks list.
        _ => None,
    };
    let repo = match verified {
        Some(repo) => repo,
        None => find_viewer_fork(owner, name, &login)
            .await?
            .ok_or_else(|| {
                AppError::Gh(format!(
                    "forked {source} but couldn't locate your fork afterward"
                ))
            })?,
    };
    let full_name = repo
        .get("full_name")
        .and_then(Value::as_str)
        .unwrap_or(&candidate_slug)
        .to_string();
    let clone_url = repo
        .get("clone_url")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let web_url = repo.get("html_url").and_then(Value::as_str).map(str::to_string);
    // Fork creation is async (202) — poll until cloneable; a timeout isn't an error.
    let ready = poll_fork_ready(&full_name).await;
    Ok(ForgeForkResult {
        full_name,
        clone_url,
        web_url,
        ready,
    })
}

/// Whether a repo JSON object is a fork whose parent is exactly `source`
/// (`owner/name`, case-insensitive — GitHub logins/repos are case-insensitive).
/// Pure, so it's unit-testable.
fn repo_is_fork_of(repo: &Value, source: &str) -> bool {
    repo.get("fork").and_then(Value::as_bool).unwrap_or(false)
        && repo
            .get("parent")
            .and_then(|p| p.get("full_name"))
            .and_then(Value::as_str)
            .is_some_and(|parent| parent.eq_ignore_ascii_case(source))
}

/// Find the viewer's fork of `owner/name` by listing the source's forks
/// (`repos/{owner}/{name}/forks?per_page=100`) and returning the first whose
/// `owner.login` is `login`. `Ok(None)` when the viewer has no fork in the first
/// page (or the source has none); an API failure surfaces.
async fn find_viewer_fork(owner: &str, name: &str, login: &str) -> AppResult<Option<Value>> {
    let endpoint = format!("repos/{owner}/{name}/forks?per_page=100");
    let out = run_gh(None, &["api", &endpoint], GH_NETWORK_TIMEOUT).await?;
    let forks: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the fork list: {e}")))?;
    let hit = forks.as_array().and_then(|arr| {
        arr.iter()
            .find(|fork| {
                fork.get("owner")
                    .and_then(|o| o.get("login"))
                    .and_then(Value::as_str)
                    .is_some_and(|l| l.eq_ignore_ascii_case(login))
            })
            .cloned()
    });
    Ok(hit)
}

/// Poll a fork's `commits?per_page=1` up to 5 times (2s apart) — the fork is
/// cloneable once GitHub has populated it. Returns `true` on the first success,
/// `false` if it never became ready in the bound (not an error).
async fn poll_fork_ready(full_name: &str) -> bool {
    let endpoint = format!("repos/{full_name}/commits?per_page=1");
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if let Ok(out) = run_gh_raw(None, &["api", &endpoint], GH_TIMEOUT).await {
            if out.code == 0 {
                return true;
            }
        }
    }
    false
}

/// Star (`PUT`) or unstar (`DELETE`) a repo by name for the signed-in user via
/// `user/starred/{owner}/{name}` — idempotent on GitHub's side.
pub async fn star_repo(owner: &str, name: &str, star: bool) -> AppResult<()> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let endpoint = format!("user/starred/{owner}/{name}");
    let method = if star { "PUT" } else { "DELETE" };
    run_gh(None, &["api", "--method", method, &endpoint], GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Whether a failed `gh api` invocation's stderr looks like a 404 (Not Found) — the
/// signal that a resource is absent (README missing, star not present) rather than a
/// transport/auth/rate-limit failure that must be surfaced. gh prints the HTTP status
/// on stderr (`HTTP 404: Not Found (…)`). Pure, so it's unit-testable.
fn gh_stderr_is_404(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("404") || s.contains("not found")
}

/// Whether the signed-in user has starred `owner/name`. `GET
/// user/starred/{owner}/{name}` answers 204 (starred) / 404 (not). A 404 → `false`;
/// ANY other non-zero exit (403 rate-limit, 5xx, auth) is a real failure and
/// surfaces as `Err` rather than masquerading as "not starred".
pub async fn starred(owner: &str, name: &str) -> AppResult<bool> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let endpoint = format!("user/starred/{owner}/{name}");
    let out = run_gh_raw(None, &["api", "--method", "GET", &endpoint], GH_TIMEOUT).await?;
    if out.code == 0 {
        return Ok(true);
    }
    if gh_stderr_is_404(&out.stderr) {
        return Ok(false);
    }
    let msg = out.stderr.trim();
    Err(AppError::Gh(if msg.is_empty() {
        format!("gh exited with code {} checking the star", out.code)
    } else {
        msg.to_string()
    }))
}

/// A repo's raw README markdown, or `None` when it has none. `gh api
/// repos/{owner}/{name}/readme` with the `raw` media type returns the body; a 404
/// (no README) reads as `None` rather than an error.
pub async fn repo_readme(owner: &str, name: &str) -> AppResult<Option<String>> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let endpoint = format!("repos/{owner}/{name}/readme");
    let out = run_gh_raw(
        None,
        &["api", &endpoint, "-H", "Accept: application/vnd.github.raw"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        if gh_stderr_is_404(&out.stderr) {
            return Ok(None);
        }
        let msg = out.stderr.trim();
        return Err(AppError::Gh(if msg.is_empty() {
            format!("gh exited with code {} reading the README", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(Some(crate::forge::cap_readme(&out.stdout_lossy())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_is_fork_of_verifies_parent_not_just_the_name() {
        // A genuine fork of the source verifies.
        let real = serde_json::json!({
            "full_name": "me/rust",
            "fork": true,
            "parent": { "full_name": "rust-lang/rust" }
        });
        assert!(repo_is_fork_of(&real, "rust-lang/rust"));
        // Case-insensitive parent match (GitHub nwo is case-insensitive).
        assert!(repo_is_fork_of(&real, "Rust-Lang/Rust"));
        // A pre-existing UNRELATED repo the caller owns at the same name: not a fork,
        // or a fork of a different parent → rejected (this is the collision bug).
        let unrelated = serde_json::json!({ "full_name": "me/rust", "fork": false });
        assert!(!repo_is_fork_of(&unrelated, "rust-lang/rust"));
        let wrong_parent = serde_json::json!({
            "full_name": "me/rust",
            "fork": true,
            "parent": { "full_name": "someone-else/rust" }
        });
        assert!(!repo_is_fork_of(&wrong_parent, "rust-lang/rust"));
        // A fork object with no parent field → rejected.
        let no_parent = serde_json::json!({ "full_name": "me/rust", "fork": true });
        assert!(!repo_is_fork_of(&no_parent, "rust-lang/rust"));
    }

    #[test]
    fn gh_stderr_404_distinguishes_absence_from_other_failures() {
        // gh's real 404 stderr shape.
        assert!(gh_stderr_is_404("HTTP 404: Not Found (https://api.github.com/…)"));
        assert!(gh_stderr_is_404("gh: Not Found"));
        // Rate limit, auth, and 5xx are NOT absence — they must surface.
        assert!(!gh_stderr_is_404("HTTP 403: API rate limit exceeded"));
        assert!(!gh_stderr_is_404("HTTP 401: Bad credentials"));
        assert!(!gh_stderr_is_404("HTTP 500: Internal Server Error"));
        assert!(!gh_stderr_is_404(""));
    }

    #[test]
    fn github_sort_args_map_each_sort() {
        assert_eq!(github_sort_args("best"), Vec::<&str>::new());
        assert_eq!(github_sort_args("stars"), vec!["-f", "sort=stars", "-f", "order=desc"]);
        assert_eq!(github_sort_args("updated"), vec!["-f", "sort=updated", "-f", "order=desc"]);
    }

    #[test]
    fn github_has_more_respects_page_and_1000_cap() {
        // Page 1 of 100 total → more pages.
        assert!(github_has_more(1, 100));
        // Exactly consumed (page 4 * 30 = 120 >= 100) → no more.
        assert!(!github_has_more(4, 100));
        // The 1000 cap bites even when total_count is huge: page 33*30 = 990 < 1000.
        assert!(github_has_more(33, 50_000));
        // page 34 * 30 = 1020 >= 1000 → no more, despite 50k reported.
        assert!(!github_has_more(34, 50_000));
        // Empty result set.
        assert!(!github_has_more(1, 0));
    }

    #[test]
    fn search_repo_from_value_parses_and_skips_malformed() {
        let item = serde_json::json!({
            "full_name": "rust-lang/rust",
            "name": "rust",
            "owner": { "login": "rust-lang" },
            "private": false,
            "archived": false,
            "fork": false,
            "clone_url": "https://github.com/rust-lang/rust.git",
            "ssh_url": "git@github.com:rust-lang/rust.git",
            "description": "The Rust language",
            "pushed_at": "2026-01-01T00:00:00Z",
            "stargazers_count": 90000,
            "language": "Rust",
            "html_url": "https://github.com/rust-lang/rust",
            "default_branch": "master"
        });
        let r = search_repo_from_value(&item).expect("parses a well-formed item");
        assert_eq!(r.full_name, "rust-lang/rust");
        assert_eq!(r.owner, "rust-lang");
        assert_eq!(r.stars, Some(90000));
        assert_eq!(r.language.as_deref(), Some("Rust"));
        assert_eq!(r.default_branch.as_deref(), Some("master"));
        // GitHub's REST `items[].name` is already the URL SLUG (not a display name),
        // `owner.login` the URL owner, and `full_name` their join — so the identity
        // every by-owner/name command depends on holds natively.
        assert_eq!(r.name, "rust");
        assert_eq!(format!("{}/{}", r.owner, r.name), r.full_name);
        // A missing full_name skips the item rather than sinking the batch.
        assert!(search_repo_from_value(&serde_json::json!({ "name": "x" })).is_none());
        // An empty full_name is also skipped.
        assert!(search_repo_from_value(&serde_json::json!({ "full_name": "" })).is_none());
    }

    #[test]
    fn credential_entries_are_reset_then_helper_for_default_host() {
        let entries = github_credential_entries("github.com", "/abs/gh");
        assert_eq!(entries.len(), 2);
        // entry[0] resets the helper chain: empty value, nothing after the `=`.
        assert_eq!(entries[0], "credential.https://github.com.helper=");
        assert_eq!(
            entries[1],
            "credential.https://github.com.helper=!\"/abs/gh\" auth git-credential"
        );
    }

    #[test]
    fn credential_entries_substitute_enterprise_host() {
        let entries = github_credential_entries("github.example.com", "/abs/gh");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], "credential.https://github.example.com.helper=");
        assert_eq!(
            entries[1],
            "credential.https://github.example.com.helper=!\"/abs/gh\" auth git-credential"
        );
    }

    // --- gh-auth TTL cache (mirrors remote.rs's cache tests). Distinct host keys
    // per test — the cache is a process-wide static shared across all tests. ---

    const BIG: std::time::Duration = std::time::Duration::from_secs(3600);

    #[test]
    fn auth_cache_put_then_get_within_ttl_hits() {
        auth_cache_put("cache-a.example.com", true);
        assert_eq!(auth_cache_get("cache-a.example.com", BIG), Some(true));
        auth_cache_put("cache-a-false.example.com", false);
        assert_eq!(auth_cache_get("cache-a-false.example.com", BIG), Some(false));
    }

    #[test]
    fn auth_cache_zero_ttl_is_always_expired() {
        auth_cache_put("cache-b.example.com", true);
        // Zero TTL: any elapsed time is >= the TTL, so the entry reads as expired.
        assert_eq!(
            auth_cache_get("cache-b.example.com", std::time::Duration::ZERO),
            None
        );
    }

    #[test]
    fn auth_cache_distinct_hosts_do_not_collide() {
        auth_cache_put("cache-c-one.example.com", true);
        auth_cache_put("cache-c-two.example.com", false);
        assert_eq!(auth_cache_get("cache-c-one.example.com", BIG), Some(true));
        assert_eq!(auth_cache_get("cache-c-two.example.com", BIG), Some(false));
    }

    #[test]
    fn auth_cache_miss_returns_none() {
        assert_eq!(auth_cache_get("cache-never-written.example.com", BIG), None);
    }

    #[test]
    fn recognized_repo_maps_to_github_with_full_capabilities() {
        let gh = GhStatus {
            installed: true,
            authenticated: true,
            repo: Some("owner/name".into()),
            host: Some("github.com".into()),
            login: Some("me".into()),
        };
        let f = from_gh_status(gh);
        assert_eq!(f.provider, Some(Provider::GitHub));
        assert_eq!(f.repo.as_deref(), Some("owner/name"));
        assert_eq!(f.host.as_deref(), Some("github.com"));
        assert!(f.installed && f.authenticated);
        assert!(f.capabilities.discussions && f.capabilities.pull_requests);
    }

    #[test]
    fn unrecognized_repo_has_no_provider_or_capabilities() {
        // gh installed + signed in, but this folder isn't a GitHub repo.
        let gh = GhStatus {
            installed: true,
            authenticated: true,
            repo: None,
            host: None,
            login: None,
        };
        let f = from_gh_status(gh);
        assert_eq!(f.provider, None);
        assert!(f.installed && f.authenticated);
        assert!(!f.capabilities.pull_requests && !f.capabilities.ci);
    }
}
