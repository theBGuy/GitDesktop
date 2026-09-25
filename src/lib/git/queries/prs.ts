import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { isAppError } from "@/lib/tauri/invoke";
import * as api from "../api";
import type {
  CiStatus,
  CommitCommentOut,
  DraftCommentIn,
  ForgeStatus,
  IssueDetails,
  PrDetails,
  PrInfo,
  PrMergeabilityState,
  PrThreadOut,
  RemoteLens,
  RemoteListFilter,
  ReviewThreadOut,
} from "../types";
import { remoteListFilterKey } from "../types";
import { keepPreviousDataForKeyAxes, repoKeys } from "./core";
import {
  useOptimisticCacheMutation,
  useRepoMutation,
  workingTreeKeys,
} from "./internal";

export function usePrsForBranch(
  repo: string,
  head: string | null,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "prs", lens, head ?? ""] as const,
    queryFn: () => api.forgePrsForBranch(repo, head ?? "", lens),
    enabled: enabled && head !== null,
    staleTime: 30_000,
  });
}

export function usePrList(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
  /** Poll this list while the CALLER has something it is waiting for the forge
   *  to show. Caller-owned and bounded — this hook counts no rungs, so an
   *  unbounded value polls forever; default false is every other call site. */
  refetchIntervalMs: number | false = false,
) {
  return useQuery({
    // The filter key is APPENDED (index 6) so the existing axis indices — and the
    // positional axes list below — don't shift.
    queryKey: [
      ...repoKeys.prList(repo),
      lens,
      state,
      limit ?? null,
      remoteListFilterKey(filter),
    ] as const,
    queryFn: () => api.forgePrList(repo, state, limit, lens, filter),
    enabled,
    staleTime: 30_000,
    // invalidArgument marks a refusal that is deterministic for this scope — the filter
    // caps, the magic values, and GitLab's walk horizon — so a retry only re-spends the
    // walk (up to 30 `glab` calls) to reach the same answer.
    retry: (failureCount, err) =>
      !(isAppError(err) && err.kind === "invalidArgument") && failureCount < 1,
    // State, limit and filter stay free so a tab switch, "Load more" or a filter
    // change keeps the current rows instead of flashing skeletons, but lens must
    // match: a fork numbers PRs independently of its parent, so another lens's rows
    // misdescribe the list and a click on one navigates by number to a different PR.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false,
  });
}

/** Hydrates PR-list rows with each PR's CI rollup, keyed by number. Runs SEPARATELY from
 *  `usePrList` — a full rollup expansion inside the list query 504s on large GitHub
 *  repos. CALLER CONTRACT: idle this hook while the list serves placeholder rows
 *  (`enabled: … && !list.isPlaceholderData`) — the comparator below leaves `state` free,
 *  so an ungated intermediate fetch would build a map from the outgoing rows and cache it
 *  under the incoming key. The number+headSha digest in the key is the remaining defense:
 *  it keeps such a result from ever caching under another page's key, and — because
 *  Bitbucket's rollup is addressed by `headSha` — a pushed head re-keys the query, so a
 *  refetch concurrent with the list's cannot leave a map built from the outgoing SHAs
 *  sitting fresh-stamped. GitHub/GitLab leave `headSha` empty (their CI reads by number),
 *  so their digests only gain a colon per row. */
export function usePrListCi(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  prs: PrInfo[] | undefined,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      ...repoKeys.prCi(repo),
      lens,
      state,
      limit ?? null,
      prs?.map((p) => `${p.number}:${p.headSha}`).join(",") ?? "",
    ] as const,
    queryFn: async () => {
      // `enabled` requires a non-empty `prs`, so the cast and `list[0]` below are safe.
      const list = prs as PrInfo[];
      // No lens arg on the api call: `sampleUrl` (list[0].url) already pins which
      // repo these numbers belong to, so the CI rollup is fork/parent-correct by
      // construction. The lens rides the key only, so the fork's and parent's
      // rollups never collide in the cache.
      const rows = await api.forgePrListCi(
        repo,
        list.map((p) => ({ number: p.number, headSha: p.headSha })),
        list[0].url,
      );
      return new Map<number, CiStatus>(rows.map((r) => [r.number, r.ciStatus]));
    },
    enabled: enabled && !!prs && prs.length > 0,
    staleTime: 30_000,
    // Repo and lens must match: a fork numbers PRs independently of its parent, so a
    // cross-lens map paints wrong icons. State stays free — the panel idles this query
    // while the list serves placeholder rows (mirroring the mergeability gate), and
    // open/closed sets are disjoint, so a cross-tab serve can't show another PR's status.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** Hydrates PR-list rows with each PR's mergeability, keyed by number — the rows' conflict
 *  chip. Runs separately from `usePrList`, and its numbers digest in the key is
 *  load-bearing: the digest pins the key to the row set the map describes, so an
 *  intermediate result can never cache under the next page's key. `prs` never
 *  reaches the backend (it re-queries the page from the filters): it is here only to
 *  form that digest and to keep the read off an empty page. */
