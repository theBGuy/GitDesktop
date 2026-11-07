import {
  type UseQueryResult,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { reloadLocalPrs } from "@/lib/pulls/local";
import {
  REPO_SHELL_GC_TIME,
  REPO_SHELL_WARM_STALE_MS,
} from "@/lib/query-cache-times";
import { reloadReviewNotes } from "@/lib/review-notes/store";
import { useUiStore } from "@/lib/stores/ui";
import * as api from "../api";
import type { BranchRewriteStatus } from "../types";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";
import { localPrWriteKey } from "./pr-writes";
import { recheckListsLater } from "./push-writes";

/** Shared by the hook and the shell warm-up, so the branch menu's local list is
 *  cached before the menu first opens. */
export function branchesOptions(repo: string) {
  return {
    queryKey: repoKeys.branches(repo),
    queryFn: () => api.gitBranches(repo),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always" as const,
    staleTime: REPO_SHELL_WARM_STALE_MS,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

export function useBranches(repo: string) {
  return useQuery(branchesOptions(repo));
}

/** Shared by the hook and the shell warm-up, so the switcher's Remote group is
 *  cached before the menu first opens. Kept on the shell gcTime because the read
 *  shapes the open menu's layout. */
export function remoteBranchesOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "remote-branches"] as const,
    queryFn: () => api.gitRemoteBranches(repo),
    networkMode: "always" as const,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

/** How old a remote-branch list the hook (and the shell warm-up) may serve. Kept
 *  out of {@link remoteBranchesOptions} so an imperative fetch spreading the
 *  options keeps fetch-always semantics. */
export const REMOTE_BRANCHES_STALE_TIME = 30_000;

/** Branches that exist on a remote (reflecting the last fetch), for the switcher's
 *  "Remote" group. Callers gate `enabled` on need (the menu while it is open, the
 *  run gate while the branch has no upstream): an enabled observer re-runs an
 *  O(remote refs) `for-each-ref` on each stale focus and repo mutation. */
export function useRemoteBranches(repo: string, enabled = true) {
  return useQuery({
    ...remoteBranchesOptions(repo),
    enabled: enabled && Boolean(repo),
    staleTime: REMOTE_BRANCHES_STALE_TIME,
  });
}

export function useCheckoutBranch(repo: string) {
  return useRepoMutation(
    repo,
    (name: string) => api.gitCheckoutBranch(repo, name),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

export function useCheckoutRemoteBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { remote: string; name: string }) =>
      api.gitCheckoutRemoteBranch(repo, args.remote, args.name),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

export function useCreateBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      name: string;
      checkout: boolean;
      startPoint?: string;
      noTrack?: boolean;
    }) =>
      api.gitCreateBranch(
        repo,
        args.name,
        args.checkout,
        args.startPoint,
        args.noTrack,
      ),
    {
      // Pinned: the call and its invalidation close over `repo`, and the dialog
      // and panel hosts survive a repo switch — without the key the newly-live
      // repo's controls would read the pending create as busy.
      identity: ["create-branch", repo],
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

export function defaultBranchOptions(repo: string) {
  return {
    queryKey: ["repo", repo, "default-branch"] as const,
    queryFn: () => api.gitDefaultBranch(repo),
    networkMode: "always" as const,
    staleTime: REPO_SHELL_WARM_STALE_MS,
    gcTime: REPO_SHELL_GC_TIME,
  };
}

export function useDefaultBranch(repo: string) {
  return useQuery(defaultBranchOptions(repo));
}

export function useRenameBranch(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: { oldName: string; newName: string }) =>
      api.gitRenameBranch(repo, args.oldName, args.newName),
    {
      onSuccess: (_data, args) => {
        // Re-key the branch's commit draft before the status refetch reports the new
        // name, so the draft (and any generation streaming into it) survives.
        // Renames from outside the app (MCP, a terminal `git branch -m`) have no such
        // hook and still lose the draft when the ambient poll flips the key.
        useUiStore
          .getState()
          .migrateCommitDraft(repo, args.oldName, args.newName);
        // The backend moved the branch's reviewer note on disk as part of the rename;
        // reload the in-memory store BEFORE invalidating (the focus bridge's pattern in
        // App.tsx) so the Create-PR dialog reads the note under the new name without
        // waiting for a focus cycle. Fire-and-forget — this callback must stay sync.
        void reloadReviewNotes()
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ["review-notes"] }),
          )
          .catch(() => {
            // Best-effort: a failed reload just leaves the last known state.
          });
        // The same for the local pull requests the backend moved to the new name,
        // so an open local-PR view acts on the new head.
        void reloadLocalPrs()
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ["local-prs"] }),
          )
          .catch(() => {
            // Best-effort, as above.
          });
      },
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useSetBranchArchived(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; archived: boolean }) =>
      api.gitSetBranchArchived(repo, args.name, args.archived),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useDeleteBranch(repo: string) {
  return useRepoMutation(
    repo,
    (name: string) => api.gitDeleteBranch(repo, name),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Deletes a branch on its remote (`git push <remote> --delete`). Invalidates
 *  the remote-branches list (the row disappears), the local branches (their
 *  upstream may now be gone), and the PR rows across both lenses: GitHub closes a
 *  PR whose head branch is deleted asynchronously, so those rows are re-read once
 *  after a delay. The review-state map rides with the list (its co-invalidation
 *  contract); the CI and mergeability maps re-key on the new rows. */
export function useDeleteRemoteBranch(repo: string) {
  const queryClient = useQueryClient();
  const prListKeys = [
    repoKeys.prList(repo),
    repoKeys.prReviewState(repo),
    ["repo", repo, "prs"],
  ] as const;
  return useRepoMutation(
    repo,
    (args: { remote: string; name: string }) =>
      api.gitDeleteRemoteBranch(repo, args.remote, args.name),
    {
      invalidate: [
        ["repo", repo, "remote-branches"],
        repoKeys.branches(repo),
        ...prListKeys,
      ],
      onSuccess: () => recheckListsLater(queryClient, repo, prListKeys),
    },
  );
}

export function useMergeBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      branch: string;
      squash: boolean;
      noFf: boolean;
      strategy: api.MergeConflictStrategy;
    }) =>
      api.gitMerge(repo, args.branch, args.squash, args.noFf, args.strategy),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Predicts a merge's outcome (fast-forward / clean / conflict / …) in memory,
 *  for the merge picker. Strategy-aware — re-runs when the conflict strategy
 *  changes so the prediction matches what the merge will actually do. Enabled
 *  only while the picker is open with a branch. */
