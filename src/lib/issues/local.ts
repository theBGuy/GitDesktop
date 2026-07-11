import { load, type Store } from "@tauri-apps/plugin-store";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

export interface LocalIssueComment {
  id: string;
  body: string;
  createdAt: string;
  /** Collapsed in the conversation (local equivalent of GitHub's "hide"). */
  hidden?: boolean;
}

export type LocalIssueStatus = "open" | "closed";

export interface LocalIssue {
  id: string;
  title: string;
  body: string;
  status: LocalIssueStatus;
  /** Free-form labels (local issues aren't tied to the repo's GitHub labels). */
  labels: string[];
  comments: LocalIssueComment[];
  createdAt: string;
  closedAt?: string;
  /** Hidden from the list unless "Show archived" — a soft alternative to delete. */
  archived?: boolean;
}

// Personal app-data, keyed by repo path — never written into the repo itself.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("local-issues.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store (and the reload) through one in-process
// queue — mirrors the local-PR store. Without it two overlapping mutations each reload the
// SAME pre-flush disk snapshot (autoSave persists on a ~100ms debounce) and the later write
// drops the earlier one's change. writeAll force-saves so each reload sees a current one.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  // Tolerate a missing store file. Asymmetry: `load()` tolerates a missing file
  // but `reload()` rejects with a raw io error ("The system cannot find the file
  // specified. (os error 2)") — the file only exists after the first `save()`.
  // Without this guard the first-ever mutation throws before reaching `save()`,
  // so the store can never bootstrap (live-hit on first Save 2026-07-10); an
  // external delete of the file breaks every mutation until restart the same way.
  // Fall back to the loaded in-memory state on ANY reload failure — the
  // serialized op-chain + force-save still protect the write path.
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing/unreadable file — proceed with in-memory state; the next save()
    // creates it.
  }
}

const withLabels = (i: LocalIssue): LocalIssue => ({
  ...i,
  labels: i.labels ?? [],
});

/** Keyed by the repo's worktree-stable identity (not its checkout path) so issues
 *  are shared across the main checkout and every worktree. This read-only path
 *  merges in any records still under a legacy checkout-path key (folded on the
 *  next mutation), so a worktree-created issue shows up right away. */
export async function listLocalIssues(repo: string): Promise<LocalIssue[]> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = (await store.get<LocalIssue[]>(id)) ?? [];
  const legacy =
    id === repo ? [] : ((await store.get<LocalIssue[]>(repo)) ?? []);
  // Tolerate issues saved before the labels field existed.
  return mergeById(primary, legacy).map(withLabels);
}

/** Identity store key for `repo`, folding any legacy checkout-path records onto it
 *  once. Call inside the serialized queue (after `reloadRaw`). */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<LocalIssue[]>(store, "local-issues", repo, mergeById);
}

async function readByKey(key: string): Promise<LocalIssue[]> {
  const store = await getStore();
  return ((await store.get<LocalIssue[]>(key)) ?? []).map(withLabels);
}

async function writeAll(key: string, issues: LocalIssue[]): Promise<void> {
  const store = await getStore();
  await store.set(key, issues);
  // Flush now (not on autoSave's debounce) so the next serialized reload can't drop this.
  await store.save();
}

/** Re-read `local-issues.json` from disk into the in-memory store. Kept symmetric
 *  with the local-PR store's reconcile-before-mutate discipline (see reloadLocalPrs);
 *  local issues have no external writer today, but every mutation reloads first so the
 *  API is uniform and future-proof if one is ever added. */
export async function reloadLocalIssues(): Promise<void> {
  return serialize(reloadRaw);
}

export async function createLocalIssue(
  repo: string,
  input: { title: string; body: string },
): Promise<LocalIssue> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const issue: LocalIssue = {
      id: crypto.randomUUID(),
      title: input.title,
      body: input.body,
      status: "open",
      labels: [],
      comments: [],
      createdAt: new Date().toISOString(),
    };
    const all = await readByKey(key);
    await writeAll(key, [issue, ...all]);
    return issue;
  });
}

/** Apply `mutate` to the FRESH on-disk record for `id`, then persist — mirrors
 *  updateLocalPr so both local-entity stores share one reconcile-before-mutate shape.
 *  Throws if the issue no longer exists. */
export async function updateLocalIssue(
  repo: string,
  id: string,
  mutate: (issue: LocalIssue) => LocalIssue,
): Promise<LocalIssue> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    const idx = all.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`no local issue with id ${id}`);
    const next = [...all];
    next[idx] = mutate(all[idx]);
    await writeAll(key, next);
    return next[idx];
  });
}

export async function deleteLocalIssue(
  repo: string,
  id: string,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    await writeAll(
      key,
      all.filter((i) => i.id !== id),
    );
  });
}
