import type {
  BoardItem,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectViewDef,
  ProjectViewSort,
} from "@/lib/git/types";

/** A board field that can group a board: one column per option. Narrowed off the
 *  shared union so the column builder can read `options` without re-testing. */
export type GroupField = Extract<ProjectFieldDef, { kind: "singleSelect" }>;

export interface BoardColumnModel {
  /** React key and the column's identity for the roving tab stop. */
  id: string;
  /** The header's words — also the column listbox's accessible name. */
  label: string;
  /** GitHub colour NAME for the header dot, or null for the catch-all columns,
   *  which stand for the ABSENCE of a value rather than one of them. */
  color: string | null;
  items: BoardItem[];
}

/** The single-select fields a board can be grouped by, in the board's own field
 *  order. Issue fields (GitHub's own single-selects, which this build can't
 *  write) group just as well as board-defined ones, so they stay in. */
export function groupableFields(fields: ProjectFieldDef[]): GroupField[] {
  return fields.filter((f): f is GroupField => f.kind === "singleSelect");
}

/** The catch-all column's id. Not an option id — it stands for the ABSENCE of a
 *  value, which is what makes it the column a clear writes to. */
export const UNSET_COLUMN_ID = "__unset__";

/** Single-writer past the move, for the same reason and one step wider: an archive,
 *  a removal, a convert and a draft edit all change what the board draws, so a
 *  second write fired over one in flight would settle against a board neither of
 *  them saw. Lives here rather than in either surface because both the panel's hold
 *  and the edit dialog's footer say it, and a copy each is a copy that can drift. */
export const CARD_WRITE_REASON = "Finishing your last card change…";

/** The option a board item sits under for `field`, or null when the field is
 *  unset on it. Matched on `optionId`, never the name: options are renamable.
 *  Exported so a surface acting on the VALUE reads it the same way the bucketing
 *  does — the catch-all holds unset cards AND cards whose stored option the field
 *  no longer defines, so a column is not a value. */
export function optionIdFor(item: BoardItem, field: GroupField): string | null {
  for (const value of item.fieldValues) {
    if (value.kind === "singleSelect" && value.fieldId === field.id)
      return value.optionId;
  }
  return null;
}

/**
 * The board's columns: one per option of `field` in the field's own order, then
 * a trailing catch-all for the items that don't carry it — including any whose
 * stored option the field no longer defines, which would otherwise vanish from a
 * board that still holds them. With no `field` the whole board is one column.
 *
 * ARCHIVED items are dropped here rather than at the call site, so the column
 * counts, the board's own total, and the keyboard walk can't disagree about what
 * the board contains.
 */
export function buildColumns(
  items: BoardItem[],
  field: GroupField | null,
): BoardColumnModel[] {
  const live = items.filter((item) => !item.isArchived);
  if (field === null)
    return [{ id: "all", label: "All items", color: null, items: live }];
  const byOption = new Map<string, BoardItem[]>();
  for (const option of field.options) byOption.set(option.id, []);
  const unset: BoardItem[] = [];
  for (const item of live) {
    const optionId = optionIdFor(item, field);
    const bucket = optionId === null ? undefined : byOption.get(optionId);
    (bucket ?? unset).push(item);
  }
  return [
    ...field.options.map((option) => ({
      id: option.id,
      label: option.name,
      color: option.color,
      items: byOption.get(option.id) ?? [],
    })),
    {
      id: UNSET_COLUMN_ID,
      label: `No ${field.name}`,
      color: null,
      items: unset,
    },
  ];
}

/** The field kinds a saved view's sort can be honoured on. A key over any other
 *  kind — a multi-select, or a system field other than Title — is dropped
 *  rather than guessed at, which leaves the board's POSITION order for that key. */
type SortableDef = Extract<
  ProjectFieldDef,
  { kind: "text" | "number" | "date" | "singleSelect" | "iteration" | "system" }
>;

/** `def` as a sort key, or null where this build can't order by it. The `system`
 *  bucket is admitted for TITLE alone: a board sorted by its Title column orders
 *  by what the card already shows, where every other system field (assignees,
 *  labels, milestone, …) reaches an item as an `unknown` value with nothing to
 *  compare. Tested on `dataType`, never the name — the field is renamable. */
function sortableDef(def: ProjectFieldDef | undefined): SortableDef | null {
  if (def === undefined) return null;
  switch (def.kind) {
    case "text":
    case "number":
    case "date":
    case "singleSelect":
    case "iteration":
      return def;
    case "system":
      return def.dataType === "TITLE" ? def : null;
    default:
      return null;
  }
}

/** Whether `def`'s keys are WORDS, which collate in the user's locale rather than
 *  comparing by code unit. Title is text whichever bucket carries it. */
function collates(def: SortableDef): boolean {
  return def.kind === "text" || def.kind === "system";
}

/** One usable key of a view's sort, resolved once for the whole column. */
type SortKey = { def: SortableDef; descending: boolean; collate: boolean };

/** The item's value for `fieldId` as `kind`, or null when it carries none — the
 *  value's own kind has to match the definition's, since a wire shape that
 *  disagrees is not a value of this field. */
