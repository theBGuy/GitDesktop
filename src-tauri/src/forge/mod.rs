//! The provider abstraction — one neutral interface over GitHub, GitLab, and
//! Bitbucket so hosted features (PRs/MRs, issues, CI, settings) work regardless of
//! where a repo is hosted.
//!
//! Per `docs/multi-provider-support.md` (decisions locked 2026-06-29): GitHub stays
//! on `gh`, GitLab uses the `glab` CLI, and Bitbucket Cloud (not yet built) will use
//! direct HTTP — all behind the [`Forge`] trait. Each `forge_*` command dispatches
//! on the detected provider: the GitHub arm delegates to the existing `gh_*`
//! commands (byte-identical), the GitLab arm to `gitlab.rs`. Which features each
//! provider has wired up is declared in `model.rs::Implemented`.

pub mod bitbucket;
pub mod github;
pub mod gitlab;
pub mod glab;
pub mod http;
pub mod jira;
pub mod model;
pub mod session;

use crate::error::{AppError, AppResult};
use crate::forge::bitbucket::BitbucketForge;
use crate::forge::github::GitHubForge;
use crate::forge::gitlab::GitLabForge;
use crate::forge::model::{ForgeRepoList, ForgeStatus, Provider};

/// A hosted-git provider GitDesktop can talk to. One method per hosted capability;
/// the trait grows a method per phase (Phase 0 = `status` only). Called via static
/// dispatch over concrete impls, so there's no `dyn`/async-trait machinery.
#[allow(async_fn_in_trait)]
pub trait Forge {
    /// Whether the hosted integration is usable for this repo, on which host, as
    /// whom, and what it supports.
    async fn status(&self, repo_path: &str) -> AppResult<ForgeStatus>;
}

/// The host of a remote URL — both `https://host[:port]/…` and scp-style
/// `git@host:owner/…`. Lowercased; `None` when there's no parseable host (a local
/// path, say). Tolerates an optional `user@` and a `:port`.
pub(crate) fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    // `scheme://[user@]host[:port]/…` → strip the scheme; otherwise treat it as a
    // scp-like `[user@]host:path` and operate on the whole string.
    let rest = url.split_once("://").map_or(url, |(_, after)| after);
    // Drop an optional `user@` (rsplit so `user@host` keeps `host`).
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    // The host ends at the first `/` (path) or `:` (port / scp path separator).
    let host = rest.split(['/', ':']).next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// The `owner/name` (or `group/subgroup/name`) path of a remote URL — the part
/// after the host, with any `.git` suffix and surrounding slashes trimmed.
/// Complements [`remote_host`]; `None` when there's no path. Handles both
/// `https://host[:port]/path` and scp-style `git@host:path`: with a scheme a `:`
/// is a port (path starts after the next `/`), without one it's the scp path
/// separator. Used to address a repo on a provider's API (e.g. a GitLab project).
pub(crate) fn remote_path(url: &str) -> Option<String> {
    let url = url.trim();
    let (had_scheme, rest) = match url.split_once("://") {
        Some((_, after)) => (true, after),
        None => (false, url),
    };
    // Drop an optional `user@` (rsplit so `user@host` keeps `host`).
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let path = if had_scheme {
        // `host[:port]/path` → everything after the first `/`.
        rest.split_once('/').map(|(_, after)| after)?
    } else {
        // scp `host:path` → everything after the first `:`.
        rest.split_once(':').map(|(_, after)| after)?
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (!path.is_empty()).then(|| path.to_string())
}

/// Percent-encode a value for safe use inside an API query string, encoding
/// everything outside the RFC-3986 unreserved set. A value with a
/// query-significant byte (`&`, `#`, `?`, `=`, `%`, space, `/`, …) must be
/// encoded or it corrupts the query. Shared by the GitLab (`glab api`) and
/// Bitbucket (HTTP) providers, which both interpolate untrusted values (branch
/// names, search terms) into query strings.
pub(crate) fn encode_query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Route a remote host to a **non-GitHub** provider, but only when it's
/// unmistakably GitLab.com or Bitbucket Cloud. github.com, Enterprise servers,
/// and unknown hosts all return `None` — so the GitHub path runs and `gh`'s own
/// (Enterprise-aware) detection stays authoritative. Self-managed GitLab is the
/// one exception, resolved separately in [`detect_non_github`] via glab's own
/// signed-in host list (a custom domain is otherwise indistinguishable from
/// GitHub Enterprise).
fn provider_for_host(host: &str) -> Option<Provider> {
    match host {
        "gitlab.com" => Some(Provider::GitLab),
        "bitbucket.org" => Some(Provider::Bitbucket),
        _ => None,
    }
}

/// Detect a non-GitHub provider from the repo's `origin` remote, with its host.
/// Canonical hosts match directly; any other host glab is signed in to (the
/// `hosts:` keys of its config) is self-managed GitLab — glab carries per-host
/// auth, so every downstream `glab` call just works there. `None` (→ GitHub
/// path) when the `origin` URL can't be read (no remote, or any git error), is
/// unparseable, or the host is unrecognized — so GitHub stays the resilient
/// default and `gh`'s own detection decides readiness.
pub(crate) async fn detect_non_github(repo_path: &str) -> Option<(Provider, String)> {
    let url = crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string())
        .await
        .ok()?;
    let host = remote_host(&url)?;
    if let Some(p) = provider_for_host(&host) {
        return Some((p, host));
    }
    // Skip the config read for the overwhelmingly common case.
    if host == "github.com" {
        return None;
    }
    if glab::known_hosts().await.contains(&host) {
        return Some((Provider::GitLab, host));
    }
    None
}

/// The one-shot URL-scoped `-c credential.https://<host>.helper` entries to
/// authenticate a network op on `remote`, resolved to the provider CLI's ABSOLUTE
/// path. The provider comes from the REQUESTED remote's OWN host (not always
/// `origin`), so a cross-forge origin/upstream pair — e.g. an `origin` on GitLab
/// with a `github.com` `upstream` — each gets the right CLI's helper.
///
/// Entries are injected ONLY when the provider CLI is present AND has a stored
/// token/session for the remote's own host, and the injection is a `[reset,
/// helper]` PAIR: a blank reset entry (`credential.https://<host>.helper=`, empty
/// value) that SEVERS git's accumulated helper chain for that URL, followed by the
/// absolute-path CLI helper — the same pair `gh auth setup-git` writes. This makes
/// the network op deterministically use the same identity as the app's forge
/// surfaces, rather than falling through to whichever ambient helper answers first
/// (git stops at the first helper returning a complete credential — an earlier
/// `osxkeychain`/git-credential-manager entry holding a stale-but-valid credential
/// would otherwise shadow the CLI and 404 the wrong identity; that was the bug).
///
/// The gates prove a credential merely EXISTS, not that it WORKS, so a stale CLI
/// token could sever a working ambient chain (the inverse failure) —
/// [`crate::git::remote::run_git_mutating_with_creds`] covers that with a one-shot
/// ambient-fallback retry on an auth-class failure. Deliberate residual: the CLONE
/// path (the `extra_config` in `repo.rs`) keeps strict injection with NO fallback —
/// clone is user-initiated, clearly messaged, and re-runnable, and GitLab private
/// clone was always strict-injection.
///
/// Empty (→ git's ambient behavior, unchanged, so this never breaks a local, SSH,
/// or already-authenticated repo) for: SSH remotes (credential helpers don't
/// apply), Bitbucket (its push flow injects auth its own way), a repo with no such
/// remote, an unknown HTTPS host (the GitHub-default routing's gh gate injects the
/// pair ONLY when gh holds a token for that host — e.g. a signed-in GitHub
/// Enterprise host, which is what makes GHE work — and nothing otherwise), and —
/// fail open — when the provider CLI isn't installed OR is installed but has no
/// stored token/session for this host (ambient helpers like git-credential-manager
/// keep working for both).
pub async fn credential_config_for_remote(repo_path: &str, remote: &str) -> AppResult<Vec<String>> {
    let url = match crate::git::remote::git_remote_url(repo_path.to_string(), remote.to_string()).await
    {
        Ok(u) => u,
        Err(_) => return Ok(Vec::new()),
    };
    if !is_https_remote(&url) {
        return Ok(Vec::new()); // SSH → keys, not helpers
    }
    let Some(host) = remote_host(&url) else {
        return Ok(Vec::new());
    };
    // Classify by the requested remote's OWN host, reproducing `detect_non_github`'s
    // logic on `url` — identical when `remote == "origin"`, correct for other
    // remotes. The glab-known-hosts config read is skipped for canonical hosts and
    // github.com; only an unrecognized host reads it (as `detect_non_github` does).
    let provider = if host == "github.com" || provider_for_host(&host).is_some() {
        provider_for_remote_host(&host, &[])
    } else {
        // Any other host glab is signed in to is self-managed GitLab — mirrors detect_non_github.
        provider_for_remote_host(&host, &glab::known_hosts().await)
    };
    // Fail open when the CLI can't be resolved: a user with working ambient auth
    // (e.g. git-credential-manager) must not have every HTTPS fetch/pull/push hard-
    // fail just because gh/glab isn't installed.
    match provider {
        Some(Provider::GitLab) => Ok(gitlab::clone_credential_config(&url).await.unwrap_or_default()),
        Some(Provider::Bitbucket) => Ok(Vec::new()),
        _ => Ok(github::clone_credential_config(&url).await.unwrap_or_default()),
    }
}

/// The provider a remote's host maps to, mirroring [`detect_non_github`] but on an
/// arbitrary remote's host rather than always `origin`. Canonical hosts match
/// directly; any *other* host in `glab_hosts` (the hosts `glab` is signed in to) is
/// self-managed GitLab; `github.com`, GHE, and unknown hosts return `None` (→ the
/// app's gh-default routing). Pure/sync so it's unit-testable — the caller supplies
/// `glab_hosts` (empty when the host is canonical/github.com and the config read is
/// skipped).
fn provider_for_remote_host(host: &str, glab_hosts: &[String]) -> Option<Provider> {
    if let Some(p) = provider_for_host(host) {
        return Some(p);
    }
    if host != "github.com" && glab_hosts.iter().any(|h| h == host) {
        return Some(Provider::GitLab);
    }
    None
}

/// True when a remote URL uses HTTPS (credential helpers apply). SSH forms
/// (`git@host:…`, `ssh://…`) and others return false — as does plain `http://`,
/// since the helper entry we format keys on `credential.https://…` and would
/// never match an http remote anyway.
fn is_https_remote(url: &str) -> bool {
    url.trim().starts_with("https://")
}

/// The provider a host resolves to, as the lowercase tag the frontend keys
/// labels on (`"github"` / `"gitlab"` / `"bitbucket"`), or `None` for hosts the
/// app doesn't recognize (the UI treats those as GitHub, matching the routing
/// above). `glab_hosts` is [`glab::known_hosts`], passed in so batch callers
/// read the config once.
pub(crate) fn provider_tag_for_host(host: &str, glab_hosts: &[String]) -> Option<&'static str> {
    match provider_for_host(host) {
        Some(Provider::GitLab) => Some("gitlab"),
        Some(Provider::Bitbucket) => Some("bitbucket"),
        Some(Provider::GitHub) | None => {
            if host == "github.com" {
                Some("github")
            } else if glab_hosts.iter().any(|h| h == host) {
                Some("gitlab")
            } else {
                None
            }
        }
    }
}

/// Resolve a repo's hosted-integration status behind the provider abstraction.
/// GitLab/Bitbucket repos are recognized but report not-ready (their impls arrive
/// in Phases 1–4); everything else delegates to the GitHub impl, unchanged.
pub async fn resolve_status(repo_path: &str) -> AppResult<ForgeStatus> {
    if let Some((provider, host)) = detect_non_github(repo_path).await {
        return match provider {
            // GitLab probes glab for install/auth; Bitbucket probes the keyring
            // token + `/user` over HTTP. Both report their real readiness (unbuilt
            // panels degrade via the `implemented` flags).
            Provider::GitLab => GitLabForge::new(host).status(repo_path).await,
            Provider::Bitbucket => BitbucketForge::new(host).status(repo_path).await,
            Provider::GitHub => GitHubForge.status(repo_path).await,
        };
    }
    GitHubForge.status(repo_path).await
}

/// Provider-neutral hosted-integration status for a repo. The frontend gates
/// hosted features on this (and its `capabilities`) instead of a GitHub-only
/// readiness check. Phase 0: GitHub delegates to the existing gh-backed status.
#[tauri::command]
pub async fn forge_status(repo_path: String) -> AppResult<ForgeStatus> {
    resolve_status(&repo_path).await
}

// ── Bitbucket account (Settings → Accounts) ───────────────────────────────────
//
// Bitbucket Cloud has no CLI to carry credentials (unlike gh/glab), so its token
// is managed here: connect (validate + store), disconnect (clear), and read (the
// stored account, no network). The token is stored in the OS keyring and is NEVER
// returned to the frontend.

/// Connect a Bitbucket account: validate the Atlassian email + API token against
/// `GET /2.0/user` BEFORE persisting (nothing is stored if validation fails), then
/// keep email/token/username in the keyring. Returns the account info sans token.
#[tauri::command]
pub async fn forge_bb_set_account(
    email: String,
    token: String,
) -> AppResult<bitbucket::BbAccountInfo> {
    bitbucket::set_account(&email, &token).await
}

/// Disconnect the Bitbucket account (delete all stored entries; a missing entry is
/// tolerated).
#[tauri::command]
pub async fn forge_bb_clear_account() -> AppResult<()> {
    bitbucket::clear_account().await
}

/// The stored Bitbucket account, if any — a keyring existence read only (no
/// network). `None` when no token is stored.
#[tauri::command]
pub async fn forge_bb_account() -> AppResult<Option<bitbucket::BbAccountInfo>> {
    bitbucket::account().await
}

/// One Bitbucket pipeline step's log, by its `log_ref` (`"{pipeline_uuid}/{step_uuid}"`
/// with RAW braced UUIDs — the value a `RunJob.logRef` carries). Bitbucket steps have
/// no numeric id, so this is the step-log path (the numeric `forge_ci_job_logs` arm
/// errors for Bitbucket).
#[tauri::command]
pub async fn forge_bb_step_logs(repo_path: String, log_ref: String) -> AppResult<String> {
    bitbucket::step_logs(&repo_path, &log_ref).await
}

