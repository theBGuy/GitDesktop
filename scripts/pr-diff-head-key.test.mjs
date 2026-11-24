// Pins the head-keyed PR diff's call sites: every `prDiffOptions(` call passes
// the head, RemotePrView's two AI sites key on the shown record (number and
// head one record's), and the unanswered-head sentinel never leaves usePrDiff.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

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

/** The argument texts of the call whose `(` sits at `open`, split at depth 0. */
export function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const last = text.slice(start, i).trim();
        if (last !== "") args.push(last);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error(`unterminated call at ${open}`);
}

/** Every `prDiffOptions(` call outside its own definition, per file. */
export function diffOptionCalls(files) {
  const calls = [];
  for (const [file, text] of files) {
    for (const m of text.matchAll(/\bprDiffOptions\(/g)) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (/const\s+$/.test(before)) continue;
      calls.push({ file, args: callArgs(text, m.index + m[0].length - 1) });
    }
  }
  return calls;
}

const files = walk(SRC).map((f) => [
  f.replaceAll("\\", "/"),
  readFileSync(f, "utf8"),
]);

test("the corpus is readable", () => {
  assert.ok(files.length > 100, `read ${files.length} files under src/`);
});

test("every prDiffOptions call passes four arguments", () => {
  const calls = diffOptionCalls(files);
  assert.ok(calls.length >= 4, `found ${calls.length} calls`);
  for (const call of calls)
    assert.equal(call.args.length, 4, `${call.file}: ${call.args.join(", ")}`);
});

test("RemotePrView's two AI sites key on the shown record and its head", () => {
  const view = diffOptionCalls(files).filter((c) =>
    c.file.endsWith("features/pulls/RemotePrView.tsx"),
  );
  assert.equal(view.length, 2);
  for (const { args } of view) {
    assert.equal(args[1], "shownNumber");
    assert.match(args[3], /^prHeadSha\(/);
  }
});

test("the unanswered-head sentinel is private to usePrDiff", () => {
  const hits = files.flatMap(([file, text]) =>
    [...text.matchAll(/PR_DIFF_HEAD_UNANSWERED/g)].map((m) => ({
      file,
      index: m.index,
      text,
    })),
  );
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
        "g(prDiffOptions(r, [1, 2], { a: 1 }));\n",
    ],
  ];
  const calls = diffOptionCalls(fixture);
  assert.deepEqual(
    calls.map((c) => c.args),
    [
      ["r", "n", "l", "prHeadSha(p) ?? null"],
      ["r", "[1, 2]", "{ a: 1 }"],
    ],
  );
});
