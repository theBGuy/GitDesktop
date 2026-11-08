import { useSyncExternalStore } from "react";
import { getZoomState, subscribeZoom, type ZoomState } from "./zoom";

/** The applied zoom level and the current monitor-bounded maximum. */
export function useZoom(): ZoomState {
  return useSyncExternalStore(subscribeZoom, getZoomState);
}
