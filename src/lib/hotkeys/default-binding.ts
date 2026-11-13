import { isMac } from "./binding";
import { ACTIONS, type ActionId, resolveDefaultBinding } from "./registry";

/** THE default for an action on this platform; every reader of a default goes
 *  through it (the `raw-default-binding-read` guard bans a member read). */
export function defaultBindingOf(action: {
  id: string;
  defaultBinding: string | null;
}): string | null {
  return resolveDefaultBinding(action, isMac);
}

/**
 * The binding every action answers to under `overrides`, on this platform: THE
 * one place an override is resolved against a default. An action's own
 * override wins (null = explicitly unbound); otherwise its default, except that
 * a default yields, reading as unassigned, when another current action's
 * non-null override holds the same chord. An override stored under an id that
 * is no current action shadows nothing.
 */
export function effectiveBindings(
  overrides: Readonly<Record<string, string | null>> | undefined,
): Map<ActionId, string | null> {
  const own = (id: string): string | null | undefined =>
    overrides !== undefined && Object.hasOwn(overrides, id)
      ? overrides[id]
      : undefined;
  const overridden = new Set<string>();
  for (const action of ACTIONS) {
    const override = own(action.id);
    if (typeof override === "string") overridden.add(override);
  }
  const map = new Map<ActionId, string | null>();
  for (const action of ACTIONS) {
    const override = own(action.id);
    if (override !== undefined) {
      map.set(action.id, override);
      continue;
    }
    const def = defaultBindingOf(action);
    map.set(action.id, def !== null && overridden.has(def) ? null : def);
  }
  return map;
}
