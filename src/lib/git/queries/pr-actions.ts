import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { dropDraftsByReviewIds } from "@/lib/pulls/pending-review-threads";
import * as api from "../api";
import type {
  ForgeUserRef,
  IssueDetails,
  PrDetails,
  PrThreadOut,
  RemoteLens,
  ReviewThreadOut,
} from "../types";
import { repoKeys } from "./core";
import {
  invalidateProjectBoards,
  useOptimisticCacheMutation,
  useRepoMutation,
} from "./internal";
import { prBaseDivergencePrefix, prReviewThreadsKey } from "./prs";

/** A merge/pull request's approval state — the approve/unapprove toggle's driver
 *  (GitLab + Bitbucket; GitHub approves via its Review menu, so `implemented.mrApprove`
 *  is false there). Pass `null` when the toggle isn't shown so the read doesn't fire;
 *  keyed under the "origin" lens segment (the lens switcher is GitHub-only). */
export function usePrApprovals(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", "origin", number ?? 0, "approvals"] as const,
    queryFn: () => api.forgePrApprovals(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useApprovePr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrApprove(repo, number, lens),
  );
}

/** A PR's task checklist (Bitbucket-only, gated on `implemented.prTasks`). Pass
 *  `null` when the panel isn't shown so the read doesn't fire (mirrors
 *  `usePrApprovals`). */
export function usePrTasks(repo: string, number: number | null) {
  return useQuery({
    queryKey: prTasksKey(repo, number ?? 0),
    queryFn: () => api.forgeBbPrTasks(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

// PR-task mutations invalidate the exact tasks key onSettled; the component patches its
// own local state optimistically (like toggleApproval), so no optimistic logic lives in
// the hooks. Bitbucket-only, so the key sits under the "origin" lens segment.
export const prTasksKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number, "tasks"] as const;

export function useCreatePrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the call and the tasks-key invalidation close over `repo`, and the PR
    // panel survives a repo switch — without the key a switch retargets the pending
    // create.
    mutationKey: ["create-pr-task", repo],
    mutationFn: (args: { number: number; text: string }) =>
      api.forgeBbPrTaskCreate(repo, args.number, args.text),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useEditPrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string; text: string }) =>
      api.forgeBbPrTaskEdit(repo, args.number, args.taskId, args.text),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useSetPrTaskState(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string; resolved: boolean }) =>
      api.forgeBbPrTaskSetState(repo, args.number, args.taskId, args.resolved),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useDeletePrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string }) =>
      api.forgeBbPrTaskDelete(repo, args.number, args.taskId),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useUnapprovePr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrUnapprove(repo, number),
  );
}

/** Request changes on an MR with an optional comment (GitLab + Bitbucket, gated
 *  on `implemented.mrRequestChanges`). The caller patches the approvals cache
 *  optimistically, like the approve toggle. */
export function useRequestChangesPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (args: { number: number; body: string }) =>
    api.forgePrRequestChanges(repo, args.number, args.body, lens),
  );
}

/** Revoke the viewer's requested-changes state (Bitbucket-only — its revoke works
 *  on every plan, so the request-changes control toggles there). Same
 *  caller-patches-optimistically contract as `useRequestChangesPr`. */
export function useUnrequestChangesPr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrUnrequestChanges(repo, number),
  );
}

/** Delete the viewer's unfinished (PENDING) review, dropping it from the cached PR
 *  details optimistically so the notice strip goes at once. The review-threads cache
 *  is patched in the same breath: the feed hides that review's drafts by matching them
 *  against the PENDING review, so dropping only the review would flash the drafts in as
 *  ordinary comments until the settle refetch lands. Rollback is field-scoped on the
 *  details key (only `reviews`, so a concurrent assignee-set survives); the threads key
 *  holds nothing else, so it restores whole. GitHub-only — no other provider models a
 *  pending review. */
