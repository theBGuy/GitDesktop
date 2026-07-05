//! The GitLab [`Forge`](super::Forge) implementation, via the `glab` CLI.
//!
//! Every operation maps GitLab's JSON onto the SAME neutral models the GitHub
//! panels already render (`PrInfo`, `IssueDetails`, `WorkflowRun`, `ReleaseInfo`,
//! …), so the frontend stays provider-agnostic. Reads cover MRs, issues, CI
//! pipelines, and releases; writes land per-action behind `Implemented` flags
//! (comment, close/reopen, approve, merge, labels, assignees, create, pipeline
//! retry/cancel/run, release management). Which features are wired up is declared
//! in `model.rs::Implemented::for_provider` — flip flags there as impls land.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::forge::glab::{run_glab, run_glab_raw, GLAB_NETWORK_TIMEOUT, GLAB_TIMEOUT};
use crate::forge::model::{
    Capabilities, ForgeRepo, ForgeRepoList, ForgeStatus, Implemented, Provider,
};
use crate::forge::Forge;
use crate::github::actions::{RunDetail, RunJob, WorkflowRun};
use crate::github::issue::{IssueDetails, IssueInfo, IssueReactions, Milestone, Reaction};
use crate::github::pr::{
    ApprovalState, ExternalReviewItem, PrAuthor, PrCommitOut, PrDetails, PrFileOut, PrInfo,
    PrListLabel, PrPollInfo, PrRef, PrThreadOut, RepoLabel, ReviewThreadOut,
};
use crate::state::AppState;
use crate::github::release::{ReleaseAsset, ReleaseDetails, ReleaseInfo};

/// GitLab via the `glab` CLI. Carries the repo's host (gitlab.com today; a
/// self-managed host list arrives with the Settings → Accounts work).
pub struct GitLabForge {
    host: String,
}

impl GitLabForge {
    pub fn new(host: String) -> Self {
        Self { host }
    }
}

/// Assemble the neutral status from the `glab` probes. Pure (testable). `repo` is
/// the project path derived from the origin remote, which flips the integration
/// *ready* once `glab` is installed and signed in — merge-request reads are wired
/// up, so it's safe for a GitLab repo to be ready (unbuilt panels degrade to
/// "coming soon" via the `implemented` flags).
fn gitlab_status(
    installed: bool,
    authenticated: bool,
    host: &str,
    repo: Option<String>,
) -> ForgeStatus {
    ForgeStatus {
        provider: Some(Provider::GitLab),
        installed,
        authenticated,
        repo,
        host: Some(host.to_string()),
        login: None,
        capabilities: Capabilities::for_provider(Provider::GitLab),
        implemented: Implemented::for_provider(Provider::GitLab),
    }
}

impl Forge for GitLabForge {
    async fn status(&self, repo_path: &str) -> AppResult<ForgeStatus> {
        // glab present on PATH?
        match run_glab_raw(None, &["--version"], GLAB_TIMEOUT).await {
            Err(AppError::GlabNotFound) => {
                return Ok(gitlab_status(false, false, &self.host, None));
            }
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        // `glab auth status` exits 0 only when signed in on the repo's host;
        // run it in the repo so glab resolves the right (self-managed) host.
        let authenticated = run_glab_raw(Some(repo_path), &["auth", "status"], GLAB_TIMEOUT)
            .await
            .map(|o| o.code == 0)
            .unwrap_or(false);
        // The project's path (group/name), derived from the origin remote — this is
        // both how we address the glab API and what flips the integration ready.
        let repo = project_path(repo_path).await.ok();
        Ok(gitlab_status(true, authenticated, &self.host, repo))
    }
}

// ── Repository listing (clone browser) ───────────────────────────────────────

#[derive(Deserialize)]
struct GlabUser {
    username: String,
}

#[derive(Deserialize)]
struct GlabNamespace {
    full_path: String,
}

/// A GitLab project as `glab api projects` returns it (field shape validated live
/// against gitlab.com). Only the fields the clone browser needs are deserialized.
#[derive(Deserialize)]
struct GlabProject {
    name: String,
    path_with_namespace: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    archived: bool,
    http_url_to_repo: String,
    ssh_url_to_repo: String,
    #[serde(default)]
    last_activity_at: Option<String>,
    namespace: GlabNamespace,
    #[serde(default)]
    forked_from_project: Option<serde_json::Value>,
}

fn from_glab_project(p: GlabProject) -> ForgeRepo {
    ForgeRepo {
        full_name: p.path_with_namespace,
        owner: p.namespace.full_path,
        name: p.name,
        // GitLab visibility is public | internal | private; anything but public
        // shows the lock.
        private: p.visibility != "public",
        archived: p.archived,
        fork: p.forked_from_project.is_some(),
        clone_url: p.http_url_to_repo,
        ssh_url: p.ssh_url_to_repo,
        description: p.description,
        pushed_at: p.last_activity_at,
    }
}

/// The signed-in GitLab user's projects, for the clone browser. Uses the `glab
/// api` REST escape hatch (validated live — mirrors `gh api`); `membership=true`
/// = projects the user belongs to. Caps at 100 for now (`--paginate` for >100 is
/// a follow-up — its multi-page output format needs its own validation);
/// ordering by activity means the cap drops the least-recently-active projects
/// rather than an arbitrary 100.
pub async fn list_repos() -> AppResult<ForgeRepoList> {
    let viewer = run_glab(None, &["api", "user"], GLAB_TIMEOUT)
        .await
        .ok()
        .and_then(|o| serde_json::from_str::<GlabUser>(&o.stdout_lossy()).ok())
        .map(|u| u.username)
        .unwrap_or_default();
    let out = run_glab(
        None,
        &["api", "projects?membership=true&order_by=last_activity_at&per_page=100"],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let projects: Vec<GlabProject> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse your GitLab projects: {e}")))?;
    Ok(ForgeRepoList {
        viewer,
        repos: projects.into_iter().map(from_glab_project).collect(),
    })
}

/// The `git -c credential.https://<host>.helper=…` entry that lets `git clone` of
/// a private GitLab repo authenticate via glab's token — glab's token isn't in
/// git's credential store, so plain `git clone` (and even `glab repo clone`) 401s.
/// One-shot (per `git` invocation), so nothing is written to git config and no
/// token lands in the remote URL. Validated live against a private gitlab.com repo.
pub async fn clone_credential_config(clone_url: &str) -> AppResult<Vec<String>> {
    let glab = crate::agent::resolve_named(&["glab"], None)
        .await
        .ok_or(AppError::GlabNotFound)?;
    let host = crate::forge::remote_host(clone_url).unwrap_or_else(|| "gitlab.com".to_string());
    Ok(vec![format!(
        "credential.https://{host}.helper=!\"{}\" auth git-credential",
        glab.display()
    )])
}

// ── Merge requests (read) ─────────────────────────────────────────────────────
//
// GitLab merge requests map onto the same neutral `PrInfo`/`PrDetails` the GitHub
// panels already render, so the frontend stays provider-agnostic. We go through
// the `glab api` REST escape hatch addressing the project by its URL-encoded full
// path (which GitLab accepts in place of a numeric id), derived from the origin
// remote — the same path `status` reports as `repo`.

/// URL-encode a project's full path for use as a `glab api` project id. Only `/`
/// needs escaping for the paths GitLab allows (letters/digits/`_`/`-`/`.`).
fn encode_project(path: &str) -> String {
    path.replace('/', "%2F")
}

/// Percent-encode a value for safe use inside a `glab api` query string — `glab`
/// forwards the endpoint verbatim (it only encodes the path, not query values), so
/// a query-significant byte must be encoded or it corrupts the query. Shared with
/// the Bitbucket provider, hence it lives in the parent `forge` module.
use crate::forge::encode_query_value;

/// The project's full path (`group/name`) from the repo's origin remote.
async fn project_path(repo_path: &str) -> AppResult<String> {
    let url = crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await?;
    crate::forge::remote_path(&url).ok_or_else(|| {
        AppError::Glab("could not determine the GitLab project from the origin remote".into())
    })
}

/// Map GitLab's MR state onto the neutral `"OPEN"/"CLOSED"/"MERGED"` the frontend
/// expects (it treats `locked` like closed).
fn map_mr_state(state: &str) -> String {
    match state {
        "opened" => "OPEN".to_string(),
        "merged" => "MERGED".to_string(),
        "closed" | "locked" => "CLOSED".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

/// Deserialize a field the provider may send as JSON `null` rather than omitting,
/// treating a present `null` as the type's default. Paired with `#[serde(default)]`
/// (which only fills a *missing* key) this absorbs both — the exact trap that sank a
/// whole issue parse when GitLab returned `discussion_locked: null` instead of
/// `false`. Applied to the optional scalars and the collections GitLab could null
/// out (it returns `[]` today, but the same one-quirk-away fragility bit us once).
pub(crate) fn null_to_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// A GitLab user as embedded in MR/note payloads.
#[derive(Deserialize)]
struct GlabMrUser {
    username: String,
}

/// A merge request as `glab api …/merge_requests` returns it (list shape).
#[derive(Deserialize)]
struct GlabMr {
    iid: u64,
    web_url: String,
    title: String,
    target_branch: String,
    source_branch: String,
    #[serde(default)]
    draft: bool,
    state: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    labels: Vec<String>,
}

fn from_glab_mr(m: GlabMr) -> PrInfo {
    PrInfo {
        number: m.iid,
        url: m.web_url,
        title: m.title,
        base_ref_name: m.target_branch,
        head_ref_name: m.source_branch,
        is_draft: m.draft,
        state: map_mr_state(&m.state),
        author: m.author.map(|a| PrAuthor { login: a.username }),
        labels: m
            .labels
            .into_iter()
            .map(|name| PrListLabel { name })
            .collect(),
    }
}

/// The signed-in user's merge requests for this repo. `state` is `"open"` or
/// `"closed"`; the Closed tab shows closed **and** merged (matching the GitHub
/// panel). GitLab splits those into separate server states, so we fetch each on
/// its own `per_page` budget and concatenate — never one `state=all` page where
/// open MRs would dilute (and silently truncate) the closed/merged ones.
pub async fn list_prs(repo_path: &str, state: &str) -> AppResult<Vec<PrInfo>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let states: &[&str] = match state {
        "open" => &["opened"],
        "closed" => &["closed", "merged"],
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown PR state filter: {other}"
            )));
        }
    };
    let mut prs = Vec::new();
    for s in states {
        let endpoint = format!("projects/{enc}/merge_requests?state={s}&per_page=100");
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let mrs: Vec<GlabMr> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse GitLab merge requests: {e}")))?;
        prs.extend(mrs.into_iter().map(from_glab_mr));
    }
    Ok(prs)
}

/// Open MRs whose source branch is `head` — the ComparePanel duplicate probe,
/// mirroring `gh_prs_for_branch` (lets the UI offer "View merge request" instead
/// of "Create" once one already exists). The branch lands in a query VALUE, which
/// glab does not URL-encode — encode it here so a `/`- or `&`-bearing branch name
/// can't split the query into silently-unfiltered results.
pub async fn prs_for_branch(repo_path: &str, head: &str) -> AppResult<Vec<PrInfo>> {
    if head.is_empty() || head.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid branch: {head}")));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!(
        "projects/{enc}/merge_requests?source_branch={}&state=opened&per_page=100",
        encode_query_value(head)
    );
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let mrs: Vec<GlabMr> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab merge requests: {e}")))?;
    Ok(mrs.into_iter().map(from_glab_mr).collect())
}

/// Map a GitLab MR's list state onto the neutral poll state the notification poller
/// expects. Unlike [`map_mr_state`], `locked` here maps to `OPEN`: on the poll surface
/// a locked MR is a transient mid-merge state (still an open PR), and mapping it closed
/// would fire a spurious "closed" notification each time GitLab locks the MR to merge it.
fn map_mr_poll_state(state: &str) -> String {
    match state {
        "opened" | "locked" => "OPEN".to_string(),
        "merged" => "MERGED".to_string(),
        "closed" => "CLOSED".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

/// A merge request as the poll endpoint returns it. `sha` is the FULL 40-char head
/// commit; the list carries no pipeline/approval state (v1 poll limitation).
#[derive(Deserialize)]
struct GlabPollMr {
    iid: u64,
    web_url: String,
    title: String,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    sha: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
}

fn from_glab_poll_mr(m: GlabPollMr) -> PrPollInfo {
    PrPollInfo {
        number: m.iid,
        title: m.title,
        url: m.web_url,
        state: map_mr_poll_state(&m.state),
        is_draft: m.draft,
        author: m.author.map(|a| a.username).unwrap_or_default(),
        // The list response carries neither an approval decision nor a pipeline
        // rollup, so both stay empty — the notification poller's checks/review
        // branches simply never fire for GitLab (a documented v1 limit).
        review_decision: String::new(),
        checks_state: String::new(),
        head_sha: m.sha,
    }
}

/// A lightweight snapshot of the repo's recently-updated MRs for the notification
/// poller — the GitLab analogue of `gh_pr_poll`. One `glab api` call ordered by
/// `updated_at` desc; `head_sha` (the full MR head OID) drives pr-sync re-review.
pub async fn poll_prs(repo_path: &str) -> AppResult<Vec<PrPollInfo>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint =
        format!("projects/{enc}/merge_requests?state=all&order_by=updated_at&per_page=20");
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let mrs: Vec<GlabPollMr> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab MR poll: {e}")))?;
    Ok(mrs.into_iter().map(from_glab_poll_mr).collect())
}

/// One changed file as the MR `/changes` endpoint returns it.
#[derive(Deserialize)]
struct GlabChange {
    #[serde(default)]
    old_path: String,
    #[serde(default)]
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    deleted_file: bool,
    /// The per-file hunks (no `diff --git`/`---`/`+++` header — we add those).
    #[serde(default)]
    diff: String,
}

/// The MR `/changes` response: the MR's core fields plus its changed files.
#[derive(Deserialize)]
struct GlabMrChanges {
    iid: u64,
    web_url: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    target_branch: String,
    source_branch: String,
    #[serde(default)]
    draft: bool,
    state: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    assignees: Vec<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    labels: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    changes: Vec<GlabChange>,
}

/// Count added/deleted lines in a GitLab per-file diff. The input is hunk-only
/// (no `---`/`+++` file headers — `reconstruct_file_diff` adds those), so a
/// leading `+`/`-` is always real content; `@@` hunk headers start with `@`.
/// (Don't skip `+++`/`---`-prefixed lines: that would drop genuine content whose
/// text begins with `++`/`--`, e.g. a deleted `---` YAML separator.)
fn count_diff_lines(diff: &str) -> (u32, u32) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// Rebuild a standard `git`-format file diff from a GitLab change, so the frontend
/// splitter (which keys on `diff --git`/`+++ b/<path>`) parses it like `gh pr diff`.
fn reconstruct_file_diff(c: &GlabChange) -> String {
    let old = if c.old_path.is_empty() {
        &c.new_path
    } else {
        &c.old_path
    };
    let new = if c.new_path.is_empty() {
        &c.old_path
    } else {
        &c.new_path
    };
    let minus = if c.new_file {
        "/dev/null".to_string()
    } else {
        format!("a/{old}")
    };
    let plus = if c.deleted_file {
        "/dev/null".to_string()
    } else {
        format!("b/{new}")
    };
    let mut s = format!("diff --git a/{old} b/{new}\n--- {minus}\n+++ {plus}\n");
    s.push_str(&c.diff);
    if !c.diff.ends_with('\n') {
        s.push('\n');
    }
    s
}

#[derive(Deserialize)]
struct GlabCommit {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct GlabNote {
    id: u64,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default)]
    created_at: String,
    /// The diff-anchor `position` object, present only on inline (diff) notes. We
    /// use its presence to keep diff-anchored notes OUT of the flat conversation
    /// list — they now surface as `review_threads` with real file/line context,
    /// instead of leaking bodies context-free into `PrDetails.comments`.
    #[serde(default)]
    position: Option<GlabNotePosition>,
}

#[derive(Deserialize)]
struct GlabLabel {
    name: String,
    #[serde(default)]
    color: String,
}

/// A name→hex-color map of the project's labels (color without the leading `#`,
/// as the frontend's `RepoLabel` expects). Best-effort: empty on any failure.
async fn project_label_colors(repo_path: &str, enc: &str) -> HashMap<String, String> {
    run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/labels?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabLabel>>(&o.stdout_lossy()).ok())
    .map(|labels| {
        labels
            .into_iter()
            .map(|l| (l.name, l.color.trim_start_matches('#').to_string()))
            .collect()
    })
    .unwrap_or_default()
}

/// Full read view of one merge request — core fields + files, commits, and
/// comments, mapped onto `PrDetails`. Reviews and CI checks are left empty for now
/// (GitLab approvals/pipelines arrive with later increments).
pub async fn view_pr(repo_path: &str, number: u64) -> AppResult<PrDetails> {
    let enc = encode_project(&project_path(repo_path).await?);

    // Core fields + changed files in one call.
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/changes")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let mr: GlabMrChanges = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab merge request: {e}")))?;

    let mut additions = 0;
    let mut deletions = 0;
    let files: Vec<PrFileOut> = mr
        .changes
        .iter()
        .map(|c| {
            let (a, d) = count_diff_lines(&c.diff);
            additions += a;
            deletions += d;
            PrFileOut {
                path: if c.new_path.is_empty() {
                    c.old_path.clone()
                } else {
                    c.new_path.clone()
                },
                additions: a,
                deletions: d,
            }
        })
        .collect();

    // Commits — GitLab returns newest-first; the frontend treats the last as head,
    // so reverse to oldest-first (matching gh's GraphQL order).
    let mut commits: Vec<PrCommitOut> = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/commits?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabCommit>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .map(|c| PrCommitOut {
        oid: c.id,
        headline: c.title,
        date: c.created_at,
        author: c.author_name,
    })
    .collect();
    commits.reverse();

    // Comments — drop GitLab's system notes (auto "added a commit", etc.) AND
    // diff-anchored (positioned) notes, which now surface as `review_threads` with
    // real file/line context instead of leaking into the flat conversation list.
    let comments: Vec<PrThreadOut> = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/notes?sort=asc&per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .filter(|n| !n.system && n.position.is_none())
    .map(|n| PrThreadOut {
        author: n.author.map(|a| a.username).unwrap_or_default(),
        state: String::new(),
        body: n.body,
        date: n.created_at,
        id: n.id.to_string(),
        url: String::new(),
        viewer_did_author: false,
        is_minimized: false,
        minimized_reason: String::new(),
    })
    .collect();

    let colors = project_label_colors(repo_path, &enc).await;
    let labels: Vec<RepoLabel> = mr
        .labels
        .into_iter()
        .map(|name| {
            let color = colors.get(&name).cloned().unwrap_or_default();
            RepoLabel {
                id: String::new(),
                name,
                color,
            }
        })
        .collect();

    Ok(PrDetails {
        // No GraphQL node id on GitLab; the GitLab mutations key on the iid (labels
        // by name, assignees by resolved numeric id), so an empty id is fine.
        id: String::new(),
        number: mr.iid,
        title: mr.title,
        body: mr.description.unwrap_or_default(),
        author: mr.author.map(|a| a.username).unwrap_or_default(),
        state: map_mr_state(&mr.state),
        is_draft: mr.draft,
        base_ref_name: mr.target_branch,
        head_ref_name: mr.source_branch,
        additions,
        deletions,
        url: mr.web_url,
        commits,
        files,
        reviews: Vec::new(),
        comments,
        checks: Vec::new(),
        labels,
        assignees: mr.assignees.into_iter().map(|a| a.username).collect(),
        // The GitLab reviewer list isn't wired into the picker yet (mr_reviewers
        // stays false) — assignees are GitLab's control here.
        reviewers: Vec::new(),
    })
}

/// The unified diff for one merge request, rebuilt from `/changes` into the same
/// `git`-style format `gh pr diff` produces so the frontend diff viewer parses it.
pub async fn diff_pr(repo_path: &str, number: u64) -> AppResult<String> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/changes")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let mr: GlabMrChanges = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        AppError::Glab(format!("could not parse GitLab merge request changes: {e}"))
    })?;
    let mut diff = String::new();
    for c in &mr.changes {
        diff.push_str(&reconstruct_file_diff(c));
    }
    // Cap to match the GitHub path (`gh_pr_diff`), so a pathologically large MR
    // can't blow up the diff viewer.
    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, 2_000_000);
    Ok(text)
}

// ── Merge requests (write) ────────────────────────────────────────────────────
//
// Comment (note), close/reopen, title/body edit, approve/unapprove, and merge —
// mirroring the gh_pr_* commands and dispatching through forge_pr_*. (Full reviews
// stay GitHub-only.) Same glab `-f` raw-field + `state_event` shape as the issue
// writes (validated live against the demo). Unlike issue close, MR close has no
// reason on either platform.

/// Post a comment (note) on a merge request.
pub async fn comment_mr(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/notes");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Close or reopen a merge request via the `state_event` field (`close` / `reopen`).
async fn set_mr_state(repo_path: &str, number: u64, event: &str) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    let state_arg = format!("state_event={event}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &state_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

pub async fn close_mr(repo_path: &str, number: u64) -> AppResult<()> {
    set_mr_state(repo_path, number, "close").await
}

pub async fn reopen_mr(repo_path: &str, number: u64) -> AppResult<()> {
    set_mr_state(repo_path, number, "reopen").await
}

/// Edit a merge request's title/description. Mirrors `gh_pr_edit` (empty-title
/// guard; an empty body clears the description). Validated live: `-f` keeps
/// multi-line/comma/`=`/`@`/leading-`-` values intact.
pub async fn edit_mr(repo_path: &str, number: u64, title: &str, body: &str) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument(
            "a merge request title is required".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    let title_arg = format!("title={title}");
    let desc_arg = format!("description={body}");
    run_glab(
        Some(repo_path),
        &[
            "api", "--method", "PUT", &endpoint, "-f", &title_arg, "-f", &desc_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Merge requests (approvals & reviewer states) ──────────────────────────────
//
// GitLab's approve/unapprove is a bodyless toggle with no GitHub analogue (GitHub
// approves through the review flow), so it surfaces as a GitLab-only control gated
// on `implemented.mr_approve`. The approvals read drives the toggle. `user_can_approve`
// is deliberately dropped from the neutral shape: GitLab reports it `false` on the
// Free tier even when approving succeeds (it's a Premium approval-rules signal), so
// the toggle keys on `user_has_approved` instead and a real permission error surfaces
// via the action's toast. Validated live against the demo (approve adds the viewer to
// `approved_by`; unapprove reverts it).
//
// Request-changes (the blocking reviewer state, `implemented.mr_request_changes`)
// rides the same read: the reviewers endpoint carries a per-reviewer `state`
// (`unreviewed` / `requested_changes` / `approved` — validated live on Free). The
// WRITE is GraphQL-only (`mergeRequestRequestChanges`, works on Free) and requires
// the viewer to BE a reviewer first; approving clears the state (validated), while
// the direct undo mutation is Premium-only ("Invalid license" on Free).

/// One entry of a GitLab MR's `approved_by` list.
#[derive(Deserialize)]
struct GlabApprovedBy {
    #[serde(default)]
    user: Option<GlabMrUser>,
}

/// The MR `/approvals` response (the fields we map onto `ApprovalState`).
#[derive(Deserialize)]
struct GlabApprovals {
    #[serde(default)]
    user_has_approved: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    approved_by: Vec<GlabApprovedBy>,
    #[serde(default)]
    approvals_required: u32,
    #[serde(default)]
    approvals_left: u32,
}

/// A reviewer's user object as the reviewers endpoint nests it (full user payload;
/// we keep the numeric id — needed to preserve existing reviewers on a PUT — and
/// the username).
#[derive(Deserialize)]
struct GlabReviewerUser {
    id: u64,
    username: String,
}

/// One entry of `GET …/merge_requests/<n>/reviewers`.
#[derive(Deserialize)]
struct GlabReviewer {
    #[serde(default)]
    user: Option<GlabReviewerUser>,
    /// `unreviewed` / `requested_changes` / `approved` (validated live).
    #[serde(default)]
    state: String,
}

/// The MR's reviewers with their review states.
async fn mr_reviewers(repo_path: &str, enc: &str, number: u64) -> AppResult<Vec<GlabReviewer>> {
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/reviewers")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab reviewers: {e}")))
}

/// The signed-in user's id + username (`glab api user`).
async fn current_user(repo_path: &str) -> AppResult<GlabReviewerUser> {
    let out = run_glab(Some(repo_path), &["api", "user"], GLAB_NETWORK_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab user: {e}")))
}

/// The viewer's + the MR's approval state, mapped onto the neutral `ApprovalState`.
/// Also folds in the viewer's requested-changes reviewer state — all three reads
/// must succeed (a wrong-but-confident review state is worse than a disabled
/// control, so no best-effort fallbacks here).
pub async fn pr_approvals(repo_path: &str, number: u64) -> AppResult<ApprovalState> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}/approvals")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let a: GlabApprovals = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab approvals: {e}")))?;
    let me = current_user(repo_path).await?;
    let viewer_requested_changes = mr_reviewers(repo_path, &enc, number)
        .await?
        .into_iter()
        .any(|r| {
            r.state == "requested_changes"
                && r.user.map(|u| u.username == me.username).unwrap_or(false)
        });
    Ok(ApprovalState {
        viewer_has_approved: a.user_has_approved,
        approved_by: a
            .approved_by
            .into_iter()
            .filter_map(|x| x.user.map(|u| u.username))
            .collect(),
        approvals_required: a.approvals_required,
        approvals_left: a.approvals_left,
        viewer_requested_changes,
    })
}

