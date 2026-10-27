/** Structural Store subset so the helper needs no runtime imports. */
export interface RollbackableStore {
  entries<T>(): Promise<Array<[key: string, value: T]>>;
  set(key: string, value: unknown): Promise<void>;
  clear(): Promise<void>;
  save(): Promise<void>;
  reload(options?: { ignoreDefaults?: boolean }): Promise<void>;
}

/** Raw reload must reject missing files so the pre-write snapshot can restore them.
 * The caller holds the lock until rollback settles, even if snapshot restore fails.
 * The original rejection passes through unchanged because callers' error handlers
 * match on that rejection object. */
export async function writeWithRollback<T>(
  store: RollbackableStore,
  write: () => Promise<T>,
): Promise<T> {
  const snapshot = await store.entries();
  try {
    return await write();
  } catch (error) {
    let restored = false;
    try {
      await store.reload({ ignoreDefaults: true });
      restored = true;
    } catch {
      try {
        await store.clear();
        for (const [key, value] of snapshot) await store.set(key, value);
        restored = true;
      } catch {
        // Unrestored memory may contain failed or partial edits; saving it would
        // persist values the caller is being told failed.
      }
    }
    if (restored) {
      try {
        await store.save();
      } catch {
        // Save cancels the autosave debounce before writing; reload never does.
        // Even a rejected save disarms a late write outside the caller's lock.
      }
    }
    throw error;
  }
}
