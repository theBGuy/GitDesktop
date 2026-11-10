// Pins source shapes the Actions tab's run filters rest on: the palette rows
// sit at the end of the registry (the shared file is append-only), the GitHub
// run window constant has one home (src/features/actions/run-filters.ts), the
// new popups' items ignore a held Enter/Space, the Workflows section is a
// roving list rather than a landmark, and the panel keeps its toolbar
// container query, its Run label slot and its one facet announcement.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (rel) =>
  readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

const REGISTRY = "lib/hotkeys/registry.ts";

/** The 15 palette rows, in file order. */
const ROWS = [
  ["filter-runs", "Filter runs…"],
  ["clear-run-filters", "Clear filters"],
  ["toggle-workflows-section", "Show or hide workflows"],
  ["open-actions-github-caches", "Open Actions caches on GitHub"],
  ["open-actions-github-deployments", "Open Deployments on GitHub"],
  ["open-actions-github-attestations", "Open Attestations on GitHub"],
  ["open-actions-github-runners", "Open Runners on GitHub"],
  ["open-actions-github-usage", "Open Actions usage on GitHub"],
  ["open-actions-github-performance", "Open Actions performance on GitHub"],
  ["open-actions-gitlab-pipelines", "Open Pipelines & caches on GitLab"],
  ["open-actions-gitlab-environments", "Open Environments on GitLab"],
  [
    "open-actions-gitlab-ci-settings",
    "Open CI/CD settings (runners) on GitLab",
  ],
  ["open-actions-gitlab-ci-analytics", "Open CI/CD analytics on GitLab"],
  ["open-actions-bitbucket-pipelines", "Open Pipelines & caches on Bitbucket"],
  ["open-actions-bitbucket-deployments", "Open Deployments on Bitbucket"],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Failures for the registry text: every row present once, palette-only in
 *  the Actions category, after app-zoom-reset and before the array's end. */
function checkRegistry(text) {
  const out = [];
  const anchor = text.indexOf('id: "app-zoom-reset"');
  const end = text.indexOf("] as const satisfies readonly ActionDef[];");
  if (anchor === -1 || end === -1) return ["registry anchors missing"];
  let last = anchor;
  for (const [id, label] of ROWS) {
    const re = new RegExp(
      `\\{\\s*id: "${escapeRe(id)}",\\s*label: "${escapeRe(label)}",\\s*category: "Actions",\\s*defaultBinding: null,\\s*\\}`,
      "g",
    );
    const hits = [...text.matchAll(re)];
    if (hits.length !== 1) {
      out.push(`${id}: ${hits.length} rows`);
      continue;
    }
    const at = hits[0].index;
    if (at < last || at > end) out.push(`${id}: out of place`);
    last = at;
  }
  return out;
}

test("the 15 palette rows are appended after app-zoom-reset, palette-only", () => {
  const text = read(REGISTRY);
  assert.deepEqual(checkRegistry(text), []);
  // Mutant: the first row moved above app-zoom-reset.
  const row = text.match(/\n {2}\{\s*id: "filter-runs",[\s\S]*?\n {2}\},/)[0];
  const moved = text
    .replace(row, "")
    .replace('\n  {\n    id: "app-zoom-reset"', `${row}\n  {\n    id: "app-zoom-reset"`);
  assert.notDeepEqual(checkRegistry(moved), []);
  // Mutant: a row given a binding.
  const bound = text.replace(
    /(id: "clear-run-filters",[\s\S]*?defaultBinding: )null/,
    '$1"mod+k"',
  );
  assert.notDeepEqual(checkRegistry(bound), []);
});

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const WINDOW_DEF = /\b(?:const|let|var)\s+FILTERED_RUN_WINDOW\b/g;
const WINDOW_HOME = path.join("features", "actions", "run-filters.ts");

/** Failures for a {relative path: text} corpus: exactly one definition. */
function checkWindowHome(corpus) {
  const homes = Object.entries(corpus)
    .filter(([, text]) => text.match(WINDOW_DEF))
    .map(([rel, text]) => [rel, text.match(WINDOW_DEF).length]);
  const ok =
    homes.length === 1 && homes[0][0] === WINDOW_HOME && homes[0][1] === 1;
  return ok ? [] : [`definitions: ${JSON.stringify(homes)}`];
}

test("FILTERED_RUN_WINDOW is defined once, in run-filters.ts", () => {
  const corpus = Object.fromEntries(
    sourceFiles(SRC).map((f) => [
      path.relative(SRC, f),
      readFileSync(f, "utf8"),
    ]),
  );
  assert.ok(Object.keys(corpus).length > 100, "the src corpus was read");
  assert.deepEqual(checkWindowHome(corpus), []);
  const panel = path.join("features", "actions", "ActionsPanel.tsx");
  const mutant = {
    ...corpus,
    [panel]: `${corpus[panel]}\nconst FILTERED_RUN_WINDOW = 1000;\n`,
  };
  assert.notDeepEqual(checkWindowHome(mutant), []);
});

const GUARD = [
  'if (e.repeat && (e.key === "Enter" || e.key === " ")) {',
  "e.preventDefault();",
  "e.preventBaseUIHandler();",
];

/** Failures for one file: every `<tag` element, up to its closing tag, carries
 *  the held-key guard; a file with no such element is a failure too. */
function checkRepeatGuards(text, tag, close) {
  const out = [];
  let at = text.indexOf(`<${tag}`);
  if (at === -1) return [`no <${tag}`];
  while (at !== -1) {
    const end = text.indexOf(close, at);
    const element = end === -1 ? text.slice(at) : text.slice(at, end);
    const flat = element.replace(/\s+/g, " ");
    if (!GUARD.every((g) => flat.includes(g)))
      out.push(`<${tag} at ${at} lacks the repeat guard`);
    at = text.indexOf(`<${tag}`, at + 1);
  }
  return out;
}

test("every new menu and combobox item ignores a held Enter/Space", () => {
  const sites = [
    ["features/actions/ManageMenu.tsx", "DropdownMenuItem", "</DropdownMenuItem>"],
    [
      "features/actions/RunFilterPopover.tsx",
      "ComboboxPrimitive.Item",
      "</ComboboxPrimitive.Item>",
    ],
  ];
  for (const [rel, tag, close] of sites) {
    const text = read(rel);
    assert.deepEqual(checkRepeatGuards(text, tag, close), [], rel);
    const mutant = text.replace("e.preventBaseUIHandler();", "");
    assert.notDeepEqual(checkRepeatGuards(mutant, tag, close), [], `${rel} mutant`);
  }
});

function checkWorkflowsSection(text) {
  const out = [];
  if (!/import \{[^}]*\buseRovingRows\b[^}]*\} from "@\/lib\/list-keyboard-nav"/.test(text))
    out.push("useRovingRows not imported");
  if (text.includes("<nav")) out.push("a <nav landmark");
  return out;
}

test("the Workflows section is a roving list, not a landmark", () => {
  const text = read("features/actions/WorkflowsSection.tsx");
  assert.deepEqual(checkWorkflowsSection(text), []);
  assert.notDeepEqual(
    checkWorkflowsSection(text.replace("<ul", "<nav><ul")),
    [],
  );
});

function checkPanel(text) {
  const out = [];
  if (!text.includes("@container/actions-toolbar")) out.push("no toolbar container");
  if (!text.includes('data-slot="run-label"')) out.push("no Run label slot");
  const n = text.split('data-testid="run-facet-announcement"').length - 1;
  if (n !== 1) out.push(`${n} facet announcements`);
  return out;
}

test("the panel keeps its toolbar container, Run label slot and one announcement", () => {
  const text = read("features/actions/ActionsPanel.tsx");
  assert.deepEqual(checkPanel(text), []);
  assert.notDeepEqual(
    checkPanel(
      text.replace(
        'data-testid="run-facet-announcement"',
        'data-testid="run-facet-announcement"\n data-testid="run-facet-announcement"',
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    checkPanel(text.replace("@container/actions-toolbar", "")),
    [],
  );
});
