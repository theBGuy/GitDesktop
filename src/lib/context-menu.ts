import type { MouseEvent } from "react";

/** Suppress a shared ContextMenu for a non-target right-click. stopPropagation,
 *  not just preventDefault: Base UI's own trigger handler (a same-element
 *  bubble listener) would still open the menu as an empty popup. */
export function suppressContextMenu(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
}
