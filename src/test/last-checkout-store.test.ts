import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withAppStoreLock } from "@/lib/app-store-lock";
import type { UserWorktree } from "@/lib/git/worktree";

// One in-memory map stands in for the store file AND its cache: a reload runs
// `onReload` once, which is how a test plays another instance writing between
// this one's loads. The lock is a real in-process mutex; rollback just runs.
// Each case re-imports the module, so its serialize chain and snapshot start
// empty.
const h = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  onReload: null as (() => void) | null,
  failSave: false,
  failLoad: false,
  failReload: false,
  // Reverses the map's order on each reload, as the Rust store's HashMap may.
  reverseOnReload: false,
  reloads: 0,
  loads: 0,
  entriesReads: 0,
  lockTail: Promise.resolve() as Promise<void>,
  // The next entries() read takes its value at call time, then waits on this.
  entriesGate: null as Promise<void> | null,
  identity: vi.fn<(repo: string) => Promise<string>>(),
  list: vi.fn<(repo: string) => Promise<UserWorktree[]>>(),
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
    keys: async () => [...h.data.keys()],
    entries: async () => {
      h.entriesReads++;
      const read = [...h.data.entries()].map(([k, v]) => [
        k,
        structuredClone(v),
      ]);
      const gate = h.entriesGate;
      h.entriesGate = null;
      if (gate) await gate;
      return read;
    },
  };
  return {
    memoizedStoreLoader: () => async () => {
      h.loads++;
      if (h.failLoad) throw new Error("unreadable");
      return store;
    },
    reloadToleratingEmptyStore: async () => {
      if (h.failReload) throw new Error("unreadable");
      h.reloads++;
      if (h.reverseOnReload) {
        const reversed = [...h.data.entries()].reverse();
        h.data.clear();
        for (const [k, v] of reversed) h.data.set(k, v);
      }
      const external = h.onReload;
      h.onReload = null;
      external?.();
    },
  };
});
vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: async (_file: string, fn: () => Promise<unknown>) => {
    const prev = h.lockTail;
    const gate: { release?: () => void } = {};
    h.lockTail = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      gate.release?.();
    }
  },
}));
vi.mock("@/lib/plugin-store-rollback", () => ({
  writeWithRollback: (_store: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/git/repo-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/repo-identity")>()),
  repoIdentityStrict: (repo: string) => h.identity(repo),
}));
vi.mock("@/lib/git/worktree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/worktree")>()),
  listUserWorktrees: (repo: string) => h.list(repo),
}));

const ID = "C:/repos/demo/.git";
const MAIN = "C:/repos/demo";
const WT = "C:/repos/demo-wt";
// validateRepo's Windows spelling of the worktree root.
const WT_LANDED = "C:\\repos\\demo-wt";

function wt(path: string, isMain = false): UserWorktree {
  return {
    path,
    branch: isMain ? "main" : "feat",
    head: "a".repeat(40),
    isMain,
    isDetached: false,
    isLocked: false,
    lockReason: "",
    lastActivityMs: null,
  };
}

const fresh = async () => {
  vi.resetModules();
  return import("@/lib/last-checkout/store");
};
type Store = Awaited<ReturnType<typeof fresh>>;

// The first import transforms the whole query layer; later re-imports reuse it.
beforeAll(async () => {
  await import("@/lib/last-checkout/store");
}, 60_000);

beforeEach(() => {
  h.data.clear();
  h.onReload = null;
  h.failSave = false;
  h.failLoad = false;
  h.failReload = false;
  h.reverseOnReload = false;
  h.reloads = 0;
  h.loads = 0;
  h.entriesReads = 0;
  h.lockTail = Promise.resolve();
  h.entriesGate = null;
  h.identity.mockReset();
  h.identity.mockResolvedValue(ID);
  h.list.mockReset();
  h.list.mockResolvedValue([wt(MAIN, true), wt(WT)]);
});

