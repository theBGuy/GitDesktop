import { useEffect, useRef } from "react";

/** A last-resort bound on the Menu key's follow-up `contextmenu` canceller, for
 *  a keyup that never arrives; a key held past it disarms too. */
const MENU_KEY_FOLLOW_UP_BOUND_MS = 10_000;

/** Returns `arm`, which a keydown handler calls right AFTER it opened an app menu for the
 *  Menu key. WebView2 follows that key's keyup with a trusted `contextmenu` that would stack
 *  its native menu over the app's: `arm` cancels that one event (never stops it), armed
 *  until it fires, a task after the keyup, a window blur, or the last-resort bound. A
 *  re-arm retires the previous canceller; unmount retires the last. */
export function useMenuKeyFollowUpCanceller(): () => void {
  const disarmMenuKeyFollowUp = useRef<(() => void) | null>(null);
  useEffect(() => () => disarmMenuKeyFollowUp.current?.(), []);

  return function armMenuKeyFollowUp() {
    disarmMenuKeyFollowUp.current?.();
    let afterKeyUp: number | undefined;
    let bound: number | undefined;
    const onContextMenu = (ev: Event) => {
      ev.preventDefault();
      disarm();
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "ContextMenu") afterKeyUp ??= window.setTimeout(disarm, 0);
    };
    const disarm = () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", disarm);
      window.clearTimeout(afterKeyUp);
      window.clearTimeout(bound);
      if (disarmMenuKeyFollowUp.current === disarm)
        disarmMenuKeyFollowUp.current = null;
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keyup", onKeyUp, true);
    // A keyup that lands in another window would otherwise leave it armed.
    window.addEventListener("blur", disarm);
    bound = window.setTimeout(disarm, MENU_KEY_FOLLOW_UP_BOUND_MS);
    disarmMenuKeyFollowUp.current = disarm;
  };
}
