//! The Bitbucket Cloud [`Forge`](super::Forge) implementation, over direct HTTPS
//! (`api.bitbucket.org/2.0`) via the [`http`](super::http) layer. Like the GitLab impl,
//! every read maps Bitbucket's JSON onto the SAME neutral models the GitHub panels
//! render, so the frontend stays provider-agnostic. Absent by PLATFORM limitation:
//! issues (the native tracker is deleted platform-wide 2026-08-20) and
//! reactions/labels/milestones (Cloud has none).
//!
//! Auth is HTTP Basic (`{atlassian_account_email}:{api_token}`) for the REST API — app
//! passwords are dead — with the token in the OS keyring under `forge/bitbucket.org/*`.
//! git-over-HTTPS is the exception: it needs the literal `x-bitbucket-api-token-auth`
//! sentinel username (NOT the email) plus the same token, seeded into git's credential
//! store on STDIN by [`seed_git_credential`].
//!
//! Pagination default: one page at the endpoint's max `pagelen`, no `next`-following
//! (the PR-list endpoint caps at 50; repos/pipelines allow 100). Readers that DO follow
//! `next` bound it at 5 pages and say so at their call site.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri_plugin_http::reqwest;

use crate::error::{AppError, AppResult};
use crate::forge::encode_query_value;
use crate::forge::gitlab::null_to_default;
use crate::forge::http::{
    self, BbCredentials, BB_HOST, KEY_DISPLAY_NAME, KEY_EMAIL, KEY_TOKEN, KEY_USERNAME,
};
use crate::forge::model::{
    Capabilities, CompletedReviewerOut, ForgeForkResult, ForgeRepo, ForgeRepoList, ForgeSearchList,
    ForgeSearchRepo, ForgeStatus, ForgeUserRef, Implemented, Provider,
};
use crate::forge::{cap_readme, validate_owner, validate_repo_name};
use crate::forge::Forge;
use crate::github::actions::{RunDetail, RunJob, WorkflowRun};
use crate::github::pr::{
    ApprovalState, CommitCommentOut, DraftCommentIn, PrAuthor, PrCiRefIn, PrCiStatus, PrCommitOut,
    PrDetails, PrFileOut, PrInfo, PrListLabel, PrPollInfo, PrRef, PrThreadOut, PrTimelineEventOut,
    ReviewSubmitOut, ReviewThreadOut,
};

/// Whether this process has SUCCESSFULLY seeded git's credential store this session
/// (the seed persists in the OS store, so re-seeding every op is wasteful). Set only
/// AFTER `git credential approve` exits 0 — a failed attempt leaves it false so a
/// later op retries. Re-armed by `reset_credential_seed` when the stored token
/// changes. See [`seed_git_credential`].
static CREDENTIAL_SEEDED: AtomicBool = AtomicBool::new(false);
/// Serializes concurrent seed attempts so the first ops of a session (e.g. fetches
/// on two repos at once) don't race: losers WAIT here until the winner's seed lands,
/// instead of proceeding unauthenticated into their git op.
static CREDENTIAL_SEED_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Failed-step logs can run to many MB; keep the tail (failures land at the end).
const CI_RUN_LOG_CAP: usize = 200_000;
/// Tighter per-step cap (a step log is also fed to the AI debugger).
const CI_STEP_LOG_CAP: usize = 60_000;
/// Cap the PR diff like the gh/gitlab paths so a pathological PR can't blow up the viewer.
const PR_DIFF_CAP: usize = 2_000_000;

/// Bitbucket Cloud, over HTTPS. Carries the repo's host (always `bitbucket.org` for
/// Cloud; Bitbucket Server is out of scope).
pub struct BitbucketForge {
    host: String,
}

impl BitbucketForge {
    pub fn new(host: String) -> Self {
        Self { host }
    }
}

// ── Status ────────────────────────────────────────────────────────────────────

/// Assemble the neutral status from the Bitbucket probes. Pure (testable), mirroring
/// `gitlab_status`: `installed` = a token is stored, `authenticated` = the `/user`
/// probe succeeded, `login` = the resolved username/display name, `repo` = the
/// workspace/slug from the origin remote (filled regardless of auth).
fn bitbucket_status(
    installed: bool,
    authenticated: bool,
    host: &str,
    repo: Option<String>,
    login: Option<String>,
) -> ForgeStatus {
    ForgeStatus {
        provider: Some(Provider::Bitbucket),
        installed,
        authenticated,
        repo,
        host: Some(host.to_string()),
        login,
        capabilities: Capabilities::for_provider(Provider::Bitbucket),
        implemented: Implemented::for_provider(Provider::Bitbucket),
    }
}

impl Forge for BitbucketForge {
    async fn status(&self, repo_path: &str) -> AppResult<ForgeStatus> {
        // The workspace/slug from the origin remote — filled regardless of auth,
        // mirroring GitLab (a recognized-but-signed-out repo still shows its slug).
        let repo = workspace_slug(repo_path)
            .await
            .ok()
            .map(|(w, s)| format!("{w}/{s}"));

        // No token stored → installed:false and NO network call at all.
        let creds = match http::load_credentials().await {
            Ok(c) => c,
            Err(AppError::BitbucketNotConfigured) => {
                return Ok(bitbucket_status(false, false, &self.host, repo, None));
            }
            Err(e) => return Err(e),
        };

        // Token present. Probe `/user`; a success authenticates and yields the login.
        match http::bb_get_json::<BbUser>(&creds, "user", "user").await {
            Ok(user) => {
                let login = user.username.or(user.display_name);
                Ok(bitbucket_status(true, true, &self.host, repo, login))
            }
            // A stored-but-invalid/expired token: installed (we have one) but not
            // authenticated. Fall back to the stored username for the login label.
            Err(AppError::Bitbucket(_)) => {
                let login = read_stored_username().await;
                Ok(bitbucket_status(true, false, &self.host, repo, login))
            }
            Err(e) => Err(e),
        }
    }
}

/// The workspace + repo slug (`{workspace}/{slug}`) from the repo's origin remote.
async fn workspace_slug(repo_path: &str) -> AppResult<(String, String)> {
    let url =
        crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await?;
    let path = crate::forge::remote_path(&url).ok_or_else(|| {
        AppError::Bitbucket(
            "could not determine the Bitbucket repository from the origin remote".into(),
        )
    })?;
    // Bitbucket repo paths are exactly `workspace/slug` (no nested groups).
    let mut parts = path.splitn(2, '/');
    match (parts.next(), parts.next()) {
        (Some(w), Some(s)) if !w.is_empty() && !s.is_empty() => Ok((w.to_string(), s.to_string())),
        _ => Err(AppError::Bitbucket(format!(
            "unexpected Bitbucket repository path: {path}"
        ))),
    }
}

/// Read the stored username from the keyring (best-effort, no network).
async fn read_stored_username() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::read_forge_secret(BB_HOST, KEY_USERNAME)
            .ok()
            .flatten()
    })
    .await
    .ok()
    .flatten()
    .filter(|s| !s.is_empty())
}

// ── Account commands (set / clear / read) ──────────────────────────────────────

/// The account info returned to the frontend after connecting (or when reading the
/// stored account). The TOKEN is never included — it stays in the keyring only.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BbAccountInfo {
    pub email: String,
    pub username: Option<String>,
    pub display_name: Option<String>,
}

/// A Bitbucket user (`/2.0/user`, or an embedded author object). For other users
/// `username` is absent (privacy) — only the authenticated self carries it, so the
/// stable cross-user identity is `uuid` (braced, present on every user object).
#[derive(Deserialize)]
struct BbUser {
    /// The braced account UUID (`{…}`) — the ONE identity field present on both the
    /// self object and other users' participant objects, so it's what reconciles the
    /// viewer against a PR participant.
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    /// `links.avatar.href` — the profile image, for the reviewer picker. Present on
    /// the unfielded single-PR GET and default-reviewers; the workspace-members read
    /// requests it explicitly (its `fields=` filter would otherwise omit it).
    #[serde(default)]
    links: Option<BbUserLinks>,
}

#[derive(Deserialize)]
struct BbUserLinks {
    #[serde(default)]
    avatar: Option<BbUserLink>,
}

#[derive(Deserialize)]
struct BbUserLink {
    #[serde(default)]
    href: String,
}

/// Connect a Bitbucket account: validate the creds via `GET /2.0/user` BEFORE
/// persisting anything (a pre-mutation guard — nothing is written if validation
/// fails), then store email/token/username in the keyring and return the account
/// info (never the token). The error distinguishes a network failure from a 401
/// invalid-token (`http_error` special-cases 401).
pub async fn set_account(email: &str, token: &str) -> AppResult<BbAccountInfo> {
    let email = email.trim().to_string();
    let token = token.trim().to_string();
    if email.is_empty() || token.is_empty() {
        return Err(AppError::InvalidArgument(
            "an email and API token are both required".into(),
        ));
    }
    // Validate with the provided creds (not the stored ones) before writing.
    let creds = BbCredentials {
        email: email.clone(),
        token: token.clone(),
    };
    let user: BbUser = http::bb_get_json(&creds, "user", "user").await?;
    let username = user.username.clone();
    let display_name = user.display_name.clone();

    // Validated — persist all entries (blocking keyring writes off-thread).
    let (kr_email, kr_token, kr_username, kr_display_name) = (
        email.clone(),
        token.clone(),
        username.clone(),
        display_name.clone(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        crate::secrets::set_forge_secret(BB_HOST, KEY_EMAIL, &kr_email)?;
        crate::secrets::set_forge_secret(BB_HOST, KEY_TOKEN, &kr_token)?;
        // Store the username too (drives the signed-out `login` label); clear a
        // stale one if the account has no username.
        match &kr_username {
            Some(u) if !u.is_empty() => crate::secrets::set_forge_secret(BB_HOST, KEY_USERNAME, u)?,
            _ => crate::secrets::delete_forge_secret(BB_HOST, KEY_USERNAME)?,
        }
        // Persist the display name too (so `account()` can surface it after a
        // restart); clear a stale one when the account has none.
        match &kr_display_name {
            Some(d) if !d.is_empty() => {
                crate::secrets::set_forge_secret(BB_HOST, KEY_DISPLAY_NAME, d)?
            }
            _ => crate::secrets::delete_forge_secret(BB_HOST, KEY_DISPLAY_NAME)?,
        }
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Bitbucket(format!("keyring task failed: {e}")))??;

    // The stored token changed — drop the cached credential and re-arm the seed
    // latch so the next load reads the new token and the next git op re-seeds.
    // Taken UNDER the seed lock: once we hold it, no seed is in flight, so an
    // old-token seed that raced this connect has fully finished — our reset then
    // guarantees the next op re-seeds (upserting the store entry with the NEW
    // token) instead of fast-pathing on the stale latch.
    {
        let _seed_guard = CREDENTIAL_SEED_LOCK.lock().await;
        http::invalidate_credential_cache();
        reset_credential_seed();
    }

    Ok(BbAccountInfo {
        email,
        username,
        display_name,
    })
}

/// Disconnect the Bitbucket account — delete all keyring entries (a missing
/// entry is tolerated).
pub async fn clear_account() -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::delete_forge_secret(BB_HOST, KEY_EMAIL)?;
        crate::secrets::delete_forge_secret(BB_HOST, KEY_TOKEN)?;
        crate::secrets::delete_forge_secret(BB_HOST, KEY_USERNAME)?;
        crate::secrets::delete_forge_secret(BB_HOST, KEY_DISPLAY_NAME)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Bitbucket(format!("keyring task failed: {e}")))??;
    // Drop the cached credential, re-arm the seed latch, and evict the seeded entry
    // from git's OS credential store — git's store is SEPARATE from our keyring, so
    // without the eviction a disconnected account keeps authenticating git ops until
    // the token expires. All UNDER the seed lock, so an in-flight seed can't land after
    // us and silently undo the reset + evict.
    let _seed_guard = CREDENTIAL_SEED_LOCK.lock().await;
    http::invalidate_credential_cache();
    reset_credential_seed();
    evict_git_credential().await;
    Ok(())
}

/// The stored account (keyring existence read ONLY — no network). `None` when no
/// token is stored. The token is never returned.
pub async fn account() -> AppResult<Option<BbAccountInfo>> {
    tauri::async_runtime::spawn_blocking(|| {
        let email = crate::secrets::read_forge_secret(BB_HOST, KEY_EMAIL)?;
        let token = crate::secrets::read_forge_secret(BB_HOST, KEY_TOKEN)?;
        let username = crate::secrets::read_forge_secret(BB_HOST, KEY_USERNAME)?;
        let display_name = crate::secrets::read_forge_secret(BB_HOST, KEY_DISPLAY_NAME)?;
        Ok::<_, AppError>(match (email, token) {
            (Some(email), Some(token)) if !email.is_empty() && !token.is_empty() => {
                Some(BbAccountInfo {
                    email,
                    username: username.filter(|u| !u.is_empty()),
                    display_name: display_name.filter(|d| !d.is_empty()),
                })
            }
            _ => None,
        })
    })
    .await
    .map_err(|e| AppError::Bitbucket(format!("keyring task failed: {e}")))?
}

// ── Shared JSON shapes ─────────────────────────────────────────────────────────

/// A Bitbucket link object (`{href}`); many are optional.
#[derive(Deserialize, Default, Clone)]
struct BbLink {
    #[serde(default)]
    href: String,
}

/// A named clone link (`{name: "https"|"ssh", href}`).
#[derive(Deserialize, Default)]
struct BbCloneLink {
    #[serde(default)]
    name: String,
    #[serde(default)]
    href: String,
}

/// A paginated envelope (`{values, …}`). `next` is ignored under the single-page
/// policy; kept undeserialized.
#[derive(Deserialize)]
struct BbPage<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
}

impl<T> Default for BbPage<T> {
    fn default() -> Self {
        Self { values: Vec::new() }
    }
}

// ── Repository listing (clone browser) ─────────────────────────────────────────

/// The nested `workspace_base` object inside a `/2.0/user/workspaces` membership
/// wrapper (also embedded on a repo object). Only the slug is needed; the base
/// shape carries no `name` field (unlike a full workspace object), so we never
/// depend on one. `#[serde(default)]` tolerates a missing slug (skipped downstream).
#[derive(Deserialize)]
struct BbWorkspace {
    #[serde(default)]
    slug: String,
}

/// One membership entry of `GET /2.0/user/workspaces` (a `workspace_access`
/// wrapper). The `workspace` is optional/tolerant — an entry with no nested
/// workspace or an empty slug is skipped rather than erroring.
#[derive(Deserialize)]
struct BbWorkspaceAccess {
    #[serde(default)]
    workspace: Option<BbWorkspace>,
}

/// The links block on a repo object (clone URLs).
#[derive(Deserialize, Default)]
struct BbRepoLinks {
    #[serde(default, deserialize_with = "null_to_default")]
    clone: Vec<BbCloneLink>,
}

/// A repository as `GET /2.0/repositories/{workspace}` returns it.
#[derive(Deserialize)]
struct BbRepo {
    #[serde(default)]
    name: String,
    #[serde(default)]
    full_name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    is_private: bool,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    updated_on: Option<String>,
    #[serde(default)]
    parent: Option<serde_json::Value>,
    #[serde(default)]
    links: Option<BbRepoLinks>,
    #[serde(default)]
    workspace: Option<BbWorkspace>,
}

fn from_bb_repo(r: BbRepo) -> ForgeRepo {
    let links = r.links.unwrap_or_default();
    let clone_url = links
        .clone
        .iter()
        .find(|c| c.name == "https")
        .map(|c| c.href.clone())
        .unwrap_or_default();
    let ssh_url = links
        .clone
        .iter()
        .find(|c| c.name == "ssh")
        .map(|c| c.href.clone())
        .unwrap_or_default();
    // Owner = the workspace slug; Bitbucket's full_name is already "workspace/slug".
    let owner = r
        .workspace
        .map(|w| w.slug)
        .filter(|s| !s.is_empty())
        .or_else(|| r.full_name.split('/').next().map(str::to_string))
        .unwrap_or_default();
    ForgeRepo {
        full_name: r.full_name,
        owner,
        name: r.name,
        private: r.is_private,
        // Bitbucket Cloud has no repository-archived concept.
        archived: false,
        fork: r.parent.is_some(),
        clone_url,
        ssh_url,
        description: r.description,
        pushed_at: r.updated_on,
    }
}

/// The signed-in user's repositories, for the clone browser. Both `GET
/// /2.0/repositories?role=member` AND `GET /2.0/workspaces` were removed (CHANGE-2770,
/// Feb 2026); the replacement is `GET /2.0/user/workspaces` (CHANGE-3022), whose items
/// are `workspace_access` membership wrappers (nested `workspace_base` with
/// uuid/slug/links — no `name`). We list the viewer's workspaces, then each workspace's
/// member repos: one page each at the max `pagelen` (100), sorted `-updated_on`, so
/// repos past 100/workspace drop off.
pub async fn list_repos() -> AppResult<ForgeRepoList> {
    let creds = http::load_credentials().await?;
    let viewer = http::bb_get_json::<BbUser>(&creds, "user", "user")
        .await
        .ok()
        .and_then(|u| u.username.or(u.display_name))
        .unwrap_or_default();

    let workspaces: BbPage<BbWorkspaceAccess> =
        http::bb_get_json(&creds, "user/workspaces?pagelen=100", "workspaces").await?;

    let mut repos = Vec::new();
    // Best-effort per workspace (one erroring shouldn't sink the others), but if EVERY
    // fetch fails, surface the last error rather than an empty "no repositories" list.
    let mut workspace_count = 0usize;
    let mut any_ok = false;
    let mut last_err: Option<AppError> = None;
    for access in workspaces.values {
        // Skip an entry with no nested workspace or an empty slug rather than error.
        let Some(slug) = access.workspace.map(|w| w.slug).filter(|s| !s.is_empty()) else {
            continue;
        };
        workspace_count += 1;
        let path = format!(
            "repositories/{}?role=member&sort=-updated_on&pagelen=100",
            encode_query_value(&slug)
        );
        match http::bb_get_json::<BbPage<BbRepo>>(&creds, &path, "repositories").await {
            Ok(page) => {
                any_ok = true;
                repos.extend(page.values.into_iter().map(from_bb_repo));
            }
            Err(e) => last_err = Some(e),
        }
    }
    if workspace_count > 0 && !any_ok {
        // Every workspace fetch failed — return the last error, not an empty Ok.
        return Err(last_err.unwrap_or_else(|| {
            AppError::Bitbucket("could not list Bitbucket repositories".into())
        }));
    }
    Ok(ForgeRepoList { viewer, repos })
}

// ── Pull requests (read) ───────────────────────────────────────────────────────

/// Map Bitbucket's PR state onto the neutral `"OPEN"/"MERGED"/"CLOSED"` the frontend
/// renders (DECLINED and SUPERSEDED both collapse to CLOSED).
fn map_bb_pr_state(state: &str) -> String {
    match state {
        "OPEN" => "OPEN".to_string(),
        "MERGED" => "MERGED".to_string(),
        "DECLINED" | "SUPERSEDED" => "CLOSED".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

/// A PR branch ref (`{branch:{name}, commit:{hash}}`).
#[derive(Deserialize, Default)]
struct BbPrEndpoint {
    #[serde(default)]
    branch: Option<BbBranchRef>,
    /// The endpoint's head commit — its `hash` feeds the per-commit CI-status probe
    /// (Bitbucket has no batch pipeline endpoint). Short hash is fine for `.../statuses`.
    #[serde(default)]
    commit: Option<BbCommitRef>,
}

#[derive(Deserialize, Default)]
struct BbBranchRef {
    #[serde(default)]
    name: String,
}

/// The `links.html.href` block shared by PRs, comments, etc.
#[derive(Deserialize, Default)]
struct BbHtmlLinks {
    #[serde(default)]
    html: Option<BbLink>,
}

/// A pull request as the list/detail endpoints return it. The list payload omits
/// reviewers/participants (single-PR GET only); the fields here are the common set.
#[derive(Deserialize)]
struct BbPr {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default, deserialize_with = "null_to_default")]
    draft: bool,
    #[serde(default)]
    author: Option<BbUser>,
    #[serde(default)]
    source: Option<BbPrEndpoint>,
    #[serde(default)]
    destination: Option<BbPrEndpoint>,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
    /// The reviewer list (present on the unfielded single-PR GET) — feeds the
    /// reviewers picker. Distinct from `participants`, which also includes
    /// commenters/approvers who were never asked to review.
    #[serde(default)]
    reviewers: Vec<BbUser>,
    /// The participant list (present on the unfielded single-PR GET). Carries each
    /// participant's approval `state`, so `view_pr` derives completed reviewers without
    /// a second fetch. Wider than `reviewers`: includes commenters/approvers who were
    /// never asked to review.
    #[serde(default, deserialize_with = "null_to_default")]
    participants: Vec<BbParticipant>,
    /// ISO-8601 open time (`created_on`); "" when absent.
    #[serde(default)]
    created_on: String,
}

/// Best display login for a Bitbucket user: display_name else nickname (other users
/// carry no username — only the authenticated self does).
fn user_login(u: &BbUser) -> String {
    u.display_name
        .clone()
        .or_else(|| u.nickname.clone())
        .or_else(|| u.username.clone())
        .unwrap_or_default()
}

/// The user's avatar URL (`links.avatar.href`), or empty when absent.
fn user_avatar(u: &BbUser) -> String {
    u.links
        .as_ref()
        .and_then(|l| l.avatar.as_ref())
        .map(|a| a.href.clone())
        .unwrap_or_default()
}

fn branch_name(ep: &Option<BbPrEndpoint>) -> String {
    ep.as_ref()
        .and_then(|e| e.branch.as_ref())
        .map(|b| b.name.clone())
        .unwrap_or_default()
}

fn html_href(links: &Option<BbHtmlLinks>) -> String {
    links
        .as_ref()
        .and_then(|l| l.html.as_ref())
        .map(|h| h.href.clone())
        .unwrap_or_default()
}

fn from_bb_pr(p: BbPr) -> PrInfo {
    PrInfo {
        number: p.id,
        url: html_href(&p.links),
        title: p.title,
        base_ref_name: branch_name(&p.destination),
        head_ref_name: branch_name(&p.source),
        is_draft: p.draft,
        state: map_bb_pr_state(&p.state),
        author: p.author.as_ref().map(|a| PrAuthor {
            login: user_login(a),
        }),
        // Bitbucket PRs have no labels.
        labels: Vec::<PrListLabel>::new(),
        created_at: p.created_on,
        // The source (head) commit's hash, for the per-commit CI-status probe.
        head_sha: p
            .source
            .as_ref()
            .and_then(|s| s.commit.as_ref())
            .map(|c| c.hash.clone())
            .unwrap_or_default(),
        // Bitbucket has no stacked-PR concept — nothing to probe, so nothing unknown.
        stack: None,
        stack_unknown: false,
    }
}

/// The `state` query fragment for a PR-list filter: `"open"` → one `state=OPEN`,
/// `"closed"` → the repeatable-param merge of MERGED/DECLINED/SUPERSEDED. Unknown
/// filters error (mirroring GitLab). Pure — validated before any I/O.
fn pr_state_filter(state: &str) -> AppResult<&'static str> {
    match state {
        "open" => Ok("state=OPEN"),
        "closed" => Ok("state=MERGED&state=DECLINED&state=SUPERSEDED"),
        other => Err(AppError::InvalidArgument(format!(
            "unknown PR state filter: {other}"
        ))),
    }
}

/// The repo's pull requests. `state` is `"open"` (→ one call `state=OPEN`) or
/// `"closed"` (→ one call merging `MERGED`/`DECLINED`/`SUPERSEDED` via the repeatable
/// `state` param). `pagelen` maxes at 50 for this endpoint. Unknown filters error.
pub async fn list_prs(repo_path: &str, state: &str, limit: Option<u32>) -> AppResult<Vec<PrInfo>> {
    let states = pr_state_filter(state)?;
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    // Bitbucket returns one page; `pagelen` maxes at 50. Default to a full page, or
    // cap it to `limit` and truncate (a multi-state filter can over-return).
    let pagelen = limit.map_or(50, |n| n.clamp(1, 50));
    let path = format!(
        "repositories/{}/{}/pullrequests?{states}&pagelen={pagelen}",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    let page: BbPage<BbPr> = http::bb_get_json(&creds, &path, "pull requests").await?;
    let mut prs: Vec<PrInfo> = page.values.into_iter().map(from_bb_pr).collect();
    if let Some(n) = limit {
        prs.truncate(n as usize);
    }
    Ok(prs)
}

/// Open PRs whose source branch is `head` — the ComparePanel duplicate probe. Uses
/// Bitbucket's BBQL query filter. Rejects an empty/`-`-leading head (mirroring
/// GitLab) and a head containing `"` or `\` (which would break the quoted BBQL
/// value — reject rather than invent escaping); the value is percent-encoded.
pub async fn prs_for_branch(repo_path: &str, head: &str) -> AppResult<Vec<PrInfo>> {
    if head.is_empty() || head.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid branch: {head}")));
    }
    if head.contains('"') || head.contains('\\') {
        return Err(AppError::InvalidArgument(format!(
            "unexpected characters in branch name: {head}"
        )));
    }
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let query = format!(r#"source.branch.name="{head}" AND state="OPEN""#);
    let path = format!(
        "repositories/{}/{}/pullrequests?q={}&pagelen=50",
        encode_query_value(&ws),
        encode_query_value(&slug),
        encode_query_value(&query),
    );
    let page: BbPage<BbPr> = http::bb_get_json(&creds, &path, "pull requests").await?;
    Ok(page.values.into_iter().map(from_bb_pr).collect())
}

// ── Pull-request poll (notifications + remote pr-sync) ─────────────────────────

/// A pull request as the poll endpoint returns it. `source.commit.hash` is the SHORT
/// 12-char head sha (not the full OID the list/detail source carries elsewhere);
/// `author.uuid` matches the viewer's uuid so an own-PR notification is suppressed.
#[derive(Deserialize)]
struct BbPollPr {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default, deserialize_with = "null_to_default")]
    draft: bool,
    #[serde(default)]
    author: Option<BbUser>,
    #[serde(default)]
    source: Option<BbPollEndpoint>,
    #[serde(default)]
    destination: Option<BbPollEndpoint>,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
    #[serde(default)]
    created_on: String,
}

/// The `source`/`destination` block of a poll PR — its head commit hash and
/// branch name matter here.
#[derive(Deserialize, Default)]
struct BbPollEndpoint {
    #[serde(default)]
    commit: Option<BbPollCommit>,
    #[serde(default)]
    branch: Option<BbBranchRef>,
}

#[derive(Deserialize, Default)]
struct BbPollCommit {
    #[serde(default)]
    hash: String,
}

/// Map a poll PR onto the neutral [`PrPollInfo`], resolving the author so the hook's
/// `mine` check (poll author == `ForgeStatus.login`) works despite Bitbucket's
/// privacy behavior: participant/author objects carry NO `username`, only `uuid` +
/// `nickname`. When the PR's `author.uuid` matches the viewer's, emit the stored
/// username (what `status().login` carries for Bitbucket) so the user isn't notified
/// about their own just-created PR; otherwise fall back to the author's nickname.
fn from_bb_poll_pr(p: BbPollPr, viewer_uuid: &str, viewer_login: &str) -> PrPollInfo {
    let author = match p.author.as_ref() {
        Some(a) if !viewer_uuid.is_empty() && a.uuid.as_deref() == Some(viewer_uuid) => {
            viewer_login.to_string()
        }
        Some(a) => a.nickname.clone().unwrap_or_default(),
        None => String::new(),
    };
    let poll_branch = |ep: &Option<BbPollEndpoint>| {
        ep.as_ref()
            .and_then(|e| e.branch.as_ref())
            .map(|b| b.name.clone())
            .unwrap_or_default()
    };
    let head_ref_name = poll_branch(&p.source);
    let base_ref_name = poll_branch(&p.destination);
    PrPollInfo {
        number: p.id,
        title: p.title,
        url: html_href(&p.links),
        state: map_bb_pr_state(&p.state),
        is_draft: p.draft,
        author,
        // Bitbucket's PR LIST carries no review decision or check rollup (both need the
        // single-PR / pipeline reads), so the poller's checks/review branches never
        // fire (a documented v1 limit).
        review_decision: String::new(),
        checks_state: String::new(),
        // The 12-char SHORT sha as-is; `sameSha` on the frontend prefix-matches it
        // against the full head sha seeded by pr-open events.
        head_sha: p.source.and_then(|s| s.commit).map(|c| c.hash).unwrap_or_default(),
        // New-comment / new-review / review-requested detection is GitHub-only in v1 —
        // Bitbucket's PR list carries none of these.
        comment_count: 0,
        last_comment_author: String::new(),
        review_count: 0,
        last_review_author: String::new(),
        review_requests: Vec::new(),
        head_ref_name,
        base_ref_name,
        // PR open time — the missed-open catch-up's recency anchor.
        created_at: p.created_on,
    }
}

/// A lightweight snapshot of the repo's recently-updated PRs for the notification
/// poller — the Bitbucket analogue of `gh_pr_poll`. One list call ordered by
/// `-updated_on` across all states, plus one `GET /2.0/user` to resolve the viewer's
/// uuid (so own-PR notifications are suppressed). `head_sha` (the short head hash)
/// drives pr-sync re-review.
pub async fn poll_prs(repo_path: &str) -> AppResult<Vec<PrPollInfo>> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let path = format!(
        "repositories/{}/{}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=20",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    let page: BbPage<BbPollPr> = http::bb_get_json(&creds, &path, "pull requests").await?;

    // Resolve the viewer's identity (uuid to match the author, login to emit as the
    // author when it's the viewer's own PR) — one GET, like `pr_approvals`.
    let self_user = http::bb_get_json::<BbUser>(&creds, "user", "user").await.ok();
    let viewer_uuid = self_user
        .as_ref()
        .and_then(|u| u.uuid.clone())
        .unwrap_or_default();
    let viewer_login = read_stored_username().await.unwrap_or_else(|| {
        self_user
            .as_ref()
            .and_then(|u| u.username.clone().or_else(|| u.display_name.clone()))
            .unwrap_or_default()
    });

    Ok(page
        .values
        .into_iter()
        .map(|p| from_bb_poll_pr(p, &viewer_uuid, &viewer_login))
        .collect())
}

/// A PR commit (`{hash, date, message, summary, author {raw, user}}`).
#[derive(Deserialize)]
struct BbCommit {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    summary: Option<BbRendered>,
    #[serde(default)]
    author: Option<BbCommitAuthor>,
}

#[derive(Deserialize, Default)]
struct BbRendered {
    #[serde(default)]
    raw: String,
}

#[derive(Deserialize, Default)]
struct BbCommitAuthor {
    #[serde(default)]
    raw: String,
    #[serde(default)]
    user: Option<BbUser>,
}

/// A diffstat entry (`{status, lines_added, lines_removed, old:{path}|null, new:{path}|null}`).
#[derive(Deserialize)]
struct BbDiffstat {
    #[serde(default)]
    lines_added: u32,
    #[serde(default)]
    lines_removed: u32,
    #[serde(default)]
    old: Option<BbPathItem>,
    #[serde(default)]
    new: Option<BbPathItem>,
}

#[derive(Deserialize, Default)]
struct BbPathItem {
    #[serde(default)]
    path: String,
}

/// A PR comment (`{id, content:{raw}, user, created_on, deleted, pending, inline?,
/// parent?}`). A reply carries `parent: {id, links}`; only the ROOT inline comment
/// carries `inline` — replies anchor via `parent` alone. No `resolution` key was
/// present on any PROBED comment (general, inline, or reply), so thread-resolution is
/// unwired for Bitbucket (`mr_thread_resolve` false).
#[derive(Deserialize)]
struct BbComment {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    content: Option<BbRendered>,
    #[serde(default)]
    user: Option<BbUser>,
    #[serde(default)]
    created_on: String,
    #[serde(default, deserialize_with = "null_to_default")]
    deleted: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    pending: bool,
    /// Present only for inline (file) comments; general comments omit it. Only the
    /// root inline comment carries this — replies anchor via `parent` (probed).
    #[serde(default)]
    inline: Option<BbInline>,
    /// Present on replies — the id of the comment this one answers. Absent on roots.
    #[serde(default)]
    parent: Option<BbParent>,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
}