export function usePrListMergeability(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  prs: PrInfo[] | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
) {
  return useQuery({
    // The filter key rides BEHIND the numbers digest: the digest pins which rows the
    // map describes, the filter key pins which server query produced it — the backend
    // re-runs the page from these args rather than taking the rows. Unlike the review
    // state's, this filter axis stays FREE in the placeholder comparator below: a PR's
    // mergeability is a property of the PR, identical whichever query surfaced it, and
    // the numbers digest already refuses a map built for different rows.
    queryKey: [
      ...repoKeys.prMergeability(repo),
      lens,
      state,
      limit ?? null,
      prs?.map((p) => p.number).join(",") ?? "",
      remoteListFilterKey(filter),
    ] as const,
    queryFn: async () => {
      const rows = await api.forgePrListMergeability(
        repo,
        state,
        limit,
        lens,
        filter,
      );
      return new Map<number, PrMergeabilityState>(
        Object.entries(rows).map(([number, mergeState]) => [
          Number(number),
          mergeState,
        ]),
      );
    },
    enabled: enabled && !!prs && prs.length > 0,
    staleTime: 30_000,
    // Keeps the current chips while a "Load more" grows the list (that moves only the
    // limit/digest segments, idx 5/6), but ONLY within the same repo, lens AND state.
    // A placeholder is served even while this query is DISABLED — query-core applies it
    // on any keyed query with no data yet — so matching on repo alone (what the shared
    // `keepPreviousDataForRepo` does) would paint the open tab's map onto closed rows,
    // and origin's onto upstream's, since numbers collide across both axes.
    placeholderData: keepPreviousDataForKeyAxes(repo, [
      [3, lens],
      [4, state],
    ]),
  });
}

/**
 * The viewer's review state for a PR-list page, keyed by number — what the
 * review-state grouping sorts rows by. A number absent from `entries` is NOT
 * reviewed, so callers derive that bucket by subtraction against the visible rows.
 *
 * CALLER CONTRACT: `enabled = onPullsTab && ghReady && groupingOn &&
 * implemented.reviewGrouping && state === "open" && !list.isPlaceholderData` — the
 * grouping is open-PRs-only; idling this hook while the list serves placeholder rows
 * keeps an intermediate fetch from caching under the incoming key; and the tab gate
 * is load-bearing: a `<TabPanel>`-hidden panel still fetches, and this is a 3-page
 * walk that a repo invalidation would otherwise re-run off-screen.
 *
 * CO-INVALIDATION CONTRACT for mutation authors: any mutation that refreshes the PR
 * list NARROWLY (`[...repoKeys.prList(repo), lens]` rather than the whole
 * `repoKeys.all(repo)` subtree) must invalidate
 * `[...repoKeys.prReviewState(repo), lens]` alongside it — `updatedAt` here is what
 * sorts a PR into "Updated since my review", and staleTime alone schedules no refetch.
 * A mutation that changes CI STATE (approve, re-run, cancel, dispatch) owes
 * {@link usePrListCi}'s `repoKeys.prCi(repo)` the same: it hydrates the list's check
 * badges from its own key, and neither the PR-detail nor the PR-list prefix matches it.
 */