export function useMergePreview(
  repo: string,
  branch: string,
  strategy: api.MergeConflictStrategy,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "merge-preview", branch, strategy] as const,
    queryFn: () => api.gitMergePreview(repo, branch, strategy),
    enabled: enabled && branch !== "",
    staleTime: 15_000,
    networkMode: "always",
  });
}

export function useRebaseBranch(repo: string) {
  return useRepoMutation(
    repo,
    (branch: string) => api.gitRebase(repo, branch),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Rebases the current branch onto `newBase`, replaying only `oldBase..HEAD`
 *  (the "branched off the wrong branch" fix). Conflicts leave the rebase in
 *  progress for the conflict banner, exactly like {@link useRebaseBranch}. */
export function useRebaseOnto(repo: string) {
  return useRepoMutation(
    repo,
    (args: { newBase: string; oldBase: string }) =>
      api.gitRebaseOnto(repo, args.newBase, args.oldBase),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Ahead/behind of every local branch vs `base`. Gated on `enabled` (one
 *  for-each-ref spawn on Git 2.41+, else one rev-list per branch) and keyed
 *  under the repo so branch mutations invalidate it.
 *
 *  `staleTime` is per observer: the branch menu passes one so a reopen spawns
 *  nothing, while CleanupBranchesDialog leaves it unset because its
 *  ahead-0/behind>0 pre-check pre-selects rows for `git branch -D` and must
 *  refetch on open. A window is safe because every in-app ref move made from
 *  this checkout invalidates this key (scripts/divergence-invalidation.test.mjs
 *  guards the writers that pass their own keys). Accepted residual: a move this
 *  checkout didn't make that leaves its HEAD alone (terminal `branch -f`,
 *  `push . x:y`, any write from a sibling worktree, in-app ones too) stays stale
 *  up to the window, and Cleanup may paint it until its refetch. */
export function useBranchDivergence(
  repo: string,
  base: string | null,
  enabled: boolean,
  staleTime?: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "divergence", base] as const,
    queryFn: () => api.gitBranchDivergence(repo, base ?? ""),
    enabled: enabled && Boolean(base),
    // Local git reads only. react-query's default "online" mode parks the
    // fetch whenever the OS reports no connection, and a parked query is neither
    // loading nor errored — consumers would silently render without divergence.
    networkMode: "always",
    ...(staleTime === undefined ? {} : { staleTime }),
  });
}

