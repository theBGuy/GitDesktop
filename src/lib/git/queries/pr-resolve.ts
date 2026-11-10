import {
  type MutationCache,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type LocalPr,
  openPendingUpdate,
  type PendingMerge,
  type PendingUpdate,
  updateLocalPr,
} from "@/lib/pulls/local";
import { errorMessage } from "@/lib/tauri/invoke";
import * as api from "../api";
import type { RemoteLens } from "../types";
import { useMutationCacheSnapshot, useRepoMutation } from "./internal";
import { prChecksRecheck } from "./pr-actions";
import { LOCAL_PR_WRITES_KEY, localPrWriteKey, prWriteKey } from "./pr-writes";
import { recheckRunsAfterPush } from "./push-writes";
import { oplogCheckOptions } from "./stashes";

/** Why the fresh record refuses a paused merge, in the order it is checked. */
export type MergeRefusal = "not-open" | "merging" | "updating";

/** The refusal of the paused merge whose worktree is `worktreeId`, or null when the
 *  fresh record takes it: an open PR with no other paused merge and no unfinished
 *  update. Its own merge recorded already (a retried write) is no collision. */
function mergeRefusal(cur: LocalPr, worktreeId: string): MergeRefusal | null {
  switch (true) {
    case cur.status !== "open":
      return "not-open";
    case !!cur.pendingMerge?.worktreePath &&
      cur.pendingMerge.worktreeId !== worktreeId:
      return "merging";
    case openPendingUpdate(cur) !== undefined:
      return "updating";
    default:
      return null;
  }
}

/** `cur` carrying `merge`, or `cur` itself when {@link mergeRefusal} refuses it.
 *  Named in the networkMode guard's local `set` family, so the merge's mutationFn
 *  may call it bare. */
function setPendingMerge(cur: LocalPr, merge: PendingMerge): LocalPr {
  return mergeRefusal(cur, merge.worktreeId) === null
    ? { ...cur, pendingMerge: merge }
    : cur;
}

export type LocalPrMergeVars = {
  id: string;
  base: string;
  head: string;
  message: string;
  strategy: api.MergeStrategy;
};
/** A merge's outcome; `refused` names why the fresh record kept a conflicted
 *  merge out, leaving its worktree for the caller to discard. */
export type LocalPrMergeResult =
  | (api.LocalPrMergeOutcome & { refused: null })
  | (api.LocalPrMergeOutcome & { refused: MergeRefusal; worktreePath: string });

/** Merge a local PR in an isolated worktree. Keyed so the view's hold reads the
 *  cache, which outlives the view's own mount. The command waits out any
 *  resolve-worktree sweep in flight ({@link resolveSweeps}): a conflicted merge
 *  mints a worktree a pass's older keep-list would remove. A conflicted merge is
 *  recorded as the PR's `pendingMerge` before the mutation settles, so the sweep's
 *  next keep-list (read once no start is pending) already names its worktree.
 *  With `recordKey` (the list a caller shows), the mutation then awaits its
 *  re-read, like the update start; without one there is no list to wait for. */
export function useMergeLocalPr(repo: string, recordKey?: readonly unknown[]) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    async (args: LocalPrMergeVars): Promise<LocalPrMergeResult> => {
      await resolveSweeps.settled();
      const outcome = await api.gitMergeLocalPr(
        repo,
        args.base,
        args.head,
        args.message,
        args.strategy,
      );
      if (outcome.status === "merged") return { ...outcome, refused: null };
      const { worktreePath, worktreeId, opId } = outcome;
      if (!worktreePath || !worktreeId)
        throw new Error("Merge paused on conflicts but returned no worktree");
      const merge: PendingMerge = {
        base: args.base,
        head: args.head,
        strategy: args.strategy as PendingMerge["strategy"],
        message: args.message,
        worktreePath,
        worktreeId,
        opId,
        startedAt: new Date().toISOString(),
      };
      const reread = async () => {
        if (recordKey)
          await queryClient
            .invalidateQueries({ queryKey: recordKey })
            .catch(() => undefined);
      };
      let written: LocalPr;
      try {
        written = await updateLocalPr(repo, args.id, (cur) =>
          setPendingMerge(cur, merge),
        );
      } catch (e) {
        // No record names the new worktree, so nothing else would ever remove it.
        await api
          .gitAbortLocalPrMerge(repo, worktreePath, opId)
          .catch(() => undefined);
        await reread();
        throw e;
      }
      await reread();
      // `mergeRefusal`'s order over the record the write left, spelled inline
      // because the networkMode guard classifies no other bare callee here.
      const refused = ((): MergeRefusal | null => {
        switch (true) {
          case written.pendingMerge?.worktreeId === worktreeId:
            return null;
          case written.status !== "open":
            return "not-open";
          case !!written.pendingMerge?.worktreePath &&
            written.pendingMerge.worktreeId !== worktreeId:
            return "merging";
          default:
            return "updating";
        }
      })();
      return { ...outcome, worktreePath, refused };
    },
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("merge", repo),
    },
  );
}

