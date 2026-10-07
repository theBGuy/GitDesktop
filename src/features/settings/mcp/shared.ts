/** One editable env-var (stdio) / header (http) row in the dialog. Kept with a
 *  stable local `rowId` so renaming a key doesn't reorder or lose focus, and a
 *  separate `secretInput` for a newly-typed secret (the saved value is never
 *  read back out of the keychain). */
export interface EntryRow {
  rowId: string;
  key: string;
  value: string;
  secret: boolean;
  secretInput: string;
}
