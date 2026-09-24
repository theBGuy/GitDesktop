import { Popover } from "@base-ui/react/popover";
import { CheckIcon, LockSimpleIcon, NoteIcon } from "@phosphor-icons/react";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { Markdown } from "@/components/markdown/markdown";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { fieldValueNode } from "@/features/conversations/ProjectFieldValues";
import { StateIcon } from "@/features/issues/IssueRelations";
import { clipTitleFromText } from "@/lib/clip-title";
import type { BoardItem, ProjectFieldDef } from "@/lib/git/types";
import { useDisabledReason } from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { ArchivedBadge, CardDates, issueStateWord, prPill } from "./BoardCard";
import {
  ARCHIVED_ITEM_REASON,
  columnValue,
  type TableColumn,
} from "./board-model";
import {
  type FieldDraft,
  fieldLockedReason,
  INVALID_DRAFT,
  IterationRows,
  isWritable,
  iterationDraft,
  MultiSelectRows,
  multiSelectDraft,
  ScalarInput,
  SingleSelectRows,
  scalarDraft,
  scalarText,
  singleSelectDraft,
  type WritableFieldDef,
} from "./ProjectFieldControls";

/** Every row's height, header and group rows included. Fixed rather than
 *  measured: a cell is one truncated line, so a measurement pass would only
 *  race the first paint. */
export const TABLE_ROW_HEIGHT = 30;

/** The pinned Title column's width — wide enough that a title reads before it
 *  truncates, which is what the column is pinned for. */
const TITLE_WIDTH = 360;

/** Per-kind widths for the other columns, sized to what each kind's value
 *  usually needs; a kind with no entry takes the default. */
const KIND_WIDTH: Partial<Record<ProjectFieldDef["kind"], number>> = {
  number: 96,
  date: 124,
  singleSelect: 150,
  multiSelect: 200,
  iteration: 200,
  text: 200,
};
const DEFAULT_WIDTH = 170;

export function columnWidth(column: TableColumn): number {
  if (column.title) return TITLE_WIDTH;
  return KIND_WIDTH[column.def.kind] ?? DEFAULT_WIDTH;
}

/** One cell's box. The focus ring is inset so a pinned neighbour can't clip it. */
export const CELL_CLASS =
  "flex h-full shrink-0 items-center gap-1.5 px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** Where the pinned Title column sits. `bg-inherit` takes the ROW's background,
 *  which is always opaque, so cells scrolling under it stay hidden whatever the
 *  row's selection state. */
export const PINNED_CLASS = "sticky left-0 z-10 bg-inherit";

/** What every focusable cell shares: its column, the roving tab stop, and the
 *  report back to the panel's cursor. */
interface CellProps {
  rowKey: string;
  colIndex: number;
  width: number;
  tabbable: boolean;
  onCellFocus: (rowKey: string, colIndex: number | null) => void;
}

function cellAttrs({
  rowKey,
  colIndex,
  width,
  tabbable,
  onCellFocus,
}: CellProps) {
  return {
    role: "gridcell",
    "aria-colindex": colIndex + 1,
    "data-table-cell": "",
    "data-col-index": colIndex,
    tabIndex: tabbable ? 0 : -1,
    style: { width },
    onFocus: () => onCellFocus(rowKey, colIndex),
  } as const;
}

/** The leading marks a row carries on its first column: the tick that says it is
 *  one of several selected (never colour alone), and the Archived badge that says
 *  why it reads quietly. */
function RowMarks({
  checked,
  archived,
}: {
  checked: boolean;
  archived: boolean;
}) {
  return (
    <>
      {checked && <CheckIcon aria-hidden className="size-3.5 shrink-0" />}
      {archived && <ArchivedBadge />}
    </>
  );
}

/** The item's glyph and its state in words — the board card's head-line grammar:
 *  the glyph carries kind and state visually, the sr-only words carry both for a
 *  reader. */
