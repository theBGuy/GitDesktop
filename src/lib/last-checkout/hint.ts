import { useEffect, useState, useSyncExternalStore } from "react";
import { useRelativeNow } from "@/components/relative-time";
import { useUserWorktreesPeek } from "@/lib/git/queries";
import { listedMainIs, rememberedIsListed, reopenHint } from "./resolve";
import {
  getLastCheckoutSnapshot,
  lastCheckoutReady,
  subscribeLastCheckout,
} from "./store";

export interface ReopenHint {
  /** Remembered worktree root (as stored). */
  path: string;
  /** Its folder basename, for display. */
  name: string;
}

/** The worktree a click on this row would reopen; null when the row's newest
 *  landing is main (or there is none), on the open repo's row, or when it
 *  remembers the open checkout. An answered list hides it unless it names
 *  rowPath as main and still lists the worktree. While `hold` is true (an open
 *  in flight, or the row's menu open) it keeps its value from when the hold
 *  began, so a late write can't reflow it. Recordless rows spawn no git. */
export function useReopenHint(
  rowPath: string,
  currentPath: string | null,
  hold: boolean,
): ReopenHint | null {
  const records = useSyncExternalStore(
    subscribeLastCheckout,
    getLastCheckoutSnapshot,
  );
  // A mount over an empty snapshot retries a failed startup load, as a click
  // would, so the hint previews what the click does.
  useEffect(() => {
    if (getLastCheckoutSnapshot().length === 0) void lastCheckoutReady();
  }, []);
  // The shared ticker's clock, so render never reads Date.now().
  const now = useRelativeNow();
  const hint = reopenHint(records, rowPath, currentPath, now);
  // Optimistic: the click also refuses the open repo's identity and validates
  // the folder, which a read without IPC can't see. A failed or pending list
  // keeps the hint; an answered one hides it when it lacks the worktree or
  // names a different main, the same list checks the click makes.
  const listed = useUserWorktreesPeek(rowPath, hint !== null);
  const live =
    hint !== null &&
    listed.data !== undefined &&
    (!listedMainIs(listed.data, rowPath) ||
      !rememberedIsListed(listed.data, hint.path))
      ? null
      : hint;
  // Latched during render on each hold edge, and re-latched for a re-targeted
  // row, so a held row never serves another row's frozen value. React discards
  // the render that sets it, so every committed render reads a synced latch.
  const [latch, setLatch] = useState(() => ({
    rowPath,
    held: hold,
    value: live,
  }));
  if (latch.rowPath !== rowPath || latch.held !== hold)
    setLatch({ rowPath, held: hold, value: live });
  return hold ? latch.value : live;
}
