// Whether the Changes list's multi-selection follows a shown-file change the
// panel didn't make (the conflict walk selecting a file). Import-free so
// scripts/shown-file-follow.test.mjs loads it under Node's type stripping.
// Keys use the panel's `"<section>:<path>"` spelling (section: staged|unstaged).

/** The multi-selection and shift-range anchor after the shown file moved, or
 *  null to leave both alone. Only a MOVE counts: the panel's own writes set the
 *  selection themselves, a clear has no row to follow, and a write that keeps
 *  the same file leaves a multi-selection around it intact. The new file's row
 *  becomes the whole selection, as a plain click would make it; a row the list
 *  doesn't show (collapsed section or folder, filtered out) is never added, so
 *  the selection empties instead. */
export function selectionFollowingShownFile(opts: {
  /** The shown file's key before the change; null = nothing was shown. */
  prevKey: string | null;
  /** The shown file's key now; null = the shown file was cleared. */
  nextKey: string | null;
  /** The panel itself wrote the shown file now on screen. */
  panelWrote: boolean;
  /** The file rows the list shows now, in nav order. */
  visibleKeys: readonly string[];
}): { keys: Set<string>; anchor: string | null } | null {
  const { prevKey, nextKey, panelWrote, visibleKeys } = opts;
  if (nextKey === null || panelWrote || nextKey === prevKey) return null;
  if (!visibleKeys.includes(nextKey)) return { keys: new Set(), anchor: null };
  return { keys: new Set([nextKey]), anchor: nextKey };
}
