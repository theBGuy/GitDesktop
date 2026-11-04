// Imported by scripts/bulk-row-targets.test.mjs under Node's type stripping, so
// this module keeps to type-only imports.
import type { FileEntry } from "@/lib/git/types";

type Row = Pick<FileEntry, "path" | "origPath" | "staged" | "unstaged">;

/**
 * The record a Changes row names: the entry at `path` with the row's side
 * present. Git can list one path as two records (a staged `D.` beside an
 * untracked `?`), so a path alone doesn't pick the row's record. Undefined
 * means the row is stale. Same side test as ChangesPanel's `hasSide` and its
 * selection prune.
 */
export function rowEntry<T extends Row>(
  entries: readonly T[],
  path: string,
  staged: boolean,
): T | undefined {
  return entries.find(
    (e) =>
      e.path === path && (staged ? e.staged !== null : e.unstaged !== null),
  );
}

export interface BulkRowTargets<T> {
  /** Selected keys that resolved to a live record (the bulk-menu gate). */
  rowCount: number;
  /** Records of selected staged rows, in entries order (Unstage). */
  stagedRows: T[];
  /** Records of selected unstaged rows, in entries order; a path has one
   *  unstaged side, so one per path (Stage after the caller's filter, Discard). */
  unstagedRows: T[];
  /** One record per distinct selected path, the path's first record, in
   *  first-seen entries order (Stash, Ignore, Exclude from AI). */
  pathEntries: T[];
  /** Per distinct selected path, its first `canUntrack` record, if any
   *  (Untrack). */
  trackedPathEntries: T[];
  /** Selected paths with a present side (in any record) that no selected row
   *  covers: a path-level action takes that side or twin too. */
  splitPaths: string[];
}

/** Whether `git rm --cached` can untrack this record: it needs an index entry,
 *  so fresh untracked files, staged adds and staged deletions are out. One
 *  unmatched pathspec fails git's whole batch, so a bulk untrack must never
 *  carry one. Shared by the bulk and single-row menus. */
export function canUntrack(e: Pick<FileEntry, "staged" | "unstaged">): boolean {
  return (
    e.unstaged !== "untracked" && e.staged !== "added" && e.staged !== "deleted"
  );
}

/**
 * The targets of every Changes bulk action, from the selected row keys
 * (`staged:<path>` / `unstaged:<path>`). Row actions take the selected rows'
 * own records; path-level actions take each selected path once. Keys of any
 * other shape (folders, headers) and keys whose side is gone are skipped.
 */
export function bulkRowTargets<T extends Row>(
  selectedKeys: ReadonlySet<string>,
  entries: readonly T[],
): BulkRowTargets<T> {
  const stagedKeys = new Set<string>();
  const unstagedKeys = new Set<string>();
  for (const key of selectedKeys) {
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon);
    if (kind === "staged") stagedKeys.add(key.slice(colon + 1));
    else if (kind === "unstaged") unstagedKeys.add(key.slice(colon + 1));
  }

  const stagedRows: T[] = [];
  const unstagedRows: T[] = [];
  const stagedTaken = new Set<string>();
  const unstagedTaken = new Set<string>();
  for (const e of entries) {
    if (
      e.staged !== null &&
      stagedKeys.has(e.path) &&
      !stagedTaken.has(e.path)
    ) {
      stagedTaken.add(e.path);
      stagedRows.push(e);
    }
    if (
      e.unstaged !== null &&
      unstagedKeys.has(e.path) &&
      !unstagedTaken.has(e.path)
    ) {
      unstagedTaken.add(e.path);
      unstagedRows.push(e);
    }
  }

  const first = new Map<string, T>();
  const tracked = new Map<string, T>();
  const present = new Map<string, { staged: boolean; unstaged: boolean }>();
  for (const e of entries) {
    if (!stagedTaken.has(e.path) && !unstagedTaken.has(e.path)) continue;
    if (!first.has(e.path)) first.set(e.path, e);
    if (!tracked.has(e.path) && canUntrack(e)) tracked.set(e.path, e);
    const sides = present.get(e.path) ?? { staged: false, unstaged: false };
    if (e.staged !== null) sides.staged = true;
    if (e.unstaged !== null) sides.unstaged = true;
    present.set(e.path, sides);
  }
  const paths = [...first.keys()];

  return {
    rowCount: stagedRows.length + unstagedRows.length,
    stagedRows,
    unstagedRows,
    pathEntries: [...first.values()],
    trackedPathEntries: paths.flatMap((p) => tracked.get(p) ?? []),
    splitPaths: paths.filter((p) => {
      const sides = present.get(p);
      return (
        (sides?.staged === true && !stagedTaken.has(p)) ||
        (sides?.unstaged === true && !unstagedTaken.has(p))
      );
    }),
  };
}

/** One spelling of "this record is a conflict": either side reports it. The
 *  same population the stage gate's conflict-marker confirm covers. */
export function isConflictedEntry(
  e: Pick<FileEntry, "staged" | "unstaged">,
): boolean {
  return e.staged === "conflicted" || e.unstaged === "conflicted";
}

/**
 * Splits rows for a destructive Discard batch: `targets` go to git and
 * `conflicted` are left alone. Git refuses the whole restore on one unmerged
 * path after the app has already recycled the batch's untracked files, so a
 * conflicted row must never be sent. Order is kept on both sides.
 */
export function excludeConflicted<
  T extends Pick<FileEntry, "staged" | "unstaged">,
>(rows: readonly T[]): { targets: T[]; conflicted: T[] } {
  const targets: T[] = [];
  const conflicted: T[] = [];
  for (const row of rows)
    (isConflictedEntry(row) ? conflicted : targets).push(row);
  return { targets, conflicted };
}

/**
 * The confirm dialogs' "left as they are" sentence, "" when both counts are 0.
 * Each noun pluralizes by its own count; the verb is plural whenever both
 * counts are above 0 and agrees with its one noun otherwise.
 */
export function leftAloneSentence(hidden: number, conflicted: number): string {
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const hiddenPart = `${files(hidden)} hidden by the filter`;
  const conflictedPart = `${conflicted} conflicted file${conflicted === 1 ? "" : "s"}`;
  if (hidden > 0 && conflicted > 0)
    return `${hiddenPart} and ${conflictedPart} are left as they are.`;
  const one = hidden > 0 ? hidden : conflicted;
  if (one === 0) return "";
  const subject = hidden > 0 ? hiddenPart : conflictedPart;
  return one === 1
    ? `${subject} is left as it is.`
    : `${subject} are left as they are.`;
}
