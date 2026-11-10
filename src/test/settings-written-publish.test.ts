// subscribeSettingsWritten publishes only a snapshot whose forced save landed:
// a write that fails after staging publishes nothing, and neither does a later
// writer that saves nothing (the chain clears the staged snapshot per entry).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AppSettings,
  saveSettingsMerged,
  setBitbucketTokenExpiresAt,
  subscribeSettingsWritten,
} from "@/lib/settings/api";
import { DEFAULT_SETTINGS } from "@/lib/settings/heal";

// One in-memory settings.json behind the settings chain's seams: the lock and
// the rollback just run, and the next forced save can be made to fail.
const disk = vi.hoisted(() => ({
  settings: undefined as unknown,
  failNextSave: false,
}));
vi.mock("@/lib/plugin-store", () => {
  const store = {
    get: async () => structuredClone(disk.settings),
    set: async (_key: string, value: unknown) => {
      disk.settings = structuredClone(value);
    },
    save: async () => {
      if (!disk.failNextSave) return;
      disk.failNextSave = false;
      throw new Error("disk full");
    },
  };
  return {
    memoizedStoreLoader: () => async () => store,
    reloadToleratingEmptyStore: async () => undefined,
  };
});
vi.mock("@/lib/app-store-lock", () => ({
  withAppStoreLock: (_file: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/plugin-store-rollback", () => ({
  writeWithRollback: (_store: unknown, fn: () => Promise<unknown>) => fn(),
}));

const base = (): AppSettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  bitbucketTokenExpiresAt: null,
});

beforeEach(() => {
  disk.settings = base();
  disk.failNextSave = false;
});

describe("subscribeSettingsWritten", () => {
  it("publishes the snapshot a write landed", async () => {
    const heard: AppSettings[] = [];
    const stop = subscribeSettingsWritten((s) => heard.push(s));
    try {
      await saveSettingsMerged({ ...base(), editHistoryOrder: "oldest-first" });
    } finally {
      stop();
    }
    expect(heard.map((s) => s.editHistoryOrder)).toEqual(["oldest-first"]);
  });

  it("publishes nothing for a failed save or a later writer that saves nothing", async () => {
    const heard: AppSettings[] = [];
    const stop = subscribeSettingsWritten((s) => heard.push(s));
    try {
      disk.failNextSave = true;
      await expect(
        saveSettingsMerged({ ...base(), editHistoryOrder: "oldest-first" }),
      ).rejects.toThrow("disk full");
      // Unchanged expiry: this writer's no-op arm saves nothing.
      await setBitbucketTokenExpiresAt(null);
    } finally {
      stop();
    }
    expect(heard).toEqual([]);
  });
});

describe("saveSettingsMerged", () => {
  it("keeps the stored diffHideWhitespace over a snapshot's copy", async () => {
    const committed = await saveSettingsMerged({
      ...base(),
      diffHideWhitespace: true,
      editHistoryOrder: "oldest-first",
    });
    const stored = disk.settings as AppSettings;
    expect(stored.diffHideWhitespace).toBe(false);
    expect(stored.editHistoryOrder).toBe("oldest-first");
    expect(committed.diffHideWhitespace).toBe(false);
  });
});
