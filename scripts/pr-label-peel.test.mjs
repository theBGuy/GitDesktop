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

test("trailing sentence punctuation neither hides a label nor fakes an answer", () => {
  for (const [trailer, want] of [
    ["Labels: None.", []],
    ["- Labels: `none`.", []],
    ["Labels: n/a!", []],
    ["Labels: bug.", ["bug"]],
    ["**Labels:** `bug`;", ["bug"]],
  ]) {
    const d = extractPrDraft(draft(trailer), LABELS);
    assert.deepEqual(d.labels, want, trailer);
    assert.deepEqual(d.droppedLabels, [], trailer);
    assert.equal(d.labelsLine, true, trailer);
  }
  // A real label ending in punctuation matches at the raw tier, first.
  const d = extractPrDraft(draft("Labels: v2.0!, v2.0"), ["v2.0!", "v2.0"]);
  assert.deepEqual(d.labels, ["v2.0!", "v2.0"]);
  // An unknown name is reported edge-unwrapped, punctuation kept.
  const unknown = extractPrDraft(draft("Labels: made-up."), LABELS);
  assert.deepEqual(unknown.droppedLabels, ["made-up."]);
});

test("trailing punctuation resolves on Closes and Relates values too", () => {
  const d = extractPrDraft(
    draft("Closes: #12.\nRelates: ABC-12., #34!"),
    LABELS,
    [12, 34],
    ["ABC-12"],
  );
  assert.deepEqual(d.closes, [12]);
  assert.deepEqual(d.relates, [34]);
  assert.deepEqual(d.jiraMentions, ["ABC-12"]);
  const wrapped = extractPrDraft(
    draft("Closes: `#12`.\nRelates: `ABC-12`;"),
    LABELS,
    [12],
    ["ABC-12"],
  );
  assert.deepEqual(wrapped.closes, [12]);
  assert.deepEqual(wrapped.jiraMentions, ["ABC-12"]);
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
    // A keyword closer spent BEFORE the colon is never taken again from the value.
    ["__Labels__: __init__", ["__init__"]],
  ]) {
    const d = extractPrDraft(draft(trailer), repo);
    assert.deepEqual(d.labels, want, trailer);
    assert.deepEqual(d.droppedLabels, [], trailer);
    assert.equal(d.body, "Guards the null path.", trailer);
  }
});

test("two nested keyword wrappers close on either side of the colon", () => {
  for (const [trailer, want] of [
    ["**`Labels:`** bug", ["bug"]],
    ["**`Labels`**: bug", ["bug"]],
    ["`Labels:` bug", ["bug"]],
    // Nesting on the keyword never reaches the value, which stays raw.
    ["**`Labels:`** area__parser", ["area__parser"]],
    ["**`Labels`**: area__parser", ["area__parser"]],
  ]) {
    const d = extractPrDraft(draft(trailer), ["bug", "area__parser"]);
    assert.deepEqual(d.labels, want, trailer);
    assert.equal(d.body, "Guards the null path.", trailer);
  }
});

