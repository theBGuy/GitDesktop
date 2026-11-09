import { withAppStoreLock } from "@/lib/app-store-lock";
import { normPath } from "@/lib/git/path";
import {
  USER_WORKTREES_STALE_TIME,
  userWorktreesOptions,
} from "@/lib/git/queries";
import { repoIdentityStrict } from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import { writeWithRollback } from "@/lib/plugin-store-rollback";
import { queryClient } from "@/lib/query-client";
import { FUTURE_AT_SLACK_MS } from "./resolve";

// The checkout each repo was last left in, one record per repo identity
// (git-common-dir). Paths keep git's and validateRepo's spelling, folded only
// to compare. Writes resolve identity strictly and drop on rejection: readers
// find records by mainPath, but a raw-path key would break the identity
// compares (the in-lock newer-record check and the open-repo guard).

/** One record, as the in-memory snapshot holds it. */
export interface LastCheckoutEntry {
  identity: string;
  path: string;
  mainPath: string;
  at: number;
}

const STORE_FILE = "last-checkout.json";
const getStore = memoizedStoreLoader(STORE_FILE);
type LastCheckoutStore = Awaited<ReturnType<typeof getStore>>;

// Serializes this module's loads and writes in-process; the cross-instance
// store lock inside each write covers the other processes. The prewarm rides it
// too, so it can never overwrite a snapshot a write already produced.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

// Replaced only by a rebuild, so `getLastCheckoutSnapshot` hands React the same
// reference between writes.
let snapshot: readonly LastCheckoutEntry[] = [];
const listeners = new Set<() => void>();
// Set by the first rebuild, settling readiness for good. The plugin's load
// answers an unreadable file as an empty store, so that rebuild may hold
// nothing.
let loaded = false;

/** Per field: one hand-edited or truncated record never blanks the rest. */
function parseEntry(
  identity: string,
  value: unknown,
): LastCheckoutEntry | null {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return null;
  const { path, mainPath, at } = value as Record<string, unknown>;
  if (typeof path !== "string" || typeof mainPath !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { identity, path, mainPath, at };
}

function sameEntries(
  a: readonly LastCheckoutEntry[],
  b: readonly LastCheckoutEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (e, i) =>
        e.identity === b[i].identity &&
        e.path === b[i].path &&
        e.mainPath === b[i].mainPath &&
        e.at === b[i].at,
    )
  );
}

/** Rebuilds the snapshot from what the store holds (another instance's records
 *  included), never from the values just written, then notifies. Sorted by
 *  identity, since the plugin store answers in no stable order. With
 *  `onlyIfChanged`, records equal to the current ones keep its reference and
 *  notify nobody, so a re-read re-renders no hinted row. */
async function rebuildSnapshot(
  store: LastCheckoutStore,
  onlyIfChanged = false,
): Promise<void> {
  const next: LastCheckoutEntry[] = [];
  for (const [identity, value] of await store.entries<unknown>()) {
    const entry = parseEntry(identity, value);
    if (entry) next.push(entry);
  }
  next.sort(
    (a, b) => Number(a.identity > b.identity) - Number(a.identity < b.identity),
  );
  loaded = true;
  if (onlyIfChanged && sameEntries(snapshot, next)) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Every remembered landing, as last loaded or written. */
export function getLastCheckoutSnapshot(): readonly LastCheckoutEntry[] {
  return snapshot;
}

export function subscribeLastCheckout(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Loads the store into the snapshot, started at app start so recents rows can
 *  hint from memory once it lands. Never writes and never rejects: it resolves
 *  whether the load succeeded, and a failed one leaves the snapshot as it was. */
export function prewarmLastCheckout(): Promise<boolean> {
  return serialize(async () => {
    try {
      await rebuildSnapshot(await getStore());
      return true;
    } catch {
      return false;
    }
  });
}

let ready: Promise<void> | null = null;
const LOADED: Promise<void> = Promise.resolve();

/** Settled once any store read has landed in the snapshot (the startup load, a
 *  refresh or a write's rebuild), so a cold-start click can wait for it. Until
 *  then, a prewarm shared by every caller while it runs, settling found or
 *  failed; a failed one is forgotten so the next caller loads afresh. Started
 *  at app start, retried by a hint mounting over an empty snapshot, and awaited
 *  unbounded by a recents redirect before its record lookup. */
export function lastCheckoutReady(): Promise<void> {
  if (loaded) return LOADED;
  if (ready === null) {
    const attempt: Promise<void> = prewarmLastCheckout().then(() => {
      if (!loaded && ready === attempt) ready = null;
    });
    ready = attempt;
  }
  return ready;
}

/** Re-reads the store into the snapshot behind every write already queued, so
 *  a redirect sees an earlier landing still writing and another instance's
 *  newer records. Never rejects: a failed read leaves the snapshot as it was. */
export function refreshLastCheckout(): Promise<void> {
  return serialize(async () => {
    try {
      const store = await getStore();
      // A reader under the writers' lock: a reload replaces the shared cache,
      // which an in-lock writer (the relocate migration) may have staged.
      await withAppStoreLock(STORE_FILE, async () => {
        await reloadToleratingEmptyStore(store);
        await rebuildSnapshot(store, true);
      });
    } catch {
      // Kept: a read that failed says nothing about what is on disk.
    }
  });
}

// Strictly increasing per process, so two landings in one millisecond still
// order, while the in-lock compare lets another instance's newer landing win.
let lastAt = 0;

/**
 * Records a landing, enqueued at the call so writes run in landing order. Never
 * rejects: a failure drops the write and keeps the previous record, so a
 * dropped main landing lets the next reopen redirect to the older worktree. A
 * landing its worktree list doesn't name (session or app-data checkouts,
 * junction or subst-drive spellings) is dropped; on a failed list read an
 * existing record takes the new path unchecked and keeps its mainPath.
 */
export function recordLastCheckout(repoPath: string): Promise<void> {
  const at = Math.max(Date.now(), lastAt + 1);
  lastAt = at;
  return serialize(async () => {
    try {
      const identity = await repoIdentityStrict(repoPath);
      let mainPath: string | null = null;
      try {
        const list = await queryClient.fetchQuery({
          ...userWorktreesOptions(repoPath),
          staleTime: USER_WORKTREES_STALE_TIME,
          retry: false,
        });
        const landed = normPath(repoPath);
        if (!list.some((w) => normPath(w.path) === landed)) return;
        const main = list.find((w) => w.isMain);
        if (!main) return;
        mainPath = main.path;
      } catch {
        // Falls back to an existing record's mainPath inside the lock.
      }
      const store = await getStore();
      await withAppStoreLock(STORE_FILE, async () => {
        await reloadToleratingEmptyStore(store);
        // Read after the reload: another instance may have written this
        // identity's record since this one last loaded, and a newer one wins
        // unless it is stamped past FUTURE_AT_SLACK_MS ahead of this clock.
        const existing = parseEntry(identity, await store.get(identity));
        if (
          existing !== null &&
          existing.at >= at &&
          existing.at <= Date.now() + FUTURE_AT_SLACK_MS
        )
          return;
        const keptMain = mainPath ?? existing?.mainPath;
        if (keptMain === undefined) return;
        const record = { path: repoPath, mainPath: keptMain, at };
        return writeWithRollback(store, async () => {
          await store.set(identity, record);
          await store.save();
        });
      });
      // A normal return, skip arms included, follows a reload that succeeded or
      // found the file missing or empty (the cache then stands); a failed write
      // throws past this.
      await rebuildSnapshot(store);
    } catch {
      // Dropped: identity unresolved, or the store couldn't be read or written.
    }
  });
}
