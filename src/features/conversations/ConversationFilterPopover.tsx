import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CheckIcon, FunnelIcon, XIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox";
import { clipTitle } from "@/lib/clip-title";
import type { TeamRef } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import type { AxisCap } from "./useRemoteListFilter";

/** A filter row is an Author or a Label, carried as an OBJECT (never a
 *  prefixed string like `"author:x"`) so Base UI's default contains-filter,
 *  which we point at `.name` via `itemToStringLabel`, matches the display name
 *  only — a prefixed string would make typing "auth" match every author.
 *  `free` rows carry a name the page never offered (see FREE_ENTRY_LABEL). */
type FilterItem = { kind: "author" | "label"; name: string; free?: boolean };
/** A titled section of rows; the `value` is the group heading text. Empty
 *  groups are omitted before rendering so no header shows for a missing side. */
type FilterGroup = {
  value: string;
  kind: FilterItem["kind"];
  items: FilterItem[];
};

/** The free-entry row's copy: the server filters by any name, not only the ones
 *  this page happened to load. */
const FREE_ENTRY_LABEL: Record<FilterItem["kind"], (q: string) => string> = {
  author: (q) => `Filter by author "${q}"`,
  label: (q) => `Filter by label "${q}"`,
};

/** One static checkbox row in the popover's Mine / My review groups. */
export interface FilterToggleRow {
  key: string;
  label: string;
  checked: boolean;
  onToggle: (on: boolean) => void;
}

/** The "My teams" inline chooser: chips for the chosen teams over a disclosure
 *  listing the viewer's memberships. */
export interface TeamChooser {
  /** Org-qualified slugs the user picked — stale ones included, flagged below. */
  chosen: string[];
  options: TeamRef[];
  /** The membership query hasn't answered — `options` is unknown, not empty. */
  pending: boolean;
  name: (slug: string) => string;
  isStale: (slug: string) => boolean;
  onToggle: (slug: string, on: boolean) => void;
  /** Why the chooser is held (provider can't express team review requests). */
  disabledReason?: string | null;
  /** A muted explanation under the row — a missing token scope, a failed load. */
  note?: string | null;
  /** Hover text for the note (e.g. the exact command to run). */
  noteTitle?: string;
}

/** A titled group of static toggle rows, with one reason covering the group when
 *  the provider can't express the axis at all. */
export interface StaticFilterGroup {
  label: string;
  rows: FilterToggleRow[];
  disabledReason?: string | null;
}

/**
 * The filter popover shared by the PR and issue list panels: a funnel trigger
 * with an active-count badge over a static region (the whole-repo "mine" axes and
 * the review-state grouping toggle) and a searchable, height-bounded combobox with
 * Author/Label sections and per-row counts.
 *
 * Built on the vendored Combobox stack (the branch-switcher pattern): the
 * `ComboboxContent`/`ComboboxList` cap their height and scroll internally, so a
 * repo with many authors can no longer overflow the window, and the input adds
 * the type-to-filter behavior. Author/label selection is CONTROLLED off the
 * parent's Sets — `onValueChange` diffs the new array against them to emit
 * `toggle` calls, so the Sets stay the single source of truth (and drive each
 * row's check). The static rows deliberately sit OUTSIDE that machinery: they are
 * real `role="checkbox"` buttons, not combobox items, so typing never filters them
 * away and Base UI's selection model never sees them.
 */
