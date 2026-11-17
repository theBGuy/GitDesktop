import { useEffect } from "react";

/**
 * The element `landId` names (a create dialog's Title) takes focus from a
 * control inside its open dialog that goes natively disabled while focused: a
 * dead stop the browser later blurs to body. An aria-disabled held button
 * doesn't match `:disabled`, so it keeps focus and its reason, and a closing
 * popup (no `data-open`) is left to Base UI's own focus return.
 */
export function useLandStrandedFocus(landId: string) {
  // Watches the DOM, not this component's commits: a child's own commit (Base
  // UI syncing a Select trigger's `disabled`) flips it too. Measured on
  // WebView2 (Chromium), the control is still focused here and through rAF and
  // a 0 ms timeout; on WebKit, unmeasured, a sooner blur makes this a no-op.
  useEffect(() => {
    const watch = new MutationObserver(() => {
      const active = document.activeElement;
      if (active === null || !active.matches(":disabled")) return;
      const land = document.getElementById(landId);
      const popup = land?.closest('[role="dialog"]');
      if (!popup?.hasAttribute("data-open") || !popup.contains(active)) return;
      land?.focus();
    });
    watch.observe(document.body, {
      attributes: true,
      attributeFilter: ["disabled"],
      subtree: true,
    });
    return () => watch.disconnect();
  }, [landId]);
}