/** Commits a paused local-PR merge once its conflicts are resolved in the worktree.
 *  Keyed so the resolve view holds by the write's own `worktreePath`. */
export function useFinishLocalPrMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      base: string;
      strategy: api.MergeStrategy;
      message: string;
      worktreePath: string;
      worktreeId: string;
      opId: string | null;
    }) =>
      api.gitFinishLocalPrMerge(
        repo,
        args.base,
        args.strategy,
        args.message,
        args.worktreePath,
        args.worktreeId,
        args.opId,
      ),
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("finish-merge", repo),
    },
  );
}

/** Rolls a paused local-PR merge back by deleting its isolated worktree. Keyed like
 *  {@link useFinishLocalPrMerge}. */
export function useAbortLocalPrMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: { worktreePath: string; opId: string | null }) =>
      api.gitAbortLocalPrMerge(repo, args.worktreePath, args.opId),
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("abort-merge", repo),
    },
  );
}

/** Merges the base into a remote PR's head branch in an isolated worktree, pushing the
 *  head when it comes out clean. Repo-wide invalidation is deliberate: a clean run moves
 *  the remote branch, so mergeability, the PR view and branch state all go stale.
 *  The variables name the PR, so the view holds each PR's resolve on its own. Only a
 *  `pushed` outcome sent anything, so only it arms the run recheck. */
export function useMergeRemotePr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: { number: number; base: string; head: string; message?: string }) =>
      api.gitMergeRemotePr(
        repo,
        args.number,
        args.base,
        args.head,
        args.message ?? null,
        lens,
      ),
    {
      identity: prWriteKey("resolve-merge", repo),
      onSuccess: (data, args) => {
        if (data.status === "pushed")
          recheckRunsAfterPush(
            queryClient,
            repo,
            prChecksRecheck(repo, lens, args.number),
          );
      },
    },
  );
}

/** Commits a paused remote-PR resolution and pushes the head branch; the run
 *  recheck gates on the outcome like {@link useMergeRemotePr}'s. Neither the
 *  variables nor the outcome name the PR, so the checks re-read covers every PR's
 *  details in the lens (only a PR whose view is on screen refetches now; the rest
 *  re-read when next opened). */
export function useFinishRemotePrResolve(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: {
      head: string;
      worktreePath: string;
      worktreeId: string;
      message?: string;
    }) =>
      api.gitFinishRemotePrResolve(
        repo,
        args.head,
        args.worktreePath,
        args.worktreeId,
        args.message ?? null,
        lens,
      ),
    {
      onSuccess: (data) => {
        if (data.status === "pushed")
          recheckRunsAfterPush(queryClient, repo, prChecksRecheck(repo, lens));
      },
    },
  );
}

/** Discards a paused remote-PR resolution by deleting its worktree. The variables
 *  name no PR, so the view holds this repo-wide. */
export function useAbortRemotePrResolve(repo: string) {
  return useRepoMutation(
    repo,
    (args: { worktreePath: string }) =>
      api.gitAbortRemotePrResolve(repo, args.worktreePath),
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: prWriteKey("abort-resolve", repo),
    },
  );
}

/** An unfinished resolve worktree for this PR (e.g. left by an earlier session), or
 *  null — feeds the banner's resume offer. Keyed by lens like every sibling PR key:
 *  the fork's #7 and the parent's #7 are different pull requests. */
