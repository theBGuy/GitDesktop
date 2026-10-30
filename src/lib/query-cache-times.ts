/** How long the repo view's layout-bearing reads stay cached once unobserved.
 *  RepositoryView is one unkeyed instance, so every repo switch orphans the last
 *  repo's keys, and a revisit past react-query's 5-minute default lands in steps.
 *  Set per curated factory, never as a `["repo"]` prefix default. Excluded, on
 *  the default: `["repo-lens", r]` (holds session-only lens writes); the
 *  notification baseline `["repo", r, "pr-poll"]`, which a stale snapshot would
 *  prime into a burst of alerts; and `["repo", r, "forge-status"]`, whose
 *  `retryOnMount: false` would keep an errored entry with no data unretried on
 *  every remount for the whole window. The run-notify list IS cached: its notifier
 *  primes only from polls fetched after it enabled. */
export const REPO_SHELL_GC_TIME = 30 * 60_000;

/** staleTime of the shell factories without a window of their own: each read is
 *  fresh for 1 s, sized to cover the warm-up→mount gap (4 × the 250 ms budget,
 *  restated since lib/ can't import features/). Polls and invalidations refetch. */
export const REPO_SHELL_WARM_STALE_MS = 1000;
