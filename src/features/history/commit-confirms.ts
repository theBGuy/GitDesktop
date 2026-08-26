/**
 * The one wording for each commit-level action that changes the working tree or
 * writes history. The History list, the commit detail view's ⋯ menu, and a tag's
 * Checkout all ask through these, so no route can pose a different question than
 * its twin. Prompts go through `useConfirm.getState().ask(...)`.
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

/** A silent checkout reads as a dead end from Compare, which flips to its
 *  detached-HEAD empty state, so every commit-checkout route reports success
 *  with this same sentence. */
export function checkoutCommitSuccessToast(hash: string) {
  return `Checked out ${short(hash)} — HEAD is detached`;
}

export const revertCommitConfirm = (hash: string) => ({
  title: `Revert commit ${short(hash)}?`,
  body: `Creates a new commit that undoes what ${short(hash)} changed, so history keeps both and nothing already recorded is rewritten. If it conflicts, the revert pauses in Changes for you to resolve.`,
  confirmLabel: "Revert commit",
});

/** `branch` names the destination when the caller already holds repo status;
 *  without it the copy says "the current branch" rather than subscribing a view
 *  to status for a string only this prompt reads. */
export const cherryPickCommitConfirm = (
  hash: string,
  branch: string | null,
) => ({
  title: `Cherry-pick commit ${short(hash)}?`,
  body: `Copies ${short(hash)} onto ${branch ?? "the current branch"} as a new commit and leaves the original where it is. If it conflicts, the pick pauses in Changes for you to resolve.`,
  confirmLabel: "Cherry-pick commit",
});

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
