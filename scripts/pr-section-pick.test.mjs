// Pins the PR views' section-pick wiring (RemotePrView, LocalPrView): every
// USER-driven section change goes through the local `pickSection` helper, which
// calls ui.ts's `noteUserInteraction()` before the local set, so a pending
// continuation guarded on `interactionEpoch` (a markdown `#N` lookup) yields to
// the pick. The two automatic corrections (the pendingPrSection landing and the
// unavailable-section fallback) must stay raw `setSection` calls: a reactive
// correction never strands a continuation. A source scan, since no Vitest
// harness mounts either view; in-memory mutation controls prove it bites.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Repo-root relative, resolved off this file so the cwd never matters.
const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const VIEWS = {
  "src/features/pulls/RemotePrView.tsx": {
    // The section buttons, the tasks chip, the feed's commit drill-in.
    userCalls: 3,
    // The activity feed's "View thread" route.
    userProps: 1,
  },
  "src/features/pulls/LocalPrView.tsx": {
    // The section buttons, the pushed-commits row.
    userCalls: 2,
    userProps: 0,
  },
};

const HELPER =
  /const pickSection = \(next: PrSection\) => \{\n\s*useUiStore\.getState\(\)\.noteUserInteraction\(\);\n\s*setSection\(next\);\n\s*\};/;
const PENDING_LANDING = /^\s*setSection\(pendingPrSection\);$/;
const FALLBACK =
  /^\s*if \(!availableSections\.includes\(section\)\) setSection\("conversation"\);$/;
const HELPER_SET = /^\s*setSection\(next\);$/;

