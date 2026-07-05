use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git_mutating, NETWORK_TIMEOUT};
use crate::github::issue::{map_reaction_groups, repo_owner_name, IssueReactions};
use crate::github::runner::{run_gh, run_gh_raw, GH_NETWORK_TIMEOUT, GH_TIMEOUT};
use crate::state::AppState;

fn validate_branch(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid branch: {name}")));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    /// "owner/name" when this repo has a GitHub remote gh recognizes.
    pub repo: Option<String>,
    /// The repo's GitHub host — "github.com" or an Enterprise server like
    /// "github.acme.com" — when it's a recognized GitHub repo. gh derives it
    /// from the repo's remote, so we don't assume github.com anywhere.
    pub host: Option<String>,
    /// The active account's login on this repo's host, when it can be determined.
    pub login: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoView {
    name_with_owner: String,
    url: String,
}

/// The host of a repo URL like `https://github.acme.com/owner/repo` →
/// `github.acme.com`. None when it isn't an http(s)-style URL. Tolerates an
/// optional `user@` prefix and `:port` suffix.
fn host_from_url(url: &str) -> Option<String> {
    let after = url.split_once("://").map(|(_, rest)| rest)?;
    let authority = after.split('/').next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    (!host.is_empty()).then(|| host.to_string())
}

/// Probes the GitHub CLI: present on PATH, logged in, and pointing at a
/// GitHub repo. Drives whether the PR features are offered at all. Host-aware:
/// resolves the repo's host (github.com or Enterprise) and the active login on
/// that host.
#[tauri::command]
pub async fn gh_status(repo_path: String) -> AppResult<GhStatus> {
    match run_gh_raw(None, &["--version"], GH_TIMEOUT).await {
        Err(AppError::GhNotFound) => {
            return Ok(GhStatus {
                installed: false,
                authenticated: false,
                repo: None,
                host: None,
                login: None,
            });
        }
        Err(e) => return Err(e),
        Ok(_) => {}
    }

    // `gh auth status` exits 0 only when a host is logged in. Its report
    // (stderr on old gh, stdout on newer) names the account(s) per host.
    let (authenticated, accounts) = match run_gh_raw(None, &["auth", "status"], GH_TIMEOUT).await {
        Ok(out) => {
            let report = format!("{}\n{}", out.stdout_lossy(), out.stderr);
            (out.code == 0, parse_auth_accounts(&report))
        }
        Err(_) => (false, Vec::new()),
    };

    // gh auto-detects the repo's host from its remote, so this resolves
    // nameWithOwner + the canonical URL on github.com OR an Enterprise server.
    let view = if authenticated {
        run_gh_raw(
            Some(&repo_path),
            &["repo", "view", "--json", "nameWithOwner,url"],
            GH_TIMEOUT,
        )
        .await
        .ok()
        .filter(|o| o.code == 0)
        .and_then(|o| serde_json::from_str::<RepoView>(&o.stdout_lossy()).ok())
    } else {
        None
    };
    let repo = view.as_ref().map(|v| v.name_with_owner.clone());
    let host = view.as_ref().and_then(|v| host_from_url(&v.url));

    // The active login on the repo's host (each host has its own active
    // account); fall back to any active account when the host is unknown.
    let login = accounts
        .iter()
        .find(|a| a.active && host.as_deref() == Some(a.host.as_str()))
        .or_else(|| accounts.iter().find(|a| a.active))
        .map(|a| a.login.clone());

    Ok(GhStatus {
        installed: true,
        authenticated,
        repo,
        host,
        login,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    pub name_with_owner: String,
    pub owner: String,
    pub name: String,
    pub private: bool,
    pub archived: bool,
    pub fork: bool,
    pub clone_url: String,
    pub ssh_url: String,
    pub description: Option<String>,
    /// ISO-8601 last-push time, for recency sorting.
    pub pushed_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepoList {
    /// The signed-in user's login, so the UI can list their own repos first.
    pub viewer: String,
    pub repos: Vec<GhRepo>,
}

/// Every repository the signed-in user can access (owned, collaborator, and
/// org member), newest-push first, plus the viewer's login. Used by the
/// clone dialog's GitHub.com tab. `--paginate` merges all pages into one
/// JSON array.
#[tauri::command]
pub async fn gh_list_repos() -> AppResult<GhRepoList> {
    // The viewer's login is cheap and lets the UI group their repos first.
    let viewer = run_gh(None, &["api", "user", "-q", ".login"], GH_TIMEOUT)
        .await?
        .stdout_lossy()
        .trim()
        .to_string();

    let out = run_gh(
        None,
        &[
            "api",
            "--paginate",
            "-X",
            "GET",
            "user/repos",
            "-f",
            "per_page=100",
            "-f",
            "affiliation=owner,collaborator,organization_member",
            "-f",
            "sort=pushed",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;

    #[derive(Deserialize)]
    struct ApiOwner {
        login: String,
    }
    #[derive(Deserialize)]
    struct ApiRepo {
        full_name: String,
        name: String,
        owner: ApiOwner,
        private: bool,
        archived: bool,
        fork: bool,
        clone_url: String,
        ssh_url: String,
        description: Option<String>,
        pushed_at: Option<String>,
    }
    let parsed: Vec<ApiRepo> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse your repositories: {e}")))?;
    let repos = parsed
        .into_iter()
        .map(|r| GhRepo {
            name_with_owner: r.full_name,
            owner: r.owner.login,
            name: r.name,
            private: r.private,
            archived: r.archived,
            fork: r.fork,
            clone_url: r.clone_url,
            ssh_url: r.ssh_url,
            description: r.description,
            pushed_at: r.pushed_at,
        })
        .collect();
    Ok(GhRepoList { viewer, repos })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccount {
    /// The host this account is signed in to ("github.com" or an Enterprise
    /// server). Accounts are grouped by host in the UI and switched per host.
    pub host: String,
    pub login: String,
    pub active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhAccounts {
    /// gh's version (e.g. "2.18.1"), "" when gh isn't installed.
    pub version: String,
    pub accounts: Vec<GhAccount>,
}

/// The gh CLI's signed-in accounts and version (account switching needs
/// gh ≥ 2.40).
#[tauri::command]
pub async fn gh_accounts() -> AppResult<GhAccounts> {
    let version = match run_gh_raw(None, &["--version"], GH_TIMEOUT).await {
        Err(AppError::GhNotFound) => {
            return Ok(GhAccounts {
                version: String::new(),
                accounts: Vec::new(),
            });
        }
        Err(e) => return Err(e),
        // "gh version 2.18.1 (2022-10-20)" → "2.18.1"
        Ok(out) => out
            .stdout_lossy()
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(2))
            .unwrap_or("")
            .to_string(),
    };
    let accounts = match run_gh_raw(None, &["auth", "status"], GH_TIMEOUT).await {
        Ok(out) => {
            let report = format!("{}\n{}", out.stdout_lossy(), out.stderr);
            parse_auth_accounts(&report)
                .into_iter()
                .map(|a| GhAccount {
                    host: a.host,
                    login: a.login,
                    active: a.active,
                })
                .collect()
        }
        Err(_) => Vec::new(),
    };
    Ok(GhAccounts { version, accounts })
}

/// Switches the active gh account on a specific host (gh ≥ 2.40; older gh
/// errors, which the UI surfaces with an upgrade hint). The host is required so
/// switching works on Enterprise servers, not just github.com.
#[tauri::command]
pub async fn gh_switch_account(host: String, login: String) -> AppResult<()> {
    if login.is_empty()
        || !login
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(AppError::InvalidArgument(format!("invalid login: {login}")));
    }
    // A hostname: letters, digits, dots, hyphens (no slashes, spaces, or flags).
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return Err(AppError::InvalidArgument(format!("invalid host: {host}")));
    }
    run_gh(
        None,
        &["auth", "switch", "--hostname", &host, "--user", &login],
        GH_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// One account from a `gh auth status` report.
struct ParsedAccount {
    host: String,
    login: String,
    active: bool,
}

/// Accounts from a `gh auth status` report, with the active one per host
/// flagged. Handles both formats: old gh prints "Logged in to <host> as
/// <login>", gh 2.40+ prints "Logged in to <host> account <login>" with a
/// separate "Active account: true" line per account.
fn parse_auth_accounts(report: &str) -> Vec<ParsedAccount> {
    let mut accounts: Vec<ParsedAccount> = Vec::new();
    for line in report.lines() {
        if let Some(after) = line.split_once("Logged in to ").map(|(_, rest)| rest) {
            // after = "<host> as <login> (...)" (old gh) or
            //         "<host> account <login> (...)" (gh 2.40+).
            let host = after.split_whitespace().next().unwrap_or("").to_string();
            let login = after
                .split_once(" as ")
                .or_else(|| after.split_once(" account "))
                .map(|(_, rest)| rest)
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or("")
                .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-')
                .to_string();
            if !host.is_empty() && !login.is_empty() {
                accounts.push(ParsedAccount {
                    host,
                    login,
                    active: false,
                });
            }
        } else if line.contains("Active account: true") {
            if let Some(last) = accounts.last_mut() {
                last.active = true;
            }
        }
    }
    // Old gh (<2.40) has no "Active account" line and one account per host —
    // each is the active account for its own host.
    if !accounts.is_empty() && !accounts.iter().any(|a| a.active) {
        for a in &mut accounts {
            a.active = true;
        }
    }
    accounts
}

/// Creates a GitHub repository from the local one, wires up `origin`, and
/// pushes the current branch — GitHub Desktop's "Publish repository". `name`
/// may be `repo` (under your account) or `owner/repo` (under an org).
#[tauri::command]
pub async fn gh_publish_repo(
    repo_path: String,
    name: String,
    private: bool,
    description: String,
    homepage: String,
    topics: Vec<String>,
) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "a repository name is required".into(),
        ));
    }
    let visibility = if private { "--private" } else { "--public" };
    let description = description.trim();
    let homepage = homepage.trim();
    let mut args: Vec<&str> = vec![
        "repo", "create", name, "--source", ".", "--remote", "origin", "--push", visibility,
    ];
    if !description.is_empty() {
        args.push("--description");
        args.push(description);
    }
    if !homepage.is_empty() {
        args.push("--homepage");
        args.push(homepage);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;

    // `gh repo create` can't set topics, so apply them with a follow-up edit.
    // Best-effort: the repo + push already succeeded, so a topic hiccup must not
    // fail the publish. The new repo is `origin`, so no repo arg is needed.
    let topics: Vec<String> = topics
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if !topics.is_empty() {
        let mut edit_args: Vec<&str> = vec!["repo", "edit"];
        for t in &topics {
            edit_args.push("--add-topic");
            edit_args.push(t);
        }
        let _ = run_gh(Some(&repo_path), &edit_args, GH_NETWORK_TIMEOUT).await;
    }

    // gh's create output is human-prose on stderr; read back the canonical URL.
    gh_repo_url(repo_path).await
}

/// The repository's web URL (works for github.com and GitHub Enterprise).
/// Append paths like `/issues/new` for specific pages.
#[tauri::command]
pub async fn gh_repo_url(repo_path: String) -> AppResult<String> {
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "url", "-q", ".url"],
        GH_TIMEOUT,
    )
    .await?;
    let url = out.stdout_lossy().trim().to_string();
    if url.is_empty() {
        return Err(AppError::Gh(
            "could not determine the repository URL".into(),
        ));
    }
    Ok(url)
}

/// Whether the signed-in user has starred this repo.
/// `GET /user/starred/{owner}/{repo}` answers 204 (starred) or 404 (not),
/// which gh surfaces as exit 0 / non-zero — hence `run_gh_raw`, so a 404 reads
/// as "not starred" rather than erroring. gh resolves `{owner}/{repo}` from the
/// repo at `repo_path`.
#[tauri::command]
pub async fn gh_repo_star_status(repo_path: String) -> AppResult<bool> {
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", "--method", "GET", "user/starred/{owner}/{repo}"],
        GH_TIMEOUT,
    )
    .await?;
    Ok(out.code == 0)
}

/// Stars (PUT) or unstars (DELETE) this repo for the signed-in user via
/// `/user/starred/{owner}/{repo}`. Both are idempotent on GitHub's side.
#[tauri::command]
pub async fn gh_repo_set_star(repo_path: String, starred: bool) -> AppResult<()> {
    let method = if starred { "PUT" } else { "DELETE" };
    run_gh(
        Some(&repo_path),
        &["api", "--method", method, "user/starred/{owner}/{repo}"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub number: u64,
    pub url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAuthor {
    pub login: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrListLabel {
    pub name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub is_draft: bool,
    pub state: String,
    // Defaults tolerate callers that don't request these fields.
    #[serde(default)]
    pub author: Option<PrAuthor>,
    #[serde(default)]
    pub labels: Vec<PrListLabel>,
}

/// Submits a review: `action` is "approve", "comment", or "request_changes".
/// gh requires a body for comment/request-changes (it surfaces the error).
#[tauri::command]
pub async fn gh_pr_review(
    repo_path: String,
    number: u64,
    action: String,
    body: String,
) -> AppResult<()> {
    let n = number.to_string();
    let flag = match action.as_str() {
        "approve" => "--approve",
        "comment" => "--comment",
        "request_changes" => "--request-changes",
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unknown review action: {action}"
            )));
        }
    };
    let body = body.trim();
    let mut args = vec!["pr", "review", &n, flag];
    if !body.is_empty() {
        args.push("--body");
        args.push(body);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Adds a standalone comment to the PR conversation.
#[tauri::command]
pub async fn gh_pr_comment(repo_path: String, number: u64, body: String) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let n = number.to_string();
    run_gh(
        Some(&repo_path),
        &["pr", "comment", &n, "--body", &body],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Merges the PR with the given strategy ("merge"/"squash"/"rebase"). When
/// `delete_branch` is set, only the *remote* head branch is removed afterwards —
/// the local branch and HEAD are left untouched.
///
/// We deliberately do NOT pass `gh pr merge --delete-branch`: that also deletes
/// the user's **local** branch and switches HEAD to the default branch, which
/// surprised users and diverged from the other providers (GitLab's
/// `should_remove_source_branch` and Bitbucket's `close_source_branch` are
/// server-side, so they only ever touch the remote). Instead we merge, then
/// delete just the remote ref via the API — remote-only, like the others.
#[tauri::command]
pub async fn gh_pr_merge(
    repo_path: String,
    number: u64,
    strategy: String,
    delete_branch: bool,
) -> AppResult<()> {
    let n = number.to_string();
    let method = match strategy.as_str() {
        "merge" => "--merge",
        "squash" => "--squash",
        "rebase" => "--rebase",
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unknown merge strategy: {strategy}"
            )));
        }
    };
    run_gh(
        Some(&repo_path),
        &["pr", "merge", &n, method],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    if delete_branch {
        gh_delete_remote_head_branch(&repo_path, number).await?;
    }
    Ok(())
}

/// The slice of `gh pr view` needed to delete only the remote head branch after
/// a merge: the ref name plus the repository that branch lives in — the fork for
/// a cross-repository PR, the base repo otherwise. `headRepository` /
/// `headRepositoryOwner` name that repo either way, so we target it explicitly
/// rather than gh's `{owner}/{repo}` placeholders (which resolve to the *base*
/// repo and would risk deleting a same-named branch there for a fork PR).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMergeHead {
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    is_cross_repository: bool,
    head_repository_owner: Option<RawLogin>,
    head_repository: Option<RawRepoName>,
}

