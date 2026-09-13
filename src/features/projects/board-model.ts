import type { BoardItem, ProjectFieldDef } from "@/lib/git/types";

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

/** The option a board item sits under for `field`, or null when the field is
 *  unset on it. Matched on `optionId`, never the name: options are renamable. */
function optionIdFor(item: BoardItem, field: GroupField): string | null {
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
    { id: "__unset__", label: `No ${field.name}`, color: null, items: unset },
  ];
}

/** Where the board's single tab stop parks when the user hasn't moved it: the
 *  first card of the first column that has one. Null on an empty board. */
export function firstCardPosition(
  columns: BoardColumnModel[],
): { col: number; idx: number } | null {
  const col = columns.findIndex((column) => column.items.length > 0);
  return col === -1 ? null : { col, idx: 0 };
}
