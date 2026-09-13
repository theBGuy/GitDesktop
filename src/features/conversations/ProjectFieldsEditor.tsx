import { Popover } from "@base-ui/react/popover";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost } from "@/lib/git/host";
import {
  useGhScopes,
  useProjectFields,
  useSetItemFieldValues,
} from "@/lib/git/queries";
import type {
  ItemProjectFieldValues,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
  ProjectIterationDef,
  RemoteLens,
} from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useUiStore } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";
import { IterationRange, OptionValue } from "./ProjectFieldValues";
import { ScopeGapBlock } from "./ProjectsPopover";

const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read project fields but not change them (needs the project scope)";
const NO_ITERATIONS_REASON =
  "This board's iteration field has no iterations to pick from yet";
const ISSUE_FIELD_REASON =
  "Issue fields are edited on GitHub — board editing arrives later.";
const SAVING_REASON = "Saving your last change…";
const STRANDED_NOTICE =
  "Field changes weren't applied — this item is no longer on the board they were drafted for";

/** GitHub's Date scalar, which carries no zone — and the only form a native date
 *  input accepts, so anything else seeds it empty rather than silently blank. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The field kinds this editor can write. The built-in fields GitHub owns on the
 *  issue/PR itself (title, assignees, labels, milestone, repository, reviewers,
 *  tracking) arrive as `system`, so the exclusion is by KIND: a name-based one
 *  would miss a renamed built-in and catch a custom field that borrowed its name. */
type WritableFieldDef = Exclude<ProjectFieldDef, { kind: "system" }>;

function isWritable(def: ProjectFieldDef): def is WritableFieldDef {
  return def.kind !== "system";
}

/** An org issue-field bridged onto a board. `updateProjectV2ItemFieldValue` is not
 *  its write path, so its row is held rather than hidden — the rail shows the value,
 *  and a missing row there would read as a broken render. */
function isIssueFieldDef(def: WritableFieldDef): boolean {
  return def.kind !== "iteration" && def.isIssueField;
}

/** One field's drafted state: what it will READ as once written, plus the write that
 *  puts it there. Both halves are built where the definitions are — the ids a write
 *  needs and the names a value renders live only there. `null` is a drafted UNSET. */
type FieldDraft = {
  value: ProjectFieldValue;
  update: ProjectFieldValueUpdate;
} | null;

/** Every touched field of one board, by field id. An absent key is untouched. */
type BoardDraft = Record<string, FieldDraft>;

/** A value's identity for the close-time diff. Kinds compare on what a write
 *  changes, so a multi-select reordered by the server still reads as unchanged, and
 *  an iteration renamed or rescheduled on the board is still the same iteration. */
function valueKey(value: ProjectFieldValue | null): string {
  if (value === null) return "";
  switch (value.kind) {
    case "text":
      return `text:${value.text}`;
    case "number":
      return `number:${value.number}`;
    case "date":
      return `date:${value.date}`;
    case "singleSelect":
      return `singleSelect:${value.optionId}`;
    case "multiSelect":
      return `multiSelect:${value.options
        .map((option) => option.id)
        .toSorted()
        .join(",")}`;
    case "iteration":
      return `iteration:${value.iterationId}`;
    // `unknown` never reaches a draft and never seeds one — it carries no field id.
    default:
      return "";
  }
}

/** One board's values by field id, the baseline a close diffs against. */
function seedBoard(
  board: ItemProjectFieldValues,
): Record<string, ProjectFieldValue> {
  const seed: Record<string, ProjectFieldValue> = {};
  for (const value of board.values) {
    if ("fieldId" in value) seed[value.fieldId] = value;
  }
  return seed;
}

type FieldDiff = {
  updates: ProjectFieldValueUpdate[];
  clears: string[];
  /** The drafts that survived the diff, by field id — what the optimistic patch
   *  applies, so a skipped draft can't reach the cache either. */
  applied: Map<string, FieldDraft>;
};

