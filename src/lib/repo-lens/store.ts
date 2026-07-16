import { load, type Store } from "@tauri-apps/plugin-store";
import { repoIdentity } from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { storeName } from "@/lib/test-mode";

// The per-repo origin|upstream lens for the Pull Requests + Issues surfaces,
// persisted in app data (never committed). Keyed by the repo's worktree-stable
// identity (git-common-dir), like the other per-repo personal stores, so the
// choice is shared across a repo's main checkout and every worktree.
//
// This is a NEW store file, so there are no legacy checkout-path-keyed entries
// to fold — a plain identity-key read/write suffices (no identityKeyFor).

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("repo-lens.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

/** Read the persisted lens for a repo. Any value that isn't exactly "upstream"
 *  (missing, hand-edited junk, an older shape) reads as "origin" — the safe
 *  default that targets the fork itself. */
export async function loadRepoLens(repo: string): Promise<RemoteLens> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const saved = await store.get(id);
  return saved === "upstream" ? "upstream" : "origin";
}

export async function saveRepoLens(
  repo: string,
  lens: RemoteLens,
): Promise<void> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  await store.set(id, lens);
}
