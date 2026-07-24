// The Code TODOs tab (a Status-hub drill-in). Read-only code-TODO scan results, run
// against a toggleable marker set. Mirrors the other list screens' state vocabulary
// (SkeletonRows / ErrorState / RepoGoneState / StaleBanner / EmptyState) and roving
// keyboard nav, but the rows are NOT tappable (there's no file viewer on the phone) —
// they're roving-focusable only, for keyboard scanning, exactly like Branches rows.

import {
  ArrowsClockwiseIcon,
  CheckIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import { useRef, useState } from "react";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { TodoScanItem } from "../lib/api";
import { useTodoScan } from "../lib/queries";
import { useRovingList } from "../lib/use-roving-list";

// The default marker set the scan looks for. THREE copies of this list exist BY
// DESIGN — keep them in sync: the desktop's `src/features/code-todos/markers.ts`
// (`DEFAULT_MARKERS`), the LAN server's `src-tauri/src/lan/routes/git.rs`
// (`DEFAULT_TODO_MARKERS`), and here. The toggle set is local (transient) state, NOT
// in the URL — matching the desktop's transient toggles.
const DEFAULT_MARKERS = ["TODO", "FIXME", "HACK", "BUG", "XXX"];

/** The code-TODO scan screen. `repoId` scopes the query; `active` is accepted for
 *  parity with the other drill-in bodies (the scan hook deliberately doesn't poll,
 *  so it's unused here). */
export function TodosBody({
  repoId,
  active: _active,
}: {
  repoId: string;
  active: boolean;
}) {
  // The enabled marker set (transient, not URL-persisted — matches the desktop).
  const [markers, setMarkers] = useState<string[]>(DEFAULT_MARKERS);
  // The query auto-scans on open (it fires on mount) and re-keys on the sorted marker
  // set; with zero markers selected the hook's own `markers.length > 0` gate keeps it
  // from firing. `keepPreviousData` keeps the prior list up while a toggle re-keys.
  const { data, isError, error, refetch, isFetching, isPlaceholderData } =
    useTodoScan(repoId, markers, true);
  const { register, onKeyDown } = useRovingList();

  const toggleMarker = (marker: string) =>
    setMarkers((prev) =>
      prev.includes(marker)
        ? prev.filter((m) => m !== marker)
        : [...prev, marker],
    );

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
        <MarkerToggles enabled={markers} onToggle={toggleMarker} />
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded px-2 text-sm font-medium text-primary disabled:text-muted-foreground"
        >
          <ArrowsClockwiseIcon
            size={16}
            // motion-safe so the spin honors the app's global reduced-motion rule.
            className={isFetching ? "motion-safe:animate-spin" : ""}
            aria-hidden
          />
          Rescan
        </button>
      </div>

      <TodosResults
        markers={markers}
        data={data}
        isError={isError}
        error={error}
        onRetry={() => refetch()}
        isPlaceholderData={isPlaceholderData}
        register={register}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** The five marker toggle chips as a horizontal roving-tabindex group (repo rule:
 *  every selectable list gets arrow-key nav in the same change). ArrowLeft/ArrowRight
 *  move focus between chips (wrapping), Home/End jump to first/last — focus ONLY; a
 *  chip toggles on Enter/Space (native button activation) or a tap, never on arrow, so
 *  arrowing across a multi-select never flips a marker. One chip is in the tab order at
 *  a time (the roving stop follows the last-focused chip). The Rescan button is a plain
 *  tab stop OUTSIDE this group — it's an action, not a selectable. Adapts BottomNav's
 *  inline roving pattern (which we can't share directly — it's link/hash-based). */
function MarkerToggles({
  enabled,
  onToggle,
}: {
  enabled: string[];
  onToggle: (marker: string) => void;
}) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  // The roving tab stop: the chip that currently holds tabIndex 0. Follows the
  // last-focused chip so Tab-ing away and back returns to it, not chip 0.
  const [focusIndex, setFocusIndex] = useState(0);

  function onKeyDown(e: React.KeyboardEvent) {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
        next = (focusIndex + 1) % DEFAULT_MARKERS.length;
        break;
      case "ArrowLeft":
        next =
          (focusIndex - 1 + DEFAULT_MARKERS.length) % DEFAULT_MARKERS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = DEFAULT_MARKERS.length - 1;
        break;
      default:
        return; // Enter/Space fall through to native button activation (toggle).
    }
    e.preventDefault();
    setFocusIndex(next);
    chips.current[next]?.focus();
  }

  return (
    <div
      role="group"
      aria-label="TODO markers"
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
    >
      {DEFAULT_MARKERS.map((marker, i) => {
        const on = enabled.includes(marker);
        return (
          <button
            key={marker}
            type="button"
            ref={(el) => {
              chips.current[i] = el;
            }}
            aria-pressed={on}
            tabIndex={i === focusIndex ? 0 : -1}
            onKeyDown={onKeyDown}
            onFocus={() => setFocusIndex(i)}
            onClick={() => onToggle(marker)}
            className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-medium ${
              on
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {/* Pressed state is never color-alone: aria-pressed carries the
                semantics and a check glyph gives a visible non-color cue. */}
            {on ? <CheckIcon size={12} weight="bold" aria-hidden /> : null}
            {marker}
          </button>
        );
      })}
    </div>
  );
}

/** The scan results below the control row. Split out so the sticky control row stays
 *  mounted (and interactive) across every result state. */
function TodosResults({
  markers,
  data,
  isError,
  error,
  onRetry,
  isPlaceholderData,
  register,
  onKeyDown,
}: {
  markers: string[];
  data: { items: TodoScanItem[]; truncated: boolean } | undefined;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  isPlaceholderData: boolean;
  register: (index: number) => (el: HTMLElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  // Zero markers selected → the hook doesn't query; teach the toggle instead of
  // showing an empty scan.
  if (markers.length === 0) {
    return (
      <EmptyState
        title="No markers selected."
        hint="Turn on a marker above to scan the working tree."
      />
    );
  }

  // Definitive gone WINS over stale data (see isRepoGoneError).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  // Prefer stale data: keep the last scan on screen even on error, with a StaleBanner
  // above it. Full-screen ErrorState only when there's nothing to show; skeleton only
  // while the first scan is pending.
  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={onRetry} />;
    return <SkeletonRows />;
  }

  if (data.items.length === 0) {
    return (
      <>
        {isError ? <StaleBanner error={error} onRetry={onRetry} /> : null}
        <EmptyState
          title="Nothing found."
          hint="No TODO-style markers match the selected set."
        />
      </>
    );
  }

  return (
    <>
      {isError ? <StaleBanner error={error} onRetry={onRetry} /> : null}
      {data.truncated ? (
        <p className="flex items-center gap-2 border-b border-info/40 bg-info/10 px-4 py-2 text-xs text-foreground">
          <InfoIcon size={14} className="shrink-0 text-info" aria-hidden />
          Showing the first 2,000 matches — turn off markers to narrow the scan.
        </p>
      ) : null}
      <TodoList
        items={data.items}
        // A marker toggle mid-flight keeps the previous list rendered (keepPreviousData)
        // — dim it so the toggle feels responsive, never a skeleton collapse.
        dimmed={isPlaceholderData}
        register={register}
        onKeyDown={onKeyDown}
      />
    </>
  );
}

/** The scan hits, grouped by file. Items arrive GROUPED BY PATH (git-grep order —
 *  consecutive items share a path); a single pass over `items` emits a file-group
 *  header at each path-change boundary, its rows beneath. Rows are roving-focusable
 *  (keyboard scanning) but not tappable. */
function TodoList({
  items,
  dimmed,
  register,
  onKeyDown,
}: {
  items: TodoScanItem[];
  dimmed: boolean;
  register: (index: number) => (el: HTMLElement | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const groups = groupByPath(items);
  // Roving index runs across ALL rows (flat), not per-group, so ArrowUp/Down scans
  // the whole scan continuously; `rowIndex` counts rows as we emit them.
  let rowIndex = 0;
  return (
    <div className={dimmed ? "opacity-60" : ""}>
      {groups.map((group) => (
        <section key={group.path} className="flex flex-col">
          <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {group.path}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {group.items.length}
            </span>
          </header>
          <ul className="flex flex-col divide-y divide-border">
            {group.items.map((item) => {
              const i = rowIndex++;
              return (
                // Keyed by the hit's stable identity (path:line) — NOT the flat roving
                // index, which would remount every subsequent row when a rescan shifts
                // earlier rows (losing focus + the dimmed-placeholder transition).
                <li key={`${item.path}:${item.line}`}>
                  <div
                    ref={register(i)}
                    onKeyDown={onKeyDown}
                    // A focusable, roving list row (repo convention: every list gets
                    // keyboard nav) — but NOT a control: there's no file viewer to
                    // open, so it's a plain row, not a button/link. First row is the
                    // tab stop; roving moves it as the user arrows.
                    tabIndex={i === 0 ? 0 : -1}
                    className="flex min-h-11 items-center gap-3 px-4 py-2 outline-none focus-visible:bg-muted/40"
                  >
                    <MarkerChip label={item.marker} />
                    {item.text ? (
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                        {item.text}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      L{item.line}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One file's group of consecutive hits. */
interface TodoGroup {
  path: string;
  items: TodoScanItem[];
}

/** Group consecutive same-path items in a single pass (the server already emits them
 *  contiguous, in git-grep order — never re-sort). */
function groupByPath(items: TodoScanItem[]): TodoGroup[] {
  const groups: TodoGroup[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.path === item.path) last.items.push(item);
    else groups.push({ path: item.path, items: [item] });
  }
  return groups;
}

/** A neutral marker chip (TODO / FIXME / …) — the marker WORD carries the meaning;
 *  no per-marker color (matching the companion's neutral-chips rule). */
function MarkerChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}
