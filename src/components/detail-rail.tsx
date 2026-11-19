import {
  CaretLeftIcon,
  CaretRightIcon,
  FunnelIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type AriaRole,
  createContext,
  type Dispatch,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
  useContext,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePanelActive } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import type { DetailRailFilter } from "@/components/use-file-list-filter";
import {
  eventToBinding,
  firesInEditable,
  hasChordModifier,
  hasModifier,
  isEditableTarget,
  isTypeaheadKey,
  isTypeaheadTarget,
} from "@/lib/hotkeys/binding";
import { useEffectiveBindings, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import type { AppSettings } from "@/lib/settings/api";
import {
  settingsKeys,
  useSaveSettings,
  useSettings,
} from "@/lib/settings/queries";
import { useContainerWidth } from "@/lib/use-container-width";
import { useLatestRef } from "@/lib/use-latest-ref";
import { cn } from "@/lib/utils";

// Below this the surrounding pane can't hold the 288px rail plus a diff wide
// enough to read, so the rail is forced to its strip whatever the preference.
const RAIL_MIN_CONTAINER_PX = 512;

// Names the landmark when the caller's own label belongs to a list role nested
// inside it — one name per element, or landmark navigation announces it twice.
const LANDMARK_LABEL = "File list";

// A filter rail's strip box, shared by both branches so the caret keeps one
// vertical position as the rail toggles: the diff path row's `py-1.5` around an
// `h-7` line (41px with the expanded strip's border).
const FILTER_BOX_Y = "py-1.5";

// The scope of a filter rail that unmounted this commit with its field focused,
// for a same-scope rail mounting in that commit (an agent session's two views
// swap in one slot) to take the field over. Written and read only in layout
// effects; a microtask clears it, so an <Activity> hide (no same-scope rail
// shows in that commit) leaves nothing for a later show.
let fieldHandoff: string | null = null;

// Width of the row the rail sits in; `null` until measured, and outside a
// DetailRailRow. Unknown reads as "wide" so the rail never flashes collapsed.
const RailWidthContext = createContext<number | null>(null);

// The row's slot for its filter rail's "focus the filter"; null outside a row.
const RailFocusFilterContext = createContext<Dispatch<
  SetStateAction<(() => void) | null>
> | null>(null);

/** The file noun the counts share; it follows the list's TOTAL, never the
 *  match count. */
function fileNoun(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/**
 * The rail + detail row. Measures itself so `DetailRail` can decide whether the
 * pane has room for the file list — the measurement has to live on the row, not
 * the rail, since the rail's own width is the thing being decided.
 */
export function DetailRailRow({ children }: { children: ReactNode }) {
  const [measureRef, width] = useContainerWidth<HTMLDivElement>();
  // State, not a ref: the row's tab stop follows whether a filter rail is in it.
  const [focusFilter, setFocusFilter] = useState<(() => void) | null>(null);
  const bindings = useEffectiveBindings();
  const binding = bindings.get("focus-filter") ?? null;
  // Focus anywhere in the row (rail or diff) sends the filter shortcut to this
  // rail's field, under the global listener's guards (a subset of what it would
  // dispatch, so a key a child already consumed stays that child's); the
  // listener then skips the prevented event. A chord several actions share
  // belongs to the first holder in the bindings map, as in the listener.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (focusFilter === null || binding === null || e.repeat) return;
    if (e.defaultPrevented) return;
    // React bubbles through portals: a dialog a row action opened is not the row.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))
      return;
    if (eventToBinding(e) !== binding) return;
    for (const [id, held] of bindings) {
      if (held !== binding) continue;
      if (id !== "focus-filter") return;
      break;
    }
    if (isEditableTarget(e.target) && !firesInEditable(binding)) return;
    if (
      !hasModifier(binding) &&
      isTypeaheadKey(binding) &&
      isTypeaheadTarget(e.target)
    )
      return;
    e.preventDefault();
    focusFilter();
  };
  return (
    <div
      ref={measureRef}
      // Focusable only around a filter rail: a click on plain diff text then
      // leaves focus inside the row, where the shortcut is answered.
      tabIndex={focusFilter ? -1 : undefined}
      className={cn("flex min-h-0 flex-1", focusFilter && "outline-none")}
      onKeyDown={onKeyDown}
    >
      <RailWidthContext value={width}>
        <RailFocusFilterContext value={setFocusFilter}>
          {children}
        </RailFocusFilterContext>
      </RailWidthContext>
    </div>
  );
}

// The tab-wide `focus-filter` answer. Mounted only when claimed: a registered
// but disabled handler still makes the window listener swallow the chord.
function FocusFilterClaim({ run }: { run: () => void }) {
  useHotkeyAction("focus-filter", run, usePanelActive());
  return null;
}

/**
 * The collapsible file-list rail shared by the diff detail views. Two state
 * layers: the persisted `diffFileListCollapsed` preference governs while the
 * row has room, and a narrow row forces the strip — an explicit expand there is
 * local, never written back, and drops when the row regains room. A `filter`
 * puts its field in the strip, outside the caller's role element.
 */
export function DetailRail({
  ariaLabel,
  className,
  header,
  role,
  filter,
  children,
}: {
  ariaLabel: string;
  className?: string;
  /** Rendered start-aligned in the strip of a rail that has NO filter (e.g. a
   *  file count), which owns the row's height — it must not grow past one short
   *  line. Not rendered with a filter. */
  header?: ReactNode;
  role?: AriaRole;
  /** The file filter, from `useFileListFilter`. Absent: no field, no rescue. */
  filter?: DetailRailFilter;
  children: ReactNode;
}) {
  const rowWidth = useContext(RailWidthContext);
  const registerFocusFilter = useContext(RailFocusFilterContext);
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const queryClient = useQueryClient();
  const panelActive = usePanelActive();
  const [transientExpand, setTransientExpand] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The expanded-ness a focus-carrying toggle asked for, or null when nothing is
  // pending: each branch renders a different button node, so without the move
  // focus drops to <body>. Armed on a committed flip, and on a rejected write's
  // rollback only while the rail holds focus AND the row is still wide (a narrow
  // rollback can't produce the transition the arm waits for). Every `expanded`
  // or `narrow` commit consumes the arm, so it can't linger to fire on a later
  // width crossing, pulling focus into a rail the user never touched.
  const refocus = useRef<boolean | null>(null);
  // "Focus the field once the expanding commit renders it": its own slot, never
  // a second meaning of `refocus`. Armed only by a "focus the filter" that
  // issued a flip; cleared by the caret, the rollback and the hide/unmount
  // cleanup; consumed by the same commits as `refocus`.
  // It holds the element focused at the press, and the field takes focus only
  // from that element or from <body> (the expansion removed it): a focus move
  // made before the expanding commit is the user's, and stays.
  const fieldClaim = useRef<Element | null>(null);
  // The last node inside the rail that took focus, for the rescue effect.
  const heldNode = useRef<HTMLElement | null>(null);
  const wasActive = useRef(filter?.active ?? false);

  const narrow = rowWidth !== null && rowWidth < RAIL_MIN_CONTAINER_PX;
  // Guarded state-during-render reset — React sanctions this over an effect,
  // which would paint one stale strip frame after the row regains room; same
  // idiom as ui/dialog.tsx and confirm-dialog-host.tsx.
  if (!narrow && transientExpand) setTransientExpand(false);
  const expanded = narrow
    ? transientExpand
    : !settings.data?.diffFileListCollapsed;

  // Rejected-write rollback as an effect event so `narrow` is read at rejection
  // time, not capture time: a rollback landing while the row is narrow can't
  // transition `expanded` (the strip is width-forced), so arming there would
  // leave a live arm for a later width crossing to fire as a focus steal.
  const rollbackCollapsePref = useEffectEvent(
    (previous: AppSettings, attempted: AppSettings) => {
      // Only roll back if this call's change is still the latest: otherwise a
      // late-failing earlier write would stomp a newer successful one.
      const latest = queryClient.getQueryData<AppSettings>(
        settingsKeys.settings,
      );
      if (latest?.diffFileListCollapsed !== attempted.diffFileListCollapsed)
        return;
      // Re-armed for the rollback's own commit, only while the rail still holds
      // focus — a user who has moved on must not have it stolen back. A field
      // claim dies here: the expand it waited for was just undone.
      fieldClaim.current = null;
      refocus.current =
        !narrow && railRef.current?.contains(document.activeElement)
          ? !previous.diffFileListCollapsed
          : null;
      queryClient.setQueryData(settingsKeys.settings, previous);
    },
  );

  // The persisted flip, shared by the caret and "focus the filter".
  const flipCollapsePref = (held: boolean) => {
    const current = settings.data;
    if (!current) return;
    const updated = {
      ...current,
      diffFileListCollapsed: !current.diffFileListCollapsed,
    };
    refocus.current = held ? current.diffFileListCollapsed : null;
    // Patch the cache before persisting: the rail has to flip in this commit so
    // the focus move lands on the button that replaced the one focus was on, and
    // so a second press reads the new value instead of re-issuing the old flip.
    queryClient.setQueryData(settingsKeys.settings, updated);
    void saveSettings
      .mutateAsync(updated)
      .catch(() => rollbackCollapsePref(current, updated));
  };

  const toggle = () => {
    const held = Boolean(railRef.current?.contains(document.activeElement));
    refocus.current = null;
    fieldClaim.current = null;
    if (narrow) {
      refocus.current = held ? !transientExpand : null;
      setTransientExpand((prev) => !prev);
      return;
    }
    flipCollapsePref(held);
  };
  // Only the visible tab's rail answers the action: <Activity> keeps hidden
  // panels mounted, and its effect teardown is deferred.
  useHotkeyAction("toggle-diff-file-list", toggle, panelActive);

  // Expanded: focus and select the field (a second press re-selects). Collapsed:
  // expand the way the caret would, and let the expanding commit focus it.
  const focusFilter = () => {
    if (expanded) {
      fieldRef.current?.focus();
      fieldRef.current?.select();
      return;
    }
    fieldClaim.current = document.activeElement ?? document.body;
    if (narrow) setTransientExpand(true);
    else flipCollapsePref(false);
  };
  const focusFilterRef = useLatestRef(focusFilter);
  const hasFilter = filter !== undefined;
  useLayoutEffect(() => {
    if (!hasFilter || registerFocusFilter === null) return;
    // An updater returning the function: a bare function argument would run.
    registerFocusFilter(() => () => focusFilterRef.current());
    return () => registerFocusFilter(null);
  }, [hasFilter, registerFocusFilter]);

  // Rides the commit that actually renders the new branch — a frame scheduled
  // from the handler could still beat react-query's notify-batched re-render.
  // `narrow` is a trigger, not a read: a ResizeObserver width update can batch
  // with the flip, leaving `expanded` still, and an arm left unconsumed there
  // would fire on the next widening instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `narrow` is the trigger — a width crossing must consume a pending arm even when `expanded` holds still.
  useLayoutEffect(() => {
    const claimed = fieldClaim.current;
    const pending = refocus.current;
    fieldClaim.current = null;
    refocus.current = null;
    if (claimed !== null && expanded) {
      const active = document.activeElement;
      if (active === document.body || active === claimed) {
        fieldRef.current?.focus();
        fieldRef.current?.select();
      }
      return;
    }
    if (pending === null) return;
    if (pending === expanded) toggleRef.current?.focus();
  }, [expanded, narrow]);

  // A hide or unmount drops what a later show would otherwise replay: effect
  // setups re-run on an <Activity> show. No other effect here may clear these
  // in its cleanup, which runs before that effect's next setup. The cleanup
  // runs before React removes the rail's DOM, so the field is still focused
  // then; the setup takes a same-scope handoff only when focus fell to <body>.
  const handoffScope = useLatestRef(filter?.scope ?? null);
  useLayoutEffect(() => {
    const scope = handoffScope.current;
    if (scope !== null && fieldHandoff === scope) {
      fieldHandoff = null;
      if (document.activeElement === document.body) {
        const field = fieldRef.current;
        if (field) {
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        } else toggleRef.current?.focus();
      }
    }
    return () => {
      fieldClaim.current = null;
      heldNode.current = null;
      const leaving = handoffScope.current;
      const field = fieldRef.current;
      if (
        leaving === null ||
        field === null ||
        document.activeElement !== field
      )
        return;
      fieldHandoff = leaving;
      queueMicrotask(() => {
        fieldHandoff = null;
      });
    };
  }, []);

  // Turning the filter off by any route brings the open row back into view;
  // change-only, so a mount or an <Activity> re-show scrolls nothing.
  useLayoutEffect(() => {
    const active = filter?.active ?? false;
    if (wasActive.current === active) return;
    wasActive.current = active;
    const path = filter?.openRowPath;
    if (active || !path) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  // A zero-file list keeps the caller's own list area: nothing is hidden there.
  const nothingMatches =
    filter !== undefined &&
    filter.active &&
    filter.matchCount === 0 &&
    filter.totalCount > 0;

  // A focused node the rail removed (a row the list dropped, the field on a
  // width collapse) or hid inside the list while nothing matches lands on the
  // field, else the caret. Only from <body> or that hidden node: a row action's
  // portalled menu or dialog keeps focus. Runs after the arm above.
  useLayoutEffect(() => {
    const node = heldNode.current;
    if (node === null) return;
    const hidden = node.isConnected;
    if (hidden && !(nothingMatches && listRef.current?.contains(node))) return;
    heldNode.current = null;
    const active = document.activeElement;
    if (
      !filter ||
      !panelActive ||
      (active !== document.body && !(hidden && active === node))
    )
      return;
    (fieldRef.current ?? toggleRef.current)?.focus();
  });

  const focusCapture = filter
    ? {
        onFocusCapture: (e: FocusEvent<HTMLElement>) => {
          // React bubbles focus through portals: a row action's menu or dialog
          // is not the rail.
          if (e.currentTarget.contains(e.target)) heldNode.current = e.target;
        },
        onBlurCapture: (e: FocusEvent<HTMLElement>) => {
          // A window deactivation blurs a node that stays the active element;
          // only a real focus move (the node no longer active) releases it.
          if (
            e.target === heldNode.current &&
            e.target.isConnected &&
            document.activeElement !== e.target
          )
            heldNode.current = null;
        },
      }
    : {};
  const claim = filter?.claimFocusFilter ? (
    <FocusFilterClaim run={focusFilter} />
  ) : null;

  if (!expanded) {
    const caretBox = (
      <div className="flex h-7 shrink-0 items-center">
        <Button
          ref={toggleRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded="false"
          aria-label="Expand file list"
          title="Expand file list"
          onClick={toggle}
        >
          <CaretRightIcon />
        </Button>
      </div>
    );
    const funnelLabel = filter
      ? `Show the file list (filter applied: ${filter.matchCount} of ${fileNoun(filter.totalCount)})`
      : "";
    return (
      <aside
        ref={railRef}
        aria-label={role ? LANDMARK_LABEL : ariaLabel}
        className={cn(
          "flex w-7 shrink-0 flex-col items-center border-r",
          className,
        )}
        {...focusCapture}
      >
        {claim}
        {/* Same box as the expanded header strip, so the button doesn't shift
            vertically as the rail toggles. */}
        {filter ? (
          <div className={cn("shrink-0", FILTER_BOX_Y)}>{caretBox}</div>
        ) : (
          caretBox
        )}
        {filter?.active ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={funnelLabel}
            title={funnelLabel}
            onClick={focusFilter}
          >
            <FunnelIcon weight="fill" className="text-primary" />
          </Button>
        ) : null}
      </aside>
    );
  }

  const collapseCaret = (
    <Button
      ref={toggleRef}
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-expanded="true"
      aria-label="Collapse file list"
      title="Collapse file list"
      onClick={toggle}
    >
      <CaretLeftIcon />
    </Button>
  );
  // The x and the empty state's button unmount as the text empties, so focus
  // moves to the field (the same node throughout) in the same handler.
  const clearFilter = () => {
    filter?.setText("");
    fieldRef.current?.focus();
  };
  const focusRow = (path: string) =>
    listRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
      ?.focus();
  const onFieldKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Bound chords (Go back's Alt+arrow) reach the window listener untouched.
    if (!filter || hasChordModifier(e)) return;
    if (e.key === "Enter") {
      // A held Enter that activated the x, `Clear filter` or the funnel repeats
      // into the field once they move focus here; a repeat picks nothing.
      if (e.nativeEvent.isComposing || e.repeat || filter.firstPath === null)
        return;
      e.preventDefault();
      filter.onPick(filter.firstPath);
      focusRow(filter.firstPath);
      return;
    }
    if (e.key === "ArrowDown") {
      // Shift+Arrow Down extends the text selection. While composing, WebKit
      // sends the real key, and Down walks the IME's candidates.
      if (e.shiftKey || e.nativeEvent.isComposing) return;
      const path = filter.openRowPath ?? filter.firstPath;
      if (path === null) return;
      e.preventDefault();
      if (filter.openRowPath === null) filter.onPick(path);
      focusRow(path);
      return;
    }
    if (e.key === "Escape") {
      // An empty field leaves Escape to whatever owns it next; while composing
      // it cancels the composition, not the filter. A held Escape's repeats are
      // swallowed whatever the text, so one hold never clears and then closes.
      if (e.nativeEvent.isComposing) return;
      if (e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (filter.text === "") return;
      e.preventDefault();
      e.stopPropagation();
      filter.setText("");
    }
  };

  return (
    <aside
      ref={railRef}
      aria-label={role ? LANDMARK_LABEL : ariaLabel}
      className={cn("flex w-72 shrink-0 flex-col border-r", className)}
      {...focusCapture}
    >
      {claim}
      {filter ? (
        // `pl-1` + the group's border + the input's `pl-[7px]` put the field's
        // text column on the rows' 12px inset; `pr-0.5` keeps the caret put.
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b pl-1 pr-0.5",
            FILTER_BOX_Y,
          )}
        >
          <InputGroup className="h-7 flex-1">
            <InputGroupInput
              ref={fieldRef}
              value={filter.text}
              onChange={(e) => filter.setText(e.target.value)}
              onKeyDown={onFieldKeyDown}
              placeholder="Filter"
              aria-label="Filter changed files"
              autoComplete="off"
              spellCheck={false}
              className="h-full pl-[7px]"
            />
            <InputGroupAddon align="inline-end" className="font-normal">
              <InputGroupText className="tabular-nums">
                {filter.active
                  ? `${filter.matchCount} of ${filter.totalCount}`
                  : fileNoun(filter.totalCount)}
              </InputGroupText>
              {filter.text !== "" ? (
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear filter"
                  title="Clear filter"
                  onClick={clearFilter}
                >
                  <XIcon />
                </InputGroupButton>
              ) : null}
            </InputGroupAddon>
          </InputGroup>
          {collapseCaret}
        </div>
      ) : (
        <div className="flex h-7 shrink-0 items-center justify-end gap-2 border-b px-0.5">
          {/* `pl-2.5` on top of the row's `px-0.5` puts the header's text column on
              the same 12px inset as the `px-3` rows below it. */}
          {header ? (
            <div className="mr-auto min-w-0 pl-2.5">{header}</div>
          ) : null}
          {collapseCaret}
        </div>
      )}
      {nothingMatches ? (
        <div className="px-2 py-8 text-center text-xs text-muted-foreground">
          <p>No files match the filter</p>
          <button
            type="button"
            onClick={clearFilter}
            className="mt-1 cursor-pointer font-medium underline underline-offset-2 hover:no-underline"
          >
            Clear filter
          </button>
        </div>
      ) : null}
      {/* The caller's role (e.g. listbox) belongs on the list itself — the
          strip above is not one of its options. Hidden, never unmounted, while
          nothing matches: a row action's open dialog lives in there. */}
      <div
        ref={listRef}
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          nothingMatches && "hidden",
        )}
        role={role}
        aria-label={role ? ariaLabel : undefined}
      >
        {children}
      </div>
    </aside>
  );
}

