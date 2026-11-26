import {
  hashKey,
  type MutationCache,
  type QueryClient,
  type QueryKey,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchPostedCopies } from "@/lib/attachments/store";
import { shouldRetryQuery } from "@/lib/forge-backoff";
import { FULL_OID_RE } from "@/lib/git/oid";
import { filterPlaceholderRows } from "@/lib/remote-state-filter";
import { useMutation } from "@/lib/started-mutation";
import { isAppError } from "@/lib/tauri/invoke";
import * as api from "../api";
import type {
  AttachmentRefs,
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
  ReviewThreadsOut,
} from "../types";
import { type PrDiffTarget, prDiffTarget, remoteListFilterKey } from "../types";
import {
  invalidateRepoAfterWrite,
  keepPreviousDataForKeyAxes,
  keepPreviousDataForRepo,
  repoKeys,
} from "./core";
import {
  useMutationCacheSnapshot,
  useOptimisticCacheMutation,
  useRepoMutation,
  workingTreeKeys,
} from "./internal";
import { issueWriteKey } from "./issues";
import {
  pendingMutationEntries,
  pendingThreadWritesFor,
  prWriteKey,
  type ThreadWriteVars,
} from "./pr-writes";

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
    // invalidArgument is deterministic per scope (filter caps, magic values, GitLab's
    // walk horizon), so a retry re-spends the walk (up to 30 `glab` calls) for the same
    // answer; the rest takes the default, which never retries rate limits or 401s.
    retry: (failureCount, err) =>
      !(isAppError(err) && err.kind === "invalidArgument") &&
      shouldRetryQuery(failureCount, err),
    // State, limit and filter stay free so a tab switch, "Load more" or a filter
    // change keeps the current rows instead of flashing skeletons, but lens must
    // match: a fork numbers PRs independently of its parent, so another lens's rows
    // misdescribe the list and a click on one navigates by number to a different PR.
    // A page kept on this tab's own state (index 4) is filed by row state; another
    // tab's page passes whole.
    placeholderData: (prev, prevQuery) => {
      const rows = keepPreviousDataForKeyAxes(repo, [[3, lens]])(
        prev,
        prevQuery,
      );
      return rows && filterPlaceholderRows(rows, state, prevQuery?.queryKey[4]);
    },
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false,
  });
}

/** `usePrList` read through `forge_pr_list_page`, so the page carries its
 *  horizon flag (`PrListPage.capped`) beside the rows. Its callers are the PR
 *  panel and the stack offer, which shares the panel's default Open page; same
 *  options and the same reasons as `usePrList`'s. */
export function usePrListPage(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
  filter: RemoteListFilter | null = null,
  refetchIntervalMs: number | false = false,
) {
  return useQuery({
    // Indices 0-6 are `usePrList`'s key, so every prefix and positional reader of
    // the family covers these pages. The trailing marker keeps the two payload
    // shapes in separate entries when a caller's arguments coincide with the
    // panel's (BranchSwitcher's closed scan).
    queryKey: [
      ...repoKeys.prList(repo),
      lens,
      state,
      limit ?? null,
      remoteListFilterKey(filter),
      "page",
    ] as const,
    queryFn: () => api.forgePrListPage(repo, state, limit, lens, filter),
    enabled,
    staleTime: 30_000,
    retry: (failureCount, err) =>
      !(isAppError(err) && err.kind === "invalidArgument") &&
      shouldRetryQuery(failureCount, err),
    // `usePrList`'s placeholder rule over the page's rows. The kept page's
    // `capped` rides along; the panel never reads it from a placeholder.
    placeholderData: (prev, prevQuery) => {
      const page = keepPreviousDataForKeyAxes(repo, [[3, lens]])(
        prev,
        prevQuery,
      );
      if (!page) return undefined;
      const rows = filterPlaceholderRows(
        page.rows,
        state,
        prevQuery?.queryKey[4],
      );
      return rows && (rows === page.rows ? page : { ...page, rows });
    },
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
 *  sitting fresh-stamped. GitHub/GitLab CI reads by number, but their rows carry
 *  headSha too, so a pushed head re-keys their digests as well, at the cost of one
 *  extra rollup read. */
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
    // the state tabs are disjoint, so a cross-tab serve can't show another PR's status.
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
 * is a backstop for a 3-page walk: a `<TabPanel>`-hidden panel already connects no
 * observers and fetches nothing (measured), and the gate holds even outside one.
 *
 * CO-INVALIDATION CONTRACT for mutation authors: any mutation that refreshes the PR
 * list NARROWLY (`[...repoKeys.prList(repo), lens]` rather than the whole
 * `repoKeys.all(repo)` subtree) must invalidate
 * `[...repoKeys.prReviewState(repo), lens]` alongside it — `updatedAt` here is what
 * sorts a PR into "Updated since my review", and staleTime alone schedules no refetch.
 * A mutation that changes CI STATE (approve, re-run, cancel, dispatch) owes
 * {@link usePrListCi}'s `repoKeys.prCi(repo)` the same: it hydrates the list's check
 * badges from its own key, and neither the PR-detail nor the PR-list prefix matches it.
 * A mutation that moves a PR head (a push, an update-branch) owes
 * `repoKeys.prMergeability(repo)` too: neither prefix matches it either.
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
 *  the team scope answers `missingScope` rather than failing. `enabled` carries the
 *  active-tab gate (`useRemoteListFilter`'s `tabActive` opt) as a backstop for a
 *  paginated walk: a hidden `<TabPanel>` already fetches nothing (measured). */
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
    // A pure transform of the answer under a landed-merge record, sampled after
    // the await. Never reads `signal`: query-core would then cancel and revert the
    // read on unmount. Only the cache listener retires a mark on a CLOSED answer.
    queryFn: async (context) =>
      overlayLandedMerge(
        context.client,
        context.queryKey,
        await api.forgePrView(repo, number, lens),
      ),
    staleTime: 30_000,
  });

/** How long a merge the app landed keeps its request's details reading MERGED
 *  while the forge's own details read still lags: GitLab's lagged a landed merge
 *  by about 13 s in a #711 live drive. */
export const LANDED_MERGE_TTL_MS = 60_000;

type LandedMark = {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
};

/** Per QueryClient, keyed on the details query's hash: a client never sees
 *  another client's record, and a sibling worktree's entry (another raw path)
 *  gets none. */
const landedMerges = new WeakMap<QueryClient, Map<string, LandedMark>>();

/** OPEN or MERGING lags a landed merge; anything else is stored as answered. */
const lagsLandedMerge = (details: unknown): boolean => {
  if (typeof details !== "object" || details === null) return false;
  const state: unknown = (details as { state?: unknown }).state;
  return state === "OPEN" || state === "MERGING";
};

/** Records that the request's merge landed and patches a cached OPEN or MERGING
 *  details entry to MERGED; never creates one. Until its deadline, a cache
 *  listener patches every write that stores OPEN or MERGING, whoever wrote it (a
 *  read in flight at the mint, a mutation rollback). That holds for the stored
 *  value: the patch lands in the same notify batch, so a synchronous observer
 *  can still see the OPEN first. Only a FETCHED answer of CLOSED retires it:
 *  query-core marks `setQueryData` writes `manual` (query.js 110, 514;
 *  queryClient.js 199) and its fetch stores without (query.js 455), so a
 *  discarded read never reaches the listener. A re-mint replaces the record, and
 *  only the newest record's expiry deletes it and invalidates the details once,
 *  by exact key: an active view re-reads, an inactive entry is only marked stale. */
export function markMergeLanded(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  number: number,
): void {
  const queryKey = prDetailsOptions(repo, number, lens).queryKey;
  const key = hashKey(queryKey);
  let marks = landedMerges.get(queryClient);
  if (!marks) {
    marks = new Map();
    landedMerges.set(queryClient, marks);
  }
  const owner = marks;
  const retire = (mark: LandedMark) => {
    clearTimeout(mark.timer);
    mark.unsubscribe();
    if (owner.get(key) === mark) owner.delete(key);
  };
  const previous = owner.get(key);
  if (previous) retire(previous);
  const mark: LandedMark = {
    expiresAt: Date.now() + LANDED_MERGE_TTL_MS,
    timer: setTimeout(() => {
      if (owner.get(key) !== mark) return;
      retire(mark);
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }, LANDED_MERGE_TTL_MS),
    unsubscribe: () => undefined,
  };
  const patch = () =>
    queryClient.setQueryData<PrDetails>(queryKey, (details) =>
      details && lagsLandedMerge(details)
        ? { ...details, state: "MERGED" }
        : undefined,
    );
  owner.set(key, mark);
  mark.unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    // Past the deadline (a late timer: sleep, a busy loop) the overlay has stopped,
    // so the listener stops too; the timer still retires and re-reads.
    if (Date.now() >= mark.expiresAt) return;
    if (event.type !== "updated" || event.query.queryHash !== key) return;
    if (owner.get(key) !== mark) return;
    const { action } = event;
    if (
      action.type === "success" &&
      action.manual !== true &&
      (action.data as { state?: unknown } | undefined)?.state === "CLOSED"
    ) {
      retire(mark);
      return;
    }
    // The patch's own write reads MERGED on its event and stops here.
    if (lagsLandedMerge(event.query.state.data)) patch();
  });
  patch();
}

