import { QueryClient, useQuery } from "@tanstack/react-query";
import {
  ApiError,
  fetchCiRun,
  fetchCiRuns,
  fetchPr,
  fetchPrs,
  fetchStatus,
} from "./api";

// A fresh QueryClient for the companion — modest freshness, one retry, and NO
// refetch-on-focus (a phone backgrounds/foregrounds constantly; we drive
// freshness with a polling interval on the ACTIVE screen instead).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Poll the active screen every ~15s; inactive screens don't poll (their hook is
// unmounted, or `active` is false). A number-or-false is exactly what
// react-query's `refetchInterval` expects.
const POLL_MS = 15_000;
const poll = (active: boolean) => (active ? POLL_MS : (false as const));

/** The shared repo's status. `active` gates polling to the visible screen. */
export function useStatus(active: boolean) {
  return useQuery({
    queryKey: ["status"],
    queryFn: fetchStatus,
    refetchInterval: poll(active),
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

/** Narrow an unknown query error to an {@link ApiError} for state routing. */
export function asApiError(error: unknown): ApiError | null {
  return error instanceof ApiError ? error : null;
}