/// Approve a merge request as the signed-in user (bodyless POST).
pub async fn approve_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/approve");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Revoke the signed-in user's approval of a merge request.
pub async fn unapprove_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/unapprove");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The GraphQL envelope for `mergeRequestRequestChanges` — mutation-level errors
/// come back inside `data`, query/auth-level errors at the top level.
#[derive(Deserialize)]
struct GlabGqlRequestChangesEnvelope {
    #[serde(default)]
    data: Option<GlabGqlRequestChangesData>,
    #[serde(default, deserialize_with = "null_to_default")]
    errors: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct GlabGqlRequestChangesData {
    #[serde(rename = "mergeRequestRequestChanges")]
    request_changes: Option<GlabGqlRequestChangesErrors>,
}

#[derive(Deserialize)]
struct GlabGqlRequestChangesErrors {
    #[serde(default, deserialize_with = "null_to_default")]
    errors: Vec<String>,
}

/// Replace the MR's reviewers with `ids` (`0` clears — the assignees CSV shape).
async fn set_mr_reviewer_ids(repo_path: &str, enc: &str, number: u64, ids: &[u64]) -> AppResult<()> {
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    let ids_arg = format!(
        "reviewer_ids={}",
        if ids.is_empty() {
            "0".to_string()
        } else {
            ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",")
        }
    );
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &ids_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Request changes on a merge request (the blocking reviewer state), with an
/// optional comment. All forms validated live on the Free-tier demo:
/// - The GraphQL mutation `mergeRequestRequestChanges` works on Free but requires
///   the viewer to BE a reviewer ("Reviewer not found") — so we add them first
///   when needed, keeping the existing reviewers ahead of the viewer in the PUT.
///   Free allows a single reviewer and keeps only the FIRST id, so that order
///   never displaces an existing reviewer — we re-read and error honestly when
///   the viewer didn't stick, rather than silently bumping someone.
/// - Approving clears the state; the direct undo mutation is Premium-only.
pub async fn request_changes_mr(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    let path = project_path(repo_path).await?;
    // The path is embedded in a quoted GraphQL string; GitLab paths can't contain
    // quotes/backslashes, so reject rather than escape if one ever shows up.
    if path.contains('"') || path.contains('\\') {
        return Err(AppError::InvalidArgument(format!(
            "unexpected characters in project path: {path}"
        )));
    }
    let enc = encode_project(&path);

    // Make the viewer a reviewer if they aren't one yet (existing reviewers first).
    let me = current_user(repo_path).await?;
    let reviewers = mr_reviewers(repo_path, &enc, number).await?;
    let existing_ids: Vec<u64> = reviewers
        .iter()
        .filter_map(|r| r.user.as_ref().map(|u| u.id))
        .collect();
    let added_viewer = !existing_ids.contains(&me.id);
    if added_viewer {
        let mut ids = existing_ids.clone();
        ids.push(me.id);
        set_mr_reviewer_ids(repo_path, &enc, number, &ids).await?;
        let now = mr_reviewers(repo_path, &enc, number).await?;
        let now_ids: Vec<u64> = now
            .iter()
            .filter_map(|r| r.user.as_ref().map(|u| u.id))
            .collect();
        if !now_ids.contains(&me.id) {
            // Single-reviewer tier: the PUT kept only the FIRST id. With one
            // pre-existing reviewer nothing changed (ours was appended last);
            // with several (multi-reviewer data retained across a tier
            // downgrade) that same PUT just dropped the rest — attempt a
            // restore and DISCLOSE the drop rather than report a clean no-op
            // (the restore runs through the same keep-first filter, so
            // verification on GitLab is the honest ask).
            let lost: Vec<String> = reviewers
                .iter()
                .filter_map(|r| r.user.as_ref())
                .filter(|u| !now_ids.contains(&u.id))
                .map(|u| u.username.clone())
                .collect();
            if !lost.is_empty() {
                let _ = set_mr_reviewer_ids(repo_path, &enc, number, &existing_ids).await;
                return Err(AppError::Glab(format!(
                    "Couldn't add you as a reviewer (this GitLab tier allows one \
                     reviewer), and GitLab may have dropped reviewer(s) {} in the \
                     attempt — please verify the reviewers on GitLab.",
                    lost.join(", ")
                )));
            }
            return Err(AppError::Glab(
                "Couldn't add you as a reviewer (this GitLab tier allows one \
                 reviewer, and the merge request already has one) — request \
                 changes on GitLab instead."
                    .into(),
            ));
        }
    }

    // The mutation itself. On failure, best-effort restore the reviewer list we
    // changed above so a failed action doesn't leave the viewer as a reviewer.
    let query = format!(
        "mutation {{ mergeRequestRequestChanges(input: {{ projectPath: \"{path}\", iid: \"{number}\" }}) {{ errors }} }}"
    );
    let query_arg = format!("query={query}");
    let result = run_glab(
        Some(repo_path),
        &["api", "graphql", "-f", &query_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await;
    let mutation_result = result.and_then(|out| {
        let env: GlabGqlRequestChangesEnvelope = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse the GitLab response: {e}")))?;
        if !env.errors.is_empty() {
            let msgs: Vec<String> = env
                .errors
                .iter()
                .map(|e| {
                    e.get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown GraphQL error")
                        .to_string()
                })
                .collect();
            return Err(AppError::Glab(msgs.join("; ")));
        }
        // With no top-level errors a compliant response always carries the
        // mutation payload — a missing/null one is an unexpected shape, not a
        // success (wrong-but-confident is worse than an error here).
        let payload = env.data.and_then(|d| d.request_changes).ok_or_else(|| {
            AppError::Glab("unexpected GitLab response (no mutation payload)".into())
        })?;
        if !payload.errors.is_empty() {
            return Err(AppError::Glab(payload.errors.join("; ")));
        }
        Ok(())
    });
    if let Err(e) = mutation_result {
        if added_viewer {
            let _ = set_mr_reviewer_ids(repo_path, &enc, number, &existing_ids).await;
        }
        return Err(e);
    }

    // The optional review comment rides as a plain note. The state change above
    // already stood, so a note failure must say so rather than read as a no-op.
    if !body.trim().is_empty() {
        if let Err(e) = comment_mr(repo_path, number, body).await {
            return Err(AppError::Glab(format!(
                "Changes were requested, but posting the comment failed: {e}"
            )));
        }
    }
    Ok(())
}

// ── Merge requests (merge) ────────────────────────────────────────────────────
//
// MR merge — a SHARED control with GitHub's `gh pr merge`. GitLab's merge endpoint
// controls `squash` (the one genuine per-MR knob) + `should_remove_source_branch`; the
// merge-commit-vs-fast-forward shape is the PROJECT's `merge_method` setting, NOT a
// per-MR choice. So we offer only `merge` (squash=false) and `squash` (squash=true) and
// reject `rebase` (GitLab has no per-MR rebase-merge — that's the project setting plus a
// separate async endpoint, deliberately out of scope). The optional `sha` guards against
// merging a head the user never saw (GitLab 409s if it moved). Validated live against the
// demo: squash+delete+sha happy path, sha-mismatch 409, and 405 on an unmergeable MR — all
// exit non-zero carrying a message, so they surface via the existing toast.

/// Merge a merge request. `strategy` is `merge` (merge commit) or `squash`; `rebase` is
/// rejected (GitLab merges via the project's configured method). `sha`, when non-empty,
/// must match the source branch HEAD or GitLab refuses — a stale-view safety guard.
pub async fn merge_mr(
    repo_path: &str,
    number: u64,
    strategy: &str,
    delete_branch: bool,
    sha: Option<&str>,
) -> AppResult<()> {
    merge_mr_inner(repo_path, number, strategy, delete_branch, sha, false).await
}

/// The shared body behind `merge_mr` and `auto_merge_mr` — same endpoint, same
/// strategy validation, same `sha` guard. The only difference is the extra
/// `merge_when_pipeline_succeeds` flag, so both wrappers can't drift apart.
async fn merge_mr_inner(
    repo_path: &str,
    number: u64,
    strategy: &str,
    delete_branch: bool,
    sha: Option<&str>,
    when_pipeline_succeeds: bool,
) -> AppResult<()> {
    let squash = match strategy {
        "merge" => false,
        "squash" => true,
        other => {
            return Err(AppError::InvalidArgument(format!(
                "GitLab merges via the project's configured method; '{other}' isn't a per-MR option"
            )));
        }
    };
    let enc = encode_project(&project_path(repo_path).await?);
    // GitLab's merge-time `squash` / `should_remove_source_branch` params can set
    // but not clear the MR's persisted `squash` / `remove_source_branch` attributes
    // (validated live; which the deferred merge consults is inconsistent) — set the
    // attributes first so the chosen strategy always governs (an MR the author
    // flagged "squash on accept" or born under the project's delete-source default
    // would otherwise ignore the user's choice). This is a pre-mutation guard: if
    // the attribute update fails we must NOT fall through to the irreversible merge.
    // (A project with a locked squash policy — squash_option always/never — may
    // reject this PUT; that surfaces as a loud toast before any merge, which is the
    // honest failure mode. Note the attribute name is `remove_source_branch`, not
    // the merge endpoint's `should_remove_source_branch`.)
    let mr_endpoint = format!("projects/{enc}/merge_requests/{number}");
    let attr_squash_arg = format!("squash={squash}");
    let attr_remove_arg = format!("remove_source_branch={delete_branch}");
    run_glab(
        Some(repo_path),
        &[
            "api",
            "--method",
            "PUT",
            &mr_endpoint,
            "-f",
            &attr_squash_arg,
            "-f",
            &attr_remove_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let endpoint = format!("projects/{enc}/merge_requests/{number}/merge");
    let squash_arg = format!("squash={squash}");
    let remove_arg = format!("should_remove_source_branch={delete_branch}");
    let mut args = vec![
        "api", "--method", "PUT", &endpoint, "-f", &squash_arg, "-f", &remove_arg,
    ];
    // Only guard on a non-empty SHA — an empty `sha=` would itself be rejected.
    let sha_arg;
    if let Some(s) = sha.filter(|s| !s.is_empty()) {
        sha_arg = format!("sha={s}");
        args.push("-f");
        args.push(&sha_arg);
    }
    if when_pipeline_succeeds {
        args.push("-f");
        args.push("merge_when_pipeline_succeeds=true");
    }
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

// ── Merge requests (auto-merge / merge-when-pipeline-succeeds) ─────────────────
//
// GitLab's "auto-merge" (MWPS) arms the merge endpoint to complete server-side
// once the head pipeline goes green — a GitLab-ONLY control (`mr_auto_merge`),
// unlike the shared `merge_mr`: GitHub has no in-app PR auto-merge here. The
// arm reuses the merge endpoint with `merge_when_pipeline_succeeds=true`; the
// read exposes the MR's armed flag + detailed merge status + head-pipeline
// summary so the UI can decide whether to offer the affordance; cancel disarms.
// All three validated live against gitlab.com (Free): arm while the pipeline is
// running → 200 with the flag set and `detailed_merge_status: ci_still_running`;
// a stale `sha` → 409 (propagates like merge); arming a finished pipeline → 405
// (a race the UI gates against). Cancel's gotcha lives on `cancel_auto_merge_mr`.

/// The head pipeline of an MR, as the slim MR GET embeds it (present only when
/// the MR has a pipeline). Both scalars are null-tolerant — GitLab nulls fields.
#[derive(Deserialize)]
struct GlabHeadPipelineBrief {
    #[serde(default, deserialize_with = "null_to_default")]
    status: String,
    #[serde(default, deserialize_with = "null_to_default")]
    web_url: String,
}

/// The MR fields the auto-merge read needs, from the slim `merge_requests/{iid}`
/// GET (not `/changes`). GitLab returns `null` for these scalars in some states,
/// so each is null-tolerant.
#[derive(Deserialize)]
struct GlabMrMergeState {
    #[serde(default, deserialize_with = "null_to_default")]
    merge_when_pipeline_succeeds: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    detailed_merge_status: String,
    #[serde(default)]
    head_pipeline: Option<GlabHeadPipelineBrief>,
}

/// The auto-merge state the MR panel gates its affordance on: whether auto-merge
/// is armed, GitLab's detailed merge status, and the head pipeline's status +
/// web URL (empty strings when the MR has no pipeline).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMrMergeState {
    /// MR.merge_when_pipeline_succeeds — whether auto-merge is armed.
    pub auto_merge_enabled: bool,
    /// MR.detailed_merge_status (e.g. "mergeable", "ci_still_running", "checking").
    pub detailed_merge_status: String,
    /// MR.head_pipeline.status ("running", "pending", "success", …); "" when the MR has no pipeline.
    pub pipeline_status: String,
    /// MR.head_pipeline.web_url; "" when no pipeline.
    pub pipeline_url: String,
}

/// Read the MR's auto-merge state (armed flag, detailed merge status, head
/// pipeline summary) from the slim MR GET. `head_pipeline` is null when the MR
/// has no pipeline → the pipeline fields map to empty strings.
pub async fn mr_merge_state(repo_path: &str, number: u64) -> AppResult<GitLabMrMergeState> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let mr: GlabMrMergeState = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab merge state: {e}")))?;
    let (pipeline_status, pipeline_url) = mr
        .head_pipeline
        .map(|p| (p.status, p.web_url))
        .unwrap_or_default();
    Ok(GitLabMrMergeState {
        auto_merge_enabled: mr.merge_when_pipeline_succeeds,
        detailed_merge_status: mr.detailed_merge_status,
        pipeline_status,
        pipeline_url,
    })
}

/// Arm auto-merge (merge-when-pipeline-succeeds) on a merge request — the merge
/// endpoint with the MWPS flag set. Same strategy/`sha`/delete-branch semantics
/// as `merge_mr`; a stale `sha` → 409 and a finished pipeline → 405, both
/// propagating via `run_glab` (the UI gates the affordance on a live pipeline).
pub async fn auto_merge_mr(
    repo_path: &str,
    number: u64,
    strategy: &str,
    delete_branch: bool,
    sha: Option<&str>,
) -> AppResult<()> {
    merge_mr_inner(repo_path, number, strategy, delete_branch, sha, true).await
}

/// The GitLab service-error envelope glab can return in a body WITH a zero exit
/// (`{"message":"…","status":"error","http_status":406}`) — the shape that makes
/// a cancel look successful. Leniently parsed: both fields optional.
#[derive(Deserialize)]
struct GlabServiceError {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

/// Detect GitLab's exit-0 service-error body. Returns the error message when the
/// body carries `status: "error"` (falling back to a generic message when the
/// `message` field is absent), else `None`. Any body without that marker — the
/// success shape, which is unspecified and must NOT be required to be MR-like —
/// is treated as success.
fn service_error_message(body: &str) -> Option<String> {
    let parsed: GlabServiceError = serde_json::from_str(body).ok()?;
    if parsed.status.as_deref() == Some("error") {
        Some(
            parsed
                .message
                .unwrap_or_else(|| "GitLab rejected the request".into()),
        )
    } else {
        None
    }
}

/// Cancel a merge request's armed auto-merge (disarm MWPS). CRITICAL: when there
/// is nothing to cancel, glab exits 0 and the failure lives ONLY in the response
/// body (`{"message":"Can't cancel the automatic merge","status":"error",…}`), so
/// a zero-exit body must be inspected for that error marker; a non-zero exit
/// already propagates via `run_glab`.
pub async fn cancel_auto_merge_mr(repo_path: &str, number: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint =
        format!("projects/{enc}/merge_requests/{number}/cancel_merge_when_pipeline_succeeds");
    let out = run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    if let Some(msg) = service_error_message(&out.stdout_lossy()) {
        return Err(AppError::Glab(msg));
    }
    Ok(())
}

// ── Issues (read) ─────────────────────────────────────────────────────────────
//
// GitLab issues map onto the same neutral `IssueInfo`/`IssueDetails` the GitHub
// panels render, so the frontend stays provider-agnostic. As with MRs we go
// through `glab api` addressing the project by its URL-encoded full path. The
// GitLab fields the still-unwired mutations would need (node id, lock reason,
// pinned, org issue type) are left empty rather than mislabeled — the wired
// writes (see the write section below) key on the iid, names, or global ids.

/// Map GitLab's issue state (`opened`/`closed`) onto the neutral `"OPEN"/"CLOSED"`
/// the frontend expects. (Issues, unlike MRs, never have a `merged` state.)
fn map_issue_state(state: &str) -> String {
    match state {
        "opened" => "OPEN".to_string(),
        "closed" => "CLOSED".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

/// An issue as `glab api …/issues` returns it (list shape).
#[derive(Deserialize)]
struct GlabIssue {
    iid: u64,
    web_url: String,
    title: String,
    state: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    labels: Vec<String>,
}

fn from_glab_issue(i: GlabIssue) -> IssueInfo {
    IssueInfo {
        number: i.iid,
        url: i.web_url,
        title: i.title,
        state: map_issue_state(&i.state),
        created_at: i.created_at,
        updated_at: i.updated_at,
        author: i.author.map(|a| PrAuthor { login: a.username }),
        labels: i
            .labels
            .into_iter()
            .map(|name| PrListLabel { name })
            .collect(),
    }
}

/// A GitLab milestone as embedded in an issue payload or listed by the milestones
/// endpoint. We keep the GLOBAL `id` — not the `iid` — because the milestone write
/// keys on `milestone_id`, and `iid` is project-scoped for project milestones but
/// group-scoped for group milestones (a collision waiting to happen). The neutral
/// `Milestone.number` carries this id everywhere on GitLab (list, detail, write),
/// so the picker's selection lookup and the mutation agree.
#[derive(Deserialize)]
struct GlabMilestone {
    id: u64,
    title: String,
}

/// One issue as `glab api …/issues/{iid}` returns it (detail shape). GitLab's body
/// is `description`; `assignees`/`milestone` carry the sidebar metadata.
#[derive(Deserialize)]
struct GlabIssueDetail {
    iid: u64,
    web_url: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    state: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    labels: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    assignees: Vec<GlabMrUser>,
    #[serde(default)]
    milestone: Option<GlabMilestone>,
    // GitLab returns `null` (not `false`) when the discussion isn't locked, and
    // `#[serde(default)]` only fills a MISSING key — a present `null` would fail to
    // deserialize into a bare `bool` and sink the whole detail parse ("Could not
    // load this issue"). `null_to_default` absorbs both null and missing.
    #[serde(default, deserialize_with = "null_to_default")]
    discussion_locked: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    confidential: bool,
    /// "YYYY-MM-DD" or null.
    #[serde(default)]
    due_date: Option<String>,
}

/// The repo's issues for the Issues list. `state` is `"open"` or `"closed"`.
/// GitLab issue state is a single `opened`/`closed` axis (no `merged`), so unlike
/// `list_prs` this is one fetch. GitLab's `/issues` endpoint already excludes merge
/// requests, so no extra filtering is needed.
pub async fn list_issues(repo_path: &str, state: &str) -> AppResult<Vec<IssueInfo>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let gl_state = match state {
        "open" => "opened",
        "closed" => "closed",
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown issue state filter: {other}"
            )));
        }
    };
    let endpoint = format!("projects/{enc}/issues?state={gl_state}&per_page=100");
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let issues: Vec<GlabIssue> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab issues: {e}")))?;
    Ok(issues.into_iter().map(from_glab_issue).collect())
}

/// Full read view of one issue — core fields, labels (with colors), and comments,
/// mapped onto `IssueDetails`. GitHub-only sidebar fields (org issue type, pinned)
/// are left empty; issues have no diff so there's no `diff` counterpart.
pub async fn view_issue(repo_path: &str, number: u64) -> AppResult<IssueDetails> {
    let enc = encode_project(&project_path(repo_path).await?);

    // Core issue fields.
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/issues/{number}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let issue: GlabIssueDetail = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab issue: {e}")))?;

    // Comments — drop GitLab's system notes (auto "changed the milestone", etc.).
    let comments: Vec<PrThreadOut> = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/issues/{number}/notes?sort=asc&per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .filter(|n| !n.system)
    .map(|n| PrThreadOut {
        author: n.author.map(|a| a.username).unwrap_or_default(),
        state: String::new(),
        body: n.body,
        date: n.created_at,
        id: n.id.to_string(),
        url: String::new(),
        viewer_did_author: false,
        is_minimized: false,
        minimized_reason: String::new(),
    })
    .collect();

    let colors = project_label_colors(repo_path, &enc).await;
    let labels: Vec<RepoLabel> = issue
        .labels
        .into_iter()
        .map(|name| {
            let color = colors.get(&name).cloned().unwrap_or_default();
            RepoLabel {
                id: String::new(),
                name,
                color,
            }
        })
        .collect();

    Ok(IssueDetails {
        // No GraphQL node id on GitLab; the GitLab mutations key on the iid
        // (labels by name), and the empty id doubles as the reactions "body"
        // subject (`forge_add_reaction` reads "" as the issue body). Sub-issue
        // mutations stay GitHub-only.
        id: String::new(),
        number: issue.iid,
        title: issue.title,
        body: issue.description.unwrap_or_default(),
        author: issue.author.map(|a| a.username).unwrap_or_default(),
        state: map_issue_state(&issue.state),
        created_at: issue.created_at,
        url: issue.web_url,
        assignees: issue.assignees.into_iter().map(|a| a.username).collect(),
        // `number` is GitLab's GLOBAL milestone id (see `GlabMilestone`) — the same
        // key `list_milestones` returns and `set_issue_milestone` writes, so the
        // picker's current-value lookup matches the option list.
        milestone: issue.milestone.map(|m| Milestone {
            number: m.id,
            title: m.title,
        }),
        // GitLab's issue "type" (issue/incident/task) isn't GitHub's org-defined
        // issue type, and GitLab has no pinned-issue concept here — leave both unset
        // rather than mislabel.
        issue_type: None,
        is_pinned: false,
        locked: issue.discussion_locked,
        active_lock_reason: None,
        confidential: issue.confidential,
        due_date: issue.due_date,
        comments,
        labels,
    })
}

// ── Issues (write) ────────────────────────────────────────────────────────────
//
// Comment (note), close/reopen, title/body edit, and milestone — mirroring the
// gh_issue_* commands and dispatching through forge_issue_* (labels/assignees/
// create live in their own sections below). The GitHub close `reason`
// (completed/not_planned) has no GitLab analogue, so the dispatch drops it before
// calling close_issue. `glab api -f key=value` is a RAW string field (no `@file`
// interpretation, unlike `-F`), so a body starting with `@` or carrying newlines
// is safe (glab is a real .exe — no BatBadBut shim refusal of newline argv; all
// validated live against the demo).

/// Post a comment (note) on an issue.
pub async fn comment_issue(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/notes");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Close or reopen an issue via the `state_event` field (`close` / `reopen`).
async fn set_issue_state(repo_path: &str, number: u64, event: &str) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let state_arg = format!("state_event={event}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &state_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

pub async fn close_issue(repo_path: &str, number: u64) -> AppResult<()> {
    set_issue_state(repo_path, number, "close").await
}

pub async fn reopen_issue(repo_path: &str, number: u64) -> AppResult<()> {
    set_issue_state(repo_path, number, "reopen").await
}

/// Edit an issue's title/description. Mirrors `gh_issue_edit` (empty-title guard;
/// an empty body clears the description). Validated live: `-f` keeps
/// multi-line/comma/`=`/`@`/leading-`-` values intact.
pub async fn edit_issue(repo_path: &str, number: u64, title: &str, body: &str) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument(
            "an issue title is required".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let title_arg = format!("title={title}");
    let desc_arg = format!("description={body}");
    run_glab(
        Some(repo_path),
        &[
            "api", "--method", "PUT", &endpoint, "-f", &title_arg, "-f", &desc_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Lock or unlock an issue's conversation (`discussion_locked`). Validated
/// live. GitLab has no lock reasons — the shared UI hides the reason submenu
/// per provider, and the read side already maps `discussion_locked` → `locked`.
pub async fn lock_issue(repo_path: &str, number: u64, locked: bool) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let lock_arg = format!("discussion_locked={locked}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &lock_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The two fields the issue-move flow reads back (the target project's id, the
/// moved issue's URL).
#[derive(Deserialize)]
struct GlabMoveTarget {
    id: u64,
}

#[derive(Deserialize)]
struct GlabMovedIssue {
    web_url: String,
}

/// Move an issue to another project — GitLab's analogue of a GitHub transfer;
/// returns the moved issue's URL. GitLab closes the original with a "moved"
/// marker. `destination` is a full project path ("group/name"), resolved to the
/// numeric id the move endpoint requires. Validated live.
pub async fn move_issue(repo_path: &str, number: u64, destination: &str) -> AppResult<String> {
    let destination = destination.trim().trim_matches('/');
    if destination.is_empty() || destination.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "a destination project is required".into(),
        ));
    }
    if !destination.contains('/') {
        return Err(AppError::InvalidArgument(
            "the destination must be a full project path (like group/name)".into(),
        ));
    }
    let dest_enc = encode_project(destination);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{dest_enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| {
        AppError::Glab(format!(
            "could not resolve the destination project \u{201c}{destination}\u{201d}: {e}"
        ))
    })?;
    let target: GlabMoveTarget = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the destination project: {e}")))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/move");
    let target_arg = format!("to_project_id={}", target.id);
    let moved = run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint, "-f", &target_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| match e {
        // GitLab folds several distinct causes into this one message — seen
        // live when the TARGET project has issues disabled, not just on actual
        // permission gaps. Spell out both so the fix is findable.
        AppError::Glab(msg) if msg.contains("insufficient permissions") => AppError::Glab(
            "GitLab refused the move — this needs Reporter access on both projects, \
             and the destination must have issues enabled."
                .into(),
        ),
        other => other,
    })?;
    let issue: GlabMovedIssue = serde_json::from_str(&moved.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the moved issue: {e}")))?;
    Ok(issue.web_url)
}

/// Project paths the viewer is a member of, ON THIS REPO'S HOST — the Move
/// dialog's destination suggestions. Runs in the repo so glab targets the
/// repo's own (possibly self-managed) instance, unlike the account-scoped
/// clone-browser listing which uses glab's default host.
pub async fn member_projects(repo_path: &str) -> AppResult<Vec<String>> {
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            "projects?membership=true&simple=true&archived=false&order_by=last_activity_at&per_page=100",
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    #[derive(Deserialize)]
    struct GlabProjectPath {
        path_with_namespace: String,
    }
    let projects: Vec<GlabProjectPath> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab projects: {e}")))?;
    Ok(projects
        .into_iter()
        .map(|p| p.path_with_namespace)
        .collect())
}

/// Permanently delete an issue. GitLab restricts this server-side to owners;
/// the API's error surfaces as-is when the viewer can't.
pub async fn delete_issue(repo_path: &str, number: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Milestones (read + write) ─────────────────────────────────────────────────
//
// The milestone picker's option list plus the issue milestone write. Everything
// keys on GitLab's GLOBAL milestone id (see `GlabMilestone`): the list returns it
// as the neutral `Milestone.number`, the issue detail carries the same id, and the
// write sends it as `milestone_id` — so the picker's selection lookup, the chip,
// and the mutation all agree. Set/clear validated live (`milestone_id=0` clears).

/// Active milestones for the milestone picker — project milestones plus ancestor
/// group milestones (`include_ancestor_groups=true`; GitLab issues commonly use a
/// group milestone, and the global-id write accepts either kind).
pub async fn list_milestones(repo_path: &str) -> AppResult<Vec<Milestone>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!(
        "projects/{enc}/milestones?state=active&include_ancestor_groups=true&per_page=100"
    );
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let milestones: Vec<GlabMilestone> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab milestones: {e}")))?;
    Ok(milestones
        .into_iter()
        .map(|m| Milestone {
            number: m.id,
            title: m.title,
        })
        .collect())
}

/// Set (`Some(global milestone id)`) or clear (`None` → `milestone_id=0`) an
/// issue's milestone.
pub async fn set_issue_milestone(
    repo_path: &str,
    number: u64,
    milestone: Option<u64>,
) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let milestone_arg = format!("milestone_id={}", milestone.unwrap_or(0));
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &milestone_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Mark an issue confidential (visible to project members only) or public again.
/// GitLab-only — GitHub has no confidential-issue concept.
pub async fn set_issue_confidential(
    repo_path: &str,
    number: u64,
    confidential: bool,
) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let arg = format!("confidential={confidential}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Set (`Some("YYYY-MM-DD")`) or clear (`None` → empty string, validated live) an
/// issue's due date. GitLab-only — GitHub has no issue due dates.
pub async fn set_issue_due_date(
    repo_path: &str,
    number: u64,
    due_date: Option<&str>,
) -> AppResult<()> {
    // The value rides a raw `-f due_date=…` field; keep the grammar strict so a
    // malformed date fails here with a clear message instead of a GitLab 400.
    if let Some(d) = due_date {
        let valid = d.len() == 10
            && d.bytes().enumerate().all(|(i, b)| match i {
                4 | 7 => b == b'-',
                _ => b.is_ascii_digit(),
            });
        if !valid {
            return Err(AppError::InvalidArgument(format!(
                "due date must be YYYY-MM-DD, got \"{d}\""
            )));
        }
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}");
    let arg = format!("due_date={}", due_date.unwrap_or(""));
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Reactions (award emoji) ───────────────────────────────────────────────────
//
// GitLab reactions are "award emoji" on issues, MRs, and notes. They map onto the
// SAME neutral `IssueReactions`/`Reaction` shape the GitHub panels render, with
// GitLab's award names translated to GitHub's ReactionContent enum (the 8 the
// ReactionBar knows); awards outside that set (GitLab allows the full emoji
// palette) are deliberately dropped — they stay visible on GitLab itself.
// Read strategy (all validated live): notes' awards come from ONE GraphQL query
// (`Note.awardEmoji`, with `currentUser` riding along for viewer detection) since
// per-note REST reads would be N+1 glab process spawns; the BODY awards come from
// GraphQL too for MRs (`MergeRequest.awardEmoji`) but REST for issues — the
// GraphQL `Issue` type exposes no `awardEmoji` field. Writes are REST: add =
// `POST …/award_emoji -f name=<award>` (a duplicate add 404s "has already been
// taken" — treated as already-on), remove = list, find the viewer's award by
// name, `DELETE …/award_emoji/<id>`.
// KNOWN CAP: every award list (REST reads + the GraphQL connections + the
// remove-path lookup) covers the first 100 awards per subject — past that,
// tallies undercount and a remove whose award sits beyond the page silently
// no-ops until a refetch. Accepted for now (a single subject with >100
// reactions is rare); revisit with pagination if it ever bites.

/// GitLab award name → GitHub ReactionContent enum (the neutral vocabulary).
fn award_to_reaction(name: &str) -> Option<&'static str> {
    Some(match name {
        "thumbsup" => "THUMBS_UP",
        "thumbsdown" => "THUMBS_DOWN",
        "smile" => "LAUGH",
        "confused" => "CONFUSED",
        "heart" => "HEART",
        "tada" => "HOORAY",
        "rocket" => "ROCKET",
        "eyes" => "EYES",
        _ => return None,
    })
}

/// GitHub ReactionContent enum → GitLab award name (the toggle's direction).
fn reaction_to_award(content: &str) -> AppResult<&'static str> {
    Ok(match content {
        "THUMBS_UP" => "thumbsup",
        "THUMBS_DOWN" => "thumbsdown",
        "LAUGH" => "smile",
        "CONFUSED" => "confused",
        "HEART" => "heart",
        "HOORAY" => "tada",
        "ROCKET" => "rocket",
        "EYES" => "eyes",
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown reaction: {other}"
            )));
        }
    })
}