export function ConversationFilterPopover({
  authors,
  labels,
  authorFilter,
  labelFilter,
  toggle,
  activeFilterCount,
  authorCount,
  labelCount,
  mine,
  review,
  authorReason,
  axisCap,
}: {
  authors: string[];
  labels: string[];
  authorFilter: Set<string>;
  labelFilter: Set<string>;
  toggle: (which: "author" | "label", value: string, on: boolean) => void;
  activeFilterCount: number;
  authorCount: (a: string) => number;
  labelCount: (l: string) => number;
  /** The whole-repo "mine" axes. Omit and the group doesn't render. */
  mine?: StaticFilterGroup & { teams?: TeamChooser };
  /** The review-state grouping toggle (pull requests only). */
  review?: StaticFilterGroup;
  /** Why the provider can't filter by author. Set, the Author rows and the author
   *  free-entry row render disabled with it — the names still show, so the list
   *  says what it can't do instead of quietly dropping a whole axis. */
  authorReason?: string | null;
  /** Ceiling on selections per axis, where the provider's filter fan-out has one.
   *  Omit and selection is unbounded. */
  axisCap?: AxisCap;
}) {
  const authorReasonId = useId();
  const capReasonId = useId();
  const [open, setOpen] = useState(false);
  // Controlled input so a selection doesn't wipe the query (Base UI clears the
  // input on item-press in multiple mode — see onInputValueChange below).
  const [inputValue, setInputValue] = useState("");
  // The selected names snapshotted when the popover OPENS. Selected-first
  // ordering sorts against THIS, not the live Sets, so toggling a row mid-open
  // doesn't yank rows around under the pointer; refreshed on each open.
  const [selectedSnapshot, setSelectedSnapshot] = useState<{
    authors: Set<string>;
    labels: Set<string>;
  }>({ authors: new Set(), labels: new Set() });

  const query = inputValue.trim();

  // Grouped items with selected-first ordering (per the open-time snapshot),
  // otherwise preserving prop order via a stable partition. A side with no
  // entries and no free-entry row is dropped so its header never renders.
  const groups = useMemo<FilterGroup[]>(() => {
    const g: FilterGroup[] = [];
    const selectedFirst = (names: string[], snapshot: Set<string>) => {
      const chosen: string[] = [];
      const rest: string[] = [];
      for (const name of names) (snapshot.has(name) ? chosen : rest).push(name);
      return [...chosen, ...rest];
    };
    // A query with no EXACT match on a side offers it as a free entry: the server
    // filters by any author or label, so the page's own vocabulary isn't the limit.
    // Exact, not substring — "bob" is a real login that "bobby" would otherwise
    // hide, leaving no way to reach it. Base UI's contains-filter keeps the row
    // visible because its `name` IS the query.
    const addGroup = (
      value: string,
      kind: FilterItem["kind"],
      names: string[],
      snapshot: Set<string>,
    ) => {
      // The suppression's case rule mirrors the server's matching per axis:
      // usernames are case-insensitive, but GitLab labels are case-SENSITIVE —
      // folding labels would make a case-distinct label (`bug` under a loaded
      // `Bug`) unreachable via free entry.
      const lower = query.toLowerCase();
      const taken =
        kind === "label"
          ? (n: string) => n === query
          : (n: string) => n.toLowerCase() === lower;
      const items: FilterItem[] = selectedFirst(names, snapshot).map(
        (name) => ({ kind, name }),
      );
      if (query && !names.some(taken))
        items.push({ kind, name: query, free: true });
      if (items.length > 0) g.push({ value, kind, items });
    };
    addGroup("Author", "author", authors, selectedSnapshot.authors);
    addGroup("Label", "label", labels, selectedSnapshot.labels);
    return g;
  }, [authors, labels, selectedSnapshot, query]);

  // Controlled selection derived from the parent's Sets (the source of truth).
  // Fresh objects each render — Base UI compares them with `isItemEqualToValue`
  // below, not by reference.
  const value = useMemo<FilterItem[]>(() => {
    const selected: FilterItem[] = [];
    for (const name of authors)
      if (authorFilter.has(name)) selected.push({ kind: "author", name });
    for (const name of labels)
      if (labelFilter.has(name)) selected.push({ kind: "label", name });
    return selected;
  }, [authors, labels, authorFilter, labelFilter]);

  const trigger = (
    <ComboboxPrimitive.Trigger
      render={
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={
            activeFilterCount > 0
              ? `Filters (${activeFilterCount} active)`
              : "Filters"
          }
          className="relative"
        />
      }
    >
      <FunnelIcon />
      {activeFilterCount > 0 && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center bg-primary text-[9px] font-medium text-primary-foreground tabular-nums"
        >
          {activeFilterCount}
        </span>
      )}
    </ComboboxPrimitive.Trigger>
  );

  // Capture the selected names when the popover opens so selected-first ordering
  // is stable for the whole open session; clear the query on close.
  const handleOpenChange = (
    next: boolean,
    details: ComboboxPrimitive.Root.ChangeEventDetails,
  ) => {
    // Refuse focus-driven closes. The static rows aren't part of Base UI's managed
    // focus, so activating one from the keyboard reads to it as focus leaving the
    // combobox and unmounts the popup mid-toggle (measured: Space on a focused row
    // closed the popover; the same row clicked did not). Cancelling here runs
    // BEFORE Base UI commits the close (AriaCombobox checks `isCanceled` right
    // after calling this), and the deliberate exits keep their own reasons —
    // Escape, an outside press, and the trigger all still close.
    if (!next && details.reason === "focus-out") {
      details.cancel();
      return;
    }
    setOpen(next);
    if (next) {
      setSelectedSnapshot({
        authors: new Set(authorFilter),
        labels: new Set(labelFilter),
      });
    } else {
      setInputValue("");
    }
  };

  return (
    <ComboboxPrimitive.Root<FilterItem, true>
      items={groups}
      multiple
      value={value}
      open={open}
      onOpenChange={handleOpenChange}
      // Controlled input: preserve the query across selections. Base UI clears
      // the input on selection in multiple mode (a chips convention — we have
      // no chips); GitHub/Linear filter menus keep the query. Live-tested: the
      // clear does NOT report `item-press` — it arrives as a plain
      // input-change, indistinguishable from typing, so reason filtering alone
      // can't stop it (the allowlist below still swallows non-typing reasons
      // as a second line of defense). The load-bearing fix is the microtask
      // restore in onValueChange. Close resets the query via handleOpenChange.
      inputValue={inputValue}
      onInputValueChange={(next, details) => {
        if (
          details.reason !== "input-change" &&
          details.reason !== "input-clear"
        )
          return;
        setInputValue(next);
      }}
      // Filter matches the display name only (see FilterItem note).
      itemToStringLabel={(item) => item.name}
      // Controlled value objects are rebuilt each render; compare by identity
      // fields so the primitive can track selection across renders. `free` is
      // deliberately not compared — a free row names the value it would add.
      isItemEqualToValue={(a, b) => a.kind === b.kind && a.name === b.name}
      onValueChange={(next) => {
        // Diff the new selection against the current Sets and emit exactly the
        // toggles that changed — the parent's Sets remain the source of truth.
        const nextAuthors = new Set<string>();
        const nextLabels = new Set<string>();
        for (const it of next)
          (it.kind === "author" ? nextAuthors : nextLabels).add(it.name);
        // The candidate set spans the offered options AND the incoming names:
        // a free-entry row names a value absent from `authors`/`labels`, so
        // walking the option lists alone would silently drop it.
        emitToggles("author", authors, nextAuthors, authorFilter, toggle);
        emitToggles("label", labels, nextLabels, labelFilter, toggle);
        // Re-assert the query after Base UI's selection-clear (see the
        // controlled-input comment above). This closure reads the render-time
        // inputValue — still the pre-clear query even if the clear's setState
        // was batched first — and the microtask lands after the clear settles
        // in the same task, before paint, so the input never flickers empty.
        const q = inputValue;
        queueMicrotask(() => setInputValue(q));
      }}
    >
      {trigger}
      {/* Explicit width: the anchor is a tiny icon button, so `--anchor-width`
          would collapse the popup — w-64 gives it room.
          `flex flex-col` is the CALL SITE's job: the vendored popup caps itself at
          `--available-height` and clips with overflow-hidden, while its list caps at
          available-height minus one input — a budget that can't know this call site
          added static sections above it. Left alone, a short window clips the
          author/label tail past the list's own scroll end. As a column, the static
          region holds its size and the list absorbs whatever is left. */}
      <ComboboxContent
        align="end"
        className="flex w-64 flex-col"
        onKeyDown={cycleTabWithinPopup}
      >
        {mine && (
          <StaticSection group={mine}>
            {mine.teams && (
              <TeamsRow
                teams={mine.teams}
                inheritedReason={mine.disabledReason ?? null}
              />
            )}
          </StaticSection>
        )}
        {review && <StaticSection group={review} />}
        <ComboboxInput
          className="shrink-0"
          showTrigger={false}
          placeholder="Filter authors and labels…"
        />
        {groups.length === 0 ? (
          // Rendered via Combobox.Status so it lands in a polite live region.
          <ComboboxPrimitive.Status className="px-3 py-2 text-xs text-muted-foreground">
            No authors or labels to filter by — type a name to filter anyway.
          </ComboboxPrimitive.Status>
        ) : (
          <>
            <ComboboxEmpty>No matches</ComboboxEmpty>
            {/* `max-h-none` drops the vendored available-height budget (it counts
                only the input) and hands sizing to the flex column above; the
                list keeps its own overflow-y-auto, so it still scrolls. */}
            <ComboboxList className="max-h-none min-h-0 flex-1">
              {(group: FilterGroup) => {
                const blockedAxis = group.kind === "author" && !!authorReason;
                // Capped at SELECTION time, never only where the server complains:
                // with a "mine" axis on, this provider applies authors/labels
                // client-side and the ceiling is slack, so an over-cap set would sit
                // unnoticed until Mine is toggled off and promotes it into the
                // server group — the request would then fail as a whole.
                const capReached =
                  axisCap != null &&
                  (group.kind === "author"
                    ? authorFilter.size
                    : labelFilter.size) >= axisCap.max;
                const groupCapId = `${capReasonId}-${group.kind}`;
                // Whichever reason a held row in THIS group points at.
                const heldReasonId = blockedAxis ? authorReasonId : groupCapId;
                return (
                  <ComboboxGroup key={group.value} items={group.items}>
                    <ComboboxLabel>{group.value}</ComboboxLabel>
                    {blockedAxis && (
                      <p
                        id={authorReasonId}
                        className="px-2 pb-1 text-[11px] text-muted-foreground"
                      >
                        {authorReason}
                      </p>
                    )}
                    {!blockedAxis && capReached && axisCap && (
                      <p
                        id={groupCapId}
                        className="px-2 pb-1 text-[11px] text-muted-foreground"
                      >
                        {axisCap.reason}
                      </p>
                    )}
                    <ComboboxCollection>
                      {(item: FilterItem) => {
                        const checked =
                          item.kind === "author"
                            ? authorFilter.has(item.name)
                            : labelFilter.has(item.name);
                        // A SELECTED row stays live under either hold: an enabled
                        // checked row can only ever remove a constraint, while
                        // disabling it would strand the pick — no way back under the
                        // cap, and no way to clear an author picked before the forge
                        // went unready. Only adding is blocked.
                        const disabled =
                          (blockedAxis || capReached) && !checked;
                        return (
                          <FilterRow
                            key={`${item.kind}:${item.free ? "free:" : ""}${item.name}`}
                            item={item}
                            checked={checked}
                            count={
                              item.kind === "author"
                                ? authorCount(item.name)
                                : labelCount(item.name)
                            }
                            disabled={disabled}
                            describedBy={disabled ? heldReasonId : undefined}
                          />
                        );
                      }}
                    </ComboboxCollection>
                  </ComboboxGroup>
                );
              }}
            </ComboboxList>
          </>
        )}
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  );
}