/** The pin's verdict over one view's source, as a list of problems. */
function audit(source, expected) {
  const text = source.replace(/\r\n/g, "\n");
  const problems = [];
  if (!HELPER.test(text))
    problems.push("pickSection helper missing or reshaped");
  const lines = text.split("\n");
  let pending = 0;
  let fallback = 0;
  for (const [i, line] of lines.entries()) {
    if (!/\bsetSection\(/.test(line)) continue;
    if (PENDING_LANDING.test(line)) pending += 1;
    else if (FALLBACK.test(line)) fallback += 1;
    else if (!HELPER_SET.test(line))
      problems.push(`raw setSection at line ${i + 1}: ${line.trim()}`);
  }
  if (pending !== 1) problems.push(`pending landing raw sites: ${pending}`);
  if (fallback !== 1) problems.push(`fallback raw sites: ${fallback}`);
  if (/pickSection\(pendingPrSection\)/.test(text))
    problems.push("the pending landing notes interaction");
  if (/setSection=\{setSection\}/.test(text))
    problems.push("a child receives the raw setter");
  const calls = (text.match(/\bpickSection\(/g) ?? []).length;
  if (calls !== expected.userCalls)
    problems.push(
      `pickSection calls: ${calls}, expected ${expected.userCalls}`,
    );
  const props = (text.match(/setSection=\{pickSection\}/g) ?? []).length;
  if (props !== expected.userProps)
    problems.push(
      `pickSection props: ${props}, expected ${expected.userProps}`,
    );
  return problems;
}

for (const [file, expected] of Object.entries(VIEWS)) {
  test(`${file}: user section picks note interaction, corrections stay silent`, () => {
    assert.deepEqual(audit(read(file), expected), []);
  });
}

test("mutation control: a reverted section button fails the pin", () => {
  const file = "src/features/pulls/RemotePrView.tsx";
  const source = read(file);
  const reverted = source.replace(
    "onClick={() => pickSection(s)}",
    "onClick={() => setSection(s)}",
  );
  assert.notEqual(reverted, source, "mutation target not found");
  assert.notDeepEqual(audit(reverted, VIEWS[file]), []);
});

test("mutation control: a noting pending landing fails the pin", () => {
  const file = "src/features/pulls/LocalPrView.tsx";
  const source = read(file);
  const noted = source.replace(
    "setSection(pendingPrSection);",
    "pickSection(pendingPrSection);",
  );
  assert.notEqual(noted, source, "mutation target not found");
  assert.notDeepEqual(audit(noted, VIEWS[file]), []);
});

test("mutation control: a helper that skips the note fails the pin", () => {
  const file = "src/features/pulls/LocalPrView.tsx";
  const source = read(file).replace(/\r\n/g, "\n");
  const silent = source.replace(
    "    useUiStore.getState().noteUserInteraction();\n    setSection(next);",
    "    setSection(next);",
  );
  assert.notEqual(silent, source, "mutation target not found");
  assert.notDeepEqual(audit(silent, VIEWS[file]), []);
});

// File picks follow the same rule: each component's local `pickPath` notes the
// interaction before the set, and its automatic selections (a reset when the PR
// on screen changes, the conflict views' walk and keep-valid effect) stay raw.
// The children handed `pickPath` call it only from a click or a keyboard
// activation, so no automatic call can reach the helper through a prop.
const FILE_PICKS = {
  "src/features/pulls/PrCommitDetail.tsx": {
    // The file row's keyboard activation and click.
    userCalls: 2,
    // The commit comments' path chip.
    userProps: 1,
    automatic: [],
  },
  "src/features/pulls/RemotePrView.tsx": {
    userCalls: 0,
    // The Files section's pane.
    userProps: 1,
    automatic: [/^\s*setSelectedPath\(null\);$/],
  },
  "src/features/pulls/ResolveConflictsView.tsx": {
    userCalls: 2,
    userProps: 0,
    automatic: [
      /^\s*setSelectedPath\(walkActive\);$/,
      /^\s*setSelectedPath\(\(cur\) => \{$/,
    ],
  },
  "src/features/pulls/ResolveRemotePrView.tsx": {
    userCalls: 2,
    userProps: 0,
    automatic: [
      /^\s*setSelectedPath\(walkActive\);$/,
      /^\s*setSelectedPath\(\(cur\) => \{$/,
    ],
  },
};

const PATH_HELPER =
  /const pickPath = \(path: string\) => \{\n\s*useUiStore\.getState\(\)\.noteUserInteraction\(\);\n\s*setSelectedPath\(path\);\n\s*\};/;
const PATH_HELPER_SET = /^\s*setSelectedPath\(path\);$/;

/** The file-pick pin's verdict over one component's source. */
function auditPaths(source, expected) {
  const text = source.replace(/\r\n/g, "\n");
  const problems = [];
  if (!PATH_HELPER.test(text))
    problems.push("pickPath helper missing or reshaped");
  const seen = expected.automatic.map(() => 0);
  for (const [i, line] of text.split("\n").entries()) {
    if (!/\bsetSelectedPath\(/.test(line)) continue;
    if (PATH_HELPER_SET.test(line)) continue;
    const at = expected.automatic.findIndex((re) => re.test(line));
    if (at === -1)
      problems.push(`raw setSelectedPath at line ${i + 1}: ${line.trim()}`);
    else seen[at] += 1;
  }
  for (const [i, n] of seen.entries())
    if (n !== 1) problems.push(`automatic site ${i}: ${n} matches`);
  if (/=\{setSelectedPath\}/.test(text))
    problems.push("a child receives the raw setter");
  const calls = (text.match(/\bpickPath\(/g) ?? []).length;
  if (calls !== expected.userCalls)
    problems.push(`pickPath calls: ${calls}, expected ${expected.userCalls}`);
  const props = (text.match(/=\{pickPath\}/g) ?? []).length;
  if (props !== expected.userProps)
    problems.push(`pickPath props: ${props}, expected ${expected.userProps}`);
  return problems;
}

// Every call a child makes through the prop it is handed `pickPath` on.
const PICK_PROP_CHILDREN = {
  "src/features/pulls/RemotePrViewParts.tsx": {
    prop: "onSelectPath",
    calls: [
      /^\s*onActivate: \(file\) => onSelectPath\(file\.path\),$/,
      /^\s*onClick=\{\(\) => onSelectPath\(file\.path\)\}$/,
    ],
  },
  "src/features/pulls/CommitComments.tsx": {
    prop: "onSelectFile",
    calls: [/^\s*onClick=\{\(\) => onSelectFile\(path\)\}$/],
  },
};

/** Problems with a child's calls through its pick prop: each must be one of
 *  the listed user routes, each route present exactly once. */
function auditChild(source, { prop, calls }) {
  const text = source.replace(/\r\n/g, "\n");
  const problems = [];
  const seen = calls.map(() => 0);
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.includes(`${prop}(`)) continue;
    const at = calls.findIndex((re) => re.test(line));
    if (at === -1) problems.push(`unlisted ${prop} call at line ${i + 1}`);
    else seen[at] += 1;
  }
  for (const [i, n] of seen.entries())
    if (n !== 1) problems.push(`${prop} route ${i}: ${n} matches`);
  return problems;
}

for (const [file, expected] of Object.entries(FILE_PICKS)) {
  test(`${file}: user file picks note interaction, automatic ones stay silent`, () => {
    assert.deepEqual(auditPaths(read(file), expected), []);
  });
}

for (const [file, spec] of Object.entries(PICK_PROP_CHILDREN)) {
  test(`${file}: ${spec.prop} is called only from user routes`, () => {
    assert.deepEqual(auditChild(read(file), spec), []);
  });
}

test("mutation control: a reverted file row click fails the pin", () => {
  const file = "src/features/pulls/PrCommitDetail.tsx";
  const source = read(file);
  const reverted = source.replace(
    "onClick={() => pickPath(file.path)}",
    "onClick={() => setSelectedPath(file.path)}",
  );
  assert.notEqual(reverted, source, "mutation target not found");
  assert.notDeepEqual(auditPaths(reverted, FILE_PICKS[file]), []);
});

test("mutation control: a noting PR-change reset fails the pin", () => {
  const file = "src/features/pulls/RemotePrView.tsx";
  const source = read(file);
  const noted = source.replace("setSelectedPath(null);", "pickPath(null);");
  assert.notEqual(noted, source, "mutation target not found");
  assert.notDeepEqual(auditPaths(noted, FILE_PICKS[file]), []);
});

test("mutation control: a noting conflict walk fails the pin", () => {
  const file = "src/features/pulls/ResolveConflictsView.tsx";
  const source = read(file);
  const noted = source.replace(
    "setSelectedPath(walkActive);",
    "pickPath(walkActive);",
  );
  assert.notEqual(noted, source, "mutation target not found");
  assert.notDeepEqual(auditPaths(noted, FILE_PICKS[file]), []);
});

test("mutation control: a file helper that skips the note fails the pin", () => {
  const file = "src/features/pulls/ResolveRemotePrView.tsx";
  const source = read(file).replace(/\r\n/g, "\n");
  const silent = source.replace(
    "    useUiStore.getState().noteUserInteraction();\n    setSelectedPath(path);",
    "    setSelectedPath(path);",
  );
  assert.notEqual(silent, source, "mutation target not found");
  assert.notDeepEqual(auditPaths(silent, FILE_PICKS[file]), []);
});

test("mutation control: an automatic call through a child's pick prop fails the pin", () => {
  const file = "src/features/pulls/RemotePrViewParts.tsx";
  const source = read(file).replace(/\r\n/g, "\n");
  const auto = source.replace(
    "    onActivate: (file) => onSelectPath(file.path),",
    "    onActivate: (file) => onSelectPath(file.path),\n    onFocus: () => onSelectPath(files[0].path),",
  );
  assert.notEqual(auto, source, "mutation target not found");
  assert.notDeepEqual(auditChild(auto, PICK_PROP_CHILDREN[file]), []);
});
