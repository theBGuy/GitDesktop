// The per-key memo mechanics behind the repo-identity resolver, with the clock and
// the resolver injected so they can be driven from a test. This file lives apart
// from its caller so `scripts/*.test.mjs` can import it under Node's type
// stripping: it must stay import-free (stripping erases types but resolves no
// bundler aliases, and it reaches no Tauri API), or the tests stop resolving.
//
// Everything here exists because a memo that never re-asks is wrong in one
// direction and a memo that re-asks per call is wrong in the other. The guards are
// the interesting part; the domain reasoning for each lives with the wrappers in
// `repo-identity.ts`.

type Entry = { at: number; value: Promise<string> };

export type TtlMemo = {
  /** The memoized answer for `key`, re-resolving once the entry is older than the
   *  TTL. Concurrent callers inside one window share a single in-flight resolve. */
  get(key: string): Promise<string>;
  /** The last SETTLED answer at any age, or undefined when none ever settled.
   *  Never resolves, never populates. */
  peek(key: string): string | undefined;
  /** {@link TtlMemo.peek} bounded by age — for a caller that would rather fail than
   *  serve an answer nothing has confirmed lately. Ages from the ISSUE stamp (the
   *  ordering guard's clock), so the bound is conservative by at most the resolver's
   *  own timeout — pass a maxAgeMs comfortably above it. */
  within(key: string, maxAgeMs: number): string | undefined;
};

/**
 * A promise memo whose entries expire, keeping the burst protection that matters:
 * N concurrent callers for one key share one resolve, and repeats inside the window
 * cost nothing, but the answer is re-confirmed once the window rolls.
 *
 * `now` is injected rather than read from a clock so callers can supply a monotonic
 * source, and so tests can drive the window directly instead of sleeping.
 */
export function ttlMemo(opts: {
  resolve: (key: string) => Promise<string>;
  ttlMs: number;
  now: () => number;
}): TtlMemo {
  const { resolve, ttlMs, now } = opts;
  /** In-flight or already-answered resolve per key, stamped with the moment it was
   *  issued — a hit past `ttlMs` re-resolves rather than serving. */
  const pending = new Map<string, Entry>();
  /** Settled answers only. Stamped but never dropped; each reader decides what age
   *  it will honor. */
  const settled = new Map<string, { at: number; value: string }>();

  return {
    get(key) {
      const at = now();
      const hit = pending.get(key);
      if (hit && at - hit.at < ttlMs) return hit.value;
      const entry: Entry = {
        at,
        value: resolve(key)
          .then((value) => {
            // Newest ANSWER wins, not newest arrival: the window re-issues while a
            // slow resolve is still out, so an older one can settle last and would
            // otherwise restore the value the re-issue just corrected.
            const prev = settled.get(key);
            if (!prev || prev.at <= at) settled.set(key, { at, value });
            return value;
          })
          .catch((e) => {
            // Drop the failed attempt so the next call resolves again — but only if
            // a re-issue hasn't already replaced it, which this one's failure says
            // nothing about.
            if (pending.get(key) === entry) pending.delete(key);
            throw e;
          }),
      };
      pending.set(key, entry);
      return entry.value;
    },
    peek(key) {
      return settled.get(key)?.value;
    },
    within(key, maxAgeMs) {
      const hit = settled.get(key);
      return hit && now() - hit.at < maxAgeMs ? hit.value : undefined;
    },
  };
}