export function useDiscardPendingReview(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; reviewId: string }) =>
      api.ghPrDiscardPendingReview(repo, args.reviewId),
    onMutate: async (args) => {
      // An "" id would hand dropDraftsByReviewIds a set member its contract bans;
      // skipping the patch keeps the caches whole while the backend rejects the call.
      if (!args.reviewId) return;
      const key = ["repo", repo, "pr", lens, args.number] as const;
      const threadsKey = prReviewThreadsKey(repo, args.number, lens);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: key }),
        queryClient.cancelQueries({ queryKey: threadsKey }),
      ]);
      const prev = queryClient.getQueryData<PrDetails>(key);
      const prevThreads =
        queryClient.getQueryData<ReviewThreadOut[]>(threadsKey);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d
          ? { ...d, reviews: d.reviews.filter((r) => r.id !== args.reviewId) }
          : d,
      );
      queryClient.setQueryData<ReviewThreadOut[]>(threadsKey, (list) =>
        list ? dropDraftsByReviewIds(list, new Set([args.reviewId])) : list,
      );
      return { key, threadsKey, prevReviews: prev?.reviews, prevThreads };
    },
    onError: (_e, _args, ctx) => {
      if (ctx === undefined) return;
      // Locals, not `ctx.x`: a property read doesn't stay narrowed inside the
      // updater closure below.
      const { key, threadsKey, prevReviews, prevThreads } = ctx;
      if (prevReviews !== undefined) {
        queryClient.setQueryData<PrDetails>(key, (cur) =>
          cur ? { ...cur, reviews: prevReviews } : cur,
        );
      }
      if (prevThreads !== undefined) {
        queryClient.setQueryData(threadsKey, prevThreads);
      }
    },
    // Prefix-matches the threads key too, so one invalidate reconciles both.
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "pr", lens, args.number],
      }),
  });
}

/** Toggle a PR/MR's draft state both ways on all three providers. `lens` threads the
 *  fork identity through to the GitHub arm. Optimistically patches `isDraft` with
 *  field-scoped rollback so the badge flips instantly; the repo-wide invalidate on
 *  settle reconciles server truth and refreshes the merge gate. */
export function useSetPrDraft(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; draft: boolean }) =>
      api.forgePrSetDraft(repo, args.number, args.draft, lens),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, isDraft: args.draft } : d,
      );
      // Field-scoped rollback: capture only the isDraft we flipped, not the whole
      // PrDetails, so a failed draft-set doesn't revert a concurrent
      // assignee/reviewer-set sharing this PR key.
      return { key, prevIsDraft: prev?.isDraft };
    },
    onError: (_e, _args, ctx) => {
      const prevIsDraft = ctx?.prevIsDraft;
      const key = ctx?.key;
      if (prevIsDraft === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, isDraft: prevIsDraft } : cur,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** The reviewer picker's candidates (Bitbucket: workspace members minus the user the
 *  server would reject). For an existing PR pass its number (excludes the PR author);
 *  at create time pass `null` (no PR yet — excludes the viewer), keyed on "create".
 *  Fetched only while the picker is enabled — the popover is the sole consumer. */
export function useReviewerCandidates(
  repo: string,
  number: number | null,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr",
      lens,
      number ?? "create",
      "reviewer-candidates",
    ] as const,
    queryFn: () => api.forgePrReviewerCandidates(repo, number, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Replace an MR's reviewer list (all three providers, `implemented.mrReviewers`) with
 *  an optimistic PR-details patch + field-scoped rollback. The list is the picker's
 *  HUMAN set; bot/team requests never travel through it (preserved provider-side). */
export function useSetPrReviewers(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; reviewers: ForgeUserRef[] }) =>
      api.forgePrSetReviewers(
        repo,
        args.number,
        args.reviewers.map((r) => r.id),
        lens,
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, reviewers: args.reviewers } : d,
      );
      // Field-scoped rollback: capture only the reviewers we replaced, not the
      // whole PrDetails, so a failed reviewer-set doesn't revert a concurrent
      // assignee-set sharing this PR key.
      return { key, prevReviewers: prev?.reviewers };
    },
    onError: (_e, _args, ctx) => {
      const prevReviewers = ctx?.prevReviewers;
      const key = ctx?.key;
      if (prevReviewers === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, reviewers: prevReviewers } : cur,
      );
    },
    // The list pair rides along because a mine-axis filter (assigned/review
    // requested/teams) is evaluated SERVER-side and `updatedAt` feeds the review
    // buckets, so a detail-only reconcile leaves both surfaces describing a PR the
    // next fetch would sort or drop differently. Same reasoning at every mutation
    // below that touches those fields.
    onSettled: (_d, _e, args) =>
      Promise.all(
        [
          ["repo", repo, "pr", lens, args.number],
          ["repo", repo, "pr-list", lens],
          ["repo", repo, "pr-review-state", lens],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
  });
}

/** Set a PR/MR's assignees (GitHub + GitLab, gated on `implemented.mrAssignees`) with an
 *  optimistic PR-details patch + field-scoped rollback — the CLI spawns a process per
 *  call, so waiting on the round trip is visible. */
