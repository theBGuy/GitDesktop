import type { KeyboardEvent } from "react";

export interface ListKeyboardNavOptions<T> {
  /** The navigable rows, in render order. */
  items: T[];
  /** Index of the active row in `items`, or -1 when nothing is active. */
  activeIndex: number;
  /** Move selection to `item` (now at index `to`); `shift` extends a range. */
  onActivate: (item: T, to: number, shift: boolean) => void;
  /** DOM key of a row, used to move focus + scroll it into view. Omit to skip. */
  rowKey?: (item: T) => string;
  /** Attribute that carries `rowKey` on each row element. */
  rowAttr?: string;
  /**
   * Leave arrows to a text editor inside the list (caret nav wins). Opt-in:
   * several callers deliberately drive nav from a filter input.
   */
  ignoreTextEntry?: boolean;
  /** Handle ArrowLeft/ArrowRight for the ACTIVE item (tree consumers: collapse/
   *  expand, jump to parent). Only consulted when provided AND an item is active;
   *  absent = Left/Right pass through untouched (existing consumers unchanged). */
  onArrowLeft?: (item: T, index: number) => void;
  onArrowRight?: (item: T, index: number) => void;
}

/**
 * Builds the `onKeyDown` handler for ArrowUp/ArrowDown navigation of a vertical
 * list, plus ArrowLeft/ArrowRight for callers that opt in. Callers own their
 * selection logic via `onActivate` (single- or multi-select) and optionally a
 * `rowKey` so the active row is focused and scrolled into view. Not a hook — it
 * calls no hooks, so it's safe to build after early returns.
 */
export function listKeyboardNav<T>({
  items,
  activeIndex,
  onActivate,
  rowKey,
  rowAttr = "data-row",
  ignoreTextEntry = false,
  onArrowLeft,
  onArrowRight,
}: ListKeyboardNavOptions<T>) {
  return (e: KeyboardEvent) => {
    let horizontal: ((item: T, index: number) => void) | undefined;
    if (e.key === "ArrowLeft") horizontal = onArrowLeft;
    else if (e.key === "ArrowRight") horizontal = onArrowRight;
    const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
    if (!vertical && !horizontal) return;
    if (items.length === 0) return;
    // Ancestor walk for the form controls (a keydown can bubble from a wrapper
    // inside an editor); isContentEditable covers every editable state — true,
    // empty, plaintext-only — and inherits from an enclosing editing host.
    if (
      ignoreTextEntry &&
      e.target instanceof HTMLElement &&
      (e.target.closest("input, textarea") !== null ||
        e.target.isContentEditable)
    )
      return;
    if (horizontal) {
      // Nothing active = nothing to collapse or step out of; the key stays the
      // browser's (caret/scroll) rather than being swallowed.
      if (activeIndex === -1) return;
      e.preventDefault();
      horizontal(items[activeIndex], activeIndex);
      return;
    }
    // Move the selection, not the scrollbar.
    e.preventDefault();
    const to =
      e.key === "ArrowDown"
        ? Math.min(activeIndex + 1, items.length - 1)
        : activeIndex === -1
          ? items.length - 1
          : Math.max(activeIndex - 1, 0);
    const item = items[to];
    onActivate(item, to, e.shiftKey);
    if (rowKey) {
      // Keep focus on the active row so the focus ring tracks the selection.
      const el = e.currentTarget.querySelector<HTMLElement>(
        `[${rowAttr}="${CSS.escape(rowKey(item))}"]`,
      );
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    }
  };
}