/** Diffs one board's touched fields against its seeded snapshot. Untouched fields
 *  can't differ, so the loop is over the drafts alone. Split out from the write
 *  because a board that left the item mid-open still has to answer "did this draft
 *  hold changes?" with no board object left to patch. */
function fieldDiff(
  seed: Record<string, ProjectFieldValue>,
  touched: BoardDraft,
): FieldDiff {
  const updates: ProjectFieldValueUpdate[] = [];
  const clears: string[] = [];
  const applied = new Map<string, FieldDraft>();
  for (const [fieldId, entry] of Object.entries(touched)) {
    // A half-typed number stays on screen but never reaches the wire: the backend
    // would have to read the NaN as something, and every reading is wrong.
    if (
      entry !== null &&
      entry.value.kind === "number" &&
      !Number.isFinite(entry.value.number)
    )
      continue;
    if (valueKey(seed[fieldId] ?? null) === valueKey(entry?.value ?? null))
      continue;
    if (entry === null) clears.push(fieldId);
    else updates.push(entry.update);
    applied.set(fieldId, entry);
  }
  return { updates, clears, applied };
}

type BoardWrite = FieldDiff & {
  /** That board's values as they'll read once the write lands — the optimistic patch. */
  values: ProjectFieldValue[];
};

/** One board's diff plus the patched value list it implies, which keeps the
 *  server's order and appends whatever the item had no value for before. */
function boardWrite(
  board: ItemProjectFieldValues,
  seed: Record<string, ProjectFieldValue>,
  touched: BoardDraft,
): BoardWrite {
  const diff = fieldDiff(seed, touched);
  const { applied } = diff;
  const values: ProjectFieldValue[] = [];
  const had = new Set<string>();
  for (const value of board.values) {
    if (!("fieldId" in value)) {
      values.push(value);
      continue;
    }
    had.add(value.fieldId);
    if (!applied.has(value.fieldId)) {
      values.push(value);
      continue;
    }
    const entry = applied.get(value.fieldId);
    if (entry) values.push(entry.value);
  }
  for (const [fieldId, entry] of applied) {
    if (entry !== null && !had.has(fieldId)) values.push(entry.value);
  }
  return { ...diff, values };
}

/**
 * The editable half of an item's GitHub Projects fields: one trigger that opens a
 * popover listing every writable field of every board the item sits on, set and
 * unset alike. Edits are drafted while it's open and committed as one batched write
 * per board on close — the same model as the Projects and Labels pickers, and the
 * reason the popup says so above its rows.
 */
