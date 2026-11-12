import { useEffect } from "react";
import { dispatchAction } from "./handler-registry";
import type { ActionId } from "./registry";

type SideButton = 3 | 4;

const SIDE_BUTTON_ACTIONS: Readonly<Record<SideButton, ActionId>> = {
  3: "go-back",
  4: "go-forward",
};

function isSideButton(button: number): button is SideButton {
  return button === 3 || button === 4;
}

// Per button: whether the press in progress was spent elsewhere. Each mousedown
// rewrites its button's flag, so a release that never arrives poisons nothing.
const vetoed: Record<SideButton, boolean> = { 3: false, 4: false };
const vetoedPresses = new WeakSet<MouseEvent>();

/** The one dispatch path a side button takes: 3 runs "go-back", 4 runs "go-forward",
 *  through dispatchAction, so every gate on the key registrations applies. True when
 *  a handler ran. */
export function navigateBySideButton(button: number): boolean {
  if (!isSideButton(button)) return false;
  return dispatchAction(SIDE_BUTTON_ACTIONS[button]);
}

/** Called during a side-button mousedown that some surface spent on something else (a
 *  board drag's cancel): the matching release must not navigate. Any other button is
 *  ignored, so a caller may hand it every cancelling press. Works whichever capture
 *  listener runs first. */
export function vetoSideButtonNavigation(e: MouseEvent): void {
  if (!isSideButton(e.button)) return;
  vetoedPresses.add(e);
  vetoed[e.button] = true;
}

// Both edges are prevented: WebView2 runs native back on an unprevented release, and an
// unprevented press moves focus to body (measured on WebView2 157). wry on macOS and
// Linux dispatches only synthetic, untrusted mousedown/mouseup, so these two events are
// read and isTrusted never is.
function onMouseDown(e: MouseEvent) {
  if (!isSideButton(e.button)) return;
  e.preventDefault();
  vetoed[e.button] = vetoedPresses.has(e);
}

function onMouseUp(e: MouseEvent) {
  if (!isSideButton(e.button)) return;
  e.preventDefault();
  if (!vetoed[e.button]) navigateBySideButton(e.button);
  vetoed[e.button] = false;
}

/** Mounts the window capture listeners. Mounted once, in App. */
export function useSideButtonNavigation(): void {
  useEffect(() => {
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);
}