export function useFindRemotePrResolve(
  repo: string,
  number: number | null,
  lens: RemoteLens,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr",
      lens,
      number ?? 0,
      "resolve-worktree",
    ] as const,
    queryFn: () => api.gitFindRemotePrResolve(repo, number ?? 0, lens),
    enabled: enabled && number !== null,
    staleTime: 5_000,
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

/** Every conflict prediction of `repo`, whatever its branches: the prefix
 *  {@link useConflictPreview} keys under, which merge writes invalidate. */
export const conflictPreviewKey = (repo: string) =>
  ["repo", repo, "conflict-preview"] as const;

/** One `base`/`head` prediction's exact key under {@link conflictPreviewKey}. */
export const conflictPreviewQueryKey = (
  repo: string,
  base: string,
  head: string,
) => [...conflictPreviewKey(repo), base, head] as const;

/** Pre-merge conflict prediction for a local PR's `base`/`head`, keyed under the
 *  repo so merge mutations invalidate it. Gate with `enabled`: its caller runs it
 *  for every open PR. */
export function useConflictPreview(
  repo: string,
  base: string,
  head: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: conflictPreviewQueryKey(repo, base, head),
    queryFn: () => api.gitConflictPreview(repo, base, head),
    enabled: enabled && base !== "" && head !== "",
    staleTime: 15_000,
    networkMode: "always",
  });
}

export type LocalPrUpdateStartVars = { id: string; base: string; head: string };
export type LocalPrUpdateFinishVars = {
  id: string;
  base: string;
  head: string;
  worktreePath: string;
  worktreeId: string;
  opId: string;
  journalRepo: string;
};
/** `id: null` when no record is left to clear (its pull request was deleted). */
export type LocalPrUpdateDiscardVars = {
  id: string | null;
  head: string;
  worktreePath: string;
  worktreeId: string;
  opId: string;
  journalRepo: string;
};
/** A start's result. `recordError`: the head moved but clearing the approval on the
 *  record failed, with that failure's message. */
export type LocalPrUpdateResult =
  | { status: "updated"; approvalCleared: boolean; recordError: string | null }
  | { status: "conflicts"; worktreeId: string };
export type LocalPrUpdateFinishResult = {
  status: "updated";
  approvalCleared: boolean;
};
export type LocalPrDiscardResult =
  | { status: "discarded" }
  | { status: "updated"; approvalCleared: boolean };

export const UPDATE_NOT_OPEN_MESSAGE =
  "This pull request is no longer open, so the update was discarded.";
export const UPDATE_ALREADY_UNFINISHED_MESSAGE =
  "This pull request already has an unfinished conflict resolution, so the new one was discarded.";
export const UPDATE_MERGE_PAUSED_MESSAGE =
  "This pull request has a paused merge to finish or abort first, so the new conflict resolution was discarded.";

/** Why a start's fresh record refused its new update. */
type UpdateRefusal = "not-open" | "merge-paused" | "already-unfinished";
/** What the refused update's discard answered; `kept` = it rejected. */
type RefusedDiscard = api.LocalPrDiscardOutcome["status"] | "kept";

/** Each refusal's words, by what the discard of the refused worktree did. */
export const UPDATE_REFUSED: Record<
  UpdateRefusal,
  Record<RefusedDiscard, string>
> = {
  "not-open": {
    discarded: UPDATE_NOT_OPEN_MESSAGE,
    updated:
      "This pull request is no longer open, and the update had already landed.",
    kept: "This pull request is no longer open, and the update couldn't be discarded, so it is still there.",
  },
  "merge-paused": {
    discarded: UPDATE_MERGE_PAUSED_MESSAGE,
    updated:
      "This pull request has a paused merge to finish or abort first, and the new conflict resolution had already landed.",
    kept: "This pull request has a paused merge to finish or abort first, and the new conflict resolution couldn't be discarded, so it is still there.",
  },
  "already-unfinished": {
    discarded: UPDATE_ALREADY_UNFINISHED_MESSAGE,
    updated:
      "This pull request already has an unfinished conflict resolution, and the new one had already landed.",
    kept: "This pull request already has an unfinished conflict resolution, and the new one couldn't be discarded, so it is still there.",
  },
};

