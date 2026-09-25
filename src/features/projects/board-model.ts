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

/** What one board item is called where it is drawn: a card on the board, a row in
 *  a table. Every string below that names the item is keyed on it, so the same
 *  hold reads in the words of the surface the user is looking at. */
export type ItemNoun = "card" | "row";

/** Single-writer past the move, for the same reason and one step wider: an archive,
 *  a removal, a convert and a draft edit all change what the board draws, so a
 *  second write fired over one in flight would settle against a board neither of
 *  them saw. Lives here rather than in either surface because both the panel's hold
 *  and the edit dialog's footer say it, and a copy each is a copy that can drift. */
export const ITEM_WRITE_REASON: Record<ItemNoun, string> = {
  card: "Finishing your last card change…",
  row: "Finishing your last row change…",
};

/** A draft's Notes field invitation, naming where the notes are read back. Shared by
 *  the new-draft and edit-draft dialogs, which both open from either surface. */
export const NOTES_PLACEHOLDER: Record<ItemNoun, string> = {
  card: "Markdown, rendered on the card",
  row: "Markdown, rendered in the row's details",
};

/** Why a search result can't be added: the surface already draws it. */
export const ALREADY_DRAWN_REASON: Record<ItemNoun, string> = {
  card: "Already on this board",
  row: "Already in this view",
};

/** Why a card can't be repositioned under a saved view that sorts: the columns are
 *  drawn in the sort's order, so the board's own manual order — the only thing a
 *  position write addresses — isn't what is on screen. Shared by the menu's held
 *  row and the keyboard route's announcement, for the same reason
 *  `ITEM_WRITE_REASON` lives here — one copy the two surfaces can't drift apart. */
export const SORTED_VIEW_REASON: Record<ItemNoun, string> = {
  card: "This view orders cards by its sort",
  row: "This view orders rows by its sort",
};

/** Why a table row can't be repositioned while the view groups its rows: the
 *  menu's held row and the keyboard route's announcement, one copy for both. */
export const GROUPED_ROWS_REASON = "Rows reposition only in an ungrouped view";

/** Why a downward move is refused at the loaded end: more of the column may live
 *  in pages the board hasn't fetched, so the card's real neighbour there is
 *  unknown. The keyboard route's announcement, where a full sentence fits. */
export const TRUNCATED_ORDER_REASON: Record<ItemNoun, string> = {
  card: "Load more cards to move past the loaded end",
  row: "Load more rows to move past the loaded end",
};

/** The same refusal as a terse menu-row parenthetical. A menu label can't take the
 *  full {@link TRUNCATED_ORDER_REASON} sentence, so the two deliberately differ in
 *  register: the row hints, the announcement explains. */
export const TRUNCATED_ROW_REASON = "load more first";

/** Why a card's placement and content rows are held while it is ARCHIVED: an
 *  archived card sits in no column and in none of the board's position order, so
 *  every write addressing either has nothing to address. Shared by the menu's held
 *  rows and the keyboard route's announcement, for the reason
 *  {@link ITEM_WRITE_REASON} lives here — one copy the two surfaces can't drift. */
export const ARCHIVED_ITEM_REASON: Record<ItemNoun, string> = {
  card: "Restore this card to change it",
  row: "Restore this row to change it",
};

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
 *  labels, milestone, …) is a list or a reference this build defines no order
 *  for. Tested on `dataType`, never the name — the field is renamable. */
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

/** The keys of `sortBy` this build honours, in the view's order — the ones
 *  {@link sortColumnItems} actually sorts by, and so the only ones a header may
 *  claim. An empty result from a non-empty `sortBy` is a view whose whole sort
 *  was dropped. */
