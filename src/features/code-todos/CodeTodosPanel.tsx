import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  ListChecksIcon,
} from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useTodoScan } from "@/lib/git/queries";
import type { TodoScanItem } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { cn } from "@/lib/utils";
import { MarkerChip } from "./MarkerChip";
import { DEFAULT_MARKERS, TODO_SCAN_CAP } from "./markers";

/** A flattened row in the virtualized list: a per-file header or a TODO item.
 *  One flat list keeps virtualization, cross-group arrow-key nav, and grouping
 *  in a single index space (the ChangesPanel recipe). */
type FlatRow =
  | { type: "header"; path: string; count: number }
  | { type: "item"; item: TodoScanItem };

/** DOM key for an item row (also its selection identity). */
function itemKey(item: TodoScanItem): string {
  return `${item.path}:${item.line}`;
}

export function CodeTodosPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const selectedTodo = useUiStore((s) => s.selectedTodo);
  const setSelectedTodo = useUiStore((s) => s.setSelectedTodo);

  const [filterText, setFilterText] = useState("");
  // Which markers are enabled (chips). All on by default.
  const [enabledMarkers, setEnabledMarkers] = useState<Set<string>>(
    () => new Set(DEFAULT_MARKERS),
  );
  // Collapsed file groups, keyed by path.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Native scroll element held in STATE (not a ref) so attaching it re-renders
  // and the virtualizer re-initializes with the real node — a plain ref stays
  // null at the virtualizer's mount effect and no rows paint. See
  // docs/list-virtualization.md.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  // The marker chips drive the SCAN, not a post-cap client filter: passing only
  // the enabled markers means the TODO_SCAN_CAP hit cap applies to the markers
  // you care about, so narrowing to BUG can't hide BUGs the cap already dropped.
  // Derived in DEFAULT_MARKERS order so the query key (which includes `markers`)
  // is stable regardless of toggle order — per-set results just cache. All-off
  // is guarded below: the Rust side rejects an empty markers vec.
  const markers = useMemo(
    () => DEFAULT_MARKERS.filter((m) => enabledMarkers.has(m)),
    [enabledMarkers],
  );
  const noMarkers = markers.length === 0;

  // Heavy git-grep scan; gate on the tab being active (<Activity> keeps this
  // mounted but doesn't defer fetches — same as InsightsPanel) AND on at least
  // one marker being selected (an empty vec errors server-side).
  const scan = useTodoScan(
    repoPath,
    markers,
    TODO_SCAN_CAP,
    active && !noMarkers,
  );
  const allItems = scan.data?.items ?? [];

  // The only client-side filter now is the free-text match on comment text OR
  // path (case-insensitive); marker selection is already applied by the scan.
  const needle = filterText.trim().toLowerCase();
  const visibleItems = useMemo(
    () =>
      needle
        ? allItems.filter(
            (it) =>
              it.text.toLowerCase().includes(needle) ||
              it.path.toLowerCase().includes(needle),
          )
        : allItems,
    [allItems, needle],
  );

  // Group the visible items by path (items already arrive path-grouped), then
  // flatten to header + item rows, dropping the rows of collapsed groups so they
  // leave both the DOM and the arrow-key nav registry.
  const { flatRows, navItems } = useMemo(() => {
    const groups: { path: string; items: TodoScanItem[] }[] = [];
    for (const it of visibleItems) {
      const last = groups[groups.length - 1];
      if (last && last.path === it.path) last.items.push(it);
      else groups.push({ path: it.path, items: [it] });
    }
    const rows: FlatRow[] = [];
    const nav: TodoScanItem[] = [];
    for (const g of groups) {
      rows.push({ type: "header", path: g.path, count: g.items.length });
      if (!collapsed.has(g.path)) {
        for (const item of g.items) {
          rows.push({ type: "item", item });
          nav.push(item);
        }
      }
    }
    return { flatRows: rows, navItems: nav };
  }, [visibleItems, collapsed]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (flatRows[i].type === "header" ? 28 : 32),
    overscan: 16,
  });

  const activeKey = selectedTodo
    ? `${selectedTodo.path}:${selectedTodo.line}`
    : null;
  const activeNavIndex = activeKey
    ? navItems.findIndex((it) => itemKey(it) === activeKey)
    : -1;
  // Flat index of the active row, so we can keep it scrolled into view under
  // virtualization (its DOM node may not be mounted). Selection stays visible
  // via the row's `bg-accent` styling + `aria-selected`; row focus doesn't move.
  const activeFlatIndex = activeKey
    ? flatRows.findIndex(
        (r) => r.type === "item" && itemKey(r.item) === activeKey,
      )
    : -1;

  // The ChangesPanel recipe: pass `rowKey` so the focus ring tracks the active
  // row (and keydown keeps firing from a focused row), AND scroll it into view
  // from an effect on the active FLAT index below — under virtualization the
  // focused row's DOM node may be unmounted, so `listKeyboardNav`'s own
  // scrollIntoView isn't enough on its own. The neighbouring row is almost
  // always already within the overscan window, so its `.focus()` lands.
  const onListKeyDown = listKeyboardNav({
    items: navItems,
    activeIndex: activeNavIndex,
    rowKey: itemKey,
    onActivate: (item) =>
      setSelectedTodo({
        path: item.path,
        line: item.line,
        marker: item.marker,
        text: item.text,
      }),
  });

  // Keep the active row scrolled into view as the selection moves — its DOM node
  // may not be mounted under virtualization, so scroll by index.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active change
  useEffect(() => {
    if (activeFlatIndex >= 0)
      virtualizer.scrollToIndex(activeFlatIndex, { align: "auto" });
  }, [activeFlatIndex]);

  function toggleMarker(marker: string) {
    setEnabledMarkers((prev) => {
      const next = new Set(prev);
      if (next.has(marker)) next.delete(marker);
      else next.add(marker);
      return next;
    });
  }

  function toggleGroup(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const busy = scan.isFetching;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        {DEFAULT_MARKERS.map((marker) => {
          const on = enabledMarkers.has(marker);
          return (
            <Button
              key={marker}
              variant={on ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={on}
              className="font-mono"
              onClick={() => toggleMarker(marker)}
            >
              {marker}
            </Button>
          );
        })}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Rescan for TODOs"
          disabled={busy || noMarkers}
          onClick={() => scan.refetch()}
        >
          <ArrowClockwiseIcon className={cn(busy && "animate-spin")} />
        </Button>
      </div>
      <div className="border-b p-2">
        <Input
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by text or path"
          className="h-7"
          autoComplete="off"
        />
      </div>

      {noMarkers ? (
        <p className="px-3 py-8 text-center text-xs text-muted-foreground">
          Select a marker above to scan.
        </p>
      ) : scan.isPending ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : scan.isError ? (
        <div className="p-4 text-center text-xs">
          <p className="font-medium text-destructive">
            Couldn't scan for TODOs.
          </p>
          <p className="mt-1 text-muted-foreground">
            {errorMessage(scan.error)}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="mt-3"
            onClick={() => scan.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : allItems.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListChecksIcon />
            </EmptyMedia>
            <EmptyTitle>No TODO comments found</EmptyTitle>
            <EmptyDescription>
              Nothing in the working tree matches {markers.join(", ")}.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {scan.data?.truncated && (
            <p className="border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
              Showing the first {TODO_SCAN_CAP.toLocaleString()} matches —
              deselect markers to scan fewer, or filter the text below.
            </p>
          )}
          {flatRows.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No matches for this filter.
            </p>
          ) : (
            // Native overflow scroll container (not the Base-UI ScrollArea) so the
            // virtualizer's getScrollElement gets the real scrollable node; a
            // fixed-height flex child so getTotalSize resolves.
            // See docs/list-virtualization.md.
            <div
              ref={setScrollEl}
              onKeyDown={onListKeyDown}
              className="min-h-0 flex-1 overflow-y-auto"
              role="listbox"
              aria-label="Code TODOs"
            >
              <div
                className="relative w-full"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualizer.getVirtualItems().map((vi) => {
                  const row = flatRows[vi.index];
                  return (
                    <div
                      key={
                        row.type === "header"
                          ? `header:${row.path}`
                          : itemKey(row.item)
                      }
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="absolute top-0 left-0 w-full"
                      style={{ transform: `translateY(${vi.start}px)` }}
                    >
                      {row.type === "header" ? (
                        <button
                          type="button"
                          onClick={() => toggleGroup(row.path)}
                          aria-expanded={!collapsed.has(row.path)}
                          className="flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                        >
                          {collapsed.has(row.path) ? (
                            <CaretRightIcon className="size-3 shrink-0" />
                          ) : (
                            <CaretDownIcon className="size-3 shrink-0" />
                          )}
                          <span className="truncate font-mono" title={row.path}>
                            {row.path}
                          </span>
                          <span className="tabular-nums">({row.count})</span>
                        </button>
                      ) : (
                        <TodoRow
                          item={row.item}
                          active={itemKey(row.item) === activeKey}
                          onSelect={() =>
                            setSelectedTodo({
                              path: row.item.path,
                              line: row.item.line,
                              marker: row.item.marker,
                              text: row.item.text,
                            })
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoRow({
  item,
  active,
  onSelect,
}: {
  item: TodoScanItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // `data-row` = the key listKeyboardNav focuses/scrolls; role="option" +
      // aria-selected give the row its listbox semantics so the active row is
      // conveyed to assistive tech — never the accent color alone.
      data-row={itemKey(item)}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1 text-left text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <MarkerChip marker={item.marker} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {item.text || (
          <span className="text-muted-foreground">(no description)</span>
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {item.line}
      </span>
    </button>
  );
}
