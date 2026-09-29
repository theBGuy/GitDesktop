// Type-only imports: scripts/pr-label-selection.test.mjs loads this file
// through Node's type stripping, which erases them but resolves no aliases.
import type { RemoteLens } from "@/lib/git/types";

/** The target a label list belongs to. Label names are validated against ONE
 *  repository's labels, so a proposal is only meaningful under the target it
 *  was produced for. */
export type LabelTargetSig = { repoPath: string; lens: RemoteLens };

/** The AI's current label proposal, stamped with the target it was validated
 *  against. */
export type AiLabelProposal = { names: string[]; sig: LabelTargetSig } | null;

export function sameLabelTarget(a: LabelTargetSig, b: LabelTargetSig): boolean {
  return a.repoPath === b.repoPath && a.lens === b.lens;
}

/** A proposal REPLACES the previous one: every stream chunk is a parse of the
 *  whole buffer so far, so the latest parse supersedes a half-typed name an
 *  earlier chunk matched, and never re-adds one the model has since dropped. */
export function applyAiProposal(
  names: string[],
  sig: LabelTargetSig,
): AiLabelProposal {
  return { names: [...names], sig };
}

/** The user's picks and removals after checking (`on`) or unchecking a label.
 *  Each move clears the opposite set's entry, so re-checking a removed name
 *  lifts its tombstone. Returns fresh sets; the inputs are never mutated. */
export function toggleLabelSets(
  added: ReadonlySet<string>,
  removed: ReadonlySet<string>,
  name: string,
  on: boolean,
): { added: Set<string>; removed: Set<string> } {
  const nextAdded = new Set(added);
  const nextRemoved = new Set(removed);
  if (on) {
    nextAdded.add(name);
    nextRemoved.delete(name);
  } else {
    nextRemoved.add(name);
    nextAdded.delete(name);
  }
  return { added: nextAdded, removed: nextRemoved };
}

/** The selected labels for the `current` target: the AI's proposal when it was
 *  made for this target, plus the user's own picks, minus the user's removals.
 *  Removals are tombstones that outlast later proposals, so a name the user
 *  took off never comes back from the model. */
export function deriveSelectedLabels(input: {
  ai: AiLabelProposal;
  added: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  current: LabelTargetSig;
}): Set<string> {
  const { ai, added, removed, current } = input;
  const proposed = ai && sameLabelTarget(ai.sig, current) ? ai.names : [];
  const selected = new Set<string>();
  for (const name of [...proposed, ...added])
    if (!removed.has(name)) selected.add(name);
  return selected;
}
