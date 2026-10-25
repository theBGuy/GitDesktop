// The diff panes' two-slot hold, as pure transitions over what is painted
// (`shown`) and what the selection asks for (`target`), and the post-write
// hold's release test over the reads' answer marks. React-free so
// scripts/diff-pane-hold.test.mjs loads it under Node's type stripping.

/** One thing the pane can paint. `F` is the selected file's own shape. A file
 *  view carries its host's entity axis (the commit, comparison, stash or pull
 *  request it belongs to); a host's placeholder may carry one too. */
export type PaneView<F> =
  | { kind: "placeholder"; entity?: string }
  | { kind: "conflict"; key: string }
  | { kind: "file"; key: string; repo: string; entity: string; file: F };

/** `shown` differs from `target` only while a file prepares out of sight,
 *  clipped over the shown view. */
export interface PaneHold<F> {
  shown: PaneView<F>;
  target: PaneView<F>;
  /** Whether `shown` is settled now. A shown file that isn't (one the bound
   *  promoted, or one loading again) is replaced outright by the next click,
   *  never held, and is held again once it settles. */
  shownSettled: boolean;
  /** The slots' React keys. A promotion or an in-place re-target keeps its
   *  slot's id, so the slot never remounts; only a fresh target takes a new one. */
  shownId: string;
  targetId: string;
  nextId: number;
}

export type SlotPhase = "shown" | "held" | "preparing";

export interface PaneSlot<F> {
  view: PaneView<F>;
  phase: SlotPhase;
  slotId: string;
}

/** The line widget a slot renders, and the one it keeps for later. A held slot
 *  keeps the one it had while shown (another file's selection owns the live
 *  one); a shown or preparing slot's file IS the selection, so it follows the
 *  live widget, and a promotion never swaps the diff view under it. */
export function slotWidget<W>(
  phase: SlotPhase,
  live: W,
  kept: W,
): { render: W; keep: W } {
  return phase === "held"
    ? { render: kept, keep: kept }
    : { render: live, keep: live };
}

/** How long a target may prepare unseen before it is promoted regardless: a slow
 *  file then shows its own loading frames rather than pinning stale content. */
export const HOLD_BOUND_MS = 400;

/** The Changes pane's entity axis: one working tree, so never an entity change. */
export const WORKING_TREE_ENTITY = "working-tree";

/** A file target within one host entity. `key` tells the host's files apart
 *  inside that entity. */
export function keyedPaneView<F>(
  repo: string,
  entity: string,
  key: string,
  file: F,
): PaneView<F> {
  return { kind: "file", key, repo, entity, file };
}

/** A host's no-file view, tied to its entity so it never holds across one. */
export function placeholderPaneView(entity?: string): PaneView<never> {
  return entity === undefined
    ? { kind: "placeholder" }
    : { kind: "placeholder", entity };
}

/** A Changes file target. The key carries `staged` because the two sides of one
 *  path are different diffs whose response can't tell them apart. */
export function filePaneView<F extends { path: string; staged: boolean }>(
  repo: string,
  file: F,
): PaneView<F> {
  return keyedPaneView(
    repo,
    WORKING_TREE_ENTITY,
    `${repo}:${file.staged}:${file.path}`,
    file,
  );
}

/** A view's identity within its repo. Equal identities are the same view, not
 *  necessarily the same paint: a conflict's resolve mode and the placeholder's
 *  message follow live state. A host's placeholder is one per entity. */
export function paneViewKey<F>(view: PaneView<F>): string {
  switch (view.kind) {
    case "placeholder":
      return view.entity === undefined
        ? "placeholder"
        : `placeholder:${view.entity}`;
    case "conflict":
      return `conflict:${view.key}`;
    case "file":
      return `file:${view.entity}:${view.key}`;
  }
}

function sameView<F>(a: PaneView<F>, b: PaneView<F>): boolean {
  if (paneViewKey(a) !== paneViewKey(b)) return false;
  return a.kind !== "file" || b.kind !== "file" || a.repo === b.repo;
}

/** A view painted at once. Only a file slot reports its settle, so only a file
 *  starts unsettled; the placeholder never loads, and a conflict view is never
 *  held, so its own loading never matters here. */
