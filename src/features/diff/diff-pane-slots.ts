// The Changes pane's two-slot hold, as pure transitions over what is painted
// (`shown`) and what the selection asks for (`target`). React-free so
// scripts/diff-pane-hold.test.mjs loads it under Node's type stripping.

/** One thing the pane can paint. `F` is the selected file's own shape. */
export type PaneView<F> =
  | { kind: "placeholder" }
  | { kind: "conflict"; key: string }
  | { kind: "file"; key: string; repo: string; file: F };

/** `shown` differs from `target` only while a file prepares out of sight,
 *  stacked invisibly over the shown view. */
export interface PaneHold<F> {
  shown: PaneView<F>;
  target: PaneView<F>;
  /** Whether `shown` is settled now. A shown file that isn't (one the bound
   *  promoted, or one loading again) is replaced outright by the next click,
   *  never held, and is held again once it settles. */
  shownSettled: boolean;
}

export type SlotPhase = "shown" | "held" | "preparing";

export interface PaneSlot<F> {
  view: PaneView<F>;
  phase: SlotPhase;
}

/** How long a target may prepare unseen before it is promoted regardless: a slow
 *  file then shows its own loading frames rather than pinning stale content. */
export const HOLD_BOUND_MS = 400;

/** A file target. The key carries `staged` because the two sides of one path
 *  are different diffs whose response can't tell them apart. */
export function filePaneView<F extends { path: string; staged: boolean }>(
  repo: string,
  file: F,
): PaneView<F> {
  return {
    kind: "file",
    key: `${repo}:${file.staged}:${file.path}`,
    repo,
    file,
  };
}

/** A view's identity, also its React key. Equal keys are the same view, not
 *  necessarily the same paint: a conflict's resolve mode and the placeholder's
 *  message follow live state. */
export function paneViewKey<F>(view: PaneView<F>): string {
  return view.kind === "placeholder"
    ? "placeholder"
    : `${view.kind}:${view.key}`;
}

/** A view painted at once. Only a file slot reports its settle, so only a file
 *  starts unsettled; the placeholder never loads, and a conflict view is never
 *  held, so its own loading never matters here. */
export function startPaneHold<F>(target: PaneView<F>): PaneHold<F> {
  return { shown: target, target, shownSettled: target.kind !== "file" };
}

export function isHolding<F>(hold: PaneHold<F>): boolean {
  return paneViewKey(hold.shown) !== paneViewKey(hold.target);
}

/** A file prepares out of sight, stacked invisibly over the placeholder or
 *  another SETTLED file of the same repo. Conflict views keep their own
 *  lifecycle, a slot never crosses repos, and a file still loading is replaced,
 *  since holding it would paint it in before the target swaps over it. */
function preparesOutOfSight<F>(
  hold: PaneHold<F>,
  target: PaneView<F>,
): boolean {
  const shown = hold.shown;
  if (target.kind !== "file") return false;
  switch (shown.kind) {
    case "placeholder":
      return true;
    case "conflict":
      return false;
    case "file":
      return (
        hold.shownSettled &&
        shown.repo === target.repo &&
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
  if (paneViewKey(hold.target) === paneViewKey(target)) return hold;
  // Back to the view already painted (the held one): its settle stands.
  if (paneViewKey(hold.shown) === paneViewKey(target))
    return { shown: target, target, shownSettled: hold.shownSettled };
  return preparesOutOfSight(hold, target)
    ? { ...hold, target }
    : startPaneHold(target);
}

/** A slot's settle report, either edge. The preparing target's first settled
 *  report promotes it. A report for the shown view (held or not) sets whether
 *  it is settled now, both ways. Any other slot's report (a replaced target's,
 *  or another repo's) is ignored. */
export function settlePane<F>(
  hold: PaneHold<F>,
  key: string,
  repo: string,
  settled: boolean,
): PaneHold<F> {
  const { shown, target } = hold;
  const isView = (view: PaneView<F>) =>
    view.kind === "file" && view.key === key && view.repo === repo;
  if (isHolding(hold) && isView(target))
    return settled ? { shown: target, target, shownSettled: true } : hold;
  if (!isView(shown) || hold.shownSettled === settled) return hold;
  return { ...hold, shownSettled: settled };
}

/** The bound's expiry for the target it was armed for: promoted unsettled. */
export function expirePane<F>(hold: PaneHold<F>, key: string): PaneHold<F> {
  const target = hold.target;
  if (!isHolding(hold) || target.kind !== "file" || target.key !== key)
    return hold;
  return startPaneHold(target);
}

/** The slots to render, in paint order: a held view stays in flow while the
 *  target lays out invisibly over it. */
export function paneSlots<F>(hold: PaneHold<F>): PaneSlot<F>[] {
  return isHolding(hold)
    ? [
        { view: hold.shown, phase: "held" },
        { view: hold.target, phase: "preparing" },
      ]
    : [{ view: hold.target, phase: "shown" }];
}
