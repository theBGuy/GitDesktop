import { type RefObject, useRef } from "react";

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
