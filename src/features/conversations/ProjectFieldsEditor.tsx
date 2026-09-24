import { Popover } from "@base-ui/react/popover";
import { SlidersHorizontalIcon } from "@phosphor-icons/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { usePanelPortalContainer } from "@/components/panel-portal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  type CommittedDraft,
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
  valueKey,
  type WritableFieldDef,
} from "@/features/projects/ProjectFieldControls";
import { presentError } from "@/lib/error-summary";
import { useActiveGhHost } from "@/lib/git/host";
import {
  useGhScopes,
  useProjectFields,
  useSetItemFieldValues,
} from "@/lib/git/queries";
import type {
  ItemProjectFieldValues,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
  RemoteLens,
} from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useUiStore } from "@/lib/stores/ui";
import {
  NO_ACCESS_REASON,
  projectScopeReadOnly,
  ScopeGapBlock,
} from "./ProjectsPopover";

const READ_ONLY_SCOPE_REASON =
  "Your GitHub sign-in can read project fields but not change them (needs the project scope)";
const SAVING_REASON = "Saving your last change…";
const STRANDED_NOTICE =
  "Field changes weren't applied — this item is no longer on the board they were drafted for";

/** Why a whole board's rows are held, or `undefined` when they're editable. The
 *  no-access wording is the Projects picker's own: both surfaces gate on the same
 *  `viewerCanUpdate` flag and must not say it differently. */
function boardLockedReason(
  readOnlyScope: boolean,
  board: ItemProjectFieldValues,
): string | undefined {
  switch (true) {
    case readOnlyScope:
      return READ_ONLY_SCOPE_REASON;
    case !board.project.viewerCanUpdate:
      return NO_ACCESS_REASON;
    default:
      return undefined;
  }
}

/** Every touched field of one board, by field id. An absent key is untouched. */
type BoardDraft = Record<string, FieldDraft>;

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
   *  applies, so a skipped draft can't reach the cache either. Typed without the
   *  invalid arm: a skipped entry is never recorded here. */
  applied: Map<string, CommittedDraft | null>;
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
  const applied = new Map<string, CommittedDraft | null>();
  for (const [fieldId, entry] of Object.entries(touched)) {
    // Neither an update nor a clear: the field keeps what the server holds while
    // its control shows an entry still being typed.
    if (entry === INVALID_DRAFT) continue;
    // Defensive twin for a raw string that reached a parse from somewhere other
    // than a number input, whose own sanitizing never yields an unparseable one.
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
  paletteEnabled = false,
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
  /** Whether the host surface owns the current selection, so this instance may
   *  answer the palette's "Edit project fields…". */
  paletteEnabled?: boolean;
}) {
  const host = useActiveGhHost();
  const scopes = useGhScopes(host);
  const openReconnect = useUiStore((s) => s.openReconnect);
  const readOnlyScope = projectScopeReadOnly(scopes.data);

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
      // Belt for the rows' own hold: a board the viewer can't write would 403 at the
      // end of a chain that stops on the first failure, stranding the boards after it.
      if (!board.project.viewerCanUpdate) continue;
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

  // Registered HERE, not in the parent views: the action's enabled state IS the
  // trigger's hold, one derivation. This component only mounts once the item has
  // boards, so a boardless item registers nothing rather than offering a no-op.
  useHotkeyAction(
    "edit-project-fields",
    () => {
      if (open || heldReason !== undefined) return;
      handleOpenChange(true);
    },
    paletteEnabled && heldReason === undefined,
  );

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
            {/* Title names the popup via aria-labelledby — a bare caption leaves the
                dialog unnamed; render keeps the <p> off Title's default <h2>. */}
            <Popover.Title
              render={<p />}
              className="px-1 pb-1.5 text-xs font-medium"
            >
              Project fields
            </Popover.Title>
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
                fits a short window, and `max-h` only bites once content exceeds it.
                py-2 contains the Checkbox touch-target's 8px vertical bleed
                (after:-inset-y-2) — without it the pseudo adds scrollable overflow
                and Windows draws a scrollbar for even one row. */}
            <div className="max-h-[70vh] space-y-3 overflow-y-auto px-1 py-2">
              {boards.map((board) => (
                <BoardSection
                  key={board.itemId}
                  repoPath={repoPath}
                  board={board}
                  open={open}
                  // A board GitHub reports with no title has no header to render.
                  showTitle={showTitles && board.project.title !== ""}
                  // Ranked as the Projects picker ranks its rows: the popover-wide
                  // scope gap outranks the per-board access one, and BoardSection
                  // puts the per-field issue-field reason below both.
                  lockedReason={boardLockedReason(readOnlyScope, board)}
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
  const writable = (defs.data?.fields ?? []).filter(isWritable);
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
          current={currentValue(def, draft, baseline)}
          // The board-wide hold outranks the per-field ones, as the Projects
          // picker's rows rank theirs: a scope gap has a remedy on this popup.
          lockedReason={
            lockedReason ?? fieldLockedReason(def, baseline[def.id])
          }
          onChange={(entry) => onChange(def.id, entry)}
        />
      ))}
      {/* Stands alone, as the picker's own truncation note does: a capped list of
          fields this build can't write renders zero rows, where the empty-state
          line above would be a lie. */}
      {defs.data?.truncated === true && (
        <p className="text-[11px] text-muted-foreground">
          Some fields aren't shown.
        </p>
      )}
    </div>
  );
}

