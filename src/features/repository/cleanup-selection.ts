/**
 * The Clean up dialog's selection policy. Import-free apart from a type-only
 * import: the node suites load it straight from `src/` under Node's type
 * stripping.
 *
 * The selection survives a close and reopen, minus the rows only a verdict
 * checked, which the reopen's own verdicts decide again; it re-seeds to the
 * pre-checked set only when the repo or that set changes. After a batch that
 * left the dialog open, until the user changes the mode, window, criteria or
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
}

export type SelectionAction = "none" | "prune" | "reseed";

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
  // choices; it only ends the post-batch window.
  if (!input.open) return { ...seed, afterBatch: null, action: "none" };
  // Never under a running batch, nor off reads still standing in.
  if (input.running || input.holdingReads) return { ...seed, action: "none" };
  const { repo, autoKey } = input;
  if (seed.repo !== repo)
    return { repo, seededKey: autoKey, afterBatch: null, action: "reseed" };
  if (seed.afterBatch !== null && seed.afterBatch === input.context)
    return {
      repo,
      seededKey: autoKey,
      afterBatch: seed.afterBatch,
      action: "prune",
    };
  if (seed.seededKey === autoKey)
    return { repo, seededKey: autoKey, afterBatch: null, action: "none" };
  return { repo, seededKey: autoKey, afterBatch: null, action: "reseed" };
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
