// Pure, import-free: node test suites import this file through Node's type
// stripping, which resolves no aliases.

/** A structural twin of `ForgeUserRef`, so this module stays import-free. */
export interface PickerUser {
  id: string;
  label: string;
  avatarUrl: string;
  isBot: boolean;
}

/** The footer line under a list the backend walk cut at its ceiling. The
 *  number comes from the wire (`ForgeUserList.ceiling`), never a table here. */
export function ceilingNote(ceiling: number): string {
  return `Showing the first ${ceiling.toLocaleString("en-US")} users.`;
}

export const PICKER_LEGEND =
  "Type to filter. Tab or ↑↓ moves, Space selects, Esc closes.";
export const PICKER_APPLY_NOTE = "Changes apply when this closes.";
export const PICKER_NO_MATCH = "No matching users.";
/** Every row is a fixed `h-9`, so the virtualizer needs no measuring. */
export const PICKER_ROW_HEIGHT = 36;
/** The rail's `py-2`: the rows' spacer sits this far below the scroll origin. */
export const PICKER_RAIL_PAD = 8;

/** Lowercased label, then id, compared by code unit: the same rule as the
 *  backend's `ForgeUserList::build` sort, so never `localeCompare`. */
export function compareUsers(a: PickerUser, b: PickerUser): number {
  const la = a.label.toLowerCase();
  const lb = b.label.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** The users selected when the picker opened, in the backend's order. */
export function sortedSnapshot<U extends PickerUser>(
  selected: readonly U[],
): U[] {
  return [...selected].sort(compareUsers);
}

/** The picker's rows: the open-time snapshot first (a fetched ref replaces its
 *  snapshot twin in place), then fetched users, then any checked user in
 *  neither list, so every pending selection keeps a row. The filter applies to
 *  both groups after the split; `restStart` counts the visible selected rows and
 *  `total` the rows before filtering. */
export function buildPickerRows<U extends PickerUser>(input: {
  fetched: readonly U[] | undefined;
  snapshot: readonly U[];
  checked: ReadonlyMap<string, U>;
  filter: string;
}): { rows: U[]; restStart: number; total: number } {
  const fetched = input.fetched ?? [];
  const byId = new Map(fetched.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const selected: U[] = [];
  for (const u of input.snapshot) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    selected.push(byId.get(u.id) ?? u);
  }
  const rest: U[] = [];
  for (const u of [...fetched, ...input.checked.values()]) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    rest.push(u);
  }
  const q = input.filter.trim().toLowerCase();
  const matches = (u: U) => q === "" || u.label.toLowerCase().includes(q);
  const shownSelected = selected.filter(matches);
  return {
    rows: [...shownSelected, ...rest.filter(matches)],
    restStart: shownSelected.length,
    total: selected.length + rest.length,
  };
}

/** "filter" | "retry" | `row:${id}`. */
export type PickerStop = string;
export const rowStop = (id: string): PickerStop => `row:${id}`;

/** Where a key moves the picker's cursor, or null for "no move" (the caller
 *  leaves the key alone). `stops` is `["filter", "retry"?, ...row stops]`. Tab
 *  wraps and never leaves the list of stops; the arrows walk the rows, clamp on
 *  the last one, and step from the first row back to the filter. */
export function nextPickerStop(input: {
  stops: readonly PickerStop[];
  from: PickerStop;
  key: "Tab" | "ArrowDown" | "ArrowUp";
  shift: boolean;
}): PickerStop | null {
  const { stops, from, key } = input;
  if (key === "Tab") {
    const n = stops.length;
    if (n === 0) return null;
    const i = stops.indexOf(from);
    if (i < 0) return input.shift ? stops[n - 1] : stops[0];
    return stops[(i + (input.shift ? n - 1 : 1)) % n];
  }
  const rows = stops.filter((s) => s.startsWith("row:"));
  if (key === "ArrowDown") {
    if (from === "filter") return rows[0] ?? null;
    const r = rows.indexOf(from);
    return r < 0 ? null : (rows[r + 1] ?? null);
  }
  const r = rows.indexOf(from);
  if (r < 0) return null;
  return r === 0 ? "filter" : rows[r - 1];
}