export function usePrReviewState(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null,
) {
  const filterKey = remoteListFilterKey(filter);
  return useQuery({
    queryKey: [
      ...repoKeys.prReviewState(repo),
      lens,
      state,
      limit ?? null,
      filterKey,
    ] as const,
    queryFn: () => api.forgePrReviewState(repo, state, limit, lens, filter),
    enabled,
    staleTime: 30_000,
    // No placeholderData, unlike the list: lens, state and FILTER are identity axes of
    // this map, and a map retained across a "Load more" is no better — its walk may not
    // reach the larger page's rows, where a number missing from `entries` reads as "not
    // reviewed" and `truncated` was decided against the old page depth. Callers refuse
    // placeholder maps regardless, per the standing gate rule.
  });
}

/** The teams the viewer belongs to, for the team-review filter's picker. Membership
 *  changes rarely, so it caches for five minutes and doesn't retry — a token without
 *  the team scope answers `missingScope` rather than failing. `enabled` must carry
 *  the active-tab gate (a `<TabPanel>`-hidden panel still fetches, and this is a
 *  paginated `user/teams` walk); `useRemoteListFilter`'s `tabActive` opt does. */
export function useMyTeams(repo: string, lens: RemoteLens, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "my-teams", lens] as const,
    queryFn: () => api.forgeMyTeams(repo, lens),
    enabled,
    staleTime: 300_000,
    retry: false,
  });
}

export function useRepoLabels(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "labels", lens] as const,
    queryFn: () => api.forgeRepoLabels(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// Shared definitions so the hook and the prefetch path stay in sync. A short
// stale window makes a hover-prefetched PR open with no extra round-trip; the
// window-focus refetch still keeps an open PR current.
export const prDetailsOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", lens, number] as const,
    queryFn: () => api.forgePrView(repo, number, lens),
    staleTime: 30_000,
  });

export const prDiffOptions = (repo: string, number: number, lens: RemoteLens) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", lens, number, "diff"] as const,
    queryFn: () => api.forgePrDiff(repo, number, lens),
    staleTime: 30_000,
  });

