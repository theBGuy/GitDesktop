import { load, type Store } from "@tauri-apps/plugin-store";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

export interface LocalPrComment {
  id: string;
  body: string;
  createdAt: string;
  /** Display name of a synthetic author (e.g. "GitDesktop" for AI-posted
   *  reviews). Optional: user-authored comments have none, and comments stored
   *  before this field existed stay valid (rendered authorless). */
  author?: string;
  /** Collapsed in the conversation (local equivalent of GitHub's "hide"). */
  hidden?: boolean;
}

export type LocalPrStatus = "open" | "merged" | "closed";

/** A local-PR merge that hit conflicts and is paused for the user to resolve in
 *  an isolated worktree. Carries everything `git_finish_local_pr_merge` /
 *  `git_abort_local_pr_merge` need to commit the result or roll it back. The
 *  conflicts are unmerged paths in the hidden worktree at `worktreePath` — the
 *  user's branch and working tree stay untouched. Set on the PR while resolution
 *  is in flight; cleared (set to `undefined`, which JSON omits) once finished or
 *  aborted. */
export interface PendingMerge {
  base: string;
  head: string;
  strategy: "merge" | "squash" | "rebase";
  /** The intended commit message (`pr.title\n\npr.body`). */
  message: string;
  /** The detached worktree holding the in-progress merge — point the conflict
   *  editor (and a worktree-scoped `git status`) at this path to resolve. */
  worktreePath: string;
  /** The worktree's id, passed to finish so the backend can locate/prune it. */
  worktreeId: string;
  /** The oplog entry id, passed to finish/abort (null if none was recorded). */
  opId: string | null;
  startedAt: string;
}

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
  /** When this PR was last closed (set alongside `status: "closed"`, cleared on
   *  reopen). Absent on PRs closed before this field existed — render a
   *  timestamp-less "closed" marker in that case rather than crashing. */
  closedAt?: string;
  /** Hidden from the list unless "Show archived" — a soft alternative to delete. */
  archived?: boolean;
  /** Set while a merge of this PR is paused on conflicts (resolved in an isolated
   *  worktree); cleared once finished or aborted. Absent on PRs stored before it
   *  existed. */
  pendingMerge?: PendingMerge;
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

/** Re-read `local-prs.json` from disk into the in-memory store. The MCP server
 *  (with `--allow-write`) can mutate this file externally; without a reload the
 *  autoSave store would clobber those writes on the next GUI mutation.
 *  `ignoreDefaults` fully matches the store to disk (so external deletes drop).
 *  Serialized so it can't land between another mutation's set and its flush. */
export async function reloadLocalPrs(): Promise<void> {
  return serialize(reloadRaw);
}

const withLabels = (p: LocalPr): LocalPr => ({ ...p, labels: p.labels ?? [] });

/** Records are keyed by the repo's worktree-stable identity, not its checkout
 *  path, so a PR is shared across the main checkout and every worktree. This
 *  read-only path merges in any records still under a legacy checkout-path key
 *  (not yet folded by a mutation), so a worktree-created PR shows up right away.
 *  Never writes — the fold happens on the next mutation (see `keyFor`). */
export async function listLocalPrs(repo: string): Promise<LocalPr[]> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = (await store.get<LocalPr[]>(id)) ?? [];
  const legacy = id === repo ? [] : ((await store.get<LocalPr[]>(repo)) ?? []);
  // Tolerate PRs saved before the labels field existed.
  return mergeById(primary, legacy).map(withLabels);
}

/** The identity store key for `repo`, folding any legacy checkout-path-keyed
 *  records onto it once. Call inside the serialized queue (after `reloadRaw`) so
 *  the fold is ordered with the mutation and a delete/update can't leave a
 *  lingering legacy record that would reappear via `listLocalPrs`'s read-merge. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<LocalPr[]>(store, "local-prs", repo, mergeById);
}

async function readByKey(key: string): Promise<LocalPr[]> {
  const store = await getStore();
  return ((await store.get<LocalPr[]>(key)) ?? []).map(withLabels);
}

async function writeAll(key: string, prs: LocalPr[]): Promise<void> {
  const store = await getStore();
  await store.set(key, prs);
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
    const key = await keyFor(repo);
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
    const all = await readByKey(key);
    await writeAll(key, [pr, ...all]);
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
    const key = await keyFor(repo);
    const all = await readByKey(key);
    const idx = all.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`no local PR with id ${id}`);
    const next = [...all];
    next[idx] = mutate(all[idx]);
    await writeAll(key, next);
    return next[idx];
  });
}

export async function deleteLocalPr(repo: string, id: string): Promise<void> {
  return serialize(async () => {
    // Fresh disk state first, so we don't drop a concurrent external MCP write.
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    await writeAll(
      key,
      all.filter((p) => p.id !== id),
    );
  });
}
