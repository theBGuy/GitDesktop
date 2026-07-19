/**
 * Canonical binding strings: lowercase, "+"-joined, modifiers in the fixed
 * order mod → alt → shift, then the key (e.g. "mod+shift+p", "f5", "mod+`").
 * "mod" is Ctrl on Windows/Linux and Cmd on macOS.
 */

const MODIFIER_KEYS = new Set(["control", "meta", "alt", "shift"]);

const KEY_NAMES: Record<string, string> = {
  " ": "space",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
};

export const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** True on Windows. Used for native path-separator decisions (macOS + Linux use "/"). */
export const isWindows =
  typeof navigator !== "undefined" && /win/i.test(navigator.platform);

/**
 * The canonical binding a keyboard event represents, or null when the event
 * is a bare modifier or carries no usable key.
 */
export function eventToBinding(
  e: KeyboardEvent | React.KeyboardEvent,
): string | null {
  // AltGr (right-Alt on many layouts) is character input, not a chord: it
  // reports ctrlKey+altKey, which would otherwise masquerade as a `mod+alt+…`
  // binding and swallow the character being typed. Left-Ctrl+Alt still works —
  // only the AltGraph composition path is excluded.
  if (e.getModifierState?.("AltGraph")) return null;
  const raw = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(raw)) return null;
  // Option/Alt composes a glyph on macOS (Option+P → "π"), so `e.key` is the
  // composed character, not the physical key — the chord would never match its
  // canonical `mod+alt+p`. When Alt is held and the key is a single character
  // that ISN'T a plain ascii letter/digit, recover the physical key from
  // `e.code` (KeyP → "p", Digit1 → "1"); anything else keeps `e.key`.
  let key = KEY_NAMES[raw] ?? raw;
  if (e.altKey && raw.length === 1 && !/^[a-z0-9]$/.test(raw)) {
    const letter = /^Key([A-Za-z])$/.exec(e.code);
    const digit = /^Digit([0-9])$/.exec(e.code);
    if (letter) key = letter[1].toLowerCase();
    else if (digit) key = digit[1];
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const DISPLAY_NAMES: Record<string, string> = {
  mod: isMac ? "Cmd" : "Ctrl",
  alt: isMac ? "Option" : "Alt",
  shift: "Shift",
  enter: "Enter",
  space: "Space",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** "mod+shift+p" → "Ctrl+Shift+P" (Cmd on macOS). */
export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      const named = DISPLAY_NAMES[part];
      if (named) return named;
      if (/^f\d{1,2}$/.test(part)) return part.toUpperCase();
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

/**
 * A canonical binding as an ARIA `aria-keyshortcuts` token string, e.g.
 * "mod+p" → "Control+P" (Windows/Linux) or "Meta+P" (macOS), "f5" → "F5".
 * The vocabulary is intentionally minimal — it only needs to cover the keys
 * that appear in real bindings (see KEY_NAMES/DISPLAY_NAMES above).
 */
/** Canonical binding tokens whose ARIA (UI Events) key value isn't just a
 *  capitalization — see `KEY_NAMES`, which shortens these on the way in. */
const ARIA_KEY_NAMES: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

export function bindingToAriaKeyshortcuts(binding: string): string {
  return binding
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac ? "Meta" : "Control";
      if (part === "alt") return "Alt";
      if (part === "shift") return "Shift";
      // ARIA wants UI Events key values: our canonical arrow tokens ("up",
      // from KEY_NAMES) must map back to "ArrowUp" etc., or AT ignores them
      // (review-caught; reachable via user-recorded arrow chords).
      const arrow = ARIA_KEY_NAMES[part];
      if (arrow) return arrow;
      if (/^f\d{1,2}$/.test(part)) return part.toUpperCase();
      // Single letters uppercase; named keys (enter, space, …) capitalize.
      return part.length === 1
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Native text-editing combos a hotkey must never shadow while typing. */
const EDITING_COMBOS = new Set([
  "mod+a",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+z",
  "mod+y",
  "mod+shift+z",
  "mod+shift+v",
]);

/**
 * Whether a binding is allowed to fire while focus sits in a text field:
 * it must carry a real modifier (plain keys and shift+key are typing) and
 * not collide with the native editing combos.
 */
export function firesInEditable(binding: string): boolean {
  if (!binding.includes("mod+") && !binding.includes("alt+")) return false;
  return !EDITING_COMBOS.has(binding);
}
