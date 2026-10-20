/**
 * The one wording for each commit-level action that changes the working tree or
 * writes history. The History list, the commit detail view's ⋯ menu, Compare's
 * commit context menu, and a tag's Checkout all ask through these, so no route
 * can pose a different question than its twin. Prompts go through
 * `useConfirm.getState().ask(...)`.
 */

const short = (hash: string) => hash.slice(0, 7);

/** Checking out a commit and checking out a tag land in the same detached HEAD,
 *  so both name their entity and share the explanation. */
export function checkoutDetachedConfirm(kind: "commit" | "tag", name: string) {
  return {
    title: `Check out ${kind} ${name}?`,
    body: `Your files move to that ${kind} and HEAD detaches, so you won't be on a branch. Switching back to a branch returns everything to normal, and commits you make while detached need a new branch to keep them.`,
    confirmLabel: `Check out ${kind}`,
  };
}

export const checkoutCommitConfirm = (hash: string) =>
  checkoutDetachedConfirm("commit", short(hash));

/** A silent checkout reads as a dead end (Compare flips to its detached-HEAD
 *  empty state with no acknowledgment), so every checkout route — commit or
 *  tag — reports success through this one template. */
const checkedOutDetached = (name: string) =>
  `Checked out ${name} — HEAD is detached`;

export function checkoutCommitSuccessToast(hash: string) {
  return checkedOutDetached(short(hash));
}

export function checkoutTagSuccessToast(tag: string) {
  return checkedOutDetached(tag);
}

/** What each op does, for its plain confirm. `branch` names the destination; a
 *  null name (status not yet read, or a detached HEAD) falls back to "the
 *  current branch". */
const OP_EFFECT: Record<
  MergeParentOp,
  (hash: string, branch: string | null) => string
> = {
  revert: (hash) =>
    `Creates a new commit that undoes what ${short(hash)} changed, so history keeps both and nothing already recorded is rewritten.`,
  "cherry-pick": (hash, branch) =>
    `Copies ${short(hash)} onto ${branch ?? "the current branch"} as a new commit and leaves the original where it is.`,
};

/** Where each op stops on a conflict: shared by the plain confirm and the
 *  merge-parent dialog, which both owe the user this warning. */
const OP_CONFLICT: Record<MergeParentOp, string> = {
  revert: "If it conflicts, the revert pauses in Changes for you to resolve.",
  "cherry-pick":
    "If it conflicts, the pick pauses in Changes for you to resolve.",
};

export const revertCommitConfirm = (hash: string) => ({
  title: `Revert commit ${short(hash)}?`,
  body: `${OP_EFFECT.revert(hash, null)} ${OP_CONFLICT.revert}`,
  confirmLabel: "Revert commit",
});

export const cherryPickCommitConfirm = (
  hash: string,
  branch: string | null,
) => ({
  title: `Cherry-pick commit ${short(hash)}?`,
  body: `${OP_EFFECT["cherry-pick"](hash, branch)} ${OP_CONFLICT["cherry-pick"]}`,
  confirmLabel: "Cherry-pick commit",
});

/** A cherry-pick that found its changes already on the branch. The full line is
 *  every route's wording and the merge-parent dialog's default; History's search
 *  results word it shorter and hand the dialog that instead. */
export const CHERRY_PICK_ALREADY_APPLIED =
  "Nothing to cherry-pick — these changes are already on this branch.";
export const CHERRY_PICK_ALREADY_APPLIED_SHORT =
  "Nothing to cherry-pick — already on this branch.";

/** A merge commit's revert or cherry-pick asks which parent is the mainline
 *  (git's `-m`) instead of the plain confirm above: without that choice git
 *  refuses the commit outright. */
export type MergeParentOp = "revert" | "cherry-pick";

/** The mainline choice in words, for every surface that offers it: Parent 1 is
 *  the side the merge was made on. */
export const MERGE_PARENT_DESCRIPTION =
  "A merge has more than one parent — choose which one counts as the mainline. Parent 1 is the usual choice.";

export const MERGE_PARENT_COPY: Record<
  MergeParentOp,
  { title: string; confirmLabel: string; nothingDone: string }
> = {
  revert: {
    title: "Revert merge commit",
    confirmLabel: "Revert commit",
    nothingDone: "nothing was reverted",
  },
  "cherry-pick": {
    title: "Cherry-pick merge commit",
    confirmLabel: "Cherry-pick commit",
    nothingDone: "nothing was cherry-picked",
  },
};

/** The merge-parent dialog's title and description for `hash`: the commit named
 *  like its plain confirm names it, the mainline choice, then the op's conflict
 *  warning (the plain confirm's effect sentence stays there; the dialog keeps to
 *  the choice). */
export const mergeParentPrompt = (op: MergeParentOp, hash: string) => ({
  title: `${MERGE_PARENT_COPY[op].title} ${short(hash)}`,
  body: `${MERGE_PARENT_DESCRIPTION} ${OP_CONFLICT[op]}`,
});

/** Compact form of the backend's batch-merge refusal (`RANGE_MERGE_REFUSAL`,
 *  src-tauri/src/git/ops.rs) for a disabled menu item's label, which carries its
 *  reason inline (no tooltip) and would otherwise widen the menu. The full
 *  sentence reaches users through the Rust error itself — no TS copy exists. */
export const RANGE_MERGE_ITEM_REASON = "includes a merge — pick it on its own";

/** The disabled-reason suffix while the log and status reads disagree: what's
 *  unpushed, and which commit is HEAD, are unknown until they agree again. */
export const HISTORY_REFRESHING_HINT = " (refreshing history…)";

/** Menu-row reason while a merge/rebase/cherry-pick/revert is mid-flight —
 *  Edit history, Squash and Cherry-pick to branch all say it. */
export const OP_IN_PROGRESS_HINT = " (finish the operation in Changes first)";

/** A parentless commit has nothing to soft-reset to, so undo deletes the branch
 *  ref instead — the one undo that doesn't just re-stage in place. Scoped to the
 *  branch, never the repository: an orphan branch's first commit takes this path
 *  while the repository's history carries on elsewhere. */
export const UNDO_ROOT_COMMIT_CONFIRM = {
  title: "Undo this branch's first commit?",
  body: "This is the first commit on this branch, so undoing it deletes the branch's ref instead of moving it back. Your changes stay staged.",
  confirmLabel: "Undo first commit",
  confirmVariant: "destructive",
} as const;
