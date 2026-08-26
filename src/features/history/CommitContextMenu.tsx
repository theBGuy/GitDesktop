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
 * Compare tab's ahead/behind lists so the two can't drift on wording or order.
 */
export function CommitContextMenuItems({
  hash,
  actions,
}: {
  hash: string;
  actions: CommitMenuActions;
}) {
  return (
    <>
      <ContextMenuItem onClick={() => actions.checkout(hash)}>
        Checkout commit
      </ContextMenuItem>
      {actions.revert && (
        <ContextMenuItem onClick={() => actions.revert?.(hash)}>
          Revert changes in commit
        </ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => actions.cherryPick(hash)}>
        Cherry-pick commit
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => actions.createBranch(hash)}>
        Create branch from commit…
      </ContextMenuItem>
      <ContextMenuItem onClick={() => actions.createTag(hash)}>
        Create tag…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => copyText(hash, "SHA copied")}>
        Copy SHA
      </ContextMenuItem>
    </>
  );
}
