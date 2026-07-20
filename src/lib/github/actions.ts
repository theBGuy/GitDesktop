import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri/invoke";

// ── Types (mirror the Rust structs in github/actions.rs) ─────────────────────

export interface WorkflowRun {
  id: number;
  number: number;
  displayTitle: string;
  /** queued | in_progress | completed | waiting | requested | pending */
  status: string;
  /** success | failure | cancelled | skipped | … ; "" while still running */
  conclusion: string;
  workflowName: string;
  headBranch: string;
  event: string;
  createdAt: string;
  /** When the run started executing (after queue); "" if never started. */
  startedAt: string;
  updatedAt: string;
  url: string;
  headSha: string;
}

export interface RunStep {
  name: string;
  status: string;
  conclusion: string;
  number: number;
  startedAt: string;
  completedAt: string;
}

export interface RunJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  url: string;
  steps: RunStep[];
  /** Present on Bitbucket jobs (a pipeline step) — the log reference its logs are
   *  fetched by (`forge_bb_step_logs`). Absent for GitHub/GitLab, whose job logs
   *  come from `forge_ci_job_logs`. */
  logRef?: string;
}

export interface RunDetail {
  id: number;
  number: number;
  displayTitle: string;
  status: string;
  conclusion: string;
  workflowName: string;
  headBranch: string;
  event: string;
  createdAt: string;
  url: string;
  headSha: string;
  jobs: RunJob[];
}

export interface Workflow {
  id: number;
  name: string;
  path: string;
  /** active | disabled_manually | disabled_inactivity */
  state: string;
}

// ── Status helpers ───────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

/** A run/job still executing (so the UI keeps polling and offers Cancel). */
export const isRunActive = (status: string) => ACTIVE_STATUSES.has(status);

// ── API wrappers ─────────────────────────────────────────────────────────────
//
// Reads AND writes go through the provider-neutral `forge_ci_*` commands (GitHub
// via `gh run …`, GitLab via `glab` pipelines → the same `WorkflowRun`/`RunDetail`
// shapes; re-run / cancel / dispatch dispatch per provider too). Only the
// workflow list stays `gh_*` — GitLab has no workflow analogue (one `.gitlab-ci.yml`
// per project), so its dispatch is ref+variables with no workflow picker.

export const forgeCiRunList = (
  repoPath: string,
  limit: number,
  branch?: string,
) =>
  invoke<WorkflowRun[]>("forge_ci_run_list", {
    repoPath,
    limit,
    branch: branch?.trim() || null,
  });

export const forgeCiRunView = (repoPath: string, runId: number | string) =>
  invoke<RunDetail>("forge_ci_run_view", { repoPath, runId: String(runId) });

export const forgeCiRunRerun = (
  repoPath: string,
  runId: number,
  failed: boolean,
) => invoke<void>("forge_ci_run_rerun", { repoPath, runId, failed });

export const forgeCiRunCancel = (repoPath: string, runId: number) =>
  invoke<void>("forge_ci_run_cancel", { repoPath, runId });

export const forgeCiRunFailedLogs = (
  repoPath: string,
  runId: number | string,
) =>
  invoke<string>("forge_ci_run_failed_logs", {
    repoPath,
    runId: String(runId),
  });

/** One job's failed-step logs (fallback: full job log), for AI debugging. */
export const forgeCiJobLogs = (repoPath: string, jobId: number | string) =>
  invoke<string>("forge_ci_job_logs", { repoPath, jobId: String(jobId) });

/** A Bitbucket pipeline step's logs (cleaned/capped). Bitbucket jobs carry a
 *  `logRef` instead of a numeric job id, and `forge_ci_job_logs` errors for
 *  them — so a job with a `logRef` fetches here instead. */
export const forgeBbStepLogs = (repoPath: string, logRef: string) =>
  invoke<string>("forge_bb_step_logs", { repoPath, logRef });

/** A job's logs, dispatched by provider: Bitbucket steps (carrying a `logRef`)
 *  go through `forge_bb_step_logs`; GitHub/GitLab jobs through the id-keyed
 *  `forge_ci_job_logs`. */
export const forgeJobLogs = (
  repoPath: string,
  job: { id: number | string; logRef?: string },
) =>
  job.logRef
    ? forgeBbStepLogs(repoPath, job.logRef)
    : forgeCiJobLogs(repoPath, job.id);

/** Play (start) a manual GitLab CI job awaiting a manual trigger — GitLab-only,
 *  gated on `implemented.ciJobPlay`; errors on other providers. */
export const forgeGlCiPlayJob = (repoPath: string, jobId: number) =>
  invoke<void>("forge_gl_ci_play_job", { repoPath, jobId });

export const ghWorkflowList = (repoPath: string) =>
  invoke<Workflow[]>("gh_workflow_list", { repoPath });

/** Start a run: GitHub dispatches `workflow` on the ref with `inputs`; GitLab runs
 *  a new pipeline on the ref with `inputs` as variables (send `workflow` empty);
 *  Bitbucket triggers the branch pipeline, or a named CUSTOM pipeline when `workflow`
 *  is a custom-pipeline name. */
export const forgeCiDispatch = (
  repoPath: string,
  workflow: string,
  gitRef: string,
  inputs: Record<string, string>,
) => invoke<void>("forge_ci_dispatch", { repoPath, workflow, gitRef, inputs });