/// One award as both the REST list and the GraphQL `awardEmoji.nodes` carry it.
#[derive(Deserialize)]
struct GlabAward {
    #[serde(default)]
    id: u64,
    name: String,
    #[serde(default)]
    user: Option<GlabMrUser>,
}

/// Fold a flat award list into the neutral per-content tallies, keeping only the
/// GitHub-8 vocabulary. `viewer` marks `viewer_reacted`.
fn tally_awards(awards: Vec<GlabAward>, viewer: &str) -> Vec<Reaction> {
    let mut out: Vec<Reaction> = Vec::new();
    for award in awards {
        let Some(content) = award_to_reaction(&award.name) else {
            continue;
        };
        let by_viewer = award
            .user
            .as_ref()
            .map(|u| u.username == viewer)
            .unwrap_or(false);
        if let Some(r) = out.iter_mut().find(|r| r.content == content) {
            r.count += 1;
            r.viewer_reacted = r.viewer_reacted || by_viewer;
        } else {
            out.push(Reaction {
                content: content.to_string(),
                count: 1,
                viewer_reacted: by_viewer,
            });
        }
    }
    out
}

// The GraphQL award-read envelope (shape validated live). Note ids come back as
// gids (`gid://gitlab/Note/<id>`); the numeric tail matches the REST note id the
// thread keys comments by.
#[derive(Deserialize)]
struct GqlAwardEnvelope {
    data: Option<GqlAwardData>,
}
#[derive(Deserialize)]
struct GqlAwardData {
    #[serde(rename = "currentUser")]
    current_user: Option<GlabUser>,
    project: Option<GqlAwardProject>,
}
#[derive(Deserialize)]
struct GqlAwardProject {
    issue: Option<GqlAwardTarget>,
    #[serde(rename = "mergeRequest")]
    merge_request: Option<GqlAwardTarget>,
}
#[derive(Deserialize)]
struct GqlAwardTarget {
    #[serde(rename = "awardEmoji")]
    award_emoji: Option<GqlAwardNodes>,
    notes: Option<GqlNoteNodes>,
}
#[derive(Deserialize)]
struct GqlAwardNodes {
    #[serde(default, deserialize_with = "null_to_default")]
    nodes: Vec<GlabAward>,
}
#[derive(Deserialize)]
struct GqlNoteNodes {
    #[serde(default, deserialize_with = "null_to_default")]
    nodes: Vec<GqlNote>,
}
#[derive(Deserialize)]
struct GqlNote {
    id: String,
    #[serde(default)]
    system: bool,
    #[serde(rename = "awardEmoji")]
    award_emoji: Option<GqlAwardNodes>,
}

/// Extract the numeric tail of a `gid://gitlab/Note/<id>` gid — the REST note id
/// the frontend's comment thread is keyed by.
fn gid_tail(gid: &str) -> String {
    gid.rsplit('/').next().unwrap_or(gid).to_string()
}

/// Run the one-shot GraphQL award read for an issue or MR and map it onto the
/// neutral shape. `body_awards_from_gql` is false for issues (no
/// `Issue.awardEmoji` in the schema — the caller fetches body awards via REST).
/// Returns the viewer's username too, so that caller can tally without another
/// `glab api user` spawn.
async fn award_read(
    repo_path: &str,
    path: &str,
    target_field: &str,
    number: u64,
    body_awards_from_gql: bool,
) -> AppResult<(IssueReactions, String)> {
    if path.contains('"') || path.contains('\\') {
        return Err(AppError::InvalidArgument(format!(
            "unexpected characters in project path: {path}"
        )));
    }
    let award_sel = if body_awards_from_gql {
        "awardEmoji { nodes { name user { username } } } "
    } else {
        ""
    };
    let query = format!(
        "{{ currentUser {{ username }} project(fullPath: \"{path}\") {{ {target_field}(iid: \"{number}\") {{ {award_sel}notes {{ nodes {{ id system awardEmoji {{ nodes {{ name user {{ username }} }} }} }} }} }} }} }}"
    );
    let query_arg = format!("query={query}");
    let out = run_glab(
        Some(repo_path),
        &["api", "graphql", "-f", &query_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let env: GqlAwardEnvelope = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab awards: {e}")))?;
    let data = env
        .data
        .ok_or_else(|| AppError::Glab("could not load GitLab awards".into()))?;
    let viewer = data.current_user.map(|u| u.username).unwrap_or_default();
    let target = data
        .project
        .and_then(|p| if target_field == "issue" { p.issue } else { p.merge_request })
        .ok_or_else(|| AppError::Glab("GitLab returned no such issue/MR".into()))?;
    let body = tally_awards(
        target.award_emoji.map(|a| a.nodes).unwrap_or_default(),
        &viewer,
    );
    let mut comments = HashMap::new();
    for note in target.notes.map(|n| n.nodes).unwrap_or_default() {
        if note.system {
            continue;
        }
        let awards = note.award_emoji.map(|a| a.nodes).unwrap_or_default();
        if awards.is_empty() {
            continue;
        }
        comments.insert(gid_tail(&note.id), tally_awards(awards, &viewer));
    }
    Ok((IssueReactions { body, comments }, viewer))
}

/// Reactions for an issue: REST for the body awards (no `Issue.awardEmoji` in
/// GraphQL) + the GraphQL note read.
pub async fn issue_reactions(repo_path: &str, number: u64) -> AppResult<IssueReactions> {
    let path = project_path(repo_path).await?;
    let enc = encode_project(&path);
    let (mut reactions, viewer) = award_read(repo_path, &path, "issue", number, false).await?;
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/issues/{number}/award_emoji?per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let awards: Vec<GlabAward> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab awards: {e}")))?;
    reactions.body = tally_awards(awards, &viewer);
    Ok(reactions)
}

/// Reactions for a merge request: one GraphQL read covers body + notes.
pub async fn mr_reactions(repo_path: &str, number: u64) -> AppResult<IssueReactions> {
    let path = project_path(repo_path).await?;
    Ok(award_read(repo_path, &path, "mergeRequest", number, true)
        .await?
        .0)
}

// ── External (third-party) reviews ────────────────────────────────────────────
//
// Third-party AI reviewers (Copilot / CodeRabbit / …) post their findings as MR
// discussion notes. We map each NON-system note onto the neutral
// `ExternalReviewItem` shape the frontend already consumes for GitHub, so its
// budgeting / prompt layers stay unchanged. GitLab REST authors carry NO `bot`
// flag (unlike GitHub's GraphQL `__typename`), so `is_bot` is NOT meaningful for
// GitLab — the frontend applies its `REVIEWER_BOTS` login allowlist to EVERY
// GitLab item regardless of kind (otherwise a human's inline diff comment would
// pose as an AI finding). GitHub, with a server-verified bot flag, still lets
// inline/review items bypass the list.

/// A note's `position` object as GitLab embeds it on diff (inline) notes; absent
/// or null for plain conversation notes. Every field is tolerated as
/// null/missing per the untrusted-JSON rule.
#[derive(Deserialize, Default)]
struct GlabNotePosition {
    #[serde(default, deserialize_with = "null_to_default")]
    new_path: String,
    #[serde(default)]
    new_line: Option<u32>,
    #[serde(default, deserialize_with = "null_to_default")]
    old_path: String,
    #[serde(default)]
    old_line: Option<u32>,
    #[serde(default, deserialize_with = "null_to_default")]
    head_sha: String,
    /// Present only on multi-line diff notes: the range's start/end line refs. We
    /// read the START line for `start_line`; a single-line note omits it. Every
    /// field is Option per the untrusted-JSON rule.
    #[serde(default)]
    line_range: Option<GlabLineRange>,
}

/// The neutral `(path, line, side)` anchor for a positioned diff note. Arm order:
/// new-line side, else old-line side, else path-only new, else path-only old (the
/// last arm labels `"old"` because the path came from the old side). Pure/testable.
fn gl_thread_anchor(position: &GlabNotePosition) -> (String, u32, &'static str) {
    if position.new_line.is_some() && !position.new_path.is_empty() {
        (position.new_path.clone(), position.new_line.unwrap_or(0), "new")
    } else if position.old_line.is_some() && !position.old_path.is_empty() {
        (position.old_path.clone(), position.old_line.unwrap_or(0), "old")
    } else if !position.new_path.is_empty() {
        (position.new_path.clone(), 0, "new")
    } else {
        (position.old_path.clone(), 0, "old")
    }
}

/// A diff note's multi-line range endpoints (`{start:{new_line,old_line}, …}`).
/// Only the start ref matters for the neutral `start_line`.
#[derive(Deserialize, Default)]
struct GlabLineRange {
    #[serde(default)]
    start: Option<GlabLineRangeRef>,
}

#[derive(Deserialize, Default)]
struct GlabLineRangeRef {
    #[serde(default)]
    new_line: Option<u32>,
    #[serde(default)]
    old_line: Option<u32>,
}

/// One note inside an MR discussion, as `…/merge_requests/<n>/discussions`
/// returns it. `type` is empty for plain notes and "DiffNote" for inline ones;
/// `resolved` is null unless the note is resolvable.
#[derive(Deserialize)]
struct GlabDiscussionNote {
    /// Numeric note id — used as the neutral comment id (stringified). Absent on
    /// no real note, but tolerated per the untrusted-JSON rule.
    #[serde(default)]
    id: u64,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    body: String,
    #[serde(default)]
    author: Option<GlabMrUser>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    resolvable: bool,
    #[serde(default)]
    resolved: Option<bool>,
    #[serde(default)]
    position: Option<GlabNotePosition>,
}

/// A discussion (thread) as the discussions endpoint returns it. `id` is the
/// discussion's (string) id — the resolve/reply endpoints key on it.
#[derive(Deserialize)]
struct GlabDiscussion {
    #[serde(default, deserialize_with = "null_to_default")]
    id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    notes: Vec<GlabDiscussionNote>,
}

/// Maps a discussion note onto the neutral `ExternalReviewItem` shape, or `None`
/// when the note is a system note (auto "approved" / "assigned" / "changed the
/// title" …) that must never enter the findings pipeline. Inline (DiffNote /
/// positioned) notes become `kind == "inline"` with a path/line; everything else
/// is `kind == "comment"`. `is_bot` is always true, but it is NOT meaningful for
/// GitLab (REST has no bot flag) — the frontend applies its `REVIEWER_BOTS` login
/// allowlist to every GitLab item regardless of kind, so it is the real gate.
/// Per-item: a malformed field falls back to a default rather than sinking the
/// whole batch.
fn external_item_from_note(n: &GlabDiscussionNote) -> Option<ExternalReviewItem> {
    if n.system {
        return None;
    }
    // A positioned note with a usable path is an inline (line-anchored) finding;
    // fall back to the old_path/old_line side when the new side is absent.
    let position = n.position.as_ref();
    let (path, line) = match position {
        Some(p) if !p.new_path.is_empty() => (p.new_path.clone(), p.new_line.unwrap_or(0)),
        Some(p) if !p.old_path.is_empty() => (p.old_path.clone(), p.old_line.unwrap_or(0)),
        _ => (String::new(), 0),
    };
    let kind = if path.is_empty() { "comment" } else { "inline" };
    // `resolved` is only meaningful when the note is resolvable.
    let is_resolved = n.resolvable && n.resolved == Some(true);
    Some(ExternalReviewItem {
        kind: kind.into(),
        author: n
            .author
            .as_ref()
            .map(|a| a.username.clone())
            .unwrap_or_default(),
        // GitLab REST authors carry no bot flag; `is_bot` is not meaningful for
        // GitLab. The frontend applies its `REVIEWER_BOTS` login allowlist to
        // EVERY GitLab item regardless of kind, so this value is only a
        // placeholder that keeps the shared shape non-empty.
        is_bot: true,
        body: n.body.clone(),
        path,
        line,
        // The commit the note was anchored to, when GitLab carries it (diff notes
        // do via `position.head_sha`); "" otherwise — used for staleness.
        commit_sha: position.map(|p| p.head_sha.clone()).unwrap_or_default(),
        // GitLab notes carry no submitted-review state (no APPROVED/CHANGES_REQUESTED
        // review-body concept on the discussions surface).
        state: String::new(),
        is_resolved,
        // GitLab has no per-thread "outdated" flag; staleness is inferred from
        // commit_sha vs head in the frontend.
        is_outdated: false,
        created_at: n.created_at.clone(),
    })
}

/// Maps a page of discussions to neutral review items, dropping system notes and
/// any note that fails to yield an item. Pure — unit-tested directly.
fn external_items_from_discussions(discussions: &[GlabDiscussion]) -> Vec<ExternalReviewItem> {
    discussions
        .iter()
        .flat_map(|d| d.notes.iter())
        .filter_map(external_item_from_note)
        .collect()
}

/// Fetch an MR's discussions (per_page=100, capped at 5 pages — the recent
/// findings/threads are all we need, and this can't spawn unbounded network
/// calls). Per-page tolerant: a page that won't parse stops the walk and returns
/// what we have so far, rather than sinking the whole read. Shared by
/// `external_reviews` (AI-context) and `review_threads` (the review-thread view).
async fn fetch_mr_discussions(
    repo_path: &str,
    enc: &str,
    number: u64,
) -> AppResult<Vec<GlabDiscussion>> {
    let mut all: Vec<GlabDiscussion> = Vec::new();
    for page in 1..=5u32 {
        let endpoint = format!(
            "projects/{enc}/merge_requests/{number}/discussions?per_page=100&page={page}"
        );
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let batch: Vec<GlabDiscussion> = match serde_json::from_str(&out.stdout_lossy()) {
            Ok(b) => b,
            Err(_) => break,
        };
        let done = batch.len() < 100;
        all.extend(batch);
        if done {
            break;
        }
    }
    Ok(all)
}

/// Third-party AI-reviewer findings on a merge request, mapped onto the same
/// neutral shape GitHub uses. Fetches the MR discussions and maps every non-system
/// note. Per-item tolerant: a malformed note falls back rather than sinking the batch.
pub async fn external_reviews(repo_path: &str, number: u64) -> AppResult<Vec<ExternalReviewItem>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let discussions = fetch_mr_discussions(repo_path, &enc, number).await?;
    Ok(external_items_from_discussions(&discussions))
}

/// File:line-anchored review threads on an MR — the positioned diff-note
/// discussions mapped onto the neutral `ReviewThreadOut`. A thread is a discussion
/// with at least one non-system positioned note. Path/line come from the first
/// positioned note (new side, else old, else new-path/0, else old-path/0 labelled
/// "old"); resolution comes from the
/// first resolvable note (GitLab resolves whole discussions, not individual notes).
/// `start_line` comes from a multi-line note's `position.line_range` (0 when
/// single-line). GitLab's flat discussions API exposes no cheap per-thread
/// "outdated" bit nor a diff excerpt, so `is_outdated` is always false and
/// `diff_hunk` is always empty. The thread's comments are its non-system notes.
pub async fn review_threads(repo_path: &str, number: u64) -> AppResult<Vec<ReviewThreadOut>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let discussions = fetch_mr_discussions(repo_path, &enc, number).await?;

    let mut threads: Vec<ReviewThreadOut> = Vec::new();
    for d in &discussions {
        // Non-system notes only — a discussion is a thread when it carries at
        // least one positioned (diff-anchored) note.
        let notes: Vec<&GlabDiscussionNote> = d.notes.iter().filter(|n| !n.system).collect();
        let first_positioned = notes.iter().find(|n| n.position.is_some());
        let Some(anchor) = first_positioned else {
            continue;
        };
        let position = anchor.position.as_ref().expect("find matched .is_some()");
        let (path, line, side) = gl_thread_anchor(position);
        // Multi-line diff notes carry a `line_range`; its start line (on the same
        // side we anchored to) is the range's first line. Single-line notes have no
        // range → 0 (the frontend then uses `line` alone).
        let start_line = position
            .line_range
            .as_ref()
            .and_then(|r| r.start.as_ref())
            .and_then(|s| if side == "old" { s.old_line } else { s.new_line })
            .unwrap_or(0);
        // GitLab resolves whole discussions; the resolvable notes share one state.
        let is_resolved = notes
            .iter()
            .find(|n| n.resolvable)
            .map(|n| n.resolved == Some(true))
            .unwrap_or(false);
        let comments: Vec<PrThreadOut> = notes
            .iter()
            .map(|n| PrThreadOut {
                author: n.author.as_ref().map(|a| a.username.clone()).unwrap_or_default(),
                state: String::new(),
                body: n.body.clone(),
                date: n.created_at.clone(),
                id: n.id.to_string(),
                url: String::new(),
                viewer_did_author: false,
                is_minimized: false,
                minimized_reason: String::new(),
            })
            .collect();
        if comments.is_empty() {
            continue;
        }
        threads.push(ReviewThreadOut {
            id: d.id.clone(),
            path,
            line,
            start_line,
            side: side.into(),
            is_resolved,
            // GitLab's flat discussions API has no cheap per-thread "outdated"
            // bit, so this is always false (staleness is inferred elsewhere).
            is_outdated: false,
            // GitLab's flat discussions API carries no unified-diff excerpt on the
            // note, so no cheap hunk to render — empty (frontend falls back to the
            // MR diff at the anchored line).
            diff_hunk: String::new(),
            // GitLab doesn't model review objects here (pr_view emits no reviews),
            // so there's no owning review id to attach.
            review_id: String::new(),
            comments,
        });
    }
    Ok(threads)
}

/// Reply in an existing MR discussion (`POST …/discussions/{id}/notes`, `-f body`).
pub async fn reply_thread(
    repo_path: &str,
    number: u64,
    discussion_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a reply is required".into()));
    }
    if discussion_id.is_empty() {
        return Err(AppError::InvalidArgument("a thread id is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint =
        format!("projects/{enc}/merge_requests/{number}/discussions/{discussion_id}/notes");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Resolve / unresolve an MR discussion (`PUT …/discussions/{id}`, `-f resolved`).
pub async fn resolve_thread(
    repo_path: &str,
    number: u64,
    discussion_id: &str,
    resolved: bool,
) -> AppResult<()> {
    if discussion_id.is_empty() {
        return Err(AppError::InvalidArgument("a thread id is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/discussions/{discussion_id}");
    let resolved_arg = format!("resolved={resolved}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &resolved_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The award endpoint for a subject: the issue/MR body (`note_id` None) or one
/// of its notes. `target` is `"issue"` or `"mr"`.
fn award_endpoint(enc: &str, target: &str, number: u64, note_id: Option<&str>) -> AppResult<String> {
    let seg = match target {
        "issue" => "issues",
        "mr" => "merge_requests",
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown reaction target: {other}"
            )));
        }
    };
    Ok(match note_id {
        Some(id) => format!("projects/{enc}/{seg}/{number}/notes/{id}/award_emoji"),
        None => format!("projects/{enc}/{seg}/{number}/award_emoji"),
    })
}

/// Add the viewer's award. A duplicate add (GitLab 404s "has already been
/// taken", validated live) means the state is already what the user wanted —
/// a no-op success, mirroring `remove_reaction`'s missing-award case; erroring
/// would roll back the optimistic chip and toast for nothing.
pub async fn add_reaction(
    repo_path: &str,
    target: &str,
    number: u64,
    note_id: Option<&str>,
    content: &str,
) -> AppResult<()> {
    let award = reaction_to_award(content)?;
    if let Some(id) = note_id {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AppError::InvalidArgument(format!("invalid note id: {id}")));
        }
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = award_endpoint(&enc, target, number, note_id)?;
    let name_arg = format!("name={award}");
    match run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint, "-f", &name_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(AppError::Glab(msg)) if msg.contains("already been taken") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Remove the viewer's award: list the subject's awards, find the viewer's by
/// name, DELETE it by id. A missing award (already removed elsewhere) is a no-op
/// success — the state matches what the user asked for.
pub async fn remove_reaction(
    repo_path: &str,
    target: &str,
    number: u64,
    note_id: Option<&str>,
    content: &str,
) -> AppResult<()> {
    let award = reaction_to_award(content)?;
    if let Some(id) = note_id {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(AppError::InvalidArgument(format!("invalid note id: {id}")));
        }
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = award_endpoint(&enc, target, number, note_id)?;
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("{endpoint}?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let awards: Vec<GlabAward> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab awards: {e}")))?;
    let viewer = current_user(repo_path).await?.username;
    let Some(mine) = awards.into_iter().find(|a| {
        a.name == award
            && a.user
                .as_ref()
                .map(|u| u.username == viewer)
                .unwrap_or(false)
    }) else {
        return Ok(());
    };
    let del = format!("{endpoint}/{}", mine.id);
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &del],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Labels & assignees (read + write) ─────────────────────────────────────────
//
// Labels are a SHARED control on both issues and MRs (GitHub keys them by GraphQL
// node id, GitLab by name); issue assignees are a shared issue control. The pickers
// read the project's labels / members, then the writes apply a delta (labels) or a
// full set (assignees). Both arg forms were validated live against the demo:
//   • labels  → `add_labels=<csv>` / `remove_labels=<csv>` (delta, by name);
//   • assignees → `assignee_ids=<comma-joined ids>` (set) or `=0` (clear). GitLab
//     assigns by numeric id, so the write resolves usernames→ids from the members
//     list. The `assignee_ids[]=…` array form 400s through glab's `-f`, hence the
//     comma form; on the Free tier GitLab keeps only the first id (reconciled by
//     refetch). The same PUT works on MRs (GitLab-only — GitHub PRs have no picker).

/// The project's labels for the label picker, as neutral `RepoLabel`s. GitLab has no
/// node id for a label (it addresses them by name), so `id` is left empty — the
/// frontend's GitLab path keys the write on the name instead.
pub async fn repo_labels(repo_path: &str) -> AppResult<Vec<RepoLabel>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/labels?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let labels: Vec<GlabLabel> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab labels: {e}")))?;
    Ok(labels
        .into_iter()
        .map(|l| RepoLabel {
            id: String::new(),
            name: l.name,
            color: l.color.trim_start_matches('#').to_string(),
        })
        .collect())
}

