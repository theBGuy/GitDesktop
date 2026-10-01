import { onlineManager } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/** react-query's own connectivity verdict, the one that decides whether a read
 *  or write parks. A mutation run while this is false waits silently and fires
 *  on reconnect, so remote-write controls gate on it rather than on `isPaused`,
 *  which a loaded list only reports once something refetches. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
  );
}
