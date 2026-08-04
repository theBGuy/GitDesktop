import { load, type Store } from "@tauri-apps/plugin-store";
import type { ReviewMode } from "@/lib/ai/types";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/**
 * Persistent "dismissed head" watermarks for pr-sync automations. Cancelling an
 * auto re-review only aborts the in-flight run; without a persisted marker the
 * same head re-fires after an app relaunch (cancel advances no watermark). So on
 * cancel the runner records the PR head that was dismissed, keyed by
 * `(kind, ref, mode)` — the runner then skips a pr-sync whose head still matches
 * a dismissed head, and only re-fires once the head genuinely advances.
 *
 * Keyed by the repo's worktree-stable identity (not its checkout path), mirroring
 * the review-history store, so a dismissal is shared across the main checkout and
 * every worktree.
 */
type DismissalMap = Record<string, string>;

const cellKey = (kind: "remote" | "local", ref: string, mode: ReviewMode) =>
  `${kind}#${ref}#${mode}`;

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

// Re-read the store from disk, tolerating a store file that doesn't exist yet:
// `load()` tolerates a missing file but `reload()` rejects with a raw io error
// until the first `save()` creates it. Falls back to the in-memory state on ANY
// failure. Mirrors the same guard in reviews-history.ts.
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

/** The head SHA last dismissed for a PR + mode, or undefined if none. `fresh`
 *  reloads from disk first — the automation gates must read this watermark as
 *  fresh as the claim they pair with (see reviews-history.ts's `read`), since the
 *  plugin-store's per-process cache is otherwise loaded once at launch. */
export async function getDismissedHead(
  repo: string,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
  opts?: { fresh?: boolean },
): Promise<string | undefined> {
  if (opts?.fresh) await reloadRaw();
  const all = await readMerged(repo);
  return all[cellKey(kind, ref, mode)];
}

/** Records the head SHA dismissed for a PR + mode (overwriting any prior). */
export async function setDismissedHead(
  repo: string,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
  headSha: string,
): Promise<void> {
  const store = await getStore();
  const key = await keyFor(repo);
  const all = (await store.get<DismissalMap>(key)) ?? {};
  await store.set(key, { ...all, [cellKey(kind, ref, mode)]: headSha });
  // Flush now rather than on autoSave's ~100ms debounce: the gates reload from
  // disk, so a fresh read inside that window would discard this dismissal.
  await store.save();
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
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
): Promise<void> {
  const store = await getStore();
  const key = await keyFor(repo);
  const all = (await store.get<DismissalMap>(key)) ?? {};
  delete all[cellKey(kind, ref, mode)];
  await store.set(key, all);
  // Same flush as setDismissedHead: an unsaved clear would be undone by the next
  // fresh gate read, re-blocking the re-run this call exists to unblock.
  await store.save();
}
