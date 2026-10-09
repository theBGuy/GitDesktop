import { ArchiveIcon, TrashIcon } from "@phosphor-icons/react";
import { type ReactElement, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { LocalPr } from "@/lib/pulls/local";
import { useDeleteLocalPr, useUpdateLocalPr } from "@/lib/pulls/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/**
 * Right-click record-management for a local PR row: Archive/Unarchive and a
 * confirmed Delete. Record management lives on the PR record (its list row), not
 * the merge footer — the footer is just the merge decision. Wraps the row button
 * so selection + arrow-key nav still work; menu-item clicks `stopPropagation` so
 * they don't bubble through the React tree to re-select the host row (the
 * portaled-menu-click-bubbles gotcha).
 */
export function LocalPrContextMenu({
  repoPath,
  pr,
  children,
}: {
  repoPath: string;
  pr: LocalPr;
  /** The row's `<button>` — wrapped as the context-menu trigger so right-click
   *  opens the menu without disturbing the button's click-to-select behavior. */
  children: ReactElement;
}) {
  const update = useUpdateLocalPr(repoPath);
  const del = useDeleteLocalPr(repoPath);
  const selectPr = useUiStore((s) => s.selectPr);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Read the selection at action time, not render time — the row's own click
  // may have just changed it, and an awaited write can settle after a repo
  // switch. `pr` is the right-clicked record regardless.
  const isSelected = () => {
    const { selectedPr: sel, repoPath: liveRepo } = useUiStore.getState();
    return liveRepo === repoPath && sel?.kind === "local" && sel.id === pr.id;
  };

  async function toggleArchive() {
    const archived = !pr.archived;
    try {
      await update.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({ ...cur, archived }),
      });
    } catch (e) {
      // The PR stays selected: nothing was archived.
      toastError(e);
      return;
    }
    // Deselect the archived PR so the detail view doesn't linger on a row the
    // list just hid.
    if (archived && isSelected()) selectPr(null);
  }

  // Awaited rather than per-call mutate callbacks: confirming can unmount this row
  // (the deleted PR leaves the list) and an `<Activity>` tab hide tears the observer
  // down mid-write — react-query drops per-call callbacks once an observer has no
  // listeners, stranding the confirm dialog open.
  async function deletePr() {
    try {
      await del.mutateAsync(pr.id);
      setConfirmDelete(false);
      if (isSelected()) selectPr(null);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={children} />
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem
            onClick={(e) => {
              e.stopPropagation();
              void toggleArchive();
            }}
          >
            <ArchiveIcon />
            {pr.archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(true);
            }}
          >
            <TrashIcon />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete this local pull request?"
        body={
          <>
            Permanently deletes "{pr.title}"
            {pr.comments.length > 0
              ? ` and its ${pr.comments.length} comment${
                  pr.comments.length === 1 ? "" : "s"
                }`
              : ""}
            . The branches are not affected. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        pending={del.isPending}
        onConfirm={() => void deletePr()}
      />
    </>
  );
}
