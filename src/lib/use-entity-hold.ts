import { useLayoutEffect, useState } from "react";

import {
  ENTITY_HOLD_BOUND_MS,
  type EntityHoldInput,
  type EntityHoldPhase,
  type EntityHoldSlot,
  entityHoldPhase,
  entityHoldSlots,
  expireEntityHold,
  isEntityHolding,
  REVEAL_HIDDEN,
  type RevealGuard,
  type RevealInput,
  revealCommit,
  revealGuard,
  stampEntityHold,
  startEntityHold,
  stepEntityHold,
} from "./entity-hold";

export interface EntityHoldState {
  /** See `EntityHoldPhase` (entity-hold.ts) for what each arm renders. */
  phase: EntityHoldPhase;
  /** The old item is painted: wrap it in `HeldFrame`. */
  holding: boolean;
  /** False only while holding. `inert` covers pointer, focus and AT, but not
   *  global hotkeys or portaled dialogs, so `useHotkeyAction` and dialogs'
   *  `open` gate on this. The loading and offline arms keep their own
   *  placeholder gates. */
  interactive: boolean;
  /** The item being held, else null. */
  heldKey: string | null;
  /** The item the host paints or loads: `heldKey` while holding, else the
   *  selection's key. */
  shownKey: string;
  /** For a keyed two-slot host; see `entityHoldSlots`. */
  slots: EntityHoldSlot[];
}

/**
 * A detail view's bounded switch hold. Transitions run at render, so the
 * render that moves the selection already reports `holding`. The clock is read
 * only in a layout effect: it stamps the hold's start, arms ONE timer per hold
 * (cleared when the hold ends or the view unmounts), and re-checks the bound
 * whenever effects remount, so a hold whose bound passed while an `<Activity>`
 * tab was hidden expires before the revealed frame paints.
 */
export function useEntityHold(input: EntityHoldInput): EntityHoldState {
  const [stored, setHold] = useState(() =>
    startEntityHold(input.key, input.settled),
  );
  const hold = stepEntityHold(stored, input);
  if (hold !== stored) setHold(hold);
  const holding = isEntityHolding(hold);
  const since = hold.since;
  useLayoutEffect(() => {
    if (!holding) return;
    const now = performance.now();
    if (since === null) {
      setHold((h) => stampEntityHold(h, now));
      return;
    }
    const due = since + ENTITY_HOLD_BOUND_MS;
    if (now >= due) {
      setHold((h) => expireEntityHold(h, now));
      return;
    }
    // `due` as the floor: a timer may land a hair before the coarsened clock
    // reaches it, and a later hold's start compares above it.
    const bound = window.setTimeout(
      () =>
        setHold((h) => expireEntityHold(h, Math.max(performance.now(), due))),
      due - now,
    );
    return () => window.clearTimeout(bound);
  }, [holding, since]);
  return {
    phase: entityHoldPhase(hold, input.paused),
    holding,
    interactive: !holding,
    heldKey: holding ? hold.shown : null,
    shownKey: hold.shown,
    slots: entityHoldSlots(hold),
  };
}

/**
 * The reveal guard every entity-hold host runs before `useEntityHold`: a
 * navigator that reveals the tab AND moves the selection in one update leaves
 * the deferred selection behind the reveal, so the first visible frames would
 * paint the old item. `revealing` swaps those frames for the loading frame;
 * `active` feeds `useEntityHold`. The commit's facts are recorded in a layout
 * effect, so the render after a reveal (one extra) reads them.
 */
export function useRevealGuard(input: RevealInput): RevealGuard {
  const [last, setLast] = useState(REVEAL_HIDDEN);
  const guard = revealGuard(last, input);
  const { visible } = input;
  const { revealing } = guard;
  useLayoutEffect(() => {
    setLast((c) => revealCommit(c, visible, revealing));
  }, [visible, revealing]);
  // An <Activity> hide runs this cleanup; hidden commits run no effects, so
  // without it the facts would stay those of the last visible commit.
  useLayoutEffect(() => () => setLast(REVEAL_HIDDEN), []);
  return guard;
}
