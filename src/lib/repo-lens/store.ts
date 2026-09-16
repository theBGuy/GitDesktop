import { repoIdentityStrict } from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { memoizedStoreLoader } from "@/lib/plugin-store";

// The per-repo origin|upstream lens for the Pull Requests + Issues surfaces,
// persisted in app data (never committed). Keyed by the repo's worktree-stable
// identity (git-common-dir), like the other per-repo personal stores, so the
// choice is shared across a repo's main checkout and every worktree.
//
// This is a NEW store file, so there are no legacy checkout-path-keyed entries
// to fold — a plain identity-key read/write suffices (no identityKeyFor).

const getStore = memoizedStoreLoader("repo-lens.json");

/** Read the persisted lens for a repo. Any value that isn't exactly "upstream"
 *  (missing, hand-edited junk, an older shape) reads as "origin" — the safe
 *  default that targets the fork itself.
 *
 *  The two failures are answered differently on purpose. An unreadable STORE
 *  defaults, so a corrupt preference file can't keep the panel from rendering. An
 *  unresolved IDENTITY rejects: the read pins for the session, so a default minted
 *  from a transport failure would outlive the outage and silently revert the user's
 *  choice — the observer must see the failure and retry instead. */
export async function loadRepoLens(repo: string): Promise<RemoteLens> {
  const id = await repoIdentityStrict(repo);
  try {
    const saved = await (await getStore()).get(id);
    return saved === "upstream" ? "upstream" : "origin";
  } catch {
    return "origin";
  }
}

/** Persist a repo's lens under its identity. REJECTS when the identity can't be
 *  resolved, which the caller reports: the only address available then is the raw
 *  checkout path, and a preference written there is invisible to every read once
 *  the lookup heals. Store open/write failures reject through the same caller
 *  path. A settled answer always writes, the legitimate non-repo raw path
 *  included — git returns that as a success. */
export async function saveRepoLens(
  repo: string,
  lens: RemoteLens,
): Promise<void> {
  const store = await getStore();
  const id = await repoIdentityStrict(repo);
  await store.set(id, lens);
}

/** Drop the persisted lens for a repo (hygiene after detaching from a fork —
 *  the upstream remote is gone, so a stale "upstream" entry no longer applies).
 *  Any subsequent read safe-defaults to "origin". Rejects on an unresolved
 *  identity like {@link saveRepoLens} (store failures reject the same way) — a
 *  delete aimed at the raw path would report success while leaving the real
 *  entry in place. */
export async function deleteRepoLens(repo: string): Promise<void> {
  const store = await getStore();
  const id = await repoIdentityStrict(repo);
  await store.delete(id);
}
