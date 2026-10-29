// Pins rollback before a chained writer settles: disk truth, snapshot fallback,
// original rejection identity, and the guarded save that disarms autosave.
// The runtime-import-free helper runs directly under Node >=24 type stripping.
// Source pins derive the writer roster from the lock ratchet and check returned
// rollback coverage per writing lock site, following same-file named helpers.
// Mutation controls cover behavior, a missing site wrap, and roster expansion.
// Autosave pins: the plugin-store allowlist matches the ratchet's exempt stores,
// and every opener (derived from src's plugin imports) takes storeLoadOptions;
// their controls mutate sources in memory or run synthetic opener fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { writeWithRollback } from "../src/lib/plugin-store-rollback.ts";
import {
  escapeRe,
  lineOf,
  maskNonCode,
  matchBrace,
  sourceFiles,
} from "./lib/ts-mask.mjs";

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

// Autosave pins: a debounce armed by a failed write would persist outside the
// store's lock, so only the lock ratchet's exempt (set-without-save) stores keep it.
const PLUGIN_STORE = "src/lib/plugin-store.ts";
// Exempt from the JS lock (its other writers are Rust), yet its one JS writer
// force-saves, so it keeps autosave off like the adopters.
const FORCE_SAVING_EXEMPT = new Set(["src/lib/review-notes/store.ts"]);

