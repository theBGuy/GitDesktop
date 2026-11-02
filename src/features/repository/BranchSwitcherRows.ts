// The branch menu's flattened, windowed row model. Import-free (types only):
// scripts/branch-menu-rows.test.mjs loads it through Node's type stripping,
// which resolves no bundler aliases.

/** One row of the branch menu's single virtualized list. Archived rows reuse
 *  "local": they render through the same row. */
export type BranchMenuRow<L, R> =
  | { type: "local"; branch: L }
  | { type: "archived-header" }
  | { type: "remote-header" }
  | { type: "remote"; branch: R };

/** The shared context menu's target, by KEY only: the menu resolves the live
 *  row from the current data on every render, never from a captured object. */
export type BranchMenuTarget =
  | { kind: "local"; name: string }
  | { kind: "remote"; name: string; remote: string }
  | null;

/**
 * Flattens the menu's sections into the one row stream the virtualizer windows,
 * with the arrow keys' stops beside it. A collapsed section contributes its
 * header only, and headers are never arrow stops, so `navNames` is exactly the
 * rendered non-header rows in render order.
 */
export function buildBranchMenuRows<
  L extends { name: string },
  R extends { name: string; remote: string },
>(args: {
  visibleBranches: readonly L[];
  archivedBranches: readonly L[];
  showArchived: boolean;
  remoteOnly: readonly R[];
  showRemote: boolean;
  showRemoteSection: boolean;
}): { flatRows: BranchMenuRow<L, R>[]; navNames: string[] } {
  const flatRows: BranchMenuRow<L, R>[] = [];
  const navNames: string[] = [];
  for (const branch of args.visibleBranches) {
    flatRows.push({ type: "local", branch });
    navNames.push(branch.name);
  }
  if (args.archivedBranches.length > 0) {
    flatRows.push({ type: "archived-header" });
    if (args.showArchived)
      for (const branch of args.archivedBranches) {
        flatRows.push({ type: "local", branch });
        navNames.push(branch.name);
      }
  }
  if (args.showRemoteSection) {
    flatRows.push({ type: "remote-header" });
    if (args.showRemote)
      for (const branch of args.remoteOnly) {
        flatRows.push({ type: "remote", branch });
        navNames.push(branch.name);
      }
  }
  return { flatRows, navNames };
}

/** A row's identity, kind-prefixed so no branch name can collide with another
 *  kind's key. The remote form is length-prefixed because git allows `/` in a
 *  remote name: remote `a/b` + branch `c` and remote `a` + branch `b/c` stay
 *  distinct. */
export function rowKeyOf<
  L extends { name: string },
  R extends { name: string; remote: string },
>(row: BranchMenuRow<L, R>): string {
  switch (row.type) {
    case "local":
      return `local:${row.branch.name}`;
    case "remote":
      return `remote:${row.branch.remote.length}:${row.branch.remote}/${row.branch.name}`;
    case "archived-header":
      return "header:archived";
    case "remote-header":
      return "header:remote";
  }
}

/** The context-menu target a row offers; headers offer none. */
export function menuTargetOf<
  L extends { name: string },
  R extends { name: string; remote: string },
>(row: BranchMenuRow<L, R> | undefined): BranchMenuTarget {
  if (row?.type === "local") return { kind: "local", name: row.branch.name };
  if (row?.type === "remote")
    return { kind: "remote", name: row.branch.name, remote: row.branch.remote };
  return null;
}

/**
 * The flat indexes that must stay mounted, resolved from the CURRENT rows:
 * the arrow cursor's row and the row holding DOM focus (each by nav name, first
 * match like the rows' `data-row`), the context menu's target row (local by
 * name, remote by the remote + name pair), and the two headers. An absent one
 * is -1, which `mergePinnedIndexes` drops.
 */
export function branchMenuPins<
  L extends { name: string },
  R extends { name: string; remote: string },
>(
  flatRows: readonly BranchMenuRow<L, R>[],
  activeName: string | null,
  target: BranchMenuTarget,
  focusedName: string | null,
): [
  active: number,
  target: number,
  archived: number,
  remote: number,
  focused: number,
] {
  let active = -1;
  let targetIndex = -1;
  let archived = -1;
  let remote = -1;
  let focused = -1;
  flatRows.forEach((row, i) => {
    switch (row.type) {
      case "archived-header":
        archived = i;
        return;
      case "remote-header":
        remote = i;
        return;
      case "local":
        if (active === -1 && row.branch.name === activeName) active = i;
        if (focused === -1 && row.branch.name === focusedName) focused = i;
        if (target?.kind === "local" && row.branch.name === target.name)
          targetIndex = i;
        return;
      case "remote":
        if (active === -1 && row.branch.name === activeName) active = i;
        if (focused === -1 && row.branch.name === focusedName) focused = i;
        if (
          target?.kind === "remote" &&
          row.branch.name === target.name &&
          row.branch.remote === target.remote
        )
          targetIndex = i;
        return;
    }
  });
  return [active, targetIndex, archived, remote, focused];
}

/**
 * The virtualizer's window plus the pinned rows, deduped and ascending.
 * virtual-core neither dedupes nor bounds-checks a range extractor's output: a
 * repeated index mints two items under one key, and an out-of-range one reads
 * a measurement that doesn't exist and throws.
 */
export function mergePinnedIndexes(
  window: readonly number[],
  pins: readonly number[],
  count: number,
): number[] {
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < count;
  return [...new Set([...window, ...pins])]
    .filter(inRange)
    .sort((a, b) => a - b);
}
