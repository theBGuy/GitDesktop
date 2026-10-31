import { useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Dialogs that must suppress App's global repo/settings actions while they are
 * open. A competing registration can't do that job: `dispatchAction` runs the
 * newest ENABLED handler and falls THROUGH disabled ones, so the only way to
 * refuse an action is App's own `enabled` flag — hence a shared signal rather
 * than a rival handler. The command palette deliberately never registers: it
 * dispatches these actions itself and must stay live while open.
 */
const openModals = new Set<object>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function getSnapshot(): boolean {
  return openModals.size > 0;
}

/**
 * Registers this component's dialog as open for as long as `open` holds, so
 * App's gated actions (which the native menu bar can fire from outside the
 * webview's modal overlay) refuse while it is on screen.
 */
export function useModalGateRegistration(open: boolean): void {
  // A LAYOUT effect, as useHotkeyAction's registration is: the gate feeds App's
  // `enabled` flags, so it flips in the commit that opens or closes the dialog.
  useLayoutEffect(() => {
    if (!open) return;
    const token = {};
    openModals.add(token);
    notify();
    return () => {
      openModals.delete(token);
      notify();
    };
  }, [open]);
}

/** True while any registered dialog is open. */
export function useModalGateOpen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Slot attributes, never roles: Base UI's PopoverPopup also sets role="dialog".
// Vaul's drawer spells open as data-state="open", not Base UI's data-open.
const OPEN_MODAL_CONTENT =
  '[data-slot="dialog-content"][data-open],[data-slot="sheet-content"][data-open],[data-slot="drawer-content"][data-state="open"]';
const MODAL_PORTAL =
  '[data-slot="dialog-portal"],[data-slot="sheet-portal"],[data-slot="drawer-portal"]';

/** The element-shaped surface the core reads (DOM Element satisfies it). A
 *  popup nested in a modal portals as a SIBLING of its content, inside the
 *  modal's portal node, so an open content under that portal counts too. */
export function elementInOpenModal(
  el: {
    closest(sel: string): { querySelector(sel: string): unknown } | null;
  } | null,
): boolean {
  if (el === null) return false;
  if (el.closest(OPEN_MODAL_CONTENT) !== null) return true;
  const portal = el.closest(MODAL_PORTAL);
  return portal !== null && portal.querySelector(OPEN_MODAL_CONTENT) !== null;
}

/** Whether focus sits inside an open modal dialog, sheet or drawer. Keyed on
 *  focus rather than registration, so a dialog concealed in a hidden tab panel
 *  doesn't count. */
export function focusInOpenModal(): boolean {
  return elementInOpenModal(document.activeElement);
}
