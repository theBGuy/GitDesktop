// Import-free on purpose: scripts/repo-shell-budget.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/** How long a repo open waits for the new repo's cold shell reads before
 *  switching anyway: past it, the view lands and the reads finish in place. */
export const REPO_SHELL_BUDGET_MS = 250;

/** Resolves once every promise has settled or `ms` has passed, whichever comes
 *  first; never rejects, and resolves at once for an empty set. */
export function settleWithin(
  promises: readonly Promise<unknown>[],
  ms: number,
): Promise<void> {
  if (promises.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void Promise.allSettled(promises).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
