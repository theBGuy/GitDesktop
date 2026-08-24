//! The GitLab [`Forge`](super::Forge) implementation, via the `glab` CLI.
//!
//! Every operation maps GitLab's JSON onto the same neutral models the GitHub
//! panels render (`PrInfo`, `IssueDetails`, `WorkflowRun`, `ReleaseInfo`, …), so
//! the frontend stays provider-agnostic. Which features are wired up is declared
//! in `model.rs::Implemented::for_provider` — flip flags there as impls land.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::forge::glab::{run_glab, run_glab_ex, run_glab_raw, GLAB_NETWORK_TIMEOUT, GLAB_TIMEOUT};
use crate::forge::model::{
    namespace_set, Capabilities, CompletedReviewerOut, ForgeForkResult, ForgeRepo, ForgeRepoList,
    ForgeSearchList, ForgeSearchRepo, ForgeStatus, ForgeTimelineEventOut, ForgeUserRef, Implemented,
    Provider,
};
use crate::forge::{
    cap_readme, validate_owner, validate_repo_name, FORK_POLL_ATTEMPTS, FORK_POLL_DELAY,
    README_CANDIDATES,
};
use crate::forge::Forge;
use crate::github::actions::{RunDetail, RunJob, WorkflowRun};
use crate::github::issue::{IssueDetails, IssueInfo, IssueReactions, Milestone, Reaction};
use crate::github::pr::{
    ApprovalState, CommitCommentOut, DraftCommentIn, ExternalReviewItem, PrAuthor, PrCheckOut,
    PrCiStatus, PrCommitOut, PrDetails, PrFileOut, PrInfo, PrListLabel, PrMergeability, PrPollInfo,
    PrRef, PrStackInfo, PrStackMember, PrThreadOut, RepoLabel, ReviewSubmitOut, ReviewThreadOut,
    STACKS_TIMEOUT,
};
use crate::github::release::{ReleaseAsset, ReleaseDetails, ReleaseInfo};
use crate::state::AppState;

/// GitLab via the `glab` CLI. Carries the repo's resolved host — gitlab.com or any
/// self-managed host glab is signed in to (detected via `forge::glab::known_hosts`).
pub struct GitLabForge {
    host: String,
}

impl GitLabForge {
    pub fn new(host: String) -> Self {
        Self { host }
    }
}

/// Assemble the neutral status from the `glab` probes. Pure (testable). A `Some`
/// `repo` (the project path from the origin remote) flips the integration *ready*;
/// unbuilt panels degrade to "coming soon" via the `implemented` flags.
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

/// The signed-in GitLab user's projects, for the clone browser, via the `glab api`
/// REST escape hatch; `membership=true` = projects the user belongs to. Caps at 100
/// (`--paginate`'s multi-page output needs its own validation); ordering by activity
/// means the cap drops the least-recently-active projects, not an arbitrary 100.
pub async fn list_repos() -> AppResult<ForgeRepoList> {
    let viewer = run_glab(None, &["api", "user"], GLAB_TIMEOUT)
        .await
        .ok()
        .and_then(|o| serde_json::from_str::<GlabUser>(&o.stdout_lossy()).ok())
        .map(|u| u.username)
        .unwrap_or_default();
    let out = run_glab(
        None,
        &[
            "api",
            "projects?membership=true&order_by=last_activity_at&per_page=100",
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let projects: Vec<GlabProject> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse your GitLab projects: {e}")))?;
    Ok(ForgeRepoList {
        // A GitLab username IS the personal namespace's full path. Groups you own are a
        // separate namespace and aren't resolved here, so Fork still shows on those.
        owned_namespaces: namespace_set([viewer.clone()]),
        viewer,
        repos: projects.into_iter().map(from_glab_project).collect(),
    })
}

/// The one-shot `git -c` credential entries that let a network op on a private
/// GitLab repo authenticate via glab's token — glab's token isn't in git's
/// credential store, so plain `git clone` 401s; one-shot, so no token lands in
/// config or the remote URL. Returns the `[reset, helper]` pair only when glab has
/// a stored session for `host` (a `hosts:` entry — it proves a session EXISTS, not
/// that it works; `run_git_mutating_with_creds`'s ambient fallback covers a dead
/// one); no session → empty Vec (git's ambient helpers still run). Missing glab →
/// `Err(GlabNotFound)`, keeping strict `?` clone sites fail-closed.
pub async fn clone_credential_config(clone_url: &str) -> AppResult<Vec<String>> {
    let glab = crate::agent::resolve_named(&["glab"], None)
        .await
        .ok_or(AppError::GlabNotFound)?;
    // The gate takes the BARE host (glab's `hosts:` keys are port-stripped), the KEY the
    // authority — git won't match a portless credential key against a ported request, so
    // a self-managed host on `:8443` would silently never see glab's token.
    let host = crate::forge::remote_host(clone_url).unwrap_or_else(|| "gitlab.com".to_string());
    let authority =
        crate::forge::remote_authority(clone_url).unwrap_or_else(|| "gitlab.com".to_string());
    // glab's signed-in hosts are the `hosts:` keys of its config.yml (written by
    // `glab auth login`) — the established repo signal, not a new `glab auth
    // status` probe. No entry → inject nothing; git's ambient helpers still run.
    // Gate is bare-only (our reader port-strips these keys), so a bare-registered glab
    // passes it yet serves a ported remote nothing — measured on glab 1.105:
    // `auth git-credential get` with `host=gitlab.com:8443` answers EMPTY at exit 0. Fine:
    // a ported instance needs a ported login anyway, and the funnel keeps its ambient retry.
    if !crate::forge::glab::known_hosts().await.contains(&host) {
        return Ok(Vec::new());
    }
    Ok(gitlab_credential_entries(
        &authority,
        &glab.display().to_string(),
    ))
}

/// The one-shot `-c` credential entries for a signed-in GitLab host — a
/// `[reset, helper]` pair. entry[0] SEVERS git's accumulated helper chain for this
/// URL (empty value clears the helper list per gitcredentials(7); the trailing `=`
/// is load-bearing — `-c name` without it sets boolean `true`), entry[1] installs
/// glab as the sole helper so no ambient helper can shadow it. Reset MUST come
/// first — consumers prefix `-c` pairs in Vec order. `authority` is `host[:port]`, not
/// a bare host: git matches credential keys by authority. A crafted remote can drive
/// characters git reads as config syntax through the URL parse, so an authority failing
/// [`crate::forge::is_safe_authority`] emits NOTHING — git falls back to ambient helpers
/// rather than to an injected one. Pure/format-only.
fn gitlab_credential_entries(authority: &str, glab_path: &str) -> Vec<String> {
    if !crate::forge::is_safe_authority(authority) {
        return Vec::new();
    }
    vec![
        format!("credential.https://{authority}.helper="),
        format!("credential.https://{authority}.helper=!\"{glab_path}\" auth git-credential"),
    ]
}

// ── Merge requests (read) ─────────────────────────────────────────────────────
//
// We address the project through the `glab api` REST escape hatch by its
// URL-encoded full path (GitLab accepts it in place of a numeric id), derived from
// the origin remote — the same path `status` reports as `repo`.

/// URL-encode a project's full path for use as a `glab api` project id. Only `/`
/// needs escaping for the paths GitLab allows (letters/digits/`_`/`-`/`.`).
pub(crate) fn encode_project(path: &str) -> String {
    path.replace('/', "%2F")
}

/// Percent-encode a value for safe use inside a `glab api` query string — `glab`
/// forwards the endpoint verbatim (it only encodes the path, not query values), so
/// a query-significant byte must be encoded or it corrupts the query. Shared with
/// the Bitbucket provider, hence it lives in the parent `forge` module.
use crate::forge::encode_query_value;

/// `glab api` args that send a JSON body over stdin — the form every request
/// carrying a secret uses, so the value never reaches argv. glab forwards an
/// `--input` body raw without a content type, and GitLab 415s on that, so the
/// header is ours to set.
fn json_body_args<'a>(method: &'a str, endpoint: &'a str) -> [&'a str; 8] {
    [
        "api",
        "--method",
        method,
        endpoint,
        "--input",
        "-",
        "--header",
        "Content-Type: application/json",
    ]
}

/// The project's full path (`group/name`) from the repo's origin remote.
pub(crate) async fn project_path(repo_path: &str) -> AppResult<String> {
    let url =
        crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await?;
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

/// Deserialize a field the provider may send as JSON `null` rather than omitting it,
/// treating a present `null` as the type's default. `#[serde(default)]` alone only
/// fills a MISSING key, so a present `null` fails the whole parse — this absorbs
/// both. Applied to every optional scalar and collection GitLab could null out.
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
    /// Profile image; GitLab sends `null` when unset, so coerce to "".
    #[serde(default, deserialize_with = "null_to_default")]
    avatar_url: String,
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
    #[serde(default)]
    created_at: String,
    /// The head/target projects. Differing ids mean a fork MR; `None` on either
    /// side leaves `cross_repository` false rather than guessing.
    #[serde(default)]
    source_project_id: Option<u64>,
    #[serde(default)]
    target_project_id: Option<u64>,
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
        created_at: m.created_at,
        // GitLab queries CI by MR iid (headPipeline), never by SHA — leave it empty.
        head_sha: String::new(),
        // GitLab has no stack object; chains are inferred over a whole open list
        // (see `infer_mr_stacks`), which a single MR can't do. That inference is pure
        // over rows already in hand — it has no probe to fail, so never unknown.
        stack: None,
        stack_unknown: false,
        // A fork MR lives in a different project; either id missing leaves this
        // false rather than guessing a fork the resolve flow would then refuse.
        cross_repository: match (m.source_project_id, m.target_project_id) {
            (Some(src), Some(tgt)) => src != tgt,
            _ => false,
        },
    }
}

/// Infer stacked-MR chains from the OPEN merge requests: `(iid, source branch,
/// target branch)` in, `iid → (stack id, 1-based position, chain size)` out.
/// GitLab auto-detects a stack server-side when an MR targets another open MR's
/// source branch but exposes no stack object, so we reconstruct the same relation
/// from the list.
///
/// Only unambiguous LINEAR chains of two or more MRs are marked, and ambiguity is
/// judged per CONNECTED COMPONENT, not per link: a source branch shared by two
/// open MRs identifies no unique parent, and an MR with two open children is a
/// branching stack — GitHub disallows those, so a component containing either
/// shape is left entirely unmarked rather than re-rooted at the break (an MR
/// whose own base is ambiguous is not a stack bottom). Pure — unit-tested.
fn infer_mr_stacks(open: &[(u64, &str, &str)]) -> HashMap<u64, (String, u32, u32)> {
    let mut sources: HashMap<&str, Vec<u64>> = HashMap::new();
    for (iid, head, _) in open {
        sources.entry(*head).or_default().push(*iid);
    }

    // Candidate links join a component even when they're AMBIGUOUS — that's what
    // lets one bad link poison its whole chain instead of silently splitting it.
    let mut neighbors: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut has_parent: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut children: HashMap<u64, Vec<u64>> = HashMap::new();
    let mut ambiguous: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for (iid, _, base) in open {
        // The open MRs offering this target branch as their source. An MR can't be
        // its own parent (a self-targeting MR just sits on a plain branch).
        let candidates: Vec<u64> = sources
            .get(*base)
            .map(|c| c.iter().copied().filter(|p| p != iid).collect())
            .unwrap_or_default();
        for parent in &candidates {
            neighbors.entry(*iid).or_default().push(*parent);
            neighbors.entry(*parent).or_default().push(*iid);
        }
        match candidates.as_slice() {
            // No open MR owns this branch — a genuine chain bottom.
            [] => {}
            [parent] => {
                has_parent.insert(*iid);
                children.entry(*parent).or_default().push(*iid);
            }
            _ => {
                ambiguous.insert(*iid);
            }
        }
    }
    for (parent, kids) in &children {
        if kids.len() > 1 {
            ambiguous.insert(*parent);
        }
    }

    let mut result = HashMap::new();
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Walk components in list order so the output never depends on hash iteration.
    for (start, _, _) in open {
        if !seen.insert(*start) {
            continue;
        }
        let mut component = vec![*start];
        let mut queue = vec![*start];
        while let Some(node) = queue.pop() {
            for next in neighbors.get(&node).into_iter().flatten() {
                if seen.insert(*next) {
                    component.push(*next);
                    queue.push(*next);
                }
            }
        }
        if component.iter().any(|iid| ambiguous.contains(iid)) {
            continue;
        }
        // Unambiguous: every link is unique in both directions, so the component is
        // one chain. A component whose every MR has a parent is a cycle — no bottom,
        // nothing emitted.
        let Some(bottom) = component.iter().find(|iid| !has_parent.contains(iid)) else {
            continue;
        };
        let mut chain = vec![*bottom];
        let mut cursor = *bottom;
        // Bounded by the component: an unambiguous component can't join a cycle to a
        // parentless bottom, so this is belt-and-braces against an infinite walk.
        while chain.len() < component.len() {
            let Some([next]) = children.get(&cursor).map(Vec::as_slice) else {
                break;
            };
            cursor = *next;
            chain.push(cursor);
        }
        if chain.len() < 2 {
            continue;
        }
        let id = format!("mr-{bottom}");
        let size = chain.len() as u32;
        for (idx, iid) in chain.into_iter().enumerate() {
            result.insert(iid, (id.clone(), idx as u32 + 1, size));
        }
    }
    result
}

/// Fill each row's `stack` from the chains inferred over the SAME list. Membership
/// is only as complete as the list in hand: callers pass the full open page (a
/// truncated list would hide a chain's bottom and mis-position the rows above it),
/// so the real limits are >100 open MRs and merged layers, which an open list has
/// dropped entirely. Cross-repository rows sit out the inference entirely: their
/// source branch lives in another project, so its name says nothing about a chain
/// in this one.
fn apply_mr_stacks(prs: &mut [PrInfo]) {
    let rows: Vec<(u64, &str, &str)> = prs
        .iter()
        .filter(|p| !p.cross_repository)
        .map(|p| {
            (
                p.number,
                p.head_ref_name.as_str(),
                p.base_ref_name.as_str(),
            )
        })
        .collect();
    let stacks = infer_mr_stacks(&rows);
    for pr in prs.iter_mut() {
        pr.stack = stacks.get(&pr.number).map(|(id, position, size)| PrStackInfo {
            id: id.clone(),
            position: *position,
            size: *size,
        });
    }
}

/// One MR's chain membership plus that chain's members bottom→top, for the detail
/// view. Reads the `stack` field `list_prs` already annotated onto its rows —
/// inference runs once, there. `(None, [])` when the MR isn't in the list or
/// isn't in an unambiguous chain.
fn mr_stack_from_rows(open: &[PrInfo], number: u64) -> (Option<PrStackInfo>, Vec<PrStackMember>) {
    let Some(stack) = open
        .iter()
        .find(|p| p.number == number)
        .and_then(|p| p.stack.as_ref())
    else {
        return (None, Vec::new());
    };
    let mut members: Vec<PrStackMember> = open
        .iter()
        .filter_map(|p| {
            let member = p.stack.as_ref()?;
            (member.id == stack.id).then(|| PrStackMember {
                number: p.number,
                title: p.title.clone(),
                state: p.state.to_ascii_lowercase(),
                position: member.position,
                head_ref_name: p.head_ref_name.clone(),
                base_ref_name: p.base_ref_name.clone(),
            })
        })
        .collect();
    members.sort_by_key(|m| m.position);
    (Some(stack.clone()), members)
}

