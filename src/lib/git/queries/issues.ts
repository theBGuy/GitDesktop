import {
  type QueryClient,
  type QueryKey,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import * as api from "../api";
import type {
  ForgeUserRef,
  GitLabTimeStats,
  IssueDetails,
  IssueInfo,
  IssueReactions,
  IssueRelation,
  IssueType,
  Reaction,
  RemoteLens,
  RemoteListFilter,
} from "../types";
import { remoteListFilterKey } from "../types";
import { keepPreviousDataForKeyAxes, repoKeys } from "./core";
import { invalidateProjectBoards, useRepoMutation } from "./internal";

export function useIssueList(
  repo: string,
  enabled: boolean,
  state: api.IssueStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
) {
  return useQuery({
    // The filter key is APPENDED (index 6) so the existing axis indices — and the
    // positional axes list below — don't shift.
    queryKey: [
      ...repoKeys.issueList(repo),
      lens,
      state,
      limit ?? null,
      remoteListFilterKey(filter),
    ] as const,
    queryFn: () => api.forgeIssueList(repo, state, limit, lens, filter),
    enabled,
    staleTime: 30_000,
    // issuesDisabled is a permanent repo condition — retrying only delays the notice.
    // invalidArgument is the same story per scope (filter caps, magic values, GitLab's
    // walk horizon): the second walk reaches the same refusal at the same cost.
    retry: (failureCount, err) =>
      !(
        isAppError(err) &&
        (err.kind === "issuesDisabled" || err.kind === "invalidArgument")
      ) && failureCount < 1,
    // State, limit and filter stay free so a tab switch, "Load more" or a filter
    // change keeps the current rows instead of flashing skeletons, but lens must
    // match: a fork numbers issues independently of its parent, so another lens's
    // rows misdescribe the list and a click on one navigates to a different issue.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

export const issueDetailsOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  queryOptions({
    queryKey: ["repo", repo, "issue", lens, number] as const,
    queryFn: () => api.forgeIssueView(repo, number, lens),
    staleTime: 30_000,
  });

export function useIssueDetails(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...issueDetailsOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // Lens is an IDENTITY axis, like the PR details twin: a fork's two lenses
    // number their issues independently, so matching on repo alone would serve
    // the other lens's issue under this one's number. The number axis stays out
    // — a switch between issues keeps the previous one painted by design.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** Warms an issue's view so opening it from the list is instant (hover/adjacent
 *  rows), mirroring `usePrefetchPr` in prs.ts. */
export function usePrefetchIssue(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(issueDetailsOptions(repo, number, lens));
    },
    [queryClient, repo, lens],
  );
}

/**
 * Writes a just-created issue into the cached open list pages so the row is on
 * screen under the closing dialog, a full list round trip ahead of the
 * reconciling refetch that owns the authoritative row.
 *
 * Only UNFILTERED pages are written: whether a new issue matches an active
 * server-side filter is the server's answer to give, so those pages are left to
 * the invalidation. Within that, the match is deliberately wide — every cached
 * page size for this repo, lens and the open state, so a sibling observer
 * (relations, mention candidates, linked-issue chips) paints the row too.
 *
 * `repo`/`lens` must be the pair the create RAN under, which is why its mutation
 * pins them as its key — an issue number is meaningless in another repo or lens.
 */
function insertCreatedIssue(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  row: IssueInfo,
) {
  const pages = queryClient.getQueriesData<IssueInfo[]>({
    // `useIssueList`'s key, axis for axis: 3 = lens, 4 = state, 5 = limit,
    // 6 = the filter key. Lens is pinned because a fork numbers its issues
    // independently of its parent; state because "closed" is the only other
    // spelling and a new issue is never that; limit stays free so every page
    // size on screen is written.
    predicate: (q) =>
      q.queryKey[0] === "repo" &&
      q.queryKey[1] === repo &&
      q.queryKey[2] === "issue-list" &&
      q.queryKey[3] === lens &&
      q.queryKey[4] === "open" &&
      q.queryKey[6] === remoteListFilterKey(null),
  });
  for (const [key, rows] of pages) {
    // A refetch can land the real row first; a second copy would collide on the
    // number-keyed React key rather than merely duplicating.
    if (!rows || rows.some((r) => r.number === row.number)) continue;
    // Both providers return the unfiltered list newest-created first, so the new
    // issue belongs at the head — and trimming back to the page's own limit is
    // what the refetch returns anyway, keeping "Load more" (a `length === limit`
    // test) from blinking off while the page is momentarily one row over.
    const limit = key[5];
    const next = [row, ...rows];
    queryClient.setQueryData<IssueInfo[]>(
      key,
      typeof limit === "number" ? next.slice(0, limit) : next,
    );
  }
}

export function useCreateIssue(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: {
      title: string;
      body: string;
      labels: string[];
      assignees: string[];
      milestone: number | null;
      type: string | null;
    }) =>
      api.forgeIssueCreate(
        repo,
        args.title,
        args.body,
        args.labels,
        args.assignees,
        args.milestone,
        args.type,
        lens,
      ),
    {
      // Both the create call and the insert below close over `repo`/`lens`, and the
      // dialog family stays mounted across a repo switch — pinning them as the
      // mutation key is what detaches a pending create instead of retargeting it,
      // so a switch mid-create can't post to, or write a row into, another repo.
      identity: ["create-issue", repo, lens],
      // Runs before the invalidation fires, so the insert is what paints and the
      // refetch reconciles it. `author` stays null rather than guessing a login —
      // the row type allows it and every list consumer reads it optionally.
      onSuccess: (ref, args) => {
        const now = new Date().toISOString();
        insertCreatedIssue(queryClient, repo, lens, {
          number: ref.number,
          url: ref.url,
          title: args.title,
          state: "OPEN",
          createdAt: now,
          updatedAt: now,
          author: null,
          labels: args.labels.map((name) => ({ name })),
        });
      },
    },
  );
}

