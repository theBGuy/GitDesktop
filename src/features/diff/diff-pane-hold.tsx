import { createContext, useContext, useLayoutEffect } from "react";

/**
 * What a diff-pane slot tells the surfaces inside it. Outside a slot (every
 * other DiffSurface/DiffContent host) the defaults leave them as they were.
 */
export interface DiffPaneHoldValue {
  /** False while the slot is held or still preparing. `inert` already blocks
   *  pointer, focus and AT there, but not global hotkeys or portaled dialogs,
   *  so those gate on this. */
  interactive: boolean;
  /** Records one loading gate's state for the slot and returns its release.
   *  The slot is settled once at least one gate has reported and every gate
   *  that has reported is settled; a gate that never reports goes unseen. */
  reportSettled: (settled: boolean) => () => void;
}

const release = () => undefined;

const OUTSIDE_SLOT: DiffPaneHoldValue = {
  interactive: true,
  reportSettled: () => release,
};

export const DiffPaneHold = createContext<DiffPaneHoldValue>(OUTSIDE_SLOT);

export function useDiffPaneHold(): DiffPaneHoldValue {
  return useContext(DiffPaneHold);
}

/** Whether a slot is listening, so settle-only work (DOM probes, observers)
 *  can stay out of every other host's tree. */
export function useInDiffPaneSlot(): boolean {
  return useContext(DiffPaneHold) !== OUTSIDE_SLOT;
}

/** Reports a loading gate: a render-null arm, or work still landing after
 *  render (an image decode). Call it before any early return. A layout effect,
 *  so a settle promotes the slot before the browser paints the frame it
 *  settled in. */
export function useReportPaneSettled(settled: boolean): void {
  const { reportSettled } = useContext(DiffPaneHold);
  useLayoutEffect(() => reportSettled(settled), [reportSettled, settled]);
}
