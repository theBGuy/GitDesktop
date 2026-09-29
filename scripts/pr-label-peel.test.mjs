// Pins how a PR draft's trailing `Labels:` line is read. The prompt makes the line
// REQUIRED (`Labels: none` when nothing fits), so the parser has to find it in the
// shapes models actually wrap it in, and has to report whether it found one at
// all: a draft with no line is a format failure the structured label pick
// catches, while `Labels: none` is a real abstention it must leave alone.
//
// `src/lib/ai/prompt.ts` imports its siblings extensionless, which Node's type
// stripping cannot resolve, so the shared src hooks go in first and the import is
// dynamic (a static one links before the hooks exist). The graph reaches no bare
// packages, so this suite also runs in the no-install `guards` job.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { extractPrDraft, needsStructuredLabelPick } = await import(
  "@/lib/ai/prompt"
);

const LABELS = ["bug", "enhancement", "Needs Review"];
const draft = (trailer) =>
  `Fix the crash\n\nGuards the null path.\n\n${trailer}`;

test("every tolerated Labels spelling yields the repo label and leaves the body clean", () => {
  for (const trailer of [
    "Labels: bug",
    "**Labels:** bug",
    "**Labels**: bug",
    "__Labels:__ bug",
    "`Labels:` bug",
    '- Labels: "bug"',
    "* Labels: 'bug'",
    "Labels: `bug`",
    "Labels: **bug**",
    "Labels: “bug”",
  ]) {
    const d = extractPrDraft(draft(trailer), LABELS);
    assert.deepEqual(d.labels, ["bug"], trailer);
    assert.deepEqual(d.droppedLabels, [], trailer);
    assert.equal(d.labelsLine, true, trailer);
    assert.equal(d.body, "Guards the null path.", trailer);
    assert.equal(d.title, "Fix the crash", trailer);
  }
});

test("Labels: none is a silent abstention, not a missing line", () => {
  for (const trailer of [
    "Labels: none",
    "**Labels:** none",
    "- Labels: `none`",
  ]) {
    const d = extractPrDraft(draft(trailer), LABELS);
    assert.deepEqual(d.labels, [], trailer);
    assert.deepEqual(d.droppedLabels, [], trailer);
    assert.equal(d.labelsLine, true, trailer);
    assert.equal(needsStructuredLabelPick(d, LABELS, false), false, trailer);
  }
});

test("wrapped names still validate case-insensitively into the repo's casing", () => {
  const d = extractPrDraft(
    draft('**Labels:** "needs review", `ENHANCEMENT`, "made-up"'),
    LABELS,
  );
  assert.deepEqual(d.labels, ["Needs Review", "enhancement"]);
  assert.deepEqual(d.droppedLabels, ["made-up"]);
});

test("markup inside a label name survives: raw first, then edge wrappers only", () => {
  const repo = ["bug", "area__parser", "__init__", "`code`"];
  for (const [trailer, want] of [
    ["Labels: area__parser", ["area__parser"]],
    ["Labels: **bug**", ["bug"]],
    ["Labels: `area__parser`", ["area__parser"]],
    ["**Labels:** area__parser, **bug**", ["area__parser", "bug"]],
    ["- Labels: `area__parser`", ["area__parser"]],
    // Names that themselves begin or end with a wrapper character match raw.
    ["Labels: __init__", ["__init__"]],
    ["Labels: `code`", ["`code`"]],
  ]) {
    const d = extractPrDraft(draft(trailer), repo);
    assert.deepEqual(d.labels, want, trailer);
    assert.deepEqual(d.droppedLabels, [], trailer);
    assert.equal(d.body, "Guards the null path.", trailer);
  }
});

test("a Jira key keeps its underscores and still unwraps", () => {
  const d = extractPrDraft(
    draft("Relates: `MY_PROJ-7`, **ABC-12**"),
    LABELS,
    [],
    ["MY_PROJ-7", "ABC-12"],
  );
  assert.deepEqual(d.jiraMentions, ["MY_PROJ-7", "ABC-12"]);
});

test("wrapped Closes/Relates lines peel alongside the Labels line", () => {
  const d = extractPrDraft(
    draft("**Labels:** bug\n**Closes:** #12\n- Relates: `34`"),
    LABELS,
    [12, 34],
  );
  assert.deepEqual(d.labels, ["bug"]);
  assert.deepEqual(d.closes, [12]);
  assert.deepEqual(d.relates, [34]);
  assert.equal(d.body, "Guards the null path.");
});

test("a streaming partial directive never renders, wrapped or not", () => {
  for (const partial of [
    "Labels",
    "**Labels",
    "- Labels",
    "**Labels:**",
    "`Labels:",
  ]) {
    const d = extractPrDraft(draft(partial), LABELS);
    assert.equal(d.body, "Guards the null path.", partial);
    assert.deepEqual(d.labels, [], partial);
  }
});

test("a prose final line is still body, and reports no Labels line", () => {
  const d = extractPrDraft(draft("- Adds **labels** to the picker"), LABELS);
  assert.match(d.body, /Adds \*\*labels\*\* to the picker$/);
  assert.equal(d.labelsLine, false);
});

test("the structured pick fires only on a missing line, with labels, on an API provider", () => {
  const missing = extractPrDraft(draft("Thanks!"), LABELS);
  assert.equal(missing.labelsLine, false);
  assert.equal(needsStructuredLabelPick(missing, LABELS, false), true);
  // CLI providers have no structured-output call.
  assert.equal(needsStructuredLabelPick(missing, LABELS, true), false);
  // A repo with no labels (or only blank names) has nothing to pick from.
  assert.equal(needsStructuredLabelPick(missing, [], false), false);
  assert.equal(needsStructuredLabelPick(missing, ["  "], false), false);
  // A line that named only unknown labels was an answer, not a skip.
  const dropped = extractPrDraft(draft("Labels: made-up"), LABELS);
  assert.equal(needsStructuredLabelPick(dropped, LABELS, false), false);
  // A line that landed a label needs nothing more.
  const landed = extractPrDraft(draft("Labels: bug"), LABELS);
  assert.equal(needsStructuredLabelPick(landed, LABELS, false), false);
});