/** Merge `base` into `branch`. Filed with the local-PR writes because the local PR
 *  view holds its Update branch on any running one, from whichever surface fired it. */
export function useUpdateBranchFrom(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: { branch: string; base: string }) =>
      api.gitUpdateBranchFrom(repo, args.branch, args.base),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("update-from", repo),
      // The default invalidation covers only this repo; an update run inside the
      // holder moved that checkout too. Git reports it forward-slashed, a window
      // opened on it keys validate_repo's backslashed form (state.rs), so both
      // are invalidated; on POSIX the backslashed one matches nothing.
      onSuccess: (data) => {
        if (!data.holder) return;
        for (const key of new Set([
          data.holder,
          data.holder.replace(/\//g, "\\"),
        ]))
          void queryClient.invalidateQueries({ queryKey: repoKeys.all(key) });
      },
    },
  );
}

/**
 * Whether a diverged branch's upstream was rewritten under it (a remote rebase
 * or force-push), and what a reset to that upstream would cost.
 *
 * LAZY on purpose: `enabled` must stay false unless a surface is actually facing
 * a diverged branch, so the ordinary in-sync path spawns no git. Keyed under the
 * repo, so a push's whole-subtree invalidation and a fetch or pull's local-only
 * one (this read is local) both refresh it. Local rev-list reads only —
 * `networkMode: "always"` keeps an offline OS from parking the query into a
 * permanent pending state, matching {@link useBranchDivergence}.
 */
export function useBranchRewriteStatus(
  repo: string,
  branch: string | null,
  opts: { enabled: boolean },
) {
  return useQuery({
    ...branchRewriteStatusOptions(repo, branch ?? ""),
    enabled: opts.enabled && Boolean(branch),
  });
}

/** The one options object behind {@link useBranchRewriteStatus}. Exported so an
 *  IMPERATIVE probe — a palette action that has to decide before it acts, with no
 *  render to hang a hook on — reads and caches exactly what the hook would, rather
 *  than a second spelling that can drift from it. */
export function branchRewriteStatusOptions(repo: string, branch: string) {
  return {
    queryKey: [...repoKeys.rewriteStatus(repo), branch] as const,
    queryFn: () => api.gitBranchRewriteStatus(repo, branch),
    staleTime: 30_000,
    networkMode: "always" as const,
  };
}

/** Whether a rewrite status proves the upstream already carries every local
 *  commit, with both tips measured: the pair, never the reflog verdict alone,
 *  is what may unlock a reset to the upstream (unique local work would be lost).
 *  Every reset-to-upstream offer and confirm reads this one predicate. */
export const carriesAllLocalCommits = (
  d: BranchRewriteStatus | null | undefined,
): d is BranchRewriteStatus & { upstreamTip: string; localTip: string } =>
  d?.remoteRewritten === true &&
  d.localOnly === 0 &&
  Boolean(d.upstreamTip) &&
  Boolean(d.localTip);

