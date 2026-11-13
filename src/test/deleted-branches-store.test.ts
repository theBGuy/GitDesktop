import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeletedBranchEntry } from "@/lib/deleted-branches/store";

// One in-memory map stands in for the store file AND its cache: a reload runs
// `onReload` once, which is how a test plays another instance writing between
// this one's loads. Rollback restores the map as it was before the write, as
// the real helper restores the store. Each case re-imports the module, so its
// serialize chain and mint clock start fresh.
const h = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  onReload: null as (() => void) | null,
  failSave: false,
  failReload: false,
  reloads: 0,
  identity: vi.fn<(repo: string) => Promise<string>>(),
}));

vi.mock("@/lib/plugin-store", () => {
  const store = {
    get: async (key: string) => structuredClone(h.data.get(key)),
    set: async (key: string, value: unknown) => {
      h.data.set(key, structuredClone(value));
    },
    save: async () => {
      if (h.failSave) throw new Error("disk full");
    },
  };
  return {
    memoizedStoreLoader: () => async () => store,
    reloadToleratingEmptyStore: async () => {
      if (h.failReload) throw new Error("unreadable");
      h.reloads++;
      const external = h.onReload;
      h.onReload = null;
      external?.();
    },
  };
});
vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: async (_file: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/plugin-store-rollback", () => ({
  writeWithRollback: async (_store: unknown, fn: () => Promise<unknown>) => {
    const before = new Map(h.data);
    try {
      return await fn();
    } catch (e) {
      h.data.clear();
      for (const [k, v] of before) h.data.set(k, v);
      throw e;
    }
  },
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentityStrict: (repo: string) => h.identity(repo),
}));

const ID = "C:/repos/demo/.git";
const REPO = "C:/repos/demo";
const tipOf = (n: number) => n.toString(16).padStart(40, "0");

const fresh = async () => {
  vi.resetModules();
  return import("@/lib/deleted-branches/store");
};

beforeAll(async () => {
  await import("@/lib/deleted-branches/store");
}, 60_000);

beforeEach(() => {
  h.data.clear();
  h.onReload = null;
  h.failSave = false;
  h.failReload = false;
  h.reloads = 0;
  h.identity.mockReset();
  h.identity.mockResolvedValue(ID);
});

function entry(
  n: number,
  overrides: Partial<DeletedBranchEntry> = {},
): DeletedBranchEntry {
  return {
    id: `id-${n}`,
    name: `feat/${n}`,
    tip: tipOf(n + 1),
    deletedAt: 1_000 + n,
    keptLocal: false,
    upstream: null,
    ...overrides,
  };
}