/** Emit one `toggle` per name whose membership changed, over the union of the
 *  offered options and the incoming selection. */
function emitToggles(
  kind: "author" | "label",
  offered: string[],
  next: Set<string>,
  current: Set<string>,
  toggle: (which: "author" | "label", value: string, on: boolean) => void,
) {
  for (const name of new Set([...offered, ...next])) {
    const on = next.has(name);
    if (on !== current.has(name)) toggle(kind, name, on);
  }
}

/** The leading box: a visual-only, `aria-hidden` check mirroring the vendored
 *  Checkbox's look, so it never announces a second control beside its row. */
function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-none border border-input transition-colors dark:bg-input/30",
        checked &&
          "border-primary bg-primary text-primary-foreground dark:bg-primary",
      )}
    >
      {checked && <CheckIcon className="size-3.5" />}
    </span>
  );
}

/** Space and Enter belong to the focused row, not the combobox behind it — a
 *  native `<button>` already activates on both, so only the bubble is stopped.
 *  Mounted on keydown AND keyup: a button's Space activation completes on keyup,
 *  so stopping only the keydown leaves half the sequence reaching the combobox. */
function keepActivationLocal(e: KeyboardEvent<HTMLElement>) {
  if (e.key === " " || e.key === "Enter") e.stopPropagation();
}

