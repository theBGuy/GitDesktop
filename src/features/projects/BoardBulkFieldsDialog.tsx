import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  ProjectIterationDef,
} from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** Mirrors {@link ProjectFieldsEditor}'s exclusion, by KIND rather than by name:
 *  the built-ins GitHub owns on the issue/PR itself (title, assignees, labels,
 *  milestone, repository, reviewers, tracking) all arrive as `system`, and a
 *  name-based test would miss a renamed built-in and catch a custom field that
 *  borrowed its name. */
type WritableFieldDef = Exclude<ProjectFieldDef, { kind: "system" }>;

function isWritable(def: ProjectFieldDef): def is WritableFieldDef {
  return def.kind !== "system";
}

/** The single-card editor's wording verbatim — the two surfaces hold the same rows
 *  for the same reason and must not say it differently. An org issue-field bridged
 *  onto a board is not written by `updateProjectV2ItemFieldValue`, so its row is
 *  held rather than hidden: a missing row would read as a broken render. */
const ISSUE_FIELD_REASON =
  "Issue fields are edited on GitHub — board editing arrives later";
const NO_ITERATIONS_REASON =
  "This board's iteration field has no iterations to pick from yet";
const NOTHING_DRAFTED_REASON = "Nothing to apply yet";

/** A control holding an entry the browser can't parse. Measured in Chromium: a
 *  half-typed exponent ("1e", "-") and an unfinished date segment all report
 *  `value === ""` with `validity.badInput`, which is indistinguishable from the
 *  emptied control that MEANS nothing-picked — hence a third state. A row in it
 *  contributes nothing to the payload and doesn't count as drafted. */
const INVALID_DRAFT = "invalid";

/** What one row will do to every eligible card. An absent key is the default,
 *  "Leave as is", which writes nothing at all — the property the whole dialog turns
 *  on, since a bulk write must never carry a field the user didn't mean. */
type RowDraft =
  | { mode: "set"; update: ProjectFieldValueUpdate }
  | { mode: "clear" }
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

/** A value's identity for the AGREED-vs-MIXED test. Compares on what a write
 *  changes, so a multi-select the server reordered still reads as the same value
 *  and an iteration renamed on the board is still the same iteration. */
function valueKey(value: ProjectFieldValue | undefined): string {
  if (value === undefined) return "";
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
    // `unknown` carries no field id, so it never reaches this.
    default:
      return "";
  }
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
            {eligibleCount === 1 ? "card" : "cards"}
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
              lockedReason={
                heldReason ??
                (def.kind !== "iteration" && def.isIssueField
                  ? ISSUE_FIELD_REASON
                  : undefined)
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
              : `${drafted} ${drafted === 1 ? "field" : "fields"} will be written to every eligible card`}
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
          onChange={onChange}
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
          update={update}
          lockedReason={lockedReason}
          onChange={onChange}
        />
      )}
      {def.kind === "multiSelect" && (
        <MultiSelectRows
          def={def}
          update={update}
          lockedReason={lockedReason}
          onChange={onChange}
        />
      )}
      {def.kind === "iteration" && (
        <IterationRows
          def={def}
          update={update}
          lockedReason={lockedReason}
          onChange={onChange}
        />
      )}
    </LabeledGroup>
  );
}

type ScalarDef = Extract<
  WritableFieldDef,
  { kind: "text" | "number" | "date" }
>;

/** A scalar input's raw text as a draft. Empty is NOT a clear here, unlike the
 *  single-card editor: this dialog has an explicit Clear arm, so an empty control
 *  under "Set to" is simply a value not yet written.
 *
 *  `badInput` separates the two ways a control reads empty — the user emptied it, or
 *  the browser can't parse what's in it and reports `""` on their behalf. Both land
 *  in the same commit-nothing state here, which is what keeps the "1e" of "1e5" from
 *  ever reaching the wire. */
function scalarDraft(def: ScalarDef, raw: string, badInput: boolean): RowDraft {
  if (badInput) return INVALID_DRAFT;
  if (def.kind === "number") {
    // Trimmed only here: `Number("  ")` is 0, so whitespace would write a zero the
    // user never typed. Text is NOT trimmed — the space that starts a word must not
    // read as an empty control on the keystroke that typed it.
    if (raw.trim() === "") return INVALID_DRAFT;
    // Number(), not parseFloat(): "1.2.3" has to read as unparseable, and nothing
    // here may re-round what was typed.
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return INVALID_DRAFT;
    return {
      mode: "set",
      update: { kind: "number", fieldId: def.id, number: parsed },
    };
  }
  if (raw === "") return INVALID_DRAFT;
  if (def.kind === "text")
    return {
      mode: "set",
      update: { kind: "text", fieldId: def.id, text: raw },
    };
  // Every intermediate of a typed 4-digit year is a valid date with a 1-3 digit one
  // ("2026-12-15" arrives as 0002-, 0020-, 0202- first), and no project dates year
  // <1000 — so an unfinished year sits in the same commit-nothing state as an
  // unparseable entry, where a valid-looking wrong date would otherwise be written.
  if (!DATE_ONLY.test(raw) || Number(raw.split("-")[0]) < 1000)
    return INVALID_DRAFT;
  return { mode: "set", update: { kind: "date", fieldId: def.id, date: raw } };
}