/** A details answer under a live record: OPEN or MERGING lags the landed merge
 *  and reads MERGED; anything else returns as answered. Never touches the record. */
function overlayLandedMerge(
  client: QueryClient,
  queryKey: QueryKey,
  details: PrDetails,
): PrDetails {
  const mark = landedMerges.get(client)?.get(hashKey(queryKey));
  if (!mark || Date.now() >= mark.expiresAt) return details;
  return lagsLandedMerge(details) ? { ...details, state: "MERGED" } : details;
}

/** A diff entry, one value per read carrying its own proof. `proven`: the
 *  forge, or a head read the run started after its diff read answered, showed
 *  the text is the key's comparison. `moved`: one of them named another head
 *  or base; the entry keeps its prior own text (or none) and counts its
 *  checks. `recheckAt`, set by the first moved answer, is the settle
 *  deadline: only a run started at or after it decides the entry. `endedAt`
 *  names the answer that ended the check and rides every later moved read,
 *  so the check's details re-read is asked once. `afterDetails`, on a held
 *  entry only, is the details answer (its `dataUpdatedAt`) cached when the
 *  run started. */
export type PrDiffRead = (
  | { proof: "proven" | "unproven"; text: string }
  | {
      proof: "moved";
      text: string | null;
      checks: number;
      recheckAt: number;
      endedAt?: number;
    }
) & { afterDetails?: number };

/** A diff read whose forge answer kept naming another head or base. */
export class PrDiffMovedError extends Error {
  constructor() {
    super("This diff changed on the forge while it was loading.");
    this.name = "PrDiffMovedError";
  }
}

/** A raw entry's text for a reader that needs this comparison's diff (the AI
 *  runs): a moved entry's text is not known to be the key's, so it throws. */
export function prDiffText(read: PrDiffRead): string {
  if (read.proof === "moved") throw new PrDiffMovedError();
  return read.text;
}

/** An answered entry: a proven one never re-reads for the details, so only an
 *  unproven one keeps the answer its run started after. */
const answeredRead = (
  proof: "proven" | "unproven",
  text: string,
  afterDetails: number,
): PrDiffRead =>
  proof === "proven" ? { proof, text } : { proof, text, afterDetails };

/** A proof as the wire carried it: any value but proven or moved fails toward
 *  the hold. */
const wireProof = (value: unknown): PrDiffRead["proof"] =>
  value === "proven" || value === "moved" ? value : "unproven";

/** The terminal check value: a moved answer from a run started at or after
 *  the settle deadline files it, and the entry then holds until the view
 *  re-keys or a Retry or refresh answers otherwise. */
