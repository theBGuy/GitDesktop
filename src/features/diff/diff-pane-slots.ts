// The Changes pane's two-slot hold, as pure transitions over what is painted
// (`shown`) and what the selection asks for (`target`). React-free so
// scripts/diff-pane-hold.test.mjs loads it under Node's type stripping.

/** One thing the pane can paint. `F` is the selected file's own shape. */
export type PaneView<F> =
  | { kind: "placeholder" }
  | { kind: "conflict"; key: string }
  | { kind: "file"; key: string; repo: string; file: F };

/** `shown` differs from `target` only while a file prepares behind it. */
export interface PaneHold<F> {
  shown: PaneView<F>;
  target: PaneView<F>;
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

/** A view's identity: equal keys paint the same thing (also the React key). */
export function paneViewKey<F>(view: PaneView<F>): string {
  return view.kind === "placeholder"
    ? "placeholder"
    : `${view.kind}:${view.key}`;
}

export function startPaneHold<F>(target: PaneView<F>): PaneHold<F> {
  return { shown: target, target };
}

export function isHolding<F>(hold: PaneHold<F>): boolean {
  return paneViewKey(hold.shown) !== paneViewKey(hold.target);
}

/** A file prepares behind the placeholder or another file of the same repo.
 *  Conflict views keep their own lifecycle, and a slot never crosses repos. */
function preparesBehind<F>(shown: PaneView<F>, target: PaneView<F>): boolean {
  if (target.kind !== "file") return false;
  switch (shown.kind) {
    case "placeholder":
      return true;
    case "conflict":
      return false;
    case "file":
      return shown.repo === target.repo && shown.key !== target.key;
  }
}

/** Same object back when the target is unchanged, so a render can compare by
 *  identity before storing it. While holding, `shown` stays the last settled. */
export function retargetPane<F>(
  hold: PaneHold<F>,
  target: PaneView<F>,
): PaneHold<F> {
  if (paneViewKey(hold.target) === paneViewKey(target)) return hold;
  return preparesBehind(hold.shown, target)
    ? { shown: hold.shown, target }
    : startPaneHold(target);
}

function promote<F>(hold: PaneHold<F>, key: string): PaneHold<F> {
  const target = hold.target;
  if (!isHolding(hold) || target.kind !== "file" || target.key !== key)
    return hold;
  return startPaneHold(target);
}

/** A slot's settled report: promotes only the current target in the repo it was
 *  prepared for, so a replaced slot's late report is ignored. */
export function settlePane<F>(
  hold: PaneHold<F>,
  key: string,
  repo: string,
): PaneHold<F> {
  return hold.target.kind === "file" && hold.target.repo === repo
    ? promote(hold, key)
    : hold;
}

/** The bound's expiry for the target it was armed for. */
export function expirePane<F>(hold: PaneHold<F>, key: string): PaneHold<F> {
  return promote(hold, key);
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