/// The signed-in user's merge requests for this repo. `state` is `"open"` or
/// `"closed"`; the Closed tab shows closed **and** merged (matching the GitHub
/// panel). GitLab splits those into separate server states, so we fetch each on
/// its own `per_page` budget and concatenate — never one `state=all` page where
/// open MRs would dilute (and silently truncate) the closed/merged ones.
pub async fn list_prs(repo_path: &str, state: &str, limit: Option<u32>) -> AppResult<Vec<PrInfo>> {
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
    // GitLab pages at `per_page` (max 100). The OPEN set always requests a full page
    // regardless of `limit`: stack inference reads the whole open list, and a
    // server-side truncation would hide a chain's bottom and mis-position the rows
    // above it. Paying for a full page on a small `limit` is therefore DELIBERATE —
    // narrowing this fetch back down would silently corrupt the positions rather
    // than merely returning fewer rows. A `limit` narrows the RESULT after inference
    // instead. Closed states have no inference, so they keep the cheaper
    // `limit`-sized page (a "closed" filter fans out over two states, so the raw
    // total can exceed `limit`).
    let per_page = if state == "open" {
        100
    } else {
        limit.map_or(100, |n| n.clamp(1, 100))
    };
    let mut prs = Vec::new();
    for s in states {
        let endpoint = format!("projects/{enc}/merge_requests?state={s}&per_page={per_page}");
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let mrs: Vec<GlabMr> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse GitLab merge requests: {e}")))?;
        prs.extend(mrs.into_iter().map(from_glab_mr));
    }
    // Chains are inferred over the open set only — a closed list's rows describe
    // merges already made. Inference sees the full page (see `per_page`), so a
    // `limit` narrows what's returned without distorting positions.
    if state == "open" {
        apply_mr_stacks(&mut prs);
    }
    if let Some(n) = limit {
        prs.truncate(n as usize);
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

/// Map a GitLab GraphQL `PipelineStatusEnum` (the MR head pipeline's status) onto the
/// neutral list-row CI signal. SKIPPED counts as passing (nothing to run, not a
/// failure); everything unrecognized or in-flight → pending, never a false green.
/// Null/absent pipeline → none. Case-insensitive.
fn pipeline_status_to_ci(status: Option<&str>) -> String {
    match status.map(|s| s.trim().to_ascii_uppercase()) {
        None => "none".to_string(),
        Some(s) if s.is_empty() => "none".to_string(),
        Some(s) => match s.as_str() {
            "SUCCESS" | "SKIPPED" => "passing",
            "FAILED" | "CANCELED" | "CANCELING" => "failing",
            _ => "pending",
        }
        .to_string(),
    }
}

/// Parse `(host, full_path)` from a GitLab MR web url of the shape
/// `https://<host>/<group>[/<sub>…]/<project>/-/merge_requests/<iid>`. The full path is
/// every segment between the host and the `/-/merge_requests/` marker — GitLab groups
/// nest arbitrarily deep, so this is not fixed at two segments. Each segment is
/// strict-validated (`[A-Za-z0-9._-]+`, never `-`-prefixed) so it can't inject a glab
/// flag or break out of the GraphQL variable. Anything not matching → Err.
fn parse_mr_url_project(url: &str) -> AppResult<(String, String)> {
    let host = crate::forge::remote_host(url)
        .ok_or_else(|| AppError::InvalidArgument(format!("not an MR url: {url}")))?;
    let after = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path = after.split_once('/').map(|(_, p)| p).unwrap_or("");
    // The project full path is everything before the `/-/merge_requests/` marker.
    let Some((full_path, _)) = path.split_once("/-/merge_requests/") else {
        return Err(AppError::InvalidArgument(format!(
            "could not parse project path from MR url: {url}"
        )));
    };
    let segments: Vec<&str> = full_path.split('/').collect();
    let valid_seg = |s: &str| {
        !s.is_empty()
            && !s.starts_with('-')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if segments.len() < 2 || !segments.iter().all(|s| valid_seg(s)) {
        return Err(AppError::InvalidArgument(format!(
            "could not parse project path from MR url: {url}"
        )));
    }
    Ok((host, full_path.to_string()))
}

/// The MR CI rollup for a set of iids in ONE project, keyed by number. GitLab's
/// GraphQL exposes each MR's `headPipeline.status` as a precomputed enum, so one
/// batched call per ≤50-iid chunk suffices — no N+1. `sample_url` (any MR web url
/// from the same page) fixes the host + project full path; `fullPath` rides as a
/// GraphQL variable, iids are digits-only and embedded as quoted strings (`[ID!]`).
/// A chunk that errors or won't parse is omitted (its rows show no icon), never
/// failing the whole call. Self-hosted works via glab's `--hostname`.
pub async fn pr_list_ci(
    repo_path: &str,
    iids: Vec<u64>,
    sample_url: &str,
) -> AppResult<Vec<PrCiStatus>> {
    if iids.is_empty() {
        return Ok(Vec::new());
    }
    let (host, full_path) = parse_mr_url_project(sample_url)?;
    let hostname_arg = (host != "gitlab.com").then_some(host);

    let mut result: Vec<PrCiStatus> = Vec::with_capacity(iids.len());
    for chunk in iids.chunks(50) {
        // Safe to interpolate: iids are u64 (digits only). fullPath rides as a
        // GraphQL variable, never interpolated.
        let iid_list = chunk
            .iter()
            .map(|i| format!("\"{i}\""))
            .collect::<Vec<_>>()
            .join(",");
        let query = format!(
            "query($path:ID!){{ project(fullPath: $path){{ mergeRequests(iids: [{iid_list}]){{ nodes{{ iid headPipeline{{ status }} }} }} }} }}"
        );
        let query_arg = format!("query={query}");
        let path_arg = format!("path={full_path}");
        let mut args: Vec<&str> = vec!["api", "graphql"];
        if let Some(h) = &hostname_arg {
            args.push("--hostname");
            args.push(h);
        }
        args.push("-f");
        args.push(&query_arg);
        args.push("-f");
        args.push(&path_arg);

        let Ok(out) = run_glab_raw(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await else {
            continue;
        };
        if out.code != 0 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) else {
            continue;
        };
        let Some(nodes) = value
            .pointer("/data/project/mergeRequests/nodes")
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for node in nodes {
            // iid comes back as a STRING; parse it back to a number for the neutral key.
            let Some(iid) = node
                .pointer("/iid")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
            else {
                continue;
            };
            // A null headPipeline (no pipeline for this MR) → none.
            let status = node
                .pointer("/headPipeline/status")
                .and_then(|s| s.as_str());
            result.push(PrCiStatus {
                number: iid,
                ci_status: pipeline_status_to_ci(status),
            });
        }
    }
    Ok(result)
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
    #[serde(default)]
    source_branch: String,
    #[serde(default)]
    target_branch: String,
    #[serde(default, deserialize_with = "null_to_default")]
    created_at: String,
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
        // rollup, so the poller's checks/review branches never fire for GitLab (v1).
        review_decision: String::new(),
        checks_state: String::new(),
        head_sha: m.sha,
        // The new-comment / new-review / review-requested detectors are GitHub-only
        // in v1 — the MR list carries none of these.
        comment_count: 0,
        last_comment_author: String::new(),
        review_count: 0,
        last_review_author: String::new(),
        last_review_id: String::new(),
        review_requests: Vec::new(),
        head_ref_name: m.source_branch,
        base_ref_name: m.target_branch,
        // MR open time — the missed-open catch-up's recency anchor.
        created_at: m.created_at,
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
    /// The MR's reviewers (inline on the detail GET), separate from assignees —
    /// what the reviewer picker reads and edits.
    #[serde(default, deserialize_with = "null_to_default")]
    reviewers: Vec<GlabMrUser>,
    #[serde(default, deserialize_with = "null_to_default")]
    labels: Vec<String>,
    #[serde(default, deserialize_with = "null_to_default")]
    changes: Vec<GlabChange>,
    /// The head commit's pipeline (`null` when the MR has no CI). Its jobs become the
    /// PR-view check rollup. `id` addresses the jobs endpoint; the frontend routes the
    /// per-job `job_id` back through `forge_ci_job_logs` for the inline log peek.
    #[serde(default)]
    head_pipeline: Option<GlabHeadPipeline>,
    /// Mergeability, carried server-side on the `/changes` payload — so the detail
    /// view costs no extra HTTP. Null-tolerant like every GitLab scalar.
    #[serde(default, deserialize_with = "null_to_default")]
    has_conflicts: Option<bool>,
    #[serde(default, deserialize_with = "null_to_default")]
    detailed_merge_status: String,
    #[serde(default, deserialize_with = "null_to_default")]
    merge_error: Option<String>,
    /// The head/target projects. Differing ids mean a fork MR; `None` on either
    /// side leaves `cross_repository` false rather than guessing.
    #[serde(default, deserialize_with = "null_to_default")]
    source_project_id: Option<u64>,
    #[serde(default, deserialize_with = "null_to_default")]
    target_project_id: Option<u64>,
}

/// The `head_pipeline` object embedded in an MR payload — only `id` (the jobs
/// fetch) is needed; each check links via its own per-job `web_url`.
#[derive(Deserialize)]
struct GlabHeadPipeline {
    id: u64,
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

// ── Multi-line diff-note ranges (line_range / line_code) ───────────────────────
//
// GitLab anchors a multi-line diff note via `position.line_range`, whose start/end
// refs each carry `line_code` = `sha1_hex(file_path)_<old_pos>_<new_pos>`, with the
// (old, new) pair following GitLab's own diff-parser walk. We send BOTH `line_code`
// and `type` + `new_line`/`old_line` (the web UI highlights on line_code; our reader
// keys on the explicit field). A ref without `line_code` is also accepted — the
// fallback when it can't be computed, so a post never fails over line_code.

/// The `line_code` for a diff-note range ref: `sha1_hex(file_path)_<old_pos>_<new_pos>`.
/// GitLab keys its multi-line highlight on this value. Pure (testable).
fn gl_line_code(file_path: &str, old_pos: u64, new_pos: u64) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(file_path.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}_{old_pos}_{new_pos}")
}

/// Walk a GitLab per-file unified-diff hunk string (starts at `@@`, no `---`/`+++`
/// header — the raw `GlabChange.diff`) and return the `(old_pos, new_pos)` pair for
/// `line` on `side` ("new"/"old"), following GitLab's own diff-parser semantics:
/// each `@@ -a[,b] +c[,d] @@` sets old=a, new=c; a `+` line takes (old,new) then
/// advances new; a `-` line takes it then advances old; a context/empty line takes
/// it then advances both; `\ No newline…` is skipped. `None` when the line isn't in
/// the diff. Pure (testable).
fn gl_diff_line_refs(file_diff: &str, side: &str, line: u64) -> Option<(u64, u64)> {
    let mut old_pos: u64 = 0;
    let mut new_pos: u64 = 0;
    for raw in file_diff.lines() {
        if let Some(header) = raw.strip_prefix("@@") {
            // `@@ -a[,b] +c[,d] @@ …` — parse the `-a` and `+c` starts.
            let (a, c) = parse_hunk_header(header)?;
            old_pos = a;
            new_pos = c;
            continue;
        }
        // `\ No newline at end of file` — no refs, no counter change.
        if raw.starts_with('\\') {
            continue;
        }
        let first = raw.chars().next();
        match first {
            Some('+') => {
                if side == "new" && new_pos == line {
                    return Some((old_pos, new_pos));
                }
                new_pos += 1;
            }
            Some('-') => {
                if side == "old" && old_pos == line {
                    return Some((old_pos, new_pos));
                }
                old_pos += 1;
            }
            // Context line (leading space) or a bare empty line inside a hunk.
            _ => {
                if (side == "new" && new_pos == line) || (side == "old" && old_pos == line) {
                    return Some((old_pos, new_pos));
                }
                old_pos += 1;
                new_pos += 1;
            }
        }
    }
    None
}

/// Parse the `-a[,b] +c[,d]` starts out of a hunk header body (the text AFTER the
/// leading `@@`). Returns `(old_start, new_start)`, or `None` if malformed. Pure.
///
/// ONLY the slice before the CLOSING `@@` is parsed: the text after it is git's
/// function-context heading and is untrusted (it can hold a `->`, a trailing `+5`,
/// even a literal `@@`). Cut at the first subsequent `@@`, then take the FIRST
/// `-`- and `+`-prefixed tokens without reassigning, so a heading number can't
/// clobber a real range.
fn parse_hunk_header(header: &str) -> Option<(u64, u64)> {
    let range = match header.split_once("@@") {
        Some((range, _heading)) => range,
        None => header,
    };
    let mut old_start = None;
    let mut new_start = None;
    for tok in range.split_whitespace() {
        if let Some(rest) = tok.strip_prefix('-') {
            if old_start.is_none() {
                old_start = rest.split(',').next().and_then(|n| n.parse::<u64>().ok());
            }
        } else if let Some(rest) = tok.strip_prefix('+') {
            if new_start.is_none() {
                new_start = rest.split(',').next().and_then(|n| n.parse::<u64>().ok());
            }
        }
    }
    Some((old_start?, new_start?))
}

/// Build the `line_range` object for a diff note spanning `start`..=`line` on `side`,
/// against the file's hunk-only diff `file_diff`. Each ref carries `type` + the
/// side-matched line field, plus `line_code` when it can be computed from the diff
/// (the no-line_code form is the accepted fallback). `None` is never returned — the
/// object always has the explicit line fields so the post can't fail over line_code.
fn gl_build_line_range(
    file_diff: &str,
    file_path: &str,
    side: &str,
    start: u64,
    line: u64,
) -> serde_json::Value {
    let line_field = if side == "old" {
        "old_line"
    } else {
        "new_line"
    };
    let make_ref = |ln: u64| {
        let mut r = serde_json::json!({ "type": side, line_field: ln });
        if let Some((old_pos, new_pos)) = gl_diff_line_refs(file_diff, side, ln) {
            r["line_code"] = serde_json::Value::String(gl_line_code(file_path, old_pos, new_pos));
        }
        r
    };
    serde_json::json!({ "start": make_ref(start), "end": make_ref(line) })
}

#[derive(Deserialize)]
struct GlabCommit {
    id: String,
    #[serde(default)]
    title: String,
    /// The full commit message (title + body). The commits API returns it; we
    /// strip the title line (+ the following blank) to derive the body.
    #[serde(default)]
    message: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    created_at: String,
}

/// Derive a commit-message body from the full message by dropping the title line
/// (the first line) and a single blank separator line after it. Pure (testable).
/// Shared shape with the Bitbucket derivation (`bb_message_body`) so all three
/// providers produce the same "body = everything after the headline" semantics.
/// Returns "" when the message is a single line (no body).
pub(crate) fn message_body_from_full(message: &str) -> String {
    let rest = match message.split_once('\n') {
        Some((_, rest)) => rest,
        None => return String::new(),
    };
    // Conventional git messages separate title and body with one blank line —
    // strip exactly that separator (a single leading "\n" or "\r\n").
    let rest = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .unwrap_or(rest);
    rest.trim_end().to_string()
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
    /// The diff-anchor `position`, present only on inline (diff) notes. Its presence
    /// keeps diff-anchored notes OUT of the flat conversation list — they surface as
    /// `review_threads` with real file/line context instead.
    #[serde(default)]
    position: Option<GlabNotePosition>,
}

#[derive(Deserialize)]
struct GlabLabel {
    name: String,
    #[serde(default)]
    color: String,
    /// The label's description; the GitLab labels API already returns it in the
    /// same response, so threading it into `RepoLabel` costs no extra call.
    #[serde(default)]
    description: Option<String>,
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

/// Full read view of one merge request — core fields + files, commits, comments, and
/// the head pipeline's CI checks, mapped onto `PrDetails`. Reviews stay empty (a
/// GitLab approval carries no reviewable body — approvals surface via the timeline
/// and the approve/unapprove control instead).
pub async fn view_pr(repo_path: &str, number: u64) -> AppResult<PrDetails> {
    let enc = encode_project(&project_path(repo_path).await?);

    // Core fields + changed files in one call, alongside the open-MR list that
    // stack inference needs — GitLab has no per-MR stack object, so membership can
    // only come from the whole open set. Fail-open: an empty list simply leaves
    // this MR unstacked.
    let changes_endpoint = format!("projects/{enc}/merge_requests/{number}/changes");
    let changes_args = ["api", changes_endpoint.as_str()];
    let (out, open_prs) = tokio::join!(
        run_glab(Some(repo_path), &changes_args, GLAB_NETWORK_TIMEOUT),
        // BOUNDED as well as concurrent: glab's own ceiling is 120s, and a stack
        // decoration must never gate the MR view for that long. Elapsing falls back
        // to no chain, exactly like an errored list.
        async {
            tokio::time::timeout(STACKS_TIMEOUT, list_prs(repo_path, "open", None))
                .await
                .unwrap_or_else(|_| Ok(Vec::new()))
                .unwrap_or_default()
        },
    );
    let out = out?;
    let (stack, stack_members) = mr_stack_from_rows(&open_prs, number);
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
        &[
            "api",
            &format!("projects/{enc}/merge_requests/{number}/commits?per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabCommit>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .map(|c| PrCommitOut {
        message_body: message_body_from_full(&c.message),
        oid: c.id,
        headline: c.title,
        date: c.created_at,
        author: c.author_name,
    })
    .collect();
    commits.reverse();

    // Resolve the signed-in user once, tolerantly — a failure just hides every
    // comment's edit/delete (drives `viewer_did_author`), it must not fail the view.
    let viewer = current_user_login(repo_path).await;

    // Comments — drop GitLab's system notes and diff-anchored (positioned) notes
    // (the latter surface as `review_threads`).
    let comments: Vec<PrThreadOut> = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/merge_requests/{number}/notes?sort=asc&per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .filter(|n| !n.system && n.position.is_none())
    .map(|n| {
        let (author, author_avatar_url) = n
            .author
            .map(|a| (a.username, a.avatar_url))
            .unwrap_or_default();
        PrThreadOut {
            viewer_did_author: note_authored_by_viewer(&author, viewer.as_deref()),
            author,
            author_avatar_url,
            state: String::new(),
            body: n.body,
            date: n.created_at,
            id: n.id.to_string(),
            url: String::new(),
            is_minimized: false,
            minimized_reason: String::new(),
            // GitLab doesn't model review objects — no owning review id.
            review_id: String::new(),
        }
    })
    .collect();

    // CI checks — the head pipeline's jobs (best-effort; empty when the MR has no
    // pipeline or the jobs fetch fails).
    let checks = match &mr.head_pipeline {
        Some(p) => pipeline_checks(repo_path, &enc, p.id).await,
        None => Vec::new(),
    };

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
                // Detail-view labels come from the MR/issue payload (name + color
                // only), with no description in hand.
                description: None,
            }
        })
        .collect();

    // GitLab supplies the author's avatar directly; carry it so the header shows a
    // real photo instead of a login-derived (GitHub-only) URL.
    let (author, author_avatar_url) = mr
        .author
        .map(|a| (a.username, a.avatar_url))
        .unwrap_or_default();

    // Reviewer verdicts. GitLab MRs carry no reviewable review objects, so a completed
    // reviewer is an assigned reviewer whose per-reviewer state is `approved` or
    // `requested_changes` (from `…/reviewers`). Best-effort — a failed fetch just leaves
    // `completed_reviewers` empty. NOTE: `reviewers` below stays the FULL assigned set:
    // an approver remains assigned, and that list drives a full-replacement PUT, so
    // dropping acted reviewers would un-assign them on the next edit. The frontend
    // de-dups the display instead.
    let reviewer_states: std::collections::HashMap<String, String> =
        mr_reviewers(repo_path, &enc, number)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| {
                r.user
                    .map(|u| (u.username, r.state.to_ascii_lowercase()))
                    .filter(|(name, _)| !name.is_empty())
            })
            .collect();

    // The acted subset (approved / requested-changes) with each verdict — borrows
    // `mr.reviewers` so the full list below can still consume it.
    let completed_reviewers: Vec<CompletedReviewerOut> = mr
        .reviewers
        .iter()
        .filter(|u| !u.username.is_empty())
        .filter_map(|u| {
            let state = match reviewer_states.get(&u.username).map(String::as_str) {
                Some("approved") => "APPROVED",
                Some("requested_changes") => "CHANGES_REQUESTED",
                _ => return None,
            };
            Some(CompletedReviewerOut {
                user: ForgeUserRef {
                    id: u.username.clone(),
                    label: u.username.clone(),
                    avatar_url: u.avatar_url.clone(),
                    is_bot: false,
                },
                state: state.to_string(),
            })
        })
        .collect();

    Ok(PrDetails {
        // No GraphQL node id on GitLab; the GitLab mutations key on the iid (labels
        // by name, assignees by resolved numeric id), so an empty id is fine.
        id: String::new(),
        number: mr.iid,
        title: mr.title,
        body: mr.description.unwrap_or_default(),
        author,
        author_avatar_url,
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
        checks,
        labels,
        assignees: mr
            .assignees
            .into_iter()
            .map(|a| ForgeUserRef {
                id: a.username.clone(),
                label: a.username,
                avatar_url: a.avatar_url,
                is_bot: false,
            })
            .collect(),
        // The FULL assigned reviewer set, keyed by username (like assignees — the
        // setter resolves username→id), so the picker's chips match its candidate
        // ids. Acted reviewers stay (this list drives a full-replacement PUT).
        reviewers: mr
            .reviewers
            .into_iter()
            .filter(|u| !u.username.is_empty())
            .map(|u| ForgeUserRef {
                id: u.username.clone(),
                label: u.username,
                avatar_url: u.avatar_url,
                is_bot: false,
            })
            .collect(),
        completed_reviewers,
        // Repository-level merge-method gating is a GitHub-only concept here; the
        // fields are honestly "unknown" for GitLab (the picker never gates on `None`).
        merge_commit_allowed: None,
        squash_merge_allowed: None,
        rebase_merge_allowed: None,
        stack,
        stack_members,
        // Inference failing open has no disclosure consequence here: a GitLab merge
        // never cascades, so an unknown chain can't hide a multi-MR merge.
        stack_unknown: false,
        mergeability: map_gl_mergeability(
            &mr.state,
            mr.has_conflicts,
            &mr.detailed_merge_status,
            mr.merge_error.as_deref(),
        ),
        // A fork MR lives in a different project; either id missing leaves this
        // false rather than guessing a fork the resolve flow would then refuse.
        cross_repository: match (mr.source_project_id, mr.target_project_id) {
            (Some(src), Some(tgt)) => src != tgt,
            _ => false,
        },
        // GitHub's "allow edits by maintainers" has no GitLab equivalent — unknown,
        // not denied.
        maintainer_can_modify: None,
    })
}

/// One `resource_label_events` entry: `{action:"add"|"remove", label{name,color},
/// user{username}, created_at}`. Every field is optional-tolerant (a deleted label
/// or ghost user leaves the string empty).
#[derive(Deserialize)]
struct GlabLabelEvent {
    #[serde(default)]
    action: String,
    #[serde(default)]
    label: Option<GlabEventLabel>,
    #[serde(default)]
    user: Option<GlabMrUser>,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct GlabEventLabel {
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
}

/// Map one `resource_label_events` entry (MR or issue — the endpoints share a shape),
/// or `None` once the label itself has been deleted. The endpoint returns `color` WITH
/// a leading `#` while the `Labeled.color` contract is bare hex (the frontend renders
/// `#${color}`), so the strip is part of the mapping, not a caller's job. Pure
/// (unit-tested).
fn map_label_event(e: GlabLabelEvent) -> Option<ForgeTimelineEventOut> {
    let label = e.label?;
    Some(ForgeTimelineEventOut::Labeled {
        label: label.name,
        color: label.color.trim_start_matches('#').to_string(),
        added: e.action == "add",
        actor: gl_actor(e.user),
        date: e.created_at,
    })
}

/// One `resource_state_events` entry: `{state:"closed"|"reopened"|"merged", user,
/// created_at}`.
#[derive(Deserialize)]
struct GlabStateEvent {
    #[serde(default)]
    state: String,
    #[serde(default)]
    user: Option<GlabMrUser>,
    #[serde(default)]
    created_at: String,
}

/// The date field of a `ForgeTimelineEventOut` — the sort key. Empty dates sort first
/// (stable), which keeps undated events at the top rather than dropping them.
fn timeline_event_date(e: &ForgeTimelineEventOut) -> &str {
    match e {
        ForgeTimelineEventOut::Labeled { date, .. }
        | ForgeTimelineEventOut::Closed { date, .. }
        | ForgeTimelineEventOut::Reopened { date, .. }
        | ForgeTimelineEventOut::Merged { date, .. }
        | ForgeTimelineEventOut::Approved { date, .. }
        | ForgeTimelineEventOut::ChangesRequested { date, .. }
        | ForgeTimelineEventOut::Unapproved { date, .. } => date,
        // The GitLab arm never produces these, but the union is shared — match
        // exhaustively so a new variant can't silently sort as "".
        ForgeTimelineEventOut::ForcePushed { date, .. }
        | ForgeTimelineEventOut::ReviewRequested { date, .. }
        | ForgeTimelineEventOut::ReadyForReview { date, .. }
        | ForgeTimelineEventOut::ConvertToDraft { date, .. }
        | ForgeTimelineEventOut::Renamed { date, .. }
        | ForgeTimelineEventOut::Assigned { date, .. }
        | ForgeTimelineEventOut::Milestoned { date, .. }
        | ForgeTimelineEventOut::CrossReferenced { date, .. }
        | ForgeTimelineEventOut::Connected { date, .. }
        | ForgeTimelineEventOut::Pinned { date, .. }
        | ForgeTimelineEventOut::Locked { date, .. }
        | ForgeTimelineEventOut::Transferred { date, .. }
        | ForgeTimelineEventOut::MarkedAsDuplicate { date, .. } => date,
    }
}

/// A GitLab timeline actor as a neutral user ref. GitLab identifies users by
/// username, so it fills both `id` and `label`; a missing user (deleted account)
/// yields an all-empty ref, which the frontend renders as no actor at all.
fn gl_actor(u: Option<GlabMrUser>) -> ForgeUserRef {
    let (username, avatar_url) = u.map(|u| (u.username, u.avatar_url)).unwrap_or_default();
    ForgeUserRef {
        id: username.clone(),
        label: username,
        avatar_url,
        is_bot: false,
    }
}

/// Map a GitLab MR system-note body onto an approval-flow timeline event, or `None`
/// when it isn't one. GitLab records approvals/verdicts as system notes with fixed
/// bodies ("approved this merge request", "unapproved this merge request",
/// "requested changes") — the only place these carry a per-event timestamp + actor
/// (the `/approvals` endpoint reports only the current state). Pure (unit-tested).
fn map_approval_note(
    body: &str,
    actor: ForgeUserRef,
    date: String,
) -> Option<ForgeTimelineEventOut> {
    match body.trim() {
        "approved this merge request" => Some(ForgeTimelineEventOut::Approved { actor, date }),
        "unapproved this merge request" => Some(ForgeTimelineEventOut::Unapproved { actor, date }),
        "requested changes" => Some(ForgeTimelineEventOut::ChangesRequested { actor, date }),
        _ => None,
    }
}

/// The MR's activity timeline — label add/remove, state changes, and approval-flow
/// events — mapped onto the neutral `ForgeTimelineEventOut` union, oldest→newest.
/// Deliberately omits commits (the frontend interleaves `pr.commits`), force-pushes
/// (no GitLab API), and draft/ready + review-request events.
///
/// Every sub-fetch is best-effort and a single `per_page=100` page, and which end a
/// busy MR truncates differs by class: `notes` defaults to newest-first, so approvals
/// keep the NEWEST page; the `resource_*` endpoints ignore `sort` and always answer
/// oldest-first, so those classes keep the OLDEST page. The same feed's conversation
/// half (`view_pr`'s comment read) keeps the oldest page, so past 100 notes the merged
/// feed pairs the oldest comments with the newest events; unifying the windows is
/// deferred.
pub async fn mr_timeline(repo_path: &str, number: u64) -> AppResult<Vec<ForgeTimelineEventOut>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let base = format!("projects/{enc}/merge_requests/{number}");
    let mut events: Vec<ForgeTimelineEventOut> = Vec::new();

    // Three independent reads on the MR-open foreground path; the terminal sort makes
    // arrival order irrelevant, so run them concurrently.
    let (label_events, state_events, notes) = tokio::join!(
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/resource_label_events?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabLabelEvent>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/resource_state_events?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabStateEvent>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
        // Approval-flow events — system notes carry the timestamped history
        // (see `map_approval_note`).
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/notes?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
    );

    events.extend(label_events.into_iter().filter_map(map_label_event));
    events.extend(state_events.into_iter().filter_map(map_state_event));

    for n in notes {
        if !n.system {
            continue;
        }
        if let Some(ev) = map_approval_note(&n.body, gl_actor(n.author), n.created_at) {
            events.push(ev);
        }
    }

    // Combine all classes and sort ascending by date (empty dates sort first).
    events.sort_by(|a, b| timeline_event_date(a).cmp(timeline_event_date(b)));
    Ok(events)
}

/// One `resource_milestone_events` entry: `{action:"add"|"remove", milestone{title},
/// user, created_at}`. `milestone` is null once the milestone itself is deleted.
#[derive(Deserialize)]
struct GlabMilestoneEvent {
    #[serde(default)]
    action: String,
    #[serde(default)]
    milestone: Option<GlabEventMilestone>,
    #[serde(default)]
    user: Option<GlabMrUser>,
    #[serde(default)]
    created_at: String,
}

#[derive(Deserialize)]
struct GlabEventMilestone {
    #[serde(default)]
    title: String,
}

/// Map one issue `resource_milestone_events` entry, or `None` when the milestone it
/// pointed at has since been deleted (GitLab keeps the event, nulls the milestone).
/// Pure (unit-tested).
fn map_issue_milestone_event(e: GlabMilestoneEvent) -> Option<ForgeTimelineEventOut> {
    let milestone = e.milestone?;
    Some(ForgeTimelineEventOut::Milestoned {
        milestone: milestone.title,
        added: e.action == "add",
        actor: gl_actor(e.user),
        date: e.created_at,
    })
}

/// Map one `resource_state_events` entry (MR or issue — the endpoints share a shape),
/// or `None` for a state we don't model, which is skipped rather than guessed. The
/// `merged` arm is unreachable from the issue caller: GitLab only ever reports it on
/// merge requests. Pure (unit-tested).
fn map_state_event(e: GlabStateEvent) -> Option<ForgeTimelineEventOut> {
    let actor = gl_actor(e.user);
    let date = e.created_at;
    match e.state.as_str() {
        // GitLab reports no close reason, so `state_reason` stays empty.
        "closed" => Some(ForgeTimelineEventOut::Closed {
            actor,
            state_reason: String::new(),
            date,
        }),
        "reopened" => Some(ForgeTimelineEventOut::Reopened { actor, date }),
        "merged" => Some(ForgeTimelineEventOut::Merged {
            actor,
            commit_oid: None,
            date,
        }),
        _ => None,
    }
}

/// Map a GitLab issue system-note body onto a timeline event, or `None` when it isn't
/// one we model. GitLab records assignment, cross-references, duplicates and lock
/// changes only as system notes — there is no structured endpoint for them. The
/// matcher is anchored and exact-form only: an unrecognized body is skipped rather
/// than half-parsed, because these bodies are free-form English that GitLab extends.
/// Cross-PROJECT mentions (`mentioned in merge request group/proj!7`) deliberately
/// don't match — the neutral `source_repo` means an `owner/name` slug, and GitLab's
/// note gives no reliable way to split one out. Pure (unit-tested).
fn map_issue_system_note(
    body: &str,
    actor: ForgeUserRef,
    date: String,
) -> Option<ForgeTimelineEventOut> {
    let body = body.trim();
    // The reference number runs to end-of-string; a cross-project form
    // (`…!7` prefixed by `group/proj`) never reaches here, so no digits, no match.
    let number = |rest: &str| {
        (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
            .then(|| rest.parse::<u64>().ok())
            .flatten()
    };
    // gitlab.com writes the lock notes as "…the discussion in this issue" (measured
    // against project 83906586, 2026-08-23); the short forms are accepted too so an
    // older self-managed wording can't drop the event.
    match body {
        "locked the discussion in this issue" | "locked this issue" => {
            return Some(ForgeTimelineEventOut::Locked {
                locked: true,
                // GitLab records no lock reason.
                reason: String::new(),
                actor,
                date,
            })
        }
        "unlocked the discussion in this issue" | "unlocked this issue" => {
            return Some(ForgeTimelineEventOut::Locked {
                locked: false,
                reason: String::new(),
                actor,
                date,
            })
        }
        _ => {}
    }
    if let Some((name, added)) = body
        .strip_prefix("assigned to @")
        .map(|rest| (rest, true))
        .or_else(|| body.strip_prefix("unassigned @").map(|rest| (rest, false)))
    {
        // One `@username` only: a multi-assignee body ("assigned to @a and @b")
        // carries whitespace and is skipped rather than credited to the first name.
        return (!name.is_empty() && !name.contains(char::is_whitespace)).then(|| {
            ForgeTimelineEventOut::Assigned {
                assignee: name.to_string(),
                added,
                actor,
                date,
            }
        });
    }
    if let Some((n, kind)) = body
        .strip_prefix("mentioned in merge request !")
        .and_then(number)
        .map(|n| (n, "pr"))
        .or_else(|| {
            body.strip_prefix("mentioned in issue #")
                .and_then(number)
                .map(|n| (n, "issue"))
        })
    {
        return Some(ForgeTimelineEventOut::CrossReferenced {
            source_kind: kind.to_string(),
            source_number: n,
            // The note carries neither the referrer's title nor its project.
            source_title: String::new(),
            source_repo: String::new(),
            will_close: false,
            actor,
            date,
        });
    }
    if let Some(n) = body
        .strip_prefix("marked this issue as a duplicate of #")
        .and_then(number)
    {
        return Some(ForgeTimelineEventOut::MarkedAsDuplicate {
            canonical_kind: "issue".to_string(),
            canonical_number: n,
            canonical_repo: String::new(),
            actor,
            date,
        });
    }
    None
}

/// The issue's activity timeline — label add/remove, state changes, milestone
/// changes, and the assignment/cross-reference/duplicate/lock system notes — mapped
/// onto the neutral `ForgeTimelineEventOut` union, oldest→newest.
///
/// Every sub-fetch is best-effort and a single `per_page=100` page, and which end a
/// busy issue truncates differs by class: `notes` defaults to newest-first, so the
/// system-note events keep the NEWEST page; the `resource_*` endpoints ignore `sort`
/// and always answer oldest-first, so those classes keep the OLDEST page. The same
/// feed's conversation half (`view_issue`'s comment read) keeps the oldest page, so
/// past 100 notes the merged feed pairs the oldest comments with the newest events;
/// unifying the windows is deferred.
pub async fn issue_timeline(repo_path: &str, number: u64) -> AppResult<Vec<ForgeTimelineEventOut>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let base = format!("projects/{enc}/issues/{number}");
    let mut events: Vec<ForgeTimelineEventOut> = Vec::new();

    // Four independent reads on the issue-open foreground path; the terminal sort
    // makes arrival order irrelevant, so run them concurrently.
    let (label_events, state_events, milestone_events, notes) = tokio::join!(
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/resource_label_events?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabLabelEvent>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/resource_state_events?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabStateEvent>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
        async {
            run_glab(
                Some(repo_path),
                &[
                    "api",
                    &format!("{base}/resource_milestone_events?per_page=100"),
                ],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabMilestoneEvent>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
        // Assignment / cross-reference / duplicate / lock events (see
        // `map_issue_system_note`).
        async {
            run_glab(
                Some(repo_path),
                &["api", &format!("{base}/notes?per_page=100")],
                GLAB_NETWORK_TIMEOUT,
            )
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
            .unwrap_or_default()
        },
    );

    events.extend(label_events.into_iter().filter_map(map_label_event));
    events.extend(state_events.into_iter().filter_map(map_state_event));
    events.extend(
        milestone_events
            .into_iter()
            .filter_map(map_issue_milestone_event),
    );

    for n in notes {
        if !n.system {
            continue;
        }
        if let Some(ev) = map_issue_system_note(&n.body, gl_actor(n.author), n.created_at) {
            events.push(ev);
        }
    }

    // Combine all classes and sort ascending by date (empty dates sort first).
    events.sort_by(|a, b| timeline_event_date(a).cmp(timeline_event_date(b)));
    Ok(events)
}

/// Fetch an MR's changed files (`…/merge_requests/{n}/changes` → `changes[]`) as the
/// raw `GlabChange` list, so a range-writer can find a file's hunk-only diff to
/// compute `line_code`. Tolerant: a parse failure yields an empty list (the caller
/// then falls back to a line_code-less range rather than failing the post).
async fn fetch_mr_changes(repo_path: &str, enc: &str, number: u64) -> Vec<GlabChange> {
    let out = match run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/merge_requests/{number}/changes"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<GlabMrChanges>(&out.stdout_lossy())
        .map(|mr| mr.changes)
        .unwrap_or_default()
}

/// Fetch a commit's changed files (`…/repository/commits/{sha}/diff` → `[]`) as the
/// raw `GlabChange` list. Same tolerant contract as `fetch_mr_changes`.
async fn fetch_commit_changes(repo_path: &str, enc: &str, sha: &str) -> Vec<GlabChange> {
    let out = match run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/repository/commits/{sha}/diff?per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<GlabChange>>(&out.stdout_lossy()).unwrap_or_default()
}

/// Find a changed file's hunk-only diff by matching on the side-appropriate path
/// (`new_path` for the new side, `old_path` for the old side). Pure (testable).
fn gl_file_diff<'a>(changes: &'a [GlabChange], path: &str, side: &str) -> Option<&'a str> {
    changes
        .iter()
        .find(|c| {
            if side == "old" {
                c.old_path == path
            } else {
                c.new_path == path
            }
        })
        .map(|c| c.diff.as_str())
}