export const PR_DIFF_MOVED_CHECKS = 3;

/** The first re-check's delay after a moved answer. */
const PR_DIFF_MOVED_FIRST_RECHECK_MS = 50;

/** How long the last re-check waits: right after a push, a forge's consecutive
 *  reads can flip back to the older head for most of a second (measured on
 *  gitlab.com, PR #742). */
export const PR_DIFF_MOVED_RECHECK_MS = 1_000;

/** Whether the pull request still names `at`, judged in Rust on the forge's own
 *  fields by the diff run itself, after its diff read answered unproven. Never
 *  the shared details query or its display view: their fetches are deduped and
 *  reused, and their fields went through display fallbacks. */
async function headReadProof(
  repo: string,
  number: number,
  lens: RemoteLens,
  at: { head: string; baseRef: string; baseSha: string | null },
): Promise<PrDiffRead["proof"]> {
  try {
    return wireProof(await api.forgePrHeadProof(repo, number, lens, at));
  } catch {
    // A failed head read proves nothing.
    return "unproven";
  }
}

/** A pull request's diff at the head and base its details name, as a pure
 *  read: a shared-query event may trigger a run, never prove one. A moved
 *  answer is filed as data and re-checked by `refetchInterval`; `usePrDiff`
 *  asks the details to re-read once the accepted entry ends the check, so a
 *  real push re-keys the view. The queryFn never reads `signal` (query-core
 *  would then cancel the read when its last observer leaves, and the IPC
 *  can't be stopped) and writes no key. */
export const prDiffOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
  target: PrDiffTarget,
) => {
  const queryKey = [
    "repo",
    repo,
    "pr",
    lens,
    number,
    "diff",
    target.head,
    target.baseRef,
    target.baseSha,
  ] as const;
  const detailsKey = prDetailsOptions(repo, number, lens).queryKey;
  return queryOptions({
    queryKey,
    queryFn: async (context): Promise<PrDiffRead> => {
      // Monotonic: a wall-clock step must not spend the settle delay early.
      const startedAt = performance.now();
      // A details answer landing after this run started, joined or not,
      // re-reads a held entry (`usePrDiff`): this run can't have seen it.
      // The stamp tells successive fetched details answers apart, since each
      // is a network round trip; a frozen or fake clock can tie them. The
      // app's own patches to the entry (a draft toggle, merge landed, an Edit
      // save) change no diff target.
      const afterDetails =
        context.client.getQueryState(detailsKey)?.dataUpdatedAt ?? 0;
      const head = target.head;
      // A head-less record, or one whose head is abbreviated, has no full head
      // to prove against: the by-target command refuses a short sha, so it
      // reads by number, proven only where the target allows it (Bitbucket).
      if (head === null || !FULL_OID_RE.test(head))
        return answeredRead(
          target.byNumberProven ? "proven" : "unproven",
          await api.forgePrDiff(repo, number, lens),
          afterDetails,
        );
      const at = { head, baseRef: target.baseRef, baseSha: target.baseSha };
      const answer = await api.forgePrDiffAt(repo, number, lens, at);
      // This run starts its own head read after its diff read answered. The
      // settle deadline applies once the entry has observed movement: a first
      // unproven diff whose head read a stale replica answers in agreement
      // settles at once. Bitbucket's diff names the head in its request, so
      // this exposure is GitHub's by-number fallback's, and Bitbucket's
      // whenever it falls back to its by-number diff.
      let proof = wireProof(answer.headProof);
      if (proof === "unproven")
        proof = await headReadProof(repo, number, lens, at);
      const prior = context.client.getQueryData<PrDiffRead>(queryKey);
      // Once the entry is moved, only a run started at or after its settle
      // deadline may leave moved or end the check. An earlier run (the 50 ms
      // re-check, a focus refetch, a Retry) may have read a replica flipping
      // back, so whatever it answered files the second check, deadline kept.
      if (prior?.proof === "moved" && startedAt < prior.recheckAt)
        return {
          proof: "moved",
          text: prior.text,
          checks: PR_DIFF_MOVED_CHECKS - 1,
          recheckAt: prior.recheckAt,
          afterDetails,
        };
      if (proof !== "moved")
        return answeredRead(proof, answer.diff, afterDetails);
      if (prior?.proof !== "moved")
        return {
          proof: "moved",
          text: prior?.text ?? null,
          checks: 1,
          recheckAt: performance.now() + PR_DIFF_MOVED_RECHECK_MS,
          afterDetails,
        };
      return {
        proof: "moved",
        text: prior.text,
        checks: PR_DIFF_MOVED_CHECKS,
        recheckAt: prior.recheckAt,
        endedAt: prior.endedAt ?? performance.now(),
        afterDetails,
      };
    },
    // An unproven or moved entry is stale at once, so any re-read retries it.
    staleTime: (query) => (query.state.data?.proof === "proven" ? 30_000 : 0),
    // Off once the check ended, and while a re-check failed: its Retry restarts
    // it, where an interval would loop on the failure.
    refetchInterval: (query) => {
      const read = query.state.data;
      if (read?.proof !== "moved" || query.state.error !== null) return false;
      if (read.checks >= PR_DIFF_MOVED_CHECKS) return false;
      // None while a read runs or parks: query-core recomputes the interval
      // on its status updates, where a passed deadline would tick every 1 ms.
      // The read's own idle update schedules what remains.
      if (query.state.fetchStatus !== "idle") return false;
      if (read.checks === 1) return PR_DIFF_MOVED_FIRST_RECHECK_MS;
      // Every query update restarts the interval, so it aims at `recheckAt`,
      // rounded up: a timer can fire on the whole millisecond below a fraction,
      // and a run started before the deadline never decides.
      return Math.max(1, Math.ceil(read.recheckAt - performance.now()));
    },
    // Polls keep running while the window is unfocused.
    refetchIntervalInBackground: true,
    retry: shouldRetryQuery,
  });
};

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

