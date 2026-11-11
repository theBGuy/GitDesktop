/**
 * The pure half of pointer drag on the Projects board: the lift gate, the slot
 * hit-test arithmetic, the archived-run slot rule, the autoscroll curve, the drop
 * verdict and the two-write order of a cross-column drop, plus the drag's motion
 * durations and document cursor tokens. The drag engine and the seam call it.
 *
 * Import-free and structurally typed on purpose: `scripts/board-drag-model.test.mjs`
 * loads this module through Node's type stripping, which erases types rather than
 * compiling them and resolves no bundler aliases. A runtime or aliased import added
 * here fails that test.
 */

export const LIFT_THRESHOLD_PX = 5;
export const COLUMN_EDGE_ZONE_PX = 48;
export const BOARD_EDGE_ZONE_PX = 64;
export const AUTOSCROLL_MAX_PX_PER_S = 900;
/** The gap a row carries around its card; mirrors BoardColumn's `pb-1.5` / first-row `pt-1.5`. */
export const ROW_GAP_PX = 6;
/** The drag's whole motion budget; the timer that removes the fading ghost and
 *  the inline styles that animate it and the column tint read these. */
export const GHOST_FADE_MS = 120;
export const TINT_FADE_MS = 100;
/** Ease-out quart: the ghost leaves quickly and settles, with no overshoot. */
export const GHOST_FADE_EASING = "cubic-bezier(0.25, 1, 0.5, 1)";
/** Class tokens the seam puts on `document.documentElement` during a session, so
 *  the cursor holds over any element, outside the board too. Literal strings, so
 *  Tailwind emits their rules from this file. */
export const DRAG_DOCUMENT_TOKENS: Record<
  "lifted" | "blocked",
  readonly string[]
> = {
  lifted: ["select-none", "[&_*]:cursor-grabbing!"],
  blocked: ["select-none", "[&_*]:cursor-not-allowed!"],
};

/** The longest frame `autoscrollStep` honours, so a stalled tab cannot jump. */
const MAX_STEP_MS = 50;

/** A row's box inside its column's scroll content, px. */
type RowBox = { start: number; size: number };

/** Plain primary mouse presses only: touch and pen keep their long-press menu, and
 *  a modified press belongs to the board's selection grammar. The caller supplies
 *  `modified`: this module is import-free, and the repo guard keeps raw modifier
 *  flag reads inside src/lib/hotkeys/. */
export function isLiftPress(e: {
  pointerType: string;
  isPrimary: boolean;
  button: number;
  modified: boolean;
}): boolean {
  return (
    e.pointerType === "mouse" && e.isPrimary && e.button === 0 && !e.modified
  );
}

/** A session's cancel key: Escape, and only from the user agent, since a
 *  synthetic key is never the user's cancel. */
export function isCancelKey(e: { key: string; trusted: boolean }): boolean {
  return e.trusted && e.key === "Escape";
}

/** True once the pointer is LIFT_THRESHOLD_PX or more (Euclidean) from the press point. */
export function crossedLiftThreshold(dx: number, dy: number): boolean {
  return dx * dx + dy * dy >= LIFT_THRESHOLD_PX * LIFT_THRESHOLD_PX;
}

/** The slot index: the smallest k in [0, count) with
 *  contentY < rowAt(k).start + rowAt(k).size / 2 (strictly less), or `count` when no row satisfies it.
 *  A pointer exactly on a row's midpoint therefore lands in the slot AFTER that row. */
export function slotIndexAt(
  contentY: number,
  count: number,
  rowAt: (index: number) => RowBox,
): number {
  for (let k = 0; k < count; k += 1) {
    const row = rowAt(k);
    if (contentY < row.start + row.size / 2) return k;
  }
  return count;
}

/** The insertion line's centre in content px for slot `index`: ROW_GAP_PX / 2 for an empty column or
 *  slot 0; half a gap above row `index`'s start otherwise; half a gap above the last row's end for
 *  index === count. */
export function slotLineY(
  index: number,
  count: number,
  rowAt: (index: number) => RowBox,
): number {
  if (count === 0 || index <= 0) return ROW_GAP_PX / 2;
  if (index >= count) {
    const last = rowAt(count - 1);
    return last.start + last.size - ROW_GAP_PX / 2;
  }
  return rowAt(index).start - ROW_GAP_PX / 2;
}