export function useAssignableUsers(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "assignable-users", lens] as const,
    queryFn: () => api.forgeAssignableUsers(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMilestones(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "milestones", lens] as const,
    queryFn: () => api.forgeMilestones(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Shallow-diff two objects, returning the keys whose value changed (`Object.is`).
 *  Lets an optimistic mutation capture exactly which fields it touched, so a
 *  rollback restores only those — never reverting a concurrent edit to a sibling
 *  field on the same cache entry. */
function changedKeys<T extends object>(prev: T, next: T): (keyof T)[] {
  const keys = new Set<keyof T>([
    ...(Object.keys(prev) as (keyof T)[]),
    ...(Object.keys(next) as (keyof T)[]),
  ]);
  return [...keys].filter((k) => !Object.is(prev[k], next[k]));
}

/** An issue meta mutation (assignee/milestone/type) with an optimistic patch of the
 *  issue-details cache + field-scoped rollback. The extra display fields callers pass
 *  (milestone title, the full type) exist only for that patch — the backend takes the
 *  id/name. */
function useOptimisticIssueMutation<TArgs extends { number: number }, TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patch: (issue: IssueDetails, args: TArgs) => IssueDetails,
  /** Keys beyond the issue's own detail subtree, for the fields a LIST filter can
   *  key on — membership is server-evaluated, so those lists must refetch. */
  extraKeys: QueryKey[] = [],
  /** Whether this field is drawn on a Projects BOARD card. Declared per call site
   *  rather than assumed for the whole helper: assignees ride a card, while
   *  milestone, issue type, due date and confidentiality do not. */
  boardCards = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (args: TArgs) => {
      const key = ["repo", repo, "issue", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<IssueDetails>(key);
      if (!prev) return { key, restore: undefined };
      const next = patch(prev, args);
      queryClient.setQueryData<IssueDetails>(key, next);
      // Field-scoped rollback: remember only the fields this patch changed, so
      // onError restores exactly those onto the CURRENT cache. A wholesale
      // snapshot restore would revert a concurrent field mutation on the same
      // issue (e.g. setMilestone landing while setAssignees is in flight).
      const restore: Partial<IssueDetails> = {};
      for (const k of changedKeys(prev, next)) {
        (restore as Record<string, unknown>)[k as string] = prev[k];
      }
      return { key, restore };
    },
    // Reporting lives HERE, not in each caller's `mutate` options: react-query
    // only runs mutate-scoped callbacks while the observer has listeners, and the
    // views re-key their metadata rail per entity — so a switch mid-flight would
    // roll the cache back with nothing said.
    onError: (e, _args, ctx) => {
      if (ctx?.restore) {
        queryClient.setQueryData<IssueDetails>(ctx.key, (cur) =>
          cur ? { ...cur, ...ctx.restore } : cur,
        );
      }
      toastError(e);
    },
    // Narrow reconciliation: only the one issue's detail subtree (not repo-wide),
    // scoped to the lens the mutation ran under, plus whatever list surface the
    // caller says this field decides membership on.
    onSettled: (_d, _e, args) => {
      if (boardCards) invalidateProjectBoards(queryClient, repo);
      return void Promise.all(
        [
          ["repo", repo, "issue", lens, args.number] as QueryKey,
          ...extraKeys,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

export function useSetIssueAssignees(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeIssueSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
        lens,
      ),
    (issue, args) => ({ ...issue, assignees: args.assignees }),
    // Assignee is a filter axis of the issue list ("Assigned to me"), and the server
    // decides membership — a detail-only reconcile leaves a filtered list showing a
    // row the next fetch would drop. No review-state sibling on the issue side.
    [[...repoKeys.issueList(repo), lens]],
    // Assignee avatars are drawn on every board card.
    true,
  );
}

export function useSetIssueMilestone(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: {
      number: number;
      milestone: number | null;
      /** Title for the optimistic chip (backend takes only the number). */
      title?: string | null;
    }) => api.forgeIssueSetMilestone(repo, args.number, args.milestone, lens),
    (issue, args) => ({
      ...issue,
      milestone:
        args.milestone === null
          ? null
          : { number: args.milestone, title: args.title ?? "" },
    }),
  );
}

/** Toggle an issue's GitLab-only confidential flag, with the optimistic
 *  cache patch every other issue-field mutation uses. GitLab-only, so it only
 *  ever runs under the origin lens (the switcher is GitHub-only). */
export function useSetIssueConfidential(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    "origin",
    (args: { number: number; confidential: boolean }) =>
      api.forgeGlIssueSetConfidential(repo, args.number, args.confidential),
    (issue, args) => ({ ...issue, confidential: args.confidential }),
  );
}

/** Set ("YYYY-MM-DD") or clear (null) an issue's GitLab-only due date. GitLab-only,
 *  so it only ever runs under the origin lens. */
export function useSetIssueDueDate(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    "origin",
    (args: { number: number; dueDate: string | null }) =>
      api.forgeGlIssueSetDueDate(repo, args.number, args.dueDate),
    (issue, args) => ({ ...issue, dueDate: args.dueDate }),
  );
}

