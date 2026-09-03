//! GitHub Actions support, driven through the `gh` CLI (`gh run …` /
//! `gh workflow …`). Read views list and inspect workflow runs; mutations
//! re-run, cancel, and manually dispatch workflows. All repo-scoped via the
//! working directory, like the PR commands.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, run_gh_raw, GH_NETWORK_TIMEOUT};

/// gh emits `null` for a not-yet-decided conclusion (and timestamps that
/// haven't happened); fold those into "" so the frontend sees a plain string.
fn de_null_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

fn validate_ref(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid ref: {name}")));
    }
    Ok(())
}

/// One workflow run in the list view.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    #[serde(rename(serialize = "id", deserialize = "databaseId"))]
    pub id: u64,
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub display_title: String,
    /// "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending".
    #[serde(default)]
    pub status: String,
    /// "success" | "failure" | "cancelled" | … ; "" while still running.
    #[serde(default, deserialize_with = "de_null_string")]
    pub conclusion: String,
    #[serde(default)]
    pub workflow_name: String,
    /// The workflow this run belongs to, so a run row can re-dispatch its own
    /// workflow without a name lookup. 0 on providers with no per-workflow
    /// concept (GitLab pipelines, Bitbucket pipelines).
    #[serde(default)]
    pub workflow_database_id: u64,
    #[serde(default)]
    pub head_branch: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub created_at: String,
    /// When the run actually started executing (after any queue wait); paired
    /// with `updated_at` (≈ completion for a finished run) this gives run
    /// duration for the Insights Actions trend, with no extra API call.
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub head_sha: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub conclusion: String,
    #[serde(default)]
    pub number: i64,
    #[serde(default, deserialize_with = "de_null_string")]
    pub started_at: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub completed_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunJob {
    #[serde(rename(serialize = "id", deserialize = "databaseId"))]
    pub id: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub conclusion: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub started_at: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub completed_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub steps: Vec<RunStep>,
    /// Provider-specific reference for fetching this job's log when it can't be
    /// addressed by a numeric id. Bitbucket steps have no numeric id (only braced
    /// UUIDs), so its jobs carry `Some("{pipeline_uuid}/{step_uuid}")` for the
    /// `forge_bb_step_logs` command; GitHub and GitLab jobs use their numeric id
    /// and leave this `None`. Skipped in serialization when absent so existing gh
    /// JSON parsing is unaffected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_ref: Option<String>,
}

/// A run plus its jobs/steps, for the detail view.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    #[serde(rename(serialize = "id", deserialize = "databaseId"))]
    pub id: u64,
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub display_title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub conclusion: String,
    #[serde(default)]
    pub workflow_name: String,
    #[serde(default)]
    pub head_branch: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub head_sha: String,
    #[serde(default)]
    pub jobs: Vec<RunJob>,
}

/// One page of CI runs, provider-neutral: the rows plus what the provider will say
/// about how much more there is. `total_count` is `None` when the provider reports no
/// total, so a UI can tell "unknown" from a real count.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiRunPage {
    pub runs: Vec<WorkflowRun>,
    /// Total runs matching the query, when the provider reports one
    /// (GitHub always; Bitbucket when its envelope carries `size`; GitLab never).
    pub total_count: Option<u64>,
    pub has_more: bool,
}

/// A repo workflow, for the "Run workflow" picker.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: u64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// "active" | "disabled_manually" | "disabled_inactivity".
    #[serde(default)]
    pub state: String,
}

const RUN_VIEW_FIELDS: &str = "databaseId,number,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url,headSha,jobs";
/// Failed-step logs can run to many MB; keep the tail (failures land at the end).
const RUN_LOG_CAP: usize = 200_000;

/// The `repos/{slug}/actions/runs` envelope. Tolerant by design — forge JSON is
/// untrusted, so a shape change degrades one field instead of sinking the page.
#[derive(Debug, Default, Deserialize)]
struct RestRunPage {
    #[serde(default)]
    total_count: u64,
    #[serde(default)]
    workflow_runs: Vec<RestRun>,
}

/// One run as REST spells it — the snake_case twin of the `gh run list` JSON the
/// [`WorkflowRun`] field names follow. Every field is null-tolerant: GitHub sends
/// `null` for an undecided `conclusion` and for timestamps that haven't happened.
#[derive(Debug, Default, Deserialize)]
struct RestRun {
    #[serde(default)]
    id: u64,
    #[serde(default)]
    run_number: u64,
    #[serde(default)]
    workflow_id: u64,
    #[serde(default, deserialize_with = "de_null_string")]
    display_title: String,
    #[serde(default, deserialize_with = "de_null_string")]
    status: String,
    #[serde(default, deserialize_with = "de_null_string")]
    conclusion: String,
    /// The RUN's name, NOT the workflow's: a `run-name:` workflow and GitHub's dynamic
    /// workflows put a per-run string here (measured on theBGuy/GitDesktop: workflow
    /// 298718218 "Dependabot Updates" spells its runs "npm_and_yarn in /. for fast-uri
    /// - Update #1553823451"). Only a `workflow_id` lookup yields the workflow name.
    #[serde(default, deserialize_with = "de_null_string")]
    name: String,
    #[serde(default, deserialize_with = "de_null_string")]
    head_branch: String,
    #[serde(default, deserialize_with = "de_null_string")]
    event: String,
    #[serde(default, deserialize_with = "de_null_string")]
    created_at: String,
    #[serde(default, deserialize_with = "de_null_string")]
    run_started_at: String,
    #[serde(default, deserialize_with = "de_null_string")]
    updated_at: String,
    /// The BROWSER url; REST's `url` is the API endpoint, which no surface links to.
    #[serde(default, deserialize_with = "de_null_string")]
    html_url: String,
    #[serde(default, deserialize_with = "de_null_string")]
    head_sha: String,
}

/// Map one REST run onto the neutral row. `workflow_names` is the `workflow_id` →
/// workflow-name index; a run whose id it doesn't carry (an unlisted or since-deleted
/// workflow, or a workflow fetch that failed) falls back to the run's own `name`,
/// which is the workflow name for every workflow that doesn't override it.
fn from_rest_run(r: RestRun, workflow_names: &HashMap<u64, String>) -> WorkflowRun {
    let workflow_name = workflow_names
        .get(&r.workflow_id)
        .cloned()
        .unwrap_or(r.name);
    WorkflowRun {
        id: r.id,
        number: r.run_number,
        display_title: r.display_title,
        status: r.status,
        conclusion: r.conclusion,
        workflow_name,
        workflow_database_id: r.workflow_id,
        head_branch: r.head_branch,
        event: r.event,
        created_at: r.created_at,
        started_at: r.run_started_at,
        updated_at: r.updated_at,
        url: r.html_url,
        head_sha: r.head_sha,
    }
}

/// Whether a page follows the 1-based `page` just fetched. BOTH conditions must
/// hold: the count math alone could promise pages past a provider-side window, and a
/// short page ends paging whatever the count says.
fn gh_has_more(fetched: usize, limit: u32, page: u32, total_count: u64) -> bool {
    fetched == limit as usize && u64::from(page) * u64::from(limit) < total_count
}