export function startPaneHold<F>(target: PaneView<F>): PaneHold<F> {
  return {
    shown: target,
    target,
    shownSettled: target.kind !== "file",
    shownId: "0",
    targetId: "0",
    nextId: 1,
  };
}

/** `target` painted at once in a fresh slot. */
function replaced<F>(hold: PaneHold<F>, target: PaneView<F>): PaneHold<F> {
  const id = String(hold.nextId);
  return {
    shown: target,
    target,
    shownSettled: target.kind !== "file",
    shownId: id,
    targetId: id,
    nextId: hold.nextId + 1,
  };
}

export function isHolding<F>(hold: PaneHold<F>): boolean {
  return !sameView(hold.shown, hold.target);
}

/** A file prepares out of sight, clipped over the placeholder or another
 *  SETTLED file of the same repo and entity. Conflict views keep their own
 *  lifecycle, a slot never crosses repos or entities, and a file still loading
 *  is replaced, since holding it would paint it in before the target swaps
 *  over it. */
function preparesOutOfSight<F>(
  hold: PaneHold<F>,
  target: PaneView<F>,
): boolean {
  const shown = hold.shown;
  if (target.kind !== "file") return false;
  switch (shown.kind) {
    case "placeholder":
      return shown.entity === undefined || shown.entity === target.entity;
    case "conflict":
      return false;
    case "file":
      return (
        hold.shownSettled &&
        shown.repo === target.repo &&
        shown.entity === target.entity &&
        shown.key !== target.key
      );
  }
}

/** Same object back when the target is unchanged, so a render can compare by
 *  identity before storing it. While holding, `shown` stays the last settled. */
export function retargetPane<F>(
  hold: PaneHold<F>,
  target: PaneView<F>,
): PaneHold<F> {
  if (sameView(hold.target, target)) return hold;
  // Back to the view already painted (the held one): its settle stands.
  if (sameView(hold.shown, target))
    return { ...hold, shown: target, target, targetId: hold.shownId };
  // Another entity of the same host re-targets the shown slot in place, any
  // hold dropped: its mounted reads move to the new keys and serve the
  // previous answer as a placeholder, where a remount would paint blank.
  const shown = hold.shown;
  if (
    shown.kind === "file" &&
    target.kind === "file" &&
    shown.repo === target.repo &&
    shown.entity !== target.entity
  )
    return {
      ...hold,
      shown: target,
      target,
      shownSettled: false,
      targetId: hold.shownId,
    };
  if (preparesOutOfSight(hold, target))
    return {
      ...hold,
      target,
      targetId: String(hold.nextId),
      nextId: hold.nextId + 1,
    };
  return replaced(hold, target);
}

function isFileView<F>(
  view: PaneView<F>,
  key: string,
  repo: string,
  entity: string,
): boolean {
  return (
    view.kind === "file" &&
    view.key === key &&
    view.repo === repo &&
    view.entity === entity
  );
}

/** A slot's settle report, either edge. The preparing target's first settled
 *  report promotes it under its own slot id. A report for the shown view (held
 *  or not) sets whether it is settled now, both ways. Any other slot's report
 *  (a replaced target's, another repo's, or the previous entity's read on the
 *  same path) is ignored. */
export function settlePane<F>(
  hold: PaneHold<F>,
  key: string,
  repo: string,
  entity: string,
  settled: boolean,
): PaneHold<F> {
  const { shown, target } = hold;
  if (isHolding(hold) && isFileView(target, key, repo, entity))
    return settled
      ? { ...hold, shown: target, shownSettled: true, shownId: hold.targetId }
      : hold;
  if (!isFileView(shown, key, repo, entity) || hold.shownSettled === settled)
    return hold;
  return { ...hold, shownSettled: settled };
}

/** The bound's expiry for the target it was armed for: promoted unsettled,
 *  under its own slot id. */
export function expirePane<F>(
  hold: PaneHold<F>,
  key: string,
  entity: string,
): PaneHold<F> {
  const target = hold.target;
  if (
    !isHolding(hold) ||
    target.kind !== "file" ||
    target.key !== key ||
    target.entity !== entity
  )
    return hold;
  return {
    ...hold,
    shown: target,
    shownSettled: false,
    shownId: hold.targetId,
  };
}