// ── Jira (linked issue provider) ───────────────────────────────────────────────
//
// Jira is a per-repo LINKED issue provider, orthogonal to the git-host detection every
// `forge_issue_*` command dispatches on: no repo has a Jira git remote, so Jira is
// never detected — it's configured. The frontend stores a per-repo `{site, projectKey}`
// link and passes `site`/`project_key` into these commands, keeping Rust stateless about
// linkage. Phase 1 is read-only. See `docs/jira-issue-integration.md`.

/// Connect a Jira account for a site: normalize + validate the site, validate the
/// (site, email, token) triple via `GET /rest/api/3/myself` BEFORE persisting (nothing
/// stored on failure), then keep email/token in the keyring under `forge/<site>/*`.
/// Returns the account info; the token is never returned.
#[tauri::command]
pub async fn jira_set_account(
    site: String,
    email: String,
    token: String,
) -> AppResult<jira::JiraAccountInfo> {
    jira::set_account(&site, &email, &token).await
}

/// Connect a Jira account for a site by REUSING the stored Bitbucket credentials
/// (Bitbucket Cloud shares the Atlassian API-token mechanism). Runs Rust-side because
/// tokens never cross IPC — the frontend can't read the Bitbucket token to pass it to
/// `jira_set_account`. Validates via `/myself` before persisting under the site host;
/// a 403 gets reuse-specific copy pointing at manual entry. The token is never returned.
#[tauri::command]
pub async fn jira_set_account_from_bitbucket(site: String) -> AppResult<jira::JiraAccountInfo> {
    jira::set_account_from_bitbucket(&site).await
}

/// The stored Jira account for a site (email only) — a keyring existence read (no
/// network). `None` when no token is stored.
#[tauri::command]
pub async fn jira_account(site: String) -> AppResult<Option<jira::JiraStoredAccount>> {
    jira::account(&site).await
}

/// Disconnect the Jira account for a site (delete both keyring entries; a missing entry
/// is tolerated).
#[tauri::command]
pub async fn jira_clear_account(site: String) -> AppResult<()> {
    jira::clear_account(&site).await
}

/// Validate the stored Jira creds for a site by probing `/myself` — distinct errors for
/// no-creds-stored / 401 / 403.
#[tauri::command]
pub async fn jira_validate(site: String) -> AppResult<jira::JiraAccountInfo> {
    jira::validate(&site).await
}

/// Search a site's Jira projects for the link picker (`GET
/// /rest/api/3/project/search`, single page).
#[tauri::command]
pub async fn jira_project_search(
    site: String,
    query: String,
) -> AppResult<Vec<jira::JiraProject>> {
    jira::project_search(&site, &query).await
}

/// A linked Jira project's issues. `state` ∈ `"open"` | `"closed"` | `"all"` (mapped
/// through `statusCategory`). One page of `POST /rest/api/3/search/jql`.
#[tauri::command]
pub async fn jira_issue_list(
    site: String,
    project_key: String,
    state: String,
) -> AppResult<Vec<jira::JiraIssueInfo>> {
    jira::issue_list(&site, &project_key, &state).await
}

/// Full details for one Jira issue's read view (ADF description + comments converted to
/// markdown).
#[tauri::command]
pub async fn jira_issue_view(site: String, key: String) -> AppResult<jira::JiraIssueDetails> {
    jira::issue_view(&site, &key).await
}

// ── Jira writes (phase 2) ──────────────────────────────────────────────────────

/// Add a comment to a Jira issue. `body_md` is markdown (converted to ADF Rust-side); a
/// whitespace-only body is rejected before any network call. Returns the created comment.
#[tauri::command]
pub async fn jira_issue_comment(
    site: String,
    key: String,
    body_md: String,
) -> AppResult<jira::JiraComment> {
    jira::issue_comment(&site, &key, &body_md).await
}

/// Close or reopen a Jira issue via its workflow. `direction` ∈ `"close"` | `"reopen"`.
/// Returns the issue's fresh status after the transition. Transition ids are per-project
/// workflow and are never hardcoded.
#[tauri::command]
pub async fn jira_issue_transition(
    site: String,
    key: String,
    direction: String,
) -> AppResult<jira::JiraTransitionResult> {
    jira::issue_transition(&site, &key, &direction).await
}

/// The full list of workflow transitions available for a Jira issue right now, for the
/// status picker (`GET /issue/<key>/transitions`, server order).
#[tauri::command]
pub async fn jira_issue_transitions(
    site: String,
    key: String,
) -> AppResult<Vec<jira::JiraTransitionOption>> {
    jira::issue_transitions(&site, &key).await
}

/// Execute a specific workflow transition on a Jira issue by its id (from
/// `jira_issue_transitions`). Returns the issue's fresh status after the transition.
#[tauri::command]
pub async fn jira_issue_transition_to(
    site: String,
    key: String,
    transition_id: String,
) -> AppResult<jira::JiraTransitionResult> {
    jira::issue_transition_to(&site, &key, &transition_id).await
}

/// Create a Jira issue. Needs `project_key`, `issue_type_id`, and a non-empty `summary`;
/// `description_md` (markdown → ADF) is optional. Returns the new issue's key + URL.
#[tauri::command]
pub async fn jira_issue_create(
    site: String,
    project_key: String,
    issue_type_id: String,
    summary: String,
    description_md: Option<String>,
) -> AppResult<jira::JiraCreatedIssue> {
    jira::issue_create(
        &site,
        &project_key,
        &issue_type_id,
        &summary,
        description_md.as_deref(),
    )
    .await
}

/// The available issue types for a project's create form (per-project `createmeta`
/// sub-endpoint). Returns all types including subtasks; the frontend filters.
#[tauri::command]
pub async fn jira_issue_types(
    site: String,
    project_key: String,
) -> AppResult<Vec<jira::JiraIssueType>> {
    jira::issue_types(&site, &project_key).await
}

/// Assign (or unassign) a Jira issue. `account_id = Some(id)` assigns; `None` unassigns.
#[tauri::command]
pub async fn jira_issue_assign(
    site: String,
    key: String,
    account_id: Option<String>,
) -> AppResult<()> {
    jira::issue_assign(&site, &key, account_id.as_deref()).await
}

/// Search users assignable to a Jira issue, for the assignee picker
/// (`GET /user/assignable/search`).
#[tauri::command]
pub async fn jira_user_search(
    site: String,
    key: String,
    query: String,
) -> AppResult<Vec<model::ForgeUserRef>> {
    jira::user_search(&site, &key, &query).await
}

/// The caller's per-project permissions, gating the Jira write actions
/// (`GET /rest/api/3/mypermissions`).
#[tauri::command]
pub async fn jira_permissions(
    site: String,
    project_key: String,
) -> AppResult<jira::JiraProjectPermissions> {
    jira::permissions(&site, &project_key).await
}

// ── Jira writes (phase 5): due date / priority / labels / comment edit-delete + pickers ──

/// The site's priorities for the priority picker (`GET /rest/api/3/priority`).
#[tauri::command]
pub async fn jira_priorities(site: String) -> AppResult<Vec<jira::JiraPriority>> {
    jira::priorities(&site).await
}

/// The site's labels for the labels picker (first page of `GET /rest/api/3/label`; the UI
/// filters client-side — no server query param exists).
#[tauri::command]
pub async fn jira_labels(site: String) -> AppResult<Vec<String>> {
    jira::labels(&site).await
}

/// Set (or clear) a Jira issue's due date. `due_date = Some("YYYY-MM-DD")` sets it; `None`
/// clears it. The date grammar is validated before any network call.
#[tauri::command]
pub async fn jira_issue_set_due_date(
    site: String,
    key: String,
    due_date: Option<String>,
) -> AppResult<()> {
    jira::issue_set_due_date(&site, &key, due_date.as_deref()).await
}

/// Set a Jira issue's priority by id (from `jira_priorities`).
#[tauri::command]
pub async fn jira_issue_set_priority(
    site: String,
    key: String,
    priority_id: String,
) -> AppResult<()> {
    jira::issue_set_priority(&site, &key, &priority_id).await
}

/// Replace a Jira issue's labels wholesale. Each label is validated (non-empty, no
/// whitespace) before any network call; an empty vec clears all labels.
#[tauri::command]
pub async fn jira_issue_set_labels(
    site: String,
    key: String,
    labels: Vec<String>,
) -> AppResult<()> {
    jira::issue_set_labels(&site, &key, &labels).await
}

/// Edit one of your own comments on a Jira issue. `body_md` is markdown (converted to ADF);
/// a whitespace-only body and a non-numeric comment id are rejected before any network
/// call. Returns the updated comment.
#[tauri::command]
pub async fn jira_comment_edit(
    site: String,
    key: String,
    comment_id: String,
    body_md: String,
) -> AppResult<jira::JiraComment> {
    jira::comment_edit(&site, &key, &comment_id, &body_md).await
}

/// Delete one of your own comments on a Jira issue.
#[tauri::command]
pub async fn jira_comment_delete(
    site: String,
    key: String,
    comment_id: String,
) -> AppResult<()> {
    jira::comment_delete(&site, &key, &comment_id).await
}

// ── Jira writes (phase 6): time tracking (estimates + worklogs) ──

/// Set (or clear) a Jira issue's original estimate. `estimate = Some("2d 4h")` sets it;
/// `None` clears it. The duration grammar is validated before any network call.
#[tauri::command]
pub async fn jira_issue_set_original_estimate(
    site: String,
    key: String,
    estimate: Option<String>,
) -> AppResult<()> {
    jira::issue_set_original_estimate(&site, &key, estimate.as_deref()).await
}

/// Set (or clear) a Jira issue's remaining estimate. `estimate = Some("2d 4h")` sets it;
/// `None` clears it. The duration grammar is validated before any network call.
#[tauri::command]
pub async fn jira_issue_set_remaining_estimate(
    site: String,
    key: String,
    estimate: Option<String>,
) -> AppResult<()> {
    jira::issue_set_remaining_estimate(&site, &key, estimate.as_deref()).await
}

/// Log work on a Jira issue. `time_spent` is a duration (e.g. "2d 4h 30m", validated before
/// any network call); `comment_md` is optional markdown (converted to ADF). Returns the
/// created worklog.
#[tauri::command]
pub async fn jira_worklog_add(
    site: String,
    key: String,
    time_spent: String,
    comment_md: Option<String>,
) -> AppResult<jira::JiraWorklog> {
    jira::worklog_add(&site, &key, &time_spent, comment_md.as_deref()).await
}

/// Edit one of your own worklog entries on a Jira issue. `comment_md = None` preserves the
/// existing note; a note can't be REMOVED via the API (an empty note is rejected). The
/// duration and the worklog id are validated before any network call. Returns the updated
/// worklog.
#[tauri::command]
pub async fn jira_worklog_update(
    site: String,
    key: String,
    worklog_id: String,
    time_spent: String,
    comment_md: Option<String>,
) -> AppResult<jira::JiraWorklog> {
    jira::worklog_update(&site, &key, &worklog_id, &time_spent, comment_md.as_deref()).await
}

/// Delete one of your own worklog entries on a Jira issue.
#[tauri::command]
pub async fn jira_worklog_delete(
    site: String,
    key: String,
    worklog_id: String,
) -> AppResult<()> {
    jira::worklog_delete(&site, &key, &worklog_id).await
}

/// The signed-in user's repositories on a provider, for the clone browser.
/// Dispatches by provider — GitHub via `gh`, GitLab via `glab`; Bitbucket isn't
/// implemented yet. Account-scoped (no repo path), unlike `forge_status`.
#[tauri::command]
pub async fn forge_list_repos(provider: Provider) -> AppResult<ForgeRepoList> {
    match provider {
        Provider::GitHub => github::list_repos().await,
        Provider::GitLab => gitlab::list_repos().await,
        Provider::Bitbucket => bitbucket::list_repos().await,
    }
}

/// Clone a repo, supplying provider auth that plain `git clone` lacks. A private
/// GitLab repo needs glab's token, injected as a ONE-SHOT `git -c` credential
/// helper (no persistent config, no token in the remote URL) — glab IS GitLab's
/// auth path here, so that arm stays strict. GitHub gets the same one-shot gh
/// helper when gh is present, but falls open to git's ambient auth when gh is
/// absent (public repos need none; a GCM user already has HTTPS auth), matching
/// how GitHub clone worked before this helper existed. Returns the path.
#[tauri::command]
pub async fn forge_clone(
    provider: Provider,
    url: String,
    parent_dir: String,
    dir_name: Option<String>,
) -> AppResult<String> {
    let extra = match provider {
        Provider::GitLab => gitlab::clone_credential_config(&url).await?,
        Provider::GitHub => github::clone_credential_config(&url).await.unwrap_or_default(),
        Provider::Bitbucket => Vec::new(),
    };
    crate::git::repo::clone_repo_core(&url, &parent_dir, dir_name, &extra).await
}

/// A repo's merge/pull requests, behind the provider abstraction. GitHub
/// delegates to the existing `gh pr list`; GitLab maps `glab` merge requests onto
/// the same neutral [`PrInfo`] shape. `state` is `"open"` or `"closed"` (closed
/// includes merged, matching the GitHub panel's Closed tab).
///
/// `lens` (the fork-identity Part B primitive — `None`/`Some("origin")`/
/// `Some("upstream")`) is threaded to the GitHub arm ONLY: it selects whether a
/// fork addresses its own PRs (origin) or the parent's (upstream). The GitLab and
/// Bitbucket arms deliberately do NOT receive the lens — their behavior is
/// byte-identical to today, and the frontend gates the lens UI to GitHub, so a
/// stray upstream lens on GitLab/Bitbucket simply reads as origin (acceptable v1).
/// This note stands for every `forge_*` PR/issue dispatcher below.
#[tauri::command]
pub async fn forge_pr_list(
    repo_path: String,
    state: String,
    limit: Option<u32>,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::list_prs(&repo_path, &state, limit).await,
        Some((Provider::Bitbucket, _)) => bitbucket::list_prs(&repo_path, &state, limit).await,
        _ => github::list_prs(&repo_path, &state, limit, lens).await,
    }
}

