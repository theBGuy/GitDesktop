/**
 * The Clean up dialog's selection policy. Import-free apart from a type-only
 * import: the node suites load it straight from `src/` under Node's type
 * stripping.
 *
 * The selection survives a close and reopen, minus the rows only a verdict
 * checked, which the reopen's own verdicts decide again. It re-seeds to the
 * pre-checked set when the repo changes, or when that set changes across a
 * control change or a reopen; new data that moves the set within one open
 * merges only the change, so the user's touches stand. After a batch that left
 * the dialog open, until the user changes the mode, window, criteria or
 * worktree opt-in, or closes it, a changed set only prunes names no longer
 * listed, or held for good (dirty, locked, unreadable); a pending read holds
 * only for now. So a batch never re-checks a row the user unchecked.
 */

import type { ContentVerdict } from "@/lib/git/api";

/** A set of branch names as one comparable key: sorted, newline-joined (git ref
 *  names can't hold a newline), so a pure reorder isn't a new set. */
export function selectionKey(names: readonly string[]): string {
  return [...names].sort().join("\n");
}

export function namesOfKey(key: string): string[] {
  return key ? key.split("\n") : [];
}

export interface SelectionSeed {
  /** The repo the selection was seeded in; the dialog outlives a repo switch. */
  repo: string | null;
  /** The pre-checked key the selection was last seeded from (or adopted). */
  seededKey: string | null;
  /** The control context (mode, window, the three criteria and the worktree
   *  opt-in) of the last batch that left the dialog open. */
  afterBatch: string | null;
  /** The control context the last unheld step of this open saw, recorded on
   *  every such step; null after a close, so a reopen's first step counts as a
   *  control change. A held step keeps it, so a control changed under a hold
   *  still counts once the hold lifts. */
  context: string | null;
}

export type SelectionAction = "none" | "prune" | "merge" | "reseed";

/** What the selection does on a render of the dialog's inputs. */
export function selectionStep(
  seed: SelectionSeed,
  input: {
    repo: string;
    open: boolean;
    running: boolean;
    holdingReads: boolean;
    context: string;
    autoKey: string;
  },
): SelectionSeed & { action: SelectionAction } {
  // A close keeps the seed, so a reopen over the same set keeps the user's
  // choices; it ends the post-batch window and forgets the context.
  if (!input.open)
    return { ...seed, afterBatch: null, context: null, action: "none" };
  // Never under a running batch, nor off reads still standing in.
  if (input.running || input.holdingReads) return { ...seed, action: "none" };
  const { repo, autoKey, context } = input;
  if (seed.repo !== repo)
    return {
      repo,
      seededKey: autoKey,
      afterBatch: null,
      context,
      action: "reseed",
    };
  if (seed.afterBatch !== null && seed.afterBatch === context)
    return {
      repo,
      seededKey: autoKey,
      afterBatch: seed.afterBatch,
      context,
      action: "prune",
    };
  const next = { repo, seededKey: autoKey, afterBatch: null, context };
  if (seed.seededKey === autoKey) return { ...next, action: "none" };
  // Same open, same controls: only new data moved the set.
  if (seed.context === context) return { ...next, action: "merge" };
  return { ...next, action: "reseed" };
}

/** The selection with every non-candidate dropped; the input itself when
 *  nothing drops, so an unchanged selection doesn't re-render. */
export function keepCandidates<S extends ReadonlySet<string>>(
  selected: S,
  candidateKey: string,
): S | Set<string> {
  const candidates = new Set(namesOfKey(candidateKey));
  const kept = [...selected].filter((n) => candidates.has(n));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** The selection without each of `names` the user hasn't touched; the input
 *  itself when nothing drops. */
export function dropUntouched<S extends ReadonlySet<string>>(
  selected: S,
  names: ReadonlySet<string>,
  touched: ReadonlySet<string>,
): S | Set<string> {
  const kept = [...selected].filter((n) => !names.has(n) || touched.has(n));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** The selection after a batch: the pre-run selection minus each name the batch
 *  processed without a failure. */
export function selectionAfterBatch(
  selected: ReadonlySet<string>,
  names: readonly string[],
  processed: number,
  failed: { has(name: string): boolean },
): Set<string> {
  const done = new Set(names.slice(0, processed).filter((n) => !failed.has(n)));
  return new Set([...selected].filter((n) => !done.has(n)));
}

/** Select all: every actionable name, plus each checked name a pending read
 *  holds right now, so the press never drops a row the user chose. */
export function selectAllOver(
  selected: ReadonlySet<string>,
  pendingHeld: readonly string[],
  actionable: readonly string[],
): Set<string> {
  const held = new Set(pendingHeld);
  return new Set([...[...selected].filter((n) => held.has(n)), ...actionable]);
}

/** Pre-check for a verdict-gated row once its verdict settled. `fallbackCheck`
 *  is the row's policy without a verdict (idle → true, PR-name only → false),
 *  which an unanswered check keeps; unique changes never pre-check. */
export function settledPreCheck(
  verdict: ContentVerdict,
  fallbackCheck: boolean,
): boolean {
  const byVerdict: Record<ContentVerdict, boolean> = {
    clean: true,
    changes: false,
    unknown: fallbackCheck,
  };
  return byVerdict[verdict];
}

/** The selection with every untouched `shouldCheck` name added. It never
 *  removes a name, so a landing can't undo a user's check, and `touched` keeps
 *  it off a row the user unchecked; the input itself when nothing is added. */
export function applySettledChecks<S extends ReadonlySet<string>>(
  selected: S,
  touched: ReadonlySet<string>,
  shouldCheck: readonly string[],
): S | Set<string> {
  const add = shouldCheck.filter((n) => !touched.has(n) && !selected.has(n));
  return add.length === 0 ? selected : new Set([...selected, ...add]);
}
