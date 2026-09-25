import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem, ProjectIterationDef } from "@/lib/git/types";
import { cn } from "@/lib/utils";
import type { TableEntry, TablePosition } from "./board-model";
import { itemTitle } from "./item-title";
import {
  addDays,
  type DateSources,
  dayCenterPx,
  dayOffset,
  type ItemSpan,
  itemSpan,
  laneBox,
  layoutStripLabels,
  localDateISO,
  type RoadmapTimeline,
  roadmapTimeline,
  shortDate,
  spanText,
  type Zoom,
} from "./roadmap-model";
import { CELL_CLASS, TABLE_ROW_HEIGHT, TitleCell } from "./TableCell";
import { TableGroupRow } from "./TableRow";

/** The pinned rail's width: the title column, which stays put while the lane
 *  scrolls sideways under it. */
const RAIL_WIDTH = 280;
/** The axis's two tiers plus the marker strip under them, whose two rows keep
 *  the iteration bands' labels apart from today's and the milestones'. */
const TIER_HEIGHT = 18;
const STRIP_ROW_HEIGHT = 17;
const HEADER_HEIGHT = TIER_HEIGHT * 2 + STRIP_ROW_HEIGHT * 2;
/** The narrowest header stretch whose label rides the scroll (see SegmentBox). */
const STICKY_LABEL_MIN_PX = 64;
/** A rough width per title character at the lane's type size — only decides
 *  whether the title sits inside its bar or beside it. */
const TITLE_CHAR_PX = 6.5;

/** A strip label's rough whole width, for the collision layout alone. */
function labelWidth(text: string): number {
  return text.length * TITLE_CHAR_PX + 12;
}

/** What a press inside the grid may move focus to — the table's own set. */
const IN_GRID_FOCUSABLE =
  "[tabindex], button, a[href], input, select, textarea";

/** Where a span draws on the lane, in pixels, clamped into it at both ends. */
function spanBox(from: string, to: string, timeline: RoadmapTimeline) {
  return laneBox(from, to, timeline.range, timeline.days, timeline.pxPerDay);
}

/** The x of a day's middle, clamped into the lane. */
function dayCenter(date: string, timeline: RoadmapTimeline): number {
  return dayCenterPx(date, timeline.range, timeline.days, timeline.pxPerDay);
}

/** The caret a clipped span shows at the edge it runs past — a shape, never the
 *  clip alone. A reader hears it in the lane's name ({@link cutWords}). */
function CutMark({ side }: { side: "start" | "end" }) {
  const Icon = side === "start" ? CaretLeftIcon : CaretRightIcon;
  return <Icon aria-hidden className="size-3 shrink-0" />;
}

/** The lane name's words for a span the capped range cuts off. */
function cutWords(span: ItemSpan, range: { min: string; max: string }) {
  const dates =
    span.kind === "point"
      ? [span.date]
      : span.kind === "none"
        ? []
        : [span.start, span.end];
  const before = dates.some((date) => date < range.min);
  const after = dates.some((date) => date > range.max);
  if (before && after) return ", reaching past both ends of the timeline";
  if (before) return ", reaching before the timeline";
  return after ? ", reaching past the timeline" : "";
}

/** A label beside a mark: after it, unless that would run off the lane's end. */
function besideStyle(left: number, right: number, laneWidth: number) {
  return right + 200 > laneWidth
    ? { right: laneWidth - left + 6 }
    : { left: right + 6 };
}

/** The lane's drawing for one span. The `data-roadmap-mark` node is what a
 *  keyboard landing scrolls into view. */
