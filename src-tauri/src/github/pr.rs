use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git_mutating, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::github::issue::{map_reaction_groups, repo_owner_name, IssueReactions};
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GH_NETWORK_TIMEOUT, GH_TIMEOUT};
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
    // Pin the origin slug positionally (`gh repo view <slug>` — the `repo` family
    // takes the target positionally, not via `-R`): on a fork with an `upstream`
    // remote a bare `gh repo view` auto-resolves to the PARENT, so the status
    // "repo" field would name the upstream instead of the fork. Best-effort: an
    // unparseable origin just leaves repo/host unresolved (same as before).
    let view = if authenticated {
        match crate::github::gh_origin_slug(&repo_path).await {
            Ok(slug) => run_gh_raw(
                Some(&repo_path),
                &["repo", "view", &slug, "--json", "nameWithOwner,url"],
                GH_TIMEOUT,
            )
            .await
            .ok()
            .filter(|o| o.code == 0)
            .and_then(|o| serde_json::from_str::<RepoView>(&o.stdout_lossy()).ok()),
            Err(_) => None,
        }
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
pub(crate) struct ParsedAccount {
    pub(crate) host: String,
    pub(crate) login: String,
    pub(crate) active: bool,
}

/// Accounts from a `gh auth status` report, with the active one per host
/// flagged. Handles both formats: old gh prints "Logged in to <host> as
/// <login>", gh 2.40+ prints "Logged in to <host> account <login>" with a
/// separate "Active account: true" line per account.
pub(crate) fn parse_auth_accounts(report: &str) -> Vec<ParsedAccount> {
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
    // Pin the origin slug positionally (`gh repo view <slug>` — the `repo` family
    // has no `-R` flag): a bare `gh repo view` on a fork with an `upstream` remote
    // auto-resolves to the PARENT, so "View on GitHub" would open the upstream.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", &slug, "--json", "url", "-q", ".url"],
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
/// as "not starred" rather than erroring. Pinned to the origin slug (a bare
/// `gh api …/{owner}/{repo}` resolves to the PARENT on a fork) so the star
/// reflects the fork itself.
#[tauri::command]
pub async fn gh_repo_star_status(repo_path: String) -> AppResult<bool> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let endpoint = format!("user/starred/{slug}");
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", "--method", "GET", &endpoint],
        GH_TIMEOUT,
    )
    .await?;
    Ok(out.code == 0)
}

/// Stars (PUT) or unstars (DELETE) this repo for the signed-in user via
/// `/user/starred/{owner}/{repo}`. Both are idempotent on GitHub's side. Pinned
/// to the origin slug so a fork stars itself, not its parent.
#[tauri::command]
pub async fn gh_repo_set_star(repo_path: String, starred: bool) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let endpoint = format!("user/starred/{slug}");
    let method = if starred { "PUT" } else { "DELETE" };
    run_gh(
        Some(&repo_path),
        &["api", "--method", method, &endpoint],
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
    /// ISO-8601 timestamp of when the PR was opened; "" when the source didn't
    /// supply it. Populated by all three providers (GitHub `createdAt`, GitLab
    /// `created_at`, Bitbucket `created_on`) so the list row can show its age.
    #[serde(default)]
    pub created_at: String,
    /// The PR head commit's SHA. Populated ONLY by the Bitbucket list arm (from
    /// `source.commit.hash`, short hash is fine) to feed its per-commit CI-status
    /// probe — Bitbucket has no batch pipeline endpoint. GitHub and GitLab leave it
    /// "" (their CI arms query by PR number / MR iid and never read this).
    #[serde(default)]
    pub head_sha: String,
}

