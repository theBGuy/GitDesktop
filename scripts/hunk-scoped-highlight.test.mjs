// Pins hunk-scoped highlighting (src/features/diff/gap-isolation.ts): a
// hunk-reconstructed buffer is tokenized per non-blank run, and the
// placeholder-skipping processAST keeps the syntax entries proportional to
// the hunk content rather than the padded buffer's length.
//
// The imports reach straight into `src/` under Node's type stripping. The
// static import is the dependency-free gap-isolation.ts, so the installless
// `guards` job runs the pure-logic suites; the vendor-parity and end-to-end
// suites load @git-diff-view/core and Shiki dynamically and skip only when one
// of those PACKAGES is unresolved. GD_EXPECT_DEPS turns that skip into a
// failure on an installed, enforced run.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gapIsolatedAst,
  HUNK_SCOPED_MAX_LINES,
  hunkScopedProcessAST,
  mergeSegments,
} from "../src/features/diff/gap-isolation.ts";

const DEP_PACKAGES =
  /Cannot find package '(@git-diff-view\/(core|lowlight)|lowlight|highlight\.js|@shikijs\/[\w-]+)'/;

let core;
let hljsGap;
let shiki;
let skip = false;
// Settled, not raced: EVERY failure must be a missing dep package, so a broken
// src module can't hide behind an absent package's earlier rejection.
const loads = await Promise.allSettled([
  import("@git-diff-view/core"),
  import("../src/features/diff/hljs-gap-isolation.ts"),
  import("../src/features/diff/shiki-highlighter.ts"),
]);
const failures = loads.filter((l) => l.status === "rejected");
if (failures.length === 0) {
  [core, hljsGap, shiki] = loads.map((l) => l.value);
} else {
  for (const { reason } of failures) {
    if (
      process.env.GD_EXPECT_DEPS ||
      reason?.code !== "ERR_MODULE_NOT_FOUND" ||
      !DEP_PACKAGES.test(String(reason?.message))
    )
      throw reason;
  }
  skip =
    "@git-diff-view/core / Shiki are not installed — the guards job runs " +
    "with no install step; an installed run with GD_EXPECT_DEPS enforces this";
}

/**
 * A Shiki-shaped stand-in tokenizer: one span per non-empty line, a bare "\n"
 * text node between lines. Records every segment it is handed, so a test can
 * assert how much text was actually tokenized.
 */
function fakeTokenizer() {
  const segments = [];
  const tokenize = (segment) => {
    segments.push(segment);
    const lines = segment.split("\n");
    const children = [];
    lines.forEach((line, i) => {
      if (line !== "") {
        children.push({
          type: "element",
          tagName: "span",
          properties: { className: ["tok"] },
          children: [{ type: "text", value: line }],
        });
      }
      if (i < lines.length - 1) children.push({ type: "text", value: "\n" });
    });
    return { type: "root", children };
  };
  return { tokenize, segments };
}

/** A padded buffer of `total` lines with `content` (1-based line -> text). */
function paddedBuffer(total, content) {
  const lines = new Array(total).fill("");
  for (const [lineNumber, text] of Object.entries(content)) {
    lines[Number(lineNumber) - 1] = text;
  }
  return { raw: lines.join("\n"), lines };
}

/** `count` content lines starting at 1-based `from`. */
function run(from, count, prefix = "line") {
  const content = {};
  for (let i = 0; i < count; i++) content[from + i] = `${prefix}${from + i};`;
  return content;
}

/** What the core's rawFile holds for a 1-based line: text plus its "\n". */
function rawLine(lines, lineNumber) {
  const text = lines[lineNumber - 1];
  return lineNumber < lines.length ? `${text}\n` : text;
}

/** Every entry's value matches the core's raw line (its dev-mode check). */
function assertEntriesMatchRaw(syntax, lines) {
  for (const entry of Object.values(syntax)) {
    assert.equal(entry.value, rawLine(lines, entry.lineNumber));
    assert.equal(entry.valueLength, entry.value.length);
  }
}

