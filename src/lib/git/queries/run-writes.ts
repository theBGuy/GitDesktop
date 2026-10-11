/**
 * The pure pieces of the CI run-write bookkeeping: the key every run write is filed
 * under, the variables each one carries, and the per-run and per-job pending state
 * the CI surfaces (runs list, run view, PR checks) hold their controls by.
 *
 * Import-free at runtime on purpose (types only, erased):
 * `scripts/mutation-cache-snapshots.test.mjs` loads it straight from `src/` under
 * Node's type stripping, which resolves no bundler aliases. A runtime import added
 * here fails that test.
 */
import type { RemoteLens } from "../types";
import type { PendingMutationEntry } from "./pr-writes";

/** The CI run writes, one per mutation hook. */
export type RunWriteKind =
  | "rerun-run"
  | "cancel-run"
  | "rerun-job"
  | "play-job"
  | "dispatch"
  | "approve-run";

/** Filter prefix for EVERY run write ({@link runWriteKey}). */
export const RUN_WRITES_KEY = ["ci-run-write"] as const;

/** A run write's mutation key. Static per repo, so a run switch never detaches a
 *  pending write; the run or job it targets rides the variables. */
export const runWriteKey = (kind: RunWriteKind, repo: string) =>
  [...RUN_WRITES_KEY, kind, repo] as const;

/** Each kind's variables: one type for the mutation's generic AND the scan's cast,
 *  so a renamed field fails to compile instead of silently matching nothing. Run
 *  ids arrive as numbers from the run views and as strings from the PR checks. */
export type RerunRunVars = {
  runId: number | string;
  failed: boolean;
  lens?: RemoteLens;
};
export type CancelRunVars = number;
/** `runId` is the run the job belongs to, so a job re-run holds its run's re-runs
 *  on every surface that shows the run. */
export type RerunJobVars = {
  jobId: string;
  runId: number | string;
  lens?: RemoteLens;
};
export type PlayJobVars = string;
export type DispatchVars = {
  workflow: string;
  gitRef: string;
  inputs: Record<string, string>;
};
/** `lens` is optional because the Actions tab is origin-scoped by design; the PR
 *  checks strip renders under either lens and passes its own. */
export type ApproveRunVars = {
  runId: number;
  lens?: RemoteLens;
};

/** One in-flight write: `paused` only when EVERY write of it is parked offline —
 *  a running request means work is happening, so the in-flight copy is honest. */
export interface RunWriteState {
  paused: boolean;
}

/** A run's in-flight writes. `rerun` says which modes are in flight: `failed` for
 *  a failed-jobs re-run, `whole` for any other. `jobRerun` is a re-run of one of
 *  its jobs; `approve` releases a run GitHub holds for maintainer approval. */
export interface PendingRunState {
  runId: string;
  rerun?: RunWriteState & { failed: boolean; whole: boolean };
  cancel?: RunWriteState;
  jobRerun?: RunWriteState;
  approve?: RunWriteState;
}

/** A job's in-flight writes. */
export interface PendingJobState {
  jobId: string;
  rerun?: RunWriteState;
  play?: RunWriteState;
}

/** Every run write in flight against one repo. Arrays, not id-keyed records: the
 *  snapshot's structural sharing keeps only plain values, and an id named like an
 *  `Object.prototype` member would read as present on a record. */
export interface PendingRunWrites {
  runs: PendingRunState[];
  jobs: PendingJobState[];
}

export const NO_PENDING_RUN_WRITES: PendingRunWrites = { runs: [], jobs: [] };

/** A run or job id as the string every lookup compares, or null when it is
 *  neither a non-empty string nor a finite number. */
function idOf(value: unknown): string | null {
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : null;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Folds one more write into a state: parked only while every write is. */
const merged = (prev: RunWriteState | undefined, paused: boolean) => ({
  paused: (prev?.paused ?? true) && paused,
});

/** The run writes among `entries` filed against `repo` (keyed `[prefix, kind,
 *  repo]`), folded per run and per job in first-seen order. A dispatch targets no
 *  run, and an unknown kind or an unreadable id holds nothing. */
export function pendingRunWritesFor(
  entries: readonly PendingMutationEntry[],
  repo: string,
): PendingRunWrites {
  const runs: PendingRunState[] = [];
  const jobs: PendingJobState[] = [];
  const runOf = (runId: string) => {
    let s = runs.find((r) => r.runId === runId);
    if (!s) runs.push((s = { runId }));
    return s;
  };
  const jobOf = (jobId: string) => {
    let s = jobs.find((j) => j.jobId === jobId);
    if (!s) jobs.push((s = { jobId }));
    return s;
  };
  for (const e of entries) {
    const [prefix, kind, keyRepo] = e.key ?? [];
    if (prefix !== RUN_WRITES_KEY[0] || keyRepo !== repo) continue;
    const paused = e.paused ?? false;
    switch (kind) {
      case "rerun-run": {
        const vars = e.vars as RerunRunVars | undefined;
        const runId = idOf(vars?.runId);
        if (runId === null) break;
        const s = runOf(runId);
        s.rerun = {
          ...merged(s.rerun, paused),
          failed: (s.rerun?.failed ?? false) || vars?.failed === true,
          whole: (s.rerun?.whole ?? false) || vars?.failed !== true,
        };
        break;
      }
      case "cancel-run": {
        const runId = idOf(e.vars as CancelRunVars | undefined);
        if (runId === null) break;
        const s = runOf(runId);
        s.cancel = merged(s.cancel, paused);
        break;
      }
      case "rerun-job": {
        const vars = e.vars as RerunJobVars | undefined;
        const jobId = idOf(vars?.jobId);
        if (jobId !== null) {
          const s = jobOf(jobId);
          s.rerun = merged(s.rerun, paused);
        }
        const runId = idOf(vars?.runId);
        if (runId !== null) {
          const s = runOf(runId);
          s.jobRerun = merged(s.jobRerun, paused);
        }
        break;
      }
      case "play-job": {
        const jobId = idOf(e.vars as PlayJobVars | undefined);
        if (jobId === null) break;
        const s = jobOf(jobId);
        s.play = merged(s.play, paused);
        break;
      }
      case "approve-run": {
        const runId = idOf((e.vars as ApproveRunVars | undefined)?.runId);
        if (runId === null) break;
        const s = runOf(runId);
        s.approve = merged(s.approve, paused);
        break;
      }
      default:
        break;
    }
  }
  return { runs, jobs };
}

/** Run `runId`'s in-flight writes, whichever id type the caller holds. */
export function pendingRunState(
  writes: PendingRunWrites,
  runId: number | string,
): PendingRunState | undefined {
  const id = String(runId);
  return writes.runs.find((r) => r.runId === id);
}

/** Job `jobId`'s in-flight writes. */
export function pendingJobState(
  writes: PendingRunWrites,
  jobId: string,
): PendingJobState | undefined {
  return writes.jobs.find((j) => j.jobId === jobId);
}

/** The run's re-run family in flight: its own re-run or a re-run of one of its
 *  jobs, which act on the same attempt. Paused only when every part is parked. */
export function rerunFamilyState(
  state: PendingRunState | undefined,
): RunWriteState | undefined {
  const parts = [state?.rerun, state?.jobRerun].filter(
    (p): p is RunWriteState => p !== undefined,
  );
  return parts.length === 0
    ? undefined
    : { paused: parts.every((p) => p.paused) };
}
