import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

/**
 * When the open repo was last fetched (manual or automatic), as wall-clock ms,
 * keyed by repo path. In-memory only — it tracks "freshness this session" to
 * drive the Fetch tooltip and the fetch-on-focus staleness check, and resets on
 * app restart (the first focus after launch then re-fetches a stale repo).
 */
interface FetchStatusState {
  lastFetchedAt: Record<string, number>;
  markFetched: (repo: string) => void;
}

export const useFetchStatusStore = create<FetchStatusState>((set) => ({
  lastFetchedAt: {},
  markFetched: (repo) =>
    set((s) => ({ lastFetchedAt: { ...s.lastFetchedAt, [repo]: Date.now() } })),
}));

/** Wall-clock ms of the open repo's last successful fetch, or undefined. */
export function useLastFetchedAt(repo: string): number | undefined {
  return useFetchStatusStore((s) => s.lastFetchedAt[repo]);
}

/**
 * Periodic background `git fetch` for the open repo. Quiet (no toasts) — it
 * keeps the behind-count and incoming commits current without the user pressing
 * Fetch. A fetch is read-only on the local side (it only updates
 * remote-tracking refs), so it never touches the working tree or local
 * branches; pulling and pushing stay manual.
 *
 * Cadence: an interval tick that fires only while the window is focused (so we
 * don't poll the network for an app sitting in the background — matching the
 * app's `refetchIntervalInBackground: false` stance), plus a fetch when the
 * window regains focus or a repo opens *and* it's been at least one interval
 * since the last fetch. So returning to GitDesktop, or opening a repo, refreshes
 * right away without burning network while you're away.
 *
 * Every attempt is gated on: enabled + an `origin` remote + `navigator.onLine`
 * + not `busy` (the caller's own hold: its sync ops and its auto-fetch in flight),
 * so a background fetch never starts over a user-initiated pull or push. The
 * caller runs it on its own mutation, so it never holds the manual controls.
 */
export function useAutoFetch(opts: {
  repoPath: string;
  enabled: boolean;
  intervalMs: number;
  hasOrigin: boolean;
  busy: boolean;
  fetch: () => void;
}) {
  const { repoPath, enabled, intervalMs, hasOrigin } = opts;
  const lastFetchedAt = useLastFetchedAt(repoPath);

  // An effect event so the timer/focus handlers stay stable yet always read the
  // current settings, remote, in-flight, and last-fetched state when they fire.
  const attempt = useEffectEvent((reason: "interval" | "focus") => {
    if (!opts.enabled || !opts.hasOrigin || opts.busy) return;
    if (navigator.onLine === false) return;
    // The interval keeps ticking while unfocused; skip those no-op fetches.
    if (reason === "interval" && !document.hasFocus()) return;
    // On focus/open, only fetch when we're actually due — don't re-fetch a
    // repo that was synced moments ago.
    if (
      reason === "focus" &&
      lastFetchedAt !== undefined &&
      Date.now() - lastFetchedAt < opts.intervalMs
    ) {
      return;
    }
    opts.fetch();
  });

  // Interval ticking, re-armed when the cadence, remote, or repo changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath intentionally re-arms the timer for the newly opened repo; `attempt` reads it via the stable effect event, so Biome can't see the dependency.
  useEffect(() => {
    if (!enabled || !hasOrigin) return;
    const id = setInterval(() => attempt("interval"), intervalMs);
    return () => clearInterval(id);
  }, [enabled, hasOrigin, intervalMs, repoPath]);

  // Fetch on open and whenever the window regains focus (gated on being due in
  // `attempt`). Opening a repo or toggling auto-fetch on counts as a focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoPath intentionally re-fires the on-open fetch for the newly opened repo (read via the stable effect event).
  useEffect(() => {
    if (!enabled || !hasOrigin) return;
    attempt("focus");
    const onFocus = () => attempt("focus");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, hasOrigin, repoPath]);
}