describe("recordDeletedBranches", () => {
  it("stores the entry under the repo's identity, not its path", async () => {
    const store = await fresh();
    const minted = store.mintDeletedBranch({
      name: "feat/x",
      tip: tipOf(7),
      keptLocal: true,
      upstream: "origin/feat/x",
    });
    await expect(store.recordDeletedBranches(REPO, [minted])).resolves.toBe(
      true,
    );
    expect(h.identity).toHaveBeenCalledWith(REPO);
    expect([...h.data.keys()]).toEqual([ID]);
    expect(h.data.get(ID)).toEqual([minted]);
    expect(minted).toMatchObject({
      id: expect.any(String),
      deletedAt: expect.any(Number),
    });
    await expect(store.loadDeletedBranches(ID)).resolves.toEqual([minted]);
  });

  it("keeps the newest 50, newest first, after 51 writes", async () => {
    const store = await fresh();
    const written: DeletedBranchEntry[] = [];
    for (let i = 0; i < 51; i++) {
      const e = store.mintDeletedBranch({
        name: `feat/${i}`,
        tip: tipOf(i + 1),
        keptLocal: false,
        upstream: null,
      });
      written.push(e);
      await store.recordDeletedBranches(REPO, [e]);
    }
    const list = await store.loadDeletedBranches(ID);
    expect(store.DELETED_BRANCHES_CAP).toBe(50);
    expect(list).toHaveLength(50);
    expect(list[0].name).toBe("feat/50");
    expect(list.at(-1)?.name).toBe("feat/1");
    expect(list.some((e) => e.name === "feat/0")).toBe(false);
  });

  it("resolves false when the cap cuts the entry it just added, leaving its time as minted", async () => {
    const store = await fresh();
    // Stored by a clock that has since been set back.
    const ahead = Array.from({ length: 50 }, (_, i) =>
      entry(100 + i, { deletedAt: 9_000_000 + i }),
    );
    h.data.set(ID, ahead);
    const added = entry(1, { deletedAt: 1_000 });
    await expect(store.recordDeletedBranches(REPO, [added])).resolves.toBe(
      false,
    );
    expect(added.deletedAt).toBe(1_000);
    const list = await store.loadDeletedBranches(ID);
    expect(list).toHaveLength(50);
    expect(list.some((e) => e.id === added.id)).toBe(false);
  });

  it("never writes an entry whose tip isn't a full object id, and reports the batch unrecorded", async () => {
    const store = await fresh();
    await expect(
      store.recordDeletedBranches(REPO, [entry(1, { tip: "main" }), entry(2)]),
    ).resolves.toBe(false);
    expect((h.data.get(ID) as DeletedBranchEntry[]).map((e) => e.id)).toEqual([
      "id-2",
    ]);
    const reloads = h.reloads;
    await expect(
      store.recordDeletedBranches(REPO, [entry(3, { tip: "abc1234" })]),
    ).resolves.toBe(false);
    expect(h.reloads).toBe(reloads);
    expect((h.data.get(ID) as DeletedBranchEntry[]).map((e) => e.id)).toEqual([
      "id-2",
    ]);
  });

  it("keeps existing entries when a mixed batch is partly written", async () => {
    const store = await fresh();
    await expect(store.recordDeletedBranches(REPO, [entry(1)])).resolves.toBe(
      true,
    );
    await expect(
      store.recordDeletedBranches(REPO, [entry(2, { tip: "main" }), entry(3)]),
    ).resolves.toBe(false);
    expect((h.data.get(ID) as DeletedBranchEntry[]).map((e) => e.id)).toEqual([
      "id-3",
      "id-1",
    ]);
  });

  it("orders entries minted in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    try {
      const store = await fresh();
      const batch = [1, 2, 3].map((i) =>
        store.mintDeletedBranch({
          name: `feat/${i}`,
          tip: tipOf(i),
          keptLocal: false,
          upstream: null,
        }),
      );
      expect(batch.map((e) => e.deletedAt)).toEqual([5_000, 5_001, 5_002]);
      await store.recordDeletedBranches(REPO, batch);
      const list = await store.loadDeletedBranches(ID);
      expect(list.map((e) => e.name)).toEqual(["feat/3", "feat/2", "feat/1"]);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("resolves false and writes nothing when the identity can't be resolved", async () => {
    h.identity.mockRejectedValue(new Error("ipc down"));
    const store = await fresh();
    await expect(store.recordDeletedBranches(REPO, [entry(1)])).resolves.toBe(
      false,
    );
    expect(h.data.size).toBe(0);
  });

  it("resolves false and writes nothing when the save fails, and the chain survives", async () => {
    h.failSave = true;
    const store = await fresh();
    await expect(store.recordDeletedBranches(REPO, [entry(1)])).resolves.toBe(
      false,
    );
    expect(h.data.size).toBe(0);
    h.failSave = false;
    await expect(store.recordDeletedBranches(REPO, [entry(2)])).resolves.toBe(
      true,
    );
    expect(h.data.get(ID)).toEqual([entry(2)]);
  });

  it("keeps an entry another instance wrote between this one's loads", async () => {
    const store = await fresh();
    await store.recordDeletedBranches(REPO, [entry(1)]);
    // Another instance records a delete after this one's last load.
    h.onReload = () => h.data.set(ID, [entry(1), entry(2)]);
    await store.recordDeletedBranches(REPO, [entry(3)]);
    expect((h.data.get(ID) as DeletedBranchEntry[]).map((e) => e.id)).toEqual([
      "id-3",
      "id-2",
      "id-1",
    ]);
  });
});

describe("parseDeletedBranches", () => {
  it("drops a malformed entry without blanking the list", async () => {
    const { parseDeletedBranches } = await fresh();
    const good1 = entry(1);
    const good2 = entry(2);
    expect(
      parseDeletedBranches([
        good2,
        { ...entry(3), tip: "abc123" },
        { ...entry(4), id: 4 },
        { ...entry(5), deletedAt: "now" },
        { ...entry(6), name: "" },
        null,
        "feat/x",
        good1,
      ]),
    ).toEqual([good2, good1]);
    expect(parseDeletedBranches("not a list")).toEqual([]);
    expect(parseDeletedBranches(undefined)).toEqual([]);
  });

  it("reads a non-boolean keptLocal as true and a non-string upstream as null", async () => {
    const { parseDeletedBranches } = await fresh();
    expect(
      parseDeletedBranches([
        { ...entry(1), keptLocal: "no", upstream: 7 },
        { ...entry(2), keptLocal: undefined },
      ]),
    ).toEqual([
      { ...entry(2), keptLocal: true },
      { ...entry(1), keptLocal: true, upstream: null },
    ]);
  });

  it("sorts and caps an unsorted over-cap array", async () => {
    const { parseDeletedBranches } = await fresh();
    const many = Array.from({ length: 60 }, (_, i) => entry(i));
    const shuffled = [...many.slice(30), ...many.slice(0, 30)];
    const list = parseDeletedBranches(shuffled);
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe("id-59");
    expect(list.at(-1)?.id).toBe("id-10");
  });

  it("reads a relocate merge's unsorted, over-cap array sorted and capped", async () => {
    h.data.set(
      ID,
      Array.from({ length: 55 }, (_, i) => entry(54 - i)).reverse(),
    );
    const store = await fresh();
    const list = await store.loadDeletedBranches(ID);
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe("id-54");
    // The next write persists the sorted, capped list.
    await store.recordDeletedBranches(REPO, [entry(100)]);
    const stored = h.data.get(ID) as DeletedBranchEntry[];
    expect(stored).toHaveLength(50);
    expect(stored[0].id).toBe("id-100");
  });
});

describe("forgetDeletedBranch and loadDeletedBranches", () => {
  it("removes one entry by id", async () => {
    h.data.set(ID, [entry(3), entry(2), entry(1)]);
    const store = await fresh();
    await expect(store.forgetDeletedBranch(REPO, "id-2")).resolves.toBe(true);
    expect((h.data.get(ID) as DeletedBranchEntry[]).map((e) => e.id)).toEqual([
      "id-3",
      "id-1",
    ]);
  });

  it("keeps two entries for the same name", async () => {
    const store = await fresh();
    await store.recordDeletedBranches(REPO, [entry(1, { name: "feat/x" })]);
    await store.recordDeletedBranches(REPO, [entry(2, { name: "feat/x" })]);
    expect(await store.loadDeletedBranches(ID)).toHaveLength(2);
  });

  it("reads another instance's write from disk", async () => {
    const store = await fresh();
    expect(await store.loadDeletedBranches(ID)).toEqual([]);
    h.onReload = () => h.data.set(ID, [entry(9)]);
    expect(await store.loadDeletedBranches(ID)).toEqual([entry(9)]);
  });

  it("rejects the load when the store is unreadable", async () => {
    h.failReload = true;
    const store = await fresh();
    await expect(store.loadDeletedBranches(ID)).rejects.toThrow("unreadable");
    // A write over an unreadable store records nothing.
    await expect(store.recordDeletedBranches(REPO, [entry(1)])).resolves.toBe(
      false,
    );
  });
});
