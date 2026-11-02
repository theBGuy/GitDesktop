// Placement pin for History's CommitList element. CommitList is uncompiled
// (useVirtualizer), so a fresh element re-renders it; HistoryPanel's compiler
// cache for that element holds only when it is built outside the list ternary
// and after `deriveEditRange(`. This pins that PLACEMENT and nothing more: a
// later statement that passes `view` or `view.commits` into a call can still
// drop the cache while this stays green. The definitive check is the compiled
// output (an in-memory React Compiler run showing a cache guard around
// `<CommitList`), which this installless guards job can't run. Reads code only
// (comments and strings masked), fails closed on anything it can't find, and
// runs each check against in-memory mutated copies so a green suite proves
// each pin bites. Node built-ins only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { maskNonCode } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = "src/features/history/HistoryPanel.tsx";
const panelSource = () =>
  readFileSync(join(REPO_ROOT, PANEL), "utf8").replace(/\r\n/g, "\n");

const WHY =
  "this placement is what lets the compiler cache the element (built earlier, it is absorbed into `view`'s pruned scope); placement alone doesn't prove the cache, which only the compiled output can";

/** Every index of `needle` in `code`. */
function indicesOf(code, needle) {
  const out = [];
  for (let i = code.indexOf(needle); i >= 0; i = code.indexOf(needle, i + 1))
    out.push(i);
  return out;
}

const TERNARY_RENDERS = /:\s*\(?\s*commitList\s*\)?\s*\}/;

/** The masked code's landmarks, or the count problems that prevent reading
 *  them. Shared by the checker and the controls' anchors. */
function landmarks(src) {
  const code = maskNonCode(src, true);
  const derive = indicesOf(code, "deriveEditRange(");
  const build = indicesOf(code, "const commitList =");
  const elements = indicesOf(code, "<CommitList");
  const problems = [];
  if (derive.length !== 1)
    problems.push(
      `${PANEL}: expected one deriveEditRange( call, found ${derive.length}`,
    );
  if (build.length !== 1)
    problems.push(
      `${PANEL}: expected one \`const commitList =\`, found ${build.length}`,
    );
  if (elements.length !== 1)
    problems.push(
      `${PANEL}: expected one <CommitList element (the commitList construction), found ${elements.length}; ${WHY}`,
    );
  if (problems.length > 0) return { problems };
  // The construction statement runs to its first `;` at code level.
  const buildEnd = code.indexOf(";", build[0]);
  return {
    problems,
    code,
    derive: derive[0],
    build: build[0],
    buildEnd,
    element: elements[0],
  };
}

/** Problems with the CommitList element's placement; empty = pinned. Each
 *  entry starts with a tag naming the check that raised it. */
function checkCommitListOrder(src) {
  const at = landmarks(src);
  if (at.problems.length > 0) return at.problems.map((p) => `count: ${p}`);
  const problems = [];
  if (at.buildEnd < 0)
    problems.push(`span: ${PANEL}: \`const commitList =\` never ends`);
  if (at.build < at.derive)
    problems.push(
      `order: ${PANEL}: \`const commitList =\` must come after deriveEditRange(; ${WHY}`,
    );
  if (at.element < at.build || at.element > at.buildEnd)
    problems.push(
      `span: ${PANEL}: <CommitList must be built only in \`const commitList =\`; ${WHY}`,
    );
  if (!TERNARY_RENDERS.test(at.code))
    problems.push(
      `ternary: ${PANEL}: the list ternary must render \`commitList\`, not an inline element; ${WHY}`,
    );
  return problems;
}

/** Asserts `problems` is non-empty and every entry comes from `tag`'s check. */
function assertFailsOn(problems, tag, label) {
  assert.ok(problems.length > 0, `control: ${label} must fail`);
  assert.ok(
    problems.every((p) => p.startsWith(`${tag}:`)),
    `control: ${label} must fail on the ${tag} check, got ${JSON.stringify(problems)}`,
  );
}

/** Start of the line holding offset `i`. */
const lineStart = (src, i) => src.lastIndexOf("\n", i) + 1;

/** The `const commitList = (…);` statement's source span, whole lines. */
function constructionSpan(src) {
  const at = landmarks(src);
  assert.equal(at.problems.length, 0, "control premise: landmarks readable");
  const start = lineStart(src, at.build);
  const nl = src.indexOf("\n", at.buildEnd);
  return { at, start, end: nl < 0 ? src.length : nl + 1 };
}

test("the CommitList element is built after deriveEditRange and rendered by name", () => {
  const src = panelSource();
  assert.deepEqual(checkCommitListOrder(src), []);
  const { at, start, end } = constructionSpan(src);

  // Control: the construction moved above deriveEditRange's statement.
  const block = src.slice(start, end);
  const rest = src.slice(0, start) + src.slice(end);
  const deriveLine = lineStart(
    rest,
    maskNonCode(rest, true).indexOf("deriveEditRange("),
  );
  const moved = rest.slice(0, deriveLine) + block + rest.slice(deriveLine);
  assertFailsOn(
    checkCommitListOrder(moved),
    "order",
    "construction above deriveEditRange",
  );

  // Control: the ternary renders null instead of commitList.
  const match = TERNARY_RENDERS.exec(at.code);
  assert.ok(match, "control premise: ternary found");
  const name = match.index + match[0].indexOf("commitList");
  const nulled = `${src.slice(0, name)}null${src.slice(name + "commitList".length)}`;
  assertFailsOn(
    checkCommitListOrder(nulled),
    "ternary",
    "ternary renders null",
  );

  // Control: the element built in its own statement outside the construction,
  // which then only names it.
  const elementStart = at.element;
  const elementEnd = src.lastIndexOf("/>", at.buildEnd) + 2;
  assert.ok(elementEnd > elementStart, "control premise: element span found");
  const element = src.slice(elementStart, elementEnd);
  const outside =
    src.slice(0, start) +
    `  const commitListEl = ${element};\n` +
    src.slice(start, elementStart) +
    "commitListEl" +
    src.slice(elementEnd);
  assertFailsOn(
    checkCommitListOrder(outside),
    "span",
    "element outside the construction",
  );
});
