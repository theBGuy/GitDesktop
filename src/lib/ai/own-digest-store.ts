import { load, type Store } from "@tauri-apps/plugin-store";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/**
 * A distilled decision ledger for one PR's over-budget GitDesktop-own comments,
 * cached so re-review only re-runs the generation model when the comments
 * actually change. `fingerprint` couples the ledger to the raw comments it was
 * distilled from (their count and newest timestamp, the section budget, and the
 * joined capped-block length); a mismatch forces a re-distill.
 * `ledger` is the model's own markdown — never parsed into structured data, and
 * always re-verified against the current diff by the reviewer that consumes it.
 */
export interface OwnCommentsDigest {
  schemaVersion: 1;
  /** `${kind}#${ref}` — one PR's ledger. */
  key: string;
  /** Invalidation token:
   *  `v2#${count}#${newestCreatedAt}#${budget}#${joinedBlockChars}` — the
   *  distilled comments' count and newest timestamp, the section budget they were
   *  sized to, and the joined length of the capped blocks (which moves on an
   *  in-place edit that changes neither of the first two). The leading version
   *  tag retires ledgers whose cached TEXT is no longer what we would produce
   *  today — it went to `v2` when the truncation note stopped claiming the omitted
   *  characters are "on the PR thread", a claim that is false for a ledger and
   *  would otherwise be served from cache into a prompt indefinitely. Bump it
   *  again for any future change to what a cached ledger's text says; records with
   *  a stale token simply miss once and re-distill. */
  fingerprint: string;
  /** The distilled ledger markdown — the cached soft context. */
  ledger: string;
  /** Generation model the ledger was produced with (diagnostic). */
  model: string;
  createdAt: number;
}

// Records live in personal app-data, keyed by the repo's worktree-stable identity
// (not its checkout path) so a PR's cached digest is shared across the main
// checkout and every worktree. Routed through storeName() so cold-start/test mode
// never pollutes real data. One digest per `${kind}#${ref}` key.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("own-comments-digest.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write through one in-process queue — without it two
// overlapping saves each reload the same pre-flush disk snapshot (autoSave's ~100ms
// debounce) and the later drops the earlier. Mirrors pr-reviews.json's chain.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  // Tolerate a missing store file: `load()` tolerates it but `reload()` rejects
  // with a raw io error until the first `save()` creates the file. Fall back to
  // the in-memory state on ANY reload failure — the next save() creates the file.
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing/unreadable file — proceed with in-memory state.
  }
}

/** The identity store key for `repo`, folding any legacy checkout-path-keyed
 *  record onto the identity key once (single-value store: prefer the identity
 *  value). Call inside the serialized queue so the fold orders with the mutation. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<Record<string, OwnCommentsDigest>>(
    store,
    "own-comments-digest",
    repo,
    (id, legacy) => ({ ...legacy, ...(id ?? {}) }),
  );
}

/** The cached digest for a PR, or undefined when none / on a missing store.
 *  Best-effort: never throws on a missing store file (`get` on an absent key
 *  returns undefined). */
export async function getDigest(
  repoPath: string,
  kind: "remote" | "local",
  ref: string,
): Promise<OwnCommentsDigest | undefined> {
  const store = await getStore();
  const id = await repoIdentity(repoPath);
  const primary =
    (await store.get<Record<string, OwnCommentsDigest>>(id)) ?? {};
  const legacy =
    id === repoPath
      ? {}
      : ((await store.get<Record<string, OwnCommentsDigest>>(repoPath)) ?? {});
  const bag = { ...legacy, ...primary };
  return bag[`${kind}#${ref}`];
}

/** Upserts one PR's digest under its `${kind}#${ref}` key — replaces the prior
 *  record for that key (one digest per PR). Serialized + force-saved so an
 *  overlapping save can't reload a pre-flush snapshot. */
export async function saveDigest(
  repoPath: string,
  record: OwnCommentsDigest,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repoPath);
    const store = await getStore();
    const bag = (await store.get<Record<string, OwnCommentsDigest>>(key)) ?? {};
    bag[record.key] = record;
    await store.set(key, bag);
    // Flush now instead of on autoSave's debounce, so the next serialized reload
    // can't re-read a pre-write disk snapshot and drop this change.
    await store.save();
  });
}
