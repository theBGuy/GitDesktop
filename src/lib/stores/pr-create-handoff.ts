import type { QueryClient } from "@tanstack/react-query";
import type { PrDetails, PrInfo, RemoteLens } from "@/lib/git/types";
// Relative and extensioned, not the `@/` alias: `scripts/pr-create-lane.test.mjs`
// imports this module directly under Node's type stripping, which resolves no
// path aliases and no extensionless specifiers.
import { normPath } from "../git/path.ts";
import {
  markPrCreateArmed,
  prCreateStartedAt,
  releasePrCreateGuard,
  settlePrCreateIfCurrent,
} from "./pr-create.ts";

/** Time after the create flow finishes before the lane's GUARD releases even if
 *  the list never showed the PR. The duplicate-create refusal and the repo-view
 *  banner both end here: the forge is the authority on duplicates, and a banner
 *  held past this backstop is the stranded-line failure the constant exists to
 *  prevent. It never removes the entry — the held list spot outlives it. */
export const GUARD_RELEASE_TIMEOUT_MS = 20_000;

/** The only wall clock that may REMOVE a held entry. It bounds the strip for a
 *  PR a server-side filter genuinely never shows, and — within that bound — one
 *  closed on the web before any list contained it, so a hold can't outlive the
 *  session waiting for a row that isn't coming. */
export const HOLD_LONGSTOP_MS = 30 * 60_000;

/** `usePrList`'s key down to its lens: index 3 is the lens, index 4 the
 *  open/closed state. Indices 4+ (state, limit, filter) stay free, so every
 *  permutation on screen counts; the lens stays pinned, since a bare number is
 *  only valid under the lens that produced it. */
function matchesPrList(
  key: readonly unknown[],
  repoPath: string,
  lens: RemoteLens,
): boolean {
  return (
    key[0] === "repo" &&
    key[2] === "pr-list" &&
    typeof key[1] === "string" &&
    normPath(key[1]) === normPath(repoPath) &&
    key[3] === lens
  );
}

/**
 * What one cached page proves about the new PR, and therefore which half of the
 * lane it ends. A row in any non-`"OPEN"` state SETTLES: it legitimately left
 * the open list, so holding its spot would paint a strip for a dead PR. An
 * open-axis page carrying it only RELEASES the guard — the PR is live and
 * listable, but this page may be some sibling surface's unfiltered one, and only
 * the panel knows whether the list the strip sits in shows the row. A
 * closed-axis row still reading `"OPEN"` proves nothing either way: a provider
 * whose closed list leaks open rows must not cut the lane short. `"OPEN"` is the
 * canonical cross-provider open spelling, the same test the list row's badge
 * makes.
 */
function pageVerdict(
  key: readonly unknown[],
  rows: PrInfo[] | undefined,
  number: number,
): "none" | "release" | "settle" {
  const row = rows?.find((p) => p.number === number);
  if (!row) return "none";
  if (row.state !== "OPEN") return "settle";
  return key[4] === "open" ? "release" : "none";
}

/** `usePrDetails`' key — lens at index 3, number at index 4, and NOTHING after:
 *  the PR diff extends the same prefix with `"diff"` and its payload is not a
 *  {@link PrDetails}. The held row opens the PR, so closing or merging it from
 *  the detail view is evidence no list page can carry — the open list will never
 *  contain it, and a closed-list observer may not exist. Any later detail read
 *  covers a web close the same way. */
function matchesPrDetail(
  key: readonly unknown[],
  repoPath: string,
  lens: RemoteLens,
  number: number,
): boolean {
  return (
    key.length === 5 &&
    key[0] === "repo" &&
    key[2] === "pr" &&
    typeof key[1] === "string" &&
    normPath(key[1]) === normPath(repoPath) &&
    key[3] === lens &&
    key[4] === number
  );
}

/**
 * Arms ONE create's hand-off, on two clocks for the lane's two jobs, and holds
 * the invariants both halves are named for:
 * - The GUARD — duplicate-create admission plus the repo-view banner, together
 *   exactly what `laneBlocks` answers — ends at list containment or
 *   {@link GUARD_RELEASE_TIMEOUT_MS}, whichever comes first.
 * - The ENTRY, i.e. the list's held spot, lives until THE PANEL's own page shows
 *   the row, closed-or-merged evidence arrives — from a list page or from the
 *   PR's own detail, which the held row can open — or {@link HOLD_LONGSTOP_MS}
 *   expires. A search-backed filtered list routinely lags well past the guard
 *   timeout, and a spot released before the real row exists leaves nothing on
 *   screen.
 * - Nothing here writes the pr-list cache: a synthetic row would poison the
 *   list's number-keyed digests.
 *
 * Deletion is therefore the panel's call, not this watcher's — sibling surfaces
 * (BranchSwitcher, the PR audit, mention candidates) fetch UNFILTERED pages
 * under the same lens, and settling on one of those would drop the strip while
 * the panel's own filtered page still lacks the row. What those pages DO prove
 * is that the PR exists, which is the guard's whole question.
 *
 * Lifecycle is module-level on purpose — raw timeouts plus a query-cache
 * subscription, so it survives the dialog's unmount, a repo switch, and an
 * `<Activity>` tab hide, all of which would defer or cancel a panel-hosted
 * effect. A watcher whose head has been re-claimed reaps itself on the next
 * cache event rather than holding a half-hour subscription for a lane it can no
 * longer speak for.
 */