/** Signed px/s for a scroller spanning [start, end] with the pointer at `pos`: 0 outside both zones,
 *  negative toward `start`, positive toward `end`, growing linearly from 0 at the zone's inner edge to
 *  AUTOSCROLL_MAX_PX_PER_S at the scroller's edge, and capped there beyond it. The zone actually used
 *  is min(zone, (end - start) / 2), so on a scroller shorter than two zones the two zones meet at the
 *  midpoint (velocity 0 there) and never overlap. */
export function edgeVelocity(
  pos: number,
  start: number,
  end: number,
  zone: number,
): number {
  const used = Math.min(zone, (end - start) / 2);
  if (!(used > 0)) return 0;
  if (pos < start + used)
    return -Math.min(1, (start + used - pos) / used) * AUTOSCROLL_MAX_PX_PER_S;
  if (pos > end - used)
    return Math.min(1, (pos - (end - used)) / used) * AUTOSCROLL_MAX_PX_PER_S;
  return 0;
}

/** px to scroll for one frame; `dtMs` is clamped to 50 so a stalled tab cannot jump. */
export function autoscrollStep(velocity: number, dtMs: number): number {
  const dt = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
  return (velocity * dt) / 1000;
}

export type DropVerdict =
  | { kind: "outside" }
  | { kind: "own-slot" }
  | { kind: "refused"; reason: string }
  | { kind: "valid"; crossColumn: boolean; afterId: string | null | undefined };

/** Rules, in order: (1) target null, or currentColumnId null, or targetItemIds null -> outside.
 *  (2) beforeId is neither null, movedId, nor in targetItemIds -> outside (the board moved under the
 *  drag). (3) same column (target.columnId === currentColumnId): plan held -> refused(truncatedReason);
 *  noop -> own-slot; move -> valid(false, afterId). (4) other column: moveHeld defined ->
 *  refused(moveHeld); plan held -> refused(truncatedReason); move -> valid(true, afterId); noop ->
 *  valid(true, undefined): a status write, and no slot write unless the re-plan after it finds one.
 *  "Own slot" is never computed here: it is planDrop's same-column `noop` (its rule 2b), passed in. */
export function classifyDrop(args: {
  target: { columnId: string; beforeId: string | null } | null;
  /** The column that draws the moved card NOW, read from the live host at this hover or drop; null
   *  when none does. Never a column remembered from the lift. */
  currentColumnId: string | null;
  movedId: string;
  targetItemIds: readonly string[] | null;
  moveHeld: string | undefined;
  plan:
    | { kind: "move"; afterId: string | null }
    | { kind: "noop" }
    | { kind: "held" };
  truncatedReason: string;
}): DropVerdict {
  const { target, currentColumnId, movedId, targetItemIds, moveHeld, plan } =
    args;
  if (target === null || currentColumnId === null || targetItemIds === null)
    return { kind: "outside" };
  const { beforeId } = target;
  if (
    beforeId !== null &&
    beforeId !== movedId &&
    !targetItemIds.includes(beforeId)
  )
    return { kind: "outside" };
  if (target.columnId === currentColumnId) {
    if (plan.kind === "held")
      return { kind: "refused", reason: args.truncatedReason };
    if (plan.kind === "noop") return { kind: "own-slot" };
    return { kind: "valid", crossColumn: false, afterId: plan.afterId };
  }
  if (moveHeld !== undefined) return { kind: "refused", reason: moveHeld };
  if (plan.kind === "held")
    return { kind: "refused", reason: args.truncatedReason };
  if (plan.kind === "move")
    return { kind: "valid", crossColumn: true, afterId: plan.afterId };
  return { kind: "valid", crossColumn: true, afterId: undefined };
}

/** GitHub refuses an archived card as a position anchor, so a slot inside or directly below a run of
 *  archived cards cannot be written: it resolves to the slot directly above that run. `column` is the
 *  target column in drawn order as the planner reads it (a restoring card counts archived). Returns
 *  `beforeId` unchanged when the card above the slot is live, the slot is the column's first, or the
 *  column does not hold `beforeId`. The moved card is an ordinary live card here. */