/** The CUSTOM pipeline names declared in the working-tree `bitbucket-pipelines.yml`
 *  (Bitbucket-only — the custom-dispatch picker's options). */
export const forgeBbCustomPipelines = (repoPath: string) =>
  invoke<string[]>("forge_bb_custom_pipelines", { repoPath });

// ── Queries ──────────────────────────────────────────────────────────────────

/** Polls every 5s while any listed run is active, otherwise stays idle. `active`
 *  (the Actions tab being visible) gates the fetch so a hidden tab stops polling;
 *  cached runs render instantly on return since React Query keeps the cache. */
export function useWorkflowRuns(
  repo: string,
  enabled: boolean,
  active: boolean,
  branch?: string,
) {
  return useQuery({
    queryKey: ["repo", repo, "actions", "runs", branch ?? ""] as const,
    queryFn: () => forgeCiRunList(repo, 40, branch),
    enabled: enabled && active,
    staleTime: 10_000,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((r) => isRunActive(r.status))
        ? 5000
        : false,
  });
}

export function useRunDetail(
  repo: string,
  runId: number | string | null,
  active: boolean,
) {
  return useQuery({
    // Normalize the id to a string in the key so number- and string-callers for
    // the same run share one cache entry.
    queryKey: ["repo", repo, "actions", "run", String(runId ?? 0)] as const,
    queryFn: () => forgeCiRunView(repo, runId ?? 0),
    enabled: runId !== null && active,
    refetchInterval: (query) =>
      query.state.data && isRunActive(query.state.data.status) ? 5000 : false,
  });
}

/**
 * The single most recent run on a branch, for the header CI badge. Polls fast
 * while it's active, slowly otherwise so a freshly-pushed run still shows up.
 */
export function useLatestRun(
  repo: string,
  enabled: boolean,
  branch: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "actions", "latest", branch ?? ""] as const,
    queryFn: async () =>
      (await forgeCiRunList(repo, 1, branch ?? undefined))[0] ?? null,
    enabled: enabled && Boolean(branch),
    staleTime: 15_000,
    refetchInterval: (query) =>
      query.state.data && isRunActive(query.state.data.status) ? 8000 : 30_000,
  });
}

export function useWorkflows(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "actions", "workflows"] as const,
    queryFn: () => ghWorkflowList(repo),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** The Bitbucket custom-pipeline names (from `bitbucket-pipelines.yml`) — the
 *  custom-dispatch picker's options. Reads the local working-tree file (no network);
 *  fetched only while the dispatch surface is enabled. */
export function useBbCustomPipelines(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "actions", "bb-custom-pipelines"] as const,
    queryFn: () => forgeBbCustomPipelines(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Failed-step logs, fetched only when the user expands them. */
export function useRunFailedLogs(
  repo: string,
  runId: number | string | null,
  enabled: boolean,
) {
  return useQuery({
    // Normalize the id to a string in the key (see useRunDetail).
    queryKey: [
      "repo",
      repo,
      "actions",
      "run",
      String(runId ?? 0),
      "logs",
    ] as const,
    queryFn: () => forgeCiRunFailedLogs(repo, runId ?? 0),
    enabled: enabled && runId !== null,
    staleTime: 30_000,
  });
}

/** One job's logs (failed steps, or the full log), fetched only when expanded.
 *  The job's `logRef` (Bitbucket steps) routes the fetch to `forge_bb_step_logs`;
 *  GitHub/GitLab jobs (no `logRef`) go through the id-keyed `forge_ci_job_logs`.
 *  The query key stays distinct per job either way. */
export function useJobLogs(
  repo: string,
  job: { id: number | string; logRef?: string } | null,
  enabled: boolean,
) {
  // Bitbucket steps are keyed by logRef (their numeric id can collide across a
  // run's jobs); GitHub/GitLab jobs by their unique id.
  const jobKey = job?.logRef ?? String(job?.id ?? 0);
  return useQuery({
    queryKey: ["repo", repo, "actions", "job", jobKey, "logs"] as const,
    queryFn: () => forgeJobLogs(repo, job ?? { id: 0 }),
    enabled: enabled && job !== null,
    staleTime: 30_000,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────

function useActionsMutation<TArgs>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // Scope the refresh to Actions — re-run/cancel/dispatch don't touch git state.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "actions"],
      }),
  });
}

export function useRerunRun(repo: string) {
  return useActionsMutation(repo, (args: { runId: number; failed: boolean }) =>
    forgeCiRunRerun(repo, args.runId, args.failed),
  );
}

export function useCancelRun(repo: string) {
  return useActionsMutation(repo, (runId: number) =>
    forgeCiRunCancel(repo, runId),
  );
}

/** Play a manual GitLab CI job (GitLab-only). Invalidating the Actions subtree
 *  refreshes the run detail + list; the job goes active and the existing 5s
 *  poll takes over. */
export function usePlayCiJob(repo: string) {
  return useActionsMutation(repo, (jobId: number) =>
    forgeGlCiPlayJob(repo, jobId),
  );
}

export function useRunWorkflow(repo: string) {
  return useActionsMutation(
    repo,
    (args: {
      workflow: string;
      gitRef: string;
      inputs: Record<string, string>;
    }) => forgeCiDispatch(repo, args.workflow, args.gitRef, args.inputs),
  );
}
