/** How long the repo view's layout-bearing reads stay cached once unobserved.
 *  RepositoryView is one unkeyed instance, so every repo switch orphans the last
 *  repo's keys, and a revisit past react-query's 5-minute default lands in steps.
 *  Set per curated factory, never as a `["repo"]` prefix default. Excluded, on
 *  the default: `["repo-lens", r]` (holds session-only lens writes); the
 *  notification baselines `["repo", r, "pr-poll"]` / `["repo", r, "actions",
 *  "notify", …]`, which a stale snapshot would prime into a burst of alerts; and
 *  `["repo", r, "forge-status"]`, whose `retryOnMount: false` would keep an
 *  errored entry with no data unretried on every remount for the whole window. */
export const REPO_SHELL_GC_TIME = 30 * 60_000;
