import { createContext, useContext, useLayoutEffect, useState } from "react";

/**
 * Which modal a hotkey registration belongs to, decided by React position:
 * PanelPortalReset (rendered by DialogContent and SheetContent) opens a scope,
 * and useHotkeyAction records the nearest one. Imports `react` only, since the
 * vendored dialog and sheet reach this module through panel-portal.tsx.
 */
export type ModalScope = object;

/** The nearest modal's scope; `null` at page level. */
export const ModalScopeContext = createContext<ModalScope | null>(null);

export function useModalScope(): ModalScope | null {
  return useContext(ModalScopeContext);
}

// The scopes whose modal is connected, each with the number it got at its first
// setup. A hidden <Activity> panel disconnects its layout effects, so a dialog
// concealed there leaves; its re-show keeps the first number.
const connected = new Map<ModalScope, number>();
const firstSetup = new WeakMap<ModalScope, number>();
let nextNumber = 0;

/** PanelPortalReset's half: one token for the component's life, registered from
 *  a layout effect so it is in place in the commit that opens the modal. */
export function useMintedModalScope(): ModalScope {
  const [scope] = useState<ModalScope>(() => ({}));
  useLayoutEffect(() => {
    let number = firstSetup.get(scope);
    if (number === undefined) {
      number = nextNumber++;
      firstSetup.set(scope, number);
    }
    connected.set(scope, number);
    return () => {
      connected.delete(scope);
    };
  }, [scope]);
  return scope;
}

/** The connected scope created last. Creation order stands in for stacking
 *  order: a scope has no DOM element to compare without a vendored edit. */
export function topModalScope(): ModalScope | null {
  let top: ModalScope | null = null;
  let best = -1;
  for (const [scope, number] of connected) {
    if (number > best) {
      best = number;
      top = scope;
    }
  }
  return top;
}