/// The rolled-up CI signal for a PR-list page, keyed by number — hydrates the row
/// icons SEPARATELY from `forge_pr_list` so a large repo's list never waits on (or
/// 504s expanding) per-check status. Provider-routed: GitHub queries its precomputed
/// `statusCheckRollup` by PR number, GitLab its MR `headPipeline.status` by iid (one
/// batched GraphQL call each), Bitbucket falls back to a per-commit statuses probe
/// keyed on each PR's `head_sha` (no batch endpoint). `sample_url` is any PR html url
/// from the same page — it fixes the repo the numbers belong to (load-bearing for
/// forks, where the list resolves to the parent while origin points at the fork).
/// Best-effort throughout: a PR whose status can't be fetched simply gets no icon.
#[tauri::command]
pub async fn forge_pr_list_ci(
    repo_path: String,
    prs: Vec<crate::github::pr::PrCiRefIn>,
    sample_url: String,
) -> AppResult<Vec<crate::github::pr::PrCiStatus>> {
    if prs.is_empty() {
        return Ok(Vec::new());
    }
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            let iids: Vec<u64> = prs.iter().map(|p| p.number).collect();
            gitlab::pr_list_ci(&repo_path, iids, &sample_url).await
        }
        Some((Provider::Bitbucket, _)) => bitbucket::pr_list_ci(&repo_path, &prs).await,
        _ => github::list_ci(&repo_path, &prs, &sample_url).await,
    }
}

/// A lightweight snapshot of the repo's recently-updated PRs for the notification
/// poller + remote pr-sync, behind the abstraction. GitHub delegates to the UNCHANGED
/// `gh_pr_poll`; GitLab/Bitbucket map their list responses onto the same neutral
/// [`PrPollInfo`](crate::github::pr::PrPollInfo). GitLab/Bitbucket carry no check
/// rollup or review decision in list responses, so those fields come back empty (a
/// documented v1 limit — the poller's checks/review notification branches never fire
/// there); `headSha` still drives pr-sync re-review.
#[tauri::command]
pub async fn forge_pr_poll(repo_path: String) -> AppResult<Vec<crate::github::pr::PrPollInfo>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::poll_prs(&repo_path).await,
        Some((Provider::Bitbucket, _)) => bitbucket::poll_prs(&repo_path).await,
        _ => github::poll_prs(&repo_path).await,
    }
}

/// The upstream lens is a GitHub-only fork affordance (Part B). Reject it before a
/// GitLab/Bitbucket dispatch so a stray upstream value can't be silently treated as
/// origin on those providers (the frontend gates the lens UI to GitHub anyway).
fn reject_upstream_on_non_github(lens: Option<&str>) -> AppResult<()> {
    if lens == Some("upstream") {
        return Err(AppError::InvalidArgument(
            "Creating a pull request on the upstream repository is currently supported for GitHub only.".into(),
        ));
    }
    Ok(())
}

/// Open merge/pull requests whose head is `head`, behind the abstraction — the
/// ComparePanel duplicate probe ("View" instead of "Create" once one exists).
/// `lens` is GitHub-only (see `forge_pr_list`).
#[tauri::command]
pub async fn forge_prs_for_branch(
    repo_path: String,
    head: String,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::PrInfo>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            reject_upstream_on_non_github(lens.as_deref())?;
            gitlab::prs_for_branch(&repo_path, &head).await
        }
        Some((Provider::Bitbucket, _)) => {
            reject_upstream_on_non_github(lens.as_deref())?;
            bitbucket::prs_for_branch(&repo_path, &head).await
        }
        _ => github::prs_for_branch(&repo_path, &head, lens).await,
    }
}

/// Full details for one merge/pull request's read view, behind the abstraction.
#[tauri::command]
pub async fn forge_pr_view(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrDetails> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::view_pr(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::view_pr(&repo_path, number).await,
        _ => github::view_pr(&repo_path, number, lens).await,
    }
}

/// The PR/MR activity timeline — state changes, label edits, approvals — behind the
/// abstraction. Each provider maps its own event source onto the neutral
/// `PrTimelineEventOut` union: GitHub `timelineItems`, GitLab resource/state/label
/// events + approval system-notes, Bitbucket PR `activity`. Events sort oldest→newest;
/// the frontend interleaves `pr.commits` itself, so no arm emits commit events.
#[tauri::command]
pub async fn forge_pr_timeline(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::PrTimelineEventOut>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::mr_timeline(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::pr_activity(&repo_path, number).await,
        _ => github::pr_timeline(&repo_path, number, lens.as_deref()).await,
    }
}

/// The unified diff for one merge/pull request, behind the abstraction.
#[tauri::command]
pub async fn forge_pr_diff(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::diff_pr(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::diff_pr(&repo_path, number).await,
        _ => github::diff_pr(&repo_path, number, lens).await,
    }
}

/// The unified diff of ONE commit within a merge/pull request, behind the
/// abstraction. GitHub uses the commit's `.diff` media type; GitLab rebuilds it
/// from the per-file commit-diff array; Bitbucket returns the raw commit diff.
#[tauri::command]
pub async fn forge_pr_commit_diff(
    repo_path: String,
    number: u64,
    oid: String,
) -> AppResult<String> {
    // `number` is part of the neutral contract (the diff is scoped to a PR in the
    // UI), but every provider addresses the commit by sha alone.
    let _ = number;
    // No lens param here (Part B): the commit is sha-addressed, and GitHub's
    // fork-network storage serves any network SHA via the fork's own endpoint, so an
    // origin/upstream distinction would make no difference to what's returned.
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::commit_diff(&repo_path, &oid).await,
        Some((Provider::Bitbucket, _)) => bitbucket::commit_diff(&repo_path, &oid).await,
        _ => github::commit_diff(&repo_path, &oid).await,
    }
}

/// A commit's comments, behind the abstraction. GitHub lists the commit-comments
/// REST endpoint; GitLab flattens its commit discussions (composite ids); Bitbucket
/// lists its commit comments.
#[tauri::command]
pub async fn forge_commit_comments(
    repo_path: String,
    sha: String,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::CommitCommentOut>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::commit_comments(&repo_path, &sha).await,
        Some((Provider::Bitbucket, _)) => bitbucket::commit_comments(&repo_path, &sha).await,
        _ => github::commit_comments(&repo_path, &sha, lens.as_deref()).await,
    }
}

/// Post a comment on a commit, behind the abstraction. Whole-commit =
/// `path`/`line`/`position` all `None`. GitHub anchored uses `path` + `position`
/// (the frontend computes `position`; `line` is ignored); GitLab and Bitbucket
/// anchored use `path` + `line`. `start_line` (a multi-line range) is honored on
/// GitLab only — GitHub and Bitbucket commit comments have no range concept, so
/// their branches ignore it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_commit_comment_create(
    repo_path: String,
    sha: String,
    body: String,
    path: Option<String>,
    line: Option<u64>,
    start_line: Option<u64>,
    position: Option<u64>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::commit_comment_create(
                &repo_path,
                &sha,
                &body,
                path.as_deref(),
                line,
                start_line,
            )
            .await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::commit_comment_create(&repo_path, &sha, &body, path.as_deref(), line).await
        }
        _ => {
            github::commit_comment_create(
                &repo_path,
                &sha,
                &body,
                path.as_deref(),
                position,
                lens.as_deref(),
            )
            .await
        }
    }
}

/// Edit a commit comment's body, behind the abstraction. `comment_id`: GitHub /
/// Bitbucket numeric-as-string; GitLab composite `"discussionId:noteId"`.
#[tauri::command]
pub async fn forge_commit_comment_edit(
    repo_path: String,
    sha: String,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::commit_comment_edit(&repo_path, &sha, &comment_id, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::commit_comment_edit(&repo_path, &sha, &comment_id, &body).await
        }
        // GitHub edits by comment id alone (sha unused, but kept for the neutral shape).
        _ => github::commit_comment_edit(&repo_path, &comment_id, &body).await,
    }
}

/// Delete a commit comment, behind the abstraction. Same `comment_id` carriage as
/// `forge_commit_comment_edit`.
#[tauri::command]
pub async fn forge_commit_comment_delete(
    repo_path: String,
    sha: String,
    comment_id: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::commit_comment_delete(&repo_path, &sha, &comment_id).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::commit_comment_delete(&repo_path, &sha, &comment_id).await
        }
        _ => github::commit_comment_delete(&repo_path, &comment_id).await,
    }
}

/// Third-party AI-reviewer findings on a merge/pull request (Copilot/CodeRabbit/…),
/// behind the abstraction. GitHub delegates unchanged (`gh_pr_external_reviews`);
/// GitLab maps MR discussion notes onto the same neutral shape; Bitbucket returns
/// an empty list by design — no third-party AI-reviewer ecosystem posts on
/// Bitbucket PRs, so there's nothing to harvest and no reason to hit the network.
/// The frontend decides which authors are AI reviewers and folds their findings
/// in as soft re-review context.
#[tauri::command]
pub async fn forge_pr_external_reviews(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::ExternalReviewItem>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::external_reviews(&repo_path, number).await,
        // By design: no bot-review ecosystem posts on Bitbucket PRs. Cheap,
        // permanent no-network empty — nothing to map.
        Some((Provider::Bitbucket, _)) => Ok(Vec::new()),
        _ => github::external_reviews(&repo_path, number, lens).await,
    }
}

/// File:line-anchored review threads on a merge/pull request, behind the
/// abstraction. GitHub maps `reviewThreads`; GitLab maps positioned MR
/// discussions; Bitbucket groups inline comments and their reply chains. Each
/// thread carries its full reply chain (oldest first).
#[tauri::command]
pub async fn forge_pr_review_threads(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::ReviewThreadOut>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::review_threads(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::review_threads(&repo_path, number).await,
        _ => github::review_threads(&repo_path, number, lens).await,
    }
}

/// Reply in an existing review thread, behind the abstraction. `thread_id` is the
/// provider's thread id (GitHub reviewThread node id / GitLab discussion id /
/// Bitbucket root comment id).
#[tauri::command]
pub async fn forge_pr_thread_reply(
    repo_path: String,
    number: u64,
    thread_id: String,
    body: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::reply_thread(&repo_path, number, &thread_id, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::reply_thread(&repo_path, number, &thread_id, &body).await
        }
        _ => github::reply_thread(&repo_path, &thread_id, &body).await,
    }
}

/// Create a NEW file:line-anchored review thread on a merge/pull request, behind
/// the abstraction. `side` is `"new"` (right/added) or `"old"` (left/removed).
/// `start_line` (a multi-line comment range) is honored on GitHub AND GitLab (both
/// send a real range); Bitbucket has no range API, so it anchors at the end `line`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_pr_thread_create(
    repo_path: String,
    number: u64,
    path: String,
    line: u64,
    side: String,
    start_line: Option<u64>,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::thread_create(&repo_path, number, &path, line, &side, start_line, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::thread_create(&repo_path, number, &path, line, &side, start_line, &body).await
        }
        _ => {
            github::thread_create(
                &repo_path,
                number,
                &path,
                line,
                &side,
                start_line,
                &body,
                lens.as_deref(),
            )
            .await
        }
    }
}

/// Submit a review on a merge/pull request — an optional summary + a batch of inline
/// comments + a verdict, behind the abstraction. `verdict` is `"comment"` /
/// `"approve"` / `"request_changes"`. GitHub submits atomically (one call); GitLab and
/// Bitbucket run sequentially and disclose partial state on failure. All
/// locally-checkable preconditions are validated HERE, before any remote call.
#[tauri::command]
pub async fn forge_pr_review_submit(
    repo_path: String,
    number: u64,
    verdict: String,
    summary: Option<String>,
    comments: Vec<crate::github::pr::DraftCommentIn>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::ReviewSubmitOut> {
    // Pre-mutation guards: verdict validity, and request_changes needs a summary.
    if !matches!(verdict.as_str(), "comment" | "approve" | "request_changes") {
        return Err(AppError::InvalidArgument(format!(
            "invalid review verdict: {verdict}"
        )));
    }
    if verdict == "request_changes" && summary.as_deref().map(str::trim).unwrap_or("").is_empty() {
        return Err(AppError::InvalidArgument(
            "A summary is required when requesting changes".into(),
        ));
    }
    let summary = summary.as_deref();
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::review_submit(&repo_path, number, &verdict, summary, &comments).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::review_submit(&repo_path, number, &verdict, summary, &comments).await
        }
        _ => {
            github::review_submit(&repo_path, number, &verdict, summary, &comments, lens.as_deref())
                .await
        }
    }
}

/// Resolve / unresolve a review thread, behind the abstraction. Bitbucket has no
/// thread-resolution surface wired (`mr_thread_resolve` false), so its arm errors.
#[tauri::command]
pub async fn forge_pr_thread_resolve(
    repo_path: String,
    number: u64,
    thread_id: String,
    resolved: bool,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::resolve_thread(&repo_path, number, &thread_id, resolved).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::resolve_thread(&repo_path, number, &thread_id, resolved).await
        }
        _ => github::resolve_thread(&repo_path, &thread_id, resolved).await,
    }
}

/// Post a comment on a merge/pull request, behind the abstraction. GitHub delegates
/// to `gh pr comment`; GitLab posts a note via `glab`. (Full reviews stay
/// GitHub-only — approve/merge/edit each have their own forge command.) `as_bot`
/// (optional — existing callers omit it) is honored only by the GitLab arm: when
/// `Some(true)` and a review-bot token is configured for this repo's GitLab host,
/// the note is authored by the project bot (else it falls back to the signed-in
/// user). GitHub/Bitbucket ignore the flag.
#[tauri::command]
pub async fn forge_pr_comment(
    repo_path: String,
    number: u64,
    body: String,
    as_bot: Option<bool>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::comment_mr(&repo_path, number, &body, as_bot.unwrap_or(false)).await
        }
        Some((Provider::Bitbucket, _)) => bitbucket::comment_pr(&repo_path, number, &body).await,
        _ => github::comment_pr(&repo_path, number, &body, lens).await,
    }
}

/// The configured GitLab review-bot login, if any (`Some(bot_login)` when a token is
/// stored). Account-scoped (no repo path); a keyring existence read only (no network).
/// gitlab.com scope (v1).
#[tauri::command]
pub async fn forge_gitlab_review_token_status() -> AppResult<Option<String>> {
    gitlab::review_token_status().await
}

