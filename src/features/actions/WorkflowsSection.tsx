import {
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
} from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import { clipTitle } from "@/lib/clip-title";
import type { Workflow, WorkflowRun } from "@/lib/github/actions";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";
import { isDisabledWorkflow, sortWorkflows } from "./run-filters";
import { StatusIcon, statusLabel } from "./status";

/** Workflow rows shown before "Show all (N)". */
const WORKFLOW_ROW_CAP = 6;

/** How many animation frames a palette toggle waits for the palette to unmount. */
const PALETTE_RESTORE_FRAMES = 120;

type Row =
  | { kind: "all" }
  | { kind: "workflow"; workflow: Workflow }
  | { kind: "show-all"; total: number };

function rowKey(row: Row): string {
  switch (row.kind) {
    case "workflow":
      return `wf-${row.workflow.id}`;
    default:
      return row.kind;
  }
}

/** The sidebar's collapsible-section header (ConversationListPanel's
 *  SectionHeader vocabulary): one persistent toggle whose name carries the
 *  count whenever it is known. */
function WorkflowsSectionHeader({
  id,
  listId,
  collapsed,
  count,
  onToggle,
  ref,
}: {
  id: string;
  listId: string;
  collapsed: boolean;
  /** Undefined while the read is pending or failed: never announced as 0. */
  count: number | undefined;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const Caret = collapsed ? CaretRightIcon : CaretDownIcon;
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={listId}
      aria-label={count === undefined ? "Workflows" : `Workflows, ${count}`}
      className="flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <Caret aria-hidden className="size-3 shrink-0" />
      <span>Workflows</span>
      {collapsed && count !== undefined && (
        <span className="tabular-nums">({count})</span>
      )}
    </button>
  );
}

export interface WorkflowsSectionRead {
  data: Workflow[] | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
}

/** The repo's workflows above the run list, each with its latest run's status;
 *  picking one filters the runs to it. A roving list: one tab stop, arrows
 *  move focus only, Enter/Space/click pick. */
