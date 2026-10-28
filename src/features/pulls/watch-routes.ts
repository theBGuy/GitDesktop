/**
 * Which completion watchers the PR checks rollup mounts for its watched runs.
 * Its one import is type-only, which Node's type stripping erases, so
 * `scripts/watch-routes.test.mjs` loads it directly.
 */
import type { ForgeProvider } from "@/lib/git/types";

/** The watch state the routing reads. `headIds` holds the runs the head list
 *  carries, and is empty off GitHub. */
export type WatchRouteInput = {
  provider: ForgeProvider | null | undefined;
  headSha: string | null;
  headLoaded: boolean;
  headError: boolean;
  headIds: { has(id: string): boolean };
  mountedWatchIds: readonly string[];
  runningRunIds: readonly string[];
  open: boolean;
};

/** The runs each watched id is read through: a run view of its own, or (for a
 *  running GitHub run the head list carries, while the rollup is open) a jobs
 *  read. With `headIds` empty whenever there is no head list, no id gets
 *  both. */
export type WatchRoutes = { runViewIds: string[]; jobsReadIds: string[] };

/** The run views to mount. Off GitHub, or with no known head sha (so no head
 *  poll), every watched run takes one. On GitHub only a run the head list
 *  doesn't carry (over 100 runs on one commit, a sha mismatch) does, and only
 *  off a list that answered and is healthy: a pending or failed read, a rate
 *  limit included, must not fan out a run view per watched run. */
function runViewIds(input: WatchRouteInput): string[] {
  if (input.provider !== "github" || input.headSha === null)
    return [...input.mountedWatchIds];
  if (!input.headLoaded || input.headError) return [];
  return input.mountedWatchIds.filter((id) => !input.headIds.has(id));
}

/** The jobs reads: only while open, and only for running runs the head list
 *  carries, whose steps the open list shows. */
function jobsReadIds(input: WatchRouteInput): string[] {
  if (!input.open) return [];
  return input.runningRunIds.filter((id) => input.headIds.has(id));
}

export function watchRoutes(input: WatchRouteInput): WatchRoutes {
  return { runViewIds: runViewIds(input), jobsReadIds: jobsReadIds(input) };
}