/// Validate a GitLab review-bot token live, store it, and return the bot login. On
/// validation failure the error surfaces and nothing is stored. The token is never
/// logged or returned.
#[tauri::command]
pub async fn forge_gitlab_review_token_set(token: String) -> AppResult<String> {
    gitlab::review_token_set(token).await
}

/// Clear the stored GitLab review-bot token + login.
#[tauri::command]
pub async fn forge_gitlab_review_token_clear() -> AppResult<()> {
    gitlab::review_token_clear().await
}

/// Edit a merge/pull request conversation comment's body, behind the abstraction.
/// GitHub edits the IssueComment node (both PR and issue comments share the
/// mutation); GitLab PUTs the MR note; Bitbucket PUTs the PR comment. `comment_id`
/// is the id the thread already carries (GitHub node id / GitLab note id /
/// Bitbucket comment id). Gated on `implemented.mrCommentEdit`.
#[tauri::command]
pub async fn forge_pr_edit_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::edit_mr_comment(&repo_path, number, &comment_id, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::edit_pr_comment(&repo_path, number, &comment_id, &body).await
        }
        _ => github::edit_comment(&repo_path, &comment_id, &body).await,
    }
}

/// Delete a merge/pull request conversation comment, behind the abstraction. Same
/// `comment_id` carriage as `forge_pr_edit_comment`.
#[tauri::command]
pub async fn forge_pr_delete_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::delete_mr_comment(&repo_path, number, &comment_id).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::delete_pr_comment(&repo_path, number, &comment_id).await
        }
        _ => github::delete_comment(&repo_path, &comment_id).await,
    }
}

/// Edit a file:line-anchored review-THREAD comment's body, behind the abstraction.
/// Distinct from `forge_pr_edit_comment` (which edits flat conversation comments):
/// GitHub review comments are `PullRequestReviewComment` nodes with their own
/// mutation, so the GitHub arm calls a dedicated fn. GitLab positioned notes and
/// Bitbucket inline comments are the same objects as their conversation notes/
/// comments, so those arms reuse the existing note/comment endpoints. `comment_id`
/// is the id the review thread already carries. Gated on
/// `implemented.mrThreadCommentEdit`.
#[tauri::command]
pub async fn forge_pr_edit_review_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::edit_mr_comment(&repo_path, number, &comment_id, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::edit_pr_comment(&repo_path, number, &comment_id, &body).await
        }
        _ => github::edit_review_comment(&repo_path, &comment_id, &body).await,
    }
}

/// Delete a file:line-anchored review-thread comment, behind the abstraction. Same
/// `comment_id` carriage and per-provider routing as `forge_pr_edit_review_comment`.
#[tauri::command]
pub async fn forge_pr_delete_review_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::delete_mr_comment(&repo_path, number, &comment_id).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::delete_pr_comment(&repo_path, number, &comment_id).await
        }
        _ => github::delete_review_comment(&repo_path, &comment_id).await,
    }
}

/// Close a merge/pull request (not merge), behind the abstraction.
#[tauri::command]
pub async fn forge_pr_close(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::close_mr(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::decline_pr(&repo_path, number).await,
        _ => github::close_pr(&repo_path, number, lens).await,
    }
}

/// Reopen a closed (not merged) merge/pull request, behind the abstraction.
#[tauri::command]
pub async fn forge_pr_reopen(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::reopen_mr(&repo_path, number).await,
        // A declined Bitbucket PR can't be reopened via API or web (BCLOUD-4954). The
        // frontend hides the button; this is defense-in-depth.
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket declined pull requests can't be reopened.".into(),
        )),
        _ => github::reopen_pr(&repo_path, number, lens).await,
    }
}

/// Request changes on a merge/pull request (the blocking reviewer state), with a
/// comment. Wired for all three providers: GitLab/Bitbucket via their reviewer
/// APIs, GitHub through `gh pr review --request-changes` (`gh_pr_review`), which
/// requires a non-empty body. The frontend still gates its own control on
/// `implemented.mrRequestChanges` (false for GitHub, so it uses GitHub's native
/// Review menu there); this arm serves the MCP `request_changes` tool.
#[tauri::command]
pub async fn forge_pr_request_changes(
    repo_path: String,
    number: u64,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::request_changes_mr(&repo_path, number, &body).await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::request_changes_pr(&repo_path, number, &body).await
        }
        _ => crate::github::pr::gh_pr_review(
            repo_path,
            number,
            "request_changes".to_string(),
            body,
            lens,
        )
        .await,
    }
}

/// Revoke the viewer's requested-changes state. Bitbucket-only: its DELETE works on
/// every plan, so the control is a true toggle there — GitLab's direct undo is a
/// Premium feature (Free clears it by approving, or by dropping the reviewer on
/// GitLab), and GitHub reviews live in its own Review menu.
#[tauri::command]
pub async fn forge_pr_unrequest_changes(repo_path: String, number: u64) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::Bitbucket, _)) => {
            bitbucket::unrequest_changes_pr(&repo_path, number).await
        }
        Some((Provider::GitLab, _)) => Err(AppError::InvalidArgument(
            "GitLab can only revoke a change request on Premium — approve instead, or remove yourself as a reviewer on GitLab.".into(),
        )),
        _ => Err(AppError::InvalidArgument(
            "GitHub requests changes through the Review menu.".into(),
        )),
    }
}

/// Toggle a merge/pull request's draft state — wired for all three providers, each
/// via its own mechanism: Bitbucket PUTs `draft` both ways; GitLab shells
/// `glab mr update <iid> --ready|--draft` (a draft is a `Draft:` title prefix glab
/// manages); GitHub shells `gh pr ready [--undo]` — `draft = true` appends `--undo`
/// to convert an open PR back to a draft, `draft = false` marks a draft ready.
/// `lens` is GitHub-only (see `forge_pr_list`): it resolves a fork's PR against the
/// chosen remote; the Bitbucket/GitLab arms ignore it. gh's own error on plans that
/// don't support draft conversion passes through as the actionable message.
#[tauri::command]
pub async fn forge_pr_set_draft(
    repo_path: String,
    number: u64,
    draft: bool,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::Bitbucket, _)) => bitbucket::set_pr_draft(&repo_path, number, draft).await,
        Some((Provider::GitLab, _)) => gitlab::set_mr_draft(&repo_path, number, draft).await,
        // `draft = true` → convert back to draft (`gh pr ready --undo`); `false` →
        // mark ready. The GitHub arm maps draft-state to the gh `ready` flag.
        _ => crate::github::pr::gh_pr_set_ready(&repo_path, number, !draft, lens.as_deref()).await,
    }
}

/// Replace a merge/pull request's reviewer list (ids from
/// [`forge_pr_reviewer_candidates`]). The setter takes the FULL desired list; each
/// arm reconciles it to the provider's API (GitHub diffs add/remove, GitLab/BB
/// PUT the list). Wired for all three (`implemented.mr_reviewers`).
#[tauri::command]
pub async fn forge_pr_set_reviewers(
    repo_path: String,
    number: u64,
    reviewers: Vec<String>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::Bitbucket, _)) => {
            bitbucket::set_pr_reviewers(&repo_path, number, &reviewers).await
        }
        Some((Provider::GitLab, _)) => {
            gitlab::set_pr_reviewers(&repo_path, number, &reviewers).await
        }
        _ => github::set_pr_reviewers(&repo_path, number, &reviewers, lens.as_deref()).await,
    }
}

/// The reviewer picker's candidates for a PR — the members who can be requested,
/// minus the user the provider would reject. For an existing PR (`Some(number)`)
/// that's the PR author (GitHub/Bitbucket exclude them; GitLab tolerates it); at
/// create time (`None`, no PR yet) it's the viewer. GitHub: assignable users;
/// GitLab: project members; Bitbucket: workspace members.
#[tauri::command]
pub async fn forge_pr_reviewer_candidates(
    repo_path: String,
    number: Option<u64>,
    lens: Option<String>,
) -> AppResult<Vec<model::ForgeUserRef>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::Bitbucket, _)) => {
            bitbucket::reviewer_candidates(&repo_path, number).await
        }
        Some((Provider::GitLab, _)) => gitlab::reviewer_candidates(&repo_path, number).await,
        _ => github::reviewer_candidates(&repo_path, number, lens.as_deref()).await,
    }
}

/// Edit a merge/pull request's title/body, behind the abstraction — the shared
/// edit dialog. GitHub PATCHes the pull; GitLab PUTs title/description.
#[tauri::command]
pub async fn forge_pr_edit(
    repo_path: String,
    number: u64,
    title: String,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::edit_mr(&repo_path, number, &title, &body).await,
        Some((Provider::Bitbucket, _)) => {
            bitbucket::edit_pr(&repo_path, number, &title, &body).await
        }
        _ => github::edit_pr(&repo_path, number, &title, &body, lens).await,
    }
}

/// The viewer's + the MR's approval state, behind the abstraction. GitLab-only:
/// GitHub surfaces approval through the review flow (`reviewDecision` + the Review
/// menu), so its arm errors — the frontend gates this on `implemented.mrApprove`
/// (false for GitHub), so it's never reached there.
#[tauri::command]
pub async fn forge_pr_approvals(
    repo_path: String,
    number: u64,
) -> AppResult<crate::github::pr::ApprovalState> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::pr_approvals(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::pr_approvals(&repo_path, number).await,
        _ => Err(AppError::InvalidArgument(
            "GitHub surfaces approval through the review flow, not this control.".into(),
        )),
    }
}

/// Approve a merge/pull request (a bodyless reviewer action), behind the
/// abstraction. Wired for all three providers: GitLab/Bitbucket via their
/// reviewer APIs, GitHub through `gh pr review --approve` (`gh_pr_review`, no
/// body). The frontend still gates its own control on `implemented.mrApprove`
/// (false for GitHub, which uses its native review flow there); this arm serves
/// the MCP `approve_pull_request` tool.
#[tauri::command]
pub async fn forge_pr_approve(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::approve_pr(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::approve_pr(&repo_path, number).await,
        _ => crate::github::pr::gh_pr_review(
            repo_path,
            number,
            "approve".to_string(),
            String::new(),
            lens,
        )
        .await,
    }
}

/// Revoke the viewer's approval of a merge request, behind the abstraction.
/// GitLab-only.
#[tauri::command]
pub async fn forge_pr_unapprove(repo_path: String, number: u64) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::unapprove_pr(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => bitbucket::unapprove_pr(&repo_path, number).await,
        _ => Err(AppError::InvalidArgument(
            "GitHub approvals go through the review flow, not this control.".into(),
        )),
    }
}

/// Merge a merge/pull request, behind the abstraction. GitHub delegates to the
/// existing `gh pr merge` UNCHANGED (it has no `sha` guard, so it's dropped); GitLab
/// merges via `glab` — `merge`/`squash` only (no per-MR rebase) with an optional
/// head-`sha` stale-view guard. `strategy` is `merge`/`squash`/`rebase` (rebase is
/// GitHub-only; the GitLab arm rejects it).
///
/// Returns a [`PrMergeOutcome`](crate::github::pr::PrMergeOutcome). Its
/// `cleanup_warning` means the PR merged fine but the post-merge head-branch
/// cleanup failed — GitHub-only by construction: GitLab and Bitbucket fold
/// branch deletion into the atomic server-side merge, so their arms always
/// return a clean outcome (`cleanup_warning: None`). A merge *failure* is still
/// an `Err`.
#[tauri::command]
pub async fn forge_pr_merge(
    repo_path: String,
    number: u64,
    strategy: String,
    delete_branch: bool,
    sha: Option<String>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrMergeOutcome> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::merge_mr(
            &repo_path,
            number,
            &strategy,
            delete_branch,
            sha.as_deref(),
        )
        .await
        .map(|()| crate::github::pr::PrMergeOutcome::default()),
        // Bitbucket has no expected-hash guard, so `sha` is dropped.
        Some((Provider::Bitbucket, _)) => bitbucket::merge_pr(&repo_path, number, &strategy, delete_branch)
            .await
            .map(|()| crate::github::pr::PrMergeOutcome::default()),
        _ => crate::github::pr::gh_pr_merge(repo_path, number, strategy, delete_branch, lens).await,
    }
}

/// A repo's issues, behind the provider abstraction. GitHub delegates to the
/// existing `gh issue list`; GitLab maps `glab` issues onto the same neutral
/// [`IssueInfo`](crate::github::issue::IssueInfo). `state` is `"open"` or
/// `"closed"`.
#[tauri::command]
pub async fn forge_issue_list(
    repo_path: String,
    state: String,
    limit: Option<u32>,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::issue::IssueInfo>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::list_issues(&repo_path, &state, limit).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::list_issues(&repo_path, &state, limit, lens).await,
    }
}

/// Full details for one issue's read view, behind the abstraction.
#[tauri::command]
pub async fn forge_issue_view(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueDetails> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::view_issue(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::view_issue(&repo_path, number, lens).await,
    }
}

/// A repo's CI runs, behind the provider abstraction. GitHub delegates to
/// `gh run list`; GitLab maps `glab` pipelines onto the same neutral
/// [`WorkflowRun`](crate::github::actions::WorkflowRun). `limit` caps the count;
/// `branch` optionally scopes to one ref.
#[tauri::command]
pub async fn forge_ci_run_list(
    repo_path: String,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<crate::github::actions::WorkflowRun>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::list_runs(&repo_path, limit, branch).await,
        Some((Provider::Bitbucket, _)) => bitbucket::list_runs(&repo_path, limit, branch).await,
        _ => github::list_runs(&repo_path, limit, branch).await,
    }
}

/// One CI run with its jobs, behind the abstraction.
#[tauri::command]
pub async fn forge_ci_run_view(
    repo_path: String,
    run_id: u64,
) -> AppResult<crate::github::actions::RunDetail> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::view_run(&repo_path, run_id).await,
        Some((Provider::Bitbucket, _)) => bitbucket::view_run(&repo_path, run_id).await,
        _ => github::view_run(&repo_path, run_id).await,
    }
}

/// The failed jobs' logs for one CI run, behind the abstraction.
#[tauri::command]
pub async fn forge_ci_run_failed_logs(repo_path: String, run_id: u64) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::run_failed_logs(&repo_path, run_id).await,
        Some((Provider::Bitbucket, _)) => bitbucket::run_failed_logs(&repo_path, run_id).await,
        _ => github::run_failed_logs(&repo_path, run_id).await,
    }
}

