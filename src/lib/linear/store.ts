import { load, type Store } from "@tauri-apps/plugin-store";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/** A repo's link to a Linear team. Personal app-data — never written into the
 *  repo itself — keyed by the repo's worktree-stable identity so the link is
 *  shared across the main checkout and every worktree. */
export interface LinearLink {
  /** The team's short key, e.g. `ENG`. */
  teamKey: string;
  /** The team's display name, cached for the section header + picker. */
  teamName: string;
}

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("linear-links.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store (and the reload) through one
// in-process queue — mirrors the Jira/local-issue/PR stores. Without it two
// overlapping mutations each reload the SAME pre-flush disk snapshot (autoSave
// persists on a ~100ms debounce) and the later write drops the earlier one's
// change. writeLink force-saves so each reload sees a current one.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing/unreadable file — proceed with in-memory state; the next save()
    // creates it.
  }
}

/** Type-guard an untrusted stored value into a LinearLink; `null` when malformed. */
function asLink(v: unknown): LinearLink | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.teamKey !== "string" || typeof o.teamName !== "string") {
    return null;
  }
  return { teamKey: o.teamKey, teamName: o.teamName };
}

const preferIdentity = (
  id: LinearLink | undefined,
  legacy: LinearLink,
): LinearLink => id ?? legacy;

/** This repo's Linear link (or `null` when unlinked). Read-only path: merges in
 *  a record still under a legacy checkout-path key (folded on the next mutation),
 *  so a worktree-created link shows up right away. */
export async function getLinearLink(repo: string): Promise<LinearLink | null> {
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
  return identityKeyFor<LinearLink>(
    store,
    "linear-links",
    repo,
    preferIdentity,
  );
}

/** Link (or re-link) `repo` to a Linear team. */
export async function setLinearLink(
  repo: string,
  link: LinearLink,
): Promise<LinearLink> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(repo);
    await store.set(key, link);
    await store.save();
    return link;
  });
}

/** Remove `repo`'s Linear link (does NOT clear the keyring credential — the
 *  account may serve other repos). */
export async function clearLinearLink(repo: string): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(repo);
    await store.delete(key);
    await store.save();
  });
}
