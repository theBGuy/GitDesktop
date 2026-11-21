import { dispatchAction } from "./handler-registry";
import { topModalScope } from "./modal-scope";
import { anyOpenModal } from "./open-modal";
import type { ActionId } from "./registry";

// App zoom acts on nothing behind a dialog and is an accessibility control, so
// it answers under any modal. The roadmap's zoom acts on the board: not exempt.
const MODAL_EXEMPT: ReadonlySet<ActionId> = new Set<ActionId>([
  "app-zoom-in",
  "app-zoom-out",
  "app-zoom-reset",
]);

/**
 * The one dispatch for every route that is not a press on a visible control
 * (the key listener, a palette pick, the macOS menu, the mouse side buttons).
 * While a modal is open and on screen only registrations made inside the
 * topmost one answer; an open modal with no registered scope (a drawer) makes
 * every action inert. A control press inside a dialog keeps raw dispatchAction.
 */
export function dispatchShortcut(id: ActionId): boolean {
  if (MODAL_EXEMPT.has(id) || !anyOpenModal()) return dispatchAction(id);
  const top = topModalScope();
  if (top === null) return false;
  return dispatchAction(id, (entry) => entry.scope === top);
}