/// How long a repo's workflow-name index stays trusted. Bounds the SECOND `gh` spawn
/// every run-list fetch would otherwise pay — multiplied by the header badge's 8–30s
/// poll and by one spawn per loaded page on the Actions panel's 5s poll. Staleness
/// runs one way: a workflow added or renamed inside the window has its runs labeled
/// with their own `name` until the entry expires, which for all but dynamic and
/// `run-name:` workflows is the same string. Errors are never cached.
const WORKFLOW_NAME_TTL: Duration = Duration::from_secs(300);

/// Cache map keyed by `(repo_path, slug)`; value is `(fetch time, workflow_id → name)`.
type WorkflowNameCache = Mutex<HashMap<(String, String), (Instant, HashMap<u64, String>)>>;

/// Per-`(repo, slug)` workflow-name index. `repo_path` is in the key for the same
/// reason [`DISPATCH_PROBE_CACHE`] carries it: `gh_origin_slug` strips the authority,
/// so an Enterprise remote and a github.com remote can present the same `owner/repo`
/// and would otherwise share one repo's names.
static WORKFLOW_NAME_CACHE: OnceLock<WorkflowNameCache> = OnceLock::new();

fn workflow_name_cache() -> &'static WorkflowNameCache {
    WORKFLOW_NAME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The cached index for `(repo_path, slug)`, only if an entry exists AND was fetched
/// less than `ttl` ago. The lock is held just long enough to clone the map.
fn workflow_names_get(
    repo_path: &str,
    slug: &str,
    ttl: Duration,
) -> Option<HashMap<u64, String>> {
    let guard = workflow_name_cache().lock().unwrap();
    let (fetched_at, names) = guard.get(&(repo_path.to_string(), slug.to_string()))?;
    (fetched_at.elapsed() < ttl).then(|| names.clone())
}

/// Record `names` as the current index for `(repo_path, slug)`, stamped now.
fn workflow_names_put(repo_path: &str, slug: &str, names: HashMap<u64, String>) {
    workflow_name_cache().lock().unwrap().insert(
        (repo_path.to_string(), slug.to_string()),
        (Instant::now(), names),
    );
}

/// The `workflow_id` → name index backing every run row's `workflowName`, served from
/// [`WORKFLOW_NAME_CACHE`] within [`WORKFLOW_NAME_TTL`] — a hit spawns no `gh` at all.
/// Advisory: a failed fetch yields an EMPTY index (every row falls back to its own
/// `name`) and is deliberately not cached, so the next call re-probes. Bounded by
/// [`fetch_workflows`]' 100-workflow limit: runs of workflows past it read as their own
/// names. No single-flight, matching this file's other caches: concurrent misses
/// compute the same value and the last write wins.
async fn workflow_name_index(repo_path: &str, slug: &str) -> HashMap<u64, String> {
    if let Some(hit) = workflow_names_get(repo_path, slug, WORKFLOW_NAME_TTL) {
        return hit;
    }
    match fetch_workflows(repo_path, slug).await {
        Ok(list) => {
            let names: HashMap<u64, String> =
                list.into_iter().map(|w| (w.id, w.name)).collect();
            workflow_names_put(repo_path, slug, names.clone());
            names
        }
        Err(_) => HashMap::new(),
    }
}

/// One page of workflow runs, newest first; optionally scoped to one branch. `page`
/// is 1-based.
///
/// REST rather than `gh run list`, which has no page flag. Query params ride `-f`
/// under `--method GET`: `gh api` with `-f` fields present defaults to POST, and only
/// under GET do they become query params. `-f` never `-F` — `-F`'s leading-`@` magic
/// reads host files. `exclude_pull_requests=true` is what `gh run list` itself sends;
/// it suppresses the per-run `pull_requests` array, which nothing here consumes.
///
/// The workflow-name index resolves alongside, concurrently, because a run's REST
/// `name` is the RUN's name — `gh run list` resolves `workflowName` through the same
/// `workflow_id` lookup, and skipping it would label every dynamic/`run-name:` run
/// with its own title. [`workflow_name_index`] serves it from cache when it can, so a
/// fetch inside its TTL spawns no additional `gh` for the name index.
pub async fn gh_run_page(
    repo_path: String,
    limit: u32,
    page: u32,
    branch: Option<String>,
) -> AppResult<CiRunPage> {
    let limit = limit.clamp(1, 100);
    let page = page.max(1);
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let endpoint = format!("repos/{slug}/actions/runs");
    let per_page_arg = format!("per_page={limit}");
    let page_arg = format!("page={page}");
    let branch_arg = match branch.as_deref().filter(|s| !s.is_empty()) {
        Some(b) => {
            validate_ref(b)?;
            Some(format!("branch={b}"))
        }
        None => None,
    };
    let mut args: Vec<&str> = vec![
        "api",
        "--method",
        "GET",
        endpoint.as_str(),
        "-f",
        per_page_arg.as_str(),
        "-f",
        page_arg.as_str(),
        "-f",
        "exclude_pull_requests=true",
    ];
    if let Some(b) = branch_arg.as_deref() {
        args.push("-f");
        args.push(b);
    }
    let (out, workflow_names) = tokio::join!(
        run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT),
        workflow_name_index(&repo_path, &slug),
    );
    let parsed: RestRunPage = serde_json::from_str(&out?.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the workflow runs: {e}")))?;
    let total_count = parsed.total_count;
    let runs: Vec<WorkflowRun> = parsed
        .workflow_runs
        .into_iter()
        .map(|r| from_rest_run(r, &workflow_names))
        .collect();
    Ok(CiRunPage {
        has_more: gh_has_more(runs.len(), limit, page, total_count),
        runs,
        total_count: Some(total_count),
    })
}

