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
}

/**
 * Builds the `onKeyDown` handler for ArrowUp/ArrowDown navigation of a vertical
 * list. Callers own their selection logic via `onActivate` (single- or
 * multi-select) and optionally a `rowKey` so the active row is focused and
 * scrolled into view. Not a hook — it calls no hooks, so it's safe to build
 * after early returns.
 */
export function listKeyboardNav<T>({
  items,
  activeIndex,
  onActivate,
  rowKey,
  rowAttr = "data-row",
  ignoreTextEntry = false,
}: ListKeyboardNavOptions<T>) {
  return (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (items.length === 0) return;
    // Ancestor walk, not the target alone: a keydown can bubble from a wrapper
    // inside an editor.
    if (
      ignoreTextEntry &&
      e.target instanceof Element &&
      e.target.closest("input, textarea, [contenteditable=true]")
    )
      return;
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