test("sparse buffer: entries track the 30 hunk lines, not 20,000", () => {
  const { raw, lines } = paddedBuffer(20_000, run(10_001, 30));
  const { tokenize, segments } = fakeTokenizer();
  const ast = gapIsolatedAst(raw, tokenize);

  assert.equal(segments.length, 1, "one contiguous run, one tokenize");
  assert.equal(segments[0].split("\n").length, 30);

  const { syntaxFileObject, syntaxFileLineNumber } = hunkScopedProcessAST(ast);
  const keys = Object.keys(syntaxFileObject).map(Number);
  // The 30 content lines plus at most one boundary entry per placeholder run
  // (the run's first "\n" and the empty start of the line after it).
  assert.ok(keys.length <= 30 + 2, `entries: ${keys.length}`);
  for (let n = 10_001; n <= 10_030; n++) {
    assert.ok(syntaxFileObject[n], `line ${n} has an entry`);
    assert.ok(
      syntaxFileObject[n].nodeList.some(
        (item) => item.wrapper?.properties?.className?.[0] === "tok",
      ),
      `line ${n} keeps its token span`,
    );
  }
  assert.equal(syntaxFileLineNumber, 20_000, "line count matches the buffer");
  assertEntriesMatchRaw(syntaxFileObject, lines);
});

test("a genuine blank line inside a hunk splits the run; both halves tokenize", () => {
  const content = { ...run(10_001, 10), ...run(10_012, 9) };
  const { raw, lines } = paddedBuffer(20_000, content);
  const { tokenize, segments } = fakeTokenizer();
  const ast = gapIsolatedAst(raw, tokenize);
  assert.equal(segments.length, 2);

  const { syntaxFileObject, syntaxFileLineNumber } = hunkScopedProcessAST(ast);
  for (const n of [10_001, 10_010, 10_012, 10_020]) {
    assert.ok(syntaxFileObject[n], `line ${n} tokenized`);
  }
  assert.equal(syntaxFileObject[10_011], undefined, "blank line renders plain");
  assert.equal(syntaxFileLineNumber, 20_000);
  assertEntriesMatchRaw(syntaxFileObject, lines);
});

test("empty buffer: no entries, one line", () => {
  const { tokenize } = fakeTokenizer();
  const ast = gapIsolatedAst("", tokenize);
  const { syntaxFileObject, syntaxFileLineNumber } = hunkScopedProcessAST(ast);
  assert.deepEqual(syntaxFileObject, {});
  assert.equal(syntaxFileLineNumber, 1);
  assert.deepEqual(hunkScopedProcessAST({ type: "root", children: [] }), {
    syntaxFileObject: {},
    syntaxFileLineNumber: 1,
  });
});

test("content on line 1 (no leading gap) keeps its first entries", () => {
  const content = { ...run(1, 5), ...run(106, 3) };
  const { raw, lines } = paddedBuffer(120, content);
  const { tokenize, segments } = fakeTokenizer();
  const ast = gapIsolatedAst(raw, tokenize);
  assert.equal(segments.length, 2, "holey buffer, two runs");

  const { syntaxFileObject, syntaxFileLineNumber } = hunkScopedProcessAST(ast);
  for (const n of [1, 2, 3, 4, 5, 106, 107, 108]) {
    assert.ok(syntaxFileObject[n], `line ${n} has an entry`);
  }
  assert.equal(syntaxFileObject[1].nodeList[0].node.startIndex, 0);
  assert.equal(syntaxFileObject[50], undefined, "placeholder skipped");
  assert.equal(syntaxFileLineNumber, 120);
  assertEntriesMatchRaw(syntaxFileObject, lines);
});