#[derive(Deserialize, Default)]
struct BbInline {
    #[serde(default)]
    path: String,
    #[serde(default)]
    to: Option<u64>,
    #[serde(default)]
    from: Option<u64>,
}

/// A comment's `parent` ref (present on replies). Only the id matters for
/// grouping a reply back to its thread root.
#[derive(Deserialize, Default)]
struct BbParent {
    #[serde(default)]
    id: u64,
}

/// A commit status (`{key, name, state, url, created_on, updated_on}`). These are
/// external build statuses (Pipelines or a third-party CI reporting in), so they
/// link out via `url` and carry no inline-log affordance (no run/job id).
#[derive(Deserialize)]
struct BbCommitStatus {
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: String,
    /// The build's web link (`SUCCESSFUL` Pipeline result page, external CI URL, …).
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    created_on: Option<String>,
    #[serde(default)]
    updated_on: Option<String>,
}

/// Map a Bitbucket commit-status state onto the vocabulary `RemotePrView`'s
/// `checkPresentation` keys on (uppercased): SUCCESS → passed, FAILURE → failed,
/// anything else → pending. Bitbucket sends SUCCESSFUL/FAILED/INPROGRESS/STOPPED.
fn map_bb_check_state(state: &str) -> String {
    match state {
        "SUCCESSFUL" => "SUCCESS".to_string(),
        "FAILED" => "FAILURE".to_string(),
        "STOPPED" => "CANCELLED".to_string(),
        // INPROGRESS (and anything unknown) → the frontend's pending bucket.
        _ => "PENDING".to_string(),
    }
}

/// Reduce a commit's build-status states (Bitbucket `state`: SUCCESSFUL/FAILED/
/// INPROGRESS/STOPPED, plus any unknown) to one neutral list-row CI signal.
/// Precedence: any FAILED/STOPPED → failing; else any INPROGRESS or unrecognized
/// state → pending (conservative — never a false green); else at least one
/// SUCCESSFUL → passing; an empty status set → none (no checks reported).
fn reduce_bb_ci(states: &[String]) -> String {
    if states.is_empty() {
        return "none".to_string();
    }
    let up: Vec<String> = states.iter().map(|s| s.trim().to_ascii_uppercase()).collect();
    if up.iter().any(|s| s == "FAILED" || s == "STOPPED") {
        return "failing".to_string();
    }
    if up.iter().any(|s| s != "SUCCESSFUL") {
        // INPROGRESS or any value we don't recognize → still-running / unknown.
        return "pending".to_string();
    }
    "passing".to_string()
}

/// The CI rollup for a set of PRs, keyed by number — the Bitbucket arm of
/// `forge_pr_list_ci`. Bitbucket has NO batch pipeline endpoint, so this probes each
/// PR's head commit `.../commit/{sha}/statuses` individually. Best-effort: refs with an
/// empty `head_sha` are skipped, the set is capped at the FIRST 50 PRs, a per-PR failure
/// just omits that icon, and the probes run SEQUENTIALLY (no concurrency idiom in this
/// module; a capped best-effort probe doesn't justify inventing one).
pub async fn pr_list_ci(repo_path: &str, prs: &[PrCiRefIn]) -> AppResult<Vec<PrCiStatus>> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;

    let mut result: Vec<PrCiStatus> = Vec::new();
    // Cap at the first 50 PRs (best-effort decoration; no N+1 blow-up on huge pages).
    for pr in prs.iter().filter(|p| !p.head_sha.is_empty()).take(50) {
        let path = format!(
            "repositories/{}/{}/commit/{}/statuses?pagelen=100",
            encode_query_value(&ws),
            encode_query_value(&slug),
            encode_query_value(&pr.head_sha),
        );
        // Per-call tolerance: a failed fetch just leaves this PR without an icon.
        let Ok(page) = http::bb_get_json::<BbPage<BbCommitStatus>>(&creds, &path, "statuses").await
        else {
            continue;
        };
        let states: Vec<String> = page.values.into_iter().map(|s| s.state).collect();
        result.push(PrCiStatus {
            number: pr.number,
            ci_status: reduce_bb_ci(&states),
        });
    }
    Ok(result)
}

fn commit_headline(c: &BbCommit) -> String {
    // Prefer the summary raw; else the first line of the full message.
    if let Some(s) = &c.summary {
        if !s.raw.trim().is_empty() {
            return s.raw.lines().next().unwrap_or("").trim().to_string();
        }
    }
    c.message.lines().next().unwrap_or("").trim().to_string()
}

/// The commit-message body (everything after the headline), derived the same
/// title-strip way as GitLab's (`gitlab::message_body_from_full`). Empty when the
/// message is a single line.
fn commit_body(c: &BbCommit) -> String {
    crate::forge::gitlab::message_body_from_full(&c.message)
}

fn commit_author(c: &BbCommit) -> String {
    c.author
        .as_ref()
        .and_then(|a| {
            a.user
                .as_ref()
                .map(user_login)
                .filter(|s| !s.is_empty())
                .or_else(|| (!a.raw.is_empty()).then(|| a.raw.clone()))
        })
        .unwrap_or_default()
}

/// Full read view of one pull request — the single PR GET (hard error) plus best-effort
/// sub-fetches (commits, diffstat, comments, statuses), mapped onto `PrDetails`.
/// `reviews` is empty: a Bitbucket "approved" participant has no body/state text to
/// render, so (like GitLab) participants who acted surface as `completed_reviewers`
/// verdict chips instead. Assignees/labels are always empty (Bitbucket has neither).
pub async fn view_pr(repo_path: &str, number: u64) -> AppResult<PrDetails> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let base = format!(
        "repositories/{}/{}/pullrequests/{number}",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );

    // Core PR — a hard error (the view can't render without it).
    let pr: BbPr = http::bb_get_json(&creds, &base, "pull request").await?;

    // Commits — Bitbucket returns newest-first; the neutral model wants oldest-first
    // (the frontend treats the last as head), matching gitlab's reversal.
    let mut commits: Vec<PrCommitOut> = http::bb_get_json::<BbPage<BbCommit>>(
        &creds,
        &format!("{base}/commits?pagelen=100"),
        "commits",
    )
    .await
    .map(|page| {
        page.values
            .into_iter()
            .map(|c| PrCommitOut {
                headline: commit_headline(&c),
                message_body: commit_body(&c),
                author: commit_author(&c),
                oid: c.hash,
                date: c.date,
            })
            .collect()
    })
    .unwrap_or_default();
    commits.reverse();

    // Diffstat → files + additions/deletions totals.
    let mut additions = 0u32;
    let mut deletions = 0u32;
    let files: Vec<PrFileOut> = http::bb_get_json::<BbPage<BbDiffstat>>(
        &creds,
        &format!("{base}/diffstat?pagelen=100"),
        "diffstat",
    )
    .await
    .map(|page| {
        page.values
            .into_iter()
            .map(|d| {
                additions += d.lines_added;
                deletions += d.lines_removed;
                // Prefer the new path; fall back to old (a delete has new=null).
                let path = d
                    .new
                    .map(|p| p.path)
                    .filter(|p| !p.is_empty())
                    .or_else(|| d.old.map(|p| p.path))
                    .unwrap_or_default();
                PrFileOut {
                    path,
                    additions: d.lines_added,
                    deletions: d.lines_removed,
                }
            })
            .collect()
    })
    .unwrap_or_default();

    // Resolve the viewer's account uuid once (tolerant — a failure just leaves
    // every comment's edit/delete hidden; it must not fail the view). Drives the
    // truthful `viewer_did_author` below.
    let viewer_uuid = http::bb_get_json::<BbUser>(&creds, "user", "user")
        .await
        .ok()
        .and_then(|u| u.uuid)
        .unwrap_or_default();

    // Comments — drop deleted + pending, AND every comment belonging to an inline
    // (diff-anchored) thread, root OR reply: those surface as `review_threads` with real
    // file/line context, and leaving replies here would both strip that context and
    // double-render them. A reply carries `parent` but not `inline`, so an
    // `inline.is_none()` filter alone misses it — resolve each comment's chain root
    // instead, across ALL pages (a page-2 reply's inline root can sit on page 1). A reply
    // to a plain comment has a non-inline root and stays in the flat list. Best-effort
    // (empty on failure); `base` already carries the `/pullrequests/{number}` suffix.
    let comments: Vec<PrThreadOut> = fetch_all_pr_comments(&creds, &format!("{base}/comments"))
        .await
        .map(|values| {
            let inline_ids = inline_thread_comment_ids(&values);
            values
                .into_iter()
                .filter(|c| !c.deleted && !c.pending && !inline_ids.contains(&c.id))
                .map(|c| from_bb_comment(c, &viewer_uuid))
                .collect()
        })
        .unwrap_or_default();

    // Statuses → checks. Scoped to the HEAD commit's statuses (the last commit after
    // the oldest-first reversal above), matching what the PR view shows — a plain
    // `pullrequests/{id}/statuses` mixes in statuses for superseded commits. External
    // build statuses link out via `url`; they carry no run/job id, so the frontend
    // renders link-out only (no inline log peek). Best-effort: empty on any failure.
    let head_sha = commits.last().map(|c| c.oid.clone()).unwrap_or_default();
    let checks = if head_sha.is_empty() {
        Vec::new()
    } else {
        http::bb_get_json::<BbPage<BbCommitStatus>>(
            &creds,
            &format!(
                "repositories/{}/{}/commit/{}/statuses?pagelen=100",
                encode_query_value(&ws),
                encode_query_value(&slug),
                encode_query_value(&head_sha),
            ),
            "statuses",
        )
        .await
        .map(|page| {
            page.values
                .into_iter()
                .map(|s| crate::github::pr::PrCheckOut {
                    name: s.name.filter(|n| !n.is_empty()).unwrap_or(s.key),
                    status: map_bb_check_state(&s.state),
                    details_url: s.url.filter(|u| !u.is_empty()),
                    // External statuses have no Actions-style run/job id (link-out only).
                    run_id: None,
                    job_id: None,
                    started_at: s.created_on.filter(|t| !t.is_empty()),
                    completed_at: s.updated_on.filter(|t| !t.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default()
    };

    // Completed reviewers = participants who acted, derived from participant state
    // (Bitbucket has no review objects); the frontend de-dups them against pending
    // reviewers. `reviewers` below stays the FULL assigned set on purpose — it feeds the
    // picker's full-replacement PUT, so dropping an acted reviewer would un-assign them.
    let completed_reviewers = completed_reviewers_from(&pr.participants);

    Ok(PrDetails {
        // No node ids on Bitbucket.
        id: String::new(),
        number: pr.id,
        title: pr.title,
        body: pr.description.unwrap_or_default(),
        author: pr.author.as_ref().map(user_login).unwrap_or_default(),
        author_avatar_url: pr.author.as_ref().map(user_avatar).unwrap_or_default(),
        state: map_bb_pr_state(&pr.state),
        is_draft: pr.draft,
        base_ref_name: branch_name(&pr.destination),
        head_ref_name: branch_name(&pr.source),
        additions,
        deletions,
        url: html_href(&pr.links),
        commits,
        files,
        reviews: Vec::new(),
        comments,
        checks,
        labels: Vec::new(),
        assignees: Vec::new(),
        // Identity = uuid (participant objects never carry `username`, and
        // nicknames aren't unique); label = the usual display fallback chain.
        reviewers: pr
            .reviewers
            .iter()
            .filter_map(|u| {
                let id = u.uuid.clone().unwrap_or_default();
                if id.is_empty() {
                    return None;
                }
                Some(ForgeUserRef {
                    id,
                    label: user_login(u),
                    avatar_url: user_avatar(u),
                    is_bot: false,
                })
            })
            .collect(),
        completed_reviewers,
        // Repository-level merge-method gating is a GitHub-only concept here; the
        // fields are honestly "unknown" for Bitbucket (the picker never gates on `None`).
        merge_commit_allowed: None,
        squash_merge_allowed: None,
        rebase_merge_allowed: None,
        // Bitbucket has no stacked-PR concept — never stacked, never unknown.
        stack: None,
        stack_members: Vec::new(),
        stack_unknown: false,
    })
}

/// One PR `activity` entry. Each carries exactly one of `update`/`approval`/
/// `changes_requested`/`comment` (comment activity is ignored — comments come from
/// the comments endpoint). Unknown/other entries deserialize with all-`None`.
#[derive(Deserialize, Default)]
struct BbActivity {
    #[serde(default)]
    update: Option<BbActivityUpdate>,
    #[serde(default)]
    approval: Option<BbActivityApproval>,
    #[serde(default)]
    changes_requested: Option<BbActivityApproval>,
}

/// An `update` activity: `state` is the PR's state AT that update ("OPEN"/"MERGED"/
/// "DECLINED"); `changes.status` is present only when the update *transitioned* the
/// state — the two together mark a merge/decline (an OPEN update with a `draft`/
/// `title` change is not a state event).
#[derive(Deserialize)]
struct BbActivityUpdate {
    #[serde(default)]
    state: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    author: Option<BbUser>,
    #[serde(default)]
    changes: Option<BbActivityChanges>,
}

/// The `changes` object on an `update`. Only `status`'s PRESENCE matters — it appears
/// when the update transitioned the PR state (merge/decline); its `{old, new}` values
/// are Bitbucket-internal (open/fulfilled/rejected), so we key the event off
/// `update.state` instead of parsing them.
#[derive(Deserialize)]
struct BbActivityChanges {
    #[serde(default)]
    status: Option<serde_json::Value>,
}

/// An `approval` or `changes_requested` activity: `{date, user}`.
#[derive(Deserialize)]
struct BbActivityApproval {
    #[serde(default)]
    date: String,
    #[serde(default)]
    user: Option<BbUser>,
}

/// The PR's activity timeline — state changes (merge/decline) and review verdicts
/// (approve / request-changes) — mapped onto the neutral `PrTimelineEventOut` union,
/// oldest→newest. Bitbucket's arm of `forge_pr_timeline`. Deliberately omits
/// `update`-commit events and `comment` activity (commits + comments come from
/// `pr.commits`/`pr.comments` on the frontend); Bitbucket has no label/reopen/draft/
/// review-request events. Best-effort: a failed fetch yields an empty timeline.
pub async fn pr_activity(repo_path: &str, number: u64) -> AppResult<Vec<PrTimelineEventOut>> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    // Bitbucket rejects pagelen > 50 on the activity endpoint ("Invalid pagelen").
    let path = format!(
        "repositories/{}/{}/pullrequests/{number}/activity?pagelen=50",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    let page: BbPage<BbActivity> = http::bb_get_json(&creds, &path, "pull request activity")
        .await
        .unwrap_or_default();

    let mut events: Vec<PrTimelineEventOut> = page
        .values
        .into_iter()
        .filter_map(map_activity_entry)
        .collect();

    // Sort ascending by date (empty dates sort first, stably).
    events.sort_by(|a, b| bb_timeline_date(a).cmp(bb_timeline_date(b)));
    Ok(events)
}

/// Map one PR `activity` entry onto a timeline event, or `None` when it isn't a
/// state-change/verdict event (a comment, a non-state `update`, or an unknown shape).
/// Pure (unit-tested). An `update` is only an event when it carries a `changes.status`
/// transition AND landed on a terminal state — an OPEN update editing draft/title is
/// skipped; the `update.state` string (not the internal `status.new`) drives the kind.
fn map_activity_entry(entry: BbActivity) -> Option<PrTimelineEventOut> {
    if let Some(u) = entry.update {
        let changed = u.changes.and_then(|c| c.status).is_some();
        if !changed {
            return None;
        }
        let actor = u.author.as_ref().map(user_login).unwrap_or_default();
        let date = u.date;
        match u.state.as_str() {
            "MERGED" => Some(PrTimelineEventOut::Merged {
                actor,
                commit_oid: None,
                date,
            }),
            "DECLINED" | "SUPERSEDED" => Some(PrTimelineEventOut::Closed { actor, date }),
            _ => None,
        }
    } else if let Some(a) = entry.approval {
        Some(PrTimelineEventOut::Approved {
            actor: a.user.as_ref().map(user_login).unwrap_or_default(),
            date: a.date,
        })
    } else if let Some(a) = entry.changes_requested {
        Some(PrTimelineEventOut::ChangesRequested {
            actor: a.user.as_ref().map(user_login).unwrap_or_default(),
            date: a.date,
        })
    } else {
        None
    }
}

/// The date field of a `PrTimelineEventOut` produced by [`pr_activity`] — the sort
/// key. Exhaustive over the union so a new variant can't silently sort as "".
fn bb_timeline_date(e: &PrTimelineEventOut) -> &str {
    match e {
        PrTimelineEventOut::Merged { date, .. }
        | PrTimelineEventOut::Closed { date, .. }
        | PrTimelineEventOut::Approved { date, .. }
        | PrTimelineEventOut::ChangesRequested { date, .. }
        | PrTimelineEventOut::Unapproved { date, .. }
        | PrTimelineEventOut::Labeled { date, .. }
        | PrTimelineEventOut::Reopened { date, .. }
        | PrTimelineEventOut::ForcePushed { date, .. }
        | PrTimelineEventOut::ReviewRequested { date, .. }
        | PrTimelineEventOut::ReadyForReview { date, .. }
        | PrTimelineEventOut::ConvertToDraft { date, .. }
        | PrTimelineEventOut::Renamed { date, .. } => date,
    }
}

/// Map one non-deleted/non-pending comment onto a neutral thread. The body is the raw
/// content verbatim — inline comments carry file/line context structurally (via
/// `ReviewThreadOut.path`/`line`), not as a text prefix. `viewer_uuid` is the signed-in
/// user's braced account uuid; a missing/mismatched uuid maps `viewer_did_author` to
/// false — the safe direction (edit/delete hidden), never the reverse.
fn from_bb_comment(c: BbComment, viewer_uuid: &str) -> PrThreadOut {
    let body = c.content.map(|r| r.raw).unwrap_or_default();
    let viewer_did_author = comment_authored_by_viewer(c.user.as_ref(), viewer_uuid);
    PrThreadOut {
        author: c.user.as_ref().map(user_login).unwrap_or_default(),
        author_avatar_url: c.user.as_ref().map(user_avatar).unwrap_or_default(),
        state: String::new(),
        body,
        date: c.created_on,
        id: c.id.to_string(),
        url: html_href(&c.links),
        viewer_did_author,
        is_minimized: false,
        minimized_reason: String::new(),
        // Bitbucket doesn't model review objects — no owning review id.
        review_id: String::new(),
    }
}

/// Whether a comment's author is the signed-in viewer, by account uuid. Pure
/// (testable): an unknown viewer (empty uuid) or an author with no uuid is never
/// a match — the safe default (hides edit/delete), never exposes another user's.
fn comment_authored_by_viewer(user: Option<&BbUser>, viewer_uuid: &str) -> bool {
    if viewer_uuid.is_empty() {
        return false;
    }
    user.and_then(|u| u.uuid.as_deref()) == Some(viewer_uuid)
}

/// The unified diff for one PR. The `/diff` endpoint 302-redirects (same host) to
/// the raw unified diff; reqwest follows it keeping Authorization (see `http::CLIENT`).
/// Capped like the gh/gitlab paths.
pub async fn diff_pr(repo_path: &str, number: u64) -> AppResult<String> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let path = format!(
        "repositories/{}/{}/pullrequests/{number}/diff",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    let diff = http::bb_get_text(&creds, &path).await?;
    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, PR_DIFF_CAP);
    Ok(text)
}

/// Validate a commit sha before it's interpolated into an API path — a hex value.
/// Rejects empty/non-hex before any network call.
fn validate_commit_sha(sha: &str) -> AppResult<()> {
    if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidArgument(format!("invalid commit id: {sha}")));
    }
    Ok(())
}

/// The raw unified diff of ONE commit (`GET …/diff/{sha}` → raw diff text). Bitbucket
/// returns the unified diff directly, so no synthesis is needed. Sha validated first.
pub async fn commit_diff(repo_path: &str, sha: &str) -> AppResult<String> {
    validate_commit_sha(sha)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/diff/{sha}");
    let diff = http::bb_get_text(&creds, &path).await?;
    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, PR_DIFF_CAP);
    Ok(text)
}

// ── Commit comments ───────────────────────────────────────────────────────────
//
// Bitbucket commit comments live under `…/commit/{sha}/comments` — the same
// `BbComment` shape as PR comments (id / content.raw / user / inline.path+to). An
// anchored comment sends `inline: {path, to: line}`; a whole-commit one omits it.

/// List a commit's comments (`GET …/commit/{sha}/comments?pagelen=100`, deleted
/// filtered). `viewer_did_author` compares each author's uuid to the viewer's.
pub async fn commit_comments(repo_path: &str, sha: &str) -> AppResult<Vec<CommitCommentOut>> {
    validate_commit_sha(sha)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let viewer_uuid = http::bb_get_json::<BbUser>(&creds, "user", "user")
        .await
        .ok()
        .and_then(|u| u.uuid)
        .unwrap_or_default();
    let page: BbPage<BbComment> = http::bb_get_json(
        &creds,
        &format!("{base}/commit/{sha}/comments?pagelen=100"),
        "commit comments",
    )
    .await?;
    Ok(page
        .values
        .into_iter()
        .filter(|c| !c.deleted)
        .map(|c| {
            let viewer_did_author = comment_authored_by_viewer(c.user.as_ref(), &viewer_uuid);
            let author = c.user.as_ref().map(user_login).unwrap_or_default();
            // `inline.path` is side-agnostic, so keep it whenever present — an
            // old-side-only anchor (a comment on a removed line) carries `from` but no
            // `to`. `line` is defined as the NEW-side line, so it stays `None` there
            // (mapping `from` into `line` would mis-anchor on the new side); the
            // comment still renders against its file rather than as whole-commit.
            let (path, line) = match &c.inline {
                Some(i) if !i.path.is_empty() => (Some(i.path.clone()), i.to),
                _ => (None, None),
            };
            CommitCommentOut {
                id: c.id.to_string(),
                author,
                body: c.content.map(|r| r.raw).unwrap_or_default(),
                created_at: c.created_on,
                viewer_did_author,
                path,
                line,
                // Bitbucket commit comments have no multi-line range concept.
                start_line: None,
                // Bitbucket has no GitHub-style diff position; anchoring is by line.
                position: None,
            }
        })
        .collect())
}

/// Post a comment on a commit (`POST …/commit/{sha}/comments`). Anchored comments
/// add `inline: {path, to: line}`; whole-commit ones send only `content.raw`.
pub async fn commit_comment_create(
    repo_path: &str,
    sha: &str,
    body: &str,
    path: Option<&str>,
    line: Option<u64>,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    validate_commit_sha(sha)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let endpoint = format!("{base}/commit/{sha}/comments");
    let mut payload = serde_json::json!({ "content": { "raw": body } });
    if let (Some(p), Some(l)) = (path, line) {
        payload["inline"] = serde_json::json!({ "path": p, "to": l });
    }
    http::bb_post_json::<serde_json::Value>(&creds, &endpoint, &payload, "commit comment").await?;
    Ok(())
}

/// Edit a commit comment (`PUT …/commit/{sha}/comments/{id}`). Empty-body guard +
/// id parse both run BEFORE the request.
pub async fn commit_comment_edit(
    repo_path: &str,
    sha: &str,
    comment_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    validate_commit_sha(sha)?;
    let cid = parse_bb_comment_id(comment_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/commit/{sha}/comments/{cid}");
    let payload = serde_json::json!({ "content": { "raw": body } });
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "commit comment").await?;
    Ok(())
}

/// Delete a commit comment (`DELETE …/commit/{sha}/comments/{id}`). Id parse runs
/// BEFORE the request.
pub async fn commit_comment_delete(
    repo_path: &str,
    sha: &str,
    comment_id: &str,
) -> AppResult<()> {
    validate_commit_sha(sha)?;
    let cid = parse_bb_comment_id(comment_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/commit/{sha}/comments/{cid}");
    http::bb_delete(&creds, &path).await
}

// ── Pipelines (CI, read) ───────────────────────────────────────────────────────

/// Collapse Bitbucket's pipeline/step state onto GitHub's two-field
/// `(status, conclusion)` model. `state_name` is PENDING/IN_PROGRESS/COMPLETED;
/// `result_name` (present when COMPLETED) is SUCCESSFUL/FAILED/ERROR/STOPPED.
fn map_bb_pipeline_status(state_name: &str, result_name: &str) -> (String, String) {
    let (status, conclusion) = match state_name {
        "COMPLETED" => match result_name {
            "SUCCESSFUL" => ("completed", "success"),
            "FAILED" => ("completed", "failure"),
            "ERROR" => ("completed", "failure"),
            "STOPPED" => ("completed", "cancelled"),
            // COMPLETED with a missing/unknown result — finished, neutral.
            _ => ("completed", ""),
        },
        "IN_PROGRESS" => ("in_progress", ""),
        "PENDING" => ("queued", ""),
        // Unknown/new Bitbucket state — treat as finished-neutral rather than guess.
        _ => ("completed", ""),
    };
    (status.to_string(), conclusion.to_string())
}

/// Bitbucket's pipeline trigger → a short label for the run's "workflow" slot.
fn friendly_trigger(name: &str) -> String {
    match name {
        "PUSH" => "Push",
        "MANUAL" => "Manual",
        "SCHEDULED" => "Scheduled",
        "PARENT_STEP" => "Parent step",
        "" => "Pipeline",
        other => other,
    }
    .to_string()
}

#[derive(Deserialize, Default)]
struct BbState {
    #[serde(default)]
    name: String,
    #[serde(default)]
    result: Option<BbNamed>,
}

#[derive(Deserialize, Default)]
struct BbNamed {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Default)]
struct BbTarget {
    #[serde(default)]
    ref_name: Option<String>,
    #[serde(default)]
    commit: Option<BbCommitRef>,
}

#[derive(Deserialize, Default)]
struct BbCommitRef {
    #[serde(default)]
    hash: String,
}

/// A pipeline as `GET …/pipelines/` returns it.
#[derive(Deserialize)]
struct BbPipeline {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    build_number: u64,
    #[serde(default)]
    state: Option<BbState>,
    #[serde(default)]
    target: Option<BbTarget>,
    #[serde(default)]
    trigger: Option<BbNamed>,
    #[serde(default)]
    created_on: String,
    #[serde(default)]
    completed_on: Option<String>,
}

/// The state/result names of a pipeline or step (helper for the mapper).
fn state_and_result(state: &Option<BbState>) -> (String, String) {
    match state {
        Some(s) => (
            s.name.clone(),
            s.result
                .as_ref()
                .map(|r| r.name.clone())
                .unwrap_or_default(),
        ),
        None => (String::new(), String::new()),
    }
}

fn pipeline_url(ws: &str, slug: &str, build_number: u64) -> String {
    format!("https://bitbucket.org/{ws}/{slug}/pipelines/results/{build_number}")
}

fn from_bb_pipeline(p: BbPipeline, ws: &str, slug: &str) -> WorkflowRun {
    let (state_name, result_name) = state_and_result(&p.state);
    let (status, conclusion) = map_bb_pipeline_status(&state_name, &result_name);
    let ref_name = p
        .target
        .as_ref()
        .and_then(|t| t.ref_name.clone())
        .filter(|s| !s.is_empty());
    let head_sha = p
        .target
        .as_ref()
        .and_then(|t| t.commit.as_ref())
        .map(|c| c.hash.clone())
        .unwrap_or_default();
    let trigger = p.trigger.map(|t| t.name).unwrap_or_default();
    let display_title = ref_name
        .clone()
        .map(|r| format!("Pipeline #{} · {r}", p.build_number))
        .unwrap_or_else(|| format!("Pipeline #{}", p.build_number));
    WorkflowRun {
        id: p.build_number,
        number: p.build_number,
        display_title,
        status,
        conclusion,
        workflow_name: friendly_trigger(&trigger),
        head_branch: ref_name.unwrap_or_default(),
        event: trigger.to_ascii_lowercase(),
        created_at: p.created_on.clone(),
        // Never leave started_at empty — Insights filters on it (same rule as gitlab).
        started_at: p.created_on.clone(),
        updated_at: p
            .completed_on
            .filter(|s| !s.is_empty())
            .unwrap_or(p.created_on),
        url: pipeline_url(ws, slug, p.build_number),
        head_sha,
    }
}

/// Recent pipelines for this repo, newest first; optionally scoped to one branch.
/// Note the TRAILING SLASH on `pipelines/` (required). Single page at `pagelen =
/// limit.clamp(1,100)`, matching GitLab's no-loop policy.
pub async fn list_runs(
    repo_path: &str,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<WorkflowRun>> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let per_page = limit.clamp(1, 100);
    let mut path = format!(
        "repositories/{}/{}/pipelines/?sort=-created_on&pagelen={per_page}",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    if let Some(b) = branch.as_deref().filter(|s| !s.is_empty()) {
        path.push_str(&format!("&target.branch={}", encode_query_value(b)));
    }
    let page: BbPage<BbPipeline> = http::bb_get_json(&creds, &path, "pipelines").await?;
    Ok(page
        .values
        .into_iter()
        .map(|p| from_bb_pipeline(p, &ws, &slug))
        .collect())
}

/// A pipeline step (`{uuid, name?, state{name, result{name}}, …}`). No numeric id.
#[derive(Deserialize)]
struct BbStep {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: Option<BbState>,
    #[serde(default, deserialize_with = "null_to_default")]
    started_on: String,
    #[serde(default, deserialize_with = "null_to_default")]
    completed_on: String,
}

/// Percent-encode a braced pipeline/step UUID for use in a path segment. Literal
/// braces 400; `{`→`%7B`, `}`→`%7D` (and any other reserved byte encoded too).
fn encode_uuid(uuid: &str) -> String {
    let mut out = String::with_capacity(uuid.len() + 6);
    for b in uuid.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve one pipeline by build number: primary `GET …/pipelines/{n}`, falling back to
/// `GET …/pipelines/?q=build_number={n}` (taking the single value) when the primary 404s.
async fn resolve_pipeline(
    creds: &BbCredentials,
    ws: &str,
    slug: &str,
    build_number: u64,
) -> AppResult<BbPipeline> {
    let ws_e = encode_query_value(ws);
    let slug_e = encode_query_value(slug);
    let primary = format!("repositories/{ws_e}/{slug_e}/pipelines/{build_number}");
    // `bb_get_json` maps every non-2xx to `AppError::Bitbucket` with no status, so
    // the fallback must gate on the raw status: only a genuine 404 warrants the
    // second request (401/429/… should surface, not fire a doomed retry).
    let (status, body) = http::bb_get_text_status(creds, &primary).await?;
    if (200..300).contains(&status) {
        serde_json::from_str::<BbPipeline>(&body)
            .map_err(|e| AppError::Bitbucket(format!("could not parse Bitbucket pipeline: {e}")))
    } else if status == 404 {
        // Fallback: query by build_number and take the single match.
        let q = format!(
            "repositories/{ws_e}/{slug_e}/pipelines/?q=build_number={build_number}&pagelen=1"
        );
        let page: BbPage<BbPipeline> = http::bb_get_json(creds, &q, "pipeline").await?;
        page.values.into_iter().next().ok_or_else(|| {
            AppError::Bitbucket(format!(
                "no Bitbucket pipeline with build number {build_number}"
            ))
        })
    } else {
        Err(http::http_error(status, &body))
    }
}

/// The pipeline's steps (`GET …/pipelines/{uuid}/steps/`). Braced UUID percent-encoded.
async fn pipeline_steps(creds: &BbCredentials, ws: &str, slug: &str, uuid: &str) -> Vec<BbStep> {
    let path = format!(
        "repositories/{}/{}/pipelines/{}/steps/?pagelen=100",
        encode_query_value(ws),
        encode_query_value(slug),
        encode_uuid(uuid),
    );
    http::bb_get_json::<BbPage<BbStep>>(creds, &path, "steps")
        .await
        .map(|p| p.values)
        .unwrap_or_default()
}

fn from_bb_step(index: usize, s: BbStep, pipeline_uuid: &str, url: &str) -> RunJob {
    let (state_name, result_name) = state_and_result(&s.state);
    let (status, conclusion) = map_bb_pipeline_status(&state_name, &result_name);
    let name = s
        .name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("Step {}", index + 1));
    RunJob {
        // Synthetic — Bitbucket steps have no numeric id; this is only a UI key.
        id: (index + 1) as u64,
        name,
        status,
        conclusion,
        started_at: s.started_on,
        completed_at: s.completed_on,
        url: url.to_string(),
        steps: Vec::new(),
        // The real handle for fetching this step's log (raw braced UUIDs).
        log_ref: Some(format!("{pipeline_uuid}/{}", s.uuid)),
    }
}

/// One pipeline with its steps mapped onto `RunDetail`.
pub async fn view_run(repo_path: &str, run_id: u64) -> AppResult<RunDetail> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let p = resolve_pipeline(&creds, &ws, &slug, run_id).await?;
    let uuid = p.uuid.clone();
    let (state_name, result_name) = state_and_result(&p.state);
    let (status, conclusion) = map_bb_pipeline_status(&state_name, &result_name);
    let ref_name = p
        .target
        .as_ref()
        .and_then(|t| t.ref_name.clone())
        .filter(|s| !s.is_empty());
    let head_sha = p
        .target
        .as_ref()
        .and_then(|t| t.commit.as_ref())
        .map(|c| c.hash.clone())
        .unwrap_or_default();
    let trigger = p.trigger.map(|t| t.name).unwrap_or_default();
    let url = pipeline_url(&ws, &slug, run_id);
    let display_title = ref_name
        .clone()
        .map(|r| format!("Pipeline #{run_id} · {r}"))
        .unwrap_or_else(|| format!("Pipeline #{run_id}"));

    let steps = pipeline_steps(&creds, &ws, &slug, &uuid).await;
    let jobs = steps
        .into_iter()
        .enumerate()
        .map(|(i, s)| from_bb_step(i, s, &uuid, &url))
        .collect();

    Ok(RunDetail {
        id: run_id,
        number: run_id,
        display_title,
        status,
        conclusion,
        workflow_name: friendly_trigger(&trigger),
        head_branch: ref_name.unwrap_or_default(),
        event: trigger.to_ascii_lowercase(),
        created_at: p.created_on,
        url,
        head_sha,
        jobs,
    })
}