// The reference recognizer: strip a list marker and EVERY markup marker anywhere in
// the line, then require the keyword and its colon. Global stripping would mangle
// markup inside values, so the parser can't use it, but it accepts any wrapper
// arrangement around the keyword, which makes it the definition of which lines are
// directives.
const MARKUP = /\*\*|__|`/g;
function referenceRecognizes(line) {
  const norm = line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(MARKUP, "")
    .trim();
  return /^(labels|closes|relates)\s*:\s*(.*)$/i.test(norm);
}

test("every wrapper combination matches the reference recognizer and keeps its value", () => {
  const markers = ["**", "__", "`"];
  const wrappers = [{ open: "", before: "", after: "" }];
  for (const m of markers) {
    wrappers.push({ open: m, before: m, after: "" });
    wrappers.push({ open: m, before: "", after: m });
  }
  for (const outer of markers)
    for (const inner of markers) {
      if (outer === inner) continue;
      const close = `${inner}${outer}`;
      wrappers.push({ open: `${outer}${inner}`, before: close, after: "" });
      wrappers.push({ open: `${outer}${inner}`, before: "", after: close });
    }
  const keywords = ["Labels", "Closes", "Relates"];
  const bullets = ["", "- "];
  // value -> what it denotes on each kind: `label` the repo name (null: an
  // abstention or no answer; absent: not a label, unchecked), `answered` the
  // Labels line's `labelsLine` (default true), `issue` a candidate number on a
  // Closes/Relates line, `jira` a candidate key on a Relates line.
  const values = new Map([
    ["bug", { label: "bug" }],
    ["area__parser", { label: "area__parser" }],
    ["__init__", { label: "__init__" }],
    ["`code`", { label: "code" }],
    ['"quoted"', { label: "quoted" }],
    ["**bold**", { label: "bold" }],
    ["MY_PROJ-7", { label: "MY_PROJ-7", jira: "MY_PROJ-7" }],
    ["none", { label: null }],
    ["none.", { label: null }],
    ["bug.", { label: "bug" }],
    ["MY_PROJ-7.", { label: "MY_PROJ-7", jira: "MY_PROJ-7" }],
    ["#12", { issue: 12 }],
    ["#12.", { issue: 12 }],
    ["`#12`.", { issue: 12 }],
    // No answer at all: nothing resolves, so `labelsLine` stays false.
    ["", { label: null, answered: false }],
    ["**", { label: null, answered: false }],
  ]);
  const repo = ["bug", "area__parser", "__init__", "code", "quoted", "bold"];
  const failures = [];
  let cases = 0;
  for (const w of wrappers)
    for (const kw of keywords)
      for (const bullet of bullets)
        for (const [value, want] of values) {
          cases++;
          const line = `${bullet}${w.open}${kw}${w.before}:${w.after} ${value}`;
          const d = extractPrDraft(
            draft(line),
            [...repo, "MY_PROJ-7"],
            [12],
            ["MY_PROJ-7"],
          );
          const recognized = d.body === "Guards the null path.";
          if (recognized !== referenceRecognizes(line)) {
            failures.push(`recognition: ${line}`);
            continue;
          }
          if (!recognized) continue;
          if (kw === "Labels" && "label" in want) {
            const labels = want.label === null ? [] : [want.label];
            if (JSON.stringify(d.labels) !== JSON.stringify(labels))
              failures.push(`labels ${JSON.stringify(d.labels)}: ${line}`);
            if (d.droppedLabels.length > 0)
              failures.push(`dropped ${d.droppedLabels}: ${line}`);
          }
          if (kw === "Labels" && d.labelsLine !== (want.answered ?? true))
            failures.push(`labelsLine ${d.labelsLine}: ${line}`);
          if (kw !== "Labels" && want.issue !== undefined) {
            const got = kw === "Closes" ? d.closes : d.relates;
            if (JSON.stringify(got) !== JSON.stringify([want.issue]))
              failures.push(`issue ${JSON.stringify(got)}: ${line}`);
          }
          if (kw === "Relates" && want.jira !== undefined) {
            if (JSON.stringify(d.jiraMentions) !== JSON.stringify([want.jira]))
              failures.push(`jira ${d.jiraMentions}: ${line}`);
          }
        }
  // 19 wrapper shapes x 3 keywords x 2 bullet forms x 16 values: a generator that
  // silently truncates fails here rather than passing on fewer cases.
  const expected =
    wrappers.length * keywords.length * bullets.length * values.size;
  console.log(`wrapper-combination cases: ${cases}`);
  assert.equal(wrappers.length, 19);
  assert.ok(cases >= expected && expected === 1824, `${cases} of ${expected}`);
  assert.deepEqual(failures, []);
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
    "**`Labels",
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

test("a Labels line counts only when it resolves to an answer", () => {
  for (const [trailer, answered] of [
    ["Labels:", false],
    ["Labels: **", false],
    ["**Labels:** ``", false],
    ["Labels: none", true],
    ["Labels: bug", true],
    ["Labels: madeup", true],
  ]) {
    const d = extractPrDraft(draft(trailer), LABELS);
    assert.equal(d.labelsLine, answered, trailer);
    // The line is peeled either way; only the answer is in question.
    assert.equal(d.body, "Guards the null path.", trailer);
    assert.equal(
      needsStructuredLabelPick(d, LABELS, false),
      !answered,
      `pick eligibility: ${trailer}`,
    );
  }
  assert.deepEqual(
    extractPrDraft(draft("Labels: madeup"), LABELS).droppedLabels,
    ["madeup"],
  );
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
