import { load, type Store } from "@tauri-apps/plugin-store";
import type { ReviewMode } from "@/lib/ai/types";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { storeName } from "@/lib/test-mode";
import { ALL_ACTION_IDS } from "./types";

/**
 * Persistent "dismissed head" watermarks for pr-sync automations. Cancelling an
 * auto re-review only aborts the in-flight run; without a persisted marker the
 * same head re-fires after an app relaunch (cancel advances no watermark). So on
 * cancel the runner records the PR head that was dismissed, keyed by
 * `(lens, kind, ref, mode)` — the runner then skips a pr-sync whose head still
 * matches a dismissed head, and only re-fires once the head genuinely advances.
 *
 * Keyed by the repo's worktree-stable identity (not its checkout path), mirroring
 * the review-history store, so a dismissal is shared across the main checkout and
 * every worktree.
 */
type DismissalMap = Record<string, string>;

/** Cell key for one PR + mode. The lens leads it because a fork's origin and
 *  upstream lenses surface DIFFERENT PRs under the same number. */
const cellKey = (
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
) => `${lens}#${kind}#${ref}#${mode}`;

/** The pre-lens cell prefix a lens cell supersedes. Pre-lens cells recorded no lens, so
 *  policy adopts them as origin — the safe default. Undefined on any other lens: the fold
 *  targets only the bare pre-lens key, which policy assigns to origin. */
const legacyCellPrefix = (
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
) => (lens === "origin" ? `${kind}#${ref}#` : undefined);

// Personal app-data, keyed by repo identity — never written into the repo itself.
// Routed through storeName() so cold-start/test mode never pollutes real data.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("automation-dismissals.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write AND every fresh read on this store through one
// in-process queue: a reload replaces the whole in-memory map from disk, so one
// landing between a writer's `set` and its flush would persist the pre-write state
// and silently drop the dismissal. Mirrors automations/store.ts and
// reviews-history.ts. In-process only; cross-window races remain out of scope.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

// Re-read the store from disk, tolerating a store file that doesn't exist yet:
// `load()` tolerates a missing file but `reload()` rejects with a raw io error
// until the first `save()` creates it. Falls back to the in-memory state on ANY
// failure. Mirrors the same guard in reviews-history.ts. Call inside the serialized
// queue so it can't land between a set and its flush.
async function reloadRaw(): Promise<void> {
  const store = await getStore();
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

// Reads merge in any records still under a legacy checkout-path key (folded onto
// the identity key by the next write via `keyFor`).
async function readMerged(repo: string): Promise<DismissalMap> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = (await store.get<DismissalMap>(id)) ?? {};
  const legacy =
    id === repo ? {} : ((await store.get<DismissalMap>(repo)) ?? {});
  // Identity-keyed values win on a shared cell key.
  return { ...legacy, ...primary };
}

async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<DismissalMap>(
    store,
    "automation-dismissals",
    repo,
    (identityVal, legacyVal) => ({ ...legacyVal, ...identityVal }),
  );
}

/** Reads the merged map, optionally re-reading the store from disk first. `fresh`
 *  is what the automation gates need: the plugin-store's per-process cache is
 *  otherwise loaded once at launch, so a gate would decide on state predating
 *  another instance's dismissal. Reload and read run inside the queue, ordered with
 *  any in-flight write. */
async function readDismissals(
  repo: string,
  opts?: { fresh?: boolean },
): Promise<DismissalMap> {
  if (!opts?.fresh) return readMerged(repo);
  return serialize(async () => {
    await reloadRaw();
    return readMerged(repo);
  });
}

// Derived from the action registry rather than another copy of the literal pair, so a
// new mode can't be silently dropped here (`ActionId` IS `ReviewMode`).
const isReviewMode = (v: string): v is ReviewMode =>
  (ALL_ACTION_IDS as readonly string[]).includes(v);

/** Every mode's dismissed head for ONE PR, in a single read. The automation gates
 *  check both modes per event, and each `fresh` read reloads (and queues behind any
 *  write) — so they take the whole PR's cells at once instead of once per mode.
 *  `fresh` re-reads the store from disk first — see {@link readDismissals}. */
export async function getDismissedHeadMap(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  opts?: { fresh?: boolean },
): Promise<Partial<Record<ReviewMode, string>>> {
  const all = await readDismissals(repo, opts);
  const byMode: Partial<Record<ReviewMode, string>> = {};
  // Pre-lens cells still serve the origin lens until the next write folds them, and
  // they lose to a lens cell for the same mode. No cell can match both prefixes: a
  // lens cell leads with the lens, a pre-lens one with the kind.
  const prefixes = [
    legacyCellPrefix(lens, kind, ref),
    `${lens}#${kind}#${ref}#`,
  ];
  for (const prefix of prefixes) {
    if (prefix === undefined) continue;
    for (const [cell, headSha] of Object.entries(all)) {
      if (!cell.startsWith(prefix)) continue;
      // Cell and value both come from the store, so both are untrusted — keep only real
      // modes, and only string heads (a hand-edited value would throw inside sameSha).
      const mode = cell.slice(prefix.length);
      if (isReviewMode(mode) && typeof headSha === "string")
        byMode[mode] = headSha;
    }
  }
  return byMode;
}

/** Records the head SHA dismissed for a PR + mode (overwriting any prior). */
export async function setDismissedHead(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
  headSha: string,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    // Reload before the read-modify-write: this rewrites the whole per-repo map, so
    // basing it on a launch-time cache would drop another instance's cells.
    await reloadRaw();
    const key = await keyFor(repo);
    const all = { ...((await store.get<DismissalMap>(key)) ?? {}) };
    // This watermark supersedes any pre-lens cell for the same PR + mode — dropping
    // it here is the fold, one cell at a time, never a sweep over the store.
    const preLens = legacyCellPrefix(lens, kind, ref);
    if (preLens !== undefined) delete all[`${preLens}${mode}`];
    await store.set(key, { ...all, [cellKey(lens, kind, ref, mode)]: headSha });
    // Flush past autoSave's ~100ms debounce so the next queued reload reads this
    // write back instead of a pre-write snapshot.
    await store.save();
  });
}

/**
 * Clears the dismissed-head watermark for a PR + mode. Called when a cancelled
 * automation run is re-run: the cancel wrote a dismissed head, and without
 * clearing it a subsequent pr-sync (or the re-run itself) silently no-ops at the
 * runner's `sameSha(dismissedHead, headSha)` gate. Best-effort at the call site
 * — a clear failure must not block the re-run.
 */
export async function clearDismissedHead(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    // Same reload-first rationale as setDismissedHead.
    await reloadRaw();
    const key = await keyFor(repo);
    const all = { ...((await store.get<DismissalMap>(key)) ?? {}) };
    delete all[cellKey(lens, kind, ref, mode)];
    // The pre-lens cell goes too — it reads as this lens's watermark, so leaving it
    // would keep re-blocking the re-run this call exists to unblock.
    const preLens = legacyCellPrefix(lens, kind, ref);
    if (preLens !== undefined) delete all[`${preLens}${mode}`];
    await store.set(key, all);
    // Flush for the same reason: an unflushed clear would be undone by the next
    // queued reload, re-blocking the re-run this call exists to unblock.
    await store.save();
  });
}