export function ProjectFieldsEditor({
  repoPath,
  kind,
  number,
  lens,
  boards,
  disabledReason,
  unsettledReason,
}: {
  repoPath: string;
  /** Which surface this item is — the backend addresses issues and PRs apart. */
  kind: "issue" | "pr";
  number: number;
  /** The origin|upstream lens the parent PR/issue surface resolved. */
  lens: RemoteLens;
  /** The boards this item is on, in memberships order, each with the cached values
   *  the draft seeds from. Empty while those values are still unread. */
  boards: ItemProjectFieldValues[];
  /** Set when the surface can't be edited right now — the viewer lacks the access
   *  its action needs, or the entity is still loading. Outranks every other hold. */
  disabledReason?: string;
  /** Set when `boards` can't be trusted yet, with the words that say so. */
  unsettledReason?: string;
}) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const openReconnect = useUiStore((s) => s.openReconnect);
  // Read-only classic token: the reads work, every write 403s. Hold the controls
  // rather than letting each edit round-trip to a rollback + toast.
  const readOnlyScope =
    scopes.data?.classic === true &&
    scopes.data.scopes.includes("read:project") &&
    !scopes.data.scopes.includes("project");

  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, BoardDraft>>({});
  // Each board's values AS SEEN at open. The close diffs draft-vs-SEEDED, never
  // draft-vs-live, so a value landing mid-open is in neither set and left alone.
  const [seeds, setSeeds] = useState<
    Record<string, Record<string, ProjectFieldValue>>
  >({});
  const portalContainer = usePanelPortalContainer();
  const setFields = useSetItemFieldValues(repoPath, kind, number, lens);

  // Ranked: the caller's reason outranks a write the viewer started, which outranks
  // values this surface hasn't read yet.
  const heldReason = (() => {
    switch (true) {
      case disabledReason !== undefined:
        return disabledReason;
      // No second edit may be drafted while one is in flight: the cache holds an
      // optimistic patch whose real values only the settle refetch supplies, and
      // that refetch is what a fresh draft would have to seed from. The mutation's
      // `onSettled` returns its invalidate promise, so this hold spans it.
      case setFields.isPending:
        return SAVING_REASON;
      case unsettledReason !== undefined:
        return unsettledReason;
      default:
        return undefined;
    }
  })();

  function setDraft(projectId: string, fieldId: string, entry: FieldDraft) {
    setDrafts((prev) => ({
      ...prev,
      [projectId]: { ...(prev[projectId] ?? {}), [fieldId]: entry },
    }));
  }

  async function commit() {
    const pending: { board: ItemProjectFieldValues; write: BoardWrite }[] = [];
    for (const board of boards) {
      const touched = drafts[board.project.id];
      if (touched === undefined) continue;
      // A board that appeared mid-open has no snapshot, so its LIVE values stand
      // in — a baseline that can move under a background refetch while a mounted
      // input's text stays frozen. Diffing only touched fields bounds that.
      const seed = seeds[board.project.id] ?? seedBoard(board);
      const write = boardWrite(board, seed, touched);
      if (write.updates.length === 0 && write.clears.length === 0) continue;
      pending.push({ board, write });
    }
    // Drafts for a board the item left mid-open have nowhere to go — the
    // membership their itemId addressed is gone, and its section left the popup
    // as it went. Said once, however many boards it was.
    const live = new Set(boards.map((board) => board.project.id));
    const stranded = Object.entries(drafts).some(([projectId, touched]) => {
      if (live.has(projectId)) return false;
      const { updates, clears } = fieldDiff(seeds[projectId] ?? {}, touched);
      return updates.length > 0 || clears.length > 0;
    });
    if (stranded) toast.info(STRANDED_NOTICE);

    for (const [i, { board, write }] of pending.entries()) {
      try {
        await setFields.mutateAsync({
          projectId: board.project.id,
          itemId: board.itemId,
          updates: write.updates,
          clears: write.clears,
          values: write.values,
          unwritten: pending.length - i - 1,
        });
      } catch {
        // The mutation owns the report, including what this stop left undone.
        return;
      }
    }
  }

  function handleOpenChange(o: boolean) {
    if (o) {
      const next: Record<string, Record<string, ProjectFieldValue>> = {};
      for (const board of boards) next[board.project.id] = seedBoard(board);
      setSeeds(next);
      setDrafts({});
      setOpen(true);
      return;
    }
    setOpen(false);
    void commit();
  }

  const showTitles = boards.length > 1;
  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        render={
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            aria-label="Edit project fields"
            disabled={!!heldReason}
            reason={heldReason}
          />
        }
      >
        {/* size-3 explicitly: the Button's own icon rule skips a sized element,
            and a 16px swap would widen the label column mid-write. */}
        {setFields.isPending ? (
          <Spinner className="size-3" data-icon="inline-start" />
        ) : (
          <SlidersHorizontalIcon data-icon="inline-start" />
        )}
        Project fields
      </Popover.Trigger>
      <Popover.Portal container={portalContainer}>
        <Popover.Positioner
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup className="w-80 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <p className="px-1 pb-1.5 text-xs font-medium">Project fields</p>
            {readOnlyScope && (
              <div className="mb-1 border-b pb-1">
                <ScopeGapBlock
                  host={host}
                  onReconnect={() =>
                    openReconnect({
                      provider: "github",
                      host,
                      mode: "refresh",
                      scopes: ["project"],
                    })
                  }
                >
                  Changing project fields needs the{" "}
                  <span className="font-mono">project</span> scope, which your
                  GitHub sign-in is missing.
                </ScopeGapBlock>
              </div>
            )}
            {/* The popup's ONE scroll region, as the Projects picker has one: every
                row below renders at natural height, so nothing nests a second
                scrollbar inside this one. Capped against the WINDOW rather than at a
                fixed height — a full field spread is taller than any cap that also
                fits a short window, and `max-h` only bites once content exceeds it. */}
            <div className="max-h-[70vh] space-y-3 overflow-y-auto px-1">
              {boards.map((board) => (
                <BoardSection
                  key={board.itemId}
                  repoPath={repoPath}
                  board={board}
                  open={open}
                  // A board GitHub reports with no title has no header to render.
                  showTitle={showTitles && board.project.title !== ""}
                  lockedReason={
                    readOnlyScope ? READ_ONLY_SCOPE_REASON : undefined
                  }
                  seed={seeds[board.project.id]}
                  draft={drafts[board.project.id]}
                  onChange={(fieldId, entry) =>
                    setDraft(board.project.id, fieldId, entry)
                  }
                />
              ))}
            </div>
            {boards.length > 0 && !readOnlyScope && (
              <p className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                Changes apply when this closes.
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One board's rows. The definitions are read here rather than in the parent: a
 *  hook can't be called per board from a list, and this is also what keeps a board
 *  whose popover never opens from ever fetching them. */
function BoardSection({
  repoPath,
  board,
  open,
  showTitle,
  lockedReason,
  seed,
  draft,
  onChange,
}: {
  repoPath: string;
  board: ItemProjectFieldValues;
  open: boolean;
  showTitle: boolean;
  lockedReason?: string;
  seed?: Record<string, ProjectFieldValue>;
  draft?: BoardDraft;
  onChange: (fieldId: string, entry: FieldDraft) => void;
}) {
  const defs = useProjectFields(repoPath, board.project.id, open);
  const writable = (defs.data ?? []).filter(isWritable);
  const baseline = seed ?? seedBoard(board);
  return (
    <div className="space-y-2">
      {showTitle && (
        <p
          className="truncate text-[11px] font-medium"
          title={board.project.title}
        >
          {board.project.title}
        </p>
      )}
      {defs.isPending && (
        <p className="py-1 text-xs text-muted-foreground">Loading fields…</p>
      )}
      {defs.error !== null && (
        <div className="py-1 text-xs">
          <p className="text-muted-foreground">
            {presentError(defs.error).summary}
          </p>
          <Button
            variant="outline"
            size="xs"
            className="mt-1.5"
            onClick={() => defs.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {defs.isSuccess && writable.length === 0 && (
        <p className="py-1 text-xs text-muted-foreground">
          This board defines no fields you can change here.
        </p>
      )}
      {writable.map((def) => (
        <FieldRow
          key={def.id}
          def={def}
          current={
            def.id in (draft ?? {})
              ? (draft?.[def.id]?.value ?? null)
              : (baseline[def.id] ?? null)
          }
          // The board-wide hold outranks the per-field one, as the Projects
          // picker's rows rank theirs: a scope gap has a remedy on this popup.
          lockedReason={
            lockedReason ??
            (isIssueFieldDef(def) ? ISSUE_FIELD_REASON : undefined)
          }
          onChange={(entry) => onChange(def.id, entry)}
        />
      ))}
    </div>
  );
}

/** One field's control, plus the header that names it and clears it. A set field
 *  offers Clear; an unset one says so where Clear would be, so no row is ever a
 *  bare control with nothing to read. */
function FieldRow({
  def,
  current,
  lockedReason,
  onChange,
}: {
  def: WritableFieldDef;
  /** What the field reads as right now — the draft if touched, else the seed. */
  current: ProjectFieldValue | null;
  lockedReason?: string;
  onChange: (entry: FieldDraft) => void;
}) {
  const inputId = useId();
  const action =
    current === null ? (
      <span className="text-[11px] text-muted-foreground">Not set</span>
    ) : (
      <DisabledReasonButton
        type="button"
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        aria-label={`Clear ${def.name}`}
        disabled={!!lockedReason}
        reason={lockedReason}
        onClick={() => onChange(null)}
      >
        Clear
      </DisabledReasonButton>
    );

  // Text, number and date share one shell: a labelled input whose own emptiness is
  // the unset state, so clearing needs no separate control path.
  if (def.kind === "text" || def.kind === "number" || def.kind === "date") {
    return (
      <div className="space-y-1" title={lockedReason}>
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={inputId}
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            {def.name}
          </Label>
          {action}
        </div>
        <ScalarInput
          id={inputId}
          def={def}
          current={current}
          lockedReason={lockedReason}
          onChange={onChange}
        />
        {lockedReason && <span className="sr-only">{lockedReason}</span>}
      </div>
    );
  }

  return (
    <LabeledGroup
      className="space-y-1"
      label={
        <span className="min-w-0 truncate text-muted-foreground">
          {def.name}
        </span>
      }
      actions={action}
    >
      <div title={lockedReason}>
        {def.kind === "singleSelect" && (
          <SingleSelectRows
            def={def}
            current={current}
            lockedReason={lockedReason}
            onChange={onChange}
          />
        )}
        {def.kind === "multiSelect" && (
          <MultiSelectRows
            def={def}
            current={current}
            lockedReason={lockedReason}
            onChange={onChange}
          />
        )}
        {def.kind === "iteration" && (
          <IterationRows
            def={def}
            current={current}
            lockedReason={lockedReason}
            onChange={onChange}
          />
        )}
        {lockedReason && <span className="sr-only">{lockedReason}</span>}
      </div>
    </LabeledGroup>
  );
}

type ScalarDef = Extract<
  WritableFieldDef,
  { kind: "text" | "number" | "date" }
>;

/** The initial text for a scalar field's input — what the value reads as in the
 *  control's own grammar, never a formatted one: a locale-grouped number or date
 *  would not survive the round trip back through this input. */
function scalarText(def: ScalarDef, current: ProjectFieldValue | null): string {
  if (current === null) return "";
  if (def.kind === "text" && current.kind === "text") return current.text;
  if (def.kind === "number" && current.kind === "number")
    return Number.isFinite(current.number) ? String(current.number) : "";
  if (def.kind === "date" && current.kind === "date")
    return DATE_ONLY.test(current.date) ? current.date : "";
  return "";
}

/** Turns a scalar input's raw text into a draft. Empty is an UNSET rather than an
 *  empty value — an empty text field and a missing one read the same on a board. */
function scalarDraft(def: ScalarDef, raw: string): FieldDraft {
  const base = {
    fieldId: def.id,
    fieldName: def.name,
    isIssueField: def.isIssueField,
  };
  if (def.kind === "number") {
    // Trimmed only here: `Number("  ")` is 0, so whitespace would write a value the
    // user meant to clear. Text is NOT trimmed for emptiness — the space that starts
    // a word would blank the field on the keystroke that typed it.
    if (raw.trim() === "") return null;
    // Number(), not parseFloat(): a trailing "1.2.3" must read as unparseable, and
    // the whole point of keeping the raw text is that nothing here re-rounds it.
    const parsed = Number(raw);
    return {
      value: { kind: "number", ...base, number: parsed },
      update: { kind: "number", fieldId: def.id, number: parsed },
    };
  }
  if (raw === "") return null;
  if (def.kind === "text")
    return {
      value: { kind: "text", ...base, text: raw },
      update: { kind: "text", fieldId: def.id, text: raw },
    };
  return {
    value: { kind: "date", ...base, date: raw },
    update: { kind: "date", fieldId: def.id, date: raw },
  };
}

/** Text / number / date. Controlled from its own state so the row's Clear can empty
 *  it: the draft above mirrors what's typed, and an unparseable number stays here
 *  exactly as entered rather than snapping back to the last good value. */
function ScalarInput({
  id,
  def,
  current,
  lockedReason,
  onChange,
}: {
  id: string;
  def: ScalarDef;
  current: ProjectFieldValue | null;
  lockedReason?: string;
  onChange: (entry: FieldDraft) => void;
}) {
  const [text, setText] = useState(() => scalarText(def, current));
  // Clear empties the draft, which this mirrors — the row's own button is outside
  // this component, so the emptied state has to arrive as a prop change.
  const shown = current === null && text !== "" ? "" : text;
  return (
    <Input
      id={id}
      type={def.kind === "text" ? "text" : def.kind}
      // `any` rather than the default step of 1: a board's number field takes
      // fractions, and a stepped input reports those as invalid.
      step={def.kind === "number" ? "any" : undefined}
      // A native date input renders its own segment mask and ignores this, so only
      // the two free-text kinds get the invitation; the header says "Not set".
      placeholder={def.kind === "date" ? undefined : `Set ${def.name}…`}
      className="h-7"
      disabled={!!lockedReason}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        onChange(scalarDraft(def, e.target.value));
      }}
    />
  );
}

const ROW_CLASS =
  "flex cursor-pointer items-center gap-2 px-1 py-1 text-xs hover:bg-muted/60";

/** A single-select field's options as a radio group — one choice, and the group's
 *  own arrow-key navigation, which is what a radio group already is. */
function SingleSelectRows({
  def,
  current,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "singleSelect" }>;
  current: ProjectFieldValue | null;
  lockedReason?: string;
  onChange: (entry: FieldDraft) => void;
}) {
  const selected =
    current !== null && current.kind === "singleSelect" ? current.optionId : "";
  return (
    // `gap-0` only: the rows carry their own padding, and the popup body owns the
    // scrolling — a cap here would nest a scrollbar inside that one.
    <RadioGroup
      className="gap-0"
      value={selected}
      onValueChange={(next) => {
        const option = def.options.find((o) => o.id === next);
        if (option === undefined) return;
        onChange({
          value: {
            kind: "singleSelect",
            fieldId: def.id,
            fieldName: def.name,
            optionId: option.id,
            name: option.name,
            color: option.color,
            isIssueField: def.isIssueField,
          },
          update: {
            kind: "singleSelect",
            fieldId: def.id,
            optionId: option.id,
          },
        });
      }}
    >
      {def.options.map((option) => (
        <label
          key={option.id}
          className={cn(ROW_CLASS, lockedReason && "cursor-not-allowed")}
        >
          <Radio value={option.id} disabled={!!lockedReason} />
          <OptionValue name={option.name} color={option.color} />
        </label>
      ))}
      {def.options.length === 0 && (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          This field has no options.
        </p>
      )}
    </RadioGroup>
  );
}

/** A multi-select field's options as checkbox rows, the labels picker's shape. */
function MultiSelectRows({
  def,
  current,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "multiSelect" }>;
  current: ProjectFieldValue | null;
  lockedReason?: string;
  onChange: (entry: FieldDraft) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const chosen =
    current !== null && current.kind === "multiSelect" ? current.options : [];
  const chosenIds = new Set(chosen.map((option) => option.id));
  // Locked rows are skipped by the arrows rather than made focus black holes: a
  // natively-disabled checkbox can't take focus.
  const navRows = lockedReason ? [] : def.options;
  const navIndexById = new Map(navRows.map((option, i) => [option.id, i]));
  const activeIndex =
    activeId === null ? -1 : (navIndexById.get(activeId) ?? -1);
  // Nothing active yet parks the single tab stop on the first row.
  const focusIndex = activeIndex === -1 ? 0 : activeIndex;
  const onKeyDown = listKeyboardNav({
    items: navRows,
    activeIndex,
    onActivate: (option) => setActiveId(option.id),
    rowKey: (option) => option.id,
  });

  function toggle(optionId: string, on: boolean) {
    const next = def.options.filter(
      (option) =>
        (chosenIds.has(option.id) || option.id === optionId) &&
        (option.id !== optionId || on),
    );
    if (next.length === 0) {
      onChange(null);
      return;
    }
    onChange({
      value: {
        kind: "multiSelect",
        fieldId: def.id,
        fieldName: def.name,
        options: next,
        isIssueField: def.isIssueField,
      },
      update: {
        kind: "multiSelect",
        fieldId: def.id,
        optionIds: next.map((option) => option.id),
      },
    });
  }

  return (
    // Unstyled but NOT removable: it hosts the key handler, and `listKeyboardNav`
    // finds the row to focus by querying within this element. The popup body owns
    // the scrolling, so this list renders at natural height.
    <div onKeyDown={onKeyDown}>
      {def.options.map((option) => (
        <label
          key={option.id}
          className={cn(
            ROW_CLASS,
            lockedReason && "cursor-not-allowed",
            activeId === option.id && "bg-muted/60",
          )}
        >
          <Checkbox
            data-row={option.id}
            tabIndex={navIndexById.get(option.id) === focusIndex ? 0 : -1}
            checked={chosenIds.has(option.id)}
            disabled={!!lockedReason}
            onCheckedChange={(v) => toggle(option.id, v === true)}
            onFocus={() => setActiveId(option.id)}
          />
          <OptionValue name={option.name} color={option.color} />
        </label>
      ))}
      {def.options.length === 0 && (
        <p className="px-1 py-1 text-xs text-muted-foreground">
          This field has no options.
        </p>
      )}
    </div>
  );
}

/** An iteration field's iterations, current ones first and the completed ones under
 *  their own caption — assignable, but not what a board means by "the current one".
 *  A field with none is held with the reason rather than shown as an empty list. */
function IterationRows({
  def,
  current,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "iteration" }>;
  current: ProjectFieldValue | null;
  lockedReason?: string;
  onChange: (entry: FieldDraft) => void;
}) {
  const { iterations, completedIterations } = def;
  const all = [...iterations, ...completedIterations];
  // The reason is the row's own text: nothing here is focusable, so a tooltip or an
  // aria-disabled flag would reach no one, and a second dimming layer over
  // muted-foreground drops the one thing that IS readable below AA.
  if (all.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-muted-foreground">
        {NO_ITERATIONS_REASON}
      </p>
    );
  }
  // An iteration the field no longer offers matches no row, so nothing is checked
  // — the header still reports the field as set, and its Clear still empties it.
  const selected =
    current !== null && current.kind === "iteration" ? current.iterationId : "";
  return (
    // `gap-0` only — see the single-select group: the popup body owns the scrolling.
    <RadioGroup
      className="gap-0"
      value={selected}
      onValueChange={(next) => {
        const iteration = all.find((it) => it.id === next);
        if (iteration === undefined) return;
        onChange({
          value: {
            kind: "iteration",
            fieldId: def.id,
            fieldName: def.name,
            iterationId: iteration.id,
            title: iteration.title,
            startDate: iteration.startDate,
            duration: iteration.duration,
            // Constant where the other kinds thread the def's flag: an iteration
            // field is board-defined, so its def carries no `isIssueField`.
            isIssueField: false,
          },
          update: {
            kind: "iteration",
            fieldId: def.id,
            iterationId: iteration.id,
          },
        });
      }}
    >
      {iterations.map((iteration) => (
        <IterationRow
          key={iteration.id}
          iteration={iteration}
          lockedReason={lockedReason}
        />
      ))}
      {completedIterations.length > 0 && (
        <p className="px-1 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
          Completed
        </p>
      )}
      {completedIterations.map((iteration) => (
        <IterationRow
          key={iteration.id}
          iteration={iteration}
          lockedReason={lockedReason}
        />
      ))}
    </RadioGroup>
  );
}

function IterationRow({
  iteration,
  lockedReason,
}: {
  iteration: ProjectIterationDef;
  lockedReason?: string;
}) {
  return (
    <label className={cn(ROW_CLASS, lockedReason && "cursor-not-allowed")}>
      <Radio value={iteration.id} disabled={!!lockedReason} />
      <span className="min-w-0 truncate">
        {iteration.title}
        <IterationRange
          startDate={iteration.startDate}
          duration={iteration.duration}
        />
      </span>
    </label>
  );
}