/** The divergence key's repo+PR segments; `prBaseDivergenceKey` adds the lens.
 *  A SIBLING of the PR subtree rather than a child, so `["repo", repo, "pr", …]`
 *  does not prefix-cover it: a write names the full key, since the other lens's
 *  PR at the same number is a different pull request. */
export const prBaseDivergencePrefix = (repo: string, number: number) =>
  ["repo", repo, "pr-base-divergence", number] as const;

/** The full key `usePrBaseDivergence` reads — the prefix plus its lens axis. */
export const prBaseDivergenceKey = (
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

/** What `data` is when it is not this key's own answer: this pull request's
 *  diff read at a head the details no longer name, or another record's. */
export type PrDiffPlaceholder = "none" | "olderHead" | "otherRecord";

/** The head axis while the details have not answered: no forge sha can equal
 *  it, and `null` is a head-less merge request's real key. */
const PR_DIFF_HEAD_UNANSWERED = "(unanswered)";

/** The one error a check that ended with no own text presents. */
const MOVED_ERROR = new PrDiffMovedError();

interface OwnPrDiff {
  repo: string;
  lens: RemoteLens;
  number: number | null;
  text: string;
}

const sameOwnPrDiff = (a: OwnPrDiff | null, b: OwnPrDiff) =>
  a !== null &&
  a.repo === b.repo &&
  a.lens === b.lens &&
  a.number === b.number &&
  a.text === b.text;

/** The diff read as its callers see it. Every status field describes the
 *  presented `data`: a check under way reads as a load in progress, and a
 *  check that ended with no own text as a failure. */
export interface PrDiffResult {
  data: string | undefined;
  error: unknown;
  isError: boolean;
  isPending: boolean;
  isPaused: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  refetch: () => Promise<unknown>;
  placeholderOf: PrDiffPlaceholder;
  /** The shown text is this key's own answer (never a retained or a
   *  placeholder text) and no head read has proven it, or its moved check
   *  ended. An older head's text keeps the older head's arms instead. */
  headUnproven: boolean;
  /** The forge answered another head or base and the entry's check has not
   *  ended, with or without a text of this key shown. Read from the data, so
   *  a failed or parked re-check still holds. */
  headChecking: boolean;
  /** A full head has no own answer of this target yet: its first read is
   *  under way, failed or parked. Read from the key's own entry, never a
   *  placeholder's; an older head's kept text holds on its own arms instead. */
  headProving: boolean;
  /** The target names no full head off Bitbucket, so no read can tie a text
   *  to one: it holds whatever the read's state (cold, in flight, failed,
   *  parked or answered) until the details name the full commit. */
  headUnnamed: boolean;
}

/** A placeholder stamped with its owner where query-core hands over the
 *  previous query, so no render-time copy decides it. */
type StampedPrDiffRead = PrDiffRead & {
  placeholderOf?: Exclude<PrDiffPlaceholder, "none">;
};

const stampedOwner = (read: PrDiffRead | undefined) =>
  read !== undefined && "placeholderOf" in read
    ? (read as StampedPrDiffRead).placeholderOf
    : undefined;

/** The ended check each diff entry last asked the details to re-read for, by
 *  the check's `endedAt`: one hint per ended check, claimed by the first view
 *  that sees it, however many mount and whenever. */
const hintedChecks = new WeakMap<object, number>();

/** `target` undefined: the details have not named one yet, and the read waits. */
export function usePrDiff(
  repo: string,
  number: number | null,
  lens: RemoteLens,
  target: PrDiffTarget | undefined,
): PrDiffResult {
  const queryClient = useQueryClient();
  const head = target?.head;
  const baseRef = target?.baseRef;
  const baseSha = target?.baseSha;
  const byNumberProven = target?.byNumberProven === true;
  // Keyed on the target's fields, never its identity: callers derive a fresh
  // object every render, which would update the observer's options each time.
  const named = target !== undefined;
  const keyTarget = useMemo<PrDiffTarget>(
    () =>
      named
        ? {
            head: head ?? null,
            baseRef: baseRef ?? "",
            baseSha: baseSha ?? null,
            byNumberProven,
          }
        : {
            head: PR_DIFF_HEAD_UNANSWERED,
            baseRef: "",
            baseSha: null,
            byNumberProven: false,
          },
    [named, head, baseRef, baseSha, byNumberProven],
  );
  const options = prDiffOptions(repo, number ?? 0, lens, keyTarget);
  const diffHash = hashKey(options.queryKey);
  const keepLens = keepPreviousDataForKeyAxes(repo, [[3, lens]]);
  const query = useQuery({
    ...options,
    enabled: number !== null && target !== undefined,
    // Lens axis mirrors usePrDetails; the number AND target axes stay
    // placeholder-served, and `placeholderOf` tells a head move from a PR switch.
    // Ownership is the previous query's repo, lens and number, never a text
    // compare: a re-key batched before React renders can hand over an entry
    // this render never drew. A textless entry is served only to its own record.
    placeholderData: (previous, previousQuery) => {
      const kept = keepLens(previous, previousQuery);
      if (kept === undefined) return undefined;
      const ownRecord = previousQuery?.queryKey[4] === (number ?? 0);
      if (kept.text === null && !ownRecord) return undefined;
      const stamped: StampedPrDiffRead = {
        ...kept,
        placeholderOf: ownRecord ? "olderHead" : "otherRecord",
      };
      return stamped;
    },
  });
  // The details' last answer, observed without fetching.
  const detailsAt = useQuery({
    ...prDetailsOptions(repo, number ?? 0, lens),
    enabled: false,
    notifyOnChangeProps: ["dataUpdatedAt"],
  }).dataUpdatedAt;
  const read = query.isPlaceholderData ? undefined : query.data;
  const checking =
    read?.proof === "moved" && read.checks < PR_DIFF_MOVED_CHECKS;
  const movedEnded = read?.proof === "moved" && !checking;
  const ownText = read?.text ?? undefined;
  // Only this record's own entries are served textless (`placeholderData`).
  const owner = query.isPlaceholderData ? stampedOwner(query.data) : undefined;
  // Text drawn for this record, its own entry's or a placeholder stamped as one
  // of its older heads: retention keeps the last one shown. Its proof and
  // placeholder status stay the shown entry's, never this memory's.
  const drawnText =
    ownText ??
    (owner === "olderHead" ? (query.data?.text ?? undefined) : undefined);
  const current: OwnPrDiff | null =
    drawnText === undefined ? null : { repo, lens, number, text: drawnText };
  // The live query's last drawn text for this record, adjusted during render.
  const [lastOwn, setLastOwn] = useState<OwnPrDiff | null>(null);
  if (current && !sameOwnPrDiff(lastOwn, current)) setLastOwn(current);
  const own = current ?? lastOwn;
  const sameRecord =
    own !== null &&
    own.repo === repo &&
    own.lens === lens &&
    own.number === number;
  const ownTextlessPlaceholder =
    owner === "olderHead" && query.data?.text === null;
  // A failed first read of a new head, and a moved one with no own text (its
  // own entry, or this record's textless entry standing in as a placeholder),
  // keep this pull request's last own diff, so the pane never swaps to its
  // no-data arm. The entry's own data shuts out another record's text.
  const retained =
    sameRecord &&
    ((read !== undefined && ownText === undefined) ||
      ownTextlessPlaceholder ||
      (query.data === undefined && query.isError && !query.isFetching));
  // This record's textless placeholder with no drawable text: a cold load.
  const textlessCold = ownTextlessPlaceholder && !retained;
  let placeholderOf: PrDiffPlaceholder = "none";
  if (retained) placeholderOf = "olderHead";
  else if (query.isPlaceholderData && !textlessCold)
    placeholderOf = owner ?? "otherRecord";
  const holdsOwn = ownText !== undefined;
  // A textless placeholder's null reads as no text.
  const data = retained ? own?.text : (query.data?.text ?? undefined);
  const isPlaceholderData =
    retained || (query.isPlaceholderData && !textlessCold);
  const endedBare = movedEnded && ownText === undefined;
  const isError = query.isError || endedBare;
  const fullHead =
    head !== undefined && head !== null && FULL_OID_RE.test(head);
  const headProving =
    fullHead && number !== null && read === undefined && !retained;
  // Derived from the target alone, never the read's state.
  const headUnnamed =
    target !== undefined && number !== null && !fullHead && !byNumberProven;
  // A check under way is a load in progress until a re-check fails or parks.
  const checkWaits = checking && query.error === null && !query.isPaused;
  // Once this target's own answer landed, the pull request's diff entries of
  // other targets go: dead weight, or another head's text after a repo-wide
  // refetch. A cold load in flight is spared, since a removal would reject its
  // waiter.
  useEffect(() => {
    if (!holdsOwn || number === null || head === undefined) return;
    queryClient.removeQueries({
      queryKey: [...prDetailsOptions(repo, number, lens).queryKey, "diff"],
      predicate: (q) =>
        !(
          q.queryKey[6] === head &&
          q.queryKey[7] === baseRef &&
          q.queryKey[8] === baseSha
        ) &&
        q.getObserversCount() === 0 &&
        !(q.state.fetchStatus !== "idle" && q.state.data === undefined),
    });
  }, [queryClient, repo, lens, number, head, baseRef, baseSha, holdsOwn]);
  // A held entry (unproven, or a check that ended) reads again while the
  // details hold an answer its run started before, so it checks again when the
  // pull request refreshes, even when that answer landed mid-run.
  const awaitsDetails = read?.proof === "unproven" || movedEnded;
  const readAfter = read?.afterDetails;
  const answeredAt = query.dataUpdatedAt;
  const refetch = query.refetch;
  // biome-ignore lint/correctness/useExhaustiveDependencies: every answer re-asks (`answeredAt`), since structural sharing keeps a joined run's equal answer as the same entry.
  useEffect(() => {
    if (awaitsDetails && readAfter !== detailsAt)
      void refetch({ cancelRefetch: false });
  }, [awaitsDetails, readAfter, detailsAt, answeredAt, refetch]);
  // The accepted entry that ends a check asks the details to re-read, once
  // per ended check, so a real push re-keys the view. A superseded run's
  // answer is never accepted, so it asks nothing.
  const endedAt = read?.proof === "moved" ? (read.endedAt ?? 0) : 0;
  useEffect(() => {
    if (endedAt === 0 || number === null) return;
    const entry = queryClient.getQueryCache().get(diffHash);
    if (entry === undefined || hintedChecks.get(entry) === endedAt) return;
    hintedChecks.set(entry, endedAt);
    void queryClient
      .invalidateQueries({
        queryKey: prDetailsOptions(repo, number, lens).queryKey,
        exact: true,
      })
      .catch(() => undefined);
  }, [queryClient, diffHash, endedAt, repo, number, lens]);
  return {
    data,
    error: query.error ?? (endedBare ? MOVED_ERROR : null),
    isError,
    isPending:
      query.isPending ||
      textlessCold ||
      (checking && data === undefined && !isError),
    isPaused: query.isPaused,
    isFetching: query.isFetching || checkWaits,
    isPlaceholderData,
    // A Retry over an ended check also re-reads the details: the push it
    // missed may be what the forge now names.
    refetch: () => {
      if (movedEnded && number !== null)
        void queryClient
          .invalidateQueries({
            queryKey: prDetailsOptions(repo, number, lens).queryKey,
            exact: true,
          })
          .catch(() => undefined);
      return refetch();
    },
    placeholderOf,
    headUnproven:
      !checking &&
      !isPlaceholderData &&
      (read?.proof === "unproven" || movedEnded),
    headChecking: checking,
    headProving,
    headUnnamed,
  };
}

// File:line-anchored review threads (Copilot/CodeRabbit/human line comments); the
// data serves both the Conversation grouping and the Files diff anchors, so it
// lives at the PR top level. The entry is the whole ReviewThreadsOut: optimistic
// writers patch `.threads` and carry `threadsTruncated` through untouched.
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
    {
      invalidate: workingTreeKeys(repo),
      // Local working-tree write — never park it offline.
      networkMode: "always",
    },
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

/** The commit-comments read {@link useCommitComments} spreads. */
export const commitCommentsOptions = (
  repo: string,
  sha: string,
  lens: RemoteLens,
) =>
  queryOptions({
    queryKey: commitCommentsKey(repo, sha, lens),
    queryFn: () => api.forgeCommitComments(repo, sha, lens),
    staleTime: 30_000,
  });

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
    ...commitCommentsOptions(repo, sha ?? "", lens),
    enabled: sha !== null,
  });
}