export function usePrDetails(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...prDetailsOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // The lens segment is an IDENTITY axis: a fork's two lenses surface different
    // pull requests at the same number, so a cross-lens placeholder paints the
    // wrong PR. A number change deliberately KEEPS the previous PR's data — the
    // dimmed switch beat that RemotePrView's detailsStale gates compensate for.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** How many reads the "checking" ladder gets per VISIT before it concedes: GitHub's
 *  async mergeability compute normally settles within a few primed reads, and an
 *  unbounded poll would burn API budget forever on a PR whose answer never comes. */
const MERGEABILITY_POLL_LIMIT = 6;

/** A PR's mergeability against its base — the conflict banner's server truth. GitHub
 *  computes it asynchronously and this read PRIMES that computation, so "checking"
 *  re-polls on the bounded ladder above, and `polling` lets the banner tell "still
 *  climbing" from "gave up". The ladder counts per MOUNT and per PR rather than off the
 *  cache entry's cumulative `dataUpdateCount`, which would leave a PR that once hit the
 *  ceiling unable to poll again all session; `retry` restarts it by hand. `isError`
 *  with no `data` is the read that never landed at all — unreachable rather than
 *  undecided, which the banner answers with the local prediction instead. */
export function usePrMergeability(
  repo: string,
  number: number | null,
  lens: RemoteLens,
  enabled: boolean,
) {
  // The ref is what `refetchInterval` reads — it runs outside render, and a render-time
  // read of mutable state goes stale once the React Compiler memoizes it. The state
  // mirror is the render-visible half.
  const polls = useRef(0);
  const ladderFor = useRef("");
  const seen = useRef({ ok: 0, failed: 0 });
  const [pollsUsed, setPollsUsed] = useState(0);
  const query = useQuery({
    queryKey: ["repo", repo, "pr", lens, number ?? 0, "mergeability"] as const,
    queryFn: () => api.forgePrMergeability(repo, number ?? 0, lens),
    enabled: enabled && number !== null,
    staleTime: 15_000,
    // `polls.current` is the ONE ladder counter, fed below by completions of either
    // kind. The cache's own cumulative counts are deliberately not used here: they
    // outlive the mount, so a PR that once hit the ceiling could never poll again.
    refetchInterval: (q) =>
      q.state.data?.state === "checking" &&
      polls.current < MERGEABILITY_POLL_LIMIT
        ? 2_500
        : false,
    refetchIntervalInBackground: false,
  });

  const identity = [repo, number, lens].join("|");
  const checking = query.data?.state === "checking";
  const updatedAt = query.dataUpdatedAt;
  const failedAt = query.errorUpdatedAt;
  // One ladder step per COMPLETED read that left the question open — a success still
  // saying "checking", OR a failure. Counting failures is what actually bounds a flaky
  // or rate-limited forge: the last good answer stays "checking" in the cache, so a
  // success-only ladder would poll every 2.5s forever and never reach the gave-up arm.
  // Compared against the last timestamps seen so an unrelated re-render can't spend a
  // rung, and reset whenever the PR or lens changes — each is its own question.
  useEffect(() => {
    if (ladderFor.current !== identity) {
      ladderFor.current = identity;
      polls.current = 0;
      seen.current = { ok: 0, failed: 0 };
    }
    const advanced =
      updatedAt > seen.current.ok || failedAt > seen.current.failed;
    seen.current = { ok: updatedAt, failed: failedAt };
    if (advanced && checking) polls.current += 1;
    setPollsUsed(polls.current);
  }, [identity, checking, updatedAt, failedAt]);

  const refetch = query.refetch;
  const retry = useCallback(() => {
    polls.current = 0;
    setPollsUsed(0);
    void refetch();
  }, [refetch]);

  return {
    data: query.data,
    isFetching: query.isFetching,
    /** Still climbing the ladder, so "checking" is an honest thing to show. */
    polling: checking && pollsUsed < MERGEABILITY_POLL_LIMIT,
    /** The last read failed. Only meaningful paired with `data`: without one the forge
     *  was never reached for this PR; with one, a settled answer survives the failure. */
    isError: query.isError,
    /** Restart the ladder and read again — the gave-up banner's Retry. */
    retry,
  };
}

/** The divergence key's repo+PR prefix, deliberately lens-free so one invalidation
 *  covers both lenses. A SIBLING of the PR subtree rather than a child, so
 *  `["repo", repo, "pr", …]` does not prefix-cover it — update-branch has to name it. */
export const prBaseDivergencePrefix = (repo: string, number: number) =>
  ["repo", repo, "pr-base-divergence", number] as const;

/** The full key `usePrBaseDivergence` reads — the prefix plus its lens axis. */
const prBaseDivergenceKey = (
  repo: string,
  number: number,
  lens: RemoteLens | undefined,
) => [...prBaseDivergencePrefix(repo, number), lens ?? "origin"] as const;

/** How many reads the post-update ladder gets before it concedes. Each rung costs TWO
 *  gh calls (the PR view, then the compare), so the budget is tighter per second than
 *  the mergeability ladder's; ~16s covers the usual update job without leaving a
 *  spinner up forever on one that never lands. */
const DIVERGENCE_UPDATE_POLL_LIMIT = 8;

/** How far a PR's head is ahead of / behind its base — the "Update branch"
 *  affordance's driver. `retry: false` keeps a repo without the permission (or a
 *  non-GitHub one) from a retry storm; consumers treat an error as "unknown".
 *  GitHub runs update-branch as a queued job, so `awaitUpdate` arms a bounded poll
 *  and `updating` stays true until a read OBSERVES the head caught up — the only
 *  honest completion signal there is. */
export function usePrBaseDivergence(
  repo: string,
  number: number | null,
  lens: RemoteLens | undefined,
  enabled: boolean,
) {
  // Same ref/state split as the mergeability ladder: `refetchInterval` runs outside
  // render, and a render-time read of mutable state goes stale once the React Compiler
  // memoizes it. The mirror carries the IDENTITY it was armed for rather than a bare
  // boolean, so a PR or lens change retires it in the same render — an effect-cleared
  // flag paints the old PR's line onto the new one for a frame first.
  const awaiting = useRef(false);
  const polls = useRef(0);
  const ladderFor = useRef("");
  const seen = useRef({ ok: 0, failed: 0 });
  const [latch, setLatch] = useState<string | null>(null);
  const identity = [repo, number, lens].join("|");
  const query = useQuery({
    queryKey: prBaseDivergenceKey(repo, number ?? 0, lens),
    queryFn: () => api.ghPrBaseDivergence(repo, number ?? 0, lens ?? "origin"),
    enabled: enabled && number !== null,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) =>
      awaiting.current &&
      (q.state.data?.behindBy ?? 0) > 0 &&
      polls.current < DIVERGENCE_UPDATE_POLL_LIMIT
        ? 2_000
        : false,
    refetchIntervalInBackground: false,
  });

  const behind = (query.data?.behindBy ?? 0) > 0;
  const updatedAt = query.dataUpdatedAt;
  const failedAt = query.errorUpdatedAt;
  // One rung per COMPLETED read that still shows the head behind — a success or a
  // failure alike. The query is `retry: false`, so counting failures is the only thing
  // bounding a forge that has started refusing: the cached `behindBy` would otherwise
  // keep the latch armed and poll forever. Timestamps guard against an unrelated
  // re-render spending a rung; a PR or lens change is a different question entirely,
  // so it clears the latch rather than inheriting it.
  useEffect(() => {
    if (ladderFor.current !== identity) {
      ladderFor.current = identity;
      awaiting.current = false;
      polls.current = 0;
      seen.current = { ok: 0, failed: 0 };
      // The mirror already reads false against the new identity; dropping the stale
      // string keeps a switch BACK to that PR from re-arming it.
      setLatch(null);
    }
    const advanced =
      updatedAt > seen.current.ok || failedAt > seen.current.failed;
    seen.current = { ok: updatedAt, failed: failedAt };
    if (advanced && awaiting.current && behind) polls.current += 1;
    if (
      awaiting.current &&
      (!behind || polls.current >= DIVERGENCE_UPDATE_POLL_LIMIT)
    ) {
      awaiting.current = false;
      setLatch(null);
    }
  }, [identity, behind, updatedAt, failedAt]);

  const refetch = query.refetch;
  const awaitUpdate = useCallback(() => {
    // A stale closure (the view moved to another PR mid-submit) must not arm the
    // shared refs against the new key — the mount effect keeps ladderFor current.
    if (ladderFor.current !== identity) return false;
    awaiting.current = true;
    polls.current = 0;
    setLatch(identity);
    void refetch();
    return true;
  }, [refetch, identity]);

  return {
    data: query.data,
    isFetching: query.isFetching,
    /** An update was asked for and the head has not been seen caught up yet. Clears on
     *  `behindBy === 0`, on rung exhaustion, and on a PR/lens change; a query disabled
     *  mid-poll holds the latch until it re-enables or the PR changes, so readers must
     *  gate this on the same `enabled` they passed. */
    updating: latch === identity,
    /** Arm the ladder after a queued update-branch and read again now. Returns false
     *  without arming anything when the view has already moved to another PR or lens,
     *  so the caller drops an answer that is no longer about what's on screen. */
    awaitUpdate,
  };
}

