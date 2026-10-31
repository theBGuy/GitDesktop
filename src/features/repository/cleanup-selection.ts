/**
 * The Clean up dialog's selection policy. Import-free on purpose: the node
 * suites load it straight from `src/` under Node's type stripping.
 *
 * The selection survives a close and reopen; it re-seeds to the pre-checked set
 * only when the repo or that set changes. After a batch that left the dialog
 * open, until the user changes the mode or window or closes it, a changed set
 * only prunes names that stopped being candidates, so a batch never re-checks
 * a row the user unchecked.
 */

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
  /** The mode/window context of the last batch that left the dialog open. */
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

/** The selection after a batch that stopped early or partly failed: the pre-run
 *  selection minus each name the batch processed without a failure. */
export function selectionAfterBatch(
  selected: ReadonlySet<string>,
  names: readonly string[],
  processed: number,
  failed: { has(name: string): boolean },
): Set<string> {
  const done = new Set(names.slice(0, processed).filter((n) => !failed.has(n)));
  return new Set([...selected].filter((n) => !done.has(n)));
}
