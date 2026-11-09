import { useSyncExternalStore } from "react";
import { getZoomState, subscribeZoom, type ZoomState } from "./zoom";

/** The applied zoom level, the current monitor-bounded maximum and the saved
 *  level (above the applied one while the display clamps it). */
export function useZoom(): ZoomState {
  return useSyncExternalStore(subscribeZoom, getZoomState);
}