// ── GitLab time tracking + related issues ────────────────────────────────────

// GitLab-only keys: the lens switcher is GitHub-only, so these always sit under the
// "origin" lens segment — nested inside the lens-scoped issue/MR detail subtree that
// repoKeys.all + the details refetch reconcile.
const issueTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number, "time-stats"] as const;

const mrTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number, "time-stats"] as const;

/** An issue's GitLab time-tracking stats (estimate + spent). Pass `null` when
 *  the section isn't shown so the read doesn't fire. */
export function useGlIssueTimeStats(repo: string, number: number | null) {
  return useQuery({
    queryKey: issueTimeStatsKey(repo, number ?? 0),
    queryFn: () => api.forgeGlIssueTimeStats(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** An MR's GitLab time-tracking stats. Pass `null` when the summary isn't shown. */
export function useGlMrTimeStats(repo: string, number: number | null) {
  return useQuery({
    queryKey: mrTimeStatsKey(repo, number ?? 0),
    queryFn: () => api.forgeGlMrTimeStats(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** A time-tracking write whose response IS the fresh {@link GitLabTimeStats}: write it
 *  straight into the stats key (no refetch), then invalidate the issue/MR view (the
 *  estimate surfaces elsewhere). `statsKey` picks issue vs MR; `viewKey` is the details
 *  query to nudge. */
function useTimeTrackingMutation(
  repo: string,
  statsKey: (repo: string, number: number) => readonly unknown[],
  viewKey: (repo: string, number: number) => readonly unknown[],
  mutationFn: (args: {
    number: number;
    duration: string | null;
  }) => Promise<GitLabTimeStats>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    // Mutation-level so the report survives the caller unmounting mid-flight (the
    // views re-key their rail per entity, and mutate-scoped callbacks stop firing
    // once the observer loses its listeners).
    onError: (e) => toastError(e),
    mutationFn,
    onSuccess: (stats, args) => {
      queryClient.setQueryData<GitLabTimeStats>(
        statsKey(repo, args.number),
        stats,
      );
      // `exact` — the stats key extends the view key, so a prefix invalidation
      // would mark the stats we just wrote stale and refetch them for nothing.
      queryClient.invalidateQueries({
        queryKey: viewKey(repo, args.number),
        exact: true,
      });
    },
  });
}

// GitLab-only time-tracking view keys — see issueTimeStatsKey: pinned to "origin".
const issueViewKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number] as const;

const mrViewKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number] as const;

export function useSetIssueTimeEstimate(repo: string) {
  return useTimeTrackingMutation(
    repo,
    issueTimeStatsKey,
    issueViewKey,
    (args) => api.forgeGlIssueSetTimeEstimate(repo, args.number, args.duration),
  );
}

export function useAddIssueSpentTime(repo: string) {
  return useTimeTrackingMutation(
    repo,
    issueTimeStatsKey,
    issueViewKey,
    (args) => api.forgeGlIssueAddSpentTime(repo, args.number, args.duration),
  );
}

export function useSetMrTimeEstimate(repo: string) {
  return useTimeTrackingMutation(repo, mrTimeStatsKey, mrViewKey, (args) =>
    api.forgeGlMrSetTimeEstimate(repo, args.number, args.duration),
  );
}

export function useAddMrSpentTime(repo: string) {
  return useTimeTrackingMutation(repo, mrTimeStatsKey, mrViewKey, (args) =>
    api.forgeGlMrAddSpentTime(repo, args.number, args.duration),
  );
}

// GitLab-only related-issue links key — pinned to "origin" (see issueTimeStatsKey).
const issueLinksKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number, "links"] as const;

/** An issue's GitLab related-issue links. Pass `null` when the section isn't
 *  shown so the read doesn't fire. */
export function useGlIssueLinks(repo: string, number: number | null) {
  return useQuery({
    queryKey: issueLinksKey(repo, number ?? 0),
    queryFn: () => api.forgeGlIssueLinks(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** Link this issue to another (relates_to). Links are symmetric server-side, so
 *  the target's own links list is invalidated too. */
export function useLinkIssue(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; targetNumber: number }) =>
      api.forgeGlIssueLink(repo, args.number, args.targetNumber),
    // Mutation-level: see useTimeTrackingMutation.
    onError: (e) => toastError(e),
    onSuccess: (_d, args) => {
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.number),
      });
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.targetNumber),
      });
    },
  });
}

