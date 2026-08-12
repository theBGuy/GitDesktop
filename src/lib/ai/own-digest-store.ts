import { load, type Store } from "@tauri-apps/plugin-store";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { storeName } from "@/lib/test-mode";

/**
 * A distilled decision ledger for one PR's over-budget GitDesktop-own comments,
 * cached so re-review only re-runs the generation model when the comments
 * actually change. `fingerprint` couples the ledger to the raw comments it was
 * distilled from (their count and newest timestamp, the section budget, and BOTH
 * the joined capped-block length and the uncapped length the distiller actually
 * read); a mismatch forces a re-distill. A FAILED attempt is remembered too, so a
 * thread that can't distill doesn't re-pay the model ceiling on every re-review —
 * and it rides ALONGSIDE any cached ledger in `failed`, with its own fingerprint,
 * so remembering a dead end never destroys a still-valid one.
 * `ledger` is the model's own markdown — never parsed into structured data, and
 * always re-verified against the current diff by the reviewer that consumes it.
 */
export interface OwnCommentsDigest {
  schemaVersion: 1;
  /** `${lens}#${kind}#${ref}` — one PR's ledger (see {@link digestKey}). */
  key: string;
  /** Invalidation token:
   *  `v4#${count}#${newestCreatedAt}#${budget}#${cappedJoinedChars}#${uncappedChars}`
   *  — the distilled comments' count and newest timestamp, the section budget they
   *  were sized to, and two lengths: the joined capped blocks (the section render
   *  this ledger was sized against) and the joined UNCAPPED blocks (what the
   *  distiller actually read). Both are needed because an in-place edit moves
   *  neither the count nor the newest timestamp, and an edit appended past a
   *  block's cap moves only the uncapped one. BUMP the leading version tag for any
   *  change that makes the cached TEXT differ from what we would produce today —
   *  distiller prompt, per-block or input caps, truncation-note wording — since
   *  every field above can stay identical while the ledger changes; a stale tag
   *  simply misses once and re-distills. */
  fingerprint: string;
  /** The distilled ledger markdown — the cached soft context. Empty when this
   *  record only carries a failure memory and no ledger has ever succeeded. */
  ledger: string;
  /** Generation model the ledger was produced with (diagnostic). */
  model: string;
  createdAt: number;
  /** The last distillation that failed, kept ALONGSIDE `ledger` rather than in
   *  place of it — its own `fingerprint` is what the retry check matches, so a
   *  failure for this round's comments never invalidates a ledger cached for an
   *  earlier round, and a merge can't overwrite a good ledger with an empty one.
   *  `at` anchors the retry window: a re-review inside it skips the attempt instead
   *  of re-paying the model ceiling to fail again, while one after it tries afresh —
   *  the usual causes (a missing generation key, a CLI not logged in, a network
   *  blip) are properties of the MODEL and never move the fingerprint, so without
   *  the clock a fixed config would stay locked out. `model` is the one the attempt
   *  was made with (diagnostic) — empty when the settings load itself threw, or
   *  when the provider runs on its account-default model (a blank
   *  `settings.ai.model`, the default for codex-cli and selectable on the other
   *  agent CLIs).
   *  Absent until something fails, and dropped again by the next success; optional,
   *  so `schemaVersion` stays 1 and older records read as never-failed. */
  failed?: { fingerprint: string; at: number; model: string };
}

/** Store key for one PR's ledger. The lens is part of it because a fork's origin
 *  and upstream lenses surface DIFFERENT PRs under the same number. */
export const digestKey = (
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
) => `${lens}#${kind}#${ref}`;

/** The pre-lens key a lens key supersedes. Pre-lens records recorded no lens, so policy
 *  adopts them as origin — the safe default (the fork's own PR). */
function legacyDigestKey(key: string): string | undefined {
  return key.startsWith("origin#") ? key.slice("origin#".length) : undefined;
}

// Records live in personal app-data, keyed by the repo's worktree-stable identity
// (not its checkout path) so a PR's cached digest is shared across the main
// checkout and every worktree. Routed through storeName() so cold-start/test mode
// never pollutes real data. One digest per `digestKey` key.
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
  lens: RemoteLens,
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
  const key = digestKey(lens, kind, ref);
  const preLens = legacyDigestKey(key);
  // A pre-lens record still serves the origin lens until the next write folds it.
  return bag[key] ?? (preLens === undefined ? undefined : bag[preLens]);
}

/** Upserts one PR's digest under its {@link digestKey} — replaces the prior
 *  record for that key (one digest per PR). Serialized + force-saved so an
 *  overlapping save can't reload a pre-flush snapshot.
 *
 *  For a FAILURE memory use {@link recordDigestFailure}, never this: a failure
 *  must merge onto whatever is already stored, and doing the read on the caller's
 *  side puts it outside the serialized queue — which is exactly how a concurrent
 *  success gets overwritten by a stale spread. */
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
    // This write supersedes any pre-lens record for the same PR — dropping it here
    // is the fold, one PR at a time, never a sweep over the store.
    const preLens = legacyDigestKey(record.key);
    if (preLens !== undefined) delete bag[preLens];
    await store.set(key, bag);
    // Flush now instead of on autoSave's debounce, so the next serialized reload
    // can't re-read a pre-write disk snapshot and drop this change.
    await store.save();
  });
}

/**
 * Records a FAILED distillation for one PR, merged onto whatever that PR's record
 * already holds — a cached ledger survives untouched, and only `failed` changes.
 *
 * The whole read-modify-write runs INSIDE the serialized queue, which is the point
 * of the function existing (the repo's settings-store house pattern: writers ride
 * the chain). Doing the read on the caller's side leaves a window between it and
 * the write — `getDigest` alone awaits `repoIdentity` plus two `store.get`s — and a
 * concurrent success landing in that window is then clobbered by the loser's stale
 * spread: the ledger is destroyed AND `failed` at the live fingerprint suppresses
 * a re-distill for the retry window.
 *
 * `key` is re-asserted rather than inherited from the spread, so a record that
 * somehow carries the wrong one is repaired rather than propagated.
 */
export async function recordDigestFailure(
  repoPath: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  failed: NonNullable<OwnCommentsDigest["failed"]>,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repoPath);
    const store = await getStore();
    const bag = (await store.get<Record<string, OwnCommentsDigest>>(key)) ?? {};
    const recordKey = digestKey(lens, kind, ref);
    // Adopt any pre-lens record for this PR rather than stranding its ledger — the
    // same one-PR-at-a-time fold `saveDigest` does.
    const preLens = legacyDigestKey(recordKey);
    const existing =
      bag[recordKey] ?? (preLens === undefined ? undefined : bag[preLens]);
    if (preLens !== undefined) delete bag[preLens];
    bag[recordKey] = {
      // No record yet → a ledger-less skeleton, so the failure has somewhere to
      // live without inventing a ledger that was never produced.
      ...(existing ?? {
        schemaVersion: 1,
        fingerprint: failed.fingerprint,
        ledger: "",
        model: "",
        createdAt: failed.at,
      }),
      key: recordKey,
      failed,
    };
    await store.set(key, bag);
    await store.save();
  });
}