export const MERGE_UPDATE_UNFINISHED_MESSAGE =
  "This pull request has an unfinished conflict resolution, so the paused merge was discarded.";
export const MERGE_UPDATE_ABORT_FAILED_NOTE =
  "This pull request has an unfinished conflict resolution, and the paused merge couldn't be discarded, so it is still there.";

/** `cur` carrying `update`, or `cur` itself when the fresh record is no longer open,
 *  already has an unfinished update, or has a paused merge (the two resolutions
 *  exclude each other). A malformed stored field is inert, so a real start overwrites
 *  it. Named in the networkMode guard's local `set` family, so the start's mutationFn
 *  may call it bare. */
function setPendingUpdate(cur: LocalPr, update: PendingUpdate): LocalPr {
  return cur.status === "open" &&
    openPendingUpdate(cur) === undefined &&
    !cur.pendingMerge?.worktreePath
    ? { ...cur, pendingUpdate: update }
    : cur;
}

/** The resolve-worktree sweeps in flight in this window, by checkout: each tracked
 *  pass covers its fresh list read, the worktree cleanup IPC and the journal-closer
 *  IPC. The stale-update discards run in a separate effect and are not tracked. An
 *  update start waits out every pass in this window, whatever checkout key it ran
 *  under, since every checkout of a repository shares those worktrees and records. */
const sweepsInFlight = new Map<string, Set<Promise<void>>>();

export const resolveSweeps = {
  /** Records `sweep` for `repo` until it settles. It must never reject. A newer pass
   *  never hides an older one still running. */
  track(repo: string, sweep: Promise<void>) {
    const running = sweepsInFlight.get(repo) ?? new Set<Promise<void>>();
    running.add(sweep);
    sweepsInFlight.set(repo, running);
    void sweep.then(() => {
      running.delete(sweep);
      if (running.size === 0 && sweepsInFlight.get(repo) === running)
        sweepsInFlight.delete(repo);
    });
  },
  /** Resolves once every sweep in flight now has settled. */
  settled: () =>
    Promise.all(
      [...sweepsInFlight.values()].flatMap((running) => [...running]),
    ).then(() => undefined),
};

/** Clears the approval on the fresh record after a clean update moved `head`. The
 *  branch already moved, so a failed write is reported by its message beside it,
 *  never thrown. Named in the networkMode guard's local `set` family, so the
 *  start's mutationFn may call it bare. */
async function setApprovalClearedAfterUpdate(
  repo: string,
  id: string,
): Promise<{ approvalCleared: boolean; recordError: string | null }> {
  let approvalCleared = false as boolean;
  try {
    await updateLocalPr(repo, id, (cur) => {
      approvalCleared = cur.approved;
      return cur.approved ? { ...cur, approved: false } : cur;
    });
    return { approvalCleared, recordError: null };
  } catch (e) {
    return { approvalCleared: false, recordError: errorMessage(e) };
  }
}

// Each update mutationFn below writes the record ITSELF and then awaits the re-read of
// `recordKey` (the caller's `localPrKey(repo)`) before it returns or rethrows: the
// mutation stays pending, and every hold that reads it stays up, until the list on
// screen shows the write. Callers add no invalidation of their own. Inside a
// mutationFn the only bare callees are `api.*`, `updateLocalPr`, this module's `set*`
// helpers (`setPendingUpdate`, `setApprovalClearedAfterUpdate`) and the start's local
// closures (`rejournal`, `reread`): the networkMode guard classifies the first three
// and passes closures a mutationFn declares.

/** Starts resolving a local PR's predicted conflicts: merges `base` INTO `head` in an
 *  isolated worktree. A clean merge moves `head` at once and clears the approval; a
 *  conflicted one is recorded as the PR's `pendingUpdate`, unless the fresh record is
 *  no longer open, already has one or has a paused merge, in which case the new
 *  worktree is discarded and the start rejects. The command waits out any
 *  resolve-worktree sweep in flight ({@link resolveSweeps}). */