function ItemGlyph({ item }: { item: BoardItem }): ReactNode {
  const content = item.content;
  switch (content.kind) {
    case "issue":
      return (
        <>
          <StateIcon state={content.state} />
          <span className="sr-only">
            {issueStateWord(content.state, content.stateReason)}
          </span>
        </>
      );
    case "pullRequest": {
      const pill = prPill(content.state, content.isDraft);
      return (
        <>
          <pill.Icon className={cn("size-3.5 shrink-0", pill.tone)} />
          <span className="sr-only">{pill.word}</span>
        </>
      );
    }
    case "draft":
      return (
        <>
          <NoteIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">Draft item</span>
        </>
      );
    default:
      return <LockSimpleIcon className="size-3.5 shrink-0" />;
  }
}

/**
 * The details peek a Title cell anchors: an issue or pull request's title, what
 * it is and its dates, or a draft's notes — what the board card's own popovers
 * say. Mounted only while open, and anchored to the CELL with focus returning to
 * it, since the cell is not the popover's trigger: Enter and Space are the
 * panel's keys, and a click on the title opens the item.
 */
function TitlePeek({
  item,
  anchor,
  onPeekChange,
}: {
  item: BoardItem;
  anchor: RefObject<HTMLDivElement | null>;
  onPeekChange: (itemId: string | null) => void;
}) {
  const portalContainer = usePanelPortalContainer();
  const content = item.content;
  if (content.kind === "redacted") return null;
  const body = content.kind === "draft" ? content.body.trim() : "";
  return (
    <Popover.Root
      open
      onOpenChange={(open) => onPeekChange(open ? item.itemId : null)}
    >
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          anchor={anchor}
          className="isolate z-50"
        >
          <Popover.Popup
            finalFocus={anchor}
            className="max-h-96 w-80 overflow-y-auto rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            {/* The caption IS the popup's accessible name; `render` keeps it a
                <p> rather than Title's default <h2>. */}
            <Popover.Title
              render={<p />}
              className="px-1 pb-1.5 text-xs font-medium"
            >
              {content.kind === "draft"
                ? content.title || "Draft item"
                : content.title}
            </Popover.Title>
            {content.kind === "draft" ? (
              body === "" ? (
                <p className="px-1 text-xs text-muted-foreground">
                  This draft has no notes yet.
                </p>
              ) : (
                <Markdown className="px-1 text-xs">{body}</Markdown>
              )
            ) : (
              <p className="px-1 text-xs text-muted-foreground">
                {content.kind === "pullRequest"
                  ? prPill(content.state, content.isDraft).word
                  : issueStateWord(content.state, content.stateReason)}
              </p>
            )}
            <CardDates item={item} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The pinned Title cell: the row's marks, the item's glyph, and its title. The
 *  title text is the pointer's way to open the item (`data-title-open`, handled
 *  by the grid); a redacted item has no title to open and says so instead. */
export function TitleCell({
  item,
  checked,
  peek,
  onPeekChange,
  ...cell
}: CellProps & {
  item: BoardItem;
  checked: boolean;
  peek: boolean;
  onPeekChange: (itemId: string | null) => void;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  const content = item.content;
  return (
    <div
      ref={cellRef}
      {...cellAttrs(cell)}
      className={cn(CELL_CLASS, PINNED_CLASS)}
    >
      <RowMarks checked={checked} archived={item.isArchived} />
      <ItemGlyph item={item} />
      {content.kind === "redacted" ? (
        <span className="min-w-0 truncate text-muted-foreground">
          Redacted item
        </span>
      ) : (
        <span
          data-title-open=""
          className="min-w-0 cursor-pointer truncate font-medium hover:underline"
          onMouseEnter={clipTitleFromText}
        >
          {content.title}
        </span>
      )}
      {peek && (
        <TitlePeek item={item} anchor={cellRef} onPeekChange={onPeekChange} />
      )}
    </div>
  );
}

/** A field column's cell: the shared value renderer inside one truncated line,
 *  with the whole value as a tooltip when it is cut off. Blank for an unset field
 *  and for a kind this build can't render — the two read the same. `lead` carries
 *  the row's marks when there is no Title column to hold them. */
export function ValueCell({
  item,
  column,
  lead,
  editHeld,
  editSession,
  onCommit,
  onCancel,
  ...cell
}: CellProps & {
  item: BoardItem;
  column: TableColumn;
  lead: { checked: boolean } | null;
  /** Why no cell of the table can be edited right now, board-wide. */
  editHeld: string | undefined;
  /** The run of this cell's editor while it is the open one, else null. A close
   *  carries it, so a retired run's close can't shut a newer editor. */
  editSession: number | null;
  onCommit: (itemId: string, fieldId: string, entry: FieldDraft) => void;
  onCancel: (session: number) => void;
}) {
  const cellRef = useRef<HTMLDivElement>(null);
  const value = columnValue(item, column.def);
  const writable = isWritable(column.def) ? column.def : null;
  const held =
    writable === null ? undefined : cellEditHeld(editHeld, item, writable);
  // The disabled-reason contract adapted to a cell: the cell stays focusable in
  // the walk, and the reason is its description and its hover text, never a dim.
  const reason = useDisabledReason({
    disabled: held !== undefined,
    reason: held,
  });
  const editable = writable !== null && held === undefined;
  return (
    <div
      ref={cellRef}
      {...cellAttrs(cell)}
      // A system field and a held one both read as read-only to a reader; only the
      // held one has a reason to give.
      aria-readonly={!editable}
      aria-describedby={reason.describedBy}
      title={reason.wrapperTitle}
      // What the grid's click handler opens; absent on a cell that can't be edited.
      data-edit-field={editable ? column.def.id : undefined}
      className={cn(CELL_CLASS, editable && "cursor-pointer")}
    >
      {lead !== null && (
        <RowMarks checked={lead.checked} archived={item.isArchived} />
      )}
      {/* `*:flex-nowrap` keeps a multi-select's options on the one line the
          fixed row height has room for. */}
      <div
        className="min-w-0 flex-1 truncate *:flex-nowrap"
        onMouseEnter={clipTitleFromText}
      >
        {value === undefined
          ? null
          : fieldValueNode(
              value,
              "repoNameWithOwner" in item.content
                ? item.content.repoNameWithOwner
                : null,
            )}
      </div>
      {/* `hidden` rather than sr-only: a description may point at hidden text,
          and the cell's own name must not read the reason a second time. */}
      {reason.blockedReason !== null && (
        <span id={reason.reasonId} hidden>
          {reason.blockedReason}
        </span>
      )}
      {/* Gated on the KIND alone once open: a hold that arrives mid-edit (another
          write starting) must not unmount the draft under the user — the commit
          re-checks every hold at fire time and says why it refused. */}
      {editSession !== null && writable !== null && (
        <CellEditor
          item={item}
          def={writable}
          anchor={cellRef}
          onCommit={(entry) => onCommit(item.itemId, writable.id, entry)}
          onCancel={() => onCancel(editSession)}
        />
      )}
    </div>
  );
}

/**
 * Why one table cell can't be edited, or undefined when it can. Board-wide holds
 * first (the sign-in, access, a write in flight), then the item's own state — an
 * archived item takes no field write, the bulk dialog's rule — then the field's:
 * an org issue field, or a multi-line text value the single-line control would
 * flatten. Shared by the cell's rendering and the panel's fire-time re-check, so
 * the two can't disagree about the same cell.
 */
export function cellEditHeld(
  boardHeld: string | undefined,
  item: BoardItem,
  def: WritableFieldDef,
): string | undefined {
  switch (true) {
    case boardHeld !== undefined:
      return boardHeld;
    // The row the board shows as redacted and leaves out of every selection: its
    // item is one this sign-in can't read, so it is no item to write to either.
    case item.content.kind === "redacted":
      return REDACTED_ROW_REASON;
    case item.isArchived:
      return ARCHIVED_ITEM_REASON.row;
    default:
      return fieldLockedReason(def, columnValue(item, def));
  }
}

/** Why a redacted row's cells hold, in the words its title cell already uses. */
const REDACTED_ROW_REASON =
  "This item is redacted for your sign-in, so its fields can't be changed here";

/** What a close means for a kind: the scalars and the single picks commit only
 *  on their own gesture, so every other close cancels; a multi-select commits on
 *  close (the field popovers' precedent) unless the close was Esc. */
const COMMITS_ON_CLOSE: Record<WritableFieldDef["kind"], boolean> = {
  text: false,
  number: false,
  date: false,
  singleSelect: false,
  iteration: false,
  multiSelect: true,
};

/**
 * One cell's editor: a popover anchored to the cell, holding the field's own
 * control from {@link ProjectFieldControls}. Drafts follow the item editor's
 * SEEDED model — an emptied scalar or an emptied multi-select is a CLEAR, and an
 * unparseable entry commits nothing — which deliberately differs from the bulk
 * dialog, whose explicit Clear arm makes an empty control mean "nothing picked".
 *
 * Commit: Enter for a scalar, the pick itself for a single-select or an iteration
 * (a pointer press, or Space; the arrows only move the choice, so Enter commits
 * it), and the close for a multi-select. Esc cancels. Every way out hands focus
 * back to the cell SYNCHRONOUSLY before the editor unmounts: a frame later would
 * lose to Base UI's own focus return.
 */
function CellEditor({
  item,
  def,
  anchor,
  onCommit,
  onCancel,
}: {
  item: BoardItem;
  def: WritableFieldDef;
  anchor: RefObject<HTMLDivElement | null>;
  onCommit: (entry: FieldDraft) => void;
  onCancel: () => void;
}) {
  const portalContainer = usePanelPortalContainer();
  const inputId = useId();
  const current = columnValue(item, def) ?? null;
  // Undefined is UNTOUCHED, which a close treats as a cancel: nothing was drafted.
  const [draft, setDraft] = useState<FieldDraft | undefined>(undefined);
  // Spent by the first way out, so a gesture that reaches two routes (a label
  // click also clicks its radio) commits once.
  const finishedRef = useRef(false);

  function finish(entry: FieldDraft | undefined) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    anchor.current?.focus();
    if (entry === undefined) onCancel();
    else onCommit(entry);
  }

  /** The pick draft for the option or iteration row `optionId` names, or
   *  undefined when it names none. */
  function pickDraft(optionId: string): FieldDraft | undefined {
    if (def.kind === "singleSelect") {
      const option = def.options.find((o) => o.id === optionId);
      return option && singleSelectDraft(def, option);
    }
    if (def.kind === "iteration") {
      const iteration = [...def.iterations, ...def.completedIterations].find(
        (it) => it.id === optionId,
      );
      return iteration && iterationDraft(def, iteration);
    }
    return undefined;
  }

  /** A scalar's draft read off its input NOW rather than off the last edit event,
   *  which the browser doesn't always raise (see {@link ScalarInput}): empty and
   *  parseable is a clear, unparseable commits nothing. Undefined for the picks. */
  function liveScalarDraft(): FieldDraft | undefined {
    if (def.kind !== "text" && def.kind !== "number" && def.kind !== "date")
      return undefined;
    const el = document.getElementById(inputId);
    if (!(el instanceof HTMLInputElement)) return undefined;
    return scalarDraft(def, el.value, el.validity.badInput);
  }

  /** The row an event landed in, for the pick kinds. */
  function optionAt(target: EventTarget): string | undefined {
    return target instanceof Element
      ? target.closest<HTMLElement>("[data-option-id]")?.dataset.optionId
      : undefined;
  }

  // What the control shows now: the draft once there is one, else the item's value.
  // An unparseable draft shows the value it will leave standing.
  const shown =
    draft === undefined || draft === INVALID_DRAFT
      ? current
      : (draft?.value ?? null);

  const control = (() => {
    switch (def.kind) {
      case "text":
      case "number":
      case "date":
        return (
          <ScalarInput
            id={inputId}
            def={def}
            defaultValue={scalarText(def, current)}
            onEdit={(raw, badInput) =>
              setDraft(scalarDraft(def, raw, badInput))
            }
          />
        );
      case "singleSelect":
        return (
          <SingleSelectRows
            def={def}
            selectedId={shown?.kind === "singleSelect" ? shown.optionId : ""}
            ariaLabel={def.name}
            onPick={(option) => setDraft(singleSelectDraft(def, option))}
          />
        );
      case "iteration":
        return (
          <IterationRows
            def={def}
            selectedId={shown?.kind === "iteration" ? shown.iterationId : ""}
            ariaLabel={def.name}
            onPick={(iteration) => setDraft(iterationDraft(def, iteration))}
          />
        );
      default:
        return (
          <MultiSelectRows
            def={def}
            chosenIds={
              new Set(
                shown?.kind === "multiSelect"
                  ? shown.options.map((option) => option.id)
                  : [],
              )
            }
            onChoose={(options) =>
              setDraft(
                options.length === 0 ? null : multiSelectDraft(def, options),
              )
            }
          />
        );
    }
  })();

  return (
    <Popover.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        finish(
          COMMITS_ON_CLOSE[def.kind] && details.reason !== "escape-key"
            ? draft
            : undefined,
        );
      }}
    >
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          anchor={anchor}
          className="isolate z-50"
        >
          <Popover.Popup
            finalFocus={anchor}
            className="w-64 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            // A pick is an ACTIVATION, not a value change: a click, or Space (which
            // a radio turns into a click), commits the row it lands on — the
            // already-checked one included, which raises no change at all. The
            // arrows only walk the choice: a radio's arrow-driven change clicks
            // its hidden input, whose click never bubbles.
            onClick={(e) => {
              const optionId = optionAt(e.target);
              if (optionId === undefined) return;
              const entry = pickDraft(optionId);
              if (entry !== undefined) finish(entry);
            }}
            onKeyDown={(e) => {
              // Enter commits the draft every kind holds; a radio swallows the
              // key's default (so it can't click) but not the event.
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              // On a pick row, Enter saves the row under focus, walked-to or not,
              // as the hint promises; elsewhere it commits the draft.
              const optionId = optionAt(e.target);
              // Only an ABSENT live read (a pick kind) falls back: its `null` is
              // the clear.
              const live = liveScalarDraft();
              const scalar = live === undefined ? draft : live;
              finish(
                optionId === undefined
                  ? scalar
                  : (pickDraft(optionId) ?? draft),
              );
            }}
          >
            {/* The caption IS the popup's accessible name, rendered off Title's
                default <h2>. */}
            <Popover.Title
              // A scalar's input takes the caption as its label; the pick lists
              // carry their own group name.
              render={
                def.kind === "text" ||
                def.kind === "number" ||
                def.kind === "date" ? (
                  <label htmlFor={inputId} />
                ) : (
                  <p />
                )
              }
              className="block px-1 pb-1.5 text-xs font-medium"
            >
              {def.name}
            </Popover.Title>
            <div className="max-h-72 overflow-y-auto px-1 py-1">{control}</div>
            <div className="mt-1 flex items-center justify-between gap-2 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
              <span>{EDITOR_HINT[def.kind]}</span>
              {/* A set value offers the item editor's rows' own Clear: the picks
                  have no empty state to clear with, and a scalar's emptied input
                  is a keyboard route a pointer user shouldn't need. A
                  multi-select clears by unchecking. */}
              {def.kind !== "multiSelect" && current !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={`Clear ${def.name}`}
                  onClick={() => finish(null)}
                  // Enter on this button means THIS button, not the popup's
                  // commit-the-draft Enter, which would also cancel its click.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.stopPropagation();
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The editor's one line of instruction, per kind — how its commit works. */
const EDITOR_HINT: Record<WritableFieldDef["kind"], string> = {
  text: "Enter saves; empty clears the field",
  number: "Enter saves; empty clears the field",
  date: "Enter saves; empty clears the field",
  singleSelect: "Pick to save, or Enter on the choice",
  iteration: "Pick to save, or Enter on the choice",
  multiSelect: "Saved when this closes; Esc cancels",
};