/// Recent workflow runs, newest first; optionally scoped to one branch — the first
/// page of [`gh_run_page`]. One fetch path, so the badge, notifications, MCP, and the
/// Actions panel can't drift on the field mapping.
pub async fn gh_run_list(
    repo_path: String,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<WorkflowRun>> {
    Ok(gh_run_page(repo_path, limit, 1, branch).await?.runs)
}

/// One run with its jobs and steps.
pub async fn gh_run_view(repo_path: String, run_id: u64) -> AppResult<RunDetail> {
    let id = run_id.to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["run", "view", "-R", &slug, &id, "--json", RUN_VIEW_FIELDS],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh run view: {e}")))
}

/// Re-runs a completed run — all jobs, or only the failed ones.
pub async fn gh_run_rerun(repo_path: String, run_id: u64, failed: bool) -> AppResult<()> {
    let id = run_id.to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args = vec!["run", "rerun", "-R", slug.as_str(), id.as_str()];
    if failed {
        args.push("--failed");
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Approves a run that GitHub is withholding pending maintainer approval — the
/// gate on a first-time contributor's fork PR. There is no `gh run` verb for it,
/// so it goes through the REST endpoint directly. Distinct from
/// `pending_deployments`, which gates environment protection rules, not the run.
///
/// Lens-scoped, unlike its origin-pinned `gh_run_*` siblings: its surface is the
/// PR checks strip, which renders under the `upstream` lens too, where the held
/// run lives on the PARENT repo and an origin slug would 404.
pub async fn gh_run_approve(repo_path: String, run_id: u64, lens: Option<String>) -> AppResult<()> {
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/actions/runs/{run_id}/approve"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Cancels an in-progress run.
pub async fn gh_run_cancel(repo_path: String, run_id: u64) -> AppResult<()> {
    let id = run_id.to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &["run", "cancel", "-R", &slug, &id],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Logs of only the failed steps (`gh run view --log-failed`), tail-capped.
/// Read raw because gh exits non-zero on a failed run.
pub async fn gh_run_failed_logs(repo_path: String, run_id: u64) -> AppResult<String> {
    let id = run_id.to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["run", "view", "-R", &slug, &id, "--log-failed"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();
    if text.trim().is_empty() {
        // No failed-step logs (e.g. cancelled, or still running) — surface gh's
        // own message instead of an empty pane.
        text = out.stderr.trim().to_string();
    }
    if text.len() > RUN_LOG_CAP {
        let mut start = text.len() - RUN_LOG_CAP;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text = format!("…(earlier output truncated)\n{}", &text[start..]);
    }
    Ok(text)
}

/// Logs for one job, for AI debugging. Prefers the failed-step logs (highest
/// signal); falls back to the full job log when gh returns nothing for
/// `--log-failed`. Tighter cap than the run-level logs since this is fed to a
/// model. Read raw because gh exits non-zero on a failed run.
const JOB_LOG_CAP: usize = 60_000;

pub async fn gh_job_logs(repo_path: String, job_id: u64) -> AppResult<String> {
    let id = job_id.to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut out = run_gh_raw(
        Some(&repo_path),
        &["run", "view", "-R", &slug, "--job", &id, "--log-failed"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();
    if text.trim().is_empty() {
        out = run_gh_raw(
            Some(&repo_path),
            &["run", "view", "-R", &slug, "--job", &id, "--log"],
            GH_NETWORK_TIMEOUT,
        )
        .await?;
        text = out.stdout_lossy();
    }
    if text.trim().is_empty() {
        text = out.stderr.trim().to_string();
    }
    if text.len() > JOB_LOG_CAP {
        let mut start = text.len() - JOB_LOG_CAP;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text = format!("…(earlier output truncated)\n{}", &text[start..]);
    }
    Ok(text)
}

/// `-L 100` because gh's own default stops at 50 (measured, gh 2.94), and this list is
/// what names every run row's workflow — a truncated tail would silently degrade those
/// rows to their run names.
async fn fetch_workflows(repo_path: &str, slug: &str) -> AppResult<Vec<Workflow>> {
    let out = run_gh(
        Some(repo_path),
        &[
            "workflow",
            "list",
            "-R",
            slug,
            "--all",
            "-L",
            "100",
            "--json",
            "id,name,path,state",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh workflow list: {e}")))
}

/// The repo's workflows, for the manual-dispatch picker.
#[tauri::command]
pub async fn gh_workflow_list(repo_path: String) -> AppResult<Vec<Workflow>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    fetch_workflows(&repo_path, &slug).await
}

/// Whether a workflow's file can be addressed safely as a `gh api` endpoint
/// segment: gh expands `{…}` in an endpoint as an owner/repo placeholder, splits
/// the endpoint on `?` and `#` as query/fragment delimiters (all three retarget
/// the request), and reads a leading `-` as a flag.
fn is_probeable_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('-')
        && !path.contains('{')
        && !path.contains('}')
        && !path.contains('?')
        && !path.contains('#')
}

/// Real workflow files live here; `gh workflow list` also reports GitHub's dynamic
/// pseudo-workflows (Dependabot, the Copilot reviewer) under other prefixes.
const WORKFLOW_DIR: &str = ".github/workflows/";

/// What the probe can decide about one workflow from its path alone.
#[derive(Debug, PartialEq, Eq)]
enum PathVerdict {
    /// No user-authored file exists, so no trigger can be declared — a definite
    /// `false`, not the 404 that fetching would produce and that reads as unknown.
    NotDispatchable,
    /// Unaddressable as an endpoint segment; stays unknown so it keeps being offered.
    Unknown,
    Fetch,
}

fn classify_workflow_path(path: &str) -> PathVerdict {
    if !path.starts_with(WORKFLOW_DIR) {
        PathVerdict::NotDispatchable
    } else if is_probeable_path(path) {
        PathVerdict::Fetch
    } else {
        PathVerdict::Unknown
    }
}

/// Substring test rather than a YAML parse: every spelling of the trigger
/// (scalar, sequence item, mapping key, quoted) carries the literal token. A
/// mention in a comment therefore reads as `true` — the accepted false positive,
/// since that direction keeps the workflow offered and the humanized 422 backstops it.
fn yaml_declares_workflow_dispatch(content: &str) -> bool {
    content.contains("workflow_dispatch")
}

/// One gh process per workflow file. The gate is PROCESS-WIDE, not per call: each
/// settled keystroke in the ref field mints another probe, so a per-invocation cap
/// would still let K stale invocations fork 4K processes at once. Stale probes are
/// not cancelled, they just finish slowly.
const DISPATCH_PROBE_CONCURRENCY: usize = 4;
static DISPATCH_PROBE_GATE: tokio::sync::Semaphore =
    tokio::sync::Semaphore::const_new(DISPATCH_PROBE_CONCURRENCY);

/// How long a probe verdict stays trusted, per direction — the two stale directions
/// cost differently, so they get different windows.
#[derive(Debug, Clone, Copy)]
struct ProbeTtl {
    /// Window for a `true` verdict (the file declares the trigger).
    declared: Duration,
    /// Window for a `false` verdict.
    absent: Duration,
}

/// A workflow file's trigger block at a given ref changes on the order of releases, not
/// keystrokes, so a generous window is what keeps a repo's whole picker off the network
/// for a working session. The directions are asymmetric: a stale `true` merely re-offers
/// a workflow whose dispatch then refuses with the humanized 422, while a stale `false`
/// HIDES an action the user may have just enabled (`RunWorkflowDialog` refuses only on an
/// explicit `false`). This window bounds the staleness a frontend refetch can RE-ADOPT:
/// the two caches compose, since a refetch landing just inside it re-serves that verdict
/// for another frontend staleTime. Worst-case hide is therefore `absent` + one staleTime
/// (~600s), half of the ~900s a symmetric long window would give.
const DISPATCH_PROBE_TTL: ProbeTtl = ProbeTtl {
    declared: Duration::from_secs(600),
    absent: Duration::from_secs(300),
};

/// Cache map keyed by `(repo_path, slug, workflow_path, git_ref)`; value is
/// `(probe time, declares workflow_dispatch)`.
type DispatchProbeCache = Mutex<HashMap<(String, String, String, String), (Instant, bool)>>;

/// Per-`(repo, slug, workflow file, ref)` cache of the last probe verdict and when it was
/// taken. `repo_path` is in the key because the slug alone is NOT host-qualified —
/// `gh_origin_slug` resolves through `forge::remote_path`, which strips the authority, so
/// an Enterprise remote and a github.com remote sharing an `owner/repo` path would
/// otherwise collide and one repo's `false` could hide the other's workflow. Re-probing
/// the same key overwrites in place, but `git_ref` is a user-typed axis, so distinct refs
/// mint entries that live for the process lifetime — slow unbounded growth, unlike the
/// closed (repo, remote) key space of `REMOTE_URL_CACHE` this mirrors. An entry is a few
/// short strings and a bool, so no eviction machinery is warranted at this size. Only
/// PARSED verdicts are stored: an erred fetch leaves the key absent so it re-probes and
/// keeps failing open.
static DISPATCH_PROBE_CACHE: OnceLock<DispatchProbeCache> = OnceLock::new();

fn dispatch_probe_cache() -> &'static DispatchProbeCache {
    DISPATCH_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return the cached verdict for `(repo_path, slug, path, git_ref)` only if an entry
/// exists AND it was probed less than its direction's window ago — the stored verdict
/// picks the window, so one cache serves both. The lock is held only long enough to
/// read the value.
fn probe_cache_get(
    repo_path: &str,
    slug: &str,
    path: &str,
    git_ref: &str,
    ttl: ProbeTtl,
) -> Option<bool> {
    let guard = dispatch_probe_cache().lock().unwrap();
    let (probed_at, verdict) = guard.get(&(
        repo_path.to_string(),
        slug.to_string(),
        path.to_string(),
        git_ref.to_string(),
    ))?;
    let window = if *verdict { ttl.declared } else { ttl.absent };
    if probed_at.elapsed() < window {
        Some(*verdict)
    } else {
        None
    }
}

/// Record `verdict` as the current answer for `(repo_path, slug, path, git_ref)`,
/// stamped now.
fn probe_cache_put(repo_path: &str, slug: &str, path: &str, git_ref: &str, verdict: bool) {
    dispatch_probe_cache().lock().unwrap().insert(
        (
            repo_path.to_string(),
            slug.to_string(),
            path.to_string(),
            git_ref.to_string(),
        ),
        (Instant::now(), verdict),
    );
}

/// Split the active workflows into verdicts already decided and the files that still
/// need a contents fetch. Cache hits are resolved HERE, before the fan-out, so a hit
/// never takes a [`DISPATCH_PROBE_GATE`] permit nor spawns a gh process.
fn plan_probes<'a>(
    workflows: &'a [Workflow],
    repo_path: &str,
    slug: &str,
    git_ref: &str,
    ttl: ProbeTtl,
) -> (HashMap<String, bool>, Vec<&'a Workflow>) {
    let mut map = HashMap::new();
    let mut probes: Vec<&Workflow> = Vec::new();
    for w in workflows.iter().filter(|w| w.state == "active") {
        match classify_workflow_path(&w.path) {
            PathVerdict::NotDispatchable => {
                map.insert(w.id.to_string(), false);
            }
            PathVerdict::Unknown => {}
            PathVerdict::Fetch => match probe_cache_get(repo_path, slug, &w.path, git_ref, ttl) {
                Some(verdict) => {
                    map.insert(w.id.to_string(), verdict);
                }
                None => probes.push(w),
            },
        }
    }
    (map, probes)
}

/// Which active workflows declare a `workflow_dispatch` trigger at `git_ref`.
/// Keyed by stringified workflow id. A workflow ABSENT from the map is unknown
/// (probe failed) — callers fail open and keep it offered. Per-file verdicts are
/// served from [`DISPATCH_PROBE_CACHE`] within [`DISPATCH_PROBE_TTL`]'s per-direction
/// window; the workflow LIST is always re-read, so a newly added workflow shows up
/// immediately.
#[tauri::command]
pub async fn gh_workflow_dispatchable(
    repo_path: String,
    git_ref: String,
) -> AppResult<HashMap<String, bool>> {
    validate_ref(&git_ref)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // Listed server-side: a frontend-supplied path would aim the contents fetch
    // at a file of the caller's choosing.
    let workflows = fetch_workflows(&repo_path, &slug).await?;
    let ref_field = format!("ref={git_ref}");
    let (mut map, probes) =
        plan_probes(&workflows, &repo_path, &slug, &git_ref, DISPATCH_PROBE_TTL);

    let results = crate::forge::futures_join_all(probes.iter().map(|w| {
        let endpoint = format!("repos/{slug}/contents/{}", w.path);
        let repo_path = repo_path.as_str();
        let ref_field = ref_field.as_str();
        let path = w.path.as_str();
        async move {
            let _permit = DISPATCH_PROBE_GATE.acquire().await.ok();
            // `--method GET` is mandatory: `gh api` with `-f` fields present
            // defaults to POST, and only under GET do they become query
            // params. `-f` never `-F` — `-F`'s leading-`@` magic reads host files.
            let res = run_gh(
                Some(repo_path),
                &[
                    "api",
                    "--method",
                    "GET",
                    &endpoint,
                    "-H",
                    "Accept: application/vnd.github.raw",
                    "-f",
                    ref_field,
                ],
                GH_NETWORK_TIMEOUT,
            )
            .await;
            (w.id, path, res)
        }
    }))
    .await;
    for (id, path, res) in results {
        // A failed fetch leaves the key ABSENT — "unknown" must not read as
        // "not dispatchable", which would hide a runnable workflow — and stays out
        // of the cache, so the next call re-probes instead of pinning the failure.
        if let Ok(out) = res {
            let verdict = yaml_declares_workflow_dispatch(&out.stdout_lossy());
            probe_cache_put(&repo_path, &slug, path, &git_ref, verdict);
            map.insert(id.to_string(), verdict);
        }
    }
    Ok(map)
}

/// GitHub's 422 for a workflow without the trigger reaches the user as gh's raw
/// HTTP line, API URL included. Lead with a plain sentence — the toast shows only
/// the first line — and keep the raw text below it for the details view.
fn humanize_dispatch_error(raw: &str, git_ref: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("workflow does not have") && lower.contains("workflow_dispatch") {
        return format!(
            "This workflow can't be run manually: it has no workflow_dispatch trigger on \"{git_ref}\".\n\n{raw}"
        );
    }
    raw.to_string()
}

/// Manually dispatches a workflow (`workflow_dispatch`) on a ref, with inputs.
/// `workflow` is the numeric id or the file name (e.g. "ci.yml").
pub async fn gh_workflow_run(
    repo_path: String,
    workflow: String,
    git_ref: String,
    inputs: HashMap<String, String>,
) -> AppResult<()> {
    if workflow.is_empty() || workflow.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid workflow: {workflow}"
        )));
    }
    validate_ref(&git_ref)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args: Vec<String> = vec![
        "workflow".into(),
        "run".into(),
        "-R".into(),
        slug,
        workflow,
        "--ref".into(),
        git_ref.clone(),
    ];
    for (k, v) in &inputs {
        if k.is_empty() || k.starts_with('-') {
            return Err(AppError::InvalidArgument(format!("invalid input key: {k}")));
        }
        args.push("-f".into());
        args.push(format!("{k}={v}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT)
        .await
        .map_err(|e| match e {
            AppError::Gh(msg) => AppError::Gh(humanize_dispatch_error(&msg, &git_ref)),
            other => other,
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The TS mirror at the top of `src/lib/github/actions.ts` is hand-maintained, so
    /// nothing but this test stops a casing or id-type drift from reaching the UI as
    /// `undefined`. Ids serialize as raw JSON NUMBERS (`id: number` in TS); only the
    /// `forge_ci_*` command PARAMS take the string form, for JS precision headroom.
    #[test]
    fn wire_shape_is_pinned() {
        let run = WorkflowRun {
            id: 17_234_567_890,
            number: 42,
            display_title: "fix: guard the cache".to_string(),
            status: "completed".to_string(),
            conclusion: "success".to_string(),
            workflow_name: "rust-tests".to_string(),
            workflow_database_id: 334_643_035,
            head_branch: "refactor/hygiene".to_string(),
            event: "pull_request".to_string(),
            created_at: "2026-08-13T09:00:00Z".to_string(),
            started_at: "2026-08-13T09:00:30Z".to_string(),
            updated_at: "2026-08-13T09:04:10Z".to_string(),
            url: "https://github.com/o/r/actions/runs/17234567890".to_string(),
            head_sha: "c5779b7".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            json!({
                "id": 17_234_567_890u64,
                "number": 42,
                "displayTitle": "fix: guard the cache",
                "status": "completed",
                "conclusion": "success",
                "workflowName": "rust-tests",
                "workflowDatabaseId": 334_643_035u64,
                "headBranch": "refactor/hygiene",
                "event": "pull_request",
                "createdAt": "2026-08-13T09:00:00Z",
                "startedAt": "2026-08-13T09:00:30Z",
                "updatedAt": "2026-08-13T09:04:10Z",
                "url": "https://github.com/o/r/actions/runs/17234567890",
                "headSha": "c5779b7"
            })
        );

        // A GitHub/GitLab job: numeric id, `logRef` omitted entirely (the TS mirror
        // declares it optional, and Bitbucket is the only provider that sets it).
        let job = RunJob {
            id: 49_876_543_210,
            name: "test (windows-latest)".to_string(),
            status: "completed".to_string(),
            conclusion: "failure".to_string(),
            started_at: "2026-08-13T09:00:40Z".to_string(),
            completed_at: "2026-08-13T09:04:00Z".to_string(),
            url: "https://github.com/o/r/actions/runs/17234567890/job/49876543210".to_string(),
            steps: vec![RunStep {
                name: "Run tests".to_string(),
                status: "completed".to_string(),
                conclusion: "failure".to_string(),
                number: 3,
                started_at: "2026-08-13T09:00:45Z".to_string(),
                completed_at: "2026-08-13T09:03:55Z".to_string(),
            }],
            log_ref: None,
        };
        let job_value = serde_json::to_value(&job).unwrap();
        assert_eq!(
            job_value,
            json!({
                "id": 49_876_543_210u64,
                "name": "test (windows-latest)",
                "status": "completed",
                "conclusion": "failure",
                "startedAt": "2026-08-13T09:00:40Z",
                "completedAt": "2026-08-13T09:04:00Z",
                "url": "https://github.com/o/r/actions/runs/17234567890/job/49876543210",
                "steps": [{
                    "name": "Run tests",
                    "status": "completed",
                    "conclusion": "failure",
                    "number": 3,
                    "startedAt": "2026-08-13T09:00:45Z",
                    "completedAt": "2026-08-13T09:03:55Z"
                }]
            })
        );
        assert!(
            job_value.get("logRef").is_none(),
            "absent logRef must not ship as null"
        );

        let detail = RunDetail {
            id: 17_234_567_890,
            number: 42,
            display_title: "fix: guard the cache".to_string(),
            status: "completed".to_string(),
            conclusion: "success".to_string(),
            workflow_name: "rust-tests".to_string(),
            head_branch: "refactor/hygiene".to_string(),
            event: "pull_request".to_string(),
            created_at: "2026-08-13T09:00:00Z".to_string(),
            url: "https://github.com/o/r/actions/runs/17234567890".to_string(),
            head_sha: "c5779b7".to_string(),
            jobs: vec![],
        };
        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            json!({
                "id": 17_234_567_890u64,
                "number": 42,
                "displayTitle": "fix: guard the cache",
                "status": "completed",
                "conclusion": "success",
                "workflowName": "rust-tests",
                "headBranch": "refactor/hygiene",
                "event": "pull_request",
                "createdAt": "2026-08-13T09:00:00Z",
                "url": "https://github.com/o/r/actions/runs/17234567890",
                "headSha": "c5779b7",
                "jobs": []
            })
        );

        let workflow = Workflow {
            id: 98_765_432,
            name: "rust-tests".to_string(),
            path: ".github/workflows/rust-tests.yml".to_string(),
            state: "active".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&workflow).unwrap(),
            json!({
                "id": 98_765_432,
                "name": "rust-tests",
                "path": ".github/workflows/rust-tests.yml",
                "state": "active"
            })
        );

        // Pins explicitly the property the `assert_eq!`s above encode only
        // implicitly: every id is a JSON number, never the string form the
        // command params use.
        for (label, value) in [
            ("WorkflowRun", serde_json::to_value(&run).unwrap()),
            ("RunJob", serde_json::to_value(&job).unwrap()),
            ("RunDetail", serde_json::to_value(&detail).unwrap()),
            ("Workflow", serde_json::to_value(&workflow).unwrap()),
        ] {
            assert!(
                value["id"].is_u64(),
                "{label}.id must serialize as a JSON number, got {}",
                value["id"]
            );
        }
    }

    /// The page envelope crosses the same hand-maintained TS boundary as
    /// `WorkflowRun`, and `totalCount` must reach the UI as `null` — not `0` — when a
    /// provider reports no total, since the panel prints the count only when it has one.
    #[test]
    fn ci_run_page_wire_shape_is_pinned() {
        let page = CiRunPage {
            runs: Vec::new(),
            total_count: Some(4085),
            has_more: true,
        };
        assert_eq!(
            serde_json::to_value(&page).unwrap(),
            json!({ "runs": [], "totalCount": 4085, "hasMore": true })
        );

        let unknown = CiRunPage {
            runs: Vec::new(),
            total_count: None,
            has_more: false,
        };
        assert_eq!(
            serde_json::to_value(&unknown).unwrap(),
            json!({ "runs": [], "totalCount": null, "hasMore": false })
        );
    }

    /// Field values captured verbatim from `gh api --method GET
    /// repos/theBGuy/GitDesktop/actions/runs`, trimmed to the keys the mapping reads
    /// plus the `url`/`name` pair REST spells differently from the neutral row. The id
    /// is past 2^32, so a `u32` field would truncate rather than merely warn.
    #[test]
    fn rest_runs_map_onto_the_neutral_row() {
        let body = r#"{
            "total_count": 4085,
            "workflow_runs": [
                {
                    "id": 33705563157,
                    "name": "changelog",
                    "head_branch": "fix/resolve-walk-scope-required-checks",
                    "head_sha": "195b9e99c92fe7814cd9b063cf0ddeda1f3d4d19",
                    "path": ".github/workflows/changelog.yml",
                    "display_title": "fix(pulls,conflicts): scope AI resolve walks",
                    "run_number": 1346,
                    "event": "pull_request",
                    "status": "completed",
                    "conclusion": "success",
                    "workflow_id": 307406754,
                    "url": "https://api.github.com/repos/theBGuy/GitDesktop/actions/runs/33705563157",
                    "html_url": "https://github.com/theBGuy/GitDesktop/actions/runs/33705563157",
                    "created_at": "2026-09-03T01:54:57Z",
                    "updated_at": "2026-09-03T01:55:13Z",
                    "run_started_at": "2026-09-03T01:54:57Z"
                },
                {
                    "id": 33705353404,
                    "name": "quality",
                    "head_branch": null,
                    "head_sha": "195b9e99c92fe7814cd9b063cf0ddeda1f3d4d19",
                    "display_title": "queued run",
                    "run_number": 396,
                    "event": "workflow_dispatch",
                    "status": "queued",
                    "conclusion": null,
                    "workflow_id": 334643035,
                    "html_url": "https://github.com/theBGuy/GitDesktop/actions/runs/33705353404",
                    "created_at": "2026-09-03T01:51:49Z",
                    "updated_at": "2026-09-03T01:52:24Z",
                    "run_started_at": null
                }
            ]
        }"#;
        let parsed: RestRunPage = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.total_count, 4085);
        // Both ids are absent from the index here, exercising the `name` fallback;
        // the divergent case has its own test below.
        let names = HashMap::new();
        let runs: Vec<WorkflowRun> = parsed
            .workflow_runs
            .into_iter()
            .map(|r| from_rest_run(r, &names))
            .collect();

        let first = &runs[0];
        assert_eq!(first.id, 33_705_563_157);
        assert_eq!(first.number, 1346);
        assert_eq!(
            first.display_title,
            "fix(pulls,conflicts): scope AI resolve walks"
        );
        assert_eq!(first.status, "completed");
        assert_eq!(first.conclusion, "success");
        assert_eq!(first.workflow_name, "changelog");
        assert_eq!(first.workflow_database_id, 307_406_754);
        assert_eq!(first.head_branch, "fix/resolve-walk-scope-required-checks");
        assert_eq!(first.event, "pull_request");
        assert_eq!(first.created_at, "2026-09-03T01:54:57Z");
        assert_eq!(first.started_at, "2026-09-03T01:54:57Z");
        assert_eq!(first.updated_at, "2026-09-03T01:55:13Z");
        assert_eq!(
            first.url,
            "https://github.com/theBGuy/GitDesktop/actions/runs/33705563157",
            "url must be the BROWSER url, never REST's api `url`"
        );
        assert_eq!(
            first.head_sha,
            "195b9e99c92fe7814cd9b063cf0ddeda1f3d4d19"
        );

        // A still-running run: the three nullable fields fold to "" rather than
        // failing the parse or reaching the UI as null.
        let second = &runs[1];
        assert_eq!(second.conclusion, "");
        assert_eq!(second.started_at, "");
        assert_eq!(second.head_branch, "");
        assert_eq!(second.status, "queued");
    }

    /// REST's per-run `name` is the RUN's name, so a dynamic or `run-name:` workflow
    /// makes it diverge from the workflow's. Values captured from
    /// theBGuy/GitDesktop: `gh run list` answers `workflowName: "Dependabot Updates"`
    /// for run 33710268988, where REST's `name` is the update's own title.
    #[test]
    fn the_workflow_index_wins_over_a_runs_own_name() {
        let body = r#"{
            "total_count": 4085,
            "workflow_runs": [
                {
                    "id": 33710268988,
                    "name": "npm_and_yarn in /. for fast-uri - Update #1553823451",
                    "display_title": "npm_and_yarn in /. for fast-uri - Update #1553823451",
                    "run_number": 812,
                    "status": "completed",
                    "conclusion": "success",
                    "workflow_id": 298718218,
                    "head_branch": "master",
                    "event": "dynamic",
                    "html_url": "https://github.com/theBGuy/GitDesktop/actions/runs/33710268988",
                    "created_at": "2026-09-03T04:11:02Z",
                    "updated_at": "2026-09-03T04:11:44Z",
                    "run_started_at": "2026-09-03T04:11:02Z"
                },
                {
                    "id": 33717811001,
                    "name": "changelog",
                    "display_title": "chore: bump",
                    "run_number": 1350,
                    "status": "completed",
                    "conclusion": "success",
                    "workflow_id": 307406754,
                    "head_branch": "master",
                    "event": "push",
                    "html_url": "https://github.com/theBGuy/GitDesktop/actions/runs/33717811001",
                    "created_at": "2026-09-03T05:00:00Z",
                    "updated_at": "2026-09-03T05:00:20Z",
                    "run_started_at": "2026-09-03T05:00:00Z"
                },
                {
                    "id": 33700936127,
                    "name": "Running Copilot Code Review",
                    "display_title": "Running Copilot Code Review",
                    "run_number": 91,
                    "status": "completed",
                    "conclusion": "success",
                    "workflow_id": 999999999,
                    "head_branch": "master",
                    "event": "dynamic",
                    "html_url": "https://github.com/theBGuy/GitDesktop/actions/runs/33700936127",
                    "created_at": "2026-09-03T00:10:00Z",
                    "updated_at": "2026-09-03T00:10:30Z",
                    "run_started_at": "2026-09-03T00:10:00Z"
                }
            ]
        }"#;
        let names: HashMap<u64, String> = [
            (298_718_218u64, "Dependabot Updates".to_string()),
            (307_406_754u64, "changelog".to_string()),
        ]
        .into_iter()
        .collect();
        let parsed: RestRunPage = serde_json::from_str(body).unwrap();
        let runs: Vec<WorkflowRun> = parsed
            .workflow_runs
            .into_iter()
            .map(|r| from_rest_run(r, &names))
            .collect();

        assert_eq!(
            runs[0].workflow_name, "Dependabot Updates",
            "a dynamic workflow's runs must carry the WORKFLOW name, not the run's"
        );
        assert_eq!(
            runs[0].display_title, "npm_and_yarn in /. for fast-uri - Update #1553823451",
            "the run's own name still belongs in the title"
        );
        // A workflow whose runs don't override the name: index and fallback agree.
        assert_eq!(runs[1].workflow_name, "changelog");
        // Absent from the index (deleted workflow, or a failed advisory fetch) — the
        // run's own name stands in rather than the row going blank.
        assert_eq!(runs[2].workflow_name, "Running Copilot Code Review");

        // An empty index is exactly the failed-fetch case: every row degrades, none is
        // dropped and none goes empty.
        let parsed: RestRunPage = serde_json::from_str(body).unwrap();
        let degraded: Vec<WorkflowRun> = parsed
            .workflow_runs
            .into_iter()
            .map(|r| from_rest_run(r, &HashMap::new()))
            .collect();
        assert_eq!(degraded.len(), 3);
        assert!(degraded.iter().all(|r| !r.workflow_name.is_empty()));
        assert_eq!(
            degraded[0].workflow_name,
            "npm_and_yarn in /. for fast-uri - Update #1553823451"
        );
    }

    /// The name index is process-wide and shared by every test in this binary, so each
    /// test keys its entries under its own repo path and slug.
    #[test]
    fn workflow_names_are_served_within_the_ttl_and_expire_after_it() {
        let (repo, slug) = ("C:/repos/wf-ttl", "o/wf-ttl");
        let names: HashMap<u64, String> = [(298_718_218u64, "Dependabot Updates".to_string())]
            .into_iter()
            .collect();

        // An unfetched key — the shape an ERRED fetch also leaves behind, since only a
        // successful list is ever stored — reads as absent, so the next call re-probes.
        assert_eq!(
            workflow_names_get(repo, slug, WORKFLOW_NAME_TTL),
            None,
            "an erred or never-run fetch must not pin an empty index"
        );

        workflow_names_put(repo, slug, names.clone());
        assert_eq!(
            workflow_names_get(repo, slug, WORKFLOW_NAME_TTL),
            Some(names.clone())
        );
        // Zero window: every entry reads as expired without sleeping.
        assert_eq!(workflow_names_get(repo, slug, Duration::ZERO), None);

        // An EMPTY index is a real answer (a repo with no workflows) and round-trips
        // as a hit, not as an absence.
        let (empty_repo, empty_slug) = ("C:/repos/wf-empty", "o/wf-empty");
        workflow_names_put(empty_repo, empty_slug, HashMap::new());
        assert_eq!(
            workflow_names_get(empty_repo, empty_slug, WORKFLOW_NAME_TTL),
            Some(HashMap::new())
        );

        // The shipped window matches the frontend's `useWorkflows` staleTime.
        assert_eq!(WORKFLOW_NAME_TTL, Duration::from_secs(300));
    }

    #[test]
    fn every_workflow_name_key_axis_misses_independently() {
        let (repo, slug) = ("C:/repos/wf-keys", "o/wf-keys");
        let names: HashMap<u64, String> = [(307_406_754u64, "changelog".to_string())]
            .into_iter()
            .collect();
        workflow_names_put(repo, slug, names);

        assert_eq!(
            workflow_names_get(repo, "other/wf-keys", WORKFLOW_NAME_TTL),
            None,
            "a different slug must re-fetch"
        );
        // The host-collision guard: `gh_origin_slug` strips the authority, so a GHE
        // remote and a github.com remote can present the SAME slug. Two checkouts on
        // that slug must not share an index.
        assert_eq!(
            workflow_names_get("C:/repos/wf-keys-enterprise", slug, WORKFLOW_NAME_TTL),
            None,
            "the same slug in a different checkout must re-fetch, not inherit"
        );
    }

    #[test]
    fn a_short_page_or_an_exhausted_count_ends_paging() {
        // Full page with more behind it.
        assert!(gh_has_more(40, 40, 1, 4085));
        // Full page that exactly consumes the total.
        assert!(!gh_has_more(40, 40, 2, 80));
        // Short page — no next page however large the total claims to be.
        assert!(!gh_has_more(17, 40, 1, 4085));
        // Full page past the total (a provider-side window; count math alone would
        // keep promising pages).
        assert!(!gh_has_more(40, 40, 3, 100));
        // Empty page.
        assert!(!gh_has_more(0, 40, 5, 4085));
    }

    /// A body missing the envelope entirely (an error object, a shape change) parses to
    /// an empty page instead of erroring — the tolerant-JSON posture forge reads take.
    #[test]
    fn a_foreign_envelope_reads_as_an_empty_page() {
        let parsed: RestRunPage = serde_json::from_str(r#"{"message":"Not Found"}"#).unwrap();
        assert_eq!(parsed.total_count, 0);
        assert!(parsed.workflow_runs.is_empty());
        assert!(!gh_has_more(0, 40, 1, 0));
    }

    #[test]
    fn detects_every_workflow_dispatch_spelling() {
        assert!(yaml_declares_workflow_dispatch(
            "name: ci\non: workflow_dispatch\njobs: {}\n"
        ));
        assert!(yaml_declares_workflow_dispatch(
            "on: [push, workflow_dispatch]\n"
        ));
        assert!(yaml_declares_workflow_dispatch(
            "on:\n  workflow_dispatch:\n    inputs:\n      level:\n        type: choice\n"
        ));
        assert!(yaml_declares_workflow_dispatch(
            "on:\n  \"workflow_dispatch\":\n"
        ));
        assert!(!yaml_declares_workflow_dispatch(
            "name: ci\non:\n  push:\n    branches: [master]\n  pull_request:\n"
        ));
    }

    #[test]
    fn skips_paths_gh_would_misread_as_endpoint_syntax() {
        assert!(is_probeable_path(".github/workflows/ci.yml"));
        assert!(!is_probeable_path("dynamic/{owner}/thing"));
        assert!(!is_probeable_path(".github/workflows/a}b.yml"));
        assert!(!is_probeable_path(".github/workflows/a?b.yml"));
        assert!(!is_probeable_path(".github/workflows/a#b.yml"));
        assert!(!is_probeable_path("-oops.yml"));
        assert!(!is_probeable_path(""));
    }

    #[test]
    fn pseudo_workflows_are_a_definite_no() {
        // GitHub's dynamic entries have no file to fetch; a 404 would read as
        // unknown and keep them offered, so they are decided from the path.
        assert_eq!(
            classify_workflow_path("dynamic/dependabot/dependabot-updates"),
            PathVerdict::NotDispatchable
        );
        assert_eq!(
            classify_workflow_path("dynamic/agents/copilot-pull-request-reviewer"),
            PathVerdict::NotDispatchable
        );
        assert_eq!(
            classify_workflow_path(".github/workflows/ci.yml"),
            PathVerdict::Fetch
        );
        assert_eq!(
            classify_workflow_path(".github/workflows/a?b.yml"),
            PathVerdict::Unknown
        );
    }

    fn workflow(id: u64, path: &str, state: &str) -> Workflow {
        Workflow {
            id,
            name: format!("wf-{id}"),
            path: path.to_string(),
            state: state.to_string(),
        }
    }

    /// Both windows zero — every entry reads as expired whatever its verdict, which is
    /// how these tests stand in for elapsed-past-TTL without sleeping.
    const EXPIRED: ProbeTtl = ProbeTtl {
        declared: Duration::ZERO,
        absent: Duration::ZERO,
    };

    /// The cache is process-wide and shared by every test in this binary, so each test
    /// keys its entries under its own repo path and slug.
    #[test]
    fn probe_verdicts_are_served_within_the_ttl_and_expire_after_it() {
        let ttl = DISPATCH_PROBE_TTL;
        let (repo, slug, path, git_ref) = (
            "C:/repos/ttl",
            "o/ttl",
            ".github/workflows/ci.yml",
            "master",
        );

        // An unprobed file — the shape an erred fetch also leaves behind, since only a
        // parsed verdict is ever stored — reads as absent, i.e. unknown.
        assert_eq!(probe_cache_get(repo, slug, path, git_ref, ttl), None);

        probe_cache_put(repo, slug, path, git_ref, true);
        assert_eq!(probe_cache_get(repo, slug, path, git_ref, ttl), Some(true));
        assert_eq!(probe_cache_get(repo, slug, path, git_ref, EXPIRED), None);

        // `false` round-trips as a hit, not as an absence.
        probe_cache_put(repo, slug, path, git_ref, false);
        assert_eq!(probe_cache_get(repo, slug, path, git_ref, ttl), Some(false));
        assert_eq!(probe_cache_get(repo, slug, path, git_ref, EXPIRED), None);
    }

    #[test]
    fn a_false_verdict_expires_before_a_true_one_of_the_same_age() {
        let (repo, slug) = ("C:/repos/directions", "o/directions");
        let (yes, no) = (
            ".github/workflows/enabled.yml",
            ".github/workflows/disabled.yml",
        );
        probe_cache_put(repo, slug, yes, "master", true);
        probe_cache_put(repo, slug, no, "master", false);

        // Both entries are the same age; only the verdict decides which window applies.
        // This window is past the `false` one and still inside the `true` one.
        let past_the_short_window = ProbeTtl {
            declared: Duration::from_secs(600),
            absent: Duration::ZERO,
        };
        assert_eq!(
            probe_cache_get(repo, slug, yes, "master", past_the_short_window),
            Some(true),
            "a true verdict still holds inside the long window"
        );
        assert_eq!(
            probe_cache_get(repo, slug, no, "master", past_the_short_window),
            None,
            "a false verdict must expire with the short window, so a workflow enabled \
             since the probe stops being hidden"
        );

        // Inside both windows nothing has expired yet.
        assert_eq!(
            probe_cache_get(repo, slug, no, "master", DISPATCH_PROBE_TTL),
            Some(false)
        );

        // The shipped windows really are asymmetric, and `absent` is pinned to one
        // frontend staleTime (`5 * 60_000` in `useWorkflowDispatchable`) — the composed
        // worst-case hide is that window plus one more staleTime.
        assert!(DISPATCH_PROBE_TTL.absent < DISPATCH_PROBE_TTL.declared);
        assert_eq!(DISPATCH_PROBE_TTL.absent, Duration::from_secs(300));
    }

    #[test]
    fn every_key_axis_misses_independently() {
        let ttl = DISPATCH_PROBE_TTL;
        let (repo, slug, ci) = ("C:/repos/keys", "o/keys", ".github/workflows/ci.yml");
        probe_cache_put(repo, slug, ci, "master", true);

        assert_eq!(
            probe_cache_get(repo, slug, ci, "dev", ttl),
            None,
            "a different ref must re-probe"
        );
        assert_eq!(
            probe_cache_get(repo, slug, ".github/workflows/release.yml", "master", ttl),
            None,
            "a different workflow file must re-probe"
        );
        assert_eq!(
            probe_cache_get(repo, "other/keys", ci, "master", ttl),
            None,
            "a different slug must re-probe"
        );
        // The host-collision guard: `gh_origin_slug` strips the authority, so a GHE
        // remote and a github.com remote can present the SAME slug. Two checkouts on
        // that slug must not share a verdict.
        assert_eq!(
            probe_cache_get("C:/repos/keys-enterprise", slug, ci, "master", ttl),
            None,
            "the same slug in a different checkout must re-probe, not inherit"
        );
    }

    #[test]
    fn a_cached_verdict_never_reaches_the_fan_out() {
        let ttl = DISPATCH_PROBE_TTL;
        let (repo, slug) = ("C:/repos/fanout", "o/fanout");
        let workflows = vec![
            workflow(1, ".github/workflows/ci.yml", "active"),
            workflow(2, ".github/workflows/release.yml", "active"),
            workflow(3, "dynamic/dependabot/dependabot-updates", "active"),
            workflow(4, ".github/workflows/retired.yml", "disabled_manually"),
        ];

        let (map, probes) = plan_probes(&workflows, repo, slug, "master", ttl);
        assert_eq!(
            probes.iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![1, 2],
            "cold: both real files fetch"
        );
        assert_eq!(map.get("3"), Some(&false));
        assert_eq!(map.len(), 1, "only the path-decided workflow is in the map");

        probe_cache_put(repo, slug, ".github/workflows/ci.yml", "master", true);
        let (map, probes) = plan_probes(&workflows, repo, slug, "master", ttl);
        assert_eq!(
            probes.iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![2],
            "warm: the cached file must not enter the fan-out at all"
        );
        assert_eq!(
            map.get("1"),
            Some(&true),
            "its verdict comes from the cache"
        );

        let (_, probes) = plan_probes(&workflows, repo, slug, "dev", ttl);
        assert_eq!(
            probes.iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![1, 2],
            "another ref is a different key, so it fans out again"
        );

        // Same slug, different checkout — the host-collision guard, exercised through
        // the fan-out path rather than the cache functions alone.
        let (_, probes) = plan_probes(
            &workflows,
            "C:/repos/fanout-enterprise",
            slug,
            "master",
            ttl,
        );
        assert_eq!(
            probes.iter().map(|w| w.id).collect::<Vec<_>>(),
            vec![1, 2],
            "a different checkout on the same slug must not inherit cached verdicts"
        );
    }

    #[test]
    fn humanizes_only_the_missing_trigger_error() {
        let raw = "HTTP 422: Workflow does not have 'workflow_dispatch' trigger (https://api.github.com/repos/o/r/actions/workflows/98765432/dispatches)";
        let out = humanize_dispatch_error(raw, "master");
        assert_eq!(
            out.lines().next().unwrap(),
            "This workflow can't be run manually: it has no workflow_dispatch trigger on \"master\"."
        );
        assert!(out.ends_with(raw), "raw text must survive verbatim: {out}");

        // Case-insensitive: gh/GitHub casing is not a contract.
        assert!(humanize_dispatch_error(
            "http 422: workflow does not have 'WORKFLOW_DISPATCH' trigger",
            "main"
        )
        .starts_with("This workflow can't be run manually"));

        let unrelated = "HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/workflows/1/dispatches)";
        assert_eq!(humanize_dispatch_error(unrelated, "master"), unrelated);
    }
}
