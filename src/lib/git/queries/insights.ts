import {
  type InfiniteData,
  type Query,
  type QueryClient,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { OFFLINE_PARK_META } from "@/lib/offline-park";
import type { StarHistoryPage } from "../api";
import * as api from "../api";
import type { ForgeStatus } from "../types";
import {
  invalidateKeyHealingStraddles,
  keepPreviousDataForRepo,
  repoKeys,
  settlesOnRepoWrite,
} from "./core";

/** Repo-wide stats; the scan is heavy, so only fetch while the dialog is up. */
export function useRepoStats(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "stats"] as const,
    queryFn: () => api.gitRepoStats(repo),
    enabled,
    staleTime: 5 * 60_000,
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
  });
}

export function useBranchStats(
  repo: string,
  branch: string | null,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "branch-stats", branch ?? "", base ?? ""] as const,
    queryFn: () => api.gitBranchStats(repo, branch ?? "", base ?? ""),
    enabled: enabled && branch !== null && base !== null && branch !== base,
    staleTime: 60_000,
    networkMode: "always",
  });
}

// ── Insights graphs ──────────────────────────────────────────────────────────
// All keyed on the trailing window (`weeks`) so toggling it refetches. The local
// graphs keep the other window's data as placeholder meanwhile (same repo only),
// so a toggle never drops a card back to its skeleton; consumers dim on
// `isPlaceholderData`. The gh community call is gated on a GitHub repo.

export function useContributorActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "contributors", weeks] as const,
    queryFn: () => api.gitContributorActivity(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCommitActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "commit-activity", weeks] as const,
    queryFn: () => api.gitCommitActivity(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCodeFrequency(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "code-frequency", weeks] as const,
    queryFn: () => api.gitCodeFrequency(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function usePunchCard(repo: string, weeks: number, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "punch-card", weeks] as const,
    queryFn: () => api.gitPunchCard(repo, weeks),
    placeholderData: keepPreviousDataForRepo(repo),
    enabled,
    staleTime: 5 * 60_000,
    networkMode: "always",
  });
}

