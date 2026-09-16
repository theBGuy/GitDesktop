import type { Store } from "@tauri-apps/plugin-store";
import { invoke } from "@/lib/tauri/invoke";

// A repository's *worktree-stable identity key*: the absolute path of its common
// git directory (`git rev-parse --git-common-dir`), which is identical for the
// main checkout and every linked worktree of the same repo. The per-repo app-data
// stores (local PRs/issues, review history + drafts, branch rules, automations)
// key their records on this so a PR created inside a worktree is visible from the
// main checkout and vice-versa — instead of being split by checkout path (the
// worktree-unaware bug). The Rust `git_repo_identity` command is the single shared
// resolver; the MCP server calls the same Rust fn directly, so the GUI and MCP can
// never disagree on the key.

/** How long an answer stays authoritative before the next resolve re-asks git. A
 *  checkout path can be deleted and re-cloned as a DIFFERENT repository inside one
 *  session, and nothing in this module can observe that — an immortal memo then
 *  mis-keys every per-repo store for the rest of the session, silently. Five
 *  minutes bounds that mis-attribution to one window while staying clear of the
 *  app's polling cadences (the 60s PR-sync tick, every query refetch): those keep
 *  hitting the memo instead of minting a git spawn apiece. */
export const IDENTITY_TTL_MS = 300_000;

/** Ages come off the monotonic clock, never `Date.now()`: an NTP correction or a
 *  user clock change would otherwise make a fresh entry look arbitrarily old, or
 *  strand a stale one as fresh. Only differences are ever read. */
const stamp = (): number => performance.now();

type IdentityEntry = { at: number; id: Promise<string> };

/** In-flight or already-answered resolve per path, stamped with the moment its IPC
 *  was issued — a hit older than {@link IDENTITY_TTL_MS} re-resolves rather than
 *  serving. */
const identityCache = new Map<string, IdentityEntry>();
/** Resolved keys only, written where the IPC call succeeds — the synchronous view
 *  of {@link identityCache}, whose entries are Promises a peek cannot inspect.
 *  Holds whatever the resolver answered, including the Rust-side raw-path
 *  fallback for a live-but-unresolvable repo — callers keep treating
 *  `identity === repoPath` as "no identity". Entries are stamped but never
 *  dropped; each reader decides what age it will honor. */
const settledIdentities = new Map<string, { at: number; id: string }>();

/** Resolve `repoPath` to its identity key (memoized per path for
 *  {@link IDENTITY_TTL_MS}), REJECTING when the IPC call fails. The Rust command
 *  owns the unresolvable-repo case itself and answers the raw path, so a rejection
 *  here is transport failure alone. Rejection is the WRITER's contract and is never
 *  softened with a remembered answer: a store write during an outage must refuse
 *  rather than address itself by an identity nothing just confirmed — the path may
 *  have changed hands since. Readers that would rather show continuity than an
 *  error take {@link settledIdentityWithin} explicitly. */
export function repoIdentityStrict(repoPath: string): Promise<string> {
  const now = stamp();
  const hit = identityCache.get(repoPath);
  if (hit && now - hit.at < IDENTITY_TTL_MS) return hit.id;
  const entry: IdentityEntry = {
    at: now,
    id: invoke<string>("git_repo_identity", { repoPath })
      .then((id) => {
        // Newest ANSWER wins, not newest arrival: the window re-issues while a slow
        // probe is still out, so an older resolve can settle last and would
        // otherwise restore the identity the re-issue just corrected.
        const prev = settledIdentities.get(repoPath);
        if (!prev || prev.at <= now)
          settledIdentities.set(repoPath, { at: now, id });
        return id;
      })
      .catch((e) => {
        // Drop the failed attempt so the next call asks git again — but only if a
        // re-issue hasn't already replaced it, which this one's failure says nothing
        // about.
        if (identityCache.get(repoPath) === entry)
          identityCache.delete(repoPath);
        throw e;
      }),
  };
  identityCache.set(repoPath, entry);
  return entry.id;
}

/** The identity this session learned for `repoPath`, at any age, or undefined when
 *  it never resolved one. READ-ONLY on the memo: never resolves, never populates.
 *  For callers that must not RESOLVE — a dead path answers the raw-path fallback and
 *  would pin it — but may honor an identity learned while the path was still alive.
 *  Deliberately unaged, for both its consumers: the notification ladder asks about
 *  checkouts that are GONE, which never re-stamp and whose identity-keyed mute has to
 *  outlive the folder, and {@link repoIdentity}'s fallback must never expire into a
 *  raw path that would redirect a write. */
