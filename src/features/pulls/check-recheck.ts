/**
 * The PR checks rollup's rescue for a check the PR still reports pending while
 * its run's head-list row reads finished: the PR's checks can lag the runs
 * list, a failed PR read isn't retried, and a re-run started elsewhere sits
 * over the old finished row until the list is read again. Pure, so the bound
 * is testable; its one import is the run-status module, by a relative `.ts`
 * specifier, so `scripts/check-recheck.test.mjs` loads it under Node's type
 * stripping.
 */
import { isRunActive } from "../../lib/github/run-status.ts";

/** When an identity re-reads the head list and the PR's checks, from when its
 *  episode began. */
export const CHECKS_RECHECK_DELAYS_MS = [15_000, 30_000, 60_000] as const;
/** A step due within this much of a tick fires on it, so identities first seen
 *  a moment apart share one re-read instead of firing back to back. */
export const RECHECK_COALESCE_MS = 1_000;

/** The check fields an identity reads. */
export type RecheckCheck = {
  runId?: string;
  jobId?: string;
  name: string;
  startedAt?: string;
};

/** The check attempts of runs with at least one `isPending` check, one
 *  identity per run: `<runId>|<sorted job ids>` over ALL the run's checks,
 *  pending or not, a check without a job id standing in as `name@startedAt`.
 *  Keyed on the checks, never the row: a re-run (full or failed jobs only)
 *  mints new check runs, so it reads as a new identity over the same stale
 *  row, while a lagging check of the old attempt, or a sibling job settling,
 *  keeps it. `live` holds those over a finished row (the mismatch), `active`
 *  those over an executing row (paused, not resolved). A run the rows don't
 *  carry belongs to the per-run fallback. */
export function recheckIdentities<C extends RecheckCheck>(
  checks: readonly C[],
  isPending: (check: C) => boolean,
  rowsById: ReadonlyMap<string, { status: string }>,
): { live: string[]; active: string[] } {
  const runs = new Map<string, { parts: string[]; pending: boolean }>();
  for (const c of checks) {
    if (!c.runId) continue;
    const part = c.jobId || `${c.name}@${c.startedAt ?? ""}`;
    const run = runs.get(c.runId);
    if (run) {
      run.parts.push(part);
      run.pending ||= isPending(c);
    } else runs.set(c.runId, { parts: [part], pending: isPending(c) });
  }
  const live: string[] = [];
  const active: string[] = [];
  for (const [runId, run] of runs) {
    const row = rowsById.get(runId);
    if (!run.pending || row === undefined) continue;
    const id = `${runId}|${[...run.parts].sort().join(",")}`;
    (isRunActive(row.status) ? active : live).push(id);
  }
  return { live: live.sort(), active: active.sort() };
}

/** One identity's progress: when its episode began, whether its head-list read
 *  ran, how many ladder steps fired, whether its row was last seen executing
 *  (paused), and whether it is finished for good. */
export type RecheckEntry = {
  firstSeenMs: number;
  headRefetched: boolean;
  firedSteps: number;
  paused: boolean;
  done: boolean;
};

export type RecheckState = ReadonlyMap<string, RecheckEntry>;

/** What a reconcile asks of its caller: the first-sight head-list read, one
 *  ladder re-read (the head list and the PR's checks), and when to reconcile
 *  again (null: nothing pending). */
export type RecheckActions = {
  refetchHead: boolean;
  reread: boolean;
  nextDueMs: number | null;
};

/** Advances every identity to `nowMs`. Each episode reads the head list on
 *  first sight and re-reads it with the PR's checks at each ladder step, then
 *  is done and never re-arms. An identity in `active` (its row executing) is
 *  paused, not resolved: when its row reads finished again it starts one fresh
 *  episode. One that left both lists has resolved (its check stopped reading
 *  pending). While not `visible` (collapsed, or the tab hidden) nothing fires
 *  and nothing resolves; on return, steps that came due meanwhile collapse
 *  into one re-read. */
export function reconcileRecheck(
  state: RecheckState,
  live: readonly string[],
  visible: boolean,
  nowMs: number,
  active: readonly string[],
): { state: RecheckState; actions: RecheckActions } {
  const actions: RecheckActions = {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  };
  if (!visible) return { state, actions };
  const liveSet = new Set(live);
  const activeSet = new Set(active);
  const next = new Map(state);
  for (const [id, entry] of state) {
    if (liveSet.has(id)) continue;
    if (activeSet.has(id)) next.set(id, { ...entry, paused: true });
    else if (!entry.done || entry.paused)
      next.set(id, { ...entry, paused: false, done: true });
  }
  for (const id of liveSet) {
    const prev = next.get(id);
    if (prev?.done && !prev.paused) continue;
    let entry: RecheckEntry =
      prev === undefined || prev.paused
        ? {
            firstSeenMs: nowMs,
            headRefetched: false,
            firedSteps: 0,
            paused: false,
            done: false,
          }
        : prev;
    if (!entry.headRefetched) {
      actions.refetchHead = true;
      entry = { ...entry, headRefetched: true };
    }
    let due = entry.firedSteps;
    while (
      due < CHECKS_RECHECK_DELAYS_MS.length &&
      entry.firstSeenMs + CHECKS_RECHECK_DELAYS_MS[due] <=
        nowMs + RECHECK_COALESCE_MS
    )
      due++;
    if (due > entry.firedSteps) {
      actions.reread = true;
      entry = { ...entry, firedSteps: due };
    }
    if (entry.firedSteps >= CHECKS_RECHECK_DELAYS_MS.length) {
      entry = { ...entry, done: true };
    } else {
      const at = entry.firstSeenMs + CHECKS_RECHECK_DELAYS_MS[entry.firedSteps];
      if (actions.nextDueMs === null || at < actions.nextDueMs)
        actions.nextDueMs = at;
    }
    next.set(id, entry);
  }
  return { state: next, actions };
}