export function useCommunityInsights(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: repoKeys.communityInsights(repo),
    queryFn: () => api.ghCommunityInsights(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoTraffic(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "traffic"] as const,
    queryFn: () => api.ghRepoTraffic(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useForkActivity(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "forks"] as const,
    queryFn: () => api.forgeForkActivity(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Ahead/behind for ONE fork, keyed per fork *and* per branch pair so a default-branch
 *  change can't serve the previous pair's counts. `enabled` carries the row's explicit
 *  request — nothing compares until the user asks — and both branch names must be
 *  known to have a comparison at all. */
export function useForkDivergence(
  repo: string,
  forkFullName: string,
  baseBranch: string | null,
  forkBranch: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "insights",
      "fork-compare",
      forkFullName,
      baseBranch ?? "",
      forkBranch ?? "",
    ] as const,
    queryFn: () =>
      api.forgeForkDivergence(
        repo,
        forkFullName,
        baseBranch ?? "",
        forkBranch ?? "",
      ),
    enabled: enabled && !!baseBranch && !!forkBranch,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoDependencies(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "dependencies"] as const,
    queryFn: () => api.ghRepoDependencies(repo),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** A failed older page, kept where that page belongs in the read's pages: the
 *  read stays a success over the pages before it, so it ages and refreshes as
 *  usual. Never on the wire; `reason` is the failure the board quotes. */
export interface StarHistoryMarker {
  failed: true;
  page: number;
  reason: unknown;
}

export type StarHistoryEntry = StarHistoryPage | StarHistoryMarker;

function isStarMarker(
  page: StarHistoryEntry | undefined,
): page is StarHistoryMarker {
  return page !== undefined && "failed" in page;
}

const STAR_FIRST_PAGE = 1;

/** The series a checkout's star history reads, `<host>/<owner>/<repo>`: the
 *  host and repository its forge status names (`useForgeStatus`, which every
 *  whole-repo write settle refreshes, fork and origin set-url included), or
 *  null off GitHub. One spelling for the key, the writers' match and the Retry. */
export function starHistorySeries(
  status: ForgeStatus | undefined,
): string | null {
  return status?.provider === "github" &&
    typeof status.host === "string" &&
    typeof status.repo === "string"
    ? `${status.host}/${status.repo}`
    : null;
}

/** A series' host and slug, split at the first `/` (a host has none). */
function starSeriesParts(series: string | null): {
  host: string;
  slug: string;
} {
  const at = series?.indexOf("/") ?? -1;
  return series === null || at < 0
    ? { host: "", slug: "" }
    : { host: series.slice(0, at), slug: series.slice(at + 1) };
}

/** The repo's star history, one GitHub page (≤30 weeks) per fetch; the card
 *  drives how many pages load. Keyed by the series it reads, so a new origin
 *  is a fresh series and no series holds two repositories' pages; no window axis,
 *  since the 52-week view is the newest pages of the same series. The long
 *  staleTime matches the other expensive read: a refetch re-requests every
 *  loaded page in sequence. */
export function useStarHistory(
  repo: string,
  series: string | null,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: repoKeys.starHistory(repo, series),
    // Page 1 rejects, so a failed first load or refresh is the read's error; a
    // deeper page resolves to a marker. Told apart by the page asked for, which
    // each call carries, never by the fetch kind, which query-core doesn't
    // promise per call. Only a Load more or a refetch walk asks a deeper page.
    queryFn: async ({ pageParam }): Promise<StarHistoryEntry> => {
      const { host, slug } = starSeriesParts(series);
      try {
        return await api.ghStarHistoryPage(repo, pageParam, slug, host);
      } catch (reason) {
        if (pageParam === STAR_FIRST_PAGE) throw reason;
        return { failed: true, page: pageParam, reason };
      }
    },
    // The offline park's refetch would re-walk every loaded page on reconnect
    // to recover a failed refresh; its Retry does so only when pressed.
    meta: { [OFFLINE_PARK_META]: false },
    initialPageParam: STAR_FIRST_PAGE,
    // Only the page after the one just fetched, within the API's 100 pages,
    // drives another fetch: the backend already refuses any other "next", so
    // this is defense in depth. A marker drives none until its Retry.
    getNextPageParam: (last, _pages, lastPageParam) =>
      !isStarMarker(last) &&
      last.nextPage !== null &&
      last.nextPage === lastPageParam + 1 &&
      last.nextPage <= 100
        ? last.nextPage
        : undefined,
    enabled: enabled && series !== null,
    // "static" while a failed refresh keeps loaded pages: an error marks the
    // read invalidated, stale under any numeric staleTime, so focus, reconnect,
    // a remount or a switch back would re-walk every page. Static also makes
    // invalidate/refetchQueries only mark it; its Retry (a refetch) still runs.
    staleTime: (query) => (failedOverPages(query) ? "static" : 30 * 60_000),
    retry: false,
  });
}

type StarRetryFetch = (options: { cancelRefetch: boolean }) => Promise<unknown>;

/** The star read's Retry; both arms join a fetch in flight. A failed refresh
 *  outranks a marker: it re-walks from page 1, which refills the marker's
 *  place too. A marker alone is dropped, keeping the read's stale clock, and
 *  its page asked again; a second failure leaves a marker, nothing re-asks. */
export function retryStarHistory(
  queryClient: QueryClient,
  repo: string,
  series: string | null,
  read: { refetch: StarRetryFetch; fetchNextPage: StarRetryFetch },
): Promise<unknown> {
  const queryKey = repoKeys.starHistory(repo, series);
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  const data = query?.state.data as
    | InfiniteData<StarHistoryEntry, number>
    | undefined;
  if (
    !query ||
    query.state.status === "error" ||
    !data ||
    !isStarMarker(data.pages[data.pages.length - 1])
  )
    return read.refetch({ cancelRefetch: false });
  queryClient.setQueryData<InfiniteData<StarHistoryEntry, number>>(
    queryKey,
    {
      pages: data.pages.slice(0, -1),
      pageParams: data.pageParams.slice(0, -1),
    },
    { updatedAt: query.state.dataUpdatedAt },
  );
  return read.fetchNextPage({ cancelRefetch: false });
}

/** The series `repo`'s cached forge status names now, or null. */
export function cachedStarSeries(
  queryClient: QueryClient,
  repo: string,
): string | null {
  // useForgeStatus's key (accounts.ts).
  return starHistorySeries(
    queryClient.getQueryData<ForgeStatus>(["repo", repo, "forge-status"]),
  );
}

/** Every cached star history of `series`, sibling checkouts' included: one
 *  repository on one host, by construction of the key. With no series, `repo`'s
 *  own reads. The match ignores case, as GitHub's slugs do: a checkout whose
 *  status still spells a renamed repo's old casing is the same series. */
function cachedStarHistories(
  queryClient: QueryClient,
  repo: string,
  series: string | null,
): Query[] {
  return queryClient.getQueryCache().findAll({
    queryKey: ["repo"],
    predicate: ({ queryKey }) =>
      queryKey.length === 5 &&
      !settlesOnRepoWrite({ queryKey }) &&
      (series === null
        ? queryKey[1] === repo
        : typeof queryKey[4] === "string" &&
          queryKey[4].toLowerCase() === series.toLowerCase()),
  });
}

/** Drops every cached star history of `series` (null: `repo`'s own reads), for
 *  the writes that erase its stars (delete, visibility), which pass the series
 *  they read when the write started. A reset cancels a page in flight silently
 *  and clears the pages; an active observer refetches at once, unless `refetch`
 *  is false (a deleted repo has nothing to read: the card waits on its skeleton
 *  until the forge status drops it). */
export function resetStarHistory(
  queryClient: QueryClient,
  repo: string,
  series: string | null,
  { refetch = true }: { refetch?: boolean } = {},
): Promise<void> {
  const reads = new Set(cachedStarHistories(queryClient, repo, series));
  if (!refetch) {
    for (const query of reads) query.reset();
    return Promise.resolve();
  }
  return queryClient.resetQueries({ predicate: (query) => reads.has(query) });
}

/** Star/Unstar's refresh of every cached star history of `series`, the one
 *  the toggle acted on (null: `repo`'s own reads), each through
 *  {@link invalidateKeyHealingStraddles}: a page in flight that would land the
 *  pre-toggle count fresh is invalidated again once it lands. Over a failed
 *  refresh (static) only the mark lands; its Retry re-walks, and a Retry already
 *  in flight is healed the same way. */
export async function invalidateStarHistory(
  queryClient: QueryClient,
  repo: string,
  series: string | null,
): Promise<void> {
  await Promise.all(
    cachedStarHistories(queryClient, repo, series).map((query) =>
      invalidateKeyHealingStraddles(queryClient, query.queryKey),
    ),
  );
}

/** Explore's Star/Unstar of `slug` (`owner/repo`): every cached star history
 *  whose series names it, on any host (Explore doesn't know which one gh
 *  starred on) and in any case, healed as the local toggle heals its own, plus
 *  the Community and star status of every checkout of that repository: those
 *  reads' checkouts, and those whose cached GitHub forge status names it (a
 *  checkout with star status cached may never have opened Insights). */
export async function invalidateStarHistoryForSlug(
  queryClient: QueryClient,
  slug: string,
): Promise<void> {
  const wanted = slug.toLowerCase();
  const reads = queryClient.getQueryCache().findAll({
    queryKey: ["repo"],
    predicate: ({ queryKey }) =>
      queryKey.length === 5 &&
      !settlesOnRepoWrite({ queryKey }) &&
      typeof queryKey[4] === "string" &&
      starSeriesParts(queryKey[4]).slug.toLowerCase() === wanted,
  });
  // useForgeStatus's key (accounts.ts).
  const statuses = queryClient.getQueryCache().findAll({
    queryKey: ["repo"],
    predicate: ({ queryKey, state }) => {
      const status = state.data as ForgeStatus | undefined;
      return (
        queryKey.length === 3 &&
        queryKey[2] === "forge-status" &&
        status?.provider === "github" &&
        typeof status.repo === "string" &&
        status.repo.toLowerCase() === wanted
      );
    },
  });
  const repos = new Set(
    [...reads, ...statuses].map((query) => query.queryKey[1] as string),
  );
  await Promise.all([
    ...reads.map((query) =>
      invalidateKeyHealingStraddles(queryClient, query.queryKey),
    ),
    ...[...repos].flatMap((repo) => [
      invalidateKeyHealingStraddles(
        queryClient,
        repoKeys.communityInsights(repo),
      ),
      // useRepoStarStatus's key (repo-access.ts).
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "star-status"],
      }),
    ]),
  ]);
}