/// Keep at most `cap` bytes, preferring the tail (CI failures land at the end), on a
/// char boundary. Mirrors the gitlab/gh log truncation.
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

/// Shown when a step's log has aged out — Bitbucket expires older pipeline logs, at
/// which point the log endpoint returns a plain 404 (no redirect). This is a normal
/// state for old pipelines, not an error, so it reads as informative text.
const EXPIRED_LOG_MESSAGE: &str =
    "Logs for this step are no longer available — Bitbucket expires older pipeline logs.";

/// Fetch one pipeline step's log from ALREADY-RESOLVED credentials + workspace/slug and
/// the bare uuids, so `run_failed_logs` can loop over failed steps without re-reading the
/// keyring and re-spawning `git remote get-url origin` once per step.
///
/// The `…/steps/{uuid}/log` endpoint 307-redirects CROSS-HOST to a pre-signed S3 URL;
/// reqwest strips Authorization on that hop (see `http::CLIENT`). Capped at 60_000 chars,
/// empty → placeholder. A 404 means the log EXPIRED (Bitbucket prunes old logs) — normal,
/// so it returns [`EXPIRED_LOG_MESSAGE`] as `Ok`; any other non-2xx errors.
async fn step_log_raw(
    creds: &BbCredentials,
    ws: &str,
    slug: &str,
    pipeline_uuid: &str,
    step_uuid: &str,
) -> AppResult<String> {
    let path = format!(
        "repositories/{}/{}/pipelines/{}/steps/{}/log",
        encode_query_value(ws),
        encode_query_value(slug),
        encode_uuid(pipeline_uuid),
        encode_uuid(step_uuid),
    );
    let (status, body) = http::bb_get_text_status(creds, &path).await?;
    if status == 404 {
        return Ok(EXPIRED_LOG_MESSAGE.to_string());
    }
    if !(200..300).contains(&status) {
        return Err(http::http_error(status, &body));
    }
    let text = if body.trim().is_empty() {
        "This step produced no log output.".to_string()
    } else {
        body
    };
    Ok(tail_cap(text, CI_STEP_LOG_CAP))
}

/// Fetch one step's log via `log_ref` (`"{pipeline_uuid}/{step_uuid}"`, RAW braces) —
/// the single-step command entry point. Parses the ref, resolves credentials +
/// workspace/slug, then delegates to [`step_log_raw`].
pub async fn step_logs(repo_path: &str, log_ref: &str) -> AppResult<String> {
    let (pipeline_uuid, step_uuid) = log_ref
        .split_once('/')
        .ok_or_else(|| AppError::InvalidArgument("a step log reference is required".into()))?;
    if pipeline_uuid.is_empty() || step_uuid.is_empty() {
        return Err(AppError::InvalidArgument(
            "a step log reference is required".into(),
        ));
    }
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    step_log_raw(&creds, &ws, &slug, pipeline_uuid, step_uuid).await
}

/// The failed steps' logs for a pipeline, concatenated — Bitbucket's analogue of
/// `gh run view --log-failed`. Resolves the pipeline, lists steps, fetches the log of
/// each step whose result is FAILED/ERROR, with `===== {name} =====` separators.
pub async fn run_failed_logs(repo_path: &str, run_id: u64) -> AppResult<String> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let p = resolve_pipeline(&creds, &ws, &slug, run_id).await?;
    let uuid = p.uuid.clone();
    let steps = pipeline_steps(&creds, &ws, &slug, &uuid).await;
    let failed: Vec<&BbStep> = steps
        .iter()
        .filter(|s| {
            let (_, result) = state_and_result(&s.state);
            result == "FAILED" || result == "ERROR"
        })
        .collect();
    if failed.is_empty() {
        return Ok("No failed steps in this pipeline.".to_string());
    }
    let mut text = String::new();
    for (i, step) in steps.iter().enumerate() {
        let (_, result) = state_and_result(&step.state);
        if result != "FAILED" && result != "ERROR" {
            continue;
        }
        if text.len() > CI_RUN_LOG_CAP {
            break;
        }
        let name = step
            .name
            .clone()
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("Step {}", i + 1));
        // An expired log returns the placeholder (Ok), a hard failure an Err — either
        // way make the section say so rather than leave a bare header. Calls
        // `step_log_raw` directly to avoid re-resolving creds/ws/slug per step.
        let log = match step_log_raw(&creds, &ws, &slug, &uuid, &step.uuid).await {
            Ok(l) if l == EXPIRED_LOG_MESSAGE => "(log unavailable — expired)".to_string(),
            Ok(l) if l.trim().is_empty() => "(log unavailable)".to_string(),
            Ok(l) => l,
            Err(_) => "(log unavailable)".to_string(),
        };
        text.push_str(&format!("===== {name} =====\n"));
        text.push_str(log.trim_end());
        text.push_str("\n\n");
    }
    Ok(tail_cap(text, CI_RUN_LOG_CAP))
}

/// The repo's web URL for "View on Bitbucket".
pub async fn repo_url(repo_path: &str) -> AppResult<String> {
    let (ws, slug) = workspace_slug(repo_path).await?;
    Ok(format!("https://bitbucket.org/{ws}/{slug}"))
}

// ── Pull requests (write) ───────────────────────────────────────────────────────

/// The `repositories/{ws}/{slug}` path prefix every write shares — resolve the
/// workspace/slug from the origin remote and percent-encode both segments.
async fn repo_base(repo_path: &str) -> AppResult<String> {
    let (ws, slug) = workspace_slug(repo_path).await?;
    Ok(format!(
        "repositories/{}/{}",
        encode_query_value(&ws),
        encode_query_value(&slug),
    ))
}

/// Post a comment on a pull request (`POST …/pullrequests/{n}/comments`,
/// `{"content":{"raw": body}}`). The created comment is ignored — the frontend
/// refetches the thread.
pub async fn comment_pr(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/comments");
    let payload = serde_json::json!({ "content": { "raw": body } });
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "comment").await?;
    Ok(())
}

/// Parse a comment id (a comment id, sent as a string over IPC) to the numeric id
/// Bitbucket's comment endpoints take — a pre-mutation guard, before any network
/// call.
fn parse_bb_comment_id(comment_id: &str) -> AppResult<u64> {
    comment_id.trim().parse::<u64>().map_err(|_| {
        AppError::InvalidArgument(format!("invalid comment id: {comment_id}"))
    })
}

/// Edit a PR comment's body (`PUT …/pullrequests/{n}/comments/{cid}`,
/// `{"content":{"raw": body}}`). Empty-body guard + comment-id parse both run
/// BEFORE the request.
pub async fn edit_pr_comment(
    repo_path: &str,
    number: u64,
    comment_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let cid = parse_bb_comment_id(comment_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/comments/{cid}");
    let payload = serde_json::json!({ "content": { "raw": body } });
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "comment").await?;
    Ok(())
}

/// Delete a PR comment (`DELETE …/pullrequests/{n}/comments/{cid}`). Comment-id
/// parse runs BEFORE the request.
pub async fn delete_pr_comment(repo_path: &str, number: u64, comment_id: &str) -> AppResult<()> {
    let cid = parse_bb_comment_id(comment_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/comments/{cid}");
    http::bb_delete(&creds, &path).await
}

/// The set of comment ids whose parent-chain ROOT carries `inline` — i.e. every
/// comment that belongs to an inline (diff-anchored) thread, root or reply. Used
/// to exclude thread replies from the flat conversation list: a reply carries
/// `parent` but not `inline` (probed), so an `inline.is_none()` filter alone
/// leaks it into the timeline while `group_bb_threads` ALSO nests it in its
/// thread (double render). Walks the same bounded parent chain as
/// `group_bb_threads`/`root_for`, building the parent map from the same comment
/// set. A reply whose chain root is a plain (non-inline) comment is NOT in the
/// set — it stays in the flat list, unchanged.
fn inline_thread_comment_ids(comments: &[BbComment]) -> std::collections::HashSet<u64> {
    // Full-topology parent map (child id -> parent id) over ALL comments, so a
    // reply can still walk THROUGH a deleted/pending intermediate up to its root.
    let parent_of: std::collections::HashMap<u64, u64> = comments
        .iter()
        .filter_map(|c| c.parent.as_ref().map(|p| (c.id, p.id)))
        .collect();
    // Roots that anchor an inline thread — an inline comment with no parent.
    let inline_roots: std::collections::HashSet<u64> = comments
        .iter()
        .filter(|c| c.inline.is_some() && c.parent.is_none())
        .map(|c| c.id)
        .collect();
    let bound = comments.len().saturating_add(1);
    comments
        .iter()
        .filter(|c| {
            // Walk this comment's parent chain (bounded, cycle-safe): it belongs
            // to an inline thread iff the chain reaches an inline root.
            let mut id = c.id;
            for _ in 0..bound {
                if inline_roots.contains(&id) {
                    return true;
                }
                match parent_of.get(&id) {
                    Some(&pid) => id = pid,
                    None => return false,
                }
            }
            false
        })
        .map(|c| c.id)
        .collect()
}

/// Group a flat list of PR comments into file:line-anchored review threads. Pure
/// (unit-tested). A thread ROOT is an inline comment with no parent; replies
/// attach to their root by walking the `parent` chain (a reply's parent may itself
/// be a reply). Deleted / pending comments are dropped first. Threads and their
/// comments are ordered oldest-first (Bitbucket returns comments oldest-first).
/// `viewer_uuid` is the signed-in user's braced account uuid (empty = unknown → every
/// `viewer_did_author` false), compared per comment via [`comment_authored_by_viewer`].
fn group_bb_threads(comments: Vec<BbComment>, viewer_uuid: &str) -> Vec<ReviewThreadOut> {
    // Chain topology (child id -> parent id) is built from ALL fetched comments,
    // including deleted/pending ones: they still carry id + parent, so a live reply
    // whose INTERMEDIATE parent was deleted can still walk THROUGH it up to a
    // surviving root. We only RENDER live comments (below) — a reply whose chain
    // root is itself deleted/absent still drops (correct orphan handling).
    let parent_of: std::collections::HashMap<u64, u64> = comments
        .iter()
        .filter_map(|c| c.parent.as_ref().map(|p| (c.id, p.id)))
        .collect();
    let chain_len = comments.len();

    // Keep only real comments, preserving order — these are the ones we render.
    let live: Vec<BbComment> = comments
        .into_iter()
        .filter(|c| !c.deleted && !c.pending)
        .collect();

    // A thread root is a LIVE inline comment with no parent. Record its order so
    // threads come out in the order their roots appear.
    let mut root_order: Vec<u64> = Vec::new();
    let mut is_root: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for c in &live {
        if c.inline.is_some() && c.parent.is_none() {
            root_order.push(c.id);
            is_root.insert(c.id);
        }
    }

    // Resolve any comment id to the root of its thread by walking parents through
    // the full-topology map (bounded by the full comment count, so a malformed
    // cycle can't loop forever).
    let root_for = |mut id: u64| -> Option<u64> {
        for _ in 0..chain_len.saturating_add(1) {
            if is_root.contains(&id) {
                return Some(id);
            }
            match parent_of.get(&id) {
                Some(&pid) => id = pid,
                None => return None,
            }
        }
        None
    };

    // Bucket each live comment under its root (roots include themselves).
    let mut buckets: std::collections::HashMap<u64, Vec<&BbComment>> =
        std::collections::HashMap::new();
    for c in &live {
        if let Some(root) = root_for(c.id) {
            buckets.entry(root).or_default().push(c);
        }
    }

    root_order
        .into_iter()
        .filter_map(|root_id| {
            let mut group = buckets.remove(&root_id)?;
            // Oldest-first within the thread — Bitbucket already returns comments
            // in ascending creation order, so sort by id to be robust to paging.
            group.sort_by_key(|c| c.id);
            let root = group.iter().find(|c| c.id == root_id)?;
            let inline = root.inline.as_ref()?;
            let (side, line) = match (inline.to, inline.from) {
                (Some(to), _) => ("new", to as u32),
                (None, Some(from)) => ("old", from as u32),
                (None, None) => ("new", 0u32),
            };
            let comments: Vec<PrThreadOut> = group
                .into_iter()
                .map(|c| PrThreadOut {
                    viewer_did_author: comment_authored_by_viewer(c.user.as_ref(), viewer_uuid),
                    author: c.user.as_ref().map(user_login).unwrap_or_default(),
                    author_avatar_url: c.user.as_ref().map(user_avatar).unwrap_or_default(),
                    state: String::new(),
                    body: c.content.as_ref().map(|r| r.raw.clone()).unwrap_or_default(),
                    date: c.created_on.clone(),
                    id: c.id.to_string(),
                    url: html_href(&c.links),
                    is_minimized: false,
                    minimized_reason: String::new(),
                    // Bitbucket doesn't model review objects — no owning review id.
                    review_id: String::new(),
                })
                .collect();
            Some(ReviewThreadOut {
                id: root_id.to_string(),
                path: inline.path.clone(),
                line,
                // Bitbucket inline anchors are single-line (`to`/`from`), with no
                // multi-line range concept — always 0.
                start_line: 0,
                side: side.into(),
                // Bitbucket surfaced no `resolution` field on any probed comment
                // (three repos, incl. inline) — thread-resolution stays unwired.
                is_resolved: false,
                // No Bitbucket "outdated" concept on comments.
                is_outdated: false,
                // Bitbucket exposes no unified-diff excerpt on comments — empty.
                diff_hunk: String::new(),
                // Bitbucket doesn't model review objects here (pr_view emits no
                // reviews), so there's no owning review id to attach.
                review_id: String::new(),
                comments,
            })
        })
        .collect()
}

/// One `…/comments` page — `values` plus the absolute `next` link (the generic
/// `BbPage` drops `next`, so comment pagination needs its own struct).
#[derive(Deserialize, Default)]
struct BbCommentsPage {
    #[serde(default)]
    values: Vec<BbComment>,
    #[serde(default)]
    next: Option<String>,
}

/// Fetch a PR's comments, following `next` up to 5 pages (500 at `pagelen=100`, the
/// `workspace_members`/`pr_tasks` idiom). `comments_path` is the `…/comments` endpoint
/// WITHOUT a query string, because `view_pr`'s base already carries the
/// `/pullrequests/{n}` suffix while `review_threads`' `repo_base` does not. Both readers
/// need ALL pages — they resolve parent chains / inline-thread roots across the full set,
/// so truncating at one page orphans reply chains and drops threads on busy PRs.
async fn fetch_all_pr_comments(
    creds: &http::BbCredentials,
    comments_path: &str,
) -> AppResult<Vec<BbComment>> {
    let mut url = format!("{comments_path}?pagelen=100");
    let mut comments: Vec<BbComment> = Vec::new();
    for _ in 0..5 {
        let page: BbCommentsPage = http::bb_get_json(creds, &url, "comments").await?;
        comments.extend(page.values);
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(comments)
}

/// File:line-anchored review threads on a PR — Bitbucket inline comments grouped with
/// their reply chains. Own fetch, kept separate from `view_pr`'s conversation read; reads
/// all comment pages because `group_bb_threads` walks parent chains across ALL comments.
pub async fn review_threads(repo_path: &str, number: u64) -> AppResult<Vec<ReviewThreadOut>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;

    // Resolve the viewer's uuid once (tolerant — a failure just hides edit/delete; it
    // must not fail the read). Drives `viewer_did_author` in the grouping.
    let viewer_uuid = http::bb_get_json::<BbUser>(&creds, "user", "user")
        .await
        .ok()
        .and_then(|u| u.uuid)
        .unwrap_or_default();

    // `repo_base` has no `/pullrequests/{n}` suffix, so add it for the endpoint.
    let comments =
        fetch_all_pr_comments(&creds, &format!("{base}/pullrequests/{number}/comments")).await?;
    Ok(group_bb_threads(comments, &viewer_uuid))
}

/// Reply in an existing review thread (`POST …/comments`, `{"content":{"raw"},
/// "parent":{"id"}}`). `thread_id` is the root comment id.
pub async fn reply_thread(
    repo_path: &str,
    number: u64,
    thread_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a reply is required".into()));
    }
    let parent_id: u64 = thread_id
        .parse()
        .map_err(|_| AppError::InvalidArgument(format!("invalid thread id: {thread_id}")))?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/comments");
    let payload = serde_json::json!({
        "content": { "raw": body },
        "parent": { "id": parent_id },
    });
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "reply").await?;
    Ok(())
}

/// Create a NEW file:line-anchored review thread on a PR (`POST
/// …/pullrequests/{n}/comments` with `inline: {path, to|from: line}`). `side` is
/// `"new"`/`"old"` — "new" anchors on the added side (`to`), "old" on the removed
/// side (`from`). `start_line` is GitHub-only (multi-line range); Bitbucket anchors
/// at `line`, so it's ignored.
#[allow(clippy::too_many_arguments)]
pub async fn thread_create(
    repo_path: &str,
    number: u64,
    path: &str,
    line: u64,
    side: &str,
    _start_line: Option<u64>,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument("a file path is required".into()));
    }
    let inline = match side {
        "new" => serde_json::json!({ "path": path, "to": line }),
        "old" => serde_json::json!({ "path": path, "from": line }),
        other => {
            return Err(AppError::InvalidArgument(format!("invalid side: {other}")));
        }
    };
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let endpoint = format!("{base}/pullrequests/{number}/comments");
    let payload = serde_json::json!({ "content": { "raw": body }, "inline": inline });
    http::bb_post_json::<serde_json::Value>(&creds, &endpoint, &payload, "review comment").await?;
    Ok(())
}

/// Resolve / unresolve a review thread. Bitbucket surfaced no comment-resolution
/// field or endpoint on any probed comment (three repos), so this is unwired —
/// `mr_thread_resolve` is false for Bitbucket and the command errors if reached.
pub async fn resolve_thread(
    _repo_path: &str,
    _number: u64,
    _thread_id: &str,
    _resolved: bool,
) -> AppResult<()> {
    Err(AppError::Bitbucket(
        "resolving comment threads is not supported".into(),
    ))
}

/// Decline (close) a pull request (`POST …/pullrequests/{n}/decline`, no body). A
/// declined Bitbucket PR CANNOT be reopened (via API or web — BCLOUD-4954), so there
/// is no reopen counterpart; `forge_pr_reopen` errors for Bitbucket by design.
pub async fn decline_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/decline");
    http::bb_post_empty(&creds, &path).await
}

/// Map the neutral merge-strategy string onto Bitbucket's `merge_strategy` enum.
/// Pure (testable). Unknown strategies error rather than silently defaulting.
fn map_merge_strategy(strategy: &str) -> AppResult<&'static str> {
    match strategy {
        "merge" => Ok("merge_commit"),
        "squash" => Ok("squash"),
        "fast_forward" => Ok("fast_forward"),
        other => Err(AppError::InvalidArgument(format!(
            "unsupported Bitbucket merge strategy: {other}"
        ))),
    }
}

/// The `{task_status}` envelope of a merge poll (`GET {location}`).
#[derive(Deserialize)]
struct BbMergeTask {
    #[serde(default)]
    task_status: String,
}

/// Merge a pull request (`POST …/pullrequests/{n}/merge`). Bitbucket has no
/// expected-hash guard (the caller's `sha` is dropped upstream); `close_source_branch`
/// auto-deletes the source branch. Small repos merge SYNCHRONOUSLY (200); large/slow
/// merges return 202 with a `Location` task-status URL we poll until `SUCCESS`. Any other
/// status errors via [`http::http_error`] (an already-closed PR surfaces its 400).
pub async fn merge_pr(
    repo_path: &str,
    number: u64,
    strategy: &str,
    delete_branch: bool,
) -> AppResult<()> {
    let merge_strategy = map_merge_strategy(strategy)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/merge");
    let payload = serde_json::json!({
        "type": "pullrequest",
        "merge_strategy": merge_strategy,
        "close_source_branch": delete_branch,
    });
    let (status, location, body) =
        http::bb_send(&creds, reqwest::Method::POST, &path, Some(&payload)).await?;
    match status {
        // Synchronous merge — done.
        200 => Ok(()),
        // Asynchronous merge — poll the task-status URL from the Location header.
        202 => {
            let task_url = location.filter(|l| !l.is_empty()).ok_or_else(|| {
                AppError::Bitbucket(
                    "Bitbucket accepted the merge but returned no task-status URL to poll.".into(),
                )
            })?;
            poll_merge_task(&creds, &task_url).await
        }
        _ => Err(http::http_error(status, &body)),
    }
}

/// Poll a Bitbucket merge task-status URL until it resolves. `PENDING` loops (bounded
/// to ~30 tries, 2s apart); `SUCCESS` → Ok; anything else → an error carrying the raw
/// body. A non-2xx poll response errors via [`http::http_error`].
async fn poll_merge_task(creds: &BbCredentials, task_url: &str) -> AppResult<()> {
    for _ in 0..30 {
        let (status, _, body) = http::bb_send(creds, reqwest::Method::GET, task_url, None).await?;
        if !(200..300).contains(&status) {
            return Err(http::http_error(status, &body));
        }
        let task: BbMergeTask = serde_json::from_str(&body).map_err(|e| {
            AppError::Bitbucket(format!("could not parse Bitbucket merge status: {e}"))
        })?;
        match task.task_status.as_str() {
            "SUCCESS" => return Ok(()),
            "PENDING" | "" => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            other => {
                return Err(AppError::Bitbucket(format!(
                    "Bitbucket merge did not complete (task status: {other})."
                )));
            }
        }
    }
    Err(AppError::Bitbucket(
        "Bitbucket merge is still processing — check the pull request on Bitbucket.".into(),
    ))
}

/// A minimal PR shape for the edit read-back — just the reviewer uuids we must echo.
#[derive(Deserialize, Default)]
struct BbPrReviewers {
    #[serde(default, deserialize_with = "null_to_default")]
    reviewers: Vec<BbReviewer>,
}

#[derive(Deserialize, Default)]
struct BbReviewer {
    #[serde(default)]
    uuid: String,
}

/// Build the reviewer-safe edit body: title + description + the existing reviewer
/// uuids, plus `destination` when retargeting. Pure (testable). Omitting
/// `reviewers` from a Bitbucket PR PUT WIPES them (Renovate-confirmed), so we
/// always echo the existing set; `destination` has no such semantics — omitting it
/// keeps the PR's current target branch.
fn build_edit_body(
    title: &str,
    body: &str,
    reviewer_uuids: &[String],
    base: Option<&str>,
) -> serde_json::Value {
    let reviewers: Vec<serde_json::Value> = reviewer_uuids
        .iter()
        .map(|u| serde_json::json!({ "uuid": u }))
        .collect();
    let mut payload = serde_json::json!({
        "title": title,
        "description": body,
        "reviewers": reviewers,
    });
    if let Some(base) = base {
        payload["destination"] = serde_json::json!({ "branch": { "name": base } });
    }
    payload
}

/// Read a PR's current reviewer uuids — the echo every mutating PR PUT needs
/// (omitting `reviewers` from a Bitbucket PR PUT WIPES them).
async fn read_reviewer_uuids(
    creds: &BbCredentials,
    base: &str,
    number: u64,
) -> AppResult<Vec<String>> {
    let read_path = format!("{base}/pullrequests/{number}?fields=reviewers.uuid");
    let existing: BbPrReviewers =
        http::bb_get_json(creds, &read_path, "pull request reviewers").await?;
    Ok(existing
        .reviewers
        .into_iter()
        .map(|r| r.uuid)
        .filter(|u| !u.is_empty())
        .collect())
}

/// Edit a pull request's title/body (`PUT …/pullrequests/{n}`), and its destination
/// branch when `target` is given. Only OPEN PRs are mutable. A Bitbucket PR PUT that
/// omits `reviewers` WIPES them, so we first read the existing reviewer uuids and
/// echo them back alongside the new title/description.
pub async fn edit_pr(
    repo_path: &str,
    number: u64,
    title: &str,
    body: &str,
    target: Option<&str>,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let uuids = read_reviewer_uuids(&creds, &base, number).await?;
    let payload = build_edit_body(title, body, &uuids, target);
    let path = format!("{base}/pullrequests/{number}");
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pull request").await?;
    Ok(())
}

/// Build the draft-toggle body. Pure (testable). Echoes the existing reviewers for
/// the same reason as [`build_edit_body`] — omitting `reviewers` from a PR PUT
/// wipes them.
fn build_draft_body(draft: bool, reviewer_uuids: &[String]) -> serde_json::Value {
    let reviewers: Vec<serde_json::Value> = reviewer_uuids
        .iter()
        .map(|u| serde_json::json!({ "uuid": u }))
        .collect();
    serde_json::json!({ "draft": draft, "reviewers": reviewers })
}

/// Toggle a pull request's draft state (`PUT …/pullrequests/{n}` with `{draft}`).
/// Bitbucket supports BOTH directions (validated live) — GitHub's `gh pr ready`
/// path stays one-way and untouched. Echoes the current reviewers like every other
/// PR PUT here.
pub async fn set_pr_draft(repo_path: &str, number: u64, draft: bool) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let uuids = read_reviewer_uuids(&creds, &base, number).await?;
    let payload = build_draft_body(draft, &uuids);
    let path = format!("{base}/pullrequests/{number}");
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pull request").await?;
    Ok(())
}

/// Build the set-reviewers body. Pure (testable).
fn build_reviewers_body(uuids: &[String]) -> serde_json::Value {
    let reviewers: Vec<serde_json::Value> = uuids
        .iter()
        .map(|u| serde_json::json!({ "uuid": u }))
        .collect();
    serde_json::json!({ "reviewers": reviewers })
}

/// Replace a pull request's reviewer list (`PUT …/pullrequests/{n}` with
/// `{reviewers:[{uuid}…]}`). The field is PROVIDED, so the omit-wipes gotcha doesn't
/// apply, and Bitbucket's partial-update semantics preserve the omitted
/// title/description (validated live). The server rejects the PR author as a
/// reviewer — [`reviewer_candidates`] filters the author out up front.
pub async fn set_pr_reviewers(repo_path: &str, number: u64, uuids: &[String]) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let payload = build_reviewers_body(uuids);
    let path = format!("{base}/pullrequests/{number}");
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pull request").await?;
    Ok(())
}

/// One `/workspaces/{ws}/members` page — `values` plus the absolute `next` link
/// (one of several bounded `next`-following reads; the bound is below).
#[derive(Deserialize, Default)]
struct BbMembersPage {
    #[serde(default)]
    values: Vec<BbMembership>,
    #[serde(default)]
    next: Option<String>,
}

/// A workspace-membership wrapper (`{type, user, workspace}`) — only the user matters.
#[derive(Deserialize, Default)]
struct BbMembership {
    #[serde(default)]
    user: Option<BbUser>,
}

/// Author-uuid-only PR read: candidates must exclude the author, because Bitbucket
/// rejects the PR author as a reviewer server-side.
#[derive(Deserialize, Default)]
struct BbPrAuthorOnly {
    #[serde(default)]
    author: Option<BbUser>,
}

/// Map + filter workspace members into picker candidates. Pure (testable): drops
/// uuid-less entries and the PR author, and sorts by label (case-insensitive) so
/// the popover list is stable across refetches.
fn reviewer_candidates_from(members: Vec<BbUser>, author_uuid: &str) -> Vec<ForgeUserRef> {
    let mut out: Vec<ForgeUserRef> = members
        .into_iter()
        .filter_map(|u| {
            let id = u.uuid.clone().unwrap_or_default();
            if id.is_empty() || id == author_uuid {
                return None;
            }
            Some(ForgeUserRef {
                id,
                label: user_login(&u),
                avatar_url: user_avatar(&u),
                is_bot: false,
            })
        })
        .collect();
    out.sort_by_key(|a| a.label.to_lowercase());
    out
}

/// Walk a workspace's members, following `next` up to 5 pages (500 members at
/// `pagelen=100`) — a larger workspace truncates rather than hanging the caller,
/// consistent with the module's bounded-pagination posture. Shared by
/// [`reviewer_candidates`] (which then filters the PR author) and
/// [`member_candidates`] (which keeps everyone).
async fn workspace_members(creds: &BbCredentials, ws: &str) -> AppResult<Vec<BbUser>> {
    let mut members: Vec<BbUser> = Vec::new();
    let mut url = format!(
        "workspaces/{}/members?pagelen=100&fields=values.user.uuid,values.user.display_name,values.user.nickname,values.user.links.avatar.href,next",
        encode_query_value(ws),
    );
    for _ in 0..5 {
        let page: BbMembersPage = http::bb_get_json(creds, &url, "workspace members").await?;
        members.extend(page.values.into_iter().filter_map(|m| m.user));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(members)
}

/// The reviewer picker's candidate list: the repo's WORKSPACE members, minus the user
/// the server would reject as a reviewer. For an EXISTING PR (`Some(number)`) that's
/// the PR author; at CREATE time (`None`, no PR yet) it's the VIEWER (the create body's
/// author, whom the server 400s "…is the author…").
pub async fn reviewer_candidates(
    repo_path: &str,
    number: Option<u64>,
) -> AppResult<Vec<ForgeUserRef>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let exclude_uuid = match number {
        Some(n) => {
            let pr_path = format!("{base}/pullrequests/{n}?fields=author.uuid");
            let pr: BbPrAuthorOnly = http::bb_get_json(&creds, &pr_path, "pull request").await?;
            pr.author.and_then(|a| a.uuid).unwrap_or_default()
        }
        None => {
            // No PR yet — the viewer would be its author, so exclude them (the
            // pr_approvals `user` idiom).
            let me: BbUser = http::bb_get_json(&creds, "user", "user").await?;
            me.uuid.unwrap_or_default()
        }
    };

    let (ws, _slug) = workspace_slug(repo_path).await?;
    let members = workspace_members(&creds, &ws).await?;
    Ok(reviewer_candidates_from(members, &exclude_uuid))
}