export function armPrCreateHandOff(
  queryClient: QueryClient,
  create: {
    repoPath: string;
    head: string;
    lens: RemoteLens;
    number: number;
    startedAt: number;
  },
  /** Durations, defaulting to the two constants. They exist as an explicit test
   *  seam: `scripts/pr-create-lane.test.mjs` injects ~10-40ms and awaits real
   *  timers rather than faking the clock. */
  opts?: { guardTimeoutMs?: number; longStopMs?: number },
): void {
  // FIRST act: arming is what lets the deferred settlers touch this entry at
  // all, and the cached-page check below is one of them. It gates nothing in
  // this function's own later paths, which by construction only exist after it.
  markPrCreateArmed(create.repoPath, create.head, create.startedAt);

  let unsubscribe: (() => void) | undefined;
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  let longStopTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
    guardTimer = undefined;
    if (longStopTimer !== undefined) clearTimeout(longStopTimer);
    longStopTimer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  };
  const releaseGuard = () =>
    releasePrCreateGuard(create.repoPath, create.head, create.startedAt);
  // Resources first, store write second: cleanup is unconditional so a watcher
  // that can no longer speak for its head still frees itself, while the settle's
  // own identity guard is what keeps it off a later create's entry.
  const settle = () => {
    cleanup();
    settlePrCreateIfCurrent(create.repoPath, create.head, create.startedAt);
  };

  // Subscribe before reading what is already cached: the reverse order would
  // leave `unsubscribe` unassigned when an already-present PR settles inline.
  unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    // A cache event is the only moment a superseded watcher can notice it was
    // superseded; without this it would hold its subscription until the long
    // stop for a lane whose every write it would no-op anyway.
    if (prCreateStartedAt(create.repoPath, create.head) !== create.startedAt) {
      cleanup();
      return;
    }
    if (
      matchesPrDetail(
        event.query.queryKey,
        create.repoPath,
        create.lens,
        create.number,
      )
    ) {
      const detail = event.query.state.data as PrDetails | undefined;
      if (detail !== undefined && detail.state !== "OPEN") settle();
      return;
    }
    if (!matchesPrList(event.query.queryKey, create.repoPath, create.lens))
      return;
    const verdict = pageVerdict(
      event.query.queryKey,
      event.query.state.data as PrInfo[] | undefined,
      create.number,
    );
    if (verdict === "settle") settle();
    else if (verdict === "release") releaseGuard();
  });
  // Releasing the guard deliberately leaves the subscription up: closed evidence
  // can still arrive, and it is one of the two things that removes the entry.
  guardTimer = setTimeout(
    releaseGuard,
    opts?.guardTimeoutMs ?? GUARD_RELEASE_TIMEOUT_MS,
  );
  longStopTimer = setTimeout(settle, opts?.longStopMs ?? HOLD_LONGSTOP_MS);

  const cached = queryClient.getQueriesData<PrInfo[]>({
    predicate: (q) => matchesPrList(q.queryKey, create.repoPath, create.lens),
  });
  const verdicts = cached.map(([key, rows]) =>
    pageVerdict(key, rows, create.number),
  );
  if (verdicts.includes("settle")) settle();
  else if (verdicts.includes("release")) releaseGuard();

  // The detail evidence's arm-time half: the held row is clickable BEFORE this
  // runs, so the PR can already have been closed or merged from the detail view
  // during the create's continuation. That detail sits cached with no cache
  // event left to fire, so the subscription alone would never see it. Matched
  // through the same predicate the subscription uses, so both halves compare
  // the repo path the one way {@link normPath} allows.
  const details = queryClient.getQueriesData<PrDetails>({
    predicate: (q) =>
      matchesPrDetail(q.queryKey, create.repoPath, create.lens, create.number),
  });
  if (details.some(([, d]) => d !== undefined && d.state !== "OPEN")) settle();
}