function LaneMark({
  span,
  title,
  timeline,
  laneWidth,
}: {
  span: ItemSpan;
  title: string;
  timeline: RoadmapTimeline;
  laneWidth: number;
}) {
  switch (span.kind) {
    case "bar": {
      const box = spanBox(span.start, span.end, timeline);
      const inside = box.width >= title.length * TITLE_CHAR_PX + 16;
      return (
        <>
          <div
            data-roadmap-mark=""
            aria-hidden
            // Opaque fill: the today and milestone lines run BEHIND the rows, and a
            // see-through bar would draw them through its title. The border is
            // what outlines the bar, so it takes the text-grade muted token.
            className="absolute top-1.5 bottom-1.5 flex items-center gap-0.5 rounded-sm border border-muted-foreground bg-muted px-1 text-[11px] text-foreground"
            style={{ left: box.left, width: box.width }}
          >
            {box.cutStart && <CutMark side="start" />}
            {inside && (
              <span
                className="min-w-0 flex-1 truncate"
                onMouseEnter={clipTitleFromText}
              >
                {title}
              </span>
            )}
            {box.cutEnd && <CutMark side="end" />}
          </div>
          {!inside && (
            <span
              aria-hidden
              className="absolute max-w-48 truncate rounded-sm bg-background px-1 text-[11px]"
              style={besideStyle(box.left, box.left + box.width, laneWidth)}
              onMouseEnter={clipTitleFromText}
            >
              {title}
            </span>
          )}
        </>
      );
    }
    case "point":
    case "inverted": {
      // A reversed pair draws at its EARLIER date, which is its target.
      const date = span.kind === "point" ? span.date : span.end;
      const x = dayCenter(date, timeline);
      const cut =
        date < timeline.range.min
          ? "start"
          : date > timeline.range.max
            ? "end"
            : null;
      return (
        <>
          <div
            data-roadmap-mark=""
            aria-hidden
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-foreground/70 bg-background"
            style={{ left: x }}
          />
          <span
            aria-hidden
            className="absolute flex max-w-60 items-center gap-1 rounded-sm bg-background px-1 text-[11px]"
            style={besideStyle(x - 6, x + 6, laneWidth)}
          >
            {cut !== null && <CutMark side={cut} />}
            <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
              {title}
            </span>
            {span.kind === "inverted" && (
              <span className="shrink-0 text-muted-foreground">
                · Dates reversed
              </span>
            )}
          </span>
        </>
      );
    }
    default:
      return (
        <span
          aria-hidden
          title="Set this item's date fields to place it on the roadmap"
          className="sticky rounded-sm bg-background px-1 text-[11px] text-muted-foreground italic"
          style={{ left: RAIL_WIDTH + 8 }}
        >
          No dates
        </span>
      );
  }
}

/** The scroll offset that puts `date` mid-lane in `el`. Applied instantly,
 *  never smoothly: nothing here animates, so reduced motion needs no arm. */
function centeredScroll(
  el: HTMLElement,
  date: string,
  min: string,
  pxPerDay: number,
): number {
  const visible = el.clientWidth - RAIL_WIDTH;
  return Math.max((dayOffset(date, min) + 0.5) * pxPerDay - visible / 2, 0);
}

/** Scroll `el` to `left` and record where it really landed (after any clamp)
 *  in `ref`, the offset the lane anchors on. */
function writeScroll(ref: { current: number }, el: HTMLElement, left: number) {
  el.scrollLeft = left;
  ref.current = el.scrollLeft;
}

/** Where a virtualized row sits: absolutely positioned at its offset. */
function rowStyle(start: number, width: number) {
  return {
    height: TABLE_ROW_HEIGHT,
    width,
    transform: `translateY(${start}px)`,
  };
}

/**
 * One item's row: the pinned rail (the table's own Title cell — marks, glyph,
 * title, peek) and the lane its span draws in. Memoized for the reason a table
 * row is; every prop is a primitive or an identity the panel holds stable. The
 * row itself stays TRANSPARENT so the iteration bands and markers drawn behind
 * the rows show through the lane — the rail takes its own opaque background to
 * cover what scrolls under it.
 */
