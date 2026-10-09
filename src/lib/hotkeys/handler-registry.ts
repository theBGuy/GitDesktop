/**
 * The live hotkey-handler registry: which mounted components currently answer
 * each action, and the dispatch that picks one. React-free so
 * `scripts/hotkey-registry.test.mjs` can load it straight from `src/` under
 * Node's type stripping — keep it free of runtime imports (types only, erased).
 */
import type { ActionId } from "./registry";

export interface HandlerEntry {
  run: () => void;
  enabled: boolean;
}

/**
 * Live handlers, registered by whichever components are currently mounted.
 * Hidden <Activity> tabs unmount their effects, so per-tab actions are only
 * live on the visible tab. The newest enabled registration wins.
 */
const liveHandlers = new Map<ActionId, HandlerEntry[]>();

// Notified on every register/unregister/enable change so the palette can
// re-derive "what's available right now".
const subscribers = new Set<() => void>();

// Snapshot for useSyncExternalStore: a stable Set reference that's only
// rebuilt when the handler map actually changes. NOTE: reading liveHandlers
// directly during render would be invisible to the React Compiler's
// memoization — the store subscription is the sanctioned reactive path.
let availableSnapshot: Set<ActionId> | null = null;

export function getAvailableSnapshot(): Set<ActionId> {
  if (availableSnapshot === null) {
    const out = new Set<ActionId>();
    for (const [id, entries] of liveHandlers) {
      if (entries.some((e) => e.enabled)) out.add(id);
    }
    availableSnapshot = out;
  }
  return availableSnapshot;
}

function notify() {
  availableSnapshot = null;
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Adds `entry` as the newest handler for `id`. */
export function registerHandler(id: ActionId, entry: HandlerEntry): void {
  const list = liveHandlers.get(id) ?? [];
  liveHandlers.set(id, [...list, entry]);
  notify();
}

/** Removes exactly `entry` (by identity), leaving every other handler for `id`. */
export function unregisterHandler(id: ActionId, entry: HandlerEntry): void {
  const current = liveHandlers.get(id) ?? [];
  liveHandlers.set(
    id,
    current.filter((e) => e !== entry),
  );
  notify();
}

/** Whether anything on screen owns `id`, enabled or not — the listener's test
 *  for keeping a chord away from the webview's browser accelerators. */
export function hasLiveHandler(id: ActionId): boolean {
  return (liveHandlers.get(id)?.length ?? 0) > 0;
}

/** Runs the newest enabled handler for an action. True when one ran. */
export function dispatchAction(id: ActionId): boolean {
  const entries = liveHandlers.get(id) ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].enabled) {
      entries[i].run();
      return true;
    }
  }
  return false;
}