/** Text / number / date. UNCONTROLLED: a number or date input mid-entry reports its
 *  value as `""` while still showing what was typed, so re-driving it from the draft
 *  would blank the field under the user's cursor. The DOM keeps the text and the
 *  draft keeps the meaning. */
function ScalarInput({
  id,
  def,
  lockedReason,
  onChange,
}: {
  id: string;
  def: ScalarDef;
  lockedReason?: string;
  onChange: (entry: RowDraft) => void;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const onEdit = useEffectEvent((el: HTMLInputElement) => {
    onChange(scalarDraft(def, el.value, el.validity.badInput));
  });
  // A NATIVE listener, not React's `onChange`: React gates its synthetic change on
  // the input's exposed value STRING (`updateValueIfChanged`, react-dom-client
  // :1592), so an edit that leaves that string `""` is never delivered. Both such
  // edits flip badInput and so decide whether this row commits anything — typing the
  // "-" of "-5" into a just-emptied field, and deleting it again to recover.
  // Measured in Chromium: the native `input` event fires for both and bubbles here.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const handle = (e: Event) => {
      if (e.target instanceof HTMLInputElement) onEdit(e.target);
    };
    host.addEventListener("input", handle);
    return () => host.removeEventListener("input", handle);
  }, []);
  return (
    // Owns the listener so the input's own ref-forwarding is never load-bearing;
    // `block` keeps the input's full width in the row's column.
    <span ref={hostRef} className="block">
      <Input
        id={id}
        type={def.kind === "text" ? "text" : def.kind}
        // `any` rather than the default step of 1: a board's number field takes
        // fractions, and a stepped input reports those as invalid.
        step={def.kind === "number" ? "any" : undefined}
        // A native date input renders its own segment mask and ignores this.
        placeholder={def.kind === "date" ? undefined : `Set ${def.name}…`}
        className="h-7"
        disabled={!!lockedReason}
      />
    </span>
  );
}

const ROW_CLASS =
  "flex cursor-pointer items-center gap-2 px-1 py-1 text-xs hover:bg-muted/60";

/** A single-select field's options as a radio group — one choice, and the arrow-key
 *  navigation a radio group already is. */
function SingleSelectRows({
  def,
  update,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "singleSelect" }>;
  update: ProjectFieldValueUpdate | undefined;
  lockedReason?: string;
  onChange: (entry: RowDraft) => void;
}) {
  const picked = update?.kind === "singleSelect" ? update.optionId : "";
  return (
    // `gap-0` only: the rows carry their own padding, and the dialog body owns the
    // scrolling — a cap here would nest a scrollbar inside that one.
    <RadioGroup
      className="gap-0"
      aria-label={def.name}
      value={picked}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const option = def.options.find((o) => o.id === next);
        if (option === undefined) return;
        onChange({
          mode: "set",
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
          // The board's own note on what the option means, where GitHub shows it —
          // supplementary, so it stays off the row's visible chrome.
          title={option.description || undefined}
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

/** A multi-select field's options as checkbox rows. The picked set REPLACES what
 *  every eligible card holds — a bulk write has no per-card set to add to. */
function MultiSelectRows({
  def,
  update,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "multiSelect" }>;
  update: ProjectFieldValueUpdate | undefined;
  lockedReason?: string;
  onChange: (entry: RowDraft) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const picked = new Set(
    update?.kind === "multiSelect" ? update.optionIds : [],
  );
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
    const next = def.options
      .filter(
        (option) =>
          (picked.has(option.id) || option.id === optionId) &&
          (option.id !== optionId || on),
      )
      .map((option) => option.id);
    // An emptied set is not a clear: this dialog's Clear arm is the way to unset a
    // field, and an empty "Set to" is a pick not yet made.
    if (next.length === 0) {
      onChange(INVALID_DRAFT);
      return;
    }
    onChange({
      mode: "set",
      update: { kind: "multiSelect", fieldId: def.id, optionIds: next },
    });
  }

  return (
    // Unstyled but NOT removable: it hosts the key handler, and `listKeyboardNav`
    // finds the row to focus by querying within this element.
    <div onKeyDown={onKeyDown}>
      {def.options.map((option) => (
        <label
          key={option.id}
          className={cn(
            ROW_CLASS,
            lockedReason && "cursor-not-allowed",
            activeId === option.id && "bg-muted/60",
          )}
          title={option.description || undefined}
        >
          <Checkbox
            data-row={option.id}
            tabIndex={navIndexById.get(option.id) === focusIndex ? 0 : -1}
            checked={picked.has(option.id)}
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
 *  their own caption — assignable, but not what a board means by "the current one". */
function IterationRows({
  def,
  update,
  lockedReason,
  onChange,
}: {
  def: Extract<WritableFieldDef, { kind: "iteration" }>;
  update: ProjectFieldValueUpdate | undefined;
  lockedReason?: string;
  onChange: (entry: RowDraft) => void;
}) {
  const { iterations, completedIterations } = def;
  const all = [...iterations, ...completedIterations];
  // The reason IS the row's text: nothing here is focusable, so a tooltip or an
  // aria-disabled flag would reach no one.
  if (all.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-muted-foreground">
        {NO_ITERATIONS_REASON}
      </p>
    );
  }
  const picked = update?.kind === "iteration" ? update.iterationId : "";
  return (
    <RadioGroup
      className="gap-0"
      aria-label={def.name}
      value={picked}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const iteration = all.find((it) => it.id === next);
        if (iteration === undefined) return;
        onChange({
          mode: "set",
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
