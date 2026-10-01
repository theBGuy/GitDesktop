// Pure, import-free: scripts/touched-draft.test.mjs imports this file through
// Node's type stripping, which resolves no aliases.

/** A settings form's draft: only the fields the user touched, so untouched ones
 *  ride the latest read and a save never sends another client's change back. */
export type TouchedEdit<K extends string, V> = Partial<Record<K, V>>;

/** What saves sent, stamped with the oldest read any of them was made against. */
export type PendingSent<K extends string, V> = {
  at: number;
  sent: TouchedEdit<K, V>;
};

/** Records a successful save: `at` is the read's `dataUpdatedAt` captured
 *  before the save started. Overlapping saves keep the earliest stamp. */
export function stampSent<K extends string, V>(
  pending: PendingSent<K, V> | null,
  at: number,
  sent: TouchedEdit<K, V>,
): PendingSent<K, V> {
  return {
    at: pending ? Math.min(pending.at, at) : at,
    sent: { ...pending?.sent, ...sent },
  };
}

/** The draft after this render's read. A touched field retires once the server
 *  reads back equal. A sent field also retires, even when the server stored
 *  something else (normalized, refused), once a read newer than the save lands
 *  with no failure after it: `isError` stays set through a refetch until one
 *  succeeds, so a failed post-save refetch holds the saved values on screen. A
 *  field edited again since the save no longer equals its sent value and stays.
 *  Unchanged inputs come back as the same objects, so a caller can apply the
 *  result while rendering without looping. */
export function reconcileTouched<K extends string, V>(input: {
  edit: TouchedEdit<K, V> | null;
  server: Record<K, V>;
  pending: PendingSent<K, V> | null;
  dataUpdatedAt: number;
  isError: boolean;
}): { edit: TouchedEdit<K, V> | null; pending: PendingSent<K, V> | null } {
  const { edit, server, pending } = input;
  const landed =
    pending !== null && input.dataUpdatedAt > pending.at && !input.isError;
  const nextPending = landed ? null : pending;
  if (edit === null) return { edit, pending: nextPending };
  const keys = Object.keys(edit) as K[];
  const kept = keys.filter(
    (k) =>
      edit[k] !== server[k] &&
      !(landed && k in pending.sent && edit[k] === pending.sent[k]),
  );
  if (kept.length === keys.length) return { edit, pending: nextPending };
  if (kept.length === 0) return { edit: null, pending: nextPending };
  const next: TouchedEdit<K, V> = {};
  for (const k of kept) next[k] = edit[k];
  return { edit: next, pending: nextPending };
}
