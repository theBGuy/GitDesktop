import {
  useEffect,
  useEffectEvent,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useSettings } from "@/lib/settings/queries";
import {
  eventToBinding,
  firesInEditable,
  hasModifier,
  isEditableTarget,
  isTypeaheadKey,
  isTypeaheadTarget,
} from "./binding";
import { ACTIONS, type ActionId } from "./registry";

interface HandlerEntry {
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

function getAvailableSnapshot(): Set<ActionId> {
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

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
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

/**
 * Registers `run` as the live handler for an action while the component is
 * mounted. `enabled` mirrors the corresponding button's disabled state so a
 * hotkey can never do what the UI wouldn't allow.
 */
export function useHotkeyAction(id: ActionId, run: () => void, enabled = true) {
  const stableRun = useEffectEvent(run);
  useEffect(() => {
    const entry: HandlerEntry = { run: stableRun, enabled };
    const list = liveHandlers.get(id) ?? [];
    liveHandlers.set(id, [...list, entry]);
    notify();
    return () => {
      const current = liveHandlers.get(id) ?? [];
      liveHandlers.set(
        id,
        current.filter((e) => e !== entry),
      );
      notify();
    };
  }, [id, enabled]);
}

/**
 * Effective binding per action: the user's override when present (null =
 * explicitly unbound), else the registry default.
 */
export function useEffectiveBindings(): Map<ActionId, string | null> {
  const settings = useSettings();
  const overrides = settings.data?.hotkeys;
  return useMemo(() => {
    const map = new Map<ActionId, string | null>();
    for (const action of ACTIONS) {
      const override = overrides?.[action.id];
      map.set(
        action.id,
        override === undefined ? action.defaultBinding : override,
      );
    }
    return map;
  }, [overrides]);
}

/** Actions that currently have an enabled live handler (for the palette). */
export function useAvailableActions(): Set<ActionId> {
  return useSyncExternalStore(subscribe, getAvailableSnapshot);
}

/**
 * The app-wide keydown listener. Mounted once in App. Local handlers and
 * Base UI popups run earlier in the bubble path and mark events consumed,
 * so anything that reaches here with defaultPrevented set is skipped.
 */
export function useHotkeysListener() {
  const bindings = useEffectiveBindings();
  // Invert ActionId→binding to binding→ActionId once per settings change, so the
  // keydown handler is an O(1) lookup instead of scanning all ~64 actions every
  // keystroke. First action wins a (rare) binding collision, matching the prior
  // first-match loop over ACTIONS order.
  const byBinding = useMemo(() => {
    const map = new Map<string, ActionId>();
    for (const [id, bound] of bindings) {
      if (bound !== null && !map.has(bound)) map.set(bound, id);
    }
    return map;
  }, [bindings]);

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return;
    const binding = eventToBinding(e);
    if (!binding) return;
    if (isEditableTarget(e.target) && !firesInEditable(binding)) return;
    // Typeahead surfaces only ever swallow modifier-less bindings, and only
    // character keys, which is all typeahead consumes: a mod/alt chord and a
    // named key alike keep firing everywhere.
    if (
      !hasModifier(binding) &&
      isTypeaheadKey(binding) &&
      isTypeaheadTarget(e.target)
    )
      return;
    const id = byBinding.get(binding);
    // Registered-vs-unregistered rule. A chord OWNED by an on-screen surface —
    // an action with at least one live handler, even a disabled one — must
    // never leak to the webview's browser accelerators (Ctrl+P → print,
    // F5/Ctrl+R → reload) —
    // so we preventDefault whenever the action is registered, dispatching only
    // if an enabled handler exists. But a chord that NOTHING on screen owns
    // (the action exists in the registry but no component registered it — e.g.
    // Ctrl+W / Ctrl+F on the repositories list, where RepositoryView is
    // unmounted) keeps its native meaning: we leave it alone. (The
    // editable-target guard above already exits for typing contexts.)
    if (id && (liveHandlers.get(id)?.length ?? 0) > 0) {
      dispatchAction(id);
      e.preventDefault();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
