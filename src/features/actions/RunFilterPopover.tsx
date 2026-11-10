import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { CheckIcon, FunnelIcon } from "@phosphor-icons/react";
import { type Ref, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
import type { ForgeProvider } from "@/lib/git/types";
import type { Workflow, WorkflowRun } from "@/lib/github/actions";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { cn } from "@/lib/utils";
import { statusFacetLabel } from "./RunFilterChips";
import {
  activeFacetCount,
  branchOptions,
  chipLabel,
  eventOptions,
  FACET_ORDER,
  FACET_SUPPORT,
  type FacetKind,
  type Facets,
  type FreeEntryVerdict,
  freeEntryVerdict,
  INVALID_FREE_ENTRY_TEXT,
  isDisabledWorkflow,
  STATUS_FACETS,
  sortWorkflows,
  UNSUPPORTED_FACET_NOTE,
} from "./run-filters";
import { isPipelineProvider } from "./status";

/** One popover row, carried as an object so the contains-filter reads its
 *  label only. `value` is what the facet sends; `free` rows name a typed value
 *  the loaded rows never offered. */
export type FacetItem = {
  kind: FacetKind;
  value: string;
  label: string;
  free?: boolean;
  disabled?: boolean;
};

type FacetGroup = { value: string; kind: FacetKind; items: FacetItem[] };

/** What the loaded rows suggest, captured when the popover opens: rows change
 *  under the poll, and a list reshuffling under the pointer loses the pick. */
type Seen = {
  events: string[];
  branches: string[];
  actors: { name: string; id: string }[];
};

const NO_SEEN: Seen = { events: [], branches: [], actors: [] };

function seenIn(runs: readonly WorkflowRun[]): Seen {
  const actors = new Map<string, string>();
  for (const r of runs) if (r.actor) actors.set(r.actor.id, r.actor.name);
  return {
    events: runs.map((r) => r.event),
    branches: runs.map((r) => r.headBranch),
    actors: [...actors].map(([id, name]) => ({ name, id })),
  };
}

const GROUP_LABEL: Record<FacetKind, string> = {
  workflow: "Workflow",
  event: "Event",
  status: "Status",
  branch: "Branch",
  actor: "Actor",
};

const FREE_ENTRY_LABEL: Partial<Record<FacetKind, (q: string) => string>> = {
  branch: (q) => `Filter by branch "${q}"`,
  actor: (q) => `Filter by actor "${q}"`,
};

/** Keyed on whether the provider runs pipelines, which offer no Workflow group. */
const INPUT_PLACEHOLDER: Record<"pipelines" | "workflows", string> = {
  workflows: "Filter by workflow, status, branch…",
  pipelines: "Filter by event, status, branch…",
};

/** Branch names are case-sensitive refs; logins and usernames are not. */
const FREE_TAKEN: Partial<
  Record<FacetKind, (q: string) => (item: FacetItem) => boolean>
> = {
  branch: (q) => (item) => item.value === q,
  actor: (q) => {
    const lower = q.toLowerCase();
    return (item) =>
      item.value.toLowerCase() === lower || item.label.toLowerCase() === lower;
  },
};

/** The item standing for each set facet, so the combobox's controlled value
 *  carries one entry per facet. "This branch" is the toggle's, never a row. */
function selectedItems(facets: Facets): FacetItem[] {
  const out: FacetItem[] = [];
  for (const kind of FACET_ORDER) {
    const value = facetValue(kind, facets);
    if (value) out.push({ kind, value, label: chipLabel(kind, facets).value });
  }
  return out;
}

function facetValue(kind: FacetKind, facets: Facets): string | undefined {
  switch (kind) {
    case "workflow":
      return facets.workflow ? String(facets.workflow.id) : undefined;
    case "branch":
      return facets.branch && "name" in facets.branch
        ? facets.branch.name
        : undefined;
    case "actor":
      return facets.actor?.id;
    default:
      return facets[kind];
  }
}

/** The slice of the workflows read the Workflow group shows. */
export interface WorkflowsRead {
  data: Workflow[] | undefined;
  isPending: boolean;
  isError: boolean;
}

export function RunFilterPopover({
  provider,
  facets,
  currentBranch,
  runs,
  workflows,
  disabledReason,
  paletteEnabled,
  triggerRef,
  onPick,
  onUnpick,
}: {
  provider: ForgeProvider | null | undefined;
  facets: Facets;
  currentBranch: string | null;
  /** Loaded rows to suggest values from; empty while they are a placeholder. */
  runs: readonly WorkflowRun[];
  workflows: WorkflowsRead;
  /** Set while the trigger is held; the popover never opens then. */
  disabledReason: string | undefined;
  paletteEnabled: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  onPick: (items: FacetItem[]) => void;
  /** A checked row pressed again: clears its facet, leaving focus in the popup. */
  onUnpick: (kinds: FacetKind[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [seen, setSeen] = useState<Seen>(NO_SEEN);
  const forge: ForgeProvider = provider ?? "github";
  const support = FACET_SUPPORT[forge];
  const pipelines = isPipelineProvider(provider);
  const query = inputValue.trim();
  const count = activeFacetCount(facets);

  const rowsFor = (k: FacetKind): FacetItem[] => {
    switch (k) {
      case "workflow":
        return sortWorkflows(workflows.data ?? []).map((w) => ({
          kind: k,
          value: String(w.id),
          label: w.name,
          disabled: isDisabledWorkflow(w.state),
        }));
      case "event":
        return eventOptions(forge, seen.events).map((e) => ({
          kind: k,
          value: e,
          label: e,
        }));
      case "status":
        return STATUS_FACETS[forge].map((s) => ({
          kind: k,
          value: s,
          label: statusFacetLabel(provider, s),
        }));
      case "branch":
        return branchOptions(currentBranch, seen.branches).map((b) => ({
          kind: k,
          value: b,
          label: b,
        }));
      case "actor":
        // GitLab's pipeline list carries no user, so it has nothing to suggest.
        return support.actor === "free"
          ? []
          : seen.actors.map((a) => ({ kind: k, value: a.id, label: a.name }));
    }
  };

  const groups: FacetGroup[] = [];
  // Typed values the free-entry rows can't take, by group, shown below the list.
  const refusedFree: {
    kind: FacetKind;
    verdict: Exclude<FreeEntryVerdict, "ok">;
  }[] = [];
  for (const k of FACET_ORDER) {
    if (support[k] === "none") continue;
    const items = rowsFor(k);
    const taken = FREE_TAKEN[k];
    if (query && taken && support[k].includes("free")) {
      const verdict = freeEntryVerdict(k, query);
      if (verdict !== "ok") refusedFree.push({ kind: k, verdict });
      else if (!items.some(taken(query)))
        items.push({ kind: k, value: query, label: query, free: true });
    }
    if (items.length > 0)
      groups.push({ value: GROUP_LABEL[k], kind: k, items });
  }

  const value = selectedItems(facets);

  const handleOpenChange = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
    if (next) setSeen(seenIn(runs));
    else setInputValue("");
  };

  // A controlled open highlights nothing, so the palette opens through Base
  // UI's own keyboard-activation click (detail 0, no pointer type).
  useHotkeyAction(
    "filter-runs",
    () => {
      const trigger = ownTrigger.current;
      if (!trigger) return;
      const click = () =>
        trigger.dispatchEvent(
          new PointerEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: 0,
          }),
        );
      click();
      // A press that ended off the trigger makes Base UI swallow one click.
      if (!openRef.current) click();
    },
    paletteEnabled && !disabledReason,
  );

  return (
    <ComboboxPrimitive.Root<FacetItem, true>
      items={groups}
      multiple
      value={value}
      open={open}
      onOpenChange={handleOpenChange}
      // Base UI clears the input on every pick in multiple mode, reported as a
      // plain input-change; the microtask in onValueChange restores the query.
      inputValue={inputValue}
      onInputValueChange={(next, details) => {
        if (
          details.reason !== "input-change" &&
          details.reason !== "input-clear"
        )
          return;
        setInputValue(next);
      }}
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.kind === b.kind && a.value === b.value}
      onValueChange={(next) => {
        // An addition sets its facet, replacing that facet's value. Base UI
        // drops a pressed checked row from `next`, which clears its facet.
        const same = (a: FacetItem) => (b: FacetItem) =>
          a.kind === b.kind && a.value === b.value;
        const added = next.filter((item) => !value.some(same(item)));
        const removed = value.filter(
          (v) => !next.some(same(v)) && !added.some((a) => a.kind === v.kind),
        );
        if (added.length > 0) onPick(added);
        if (removed.length > 0) onUnpick(removed.map((v) => v.kind));
        const q = inputValue;
        queueMicrotask(() => setInputValue(q));
      }}
    >
      {/* `disabled` rides the BUTTON, never the Trigger: a disabled Trigger
          leaves the tab order and takes its reason out of keyboard reach. */}
      <ComboboxPrimitive.Trigger
        render={
          <DisabledReasonButton
            ref={(node: HTMLButtonElement | null) => {
              ownTrigger.current = node;
              if (typeof triggerRef === "function") triggerRef(node);
              else if (triggerRef) triggerRef.current = node;
            }}
            variant="outline"
            size="icon-sm"
            aria-label={
              count > 0 ? `Filter runs, ${count} active` : "Filter runs"
            }
            disabled={!!disabledReason}
            reason={disabledReason}
            className="relative"
          />
        }
      >
        <FunnelIcon />
        {count > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center bg-primary text-[9px] font-medium text-primary-foreground tabular-nums"
          >
            {count}
          </span>
        )}
      </ComboboxPrimitive.Trigger>
      {/* Explicit width: the anchor is an icon button, so `--anchor-width`
          would collapse the popup. As a column, the static lines hold their
          size and the list absorbs what is left of the available height. */}
      <ComboboxContent align="end" className="flex w-64 flex-col">
        {pipelines && provider && provider !== "github" && (
          <p className="shrink-0 px-3 py-2 text-[11px] text-muted-foreground">
            {UNSUPPORTED_FACET_NOTE(provider)}
          </p>
        )}
        <ComboboxInput
          className="shrink-0"
          showTrigger={false}
          placeholder={INPUT_PLACEHOLDER[pipelines ? "pipelines" : "workflows"]}
        />
        {/* A group with no rows is dropped from the list, so the Workflow
            group's read states sit above it as plain lines. */}
        {support.workflow !== "none" && workflows.data === undefined && (
          <p className="shrink-0 px-3 py-1.5 text-[11px] text-muted-foreground">
            {workflows.isError
              ? "Couldn't load workflows."
              : "Loading workflows…"}
          </p>
        )}
        <ComboboxEmpty>No matches</ComboboxEmpty>
        <ComboboxList className="max-h-none min-h-0 flex-1">
          {(group: FacetGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: FacetItem) => (
                  <FacetRow
                    key={`${item.kind}:${item.free ? "free:" : ""}${item.value}`}
                    item={item}
                    checked={facetValue(item.kind, facets) === item.value}
                  />
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {refusedFree.map(({ kind: k, verdict }) => (
          <p
            key={k}
            className="flex shrink-0 gap-1 px-3 py-1.5 text-[11px] text-muted-foreground"
          >
            <span className="font-medium">{GROUP_LABEL[k]}</span>
            <span>{INVALID_FREE_ENTRY_TEXT[verdict]}</span>
          </p>
        ))}
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  );
}

/** The leading box: a visual-only check, so it never announces a second
 *  control beside its row. */
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

function FacetRow({ item, checked }: { item: FacetItem; checked: boolean }) {
  const free = item.free ? FREE_ENTRY_LABEL[item.kind] : undefined;
  const label = free ? free(item.value) : item.label;
  return (
    <ComboboxPrimitive.Item
      value={item}
      // Base UI activates on keydown with no repeat check, so a key still
      // held from opening the popover would pick the highlighted row.
      onKeyDown={(e) => {
        if (e.repeat && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          e.preventBaseUIHandler();
        }
      }}
      className="relative flex w-full cursor-default items-center gap-2 rounded-none py-1.5 pr-2 pl-2 text-xs outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-highlighted:**:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0"
    >
      <CheckBox checked={checked} />
      <span className="min-w-0 flex-1 truncate" onMouseEnter={clipTitle(label)}>
        {label}
      </span>
      {item.disabled && (
        <span className="shrink-0 text-muted-foreground">disabled</span>
      )}
    </ComboboxPrimitive.Item>
  );
}