/** Remove a related-issue link by its `linkId`. Invalidates the source's links;
 *  the other side is refreshed on its next open (its `linkId` differs). */
export function useUnlinkIssue(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; linkId: string }) =>
      api.forgeGlIssueUnlink(repo, args.number, args.linkId),
    // Mutation-level: see useTimeTrackingMutation.
    onError: (e) => toastError(e),
    onSuccess: (_d, args) =>
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.number),
      }),
  });
}

export function useIssueTypes(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue-types", lens] as const,
    queryFn: () => api.ghIssueTypes(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSetIssueType(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: {
      number: number;
      typeName: string | null;
      /** The full type for the optimistic patch (backend takes only the name). */
      type?: IssueType | null;
    }) => api.ghIssueSetType(repo, args.number, args.typeName, lens),
    (issue, args) => ({ ...issue, issueType: args.type ?? null }),
  );
}

/**
 * An issue-lifecycle write (close/reopen/edit/pin/lock/transfer/delete) that reconciles
 * NARROWLY instead of whole-repo: the one issue's detail subtree (prefix-matched, so its
 * reactions/relations/dependencies/development sub-queries refresh too) plus every
 * issue-list state variant (row fields change, and transfer/delete change list
 * membership). `numberOf` extracts the number because the arg shapes differ. No
 * optimistic patch — these change fields the details view re-reads wholesale.
 */