export function usePrDiff(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...prDiffOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // Lens axis mirrors usePrDetails; the number axis stays placeholder-served so
    // RemotePrView's diffStale keeps gating the Files tab during a PR switch.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

// File:line-anchored review threads (Copilot/CodeRabbit/human line comments); the
// data serves both the Conversation grouping and the Files diff anchors, so it
// lives at the PR top level.
export const prReviewThreadsKey = (
  repo: string,
  number: number,
  lens: RemoteLens,
) => ["repo", repo, "pr", lens, number, "review-threads"] as const;

export function usePrReviewThreads(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: prReviewThreadsKey(repo, number ?? 0, lens),
    queryFn: () => api.forgePrReviewThreads(repo, number ?? 0, lens),
    staleTime: 30_000,
    // Gate on `number !== null` alone, exactly like usePrDetails/usePrReactions.
    // A transient gh status-probe failure (useForgeStatus has retry:false) leaves
    // forge.data undefined for ~60s; gating this read on it would silently hide
    // threads on a healthy PR. The Implemented flags still gate the WRITE
    // controls (reply/resolve) in the view.
    enabled: number !== null,
  });
}

/**
 * Applies a review suggestion to the working tree (GitHub's "Commit suggestion", done
 * locally). A staging-class edit, so it narrows invalidation to {@link workingTreeKeys}
 * like workingtree.ts's `useStage` — the whole-repo default would prefix-match the
 * review-threads key and force a needless GitHub GraphQL refetch even though no thread
 * changed. The backend verifies the expected lines before editing; a mismatch throws.
 */
