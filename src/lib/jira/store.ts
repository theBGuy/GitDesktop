import { load, type Store } from "@tauri-apps/plugin-store";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/** A repo's link to a Jira project. Personal app-data — never written into the
 *  repo itself — keyed by the repo's worktree-stable identity so the link is
 *  shared across the main checkout and every worktree. */
export interface JiraLink {
  /** The Atlassian site host, e.g. `mycompany.atlassian.net`. */
  siteHost: string;
  /** The project key, e.g. `PROJ`. */
  projectKey: string;
  /** The project's display name, cached for the section header + picker. */
  projectName: string;
}

// Personal app-data — one link per repo, keyed by repo identity.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("jira-links.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store (and the reload) through one
// in-process queue — mirrors the local-issue/PR stores. Without it two
// overlapping mutations each reload the SAME pre-flush disk snapshot (autoSave
// persists on a ~100ms debounce) and the later write drops the earlier one's
// change. writeLink force-saves so each reload sees a current one.
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

/** Type-guard an untrusted stored value into a JiraLink; `null` when malformed
 *  (so a hand-edited or partially-corrupt entry can never crash a read). */
function asLink(v: unknown): JiraLink | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.siteHost !== "string" ||
    typeof o.projectKey !== "string" ||
    typeof o.projectName !== "string"
  ) {
    return null;
  }
  return {
    siteHost: o.siteHost,
    projectKey: o.projectKey,
    projectName: o.projectName,
  };
}

/** The identity value wins over any legacy checkout-path value when folding a
 *  single-value store (per identityKeyFor's contract). */
const preferIdentity = (id: JiraLink | undefined, legacy: JiraLink): JiraLink =>
  id ?? legacy;

/** This repo's Jira link (or `null` when unlinked). Read-only path: merges in a
 *  record still under a legacy checkout-path key (folded on the next mutation),
 *  so a worktree-created link shows up right away. */
export async function getJiraLink(repo: string): Promise<JiraLink | null> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = asLink(await store.get(id));
  if (primary) return primary;
  if (id === repo) return null;
  return asLink(await store.get(repo));
}

/** Identity store key for `repo`, folding any legacy checkout-path record onto
 *  it once. Call inside the serialized queue (after `reloadRaw`). */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<JiraLink>(store, "jira-links", repo, preferIdentity);
}

/** Link (or re-link) `repo` to a Jira project. */
export async function setJiraLink(
  repo: string,
  link: JiraLink,
): Promise<JiraLink> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(repo);
    await store.set(key, link);
    // Flush now (not on autoSave's debounce) so the next serialized reload can't
    // drop this.
    await store.save();
    return link;
  });
}

/** Remove `repo`'s Jira link (does NOT clear the keyring credential — the site
 *  account may serve other repos). */
export async function clearJiraLink(repo: string): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(repo);
    await store.delete(key);
    await store.save();
  });
}