/// Compute the `line_range` for a ranged diff note against a fetched change set:
/// find the file's diff, then build the range. `None` when the file isn't in the
/// change set — the caller then falls back to a line_code-less range so the post
/// never fails over an unresolved file.
fn gl_range_from_changes(
    changes: &[GlabChange],
    path: &str,
    side: &str,
    start: u64,
    line: u64,
) -> serde_json::Value {
    match gl_file_diff(changes, path, side) {
        Some(diff) => gl_build_line_range(diff, path, side, start, line),
        // File not in the change set: emit refs without line_code (type + line only).
        None => gl_build_line_range("", path, side, start, line),
    }
}

/// The unified diff for one merge request, rebuilt from `/changes` into the same
/// `git`-style format `gh pr diff` produces so the frontend diff viewer parses it.
pub async fn diff_pr(repo_path: &str, number: u64) -> AppResult<String> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/merge_requests/{number}/changes"),
        ],
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

/// Validate a commit sha before it's interpolated into an API path — a hex value
/// (GitLab accepts abbreviated shas, so length isn't fixed). Rejects empty/non-hex
/// before any network call.
fn validate_commit_sha(sha: &str) -> AppResult<()> {
    if sha.is_empty() || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidArgument(format!(
            "invalid commit id: {sha}"
        )));
    }
    Ok(())
}

/// The unified diff of ONE commit (`GET …/repository/commits/{sha}/diff`), rebuilt
/// from GitLab's per-file array into the `git`-style format `gh pr diff` produces
/// (via `reconstruct_file_diff`). Sha validated before the request.
pub async fn commit_diff(repo_path: &str, sha: &str) -> AppResult<String> {
    validate_commit_sha(sha)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/repository/commits/{sha}/diff?per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let changes: Vec<GlabChange> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab commit diff: {e}")))?;
    let mut diff = String::new();
    for c in &changes {
        diff.push_str(&reconstruct_file_diff(c));
    }
    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, 2_000_000);
    Ok(text)
}

// ── Commit comments ───────────────────────────────────────────────────────────
//
// GitLab has no first-class "commit comment" — a comment on a commit is a note in a
// commit DISCUSSION (`…/repository/commits/{sha}/discussions`), so the neutral
// comment id is the COMPOSITE `"{discussion_id}:{note_id}"` that edit/delete parse
// apart. A whole-commit comment posts a flat `-f body`; an anchored one needs the
// nested `position` JSON via `--input -` (flat `-f position[x]=y` is SILENTLY
// ignored by GitLab).

/// A note inside a commit discussion (the fields we map). `position` (present only
/// on diff-anchored notes) carries the anchored path/line.
#[derive(Deserialize)]
struct GlabCommitNote {
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
    position: Option<GlabCommitNotePosition>,
}

/// A commit discussion (`{id, notes:[…]}`).
#[derive(Deserialize)]
struct GlabCommitDiscussion {
    id: String,
    #[serde(default, deserialize_with = "null_to_default")]
    notes: Vec<GlabCommitNote>,
}

/// The diff-anchor of a positioned commit note. New side (`new_path`/`new_line`)
/// when present; an old-side-only anchor (a comment on a removed line) carries
/// `old_path` with no `new_line`.
#[derive(Deserialize)]
struct GlabCommitNotePosition {
    #[serde(default)]
    new_path: String,
    #[serde(default)]
    new_line: Option<u64>,
    #[serde(default)]
    old_path: String,
    /// Present only on multi-line commit-diff notes: the range endpoints. We read the
    /// START line (new side) for the neutral `start_line`. Option per untrusted-JSON.
    #[serde(default)]
    line_range: Option<GlabLineRange>,
}

/// Map a positioned commit note's anchor onto the neutral `(path, line)`. Pure
/// (testable). `line` is defined as the NEW-side line, so an old-side-only anchor
/// keeps its `old_path` (so the comment still renders against a file, not as a
/// whole-commit comment) but leaves `line: None` — mapping the old-side number into
/// `line` would mis-anchor it on the new side.
fn gl_commit_anchor(pos: &GlabCommitNotePosition) -> (Option<String>, Option<u64>) {
    if !pos.new_path.is_empty() {
        (Some(pos.new_path.clone()), pos.new_line)
    } else if !pos.old_path.is_empty() {
        (Some(pos.old_path.clone()), None)
    } else {
        (None, None)
    }
}

/// Parse the neutral composite commit-comment id `"{discussionId}:{noteId}"` into
/// its parts. Pure (testable). Rejects a malformed value (missing colon, empty
/// half, non-numeric note id) BEFORE any remote call — the discussion id is an
/// opaque hex string, the note id numeric.
fn parse_commit_comment_id(comment_id: &str) -> AppResult<(String, u64)> {
    let (did, nid) = comment_id.split_once(':').ok_or_else(|| {
        AppError::InvalidArgument(format!("invalid commit comment id: {comment_id}"))
    })?;
    if did.is_empty() {
        return Err(AppError::InvalidArgument(format!(
            "invalid commit comment id: {comment_id}"
        )));
    }
    let note_id: u64 = nid.parse().map_err(|_| {
        AppError::InvalidArgument(format!("invalid commit comment id: {comment_id}"))
    })?;
    Ok((did.to_string(), note_id))
}

/// List a commit's comments — the non-system notes of its discussions, flattened.
/// Each neutral id is `"{discussion_id}:{note_id}"`; anchored notes carry path/line
/// from `position`. `viewer_did_author` uses the tolerant current-login compare.
pub async fn commit_comments(repo_path: &str, sha: &str) -> AppResult<Vec<CommitCommentOut>> {
    validate_commit_sha(sha)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let viewer = current_user_login(repo_path).await;
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/repository/commits/{sha}/discussions?per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let discussions: Vec<GlabCommitDiscussion> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab commit discussions: {e}")))?;
    let mut items = Vec::new();
    for d in discussions {
        for n in d.notes {
            if n.system {
                continue;
            }
            let author = n.author.map(|a| a.username).unwrap_or_default();
            let (path, line) = match &n.position {
                Some(p) => gl_commit_anchor(p),
                None => (None, None),
            };
            // Multi-line commit-diff notes carry `line_range`; its start (new side —
            // the commit composer only ranges the new side) is the range's first
            // line, resolved from the explicit field or the line_code fallback.
            let start_line = n
                .position
                .as_ref()
                .and_then(|p| p.line_range.as_ref())
                .and_then(|r| r.start.as_ref())
                .and_then(|s| gl_range_ref_line(s, "new"))
                .map(u64::from);
            items.push(CommitCommentOut {
                viewer_did_author: note_authored_by_viewer(&author, viewer.as_deref()),
                id: format!("{}:{}", d.id, n.id),
                author,
                body: n.body,
                created_at: n.created_at,
                path,
                line,
                start_line,
                // GitLab has no GitHub-style diff `position`; anchoring is by line.
                position: None,
            });
        }
    }
    Ok(items)
}

/// The parent sha of a commit (`GET …/commits/{sha}` → `.parent_ids[0]`), needed to
/// anchor a positioned commit note. Errors clearly when the commit has no parent.
async fn commit_parent_sha(repo_path: &str, enc: &str, sha: &str) -> AppResult<String> {
    #[derive(Deserialize)]
    struct GlabCommitParents {
        #[serde(default, deserialize_with = "null_to_default")]
        parent_ids: Vec<String>,
    }
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/repository/commits/{sha}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let c: GlabCommitParents = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab commit: {e}")))?;
    c.parent_ids.into_iter().next().ok_or_else(|| {
        AppError::InvalidArgument(
            "can't anchor a comment on this commit — it has no parent commit to diff against."
                .into(),
        )
    })
}

/// Post a comment on a commit. Whole-commit (`path`/`line` both None) posts a flat
/// `-f body`; an anchored one posts the nested `position` JSON via `--input -`.
/// `start_line`, when set and different from `line`, makes it a MULTI-LINE range
/// (new side only): fetch the commit's per-file diffs and attach
/// `position.line_range`, falling back to line_code-less refs if the file/line
/// can't be resolved — the post never fails over line_code. Empty-body guarded.
pub async fn commit_comment_create(
    repo_path: &str,
    sha: &str,
    body: &str,
    path: Option<&str>,
    line: Option<u64>,
    start_line: Option<u64>,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    validate_commit_sha(sha)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/repository/commits/{sha}/discussions");
    match (path, line) {
        (Some(p), Some(l)) => {
            let parent = commit_parent_sha(repo_path, &enc, sha).await?;
            let mut position = serde_json::json!({
                "base_sha": parent,
                "start_sha": parent,
                "head_sha": sha,
                "position_type": "text",
                "new_path": p,
                "new_line": l,
            });
            // Multi-line range (new side): attach `line_range` from the commit diffs.
            if let Some(start) = start_line.filter(|s| *s != l) {
                let changes = fetch_commit_changes(repo_path, &enc, sha).await;
                position["line_range"] = gl_range_from_changes(&changes, p, "new", start, l);
            }
            let payload = serde_json::json!({ "body": body, "position": position });
            run_glab_ex(
                Some(repo_path),
                &json_body_args("POST", &endpoint),
                Some(&payload.to_string()),
                &[],
                GLAB_NETWORK_TIMEOUT,
            )
            .await?;
        }
        _ => {
            let body_arg = format!("body={body}");
            run_glab(
                Some(repo_path),
                &["api", "--method", "POST", &endpoint, "-f", &body_arg],
                GLAB_NETWORK_TIMEOUT,
            )
            .await?;
        }
    }
    Ok(())
}

/// Edit a commit comment (`PUT …/commits/{sha}/discussions/{did}/notes/{nid}`,
/// `-f body`). Empty-body guard + composite-id parse both run BEFORE the request.
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
    let (did, nid) = parse_commit_comment_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/repository/commits/{sha}/discussions/{did}/notes/{nid}");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Delete a commit comment (`DELETE …/commits/{sha}/discussions/{did}/notes/{nid}`).
/// Composite-id parse runs BEFORE the request.
pub async fn commit_comment_delete(repo_path: &str, sha: &str, comment_id: &str) -> AppResult<()> {
    validate_commit_sha(sha)?;
    let (did, nid) = parse_commit_comment_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/repository/commits/{sha}/discussions/{did}/notes/{nid}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Merge requests (write) ────────────────────────────────────────────────────
//
// Comment (note), close/reopen, title/body edit, approve/unapprove, and merge —
// mirroring the gh_pr_* commands and dispatching through forge_pr_*. (Full reviews
// stay GitHub-only.) Same glab `-f` raw-field + `state_event` shape as the issue
// writes. Unlike issue close, MR close has no reason on either platform.

/// Post a comment (note) on a merge request. When `as_bot` is set and a review-bot
/// token is stored for this repo's GitLab host, the POST runs with the bot
/// `GITLAB_TOKEN` in the env (which overrides glab's configured auth); with no token
/// stored it falls back silently to the signed-in-user path and still succeeds.
pub async fn comment_mr(repo_path: &str, number: u64, body: &str, as_bot: bool) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/notes");
    let body_arg = format!("body={body}");
    let args: &[&str] = &["api", "--method", "POST", &endpoint, "-f", &body_arg];

    // Try the bot token only when asked AND one is stored for this repo's host.
    let bot_token = if as_bot {
        review_bot_token_for_host(repo_path).await
    } else {
        None
    };
    if let Some(token) = bot_token {
        run_glab_ex(
            Some(repo_path),
            args,
            None,
            &[("GITLAB_TOKEN", &token), ("GITLAB_HOST", REVIEW_TOKEN_HOST)],
            GLAB_NETWORK_TIMEOUT,
        )
        .await?;
    } else {
        run_glab(Some(repo_path), args, GLAB_NETWORK_TIMEOUT).await?;
    }
    Ok(())
}

// ── Review-bot token (gitlab.com scope, v1) ───────────────────────────────────
//
// A project bot's PAT, stored so AI-review notes can be authored by the bot instead
// of the signed-in user. Keyring-namespaced under `forge/gitlab.com/*` (the same
// scheme Bitbucket uses), gitlab.com-only for v1. NEVER logged or echoed.

/// The host the review-bot token is scoped to (gitlab.com only, v1).
const REVIEW_TOKEN_HOST: &str = "gitlab.com";
const REVIEW_TOKEN_KEY: &str = "review_token";
const REVIEW_BOT_LOGIN_KEY: &str = "review_bot_login";

/// The stored review-bot token, but ONLY when this repo is on the token's host
/// (gitlab.com) — the v1 scope. `None` when off-host or nothing is stored (a
/// keyring read on a blocking thread; any failure → `None`, so `comment_mr` falls
/// back to the signed-in-user path).
async fn review_bot_token_for_host(repo_path: &str) -> Option<String> {
    let url = crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string())
        .await
        .ok()?;
    if crate::forge::remote_host(&url).as_deref() != Some(REVIEW_TOKEN_HOST) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::read_forge_secret(REVIEW_TOKEN_HOST, REVIEW_TOKEN_KEY)
            .ok()
            .flatten()
    })
    .await
    .ok()
    .flatten()
    .filter(|t| !t.is_empty())
}

/// The configured review-bot login, if any (`Some(bot_login)` when a token is
/// stored). A keyring existence read only (no network).
pub async fn review_token_status() -> AppResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::read_forge_secret(REVIEW_TOKEN_HOST, REVIEW_BOT_LOGIN_KEY)
    })
    .await
    .map_err(|e| AppError::Glab(format!("keyring task failed: {e}")))?
    .map(|opt| opt.filter(|s| !s.is_empty()))
}

/// Validate a review-bot token live (`glab api user` with the token in the env,
/// which overrides glab's configured auth — an invalid token 401s even when glab is
/// logged in), store the token + resolved login, and return the login. On validation
/// failure the error surfaces and NOTHING is stored. The token is never logged.
pub async fn review_token_set(token: String) -> AppResult<String> {
    if token.trim().is_empty() {
        return Err(AppError::InvalidArgument("a token is required".into()));
    }
    // Validate against the token's host with the token injected via env.
    let out = run_glab_ex(
        None,
        &["api", "user"],
        None,
        &[
            ("GITLAB_TOKEN", token.trim()),
            ("GITLAB_HOST", REVIEW_TOKEN_HOST),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let user: GlabUser = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab user: {e}")))?;
    if user.username.is_empty() {
        return Err(AppError::Glab(
            "the token validated but returned no username.".into(),
        ));
    }
    let login = user.username.clone();
    let stored_token = token.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::secrets::set_forge_secret(REVIEW_TOKEN_HOST, REVIEW_TOKEN_KEY, &stored_token)?;
        crate::secrets::set_forge_secret(REVIEW_TOKEN_HOST, REVIEW_BOT_LOGIN_KEY, &login)
    })
    .await
    .map_err(|e| AppError::Glab(format!("keyring task failed: {e}")))??;
    Ok(user.username)
}

/// Clear the stored review-bot token + login (a missing entry is tolerated).
pub async fn review_token_clear() -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::secrets::delete_forge_secret(REVIEW_TOKEN_HOST, REVIEW_TOKEN_KEY)?;
        crate::secrets::delete_forge_secret(REVIEW_TOKEN_HOST, REVIEW_BOT_LOGIN_KEY)
    })
    .await
    .map_err(|e| AppError::Glab(format!("keyring task failed: {e}")))?
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