test("below-cap buffers: gap isolation unchanged, every line still indexed", () => {
  // A dense file is not holey: one whole-buffer tokenize, exactly as before.
  const dense = paddedBuffer(40, { ...run(1, 10), ...run(12, 20) });
  const a = fakeTokenizer();
  const b = fakeTokenizer();
  assert.deepEqual(
    gapIsolatedAst(dense.raw, a.tokenize),
    b.tokenize(dense.raw),
  );
  assert.equal(a.segments.length, 1);
  // Single-"\n" separators (Shiki's shape, genuine blank lines included) keep
  // an entry per line, so a non-holey buffer is indexed line for line.
  const { syntaxFileObject, syntaxFileLineNumber } = hunkScopedProcessAST(
    gapIsolatedAst(dense.raw, fakeTokenizer().tokenize),
  );
  assert.equal(Object.keys(syntaxFileObject).length, 40);
  assert.equal(syntaxFileLineNumber, 40);
  assertEntriesMatchRaw(syntaxFileObject, dense.lines);

  // A small holey buffer still segments through mergeSegments.
  const holey = paddedBuffer(200, run(100, 10));
  const viaGap = gapIsolatedAst(holey.raw, fakeTokenizer().tokenize);
  const viaMerge = mergeSegments(
    holey.raw,
    holey.lines,
    fakeTokenizer().tokenize,
  );
  assert.deepEqual(viaGap, viaMerge);
});

test("the per-object cap is unbounded", () => {
  assert.equal(HUNK_SCOPED_MAX_LINES > 1e12, true);
});

/** A processAST result reduced to comparable plain data. */
function summarize(syntax) {
  return Object.fromEntries(
    Object.entries(syntax).map(([k, entry]) => [
      k,
      {
        value: entry.value,
        lineNumber: entry.lineNumber,
        valueLength: entry.valueLength,
        nodes: entry.nodeList.map(({ node, wrapper }) => ({
          value: node.value,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          className: wrapper?.properties?.className?.join(" "),
        })),
      },
    ]),
  );
}

test("vendor parity: identical to core processAST except skipped blank lines", {
  skip,
}, () => {
  const engine = core.highlighter.getHighlighterEngine();
  // Real highlight.js output: multi-line comment and string nodes, nesting.
  const source = [
    "/** doc",
    " * more",
    " */",
    "export function f(a: number): string {",
    "  const s = `x${a}",
    "y`;",
    "  return s; // tail",
    "}",
  ].join("\n");
  const ast = engine.highlight("typescript", source);
  const vendor = core.processAST(structuredClone(ast));
  const ours = hunkScopedProcessAST(structuredClone(ast));
  assert.deepEqual(
    summarize(ours.syntaxFileObject),
    summarize(vendor.syntaxFileObject),
  );
  assert.equal(ours.syntaxFileLineNumber, vendor.syntaxFileLineNumber);

  // Holey: ours keeps every vendor entry that carries content, verbatim.
  const { raw } = paddedBuffer(400, run(200, 5, "const v"));
  const holeyAst = gapIsolatedAst(raw, (seg) =>
    engine.highlight("typescript", seg),
  );
  const v = summarize(
    core.processAST(structuredClone(holeyAst)).syntaxFileObject,
  );
  const o = summarize(
    hunkScopedProcessAST(structuredClone(holeyAst)).syntaxFileObject,
  );
  for (let n = 200; n <= 204; n++) assert.deepEqual(o[n], v[n]);
  for (const [k, entry] of Object.entries(v)) {
    if (!(k in o))
      assert.equal(entry.value, "\n", `only blank lines skipped (${k})`);
  }
  assert.ok(Object.keys(o).length < Object.keys(v).length / 10);
});

