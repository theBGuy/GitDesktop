// A detail view's switch hold, as pure transitions over the item painted
// (`shown`) and the item the selection asks for (`target`), keyed by opaque
// strings the host builds. React-free so scripts/entity-hold.test.mjs loads it
// under Node's type stripping.

/** How long the old item may stay painted after the selection leaves it,
 *  measured from the hold's start: a fast run through a list holds the item it
 *  left for this long in total, never per step. Equal to the diff pane's
 *  `HOLD_BOUND_MS` (pinned by the test). */
export const ENTITY_HOLD_BOUND_MS = 400;

/** `shown` differs from `target` only while the old item is held. */
export interface EntityHold {
  shown: string;
  target: string;
  /** Whether `shown` has an answer of its own. A shown item that has none (one
   *  the bound promoted, a first open, an offline arrival) is replaced
   *  outright by the next move, never held: its paint would be someone
   *  else's placeholder. */
  shownSettled: boolean;
  /** The hold's start on a monotonic clock; null when not holding or not yet
   *  stamped. Retargets keep it, so the bound runs from the first departure. */
  since: number | null;
}

/** What the host knows this render, all about `key` (the selection). */
export interface EntityHoldInput {
  key: string;
  /** The key's primary read has answered for THIS key: its own data (never a
   *  placeholder) or a final error. A background refetch stays settled. */
  settled: boolean;
  /** The current paint may stand in for `key` while it loads: same repo and
   *  lens, and the held paint is available (a placeholder query refusing the
   *  move means it isn't). Read only when a hold would start or retarget. */
  canHold: boolean;
  /** The key's primary read is paused (offline): it never holds, and the host
   *  renders its offline arm instead of a loading one. */
  paused: boolean;
  /** The host's tab is visible. A move made while hidden shows directly: the
   *  user never saw the item it would hold. */
  active: boolean;
}

/**
 * What the host renders:
 * - `shown`: the target, settled. Normal rendering.
 * - `holding`: the OLD item stays painted, dimmed and inert (HeldFrame), while
 *   the target loads; at most the bound.
 * - `loading`: the target without an answer (first open, or the bound
 *   expired). Render its loading arm and NEVER the placeholder: react-query
 *   keeps serving the last defined data, which is the item the hold left.
 * - `offline`: the target without an answer, its read paused. Render the
 *   existing offline arm, undimmed.
 */
export type EntityHoldPhase = "shown" | "holding" | "loading" | "offline";

export type EntitySlotRole = "held" | "preparing" | "shown";

export interface EntityHoldSlot {
  key: string;
  role: EntitySlotRole;
}

/** The number a host's `scope#number` key ends with (the PR and issue views
 *  key `repo#lens#number`), read after the LAST `#` so a scope may hold any. */
export function entityKeyNumber(key: string): number {
  return Number(key.slice(key.lastIndexOf("#") + 1));
}

/** A `scope#number` key's scope, up to and including its last `#`: two keys
 *  share one when they name items of the same repo and lens. */
export function entityKeyScope(key: string): string {
  return key.slice(0, key.lastIndexOf("#") + 1);
}

/** The target painted directly, no hold. */
export function startEntityHold(key: string, settled: boolean): EntityHold {
  return { shown: key, target: key, shownSettled: settled, since: null };
}

export function isEntityHolding(hold: EntityHold): boolean {
  return hold.shown !== hold.target;
}

/**
 * This render's inputs applied. Same object back when nothing changed, so a
 * render can compare by identity before storing it. A hold starts only from a
 * settled shown item to an unsettled, holdable key while visible and online; a
 * new key during a hold replaces the target and keeps the start; the target
 * settling, or its read pausing, ends the hold onto the target; returning to
 * the held item ends it there.
 */
