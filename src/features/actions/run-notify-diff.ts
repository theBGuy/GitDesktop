/**
 * Which runs of a branch's latest poll the run notifier announces, as a pure diff
 * against the previous poll (the prime). Its one import is the run-status module,
 * by a relative `.ts` specifier, so `scripts/run-notify-diff.test.mjs` loads it
 * under Node's type stripping.
 */
import {
  isFailureConclusion,
  isRunActive,
} from "../../lib/github/run-status.ts";

/** The run fields the diff reads. */
export type NotifyRun = {
  id: number;
  status: string;
  conclusion: string;
  createdAt: string;
  headSha: string;
};

/** The previous poll: its runs by id, its highest run id (null when it saw none),
 *  its result time, and the time a run must be created after to count as new
 *  while it saw none. */
export type RunNotifyPrime<R extends NotifyRun> = {
  runs: Map<number, R>;
  maxId: number | null;
  fetchedAt: number;
  primedAt: number;
};

/** How far a forge `createdAt` may run behind the local clock and still count as
 *  after an empty prime. Fails toward one duplicate (absorbed by the emitters'
 *  dedupe key) rather than a missed run; skew beyond it can still miss one. */
export const PRIME_SKEW_MS = 120_000;

/** The widest gap between two polls whose diff still announces runs absent from
 *  the first (three idle intervals). Past it (a sleep, an outage, a mute) the
 *  prime no longer describes what happened in between, so only witnessed edges
 *  announce. */
export const BETWEEN_POLLS_MAX_MS = 135_000;

/** The poll's interval: 8 s while the NEWEST run (the list's first) is active, or
 *  while a run of the same push (a non-empty `headSha`) is executing, since one
 *  push's runs list in arbitrary order; 45 s otherwise. A run left waiting or
 *  queued (an environment approval, an offline runner) never holds the fast rate. */
export function notifyPollInterval(
  runs: readonly NotifyRun[] | undefined,
): number {
  const newest = runs?.[0];
  if (newest === undefined) return 45_000;
  if (isRunActive(newest.status)) return 8_000;
  const sha = newest.headSha;
  return typeof sha === "string" &&
    sha !== "" &&
    runs?.some((r) => r.headSha === sha && r.status === "in_progress")
    ? 8_000
    : 45_000;
}

/** Whether a poll may become the first prime: only one fetched at or after the
 *  notifier enabled for this repo and branch, so a cached snapshot (a revisit, an
 *  unmute) never primes into alerts, whatever its age. `enabledAt` is the time the
 *  caller captured at enable, never the clock at the data's arrival. */
export function acceptsAsPrime(
  enabledAt: number | null,
  dataUpdatedAt: number,
): boolean {
  return enabledAt !== null && dataUpdatedAt >= enabledAt;
}

/** The prime a poll leaves for the next one. `fetchedAt` is the poll's result
 *  time (`dataUpdatedAt`), never a render clock. */
export function primeFrom<R extends NotifyRun>(
  snapshot: readonly R[],
  fetchedAt: number,
): RunNotifyPrime<R> {
  let maxId: number | null = null;
  for (const run of snapshot)
    if (maxId === null || run.id > maxId) maxId = run.id;
  return {
    runs: new Map(snapshot.map((run) => [run.id, run])),
    maxId,
    fetchedAt,
    primedAt: fetchedAt - PRIME_SKEW_MS,
  };
}

/**
 * The runs of the poll fetched at `fetchedAt` to announce: completed with a success
 * or failure conclusion (skipped, cancelled and neutral stay quiet), and either seen
 * active in the prime (the witnessed edge) or absent from it and newer than
 * anything it saw — a run that started and finished between polls, admitted only
 * when the two polls sit within {@link BETWEEN_POLLS_MAX_MS}. Newer means a higher
 * id than the prime's highest; with an empty prime, a parseable `createdAt` after
 * `primedAt` (an unparseable one stays quiet). A null prime (first poll, or a
 * switched repo or branch) announces nothing, so a switch never backfills.
 */
export function runsToNotify<R extends NotifyRun>(
  prime: RunNotifyPrime<R> | null,
  snapshot: readonly R[],
  fetchedAt: number,
): R[] {
  if (prime === null) return [];
  const adjacent = fetchedAt - prime.fetchedAt <= BETWEEN_POLLS_MAX_MS;
  return snapshot.filter((run) => {
    if (run.status !== "completed") return false;
    if (run.conclusion !== "success" && !isFailureConclusion(run.conclusion))
      return false;
    const before = prime.runs.get(run.id);
    if (before) return isRunActive(before.status);
    if (!adjacent) return false;
    if (prime.maxId !== null) return run.id > prime.maxId;
    const created = Date.parse(run.createdAt);
    return Number.isFinite(created) && created > prime.primedAt;
  });
}