/// One CI job's log, behind the abstraction.
#[tauri::command]
pub async fn forge_ci_job_logs(repo_path: String, job_id: u64) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::job_logs(&repo_path, job_id).await,
        // Bitbucket steps are addressed by braced UUID, not a numeric id — the
        // frontend fetches their logs via `forge_bb_step_logs` using RunJob.logRef.
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket step logs are fetched by step reference.".into(),
        )),
        _ => github::job_logs(&repo_path, job_id).await,
    }
}

/// Re-run a finished CI run, behind the abstraction. GitHub re-runs all jobs or
/// (`failed`) just the failed ones; GitLab's retry restarts failed + canceled jobs
/// only — its single semantic — so the GitLab arm ignores `failed` (the UI only
/// offers the retry button there; "re-run all" stays GitHub-only).
#[tauri::command]
pub async fn forge_ci_run_rerun(repo_path: String, run_id: u64, failed: bool) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::retry_run(&repo_path, run_id).await,
        // Bitbucket has no rerun-failed-only; a re-run re-triggers the run's branch.
        Some((Provider::Bitbucket, _)) => bitbucket::rerun_run(&repo_path, run_id).await,
        _ => github::rerun_run(&repo_path, run_id, failed).await,
    }
}

/// Cancel an in-flight CI run, behind the abstraction.
#[tauri::command]
pub async fn forge_ci_run_cancel(repo_path: String, run_id: u64) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::cancel_run(&repo_path, run_id).await,
        Some((Provider::Bitbucket, _)) => bitbucket::cancel_run(&repo_path, run_id).await,
        _ => github::cancel_run(&repo_path, run_id).await,
    }
}

/// Manually start a CI run, behind the abstraction. GitHub dispatches `workflow`
/// (id or file name) on `git_ref` with `inputs`; GitLab runs a new pipeline on the
/// ref with `inputs` as CI/CD variables — it has no per-workflow dispatch, so the
/// GitLab arm ignores `workflow` (the UI sends it empty there).
#[tauri::command]
pub async fn forge_ci_dispatch(
    repo_path: String,
    workflow: String,
    git_ref: String,
    inputs: std::collections::HashMap<String, String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::run_pipeline(&repo_path, &git_ref, &inputs).await,
        // Bitbucket triggers a branch pipeline; a non-empty `workflow` names a CUSTOM
        // pipeline (via a selector on the target), and `inputs` become pipeline variables.
        Some((Provider::Bitbucket, _)) => {
            bitbucket::dispatch_ci(&repo_path, &workflow, &git_ref, &inputs).await
        }
        _ => github::dispatch_ci(&repo_path, &workflow, &git_ref, inputs).await,
    }
}

/// A repo's releases (list view), behind the provider abstraction. GitHub delegates
/// to `gh release list`; GitLab maps `glab` releases onto the same neutral
/// [`ReleaseInfo`](crate::github::release::ReleaseInfo).
#[tauri::command]
pub async fn forge_release_list(
    repo_path: String,
) -> AppResult<Vec<crate::github::release::ReleaseInfo>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::list_releases(&repo_path).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::list_releases(&repo_path).await,
    }
}

/// Full details for one release's read view, by its tag, behind the abstraction.
#[tauri::command]
pub async fn forge_release_view(
    repo_path: String,
    tag: String,
) -> AppResult<crate::github::release::ReleaseDetails> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::view_release(&repo_path, &tag).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::view_release(&repo_path, &tag).await,
    }
}

/// Publish a release, behind the abstraction; returns its web URL. The
/// draft / prerelease / latest toggles are GitHub concepts — GitLab has none of
/// the three, so its arm drops them (the create dialog hides those fields there,
/// like the issue dialog's milestone/type).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_release_create(
    repo_path: String,
    tag: String,
    title: String,
    notes: String,
    target: String,
    prerelease: bool,
    draft: bool,
    latest: bool,
) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::create_release(&repo_path, &tag, &title, &notes, &target).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => {
            github::create_release(
                &repo_path, &tag, &title, &notes, &target, prerelease, draft, latest,
            )
            .await
        }
    }
}

/// Edit a release's title/notes (GitHub also its draft/prerelease/latest state),
/// behind the abstraction. The GitLab arm drops the GitHub-only toggles.
#[tauri::command]
pub async fn forge_release_edit(
    repo_path: String,
    tag: String,
    title: String,
    notes: String,
    prerelease: bool,
    draft: bool,
    latest: Option<bool>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::edit_release(&repo_path, &tag, &title, &notes).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::edit_release(&repo_path, &tag, &title, &notes, prerelease, draft, latest).await,
    }
}

/// Delete a release (optionally its git tag too), behind the abstraction.
#[tauri::command]
pub async fn forge_release_delete(
    repo_path: String,
    tag: String,
    cleanup_tag: bool,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::delete_release(&repo_path, &tag, cleanup_tag).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::delete_release(&repo_path, &tag, cleanup_tag).await,
    }
}

/// Upload a file as a release asset, behind the abstraction. GitHub attaches a
/// binary; GitLab uploads to the project and links it as a release asset (its
/// assets are links, so the row renders as a link — no size/download stats).
#[tauri::command]
pub async fn forge_release_upload_asset(
    repo_path: String,
    tag: String,
    file_path: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::upload_release_asset(&repo_path, &tag, &file_path).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::upload_release_asset(&repo_path, &tag, &file_path).await,
    }
}

/// Delete a release asset by its display name, behind the abstraction. GitLab
/// assets are links with server-side ids, so its arm resolves the name to the
/// link id first.
#[tauri::command]
pub async fn forge_release_delete_asset(
    repo_path: String,
    tag: String,
    asset_name: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::delete_release_asset(&repo_path, &tag, &asset_name).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket releases aren't supported yet.".into(),
        )),
        _ => github::delete_release_asset(&repo_path, &tag, &asset_name).await,
    }
}

/// Post a comment on an issue, behind the provider abstraction — the first GitLab
/// WRITE. GitHub delegates to `gh issue comment`; GitLab posts a note via `glab`.
#[tauri::command]
pub async fn forge_issue_comment(
    repo_path: String,
    number: u64,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::comment_issue(&repo_path, number, &body).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::comment_issue(&repo_path, number, &body, lens).await,
    }
}

/// Edit an issue conversation comment's body, behind the abstraction. GitHub edits
/// the IssueComment node (the same mutation the PR path uses); GitLab PUTs the
/// issue note; Bitbucket's tracker is being retired, so its arm errors. Gated on
/// `implemented.issueCommentEdit` (GitLab true; Bitbucket false; GitHub true).
#[tauri::command]
pub async fn forge_issue_edit_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
    body: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::edit_issue_comment(&repo_path, number, &comment_id, &body).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::edit_comment(&repo_path, &comment_id, &body).await,
    }
}

/// Delete an issue conversation comment, behind the abstraction. Same `comment_id`
/// carriage as `forge_issue_edit_comment`; Bitbucket's arm errors.
#[tauri::command]
pub async fn forge_issue_delete_comment(
    repo_path: String,
    number: u64,
    comment_id: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::delete_issue_comment(&repo_path, number, &comment_id).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::delete_comment(&repo_path, &comment_id).await,
    }
}

/// Close an issue, behind the abstraction. `reason` is GitHub's close reason
/// (`completed`/`not_planned`); GitLab has no close reason and ignores it.
#[tauri::command]
pub async fn forge_issue_close(
    repo_path: String,
    number: u64,
    reason: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::close_issue(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::close_issue(&repo_path, number, &reason, lens).await,
    }
}

/// Reopen a closed issue, behind the abstraction.
#[tauri::command]
pub async fn forge_issue_reopen(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::reopen_issue(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::reopen_issue(&repo_path, number, lens).await,
    }
}

/// Edit an issue's title/body, behind the abstraction — the shared edit dialog.
/// GitHub PATCHes the issue; GitLab PUTs title/description.
#[tauri::command]
pub async fn forge_issue_edit(
    repo_path: String,
    number: u64,
    title: String,
    body: String,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::edit_issue(&repo_path, number, &title, &body).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::edit_issue(&repo_path, number, &title, &body, lens).await,
    }
}

/// Lock an issue's conversation, behind the abstraction. GitHub locks with an
/// optional reason; GitLab's `discussion_locked` has none, so its arm ignores
/// `reason` (the UI hides the reason submenu per provider — a stray reason must
/// not fail the lock).
#[tauri::command]
pub async fn forge_issue_lock(
    repo_path: String,
    number: u64,
    reason: Option<String>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::lock_issue(&repo_path, number, true).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::lock_issue(&repo_path, number, reason, lens).await,
    }
}

/// Unlock an issue's conversation, behind the abstraction.
#[tauri::command]
pub async fn forge_issue_unlock(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::lock_issue(&repo_path, number, false).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::unlock_issue(&repo_path, number, lens).await,
    }
}

/// Transfer (GitHub) / move (GitLab) an issue to another repository, behind the
/// abstraction; returns the issue's new URL. `destination` is "owner/repo" on
/// GitHub, a full "group/name" project path on GitLab.
#[tauri::command]
pub async fn forge_issue_transfer(
    repo_path: String,
    number: u64,
    destination: String,
    lens: Option<String>,
) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::move_issue(&repo_path, number, &destination).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::transfer_issue(&repo_path, number, &destination, lens).await,
    }
}

/// Permanently delete an issue, behind the abstraction. Both providers restrict
/// this server-side (GitHub: admin/triage; GitLab: owner) — their errors
/// surface as-is.
#[tauri::command]
pub async fn forge_issue_delete(repo_path: String, number: u64, lens: Option<String>) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::delete_issue(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::delete_issue(&repo_path, number, lens).await,
    }
}

/// The repo's open/active milestones for the milestone picker, behind the
/// abstraction. The neutral `Milestone.number` is GitHub's milestone number or
/// GitLab's GLOBAL milestone id — whichever key that provider's write takes.
#[tauri::command]
pub async fn forge_milestones(
    repo_path: String,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::issue::Milestone>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::list_milestones(&repo_path).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket milestones aren't supported yet.".into(),
        )),
        _ => github::milestones(&repo_path, lens).await,
    }
}

/// Reactions for an issue + its comments, behind the abstraction. GitLab maps
/// award emoji onto the same shape (comments keyed by note id; GitHub keys them
/// by GraphQL node id — either way the id the thread already carries).
#[tauri::command]
pub async fn forge_issue_reactions(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueReactions> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::issue_reactions(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::issue_reactions(&repo_path, number, lens).await,
    }
}

/// Reactions for a merge/pull request + its comments, behind the abstraction.
#[tauri::command]
pub async fn forge_pr_reactions(
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<crate::github::issue::IssueReactions> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::mr_reactions(&repo_path, number).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket merge requests aren't supported yet.".into(),
        )),
        _ => github::pr_reactions(&repo_path, number, lens).await,
    }
}

/// Add the viewer's reaction, behind the abstraction. The subject is carried in
/// BOTH provider vocabularies (the shared-control different-identifiers rule):
/// GitHub uses `subject_id` (a GraphQL node id — body or comment) and ignores
/// `target`/`number`; GitLab uses `target` (`"issue"`/`"mr"`) + `number`, with
/// `subject_id` empty for the body or the note id for a comment. Discussions
/// (GitHub-only) ride the GitHub arm with `target: "discussion"`.
#[tauri::command]
pub async fn forge_add_reaction(
    repo_path: String,
    target: String,
    number: u64,
    subject_id: String,
    content: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            let note_id = (!subject_id.is_empty()).then_some(subject_id.as_str());
            gitlab::add_reaction(&repo_path, &target, number, note_id, &content).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket Cloud has no reactions.".into(),
        )),
        _ => github::add_reaction(&repo_path, &subject_id, &content).await,
    }
}

/// Remove the viewer's reaction, behind the abstraction (same subject carriage
/// as `forge_add_reaction`; GitLab resolves the award id server-side).
#[tauri::command]
pub async fn forge_remove_reaction(
    repo_path: String,
    target: String,
    number: u64,
    subject_id: String,
    content: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            let note_id = (!subject_id.is_empty()).then_some(subject_id.as_str());
            gitlab::remove_reaction(&repo_path, &target, number, note_id, &content).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket Cloud has no reactions.".into(),
        )),
        _ => github::remove_reaction(&repo_path, &subject_id, &content).await,
    }
}

/// Set (or, with `None`, clear) an issue's milestone, behind the abstraction.
/// `milestone` is whatever `forge_milestones` returned as `number` for the
/// chosen entry.
#[tauri::command]
pub async fn forge_issue_set_milestone(
    repo_path: String,
    number: u64,
    milestone: Option<u64>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::set_issue_milestone(&repo_path, number, milestone).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => github::set_issue_milestone(&repo_path, number, milestone, lens).await,
    }
}

/// The repo's labels for the label picker, behind the abstraction. GitHub lists them
/// via GraphQL (each with a node id); GitLab lists project labels via `glab` (by name,
/// no id). Used by both the issue and MR label pickers.
#[tauri::command]
pub async fn forge_repo_labels(
    repo_path: String,
    lens: Option<String>,
) -> AppResult<Vec<crate::github::pr::RepoLabel>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_labels(&repo_path).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket labels aren't supported yet.".into(),
        )),
        _ => github::repo_labels(&repo_path, lens).await,
    }
}

/// The repo's assignable users for the assignee picker, behind the abstraction.
/// GitHub lists repo assignees (avatar login-derived); GitLab lists project members
/// (with their avatars). Returns `ForgeUserRef`s so the picker renders avatars.
#[tauri::command]
pub async fn forge_assignable_users(
    repo_path: String,
    lens: Option<String>,
) -> AppResult<Vec<model::ForgeUserRef>> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::assignable_users(&repo_path).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket assignees aren't supported yet.".into(),
        )),
        _ => github::assignable_users(&repo_path, lens).await,
    }
}