/** Shared by {@link useCommitOnRemote} and the commit prefetch so the two can't
 *  drift. A push flips the verdict, hence the short stale window. */
export const commitOnRemoteOptions = (repo: string, sha: string) =>
  queryOptions({
    queryKey: ["repo", repo, "commit", sha, "on-remote"] as const,
    queryFn: () => api.commitOnRemote(repo, sha),
    staleTime: 30_000,
    // A local `git for-each-ref` read: the default "online" mode would park it.
    networkMode: "always",
  });

/** Whether a commit lives on any remote — gates the History-tab commit-comment surface
 *  (you can only comment on a commit the forge already has); pass `sha: null` when no
 *  commit is selected. The previous commit's verdict is held while the next resolves,
 *  so callers must gate forge reads/writes on `!isPlaceholderData`. */
export function useCommitOnRemote(repo: string, sha: string | null) {
  return useQuery({
    ...commitOnRemoteOptions(repo, sha ?? ""),
    enabled: sha !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** The forge's own unified diff for a commit, PR-independent. GitHub commit-comment
 *  `position` mapping must walk GitHub's own patch rather than local git's (rename
 *  detection etc. can differ), so this fetches the provider's diff. Pass `sha: null`
 *  to keep it cold until the diff is needed. Never stale: a commit's diff is fixed
 *  by its SHA. */
export function useRemoteCommitDiff(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "remote-diff"] as const,
    queryFn: () => api.forgeCommitDiff(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

const commitCommentsKey = (repo: string, sha: string, lens: RemoteLens) =>
  ["repo", repo, "commit", sha, "comments", lens] as const;

/** Filter prefix for every commit-comment write ({@link commitCommentWriteKey}). */
export const COMMIT_COMMENT_WRITES_FAMILY = "commit-comment-write";

/** A commit-comment write's mutation key: static per repo and lens, so a commit
 *  switch never detaches a pending write; the commit rides the variables (`sha`). */
export const commitCommentWriteKey = (
  kind: "create" | "edit" | "delete",
  repo: string,
  lens: RemoteLens,
) => [COMMIT_COMMENT_WRITES_FAMILY, kind, repo, lens] as const;

/** Each commit-comment write's variables, shared by the mutations' generics and
 *  the pending reads' casts. A line comment's create carries `path`; a
 *  whole-commit one never does. */
export type CommitCommentWriteVars = {
  create: {
    sha: string;
    body: string;
    path?: string;
    line?: number;
    startLine?: number;
    position?: number;
  };
  edit: { sha: string; commentId: string; body?: string };
  delete: { sha: string; commentId: string };
};

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
    // Pinned: the call, the optimistic patch, its rollback and the invalidation
    // all close over `repo`/`lens`, and the comment hosts survive a repo switch —
    // without the key the newly-live repo's controls would read the pending
    // create as busy.
    mutationKey: commitCommentWriteKey("create", repo, lens),
    mutationFn: (args: CommitCommentWriteVars["create"]) =>
      api.forgeCommitCommentCreate(repo, args, lens),
    onMutate: async (args: CommitCommentWriteVars["create"]) => {
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
    onSettled: () => void invalidateRepoAfterWrite(queryClient, repo),
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
  mutationKey?: QueryKey,
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
    (queryClient) => void invalidateRepoAfterWrite(queryClient, repo),
    mutationKey,
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
    commitCommentWriteKey("edit", repo, lens),
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
    commitCommentWriteKey("delete", repo, lens),
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
    // Pinned: the call, the optimistic patch, its rollback and the invalidation
    // all close over `repo`/`lens`, and the composer's host survives a repo
    // switch — without the key the newly-live repo's controls would read the
    // pending create as busy.
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
      const prev = queryClient.getQueryData<ReviewThreadsOut>(key);
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
      queryClient.setQueryData<ReviewThreadsOut>(key, (out) =>
        out ? { ...out, threads: [...out.threads, synthetic] } : out,
      );
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => void invalidateRepoAfterWrite(queryClient, repo),
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
    // The PR rides the variables, so the dialog reopened on it after a switch
    // still finds this submit in the cache and holds Submit.
    { identity: prWriteKey("submit-review", repo) },
  );
}

// The PR rides the variables, which `pendingThreadWritesFor` matches the thread
// holds on, and the key pins `repo`, so a hold never crosses repos.
export function useThreadReply(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["thread-reply", repo],
    mutationFn: (args: ThreadWriteVars & { body: string }) =>
      api.forgePrThreadReply(repo, args.number, args.threadId, args.body),
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: prReviewThreadsKey(repo, args.number, args.lens),
      }),
  });
}

