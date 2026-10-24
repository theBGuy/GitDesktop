/**
 * Which cached repo queries a local git operation can change. A query is LOCAL
 * iff it sets `networkMode: "always"` — every local queryFn must, ratcheted by
 * `scripts/networkmode-local-queries.test.mjs` — minus the networked reads that
 * set it too. That ratchet fails only on networked "always" reads it can
 * recognize (named callees, the forge/gh/jira families, classified commands); any
 * other one is listed in its NETWORKED_ALWAYS, and here too when its key is
 * repo-rooted. The same premise `shouldResetOnAccountChange` (account-change.ts)
 * inverts; `scripts/local-query-filter.test.mjs` pins the two against each other.
 *
 * Import-free at runtime on purpose: internal.ts imports it, and the test loads it
 * straight from `src/` under Node's type stripping.
 */

/** Kind slots (key index 2) that set networkMode "always" yet hit the network: the
 *  repo-rooted entries of that ratchet's networked-"always" roster, which the
 *  ratchet fills for the reads it recognizes and a human for the rest. A roster
 *  entry added there joins this set with a test row. */
export const NETWORKED_ALWAYS_OVERRIDES: ReadonlySet<string> = new Set([
  // A forge probe; "always" so a cold offline start settles on its can't-reach arm.
  "forge-status",
  // Runs `git fetch upstream` on every read, so it refreshes itself.
  "create-pr-parent-branches",
]);

/** The slice of a react-query `Query` the predicate reads — the duck type
 *  account-change.ts's `ResetCandidate` reads. */
export type LocalnessCandidate = {
  queryKey: readonly unknown[];
  options: { networkMode?: string };
};

/** Whether a local git operation can change this cached repo query. A query whose
 *  options carry no networkMode (a key seeded by `setQueryData` before any observer
 *  mounted) reads as networked, so such a key waits for its first observer. */
export function isLocalRepoQuery(q: LocalnessCandidate): boolean {
  const kind = q.queryKey[2];
  return (
    q.options.networkMode === "always" &&
    !(typeof kind === "string" && NETWORKED_ALWAYS_OVERRIDES.has(kind))
  );
}