export function useApplySuggestion(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      filePath: string;
      startLine: number;
      expectedLines: string[];
      replacementLines: string[];
      stageWhenClean: boolean;
    }) =>
      api.gitReplaceFileLines(
        repo,
        args.filePath,
        args.startLine,
        args.expectedLines,
        args.replacementLines,
        args.stageWhenClean,
      ),
    { invalidate: workingTreeKeys(repo) },
  );
}

/** The unified diff for one commit of a PR/MR. Pass `oid: null` when no commit is
 *  selected so the read doesn't fire; keyed by oid so each commit's diff caches
 *  independently. */
export function usePrCommitDiff(
  repo: string,
  number: number,
  oid: string | null,
  lens: RemoteLens,
) {
  return useQuery({
    // The diff itself is sha-addressed (forgePrCommitDiff takes no lens), but the
    // PARENT PR this attaches to is lens-scoped, so the lens rides the key.
    queryKey: ["repo", repo, "pr", lens, number, "commit-diff", oid] as const,
    queryFn: () => api.forgePrCommitDiff(repo, number, oid ?? ""),
    enabled: oid !== null,
    staleTime: 30_000,
  });
}

/** Comments on a commit (GitHub commit comments / GitLab commit notes). Pass
 *  `sha: null` when no commit is selected so the read doesn't fire. The `lens`
 *  scopes which repo the commit's comments come from — "origin" from the History
 *  surface, the live lens inside the PR-commit review context. */
export function useCommitComments(
  repo: string,
  sha: string | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: commitCommentsKey(repo, sha ?? "", lens),
    queryFn: () => api.forgeCommitComments(repo, sha ?? "", lens),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

/** Whether a commit lives on any remote — gates the History-tab commit-comment surface
 *  (you can only comment on a commit the forge already has). A push flips it, hence the
 *  short stale window; pass `sha: null` when no commit is selected. */
export function useCommitOnRemote(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "on-remote"] as const,
    queryFn: () => api.commitOnRemote(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: 30_000,
    // A local `git for-each-ref` read: the default "online" mode would park it.
    networkMode: "always",
  });
}

/** The forge's own unified diff for a commit, PR-independent. GitHub commit-comment
 *  `position` mapping must walk GitHub's own patch rather than local git's (rename
 *  detection etc. can differ), so this fetches the provider's diff. Pass `sha: null`
 *  to keep it cold when no commit is selected. */