export function useThreadResolve(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["thread-resolve", repo],
    mutationFn: (args: ThreadWriteVars & { resolved: boolean }) =>
      api.forgePrThreadResolve(repo, args.number, args.threadId, args.resolved),
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: prReviewThreadsKey(repo, args.number, args.lens),
      }),
  });
}

/** One thread's in-flight write of a kind; an entry exists only while one is
 *  pending, and `paused` says whether any of it is parked offline. */
export interface ThreadWriteState {
  paused: boolean;
}

/** In-flight thread replies and resolves on one PR, keyed by thread id. */
export interface PendingThreadWrites {
  reply: Record<string, ThreadWriteState>;
  resolve: Record<string, ThreadWriteState>;
}

const NO_PENDING_THREAD_WRITES: PendingThreadWrites = {
  reply: {},
  resolve: {},
};

/**
 * The thread replies and resolves on PR `number` (in `lens`) that are in flight.
 * Read from the mutation cache, through {@link useMutationCacheSnapshot}, because a
 * card's own pending flag dies with a remount, and a second press would then queue
 * a duplicate write.
 */
export function usePendingThreadWrites(
  repo: string,
  number: number,
  lens: RemoteLens,
): PendingThreadWrites {
  const select = useCallback(
    (cache: MutationCache) =>
      pendingThreadWritesFor(
        pendingMutationEntries([
          ...cache.findAll({
            mutationKey: ["thread-reply"],
            status: "pending",
          }),
          ...cache.findAll({
            mutationKey: ["thread-resolve"],
            status: "pending",
          }),
        ]),
        repo,
        number,
        lens,
      ),
    [repo, number, lens],
  );
  return useMutationCacheSnapshot(select, NO_PENDING_THREAD_WRITES);
}

