// Pins rollback before a chained writer settles: disk truth, snapshot fallback,
// original rejection identity, and the guarded save that disarms autosave.
// The runtime-import-free helper runs directly under Node >=24 type stripping.
// Source pins derive the writer roster from the lock ratchet and check returned
// rollback coverage per writing lock site, following same-file named helpers.
// Mutation controls cover behavior, a missing site wrap, and roster expansion.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { writeWithRollback } from "../src/lib/plugin-store-rollback.ts";
import { escapeRe, lineOf, maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

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

const source = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

function closing(masked, open) {
  const close = matchBrace(masked, open);
  assert.ok(close > open, `balanced source at line ${lineOf(masked, open)}`);
  return close;
}

function literalPaths(text) {
  const masked = maskNonCode(text, false);
  const literals = /(["'])[^"'\r\n]*\1/g;
  assert.equal(masked.replace(literals, "").replace(/[\s,]/g, ""), "");
  const paths = [...masked.matchAll(literals)].map((match) => {
    const path = text.slice(match.index + 1, match.index + match[0].length - 1);
    assert.match(path, /^src\/[\w./-]+\.tsx?$/);
    return path;
  });
  assert.ok(paths.length > 0, "the roster must not be empty");
  assert.equal(new Set(paths).size, paths.length, "unique roster entries");
  return paths;
}

function parseAdopters(text) {
  const masked = maskNonCode(text, false);
  const sets = [
    ...masked.matchAll(/\bconst\s+ADOPTED\s*=\s*new\s+Set\s*\(\s*\[/g),
  ];
  assert.equal(sets.length, 1, "one ADOPTED Set literal in the lock ratchet");
  const open = masked.indexOf("[", sets[0].index);
  const close = closing(masked, open);
  assert.match(masked.slice(close + 1), /^\s*\)\s*;/);
  const adopted = literalPaths(text.slice(open + 1, close));
  const migrators = [
    ...masked.matchAll(/\bconst\s+DYNAMIC_MIGRATOR\s*=\s*(["'])[^"']*\1\s*;/g),
  ];
  assert.equal(migrators.length, 1, "one DYNAMIC_MIGRATOR string literal");
  const declaration = text.slice(
    migrators[0].index,
    migrators[0].index + migrators[0][0].length,
  );
  const migrator = literalPaths(
    declaration.slice(declaration.indexOf("=") + 1, -1),
  );
  assert.equal(migrator.length, 1);
  assert.ok(!adopted.includes(migrator[0]), "separate migrator classification");
  return [...adopted, ...migrator];
}

// Like the lock ratchet, this follows direct calls to same-file named functions;
// aliases, computed members and cross-module helpers remain review-owned.
function namedFunctions(masked) {
  const functions = new Map();
  const patterns = [
    /\bfunction\s+([\w$]+)\s*(?:<[^{}]*>)?\s*\([^{}]*\)\s*(?::\s*[^{}=]*)?\{/g,
    /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^{}]*\)|[\w$]+)\s*=>\s*\{/g,
  ];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const open = match.index + match[0].lastIndexOf("{");
      const bodies = functions.get(match[1]) ?? [];
      bodies.push({ start: open + 1, end: closing(masked, open) });
      functions.set(match[1], bodies);
    }
  }
  return functions;
}

function arrowBody(masked, call) {
  const open = masked.indexOf("(", call);
  const end = closing(masked, open);
  const arrow = masked.indexOf("=>", open);
  assert.ok(
    arrow > open && arrow < end,
    "an inline arrow callback is required",
  );
  let start = arrow + 2;
  while (/\s/.test(masked[start])) start++;
  if (masked[start] === "{") {
    return { start: start + 1, end: closing(masked, start), expression: false };
  }
  return { start, end, expression: true };
}

function isReturned(masked, body, call) {
  const prefix = masked.slice(body.start, call);
  return (
    /\breturn\s+(?:await\s+)?$/.test(prefix) ||
    (body.expression && /^\s*(?:await\s+)?$/.test(prefix))
  );
}

function writingLockSites(text, file) {
  const masked = maskNonCode(text, file.endsWith(".tsx"));
  const functions = namedFunctions(masked);
  // The receiver shape the lock ratchet's STORE_METHOD_PATTERN counts (`as`
  // casts, parenthesized, `?.` and `!.`), copied: importing it would re-register
  // that file's tests.
  const writes =
    /(?<![\w$.])store(?:\s+as\s+[^;,)]+)?\s*\)*\s*(?:\?\.|!\.|\.)\s*(?:set|delete|clear|save|reset)\s*\(|\bfoldIdentityKey\s*(?:<[^;]*?>)?\s*\(/g;

  function inspect(body, protectedByCaller = false, seen = new Set()) {
    const code = masked.slice(body.start, body.end);
    const wrappers = [...code.matchAll(/\bwriteWithRollback\s*\(/g)]
      .map((match) => body.start + match.index)
      .filter((call) => isReturned(masked, body, call))
      .map((call) => arrowBody(masked, call));
    const covered = (at) =>
      protectedByCaller ||
      wrappers.some((wrapper) => at >= wrapper.start && at < wrapper.end);
    const found = [...code.matchAll(writes)].map((match) => ({
      at: body.start + match.index,
      covered: covered(body.start + match.index),
    }));
    for (const [name, bodies] of functions) {
      if (seen.has(name)) continue;
      const calls = new RegExp(`(?<![\\w$.])${escapeRe(name)}\\s*\\(`, "g");
      for (const match of code.matchAll(calls)) {
        const at = body.start + match.index;
        assert.equal(bodies.length, 1, `${file}: unambiguous helper ${name}`);
        const inherited = covered(at);
        const nested = inspect(bodies[0], inherited, new Set([...seen, name]));
        for (const write of nested) {
          found.push({
            at: write.at,
            covered:
              write.covered && (inherited || isReturned(masked, body, at)),
          });
        }
      }
    }
    return found;
  }

  let writingSites = 0;
  for (const match of masked.matchAll(/\bwithAppStoreLock\s*\(/g)) {
    const found = inspect(arrowBody(masked, match.index));
    if (found.length === 0) continue;
    writingSites++;
    for (const write of found) {
      assert.ok(
        write.covered,
        `${file}:${lineOf(masked, match.index)}: writing lock must return ` +
          `writeWithRollback (uncovered write at ${lineOf(masked, write.at)})`,
      );
    }
  }
  return writingSites;
}

function assertAdoption(text, file) {
  assert.match(
    text,
    /import\s*\{\s*writeWithRollback\s*\}\s*from\s*["']@\/lib\/plugin-store-rollback["']/,
    `${file} imports the shared helper`,
  );
  const sites = writingLockSites(text, file);
  assert.ok(
    sites > 0,
    `${file} has a writing lock that calls the shared helper`,
  );
  return sites;
}

function assertRosterAdoption(ratchet, readSource = source) {
  return parseAdopters(ratchet).reduce(
    (sites, file) => sites + assertAdoption(readSource(file), file),
    0,
  );
}

test("the ratchet's writer roster returns rollback at every writing lock site", () => {
  const ratchet = source("scripts/app-store-lock.test.mjs");
  assert.ok(parseAdopters(ratchet).length >= 18);
  assert.ok(assertRosterAdoption(ratchet) >= 37);
});

test("roster parsing includes the migrator and ignores commented entries", () => {
  const fixture = `
    const ADOPTED = new Set([
      // "src/lib/not-adopted.ts",
      "src/lib/writer.ts",
    ]);
    const DYNAMIC_MIGRATOR = "src/lib/migrator.ts";
  `;
  assert.deepEqual(parseAdopters(fixture), [
    "src/lib/writer.ts",
    "src/lib/migrator.ts",
  ]);
  for (const mutant of [
    fixture.replace('"src/lib/writer.ts",', "...otherWriters,"),
    fixture.replace('"src/lib/migrator.ts"', "migratorFile"),
    fixture.replace('"src/lib/writer.ts",', ""),
  ]) {
    assert.throws(() => parseAdopters(mutant), { name: "AssertionError" });
  }
});

test("mutation control: removing one history wrap fails its lock site", () => {
  const file = "src/lib/automations/history.ts";
  const text = source(file);
  assert.equal(assertAdoption(text, file), 4);
  const masked = maskNonCode(text, false);
  const call = masked.indexOf("writeWithRollback(");
  const body = arrowBody(masked, call);
  const start = masked.lastIndexOf("return", call);
  const end = closing(masked, masked.indexOf("(", call)) + 1;
  const mutant =
    text.slice(0, start) +
    text.slice(body.start, body.end) +
    text.slice(end).replace(/^;/, "");
  assert.throws(() => assertAdoption(mutant, file), /writing lock must return/);
});

test("mutation control: a new ratchet adopter must also adopt rollback", () => {
  const ratchet = source("scripts/app-store-lock.test.mjs").replace(
    "const ADOPTED = new Set([",
    'const ADOPTED = new Set(["src/lib/new-adopter.ts",',
  );
  assert.ok(parseAdopters(ratchet).includes("src/lib/new-adopter.ts"));
  assert.throws(
    () =>
      assertRosterAdoption(ratchet, (file) =>
        file === "src/lib/new-adopter.ts"
          ? 'withAppStoreLock("new.json", async () => { await store.save(); });'
          : source(file),
      ),
    /new-adopter.ts imports the shared helper/,
  );
});

test("read-only lock callbacks need no rollback wrapper", () => {
  const file = "src/lib/automations/history.ts";
  const text =
    source(file) +
    `
    withAppStoreLock("history.json", async () => {
      await store.reload();
      return store.get("history");
    });
  `;
  assert.equal(assertAdoption(text, file), 4);
});

test("mutation control: an extra unwrapped writer fails in an adopted file", () => {
  const file = "src/lib/automations/history.ts";
  const text =
    source(file) +
    `
    withAppStoreLock("history.json", async () => {
      await store.set("new", true);
      await store.save();
    });
  `;
  assert.throws(() => assertAdoption(text, file), /writing lock must return/);
});

test("mutation control: an unwrapped writer in any receiver form the ratchet counts fails", () => {
  const file = "src/lib/automations/history.ts";
  for (const write of [
    "store!.save()",
    'store?.set("new", true)',
    '(store as Store).set("new", true)',
    '(store).delete("new")',
  ]) {
    const text =
      source(file) +
      `
    withAppStoreLock("history.json", async () => {
      await ${write};
    });
  `;
    assert.throws(
      () => assertAdoption(text, file),
      /writing lock must return/,
      `${write} passed unwrapped`,
    );
  }
});

test("mutation control: an unreturned rollback call fails its lock site", () => {
  const file = "src/lib/automations/history.ts";
  const mutant = source(file).replace(
    "return writeWithRollback(",
    "writeWithRollback(",
  );
  assert.throws(() => assertAdoption(mutant, file), /writing lock must return/);
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
