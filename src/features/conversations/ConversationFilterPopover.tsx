import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CheckIcon, FunnelIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
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
import { cn } from "@/lib/utils";

/** A filter row is an Author or a Label, carried as an OBJECT (never a
 *  prefixed string like `"author:x"`) so Base UI's default contains-filter,
 *  which we point at `.name` via `itemToStringLabel`, matches the display name
 *  only — a prefixed string would make typing "auth" match every author. */
type FilterItem = { kind: "author" | "label"; name: string };
/** A titled section of rows; the `value` is the group heading text. Empty
 *  groups are omitted before rendering so no header shows for a missing side. */
type FilterGroup = { value: string; items: FilterItem[] };

/**
 * The author/label filter popover shared by the PR and issue list panels: a
 * funnel trigger with an active-count badge over a searchable, height-bounded
 * combobox with Author/Label sections and per-row counts. Driven entirely by
 * `useLocalRemoteFilter`'s output.
 *
 * Rebuilt on the vendored Combobox stack (the branch-switcher pattern): the
 * `ComboboxContent`/`ComboboxList` cap their height and scroll internally, so a
 * repo with many authors can no longer overflow the window, and the input adds
 * the type-to-filter behavior. Selection is CONTROLLED off the parent's Sets —
 * `onValueChange` diffs the new array against them to emit `toggle` calls, so
 * the Sets stay the single source of truth (and drive each row's check).
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
}: {
  authors: string[];
  labels: string[];
  authorFilter: Set<string>;
  labelFilter: Set<string>;
  toggle: (which: "author" | "label", value: string, on: boolean) => void;
  activeFilterCount: number;
  authorCount: (a: string) => number;
  labelCount: (l: string) => number;
}) {
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

  // Grouped items with selected-first ordering (per the open-time snapshot),
  // otherwise preserving prop order via a stable partition. A side with no
  // entries is dropped so its header never renders; when both are empty we skip
  // the combobox entirely and show a single muted line below.
  const groups = useMemo<FilterGroup[]>(() => {
    const g: FilterGroup[] = [];
    const selectedFirst = (names: string[], snapshot: Set<string>) => {
      const chosen: string[] = [];
      const rest: string[] = [];
      for (const name of names) (snapshot.has(name) ? chosen : rest).push(name);
      return [...chosen, ...rest];
    };
    if (authors.length > 0)
      g.push({
        value: "Author",
        items: selectedFirst(authors, selectedSnapshot.authors).map((name) => ({
          kind: "author",
          name,
        })),
      });
    if (labels.length > 0)
      g.push({
        value: "Label",
        items: selectedFirst(labels, selectedSnapshot.labels).map((name) => ({
          kind: "label",
          name,
        })),
      });
    return g;
  }, [authors, labels, selectedSnapshot]);

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
              ? `Filter by author or label (${activeFilterCount} active)`
              : "Filter by author or label"
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
  const handleOpenChange = (next: boolean) => {
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

  // No data at all: keep a real popover, but skip the combobox machinery and
  // show a single muted line (replaces the old per-section empties). Rendered
  // via Combobox.Status so it lands in a polite live region — this branch has
  // no input for the popup to focus, so a plain <p> could go unannounced.
  if (groups.length === 0) {
    return (
      <ComboboxPrimitive.Root
        items={[]}
        open={open}
        // handleOpenChange (not bare setOpen): closing from THIS branch must
        // still reset the query, or a stale search pre-filters the list when
        // options return.
        onOpenChange={handleOpenChange}
      >
        {trigger}
        <ComboboxContent align="end" className="w-64 p-2">
          <ComboboxPrimitive.Status className="px-1 py-1 text-xs text-muted-foreground">
            No authors or labels to filter by.
          </ComboboxPrimitive.Status>
        </ComboboxContent>
      </ComboboxPrimitive.Root>
    );
  }

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
      // fields so the primitive can track selection across renders.
      isItemEqualToValue={(a, b) => a.kind === b.kind && a.name === b.name}
      onValueChange={(next) => {
        // Diff the new selection against the current Sets and emit exactly the
        // toggles that changed — the parent's Sets remain the source of truth.
        const nextAuthors = new Set<string>();
        const nextLabels = new Set<string>();
        for (const it of next)
          (it.kind === "author" ? nextAuthors : nextLabels).add(it.name);
        for (const name of authors) {
          const on = nextAuthors.has(name);
          if (on !== authorFilter.has(name)) toggle("author", name, on);
        }
        for (const name of labels) {
          const on = nextLabels.has(name);
          if (on !== labelFilter.has(name)) toggle("label", name, on);
        }
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
          would collapse the popup — w-64 gives it room. */}
      <ComboboxContent align="end" className="w-64">
        <ComboboxInput
          showTrigger={false}
          placeholder="Filter authors and labels…"
        />
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList>
          {(group: FilterGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: FilterItem) => (
                  <FilterRow
                    key={`${item.kind}:${item.name}`}
                    item={item}
                    checked={
                      item.kind === "author"
                        ? authorFilter.has(item.name)
                        : labelFilter.has(item.name)
                    }
                    count={
                      item.kind === "author"
                        ? authorCount(item.name)
                        : labelCount(item.name)
                    }
                  />
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  );
}

/** One combobox row, built from the RAW primitive `Item` (not the vendored
 *  `ComboboxItem`, which reserves `pr-8` for a right-side check we don't want
 *  here). Selection flows through the item itself; the leading box is a
 *  visual-only, `aria-hidden` check (mirrors the vendored Checkbox's look) so
 *  it doesn't announce a second control. */
function FilterRow({
  item,
  checked,
  count,
}: {
  item: FilterItem;
  checked: boolean;
  count: number;
}) {
  return (
    <ComboboxPrimitive.Item
      value={item}
      className="relative flex w-full cursor-default items-center gap-2 rounded-none py-1.5 pr-2 pl-2 text-xs outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
    >
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
      <span
        className="min-w-0 flex-1 truncate"
        // Expose the full name as a tooltip only when actually clipped —
        // measured just-in-time on hover, so no per-row refs.
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.title = el.scrollWidth > el.clientWidth ? item.name : "";
        }}
      >
        {item.name}
      </span>
      <span className="shrink-0 text-muted-foreground">({count})</span>
    </ComboboxPrimitive.Item>
  );
}