/// A newly-created PR's identity (id + web link), for mapping onto [`PrRef`].
#[derive(Deserialize)]
struct BbCreatedPr {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
}

/// Build the create-PR body. Pure (testable). A non-empty `reviewers` (account uuids)
/// adds a `reviewers` array (`[{uuid},…]`); an EMPTY list OMITS the key entirely, which
/// preserves the server's default-reviewer auto-add (sending `reviewers: []` would
/// suppress it). The author must not appear (the server 400s "…is the author…").
fn build_create_body(
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    reviewers: &[String],
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "title": title,
        "description": body,
        "source": { "branch": { "name": head } },
        "destination": { "branch": { "name": base } },
        "draft": draft,
    });
    if !reviewers.is_empty() {
        let list: Vec<serde_json::Value> = reviewers
            .iter()
            .map(|u| serde_json::json!({ "uuid": u }))
            .collect();
        payload["reviewers"] = serde_json::Value::Array(list);
    }
    payload
}

/// Find an existing OPEN PR from `head` into `base`. Pure (testable). `prs_for_branch`
/// already constrains source + OPEN but NOT the destination, so filter on
/// `base_ref_name == base` to catch only a genuine same-source→same-dest duplicate.
fn duplicate_pr_number(open_prs: &[PrInfo], base: &str) -> Option<u64> {
    open_prs
        .iter()
        .find(|p| p.base_ref_name == base)
        .map(|p| p.number)
}

/// Seed git's credential store with the Bitbucket API token so a subsequent HTTPS
/// clone / fetch / pull / push authenticates non-interactively. Best-effort (no stored
/// token, a missing helper, or a non-zero exit are tolerated — the git op surfaces any
/// real auth failure); it only ever ADDS a credential. Seeds at most ONCE per process
/// (the seed persists in the OS store; the keyring READ is separately cached in
/// `http::load_credentials`, so the macOS keychain prompt does not re-pop after the
/// first), re-armed by [`reset_credential_seed`] when the stored token changes.
///
/// Runs `git credential approve` OUTSIDE any repo (`run_git_input(None, …)`) and takes
/// NO repo lock, so it stays safe to call from a context that already holds the per-repo
/// mutating lock. Do NOT switch this to a locking runner.
///
/// SECURITY: the token is fed on STDIN ONLY — never argv / env / git config. NOTE:
/// git-over-HTTPS REQUIRES the `x-bitbucket-api-token-auth` sentinel username; the
/// account email authenticates the REST API but NOT git (probe-validated with
/// `git ls-remote`). Changing the username to the email breaks auth.
///
/// Returns whether a credential is now in the store. Callers gate credential-dependent
/// `-c` entries (e.g. `credential.interactive=false`) on it, so an unconfigured user
/// keeps git's ambient — possibly interactive — behavior, fail-open.
pub async fn seed_git_credential() -> bool {
    // Fast path: a prior seed this session already succeeded (latch is set only
    // AFTER `approve` exits 0, so `true` means the credential is really stored).
    if CREDENTIAL_SEEDED.load(Ordering::Acquire) {
        return true;
    }
    // Serialize attempts: concurrent first ops WAIT here for the in-flight seed
    // (which may be blocked on the first macOS keychain prompt) instead of racing
    // ahead unauthenticated; each waiter re-checks once it holds the lock.
    let _guard = CREDENTIAL_SEED_LOCK.lock().await;
    if CREDENTIAL_SEEDED.load(Ordering::Acquire) {
        return true;
    }
    let Ok(creds) = http::load_credentials().await else {
        return false; // no stored token → nothing to seed; ambient auth unchanged
    };
    let approve_input = format!(
        "protocol=https\nhost={BB_HOST}\nusername=x-bitbucket-api-token-auth\npassword={}\n\n",
        creds.token
    );
    let seeded = crate::git::runner::run_git_input(
        None,
        &["credential", "approve"],
        Some(&approve_input),
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .is_ok();
    if seeded {
        // Latch ONLY on success — a transient helper failure must not stop a later
        // op from retrying the seed.
        CREDENTIAL_SEEDED.store(true, Ordering::Release);
    }
    seeded
}

/// Re-arm the once-per-process seed latch so the next Bitbucket git op re-seeds git's
/// credential store — called whenever the stored token changes (connect / disconnect),
/// so a re-authenticated token replaces the persisted git credential.
pub(crate) fn reset_credential_seed() {
    CREDENTIAL_SEEDED.store(false, Ordering::Release);
}

/// Evict the seeded entry from git's OS credential store (`git credential reject`, same
/// protocol/host/username shape the seed wrote, no password — helpers match on those
/// fields, so ONLY our sentinel-account entry is erased; a user's own Bitbucket
/// credential under a different username is untouched). Called on disconnect, since git's
/// store is SEPARATE from our keyring. Best-effort.
async fn evict_git_credential() {
    let reject_input =
        format!("protocol=https\nhost={BB_HOST}\nusername=x-bitbucket-api-token-auth\n\n");
    let _ = crate::git::runner::run_git_input(
        None,
        &["credential", "reject"],
        Some(&reject_input),
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await;
}

/// Strip an embedded `user@` from an `https://` URL's authority so git's credential
/// lookup keys on the host alone and finds the seeded `x-bitbucket-api-token-auth` entry.
/// Bitbucket's clone links embed the account username; git SCOPES its credential lookup
/// by the URL username when present, so a `user@` URL asks for account=`user`, misses the
/// sentinel seed, and re-prompts — on Windows GCM as well as macOS osxkeychain.
/// Non-`https` URLs and URLs without userinfo pass through unchanged.
pub(crate) fn strip_https_userinfo(url: &str) -> String {
    let Some(rest) = url.strip_prefix("https://") else {
        return url.to_string();
    };
    let (authority, path) = match rest.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (rest, None),
    };
    let Some((_userinfo, hostport)) = authority.rsplit_once('@') else {
        return url.to_string(); // no userinfo → unchanged
    };
    match path {
        Some(p) => format!("https://{hostport}/{p}"),
        None => format!("https://{hostport}"),
    }
}

/// The one-shot `-c` entries for a SEEDED Bitbucket network op (the Bitbucket analogue
/// of `github_credential_entries`). Pure/format-only:
///
///  - `credential.interactive=false` — the seeded credential answers the fill, so an
///    interactive helper GUI (e.g. GCM's dialog) must not pop on a stale token. Callers
///    apply these only when the seed SUCCEEDED, so an unconfigured user keeps ambient auth.
///  - For a userinfo remote (`https://user@bitbucket.org/…`): a transient
///    `url.<stripped>.insteadOf=<url>` rewrite so git's credential lookup resolves to the
///    bare host and finds the sentinel seed (see [`strip_https_userinfo`]). The stored
///    remote is never mutated. Safe as a `-c` key: Bitbucket URLs contain no `=`.
pub(crate) fn bitbucket_credential_entries(url: &str) -> Vec<String> {
    let mut entries = vec![CREDENTIAL_NONINTERACTIVE.to_string()];
    let stripped = strip_https_userinfo(url);
    if stripped != url {
        entries.push(format!("url.{stripped}.insteadOf={url}"));
    }
    entries
}

/// The one-shot `-c` entry suppressing interactive credential-helper GUIs (e.g.
/// GCM's dialog — `GIT_TERMINAL_PROMPT=0` doesn't block those). Shared by
/// [`bitbucket_credential_entries`] and `forge_clone`'s Bitbucket arm so the
/// literal lives in one place.
pub(crate) const CREDENTIAL_NONINTERACTIVE: &str = "credential.interactive=false";

/// Push `head` to origin, then open a pull request from `head` into `base`. Mirrors
/// `gitlab::create_mr`, with one Bitbucket-specific hazard: a create POST for a
/// source→dest pair that already has an OPEN PR returns 201 with the EXISTING PR but ALSO
/// applies the payload (title overwritten, an omitted description wiped to ""). So the
/// duplicate pre-check runs FIRST (read-only) and errors naming that PR — nothing is
/// pushed or changed. Order: pre-check → validate → push → POST create; a POST failure
/// after a successful push discloses the partial state. The push routes through the shared
/// `credential_config_for_remote` funnel (STDIN-only token seed + one-shot `-c` entries) —
/// the token never reaches argv / env / git config.
#[allow(clippy::too_many_arguments)]
pub async fn create_pr(
    state: &crate::state::AppState,
    repo_path: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    reviewers: &[String],
) -> AppResult<PrRef> {
    for b in [base, head] {
        if b.is_empty() || b.starts_with('-') {
            return Err(AppError::InvalidArgument(format!("invalid branch: {b}")));
        }
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("a PR title is required".into()));
    }

    // Pre-mutation guard: a duplicate create is a silent overwrite on Bitbucket, so
    // refuse it before pushing or POSTing anything.
    let open_prs = prs_for_branch(repo_path, head).await?;
    if let Some(n) = duplicate_pr_number(&open_prs, base) {
        return Err(AppError::Bitbucket(format!(
            "Pull request #{n} already exists for {head} → {base} — creating another would \
             silently overwrite it, so nothing was changed. Open PR #{n} instead."
        )));
    }

    // A PR needs the branch on the remote first. Route the push's credentials through
    // the same `credential_config_for_remote` funnel every other network op uses; an
    // unconfigured user (or an SSH origin) gets no entries — fail-open.
    let cred = crate::forge::credential_config_for_remote(repo_path, "origin").await?;
    let push_args =
        crate::git::remote::with_credentials(&cred, &["push", "-u", "origin", head]);
    let push_refs: Vec<&str> = push_args.iter().map(String::as_str).collect();
    crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &push_refs,
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await?;

    let creds = http::load_credentials().await?;
    let repo = repo_base(repo_path).await?;
    let path = format!("{repo}/pullrequests");
    let payload = build_create_body(base, head, title, body, draft, reviewers);
    let created: BbCreatedPr = http::bb_post_json(&creds, &path, &payload, "created pull request")
        .await
        .map_err(|e| {
            // The branch is already on the remote; disclose that partial state so the
            // user knows a retry needn't re-push (and the branch isn't orphaned silently).
            AppError::Bitbucket(format!("The branch was pushed, but creating the pull request failed: {e}"))
        })?;
    Ok(PrRef {
        number: created.id,
        url: html_href(&created.links),
    })
}

/// Approve a pull request (`POST …/pullrequests/{n}/approve`, no body). The author CAN
/// self-approve on Bitbucket.
pub async fn approve_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/approve");
    http::bb_post_empty(&creds, &path).await
}

/// Revoke the viewer's approval (`DELETE …/pullrequests/{n}/approve`). Unapproving a
/// MERGED PR is rejected server-side (400 CANNOT_UNAPPROVED_MERGED_PR), surfacing via
/// [`http::http_error`].
pub async fn unapprove_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/approve");
    http::bb_delete(&creds, &path).await
}

/// Request changes on a pull request (`POST …/pullrequests/{n}/request-changes`).
/// The optional review comment rides as a plain PR comment AFTER the state change,
/// mirroring `gitlab::request_changes_mr` — if only the comment fails, the error
/// says the request itself stood rather than reading as a clean no-op.
pub async fn request_changes_pr(repo_path: &str, number: u64, body: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/request-changes");
    http::bb_post_empty(&creds, &path).await?;
    if !body.trim().is_empty() {
        if let Err(e) = comment_pr(repo_path, number, body).await {
            return Err(AppError::Bitbucket(format!(
                "Changes were requested, but posting the comment failed: {e}"
            )));
        }
    }
    Ok(())
}

/// Submit a review on a PR — SEQUENTIAL. Bitbucket has NO invisible-draft flow that
/// can be cleared (a `pending:true` comment is stranded invisible — probed), so each
/// comment posts LIVE: the summary as a plain PR comment, each inline comment as an
/// anchored one, then the verdict (approve / request-changes reuse the existing fns;
/// comment does nothing extra). Partial failure STOPS at the first error and discloses
/// exactly what landed. Guards run in the dispatch.
pub async fn review_submit(
    repo_path: &str,
    number: u64,
    verdict: &str,
    summary: Option<&str>,
    comments: &[DraftCommentIn],
) -> AppResult<ReviewSubmitOut> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let endpoint = format!("{base}/pullrequests/{number}/comments");
    let total = comments.len() as u32;
    let has_summary = summary.map(str::trim).is_some_and(|s| !s.is_empty());

    // The summary → a plain PR comment. Failure here means nothing landed yet.
    if let Some(s) = summary.filter(|s| !s.trim().is_empty()) {
        let payload = serde_json::json!({ "content": { "raw": s } });
        http::bb_post_json::<serde_json::Value>(&creds, &endpoint, &payload, "review summary")
            .await
            .map_err(|e| {
                AppError::Bitbucket(format!(
                    "The review summary couldn't be posted, so the review was not submitted: {e}"
                ))
            })?;
    }

    // Each comment → a LIVE anchored comment. Stop at the first failure and disclose.
    for (i, c) in comments.iter().enumerate() {
        let inline = match c.side.as_str() {
            "new" => serde_json::json!({ "path": c.path, "to": c.line }),
            "old" => serde_json::json!({ "path": c.path, "from": c.line }),
            other => {
                return Err(AppError::InvalidArgument(format!("invalid side: {other}")));
            }
        };
        let payload = serde_json::json!({ "content": { "raw": c.body }, "inline": inline });
        if let Err(e) =
            http::bb_post_json::<serde_json::Value>(&creds, &endpoint, &payload, "review comment")
                .await
        {
            return Err(AppError::Bitbucket(format!(
                "Posted {} of {} review comments before the failure; the review was not \
                 submitted. Check the pull request on Bitbucket before retrying. ({e})",
                i, total
            )));
        }
    }

    // Apply the verdict. Approve / request-changes reuse the existing fns. Every
    // comment (and the summary) already posted LIVE above, so a verdict failure must
    // disclose that — otherwise a retry double-posts every comment.
    let verdict_result = match verdict {
        "approve" => approve_pr(repo_path, number).await,
        "request_changes" => request_changes_pr(repo_path, number, "").await,
        _ => Ok(()),
    };
    if let Err(e) = verdict_result {
        let action = if verdict == "approve" {
            "approve"
        } else {
            "request changes"
        };
        // Only mention what actually landed (an approve-only review posted nothing).
        let landed = if has_summary || total > 0 {
            let n = if has_summary { total + 1 } else { total };
            format!(
                "the {n} review comment(s) were already posted successfully — do NOT resubmit \
                 them; "
            )
        } else {
            String::new()
        };
        return Err(AppError::Bitbucket(format!(
            "The review was posted, but the {action} step failed: {landed}only re-run the \
             {action} action on Bitbucket. ({e})"
        )));
    }

    Ok(ReviewSubmitOut {
        posted: total,
        total,
        verdict_applied: verdict != "comment",
    })
}

/// Revoke the viewer's requested-changes state
/// (`DELETE …/pullrequests/{n}/request-changes`). Works on every Bitbucket plan —
/// unlike GitLab, whose direct undo is Premium-only — so the frontend renders the
/// request-changes control as a real toggle for Bitbucket.
pub async fn unrequest_changes_pr(repo_path: &str, number: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/request-changes");
    http::bb_delete(&creds, &path).await
}

/// A PR participant (`{user, approved, state}`) — the approval read source. `state` is
/// `"approved"` / `"changes_requested"` / null.
#[derive(Deserialize, Default)]
struct BbParticipant {
    #[serde(default)]
    user: Option<BbUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    approved: bool,
    #[serde(default)]
    state: Option<String>,
}

/// The participants block on a single-PR GET (for the approvals read).
#[derive(Deserialize, Default)]
struct BbPrParticipants {
    #[serde(default, deserialize_with = "null_to_default")]
    participants: Vec<BbParticipant>,
}

/// Display name for a PR participant: nickname → display_name → username (participant
/// objects carry no `username`, so in practice nickname then display_name). Used for
/// OTHER participants in `approved_by`; the viewer's own entry differs (see
/// [`build_approval_state`]).
fn participant_login(u: &BbUser) -> String {
    u.nickname
        .clone()
        .or_else(|| u.display_name.clone())
        .or_else(|| u.username.clone())
        .unwrap_or_default()
}

/// Build the neutral [`ApprovalState`] from a PR's participants. Pure (testable).
///
/// The viewer is matched on `participant.user.uuid`, NOT a name: participant user objects
/// never carry `username` (privacy), so a name match fails whenever the viewer's nickname
/// differs from their username.
///
/// `approved_by` mixes two derivations on purpose: other approvers get their
/// human-readable [`participant_login`], but the VIEWER's entry emits `viewer_login` —
/// the exact string `status().login` produces, which the frontend's optimistic
/// add/remove inserts into `approvedBy`. Anything else flickers/duplicates across the
/// optimistic window.
///
/// Bitbucket exposes no required-approval count here (it's a repo-settings merge check),
/// so `approvals_required`/`_left` are 0.
fn build_approval_state(
    participants: &[BbParticipant],
    viewer_uuid: &str,
    viewer_login: &str,
) -> ApprovalState {
    let is_viewer = |u: &BbUser| -> bool {
        !viewer_uuid.is_empty() && u.uuid.as_deref() == Some(viewer_uuid)
    };
    let approved_by: Vec<String> = participants
        .iter()
        .filter(|p| p.approved)
        .filter_map(|p| {
            p.user.as_ref().map(|u| {
                if is_viewer(u) {
                    viewer_login.to_string()
                } else {
                    participant_login(u)
                }
            })
        })
        .filter(|n| !n.is_empty())
        .collect();
    let viewer = participants
        .iter()
        .find(|p| p.user.as_ref().map(is_viewer).unwrap_or(false));
    let viewer_has_approved = viewer.map(|p| p.approved).unwrap_or(false);
    let viewer_requested_changes = viewer
        .and_then(|p| p.state.as_deref())
        .map(|s| s == "changes_requested")
        .unwrap_or(false);
    ApprovalState {
        viewer_has_approved,
        approved_by,
        approvals_required: 0,
        approvals_left: 0,
        viewer_requested_changes,
    }
}

/// The completed reviewers of a PR — every participant who cast a verdict. Bitbucket has
/// no review objects, so participant `state` IS the verdict; commenters (`null`) and
/// unrecognized states are skipped, as are participants with no braced uuid. Identity =
/// braced uuid (the one field on participant objects), matching the reviewers picker so
/// the caller can subtract these from pending. Pure (testable).
fn completed_reviewers_from(participants: &[BbParticipant]) -> Vec<CompletedReviewerOut> {
    participants
        .iter()
        .filter_map(|p| {
            let state = match p.state.as_deref() {
                Some("approved") => "APPROVED",
                Some("changes_requested") => "CHANGES_REQUESTED",
                // Commenters (null) and any unrecognized state didn't cast a verdict.
                _ => return None,
            };
            let u = p.user.as_ref()?;
            let id = u.uuid.clone().unwrap_or_default();
            if id.is_empty() {
                return None;
            }
            Some(CompletedReviewerOut {
                user: ForgeUserRef {
                    id,
                    label: user_login(u),
                    avatar_url: user_avatar(u),
                    is_bot: false,
                },
                state: state.to_string(),
            })
        })
        .collect()
}

/// The viewer's + the PR's approval state (`GET …/pullrequests/{n}` participants). The
/// viewer is resolved by a one-time `GET /2.0/user` (its braced `uuid` — the only
/// identity field present on both the self object and participant objects), then
/// matched against participants by UUID. The viewer's `approved_by` entry uses the
/// stored username (falling back to the self object's display name) so it equals
/// `status().login` and reconciles with the frontend's optimistic toggle.
pub async fn pr_approvals(repo_path: &str, number: u64) -> AppResult<ApprovalState> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}?fields=participants.user.uuid,participants.user.nickname,participants.user.display_name,participants.approved,participants.state");
    let pr: BbPrParticipants = http::bb_get_json(&creds, &path, "pull request participants").await?;

    // Resolve the viewer's uuid (for matching) and login (for the reconciling
    // approved_by entry) from the self object — one GET, like GitLab's approvals read.
    let self_user = http::bb_get_json::<BbUser>(&creds, "user", "user").await.ok();
    let viewer_uuid = self_user
        .as_ref()
        .and_then(|u| u.uuid.clone())
        .unwrap_or_default();
    // `status().login` = username || display_name; the stored username is the same
    // value persisted at connect time, so prefer it and fall back to the self object.
    let viewer_login = read_stored_username().await.unwrap_or_else(|| {
        self_user
            .as_ref()
            .and_then(|u| u.username.clone().or_else(|| u.display_name.clone()))
            .unwrap_or_default()
    });
    Ok(build_approval_state(&pr.participants, &viewer_uuid, &viewer_login))
}

// ── Pull-request tasks (checklist) ───────────────────────────────────────────────
//
// Bitbucket PRs carry a native task checklist (`…/pullrequests/{id}/tasks`) — a
// Bitbucket-only surface (`implemented.pr_tasks`). A task is UNRESOLVED / RESOLVED with
// free-text content, optionally attached to a PR comment. Task/user ids are numeric on
// the wire and travel as Strings over IPC (the u64-precision rule); task user objects
// carry NO `username`, so the neutral shape reads display_name → nickname only.

/// A pull-request task, as the frontend consumes it. `id`/`commentId` are the numeric
/// server ids serialized as Strings (u64-precision rule); `state` is
/// `"UNRESOLVED"` / `"RESOLVED"`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrTask {
    pub id: String,
    pub state: String,
    /// The task text (`content.raw`).
    pub text: String,
    /// The creator's display name (falls back to nickname, then ""). Never a username
    /// (task user objects don't carry one).
    pub creator: String,
    pub created_on: String,
    /// The display name of whoever resolved it, or `None` while unresolved.
    pub resolved_by: Option<String>,
    /// The id of the PR comment this task is attached to, or `None` for a standalone
    /// task. Numeric on the wire → String over IPC.
    pub comment_id: Option<String>,
    /// The task's web (`links.html.href`) URL, or "" when absent.
    pub url: String,
}

/// A task's `content` block (`{raw, html, markup}`) — only `raw` is consumed.
#[derive(Deserialize, Default)]
struct BbTaskContent {
    #[serde(default, deserialize_with = "null_to_default")]
    raw: String,
}

/// The PR comment a task is attached to (`{id, links}`) — only the numeric id matters.
#[derive(Deserialize, Default)]
struct BbTaskComment {
    #[serde(default)]
    id: Option<u64>,
}

/// A PR task as `…/tasks` returns it. All fields tolerated null/missing.
#[derive(Deserialize, Default)]
struct BbTask {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default, deserialize_with = "null_to_default")]
    state: String,
    #[serde(default)]
    content: Option<BbTaskContent>,
    #[serde(default)]
    creator: Option<BbUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    created_on: String,
    #[serde(default)]
    resolved_by: Option<BbUser>,
    #[serde(default)]
    comment: Option<BbTaskComment>,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
}

/// One `…/tasks` page — `values` plus the absolute `next` link (bounded pagination).
#[derive(Deserialize, Default)]
struct BbTasksPage {
    #[serde(default)]
    values: Vec<BbTask>,
    #[serde(default)]
    next: Option<String>,
}

/// A task user's display name: display_name → nickname → "" (never a username — task
/// user objects don't carry one).
fn task_user_name(u: &BbUser) -> String {
    u.display_name
        .clone()
        .or_else(|| u.nickname.clone())
        .unwrap_or_default()
}

/// Map a raw Bitbucket task onto the neutral [`PrTask`]. Pure (testable).
fn from_bb_task(t: BbTask) -> PrTask {
    PrTask {
        id: t.id.map(|n| n.to_string()).unwrap_or_default(),
        state: t.state,
        text: t.content.map(|c| c.raw).unwrap_or_default(),
        creator: t.creator.as_ref().map(task_user_name).unwrap_or_default(),
        created_on: t.created_on,
        resolved_by: t.resolved_by.as_ref().map(task_user_name),
        comment_id: t
            .comment
            .and_then(|c| c.id)
            .map(|n| n.to_string()),
        url: html_href(&t.links),
    }
}

/// A PR's task checklist, in list order. Follows `next` up to 5 pages (the
/// workspace_members idiom), so a long checklist is bounded rather than unbounded.
pub async fn pr_tasks(repo_path: &str, number: u64) -> AppResult<Vec<PrTask>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut url = format!("{base}/pullrequests/{number}/tasks?pagelen=100");
    let mut out: Vec<PrTask> = Vec::new();
    for _ in 0..5 {
        let page: BbTasksPage = http::bb_get_json(&creds, &url, "pull request tasks").await?;
        out.extend(page.values.into_iter().map(from_bb_task));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

/// Parse a task id from the String the frontend carries (numeric server id). A
/// non-numeric value is a client bug → `InvalidArgument` rather than a 4xx round-trip.
fn parse_task_id(task_id: &str) -> AppResult<u64> {
    task_id
        .trim()
        .parse::<u64>()
        .map_err(|_| AppError::InvalidArgument(format!("invalid task id: {task_id}")))
}

/// Create a PR task (`POST …/tasks`, `{content:{raw}}` → 201 full task). Empty /
/// whitespace-only text is rejected before the request (a pre-mutation guard).
pub async fn pr_task_create(repo_path: &str, number: u64, text: &str) -> AppResult<PrTask> {
    if text.trim().is_empty() {
        return Err(AppError::InvalidArgument("a task description is required".into()));
    }
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/tasks");
    let payload = serde_json::json!({ "content": { "raw": text } });
    let created: BbTask = http::bb_post_json(&creds, &path, &payload, "created task").await?;
    Ok(from_bb_task(created))
}

/// Edit a PR task's text (`PUT …/tasks/{id}`, `{content:{raw}}` → 200; state
/// survives). Empty text is rejected up front; a non-numeric `task_id` errors before
/// the request.
pub async fn pr_task_edit(
    repo_path: &str,
    number: u64,
    task_id: &str,
    text: &str,
) -> AppResult<PrTask> {
    if text.trim().is_empty() {
        return Err(AppError::InvalidArgument("a task description is required".into()));
    }
    let id = parse_task_id(task_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/tasks/{id}");
    let payload = serde_json::json!({ "content": { "raw": text } });
    let edited: BbTask = http::bb_put_json(&creds, &path, &payload, "task").await?;
    Ok(from_bb_task(edited))
}

/// Resolve / unresolve a PR task (`PUT …/tasks/{id}`, `{state:…}` → 200; content
/// survives). Partial PUT is safe (no full-echo requirement — validated live).
pub async fn pr_task_set_state(
    repo_path: &str,
    number: u64,
    task_id: &str,
    resolved: bool,
) -> AppResult<PrTask> {
    let id = parse_task_id(task_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/tasks/{id}");
    let state = if resolved { "RESOLVED" } else { "UNRESOLVED" };
    let payload = serde_json::json!({ "state": state });
    let updated: BbTask = http::bb_put_json(&creds, &path, &payload, "task").await?;
    Ok(from_bb_task(updated))
}

/// Delete a PR task (`DELETE …/tasks/{id}` → 204).
pub async fn pr_task_delete(repo_path: &str, number: u64, task_id: &str) -> AppResult<()> {
    let id = parse_task_id(task_id)?;
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pullrequests/{number}/tasks/{id}");
    http::bb_delete(&creds, &path).await
}

// ── Pipelines (CI, write) ───────────────────────────────────────────────────────

/// Build the pipeline-trigger body for a ref. Pure (testable). `ref_type` is
/// `"branch"`/`"tag"` — the dispatch dialog's ref field is free-text ("Branch or tag"),
/// so the backend detects which it is. A non-empty `workflow` adds a `selector`
/// (`{type:"custom", pattern}`) INSIDE `target`, dispatching that named custom pipeline;
/// empty triggers the ref's default (the rerun path passes ""). A non-empty `inputs` adds
/// a top-level `variables` array (sibling of `target`); an empty map omits it.
fn build_trigger_body(
    git_ref: &str,
    ref_type: &str,
    workflow: &str,
    inputs: &std::collections::HashMap<String, String>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "target": {
            "type": "pipeline_ref_target",
            "ref_type": ref_type,
            "ref_name": git_ref,
        }
    });
    if !workflow.is_empty() {
        body["target"]["selector"] = serde_json::json!({
            "type": "custom",
            "pattern": workflow,
        });
    }
    if !inputs.is_empty() {
        // Sort by key for a deterministic body (stable tests + reproducible requests).
        let mut keys: Vec<&String> = inputs.keys().collect();
        keys.sort();
        let variables: Vec<serde_json::Value> = keys
            .into_iter()
            .map(|k| serde_json::json!({ "key": k, "value": inputs[k] }))
            .collect();
        body["variables"] = serde_json::Value::Array(variables);
    }
    body
}

/// Cancel an in-flight pipeline (`POST …/pipelines/{uuid}/stopPipeline`). `run_id` is
/// the build number, resolved to the pipeline UUID first (reusing the read-side
/// resolution). A 400 "already completed" surfaces via [`http::http_error`].
pub async fn cancel_run(repo_path: &str, run_id: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let p = resolve_pipeline(&creds, &ws, &slug, run_id).await?;
    let path = format!(
        "repositories/{}/{}/pipelines/{}/stopPipeline",
        encode_query_value(&ws),
        encode_query_value(&slug),
        encode_uuid(&p.uuid),
    );
    http::bb_post_empty(&creds, &path).await
}

/// Re-run a finished pipeline. Bitbucket has no rerun endpoint, so "re-run" re-triggers
/// a fresh pipeline on the original run's branch (`run_id` is the build number →
/// resolve → its `target.ref_name` → trigger). The new pipeline is returned but ignored.
pub async fn rerun_run(repo_path: &str, run_id: u64) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let p = resolve_pipeline(&creds, &ws, &slug, run_id).await?;
    let branch = p
        .target
        .as_ref()
        .and_then(|t| t.ref_name.clone())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::Bitbucket(format!(
                "could not determine the branch of Bitbucket pipeline #{run_id} to re-run"
            ))
        })?;
    let path = format!(
        "repositories/{}/{}/pipelines/",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    // Re-run re-triggers the branch's DEFAULT pipeline (no custom selector). A rerun
    // always targets the original run's BRANCH.
    let payload = build_trigger_body(&branch, "branch", "", &std::collections::HashMap::new());
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "pipeline").await?;
    Ok(())
}

/// Best-effort detection of whether `git_ref` names a TAG (vs a branch) in this repo,
/// by probing `GET repositories/{ws}/{slug}/refs/tags/{ref}` — a 200 means the tag
/// exists. Any error or non-200 (including a network hiccup, a 404 for a branch ref,
/// or an auth failure) resolves to `false` (treat as a branch): this only refines the
/// dispatch body's `ref_type`, so it must never sink the dispatch itself.
async fn ref_is_tag(creds: &BbCredentials, ws: &str, slug: &str, git_ref: &str) -> bool {
    let path = format!(
        "repositories/{}/{}/refs/tags/{}",
        encode_query_value(ws),
        encode_query_value(slug),
        encode_query_value(git_ref),
    );
    matches!(http::bb_get_text_status(creds, &path).await, Ok((200, _)))
}

/// Manually start a pipeline on `git_ref` (`POST …/pipelines/`), with `inputs` as
/// pipeline variables and a non-empty `workflow` selecting a named CUSTOM pipeline. The
/// dialog's ref field is free-text, so the ref type is detected ([`ref_is_tag`]). A 400
/// (pipelines disabled / missing yml / unknown selector) surfaces its raw message via
/// [`http::http_error`], which prefers the `error.detail` text.
pub async fn dispatch_ci(
    repo_path: &str,
    workflow: &str,
    git_ref: &str,
    inputs: &std::collections::HashMap<String, String>,
) -> AppResult<()> {
    if git_ref.is_empty() || git_ref.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch: {git_ref}"
        )));
    }
    let creds = http::load_credentials().await?;
    let (ws, slug) = workspace_slug(repo_path).await?;
    let path = format!(
        "repositories/{}/{}/pipelines/",
        encode_query_value(&ws),
        encode_query_value(&slug),
    );
    let ref_type = if ref_is_tag(&creds, &ws, &slug, git_ref).await {
        "tag"
    } else {
        "branch"
    };
    let payload = build_trigger_body(git_ref, ref_type, workflow, inputs);
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "pipeline").await?;
    Ok(())
}

