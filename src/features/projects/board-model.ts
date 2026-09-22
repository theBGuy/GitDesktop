import type {
  BoardItem,
  ProjectFieldDef,
  ProjectFieldValue,
  ProjectViewDef,
  ProjectViewSort,
} from "@/lib/git/types";

/** A board field that can group a board: one column per option, or per iteration.
 *  Narrowed off the shared union so the column builder can read each kind's own
 *  bucket list without re-testing the rest of it. */
export type GroupField = Extract<
  ProjectFieldDef,
  { kind: "singleSelect" | "iteration" }
>;

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

/** The fields a board can be grouped by, in the board's own field order: its
 *  single-selects and its iteration fields. Issue fields (GitHub's own
 *  single-selects, which this build can't write) group just as well as
 *  board-defined ones, so they stay in. */
export function groupableFields(fields: ProjectFieldDef[]): GroupField[] {
  return fields.filter(
    (f): f is GroupField => f.kind === "singleSelect" || f.kind === "iteration",
  );
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

/** Why a card can't be repositioned under a saved view that sorts: the columns are
 *  drawn in the sort's order, so the board's own manual order — the only thing a
 *  position write addresses — isn't what is on screen. Shared by the menu's held
 *  row and the keyboard route's announcement, for the same reason
 *  `CARD_WRITE_REASON` lives here — one copy the two surfaces can't drift apart. */
export const SORTED_VIEW_REASON = "This view orders cards by its sort";

/** Why a downward move is refused at the loaded end: more of the column may live
 *  in pages the board hasn't fetched, so the card's real neighbour there is
 *  unknown. The keyboard route's announcement, where a full sentence fits. */
export const TRUNCATED_ORDER_REASON =
  "Load more cards to move past the loaded end";

/** The same refusal as a terse menu-row parenthetical. A menu label can't take the
 *  full {@link TRUNCATED_ORDER_REASON} sentence, so the two deliberately differ in
 *  register: the row hints, the announcement explains. */
export const TRUNCATED_ROW_REASON = "load more first";

/** Why a card's placement and content rows are held while it is ARCHIVED: an
 *  archived card sits in no column and in none of the board's position order, so
 *  every write addressing either has nothing to address. Shared by the menu's held
 *  rows and the keyboard route's announcement, for the reason
 *  {@link CARD_WRITE_REASON} lives here — one copy the two surfaces can't drift. */
export const ARCHIVED_CARD_REASON = "Restore this card to change it";

/** Why NO card can be repositioned while archived cards are drawn: GitHub refuses
 *  an archived item as a position anchor, so a card's drawn neighbour is not
 *  necessarily one a write may land it after. Naming the control that clears it,
 *  since the state is the user's own toggle rather than the board's. */
export const ARCHIVED_SHOWN_REASON =
  "Turn off Show archived cards to reposition";

/** The bucket a board item sits in for `field`, or null when the field is unset on
 *  it: a single-select's `optionId`, an iteration field's `iterationId`. Matched on
 *  the id, never the name — options are renamable and an iteration's title and dates
 *  are editable on the board. Exported so a surface acting on the VALUE reads it the
 *  same way the bucketing does — the catch-all holds unset cards AND cards whose
 *  stored id the field no longer defines, so a column is not a value. */
export function bucketIdFor(item: BoardItem, field: GroupField): string | null {
  for (const value of item.fieldValues) {
    if (
      field.kind === "singleSelect" &&
      value.kind === "singleSelect" &&
      value.fieldId === field.id
    )
      return value.optionId;
    if (
      field.kind === "iteration" &&
      value.kind === "iteration" &&
      value.fieldId === field.id
    )
      return value.iterationId;
  }
  return null;
}

/** One column the grouping field defines, before any card lands in it.
 *  `droppable` marks a bucket that is only drawn once something is in it. */
interface GroupBucket {
  id: string;
  label: string;
  color: string | null;
  droppable: boolean;
}

/**
 * The buckets `field` defines, in the order the board draws them.
 *
 * A single-select offers its options. An iteration field offers its CURRENT and
 * upcoming iterations always, empty ones included — a board grouped by iteration is
 * there to show what the next ones hold — then its COMPLETED iterations only where
 * they still hold a card: a long-running project accumulates dozens of finished
 * iterations, and drawing every empty one would bury the columns that matter. The
 * deliberate consequence is that "Move to" can't target an undrawn empty completed
 * iteration; the field editor on an issue or pull request still assigns into one.
 */
function groupBuckets(field: GroupField): GroupBucket[] {
  if (field.kind === "singleSelect")
    return field.options.map((option) => ({
      id: option.id,
      label: option.name,
      color: option.color,
      droppable: false,
    }));
  // No colour on any iteration column: GitHub gives iterations none, and the header
  // and the menu rows both take the null arm for exactly that.
  return [
    ...field.iterations.map((iteration) => ({
      id: iteration.id,
      label: iteration.title,
      color: null,
      droppable: false,
    })),
    ...field.completedIterations.map((iteration) => ({
      id: iteration.id,
      label: iteration.title,
      color: null,
      droppable: true,
    })),
  ];
}

/**
 * The board's columns: one per bucket of `field` in the field's own order, then a
 * trailing catch-all for the items that don't carry it — including any whose stored
 * id the field no longer defines, which would otherwise vanish from a board that
 * still holds them. With no `field` the whole board is one column.
 *
 * ARCHIVED items are the CALLER's one decision — the View options toggle — and it is
 * made here rather than at the call site so the column counts, the keyboard walk and
 * the card menu can't disagree about what the board contains.
 */
export function buildColumns(
  items: BoardItem[],
  field: GroupField | null,
  includeArchived: boolean,
): BoardColumnModel[] {
  const drawn = includeArchived
    ? items
    : items.filter((item) => !item.isArchived);
  if (field === null)
    return [{ id: "all", label: "All items", color: null, items: drawn }];
  const buckets = groupBuckets(field);
  const byBucket = new Map<string, BoardItem[]>();
  for (const bucket of buckets) byBucket.set(bucket.id, []);
  const unset: BoardItem[] = [];
  for (const item of drawn) {
    const id = bucketIdFor(item, field);
    const into = id === null ? undefined : byBucket.get(id);
    (into ?? unset).push(item);
  }
  return [
    // A droppable bucket is dropped only when EMPTY, so no card is ever bucketed
    // into a column the board then declines to draw.
    ...buckets
      .map((bucket) => ({ ...bucket, items: byBucket.get(bucket.id) ?? [] }))
      .filter((column) => !column.droppable || column.items.length > 0)
      .map(({ droppable: _droppable, ...column }) => column),
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

/** Whether `view` orders the cards itself. ONE reading for both consumers: the
 *  columns apply {@link sortColumnItems} exactly when this is true, and a
 *  reposition is refused exactly then — the board's own POSITION order is what a
 *  position write addresses, and a sorted view doesn't draw it. A type predicate
 *  so the sorting branch keeps the view narrowed. */
export function lensSorted(
  view: ProjectViewDef | null,
): view is ProjectViewDef {
  return view !== null && view.sortBy.length > 0;
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
