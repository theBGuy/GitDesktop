import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  gitCleanupOrphanedResolveWorktrees,
  gitCloseAbandonedLocalPrUpdates,
} from "@/lib/git/api";
import {
  type LocalPrUpdateDiscardVars,
  oplogCheckOptions,
  RESOLVE_WORKTREE_START_KEYS,
  resolveSweeps,
  useAnyResolveWorktreeStarting,
  useDiscardLocalPrUpdate,
} from "@/lib/git/queries";
import {
  type LocalPr,
  openPendingUpdate,
  type PendingUpdate,
  reloadLocalPrs,
  updateLocalPr,
} from "@/lib/pulls/local";
import { localPrKey, useLocalPrs } from "@/lib/pulls/queries";

/** The open PRs' unfinished updates as one pass of the sweep saw them. */
export interface SeenUpdates {
  repo: string;
  updates: Map<string, PendingUpdate>;
}

const discardOf = (
  id: string | null,
  update: PendingUpdate,
  head: string,
): LocalPrUpdateDiscardVars => ({
  id,
  head,
  worktreePath: update.worktreePath,
  worktreeId: update.worktreeId,
  opId: update.opId,
  journalRepo: update.journalRepo,
});

/**
 * The unfinished updates a loaded list shows to be abandoned, and the open ones to
 * compare the next list against:
 * - a PR that is no longer open but still carries the field: a well-formed field is
 *   discarded under its record id and the record's own head (a branch rename rewrites
 *   an OPEN record's head, never the field, and leaves closed records as they are);
 *   one too malformed to name a worktree is listed in
 *   `clears`, to be dropped from the record with nothing to remove;
 * - an open update in `seen` whose PR is gone from this list (deleted): discarded with
 *   a null id and the head it was stored with, since no record is left.
 * `seen` from another repository discards nothing, and an open PR whose field simply
 * cleared was finished or discarded by its own flow.
 */
export function staleUpdateDiscards(
  seen: SeenUpdates | null,
  repoPath: string,
  prs: LocalPr[],
): {
  discards: LocalPrUpdateDiscardVars[];
  clears: string[];
  seen: SeenUpdates;
} {
  const discards: LocalPrUpdateDiscardVars[] = [];
  const clears: string[] = [];
  const updates = new Map<string, PendingUpdate>();
  for (const pr of prs) {
    if (pr.status === "open") {
      const update = openPendingUpdate(pr);
      if (update) updates.set(pr.id, update);
      continue;
    }
    if (pr.pendingUpdate === undefined) continue;
    // The field's shape is judged as the open read would judge it.
    const stale = openPendingUpdate({ ...pr, status: "open" });
    if (stale) discards.push(discardOf(pr.id, stale, pr.head));
    else clears.push(pr.id);
  }
  if (seen?.repo === repoPath) {
    const listed = new Set(prs.map((pr) => pr.id));
    for (const [id, update] of seen.updates)
      if (!listed.has(id)) discards.push(discardOf(null, update, update.head));
  }
  return { discards, clears, seen: { repo: repoPath, updates } };
}

/** False when `current` turned false before an IPC: a start began, or the repository
 *  switched, after `prs` was read, so the keep-lists are stale and the rest of the
 *  pass is left undone. */
async function sweepResolveWorktrees(
  queryClient: QueryClient,
  repoPath: string,
  prs: LocalPr[],
  current: () => boolean,
): Promise<boolean> {
  const keep: string[] = [];
  const keepOpIds: string[] = [];
  for (const pr of prs) {
    if (pr.pendingMerge?.worktreePath) keep.push(pr.pendingMerge.worktreePath);
    if (pr.pendingMerge?.opId) keepOpIds.push(pr.pendingMerge.opId);
    const update = openPendingUpdate(pr);
    if (update) {
      keep.push(update.worktreePath);
      keepOpIds.push(update.opId);
    }
  }
  if (!current()) return false;
  await gitCleanupOrphanedResolveWorktrees(repoPath, keep).catch(
    () => undefined,
  );
  if (!current()) return false;
  const closed = await gitCloseAbandonedLocalPrUpdates(
    repoPath,
    keepOpIds,
  ).catch(() => 0);
  if (closed > 0) {
    void queryClient.invalidateQueries({
      queryKey: oplogCheckOptions(repoPath).queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: ["repo", repoPath, "oplog"],
    });
  }
  return true;
}

/**
 * Reclaims what a local PR's conflict resolution leaves behind. Three behaviours, all
 * idle while no repository is open (`repoPath` is "") or the PR list hasn't loaded:
 *
 * - ONCE per repo open, the worktree sweep. The command removes every hidden
 *   `gd-resolve-*` worktree outside the keep-list (each paused merge's worktree plus
 *   each open PR's unfinished update worktree) and, keep-list free, every remote
 *   `gd-pr-resolve-*` worktree holding nothing; then the journal closer ends this
 *   checkout's unfinished update entries whose op id no open record keeps, and its
 *   paused merge entries whose op id no record keeps. The keep-list comes ONLY from a
 *   list read this hook requested, after a store reload, once the repo opened and
 *   after the last moment a local-PR update or into-base merge start was in flight
 *   in this window, under any checkout key: a cached list, one read before a start
 *   wrote its record, or the store's in-memory copy would sweep a live worktree.
 *   A start in this window waits out a pass in flight, and a pass that sees a start
 *   begin abandons before its next IPC and asks again. A failed reload or read skips
 *   the sweep for this open (an empty keep-list would remove live worktrees).
 *   Residual: a second window's in-flight start is invisible here.
 * - On EVERY loaded list, a PR that stopped being open with its update still on
 *   record (closed or merged by a route outside the view) has that update discarded,
 *   and an open update whose PR left the list (deleted) is discarded with no record
 *   to clear ({@link staleUpdateDiscards}). Each worktree is handed to a discard once.
 * - A closed PR's field too malformed to name a worktree is dropped from the record,
 *   once per PR.
 *
 * Best-effort: errors are swallowed and nothing toasts. Mount once per repo.
 */