/// Set a merge request's draft state via `glab mr update <iid> --ready | --draft`.
/// A GitLab draft is a `Draft:` title prefix and `glab mr update` adds/strips it for
/// us — which is why this shells the `mr` subcommand instead of PATCHing the title.
/// The project resolves from the repo dir (matching the iid's scope); `number` is a
/// u64, so it's safe positionally.
pub async fn set_mr_draft(repo_path: &str, number: u64, draft: bool) -> AppResult<()> {
    let iid = number.to_string();
    let flag = if draft { "--draft" } else { "--ready" };
    run_glab(
        Some(repo_path),
        &["mr", "update", &iid, flag],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The PUT argv for an MR edit. `target_branch` is appended ONLY when retargeting:
/// an absent field leaves the MR's target untouched.
fn edit_mr_args(endpoint: &str, title: &str, body: &str, base: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "--method".to_string(),
        "PUT".to_string(),
        endpoint.to_string(),
        "-f".to_string(),
        format!("title={title}"),
        "-f".to_string(),
        format!("description={body}"),
    ];
    if let Some(base) = base {
        args.push("-f".to_string());
        args.push(format!("target_branch={base}"));
    }
    args
}

/// Edit a merge request's title/description, and its target branch when `base` is
/// given. Mirrors `gh_pr_edit` (empty-title guard; an empty body clears the
/// description). Validated live: `-f` keeps multi-line/comma/`=`/`@`/leading-`-`
/// values intact.
pub async fn edit_mr(
    repo_path: &str,
    number: u64,
    title: &str,
    body: &str,
    base: Option<&str>,
) -> AppResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument(
            "a merge request title is required".into(),
        ));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    let args = edit_mr_args(&endpoint, title, body, base);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_glab(Some(repo_path), &arg_refs, GLAB_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Parse a comment id (a note id, sent as a string over IPC) to the numeric id
/// GitLab's notes endpoint takes — a pre-mutation guard, before any network call.
fn parse_note_id(comment_id: &str) -> AppResult<u64> {
    comment_id
        .trim()
        .parse::<u64>()
        .map_err(|_| AppError::InvalidArgument(format!("invalid comment id: {comment_id}")))
}

/// Edit a merge request note's body (`PUT …/merge_requests/{n}/notes/{id}`).
/// Empty-body guard + comment-id parse both run BEFORE the request.
pub async fn edit_mr_comment(
    repo_path: &str,
    number: u64,
    comment_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let note_id = parse_note_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/notes/{note_id}");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Delete a merge request note (`DELETE …/merge_requests/{n}/notes/{id}`).
/// Comment-id parse runs BEFORE the request.
pub async fn delete_mr_comment(repo_path: &str, number: u64, comment_id: &str) -> AppResult<()> {
    let note_id = parse_note_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/merge_requests/{number}/notes/{note_id}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Merge requests (approvals & reviewer states) ──────────────────────────────
//
// GitLab's approve/unapprove is a bodyless toggle with no GitHub analogue, gated on
// `implemented.mr_approve`; the approvals read drives it. `user_can_approve` is
// deliberately dropped from the neutral shape — GitLab reports it `false` on Free
// even when approving succeeds (it's a Premium approval-rules signal), so the toggle
// keys on `user_has_approved` and a real permission error surfaces via the toast.
// Request-changes (`implemented.mr_request_changes`) rides the same read: the
// reviewers endpoint carries a per-reviewer `state` (unreviewed / requested_changes
// / approved). Its WRITE is GraphQL-only (`mergeRequestRequestChanges`, works on
// Free) and needs the viewer to BE a reviewer first; approving clears the state,
// and the direct undo mutation is Premium-only ("Invalid license" on Free).

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
        &[
            "api",
            // per_page=100: GitLab paginates at 20 by default, so a Premium MR with
            // 21+ reviewers would re-read truncated and misfire the tier-clamp warning.
            &format!("projects/{enc}/merge_requests/{number}/reviewers?per_page=100"),
        ],
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

/// The signed-in user's username, resolved TOLERANTLY for the read views — any
/// failure (glab error, parse error, empty username) yields `None`, so a comment's
/// `viewer_did_author` falls back to `false` (edit/delete hidden) rather than
/// failing the whole view. Never returns an empty string.
async fn current_user_login(repo_path: &str) -> Option<String> {
    current_user(repo_path)
        .await
        .ok()
        .map(|u| u.username)
        .filter(|u| !u.is_empty())
}

/// Whether a note's author is the signed-in viewer. Pure (testable): an unknown
/// viewer (`None`) or an empty author is never a match — the safe direction, which
/// only ever HIDES a comment's edit/delete, never exposes someone else's.
fn note_authored_by_viewer(author: &str, viewer: Option<&str>) -> bool {
    match viewer {
        Some(v) => !author.is_empty() && author == v,
        None => false,
    }
}

/// The viewer's + the MR's approval state, mapped onto the neutral `ApprovalState`.
/// Also folds in the viewer's requested-changes reviewer state — all three reads
/// must succeed (a wrong-but-confident review state is worse than a disabled
/// control, so no best-effort fallbacks here).
pub async fn pr_approvals(repo_path: &str, number: u64) -> AppResult<ApprovalState> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/merge_requests/{number}/approvals"),
        ],
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
async fn set_mr_reviewer_ids(
    repo_path: &str,
    enc: &str,
    number: u64,
    ids: &[u64],
) -> AppResult<()> {
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    let ids_arg = format!(
        "reviewer_ids={}",
        if ids.is_empty() {
            "0".to_string()
        } else {
            ids.iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
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
/// optional comment. The GraphQL `mergeRequestRequestChanges` works on Free but
/// requires the viewer to BE a reviewer ("Reviewer not found"), so we add them
/// first, keeping existing reviewers AHEAD of the viewer in the PUT — Free allows
/// one reviewer and keeps only the FIRST id, so that order never displaces an
/// existing one; we re-read and error honestly when the viewer didn't stick.
/// Approving clears the state; the direct undo mutation is Premium-only.
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
            // pre-existing reviewer nothing changed (ours was appended last); with
            // several (multi-reviewer data retained across a tier downgrade) it just
            // dropped the rest — attempt a restore and DISCLOSE the drop rather than
            // report a clean no-op (the restore hits the same keep-first filter, so
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
        if let Err(e) = comment_mr(repo_path, number, body, false).await {
            return Err(AppError::Glab(format!(
                "Changes were requested, but posting the comment failed: {e}"
            )));
        }
    }
    Ok(())
}

// ── Merge requests (merge) ────────────────────────────────────────────────────
//
// A SHARED control with GitHub's `gh pr merge`. GitLab's merge endpoint controls
// `squash` (the one genuine per-MR knob) + `should_remove_source_branch`; the
// merge-commit-vs-fast-forward shape is the PROJECT's `merge_method` setting, not a
// per-MR choice. So we offer only `merge` (squash=false) and `squash` (squash=true)
// and reject `rebase` (GitLab has no per-MR rebase-merge — that's the project
// setting plus a separate async endpoint). The optional `sha` guards against merging
// a head the user never saw (GitLab 409s if it moved); that 409 and the 405 on an
// unmergeable MR both exit non-zero with a message, so they surface via the toast.

/// Merge a merge request. `strategy` is `merge` or `squash` — `rebase` is rejected
/// (see the section note). A non-empty `sha` must match the source branch HEAD or
/// GitLab refuses: a stale-view safety guard.
pub async fn merge_mr(
    repo_path: &str,
    number: u64,
    strategy: &str,
    delete_branch: bool,
    sha: Option<&str>,
) -> AppResult<()> {
    merge_mr_inner(repo_path, number, strategy, delete_branch, sha, false).await
}

/// The HTTP status behind a failed `glab api` call. glab writes either
/// `glab: <message> (HTTP <code>)` when the error body carried a `message`, or a bare
/// `glab: HTTP <code>` when it didn't (`internal/commands/api/api.go`). Read from the
/// LAST `HTTP ` in the text: GitLab's own message often opens with the code too, and
/// only the trailing one is glab's.
fn glab_http_status(stderr: &str) -> Option<u16> {
    const MARK: &str = "HTTP ";
    let idx = stderr.rfind(MARK)?;
    stderr[idx + MARK.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

/// A refused merge PUT, in the app's own words — `None` for anything else, so an
/// unrecognized failure still surfaces glab's raw text. Only two of the statuses the
/// merge endpoint documents are reworded: `405 Method Not Allowed` ("The merge request
/// cannot merge") and `409` ("SHA does not match HEAD of source branch") — GitLab's
/// `doc/api/merge_requests.md`, "Merge a merge request".
///
/// `arming_auto_merge` holds the 405 arm back: on the arming path GitLab answers 405
/// only when no auto-merge strategy is available AND the head pipeline isn't passing
/// (a passing one merges immediately instead), per v19.3.0 `lib/api/merge_requests.rb`.
/// Which strategies exist is version- and edition-dependent, so glab's own text stays
/// the safer message there.
///
/// The 405 message deliberately doesn't name WHICH requirement is unmet: the
/// mergeability read owns that wording, and the refusal toast carries its line as a
/// note — one place for the reasons, not two that can drift.
fn classify_gl_merge_refusal(stderr: &str, arming_auto_merge: bool) -> Option<String> {
    match glab_http_status(stderr)? {
        405 if !arming_auto_merge => Some(
            "GitLab is blocking this merge — the merge request isn't in a mergeable state yet."
                .to_string(),
        ),
        409 => Some("The merge request changed while merging — refresh and retry.".to_string()),
        _ => None,
    }
}

/// The merge PUT's argv. `sha` is sent only when non-empty — an empty `sha=` would
/// itself be rejected. Arming sends BOTH auto-merge params; the auto-merge section
/// note below carries why.
fn merge_mr_args(
    endpoint: &str,
    squash: bool,
    delete_branch: bool,
    sha: Option<&str>,
    when_pipeline_succeeds: bool,
) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "--method".to_string(),
        "PUT".to_string(),
        endpoint.to_string(),
        "-f".to_string(),
        format!("squash={squash}"),
        "-f".to_string(),
        format!("should_remove_source_branch={delete_branch}"),
    ];
    if let Some(s) = sha.filter(|s| !s.is_empty()) {
        args.push("-f".to_string());
        args.push(format!("sha={s}"));
    }
    if when_pipeline_succeeds {
        args.push("-f".to_string());
        args.push("merge_when_pipeline_succeeds=true".to_string());
        args.push("-f".to_string());
        args.push("auto_merge=true".to_string());
    }
    args
}

/// The shared body behind `merge_mr` and `auto_merge_mr` — same endpoint, same
/// strategy validation, same `sha` guard. The only difference is the extra
/// auto-merge flags, so both wrappers can't drift apart.
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
    // GitLab's merge-time `squash` / `should_remove_source_branch` params can SET but
    // not CLEAR the MR's persisted `squash` / `remove_source_branch` attributes (and
    // which one the deferred merge consults is inconsistent) — so set the attributes
    // first and let the chosen strategy always govern; otherwise an MR the author
    // flagged "squash on accept", or born under the project's delete-source default,
    // ignores the user's choice. This is a pre-mutation guard: if the attribute PUT
    // fails we must NOT fall through to the irreversible merge. (A project with a
    // locked squash policy may reject the PUT; that's a loud toast before any merge.
    // Note the attribute is `remove_source_branch`, not the merge endpoint's
    // `should_remove_source_branch`.)
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
    let args = merge_mr_args(&endpoint, squash, delete_branch, sha, when_pipeline_succeeds);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_glab_raw(Some(repo_path), &arg_refs, GLAB_NETWORK_TIMEOUT).await?;
    if out.code != 0 {
        // Raw rather than `run_glab` only so a documented refusal can be reworded;
        // everything else keeps `run_glab`'s exact fallback.
        let raw = out.stderr.trim();
        return Err(AppError::Glab(
            match classify_gl_merge_refusal(&out.stderr, when_pipeline_succeeds) {
                Some(message) => message,
                None if raw.is_empty() => format!("glab exited with code {}", out.code),
                None => raw.to_string(),
            },
        ));
    }
    // GitLab can also refuse in a body with a ZERO exit — the shape that makes a cancel
    // look successful, and nothing about it is specific to that endpoint. A body without
    // the error marker is success, whatever else it holds.
    if let Some(message) = service_error_message(&out.stdout_lossy()) {
        return Err(AppError::Glab(message));
    }
    Ok(())
}

// ── Merge requests (auto-merge / merge-when-pipeline-succeeds) ─────────────────
//
// GitLab's "auto-merge" (MWPS) arms the merge endpoint to complete server-side once
// the head pipeline goes green — a GitLab-ONLY control (`mr_auto_merge`); GitHub has
// no in-app PR auto-merge here. Arm reuses the merge endpoint, sending BOTH
// `merge_when_pipeline_succeeds=true` (deprecated as a REQUEST param in 17.11) and its
// replacement `auto_merge=true`: pre-17.11 ignores the unknown `auto_merge` and honors
// MWPS, 17.11+ ORs the two into one variable so both-true arms exactly once, and
// `auto_merge` ALONE would merge a pre-17.11 MR immediately rather than arm it (v17.10
// `immediately_mergeable?` falls through to `mergeable_state?`). Only the request param
// moved: the RESPONSE field and the cancel endpoint's path both keep the MWPS name on
// current GitLab (v19.3.0), with no replacement to migrate to.
//
// The read exposes the armed flag + detailed merge status + head-pipeline summary so
// the UI can decide whether to offer it; cancel disarms. A stale `sha` → 409
// (propagates like merge); arming 405s only when no auto-merge strategy is available
// AND the head pipeline isn't passing — a passing one merges immediately instead
// (v19.3.0 `lib/api/merge_requests.rb`). Cancel's gotcha lives on
// `cancel_auto_merge_mr`.

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

/// The MR fields a mergeability read needs, from the slim `merge_requests/{iid}`
/// GET or a list row. Every scalar is null-tolerant — GitLab nulls them while a
/// merge status is still being computed.
#[derive(Deserialize)]
struct GlabMrMergeability {
    #[serde(default, deserialize_with = "null_to_default")]
    iid: u64,
    #[serde(default, deserialize_with = "null_to_default")]
    state: String,
    #[serde(default, deserialize_with = "null_to_default")]
    has_conflicts: Option<bool>,
    #[serde(default, deserialize_with = "null_to_default")]
    detailed_merge_status: String,
    #[serde(default, deserialize_with = "null_to_default")]
    merge_error: Option<String>,
}

/// Map an MR's state + conflict flags onto the neutral shape. EITHER conflict
/// signal is enough: `has_conflicts` outranks `detailed_merge_status` (which
/// reports the first blocking reason — CI, approvals — and can hide a conflict),
/// but GitLab nulls `has_conflicts` while recomputing, and then only the
/// `"conflict"` detailed status carries the truth.
fn map_gl_mergeability(
    state: &str,
    has_conflicts: Option<bool>,
    detailed_merge_status: &str,
    merge_error: Option<&str>,
) -> PrMergeability {
    let detail = merge_error
        .filter(|e| !e.is_empty())
        .map(str::to_string)
        .or_else(|| (!detailed_merge_status.is_empty()).then(|| detailed_merge_status.to_string()));
    if state != "opened" || detailed_merge_status == "not_open" {
        // No detail: "unavailable" means there is no server truth to be had, so a
        // leftover status string would describe a computation that no longer applies.
        return PrMergeability {
            state: "unavailable".to_string(),
            detail: None,
        };
    }
    let state = if has_conflicts == Some(true) || detailed_merge_status == "conflict" {
        "conflicting"
    } else if matches!(
        detailed_merge_status,
        "checking" | "unchecked" | "preparing" | "broken_status" | ""
    ) {
        // Empty included: GitLab has not answered yet, so never claim mergeable.
        // `broken_status` is GitLab's "cannot merge source into target, potential
        // conflict" — an honest "couldn't determine" (which the UI can retry)
        // beats leaning it toward a false all-clear.
        "checking"
    } else {
        "mergeable"
    };
    PrMergeability {
        state: state.to_string(),
        detail,
    }
}

/// One MR's mergeability, from the slim MR GET. Deliberately NO recheck parameter:
/// GitLab documents `with_merge_status_recheck` on the LIST endpoints only and
/// ignores it here. Reading the MR is itself what primes GitLab's asynchronous
/// mergeability check, so a stale status resolves on a later read — which is what
/// the `"checking"` state and the caller's re-poll are for.
pub async fn mr_mergeability(repo_path: &str, number: u64) -> AppResult<PrMergeability> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let mr: GlabMrMergeability = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab merge status: {e}")))?;
    Ok(map_gl_mergeability(
        &mr.state,
        mr.has_conflicts,
        &mr.detailed_merge_status,
        mr.merge_error.as_deref(),
    ))
}

/// Mergeability for a whole MR-list page, keyed by iid. The list read carries the
/// same conflict fields as the single GET, so one call covers the page.
///
/// `with_merge_status_recheck` is valid HERE (the list endpoints document it, the
/// show endpoint does not): it requests — without guaranteeing — an asynchronous
/// recalculation, so rows sitting on a stale `unchecked` start recomputing.
pub async fn mr_list_mergeability(
    repo_path: &str,
    state: &str,
) -> AppResult<HashMap<u64, String>> {
    // Only "open" reaches any provider — `forge_pr_list_mergeability` short-circuits
    // every other filter to an empty map, because a closed/merged row has no live
    // mergeability to report.
    debug_assert_eq!(state, "open", "only the open filter reaches the providers");
    let enc = encode_project(&project_path(repo_path).await?);
    // per_page=100 matches `list_prs`' own deliberate open-state cap, so every row
    // the list can render is answerable here — a limit param would add nothing.
    let endpoint = format!(
        "projects/{enc}/merge_requests?state=opened&per_page=100&with_merge_status_recheck=true"
    );
    let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let rows: Vec<GlabMrMergeability> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab merge requests: {e}")))?;
    let mut out_map: HashMap<u64, String> = HashMap::new();
    for r in rows {
        let m = map_gl_mergeability(
            &r.state,
            r.has_conflicts,
            &r.detailed_merge_status,
            r.merge_error.as_deref(),
        );
        out_map.insert(r.iid, m.state);
    }
    Ok(out_map)
}

/// Arm auto-merge (merge-when-pipeline-succeeds) — the merge endpoint with the MWPS
/// flag set. Same strategy / `sha` / delete-branch semantics as `merge_mr`.
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
// The GitLab fields the still-unwired mutations would need (node id, lock reason,
// pinned, org issue type) are left EMPTY rather than mislabeled — the wired writes
// key on the iid, names, or global ids.

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

/// A GitLab milestone. We keep the GLOBAL `id`, not the `iid`: the milestone write
/// keys on `milestone_id`, and `iid` is project-scoped for project milestones but
/// group-scoped for group ones (a collision waiting to happen). The neutral
/// `Milestone.number` carries this id everywhere on GitLab.
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
    // GitLab returns `null` (not `false`) here when the discussion isn't locked; a
    // present `null` would sink the whole detail parse. See `null_to_default`.
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
pub async fn list_issues(
    repo_path: &str,
    state: &str,
    limit: Option<u32>,
) -> AppResult<Vec<IssueInfo>> {
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
    // GitLab pages at `per_page` (max 100); default to a full page, or cap it to `limit`.
    let per_page = limit.map_or(100, |n| n.clamp(1, 100));
    let endpoint = format!("projects/{enc}/issues?state={gl_state}&per_page={per_page}");
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

    // Resolve the signed-in user once (tolerant — a failure just hides every
    // comment's edit/delete; it must not fail the view). Drives the truthful
    // `viewer_did_author` below.
    let viewer = current_user_login(repo_path).await;

    // Comments — drop GitLab's system notes (auto "changed the milestone", etc.).
    let comments: Vec<PrThreadOut> = run_glab(
        Some(repo_path),
        &[
            "api",
            &format!("projects/{enc}/issues/{number}/notes?sort=asc&per_page=100"),
        ],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|o| serde_json::from_str::<Vec<GlabNote>>(&o.stdout_lossy()).ok())
    .unwrap_or_default()
    .into_iter()
    .filter(|n| !n.system)
    .map(|n| {
        let (author, author_avatar_url) = n
            .author
            .map(|a| (a.username, a.avatar_url))
            .unwrap_or_default();
        PrThreadOut {
            viewer_did_author: note_authored_by_viewer(&author, viewer.as_deref()),
            author,
            author_avatar_url,
            state: String::new(),
            body: n.body,
            date: n.created_at,
            id: n.id.to_string(),
            url: String::new(),
            is_minimized: false,
            minimized_reason: String::new(),
            // GitLab doesn't model review objects — no owning review id.
            review_id: String::new(),
        }
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
                // Detail-view labels come from the MR/issue payload (name + color
                // only), with no description in hand.
                description: None,
            }
        })
        .collect();

    // GitLab supplies the author's avatar directly; carry it so the header shows a
    // real photo instead of a login-derived (GitHub-only) URL.
    let (author, author_avatar_url) = issue
        .author
        .map(|a| (a.username, a.avatar_url))
        .unwrap_or_default();
    Ok(IssueDetails {
        // No GraphQL node id on GitLab; the GitLab mutations key on the iid
        // (labels by name), and the empty id doubles as the reactions "body"
        // subject (`forge_add_reaction` reads "" as the issue body). Sub-issue
        // mutations stay GitHub-only.
        id: String::new(),
        number: issue.iid,
        title: issue.title,
        body: issue.description.unwrap_or_default(),
        author,
        author_avatar_url,
        state: map_issue_state(&issue.state),
        created_at: issue.created_at,
        url: issue.web_url,
        assignees: issue
            .assignees
            .into_iter()
            .map(|a| ForgeUserRef {
                id: a.username.clone(),
                label: a.username,
                avatar_url: a.avatar_url,
                is_bot: false,
            })
            .collect(),
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
// gh_issue_* commands and dispatching through forge_issue_* (labels/assignees/create
// live in their own sections below). The GitHub close `reason` has no GitLab
// analogue, so the dispatch drops it before calling close_issue. `glab api -f
// key=value` is a RAW string field (no `@file` interpretation, unlike `-F`), so a
// body starting with `@` or carrying newlines is safe (glab is a real .exe — no
// BatBadBut shim refusal of newline argv).

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

/// Edit an issue note's body (`PUT …/issues/{n}/notes/{id}`). Empty-body guard +
/// comment-id parse both run BEFORE the request.
pub async fn edit_issue_comment(
    repo_path: &str,
    number: u64,
    comment_id: &str,
    body: &str,
) -> AppResult<()> {
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    let note_id = parse_note_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/notes/{note_id}");
    let body_arg = format!("body={body}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "PUT", &endpoint, "-f", &body_arg],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Delete an issue note (`DELETE …/issues/{n}/notes/{id}`). Comment-id parse runs
/// BEFORE the request.
pub async fn delete_issue_comment(repo_path: &str, number: u64, comment_id: &str) -> AppResult<()> {
    let note_id = parse_note_id(comment_id)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/issues/{number}/notes/{note_id}");
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &endpoint],
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

/// The destination project's numeric id, resolved from its full path for the move.
#[derive(Deserialize)]
struct GlabMoveTarget {
    id: u64,
}

/// The moved issue's URL, read back from the move response.
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
        // GitLab folds several causes into this one message — a target project with
        // issues DISABLED, not just a permission gap. Spell out both.
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
// Everything keys on GitLab's GLOBAL milestone id (see `GlabMilestone`): the list
// returns it as the neutral `Milestone.number`, the issue detail carries the same
// id, and the write sends it as `milestone_id`. `milestone_id=0` clears.

/// Active milestones for the milestone picker — project milestones plus ancestor
/// group milestones (`include_ancestor_groups=true`; GitLab issues commonly use a
/// group milestone, and the global-id write accepts either kind).
pub async fn list_milestones(repo_path: &str) -> AppResult<Vec<Milestone>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint =
        format!("projects/{enc}/milestones?state=active&include_ancestor_groups=true&per_page=100");
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
// GitLab reactions are "award emoji" on issues, MRs, and notes, mapped onto the same
// neutral `IssueReactions`/`Reaction` shape as GitHub, with GitLab's award names
// translated to GitHub's ReactionContent enum (the 8 the ReactionBar knows); awards
// outside that set are dropped from our tallies and stay visible on GitLab itself.
// Reads: notes' awards come from ONE GraphQL query (`Note.awardEmoji`, with
// `currentUser` riding along) — per-note REST reads would be N+1 glab spawns; BODY
// awards come from GraphQL for MRs but REST for issues, because the GraphQL `Issue`
// type exposes NO `awardEmoji` field. Writes are REST: add = `POST …/award_emoji -f
// name=<award>` (a duplicate add 404s "has already been taken" = already-on),
// remove = list, find the viewer's award by name, DELETE by id.
// KNOWN CAP: every award list covers the first 100 awards per subject — past that
// tallies undercount and a remove beyond the page silently no-ops until a refetch.

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
        .and_then(|p| {
            if target_field == "issue" {
                p.issue
            } else {
                p.merge_request
            }
        })
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
// Third-party AI reviewers post findings as MR discussion notes; each NON-system
// note maps onto the neutral `ExternalReviewItem` the frontend already consumes for
// GitHub, so its budgeting / prompt layers stay unchanged. GitLab REST authors carry
// NO bot flag (unlike GitHub's GraphQL `__typename`), so `is_bot` is NOT meaningful
// here — the frontend applies its `REVIEWER_BOTS` login allowlist to EVERY GitLab
// item regardless of kind (otherwise a human's inline comment would pose as an AI
// finding). GitHub, with a server-verified bot flag, still lets inline/review items
// bypass the list.

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
        (
            position.new_path.clone(),
            position.new_line.unwrap_or(0),
            "new",
        )
    } else if position.old_line.is_some() && !position.old_path.is_empty() {
        (
            position.old_path.clone(),
            position.old_line.unwrap_or(0),
            "old",
        )
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
    /// `sha1_hex(file_path)_<old_pos>_<new_pos>` — GitLab's own multi-line highlight
    /// key. API-created ranges (ours pre-echo, or another client's) may carry ONLY
    /// this, with the explicit line field null, so it's a fallback source for the
    /// side-matched line. Option per the untrusted-JSON rule.
    #[serde(default)]
    line_code: Option<String>,
    /// The ref's side ("new"/"old"); present on API-created refs. We resolve the side
    /// from the note's anchor, not this field, so it's captured for shape-tolerance
    /// only (accepts GitLab's `type` key without erroring). Untrusted → Option.
    #[serde(default, rename = "type")]
    #[allow(dead_code)]
    ref_type: Option<String>,
}

/// Resolve a range ref's line for `side` ("new"/"old"): the explicit side-matched
/// field first (`new_line` for the new side, `old_line` for the old), else the
/// trailing `_<old_pos>_<new_pos>` parsed out of `line_code` (picking the old part
/// for the old side, the new part for the new side). `None` when neither yields a
/// value — a garbage or absent `line_code` and no explicit field. Pure (testable).
fn gl_range_ref_line(r: &GlabLineRangeRef, side: &str) -> Option<u32> {
    let explicit = if side == "old" {
        r.old_line
    } else {
        r.new_line
    };
    if explicit.is_some() {
        return explicit;
    }
    let code = r.line_code.as_deref()?;
    // The last two `_`-separated segments are `<old_pos>_<new_pos>`.
    let mut parts = code.rsplitn(3, '_');
    let new_pos = parts.next()?.parse::<u32>().ok()?;
    let old_pos = parts.next()?.parse::<u32>().ok()?;
    // Require a non-empty prefix (the sha1) so a bare `"_1_2"` isn't accepted.
    let prefix = parts.next()?;
    if prefix.is_empty() {
        return None;
    }
    Some(if side == "old" { old_pos } else { new_pos })
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

/// Maps a discussion note onto the neutral `ExternalReviewItem`, or `None` for a
/// system note (which must never enter the findings pipeline). Positioned (DiffNote)
/// notes become `kind == "inline"` with a path/line; everything else is `"comment"`.
/// `is_bot` is always true but NOT meaningful for GitLab (see the section note — the
/// frontend's `REVIEWER_BOTS` allowlist is the real gate). Per-item: a malformed
/// field falls back to a default rather than sinking the batch.
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
        // GitLab REST authors carry no bot flag — a placeholder that keeps the shared
        // shape non-empty; the frontend's `REVIEWER_BOTS` allowlist is the real gate.
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
        let endpoint =
            format!("projects/{enc}/merge_requests/{number}/discussions?per_page=100&page={page}");
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

/// Third-party AI-reviewer findings on a merge request, mapped onto the same neutral
/// shape GitHub uses — every non-system note of the MR's discussions.
pub async fn external_reviews(repo_path: &str, number: u64) -> AppResult<Vec<ExternalReviewItem>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let discussions = fetch_mr_discussions(repo_path, &enc, number).await?;
    Ok(external_items_from_discussions(&discussions))
}

/// File:line-anchored review threads on an MR — positioned diff-note discussions
/// mapped onto `ReviewThreadOut`. A thread is a discussion with at least one
/// non-system positioned note; path/line come from the first such note (see
/// `gl_thread_anchor`), resolution from the first resolvable one (GitLab resolves
/// whole discussions, not individual notes), `start_line` from a multi-line note's
/// `position.line_range` (0 when single-line). GitLab's flat discussions API exposes
/// no per-thread "outdated" bit nor a diff excerpt, so `is_outdated` is always false
/// and `diff_hunk` always empty.
pub async fn review_threads(repo_path: &str, number: u64) -> AppResult<Vec<ReviewThreadOut>> {
    let enc = encode_project(&project_path(repo_path).await?);
    let discussions = fetch_mr_discussions(repo_path, &enc, number).await?;

    // Resolve the signed-in user once, tolerantly — a failure just hides every
    // comment's edit/delete (drives `viewer_did_author`), it must not fail the read.
    let viewer = current_user_login(repo_path).await;

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
            .and_then(|s| gl_range_ref_line(s, side))
            .unwrap_or(0);
        // GitLab resolves whole discussions; the resolvable notes share one state.
        let is_resolved = notes
            .iter()
            .find(|n| n.resolvable)
            .map(|n| n.resolved == Some(true))
            .unwrap_or(false);
        let comments: Vec<PrThreadOut> = notes
            .iter()
            .map(|n| {
                let (author, author_avatar_url) = n
                    .author
                    .as_ref()
                    .map(|a| (a.username.clone(), a.avatar_url.clone()))
                    .unwrap_or_default();
                PrThreadOut {
                    viewer_did_author: note_authored_by_viewer(&author, viewer.as_deref()),
                    author,
                    author_avatar_url,
                    state: String::new(),
                    body: n.body.clone(),
                    date: n.created_at.clone(),
                    id: n.id.to_string(),
                    url: String::new(),
                    is_minimized: false,
                    minimized_reason: String::new(),
                    // GitLab doesn't model review objects — no owning review id.
                    review_id: String::new(),
                }
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
            // No diff excerpt on the note — the frontend falls back to the MR diff
            // at the anchored line.
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

/// The MR's `diff_refs` (`base_sha` / `start_sha` / `head_sha`) — the three SHAs a
/// positioned diff note anchors against.
#[derive(Deserialize)]
struct GlabDiffRefs {
    #[serde(default)]
    base_sha: String,
    #[serde(default)]
    start_sha: String,
    #[serde(default)]
    head_sha: String,
}

/// Fetch an MR's `diff_refs`. Errors clearly when GitLab omits them (a not-yet-diffable
/// MR), before any write.
async fn mr_diff_refs(repo_path: &str, enc: &str, number: u64) -> AppResult<GlabDiffRefs> {
    #[derive(Deserialize)]
    struct GlabMrDiffRefs {
        #[serde(default)]
        diff_refs: Option<GlabDiffRefs>,
    }
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}/merge_requests/{number}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let mr: GlabMrDiffRefs = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab merge request: {e}")))?;
    mr.diff_refs.ok_or_else(|| {
        AppError::Glab("this merge request has no diff refs to anchor a comment against.".into())
    })
}

/// Create a NEW file:line-anchored review thread on an MR (`POST …/discussions` with
/// the nested `position` JSON via `--input -` — flat `-f position[x]=y` is SILENTLY
/// ignored by GitLab). `side` is `"new"`/`"old"` (old → `old_path`/`old_line`).
/// `start_line`, when set and different from `line`, makes it a MULTI-LINE range from
/// the MR's per-file diffs; an unresolvable file or line falls back to line_code-less
/// refs, so the post never fails over line_code. A single-line call sends the
/// identical payload it always has.
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
    if body.trim().is_empty() {
        return Err(AppError::InvalidArgument("a comment is required".into()));
    }
    if path.is_empty() {
        return Err(AppError::InvalidArgument("a file path is required".into()));
    }
    if side != "new" && side != "old" {
        return Err(AppError::InvalidArgument(format!("invalid side: {side}")));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let refs = mr_diff_refs(repo_path, &enc, number).await?;
    let mut position = serde_json::json!({
        "base_sha": refs.base_sha,
        "start_sha": refs.start_sha,
        "head_sha": refs.head_sha,
        "position_type": "text",
    });
    if side == "old" {
        position["old_path"] = serde_json::Value::String(path.to_string());
        position["old_line"] = serde_json::Value::from(line);
    } else {
        position["new_path"] = serde_json::Value::String(path.to_string());
        position["new_line"] = serde_json::Value::from(line);
    }
    // Multi-line range: attach `line_range` computed from the MR's per-file diffs.
    if let Some(start) = start_line.filter(|s| *s != line) {
        let changes = fetch_mr_changes(repo_path, &enc, number).await;
        position["line_range"] = gl_range_from_changes(&changes, path, side, start, line);
    }
    let payload = serde_json::json!({ "body": body, "position": position });
    let endpoint = format!("projects/{enc}/merge_requests/{number}/discussions");
    run_glab_ex(
        Some(repo_path),
        &json_body_args("POST", &endpoint),
        Some(&payload.to_string()),
        &[],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Submit a review on an MR — SEQUENTIAL (GitLab draft notes are invisible until
/// bulk-published, so we stage them, publish, then apply the verdict). The summary
/// (when present) is a plain draft note; each comment is a positioned draft note
/// (nested `position` JSON via `--input -`). Then `draft_notes/bulk_publish`, then
/// the verdict (approve / request-changes reuse the existing fns; comment does
/// nothing extra). Partial failure STOPS at the first error and discloses exactly
/// what landed (never claims success on partial state). Guards run in the dispatch.
pub async fn review_submit(
    repo_path: &str,
    number: u64,
    verdict: &str,
    summary: Option<&str>,
    comments: &[DraftCommentIn],
) -> AppResult<ReviewSubmitOut> {
    let enc = encode_project(&project_path(repo_path).await?);
    let draft_endpoint = format!("projects/{enc}/merge_requests/{number}/draft_notes");
    let total = comments.len() as u32;
    let has_summary = summary.map(str::trim).is_some_and(|s| !s.is_empty());
    // `bulk_publish` on an EMPTY draft set fails with a misleading error, so an
    // approve-only review (no summary, no comments) stages nothing and skips
    // straight to the verdict.
    let staged_any = has_summary || !comments.is_empty();

    // The diff refs anchor every positioned draft note; fetch once (only when there
    // are inline comments — a summary-only review needs no anchoring).
    let refs = if comments.is_empty() {
        None
    } else {
        Some(mr_diff_refs(repo_path, &enc, number).await?)
    };

    // Multi-line ranges need the MR's per-file diffs to compute `line_code`. Fetch
    // ONCE, lazily — only when at least one comment actually carries a range (a
    // `start_line` that differs from its `line`) — and reuse across every ranged
    // comment. Comments without a range keep byte-identical payloads.
    let changes = if comments
        .iter()
        .any(|c| c.start_line.is_some_and(|s| s != c.line))
    {
        Some(fetch_mr_changes(repo_path, &enc, number).await)
    } else {
        None
    };

    // The summary → a plain draft note. Failure here means nothing landed yet.
    if let Some(s) = summary.filter(|s| !s.trim().is_empty()) {
        let note_arg = format!("note={s}");
        run_glab(
            Some(repo_path),
            &["api", "--method", "POST", &draft_endpoint, "-f", &note_arg],
            GLAB_NETWORK_TIMEOUT,
        )
        .await
        .map_err(|e| {
            AppError::Glab(format!(
                "The review summary couldn't be saved as a draft, so the review was not \
                 submitted: {e}"
            ))
        })?;
    }

    // Each comment → a positioned draft note. Stop at the first failure and disclose.
    for (i, c) in comments.iter().enumerate() {
        let refs = refs.as_ref().expect("refs fetched when comments present");
        let mut position = serde_json::json!({
            "base_sha": refs.base_sha,
            "start_sha": refs.start_sha,
            "head_sha": refs.head_sha,
            "position_type": "text",
        });
        if c.side == "old" {
            position["old_path"] = serde_json::Value::String(c.path.clone());
            position["old_line"] = serde_json::Value::from(c.line);
        } else {
            position["new_path"] = serde_json::Value::String(c.path.clone());
            position["new_line"] = serde_json::Value::from(c.line);
        }
        // Multi-line range: attach `line_range` from the pre-fetched change set.
        if let Some(start) = c.start_line.filter(|s| *s != c.line) {
            let changes = changes.as_deref().unwrap_or(&[]);
            position["line_range"] =
                gl_range_from_changes(changes, &c.path, &c.side, start, c.line);
        }
        let payload = serde_json::json!({ "note": c.body, "position": position });
        if let Err(e) = run_glab_ex(
            Some(repo_path),
            &json_body_args("POST", &draft_endpoint),
            Some(&payload.to_string()),
            &[],
            GLAB_NETWORK_TIMEOUT,
        )
        .await
        {
            return Err(AppError::Glab(format!(
                "Saved {} of {} review comments as drafts before the failure; the review was \
                 not submitted. Check the merge request on GitLab before retrying. ({e})",
                i, total
            )));
        }
    }

    // Publish all drafts at once — only when something was staged (see `staged_any`).
    // A failure here leaves the drafts staged (invisible).
    if staged_any {
        let publish_endpoint = format!("{draft_endpoint}/bulk_publish");
        run_glab(
            Some(repo_path),
            &["api", "--method", "POST", &publish_endpoint],
            GLAB_NETWORK_TIMEOUT,
        )
        .await
        .map_err(|e| {
            AppError::Glab(format!(
                "The review's draft notes couldn't be published, so the review was not \
                 submitted. Check the merge request on GitLab before retrying. ({e})"
            ))
        })?;
    }

    // Apply the verdict. Approve / request-changes reuse the existing fns; comment
    // needs nothing extra. The review CONTENT already published above, so a verdict
    // failure must disclose that — otherwise a retry double-posts every comment.
    let verdict_result = match verdict {
        "approve" => approve_pr(repo_path, number).await,
        "request_changes" => request_changes_mr(repo_path, number, "").await,
        _ => Ok(()),
    };
    if let Err(e) = verdict_result {
        let action = if verdict == "approve" {
            "approve"
        } else {
            "request changes"
        };
        // Only mention what actually landed (an approve-only review published nothing).
        let landed = if staged_any {
            let n = if has_summary { total + 1 } else { total };
            format!(
                "the {n} review note(s) were already posted successfully — do NOT resubmit \
                 them; "
            )
        } else {
            String::new()
        };
        return Err(AppError::Glab(format!(
            "The review was posted, but the {action} step failed: {landed}only re-run the \
             {action} action on GitLab. ({e})"
        )));
    }

    Ok(ReviewSubmitOut {
        posted: total,
        total,
        verdict_applied: verdict != "comment",
    })
}

/// The award endpoint for a subject: the issue/MR body (`note_id` None) or one
/// of its notes. `target` is `"issue"` or `"mr"`.
fn award_endpoint(
    enc: &str,
    target: &str,
    number: u64,
    note_id: Option<&str>,
) -> AppResult<String> {
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
// Labels are a SHARED control on issues and MRs (GitHub keys them by node id, GitLab
// by name); issue assignees are a shared issue control. Writes apply a delta for
// labels (`add_labels`/`remove_labels` by name) and a full set for assignees
// (`assignee_ids=<comma-joined ids>`, `=0` clears). GitLab assigns by NUMERIC id, so
// the write resolves usernames→ids from the members list; the `assignee_ids[]=…`
// array form 400s through glab's `-f`, hence the comma form. On the Free tier GitLab
// keeps only the first id (reconciled by refetch). The same PUT works on MRs.

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
            description: l.description,
        })
        .collect())
}

/// A GitLab project member (assignee candidate). `id` is required to SET assignees —
/// GitLab assigns by numeric id, not username, so the write resolves usernames→ids.
#[derive(Deserialize)]
struct GlabMember {
    id: u64,
    username: String,
    /// Profile image; GitLab sends `null` when unset, so coerce to "".
    #[serde(default, deserialize_with = "null_to_default")]
    avatar_url: String,
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
    let by_name: HashMap<&str, u64> = members
        .iter()
        .map(|m| (m.username.as_str(), m.id))
        .collect();
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

/// The project's assignable users as `ForgeUserRef`s (with avatars), mirroring the
/// reviewer candidates. `members/all` can list a user twice (direct + inherited), so
/// dedupe by username.
pub async fn assignable_users(repo_path: &str) -> AppResult<Vec<ForgeUserRef>> {
    let mut seen = std::collections::HashSet::new();
    Ok(project_members(repo_path)
        .await?
        .into_iter()
        .filter(|m| seen.insert(m.username.clone()))
        .map(|m| ForgeUserRef {
            id: m.username.clone(),
            label: m.username,
            avatar_url: m.avatar_url,
            is_bot: false,
        })
        .collect())
}

/// The reviewer picker's candidates for a GitLab MR: the project members, keyed by
/// username (deduped) — the same id space the setter resolves and the MR-detail
/// read fills. GitLab tolerates the author as a reviewer, so `number` is unused (no
/// author exclusion, matching the assignee picker).
pub async fn reviewer_candidates(
    repo_path: &str,
    _number: Option<u64>,
) -> AppResult<Vec<ForgeUserRef>> {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<ForgeUserRef> = project_members(repo_path)
        .await?
        .into_iter()
        .filter(|m| seen.insert(m.username.clone()))
        .map(|m| ForgeUserRef {
            id: m.username.clone(),
            label: m.username,
            avatar_url: m.avatar_url,
            is_bot: false,
        })
        .collect();
    out.sort_by_key(|a| a.label.to_lowercase());
    Ok(out)
}

/// Replace an MR's reviewers with `desired` (usernames): resolve username→numeric
/// id via the project members and PUT `reviewer_ids` (empty clears). ⚠ GitLab's
/// Free tier keeps only the FIRST reviewer id (validated in `request_changes_mr`),
/// so a multi-reviewer request silently drops the rest — we re-read and DISCLOSE
/// any dropped reviewer rather than reporting a clean success (Premium keeps all).
pub async fn set_pr_reviewers(repo_path: &str, number: u64, desired: &[String]) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    // A resolution miss errors inside the resolver (fail safe — never a partial set).
    let ids: Vec<u64> = if desired.is_empty() {
        Vec::new()
    } else {
        resolve_assignee_ids(repo_path, desired).await?
    };
    set_mr_reviewer_ids(repo_path, &enc, number, &ids).await?;
    if desired.is_empty() {
        return Ok(());
    }
    // Verify the write stuck (the Free single-reviewer tier drops extras).
    let now: std::collections::HashSet<String> = mr_reviewers(repo_path, &enc, number)
        .await?
        .into_iter()
        .filter_map(|r| r.user.map(|u| u.username))
        .collect();
    let dropped: Vec<String> = desired
        .iter()
        .filter(|d| !now.contains(*d))
        .cloned()
        .collect();
    if !dropped.is_empty() {
        return Err(AppError::Glab(format!(
            "GitLab didn't set reviewer(s) {} — this GitLab tier may allow only one \
             reviewer per merge request. Please verify the reviewers on GitLab.",
            dropped.join(", ")
        )));
    }
    Ok(())
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
pub async fn set_mr_assignees(repo_path: &str, number: u64, assignees: &[String]) -> AppResult<()> {
    set_target_assignees(repo_path, "merge_requests", number, assignees).await
}

// ── Repository actions & publish ──────────────────────────────────────────────
//
// View (web URL), star/unstar, and publishing a local repo to GitLab. Forking stays
// a web link-out for GitLab, and the admin-settings / branch-rule-import
// sub-surfaces stay GitHub-only — the frontend guards those on the provider, not
// just `repo_actions`. Re-starring returns HTTP 304 (treated as already-done).
// `glab repo create <name>` creates the project (visibility / description /
// repeated `-t` topics all land) but does NOT wire a remote — the publish flow adds
// `origin` itself and pushes with the one-shot glab credential helper.

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

/// The project's visibility (`public` / `internal` / `private`, already
/// lowercase from GitLab) plus fork provenance. Reuses the same `projects/{enc}`
/// read the settings fetch uses, with a minimal shape — `forked_from_project` is
/// the upstream project embed GitLab returns for a fork (null otherwise), so
/// fork-ness rides the same round-trip.
#[derive(Deserialize)]
struct GlabProjectVisibility {
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    forked_from_project: Option<GlabForkParent>,
}

/// The `forked_from_project` embed — only its full path is needed for the badge.
#[derive(Deserialize)]
struct GlabForkParent {
    #[serde(default)]
    path_with_namespace: Option<String>,
}

pub async fn repo_visibility(repo_path: &str) -> AppResult<crate::forge::RepoVisibilityRaw> {
    let enc = encode_project(&project_path(repo_path).await?);
    let out = run_glab(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let p: GlabProjectVisibility = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the GitLab project: {e}")))?;
    let is_fork = p.forked_from_project.is_some();
    let parent = p
        .forked_from_project
        .and_then(|f| f.path_with_namespace)
        .filter(|s| !s.is_empty());
    Ok(crate::forge::RepoVisibilityRaw {
        visibility: p.visibility,
        is_fork,
        parent,
    })
}

/// Remove the project's fork relationship (`DELETE projects/{enc}/fork`). Requires
/// admin or project Owner — a non-Owner's 403 bubbles up as an honest toast. Side
/// effect: any open merge requests from the fork to the source are CLOSED, and stay
/// closed even if the relationship is later re-established.
pub async fn remove_fork_relationship(repo_path: &str) -> AppResult<()> {
    let enc = encode_project(&project_path(repo_path).await?);
    run_glab(
        Some(repo_path),
        &["api", "--method", "DELETE", &format!("projects/{enc}/fork")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
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
    // `search` also matches names/descriptions, so walk pages (capped) rather than
    // trust page 1.
    for page in 1..=10u32 {
        let endpoint = format!(
            "users/{}/starred_projects?search={}&per_page=100&page={page}",
            me.id,
            encode_query_value(name)
        );
        let out = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        let starred: Vec<GlabStarredProject> = serde_json::from_str(&out.stdout_lossy())
            .map_err(|e| AppError::Glab(format!("could not parse GitLab starred projects: {e}")))?;
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
                if stderr.contains("ambiguous argument") || stderr.contains("unknown revision") =>
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
    // The branch rides the publish push's refspec — validate it here, still
    // before the create.
    crate::git::branches::validate_ref_name(&branch)?;
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
    // A plain-http instance can only get inert `credential.https://…` entries, so skip
    // the injection — and with it a hard `GlabNotFound` that would block the push for
    // nothing. The https path keeps `?`: glab got us this far, so its absence is real.
    let config = if crate::forge::is_https_remote(&project.http_url_to_repo) {
        clone_credential_config(&project.http_url_to_repo).await?
    } else {
        Vec::new()
    };
    let mut push_args: Vec<&str> = Vec::new();
    for entry in &config {
        push_args.push("-c");
        push_args.push(entry);
    }
    let spec = crate::git::remote::publish_refspec(&branch);
    push_args.extend(["push", "-u", "origin", &spec]);
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
// Both creates POST through `glab api` and return the same neutral `PrRef` the
// GitHub creates return, so the dialogs stay provider-agnostic. Issue create takes
// `labels=<csv>` (names), `assignee_ids=<csv>` (numeric ids resolved from
// usernames) and `milestone_id=<global id>`; MR create takes
// source/target/title/description, with **draft = the `Draft:` title prefix**
// (GitLab has no draft field on create — the response then carries `draft: true`).
// A created issue's `web_url` comes back in GitLab's newer `/-/work_items/<iid>` form.

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
#[allow(clippy::too_many_arguments)]
pub async fn create_mr(
    state: &AppState,
    repo_path: &str,
    base: &str,
    head: &str,
    title: &str,
    body: &str,
    draft: bool,
    labels: &[String],
    assignees: &[String],
) -> AppResult<PrRef> {
    for b in [base, head] {
        // The shared ref validator (empty / leading `-` / refspec metacharacters);
        // remapped so this surface keeps its own wording.
        crate::git::branches::validate_ref_name(b)
            .map_err(|_| AppError::InvalidArgument(format!("invalid branch: {b}")))?;
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::InvalidArgument("an MR title is required".into()));
    }

    // Resolve assignee usernames→ids up front (before the push), so a resolution
    // miss aborts cleanly rather than leaving a branch pushed with no MR opened.
    let assignee_ids = if assignees.is_empty() {
        Vec::new()
    } else {
        resolve_assignee_ids(repo_path, assignees).await?
    };

    // An MR needs the branch on the remote first.
    let origin =
        crate::git::remote::git_remote_url(repo_path.to_string(), "origin".to_string()).await?;
    // Same http gate as `publish_repo`: inert entries aren't worth a hard `GlabNotFound`.
    let config = if crate::forge::is_https_remote(&origin) {
        clone_credential_config(&origin).await?
    } else {
        Vec::new()
    };
    let mut push_args: Vec<&str> = Vec::new();
    for entry in &config {
        push_args.push("-c");
        push_args.push(entry);
    }
    let spec = crate::git::remote::publish_refspec(head);
    push_args.extend(["push", "-u", "origin", &spec]);
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
    let mut args = vec![
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
    ];
    // Labels travel as a comma-joined name list; assignees as comma-joined ids
    // (resolved above). Omitted entirely when empty so create behavior is unchanged.
    let labels_arg = format!("labels={}", labels.join(","));
    if !labels.is_empty() {
        args.push("-f");
        args.push(&labels_arg);
    }
    let assignees_arg = format!(
        "assignee_ids={}",
        assignee_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    if !assignee_ids.is_empty() {
        args.push("-f");
        args.push(&assignees_arg);
    }
    let out = run_glab(Some(repo_path), &args, GLAB_NETWORK_TIMEOUT).await?;
    let created: GlabCreated = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the created merge request: {e}")))?;
    Ok(PrRef {
        number: created.iid,
        url: created.web_url,
    })
}

// ── Pipelines (CI, read) ──────────────────────────────────────────────────────
//
// GitLab pipelines map onto the neutral `WorkflowRun`/`RunDetail`/`RunJob` the
// GitHub Actions panels render. Two model gaps we bridge: GitLab has ONE `status`
// per pipeline/job where GitHub splits lifecycle from result (`map_ci_status`
// collapses one onto both); and GitLab is pipeline → jobs with no per-job steps via
// the API, so GitLab jobs map to neutral jobs with an empty `steps` list (logs are
// per-job, `/jobs/<id>/trace`). GitLab's retry restarts failed+canceled jobs only —
// there is no "re-run all" on an existing pipeline, so that control stays
// GitHub-only in the UI.

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

/// Map a GitLab job `status` onto the check-status vocabulary the PR-view rollup
/// keys on (`ChecksRollup.checkPresentation`, matched uppercased). `SKIPPED` is its
/// own muted bucket; everything unrecognized or in flight → PENDING, and `manual`
/// stays pending because it's blocked on a human, not skipped. Pure (unit-tested).
fn map_job_check_status(status: &str) -> String {
    match status {
        "success" => "SUCCESS",
        "failed" => "FAILURE",
        "canceled" | "cancelled" => "CANCELLED",
        "skipped" => "SKIPPED",
        // Anything else (running / pending / manual / created / a new state) →
        // the frontend's pending bucket.
        _ => "PENDING",
    }
    .to_string()
}

/// The MR head pipeline's jobs mapped onto the PR-view check rollup. Best-effort: a
/// missing pipeline or a failed jobs fetch yields an empty list (checks are additive
/// to the view, never fatal). Each job carries its own `web_url` (link-out) plus the
/// pipeline id as `run_id` and the job id as `job_id` (both stringified — GitLab ids
/// exceed the JS safe-int range) so the frontend's inline log peek routes `job_id`
/// through `forge_ci_job_logs`.
async fn pipeline_checks(repo_path: &str, enc: &str, pipeline_id: u64) -> Vec<PrCheckOut> {
    let endpoint = format!("projects/{enc}/pipelines/{pipeline_id}/jobs?per_page=100");
    let jobs: Vec<GlabJob> = run_glab(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT)
        .await
        .ok()
        .and_then(|o| serde_json::from_str::<Vec<GlabJob>>(&o.stdout_lossy()).ok())
        .unwrap_or_default();
    let run_id = pipeline_id.to_string();
    jobs.into_iter()
        .map(|j| PrCheckOut {
            name: j.name,
            status: map_job_check_status(&j.status),
            details_url: Some(j.web_url).filter(|u| !u.is_empty()),
            run_id: Some(run_id.clone()),
            job_id: Some(j.id.to_string()),
            started_at: Some(j.started_at).filter(|s| !s.is_empty()),
            completed_at: Some(j.finished_at).filter(|s| !s.is_empty()),
        })
        .collect()
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
        let named = after[digits_end..]
            .strip_prefix(':')
            .unwrap_or(&after[digits_end..]);
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
        &[
            "api",
            &format!("projects/{enc}/pipelines/{run_id}/jobs?per_page=100"),
        ],
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
        &[
            "api",
            &format!("projects/{enc}/pipelines/{run_id}/jobs?per_page=100"),
        ],
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

/// Retry a pipeline (`run_id` = the global pipeline id the runs list carries).
/// GitLab restarts the failed + canceled jobs — the analogue of GitHub's "re-run
/// failed jobs" (see the section note).
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

/// A key for a variable passed when running a pipeline manually — it becomes an
/// environment variable in the jobs, so `[A-Za-z_][A-Za-z0-9_]*` (no leading
/// digit). [`validate_variable_key`] shares the charset but guards the stored
/// project CI/CD variables, permits a leading digit, and caps length — that
/// difference is why the two aren't folded.
fn valid_pipeline_variable_key(k: &str) -> bool {
    !k.is_empty()
        && !k.starts_with(|c: char| c.is_ascii_digit())
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The manual-pipeline body. `variables[]` is a nested array, the shape flat
/// `-f` fields can't express — which is why this request goes over stdin.
fn pipeline_body(git_ref: &str, vars: Vec<serde_json::Value>) -> serde_json::Value {
    serde_json::json!({ "ref": git_ref, "variables": vars })
}

/// Manually run a new pipeline on a ref — GitLab's analogue of a workflow
/// dispatch. `variables` POST as the REST `variables[]` array over stdin, so a
/// value a user typed never reaches argv (nor any flag-encoding rules).
pub async fn run_pipeline(
    repo_path: &str,
    git_ref: &str,
    variables: &HashMap<String, String>,
) -> AppResult<()> {
    if git_ref.is_empty() || git_ref.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid ref: {git_ref}")));
    }
    let mut vars = Vec::with_capacity(variables.len());
    for (k, v) in variables {
        if !valid_pipeline_variable_key(k) {
            return Err(AppError::InvalidArgument(format!(
                "invalid variable name: {k} (letters, digits and _ only)"
            )));
        }
        vars.push(serde_json::json!({ "key": k, "value": v }));
    }
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/pipeline");
    let body = pipeline_body(git_ref, vars);
    run_glab_ex(
        Some(repo_path),
        &json_body_args("POST", &endpoint),
        Some(&body.to_string()),
        &[],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Releases (read) ───────────────────────────────────────────────────────────
//
// GitLab releases map onto the neutral `ReleaseInfo`/`ReleaseDetails` the GitHub
// Tags panel renders. Model gaps: GitLab has no draft or prerelease (both map to
// `false`); no per-release "latest" flag — the list comes back `released_at`-desc, so
// we mark the newest non-upcoming one; the release web URL is `_links.self`, not a
// top-level `web_url`; and assets are `links` (named URLs, no size/downloads) plus
// auto-generated source archives — we surface only the user `links`, mirroring `gh`,
// with size/downloads 0 so the UI renders plain external links. The GitHub-only
// draft / prerelease / latest toggles are dropped by the forge dispatch before
// reaching the writes at the end of this section.

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

/// Mark the newest non-upcoming release "latest" (the list is `released_at`-desc);
/// every other row, and any upcoming one, stays non-latest.
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
    crate::git::ops::validate_tag_name(tag)?;
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
    crate::git::ops::validate_tag_name(tag)?;
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
    crate::git::ops::validate_tag_name(tag)?;
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
    crate::git::ops::validate_tag_name(tag)?;
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
    crate::git::ops::validate_tag_name(tag)?;
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
    crate::git::ops::validate_tag_name(tag)?;
    if asset_name.is_empty() {
        return Err(AppError::InvalidArgument(
            "an asset name is required".into(),
        ));
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
// The project-settings surface (`GET/PUT projects/:id` + the lifecycle endpoints).
// GitLab's settings model differs from GitHub's where it matters — per-feature
// ACCESS LEVELS (enabled/private/disabled) instead of has_* booleans, one
// `merge_method` enum instead of three allow-flags, a `squash_option` enum — so it
// travels as its own `GitLabRepoSettings` shape and the frontend renders a
// GitLab-shaped General section rather than a lossy mapping onto the GitHub types.
// The lifecycle actions DO share GitHub's parameter shapes and dispatch behind
// neutral `forge_repo_*` commands.

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

/// The viewer's effective access level, plus why the membership fallback
/// couldn't answer when it failed. An unanswered fallback makes `level` a FLOOR
/// (the fallback only ever raises it), never a denial.
struct EffectiveAccess {
    level: u8,
    ambiguous: Option<String>,
}

/// The viewer's access level from the effective-membership endpoint:
/// `Ok(Some(level))` when it answered, `Ok(None)` on a 404 (GitLab saying the
/// viewer is genuinely not a member), `Err(reason)` when it couldn't answer.
async fn membership_access_level(repo_path: &str, enc: &str) -> Result<Option<u8>, String> {
    let user = current_user(repo_path)
        .await
        .map_err(|e| format!("could not identify the signed-in GitLab user: {e}"))?;
    let endpoint = format!("projects/{enc}/members/all/{}", user.id);
    let out = run_glab_raw(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT)
        .await
        .map_err(|e| format!("could not read GitLab project membership: {e}"))?;
    if out.code != 0 {
        let stdout = out.stdout_lossy();
        if glab_output_is_404(&out.stderr, &stdout) {
            return Ok(None);
        }
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            format!("glab exited with code {} reading project membership", out.code)
        } else {
            msg.to_string()
        });
    }
    serde_json::from_str::<GlabAccessLevel>(&out.stdout_lossy())
        .map(|m| Some(m.access_level))
        .map_err(|e| format!("could not parse GitLab project membership: {e}"))
}

/// The viewer's effective access level on the project (0 when they have none) —
/// the shared resolution behind the admin and write-access probes. `enc` is the
/// already-encoded project id, so a caller that needs the raw path doesn't
/// resolve it twice.
async fn effective_access_level(repo_path: &str, enc: &str) -> AppResult<EffectiveAccess> {
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
    let mut ambiguous = None;
    if level < 40 {
        match membership_access_level(repo_path, enc).await {
            Ok(Some(inherited)) => level = level.max(inherited),
            Ok(None) => {}
            Err(reason) => ambiguous = Some(reason),
        }
    }
    Ok(EffectiveAccess { level, ambiguous })
}

/// Whether the signed-in viewer can manage this project's settings
/// (Maintainer+) and whether they hold the Owner-only lifecycle powers. An
/// unanswered membership fallback reads as "not a member" here, as it always has.
pub async fn repo_admin(repo_path: &str) -> AppResult<(bool, bool)> {
    let enc = encode_project(&project_path(repo_path).await?);
    let level = effective_access_level(repo_path, &enc).await?.level;
    Ok((level >= 40, level >= 50))
}

/// A GitLab access level → `(can push, can triage, role label)`. Pure. Developer
/// (30) is the first level that can push and Reporter (20) the first that manages
/// issue/MR metadata; levels the app doesn't name (0 = none, 5 = minimal access,
/// any future tier) carry no label.
fn write_access_from_level(level: u8) -> (bool, bool, Option<String>) {
    let role = match level {
        50 => Some("owner"),
        40 => Some("maintainer"),
        30 => Some("developer"),
        20 => Some("reporter"),
        10 => Some("guest"),
        _ => None,
    };
    (level >= 30, level >= 20, role.map(str::to_string))
}

/// The write-access answer a resolved level implies. Pure; `repo` is left `None`
/// because the caller resolves that identity asynchronously.
///
/// An unanswered membership fallback leaves the level a FLOOR, so a threshold it
/// already clears stays affirmative while the ones it doesn't become unknown.
/// The tier label survives only alongside a granted push, and even then the
/// floor can understate it — nothing gates on the label.
fn write_access_fields(level: u8, ambiguous: Option<String>) -> crate::forge::ForgeRepoWriteAccess {
    let (can_push, can_triage, role) = write_access_from_level(level);
    let resolved = ambiguous.is_none();
    crate::forge::ForgeRepoWriteAccess {
        can_push: (can_push || resolved).then_some(can_push),
        can_triage: (can_triage || resolved).then_some(can_triage),
        role: if can_push || resolved { role } else { None },
        repo: None,
        unknown_reason: if can_push { None } else { ambiguous },
    }
}

/// Whether the signed-in viewer can push to this project — the write twin of
/// [`repo_admin`]. A resolved level is an affirmative answer even at 0 (the
/// endpoints replied), and a failed project read propagates as an error rather
/// than a guessed `false`.
pub async fn repo_write_access(repo_path: &str) -> AppResult<crate::forge::ForgeRepoWriteAccess> {
    let path = project_path(repo_path).await?;
    let access = effective_access_level(repo_path, &encode_project(&path)).await?;
    Ok(crate::forge::ForgeRepoWriteAccess {
        repo: Some(path),
        ..write_access_fields(access.level, access.ambiguous)
    })
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
        ("issues", &input.issues_access_level, &ACCESS_LEVELS[..]),
        (
            "merge requests",
            &input.merge_requests_access_level,
            &ACCESS_LEVELS[..],
        ),
        ("wiki", &input.wiki_access_level, &ACCESS_LEVELS[..]),
        ("snippets", &input.snippets_access_level, &ACCESS_LEVELS[..]),
        ("forking", &input.forking_access_level, &ACCESS_LEVELS[..]),
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

/// The JSON body shared by hook create/update: url + SSL + every known event
/// flag set explicitly true/false (so unchecking sticks on update). It rides
/// stdin, so the secret token never reaches argv. Omitting `token` relies on the
/// hook PUT's documented partial-update semantics (omitted fields unchanged) —
/// the contract the form's blank-means-unchanged placeholder is written against.
fn hook_body(input: &GitLabHookInput) -> AppResult<serde_json::Value> {
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
    let mut body = serde_json::Map::new();
    body.insert("url".to_string(), url.into());
    for e in HOOK_EVENTS {
        body.insert(e.to_string(), input.events.iter().any(|x| x == e).into());
    }
    body.insert(
        "enable_ssl_verification".to_string(),
        input.enable_ssl_verification.into(),
    );
    if let Some(token) = input.token.as_deref() {
        if !token.is_empty() {
            body.insert("token".to_string(), token.into());
        }
    }
    Ok(serde_json::Value::Object(body))
}

pub async fn create_hook(repo_path: &str, input: GitLabHookInput) -> AppResult<()> {
    let body = hook_body(&input)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks");
    run_glab_ex(
        Some(repo_path),
        &json_body_args("POST", &endpoint),
        Some(&body.to_string()),
        &[],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

pub async fn update_hook(repo_path: &str, hook_id: &str, input: GitLabHookInput) -> AppResult<()> {
    let hook_id: u64 = hook_id
        .parse()
        .map_err(|_| AppError::InvalidArgument("invalid webhook id".into()))?;
    let body = hook_body(&input)?;
    let enc = encode_project(&project_path(repo_path).await?);
    let endpoint = format!("projects/{enc}/hooks/{hook_id}");
    run_glab_ex(
        Some(repo_path),
        &json_body_args("PUT", &endpoint),
        Some(&body.to_string()),
        &[],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
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
        // GitLab answers 422 BOTH when the endpoint rejected a delivered event
        // (relaying its body — the event DID fire) and when the test couldn't fire
        // at all (e.g. "Ensure the project has commits"). Keep the original message
        // so the could-not-fire causes stay diagnosable, truncated — a relayed body
        // can be a whole HTML page.
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
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
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

/// The create/update body. `key` rides the body only on create — an update
/// addresses its key in the endpoint, and resending it there reads as a rename.
fn variable_body(
    create: bool,
    key: &str,
    value: &str,
    protected: bool,
    masked: bool,
) -> serde_json::Value {
    if create {
        serde_json::json!({ "key": key, "value": value, "protected": protected, "masked": masked })
    } else {
        serde_json::json!({ "value": value, "protected": protected, "masked": masked })
    }
}

/// Does this 400 mean GitLab refused to MASK the value (length ≥ 8, one line,
/// Base64-ish alphabet)? Measured: glab's stderr renders it as
/// `map[message:map[value:[is invalid]]]`; older GitLab wordings said "masked".
/// Both renderings are matched, raw JSON included.
fn is_mask_rejection(msg: &str) -> bool {
    msg.contains("masked") || (msg.contains("value") && msg.contains("is invalid"))
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
    // The value rides stdin, never argv: a masked variable readable in the
    // process table isn't masked at all.
    let body = variable_body(create, key, value, protected, masked);
    run_glab_ex(
        Some(repo_path),
        &json_body_args(method, &endpoint),
        Some(&body.to_string()),
        &[],
        GLAB_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| match e {
        // GitLab's curt 400 on an unmaskable value — spell out what it wants.
        AppError::Glab(msg) if masked && is_mask_rejection(&msg) => AppError::Glab(
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
// Project protected branches (`projects/:id/protected_branches`). Each protection
// carries per-action access-level lists (push/merge); on Free the levels are one of
// {0 = no one, 30 = developers + maintainers, 40 = maintainers}. Only
// `allow_force_push` is updatable on Free — access-level PATCH params are SILENTLY
// ignored — so no level-editing surface is exposed. `unprotect_access_levels` /
// `code_owner_approval_required` are Premium and deliberately not surfaced.

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
        return Err(AppError::InvalidArgument(
            "branch name can't be empty".into(),
        ));
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
        let batch: Vec<GlabProtectedBranch> =
            serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
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
// GitLab-only: estimate + spent time, with no GitHub analogue. The read
// (`time_stats`) and both writes (`time_estimate`/`add_spent_time`) return the SAME
// `time_stats` object, so every command resolves to a `GitLabTimeStats`; issue and
// MR endpoints are exactly symmetric. Durations are GitLab's human strings ("3h",
// "45m", even negative "-15m" — passed through for the server to validate), and an
// absent/blank duration routes to the matching reset endpoint.

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
/// `human_*` come back `null` when the seconds are zero → the empty string.
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
    write_time(
        repo_path,
        TimeTarget::Issue,
        number,
        TimeWrite::Estimate,
        duration,
    )
    .await
}

/// Add to (or, when blank, reset) an issue's spent time; returns the new stats.
pub async fn issue_add_spent_time(
    repo_path: &str,
    number: u64,
    duration: Option<&str>,
) -> AppResult<GitLabTimeStats> {
    write_time(
        repo_path,
        TimeTarget::Issue,
        number,
        TimeWrite::Spent,
        duration,
    )
    .await
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
// GitLab-only: link two issues as "related" (`issue_links`), no GitHub analogue.
// Links are SYMMETRIC — the same link shows on both issues. The list returns full
// issue objects each augmented with `issue_link_id` (needed for delete) and
// `link_type`. Create takes `target_project_id` = the PLAIN "owner/repo" path (NOT
// url-encoded) + `target_issue_iid`; delete keys on the `issue_link_id`.

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
/// link is symmetric, so it shows on both issues afterward.
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

// ── Explore: repo search / fork-by-name / star / README ───────────────────────
//
// The Explore view's GitLab backend, over the `glab api` REST escape hatch. Search
// uses `projects?search=…`; fork/star/readme address the project by its
// URL-encoded `owner%2Fname` path (which GitLab accepts in place of a numeric id).
// All owner/name values are grammar-validated before interpolation.

/// GitLab returns 30 projects per Explore search page; a full page is the
/// documented "more available" heuristic (we don't parse response headers).
const GL_SEARCH_PER_PAGE: usize = 30;

/// Map the neutral `sort` onto GitLab's `order_by`. `order_by` and `sort` are two
/// separate query params — a combined `order_by=stars_desc` 400s. `"best"` maps to
/// `star_count`, NOT `similarity`: similarity ordering is silently restricted to
/// projects the caller is a member of, so a public Explore search with it returns
/// an EMPTY set (live-verified on gitlab.com).
fn gitlab_order_by(sort: &str) -> &'static str {
    match sort {
        "stars" => "star_count",
        "updated" => "last_activity_at",
        // "best" → star_count (see the doc comment); also the defensive default.
        _ => "star_count",
    }
}

/// One search-result repo from an item of GitLab's `projects` response. Tolerant: a
/// missing `path_with_namespace` skips the item. This endpoint has no per-project
/// language field, so `language` is always `None`.
///
/// CRITICAL: `name` must be the URL SLUG (`path`), never GitLab's `name` field —
/// that's the DISPLAY name and can diverge. Every by-owner/name command (README,
/// fork, star) addresses `owner%2Fname`, so a display name there 404s. `owner` is
/// `path_with_namespace` minus its last segment (not `namespace.full_path`) so
/// `owner + "/" + name == full_name` ALWAYS holds.
fn gl_search_repo_from_value(item: &serde_json::Value) -> Option<ForgeSearchRepo> {
    use serde_json::Value;
    let full_name = item
        .get("path_with_namespace")
        .and_then(Value::as_str)?
        .to_string();
    if full_name.is_empty() {
        return None;
    }
    // Slug + owner, derived so `owner/name == full_name`.
    let (owner, name) = match full_name.rsplit_once('/') {
        Some((o, n)) => (o.to_string(), n.to_string()),
        // No namespace separator (shouldn't happen for a real project) — no owner.
        None => (String::new(), full_name.clone()),
    };
    let name = item
        .get("path")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(name);
    let str_field = |k: &str| item.get(k).and_then(Value::as_str).map(str::to_string);
    Some(ForgeSearchRepo {
        owner,
        name,
        full_name,
        // visibility public|internal|private — anything but public shows the lock.
        private: item.get("visibility").and_then(Value::as_str) != Some("public"),
        archived: item.get("archived").and_then(Value::as_bool).unwrap_or(false),
        // Presence of forked_from_project → this is a fork.
        fork: item
            .get("forked_from_project")
            .map(|v| !v.is_null())
            .unwrap_or(false),
        clone_url: str_field("http_url_to_repo").unwrap_or_default(),
        ssh_url: str_field("ssh_url_to_repo").unwrap_or_default(),
        description: str_field("description"),
        updated_at: str_field("last_activity_at"),
        stars: item.get("star_count").and_then(Value::as_u64),
        language: None,
        web_url: str_field("web_url"),
        default_branch: str_field("default_branch"),
    })
}

/// Search GitLab projects for the Explore view. An empty `query` is the
/// Popular/Discover feed (no `search`, ordered by star count). `has_more` is the
/// documented full-page heuristic (a returned page of exactly 30).
pub async fn search_repos(query: &str, sort: &str, page: u32) -> AppResult<ForgeSearchList> {
    let per_page = GL_SEARCH_PER_PAGE;
    let endpoint = if query.trim().is_empty() {
        // Popular mode: no search term, order by stars.
        format!("projects?order_by=star_count&sort=desc&per_page={per_page}&page={page}")
    } else {
        let enc = encode_query_value(query);
        let order_by = gitlab_order_by(sort);
        format!(
            "projects?search={enc}&order_by={order_by}&sort=desc&per_page={per_page}&page={page}"
        )
    };
    let out = run_glab(None, &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse GitLab project search: {e}")))?;
    let items = value.as_array().cloned().unwrap_or_default();
    let returned = items.len();
    let repos = items.iter().filter_map(gl_search_repo_from_value).collect();
    Ok(ForgeSearchList {
        repos,
        has_more: returned == per_page,
        total: None,
    })
}

/// Fork a GitLab project by `owner/name` into the caller's namespace. `glab api -X
/// POST projects/{enc}/fork` returns the new project; we poll `projects/{id}` until
/// `import_status == "finished"` (bounded 5×2s → `ready`). A 409 (already forked)
/// maps to a clear error rather than a fake success.
pub async fn fork_repo(owner: &str, name: &str) -> AppResult<ForgeForkResult> {
    use serde_json::Value;
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let enc = encode_project(&format!("{owner}/{name}"));
    let endpoint = format!("projects/{enc}/fork");
    // A conflict (already forked) exits non-zero with a 409 — surface a clear message
    // instead of an opaque glab error or a fabricated success.
    let out = run_glab_raw(None, &["api", "--method", "POST", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    if out.code != 0 {
        let stderr = out.stderr.to_ascii_lowercase();
        if stderr.contains("409") || stderr.contains("already") {
            return Err(AppError::Glab(
                "You already have a fork of this project on GitLab.".into(),
            ));
        }
        let msg = out.stderr.trim();
        return Err(AppError::Glab(if msg.is_empty() {
            format!("glab exited with code {} forking the project", out.code)
        } else {
            msg.to_string()
        }));
    }
    let fork: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse the forked project: {e}")))?;
    let full_name = fork
        .get("path_with_namespace")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let clone_url = fork
        .get("http_url_to_repo")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let web_url = fork.get("web_url").and_then(Value::as_str).map(str::to_string);
    // Readiness: the fork's `import_status` starts non-"finished" while GitLab copies
    // the repository. Poll by numeric id (5×2s). A missing id → treat the initial
    // status as authoritative.
    let ready = match fork.get("id").and_then(Value::as_u64) {
        Some(id) => poll_fork_ready(id).await,
        None => {
            fork.get("import_status").and_then(Value::as_str) == Some("finished")
        }
    };
    Ok(ForgeForkResult {
        full_name,
        clone_url,
        web_url,
        ready,
    })
}

/// Poll `projects/{id}` until `import_status == "finished"`, on the shared
/// [`FORK_POLL_ATTEMPTS`] / [`FORK_POLL_DELAY`] cadence. Returns `true` on the first
/// finished read, `false` if it never finished within the bound (not an error — the
/// fork exists).
async fn poll_fork_ready(id: u64) -> bool {
    let endpoint = format!("projects/{id}");
    for attempt in 0..FORK_POLL_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(FORK_POLL_DELAY).await;
        }
        if let Ok(out) = run_glab_raw(None, &["api", &endpoint], GLAB_TIMEOUT).await {
            if out.code == 0 {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) {
                    if v.get("import_status").and_then(serde_json::Value::as_str) == Some("finished")
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Star (`POST …/star`) or unstar (`POST …/unstar`) a GitLab project by name. A 304
/// (already in the desired state) is success.
pub async fn star_repo(owner: &str, name: &str, star: bool) -> AppResult<()> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let enc = encode_project(&format!("{owner}/{name}"));
    let action = if star { "star" } else { "unstar" };
    let endpoint = format!("projects/{enc}/{action}");
    let out = run_glab_raw(None, &["api", "--method", "POST", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    if out.code != 0 {
        // A 304 means the project was already in the desired star state — success.
        if out.stderr.contains("304") {
            return Ok(());
        }
        let msg = out.stderr.trim();
        return Err(AppError::Glab(if msg.is_empty() {
            format!("glab exited with code {} toggling the star", out.code)
        } else {
            msg.to_string()
        }));
    }
    Ok(())
}

/// Whether the signed-in user has starred `owner/name`. GitLab has no direct
/// "is this starred" endpoint, so we list the viewer's starred projects filtered by
/// the repo's name and check for an exact `path_with_namespace` match. Best-effort:
/// the query caps at 100 results (a very common name past 100 starred could miss).
pub async fn starred(owner: &str, name: &str) -> AppResult<bool> {
    use serde_json::Value;
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let want = format!("{owner}/{name}");
    let enc = encode_query_value(name);
    let endpoint = format!("projects?starred=true&search={enc}&per_page=100");
    let out = run_glab(None, &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let value: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Glab(format!("could not parse starred projects: {e}")))?;
    let hit = value
        .as_array()
        .map(|arr| {
            arr.iter().any(|p| {
                p.get("path_with_namespace").and_then(Value::as_str) == Some(want.as_str())
            })
        })
        .unwrap_or(false);
    Ok(hit)
}

/// Whether a failed `glab api` invocation's output looks like a 404 (Not Found) —
/// the signal that a candidate file is absent, as opposed to a transport/auth/
/// rate-limit failure that must be surfaced. glab prints the HTTP status to stderr
/// (`404 Not Found`); some builds echo the JSON body (`{"message":"404 ... Not
/// Found"}`) too, so scan both. Pure, so it's unit-testable.
pub(crate) fn glab_output_is_404(stderr: &str, stdout: &str) -> bool {
    let hay = format!("{stderr}\n{stdout}").to_ascii_lowercase();
    hay.contains("404") || hay.contains("not found")
}

/// A GitLab project's raw README markdown, or `None` when absent. Tries a set of
/// candidate filenames via the repository-files raw endpoint at
/// `?ref={default_branch or "HEAD"}`; the first hit wins. Continues to the next
/// candidate ONLY on a 404 (that file doesn't exist); any other failure (auth,
/// rate-limit, network) surfaces as an error rather than silently reading "no README".
pub async fn repo_readme(
    owner: &str,
    name: &str,
    default_branch: Option<&str>,
) -> AppResult<Option<String>> {
    validate_owner(owner)?;
    validate_repo_name(name)?;
    let enc = encode_project(&format!("{owner}/{name}"));
    let git_ref = default_branch.filter(|b| !b.is_empty()).unwrap_or("HEAD");
    let ref_enc = encode_query_value(git_ref);
    for candidate in README_CANDIDATES {
        let file_enc = encode_query_value(candidate);
        let endpoint = format!("projects/{enc}/repository/files/{file_enc}/raw?ref={ref_enc}");
        let out = run_glab_raw(None, &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await?;
        if out.code == 0 {
            return Ok(Some(cap_readme(&out.stdout_lossy())));
        }
        // Only a 404 means "this candidate doesn't exist" — try the next one. Any
        // other failure is a real error worth surfacing, not "No README."
        if !glab_output_is_404(&out.stderr, &out.stdout_lossy()) {
            let msg = out.stderr.trim();
            return Err(AppError::Glab(if msg.is_empty() {
                format!("glab exited with code {} reading the README", out.code)
            } else {
                msg.to_string()
            }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The MR edit PUT sends `target_branch` only when retargeting — the no-base
    /// form must stay byte-identical to the title/description-only request.
    #[test]
    fn edit_mr_args_append_target_branch_only_when_given() {
        let plain = edit_mr_args("projects/9/merge_requests/7", "T", "D", None);
        assert_eq!(
            plain,
            vec![
                "api",
                "--method",
                "PUT",
                "projects/9/merge_requests/7",
                "-f",
                "title=T",
                "-f",
                "description=D",
            ]
        );

        let retarget = edit_mr_args("projects/9/merge_requests/7", "T", "D", Some("main"));
        assert_eq!(retarget[..plain.len()], plain[..]);
        assert_eq!(retarget[plain.len()..], ["-f", "target_branch=main"]);
    }

    /// The hook body carries the secret token only when the form supplied one:
    /// an absent/empty token must leave the key out entirely, or the request
    /// would clear GitLab's stored secret (it never returns it to re-send).
    /// Event flags are real JSON booleans; `-f` is `--raw-field`, so the old
    /// form sent the strings "true"/"false" — GitLab accepts either.
    #[test]
    fn hook_body_carries_the_token_only_when_set() {
        let input = |token: Option<&str>| GitLabHookInput {
            url: "https://example.com/hook".to_string(),
            token: token.map(str::to_string),
            enable_ssl_verification: true,
            events: vec!["push_events".to_string()],
        };

        let with = hook_body(&input(Some("s3cret"))).unwrap();
        assert_eq!(with["url"], "https://example.com/hook");
        assert_eq!(with["token"], "s3cret");
        assert_eq!(with["push_events"], serde_json::json!(true));
        assert_eq!(with["issues_events"], serde_json::json!(false));
        assert_eq!(with["enable_ssl_verification"], serde_json::json!(true));

        for absent in [
            hook_body(&input(None)).unwrap(),
            hook_body(&input(Some(""))).unwrap(),
        ] {
            assert!(
                absent.get("token").is_none(),
                "token key omitted entirely: {absent}"
            );
        }
    }

    /// A mask refusal gets the explanatory rewrite; the other measured 400s
    /// pass through with GitLab's own message (substring match, not exhaustive).
    #[test]
    fn mask_rejection_matches_measured_renderings() {
        assert!(is_mask_rejection(
            "glab: map[message:map[value:[is invalid]]]"
        ));
        assert!(is_mask_rejection("value is invalid"));
        assert!(is_mask_rejection("masked variables must be at least 8 characters"));
        assert!(!is_mask_rejection(
            "glab: map[message:map[key:[has already been taken]]]"
        ));
    }

    /// The manual-pipeline body: the ref plus the REST `variables[]` array.
    #[test]
    fn pipeline_body_carries_ref_and_variables_array() {
        let body = pipeline_body(
            "main",
            vec![serde_json::json!({ "key": "DEPLOY_ENV", "value": "prod" })],
        );
        assert_eq!(
            body,
            serde_json::json!({
                "ref": "main",
                "variables": [{ "key": "DEPLOY_ENV", "value": "prod" }],
            })
        );
    }

    /// The create body carries the key; an update addresses it in the endpoint,
    /// so repeating it in the body would read as a rename. Both flags are real
    /// JSON booleans, and the value itself never touches argv.
    #[test]
    fn variable_body_sends_the_key_on_create_only() {
        let created = variable_body(true, "DEPLOY_ENV", "s3cret", true, false);
        assert_eq!(created["key"], "DEPLOY_ENV");
        assert_eq!(created["value"], "s3cret");
        assert_eq!(created["protected"], serde_json::json!(true));
        assert_eq!(created["masked"], serde_json::json!(false));

        let updated = variable_body(false, "DEPLOY_ENV", "s3cret", false, true);
        assert!(
            updated.get("key").is_none(),
            "an update omits the key entirely: {updated}"
        );
        assert_eq!(updated["value"], "s3cret");
        assert_eq!(updated["protected"], serde_json::json!(false));
        assert_eq!(updated["masked"], serde_json::json!(true));
    }

    /// `(iid, position, size)` per MR, sorted — the readable shape of an inference.
    fn chain_of(open: &[(u64, &str, &str)]) -> Vec<(u64, String, u32, u32)> {
        let mut rows: Vec<(u64, String, u32, u32)> = infer_mr_stacks(open)
            .into_iter()
            .map(|(iid, (id, position, size))| (iid, id, position, size))
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn infer_mr_stacks_marks_a_linear_chain_bottom_first() {
        // A (feat-a → main) ← B (feat-b → feat-a): B targets A's source branch.
        let rows = chain_of(&[(7, "feat-a", "main"), (8, "feat-b", "feat-a")]);
        assert_eq!(
            rows,
            vec![
                (7, "mr-7".to_string(), 1, 2),
                (8, "mr-7".to_string(), 2, 2),
            ]
        );
        // Three deep, and list order must not matter.
        let rows = chain_of(&[
            (30, "feat-c", "feat-b"),
            (10, "feat-a", "main"),
            (20, "feat-b", "feat-a"),
        ]);
        assert_eq!(
            rows,
            vec![
                (10, "mr-10".to_string(), 1, 3),
                (20, "mr-10".to_string(), 2, 3),
                (30, "mr-10".to_string(), 3, 3),
            ]
        );
    }

    #[test]
    fn infer_mr_stacks_leaves_ambiguous_shapes_unmarked() {
        // Branching stack: two open MRs both target feat-a. GitHub disallows the
        // shape, so the whole chain stays unmarked rather than picking an order.
        assert!(infer_mr_stacks(&[
            (1, "feat-a", "main"),
            (2, "feat-b", "feat-a"),
            (3, "feat-c", "feat-a"),
        ])
        .is_empty());
        // Two open MRs sharing a source branch identify no unique parent.
        assert!(infer_mr_stacks(&[
            (1, "feat-a", "main"),
            (2, "feat-a", "release"),
            (3, "feat-b", "feat-a"),
        ])
        .is_empty());
    }

    /// Rows as `list_prs` returns them: stacks already annotated, state in GitLab's
    /// uppercase neutral casing.
    fn row(number: u64, head: &str, base: &str, stack: Option<(&str, u32, u32)>) -> PrInfo {
        PrInfo {
            number,
            url: String::new(),
            title: format!("MR {number}"),
            base_ref_name: base.to_string(),
            head_ref_name: head.to_string(),
            is_draft: false,
            state: "OPEN".to_string(),
            author: None,
            labels: Vec::new(),
            created_at: String::new(),
            head_sha: String::new(),
            stack: stack.map(|(id, position, size)| PrStackInfo {
                id: id.to_string(),
                position,
                size,
            }),
            stack_unknown: false,
            cross_repository: false,
        }
    }

    /// The same row from a FORK: its source branch name is a coincidence, not a link.
    fn fork_row(number: u64, head: &str, base: &str) -> PrInfo {
        PrInfo {
            cross_repository: true,
            ..row(number, head, base, None)
        }
    }

    #[test]
    fn apply_mr_stacks_ignores_fork_rows() {
        // A fork MR whose source branch happens to be named `feat-a` — the same name
        // the real chain's bottom uses. Counted, it would make `feat-a` an ambiguous
        // parent and poison the whole chain.
        let mut prs = vec![
            fork_row(99, "feat-a", "main"),
            row(7, "feat-a", "main", None),
            row(8, "feat-b", "feat-a", None),
        ];
        apply_mr_stacks(&mut prs);
        // The fork row is never a member…
        assert!(prs[0].stack.is_none());
        // …and the real chain still marks, bottom→top.
        let bottom = prs[1].stack.as_ref().expect("MR 7 is the chain bottom");
        let top = prs[2].stack.as_ref().expect("MR 8 is the chain top");
        assert_eq!((bottom.id.as_str(), bottom.position, bottom.size), ("mr-7", 1, 2));
        assert_eq!((top.id.as_str(), top.position, top.size), ("mr-7", 2, 2));
    }

    #[test]
    fn mr_stack_from_rows_filters_by_id_sorts_and_lowercases_state() {
        // Two chains plus an unstacked MR; the chain rows are deliberately out of
        // position order in the list.
        let open = vec![
            row(2, "a2", "a1", Some(("mr-1", 2, 2))),
            row(9, "solo", "main", None),
            row(6, "b2", "b1", Some(("mr-5", 2, 2))),
            row(1, "a1", "main", Some(("mr-1", 1, 2))),
            row(5, "b1", "release", Some(("mr-5", 1, 2))),
        ];

        let (stack, members) = mr_stack_from_rows(&open, 2);
        let stack = stack.expect("MR 2 is in a chain");
        assert_eq!((stack.id.as_str(), stack.position, stack.size), ("mr-1", 2, 2));
        // Only the SAME chain's rows, sorted bottom→top — never the other chain's.
        assert_eq!(
            members.iter().map(|m| m.number).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(members[0].position, 1);
        assert_eq!(members[0].head_ref_name, "a1");
        assert_eq!(members[0].base_ref_name, "main");
        assert_eq!(members[0].title, "MR 1");
        // Provider-neutral lowercase, from GitLab's uppercase row state.
        assert_eq!(members[0].state, "open");

        // The other chain resolves independently.
        let (stack, members) = mr_stack_from_rows(&open, 6);
        assert_eq!(stack.expect("MR 6 is in a chain").id, "mr-5");
        assert_eq!(
            members.iter().map(|m| m.number).collect::<Vec<_>>(),
            vec![5, 6]
        );

        // An unstacked MR, and one absent from the list entirely.
        assert!(mr_stack_from_rows(&open, 9).0.is_none());
        assert!(mr_stack_from_rows(&open, 9).1.is_empty());
        assert!(mr_stack_from_rows(&open, 404).0.is_none());
    }

    #[test]
    fn infer_mr_stacks_unmarks_the_whole_component_not_just_the_bad_link() {
        // A backport shape: !10 and !11 both source feat-a (onto main and release),
        // !12 stacks on feat-a, !13 on !12. !12's base is an ambiguous open-MR head,
        // so !12 is NOT a bottom — dropping only the bad link would re-root the
        // chain there and report [12, 13] as a stack. The ambiguity poisons the
        // whole component instead.
        assert!(infer_mr_stacks(&[
            (10, "feat-a", "main"),
            (11, "feat-a", "release"),
            (12, "feat-b", "feat-a"),
            (13, "feat-c", "feat-b"),
        ])
        .is_empty());
    }

    #[test]
    fn infer_mr_stacks_finds_nothing_without_a_chain() {
        // Independent MRs onto the trunk — a lone MR is not a stack of one.
        assert!(infer_mr_stacks(&[(1, "feat-a", "main"), (2, "feat-b", "main")]).is_empty());
        assert!(infer_mr_stacks(&[]).is_empty());
        // A self-targeting MR can't be its own parent.
        assert!(infer_mr_stacks(&[(1, "feat-a", "feat-a")]).is_empty());
        // A 2-cycle (each MR targets the other's source branch) has no parentless
        // bottom, so the component yields nothing rather than looping.
        assert!(infer_mr_stacks(&[(1, "feat-a", "feat-b"), (2, "feat-b", "feat-a")]).is_empty());
    }

    #[test]
    fn infer_mr_stacks_handles_two_independent_chains() {
        let rows = chain_of(&[
            (1, "a1", "main"),
            (2, "a2", "a1"),
            (5, "b1", "release"),
            (6, "b2", "b1"),
        ]);
        assert_eq!(
            rows,
            vec![
                (1, "mr-1".to_string(), 1, 2),
                (2, "mr-1".to_string(), 2, 2),
                (5, "mr-5".to_string(), 1, 2),
                (6, "mr-5".to_string(), 2, 2),
            ]
        );
    }

    #[test]
    fn gitlab_order_by_maps_each_sort() {
        assert_eq!(gitlab_order_by("stars"), "star_count");
        assert_eq!(gitlab_order_by("updated"), "last_activity_at");
        // "best" deliberately avoids `similarity` (member-scoped → empty public
        // searches); star_count is the relevance proxy.
        assert_eq!(gitlab_order_by("best"), "star_count");
    }

    #[test]
    fn glab_output_404_distinguishes_absence_from_other_failures() {
        // glab's 404 shapes (stderr line and/or JSON body).
        assert!(glab_output_is_404("404 Not Found", ""));
        assert!(glab_output_is_404("", "{\"message\":\"404 File Not Found\"}"));
        // Auth / rate-limit / 5xx must surface, not read as "no README".
        assert!(!glab_output_is_404("401 Unauthorized", ""));
        assert!(!glab_output_is_404("429 Too Many Requests", ""));
        assert!(!glab_output_is_404("500 Internal Server Error", ""));
        assert!(!glab_output_is_404("", ""));
    }

    #[test]
    fn gl_search_repo_parses_and_skips_malformed() {
        let item = serde_json::json!({
            "path_with_namespace": "group/sub/repo",
            "path": "repo",
            "name": "repo",
            "namespace": { "full_path": "group/sub" },
            "visibility": "private",
            "archived": false,
            "forked_from_project": { "id": 5 },
            "http_url_to_repo": "https://gitlab.com/group/sub/repo.git",
            "ssh_url_to_repo": "git@gitlab.com:group/sub/repo.git",
            "description": "desc",
            "last_activity_at": "2026-01-01T00:00:00Z",
            "star_count": 42,
            "web_url": "https://gitlab.com/group/sub/repo",
            "default_branch": "main"
        });
        let r = gl_search_repo_from_value(&item).expect("parses");
        assert_eq!(r.full_name, "group/sub/repo");
        assert_eq!(r.owner, "group/sub");
        assert!(r.private);
        assert!(r.fork);
        assert_eq!(r.stars, Some(42));
        // No per-request language on this endpoint.
        assert!(r.language.is_none());
        assert_eq!(r.default_branch.as_deref(), Some("main"));
        // Missing path_with_namespace → skipped.
        assert!(gl_search_repo_from_value(&serde_json::json!({ "name": "x" })).is_none());
    }

    #[test]
    fn gl_search_repo_name_is_slug_not_display_name() {
        // GitLab's `name` is a DISPLAY name that can diverge from the URL slug
        // (`path`). `ForgeSearchRepo.name` must be the slug so
        // `owner + "/" + name == full_name` and by-owner/name commands address the
        // right project.
        let item = serde_json::json!({
            "path_with_namespace": "grp/pretty-name",
            "path": "pretty-name",
            "name": "Pretty Name",
            "web_url": "https://gitlab.com/grp/pretty-name"
        });
        let r = gl_search_repo_from_value(&item).expect("parses");
        assert_eq!(r.name, "pretty-name", "name must be the slug, not the display name");
        assert_eq!(r.owner, "grp");
        assert_eq!(r.full_name, "grp/pretty-name");
        // The load-bearing identity every by-owner/name command relies on.
        assert_eq!(format!("{}/{}", r.owner, r.name), r.full_name);

        // Fallback: when `path` is absent, the slug is the last segment of
        // path_with_namespace (never the display `name`), and owner still holds.
        let no_path = serde_json::json!({
            "path_with_namespace": "a/b/pretty-name",
            "name": "Pretty Name"
        });
        let r2 = gl_search_repo_from_value(&no_path).expect("parses");
        assert_eq!(r2.name, "pretty-name");
        assert_eq!(r2.owner, "a/b");
        assert_eq!(format!("{}/{}", r2.owner, r2.name), r2.full_name);
    }

    #[test]
    fn credential_entries_are_reset_then_helper() {
        let entries = gitlab_credential_entries("gitlab.com", "/abs/glab");
        assert_eq!(entries.len(), 2);
        // entry[0] resets the helper chain: empty value, nothing after the `=`.
        assert_eq!(entries[0], "credential.https://gitlab.com.helper=");
        assert_eq!(
            entries[1],
            "credential.https://gitlab.com.helper=!\"/abs/glab\" auth git-credential"
        );
        // No host is special-cased: a port rides through on the canonical host too.
        let ported = gitlab_credential_entries("gitlab.com:8443", "/abs/glab");
        assert_eq!(ported[0], "credential.https://gitlab.com:8443.helper=");
    }

    #[test]
    fn credential_entries_substitute_self_managed_host() {
        let entries = gitlab_credential_entries("gitlab.example.com", "/abs/glab");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], "credential.https://gitlab.example.com.helper=");
        assert_eq!(
            entries[1],
            "credential.https://gitlab.example.com.helper=!\"/abs/glab\" auth git-credential"
        );
        // A ported instance keys on the authority — git won't match a portless key.
        let ported = gitlab_credential_entries("gitlab.example.com:8443", "/abs/glab");
        assert_eq!(ported[0], "credential.https://gitlab.example.com:8443.helper=");
        assert_eq!(
            ported[1],
            "credential.https://gitlab.example.com:8443.helper=!\"/abs/glab\" auth git-credential"
        );
        // git spells an IPv6 credential context bracketed (measured against git 2.51),
        // so the key must carry the brackets to match the request.
        let v6 = gitlab_credential_entries("[::1]:8443", "/abs/glab");
        assert_eq!(v6[0], "credential.https://[::1]:8443.helper=");
    }

    #[test]
    fn ported_remote_gates_on_bare_host_but_keys_on_authority() {
        // The trap `clone_credential_config` threads: glab's `hosts:` keys are
        // port-stripped, so the gate needs the bare host while the key needs the port.
        let url = "https://gitlab.example.com:8443/g/s/r.git";
        assert_eq!(crate::forge::remote_host(url).as_deref(), Some("gitlab.example.com"));
        assert_eq!(
            crate::forge::remote_authority(url).as_deref(),
            Some("gitlab.example.com:8443"),
        );
        let entries =
            gitlab_credential_entries(&crate::forge::remote_authority(url).unwrap(), "/abs/glab");
        assert_eq!(entries[0], "credential.https://gitlab.example.com:8443.helper=");
    }

    #[test]
    fn a_crafted_authority_emits_no_entries_at_all() {
        // Fail OPEN to ambient rather than installing an attacker's `!`-shell helper.
        assert!(
            gitlab_credential_entries("gitlab.com:443.helper=!evil #", "/abs/glab").is_empty()
        );
        assert!(gitlab_credential_entries("gitlab.com;evil", "/abs/glab").is_empty());
    }

    #[test]
    fn job_status_maps_to_check_buckets() {
        // Only "success" reads as passed.
        assert_eq!(map_job_check_status("success"), "SUCCESS");
        // Terminal-failure states.
        assert_eq!(map_job_check_status("failed"), "FAILURE");
        assert_eq!(map_job_check_status("canceled"), "CANCELLED");
        assert_eq!(map_job_check_status("cancelled"), "CANCELLED");
        // Skipped jobs read as their own muted bucket, not pending.
        assert_eq!(map_job_check_status("skipped"), "SKIPPED");
        // Everything else (in-flight, manual, unknown) → pending bucket. `manual`
        // stays pending — it's blocked on a human, not skipped.
        for s in ["running", "pending", "manual", "created", "weird_new_state"] {
            assert_eq!(map_job_check_status(s), "PENDING", "status {s}");
        }
    }

    #[test]
    fn approval_notes_map_to_the_right_variant() {
        let a = || {
            gl_actor(Some(
                serde_json::from_str(
                    r#"{"username":"theBGuy","avatar_url":"https://gl/u/theBGuy.png"}"#,
                )
                .expect("user should parse"),
            ))
        };
        let d = || "2026-07-02T05:45:40.961Z".to_string();
        match map_approval_note("approved this merge request", a(), d()) {
            Some(ForgeTimelineEventOut::Approved { actor, .. }) => {
                // The username fills both id and label; the avatar rides along.
                assert_eq!((actor.id.as_str(), actor.label.as_str()), ("theBGuy", "theBGuy"));
                assert_eq!(actor.avatar_url, "https://gl/u/theBGuy.png");
            }
            _ => panic!("expected Approved"),
        }
        assert!(matches!(
            map_approval_note("unapproved this merge request", a(), d()),
            Some(ForgeTimelineEventOut::Unapproved { .. })
        ));
        assert!(matches!(
            map_approval_note("requested changes", a(), d()),
            Some(ForgeTimelineEventOut::ChangesRequested { .. })
        ));
        // A non-approval system note (e.g. a time-tracking note) is not a timeline event.
        assert!(map_approval_note("added 3h of time spent", a(), d()).is_none());
        // Leading/trailing whitespace is tolerated.
        assert!(matches!(
            map_approval_note("  approved this merge request  ", a(), d()),
            Some(ForgeTimelineEventOut::Approved { .. })
        ));
        // A deleted-account note keeps its event with an all-empty actor.
        let ghost = gl_actor(None);
        assert!(ghost.label.is_empty() && ghost.avatar_url.is_empty());
        assert!(matches!(
            map_approval_note("approved this merge request", ghost, d()),
            Some(ForgeTimelineEventOut::Approved { .. })
        ));
    }

    #[test]
    fn label_event_color_is_stripped_to_bare_hex() {
        let ev = |json: &str| -> GlabLabelEvent {
            serde_json::from_str(json).expect("label event should parse")
        };
        // `resource_label_events` returns `color` with a leading `#`; the
        // `Labeled.color` contract is bare hex.
        match map_label_event(ev(r##"{"action":"add","created_at":"2026-06-30T00:35:46.215Z",
            "user":{"username":"theBGuy"},
            "label":{"name":"enhancement","color":"#5cb85c"}}"##)) {
            Some(ForgeTimelineEventOut::Labeled {
                label,
                color,
                added,
                actor,
                ..
            }) => {
                assert_eq!((label.as_str(), color.as_str()), ("enhancement", "5cb85c"));
                assert!(added);
                assert_eq!(actor.id, "theBGuy");
            }
            _ => panic!("expected Labeled"),
        }
        // An already-bare color is unchanged (idempotent), and `remove` is a removal.
        assert!(matches!(
            map_label_event(ev(r##"{"action":"remove","created_at":"2026-06-30T00:35:46.215Z",
                "user":{"username":"theBGuy"},
                "label":{"name":"enhancement","color":"5cb85c"}}"##)),
            Some(ForgeTimelineEventOut::Labeled { color, added: false, .. }) if color == "5cb85c"
        ));
        // A deleted label leaves `label: null` — the entry is skipped.
        assert!(map_label_event(ev(
            r#"{"action":"add","created_at":"2026-06-30T00:35:46.215Z","label":null}"#
        ))
        .is_none());
    }

    #[test]
    fn issue_system_notes_map_to_the_right_variant() {
        let a = || {
            gl_actor(Some(
                serde_json::from_str(
                    r#"{"username":"theBGuy","avatar_url":"https://gl/u/theBGuy.png"}"#,
                )
                .expect("user should parse"),
            ))
        };
        let d = || "2026-08-23T05:45:40.961Z".to_string();

        match map_issue_system_note("assigned to @theBGuy", a(), d()) {
            Some(ForgeTimelineEventOut::Assigned {
                assignee,
                added,
                actor,
                ..
            }) => {
                assert_eq!(assignee, "theBGuy");
                assert!(added);
                assert_eq!(actor.id, "theBGuy");
            }
            _ => panic!("expected Assigned"),
        }
        assert!(matches!(
            map_issue_system_note("unassigned @theBGuy", a(), d()),
            Some(ForgeTimelineEventOut::Assigned { added: false, .. })
        ));
        // Multi-assignee bodies are skipped rather than half-parsed.
        assert!(map_issue_system_note("assigned to @a and @b", a(), d()).is_none());
        // A bare prefix with no username is not an event either.
        assert!(map_issue_system_note("assigned to @", a(), d()).is_none());

        match map_issue_system_note("mentioned in merge request !151", a(), d()) {
            Some(ForgeTimelineEventOut::CrossReferenced {
                source_kind,
                source_number,
                source_repo,
                will_close,
                ..
            }) => {
                assert_eq!((source_kind.as_str(), source_number), ("pr", 151));
                assert!(source_repo.is_empty() && !will_close);
            }
            _ => panic!("expected CrossReferenced"),
        }
        assert!(matches!(
            map_issue_system_note("mentioned in issue #150", a(), d()),
            Some(ForgeTimelineEventOut::CrossReferenced { source_number: 150, .. })
        ));
        // Cross-PROJECT mentions carry a project path the neutral shape can't
        // express — they must NOT match as a same-project reference.
        assert!(map_issue_system_note("mentioned in merge request group/proj!7", a(), d()).is_none());
        assert!(map_issue_system_note("mentioned in issue group/proj#7", a(), d()).is_none());
        // A non-numeric tail is not a reference.
        assert!(map_issue_system_note("mentioned in issue #abc", a(), d()).is_none());

        match map_issue_system_note("marked this issue as a duplicate of #12", a(), d()) {
            Some(ForgeTimelineEventOut::MarkedAsDuplicate {
                canonical_kind,
                canonical_number,
                ..
            }) => assert_eq!((canonical_kind.as_str(), canonical_number), ("issue", 12)),
            _ => panic!("expected MarkedAsDuplicate"),
        }

        // gitlab.com's live wording, plus the short form kept for older instances.
        for body in ["locked the discussion in this issue", "locked this issue"] {
            assert!(
                matches!(
                    map_issue_system_note(body, a(), d()),
                    Some(ForgeTimelineEventOut::Locked { locked: true, .. })
                ),
                "body {body}"
            );
        }
        for body in ["unlocked the discussion in this issue", "unlocked this issue"] {
            assert!(
                matches!(
                    map_issue_system_note(body, a(), d()),
                    Some(ForgeTimelineEventOut::Locked { locked: false, .. })
                ),
                "body {body}"
            );
        }
        // Leading/trailing whitespace is tolerated, like the approval matcher.
        assert!(matches!(
            map_issue_system_note("  locked the discussion in this issue  ", a(), d()),
            Some(ForgeTimelineEventOut::Locked { locked: true, .. })
        ));
        // Anything else GitLab writes as a system note is skipped, never guessed.
        assert!(map_issue_system_note("changed the description", a(), d()).is_none());
        assert!(map_issue_system_note("added 3h of time spent", a(), d()).is_none());
    }

    #[test]
    fn issue_milestone_events_map_or_skip() {
        let ev = |json: &str| -> GlabMilestoneEvent {
            serde_json::from_str(json).expect("milestone event should parse")
        };
        match map_issue_milestone_event(ev(r#"{"action":"add",
            "created_at":"2026-08-23T00:00:00Z","user":{"username":"theBGuy"},
            "milestone":{"title":"v1.0"}}"#)) {
            Some(ForgeTimelineEventOut::Milestoned {
                milestone,
                added,
                actor,
                date,
            }) => {
                assert_eq!(milestone, "v1.0");
                assert!(added);
                assert_eq!(actor.id, "theBGuy");
                assert_eq!(date, "2026-08-23T00:00:00Z");
            }
            _ => panic!("expected Milestoned"),
        }
        assert!(matches!(
            map_issue_milestone_event(ev(r#"{"action":"remove",
                "created_at":"2026-08-23T00:00:00Z","user":{"username":"theBGuy"},
                "milestone":{"title":"v1.0"}}"#)),
            Some(ForgeTimelineEventOut::Milestoned { added: false, .. })
        ));
        // A deleted milestone leaves `milestone: null` — the entry is skipped.
        assert!(map_issue_milestone_event(ev(r#"{"action":"add",
            "created_at":"2026-08-23T00:00:00Z","user":{"username":"theBGuy"},
            "milestone":null}"#))
        .is_none());
    }

    #[test]
    fn state_events_map_close_reopen_and_merge() {
        let ev = |state: &str| -> GlabStateEvent {
            serde_json::from_str(&format!(
                r#"{{"state":"{state}","created_at":"2026-08-23T00:00:00Z",
                    "user":{{"username":"theBGuy"}}}}"#
            ))
            .expect("state event should parse")
        };
        match map_state_event(ev("closed")) {
            Some(ForgeTimelineEventOut::Closed {
                state_reason,
                actor,
                date,
            }) => {
                // GitLab reports no close reason.
                assert!(state_reason.is_empty());
                assert_eq!(actor.id, "theBGuy");
                assert_eq!(date, "2026-08-23T00:00:00Z");
            }
            _ => panic!("expected Closed"),
        }
        assert!(matches!(
            map_state_event(ev("reopened")),
            Some(ForgeTimelineEventOut::Reopened { .. })
        ));
        // `merged` reaches this mapper only from the MR arm; GitLab never reports it
        // on an issue.
        assert!(matches!(
            map_state_event(ev("merged")),
            Some(ForgeTimelineEventOut::Merged {
                commit_oid: None,
                ..
            })
        ));
        // An unknown/new state is skipped rather than guessed.
        assert!(map_state_event(ev("weird_new_state")).is_none());
        assert!(map_state_event(ev("")).is_none());
    }

    #[test]
    fn timeline_sorts_ascending_by_date_empties_first() {
        let mut events = [
            ForgeTimelineEventOut::Merged {
                actor: gl_actor(None),
                commit_oid: None,
                date: "2026-07-02T00:00:00Z".into(),
            },
            ForgeTimelineEventOut::Approved {
                actor: gl_actor(None),
                date: String::new(),
            },
            ForgeTimelineEventOut::Closed {
                actor: gl_actor(None),
                state_reason: String::new(),
                date: "2026-07-01T00:00:00Z".into(),
            },
        ];
        events.sort_by(|a, b| timeline_event_date(a).cmp(timeline_event_date(b)));
        let dates: Vec<&str> = events.iter().map(timeline_event_date).collect();
        assert_eq!(
            dates,
            vec!["", "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"]
        );
    }

    #[test]
    fn message_body_strips_title_and_separator() {
        // Title + blank separator + body → the body only.
        assert_eq!(
            message_body_from_full("Fix the thing\n\nDetails here\nMore details"),
            "Details here\nMore details"
        );
        // A single-line message has no body.
        assert_eq!(message_body_from_full("Just a title"), "");
        // No blank separator (title directly followed by body) still drops the title.
        assert_eq!(message_body_from_full("Title\nbody line"), "body line");
        // Trailing whitespace/newlines are trimmed.
        assert_eq!(message_body_from_full("Title\n\nbody\n\n"), "body");
        // Empty message → empty body.
        assert_eq!(message_body_from_full(""), "");
        // CRLF: the separator after the title's own "\r" line is consumed.
        assert_eq!(
            message_body_from_full("Title\r\n\r\nbody"),
            "body".trim_end()
        );
    }

    #[test]
    fn commit_comment_id_parses_and_rejects_malformed() {
        // Valid composite: opaque hex discussion id + numeric note id.
        assert_eq!(
            parse_commit_comment_id("abc123def:456").unwrap(),
            ("abc123def".to_string(), 456u64)
        );
        // No colon → rejected.
        assert!(parse_commit_comment_id("abc123").is_err());
        // Empty discussion id → rejected.
        assert!(parse_commit_comment_id(":456").is_err());
        // Non-numeric note id → rejected.
        assert!(parse_commit_comment_id("abc:notanumber").is_err());
        // Empty note id → rejected.
        assert!(parse_commit_comment_id("abc:").is_err());
    }

    #[test]
    fn commit_anchor_keeps_old_side_path_without_line() {
        // New side present → path + new line.
        let new_side = GlabCommitNotePosition {
            new_path: "src/main.rs".into(),
            new_line: Some(42),
            old_path: "src/main.rs".into(),
            line_range: None,
        };
        assert_eq!(
            gl_commit_anchor(&new_side),
            (Some("src/main.rs".to_string()), Some(42))
        );
        // Old-side-only (a comment on a removed line): keep old_path, but line stays
        // None — the old-side number must NOT be mapped into the new-side `line`.
        let old_side = GlabCommitNotePosition {
            new_path: String::new(),
            new_line: None,
            old_path: "src/old.rs".into(),
            line_range: None,
        };
        assert_eq!(
            gl_commit_anchor(&old_side),
            (Some("src/old.rs".to_string()), None)
        );
        // Neither side → whole-commit (no path, no line).
        let none = GlabCommitNotePosition {
            new_path: String::new(),
            new_line: None,
            old_path: String::new(),
            line_range: None,
        };
        assert_eq!(gl_commit_anchor(&none), (None, None));
    }

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
            "labels": ["enhancement", "ui"],
            "created_at": "2026-07-01T10:00:00Z"
        }"#;
        let p = from_glab_mr(serde_json::from_str(json).unwrap());
        assert_eq!(p.number, 7);
        assert_eq!(p.base_ref_name, "main");
        assert_eq!(p.head_ref_name, "feature/dark");
        assert_eq!(p.state, "MERGED");
        assert_eq!(p.author.unwrap().login, "alice");
        assert_eq!(p.labels.len(), 2);
        // Opened-time maps through (CI status is a separate follow-up fetch).
        assert_eq!(p.created_at, "2026-07-01T10:00:00Z");
        // The fixture carries no project ids at all — absent must read as same-repo.
        assert!(!p.cross_repository);
    }

    /// A fork MR's source project differs from its target; either id absent (an
    /// older cached shape) must read as same-repo, never as a fork.
    #[test]
    fn cross_repository_compares_mr_project_ids() {
        let mr = |ids: &str| -> PrInfo {
            let json = format!(
                r#"{{"iid":7,"web_url":"","title":"t","target_branch":"main",
                     "source_branch":"feat","state":"opened"{ids}}}"#
            );
            from_glab_mr(serde_json::from_str(&json).unwrap())
        };
        // Differing projects → a fork MR.
        assert!(mr(r#","source_project_id":42,"target_project_id":7"#).cross_repository);
        // Same project → a plain branch MR.
        assert!(!mr(r#","source_project_id":7,"target_project_id":7"#).cross_repository);
        // Either side missing or null → false rather than a guess.
        assert!(!mr(r#","target_project_id":7"#).cross_repository);
        assert!(!mr(r#","source_project_id":42"#).cross_repository);
        assert!(!mr(r#","source_project_id":null,"target_project_id":7"#).cross_repository);
    }

    #[test]
    fn pipeline_status_maps_to_ci_signal() {
        assert_eq!(pipeline_status_to_ci(Some("SUCCESS")), "passing");
        assert_eq!(pipeline_status_to_ci(Some("SKIPPED")), "passing");
        assert_eq!(pipeline_status_to_ci(Some("FAILED")), "failing");
        assert_eq!(pipeline_status_to_ci(Some("CANCELED")), "failing");
        assert_eq!(pipeline_status_to_ci(Some("CANCELING")), "failing");
        assert_eq!(pipeline_status_to_ci(Some("RUNNING")), "pending");
        assert_eq!(pipeline_status_to_ci(Some("PENDING")), "pending");
        assert_eq!(pipeline_status_to_ci(Some("PREPARING")), "pending");
        assert_eq!(pipeline_status_to_ci(Some("WAITING_FOR_RESOURCE")), "pending");
        // Case-insensitive; unknown → pending (never a false green).
        assert_eq!(pipeline_status_to_ci(Some("running")), "pending");
        assert_eq!(pipeline_status_to_ci(Some("SOMETHING_NEW")), "pending");
        // Null / empty head pipeline → none.
        assert_eq!(pipeline_status_to_ci(None), "none");
        assert_eq!(pipeline_status_to_ci(Some("")), "none");
    }

    #[test]
    fn parse_mr_url_project_extracts_host_and_full_path() {
        // gitlab.com, single-level group.
        let (host, path) =
            parse_mr_url_project("https://gitlab.com/gitlab-org/gitlab/-/merge_requests/245499")
                .unwrap();
        assert_eq!(host, "gitlab.com");
        assert_eq!(path, "gitlab-org/gitlab");

        // Multi-level (nested sub-group) path is normal for GitLab.
        let (host, path) = parse_mr_url_project(
            "https://gitlab.example.com/group/sub/project/-/merge_requests/3",
        )
        .unwrap();
        assert_eq!(host, "gitlab.example.com");
        assert_eq!(path, "group/sub/project");

        // Malformed: not an MR url, too-shallow path, `-`-prefixed segment.
        assert!(parse_mr_url_project("https://gitlab.com/gitlab-org/gitlab/-/issues/1").is_err());
        assert!(parse_mr_url_project("https://gitlab.com/only/-/merge_requests/1").is_err());
        assert!(
            parse_mr_url_project("https://gitlab.com/-evil/project/-/merge_requests/1").is_err()
        );
        assert!(parse_mr_url_project("not a url").is_err());
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

    /// `has_conflicts` OUTRANKS `detailed_merge_status`: the detailed status
    /// reports the first blocking reason (CI, approvals), so a conflicting MR can
    /// present as `ci_still_running` — which is exactly how a conflicting PR came
    /// to look clean.
    #[test]
    fn maps_gitlab_mergeability_conflicts_over_detailed_status() {
        let m = map_gl_mergeability("opened", Some(true), "ci_still_running", None);
        assert_eq!(m.state, "conflicting");
        assert_eq!(m.detail.as_deref(), Some("ci_still_running"));

        let m = map_gl_mergeability("opened", Some(false), "mergeable", None);
        assert_eq!(m.state, "mergeable");

        // GitLab NULLS has_conflicts while recomputing — the detailed status is
        // then the only carrier of the conflict, and must still be believed.
        assert_eq!(
            map_gl_mergeability("opened", None, "conflict", None).state,
            "conflicting"
        );
        assert_eq!(
            map_gl_mergeability("opened", Some(false), "conflict", None).state,
            "conflicting"
        );

        // Blocked-but-not-conflicting is still mergeable as far as CONFLICTS go —
        // this signal answers "would it merge cleanly", not "may it merge".
        assert_eq!(
            map_gl_mergeability("opened", Some(false), "not_approved", None).state,
            "mergeable"
        );

        // The still-computing set, empty string included (GitLab hasn't answered).
        // `broken_status` joins it deliberately: GitLab documents it as "cannot
        // merge the source into the target, potential conflict", so it must not
        // lean mergeable.
        for s in ["checking", "unchecked", "preparing", "broken_status", ""] {
            assert_eq!(
                map_gl_mergeability("opened", None, s, None).state,
                "checking",
                "detailed_merge_status={s:?}"
            );
        }

        // Not open (either spelling) ⇒ no live mergeability, and NO detail: a
        // leftover status would describe a computation that no longer applies.
        let m = map_gl_mergeability("merged", Some(true), "mergeable", None);
        assert_eq!(m.state, "unavailable");
        assert!(m.detail.is_none(), "got: {:?}", m.detail);
        let m = map_gl_mergeability("opened", Some(true), "not_open", Some("Merge conflict"));
        assert_eq!(m.state, "unavailable");
        assert!(m.detail.is_none(), "got: {:?}", m.detail);

        // merge_error wins the detail slot; an empty one falls back to the status.
        assert_eq!(
            map_gl_mergeability("opened", Some(true), "broken_status", Some("Merge conflict"))
                .detail
                .as_deref(),
            Some("Merge conflict")
        );
        assert_eq!(
            map_gl_mergeability("opened", Some(true), "broken_status", Some(""))
                .detail
                .as_deref(),
            Some("broken_status")
        );
        assert_eq!(map_gl_mergeability("opened", None, "", None).detail, None);
    }

    /// GitLab sends `null` for these scalars while a status is being computed; a
    /// present `null` must not fail the whole parse (the negative control).
    #[test]
    fn mr_mergeability_tolerates_nulls() {
        let json = r#"{
            "iid": 6,
            "state": "opened",
            "has_conflicts": null,
            "detailed_merge_status": null,
            "merge_error": null
        }"#;
        let mr: GlabMrMergeability = serde_json::from_str(json).unwrap();
        assert_eq!(mr.iid, 6);
        assert_eq!(mr.has_conflicts, None);
        assert_eq!(mr.detailed_merge_status, "");
        assert_eq!(mr.merge_error, None);
        let m = map_gl_mergeability(
            &mr.state,
            mr.has_conflicts,
            &mr.detailed_merge_status,
            mr.merge_error.as_deref(),
        );
        assert_eq!(m.state, "checking");
        assert_eq!(m.detail, None);
    }

    /// The `/changes` payload the MR view already fetches carries the conflict and
    /// project-id fields, so the detail view costs no extra HTTP.
    #[test]
    fn mr_changes_carries_mergeability_and_fork_ids() {
        let json = r#"{
            "iid": 6, "web_url": "u", "title": "t", "target_branch": "main",
            "source_branch": "feat", "state": "opened",
            "has_conflicts": true, "detailed_merge_status": "broken_status",
            "source_project_id": 2, "target_project_id": 1
        }"#;
        let mr: GlabMrChanges = serde_json::from_str(json).unwrap();
        assert_eq!(mr.has_conflicts, Some(true));
        assert_eq!(
            map_gl_mergeability(
                &mr.state,
                mr.has_conflicts,
                &mr.detailed_merge_status,
                mr.merge_error.as_deref()
            )
            .state,
            "conflicting"
        );
        assert_ne!(mr.source_project_id, mr.target_project_id);

        // Same project ⇒ not a fork; a missing id must NOT read as a fork.
        let same: GlabMrChanges = serde_json::from_str(
            r#"{"iid":6,"web_url":"u","title":"t","target_branch":"main",
                "source_branch":"feat","state":"opened",
                "source_project_id":1,"target_project_id":1}"#,
        )
        .unwrap();
        assert_eq!(same.source_project_id, same.target_project_id);
        let absent: GlabMrChanges = serde_json::from_str(
            r#"{"iid":6,"web_url":"u","title":"t","target_branch":"main",
                "source_branch":"feat","state":"opened"}"#,
        )
        .unwrap();
        assert_eq!(absent.source_project_id, None);
        assert_eq!(absent.target_project_id, None);
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

    /// The merge PUT gets the same envelope treatment as the cancel: a refusal can
    /// ride a zero exit, and the success body is the MR object, which carries no
    /// marker and must stay success. The message/status pair is the one GitLab
    /// documents for a failed merge (`422 Branch cannot be merged`).
    #[test]
    fn a_merge_put_that_exits_zero_still_reports_an_error_envelope() {
        assert_eq!(
            service_error_message(
                r#"{"message":"Branch cannot be merged","status":"error","http_status":422}"#
            )
            .as_deref(),
            Some("Branch cannot be merged")
        );
        assert_eq!(
            service_error_message(
                r#"{"iid":7,"state":"merged","detailed_merge_status":"mergeable","merge_commit_sha":"abc"}"#
            ),
            None
        );
    }

    /// glab's two stderr forms for an API failure, pinned as fixtures: with a server
    /// `message` it writes `glab: <message> (HTTP <code>)`, without one a bare
    /// `glab: HTTP <code>` (`internal/commands/api/api.go`).
    #[test]
    fn reads_the_status_glab_reports_for_a_failed_call() {
        assert_eq!(
            glab_http_status("glab: 405 Method Not Allowed (HTTP 405)\n"),
            Some(405)
        );
        assert_eq!(glab_http_status("glab: HTTP 409\n"), Some(409));
        // The trailing occurrence is glab's; a code inside the server message is not.
        assert_eq!(
            glab_http_status("glab: 404 Project Not Found (HTTP 403)\n"),
            Some(403)
        );
        assert_eq!(glab_http_status("could not resolve host\n"), None);
        assert_eq!(glab_http_status(""), None);
    }

    /// Only the two statuses GitLab documents for the merge endpoint are reworded —
    /// 405 for an MR that can't be merged, 409 for a `sha` that no longer matches the
    /// source head. Everything else falls open to glab's own text.
    #[test]
    fn classifies_the_documented_merge_refusals() {
        assert_eq!(
            classify_gl_merge_refusal("glab: 405 Method Not Allowed (HTTP 405)\n", false)
                .as_deref(),
            Some(
                "GitLab is blocking this merge — the merge request isn't in a mergeable state yet."
            )
        );
        assert_eq!(
            classify_gl_merge_refusal(
                "glab: SHA does not match HEAD of source branch (HTTP 409)\n",
                false
            )
            .as_deref(),
            Some("The merge request changed while merging — refresh and retry.")
        );
        // A 405 on the arming path means no auto-merge strategy was available AND the
        // head pipeline isn't passing; which strategies exist is version- and
        // edition-dependent, so that arm keeps glab's own wording.
        assert_eq!(
            classify_gl_merge_refusal("glab: 405 Method Not Allowed (HTTP 405)\n", true),
            None
        );
        // The stale-sha guard means the same thing whichever wrapper armed it.
        assert!(classify_gl_merge_refusal("glab: HTTP 409\n", true).is_some());
    }

    /// Fail-open control: an unrecognized failure classifies to nothing, so the caller
    /// surfaces glab's raw stderr rather than an invented reason.
    #[test]
    fn leaves_an_unrecognized_merge_failure_alone() {
        for raw in [
            "",
            "glab: 401 Unauthorized (HTTP 401)\n",
            "glab: HTTP 500\n",
            "could not resolve host gitlab.example.com\n",
        ] {
            assert_eq!(classify_gl_merge_refusal(raw, false), None, "raw: {raw:?}");
        }
    }

    /// A plain merge sends neither auto-merge param, and `sha` rides along only when
    /// non-empty — the stale-view guard is opt-in, an empty `sha=` would be rejected.
    #[test]
    fn merge_mr_args_send_no_auto_merge_params_unless_arming() {
        let plain = merge_mr_args("projects/9/merge_requests/7/merge", true, false, None, false);
        assert_eq!(
            plain,
            vec![
                "api",
                "--method",
                "PUT",
                "projects/9/merge_requests/7/merge",
                "-f",
                "squash=true",
                "-f",
                "should_remove_source_branch=false",
            ]
        );
        assert!(!plain.iter().any(|a| a.contains("auto_merge")));
        assert!(
            !plain
                .iter()
                .any(|a| a.contains("merge_when_pipeline_succeeds"))
        );

        let empty_sha = merge_mr_args(
            "projects/9/merge_requests/7/merge",
            true,
            false,
            Some(""),
            false,
        );
        assert_eq!(empty_sha, plain);

        let guarded = merge_mr_args(
            "projects/9/merge_requests/7/merge",
            false,
            true,
            Some("abc123"),
            false,
        );
        assert_eq!(
            guarded,
            vec![
                "api",
                "--method",
                "PUT",
                "projects/9/merge_requests/7/merge",
                "-f",
                "squash=false",
                "-f",
                "should_remove_source_branch=true",
                "-f",
                "sha=abc123",
            ]
        );
    }

    /// Arming sends BOTH `merge_when_pipeline_succeeds` (deprecated as a request param
    /// in 17.11) and `auto_merge`, so pre-17.11 instances still arm and 17.11+ ones OR
    /// the pair into a single arm. `auto_merge` alone would merge a pre-17.11 MR
    /// outright. Everything else must be byte-identical to the plain merge.
    #[test]
    fn merge_mr_args_arm_with_both_auto_merge_params() {
        let plain = merge_mr_args(
            "projects/9/merge_requests/7/merge",
            false,
            true,
            Some("abc123"),
            false,
        );
        let arming = merge_mr_args(
            "projects/9/merge_requests/7/merge",
            false,
            true,
            Some("abc123"),
            true,
        );
        assert_eq!(arming[..plain.len()], plain[..]);
        assert_eq!(
            arming[plain.len()..],
            [
                "-f",
                "merge_when_pipeline_succeeds=true",
                "-f",
                "auto_merge=true",
            ]
        );
        // `-f` is glab's raw field: no leading-`@` file-read magic on any value.
        assert!(!arming.iter().any(|a| a == "-F"));
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
        // bare `#[serde(default)]` field fails the WHOLE parse on a present `null` —
        // `null_to_default` must absorb every one.
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
        assert_eq!(
            issue.labels,
            vec!["enhancement".to_string(), "ui".to_string()]
        );
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
        assert_eq!(
            map_ci_status("success"),
            ("completed".into(), "success".into())
        );
        assert_eq!(
            map_ci_status("failed"),
            ("completed".into(), "failure".into())
        );
        assert_eq!(
            map_ci_status("canceled"),
            ("completed".into(), "cancelled".into())
        );
        assert_eq!(
            map_ci_status("skipped"),
            ("completed".into(), "skipped".into())
        );
        assert_eq!(
            map_ci_status("manual"),
            ("completed".into(), "action_required".into())
        );
        // In-flight states map to a non-completed lifecycle (so the UI keeps polling).
        assert_eq!(
            map_ci_status("running"),
            ("in_progress".into(), String::new())
        );
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
        assert!(
            !cleaned.contains('\u{1b}'),
            "ANSI escapes remain: {cleaned:?}"
        );
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
        assert_eq!(
            encode_query_value("feature/dark-mode"),
            "feature%2Fdark-mode"
        );
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
        // No description / assets / `_links`: GitLab sends `null` for the body, which
        // `null_to_default` must absorb (same trap as the issue parse).
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
        let list = vec![
            mk("v2.0.0-next", true),
            mk("v1.1.0", false),
            mk("v1.0.0", false),
        ];
        let infos = releases_to_infos(&list);
        assert!(!infos[0].is_latest, "an upcoming release is never latest");
        assert!(infos[1].is_latest, "the newest published release is latest");
        assert!(!infos[2].is_latest);
    }

    #[test]
    fn pipeline_variable_keys_reject_invalid_env_names() {
        // Env-var names only: no punctuation, no space, no leading digit.
        assert!(valid_pipeline_variable_key("DEPLOY_ENV"));
        assert!(valid_pipeline_variable_key("_private"));
        assert!(valid_pipeline_variable_key("key2"));
        assert!(!valid_pipeline_variable_key(""));
        assert!(!valid_pipeline_variable_key("has:colon"));
        assert!(!valid_pipeline_variable_key("has space"));
        assert!(!valid_pipeline_variable_key("2leading"));
        assert!(!valid_pipeline_variable_key("-flag"));
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
            "author": { "username": "theBGuy" },
            "created_at": "2026-01-02T03:04:05Z"
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
        // Open time rides through for the missed-open catch-up's recency window.
        assert_eq!(info.created_at, "2026-01-02T03:04:05Z");
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
        // Absent `created_at` defaults to "" (the frontend fails closed on it).
        assert_eq!(info.created_at, "");
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

        let refused =
            r#"{"data":{"mergeRequestRequestChanges":{"errors":["Reviewer not found"]}}}"#;
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
        let err = update_protected_branch("/repo", "", false)
            .await
            .unwrap_err();
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

    // ── Multi-line range: parser refs, line_code, and read-side fallback ──────────

    #[test]
    fn diff_line_refs_new_file_added_lines() {
        // A brand-new file: `@@ -0,0 +1,6 @@`, only `+` lines. old never advances,
        // so line 2 ⇒ (0, 2) and line 4 ⇒ (0, 4) — GitLab's `_0_N` semantics.
        let diff = "@@ -0,0 +1,6 @@\n+one\n+two\n+three\n+four\n+five\n+six\n";
        assert_eq!(gl_diff_line_refs(diff, "new", 2), Some((0, 2)));
        assert_eq!(gl_diff_line_refs(diff, "new", 4), Some((0, 4)));
        // Line 1 is the hunk's first `+` line ⇒ (0, 1).
        assert_eq!(gl_diff_line_refs(diff, "new", 1), Some((0, 1)));
    }

    #[test]
    fn diff_line_refs_mixed_hunk_context_add_remove() {
        // A mixed hunk: context advances both counters, `-` advances old only,
        // `+` advances new only.
        let diff = "@@ -10,4 +10,4 @@\n ctx\n-gone\n+new\n a\n b\n";
        // New-side line 11 is the `+new` line ⇒ (12, 11) (old counter is 12 there).
        assert_eq!(gl_diff_line_refs(diff, "new", 11), Some((12, 11)));
        // New-side context line 12 ⇒ (12, 12).
        assert_eq!(gl_diff_line_refs(diff, "new", 12), Some((12, 12)));
        // Old-side line 11 is the removed `-gone` line ⇒ (11, 11).
        assert_eq!(gl_diff_line_refs(diff, "old", 11), Some((11, 11)));
        // Old-side context line 10 ⇒ (10, 10).
        assert_eq!(gl_diff_line_refs(diff, "old", 10), Some((10, 10)));
    }

    #[test]
    fn diff_line_refs_multi_hunk() {
        // Two hunks; a line only resolvable in the second hunk.
        let diff = "@@ -1,2 +1,2 @@\n a\n b\n@@ -50,2 +50,3 @@\n c\n+added\n d\n";
        // New line 51 is the `+added` line in the second hunk ⇒ (51, 51).
        assert_eq!(gl_diff_line_refs(diff, "new", 51), Some((51, 51)));
        // New line 2 is `b` in the first hunk ⇒ (2, 2).
        assert_eq!(gl_diff_line_refs(diff, "new", 2), Some((2, 2)));
    }

    #[test]
    fn diff_line_refs_skips_no_newline_marker() {
        // The `\ No newline at end of file` marker must not advance any counter.
        let diff = "@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file\n";
        assert_eq!(gl_diff_line_refs(diff, "new", 2), Some((0, 2)));
        // Nothing past line 2 exists.
        assert_eq!(gl_diff_line_refs(diff, "new", 3), None);
    }

    #[test]
    fn diff_line_refs_function_context_heading_with_arrow() {
        // The hunk carries a git function-context heading containing a `->` return
        // type. The `->` token must NOT clobber the old range start (it lives past the
        // closing `@@`). Line 41 (the `+` line) must still resolve — with a line_code.
        let diff = "@@ -40,3 +40,4 @@ fn foo() -> Result<T> {\n ctx\n+added\n more\n";
        // Walk from (40,40): " ctx" → (40,40), advance both → (41,41); "+added"
        // new=41 → (41,41). The `->` in the heading must not have broken the range.
        assert_eq!(gl_diff_line_refs(diff, "new", 41), Some((41, 41)));
        assert_eq!(gl_diff_line_refs(diff, "new", 40), Some((40, 40)));
    }

    #[test]
    fn diff_line_refs_heading_with_trailing_signed_number() {
        // A heading ending in a `+N`/`-N` token must NOT overwrite the real range
        // starts. Range starts stay 1/1; the heading's "+5"/"-3" are ignored.
        let plus = "@@ -1,2 +1,2 @@ label +5 items\n a\n b\n";
        assert_eq!(gl_diff_line_refs(plus, "new", 2), Some((2, 2)));
        assert_eq!(gl_diff_line_refs(plus, "old", 1), Some((1, 1)));
        let minus = "@@ -1,2 +1,2 @@ heading -3\n a\n b\n";
        assert_eq!(gl_diff_line_refs(minus, "new", 2), Some((2, 2)));
        assert_eq!(gl_diff_line_refs(minus, "old", 1), Some((1, 1)));
    }

    #[test]
    fn diff_line_refs_heading_with_literal_double_at() {
        // A Ruby-style `@@var` in the section heading, AFTER the closing `@@`. The
        // first-`@@`-cut isolates the true range; the second `@@` is untrusted text.
        let diff = "@@ -5,2 +5,3 @@ def m; @@count += 1\n ctx\n+new\n tail\n";
        // From (5,5): " ctx" → (5,5), advance both → (6,6); "+new" new=6 → (6,6). The
        // literal `@@` in the heading must not have confused the range parse.
        assert_eq!(gl_diff_line_refs(diff, "new", 6), Some((6, 6)));
        assert_eq!(gl_diff_line_refs(diff, "new", 5), Some((5, 5)));
    }

    #[test]
    fn parse_hunk_header_ignores_untrusted_heading() {
        // Direct unit coverage of the range/heading split (input is the text AFTER the
        // leading `@@`, as `gl_diff_line_refs` passes it).
        assert_eq!(
            parse_hunk_header(" -40,3 +40,4 @@ fn f() -> T"),
            Some((40, 40))
        );
        assert_eq!(parse_hunk_header(" -1,2 +1,2 @@ x +5"), Some((1, 1)));
        assert_eq!(parse_hunk_header(" -5,2 +5,3 @@ @@count"), Some((5, 5)));
        // A malformed range (no `+` start) is still None.
        assert_eq!(parse_hunk_header(" -1,2 @@ heading"), None);
    }

    #[test]
    fn diff_line_refs_line_not_in_diff_is_none() {
        let diff = "@@ -0,0 +1,2 @@\n+a\n+b\n";
        assert_eq!(gl_diff_line_refs(diff, "new", 99), None);
        assert_eq!(gl_diff_line_refs(diff, "old", 1), None);
        // Empty diff (unresolvable file) ⇒ None for any line → line_code-less fallback.
        assert_eq!(gl_diff_line_refs("", "new", 1), None);
    }

    #[test]
    fn line_code_matches_gitlab_new_file_shape() {
        // sha1_hex(file_path)_<old>_<new>; the sha1 of "a.txt" is stable and known.
        let code = gl_line_code("a.txt", 0, 2);
        assert!(code.ends_with("_0_2"), "code = {code}");
        // 40 hex chars + "_0_2".
        let sha = code.trim_end_matches("_0_2");
        assert_eq!(sha.len(), 40);
        assert!(sha.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn build_line_range_carries_line_code_and_type() {
        // A new-file range 2..=4: both refs carry type="new", the explicit new_line,
        // and a line_code resolved from the diff.
        let diff = "@@ -0,0 +1,6 @@\n+1\n+2\n+3\n+4\n+5\n+6\n";
        let range = gl_build_line_range(diff, "a.txt", "new", 2, 4);
        let start = &range["start"];
        let end = &range["end"];
        assert_eq!(start["type"], "new");
        assert_eq!(start["new_line"], 2);
        assert!(start["line_code"].as_str().unwrap().ends_with("_0_2"));
        assert_eq!(end["type"], "new");
        assert_eq!(end["new_line"], 4);
        assert!(end["line_code"].as_str().unwrap().ends_with("_0_4"));
    }

    #[test]
    fn build_line_range_falls_back_without_line_code() {
        // Unresolvable file (empty diff): refs keep type + line but NO line_code — the
        // accepted fallback form; a post must never fail over line_code.
        let range = gl_build_line_range("", "missing.txt", "old", 3, 5);
        let start = &range["start"];
        assert_eq!(start["type"], "old");
        assert_eq!(start["old_line"], 3);
        assert!(start.get("line_code").is_none());
        assert_eq!(range["end"]["old_line"], 5);
        assert!(range["end"].get("line_code").is_none());
    }

    #[test]
    fn range_ref_line_prefers_explicit_field_then_line_code() {
        // Explicit new_line wins on the new side.
        let explicit = GlabLineRangeRef {
            new_line: Some(7),
            old_line: None,
            line_code: Some("abc123_0_9".into()),
            ref_type: Some("new".into()),
        };
        assert_eq!(gl_range_ref_line(&explicit, "new"), Some(7));

        // line_code-only: parse the trailing `_<old>_<new>` — new side ⇒ new part.
        let code_only = GlabLineRangeRef {
            new_line: None,
            old_line: None,
            line_code: Some("deadbeef_4_11".into()),
            ref_type: Some("new".into()),
        };
        assert_eq!(gl_range_ref_line(&code_only, "new"), Some(11));
        // Old side of the same ref ⇒ the old part.
        assert_eq!(gl_range_ref_line(&code_only, "old"), Some(4));

        // Garbage line_code (no numeric tail) ⇒ None.
        let garbage = GlabLineRangeRef {
            new_line: None,
            old_line: None,
            line_code: Some("not-a-code".into()),
            ref_type: None,
        };
        assert_eq!(gl_range_ref_line(&garbage, "new"), None);
        // A bare `_1_2` (empty sha prefix) is rejected.
        let no_prefix = GlabLineRangeRef {
            new_line: None,
            old_line: None,
            line_code: Some("_1_2".into()),
            ref_type: None,
        };
        assert_eq!(gl_range_ref_line(&no_prefix, "new"), None);

        // Absent everything ⇒ None.
        let empty = GlabLineRangeRef::default();
        assert_eq!(gl_range_ref_line(&empty, "new"), None);
        assert_eq!(gl_range_ref_line(&empty, "old"), None);
    }

    #[test]
    fn file_diff_matches_by_side_path() {
        let changes = vec![GlabChange {
            old_path: "old_name.rs".into(),
            new_path: "new_name.rs".into(),
            new_file: false,
            deleted_file: false,
            diff: "@@ -1 +1 @@\n-a\n+b\n".into(),
        }];
        // New side matches on new_path; old side on old_path.
        assert!(gl_file_diff(&changes, "new_name.rs", "new").is_some());
        assert!(gl_file_diff(&changes, "old_name.rs", "old").is_some());
        // Cross-side lookups miss (new_path on the old side, etc.).
        assert!(gl_file_diff(&changes, "new_name.rs", "old").is_none());
        assert!(gl_file_diff(&changes, "absent.rs", "new").is_none());
    }

    #[test]
    fn write_access_from_level_maps_push_triage_and_role() {
        let role = |level| write_access_from_level(level).2;
        assert_eq!(write_access_from_level(50), (true, true, Some("owner".into())));
        assert_eq!(
            write_access_from_level(40),
            (true, true, Some("maintainer".into()))
        );
        assert_eq!(
            write_access_from_level(30),
            (true, true, Some("developer".into()))
        );
        // Reporter can't push but DOES manage issue/MR metadata.
        assert_eq!(
            write_access_from_level(20),
            (false, true, Some("reporter".into()))
        );
        assert_eq!(
            write_access_from_level(10),
            (false, false, Some("guest".into()))
        );
        // No membership resolved at all is an affirmative "no" on both axes.
        assert_eq!(write_access_from_level(0), (false, false, None));
        // Levels the app doesn't name (5 = minimal access) stay unlabeled.
        assert_eq!(role(5), None);
        assert_eq!(role(35), None);
    }

    #[test]
    fn write_access_fields_treat_an_unanswered_fallback_as_a_floor() {
        let fields = |level, ambiguous: Option<&str>| {
            let a = write_access_fields(level, ambiguous.map(str::to_string));
            (a.can_push, a.can_triage, a.role, a.repo, a.unknown_reason)
        };
        // Developer already clears both bars, so an unanswered fallback is moot.
        assert_eq!(
            fields(30, Some("502 Bad Gateway")),
            (Some(true), Some(true), Some("developer".into()), None, None)
        );
        // Reporter clears triage but not push: only the unmet axis — and the
        // label, which the floor can understate — goes unknown, with the reason.
        assert_eq!(
            fields(20, Some("502 Bad Gateway")),
            (
                None,
                Some(true),
                None,
                None,
                Some("502 Bad Gateway".into())
            )
        );
        // Nothing resolved and no answer from the fallback: both axes unknown.
        assert_eq!(
            fields(0, Some("502 Bad Gateway")),
            (None, None, None, None, Some("502 Bad Gateway".into()))
        );
        // An answered fallback (404 = not a member) is an affirmative "no".
        assert_eq!(fields(0, None), (Some(false), Some(false), None, None, None));
    }
}