const RoadmapItemRow = memo(function RoadmapItemRow({
  rowKey,
  item,
  rowIndex,
  start,
  width,
  laneWidth,
  selected,
  checked,
  busy,
  peek,
  tabCol,
  sources,
  calendars,
  timeline,
  onCellFocus,
  onPeekChange,
}: {
  rowKey: string;
  item: BoardItem;
  rowIndex: number;
  start: number;
  width: number;
  laneWidth: number;
  selected: boolean;
  checked: boolean;
  busy: boolean;
  peek: boolean;
  tabCol: number | null;
  sources: DateSources;
  calendars: ReadonlyMap<string, ProjectIterationDef[]>;
  timeline: RoadmapTimeline;
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
  onPeekChange: (itemId: string | null) => void;
}) {
  const span = itemSpan(item, sources, calendars);
  const words = `${spanText(span, timeline.todayISO)}${cutWords(span, timeline.range)}`;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-selected={selected}
      aria-busy={busy || undefined}
      aria-disabled={item.content.kind === "redacted" || undefined}
      data-row-key={rowKey}
      data-item-id={item.itemId}
      className={cn(
        "absolute top-0 left-0 flex border-b border-border/60 text-xs",
        "[&>:first-child]:bg-background",
        item.isArchived && "text-muted-foreground",
        selected && "text-accent-foreground [&>:first-child]:bg-accent",
        busy && "opacity-60",
      )}
      style={rowStyle(start, width)}
    >
      <TitleCell
        rowKey={rowKey}
        colIndex={0}
        width={RAIL_WIDTH}
        tabbable={tabCol === 0}
        onCellFocus={onCellFocus}
        item={item}
        checked={checked}
        peek={peek}
        onPeekChange={onPeekChange}
      />
      <div
        role="gridcell"
        aria-colindex={2}
        aria-label={
          span.kind === "none"
            ? `${words}. Set this item's date fields to place it on the roadmap.`
            : words
        }
        data-table-cell=""
        data-col-index={1}
        tabIndex={tabCol === 1 ? 0 : -1}
        onFocus={() => onCellFocus(rowKey, 1)}
        className={cn(CELL_CLASS, "relative px-0", selected && "bg-accent/40")}
        style={{ width: laneWidth }}
      >
        <LaneMark
          span={span}
          title={itemTitle(item)}
          timeline={timeline}
          laneWidth={laneWidth}
        />
      </div>
    </div>
  );
});

/** The two axis tiers, the marker strip and the today button — the grid's
 *  header row. The drawing is presentation; its words ride the sr-only summary. */