export function slotAboveArchivedRun(args: {
  column: readonly { itemId: string; isArchived: boolean }[];
  beforeId: string | null;
}): string | null {
  const { column, beforeId } = args;
  const index =
    beforeId === null
      ? column.length
      : column.findIndex((card) => card.itemId === beforeId);
  if (index === -1) return beforeId;
  let k = index;
  while (k > 0 && column[k - 1].isArchived) k -= 1;
  return k === index ? beforeId : column[k].itemId;
}

/** Where the card is drawn in the target column once the writes land, and that column's count.
 *  `order`: the ids of the host's `loaded` list, in its order, archived cards included.
 *  `column`: the ids the TARGET column draws now, in drawn order, with or without movedId.
 *  `afterId`: the anchor the position write will send (null = top of the board); undefined = no
 *  position write, so the card keeps its place in `order`.
 *  Result: `idx` is the card's 0-based index among the column's drawn cards once it sits after
 *  `afterId` in `order`; `count` is the column's ids without movedId, plus one. */
export function dropLanding(args: {
  order: readonly string[];
  column: readonly string[];
  movedId: string;
  afterId: string | null | undefined;
}): { idx: number; count: number } {
  const { order, column, movedId, afterId } = args;
  const others = column.filter((id) => id !== movedId);
  const count = others.length + 1;
  // An anchor the order doesn't hold leaves the card where it is, as the cache
  // splice does with an unknown anchor.
  let landed: readonly string[] = order;
  if (afterId !== undefined) {
    const rest = order.filter((id) => id !== movedId);
    const to = afterId === null ? 0 : rest.lastIndexOf(afterId) + 1;
    if (afterId === null || to > 0)
      landed = [...rest.slice(0, to), movedId, ...rest.slice(to)];
  }
  const drawn = new Set(others);
  drawn.add(movedId);
  const idx = landed.filter((id) => drawn.has(id)).indexOf(movedId);
  return { idx: idx === -1 ? others.length : idx, count };
}

/** After the status write settled. Rules in order: liveRepo !== pinned.repo -> skip "repo"; live null
 *  (the root unmounted) or live.signature !== pinned.signature -> skip "board"; target column missing
 *  -> skip "column-gone"; that column does not draw movedId -> skip "card-left"; then replan(), the
 *  caller's re-plan on the LIVE board (dropAnchor for a slotted drop, whose status write already
 *  draws the card at the slot; planDrop otherwise): move -> write; else skip "nothing-to-write". */
export function recheckSlot(args: {
  pinned: {
    repo: string;
    signature: string;
    movedId: string;
    targetColumnId: string;
  };
  liveRepo: string | null;
  live: {
    signature: string;
    columns: readonly { id: string; itemIds: readonly string[] }[];
  } | null;
  replan: () =>
    | { kind: "move"; afterId: string | null }
    | { kind: "noop" }
    | { kind: "held" };
}):
  | { kind: "write"; afterId: string | null }
  | {
      kind: "skip";
      why: "repo" | "board" | "column-gone" | "card-left" | "nothing-to-write";
    } {
  const { pinned, liveRepo, live } = args;
  if (liveRepo !== pinned.repo) return { kind: "skip", why: "repo" };
  if (live === null || live.signature !== pinned.signature)
    return { kind: "skip", why: "board" };
  const column = live.columns.find((c) => c.id === pinned.targetColumnId);
  if (column === undefined) return { kind: "skip", why: "column-gone" };
  if (!column.itemIds.includes(pinned.movedId))
    return { kind: "skip", why: "card-left" };
  const plan = args.replan();
  if (plan.kind === "move") return { kind: "write", afterId: plan.afterId };
  return { kind: "skip", why: "nothing-to-write" };
}

/** Status first; the slot write starts only after it resolved AND recheck says write. A rejected
 *  status write is swallowed here (its hook reported it). */
export async function runCrossColumnDrop(deps: {
  writeStatus: () => Promise<unknown>;
  recheck: () => ReturnType<typeof recheckSlot>;
  writeSlot: (afterId: string | null) => void;
}): Promise<"status-failed" | "slot-skipped" | "slot-written"> {
  try {
    await deps.writeStatus();
  } catch {
    return "status-failed";
  }
  const verdict = deps.recheck();
  if (verdict.kind !== "write") return "slot-skipped";
  deps.writeSlot(verdict.afterId);
  return "slot-written";
}
