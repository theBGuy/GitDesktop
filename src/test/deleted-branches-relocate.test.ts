import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletedBranchEntry } from "@/lib/deleted-branches/store";

// A relocate whose new folder's identity didn't resolve, end to end: the real
// migration and the real Deleted branches store over one in-memory map per store
// file, answered at the Tauri IPC layer the store plugin calls. The identity
// resolver is the app's IPC seam; the store lock and task-scope re-home stand
// aside.
const h = vi.hoisted(() => ({
  files: new Map<string, Map<string, unknown>>(),
  resolve: vi.fn<(repoPath: string) => Promise<string>>(),
}));

/** The store plugin's commands over `h.files`, one resource id per file. */
function mockStorePlugin() {
  const byRid = new Map<number, Map<string, unknown>>();
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as {
      path?: string;
      rid?: number;
      key?: string;
      value?: unknown;
    };
    if (cmd === "plugin:store|load") {
      const path = args.path ?? "";
      let data = h.files.get(path);
      if (data === undefined) {
        data = new Map();
        h.files.set(path, data);
      }
      const rid = byRid.size + 1;
      byRid.set(rid, data);
      return rid;
    }
    const data = byRid.get(args.rid ?? -1);
    if (data === undefined) throw new Error(`no store for ${cmd}`);
    const key = args.key ?? "";
    switch (cmd) {
      case "plugin:store|get":
        return [structuredClone(data.get(key)), data.has(key)];
      case "plugin:store|set":
        data.set(key, structuredClone(args.value));
        return null;
      case "plugin:store|delete":
        return data.delete(key);
      case "plugin:store|keys":
        return [...data.keys()];
      case "plugin:store|entries":
        return [...data.entries()];
      case "plugin:store|clear":
        data.clear();
        return null;
      case "plugin:store|save":
      case "plugin:store|reload":
        return null;
      default:
        throw new Error(`unexpected ${cmd}`);
    }
  });
}

vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: async (_file: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/scripts/store", () => ({
  rehomeTaskScopes: async () => undefined,
}));
vi.mock("@/lib/tauri/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/invoke")>()),
  invoke: (_cmd: string, args: { repoPath: string }) =>
    h.resolve(args.repoPath),
}));

const OLD = "C:/repos/moved-from";
const NEW = "C:/repos/moved-to";
const NEW_ID = `${NEW}/.git`;
const FILE = "deleted-branches.json";

function entry(n: number): DeletedBranchEntry {
  return {
    id: `id-${n}`,
    name: `feat/${n}`,
    tip: (n + 1).toString(16).padStart(40, "0"),
    deletedAt: 1_000 + n,
    keptLocal: false,
    upstream: null,
  };
}

/** A fresh session: the identity memo, the fold guard and the store's queue. */
async function session() {
  vi.resetModules();
  const [migration, store] = await Promise.all([
    import("@/lib/repo-data-migration"),
    import("@/lib/deleted-branches/store"),
  ]);
  return { ...migration, ...store };
}

const stored = () => h.files.get(FILE) ?? new Map<string, unknown>();
const ids = (key: string) =>
  (stored().get(key) as DeletedBranchEntry[]).map((e) => e.id);

beforeEach(() => {
  h.files.clear();
  h.files.set(FILE, new Map([[`${OLD}/.git`, [entry(2), entry(1)]]]));
  h.resolve.mockReset();
  mockStorePlugin();
});

afterEach(() => {
  clearMocks();
});

describe("relocating a repository keeps its Deleted branches record", () => {
  it("lists and folds the record a relocate left under the raw path when the identity failed", async () => {
    h.resolve.mockRejectedValue(new Error("ipc down"));
    const relocating = await session();
    await relocating.migrateRepoData(OLD, NEW);
    expect([...stored().keys()]).toEqual([NEW]);

    h.resolve.mockResolvedValue(NEW_ID);
    const later = await session();
    await expect(later.loadDeletedBranches(NEW_ID, NEW)).resolves.toEqual([
      entry(2),
      entry(1),
    ]);
    await expect(later.recordDeletedBranches(NEW, [entry(3)])).resolves.toBe(
      true,
    );
    expect([...stored().keys()]).toEqual([NEW_ID]);
    expect(ids(NEW_ID)).toEqual(["id-3", "id-2", "id-1"]);
  });

  it("does the same when the resolver answers the raw path without rejecting", async () => {
    h.resolve.mockImplementation(async (repoPath) => repoPath);
    const relocating = await session();
    await relocating.migrateRepoData(OLD, NEW);
    expect([...stored().keys()]).toEqual([NEW]);

    h.resolve.mockImplementation(async () => NEW_ID);
    const later = await session();
    await expect(later.loadDeletedBranches(NEW_ID, NEW)).resolves.toEqual([
      entry(2),
      entry(1),
    ]);
    await expect(later.recordDeletedBranches(NEW, [entry(3)])).resolves.toBe(
      true,
    );
    expect([...stored().keys()]).toEqual([NEW_ID]);
    expect(ids(NEW_ID)).toEqual(["id-3", "id-2", "id-1"]);
  });
});
