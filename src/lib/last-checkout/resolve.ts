// Import-free on purpose: scripts/last-checkout.test.mjs imports this file
// straight from src/ under Node's type stripping, which resolves no aliases.

/** One remembered landing, keyed by the repo identity it was written under. */
export interface ReopenRecordView {
  identity: string;
  path: string;
  mainPath: string;
  at: number;
}

/** `normPath`'s twin (src/lib/git/path.ts), local so this module stays
 *  import-free; the scripts test pins the two equal. Compare-only: lower-cased,
 *  so never shown, stored or handed to git. */
export function foldPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

const isWorktreeRecord = (r: ReopenRecordView) =>
  foldPath(r.path) !== foldPath(r.mainPath);

/** How far past the local clock a stored `at` may sit and still be trusted (a
 *  clock stepped back or a hand-edited file stamps past it). */
export const FUTURE_AT_SLACK_MS = 24 * 60 * 60 * 1000;

const isTrusted = (r: ReopenRecordView, now: number) =>
  r.at <= now + FUTURE_AT_SLACK_MS;

/** Whether `a` outranks `b`: a trusted record over an untrusted one, then the
 *  newer landing; on a tie the worktree record, then the lower identity, so the
 *  answer never depends on store order. */
function outranks(
  a: ReopenRecordView,
  b: ReopenRecordView,
  now: number,
): boolean {
  if (isTrusted(a, now) !== isTrusted(b, now)) return isTrusted(a, now);
  if (a.at !== b.at) return a.at > b.at;
  if (isWorktreeRecord(a) !== isWorktreeRecord(b)) return isWorktreeRecord(a);
  return a.identity < b.identity;
}

/**
 * The ONE record lookup the row hint and the redirect share. The newest landing
 * among every record whose mainPath folds equal to `rowPath` wins, main
 * landings included (several match when one repo's identity is spelled more
 * than one way, or a record is orphaned). Null when that winner is main, when
 * `rowPath` is the open checkout, or when the winner's path is (it IS the open
 * checkout). Empty paths never match. `now` comes from the caller, so this
 * module stays pure.
 */
export function findReopenRecord(
  records: readonly ReopenRecordView[],
  rowPath: string,
  currentPath: string | null,
  now: number,
): ReopenRecordView | null {
  if (!rowPath) return null;
  const row = foldPath(rowPath);
  const current = currentPath === null ? null : foldPath(currentPath);
  if (row === current) return null;
  let best: ReopenRecordView | null = null;
  for (const record of records) {
    if (!record.path || !record.mainPath) continue;
    if (foldPath(record.mainPath) !== row) continue;
    if (best === null || outranks(record, best, now)) best = record;
  }
  if (best === null) return null;
  const remembered = foldPath(best.path);
  if (remembered === row || remembered === current) return null;
  return best;
}

/** The ONE worktree-membership predicate: some NON-main entry's path folds
 *  equal to `remembered`. */
export function rememberedIsListed(
  worktrees: readonly { path: string; isMain: boolean }[],
  remembered: string,
): boolean {
  if (!remembered) return false;
  const target = foldPath(remembered);
  return worktrees.some((w) => !w.isMain && foldPath(w.path) === target);
}

/** The ONE main-checkout predicate: the list's isMain entry folds equal to
 *  `root`. A list whose main lives elsewhere means a record matched a moved or
 *  foreign checkout. */
export function listedMainIs(
  worktrees: readonly { path: string; isMain: boolean }[],
  root: string,
): boolean {
  const main = worktrees.find((w) => w.isMain);
  return main !== undefined && foldPath(main.path) === foldPath(root);
}

/** {@link findReopenRecord} plus the display basename (split on / and \). */
export function reopenHint(
  records: readonly ReopenRecordView[],
  rowPath: string,
  currentPath: string | null,
  now: number,
): { path: string; name: string } | null {
  const record = findReopenRecord(records, rowPath, currentPath, now);
  if (record === null) return null;
  const name = record.path.split(/[\\/]/).filter(Boolean).pop() ?? record.path;
  return { path: record.path, name };
}

/**
 * The remembered path to validate and open, or null to open the clicked main.
 * `openIdentity`: null = no repo open; "unresolved" = the strict resolve
 * rejected, which fails toward today's behavior. `worktrees` null = the fresh
 * list read failed.
 */
export function resolveReopenTarget(args: {
  clickedRoot: string;
  record: ReopenRecordView | null;
  preferMain: boolean;
  openIdentity: string | null | "unresolved";
  worktrees: readonly { path: string; isMain: boolean }[] | null;
}): string | null {
  const { clickedRoot, record, preferMain, openIdentity, worktrees } = args;
  if (preferMain || record === null || worktrees === null) return null;
  if (openIdentity === "unresolved") return null;
  // Clicking the open repo's own row from inside one of its worktrees goes to
  // main, as it always has.
  if (
    openIdentity !== null &&
    foldPath(openIdentity) === foldPath(record.identity)
  )
    return null;
  if (!listedMainIs(worktrees, clickedRoot)) return null;
  return rememberedIsListed(worktrees, record.path) ? record.path : null;
}