#[derive(Deserialize)]
struct RawRepoName {
    #[serde(default)]
    name: String,
}

/// Deletes only the *remote* head branch of a just-merged PR (see `gh_pr_merge`).
/// Best-effort and disclosing: the merge already succeeded, so a delete failure
/// is surfaced as a caveat rather than a merge failure, and a branch that is
/// already gone (e.g. a repo that auto-deletes head branches on merge) counts as
/// success.
async fn gh_delete_remote_head_branch(repo_path: &str, number: u64) -> AppResult<()> {
    let out = run_gh(
        Some(repo_path),
        &[
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "headRefName,isCrossRepository,headRepositoryOwner,headRepository",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let head: RawMergeHead = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not read the PR's head branch: {e}")))?;

    let branch = head.head_ref_name.trim().to_string();
    if branch.is_empty() {
        return Ok(());
    }
    // The fork may have been deleted, or gh couldn't resolve the head repo —
    // either way there is no remote branch of ours left to remove.
    let (Some(owner), Some(repo)) = (
        head.head_repository_owner
            .map(|o| o.login)
            .filter(|s| !s.is_empty()),
        head.head_repository
            .map(|r| r.name)
            .filter(|s| !s.is_empty()),
    ) else {
        return Ok(());
    };

    let endpoint = format!("repos/{owner}/{repo}/git/refs/heads/{branch}");
    match run_gh(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GH_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(err) => {
            let raw = err.to_string();
            let lower = raw.to_ascii_lowercase();
            // Only the explicit missing-ref case (GitHub's 422 "Reference does not
            // exist") is the desired end state — the branch is already gone (the repo
            // auto-deletes head branches, or a prior attempt removed it). A permission
            // failure can return 404 "Not found", so don't swallow that — let it surface.
            if lower.contains("reference does not exist") {
                return Ok(());
            }
            let fork_note = if head.is_cross_repository {
                " (the branch is on a fork, where you may not have permission to delete it)"
            } else {
                ""
            };
            Err(AppError::Gh(format!(
                "Merged #{number}, but the remote branch \"{branch}\" could not be deleted: {raw}{fork_note}"
            )))
        }
    }
}

#[tauri::command]
pub async fn gh_pr_close(repo_path: String, number: u64) -> AppResult<()> {
    let n = number.to_string();
    run_gh(Some(&repo_path), &["pr", "close", &n], GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Reopens a closed (not merged) pull request.
#[tauri::command]
pub async fn gh_pr_reopen(repo_path: String, number: u64) -> AppResult<()> {
    let n = number.to_string();
    run_gh(Some(&repo_path), &["pr", "reopen", &n], GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Edits the body of an existing PR conversation comment, addressed by its
/// GraphQL node id (from `gh pr view`). GitHub only lets the comment's author
/// edit it, so this is offered solely on the viewer's own comments.
#[tauri::command]
pub async fn gh_pr_edit_comment(
    repo_path: String,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}}",
            "-f",
            &format!("id={comment_id}"),
            "-f",
            &format!("body={body}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Permanently deletes a PR conversation comment by its GraphQL node id.
#[tauri::command]
pub async fn gh_pr_delete_comment(repo_path: String, comment_id: String) -> AppResult<()> {
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}",
            "-f",
            &format!("id={comment_id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Hides (minimizes) a comment with a reason. `classifier` is a GitHub
/// `ReportedContentClassifiers` value: SPAM, ABUSE, OFF_TOPIC, OUTDATED,
/// DUPLICATE, or RESOLVED.
#[tauri::command]
pub async fn gh_pr_minimize_comment(
    repo_path: String,
    comment_id: String,
    classifier: String,
) -> AppResult<()> {
    const VALID: [&str; 6] = [
        "SPAM",
        "ABUSE",
        "OFF_TOPIC",
        "OUTDATED",
        "DUPLICATE",
        "RESOLVED",
    ];
    if !VALID.contains(&classifier.as_str()) {
        return Err(AppError::InvalidArgument(format!(
            "invalid classifier: {classifier}"
        )));
    }
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$c:ReportedContentClassifiers!){minimizeComment(input:{subjectId:$id,classifier:$c}){minimizedComment{isMinimized}}}",
            "-f",
            &format!("id={comment_id}"),
            "-f",
            &format!("c={classifier}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Unhides (unminimizes) a previously hidden comment.
#[tauri::command]
pub async fn gh_pr_unminimize_comment(repo_path: String, comment_id: String) -> AppResult<()> {
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){unminimizeComment(input:{subjectId:$id}){unminimizedComment{isMinimized}}}",
            "-f",
            &format!("id={comment_id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Checks out a PR's branch locally (handles fork-sourced PRs too).
#[tauri::command]
pub async fn gh_pr_checkout(repo_path: String, number: u64) -> AppResult<()> {
    let n = number.to_string();
    run_gh(
        Some(&repo_path),
        &["pr", "checkout", &n],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// "owner/repo" from a remote URL — handles https://host/owner/repo(.git)
/// and git@host:owner/repo(.git).
fn name_with_owner_from_url(url: &str) -> Option<String> {
    let cleaned = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let mut parts = cleaned.rsplitn(3, ['/', ':']);
    let repo = parts.next()?;
    let owner = parts.next()?;
    if repo.is_empty() || owner.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// Forks the repo on GitHub. Remotes follow gh's default rewiring (the fork
/// becomes `origin`, the original `upstream`); `contribute_to_parent`
/// decides which of the two `gh repo set-default` points at — that's what
/// PR lists/creation, issues, and "View on GitHub" follow afterwards.
#[tauri::command]
pub async fn gh_repo_fork(repo_path: String, contribute_to_parent: bool) -> AppResult<String> {
    // Before forking, origin still points at the parent.
    let parent = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        GH_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();

    let out = run_gh(
        Some(&repo_path),
        &["repo", "fork", "--remote"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // gh prints progress to stderr; stdout carries the fork's URL when
    // creation succeeds (empty if the fork already existed).
    let fork_url = out.stdout_lossy().trim().to_string();

    let target = if contribute_to_parent {
        parent
    } else {
        // After --remote, origin points at the fork.
        let origin = crate::git::runner::run_git(
            Some(&repo_path),
            &["remote", "get-url", "origin"],
            crate::git::runner::DEFAULT_TIMEOUT,
        )
        .await?
        .stdout_lossy()
        .trim()
        .to_string();
        name_with_owner_from_url(&origin)
            .ok_or_else(|| AppError::Gh(format!("could not parse fork from {origin}")))?
    };
    run_gh(
        Some(&repo_path),
        &["repo", "set-default", &target],
        GH_TIMEOUT,
    )
    .await?;
    Ok(fork_url)
}

/// Marks a draft PR as ready for review.
#[tauri::command]
pub async fn gh_pr_ready(repo_path: String, number: u64) -> AppResult<()> {
    let n = number.to_string();
    run_gh(Some(&repo_path), &["pr", "ready", &n], GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

const PR_LIST_FIELDS: &str =
    "number,url,title,baseRefName,headRefName,isDraft,state,author,labels";

/// PRs for the Pull Requests list. `state` is "open" or "closed"; closed
/// uses the search qualifier so merged PRs are included, matching the
/// semantics of GitHub's own Closed tab.
#[tauri::command]
pub async fn gh_pr_list(repo_path: String, state: String) -> AppResult<Vec<PrInfo>> {
    let args: &[&str] = match state.as_str() {
        "open" => &["pr", "list", "--state", "open", "--json", PR_LIST_FIELDS],
        "closed" => &[
            "pr",
            "list",
            "--search",
            "is:closed",
            "--json",
            PR_LIST_FIELDS,
        ],
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unknown PR state filter: {state}"
            )));
        }
    };
    let out = run_gh(Some(&repo_path), args, GH_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh pr list: {e}")))
}

// NOTE: `gh pr edit` is unusable on older gh versions (its GraphQL query
// still selects the sunset Projects-classic `projectCards` field, which the
// API now rejects outright), so PR edits go through `gh api` instead: REST
// for title/body, GraphQL mutations for labels.

/// Updates a PR's title and body via the REST API.
#[tauri::command]
pub async fn gh_pr_edit(
    repo_path: String,
    number: u64,
    title: String,
    body: String,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("a PR title is required".into()));
    }
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{{owner}}/{{repo}}/pulls/{number}"),
            "-f",
            &format!("title={title}"),
            "-f",
            &format!("body={body}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLabel {
    /// GraphQL node id; needed for the label mutations. May be empty on
    /// labels embedded in `gh pr view` output.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Hex without the leading '#', as GitHub returns it.
    #[serde(default)]
    pub color: String,
}

/// GraphQL node ids and owner/repo names are embedded into query strings;
/// restrict them to their known-safe alphabets so quoting can't be escaped.
fn validate_graphql_embed(value: &str, what: &str) -> AppResult<()> {
    let ok = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '=' | '+' | '/'));
    if ok {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!("invalid {what}: {value}")))
    }
}

/// The repository's labels with their GraphQL node ids, for the PR label
/// picker. (`gh label list --json id` returns empty ids on older gh.)
#[tauri::command]
pub async fn gh_repo_labels(repo_path: String) -> AppResult<Vec<RepoLabel>> {
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        GH_TIMEOUT,
    )
    .await?;
    let name_with_owner = out.stdout_lossy().trim().to_string();
    let Some((owner, name)) = name_with_owner.split_once('/') else {
        return Err(AppError::Gh("could not determine the repository owner".into()));
    };
    validate_graphql_embed(owner, "repository owner")?;
    validate_graphql_embed(name, "repository name")?;

    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ labels(first:100){{ nodes{{ id name color }} }} }} }}"#
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the label query: {e}")))?;
    let nodes = value
        .pointer("/data/repository/labels/nodes")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    serde_json::from_value(nodes)
        .map_err(|e| AppError::Gh(format!("could not parse the label query: {e}")))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhBranchProtection {
    pub pattern: String,
    pub allows_deletions: bool,
    pub allows_force_pushes: bool,
    pub requires_linear_history: bool,
    pub requires_approving_reviews: bool,
}

/// The repo's GitHub branch protection rules (classic, pattern-based), for
/// importing into GitDesktop's own branch rules. Read-only — never writes to
/// GitHub. Reading protection settings needs repo-admin access, so a
/// non-admin viewer simply gets an empty list.
#[tauri::command]
pub async fn gh_branch_protections(repo_path: String) -> AppResult<Vec<GhBranchProtection>> {
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        GH_TIMEOUT,
    )
    .await?;
    let name_with_owner = out.stdout_lossy().trim().to_string();
    let Some((owner, name)) = name_with_owner.split_once('/') else {
        return Err(AppError::Gh("could not determine the repository owner".into()));
    };
    validate_graphql_embed(owner, "repository owner")?;
    validate_graphql_embed(name, "repository name")?;

    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ branchProtectionRules(first:100){{ nodes{{ pattern allowsDeletions allowsForcePushes requiresLinearHistory requiresApprovingReviews }} }} }} }}"#
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the protection query: {e}")))?;
    let nodes = value
        .pointer("/data/repository/branchProtectionRules/nodes")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    serde_json::from_value(nodes)
        .map_err(|e| AppError::Gh(format!("could not parse the protection query: {e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPollInfo {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    pub review_decision: String,
    /// Rollup of the head commit's checks: SUCCESS/FAILURE/PENDING/"".
    pub checks_state: String,
    /// Head commit SHA — lets the poll detect when a PR receives new commits
    /// (drives pr-sync auto re-review for remote PRs, incl. non-local heads).
    pub head_sha: String,
}

/// Lightweight snapshot of the repo's recently-updated PRs for the
/// notification poller — one GraphQL round trip including the check rollup
/// (reliable on old gh, unlike `pr list --json statusCheckRollup`).
#[tauri::command]
pub async fn gh_pr_poll(repo_path: String) -> AppResult<Vec<PrPollInfo>> {
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        GH_TIMEOUT,
    )
    .await?;
    let name_with_owner = out.stdout_lossy().trim().to_string();
    let Some((owner, name)) = name_with_owner.split_once('/') else {
        return Err(AppError::Gh("could not determine the repository owner".into()));
    };
    validate_graphql_embed(owner, "repository owner")?;
    validate_graphql_embed(name, "repository name")?;

    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ pullRequests(first:30, states:[OPEN, CLOSED, MERGED], orderBy:{{field:UPDATED_AT, direction:DESC}}){{ nodes{{ number title url state isDraft author{{login}} reviewDecision commits(last:1){{ nodes{{ commit{{ oid statusCheckRollup{{ state }} }} }} }} }} }} }} }}"#
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR poll: {e}")))?;
    let nodes = value
        .pointer("/data/repository/pullRequests/nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let str_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    Ok(nodes
        .iter()
        .map(|n| PrPollInfo {
            number: n.pointer("/number").and_then(|x| x.as_u64()).unwrap_or(0),
            title: str_at(n, "/title"),
            url: str_at(n, "/url"),
            state: str_at(n, "/state"),
            is_draft: n
                .pointer("/isDraft")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            author: str_at(n, "/author/login"),
            review_decision: str_at(n, "/reviewDecision"),
            checks_state: str_at(n, "/commits/nodes/0/commit/statusCheckRollup/state"),
            head_sha: str_at(n, "/commits/nodes/0/commit/oid"),
        })
        .filter(|p| p.number > 0)
        .collect())
}

