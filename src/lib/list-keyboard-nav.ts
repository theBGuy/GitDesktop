import { type KeyboardEvent, useState } from "react";

export interface ListKeyboardNavOptions<T> {
  /** The navigable rows, in render order. */
  items: T[];
  /** Index of the active row in `items`, or -1 when nothing is active. */
  activeIndex: number;
  /** Move selection to `item` (now at index `to`); `shift` extends a range — a
   *  `tabAdvances` move always reports false, the Shift there being direction. */
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
  /**
   * Also move on Tab / Shift+Tab, wrapping at both ends where the arrows clamp.
   * Opt-in and popup-only: it spends the surface's native Tab exit, so only a
   * popup with no other FOCUSABLE element can afford it, and only while its Esc
   * exit is on screen as the popup's `Popover.Description`. Modified Tab
   * (Ctrl/Alt/Meta) stays native.
   */
  tabAdvances?: boolean;
}

/**
 * Builds the `onKeyDown` handler for ArrowUp/ArrowDown navigation of a vertical
 * list — plus Tab/Shift+Tab under `tabAdvances`. Callers own their selection
 * logic via `onActivate` (single- or multi-select) and optionally a `rowKey` so
 * the active row is focused and scrolled into view. Not a hook — it calls no
 * hooks, so it's safe to build after early returns.
 */
export function listKeyboardNav<T>({
  items,
  activeIndex,
  onActivate,
  rowKey,
  rowAttr = "data-row",
  ignoreTextEntry = false,
  tabAdvances = false,
}: ListKeyboardNavOptions<T>) {
  return (e: KeyboardEvent) => {
    const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
    // A modified Tab is a window/app chord, never row nav.
    const tab =
      tabAdvances && e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (!arrow && !tab) return;
    // Before any preventDefault, so an empty list leaves Tab native.
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
    // Move the selection, not the scrollbar (and, on Tab, not the focus ring out
    // of the list).
    e.preventDefault();
    const to = (() => {
      switch (true) {
        // Tab cycles: inside a popup, wrapping is what makes one-handed
        // multi-select work, where the arrows deliberately stop at the ends.
        case tab && e.shiftKey:
          return activeIndex === -1
            ? items.length - 1
            : (activeIndex - 1 + items.length) % items.length;
        case tab:
          return activeIndex === -1 ? 0 : (activeIndex + 1) % items.length;
        case e.key === "ArrowDown":
          return Math.min(activeIndex + 1, items.length - 1);
        default:
          return activeIndex === -1
            ? items.length - 1
            : Math.max(activeIndex - 1, 0);
      }
    })();
    const item = items[to];
    // Shift on a Tab is the direction, already consumed — never a range extend.
    onActivate(item, to, e.shiftKey && !tab);
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

/**
 * Roving-tabindex wiring for a list of checkbox/option rows: one tab stop for
 * the whole list, parked on the active row. A hook, unlike `listKeyboardNav` —
 * call it before any early return. The element carrying `onRowKeyDown` is
 * unstyled but NOT removable: `listKeyboardNav` finds the row to focus by
 * querying within it.
 */
export function useRovingRows<T>({
  items,
  rowKey,
  tabAdvances,
}: {
  /** The navigable rows, in render order — locked rows belong out of this list. */
  items: T[];
  rowKey: (item: T) => string;
  tabAdvances?: boolean;
}): {
  onRowKeyDown: (e: KeyboardEvent<Element>) => void;
  rowProps: (item: T) => {
    "data-row": string;
    tabIndex: 0 | -1;
    onFocus: () => void;
  };
  isActive: (item: T) => boolean;
} {
  const [activeId, setActiveId] = useState<string | null>(null);
  const navIndexById = new Map(items.map((item, i) => [rowKey(item), i]));
  const activeIndex =
    activeId === null ? -1 : (navIndexById.get(activeId) ?? -1);
  // Nothing active yet (or the active row vanished on a refetch) parks the single
  // tab stop on the first row.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;
  const onRowKeyDown = listKeyboardNav({
    items,
    activeIndex,
    onActivate: (item) => setActiveId(rowKey(item)),
    rowKey,
    tabAdvances,
  });

  return {
    onRowKeyDown,
    rowProps: (item) => {
      const id = rowKey(item);
      return {
        "data-row": id,
        tabIndex: navIndexById.get(id) === focusIndex ? 0 : -1,
        onFocus: () => setActiveId(id),
      };
    },
    isActive: (item) => activeId === rowKey(item),
  };
}
