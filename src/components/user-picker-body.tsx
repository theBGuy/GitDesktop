import { Popover } from "@base-ui/react/popover";
import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
} from "@tanstack/react-virtual";
import {
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  buildPickerRows,
  ceilingNote,
  nextPickerStop,
  PICKER_APPLY_NOTE,
  PICKER_LEGEND,
  PICKER_NO_MATCH,
  PICKER_RAIL_PAD,
  PICKER_ROW_HEIGHT,
  type PickerStop,
  rowStop,
} from "@/components/user-picker-model";
import {
  DEGRADED_ACTION_CLASS,
  emptyPickerCopy,
  listNotice,
  OFFLINE_ROWS_NOTICE,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { mergePinnedIndexes } from "@/features/repository/BranchSwitcherRows";
import { clipTitleFromText } from "@/lib/clip-title";
import type { ForgeUserList, ForgeUserRef } from "@/lib/git/types";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { cn } from "@/lib/utils";

/** The popup of a user picker: a flex column capped to the viewport, where
 *  only the body's rows rail scrolls. */
export const USER_PICKER_POPUP_CLASS =
  "flex max-h-[min(24rem,var(--available-height))] w-60 flex-col rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10";

export interface UserPickerRead {
  /** The fetched list (`data?.users`); undefined until a read has answered. */
  users: ForgeUserRef[] | undefined;
  /** `data?.truncated ?? false`. */
  truncated: boolean;
  /** `data?.ceiling ?? 0`; printed only while `truncated`. */
  ceiling: number;
  isPending: boolean;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}

/** A user-list query as the body reads it. */
export function toUserPickerRead(q: {
  data: ForgeUserList | undefined;
  isPending: boolean;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
  refetch: () => unknown;
}): UserPickerRead {
  return {
    users: q.data?.users,
    truncated: q.data?.truncated ?? false,
    ceiling: q.data?.ceiling ?? 0,
    isPending: q.isPending,
    isError: q.isError,
    isPaused: q.isPaused,
    isFetching: q.isFetching,
    refetch: q.refetch,
  };
}

/** For `Popover.Popup`'s `onFocus`: focus that lands on the popup element itself (a click on its
 *  non-focusable text) moves to the filter, so it never rests outside the body's key handler. */
export function redirectPopupFocus(e: FocusEvent<HTMLElement>): void {
  if (e.target !== e.currentTarget) return;
  e.currentTarget
    .querySelector<HTMLElement>('[data-picker-stop="filter"]')
    ?.focus();
}

/** The status slot's line; the first rung that holds wins. */
function statusLine(input: {
  read: UserPickerRead;
  copy: { noun: string; loadFailed: string; empty: string };
  total: number;
  shown: number;
}): string {
  const { read, copy } = input;
  const fetchedCount = read.users?.length ?? 0;
  switch (true) {
    case fetchedCount === 0:
      return emptyPickerCopy({ ...read, data: read.users }, copy);
    case refreshFailed(read):
      return (
        listNotice({
          noun: copy.noun,
          failed: true,
          offline: false,
          placeholder: false,
          hasRows: true,
          loadMoreFailed: false,
        })?.message ?? ""
      );
    case read.isPaused:
      return OFFLINE_ROWS_NOTICE;
    case input.total > 0 && input.shown === 0:
      return PICKER_NO_MATCH;
    default:
      return "";
  }
}

/**
 * The body of a forge-user picker popup (assignees, reviewers): title, filter,
 * status line, the windowed rows rail and the footer. It owns every key the
 * popup handles: Tab and the arrows walk a cursor over filter, Retry and rows
 * (Tab never leaves the popup; Esc, which Base UI handles, is the exit), and
 * Enter or a printable key act on the row the event came from. Re-keyed per
 * open by its popover, so filter, cursor and scroll start fresh each time.
 */
export function UserPickerBody({
  title,
  read,
  copy,
  snapshot,
  checked,
  onToggle,
  commitsOnClose,
  ghHost,
  hint,
}: {
  title: string;
  read: UserPickerRead;
  copy: { noun: string; loadFailed: string; empty: string };
  /** The users selected when the popup opened, sorted (`sortedSnapshot`). */
  snapshot: readonly ForgeUserRef[];
  checked: ReadonlyMap<string, ForgeUserRef>;
  onToggle: (user: ForgeUserRef, on: boolean) => void;
  commitsOnClose: boolean;
  ghHost: string | null;
  hint?: (user: ForgeUserRef) => string | null;
}) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<PickerStop>("filter");
  // Bumped by keyboard moves onto a row only: those scroll and claim focus.
  const [focusNonce, setFocusNonce] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // The row holding DOM focus, for the rescue below.
  const focusedRowRef = useRef<string | null>(null);

  const { rows, restStart, total } = buildPickerRows({
    fetched: read.users,
    snapshot,
    checked,
    filter,
  });
  const status = statusLine({ read, copy, total, shown: rows.length });
  const showRetry = refreshFailed(read);
  const stops: PickerStop[] = [
    "filter",
    ...(showRetry ? ["retry"] : []),
    ...rows.map((u) => rowStop(u.id)),
  ];
  const cursorRowId = cursor.startsWith("row:") ? cursor.slice(4) : null;

  function moveTo(stop: PickerStop) {
    setCursor(stop);
    if (stop === "filter") filterRef.current?.focus();
    else if (stop === "retry") retryRef.current?.focus();
    else setFocusNonce((n) => n + 1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      if (hasChordModifier(e)) return;
      // Always consumed, even with one stop: a Tab out would be a focus-out
      // close, which commits in commit-on-close mode.
      e.preventDefault();
      const to = nextPickerStop({
        stops,
        from: cursor,
        key: "Tab",
        shift: e.shiftKey,
      });
      if (to !== null) moveTo(to);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hasChordModifier(e) || e.shiftKey) return;
      // Consumed even with nowhere to go, so an arrow never scrolls the rail,
      // the dialog or the page behind the popup.
      e.preventDefault();
      const to = nextPickerStop({
        stops,
        from: cursor,
        key: e.key,
        shift: false,
      });
      if (to !== null) moveTo(to);
      return;
    }
    // Row actions follow the event's target, never the cursor, which can run
    // ahead of focus while a claim is in flight.
    const rowEl =
      e.target instanceof Element ? e.target.closest("[data-row-id]") : null;
    if (!rowEl || hasChordModifier(e)) return;
    const user = rows.find((u) => u.id === rowEl.getAttribute("data-row-id"));
    if (!user) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) onToggle(user, !checked.has(user.id));
      return;
    }
    if (e.key.length === 1 && e.key !== " " && !e.nativeEvent.isComposing) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      moveTo("filter");
    }
  }

  function onFocus(e: FocusEvent<HTMLDivElement>) {
    if (!(e.target instanceof HTMLElement)) return;
    const kind = e.target.getAttribute("data-picker-stop");
    const id = e.target.getAttribute("data-row-id");
    focusedRowRef.current = kind === "row" ? id : null;
    if (kind === "filter" || kind === "retry") setCursor(kind);
    else if (kind === "row" && id !== null) setCursor(rowStop(id));
  }

  function retry() {
    // Focus moves to the filter BEFORE the refetch unmounts this button, never
    // via useRetryFocusRescue: focus falling to <body> here is a focus-out
    // close, and in commit-on-close mode a close writes.
    setCursor("filter");
    filterRef.current?.focus();
    read.refetch();
  }

  // A refetch that dropped the focused row leaves focus on <body>; bring it
  // back to the filter so the popup's keys keep working.
  useEffect(() => {
    const held = focusedRowRef.current;
    if (held === null || rows.some((u) => u.id === held)) return;
    focusedRowRef.current = null;
    const scope = rootRef.current?.parentElement ?? rootRef.current;
    if (scope?.contains(document.activeElement)) return;
    setCursor("filter");
    filterRef.current?.focus();
  }, [rows]);

  return (
    <div
      ref={rootRef}
      className="flex min-h-0 flex-col"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {/* Title names the popup via aria-labelledby — a bare caption leaves the
          dialog unnamed; render keeps the <p> off Title's default <h2>. */}
      <Popover.Title
        render={<p />}
        className="shrink-0 px-1 pb-1.5 text-xs font-medium"
      >
        {title}
      </Popover.Title>
      <Input
        ref={filterRef}
        className="h-7 shrink-0"
        placeholder="Filter users"
        aria-label="Filter users"
        data-picker-stop="filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="flex shrink-0 items-baseline gap-2 px-1">
        {/* Always mounted so its changes are announced; empty, it takes no
            height (no padding), never `hidden`. */}
        <p
          role="status"
          className={cn(
            "min-w-0 flex-1 text-xs text-muted-foreground",
            status && "pt-1.5",
          )}
        >
          {status}
        </p>
        {showRetry && (
          <button
            ref={retryRef}
            type="button"
            tabIndex={-1}
            data-picker-stop="retry"
            aria-label={`Retry loading ${copy.noun}`}
            className={cn(
              "shrink-0 text-xs text-muted-foreground",
              DEGRADED_ACTION_CLASS,
            )}
            onClick={retry}
          >
            Retry
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <UserPickerRows
          title={title}
          rows={rows}
          restStart={restStart}
          checked={checked}
          onToggle={onToggle}
          ghHost={ghHost}
          hint={hint}
          cursorRowId={cursorRowId}
          focusNonce={focusNonce}
          filter={filter}
          rootRef={rootRef}
        />
      )}
      {/* The popup's aria-describedby, always rendered: Tab is trapped, so the
          Esc exit has to be on screen and announced in every state. */}
      <Popover.Description
        render={<div />}
        className="mt-1 shrink-0 border-t px-1 pt-1.5 text-[11px] text-muted-foreground"
      >
        {read.truncated && <p>{ceilingNote(read.ceiling)}</p>}
        {commitsOnClose && <p>{PICKER_APPLY_NOTE}</p>}
        <p>{PICKER_LEGEND}</p>
      </Popover.Description>
    </div>
  );
}

