//! The GitHub [`Forge`](super::Forge) implementation.
//!
//! GitHub already works and ships, and `gh` handles Enterprise hosts and
//! multi-account auth for free — so this impl is a **thin adapter** over the
//! existing `github::*` (gh-CLI-backed) code, never a rewrite. Phase 0 only maps
//! `gh_status` → the neutral [`ForgeStatus`]; later phases add the PR/issue/CI
//! methods, each delegating to the matching `gh_*` function.

use crate::error::AppResult;
use crate::forge::model::{
    Capabilities, ForgeRepo, ForgeRepoList, ForgeStatus, Implemented, Provider,
};
use crate::forge::Forge;
use crate::github::pr::{gh_list_repos, gh_status, GhRepo, GhStatus};

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
        // Delegate to the existing gh-backed status (Enterprise- and
        // multi-account-aware) and normalize its result.
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

/// The signed-in GitHub user's repositories, for the clone browser — delegates to
/// the existing `gh_list_repos` and normalizes.
pub async fn list_repos() -> AppResult<ForgeRepoList> {
    let gh = gh_list_repos().await?;
    Ok(ForgeRepoList {
        viewer: gh.viewer,
        repos: gh.repos.into_iter().map(from_gh_repo).collect(),
    })
}

// ── Pull requests ────────────────────────────────────────────────────────────
//
// Thin delegates to the existing gh-backed commands. The frontend already speaks
// `PrInfo`/`PrDetails`, so the GitHub path is byte-identical to calling `gh_pr_*`
// directly — the abstraction adds the dispatch seam without changing GitHub.

pub async fn list_prs(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    crate::github::pr::gh_pr_list(repo_path.to_string(), state.to_string(), limit).await
}

pub async fn view_pr(repo_path: &str, number: u64) -> AppResult<crate::github::pr::PrDetails> {
    crate::github::pr::gh_pr_view(repo_path.to_string(), number).await
}

pub async fn pr_timeline(
    repo_path: &str,
    number: u64,
) -> AppResult<Vec<crate::github::pr::PrTimelineEventOut>> {
    crate::github::pr::pr_timeline(repo_path, number).await
}

pub async fn diff_pr(repo_path: &str, number: u64) -> AppResult<String> {
    crate::github::pr::gh_pr_diff(repo_path.to_string(), number).await
}

pub async fn commit_diff(repo_path: &str, oid: &str) -> AppResult<String> {
    crate::github::pr::commit_diff(repo_path, oid).await
}

pub async fn commit_comments(
    repo_path: &str,
    sha: &str,
) -> AppResult<Vec<crate::github::pr::CommitCommentOut>> {
    crate::github::pr::commit_comments(repo_path, sha).await
}

/// Create a commit comment. GitHub anchored comments use `path` + `position`; `line`
/// is ignored (the frontend computes the diff-position).
pub async fn commit_comment_create(
    repo_path: &str,
    sha: &str,
    body: &str,
    path: Option<&str>,
    position: Option<u64>,
) -> AppResult<()> {
    crate::github::pr::commit_comment_create(repo_path, sha, body, path, position).await
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
) -> AppResult<()> {
    crate::github::pr::thread_create(repo_path, number, path, line, side, start_line, body).await
}

pub async fn review_submit(
    repo_path: &str,
    number: u64,
    verdict: &str,
    summary: Option<&str>,
    comments: &[crate::github::pr::DraftCommentIn],
) -> AppResult<crate::github::pr::ReviewSubmitOut> {
    crate::github::pr::review_submit(repo_path, number, verdict, summary, comments).await
}

pub async fn external_reviews(
    repo_path: &str,
    number: u64,
) -> AppResult<Vec<crate::github::pr::ExternalReviewItem>> {
    crate::github::pr::gh_pr_external_reviews(repo_path.to_string(), number).await
}

