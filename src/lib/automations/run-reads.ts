/**
 * One review run's shared forge reads: the harvests a run makes ask for the same
 * read with identical arguments, so the first caller's promise serves the rest.
 * A run holds one instance for its own lifetime and evicts any entry whose value
 * the run itself can change (its delivery joins the review activity it read).
 *
 * Callers must not mutate a shared result: every consumer of a key holds the same
 * object. One failed shared read fails every consumer of that key where separate
 * fetches could have partly succeeded; the failure is evicted, so the next share
 * of the key reads again.
 *
 * Import-free at runtime on purpose (erasable syntax only): the pin
 * `scripts/automation-run-reads.test.mjs` loads it straight from `src/` under
 * Node's type stripping, which resolves no bundler aliases.
 */

export interface RunReads {
  /** The read filed under `key`: the pending or settled promise of the first
   *  caller, or `fetch()` when there is none. A rejection is evicted, never
   *  served again. */
  share<T>(key: string, fetch: () => Promise<T>): Promise<T>;
  /** Drops every entry whose key starts with `keyPrefix`. */
  evict(keyPrefix: string): void;
}

export function createRunReads(): RunReads {
  const entries = new Map<string, Promise<unknown>>();
  return {
    share<T>(key: string, fetch: () => Promise<T>): Promise<T> {
      const held = entries.get(key);
      if (held) return held as Promise<T>;
      let read: Promise<T>;
      try {
        read = fetch();
      } catch (e) {
        // Never filed: a synchronous throw has nothing in flight to share. Observed
        // so an unconsumed rejection doesn't surface as unhandled.
        const thrown: Promise<T> = Promise.reject(e);
        thrown.catch(() => undefined);
        return thrown;
      }
      entries.set(key, read);
      // Compare-and-delete: a late rejection must not evict a newer entry filed
      // after an eviction. The observer also keeps an unconsumed rejection from
      // surfacing as unhandled.
      read.catch(() => {
        if (entries.get(key) === read) entries.delete(key);
      });
      return read;
    },
    evict(keyPrefix: string): void {
      for (const key of [...entries.keys()])
        if (key.startsWith(keyPrefix)) entries.delete(key);
    },
  };
}