interface FilterStatusState {
  text: string;
  /** Whether the filter was active at the last settled render. */
  active: boolean;
  /** The list total at the last settled render. */
  total: number;
}

function nextFilterStatus(
  prev: FilterStatusState,
  filter: DetailRailFilter,
): FilterStatusState {
  const total = filter.totalCount;
  // The empty arms show no field, so a persisted text there announces nothing.
  if (total === 0) return { text: "", active: filter.active, total };
  if (filter.active) {
    return {
      text: `Showing ${filter.matchCount} of ${fileNoun(total)}`,
      active: true,
      total,
    };
  }
  if (prev.active) {
    return {
      text: total === 1 ? "Showing 1 file" : `Showing all ${total} files`,
      active: false,
      total,
    };
  }
  // At rest: a clear's text holds until the next filter, but only while its
  // count is still true; blanking a polite region announces nothing.
  if (prev.total === total) return prev;
  return { text: "", active: false, total };
}

/**
 * The filter's polite, visually hidden status. The consumer renders ONE, outside
 * every `aria-busy` element it renders itself (a busy region's updates may go
 * unannounced), mounted before any text arrives.
 */
export function DetailRailFilterStatus({
  filter,
  blank = false,
}: {
  filter: DetailRailFilter;
  /** The consumer's error arm is shown. The status empties and forgets the
   *  filter, so a list that settles later announces its counts once; other
   *  non-list arms keep the text, which the next settled list replaces. */
  blank?: boolean;
}) {
  const [status, setStatus] = useState<FilterStatusState>({
    text: "",
    active: false,
    total: 0,
  });
  // Guarded render-time adjustment, recomputed only on a settled list: a
  // placeholder's rows are another identity's, so its counts are never
  // announced, and an edge crossed meanwhile lands on the next settled render.
  // The guard compares every field, so the render after a store stores nothing.
  if (blank || filter.settled) {
    const next = blank
      ? { text: "", active: false, total: status.total }
      : nextFilterStatus(status, filter);
    if (
      next.text !== status.text ||
      next.active !== status.active ||
      next.total !== status.total
    )
      setStatus(next);
  }
  return (
    <span role="status" className="sr-only" data-file-filter-status="">
      {status.text}
    </span>
  );
}
