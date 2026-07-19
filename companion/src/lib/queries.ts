import { QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import {
  ApiError,
  fetchCiRun,
  fetchCiRuns,
  fetchPr,
  fetchPrs,
  fetchPrThreads,
  fetchPrTimeline,
  fetchRepos,
  fetchReviews,
  fetchStatus,
} from "./api";
import { navigate } from "./router";

// A fresh QueryClient for the companion — modest freshness, one retry, and NO
// refetch-on-focus (a phone backgrounds/foregrounds constantly; we drive
// freshness with a polling interval on the ACTIVE screen instead).
export const queryClient = new QueryClient({
  // ROUND-6 FINDING (PR #75): the "401 anywhere → #pair" invariant must hold
  // centrally, not just via the shell's status probe — that probe doesn't poll
  // on the PRs/CI tabs, so a phone revoked while sitting there kept its stale
  // list (the banner read "couldn't refresh") AND re-sent its dead cookie every
  // poll, burning the server's brute-force budget until it rate-limited itself
  // out of RE-pairing. Any query's fresh 401 now redirects; `navigate` is a
  // no-op when already on #pair. (The shell's status-based redirect remains as
  // belt-and-braces with its post-pair freshness gate.)
  queryCache: new QueryCache({
    onError: (err) => {
      if (err instanceof ApiError && err.isUnauthorized) navigate("#pair");
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // One retry for transient failures — but never for a definitive error: a
      // 401 (re-sending the dead cookie double-bills the per-IP lockout budget on
      // every poll cycle), a 409 noActiveRepo, or a 404 noSuchRepo (the scoped
      // repo is gone — a retry can't conjure it back and only delays the
      // repo-gone state).
      retry: (failureCount, err) =>
        !(
          err instanceof ApiError &&
          (err.isUnauthorized || err.isNoActiveRepo || err.isNoSuchRepo)
        ) && failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Poll the active screen every ~15s; inactive screens don't poll (their hook is
// unmounted, or `active` is false). A number-or-false is exactly what
// react-query's `refetchInterval` expects.
const POLL_MS = 15_000;
const poll = (active: boolean) => (active ? POLL_MS : (false as const));

/** The repositories shared from the desktop, for the picker + TopBar title.
 *  A modest freshness window plus refetch-on-focus (the ONE exception to the
 *  companion's no-focus-refetch default): the shared set changes on the DESKTOP,
 *  so when the user brings the phone back to foreground we want a current list —
 *  a repo that stopped being shared should drop out promptly. Device-level (not
 *  repo-scoped): safe to fetch on any authed screen, and a 401 still routes
 *  through the central QueryCache → `#pair`. */
export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: fetchRepos,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** The selected repo's status. `repoId` scopes the query + cache key; `active`
 *  gates polling to the visible screen; `enabled` (default true) gates the query
 *  entirely — the shell passes false while the phone sits on `#pair`, so an
 *  unpaired page never fires authed requests (each would 401, and pre-pair
 *  traffic was how the shell once banked rate-limit failures before the user ever
 *  typed a PIN). A null `repoId` also disables it (no repo selected yet). */
export function useStatus(
  repoId: string | null,
  active: boolean,
  enabled = true,
) {
  const on = enabled && repoId != null;
  return useQuery({
    queryKey: ["status", repoId],
    queryFn: () => fetchStatus(repoId as string),
    enabled: on,
    refetchInterval: on ? poll(active) : false,
  });
}

export function usePrs(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["prs", repoId, "open"],
    queryFn: () => fetchPrs(repoId as string, "open"),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function usePr(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number],
    queryFn: () => fetchPr(repoId as string, number as number),
    enabled: on,
    // A detail view is a deliberate drill-in; poll it while it's open.
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

export function useCiRuns(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["ci", "runs", repoId],
    queryFn: () => fetchCiRuns(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function useCiRun(repoId: string | null, id: number | null) {
  const on = repoId != null && id != null;
  return useQuery({
    queryKey: ["ci", "run", repoId, id],
    queryFn: () => fetchCiRun(repoId as string, id as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

/** The live agent streams (AI reviews + agent sessions) to watch. `repoId` scopes
 *  the query + cache key; `active` gates polling — pass false while a watch screen
 *  is open so the list doesn't poll behind it. The watch screen also refetches
 *  THIS query to classify a stream that closed without a terminal event (present →
 *  still live, gone → ended/unshared), which is why it lives here (a react-query
 *  refetch routes a 401 through the central QueryCache → `#pair`, unlike a raw
 *  fetch). */
export function useReviews(repoId: string | null, active: boolean) {
  return useQuery({
    queryKey: ["reviews", repoId],
    queryFn: () => fetchReviews(repoId as string),
    enabled: repoId != null,
    refetchInterval: repoId != null ? poll(active) : false,
  });
}

export function usePrTimeline(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number, "timeline"],
    queryFn: () => fetchPrTimeline(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

export function usePrThreads(repoId: string | null, number: number | null) {
  const on = repoId != null && number != null;
  return useQuery({
    queryKey: ["pr", repoId, number, "threads"],
    queryFn: () => fetchPrThreads(repoId as string, number as number),
    enabled: on,
    refetchInterval: on ? POLL_MS : (false as const),
  });
}

/** Narrow an unknown query error to an {@link ApiError} for state routing. */
export function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}
