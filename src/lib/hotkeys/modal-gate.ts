import { useEffect, useSyncExternalStore } from "react";

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
  useEffect(() => {
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
