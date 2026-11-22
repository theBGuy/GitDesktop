import type { HandlerTier } from "./handler-registry";
import { useHotkeyAction } from "./hotkeys";
import type { ActionId } from "./registry";

/**
 * useHotkeyAction from JSX, for a registration that must sit inside a dialog's
 * content while the hook's natural caller sits outside it: the modal scope comes
 * from React position. Renders nothing.
 */
export function HotkeyAction({
  id,
  run,
  enabled = true,
  tier,
}: {
  id: ActionId;
  run: () => void;
  enabled?: boolean;
  tier?: HandlerTier;
}): null {
  useHotkeyAction(id, run, enabled, { tier });
  return null;
}
