import { onlineManager } from "@tanstack/react-query";
import { toast } from "sonner";
import { useOnline } from "@/lib/use-online";

/** The one reason every held remote-write control gives while offline: a forge
 *  write pressed then parks silently and fires on reconnect, so destructive and
 *  publishing writes refuse at the press instead. */
export const OFFLINE_WRITE_REASON =
  "You're offline — this will be available once you're back online.";

/** The hold reason on a write's own trigger (a confirm's act button, a
 *  create/save/enable submit) while that write is in flight. Giving the running
 *  write a reason keeps the trigger on the same aria-disabled path as the offline
 *  hold, so a flip between the two never drops focus. */
export const ACT_PENDING_REASON = "Applying this change…";

/** The hold reason on a submit while an AI draft is still streaming into the
 *  form it would send. */
export const AI_DRAFT_PENDING_REASON = "Wait for the AI draft to finish";

/** The in-flight copy for a forge comment delete, shared by every conversation
 *  surface's composer hold and Delete comment dialog. */
export const COMMENT_DELETE_PENDING_REASON = "Deleting a comment…";

/** The compact form of {@link OFFLINE_WRITE_REASON} appended to a disabled MENU
 *  ITEM's label, which can show no tooltip. */
export const OFFLINE_ITEM_REASON = "you're offline";

/** {@link OFFLINE_WRITE_REASON} while react-query reads the app as offline,
 *  otherwise undefined — the hold a press-gated control folds into its own
 *  disabled + reason pair, button and palette path alike. */
export function useOfflineHold(): string | undefined {
  return useOnline() ? undefined : OFFLINE_WRITE_REASON;
}

/** The fire-time verdict, read at the moment a write is about to start. */
export function isOfflineNow(): boolean {
  return !onlineManager.isOnline();
}

/** Fire-time twin of {@link useOfflineHold}. It belongs immediately before the
 *  write, after every await in the handler (a confirm, a picker, an earlier
 *  write): the connection can drop during any of them, and a write sent then
 *  would park. Says why it refused, since a just-confirmed action going silent
 *  reads as success. */
export function refuseWhileOffline(message = OFFLINE_WRITE_REASON): boolean {
  if (!isOfflineNow()) return false;
  toast.info(message);
  return true;
}

/** The refusal for a close whose riding comment already posted before the
 *  connection dropped: the thread shows the comment, so the line accounts for
 *  both writes. Shared by the PR, issue and discussion views. */
export const RIDING_COMMENT_CLOSE_HELD =
  "Your comment was posted, but you're offline, so nothing was closed — try Close again once you're back online.";

/** The reason a pending write holds its controls with: while it is parked
 *  offline it is waiting, not running, so the in-flight copy would claim work that
 *  hasn't started. `paused` must come from the same source as the busy flag it
 *  explains — the observer's `isPaused` beside its `isPending`, or a cache
 *  entry's `state.isPaused` beside a cache-derived hold. */
export function pendingWriteReason(paused: boolean, inFlight: string): string {
  return paused ? OFFLINE_WRITE_REASON : inFlight;
}
