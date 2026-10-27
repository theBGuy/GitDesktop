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

/** When an identity re-reads the head list and the PR's checks, from when it
 *  was first seen. */
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

/** The pending checks' attempts over finished head rows, one identity per run:
 *  `<runId>|<sorted job ids>`, a check without a job id standing in as
 *  `name@startedAt`. Keyed on the CHECKS, never the row: a re-run mints new
 *  check runs, so it always reads as a new identity over the same stale row,
 *  while a lagging check of the old attempt keeps its own. A run the rows
 *  don't carry belongs to the per-run fallback. */
export function recheckIdentities(
  pendingChecks: readonly RecheckCheck[],
  rowsById: ReadonlyMap<string, { status: string }>,
): string[] {
  const parts = new Map<string, string[]>();
  for (const c of pendingChecks) {
    if (!c.runId) continue;
    const row = rowsById.get(c.runId);
    if (row === undefined || isRunActive(row.status)) continue;
    const part = c.jobId || `${c.name}@${c.startedAt ?? ""}`;
    const list = parts.get(c.runId);
    if (list) list.push(part);
    else parts.set(c.runId, [part]);
  }
  return [...parts]
    .map(([runId, list]) => `${runId}|${[...list].sort().join(",")}`)
    .sort();
}

/** One identity's progress: when it was first seen, whether its head-list read
 *  ran, how many ladder steps fired, and whether it is finished for good. */
export type RecheckEntry = {
  firstSeenMs: number;
  headRefetched: boolean;
  firedSteps: number;
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

/** Advances every identity to `nowMs`. Each one reads the head list on first
 *  sight and re-reads it with the PR's checks at each ladder step, then is
 *  done and never re-arms. While not `visible` (collapsed, or the tab hidden) nothing fires
 *  and nothing resolves; on return, steps that came due meanwhile collapse
 *  into one re-read. A visible identity that left `live` has resolved (its
 *  check stopped reading pending, or its row turned active). */
export function reconcileRecheck(
  state: RecheckState,
  live: readonly string[],
  visible: boolean,
  nowMs: number,
): { state: RecheckState; actions: RecheckActions } {
  const actions: RecheckActions = {
    refetchHead: false,
    reread: false,
    nextDueMs: null,
  };
  if (!visible) return { state, actions };
  const liveSet = new Set(live);
  const next = new Map(state);
  for (const [id, entry] of state) {
    if (!entry.done && !liveSet.has(id)) next.set(id, { ...entry, done: true });
  }
  for (const id of liveSet) {
    const prev = next.get(id);
    if (prev?.done) continue;
    let entry: RecheckEntry = prev ?? {
      firstSeenMs: nowMs,
      headRefetched: false,
      firedSteps: 0,
      done: false,
    };
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
