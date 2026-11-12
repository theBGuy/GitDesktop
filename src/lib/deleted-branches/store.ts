import { withAppStoreLock } from "@/lib/app-store-lock";
import { FULL_OID_RE } from "@/lib/git/oid";
import { repoIdentityStrict } from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import { writeWithRollback } from "@/lib/plugin-store-rollback";

// The branches deleted in this app's window, per repository identity
// (git-common-dir), so every linked worktree shares one list. Only the commit
// the branch pointed at restores its work; the rest is read from the branch
// row before the delete, which removes the branch's whole config section.

export const DELETED_BRANCHES_CAP = 50;

/** The query key prefix of the list; outside `["repo", …]`, so a repo write's
 *  settle leaves it alone and a restore settles it explicitly. */
export const DELETED_BRANCHES_KEY = ["deleted-branches"] as const;

export interface DeletedBranchEntry {
  id: string;
  name: string;
  /** Full object id. */
  tip: string;
  /** Epoch ms. */
  deletedAt: number;
  keptLocal: boolean;
  /** The branch's upstream at delete time, display only. */
  upstream: string | null;
}

const STORE_FILE = "deleted-branches.json";
const getStore = memoizedStoreLoader(STORE_FILE);
type DeletedBranchesStore = Awaited<ReturnType<typeof getStore>>;

// Serializes this module's reads and writes in-process; the cross-instance
// store lock inside each covers the other processes.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

// Strictly increasing per process, so a batch's entries keep their order.
let lastAt = 0;

/** Mints id + deletedAt; deletedAt is strictly increasing per process, so one
 *  batch keeps its order. */
export function mintDeletedBranch(
  d: Pick<DeletedBranchEntry, "name" | "tip" | "keptLocal" | "upstream">,
): DeletedBranchEntry {
  const deletedAt = Math.max(Date.now(), lastAt + 1);
  lastAt = deletedAt;
  return {
    id: crypto.randomUUID(),
    name: d.name,
    tip: d.tip,
    deletedAt,
    keptLocal: d.keptLocal,
    upstream: d.upstream,
  };
}

function parseEntry(value: unknown): DeletedBranchEntry | null {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return null;
  const { id, name, tip, deletedAt, keptLocal, upstream } = value as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string" || name === "") return null;
  if (typeof tip !== "string" || !FULL_OID_RE.test(tip)) return null;
  if (typeof deletedAt !== "number" || !Number.isFinite(deletedAt)) return null;
  return {
    id,
    name,
    tip,
    deletedAt,
    // Unreadable reads as marked: a restore then can't make it pushable.
    keptLocal: typeof keptLocal === "boolean" ? keptLocal : true,
    upstream: typeof upstream === "string" ? upstream : null,
  };
}

/** Per-entry guards; a malformed entry is dropped, never the list. Newest first,
 *  capped at DELETED_BRANCHES_CAP. A non-boolean keptLocal reads true. */
export function parseDeletedBranches(value: unknown): DeletedBranchEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const entries: DeletedBranchEntry[] = [];
  for (const item of value) {
    const entry = parseEntry(item);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  entries.sort((a, b) => b.deletedAt - a.deletedAt);
  return entries.slice(0, DELETED_BRANCHES_CAP);
}

/** Reload → change → forced save of one identity's list, under the store lock.
 *  Resolves false (writing nothing) when the identity, the store or the save
 *  fails; otherwise `kept` judges the list that was saved. */
function writeList(
  repoPath: string,
  change: (current: DeletedBranchEntry[]) => DeletedBranchEntry[],
  kept: (saved: readonly DeletedBranchEntry[]) => boolean = () => true,
): Promise<boolean> {
  return serialize(async () => {
    try {
      const identity = await repoIdentityStrict(repoPath);
      const store: DeletedBranchesStore = await getStore();
      const saved = await withAppStoreLock(STORE_FILE, async () => {
        // After the reload: another instance may have written since this one
        // last loaded, and its entries must survive this write.
        await reloadToleratingEmptyStore(store);
        return writeWithRollback(store, async () => {
          const current = parseDeletedBranches(await store.get(identity));
          const next = parseDeletedBranches(change(current));
          await store.set(identity, next);
          await store.save();
          return next;
        });
      });
      return kept(saved);
    } catch {
      return false;
    }
  });
}

/** Adds entries under the repo's identity. Never rejects. True only when every
 *  entry is in the saved list: the cap orders by deletedAt, so a newer stored
 *  timestamp (a clock set back) can cut one, and an entry whose tip isn't a full
 *  object id is never written. */
export function recordDeletedBranches(
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
): Promise<boolean> {
  const valid = entries.filter((e) => FULL_OID_RE.test(e.tip));
  if (valid.length === 0 && entries.length > 0) return Promise.resolve(false);
  const added = new Set(valid.map((e) => e.id));
  return writeList(
    repoPath,
    (current) => [...valid, ...current.filter((e) => !added.has(e.id))],
    (saved) =>
      valid.length === entries.length &&
      [...added].every((id) => saved.some((e) => e.id === id)),
  );
}

/** Removes one entry by id. Never rejects. */
export function forgetDeletedBranch(
  repoPath: string,
  id: string,
): Promise<boolean> {
  return writeList(repoPath, (current) => current.filter((e) => e.id !== id));
}

/** Reads one identity key's entries from DISK. Rejects when the store is
 *  unreadable. */
export function loadDeletedBranches(
  identityKey: string,
): Promise<DeletedBranchEntry[]> {
  return serialize(async () => {
    const store = await getStore();
    // A reader under the writers' lock: a reload replaces the shared cache,
    // which an in-lock writer (the relocate migration) may have staged.
    return withAppStoreLock(STORE_FILE, async () => {
      await reloadToleratingEmptyStore(store);
      return parseDeletedBranches(await store.get(identityKey));
    });
  });
}
