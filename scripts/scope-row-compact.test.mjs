// The pull-request list's scope row (All / Mine / Needs review + Fork /
// Upstream) keeps one line at the sidebar floor through a CSS-only compact arm:
// under a 316px gd-prhead container, and only while the lens pair is present,
// every segment drops to px-1 and Needs review shows as "Review" (the full label
// stays sr-only, so the accessible name never changes). Pins: the scope row's
// `group/scope` with bare children, the one `@container/gd-prhead` declaration
// every variant queries, the lens switch's `data-slot` marker, one
// threshold / group / marker spelling across both switchers, identical
// COMPACT_PAD literals on every segment button, and the short label's
// aria-hidden span. Not covered: whether Tailwind generated the utilities (the
// built CSS is checked at integration) and the layout itself (a live drive).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PANEL = "src/features/conversations/ConversationListPanel.tsx";
const PRESET = "src/features/conversations/ConversationPresetSwitcher.tsx";
const LENS = "src/features/conversations/RepoLensSwitcher.tsx";
const SWITCHERS = [PRESET, LENS];

const ARM = "@max-[316px]/gd-prhead:group-has-data-[slot=lens-switch]/scope:";
const EXPECTED = {
  COMPACT_PAD: `${ARM}px-1`,
  FULL_LABEL: `${ARM}sr-only`,
  SHORT_LABEL: `hidden ${ARM}inline`,
};

function load() {
  const files = new Map();
  for (const rel of [PANEL, ...SWITCHERS]) {
    files.set(
      rel,
      readFileSync(`${ROOT}${rel}`, "utf8").replace(/\r\n/g, "\n"),
    );
  }
  return files;
}

const count = (text, re) => (text.match(re) ?? []).length;

/** The `const NAME = "…";` literal's value, or null when absent or not a
 *  single plain string literal. */
function constLiteral(text, name) {
  const all = [
    ...text.matchAll(new RegExp(`const ${name} =\\s*"([^"]*)";`, "g")),
  ];
  return all.length === 1 ? all[0][1] : null;
}

function panelProblems(text) {
  const rows = [
    ...text.matchAll(
      /<div className="([^"]*)">\s*\{presetControl\}\s*\{lensControl\}\s*<\/div>/g,
    ),
  ];
  if (rows.length !== 1) {
    return [
      `${PANEL}: want one scope row div with exactly the bare children {presetControl}{lensControl}, found ${rows.length}`,
    ];
  }
  const tokens = new Set(rows[0][1].split(/\s+/));
  const problems = ["group/scope", "empty:hidden"]
    .filter((t) => !tokens.has(t))
    .map((t) => `${PANEL}: scope row div lacks ${t}`);
  // Every compact-arm variant queries this container; without it they never match.
  const containers = text.split('"@container/gd-prhead"').length - 1;
  if (containers !== 1) {
    problems.push(
      `${PANEL}: want one "@container/gd-prhead" declaration, found ${containers}`,
    );
  }
  return problems;
}

function switcherProblems(files) {
  const problems = [];
  for (const rel of SWITCHERS) {
    const text = files.get(rel);
    const loose = count(text, /@max-\[[^\]]*\]\/[^:\s"]*:group-has-/g);
    const exact = text.split(ARM).length - 1;
    if (exact === 0) problems.push(`${rel}: no compact-arm utility`);
    if (loose !== exact) {
      problems.push(
        `${rel}: ${loose - exact} compact-arm variant(s) not spelled ${ARM}`,
      );
    }
    const pad = constLiteral(text, "COMPACT_PAD");
    if (pad !== EXPECTED.COMPACT_PAD) {
      problems.push(`${rel}: COMPACT_PAD is ${JSON.stringify(pad)}`);
    }
    const buttons = count(text, /<DisabledReasonButton\b/g);
    const padded = count(text, /className=\{cn\("px-1\.5", COMPACT_PAD\b/g);
    if (buttons === 0 || buttons !== padded) {
      problems.push(
        `${rel}: ${padded} of ${buttons} segment buttons carry COMPACT_PAD`,
      );
    }
  }
  if (!/<div data-slot="lens-switch"/.test(files.get(LENS))) {
    problems.push(`${LENS}: root div lacks data-slot="lens-switch"`);
  }
  return problems;
}

function labelProblems(text) {
  const problems = [];
  for (const name of ["FULL_LABEL", "SHORT_LABEL"]) {
    const got = constLiteral(text, name);
    if (got !== EXPECTED[name]) {
      problems.push(`${PRESET}: ${name} is ${JSON.stringify(got)}`);
    }
  }
  const at = text.indexOf('value: "needs-review"');
  const entry = at < 0 ? "" : text.slice(at, text.indexOf("}", at));
  if (!entry.includes('shortLabel: "Review"')) {
    problems.push(`${PRESET}: needs-review segment lacks shortLabel "Review"`);
  }
  const shortUses = count(text, /className=\{SHORT_LABEL\}/g);
  const hidden = count(text, /<span aria-hidden className=\{SHORT_LABEL\}>/g);
  if (shortUses === 0 || shortUses !== hidden) {
    problems.push(`${PRESET}: the short-label span must be aria-hidden`);
  }
  if (count(text, /<span className=\{FULL_LABEL\}>/g) !== 1) {
    problems.push(`${PRESET}: want one full-label span`);
  }
  return problems;
}

const FILES = load();

test("the scope row is the named group with bare children", () => {
  assert.deepEqual(panelProblems(FILES.get(PANEL)), []);
});

test("both switchers share one compact arm on every segment", () => {
  assert.deepEqual(switcherProblems(FILES), []);
});

test("Needs review's short label is visual only", () => {
  assert.deepEqual(labelProblems(FILES.get(PRESET)), []);
});

test("mutation controls go red", () => {
  const edit = (rel, from, to) => {
    const text = FILES.get(rel);
    assert.ok(text.includes(from), `${rel}: mutation anchor ${from} missing`);
    return new Map([...FILES, [rel, text.replace(from, to)]]);
  };

  const noGroup = edit(PANEL, "group/scope ", "");
  assert.notDeepEqual(panelProblems(noGroup.get(PANEL)), [], "group dropped");

  const renamed = edit(PANEL, '"@container/gd-prhead"', '"@container/gd-head"');
  assert.notDeepEqual(
    panelProblems(renamed.get(PANEL)),
    [],
    "container renamed",
  );

  const noMarker = edit(LENS, 'data-slot="lens-switch" ', "");
  assert.notDeepEqual(switcherProblems(noMarker), [], "marker dropped");

  const narrower = edit(LENS, "@max-[316px]", "@max-[310px]");
  assert.notDeepEqual(switcherProblems(narrower), [], "310px in one file");

  const unpadded = edit(
    PRESET,
    'className={cn("px-1.5", COMPACT_PAD, s.shortLabel && "relative")}',
    'className="px-1.5"',
  );
  assert.notDeepEqual(switcherProblems(unpadded), [], "button without pad");

  const exposed = edit(
    PRESET,
    "<span aria-hidden className={SHORT_LABEL}>",
    "<span className={SHORT_LABEL}>",
  );
  assert.notDeepEqual(
    labelProblems(exposed.get(PRESET)),
    [],
    "aria-hidden dropped",
  );
});