/** A unified diff whose single hunk sits at `start` (new side gains a line). */
function deepHunk(path, start, eol = "") {
  const content = [
    " const a = 1;",
    '-let b = "x";',
    '+let b = "y";',
    "+// added",
    " function f() {}",
  ].map((line) => line + eol);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},3 +${start},4 @@`,
    ...content,
    "",
  ].join("\n");
}

function diffFileFor(path, lang, start, eol = "") {
  const file = core.DiffFile.createInstance({
    oldFile: { fileName: path, fileLang: lang, content: null },
    newFile: { fileName: path, fileLang: lang, content: null },
    hunks: [deepHunk(path, start, eol)],
  });
  file.initRaw();
  return file;
}

test("past the singleton cap, hljs hunks keep their colors", { skip }, () => {
  core.highlighter.setMaxLineToIgnoreSyntax(15_000);
  const start = 30_001;

  // Control: the capped singleton skips the deep hunk outright.
  const control = diffFileFor("big.ts", "typescript", start);
  control.initSyntax();
  assert.equal(control.getNewSyntaxLine(start + 1), undefined);

  const file = diffFileFor("big.ts", "typescript", start);
  file.initSyntax({ registerHighlighter: hljsGap.hunkScopedHljsHighlighter });
  const line = file.getNewSyntaxLine(start + 1);
  assert.ok(line, "deep hunk line has syntax");
  assert.ok(
    line.nodeList.some((n) =>
      n.wrapper?.properties?.className?.includes("hljs-keyword"),
    ),
  );
  const entries = Object.keys(file.getBundle().newFileSyntaxLines).length;
  assert.ok(entries <= 4 + 2, `entries ∝ hunk: ${entries}`);
});

test("past the cap, an unregistered hljs language renders plain and bounded", {
  skip,
}, () => {
  const start = 30_001;
  const file = diffFileFor("big.gdx", "gd-not-a-language", start);
  file.initSyntax({ registerHighlighter: hljsGap.hunkScopedHljsHighlighter });
  const line = file.getNewSyntaxLine(start + 1);
  assert.ok(line, "deep hunk line is indexed");
  assert.ok(
    line.nodeList.every((n) => n.wrapper === undefined),
    "no tokens",
  );
  const syntax = file.getBundle().newFileSyntaxLines;
  assert.ok(Object.keys(syntax).length <= 4 + 2);
  // The core's dev check compares these; a bare empty root reports 1.
  const result = file._getFullBundle().newFileResult;
  assert.equal(result.syntaxLength, result.rawLength);
});

test("past the singleton cap, Shiki hunks keep their colors", {
  skip,
}, async () => {
  assert.equal(await shiki.ensureBuiltinShikiLang("tsx"), true);
  const start = 30_001;
  const file = diffFileFor("big.tsx", "tsx", start);
  file.initSyntax({ registerHighlighter: shiki.shikiDiffHighlighter() });
  const line = file.getNewSyntaxLine(start + 1);
  assert.ok(line, "deep hunk line has syntax");
  assert.ok(
    line.nodeList.some((n) =>
      String(n.wrapper?.properties?.style).includes("var(--gd-syn-keyword)"),
    ),
  );
  const entries = Object.keys(file.getBundle().newFileSyntaxLines).length;
  assert.ok(entries <= 4 + 2, `entries ∝ hunk: ${entries}`);
});

// CRLF content lines keep their "\r" in the padded buffer while Shiki strips it
// from each line break; a tree that dropped it would fail mergeSegments' length
// check and fall back to tokenizing the whole buffer (one entry per line).
test("CRLF hunks stay hunk-scoped on the Shiki path", { skip }, async () => {
  assert.equal(await shiki.ensureBuiltinShikiLang("tsx"), true);
  // New side: 4 hunk lines, plus line 1 (the leading run's first "\n") and the
  // empty final line — 6 entries, against one per buffer line on the fallback.
  for (const start of [30_001, 101]) {
    const file = diffFileFor("big.tsx", "tsx", start, "\r");
    file.initSyntax({ registerHighlighter: shiki.shikiDiffHighlighter() });
    const line = file.getNewSyntaxLine(start + 1);
    assert.ok(line, `line ${start + 1} has syntax`);
    assert.ok(
      line.nodeList.some((n) =>
        String(n.wrapper?.properties?.style).includes("var(--gd-syn-keyword)"),
      ),
    );
    assert.equal(line.value, 'let b = "y";\r\n');
    const syntax = file.getBundle().newFileSyntaxLines;
    const entries = Object.keys(syntax).length;
    assert.ok(entries <= 4 + 2, `start ${start}: entries ∝ hunk: ${entries}`);
    const { rawFile } = file._getFullBundle().newFileResult;
    for (const entry of Object.values(syntax)) {
      assert.equal(entry.value, rawFile[entry.lineNumber]);
    }
  }
});
