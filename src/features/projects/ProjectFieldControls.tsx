import { useEffect, useEffectEvent, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import {
  DATE_ONLY,
  IterationRange,
  OptionValue,
} from "@/features/conversations/ProjectFieldValues";
import type {
  ProjectFieldDef,
  ProjectFieldOptionDef,
  ProjectFieldValue,
  ProjectFieldValueUpdate,
  ProjectIterationDef,
} from "@/lib/git/types";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/**
 * The per-kind project-field controls, and the draft rules behind them — the ONE
 * implementation the item's field editor, the board's bulk fields dialog and the
 * table's cell editor all draw from. The controls report neutral picks (raw text,
 * an option, an iteration, a set of options); each surface turns a pick into its
 * own draft model, which is the one thing the three legitimately differ on.
 */

/** The field kinds these controls can write. The built-in fields GitHub owns on
 *  the issue/PR itself (title, assignees, labels, milestone, repository, reviewers,
 *  tracking) arrive as `system`, so the exclusion is by KIND: a name-based one would
 *  miss a renamed built-in and catch a custom field that borrowed its name. */
export type WritableFieldDef = Exclude<ProjectFieldDef, { kind: "system" }>;

export function isWritable(def: ProjectFieldDef): def is WritableFieldDef {
  return def.kind !== "system";
}

/** One wording for every surface that holds an org issue-field: they gate on the
 *  same predicate and must not say it differently. */
export const ISSUE_FIELD_REASON =
  "Issue fields are edited on GitHub — board editing arrives later";
export const MULTILINE_TEXT_REASON = "Multi-line text is edited on GitHub";
export const NO_ITERATIONS_REASON =
  "This board's iteration field has no iterations to pick from yet";

/** A board text value the API wrote with line breaks in it. */
const MULTILINE = /[\r\n]/;

/** An org issue-field bridged onto a board. `updateProjectV2ItemFieldValue` is not
 *  its write path, so its control is held rather than hidden — the value still
 *  shows, and a missing control there would read as a broken render. */
export function isIssueFieldDef(def: WritableFieldDef): boolean {
  return def.kind !== "iteration" && def.isIssueField;
}

/** Why ONE field is held for an editor that SEEDS from the item's value, or
 *  `undefined` when it's editable; `seeded` is the value held now, which is what
 *  the multi-line arm protects. */
export function fieldLockedReason(
  def: WritableFieldDef,
  seeded: ProjectFieldValue | undefined,
): string | undefined {
  switch (true) {
    case isIssueFieldDef(def):
      return ISSUE_FIELD_REASON;
    // A single-line input strips CR/LF as the value is assigned to it, so the first
    // keystroke would draft the flattened string and the close would commit it — a
    // multi-line control belongs to a board surface if ever.
    case seeded?.kind === "text" && MULTILINE.test(seeded.text):
      return MULTILINE_TEXT_REASON;
    default:
      return undefined;
  }
}

/** One field's drafted VALUE: what it will read as once written, plus the write that
 *  puts it there. Both halves are built where the definitions are — the ids a write
 *  needs and the names a value renders live only there. */
export type CommittedDraft = {
  value: ProjectFieldValue;
  update: ProjectFieldValueUpdate;
};

/** A control holding an entry the browser can't parse. Measured in Chromium: a
 *  half-typed exponent ("1e", "-") and an unfinished date segment all report
 *  `value === ""` with `validity.badInput`, which is indistinguishable from the
 *  emptied control that MEANS clear — hence a third state rather than `null`. */
export const INVALID_DRAFT = "invalid";

/** One field's drafted state in the SEEDED model (the item's editor, a table cell):
 *  `null` is a drafted UNSET (the clear gesture); {@link INVALID_DRAFT} commits
 *  nothing at all, overriding any earlier draft. */
export type FieldDraft = CommittedDraft | typeof INVALID_DRAFT | null;

/** A value's identity for a no-op or agreement test. Kinds compare on what a write
 *  changes, so a multi-select reordered by the server still reads as unchanged, and
 *  an iteration renamed or rescheduled on the board is still the same iteration. */
export function valueKey(value: ProjectFieldValue | null | undefined): string {
  if (value === null || value === undefined) return "";
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

export type ScalarDef = Extract<
  WritableFieldDef,
  { kind: "text" | "number" | "date" }
>;

/** The initial text for a scalar field's input — what the value reads as in the
 *  control's own grammar, never a formatted one: a locale-grouped number or date
 *  would not survive the round trip back through this input. */
export function scalarText(
  def: ScalarDef,
  current: ProjectFieldValue | null,
): string {
  if (current === null) return "";
  if (def.kind === "text" && current.kind === "text") return current.text;
  if (def.kind === "number" && current.kind === "number")
    return Number.isFinite(current.number) ? String(current.number) : "";
  if (def.kind === "date" && current.kind === "date")
    return DATE_ONLY.test(current.date) ? current.date : "";
  return "";
}

/** Turns a scalar input's raw text into a SEEDED-model draft. Empty is an UNSET
 *  rather than an empty value — an empty text field and a missing one read the same
 *  on a board. (The bulk dialog, which has an explicit Clear arm, maps that unset
 *  to "nothing picked yet" on its own side.)
 *
 *  `badInput` is what separates the two ways a control reads empty: the user cleared
 *  it (clear), or the browser can't parse what's in it and reports `""` on their
 *  behalf (commit nothing). Without it, typing the "e" of "1e5" into a set field
 *  wipes the value on close. */
export function scalarDraft(
  def: ScalarDef,
  raw: string,
  badInput: boolean,
): FieldDraft {
  if (badInput) return INVALID_DRAFT;
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
  // Every intermediate of a typed 4-digit year is a valid date with a 1-3 digit one
  // ("2026-12-15" arrives as 0002-, 0020-, 0202- first), and no project dates year
  // <1000 — so the floor puts an unfinished year in the same commit-nothing state as
  // an unparseable entry, where a valid-looking wrong date would otherwise be written.
  if (Number(raw.split("-")[0]) < 1000) return INVALID_DRAFT;
  return {
    value: { kind: "date", ...base, date: raw },
    update: { kind: "date", fieldId: def.id, date: raw },
  };
}

/** The draft picking `option` of a single-select makes. */
export function singleSelectDraft(
  def: Extract<WritableFieldDef, { kind: "singleSelect" }>,
  option: ProjectFieldOptionDef,
): CommittedDraft {
  return {
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
  };
}

/** The draft a non-empty chosen set of a multi-select makes. */
export function multiSelectDraft(
  def: Extract<WritableFieldDef, { kind: "multiSelect" }>,
  options: ProjectFieldOptionDef[],
): CommittedDraft {
  return {
    value: {
      kind: "multiSelect",
      fieldId: def.id,
      fieldName: def.name,
      options,
      isIssueField: def.isIssueField,
    },
    update: {
      kind: "multiSelect",
      fieldId: def.id,
      optionIds: options.map((option) => option.id),
    },
  };
}

/** The draft picking `iteration` of an iteration field makes. */
export function iterationDraft(
  def: Extract<WritableFieldDef, { kind: "iteration" }>,
  iteration: ProjectIterationDef,
): CommittedDraft {
  return {
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
  };
}

/** Text / number / date. UNCONTROLLED: a number or date input mid-entry reports its
 *  value as `""` while still showing what was typed, so re-driving it from that value
 *  would blank the field under the user's cursor. The DOM keeps the text, the
 *  caller's draft keeps the meaning, and a caller that needs a fresh control remounts
 *  this via its `key`. */
export function ScalarInput({
  id,
  def,
  defaultValue,
  lockedReason,
  onEdit,
}: {
  id: string;
  def: ScalarDef;
  /** The seeded text, for a surface that edits the value the item holds now. */
  defaultValue?: string;
  lockedReason?: string;
  /** Every edit, as the control's raw text and whether the browser could parse it. */
  onEdit: (raw: string, badInput: boolean) => void;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  // The last state reported, seeded from the mounted control so a reconcile that
  // finds nothing changed reports nothing.
  const lastRef = useRef<{ raw: string; badInput: boolean } | null>(null);
  const onInput = useEffectEvent((el: HTMLInputElement) => {
    const raw = el.value;
    const badInput = el.validity.badInput;
    const last = lastRef.current;
    if (last !== null && last.raw === raw && last.badInput === badInput) return;
    lastRef.current = { raw, badInput };
    onEdit(raw, badInput);
  });
  // A NATIVE listener, not React's `onChange`: React gates its synthetic change on
  // the input's exposed value STRING (`updateValueIfChanged`, react-dom-client
  // :1592), so an edit that leaves that string `""` is never delivered. Both such
  // edits flip badInput and so decide whether this field clears — typing the "-" of
  // "-5" into a just-emptied field, and deleting it again to recover. Measured in
  // Chromium: the native `input` event fires for both and bubbles to this host.
  // Not for every such edit, though: clearing a date's LAST segment takes it from
  // "" + badInput to "" + parseable with NO input event (drive-measured), which
  // would strand the field's draft as unparseable. So keyup and focusout reconcile
  // too, reporting only a state that differs from the last one reported.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const input = host.querySelector("input");
    if (input !== null)
      lastRef.current = {
        raw: input.value,
        badInput: input.validity.badInput,
      };
    const handle = (e: Event) => {
      if (e.target instanceof HTMLInputElement) onInput(e.target);
    };
    for (const type of ["input", "keyup", "focusout"])
      host.addEventListener(type, handle);
    return () => {
      for (const type of ["input", "keyup", "focusout"])
        host.removeEventListener(type, handle);
    };
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
        // A native date input renders its own segment mask and ignores this, so only
        // the two free-text kinds get the invitation.
        placeholder={def.kind === "date" ? undefined : `Set ${def.name}…`}
        className="h-7"
        disabled={!!lockedReason}
        defaultValue={defaultValue}
      />
    </span>
  );
}

const ROW_CLASS =
  "flex cursor-pointer items-center gap-2 px-1 py-1 text-xs hover:bg-muted/60";

/** A single-select field's options as a radio group — one choice, and the group's
 *  own arrow-key navigation, which is what a radio group already is. */
export function SingleSelectRows({
  def,
  selectedId,
  lockedReason,
  ariaLabel,
  onPick,
}: {
  def: Extract<WritableFieldDef, { kind: "singleSelect" }>;
  /** The checked option's id, or `""` for none. */
  selectedId: string;
  lockedReason?: string;
  /** For a surface whose caption names the group some other way. */
  ariaLabel?: string;
  onPick: (option: ProjectFieldOptionDef) => void;
}) {
  return (
    // `gap-0` only: the rows carry their own padding, and the host popup or dialog
    // owns the scrolling — a cap here would nest a scrollbar inside that one.
    <RadioGroup
      className="gap-0"
      aria-label={ariaLabel}
      value={selectedId}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const option = def.options.find((o) => o.id === next);
        if (option !== undefined) onPick(option);
      }}
    >
      {def.options.map((option) => (
        <label
          key={option.id}
          // Which option a focused row is, for a host that acts on Enter itself.
          data-option-id={option.id}
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

/** A multi-select field's options as checkbox rows, the labels picker's shape. A
 *  toggle reports the WHOLE chosen set in the field's own option order; an empty set
 *  means something different to each surface, so it is reported as-is. */
export function MultiSelectRows({
  def,
  chosenIds,
  lockedReason,
  onChoose,
}: {
  def: Extract<WritableFieldDef, { kind: "multiSelect" }>;
  chosenIds: ReadonlySet<string>;
  lockedReason?: string;
  onChoose: (options: ProjectFieldOptionDef[]) => void;
}) {
  // Locked rows are skipped by the arrows rather than made focus black holes: a
  // natively-disabled checkbox can't take focus.
  const navRows = lockedReason ? [] : def.options;
  // No `tabAdvances`: these rows sit among other controls, so Tab has to keep
  // walking out of this list.
  const nav = useRovingRows({
    items: navRows,
    rowKey: (option) => option.id,
  });

  function toggle(optionId: string, on: boolean) {
    onChoose(
      def.options.filter(
        (option) =>
          (chosenIds.has(option.id) || option.id === optionId) &&
          (option.id !== optionId || on),
      ),
    );
  }

  return (
    // Unstyled but NOT removable — see `useRovingRows`. The host owns the
    // scrolling, so this list renders at natural height.
    <div onKeyDown={nav.onRowKeyDown}>
      {def.options.map((option) => (
        <label
          key={option.id}
          className={cn(
            ROW_CLASS,
            lockedReason && "cursor-not-allowed",
            nav.isActive(option) && "bg-muted/60",
          )}
          // See the single-select rows: the board's note on the option, hover-only.
          title={option.description || undefined}
        >
          <Checkbox
            {...nav.rowProps(option)}
            checked={chosenIds.has(option.id)}
            disabled={!!lockedReason}
            onCheckedChange={(v) => toggle(option.id, v === true)}
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
export function IterationRows({
  def,
  selectedId,
  lockedReason,
  ariaLabel,
  onPick,
}: {
  def: Extract<WritableFieldDef, { kind: "iteration" }>;
  /** The checked iteration's id, or `""` for none. An iteration the field no longer
   *  offers matches no row, so nothing is checked. */
  selectedId: string;
  lockedReason?: string;
  ariaLabel?: string;
  onPick: (iteration: ProjectIterationDef) => void;
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
  return (
    // `gap-0` only — see the single-select group: the host owns the scrolling.
    <RadioGroup
      className="gap-0"
      aria-label={ariaLabel}
      value={selectedId}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        const iteration = all.find((it) => it.id === next);
        if (iteration !== undefined) onPick(iteration);
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
    <label
      data-option-id={iteration.id}
      className={cn(ROW_CLASS, lockedReason && "cursor-not-allowed")}
    >
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
