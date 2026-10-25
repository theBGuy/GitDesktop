// What the Changes list does when a tracked row leaves its section between two
// status reads, and which file shows next. Import-free so
// scripts/next-file-after-stage.test.mjs loads it under Node's type stripping.
// Keys use the panel's `"<section>:<path>"` spelling (section: staged|unstaged).

export type PruneOutcome = "keep" | "clear" | "advance";

/** What the status transition does with a tracked row (selected or focused)
 *  whose side membership changed between two status reads. A row still in its
 *  section (a partial stage) is kept; a commit, an AI-resolve walk (whose own
 *  pick wins, through its last file too) and a file gone from both sides
 *  clear; anything else advances. */
export function pruneDecision(opts: {
  /** Its own side is still present in the current entries. */
  stillInSection: boolean;
  /** The same path now has a row on the OTHER side. */
  presentInOther: boolean;
  /** `branch.oid` differs between the two reads (a commit). */
  headMoved: boolean;
  /** The conflict-resolve walk is active for this repo. */
  walkActive: boolean;
  /** The walk was active at, or since, the previous read: the walk's end
   *  stages its last file after the walk itself has closed. */
  walkWasActive: boolean;
}): PruneOutcome {
  if (opts.stillInSection) return "keep";
  if (
    opts.headMoved ||
    opts.walkActive ||
    opts.walkWasActive ||
    !opts.presentInOther
  )
    return "clear";
  return "advance";
}

function sectionOfKey(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/** First still-eligible key BELOW removedKey in the previous on-screen order,
 *  SAME section only (never cross: the "row above" an unstaged row can be the
 *  very file just staged); else nearest eligible ABOVE; else null. No wrap.
 *  Keys removed in the same pass are simply absent from eligibleNow, so a
 *  multi-file stage lands on the nearest row that is left. */
export function nextFileKey(
  /** The previous render's VISIBLE nav order, file rows only. */
  prevKeys: readonly string[],
  removedKey: string,
  /** The current visible, file-row, non-conflicted keys. */
  eligibleNow: ReadonlySet<string>,
): string | null {
  const at = prevKeys.indexOf(removedKey);
  if (at === -1) return null;
  const section = sectionOfKey(removedKey);
  const eligible = (key: string) =>
    key !== removedKey && sectionOfKey(key) === section && eligibleNow.has(key);
  for (let i = at + 1; i < prevKeys.length; i++) {
    if (eligible(prevKeys[i])) return prevKeys[i];
  }
  for (let i = at - 1; i >= 0; i--) {
    if (eligible(prevKeys[i])) return prevKeys[i];
  }
  return null;
}

/** The multi-selection after the active row advanced: only the row that left
 *  drops out, and the successor joins as the new active row. */
export function selectionAfterAdvance(
  selected: ReadonlySet<string>,
  removedKey: string,
  nextKey: string,
): Set<string> {
  const out = new Set(selected);
  out.delete(removedKey);
  out.add(nextKey);
  return out;
}

/** Where focus sits while an advance waits to land it: on nobody (`orphaned`),
 *  still inside the dialog that held it (`dialog`), or on a live control of
 *  somebody else's (`other`). */
export type WaitingFocus = "orphaned" | "dialog" | "other";

/** One frame of an advance's focus claim armed while a dialog (the marker
 *  confirm) held focus: claim once the dialog's focus return has left focus
 *  orphaned; keep waiting while focus is still in the dialog and the deadline
 *  (a time, since frame rates vary) hasn't passed; drop it the moment somebody
 *  else owns focus, or once the deadline has. */
export function dialogClaimStep(
  focus: WaitingFocus,
  now: number,
  deadline: number,
): "claim" | "wait" | "drop" {
  if (focus === "orphaned") return "claim";
  if (focus === "dialog" && now < deadline) return "wait";
  return "drop";
}
