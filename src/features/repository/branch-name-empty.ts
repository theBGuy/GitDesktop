/** What one side (working tree, or committed work) of an empty branch-name run
 *  held: changes the patterns hid, only files whose names aren't readable text,
 *  or nothing at all. */
export type SideState = "patterns" | "unreadable" | "none";

/** One side's hidden counts: whether the patterns hid anything there, and how
 *  many of its files were left out for names that aren't readable text. */
export interface SideHidden {
  patternHidden: boolean;
  unreadable: number;
}

export function sideState({
  patternHidden,
  unreadable,
}: SideHidden): SideState {
  if (patternHidden) return "patterns";
  return unreadable > 0 ? "unreadable" : "none";
}

/** Empty-state copy with no committed work to fall back on, by working tree. */
const NO_FALLBACK_COPY: Record<SideState, string> = {
  patterns:
    "All changes match your AI ignore patterns — nothing to name a branch after.",
  unreadable:
    "Nothing to name a branch after — the only changed files have names that aren't readable text.",
  none: "No in-progress changes to name a branch after.",
};

/** Empty-state copy naming a branch that isn't checked out, by its committed
 *  work vs `base`. */
const COMMITTED_ONLY_COPY: Record<SideState, (base: string) => string> = {
  patterns: () =>
    "This branch's committed changes all match your AI ignore patterns — nothing to name it after.",
  unreadable: (base) =>
    `The only net changes vs ${base} are files whose names aren't readable text — nothing to name this branch after.`,
  none: (base) => `No net changes vs ${base} to name this branch after.`,
};

/** Empty-state copy by `<working tree>-<committed work>` state. A side holding
 *  only unreadable names is never described as having no changes. */
const BOTH_SIDES_COPY: Record<
  `${SideState}-${SideState}`,
  (base: string) => string
> = {
  "patterns-patterns": () =>
    "All changes match your AI ignore patterns — nothing left in your working tree or this branch's commits to name it after.",
  "unreadable-patterns": () =>
    "This branch's committed changes all match your AI ignore patterns, and the only in-progress changes are files whose names aren't readable text — nothing to name it after.",
  "none-patterns": () =>
    "This branch's committed changes all match your AI ignore patterns — nothing to name it after.",
  "patterns-unreadable": (base) =>
    `All your in-progress changes match your AI ignore patterns, and the only net changes vs ${base} are files whose names aren't readable text — nothing to name a branch after.`,
  "patterns-none": (base) =>
    `All your in-progress changes match your AI ignore patterns, and there are no net changes vs ${base} to name a branch after.`,
  "unreadable-unreadable": (base) =>
    `The only changes, in progress or committed vs ${base}, are files whose names aren't readable text — nothing to name a branch after.`,
  "unreadable-none": (base) =>
    `The only in-progress changes are files whose names aren't readable text, and there are no net changes vs ${base} to name a branch after.`,
  "none-unreadable": (base) =>
    `No in-progress changes, and the only net changes vs ${base} are files whose names aren't readable text — nothing to name a branch after.`,
  "none-none": (base) =>
    `No in-progress changes, and no net changes vs ${base} to name a branch after.`,
};

export const UNREADABLE_NOTE =
  " Some files were also left out because their names aren't readable text.";

/**
 * The toast for a branch-name run with nothing left to name the branch after.
 * `fallbackBase` is the default branch the committed work was diffed against,
 * null when there was none; `committed` is zero then. The working tree side is
 * zero when it wasn't read (`useWorkingTree: false`).
 */
export function branchNameEmptyMessage(input: {
  tree: SideHidden;
  committed: SideHidden;
  fallbackBase: string | null;
  useWorkingTree: boolean;
}): string {
  const { fallbackBase: base, useWorkingTree } = input;
  const tree = sideState(input.tree);
  const committed = sideState(input.committed);
  let message: string;
  if (base !== null && useWorkingTree) {
    message = BOTH_SIDES_COPY[`${tree}-${committed}`](base);
  } else if (base !== null) {
    message = COMMITTED_ONLY_COPY[committed](base);
  } else if (useWorkingTree) {
    message = NO_FALLBACK_COPY[tree];
  } else {
    // Defensive: the caller disables the affordance in this state, and with no
    // working tree read there are no in-progress changes to cite.
    message = "Nothing to name this branch after.";
  }
  // A side labelled by its patterns may also hold unreadable names; say so — the
  // other side's, if any, are already in the sentence.
  if (
    (tree === "patterns" && input.tree.unreadable > 0) ||
    (committed === "patterns" && input.committed.unreadable > 0)
  ) {
    message += UNREADABLE_NOTE;
  }
  return message;
}