function stringLiterals(text, masked, from, to) {
  return [...masked.slice(from, to).matchAll(/(["'])[^"'\r\n]*\1/g)].map(
    (match) => ({
      at: from + match.index,
      value: text.slice(
        from + match.index + 1,
        from + match.index + match[0].length - 1,
      ),
    }),
  );
}

function onlyLiterals(masked, from, to, extra = "") {
  const rest = masked
    .slice(from, to)
    .replace(/(["'])[^"'\r\n]*\1/g, "")
    .replace(new RegExp(`[\\s,${extra}]`, "g"), "");
  assert.equal(rest, "", "a literal-only list");
}

function parseAutosaveStores(text) {
  const masked = maskNonCode(text, false);
  const sets = [
    ...masked.matchAll(
      /\bconst\s+AUTOSAVE_STORES\s*(?::[^=]*)?=\s*new\s+Set\s*\(\s*\[/g,
    ),
  ];
  assert.equal(sets.length, 1, "one AUTOSAVE_STORES Set literal");
  const open = masked.indexOf("[", sets[0].index + sets[0][0].length - 1);
  const close = closing(masked, open);
  onlyLiterals(masked, open + 1, close);
  const files = stringLiterals(text, masked, open + 1, close).map(
    (literal) => literal.value,
  );
  assert.ok(files.length > 0, "the allowlist must not be empty");
  assert.equal(new Set(files).size, files.length, "unique allowlist entries");
  return files;
}

function parseExemptModules(ratchet) {
  const masked = maskNonCode(ratchet, false);
  const maps = [
    ...masked.matchAll(/\bconst\s+EXEMPT\s*=\s*new\s+Map\s*\(\s*\[/g),
  ];
  assert.equal(maps.length, 1, "one EXEMPT Map literal in the lock ratchet");
  const open = masked.indexOf("[", maps[0].index + maps[0][0].length - 1);
  const close = closing(masked, open);
  onlyLiterals(masked, open + 1, close, "\\[\\]");
  const modules = [];
  for (let i = open + 1; i < close; i++) {
    if (masked[i] !== "[") continue;
    const end = closing(masked, i);
    const entry = stringLiterals(ratchet, masked, i + 1, end);
    assert.equal(entry.length, 2, "each EXEMPT entry is [module, reason]");
    assert.match(entry[0].value, /^src\/[\w./-]+\.tsx?$/);
    modules.push(entry[0].value);
    i = end;
  }
  assert.ok(modules.length > 0, "the exemption map must not be empty");
  return modules;
}

// The module's store file, read from its loader call's literal or the one
// same-file `const` literal it names; zero or several openers, or an
// unresolvable name, fail closed rather than guessing which file it owns.
function storeFileOf(text, file) {
  const masked = maskNonCode(text, file.endsWith(".tsx"));
  const openers = [
    ...masked.matchAll(
      /(?<![\w$.])(?:memoizedStoreLoader\s*\(|load\s*\(\s*storeName\s*\()\s*(?:(["'])[^"'\r\n]*\1|([A-Za-z_$][\w$]*))\s*\)/g,
    ),
  ];
  assert.equal(
    openers.length,
    1,
    `${file}: exactly one literal store opener (found ${openers.length})`,
  );
  const [opener] = openers;
  let from = opener.index;
  let to = opener.index + opener[0].length;
  if (opener[2] !== undefined) {
    const declarations = [
      ...masked.matchAll(
        new RegExp(
          `\\bconst\\s+${escapeRe(opener[2])}\\s*=\\s*(["'])[^"'\\r\\n]*\\1\\s*;`,
          "g",
        ),
      ),
    ];
    assert.equal(
      declarations.length,
      1,
      `${file}: exactly one literal store opener (${opener[2]} resolves to ${declarations.length} const literals)`,
    );
    from = declarations[0].index;
    to = from + declarations[0][0].length;
  }
  const literal = stringLiterals(text, masked, from, to);
  assert.equal(literal.length, 1);
  assert.match(
    literal[0].value,
    /^[\w.-]+\.json$/,
    `${file}: a bare file name`,
  );
  return literal[0].value;
}

function assertAutosaveAllowlist(
  ratchet = source("scripts/app-store-lock.test.mjs"),
  readSource = source,
) {
  const expected = parseExemptModules(ratchet)
    .filter((module) => !FORCE_SAVING_EXEMPT.has(module))
    .map((module) => storeFileOf(readSource(module), module))
    .sort();
  const actual = parseAutosaveStores(readSource(PLUGIN_STORE)).sort();
  assert.deepEqual(
    actual,
    expected,
    "AUTOSAVE_STORES drifted from the lock ratchet's set-without-save stores",
  );
}

function topLevelArgs(masked, open) {
  const close = closing(masked, open);
  const args = [];
  let start = open + 1;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    if ("([{".includes(masked[i])) depth++;
    else if (")]}".includes(masked[i])) depth--;
    else if (masked[i] === "," && depth === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  args.push({ start, end: close });
  return args.filter((arg) => masked.slice(arg.start, arg.end).trim() !== "");
}

// The plugin's option-bearing openers, keyed by export. A value Store import
// may only open (Store.load); fetching an open store goes through getStore,
// which takes no options, and types come in through `type`.
const OPENER_EXPORTS = new Set(["load", "Store", "LazyStore"]);
// Not a member name: a `.` is member access unless it ends a spread's `...`.
const NOT_MEMBER = String.raw`(?<![\w$])(?<!(?<!\.)\.\s*)`;
const OPENING_SITES = [
  ["load", "load", new RegExp(`${NOT_MEMBER}load\\s*\\(`, "g")],
  [
    "Store",
    "Store.load",
    new RegExp(`${NOT_MEMBER}Store\\s*\\.\\s*load\\s*\\(`, "g"),
  ],
  [
    "LazyStore",
    "new LazyStore",
    new RegExp(`${NOT_MEMBER}new\\s+LazyStore\\s*\\(`, "g"),
  ],
];
const BACKSLASH = "\\";
const PLAIN_ARG = /^(?:"[^"\\]*"|'[^'\\]*'|[A-Za-z_$][\w$]*)$/;

// Every module specifier in masked code (`from "x"`, a side-effect
// `import "x"`, and `import("x")` in value or type position), with its raw text.
function moduleSpecifiers(text, masked) {
  const specs = [];
  const specifier = new RegExp(
    `${NOT_MEMBER}(?<!#)(from|import)\\s*(\\(\\s*)?(["'\`])`,
    "g",
  );
  for (const m of masked.matchAll(specifier)) {
    if (m[1] === "from" && m[2]) continue;
    const open = m.index + m[0].length - 1;
    const close = masked.indexOf(m[3], open + 1);
    assert.ok(close > open, `unterminated module specifier at ${open}`);
    specs.push({
      keyword: m[1],
      index: m.index,
      at: open,
      end: close + 1,
      raw: text.slice(open + 1, close),
    });
  }
  return specs;
}

// Lines of each `import(` whose argument isn't one plain string literal or
// `${}`-free template; a method named `import` is refused too (telling it from
// a call needs a parser: rename it). Member calls and `#import` aren't imports;
// an escaped literal passes here for moduleSpecifiers' backslash refusal.
const COMPUTED_IMPORT =
  "a computed dynamic import, or a method named import (rename it), is unsupported";
function computedDynamicImports(masked) {
  const lines = [];
  for (const m of masked.matchAll(
    new RegExp(`${NOT_MEMBER}(?<!#)import\\s*\\(`, "g"),
  )) {
    const [first] = topLevelArgs(masked, m.index + m[0].length - 1);
    const arg = first ? masked.slice(first.start, first.end).trim() : "";
    if (!/^(["'`])\s*\1$/.test(arg)) lines.push(lineOf(masked, m.index));
  }
  return lines;
}

// storeName and storeLoadOptions are the canonical helpers: a plain named
// import from their defining module, or that module's single declaration of
// it; every other reference is a call, so no local binding can stand in.
const HELPERS = [
  ["storeName", "@/lib/test-mode", "src/lib/test-mode.ts"],
  ["storeLoadOptions", "@/lib/plugin-store", PLUGIN_STORE],
];
function assertCanonicalHelpers(text, masked, file) {
  const specs = moduleSpecifiers(text, masked);
  for (const [name, module, home] of HELPERS) {
    const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`);
    const spans = [];
    for (const spec of specs) {
      if (spec.keyword !== "from") continue;
      const stmt = [
        ...masked.slice(0, spec.index).matchAll(/\b(import|export)\b/g),
      ].pop();
      if (!stmt) continue;
      const clause = masked.slice(stmt.index + stmt[0].length, spec.index);
      if (!word.test(clause)) continue;
      const plain =
        stmt[1] === "import" &&
        !/^\s*type\b/.test(clause) &&
        new RegExp(`[{,]\\s*${name}\\s*[,}]`).test(clause);
      assert.ok(
        plain && spec.raw === module,
        `${file}:${lineOf(masked, stmt.index)}: ${name} must be a plain named import from ${module}`,
      );
      spans.push([stmt.index, spec.end]);
    }
    const decls =
      file === home
        ? [...masked.matchAll(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, "g"))]
        : [];
    assert.equal(
      spans.length + decls.length,
      1,
      `${file}: ${name} must come from ${module} exactly once`,
    );
    const declared = new Set(decls.map((d) => d.index + d[0].indexOf(name)));
    const call = /\s*\(/y;
    const ref = new RegExp(`${NOT_MEMBER}${name}(?![\\w$])`, "g");
    for (const m of masked.matchAll(ref)) {
      const at = m.index;
      if (declared.has(at)) continue;
      if (spans.some(([from, to]) => at >= from && at < to)) continue;
      call.lastIndex = at + name.length;
      // Comments are already blank, so any gap before the name is whitespace.
      const before = masked.slice(0, at).trimEnd();
      if (
        call.test(masked) &&
        !/\b(?:function\s*\*?|class|const|let|var)$/.test(before)
      )
        continue;
      assert.fail(
        `${file}:${lineOf(masked, at)}: ${name} is bound or referenced other than as a call to the canonical helper`,
      );
    }
  }
}

// Each imported opener name, outside its import statement and not after a
// `.`, must start an opening site of its own kind. Anything else fails closed:
// a binding alias or callback could open a store the site check never sees,
// and Store.get or a type annotation has getStore or `type` instead.
function assertOnlyOpeningReferences(masked, file, imports) {
  for (const [name, , pattern] of OPENING_SITES) {
    if (!imports.names.has(name)) continue;
    const sites = new Set(
      [...masked.matchAll(pattern)].map(
        (site) => site.index + site[0].indexOf(name),
      ),
    );
    const ref = new RegExp(`${NOT_MEMBER}${name}(?![\\w$])`, "g");
    for (const match of masked.matchAll(ref)) {
      if (sites.has(match.index)) continue;
      const at = match.index;
      if (imports.spans.some(([from, to]) => at >= from && at < to)) continue;
      assert.fail(
        `${file}:${lineOf(masked, match.index)}: ${name} is referenced other than to open a store (fetch an open store with getStore; import types with \`type\`)`,
      );
    }
  }
}

// Every opening site of an imported opener opens `storeName(X)` with
// `storeLoadOptions(X)` over the same bare name, so options key on the
// pre-cold-start name.
function assertLoadsTakeStoreOptions(text, file) {
  const masked = maskNonCode(text, file.endsWith(".tsx"));
  const imports = pluginStoreImports(text, file);
  const escaped = masked.indexOf(BACKSLASH);
  if (escaped !== -1)
    assert.fail(
      `${file}:${lineOf(masked, escaped)}: escaped identifier is unsupported`,
    );
  assertOnlyOpeningReferences(masked, file, imports);
  assertCanonicalHelpers(text, masked, file);
  const calls = OPENING_SITES.filter(([name]) => imports.names.has(name))
    .flatMap(([, kind, pattern]) =>
      [...masked.matchAll(pattern)].map((call) => ({ kind, call })),
    )
    .sort((a, b) => a.call.index - b.call.index);
  assert.ok(
    calls.length > 0,
    `${file}: imports a store opener but opens nothing`,
  );
  for (const { kind, call } of calls) {
    const open = call.index + call[0].length - 1;
    const args = topLevelArgs(masked, open);
    const at = `${file}:${lineOf(masked, call.index)}`;
    assert.equal(args.length, 2, `${at}: ${kind} takes (name, options)`);
    const [name, options] = args.map((arg) =>
      text.slice(arg.start, arg.end).trim(),
    );
    const nameArg = /^storeName\(([^()]*)\)$/.exec(name);
    const optionsArg = /^storeLoadOptions\(([^()]*)\)$/.exec(options);
    assert.ok(nameArg, `${at}: ${kind} opens a storeName(...) path`);
    assert.ok(optionsArg, `${at}: ${kind} options come from storeLoadOptions`);
    for (const arg of [nameArg[1].trim(), optionsArg[1].trim()])
      assert.ok(
        PLAIN_ARG.test(arg),
        `${at}: the store file argument must be a string literal or a bare identifier`,
      );
    assert.equal(
      optionsArg[1].trim(),
      nameArg[1].trim(),
      `${at}: options key on the same bare file name`,
    );
  }
  return calls.length;
}

const PLUGIN_PACKAGE = "@tauri-apps/plugin-store";

// A drift guard for ordinary code, not a sandbox: it refuses the import,
// specifier, identifier and argument spellings it can't read, never guessing.
// Out of its reach by design: eval, casts to `typeof Store` or through
// `.constructor`, writes to a store's options, raw plugin IPC (invoking the
// plugin's command), and the mask's regex-versus-division ambiguity.
// Classified on masked code, so a comment or string can't pose as an import.
function pluginStoreImports(text, file) {
  const masked = maskNonCode(text, file.endsWith(".tsx"));
  const names = new Set();
  const spans = [];
  const failures = [];
  const specifier = new RegExp(`(["'\`])${escapeRe(PLUGIN_PACKAGE)}\\1`, "g");
  for (const match of text.matchAll(specifier)) {
    if (masked[match.index] !== match[1]) continue;
    const at = `${file}:${lineOf(masked, match.index)}`;
    const before = masked.slice(0, match.index);
    if (/\bimport\s*\(\s*$/.test(before)) {
      failures.push(`${at}: dynamic import of a store loader is unsupported`);
      continue;
    }
    if (/\bimport\s*$/.test(before)) continue;
    const from = /\bfrom\s*$/.exec(before);
    const keyword = from
      ? [...before.slice(0, from.index).matchAll(/\b(import|export)\b/g)].pop()
      : undefined;
    if (!keyword) {
      failures.push(`${at}: unrecognized reference to ${PLUGIN_PACKAGE}`);
      continue;
    }
    const clause = before
      .slice(keyword.index + keyword[0].length, from.index)
      .trim();
    spans.push([keyword.index, match.index + match[0].length]);
    if (/^type\b/.test(clause)) continue;
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
    const items = (named ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && !/^type\b/.test(item));
    if (keyword[1] === "export") {
      if (named === undefined || items.length > 0)
        failures.push(`${at}: re-export of a store loader is unsupported`);
      continue;
    }
    const head = clause
      .replace(/\{[\s\S]*\}/, "")
      .replace(/,/g, " ")
      .trim();
    if (/^\*\s*as\b/.test(head)) {
      failures.push(`${at}: namespace import of a store loader is unsupported`);
      continue;
    }
    if (head)
      failures.push(`${at}: default import of a store loader is unsupported`);
    for (const item of items) {
      const [imported, local = imported] = item.split(/\s+as\s+/);
      if (!/^[A-Za-z_$][\w$]*$/.test(imported)) {
        failures.push(
          `${at}: import item that is not a plain identifier is unsupported`,
        );
        continue;
      }
      if (!OPENER_EXPORTS.has(imported)) continue;
      if (local.trim() !== imported)
        failures.push(`${at}: aliased import of ${imported} is unsupported`);
      else names.add(imported);
    }
  }
  return { names, spans, failures };
}

// Specifiers are read in every file: an escape or a path into the package
// would hide the package name from a text prefilter. Imports from
// @/lib/plugin-store don't count: memoizedStoreLoader passes storeLoadOptions.
function derivePluginStoreOpeners(files) {
  const openers = new Map();
  const failures = [];
  for (const [file, text] of files) {
    const masked = maskNonCode(text, file.endsWith(".tsx"));
    for (const line of computedDynamicImports(masked))
      failures.push(`${file}:${line}: ${COMPUTED_IMPORT}`);
    for (const spec of moduleSpecifiers(text, masked)) {
      const at = `${file}:${lineOf(masked, spec.at)}`;
      if (spec.raw.includes(BACKSLASH))
        failures.push(`${at}: escaped module specifier is unsupported`);
      else if (
        !spec.raw.startsWith(".") &&
        /\/\/|\/\.{1,2}(?:\/|$)|\/$/.test(spec.raw)
      )
        failures.push(`${at}: an unnormalized specifier is unsupported`);
      else if (spec.raw.includes("node_modules"))
        failures.push(`${at}: a node_modules specifier is unsupported`);
      else if (spec.raw.includes(PLUGIN_PACKAGE) && spec.raw !== PLUGIN_PACKAGE)
        failures.push(`${at}: a plugin-store subpath specifier is unsupported`);
    }
    if (!text.includes(PLUGIN_PACKAGE)) continue;
    const imports = pluginStoreImports(text, file);
    failures.push(...imports.failures);
    if (imports.names.size > 0) openers.set(file, text);
  }
  if (failures.length > 0)
    assert.fail(`unreadable plugin-store imports: ${failures.join("; ")}`);
  return openers;
}

// A floor, not the roster: a scanner that stops recognizing one fails here.
const OPENERS = [
  PLUGIN_STORE,
  "src/lib/repo-data-migration.ts",
  "src/lib/analytics/posthog.ts",
];

function assertPluginStoreOpeners(files) {
  const openers = derivePluginStoreOpeners(files);
  for (const file of OPENERS)
    assert.ok(openers.has(file), `OPENERS floor: ${file} is not derived`);
  for (const [file, text] of openers)
    assert.ok(assertLoadsTakeStoreOptions(text, file) >= 1);
  return [...openers.keys()];
}

// `autoSave` is spelled only in plugin-store.ts: as code, or as a quoted key
// (a string keeps its quotes in the mask, a comment does not).
function autoSaveHits(files) {
  const hits = [];
  for (const [file, text] of files) {
    if (file === PLUGIN_STORE || !/autoSave/.test(text)) continue;
    const masked = maskNonCode(text, file.endsWith(".tsx"));
    for (const match of masked.matchAll(/\bautoSave\b/g)) {
      hits.push(`${file}:${lineOf(masked, match.index)}`);
    }
    for (const match of text.matchAll(/(["'`])autoSave\1/g)) {
      if (masked[match.index] === match[1]) {
        hits.push(`${file}:${lineOf(masked, match.index)}`);
      }
    }
  }
  return hits;
}

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
function* srcFiles() {
  for (const full of sourceFiles(SRC_ROOT)) {
    const file = `src/${relative(SRC_ROOT, full).replace(/\\/g, "/")}`;
    yield [file, source(file)];
  }
}

test("the autosave allowlist is exactly the lock ratchet's set-without-save stores", () => {
  assertAutosaveAllowlist();
  assert.deepEqual(parseAutosaveStores(source(PLUGIN_STORE)).sort(), [
    "analytics.json",
    "notifications.json",
    "plans.json",
    "research.json",
  ]);
});

test("every plugin store opener passes storeLoadOptions over the bare file name", () => {
  const files = [...srcFiles()];
  assert.ok(files.length > 100, "the src scan read the tree");
  assertPluginStoreOpeners(files);
});

const OPENER_FIXTURE = "src/fixture.ts";
const IMPORT_LOAD = `import { load } from "${PLUGIN_PACKAGE}";\n`;
// Appended so every fixture's own line numbers stay as written.
const HELPER_IMPORTS =
  '\nimport { storeLoadOptions } from "@/lib/plugin-store";\n' +
  'import { storeName } from "@/lib/test-mode";\n';
function checkOpenerFixture(text, name = OPENER_FIXTURE) {
  const fixture = `${text}${HELPER_IMPORTS}`;
  const openers = derivePluginStoreOpeners([[name, fixture]]);
  for (const [file, body] of openers) assertLoadsTakeStoreOptions(body, file);
  return [...openers.keys()];
}

test("mutation control: opener sites with the wrong options or arity fail", () => {
  for (const [fixture, message] of [
    [
      `${IMPORT_LOAD}load(storeName("x.json"), { defaults: {} });`,
      /:2: load options come from storeLoadOptions/,
    ],
    [
      `${IMPORT_LOAD}load(storeName("x.json"));`,
      /:2: load takes \(name, options\)/,
    ],
    [
      `import { Store } from "${PLUGIN_PACKAGE}";\nStore.load(storeName("x.json"), {});`,
      /:2: Store\.load options come from storeLoadOptions/,
    ],
    [
      `import { LazyStore } from "${PLUGIN_PACKAGE}";\nnew LazyStore(storeName("x.json"));`,
      /:2: new LazyStore takes \(name, options\)/,
    ],
    [
      `${IMPORT_LOAD}export {};`,
      /fixture\.ts: imports a store opener but opens nothing/,
    ],
  ]) {
    assert.throws(() => checkOpenerFixture(fixture), message);
  }
});

test("mutation control: an imported opener referenced other than to open fails", () => {
  const referenced = (name, line) =>
    new RegExp(
      `fixture\\.ts:${line}: ${name} is referenced other than to open a store`,
    );
  for (const [fixture, message] of [
    [
      `${IMPORT_LOAD}load(storeName(f), storeLoadOptions(f));\nconst open = load;\nopen(storeName(g), storeLoadOptions(g));`,
      referenced("load", 3),
    ],
    [
      `${IMPORT_LOAD}load(storeName(f), storeLoadOptions(f));\n[a].map(load);`,
      referenced("load", 3),
    ],
    [
      `import { Store } from "${PLUGIN_PACKAGE}";\nconst s = await Store.get("x.json");`,
      referenced("Store", 2),
    ],
    [
      `import { Store } from "${PLUGIN_PACKAGE}";\nlet s: Store;\ns = await Store.load(storeName(f), storeLoadOptions(f));`,
      referenced("Store", 2),
    ],
  ]) {
    assert.throws(() => checkOpenerFixture(fixture), message);
  }
});

test("site checks apply only to the opener kinds a file imports", () => {
  assert.deepEqual(
    checkOpenerFixture(
      `import { LazyStore } from "${PLUGIN_PACKAGE}";\n` +
        "new LazyStore(storeName(f), storeLoadOptions(f));\n" +
        "function load(x) {}\nload(1);",
    ),
    [OPENER_FIXTURE],
  );
});

test("mutation control: unreadable plugin-store imports fail closed", () => {
  for (const [fixture, message] of [
    [
      `import { load as openStore } from "${PLUGIN_PACKAGE}";`,
      /aliased import of load is unsupported/,
    ],
    [
      `import * as ps from "${PLUGIN_PACKAGE}";\nps.load(storeName("x.json"), {});`,
      /namespace import of a store loader is unsupported/,
    ],
    [
      `import ps from "${PLUGIN_PACKAGE}";`,
      /default import of a store loader is unsupported/,
    ],
    [
      `const m = await import("${PLUGIN_PACKAGE}");`,
      /dynamic import of a store loader is unsupported/,
    ],
    [
      `export { load } from "${PLUGIN_PACKAGE}";`,
      /re-export of a store loader is unsupported/,
    ],
    [
      `import { "load" as x } from "${PLUGIN_PACKAGE}";`,
      /import item that is not a plain identifier is unsupported/,
    ],
  ]) {
    assert.throws(() => checkOpenerFixture(fixture), message);
  }
});

test("type-only, foreign and commented imports derive no opener", () => {
  for (const fixture of [
    `import type { Store } from "${PLUGIN_PACKAGE}";\nimport { load } from "./other";\nload(a, b);`,
    `import { type Store, getStore } from "${PLUGIN_PACKAGE}";\nload(a, b);`,
    `// import { load } from "${PLUGIN_PACKAGE}"\nload(a, b);`,
    `import { memoizedStoreLoader } from "@/lib/plugin-store";\nload(a, b);`,
  ]) {
    assert.deepEqual(checkOpenerFixture(fixture), [], fixture);
  }
  assert.deepEqual(
    checkOpenerFixture(
      `import { LazyStore, Store, type StoreOptions } from "${PLUGIN_PACKAGE}";\n` +
        "await Store.load(storeName(f), storeLoadOptions(f));\n" +
        "new LazyStore(storeName(f), storeLoadOptions(f));",
    ),
    [OPENER_FIXTURE],
  );
});

test("mutation control: escaped or non-exact specifiers fail in any file", () => {
  const escaped = `@tauri-apps${BACKSLASH}/plugin-store`;
  for (const [fixture, message] of [
    [
      `import { load } from "${escaped}";\nexport const s = await load("x.json");`,
      /fixture\.ts:1: escaped module specifier is unsupported/,
    ],
    [
      `const m = await import("${escaped}");`,
      /fixture\.ts:1: escaped module specifier is unsupported/,
    ],
    [
      `const m = await import(\`${escaped}\`);`,
      /fixture\.ts:1: escaped module specifier is unsupported/,
    ],
    [
      `export { load } from "${escaped}";`,
      /fixture\.ts:1: escaped module specifier is unsupported/,
    ],
    [
      `type T = typeof import("${escaped}");`,
      /fixture\.ts:1: escaped module specifier is unsupported/,
    ],
    [
      'import { load } from "@/../node_modules/@tauri-apps/plugin-store";',
      /fixture\.ts:1: an unnormalized specifier is unsupported/,
    ],
    [
      'import { load } from "node_modules/@tauri-apps/plugin-store";',
      /fixture\.ts:1: a node_modules specifier is unsupported/,
    ],
    [
      'import { load } from "@tauri-apps//plugin-store";',
      /fixture\.ts:1: an unnormalized specifier is unsupported/,
    ],
    [
      'import { load } from "@tauri-apps/./plugin-store";',
      /fixture\.ts:1: an unnormalized specifier is unsupported/,
    ],
    [
      `import { load } from "${PLUGIN_PACKAGE}/";`,
      /fixture\.ts:1: an unnormalized specifier is unsupported/,
    ],
    [
      `import { load } from "${PLUGIN_PACKAGE}/dist-js/index.js";`,
      /fixture\.ts:1: a plugin-store subpath specifier is unsupported/,
    ],
  ]) {
    assert.ok(!fixture.includes(`"${PLUGIN_PACKAGE}"`), fixture);
    assert.throws(() => checkOpenerFixture(fixture), message);
  }
});

test("mutation control: escapes, shadowed helpers and computed names fail an opener", () => {
  const valid = `${IMPORT_LOAD}load(storeName(f), storeLoadOptions(f));\n`;
  const bound = (name, line) =>
    new RegExp(`fixture\\.ts:${line}: ${name} is bound or referenced other`);
  const computed =
    /:2: the store file argument must be a string literal or a bare identifier/;
  for (const [fixture, message] of [
    [
      `${valid}export const s = await lo${BACKSLASH}u0061d("x.json");`,
      /fixture\.ts:3: escaped identifier is unsupported/,
    ],
    [
      `${valid}const storeLoadOptions = (_n: string) => ({ autoSave: 100 });`,
      bound("storeLoadOptions", 3),
    ],
    [
      `${IMPORT_LOAD}export function f(storeLoadOptions: (n: string) => object) {\n  return load(storeName(g), storeLoadOptions(g));\n}`,
      bound("storeLoadOptions", 2),
    ],
    [
      `${valid}function storeName(n: string) {\n  return n;\n}`,
      bound("storeName", 3),
    ],
    [
      `${valid}export function f() {\n  function /* scoped override for this opener only */ storeLoadOptions(_n: string) {\n    return {};\n  }\n}`,
      bound("storeLoadOptions", 4),
    ],
    [
      `${IMPORT_LOAD}import { storeLoadOptions } from "./opts";\nload(storeName(f), storeLoadOptions(f));`,
      /fixture\.ts:2: storeLoadOptions must be a plain named import from @\/lib\/plugin-store/,
    ],
    [
      `${IMPORT_LOAD}load(storeName(names[i++]), storeLoadOptions(names[i++]));`,
      computed,
    ],
    [
      `${IMPORT_LOAD}load(storeName(cfg.file), storeLoadOptions(cfg.file));`,
      computed,
    ],
    [
      `${valid}export const o = { ...load(storeName("b.json"), {}) };`,
      /fixture\.ts:3: load options come from storeLoadOptions/,
    ],
  ]) {
    assert.throws(() => checkOpenerFixture(fixture), message);
  }
});

test("mutation control: a generic function type can't hide a .tsx opener site", () => {
  // In .tsx a generic function type (an alias's right-hand side or an
  // annotation) lexes as an element named `T`; the comment's unrelated close
  // tag must not end it over the bad site between, so the mask fails closed.
  const valid = `${IMPORT_LOAD}await load(storeName("a.json"), storeLoadOptions("a.json"));\n`;
  const bad = 'export const prefs = load(storeName("prefs.json"));\n';
  for (const type of [
    "export type Cmp = <T>(a: T, b: T) => number;",
    "export const cmp: <T>(a: T, b: T) => number = by;",
  ]) {
    assert.throws(
      () =>
        checkOpenerFixture(
          `${valid}${type}\n${bad}// keep in sync with the </table> markup\n`,
          "src/fixture.tsx",
        ),
      /mismatched JSX closing tag at line 5/,
    );
  }
});

test("mutation control: a computed dynamic import fails in any file", () => {
  const refused = (file, line) =>
    new RegExp(`${escapeRe(file)}:${line}: ${escapeRe(COMPUTED_IMPORT)}`);
  for (const fixture of [
    'const m = await import("@tauri-apps/" + "plugin-store");',
    "const m = await import(`@tauri-apps/${name}`);",
    "const m = await import(spec);",
    "const m = await import(/* c */ spec);",
    "const m = c ? import(spec) : 0;",
    "const m = [import(spec)];",
    "await import(spec);",
    "x = import(spec);",
    "cond ? a * import(spec) : b;",
    "c ? (0, import(spec)) : null;",
  ]) {
    assert.throws(
      () => checkOpenerFixture(fixture),
      refused("src/fixture.ts", 1),
      fixture,
    );
  }
  // Calls on a line of their own, after ASI, in a class field or an object
  // value, and inside members named `interface`/`class`, are all refused.
  for (const [fixture, file, line] of [
    ["import(spec)\n{}", "src/fixture.ts", 1],
    ["if (x) {\n  import(spec)\n  {}\n}", "src/fixture.ts", 2],
    ["if (el.class) {\n  import(spec)\n  {}\n}", "src/fixture.ts", 2],
    ["class A {\n  m = import(spec);\n}", "src/fixture.ts", 2],
    ["const o = { a: import(spec) };", "src/fixture.ts", 1],
    ["const o = { k: c ? a * import(spec) : b };", "src/fixture.ts", 1],
    ["const o = { k: c ? (0, import(spec)) : null };", "src/fixture.ts", 1],
    [
      'const routes = {\n  interface: "eth0",\n  load: async () => {\n    const m = await import(spec);\n    return m;\n  },\n};',
      "src/fixture.ts",
      4,
    ],
    [
      "const o = {\n  interface,\n  load() {\n    return import(spec);\n  },\n};",
      "src/fixture.ts",
      4,
    ],
    [
      "const o = { interface: a, f: (b) => { return b ? import(spec) : 0; } };",
      "src/fixture.ts",
      1,
    ],
    [
      "class Net {\n  interface() {\n    return import(spec);\n  }\n}",
      "src/fixture.ts",
      3,
    ],
    [
      "class Net {\n  get interface() { return import(spec); }\n}",
      "src/fixture.ts",
      2,
    ],
    [
      'const o = {\n  class: "x",\n  load: () => {\n    import(spec)\n    {}\n  },\n};',
      "src/fixture.ts",
      4,
    ],
    [
      "const o = {\n  class() {\n    import(spec)\n    {}\n  },\n};",
      "src/fixture.ts",
      3,
    ],
    [
      "export const loadMessages = dev\n  ? (locale: string, region: string, variant: string) =>\n      import(modulePathFor(locale, region, variant, extraArgument))\n  : null;",
      "src/fixture.ts",
      3,
    ],
    [
      "export const loadMessages = dev\n  ? (locale: string, region: string, variant: string) =>\n      import(`./locales/${locale}/${region}/${variant}/messages.json`)\n  : null;",
      "src/fixture.ts",
      3,
    ],
    ["const m = dev ?\n  import(spec) :\n  other;", "src/fixture.ts", 2],
    [
      "export const X = () => <div>{dev ?\n  import(spec) : null}</div>;",
      "src/fixture.tsx",
      2,
    ],
    // A method or signature named `import` is refused too, and renamed.
    ["class A {\n  import(data: string) {\n    return data;\n  }\n}", 2],
    ["interface I {\n  import(s: string): void;\n}", 2],
    ["type L = { import(s: string): void };", 1],
    ["const o = { import(s: string) { return s; } };", 1],
    ["class C {\n  async import() {}\n}", 2],
    ["class D {\n  get import() { return 1; }\n}", 2],
    ["class E {\n  static import(s: string) {}\n}", 2],
    ["const o = { *import(s) { yield s; } };", 1],
    ["class F { *import(d) {} }", 1],
    ["class G {\n  @dec()\n  import(s: string) {}\n}", 3],
    ["interface J {\n  other(): void\n  import(s: string): void;\n}", 3],
    ["f({ import(s) {} });", 1],
    ["const A = class extends B {\n  import(s: string) {}\n};", 2],
    ["export default {\n  import(s: string) {\n    return s;\n  },\n};", 2],
  ].map((row) =>
    row.length === 2 ? [row[0], "src/fixture.ts", row[1]] : row,
  )) {
    assert.throws(
      () => checkOpenerFixture(fixture, file),
      refused(file, line),
      fixture,
    );
  }
  for (const fixture of [
    'const m = await import("./a");',
    "const m = await import(`./a`);",
    'type M = typeof import("./a");',
    'await backup.import("https://a//b");',
    'await backup?.import("https://a//b");',
    "class B {\n  #import(s: string) {}\n  run(spec: string) { this.#import(spec); }\n}",
    'class B {\n  #import(s: string) {}\n  run() { this.#import("https://a//b"); }\n}',
  ]) {
    assert.deepEqual(checkOpenerFixture(fixture), [], fixture);
  }
});

test("canonical helpers over literal, identifier and spread sites pass", () => {
  assert.deepEqual(
    checkOpenerFixture(
      'import { writeWithRollback } from "@/lib/plugin-store-rollback";',
    ),
    [],
  );
  for (const fixture of [
    `${IMPORT_LOAD}load(storeName("a.json"), storeLoadOptions("a.json"));`,
    `${IMPORT_LOAD}load(storeName(file), storeLoadOptions(file));`,
    `${IMPORT_LOAD}export const o = { ...load(storeName(f), storeLoadOptions(f)) };`,
  ]) {
    assert.deepEqual(checkOpenerFixture(fixture), [OPENER_FIXTURE], fixture);
  }
});

test("mutation control: a real opener rewritten to a type-only import fails the floor", () => {
  const file = "src/lib/analytics/posthog.ts";
  const files = [...srcFiles()];
  const mutant = files.map(([name, text]) => [
    name,
    name === file
      ? text.replace(
          IMPORT_LOAD,
          `import type { Store } from "${PLUGIN_PACKAGE}";\n`,
        )
      : text,
  ]);
  assert.notDeepEqual(mutant, files);
  assert.throws(
    () => assertPluginStoreOpeners(mutant),
    /OPENERS floor: src\/lib\/analytics\/posthog\.ts is not derived/,
  );
});

test("autoSave is spelled nowhere in src outside plugin-store.ts", () => {
  const files = [...srcFiles()];
  assert.ok(files.length > 100, "the src scan read the tree");
  assert.deepEqual(autoSaveHits(files), []);
  assert.ok(
    /\bautoSave\b/.test(maskNonCode(source(PLUGIN_STORE), false)),
    "plugin-store.ts still mints the option",
  );
});

test("mutation control: an adopted store moved into EXEMPT drifts the allowlist", () => {
  const ratchet = source("scripts/app-store-lock.test.mjs");
  const mutant = ratchet
    .replace('  "src/lib/jira/store.ts",\n', "")
    .replace(
      "const EXEMPT = new Map([",
      'const EXEMPT = new Map([\n  ["src/lib/jira/store.ts", "fixture"],',
    );
  assert.notEqual(mutant, ratchet);
  assert.ok(parseExemptModules(mutant).includes("src/lib/jira/store.ts"));
  assert.throws(
    () => assertAutosaveAllowlist(mutant),
    /AUTOSAVE_STORES drifted/,
  );
});

test("mutation control: a lock-forced-save store on the allowlist fails", () => {
  const text = source(PLUGIN_STORE);
  const mutant = text.replace(
    '  "analytics.json",\n',
    '  "analytics.json",\n  "settings.json",\n',
  );
  assert.notEqual(mutant, text);
  assert.throws(
    () =>
      assertAutosaveAllowlist(undefined, (file) =>
        file === PLUGIN_STORE ? mutant : source(file),
      ),
    /AUTOSAVE_STORES drifted/,
  );
});

test("mutation control: inline loader options fail the opener pin", () => {
  const text = source(PLUGIN_STORE);
  const mutant = text.replace(
    "load(storeName(file), storeLoadOptions(file))",
    "load(storeName(file), { autoSave: true, defaults: {} })",
  );
  assert.notEqual(mutant, text);
  assert.throws(
    () => assertLoadsTakeStoreOptions(mutant, PLUGIN_STORE),
    /load options come from storeLoadOptions/,
  );
});

test("mutation control: a migration opener with literal options fails", () => {
  const file = "src/lib/repo-data-migration.ts";
  const text = source(file);
  const mutant = text.replace(
    "load(storeName(file), storeLoadOptions(file))",
    "load(storeName(file), { autoSave: false, defaults: {} })",
  );
  assert.notEqual(mutant, text);
  assert.throws(
    () => assertLoadsTakeStoreOptions(mutant, file),
    /load options come from storeLoadOptions/,
  );
  const wrapped = text.replace(
    "load(storeName(file), storeLoadOptions(file))",
    "load(storeName(file), storeLoadOptions(storeName(file)))",
  );
  assert.notEqual(wrapped, text);
  assert.throws(
    () => assertLoadsTakeStoreOptions(wrapped, file),
    /load options come from storeLoadOptions/,
  );
});

test("mutation control: a store module with zero or two literal openers fails closed", () => {
  for (const fixture of [
    "const getStore = memoizedStoreLoader(STORE_FILE);",
    'const F = "a.json";\nconst F = "b.json";\nmemoizedStoreLoader(F);',
    "memoizedStoreLoader(`a.json`);",
    'const a = memoizedStoreLoader("a.json");\nconst b = memoizedStoreLoader("b.json");',
    'const a = memoizedStoreLoader("a.json");\nload(storeName("b.json"), storeLoadOptions("b.json"));',
  ]) {
    assert.throws(
      () => storeFileOf(fixture, "fixture.ts"),
      /exactly one literal store opener/,
    );
  }
  assert.equal(
    storeFileOf(
      '// memoizedStoreLoader("x.json")\nmemoizedStoreLoader("a.json");',
      "f.ts",
    ),
    "a.json",
  );
  assert.equal(
    storeFileOf(
      'const STORE_FILE = "b.json";\nmemoizedStoreLoader(STORE_FILE);',
      "f.ts",
    ),
    "b.json",
  );
});

test("mutation control: an autoSave option outside plugin-store.ts fails", () => {
  const file = "src/lib/analytics/posthog.ts";
  const text = source(file);
  for (const options of ["{ autoSave: true }", '{ "autoSave": true }']) {
    const mutant = text.replace(
      'storeLoadOptions("analytics.json")',
      () => options,
    );
    assert.notEqual(mutant, text);
    assert.equal(autoSaveHits([[file, mutant]]).length, 1, options);
  }
  assert.deepEqual(
    autoSaveHits([[file, `${text}\n// autoSave is off; "autoSave" too\n`]]),
    [],
  );
});

// The FORCE_SAVING_EXEMPT reason: every store write in review-notes lives in
// `writeBranchToStore`, and a `store.save()` follows its last write there.
const FORCE_SAVING_WRITER = "writeBranchToStore";
function assertForceSavingWriter(text, file) {
  const masked = maskNonCode(text, false);
  const bodies = namedFunctions(masked).get(FORCE_SAVING_WRITER) ?? [];
  assert.equal(bodies.length, 1, `${file}: one ${FORCE_SAVING_WRITER}`);
  const [body] = bodies;
  const writes = [
    ...masked.matchAll(
      /(?<![\w$.])store\s*(?:\?\.|!\.|\.)\s*(?:set|delete|clear|reset)\s*\(/g,
    ),
  ].map((match) => match.index);
  assert.ok(writes.length > 0, `${file}: the writer's store writes`);
  for (const at of writes) {
    assert.ok(
      at >= body.start && at < body.end,
      `${file}:${lineOf(masked, at)}: store write outside ${FORCE_SAVING_WRITER}`,
    );
  }
  const saves = [
    ...masked
      .slice(body.start, body.end)
      .matchAll(/(?<![\w$.])store\s*(?:\?\.|!\.|\.)\s*save\s*\(/g),
  ].map((match) => body.start + match.index);
  assert.ok(
    saves.some((at) => at > Math.max(...writes)),
    `${file}: ${FORCE_SAVING_WRITER} must force-save after its last write`,
  );
}

test("each force-saving exempt store saves after every write", () => {
  for (const file of FORCE_SAVING_EXEMPT) {
    assertForceSavingWriter(source(file), file);
  }
});

test("mutation control: a force-saving exempt writer without its save fails", () => {
  const file = "src/lib/review-notes/store.ts";
  const text = source(file);
  const unsaved = text.replace("  await store.save();\n", "");
  assert.notEqual(unsaved, text);
  assert.throws(
    () => assertForceSavingWriter(unsaved, file),
    /must force-save after its last write/,
  );
  const early = text
    .replace("  await store.save();\n", "")
    .replace(
      "  const branches = {",
      "  await store.save();\n  const branches = {",
    );
  assert.notEqual(early, text);
  assert.throws(
    () => assertForceSavingWriter(early, file),
    /must force-save after its last write/,
  );
  const stray = `${text}\nexport async function extra() {\n  const store = await getStore();\n  await store.set("k", 1);\n}\n`;
  assert.throws(
    () => assertForceSavingWriter(stray, file),
    /store write outside writeBranchToStore/,
  );
});