export function useSetPrAssignees(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeMrSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
        lens,
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, assignees: args.assignees } : d,
      );
      // Field-scoped rollback: capture only the assignees we replaced, not the
      // whole PrDetails, so a failed assignee-set doesn't revert a concurrent
      // reviewer-set sharing this PR key.
      return { key, prevAssignees: prev?.assignees };
    },
    onError: (_e, _args, ctx) => {
      const prevAssignees = ctx?.prevAssignees;
      const key = ctx?.key;
      if (prevAssignees === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, assignees: prevAssignees } : cur,
      );
    },
    // Assignees are a filter axis; see useSetPrReviewers's settle note. This
    // settle is SCOPED (three keys, not the repo subtree), so the board needs
    // naming explicitly — assignee avatars ride every card.
    onSettled: (_d, _e, args) => {
      invalidateProjectBoards(queryClient, repo);
      return Promise.all(
        [
          ["repo", repo, "pr", lens, args.number],
          ["repo", repo, "pr-list", lens],
          ["repo", repo, "pr-review-state", lens],
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

export function useMergePr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    async (args: {
      number: number;
      strategy: api.MergeStrategy;
      deleteBranch: boolean;
      /** GitLab stale-view guard (the MR head sha); GitHub ignores it. */
      sha?: string;
    }) => {
      const outcome = await api.forgePrMerge(
        repo,
        args.number,
        args.strategy,
        args.deleteBranch,
        args.sha,
        lens,
      );
      // The remote advanced but the local repo is now stale (ahead/behind, history,
      // tracking refs). Kick off a background pruning fetch so they catch up —
      // NOT awaited, so the merge toast fires the moment the call resolves, and
      // silent: the forge already accepted the merge (landed or queued), so a fetch
      // failure toast would misreport it (header Fetch stays the manual fallback).
      // The mutation's own invalidation refreshes the forge-side PR state.
      void api
        .gitFetch(repo)
        .then(() =>
          queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
        )
        .catch(() => undefined);
      return outcome;
    },
  );
}

/** What an update-branch makes stale on the PR side: the PR subtree (details and its
 *  commits/files/checks rollup, mergeability, diff, review threads), the rows that
 *  carry PR state, and the review-state map those rows group by (the new commit moves
 *  this PR's `updatedAt`). Exported because the set has to run TWICE — once when the
 *  forge accepts the job, and again once the poll sees the head actually move, since
 *  the first pass reads a head that has not shifted yet. */
export const prUpdateBranchKeys = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  [
    ["repo", repo, "pr", lens, number],
    ["repo", repo, "pr-list", lens],
    ["repo", repo, "pr-review-state", lens],
    ["repo", repo, "prs", lens],
  ] as const;

/** Merge (or rebase) the base branch into a PR's head — GitHub's "Update branch".
 *  GitHub QUEUES the work and answers 202, so resolving means accepted, not done —
 *  `usePrBaseDivergence.awaitUpdate` is what waits for the head to move, and the caller
 *  re-runs `prUpdateBranchKeys` once it has. Only the remote moved, so this pass is
 *  narrow: those keys plus the divergence key by name (it is a sibling of the PR
 *  subtree, not a child). Keyed off the args like the label mutation, which
 *  `useRepoMutation`'s static option can't do. */
export function usePrUpdateBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; rebase: boolean; lens: RemoteLens }) =>
      api.ghPrUpdateBranch(repo, args.number, args.rebase, args.lens),
    onSettled: (_d, _e, args) => {
      const keys: QueryKey[] = [
        ...prUpdateBranchKeys(repo, args.number, args.lens),
        prBaseDivergencePrefix(repo, args.number),
      ];
      return void Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

/** Approve a workflow run GitHub is holding for maintainer approval (a first-time
 *  contributor's fork PR). Invalidates the Actions subtree like re-run/cancel, plus
 *  the PR subtree — the PR checks list renders these runs off PR details. */
export function useApproveWorkflowRun(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // `lens` is optional because the Actions tab is origin-scoped by design;
    // the PR checks strip renders under either lens and must pass its own.
    mutationFn: (args: { runId: number; lens?: RemoteLens }) =>
      api.forgeCiRunApprove(repo, args.runId, args.lens),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["repo", repo, "actions"] });
      queryClient.invalidateQueries({ queryKey: ["repo", repo, "pr"] });
      // `pr-ci` is a SIBLING key, not a child of `pr` — prefix matching compares
      // segments whole, so the line above never reaches the PR list's CI badges.
      queryClient.invalidateQueries({ queryKey: ["repo", repo, "pr-ci"] });
    },
  });
}

/** GitLab pipeline statuses that count as "in flight" — the auto-merge affordance
 *  is only offered while a pipeline hasn't settled, and the merge-state poll runs
 *  fast while one is running. Both the view and this query classify against it. */
export const PIPELINE_IN_FLIGHT = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
] as const;