/// Adds/removes labels on a PR via GraphQL mutations. `labelable_id` is the
/// PR's GraphQL node id; the label ids come from `gh_repo_labels`.
#[tauri::command]
pub async fn gh_pr_edit_labels(
    repo_path: String,
    labelable_id: String,
    add_ids: Vec<String>,
    remove_ids: Vec<String>,
) -> AppResult<()> {
    if add_ids.is_empty() && remove_ids.is_empty() {
        return Ok(());
    }
    validate_graphql_embed(&labelable_id, "PR id")?;
    for id in add_ids.iter().chain(remove_ids.iter()) {
        validate_graphql_embed(id, "label id")?;
    }

    let quote_list = |ids: &[String]| {
        ids.iter()
            .map(|i| format!(r#""{i}""#))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut parts = Vec::new();
    if !add_ids.is_empty() {
        parts.push(format!(
            r#"a: addLabelsToLabelable(input:{{labelableId:"{labelable_id}", labelIds:[{}]}}){{ clientMutationId }}"#,
            quote_list(&add_ids)
        ));
    }
    if !remove_ids.is_empty() {
        parts.push(format!(
            r#"r: removeLabelsFromLabelable(input:{{labelableId:"{labelable_id}", labelIds:[{}]}}){{ clientMutationId }}"#,
            quote_list(&remove_ids)
        ));
    }
    let query = format!("mutation{{ {} }}", parts.join(" "));
    run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// --- gh pr view: deserialize gh's JSON, then map to a clean frontend shape ---

#[derive(Deserialize)]
struct RawLogin {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct RawCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    #[serde(default)]
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    authored_date: String,
    #[serde(default)]
    authors: Vec<RawCommitAuthor>,
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    path: String,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReview {
    author: Option<RawLogin>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawComment {
    #[serde(default)]
    id: String,
    author: Option<RawLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_minimized: bool,
    #[serde(default)]
    minimized_reason: String,
    #[serde(default)]
    viewer_did_author: bool,
}

/// statusCheckRollup is a union of CheckRun (name/conclusion) and StatusContext
/// (context/state); accept any of the keys and normalize below.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCheck {
    #[serde(default)]
    name: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    conclusion: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    /// GraphQL node id, used by the label mutations.
    #[serde(default)]
    id: String,
    #[serde(default)]
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    author: Option<RawLogin>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
    #[serde(default)]
    url: String,
    #[serde(default)]
    commits: Vec<RawCommit>,
    #[serde(default)]
    files: Vec<RawFile>,
    #[serde(default)]
    reviews: Vec<RawReview>,
    #[serde(default)]
    comments: Vec<RawComment>,
    #[serde(default)]
    status_check_rollup: Vec<RawCheck>,
    #[serde(default)]
    labels: Vec<RepoLabel>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitOut {
    pub oid: String,
    pub headline: String,
    pub date: String,
    pub author: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrFileOut {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrThreadOut {
    pub author: String,
    pub state: String,
    pub body: String,
    pub date: String,
    /// GraphQL node id — set for conversation comments, empty for reviews
    /// (which use a different edit path and aren't editable here).
    pub id: String,
    /// Permalink to the comment on GitHub ("" for reviews) — for "Copy link".
    pub url: String,
    /// Whether the signed-in user wrote it — drives the edit affordance.
    pub viewer_did_author: bool,
    /// Whether the comment is hidden (minimized), and GitHub's reason for it.
    pub is_minimized: bool,
    pub minimized_reason: String,
}

/// One file:line-anchored review thread, provider-neutral. GitHub: a GraphQL
/// PullRequestReviewThread; GitLab: an MR diff-note discussion; Bitbucket: an
/// inline comment and its reply chain.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadOut {
    /// Provider thread id: GitHub reviewThread node id; GitLab discussion id;
    /// Bitbucket root comment id (stringified — u64 ids must not cross IPC as numbers).
    pub id: String,
    pub path: String,
    /// 1-based anchored line; 0 = unknown (e.g. outdated GitHub threads with null line).
    pub line: u32,
    /// First line of a multi-line comment range (1-based); 0 = single-line (use `line`).
    pub start_line: u32,
    /// "new" (right side / added lines) or "old" (left side).
    pub side: String,
    pub is_resolved: bool,
    pub is_outdated: bool,
    /// The unified-diff hunk excerpt the thread anchors to (GitHub's `diffHunk`), for
    /// rendering the code context above the comment. Empty when the provider has no
    /// cheap excerpt (GitLab flat API, Bitbucket).
    pub diff_hunk: String,
    /// Full reply chain, oldest first, reusing the existing comment shape.
    pub comments: Vec<PrThreadOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheckOut {
    pub name: String,
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetails {
    /// GraphQL node id, used by the label mutations.
    pub id: String,
    pub number: u64,
    pub title: String,
    pub body: String,
    pub author: String,
    pub state: String,
    pub is_draft: bool,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub additions: u32,
    pub deletions: u32,
    pub url: String,
    pub commits: Vec<PrCommitOut>,
    pub files: Vec<PrFileOut>,
    pub reviews: Vec<PrThreadOut>,
    pub comments: Vec<PrThreadOut>,
    pub checks: Vec<PrCheckOut>,
    pub labels: Vec<RepoLabel>,
    /// Assignee usernames. Only GitLab fills this — the MR-assignees picker is
    /// GitLab-only (`implemented.mrAssignees`), so the GitHub view doesn't request
    /// assignees and leaves it empty.
    pub assignees: Vec<String>,
    /// The reviewer list. Only Bitbucket fills this — the reviewers picker is
    /// Bitbucket-only (`implemented.mrReviewers`); identity is the provider's
    /// stable id (Bitbucket: the braced account uuid), label the display name.
    pub reviewers: Vec<crate::forge::model::ForgeUserRef>,
}

/// A merge/pull request's approval summary — who has approved and whether the
/// viewer has. Provider-neutral, but only GitLab produces it today: GitHub
/// surfaces approval through the review flow (`reviewDecision` + the Review menu),
/// not a bodyless toggle, so its forge arm errors and the GitLab-only
/// approve/unapprove control gates on `implemented.mrApprove` (false for GitHub).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalState {
    /// Whether the signed-in viewer has approved — the toggle's driver (Approve ↔
    /// Revoke). The reliable signal, unlike GitLab's `user_can_approve`, which it
    /// reports `false` on the Free tier even when approving succeeds (a Premium
    /// approval-rules concept), so a genuine permission error surfaces via the
    /// action's toast instead of pre-disabling the control.
    pub viewer_has_approved: bool,
    /// Usernames who have approved, for an "Approved by …" summary.
    pub approved_by: Vec<String>,
    /// Required approvals — a Premium approval-rules concept; `0` on Free.
    pub approvals_required: u32,
    /// Approvals still needed (`0` on Free).
    pub approvals_left: u32,
    /// Whether the signed-in viewer has a "requested changes" reviewer state on
    /// this MR — the GitLab-only Request-changes control's pressed state. Cleared
    /// server-side by approving (validated live) or by removing the viewer from
    /// the reviewers; the direct undo mutation is Premium-only.
    pub viewer_requested_changes: bool,
}

const PR_VIEW_FIELDS: &str = "id,number,title,body,author,state,isDraft,baseRefName,headRefName,additions,deletions,url,commits,files,reviews,comments,statusCheckRollup,labels";

/// Full details for one PR's read view.
#[tauri::command]
pub async fn gh_pr_view(repo_path: String, number: u64) -> AppResult<PrDetails> {
    let out = run_gh(
        Some(&repo_path),
        &["pr", "view", &number.to_string(), "--json", PR_VIEW_FIELDS],
        GH_TIMEOUT,
    )
    .await?;
    let raw: RawPr = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh pr view: {e}")))?;

    let login = |a: Option<RawLogin>| a.map(|x| x.login).unwrap_or_default();
    Ok(PrDetails {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        body: raw.body,
        author: login(raw.author),
        state: raw.state,
        is_draft: raw.is_draft,
        base_ref_name: raw.base_ref_name,
        head_ref_name: raw.head_ref_name,
        additions: raw.additions,
        deletions: raw.deletions,
        url: raw.url,
        commits: raw
            .commits
            .into_iter()
            .map(|c| {
                let author = c
                    .authors
                    .into_iter()
                    .next()
                    .map(|a| if a.name.is_empty() { a.login } else { a.name })
                    .unwrap_or_default();
                PrCommitOut {
                    oid: c.oid,
                    headline: c.message_headline,
                    date: c.authored_date,
                    author,
                }
            })
            .collect(),
        files: raw
            .files
            .into_iter()
            .map(|f| PrFileOut {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect(),
        reviews: raw
            .reviews
            .into_iter()
            .map(|r| PrThreadOut {
                author: login(r.author),
                state: r.state,
                body: r.body,
                date: r.submitted_at,
                id: String::new(),
                url: String::new(),
                viewer_did_author: false,
                is_minimized: false,
                minimized_reason: String::new(),
            })
            .collect(),
        comments: raw
            .comments
            .into_iter()
            .map(|c| PrThreadOut {
                author: login(c.author),
                state: String::new(),
                body: c.body,
                date: c.created_at,
                id: c.id,
                url: c.url,
                viewer_did_author: c.viewer_did_author,
                is_minimized: c.is_minimized,
                minimized_reason: c.minimized_reason,
            })
            .collect(),
        checks: raw
            .status_check_rollup
            .into_iter()
            .map(|c| {
                let name = if c.name.is_empty() { c.context } else { c.name };
                let status = [c.conclusion, c.state, c.status]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or_default();
                PrCheckOut { name, status }
            })
            .collect(),
        labels: raw.labels,
        assignees: Vec::new(),
        reviewers: Vec::new(),
    })
}

const PR_REACTIONS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reactionGroups{ content viewerHasReacted reactors{ totalCount } } comments(first:100){ nodes{ id reactionGroups{ content viewerHasReacted reactors{ totalCount } } } } } } }";

/// Reactions for a PR's body + each conversation comment (keyed by comment node
/// id). Same decoupled design as `gh_issue_reactions`: `viewerHasReacted` is
/// GraphQL-only, so this loads in parallel with the PR view and leaves
/// `gh_pr_view` untouched. Reuses the issue reaction types + mapper.
#[tauri::command]
pub async fn gh_pr_reactions(repo_path: String, number: u64) -> AppResult<IssueReactions> {
    let (owner, name) = repo_owner_name(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-F",
            &format!("owner={owner}"),
            "-F",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
            "-f",
            &format!("query={PR_REACTIONS_QUERY}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse reactions: {e}")))?;
    let pr = value.pointer("/data/repository/pullRequest");

    let body = map_reaction_groups(pr.and_then(|p| p.get("reactionGroups")));
    let mut comments = std::collections::HashMap::new();
    if let Some(nodes) = pr
        .and_then(|p| p.pointer("/comments/nodes"))
        .and_then(|n| n.as_array())
    {
        for node in nodes {
            if let Some(id) = node.get("id").and_then(serde_json::Value::as_str) {
                let reactions = map_reaction_groups(node.get("reactionGroups"));
                if !reactions.is_empty() {
                    comments.insert(id.to_string(), reactions);
                }
            }
        }
    }

    Ok(IssueReactions { body, comments })
}

/// The PR's full unified diff (`gh pr diff`), capped for the webview. The
/// frontend splits it per file for the diff viewer.
#[tauri::command]
pub async fn gh_pr_diff(repo_path: String, number: u64) -> AppResult<String> {
    let out = run_gh(
        Some(&repo_path),
        &["pr", "diff", &number.to_string()],
        GH_TIMEOUT,
    )
    .await?;
    let (text, _) =
        crate::git::diff::truncate_at_char_boundary(out.stdout_lossy(), 2_000_000);
    Ok(text)
}

/// One external (third-party) review item harvested from a GitHub PR — a
/// submitted review body, a line-anchored inline review comment, or a
/// conversation comment — with each author's bot flag. Surfaced so an AI
/// re-review can fold in what tools like GitHub Copilot or CodeRabbit already
/// flagged (as soft, re-verifiable context, never ground truth). The frontend
/// decides which authors count as AI reviewers and how to format them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalReviewItem {
    /// "review" (PR-level review body), "inline" (line-anchored review comment),
    /// or "comment" (top-level conversation comment).
    pub kind: String,
    /// The author's GitHub login (e.g. "coderabbitai", "copilot-pull-request-reviewer").
    pub author: String,
    /// Whether the author is a GitHub App / bot (GraphQL `__typename == "Bot"`).
    pub is_bot: bool,
    pub body: String,
    /// File path for `inline` items ("" otherwise).
    pub path: String,
    /// 1-based line for `inline` items (0 when unknown / the line is outdated).
    pub line: u32,
    /// The commit OID the item was made against ("" when unknown) — for staleness.
    pub commit_sha: String,
    /// Submitted-review state (APPROVED / CHANGES_REQUESTED / COMMENTED) for
    /// `review` items; "" otherwise.
    pub state: String,
    /// For `inline` items: GitHub's own thread flags. `is_outdated` means the
    /// anchored line moved since the comment was made.
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub created_at: String,
}

/// All review activity on a PR — submitted reviews, inline review-thread
/// comments, and conversation comments — in one GraphQL round trip, each tagged
/// with its author's bot flag. The frontend filters to AI reviewers and folds
/// their findings into an AI re-review as soft context.
#[tauri::command]
pub async fn gh_pr_external_reviews(
    repo_path: String,
    number: u64,
) -> AppResult<Vec<ExternalReviewItem>> {
    let (owner, name) = repo_owner_name(&repo_path).await?;
    validate_graphql_embed(&owner, "repository owner")?;
    validate_graphql_embed(&name, "repository name")?;

    // `number` is a u64 (digits only), so it's safe to embed directly.
    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ pullRequest(number:{number}){{ reviews(first:50){{ nodes{{ author{{ login __typename }} body state submittedAt commit{{ oid }} }} }} reviewThreads(first:100){{ nodes{{ isResolved isOutdated path line originalLine comments(first:1){{ nodes{{ author{{ login __typename }} body createdAt commit{{ oid }} originalCommit{{ oid }} }} }} }} }} comments(first:100){{ nodes{{ author{{ login __typename }} body createdAt }} }} }} }} }}"#
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR reviews: {e}")))?;
    let pr = value.pointer("/data/repository/pullRequest");

    let str_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    let is_bot = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_str()) == Some("Bot")
    };

    let mut items: Vec<ExternalReviewItem> = Vec::new();

    // Submitted reviews (PR-level bodies) — a bot reviewer's summary review.
    if let Some(nodes) = pr
        .and_then(|p| p.pointer("/reviews/nodes"))
        .and_then(|v| v.as_array())
    {
        for n in nodes {
            let body = str_at(n, "/body");
            if body.trim().is_empty() {
                continue;
            }
            items.push(ExternalReviewItem {
                kind: "review".into(),
                author: str_at(n, "/author/login"),
                is_bot: is_bot(n, "/author/__typename"),
                body,
                path: String::new(),
                line: 0,
                commit_sha: str_at(n, "/commit/oid"),
                state: str_at(n, "/state"),
                is_resolved: false,
                is_outdated: false,
                created_at: str_at(n, "/submittedAt"),
            });
        }
    }

    // Inline review-thread comments — the line-anchored findings (Copilot's and
    // CodeRabbit's specific suggestions). Take each thread's first comment (its
    // opener = the reviewer), not the human replies beneath it.
    if let Some(nodes) = pr
        .and_then(|p| p.pointer("/reviewThreads/nodes"))
        .and_then(|v| v.as_array())
    {
        for t in nodes {
            let Some(c) = t.pointer("/comments/nodes/0") else {
                continue;
            };
            let body = str_at(c, "/body");
            if body.trim().is_empty() {
                continue;
            }
            // Outdated threads carry `"line": null` (key present, value null), and
            // `pointer` returns `Some(Null)` for that — so convert to `u64` BEFORE
            // the `originalLine` fallback, else a null `line` swallows the fallback
            // and reports line 0 (see `gh_pr_review_threads` for the same trap).
            let line = t
                .pointer("/line")
                .and_then(|x| x.as_u64())
                .or_else(|| t.pointer("/originalLine").and_then(|x| x.as_u64()))
                .unwrap_or(0) as u32;
            let commit_sha = {
                let latest = str_at(c, "/commit/oid");
                if latest.is_empty() {
                    str_at(c, "/originalCommit/oid")
                } else {
                    latest
                }
            };
            items.push(ExternalReviewItem {
                kind: "inline".into(),
                author: str_at(c, "/author/login"),
                is_bot: is_bot(c, "/author/__typename"),
                body,
                path: str_at(t, "/path"),
                line,
                commit_sha,
                state: String::new(),
                is_resolved: t
                    .pointer("/isResolved")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                is_outdated: t
                    .pointer("/isOutdated")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                created_at: str_at(c, "/createdAt"),
            });
        }
    }

    // Top-level conversation comments — CodeRabbit posts its walkthrough/summary
    // here. The frontend keeps these only from known reviewer bots (CI / deploy
    // bots also post on this surface).
    if let Some(nodes) = pr
        .and_then(|p| p.pointer("/comments/nodes"))
        .and_then(|v| v.as_array())
    {
        for n in nodes {
            let body = str_at(n, "/body");
            if body.trim().is_empty() {
                continue;
            }
            items.push(ExternalReviewItem {
                kind: "comment".into(),
                author: str_at(n, "/author/login"),
                is_bot: is_bot(n, "/author/__typename"),
                body,
                path: String::new(),
                line: 0,
                commit_sha: String::new(),
                state: String::new(),
                is_resolved: false,
                is_outdated: false,
                created_at: str_at(n, "/createdAt"),
            });
        }
    }

    Ok(items)
}

