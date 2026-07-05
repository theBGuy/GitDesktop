import { load, type Store } from "@tauri-apps/plugin-store";
import { storeName } from "@/lib/test-mode";

export interface LocalPrComment {
  id: string;
  body: string;
  createdAt: string;
  /** Collapsed in the conversation (local equivalent of GitHub's "hide"). */
  hidden?: boolean;
}

export type LocalPrStatus = "open" | "merged" | "closed";

export interface LocalPr {
  id: string;
  title: string;
  body: string;
  base: string;
  head: string;
  status: LocalPrStatus;
  approved: boolean;
  /** Free-form labels (local PRs aren't tied to the repo's GitHub labels). */
  labels: string[];
  comments: LocalPrComment[];
  createdAt: string;
  mergedAt?: string;
  /** Hidden from the list unless "Show archived" — a soft alternative to delete. */
  archived?: boolean;
}

// Personal app-data, keyed by repo path — never written into the repo itself.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("local-prs.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store (and the reconcile reload) through one
// in-process queue. Without it, two overlapping mutations each reload the SAME pre-flush
// disk snapshot — autoSave persists on a ~100ms debounce, so the first write isn't on disk
// yet — and the later write drops the earlier one's change (a lost update; e.g. the
// reconcile hook marking several PRs in a parallel forEach). Running them one at a time,
// plus the force-save in writeAll, guarantees each reload sees a current snapshot.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  await store.reload({ ignoreDefaults: true });
}

/** Re-read `local-prs.json` from disk into the in-memory store. The MCP server
 *  (with `--allow-write`) can mutate this file externally; without a reload the
 *  autoSave store would clobber those writes on the next GUI mutation.
 *  `ignoreDefaults` fully matches the store to disk (so external deletes drop).
 *  Serialized so it can't land between another mutation's set and its flush. */
export async function reloadLocalPrs(): Promise<void> {
  return serialize(reloadRaw);
}

export async function listLocalPrs(repo: string): Promise<LocalPr[]> {
  const store = await getStore();
  const prs = (await store.get<LocalPr[]>(repo)) ?? [];
  // Tolerate PRs saved before the labels field existed.
  return prs.map((p) => ({ ...p, labels: p.labels ?? [] }));
}

async function writeAll(repo: string, prs: LocalPr[]): Promise<void> {
  const store = await getStore();
  await store.set(repo, prs);
  // Flush now instead of on autoSave's debounce, so the next serialized reload can't
  // re-read a pre-write disk snapshot and drop this change.
  await store.save();
}

export async function createLocalPr(
  repo: string,
  input: { title: string; body: string; base: string; head: string },
): Promise<LocalPr> {
  return serialize(async () => {
    // Reconcile any external MCP (--allow-write) writes from disk before we read-modify-
    // write, so a GUI mutation never clobbers a PR the server added while we were focused.
    await reloadRaw();
    const pr: LocalPr = {
      id: crypto.randomUUID(),
      title: input.title,
      body: input.body,
      base: input.base,
      head: input.head,
      status: "open",
      approved: false,
      labels: [],
      comments: [],
      createdAt: new Date().toISOString(),
    };
    const all = await listLocalPrs(repo);
    await writeAll(repo, [pr, ...all]);
    return pr;
  });
}

/** Apply `mutate` to the FRESH on-disk record for `id`, then persist. Reloads from
 *  disk first, so a concurrent external MCP write to the SAME PR (e.g. a comment the
 *  server appended while the GUI was open) is merged against — not clobbered by — a
 *  stale in-memory snapshot. `mutate` receives the current record and returns the next
 *  one: append to `cur.comments`, or set a field. Throws if the PR no longer exists. */
export async function updateLocalPr(
  repo: string,
  id: string,
  mutate: (pr: LocalPr) => LocalPr,
): Promise<LocalPr> {
  return serialize(async () => {
    await reloadRaw();
    const all = await listLocalPrs(repo);
    const idx = all.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`no local PR with id ${id}`);
    const next = [...all];
    next[idx] = mutate(all[idx]);
    await writeAll(repo, next);
    return next[idx];
  });
}

export async function deleteLocalPr(repo: string, id: string): Promise<void> {
  return serialize(async () => {
    // Fresh disk state first, so we don't drop a concurrent external MCP write.
    await reloadRaw();
    const all = await listLocalPrs(repo);
    await writeAll(
      repo,
      all.filter((p) => p.id !== id),
    );
  });
}