export function honouredSortKeys(
  sortBy: ProjectViewSort[],
  fields: ProjectFieldDef[],
): ProjectViewSort[] {
  return sortBy.filter(
    (sort) => sortableDef(fields.find((f) => f.id === sort.fieldId)) !== null,
  );
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
 * rest of that bucket on the issue itself, which the card has no chip form
 * for. Excluded by KIND, never by name, the same way the field
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

/** One column of a TABLE view: the field it reads, and whether it is the Title
 *  column, which draws the item's own head line rather than a field value. */
export interface TableColumn {
  def: ProjectFieldDef;
  title: boolean;
}

/** Title is a `system` field told apart by `dataType`, never by its renamable
 *  name. */
function isTitleDef(def: ProjectFieldDef): boolean {
  return def.kind === "system" && def.dataType === "TITLE";
}

/** Stands in for a Title definition the board's field read didn't carry, so a
 *  table always has a column that names its rows. */
const FALLBACK_TITLE_DEF: ProjectFieldDef = {
  kind: "system",
  id: "__title__",
  name: "Title",
  dataType: "TITLE",
};

/**
 * A table view's columns: its visible fields in the view's own order, system
 * fields included, with Title moved first so it can stay pinned while the rest
 * scroll. An id the field read didn't return is skipped — there is no name to
 * head it with. A view that resolves to nothing still gets a Title column.
 */
export function tableColumns(
  view: ProjectViewDef,
  fields: ProjectFieldDef[],
): TableColumn[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const columns: TableColumn[] = [];
  for (const id of view.visibleFieldIds) {
    const def = byId.get(id);
    if (def === undefined || seen.has(id)) continue;
    seen.add(id);
    columns.push({ def, title: isTitleDef(def) });
  }
  const at = columns.findIndex((column) => column.title);
  if (at > 0) columns.unshift(...columns.splice(at, 1));
  if (columns.length === 0)
    return [
      { def: fields.find(isTitleDef) ?? FALLBACK_TITLE_DEF, title: true },
    ];
  return columns;
}

/**
 * What `item` holds for a table column, or undefined when it holds nothing
 * renderable. A board-defined field's value must match the definition's kind (a
 * wire shape that disagrees is not a value of this field); a `system` column
 * takes whichever typed arm GitHub sent for it. Assignees and Repository fall
 * back to the item's own content where the field value is absent, which is the
 * same data the board card draws.
 */
export function columnValue(
  item: BoardItem,
  def: ProjectFieldDef,
): ProjectFieldValue | undefined {
  // A DRAFT's own assignees are authoritative over its typed value: they change
  // only through this app's draft editor, whose write patches the content but
  // whose answer carries no field values — so the typed copy is the stale one.
  // An issue's or pull request's are edited on GitHub, where both copies go stale
  // together and the typed one keeps its "+N".
  if (
    def.kind === "system" &&
    def.dataType === "ASSIGNEES" &&
    item.content.kind === "draft"
  )
    return item.content.assignees.length === 0
      ? undefined
      : {
          kind: "users",
          fieldId: def.id,
          fieldName: def.name,
          totalCount: item.content.assignees.length,
          users: item.content.assignees,
          isIssueField: false,
        };
  for (const value of item.fieldValues) {
    if (value.kind === "unknown" || value.fieldId !== def.id) continue;
    if (def.kind === "system" || value.kind === def.kind) return value;
  }
  if (def.kind !== "system") return undefined;
  const content = item.content;
  if (
    def.dataType === "ASSIGNEES" &&
    "assignees" in content &&
    content.assignees.length > 0
  )
    return {
      kind: "users",
      fieldId: def.id,
      fieldName: def.name,
      totalCount: content.assignees.length,
      users: content.assignees,
      isIssueField: false,
    };
  if (def.dataType === "REPOSITORY" && "repoNameWithOwner" in content)
    return {
      kind: "repository",
      fieldId: def.id,
      fieldName: def.name,
      nameWithOwner: content.repoNameWithOwner,
      isIssueField: false,
    };
  return undefined;
}

/** A table row's identity. Prefixed per row kind so an item and a group header
 *  can never share a key, in React or in the cursor. */
const ITEM_ROW_PREFIX = "item:";

export function itemRowKey(itemId: string): string {
  return `${ITEM_ROW_PREFIX}${itemId}`;
}

export function groupRowKey(bucketId: string): string {
  return `group:${bucketId}`;
}

/** One entry of a table's flat row list: a group section's header, or an item. */
export type TableEntry =
  | {
      kind: "group";
      key: string;
      bucketId: string;
      label: string;
      color: string | null;
      count: number;
      expanded: boolean;
    }
  | { kind: "item"; key: string; item: BoardItem };

/**
 * The table's rows as one flat list: with `grouped`, each non-empty bucket as a
 * header followed by its items, and a COLLAPSED bucket's items left out
 * entirely — so the keyboard walk and a Shift range both skip them by
 * construction. Without it, the single column's items alone. An empty bucket
 * draws no header: it has nothing to collapse and nothing to count.
 */
export function tableRows(
  columns: BoardColumnModel[],
  grouped: boolean,
  collapsed: ReadonlySet<string>,
): TableEntry[] {
  const rows: TableEntry[] = [];
  for (const column of columns) {
    if (grouped) {
      if (column.items.length === 0) continue;
      const expanded = !collapsed.has(column.id);
      rows.push({
        kind: "group",
        key: groupRowKey(column.id),
        bucketId: column.id,
        label: column.label,
        color: column.color,
        count: column.items.length,
        expanded,
      });
      if (!expanded) continue;
    }
    for (const item of column.items)
      rows.push({ kind: "item", key: itemRowKey(item.itemId), item });
  }
  return rows;
}

/** Where `itemId` sits among the DRAWN item rows, group headers and a collapsed
 *  section's rows excluded, or null when it isn't drawn. */
export function itemRowSlot(rows: TableEntry[], itemId: string): number | null {
  let slot = 0;
  for (const row of rows) {
    if (row.kind !== "item") continue;
    if (row.item.itemId === itemId) return slot;
    slot += 1;
  }
  return null;
}

/** The item now filling a departed row's flat `slot`, clamped to the last drawn
 *  item row, or null with none drawn. FLAT across sections: a section is a board
 *  column, so the board's per-column slot would jump to the table's top whenever a
 *  removal emptied one. */
export function itemAtRowSlot(rows: TableEntry[], slot: number): string | null {
  const items = rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
  return items[Math.min(slot, items.length - 1)]?.itemId ?? null;
}

/** A table's keyboard cursor, by IDENTITY: the row's key and the column being
 *  walked. An index would name whichever row slid into the slot after a splice. */
export interface TableCursor {
  rowKey: string;
  colIndex: number;
}

/** A cursor resolved against the rows drawn right now. `colIndex` is the column
 *  being WALKED — a group header is one full-width cell and focuses that cell
 *  whatever it says, so walking through a header keeps the column. */
export interface TablePosition {
  rowIndex: number;
  colIndex: number;
}

/**
 * Where `cursor` stands in `rows`, clamped to the columns there are. An item
 * hidden inside a COLLAPSED group re-lands on that group's header rather than
 * stranding; an item the board no longer holds resolves to null, and the caller
 * falls back to the first row.
 */
export function resolveTableCursor(
  rows: TableEntry[],
  columns: BoardColumnModel[],
  cursor: TableCursor | null,
  colCount: number,
): TablePosition | null {
  if (cursor === null) return null;
  const colIndex = Math.max(Math.min(cursor.colIndex, colCount - 1), 0);
  const at = rows.findIndex((row) => row.key === cursor.rowKey);
  if (at !== -1) return { rowIndex: at, colIndex };
  for (const column of columns) {
    if (!column.items.some((item) => itemRowKey(item.itemId) === cursor.rowKey))
      continue;
    const header = rows.findIndex((row) => row.key === groupRowKey(column.id));
    return header === -1 ? null : { rowIndex: header, colIndex };
  }
  return null;
}

/** The ways the table's cursor moves: a row or column step, a row's ends, the
 *  table's ends, and a viewport's worth of rows. */
export type TableMove =
  | "up"
  | "down"
  | "left"
  | "right"
  | "rowStart"
  | "rowEnd"
  | "first"
  | "last"
  | "pageUp"
  | "pageDown";

/** Where `move` takes the cursor at `from`. Column moves on a group header do
 *  nothing: it has one cell. `pageSize` is how many rows a viewport holds. */
export function stepTableCursor(
  rows: TableEntry[],
  from: TablePosition,
  move: TableMove,
  colCount: number,
  pageSize: number,
): TablePosition {
  const lastRow = Math.max(rows.length - 1, 0);
  const lastCol = Math.max(colCount - 1, 0);
  const onGroup = rows[from.rowIndex]?.kind === "group";
  const page = Math.max(pageSize, 1);
  const { rowIndex, colIndex } = from;
  switch (move) {
    case "up":
      return { rowIndex: Math.max(rowIndex - 1, 0), colIndex };
    case "down":
      return { rowIndex: Math.min(rowIndex + 1, lastRow), colIndex };
    case "pageUp":
      return { rowIndex: Math.max(rowIndex - page, 0), colIndex };
    case "pageDown":
      return { rowIndex: Math.min(rowIndex + page, lastRow), colIndex };
    case "first":
      return { rowIndex: 0, colIndex };
    case "last":
      return { rowIndex: lastRow, colIndex };
    case "left":
      return onGroup ? from : { rowIndex, colIndex: Math.max(colIndex - 1, 0) };
    case "right":
      return onGroup
        ? from
        : { rowIndex, colIndex: Math.min(colIndex + 1, lastCol) };
    case "rowStart":
      return onGroup ? from : { rowIndex, colIndex: 0 };
    default:
      return onGroup ? from : { rowIndex, colIndex: lastCol };
  }
}
