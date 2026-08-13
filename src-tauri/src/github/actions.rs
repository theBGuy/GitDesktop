//! GitHub Actions support, driven through the `gh` CLI (`gh run …` /
//! `gh workflow …`). Read views list and inspect workflow runs; mutations
//! re-run, cancel, and manually dispatch workflows. All repo-scoped via the
//! working directory, like the PR commands.

use std::collections::HashMap;

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

const RUN_LIST_FIELDS: &str = "databaseId,number,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,startedAt,updatedAt,url,headSha";
const RUN_VIEW_FIELDS: &str = "databaseId,number,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url,headSha,jobs";
/// Failed-step logs can run to many MB; keep the tail (failures land at the end).
const RUN_LOG_CAP: usize = 200_000;

/// Recent workflow runs, newest first; optionally scoped to one branch.
pub async fn gh_run_list(
    repo_path: String,
    limit: u32,
    branch: Option<String>,
) -> AppResult<Vec<WorkflowRun>> {
    let limit = limit.clamp(1, 100).to_string();
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args: Vec<&str> = vec![
        "run",
        "list",
        "-R",
        slug.as_str(),
        "-L",
        limit.as_str(),
        "--json",
        RUN_LIST_FIELDS,
    ];
    if let Some(b) = branch.as_deref().filter(|s| !s.is_empty()) {
        validate_ref(b)?;
        args.push("--branch");
        args.push(b);
    }
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh run list: {e}")))
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

/// The repo's workflows, for the manual-dispatch picker.
#[tauri::command]
pub async fn gh_workflow_list(repo_path: String) -> AppResult<Vec<Workflow>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "workflow",
            "list",
            "-R",
            &slug,
            "--all",
            "--json",
            "id,name,path,state",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh workflow list: {e}")))
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
        git_ref,
    ];
    for (k, v) in &inputs {
        if k.is_empty() || k.starts_with('-') {
            return Err(AppError::InvalidArgument(format!("invalid input key: {k}")));
        }
        args.push("-f".into());
        args.push(format!("{k}={v}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT).await?;
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
}