function valueOfKind<K extends ProjectFieldValue["kind"]>(
  item: BoardItem,
  fieldId: string,
  kind: K,
): Extract<ProjectFieldValue, { kind: K }> | null {
  for (const value of item.fieldValues) {
    if (value.kind !== kind) continue;
    if ("fieldId" in value && value.fieldId === fieldId)
      return value as Extract<ProjectFieldValue, { kind: K }>;
  }
  return null;
}

/** What `item` sorts by under `def`, or null when it holds no value for it. A
 *  single-select sorts by the option's POSITION in the field, which is the order
 *  the board itself draws those options in; an option the field no longer defines
 *  has no position, so it counts as unset. */
function sortKeyFor(item: BoardItem, def: SortableDef): string | number | null {
  switch (def.kind) {
    case "text": {
      const text = valueOfKind(item, def.id, "text")?.text.trim();
      return text === undefined || text === "" ? null : text;
    }
    case "number": {
      const number = valueOfKind(item, def.id, "number")?.number;
      return number !== undefined && Number.isFinite(number) ? number : null;
    }
    case "date": {
      const date = valueOfKind(item, def.id, "date")?.date;
      return date === undefined || date === "" ? null : date;
    }
    case "singleSelect": {
      const optionId = valueOfKind(item, def.id, "singleSelect")?.optionId;
      const at = def.options.findIndex((option) => option.id === optionId);
      return at === -1 ? null : at;
    }
    // TITLE, the only system field `sortableDef` admits. The title lives on the
    // item's CONTENT rather than in its field values, and a redacted item has
    // none at all — which sorts it last, like any other absent value.
    case "system": {
      const title = "title" in item.content ? item.content.title.trim() : "";
      return title === "" ? null : title;
    }
    // Iteration, the last kind admitted: its START date is the key.
    default: {
      const start = valueOfKind(item, def.id, "iteration")?.startDate;
      return start === undefined || start === "" ? null : start;
    }
  }
}

/** Two keys off the SAME field, so they are always the same JS type. Words
 *  collate in the user's locale; dates and iteration starts are GitHub's bare
 *  `YYYY-MM-DD`, where a plain string comparison IS chronological. */
function compareKeys(
  a: string | number,
  b: string | number,
  collate: boolean,
): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  if (collate) return left.localeCompare(right);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * One column's cards in a saved view's sort order. Keys apply in the view's own
 * order, each breaking the previous one's ties, and an item with no value for a
 * key sorts LAST whichever direction that key runs — a direction orders values,
 * and an absent one is not a small value.
 *
 * `toSorted` is stable, which is the rest of the contract: the input arrives in
 * the board's POSITION order, so every pair the keys can't separate keeps it, and
 * a view with no usable key leaves the column exactly as it was.
 */
export function sortColumnItems(
  items: BoardItem[],
  sortBy: ProjectViewSort[],
  fields: ProjectFieldDef[],
): BoardItem[] {
  const keys: SortKey[] = [];
  for (const sort of sortBy) {
    const def = sortableDef(fields.find((f) => f.id === sort.fieldId));
    if (def !== null)
      keys.push({
        def,
        descending: sort.direction === "desc",
        collate: collates(def),
      });
  }
  if (keys.length === 0) return items;
  // Keys are read ONCE per item, not once per comparison: reading one scans the
  // item's field values, and a select also walks the field's options — work a
  // comparator would repeat O(n log n) times over the same card.
  const rows = items.map((item) => ({
    item,
    keys: keys.map(({ def }) => sortKeyFor(item, def)),
  }));
  return rows
    .toSorted((a, b) => {
      for (const [i, key] of keys.entries()) {
        const left = a.keys[i];
        const right = b.keys[i];
        if (left === null && right === null) continue;
        if (left === null) return 1;
        if (right === null) return -1;
        const cmp = compareKeys(left, right, key.collate);
        if (cmp !== 0) return key.descending ? -cmp : cmp;
      }
      return 0;
    })
    .map((row) => row.item);
}

/**
 * The fields a card shows as chips under `view`: the view's own visible fields,
 * in its order, minus what the card already carries. The whole `system` kind
 * drops — title and assignees are structural on the card, and GitHub owns the
 * rest of that bucket on the issue itself, so their values arrive as `unknown`
 * with nothing to render. Excluded by KIND, never by name, the same way the field
 * editor excludes them. The grouped field drops too: the column the card sits in
 * is already that value.
 */
export function chipFieldDefs(
  view: ProjectViewDef | null,
  fields: ProjectFieldDef[],
  groupField: GroupField | null,
): ProjectFieldDef[] {
  if (view === null) return [];
  const byId = new Map(fields.map((field) => [field.id, field]));
  const chips: ProjectFieldDef[] = [];
  for (const id of view.visibleFieldIds) {
    if (id === groupField?.id) continue;
    const def = byId.get(id);
    if (def === undefined || def.kind === "system") continue;
    chips.push(def);
  }
  return chips;
}

/** Where the board's single tab stop parks when the user hasn't moved it: the
 *  first card of the first column that has one. Null on an empty board. */
export function firstCardPosition(
  columns: BoardColumnModel[],
): { col: number; idx: number } | null {
  const col = columns.findIndex((column) => column.items.length > 0);
  return col === -1 ? null : { col, idx: 0 };
}