export function useStartLocalPrUpdate(
  repo: string,
  recordKey: readonly unknown[],
) {
  const queryClient = useQueryClient();
  const previewKey = conflictPreviewKey(repo);
  const journalKey = oplogCheckOptions(repo).queryKey;
  return useRepoMutation(
    repo,
    async ({
      id,
      base,
      head,
    }: LocalPrUpdateStartVars): Promise<LocalPrUpdateResult> => {
      // Every path the command ran on re-reads the journal check before settling:
      // the recovery banner holds this op's entry back only while a start runs, so
      // a check read mid-start must not outlive it.
      const rejournal = () =>
        queryClient
          .invalidateQueries({ queryKey: journalKey })
          .catch(() => undefined);
      // A sweep mid-run holds a keep-list read before this start: it would remove
      // the new worktree or close its entry.
      await resolveSweeps.settled();
      const outcome = await api
        .gitUpdateLocalPrHead(repo, base, head)
        .catch(async (e: unknown) => {
          await rejournal();
          throw e;
        });
      const reread = (preview: boolean) =>
        Promise.all([
          queryClient
            .invalidateQueries({ queryKey: recordKey })
            .catch(() => undefined),
          preview
            ? queryClient
                .invalidateQueries({ queryKey: previewKey })
                .catch(() => undefined)
            : undefined,
          rejournal(),
        ]);
      if (outcome.status === "updated") {
        const cleared = await setApprovalClearedAfterUpdate(repo, id);
        await reread(true);
        return { status: "updated", ...cleared };
      }
      const { worktreePath, worktreeId, opId, journalRepo } = outcome;
      if (!worktreePath || !worktreeId) {
        await rejournal();
        throw new Error("Update paused on conflicts but returned no worktree");
      }
      const update: PendingUpdate = {
        base,
        head,
        worktreePath,
        worktreeId,
        opId,
        journalRepo,
        startedAt: new Date().toISOString(),
      };
      let refused = null as UpdateRefusal | null;
      let failure = null as unknown;
      try {
        const written = await updateLocalPr(repo, id, (cur) =>
          setPendingUpdate(cur, update),
        );
        if (written.pendingUpdate !== update)
          refused = (() => {
            switch (true) {
              case written.status !== "open":
                return "not-open";
              case !!written.pendingMerge?.worktreePath:
                return "merge-paused";
              default:
                return "already-unfinished";
            }
          })();
      } catch (e) {
        failure = e;
      }
      if (refused !== null || failure !== null) {
        const discard: RefusedDiscard = await api
          .gitDiscardLocalPrUpdate(
            repo,
            head,
            worktreePath,
            worktreeId,
            opId,
            journalRepo,
          )
          .then(
            (o) => o.status,
            () => "kept" as const,
          );
        await reread(false);
        throw refused !== null
          ? new Error(UPDATE_REFUSED[refused][discard])
          : failure;
      }
      await reread(false);
      return { status: "conflicts", worktreeId };
    },
    {
      // Local git and app-data write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("update-resolve", repo),
    },
  );
}

/** Finishes a paused update: commits the resolution and moves `head` to it, then
 *  clears the record's field (only when it still names this worktree) and its
 *  approval. Never touches `status` or `mergedAt`: the PR stays open. A record write
 *  that fails rejects the mutation, since the record would still name a consumed
 *  worktree. */
export function useFinishLocalPrUpdate(
  repo: string,
  recordKey: readonly unknown[],
) {
  const queryClient = useQueryClient();
  const previewKey = conflictPreviewKey(repo);
  return useRepoMutation(
    repo,
    async (
      vars: LocalPrUpdateFinishVars,
    ): Promise<LocalPrUpdateFinishResult> => {
      const outcome = await api.gitFinishLocalPrUpdate(
        repo,
        vars.base,
        vars.head,
        vars.worktreePath,
        vars.worktreeId,
        vars.opId,
        vars.journalRepo,
      );
      if (outcome.status !== "updated")
        throw new Error(
          `Couldn't finish this update; ${vars.head} was not updated.`,
        );
      try {
        let approvalCleared = false as boolean;
        await updateLocalPr(repo, vars.id, (cur) => {
          approvalCleared = cur.approved;
          return {
            ...cur,
            approved: false,
            pendingUpdate:
              cur.pendingUpdate?.worktreeId === vars.worktreeId
                ? undefined
                : cur.pendingUpdate,
          };
        });
        return { status: "updated", approvalCleared };
      } finally {
        await Promise.all([
          queryClient
            .invalidateQueries({ queryKey: recordKey })
            .catch(() => undefined),
          queryClient
            .invalidateQueries({ queryKey: previewKey })
            .catch(() => undefined),
        ]);
      }
    },
    {
      // Local git and app-data write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("finish-update", repo),
    },
  );
}