/** Marks a control as a stop in the popup's Tab cycle. The search input is found
 *  by tag instead, so nothing depends on props reaching through the vendored
 *  `ComboboxInput`. */
const TAB_STOP = '[data-tabstop="filter"]:not([disabled])';

/**
 * Holds focus on a control across the re-render its own keyboard activation
 * causes. Two constraints shape it: the toggle writes through react-query, whose
 * notify-batched re-render can land AFTER an rAF scheduled from the handler (so
 * the pending element is consumed in a layout effect keyed on the value that
 * flipped, the repo's pending-ref idiom), and Base UI drives this combobox with a
 * VIRTUAL list navigation that keeps DOM focus on the input — hence the one rAF
 * inside the effect, which only re-asserts a still-connected element that
 * something else took focus from.
 *
 * Assign the element to the returned ref from a keyboard handler; pointer
 * activation deliberately never arms it, leaving pointer behavior untouched.
 */
function useRefocusAfterToggle(flipped: unknown) {
  const pending = useRef<HTMLElement | null>(null);
  const seen = useRef(flipped);
  useLayoutEffect(() => {
    // Act on a real change of the watched value, never on a bare effect re-run:
    // a refused write (prefs not yet resolved) leaves it equal, and focus should
    // then stay exactly where the browser left it.
    if (seen.current === flipped) return;
    seen.current = flipped;
    const el = pending.current;
    if (!el) return;
    pending.current = null;
    el.focus();
    const frame = requestAnimationFrame(() => {
      if (el.isConnected && document.activeElement !== el) el.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [flipped]);
  return pending;
}

/**
 * Keeps Tab inside the open popover. The popup is PORTALED, so native tabbing out
 * of its input resumes at the TRIGGER's document position and walks the page
 * behind it — measured: six hops reached the panel's own search box and list rows
 * without ever landing on a static row, while the popup stayed open. Base UI
 * manages only the input and its listbox (through `aria-activedescendant`), so
 * this cycle over [static rows…, input] is ours to own. Deliberately a scoped
 * trap: Escape still closes the popover from anywhere inside, arrow keys still
 * drive the option list, and pointer behavior is untouched.
 */
function cycleTabWithinPopup(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "Tab") return;
  const popup = e.currentTarget;
  // Document order, which puts the static rows ahead of the input — so Tab from
  // the input wraps forward onto the first row and Shift+Tab onto the last.
  const stops: HTMLElement[] = [
    ...popup.querySelectorAll<HTMLElement>(TAB_STOP),
  ];
  const input = popup.querySelector<HTMLInputElement>(
    'input:not([type="hidden"])',
  );
  if (input) stops.push(input);
  // Fewer than two stops is nothing to cycle between — leave native Tab alone.
  if (stops.length < 2) return;
  const from = stops.indexOf(document.activeElement as HTMLElement);
  const step = e.shiftKey ? -1 : 1;
  e.preventDefault();
  stops[from === -1 ? 0 : (from + step + stops.length) % stops.length]?.focus();
}

/** A titled group of static toggle rows above the search input. One reason covers
 *  the whole group: it renders once, visibly (and `aria-hidden`, since every row
 *  already carries it as its accessible description). */
function StaticSection({
  group,
  children,
}: {
  group: StaticFilterGroup;
  children?: ReactNode;
}) {
  const reason = group.disabledReason ?? null;
  const captionId = useId();
  return (
    // role="group" + aria-labelledby: the caption is what tells a row apart from
    // its twin in the other section ("Assigned to me" under Mine), and a styled
    // <p> alone names nothing for assistive tech.
    <div
      role="group"
      aria-labelledby={captionId}
      // shrink-0: this region keeps its height in the popup's flex column so the
      // combobox list below absorbs the shortfall instead of being clipped.
      className="shrink-0 border-b pt-1 pb-1.5"
    >
      <p id={captionId} className="px-3 py-2 text-xs text-muted-foreground">
        {group.label}
      </p>
      {group.rows.map((row) => (
        <ToggleRow key={row.key} row={row} reason={reason} />
      ))}
      {children}
      {reason && (
        <p
          aria-hidden
          className="px-3 pt-1 pl-9 text-[11px] text-muted-foreground"
        >
          {reason}
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  row,
  reason,
}: {
  row: FilterToggleRow;
  reason: string | null;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: !!reason,
      reason,
      onClick: () => row.onToggle(!row.checked),
    });
  const refocus = useRefocusAfterToggle(row.checked);
  return (
    <span className="block" title={wrapperTitle}>
      <button
        type="button"
        role="checkbox"
        aria-checked={row.checked}
        aria-describedby={describedBy}
        data-tabstop="filter"
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter")
            refocus.current = e.currentTarget;
          keepActivationLocal(e);
        }}
        onKeyUp={keepActivationLocal}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
          ARIA_DISABLED_CLASS,
        )}
        {...nativeProps}
      >
        <CheckBox checked={row.checked} />
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
      </button>
      {blockedReason && (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      )}
    </span>
  );
}

