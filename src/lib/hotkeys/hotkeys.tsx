import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useSettings } from "@/lib/settings/queries";
import {
  consumeRequiresDispatch,
  eventToBinding,
  firesInEditable,
  hasModifier,
  isEditableTarget,
  isTypeaheadKey,
  isTypeaheadTarget,
} from "./binding";
import { effectiveBindings } from "./default-binding";
import {
  dispatchAction,
  getAvailableSnapshot,
  type HandlerEntry,
  hasLiveHandler,
  registerHandler,
  subscribe,
  unregisterHandler,
} from "./handler-registry";
import type { ActionId } from "./registry";

export { dispatchAction };

/**
 * Registers `run` as the live handler for an action while the component is
 * mounted. `enabled` mirrors the corresponding button's disabled state so a
 * hotkey can never do what the UI wouldn't allow.
 */
export function useHotkeyAction(id: ActionId, run: () => void, enabled = true) {
  const stableRun = useEffectEvent(run);
  // A LAYOUT effect: `stableRun` swaps in during the commit, and a passive
  // registration would leave a dispatch landing before the passive flush running
  // the new closure under the previous commit's `enabled`.
  useLayoutEffect(() => {
    const entry: HandlerEntry = { run: stableRun, enabled };
    registerHandler(id, entry);
    return () => unregisterHandler(id, entry);
  }, [id, enabled]);
}

/** Effective binding per action under the saved overrides ({@link effectiveBindings}). */
export function useEffectiveBindings(): Map<ActionId, string | null> {
  const settings = useSettings();
  const overrides = settings.data?.hotkeys;
  return useMemo(() => effectiveBindings(overrides), [overrides]);
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
    // Bare F7 would open WebView2's "Turn on caret browsing?" prompt (measured,
    // WebView2 156): consume it app-wide, text fields and repeats included;
    // dispatch below is unchanged and propagation never stops. The consumed
    // flag is read first: after the guard it would be this guard's own mark.
    const consumed = e.defaultPrevented;
    if (
      e.key === "F7" &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
    }
    if (consumed || e.repeat) return;
    const binding = eventToBinding(e);
    if (!binding) return;
    if (isEditableTarget(e.target) && !firesInEditable(binding)) return;
    // Typeahead surfaces only ever swallow modifier-less bindings, and only
    // character keys and Space, which is all typeahead consumes: a mod/alt
    // chord and a named key alike keep firing everywhere.
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
    // F5/Ctrl+R → reload), so we preventDefault whenever the action is
    // registered, dispatching only if an enabled handler exists. The one
    // carve-out is bare Space ({@link consumeRequiresDispatch}): it is consumed
    // only when a dispatch ran, so a disabled action leaves the press to the
    // focused button, checkbox or scroller. A chord that NOTHING on screen owns
    // (the action exists in the registry but no component registered it — e.g.
    // Ctrl+W / Ctrl+F on the repositories list, where RepositoryView is
    // unmounted) keeps its native meaning: we leave it alone. (The
    // editable-target guard above already exits for typing contexts.)
    if (id && hasLiveHandler(id)) {
      const ran = dispatchAction(id);
      if (ran || !consumeRequiresDispatch(binding)) e.preventDefault();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