export function useRemoteCommitDiff(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "remote-diff"] as const,
    queryFn: () => api.forgeCommitDiff(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

const commitCommentsKey = (repo: string, sha: string, lens: RemoteLens) =>
  ["repo", repo, "commit", sha, "comments", lens] as const;

/**
 * Optimistically appends a synthetic commit comment with exact-key rollback. The
 * synthetic row carries a collision-proof `optimistic:<n>` id and
 * `viewerDidAuthor: false`, so it offers no edit/delete until the reconciling refetch
 * replaces it with the real comment; `author` is the viewer's cached forge login, else
 * "You".
 */
export function useCreateCommitComment(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the call, the optimistic patch, its rollback and the invalidation all
    // close over `repo`/`lens`, and the comment hosts survive a repo switch — without
    // the key a switch retargets the pending create and writes the row elsewhere.
    mutationKey: ["create-commit-comment", repo, lens],
    mutationFn: (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => api.forgeCommitCommentCreate(repo, args, lens),
    onMutate: async (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => {
      const key = commitCommentsKey(repo, args.sha, lens);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<CommitCommentOut[]>(key);
      // The viewer's login is read from the already-cached forge status (no fetch);
      // "You" until the reconciliation refetch swaps in the real comment.
      const login = queryClient.getQueryData<ForgeStatus>([
        "repo",
        repo,
        "forge-status",
      ])?.login;
      const synthetic: CommitCommentOut = {
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        author: login ?? "You",
        body: args.body,
        createdAt: new Date().toISOString(),
        viewerDidAuthor: false,
        path: args.path ?? null,
        line: args.line ?? null,
        startLine: args.startLine ?? null,
        position: args.position ?? null,
      };
      queryClient.setQueryData<CommitCommentOut[]>(key, (list) =>
        list ? [...list, synthetic] : list,
      );
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** Optimistic edit/delete of one commit comment with exact-key rollback — the
 *  commit-comment analogue of pr-actions.ts's `useOptimisticCommentMutation`. */
function useOptimisticCommitCommentMutation<TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: {
    sha: string;
    commentId: string;
    body?: string;
  }) => Promise<TData>,
  patchComment: (
    comment: CommitCommentOut,
    args: { sha: string; commentId: string; body?: string },
  ) => CommitCommentOut | null,
) {
  return useOptimisticCacheMutation<
    { sha: string; commentId: string; body?: string },
    TData,
    CommitCommentOut[]
  >(
    mutationFn,
    (args) => commitCommentsKey(repo, args.sha, lens),
    (list, args) =>
      list?.flatMap((c) => {
        if (c.id !== args.commentId) return [c];
        const patched = patchComment(c, args);
        return patched ? [patched] : [];
      }),
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditCommitComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommitCommentMutation(
    repo,
    lens,
    (args: { sha: string; commentId: string; body?: string }) =>
      api.forgeCommitCommentEdit(
        repo,
        {
          sha: args.sha,
          commentId: args.commentId,
          body: args.body ?? "",
        },
        lens,
      ),
    (comment, args) => ({ ...comment, body: args.body ?? comment.body }),
  );
}

export function useDeleteCommitComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommitCommentMutation(
    repo,
    lens,
    (args: { sha: string; commentId: string }) =>
      api.forgeCommitCommentDelete(
        repo,
        {
          sha: args.sha,
          commentId: args.commentId,
        },
        lens,
      ),
    () => null,
  );
}

/**
 * Creates a file:line-anchored review thread, optimistically appending a synthetic
 * single-comment {@link ReviewThreadOut} with exact-key rollback so the card shows
 * instantly. The synthetic comment carries an `optimistic:<n>` id and
 * `viewerDidAuthor: false` — no edit/delete until the reconciling refetch replaces it.
 */
export function useCreateReviewThread(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    // Pinned: the call, the optimistic patch, its rollback and the invalidation all
    // close over `repo`/`lens`, and the composer's host survives a repo switch —
    // without the key a switch retargets the pending create and writes the thread
    // elsewhere.
    mutationKey: ["create-review-thread", repo, lens],
    mutationFn: (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => api.forgePrThreadCreate(repo, args, lens),
    onMutate: async (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => {
      const key = prReviewThreadsKey(repo, args.number, lens);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ReviewThreadOut[]>(key);
      const login = queryClient.getQueryData<ForgeStatus>([
        "repo",
        repo,
        "forge-status",
      ])?.login;
      const synthetic: ReviewThreadOut = {
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        reviewId: "",
        path: args.path,
        line: args.line,
        startLine: args.startLine ?? 0,
        side: args.side,
        isResolved: false,
        isOutdated: false,
        diffHunk: "",
        comments: [
          {
            author: login ?? "You",
            // Optimistic: login-derived (GitHub) / initial until the refetch fills it.
            authorAvatarUrl: "",
            state: "",
            body: args.body,
            date: new Date().toISOString(),
            id: `optimistic:${(optimisticCommentSeq += 1)}`,
            url: "",
            viewerDidAuthor: false,
            isMinimized: false,
            minimizedReason: "",
            // Optimistic reply: the owning review id (if GitHub wraps it in one)
            // arrives with the reconciling refetch.
            reviewId: "",
          },
        ],
      };
      queryClient.setQueryData<ReviewThreadOut[]>(key, (threads) =>
        threads ? [...threads, synthetic] : threads,
      );
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** Submit a batch review (verdict + summary + staged draft comments). NOT
 *  optimistic — on some providers it fans out to several calls, so it just
 *  invalidates the repo subtree on success and returns the `ReviewSubmitOut`
 *  (types/pr-reviews.ts) so the caller can toast the posted/total counts. */
export function useSubmitReview(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      verdict: api.ReviewVerdict;
      summary?: string;
      comments: DraftCommentIn[];
    }) => api.forgePrReviewSubmit(repo, args, lens),
  );
}

export function useThreadReply(repo: string, number: number, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; body: string }) =>
      api.forgePrThreadReply(repo, number, args.threadId, args.body),
    { invalidate: [prReviewThreadsKey(repo, number, lens)] },
  );
}

export function useThreadResolve(
  repo: string,
  number: number,
  lens: RemoteLens,
) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; resolved: boolean }) =>
      api.forgePrThreadResolve(repo, number, args.threadId, args.resolved),
    { invalidate: [prReviewThreadsKey(repo, number, lens)] },
  );
}

