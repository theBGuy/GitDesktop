import { flushSync } from "react-dom";

const reduceMotion =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransition;
};

/**
 * Runs a state update inside a View Transition (a calm crossfade between
 * top-level screens) when the browser supports it and the user hasn't asked for
 * reduced motion; otherwise applies the update immediately. `flushSync` lands
 * the React update synchronously so the transition captures before/after.
 *
 * `animate: false` drops the crossfade but keeps the ORDER: the transition is
 * skipped at once, and its update is applied without animation in a later task,
 * after any pending transition's update — still one atomic action. A plain
 * synchronous update could land first and be overwritten by that pending one.
 *
 * Only call this from event handlers — never during render or an effect.
 */
export function startViewTransition(
  update: () => void,
  { animate = true }: { animate?: boolean } = {},
): void {
  const doc = document as ViewTransitionDocument;
  if (reduceMotion?.matches || typeof doc.startViewTransition !== "function") {
    update();
    return;
  }
  const transition = doc.startViewTransition(() => flushSync(update));
  // A skip (this arm, or the next transition aborting a running one) rejects a
  // not-yet-resolved `ready`; `finished` rejects only when the update throws.
  // Both are claimed so the unhandledrejection hook never reports a navigation.
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
  if (!animate) transition.skipTransition();
}