/** Discards a paused update: removes its worktree and clears the record's field when
 *  it still names that worktree (`id: null` writes no record). The command answers
 *  `updated` when the update had in fact landed; the approval is then cleared as a
 *  finish would. Moves no branch, so only local queries are invalidated. */
export function useDiscardLocalPrUpdate(
  repo: string,
  recordKey: readonly unknown[],
) {
  const queryClient = useQueryClient();
  const previewKey = conflictPreviewKey(repo);
  return useRepoMutation(
    repo,
    async (vars: LocalPrUpdateDiscardVars): Promise<LocalPrDiscardResult> => {
      const outcome = await api.gitDiscardLocalPrUpdate(
        repo,
        vars.head,
        vars.worktreePath,
        vars.worktreeId,
        vars.opId,
        vars.journalRepo,
      );
      const landed = outcome.status === "updated";
      try {
        let approvalCleared = false as boolean;
        if (vars.id !== null)
          await updateLocalPr(repo, vars.id, (cur) => {
            if (cur.pendingUpdate?.worktreeId !== vars.worktreeId) return cur;
            approvalCleared = landed && cur.approved;
            return {
              ...cur,
              pendingUpdate: undefined,
              approved: landed ? false : cur.approved,
            };
          });
        return landed
          ? { status: "updated", approvalCleared }
          : { status: "discarded" };
      } finally {
        await Promise.all([
          queryClient
            .invalidateQueries({ queryKey: recordKey })
            .catch(() => undefined),
          // A landed update moved the head, which the strip's prediction reads.
          landed
            ? queryClient
                .invalidateQueries({ queryKey: previewKey })
                .catch(() => undefined)
            : undefined,
        ]);
      }
    },
    {
      // Local git and app-data write — never park it offline.
      networkMode: "always",
      localOnly: true,
      identity: localPrWriteKey("discard-update", repo),
    },
  );
}

/** Filter prefix for every local-PR update start, under any checkout key. */
export const LOCAL_PR_UPDATE_START_KEY = [
  ...LOCAL_PR_WRITES_KEY,
  "update-resolve",
] as const;

/** Filter prefix for every into-base local-PR merge start, under any checkout key. */
export const LOCAL_PR_MERGE_START_KEY = [
  ...LOCAL_PR_WRITES_KEY,
  "merge",
] as const;

/** The starts that mint a `gd-resolve-*` worktree, which the sweep's keep-list must
 *  postdate. */
export const RESOLVE_WORKTREE_START_KEYS = [
  LOCAL_PR_UPDATE_START_KEY,
  LOCAL_PR_MERGE_START_KEY,
] as const;

const anyUpdateStarting = (cache: MutationCache) =>
  cache.findAll({
    mutationKey: LOCAL_PR_UPDATE_START_KEY,
    status: "pending",
  }).length > 0;

/** Whether any start in {@link RESOLVE_WORKTREE_START_KEYS} is pending in `cache`. */
export const anyResolveWorktreeStarting = (cache: MutationCache) =>
  RESOLVE_WORKTREE_START_KEYS.some(
    (mutationKey) =>
      cache.findAll({ mutationKey, status: "pending" }).length > 0,
  );

/** Whether ANY local-PR update start is in flight in this window, under any checkout
 *  key: the recovery banner reads it. */
export function useAnyLocalPrUpdateStarting(): boolean {
  return useMutationCacheSnapshot(anyUpdateStarting, false);
}

/** Whether any update or merge start is in flight in this window, under any checkout
 *  key: the sweep's freshness gate reads it. */
export function useAnyResolveWorktreeStarting(): boolean {
  return useMutationCacheSnapshot(anyResolveWorktreeStarting, false);
}