/** Warms a remote PR's view (metadata + diff) on row hover and adjacent rows — PR data
 *  is the slowest load in the app, so prefetching pays off most here. */
export function usePrefetchPr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(prDetailsOptions(repo, number, lens));
      queryClient.prefetchQuery(prDiffOptions(repo, number, lens));
    },
    [queryClient, repo, lens],
  );
}

/** Reactions for a PR's body + comments — decoupled from the PR view so it
 *  loads in parallel and leaves the (untouched) PR query alone. */
export function usePrReactions(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "pr", lens, number ?? 0, "reactions"] as const,
    queryFn: () => api.forgePrReactions(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** A PR's activity timeline for the Conversation tab. Provider-neutral (the backend
 *  dispatches), so the caller passes `enabled = section === "conversation" && <known
 *  provider>` — a hidden tab must NOT fetch. Decoupled from the PR view like
 *  {@link usePrReactions}. */
export function usePrTimeline(
  repoPath: string,
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "pr", lens, number, "timeline"] as const,
    queryFn: () => api.forgePrTimeline(repoPath, number, lens),
    enabled,
    staleTime: 30_000,
  });
}

export function useCommentIssue(repo: string, lens: RemoteLens) {
  return useOptimisticCreateCommentMutation(repo, "issue", lens, (args) =>
    api.forgeIssueComment(repo, args.number, args.body, lens),
  );
}

export function useCommentPr(repo: string, lens: RemoteLens) {
  return useOptimisticCreateCommentMutation(repo, "pr", lens, (args) =>
    api.forgePrComment(repo, args.number, args.body, args.asBot, lens),
  );
}

/** Monotonic counter for synthetic optimistic-comment ids — combined with the
 *  `optimistic:` prefix it can never collide with a real provider node id. */
let optimisticCommentSeq = 0;

/**
 * Optimistically appends a synthetic conversation comment to a PR/issue detail cache
 * with exact-key rollback (a full glab round trip is ~2-4s). The synthetic row carries a
 * collision-proof `optimistic:<n>` id and `viewerDidAuthor: false`, so it offers no
 * edit/delete (its temp id would 404 server-side); the reconciling refetch replaces it.
 * Only the flat `comments` array is touched — inline review threads live in another
 * query.
 */
function useOptimisticCreateCommentMutation<TData>(
  repo: string,
  kind: "pr" | "issue",
  lens: RemoteLens,
  // `asBot` posts as the configured GitLab review-bot identity (ignored elsewhere).
  mutationFn: (args: {
    number: number;
    body: string;
    asBot?: boolean;
  }) => Promise<TData>,
) {
  return useOptimisticCacheMutation<
    { number: number; body: string; author: string; asBot?: boolean },
    TData,
    PrDetails | IssueDetails
  >(
    (args) => mutationFn(args),
    (args) => ["repo", repo, kind, lens, args.number] as const,
    (d, args) => {
      const synthetic: PrThreadOut = {
        author: args.author,
        // Optimistic: login-derived (GitHub) / initial until the refetch fills it.
        authorAvatarUrl: "",
        state: "",
        body: args.body,
        date: new Date().toISOString(),
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        url: "",
        viewerDidAuthor: false,
        isMinimized: false,
        minimizedReason: "",
        // Synthetic conversation comment — belongs to no review.
        reviewId: "",
      };
      return d ? { ...d, comments: [...d.comments, synthetic] } : d;
    },
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}