/// A GitLab project member (assignee candidate). `id` is required to SET assignees —
/// GitLab assigns by numeric id, not username, so the write resolves usernames→ids.
#[derive(Deserialize)]
struct GlabMember {
    id: u64,
    username: String,
}

/// The project's members (`members/all` = direct + inherited group members).
async fn project_members(repo_path: &str) -> AppResult<Vec<GlabMember>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/members/all?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab project members: {e}")))
}

/// Resolve assignee usernames to GitLab's numeric ids via the project members.
/// Errors when the members can't be fetched (a 403/timeout must not read as "no
/// match") or when ANY username fails to resolve (naming the misses) — an assignee
/// write must never silently drop someone (fail safe; shared by the set + create
/// paths). A miss is a picker-vs-submit race or a >100-member project (the members
/// read is capped at one page).
async fn resolve_assignee_ids(repo_path: &str, assignees: &[String]) -> AppResult<Vec<u64>> {
    let members = project_members(repo_path).await?;
    let by_name: HashMap<&str, u64> =
        members.iter().map(|m| (m.username.as_str(), m.id)).collect();
    let mut ids = Vec::with_capacity(assignees.len());
    let mut missing: Vec<&str> = Vec::new();
    for u in assignees {
        match by_name.get(u.as_str()) {
            Some(id) => ids.push(*id),
            None => missing.push(u.as_str()),
        }
    }
    if !missing.is_empty() {
        return Err(AppError::Glab(format!(
            "could not match {} to GitLab project members",
            missing.join(", ")
        )));
    }
    Ok(ids)
}

/// The project's assignable users, as usernames (mirroring `gh_assignable_users`).
/// `members/all` can list a user twice (direct + inherited), so dedupe by username.
pub async fn assignable_users(repo_path: &str) -> AppResult<Vec<String>> {
    let mut seen = std::collections::HashSet::new();
    Ok(project_members(repo_path)
        .await?
        .into_iter()
        .filter(|m| seen.insert(m.username.clone()))
        .map(|m| m.username)
        .collect())
}

/// Add/remove labels on an issue or MR by NAME (GitLab's `add_labels`/`remove_labels`
/// delta fields). `target` is `"issue"` or `"mr"`. An empty add+remove is a no-op.
pub async fn edit_labels(
    repo_path: &str,
    target: &str,
    number: u64,
    add: &[String],
    remove: &[String],
) -> AppResult<()> {
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }
    let path = match target {
        "issue" => "issues",
        "mr" => "merge_requests",
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown label target: {other}"
            )));
        }
    };
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/{path}/{number}");
    let add_arg = format!("add_labels={}", add.join(","));
    let remove_arg = format!("remove_labels={}", remove.join(","));
    let mut args = vec!["api", "--method", "PUT", &endpoint];
    if !add.is_empty() {
        args.push("-f");
        args.push(&add_arg);
    }
    if !remove.is_empty() {
        args.push("-f");
        args.push(&remove_arg);
    }
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Set an issue's or MR's assignees to the desired set of usernames — the two
/// endpoints differ only in the path segment. GitLab assigns by numeric id, so
/// resolve usernames→ids from the project members; an empty list clears all
/// assignees (`assignee_ids=0`). A non-empty request that resolves to no known
/// member errors rather than silently clearing.
async fn set_target_assignees(
    repo_path: &str,
    target_segment: &str,
    number: u64,
    assignees: &[String],
) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/{target_segment}/{number}");
    // A resolution miss errors inside the resolver — it must never turn an assign
    // into a partial assign or (worse) a clear.
    let ids: Vec<u64> = if assignees.is_empty() {
        Vec::new()
    } else {
        resolve_assignee_ids(repo_path, assignees).await?
    };
    // `assignee_ids=0` clears; otherwise the comma-joined id list (the `[]` array
    // form 400s through glab's `-f`).
    let value = if ids.is_empty() {
        "0".to_string()
    } else {
        ids.iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    let arg = format!("assignee_ids={value}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Set an issue's assignees (usernames; empty clears).
pub async fn set_issue_assignees(
    repo_path: &str,
    number: u64,
    assignees: &[String],
) -> AppResult<()> {
    set_target_assignees(repo_path, "issues", number, assignees).await
}

/// Set a merge request's assignees (usernames; empty clears). GitLab-only — GitHub
/// PRs have no assignee picker in this app.
pub async fn set_mr_assignees(
    repo_path: &str,
    number: u64,
    assignees: &[String],
) -> AppResult<()> {
    set_target_assignees(repo_path, "merge_requests", number, assignees).await
}

// ── Repository actions & publish ──────────────────────────────────────────────
//
// View (web URL), star/unstar, and publishing a local repo to GitLab. Forking
// stays a web link-out for GitLab (the fork+remote-rewire flow is GitHub-only for
// now), and the admin-settings / branch-rule-import sub-surfaces stay GitHub-only
// — the frontend guards those on the provider, not just `repo_actions`.
// All validated live: `starrers?search=<username>` answers "has the viewer
// starred it" (exact-match filter); re-starring returns HTTP 304 (treated as
// already-done); `glab repo create <name>` creates the project (visibility /
// description / repeated `-t` topics all land) but does NOT wire a remote — the
// publish flow adds `origin` itself and pushes with the one-shot glab credential
// helper (the same trick as clone/create-MR).

/// The project fields the repo-action reads need.
#[derive(Deserialize)]
struct GlabProjectRef {
    web_url: String,
    http_url_to_repo: String,
}

/// The repo's web URL (project home) for "View on GitLab".
pub async fn repo_url(repo_path: &str) -> AppResult<String> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let p: GlabProjectRef = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab project: {e}")))?;
    Ok(p.web_url)
}

/// One of the viewer's starred projects (only the path is needed).
#[derive(Deserialize)]
struct GlabStarredProject {
    path_with_namespace: String,
}

/// Whether the signed-in viewer has starred this project. Reads the VIEWER's
/// starred list filtered by the project name and matches the full path — the
/// project-side starrers list is unusable here (`search` also matches display
/// names and pages at 20, so a common username on a popular repo false-negatives
/// off page one, which the 304-tolerant star write would then turn into a
/// permanently dead button).
pub async fn repo_star_status(repo_path: &str) -> AppResult<bool> {
    let path = project_path(repo_path).await?;
    let me = current_user(repo_path).await?;
    let name = path.rsplit('/').next().unwrap_or(&path);
    // `search` also matches names/descriptions, so a common path tail can match
    // far more than one project — walk pages (capped) rather than trust page 1;
    // a missed star turns the button permanently dead via the 304-tolerant write.
    for page in 1..=10u32 {
        let endpoint = format!(
            "users/{}/starred_projects?search={}&per_page=100&page={page}",
            me.id,
            encode_query_value(name)
        );
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let starred: Vec<GlabStarredProject> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| {
                AppError::Glab(format!("could not parse GitLab starred projects: {e}"))
            })?;
        if starred.iter().any(|p| p.path_with_namespace == path) {
            return Ok(true);
        }
        if starred.len() < 100 {
            return Ok(false);
        }
    }
    // >1000 matching starred projects — beyond the cap, report unstarred rather
    // than keep walking (the star write is 304-tolerant either way).
    Ok(false)
}

/// Star or unstar the project. GitLab answers HTTP 304 when the state already
/// matches (validated live) — that's the outcome the user asked for, not an
/// error.
pub async fn repo_set_star(repo_path: &str, starred: bool) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let action = if starred { "star" } else { "unstar" };
    let endpoint = format!("projects/{enc}/{action}");
    match run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => Ok(()),
        Err(AppError::Glab(msg)) if msg.contains("HTTP 304") => Ok(()),
        Err(e) => Err(e),
    }
}

/// Whether glab is installed + signed in — the "can this machine publish to
/// GitLab?" probe for repos with no hosted remote yet (there's nothing to detect
/// a provider from, so publish targets are asked for explicitly).
pub async fn cli_ready() -> bool {
    if run_glab_raw(None, &["--version"], GLAB_TIMEOUT)
        .await
        .map(|o| o.code == 0)
        .unwrap_or(false)
    {
        run_glab_raw(None, &["auth", "status"], GLAB_TIMEOUT)
            .await
            .map(|o| o.code == 0)
            .unwrap_or(false)
    } else {
        false
    }
}

/// Publish a local repo to GitLab: create the project (in the user's namespace),
/// add it as `origin`, and push the current branch with the one-shot glab
/// credential helper. Returns the project's web URL. GitLab has no homepage
/// field, and publishing into a group isn't wired yet — the dialog says so.
pub async fn publish_repo(
    state: &AppState,
    repo_path: &str,
    name: &str,
    private: bool,
    description: &str,
    topics: &[String],
) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "a project name is required".into(),
        ));
    }
    if name.contains('/') {
        return Err(AppError::InvalidArgument(
            "Publishing into a GitLab group isn't supported yet — use a plain \
             project name (it lands in your namespace)."
                .into(),
        ));
    }
    let description = description.trim();
    // glab treats a lone "-" description as "open an editor" — never from an app.
    if description == "-" {
        return Err(AppError::InvalidArgument("invalid description".into()));
    }

    // Every local precondition is checked BEFORE the mutating create — a guard
    // that fires after it would strand an orphaned GitLab project whose name
    // then blocks every retry with "has already been taken".
    let branch_out = crate::git::runner::run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| {
        // An unborn branch (fresh `git init`, no commits) makes rev-parse fail
        // with "ambiguous argument 'HEAD'" — translate just that; any other
        // failure (not a repo, git missing, …) keeps its real message.
        match &e {
            AppError::Git { stderr, .. }
                if stderr.contains("ambiguous argument")
                    || stderr.contains("unknown revision") =>
            {
                AppError::InvalidArgument(
                    "make an initial commit before publishing (this repository has none yet)"
                        .into(),
                )
            }
            _ => e,
        }
    })?;
    let branch = branch_out.stdout_lossy().trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(AppError::InvalidArgument(
            "check out a branch before publishing (detached HEAD)".into(),
        ));
    }
    // An origin remote may have appeared since the UI's (cached) no-origin
    // check — adding one externally then publishing would otherwise strand an
    // orphaned project when the post-create `remote add` fails.
    if crate::git::runner::run_git_raw(
        Some(repo_path),
        &["remote", "get-url", "origin"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .map(|o| o.code == 0)
    .unwrap_or(false)
    {
        return Err(AppError::InvalidArgument(
            "this repository already has an origin remote — push to it instead".into(),
        ));
    }
    let me = current_user(repo_path).await?;

    let visibility = if private { "--private" } else { "--public" };
    let mut args: Vec<&str> = vec!["repo", "create", name, visibility];
    if !description.is_empty() {
        args.push("-d");
        args.push(description);
    }
    for topic in topics {
        // Topics are lowercased [a-z0-9-] upstream; skip anything flag-shaped.
        if !topic.is_empty() && !topic.starts_with('-') {
            args.push("-t");
            args.push(topic);
        }
    }
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;

    // The project now exists — from here on, any failure must SAY so, or a
    // retry (which re-creates) reads as an inexplicable "name already taken".
    let created_hint = format!(
        "the project WAS created at {}/{name} on GitLab — add it as a remote and \
         push manually, or delete it there and retry",
        me.username
    );

    // `glab repo create` does not wire a remote (validated live) — resolve the
    // created project's URLs and do it ourselves, then push the current branch.
    let enc = encode_project(&format!("{}/{name}", me.username));
    let project: GlabProjectRef = match run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .and_then(|out| {
        serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse the created project: {e}")))
    }) {
        Ok(p) => p,
        Err(e) => return Err(AppError::Glab(format!("{e} ({created_hint})"))),
    };

    if let Err(e) = crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &["remote", "add", "origin", &project.http_url_to_repo],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await
    {
        return Err(AppError::Glab(format!("{e} ({created_hint})")));
    }

    // A push failure after this point self-recovers: origin exists, so the repo
    // flips GitLab-ready and the normal Push button takes over.
    let config = clone_credential_config(&project.http_url_to_repo).await?;
    let mut push_args: Vec<&str> = Vec::new();
    for entry in &config {
        push_args.push("-c");
        push_args.push(entry);
    }
    push_args.extend(["push", "-u", "origin", &branch]);
    crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &push_args,
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await?;

    Ok(project.web_url)
}

// ── Issues & merge requests (create) ──────────────────────────────────────────
//
// Both creates POST through `glab api` and return the same neutral `PrRef`
// (number + URL) the GitHub creates return, so the dialogs stay provider-agnostic.
// Arg forms validated live against the demo: `labels=<csv>` (names),
// `assignee_ids=<csv>` (numeric ids, resolved from usernames like the assignee
// write), and `milestone_id=<global id>` on issue create;
// `source_branch`/`target_branch`/`title`/`description` on MR create, with
// **draft = the `Draft:` title prefix** (GitLab has no draft field on create —
// the response then carries `draft: true`). Note the created issue's `web_url`
// comes back in GitLab's newer `/-/work_items/<iid>` form.

/// The created issue/MR fields we need back (GitLab returns the full object).
#[derive(Deserialize)]
struct GlabCreated {
    iid: u64,
    web_url: String,
}

/// Create an issue with optional labels (by name), assignees (by username —
/// resolved to GitLab's numeric ids via the project members, erroring rather than
/// silently dropping when none resolve), and milestone (by GLOBAL milestone id,
/// as `list_milestones` returns; validated live). GitHub's org issue type has no
/// GitLab analogue (the dialog hides that picker).
pub async fn create_issue(
    repo_path: &str,
    title: &str,
    body: &str,
    labels: &[String],
    assignees: &[String],
    milestone: Option<u64>,
) -> AppResult<PrRef> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument(
            "an issue title is required".into(),
        ));
    }
    let labels_arg = (!labels.is_empty()).then(|| format!("labels={}", labels.join(",")));
    let mut ids_arg = None;
    if !assignees.is_empty() {
        // Full resolution or error — never create with a silently-reduced set.
        let ids = resolve_assignee_ids(repo_path, assignees).await?;
        ids_arg = Some(format!(
            "assignee_ids={}",
            ids.iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues");
    let title_arg = format!("title={title}");
    let desc_arg = format!("description={body}");
    let milestone_arg = milestone.map(|m| format!("milestone_id={m}"));
    let mut args = vec![
        "api", "--method", "POST", &endpoint, "-f", &title_arg, "-f", &desc_arg,
    ];
    if let Some(a) = &labels_arg {
        args.push("-f");
        args.push(a);
    }
    if let Some(a) = &ids_arg {
        args.push("-f");
        args.push(a);
    }
    if let Some(a) = &milestone_arg {
        args.push("-f");
        args.push(a);
    }
    let out = run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    let created: GlabCreated = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the created issue: {e}")))?;
    Ok(PrRef {
        number: created.iid,
        url: created.web_url,
    })
}

/// Push `head` to origin, then open a merge request from `head` into `base`.
/// The push injects glab's token as a one-shot git credential helper (the same
/// trick as `forge_clone`) — git alone 401s on a private GitLab remote because
/// glab's token isn't in git's credential store.
pub async fn create_mr(
    state: &AppState,
    repo_path: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> AppResult<PrRef> {
    for b in [base, head] {
        if b.is_empty() || b.starts_with('-') {
            return Err(AppError::InvalidArgument(format!("invalid branch: {b}")));
        }
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("an MR title is required".into()));
    }

    // An MR needs the branch on the remote first.
    let origin =
        crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await?;
    let config = clone_credential_config(&origin).await?;
    let mut push_args: Vec<&str> = Vec::new();
    for entry in &config {
        push_args.push("-c");
        push_args.push(entry);
    }
    push_args.extend(["push", "-u", "origin", head]);
    crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &push_args,
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await?;

    // GitLab drafts are the `Draft:` title prefix (no field on create).
    let full_title = if draft && !title.to_ascii_lowercase().starts_with("draft:") {
        format!("Draft: {title}")
    } else {
        title.to_string()
    };
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests");
    let source_arg = format!("source_branch={head}");
    let target_arg = format!("target_branch={base}");
    let title_arg = format!("title={full_title}");
    let desc_arg = format!("description={body}");
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            "--method",
            "POST",
            &endpoint,
            "-f",
            &source_arg,
            "-f",
            &target_arg,
            "-f",
            &title_arg,
            "-f",
            &desc_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let created: GlabCreated = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the created merge request: {e}")))?;
    Ok(PrRef {
        number: created.iid,
        url: created.web_url,
    })
}

// ── Pipelines (CI, read) ──────────────────────────────────────────────────────
//
// GitLab pipelines map onto the same neutral `WorkflowRun`/`RunDetail`/`RunJob`
// the GitHub Actions panels render, so the frontend stays provider-agnostic. The
// two models differ in two ways we bridge here:
//   • GitLab has ONE `status` per pipeline/job; GitHub splits lifecycle (`status`)
//     from result (`conclusion`). `map_ci_status` collapses GitLab's onto both.
//   • GitHub nests run → jobs → steps; GitLab is pipeline → jobs (grouped by
//     `stage`, no per-job steps via the API), so GitLab jobs map to neutral jobs
//     with an empty `steps` list. Logs are per-job (`/jobs/<id>/trace`).
// Writes (retry / cancel / run) live at the end of this section. GitLab's retry
// restarts failed+canceled jobs only — there is no "re-run all" on an existing
// pipeline, so that one control stays GitHub-only in the UI.

/// Failed-step logs can run to many MB; keep the tail (failures land at the end).
const CI_RUN_LOG_CAP: usize = 200_000;
/// Tighter per-job cap (a job log is also fed to the AI debugger).
const CI_JOB_LOG_CAP: usize = 60_000;

/// Collapse GitLab's single pipeline/job `status` onto GitHub's two-field model:
/// `(lifecycle status, conclusion)`. A run/job is "active" while `status` isn't
/// `"completed"`, so anything still in flight maps to a non-completed lifecycle and
/// an empty conclusion; finished states carry their result in `conclusion`.
fn map_ci_status(s: &str) -> (String, String) {
    let (status, conclusion) = match s {
        "success" => ("completed", "success"),
        "failed" => ("completed", "failure"),
        "canceled" | "cancelled" => ("completed", "cancelled"),
        "skipped" => ("completed", "skipped"),
        // A pipeline blocked on a manual job — closest neutral is "needs a human".
        "manual" => ("completed", "action_required"),
        "running" => ("in_progress", ""),
        "pending" => ("pending", ""),
        "created" | "preparing" => ("queued", ""),
        "waiting_for_resource" | "scheduled" => ("waiting", ""),
        // Unknown/new GitLab state — treat as finished-neutral rather than guess.
        _ => ("completed", ""),
    };
    (status.to_string(), conclusion.to_string())
}

/// GitLab's pipeline `source` → a short label for the run's "workflow" slot
/// (GitLab has no per-workflow name; the whole `.gitlab-ci.yml` is the pipeline).
fn friendly_source(source: &str) -> String {
    match source {
        "push" => "Push",
        "web" => "Manual",
        "schedule" => "Schedule",
        "merge_request_event" => "Merge request",
        "trigger" => "Trigger",
        "pipeline" => "Multi-project",
        "api" => "API",
        "external" | "external_pull_request_event" => "External",
        "" => "Pipeline",
        other => other,
    }
    .to_string()
}

/// Keep at most `cap` bytes, preferring the tail (CI failures land at the end), on
/// a char boundary. Mirrors the GitHub log commands' truncation.
fn tail_cap(text: String, cap: usize) -> String {
    if text.len() <= cap {
        return text;
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…(earlier output truncated)\n{}", &text[start..])
}

/// Clean a GitLab job trace into the plain text the log viewer expects: drop
/// GitLab's `section_start/end:<ts>:<name>` fold markers, ANSI CSI escapes, and
/// carriage returns — runner-formatting noise the GitHub `--log` path never emits.
fn clean_trace(raw: &str) -> String {
    // 1. Drop the markers FIRST, while the CR GitLab puts after the section name
    //    still delimits it from the visible content. (Stripping CRs first would
    //    fuse `…:prepare` into the following `Preparing…` and eat real output.)
    let mut without_markers = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(idx) = rest.find("section_") {
        without_markers.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        let prefix = if tail.starts_with("section_start:") {
            "section_start:"
        } else if tail.starts_with("section_end:") {
            "section_end:"
        } else {
            // A "section_" that isn't a marker — keep it and move past.
            without_markers.push_str("section_");
            rest = &tail["section_".len()..];
            continue;
        };
        // Skip the prefix, the timestamp digits, ':' and the section name (which
        // ends at the CR before the content — non-`[A-Za-z0-9_.-]`).
        let after = &tail[prefix.len()..];
        let digits_end = after
            .char_indices()
            .find(|(_, ch)| !ch.is_ascii_digit())
            .map_or(after.len(), |(i, _)| i);
        let named = after[digits_end..].strip_prefix(':').unwrap_or(&after[digits_end..]);
        let name_end = named
            .char_indices()
            .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-' || *ch == '.'))
            .map_or(named.len(), |(i, _)| i);
        rest = &named[name_end..];
    }
    without_markers.push_str(rest);

    // 2. Strip ANSI CSI escapes (ESC `[` … final byte 0x40–0x7E) and carriage returns.
    let mut out = String::with_capacity(without_markers.len());
    let mut it = without_markers.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                for n in it.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            continue;
        }
        if c == '\r' {
            continue;
        }
        out.push(c);
    }
    out
}

/// A GitLab pipeline as `glab api …/pipelines` returns it (list + detail core).
#[derive(Deserialize)]
struct GlabPipeline {
    id: u64,
    #[serde(default)]
    iid: u64,
    #[serde(default)]
    sha: String,
    #[serde(rename = "ref", default)]
    git_ref: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    web_url: String,
    // GitLab 15.5+ pipeline name (from `workflow:name:`); usually absent.
    #[serde(default)]
    name: Option<String>,
}

fn from_glab_pipeline(p: GlabPipeline) -> WorkflowRun {
    let (status, conclusion) = map_ci_status(&p.status);
    let workflow_name = friendly_source(&p.source);
    let name = p.name.unwrap_or_default();
    let display_title = if name.is_empty() {
        format!("Pipeline #{}", p.iid)
    } else {
        name
    };
    WorkflowRun {
        id: p.id,
        number: p.iid,
        display_title,
        status,
        conclusion,
        workflow_name,
        head_branch: p.git_ref,
        event: p.source,
        // GitLab's LIST payload has no per-run start time (only the detail
        // does), so created_at stands in for both — the Insights duration trend
        // (created → updated) then includes queue time, a slight overstatement
        // that's still an honest trend. Never leave it empty: the chart filters
        // on startedAt and would silently drop every GitLab pipeline.
        created_at: p.created_at.clone(),
        started_at: p.created_at,
        updated_at: p.updated_at,
        url: p.web_url,
        head_sha: p.sha,
    }
}

/// The commit a job ran against — its title gives the pipeline detail a real header.
#[derive(Deserialize)]
struct GlabJobCommit {
    #[serde(default)]
    title: String,
}

/// One job as `glab api …/pipelines/<id>/jobs` returns it.
#[derive(Deserialize)]
struct GlabJob {
    id: u64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    name: String,
    // GitLab sends `null` for a not-yet-started/finished job — absorb it.
    #[serde(default, deserialize_with = "null_to_default")]
    started_at: String,
    #[serde(default, deserialize_with = "null_to_default")]
    finished_at: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    commit: Option<GlabJobCommit>,
}

fn from_glab_job(j: GlabJob) -> RunJob {
    let (status, conclusion) = map_ci_status(&j.status);
    RunJob {
        id: j.id,
        name: j.name,
        status,
        conclusion,
        started_at: j.started_at,
        completed_at: j.finished_at,
        url: j.web_url,
        // GitLab exposes no per-job steps via the API — the job is the leaf unit.
        steps: Vec::new(),
        // GitLab job logs are addressed by the numeric job id, not a log ref.
        log_ref: None,
    }
}

/// Recent pipelines for this repo, newest first; optionally scoped to one branch.
pub async fn list_runs(
    repo_path: &str,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<WorkflowRun>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let per_page = limit.clamp(1, 100);
    let mut endpoint = format!("projects/{enc}/pipelines?per_page={per_page}");
    if let Some(b) = branch.as_deref().filter(|s| !s.is_empty()) {
        // Percent-encode: a branch with a query-significant char (`&`, `#`, `?`, `=`,
        // `%`) would otherwise corrupt the query and silently return the wrong
        // (unfiltered) pipeline set. `%2F` for `/` is accepted by GitLab's `ref`.
        endpoint.push_str(&format!("&ref={}", encode_query_value(b)));
    }
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let pipelines: Vec<GlabPipeline> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab pipelines: {e}")))?;
    Ok(pipelines.into_iter().map(from_glab_pipeline).collect())
}

/// One pipeline with its jobs, mapped onto `RunDetail` (jobs have empty `steps`).
pub async fn view_run(repo_path: &str, run_id: u64) -> AppResult<RunDetail> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/pipelines/{run_id}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let p: GlabPipeline = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab pipeline: {e}")))?;

    // Jobs — GitLab returns newest-first; reverse to execution order (stage order),
    // matching how view_pr reorders commits oldest-first.
    let mut jobs: Vec<GlabJob> = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/pipelines/{run_id}/jobs?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabJob>>(&o.stdout_lossy()).ok())
    .unwrap_or_default();
    jobs.reverse();

    // Prefer the commit subject (free, from the jobs) for the header; else the
    // pipeline name; else a stable "#iid".
    let commit_title = jobs
        .iter()
        .find_map(|j| j.commit.as_ref())
        .map(|c| c.title.clone())
        .filter(|t| !t.is_empty());
    let name = p.name.clone().unwrap_or_default();
    let display_title = commit_title
        .or_else(|| (!name.is_empty()).then_some(name))
        .unwrap_or_else(|| format!("Pipeline #{}", p.iid));

    let (status, conclusion) = map_ci_status(&p.status);
    let workflow_name = friendly_source(&p.source);
    Ok(RunDetail {
        id: p.id,
        number: p.iid,
        display_title,
        status,
        conclusion,
        workflow_name,
        head_branch: p.git_ref,
        event: p.source,
        created_at: p.created_at,
        url: p.web_url,
        head_sha: p.sha,
        jobs: jobs.into_iter().map(from_glab_job).collect(),
    })
}

