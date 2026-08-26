import { load, type Store } from "@tauri-apps/plugin-store";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

/** A repo's link to a Linear team. Personal app-data — never written into the
 *  repo itself — keyed by the repo's worktree-stable identity. */
export interface LinearLink {
  /** The workspace slug, for building URLs. */
  workspaceSlug: string;
  /** The team UUID from the Linear API. Required for issue creation. */
  teamId: string;
  /** The team key, e.g. `ENG`. */
  teamKey: string;
  /** The team's display name, cached for the section header. */
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
    // Missing/unreadable file — proceed with in-memory state.
  }
}

function asLink(v: unknown): LinearLink | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (
    typeof o.workspaceSlug !== "string" ||
    typeof o.teamKey !== "string" ||
    typeof o.teamName !== "string"
  ) {
    return null;
  }
  return {
    workspaceSlug: o.workspaceSlug,
    teamId: typeof o.teamId === "string" ? o.teamId : "",
    teamKey: o.teamKey,
    teamName: o.teamName,
  };
}

const preferIdentity = (
  id: LinearLink | undefined,
  legacy: LinearLink,
): LinearLink => id ?? legacy;

export async function getLinearLink(repo: string): Promise<LinearLink | null> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = asLink(await store.get(id));
  if (primary) return primary;
  if (id === repo) return null;
  return asLink(await store.get(repo));
}

async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<LinearLink>(
    store,
    "linear-links",
    repo,
    preferIdentity,
  );
}

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

export async function clearLinearLink(repo: string): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const store = await getStore();
    const key = await keyFor(repo);
    await store.delete(key);
    await store.save();
  });
}
