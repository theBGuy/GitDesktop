import type { WorkflowInput } from "@/lib/github/actions";

/** GitHub's documented `workflow_dispatch` limits: top-level inputs per dispatch,
 *  and characters in the serialized inputs payload. */
export const MAX_DISPATCH_INPUTS = 25;
export const MAX_DISPATCH_INPUT_CHARS = 65_535;

/** A choice field's "(none)" selection; option selections are their array index. */
export const CHOICE_NONE = "none";

/** One typed field seeded from a declared input. `value` is the control's own
 *  value: the text for string/number/environment, "true"/"false" for a boolean,
 *  and for a choice an option index as a string, {@link CHOICE_NONE}, or "" for
 *  no selection. Index keys keep duplicate or "none"-spelled options distinct. */
export interface DispatchField {
  input: WorkflowInput;
  /** The choice options, first occurrence of each string kept; [] otherwise. */
  options: string[];
  /** Whether a choice offers the "(none)" row: optional with no valid default. */
  none: boolean;
  value: string;
  dirty: boolean;
}

/** A free-form name/value row (the "Additional inputs" panel). */
export interface DispatchRow {
  id: number;
  key: string;
  value: string;
}

function dedupe(options: string[]): string[] {
  return [...new Set(options)];
}

function seedField(input: WorkflowInput): DispatchField {
  switch (input.type) {
    case "boolean":
      return {
        input,
        options: [],
        none: false,
        value: input.default === "true" ? "true" : "false",
        dirty: false,
      };
    case "choice": {
      const options = dedupe(input.options);
      const at = input.default === null ? -1 : options.indexOf(input.default);
      const none = !input.required && at < 0;
      const value = (() => {
        switch (true) {
          case at >= 0:
            return String(at);
          case none:
            return CHOICE_NONE;
          default:
            return "";
        }
      })();
      return { input, options, none, value, dirty: false };
    }
    case "string":
    case "number":
    case "environment":
      return {
        input,
        options: [],
        none: false,
        value: input.default ?? "",
        dirty: false,
      };
  }
}

/** Fields for a freshly landed schema, in the file order the probe delivered. */
export function seedFields(inputs: WorkflowInput[]): DispatchField[] {
  return inputs.map(seedField);
}

/** The option string a choice field's value selects, or null for none. */
function choiceOption(field: DispatchField): string | null {
  if (field.value === "" || field.value === CHOICE_NONE) return null;
  return field.options[Number(field.value)] ?? null;
}

/** A schema landing for the workflow already shown: an untouched field takes the
 *  new default, and an edited one keeps its value while an input of the same name
 *  and type is still declared (a choice also needs its option to survive). */
export function reseedFields(
  prev: DispatchField[],
  inputs: WorkflowInput[],
): DispatchField[] {
  const byName = new Map(prev.map((f) => [f.input.name, f]));
  return inputs.map((input) => {
    const fresh = seedField(input);
    const old = byName.get(input.name);
    if (!old?.dirty || old.input.type !== input.type) return fresh;
    if (input.type !== "choice")
      return { ...fresh, value: old.value, dirty: true };
    if (old.value === CHOICE_NONE) {
      return fresh.none ? { ...fresh, value: CHOICE_NONE, dirty: true } : fresh;
    }
    const picked = choiceOption(old);
    const at = picked === null ? -1 : fresh.options.indexOf(picked);
    return at >= 0 ? { ...fresh, value: String(at), dirty: true } : fresh;
  });
}

/** The control value a free row's text becomes in `field`, or null when the
 *  control can't hold it (a boolean takes only "true"/"false", a choice only one
 *  of its option strings). */
function heldValue(field: DispatchField, text: string): string | null {
  switch (field.input.type) {
    case "boolean":
      return text === "true" || text === "false" ? text : null;
    case "choice": {
      const at = field.options.indexOf(text);
      return at >= 0 ? String(at) : null;
    }
    case "string":
    case "number":
    case "environment":
      return text;
  }
}

const nameKey = (name: string) => name.trim().toLowerCase();

