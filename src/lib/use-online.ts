import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

// Module-level so every consumer hands useSyncExternalStore the same identities
// and never re-subscribes on render.
const subscribe = (cb: () => void) => onlineManager.subscribe(cb);
const getSnapshot = () => onlineManager.isOnline();

/** react-query's own connectivity verdict, the one that decides whether a read
 *  or write parks. A mutation run while this is false waits silently and fires
 *  on reconnect, so remote-write controls gate on it rather than on `isPaused`,
 *  which a loaded list only reports once something refetches. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