/** Warms a remote PR's view (metadata + diff) on row hover and adjacent rows — PR data
 *  is the slowest load in the app, so prefetching pays off most here. */
export function usePrefetchPr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      // The diff waits for the head its details name; best-effort throughout.
      queryClient
        .fetchQuery(prDetailsOptions(repo, number, lens))
        .then((pr) =>
          queryClient.prefetchQuery(
            prDiffOptions(repo, number, lens, prDiffTarget(pr)),
          ),
        )
        .catch(() => undefined);
    },
    [queryClient, repo, lens],
  );
}

/** The children of a pull request's subtree a list Refresh leaves alone. */
export const OPEN_PR_REFRESH_SKIPS: ReadonlySet<string> = new Set([
  "commit-diff",
  "review-drafts",
  "resolve-worktree",
]);

/** Its head-keyed children: never re-read by prefix, only by the exact key of
 *  the head the details name once they have answered. */
export const OPEN_PR_HEAD_KEYED: ReadonlySet<string> = new Set([
  "diff",
  "content-revs",
]);

/** Re-reads the open pull request by invalidation only: a cancel would reject a
 *  cold load's waiter (an AI run awaiting the diff). The head-keyed reads wait
 *  for the details, then address that head's exact keys: the diff observer is
 *  still on the previous head's key until it re-renders, so a prefix would
 *  refetch it and file the new head's text under the old head. Only a details
 *  answer this press landed names a head: a failed or parked read's retained
 *  data may predate a push, and the next answer re-keys. */
export async function refreshOpenPr(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  number: number,
): Promise<void> {
  const details = prDetailsOptions(repo, number, lens).queryKey;
  const landedBefore = queryClient.getQueryState(details)?.dataUpdateCount ?? 0;
  const settled = queryClient
    .invalidateQueries({ queryKey: details, exact: true })
    .catch(() => undefined);
  queryClient
    .invalidateQueries({
      queryKey: details,
      predicate: (q) => {
        const child = q.queryKey[5];
        return (
          q.queryKey.length > 5 &&
          !(
            typeof child === "string" &&
            (OPEN_PR_REFRESH_SKIPS.has(child) || OPEN_PR_HEAD_KEYED.has(child))
          )
        );
      },
    })
    .catch(() => undefined);
  queryClient
    .invalidateQueries({ queryKey: prBaseDivergenceKey(repo, number, lens) })
    .catch(() => undefined);
  await settled;
  const after = queryClient.getQueryState(details);
  if (after?.status !== "success" || after.dataUpdateCount === landedBefore)
    return;
  const pr = queryClient.getQueryData(details);
  if (pr === undefined) return;
  const target = prDiffTarget(pr);
  queryClient
    .invalidateQueries({
      queryKey: prDiffOptions(repo, number, lens, target).queryKey,
      exact: true,
    })
    .catch(() => undefined);
  // A head-less record has no revs entry: its read is disabled under "".
  if (target.head !== null)
    queryClient
      .invalidateQueries({
        queryKey: prContentRevsOptions(repo, number, lens, {
          ...target,
          head: target.head,
        }).queryKey,
        exact: true,
      })
      .catch(() => undefined);
}

/** {@link usePrReactions}'s query options. */
export const prReactionsOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  queryOptions({
    queryKey: repoKeys.reactions(repo, ["pr", lens, number]),
    queryFn: () => api.forgePrReactions(repo, number, lens),
    staleTime: 30_000,
  });

/** Reactions for a PR's body + comments — decoupled from the PR view so it
 *  loads in parallel and leaves the (untouched) PR query alone. */
export function usePrReactions(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...prReactionsOptions(repo, number ?? 0, lens),
    enabled: number !== null,
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
  return useOptimisticCreateCommentMutation(
    repo,
    "issue",
    lens,
    (args) =>
      api.forgeIssueComment(
        repo,
        args.number,
        args.body,
        lens,
        args.attachments,
      ),
    issueWriteKey("comment", repo),
  );
}

export function useCommentPr(repo: string, lens: RemoteLens) {
  return useOptimisticCreateCommentMutation(
    repo,
    "pr",
    lens,
    (args) =>
      api.forgePrComment(
        repo,
        args.number,
        args.body,
        args.asBot,
        lens,
        args.attachments,
      ),
    prWriteKey("comment", repo),
  );
}

/** Monotonic counter for synthetic optimistic-comment ids — combined with the
 *  `optimistic:` prefix it can never collide with a real provider node id. */
let optimisticCommentSeq = 0;

/** Each attachment post's thread comment ids from just before its optimistic
 *  row went in (null: no thread data then), by the mutation's variables, so the
 *  watcher seeds only a row the post could have made. */