/// Parse the CUSTOM pipeline names declared in a `bitbucket-pipelines.yml`, in file
/// order. A hand-rolled line scanner (no YAML crate in the dep tree — kept that way):
/// find the top-level `pipelines:` key, then its child `custom:` mapping, and return
/// the immediate child key names. Handles full-line and trailing `#` comments,
/// single/double-quoted keys, blank lines, and an arbitrary consistent indent width
/// (measured from the first child rather than assumed). Ignores list items (`- `) and
/// deeper grandchildren; stops when a line dedents to `custom:`'s level or above. Bails
/// to `vec![]` (never errors) on anything it can't confidently read — tabs in
/// indentation, an inline flow value on `custom:` (`custom: {…`), etc. Capped at 50.
fn parse_custom_pipeline_names(yml: &str) -> Vec<String> {
    const MAX_NAMES: usize = 50;

    /// Strip a trailing ` # comment` (only when the `#` is preceded by whitespace or
    /// starts the token — a `#` inside an unquoted value is rare in keys, but the caller
    /// only ever passes the pre-colon key text here). Returns the trimmed-right remainder.
    fn strip_trailing_comment(s: &str) -> &str {
        match s.find(" #") {
            Some(i) => &s[..i],
            None => s,
        }
    }

    /// The indent width (count of leading spaces) of a line. A tab in the indentation
    /// returns `None` — the caller bails, since tab/space mixing makes levels ambiguous.
    fn indent_of(line: &str) -> Option<usize> {
        let mut n = 0;
        for c in line.chars() {
            match c {
                ' ' => n += 1,
                '\t' => return None,
                _ => break,
            }
        }
        Some(n)
    }

    /// Strip matching surrounding single/double quotes from a key name.
    fn unquote(s: &str) -> &str {
        let s = s.trim();
        let b = s.as_bytes();
        if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
            &s[1..s.len() - 1]
        } else {
            s
        }
    }

    // A "content line" is one with a non-comment, non-blank payload. We track the
    // top-level `pipelines:` block, then the `custom:` block within it.
    #[derive(PartialEq)]
    enum Phase {
        SeekPipelines,
        SeekCustom,
        InCustom,
    }
    let mut phase = Phase::SeekPipelines;
    let mut pipelines_indent = 0usize;
    let mut custom_indent = 0usize;
    let mut child_indent: Option<usize> = None;
    let mut out: Vec<String> = Vec::new();

    for raw_line in yml.lines() {
        // Skip full-line comments and blank lines.
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = match indent_of(raw_line) {
            Some(i) => i,
            // A tab in indentation → structure is ambiguous; bail entirely.
            None => return Vec::new(),
        };

        match phase {
            Phase::SeekPipelines => {
                // Only a top-level (indent 0) `pipelines:` key counts. Strip a trailing
                // comment first (`pipelines:  # ci config`) so it doesn't read as an
                // inline flow value and bail — mirroring the SeekCustom arm.
                let key = strip_trailing_comment(trimmed);
                if indent == 0 && (key == "pipelines:" || key.starts_with("pipelines:")) {
                    // Reject an inline flow value (`pipelines: {…}`) — can't read it.
                    let after = key["pipelines:".len()..].trim();
                    if key == "pipelines:" || after.is_empty() {
                        pipelines_indent = indent;
                        phase = Phase::SeekCustom;
                    } else {
                        return Vec::new();
                    }
                }
            }
            Phase::SeekCustom => {
                // Left the pipelines block without finding custom → nothing to collect.
                if indent <= pipelines_indent {
                    return out;
                }
                let key = strip_trailing_comment(trimmed);
                if key == "custom:" || key.starts_with("custom:") {
                    let after = key["custom:".len()..].trim();
                    // An inline flow value (`custom: {…`) can't be read → bail.
                    if !(key == "custom:" || after.is_empty()) {
                        return Vec::new();
                    }
                    custom_indent = indent;
                    phase = Phase::InCustom;
                }
                // Any other key under pipelines (e.g. `default:`, `branches:`) is skipped
                // until we either find `custom:` or dedent out.
            }
            Phase::InCustom => {
                // Dedent to custom:'s level or above → the custom block ended.
                if indent <= custom_indent {
                    return out;
                }
                // Establish the child indent from the FIRST child line.
                let ci = *child_indent.get_or_insert(indent);
                // Only immediate children at exactly the child indent are pipeline names;
                // deeper lines (steps, scripts) and shallower-but-still-inside lines are
                // grandchildren/structure and skipped.
                if indent != ci {
                    continue;
                }
                // A list item (`- …`) at the child level isn't a mapping key → skip.
                if trimmed.starts_with("- ") || trimmed == "-" {
                    continue;
                }
                // A pipeline name is a `key:` mapping entry. Take the text before the
                // first colon, drop a trailing comment, unquote. NOTE: a quoted key that
                // itself contains a colon (`"a:b":`) splits at the inner colon and yields
                // a wrong name — an exotic we accept as unsupported; dispatching it just
                // 400s with a legible `detail` ("selector not found") rather than misfiring.
                if let Some(colon) = trimmed.find(':') {
                    let name = unquote(strip_trailing_comment(&trimmed[..colon]));
                    if !name.is_empty() {
                        out.push(name.to_string());
                        if out.len() >= MAX_NAMES {
                            return out;
                        }
                    }
                }
            }
        }
    }
    out
}

/// The CUSTOM pipeline names declared in the WORKING-TREE `bitbucket-pipelines.yml`
/// (`<repo_path>/bitbucket-pipelines.yml`) — the custom-dispatch picker's options. A
/// missing file is not an error (returns `vec![]`, like `dependabot_get`); other io
/// errors propagate. No credentials / network — this reads the local file only.
pub async fn custom_pipelines(repo_path: &str) -> AppResult<Vec<String>> {
    let path = std::path::Path::new(repo_path).join("bitbucket-pipelines.yml");
    let yml = match tokio::fs::read_to_string(&path).await {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e)),
    };
    Ok(parse_custom_pipeline_names(&yml))
}

// ── Deployment environments (read) ───────────────────────────────────────────────

/// A deployment environment, as the frontend consumes it — minimal by design
/// (lock/category deliberately unmapped). `adminOnly` comes from
/// `restrictions.admin_only`; `environmentType` from `environment_type.name`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BbEnvironment {
    pub uuid: String,
    pub name: String,
    /// The environment tier name (`environment_type.name`, e.g. "Test" / "Production"),
    /// or "" when missing.
    pub environment_type: String,
    pub rank: i64,
    pub hidden: bool,
    /// Whether the environment is restricted to admins (`restrictions.admin_only`).
    pub admin_only: bool,
}

/// The `environment_type` sub-object (`{name, rank}`) — only the name is mapped.
#[derive(Deserialize, Default)]
struct BbEnvType {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
}

/// The `restrictions` sub-object (`{admin_only}`).
#[derive(Deserialize, Default)]
struct BbEnvRestrictions {
    #[serde(default, deserialize_with = "null_to_default")]
    admin_only: bool,
}

/// A deployment environment as `…/environments/` returns it. All fields tolerated
/// null/missing.
#[derive(Deserialize, Default)]
struct BbRawEnvironment {
    #[serde(default, deserialize_with = "null_to_default")]
    uuid: String,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default)]
    environment_type: Option<BbEnvType>,
    #[serde(default, deserialize_with = "null_to_default")]
    rank: i64,
    #[serde(default, deserialize_with = "null_to_default")]
    hidden: bool,
    #[serde(default)]
    restrictions: Option<BbEnvRestrictions>,
}

/// One `…/environments/` page — `values` plus the absolute `next` link (bounded
/// pagination, ≤5 pages).
#[derive(Deserialize, Default)]
struct BbEnvironmentsPage {
    #[serde(default)]
    values: Vec<BbRawEnvironment>,
    #[serde(default)]
    next: Option<String>,
}

fn from_bb_environment(e: BbRawEnvironment) -> BbEnvironment {
    BbEnvironment {
        uuid: e.uuid,
        name: e.name,
        environment_type: e.environment_type.map(|t| t.name).unwrap_or_default(),
        rank: e.rank,
        hidden: e.hidden,
        admin_only: e.restrictions.map(|r| r.admin_only).unwrap_or(false),
    }
}

/// The repo's deployment environments (`GET …/environments/`), sorted by rank
/// ascending. Follows `next` up to 5 pages. Note the TRAILING SLASH (required, like
/// `pipelines/`).
pub async fn environments(repo_path: &str) -> AppResult<Vec<BbEnvironment>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut url = format!("{base}/environments/");
    let mut out: Vec<BbEnvironment> = Vec::new();
    for _ in 0..5 {
        let page: BbEnvironmentsPage =
            http::bb_get_json(&creds, &url, "environments").await?;
        out.extend(page.values.into_iter().map(from_bb_environment));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    out.sort_by_key(|e| e.rank);
    Ok(out)
}

// ── Repository settings & lifecycle ──────────────────────────────────────────
//
// The Bitbucket repo-management surface: settings read/update, the admin probe, the
// lifecycle actions (rename / visibility / delete — archive and transfer are
// platform-impossible), default reviewers, branch restrictions, pipelines config /
// variables / schedules, and webhooks. Account UUIDs the app puts in paths are
// percent-encoded (braced) via [`encode_uuid`].

/// Whether the signed-in viewer is an admin of this repo. The old
/// `/user/permissions/repositories` endpoint is 410-GONE (CHANGE-2770); the
/// replacement is `GET /2.0/repositories/{ws}?role=admin&q=slug="{slug}"` — the
/// repo appears in `values` iff the viewer is an admin. `role=owner` matched 0 even
/// for an admin, so for Bitbucket owner := admin (the caller maps both). A slug
/// containing `"` is rejected up front (it would break the quoted BBQL value).
pub async fn repo_admin(repo_path: &str) -> AppResult<bool> {
    let (ws, slug) = workspace_slug(repo_path).await?;
    if slug.contains('"') {
        return Err(AppError::Bitbucket(format!(
            "unexpected characters in repository slug: {slug}"
        )));
    }
    let creds = http::load_credentials().await?;
    // Bitbucket stores slugs lowercase and the BBQL `slug="…"` filter is case-sensitive
    // server-side — a mixed-case clone URL would match 0 rows and report a real admin as
    // non-admin. (`repo_admin_matches` below is case-insensitive.)
    let query = format!(r#"slug="{}""#, slug.to_ascii_lowercase());
    let path = format!(
        "repositories/{}?role=admin&q={}&pagelen=100",
        encode_query_value(&ws),
        encode_query_value(&query),
    );
    let page: BbPage<BbRepoSlug> = http::bb_get_json(&creds, &path, "repositories").await?;
    Ok(repo_admin_matches(&page.values, &slug))
}

/// A repo's slug only, for the admin probe's slug match.
#[derive(Deserialize)]
struct BbRepoSlug {
    #[serde(default)]
    slug: String,
}

/// Whether the admin-scoped repo list contains this slug (case-insensitive). Pure
/// (testable): the `q=slug="…"` filter is server-side, but we confirm the match
/// defensively rather than trusting a non-empty list.
fn repo_admin_matches(repos: &[BbRepoSlug], slug: &str) -> bool {
    repos.iter().any(|r| r.slug.eq_ignore_ascii_case(slug))
}

/// Delete the repository (`DELETE repositories/{ws}/{slug}`) → 204. Irreversible;
/// owner-scoped, enforced server-side.
pub async fn delete_repo(repo_path: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    http::bb_delete(&creds, &base).await
}

/// The origin remote's URL, so a rename can rewrite it preserving the scheme.
async fn origin_remote_url(repo_path: &str) -> AppResult<String> {
    crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await
}

/// Rewrite an `origin` remote URL to point at a new slug, preserving its scheme.
/// Pure (testable). Handles the three forms this app clones with: HTTPS
/// (`https://bitbucket.org/{ws}/{slug}.git`), `ssh://` SSH
/// (`ssh://git@bitbucket.org/{ws}/{slug}.git`), and scp-style SSH
/// (`git@bitbucket.org:{ws}/{slug}.git`). Returns `None` when the URL isn't a
/// recognized Bitbucket remote (so the caller leaves it alone).
fn rewritten_origin_url(old_url: &str, ws: &str, new_slug: &str) -> Option<String> {
    let trimmed = old_url.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .map(|r| ("https", r))
        .or_else(|| trimmed.strip_prefix("http://").map(|r| ("http", r)))
    {
        let (scheme, after_scheme) = rest;
        // Authority is everything up to the first '/'.
        let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
        // Strip an optional userinfo prefix (`user@`), then an optional `:port`.
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host.split_once(':').map_or(host, |(h, _)| h);
        if !host.eq_ignore_ascii_case("bitbucket.org") {
            return None;
        }
        Some(format!("{scheme}://bitbucket.org/{ws}/{new_slug}.git"))
    } else if let Some(after_scheme) = trimmed.strip_prefix("ssh://") {
        // `ssh://git@bitbucket.org/ws/slug.git` — authority is up to the first '/',
        // preserving the userinfo (`git@`) prefix like the http(s) branch preserves
        // scheme. Only rewrite when the host is actually Bitbucket.
        let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
        // Split off an optional userinfo prefix (`user@`), keeping it to re-emit.
        let (userinfo, hostport) = match authority.rsplit_once('@') {
            Some((u, h)) => (format!("{u}@"), h),
            None => (String::new(), authority),
        };
        // Strip an optional `:port`.
        let host = hostport.split_once(':').map_or(hostport, |(h, _)| h);
        if !host.eq_ignore_ascii_case("bitbucket.org") {
            return None;
        }
        Some(format!("ssh://{userinfo}bitbucket.org/{ws}/{new_slug}.git"))
    } else if let Some((prefix, _rest)) = trimmed.split_once(':') {
        // scp-style `git@bitbucket.org:ws/slug.git` — keep the user@host prefix,
        // but only when the host is actually Bitbucket (a `git@github.com:…`
        // origin must be left alone).
        if prefix.eq_ignore_ascii_case("bitbucket.org")
            || prefix
                .rsplit_once('@')
                .is_some_and(|(_, h)| h.eq_ignore_ascii_case("bitbucket.org"))
        {
            Some(format!("{prefix}:{ws}/{new_slug}.git"))
        } else {
            None
        }
    } else {
        None
    }
}

/// Rename the repository: `PUT repositories/{ws}/{slug} {name}` → the server slugifies
/// the name (lowercase, spaces→dashes) and returns the new `slug`. Unlike GitLab, the
/// OLD slug 404s immediately (no redirect), so the local `origin` remote must be
/// rewritten. If the rename succeeds but `remote set-url` then fails, the error
/// discloses the partial state so the user can fix the remote by hand.
pub async fn rename_repo(state: &crate::state::AppState, repo_path: &str, new_name: &str) -> AppResult<()> {
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.starts_with('-') {
        return Err(AppError::InvalidArgument(
            "a repository name is required".into(),
        ));
    }
    let creds = http::load_credentials().await?;
    let (ws, _slug) = workspace_slug(repo_path).await?;
    let base = repo_base(repo_path).await?;
    let payload = serde_json::json!({ "name": new_name });
    let updated: BbRepoSlug = http::bb_put_json(&creds, &base, &payload, "repository").await?;
    let new_slug = updated.slug;
    if new_slug.is_empty() {
        return Err(AppError::Bitbucket(
            "Bitbucket renamed the repository but returned no new slug.".into(),
        ));
    }

    // Rewrite the local origin remote to the new slug (the old one 404s now). Best
    // effort on reading the current URL — if we can't read or recognize it, leave it.
    let old_url = origin_remote_url(repo_path).await.unwrap_or_default();
    if let Some(new_url) = rewritten_origin_url(&old_url, &ws, &new_slug) {
        if let Err(e) = crate::git::runner::run_git_mutating(
            state,
            repo_path,
            &["remote", "set-url", "origin", &new_url],
            crate::git::runner::NETWORK_TIMEOUT,
        )
        .await
        {
            return Err(AppError::Bitbucket(format!(
                "Renamed on Bitbucket, but the local 'origin' remote couldn't be updated — \
                 set it to {new_url} manually. ({e})"
            )));
        }
        // origin now points at the new slug — drop any cached (stale) URL so a forge query
        // within the TTL re-resolves it instead of hitting the old, now-404 URL.
        crate::git::remote::invalidate_remote_url_cache(repo_path, "origin");
    }
    Ok(())
}

/// Change visibility: `PUT {is_private}`. `is_private:false` can 400 with a clean
/// server message (e.g. "Public repositories must allow public forks.") — surface it
/// verbatim rather than pre-translating.
pub async fn set_visibility(repo_path: &str, is_private: bool) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let payload = serde_json::json!({ "is_private": is_private });
    http::bb_put_json::<serde_json::Value>(&creds, &base, &payload, "repository").await?;
    Ok(())
}

/// The Bitbucket repository settings the app manages, as the frontend consumes them.
/// Nullable scalars ride empty-string defaults (the established idiom).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketRepoSettings {
    pub name: String,
    pub slug: String,
    pub full_name: String,
    pub description: String,
    pub website: String,
    pub language: String,
    pub is_private: bool,
    /// "allow_forks" | "no_public_forks" | "no_forks".
    pub fork_policy: String,
    pub main_branch: String,
    pub web_url: String,
    pub project_key: String,
    pub project_name: String,
}

/// The raw repo read for the settings surface. Nullable scalars ride
/// `null_to_default` (Bitbucket nulls `description`/`website`/`language` rather than
/// omitting them).
#[derive(Deserialize, Default)]
struct BbRepoSettingsRaw {
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    slug: String,
    #[serde(default, deserialize_with = "null_to_default")]
    full_name: String,
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    website: String,
    #[serde(default, deserialize_with = "null_to_default")]
    language: String,
    #[serde(default, deserialize_with = "null_to_default")]
    is_private: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    fork_policy: String,
    #[serde(default)]
    mainbranch: Option<BbBranchRef>,
    #[serde(default)]
    project: Option<BbProject>,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
}

#[derive(Deserialize, Default)]
struct BbProject {
    #[serde(default, deserialize_with = "null_to_default")]
    key: String,
    #[serde(default, deserialize_with = "null_to_default")]
    name: String,
}

fn settings_from_repo(r: BbRepoSettingsRaw) -> BitbucketRepoSettings {
    let main_branch = r.mainbranch.map(|b| b.name).unwrap_or_default();
    let (project_key, project_name) = r
        .project
        .map(|p| (p.key, p.name))
        .unwrap_or_else(|| (String::new(), String::new()));
    let web_url = html_href(&r.links);
    BitbucketRepoSettings {
        name: r.name,
        slug: r.slug,
        full_name: r.full_name,
        description: r.description,
        website: r.website,
        language: r.language,
        is_private: r.is_private,
        fork_policy: r.fork_policy,
        main_branch,
        web_url,
        project_key,
        project_name,
    }
}

/// The repository settings read (`GET repositories/{ws}/{slug}`).
pub async fn repo_settings(repo_path: &str) -> AppResult<BitbucketRepoSettings> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let raw: BbRepoSettingsRaw = http::bb_get_json(&creds, &base, "repository").await?;
    Ok(settings_from_repo(raw))
}

/// The repo's `is_private` (→ neutral visibility string) plus fork provenance; Bitbucket
/// has no "internal" tier. Unlike the tolerant settings struct, `is_private` is STRICT
/// (`Option`, no default): a missing/null value is undeterminable and this probe must
/// error rather than guess "public". `parent` is the upstream embed Bitbucket returns for
/// a fork (null otherwise), so fork-ness rides the same round-trip.
#[derive(Deserialize)]
struct BbRepoVisibility {
    #[serde(default)]
    is_private: Option<bool>,
    #[serde(default)]
    parent: Option<BbForkParent>,
}

/// The `parent` embed on a fork — only its `full_name` ("workspace/slug") is
/// needed for the badge.
#[derive(Deserialize)]
struct BbForkParent {
    #[serde(default)]
    full_name: Option<String>,
}

pub async fn repo_visibility(repo_path: &str) -> AppResult<crate::forge::RepoVisibilityRaw> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let raw: BbRepoVisibility = http::bb_get_json(&creds, &base, "repository").await?;
    let is_private = raw.is_private.ok_or_else(|| {
        AppError::Bitbucket("could not read the repository's visibility".into())
    })?;
    let is_fork = raw.parent.is_some();
    let parent = raw
        .parent
        .and_then(|p| p.full_name)
        .filter(|s| !s.is_empty());
    Ok(crate::forge::RepoVisibilityRaw {
        visibility: if is_private { "private" } else { "public" }.to_string(),
        is_fork,
        parent,
    })
}

/// The settings the General form sends back (the managed subset). Name and
/// visibility are deliberately absent — the Danger zone owns them (rename +
/// set-visibility).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketRepoSettingsInput {
    pub description: String,
    pub website: String,
    pub language: String,
    pub fork_policy: String,
    pub main_branch: String,
}

/// Build the settings-update PUT body. Pure (testable). `mainbranch` rides only when
/// a non-empty branch is chosen (an empty repo has none). `fork_policy` is only sent
/// when non-empty (an empty value would 400).
fn build_settings_update_body(input: &BitbucketRepoSettingsInput) -> serde_json::Value {
    let mut body = serde_json::json!({
        "description": input.description,
        "website": input.website,
        "language": input.language,
    });
    if !input.fork_policy.is_empty() {
        body["fork_policy"] = serde_json::Value::String(input.fork_policy.clone());
    }
    if !input.main_branch.is_empty() {
        body["mainbranch"] = serde_json::json!({ "type": "branch", "name": input.main_branch });
    }
    body
}

/// Batch-save the managed settings via one `PUT repositories/{ws}/{slug}`, returning
/// the fresh settings.
pub async fn update_repo_settings(
    repo_path: &str,
    input: BitbucketRepoSettingsInput,
) -> AppResult<BitbucketRepoSettings> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let payload = build_settings_update_body(&input);
    let raw: BbRepoSettingsRaw = http::bb_put_json(&creds, &base, &payload, "repository").await?;
    Ok(settings_from_repo(raw))
}

// ── Workspaces ───────────────────────────────────────────────────────────────

/// A workspace the viewer belongs to, for the publish target picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketWorkspace {
    pub slug: String,
    pub administrator: bool,
}

/// One `/2.0/user/workspaces` membership entry, with the `administrator` flag the
/// publish picker needs (distinct from the read-only [`BbWorkspaceAccess`] used for
/// the clone browser, which only needs the slug).
#[derive(Deserialize)]
struct BbWorkspaceMembership {
    #[serde(default)]
    workspace: Option<BbWorkspace>,
    #[serde(default, deserialize_with = "null_to_default")]
    administrator: bool,
}

/// One `/2.0/user/workspaces` page (values + `next` for bounded pagination).
#[derive(Deserialize, Default)]
struct BbWorkspacesPage {
    #[serde(default)]
    values: Vec<BbWorkspaceMembership>,
    #[serde(default)]
    next: Option<String>,
}

/// The viewer's workspaces (`GET /2.0/user/workspaces`), account-scoped (no repo).
/// Follows `next` up to 5 pages. Skips entries with no nested workspace / empty slug.
pub async fn workspaces() -> AppResult<Vec<BitbucketWorkspace>> {
    let creds = http::load_credentials().await?;
    let mut out: Vec<BitbucketWorkspace> = Vec::new();
    let mut url = "user/workspaces?pagelen=100".to_string();
    for _ in 0..5 {
        let page: BbWorkspacesPage = http::bb_get_json(&creds, &url, "workspaces").await?;
        for m in page.values {
            let administrator = m.administrator;
            if let Some(slug) = m.workspace.map(|w| w.slug).filter(|s| !s.is_empty()) {
                out.push(BitbucketWorkspace { slug, administrator });
            }
        }
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

// ── Default reviewers ────────────────────────────────────────────────────────

/// The repo's default reviewers (`GET .../default-reviewers?pagelen=100`, follow
/// `next` ≤5 pages). Maps onto `ForgeUserRef` (id = uuid, label = display name).
pub async fn default_reviewers(repo_path: &str) -> AppResult<Vec<ForgeUserRef>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut out: Vec<ForgeUserRef> = Vec::new();
    let mut url = format!("{base}/default-reviewers?pagelen=100");
    for _ in 0..5 {
        let page: BbUsersPage = http::bb_get_json(&creds, &url, "default reviewers").await?;
        for u in page.values {
            let id = u.uuid.clone().unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            out.push(ForgeUserRef {
                id,
                label: user_login(&u),
                avatar_url: user_avatar(&u),
                is_bot: false,
            });
        }
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

/// A paginated page of bare user objects, with `next` (default reviewers list).
#[derive(Deserialize, Default)]
struct BbUsersPage {
    #[serde(default)]
    values: Vec<BbUser>,
    #[serde(default)]
    next: Option<String>,
}

/// Add a default reviewer (`PUT .../default-reviewers/{pct-enc-braced-uuid}`, empty
/// body → 200). The repo owner CAN be a default reviewer (unlike PR reviewers).
pub async fn default_reviewer_add(repo_path: &str, uuid: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/default-reviewers/{}", encode_uuid(uuid));
    // PUT with an empty JSON object body (the endpoint takes no fields).
    let payload = serde_json::json!({});
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "default reviewer").await?;
    Ok(())
}

/// Remove a default reviewer (`DELETE .../default-reviewers/{pct-enc-braced-uuid}` →
/// 204).
pub async fn default_reviewer_remove(repo_path: &str, uuid: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/default-reviewers/{}", encode_uuid(uuid));
    http::bb_delete(&creds, &path).await
}

/// The workspace-member picker candidates for default reviewers — everyone in the
/// workspace, WITHOUT the PR-author exclusion `reviewer_candidates` applies.
pub async fn member_candidates(repo_path: &str) -> AppResult<Vec<ForgeUserRef>> {
    let creds = http::load_credentials().await?;
    let (ws, _slug) = workspace_slug(repo_path).await?;
    let members = workspace_members(&creds, &ws).await?;
    // Reuse the map/sort with an empty author filter (nothing excluded).
    Ok(reviewer_candidates_from(members, ""))
}

// ── Branch restrictions ──────────────────────────────────────────────────────

/// A branch restriction, as the frontend consumes it. The server `id` is numeric on
/// the wire; it travels as a String over IPC (the u64-precision rule).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketBranchRestriction {
    pub id: String,
    pub kind: String,
    pub pattern: String,
    pub branch_match_kind: String,
    pub value: Option<u32>,
}

/// The raw branch-restriction object (`id` numeric, `value` optional).
#[derive(Deserialize)]
struct BbBranchRestrictionRaw {
    #[serde(default)]
    id: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    kind: String,
    #[serde(default, deserialize_with = "null_to_default")]
    pattern: String,
    #[serde(default, deserialize_with = "null_to_default")]
    branch_match_kind: String,
    #[serde(default)]
    value: Option<u32>,
}

fn from_bb_branch_restriction(r: BbBranchRestrictionRaw) -> BitbucketBranchRestriction {
    BitbucketBranchRestriction {
        id: r.id.to_string(),
        kind: r.kind,
        pattern: r.pattern,
        branch_match_kind: r.branch_match_kind,
        value: r.value,
    }
}

/// Build a branch-restriction create/update body. Pure (testable). Always sends the
/// FULL shape (`kind` + `branch_match_kind:"glob"` + `pattern` + empty `users`/
/// `groups` + `value`) — a partial PUT is rejected. `value` rides only when present.
fn build_branch_restriction_body(kind: &str, pattern: &str, value: Option<u32>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "kind": kind,
        "branch_match_kind": "glob",
        "pattern": pattern,
        "users": [],
        "groups": [],
    });
    if let Some(v) = value {
        body["value"] = serde_json::json!(v);
    } else {
        body["value"] = serde_json::Value::Null;
    }
    body
}

/// The repo's branch restrictions (`GET .../branch-restrictions?pagelen=100`, follow
/// `next` ≤5 pages).
pub async fn branch_restrictions(repo_path: &str) -> AppResult<Vec<BitbucketBranchRestriction>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut out: Vec<BitbucketBranchRestriction> = Vec::new();
    let mut url = format!("{base}/branch-restrictions?pagelen=100");
    for _ in 0..5 {
        let page: BbRestrictionsPage =
            http::bb_get_json(&creds, &url, "branch restrictions").await?;
        out.extend(page.values.into_iter().map(from_bb_branch_restriction));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

/// A paginated page of branch restrictions (values + `next`).
#[derive(Deserialize, Default)]
struct BbRestrictionsPage {
    #[serde(default)]
    values: Vec<BbBranchRestrictionRaw>,
    #[serde(default)]
    next: Option<String>,
}

/// Create a branch restriction (`POST .../branch-restrictions` → 201 with numeric id).
pub async fn branch_restriction_create(
    repo_path: &str,
    kind: &str,
    pattern: &str,
    value: Option<u32>,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/branch-restrictions");
    let payload = build_branch_restriction_body(kind, pattern, value);
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "branch restriction").await?;
    Ok(())
}

/// Update a branch restriction (`PUT .../branch-restrictions/{id}` with the FULL
/// shape → 200).
pub async fn branch_restriction_update(
    repo_path: &str,
    id: &str,
    kind: &str,
    pattern: &str,
    value: Option<u32>,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/branch-restrictions/{}", encode_query_value(id));
    let payload = build_branch_restriction_body(kind, pattern, value);
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "branch restriction").await?;
    Ok(())
}

/// Delete a branch restriction (`DELETE .../branch-restrictions/{id}` → 204).
pub async fn branch_restriction_delete(repo_path: &str, id: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/branch-restrictions/{}", encode_query_value(id));
    http::bb_delete(&creds, &path).await
}

// ── Pipelines config, variables & schedules ──────────────────────────────────

/// Whether Bitbucket Pipelines is enabled for the repo.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPipelinesConfig {
    pub enabled: bool,
}

#[derive(Deserialize, Default)]
struct BbPipelinesConfigRaw {
    #[serde(default, deserialize_with = "null_to_default")]
    enabled: bool,
}

/// Parse a `pipelines_config` `(status, body)` into a [`BitbucketPipelinesConfig`].
/// A never-configured repo 404s → `{enabled:false}` (Bitbucket's error message wording
/// isn't guaranteed to mention "404"/"not found", so branch on the numeric status like
/// the expired-log path does); 2xx → parse the JSON; any other status → the normal
/// `http_error` mapping so 401/403 messages stay identical to the JSON helper.
fn parse_pipelines_config(status: u16, body: &str) -> AppResult<BitbucketPipelinesConfig> {
    if status == 404 {
        return Ok(BitbucketPipelinesConfig { enabled: false });
    }
    if !(200..300).contains(&status) {
        return Err(http::http_error(status, body));
    }
    let raw: BbPipelinesConfigRaw = serde_json::from_str(body).map_err(|e| {
        AppError::Bitbucket(format!("could not parse Bitbucket pipelines config: {e}"))
    })?;
    Ok(BitbucketPipelinesConfig {
        enabled: raw.enabled,
    })
}

/// The pipelines config (`GET .../pipelines_config`). A never-configured repo 404s →
/// map to `{enabled:false}` rather than surfacing an error.
pub async fn pipelines_config(repo_path: &str) -> AppResult<BitbucketPipelinesConfig> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config");
    let (status, body) = http::bb_get_text_status(&creds, &path).await?;
    parse_pipelines_config(status, &body)
}

/// Enable / disable Pipelines (`PUT .../pipelines_config {enabled}`).
pub async fn pipelines_config_update(repo_path: &str, enabled: bool) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config");
    let payload = serde_json::json!({ "enabled": enabled });
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pipelines config").await?;
    Ok(())
}

/// A pipeline variable. A secured variable's `value` is write-only (omitted from
/// reads) → `None`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPipelineVariable {
    pub uuid: String,
    pub key: String,
    pub value: Option<String>,
    pub secured: bool,
}

