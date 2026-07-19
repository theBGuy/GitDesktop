import { QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import {
  ApiError,
  fetchCiRun,
  fetchCiRuns,
  fetchPr,
  fetchPrs,
  fetchPrThreads,
  fetchPrTimeline,
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
      // One retry for transient failures — but never for a 401/409: both are
      // definitive, and a retried 401 re-sends the dead cookie, double-billing
      // the per-IP lockout budget on every poll cycle.
      retry: (failureCount, err) =>
        !(
          err instanceof ApiError &&
          (err.isUnauthorized || err.isNoActiveRepo)
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

/** The shared repo's status. `active` gates polling to the visible screen;
 *  `enabled` (default true) gates the query entirely — the shell passes false
 *  while the phone sits on `#pair`, so an unpaired page never fires authed
 *  requests (each would 401, and pre-pair traffic was how the shell once banked
 *  rate-limit failures before the user ever typed a PIN). */
export function useStatus(active: boolean, enabled = true) {
  return useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    enabled,
    refetchInterval: enabled ? poll(active) : false,
  });
}

export function usePrs(active: boolean) {
  return useQuery({
    queryKey: ["prs", "open"],
    queryFn: () => fetchPrs("open"),
    refetchInterval: poll(active),
  });
}

export function usePr(number: number | null) {
  return useQuery({
    queryKey: ["pr", number],
    queryFn: () => fetchPr(number as number),
    enabled: number != null,
    // A detail view is a deliberate drill-in; poll it while it's open.
    refetchInterval: number != null ? POLL_MS : (false as const),
  });
}

export function useCiRuns(active: boolean) {
  return useQuery({
    queryKey: ["ci", "runs"],
    queryFn: () => fetchCiRuns(),
    refetchInterval: poll(active),
  });
}

export function useCiRun(id: number | null) {
  return useQuery({
    queryKey: ["ci", "run", id],
    queryFn: () => fetchCiRun(id as number),
    enabled: id != null,
    refetchInterval: id != null ? POLL_MS : (false as const),
  });
}

/** The live agent streams (AI reviews + agent sessions) to watch. `active` gates
 *  polling — pass false while a watch screen is open so the list doesn't poll
 *  behind it. The watch screen also refetches THIS query to classify a stream that
 *  closed without a terminal event (present → still live, gone → ended/unshared),
 *  which is why it lives here (a react-query refetch routes a 401 through the
 *  central QueryCache → `#pair`, unlike a raw fetch). */
export function useReviews(active: boolean) {
  return useQuery({
    queryKey: ["reviews"],
    queryFn: fetchReviews,
    refetchInterval: poll(active),
  });
}

export function usePrTimeline(number: number | null) {
  return useQuery({
    queryKey: ["pr", number, "timeline"],
    queryFn: () => fetchPrTimeline(number as number),
    enabled: number != null,
    refetchInterval: number != null ? POLL_MS : (false as const),
  });
}

export function usePrThreads(number: number | null) {
  return useQuery({
    queryKey: ["pr", number, "threads"],
    queryFn: () => fetchPrThreads(number as number),
    enabled: number != null,
    refetchInterval: number != null ? POLL_MS : (false as const),
  });
}

/** Narrow an unknown query error to an {@link ApiError} for state routing. */
export function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}