/** Points a NON-current branch at its upstream's tip, refusing if that upstream
 *  moved away from `expectedTip`, or the branch away from `expectedLocalTip`,
 *  since the caller measured them. The current branch takes commit-ops.ts's
 *  `useHardResetToCommit` instead — only that moves the working tree with it. */
export function useBranchResetToUpstream(repo: string) {
  return useRepoMutation(
    repo,
    (args: { branch: string; expectedTip: string; expectedLocalTip: string }) =>
      api.gitBranchResetToUpstream(
        repo,
        args.branch,
        args.expectedTip,
        args.expectedLocalTip,
      ),
    {
      // Local branch write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Content checks in flight app-wide: each runs git one to five times (a tip
 *  that no longer resolves stops after one rev-parse; a clean verdict adds a
 *  merge-base read, and a content merge two more), and one open checks every
 *  listed branch (150+ in real repos). */
const CONTENT_CHECK_SLOTS = 4;

/** FIFO slot queue. A queued acquire rejects with the abort reason, so a
 *  cancelled check never starts; an acquired slot ignores abort, because invoke
 *  can't be cancelled and the slot frees only when it settles. */
function slotQueue(size: number) {
  let free = size;
  const waiters: (() => void)[] = [];
  return {
    acquire(signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (free > 0) {
        free--;
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener("abort", drop);
          resolve();
        };
        const drop = () => {
          const at = waiters.indexOf(grant);
          if (at !== -1) waiters.splice(at, 1);
          reject(signal.reason);
        };
        waiters.push(grant);
        signal.addEventListener("abort", drop, { once: true });
      });
    },
    release() {
      const next = waiters.shift();
      if (next) next();
      else free++;
    },
  };
}

const contentCheckSlots = slotQueue(CONTENT_CHECK_SLOTS);

/** An in-flight check is cancelled and reverted when its last observer leaves
 *  (the queryFn reads the abort signal), and a latched answer returns without
 *  git, so this only keeps a landed answer across a brief observer gap. The
 *  close or epoch change drops the open's entries itself. */
const CONTENT_CHECK_GC_TIME = 5 * 60_000;

// Minted only inside a setState updater: the React Compiler would cache a
// call made directly in render, since it takes no reactive input.
let contentCheckEpoch = 0;
function nextContentCheckEpoch() {
  contentCheckEpoch += 1;
  return contentCheckEpoch;
}

interface ContentCheckOpen {
  epoch: number;
  repoPath: string;
  /** The default branch this open checks against; undefined until its read
   *  settles, then fixed for the open. */
  latched: string | null | undefined;
  /** The base this open's first settled read gave (null: none, or the read
   *  failed); undefined until then. A later refetch never moves it. */
  base: api.ContentCheckBase | null | undefined;
  /** Each branch's first settled check this open (null: it failed). A later
   *  refetch never moves one. */
  answers: ReadonlyMap<string, api.BranchContentMerged | null>;
}

const NO_ANSWERS: ReadonlyMap<string, api.BranchContentMerged | null> =
  new Map();

export interface BranchContentCheck {
  /** "unsupported": git < 2.38 (or a version that can't be read), no resolvable
   *  default branch, a failed base read (final for the open), or a configured
   *  merge driver or merge.default (or an unreadable config).
   *  "pending": the base or some requested verdict is still running.
   *  "settled": every requested branch has a verdict (unknown included). */
  status: "unsupported" | "pending" | "settled";
  base: api.ContentCheckBase | null;
  /** Landed verdicts by branch name; a requested branch missing here is still
   *  pending. */
  verdicts: ReadonlyMap<string, api.ContentVerdict>;
  /** Requested branches whose verdict hasn't landed yet. */
  pendingCount: number;
}