function useIssueLifecycleMutation<TArgs, TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  numberOf: (args: TArgs) => number,
  /** Whether this write changes what a Projects BOARD card draws. Declared per
   *  call site, not assumed for the helper: close/reopen/edit/transfer/delete all
   *  change a card's state glyph, title, or presence, while pin and lock/unlock
   *  change nothing a card shows. */
  boardCards = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: (_d, _e, args) => {
      if (boardCards) invalidateProjectBoards(queryClient, repo);
      return void Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...repoKeys.issueList(repo), lens],
        }),
        queryClient.invalidateQueries({
          queryKey: ["repo", repo, "issue", lens, numberOf(args)],
        }),
      ]);
    },
  });
}

export function usePinIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; pinned: boolean }) =>
      args.pinned
        ? api.ghIssuePin(repo, args.number, lens)
        : api.ghIssueUnpin(repo, args.number, lens),
    (args) => args.number,
  );
}

export function useLockIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; reason: api.LockReason | null }) =>
      api.forgeIssueLock(repo, args.number, args.reason, lens),
    (args) => args.number,
  );
}

export function useUnlockIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueUnlock(repo, number, lens),
    (number) => number,
  );
}

export function useIssueReactions(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue", lens, number ?? 0, "reactions"] as const,
    queryFn: () => api.forgeIssueReactions(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** An issue's activity timeline for the issue view. Provider-neutral (the backend
 *  dispatches), so the caller passes `enabled = <known provider that has it>` — an
 *  unresolved provider must NOT fetch. Decoupled from the issue view like
 *  {@link useIssueReactions}. */
export function useIssueTimeline(
  repoPath: string,
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "issue", lens, number, "timeline"] as const,
    queryFn: () => api.forgeIssueTimeline(repoPath, number, lens),
    enabled,
    staleTime: 30_000,
  });
}

function patchReactionList(
  list: Reaction[],
  content: string,
  active: boolean,
): Reaction[] {
  const existing = list.find((r) => r.content === content);
  if (active) {
    // Removing the viewer's reaction.
    if (!existing) return list;
    const count = existing.count - 1;
    return count <= 0
      ? list.filter((r) => r.content !== content)
      : list.map((r) =>
          r.content === content ? { ...r, count, viewerReacted: false } : r,
        );
  }
  // Adding the viewer's reaction.
  if (existing) {
    return list.map((r) =>
      r.content === content
        ? { ...r, count: r.count + 1, viewerReacted: true }
        : r,
    );
  }
  return [...list, { content, count: 1, viewerReacted: true }];
}

/**
 * Toggles the viewer's reaction with an optimistic cache update + rollback.
 * `reactionsKey` is the reactions query; `bodyId` is the issue/PR/discussion body id
 * (anything else is a comment id). `opts` carries the GitLab-side subject (containing
 * issue/MR) — GitHub keys purely on node ids and ignores it.
 */
export function useToggleReaction(
  repo: string,
  reactionsKey: QueryKey,
  bodyId: string,
  opts: { target: api.ReactionTarget; number: number } = {
    target: "discussion",
    number: 0,
  },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      subjectId: string;
      content: string;
      active: boolean;
    }) =>
      args.active
        ? api.forgeRemoveReaction(
            repo,
            opts.target,
            opts.number,
            args.subjectId,
            args.content,
          )
        : api.forgeAddReaction(
            repo,
            opts.target,
            opts.number,
            args.subjectId,
            args.content,
          ),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: reactionsKey });
      const prev = queryClient.getQueryData<IssueReactions>(reactionsKey);
      queryClient.setQueryData<IssueReactions>(reactionsKey, (data) => {
        const base: IssueReactions = data ?? { body: [], comments: {} };
        if (args.subjectId === bodyId) {
          return {
            ...base,
            body: patchReactionList(base.body, args.content, args.active),
          };
        }
        return {
          ...base,
          comments: {
            ...base.comments,
            [args.subjectId]: patchReactionList(
              base.comments[args.subjectId] ?? [],
              args.content,
              args.active,
            ),
          },
        };
      });
      return { prev };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData(reactionsKey, ctx.prev);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: reactionsKey }),
  });
}

