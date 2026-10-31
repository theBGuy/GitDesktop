// Import-free on purpose: scripts/navigator-hold.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/** Lands `land` after `warm.settled`, only if `warm.stillCurrent()` still
 *  holds. `land` runs at most once; `settled` must never reject
 *  (settleWithin's contract). The same-repo / no-provider arm never reaches
 *  this helper: callers land synchronously themselves. A throw from `land` or
 *  `stillCurrent` runs after the navigator returned, so it surfaces as an
 *  unhandled rejection rather than reaching the navigator's caller. */
export function holdNavigation(
  warm: { settled: Promise<unknown>; stillCurrent: () => boolean },
  land: () => void,
): void {
  void warm.settled.then(() => {
    if (warm.stillCurrent()) land();
  });
}