export function stepEntityHold(
  hold: EntityHold,
  input: EntityHoldInput,
): EntityHold {
  const { key, settled, paused } = input;
  if (key === hold.target) {
    if (!isEntityHolding(hold))
      return hold.shownSettled === settled
        ? hold
        : { ...hold, shownSettled: settled };
    if (settled) return startEntityHold(key, true);
    return paused ? startEntityHold(key, false) : hold;
  }
  // Back to the item still painted: it never stopped being shown.
  if (key === hold.shown) return startEntityHold(key, settled);
  const holdable =
    hold.shownSettled && input.canHold && input.active && !settled && !paused;
  if (!holdable) return startEntityHold(key, settled);
  return { ...hold, target: key };
}

/** Records the hold's start; a no-op once stamped or when not holding. */
export function stampEntityHold(hold: EntityHold, now: number): EntityHold {
  if (!isEntityHolding(hold) || hold.since !== null) return hold;
  return { ...hold, since: now };
}

/** The bound's check against a clock reading: an expired hold promotes the
 *  target unsettled (`loading`), and the held item is gone for good. */
export function expireEntityHold(hold: EntityHold, now: number): EntityHold {
  if (
    !isEntityHolding(hold) ||
    hold.since === null ||
    now - hold.since < ENTITY_HOLD_BOUND_MS
  )
    return hold;
  return startEntityHold(hold.target, false);
}

/** `paused` is this render's input, the same one `stepEntityHold` took. */
export function entityHoldPhase(
  hold: EntityHold,
  paused: boolean,
): EntityHoldPhase {
  if (isEntityHolding(hold)) return "holding";
  if (hold.shownSettled) return "shown";
  return paused ? "offline" : "loading";
}

/** The keyed instances a two-slot host renders, in paint order: the held item
 *  stays in flow while the target lays out invisibly over it. A single-instance
 *  host reads the same state through `entityHoldPhase` instead. */
export function entityHoldSlots(hold: EntityHold): EntityHoldSlot[] {
  return isEntityHolding(hold)
    ? [
        { key: hold.shown, role: "held" },
        { key: hold.target, role: "preparing" },
      ]
    : [{ key: hold.target, role: "shown" }];
}

/** What the last commit did, as `useRevealGuard` records it: whether the tab was
 *  visible, and whether it painted the view's item (not a reveal frame). */
export interface RevealCommit {
  visible: boolean;
  painted: boolean;
}

/** No visible commit yet, or the tab was hidden since (an `<Activity>` hide
 *  runs no effects, so the guard resets to this on the hide's cleanup). */
export const REVEAL_HIDDEN: RevealCommit = { visible: false, painted: false };

/** This render's selection facts, all urgent except `viewKey`. */
export interface RevealInput {
  /** The host's tab is visible NOW (the store's value, never deferred). */
  visible: boolean;
  /** The selection's key in the store, urgent; null with nothing selected. */
  liveKey: string | null;
  /** The key this render targets: the host's deferred selection. */
  viewKey: string | null;
  /** `useEntityHold`'s `shownKey` from the host's previous render, i.e. the
   *  item the view would paint before this render's hold step. */
  shownKey: string;
}

export interface RevealGuard {
  /** The tab is arriving and the view would paint something other than the
   *  live selection (the deferred key lags, or a hold keeps another item):
   *  render the loading frame, never that item. */
  revealing: boolean;
  /** Pass as `useEntityHold`'s `active`. True only when the tab is visible
   *  and the last commit was visible and painted the view's item, so a move
   *  that lands with or right after a reveal shows directly instead of
   *  holding an item the user never saw. */
  active: boolean;
}

export function revealGuard(
  last: RevealCommit,
  input: RevealInput,
): RevealGuard {
  const active = input.visible && last.visible && last.painted;
  const lags =
    input.viewKey !== input.liveKey || input.shownKey !== input.liveKey;
  return { revealing: input.visible && !active && lags, active };
}

/** The facts a commit records; same object back when they're unchanged. */
export function revealCommit(
  last: RevealCommit,
  visible: boolean,
  revealing: boolean,
): RevealCommit {
  const painted = visible && !revealing;
  return last.visible === visible && last.painted === painted
    ? last
    : { visible, painted };
}
