import { useId, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  DATE_ONLY,
  formatFieldDate,
  IterationRange,
  OptionValue,
} from "@/features/conversations/ProjectFieldValues";
import { presentError } from "@/lib/error-summary";
import type {
  BoardItem,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
} from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import type { ItemNoun } from "./board-model";
import {
  INVALID_DRAFT,
  ISSUE_FIELD_REASON,
  IterationRows,
  isIssueFieldDef,
  isWritable,
  iterationDraft,
  MultiSelectRows,
  multiSelectDraft,
  type ScalarDef,
  ScalarInput,
  SingleSelectRows,
  scalarDraft,
  singleSelectDraft,
  valueKey,
  type WritableFieldDef,
} from "./ProjectFieldControls";

const NOTHING_DRAFTED_REASON = "Nothing to apply yet";

/** What one row will do to every eligible card. An absent key is the default,
 *  "Leave as is", which writes nothing at all — the property the whole dialog turns
 *  on, since a bulk write must never carry a field the user didn't mean. */
type RowDraft =
  | { mode: "set"; update: ProjectFieldValueUpdate }
  | { mode: "clear" }
  // A row "Set to" nothing parseable yet: it contributes nothing to the payload
  // and doesn't count as drafted.
  | typeof INVALID_DRAFT;

/** Every drafted row, by field id. */
type BulkDraft = Record<string, RowDraft>;

/** Which of the three a row's radio group is sitting on. Derived from the draft
 *  rather than stored beside it: two sources for one choice is one that can drift,
 *  and a half-typed "Set to" is still a "Set to". */
type RowMode = "keep" | "set" | "clear";

function rowMode(entry: RowDraft | undefined): RowMode {
  if (entry === undefined) return "keep";
  if (entry === INVALID_DRAFT) return "set";
  return entry.mode;
}

/** One card's value for `fieldId`, matched on the field id alone — one field holds
 *  one value, whatever kind the cached copy of it was read as. */
function cardValueFor(
  card: BoardItem,
  fieldId: string,
): ProjectFieldValue | undefined {
  return card.fieldValues.find(
    (value) => "fieldId" in value && value.fieldId === fieldId,
  );
}

/** What the eligible cards currently hold for one field: the shared value where
 *  they agree, or the mixed marker.
 *
 *  DISPLAY ONLY, and that is load-bearing. The board reads field values through a
 *  CAPPED selection, so a card whose values were truncated can make a genuinely
 *  agreed field read as mixed (or the reverse). That must never matter, and here it
 *  can't: nothing on this side of the dialog feeds the payload — only a row the user
 *  drafted does. The hint is a reminder of what they are about to overwrite, never a
 *  seed a write replays back. */
type FieldHint =
  | { kind: "agreed"; value: ProjectFieldValue | undefined }
  | { kind: "mixed" };

function fieldHint(cards: BoardItem[], fieldId: string): FieldHint {
  if (cards.length === 0) return { kind: "agreed", value: undefined };
  const first = cardValueFor(cards[0], fieldId);
  const key = valueKey(first);
  for (const card of cards.slice(1)) {
    if (valueKey(cardValueFor(card, fieldId)) !== key) return { kind: "mixed" };
  }
  return { kind: "agreed", value: first };
}

/** The payload a draft implies. "Leave as is" rows are absent from the draft and an
 *  invalid one contributes nothing, so this loop over the DRAFTED entries is the
 *  whole rule: a field reaches the wire only because the user put it there. */
function draftPayload(draft: BulkDraft): {
  updates: ProjectFieldValueUpdate[];
  clears: string[];
} {
  const updates: ProjectFieldValueUpdate[] = [];
  const clears: string[] = [];
  for (const [fieldId, entry] of Object.entries(draft)) {
    if (entry === INVALID_DRAFT) continue;
    if (entry.mode === "clear") clears.push(fieldId);
    else updates.push(entry.update);
  }
  return { updates, clears };
}

/**
 * Write one set of field values across a whole board selection.
 *
 * Every writable field of the board is a row, and every row starts at **Leave as
 * is**: the user drafts only what they mean to change, and an explicit Apply sends
 * exactly those updates and clears to every eligible card. Deliberately NOT the
 * single-card editor's commit-on-close — a batch that writes several cards behind an
 * Escape is the house's banned shape, so the two ways out of this dialog are Apply
 * and Cancel, and Cancel discards in silence.
 *
 * The hints beside each row say what the selection holds now, agreed or mixed, and
 * are display-only for the reason {@link fieldHint} states.
 */