#[derive(Deserialize)]
struct BbPipelineVariableRaw {
    #[serde(default)]
    uuid: String,
    #[serde(default, deserialize_with = "null_to_default")]
    key: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    secured: bool,
}

fn from_bb_pipeline_variable(v: BbPipelineVariableRaw) -> BitbucketPipelineVariable {
    // A secured variable never returns its value; force None so the frontend never
    // shows a stale/blank secured value as if it were the real one.
    let value = if v.secured { None } else { v.value };
    BitbucketPipelineVariable {
        uuid: v.uuid,
        key: v.key,
        value,
        secured: v.secured,
    }
}

/// The repo's pipeline variables (`GET .../pipelines_config/variables/?pagelen=100`,
/// follow `next` ≤5 pages). Note the TRAILING SLASH on `variables/`.
pub async fn pipeline_variables(repo_path: &str) -> AppResult<Vec<BitbucketPipelineVariable>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut out: Vec<BitbucketPipelineVariable> = Vec::new();
    let mut url = format!("{base}/pipelines_config/variables/?pagelen=100");
    for _ in 0..5 {
        let page: BbVariablesPage =
            http::bb_get_json(&creds, &url, "pipeline variables").await?;
        out.extend(page.values.into_iter().map(from_bb_pipeline_variable));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

#[derive(Deserialize, Default)]
struct BbVariablesPage {
    #[serde(default)]
    values: Vec<BbPipelineVariableRaw>,
    #[serde(default)]
    next: Option<String>,
}

/// Create a pipeline variable (`POST .../pipelines_config/variables/` → 201).
pub async fn pipeline_variable_create(
    repo_path: &str,
    key: &str,
    value: &str,
    secured: bool,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config/variables/");
    let payload = serde_json::json!({ "key": key, "value": value, "secured": secured });
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "pipeline variable").await?;
    Ok(())
}

/// Update a pipeline variable (`PUT .../pipelines_config/variables/{pct-enc-uuid}` →
/// 200). The key is immutable; only value + secured change.
pub async fn pipeline_variable_update(
    repo_path: &str,
    uuid: &str,
    value: &str,
    secured: bool,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!(
        "{base}/pipelines_config/variables/{}",
        encode_uuid(uuid)
    );
    let payload = serde_json::json!({ "value": value, "secured": secured });
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pipeline variable").await?;
    Ok(())
}

/// Delete a pipeline variable (`DELETE .../pipelines_config/variables/{pct-enc-uuid}`
/// → 204).
pub async fn pipeline_variable_delete(repo_path: &str, uuid: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!(
        "{base}/pipelines_config/variables/{}",
        encode_uuid(uuid)
    );
    http::bb_delete(&creds, &path).await
}

/// A pipeline schedule (a cron-triggered pipeline on a branch).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketPipelineSchedule {
    pub uuid: String,
    pub enabled: bool,
    /// QUARTZ-format cron (e.g. "0 0 12 * * ?").
    pub cron_pattern: String,
    pub ref_name: String,
}

#[derive(Deserialize)]
struct BbPipelineScheduleRaw {
    #[serde(default)]
    uuid: String,
    #[serde(default, deserialize_with = "null_to_default")]
    enabled: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    cron_pattern: String,
    #[serde(default)]
    target: Option<BbScheduleTarget>,
}

#[derive(Deserialize, Default)]
struct BbScheduleTarget {
    #[serde(default, deserialize_with = "null_to_default")]
    ref_name: String,
}

fn from_bb_pipeline_schedule(s: BbPipelineScheduleRaw) -> BitbucketPipelineSchedule {
    let ref_name = s.target.map(|t| t.ref_name).unwrap_or_default();
    BitbucketPipelineSchedule {
        uuid: s.uuid,
        enabled: s.enabled,
        cron_pattern: s.cron_pattern,
        ref_name,
    }
}

/// Build a schedule-create body. Pure (testable). The `selector.pattern` rides the
/// same `ref_name` as the target branch. `cron_pattern` is QUARTZ format (validated).
fn build_schedule_create_body(ref_name: &str, cron_pattern: &str, enabled: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "pipeline_schedule",
        "enabled": enabled,
        "cron_pattern": cron_pattern,
        "target": {
            "type": "pipeline_ref_target",
            "ref_type": "branch",
            "ref_name": ref_name,
            "selector": {
                "type": "branches",
                "pattern": ref_name,
            },
        },
    })
}

/// The repo's pipeline schedules (`GET .../pipelines_config/schedules/?pagelen=100`,
/// follow `next` ≤5 pages). Note the TRAILING SLASH.
pub async fn pipeline_schedules(repo_path: &str) -> AppResult<Vec<BitbucketPipelineSchedule>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut out: Vec<BitbucketPipelineSchedule> = Vec::new();
    let mut url = format!("{base}/pipelines_config/schedules/?pagelen=100");
    for _ in 0..5 {
        let page: BbSchedulesPage =
            http::bb_get_json(&creds, &url, "pipeline schedules").await?;
        out.extend(page.values.into_iter().map(from_bb_pipeline_schedule));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

#[derive(Deserialize, Default)]
struct BbSchedulesPage {
    #[serde(default)]
    values: Vec<BbPipelineScheduleRaw>,
    #[serde(default)]
    next: Option<String>,
}

/// Create a pipeline schedule (`POST .../pipelines_config/schedules/` → 201).
pub async fn pipeline_schedule_create(
    repo_path: &str,
    ref_name: &str,
    cron_pattern: &str,
    enabled: bool,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config/schedules/");
    let payload = build_schedule_create_body(ref_name, cron_pattern, enabled);
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "pipeline schedule").await?;
    Ok(())
}

/// Toggle a schedule's enabled state (`PUT .../schedules/{uuid} {enabled}` → 200).
pub async fn pipeline_schedule_set_enabled(
    repo_path: &str,
    uuid: &str,
    enabled: bool,
) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config/schedules/{}", encode_uuid(uuid));
    let payload = serde_json::json!({ "enabled": enabled });
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "pipeline schedule").await?;
    Ok(())
}

/// Delete a schedule (`DELETE .../schedules/{uuid}` → 204).
pub async fn pipeline_schedule_delete(repo_path: &str, uuid: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/pipelines_config/schedules/{}", encode_uuid(uuid));
    http::bb_delete(&creds, &path).await
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/// A repository webhook. Bitbucket has no delivery-log API (no deliveries feature).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketHook {
    pub uuid: String,
    pub description: String,
    pub url: String,
    pub active: bool,
    pub events: Vec<String>,
    pub skip_cert_verification: bool,
}

#[derive(Deserialize)]
struct BbHookRaw {
    #[serde(default)]
    uuid: String,
    #[serde(default, deserialize_with = "null_to_default")]
    description: String,
    #[serde(default, deserialize_with = "null_to_default")]
    url: String,
    #[serde(default, deserialize_with = "null_to_default")]
    active: bool,
    #[serde(default, deserialize_with = "null_to_default")]
    events: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    skip_cert_verification: bool,
}

fn from_bb_hook(h: BbHookRaw) -> BitbucketHook {
    BitbucketHook {
        uuid: h.uuid,
        description: h.description,
        url: h.url,
        active: h.active,
        events: h.events,
        skip_cert_verification: h.skip_cert_verification,
    }
}

/// What the webhook form sends. A PUT requires the FULL shape (a partial PUT 400s
/// with "You cannot create a webhook without any events").
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BitbucketHookInput {
    pub description: String,
    pub url: String,
    pub active: bool,
    pub events: Vec<String>,
    pub skip_cert_verification: bool,
}

/// Build a webhook create/update body. Pure (testable). Always the FULL shape.
fn build_hook_body(input: &BitbucketHookInput) -> serde_json::Value {
    serde_json::json!({
        "description": input.description,
        "url": input.url,
        "active": input.active,
        "events": input.events,
        "skip_cert_verification": input.skip_cert_verification,
    })
}

/// The repo's webhooks (`GET .../hooks?pagelen=100`, follow `next` ≤5 pages).
pub async fn hooks(repo_path: &str) -> AppResult<Vec<BitbucketHook>> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let mut out: Vec<BitbucketHook> = Vec::new();
    let mut url = format!("{base}/hooks?pagelen=100");
    for _ in 0..5 {
        let page: BbHooksPage = http::bb_get_json(&creds, &url, "webhooks").await?;
        out.extend(page.values.into_iter().map(from_bb_hook));
        match page.next {
            Some(next) if !next.is_empty() => url = next,
            _ => break,
        }
    }
    Ok(out)
}

#[derive(Deserialize, Default)]
struct BbHooksPage {
    #[serde(default)]
    values: Vec<BbHookRaw>,
    #[serde(default)]
    next: Option<String>,
}

/// Create a webhook (`POST .../hooks` → 201).
pub async fn hook_create(repo_path: &str, input: BitbucketHookInput) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/hooks");
    let payload = build_hook_body(&input);
    http::bb_post_json::<serde_json::Value>(&creds, &path, &payload, "webhook").await?;
    Ok(())
}

/// Update a webhook (`PUT .../hooks/{pct-enc-uuid}` with the FULL shape → 200).
pub async fn hook_update(repo_path: &str, uuid: &str, input: BitbucketHookInput) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/hooks/{}", encode_uuid(uuid));
    let payload = build_hook_body(&input);
    http::bb_put_json::<serde_json::Value>(&creds, &path, &payload, "webhook").await?;
    Ok(())
}

/// Delete a webhook (`DELETE .../hooks/{pct-enc-uuid}` → 204).
pub async fn hook_delete(repo_path: &str, uuid: &str) -> AppResult<()> {
    let creds = http::load_credentials().await?;
    let base = repo_base(repo_path).await?;
    let path = format!("{base}/hooks/{}", encode_uuid(uuid));
    http::bb_delete(&creds, &path).await
}

// ── Publish ──────────────────────────────────────────────────────────────────

/// A slug-grammar check for a name that becomes a Bitbucket repo slug. Pure
/// (testable). The server lowercases the name into the slug, so the grammar allows
/// the mixed-case input: `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
fn is_valid_repo_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Build the repo-create body. Pure (testable). Empty description/website are
/// omitted (Bitbucket accepts them, but omitting keeps the object clean).
fn build_publish_body(is_private: bool, description: &str, website: &str) -> serde_json::Value {
    let mut body = serde_json::json!({ "scm": "git", "is_private": is_private });
    if !description.is_empty() {
        body["description"] = serde_json::Value::String(description.to_string());
    }
    if !website.is_empty() {
        body["website"] = serde_json::Value::String(website.to_string());
    }
    body
}

/// A created repo's identity (slug + html link).
#[derive(Deserialize)]
struct BbCreatedRepo {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    links: Option<BbHtmlLinks>,
}

/// Publish a local repo to Bitbucket: create the repo in `workspace`, seed git's
/// credential store, add `origin`, and push the current branch. Returns the repo's html
/// URL. `website` maps to Bitbucket's website field; topics are dropped (Bitbucket has
/// none).
///
/// Guard order mirrors `gitlab::publish_repo`: every locally-checkable precondition runs
/// BEFORE the create POST — the failure to avoid is an orphaned repo whose slug then
/// blocks retries. Any failure AFTER the create discloses the partial state ("The
/// Bitbucket repository was created at <url>, but …").
pub async fn publish_repo(
    state: &crate::state::AppState,
    repo_path: &str,
    name: &str,
    private: bool,
    description: &str,
    website: &str,
    workspace: Option<String>,
) -> AppResult<String> {
    // ── Pre-mutation guards (all before the create POST). ──
    let workspace = workspace.map(|w| w.trim().to_string()).unwrap_or_default();
    if workspace.is_empty() {
        return Err(AppError::InvalidArgument(
            "choose a Bitbucket workspace to publish into".into(),
        ));
    }
    let name = name.trim();
    if !is_valid_repo_name(name) {
        return Err(AppError::InvalidArgument(
            "repository names must start with a letter or digit and use only letters, digits, '.', '_' or '-'".into(),
        ));
    }
    let description = description.trim();
    let website = website.trim();

    // Current branch (unborn / detached HEAD → a clear error, like gitlab::publish_repo).
    let branch_out = crate::git::runner::run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| match &e {
        AppError::Git { stderr, .. }
            if stderr.contains("ambiguous argument") || stderr.contains("unknown revision") =>
        {
            AppError::InvalidArgument(
                "make an initial commit before publishing (this repository has none yet)".into(),
            )
        }
        _ => e,
    })?;
    let branch = branch_out.stdout_lossy().trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(AppError::InvalidArgument(
            "check out a branch before publishing (detached HEAD)".into(),
        ));
    }

    // Origin must not already exist (an externally-added origin would strand an
    // orphaned repo when the post-create `remote add` fails).
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

    let creds = http::load_credentials().await?;

    // ── Create the repo (the slug is the lowercased name; the server assigns the
    //    project). ──
    let slug = name.to_ascii_lowercase();
    let create_path = format!(
        "repositories/{}/{}",
        encode_query_value(&workspace),
        encode_query_value(&slug),
    );
    let payload = build_publish_body(private, description, website);
    let created: BbCreatedRepo =
        http::bb_post_json(&creds, &create_path, &payload, "created repository").await?;
    let created_slug = if created.slug.is_empty() {
        slug.clone()
    } else {
        created.slug
    };
    let html_url = html_href(&created.links);
    let html_url = if html_url.is_empty() {
        format!("https://bitbucket.org/{workspace}/{created_slug}")
    } else {
        html_url
    };
    // From here on, any failure must disclose that the repo WAS created.
    let created_hint =
        format!("The Bitbucket repository was created at {html_url}, but ");

    // ── Seed git's credential store so the push authenticates non-interactively (see
    //    `seed_git_credential`). Best-effort — the push surfaces any auth failure. ──
    let _ = seed_git_credential().await;

    // ── Add origin, then push the current branch. ──
    let remote_url = format!("https://bitbucket.org/{workspace}/{created_slug}.git");
    if let Err(e) = crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &["remote", "add", "origin", &remote_url],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await
    {
        return Err(AppError::Bitbucket(format!("{created_hint}adding the 'origin' remote failed: {e}")));
    }

    if let Err(e) = crate::git::runner::run_git_mutating(
        state,
        repo_path,
        &["-c", "credential.interactive=false", "push", "-u", "origin", &branch],
        crate::git::runner::NETWORK_TIMEOUT,
    )
    .await
    {
        return Err(AppError::Bitbucket(format!("{created_hint}pushing failed: {e}")));
    }

    Ok(html_url)
}

// ── Explore: repo search / fork-by-name / README ──────────────────────────────
//
// Bitbucket retired global repo search (`GET /2.0/repositories` → 410 Gone,
// CHANGE-2770), so Explore search is workspace-scoped by design: iterate the viewer's
// workspaces and run a `q=name~"…"` filter in each, aggregating. Fork and README address
// the repo by `owner/name` (grammar-validated). Bitbucket Cloud has no stars, so
// `star_repo`/`starred` are inert.

/// Bitbucket's single page cap for the workspace repo-search endpoint.
const BB_SEARCH_PAGELEN: u32 = 50;

/// Escape a user query for embedding inside a BBQL double-quoted string literal
/// (`name ~ "<escaped>"`). A backslash and a double-quote are the two characters
/// that would break out of the literal, so each is backslash-escaped. Pure, tested.
fn bbql_escape(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out
}