export function useCloseIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; reason: string }) =>
      api.forgeIssueClose(repo, args.number, args.reason, lens),
    (args) => args.number,
    // State + close reason are the card glyph and its screen-reader word.
    true,
  );
}

export function useReopenIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueReopen(repo, number, lens),
    (number) => number,
    // Back to the open glyph, and REOPENED lands as the state reason.
    true,
  );
}

export function useEditIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; title: string; body: string }) =>
      api.forgeIssueEdit(repo, args.number, args.title, args.body, lens),
    (args) => args.number,
    // The title is the card.
    true,
  );
}

export function useTransferIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; destination: string }) =>
      api.forgeIssueTransfer(repo, args.number, args.destination, lens),
    (args) => args.number,
    // A transfer re-homes the item: its number and owning repo both change.
    true,
  );
}

export function useDeleteIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueDelete(repo, number, lens),
    (number) => number,
    // A deleted issue leaves the board entirely.
    true,
  );
}

/** An issue's parent + sub-issues, loaded alongside the conversation. */
export function useIssueRelations(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue", lens, number ?? 0, "relations"] as const,
    queryFn: () => api.ghIssueRelations(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** The link target rides the VARIABLES, never this hook's scope: the create dialog
 *  fires it after an await, so a switch in that window would retarget the write —
 *  and node ids are global, so the parent would still resolve while `subNumber`
 *  picked the newly-live repo's unrelated issue and adopted it. */
export function useAddSubIssue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      repo: string;
      parentId: string;
      subNumber: number;
      lens: RemoteLens;
    }) =>
      api.ghIssueAddSubIssue(
        args.repo,
        args.parentId,
        args.subNumber,
        args.lens,
      ),
    // Follows the variables' repo, so the refresh lands where the write did.
    onSettled: (_d, _e, args) => {
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(args.repo) });
    },
  });
}

/** An issue's blocked-by / blocking dependencies. */
export function useIssueDependencies(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "issue",
      lens,
      number ?? 0,
      "dependencies",
    ] as const,
    queryFn: () => api.ghIssueDependencies(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** An issue's "Development" links: closing PRs + linked branches. */
export function useIssueDevelopment(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "issue",
      lens,
      number ?? 0,
      "development",
    ] as const,
    queryFn: () => api.ghIssueDevelopment(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useCreateLinkedBranch(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { issueId: string; name: string }) =>
      api.ghIssueCreateLinkedBranch(repo, args.issueId, args.name, lens),
    {
      // Pinned: the call closes over `repo`/`lens` and its invalidation over `repo`,
      // and the issue panel survives a repo switch — without the key a switch
      // retargets the pending create.
      identity: ["create-linked-branch", repo, lens],
    },
  );
}

export function useSetIssueDependency(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      number: number;
      relation: IssueRelation;
      target: number;
      add: boolean;
    }) =>
      api.ghIssueSetDependency(
        repo,
        args.number,
        args.relation,
        args.target,
        args.add,
        lens,
      ),
    // Cross-issue: a dependency touches BOTH the source's and the target's detail
    // subtrees (their `dependencies` sub-query is keyed by number) — no list-
    // membership change, so scope to the two issues' details rather than repo-wide.
    onSettled: (_d, _e, args) =>
      void Promise.all(
        [args.number, args.target].map((n) =>
          queryClient.invalidateQueries({
            queryKey: ["repo", repo, "issue", lens, n],
          }),
        ),
      ),
  });
}

export function useRemoveSubIssue(repo: string) {
  return useRepoMutation(repo, (args: { parentId: string; subId: string }) =>
    api.ghIssueRemoveSubIssue(repo, args.parentId, args.subId),
  );
}