/// One job's log (`/jobs/<id>/trace`), cleaned of ANSI + section markers, tail-capped.
pub async fn job_logs(repo_path: &str, job_id: u64) -> AppResult<String> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/jobs/{job_id}/trace")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let text = clean_trace(&out.stdout_lossy());
    let text = if text.trim().is_empty() {
        "This job produced no log output.".to_string()
    } else {
        text
    };
    Ok(tail_cap(text, CI_JOB_LOG_CAP))
}

/// The failed jobs' logs for a pipeline, concatenated — GitLab's analogue of
/// `gh run view --log-failed` (which GitLab has no single endpoint for).
pub async fn run_failed_logs(repo_path: &str, run_id: u64) -> AppResult<String> {
    let enc = encode_project(&project_path(repo_path).await?);
    let jobs: Vec<GlabJob> = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/pipelines/{run_id}/jobs?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabJob>>(&o.stdout_lossy()).ok())
    .unwrap_or_default();
    let failed: Vec<&GlabJob> = jobs.iter().filter(|j| j.status == "failed").collect();
    if failed.is_empty() {
        return Ok("No failed jobs in this pipeline.".to_string());
    }
    let mut text = String::new();
    for job in failed {
        if text.len() > CI_RUN_LOG_CAP {
            break;
        }
        let trace = run_glab(
            Some(repo_path),
            &["api", &format!("projects/{enc}/jobs/{}/trace", job.id)],
            GLAB_NETWORK_TIMEOUT,
        )
        .await
        .map(|o| clean_trace(&o.stdout_lossy()))
        .unwrap_or_default();
        text.push_str(&format!("===== {} =====\n", job.name));
        text.push_str(trace.trim_end());
        text.push_str("\n\n");
    }
    Ok(tail_cap(text, CI_RUN_LOG_CAP))
}

