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

const identityCache = new Map<string, Promise<string>>();

/** Resolve `repoPath` to its worktree-stable identity key (memoized per path).
 *  Falls back to the raw path when git can't resolve it (a non-repo path, or an
 *  IPC failure) — a stable key that matches the Rust fallback exactly. Failures
 *  aren't cached, so a transient error doesn't pin a repo to the raw path for the
 *  whole session. */
export function repoIdentity(repoPath: string): Promise<string> {
  const hit = identityCache.get(repoPath);
  if (hit) return hit;
  const p = (async () => {
    try {
      return await invoke<string>("git_repo_identity", { repoPath });
    } catch {
      identityCache.delete(repoPath);
      return repoPath;
    }
  })();
  identityCache.set(repoPath, p);
  return p;
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
// sentinel, which git treats as a binary file).
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