/** "My teams": the chosen teams as chips, over a disclosure that lists the
 *  viewer's memberships as checkbox rows. A chip the membership query no longer
 *  vouches for is flagged in words — it is also excluded from the query itself,
 *  since the forge answers an unknown team with a silent zero rows. */
function TeamsRow({
  teams,
  inheritedReason,
}: {
  teams: TeamChooser;
  inheritedReason: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const reason = teams.disabledReason ?? inheritedReason;
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: !!reason,
      reason,
      onClick: () => setExpanded((v) => !v),
    });
  /**
   * Arrow-key nav over the chooser rows (the repo's same-change list invariant).
   * `activeIndex` is read from the row that actually HAS focus, not from state:
   * focus is this list's only notion of position, and the popup's Tab cycle, a
   * pointer press, and the post-toggle refocus all move it without passing
   * through here — a mirrored index would answer from wherever the last arrow
   * left it. Nothing to store, so `onActivate` is empty; the helper still moves
   * focus and scrolls the row into view off `rowKey`.
   */
  const onOptionsKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const focused = document.activeElement;
    const slug =
      focused instanceof HTMLElement ? focused.dataset.row : undefined;
    listKeyboardNav({
      items: teams.options,
      activeIndex: teams.options.findIndex((team) => team.slug === slug),
      onActivate: () => {
        // Intentionally empty: focus is the position, and `rowKey` moves it.
      },
      rowKey: (team) => team.slug,
    })(e);
  };
  // Every team toggle changes the chosen count, so one key covers both paths: an
  // option row survives its own toggle and takes focus back, while a removed chip
  // is gone by the next commit — that one hands focus to the disclosure button
  // instead, so focus never lands on <body> and out of the Tab cycle's reach.
  const chooseRef = useRef<HTMLButtonElement>(null);
  const refocus = useRefocusAfterToggle(teams.chosen.length);
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs">My teams</span>
        <span title={wrapperTitle}>
          <button
            ref={chooseRef}
            type="button"
            aria-expanded={expanded}
            aria-describedby={describedBy}
            data-tabstop="filter"
            onKeyDown={keepActivationLocal}
            onKeyUp={keepActivationLocal}
            className={cn(
              "cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
              ARIA_DISABLED_CLASS,
            )}
            {...nativeProps}
          >
            {expanded ? "Done" : "Choose…"}
          </button>
        </span>
        {blockedReason && (
          <span id={reasonId} className="sr-only">
            {blockedReason}
          </span>
        )}
      </div>
      {teams.chosen.length > 0 && (
        // Bounded like the options list below, and for the same reason: this strip
        // sits in the popup's shrink-0 static region, so an uncapped wrap of many
        // chips pushes the search input and Author/Label groups past the popup's
        // overflow-hidden edge, where no scroller can reach them.
        <ul className="mt-1 flex max-h-16 flex-wrap gap-1 overflow-y-auto overscroll-contain">
          {teams.chosen.map((slug) => (
            <li
              key={slug}
              className="flex max-w-full items-center gap-1 bg-muted px-1.5 py-px text-[11px]"
            >
              {/* Static title, no clipTitle: the org-qualified slug disambiguates
                  two same-named teams whether or not the name is clipped, and
                  clipTitle's not-clipped branch REMOVES the attribute for good. */}
              <span className="min-w-0 truncate" title={slug}>
                {teams.name(slug)}
              </span>
              {teams.isStale(slug) && (
                <span className="shrink-0 text-muted-foreground">
                  (no longer your team)
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${teams.name(slug)}`}
                data-tabstop="filter"
                onClick={() => teams.onToggle(slug, false)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter")
                    refocus.current = chooseRef.current;
                  keepActivationLocal(e);
                }}
                onKeyUp={keepActivationLocal}
                className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {expanded &&
        (() => {
          // An unanswered membership query must not claim an empty membership —
          // the two read identically in `options` and only one is a fact.
          if (teams.pending) {
            return (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Loading your teams…
              </p>
            );
          }
          if (teams.options.length === 0) {
            // A note below carries the reason membership is unreadable; "no teams"
            // over it asserts as fact the one thing that couldn't be checked. Keyed
            // on the note, not a cause — error and missing scope share the trap.
            if (teams.note) return null;
            return (
              <p className="mt-1 text-[11px] text-muted-foreground">
                No teams to choose from.
              </p>
            );
          }
          return (
            // Bounded like the combobox list below it: this region sits OUTSIDE
            // that scroller, and the popup clips with overflow-hidden, so a viewer
            // in many teams would push the later teams and the Author/Label groups
            // past the clip with nothing able to scroll them back. `overscroll-contain`
            // keeps a wheel at either end from chaining out to the popup.
            <ul
              className="mt-1 max-h-40 overflow-y-auto overscroll-contain"
              onKeyDown={onOptionsKeyDown}
            >
              {teams.options.map((team) => {
                const checked = teams.chosen.includes(team.slug);
                return (
                  <li key={team.slug}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      data-row={team.slug}
                      data-tabstop="filter"
                      // Arrows are deliberately NOT handled here — they bubble to
                      // the list's own handler, which owns focus movement.
                      onKeyDown={(e) => {
                        if (e.key === " " || e.key === "Enter")
                          refocus.current = e.currentTarget;
                        keepActivationLocal(e);
                      }}
                      onKeyUp={keepActivationLocal}
                      onClick={() => teams.onToggle(team.slug, !checked)}
                      className="flex w-full cursor-pointer items-center gap-2 py-1 text-left text-[11px] hover:text-foreground"
                    >
                      <CheckBox checked={checked} />
                      {/* Static title (the org-qualified slug), never clipTitle —
                          it disambiguates same-named teams regardless of clipping. */}
                      <span
                        className="min-w-0 flex-1 truncate"
                        title={team.slug}
                      >
                        {team.name}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          );
        })()}
      {teams.note && (
        <p
          className="mt-1 text-[11px] text-muted-foreground"
          title={teams.noteTitle}
        >
          {teams.note}
        </p>
      )}
    </div>
  );
}

/** One combobox row, built from the RAW primitive `Item` (not the vendored
 *  `ComboboxItem`, which reserves `pr-8` for a right-side check we don't want
 *  here). Selection flows through the item itself; the leading box is a
 *  visual-only, `aria-hidden` check. A free-entry row names the value it would
 *  add instead of a count — the page has no rows to count for it. */
function FilterRow({
  item,
  checked,
  count,
  disabled,
  describedBy,
}: {
  item: FilterItem;
  checked: boolean;
  count: number;
  disabled?: boolean;
  describedBy?: string;
}) {
  const label = item.free ? FREE_ENTRY_LABEL[item.kind](item.name) : item.name;
  return (
    <ComboboxPrimitive.Item
      value={item}
      disabled={disabled}
      aria-describedby={describedBy}
      className="relative flex w-full cursor-default items-center gap-2 rounded-none py-1.5 pr-2 pl-2 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
    >
      <CheckBox checked={checked} />
      <span className="min-w-0 flex-1 truncate" onMouseEnter={clipTitle(label)}>
        {label}
      </span>
      {!item.free && (
        <span className="shrink-0 text-muted-foreground">({count})</span>
      )}
    </ComboboxPrimitive.Item>
  );
}