function AxisHeader({
  timeline,
  width,
  laneWidth,
  laneScroll,
  onToday,
}: {
  timeline: RoadmapTimeline;
  width: number;
  laneWidth: number;
  /** How far the lane is scrolled: its first day in view sits this far in. */
  laneScroll: number;
  onToday: () => void;
}) {
  const { axis, pxPerDay, bands, markers, range, todayISO } = timeline;
  const year = Number(todayISO.slice(0, 4));
  const current = bands.find((band) => band.current);
  const todayIn = todayISO >= range.min && todayISO <= range.max;
  const summary = [
    `Timeline from ${shortDate(range.min, year)} to ${shortDate(range.max, year)}.`,
    `Today is ${shortDate(todayISO)}.`,
    current === undefined ? "" : `Current iteration: ${current.title}.`,
    markers.length === 0
      ? ""
      : `Milestones: ${markers
          .map((m) => `${m.titles.join(", ")} due ${shortDate(m.date, year)}`)
          .join("; ")}.`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  // The point row's labels — today and each milestone — laid out so none covers
  // another; the iteration bands have a row of their own above them.
  const points = [
    ...(todayIn
      ? [
          {
            key: "today",
            x: dayCenter(todayISO, timeline) - 1,
            width: labelWidth("Today"),
            pinned: true,
          },
        ]
      : []),
    ...markers.map((marker) => ({
      key: marker.date,
      x: dayCenter(marker.date, timeline) - 1,
      width: labelWidth(marker.label),
    })),
  ];
  const placed = new Map(
    layoutStripLabels(points, laneWidth).map((p) => [p.key, p]),
  );
  return (
    <div role="rowgroup" className="sticky top-0 z-20" style={{ width }}>
      <div
        role="row"
        aria-rowindex={1}
        className="flex border-b bg-background text-[11px] text-muted-foreground"
        style={{ height: HEADER_HEIGHT, width }}
      >
        <div
          role="columnheader"
          aria-colindex={1}
          // Named apart from its contents: the Today button inside would
          // otherwise join the header's name.
          aria-label="Title"
          className="sticky left-0 z-10 flex shrink-0 items-end justify-between gap-2 border-r bg-background px-2 pb-1 text-xs font-medium"
          style={{ width: RAIL_WIDTH }}
        >
          <span>Title</span>
          <Button
            variant="outline"
            size="xs"
            // A mouse focus would scroll this sticky button "into view" first,
            // nudging the lane before the jump; the jump is the only scroll.
            onMouseDown={(e) => {
              e.preventDefault();
              e.currentTarget.focus({ preventScroll: true });
            }}
            onClick={onToday}
          >
            Today
          </Button>
        </div>
        <div
          role="columnheader"
          aria-colindex={2}
          // `clip`, never `hidden`: a hidden overflow is a scroll container,
          // which would pin the sticky labels below to this box instead of the
          // grid's own scroll.
          className="relative shrink-0 overflow-clip"
          style={{ width: laneWidth }}
        >
          <span className="sr-only">{summary}</span>
          {[axis.top, axis.bottom].map((tier, t) => (
            <div
              key={t === 0 ? "top" : "bottom"}
              aria-hidden
              className="absolute left-0"
              style={{
                top: t * TIER_HEIGHT,
                height: TIER_HEIGHT,
                width: laneWidth,
              }}
            >
              {tier.map((seg) => (
                <SegmentBox
                  key={seg.key}
                  left={seg.offset * pxPerDay}
                  width={seg.days * pxPerDay}
                  laneScroll={laneScroll}
                  title={seg.label}
                  className={cn(
                    "leading-[18px]",
                    t === 0 && "font-medium text-foreground",
                    seg.emphasis && "border-l-foreground/40",
                  )}
                >
                  {seg.label}
                </SegmentBox>
              ))}
            </div>
          ))}
          <div
            aria-hidden
            className="absolute left-0"
            style={{
              top: TIER_HEIGHT * 2,
              height: STRIP_ROW_HEIGHT,
              width: laneWidth,
            }}
          >
            {bands.map((band) => (
              <SegmentBox
                key={band.id}
                left={band.offset * pxPerDay}
                width={band.days * pxPerDay}
                laneScroll={laneScroll}
                title={band.current ? `Current · ${band.title}` : band.title}
                className={cn(
                  "border-l-foreground/30 leading-4",
                  band.current && "bg-primary/15 font-medium text-foreground",
                )}
              >
                {band.current ? `Current · ${band.title}` : band.title}
              </SegmentBox>
            ))}
          </div>
          <div
            aria-hidden
            className="absolute left-0"
            style={{
              top: TIER_HEIGHT * 2 + STRIP_ROW_HEIGHT,
              height: STRIP_ROW_HEIGHT,
              width: laneWidth,
            }}
          >
            {markers.map((marker) => {
              const at = placed.get(marker.date);
              return (
                <span
                  key={marker.date}
                  title={marker.titles.join(", ")}
                  className="absolute top-0 truncate border-l-2 border-l-info bg-background px-1 leading-4 text-foreground"
                  style={{ left: at?.left ?? 0, maxWidth: at?.maxWidth }}
                >
                  {marker.label}
                </span>
              );
            })}
            {todayIn && (
              <span
                className="absolute top-0 bg-primary px-1 leading-4 font-medium whitespace-nowrap text-primary-foreground"
                style={{ left: placed.get("today")?.left ?? 0 }}
              >
                Today
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A labelled stretch of the header — an axis segment or an iteration band.
 *  A wide one keeps its label stuck just right of the rail while enough of it is
 *  in view, so the label on screen is always the stretch under it; a narrow one
 *  isn't worth the sticky layer and just truncates. The title carries the whole
 *  label either way. */
function SegmentBox({
  left,
  width,
  laneScroll,
  title,
  className,
  children,
}: {
  left: number;
  width: number;
  laneScroll: number;
  title: string;
  className?: string;
  children: string;
}) {
  const sticky = width >= STICKY_LABEL_MIN_PX;
  // A stuck label whose stretch has mostly scrolled under the rail would be
  // pushed back under it by the stretch's end, leaving a fragment in view: it
  // hides once the part still showing is narrower than the label.
  const hidden =
    sticky &&
    left < laneScroll &&
    left + width - laneScroll < labelWidth(children);
  return (
    <span
      title={title}
      className={cn("absolute top-0 h-full border-l", className)}
      style={{ left, width }}
    >
      <span
        className={cn(
          "block max-w-full truncate px-1",
          sticky && "sticky w-fit",
          hidden && "invisible",
        )}
        style={sticky ? { left: RAIL_WIDTH } : undefined}
      >
        {children}
      </span>
    </span>
  );
}

/** What is drawn BEHIND the rows: iteration boundaries, the current iteration's
 *  shading, milestone lines, and the today line. Presentation only — every one
 *  is named in words in the header strip above it. */
function Underlay({
  timeline,
  laneWidth,
  height,
}: {
  timeline: RoadmapTimeline;
  laneWidth: number;
  height: number;
}) {
  const { bands, markers, pxPerDay, range, todayISO } = timeline;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute top-0"
      style={{ left: RAIL_WIDTH, width: laneWidth, height }}
    >
      {bands.map((band) => (
        <div
          key={band.id}
          className={cn(
            "absolute top-0 bottom-0 border-l border-l-foreground/15",
            // A mint tint to find it by, and edges at the non-text 3:1 line.
            band.current && "border-x border-muted-foreground bg-primary/15",
          )}
          style={{ left: band.offset * pxPerDay, width: band.days * pxPerDay }}
        />
      ))}
      {markers.map((marker) => (
        <div
          key={marker.date}
          className="absolute top-0 bottom-0 w-0.5 bg-info"
          style={{ left: dayCenter(marker.date, timeline) - 1 }}
        />
      ))}
      {todayISO >= range.min && todayISO <= range.max && (
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-primary"
          style={{ left: dayCenter(todayISO, timeline) - 1 }}
        />
      )}
    </div>
  );
}

/**
 * A saved ROADMAP view as a timeline grid: a sticky axis header, a pinned title
 * rail, and one virtualized list of rows in which group headers and items share
 * a single sequence — the table's grid, with the fields' columns replaced by one
 * lane each item's span draws in.
 *
 * A leaf, like the table: `useVirtualizer` opts its component out of the React
 * Compiler, so the panel hands this its rows already derived, and the timeline
 * is memoized here off the shared clock ticker. The panel owns
 * the keyboard and the pointer grammar; this owns the window, the scroll, the
 * focus claims, and the grid's own clicks.
 */
export function ProjectsRoadmapView({
  label,
  rows,
  cursor,
  focusNonce,
  todayNonce,
  selectedIds,
  selectionSize,
  busyItemId,
  peekItemId,
  items,
  sources,
  calendars,
  zoom,
  onCellFocus,
  onToggleGroup,
  onActivate,
  onPeekChange,
  onFocusLost,
  onKeyDown,
}: {
  /** The grid's accessible name — the view's own. */
  label: string;
  /** The rows drawn right now, collapsed groups' items already left out. */
  rows: TableEntry[];
  cursor: TablePosition | null;
  /** Bumped by every route that means to move DOM focus; nothing else may. */
  focusNonce: number;
  /** Bumped by the palette's jump to today. */
  todayNonce: number;
  selectedIds: ReadonlySet<string>;
  selectionSize: number;
  busyItemId: string | null;
  peekItemId: string | null;
  /** Every item the view draws, folded sections included — the range spans them
   *  all, so folding a section doesn't re-scale the lane. */
  items: readonly BoardItem[];
  sources: DateSources;
  calendars: ReadonlyMap<string, ProjectIterationDef[]>;
  zoom: Zoom;
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
  onToggleGroup: (bucketId: string) => void;
  /** A click on a row's title: open the item, or peek at a draft's notes. */
  onActivate: (item: BoardItem) => void;
  onPeekChange: (itemId: string | null) => void;
  /** The grid owned focus and has no row left to hand it to. */
  onFocusLost: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, pageSize: number) => void;
}) {
  // State-backed, never a ref: the virtualizer captures its scroll element in a
  // mount effect and never re-reads a RefObject.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Today off the shared ticker, never the clock in render. Derived here, in the
  // leaf, so the tick re-renders the timeline rather than the whole panel; the
  // memo keeps the rows' `timeline` identity across cursor moves.
  const todayISO = localDateISO(useRelativeNow());
  const timeline = useMemo(
    () => roadmapTimeline(items, sources, calendars, todayISO, zoom),
    [items, sources, calendars, todayISO, zoom],
  );
  const laneWidth = timeline.days * timeline.pxPerDay;
  const width = RAIL_WIDTH + laneWidth;
  const tabStop: TablePosition | null =
    cursor ?? (rows.length > 0 ? { rowIndex: 0, colIndex: 0 } : null);
  const tabStopRow = tabStop?.rowIndex ?? null;
  const getItemKey = useCallback(
    (index: number) => rows[index]?.key ?? index,
    [rows],
  );
  // The grid's single tab stop stays MOUNTED, the table's rule: scrolled past
  // the overscan window it would unmount, and Tab couldn't reach the grid.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const drawn = defaultRangeExtractor(range);
      if (tabStopRow === null || drawn.includes(tabStopRow)) return drawn;
      return [...drawn, tabStopRow].sort((a, b) => a - b);
    },
    [tabStopRow],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => TABLE_ROW_HEIGHT,
    getItemKey,
    rangeExtractor,
    overscan: 8,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });

  // The lane's origin and scale as last laid out, so a change to either keeps
  // the user on the dates they were looking at.
  const { min } = timeline.range;
  const { pxPerDay } = timeline;
  const layoutRef = useRef<{ min: string; pxPerDay: number } | null>(null);
  // The scroll offset as of the last scroll event or write of our own. A lane
  // that SHRINKS has its offset clamped by the browser before any effect runs,
  // so the anchor below can't trust a live read that sits at the new maximum.
  const scrollLeftRef = useRef(0);
  // The same offset as state, for the header's sticky labels (`SegmentBox`).
  const [laneScroll, setLaneScroll] = useState(0);
  useLayoutEffect(() => {
    if (scrollEl === null) return;
    const prev = layoutRef.current;
    layoutRef.current = { min, pxPerDay };
    // First layout: open on today.
    if (prev === null) {
      writeScroll(
        scrollLeftRef,
        scrollEl,
        centeredScroll(scrollEl, timeline.todayISO, min, pxPerDay),
      );
      return;
    }
    // Where the lane WAS: the live offset, unless the browser clamped it into
    // the shrunk lane, in which case the offset from before the shrink. The live
    // read wins otherwise, since a focus claim may have scrolled since the last
    // scroll event.
    const live = scrollEl.scrollLeft;
    const clamped =
      live >= scrollEl.scrollWidth - scrollEl.clientWidth - 1 &&
      scrollLeftRef.current > live;
    const was = clamped ? scrollLeftRef.current : live;
    // Same scale, moved origin (a write re-ranged the lane): shift by the day
    // delta so every date stays where it was on screen.
    if (prev.pxPerDay === pxPerDay) {
      if (prev.min !== min)
        writeScroll(
          scrollLeftRef,
          scrollEl,
          was + dayOffset(prev.min, min) * pxPerDay,
        );
      else scrollLeftRef.current = live;
      return;
    }
    // A new zoom: keep the day that sat mid-lane under the old scale mid-lane.
    const visible = scrollEl.clientWidth - RAIL_WIDTH;
    const center = addDays(
      prev.min,
      Math.floor((was + visible / 2) / prev.pxPerDay),
    );
    writeScroll(
      scrollLeftRef,
      scrollEl,
      centeredScroll(scrollEl, center, min, pxPerDay),
    );
  }, [scrollEl, min, pxPerDay, timeline.todayISO]);
  function jumpToToday() {
    if (scrollEl !== null)
      writeScroll(
        scrollLeftRef,
        scrollEl,
        centeredScroll(scrollEl, timeline.todayISO, min, pxPerDay),
      );
  }
  const appliedTodayNonce = useRef(todayNonce);
  const jumpFromNonce = useEffectEvent(() => jumpToToday());
  useEffect(() => {
    if (appliedTodayNonce.current === todayNonce) return;
    appliedTodayNonce.current = todayNonce;
    jumpFromNonce();
  }, [todayNonce]);

  // Focus follows the NONCE only, the table's rule, and finds its target by ROW
  // KEY. A lane cell also brings its bar into view: the lane is as wide as the
  // whole range, so scrolling the CELL in would do nothing sideways.
  const cursorKey =
    cursor === null ? null : (rows[cursor.rowIndex]?.key ?? null);
  const cursorRow = cursor?.rowIndex ?? null;
  const cursorCol = cursor?.colIndex ?? null;
  const claimCell = useEffectEvent(
    (key: string, rowIndex: number, at: number) => {
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
      let frame = 0;
      let tries = 6;
      const claim = () => {
        tries -= 1;
        const row = scrollEl?.querySelector<HTMLElement>(
          `[data-row-key="${CSS.escape(key)}"]`,
        );
        const col = row?.dataset.itemId === undefined ? 0 : at;
        const cell = row?.querySelector<HTMLElement>(
          `[data-col-index="${col}"]`,
        );
        if (cell) {
          cell.focus({ preventScroll: true });
          cell.scrollIntoView({ block: "nearest", inline: "nearest" });
          if (col === 1)
            cell
              .querySelector<HTMLElement>("[data-roadmap-mark]")
              ?.scrollIntoView({ block: "nearest", inline: "nearest" });
          return;
        }
        if (tries === 0) return;
        frame = requestAnimationFrame(claim);
      };
      frame = requestAnimationFrame(claim);
      return () => cancelAnimationFrame(frame);
    },
  );
  const claimCursorCell = useEffectEvent(() =>
    cursorKey === null || cursorRow === null
      ? undefined
      : claimCell(cursorKey, cursorRow, cursorCol ?? 0),
  );
  const appliedNonce = useRef(focusNonce);
  useEffect(() => {
    const unseen = appliedNonce.current !== focusNonce;
    appliedNonce.current = focusNonce;
    if (!unseen) return;
    return claimCursorCell();
  }, [focusNonce]);

  // Focus RECOVERY, the table's landing chain: when the grid OWNED focus and a
  // commit left it on <body> (a row re-sorted by its new dates, folded away, or
  // filtered out), land it on the cursor's cell, else the slot the focused row
  // left, else hand off to the panel. The one popup the grid anchors is the
  // title peek; a peek whose row stops being drawn reclaims focus the same way.
  const ownsFocusRef = useRef(false);
  const lastFocusRef = useRef<{ row: number; col: number } | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof Element && (scrollEl?.contains(active) ?? false)) {
      const key = active.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
      const row = rows.findIndex((entry) => entry.key === key);
      const col = Number(
        active.closest<HTMLElement>("[data-col-index]")?.dataset.colIndex,
      );
      if (row !== -1)
        lastFocusRef.current = { row, col: Number.isInteger(col) ? col : 0 };
      return;
    }
    const onBody =
      active === null ||
      active === document.body ||
      (scrollEl !== null && active.contains(scrollEl));
    const peekRetired =
      peekItemId !== null &&
      !rows.some(
        (entry) => entry.kind === "item" && entry.item.itemId === peekItemId,
      );
    if (peekRetired && onBody) ownsFocusRef.current = true;
    if (!ownsFocusRef.current || !onBody) return;
    if (cursorKey !== null && cursorRow !== null) return claimCursorCell();
    const last = lastFocusRef.current;
    const slot = Math.min(last?.row ?? 0, rows.length - 1);
    const landing = rows[slot];
    if (landing === undefined) {
      ownsFocusRef.current = false;
      onFocusLost();
      return;
    }
    return claimCell(landing.key, slot, Math.min(last?.col ?? 0, 1));
  });

  // Ownership is given up by a pointer press outside the grid, the table's rule.
  const pressInGridRef = useRef(false);
  useEffect(() => {
    if (scrollEl === null) return;
    const onPress = (e: PointerEvent) => {
      const inside = e.target instanceof Node && scrollEl.contains(e.target);
      pressInGridRef.current = inside;
      if (!inside) ownsFocusRef.current = false;
    };
    const onRelease = () => {
      pressInGridRef.current = false;
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("pointerup", onRelease, true);
    document.addEventListener("pointercancel", onRelease, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("pointerup", onRelease, true);
      document.removeEventListener("pointercancel", onRelease, true);
    };
  }, [scrollEl]);

  // A press on non-focusable grid space keeps focus where it was (the table's
  // rule); the scrollbars keep their default.
  function handleMouseDown(e: MouseEvent<HTMLDivElement>) {
    const el = e.target instanceof Element ? e.target : null;
    if (el === null || !e.currentTarget.contains(el)) return;
    const grid = e.currentTarget;
    const focusable = el.closest(IN_GRID_FOCUSABLE);
    if (focusable !== null && grid.contains(focusable)) return;
    if (
      el === grid &&
      (e.nativeEvent.offsetX >= grid.clientWidth ||
        e.nativeEvent.offsetY >= grid.clientHeight)
    )
      return;
    e.preventDefault();
  }

  /** The grid's own clicks: a group header toggles its section, a row's title
   *  opens the item. The panel's pointer grammar runs first, in capture. */
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target instanceof Element ? e.target : null;
    if (el === null) return;
    const toggle = el.closest<HTMLElement>("[data-group-toggle]");
    if (toggle?.dataset.groupToggle !== undefined) {
      onToggleGroup(toggle.dataset.groupToggle);
      return;
    }
    const key = el.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
    const entry = rows.find((row) => row.key === key);
    if (entry?.kind === "item" && el.closest("[data-title-open]") !== null)
      onActivate(entry.item);
  }

  const scrollMargin = virtualizer.options.scrollMargin;
  const year = Number(timeline.todayISO.slice(0, 4));
  return (
    <>
      {timeline.range.clamped && (
        <p className="mb-1 shrink-0 text-[11px] text-muted-foreground">
          Showing five years, {shortDate(timeline.range.min, year)} to{" "}
          {shortDate(timeline.range.max, year)}; items further out are cut off
          at the edge.
        </p>
      )}
      <div
        ref={setScrollEl}
        role="grid"
        aria-label={label}
        aria-rowcount={rows.length + 1}
        aria-colcount={2}
        aria-multiselectable
        onKeyDown={(e) => {
          // The header's Today button is the one control in here that isn't a
          // cell; its keys are its own.
          if (
            !(e.target instanceof Element) ||
            e.target.closest("[data-table-cell]") === null
          )
            return;
          onKeyDown(
            e,
            Math.max(
              Math.floor(
                (e.currentTarget.clientHeight - HEADER_HEIGHT) /
                  TABLE_ROW_HEIGHT,
              ) - 1,
              1,
            ),
          );
        }}
        onScroll={(e) => {
          scrollLeftRef.current = e.currentTarget.scrollLeft;
          setLaneScroll(e.currentTarget.scrollLeft);
        }}
        onClick={handleClick}
        onMouseDown={handleMouseDown}
        onFocus={() => {
          ownsFocusRef.current = true;
        }}
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (!(to instanceof Node) || e.currentTarget.contains(to)) return;
          if (pressInGridRef.current && to.contains(e.currentTarget)) return;
          ownsFocusRef.current = false;
        }}
        className={cn(
          "relative overflow-auto border",
          rows.length > 0 && "min-h-0 flex-1",
        )}
        style={{
          scrollPaddingTop: HEADER_HEIGHT,
          scrollPaddingLeft: RAIL_WIDTH,
        }}
      >
        <AxisHeader
          timeline={timeline}
          width={width}
          laneWidth={laneWidth}
          laneScroll={laneScroll}
          onToday={jumpToToday}
        />
        {rows.length > 0 && (
          <div
            role="rowgroup"
            className="relative"
            style={{ height: virtualizer.getTotalSize(), width }}
          >
            <Underlay
              timeline={timeline}
              laneWidth={laneWidth}
              height={virtualizer.getTotalSize()}
            />
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = rows[vi.index];
              const start = vi.start - scrollMargin;
              if (entry.kind === "group")
                return (
                  <TableGroupRow
                    key={entry.key}
                    entry={entry}
                    rowIndex={vi.index}
                    start={start}
                    width={width}
                    colCount={2}
                    tabbable={tabStopRow === vi.index}
                    onCellFocus={onCellFocus}
                  />
                );
              const item = entry.item;
              // The table's reading of "selected": the selection, or with
              // nothing selected the cursor's own row; never a redacted row.
              const selected =
                (item.content.kind !== "redacted" &&
                  selectedIds.has(item.itemId)) ||
                (selectionSize === 0 && cursorRow === vi.index);
              return (
                <RoadmapItemRow
                  key={entry.key}
                  rowKey={entry.key}
                  item={item}
                  rowIndex={vi.index}
                  start={start}
                  width={width}
                  laneWidth={laneWidth}
                  selected={selected}
                  checked={selected && selectionSize >= 2}
                  busy={item.itemId === busyItemId}
                  peek={item.itemId === peekItemId}
                  tabCol={
                    tabStopRow === vi.index ? (tabStop?.colIndex ?? 0) : null
                  }
                  sources={sources}
                  calendars={calendars}
                  timeline={timeline}
                  onCellFocus={onCellFocus}
                  onPeekChange={onPeekChange}
                />
              );
            })}
          </div>
        )}
      </div>
      {rows.length === 0 && (
        <p className="px-2 py-3 text-[11px] text-muted-foreground">No items</p>
      )}
    </>
  );
}
