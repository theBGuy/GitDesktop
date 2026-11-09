// Pure, import-free: a node test suite loads this file through Node's type
// stripping, which resolves no aliases.

/** The fields of one issue-list read the pickers' status ladder looks at. */
export interface PickerRead {
  data: unknown;
  isLoading: boolean;
  isPlaceholderData: boolean;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
}

export const ISSUES_LOADING = "Loading…";
export const ISSUES_LOAD_FAILED = "Couldn't load issues.";
export const ISSUES_PARTIAL = "Some issues couldn't load";
export const ISSUES_EMPTY = "No matching issues.";
/** `offlinePendingMessage("issues")`'s text; a scripts test pins the match. */
const ISSUES_OFFLINE =
  "You're offline — issues will load once you're back online.";

const answered = (r: PickerRead) =>
  r.data !== undefined && !r.isPlaceholderData;
const failed = (r: PickerRead) => r.isError && !r.isPaused && !r.isFetching;
const parked = (r: PickerRead) =>
  r.isPaused && (r.data === undefined || r.isError);

/**
 * The issue pickers' empty-slot line and partial-failure line over their reads.
 * Only a read that answered may let the picker claim no match, so a pending,
 * placeholder, parked or failed read never yields `ISSUES_EMPTY`. `partial`
 * needs two reads: with one, "some issues" has nothing to contrast with. When
 * every read failed over cached rows it says they couldn't load, never "some".
 */
export function issuePickerStatus(
  reads: readonly PickerRead[],
  rowCount: number,
): { empty: string; partial: string | null } {
  const everyFailed = reads.length > 0 && reads.every(failed);
  const allFailed = everyFailed && rowCount === 0;
  let partial: string | null = null;
  if (reads.length > 1 && !allFailed && reads.some(failed))
    partial = everyFailed ? ISSUES_LOAD_FAILED : ISSUES_PARTIAL;
  let empty = ISSUES_EMPTY;
  if (reads.some(parked)) empty = ISSUES_OFFLINE;
  else if (reads.some((r) => r.isLoading || r.isPlaceholderData))
    empty = ISSUES_LOADING;
  else if (allFailed) empty = ISSUES_LOAD_FAILED;
  else if (reads.some((r) => !answered(r) && !failed(r)))
    empty = ISSUES_LOADING;
  return { empty, partial };
}
