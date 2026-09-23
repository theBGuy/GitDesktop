import { type RefObject, useRef } from "react";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { ConversationScrollHandle } from "./ConversationScrollArea";

/**
 * The palette's jump-to-top/bottom commands for one conversation view. Pass the
 * returned ref to that view's `ConversationScrollArea`. `enabled` is the view's
 * surface-active gate: dispatch runs the newest ENABLED handler, so a gate that
 * stays true on a hidden view would steal the jump from the visible one.
 */
export function useThreadJumpHotkeys(
  enabled: boolean,
): RefObject<ConversationScrollHandle | null> {
  const jumpRef = useRef<ConversationScrollHandle>(null);
  useHotkeyAction(
    "jump-to-thread-top",
    () => jumpRef.current?.jumpToTop(),
    enabled,
  );
  useHotkeyAction(
    "jump-to-thread-bottom",
    () => jumpRef.current?.jumpToBottom(),
    enabled,
  );
  return jumpRef;
}
