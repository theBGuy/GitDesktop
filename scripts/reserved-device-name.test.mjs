// Pins `pathHasReservedComponent` (src/lib/git/reserved-device-name.ts) to the
// backend's `path_has_reserved_component` (src-tauri/src/fsops.rs): its rows
// are the Rust test's own, so the Stash counts leave out exactly the paths the
// path stash excludes. `reservedDeviceName` keeps reading the file name alone.
//
// The module decides on `navigator.platform`, so the suite poses as Windows
// before its first import. Imported through the shared src hooks (dynamic, so
// they are registered before the module links); mutants load from memory under
// the module's own URL plus a query, so nothing is written to disk.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const MODULE_URL = new URL(
  "../src/lib/git/reserved-device-name.ts",
  import.meta.url,
).href;

Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Win32" },
  configurable: true,
});
const hooks = installSrcHooks();
const mutants = new Map();
const loads = registerHooks({
  load(url, context, next) {
    const source = mutants.get(url);
    if (source === undefined) return next(url, context);
    return { format: "module-typescript", source, shortCircuit: true };
  },
});
after(() => {
  loads.deregister();
  hooks.deregister();
});

const real = await import(MODULE_URL);

/** Imports the module with `from` replaced by `to`, from memory. */
async function importMutated(from, to) {
  const source = readFileSync(new URL(MODULE_URL), "utf8");
  const out = source.replace(from, to);
  assert.notEqual(out, source, `mutation did not apply: ${from}`);
  const url = `${MODULE_URL}?mutant=${mutants.size}`;
  mutants.set(url, out);
  return import(url);
}

// fsops.rs `path_has_reserved_component_walks_every_component`.
const RESERVED = [
  "con/x.txt",
  "a/nul.txt/deep.bin",
  "nul",
  "a/com\u00b9/b/c.txt",
];
const ORDINARY = ["console/x", "com10/x", "a/nulx", ""];

/** Rows the module gets wrong (empty = agrees with the backend). */
function rowFailures(mod) {
  return [
    ...RESERVED.filter((p) => !mod.pathHasReservedComponent(p)),
    ...ORDINARY.filter((p) => mod.pathHasReservedComponent(p)),
  ];
}

test("every component is checked, like the backend's stash exclude", () => {
  assert.deepEqual(rowFailures(real), []);
});

test("the file-name check stays last-segment only", () => {
  assert.equal(real.reservedDeviceName("con/x.txt"), null);
  assert.equal(real.reservedDeviceName("a/nul.txt"), "nul.txt");
});

test("a last-segment-only component check goes red", async () => {
  const mutant = await importMutated(
    'path.split("/").some(isReservedComponent)',
    'isReservedComponent(path.slice(path.lastIndexOf("/") + 1))',
  );
  assert.deepEqual(rowFailures(mutant), [
    "con/x.txt",
    "a/nul.txt/deep.bin",
    "a/com\u00b9/b/c.txt",
  ]);
});

test("a component check that ignores the stem rule goes red", async () => {
  const mutant = await importMutated(
    'const stem = name.split(".")[0].replace(/ +$/, "");',
    "const stem = name;",
  );
  assert.notDeepEqual(rowFailures(mutant), []);
});
