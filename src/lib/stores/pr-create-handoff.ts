import type { QueryClient } from "@tanstack/react-query";
import { normPath } from "@/lib/git/path";
import type { PrInfo, RemoteLens } from "@/lib/git/types";
import { prCreateStartedAt, settlePrCreate } from "@/lib/stores/pr-create";

/** Time after the create flow finishes before the lane force-settles even if the
 *  list never showed the PR — a failed refetch, a server-side filter that
 *  excludes it, or no observer on the pulls tab at all. Settling also releases
 *  the duplicate-create guard the lane doubles as: deliberate, since the forge
 *  is the authority on duplicates, and holding the lane past this backstop is
 *  exactly the stranded-banner failure the constant exists to prevent. */
export const HANDOFF_TIMEOUT_MS = 20_000;

/** `usePrList`'s key up to its state axis: index 3 is the lens, index 4 the
 *  open/closed state. Indices 5+ (limit, filter) stay free, so every filter
 *  permutation on screen counts — but the state is pinned to "open", since a
 *  CLOSED list containing the number would settle the lane before the list the
 *  strip actually sits in has caught up. */
function matchesOpenPrList(
  key: readonly unknown[],
  repoPath: string,
  lens: RemoteLens,
): boolean {
  return (
    key[0] === "repo" &&
    key[2] === "pr-list" &&
    typeof key[1] === "string" &&
    normPath(key[1]) === normPath(repoPath) &&
    key[3] === lens &&
    key[4] === "open"
  );
}

/** Whether a cached page holds the new PR. Its rows are {@link PrInfo}, which the
 *  panel's own hand-off derive tests the same way. */
function pageHasNumber(rows: PrInfo[] | undefined, number: number): boolean {
  return rows?.some((p) => p.number === number) ?? false;
}

/**
 * Arms ONE create's hand-off: settles the lane with `"success"` once any cached
 * open pr-list query for this repo + lens contains `number`, else at
 * {@link HANDOFF_TIMEOUT_MS}. Lifecycle is module-level on purpose — a raw
 * timeout plus a query-cache subscription, so it survives the dialog's unmount,
 * a repo switch, and an `<Activity>` tab hide, all of which would defer or
 * cancel a panel-hosted effect. It never writes the cache: a synthetic row would
 * poison the list's number-keyed digests.
 *
 * ACCEPTED: any open-lens page for the repo counts, so a sibling observer's page
 * (BranchSwitcher, the PR audit, mention candidates) can settle the lane a beat
 * before the panel's own fetch lands. Narrowing the match to the panel's
 * limit/filter is undecidable, and the window is concurrent-refetch skew.
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
): void {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    // Identity guard: the lane may already be gone, or re-claimed by a LATER
    // create on the same head whose arrival this watcher must not cut short.
    // It is also what makes a second firing a no-op.
    if (prCreateStartedAt(create.repoPath, create.head) !== create.startedAt)
      return;
    settlePrCreate(create.repoPath, create.head, "success");
  };

  // Subscribe before reading what is already cached: the reverse order would
  // leave `unsubscribe` unassigned when an already-present PR settles inline.
  unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (!matchesOpenPrList(event.query.queryKey, create.repoPath, create.lens))
      return;
    if (
      pageHasNumber(
        event.query.state.data as PrInfo[] | undefined,
        create.number,
      )
    )
      settle();
  });
  timer = setTimeout(settle, HANDOFF_TIMEOUT_MS);

  const cached = queryClient.getQueriesData<PrInfo[]>({
    predicate: (q) =>
      matchesOpenPrList(q.queryKey, create.repoPath, create.lens),
  });
  if (cached.some(([, rows]) => pageHasNumber(rows, create.number))) settle();
}
