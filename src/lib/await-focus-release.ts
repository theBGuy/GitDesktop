/** How long a landing waits for a closing dialog to release focus: a time
 *  bound, since a frame count shrinks with the display's refresh rate. */
export const FOCUS_RELEASE_WAIT_MS = 500;

/** Polls once per animation frame while `held()` says another surface (a
 *  confirm still closing) has focus. Each frame first checks `aborted()`,
 *  which stops it silently; a frame that finds focus released calls
 *  `onRelease`, and one still held past the bound calls `onTimeout`. Returns
 *  a cancel for the pending frame, a no-op once it has settled. */
export function awaitFocusRelease({
  held,
  aborted,
  onRelease,
  onTimeout,
}: {
  held: () => boolean;
  aborted: () => boolean;
  onRelease: () => void;
  onTimeout?: () => void;
}): () => void {
  const deadline = performance.now() + FOCUS_RELEASE_WAIT_MS;
  let frame = 0;
  const wait = () => {
    frame = 0;
    if (aborted()) return;
    if (!held()) onRelease();
    else if (performance.now() < deadline) frame = requestAnimationFrame(wait);
    else onTimeout?.();
  };
  frame = requestAnimationFrame(wait);
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };
}
