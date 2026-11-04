// Pins `pathHasReservedComponent` (src/lib/git/reserved-device-name.ts) to the
// backend's `path_has_reserved_component` (src-tauri/src/fsops.rs): its rows
// are the Rust test's own, so the Stash counts leave out exactly the paths the
// path stash excludes. `reservedDeviceName` keeps reading the file name alone.
// Also pins the context menu's single-file Stash gate to ChangesPanel's
// `staysOutOfStash` (source congruence, two copies of one rule).
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

// The single-file Stash item disables on the panel's stash-exclude rule, spelled
// in both files: a drifted copy would offer a stash that stashes nothing, or hide
// one that works.
const PANEL_SRC = readFileSync(
  new URL("../src/features/repository/ChangesPanel.tsx", import.meta.url),
  "utf8",
);
const MENU_SRC = readFileSync(
  new URL("../src/features/repository/ChangesContextMenu.tsx", import.meta.url),
  "utf8",
);
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Failures (empty = congruent and wired) for a panel/menu source pair. */
function stashGateFailures(panel, menu) {
  const failures = [];
  const panelRule =
    /function staysOutOfStash\(entry: FileEntry\): boolean \{\s*return ([^;]*);/.exec(
      panel,
    );
  const menuRule = /const stashBlocked =([^;]*);/.exec(menu);
  if (!panelRule) failures.push("ChangesPanel must declare staysOutOfStash");
  if (!menuRule) failures.push("the menu must declare stashBlocked");
  if (panelRule && menuRule) {
    const want =
      'entry.unstaged === "untracked" && pathHasReservedComponent(entry.path)';
    if (squash(panelRule[1]) !== want)
      failures.push("staysOutOfStash moved off the component-wise rule");
    if (squash(menuRule[1]) !== squash(panelRule[1]))
      failures.push("stashBlocked differs from staysOutOfStash");
  }
  if (
    !/disabled=\{anyConflicted \|\| stashBlocked\}\s*onClick=\{\(\) => actions\.stashFile\(/.test(
      menu,
    )
  )
    failures.push("the file Stash item must disable on stashBlocked");
  if (
    !/\{stashBlocked \? RESERVED_HINT : anyConflicted \? CONFLICT_HINT : ""\}/.test(
      menu,
    )
  )
    failures.push("the file Stash item must name the reserved name first");
  return failures;
}

test("the file Stash item gates on the panel's stash-exclude rule", () => {
  assert.deepEqual(stashGateFailures(PANEL_SRC, MENU_SRC), []);
});

test("a drifted or unwired Stash gate goes red", () => {
  const swap = (src, from, to) => {
    const out = src.replace(from, to);
    assert.notEqual(out, src, `mutation did not apply: ${from}`);
    return out;
  };
  const cases = [
    [
      PANEL_SRC,
      swap(
        MENU_SRC,
        "pathHasReservedComponent(entry.path);",
        "reservedDeviceName(entry.path) !== null;",
      ),
      /stashBlocked differs from staysOutOfStash/,
    ],
    [
      swap(
        PANEL_SRC,
        'return entry.unstaged === "untracked" && pathHasReservedComponent',
        "return pathHasReservedComponent",
      ),
      MENU_SRC,
      /moved off the component-wise rule/,
    ],
    [
      PANEL_SRC,
      swap(
        MENU_SRC,
        "disabled={anyConflicted || stashBlocked}",
        "disabled={anyConflicted}",
      ),
      /must disable on stashBlocked/,
    ],
    [
      PANEL_SRC,
      swap(
        MENU_SRC,
        "{stashBlocked ? RESERVED_HINT : anyConflicted ? CONFLICT_HINT",
        "{anyConflicted ? CONFLICT_HINT : stashBlocked ? RESERVED_HINT",
      ),
      /reserved name first/,
    ],
  ];
  for (const [panel, menu, message] of cases) {
    const failures = stashGateFailures(panel, menu);
    assert.ok(
      failures.some((f) => message.test(f)),
      `expected ${message}, got ${JSON.stringify(failures)}`,
    );
  }
});
