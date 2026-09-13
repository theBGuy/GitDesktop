import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";

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
const getStore = memoizedStoreLoader("local-issues.json");

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
  await reloadToleratingEmptyStore(await getStore());
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

/** Re-read `local-issues.json` from disk into the in-memory store. The MCP server
 *  (`--allow-write`) writes it out of process (create/comment/status); without a
 *  reload the autoSave store would clobber those writes on the next GUI mutation.
 *  `ignoreDefaults` fully matches the store to disk (so external deletes drop).
 *  Registered in `@/lib/mcp-writable-stores` so the focus sweep makes external
 *  writes visible without a relaunch. */
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