export function WorkflowsSection({
  workflows,
  collapsed,
  onToggle,
  showAll,
  onShowAll,
  selectedId,
  onSelect,
  latestRuns,
  glyphsMuted,
}: {
  workflows: WorkflowsSectionRead;
  collapsed: boolean;
  onToggle: () => void;
  showAll: boolean;
  onShowAll: () => void;
  /** The workflow facet's id, or undefined for "All workflows". */
  selectedId: number | undefined;
  onSelect: (workflow: Workflow | null) => void;
  /** Facet-free page-1 runs, newest first; undefined when none is loaded. */
  latestRuns: readonly WorkflowRun[] | undefined;
  /** Another facet narrows the list, so the facet-free glyphs would mislead. */
  glyphsMuted: boolean;
}) {
  const headerId = useId();
  const listId = useId();
  const failed = workflows.isError && workflows.data === undefined;
  // The failed line's Retry unmounts once the retry starts; the header holds focus.
  const rescue = useRetryFocusRescue(!collapsed && failed);
  const sorted = sortWorkflows(workflows.data ?? []);
  const capped = !showAll && sorted.length > WORKFLOW_ROW_CAP;
  const rows: Row[] = [
    { kind: "all" },
    ...(capped ? sorted.slice(0, WORKFLOW_ROW_CAP) : sorted).map(
      (workflow): Row => ({ kind: "workflow", workflow }),
    ),
    ...(capped ? [{ kind: "show-all", total: sorted.length } as const] : []),
  ];
  const roving = useRovingRows({ items: rows, rowKey });
  const listRef = useRef<HTMLDivElement>(null);
  // The palette collapse unmounts a focused row after the palette hands focus
  // back to it; the header catches what would otherwise fall to <body>.
  const headerRef = useRef<HTMLButtonElement | null>(null);
  useFocusOnControlsSwap(collapsed, headerRef);
  // The palette dispatches while still open, and its restore on unmount can't
  // reach the opener: its autofocused input is what Base UI records as focused
  // before open, so the restore falls back to an older popup's trigger. A toggle
  // run from a dialog over this section moves whatever that restore lands to
  // the header.
  const sectionFocus = useRef(false);
  const lastCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    if (lastCollapsed.current === collapsed) return;
    lastCollapsed.current = collapsed;
    const fromSection = sectionFocus.current;
    sectionFocus.current = false;
    const dialog = document.activeElement?.closest('[role="dialog"]');
    if (!fromSection || !dialog) return;
    let frame = 0;
    let frames = 0;
    const disarm = () => {
      document.removeEventListener("focusin", onFocusIn);
      cancelAnimationFrame(frame);
    };
    function onFocusIn(e: FocusEvent) {
      if (e.target instanceof Element && e.target.closest('[role="dialog"]'))
        return;
      disarm();
      if (e.target !== headerRef.current) headerRef.current?.focus();
    }
    // A restore with nowhere to go leaves focus on <body>, which fires nothing.
    function watch() {
      if (dialog?.isConnected && ++frames < PALETTE_RESTORE_FRAMES) {
        frame = requestAnimationFrame(watch);
        return;
      }
      disarm();
      if (!dialog?.isConnected && document.activeElement === document.body)
        headerRef.current?.focus();
    }
    document.addEventListener("focusin", onFocusIn);
    frame = requestAnimationFrame(watch);
    return disarm;
  }, [collapsed]);
  // "Show all" unmounts under the press; focus moves to the first row it revealed.
  const revealFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!showAll) return;
    const key = revealFocus.current;
    revealFocus.current = null;
    if (key)
      listRef.current
        ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)
        ?.focus();
  }, [showAll]);

  const latestByWorkflow = new Map<number, WorkflowRun>();
  for (const run of latestRuns ?? [])
    if (!latestByWorkflow.has(run.workflowDatabaseId))
      latestByWorkflow.set(run.workflowDatabaseId, run);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // A chord belongs to the app's bindings, never to row navigation.
    if (hasChordModifier(e)) return;
    // Rows are native buttons that activate on Enter/Space themselves; a held
    // key must not re-pick on every repeat.
    if (e.repeat && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      return;
    }
    if ((e.key === "Home" || e.key === "End") && !e.shiftKey) {
      const all = e.currentTarget.querySelectorAll<HTMLElement>("[data-row]");
      const el = e.key === "Home" ? all[0] : all[all.length - 1];
      if (!el) return;
      e.preventDefault();
      el.focus();
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    roving.onRowKeyDown(e);
  }

  function activate(row: Row) {
    switch (row.kind) {
      case "all":
        onSelect(null);
        return;
      case "workflow":
        onSelect(row.workflow);
        return;
      case "show-all": {
        const next = sorted[WORKFLOW_ROW_CAP];
        revealFocus.current = next ? `wf-${next.id}` : null;
        onShowAll();
        return;
      }
    }
  }

  const body = (() => {
    switch (true) {
      case workflows.data !== undefined:
        return (
          <div ref={listRef} onKeyDown={onKeyDown}>
            <ul id={listId} aria-labelledby={headerId}>
              {rows.map((row) => (
                <li key={rowKey(row)}>
                  <WorkflowRow
                    row={row}
                    current={
                      (row.kind === "all" && selectedId === undefined) ||
                      (row.kind === "workflow" &&
                        row.workflow.id === selectedId)
                    }
                    latest={
                      row.kind === "workflow"
                        ? latestByWorkflow.get(row.workflow.id)
                        : undefined
                    }
                    muted={glyphsMuted}
                    rowProps={roving.rowProps(row)}
                    onClick={() => activate(row)}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      case failed:
        return (
          <div
            id={listId}
            className="flex items-center gap-2 px-3 pb-1.5 text-xs text-muted-foreground"
          >
            <p>Couldn't load workflows.</p>
            <Button
              ref={rescue.retryRef}
              variant="outline"
              size="xs"
              onClick={() => void workflows.refetch()}
            >
              Retry
            </Button>
          </div>
        );
      default:
        return (
          <p id={listId} className="px-3 pb-1.5 text-xs text-muted-foreground">
            Loading workflows…
          </p>
        );
    }
  })();

  return (
    <div
      className="border-b pb-1"
      onFocus={() => {
        sectionFocus.current = true;
      }}
      // Leaving for a dialog keeps the mark: the palette opens over the section.
      onBlur={(e) => {
        sectionFocus.current =
          e.relatedTarget instanceof Element &&
          e.relatedTarget.closest('[role="dialog"]') !== null;
      }}
    >
      <WorkflowsSectionHeader
        ref={(node) => {
          headerRef.current = node;
          rescue.hostRef(node);
        }}
        id={headerId}
        listId={listId}
        collapsed={collapsed}
        count={workflows.data?.length}
        onToggle={onToggle}
      />
      {!collapsed && body}
    </div>
  );
}

function WorkflowRow({
  row,
  current,
  latest,
  muted,
  rowProps,
  onClick,
}: {
  row: Row;
  current: boolean;
  latest: WorkflowRun | undefined;
  muted: boolean;
  rowProps: ReturnType<ReturnType<typeof useRovingRows<Row>>["rowProps"]>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      {...rowProps}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-left text-xs outline-none hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
        current && "font-medium",
        row.kind === "show-all" && "text-muted-foreground",
      )}
    >
      {row.kind === "workflow" && <RunGlyph latest={latest} muted={muted} />}
      <RowLabel row={row} />
      {row.kind === "workflow" && !muted && (
        // After the name, so the row reads "CI, last run: Failed".
        <>
          {" "}
          <span className="sr-only">
            {latest
              ? `last run: ${statusLabel(latest.status, latest.conclusion)}`
              : "no run loaded"}
          </span>
        </>
      )}
      {current && (
        <CheckIcon aria-hidden className="ml-auto size-3.5 shrink-0" />
      )}
    </button>
  );
}

function RowLabel({ row }: { row: Row }) {
  switch (row.kind) {
    case "all":
      return <span className="truncate">All workflows</span>;
    case "show-all":
      return <span className="truncate">Show all ({row.total})</span>;
    case "workflow":
      return (
        <>
          <span
            className="min-w-0 truncate"
            onMouseEnter={clipTitle(row.workflow.name)}
          >
            {row.workflow.name}
          </span>
          {isDisabledWorkflow(row.workflow.state) && (
            <span className="shrink-0 text-muted-foreground">disabled</span>
          )}
        </>
      );
  }
}

const DASH = (
  <span
    aria-hidden
    className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
  >
    —
  </span>
);

/** The workflow's latest facet-free run, or a dash: always under another facet,
 *  and whenever no facet-free page holds one. Visual only; the row's sr-only
 *  text says the same. */
function RunGlyph({
  latest,
  muted,
}: {
  latest: WorkflowRun | undefined;
  muted: boolean;
}) {
  if (muted || !latest) return DASH;
  return (
    <span aria-hidden className="flex shrink-0">
      <StatusIcon
        status={latest.status}
        conclusion={latest.conclusion}
        className="size-3.5"
      />
    </span>
  );
}