const commentIdsBeforePost = new WeakMap<object, ReadonlySet<string> | null>();

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
  // `asBot` posts as the configured GitLab review-bot identity (ignored elsewhere);
  // never combined with `attachments`, which Rust refuses for the bot.
  mutationFn: (args: {
    number: number;
    body: string;
    asBot?: boolean;
    attachments?: AttachmentRefs;
  }) => Promise<TData>,
  mutationKey?: QueryKey,
) {
  const keyFor = (args: { number: number }) =>
    ["repo", repo, kind, lens, args.number] as const;
  return useOptimisticCacheMutation<
    {
      number: number;
      body: string;
      author: string;
      asBot?: boolean;
      attachments?: AttachmentRefs;
      /** The post ticket's token, carried by the optimistic row only. */
      postToken?: string;
    },
    TData,
    PrDetails | IssueDetails
  >(
    (args) => mutationFn(args),
    keyFor,
    (d, args) => {
      // Runs once, inside onMutate's write: `d` is the data before this row.
      if (args.attachments && args.postToken)
        commentIdsBeforePost.set(
          args,
          d ? new Set(d.comments.map((c) => c.id)) : null,
        );
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
        // Shows this post's staged images until the server row replaces it.
        ...(args.attachments && args.postToken
          ? { postToken: args.postToken }
          : {}),
      };
      return d ? { ...d, comments: [...d.comments, synthetic] } : d;
    },
    (queryClient, args) => {
      // Subscribed before the refetch starts, so its settle is the first one seen.
      if (args.attachments && args.postToken)
        watchPostedCopies(
          queryClient,
          keyFor(args),
          args.postToken,
          args.body,
          commentIdsBeforePost.get(args) ?? null,
        );
      void invalidateRepoAfterWrite(queryClient, repo);
    },
    mutationKey,
  );
}

// Whole-file reads for pull request diffs (expand context, image previews).
// None keeps previous data: another head's or pull request's revs never serve.

/** How long an unobserved by-sha forge read stays cached: a sha's bytes never
 *  change, and the bound keeps up to 20 MB per image out of session memory. */
export const FORGE_SHA_READ_GC_MS = 30 * 60_000;

/** A refusal (`invalidArgument`) answers the same every time. */
const retryUnlessRefused = (failureCount: number, error: unknown) =>
  !(isAppError(error) && error.kind === "invalidArgument") &&
  shouldRetryQuery(failureCount, error);

/** A pull request's content revs at one diff target: its merge base and that
 *  head. Keyed on the same target as the diff, so a retarget re-reads the base.
 *  In the PR subtree, so it refreshes with the diff. */
export const prContentRevsOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
  target: PrDiffTarget & { head: string },
) =>
  queryOptions({
    queryKey: [
      "repo",
      repo,
      "pr",
      lens,
      number,
      "content-revs",
      target.head,
      target.baseRef,
      target.baseSha,
    ] as const,
    queryFn: () =>
      api.forgePrContentRevs(
        repo,
        number,
        lens,
        target.head,
        target.baseRef,
        target.baseSha,
      ),
    staleTime: 30_000,
    retry: retryUnlessRefused,
  });

/** A head-less target keeps a disabled entry under an empty head. */
export function usePrContentRevs(
  repo: string,
  number: number,
  lens: RemoteLens,
  target: PrDiffTarget | null,
  enabled: boolean,
) {
  return useQuery({
    ...prContentRevsOptions(repo, number, lens, {
      head: target?.head ?? "",
      baseRef: target?.baseRef ?? "",
      baseSha: target?.baseSha ?? null,
    }),
    enabled: enabled && !!target?.head,
  });
}

/** A commit's first parent from the forge (null: a root commit). Outside the
 *  `["repo", …]` subtree: a commit's parents never change, so a repo-wide
 *  invalidation never re-reads them. */
export const commitFirstParentOptions = (
  repo: string,
  lens: RemoteLens,
  oid: string,
) =>
  queryOptions({
    queryKey: ["forge-commit-parent", repo, lens, oid] as const,
    queryFn: () => api.forgeCommitFirstParent(repo, oid, lens),
    staleTime: Infinity,
    gcTime: FORGE_SHA_READ_GC_MS,
    retry: retryUnlessRefused,
  });

export function useCommitFirstParent(
  repo: string,
  lens: RemoteLens,
  oid: string,
  enabled: boolean,
) {
  return useQuery({ ...commitFirstParentOptions(repo, lens, oid), enabled });
}

/** One file's bytes at a sha, from the forge (null: absent at that commit).
 *  `maxBytes` (null: the 20 MB image cap) keys the read, so content mode's
 *  budgeted read never serves an image's. Outside the `["repo", …]` subtree
 *  for the same reason as the parent read. */
export const forgeFileAtShaOptions = (
  repo: string,
  lens: RemoteLens,
  sha: string,
  file: string,
  maxBytes: number | null,
) => ({
  queryKey: ["forge-file-at-sha", repo, lens, sha, file, maxBytes] as const,
  queryFn: () => api.forgeFileAtSha(repo, sha, file, lens, maxBytes),
  staleTime: Infinity,
  gcTime: FORGE_SHA_READ_GC_MS,
  retry: retryUnlessRefused,
});

/** The `-w` hunks of one file's two versions, as read for a forge-patch diff
 *  (`sides`: each version's base64 as read, null where absent). Keyed on the
 *  reads' identity, never the bytes; outside the `["repo", …]` subtree, since
 *  a rev pair's diff never changes. A local git run, so it never parks. */
export const prWhitespaceHunksOptions = (
  reads: {
    repo: string;
    sourceKey: string;
    oldRev: string | undefined;
    oldPath: string;
    newRev: string;
    path: string;
  },
  sides: { old: string | null; new: string | null },
) =>
  queryOptions({
    queryKey: [
      "pr-whitespace-hunks",
      reads.repo,
      reads.sourceKey,
      reads.oldRev ?? null,
      reads.oldPath,
      reads.newRev,
      reads.path,
    ] as const,
    queryFn: () => api.gitDiffBytesIgnoringWhitespace(sides.old, sides.new),
    staleTime: Infinity,
    gcTime: FORGE_SHA_READ_GC_MS,
    networkMode: "always",
  });