export function useCleanupResolveWorktrees(repoPath: string) {
  const queryClient = useQueryClient();
  const prs = useLocalPrs(repoPath);
  const starting = useAnyResolveWorktreeStarting();
  const { mutateAsync: discardUpdate } = useDiscardLocalPrUpdate(
    repoPath,
    localPrKey(repoPath),
  );
  const sweptRepo = useRef<string | null>(null);
  // The read the sweep may use must be requested after `since`: a new object per
  // window, so a continuation whose window moved on recognises itself as stale.
  const fresh = useRef<{
    repo: string;
    since: number;
    requested: boolean;
  } | null>(null);
  const request = useRef<(() => void) | null>(null);
  const seen = useRef<SeenUpdates | null>(null);
  const handed = useRef(new Set<string>());
  const cleared = useRef(new Set<string>());
  const { isSuccess, data, refetch } = prs;

  useEffect(() => {
    // A start is pending in the cache before any render shows it, and can settle
    // before one does, so the cache itself is read, not only `starting`.
    const startsInFlight = () =>
      starting ||
      RESOLVE_WORKTREE_START_KEYS.some(
        (mutationKey) =>
          queryClient.getMutationCache().findAll({
            mutationKey,
            status: "pending",
          }).length > 0,
      );
    const sweepWhenFresh = () => {
      if (!repoPath) return;
      if (fresh.current?.repo !== repoPath)
        fresh.current = { repo: repoPath, since: Date.now(), requested: false };
      if (
        startsInFlight() ||
        !isSuccess ||
        sweptRepo.current === repoPath ||
        fresh.current.requested
      )
        return;
      const token = fresh.current;
      token.requested = true;
      const current = () => fresh.current === token && !startsInFlight();
      const sweep = async () => {
        // The store serves its in-memory copy, so another instance's records reach
        // the read only through a reload; a failed one skips this open's sweep.
        try {
          await reloadLocalPrs();
        } catch {
          if (current()) sweptRepo.current = repoPath;
          return;
        }
        if (!current() || sweptRepo.current === repoPath) return;
        // Cancels a read in flight from before the reload.
        const result = await refetch();
        if (!current() || sweptRepo.current === repoPath) return;
        // A read cancelled back to its earlier answer resolves with data from before
        // `since`, which this window never requested: ask again.
        if (result.isSuccess && result.dataUpdatedAt <= token.since) {
          token.requested = false;
          request.current?.();
          return;
        }
        sweptRepo.current = repoPath;
        // A failed list read skips this open's sweep rather than guess a keep-list.
        if (!result.isSuccess) return;
        const done = await sweepResolveWorktrees(
          queryClient,
          repoPath,
          result.data,
          current,
        ).catch(() => true);
        if (done) return;
        // A start began or the repository switched mid-pass: this open is still
        // unswept, so ask again (the request waits until no start is in flight).
        if (sweptRepo.current === repoPath) sweptRepo.current = null;
        request.current?.();
      };
      // Starts wait this out before their command runs (`resolveSweeps`).
      resolveSweeps.track(repoPath, sweep());
    };
    request.current = sweepWhenFresh;
    sweepWhenFresh();
  }, [repoPath, starting, isSuccess, refetch, queryClient]);

  // A start's `added` and `updated` events (begun, and every state change up to its
  // settle) each open a new window: no read requested before it may supply the
  // keep-list. Observer and removal events change nothing a list read could miss.
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "added" && event.type !== "updated") return;
        const key = event.mutation?.options.mutationKey;
        const isStart = RESOLVE_WORKTREE_START_KEYS.some(
          (start) => key?.[0] === start[0] && key[1] === start[1],
        );
        if (!isStart || !fresh.current) return;
        fresh.current = {
          repo: fresh.current.repo,
          since: Date.now(),
          requested: false,
        };
        request.current?.();
      }),
    [queryClient],
  );

  useEffect(() => {
    if (!repoPath || !isSuccess || data === undefined) return;
    const pass = staleUpdateDiscards(seen.current, repoPath, data);
    seen.current = pass.seen;
    for (const vars of pass.discards) {
      if (handed.current.has(vars.worktreeId)) continue;
      handed.current.add(vars.worktreeId);
      discardUpdate(vars).catch(() => undefined);
    }
    for (const id of pass.clears) {
      const key = `${repoPath}\n${id}`;
      if (cleared.current.has(key)) continue;
      cleared.current.add(key);
      void updateLocalPr(repoPath, id, (cur) =>
        cur.status === "open" ? cur : { ...cur, pendingUpdate: undefined },
      )
        .catch(() => undefined)
        .then(() =>
          queryClient.invalidateQueries({ queryKey: localPrKey(repoPath) }),
        );
    }
  }, [repoPath, isSuccess, data, discardUpdate, queryClient]);
}
