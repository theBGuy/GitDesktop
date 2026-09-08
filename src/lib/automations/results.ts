import { load, type Store } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import { create } from "zustand";
import type { ReviewMode } from "@/lib/ai/types";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/**
 * A finished automated COMMIT review — the one review target with no comment
 * surface to deliver into, so this store is the output's only home. Persisted so
 * the text survives a restart and its notification stays clickable.
 */
export interface AutomationRunResult {
  schemaVersion: 1;
  id: string;
  repoPath: string;
  /** What was reviewed: the commit's subject. */
  subject: string;
  mode: ReviewMode;
  text: string;
  createdAt: string;
  /** Commit sha the review covered; "" when unknown. */
  hash: string;
  /** Present only on a kept PARTIAL run (mirrors PersistedReview's vocabulary). */
  phase?: "error";
  error?: string;
  timedOut?: boolean;
}

/** Records kept per repo, pruned on every write so the file stays bounded.
 *  Completed reviews and kept partials share the cap — commit-review traffic is
 *  low, so a split (as the PR history store has) would buy nothing. */
const MAX_PER_REPO = 20;

/** In-session rows, across all repos — the toast's View button reads this list. */
const MAX_IN_SESSION = 20;

// Personal app-data, keyed by the repo's worktree-stable identity — never written
// into the repo itself (the text quotes user source + may contain AI false
// positives). Routed through storeName() so cold-start/test mode never pollutes
// real results.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("automation-results.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write through one in-process queue: autoSave persists
// on a ~100ms debounce, so two overlapping writes would both reload the same
// pre-flush disk snapshot and the later would drop the earlier's record (two review
// modes of the same commit settle back to back). With the force-save in `persist`,
// each reload sees fresh state. Cross-INSTANCE overlap (two app instances delivering
// different runs) still races last-writer-wins like the sibling plugin stores — the
// automation claim only keeps instances off the SAME run; cross-process locking for
// this store class is a recorded deferral.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  // Tolerate a missing store file: `load()` tolerates one but `reload()` rejects with
  // a raw io error (os error 2) until the first `save()` creates the file — without
  // this guard the first-ever write throws before reaching `save()` and the store can
  // never bootstrap. Fall back to the loaded in-memory state on ANY reload failure.
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

/** Shape-guard one record out of untrusted store JSON: a hand-edited (or older)
 *  `automation-results.json` reaches the dialog verbatim, so a malformed record is
 *  dropped rather than blanking the list or throwing mid-render. Every field left
 *  unchecked is guarded at its consumer instead: `mode` / `phase` / `timedOut` are
 *  compared by exact value in `AutomationResultDialog` and `error` is typeof-guarded
 *  at its render site there, `repoPath` is dereferenced only on the write path
 *  (`persist`, whose caller is runner-typed), and `schemaVersion` is write-only. */
function isStoredResult(x: unknown): x is AutomationRunResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.text === "string" &&
    typeof r.subject === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.hash === "string"
  );
}

async function readByKey(key: string): Promise<AutomationRunResult[]> {
  const store = await getStore();
  const raw = await store.get<unknown>(key);
  return Array.isArray(raw) ? raw.filter(isStoredResult) : [];
}

/** Reads a repo's records, merging in any still under a legacy checkout-path key
 *  (folded onto the identity by the next write via `keyFor`). */
async function readMerged(repo: string): Promise<AutomationRunResult[]> {
  const id = await repoIdentity(repo);
  const primary = await readByKey(id);
  const legacy = id === repo ? [] : await readByKey(repo);
  return mergeById(primary, legacy);
}

/** The identity store key for `repo`, folding any legacy checkout-path-keyed records
 *  onto it once. Called inside the serialized queue (after `reloadRaw`) so the fold
 *  is ordered with the write. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<AutomationRunResult[]>(
    store,
    "automation-results",
    repo,
    mergeById,
  );
}

/** Newest {@link MAX_PER_REPO} by `createdAt`. A record whose stamp doesn't parse
 *  can't be ordered, so those sort after the dated ones and keep their insertion
 *  order — a junk stamp costs its own position, never someone else's. */
function prune(records: AutomationRunResult[]): AutomationRunResult[] {
  return records
    .map((record, index) => {
      const ts = new Date(record.createdAt).getTime();
      return { record, index, ts: Number.isNaN(ts) ? null : ts };
    })
    .sort((a, b) => {
      if (a.ts === null || b.ts === null) {
        if (a.ts !== b.ts) return a.ts === null ? 1 : -1;
        return a.index - b.index;
      }
      return b.ts - a.ts;
    })
    .slice(0, MAX_PER_REPO)
    .map((x) => x.record);
}

/** Upserts a record by id under its repo's identity key, then prunes. */
async function persist(result: AutomationRunResult): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(result.repoPath);
    const all = await readByKey(key);
    const without = all.filter((r) => r.id !== result.id);
    await store.set(key, prune([result, ...without]));
    // Flush now instead of on autoSave's debounce, so the next serialized reload
    // can't re-read a pre-write disk snapshot and drop this record.
    await store.save();
  });
}

interface AutomationResultsState {
  /** Newest first, capped — this session's results; the durable copy is the store
   *  file, which {@link openAutomationResult} reads on a miss. */
  results: AutomationRunResult[];
  /** Result shown in the viewer dialog, if any. */
  openId: string | null;
  /** Inserts synchronously (so the completion toast's View button works at once);
   *  the returned promise settles with the DURABLE write — it rejects when the
   *  record didn't reach disk, so a caller can tell the user what was kept. */
  add: (result: AutomationRunResult) => Promise<void>;
  /** Puts a record read back from disk into the session list WITHOUT re-persisting
   *  it. Internal to {@link openAutomationResult}; a re-persist would rewrite the
   *  file on every restored open. */
  hydrate: (result: AutomationRunResult) => void;
  setOpen: (id: string | null) => void;
}

export const useAutomationResults = create<AutomationResultsState>()((set) => ({
  results: [],
  openId: null,
  add: (result) => {
    set((s) => ({ results: [result, ...s.results].slice(0, MAX_IN_SESSION) }));
    return persist(result);
  },
  hydrate: (result) =>
    set((s) => ({
      results: [result, ...s.results.filter((r) => r.id !== result.id)].slice(
        0,
        MAX_IN_SESSION,
      ),
    })),
  setOpen: (id) => set({ openId: id }),
}));

/**
 * Opens a stored automation result in the viewer dialog — the click-through of an
 * automated commit review's notification, which outlives the session that produced
 * it. Reads the persisted copy when the session list doesn't hold the record, and
 * says so when it's gone (pruned, or cleared with the repo's app data) rather than
 * leaving a dead click.
 */
export async function openAutomationResult(
  repoPath: string,
  id: string,
): Promise<void> {
  const state = useAutomationResults.getState();
  if (state.results.some((r) => r.id === id)) {
    state.setOpen(id);
    return;
  }
  // Read through the write queue after a fresh reload: `getStore()` memoizes the
  // first `load()`, so a record another instance wrote since then is absent from
  // the cached snapshot and would read as pruned.
  const stored = await serialize(async () => {
    await reloadRaw();
    return readMerged(repoPath);
  }).catch((): AutomationRunResult[] => []);
  const found = stored.find((r) => r.id === id);
  if (!found) {
    toast.info("This review result is no longer available.");
    return;
  }
  useAutomationResults.getState().hydrate(found);
  useAutomationResults.getState().setOpen(id);
}
