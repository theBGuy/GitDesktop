import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { OptionValue } from "@/features/conversations/ProjectFieldValues";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import { BoardCard } from "./BoardCard";
import type { BoardColumnModel } from "./board-model";

/** A card's resting height — one title line, one meta line, and the row's own
 *  bottom gap. `measureElement` corrects every mounted card from there, so this
 *  only has to keep the first paint's scrollbar honest. */
const CARD_ESTIMATE = 74;

/**
 * One board column: its header and a virtualized list of its cards.
 *
 * A leaf on purpose. `useVirtualizer` opts its component out of the React
 * Compiler's memoization, so it lives here rather than in the panel, and each
 * column's scroll position, measurements, and windowing stay independent of the
 * others (the HistoryPanel/CommitList split, and ChangesPanel's
 * `VirtualizedChangeList`).
 */
export const BoardColumn = memo(function BoardColumn({
  column,
  columnIndex,
  activeIndex,
  tabStopIndex,
  focusNonce,
  repoSlug,
  ghHost,
  onCardFocus,
  onOpen,
}: {
  column: BoardColumnModel;
  columnIndex: number;
  /** The keyboard cursor's row in THIS column, or null when it sits elsewhere. */
  activeIndex: number | null;
  /** The board's single tab stop, when it is in this column. */
  tabStopIndex: number | null;
  /** Bumped once per arrow press. The only thing that may move DOM focus. */
  focusNonce: number;
  repoSlug: string | null;
  ghHost: string | null;
  onCardFocus: (columnIndex: number, index: number) => void;
  onOpen: (item: BoardItem) => void;
}) {
  // State-backed, never a ref: with a plain RefObject the virtualizer captures
  // `null` in its mount effect and never re-reads, so `getVirtualItems()` stays
  // empty and the column paints blank under a full-height scrollbar.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const items = column.items;
  // Re-minted per item SEQUENCE, which the `[items]` dep is: the virtualizer
  // keys its measurement projection on this callback's IDENTITY, so a stale one
  // paints a card into the previous occupant's measured slot after a regroup.
  const getItemKey = useCallback(
    (index: number) => items[index]?.itemId ?? index,
    [items],
  );
  // The board's single tab stop has to stay MOUNTED or Tab can't get into the
  // board at all: scroll it past the overscan window by hand and the only
  // tabbable card unmounts with it. Neither virtualized sibling hits this —
  // ChangesPanel makes every row its own tab stop, MyWorkScreen keeps focus on
  // a combobox input and never puts it on a row — so a roving tab stop over a
  // virtualized list needs the window itself to carry the guarantee.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const window = defaultRangeExtractor(range);
      if (tabStopIndex === null || window.includes(tabStopIndex)) return window;
      // Ascending, like the default's own output: the rows are absolutely
      // positioned, but keeping DOM order in step with index order keeps the
      // measurement projection and a reader's traversal honest.
      return [...window, tabStopIndex].sort((a, b) => a - b);
    },
    [tabStopIndex],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => CARD_ESTIMATE,
    getItemKey,
    rangeExtractor,
    overscan: 8,
  });

  // Focus follows the KEYBOARD only. The ref starts at the nonce this column
  // mounted with, so neither an <Activity> show replaying this effect nor a
  // regroup remounting the column can claim focus the user never asked for.
  // Scroll first: under virtualization the target card may not be mounted yet,
  // so the focus claim gets a few frames before it gives up.
  // Fully declared rather than suppressed: `scrollEl` is state and belongs in
  // the deps anyway, and `useVirtualizer` returns one instance held in its own
  // `useState` initialiser, so the virtualizer is referentially stable and
  // listing it can't re-run this. The nonce guard makes any extra run a no-op.
  const appliedNonce = useRef(focusNonce);
  useEffect(() => {
    // Recorded on EVERY run, the early returns included. A column that sat
    // inactive through an arrow press would otherwise keep the pre-press nonce
    // and spend it later: clicking a card here — a DRAFT card, say, whose click
    // hands focus to its popup — makes this column active, finds the stale
    // mismatch, and yanks focus back out of the popup a frame later.
    const unseen = appliedNonce.current !== focusNonce;
    appliedNonce.current = focusNonce;
    if (activeIndex === null || !unseen) return;
    virtualizer.scrollToIndex(activeIndex, { align: "auto" });
    let frame = 0;
    let tries = 3;
    const claim = () => {
      tries -= 1;
      const card = scrollEl?.querySelector<HTMLElement>(
        `[data-card-index="${activeIndex}"]`,
      );
      if (card) {
        card.focus();
        // Both axes: the card's own column scrolls vertically, and the board
        // region it sits in scrolls horizontally.
        card.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
      if (tries === 0) return;
      frame = requestAnimationFrame(claim);
    };
    frame = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, focusNonce, scrollEl, virtualizer]);

  const countLabel = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  return (
    <section
      data-column-index={columnIndex}
      className="flex w-76 shrink-0 flex-col border bg-muted/20"
    >
      <h3 className="flex items-center gap-1.5 border-b px-2 py-1.5 text-xs font-medium">
        {column.color === null ? (
          <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
            {column.label}
          </span>
        ) : (
          <OptionValue name={column.label} color={column.color} />
        )}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {items.length}
        </span>
      </h3>
      {/* Fixed height (`min-h-0 flex-1`), never `max-h`: an unbounded scroll
          container makes `getTotalSize()` 0 and the cards vanish. A native
          scroll div, not ScrollArea, whose viewport doesn't hand its element to
          `getScrollElement()`. */}
      {/* One listbox PER COLUMN, named by its header: a single board-wide grid
          would have to own all the rows, which the per-column virtualizers can't
          give it. An empty column drops the role rather than putting a bare
          paragraph inside a listbox — the heading above still names it. */}
      <div
        ref={setScrollEl}
        role={items.length === 0 ? undefined : "listbox"}
        aria-label={
          items.length === 0 ? undefined : `${column.label}, ${countLabel}`
        }
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {items.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            No items
          </p>
        ) : (
          <div
            // Presentation like the row wrapper below it: the spacer is the
            // other div standing between the listbox and its options, and
            // marking only one of the two leaves the chain broken.
            role="presentation"
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={items[vi.index].itemId}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                // Presentation wrapper so the virtualizer's positioning div
                // doesn't sit between the listbox and its options.
                role="presentation"
                // The gap rides the measured ROW, never the spacer: padding on
                // the spacer wouldn't move its absolutely-positioned children,
                // and the first row carries the top gap itself.
                className={cn(
                  "absolute top-0 left-0 w-full px-1.5 pb-1.5",
                  vi.index === 0 && "pt-1.5",
                )}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <BoardCard
                  item={items[vi.index]}
                  index={vi.index}
                  setSize={items.length}
                  columnIndex={columnIndex}
                  active={vi.index === activeIndex}
                  rovingTab={vi.index === tabStopIndex ? 0 : -1}
                  repoSlug={repoSlug}
                  ghHost={ghHost}
                  onFocus={onCardFocus}
                  onOpen={onOpen}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
});