/**
 * Whether each of `branches` still carries content its repo's default branch
 * lacks, checked once per open (`enabled` false→true) against the newer of the
 * default branch and its remote-tracking counterpart.
 *
 * `defaultBranch` is undefined ONLY while its read loads; pass null once it
 * settled with none or failed ("unsupported", final for the open). Keys sit
 * outside `["repo", repoPath]` and carry a per-open epoch, so no repo
 * invalidation or refocus refetches a verdict mid-open and an earlier open's
 * data never lands in this one. The open is decided during render, so the
 * first commit after an enable edge or a repo switch already shows nothing
 * landed. Closing cancels queued checks and drops the open's cache entries.
 */
export function useBranchContentCheck(
  repoPath: string,
  defaultBranch: string | null | undefined,
  branches: readonly string[],
  enabled: boolean,
): BranchContentCheck {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<ContentCheckOpen | null>(null);
  // Render-time adjust: an effect would commit one render that still serves
  // the previous open to consumers' effects.
  if (enabled && (open === null || open.repoPath !== repoPath)) {
    setOpen((prev) =>
      prev !== null && prev.repoPath === repoPath
        ? prev
        : {
            epoch: nextContentCheckEpoch(),
            repoPath,
            latched: defaultBranch,
            base: undefined,
            answers: NO_ANSWERS,
          },
    );
  } else if (!enabled && open !== null) {
    setOpen(null);
  } else if (
    open !== null &&
    open.latched === undefined &&
    defaultBranch !== undefined
  ) {
    setOpen({ ...open, latched: defaultBranch });
  }
  const live =
    enabled && open !== null && open.repoPath === repoPath ? open : null;
  const latched = live?.latched;

  // Observers exist only while open, so a closed open's entries have none.
  const baseInputs =
    live !== null && typeof latched === "string"
      ? [{ repo: live.repoPath, epoch: live.epoch, defaultName: latched }]
      : [];
  const baseQuery = useQueries({
    queries: baseInputs.map(({ repo, epoch, defaultName }) => ({
      queryKey: ["content-merged", repo, epoch, "base", defaultName] as const,
      queryFn: () => api.gitContentCheckBase(repo, defaultName),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: CONTENT_CHECK_GC_TIME,
      retry: false,
      networkMode: "always" as const,
    })),
  })[0] as UseQueryResult<api.ContentCheckBase | null> | undefined;
  // A filterless invalidation (an account switch) still refetches the base, so
  // the open keeps its first settled answer: a failed or moved refetch must not
  // turn the open unsupported or re-key its verdicts.
  const settledBase = baseQuery?.isError ? null : baseQuery?.data;
  const landedBase = live?.base !== undefined ? live.base : settledBase;
  if (live !== null && live.base === undefined && settledBase !== undefined) {
    const epochNow = live.epoch;
    setOpen((prev) =>
      prev !== null && prev.epoch === epochNow && prev.base === undefined
        ? { ...prev, base: settledBase }
        : prev,
    );
  }
  const base = landedBase ?? null;

  const verdictQueries = useQueries({
    queries:
      live !== null && base !== null
        ? branches.map((branch) => ({
            queryKey: [
              "content-merged",
              live.repoPath,
              live.epoch,
              "verdict",
              base.sha,
              branch,
            ] as const,
            queryFn: async ({ signal }: { signal: AbortSignal }) => {
              const landed = live.answers.get(branch);
              if (landed === null)
                throw new Error("This branch's check already failed");
              if (landed !== undefined) return landed;
              await contentCheckSlots.acquire(signal);
              try {
                // A cancel can land between the grant and this continuation,
                // after the waiter stopped listening for it.
                if (signal.aborted) throw signal.reason;
                return await api.gitBranchContentMerged(
                  live.repoPath,
                  base.sha,
                  base.tree,
                  branch,
                );
              } finally {
                contentCheckSlots.release();
              }
            },
            staleTime: Number.POSITIVE_INFINITY,
            gcTime: CONTENT_CHECK_GC_TIME,
            retry: false,
            networkMode: "always" as const,
          }))
        : [],
  });
  // Latched like the base (`settledBase`/`landedBase`): a branch's first settled
  // answer is final for the open, and its queryFn hands it back without git, so
  // a filterless refetch never moves a verdict.
  let freshAnswers: Map<string, api.BranchContentMerged | null> | null = null;
  if (live !== null && base !== null) {
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i];
      const query = verdictQueries[i];
      if (query === undefined || live.answers.has(branch)) continue;
      const answer = query.data ?? (query.isError ? null : undefined);
      if (answer === undefined) continue;
      freshAnswers ??= new Map();
      freshAnswers.set(branch, answer);
    }
  }
  if (live !== null && freshAnswers !== null) {
    const epochNow = live.epoch;
    const landing = freshAnswers;
    setOpen((prev) => {
      if (prev === null || prev.epoch !== epochNow) return prev;
      const answers = new Map(prev.answers);
      for (const [branch, answer] of landing)
        if (!answers.has(branch)) answers.set(branch, answer);
      return { ...prev, answers };
    });
  }

  // Ended in an effect BODY on the close or epoch-change commit, never in a
  // cleanup: an <Activity> hide runs cleanups, and the open outlives a hide.
  // An unmount leaves the entries to age out by gcTime.
  const openRepo = live?.repoPath;
  const epoch = live?.epoch;
  const ended = useRef<{ repo: string; epoch: number } | null>(null);
  useEffect(() => {
    const prev = ended.current;
    ended.current =
      openRepo === undefined || epoch === undefined
        ? null
        : { repo: openRepo, epoch };
    if (prev === null || (prev.repo === openRepo && prev.epoch === epoch))
      return;
    void queryClient.cancelQueries({
      queryKey: ["content-merged", prev.repo, prev.epoch, "verdict"],
      fetchStatus: "fetching",
    });
    queryClient.removeQueries({
      queryKey: ["content-merged", prev.repo, prev.epoch],
    });
  }, [queryClient, openRepo, epoch]);

  // A name that leaves `branches` mid-open has its queued check cancelled.
  const requested = useRef<{
    epoch: number;
    baseSha: string;
    names: readonly string[];
  } | null>(null);
  const baseSha = base?.sha;
  useEffect(() => {
    const prev = requested.current;
    requested.current =
      epoch === undefined || baseSha === undefined
        ? null
        : { epoch, baseSha, names: branches };
    if (
      openRepo === undefined ||
      prev === null ||
      prev.epoch !== epoch ||
      prev.baseSha !== baseSha
    )
      return;
    const kept = new Set(branches);
    for (const name of prev.names) {
      if (kept.has(name)) continue;
      void queryClient.cancelQueries({
        queryKey: ["content-merged", openRepo, epoch, "verdict", baseSha, name],
        fetchStatus: "fetching",
      });
    }
  }, [queryClient, openRepo, epoch, baseSha, branches]);

  const verdicts = new Map<string, api.ContentVerdict>();
  if (live === null || latched === undefined)
    return {
      status: "pending",
      base: null,
      verdicts,
      pendingCount: branches.length,
    };
  if (latched === null || landedBase === null)
    return { status: "unsupported", base: null, verdicts, pendingCount: 0 };
  if (base === null)
    return {
      status: "pending",
      base: null,
      verdicts,
      pendingCount: branches.length,
    };
  let pendingCount = 0;
  for (const branch of branches) {
    const answer = live.answers.has(branch)
      ? live.answers.get(branch)
      : freshAnswers?.get(branch);
    if (answer === undefined) pendingCount++;
    // A failed check fails toward unknown, never toward merged.
    else verdicts.set(branch, answer?.verdict ?? "unknown");
  }
  return {
    status: pendingCount > 0 ? "pending" : "settled",
    base,
    verdicts,
    pendingCount,
  };
}
