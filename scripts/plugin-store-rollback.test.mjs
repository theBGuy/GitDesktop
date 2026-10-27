// Pins rollback before a chained writer settles: disk truth, snapshot fallback,
// original rejection identity, and the guarded save that disarms autosave.
// The runtime-import-free helper runs directly under Node >=24 type stripping.
// Mutation controls pin both the behavior and the 18-module adoption roster.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { writeWithRollback } from "../src/lib/plugin-store-rollback.ts";

const seed = () =>
  new Map([
    ["settings", { theme: "dark", nested: { enabled: true } }],
    ["counter", 4],
  ]);

class FakeStore {
  constructor(initial = seed()) {
    this.disk = structuredClone(initial);
    this.mem = structuredClone(initial);
    this.saveError = undefined;
    this.saveErrorOnce = false;
    this.reloadError = undefined;
    this.restoreError = undefined;
    this.restoreSetError = undefined;
    this.reloadCalls = 0;
    this.reloadOptions = [];
    this.saveCalls = 0;
    this.tailSaveCalls = 0;
    this.entriesCalls = 0;
    this.inWrite = false;
    this.restoring = false;
  }

  async entries() {
    this.entriesCalls++;
    return structuredClone([...this.mem]);
  }

  async get(key) {
    return this.mem.get(key);
  }

  async set(key, value) {
    if (this.restoring && key === "counter" && this.restoreSetError) {
      throw this.restoreSetError;
    }
    this.mem.set(key, value);
  }

  async clear() {
    if (this.restoreError) throw this.restoreError;
    this.restoring = true;
    this.mem.clear();
  }

  async save() {
    this.saveCalls++;
    if (!this.inWrite) this.tailSaveCalls++;
    if (this.saveError !== undefined) {
      const error = this.saveError;
      if (this.saveErrorOnce) this.saveError = undefined;
      throw error;
    }
    this.disk = structuredClone(this.mem);
  }

  async reload(options) {
    this.reloadCalls++;
    this.reloadOptions.push(options);
    if (this.reloadError) throw this.reloadError;
    const disk = structuredClone(this.disk);
    if (options?.ignoreDefaults === true) {
      this.mem = disk;
    } else {
      for (const [key, value] of disk) this.mem.set(key, value);
    }
  }
}

async function mutate(store) {
  const settings = await store.get("settings");
  if (settings) {
    settings.nested.enabled = false;
    await store.set("settings", { ...settings, theme: "light" });
  } else {
    await store.set("settings", { theme: "light" });
  }
  await store.set("added", { unsaved: true });
}

function execute(implementation, store, write) {
  return implementation(store, async () => {
    store.inWrite = true;
    try {
      return await write();
    } finally {
      store.inWrite = false;
    }
  });
}

async function assertRestored(store, expected) {
  assert.deepEqual(store.mem, expected);
  assert.deepEqual(store.disk, expected);
  assert.deepEqual(await store.get("settings"), expected.get("settings"));
  assert.equal(await store.get("added"), undefined);
  assert.equal(store.reloadCalls, 1);
  assert.deepEqual(store.reloadOptions, [{ ignoreDefaults: true }]);
  assert.equal(store.entriesCalls, 1);
}

const cases = [
  {
    name: "success preserves result and makes no helper reload or save",
    async run(implementation) {
      const store = new FakeStore();
      const result = { saved: true };
      const out = await execute(implementation, store, async () => {
        await mutate(store);
        await store.save();
        return result;
      });
      assert.equal(out, result);
      assert.deepEqual(store.mem, store.disk);
      assert.equal((await store.get("settings")).theme, "light");
      assert.deepEqual(await store.get("added"), { unsaved: true });
      assert.equal(store.reloadCalls, 0);
      assert.equal(store.saveCalls, 1);
      assert.equal(store.tailSaveCalls, 0);
      assert.equal(store.entriesCalls, 1);

      const noOp = new FakeStore();
      assert.equal(
        await execute(implementation, noOp, async () => result),
        result,
      );
      assert.equal(noOp.saveCalls, 0);
      assert.equal(noOp.reloadCalls, 0);
      assert.equal(noOp.entriesCalls, 1);
    },
  },
  {
    name: "save rejection restores disk and swallows a rejected tail save",
    async run(implementation) {
      const store = new FakeStore();
      const error = { message: "disk write failed" };
      store.saveError = error;
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          await store.save();
        }),
        (e) => e === error,
      );
      await assertRestored(store, seed());
      assert.equal(store.saveCalls, 2);
      assert.equal(store.tailSaveCalls, 1);
    },
  },
  {
    name: "partial callback rejection reloads disk and saves once to disarm autosave",
    async run(implementation) {
      const store = new FakeStore();
      const error = new Error("callback failed");
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          throw error;
        }),
        (e) => e === error,
      );
      await assertRestored(store, seed());
      assert.equal(store.saveCalls, 1);
      assert.equal(store.tailSaveCalls, 1);
    },
  },
  {
    name: "failed reload restores the deep snapshot and writes it in the tail save",
    async run(implementation) {
      const store = new FakeStore();
      const error = new Error("save failed once");
      store.saveError = error;
      store.saveErrorOnce = true;
      store.reloadError = new Error("unreadable disk");
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          store.disk.clear();
          await store.save();
        }),
        (e) => e === error,
      );
      await assertRestored(store, seed());
      assert.equal(store.saveCalls, 2);
      assert.equal(store.tailSaveCalls, 1);
    },
  },
  {
    name: "failed reload and clear preserve the original rejection without a tail save",
    async run(implementation) {
      const store = new FakeStore();
      const error = new Error("save failed");
      store.saveError = error;
      store.saveErrorOnce = true;
      store.reloadError = new Error("reload failed");
      store.restoreError = new Error("clear failed");
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          await store.save();
        }),
        (e) => e === error,
      );
      assert.deepEqual(store.disk, seed());
      assert.equal(store.reloadCalls, 1);
      assert.equal(store.saveCalls, 1);
      assert.equal(store.tailSaveCalls, 0);
    },
  },
  {
    name: "first-ever save failure restores an empty snapshot when the file is missing",
    async run(implementation) {
      const store = new FakeStore(new Map());
      const error = new Error("first save failed");
      store.saveError = error;
      store.reloadError = new Error(
        "The system cannot find the file (os error 2)",
      );
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          await store.save();
        }),
        (e) => e === error,
      );
      await assertRestored(store, new Map());
      assert.equal(store.saveCalls, 2);
      assert.equal(store.tailSaveCalls, 1);
    },
  },
  {
    name: "non-Error rejections pass through unchanged",
    async run(implementation) {
      const store = new FakeStore();
      const error = "plain rejection";
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          throw error;
        }),
        (e) => e === error,
      );
      await assertRestored(store, seed());
      assert.equal(store.saveCalls, 1);
      assert.equal(store.tailSaveCalls, 1);
    },
  },
  {
    name: "a partial snapshot restore must not save the incomplete store",
    async run(implementation) {
      const store = new FakeStore();
      const error = new Error("callback failed before save");
      store.reloadError = new Error("reload failed");
      store.restoreSetError = new Error("restore set failed");
      await assert.rejects(
        execute(implementation, store, async () => {
          await mutate(store);
          throw error;
        }),
        (e) => e === error,
      );
      assert.deepEqual(store.disk, seed());
      assert.deepEqual([...store.mem.keys()], ["settings"]);
      assert.equal(store.reloadCalls, 1);
      assert.equal(store.saveCalls, 0);
      assert.equal(store.tailSaveCalls, 0);
    },
  },
];