/// One search-result repo from a `serde_json::Value` item of a workspace repo page.
/// Tolerant: a missing `full_name` skips the item. Bitbucket carries `language` and
/// `mainbranch`, but no star concept, so `stars` is always `None`.
///
/// CRITICAL: `name` must be the URL SLUG (`slug`), never Bitbucket's `name` field —
/// that's the DISPLAY name and can diverge from the slug. Every by-owner/name
/// command (README, fork) addresses `{owner}/{name}`, so a display name there 404s.
/// `owner` and the slug fallback are derived from `full_name` (`workspace/slug`) so
/// the identity `owner + "/" + name == full_name` ALWAYS holds.
fn bb_search_repo_from_value(item: &serde_json::Value) -> Option<ForgeSearchRepo> {
    use serde_json::Value;
    let full_name = item.get("full_name").and_then(Value::as_str)?.to_string();
    if full_name.is_empty() {
        return None;
    }
    // Clone URLs live in links.clone[] keyed by name ("https"/"ssh").
    let clone_link = |kind: &str| -> String {
        item.get("links")
            .and_then(|l| l.get("clone"))
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|c| c.get("name").and_then(Value::as_str) == Some(kind))
                    .and_then(|c| c.get("href").and_then(Value::as_str))
            })
            .unwrap_or("")
            .to_string()
    };
    // Owner and slug derived from full_name (`workspace/slug`) so `owner/name ==
    // full_name`. Prefer the explicit `slug` field for the slug; fall back to the
    // last `/`-segment of full_name (never the display `name` field).
    let (owner, name_from_full) = match full_name.rsplit_once('/') {
        Some((o, n)) => (o.to_string(), n.to_string()),
        None => (String::new(), full_name.clone()),
    };
    let name = item
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(name_from_full);
    let str_field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
    // Bitbucket's `language` is often an empty string rather than absent — treat
    // empty as None so the UI doesn't render a blank language chip.
    let language = str_field("language").filter(|s| !s.is_empty());
    Some(ForgeSearchRepo {
        owner,
        name,
        full_name,
        private: item.get("is_private").and_then(Value::as_bool).unwrap_or(false),
        // Bitbucket Cloud has no repo-archived concept.
        archived: false,
        fork: item.get("parent").map(|v| !v.is_null()).unwrap_or(false),
        clone_url: clone_link("https"),
        ssh_url: clone_link("ssh"),
        description: str_field("description"),
        updated_at: str_field("updated_on"),
        stars: None,
        language,
        web_url: item
            .get("links")
            .and_then(|l| l.get("html"))
            .and_then(|h| h.get("href"))
            .and_then(Value::as_str)
            .map(str::to_string),
        default_branch: item
            .get("mainbranch")
            .and_then(|b| b.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Search Bitbucket repositories for the Explore view — workspace-scoped by design
/// (global repo search was retired). Runs a `name ~ "<query>"` filter across the
/// viewer's workspaces CONCURRENTLY. `page` is ignored (no cross-workspace paging);
/// any `sort` maps to `-updated_on` (Bitbucket has no stars). An empty query is
/// rejected upstream by the dispatcher. Best-effort per workspace (one erroring
/// doesn't sink the others), but if EVERY workspace fetch fails, the last error
/// surfaces rather than an empty "no results" list — mirroring `list_repos`.
pub async fn search_repos(query: &str, _sort: &str, _page: u32) -> AppResult<ForgeSearchList> {
    let creds = http::load_credentials().await?;
    let bbql = format!("name ~ \"{}\"", bbql_escape(query));
    let q_enc = encode_query_value(&bbql);
    let ws_list = workspaces().await?;
    // Fetch every workspace's page concurrently (the local join_all — no futures crate).
    let pages = crate::forge::futures_join_all(ws_list.iter().map(|ws| {
        let creds = &creds;
        let q_enc = &q_enc;
        async move {
            let path = format!(
                "repositories/{}?q={q_enc}&sort=-updated_on&pagelen={BB_SEARCH_PAGELEN}",
                encode_query_value(&ws.slug),
            );
            http::bb_get_json::<BbPage<serde_json::Value>>(creds, &path, "repositories").await
        }
    }))
    .await;
    let mut repos: Vec<ForgeSearchRepo> = Vec::new();
    let mut any_ok = false;
    let mut last_err: Option<AppError> = None;
    for page in pages {
        match page {
            Ok(page) => {
                any_ok = true;
                repos.extend(page.values.iter().filter_map(bb_search_repo_from_value));
            }
            Err(e) => last_err = Some(e),
        }
    }
    // Every workspace fetch failed (and there was at least one) → surface the error
    // instead of a misleading empty result.
    if !ws_list.is_empty() && !any_ok {
        return Err(last_err.unwrap_or_else(|| {
            AppError::Bitbucket("could not search Bitbucket repositories".into())
        }));
    }
    Ok(ForgeSearchList {
        repos,
        has_more: false,
        total: None,
    })
}

/// Fork a Bitbucket repo by `owner/name` into the caller's personal workspace
/// (`POST repositories/{owner}/{name}/forks` with an empty body). The response is
/// the new repo object; readiness is a bounded `GET` poll on the fork (5×2s → ready
/// on 200).
pub async fn fork_repo(owner: &str, name: &str) -> AppResult<ForgeForkResult> {
    use serde_json::Value;
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let creds = http::load_credentials().await?;
    let path = format!(
        "repositories/{}/{}/forks",
        encode_query_value(owner),
        encode_query_value(name),
    );
    let fork: Value = http::bb_post_json(&creds, &path, &serde_json::json!({}), "fork").await?;
    let full_name = fork
        .get("full_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let clone_url = fork
        .get("links")
        .and_then(|l| l.get("clone"))
        .and_then(Value::as_array)
        .and_then(|arr| {
            arr.iter()
                .find(|c| c.get("name").and_then(Value::as_str) == Some("https"))
                .and_then(|c| c.get("href").and_then(Value::as_str))
        })
        .unwrap_or("")
        .to_string();
    let web_url = fork
        .get("links")
        .and_then(|l| l.get("html"))
        .and_then(|h| h.get("href"))
        .and_then(Value::as_str)
        .map(str::to_string);
    // Readiness: poll the fork by its full_name (5×2s) — 200 ⇒ ready. Bitbucket's
    // async fork semantics aren't documented-confirmed; the bounded poll covers
    // both a synchronous and an eventual-consistency case.
    let ready = if full_name.is_empty() {
        false
    } else {
        poll_fork_ready(&creds, &full_name).await
    };
    Ok(ForgeForkResult {
        full_name,
        clone_url,
        web_url,
        ready,
    })
}

/// Poll `GET repositories/{full_name}` up to 5 times (2s apart); ready on the first
/// 2xx. `false` if it never became ready in the bound (not an error).
async fn poll_fork_ready(creds: &BbCredentials, full_name: &str) -> bool {
    let path = format!("repositories/{full_name}");
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        if let Ok((status, _)) = http::bb_get_text_status(creds, &path).await {
            if (200..300).contains(&status) {
                return true;
            }
        }
    }
    false
}

/// A Bitbucket repo's raw README markdown, or `None` when absent. Resolves the
/// repo's `mainbranch.name`, then tries a candidate filename list via the `src`
/// endpoint; the first hit wins. Continues to the next candidate ONLY on a 404 (that
/// file doesn't exist); any other non-2xx (auth, rate-limit, 5xx) surfaces as an
/// error rather than silently reading "no README".
pub async fn repo_readme(owner: &str, name: &str) -> AppResult<Option<String>> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let creds = http::load_credentials().await?;
    // Resolve the default branch from the repo object.
    let repo_path = format!(
        "repositories/{}/{}",
        encode_query_value(owner),
        encode_query_value(name),
    );
    #[derive(Deserialize)]
    struct RepoMain {
        #[serde(default)]
        mainbranch: Option<BbBranchRef>,
    }
    let repo: RepoMain = http::bb_get_json(&creds, &repo_path, "repository").await?;
    let branch = repo.mainbranch.map(|b| b.name).filter(|s| !s.is_empty());
    let Some(branch) = branch else {
        return Ok(None);
    };
    for candidate in ["README.md", "readme.md", "README.rst", "README"] {
        let src_path = format!(
            "repositories/{}/{}/src/{}/{}",
            encode_query_value(owner),
            encode_query_value(name),
            encode_query_value(&branch),
            encode_query_value(candidate),
        );
        let (status, body) = http::bb_get_text_status(&creds, &src_path).await?;
        if (200..300).contains(&status) {
            return Ok(Some(cap_readme(&body)));
        }
        // Only a 404 means "this candidate doesn't exist" — try the next one. Any
        // other non-2xx is a real failure worth surfacing, not "No README."
        if status != 404 {
            return Err(http::http_error(status, &body));
        }
    }
    Ok(None)
}

/// Star a Bitbucket repo — unsupported (Bitbucket Cloud has no stars). Inert: the
/// `repo_star` flag is false so the frontend never calls this; the dispatcher errors
/// as defense-in-depth.
pub async fn star_repo(_owner: &str, _name: &str, _star: bool) -> AppResult<()> {
    Err(AppError::InvalidArgument(
        "Bitbucket Cloud doesn't support starring repositories.".into(),
    ))
}

/// Whether a Bitbucket repo is starred — always `false` (Bitbucket Cloud has no
/// stars). Returned rather than erroring so a shared starred-state read is harmless.
pub async fn starred(_owner: &str, _name: &str) -> AppResult<bool> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bbql_escape_escapes_quote_and_backslash() {
        // A plain query is unchanged.
        assert_eq!(bbql_escape("hello world"), "hello world");
        // A double-quote is backslash-escaped so it can't close the BBQL literal.
        assert_eq!(bbql_escape("say \"hi\""), "say \\\"hi\\\"");
        // A backslash is doubled.
        assert_eq!(bbql_escape("a\\b"), "a\\\\b");
        // Both together: a backslash then a quote.
        assert_eq!(bbql_escape("x\\\"y"), "x\\\\\\\"y");
    }

    #[test]
    fn bb_search_repo_parses_and_skips_malformed() {
        let item = serde_json::json!({
            "full_name": "myws/repo",
            "slug": "repo",
            "name": "repo",
            "workspace": { "slug": "myws" },
            "is_private": true,
            "parent": { "full_name": "other/repo" },
            "description": "desc",
            "updated_on": "2026-01-01T00:00:00Z",
            "language": "python",
            "mainbranch": { "name": "main" },
            "links": {
                "clone": [
                    { "name": "https", "href": "https://bitbucket.org/myws/repo.git" },
                    { "name": "ssh", "href": "git@bitbucket.org:myws/repo.git" }
                ],
                "html": { "href": "https://bitbucket.org/myws/repo" }
            }
        });
        let r = bb_search_repo_from_value(&item).expect("parses");
        assert_eq!(r.full_name, "myws/repo");
        assert_eq!(r.owner, "myws");
        assert!(r.private);
        assert!(r.fork);
        assert!(r.stars.is_none());
        assert_eq!(r.language.as_deref(), Some("python"));
        assert_eq!(r.clone_url, "https://bitbucket.org/myws/repo.git");
        assert_eq!(r.ssh_url, "git@bitbucket.org:myws/repo.git");
        assert_eq!(r.web_url.as_deref(), Some("https://bitbucket.org/myws/repo"));
        assert_eq!(r.default_branch.as_deref(), Some("main"));
        // An empty language string is normalized to None.
        let no_lang = serde_json::json!({ "full_name": "w/r", "language": "" });
        assert!(bb_search_repo_from_value(&no_lang).unwrap().language.is_none());
        // Missing full_name → skipped.
        assert!(bb_search_repo_from_value(&serde_json::json!({ "name": "x" })).is_none());
    }

    #[test]
    fn bb_search_repo_name_is_slug_not_display_name() {
        // Bitbucket's `name` is a DISPLAY name that can diverge from the URL slug.
        // `ForgeSearchRepo.name` must be the slug so `owner + "/" + name == full_name`
        // and by-owner/name commands address the right repo.
        let item = serde_json::json!({
            "full_name": "ws/pretty-name",
            "slug": "pretty-name",
            "name": "Pretty Name"
        });
        let r = bb_search_repo_from_value(&item).expect("parses");
        assert_eq!(r.name, "pretty-name", "name must be the slug, not the display name");
        assert_eq!(r.owner, "ws");
        assert_eq!(r.full_name, "ws/pretty-name");
        // The load-bearing identity every by-owner/name command relies on.
        assert_eq!(format!("{}/{}", r.owner, r.name), r.full_name);

        // Fallback: when `slug` is absent, the slug is the last segment of
        // full_name (never the display `name`), and owner still holds.
        let no_slug = serde_json::json!({
            "full_name": "ws/pretty-name",
            "name": "Pretty Name"
        });
        let r2 = bb_search_repo_from_value(&no_slug).expect("parses");
        assert_eq!(r2.name, "pretty-name");
        assert_eq!(r2.owner, "ws");
        assert_eq!(format!("{}/{}", r2.owner, r2.name), r2.full_name);
    }

    #[test]
    fn credential_entries_suppress_interactive_and_rewrite_userinfo_urls() {
        // user@ remote → interactive suppression + the transient insteadOf rewrite.
        assert_eq!(
            bitbucket_credential_entries("https://alice@bitbucket.org/ws/repo.git"),
            vec![
                "credential.interactive=false".to_string(),
                "url.https://bitbucket.org/ws/repo.git.insteadOf=https://alice@bitbucket.org/ws/repo.git"
                    .to_string(),
            ]
        );
        // Bare-host remote → suppression only, no rewrite entry.
        assert_eq!(
            bitbucket_credential_entries("https://bitbucket.org/ws/repo.git"),
            vec!["credential.interactive=false".to_string()]
        );
    }

    #[test]
    fn strip_https_userinfo_removes_embedded_username() {
        // Bitbucket's API clone link embeds the account username.
        assert_eq!(
            strip_https_userinfo("https://alice-admin@bitbucket.org/ws/repo.git"),
            "https://bitbucket.org/ws/repo.git"
        );
        // No userinfo → unchanged.
        assert_eq!(
            strip_https_userinfo("https://bitbucket.org/ws/repo.git"),
            "https://bitbucket.org/ws/repo.git"
        );
        // Authority only, no path → unchanged host.
        assert_eq!(
            strip_https_userinfo("https://bob@bitbucket.org"),
            "https://bitbucket.org"
        );
        // Non-https (scp-style SSH) → untouched.
        assert_eq!(
            strip_https_userinfo("git@bitbucket.org:ws/repo.git"),
            "git@bitbucket.org:ws/repo.git"
        );
    }

    fn pr(json: &str) -> PrInfo {
        from_bb_pr(serde_json::from_str(json).expect("PR should parse"))
    }

    fn activity(json: &str) -> Option<PrTimelineEventOut> {
        map_activity_entry(serde_json::from_str(json).expect("activity should parse"))
    }

    #[test]
    fn activity_approval_maps_to_approved() {
        // Shape from the live `approval` activity entry.
        let ev = activity(
            r#"{"approval":{"date":"2026-07-03T21:12:55.697902-04:00",
                "user":{"display_name":"Casey Approver","uuid":"{0f39}"}}}"#,
        )
        .expect("approval is a timeline event");
        match ev {
            PrTimelineEventOut::Approved { actor, date } => {
                assert_eq!(actor, "Casey Approver");
                assert_eq!(date, "2026-07-03T21:12:55.697902-04:00");
            }
            _ => panic!("expected Approved"),
        }
    }

    #[test]
    fn activity_changes_requested_maps_to_changes_requested() {
        let ev = activity(
            r#"{"changes_requested":{"date":"2026-07-03T21:00:00-04:00",
                "user":{"display_name":"Ada"}}}"#,
        )
        .expect("changes_requested is a timeline event");
        assert!(matches!(ev, PrTimelineEventOut::ChangesRequested { .. }));
    }

    #[test]
    fn activity_merge_update_maps_to_merged() {
        // A merge update: state MERGED + a changes.status transition (live shape).
        let ev = activity(
            r#"{"update":{"state":"MERGED","date":"2023-03-13T09:06:16-04:00",
                "author":{"display_name":"Ada"},
                "changes":{"status":{"old":"open","new":"fulfilled"}}}}"#,
        )
        .expect("a status-changing MERGED update is an event");
        assert!(matches!(ev, PrTimelineEventOut::Merged { .. }));
    }

    #[test]
    fn activity_declined_update_maps_to_closed() {
        let ev = activity(
            r#"{"update":{"state":"DECLINED","date":"2023-03-13T09:06:16-04:00",
                "author":{"display_name":"Ada"},
                "changes":{"status":{"old":"open","new":"rejected"}}}}"#,
        )
        .expect("a status-changing DECLINED update is an event");
        assert!(matches!(ev, PrTimelineEventOut::Closed { .. }));
    }

    #[test]
    fn activity_non_state_update_and_comment_are_skipped() {
        // An OPEN update editing the draft flag (no status transition) → not an event.
        assert!(activity(
            r#"{"update":{"state":"OPEN","date":"2026-07-03T21:19:37-04:00",
                "author":{"display_name":"Ada"},"changes":{"draft":{"old":true,"new":false}}}}"#
        )
        .is_none());
        // A state MERGED but WITHOUT a changes.status is not a merge event.
        assert!(activity(
            r#"{"update":{"state":"MERGED","date":"x","author":{"display_name":"Ada"}}}"#
        )
        .is_none());
        // A comment activity carries neither update/approval/changes_requested.
        assert!(activity(r#"{"comment":{"id":1}}"#).is_none());
    }

    #[test]
    fn pr_list_item_maps_to_pr_info_with_draft_and_branches() {
        let p = pr(r#"{
                "id": 42,
                "title": "Add feature",
                "state": "OPEN",
                "draft": true,
                "author": {"display_name": "Ada Lovelace", "nickname": "ada"},
                "source": {"branch": {"name": "feature/x"}, "commit": {"hash": "abc123def"}},
                "destination": {"branch": {"name": "main"}},
                "links": {"html": {"href": "https://bitbucket.org/ws/repo/pull-requests/42"}},
                "created_on": "2026-07-02T08:30:00.000000+00:00"
            }"#);
        assert_eq!(p.number, 42);
        assert_eq!(p.state, "OPEN");
        assert!(p.is_draft);
        assert_eq!(p.head_ref_name, "feature/x");
        assert_eq!(p.base_ref_name, "main");
        assert_eq!(p.author.unwrap().login, "Ada Lovelace");
        assert_eq!(p.url, "https://bitbucket.org/ws/repo/pull-requests/42");
        assert!(p.labels.is_empty());
        // Opened-time maps through (CI status is a separate follow-up fetch).
        assert_eq!(p.created_at, "2026-07-02T08:30:00.000000+00:00");
        // Head SHA maps from source.commit.hash, feeding the Bitbucket CI probe.
        assert_eq!(p.head_sha, "abc123def");
    }

    #[test]
    fn reduce_bb_ci_reduces_the_status_set() {
        // Empty → none.
        assert_eq!(reduce_bb_ci(&[]), "none");
        // All successful → passing.
        assert_eq!(
            reduce_bb_ci(&["SUCCESSFUL".into(), "SUCCESSFUL".into()]),
            "passing"
        );
        // Any FAILED/STOPPED dominates.
        assert_eq!(
            reduce_bb_ci(&["SUCCESSFUL".into(), "FAILED".into()]),
            "failing"
        );
        assert_eq!(reduce_bb_ci(&["STOPPED".into()]), "failing");
        // In-progress (no failure) → pending, not passing.
        assert_eq!(
            reduce_bb_ci(&["SUCCESSFUL".into(), "INPROGRESS".into()]),
            "pending"
        );
        // Unknown state (no failure) → pending (conservative), case-insensitive.
        assert_eq!(reduce_bb_ci(&["successful".into()]), "passing");
        assert_eq!(reduce_bb_ci(&["WEIRD".into()]), "pending");
    }

    #[test]
    fn pr_state_maps_all_four_bitbucket_states() {
        assert_eq!(map_bb_pr_state("OPEN"), "OPEN");
        assert_eq!(map_bb_pr_state("MERGED"), "MERGED");
        assert_eq!(map_bb_pr_state("DECLINED"), "CLOSED");
        assert_eq!(map_bb_pr_state("SUPERSEDED"), "CLOSED");
        // Unknown → uppercased passthrough.
        assert_eq!(map_bb_pr_state("weird"), "WEIRD");
    }

    #[test]
    fn pr_tolerates_null_merge_commit_author_and_description() {
        // A minimal declined PR with a null author and no description.
        let p = pr(r#"{
                "id": 7,
                "title": "Old",
                "state": "DECLINED",
                "author": null,
                "description": null,
                "merge_commit": null,
                "source": {"branch": {"name": "old"}},
                "destination": {"branch": {"name": "main"}}
            }"#);
        assert_eq!(p.state, "CLOSED");
        assert!(!p.is_draft);
        assert!(p.author.is_none());
        assert_eq!(p.url, "");
    }

    #[test]
    fn pipelines_config_404_maps_to_disabled() {
        // A repo that never enabled Pipelines 404s regardless of the message wording.
        let cfg =
            parse_pipelines_config(404, r#"{"type":"error","error":{"message":"Not found"}}"#)
                .expect("404 should map to disabled, not error");
        assert!(!cfg.enabled);
    }

    #[test]
    fn pipelines_config_200_parses_enabled() {
        let cfg =
            parse_pipelines_config(200, r#"{"enabled":true}"#).expect("200 body should parse");
        assert!(cfg.enabled);
        let cfg =
            parse_pipelines_config(200, r#"{"enabled":false}"#).expect("200 body should parse");
        assert!(!cfg.enabled);
    }

    #[test]
    fn pipelines_config_other_status_errors() {
        // A 401 must surface as an error, not a silently-disabled config.
        assert!(parse_pipelines_config(401, r#"{"type":"error"}"#).is_err());
    }

    #[test]
    fn diffstat_maps_to_pr_file_out_including_renames() {
        let page: BbPage<BbDiffstat> = serde_json::from_str(
            r#"{"values":[
                {"status":"modified","lines_added":3,"lines_removed":1,
                 "old":{"path":"src/a.rs"},"new":{"path":"src/a.rs"}},
                {"status":"removed","lines_added":0,"lines_removed":9,
                 "old":{"path":"src/gone.rs"},"new":null},
                {"status":"added","lines_added":5,"lines_removed":0,
                 "old":null,"new":{"path":"src/new.rs"}},
                {"status":"renamed","lines_added":0,"lines_removed":0,
                 "old":{"path":"src/old.rs"},"new":{"path":"src/renamed.rs"}}
            ]}"#,
        )
        .unwrap();
        let files: Vec<PrFileOut> = page
            .values
            .into_iter()
            .map(|d| {
                let path = d
                    .new
                    .map(|p| p.path)
                    .filter(|p| !p.is_empty())
                    .or_else(|| d.old.map(|p| p.path))
                    .unwrap_or_default();
                PrFileOut {
                    path,
                    additions: d.lines_added,
                    deletions: d.lines_removed,
                }
            })
            .collect();
        assert_eq!(files[0].path, "src/a.rs");
        // Removed file: new is null → falls back to old path.
        assert_eq!(files[1].path, "src/gone.rs");
        assert_eq!(files[1].deletions, 9);
        // Added file: old is null → new path.
        assert_eq!(files[2].path, "src/new.rs");
        // Renamed: prefers the new path.
        assert_eq!(files[3].path, "src/renamed.rs");
    }

    #[test]
    fn conversation_comments_drop_deleted_pending_and_inline() {
        // The flat conversation list keeps only non-deleted, non-pending comments
        // that don't belong to an inline thread. Inline roots AND their replies
        // (which carry `parent` but not `inline`) both surface as review threads;
        // a reply to a plain non-inline comment stays in the flat list.
        let page: BbPage<BbComment> = serde_json::from_str(
            r#"{"values":[
                {"id":1,"content":{"raw":"general note"},"user":{"display_name":"Bob"},
                 "created_on":"2026-01-01"},
                {"id":2,"content":{"raw":"needs fix"},"user":{"display_name":"Sue"},
                 "created_on":"2026-01-02","inline":{"path":"src/x.rs","to":12}},
                {"id":3,"content":{"raw":"gone"},"deleted":true,"created_on":"2026-01-03"},
                {"id":4,"content":{"raw":"draft"},"pending":true,"created_on":"2026-01-04"},
                {"id":5,"content":{"raw":"inline reply"},"user":{"display_name":"Amy"},
                 "created_on":"2026-01-05","parent":{"id":2}},
                {"id":6,"content":{"raw":"reply to general"},"user":{"display_name":"Cid"},
                 "created_on":"2026-01-06","parent":{"id":1}}
            ]}"#,
        )
        .unwrap();
        let inline_ids = inline_thread_comment_ids(&page.values);
        // The inline root (2) and its reply (5) are both flagged; nothing else is.
        assert!(inline_ids.contains(&2));
        assert!(inline_ids.contains(&5));
        assert!(!inline_ids.contains(&1));
        assert!(!inline_ids.contains(&6));
        let threads: Vec<PrThreadOut> = page
            .values
            .into_iter()
            .filter(|c| !c.deleted && !c.pending && !inline_ids.contains(&c.id))
            .map(|c| from_bb_comment(c, ""))
            .collect();
        // Survivors: the general comment and its (non-inline) reply. The inline
        // root + its reply, plus deleted/pending, are excluded.
        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].body, "general note");
        assert_eq!(threads[0].author, "Bob");
        assert_eq!(threads[1].body, "reply to general");
        assert_eq!(threads[1].author, "Cid");
    }

    #[test]
    fn comment_authored_by_viewer_matches_uuid() {
        let mine = BbUser {
            uuid: Some("{me-uuid}".into()),
            username: None,
            display_name: Some("Me".into()),
            nickname: None,
            links: None,
        };
        let theirs = BbUser {
            uuid: Some("{other-uuid}".into()),
            username: None,
            display_name: Some("Them".into()),
            nickname: None,
            links: None,
        };
        let no_uuid = BbUser {
            uuid: None,
            username: None,
            display_name: Some("Anon".into()),
            nickname: None,
            links: None,
        };
        // Match → true.
        assert!(comment_authored_by_viewer(Some(&mine), "{me-uuid}"));
        // Different uuid → false.
        assert!(!comment_authored_by_viewer(Some(&theirs), "{me-uuid}"));
        // Author has no uuid → false.
        assert!(!comment_authored_by_viewer(Some(&no_uuid), "{me-uuid}"));
        // Unknown viewer (empty uuid) → false even for a real author.
        assert!(!comment_authored_by_viewer(Some(&mine), ""));
        // No author at all → false.
        assert!(!comment_authored_by_viewer(None, "{me-uuid}"));
    }

    #[test]
    fn parse_bb_comment_id_rejects_non_numeric() {
        assert_eq!(parse_bb_comment_id("42").unwrap(), 42);
        assert!(parse_bb_comment_id("").is_err());
        assert!(parse_bb_comment_id("abc").is_err());
        assert!(parse_bb_comment_id("{node}").is_err());
    }

    #[test]
    fn group_bb_threads_roots_replies_and_line_side() {
        // Two inline roots (one on the new side via `to`, one on the old side via
        // `from`), a nested reply chain, and deleted/pending/general noise that must
        // be excluded from threads.
        let page: BbPage<BbComment> = serde_json::from_str(
            r#"{"values":[
                {"id":10,"content":{"raw":"root A"},"user":{"display_name":"Ann"},
                 "created_on":"2026-01-01","inline":{"path":"a.rs","to":5}},
                {"id":11,"content":{"raw":"reply A1"},"user":{"display_name":"Bob"},
                 "created_on":"2026-01-02","parent":{"id":10}},
                {"id":12,"content":{"raw":"reply A2 (to A1)"},"user":{"display_name":"Cy"},
                 "created_on":"2026-01-03","parent":{"id":11}},
                {"id":20,"content":{"raw":"root B old-side"},"user":{"display_name":"Dee"},
                 "created_on":"2026-01-04","inline":{"path":"b.rs","from":9}},
                {"id":30,"content":{"raw":"general"},"created_on":"2026-01-05"},
                {"id":40,"content":{"raw":"gone"},"deleted":true,"created_on":"2026-01-06",
                 "inline":{"path":"c.rs","to":1}},
                {"id":50,"content":{"raw":"draft"},"pending":true,"created_on":"2026-01-07",
                 "inline":{"path":"d.rs","to":2}}
            ]}"#,
        )
        .unwrap();
        // Unknown viewer → every viewer_did_author stays false.
        let threads = group_bb_threads(page.values, "");
        assert_eq!(threads.len(), 2);

        // Thread A: root + two replies (the deeper reply walks parent→parent→root),
        // ordered oldest-first, new side, line 5.
        let a = &threads[0];
        assert_eq!(a.id, "10");
        assert_eq!(a.path, "a.rs");
        assert_eq!(a.line, 5);
        assert_eq!(a.side, "new");
        assert!(!a.is_resolved && !a.is_outdated);
        // Bitbucket has no multi-line range or diff excerpt.
        assert_eq!(a.start_line, 0);
        assert_eq!(a.diff_hunk, "");
        // Bitbucket doesn't model review objects, so no owning review id.
        assert_eq!(a.review_id, "");
        assert_eq!(a.comments.len(), 3);
        assert_eq!(a.comments[0].body, "root A");
        assert_eq!(a.comments[1].body, "reply A1");
        assert_eq!(a.comments[2].body, "reply A2 (to A1)");

        // Thread B: old side (from → "old"), line 9, single comment.
        let b = &threads[1];
        assert_eq!(b.id, "20");
        assert_eq!(b.side, "old");
        assert_eq!(b.line, 9);
        assert_eq!(b.comments.len(), 1);
    }

    #[test]
    fn group_bb_threads_walks_through_deleted_mid_chain_but_drops_deleted_root() {
        // Chains must walk THROUGH a deleted intermediate up to a surviving root (that
        // reply renders), but a chain whose ROOT is deleted has no live root, so its
        // reply drops (orphan handling).
        let page: BbPage<BbComment> = serde_json::from_str(
            r#"{"values":[
                {"id":100,"content":{"raw":"root live"},"user":{"display_name":"Ann"},
                 "created_on":"2026-01-01","inline":{"path":"a.rs","to":5}},
                {"id":101,"content":{"raw":"mid gone"},"deleted":true,
                 "created_on":"2026-01-02","parent":{"id":100}},
                {"id":102,"content":{"raw":"reply survives"},"user":{"display_name":"Bob"},
                 "created_on":"2026-01-03","parent":{"id":101}},
                {"id":200,"content":{"raw":"root gone"},"deleted":true,
                 "created_on":"2026-01-04","inline":{"path":"b.rs","to":8}},
                {"id":201,"content":{"raw":"orphan reply"},"user":{"display_name":"Cy"},
                 "created_on":"2026-01-05","parent":{"id":200}}
            ]}"#,
        )
        .unwrap();
        let threads = group_bb_threads(page.values, "");
        // Only the live-root thread survives; the deleted-root thread is gone.
        assert_eq!(threads.len(), 1);
        let t = &threads[0];
        assert_eq!(t.id, "100");
        // root + reply render; the deleted mid is walked through but NOT rendered.
        assert_eq!(t.comments.len(), 2);
        assert_eq!(t.comments[0].body, "root live");
        assert_eq!(t.comments[1].body, "reply survives");
    }

    #[test]
    fn group_bb_threads_marks_viewer_authored_on_root_and_reply() {
        // A root the viewer authored and a reply someone else authored: with the
        // viewer's uuid known, viewer_did_author is true for the root, false for the
        // reply — proving the flag is per-comment, on both roots and replies.
        let page: BbPage<BbComment> = serde_json::from_str(
            r#"{"values":[
                {"id":10,"content":{"raw":"my root"},
                 "user":{"display_name":"Me","uuid":"{me-uuid}"},
                 "created_on":"2026-01-01","inline":{"path":"a.rs","to":5}},
                {"id":11,"content":{"raw":"their reply"},
                 "user":{"display_name":"Them","uuid":"{other-uuid}"},
                 "created_on":"2026-01-02","parent":{"id":10}},
                {"id":12,"content":{"raw":"my reply"},
                 "user":{"display_name":"Me","uuid":"{me-uuid}"},
                 "created_on":"2026-01-03","parent":{"id":10}}
            ]}"#,
        )
        .unwrap();
        let threads = group_bb_threads(page.values, "{me-uuid}");
        assert_eq!(threads.len(), 1);
        let c = &threads[0].comments;
        assert_eq!(c.len(), 3);
        // Root authored by the viewer → true.
        assert!(c[0].viewer_did_author);
        // Reply by another user → false.
        assert!(!c[1].viewer_did_author);
        // Reply by the viewer → true (per-comment, works on replies too).
        assert!(c[2].viewer_did_author);
    }

    #[test]
    fn pipeline_status_matrix_including_error_and_missing_result() {
        assert_eq!(
            map_bb_pipeline_status("COMPLETED", "SUCCESSFUL"),
            ("completed".into(), "success".into())
        );
        assert_eq!(
            map_bb_pipeline_status("COMPLETED", "FAILED"),
            ("completed".into(), "failure".into())
        );
        assert_eq!(
            map_bb_pipeline_status("COMPLETED", "ERROR"),
            ("completed".into(), "failure".into())
        );
        assert_eq!(
            map_bb_pipeline_status("COMPLETED", "STOPPED"),
            ("completed".into(), "cancelled".into())
        );
        // COMPLETED with no result → finished-neutral.
        assert_eq!(
            map_bb_pipeline_status("COMPLETED", ""),
            ("completed".into(), "".into())
        );
        assert_eq!(
            map_bb_pipeline_status("IN_PROGRESS", ""),
            ("in_progress".into(), "".into())
        );
        assert_eq!(
            map_bb_pipeline_status("PENDING", ""),
            ("queued".into(), "".into())
        );
    }

    #[test]
    fn pipeline_maps_to_workflow_run_with_nonempty_started_at() {
        let p: BbPipeline = serde_json::from_str(
            r#"{
                "uuid": "{abc-123}",
                "build_number": 17,
                "state": {"name": "COMPLETED", "result": {"name": "FAILED"}},
                "target": {"ref_name": "main", "commit": {"hash": "deadbeef"}},
                "trigger": {"name": "PUSH"},
                "created_on": "2026-02-01T00:00:00Z",
                "completed_on": "2026-02-01T00:05:00Z"
            }"#,
        )
        .unwrap();
        let run = from_bb_pipeline(p, "ws", "repo");
        assert_eq!(run.id, 17);
        assert_eq!(run.number, 17);
        assert_eq!(run.status, "completed");
        assert_eq!(run.conclusion, "failure");
        assert_eq!(run.workflow_name, "Push");
        assert_eq!(run.head_branch, "main");
        assert_eq!(run.event, "push");
        assert_eq!(run.head_sha, "deadbeef");
        // started_at must never be empty (Insights filters on it).
        assert!(!run.started_at.is_empty());
        assert_eq!(run.started_at, "2026-02-01T00:00:00Z");
        assert_eq!(run.updated_at, "2026-02-01T00:05:00Z");
        assert_eq!(
            run.url,
            "https://bitbucket.org/ws/repo/pipelines/results/17"
        );
    }

    #[test]
    fn pipeline_missing_completed_on_falls_back_to_created_on_for_updated_at() {
        let p: BbPipeline = serde_json::from_str(
            r#"{
                "uuid": "{x}",
                "build_number": 3,
                "state": {"name": "IN_PROGRESS"},
                "target": {"ref_name": "dev", "commit": {"hash": "aa"}},
                "trigger": {"name": "MANUAL"},
                "created_on": "2026-03-01T00:00:00Z"
            }"#,
        )
        .unwrap();
        let run = from_bb_pipeline(p, "ws", "repo");
        assert_eq!(run.updated_at, "2026-03-01T00:00:00Z");
        assert_eq!(run.started_at, "2026-03-01T00:00:00Z");
        assert_eq!(run.workflow_name, "Manual");
    }

    #[test]
    fn step_maps_to_run_job_with_synthetic_id_and_log_ref() {
        let s: BbStep = serde_json::from_str(
            r#"{
                "uuid": "{step-9}",
                "name": "Build",
                "state": {"name": "COMPLETED", "result": {"name": "SUCCESSFUL"}},
                "started_on": "2026-01-01T00:00:00Z",
                "completed_on": "2026-01-01T00:01:00Z"
            }"#,
        )
        .unwrap();
        let job = from_bb_step(
            0,
            s,
            "{pipe-1}",
            "https://bitbucket.org/ws/repo/pipelines/results/1",
        );
        // Synthetic 1-based id.
        assert_eq!(job.id, 1);
        assert_eq!(job.name, "Build");
        assert_eq!(job.status, "completed");
        assert_eq!(job.conclusion, "success");
        // log_ref carries the RAW braced UUIDs joined by '/'.
        assert_eq!(job.log_ref.as_deref(), Some("{pipe-1}/{step-9}"));
    }

    #[test]
    fn step_without_name_gets_synthetic_step_label() {
        let s: BbStep =
            serde_json::from_str(r#"{"uuid":"{s}","state":{"name":"PENDING"}}"#).unwrap();
        let job = from_bb_step(2, s, "{p}", "url");
        assert_eq!(job.name, "Step 3");
        assert_eq!(job.status, "queued");
    }

    #[test]
    fn repo_maps_clone_ssh_fork_and_private() {
        let r: BbRepo = serde_json::from_str(
            r#"{
                "name": "myrepo",
                "full_name": "ws/myrepo",
                "is_private": true,
                "description": "A repo",
                "updated_on": "2026-01-01",
                "parent": {"full_name": "other/myrepo"},
                "links": {
                    "clone": [
                        {"name": "https", "href": "https://bitbucket.org/ws/myrepo.git"},
                        {"name": "ssh", "href": "git@bitbucket.org:ws/myrepo.git"}
                    ]
                },
                "workspace": {"slug": "ws"}
            }"#,
        )
        .unwrap();
        let repo = from_bb_repo(r);
        assert_eq!(repo.full_name, "ws/myrepo");
        assert_eq!(repo.owner, "ws");
        assert_eq!(repo.name, "myrepo");
        assert!(repo.private);
        assert!(!repo.archived);
        assert!(repo.fork);
        assert_eq!(repo.clone_url, "https://bitbucket.org/ws/myrepo.git");
        assert_eq!(repo.ssh_url, "git@bitbucket.org:ws/myrepo.git");
    }

    #[test]
    fn repo_without_ssh_link_gets_empty_ssh_url_and_no_fork() {
        let r: BbRepo = serde_json::from_str(
            r#"{
                "name": "solo",
                "full_name": "ws/solo",
                "is_private": false,
                "links": {"clone": [{"name": "https", "href": "https://bitbucket.org/ws/solo.git"}]},
                "workspace": {"slug": "ws"}
            }"#,
        )
        .unwrap();
        let repo = from_bb_repo(r);
        assert!(!repo.private);
        assert!(!repo.fork);
        assert_eq!(repo.ssh_url, "");
    }

    #[test]
    fn user_workspaces_membership_wrappers_yield_slugs_and_skip_empty() {
        // The live CHANGE-3022 shape: `workspace_access` wrappers with a nested
        // `workspace_base` (uuid/slug/links, NO name). An entry with no nested
        // workspace or an empty slug is skipped.
        let page: BbPage<BbWorkspaceAccess> = serde_json::from_str(
            r#"{"values":[
                {"type":"workspace_access","administrator":true,
                 "workspace":{"type":"workspace_base","uuid":"{286b6e4c}","slug":"betabotsllc",
                              "links":{"avatar":{"href":"x"},"self":{"href":"y"}}}},
                {"type":"workspace_access","workspace":{"slug":""}},
                {"type":"workspace_access"}
            ]}"#,
        )
        .unwrap();
        let slugs: Vec<String> = page
            .values
            .into_iter()
            .filter_map(|a| a.workspace.map(|w| w.slug).filter(|s| !s.is_empty()))
            .collect();
        assert_eq!(slugs, vec!["betabotsllc".to_string()]);
    }

    #[test]
    fn uuid_percent_encoding_encodes_braces() {
        assert_eq!(encode_uuid("{abc-123}"), "%7Babc-123%7D");
        // Unreserved chars pass through.
        assert_eq!(encode_uuid("a.b-c_d~e"), "a.b-c_d~e");
    }

    #[test]
    fn check_state_maps_onto_frontend_vocabulary() {
        assert_eq!(map_bb_check_state("SUCCESSFUL"), "SUCCESS");
        assert_eq!(map_bb_check_state("FAILED"), "FAILURE");
        assert_eq!(map_bb_check_state("STOPPED"), "CANCELLED");
        assert_eq!(map_bb_check_state("INPROGRESS"), "PENDING");
    }

    #[test]
    fn bitbucket_status_assembly_no_token_unauth_and_ready() {
        // No token: not installed, not authenticated, no login, repo still filled.
        let s = bitbucket_status(false, false, "bitbucket.org", Some("ws/r".into()), None);
        assert!(!s.installed && !s.authenticated);
        assert_eq!(s.repo.as_deref(), Some("ws/r"));
        assert!(s.login.is_none());
        assert!(s.implemented.pull_requests && s.implemented.ci && s.implemented.repo_actions);

        // Token but unauthenticated (expired): installed, not authenticated.
        let s = bitbucket_status(
            true,
            false,
            "bitbucket.org",
            Some("ws/r".into()),
            Some("me".into()),
        );
        assert!(s.installed && !s.authenticated);
        assert_eq!(s.login.as_deref(), Some("me"));

        // Ready: installed + authenticated.
        let s = bitbucket_status(
            true,
            true,
            "bitbucket.org",
            Some("ws/r".into()),
            Some("me".into()),
        );
        assert!(s.installed && s.authenticated);
        assert_eq!(s.host.as_deref(), Some("bitbucket.org"));
        assert_eq!(s.provider, Some(Provider::Bitbucket));
    }

    #[test]
    fn pr_state_filter_rejects_unknown_values() {
        assert_eq!(pr_state_filter("open").unwrap(), "state=OPEN");
        assert_eq!(
            pr_state_filter("closed").unwrap(),
            "state=MERGED&state=DECLINED&state=SUPERSEDED"
        );
        assert!(matches!(
            pr_state_filter("all"),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[tokio::test]
    async fn prs_for_branch_rejects_quote_backslash_empty_and_dash_heads() {
        // Each of these is rejected BEFORE any network/credential I/O, so a bogus
        // repo path never matters — the validation error fires first.
        for bad in ["", "-x", "has\"quote", "has\\backslash"] {
            match prs_for_branch("C:/nonexistent", bad).await {
                Err(AppError::InvalidArgument(_)) => {}
                Err(e) => panic!("expected InvalidArgument for head {bad:?}, got {e:?}"),
                Ok(_) => panic!("expected InvalidArgument for head {bad:?}, got Ok"),
            }
        }
    }

    #[test]
    fn user_login_prefers_display_name_then_nickname() {
        let full: BbUser = serde_json::from_str(
            r#"{"username":"u","display_name":"Full Name","nickname":"nick"}"#,
        )
        .unwrap();
        assert_eq!(user_login(&full), "Full Name");
        let no_display: BbUser = serde_json::from_str(r#"{"nickname":"nick"}"#).unwrap();
        assert_eq!(user_login(&no_display), "nick");
    }

    // ── Write-side unit tests (pure; no network) ────────────────────────────────

    #[test]
    fn merge_strategy_maps_neutral_to_bitbucket_enum() {
        assert_eq!(map_merge_strategy("merge").unwrap(), "merge_commit");
        assert_eq!(map_merge_strategy("squash").unwrap(), "squash");
        assert_eq!(map_merge_strategy("fast_forward").unwrap(), "fast_forward");
        assert!(matches!(
            map_merge_strategy("rebase"),
            Err(AppError::InvalidArgument(_))
        ));
    }

    fn participants(json: &str) -> Vec<BbParticipant> {
        let page: BbPrParticipants = serde_json::from_str(json).unwrap();
        page.participants
    }

    #[test]
    fn approval_state_reflects_viewer_approval() {
        let ps = participants(
            r#"{"participants":[
                {"user":{"uuid":"{me}","nickname":"me"},"approved":true,"state":"approved"},
                {"user":{"uuid":"{other}","nickname":"other"},"approved":false,"state":null}
            ]}"#,
        );
        // Viewer matched by uuid; the viewer's approved_by entry is the passed login.
        let state = build_approval_state(&ps, "{me}", "me-login");
        assert!(state.viewer_has_approved);
        assert!(!state.viewer_requested_changes);
        assert_eq!(state.approved_by, vec!["me-login".to_string()]);
        assert_eq!(state.approvals_required, 0);
        assert_eq!(state.approvals_left, 0);
    }

    #[test]
    fn approval_state_matches_viewer_by_uuid_not_name() {
        // The viewer's nickname, username, and display_name are ALL different and the
        // participant object carries no username (Bitbucket privacy) — only uuid matching
        // works.
        let ps = participants(
            r#"{"participants":[
                {"user":{"uuid":"{viewer-uuid}","nickname":"nick","display_name":"Display Name"},
                 "approved":true,"state":"approved"},
                {"user":{"uuid":"{other-uuid}","nickname":"other"},"approved":true,"state":"approved"}
            ]}"#,
        );
        // viewer_uuid matches the first participant; viewer_login is the account
        // username (what status().login emits), distinct from nickname/display_name.
        let state = build_approval_state(&ps, "{viewer-uuid}", "myusername");
        assert!(state.viewer_has_approved);
        // The viewer's own entry uses the login string (reconciles with the optimistic
        // toggle); the OTHER approver keeps their human-readable nickname.
        assert_eq!(
            state.approved_by,
            vec!["myusername".to_string(), "other".to_string()]
        );
    }

    #[test]
    fn approval_state_reflects_another_reviewer_requested_changes() {
        let ps = participants(
            r#"{"participants":[
                {"user":{"uuid":"{me}","nickname":"me"},"approved":false,"state":null},
                {"user":{"uuid":"{rev}","nickname":"rev"},"approved":false,"state":"changes_requested"}
            ]}"#,
        );
        let state = build_approval_state(&ps, "{me}", "me-login");
        // The viewer neither approved nor requested changes.
        assert!(!state.viewer_has_approved);
        assert!(!state.viewer_requested_changes);
        assert!(state.approved_by.is_empty());
    }

    #[test]
    fn poll_pr_maps_state_short_sha_and_own_author_as_login() {
        // DECLINED collapses to CLOSED; the short (12-char) head hash rides through
        // as-is; the author is the VIEWER, so it emits the stored login (not nickname)
        // — that's how the hook suppresses a notification about the viewer's own PR.
        let json = r#"{
            "id": 12,
            "title": "My PR",
            "state": "DECLINED",
            "draft": false,
            "author": {"uuid": "{me}", "nickname": "me-nick"},
            "source": {"commit": {"hash": "abc123def456"}},
            "links": {"html": {"href": "https://bitbucket.org/w/r/pull-requests/12"}},
            "created_on": "2026-01-02T03:04:05.000000+00:00"
        }"#;
        let info = from_bb_poll_pr(serde_json::from_str(json).unwrap(), "{me}", "me-login");
        assert_eq!(info.number, 12);
        assert_eq!(info.state, "CLOSED");
        assert_eq!(info.url, "https://bitbucket.org/w/r/pull-requests/12");
        // Author == the viewer's login, so `pr.author === gh.login` matches → own PR.
        assert_eq!(info.author, "me-login");
        // The 12-char short sha is passed through untouched.
        assert_eq!(info.head_sha, "abc123def456");
        assert_eq!(info.review_decision, "");
        assert_eq!(info.checks_state, "");
        // `created_on` rides through as `created_at` for the missed-open catch-up.
        assert_eq!(info.created_at, "2026-01-02T03:04:05.000000+00:00");
    }

    #[test]
    fn poll_pr_other_author_uses_nickname() {
        // A PR by someone else: no username is available (Bitbucket privacy), so the
        // author falls back to the nickname — the hook then notifies (not the viewer).
        let json = r#"{
            "id": 3,
            "title": "Their PR",
            "state": "OPEN",
            "author": {"uuid": "{other}", "nickname": "other-nick"},
            "source": {"commit": {"hash": "000111222333"}}
        }"#;
        let info = from_bb_poll_pr(serde_json::from_str(json).unwrap(), "{me}", "me-login");
        assert_eq!(info.state, "OPEN");
        assert_eq!(info.author, "other-nick");
        assert_eq!(info.head_sha, "000111222333");
        // SUPERSEDED also collapses to CLOSED.
        assert_eq!(map_bb_pr_state("SUPERSEDED"), "CLOSED");
    }

    #[test]
    fn poll_pr_tolerates_missing_author_and_commit() {
        // A PR with no author object and no source commit must not sink the parse.
        let json = r#"{ "id": 9, "title": "t", "state": "MERGED" }"#;
        let info = from_bb_poll_pr(serde_json::from_str(json).unwrap(), "{me}", "me-login");
        assert_eq!(info.number, 9);
        assert_eq!(info.state, "MERGED");
        assert_eq!(info.author, "");
        assert_eq!(info.head_sha, "");
        // Absent `created_on` defaults to "" (the frontend fails closed on it).
        assert_eq!(info.created_at, "");
    }

    #[test]
    fn approval_state_reflects_viewer_requested_changes() {
        let ps = participants(
            r#"{"participants":[
                {"user":{"uuid":"{me}","nickname":"me"},"approved":false,"state":"changes_requested"}
            ]}"#,
        );
        let state = build_approval_state(&ps, "{me}", "me-login");
        assert!(!state.viewer_has_approved);
        assert!(state.viewer_requested_changes);
    }

    #[test]
    fn approval_state_empty_viewer_uuid_never_matches() {
        // Defensive: if the self /user probe failed (empty uuid), no participant is
        // mistaken for the viewer (an empty uuid must not match a missing uuid).
        let ps = participants(
            r#"{"participants":[
                {"user":{"nickname":"someone"},"approved":true,"state":"approved"}
            ]}"#,
        );
        let state = build_approval_state(&ps, "", "me-login");
        assert!(!state.viewer_has_approved);
        assert!(!state.viewer_requested_changes);
        // The approver is not the viewer, so their nickname (not the login) is used.
        assert_eq!(state.approved_by, vec!["someone".to_string()]);
    }

    #[test]
    fn completed_reviewers_maps_states_avatars_and_skips_commenters() {
        // approved → APPROVED (with avatar), changes_requested → CHANGES_REQUESTED,
        // null (a commenter) → skipped, unrecognized state → skipped.
        let ps = participants(
            r#"{"participants":[
                {"user":{"uuid":"{app}","display_name":"Approver",
                         "links":{"avatar":{"href":"https://avatars/app.png"}}},
                 "approved":true,"state":"approved"},
                {"user":{"uuid":"{cr}","nickname":"Reviewer"},
                 "approved":false,"state":"changes_requested"},
                {"user":{"uuid":"{c}","nickname":"Commenter"},"approved":false,"state":null},
                {"user":{"uuid":"{u}","nickname":"Unknown"},"approved":false,"state":"weird"}
            ]}"#,
        );
        let out = completed_reviewers_from(&ps);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].user.id, "{app}");
        assert_eq!(out[0].user.label, "Approver");
        assert_eq!(out[0].user.avatar_url, "https://avatars/app.png");
        assert!(!out[0].user.is_bot);
        assert_eq!(out[0].state, "APPROVED");
        assert_eq!(out[1].user.id, "{cr}");
        assert_eq!(out[1].user.label, "Reviewer");
        assert_eq!(out[1].state, "CHANGES_REQUESTED");
    }

    #[test]
    fn completed_reviewers_skips_participant_with_no_uuid() {
        // A participant with a verdict but no braced uuid can't round-trip, so it's
        // dropped rather than emitted with an empty id.
        let ps = participants(
            r#"{"participants":[
                {"user":{"nickname":"NoUuid"},"approved":true,"state":"approved"}
            ]}"#,
        );
        assert!(completed_reviewers_from(&ps).is_empty());
    }

    #[test]
    fn create_pr_maps_id_and_html_url_to_pr_ref() {
        let created: BbCreatedPr = serde_json::from_str(
            r#"{
                "id": 123,
                "title": "New feature",
                "links": {"html": {"href": "https://bitbucket.org/ws/repo/pull-requests/123"}}
            }"#,
        )
        .unwrap();
        let pr_ref = PrRef {
            number: created.id,
            url: html_href(&created.links),
        };
        assert_eq!(pr_ref.number, 123);
        assert_eq!(
            pr_ref.url,
            "https://bitbucket.org/ws/repo/pull-requests/123"
        );
    }

    #[test]
    fn duplicate_pr_number_matches_only_same_destination() {
        // `prs_for_branch` already constrains source==head + OPEN, so the fixtures here
        // are all open PRs from the same head; only the destination differs.
        let to_main = pr(r#"{"id":7,"title":"x","state":"OPEN",
            "source":{"branch":{"name":"feature/x"}},
            "destination":{"branch":{"name":"main"}}}"#);
        let to_develop = pr(r#"{"id":9,"title":"y","state":"OPEN",
            "source":{"branch":{"name":"feature/x"}},
            "destination":{"branch":{"name":"develop"}}}"#);
        // A PR into develop is not a duplicate of a create into main.
        assert_eq!(duplicate_pr_number(&[to_develop], "main"), None);
        // …but one already into main is.
        let list = vec![
            pr(r#"{"id":9,"title":"y","state":"OPEN",
                "source":{"branch":{"name":"feature/x"}},
                "destination":{"branch":{"name":"develop"}}}"#),
            to_main,
        ];
        assert_eq!(duplicate_pr_number(&list, "main"), Some(7));
        // Empty list → no duplicate.
        assert_eq!(duplicate_pr_number(&[], "main"), None);
    }

    #[test]
    fn create_body_carries_source_destination_and_draft() {
        let body = build_create_body("main", "feature/x", "Title", "Body", true, &[]);
        assert_eq!(body["title"], "Title");
        assert_eq!(body["description"], "Body");
        assert_eq!(body["source"]["branch"]["name"], "feature/x");
        assert_eq!(body["destination"]["branch"]["name"], "main");
        assert_eq!(body["draft"], true);
        // Empty reviewers → the key is OMITTED (preserves the server's default-reviewer
        // auto-add; sending `[]` would suppress it).
        assert!(body.get("reviewers").is_none());
    }

    #[test]
    fn create_body_with_reviewers_maps_uuids() {
        let body = build_create_body(
            "main",
            "feature/x",
            "T",
            "B",
            false,
            &["{a}".to_string(), "{b}".to_string()],
        );
        let reviewers = body["reviewers"].as_array().unwrap();
        assert_eq!(reviewers.len(), 2);
        assert_eq!(reviewers[0]["uuid"], "{a}");
        assert_eq!(reviewers[1]["uuid"], "{b}");
    }

    #[test]
    fn edit_body_echoes_reviewers_alongside_title_and_description() {
        let body = build_edit_body(
            "T",
            "D",
            &["{uuid-1}".to_string(), "{uuid-2}".to_string()],
            None,
        );
        assert_eq!(body["title"], "T");
        assert_eq!(body["description"], "D");
        let reviewers = body["reviewers"].as_array().unwrap();
        assert_eq!(reviewers.len(), 2);
        assert_eq!(reviewers[0]["uuid"], "{uuid-1}");
        assert_eq!(reviewers[1]["uuid"], "{uuid-2}");
    }

    #[test]
    fn edit_body_with_no_reviewers_sends_empty_array_not_omitted() {
        let body = build_edit_body("T", "D", &[], None);
        // The reviewers key is present (an empty array), so we never accidentally omit
        // it — which would WIPE reviewers on a PR that had them.
        assert!(body["reviewers"].is_array());
        assert_eq!(body["reviewers"].as_array().unwrap().len(), 0);
    }

    /// `destination` rides the edit body only when retargeting: unlike `reviewers`,
    /// omitting it keeps the PR's current target branch.
    #[test]
    fn edit_body_carries_destination_only_when_retargeting() {
        let plain = build_edit_body("T", "D", &[], None);
        assert!(plain.get("destination").is_none());

        let retarget = build_edit_body("T", "D", &[], Some("main"));
        assert_eq!(retarget["destination"]["branch"]["name"], "main");
        // Every other field is untouched by the retarget.
        assert_eq!(retarget["title"], plain["title"]);
        assert_eq!(retarget["description"], plain["description"]);
        assert_eq!(retarget["reviewers"], plain["reviewers"]);
    }

    #[test]
    fn trigger_body_with_variables_adds_sorted_variables_array() {
        let mut inputs = std::collections::HashMap::new();
        inputs.insert("DEPLOY_ENV".to_string(), "staging".to_string());
        inputs.insert("VERSION".to_string(), "1.2.3".to_string());
        let body = build_trigger_body("main", "branch", "", &inputs);
        assert_eq!(body["target"]["type"], "pipeline_ref_target");
        assert_eq!(body["target"]["ref_type"], "branch");
        assert_eq!(body["target"]["ref_name"], "main");
        let vars = body["variables"].as_array().unwrap();
        assert_eq!(vars.len(), 2);
        // Sorted by key for determinism.
        assert_eq!(vars[0]["key"], "DEPLOY_ENV");
        assert_eq!(vars[0]["value"], "staging");
        assert_eq!(vars[1]["key"], "VERSION");
        assert_eq!(vars[1]["value"], "1.2.3");
        // No custom selector when workflow is empty.
        assert!(body["target"].get("selector").is_none());
    }

    #[test]
    fn trigger_body_without_variables_omits_the_array() {
        let body = build_trigger_body("dev", "branch", "", &std::collections::HashMap::new());
        assert_eq!(body["target"]["ref_name"], "dev");
        // No `variables` key at all when inputs are empty.
        assert!(body.get("variables").is_none());
        // No selector either (default pipeline).
        assert!(body["target"].get("selector").is_none());
    }

    #[test]
    fn trigger_body_with_tag_ref_type_sets_tag_target() {
        // A tag dispatch must carry `ref_type:"tag"` (the dialog's ref field is
        // free-text "Branch or tag", so the backend detects the type).
        let body = build_trigger_body("v1.2.3", "tag", "", &std::collections::HashMap::new());
        assert_eq!(body["target"]["ref_type"], "tag");
        assert_eq!(body["target"]["ref_name"], "v1.2.3");
    }

    #[test]
    fn trigger_body_with_workflow_adds_custom_selector_inside_target() {
        let body = build_trigger_body("main", "branch", "w4-smoke", &std::collections::HashMap::new());
        assert_eq!(body["target"]["ref_name"], "main");
        assert_eq!(body["target"]["selector"]["type"], "custom");
        assert_eq!(body["target"]["selector"]["pattern"], "w4-smoke");
        // No variables when inputs are empty.
        assert!(body.get("variables").is_none());
    }

    #[test]
    fn trigger_body_selector_and_variables_combine() {
        let mut inputs = std::collections::HashMap::new();
        inputs.insert("W4_VAR".to_string(), "on".to_string());
        let body = build_trigger_body("dev", "branch", "w4-second", &inputs);
        assert_eq!(body["target"]["selector"]["pattern"], "w4-second");
        let vars = body["variables"].as_array().unwrap();
        assert_eq!(vars.len(), 1);
        assert_eq!(vars[0]["key"], "W4_VAR");
        assert_eq!(vars[0]["value"], "on");
    }

    // ── Custom-pipeline-name parser ─────────────────────────────────────────────

    #[test]
    fn custom_pipelines_parse_the_live_validated_yml() {
        let yml = "\
pipelines:
  custom:
    w4-smoke:
      - step:
          name: Smoke
          script:
            - echo \"w4 smoke $W4_VAR\"
    w4-second:
      - step:
          script:
            - echo second
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["w4-smoke".to_string(), "w4-second".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_strip_quotes_from_keys() {
        let yml = "\
pipelines:
  custom:
    \"quoted-one\":
      - step:
          script:
            - echo a
    'quoted-two':
      - step:
          script:
            - echo b
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["quoted-one".to_string(), "quoted-two".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_ignore_comments_full_line_and_trailing() {
        let yml = "\
# top comment
pipelines:
  # a comment inside pipelines
  custom:
    deploy:  # trailing comment on the key
      - step:
          script:
            - echo deploy

    # another comment
    smoke:
      - step:
          script:
            - echo smoke
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["deploy".to_string(), "smoke".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_tolerate_trailing_comment_on_pipelines_key() {
        // A trailing comment on `pipelines:` must not read as an inline flow value and
        // bail — the custom names still parse.
        let yml = "\
pipelines:  # ci config
  custom:
    w4-smoke:
      - step:
          script:
            - echo smoke
    w4-second:
      - step:
          script:
            - echo second
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["w4-smoke".to_string(), "w4-second".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_handle_four_space_indent() {
        // Indent width is measured from the first child, not assumed to be 2.
        let yml = "\
pipelines:
    custom:
        alpha:
            - step:
                  script:
                      - echo alpha
        beta:
            - step:
                  script:
                      - echo beta
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["alpha".to_string(), "beta".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_missing_custom_section_is_empty() {
        // A default-only pipelines block (no custom:).
        let yml = "\
pipelines:
  default:
    - step:
        script:
          - echo hi
  branches:
    main:
      - step:
          script:
            - echo main
";
        assert!(parse_custom_pipeline_names(yml).is_empty());
    }

    #[test]
    fn custom_pipelines_empty_input_is_empty() {
        assert!(parse_custom_pipeline_names("").is_empty());
        assert!(parse_custom_pipeline_names("   \n\n# just a comment\n").is_empty());
    }

    #[test]
    fn custom_pipelines_inline_flow_custom_bails() {
        // A flow-style custom mapping we can't confidently read → vec![].
        let yml = "\
pipelines:
  custom: { w4-smoke: [] }
";
        assert!(parse_custom_pipeline_names(yml).is_empty());
    }

    #[test]
    fn custom_pipelines_do_not_collect_grandchildren() {
        // Deeper keys (step, name, script) under a pipeline name must NOT be collected;
        // only the immediate custom children (the pipeline names).
        let yml = "\
pipelines:
  custom:
    only-one:
      - step:
          name: A step named like a pipeline
          deployment: production
          script:
            - echo one
";
        assert_eq!(
            parse_custom_pipeline_names(yml),
            vec!["only-one".to_string()]
        );
    }

    #[test]
    fn custom_pipelines_bail_on_tab_indentation() {
        // Tabs in indentation make levels ambiguous → bail to vec![].
        let yml = "pipelines:\n\tcustom:\n\t\ta-pipe:\n\t\t\t- step:\n";
        assert!(parse_custom_pipeline_names(yml).is_empty());
    }

    #[test]
    fn custom_pipelines_stop_at_sibling_top_level_key() {
        // A top-level key after pipelines (e.g. `definitions:`) ends the custom block.
        let yml = "\
pipelines:
  custom:
    one:
      - step:
          script:
            - echo one
definitions:
  caches:
    node: node_modules
";
        assert_eq!(parse_custom_pipeline_names(yml), vec!["one".to_string()]);
    }

    // ── PR tasks ────────────────────────────────────────────────────────────────

    #[test]
    fn from_bb_task_maps_ids_as_strings_and_prefers_display_name() {
        let raw: BbTask = serde_json::from_str(
            r#"{
                "id": 67881206,
                "state": "RESOLVED",
                "content": {"raw": "fix the thing", "html": "<p>fix</p>"},
                "creator": {"uuid": "{c}", "display_name": "Cre Ator", "nickname": "cre"},
                "created_on": "2026-07-04T00:00:00Z",
                "resolved_by": {"uuid": "{r}", "nickname": "resolver"},
                "comment": {"id": 42, "links": {}},
                "links": {"html": {"href": "https://bitbucket.org/x/tasks/1"}}
            }"#,
        )
        .unwrap();
        let t = from_bb_task(raw);
        // Numeric ids serialize as Strings (u64-precision rule).
        assert_eq!(t.id, "67881206");
        assert_eq!(t.comment_id.as_deref(), Some("42"));
        assert_eq!(t.state, "RESOLVED");
        assert_eq!(t.text, "fix the thing");
        // Creator prefers display_name; resolver falls back to nickname (no display_name).
        assert_eq!(t.creator, "Cre Ator");
        assert_eq!(t.resolved_by.as_deref(), Some("resolver"));
        assert_eq!(t.url, "https://bitbucket.org/x/tasks/1");
    }

    #[test]
    fn from_bb_task_tolerates_missing_optional_fields() {
        let raw: BbTask = serde_json::from_str(r#"{"id": 5, "state": "UNRESOLVED"}"#).unwrap();
        let t = from_bb_task(raw);
        assert_eq!(t.id, "5");
        assert_eq!(t.text, "");
        assert_eq!(t.creator, "");
        assert!(t.resolved_by.is_none());
        assert!(t.comment_id.is_none());
        assert_eq!(t.url, "");
    }

    #[test]
    fn parse_task_id_rejects_non_numeric() {
        assert_eq!(parse_task_id("42").unwrap(), 42);
        assert!(matches!(
            parse_task_id("nope"),
            Err(AppError::InvalidArgument(_))
        ));
    }

    // ── Environments ────────────────────────────────────────────────────────────

    #[test]
    fn from_bb_environment_maps_type_and_admin_only() {
        let raw: BbRawEnvironment = serde_json::from_str(
            r#"{
                "uuid": "{e1}",
                "name": "Production",
                "environment_type": {"name": "Production", "rank": 2},
                "rank": 2,
                "hidden": true,
                "restrictions": {"admin_only": true}
            }"#,
        )
        .unwrap();
        let e = from_bb_environment(raw);
        assert_eq!(e.uuid, "{e1}");
        assert_eq!(e.name, "Production");
        assert_eq!(e.environment_type, "Production");
        assert_eq!(e.rank, 2);
        assert!(e.hidden);
        assert!(e.admin_only);
    }

    #[test]
    fn from_bb_environment_defaults_when_fields_missing() {
        let raw: BbRawEnvironment =
            serde_json::from_str(r#"{"uuid": "{e2}", "name": "Test"}"#).unwrap();
        let e = from_bb_environment(raw);
        assert_eq!(e.environment_type, "");
        assert_eq!(e.rank, 0);
        assert!(!e.hidden);
        // admin_only defaults to false when restrictions is absent.
        assert!(!e.admin_only);
    }

    #[test]
    fn draft_body_flips_state_and_echoes_reviewers() {
        let body = build_draft_body(true, &["{uuid-1}".to_string()]);
        assert_eq!(body["draft"], true);
        assert_eq!(body["reviewers"][0]["uuid"], "{uuid-1}");
        // Ready direction, no reviewers: the key is still PRESENT (empty array) —
        // omitting it would wipe reviewers on a PR that had them.
        let body = build_draft_body(false, &[]);
        assert_eq!(body["draft"], false);
        assert!(body["reviewers"].is_array());
        assert_eq!(body["reviewers"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn reviewers_body_maps_uuids_and_carries_nothing_else() {
        let body = build_reviewers_body(&["{a}".to_string(), "{b}".to_string()]);
        let reviewers = body["reviewers"].as_array().unwrap();
        assert_eq!(reviewers.len(), 2);
        assert_eq!(reviewers[0]["uuid"], "{a}");
        assert_eq!(reviewers[1]["uuid"], "{b}");
        // Only the reviewers field rides — title/description omitted are preserved
        // by Bitbucket's partial-update semantics (validated live).
        assert_eq!(body.as_object().unwrap().len(), 1);
    }

    #[test]
    fn reviewer_candidates_drop_author_and_uuidless_and_sort_by_label() {
        let members: Vec<BbUser> = serde_json::from_str(
            r#"[
                {"uuid":"{zed}","display_name":"Zed"},
                {"uuid":"{author}","display_name":"The Author"},
                {"display_name":"No Uuid"},
                {"uuid":"{amy}","nickname":"amy"},
                {"uuid":"{bob}","display_name":"bob"}
            ]"#,
        )
        .unwrap();
        let out = reviewer_candidates_from(members, "{author}");
        // Author + uuid-less dropped; case-insensitive label sort; label falls back
        // to nickname when display_name is absent.
        let labels: Vec<&str> = out.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, vec!["amy", "bob", "Zed"]);
        assert_eq!(out[0].id, "{amy}");
    }

    #[test]
    fn pr_reviewers_deserialize_from_the_reviewers_field() {
        let parsed: BbPr = serde_json::from_str(
            r#"{"id":4,"title":"t","state":"OPEN",
                "reviewers":[{"uuid":"{r1}","display_name":"Rev One"}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.reviewers.len(), 1);
        assert_eq!(parsed.reviewers[0].uuid.as_deref(), Some("{r1}"));
        assert_eq!(user_login(&parsed.reviewers[0]), "Rev One");
    }

    // ── Publish + repo management unit tests ────────────────────────────────────

    #[test]
    fn publish_body_omits_empty_description_and_website() {
        let body = build_publish_body(true, "", "");
        assert_eq!(body["scm"], "git");
        assert_eq!(body["is_private"], true);
        assert!(body.get("description").is_none());
        assert!(body.get("website").is_none());

        let body = build_publish_body(false, "A repo", "https://x.dev");
        assert_eq!(body["is_private"], false);
        assert_eq!(body["description"], "A repo");
        assert_eq!(body["website"], "https://x.dev");
    }

    #[test]
    fn repo_name_grammar_matches_slug_rules() {
        assert!(is_valid_repo_name("MyRepo"));
        assert!(is_valid_repo_name("my-repo_1.2"));
        assert!(is_valid_repo_name("a"));
        // Must start with a letter or digit.
        assert!(!is_valid_repo_name("-lead"));
        assert!(!is_valid_repo_name(".dot"));
        assert!(!is_valid_repo_name(""));
        // No spaces or slashes (the server would slugify, but we reject up front).
        assert!(!is_valid_repo_name("has space"));
        assert!(!is_valid_repo_name("ws/repo"));
    }

    #[test]
    fn branch_restriction_body_carries_full_shape_with_and_without_value() {
        // `require_approvals_to_merge` with a value.
        let body = build_branch_restriction_body("require_approvals_to_merge", "main", Some(1));
        assert_eq!(body["kind"], "require_approvals_to_merge");
        assert_eq!(body["branch_match_kind"], "glob");
        assert_eq!(body["pattern"], "main");
        assert!(body["users"].as_array().unwrap().is_empty());
        assert!(body["groups"].as_array().unwrap().is_empty());
        assert_eq!(body["value"], 1);

        // `push` with no value → value is explicit null (not omitted).
        let body = build_branch_restriction_body("push", "release/*", None);
        assert_eq!(body["kind"], "push");
        assert_eq!(body["pattern"], "release/*");
        assert!(body["value"].is_null());
    }

    #[test]
    fn branch_restriction_maps_numeric_id_to_string() {
        let raw: BbBranchRestrictionRaw = serde_json::from_str(
            r#"{"id":123456789,"kind":"push","pattern":"main","branch_match_kind":"glob","value":null}"#,
        )
        .unwrap();
        let r = from_bb_branch_restriction(raw);
        assert_eq!(r.id, "123456789");
        assert_eq!(r.kind, "push");
        assert_eq!(r.pattern, "main");
        assert_eq!(r.value, None);

        let raw: BbBranchRestrictionRaw = serde_json::from_str(
            r#"{"id":42,"kind":"require_approvals_to_merge","pattern":"main","branch_match_kind":"glob","value":2}"#,
        )
        .unwrap();
        let r = from_bb_branch_restriction(raw);
        assert_eq!(r.id, "42");
        assert_eq!(r.value, Some(2));
    }

    #[test]
    fn schedule_create_body_rides_ref_name_into_selector() {
        let body = build_schedule_create_body("main", "0 0 12 * * ?", true);
        assert_eq!(body["type"], "pipeline_schedule");
        assert_eq!(body["enabled"], true);
        assert_eq!(body["cron_pattern"], "0 0 12 * * ?");
        assert_eq!(body["target"]["type"], "pipeline_ref_target");
        assert_eq!(body["target"]["ref_type"], "branch");
        assert_eq!(body["target"]["ref_name"], "main");
        // The selector pattern MUST equal the ref_name (validated live).
        assert_eq!(body["target"]["selector"]["type"], "branches");
        assert_eq!(body["target"]["selector"]["pattern"], "main");
    }

    #[test]
    fn hook_body_carries_full_shape() {
        let input: BitbucketHookInput = serde_json::from_str(
            r#"{"description":"CI","url":"https://x.dev/h","active":true,
                "events":["repo:push","pullrequest:created"],"skipCertVerification":false}"#,
        )
        .unwrap();
        let body = build_hook_body(&input);
        assert_eq!(body["description"], "CI");
        assert_eq!(body["url"], "https://x.dev/h");
        assert_eq!(body["active"], true);
        assert_eq!(body["events"][0], "repo:push");
        assert_eq!(body["events"][1], "pullrequest:created");
        assert_eq!(body["skip_cert_verification"], false);
    }

    #[test]
    fn settings_mapping_absorbs_null_scalars() {
        // Bitbucket nulls description/website/language rather than omitting them.
        let raw: BbRepoSettingsRaw = serde_json::from_str(
            r#"{
                "name":"My Repo","slug":"my-repo","full_name":"ws/my-repo",
                "description":null,"website":null,"language":null,
                "is_private":true,"fork_policy":"no_public_forks",
                "mainbranch":{"name":"main"},
                "project":{"key":"PROJ","name":"Project X"},
                "links":{"html":{"href":"https://bitbucket.org/ws/my-repo"}}
            }"#,
        )
        .unwrap();
        let s = settings_from_repo(raw);
        assert_eq!(s.name, "My Repo");
        assert_eq!(s.slug, "my-repo");
        assert_eq!(s.description, "");
        assert_eq!(s.website, "");
        assert_eq!(s.language, "");
        assert!(s.is_private);
        assert_eq!(s.fork_policy, "no_public_forks");
        assert_eq!(s.main_branch, "main");
        assert_eq!(s.project_key, "PROJ");
        assert_eq!(s.project_name, "Project X");
        assert_eq!(s.web_url, "https://bitbucket.org/ws/my-repo");
    }

    #[test]
    fn visibility_probe_reads_is_private_and_errors_when_undeterminable() {
        // Present → decodes to the boolean.
        let private: BbRepoVisibility =
            serde_json::from_str(r#"{"is_private":true}"#).unwrap();
        assert_eq!(private.is_private, Some(true));
        let public: BbRepoVisibility =
            serde_json::from_str(r#"{"is_private":false}"#).unwrap();
        assert_eq!(public.is_private, Some(false));
        // Missing OR explicit null → None, so the command errors rather than
        // guessing "public" for a repo whose visibility we can't read.
        let missing: BbRepoVisibility = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(missing.is_private, None);
        let null: BbRepoVisibility =
            serde_json::from_str(r#"{"is_private":null}"#).unwrap();
        assert_eq!(null.is_private, None);
    }

    #[test]
    fn settings_update_body_conditionally_includes_forkpolicy_and_mainbranch() {
        let input = BitbucketRepoSettingsInput {
            description: "d".into(),
            website: "w".into(),
            language: "rust".into(),
            fork_policy: "allow_forks".into(),
            main_branch: "develop".into(),
        };
        let body = build_settings_update_body(&input);
        assert_eq!(body["description"], "d");
        assert_eq!(body["website"], "w");
        assert_eq!(body["language"], "rust");
        assert_eq!(body["fork_policy"], "allow_forks");
        assert_eq!(body["mainbranch"]["type"], "branch");
        assert_eq!(body["mainbranch"]["name"], "develop");

        // Empty fork_policy / main_branch are omitted (an empty repo has no branch).
        let input = BitbucketRepoSettingsInput {
            description: "d".into(),
            website: "".into(),
            language: "".into(),
            fork_policy: "".into(),
            main_branch: "".into(),
        };
        let body = build_settings_update_body(&input);
        assert!(body.get("fork_policy").is_none());
        assert!(body.get("mainbranch").is_none());
    }

    #[test]
    fn secured_pipeline_variable_hides_its_value() {
        // An unsecured variable keeps its value.
        let raw: BbPipelineVariableRaw = serde_json::from_str(
            r#"{"uuid":"{v1}","key":"PLAIN","value":"hello","secured":false}"#,
        )
        .unwrap();
        let v = from_bb_pipeline_variable(raw);
        assert_eq!(v.value.as_deref(), Some("hello"));
        assert!(!v.secured);

        // A secured variable forces value to None even if the JSON carried one.
        let raw: BbPipelineVariableRaw = serde_json::from_str(
            r#"{"uuid":"{v2}","key":"SECRET","secured":true}"#,
        )
        .unwrap();
        let v = from_bb_pipeline_variable(raw);
        assert_eq!(v.value, None);
        assert!(v.secured);
    }

    #[test]
    fn repo_admin_matches_slug_exactly_and_case_insensitively() {
        let repos = vec![
            BbRepoSlug { slug: "other".into() },
            BbRepoSlug { slug: "My-Repo".into() },
        ];
        // Exact.
        assert!(repo_admin_matches(&repos, "My-Repo"));
        // Case-insensitive.
        assert!(repo_admin_matches(&repos, "my-repo"));
        // Not present.
        assert!(!repo_admin_matches(&repos, "nope"));
        // Empty list = not an admin.
        assert!(!repo_admin_matches(&[], "my-repo"));
    }

    #[test]
    fn rename_rewrites_https_and_scp_origin_urls_preserving_scheme() {
        // HTTPS form.
        assert_eq!(
            rewritten_origin_url("https://bitbucket.org/ws/old.git", "ws", "new"),
            Some("https://bitbucket.org/ws/new.git".to_string())
        );
        // HTTPS with an embedded user (some clones carry one) — the rebuilt URL is
        // the canonical host form.
        assert_eq!(
            rewritten_origin_url("https://user@bitbucket.org/ws/old.git", "ws", "new"),
            Some("https://bitbucket.org/ws/new.git".to_string())
        );
        // scp-style SSH form keeps the user@host prefix.
        assert_eq!(
            rewritten_origin_url("git@bitbucket.org:ws/old.git", "ws", "new"),
            Some("git@bitbucket.org:ws/new.git".to_string())
        );
        // `ssh://` form with userinfo preserves the `git@` prefix.
        assert_eq!(
            rewritten_origin_url("ssh://git@bitbucket.org/ws/old.git", "ws", "new"),
            Some("ssh://git@bitbucket.org/ws/new.git".to_string())
        );
        // `ssh://` form without userinfo emits the bare host.
        assert_eq!(
            rewritten_origin_url("ssh://bitbucket.org/ws/old.git", "ws", "new"),
            Some("ssh://bitbucket.org/ws/new.git".to_string())
        );
        // A non-Bitbucket `ssh://` host must NOT be clobbered.
        assert_eq!(
            rewritten_origin_url("ssh://git@example.com/ws/old.git", "ws", "new"),
            None
        );
        // An unrecognized URL is left alone (None).
        assert_eq!(rewritten_origin_url("/local/path", "ws", "new"), None);
        // A non-Bitbucket https host (e.g. a corporate proxy) must NOT be clobbered.
        assert_eq!(
            rewritten_origin_url("https://git-proxy.corp.example.com/ws/old.git", "ws", "new"),
            None
        );
        // A non-Bitbucket scp host (github) must NOT be clobbered.
        assert_eq!(
            rewritten_origin_url("git@github.com:ws/old.git", "ws", "new"),
            None
        );
    }

    #[test]
    fn workspace_membership_carries_administrator_flag() {
        let page: BbWorkspacesPage = serde_json::from_str(
            r#"{"values":[
                {"administrator":true,"workspace":{"slug":"team-a"}},
                {"administrator":false,"workspace":{"slug":"team-b"}},
                {"administrator":true,"workspace":{"slug":""}},
                {"administrator":true}
            ]}"#,
        )
        .unwrap();
        let out: Vec<BitbucketWorkspace> = page
            .values
            .into_iter()
            .filter_map(|m| {
                let administrator = m.administrator;
                m.workspace
                    .map(|w| w.slug)
                    .filter(|s| !s.is_empty())
                    .map(|slug| BitbucketWorkspace { slug, administrator })
            })
            .collect();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].slug, "team-a");
        assert!(out[0].administrator);
        assert_eq!(out[1].slug, "team-b");
        assert!(!out[1].administrator);
    }

    #[test]
    fn hook_mapping_defaults_empty_events_and_flags() {
        let raw: BbHookRaw = serde_json::from_str(
            r#"{"uuid":"{h1}","description":"CI","url":"https://x.dev","active":true,
                "events":["repo:push"],"skip_cert_verification":false}"#,
        )
        .unwrap();
        let h = from_bb_hook(raw);
        assert_eq!(h.uuid, "{h1}");
        assert_eq!(h.events, vec!["repo:push".to_string()]);
        assert!(h.active);
        assert!(!h.skip_cert_verification);
    }
}
