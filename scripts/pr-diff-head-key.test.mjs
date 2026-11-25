// Pins the head-keyed PR diff's call sites: every `prDiffOptions(` call passes
// the head, RemotePrView's two AI sites key on the shown record (number and
// head one record's), and the unanswered-head sentinel never leaves usePrDiff.
// CONTRACT. Corpus: every .ts/.tsx under src/ outside src/test/, read on
// `maskNonCode` text (comments, strings and JSX text blanked, offsets kept),
// so no mention inside them counts. Each code mention of `prDiffOptions` is
// one of: a call (the name, then masked white space or a comment, an
// optional `?.`, then `(`; a member call `x.prDiffOptions(` included), whose
// arguments split at depth 0 of the masked text (a slot blank once masked,
// comments only or after a trailing comma, is no argument); its `const … =`
// definition; or a plain specifier in an `import {…}` / `export {…}` list.
// Any other mention (an alias, a renamed specifier, a value passed by name, a
// generic call) fails as unreadable. Out of sight: a spread argument
// (`prDiffOptions(...args)`, counted as one argument, so it fails the count);
// a generic type argument list inside a call argument (`getHead<A, B>(x)`,
// whose comma splits, so it fails closed on extra arguments); a namespace or default import read through another name; what each
// argument evaluates to beyond the two pinned AI sites' texts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { maskNonCode } from "./lib/ts-mask.mjs";

const ROOT = new URL("../src/", import.meta.url);
const SRC = decodeURIComponent(ROOT.pathname).replace(/^\/([A-Za-z]:)/, "$1");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") out.push(...walk(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** The argument texts of the call whose `(` sits at `open`, split at depth 0
 *  of `masked` (`text` with comments and strings blanked, offsets kept) and
 *  read back from `text`. A slot that is blank once masked (comments only, or
 *  the gap after a trailing comma) is no argument. */
export function callArgs(text, masked, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  const take = (end) => {
    if (masked.slice(start, end).trim() !== "")
      args.push(text.slice(start, end).trim());
  };
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        take(i);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      take(i);
      start = i + 1;
    }
  }
  throw new Error(`unterminated call at ${open}`);
}

/** Import and export lists (`import { … } from`, `export { … }`) in `masked`. */
const SPECIFIER_LISTS = /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}/g;

/** Every `prDiffOptions` call, per file, and every code mention the scan can't
 *  follow (`unread`). Matching and splitting read the masked text, so a
 *  mention in a comment or a string is no mention. */
export function diffOptionMentions(files) {
  const calls = [];
  const unread = [];
  for (const [file, text] of files) {
    const masked = maskNonCode(text, file.endsWith(".tsx"));
    const lists = [...masked.matchAll(SPECIFIER_LISTS)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    for (const m of masked.matchAll(/(?<![\w$])prDiffOptions(?![\w$])/g)) {
      const end = m.index + m[0].length;
      const call = /^\s*(?:\?\.\s*)?\(/.exec(masked.slice(end));
      if (call) {
        const open = end + call[0].length - 1;
        calls.push({ file, args: callArgs(text, masked, open) });
        continue;
      }
      const before = masked.slice(Math.max(0, m.index - 20), m.index);
      if (/\bconst\s+$/.test(before) && /^\s*=/.test(masked.slice(end))) {
        continue;
      }
      // A plain specifier: a renamed one would hide the calls under the alias.
      const inList = lists.some(([s, e]) => s < m.index && m.index < e);
      const spec = /^\s*(?:type\s+)?prDiffOptions\s*$/;
      const from = Math.max(
        masked.lastIndexOf(",", m.index),
        masked.lastIndexOf("{", m.index),
      );
      const to = /[,}]/.exec(masked.slice(end));
      if (inList && to && spec.test(masked.slice(from + 1, end + to.index))) {
        continue;
      }
      unread.push(`${file}:${text.slice(0, m.index).split("\n").length}`);
    }
  }
  return { calls, unread };
}

export const diffOptionCalls = (files) => diffOptionMentions(files).calls;

const files = walk(SRC).map((f) => [
  f.replaceAll("\\", "/"),
  readFileSync(f, "utf8"),
]);

test("the corpus is readable", () => {
  assert.ok(files.length > 100, `read ${files.length} files under src/`);
});

test("every prDiffOptions call passes four arguments", () => {
  const { calls, unread } = diffOptionMentions(files);
  assert.deepEqual(unread, [], "mentions the scan can't follow");
  assert.ok(calls.length >= 4, `found ${calls.length} calls`);
  for (const call of calls)
    assert.equal(call.args.length, 4, `${call.file}: ${call.args.join(", ")}`);
});

test("RemotePrView's two AI sites key on the shown record and its head", () => {
  const view = diffOptionCalls(files).filter((c) =>
    c.file.endsWith("features/pulls/RemotePrView.tsx"),
  );
  // Each site's head comes from the details record the view shows: `prForGen`
  // aliases `pr` (= details.data) for the Edit dialog's hoisted closure.
  assert.deepEqual(
    view.map(({ args }) => [args[1], args[3]]),
    [
      ["shownNumber", "prHeadSha(prForGen) ?? null"],
      ["shownNumber", "prHeadSha(pr) ?? null"],
    ],
  );
});

/** Every code mention of the sentinel, with its file's masked text, so a
 *  mention in a comment or a string is no mention. */
export function sentinelHits(files) {
  return files.flatMap(([file, text]) => {
    const masked = maskNonCode(text, file.endsWith(".tsx"));
    return [...masked.matchAll(/PR_DIFF_HEAD_UNANSWERED/g)].map((m) => ({
      file,
      index: m.index,
      text: masked,
    }));
  });
}

test("the unanswered-head sentinel is private to usePrDiff", () => {
  const hits = sentinelHits(files);
  const decls = hits.filter((h) =>
    /const\s+$/.test(h.text.slice(Math.max(0, h.index - 12), h.index)),
  );
  assert.equal(decls.length, 1);
  const [decl] = decls;
  assert.ok(decl.file.endsWith("lib/git/queries/prs.ts"));
  assert.doesNotMatch(
    decl.text.slice(Math.max(0, decl.index - 20), decl.index),
    /export/,
  );
  const start = decl.text.indexOf("export function usePrDiff(");
  assert.ok(start > 0, "usePrDiff is declared");
  const end = decl.text.indexOf("\nexport ", start + 1);
  const reads = hits.filter((h) => h !== decl);
  assert.ok(reads.length >= 1);
  for (const read of reads) {
    assert.equal(read.file, decl.file);
    assert.ok(read.index > start && read.index < end, "read inside usePrDiff");
  }
});

test("fixtures: the splitter and the definition skip", () => {
  const fixture = [
    [
      "a.ts",
      "export const prDiffOptions = (a, b) => 1;\n" +
        "f(prDiffOptions(r, n, l, prHeadSha(p) ?? null));\n" +
        "g(prDiffOptions(r, [1, 2], { a: 1 }));\n" +
        'h(prDiffOptions(r, /* old, new */ n, "a,(b", // x, y)\n  head));\n',
    ],
  ];
  const calls = diffOptionCalls(fixture);
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["r", "n", "l", "prHeadSha(p) ?? null"],
      ["r", "[1, 2]", "{ a: 1 }"],
      ["r", "/* old, new */ n", '"a,(b"', "// x, y)\n  head"],
    ],
  );
  // A slot holding only comments, or the gap after a trailing comma, is no
  // argument, so a call missing its head still counts three.
  for (const text of [
    "prDiffOptions(repo, n, lens, /* head pending */)",
    "prDiffOptions(repo, n, lens,)",
    "prDiffOptions(repo, n, lens, // head pending\n)",
    "prDiffOptions(repo, /* n */, n, lens)",
    "prDiffOptions(repo, n, lens /* head */, /* pending */ )",
  ]) {
    assert.deepEqual(
      diffOptionCalls([["a.ts", `${text};\n`]]).map((c) => c.args.length),
      [3],
      text,
    );
  }
});

