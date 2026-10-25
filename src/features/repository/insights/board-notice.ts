// Pure, import-free: scripts/board-notice.test.mjs imports this file through
// Node's type stripping, which resolves no aliases.

/** The slice of a card's read the board notice decides on. */
export type BoardCardRead = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isPaused: boolean;
  errorUpdatedAt: number;
  dataUpdatedAt: number;
};

/** The Insights board's one failure line and the reads its Retry refetches,
 *  or null. Membership is sticky through background refetches: react-query
 *  keeps `isError` through a refetch of a read that has data, so a polling run
 *  list never blanks and re-announces the line, and a read that never loaded
 *  (reset to pending by its refetch) still counts while its last settle was
 *  the error. A park is not a failure (it resumes on reconnect). Silent only
 *  while a user's Retry is settling (`retrying`), so the sentence never swaps
 *  mid-retry. `summarize` turns the first failure's error, in the cards'
 *  order, into its reason. */
export function boardNotice<T extends BoardCardRead>(
  cards: readonly T[],
  retrying: boolean,
  summarize: (error: unknown) => string,
): { message: string; failed: T[] } | null {
  const failed = cards.filter(
    (q) => (q.isError || q.errorUpdatedAt > q.dataUpdatedAt) && !q.isPaused,
  );
  if (retrying || failed.length === 0) return null;
  const message = failed.every((q) => q.data !== undefined)
    ? "Couldn't refresh some insights — showing the last loaded ones."
    : `Couldn't load some insights. ${summarize(failed[0].error)}`;
  return { message, failed };
}
