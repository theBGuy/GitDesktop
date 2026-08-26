import {
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";

/** Callbacks the menu items invoke — owned by the parent panel, which holds the
 *  confirms, mutations, and dialog state so this stays presentational. */
export interface CommitMenuActions {
  checkout: (hash: string) => void;
  /** Omit to hide "Revert changes in commit" — only offered when the commit is
   *  in the current branch's history. */
  revert?: (hash: string) => void;
  cherryPick: (hash: string) => void;
  createBranch: (hash: string) => void;
  createTag: (hash: string) => void;
}

/**
 * The position-independent commit actions — no amend/reset/squash/reorder, which
 * assume contiguous recent history. Shared by History's search results and the
 * Compare tab's ahead/behind lists so the two can't drift on item wording or
 * order.
 */
export function CommitContextMenuItems({
  hash,
  actions,
}: {
  hash: string;
  actions: CommitMenuActions;
}) {
  // Destructured so `revert` stays narrowed inside the item callbacks: a
  // property narrowing doesn't survive into a closure, a const binding's does.
  const { checkout, revert, cherryPick, createBranch, createTag } = actions;
  return (
    <>
      <ContextMenuItem onClick={() => checkout(hash)}>
        Checkout commit
      </ContextMenuItem>
      {revert && (
        <ContextMenuItem onClick={() => revert(hash)}>
          Revert changes in commit
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => cherryPick(hash)}>
        Cherry-pick commit
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => createBranch(hash)}>
        Create branch from commit…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => createTag(hash)}>
        Create tag…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyText(hash, "SHA copied")}>
        Copy SHA
      </ContextMenuItem>
    </>
  );
}