describe("recordLastCheckout", () => {
  it("round-trips a worktree landing under its identity", async () => {
    const store = await fresh();
    await store.recordLastCheckout(WT_LANDED);
    const written = h.data.get(ID) as { at: number };
    expect(written).toEqual({
      path: WT_LANDED,
      mainPath: MAIN,
      at: expect.any(Number),
    });
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, ...written },
    ]);
    const reloaded = await fresh();
    await reloaded.prewarmLastCheckout();
    expect(reloaded.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, ...written },
    ]);
  });

  it("records a main landing too", async () => {
    const store = await fresh();
    await store.recordLastCheckout(MAIN);
    expect(h.data.get(ID)).toMatchObject({ path: MAIN, mainPath: MAIN });
  });

  it("drops the write when the identity can't be resolved", async () => {
    h.identity.mockRejectedValue(new Error("ipc down"));
    const store = await fresh();
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.size).toBe(0);
    expect(store.getLastCheckoutSnapshot()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drops a landing its worktree list doesn't name", async () => {
    const store = await fresh();
    await store.recordLastCheckout("C:/appdata/sessions/agent-1");
    expect(h.data.size).toBe(0);
  });

  it("drops a landing whose list has no main entry", async () => {
    h.list.mockResolvedValue([wt(WT)]);
    const store = await fresh();
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.size).toBe(0);
  });

  it("keeps an existing record's mainPath when the list read fails", async () => {
    h.data.set(ID, { path: MAIN, mainPath: MAIN, at: 1 });
    h.list.mockRejectedValue(new Error("git failed"));
    const store = await fresh();
    await store.recordLastCheckout(WT_LANDED);
    const written = h.data.get(ID) as { at: number };
    expect(written).toMatchObject({ path: WT_LANDED, mainPath: MAIN });
    expect(written.at).toBeGreaterThan(1);
  });

  it("drops a failed-list landing with no record to update", async () => {
    h.list.mockRejectedValue(new Error("git failed"));
    const store = await fresh();
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.size).toBe(0);
  });

  it("looks for that record after the in-lock reload", async () => {
    h.list.mockRejectedValue(new Error("git failed"));
    const store = await fresh();
    await store.prewarmLastCheckout();
    // Another instance records this repo after this one's load.
    h.onReload = () => h.data.set(ID, { path: MAIN, mainPath: MAIN, at: 1 });
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.get(ID)).toMatchObject({ path: WT_LANDED, mainPath: MAIN });
  });

  it("rebuilds the snapshot from the store after a save", async () => {
    const store = await fresh();
    h.onReload = () =>
      h.data.set("C:/repos/other/.git", {
        path: "C:/repos/other",
        mainPath: "C:/repos/other",
        at: 5,
      });
    await store.recordLastCheckout(WT_LANDED);
    expect(
      store
        .getLastCheckoutSnapshot()
        .map((e) => e.identity)
        .sort(),
    ).toEqual(["C:/repos/demo/.git", "C:/repos/other/.git"]);
  });

  it("leaves the snapshot alone when the save fails", async () => {
    h.failSave = true;
    const store = await fresh();
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    await store.recordLastCheckout(WT_LANDED);
    expect(store.getLastCheckoutSnapshot()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    // The chain survives the failure.
    h.failSave = false;
    await store.recordLastCheckout(WT_LANDED);
    expect(store.getLastCheckoutSnapshot()).toHaveLength(1);
  });

  it("writes in landing order even when an earlier list read settles last", async () => {
    const gate: { release?: () => void } = {};
    h.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve([wt(MAIN, true), wt(WT)]);
        }),
    );
    const store = await fresh();
    const first = store.recordLastCheckout(WT_LANDED);
    const second = store.recordLastCheckout(MAIN);
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    gate.release?.();
    await Promise.all([first, second]);
    expect(h.data.get(ID)).toMatchObject({ path: MAIN });
  });

  it("hands React one snapshot reference between writes", async () => {
    const store = await fresh();
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    await store.recordLastCheckout(WT_LANDED);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getLastCheckoutSnapshot()).toBe(
      store.getLastCheckoutSnapshot(),
    );
  });
});