/** The windowed rows. Its own component because `useVirtualizer` bails its host
 *  out of the React Compiler; mounted only with rows. */
function UserPickerRows({
  title,
  rows,
  restStart,
  checked,
  onToggle,
  ghHost,
  hint,
  cursorRowId,
  focusNonce,
  filter,
  rootRef,
}: {
  title: string;
  rows: ForgeUserRef[];
  restStart: number;
  checked: ReadonlyMap<string, ForgeUserRef>;
  onToggle: (user: ForgeUserRef, on: boolean) => void;
  ghHost: string | null;
  hint?: (user: ForgeUserRef) => string | null;
  cursorRowId: string | null;
  focusNonce: number;
  filter: string;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  const labelPrefix = useId();
  // State, not a ref: the virtualizer must see the element the instant it mounts.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // The row holding DOM focus. State: it pins a row, so a change re-renders the range.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const count = rows.length;
  const cursorPin =
    cursorRowId === null ? -1 : rows.findIndex((u) => u.id === cursorRowId);
  const focusedPin =
    focusedId === null ? -1 : rows.findIndex((u) => u.id === focusedId);
  const getItemKey = useCallback((i: number) => rows[i].id, [rows]);
  // The cursor row stays mounted so a key move can claim it, and the focused
  // row so focus never drops to <body> when it scrolls out of the window.
  const rangeExtractor = useCallback(
    (range: Range) =>
      mergePinnedIndexes(
        defaultRangeExtractor(range),
        [cursorPin, focusedPin],
        count,
      ),
    [cursorPin, focusedPin, count],
  );
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    estimateSize: () => PICKER_ROW_HEIGHT,
    getItemKey,
    rangeExtractor,
    // The rail's py-2 puts the rows this far below the scroll origin; without
    // it scrollToIndex leaves the last row's bottom edge under the viewport.
    scrollMargin: PICKER_RAIL_PAD,
    scrollPaddingStart: PICKER_RAIL_PAD,
    scrollPaddingEnd: PICKER_RAIL_PAD,
    overscan: 8,
  });

  // Focus follows KEYBOARD moves only, so a click never scrolls the list. The
  // claim lands only while focus is still inside the popup, with a few frames
  // for the pinned row to mount. A claim counts as applied only once it lands
  // or runs out of frames: a re-run that cancels its pending frame retries it.
  const appliedNonce = useRef(focusNonce);
  useEffect(() => {
    if (appliedNonce.current === focusNonce) return;
    if (cursorPin < 0 || cursorRowId === null) {
      appliedNonce.current = focusNonce;
      return;
    }
    virtualizer.scrollToIndex(cursorPin, { align: "auto" });
    let frame = 0;
    let tries = 4;
    const claim = () => {
      tries -= 1;
      const row = scrollEl?.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(cursorRowId)}"]`,
      );
      if (row) {
        appliedNonce.current = focusNonce;
        const focused = document.activeElement;
        const scope = rootRef.current?.parentElement ?? rootRef.current;
        if (focused !== row && focused !== null && scope?.contains(focused))
          row.focus();
        return;
      }
      if (tries > 0) frame = requestAnimationFrame(claim);
      else appliedNonce.current = focusNonce;
    };
    claim();
    return () => cancelAnimationFrame(frame);
  }, [cursorPin, cursorRowId, focusNonce, scrollEl, virtualizer, rootRef]);

  // Back to the top when the filter changes; only on a real change, so a
  // replayed effect keeps the position.
  const appliedFilter = useRef(filter);
  useEffect(() => {
    if (appliedFilter.current === filter) return;
    appliedFilter.current = filter;
    virtualizer.scrollToOffset(0);
  }, [filter, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  return (
    <div
      ref={setScrollEl}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2"
      // React bubbles focus through portals by component tree, so only a target
      // inside this element in the DOM counts.
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.target)) return;
        setFocusedId(
          e.target.closest("[data-row-id]")?.getAttribute("data-row-id") ??
            null,
        );
      }}
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.target) ||
          (e.relatedTarget instanceof Node &&
            e.currentTarget.contains(e.relatedTarget))
        )
          return;
        setFocusedId(null);
      }}
    >
      <div
        role="list"
        aria-label={title}
        className="relative w-full"
        style={{ height: `${totalSize}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const user = rows[vi.index];
          const userHint = hint?.(user) ?? null;
          const labelId = `${labelPrefix}-${vi.index}`;
          return (
            <div
              key={user.id}
              role="listitem"
              aria-setsize={count}
              aria-posinset={vi.index + 1}
              className={cn(
                "absolute top-0 left-0 w-full",
                vi.index === restStart &&
                  restStart > 0 &&
                  "before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-border",
              )}
              style={{
                transform: `translateY(${vi.start - PICKER_RAIL_PAD}px)`,
              }}
            >
              {/* The focus cue is the row's inset ring: the vendored checkbox's
                  data-checked border outranks its focus-visible one, so a
                  focused checked box alone shows no 3:1 change. */}
              <label className="flex h-9 cursor-pointer items-center gap-2 px-1 text-xs hover:bg-muted/60 focus-within:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset">
                <Checkbox
                  tabIndex={-1}
                  data-picker-stop="row"
                  data-row-id={user.id}
                  aria-labelledby={labelId}
                  checked={checked.has(user.id)}
                  onCheckedChange={(v) => onToggle(user, v === true)}
                />
                <ForgeUserAvatar user={user} ghHost={ghHost} decorative />
                <span
                  id={labelId}
                  className="flex-1 truncate"
                  onMouseEnter={clipTitleFromText}
                >
                  {user.label}
                  {userHint && (
                    <span className="text-muted-foreground"> · {userHint}</span>
                  )}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