/// Add/remove labels on an issue or merge/pull request, behind the abstraction. A
/// SHARED control: GitHub keys labels by GraphQL node id (`add_ids`/`remove_ids` on
/// the `labelable_id`); GitLab keys them by name (`add_names`/`remove_names` on the
/// numeric `number`). `target` is `"issue"` or `"mr"`. The caller passes both id and
/// name deltas so each provider takes the pair it addresses by.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_edit_labels(
    repo_path: String,
    target: String,
    number: u64,
    labelable_id: String,
    add_ids: Vec<String>,
    remove_ids: Vec<String>,
    add_names: Vec<String>,
    remove_names: Vec<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::edit_labels(&repo_path, &target, number, &add_names, &remove_names).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket labels aren't supported yet.".into(),
        )),
        _ => github::edit_labels(&repo_path, &labelable_id, add_ids, remove_ids).await,
    }
}

/// Set an issue's assignees (the full desired set, by login), behind the abstraction.
/// GitHub PATCHes the issue with the login set; GitLab resolves logins→ids and PUTs
/// `assignee_ids`.
#[tauri::command]
pub async fn forge_issue_set_assignees(
    repo_path: String,
    number: u64,
    assignees: Vec<String>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::set_issue_assignees(&repo_path, number, &assignees).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket assignees aren't supported yet.".into(),
        )),
        _ => github::set_issue_assignees(&repo_path, number, assignees, lens).await,
    }
}

/// Set a merge/pull request's assignees, behind the abstraction. GitHub PRs are
/// issues under the hood, so the GitHub arm PATCHes the issues endpoint with the
/// login set (reusing the issue assignee-set path — a PR number is valid there);
/// GitLab resolves logins→ids and PUTs `assignee_ids`. Gated on
/// `implemented.mrAssignees` (GitHub true, GitLab true, Bitbucket false).
#[tauri::command]
pub async fn forge_mr_set_assignees(
    repo_path: String,
    number: u64,
    assignees: Vec<String>,
    lens: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::set_mr_assignees(&repo_path, number, &assignees).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket assignees aren't supported yet.".into(),
        )),
        // A PR number addresses the same issues endpoint (PRs are issues on GitHub).
        _ => github::set_issue_assignees(&repo_path, number, assignees, lens).await,
    }
}

/// Create an issue, behind the abstraction. Returns the new number + URL.
/// GitHub sends the full field set; GitLab takes everything but the org issue
/// type (no GitLab analogue — the dialog hides that picker, and the dispatch
/// drops it like `forge_issue_close` drops the GitHub-only close reason).
/// `milestone` is whatever `forge_milestones` returned as `number`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_issue_create(
    repo_path: String,
    title: String,
    body: String,
    labels: Vec<String>,
    assignees: Vec<String>,
    milestone: Option<u64>,
    issue_type: Option<String>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrRef> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab::create_issue(&repo_path, &title, &body, &labels, &assignees, milestone).await
        }
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket issues aren't supported yet.".into(),
        )),
        _ => {
            github::create_issue(
                &repo_path, &title, &body, labels, assignees, milestone, issue_type, lens,
            )
            .await
        }
    }
}

/// The repo's web URL for "View on GitHub/GitLab", behind the abstraction.
#[tauri::command]
pub async fn forge_repo_url(repo_path: String) -> AppResult<String> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_url(&repo_path).await,
        Some((Provider::Bitbucket, _)) => bitbucket::repo_url(&repo_path).await,
        _ => github::repo_url(&repo_path).await,
    }
}

/// Whether the signed-in viewer has starred this repo, behind the abstraction.
#[tauri::command]
pub async fn forge_repo_star_status(repo_path: String) -> AppResult<bool> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_star_status(&repo_path).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket repositories aren't supported yet.".into(),
        )),
        _ => github::repo_star_status(&repo_path).await,
    }
}

/// Star / unstar this repo, behind the abstraction.
#[tauri::command]
pub async fn forge_repo_set_star(repo_path: String, starred: bool) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_set_star(&repo_path, starred).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket repositories aren't supported yet.".into(),
        )),
        _ => github::repo_set_star(&repo_path, starred).await,
    }
}

/// Canonicalize a provider's raw visibility string to one of the three neutral
/// values (`public` / `private` / `internal`), case-insensitively — gh emits
/// uppercase, GitLab lowercase. An unrecognized/empty value maps to `None` so
/// the caller errors rather than passing a guessed value to the UI.
fn normalize_visibility(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "public" => Some("public"),
        "private" => Some("private"),
        "internal" => Some("internal"),
        _ => None,
    }
}

/// A provider's raw visibility probe result: the un-normalized visibility string
/// plus fork provenance, gathered in a SINGLE round-trip (each provider already
/// fetches the whole repo/project record, so fork-ness rides along for free —
/// never a second API call). `is_fork` is set only on positive API evidence; a
/// provider that can't say (no field, error) reports `false` + `parent: None`,
/// so the absence of a badge never lies.
pub struct RepoVisibilityRaw {
    pub visibility: String,
    pub is_fork: bool,
    /// The upstream repo as an `owner/repo` slug when the API supplies it; `None`
    /// when it's a fork but the parent slug isn't available.
    pub parent: Option<String>,
}

/// The normalized visibility probe result the frontend consumes — the canonical
/// visibility string plus fork provenance (camelCase over IPC). Backfilled onto
/// the recent-repo record alongside `visibility` and cleared with it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoVisibilityOut {
    pub visibility: String,
    pub is_fork: bool,
    pub parent: Option<String>,
}

/// The repo's remote visibility (`public` / `private` / `internal`) plus whether
/// it's a fork, behind the abstraction — for badging the repo list. Every arm
/// returns a raw provider result whose visibility is canonicalized here; an
/// undeterminable visibility (no remote, CLI/API failure, unrecognized payload)
/// errors rather than guessing. Fork-ness is best-effort: a provider that can't
/// report it yields `is_fork: false` (never a guess), so absence of the badge is
/// always honest.
#[tauri::command]
pub async fn forge_repo_visibility(repo_path: String) -> AppResult<RepoVisibilityOut> {
    let raw = match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_visibility(&repo_path).await?,
        Some((Provider::Bitbucket, _)) => bitbucket::repo_visibility(&repo_path).await?,
        _ => github::repo_visibility(&repo_path).await?,
    };
    let visibility = normalize_visibility(&raw.visibility)
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::InvalidArgument(format!("unrecognized visibility: {}", raw.visibility))
        })?;
    Ok(RepoVisibilityOut {
        visibility,
        is_fork: raw.is_fork,
        parent: raw.parent,
    })
}

// ── Repository settings & lifecycle ──────────────────────────────────────────

/// Whether the signed-in viewer can manage this repo's settings (`admin`), and
/// whether they hold the owner-only lifecycle powers (`owner`). GitHub's admin
/// role implies both; GitLab distinguishes Maintainer (settings) from Owner
/// (transfer / delete / archive).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepoAdmin {
    pub admin: bool,
    pub owner: bool,
}

/// The settings-management probe, behind the abstraction — gates the
/// "Repository settings…" surface.
#[tauri::command]
pub async fn forge_repo_admin(repo_path: String) -> AppResult<ForgeRepoAdmin> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            let (admin, owner) = gitlab::repo_admin(&repo_path).await?;
            Ok(ForgeRepoAdmin { admin, owner })
        }
        Some((Provider::Bitbucket, _)) => {
            // Bitbucket has no owner/admin distinction here (role=owner matched 0
            // even for an admin), so owner := admin.
            let admin = bitbucket::repo_admin(&repo_path).await?;
            Ok(ForgeRepoAdmin {
                admin,
                owner: admin,
            })
        }
        _ => {
            let admin = crate::github::repo_settings::gh_repo_admin(repo_path).await?;
            Ok(ForgeRepoAdmin {
                admin,
                owner: admin,
            })
        }
    }
}

/// The GitLab project-settings read. GitLab-only — its settings model (feature
/// access levels, one merge-method enum, a squash option) doesn't map onto
/// GitHub's `RepoSettings`, so each provider keeps its own shaped surface
/// (GitHub stays on `gh_repo_settings_get`).
#[tauri::command]
pub async fn forge_gl_repo_settings(repo_path: String) -> AppResult<gitlab::GitLabRepoSettings> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::repo_settings(&repo_path).await,
        _ => Err(AppError::InvalidArgument(
            "this repo isn't hosted on GitLab.".into(),
        )),
    }
}

/// Batch-save the GitLab project settings (the General section's Save).
#[tauri::command]
pub async fn forge_gl_repo_settings_update(
    repo_path: String,
    input: gitlab::GitLabRepoSettingsInput,
) -> AppResult<gitlab::GitLabRepoSettings> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::update_repo_settings(&repo_path, input).await,
        _ => Err(AppError::InvalidArgument(
            "this repo isn't hosted on GitLab.".into(),
        )),
    }
}

/// The GitLab-only settings sub-surfaces (Members, Webhooks, CI/CD variables).
/// Each guards on the detected provider like `forge_gl_repo_settings` — the
/// GitHub dialog keeps its own gh-backed sections.
macro_rules! gl_only {
    ($repo_path:expr, $call:expr) => {
        match detect_non_github(&$repo_path).await {
            Some((Provider::GitLab, _)) => $call.await,
            _ => Err(AppError::InvalidArgument(
                "this repo isn't hosted on GitLab.".into(),
            )),
        }
    };
}

/// The Bitbucket-only settings sub-surfaces (repo settings, default reviewers,
/// branch restrictions, pipelines config/variables/schedules, webhooks). Mirrors
/// [`gl_only!`] — each guards on the detected provider being Bitbucket.
macro_rules! bb_only {
    ($repo_path:expr, $call:expr) => {
        match detect_non_github(&$repo_path).await {
            Some((Provider::Bitbucket, _)) => $call.await,
            _ => Err(AppError::InvalidArgument(
                "this repo isn't hosted on Bitbucket.".into(),
            )),
        }
    };
}

/// Mark an issue confidential (members-only) or public again. GitLab-unique —
/// GitHub has no confidential-issue concept, so this is `gl_only` rather than a
/// neutral `forge_issue_*` dispatch.
#[tauri::command]
pub async fn forge_gl_issue_set_confidential(
    repo_path: String,
    number: u64,
    confidential: bool,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::set_issue_confidential(&repo_path, number, confidential)
    )
}

/// Set (`Some("YYYY-MM-DD")`) or clear an issue's due date. GitLab-unique —
/// GitHub issues have no due dates.
#[tauri::command]
pub async fn forge_gl_issue_set_due_date(
    repo_path: String,
    number: u64,
    due_date: Option<String>,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::set_issue_due_date(&repo_path, number, due_date.as_deref())
    )
}

#[tauri::command]
pub async fn forge_gl_members(repo_path: String) -> AppResult<Vec<gitlab::GitLabMember>> {
    gl_only!(repo_path, gitlab::list_members(&repo_path))
}

#[tauri::command]
pub async fn forge_gl_member_add(
    repo_path: String,
    username: String,
    access_level: u8,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::add_member(&repo_path, &username, access_level)
    )
}

#[tauri::command]
pub async fn forge_gl_member_update(
    repo_path: String,
    user_id: String,
    access_level: u8,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::update_member(&repo_path, &user_id, access_level)
    )
}

#[tauri::command]
pub async fn forge_gl_member_remove(repo_path: String, user_id: String) -> AppResult<()> {
    gl_only!(repo_path, gitlab::remove_member(&repo_path, &user_id))
}

#[tauri::command]
pub async fn forge_gl_hooks(repo_path: String) -> AppResult<Vec<gitlab::GitLabHook>> {
    gl_only!(repo_path, gitlab::list_hooks(&repo_path))
}

#[tauri::command]
pub async fn forge_gl_hook_create(
    repo_path: String,
    input: gitlab::GitLabHookInput,
) -> AppResult<()> {
    gl_only!(repo_path, gitlab::create_hook(&repo_path, input))
}

#[tauri::command]
pub async fn forge_gl_hook_update(
    repo_path: String,
    hook_id: String,
    input: gitlab::GitLabHookInput,
) -> AppResult<()> {
    gl_only!(repo_path, gitlab::update_hook(&repo_path, &hook_id, input))
}

#[tauri::command]
pub async fn forge_gl_hook_delete(repo_path: String, hook_id: String) -> AppResult<()> {
    gl_only!(repo_path, gitlab::delete_hook(&repo_path, &hook_id))
}

#[tauri::command]
pub async fn forge_gl_hook_test(
    repo_path: String,
    hook_id: String,
    trigger: String,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::test_hook(&repo_path, &hook_id, &trigger)
    )
}

#[tauri::command]
pub async fn forge_gl_hook_events(
    repo_path: String,
    hook_id: String,
) -> AppResult<Vec<gitlab::GitLabHookDelivery>> {
    gl_only!(repo_path, gitlab::hook_events(&repo_path, &hook_id))
}

#[tauri::command]
pub async fn forge_gl_hook_resend(
    repo_path: String,
    hook_id: String,
    event_id: String,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::hook_event_resend(&repo_path, &hook_id, &event_id)
    )
}

#[tauri::command]
pub async fn forge_gl_variables(repo_path: String) -> AppResult<Vec<gitlab::GitLabVariable>> {
    gl_only!(repo_path, gitlab::list_variables(&repo_path))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per form field, IPC-shaped
pub async fn forge_gl_variable_set(
    repo_path: String,
    key: String,
    value: String,
    protected: bool,
    masked: bool,
    create: bool,
    scope: String,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::set_variable(&repo_path, &key, &value, protected, masked, create, &scope)
    )
}

#[tauri::command]
pub async fn forge_gl_variable_delete(
    repo_path: String,
    key: String,
    scope: String,
) -> AppResult<()> {
    gl_only!(repo_path, gitlab::delete_variable(&repo_path, &key, &scope))
}

/// The repo's protected branches, with per-action push/merge access levels.
#[tauri::command]
pub async fn forge_gl_protected_branches(
    repo_path: String,
) -> AppResult<Vec<gitlab::GitLabProtectedBranch>> {
    gl_only!(repo_path, gitlab::list_protected_branches(&repo_path))
}

/// Protect a branch (or wildcard). Access levels are the Free-tier set {0, 30, 40}.
#[tauri::command]
pub async fn forge_gl_protected_branch_create(
    repo_path: String,
    name: String,
    push_access_level: u8,
    merge_access_level: u8,
    allow_force_push: bool,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::create_protected_branch(
            &repo_path,
            &name,
            push_access_level,
            merge_access_level,
            allow_force_push,
        )
    )
}

