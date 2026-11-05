// Guards src/ against SHA-1-only object-id reads: a full commit id is 40 hex in
// a SHA-1 repo and 64 in a SHA-256 one, and git's "no ref" marker is all zeros at
// either width. A line fails when it carries (a) a fixed-width-40 regex quantifier
// with no {64} alternative on the same line, (b) a 40-zero literal, the regex text
// 0{40} / 0{40,}, or "0".repeat(40), whatever else the line says, or (c) a length
// compared against 40. Out of reach: slice/substring widths (`slice(0, 40)`; test
// fixtures legitimately cut ids that way), a width held in a named constant, and
// a shape split across lines. The walk fails closed on an empty corpus, an
// unreadable file, or a missing anchor file.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const ANCHOR = "src/lib/git/queries/workingtree.ts";

/** Reviewed exceptions: repo-relative path + the exact trimmed line. */
const ALLOWLIST = [];

// The quantified atom is a class, group, word char, `.`, or a braced escape
// (`\p{…}`, `\u{…}`); never a bare `}`, which would read JSX like `{a}{40}`.
const FIXED_40 = /(?<=[\])a-zA-Z0-9.]|\\[pPu]\{[^}]*\})\{40(?:,\d*)?\}/;
const ZEROS_40 = /0{40}|0\{40(?:,\d*)?\}|["'`]0["'`]\s*\.repeat\(\s*40\s*\)/;
const LENGTH_40 = /\.length\s*[!=]==?\s*40\b|\b40\s*[!=]==?\s*[\w.]+\.length\b/;
const REMEDY =
  "accept both widths: `{40}|{64}`, or test zeros width-free, e.g. `/^0+$/`";

/** Every arm a line trips, in check order; empty when clean. */
function offendingArms(line) {
  const arms = [];
  if (FIXED_40.test(line) && !line.includes("{64}"))
    arms.push("fixed-width-40");
  if (ZEROS_40.test(line)) arms.push("40-zero literal");
  if (LENGTH_40.test(line)) arms.push("length-40");
  return arms;
}

function scan() {
  const files = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => relative(ROOT, join(SRC, f)).split(sep).join("/"));
  assert.ok(files.length > 0, "the src/ walk found no .ts/.tsx files");
  assert.ok(files.includes(ANCHOR), `anchor ${ANCHOR} missing from the scan`);
  const hits = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      const arms = offendingArms(line);
      if (arms.length > 0) {
        hits.push({
          file,
          line: i + 1,
          text: line.trim(),
          arm: arms.join(", "),
        });
      }
    });
  }
  return hits;
}

test("no fixed-width SHA-1 object-id read in src/", () => {
  const hits = scan();
  const allowed = (h) =>
    ALLOWLIST.some((a) => a.path === h.file && a.line === h.text);
  for (const a of ALLOWLIST) {
    assert.ok(
      hits.some((h) => h.file === a.path && h.text === a.line),
      `stale allowlist entry: ${a.path}: ${a.line}`,
    );
  }
  const bad = hits.filter((h) => !allowed(h));
  assert.deepEqual(
    bad.map((h) => `${h.file}:${h.line} (${h.arm})`),
    [],
    `SHA-1-only object-id reads found; ${REMEDY}`,
  );
});

test("each arm flags its synthetic offender", () => {
  const zeros = "0".repeat(40);
  const W = "fixed-width-40";
  const Z = "40-zero literal";
  const L = "length-40";
  for (const [line, arms] of [
    ["const FULL = /^[0-9a-f]{40}$/i;", [W]],
    [String.raw`const LONG = /\d{40,}/;`, [W]],
    [String.raw`const HEX = /^\p{AHex}{40}$/u;`, [W]],
    [String.raw`const ZERO = /^\u{30}{40}$/u;`, [W]],
    [`const z = "${zeros}";`, [Z]],
    ['const z = "0".repeat(40);', [Z]],
    ["const Z = /^0{40}$/;", [W, Z]],
    ["const NULL = /^0{40}$/; // SHA-256 ids are {64}", [Z]],
    ["const NULLS = /^0{40,}$/; // {64}", [Z]],
    ["if (sha.length !== 40) return null;", [L]],
    ["return oid.length === 40;", [L]],
    ["if (id.length != 40) return;", [L]],
    ["const full = sha.length == 40;", [L]],
    ["if (40 === sha.length) return sha;", [L]],
  ]) {
    assert.deepEqual(offendingArms(line), arms, `arms for: ${line}`);
  }
});

test("width-free and non-oid lines pass", () => {
  for (const line of [
    "export const FULL_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;",
    "<Icon size={40} />",
    "<Row label={a}{40} />",
    "return !/^0+$/.test(hash);",
    "if (rows.length === 400) return;",
    "if (sha.length >= 40) return sha;",
  ]) {
    assert.deepEqual(offendingArms(line), [], `flagged: ${line}`);
  }
});