/** The slots to render, in paint order: a held view stays in flow while the
 *  target lays out, clipped, over it. */
export function paneSlots<F>(hold: PaneHold<F>): PaneSlot<F>[] {
  return isHolding(hold)
    ? [
        { view: hold.shown, phase: "held", slotId: hold.shownId },
        { view: hold.target, phase: "preparing", slotId: hold.targetId },
      ]
    : [{ view: hold.target, phase: "shown", slotId: hold.targetId }];
}

/** What changes each time a query answers: its data stamp and error count.
 *  Compared for identity, never order, so a clock stepping backwards between
 *  two answers still reads as a new one. */
export const answerMark = (s: {
  dataUpdatedAt: number;
  errorUpdateCount: number;
}) => `${s.dataUpdatedAt}:${s.errorUpdateCount}`;

/** The shown query has answered since the settle that captured `before` (the
 *  marks of every cache entry the read could be showing then), so the
 *  post-write hold can release. */
export const answeredSince = (
  q: { isFetched: boolean; dataUpdatedAt: number; errorUpdateCount: number },
  before: ReadonlySet<string>,
) => q.isFetched && !before.has(answerMark(q));

/** Which status answer the post-write hold waits on. An untracked file's
 *  partial stage re-keys the diff from status, so it always waits. A tracked
 *  stage or unstage waits only once its fresh diff answers empty: the side may
 *  have emptied, and only status tells that from a stale row. A tracked
 *  discard never waits. */
export type StatusWait = "always" | "if-emptied" | null;

export function statusWaitFor(
  kind: "stage" | "unstage" | "discard",
  untracked: boolean,
): StatusWait {
  if (untracked) return "always";
  return kind === "discard" ? null : "if-emptied";
}

/** Whether the hold still waits on status: never once status has answered,
 *  and for an `if-emptied` write only after the diff answered empty, so a
 *  press that leaves content releases on the diff's answer alone. */
export function statusBehind(
  wait: StatusWait,
  statusAnswered: boolean,
  diff: { answered: boolean; empty: boolean },
): boolean {
  if (wait === null || statusAnswered) return false;
  return wait === "always" || (diff.answered && diff.empty);
}

/** One render of the Changes pane's staging view, for what it keeps painted. */
export interface StagingKeepInputs {
  /** The live diff parses to hunks, so the pane paints it. */
  live: boolean;
  /** The pane's slot is the shown one. */
  interactive: boolean;
  /** A stage or unstage from this pane hasn't released yet. */
  writeHolding: boolean;
  /** That write's settle is in and this side has answered empty since. */
  emptiedByWrite: boolean;
  /** No write from this pane is held: status answered for the last one. */
  writeReleased: boolean;
  /** Status lists the file on this side. */
  onSide: boolean;
  /** This side's answer has content. */
  nonEmptyAnswer: boolean;
  /** The bound since status took the file off this side has run out. */
  leftBoundExpired: boolean;
}

export interface StagingKeep {
  /** A hunk view is on screen: the live one, or the one kept. */
  hasView: boolean;
  /** A stage or unstage emptied this side. */
  emptied: boolean;
}

export const NO_STAGING_KEEP: StagingKeep = { hasView: false, emptied: false };

/**
 * Whether the staging view keeps its last hunk view instead of falling back
 * (which would repaint the pane), and what it keeps next. It keeps while its
 * slot is held or preparing, while a stage or unstage is still settling, and
 * while that write has emptied the side. The emptied keep ends on a non-empty
 * answer, on status still listing the file once the write released, or a
 * bound after status took the file away: the selection's move or prune comes
 * a render later, and a hidden Changes list never prunes. A view no longer on
 * screen (the fallback shown) is never kept again.
 */
export function stagingKeep(
  prev: StagingKeep,
  i: StagingKeepInputs,
): StagingKeep & { kept: boolean } {
  const released =
    i.nonEmptyAnswer || (i.writeReleased && (i.onSide || i.leftBoundExpired));
  const emptied = i.emptiedByWrite || (prev.emptied && !released);
  const kept =
    !i.live && prev.hasView && (!i.interactive || i.writeHolding || emptied);
  return { hasView: i.live || kept, emptied, kept };
}