/// Update a protection. Only `allow_force_push` takes effect on Free tier.
#[tauri::command]
pub async fn forge_gl_protected_branch_update(
    repo_path: String,
    name: String,
    allow_force_push: bool,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::update_protected_branch(&repo_path, &name, allow_force_push)
    )
}

/// Remove a branch protection.
#[tauri::command]
pub async fn forge_gl_protected_branch_delete(repo_path: String, name: String) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::delete_protected_branch(&repo_path, &name)
    )
}

/// Project paths the viewer is a member of on THIS repo's host — the Move
/// dialog's destination suggestions (host-correct for self-managed, unlike the
/// account-scoped clone-browser listing).
#[tauri::command]
pub async fn forge_gl_member_projects(repo_path: String) -> AppResult<Vec<String>> {
    gl_only!(repo_path, gitlab::member_projects(&repo_path))
}

/// Read a merge request's auto-merge state (armed flag, detailed merge status,
/// head-pipeline summary). GitLab-only — the frontend gates the auto-merge
/// affordance on this; GitHub has no in-app PR auto-merge control here.
#[tauri::command]
pub async fn forge_gl_mr_merge_state(
    repo_path: String,
    number: u64,
) -> AppResult<gitlab::GitLabMrMergeState> {
    gl_only!(repo_path, gitlab::mr_merge_state(&repo_path, number))
}

/// Arm auto-merge (merge-when-pipeline-succeeds) on a merge request. GitLab-only.
#[tauri::command]
pub async fn forge_gl_mr_auto_merge(
    repo_path: String,
    number: u64,
    strategy: String,
    delete_branch: bool,
    sha: Option<String>,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::auto_merge_mr(&repo_path, number, &strategy, delete_branch, sha.as_deref())
    )
}

/// Cancel a merge request's armed auto-merge. GitLab-only.
#[tauri::command]
pub async fn forge_gl_mr_cancel_auto_merge(repo_path: String, number: u64) -> AppResult<()> {
    gl_only!(repo_path, gitlab::cancel_auto_merge_mr(&repo_path, number))
}

/// Remove the project's fork relationship (detach from the fork network). GitLab-only.
#[tauri::command]
pub async fn forge_gl_remove_fork_relationship(repo_path: String) -> AppResult<()> {
    gl_only!(repo_path, gitlab::remove_fork_relationship(&repo_path))
}

/// Play (start) a manual CI job. GitLab-only — GitHub Actions has no per-job
/// manual play, so this is `gl_only` rather than a neutral forge dispatch.
#[tauri::command]
pub async fn forge_gl_ci_play_job(repo_path: String, job_id: u64) -> AppResult<()> {
    gl_only!(repo_path, gitlab::play_job(&repo_path, job_id))
}

/// An issue's time-tracking stats (estimate + spent). GitLab-only — GitHub has no
/// native time tracking.
#[tauri::command]
pub async fn forge_gl_issue_time_stats(
    repo_path: String,
    number: u64,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(repo_path, gitlab::issue_time_stats(&repo_path, number))
}

/// A merge request's time-tracking stats (estimate + spent). GitLab-only.
#[tauri::command]
pub async fn forge_gl_mr_time_stats(
    repo_path: String,
    number: u64,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(repo_path, gitlab::mr_time_stats(&repo_path, number))
}

/// Set (or, when the duration is blank, reset) an issue's time estimate; returns
/// the updated stats. GitLab-only.
#[tauri::command]
pub async fn forge_gl_issue_set_time_estimate(
    repo_path: String,
    number: u64,
    duration: Option<String>,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(
        repo_path,
        gitlab::issue_set_time_estimate(&repo_path, number, duration.as_deref())
    )
}

/// Add to (or, when the duration is blank, reset) an issue's spent time; returns
/// the updated stats. GitLab-only.
#[tauri::command]
pub async fn forge_gl_issue_add_spent_time(
    repo_path: String,
    number: u64,
    duration: Option<String>,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(
        repo_path,
        gitlab::issue_add_spent_time(&repo_path, number, duration.as_deref())
    )
}

/// Set (or, when the duration is blank, reset) a merge request's time estimate;
/// returns the updated stats. GitLab-only.
#[tauri::command]
pub async fn forge_gl_mr_set_time_estimate(
    repo_path: String,
    number: u64,
    duration: Option<String>,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(
        repo_path,
        gitlab::mr_set_time_estimate(&repo_path, number, duration.as_deref())
    )
}

/// Add to (or, when the duration is blank, reset) a merge request's spent time;
/// returns the updated stats. GitLab-only.
#[tauri::command]
pub async fn forge_gl_mr_add_spent_time(
    repo_path: String,
    number: u64,
    duration: Option<String>,
) -> AppResult<gitlab::GitLabTimeStats> {
    gl_only!(
        repo_path,
        gitlab::mr_add_spent_time(&repo_path, number, duration.as_deref())
    )
}

/// An issue's related issues (links). GitLab-only — GitHub has no native issue
/// links.
#[tauri::command]
pub async fn forge_gl_issue_links(
    repo_path: String,
    number: u64,
) -> AppResult<Vec<gitlab::GitLabLinkedIssue>> {
    gl_only!(repo_path, gitlab::issue_links(&repo_path, number))
}

/// Link an issue to another issue (in this repo) as related. GitLab-only.
#[tauri::command]
pub async fn forge_gl_issue_link(
    repo_path: String,
    number: u64,
    target_number: u64,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::link_issue(&repo_path, number, target_number)
    )
}

/// Remove an issue link by its link id. GitLab-only.
#[tauri::command]
pub async fn forge_gl_issue_unlink(
    repo_path: String,
    number: u64,
    link_id: String,
) -> AppResult<()> {
    gl_only!(
        repo_path,
        gitlab::unlink_issue(&repo_path, number, &link_id)
    )
}

/// Rename the repository, behind the abstraction. GitHub renames the repo
/// (old links redirect); GitLab renames both the display name and the URL slug
/// (old paths redirect).
#[tauri::command]
pub async fn forge_repo_rename(
    state: tauri::State<'_, crate::state::AppState>,
    repo_path: String,
    new_name: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::rename_repo(&repo_path, &new_name).await,
        // Bitbucket's rename changes the slug and the OLD slug 404s (no redirect),
        // so the local origin remote is rewritten — hence the state handle.
        Some((Provider::Bitbucket, _)) => {
            bitbucket::rename_repo(&state, &repo_path, &new_name).await
        }
        _ => crate::github::lifecycle::gh_repo_rename(repo_path, new_name).await,
    }
}

/// Archive / unarchive the repository, behind the abstraction.
#[tauri::command]
pub async fn forge_repo_set_archived(repo_path: String, archived: bool) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::set_archived(&repo_path, archived).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Bitbucket doesn't support archiving repositories.".into(),
        )),
        _ => crate::github::lifecycle::gh_repo_set_archived(repo_path, archived).await,
    }
}

/// Change the repository's visibility, behind the abstraction (both providers
/// take "public" / "private" / "internal", with provider-specific rules on
/// "internal" enforced server-side).
#[tauri::command]
pub async fn forge_repo_set_visibility(repo_path: String, visibility: String) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::set_visibility(&repo_path, &visibility).await,
        Some((Provider::Bitbucket, _)) => match visibility.as_str() {
            "public" => bitbucket::set_visibility(&repo_path, false).await,
            "private" => bitbucket::set_visibility(&repo_path, true).await,
            "internal" => Err(AppError::InvalidArgument(
                "Bitbucket has no internal visibility.".into(),
            )),
            other => Err(AppError::InvalidArgument(format!(
                "unknown visibility: {other}"
            ))),
        },
        _ => crate::github::lifecycle::gh_repo_set_visibility(repo_path, visibility).await,
    }
}

/// Transfer the repository to another owner/namespace, behind the abstraction.
/// GitHub takes a user/org (with an optional rename); GitLab a namespace path.
#[tauri::command]
pub async fn forge_repo_transfer(
    repo_path: String,
    new_owner: String,
    new_name: Option<String>,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::transfer_repo(&repo_path, &new_owner).await,
        Some((Provider::Bitbucket, _)) => Err(AppError::InvalidArgument(
            "Transferring isn't available via the Bitbucket API — use the repository's settings on Bitbucket.".into(),
        )),
        _ => crate::github::lifecycle::gh_repo_transfer(repo_path, new_owner, new_name).await,
    }
}