export function peekRepoIdentity(repoPath: string): string | undefined {
  return settledIdentities.get(repoPath)?.id;
}

/** {@link peekRepoIdentity} bounded by age — the seam for a query READER that would
 *  rather show the last identity than an error while a re-validation is failing.
 *  Reader-only by design: a bound is affordable where running out of it renders an
 *  error body, and unaffordable where it would silently redirect a write (see
 *  {@link repoIdentity}). `maxAgeMs` is the caller's policy. */
export function settledIdentityWithin(
  repoPath: string,
  maxAgeMs: number,
): string | undefined {
  const hit = settledIdentities.get(repoPath);
  return hit && stamp() - hit.at < maxAgeMs ? hit.id : undefined;
}

/** {@link repoIdentityStrict} for callers with nowhere to put a failure: never
 *  rejects, standing in the LAST KNOWN identity when the IPC call fails, and in the
 *  raw path only for a path this session never resolved — the same key the Rust
 *  fallback produces. For one-shot store/fold callers; observers that can retry use
 *  the strict form. */
export async function repoIdentity(repoPath: string): Promise<string> {
  try {
    return await repoIdentityStrict(repoPath);
  } catch {
    // Unaged, unlike the query reader's bounded grace, because the two non-refusing
    // surfaces lose differently. Here a fallback REDIRECTS a write: a raw-path
    // record is one that healed reads never consult once an identity-keyed record
    // exists, and identityKeyFor's once-per-session guard won't migrate it — the
    // write is lost with nothing on screen. A reader running out of grace only
    // renders an error body, which is visible and self-corrects. So a path resolved
    // once never answers the raw path again; the TTL still heals a reused path
    // within its window whenever git is answering at all.
    return peekRepoIdentity(repoPath) ?? repoPath;
  }
}

/** Merge two id-bearing lists, dropping duplicates by `id`; `keep`'s items come
 *  first and win on a shared id, and first occurrence wins within `extra` too.
 *  `keep` itself passes through verbatim (never deduped). Used to fold a legacy
 *  path-keyed record list into the identity key's list during migration. */
export function mergeById<T extends { id: string }>(
  keep: T[] | undefined,
  extra: T[],
): T[] {
  const base = keep ?? [];
  const seen = new Set(base.map((x) => x.id));
  const rest: T[] = [];
  for (const x of extra) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    rest.push(x);
  }
  return [...base, ...rest];
}

// In-flight/settled fold per (store, path), so the legacy migration runs at most
// once per session and concurrent callers await the SAME fold (a single save)
// rather than each redoing it. A rejected fold is dropped from the map so a later
// call retries. Keyed `tag::repoPath` (a printable separator — never an invisible
// sentinel, which git treats as a binary file). Deliberately NOT expired alongside
// the identity memo: a path holds at most one legacy record, so a guard that
// outlives a path changing hands only skips a fold with nothing left to move.
const folds = new Map<string, Promise<void>>();

/** Resolve `repoPath`'s identity key and, once, fold any record still stored under
 *  the raw checkout path (pre-identity-keying) into the identity key via `merge`,
 *  then delete the legacy key. Returns the key the caller should read/write under.
 *  `merge(identityVal, legacyVal)` combines the two — for list stores use
 *  {@link mergeById}; for single-value stores prefer the identity value
 *  (`(id, legacy) => id ?? legacy`). `tag` namespaces the once-guard per store.
 *  Idempotent: a no-op passthrough once folded (or when the identity couldn't be
 *  resolved and equals the raw path). Callers that serialize their own writes
 *  should invoke this inside that queue so the fold is ordered with their ops. */
export async function identityKeyFor<T>(
  store: Store,
  tag: string,
  repoPath: string,
  merge: (identityVal: T | undefined, legacyVal: T) => T,
): Promise<string> {
  const id = await repoIdentity(repoPath);
  // Fallback fired (git unresolved): the raw path IS the key, so there's no
  // distinct legacy entry to fold.
  if (id === repoPath) return id;
  const guard = `${tag}::${repoPath}`;
  // Register the fold synchronously (before the first await) so two concurrent
  // callers share one fold + one save. On failure, drop it so a later call retries.
  let fold = folds.get(guard);
  if (!fold) {
    fold = (async () => {
      const legacy = await store.get<T>(repoPath);
      if (legacy != null) {
        const current = await store.get<T>(id);
        await store.set(id, merge(current, legacy));
        await store.delete(repoPath);
        await store.save();
      }
    })().catch((e) => {
      folds.delete(guard);
      throw e;
    });
    folds.set(guard, fold);
  }
  await fold;
  return id;
}