describe("prewarmLastCheckout", () => {
  it("skips malformed entries without blanking the rest", async () => {
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    h.data.set("bad-path", { path: 1, mainPath: MAIN, at: 7 });
    h.data.set("bad-at", { path: WT, mainPath: MAIN, at: "7" });
    h.data.set("not-an-object", "C:/repos/demo");
    h.data.set("null", null);
    const store = await fresh();
    await store.prewarmLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, path: WT, mainPath: MAIN, at: 7 },
    ]);
  });
});

describe("landing writes, readiness and re-reads", () => {
  it("skips a write when another instance recorded a newer landing", async () => {
    const store = await fresh();
    const newer = {
      path: "C:/repos/demo-newer",
      mainPath: MAIN,
      at: Date.now() + 60_000,
    };
    h.onReload = () => h.data.set(ID, newer);
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.get(ID)).toEqual(newer);
  });

  it("installs a new snapshot array on a write", async () => {
    const store = await fresh();
    const before = store.getLastCheckoutSnapshot();
    await store.recordLastCheckout(WT_LANDED);
    expect(store.getLastCheckoutSnapshot()).not.toBe(before);
  });

  it("queues a write behind a prewarm still reading", async () => {
    const gate: { release?: () => void } = {};
    h.entriesGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const store = await fresh();
    const warm = store.prewarmLastCheckout();
    const write = store.recordLastCheckout(WT_LANDED);
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.list).not.toHaveBeenCalled();
    gate.release?.();
    await Promise.all([warm, write]);
    expect(store.getLastCheckoutSnapshot().map((e) => e.path)).toEqual([
      WT_LANDED,
    ]);
  });

  it("settles readiness once a load fails, then loads afresh on the next ask", async () => {
    h.failLoad = true;
    const store = await fresh();
    const ready = store.lastCheckoutReady();
    expect(store.lastCheckoutReady()).toBe(ready);
    await expect(ready).resolves.toBeUndefined();
    expect(store.getLastCheckoutSnapshot()).toEqual([]);
    h.failLoad = false;
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const retry = store.lastCheckoutReady();
    expect(retry).not.toBe(ready);
    await retry;
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, path: WT, mainPath: MAIN, at: 7 },
    ]);
    // A successful load is kept: asking again loads nothing.
    const counts = [h.loads, h.entriesReads];
    await store.lastCheckoutReady();
    expect([h.loads, h.entriesReads]).toEqual(counts);
  });

  it("rebuilds the snapshot when a newer record skips the write", async () => {
    const store = await fresh();
    const newer = {
      path: "C:/repos/demo-newer",
      mainPath: MAIN,
      at: Date.now() + 60_000,
    };
    h.onReload = () => h.data.set(ID, newer);
    await store.recordLastCheckout(WT_LANDED);
    expect(h.data.get(ID)).toEqual(newer);
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, ...newer },
    ]);
  });

  it("overwrites a record stamped more than a day ahead of the clock", async () => {
    const store = await fresh();
    h.onReload = () =>
      h.data.set(ID, {
        path: "C:/repos/demo-future",
        mainPath: MAIN,
        at: Date.now() + 2 * 24 * 60 * 60 * 1000,
      });
    await store.recordLastCheckout(WT_LANDED);
    const written = h.data.get(ID) as { path: string; at: number };
    expect(written.path).toBe(WT_LANDED);
    expect(written.at).toBeLessThanOrEqual(Date.now());
  });

  it("re-reads only after a landing write already queued has landed", async () => {
    const gate: { release?: () => void } = {};
    h.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve([wt(MAIN, true), wt(WT)]);
        }),
    );
    const store = await fresh();
    const write = store.recordLastCheckout(WT_LANDED);
    let refreshed = false;
    const refresh = store.refreshLastCheckout().then(() => {
      refreshed = true;
    });
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshed).toBe(false);
    gate.release?.();
    await refresh;
    expect(store.getLastCheckoutSnapshot().map((e) => e.path)).toEqual([
      WT_LANDED,
    ]);
    await write;
  });

  it("picks up another instance's newer record on a re-read", async () => {
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const store = await fresh();
    await store.lastCheckoutReady();
    const newer = { path: "C:/repos/demo-newer", mainPath: MAIN, at: 9 };
    h.onReload = () => h.data.set(ID, newer);
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, ...newer },
    ]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("resolves through a failed re-read, keeping the snapshot, and recovers", async () => {
    const loaded = { identity: ID, path: WT, mainPath: MAIN, at: 7 };
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const store = await fresh();
    await store.lastCheckoutReady();
    expect(store.getLastCheckoutSnapshot()).toEqual([loaded]);
    h.failReload = true;
    await expect(store.refreshLastCheckout()).resolves.toBeUndefined();
    expect(store.getLastCheckoutSnapshot()).toEqual([loaded]);
    h.failReload = false;
    const newer = { path: "C:/repos/demo-newer", mainPath: MAIN, at: 9 };
    h.onReload = () => h.data.set(ID, newer);
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, ...newer },
    ]);
  });

  it("re-reads after a failed first load", async () => {
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    h.failLoad = true;
    const store = await fresh();
    await expect(store.refreshLastCheckout()).resolves.toBeUndefined();
    expect(store.getLastCheckoutSnapshot()).toEqual([]);
    h.failLoad = false;
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toEqual([
      { identity: ID, path: WT, mainPath: MAIN, at: 7 },
    ]);
  });

  it("keeps the snapshot reference and notifies nobody on an unchanged re-read", async () => {
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const store = await fresh();
    await store.lastCheckoutReady();
    const before = store.getLastCheckoutSnapshot();
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    // Control: a changed field installs a new snapshot and notifies.
    h.onReload = () => h.data.set(ID, { path: WT, mainPath: MAIN, at: 8 });
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps the snapshot through a re-read that answers in another order", async () => {
    h.data.set("C:/repos/zulu/.git", {
      path: "C:/repos/zulu-wt",
      mainPath: "C:/repos/zulu",
      at: 3,
    });
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const store = await fresh();
    await store.lastCheckoutReady();
    const before = store.getLastCheckoutSnapshot();
    expect(before.map((e) => e.identity)).toEqual([ID, "C:/repos/zulu/.git"]);
    const listener = vi.fn();
    store.subscribeLastCheckout(listener);
    h.reverseOnReload = true;
    await store.refreshLastCheckout();
    await store.refreshLastCheckout();
    expect(store.getLastCheckoutSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ["a refresh", (s: Store) => s.refreshLastCheckout()],
    ["a landing write", (s: Store) => s.recordLastCheckout(WT_LANDED)],
  ])(
    "settles readiness once %s loads after a failed startup load",
    async (_name, load) => {
      h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
      h.failLoad = true;
      const store = await fresh();
      await store.lastCheckoutReady();
      h.failLoad = false;
      await load(store);
      expect(store.getLastCheckoutSnapshot()).toHaveLength(1);
      // A later landing write blocks on its worktree list read.
      const gate: { release?: () => void } = {};
      h.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            gate.release = () => resolve([wt(MAIN, true), wt(WT)]);
          }),
      );
      const blocked = store.recordLastCheckout(MAIN);
      await vi.waitFor(() => expect(gate.release).toBeDefined());
      let ready = false;
      void store.lastCheckoutReady().then(() => {
        ready = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ready).toBe(true);
      gate.release?.();
      await blocked;
    },
  );

  it("re-reads only once a writer holding the store lock lets go", async () => {
    const store = await fresh();
    await store.lastCheckoutReady();
    const reloadsBefore = h.reloads;
    const gate: { release?: () => void } = {};
    const held = withAppStoreLock("last-checkout.json", async () => {
      // The migration's staged set, not yet saved.
      h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    });
    await vi.waitFor(() => expect(gate.release).toBeDefined());
    const refresh = store.refreshLastCheckout();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.reloads).toBe(reloadsBefore);
    gate.release?.();
    await Promise.all([held, refresh]);
    expect(h.reloads).toBe(reloadsBefore + 1);
    expect(store.getLastCheckoutSnapshot()).toHaveLength(1);
  });

  it("settles readiness with the loaded snapshot", async () => {
    h.data.set(ID, { path: WT, mainPath: MAIN, at: 7 });
    const store = await fresh();
    await store.lastCheckoutReady();
    expect(store.getLastCheckoutSnapshot()).toHaveLength(1);
  });
});