/// Retry a pipeline (`run_id` is the global pipeline id the runs list carries).
/// GitLab restarts the failed + canceled jobs of the pipeline — the analogue of
/// GitHub's "re-run failed jobs"; a full re-run of an existing pipeline doesn't
/// exist on GitLab (a *new* pipeline on the ref is a different thing).
pub async fn retry_run(repo_path: &str, run_id: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/pipelines/{run_id}/retry");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Cancel an in-flight pipeline. (GitLab treats cancel on an already-finished
/// pipeline as a no-op 200, so a stale view can't error here.)
pub async fn cancel_run(repo_path: &str, run_id: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/pipelines/{run_id}/cancel");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Play (start) a manual CI job — a pipeline job configured `when: manual`. The
/// job id is GitLab's global job id (from the run's job list), not an iid. A
/// non-manual (already-started) job → HTTP 400 "Unplayable Job", which `run_glab`
/// surfaces as an error (glab exits non-zero), so no body-sniffing is needed.
pub async fn play_job(repo_path: &str, job_id: u64) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/jobs/{job_id}/play");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// A CI/CD variable key must be a valid env-var name. The `key:value` token
/// `glab ci run --variables-env` takes splits on the FIRST colon, so anything
/// beyond `[A-Za-z_][A-Za-z0-9_]*` (a colon especially) would corrupt the value.
fn valid_variable_key(k: &str) -> bool {
    !k.is_empty()
        && !k.starts_with(|c: char| c.is_ascii_digit())
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// One `--variables` token: glab reads the flag's value through a CSV reader
/// (pflag StringSlice), so a bare comma in a VALUE would split it into bogus
/// extra `key:value` entries — silently corrupting the variables. A fully
/// CSV-quoted field (embedded quotes doubled) passes commas and quotes through
/// intact (validated live: `"REGIONS:a,b"` → one variable `a,b`).
fn variable_token(key: &str, value: &str) -> String {
    format!("\"{key}:{}\"", value.replace('"', "\"\""))
}

/// Manually run a new pipeline on a ref — GitLab's analogue of a workflow
/// dispatch. `variables` become CI/CD env variables via `glab ci run`'s
/// `--variables key:value` tokens, CSV-quoted (see [`variable_token`]) — the
/// REST `variables[]` array form doesn't survive glab's `-f` field encoding, so
/// the purpose-built subcommand is the safe path.
pub async fn run_pipeline(
    repo_path: &str,
    git_ref: &str,
    variables: &HashMap<String, String>,
) -> AppResult<()> {
    if git_ref.is_empty() || git_ref.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid ref: {git_ref}")));
    }
    let mut args: Vec<String> = vec!["ci".into(), "run".into(), "-b".into(), git_ref.into()];
    for (k, v) in variables {
        if !valid_variable_key(k) {
            return Err(AppError::InvalidArgument(format!(
                "invalid variable name: {k} (letters, digits and _ only)"
            )));
        }
        args.push("--variables".into());
        args.push(variable_token(k, v));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_glab(Some(repo_path), &arg_refs, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

// ── Releases (read) ───────────────────────────────────────────────────────────
//
// GitLab releases map onto the same neutral `ReleaseInfo`/`ReleaseDetails` the
// GitHub Tags panel renders, so the frontend stays provider-agnostic. The two
// models differ in a few ways we bridge here:
//   • GitLab has no draft or prerelease concept — both map to `false`.
//   • GitLab has no per-release "latest" flag; the list comes back `released_at`-
//     desc, so the newest non-upcoming release is GitLab's own "latest" — we mark
//     just that one.
//   • The release web URL is `_links.self` (not a top-level `web_url` like MRs).
//   • GitLab release assets are `links` (named URLs, no size/download count) plus
//     auto-generated source archives; we surface only the user `links` — mirroring
//     `gh`, which likewise omits source archives — with size/downloads 0, so the
//     UI renders them as plain external links, not downloadable binaries.
// Writes (create / edit / delete / asset upload+delete) live at the end of this
// section; the GitHub-only draft / prerelease / latest toggles are dropped by the
// forge dispatch before reaching here.

#[derive(Deserialize)]
struct GlabReleaseAuthor {
    #[serde(default)]
    username: String,
}

/// One user-attached release asset link (`assets.links[]`). GitLab also returns
/// `direct_asset_url` (resolves through the project) — prefer it over the raw `url`.
#[derive(Deserialize)]
struct GlabReleaseLink {
    #[serde(default)]
    name: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    direct_asset_url: String,
}

#[derive(Deserialize, Default)]
struct GlabReleaseAssets {
    #[serde(default, deserialize_with = "null_to_default")]
    links: Vec<GlabReleaseLink>,
}

/// The `_links` block — we only need the release's own web URL (`self`).
#[derive(Deserialize, Default)]
struct GlabReleaseSelfLink {
    #[serde(rename = "self", default)]
    self_url: String,
}

/// A release as `glab api …/releases[/<tag>]` returns it (list + detail share one
/// shape). `description` is the markdown body; `released_at` is the publish time.
#[derive(Deserialize)]
struct GlabRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
    #[serde(default)]
    released_at: String,
    #[serde(default)]
    created_at: String,
    /// A release scheduled for a future `released_at` (GitLab's nearest thing to an
    /// unpublished state); it's still listed, and is never the "latest".
    #[serde(default)]
    upcoming_release: bool,
    #[serde(default)]
    author: Option<GlabReleaseAuthor>,
    #[serde(default, deserialize_with = "null_to_default")]
    assets: GlabReleaseAssets,
    #[serde(rename = "_links", default, deserialize_with = "null_to_default")]
    links: GlabReleaseSelfLink,
}

fn from_glab_release_link(l: GlabReleaseLink) -> ReleaseAsset {
    ReleaseAsset {
        name: l.name,
        // GitLab asset links carry no size or download count.
        size: 0,
        download_count: 0,
        url: if l.direct_asset_url.is_empty() {
            l.url
        } else {
            l.direct_asset_url
        },
    }
}

/// The release's publish time — `released_at`, falling back to `created_at`.
fn release_published_at(r: &GlabRelease) -> String {
    if r.released_at.is_empty() {
        r.created_at.clone()
    } else {
        r.released_at.clone()
    }
}

/// Map a GitLab release onto the neutral list-row `ReleaseInfo`. `is_latest` is
/// decided by the caller (the newest non-upcoming release) since GitLab has no
/// per-release latest flag.
fn release_info(r: &GlabRelease, is_latest: bool) -> ReleaseInfo {
    ReleaseInfo {
        tag_name: r.tag_name.clone(),
        name: r.name.clone(),
        // GitLab has neither draft nor prerelease releases.
        is_draft: false,
        is_prerelease: false,
        is_latest,
        published_at: release_published_at(r),
    }
}

/// Mark the newest non-upcoming release "latest". GitLab returns releases
/// `released_at`-desc, so the first non-upcoming entry is GitLab's own default
/// "latest" — every other row (and any upcoming ones) stays non-latest.
fn releases_to_infos(releases: &[GlabRelease]) -> Vec<ReleaseInfo> {
    let latest_idx = releases.iter().position(|r| !r.upcoming_release);
    releases
        .iter()
        .enumerate()
        .map(|(i, r)| release_info(r, Some(i) == latest_idx))
        .collect()
}

/// Map a GitLab release onto the neutral detail `ReleaseDetails`.
fn release_details(r: GlabRelease) -> ReleaseDetails {
    let published_at = release_published_at(&r);
    ReleaseDetails {
        tag_name: r.tag_name,
        name: r.name,
        body: r.description,
        author: r.author.map(|a| a.username).unwrap_or_default(),
        published_at,
        is_draft: false,
        is_prerelease: false,
        // GitLab releases have no GitHub-style "target commitish" the read view acts
        // on (the tag's commit is implicit); leave empty (display-only on GitHub).
        target_commitish: String::new(),
        url: r.links.self_url,
        assets: r
            .assets
            .links
            .into_iter()
            .map(from_glab_release_link)
            .collect(),
    }
}

/// The repo's releases for the Tags panel (newest first), capped at 100 to match
/// the GitHub path (`gh release list --limit 100`).
pub async fn list_releases(repo_path: &str) -> AppResult<Vec<ReleaseInfo>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/releases?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let releases: Vec<GlabRelease> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab releases: {e}")))?;
    Ok(releases_to_infos(&releases))
}

/// Full read view of one release, by its tag, mapped onto `ReleaseDetails`.
pub async fn view_release(repo_path: &str, tag: &str) -> AppResult<ReleaseDetails> {
    if tag.is_empty() {
        return Err(AppError::InvalidArgument("a tag is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    // The tag is a single path segment — percent-encode it so a `/` in a tag like
    // `release/1.0` (or any query-significant byte) can't break the endpoint path.
    let enc_tag = encode_query_value(tag);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/releases/{enc_tag}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let r: GlabRelease = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab release: {e}")))?;
    Ok(release_details(r))
}

/// Publish a release; returns its web URL (`_links.self`). `target` is the ref to
/// create the tag from when the tag doesn't exist yet — the dialog only sends it
/// for a brand-new tag, and GitLab requires it then (a clear server error surfaces
/// if it's missing). Empty title/notes are simply omitted, mirroring the gh path.
pub async fn create_release(
    repo_path: &str,
    tag: &str,
    title: &str,
    notes: &str,
    target: &str,
) -> AppResult<String> {
    if tag.is_empty() || tag.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid tag: {tag}")));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/releases");
    let mut args: Vec<String> = vec![
        "api".into(),
        "--method".into(),
        "POST".into(),
        endpoint,
        "-f".into(),
        format!("tag_name={tag}"),
    ];
    if !target.trim().is_empty() {
        args.push("-f".into());
        args.push(format!("ref={}", target.trim()));
    }
    if !title.trim().is_empty() {
        args.push("-f".into());
        args.push(format!("name={}", title.trim()));
    }
    if !notes.trim().is_empty() {
        args.push("-f".into());
        args.push(format!("description={notes}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_glab(Some(repo_path), &arg_refs, GLAB_NETWORK_TIMEOUT).await?;
    let r: GlabRelease = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse created GitLab release: {e}")))?;
    Ok(r.links.self_url)
}

/// Edit a release's title and/or notes. Empty fields are left unchanged (the gh
/// path likewise only passes non-empty `--title`/`--notes`); when both are empty
/// there's nothing to send, so it's a no-op.
pub async fn edit_release(repo_path: &str, tag: &str, title: &str, notes: &str) -> AppResult<()> {
    if tag.is_empty() {
        return Err(AppError::InvalidArgument("a tag is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let enc_tag = encode_query_value(tag);
    let endpoint = format!("projects/{enc}/releases/{enc_tag}");
    let mut args: Vec<String> = vec!["api".into(), "--method".into(), "PUT".into(), endpoint];
    if !title.trim().is_empty() {
        args.push("-f".into());
        args.push(format!("name={}", title.trim()));
    }
    if !notes.trim().is_empty() {
        args.push("-f".into());
        args.push(format!("description={notes}"));
    }
    if args.len() == 4 {
        return Ok(());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_glab(Some(repo_path), &arg_refs, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Delete a release; `cleanup_tag` also deletes the git tag afterwards (mirroring
/// `gh release delete --cleanup-tag` — GitLab's release delete never touches the tag).
pub async fn delete_release(repo_path: &str, tag: &str, cleanup_tag: bool) -> AppResult<()> {
    if tag.is_empty() {
        return Err(AppError::InvalidArgument("a tag is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let enc_tag = encode_query_value(tag);
    let endpoint = format!("projects/{enc}/releases/{enc_tag}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    if cleanup_tag {
        let tag_endpoint = format!("projects/{enc}/repository/tags/{enc_tag}");
        run_glab(
            Some(repo_path),
            &["api", "--method", "DELETE", &tag_endpoint],
            GLAB_NETWORK_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

/// Upload a file as a release asset via `glab release upload` — it uploads to the
/// project and attaches an asset link named after the file, with a direct download
/// URL. glab parses `#` in the file argument as its display-name separator
/// (`file#name#type`), so a `#`-bearing path can't be passed unambiguously — reject
/// it rather than upload under a mangled name.
pub async fn upload_release_asset(repo_path: &str, tag: &str, file_path: &str) -> AppResult<()> {
    if tag.is_empty() || tag.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid tag: {tag}")));
    }
    if file_path.is_empty() || file_path.starts_with('-') {
        return Err(AppError::InvalidArgument("a file is required".into()));
    }
    if file_path.contains('#') {
        return Err(AppError::InvalidArgument(
            "GitLab uploads can't handle a '#' in the file path — rename or move the file first."
                .into(),
        ));
    }
    run_glab(
        Some(repo_path),
        &["release", "upload", tag, file_path],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Delete a release asset link by its display name. GitLab keys links by a
/// server-side id, so resolve the name against the release's links first; a
/// missing name errors (the view may be stale) rather than deleting the wrong link.
pub async fn delete_release_asset(repo_path: &str, tag: &str, asset_name: &str) -> AppResult<()> {
    #[derive(Deserialize)]
    struct Link {
        id: u64,
        #[serde(default)]
        name: String,
    }
    if tag.is_empty() {
        return Err(AppError::InvalidArgument("a tag is required".into()));
    }
    if asset_name.is_empty() {
        return Err(AppError::InvalidArgument("an asset name is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let enc_tag = encode_query_value(tag);
    let list_endpoint = format!("projects/{enc}/releases/{enc_tag}/assets/links");
    let out = run_glab(
        Some(repo_path),
        &["api", &list_endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let links: Vec<Link> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab release assets: {e}")))?;
    let link = links
        .into_iter()
        .find(|l| l.name == asset_name)
        .ok_or_else(|| AppError::Glab(format!("no release asset named {asset_name}")))?;
    let del_endpoint = format!("projects/{enc}/releases/{enc_tag}/assets/links/{}", link.id);
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &del_endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Repository settings & lifecycle ──────────────────────────────────────────
//
// The project-settings surface (`GET/PUT projects/:id` + the lifecycle
// endpoints), all validated live. GitLab's settings model differs from
// GitHub's where it matters — per-feature ACCESS LEVELS (enabled / private /
// disabled) instead of has_* booleans, one `merge_method` enum instead of
// three allow-flags, a `squash_option` enum — so it travels as its own
// `GitLabRepoSettings` shape and the frontend renders a GitLab-shaped General
// section, rather than forcing a lossy mapping onto the GitHub types. The
// lifecycle actions (rename/archive/visibility/transfer/delete) DO share
// GitHub's parameter shapes and dispatch behind neutral `forge_repo_*`
// commands.

/// The viewer's effective access to this project, from `permissions` on the
/// project read: the max of the direct project grant and the inherited group
/// grant. 40 = Maintainer (can edit settings), 50 = Owner (can transfer /
/// delete / archive).
#[derive(Deserialize)]
struct GlabPermissions {
    #[serde(default, deserialize_with = "null_to_default")]
    project_access: Option<GlabAccessLevel>,
    #[serde(default, deserialize_with = "null_to_default")]
    group_access: Option<GlabAccessLevel>,
}

#[derive(Deserialize, Default)]
struct GlabAccessLevel {
    #[serde(default)]
    access_level: u8,
}

#[derive(Deserialize)]
struct GlabProjectPermissions {
    #[serde(default, deserialize_with = "null_to_default")]
    permissions: Option<GlabPermissions>,
}

/// Whether the signed-in viewer can manage this project's settings
/// (Maintainer+) and whether they hold the Owner-only lifecycle powers.
pub async fn repo_admin(repo_path: &str) -> AppResult<(bool, bool)> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let p: GlabProjectPermissions = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab project: {e}")))?;
    let mut level = p
        .permissions
        .map(|perms| {
            let project = perms.project_access.map_or(0, |a| a.access_level);
            let group = perms.group_access.map_or(0, |a| a.access_level);
            project.max(group)
        })
        .unwrap_or(0);
    // `permissions` only reflects a direct project/namespace-group grant —
    // access inherited from an ancestor group or an invited group reads as
    // null/null. Before concluding the viewer can't manage, ask the
    // effective-membership endpoint (a 404 there = genuinely not a member).
    if level < 40 {
        if let Ok(user) = current_user(repo_path).await {
            let endpoint = format!("projects/{enc}/members/all/{}", user.id);
            if let Ok(out) =
                run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await
            {
                if let Ok(m) = serde_json::from_str::<GlabAccessLevel>(&out.stdout_lossy()) {
                    level = level.max(m.access_level);
                }
            }
        }
    }
    Ok((level >= 40, level >= 50))
}

/// The GitLab project settings the app manages, as the frontend consumes them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabRepoSettings {
    pub description: Option<String>,
    pub topics: Vec<String>,
    pub default_branch: Option<String>,
    /// "private" / "internal" / "public" (read-only here; changed in Danger zone).
    pub visibility: String,
    pub web_url: String,
    /// The full path ("group/name") — the Danger-zone confirm phrase.
    pub full_name: String,
    /// The URL slug (what a rename edits).
    pub path: String,
    /// The display name.
    pub name: String,
    pub archived: bool,
    /// Feature access levels: "enabled" / "private" (members only) / "disabled".
    pub issues_access_level: String,
    pub merge_requests_access_level: String,
    pub wiki_access_level: String,
    pub snippets_access_level: String,
    pub forking_access_level: String,
    /// "merge" / "rebase_merge" (semi-linear) / "ff".
    pub merge_method: String,
    /// "never" / "always" / "default_on" / "default_off".
    pub squash_option: String,
    pub remove_source_branch_after_merge: bool,
    pub only_allow_merge_if_pipeline_succeeds: bool,
    pub only_allow_merge_if_all_discussions_are_resolved: bool,
}

/// The raw project read for the settings surface. Optional scalars ride
/// `null_to_default` — GitLab nulls fields (e.g. `remove_source_branch_after_merge`)
/// rather than omitting them.
#[derive(Deserialize)]
struct GlabProjectSettings {
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    topics: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    default_branch: String,
    #[serde(default, deserialize_with = "null_to_default")]
    visibility: String,
    #[serde(default, deserialize_with = "null_to_default")]
    web_url: String,
    #[serde(default, deserialize_with = "null_to_default")]
    path_with_namespace: String,
    #[serde(default, deserialize_with = "null_to_default")]
    path: String,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    archived: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    issues_access_level: String,
    #[serde(default, deserialize_with = "null_to_default")]
    merge_requests_access_level: String,
    #[serde(default, deserialize_with = "null_to_default")]
    wiki_access_level: String,
    #[serde(default, deserialize_with = "null_to_default")]
    snippets_access_level: String,
    #[serde(default, deserialize_with = "null_to_default")]
    forking_access_level: String,
    #[serde(default, deserialize_with = "null_to_default")]
    merge_method: String,
    #[serde(default, deserialize_with = "null_to_default")]
    squash_option: String,
    #[serde(default, deserialize_with = "null_to_default")]
    remove_source_branch_after_merge: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    only_allow_merge_if_pipeline_succeeds: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    only_allow_merge_if_all_discussions_are_resolved: bool,
}

fn settings_from_project(p: GlabProjectSettings) -> GitLabRepoSettings {
    GitLabRepoSettings {
        description: (!p.description.is_empty()).then_some(p.description),
        topics: p.topics,
        default_branch: (!p.default_branch.is_empty()).then_some(p.default_branch),
        visibility: p.visibility,
        web_url: p.web_url,
        full_name: p.path_with_namespace,
        path: p.path,
        name: p.name,
        archived: p.archived,
        issues_access_level: p.issues_access_level,
        merge_requests_access_level: p.merge_requests_access_level,
        wiki_access_level: p.wiki_access_level,
        snippets_access_level: p.snippets_access_level,
        forking_access_level: p.forking_access_level,
        merge_method: p.merge_method,
        squash_option: p.squash_option,
        remove_source_branch_after_merge: p.remove_source_branch_after_merge,
        only_allow_merge_if_pipeline_succeeds: p.only_allow_merge_if_pipeline_succeeds,
        only_allow_merge_if_all_discussions_are_resolved: p
            .only_allow_merge_if_all_discussions_are_resolved,
    }
}

pub async fn repo_settings(repo_path: &str) -> AppResult<GitLabRepoSettings> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let p: GlabProjectSettings = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab project: {e}")))?;
    Ok(settings_from_project(p))
}

/// The settings the frontend sends back (everything the form manages).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabRepoSettingsInput {
    pub description: String,
    pub topics: Vec<String>,
    pub default_branch: Option<String>,
    pub issues_access_level: String,
    pub merge_requests_access_level: String,
    pub wiki_access_level: String,
    pub snippets_access_level: String,
    pub forking_access_level: String,
    pub merge_method: String,
    pub squash_option: String,
    pub remove_source_branch_after_merge: bool,
    pub only_allow_merge_if_pipeline_succeeds: bool,
    pub only_allow_merge_if_all_discussions_are_resolved: bool,
}

const ACCESS_LEVELS: [&str; 3] = ["enabled", "private", "disabled"];
const MERGE_METHODS: [&str; 3] = ["merge", "rebase_merge", "ff"];
const SQUASH_OPTIONS: [&str; 4] = ["never", "always", "default_on", "default_off"];

/// Batch-save the managed settings via one `PUT projects/:id` (topics ride the
/// same PUT as a comma-joined list — validated live). Enum fields are checked
/// here so a UI regression can't send GitLab a 400 with a cryptic message.
pub async fn update_repo_settings(
    repo_path: &str,
    input: GitLabRepoSettingsInput,
) -> AppResult<GitLabRepoSettings> {
    for (field, value, allowed) in [
        (
            "issues",
            &input.issues_access_level,
            &ACCESS_LEVELS[..],
        ),
        (
            "merge requests",
            &input.merge_requests_access_level,
            &ACCESS_LEVELS[..],
        ),
        ("wiki", &input.wiki_access_level, &ACCESS_LEVELS[..]),
        (
            "snippets",
            &input.snippets_access_level,
            &ACCESS_LEVELS[..],
        ),
        (
            "forking",
            &input.forking_access_level,
            &ACCESS_LEVELS[..],
        ),
        ("merge method", &input.merge_method, &MERGE_METHODS[..]),
        ("squash option", &input.squash_option, &SQUASH_OPTIONS[..]),
    ] {
        if !allowed.contains(&value.as_str()) {
            return Err(AppError::InvalidArgument(format!(
                "invalid {field} setting: {value}"
            )));
        }
    }
    // GitLab topics may contain spaces; only commas separate them.
    if input.topics.iter().any(|t| t.contains(',')) {
        return Err(AppError::InvalidArgument(
            "topics must not contain commas".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}");
    let description = format!("description={}", input.description);
    let topics = format!("topics={}", input.topics.join(","));
    let issues = format!("issues_access_level={}", input.issues_access_level);
    let mrs = format!(
        "merge_requests_access_level={}",
        input.merge_requests_access_level
    );
    let wiki = format!("wiki_access_level={}", input.wiki_access_level);
    let snippets = format!("snippets_access_level={}", input.snippets_access_level);
    let forking = format!("forking_access_level={}", input.forking_access_level);
    let merge_method = format!("merge_method={}", input.merge_method);
    let squash = format!("squash_option={}", input.squash_option);
    let remove_source = format!(
        "remove_source_branch_after_merge={}",
        input.remove_source_branch_after_merge
    );
    let pipeline = format!(
        "only_allow_merge_if_pipeline_succeeds={}",
        input.only_allow_merge_if_pipeline_succeeds
    );
    let discussions = format!(
        "only_allow_merge_if_all_discussions_are_resolved={}",
        input.only_allow_merge_if_all_discussions_are_resolved
    );
    let mut args: Vec<&str> = vec!["api", "--method", "PUT", &endpoint];
    for arg in [
        &description,
        &topics,
        &issues,
        &mrs,
        &wiki,
        &snippets,
        &forking,
        &merge_method,
        &squash,
        &remove_source,
        &pipeline,
        &discussions,
    ] {
        args.push("-f");
        args.push(arg);
    }
    // Only send a default branch when one is chosen (an empty project has none).
    let default_branch = input
        .default_branch
        .as_deref()
        .map(|b| format!("default_branch={b}"));
    if let Some(db) = &default_branch {
        args.push("-f");
        args.push(db);
    }
    let out = run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    let p: GlabProjectSettings = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the updated project: {e}")))?;
    Ok(settings_from_project(p))
}

/// Rename the project: both the display name and the URL slug, so the app and
/// the web agree (GitLab redirects the old path). Validated live.
pub async fn rename_repo(repo_path: &str, new_name: &str) -> AppResult<()> {
    let new_name = new_name.trim();
    // GitLab paths: alphanumeric start, then letters/digits/`.`/`-`/`_`.
    let valid = new_name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && new_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !valid {
        return Err(AppError::InvalidArgument(
            "project names must start with a letter or digit and use only letters, digits, '.', '-' or '_'".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}");
    let name_arg = format!("name={new_name}");
    let path_arg = format!("path={new_name}");
    run_glab(
        Some(repo_path),
        &[
            "api", "--method", "PUT", &endpoint, "-f", &name_arg, "-f", &path_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Archive / unarchive the project (their own POST endpoints, not a PUT field).
/// Validated live.
pub async fn set_archived(repo_path: &str, archived: bool) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let action = if archived { "archive" } else { "unarchive" };
    let endpoint = format!("projects/{enc}/{action}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Change the project's visibility ("private" / "internal" / "public").
/// Validated live. gitlab.com restricts "internal" to legacy namespaces — that
/// error surfaces as-is.
pub async fn set_visibility(repo_path: &str, visibility: &str) -> AppResult<()> {
    if !matches!(visibility, "private" | "internal" | "public") {
        return Err(AppError::InvalidArgument(format!(
            "unknown visibility: {visibility}"
        )));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}");
    let vis_arg = format!("visibility={visibility}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &vis_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Transfer the project to another namespace (a group path or username the
/// viewer controls). Owner-only, enforced server-side.
pub async fn transfer_repo(repo_path: &str, namespace: &str) -> AppResult<()> {
    let namespace = namespace.trim().trim_matches('/');
    if namespace.is_empty() || namespace.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "a destination namespace is required".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let ns = encode_query_value(namespace);
    let endpoint = format!("projects/{enc}/transfer?namespace={ns}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Permanently delete the project. Owner-only, enforced server-side; on
/// gitlab.com the deletion may be scheduled (delayed) rather than immediate.
pub async fn delete_repo(repo_path: &str) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Members ──────────────────────────────────────────────────────────────────
//
// The GitLab analogue of GitHub collaborators. Numeric access levels
// (10 Guest … 50 Owner) instead of role names; a member can be DIRECT (added
// on this project — editable here) or INHERITED from a group (read-only here).
// Reads cap at 100 per list (the settings dialog's working range).

/// A project member for the Members section. `id` is the GitLab user id, as a
/// string (large ints don't survive the JS IPC boundary).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMember {
    pub id: String,
    pub username: String,
    pub avatar_url: String,
    /// 10 Guest / 15 Planner / 20 Reporter / 30 Developer / 40 Maintainer / 50 Owner.
    pub access_level: u8,
    /// Added on this project directly (editable) vs inherited from a group.
    pub direct: bool,
}

#[derive(Deserialize)]
struct GlabProjectMember {
    id: u64,
    username: String,
    #[serde(default, deserialize_with = "null_to_default")]
    avatar_url: String,
    #[serde(default)]
    access_level: u8,
}

/// All pages of a members endpoint (capped at 10 × 100 — misclassifying a
/// direct member past page 1 as inherited would hide their edit controls, so
/// this can't ride a single-page read).
async fn member_pages(repo_path: &str, enc: &str, path: &str) -> AppResult<Vec<GlabProjectMember>> {
    let mut members = Vec::new();
    for page in 1..=10 {
        let endpoint = format!("projects/{enc}/{path}?per_page=100&page={page}");
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let batch: Vec<GlabProjectMember> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse GitLab members: {e}")))?;
        let done = batch.len() < 100;
        members.extend(batch);
        if done {
            break;
        }
    }
    Ok(members)
}

/// All members (direct + inherited), with direct ones flagged editable. A user
/// can be BOTH direct and inherited — `members/all` reports their highest
/// level, but edits target the direct membership, so direct rows carry the
/// DIRECT record's level (what a re-role actually changes).
pub async fn list_members(repo_path: &str) -> AppResult<Vec<GitLabMember>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let all = member_pages(repo_path, &enc, "members/all").await?;
    let direct = member_pages(repo_path, &enc, "members").await?;
    let direct_levels: std::collections::HashMap<u64, u8> =
        direct.iter().map(|m| (m.id, m.access_level)).collect();
    Ok(all
        .into_iter()
        .map(|m| {
            let direct_level = direct_levels.get(&m.id).copied();
            GitLabMember {
                direct: direct_level.is_some(),
                id: m.id.to_string(),
                username: m.username,
                avatar_url: m.avatar_url,
                access_level: direct_level.unwrap_or(m.access_level),
            }
        })
        .collect())
}

/// The access levels the app offers (the classic five — Planner is newer and
/// not accepted by older self-managed instances).
fn validate_access_level(level: u8) -> AppResult<()> {
    if !matches!(level, 10 | 20 | 30 | 40 | 50) {
        return Err(AppError::InvalidArgument(format!(
            "unknown access level: {level}"
        )));
    }
    Ok(())
}

/// Add a member by username: resolve the user id (exact username match), then
/// POST the membership. GitLab has no pending-invitation state for existing
/// users — the grant is immediate.
pub async fn add_member(repo_path: &str, username: &str, access_level: u8) -> AppResult<()> {
    let username = username.trim();
    if username.is_empty() || username.starts_with('-') {
        return Err(AppError::InvalidArgument("a username is required".into()));
    }
    validate_access_level(access_level)?;
    let user_q = encode_query_value(username);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("users?username={user_q}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    #[derive(Deserialize)]
    struct GlabUser {
        id: u64,
        username: String,
    }
    let users: Vec<GlabUser> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab user lookup: {e}")))?;
    let user = users
        .into_iter()
        .find(|u| u.username.eq_ignore_ascii_case(username))
        .ok_or_else(|| AppError::Glab(format!("no GitLab user named {username}")))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/members");
    let user_arg = format!("user_id={}", user.id);
    let level_arg = format!("access_level={access_level}");
    run_glab(
        Some(repo_path),
        &[
            "api", "--method", "POST", &endpoint, "-f", &user_arg, "-f", &level_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Change a direct member's access level.
pub async fn update_member(repo_path: &str, user_id: &str, access_level: u8) -> AppResult<()> {
    let user_id: u64 = user_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid member id".into()))?;
    validate_access_level(access_level)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/members/{user_id}");
    let level_arg = format!("access_level={access_level}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &level_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Remove a direct member from the project.
pub async fn remove_member(repo_path: &str, user_id: &str) -> AppResult<()> {
    let user_id: u64 = user_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid member id".into()))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/members/{user_id}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
//
// Project hooks (`projects/:id/hooks`), all validated live. GitLab models
// events as per-hook boolean flags (no "send everything"); the secret token is
// write-only (never returned); a failing hook gets auto-disabled and reports it
// via `alert_status`. Delivery history is `hooks/:id/events` (request/response
// inline — no separate detail read), with a per-event resend.

/// The hook event flags the app manages, in display order.
const HOOK_EVENTS: [&str; 10] = [
    "push_events",
    "tag_push_events",
    "issues_events",
    "merge_requests_events",
    "note_events",
    "pipeline_events",
    "job_events",
    "wiki_page_events",
    "releases_events",
    "deployment_events",
];

/// A project webhook as the frontend renders it. `id` as a string (IPC).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabHook {
    pub id: String,
    pub url: String,
    /// The enabled event flags (the `HOOK_EVENTS` names).
    pub events: Vec<String>,
    pub enable_ssl_verification: bool,
    /// "executable", or "disabled"/"temporarily_disabled" once GitLab
    /// auto-disables a failing hook.
    pub alert_status: String,
    pub created_at: String,
}

fn hook_from_value(v: &serde_json::Value) -> Option<GitLabHook> {
    let id = v.get("id")?.as_u64()?;
    let events = HOOK_EVENTS
        .iter()
        .filter(|e| v.get(**e).and_then(|b| b.as_bool()).unwrap_or(false))
        .map(|e| e.to_string())
        .collect();
    Some(GitLabHook {
        id: id.to_string(),
        url: v.get("url")?.as_str().unwrap_or_default().to_string(),
        events,
        enable_ssl_verification: v
            .get("enable_ssl_verification")
            .and_then(|b| b.as_bool())
            .unwrap_or(true),
        alert_status: v
            .get("alert_status")
            .and_then(|s| s.as_str())
            .unwrap_or("executable")
            .to_string(),
        created_at: v
            .get("created_at")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

pub async fn list_hooks(repo_path: &str) -> AppResult<Vec<GitLabHook>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/hooks?per_page=100")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let hooks: Vec<serde_json::Value> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab webhooks: {e}")))?;
    // Per-item so one malformed hook doesn't sink the list.
    Ok(hooks.iter().filter_map(hook_from_value).collect())
}

/// What the frontend sends for create/update. `token: None` leaves an existing
/// secret unchanged on update (GitLab never returns it, so the form can't).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabHookInput {
    pub url: String,
    pub token: Option<String>,
    pub enable_ssl_verification: bool,
    pub events: Vec<String>,
}

/// The `-f` args shared by hook create/update: url + SSL + every known event
/// flag set explicitly true/false (so unchecking sticks on update).
fn hook_args(input: &GitLabHookInput) -> AppResult<Vec<String>> {
    let url = input.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::InvalidArgument(
            "the payload URL must start with http:// or https://".into(),
        ));
    }
    for e in &input.events {
        if !HOOK_EVENTS.contains(&e.as_str()) {
            return Err(AppError::InvalidArgument(format!(
                "unknown webhook event: {e}"
            )));
        }
    }
    if input.events.is_empty() {
        return Err(AppError::InvalidArgument(
            "select at least one event".into(),
        ));
    }
    let mut args = vec![format!("url={url}")];
    for e in HOOK_EVENTS {
        args.push(format!("{e}={}", input.events.iter().any(|x| x == e)));
    }
    args.push(format!(
        "enable_ssl_verification={}",
        input.enable_ssl_verification
    ));
    if let Some(token) = input.token.as_deref() {
        if !token.is_empty() {
            args.push(format!("token={token}"));
        }
    }
    Ok(args)
}

pub async fn create_hook(repo_path: &str, input: GitLabHookInput) -> AppResult<()> {
    let fields = hook_args(&input)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks");
    let mut args: Vec<&str> = vec!["api", "--method", "POST", &endpoint];
    for f in &fields {
        args.push("-f");
        args.push(f);
    }
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

pub async fn update_hook(repo_path: &str, hook_id: &str, input: GitLabHookInput) -> AppResult<()> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    let fields = hook_args(&input)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}");
    let mut args: Vec<&str> = vec!["api", "--method", "PUT", &endpoint];
    for f in &fields {
        args.push("-f");
        args.push(f);
    }
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

pub async fn delete_hook(repo_path: &str, hook_id: &str) -> AppResult<()> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Fire a test event at the hook. GitLab relays the endpoint's own failure as
/// an HTTP 422 whose body is the endpoint's response — the test FIRED in that
/// case, so it's reported as delivered-but-rejected rather than "test failed"
/// (seen live: a 405 HTML page from the target came back as the 422 message).
pub async fn test_hook(repo_path: &str, hook_id: &str, trigger: &str) -> AppResult<()> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    if !HOOK_EVENTS.contains(&trigger) {
        return Err(AppError::InvalidArgument(format!(
            "unknown webhook trigger: {trigger}"
        )));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}/test/{trigger}");
    match run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(_) => Ok(()),
        // GitLab answers 422 BOTH when the endpoint rejected the delivered
        // event (relaying its response body — the event DID fire) and when the
        // test couldn't fire at all (e.g. "Ensure the project has commits" for
        // a push test on an empty repo). Keep the original message so the
        // could-not-fire causes stay diagnosable, truncated because a relayed
        // body can be a whole HTML page.
        Err(AppError::Glab(msg)) if msg.contains("HTTP 422") => {
            let detail: String = msg.chars().take(200).collect();
            Err(AppError::Glab(format!(
                "GitLab returned an error for the test — if the endpoint itself rejected the \
                 event, it fired and appears in the delivery log. Details: {detail}"
            )))
        }
        Err(e) => Err(e),
    }
}

/// One recorded delivery of a hook (`hooks/:id/events` row). Payloads ride
/// along — GitLab returns them inline, so there's no separate detail read.
/// `id` as a string (11-digit ids are already near JS's comfort zone).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabHookDelivery {
    pub id: String,
    /// e.g. "push_hooks".
    pub trigger: String,
    /// The endpoint's HTTP status ("405") or a failure word ("internal error").
    pub response_status: String,
    pub created_at: String,
    /// Seconds.
    pub duration: f64,
    /// The request body, pretty-printed JSON.
    pub request_payload: String,
    /// The endpoint's response body.
    pub response_payload: String,
}

pub async fn hook_events(repo_path: &str, hook_id: &str) -> AppResult<Vec<GitLabHookDelivery>> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}/events?per_page=20");
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let events: Vec<serde_json::Value> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the delivery log: {e}")))?;
    Ok(events
        .iter()
        .filter_map(|v| {
            Some(GitLabHookDelivery {
                id: v.get("id")?.as_u64()?.to_string(),
                trigger: v
                    .get("trigger")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                response_status: match v.get("response_status") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Number(n)) => n.to_string(),
                    _ => String::new(),
                },
                created_at: v
                    .get("created_at")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
                duration: v
                    .get("execution_duration")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
                request_payload: v
                    .get("request_data")
                    .map(|d| serde_json::to_string_pretty(d).unwrap_or_default())
                    .unwrap_or_default(),
                response_payload: v
                    .get("response_body")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
}

/// Re-deliver one recorded event. Validated live (returns the endpoint's new
/// response status, which the refreshed delivery log shows anyway).
pub async fn hook_event_resend(repo_path: &str, hook_id: &str, event_id: &str) -> AppResult<()> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    let event_id: u64 = event_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid delivery id".into()))?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}/events/{event_id}/resend");
    run_glab(
        Some(repo_path),
        &["api", "--method", "POST", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── CI/CD variables ──────────────────────────────────────────────────────────
//
// Project variables (`projects/:id/variables`), validated live. Unlike GitHub's
// split secrets/variables stores, GitLab has ONE store where `masked` hides a
// value in job logs (the API still returns it to maintainers) and `protected`
// limits it to protected refs. Environment scoping is left at "*" (it's a
// Premium feature).

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabVariable {
    pub key: String,
    pub value: String,
    pub protected: bool,
    pub masked: bool,
    /// "*" for unscoped; a key can repeat with different scopes (a Premium
    /// feature the app displays but doesn't create), so writes filter on it.
    pub environment_scope: String,
}

#[derive(Deserialize)]
struct GlabVariable {
    key: String,
    #[serde(default, deserialize_with = "null_to_default")]
    value: String,
    #[serde(default)]
    protected: bool,
    #[serde(default)]
    masked: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    environment_scope: String,
}

pub async fn list_variables(repo_path: &str) -> AppResult<Vec<GitLabVariable>> {
    let enc = encode_project(&project_path(repo_path).await?);
    // Paginated (10 × 100 cap) — CI-heavy projects legitimately exceed 100
    // variables, and a missing row here would read as "safe to re-create".
    let mut vars: Vec<GlabVariable> = Vec::new();
    for page in 1..=10 {
        let endpoint = format!("projects/{enc}/variables?per_page=100&page={page}");
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let batch: Vec<GlabVariable> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse GitLab variables: {e}")))?;
        let done = batch.len() < 100;
        vars.extend(batch);
        if done {
            break;
        }
    }
    Ok(vars
        .into_iter()
        .map(|v| GitLabVariable {
            key: v.key,
            value: v.value,
            protected: v.protected,
            masked: v.masked,
            environment_scope: if v.environment_scope.is_empty() {
                "*".to_string()
            } else {
                v.environment_scope
            },
        })
        .collect())
}

fn validate_variable_key(key: &str) -> AppResult<()> {
    let valid = !key.is_empty()
        && key.len() <= 255
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return Err(AppError::InvalidArgument(
            "variable keys use only letters, digits, and underscores".into(),
        ));
    }
    Ok(())
}

/// The `filter[environment_scope]` query suffix that disambiguates a key that
/// exists at several scopes (without it, GitLab 409s "There are multiple
/// variables with provided parameters").
fn scope_filter(scope: &str) -> String {
    format!(
        "?filter%5Benvironment_scope%5D={}",
        encode_query_value(scope)
    )
}

/// Create (`create: true`) or update a variable. Split endpoints on GitLab —
/// POST 400s on an existing key, PUT 404s on a missing one — and the form
/// knows which it's doing. Updates address the exact `scope` (a key can exist
/// at several environment scopes); creates land unscoped ("*").
pub async fn set_variable(
    repo_path: &str,
    key: &str,
    value: &str,
    protected: bool,
    masked: bool,
    create: bool,
    scope: &str,
) -> AppResult<()> {
    validate_variable_key(key)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let (method, endpoint) = if create {
        ("POST", format!("projects/{enc}/variables"))
    } else {
        (
            "PUT",
            format!("projects/{enc}/variables/{key}{}", scope_filter(scope)),
        )
    };
    let key_arg = format!("key={key}");
    let value_arg = format!("value={value}");
    let protected_arg = format!("protected={protected}");
    let masked_arg = format!("masked={masked}");
    let mut args = vec!["api", "--method", method, &endpoint, "-f", &value_arg];
    if create {
        args.push("-f");
        args.push(&key_arg);
    }
    args.push("-f");
    args.push(&protected_arg);
    args.push("-f");
    args.push(&masked_arg);
    run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT)
        .await
        .map_err(|e| match e {
            // GitLab enforces maskability server-side (length ≥ 8, one line,
            // Base64-ish alphabet) with a curt 400 — spell it out.
            AppError::Glab(msg) if masked && msg.contains("masked") => AppError::Glab(
                "GitLab can't mask this value — masked values need at least 8 characters on a single line, without most special characters".into(),
            ),
            other => other,
        })?;
    Ok(())
}

pub async fn delete_variable(repo_path: &str, key: &str, scope: &str) -> AppResult<()> {
    validate_variable_key(key)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/variables/{key}{}", scope_filter(scope));
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Protected branches ────────────────────────────────────────────────────────
//
// Project protected branches (`projects/:id/protected_branches`), validated live
// on gitlab.com Free tier. Each protection carries per-action access-level lists
// (push/merge); on Free tier the levels are one of {0 = no one, 30 = developers +
// maintainers, 40 = maintainers}. Only `allow_force_push` is updatable on Free —
// access-level PATCH params are silently ignored — so this package exposes no
// level-editing surface. `unprotect_access_levels` / `code_owner_approval_required`
// are Premium concepts and deliberately not surfaced.

/// One entry in a protection's push/merge access-level list, projected onto the
/// camelCase shape the frontend consumes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabAccessLevelEntry {
    pub access_level: u8,
    /// GitLab's `access_level_description` verbatim (e.g. "Maintainers").
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabProtectedBranch {
    /// Stringified — GitLab ids are large ints that lose precision as JS numbers.
    pub id: String,
    pub name: String,
    pub push_levels: Vec<GitLabAccessLevelEntry>,
    pub merge_levels: Vec<GitLabAccessLevelEntry>,
    pub allow_force_push: bool,
    pub inherited: bool,
}

#[derive(Deserialize)]
struct GlabProtectedAccessLevel {
    #[serde(default)]
    access_level: u8,
    #[serde(default, deserialize_with = "null_to_default")]
    access_level_description: String,
}

#[derive(Deserialize)]
struct GlabProtectedBranch {
    #[serde(default)]
    id: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    push_access_levels: Vec<GlabProtectedAccessLevel>,
    #[serde(default, deserialize_with = "null_to_default")]
    merge_access_levels: Vec<GlabProtectedAccessLevel>,
    #[serde(default, deserialize_with = "null_to_default")]
    allow_force_push: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    inherited: bool,
}

fn map_protected_branch(pb: GlabProtectedBranch) -> GitLabProtectedBranch {
    let map_levels = |levels: Vec<GlabProtectedAccessLevel>| {
        levels
            .into_iter()
            .map(|l| GitLabAccessLevelEntry {
                access_level: l.access_level,
                description: l.access_level_description,
            })
            .collect()
    };
    GitLabProtectedBranch {
        id: pb.id.to_string(),
        name: pb.name,
        push_levels: map_levels(pb.push_access_levels),
        merge_levels: map_levels(pb.merge_access_levels),
        allow_force_push: pb.allow_force_push,
        inherited: pb.inherited,
    }
}

/// A protection's `name` must survive as a single path segment (`update`/`delete`
/// address it in the URL) and can't be blank.
fn validate_branch_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidArgument("branch name can't be empty".into()));
    }
    Ok(())
}

/// Push/merge access levels are constrained to the Free-tier set on create.
fn validate_protected_access_level(level: u8) -> AppResult<()> {
    if !matches!(level, 0 | 30 | 40) {
        return Err(AppError::InvalidArgument(
            "access level must be 0 (no one), 30 (developers + maintainers), or 40 (maintainers)"
                .into(),
        ));
    }
    Ok(())
}

pub async fn list_protected_branches(repo_path: &str) -> AppResult<Vec<GitLabProtectedBranch>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let mut branches: Vec<GlabProtectedBranch> = Vec::new();
    for page in 1..=10 {
        let endpoint = format!("projects/{enc}/protected_branches?per_page=100&page={page}");
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let batch: Vec<GlabProtectedBranch> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| {
                AppError::Glab(format!("could not parse GitLab protected branches: {e}"))
            })?;
        let done = batch.len() < 100;
        branches.extend(batch);
        if done {
            break;
        }
    }
    Ok(branches.into_iter().map(map_protected_branch).collect())
}

/// Protect a branch (or wildcard, e.g. `release/*`). Free tier accepts push/merge
/// levels from {0, 30, 40}. Ignores the 201 body — the list re-fetches.
pub async fn create_protected_branch(
    repo_path: &str,
    name: &str,
    push_access_level: u8,
    merge_access_level: u8,
    allow_force_push: bool,
) -> AppResult<()> {
    validate_branch_name(name)?;
    validate_protected_access_level(push_access_level)?;
    validate_protected_access_level(merge_access_level)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/protected_branches");
    let name_arg = format!("name={name}");
    let push_arg = format!("push_access_level={push_access_level}");
    let merge_arg = format!("merge_access_level={merge_access_level}");
    let force_arg = format!("allow_force_push={allow_force_push}");
    run_glab(
        Some(repo_path),
        &[
            "api", "--method", "POST", &endpoint, "-f", &name_arg, "-f", &push_arg, "-f",
            &merge_arg, "-f", &force_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Update a protection. On Free tier only `allow_force_push` takes effect —
/// access-level params are silently ignored by GitLab, so we don't send them.
pub async fn update_protected_branch(
    repo_path: &str,
    name: &str,
    allow_force_push: bool,
) -> AppResult<()> {
    validate_branch_name(name)?;
    let enc = encode_project(&project_path(repo_path).await?);
    // The name rides the URL as a single path segment — percent-encode it so
    // wildcards (`*`) and `/` in wildcard names survive.
    let endpoint = format!(
        "projects/{enc}/protected_branches/{}",
        encode_query_value(name)
    );
    let force_arg = format!("allow_force_push={allow_force_push}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PATCH", &endpoint, "-f", &force_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

pub async fn delete_protected_branch(repo_path: &str, name: &str) -> AppResult<()> {
    validate_branch_name(name)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!(
        "projects/{enc}/protected_branches/{}",
        encode_query_value(name)
    );
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Time tracking (issues & merge requests) ───────────────────────────────────
//
// GitLab-only: estimate + spent time on issues and MRs, a GitLab-unique surface
// with no GitHub analogue (`time_tracking`). The read (`time_stats`) and both
// writes (`time_estimate`/`add_spent_time`) return the SAME `time_stats` object,
// so every command resolves to a `GitLabTimeStats`. Issue and MR endpoints are
// exactly symmetric under `issues/{n}/…` vs `merge_requests/{n}/…`. Durations are
// GitLab's human strings ("3h", "45m", and even negative "-15m" — passed through;
// the server validates, rejecting bad input with a non-zero exit + message). An
// absent/blank duration routes to the matching reset endpoint. Validated live.

/// The neutral time-tracking stats the frontend renders. GitLab returns
/// `human_*` as `null` when the underlying seconds are zero, so those map to "".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabTimeStats {
    /// Estimated time, in seconds.
    pub time_estimate: u64,
    /// Total time spent, in seconds.
    pub total_time_spent: u64,
    /// GitLab's human-readable estimate ("3h"); "" when the estimate is zero.
    pub human_time_estimate: String,
    /// GitLab's human-readable total spent ("45m"); "" when zero.
    pub human_total_time_spent: String,
}

/// The raw `time_stats` payload GitLab returns from the read and both writes.
/// `human_*` come back `null` when the corresponding seconds are zero, so they're
/// null-tolerant and map onto the empty string.
#[derive(Deserialize)]
struct GlabTimeStats {
    #[serde(default)]
    time_estimate: u64,
    #[serde(default)]
    total_time_spent: u64,
    #[serde(default)]
    human_time_estimate: Option<String>,
    #[serde(default)]
    human_total_time_spent: Option<String>,
}

fn from_glab_time_stats(s: GlabTimeStats) -> GitLabTimeStats {
    GitLabTimeStats {
        time_estimate: s.time_estimate,
        total_time_spent: s.total_time_spent,
        human_time_estimate: s.human_time_estimate.unwrap_or_default(),
        human_total_time_spent: s.human_total_time_spent.unwrap_or_default(),
    }
}

/// Whether a target is an issue or a merge request, for the symmetric endpoints.
#[derive(Clone, Copy)]
enum TimeTarget {
    Issue,
    MergeRequest,
}

impl TimeTarget {
    /// The endpoint path segment (`issues` / `merge_requests`).
    fn segment(self) -> &'static str {
        match self {
            TimeTarget::Issue => "issues",
            TimeTarget::MergeRequest => "merge_requests",
        }
    }
}

/// Which time-tracking write action — set an estimate vs. add spent time. Pairs
/// each with its reset counterpart so [`time_write_endpoint`] can route a blank
/// duration to the reset endpoint (see the duration→endpoint routing rule).
#[derive(Clone, Copy)]
enum TimeWrite {
    Estimate,
    Spent,
}

/// Route a time-tracking write to its endpoint suffix based on the duration: a
/// non-empty (trimmed) duration hits the set/add endpoint; a `None` or
/// blank/whitespace-only duration hits the reset endpoint. Pure — unit-tested.
fn time_write_endpoint(action: TimeWrite, duration: Option<&str>) -> &'static str {
    let has_duration = duration.map(|d| !d.trim().is_empty()).unwrap_or(false);
    match (action, has_duration) {
        (TimeWrite::Estimate, true) => "time_estimate",
        (TimeWrite::Estimate, false) => "reset_time_estimate",
        (TimeWrite::Spent, true) => "add_spent_time",
        (TimeWrite::Spent, false) => "reset_spent_time",
    }
}

/// Read a target's time-tracking stats (`GET …/{target}/{n}/time_stats`).
async fn time_stats(
    repo_path: &str,
    target: TimeTarget,
    number: u64,
) -> AppResult<GitLabTimeStats> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/{}/{number}/time_stats", target.segment());
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let s: GlabTimeStats = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab time stats: {e}")))?;
    Ok(from_glab_time_stats(s))
}

/// Apply a time-tracking write (set estimate / add spent — or their reset when
/// `duration` is blank) and return the updated stats. The set/add endpoints take
/// a raw `-f duration=…` field; the reset endpoints take none.
async fn write_time(
    repo_path: &str,
    target: TimeTarget,
    number: u64,
    action: TimeWrite,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    let enc = encode_project(&project_path(repo_path).await?);
    let suffix = time_write_endpoint(action, duration);
    let endpoint = format!("projects/{enc}/{}/{number}/{suffix}", target.segment());
    let is_reset = suffix.starts_with("reset_");
    let mut args = vec!["api", "--method", "POST", &endpoint];
    let duration_arg;
    if !is_reset {
        // Non-empty by construction (blank routed to reset above); trim so a
        // padded value doesn't reach the server verbatim.
        duration_arg = format!("duration={}", duration.unwrap_or("").trim());
        args.push("-f");
        args.push(&duration_arg);
    }
    let out = run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    let s: GlabTimeStats = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab time stats: {e}")))?;
    Ok(from_glab_time_stats(s))
}

/// An issue's time-tracking stats.
pub async fn issue_time_stats(repo_path: &str, number: u64) -> AppResult<GitLabTimeStats> {
    time_stats(repo_path, TimeTarget::Issue, number).await
}

/// A merge request's time-tracking stats.
pub async fn mr_time_stats(repo_path: &str, number: u64) -> AppResult<GitLabTimeStats> {
    time_stats(repo_path, TimeTarget::MergeRequest, number).await
}

/// Set (or, when blank, reset) an issue's time estimate; returns the new stats.
pub async fn issue_set_time_estimate(
    repo_path: &str,
    number: u64,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    write_time(repo_path, TimeTarget::Issue, number, TimeWrite::Estimate, duration).await
}

/// Add to (or, when blank, reset) an issue's spent time; returns the new stats.
pub async fn issue_add_spent_time(
    repo_path: &str,
    number: u64,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    write_time(repo_path, TimeTarget::Issue, number, TimeWrite::Spent, duration).await
}

/// Set (or, when blank, reset) a merge request's time estimate; returns new stats.
pub async fn mr_set_time_estimate(
    repo_path: &str,
    number: u64,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    write_time(
        repo_path,
        TimeTarget::MergeRequest,
        number,
        TimeWrite::Estimate,
        duration,
    )
    .await
}

/// Add to (or, when blank, reset) a merge request's spent time; returns new stats.
pub async fn mr_add_spent_time(
    repo_path: &str,
    number: u64,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    write_time(
        repo_path,
        TimeTarget::MergeRequest,
        number,
        TimeWrite::Spent,
        duration,
    )
    .await
}

// ── Related issues (issue links) ──────────────────────────────────────────────
//
// GitLab-only: link two issues as "related" (`issue_links`), a GitLab-unique
// surface with no GitHub analogue. Links are symmetric — the same link appears on
// both issues. The list endpoint returns full issue objects each augmented with
// `issue_link_id` (the link's own id, needed for delete) and `link_type`. Create
// takes the target by `target_project_id` (the plain "owner/repo" path, NOT
// url-encoded) + `target_issue_iid`; delete keys on the `issue_link_id`. All
// validated live against a real GitLab project.

/// One linked issue as `GET …/issues/{n}/links` returns it — a full issue object
/// augmented with the link's own id and type. Only the fields the neutral
/// `GitLabLinkedIssue` needs are deserialized; `state` is null-tolerant like the
/// other issue reads.
#[derive(Deserialize)]
struct GlabLinkedIssue {
    issue_link_id: u64,
    iid: u64,
    #[serde(default)]
    title: String,
    #[serde(default, deserialize_with = "null_to_default")]
    state: String,
    #[serde(default)]
    link_type: String,
    #[serde(default)]
    web_url: String,
}

/// A related issue (issue link) as the frontend renders it. `link_id` is the
/// link's own id serialized as a string (repo rule: ids over IPC as strings);
/// `state` is the neutral UPPERCASE form.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabLinkedIssue {
    /// The `issue_link_id` (the link itself), as a string — passed back to unlink.
    pub link_id: String,
    /// The linked issue's iid.
    pub number: u64,
    pub title: String,
    /// Neutral UPPERCASE state ("OPEN" / "CLOSED").
    pub state: String,
    /// The link type, e.g. "relates_to".
    pub link_type: String,
    pub web_url: String,
}

fn from_glab_linked_issue(l: GlabLinkedIssue) -> GitLabLinkedIssue {
    GitLabLinkedIssue {
        link_id: l.issue_link_id.to_string(),
        number: l.iid,
        title: l.title,
        state: map_issue_state(&l.state),
        link_type: l.link_type,
        web_url: l.web_url,
    }
}

/// An issue's related issues (links).
pub async fn issue_links(repo_path: &str, number: u64) -> AppResult<Vec<GitLabLinkedIssue>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/links");
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let links: Vec<GlabLinkedIssue> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab issue links: {e}")))?;
    Ok(links.into_iter().map(from_glab_linked_issue).collect())
}

/// Link `number` to `target_number` (both iids in this project) as related. The
/// target project is this repo's own path (a plain "owner/repo", not url-encoded
/// in the field value — validated live). The link is symmetric, so it shows on
/// both issues afterward.
pub async fn link_issue(repo_path: &str, number: u64, target_number: u64) -> AppResult<()> {
    let path = project_path(repo_path).await?;
    let enc = encode_project(&path);
    let endpoint = format!("projects/{enc}/issues/{number}/links");
    let target_project_arg = format!("target_project_id={path}");
    let target_issue_arg = format!("target_issue_iid={target_number}");
    run_glab(
        Some(repo_path),
        &[
            "api",
            "--method",
            "POST",
            &endpoint,
            "-f",
            &target_project_arg,
            "-f",
            &target_issue_arg,
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Remove an issue link by its `link_id` (the `issue_link_id` from the list).
pub async fn unlink_issue(repo_path: &str, number: u64, link_id: &str) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/links/{link_id}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_reviews_drop_system_notes_and_map_kinds() {
        // A live-shaped discussions payload: a system note (must be dropped), a
        // plain conversation note (→ "comment"), and an inline DiffNote (→
        // "inline" with path/line/commit).
        let json = r#"[
            {
                "notes": [
                    {
                        "system": true,
                        "body": "approved this merge request",
                        "author": { "username": "someuser" },
                        "created_at": "2026-07-04T00:00:00Z",
                        "resolvable": false,
                        "resolved": null
                    }
                ]
            },
            {
                "notes": [
                    {
                        "system": false,
                        "body": "Consider extracting this helper.",
                        "author": { "username": "coderabbitai" },
                        "created_at": "2026-07-04T00:01:00Z",
                        "resolvable": false,
                        "resolved": null
                    }
                ]
            },
            {
                "notes": [
                    {
                        "system": false,
                        "body": "Off-by-one here.",
                        "author": { "username": "coderabbitai" },
                        "created_at": "2026-07-04T00:02:00Z",
                        "resolvable": true,
                        "resolved": true,
                        "position": {
                            "new_path": "src/main.rs",
                            "new_line": 42,
                            "old_path": "src/main.rs",
                            "old_line": 40,
                            "head_sha": "abc123"
                        }
                    }
                ]
            }
        ]"#;
        let discussions: Vec<GlabDiscussion> = serde_json::from_str(json).unwrap();
        let items = external_items_from_discussions(&discussions);
        // System note filtered out → only the two real notes survive.
        assert_eq!(items.len(), 2);

        let comment = &items[0];
        assert_eq!(comment.kind, "comment");
        assert_eq!(comment.author, "coderabbitai");
        assert!(comment.is_bot);
        assert_eq!(comment.path, "");
        assert_eq!(comment.line, 0);
        assert!(!comment.is_resolved);

        let inline = &items[1];
        assert_eq!(inline.kind, "inline");
        assert_eq!(inline.path, "src/main.rs");
        assert_eq!(inline.line, 42);
        assert_eq!(inline.commit_sha, "abc123");
        // resolvable && resolved == true.
        assert!(inline.is_resolved);
    }

    #[test]
    fn external_reviews_fall_back_to_old_path_and_ignore_unresolvable_resolved() {
        // No new_path (a deletion-side note): fall back to old_path/old_line.
        // `resolved` is meaningless without `resolvable`, so is_resolved stays false.
        let json = r#"[
            {
                "notes": [
                    {
                        "system": false,
                        "body": "This deleted line was load-bearing.",
                        "author": { "username": "copilot-pull-request-reviewer" },
                        "created_at": "2026-07-04T00:03:00Z",
                        "resolvable": false,
                        "resolved": true,
                        "position": {
                            "new_path": "",
                            "new_line": null,
                            "old_path": "src/old.rs",
                            "old_line": 7,
                            "head_sha": ""
                        }
                    }
                ]
            }
        ]"#;
        let discussions: Vec<GlabDiscussion> = serde_json::from_str(json).unwrap();
        let items = external_items_from_discussions(&discussions);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, "inline");
        assert_eq!(items[0].path, "src/old.rs");
        assert_eq!(items[0].line, 7);
        assert_eq!(items[0].commit_sha, "");
        // resolved true but not resolvable → not resolved.
        assert!(!items[0].is_resolved);
    }

    #[test]
    fn gl_thread_anchor_picks_side_across_all_four_arms() {
        // Arm 1: new_line + new_path → new side, new line.
        let (path, line, side) = gl_thread_anchor(&GlabNotePosition {
            new_path: "src/main.rs".into(),
            new_line: Some(42),
            old_path: "src/old.rs".into(),
            old_line: Some(7),
            ..Default::default()
        });
        assert_eq!((path.as_str(), line, side), ("src/main.rs", 42, "new"));

        // Arm 2: no new_line, but old_line + old_path → old side, old line.
        let (path, line, side) = gl_thread_anchor(&GlabNotePosition {
            new_path: String::new(),
            new_line: None,
            old_path: "src/old.rs".into(),
            old_line: Some(9),
            ..Default::default()
        });
        assert_eq!((path.as_str(), line, side), ("src/old.rs", 9, "old"));

        // Arm 3: no lines, but a new_path present → new side, line 0.
        let (path, line, side) = gl_thread_anchor(&GlabNotePosition {
            new_path: "src/added.rs".into(),
            new_line: None,
            old_path: String::new(),
            old_line: None,
            ..Default::default()
        });
        assert_eq!((path.as_str(), line, side), ("src/added.rs", 0, "new"));

        // Arm 4 (the fixed fallback): no lines, only old_path → OLD side, line 0.
        let (path, line, side) = gl_thread_anchor(&GlabNotePosition {
            new_path: String::new(),
            new_line: None,
            old_path: "src/removed.rs".into(),
            old_line: None,
            ..Default::default()
        });
        assert_eq!((path.as_str(), line, side), ("src/removed.rs", 0, "old"));
    }

    #[test]
    fn external_reviews_tolerate_missing_and_null_fields() {
        // A note missing author/position/created_at and one with a null position
        // and null author must still map (defaults), not panic or drop the batch.
        let json = r#"[
            {
                "notes": [
                    { "body": "bare note, no other fields" }
                ]
            },
            {
                "notes": [
                    {
                        "system": false,
                        "body": "null author and position",
                        "author": null,
                        "position": null,
                        "created_at": "2026-07-04T00:04:00Z"
                    }
                ]
            }
        ]"#;
        let discussions: Vec<GlabDiscussion> = serde_json::from_str(json).unwrap();
        let items = external_items_from_discussions(&discussions);
        assert_eq!(items.len(), 2);
        // Both fall back to plain-comment kind with empty author.
        assert_eq!(items[0].kind, "comment");
        assert_eq!(items[0].author, "");
        assert_eq!(items[0].body, "bare note, no other fields");
        assert_eq!(items[1].kind, "comment");
        assert_eq!(items[1].author, "");
    }

    #[test]
    fn parses_project_permissions_with_null_group_access() {
        // The exact shape observed live: a direct project grant, no group.
        let json = r#"{
            "permissions": {
                "project_access": { "access_level": 50, "notification_level": 3 },
                "group_access": null
            }
        }"#;
        let p: GlabProjectPermissions = serde_json::from_str(json).unwrap();
        let perms = p.permissions.unwrap();
        assert_eq!(perms.project_access.map(|a| a.access_level), Some(50));
        assert!(perms.group_access.is_none());
    }

    #[test]
    fn maps_project_settings_with_nulled_fields() {
        // GitLab nulls optional fields rather than omitting them.
        let json = r#"{
            "description": null,
            "topics": ["alpha", "beta"],
            "default_branch": "main",
            "visibility": "private",
            "web_url": "https://gitlab.com/g/r",
            "path_with_namespace": "g/r",
            "path": "r",
            "name": "r",
            "archived": false,
            "issues_access_level": "enabled",
            "merge_requests_access_level": "private",
            "wiki_access_level": "disabled",
            "snippets_access_level": "enabled",
            "forking_access_level": "enabled",
            "merge_method": "ff",
            "squash_option": "default_off",
            "remove_source_branch_after_merge": null,
            "only_allow_merge_if_pipeline_succeeds": true,
            "only_allow_merge_if_all_discussions_are_resolved": false
        }"#;
        let s = settings_from_project(serde_json::from_str(json).unwrap());
        assert_eq!(s.description, None);
        assert_eq!(s.default_branch.as_deref(), Some("main"));
        assert_eq!(s.merge_requests_access_level, "private");
        assert_eq!(s.merge_method, "ff");
        assert!(!s.remove_source_branch_after_merge);
        assert!(s.only_allow_merge_if_pipeline_succeeds);
        assert_eq!(s.full_name, "g/r");
    }

    #[tokio::test]
    async fn settings_update_rejects_invalid_enums_and_comma_topics() {
        let valid = || GitLabRepoSettingsInput {
            description: "d".into(),
            topics: vec!["a".into()],
            default_branch: Some("main".into()),
            issues_access_level: "enabled".into(),
            merge_requests_access_level: "enabled".into(),
            wiki_access_level: "disabled".into(),
            snippets_access_level: "private".into(),
            forking_access_level: "enabled".into(),
            merge_method: "merge".into(),
            squash_option: "never".into(),
            remove_source_branch_after_merge: true,
            only_allow_merge_if_pipeline_succeeds: false,
            only_allow_merge_if_all_discussions_are_resolved: false,
        };
        let mut bad_enum = valid();
        bad_enum.merge_method = "octopus".into();
        assert!(update_repo_settings("C:/nonexistent", bad_enum)
            .await
            .is_err());
        let mut bad_topic = valid();
        bad_topic.topics = vec!["a,b".into()];
        assert!(update_repo_settings("C:/nonexistent", bad_topic)
            .await
            .is_err());
    }

    #[test]
    fn ready_gitlab_repo_has_repo_and_merge_request_support() {
        let s = gitlab_status(true, true, "gitlab.com", Some("group/repo".into()));
        assert_eq!(s.provider, Some(Provider::GitLab));
        assert_eq!(s.host.as_deref(), Some("gitlab.com"));
        assert!(s.installed && s.authenticated);
        // repo Some => forgeReady is true; MR reads are implemented…
        assert_eq!(s.repo.as_deref(), Some("group/repo"));
        assert!(s.implemented.pull_requests);
        // …issue reads, and CI pipeline reads.
        assert!(s.implemented.issues && s.implemented.ci);
        // GitLab capability profile (everything but Discussions).
        assert!(!s.capabilities.discussions && s.capabilities.labels);
    }

    #[test]
    fn missing_glab_reports_not_installed() {
        let s = gitlab_status(false, false, "gitlab.com", None);
        assert_eq!(s.provider, Some(Provider::GitLab));
        assert!(!s.installed && !s.authenticated && s.repo.is_none());
    }

    #[test]
    fn maps_glab_mr_to_neutral_pr() {
        let json = r#"{
            "iid": 7,
            "web_url": "https://gitlab.com/g/r/-/merge_requests/7",
            "title": "Add dark mode",
            "target_branch": "main",
            "source_branch": "feature/dark",
            "draft": false,
            "state": "merged",
            "author": { "username": "alice" },
            "labels": ["enhancement", "ui"]
        }"#;
        let p = from_glab_mr(serde_json::from_str(json).unwrap());
        assert_eq!(p.number, 7);
        assert_eq!(p.base_ref_name, "main");
        assert_eq!(p.head_ref_name, "feature/dark");
        assert_eq!(p.state, "MERGED");
        assert_eq!(p.author.unwrap().login, "alice");
        assert_eq!(p.labels.len(), 2);
    }

    #[test]
    fn mr_state_maps_to_neutral() {
        assert_eq!(map_mr_state("opened"), "OPEN");
        assert_eq!(map_mr_state("closed"), "CLOSED");
        assert_eq!(map_mr_state("locked"), "CLOSED");
        assert_eq!(map_mr_state("merged"), "MERGED");
    }

    // The auto-merge read's mapping lives inline in the async `mr_merge_state`,
    // which can't run without a live glab; these mirror it on the internal
    // deserialize struct so the field mapping (incl. the null → "" fallback) is
    // covered by a pure test.
    fn to_public_merge_state(mr: GlabMrMergeState) -> GitLabMrMergeState {
        let (pipeline_status, pipeline_url) = mr
            .head_pipeline
            .map(|p| (p.status, p.web_url))
            .unwrap_or_default();
        GitLabMrMergeState {
            auto_merge_enabled: mr.merge_when_pipeline_succeeds,
            detailed_merge_status: mr.detailed_merge_status,
            pipeline_status,
            pipeline_url,
        }
    }

    #[test]
    fn maps_mr_merge_state_with_head_pipeline() {
        // The live shape while armed with a running pipeline.
        let json = r#"{
            "iid": 6,
            "merge_when_pipeline_succeeds": true,
            "detailed_merge_status": "ci_still_running",
            "head_pipeline": {
                "status": "running",
                "web_url": "https://gitlab.com/g/r/-/pipelines/42"
            }
        }"#;
        let s = to_public_merge_state(serde_json::from_str(json).unwrap());
        assert!(s.auto_merge_enabled);
        assert_eq!(s.detailed_merge_status, "ci_still_running");
        assert_eq!(s.pipeline_status, "running");
        assert_eq!(s.pipeline_url, "https://gitlab.com/g/r/-/pipelines/42");
    }

    #[test]
    fn mr_merge_state_tolerates_nulls_and_missing_pipeline() {
        // GitLab nulls the scalars and sends a null head_pipeline for an MR with
        // no pipeline — all four fields fall back to false / "".
        let json = r#"{
            "iid": 6,
            "merge_when_pipeline_succeeds": null,
            "detailed_merge_status": null,
            "head_pipeline": null
        }"#;
        let s = to_public_merge_state(serde_json::from_str(json).unwrap());
        assert!(!s.auto_merge_enabled);
        assert_eq!(s.detailed_merge_status, "");
        assert_eq!(s.pipeline_status, "");
        assert_eq!(s.pipeline_url, "");
    }

    #[test]
    fn service_error_message_detects_cancel_error_body_only() {
        // The exact live exit-0 body when nothing is armed to cancel.
        let err =
            r#"{"message":"Can't cancel the automatic merge","status":"error","http_status":406}"#;
        assert_eq!(
            service_error_message(err).as_deref(),
            Some("Can't cancel the automatic merge")
        );
        // A plain success-ish body and empty input are NOT errors.
        assert_eq!(service_error_message(r#"{"iid": 6}"#), None);
        assert_eq!(service_error_message(""), None);
    }

    #[tokio::test]
    async fn auto_merge_rejects_invalid_strategy() {
        // The arm path shares merge_mr's strategy validation — "rebase" is not a
        // per-MR option and must fail before any remote call.
        let r = auto_merge_mr("C:/nonexistent", 1, "rebase", false, None).await;
        assert!(matches!(r, Err(AppError::InvalidArgument(_))));
    }

    #[test]
    fn maps_glab_issue_to_neutral_issue() {
        let json = r#"{
            "iid": 3,
            "web_url": "https://gitlab.com/g/r/-/issues/3",
            "title": "Add dark mode toggle",
            "state": "opened",
            "created_at": "2026-06-30T00:36:04Z",
            "updated_at": "2026-06-30T01:00:00Z",
            "author": { "username": "alice" },
            "labels": ["enhancement"]
        }"#;
        let i = from_glab_issue(serde_json::from_str(json).unwrap());
        assert_eq!(i.number, 3);
        assert_eq!(i.url, "https://gitlab.com/g/r/-/issues/3");
        assert_eq!(i.state, "OPEN");
        assert_eq!(i.created_at, "2026-06-30T00:36:04Z");
        assert_eq!(i.updated_at, "2026-06-30T01:00:00Z");
        assert_eq!(i.author.unwrap().login, "alice");
        assert_eq!(i.labels.len(), 1);
        assert_eq!(i.labels[0].name, "enhancement");
    }

    #[test]
    fn issue_state_maps_to_neutral() {
        assert_eq!(map_issue_state("opened"), "OPEN");
        assert_eq!(map_issue_state("closed"), "CLOSED");
        // Unknown states upper-case rather than panic (issues never report merged).
        assert_eq!(map_issue_state("weird"), "WEIRD");
    }

    #[test]
    fn issue_detail_tolerates_null_collections_and_scalars() {
        // GitLab can send `null` (not `[]`/`false`/omitted) for any of these, and a
        // bare field with only `#[serde(default)]` fails the WHOLE parse on a present
        // `null` — the "Could not load this issue" dogfood bug. `null_to_default`
        // must absorb every one (labels, assignees, milestone, discussion_locked).
        let json = r#"{
            "iid": 2,
            "web_url": "https://gitlab.com/g/r/-/issues/2",
            "title": "Crash when cloning an empty repository",
            "description": "Steps to reproduce…",
            "state": "opened",
            "created_at": "2026-06-30T00:36:04.349Z",
            "author": { "username": "theBGuy" },
            "labels": null,
            "assignees": null,
            "milestone": null,
            "discussion_locked": null
        }"#;
        let issue: GlabIssueDetail = serde_json::from_str(json).unwrap();
        assert_eq!(issue.iid, 2);
        assert!(!issue.discussion_locked);
        assert!(issue.milestone.is_none());
        assert!(issue.labels.is_empty());
        assert!(issue.assignees.is_empty());
    }

    #[test]
    fn issue_detail_maps_populated_milestone_and_assignees() {
        // The happy path: a present milestone + assignees + labels deserialize and
        // carry through (locks the mapping the null test can't exercise).
        let json = r#"{
            "iid": 5,
            "web_url": "https://gitlab.com/g/r/-/issues/5",
            "title": "Polish onboarding",
            "description": "",
            "state": "closed",
            "created_at": "2026-06-30T00:00:00Z",
            "author": { "username": "alice" },
            "labels": ["enhancement", "ui"],
            "assignees": [{ "username": "bob" }, { "username": "carol" }],
            "milestone": { "id": 7495818, "iid": 3, "title": "v1.0" },
            "discussion_locked": true
        }"#;
        let issue: GlabIssueDetail = serde_json::from_str(json).unwrap();
        assert_eq!(issue.labels, vec!["enhancement".to_string(), "ui".to_string()]);
        assert_eq!(issue.assignees.len(), 2);
        assert_eq!(issue.assignees[0].username, "bob");
        let m = issue.milestone.as_ref().unwrap();
        // The GLOBAL id, not the project-scoped iid (the write keys on milestone_id).
        assert_eq!(m.id, 7495818);
        assert_eq!(m.title, "v1.0");
        assert!(issue.discussion_locked);
    }

    #[test]
    fn ci_status_maps_to_neutral_two_field_model() {
        assert_eq!(map_ci_status("success"), ("completed".into(), "success".into()));
        assert_eq!(map_ci_status("failed"), ("completed".into(), "failure".into()));
        assert_eq!(map_ci_status("canceled"), ("completed".into(), "cancelled".into()));
        assert_eq!(map_ci_status("skipped"), ("completed".into(), "skipped".into()));
        assert_eq!(map_ci_status("manual"), ("completed".into(), "action_required".into()));
        // In-flight states map to a non-completed lifecycle (so the UI keeps polling).
        assert_eq!(map_ci_status("running"), ("in_progress".into(), String::new()));
        assert_eq!(map_ci_status("pending"), ("pending".into(), String::new()));
        assert_eq!(map_ci_status("created"), ("queued".into(), String::new()));
    }

    #[test]
    fn maps_glab_pipeline_to_neutral_run() {
        let json = r#"{
            "id": 999,
            "iid": 12,
            "sha": "abc123",
            "ref": "feature/dark-mode",
            "status": "failed",
            "source": "push",
            "created_at": "2026-06-30T00:35:25Z",
            "updated_at": "2026-06-30T00:35:53Z",
            "web_url": "https://gitlab.com/g/r/-/pipelines/999",
            "name": null
        }"#;
        let run = from_glab_pipeline(serde_json::from_str(json).unwrap());
        assert_eq!(run.id, 999);
        assert_eq!(run.number, 12);
        // No pipeline name → a stable "#iid" title.
        assert_eq!(run.display_title, "Pipeline #12");
        assert_eq!(run.workflow_name, "Push");
        assert_eq!(run.head_branch, "feature/dark-mode");
        assert_eq!(run.status, "completed");
        assert_eq!(run.conclusion, "failure");
        assert_eq!(run.head_sha, "abc123");
    }

    #[test]
    fn maps_glab_job_to_neutral_with_no_steps() {
        // A not-yet-started job sends `started_at: null` — must absorb, not sink.
        let json = r#"{
            "id": 5151,
            "status": "skipped",
            "stage": "build",
            "name": "build",
            "started_at": null,
            "finished_at": null,
            "web_url": "https://gitlab.com/g/r/-/jobs/5151"
        }"#;
        let job = from_glab_job(serde_json::from_str(json).unwrap());
        assert_eq!(job.id, 5151);
        assert_eq!(job.name, "build");
        assert_eq!(job.status, "completed");
        assert_eq!(job.conclusion, "skipped");
        assert_eq!(job.started_at, "");
        assert!(job.steps.is_empty());
    }

    #[test]
    fn cleans_gitlab_trace_of_ansi_and_section_markers() {
        let raw = "\u{1b}[0Ksection_start:1718000000:prepare\rPreparing\u{1b}[0;m\nsection_end:1718000000:prepare\r\u{1b}[32;1mDone\u{1b}[0m\n";
        let cleaned = clean_trace(raw);
        assert!(!cleaned.contains('\u{1b}'), "ANSI escapes remain: {cleaned:?}");
        assert!(!cleaned.contains('\r'));
        assert!(!cleaned.contains("section_start"));
        assert!(!cleaned.contains("section_end"));
        assert!(cleaned.contains("Preparing"));
        assert!(cleaned.contains("Done"));
    }

    #[test]
    fn counts_added_and_deleted_lines() {
        let diff = "@@ -1,2 +1,3 @@\n context\n-old\n+new\n+extra\n";
        assert_eq!(count_diff_lines(diff), (2, 1));
    }

    #[test]
    fn counts_content_lines_that_start_with_plus_or_minus_runs() {
        // Hunk-only input: an added line whose content is `++x` and a deleted
        // `---` separator are real content, not file headers — both must count.
        let diff = "@@ -1,2 +1,2 @@\n+++added\n---\n context\n";
        assert_eq!(count_diff_lines(diff), (1, 1));
    }

    #[test]
    fn reconstructs_new_file_diff_with_git_header() {
        let c = GlabChange {
            old_path: "docs/x.md".into(),
            new_path: "docs/x.md".into(),
            new_file: true,
            deleted_file: false,
            diff: "@@ -0,0 +1 @@\n+hi".into(),
        };
        let out = reconstruct_file_diff(&c);
        // The splitter keys on these lines, so they must be present and well-formed.
        assert!(out.starts_with("diff --git a/docs/x.md b/docs/x.md\n"));
        assert!(out.contains("--- /dev/null\n"));
        assert!(out.contains("+++ b/docs/x.md\n"));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn reconstructs_deleted_file_diff() {
        let c = GlabChange {
            old_path: "gone.txt".into(),
            new_path: "gone.txt".into(),
            new_file: false,
            deleted_file: true,
            diff: "@@ -1 +0,0 @@\n-bye\n".into(),
        };
        let out = reconstruct_file_diff(&c);
        assert!(out.contains("--- a/gone.txt\n"));
        assert!(out.contains("+++ /dev/null\n"));
    }

    #[test]
    fn encodes_nested_project_path() {
        assert_eq!(encode_project("group/sub/repo"), "group%2Fsub%2Frepo");
    }

    #[test]
    fn encodes_query_significant_chars_in_a_branch_ref() {
        // The plain branch name survives; `/` and query-significant chars encode so
        // `glab api`'s verbatim query can't be corrupted/split.
        assert_eq!(encode_query_value("feature/dark-mode"), "feature%2Fdark-mode");
        assert_eq!(encode_query_value("fix_bug.v2"), "fix_bug.v2");
        assert_eq!(encode_query_value("a&b=c#d"), "a%26b%3Dc%23d");
    }

    // Sample JSON below mirrors the real `glab api projects` shape (validated live).
    #[test]
    fn maps_glab_project_to_neutral_repo() {
        let json = r#"{
            "name": "cli",
            "path_with_namespace": "gitlab-org/cli",
            "description": "The GitLab CLI",
            "visibility": "public",
            "archived": false,
            "http_url_to_repo": "https://gitlab.com/gitlab-org/cli.git",
            "ssh_url_to_repo": "git@gitlab.com:gitlab-org/cli.git",
            "last_activity_at": "2026-06-29T22:54:01Z",
            "namespace": { "full_path": "gitlab-org" },
            "forked_from_project": null
        }"#;
        let r = from_glab_project(serde_json::from_str(json).unwrap());
        assert_eq!(r.full_name, "gitlab-org/cli");
        assert_eq!(r.owner, "gitlab-org");
        assert_eq!(r.name, "cli");
        assert!(!r.private && !r.archived && !r.fork);
        assert_eq!(r.clone_url, "https://gitlab.com/gitlab-org/cli.git");
        assert_eq!(r.ssh_url, "git@gitlab.com:gitlab-org/cli.git");
        assert_eq!(r.pushed_at.as_deref(), Some("2026-06-29T22:54:01Z"));
    }

    #[test]
    fn detects_private_and_fork() {
        let json = r#"{
            "name": "x", "path_with_namespace": "me/x",
            "visibility": "private", "archived": true,
            "http_url_to_repo": "h", "ssh_url_to_repo": "s",
            "namespace": { "full_path": "me" },
            "forked_from_project": { "id": 1 }
        }"#;
        let r = from_glab_project(serde_json::from_str(json).unwrap());
        assert!(r.private && r.archived && r.fork);
    }

    // Sample JSON below mirrors the real `glab api …/releases` shape (validated live).
    #[test]
    fn maps_glab_release_to_neutral_info() {
        let json = r#"{
            "tag_name": "v1.0.0",
            "name": "v1.0.0 — stable",
            "description": "First **stable** release.",
            "released_at": "2026-06-30T07:06:16.417Z",
            "created_at": "2026-06-30T07:06:16.417Z",
            "upcoming_release": false,
            "author": { "username": "theBGuy" },
            "assets": { "links": [] },
            "_links": { "self": "https://gitlab.com/g/r/-/releases/v1.0.0" }
        }"#;
        let r: GlabRelease = serde_json::from_str(json).unwrap();
        let info = release_info(&r, true);
        assert_eq!(info.tag_name, "v1.0.0");
        assert_eq!(info.name, "v1.0.0 — stable");
        // GitLab has neither draft nor prerelease releases.
        assert!(!info.is_draft && !info.is_prerelease);
        assert!(info.is_latest);
        assert_eq!(info.published_at, "2026-06-30T07:06:16.417Z");
    }

    #[test]
    fn release_detail_maps_description_url_and_asset_links() {
        let json = r#"{
            "tag_name": "v1.0.0",
            "name": "v1.0.0",
            "description": "Body text",
            "released_at": "2026-06-30T07:06:16.417Z",
            "created_at": "2026-06-30T07:00:00Z",
            "upcoming_release": false,
            "author": { "username": "theBGuy" },
            "assets": { "links": [
                { "id": 1, "name": "Release notes (README)", "url": "https://x/u", "direct_asset_url": "https://x/direct", "link_type": "other" }
            ] },
            "_links": { "self": "https://gitlab.com/g/r/-/releases/v1.0.0" }
        }"#;
        let d = release_details(serde_json::from_str(json).unwrap());
        assert_eq!(d.body, "Body text");
        assert_eq!(d.author, "theBGuy");
        assert_eq!(d.url, "https://gitlab.com/g/r/-/releases/v1.0.0");
        assert!(!d.is_draft && !d.is_prerelease);
        assert_eq!(d.published_at, "2026-06-30T07:06:16.417Z");
        assert_eq!(d.assets.len(), 1);
        assert_eq!(d.assets[0].name, "Release notes (README)");
        // Asset links have no size/downloads; the direct asset URL is preferred.
        assert_eq!(d.assets[0].size, 0);
        assert_eq!(d.assets[0].download_count, 0);
        assert_eq!(d.assets[0].url, "https://x/direct");
    }

    #[test]
    fn release_tolerates_null_description_and_missing_links() {
        // A release with no description / no assets / no `_links`: GitLab can send
        // `null` for the body, and `#[serde(default)]` alone would sink a present
        // `null` — `null_to_default` must absorb it (same trap as the issue parse).
        let json = r#"{
            "tag_name": "v0.1.0",
            "name": "",
            "description": null,
            "released_at": "2026-06-30T00:00:00Z",
            "upcoming_release": false
        }"#;
        let d = release_details(serde_json::from_str(json).unwrap());
        assert_eq!(d.tag_name, "v0.1.0");
        assert_eq!(d.body, "");
        assert_eq!(d.url, "");
        assert!(d.assets.is_empty());
        // Falls back to released_at for the publish time.
        assert_eq!(d.published_at, "2026-06-30T00:00:00Z");
    }

    #[test]
    fn newest_non_upcoming_release_is_marked_latest() {
        // The list comes back released_at-desc; an upcoming (scheduled) release can
        // sit at the top but must NOT be "latest" — the first non-upcoming is.
        let mk = |tag: &str, upcoming: bool| -> GlabRelease {
            serde_json::from_str(&format!(
                r#"{{ "tag_name": "{tag}", "name": "{tag}", "released_at": "2026-06-30T00:00:00Z", "upcoming_release": {upcoming} }}"#
            ))
            .unwrap()
        };
        let list = vec![mk("v2.0.0-next", true), mk("v1.1.0", false), mk("v1.0.0", false)];
        let infos = releases_to_infos(&list);
        assert!(!infos[0].is_latest, "an upcoming release is never latest");
        assert!(infos[1].is_latest, "the newest published release is latest");
        assert!(!infos[2].is_latest);
    }

    #[test]
    fn pipeline_variable_keys_reject_colon_and_flaggy_names() {
        // The `key:value` token splits on the FIRST colon — a colon-bearing key
        // would silently corrupt the value, and a leading digit isn't an env var.
        assert!(valid_variable_key("DEPLOY_ENV"));
        assert!(valid_variable_key("_private"));
        assert!(valid_variable_key("key2"));
        assert!(!valid_variable_key(""));
        assert!(!valid_variable_key("has:colon"));
        assert!(!valid_variable_key("has space"));
        assert!(!valid_variable_key("2leading"));
        assert!(!valid_variable_key("-flag"));
    }

    #[test]
    fn pipeline_variable_values_survive_commas_and_quotes() {
        // glab CSV-splits the --variables flag value; the token must be a fully
        // quoted CSV field with embedded quotes doubled (forms validated live).
        assert_eq!(variable_token("KEY", "simple"), "\"KEY:simple\"");
        assert_eq!(variable_token("REGIONS", "us-east-1,eu-west-1"), "\"REGIONS:us-east-1,eu-west-1\"");
        assert_eq!(variable_token("NOTE", "say \"hi\", ok"), "\"NOTE:say \"\"hi\"\", ok\"");
        assert_eq!(variable_token("MSG", "hello: world"), "\"MSG:hello: world\"");
    }

    #[test]
    fn mr_changes_parse_assignees_present_null_and_missing() {
        // GitLab sends `assignees: []` normally, but nullable collections must
        // tolerate an explicit `null` (the null_to_default trap) and absence.
        let base = r#""iid": 1, "web_url": "u", "title": "t", "target_branch": "main",
            "source_branch": "f", "state": "opened""#;
        let with = format!(
            r#"{{ {base}, "assignees": [ {{ "username": "alice" }}, {{ "username": "bob" }} ] }}"#
        );
        let mr: GlabMrChanges = serde_json::from_str(&with).unwrap();
        let names: Vec<String> = mr.assignees.into_iter().map(|a| a.username).collect();
        assert_eq!(names, vec!["alice", "bob"]);

        let with_null = format!(r#"{{ {base}, "assignees": null }}"#);
        let mr: GlabMrChanges = serde_json::from_str(&with_null).unwrap();
        assert!(mr.assignees.is_empty());

        let missing = format!("{{ {base} }}");
        let mr: GlabMrChanges = serde_json::from_str(&missing).unwrap();
        assert!(mr.assignees.is_empty());
    }

    #[test]
    fn mr_poll_state_maps_locked_to_open() {
        // `locked` is a transient mid-merge state — the poll must treat it as OPEN,
        // NOT closed (map_mr_state maps it to CLOSED for the list panel, but firing a
        // spurious "closed" notification while GitLab locks the MR to merge is wrong).
        assert_eq!(map_mr_poll_state("opened"), "OPEN");
        assert_eq!(map_mr_poll_state("locked"), "OPEN");
        assert_eq!(map_mr_poll_state("merged"), "MERGED");
        assert_eq!(map_mr_poll_state("closed"), "CLOSED");
        // An unrecognized state is uppercased, never silently dropped.
        assert_eq!(map_mr_poll_state("weird"), "WEIRD");
    }

    #[test]
    fn poll_mr_maps_full_sha_author_and_empty_rollups() {
        let json = r#"{
            "iid": 42,
            "web_url": "https://gitlab.com/g/r/-/merge_requests/42",
            "title": "Add feature",
            "state": "opened",
            "draft": true,
            "sha": "0123456789abcdef0123456789abcdef01234567",
            "author": { "username": "theBGuy" }
        }"#;
        let info = from_glab_poll_mr(serde_json::from_str(json).unwrap());
        assert_eq!(info.number, 42);
        assert_eq!(info.state, "OPEN");
        assert!(info.is_draft);
        // Author = username (matches ForgeStatus.login for GitLab, so `mine` matches).
        assert_eq!(info.author, "theBGuy");
        // Full 40-char head OID drives pr-sync.
        assert_eq!(info.head_sha, "0123456789abcdef0123456789abcdef01234567");
        // The list carries neither an approval decision nor a check rollup (v1 limit).
        assert_eq!(info.review_decision, "");
        assert_eq!(info.checks_state, "");
    }

    #[test]
    fn poll_mr_tolerates_null_sha_and_missing_author() {
        // A null `sha` (null_to_default) and an absent author must not sink the parse.
        let json = r#"{
            "iid": 7,
            "web_url": "u",
            "title": "t",
            "state": "merged",
            "sha": null
        }"#;
        let info = from_glab_poll_mr(serde_json::from_str(json).unwrap());
        assert_eq!(info.number, 7);
        assert_eq!(info.state, "MERGED");
        assert!(!info.is_draft);
        assert_eq!(info.author, "");
        assert_eq!(info.head_sha, "");
    }

    #[test]
    fn release_published_at_falls_back_to_created_at() {
        let r: GlabRelease = serde_json::from_str(
            r#"{ "tag_name": "v1", "name": "v1", "created_at": "2026-01-01T00:00:00Z" }"#,
        )
        .unwrap();
        assert_eq!(release_published_at(&r), "2026-01-01T00:00:00Z");
    }

    #[test]
    fn request_changes_envelope_parses_all_three_outcomes() {
        // Success, a mutation-level error (inside `data`), and a top-level GraphQL
        // error (bad query / auth / license) — all shapes seen live.
        let ok = r#"{"data":{"mergeRequestRequestChanges":{"errors":[]}}}"#;
        let env: GlabGqlRequestChangesEnvelope = serde_json::from_str(ok).unwrap();
        assert!(env.errors.is_empty());
        assert!(env.data.unwrap().request_changes.unwrap().errors.is_empty());

        let refused = r#"{"data":{"mergeRequestRequestChanges":{"errors":["Reviewer not found"]}}}"#;
        let env: GlabGqlRequestChangesEnvelope = serde_json::from_str(refused).unwrap();
        assert_eq!(
            env.data.unwrap().request_changes.unwrap().errors,
            vec!["Reviewer not found"]
        );

        let top = r#"{"errors":[{"message":"syntax error"}],"data":null}"#;
        let env: GlabGqlRequestChangesEnvelope = serde_json::from_str(top).unwrap();
        assert_eq!(env.errors.len(), 1);
        assert!(env.data.is_none());
    }

    #[test]
    fn awards_map_tally_and_round_trip() {
        // The GitHub-8 map both ways; anything else drops from the tally (GitLab
        // allows the full emoji palette — those stay visible on GitLab itself).
        for (award, content) in [
            ("thumbsup", "THUMBS_UP"),
            ("thumbsdown", "THUMBS_DOWN"),
            ("smile", "LAUGH"),
            ("confused", "CONFUSED"),
            ("heart", "HEART"),
            ("tada", "HOORAY"),
            ("rocket", "ROCKET"),
            ("eyes", "EYES"),
        ] {
            assert_eq!(award_to_reaction(award), Some(content));
            assert_eq!(reaction_to_award(content).unwrap(), award);
        }
        assert_eq!(award_to_reaction("bowtie"), None);
        assert!(reaction_to_award("SPARKLES").is_err());

        let awards: Vec<GlabAward> = serde_json::from_str(
            r#"[
                { "id": 1, "name": "thumbsup", "user": { "username": "alice" } },
                { "id": 2, "name": "thumbsup", "user": { "username": "me" } },
                { "id": 3, "name": "bowtie", "user": { "username": "me" } },
                { "id": 4, "name": "rocket", "user": { "username": "bob" } }
            ]"#,
        )
        .unwrap();
        let tally = tally_awards(awards, "me");
        assert_eq!(tally.len(), 2);
        let thumbs = tally.iter().find(|r| r.content == "THUMBS_UP").unwrap();
        assert_eq!(thumbs.count, 2);
        assert!(thumbs.viewer_reacted);
        let rocket = tally.iter().find(|r| r.content == "ROCKET").unwrap();
        assert_eq!(rocket.count, 1);
        assert!(!rocket.viewer_reacted);
    }

    #[test]
    fn award_gql_envelope_maps_notes_by_numeric_gid_tail() {
        // The live shape: note ids are gids; system notes and award-less notes
        // stay out of the comments map; currentUser drives viewer_reacted.
        let json = r#"{"data":{
            "currentUser":{"username":"me"},
            "project":{"mergeRequest":{
                "awardEmoji":{"nodes":[{"name":"heart","user":{"username":"me"}}]},
                "notes":{"nodes":[
                    {"id":"gid://gitlab/Note/111","system":false,
                     "awardEmoji":{"nodes":[{"name":"eyes","user":{"username":"bob"}}]}},
                    {"id":"gid://gitlab/Note/222","system":true,
                     "awardEmoji":{"nodes":[{"name":"eyes","user":{"username":"bob"}}]}},
                    {"id":"gid://gitlab/Note/333","system":false,
                     "awardEmoji":{"nodes":[]}}
                ]}
            }}
        }}"#;
        let env: GqlAwardEnvelope = serde_json::from_str(json).unwrap();
        let data = env.data.unwrap();
        assert_eq!(data.current_user.unwrap().username, "me");
        let mr = data.project.unwrap().merge_request.unwrap();
        assert_eq!(mr.award_emoji.as_ref().unwrap().nodes.len(), 1);
        let notes = mr.notes.unwrap().nodes;
        assert_eq!(notes.len(), 3);
        assert_eq!(gid_tail(&notes[0].id), "111");
        assert!(notes[1].system);
    }

    #[test]
    fn reviewers_parse_states_and_tolerate_missing_user() {
        // The reviewers endpoint nests full user payloads; `state` is the
        // per-reviewer review state (requested_changes drives the pressed UI).
        let json = r#"[
            { "user": { "id": 7, "username": "alice", "name": "Alice" }, "state": "requested_changes" },
            { "user": { "id": 9, "username": "bob" }, "state": "unreviewed" },
            { "state": "approved" }
        ]"#;
        let reviewers: Vec<GlabReviewer> = serde_json::from_str(json).unwrap();
        assert_eq!(reviewers.len(), 3);
        assert_eq!(reviewers[0].state, "requested_changes");
        assert_eq!(reviewers[0].user.as_ref().unwrap().id, 7);
        assert!(reviewers[2].user.is_none());
    }

    #[test]
    fn maps_protected_branch_from_live_shape() {
        // The exact object captured live from gitlab.com Free tier.
        let json = r#"{"id":267905477,"name":"main","push_access_levels":[{"id":325719801,"access_level":40,"access_level_description":"Maintainers","deploy_key_id":null,"user_id":null,"group_id":null}],"merge_access_levels":[{"id":290254592,"access_level":40,"access_level_description":"Maintainers","user_id":null,"group_id":null}],"allow_force_push":false,"unprotect_access_levels":[],"code_owner_approval_required":false,"inherited":false}"#;
        let pb: GlabProtectedBranch = serde_json::from_str(json).unwrap();
        let mapped = map_protected_branch(pb);
        assert_eq!(mapped.id, "267905477");
        assert_eq!(mapped.name, "main");
        assert_eq!(mapped.push_levels.len(), 1);
        assert_eq!(mapped.push_levels[0].access_level, 40);
        assert_eq!(mapped.push_levels[0].description, "Maintainers");
        assert_eq!(mapped.merge_levels.len(), 1);
        assert_eq!(mapped.merge_levels[0].access_level, 40);
        assert_eq!(mapped.merge_levels[0].description, "Maintainers");
        assert!(!mapped.allow_force_push);
        assert!(!mapped.inherited);
    }

    #[test]
    fn protected_branch_tolerates_null_and_missing_fields() {
        // GitLab nulls scalars rather than omitting them; missing collections/bools
        // must fall back to defaults so a single quirk doesn't sink the whole parse.
        let json = r#"{"id":1,"name":"main","push_access_levels":[],"allow_force_push":null}"#;
        let pb: GlabProtectedBranch = serde_json::from_str(json).unwrap();
        let mapped = map_protected_branch(pb);
        assert!(!mapped.allow_force_push);
        assert!(!mapped.inherited);
        assert!(mapped.merge_levels.is_empty());
    }

    #[tokio::test]
    async fn create_protected_branch_rejects_bad_access_level() {
        // The guard returns early, before any glab spawn or network access.
        let err = create_protected_branch("/repo", "main", 20, 40, false)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
    }

    #[tokio::test]
    async fn protected_branch_ops_reject_blank_name() {
        let err = create_protected_branch("/repo", "   ", 40, 40, false)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
        let err = update_protected_branch("/repo", "", false).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
        let err = delete_protected_branch("/repo", "  ").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
    }

    #[test]
    fn maps_time_stats_with_null_human_fields() {
        // The exact live shape after setting an estimate with no spent time:
        // human_total_time_spent is null, which must map onto "".
        let json = r#"{
            "time_estimate": 10800,
            "total_time_spent": 0,
            "human_time_estimate": "3h",
            "human_total_time_spent": null
        }"#;
        let s = from_glab_time_stats(serde_json::from_str(json).unwrap());
        assert_eq!(s.time_estimate, 10800);
        assert_eq!(s.total_time_spent, 0);
        assert_eq!(s.human_time_estimate, "3h");
        assert_eq!(s.human_total_time_spent, "");
    }

    #[test]
    fn maps_time_stats_all_zero_nulls_both_human_fields() {
        // A freshly reset target: both human fields null → "".
        let json = r#"{
            "time_estimate": 0,
            "total_time_spent": 0,
            "human_time_estimate": null,
            "human_total_time_spent": null
        }"#;
        let s = from_glab_time_stats(serde_json::from_str(json).unwrap());
        assert_eq!(s.human_time_estimate, "");
        assert_eq!(s.human_total_time_spent, "");
    }

    #[test]
    fn time_write_endpoint_routes_set_vs_reset() {
        // A real duration hits the set/add endpoint…
        assert_eq!(
            time_write_endpoint(TimeWrite::Estimate, Some("3h")),
            "time_estimate"
        );
        assert_eq!(
            time_write_endpoint(TimeWrite::Spent, Some("45m")),
            "add_spent_time"
        );
        // …negative durations are still real durations (server-validated).
        assert_eq!(
            time_write_endpoint(TimeWrite::Spent, Some("-15m")),
            "add_spent_time"
        );
        // None or blank/whitespace-only routes to the reset endpoint.
        assert_eq!(
            time_write_endpoint(TimeWrite::Estimate, None),
            "reset_time_estimate"
        );
        assert_eq!(
            time_write_endpoint(TimeWrite::Estimate, Some("")),
            "reset_time_estimate"
        );
        assert_eq!(
            time_write_endpoint(TimeWrite::Spent, Some("   ")),
            "reset_spent_time"
        );
    }

    #[test]
    fn maps_linked_issue_to_neutral() {
        // The live shape: a full issue object augmented with issue_link_id + link_type.
        let json = r#"{
            "issue_link_id": 812,
            "iid": 4,
            "title": "Related crash on startup",
            "state": "opened",
            "link_type": "relates_to",
            "web_url": "https://gitlab.com/g/r/-/issues/4"
        }"#;
        let l = from_glab_linked_issue(serde_json::from_str(json).unwrap());
        // issue_link_id serialized as a STRING (repo id-over-IPC rule).
        assert_eq!(l.link_id, "812");
        assert_eq!(l.number, 4);
        assert_eq!(l.title, "Related crash on startup");
        // opened → OPEN.
        assert_eq!(l.state, "OPEN");
        assert_eq!(l.link_type, "relates_to");
        assert_eq!(l.web_url, "https://gitlab.com/g/r/-/issues/4");
    }

    #[test]
    fn linked_issue_maps_closed_state() {
        let json = r#"{
            "issue_link_id": 900,
            "iid": 9,
            "title": "Fixed elsewhere",
            "state": "closed",
            "link_type": "relates_to",
            "web_url": "https://gitlab.com/g/r/-/issues/9"
        }"#;
        let l = from_glab_linked_issue(serde_json::from_str(json).unwrap());
        // closed → CLOSED.
        assert_eq!(l.state, "CLOSED");
    }
}
