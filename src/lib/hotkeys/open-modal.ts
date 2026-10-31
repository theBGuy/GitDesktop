/**
 * Whether an element sits inside an open modal dialog, sheet or drawer, read
 * from the DOM's slot attributes. Import-free on purpose:
 * `scripts/branch-push-recheck.test.mjs` loads it straight from `src/` under
 * Node's type stripping in the install-free guards job, so any import (a
 * package or an alias) fails that test.
 */

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
