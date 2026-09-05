import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Focus rescue for a popover whose trigger can be hidden by a container query.
 *
 * Closing below the query's threshold re-hides the trigger in the same commit,
 * so Base UI's focus-return lands on a display:none node and focus falls to
 * `<body>`. Attach `wrapRef` to the element the query hides and `controlsRef`
 * to a `tabIndex={-1}` neighbour that survives, then call
 * `returnFocusIfTriggerHidden` from the close arm of `onOpenChange`: it catches
 * exactly that case — `offsetParent === null` means the wrapper really went
 * away — and leaves the normal return-to-trigger alone at wider widths.
 */
export function useHiddenTriggerFocus(): {
  wrapRef: RefObject<HTMLSpanElement | null>;
  controlsRef: RefObject<HTMLSpanElement | null>;
  returnFocusIfTriggerHidden: () => void;
} {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const controlsRef = useRef<HTMLSpanElement>(null);
  const returnFocusIfTriggerHidden = () =>
    requestAnimationFrame(() => {
      if (wrapRef.current?.offsetParent === null) {
        controlsRef.current?.focus();
      }
    });
  return { wrapRef, controlsRef, returnFocusIfTriggerHidden };
}

/**
 * Focus rescue for a mode swap that unmounts the control holding focus (a
 * palette-driven flip — the picker and mode toggle leave the cluster),
 * dropping focus to `<body>`; land it on `controlsRef`'s silent landing spot
 * instead. Change-only (prev-ref guard), so a mount can never steal focus
 * from elsewhere.
 */
export function useFocusOnControlsSwap(
  active: boolean,
  controlsRef: RefObject<HTMLSpanElement | null>,
) {
  const prevRef = useRef(active);
  useLayoutEffect(() => {
    if (prevRef.current === active) return;
    prevRef.current = active;
    if (document.activeElement === document.body) controlsRef.current?.focus();
  }, [active, controlsRef]);
}
