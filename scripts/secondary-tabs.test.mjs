// Pins the repository view's More menu: src/features/repository/secondary-tabs.ts
// lists the secondary tabs by label (Agent only while AI features are on), each
// row's action is its tab's switch action, and the effective binding passes
// through untouched. An in-memory mutant without the sort must fail the order.
//
// The menus render only inside RepositoryView, which nothing renders in jsdom,
// so the render half is a source pin over MASKED code (comments and string text
// blanked): both maps show the binding through the shared formatter and
// aria-keyshortcuts, under a null guard. Each pin carries an in-memory control.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY. The module is
// imported through the shared src hooks; mutants load from memory under its URL
// plus a query, so nothing is written to disk.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const MODULE_URL = new URL(
  "../src/features/repository/secondary-tabs.ts",
  import.meta.url,
).href;

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
const moduleSrc = readFileSync(new URL(MODULE_URL), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** Imports the module with `from` replaced by `to`, from memory. */
async function importMutated(from, to) {
  assert.equal(
    moduleSrc.split(from).length,
    2,
    `mutation anchor appears exactly once: ${from}`,
  );
  const url = `${MODULE_URL}?mutant=${mutants.size}`;
  mutants.set(
    url,
    moduleSrc.replace(from, () => to),
  );
  return import(url);
}

const ORDER = [
  "Actions",
  "Agent",
  "Code TODOs",
  "Compare",
  "Discussions",
  "Findings",
  "Insights",
  "Issues",
  "Projects",
  "Tags",
  "Tasks",
];

const labelsOf = (mod, aiEnabled) =>
  mod.secondaryTabRows(aiEnabled, new Map()).map((r) => r.label);

test("the More menu lists its tabs by label, Agent only while AI is on", () => {
  assert.deepEqual(labelsOf(real, true), ORDER);
  assert.deepEqual(
    labelsOf(real, false),
    ORDER.filter((l) => l !== "Agent"),
  );
  assert.deepEqual(
    real.SECONDARY_TABS.map((t) => t.label),
    ORDER,
  );
});

const REGISTRY = readFileSync(
  new URL("../src/lib/hotkeys/registry.ts", import.meta.url),
  "utf8",
);

test("each row's action is its tab's registered switch action", () => {
  for (const t of real.SECONDARY_TABS) {
    assert.equal(t.action, `tab-${t.tab}`, t.label);
    assert.equal(
      REGISTRY.split(`id: "${t.action}",`).length,
      2,
      `registry declares ${t.action} once`,
    );
  }
});

test("the effective binding passes through: default, override and null", () => {
  const bindings = new Map([
    ["tab-compare", "mod+3"],
    ["tab-issues", "mod+shift+i"],
    ["tab-tags", null],
    ["tab-projects", null],
  ]);
  const rows = real.secondaryTabRows(true, bindings);
  const byTab = Object.fromEntries(rows.map((r) => [r.tab, r.binding]));
  assert.equal(byTab.compare, "mod+3");
  assert.equal(byTab.issues, "mod+shift+i");
  assert.equal(byTab.tags, null);
  assert.equal(byTab.projects, null);
  // A tab the map doesn't name is unbound.
  assert.equal(byTab.actions, null);
});

test("negative control: a module without the sort fails the order", async () => {
  const mutant = await importMutated(
    ').sort((a, b) => a.label.localeCompare(b.label, "en"));',
    ");",
  );
  assert.notDeepEqual(labelsOf(mutant, true), ORDER);
});

const VIEW = readFileSync(
  new URL("../src/features/repository/RepositoryView.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** Every `secondaryTabs.map(` callback body, as masked code. */
function rowMaps(masked) {
  const maps = [];
  const re = /\bsecondaryTabs\.map\(/g;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) throw new Error("unclosed secondaryTabs.map(");
    maps.push(masked.slice(open, close + 1));
  }
  return maps;
}

/** Ways the More menu renders drift from the binding contract. */
function renderFailures(source) {
  const masked = maskNonCode(source, true);
  const maps = rowMaps(masked);
  const failures = [];
  if (maps.length !== 2) failures.push(`${maps.length} row maps, want 2`);
  for (const [i, body] of maps.entries()) {
    const flat = body.replace(/\s+/g, " ");
    if (!flat.includes("<DropdownMenuItem "))
      failures.push(`map ${i}: no DropdownMenuItem`);
    if (!flat.includes("({ tab, label, binding })"))
      failures.push(`map ${i}: the row's binding is not read`);
    if (
      !flat.includes(
        "aria-keyshortcuts={ binding === null ? undefined : bindingToAriaKeyshortcuts(binding) }",
      )
    )
      failures.push(`map ${i}: aria-keyshortcuts under the null guard`);
    if (
      !flat.includes(
        "{binding !== null && ( <DropdownMenuShortcut aria-hidden> {formatBinding(binding)} </DropdownMenuShortcut> )}",
      )
    )
      failures.push(`map ${i}: the shortcut slot under the null guard`);
  }
  return failures;
}

test("both More menus show each row's binding under a null guard", () => {
  assert.deepEqual(renderFailures(VIEW), []);
});

test("negative controls: a dropped guard or a dropped shortcut fails", () => {
  const guard =
    "binding === null\n                  ? undefined\n                  : bindingToAriaKeyshortcuts(binding)";
  assert.equal(VIEW.split(guard).length, 2, "guard anchor once");
  assert.notDeepEqual(
    renderFailures(
      VIEW.replace(guard, () => 'bindingToAriaKeyshortcuts(binding ?? "")'),
    ),
    [],
  );
  const slot =
    "              {binding !== null && (\n                <DropdownMenuShortcut aria-hidden>\n                  {formatBinding(binding)}\n                </DropdownMenuShortcut>\n              )}\n";
  assert.equal(VIEW.split(slot).length, 2, "slot anchor once");
  assert.notDeepEqual(renderFailures(VIEW.replace(slot, () => "")), []);
  // A comment spelling the shortcut can't stand in for it.
  assert.notDeepEqual(
    renderFailures(
      VIEW.replace(
        slot,
        () =>
          "              {/* {binding !== null && ( <DropdownMenuShortcut aria-hidden> {formatBinding(binding)} </DropdownMenuShortcut> )} */}\n",
      ),
    ),
    [],
  );
});

/** Ways the rows' `bindings` drift from the user's effective (rebound) map. */
function bindingSourceFailures(source) {
  const masked = maskNonCode(source, true).replace(/\s+/g, " ");
  const failures = [];
  const calls = masked.match(/\bsecondaryTabRows\(/g) ?? [];
  if (calls.length !== 1)
    failures.push(`${calls.length} secondaryTabRows calls`);
  if (!masked.includes("secondaryTabRows(aiEnabled, bindings)"))
    failures.push("rows built from `bindings`");
  const decls = masked.match(/\b(const|let|var) bindings\b/g) ?? [];
  if (decls.length !== 1)
    failures.push(`${decls.length} bindings declarations`);
  if (!masked.includes("const bindings = useEffectiveBindings();"))
    failures.push("bindings from useEffectiveBindings()");
  return failures;
}

test("the More menu rows take the effective bindings", () => {
  assert.deepEqual(bindingSourceFailures(VIEW), []);
});

test("negative controls: a default-only or commented-out binding source fails", () => {
  const decl = "const bindings = useEffectiveBindings();";
  assert.equal(VIEW.split(decl).length, 2, "decl anchor once");
  for (const to of [
    "const bindings = defaultBindings();",
    "/* const bindings = useEffectiveBindings(); */ const bindings = new Map();",
  ])
    assert.notDeepEqual(
      bindingSourceFailures(VIEW.replace(decl, () => to)),
      [],
      to,
    );
  const call = "secondaryTabRows(aiEnabled, bindings)";
  assert.equal(VIEW.split(call).length, 2, "call anchor once");
  assert.notDeepEqual(
    bindingSourceFailures(
      VIEW.replace(call, () => "secondaryTabRows(aiEnabled, new Map())"),
    ),
    [],
  );
});