for (const scenario of cases) {
  test(scenario.name, () => scenario.run(writeWithRollback));
}

const withoutRollback = async (_store, write) => {
  const out = await write();
  return out;
};
for (const scenario of cases.slice(1, 4)) {
  test(`mutation control: no rollback fails ${scenario.name}`, async () => {
    await assert.rejects(scenario.run(withoutRollback), {
      name: "AssertionError",
    });
  });
}

const withBareReload = async (store, write) => {
  const snapshot = await store.entries();
  try {
    return await write();
  } catch (error) {
    let restored = false;
    try {
      await store.reload();
      restored = true;
    } catch {
      try {
        await store.clear();
        for (const [key, value] of snapshot) await store.set(key, value);
        restored = true;
      } catch {
        // Unrestored memory must not reach the tail save.
      }
    }
    if (restored) {
      try {
        await store.save();
      } catch {
        // The original rejection must survive a failed tail save.
      }
    }
    throw error;
  }
};
for (const scenario of [cases[1], cases[2], cases[6]]) {
  test(`mutation control: bare reload fails ${scenario.name}`, async () => {
    await assert.rejects(scenario.run(withBareReload), {
      name: "AssertionError",
    });
  });
}

const ADOPTERS = [
  "src/features/sessions/agentNumber.ts",
  "src/lib/ai/own-digest-store.ts",
  "src/lib/automations/dismissals.ts",
  "src/lib/automations/history.ts",
  "src/lib/automations/results.ts",
  "src/lib/automations/store.ts",
  "src/lib/branch-rules/store.ts",
  "src/lib/conversation-filters/store.ts",
  "src/lib/issues/local.ts",
  "src/lib/jira/store.ts",
  "src/lib/notifications/overrides.ts",
  "src/lib/pulls/local.ts",
  "src/lib/pulls/review-drafts.ts",
  "src/lib/pulls/reviews-history.ts",
  "src/lib/repo-data-migration.ts",
  "src/lib/repo-lens/store.ts",
  "src/lib/scripts/store.ts",
  "src/lib/settings/api.ts",
];

const source = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

function assertAdoption(text, file) {
  assert.match(
    text,
    /import\s*\{\s*writeWithRollback\s*\}\s*from\s*["']@\/lib\/plugin-store-rollback["']/,
    `${file} imports the shared helper`,
  );
  assert.match(
    text,
    /\bwriteWithRollback\s*\(/,
    `${file} calls the shared helper`,
  );
}

test("all 18 chained-writer modules adopt the helper", () => {
  assert.equal(ADOPTERS.length, 18);
  for (const file of ADOPTERS) assertAdoption(source(file), file);
});

test("settings keeps reload, rollback, callback, and forced save in order", () => {
  const text = source("src/lib/settings/api.ts");
  const body = text.slice(
    text.indexOf("function serializedRecentRepoWrite"),
    text.indexOf("const run = recentRepoWrites.then"),
  );
  let previous = -1;
  for (const token of [
    "reloadToleratingEmptyStore(",
    "writeWithRollback(",
    "fn(",
    "store.save(",
  ]) {
    const position = body.indexOf(token);
    assert.ok(position > previous, `${token} follows the preceding operation`);
    previous = position;
  }
});

test("mutation control: an imported helper without a call fails adoption", () => {
  assert.throws(
    () =>
      assertAdoption(
        'import { writeWithRollback } from "@/lib/plugin-store-rollback";',
        "missing-call fixture",
      ),
    { name: "AssertionError" },
  );
});
