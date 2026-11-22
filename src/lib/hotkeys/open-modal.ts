/**
 * Whether a modal dialog, sheet or drawer is open, read from the DOM's slot
 * attributes. Import-free on purpose: `scripts/hotkey-registry.test.mjs`
 * loads it straight from `src/` under Node's type stripping in the
 * install-free guards job, so any import (a package or an alias) fails that
 * test.
 */

// Slot attributes, never roles: Base UI's PopoverPopup also sets role="dialog".
// Vaul's drawer spells open as data-state="open", not Base UI's data-open.
const OPEN_MODAL_CONTENT =
  '[data-slot="dialog-content"][data-open],[data-slot="sheet-content"][data-open],[data-slot="drawer-content"][data-state="open"]';
// A drawer's boundary is its content: Vaul renders Radix's DialogPortal, which
// drops the wrapper's data-slot, so no drawer-portal node exists.
const MODAL_BOUNDARY =
  '[data-slot="dialog-portal"],[data-slot="sheet-portal"],[data-slot="drawer-content"]';
const OPEN_DRAWER_CONTENT = '[data-slot="drawer-content"][data-state="open"]';

/** Whether `root` holds an open modal content that `rendered` accepts. The
 *  rendered test keeps a dialog concealed in a hidden tab panel (still
 *  `data-open`) from counting. */
export function hasOpenModal<T>(
  root: { querySelectorAll(sel: string): Iterable<T> },
  rendered: (el: T) => boolean,
): boolean {
  for (const el of root.querySelectorAll(OPEN_MODAL_CONTENT))
    if (rendered(el)) return true;
  return false;
}

// Restates src/lib/focus-lost.ts's two arms, since this module may not import:
// jsdom has no checkVisibility, so the fallback walks computed `display`.
function isRendered(el: Element): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility();
  for (let node: Element | null = el; node !== null; node = node.parentElement)
    if (getComputedStyle(node).display === "none") return false;
  return true;
}

/** Whether an open drawer is on screen. A drawer mints no modal scope, so no
 *  registration answers while one is up (dispatch-shortcut.ts). */
export function anyOpenDrawer(): boolean {
  for (const el of document.querySelectorAll(OPEN_DRAWER_CONTENT))
    if (isRendered(el)) return true;
  return false;
}

/**
 * Whether a key event reached `currentTarget` from another modal than the one
 * it sits in. React bubbles synthetic events through the component tree, across
 * portals, so a dialog's container handler also hears a nested dialog's keys. A
 * picker a dialog opens portals inside that dialog's portal node (same nearest
 * modal boundary: its own event); a nested dialog has a portal of its own.
 */
export function fromOtherModal(
  target: unknown,
  currentTarget: { closest(sel: string): unknown },
): boolean {
  if (
    typeof target !== "object" ||
    target === null ||
    typeof (target as { closest?: unknown }).closest !== "function"
  )
    return false;
  const el = target as { closest(sel: string): unknown };
  return el.closest(MODAL_BOUNDARY) !== currentTarget.closest(MODAL_BOUNDARY);
}

/** Whether any modal dialog, sheet or drawer is open and on screen. Read from
 *  the DOM, never focus, so focus on <body> under a dialog still counts. */
export function anyOpenModal(): boolean {
  return hasOpenModal(document, isRendered);
}