/** Moves each free row naming a declared input (case-insensitively) into that
 *  field as an edit, when the control can hold its value. An edited field is never
 *  overwritten, and each field absorbs at most one row: a row left behind holds
 *  Run as a duplicate. `absorbed` maps each moved row's id to its field's name. */
export function absorbRows(
  fields: DispatchField[],
  rows: DispatchRow[],
): {
  fields: DispatchField[];
  rows: DispatchRow[];
  absorbed: Map<number, string>;
} {
  const next = [...fields];
  const absorbed = new Map<number, string>();
  const kept: DispatchRow[] = [];
  for (const row of rows) {
    const key = nameKey(row.key);
    const at = key
      ? next.findIndex((f) => !f.dirty && nameKey(f.input.name) === key)
      : -1;
    const value = at >= 0 ? heldValue(next[at], row.value) : null;
    if (value === null) {
      kept.push(row);
      continue;
    }
    next[at] = { ...next[at], value, dirty: true };
    absorbed.set(row.id, next[at].input.name);
  }
  return absorbed.size === 0
    ? { fields, rows, absorbed }
    : { fields: next, rows: kept, absorbed };
}

/** "Enter a number" while a number field holds text that isn't one. Advisory:
 *  GitHub's own validation of number inputs decides, so this never holds Run. */
export function numberWarning(value: string): string | null {
  const v = value.trim();
  return v !== "" && !Number.isFinite(Number(v)) ? "Enter a number" : null;
}

/** The inputs a dispatch sends, or the first reason it can't go yet, ranked:
 *  a required text field left blank, a required choice unpicked, a free row
 *  repeating a declared name, two free rows sharing a name, then GitHub's caps
 *  over the record that would be sent. */
export function buildDispatch(
  fields: DispatchField[],
  rows: DispatchRow[],
): { record: Record<string, string>; hold: string | undefined } {
  const held = (hold: string) => ({ record: {}, hold });
  const blank = fields.find(
    (f) =>
      f.input.required &&
      f.input.type !== "boolean" &&
      f.input.type !== "choice" &&
      f.value.trim() === "",
  );
  if (blank) return held(`Enter a value for '${blank.input.name}'`);
  const unpicked = fields.find(
    (f) =>
      f.input.required && f.input.type === "choice" && choiceOption(f) === null,
  );
  if (unpicked) return held(`Choose a value for '${unpicked.input.name}'`);

  const declared = new Map(fields.map((f) => [nameKey(f.input.name), f]));
  const named = rows.filter((r) => r.key.trim() !== "");
  for (const row of named) {
    const twin = declared.get(nameKey(row.key));
    if (twin) return held(`'${twin.input.name}' is already an input above`);
  }
  const seen = new Map<string, string>();
  for (const row of named) {
    const k = nameKey(row.key);
    const first = seen.get(k);
    if (first !== undefined) return held(`'${first}' is listed twice`);
    seen.set(k, row.key.trim());
  }

  const record: Record<string, string> = {};
  for (const f of fields) {
    const sent = sentValue(f);
    if (sent !== null) record[f.input.name] = sent;
  }
  for (const row of named) record[row.key.trim()] = row.value;

  const count = Object.keys(record).length;
  if (count > MAX_DISPATCH_INPUTS) {
    return held(`Too many inputs (${count} of ${MAX_DISPATCH_INPUTS})`);
  }
  const chars = JSON.stringify(record).length;
  if (chars > MAX_DISPATCH_INPUT_CHARS) {
    return held(
      `Inputs too long (${chars.toLocaleString()} of ${MAX_DISPATCH_INPUT_CHARS.toLocaleString()} characters)`,
    );
  }
  return { record, hold: undefined };
}

/** What one field sends, or null to omit it. An empty text field is omitted
 *  unless it was cleared over a non-empty default, which only "" can override. */
function sentValue(field: DispatchField): string | null {
  switch (field.input.type) {
    case "boolean":
      return field.value === "true" ? "true" : "false";
    case "choice":
      return choiceOption(field);
    case "string":
    case "number":
    case "environment":
      if (field.value !== "") return field.value;
      return field.dirty && (field.input.default ?? "") !== "" ? "" : null;
  }
}
