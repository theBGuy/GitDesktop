// Import-free: the one home of the create dialogs' default branch pair and
// their shared branch copy, so neither dialog imports the other.

/** What an unchosen branch picker shows. */
export const BRANCH_PLACEHOLDER = "Choose a branch";

/** The status line, and Create's reason, while that side is unchosen. */
export const UNCHOSEN_COPY: Record<"head" | "base", string> = {
  head: "Choose the branch to merge.",
  base: "Choose the branch to merge into.",
};

/** Shown while a dialog's commit count, or the read that picks its base ref,
 *  has no answer yet. */
export const COUNTING_COPY = "Counting commits to merge…";

/** Shown when the count read failed with nothing loaded for the pair. */
export const COUNT_FAILED_COPY = "Couldn't count the commits to merge.";

/** The base an open seeds for `head`: the default branch, or "" (unchosen)
 *  when it is unknown or is the head itself. Never a branch nobody named. */
export function defaultBaseFor(
  head: string,
  defaultBranch: string | null | undefined,
): string {
  return defaultBranch && defaultBranch !== head ? defaultBranch : "";
}

/** The pair an open seeds. A side the opener hands in wins; otherwise Merge is
 *  the current branch, left unchosen on a detached HEAD and, on the own
 *  repository, on the default branch itself (a fork's pull request to its
 *  parent keeps it, since that is a real pull request). */
export function defaultPrPair(input: {
  handedHead: string | undefined;
  handedBase: string | undefined;
  /** Null on a detached HEAD or before the status read answered. */
  current: string | null;
  defaultBranch: string | null | undefined;
  /** The effective target at seed time is the fork's parent. */
  parentTarget: boolean;
}): { head: string; base: string } {
  const { handedHead, handedBase, current, defaultBranch, parentTarget } =
    input;
  const ownDefault =
    !parentTarget && Boolean(defaultBranch) && current === defaultBranch;
  const head = handedHead ?? (current === null || ownDefault ? "" : current);
  return { head, base: handedBase ?? defaultBaseFor(head, defaultBranch) };
}

/** The side an unchosen pair asks for first: Merge before Base. */
export function unchosenSide(
  head: string,
  base: string,
): "head" | "base" | null {
  if (head === "") return "head";
  if (base === "") return "base";
  return null;
}

/** {@link unchosenSide} for the forge dialog, whose parent target fills an
 *  empty Base itself: while the parent's branches load, and once they loaded
 *  with a base the reconcile is about to write, the empty Base is that fill's
 *  transient, not a choice. A parent with no resolvable base still asks. */
export function forgeUnchosenSide(input: {
  head: string;
  base: string;
  baseLoading: boolean;
  targetIsParent: boolean;
  parentBase: string;
}): "head" | "base" | null {
  const { head, base, baseLoading, targetIsParent, parentBase } = input;
  if (head === "") return "head";
  if (base !== "" || baseLoading) return null;
  return targetIsParent && parentBase !== "" ? null : "base";
}

/** The forge dialog's status line under the pickers, in rank order. */
export type ForgeStatusArm =
  | "baseLoading"
  | "fetchError"
  | "unchosen"
  | "sameBranch"
  | "counting"
  | "countFailed"
  | "count";

/** Which status line the forge dialog shows. With no side unchosen, an empty
 *  side is a fill not yet written, so it counts rather than reading as zero. */
export function forgeStatusArm(input: {
  baseLoading: boolean;
  fetchError: boolean;
  unchosen: "head" | "base" | null;
  sideEmpty: boolean;
  sameBranch: boolean;
  counting: boolean;
  /** The count read failed with nothing loaded for the pair. */
  countFailed: boolean;
}): ForgeStatusArm {
  switch (true) {
    case input.baseLoading:
      return "baseLoading";
    case input.fetchError:
      return "fetchError";
    case input.unchosen !== null:
      return "unchosen";
    case input.sideEmpty:
      return "counting";
    case input.sameBranch:
      return "sameBranch";
    case input.counting:
      return "counting";
    case input.countFailed:
      return "countFailed";
    default:
      return "count";
  }
}
