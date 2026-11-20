import type { SelectedIssue, SelectedPr } from "@/lib/stores/ui";

/** The key of the item the detail pane shows, or null when it shows none.
 *  Callers pass the SAME deferred selection the pane renders from, so a clear
 *  reads null in the commit that unmounts the detail, not the urgent one
 *  before it. Kind and id both count: another item is no clear. */
export function detailKeyOf(
  selection: SelectedIssue | SelectedPr | null,
): string | null {
  return selection === null ? null : `${selection.kind}:${selection.id}`;
}