/// Submits a review: `action` is "approve", "comment", or "request_changes".
/// gh requires a body for comment/request-changes (it surfaces the error).
#[tauri::command]
pub async fn gh_pr_review(
    repo_path: String,
    number: u64,
    action: String,
    body: String,
    lens: Option<String>,
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
    // Resolve the lens slug (`gh pr … --repo OWNER/REPO`) so a fork's PR resolves
    // against the chosen remote, not the parent gh auto-detects from `upstream`.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let body = body.trim();
    let mut args = vec!["pr", "review", &n, flag, "--repo", &slug];
    if !body.is_empty() {
        args.push("--body");
        args.push(body);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Adds a standalone comment to the PR conversation.
#[tauri::command]
pub async fn gh_pr_comment(
    repo_path: String,
    number: u64,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let n = number.to_string();
    // Resolve the lens slug so the comment lands on the chosen repo's PR.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "comment", &n, "--body", &body, "--repo", &slug],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The outcome of a successful merge. The PR *did* merge; `cleanup_warning`
/// carries a human-readable caveat when the post-merge remote head-branch
/// cleanup failed (GitHub-only by construction — GitLab and Bitbucket fold
/// deletion into the atomic merge server-side, so they never produce one). A
/// merge *failure* is still an `Err`, never an outcome with a warning.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrMergeOutcome {
    /// `Some(msg)` — merged fine, but head-branch cleanup failed; `msg` always
    /// states the merge succeeded. `None` — merged and cleaned up cleanly.
    pub cleanup_warning: Option<String>,
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
///
/// The merge itself is hard: a failure returns `Err`. Head-branch cleanup is
/// best-effort: once the merge has landed, a cleanup failure is folded into a
/// successful [`PrMergeOutcome`] as a `cleanup_warning` rather than surfacing as
/// a red merge error for a PR that already merged.
#[tauri::command]
pub async fn gh_pr_merge(
    repo_path: String,
    number: u64,
    strategy: String,
    delete_branch: bool,
    lens: Option<String>,
) -> AppResult<PrMergeOutcome> {
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
    // Resolve the lens slug so the merge targets the chosen repo's PR.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "merge", &n, method, "--repo", &slug],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // The merge has landed. From here, any cleanup failure is disclosed as a
    // warning on a successful outcome — never an error — so the UI can't show a
    // red "merge failed" toast for a PR that already merged.
    let cleanup_warning = if delete_branch {
        gh_delete_remote_head_branch(&repo_path, number, lens.as_deref())
            .await
            .err()
            .map(|e| e.to_string())
    } else {
        None
    };
    Ok(PrMergeOutcome { cleanup_warning })
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
/// Best-effort and disclosing: the merge already succeeded, so every error path
/// here (head lookup, parse, or the DELETE itself) produces a "Merged #N, but …"
/// message that `gh_pr_merge` folds into a successful outcome's `cleanup_warning`
/// rather than a merge failure. A branch that is already gone (e.g. a repo that
/// auto-deletes head branches on merge) counts as success.
async fn gh_delete_remote_head_branch(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<()> {
    // Resolve the lens slug for the READ so the PR resolves against the chosen repo
    // (the DELETE below then targets the PR's OWN head repository — see its note).
    let slug = crate::github::gh_lens_slug(repo_path, lens).await.map_err(|e| {
        AppError::Gh(format!(
            "Merged #{number}, but couldn't clean up the remote head branch: {e}"
        ))
    })?;
    let out = run_gh(
        Some(repo_path),
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &slug,
            "--json",
            "headRefName,isCrossRepository,headRepositoryOwner,headRepository",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| {
        AppError::Gh(format!(
            "Merged #{number}, but couldn't clean up the remote head branch: {e}"
        ))
    })?;
    let head: RawMergeHead = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        AppError::Gh(format!(
            "Merged #{number}, but couldn't clean up the remote head branch: {e}"
        ))
    })?;

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

    // Best-effort prune of the LOCAL remote-tracking ref for this branch. The
    // GitHub API delete never touches local git, so `refs/remotes/origin/<branch>`
    // lingers (marked `[gone]`) until the next pruning fetch — long enough for the
    // sync bar to keep offering stale Push/Pull. Deleting it now flips the branch
    // to "Publish" on the next status refresh. Skipped for a cross-repository PR:
    // a fork's head branch has no `origin` tracking ref of ours to prune. We use
    // `run_git_raw` (no AppState) for this single atomic ref deletion rather than
    // threading state through the signature — the same idempotent-prune model
    // `git_delete_remote_branch_core` already uses.
    let prune_local_tracking = || async {
        if !head.is_cross_repository {
            let _ = run_git_raw(
                Some(repo_path),
                &["update-ref", "-d", &format!("refs/remotes/origin/{branch}")],
                DEFAULT_TIMEOUT,
            )
            .await;
        }
    };

    // INVARIANT — do NOT origin-pin this DELETE. `owner`/`repo` come from the PR's
    // OWN `headRepository[Owner]` (the fork side of a cross-repo PR), which is
    // exactly where the branch to delete lives. Substituting the origin slug here
    // would delete refs on the wrong repo for a cross-repository PR.
    let endpoint = format!("repos/{owner}/{repo}/git/refs/heads/{branch}");
    match run_gh(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GH_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => {
            prune_local_tracking().await;
            Ok(())
        }
        Err(err) => {
            let raw = err.to_string();
            let lower = raw.to_ascii_lowercase();
            // Only the explicit missing-ref case (GitHub's 422 "Reference does not
            // exist") is the desired end state — the branch is already gone (the repo
            // auto-deletes head branches, or a prior attempt removed it). A permission
            // failure can return 404 "Not found", so don't swallow that — let it surface.
            if lower.contains("reference does not exist") {
                prune_local_tracking().await;
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
pub async fn gh_pr_close(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    let n = number.to_string();
    // Resolve the lens slug so the PR closes on the chosen repo.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "close", &n, "--repo", &slug],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Reopens a closed (not merged) pull request.
#[tauri::command]
pub async fn gh_pr_reopen(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    let n = number.to_string();
    // Resolve the lens slug so the PR reopens on the chosen repo.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "reopen", &n, "--repo", &slug],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Edits the body of an existing conversation comment, addressed by its GraphQL
/// node id (from `gh pr view` / `gh issue view`). The `updateIssueComment`
/// mutation operates on `IssueComment` nodes, which back BOTH pull-request and
/// issue conversation comments — so this one fn serves both forge dispatch arms.
/// GitHub only lets the comment's author edit it, so it's offered solely on the
/// viewer's own comments. Plain fn (called by the forge dispatch); no longer a
/// Tauri command.
pub async fn edit_comment(repo_path: &str, comment_id: &str, body: &str) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    run_gh(
        Some(repo_path),
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

/// Permanently deletes a conversation comment by its GraphQL node id. Like
/// [`edit_comment`], the `deleteIssueComment` mutation serves both PR and issue
/// conversation comments. Plain fn (called by the forge dispatch).
pub async fn delete_comment(repo_path: &str, comment_id: &str) -> AppResult<()> {
    run_gh(
        Some(repo_path),
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

/// Edits the body of a file:line-anchored REVIEW-thread comment, addressed by its
/// GraphQL node id (from `gh_pr_review_threads`). These are `PullRequestReviewComment`
/// nodes — a DISTINCT type from the `IssueComment` nodes [`edit_comment`] handles, so
/// they take their own `updatePullRequestReviewComment` mutation (the IssueComment
/// mutations reject a review-comment id). GitHub only lets the author edit, so it's
/// offered solely on the viewer's own comments. Plain fn (called by the forge dispatch).
pub async fn edit_review_comment(repo_path: &str, comment_id: &str, body: &str) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    run_gh(
        Some(repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){pullRequestReviewComment{id}}}",
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

/// Permanently deletes a review-thread comment by its GraphQL node id. Like
/// [`edit_review_comment`], these are `PullRequestReviewComment` nodes, so this uses
/// `deletePullRequestReviewComment` (not the IssueComment delete). Plain fn.
pub async fn delete_review_comment(repo_path: &str, comment_id: &str) -> AppResult<()> {
    run_gh(
        Some(repo_path),
        &[
            "api",
            "graphql",
            "-f",
            "query=mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}",
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
pub async fn gh_pr_checkout(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    let n = number.to_string();
    // Resolve the lens slug so the PR number checks out from the chosen repo, not the
    // parent gh would auto-resolve from an `upstream` remote.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "checkout", &n, "--repo", &slug],
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
    // Deliberately NOT origin-pinned: before forking, this read must resolve the
    // PARENT repo — pinning it would break fork creation.
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
pub async fn gh_pr_ready(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    let n = number.to_string();
    // Resolve the lens slug so the PR is marked ready on the chosen repo.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &["pr", "ready", &n, "--repo", &slug],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

const PR_LIST_FIELDS: &str =
    "number,url,title,baseRefName,headRefName,isDraft,state,author,labels,createdAt";

/// PRs for the Pull Requests list. `state` is "open" or "closed"; closed
/// uses the search qualifier so merged PRs are included, matching the
/// semantics of GitHub's own Closed tab.
#[tauri::command]
pub async fn gh_pr_list(
    repo_path: String,
    state: String,
    limit: Option<u32>,
    lens: Option<String>,
) -> AppResult<Vec<PrInfo>> {
    // Resolve the lens slug so a fork lists the chosen repo's PRs (a bare
    // `gh pr list` on a fork auto-resolves to the upstream repo).
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let mut args: Vec<&str> = match state.as_str() {
        "open" => vec![
            "pr", "list", "--repo", &slug, "--state", "open", "--json", PR_LIST_FIELDS,
        ],
        "closed" => vec![
            "pr",
            "list",
            "--repo",
            &slug,
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
    // `gh pr list` defaults to 30; thread an explicit `--limit` when the caller asks
    // for a different cap (existing callers pass `None` → gh's default is untouched).
    // Clamp to gh's accepted `--limit` range (1..=1000): `--limit 0` errors at runtime,
    // and this keeps the MCP `limit` behavior consistent with the other providers, which
    // clamp to their own page ceilings rather than erroring.
    let limit_str;
    if let Some(n) = limit {
        limit_str = n.clamp(1, 1000).to_string();
        args.push("--limit");
        args.push(&limit_str);
    }
    let out = run_gh(Some(&repo_path), &args, GH_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh pr list: {e}")))
}

/// One PR's rolled-up CI signal, keyed by number — the hydration payload for the
/// PR-list row icons. `ci_status` is one of `"passing" | "failing" | "pending" |
/// "none"`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCiStatus {
    pub number: u64,
    pub ci_status: String,
}

/// One PR reference the frontend hands `forge_pr_list_ci` to hydrate row CI icons:
/// the PR number plus its head SHA. The GitHub/GitLab arms need only the number
/// (they query by number / iid); the Bitbucket arm needs `head_sha` for its
/// per-commit statuses probe (it's "" for GitHub/GitLab list rows).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCiRefIn {
    pub number: u64,
    #[serde(default)]
    pub head_sha: String,
}

/// Map GitHub's *precomputed* single-enum `statusCheckRollup.state` to the neutral
/// list-row CI signal. `None` = the rollup was null (no checks configured) → `"none"`;
/// an empty state string is treated the same. Unrecognized states bias to `"pending"`
/// (conservative — never a false green). Case-insensitive.
fn rollup_state_to_ci(state: Option<&str>) -> String {
    match state.map(|s| s.trim().to_ascii_uppercase()) {
        None => "none".to_string(),
        Some(s) if s.is_empty() => "none".to_string(),
        Some(s) => match s.as_str() {
            "SUCCESS" => "passing",
            "FAILURE" | "ERROR" => "failing",
            "PENDING" | "EXPECTED" => "pending",
            // A new/unknown state → pending, never falsely green.
            _ => "pending",
        }
        .to_string(),
    }
}

/// Parse `(host, owner, name)` from a PR html url like
/// `https://github.com/biomejs/biome/pull/10937`. The url is the empirical truth
/// for which repo the PR numbers belong to — for a fork, the PR list resolves to
/// the PARENT repo while origin points at the fork, so we must not re-derive the
/// repo from the checkout. Strict: exactly two path segments (owner, name) each
/// matching `[A-Za-z0-9._-]+` and NOT starting with `-` (flag-injection guard),
/// immediately followed by `/pull/`. Anything else is an error.
fn parse_pr_url_repo(url: &str) -> AppResult<(String, String, String)> {
    let host = host_from_url(url)
        .ok_or_else(|| AppError::InvalidArgument(format!("not a PR url: {url}")))?;
    let after = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url);
    // Drop the authority; keep the path.
    let path = after.split_once('/').map(|(_, p)| p).unwrap_or("");
    let mut segs = path.split('/');
    let owner = segs.next().unwrap_or("");
    let name = segs.next().unwrap_or("");
    let sep = segs.next().unwrap_or("");
    let valid_seg = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if sep != "pull" || !valid_seg(owner) || !valid_seg(name) {
        return Err(AppError::InvalidArgument(format!(
            "could not parse owner/repo from PR url: {url}"
        )));
    }
    Ok((host, owner.to_string(), name.to_string()))
}

/// The precomputed CI rollup for a set of PR numbers in ONE repo, keyed by number
/// — the GitHub arm of `forge_pr_list_ci`. The PR list (`gh_pr_list`) intentionally
/// fetches no rollup (a full `statusCheckRollup` expansion 504s on large repos), so
/// the row icons hydrate separately from this cheap follow-up. `numbers` come from a
/// single list page and `sample_url` is any PR html url from that same page (it fixes
/// the owner/name/host — load-bearing for forks). Queries by number aliases in chunks
/// of ≤50, each chunk one `gh api graphql` call. Tolerant: a chunk that errors or fails
/// to parse is simply omitted (its rows show no icon) — one bad chunk never fails the
/// whole call.
pub async fn gh_pr_list_ci(
    repo_path: &str,
    numbers: Vec<u64>,
    sample_url: &str,
) -> AppResult<Vec<PrCiStatus>> {
    if numbers.is_empty() {
        return Ok(Vec::new());
    }
    let (host, owner, name) = parse_pr_url_repo(sample_url)?;
    let hostname_arg = (host != "github.com").then_some(host);

    let mut result: Vec<PrCiStatus> = Vec::with_capacity(numbers.len());
    for chunk in numbers.chunks(50) {
        // Numbers are u64 (digits only) → safe to embed directly. Owner/name are
        // passed as GraphQL variables (validated above), never interpolated.
        let aliases: String = chunk
            .iter()
            .map(|n| {
                format!(
                    "p{n}: pullRequest(number:{n}){{ number commits(last:1){{ nodes{{ commit{{ statusCheckRollup{{ state }} }} }} }} }} "
                )
            })
            .collect();
        let query = format!(
            "query($owner:String!,$name:String!){{ repository(owner:$owner,name:$name){{ {aliases}}} }}"
        );
        let query_arg = format!("query={query}");
        let owner_arg = format!("owner={owner}");
        let name_arg = format!("name={name}");
        let mut args: Vec<&str> = vec!["api", "graphql"];
        if let Some(h) = &hostname_arg {
            args.push("--hostname");
            args.push(h);
        }
        args.push("-f");
        args.push(&query_arg);
        args.push("-f");
        args.push(&owner_arg);
        args.push("-f");
        args.push(&name_arg);

        // Per-chunk tolerance: a network error / non-zero exit / parse failure
        // just drops this chunk's numbers (their icons stay absent).
        let Ok(out) = run_gh_raw(Some(repo_path), &args, GH_NETWORK_TIMEOUT).await else {
            continue;
        };
        if out.code != 0 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) else {
            continue;
        };
        let Some(repo_obj) = value
            .pointer("/data/repository")
            .and_then(|v| v.as_object())
        else {
            continue;
        };
        for n in chunk {
            // Per-node guard: a missing/null alias (e.g. a number that isn't a PR
            // in this repo) is skipped, not defaulted to a misleading value.
            let Some(node) = repo_obj.get(&format!("p{n}")) else {
                continue;
            };
            if node.is_null() {
                continue;
            }
            // `statusCheckRollup` is null when the PR has no checks → "none". The
            // pointer walks the last-commit rollup; a null/absent state maps to "none".
            let state = node
                .pointer("/commits/nodes/0/commit/statusCheckRollup/state")
                .and_then(|s| s.as_str());
            result.push(PrCiStatus {
                number: *n,
                ci_status: rollup_state_to_ci(state),
            });
        }
    }
    Ok(result)
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
    lens: Option<String>,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("a PR title is required".into()));
    }
    // Resolve the lens slug so the PR is edited on the chosen repo
    // (`gh api` has no `-R` flag, so build a literal `repos/<slug>/…` path).
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}");
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &endpoint,
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
    /// The label's description (its stated purpose), when the source carries one.
    /// Threaded into the AI PR-description prompt so the model can judge a label
    /// by what it's for, not just its name.
    #[serde(default)]
    pub description: Option<String>,
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
pub async fn gh_repo_labels(repo_path: String, lens: Option<String>) -> AppResult<Vec<RepoLabel>> {
    // Resolve the lens slug: an unpinned `gh repo view` on a fork with an `upstream`
    // remote auto-resolves to the PARENT, so the origin picker would show the
    // upstream's labels. `gh_lens_slug` returns "owner/repo".
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let Some((owner, name)) = slug.split_once('/') else {
        return Err(AppError::Gh("could not determine the repository owner".into()));
    };
    validate_graphql_embed(owner, "repository owner")?;
    validate_graphql_embed(name, "repository name")?;

    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ labels(first:100){{ nodes{{ id name color description }} }} }} }}"#
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
    // Pin the origin slug: an unpinned `gh repo view` on a fork with an
    // `upstream` remote auto-resolves to the PARENT, so it would import the
    // upstream's branch protections. `gh_origin_slug` returns "owner/repo".
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let Some((owner, name)) = slug.split_once('/') else {
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
    /// Count of conversation comments — a rise between polls signals a new
    /// comment on the PR. GitHub only; 0 for GitLab/Bitbucket.
    pub comment_count: u64,
    /// Login of the most recent conversation comment's author — lets the poller
    /// suppress a "new comment" notification for your OWN comment on your own PR
    /// (the count alone can't tell whose it is). GitHub only; "" elsewhere.
    pub last_comment_author: String,
    /// Count of submitted reviews — a rise WITHOUT a `review_decision` change to
    /// approved/changes-requested signals a plain "commented" review. GitHub
    /// only; 0 for GitLab/Bitbucket.
    pub review_count: u64,
    /// Login of the most recent review's author — same self-suppression as
    /// `last_comment_author`. GitHub only; "" elsewhere.
    pub last_review_author: String,
    /// Logins currently requested to review this PR — the poller notifies you
    /// when you newly appear here. GitHub only; empty for GitLab/Bitbucket.
    pub review_requests: Vec<String>,
    /// Head branch name — lets per-action branch conditions match on remote PRs.
    /// "" when the provider can't supply it.
    pub head_ref_name: String,
    /// Base/target branch name — same per-action branch matching.
    /// "" when the provider can't supply it.
    pub base_ref_name: String,
    /// ISO-8601 timestamp of when the PR was opened — drives the missed-open
    /// catch-up's recency window on the frontend. Populated by all three
    /// providers (GitHub `createdAt`, GitLab `created_at`, Bitbucket
    /// `created_on`); "" when the source didn't supply it (frontend fails closed).
    pub created_at: String,
}

/// Lightweight snapshot of the repo's recently-updated PRs for the
/// notification poller — one GraphQL round trip including the check rollup
/// (reliable on old gh, unlike `pr list --json statusCheckRollup`).
#[tauri::command]
pub async fn gh_pr_poll(repo_path: String) -> AppResult<Vec<PrPollInfo>> {
    // Pin the origin slug: an unpinned `gh repo view` on a fork with an `upstream`
    // remote auto-resolves to the PARENT, so PR notifications + background pr-sync
    // would poll the upstream's PRs. Pinned, the poller reads the fork's own PRs.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let Some((owner, name)) = slug.split_once('/') else {
        return Err(AppError::Gh("could not determine the repository owner".into()));
    };
    validate_graphql_embed(owner, "repository owner")?;
    validate_graphql_embed(name, "repository name")?;

    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ pullRequests(first:30, states:[OPEN, CLOSED, MERGED], orderBy:{{field:UPDATED_AT, direction:DESC}}){{ nodes{{ number title url state isDraft createdAt headRefName baseRefName author{{login}} reviewDecision comments(last:1){{ totalCount nodes{{ author{{ login }} }} }} reviews(last:1){{ totalCount nodes{{ author{{ login }} }} }} reviewRequests(first:20){{ nodes{{ requestedReviewer{{ ... on User{{ login }} }} }} }} commits(last:1){{ nodes{{ commit{{ oid statusCheckRollup{{ state }} }} }} }} }} }} }} }}"#
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
            comment_count: n
                .pointer("/comments/totalCount")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            last_comment_author: str_at(n, "/comments/nodes/0/author/login"),
            review_count: n
                .pointer("/reviews/totalCount")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            last_review_author: str_at(n, "/reviews/nodes/0/author/login"),
            review_requests: n
                .pointer("/reviewRequests/nodes")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|rr| {
                            rr.pointer("/requestedReviewer/login")
                                .and_then(|l| l.as_str())
                                .map(String::from)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            head_ref_name: str_at(n, "/headRefName"),
            base_ref_name: str_at(n, "/baseRefName"),
            created_at: str_at(n, "/createdAt"),
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

/// One entry of `gh pr view --json reviewRequests` — a *pending* requested
/// reviewer (users who already submitted a review show in the reviews surface,
/// not here). Each is a `User` (`login`), a `Bot` (`login`, e.g. GitHub
/// Copilot), or a `Team`; `__typename` disambiguates. We keep Users and Bots
/// (both carry a `login`); teams have none. Verified live:
/// `{"__typename":"User","login":"…"}` and
/// `{"__typename":"Bot","login":"copilot-pull-request-reviewer"}`.
///
/// The Bot arm depends on the gh CLI version: gh's own internal GraphQL query
/// (`prReviewRequests` in cli/cli `api/query_builder.go`) added `...on Bot` in
/// v2.94.0 "to support Copilot as a reviewer on github.com". Older gh has no Bot
/// arm, so a Copilot request arrives with an empty `login` — requiring a
/// non-empty login below degrades those to today's behavior (no chip, no error).
#[derive(Deserialize)]
struct RawReviewRequest {
    #[serde(rename = "__typename", default)]
    typename: String,
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
    message_body: String,
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
    #[serde(default)]
    id: String,
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

/// statusCheckRollup is a union of CheckRun (name/conclusion/detailsUrl) and
/// StatusContext (context/state/targetUrl); accept any of the keys and normalize
/// below. `details_url`/`target_url` are the two arms' link fields (whichever is
/// present wins); `started_at`/`completed_at` are CheckRun-only timestamps that a
/// StatusContext simply omits (they stay `None`).
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
    /// CheckRun link.
    #[serde(default)]
    details_url: Option<String>,
    /// StatusContext link.
    #[serde(default)]
    target_url: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
}

/// Extract `(run_id, job_id)` from a GitHub Actions check details URL of the form
/// `https://<host>/<owner>/<repo>/actions/runs/<runId>/job/<jobId>` (the job
/// segment is optional). Ids are kept as **strings** — GitHub run/job ids exceed
/// the JS safe-integer range, so they must never be parsed to a number. Any URL
/// that isn't an Actions run URL (Vercel, Netlify, empty, absent) yields
/// `(None, None)`.
fn parse_actions_run_job(url: &str) -> (Option<String>, Option<String>) {
    // Find "/actions/runs/" then read the following all-digit run id, and an
    // optional "/job/<digits>" immediately after. Substring scan (no regex dep).
    let Some(rest) = url.split_once("/actions/runs/").map(|(_, r)| r) else {
        return (None, None);
    };
    let run_id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if run_id.is_empty() {
        return (None, None);
    }
    let after_run = &rest[run_id.len()..];
    let job_id = after_run.strip_prefix("/job/").map(|j| {
        j.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
    });
    // An empty job capture (e.g. ".../job/") is not a real id.
    let job_id = job_id.filter(|j| !j.is_empty());
    (Some(run_id), job_id)
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
    #[serde(default)]
    assignees: Vec<RawLogin>,
    #[serde(default)]
    review_requests: Vec<RawReviewRequest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommitOut {
    pub oid: String,
    pub headline: String,
    /// The commit message body (everything after the headline), empty when the
    /// commit has no body. GitHub carries it as `messageBody`; GitLab/Bitbucket
    /// derive it by stripping the title line from the full message.
    pub message_body: String,
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
    /// The comment author's avatar URL when the provider supplies one
    /// (GitLab/Bitbucket). Empty for GitHub, where it's login-derived on the
    /// frontend (`<host>/<login>.png`).
    pub author_avatar_url: String,
    pub state: String,
    pub body: String,
    pub date: String,
    /// GraphQL node id — set for conversation comments; for reviews (GitHub
    /// only) this carries the review's `PRR_…` node id. GitLab/Bitbucket emit
    /// no review entries, so it stays empty there.
    pub id: String,
    /// Permalink to the comment on GitHub ("" for reviews) — for "Copy link".
    pub url: String,
    /// Whether the signed-in user wrote it — drives the edit affordance.
    pub viewer_did_author: bool,
    /// Whether the comment is hidden (minimized), and GitHub's reason for it.
    pub is_minimized: bool,
    pub minimized_reason: String,
    /// The owning review's node id (GitHub `PRR_…`) when this row is a
    /// review-thread comment — populated per thread-comment from its own
    /// `pullRequestReview`. Empty for review/conversation rows and for the
    /// providers that don't model reviews (GitLab/Bitbucket). Lets the frontend
    /// tie GitHub's empty reply-wrapper reviews back to the thread they wrap.
    pub review_id: String,
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
    /// GraphQL id of the review this thread belongs to (GitHub `PRR_…`, from the
    /// first comment's `pullRequestReview`); "" when unknown or the provider
    /// doesn't model reviews (GitLab/Bitbucket emit no review entries).
    pub review_id: String,
    /// Full reply chain, oldest first, reusing the existing comment shape.
    pub comments: Vec<PrThreadOut>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrCheckOut {
    pub name: String,
    pub status: String,
    /// The check's link: CheckRun `detailsUrl` or StatusContext `targetUrl`,
    /// whichever is present. `None` when neither arm supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details_url: Option<String>,
    /// GitHub Actions run id, parsed from a `.../actions/runs/<runId>/…`
    /// details URL (string — exceeds JS safe-int range). `None` for non-Actions
    /// checks (external CI like Vercel/Netlify, or a StatusContext).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// GitHub Actions job id, parsed from `.../actions/runs/<runId>/job/<jobId>`.
    /// `None` when the details URL has no job segment (or isn't an Actions URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// CheckRun `startedAt`; `None` for a StatusContext (it has no start).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// CheckRun `completedAt`; `None` for a StatusContext.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
}

/// One draft inline comment in a batched review submission, provider-neutral.
/// `side` is `"new"`/`"old"`; `start_line` (a multi-line range) is GitHub-only.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DraftCommentIn {
    pub path: String,
    pub line: u64,
    pub side: String,
    #[serde(default)]
    pub start_line: Option<u64>,
    pub body: String,
}

/// The outcome of a batched review submission. `posted` = inline comments that
/// landed, `total` = comments requested, `verdict_applied` = whether the
/// approve/request-changes verdict was applied (false for a plain comment review).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSubmitOut {
    pub posted: u32,
    pub total: u32,
    pub verdict_applied: bool,
}

/// One comment on a commit, provider-neutral. Whole-commit comments carry no
/// anchor (`path`/`line`/`position` all `None`); anchored ones carry a `path` plus
/// a `line` (new-side line, GitLab/Bitbucket) and/or a `position` (GitHub's
/// diff-position — GitHub anchored comments only).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCommentOut {
    /// Provider comment id (GitHub/Bitbucket numeric-as-string; GitLab composite
    /// `"discussionId:noteId"`). Large ids must not cross IPC as numbers.
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    /// Whether the signed-in user wrote it — drives the edit/delete affordance.
    pub viewer_did_author: bool,
    /// Anchored file path (`None` = whole-commit comment).
    pub path: Option<String>,
    /// Anchored new-side line (`None` = whole-commit, or a GitHub comment whose
    /// `line` GitHub reported null).
    pub line: Option<u64>,
    /// First line of a multi-line range; `None` = single-line. GitLab only —
    /// GitHub/Bitbucket commit comments have no range concept.
    pub start_line: Option<u64>,
    /// GitHub diff-position (GitHub anchored comments only; `None` elsewhere).
    pub position: Option<u64>,
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
    /// The author's avatar URL when the provider supplies one (GitLab/Bitbucket).
    /// Empty for GitHub, where it's login-derived on the frontend.
    pub author_avatar_url: String,
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
    /// Assignees. GitHub and GitLab both fill this — the MR/PR-assignees picker is
    /// wired for both (`implemented.mrAssignees`); Bitbucket PRs have no assignee
    /// concept, so it stays empty there. Carries each user's avatar (GitLab supplies
    /// it; GitHub is login-derived) so chips render a photo without a candidate fetch.
    pub assignees: Vec<crate::forge::model::ForgeUserRef>,
    /// The reviewer list. All three providers fill this when `implemented.mr_reviewers`
    /// is true; the id is the provider's stable handle (GitHub login, GitLab username,
    /// Bitbucket the braced account uuid), the label the display name.
    pub reviewers: Vec<crate::forge::model::ForgeUserRef>,
    /// Reviewers who have submitted a verdict, supplied by the backend for providers
    /// that don't populate `reviews` (GitLab approvals, Bitbucket participant states).
    /// GitHub derives its completed reviewers on the frontend from `reviews`, so it
    /// leaves this empty.
    pub completed_reviewers: Vec<crate::forge::model::CompletedReviewerOut>,
    /// Whether the repository the PR lives in (its base/parent repo, not origin on a
    /// fork) allows the merge-commit method. GitHub only, best-effort — `None` means
    /// unknown (fetch failed, or GitLab/Bitbucket). The merge-method picker pre-gates
    /// on `false`; `None` never gates (the raw server error on merge is the fallback).
    pub merge_commit_allowed: Option<bool>,
    /// Whether the repository allows the squash-merge method. See `merge_commit_allowed`.
    pub squash_merge_allowed: Option<bool>,
    /// Whether the repository allows the rebase-merge method. See `merge_commit_allowed`.
    pub rebase_merge_allowed: Option<bool>,
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

const PR_VIEW_FIELDS: &str = "id,number,title,body,author,state,isDraft,baseRefName,headRefName,additions,deletions,url,commits,files,reviews,comments,statusCheckRollup,labels,assignees,reviewRequests";

const REPO_MERGE_SETTINGS_QUERY: &str = "query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed } }";

/// The three repository-level merge-method toggles (allow merge / squash / rebase),
/// each `None` when unknown.
#[derive(Default)]
struct RepoMergeSettings {
    merge_commit_allowed: Option<bool>,
    squash_merge_allowed: Option<bool>,
    rebase_merge_allowed: Option<bool>,
}

/// Fetch the repository's server-side merge-method settings for the repo the PR
/// LIVES IN. `pr_url` is the PR's html url — for a fork's outgoing PR this is the
/// PARENT/base repo (a PR url is always on the base repo), so we derive owner/name
/// from it rather than from origin (which is the fork). Best-effort by contract:
/// the caller treats any `Err` as "unknown" (all fields `None`) and never fails the
/// PR view over it. Owner/name are passed as GraphQL variables (validated by
/// [`parse_pr_url_repo`]), never interpolated into the query.
async fn gh_repo_merge_settings(repo_path: &str, pr_url: &str) -> AppResult<RepoMergeSettings> {
    let (host, owner, name) = parse_pr_url_repo(pr_url)?;
    let hostname_arg = (host != "github.com").then_some(host);

    let query_arg = format!("query={REPO_MERGE_SETTINGS_QUERY}");
    let owner_arg = format!("owner={owner}");
    let name_arg = format!("name={name}");
    let mut args: Vec<&str> = vec!["api", "graphql"];
    if let Some(h) = &hostname_arg {
        args.push("--hostname");
        args.push(h);
    }
    args.push("-f");
    args.push(&query_arg);
    args.push("-f");
    args.push(&owner_arg);
    args.push("-f");
    args.push(&name_arg);

    let out = run_gh(Some(repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse merge settings: {e}")))?;
    let repo = value.pointer("/data/repository");
    // A field GitHub omits/nulls stays `None` (unknown) rather than defaulting to a
    // gating value — the picker never disables an option on unknown.
    let flag = |key: &str| {
        repo.and_then(|r| r.get(key))
            .and_then(serde_json::Value::as_bool)
    };
    Ok(RepoMergeSettings {
        merge_commit_allowed: flag("mergeCommitAllowed"),
        squash_merge_allowed: flag("squashMergeAllowed"),
        rebase_merge_allowed: flag("rebaseMergeAllowed"),
    })
}

/// Full details for one PR's read view.
#[tauri::command]
pub async fn gh_pr_view(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<PrDetails> {
    // Resolve the lens slug so the PR number resolves against the chosen repo, not
    // the parent gh would auto-detect from an `upstream` remote. The REST top-ups
    // this fn calls (files/commits/reviews/comments) inherit the SAME lens so they
    // resolve to the SAME repo these PR numbers came from.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &slug,
            "--json",
            PR_VIEW_FIELDS,
        ],
        GH_TIMEOUT,
    )
    .await?;
    let raw: RawPr = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh pr view: {e}")))?;

    let login = |a: Option<RawLogin>| a.map(|x| x.login).unwrap_or_default();

    // `gh pr view --json files` caps at GitHub's GraphQL 100-file connection
    // limit, so a larger PR's rail would list only the first 100. When we hit
    // that cap, complete the list from the paginated REST files API (a PR with
    // exactly 100 files just makes one redundant call). Best-effort: if the REST
    // completion fails, keep the 100 GraphQL entries rather than failing the view.
    let files: Vec<PrFileOut> = if raw.files.len() >= 100 {
        match gh_pr_files_paginated(&repo_path, number, lens.as_deref()).await {
            Ok(complete) => complete
                .into_iter()
                .map(|f| PrFileOut {
                    path: f.filename,
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
            Err(_) => raw
                .files
                .into_iter()
                .map(|f| PrFileOut {
                    path: f.path,
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
        }
    } else {
        raw.files
            .into_iter()
            .map(|f| PrFileOut {
                path: f.path,
                additions: f.additions,
                deletions: f.deletions,
            })
            .collect()
    };

    // Same GraphQL-100-connection cap on commits/reviews/comments: complete each
    // from its paginated REST endpoint when we hit 100, best-effort (a REST
    // failure keeps the 100 GraphQL entries rather than failing the view).
    let commits: Vec<PrCommitOut> = if raw.commits.len() >= 100 {
        match gh_pr_commits_paginated(&repo_path, number, lens.as_deref()).await {
            Ok(complete) => complete,
            Err(_) => raw
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
                        message_body: c.message_body,
                        date: c.authored_date,
                        author,
                    }
                })
                .collect(),
        }
    } else {
        raw.commits
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
                    message_body: c.message_body,
                    date: c.authored_date,
                    author,
                }
            })
            .collect()
    };

    let reviews: Vec<PrThreadOut> = if raw.reviews.len() >= 100 {
        match gh_pr_reviews_paginated(&repo_path, number, lens.as_deref()).await {
            Ok(complete) => complete,
            Err(_) => raw
                .reviews
                .into_iter()
                .map(|r| PrThreadOut {
                    author: login(r.author),
                    author_avatar_url: String::new(),
                    state: r.state,
                    body: r.body,
                    date: r.submitted_at,
                    id: r.id,
                    url: String::new(),
                    viewer_did_author: false,
                    is_minimized: false,
                    minimized_reason: String::new(),
                    // A review row keeps its own id in `id`; `review_id` is for
                    // thread-comment rows to point back at their owning review.
                    review_id: String::new(),
                })
                .collect(),
        }
    } else {
        raw.reviews
            .into_iter()
            .map(|r| PrThreadOut {
                author: login(r.author),
                author_avatar_url: String::new(),
                state: r.state,
                body: r.body,
                date: r.submitted_at,
                id: r.id,
                url: String::new(),
                viewer_did_author: false,
                is_minimized: false,
                minimized_reason: String::new(),
                // A review row keeps its own id in `id`; `review_id` is for
                // thread-comment rows to point back at their owning review.
                review_id: String::new(),
            })
            .collect()
    };

    let comments: Vec<PrThreadOut> = if raw.comments.len() >= 100 {
        match gh_pr_comments_paginated(&repo_path, number, lens.as_deref()).await {
            Ok(complete) => complete,
            Err(_) => raw
                .comments
                .into_iter()
                .map(|c| PrThreadOut {
                    author: login(c.author),
                    author_avatar_url: String::new(),
                    state: String::new(),
                    body: c.body,
                    date: c.created_at,
                    id: c.id,
                    url: c.url,
                    viewer_did_author: c.viewer_did_author,
                    is_minimized: c.is_minimized,
                    minimized_reason: c.minimized_reason,
                    // Conversation comments belong to no review.
                    review_id: String::new(),
                })
                .collect(),
        }
    } else {
        raw.comments
            .into_iter()
            .map(|c| PrThreadOut {
                author: login(c.author),
                author_avatar_url: String::new(),
                state: String::new(),
                body: c.body,
                date: c.created_at,
                id: c.id,
                url: c.url,
                viewer_did_author: c.viewer_did_author,
                is_minimized: c.is_minimized,
                minimized_reason: c.minimized_reason,
                // Conversation comments belong to no review.
                review_id: String::new(),
            })
            .collect()
    };

    // Repository-level merge-method settings (allow merge / squash / rebase). The
    // `gh pr view --json` surface can't return these, so it's one extra `gh api
    // graphql` call, best-effort: on any failure the three fields stay `None` and the
    // picker gates exactly as before (raw server error on merge as the fallback). The
    // repo is derived from the PR's own url, so a fork's PR reports its BASE repo's
    // settings — the repo the merge actually lands in.
    let merge_settings = gh_repo_merge_settings(&repo_path, &raw.url)
        .await
        .unwrap_or_default();

    Ok(PrDetails {
        id: raw.id,
        number: raw.number,
        title: raw.title,
        body: raw.body,
        author: login(raw.author),
        // GitHub carries no avatar URL in the API; the frontend derives it from
        // the login, so leave it empty here.
        author_avatar_url: String::new(),
        state: raw.state,
        is_draft: raw.is_draft,
        base_ref_name: raw.base_ref_name,
        head_ref_name: raw.head_ref_name,
        additions: raw.additions,
        deletions: raw.deletions,
        url: raw.url,
        commits,
        files,
        reviews,
        comments,
        checks: raw
            .status_check_rollup
            .into_iter()
            .map(|c| {
                let name = if c.name.is_empty() { c.context } else { c.name };
                let status = [c.conclusion, c.state, c.status]
                    .into_iter()
                    .find(|s| !s.is_empty())
                    .unwrap_or_default();
                // CheckRun `detailsUrl` OR StatusContext `targetUrl`, whichever
                // is present (drop an empty string so an absent link stays None).
                let details_url = c
                    .details_url
                    .or(c.target_url)
                    .filter(|u| !u.is_empty());
                let (run_id, job_id) = details_url
                    .as_deref()
                    .map(parse_actions_run_job)
                    .unwrap_or((None, None));
                PrCheckOut {
                    name,
                    status,
                    details_url,
                    run_id,
                    job_id,
                    started_at: c.started_at.filter(|s| !s.is_empty()),
                    completed_at: c.completed_at.filter(|s| !s.is_empty()),
                }
            })
            .collect(),
        labels: raw.labels,
        assignees: raw
            .assignees
            .into_iter()
            .map(|a| crate::forge::model::ForgeUserRef {
                id: a.login.clone(),
                label: a.login,
                // GitHub avatar is login-derived on the frontend.
                avatar_url: String::new(),
                is_bot: false,
            })
            .collect(),
        // Pending requested USER and BOT reviewers (id = login). User requests are
        // editable in the picker; bot requests (e.g. Copilot) are display-only
        // read-only chips (`is_bot`), never in the picker's managed set — mirroring
        // how team requests are preserved untouched (the setter leaves both alone).
        reviewers: raw
            .review_requests
            .into_iter()
            .filter(|r| (r.typename == "User" || r.typename == "Bot") && !r.login.is_empty())
            .map(|r| {
                let is_bot = r.typename == "Bot";
                // The raw bot login is unreadable in a chip, so prettify Copilot's;
                // `id` still carries the real login. Other bots show the login verbatim.
                let label = if r.login == "copilot-pull-request-reviewer" {
                    "Copilot".to_string()
                } else {
                    r.login.clone()
                };
                crate::forge::model::ForgeUserRef {
                    id: r.login,
                    label,
                    // GitHub avatar is derived from the login on the frontend.
                    avatar_url: String::new(),
                    is_bot,
                }
            })
            .collect(),
        // GitHub derives its completed reviewers on the frontend from `reviews`.
        completed_reviewers: Vec::new(),
        merge_commit_allowed: merge_settings.merge_commit_allowed,
        squash_merge_allowed: merge_settings.squash_merge_allowed,
        rebase_merge_allowed: merge_settings.rebase_merge_allowed,
    })
}

/// The PR's current PENDING requested reviewers that are USERS (logins). Teams
/// and bots (e.g. Copilot) are intentionally excluded — exactly like teams — so
/// [`set_pr_reviewers`] can preserve them untouched and never `--remove-reviewer`
/// a bot.
async fn current_requested_reviewer_logins(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<String>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Wrap {
        #[serde(default)]
        review_requests: Vec<RawReviewRequest>,
    }
    // Inherit the lens so the PR resolves against the same repo as the write below.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let out = run_gh(
        Some(repo_path),
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &slug,
            "--json",
            "reviewRequests",
        ],
        GH_TIMEOUT,
    )
    .await?;
    let wrap: Wrap = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse reviewRequests: {e}")))?;
    Ok(wrap
        .review_requests
        .into_iter()
        .filter(|r| r.typename == "User" && !r.login.is_empty())
        .map(|r| r.login)
        .collect())
}

/// The PR author's login (`gh pr view --json author`) — excluded from the reviewer
/// candidates, because GitHub rejects requesting a review from the author.
async fn pr_author_login(repo_path: &str, number: u64, lens: Option<&str>) -> AppResult<String> {
    // Inherit the lens so the PR resolves against the same repo as its candidates.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let out = run_gh(
        Some(repo_path),
        // `// empty` so a GraphQL-null author (deleted account / some bots) yields an
        // empty string, not the literal "null" — otherwise the `!= author` candidate
        // filter compares against "null" and never excludes the real author.
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &slug,
            "--json",
            "author",
            "-q",
            ".author.login // empty",
        ],
        GH_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy().trim().to_string())
}

/// Replace a PR's requested USER reviewers with `desired` (logins) by diffing
/// against the current pending user requests and running one `gh pr edit
/// --add-reviewer … --remove-reviewer …`. **Team** and **bot** (e.g. Copilot)
/// requests are never touched (they're not in the diff), so managing people here
/// can't drop a team or a bot. GitHub
/// rejects requesting a review from the PR author, and a reviewer who already
/// submitted needs a *re-request* — those failures surface as the gh error rather
/// than being swallowed (`run_gh` carries the stderr).
pub async fn set_pr_reviewers(
    repo_path: &str,
    number: u64,
    desired: &[String],
    lens: Option<&str>,
) -> AppResult<()> {
    use std::collections::HashSet;
    let current = current_requested_reviewer_logins(repo_path, number, lens).await?;
    let desired_set: HashSet<&str> = desired.iter().map(String::as_str).collect();
    let current_set: HashSet<&str> = current.iter().map(String::as_str).collect();
    let add: Vec<&str> = desired
        .iter()
        .map(String::as_str)
        .filter(|l| !l.is_empty() && !current_set.contains(l))
        .collect();
    let remove: Vec<&str> = current
        .iter()
        .map(String::as_str)
        .filter(|l| !desired_set.contains(l))
        .collect();
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let num = number.to_string();
    let add_csv = add.join(",");
    let remove_csv = remove.join(",");
    // Resolve the lens slug so the PR reviewers are edited on the chosen repo
    // (`current_requested_reviewer_logins` above inherits the same lens, so the
    // diff and the write agree on which repo's PR they target).
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let mut args: Vec<&str> = vec!["pr", "edit", &num, "--repo", &slug];
    if !add.is_empty() {
        args.push("--add-reviewer");
        args.push(&add_csv);
    }
    if !remove.is_empty() {
        args.push("--remove-reviewer");
        args.push(&remove_csv);
    }
    run_gh(Some(repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// The reviewer picker's candidates for a GitHub PR: the repo's assignable users
/// (a close proxy for requestable reviewers — the overlap isn't exact, so a
/// non-requestable pick surfaces as a gh error on set), minus the user GitHub
/// would reject as a reviewer. For an existing PR (`Some`) that's the author; at
/// create time (`None`, no PR yet) it's the viewer. Sorted by login for a stable list.
pub async fn reviewer_candidates(
    repo_path: &str,
    number: Option<u64>,
    lens: Option<&str>,
) -> AppResult<Vec<crate::forge::model::ForgeUserRef>> {
    let logins =
        crate::github::issue::gh_assignable_users(repo_path.to_string(), lens.map(str::to_string))
            .await?;
    let exclude = match number {
        Some(n) => pr_author_login(repo_path, n, lens).await.unwrap_or_default(),
        None => current_login(repo_path).await.unwrap_or_default(),
    };
    let mut out: Vec<crate::forge::model::ForgeUserRef> = logins
        .into_iter()
        .filter(|l| !l.is_empty() && *l != exclude)
        .map(|l| crate::forge::model::ForgeUserRef {
            id: l.clone(),
            label: l,
            // GitHub avatar is derived from the login on the frontend.
            avatar_url: String::new(),
            is_bot: false,
        })
        .collect();
    out.sort_by_key(|a| a.label.to_lowercase());
    Ok(out)
}

const PR_REACTIONS_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reactionGroups{ content viewerHasReacted reactors{ totalCount } } comments(first:100){ nodes{ id reactionGroups{ content viewerHasReacted reactors{ totalCount } } } } } } }";

/// Reactions for a PR's body + each conversation comment (keyed by comment node
/// id). Same decoupled design as `gh_issue_reactions`: `viewerHasReacted` is
/// GraphQL-only, so this loads in parallel with the PR view and leaves
/// `gh_pr_view` untouched. Reuses the issue reaction types + mapper.
#[tauri::command]
pub async fn gh_pr_reactions(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<IssueReactions> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
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

/// One activity-timeline event on a PR, serialized as a tagged union keyed on
/// `kind` (camelCase). Feeds the Conversation tab's activity timeline
/// (force-pushes, label changes, review requests, state changes, renames). The
/// backend maps a GitHub `timelineItems` `__typename` onto one of these variants;
/// any node it can't classify is skipped rather than panicking the batch. Every
/// `actor`/`date`/oid field defaults to `""` when GitHub returns null (ghost or
/// deleted actors, gone commits).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrTimelineEventOut {
    /// `HeadRefForcePushedEvent` — the head branch was force-pushed.
    ForcePushed {
        before: String,
        after: String,
        actor: String,
        date: String,
    },
    /// `LabeledEvent` (`added = true`) / `UnlabeledEvent` (`added = false`).
    Labeled {
        label: String,
        color: String,
        added: bool,
        actor: String,
        date: String,
    },
    /// `ReviewRequestedEvent` — `reviewer` is a user login OR a team slug.
    ReviewRequested {
        reviewer: String,
        actor: String,
        date: String,
    },
    /// `ReadyForReviewEvent` — a draft was marked ready.
    ReadyForReview { actor: String, date: String },
    /// `ConvertToDraftEvent` — the PR was converted back to a draft.
    ConvertToDraft { actor: String, date: String },
    /// `ClosedEvent` — the PR was closed (without merging).
    Closed { actor: String, date: String },
    /// `ReopenedEvent` — a closed PR was reopened.
    Reopened { actor: String, date: String },
    /// `MergedEvent` — `commit_oid` is the merge commit (may be `None`).
    Merged {
        actor: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        commit_oid: Option<String>,
        date: String,
    },
    /// `RenamedTitleEvent` — the PR title changed.
    Renamed {
        previous: String,
        current: String,
        actor: String,
        date: String,
    },
    /// An approval was given. GitHub surfaces approvals through the review flow
    /// (they render as review cards), so its own timeline never emits this — it's
    /// produced by the GitLab (system-note "approved") and Bitbucket (`approval`
    /// activity) arms, whose approvals carry no reviewable body.
    Approved { actor: String, date: String },
    /// A "request changes" verdict without an accompanying review card. Emitted by
    /// the GitLab (system-note "requested changes") and Bitbucket (`changes_requested`
    /// activity) arms; GitHub renders its request-changes reviews as cards instead.
    ChangesRequested { actor: String, date: String },
    /// A previously-given approval was withdrawn (GitLab system-note "unapproved";
    /// Bitbucket has no explicit unapproval activity). GitHub never emits it.
    Unapproved { actor: String, date: String },
}

const PR_TIMELINE_QUERY: &str = r#"query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ timelineItems(last:100, itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT, LABELED_EVENT, UNLABELED_EVENT, REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT, RENAMED_TITLE_EVENT]){ nodes{ __typename ... on HeadRefForcePushedEvent{ actor{login} createdAt beforeCommit{oid} afterCommit{oid} } ... on LabeledEvent{ actor{login} createdAt label{name color} } ... on UnlabeledEvent{ actor{login} createdAt label{name color} } ... on ReviewRequestedEvent{ actor{login} createdAt requestedReviewer{ __typename ... on User{login} ... on Team{slug} } } ... on ReadyForReviewEvent{ actor{login} createdAt } ... on ConvertToDraftEvent{ actor{login} createdAt } ... on ClosedEvent{ actor{login} createdAt } ... on ReopenedEvent{ actor{login} createdAt } ... on MergedEvent{ actor{login} createdAt commit{oid} } ... on RenamedTitleEvent{ actor{login} createdAt previousTitle currentTitle } } } } } }"#;

/// Map one `timelineItems` node onto a `PrTimelineEventOut`, or `None` when the
/// `__typename` is missing/unrecognized (guarded so a single odd node doesn't
/// break the batch). Every string field defaults to `""` for null values — a
/// ghost actor, a gone force-push commit, an absent title — per the module's
/// nullability discipline (no `unwrap_or_default()` on a `from_value` result).
fn map_timeline_node(node: &serde_json::Value) -> Option<PrTimelineEventOut> {
    let s = |p: &str| {
        node.pointer(p)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let actor = s("/actor/login");
    let date = s("/createdAt");
    match node.get("__typename").and_then(serde_json::Value::as_str)? {
        "HeadRefForcePushedEvent" => Some(PrTimelineEventOut::ForcePushed {
            before: s("/beforeCommit/oid"),
            after: s("/afterCommit/oid"),
            actor,
            date,
        }),
        "LabeledEvent" | "UnlabeledEvent" => Some(PrTimelineEventOut::Labeled {
            label: s("/label/name"),
            color: s("/label/color"),
            added: node.get("__typename").and_then(serde_json::Value::as_str)
                == Some("LabeledEvent"),
            actor,
            date,
        }),
        "ReviewRequestedEvent" => {
            // requestedReviewer is a User (login) or a Team (slug); it can also be
            // null (the requested entity was deleted) → empty reviewer.
            let reviewer = {
                let user = s("/requestedReviewer/login");
                if user.is_empty() {
                    s("/requestedReviewer/slug")
                } else {
                    user
                }
            };
            Some(PrTimelineEventOut::ReviewRequested {
                reviewer,
                actor,
                date,
            })
        }
        "ReadyForReviewEvent" => Some(PrTimelineEventOut::ReadyForReview { actor, date }),
        "ConvertToDraftEvent" => Some(PrTimelineEventOut::ConvertToDraft { actor, date }),
        "ClosedEvent" => Some(PrTimelineEventOut::Closed { actor, date }),
        "ReopenedEvent" => Some(PrTimelineEventOut::Reopened { actor, date }),
        "MergedEvent" => {
            let commit_oid = node
                .pointer("/commit/oid")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some(PrTimelineEventOut::Merged {
                actor,
                commit_oid,
                date,
            })
        }
        "RenamedTitleEvent" => Some(PrTimelineEventOut::Renamed {
            previous: s("/previousTitle"),
            current: s("/currentTitle"),
            actor,
            date,
        }),
        _ => None,
    }
}

/// The PR's activity timeline — force-pushes, label changes, review requests, and
/// state changes (ready/draft/close/reopen/merge/rename) — for the Conversation
/// tab. GitHub's arm of the provider-neutral `forge_pr_timeline` dispatch (no longer
/// a Tauri command — the dispatcher owns the `#[tauri::command]` seam). Nodes arrive
/// oldest→newest and that order is preserved. GitHub does NOT emit the `Approved`/
/// `ChangesRequested`/`Unapproved` kinds — its approvals/reviews already render as
/// review cards, so `map_timeline_node` has no arms for them. Same decoupled design
/// as `gh_pr_reactions`: it loads in parallel and leaves `gh_pr_view` untouched.
pub async fn pr_timeline(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<PrTimelineEventOut>> {
    let (owner, name) = repo_owner_name(repo_path, lens).await?;
    let out = run_gh(
        Some(repo_path),
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
            &format!("query={PR_TIMELINE_QUERY}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse pr timeline: {e}")))?;
    let nodes = value
        .pointer("/data/repository/pullRequest/timelineItems/nodes")
        .and_then(serde_json::Value::as_array);
    Ok(nodes
        .map(|ns| ns.iter().filter_map(map_timeline_node).collect())
        .unwrap_or_default())
}

/// The PR's full unified diff (`gh pr diff`), capped for the webview. The
/// frontend splits it per file for the diff viewer.
///
/// Past 300 files GitHub refuses the `.diff` media type with HTTP 406
/// `too_large`, so `gh pr diff` fails outright. When we recognize that specific
/// failure we fall back to reconstructing a unified diff from the paginated
/// files API (`gh_pr_diff_from_files`) instead of failing the whole view. Any
/// other error propagates raw.
#[tauri::command]
pub async fn gh_pr_diff(repo_path: String, number: u64, lens: Option<String>) -> AppResult<String> {
    // Resolve the lens slug so the PR diff resolves against the chosen repo (the
    // files-API fallback below inherits the lens via `gh_pr_diff_from_files`).
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let out = match run_gh(
        Some(&repo_path),
        &["pr", "diff", &number.to_string(), "--repo", &slug],
        GH_TIMEOUT,
    )
    .await
    {
        Ok(out) => out,
        Err(e) if is_diff_too_large(&e.to_string()) => {
            // Reconstruct from the files API; if THAT fails, surface its error raw.
            return gh_pr_diff_from_files(&repo_path, number, lens.as_deref()).await;
        }
        Err(e) => return Err(e),
    };
    let (text, _) =
        crate::git::diff::truncate_at_char_boundary(out.stdout_lossy(), 2_000_000);
    Ok(text)
}

/// Validate a commit oid before it's interpolated into an API path — a hex sha
/// (git allows abbreviated ones, so length isn't fixed). Rejects empty / non-hex
/// values before any network call rather than passing a guessed path to gh.
fn validate_commit_oid(oid: &str) -> AppResult<()> {
    if oid.is_empty() || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidArgument(format!("invalid commit id: {oid}")));
    }
    Ok(())
}

/// The unified diff of ONE commit in a PR (`gh api repos/<slug>/commits/{oid}`
/// with the `application/vnd.github.diff` media type). Pinned to the origin slug
/// so a fork reads its own commit, not the parent's. Returns the raw unified diff
/// string, capped like `gh_pr_diff`. Plain fn (called by the forge dispatch).
///
/// INVARIANT — origin-pin the whole commit cluster (this + `commit_comments`),
/// even for an upstream-only SHA the History tab surfaces on a fork. GitHub's
/// fork-network storage serves ANY network SHA via the fork's own commits
/// endpoint, so the pin does not 404 (probed live on a real fork, 2026-07-16),
/// and the comments namespace deliberately becomes the fork's own thread rather
/// than the parent's.
pub async fn commit_diff(repo_path: &str, oid: &str) -> AppResult<String> {
    validate_commit_oid(oid)?;
    let slug = crate::github::gh_origin_slug(repo_path).await?;
    let endpoint = format!("repos/{slug}/commits/{oid}");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "-H",
            "Accept: application/vnd.github.diff",
            &endpoint,
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let (text, _) = crate::git::diff::truncate_at_char_boundary(out.stdout_lossy(), 2_000_000);
    Ok(text)
}

/// The signed-in user's login, resolved TOLERANTLY (`gh api user -q .login`) — any
/// failure yields `None`, so a commit comment's `viewer_did_author` falls back to
/// `false` (edit/delete hidden) rather than wrongly claiming authorship. Never
/// returns an empty string. Mirrors gitlab.rs's `current_user_login`.
async fn current_login(repo_path: &str) -> Option<String> {
    run_gh(Some(repo_path), &["api", "user", "-q", ".login"], GH_NETWORK_TIMEOUT)
        .await
        .ok()
        .map(|o| o.stdout_lossy().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// One commit comment as the REST list returns it. Every field tolerant/defaulted
/// (untrusted API JSON) — `line` is often null (map as-is), `position` nullable.
#[derive(Deserialize)]
struct GhCommitComment {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    user: Option<RawLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<u64>,
    #[serde(default)]
    position: Option<u64>,
}

/// List a commit's comments (`GET repos/{o}/{r}/commits/{sha}/comments`, paginated
/// via the `--slurp` idiom). `viewer_did_author` compares each author against the
/// tolerantly-resolved current login.
pub async fn commit_comments(
    repo_path: &str,
    sha: &str,
    lens: Option<&str>,
) -> AppResult<Vec<CommitCommentOut>> {
    validate_commit_oid(sha)?;
    // Resolve the lens slug so the commit's comments read from the chosen repo's
    // namespace (default origin — a fork reads its own, not the parent's).
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let viewer = current_login(repo_path).await;
    let endpoint = format!("repos/{slug}/commits/{sha}/comments");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "--paginate",
            "--slurp",
            "-X",
            "GET",
            &endpoint,
            "-f",
            "per_page=100",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // `--slurp` yields `[[...page1...],[...page2...]]`; flatten.
    let pages: Vec<Vec<GhCommitComment>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the commit comments: {e}")))?;
    Ok(pages
        .into_iter()
        .flatten()
        .map(|c| {
            let author = c.user.map(|u| u.login).unwrap_or_default();
            CommitCommentOut {
                viewer_did_author: viewer
                    .as_deref()
                    .is_some_and(|v| !author.is_empty() && author == v),
                id: c.id.to_string(),
                author,
                body: c.body,
                created_at: c.created_at,
                path: c.path,
                line: c.line,
                // GitHub commit comments have no multi-line range concept.
                start_line: None,
                position: c.position,
            }
        })
        .collect())
}

/// Post a comment on a commit (`POST repos/<slug>/commits/{sha}/comments`). A
/// whole-commit comment sends only `body`; an anchored one adds `path` + `position`
/// (GitHub's diff-position — the frontend computes it; `line` is ignored for GitHub).
///
/// INVARIANT — origin-pin the whole commit-comment cluster (this + edit/delete).
/// A comment created here MUST land on the user's own repo, not the parent: on a
/// fork, GitHub's fork-network storage lets you comment on any network SHA via the
/// fork's endpoint (probed live, 2026-07-16), and the resulting thread is the
/// fork's own — so create/read/edit/delete all agree on the fork's namespace.
pub async fn commit_comment_create(
    repo_path: &str,
    sha: &str,
    body: &str,
    path: Option<&str>,
    position: Option<u64>,
    lens: Option<&str>,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    validate_commit_oid(sha)?;
    // Resolve the lens slug so the commit comment lands in the chosen repo's
    // namespace (default origin — a fork's comment lands on the fork, not the parent).
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/commits/{sha}/comments");
    let mut payload = serde_json::json!({ "body": body });
    if let (Some(p), Some(pos)) = (path, position) {
        payload["path"] = serde_json::Value::String(p.to_string());
        payload["position"] = serde_json::Value::from(pos);
    }
    run_gh_input(
        Some(repo_path),
        &["api", "-X", "POST", &endpoint, "--input", "-"],
        &payload.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Edit a commit comment (`PATCH repos/{o}/{r}/comments/{id}`). Empty-body guard +
/// id parse run before the request.
pub async fn commit_comment_edit(
    repo_path: &str,
    comment_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let id: u64 = comment_id
        .trim()
        .parse()
        .map_err(|_| AppError::InvalidArgument(format!("invalid comment id: {comment_id}")))?;
    // Pin the origin slug so a fork's commit comment is edited on the fork, not the parent.
    let slug = crate::github::gh_origin_slug(repo_path).await?;
    let endpoint = format!("repos/{slug}/comments/{id}");
    let payload = serde_json::json!({ "body": body });
    run_gh_input(
        Some(repo_path),
        &["api", "-X", "PATCH", &endpoint, "--input", "-"],
        &payload.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Delete a commit comment (`DELETE repos/{o}/{r}/comments/{id}`). Id parse runs
/// before the request.
pub async fn commit_comment_delete(repo_path: &str, comment_id: &str) -> AppResult<()> {
    let id: u64 = comment_id
        .trim()
        .parse()
        .map_err(|_| AppError::InvalidArgument(format!("invalid comment id: {comment_id}")))?;
    // Pin the origin slug so a fork's commit comment is deleted on the fork, not the parent.
    let slug = crate::github::gh_origin_slug(repo_path).await?;
    let endpoint = format!("repos/{slug}/comments/{id}");
    run_gh(
        Some(repo_path),
        &["api", "-X", "DELETE", &endpoint],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Resolve a PR's head commit oid (`gh pr view {n} --json headRefOid`). Used to
/// anchor a new inline review comment/thread to the current head — the commits list
/// caps at 100, so this dedicated read is the reliable source.
async fn head_ref_oid(repo_path: &str, number: u64, lens: Option<&str>) -> AppResult<String> {
    // Inherit the lens so the PR resolves against the same repo as the write below.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let out = run_gh(
        Some(repo_path),
        &[
            "pr",
            "view",
            &number.to_string(),
            "--repo",
            &slug,
            "--json",
            "headRefOid",
            "-q",
            ".headRefOid",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let oid = out.stdout_lossy().trim().to_string();
    if oid.is_empty() {
        return Err(AppError::Gh("could not resolve the pull request head commit".into()));
    }
    Ok(oid)
}

/// Map the neutral side `"new"`/`"old"` onto GitHub's `RIGHT`/`LEFT`.
fn gh_side(side: &str) -> AppResult<&'static str> {
    match side {
        "new" => Ok("RIGHT"),
        "old" => Ok("LEFT"),
        other => Err(AppError::InvalidArgument(format!("invalid side: {other}"))),
    }
}

/// Create a NEW file:line-anchored review thread on a PR (`POST
/// repos/{o}/{r}/pulls/{n}/comments` via `--input -`). `side` is `"new"`/`"old"`;
/// `start_line` (GitHub-only multi-line range) adds `start_line` + `start_side`.
/// The head oid is resolved internally. Plain fn (called by the forge dispatch).
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
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument("a file path is required".into()));
    }
    let gh_side = gh_side(side)?;
    let commit_id = head_ref_oid(repo_path, number, lens).await?;
    let mut payload = serde_json::json!({
        "body": body,
        "commit_id": commit_id,
        "path": path,
        "line": line,
        "side": gh_side,
    });
    if let Some(start) = start_line {
        payload["start_line"] = serde_json::Value::from(start);
        payload["start_side"] = serde_json::Value::String(gh_side.to_string());
    }
    // Resolve the lens slug so the review thread lands on the chosen repo's PR.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}/comments");
    run_gh_input(
        Some(repo_path),
        &["api", "-X", "POST", &endpoint, "--input", "-"],
        &payload.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Submit a review in ONE atomic call (`POST repos/{o}/{r}/pulls/{n}/reviews` via
/// `--input -`). `verdict` is `"comment"`/`"approve"`/`"request_changes"` → the
/// GitHub `event` (COMMENT / APPROVE / REQUEST_CHANGES). The summary is omitted when
/// None/empty (GitHub docs claim body is required for COMMENT — we let a 422 surface
/// verbatim rather than substitute placeholder text). Inline comments carry
/// path/line/side (+ start_line/start_side for multi-line ranges). The guards
/// (verdict validity, request_changes needs a summary) run in the dispatch before
/// this is reached. Returns the posted/total counts (GitHub is atomic → all or none).
pub async fn review_submit(
    repo_path: &str,
    number: u64,
    verdict: &str,
    summary: Option<&str>,
    comments: &[DraftCommentIn],
    lens: Option<&str>,
) -> AppResult<ReviewSubmitOut> {
    let event = match verdict {
        "comment" => "COMMENT",
        "approve" => "APPROVE",
        "request_changes" => "REQUEST_CHANGES",
        other => return Err(AppError::InvalidArgument(format!("invalid verdict: {other}"))),
    };
    // Anchor the review's inline comments against the head the reviewer's lines were
    // computed on (not whatever head exists at submit time), like `thread_create`.
    let commit_id = head_ref_oid(repo_path, number, lens).await?;
    let mut payload = serde_json::json!({ "event": event, "commit_id": commit_id });
    if let Some(s) = summary.filter(|s| !s.trim().is_empty()) {
        payload["body"] = serde_json::Value::String(s.to_string());
    }
    let mut arr: Vec<serde_json::Value> = Vec::with_capacity(comments.len());
    for c in comments {
        let side = gh_side(&c.side)?;
        let mut o = serde_json::json!({
            "path": c.path,
            "line": c.line,
            "side": side,
            "body": c.body,
        });
        if let Some(start) = c.start_line {
            o["start_line"] = serde_json::Value::from(start);
            o["start_side"] = serde_json::Value::String(side.to_string());
        }
        arr.push(o);
    }
    if !arr.is_empty() {
        payload["comments"] = serde_json::Value::Array(arr);
    }
    // Resolve the lens slug so the review is submitted on the chosen repo's PR.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}/reviews");
    run_gh_input(
        Some(repo_path),
        &["api", "-X", "POST", &endpoint, "--input", "-"],
        &payload.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let total = comments.len() as u32;
    Ok(ReviewSubmitOut {
        posted: total,
        total,
        verdict_applied: verdict != "comment",
    })
}

/// True when `gh pr diff` failed with GitHub's "diff exceeds 300 files" refusal
/// (HTTP 406 `too_large`). Matched generously within that family — but only that
/// family — so a real too-large diff degrades to the files-API fallback while
/// every other failure keeps propagating raw.
fn is_diff_too_large(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("too_large")
        || m.contains("exceeded the maximum number of files")
        || m.contains("http 406")
        || m.contains("status code 406")
}

/// One entry from `repos/{owner}/{repo}/pulls/<n>/files`. Every field is
/// optional + defaulted so one malformed entry in the (CLI-produced) JSON can't
/// sink the whole reconstruction.
#[derive(Deserialize, Default)]
struct GhPrFile {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    /// added / removed / modified / renamed / changed / copied / unchanged.
    #[serde(default)]
    status: String,
    /// The `@@` hunks only — GitHub omits this for binary or individually-huge
    /// files. We synthesize the `---`/`+++` header lines ourselves.
    #[serde(default)]
    patch: Option<String>,
    #[serde(default)]
    additions: u32,
    #[serde(default)]
    deletions: u32,
}

/// Fetches the PR's complete changed-file list via the paginated files REST API.
/// `gh pr view --json files` and `gh pr diff` both cap at GitHub's GraphQL 100-file
/// connection limit; this endpoint paginates past it. Used both to reconstruct the
/// >300-file diff and to complete the PR-view file rail.
async fn gh_pr_files_paginated(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<GhPrFile>> {
    // Inherit the caller's lens: `gh_pr_view` resolves PR numbers against one repo,
    // so this top-up must resolve to the SAME repo, not the parent gh would
    // auto-detect from an `upstream` remote. `--paginate` on an array endpoint emits
    // one JSON array PER PAGE concatenated, which a single `from_str::<Vec<_>>` can't
    // parse — `--slurp` wraps the pages into one outer array of arrays, which we then
    // flatten. (gh 2.44+ supports `--slurp`.)
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}/files");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "--paginate",
            "--slurp",
            "-X",
            "GET",
            &endpoint,
            "-f",
            "per_page=100",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;

    // `--slurp` yields `[[...page1...],[...page2...]]`; flatten to the file list.
    let pages: Vec<Vec<GhPrFile>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR file list: {e}")))?;
    Ok(pages.into_iter().flatten().collect())
}

// --- PR-view list top-ups: commits / reviews / conversation comments -------
//
// `gh pr view --json {commits,reviews,comments}` reads GraphQL connections that
// cap at 100 items, so a PR with >100 of any silently shows the first 100 as if
// complete. Each helper below completes the list from the corresponding
// paginated REST endpoint (best-effort — the caller keeps the 100 GraphQL
// entries if the REST top-up fails), and a pure `*_to_out` mapper turns each REST
// row into the same Out shape the GraphQL arm produces (so both paths agree).

/// One entry from `repos/{owner}/{repo}/pulls/<n>/commits`. Fields optional +
/// defaulted so one malformed row can't sink the reconstruction.
#[derive(Deserialize, Default)]
struct GhPrRestCommit {
    /// The commit's `oid` (its sha) — the PR-view commit shape keys commits on
    /// `oid`, matching the GraphQL arm (which also maps GraphQL `oid` → `oid`).
    /// A commit's node id plays no role in the Out shape (unlike reviews and
    /// comments, whose GraphQL `node_id` is load-bearing), so it isn't read.
    #[serde(default)]
    sha: String,
    #[serde(default)]
    commit: GhPrRestCommitInner,
    /// The GitHub *account* that authored (may be null for a non-user commit);
    /// its `login` is the fallback display name.
    #[serde(default)]
    author: Option<RawLogin>,
}

#[derive(Deserialize, Default)]
struct GhPrRestCommitInner {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: GhPrRestCommitGitAuthor,
}

#[derive(Deserialize, Default)]
struct GhPrRestCommitGitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    date: String,
}

/// One entry from `repos/{owner}/{repo}/pulls/<n>/reviews`.
#[derive(Deserialize, Default)]
struct GhPrRestReview {
    /// GraphQL node id — mapped into the Out `id` (matches the GraphQL arm's
    /// `PRR_…` review node id, which thread-comment rows point back at).
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    user: Option<RawLogin>,
    /// Already APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING —
    /// same vocabulary the GraphQL `state` arm carries, so it passes straight
    /// through.
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    submitted_at: String,
}

/// One entry from `repos/{owner}/{repo}/issues/<n>/comments` — the PR's
/// conversation (issue) comments.
#[derive(Deserialize, Default)]
struct GhPrRestComment {
    /// GraphQL node id — mapped into the Out `id` (the ≤100 path uses GraphQL
    /// node ids).
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    user: Option<RawLogin>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    html_url: String,
}

/// Map a REST commit row to the PR-view commit shape, mirroring the GraphQL arm:
/// the message splits into a headline (first line) and body (everything after the
/// first blank line — GraphQL's messageHeadline/messageBody semantics), the
/// authored date is the git author date, and the display author is the git
/// author name, falling back to the GitHub account login.
fn rest_commit_to_out(c: GhPrRestCommit) -> PrCommitOut {
    let (headline, message_body) = split_commit_message(&c.commit.message);
    let git_name = c.commit.author.name;
    let author = if git_name.is_empty() {
        c.author.map(|a| a.login).unwrap_or_default()
    } else {
        git_name
    };
    PrCommitOut {
        // The commit's node id keeps the row in the GraphQL id space; `oid` is
        // the sha (GraphQL's `oid`).
        oid: c.sha,
        headline,
        message_body,
        date: c.commit.author.date,
        author,
    }
}

/// Split a full commit message into (headline, body) with GraphQL
/// messageHeadline/messageBody semantics: the headline is the first line; the
/// body is everything after the first blank line (empty when there is no blank
/// line, i.e. no body).
fn split_commit_message(message: &str) -> (String, String) {
    let headline = message.lines().next().unwrap_or("").to_string();
    // Body = text after the first blank line. If there is no blank line, there
    // is no body (a wrapped-but-unblanked second line is still part of no body,
    // matching GraphQL, which treats only a blank-line-separated remainder as
    // messageBody).
    let body = message
        .split_once("\n\n")
        .map(|(_, rest)| rest.trim_end_matches('\n').to_string())
        .unwrap_or_default();
    (headline, body)
}

/// Map a REST review row to the PR-view thread shape, mirroring the GraphQL
/// reviews arm (login → author, node_id → id, state/body/submitted_at through;
/// every other `PrThreadOut` field defaults exactly as the GraphQL arm does).
fn rest_review_to_out(r: GhPrRestReview) -> PrThreadOut {
    PrThreadOut {
        author: r.user.map(|u| u.login).unwrap_or_default(),
        author_avatar_url: String::new(),
        state: r.state,
        body: r.body,
        date: r.submitted_at,
        id: r.node_id,
        url: String::new(),
        viewer_did_author: false,
        is_minimized: false,
        minimized_reason: String::new(),
        // A review row keeps its own id in `id`; `review_id` points thread-comment
        // rows back at their owning review.
        review_id: String::new(),
    }
}

/// Map a REST conversation-comment row to the PR-view thread shape, mirroring the
/// GraphQL comments arm. `viewer_login` is the authenticated user's login
/// (resolved once per top-up); `viewer_did_author` is whether it wrote the
/// comment. REST issue comments carry no minimized state, so those default false.
fn rest_comment_to_out(c: GhPrRestComment, viewer_login: Option<&str>) -> PrThreadOut {
    let login = c.user.map(|u| u.login).unwrap_or_default();
    let viewer_did_author = viewer_login.is_some_and(|v| !v.is_empty() && v == login);
    PrThreadOut {
        author: login,
        author_avatar_url: String::new(),
        state: String::new(),
        body: c.body,
        date: c.created_at,
        id: c.node_id,
        url: c.html_url,
        viewer_did_author,
        is_minimized: false,
        minimized_reason: String::new(),
        // Conversation comments belong to no review.
        review_id: String::new(),
    }
}

/// Completes the PR's commit list via the paginated commits REST API, past the
/// 100-item GraphQL cap `gh pr view --json commits` hits. Returns rows in the
/// PR-view shape.
async fn gh_pr_commits_paginated(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<PrCommitOut>> {
    // Inherit the caller's lens: `gh_pr_view` resolves PR numbers against one repo,
    // so this top-up must resolve to the SAME repo, not the parent.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}/commits");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "--paginate",
            "--slurp",
            "-X",
            "GET",
            &endpoint,
            "-f",
            "per_page=100",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let pages: Vec<Vec<GhPrRestCommit>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR commit list: {e}")))?;
    Ok(pages
        .into_iter()
        .flatten()
        .map(rest_commit_to_out)
        .collect())
}

/// Completes the PR's review list via the paginated reviews REST API, past the
/// 100-item GraphQL cap. Returns rows in the PR-view thread shape.
async fn gh_pr_reviews_paginated(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<PrThreadOut>> {
    // Inherit the caller's lens: must resolve to the same repo `gh_pr_view`
    // resolved the PR number against, or it would 404.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/pulls/{number}/reviews");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "--paginate",
            "--slurp",
            "-X",
            "GET",
            &endpoint,
            "-f",
            "per_page=100",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let pages: Vec<Vec<GhPrRestReview>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR review list: {e}")))?;
    Ok(pages
        .into_iter()
        .flatten()
        .map(rest_review_to_out)
        .collect())
}

/// Completes the PR's conversation-comment list via the paginated issue-comments
/// REST API (a PR's conversation comments are issue comments), past the 100-item
/// GraphQL cap. Resolves the authenticated login once (best-effort) to set
/// `viewer_did_author`. Returns rows in the PR-view thread shape.
async fn gh_pr_comments_paginated(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<Vec<PrThreadOut>> {
    // Inherit the caller's lens: must resolve to the same repo `gh_pr_view`
    // resolved the PR number against, or it would 404.
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let endpoint = format!("repos/{slug}/issues/{number}/comments");
    let out = run_gh(
        Some(repo_path),
        &[
            "api",
            "--paginate",
            "--slurp",
            "-X",
            "GET",
            &endpoint,
            "-f",
            "per_page=100",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let pages: Vec<Vec<GhPrRestComment>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the PR comment list: {e}")))?;
    // Resolve the viewer login once, only now that this top-up fired. Best-effort:
    // if the probe fails, default `viewer_did_author` to false (no edit affordance)
    // rather than failing the top-up.
    let viewer_login = run_gh(
        Some(repo_path),
        &["api", "user", "-q", ".login"],
        GH_TIMEOUT,
    )
    .await
    .ok()
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|s| !s.is_empty());
    Ok(pages
        .into_iter()
        .flatten()
        .map(|c| rest_comment_to_out(c, viewer_login.as_deref()))
        .collect())
}

/// Fetches the PR's changed files via the paginated files API and rebuilds a
/// unified diff from them, in the same `git`-style format `gh pr diff` produces
/// so the frontend diff viewer parses it identically. This is the >300-file
/// fallback for `gh_pr_diff`.
async fn gh_pr_diff_from_files(
    repo_path: &str,
    number: u64,
    lens: Option<&str>,
) -> AppResult<String> {
    let files = gh_pr_files_paginated(repo_path, number, lens).await?;
    let diff = reconstruct_pr_diff(&files);
    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, 2_000_000);
    Ok(text)
}

/// Rebuild a full unified diff from GitHub files-API entries, mirroring the
/// GitLab reconstruction (`forge::gitlab::reconstruct_file_diff`) so the frontend
/// splitter — which keys on `diff --git`/`+++ b/<path>` — parses it exactly like
/// `gh pr diff` output. GitHub's `patch` carries only the `@@` hunks, so we
/// synthesize the `diff --git`/`---`/`+++` headers; a file with no `patch`
/// (binary or individually-huge) gets a `Binary files … differ` placeholder so it
/// still appears in the list rather than vanishing.
fn reconstruct_pr_diff(files: &[GhPrFile]) -> String {
    let mut out = String::new();
    for f in files {
        if f.filename.is_empty() {
            continue;
        }
        let new_path = f.filename.as_str();
        let is_added = f.status == "added";
        let is_removed = f.status == "removed";
        let is_renamed = f.status == "renamed";
        // The a/ side is the pre-change path — the previous filename on a rename,
        // otherwise the file's own path.
        let old_path = if is_renamed {
            f.previous_filename.as_deref().unwrap_or(new_path)
        } else {
            new_path
        };

        out.push_str(&format!("diff --git a/{old_path} b/{new_path}\n"));
        if is_renamed && old_path != new_path {
            out.push_str("rename from ");
            out.push_str(old_path);
            out.push('\n');
            out.push_str("rename to ");
            out.push_str(new_path);
            out.push('\n');
        }
        if is_added {
            out.push_str("new file mode 100644\n");
        } else if is_removed {
            out.push_str("deleted file mode 100644\n");
        }

        match &f.patch {
            Some(patch) if !patch.is_empty() => {
                let minus = if is_added {
                    "/dev/null".to_string()
                } else {
                    format!("a/{old_path}")
                };
                let plus = if is_removed {
                    "/dev/null".to_string()
                } else {
                    format!("b/{new_path}")
                };
                out.push_str(&format!("--- {minus}\n+++ {plus}\n"));
                out.push_str(patch);
                if !patch.ends_with('\n') {
                    out.push('\n');
                }
            }
            // No hunks: binary or an individually-huge file GitHub dropped the
            // patch for. Emit git's binary placeholder (the frontend recognizes
            // the `Binary files ` marker and renders it as an undisplayable file).
            _ => {
                out.push_str(&format!(
                    "Binary files a/{old_path} and b/{new_path} differ\n"
                ));
            }
        }
    }
    out
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
    /// "reply" (a follow-up comment beneath an inline finding — e.g. a human triage
    /// refutation, inheriting its thread's path/line), or "comment" (top-level
    /// conversation comment).
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
/// comments (each thread's opener plus the human follow-up replies beneath it),
/// and conversation comments — in one GraphQL round trip, each tagged with its
/// author's bot flag. The frontend filters to AI reviewers and folds their
/// findings into an AI re-review as soft context. The replies are harvested
/// (up to 19 per thread) so a re-review sees a finding's own dispositioning — a
/// triage "deferred by design" refutation under a bot's inline finding is that
/// finding's context, and without it the re-review re-flags what a human already
/// resolved.
#[tauri::command]
pub async fn gh_pr_external_reviews(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<ExternalReviewItem>> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    validate_graphql_embed(&owner, "repository owner")?;
    validate_graphql_embed(&name, "repository name")?;

    // `number` is a u64 (digits only), so it's safe to embed directly.
    let query = format!(
        r#"query{{ repository(owner:"{owner}", name:"{name}"){{ pullRequest(number:{number}){{ reviews(first:50){{ nodes{{ author{{ login __typename }} body state submittedAt commit{{ oid }} }} }} reviewThreads(first:100){{ nodes{{ isResolved isOutdated path line originalLine comments(first:20){{ nodes{{ author{{ login __typename }} body createdAt commit{{ oid }} originalCommit{{ oid }} }} }} }} }} comments(first:100){{ nodes{{ author{{ login __typename }} body createdAt }} }} }} }} }}"#
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
    // CodeRabbit's specific suggestions). Node 0 of each thread is its opener (the
    // reviewer's finding), mapped as `inline`. The human follow-up replies beneath
    // it (nodes 1..) are mapped as `reply` items — a triage "deferred by design"
    // refutation under a finding is that finding's own context, so an AI re-review
    // must see it or it re-flags what a human already dispositioned. Replies inherit
    // the thread's path/line/resolved/outdated and are pushed right after their
    // opener so items stay thread-grouped in order.
    if let Some(nodes) = pr
        .and_then(|p| p.pointer("/reviewThreads/nodes"))
        .and_then(|v| v.as_array())
    {
        for t in nodes {
            let Some(comments) = t
                .pointer("/comments/nodes")
                .and_then(|v| v.as_array())
            else {
                continue;
            };
            // Outdated threads carry `"line": null` (key present, value null), and
            // `pointer` returns `Some(Null)` for that — so convert to `u64` BEFORE
            // the `originalLine` fallback, else a null `line` swallows the fallback
            // and reports line 0 (see `gh_pr_review_threads` for the same trap).
            let line = t
                .pointer("/line")
                .and_then(|x| x.as_u64())
                .or_else(|| t.pointer("/originalLine").and_then(|x| x.as_u64()))
                .unwrap_or(0) as u32;
            let path = str_at(t, "/path");
            let is_resolved = t
                .pointer("/isResolved")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let is_outdated = t
                .pointer("/isOutdated")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            // The first non-empty comment is the thread's opener (`inline`); the
            // rest are `reply`. Keying on the raw index would tag replies "reply"
            // with no `inline` opener when the opener's body is empty — so flip
            // `saw_opener` only after the first pushed item, promoting the first
            // real comment.
            let mut saw_opener = false;
            for c in comments {
                let body = str_at(c, "/body");
                if body.trim().is_empty() {
                    continue;
                }
                let commit_sha = {
                    let latest = str_at(c, "/commit/oid");
                    if latest.is_empty() {
                        str_at(c, "/originalCommit/oid")
                    } else {
                        latest
                    }
                };
                let kind = if saw_opener { "reply" } else { "inline" };
                saw_opener = true;
                items.push(ExternalReviewItem {
                    kind: kind.into(),
                    author: str_at(c, "/author/login"),
                    is_bot: is_bot(c, "/author/__typename"),
                    body,
                    path: path.clone(),
                    line,
                    commit_sha,
                    state: String::new(),
                    is_resolved,
                    is_outdated,
                    created_at: str_at(c, "/createdAt"),
                });
            }
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

/// Fetches the remaining replies of a single review thread whose inner
/// `comments(first:50)` connection had more than 50 (`hasNextPage`). Keyed on the
/// thread's GraphQL node id, resuming from `after` (the inner `endCursor`). Both
/// the node id and the cursor are server-opaque, so they travel as GraphQL
/// VARIABLES (`-f`), never `format!`-embedded — the injection-safe idiom the rest
/// of this file uses. Bounded at 5 extra pages (500 more replies, the repo's
/// 500-cap idiom): past that the tail is truncated rather than looping. `map` is
/// the same per-comment mapper the main query uses, so shapes agree. Best-effort:
/// callers keep the first 50 on any error rather than failing the threads read.
async fn gh_thread_comment_replies_topup(
    repo_path: &str,
    thread_id: &str,
    after: &str,
    map: impl Fn(&serde_json::Value) -> PrThreadOut,
) -> AppResult<Vec<PrThreadOut>> {
    // Same comment field set the main `reviewThreads` query selects, so a topped-up
    // reply maps identically to a first-page one.
    const QUERY: &str = "query($id: ID!, $cursor: String){ node(id: $id){ ... on PullRequestReviewThread { comments(first: 100, after: $cursor){ pageInfo{ hasNextPage endCursor } nodes{ id author{ login } body createdAt url viewerDidAuthor isMinimized minimizedReason diffHunk pullRequestReview{ id } } } } } }";
    let mut extra: Vec<PrThreadOut> = Vec::new();
    let mut cursor = after.to_string();
    for _ in 0..5 {
        let out = run_gh(
            Some(repo_path),
            &[
                "api",
                "graphql",
                "-f",
                &format!("query={QUERY}"),
                "-f",
                &format!("id={thread_id}"),
                "-f",
                &format!("cursor={cursor}"),
            ],
            GH_NETWORK_TIMEOUT,
        )
        .await?;
        let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Gh(format!("could not parse the review-thread replies: {e}")))?;
        let comments = value.pointer("/data/node/comments");
        if let Some(nodes) = comments
            .and_then(|c| c.pointer("/nodes"))
            .and_then(|v| v.as_array())
        {
            extra.extend(nodes.iter().map(&map));
        }
        let has_next = comments
            .and_then(|c| c.pointer("/pageInfo/hasNextPage"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let end_cursor = comments
            .and_then(|c| c.pointer("/pageInfo/endCursor"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !has_next || end_cursor.is_empty() {
            break;
        }
        cursor = end_cursor.to_string();
    }
    Ok(extra)
}

/// File:line-anchored review threads on a PR — GitHub's `reviewThreads` mapped
/// onto the neutral `ReviewThreadOut`. Each thread carries its full reply chain
/// (oldest first). Empty-comment threads are skipped. Line falls back to the
/// original line, then 0 (an outdated thread whose anchor moved has a null line).
/// Follows the `reviewThreads` cursor up to 5 pages (500 threads) so a PR with
/// many threads isn't silently truncated — parity with the Bitbucket comments read.
/// A thread with more than 50 replies is topped up per-thread via
/// [`gh_thread_comment_replies_topup`] (only when its inner `hasNextPage`, so the
/// common case adds no extra requests).
#[tauri::command]
pub async fn gh_pr_review_threads(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<ReviewThreadOut>> {
    let (owner, name) = repo_owner_name(&repo_path, lens.as_deref()).await?;
    validate_graphql_embed(&owner, "repository owner")?;
    validate_graphql_embed(&name, "repository name")?;

    // owner/name are validated remote-parse values and `number` is a u64 (digits
    // only), so all three are safe to embed. The pagination `cursor` is server-opaque
    // text, so it travels as a GraphQL VARIABLE (never format!-embedded).
    let query = format!(
        r#"query($cursor: String){{ repository(owner:"{owner}", name:"{name}"){{ pullRequest(number:{number}){{ reviewThreads(first:100, after:$cursor){{ pageInfo{{ endCursor hasNextPage }} nodes{{ id isResolved isOutdated diffSide line originalLine startLine originalStartLine path comments(first:50){{ pageInfo{{ hasNextPage endCursor }} nodes{{ id author{{ login }} body createdAt url viewerDidAuthor isMinimized minimizedReason diffHunk pullRequestReview{{ id }} }} }} }} }} }} }} }}"#
    );

    let str_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    let bool_at = |v: &serde_json::Value, p: &str| {
        v.pointer(p).and_then(|x| x.as_bool()).unwrap_or(false)
    };
    // One review-thread comment JSON node → the neutral `PrThreadOut`. Shared by
    // the main query and the >50-reply top-up so both map identically (the same
    // field set the inner `comments{nodes{…}}` selection above requests).
    let map_comment = |c: &serde_json::Value| PrThreadOut {
        author: str_at(c, "/author/login"),
        author_avatar_url: String::new(),
        state: String::new(),
        body: str_at(c, "/body"),
        date: str_at(c, "/createdAt"),
        id: str_at(c, "/id"),
        url: str_at(c, "/url"),
        viewer_did_author: bool_at(c, "/viewerDidAuthor"),
        is_minimized: bool_at(c, "/isMinimized"),
        minimized_reason: str_at(c, "/minimizedReason"),
        // The comment's own owning review (nullable — a reply outside a batched
        // review still carries the empty wrapper review GitHub auto-creates).
        // `str_at` maps a present-but-null value to "".
        review_id: str_at(c, "/pullRequestReview/id"),
    };

    let mut threads: Vec<ReviewThreadOut> = Vec::new();
    let mut cursor: Option<String> = None;
    // Bounded at 5 pages (500 threads) — a larger PR truncates rather than looping.
    for _ in 0..5 {
        // The `cursor` variable is omitted on the first request (a missing GraphQL
        // variable is null → the first page); later pages pass the prior endCursor.
        let mut args: Vec<String> =
            vec!["api".into(), "graphql".into(), "-f".into(), format!("query={query}")];
        if let Some(c) = &cursor {
            args.push("-f".into());
            args.push(format!("cursor={c}"));
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT).await?;
        let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Gh(format!("could not parse the PR review threads: {e}")))?;

        let review_threads = value.pointer("/data/repository/pullRequest/reviewThreads");
        if let Some(nodes) = review_threads
            .and_then(|rt| rt.pointer("/nodes"))
            .and_then(|v| v.as_array())
        {
            for t in nodes {
                let mut comments: Vec<PrThreadOut> = t
                    .pointer("/comments/nodes")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().map(&map_comment).collect())
                    .unwrap_or_default();
                // A thread with no comments carries no content to anchor — skip it.
                if comments.is_empty() {
                    continue;
                }
                // >50-reply thread: the inner `comments(first:50)` connection didn't
                // fetch the tail. Top it up with a follow-up query keyed on the
                // thread's node id (both id and cursor are server-opaque → GraphQL
                // VARIABLES, never format!-embedded). Rare, so this adds ZERO extra
                // requests for the common ≤50-reply case. Best-effort per the top-up
                // policy: on any failure keep the first 50 rather than failing the
                // whole threads read.
                let inner_has_next = bool_at(t, "/comments/pageInfo/hasNextPage");
                let inner_cursor = str_at(t, "/comments/pageInfo/endCursor");
                if inner_has_next && !inner_cursor.is_empty() {
                    let thread_id = str_at(t, "/id");
                    if !thread_id.is_empty() {
                        if let Ok(extra) =
                            gh_thread_comment_replies_topup(&repo_path, &thread_id, &inner_cursor, &map_comment)
                                .await
                        {
                            comments.extend(extra);
                        }
                    }
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
                // The owning review's node id comes off the first comment's
                // `pullRequestReview`, which is nullable — `str_at` maps a
                // present-but-null value to "" (it converts to `&str` before use, so
                // the `Some(Null)` pointer trap can't swallow anything here).
                let review_id = str_at(t, "/comments/nodes/0/pullRequestReview/id");
                threads.push(ReviewThreadOut {
                    id: str_at(t, "/id"),
                    path: str_at(t, "/path"),
                    line,
                    start_line,
                    side: side.into(),
                    is_resolved: bool_at(t, "/isResolved"),
                    is_outdated: bool_at(t, "/isOutdated"),
                    diff_hunk,
                    review_id,
                    comments,
                });
            }
        }

        // Advance only while GitHub reports another page AND hands back a cursor.
        let has_next = review_threads
            .and_then(|rt| rt.pointer("/pageInfo/hasNextPage"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let end_cursor = review_threads
            .and_then(|rt| rt.pointer("/pageInfo/endCursor"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !has_next || end_cursor.is_empty() {
            break;
        }
        cursor = Some(end_cursor.to_string());
    }
    Ok(threads)
}

/// Replies in an existing review thread, addressed by its GraphQL node id. The id
/// and body travel as GraphQL variables (never format!-embedded) — the
/// injection-safe idiom `edit_comment` uses.
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

/// A subset of the GitHub REST `GET /repos/{slug}/pulls` item, enough to build a
/// [`PrInfo`] for the upstream-lens duplicate probe (see [`gh_prs_for_branch`]).
/// Tolerant serde over the untrusted REST payload.
#[derive(Deserialize)]
struct GhPrRestPull {
    number: u64,
    html_url: String,
    #[serde(default)]
    title: String,
    base: GhPrRestPullRef,
    head: GhPrRestPullRef,
    #[serde(default)]
    draft: bool,
}

#[derive(Deserialize)]
struct GhPrRestPullRef {
    #[serde(rename = "ref", default)]
    ref_name: String,
}

/// Map a REST `pulls` item onto the [`PrInfo`] the frontend already consumes. The
/// caller queries `state=open`, so every item here is open by construction — hence
/// the `"OPEN"` casing (matching what `gh pr list --json state` emits for the
/// origin path). Only the fields the compare-panel probe needs are populated.
fn rest_pull_to_pr_info(p: GhPrRestPull) -> PrInfo {
    PrInfo {
        number: p.number,
        url: p.html_url,
        title: p.title,
        base_ref_name: p.base.ref_name,
        head_ref_name: p.head.ref_name,
        is_draft: p.draft,
        state: "OPEN".to_string(),
        author: None,
        labels: Vec::new(),
        created_at: String::new(),
        head_sha: String::new(),
    }
}

/// Build the REST endpoint for the upstream-lens duplicate probe:
/// `repos/<parent_slug>/pulls?head=<fork_owner>:<head>&state=open`. `fork_owner`
/// and `head` are the only untrusted query VALUES, so each is percent-encoded via
/// the shared [`encode_query_value`](crate::forge::encode_query_value) (escapes
/// `&`, `%`, `#`, `+`, `?`, `=`, space, `/`, `:`, … — everything outside the
/// RFC-3986 unreserved set) so a legal-but-hostile refname like `feat&state=all`
/// can't inject query parameters. The `:` separator is added LITERALLY between the
/// two encoded parts because GitHub's `?head=owner:branch` filter needs a real
/// colon there; `parent_slug` is a validated `owner/repo` remote path whose `/` is
/// a real path segment, so it stays unencoded. Pure — unit-tested.
fn upstream_pulls_endpoint(parent_slug: &str, fork_owner: &str, head: &str) -> String {
    let owner = crate::forge::encode_query_value(fork_owner);
    let head = crate::forge::encode_query_value(head);
    format!("repos/{parent_slug}/pulls?head={owner}:{head}&state=open")
}

/// Open PRs whose head is `head` (there's at most one per base). Lets the UI
/// offer "View pull request" instead of "Create" once one already exists.
///
/// `lens`: `None`/`Some("origin")` probes the fork's own PRs (consistent with
/// `gh_pr_list`); `Some("upstream")` probes the PARENT repo — the fork
/// contribution flow's "did I already open this upstream?" check.
///
/// The upstream arm does NOT use `gh pr list --head`: verified live 2026-07-16,
/// `gh pr list --head "owner:branch"` silently returns `[]` even when the PR
/// exists (it doesn't support the owner-prefixed head form). We hit REST instead
/// — `GET repos/<parent>/pulls?head=<fork_owner>:<head>&state=open` — which
/// matches cross-fork heads correctly. The caller passes a BARE branch name; we
/// compose the `owner:` prefix here from the fork's origin owner.
#[tauri::command]
pub async fn gh_prs_for_branch(
    repo_path: String,
    head: String,
    lens: Option<String>,
) -> AppResult<Vec<PrInfo>> {
    if head.is_empty() || head.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid branch: {head}")));
    }
    if lens.as_deref() == Some("upstream") {
        let parent_slug = crate::github::gh_lens_slug(&repo_path, Some("upstream")).await?;
        let origin_slug = crate::github::gh_lens_slug(&repo_path, None).await?;
        let fork_owner = crate::github::fork_owner_of(&origin_slug);
        let endpoint = upstream_pulls_endpoint(&parent_slug, fork_owner, &head);
        let out = run_gh(
            Some(&repo_path),
            &["api", "--method", "GET", &endpoint],
            GH_TIMEOUT,
        )
        .await?;
        let pulls: Vec<GhPrRestPull> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Gh(format!("could not parse gh api pulls: {e}")))?;
        return Ok(pulls.into_iter().map(rest_pull_to_pr_info).collect());
    }
    // Pin the resolved slug so this "does a PR exist for this branch?" check reads the
    // fork's own PRs (consistent with `gh_pr_list`), not the parent's.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "pr",
            "list",
            "--repo",
            &slug,
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
#[allow(clippy::too_many_arguments)]
pub async fn gh_pr_create(
    state: State<'_, AppState>,
    repo_path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
    labels: Vec<String>,
    assignees: Vec<String>,
    lens: Option<String>,
) -> AppResult<PrRef> {
    // The command shell derefs the managed `State` to a plain `&AppState` and
    // delegates to the core, so off-Tauri callers (the MCP server, via
    // `forge_pr_create_core`) can create a PR with an `AppState` they own.
    gh_pr_create_core(
        &state, repo_path, base, head, title, body, draft, labels, assignees, lens,
    )
    .await
}

/// The body of [`gh_pr_create`], taking a plain `&AppState` so it is callable off
/// the Tauri runtime (the MCP server routes here through `forge_pr_create_core`).
///
/// `lens` selects the target repo:
/// - `None`/`Some("origin")`: a same-repo PR **on the fork itself**, created with
///   an explicit `-R <origin-slug>`. This is a deliberate behavior change from
///   Part A (#56): the create call used to be UNPINNED, so on a fork `gh` would
///   auto-resolve to the PARENT — meaning `gh_prs_for_branch`/`gh_pr_list` checked
///   the fork while create silently targeted upstream. Pinning origin here closes
///   that disclosed asymmetry: origin lens = honest, explicit same-repo PR.
/// - `Some("upstream")`: the real fork contribution flow — push `head` to origin
///   (origin IS the fork), then `gh pr create -R <parent> --head <fork_owner>:<head>`.
///   Labels/assignees/reviewers are rejected up front (v1 keeps the cross-repo
///   create minimal; the post-create edit is skipped on this path). Per gh's own
///   docs (`gh pr create --help`, verified 2026-07-16) the `<user>:<branch>` head
///   form does NOT support an organization as `<user>` (cli/cli#10093); gh's error
///   is the disclosure surface if the fork owner is an org.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn gh_pr_create_core(
    state: &AppState,
    repo_path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
    labels: Vec<String>,
    assignees: Vec<String>,
    lens: Option<String>,
) -> AppResult<PrRef> {
    // Pre-mutation guards: every local precondition is checked BEFORE the push, so
    // no remote mutation happens on an input we'd have rejected.
    validate_branch(&base)?;
    validate_branch(&head)?;
    if title.trim().is_empty() {
        return Err(AppError::InvalidArgument("a PR title is required".into()));
    }

    let upstream = lens.as_deref() == Some("upstream");
    if lens.is_some() && !matches!(lens.as_deref(), Some("origin") | Some("upstream")) {
        // Validate the lens before any remote work, mirroring `gh_lens_slug`.
        return Err(AppError::InvalidArgument(format!(
            "unknown remote lens: {}",
            lens.as_deref().unwrap_or_default()
        )));
    }

    if upstream {
        // v1: the cross-repo create is minimal — no post-create edit — so reject
        // metadata up front rather than silently dropping it (pre-mutation guard).
        reject_upstream_create_metadata(&labels, &assignees)?;
        let parent_slug = crate::github::gh_lens_slug(&repo_path, Some("upstream")).await?;
        let origin_slug = crate::github::gh_lens_slug(&repo_path, None).await?;
        let fork_owner = crate::github::fork_owner_of(&origin_slug).to_string();

        // Push `head` to origin — origin IS the fork; the PR's head lives there.
        run_git_mutating(
            state,
            &repo_path,
            &["push", "-u", "origin", &head],
            NETWORK_TIMEOUT,
        )
        .await?;

        let cross_head = format!("{fork_owner}:{head}");
        let mut args = vec![
            "pr",
            "create",
            "--repo",
            &parent_slug,
            "--base",
            &base,
            "--head",
            &cross_head,
            "--title",
            &title,
            "--body",
            &body,
        ];
        if draft {
            args.push("--draft");
        }
        let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
        let (number, url) = scrape_pr_ref(&out.stdout_lossy());
        return Ok(PrRef { number, url });
    }

    // Origin lens (default). Pin the origin slug so this is a same-repo PR on the
    // fork, explicit and honest (see the doc comment above).
    let origin_slug = crate::github::gh_lens_slug(&repo_path, None).await?;

    // gh can only open a PR for a branch that exists on the remote.
    run_git_mutating(
        state,
        &repo_path,
        &["push", "-u", "origin", &head],
        NETWORK_TIMEOUT,
    )
    .await?;

    let mut args = vec![
        "pr",
        "create",
        "--repo",
        &origin_slug,
        "--base",
        &base,
        "--head",
        &head,
        "--title",
        &title,
        "--body",
        &body,
    ];
    if draft {
        args.push("--draft");
    }
    // Labels/assignees are applied AFTER create (below), NOT via `gh pr create
    // --label/--assignee`: gh 2.94 records EACH value TWICE on the PR's activity
    // timeline when it's passed at create time (it sets them in the create
    // mutation AND re-applies them in a follow-up), so the feed shows doubled
    // "added the X label" rows. `gh pr edit --add-label/--add-assignee` applies
    // each exactly once. (Reproduced empirically 2026-07-10.)
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;

    let (number, url) = scrape_pr_ref(&out.stdout_lossy());

    // Apply labels + assignees once, post-create. Address the PR by NUMBER when the
    // URL scrape yielded one (unambiguous, and the only form `gh pr edit` accepts for
    // a cross-fork `OWNER:BRANCH` head), else fall back to the head BRANCH — so this
    // still never depends on the scrape succeeding (the old `gh pr create --label`
    // argv applied labels unconditionally; keep that guarantee). Values come from the
    // repo's own pickers, so they resolve; an unknown one would fail this edit AFTER
    // the PR exists (surfaced, not silent). Pinned to the origin slug to match the
    // create call above.
    if !labels.is_empty() || !assignees.is_empty() {
        let pr_id = if number != 0 {
            number.to_string()
        } else {
            head.clone()
        };
        let mut edit_args = vec!["pr", "edit", pr_id.as_str(), "--repo", &origin_slug];
        for label in &labels {
            edit_args.push("--add-label");
            edit_args.push(label);
        }
        for assignee in &assignees {
            edit_args.push("--add-assignee");
            edit_args.push(assignee);
        }
        // The PR already exists; on a rare edit failure (network, or a value the
        // pickers wouldn't offer) disclose the partial state — with the PR's
        // location when known — so the caller doesn't read it as "create failed".
        let at = if url.is_empty() {
            String::new()
        } else {
            format!(" ({url})")
        };
        run_gh(Some(&repo_path), &edit_args, GH_NETWORK_TIMEOUT)
            .await
            .map_err(move |e| {
                AppError::Gh(format!(
                    "The pull request was created{at}, but applying its labels/assignees failed: {e}. Add them from the PR."
                ))
            })?;
    }

    Ok(PrRef { number, url })
}

/// Pre-mutation guard for the upstream-lens PR create: the v1 cross-repo flow is
/// minimal (no post-create `gh pr edit`), so any labels or assignees are rejected
/// up front rather than silently dropped. Pure, so it's unit-testable and runs
/// before the branch push. (Reviewers aren't a param here — the `forge_pr_create`
/// dispatch rejects create-time reviewers for GitHub before reaching this core —
/// but the message names them so the surface reads consistently.)
fn reject_upstream_create_metadata(labels: &[String], assignees: &[String]) -> AppResult<()> {
    if !labels.is_empty() || !assignees.is_empty() {
        return Err(AppError::InvalidArgument(
            "Labels, assignees, and reviewers aren't supported when creating a pull request on the upstream repository.".into(),
        ));
    }
    Ok(())
}

/// Scrape the new PR's number + URL from `gh pr create` stdout (gh prints the URL
/// as its last line). Shared by the origin and upstream create paths.
fn scrape_pr_ref(stdout: &str) -> (u64, String) {
    let url = stdout
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
    (number, url)
}

#[cfg(test)]
mod tests {
    use super::{
        host_from_url, is_diff_too_large, map_timeline_node, parse_actions_run_job,
        parse_auth_accounts, parse_pr_url_repo, reconstruct_pr_diff,
        reject_upstream_create_metadata, rest_comment_to_out, rest_commit_to_out,
        rest_pull_to_pr_info, rest_review_to_out, rollup_state_to_ci, scrape_pr_ref,
        split_commit_message, upstream_pulls_endpoint, GhPrFile, GhPrRestComment, GhPrRestCommit,
        GhPrRestCommitGitAuthor, GhPrRestCommitInner, GhPrRestPull, GhPrRestReview,
        PrTimelineEventOut, RawLogin,
    };
    use crate::error::AppError;

    fn file(status: &str, filename: &str, patch: Option<&str>) -> GhPrFile {
        GhPrFile {
            filename: filename.to_string(),
            previous_filename: None,
            status: status.to_string(),
            patch: patch.map(str::to_string),
            additions: 0,
            deletions: 0,
        }
    }

    fn rest_commit(sha: &str, message: &str, git_name: &str, date: &str) -> GhPrRestCommit {
        GhPrRestCommit {
            sha: sha.to_string(),
            commit: GhPrRestCommitInner {
                message: message.to_string(),
                author: GhPrRestCommitGitAuthor {
                    name: git_name.to_string(),
                    date: date.to_string(),
                },
            },
            author: None,
        }
    }

    #[test]
    fn rollup_state_to_ci_maps_the_precomputed_states() {
        // The precomputed single-enum rollup states GitHub returns.
        assert_eq!(rollup_state_to_ci(Some("SUCCESS")), "passing");
        assert_eq!(rollup_state_to_ci(Some("FAILURE")), "failing");
        assert_eq!(rollup_state_to_ci(Some("ERROR")), "failing");
        assert_eq!(rollup_state_to_ci(Some("PENDING")), "pending");
        assert_eq!(rollup_state_to_ci(Some("EXPECTED")), "pending");
        // Case-insensitive.
        assert_eq!(rollup_state_to_ci(Some("success")), "passing");
        // A null rollup (no checks configured) → none.
        assert_eq!(rollup_state_to_ci(None), "none");
        // Empty string (odd/absent state) → none, never a false green.
        assert_eq!(rollup_state_to_ci(Some("")), "none");
        // An unrecognized state biases to pending (conservative).
        assert_eq!(rollup_state_to_ci(Some("SOMETHING_NEW")), "pending");
    }

    #[test]
    fn parse_pr_url_repo_extracts_host_owner_name() {
        // github.com PR url.
        let (host, owner, name) =
            parse_pr_url_repo("https://github.com/biomejs/biome/pull/10937").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "biomejs");
        assert_eq!(name, "biome");

        // GitHub Enterprise host, dotted/underscored/hyphened segments.
        let (host, owner, name) =
            parse_pr_url_repo("https://github.acme.com/my-org/my_repo.js/pull/42").unwrap();
        assert_eq!(host, "github.acme.com");
        assert_eq!(owner, "my-org");
        assert_eq!(name, "my_repo.js");

        // Trailing garbage after `/pull/N` is fine — owner/name are the two segments
        // before `/pull/`, so the merge-settings fetch still targets the right repo.
        let (host, owner, name) =
            parse_pr_url_repo("https://github.com/biomejs/biome/pull/10937/files#diff-1").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "biomejs");
        assert_eq!(name, "biome");

        // Malformed / non-PR urls → Err.
        assert!(parse_pr_url_repo("https://github.com/biomejs/biome/issues/1").is_err());
        assert!(parse_pr_url_repo("https://github.com/onlyowner/pull/1").is_err());
        assert!(parse_pr_url_repo("not a url").is_err());
        // Empty string → Err (no host, no segments).
        assert!(parse_pr_url_repo("").is_err());
        // A `-`-prefixed segment (flag-injection guard) → Err.
        assert!(parse_pr_url_repo("https://github.com/-evil/repo/pull/1").is_err());
        assert!(parse_pr_url_repo("https://github.com/owner/-evil/pull/1").is_err());
    }

    #[test]
    fn split_commit_message_splits_headline_and_body() {
        // Standard: headline, blank line, then a multi-line body.
        let (h, b) = split_commit_message("Add feature\n\nBody line one\nBody line two\n");
        assert_eq!(h, "Add feature");
        assert_eq!(b, "Body line one\nBody line two");

        // No blank line → no body (even with a wrapped second line).
        let (h, b) = split_commit_message("Headline only\ntrailing line");
        assert_eq!(h, "Headline only");
        assert_eq!(b, "");

        // Single-line message → headline, empty body.
        let (h, b) = split_commit_message("Just a title");
        assert_eq!(h, "Just a title");
        assert_eq!(b, "");

        // Empty message → both empty.
        let (h, b) = split_commit_message("");
        assert_eq!(h, "");
        assert_eq!(b, "");
    }

    #[test]
    fn rest_commit_to_out_maps_fields_and_node_id() {
        let out = rest_commit_to_out(rest_commit(
            "abc123",
            "Fix bug\n\nDetailed explanation.",
            "Ada Lovelace",
            "2026-01-02T03:04:05Z",
        ));
        // sha → oid (GraphQL `oid`); node id keeps the row in the GraphQL id space.
        assert_eq!(out.oid, "abc123");
        assert_eq!(out.headline, "Fix bug");
        assert_eq!(out.message_body, "Detailed explanation.");
        assert_eq!(out.date, "2026-01-02T03:04:05Z");
        assert_eq!(out.author, "Ada Lovelace");
    }

    #[test]
    fn rest_commit_to_out_falls_back_to_account_login_when_git_name_empty() {
        let mut c = rest_commit("def456", "Tidy up", "", "2026-01-01T00:00:00Z");
        c.author = Some(RawLogin {
            login: "octocat".to_string(),
        });
        let out = rest_commit_to_out(c);
        assert_eq!(out.author, "octocat");
        // No blank line → no body.
        assert_eq!(out.message_body, "");

        // Empty git name AND no account → empty author (defaulted, not a panic).
        let empty = rest_commit_to_out(rest_commit("ghi", "msg", "", "d"));
        assert_eq!(empty.author, "");
    }

    #[test]
    fn rest_review_to_out_maps_login_state_and_node_id() {
        let out = rest_review_to_out(GhPrRestReview {
            node_id: "PRR_node".to_string(),
            user: Some(RawLogin {
                login: "reviewer".to_string(),
            }),
            state: "CHANGES_REQUESTED".to_string(),
            body: "Please fix".to_string(),
            submitted_at: "2026-02-03T00:00:00Z".to_string(),
        });
        assert_eq!(out.author, "reviewer");
        assert_eq!(out.state, "CHANGES_REQUESTED");
        assert_eq!(out.body, "Please fix");
        assert_eq!(out.date, "2026-02-03T00:00:00Z");
        // node_id passes through to `id` (the GraphQL review node id space).
        assert_eq!(out.id, "PRR_node");
        assert!(!out.viewer_did_author);
        assert_eq!(out.review_id, "");

        // Null user → empty author, defaulted.
        let anon = rest_review_to_out(GhPrRestReview {
            node_id: "PRR_x".to_string(),
            user: None,
            state: "COMMENTED".to_string(),
            body: String::new(),
            submitted_at: String::new(),
        });
        assert_eq!(anon.author, "");
        assert_eq!(anon.id, "PRR_x");
    }

    #[test]
    fn rest_comment_to_out_maps_fields_and_viewer_authorship() {
        let make = || GhPrRestComment {
            node_id: "IC_node".to_string(),
            user: Some(RawLogin {
                login: "alice".to_string(),
            }),
            body: "A comment".to_string(),
            created_at: "2026-03-04T00:00:00Z".to_string(),
            html_url: "https://github.com/o/r/pull/1#issuecomment-1".to_string(),
        };
        let out = rest_comment_to_out(make(), Some("alice"));
        assert_eq!(out.author, "alice");
        assert_eq!(out.body, "A comment");
        assert_eq!(out.date, "2026-03-04T00:00:00Z");
        assert_eq!(out.url, "https://github.com/o/r/pull/1#issuecomment-1");
        // node_id → id (GraphQL node id space).
        assert_eq!(out.id, "IC_node");
        assert!(out.viewer_did_author);

        // A different viewer → not the author.
        assert!(!rest_comment_to_out(make(), Some("bob")).viewer_did_author);
        // Unknown viewer (probe failed) → default false.
        assert!(!rest_comment_to_out(make(), None).viewer_did_author);
        // Empty viewer login must not match an empty comment author.
        let anon = GhPrRestComment {
            node_id: "IC_x".to_string(),
            user: None,
            body: String::new(),
            created_at: String::new(),
            html_url: String::new(),
        };
        assert!(!rest_comment_to_out(anon, Some("")).viewer_did_author);
    }

    #[test]
    fn too_large_signature_matches_only_its_family() {
        assert!(is_diff_too_large(
            "GraphQL: PullRequest.diff too_large (repository.pullRequest.diff)"
        ));
        assert!(is_diff_too_large(
            "Sorry, the diff exceeded the maximum number of files (300)."
        ));
        assert!(is_diff_too_large("HTTP 406: too_large"));
        assert!(is_diff_too_large("gh: status code 406"));
        // Case-insensitive.
        assert!(is_diff_too_large("TOO_LARGE"));
        // Unrelated failures do NOT route to the fallback.
        assert!(!is_diff_too_large("HTTP 404: Not Found"));
        assert!(!is_diff_too_large("could not resolve to a PullRequest"));
        assert!(!is_diff_too_large("no pull requests found for branch"));
    }

    #[test]
    fn reconstructs_modified_file() {
        let out = reconstruct_pr_diff(&[file(
            "modified",
            "src/main.rs",
            Some("@@ -1,2 +1,2 @@\n-old\n+new"),
        )]);
        assert!(out.contains("diff --git a/src/main.rs b/src/main.rs\n"));
        assert!(out.contains("--- a/src/main.rs\n"));
        assert!(out.contains("+++ b/src/main.rs\n"));
        assert!(out.contains("@@ -1,2 +1,2 @@\n"));
        // A patch without a trailing newline gets one appended.
        assert!(out.ends_with("+new\n"));
    }

    #[test]
    fn reconstructs_added_file() {
        let out = reconstruct_pr_diff(&[file(
            "added",
            "new.txt",
            Some("@@ -0,0 +1 @@\n+hello\n"),
        )]);
        assert!(out.contains("diff --git a/new.txt b/new.txt\n"));
        assert!(out.contains("new file mode 100644\n"));
        assert!(out.contains("--- /dev/null\n"));
        assert!(out.contains("+++ b/new.txt\n"));
    }

    #[test]
    fn reconstructs_removed_file() {
        let out = reconstruct_pr_diff(&[file(
            "removed",
            "gone.txt",
            Some("@@ -1 +0,0 @@\n-bye\n"),
        )]);
        assert!(out.contains("diff --git a/gone.txt b/gone.txt\n"));
        assert!(out.contains("deleted file mode 100644\n"));
        assert!(out.contains("--- a/gone.txt\n"));
        assert!(out.contains("+++ /dev/null\n"));
    }

    #[test]
    fn reconstructs_renamed_file_using_previous_filename() {
        let mut f = file("renamed", "src/new_name.rs", Some("@@ -1 +1 @@\n-a\n+b\n"));
        f.previous_filename = Some("src/old_name.rs".to_string());
        let out = reconstruct_pr_diff(&[f]);
        assert!(out.contains("diff --git a/src/old_name.rs b/src/new_name.rs\n"));
        assert!(out.contains("rename from src/old_name.rs\n"));
        assert!(out.contains("rename to src/new_name.rs\n"));
        // The a/ side of the hunk header uses the previous filename.
        assert!(out.contains("--- a/src/old_name.rs\n"));
        assert!(out.contains("+++ b/src/new_name.rs\n"));
    }

    #[test]
    fn omitted_patch_gets_binary_placeholder() {
        // GitHub drops `patch` for binary or individually-huge files.
        let out = reconstruct_pr_diff(&[file("modified", "assets/logo.png", None)]);
        assert!(out.contains("diff --git a/assets/logo.png b/assets/logo.png\n"));
        // The frontend keys on this exact `Binary files ` marker.
        assert!(out.contains("Binary files a/assets/logo.png and b/assets/logo.png differ\n"));
        // No hunk header was synthesized for a patch-less file.
        assert!(!out.contains("@@"));
        assert!(!out.contains("--- "));
    }

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

    #[test]
    fn parse_actions_run_job_extracts_both_ids() {
        // A real GitHub Actions details URL yields both ids as strings.
        let (run, job) = parse_actions_run_job(
            "https://github.com/cli/cli/actions/runs/28872299305/job/85638045238",
        );
        assert_eq!(run.as_deref(), Some("28872299305"));
        assert_eq!(job.as_deref(), Some("85638045238"));

        // An Actions run URL with no job segment → run id only.
        let (run, job) =
            parse_actions_run_job("https://github.com/cli/cli/actions/runs/28872299305");
        assert_eq!(run.as_deref(), Some("28872299305"));
        assert_eq!(job, None);

        // Enterprise host + trailing query/fragment still parses the run id and stops
        // the job id at the first non-digit.
        let (run, job) = parse_actions_run_job(
            "https://ghe.example.com/o/r/actions/runs/12/job/34?check_suite_focus=true",
        );
        assert_eq!(run.as_deref(), Some("12"));
        assert_eq!(job.as_deref(), Some("34"));
    }

    #[test]
    fn parse_actions_run_job_ignores_non_actions_urls() {
        // External CI (Vercel/Netlify), empty, and malformed URLs → neither id.
        assert_eq!(
            parse_actions_run_job("https://vercel.com/acme/proj/deployments/abc"),
            (None, None)
        );
        assert_eq!(parse_actions_run_job(""), (None, None));
        // The marker is present but no numeric run id follows.
        assert_eq!(
            parse_actions_run_job("https://github.com/o/r/actions/runs/"),
            (None, None)
        );
    }

    #[test]
    fn map_timeline_node_classifies_typenames() {
        let node = |v: serde_json::Value| map_timeline_node(&v);

        // Force-push → before/after oids + actor + date.
        match node(serde_json::json!({
            "__typename": "HeadRefForcePushedEvent",
            "actor": {"login": "alice"},
            "createdAt": "2026-05-12T12:01:23Z",
            "beforeCommit": {"oid": "aaa"},
            "afterCommit": {"oid": "bbb"},
        })) {
            Some(PrTimelineEventOut::ForcePushed {
                before,
                after,
                actor,
                date,
            }) => {
                assert_eq!((before, after, actor), ("aaa".into(), "bbb".into(), "alice".into()));
                assert_eq!(date, "2026-05-12T12:01:23Z");
            }
            other => panic!("expected ForcePushed, got {:?}", other.is_some()),
        }

        // LABELED_EVENT → added = true; UNLABELED_EVENT → added = false.
        match node(serde_json::json!({
            "__typename": "LabeledEvent",
            "actor": {"login": "bot"},
            "createdAt": "d",
            "label": {"name": "bug", "color": "d73a4a"},
        })) {
            Some(PrTimelineEventOut::Labeled { label, color, added, .. }) => {
                assert_eq!((label, color, added), ("bug".into(), "d73a4a".into(), true));
            }
            _ => panic!("expected Labeled"),
        }
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "UnlabeledEvent",
                "actor": {"login": "bot"}, "createdAt": "d",
                "label": {"name": "bug", "color": "d73a4a"},
            })),
            Some(PrTimelineEventOut::Labeled { added: false, .. })
        ));

        // Review request: User login and Team slug both land in `reviewer`.
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "ReviewRequestedEvent", "actor": {"login": "a"}, "createdAt": "d",
                "requestedReviewer": {"__typename": "User", "login": "carol"},
            })),
            Some(PrTimelineEventOut::ReviewRequested { reviewer, .. }) if reviewer == "carol"
        ));
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "ReviewRequestedEvent", "actor": {"login": "a"}, "createdAt": "d",
                "requestedReviewer": {"__typename": "Team", "slug": "reviewers"},
            })),
            Some(PrTimelineEventOut::ReviewRequested { reviewer, .. }) if reviewer == "reviewers"
        ));
        // A null requestedReviewer (deleted entity) → empty reviewer, still classified.
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "ReviewRequestedEvent", "actor": {"login": "a"}, "createdAt": "d",
                "requestedReviewer": serde_json::Value::Null,
            })),
            Some(PrTimelineEventOut::ReviewRequested { reviewer, .. }) if reviewer.is_empty()
        ));

        // Merged with a commit oid; a ghost/null actor defaults to "".
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "MergedEvent", "actor": serde_json::Value::Null, "createdAt": "d",
                "commit": {"oid": "deadbeef"},
            })),
            Some(PrTimelineEventOut::Merged { actor, commit_oid: Some(oid), .. })
                if actor.is_empty() && oid == "deadbeef"
        ));

        // Rename carries both titles.
        assert!(matches!(
            node(serde_json::json!({
                "__typename": "RenamedTitleEvent", "actor": {"login": "a"}, "createdAt": "d",
                "previousTitle": "old", "currentTitle": "new",
            })),
            Some(PrTimelineEventOut::Renamed { previous, current, .. })
                if previous == "old" && current == "new"
        ));

        // An unrecognized/missing __typename is skipped (None), not a panic.
        assert!(node(serde_json::json!({ "__typename": "SomeOtherEvent" })).is_none());
        assert!(node(serde_json::json!({ "actor": {"login": "a"} })).is_none());
    }

    #[test]
    fn rest_pull_maps_onto_pr_info_as_open() {
        // A REST `GET /repos/{parent}/pulls?head=…&state=open` item, matching the
        // shape verified live against biomejs/biome#10965. Only the compare-panel
        // probe's fields need to survive the mapping; state is "OPEN" by construction.
        let raw: GhPrRestPull = serde_json::from_value(serde_json::json!({
            "number": 10965,
            "html_url": "https://github.com/biomejs/biome/pull/10965",
            "title": "feat: resolve globals from d.ts",
            "base": { "ref": "main" },
            "head": { "ref": "feat/resolve-globals-from-dts" },
            "draft": false,
        }))
        .expect("REST pull fixture deserializes");
        let info = rest_pull_to_pr_info(raw);
        assert_eq!(info.number, 10965);
        assert_eq!(info.url, "https://github.com/biomejs/biome/pull/10965");
        assert_eq!(info.title, "feat: resolve globals from d.ts");
        assert_eq!(info.base_ref_name, "main");
        assert_eq!(info.head_ref_name, "feat/resolve-globals-from-dts");
        assert!(!info.is_draft);
        // Open by construction → the same casing gh's `--json state` emits, so the
        // frontend's `pr.state === "OPEN"` checks fire identically on this path.
        assert_eq!(info.state, "OPEN");
    }

    #[test]
    fn rest_pull_tolerates_missing_optional_fields_and_draft() {
        // A draft PR with an absent title (tolerant serde: defaults to "").
        let raw: GhPrRestPull = serde_json::from_value(serde_json::json!({
            "number": 7,
            "html_url": "https://github.com/o/r/pull/7",
            "base": { "ref": "trunk" },
            "head": { "ref": "wip" },
            "draft": true,
        }))
        .expect("draft REST pull fixture deserializes");
        let info = rest_pull_to_pr_info(raw);
        assert_eq!(info.title, "");
        assert!(info.is_draft);
        assert_eq!(info.state, "OPEN");
    }

    #[test]
    fn upstream_create_rejects_labels_or_assignees() {
        let label = vec!["bug".to_string()];
        let assignee = vec!["octocat".to_string()];
        // Empty metadata is allowed on the upstream path.
        assert!(reject_upstream_create_metadata(&[], &[]).is_ok());
        // A non-empty label OR assignee list is rejected (pre-mutation, no push).
        for (labels, assignees) in [
            (label.as_slice(), [].as_slice()),
            ([].as_slice(), assignee.as_slice()),
            (label.as_slice(), assignee.as_slice()),
        ] {
            let err = reject_upstream_create_metadata(labels, assignees).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "expected InvalidArgument, got {err:?}"
            );
        }
    }

    #[test]
    fn upstream_pulls_endpoint_encodes_hostile_refnames() {
        // Plain refname: nothing to escape but the reserved `:` separator stays literal.
        assert_eq!(
            upstream_pulls_endpoint("biomejs/biome", "PhoenixMputu", "feat/x"),
            "repos/biomejs/biome/pulls?head=PhoenixMputu:feat%2Fx&state=open",
        );
        // A legal refname carrying `&` can't inject a second query parameter — the
        // `&` is encoded, so `state=all` lands inside the head VALUE, not as a param.
        let ep = upstream_pulls_endpoint("o/r", "me", "feat&state=all");
        assert_eq!(ep, "repos/o/r/pulls?head=me:feat%26state%3Dall&state=open");
        // Exactly one `&` (the real separator) and one `state=` (the real filter).
        assert_eq!(ep.matches('&').count(), 1);
        assert_eq!(ep.matches("state=").count(), 1);
        // `%` and space are escaped too (no half-open percent-escape, no raw space).
        assert_eq!(
            upstream_pulls_endpoint("o/r", "me", "a b%c"),
            "repos/o/r/pulls?head=me:a%20b%25c&state=open",
        );
        // A hostile FORK OWNER is encoded the same way (defense in depth, though a
        // real login is alphanumeric).
        assert_eq!(
            upstream_pulls_endpoint("o/r", "ev&il", "b"),
            "repos/o/r/pulls?head=ev%26il:b&state=open",
        );
    }

    #[test]
    fn scrape_pr_ref_reads_the_last_url_line() {
        // gh prints the new PR's URL as the last stdout line.
        let (number, url) =
            scrape_pr_ref("Warning: something\nhttps://github.com/o/r/pull/42\n");
        assert_eq!(number, 42);
        assert_eq!(url, "https://github.com/o/r/pull/42");
        // No URL line → number 0, empty url (create still returns Ok elsewhere).
        assert_eq!(scrape_pr_ref("no url here"), (0, String::new()));
    }
}