/// Permanently delete the repository on its provider, behind the abstraction.
/// After the remote is gone the local `origin` remote is a dangling pointer, so
/// we remove it — the repo then reads as unpublished again (the header's
/// "Publish repository…" button reappears). The `state` handle is injected by
/// Tauri; the invoke args are unchanged.
#[tauri::command]
pub async fn forge_repo_delete(
    state: tauri::State<'_, crate::state::AppState>,
    repo_path: String,
) -> AppResult<()> {
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab::delete_repo(&repo_path).await,
        Some((Provider::Bitbucket, _)) => bitbucket::delete_repo(&repo_path).await,
        _ => crate::github::lifecycle::gh_repo_delete(repo_path.clone()).await,
    }?;

    // The remote delete succeeded — now drop the local `origin` remote so the
    // repo reads as unpublished. Tolerate origin already being absent (a git
    // "No such remote" failure is treated as success). Any other failure AFTER
    // the remote is gone discloses the partial state rather than masking it.
    if let Err(e) = crate::git::runner::run_git_mutating(
        &state,
        &repo_path,
        &["remote", "remove", "origin"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    {
        let already_absent = matches!(
            &e,
            AppError::Git { stderr, .. } if stderr.contains("No such remote")
        );
        if !already_absent {
            return Err(AppError::Command(format!(
                "The repository was deleted on the host, but the local 'origin' \
                 remote couldn't be removed — remove it manually. ({e})"
            )));
        }
    }
    // origin is gone (either just removed, or already absent) — drop any cached URL so a
    // forge query within the TTL sees the repo as unpublished instead of serving the stale
    // (now-deleted) remote URL.
    crate::git::remote::invalidate_remote_url_cache(&repo_path, "origin");
    Ok(())
}

// ── Bitbucket settings sub-surfaces (wave 3) ─────────────────────────────────

/// The viewer's Bitbucket workspaces — the publish target picker. Account-scoped
/// (no repo_path); creds come from the keyring.
#[tauri::command]
pub async fn forge_bb_workspaces() -> AppResult<Vec<bitbucket::BitbucketWorkspace>> {
    bitbucket::workspaces().await
}

/// The Bitbucket repository-settings read (Bitbucket repos only — its model is
/// provider-shaped, like GitLab's).
#[tauri::command]
pub async fn forge_bb_repo_settings(
    repo_path: String,
) -> AppResult<bitbucket::BitbucketRepoSettings> {
    bb_only!(repo_path, bitbucket::repo_settings(&repo_path))
}

/// Batch-save the Bitbucket repo settings (the General section's Save). Name and
/// visibility are deliberately not here — the Danger zone owns them.
#[tauri::command]
pub async fn forge_bb_repo_settings_update(
    repo_path: String,
    input: bitbucket::BitbucketRepoSettingsInput,
) -> AppResult<bitbucket::BitbucketRepoSettings> {
    bb_only!(repo_path, bitbucket::update_repo_settings(&repo_path, input))
}

#[tauri::command]
pub async fn forge_bb_default_reviewers(
    repo_path: String,
) -> AppResult<Vec<model::ForgeUserRef>> {
    bb_only!(repo_path, bitbucket::default_reviewers(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_default_reviewer_add(repo_path: String, uuid: String) -> AppResult<()> {
    bb_only!(repo_path, bitbucket::default_reviewer_add(&repo_path, &uuid))
}

#[tauri::command]
pub async fn forge_bb_default_reviewer_remove(repo_path: String, uuid: String) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::default_reviewer_remove(&repo_path, &uuid)
    )
}

/// Workspace members WITHOUT the PR-author exclusion — the default-reviewers picker.
#[tauri::command]
pub async fn forge_bb_member_candidates(
    repo_path: String,
) -> AppResult<Vec<model::ForgeUserRef>> {
    bb_only!(repo_path, bitbucket::member_candidates(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_branch_restrictions(
    repo_path: String,
) -> AppResult<Vec<bitbucket::BitbucketBranchRestriction>> {
    bb_only!(repo_path, bitbucket::branch_restrictions(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_branch_restriction_create(
    repo_path: String,
    kind: String,
    pattern: String,
    value: Option<u32>,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::branch_restriction_create(&repo_path, &kind, &pattern, value)
    )
}

#[tauri::command]
pub async fn forge_bb_branch_restriction_update(
    repo_path: String,
    id: String,
    kind: String,
    pattern: String,
    value: Option<u32>,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::branch_restriction_update(&repo_path, &id, &kind, &pattern, value)
    )
}

#[tauri::command]
pub async fn forge_bb_branch_restriction_delete(repo_path: String, id: String) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::branch_restriction_delete(&repo_path, &id)
    )
}

#[tauri::command]
pub async fn forge_bb_pipelines_config(
    repo_path: String,
) -> AppResult<bitbucket::BitbucketPipelinesConfig> {
    bb_only!(repo_path, bitbucket::pipelines_config(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_pipelines_config_update(repo_path: String, enabled: bool) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipelines_config_update(&repo_path, enabled)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_variables(
    repo_path: String,
) -> AppResult<Vec<bitbucket::BitbucketPipelineVariable>> {
    bb_only!(repo_path, bitbucket::pipeline_variables(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_pipeline_variable_create(
    repo_path: String,
    key: String,
    value: String,
    secured: bool,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_variable_create(&repo_path, &key, &value, secured)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_variable_update(
    repo_path: String,
    uuid: String,
    value: String,
    secured: bool,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_variable_update(&repo_path, &uuid, &value, secured)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_variable_delete(repo_path: String, uuid: String) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_variable_delete(&repo_path, &uuid)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_schedules(
    repo_path: String,
) -> AppResult<Vec<bitbucket::BitbucketPipelineSchedule>> {
    bb_only!(repo_path, bitbucket::pipeline_schedules(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_pipeline_schedule_create(
    repo_path: String,
    ref_name: String,
    cron_pattern: String,
    enabled: bool,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_schedule_create(&repo_path, &ref_name, &cron_pattern, enabled)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_schedule_set_enabled(
    repo_path: String,
    uuid: String,
    enabled: bool,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_schedule_set_enabled(&repo_path, &uuid, enabled)
    )
}

#[tauri::command]
pub async fn forge_bb_pipeline_schedule_delete(repo_path: String, uuid: String) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pipeline_schedule_delete(&repo_path, &uuid)
    )
}

#[tauri::command]
pub async fn forge_bb_hooks(repo_path: String) -> AppResult<Vec<bitbucket::BitbucketHook>> {
    bb_only!(repo_path, bitbucket::hooks(&repo_path))
}

#[tauri::command]
pub async fn forge_bb_hook_create(
    repo_path: String,
    input: bitbucket::BitbucketHookInput,
) -> AppResult<()> {
    bb_only!(repo_path, bitbucket::hook_create(&repo_path, input))
}

#[tauri::command]
pub async fn forge_bb_hook_update(
    repo_path: String,
    uuid: String,
    input: bitbucket::BitbucketHookInput,
) -> AppResult<()> {
    bb_only!(repo_path, bitbucket::hook_update(&repo_path, &uuid, input))
}

#[tauri::command]
pub async fn forge_bb_hook_delete(repo_path: String, uuid: String) -> AppResult<()> {
    bb_only!(repo_path, bitbucket::hook_delete(&repo_path, &uuid))
}

// ── Bitbucket PR tasks + custom pipelines + environments (wave 4) ─────────────

/// A pull request's task checklist, in list order (Bitbucket-only —
/// `implemented.pr_tasks`).
#[tauri::command]
pub async fn forge_bb_pr_tasks(
    repo_path: String,
    number: u64,
) -> AppResult<Vec<bitbucket::PrTask>> {
    bb_only!(repo_path, bitbucket::pr_tasks(&repo_path, number))
}

/// Create a PR task from free-text (empty text is rejected before the request).
#[tauri::command]
pub async fn forge_bb_pr_task_create(
    repo_path: String,
    number: u64,
    text: String,
) -> AppResult<bitbucket::PrTask> {
    bb_only!(repo_path, bitbucket::pr_task_create(&repo_path, number, &text))
}

/// Edit a PR task's text (`task_id` is the numeric server id as a String).
#[tauri::command]
pub async fn forge_bb_pr_task_edit(
    repo_path: String,
    number: u64,
    task_id: String,
    text: String,
) -> AppResult<bitbucket::PrTask> {
    bb_only!(
        repo_path,
        bitbucket::pr_task_edit(&repo_path, number, &task_id, &text)
    )
}

/// Resolve / unresolve a PR task.
#[tauri::command]
pub async fn forge_bb_pr_task_set_state(
    repo_path: String,
    number: u64,
    task_id: String,
    resolved: bool,
) -> AppResult<bitbucket::PrTask> {
    bb_only!(
        repo_path,
        bitbucket::pr_task_set_state(&repo_path, number, &task_id, resolved)
    )
}

/// Delete a PR task.
#[tauri::command]
pub async fn forge_bb_pr_task_delete(
    repo_path: String,
    number: u64,
    task_id: String,
) -> AppResult<()> {
    bb_only!(
        repo_path,
        bitbucket::pr_task_delete(&repo_path, number, &task_id)
    )
}

/// The CUSTOM pipeline names declared in the working-tree `bitbucket-pipelines.yml`
/// (the custom-dispatch picker's options). Reads the local file only (no network); a
/// missing file yields an empty list.
#[tauri::command]
pub async fn forge_bb_custom_pipelines(repo_path: String) -> AppResult<Vec<String>> {
    bb_only!(repo_path, bitbucket::custom_pipelines(&repo_path))
}

/// The repo's deployment environments, sorted by rank ascending (Bitbucket-only).
#[tauri::command]
pub async fn forge_bb_environments(
    repo_path: String,
) -> AppResult<Vec<bitbucket::BbEnvironment>> {
    bb_only!(repo_path, bitbucket::environments(&repo_path))
}

/// Which providers this machine can publish a local repo to. A repo with no
/// hosted remote has nothing to detect a provider from, so the publish UI asks
/// explicitly and offers each ready target.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishTargets {
    pub github: bool,
    pub gitlab: bool,
    pub bitbucket: bool,
}

#[tauri::command]
pub async fn forge_publish_targets(repo_path: String) -> AppResult<PublishTargets> {
    let gh = crate::github::pr::gh_status(repo_path)
        .await
        .map(|s| s.installed && s.authenticated)
        .unwrap_or(false);
    let gl = gitlab::cli_ready().await;
    // Bitbucket is publishable iff an account is stored (keyring read, no network).
    let bb = bitbucket::account().await.map(|a| a.is_some()).unwrap_or(false);
    Ok(PublishTargets {
        github: gh,
        gitlab: gl,
        bitbucket: bb,
    })
}

/// Publish a local repo, behind the abstraction. The PROVIDER IS EXPLICIT — a
/// not-yet-published repo has no remote to detect one from. GitHub creates +
/// pushes via `gh repo create --push`; GitLab creates via `glab repo create`,
/// wires `origin`, and pushes with the one-shot credential helper. GitLab has no
/// homepage field (the dialog hides it) and drops it here.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // mirrors gh_publish_repo's field set + provider
pub async fn forge_publish_repo(
    state: tauri::State<'_, crate::state::AppState>,
    provider: Provider,
    repo_path: String,
    name: String,
    private: bool,
    description: String,
    homepage: String,
    topics: Vec<String>,
    // Optional — GitHub/GitLab arms ignore it; a missing arg deserializes to None.
    workspace: Option<String>,
) -> AppResult<String> {
    match provider {
        Provider::GitLab => {
            gitlab::publish_repo(&state, &repo_path, &name, private, &description, &topics).await
        }
        // Bitbucket: homepage maps to `website`; topics are dropped (no topics on
        // Bitbucket); `workspace` names the target (required).
        Provider::Bitbucket => {
            bitbucket::publish_repo(
                &state,
                &repo_path,
                &name,
                private,
                &description,
                &homepage,
                workspace,
            )
            .await
        }
        Provider::GitHub => {
            github::publish_repo(&repo_path, &name, private, &description, &homepage, topics)
                .await
        }
    }
}

/// Create a merge/pull request, behind the abstraction. Both arms push the head
/// branch to origin first (an MR/PR needs it on the remote); GitLab injects glab's
/// token as a one-shot git credential helper for that push, like `forge_clone`.
/// GitHub delegates to the unchanged `gh pr create`; GitLab POSTs the MR with
/// draft mapped to the `Draft:` title prefix. Returns the new number + URL.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn forge_pr_create(
    state: tauri::State<'_, crate::state::AppState>,
    repo_path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrRef> {
    // The `#[tauri::command]` shell just derefs the managed `State` to a plain
    // `&AppState` and delegates to the core, so non-Tauri callers (the MCP server)
    // can create a PR with an `AppState` they own — GUI behavior is unchanged.
    forge_pr_create_core(
        &state, repo_path, base, head, title, body, draft, reviewers, labels, assignees, lens,
    )
    .await
}

/// The provider-dispatch core of [`forge_pr_create`], taking a plain `&AppState`
/// (not a Tauri-managed `State`) so it is callable off the Tauri runtime — the MCP
/// server's `create_pull_request` tool routes through it. The `#[tauri::command]`
/// wrapper above delegates here after dereffing its `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn forge_pr_create_core(
    state: &crate::state::AppState,
    repo_path: String,
    base: String,
    head: String,
    title: String,
    body: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
    lens: Option<String>,
) -> AppResult<crate::github::pr::PrRef> {
    let detected = detect_non_github(&repo_path).await;
    // The upstream lens (a fork contribution to the PARENT) is GitHub-only. Reject it
    // for GitLab/Bitbucket BEFORE any dispatch or remote work (`None`/`Some("origin")`
    // proceed as today; an unknown lens is caught in `gh_pr_create_core`).
    if lens.as_deref() == Some("upstream") && detected.is_some() {
        return Err(AppError::InvalidArgument(
            "Creating a pull request on the upstream repository is currently supported for GitHub only.".into(),
        ));
    }
    // Create-time reviewers are Bitbucket-only. GitHub/GitLab reject a non-empty list
    // BEFORE dispatching (existing callers omit the key → `None` → untouched behavior).
    if reviewers.as_deref().is_some_and(|r| !r.is_empty())
        && !matches!(detected, Some((Provider::Bitbucket, _)))
    {
        return Err(AppError::InvalidArgument(
            "Create-time reviewers aren't supported for this provider.".into(),
        ));
    }
    // Labels/assignees are the mirror case: GitHub and GitLab carry them at create
    // time; Bitbucket PRs have no label/assignee concept, so reject a non-empty list
    // BEFORE dispatching (existing callers omit the keys → `None` → untouched behavior).
    let labels = labels.unwrap_or_default();
    let assignees = assignees.unwrap_or_default();
    if (!labels.is_empty() || !assignees.is_empty())
        && matches!(detected, Some((Provider::Bitbucket, _)))
    {
        return Err(AppError::InvalidArgument(
            "Labels and assignees aren't supported for Bitbucket pull requests.".into(),
        ));
    }
    match detected {
        Some((Provider::GitLab, _)) => {
            gitlab::create_mr(
                state, &repo_path, &base, &head, &title, &body, draft, &labels, &assignees,
            )
            .await
        }
        Some((Provider::Bitbucket, _)) => {
            bitbucket::create_pr(
                state,
                &repo_path,
                &base,
                &head,
                &title,
                &body,
                draft,
                reviewers.as_deref().unwrap_or(&[]),
            )
            .await
        }
        _ => {
            crate::github::pr::gh_pr_create_core(
                state, repo_path, base, head, title, body, draft, labels, assignees, lens,
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_host_parses_https_and_ssh_forms() {
        assert_eq!(remote_host("https://github.com/o/r").as_deref(), Some("github.com"));
        assert_eq!(
            remote_host("https://gitlab.acme.com:8443/g/s/r.git").as_deref(),
            Some("gitlab.acme.com"),
        );
        assert_eq!(remote_host("git@github.com:o/r.git").as_deref(), Some("github.com"));
        assert_eq!(remote_host("ssh://git@gitlab.com/g/r.git").as_deref(), Some("gitlab.com"));
        // Mixed case is normalized.
        assert_eq!(remote_host("https://GitLab.com/o/r").as_deref(), Some("gitlab.com"));
        // No host → None (local path).
        assert_eq!(remote_host("/local/path"), None);
    }

    #[test]
    fn is_https_remote_distinguishes_https_from_ssh() {
        assert!(is_https_remote("https://github.com/o/r.git"));
        assert!(!is_https_remote("git@github.com:o/r.git"));
        assert!(!is_https_remote("ssh://git@github.com/o/r.git"));
        // Plain http never matches the https-keyed helper entry we format.
        assert!(!is_https_remote("http://github.example.com/o/r.git"));
    }

    #[test]
    fn provider_for_remote_host_classifies_by_requested_host() {
        let glab_hosts = vec!["gitlab.acme.com".to_string()];
        // Canonical hosts route directly, no glab config needed.
        assert_eq!(provider_for_remote_host("gitlab.com", &[]), Some(Provider::GitLab));
        assert_eq!(provider_for_remote_host("bitbucket.org", &[]), Some(Provider::Bitbucket));
        // github.com → None (gh-default routing), even if it somehow appears in glab_hosts.
        assert_eq!(provider_for_remote_host("github.com", &glab_hosts), None);
        // A glab-known custom host is self-managed GitLab.
        assert_eq!(provider_for_remote_host("gitlab.acme.com", &glab_hosts), Some(Provider::GitLab));
        // An unknown host (GHE or otherwise) → None.
        assert_eq!(provider_for_remote_host("github.example.com", &glab_hosts), None);
    }

    #[test]
    fn only_canonical_hosts_route_away_from_github() {
        assert_eq!(provider_for_host("gitlab.com"), Some(Provider::GitLab));
        assert_eq!(provider_for_host("bitbucket.org"), Some(Provider::Bitbucket));
        // GitHub.com + Enterprise + self-managed GitLab → None (gh / Phase 1 decide).
        assert_eq!(provider_for_host("github.com"), None);
        assert_eq!(provider_for_host("github.acme.com"), None);
        assert_eq!(provider_for_host("gitlab.acme.com"), None);
    }

    #[test]
    fn remote_path_extracts_project_path() {
        // https, with and without .git, default and custom port.
        assert_eq!(remote_path("https://gitlab.com/group/repo.git").as_deref(), Some("group/repo"));
        assert_eq!(remote_path("https://gitlab.com/group/repo").as_deref(), Some("group/repo"));
        assert_eq!(
            remote_path("https://gitlab.acme.com:8443/g/sub/repo.git").as_deref(),
            Some("g/sub/repo"),
        );
        // scp form keeps the nested group path.
        assert_eq!(remote_path("git@gitlab.com:group/sub/repo.git").as_deref(), Some("group/sub/repo"));
        assert_eq!(remote_path("ssh://git@gitlab.com/group/repo.git").as_deref(), Some("group/repo"));
        // GitHub `owner/repo` slug (what `gh_origin_slug` passes to `gh -R`),
        // in https and scp forms with and without `.git`.
        assert_eq!(remote_path("https://github.com/theBGuy/biome.git").as_deref(), Some("theBGuy/biome"));
        assert_eq!(remote_path("git@github.com:theBGuy/biome.git").as_deref(), Some("theBGuy/biome"));
        assert_eq!(remote_path("https://github.com/theBGuy/biome").as_deref(), Some("theBGuy/biome"));
        // host only → no path.
        assert_eq!(remote_path("https://gitlab.com"), None);
        assert_eq!(remote_path("/local/path"), None);
    }

    #[test]
    fn visibility_normalizes_case_insensitively_and_rejects_garbage() {
        // gh's uppercase, GitLab's lowercase, and mixed case all canonicalize.
        assert_eq!(normalize_visibility("PUBLIC"), Some("public"));
        assert_eq!(normalize_visibility("public"), Some("public"));
        assert_eq!(normalize_visibility("Private"), Some("private"));
        assert_eq!(normalize_visibility("INTERNAL"), Some("internal"));
        // Surrounding whitespace (e.g. a trailing newline from a CLI) is tolerated.
        assert_eq!(normalize_visibility(" public\n"), Some("public"));
        // Anything else → None so the caller errors rather than guessing.
        assert_eq!(normalize_visibility("garbage"), None);
        assert_eq!(normalize_visibility(""), None);
    }
}