test("fixtures: a mention in a comment, string or regex is no call", () => {
  const real = "f(prDiffOptions(r, n, l, h));\n";
  const mentions = {
    line: "// see prDiffOptions() for the head\n",
    block: "/* prDiffOptions(a, b) */\n",
    string: 'const s = "prDiffOptions(";\n',
    template: "const t = `prDiffOptions(${x}`;\n",
    regex: "const re = /prDiffOptions\\(/;\n",
  };
  for (const [name, mention] of Object.entries(mentions)) {
    for (const text of [mention + real, real + mention]) {
      assert.deepEqual(
        diffOptionCalls([["a.ts", text]]).map((c) => c.args),
        [["r", "n", "l", "h"]],
        name,
      );
    }
  }
  // A call inside a template's `${…}` is code, so it counts.
  const nested = "`${prDiffOptions(r, n, l, h).queryKey}`;\n";
  assert.deepEqual(
    diffOptionCalls([["a.ts", nested]]).map((c) => c.args),
    [["r", "n", "l", "h"]],
  );
  // Masked white space or a comment between the name and its `(` is a call.
  for (const gap of [
    " ",
    " /* cached */ ",
    "\n  ",
    " // x\n  ",
    "?.",
    " ?. ",
  ]) {
    assert.deepEqual(
      diffOptionCalls([["a.ts", `f(prDiffOptions${gap}(r, n, l));\n`]]).map(
        (c) => c.args,
      ),
      [["r", "n", "l"]],
      JSON.stringify(gap),
    );
  }
  const sentinel = [
    "// PR_DIFF_HEAD_UNANSWERED stays private\n",
    "/* const PR_DIFF_HEAD_UNANSWERED */\n",
    'const s = "PR_DIFF_HEAD_UNANSWERED";\n',
    "if (k === PR_DIFF_HEAD_UNANSWERED) f();\n",
  ].join("");
  assert.deepEqual(
    sentinelHits([["a.ts", sentinel]]).map((h) => h.index),
    [sentinel.indexOf("k === ") + 6],
  );
});

test("fixtures: a mention that is no call, definition or plain specifier fails closed", () => {
  const read = [
    "import { a, prDiffOptions } from './prs';\n",
    "import {\n  type prDiffOptions,\n  b,\n} from './prs';\n",
    "export { prDiffOptions } from './prs';\n",
    "export const prDiffOptions = (r) => r;\n",
    "q.prDiffOptions(r, n, l, h);\n",
  ];
  for (const text of read) {
    assert.deepEqual(diffOptionMentions([["a.ts", text]]).unread, [], text);
  }
  const unread = [
    "import { prDiffOptions as pdo } from './prs';\n",
    "const f = prDiffOptions;\n",
    "xs.map(prDiffOptions);\n",
    "prDiffOptions<Pr>(r, n, l, h);\n",
    "export { other, prDiffOptions as x };\n",
  ];
  for (const text of unread) {
    assert.deepEqual(
      diffOptionMentions([["a.ts", text]]).unread,
      ["a.ts:1"],
      text,
    );
  }
});
