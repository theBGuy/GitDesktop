/**
 * The live hotkey-handler registry: which mounted components currently answer
 * each action, and the dispatch that picks one. React-free so
 * `scripts/hotkey-registry.test.mjs` can load it straight from `src/` under
 * Node's type stripping — keep it free of runtime imports (types only, erased).
 */
import type { ActionId } from "./registry";

/** Precedence band of a registration: an app-level default is a `fallback`, a
 *  panel or view is a `surface`, an open popup's own content is a `popup`. */
export type HandlerTier = "fallback" | "surface" | "popup";

export interface HandlerEntry {
  run: () => void;
  enabled: boolean;
  /** Absent means "surface". */
  tier?: HandlerTier;
  /** The modal scope it registered inside; absent or null means page level. */
  scope?: object | null;
}

const TIER_RANK: Record<HandlerTier, number> = {
  fallback: 0,
  surface: 1,
  popup: 2,
};

/**
 * Live handlers, registered by whichever components are currently mounted.
 * Hidden <Activity> tabs unmount their effects, so per-tab actions are only
 * live on the visible tab. Among enabled entries the highest tier answers, and
 * registration order decides only inside one tier, so an `enabled` flip that
 * re-registers an entry can't take an action from a higher tier.
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

/** Runs, among the enabled entries `eligible` accepts (all when omitted), the
 *  one in the highest tier, newest within it. True when one ran. The filter
 *  narrows only who runs: hasLiveHandler and the snapshot still count every
 *  entry. */
export function dispatchAction(
  id: ActionId,
  eligible?: (entry: HandlerEntry) => boolean,
): boolean {
  const entries = liveHandlers.get(id) ?? [];
  let best: HandlerEntry | null = null;
  let bestRank = -1;
  // Newest first, so a later entry of the same tier is never displaced.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry.enabled || (eligible !== undefined && !eligible(entry)))
      continue;
    const rank = TIER_RANK[entry.tier ?? "surface"];
    if (rank > bestRank) {
      best = entry;
      bestRank = rank;
    }
  }
  if (best === null) return false;
  best.run();
  return true;
}