export function BoardBulkFieldsDialog({
  open,
  cards,
  eligibleCount,
  fieldDefs,
  defsTruncated,
  defsPending,
  defsError,
  onRetryDefs,
  pending,
  heldReason,
  noun,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  /** The eligible cards as they read when the dialog OPENED — the hints' source,
   *  and nothing else. The panel re-derives the cards a write addresses at Apply
   *  time, so a card that left the board under an open dialog can't be written. */
  cards: BoardItem[];
  /** How many cards Apply would write to RIGHT NOW — the panel's live eligible
   *  count, which is what the title claims. Apart from `cards.length` on purpose:
   *  that snapshot is frozen at open, so a card pruned from the selection under
   *  this dialog would leave the title over-claiming what a write will reach. */
  eligibleCount: number;
  /** The board's field definitions, from the panel's own cached read. */
  fieldDefs: ProjectFieldDef[];
  /** The definitions read was capped, so some fields have no row here. */
  defsTruncated: boolean;
  defsPending: boolean;
  defsError: Error | null;
  onRetryDefs: () => void;
  /** A bulk write is in flight — from this run or one the user closed over. */
  pending: boolean;
  /** Why Apply is held whatever the draft holds: the board-wide bulk ladder. */
  heldReason: string | undefined;
  /** What the surface that opened this calls an item: a board card, a table row. */
  noun: ItemNoun;
  onOpenChange: (open: boolean) => void;
  /** Write the draft. The panel owns it, so it can re-check its own gates, report
   *  the result, and decide whether this run is still the one on screen.
   *
   *  Resolves `true` only when EVERY card took the write — the batch command
   *  resolves with its refusals inside it, so "the call returned" is not the same
   *  claim. Anything less keeps this dialog open over the draft that produced it,
   *  which is what makes a retry possible; the panel has already reported what
   *  failed. A resolution from a run the user has since cancelled answers `false`
   *  too, so it can't close the editor that replaced it. */
  onApply: (
    updates: ProjectFieldValueUpdate[],
    clears: string[],
  ) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<BulkDraft>({});
  const titleId = useId();
  // Every open starts fresh at "Leave as is" everywhere: this dialog stays mounted
  // across close, and `<Activity>` replays effect setups on show, so a draft left
  // behind would be a payload the user never re-authored.
  useSeedOnOpen(open, () => setDraft({}));

  const writable = fieldDefs.filter(isWritable);
  const { updates, clears } = draftPayload(draft);
  const drafted = updates.length + clears.length;
  // Ranked: the board-wide hold outranks the draft's own emptiness, since a
  // sign-in that can't write at all is the more useful thing to say.
  const applyHeld =
    heldReason ?? (drafted === 0 ? NOTHING_DRAFTED_REASON : undefined);

  async function apply() {
    // Belt-and-braces with the button's own `disabled`, which is derived at render:
    // the chord reaches this with no button to grey out, and a press racing the
    // render that set the hold must not get through either.
    if (applyHeld !== undefined || pending) return;
    if (await onApply(updates, clears)) onOpenChange(false);
  }

  function setRow(fieldId: string, entry: RowDraft | undefined) {
    setDraft((prev) => {
      if (entry === undefined) {
        const { [fieldId]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [fieldId]: entry };
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-lg"
        aria-labelledby={titleId}
        // mod+enter applies from anywhere in the dialog. Captured on the Popup
        // rather than a form: the X close renders as a SIBLING of the body, so a
        // chord pressed with focus on it would bypass a body-level handler and
        // reach the global mod+enter action. ALWAYS swallow it here; apply only
        // under the gate the button takes. (BoardDraftEditDialog's own shape.)
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void apply();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle id={titleId}>
            Edit fields on {eligibleCount}{" "}
            {eligibleCount === 1 ? noun : `${noun}s`}
          </DialogTitle>
          <DialogDescription>
            Every field starts at <strong>Leave as is</strong>. Only the rows
            you change are written, and nothing is sent until you apply.
          </DialogDescription>
        </DialogHeader>
        {/* The dialog's ONE scroll region: every row renders at natural height, so
            nothing nests a second scrollbar inside this one. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {defsPending && (
            <p className="py-1 text-muted-foreground">Loading fields…</p>
          )}
          {defsError !== null && (
            <div className="py-1">
              <p className="text-muted-foreground">
                {presentError(defsError).summary}
              </p>
              <Button
                variant="outline"
                size="xs"
                className="mt-1.5"
                onClick={onRetryDefs}
              >
                Retry
              </Button>
            </div>
          )}
          {!defsPending && defsError === null && writable.length === 0 && (
            <p className="py-1 text-muted-foreground">
              This board defines no fields you can change here.
            </p>
          )}
          {writable.map((def) => (
            <BulkFieldRow
              key={def.id}
              def={def}
              hint={fieldHint(cards, def.id)}
              entry={draft[def.id]}
              // Ranked below the board-wide hold, as the single-card editor ranks
              // its rows: an org issue-field has no write path here whatever the
              // sign-in can do.
              // No multi-line hold here, unlike a table cell and the item
              // editor: that hold exists because a single-line control would LOAD
              // the value and flatten it, and "Set to" never loads one — it
              // replaces the value wholesale with what the user typed.
              lockedReason={
                heldReason ??
                (isIssueFieldDef(def) ? ISSUE_FIELD_REASON : undefined)
              }
              onChange={(entry) => setRow(def.id, entry)}
            />
          ))}
          {/* Stands alone, as the single-card editor's own note does: a capped list
              whose remainder this build can't write renders zero rows, where the
              empty-state line above would be a lie. */}
          {defsTruncated && (
            <p className="text-[11px] text-muted-foreground">
              Some of this board's fields aren't shown.
            </p>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-[11px] text-muted-foreground">
            {drafted === 0
              ? "No changes drafted"
              : `${drafted} ${drafted === 1 ? "field" : "fields"} will be written to every eligible ${noun}`}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <DisabledReasonButton
            type="button"
            title={SUBMIT_HINT}
            disabled={applyHeld !== undefined || pending}
            reason={applyHeld}
            onClick={() => void apply()}
          >
            Apply
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the selection holds for a field right now, as the row's own quiet line. */
function HintLine({ def, hint }: { def: WritableFieldDef; hint: FieldHint }) {
  if (hint.kind === "mixed")
    return <span className="text-muted-foreground">(mixed)</span>;
  const value = hint.value;
  if (value === undefined)
    return <span className="text-muted-foreground">Not set</span>;
  switch (value.kind) {
    case "singleSelect":
      return <OptionValue name={value.name} color={value.color} />;
    case "multiSelect":
      return (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
          {value.options.map((option) => (
            <OptionValue
              key={option.id}
              name={option.name}
              color={option.color}
            />
          ))}
        </span>
      );
    case "iteration":
      return (
        <span className="min-w-0 truncate">
          {value.title}
          <IterationRange
            startDate={value.startDate}
            duration={value.duration}
          />
        </span>
      );
    case "date":
      return <span>{formatFieldDate(value.date)}</span>;
    case "number":
      return (
        <span className="tabular-nums">
          {value.number.toLocaleString(undefined, {
            maximumFractionDigits: 20,
          })}
        </span>
      );
    case "text": {
      // DISPOSITION (settled, do not re-litigate): a multi-line text value does NOT
      // hold its row. The single-card editor holds one because its input would
      // flatten the value it seeded; nothing is seeded here, so "Set to" is the
      // deliberate overwrite it is for every other kind — and a capped display read
      // must never gate a write. The hint says so instead of quietly showing a
      // flattened first line as if that were the whole value.
      const lines = value.text.split(/\r\n|\r|\n/);
      if (lines.length === 1)
        return <span className="min-w-0 truncate">{value.text}</span>;
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{lines[0]}</span>
          <span className="shrink-0 text-muted-foreground">(multi-line)</span>
        </span>
      );
    }
    // A kind this build has no compact form for says nothing rather than guessing;
    // `def` is what names the row above it either way.
    default:
      return <span className="text-muted-foreground">Set on {def.name}</span>;
  }
}

const MODE_ROW_CLASS =
  "flex cursor-pointer items-center gap-1.5 text-xs whitespace-nowrap";

/** One field: the three-way choice, the hint, and the control the "Set to" arm
 *  reveals. The control is mounted only under that arm — an always-visible one
 *  would read as a value the selection already holds. */
function BulkFieldRow({
  def,
  hint,
  entry,
  lockedReason,
  onChange,
}: {
  def: WritableFieldDef;
  hint: FieldHint;
  entry: RowDraft | undefined;
  lockedReason?: string;
  onChange: (entry: RowDraft | undefined) => void;
}) {
  const mode = rowMode(entry);
  const modeLabelId = useId();
  return (
    <div
      className="space-y-1.5 border-b pb-2.5 last:border-b-0"
      title={lockedReason}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span id={modeLabelId} className="min-w-0 truncate font-medium">
          {def.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">Now:</span>
          <HintLine def={def} hint={hint} />
        </span>
      </div>
      {/* A radio group rather than a select: three choices with no positioning
          machinery to get wrong, and arrow-key navigation the group already owns.
          Horizontal because the row's own control sits under it. */}
      <RadioGroup
        className="flex flex-row flex-wrap gap-x-4 gap-y-1"
        aria-labelledby={modeLabelId}
        value={mode}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          if (next === "keep") onChange(undefined);
          else if (next === "clear") onChange({ mode: "clear" });
          // "Set to" with nothing picked yet commits nothing and doesn't count as
          // drafted — the same third state a half-typed number sits in.
          else onChange(INVALID_DRAFT);
        }}
      >
        <label className={MODE_ROW_CLASS}>
          <Radio value="keep" disabled={!!lockedReason} />
          Leave as is
        </label>
        <label className={MODE_ROW_CLASS}>
          <Radio value="set" disabled={!!lockedReason} />
          Set to
        </label>
        <label className={MODE_ROW_CLASS}>
          <Radio value="clear" disabled={!!lockedReason} />
          Clear
        </label>
      </RadioGroup>
      {mode === "set" && (
        <BulkFieldControl
          def={def}
          entry={entry}
          lockedReason={lockedReason}
          onChange={onChange}
        />
      )}
      {lockedReason && <span className="sr-only">{lockedReason}</span>}
    </div>
  );
}

/** The value control for whichever kind `def` is. Only the UPDATE half of a draft is
 *  built here — unlike the single-card editor, which also mints the patched value:
 *  a bulk write has no optimistic patch to feed, so the rendered value never has to
 *  be reconstructed. */
function BulkFieldControl({
  def,
  entry,
  lockedReason,
  onChange,
}: {
  def: WritableFieldDef;
  entry: RowDraft | undefined;
  lockedReason?: string;
  onChange: (entry: RowDraft) => void;
}) {
  const inputId = useId();
  const update =
    entry !== undefined && entry !== INVALID_DRAFT && entry.mode === "set"
      ? entry.update
      : undefined;

  if (def.kind === "text" || def.kind === "number" || def.kind === "date") {
    return (
      <div className="space-y-1">
        <Label htmlFor={inputId} className="sr-only">
          {def.name}
        </Label>
        <ScalarInput
          id={inputId}
          def={def}
          lockedReason={lockedReason}
          onEdit={(raw, badInput) =>
            onChange(bulkScalarDraft(def, raw, badInput))
          }
        />
      </div>
    );
  }

  return (
    <LabeledGroup
      className="space-y-1"
      label={<span className="sr-only">{def.name}</span>}
    >
      {def.kind === "singleSelect" && (
        <SingleSelectRows
          def={def}
          selectedId={update?.kind === "singleSelect" ? update.optionId : ""}
          lockedReason={lockedReason}
          ariaLabel={def.name}
          onPick={(option) =>
            onChange({
              mode: "set",
              update: singleSelectDraft(def, option).update,
            })
          }
        />
      )}
      {def.kind === "multiSelect" && (
        <MultiSelectRows
          def={def}
          chosenIds={
            new Set(update?.kind === "multiSelect" ? update.optionIds : [])
          }
          lockedReason={lockedReason}
          // The picked set REPLACES what every eligible card holds — a bulk write
          // has no per-card set to add to. An emptied set is not a clear: this
          // dialog's Clear arm is the way to unset a field, and an empty "Set to" is
          // a pick not yet made.
          onChoose={(options) =>
            onChange(
              options.length === 0
                ? INVALID_DRAFT
                : {
                    mode: "set",
                    update: multiSelectDraft(def, options).update,
                  },
            )
          }
        />
      )}
      {def.kind === "iteration" && (
        <IterationRows
          def={def}
          selectedId={update?.kind === "iteration" ? update.iterationId : ""}
          lockedReason={lockedReason}
          ariaLabel={def.name}
          onPick={(iteration) =>
            onChange({
              mode: "set",
              update: iterationDraft(def, iteration).update,
            })
          }
        />
      )}
    </LabeledGroup>
  );
}

/** A scalar input's raw text as a bulk-model draft: the shared rule, read the
 *  bulk way. Empty is NOT a clear here, unlike the seeded editors — this dialog has
 *  an explicit Clear arm, so an empty control under "Set to" is simply a value not
 *  yet written, the same commit-nothing state an unparseable entry sits in. The
 *  finite-number and date-shape checks refuse, before the wire, a value the seeded
 *  editors leave for the server to judge. */
function bulkScalarDraft(
  def: ScalarDef,
  raw: string,
  badInput: boolean,
): RowDraft {
  const entry = scalarDraft(def, raw, badInput);
  if (entry === null || entry === INVALID_DRAFT) return INVALID_DRAFT;
  const { update } = entry;
  if (update.kind === "number" && !Number.isFinite(update.number))
    return INVALID_DRAFT;
  if (update.kind === "date" && !DATE_ONLY.test(update.date))
    return INVALID_DRAFT;
  return { mode: "set", update };
}