/** A refresh failed over pages the read keeps. */
function failedOverPages(query: {
  state: { status: string; data: unknown };
}): boolean {
  return query.state.status === "error" && query.state.data !== undefined;
}

/** An older star page parked offline (a Load more paused before it sent). */
function isParkedStarPage(query: Query): boolean {
  return (
    query.state.fetchStatus === "paused" &&
    query.state.fetchMeta?.fetchMore?.direction === "forward"
  );
}

/** A star refresh parked offline (a Retry or a toggle's refetch paused before
 *  it sent), which would re-walk every loaded page. A reset's parked first load
 *  has no pages to re-walk and is the card's only read, so it stays. */
function isParkedStarRefresh(query: Query): boolean {
  return (
    query.state.fetchStatus === "paused" &&
    query.state.data !== undefined &&
    query.state.fetchMeta?.fetchMore === undefined
  );
}

/**
 * Cancels an older star page parked offline once nothing wants it (`wanted`
 * turns false, the repo or series switches, or an `<Activity>` hide runs this
 * cleanup): query-core 5.105.3 continues a paused fetch on reconnect even with
 * no observer (query.ts:603-610, :636-656). The cancel reverts to the pre-fetch
 * state (:837, :853-861, :909-916): pages stay, fetchStatus goes idle, the page
 * never sends, and the driver asks again once wanted (a retired Retry dropped
 * its marker at the press). A fetch already sending stays and lands as usual.
 */
export function useRetireParkedStarPage(
  repo: string,
  series: string | null,
  wanted: boolean,
) {
  useRetireParked(repo, series, wanted, isParkedStarPage);
}

/** The refresh twin of {@link useRetireParkedStarPage}, wanted while the card
 *  shows: a refresh parked offline is retired the same way once nobody sees it.
 *  A retired toggle refetch keeps its invalidated mark, so the next mount
 *  re-reads; a retired Retry leaves the failure and its Retry showing. */
export function useRetireParkedStarRefresh(
  repo: string,
  series: string | null,
  shown: boolean,
) {
  useRetireParked(repo, series, shown, isParkedStarRefresh);
}

function useRetireParked(
  repo: string,
  series: string | null,
  wanted: boolean,
  predicate: (query: Query) => boolean,
) {
  const queryClient = useQueryClient();
  const retireFor = wanted ? repo : null;
  useEffect(() => {
    if (retireFor === null) return;
    return () => {
      void queryClient.cancelQueries({
        queryKey: repoKeys.starHistory(retireFor, series),
        exact: true,
        predicate,
      });
    };
  }, [queryClient, retireFor, series, predicate]);
}