pub async fn review_threads(
    repo_path: &str,
    number: u64,
) -> AppResult<Vec<crate::github::pr::ReviewThreadOut>> {
    crate::github::pr::gh_pr_review_threads(repo_path.to_string(), number).await
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
// Thin delegates to the existing gh-backed PR mutations — comment, close/reopen,
// title/body edit, and the duplicate probe. Merge dispatches straight to
// `gh_pr_merge` inside `forge_pr_merge` (no delegate here); full reviews stay
// GitHub-only and aren't fronted.

pub async fn edit_pr(repo_path: &str, number: u64, title: &str, body: &str) -> AppResult<()> {
    crate::github::pr::gh_pr_edit(
        repo_path.to_string(),
        number,
        title.to_string(),
        body.to_string(),
    )
    .await
}

pub async fn prs_for_branch(
    repo_path: &str,
    head: &str,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    crate::github::pr::gh_prs_for_branch(repo_path.to_string(), head.to_string()).await
}

pub async fn comment_pr(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    crate::github::pr::gh_pr_comment(repo_path.to_string(), number, body.to_string()).await
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

pub async fn close_pr(repo_path: &str, number: u64) -> AppResult<()> {
    crate::github::pr::gh_pr_close(repo_path.to_string(), number).await
}

pub async fn reopen_pr(repo_path: &str, number: u64) -> AppResult<()> {
    crate::github::pr::gh_pr_reopen(repo_path.to_string(), number).await
}

// ── Issues (read) ────────────────────────────────────────────────────────────
//
// Thin delegates to the existing gh-backed issue commands, mirroring the PR ones.

pub async fn list_issues(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
) -> AppResult<Vec<crate::github::issue::IssueInfo>> {
    crate::github::issue::gh_issue_list(repo_path.to_string(), state.to_string(), limit).await
}

pub async fn view_issue(
    repo_path: &str,
    number: u64,
) -> AppResult<crate::github::issue::IssueDetails> {
    crate::github::issue::gh_issue_view(repo_path.to_string(), number).await
}

// ── CI / Actions ─────────────────────────────────────────────────────────────
//
// Thin delegates to the existing gh-backed Actions commands, mirroring the
// PR/issue ones — reads plus the re-run / cancel / dispatch writes.

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
// Thin delegates to the existing gh-backed release commands — reads plus the
// create / edit / delete / asset writes. (Notes generation and asset download
// stay GitHub-only `gh_*` commands: GitLab has no analogue.)

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
    latest: bool,
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
// Thin delegates to the existing gh-backed issue mutations. The still-unfronted
// remainder of the issue write surface (pin, sub-issues, close reason, …) stays
// GitHub-only.

pub async fn comment_issue(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    crate::github::issue::gh_issue_comment(repo_path.to_string(), number, body.to_string()).await
}

pub async fn close_issue(repo_path: &str, number: u64, reason: &str) -> AppResult<()> {
    crate::github::issue::gh_issue_close(repo_path.to_string(), number, reason.to_string()).await
}

pub async fn reopen_issue(repo_path: &str, number: u64) -> AppResult<()> {
    crate::github::issue::gh_issue_reopen(repo_path.to_string(), number).await
}

pub async fn edit_issue(repo_path: &str, number: u64, title: &str, body: &str) -> AppResult<()> {
    crate::github::issue::gh_issue_edit(
        repo_path.to_string(),
        number,
        title.to_string(),
        body.to_string(),
    )
    .await
}

pub async fn lock_issue(repo_path: &str, number: u64, reason: Option<String>) -> AppResult<()> {
    crate::github::issue::gh_issue_lock(repo_path.to_string(), number, reason).await
}

pub async fn unlock_issue(repo_path: &str, number: u64) -> AppResult<()> {
    crate::github::issue::gh_issue_unlock(repo_path.to_string(), number).await
}

pub async fn transfer_issue(repo_path: &str, number: u64, destination: &str) -> AppResult<String> {
    crate::github::issue::gh_issue_transfer(repo_path.to_string(), number, destination.to_string())
        .await
}

pub async fn delete_issue(repo_path: &str, number: u64) -> AppResult<()> {
    crate::github::issue::gh_issue_delete(repo_path.to_string(), number).await
}

// ── Milestones (read + write) ──────────────────────────────────────────────────
//
// Thin delegates for the milestone picker's option list and the issue milestone
// write. GitHub keys on the milestone number; the GitLab impl keys on its global
// milestone id — both travel as the neutral `Milestone.number`.

pub async fn milestones(repo_path: &str) -> AppResult<Vec<crate::github::issue::Milestone>> {
    crate::github::issue::gh_milestones(repo_path.to_string()).await
}

// ── Repository actions & publish ───────────────────────────────────────────────
//
// Thin delegates for View/star and publish. Fork keeps calling `gh_repo_fork`
// directly (its remote-rewiring flow is GitHub-only; GitLab forks via a web
// link-out), and the admin/branch-rule sub-surfaces stay on their gh_* commands.

pub async fn repo_url(repo_path: &str) -> AppResult<String> {
    crate::github::pr::gh_repo_url(repo_path.to_string()).await
}

pub async fn repo_star_status(repo_path: &str) -> AppResult<bool> {
    crate::github::pr::gh_repo_star_status(repo_path.to_string()).await
}

pub async fn repo_set_star(repo_path: &str, starred: bool) -> AppResult<()> {
    crate::github::pr::gh_repo_set_star(repo_path.to_string(), starred).await
}

pub async fn repo_visibility(repo_path: &str) -> AppResult<String> {
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
// Thin delegates to the gh-backed reaction reads and the node-id-keyed toggle.
// GitHub subjects are GraphQL node ids, so the add/remove delegates ignore the
// target/number the GitLab arm needs — the frontend carries both (the shared-
// control different-identifiers pattern).

pub async fn issue_reactions(
    repo_path: &str,
    number: u64,
) -> AppResult<crate::github::issue::IssueReactions> {
    crate::github::issue::gh_issue_reactions(repo_path.to_string(), number).await
}

pub async fn pr_reactions(
    repo_path: &str,
    number: u64,
) -> AppResult<crate::github::issue::IssueReactions> {
    crate::github::pr::gh_pr_reactions(repo_path.to_string(), number).await
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
) -> AppResult<()> {
    crate::github::issue::gh_issue_set_milestone(repo_path.to_string(), number, milestone).await
}

// ── Labels & assignees (read + write) ─────────────────────────────────────────
//
// Thin delegates to the existing gh-backed label/assignee commands. Labels are a
// shared control on both issues and MRs (GitHub keys them by GraphQL node id); issue
// assignees are a shared issue control. GitHub is byte-identical to calling the
// `gh_*` commands directly — the abstraction only adds the dispatch seam.

pub async fn repo_labels(repo_path: &str) -> AppResult<Vec<crate::github::pr::RepoLabel>> {
    crate::github::pr::gh_repo_labels(repo_path.to_string()).await
}

pub async fn assignable_users(
    repo_path: &str,
) -> AppResult<Vec<crate::forge::model::ForgeUserRef>> {
    // GitHub carries no avatar in the assignees endpoint; the picker derives it
    // from the login (id), so leave `avatar_url` empty and let the frontend fill it.
    Ok(
        crate::github::issue::gh_assignable_users(repo_path.to_string())
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

pub async fn set_pr_reviewers(repo_path: &str, number: u64, reviewers: &[String]) -> AppResult<()> {
    crate::github::pr::set_pr_reviewers(repo_path, number, reviewers).await
}

pub async fn reviewer_candidates(
    repo_path: &str,
    number: Option<u64>,
) -> AppResult<Vec<crate::forge::model::ForgeUserRef>> {
    crate::github::pr::reviewer_candidates(repo_path, number).await
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
) -> AppResult<()> {
    crate::github::issue::gh_issue_set_assignees(repo_path.to_string(), number, assignees).await
}

/// Create an issue — delegates to the gh-backed REST create with the full GitHub
/// field set (labels/assignees/milestone/org issue type). (PR create has no delegate
/// here: `forge_pr_create`'s GitHub arm calls `gh_pr_create_core` directly, since the
/// push needs an `AppState`, like `forge_pr_merge`.)
pub async fn create_issue(
    repo_path: &str,
    title: &str,
    body: &str,
    labels: Vec<String>,
    assignees: Vec<String>,
    milestone: Option<u64>,
    issue_type: Option<String>,
) -> AppResult<crate::github::pr::PrRef> {
    crate::github::issue::gh_issue_create(
        repo_path.to_string(),
        title.to_string(),
        body.to_string(),
        labels,
        assignees,
        milestone,
        issue_type,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
