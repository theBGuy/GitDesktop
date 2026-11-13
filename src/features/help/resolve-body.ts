import { formatBinding, secondaryClickLabel } from "@/lib/hotkeys/binding";
import { defaultBindingOf } from "@/lib/hotkeys/default-binding";
import { ACTIONS, type ActionId } from "@/lib/hotkeys/registry";

const BINDING_TOKEN = /\{\{(kbd|key):([a-z0-9+-]+)\}\}/g;
const AI_BLOCK = /\{\{ai\}\}[\s\S]*?\{\{\/ai\}\}/g;
const AI_MARKER = /\{\{\/?ai\}\}/g;
// {{secondaryclick}} → the platform's word for a context-menu click; the capital
// form {{Secondaryclick}} is sentence-initial and gets its first letter uppercased.
const SECONDARY_CLICK_TOKEN = /\{\{(s|S)econdaryclick\}\}/g;

// Actions with no default on this platform, so an unset binding reads as
// "palette" (the chip idiom); a cleared default, or one yielding to another
// action's override, reads "unbound".
const PALETTE_ONLY: Set<string> = new Set(
  ACTIONS.filter((a) => defaultBindingOf(a) === null).map((a) => a.id),
);

/**
 * Resolve a guide body for display: first gate AI passages on `aiEnabled` (strip
 * the marked block when AI is hidden, else drop just the markers), then swap each
 * shortcut token for the live, platform-formatted binding — so the guide always
 * shows the right keys (⌘ vs Ctrl) and reflects the user's rebindings.
 */
export function resolveBody(
  md: string,
  aiEnabled: boolean,
  bindings: Map<ActionId, string | null>,
): string {
  const gated = aiEnabled
    ? md.replace(AI_MARKER, "")
    : md.replace(AI_BLOCK, "");
  const withSecondary = gated.replace(
    SECONDARY_CLICK_TOKEN,
    (_match, initial) =>
      initial === "S"
        ? secondaryClickLabel.charAt(0).toUpperCase() +
          secondaryClickLabel.slice(1)
        : secondaryClickLabel,
  );
  return withSecondary.replace(BINDING_TOKEN, (_match, kind, ref) => {
    if (kind === "key") return formatBinding(ref);
    const binding = bindings.get(ref as ActionId);
    if (binding) return formatBinding(binding);
    return PALETTE_ONLY.has(ref) ? "palette" : "unbound";
  });
}