/** A GitLab MR's merge/auto-merge state — the auto-merge dropdown + "auto-merge
 *  enabled" footer. Pass `null` when auto-merge isn't shown so the read doesn't fire.
 *  Polls because the merge fires SERVER-side once the pipeline passes and neither the
 *  pipeline completing nor the auto-merge emits a client event: fast while armed or a
 *  pipeline is in flight, slow otherwise. */
export function useGlMrMergeState(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number ?? 0, "gl-merge-state"] as const,
    queryFn: () => api.forgeGlMrMergeState(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return d.autoMergeEnabled ||
        (PIPELINE_IN_FLIGHT as readonly string[]).includes(d.pipelineStatus)
        ? 8_000
        : 30_000;
    },
    refetchIntervalInBackground: false,
  });
}

/** Arm auto-merge (merge-when-pipeline-succeeds) on a GitLab MR. Default repo-wide
 *  invalidation is deliberate: an arm can race into an immediate merge when the
 *  pipeline just passed, so the whole MR view must refresh. */
export function useGlArmAutoMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      strategy: api.MergeStrategy;
      deleteBranch: boolean;
      /** Stale-view guard (the MR head sha) — GitLab 409s if the head moved. */
      sha?: string;
    }) =>
      api.forgeGlMrAutoMerge(
        repo,
        args.number,
        args.strategy,
        args.deleteBranch,
        args.sha,
      ),
  );
}

export function useGlCancelAutoMerge(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgeGlMrCancelAutoMerge(repo, number),
  );
}

/** Remove a GitLab project's fork relationship (detach from the fork network) —
 *  GitLab-only. Deliberately does NO cache patching or invalidation: `isFork` is
 *  forge truth that only flips via a re-probe, so the Danger-zone call site owns
 *  the post-success `probeAndPersistVisibility` + settings invalidation. */
export function useGlRemoveForkRelationship(repo: string) {
  return useMutation({
    mutationFn: () => api.forgeGlRemoveForkRelationship(repo),
  });
}

export function useClosePr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrClose(repo, number, lens),
  );
}

export function useReopenPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrReopen(repo, number, lens),
  );
}

/**
 * Optimistic edit/delete of a flat conversation comment on a PR/issue detail cache, with
 * exact-key rollback (a glab round trip is ~2-4s). Only the flat `comments` array is
 * touched; inline review threads live in a separate query and aren't editable here.
 * `kind` selects the detail subtree ("pr" | "issue").
 */
function useOptimisticCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  kind: "pr" | "issue",
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, PrDetails | IssueDetails>(
    mutationFn,
    (args) => ["repo", repo, kind, lens, args.number] as const,
    (d, args) =>
      d
        ? {
            ...d,
            comments: d.comments.flatMap((c) => {
              if (c.id !== args.commentId) return [c];
              const patched = patchComment(c, args);
              return patched ? [patched] : [];
            }),
          }
        : d,
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditPrComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgePrEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeletePrComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgePrDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

export function useEditIssueComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgeIssueEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeleteIssueComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgeIssueDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

/**
 * Optimistic edit/delete one level down (thread → comments) in the review-threads cache,
 * with exact-key rollback; a delete that empties a thread drops the thread. `commentId`
 * is unique across threads (provider comment ids), so no threadId is needed.
 */
function useOptimisticReviewCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, ReviewThreadOut[]>(
    mutationFn,
    (args) => prReviewThreadsKey(repo, args.number, lens),
    (threads, args) =>
      threads?.flatMap((t) => {
        if (!t.comments.some((c) => c.id === args.commentId)) return [t];
        const comments = t.comments.flatMap((c) => {
          if (c.id !== args.commentId) return [c];
          const patched = patchComment(c, args);
          return patched ? [patched] : [];
        });
        // A delete that empties the thread drops the whole card (server does too).
        return comments.length === 0 ? [] : [{ ...t, comments }];
      }),
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditReviewComment(repo: string, lens: RemoteLens) {
  return useOptimisticReviewCommentMutation(
    repo,
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgePrEditReviewComment(
        repo,
        args.number,
        args.commentId,
        args.body,
      ),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeleteReviewComment(repo: string, lens: RemoteLens) {
  return useOptimisticReviewCommentMutation(
    repo,
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgePrDeleteReviewComment(repo, args.number, args.commentId),
    () => null,
  );
}

export function useMinimizeComment(repo: string) {
  return useRepoMutation(
    repo,
    (args: { commentId: string; classifier: api.MinimizeReason }) =>
      api.ghPrMinimizeComment(repo, args.commentId, args.classifier),
  );
}

export function useUnminimizeComment(repo: string) {
  return useRepoMutation(repo, (commentId: string) =>
    api.ghPrUnminimizeComment(repo, commentId),
  );
}

export function useCheckoutPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.ghPrCheckout(repo, number, lens),
  );
}