/** What a row reads as now: its draft where the field was touched, else the seed. An
 *  INVALID entry reads as the SEED — nothing will be written for it, so the field
 *  still holds what it held, and its Clear stays offered. */
function currentValue(
  def: WritableFieldDef,
  draft: BoardDraft | undefined,
  baseline: Record<string, ProjectFieldValue>,
): ProjectFieldValue | null {
  const entry = draft?.[def.id];
  if (entry === undefined || entry === INVALID_DRAFT)
    return baseline[def.id] ?? null;
  return entry?.value ?? null;
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
  // Remounts the scalar input, which is uncontrolled so that a partly-typed entry
  // the browser reports as empty stays legible while it can't be parsed. Bumped
  // only by Clear, so a keystroke never costs the caret its place.
  const [clearSeq, setClearSeq] = useState(0);
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
        onClick={() => {
          setClearSeq((n) => n + 1);
          onChange(null);
        }}
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
          key={clearSeq}
          id={inputId}
          def={def}
          defaultValue={scalarText(def, current)}
          lockedReason={lockedReason}
          onEdit={(raw, badInput) => onChange(scalarDraft(def, raw, badInput))}
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
            selectedId={
              current !== null && current.kind === "singleSelect"
                ? current.optionId
                : ""
            }
            lockedReason={lockedReason}
            onPick={(option) => onChange(singleSelectDraft(def, option))}
          />
        )}
        {def.kind === "multiSelect" && (
          <MultiSelectRows
            def={def}
            chosenIds={
              new Set(
                current !== null && current.kind === "multiSelect"
                  ? current.options.map((option) => option.id)
                  : [],
              )
            }
            lockedReason={lockedReason}
            // An emptied set is the clear gesture in this editor's model.
            onChoose={(options) =>
              onChange(
                options.length === 0 ? null : multiSelectDraft(def, options),
              )
            }
          />
        )}
        {def.kind === "iteration" && (
          <IterationRows
            def={def}
            selectedId={
              current !== null && current.kind === "iteration"
                ? current.iterationId
                : ""
            }
            lockedReason={lockedReason}
            onPick={(iteration) => onChange(iterationDraft(def, iteration))}
          />
        )}
        {lockedReason && <span className="sr-only">{lockedReason}</span>}
      </div>
    </LabeledGroup>
  );
}