/// File:line-anchored review threads on a PR — GitHub's `reviewThreads` mapped
/// onto the neutral `ReviewThreadOut`. Each thread carries its full reply chain
/// (oldest first). Empty-comment threads are skipped. Line falls back to the
/// original line, then 0 (an outdated thread whose anchor moved has a null line).
#[tauri::command]
pub async fn gh_pr_review_threads(
    repo_path: String,
    number: u64,
) -> AppResult<Vec<ReviewThreadOut>> {
    let (owner, name) = repo_owner_name(&repo_path).await?;
    validate_graphql_embed(&owner, "repository owner")?;
    validate_graphql_embed(&name, "repository name")?;

    // `number` is a u64 (digits only), so it's safe to embed directly.
    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ pullRequest(number:{number}){{ reviewThreads(first:100){{ nodes{{ id isResolved isOutdated diffSide line originalLine startLine originalStartLine path comments(first:50){{ nodes{{ id author{{ login }} body createdAt url viewerDidAuthor isMinimized minimizedReason diffHunk }} }} }} }} }} }} }}"#
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "graphql", "-f", &format!("query={query}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR review threads: {e}")))?;

    let str_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    let bool_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_bool()).unwrap_or(false)
    };

    let mut threads: Vec<ReviewThreadOut> = Vec::new();
    if let Some(nodes) = value
        .pointer("/data/repository/pullRequest/reviewThreads/nodes")
        .and_then(|v| v.as_array())
    {
        for t in nodes {
            let comments: Vec<PrThreadOut> = t
                .pointer("/comments/nodes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|c| PrThreadOut {
                            author: str_at(c, "/author/login"),
                            state: String::new(),
                            body: str_at(c, "/body"),
                            date: str_at(c, "/createdAt"),
                            id: str_at(c, "/id"),
                            url: str_at(c, "/url"),
                            viewer_did_author: bool_at(c, "/viewerDidAuthor"),
                            is_minimized: bool_at(c, "/isMinimized"),
                            minimized_reason: str_at(c, "/minimizedReason"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            // A thread with no comments carries no content to anchor — skip it.
            if comments.is_empty() {
                continue;
            }
            // NOTE: for OUTDATED threads GitHub returns the key present but JSON
            // null (`"line": null`), and `serde_json`'s `pointer` returns
            // `Some(Value::Null)` for a present-but-null key — NOT `None`. So the
            // fallback must convert to `u64` BEFORE `.or_else`, or a null `line`
            // would swallow the `originalLine` fallback and render line 0.
            let line = t
                .pointer("/line")
                .and_then(|x| x.as_u64())
                .or_else(|| t.pointer("/originalLine").and_then(|x| x.as_u64()))
                .unwrap_or(0) as u32;
            let start_line = t
                .pointer("/startLine")
                .and_then(|x| x.as_u64())
                .or_else(|| t.pointer("/originalStartLine").and_then(|x| x.as_u64()))
                .unwrap_or(0) as u32;
            let side = if str_at(t, "/diffSide") == "LEFT" {
                "old"
            } else {
                "new"
            };
            // The diff excerpt lives on the individual comments; the thread's
            // opener (first comment) carries the anchor hunk.
            let diff_hunk = str_at(t, "/comments/nodes/0/diffHunk");
            threads.push(ReviewThreadOut {
                id: str_at(t, "/id"),
                path: str_at(t, "/path"),
                line,
                start_line,
                side: side.into(),
                is_resolved: bool_at(t, "/isResolved"),
                is_outdated: bool_at(t, "/isOutdated"),
                diff_hunk,
                comments,
            });
        }
    }
    Ok(threads)
}

/// Replies in an existing review thread, addressed by its GraphQL node id. The id
/// and body travel as GraphQL variables (never format!-embedded) — the
/// injection-safe idiom `gh_pr_edit_comment` uses.
#[tauri::command]
pub async fn gh_pr_reply_review_thread(
    repo_path: String,
    thread_id: String,
    body: String,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a reply is required".into()));
    }
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}",
            "-f",
            &format!("id={thread_id}"),
            "-f",
            &format!("body={body}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Resolves or unresolves a review thread by its GraphQL node id.
#[tauri::command]
pub async fn gh_pr_resolve_review_thread(
    repo_path: String,
    thread_id: String,
    resolved: bool,
) -> AppResult<()> {
    let query = if resolved {
        "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}"
    } else {
        "query=mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}"
    };
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "graphql",
            "-f",
            query,
            "-f",
            &format!("id={thread_id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Open PRs whose head is `head` (there's at most one per base). Lets the UI
/// offer "View pull request" instead of "Create" once one already exists.
#[tauri::command]
pub async fn gh_prs_for_branch(repo_path: String, head: String) -> AppResult<Vec<PrInfo>> {
    if head.is_empty() || head.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid branch: {head}")));
    }
    let out = run_gh(
        Some(&repo_path),
        &[
            "pr",
            "list",
            "--head",
            &head,
            "--state",
            "open",
            "--json",
            "number,url,title,baseRefName,headRefName,isDraft,state",
        ],
        GH_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh pr list: {e}")))
}

/// Pushes `head` to origin, then opens a PR from `head` into `base`. Returns
/// the new PR's number and URL.
#[tauri::command]
pub async fn gh_pr_create(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
) -> AppResult<PrRef> {
    validate_branch(&base)?;
    validate_branch(&head)?;
    if title.trim().is_empty() {
        return Err(AppError::InvalidArgument("a PR title is required".into()));
    }

    // gh can only open a PR for a branch that exists on the remote.
    run_git_mutating(
        &state,
        &repo_path,
        &["push", "-u", "origin", &head],
        NETWORK_TIMEOUT,
    )
    .await?;

    let mut args = vec![
        "pr", "create", "--base", &base, "--head", &head, "--title", &title, "--body", &body,
    ];
    if draft {
        args.push("--draft");
    }
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;

    // gh prints the new PR's URL as its last stdout line.
    let url = out
        .stdout_lossy()
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .unwrap_or_default()
        .to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(PrRef { number, url })
}

#[cfg(test)]
mod tests {
    use super::{host_from_url, parse_auth_accounts};

    #[test]
    fn host_from_url_handles_github_and_enterprise() {
        assert_eq!(
            host_from_url("https://github.com/owner/repo").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            host_from_url("https://github.acme.com/owner/repo").as_deref(),
            Some("github.acme.com")
        );
        // userinfo + port are tolerated.
        assert_eq!(
            host_from_url("https://user@github.acme.com:8443/owner/repo").as_deref(),
            Some("github.acme.com")
        );
        // Not an http(s)-style URL → no host.
        assert_eq!(host_from_url("git@github.com:owner/repo.git"), None);
    }

    #[test]
    fn parse_auth_accounts_groups_hosts_and_marks_active() {
        // gh 2.40+ format: per-account "Active account" lines, multi-host.
        let report = "\
github.com
  ✓ Logged in to github.com account alice (keyring)
  - Active account: true
  ✓ Logged in to github.com account bob (keyring)
  - Active account: false
github.acme.com
  ✓ Logged in to github.acme.com account alice-work (keyring)
  - Active account: true";
        let accounts = parse_auth_accounts(report);
        assert_eq!(accounts.len(), 3);
        assert_eq!(accounts[0].host, "github.com");
        assert_eq!(accounts[0].login, "alice");
        assert!(accounts[0].active);
        assert_eq!(accounts[1].login, "bob");
        assert!(!accounts[1].active);
        assert_eq!(accounts[2].host, "github.acme.com");
        assert_eq!(accounts[2].login, "alice-work");
        assert!(accounts[2].active);
    }

    #[test]
    fn parse_auth_accounts_old_gh_marks_each_host_active() {
        // Old gh: "as <login>", no "Active account" lines → each host's lone
        // account is active.
        let report = "\
  ✓ Logged in to github.com as alice (oauth_token)
  ✓ Logged in to github.acme.com as alice-work (oauth_token)";
        let accounts = parse_auth_accounts(report);
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].host, "github.com");
        assert_eq!(accounts[1].host, "github.acme.com");
        assert!(accounts[0].active && accounts[1].active);
    }
}
