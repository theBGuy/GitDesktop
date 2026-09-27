import type { PrPollInfo } from "@/lib/git/types";

/** Consecutive polls a row may stay unconfirmed before GitHub's precomputed
 *  rollup stands for it. */
export const MAX_UNCONFIRMED_POLLS = 3;

/** One poll's merged baseline, plus each PR's current unconfirmed streak (only
 *  PRs in this poll with a streak above zero). */
export interface PollBaseline {
  snapshot: Map<number, PrPollInfo>;
  streaks: Map<number, number>;
}

/**
 * The PR poller's next baseline. An unconfirmed red rollup may flip back next
 * poll, so for up to {@link MAX_UNCONFIRMED_POLLS} polls it never replaces the
 * baseline: the previous state carries over, and an unknown one stays unknown.
 * Past the limit the row takes GitHub's precomputed enum as confirmed, so a
 * confirm that fails every poll can't silence a PR's checks for good.
 *
 * Cost: a confirm outage longer than the limit can still send one false
 * failed/passed pair for a superseded failure — what every poll did before the
 * confirm existed, now bounded in time instead of repeating.
 *
 * Kept free of runtime imports so the node test harness can load it directly.
 */
export function mergePollBaseline(
  before: ReadonlyMap<number, PrPollInfo> | null,
  data: readonly PrPollInfo[],
  streaks: ReadonlyMap<number, number>,
): PollBaseline {
  const snapshot = new Map<number, PrPollInfo>();
  const nextStreaks = new Map<number, number>();
  for (const p of data) {
    const streak = p.checksUnconfirmed ? (streaks.get(p.number) ?? 0) + 1 : 0;
    if (streak > 0) nextStreaks.set(p.number, streak);
    const held = p.checksUnconfirmed ? before?.get(p.number) : undefined;
    let row = p;
    if (streak > MAX_UNCONFIRMED_POLLS) {
      row = { ...p, checksUnconfirmed: false };
    } else if (held) {
      row = {
        ...p,
        checksState: held.checksState,
        checksUnconfirmed: held.checksUnconfirmed,
      };
    }
    snapshot.set(p.number, row);
  }
  return { snapshot, streaks: nextStreaks };
}
