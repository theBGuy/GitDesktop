#!/usr/bin/env node
// A node suite that reads GD_EXPECT_DEPS skips without node_modules (the
// installless guards job) and relies on frontend.yml's installed step, which
// sets that variable, as its enforced run; so that step must list it, or the
// suite's skipped tests run in no CI job at all. This gate needs only Node
// stdlib because CI runs it before installing anything.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { maskNonCode, ScanError } from "./lib/ts-mask.mjs";

/** What every installed-only suite reads to turn a missing dependency into a
 *  failure. Reading it marks a suite the enforced step must list, however the
 *  suite words its skip. */
export const CARRIER_TOKEN = "process.env.GD_EXPECT_DEPS";

const VAR = "GD_EXPECT_DEPS";
const ENV = String.raw`(?<![\w$.])process\s*\??\.\s*env`;
const DOT_READ = new RegExp(String.raw`${ENV}\s*\??\.\s*${VAR}(?![\w$])`, "g");
const BRACKET_OPEN = new RegExp(String.raw`${ENV}\s*(?:\?\.)?\s*\[\s*`, "g");
const DESTRUCTURE = new RegExp(
  String.raw`\{([^{}]*)\}\s*=\s*${ENV}(?![\w$])`,
  "g",
);
const BARE_VAR = new RegExp(String.raw`(?<![\w$])${VAR}(?![\w$])`, "g");
const QUOTED_VAR = new RegExp(String.raw`(['"\x60])${VAR}\1`, "g");
const QUOTED_KEY_AT = new RegExp(String.raw`^(['"\x60])${VAR}\1`);

/**
 * Whether a suite reads GD_EXPECT_DEPS, judged on code only (comments and
 * string, template and regex text masked by maskNonCode, so a fixture string
 * can't make a carrier). Recognized reads: `process.env.X` with optional `?.`
 * and whitespace around the dots, `process.env[...]` with a ', " or ` quoted
 * key, and a destructured key from process.env. Only that key is recognized:
 * a renamed binding (`{ X: expect }`, default or not) reads cleanly, while a
 * shorthand one (`{ X }`, `{ X = "" }`) fails closed at its first use (never
 * used, it still counts). Any other code-level mention of the name (an
 * identifier, or a string holding exactly the name) throws: a read the gate
 * can't recognize must not pass as "not a carrier". So does a ScanError.
 */
export function readsExpectDeps(src, file) {
  let masked;
  try {
    masked = maskNonCode(src, false);
  } catch (err) {
    if (err instanceof ScanError)
      throw new Error(`could not scan ${file}: ${err.message}`);
    throw err;
  }
  const seen = new Set();
  let carrier = false;
  for (const m of masked.matchAll(DOT_READ)) {
    seen.add(m.index + m[0].length - VAR.length);
    carrier = true;
  }
  for (const m of masked.matchAll(BRACKET_OPEN)) {
    const q = m.index + m[0].length;
    const key = src.slice(q).match(QUOTED_KEY_AT);
    if (
      key &&
      masked[q] === key[1] &&
      /^\s*\]/.test(masked.slice(q + key[0].length))
    ) {
      seen.add(q);
      carrier = true;
    }
  }
  for (const m of masked.matchAll(DESTRUCTURE)) {
    const start = m.index + 1;
    for (const k of m[1].matchAll(BARE_VAR)) {
      // A key, not a rename target: led by the brace or a comma, followed by
      // the next entry, a rename or a default.
      if (
        !/(?:^|,)\s*$/.test(m[1].slice(0, k.index)) ||
        !/^\s*(?:[,:=]|$)/.test(m[1].slice(k.index + VAR.length))
      )
        continue;
      seen.add(start + k.index);
      carrier = true;
    }
  }
  const unsupported = [
    ...[...masked.matchAll(BARE_VAR)].map((m) => m.index),
    // A string holding exactly the name, in code (its quote survived masking).
    ...[...src.matchAll(QUOTED_VAR)]
      .filter((m) => masked[m.index] === m[1])
      .map((m) => m.index),
  ].filter((at) => !seen.has(at));
  if (unsupported.length > 0)
    throw new Error(
      `unsupported GD_EXPECT_DEPS read in ${file}; use ${CARRIER_TOKEN}`,
    );
  return carrier;
}

/** The frontend.yml step that is those suites' one enforced run. */
export const ENFORCED_STEP = "Node suites needing node_modules (enforced)";

const SUITE_PATH = /^scripts\/[A-Za-z0-9_.-]+\.test\.mjs$/;

const KEY = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/;
const BLOCK_SCALAR = /^[|>][0-9+-]*\s*(?:#.*)?$/;
const EMPTY_VALUE = /^(?:#.*)?$/;

/**
 * Classifies each line as blank, comment, block-scalar content, or a node:
 * its indent, the column its key or item content starts at (after a `- `),
 * and `key`/`value` when it is a `key: value` pair. Only nodes are structure,
 * so text inside a comment or another key's block scalar is never read as a
 * key. Throws on shapes the line model can't represent: tab indentation and
 * quoted or flow values that continue onto another line.
 */
function scanYaml(workflow) {
  const rows = [];
  let blockParent = -1;
  for (const [i, line] of workflow.split(/\r?\n/).entries()) {
    const lead = line.match(/^[ \t]*/)[0];
    const trimmed = line.trim();
    if (blockParent >= 0) {
      if (trimmed === "" || lead.length > blockParent) {
        rows.push({ kind: "content" });
        continue;
      }
      blockParent = -1;
    }
    if (lead.includes("\t"))
      throw new Error(`Tab in indentation at line ${i + 1}`);
    if (trimmed === "") {
      rows.push({ kind: "blank" });
      continue;
    }
    if (trimmed.startsWith("#")) {
      rows.push({ kind: "comment" });
      continue;
    }
    let rest = trimmed;
    let seq = false;
    if (rest === "-" || rest.startsWith("- ")) {
      seq = true;
      rest = rest.slice(1).trimStart();
    }
    const col = lead.length + (trimmed.length - rest.length);
    const m = rest.match(KEY);
    const key = m ? m[1] : null;
    const value = m ? (m[2] ?? "").trim() : rest;
    if (/^"/.test(value) && !/^"(?:[^"\\]|\\.)*"/.test(value))
      throw new Error(`Multi-line quoted value at line ${i + 1}`);
    if (/^'/.test(value) && !/^'(?:[^']|'')*'/.test(value))
      throw new Error(`Multi-line quoted value at line ${i + 1}`);
    const bare = value.replace(/\s+#.*$/, "");
    if (/^[{[]/.test(bare) && !/[}\]]$/.test(bare))
      throw new Error(`Multi-line flow value at line ${i + 1}`);
    if (BLOCK_SCALAR.test(value)) blockParent = key ? col : lead.length;
    rows.push({ kind: "node", i, indent: lead.length, col, seq, key, value });
  }
  return rows;
}

/** A single-line scalar's text: unquoted, trailing comment dropped. */
function scalarText(value) {
  const dq = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
  if (dq) return dq[1];
  const sq = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
  if (sq) return sq[1].replaceAll("''", "'");
  return value.replace(/\s+#.*$/, "").trim();
}

/** Values the guard reads must be plain one-line scalars it can see whole. */
function assertReadable(row, what) {
  if (/^[&*!]/.test(row.value))
    throw new Error(`${what} uses an anchor, alias or tag`);
  if (BLOCK_SCALAR.test(row.value))
    throw new Error(`${what} is a block scalar`);
  if (/^[{[]/.test(row.value)) throw new Error(`${what} is a flow collection`);
}

/**
 * The direct `key: value` children of a block-mapping key: every node from
 * `from` up to the next one at or above `parentIndent`, keyed at the first
 * child's indent. A deeper node belongs to the child above it; a shallower
 * one, a sequence item, a non-key or a repeated key fails closed. Returns
 * `{ row, nested }` by key.
 */
function childKeys(rows, from, parentIndent, what) {
  const out = new Map();
  let level = -1;
  let last = null;
  for (let j = from; j < rows.length; j++) {
    const row = rows[j];
    if (row.kind !== "node") continue;
    if (row.indent <= parentIndent) break;
    if (level < 0) level = row.indent;
    if (row.indent > level && last) {
      last.nested.push(row);
      continue;
    }
    if (row.indent !== level || row.seq || row.key === null)
      throw new Error(`${what}: unreadable entry at line ${row.i + 1}`);
    if (out.has(row.key))
      throw new Error(`${what}: duplicate key '${row.key}'`);
    last = { row, nested: [] };
    out.set(row.key, last);
  }
  return out;
}

/**
 * The suites the enforced step runs, read structurally: the step is the one
 * sequence item under a `steps:` key whose direct `name:` is ENFORCED_STEP,
 * its direct `env:` block mapping must hold a direct `GD_EXPECT_DEPS: "1"`, and
 * its direct `run:` must be one line of `node --test "…" "…"`. Every shape it
 * can't read that way (comments, block scalars, flow mappings, anchors, tabs,
 * duplicate keys, an unquoted or non-suite argument, an empty list) throws
 * rather than passing on a misread.
 */
export function parseEnforcedSuites(workflow) {
  const rows = scanYaml(workflow);
  const steps = [];
  for (const [at, row] of rows.entries()) {
    if (row.kind !== "node" || !row.seq || row.key === null) continue;
    // The item's own keys: its first line's, then its siblings at `col`.
    const item = new Map([[row.key, { row, nested: [] }]]);
    let last = item.get(row.key);
    for (let j = at + 1; j < rows.length; j++) {
      const next = rows[j];
      if (next.kind !== "node") continue;
      if (next.indent <= row.indent) break;
      if (next.indent > row.col) {
        last.nested.push(next);
        continue;
      }
      if (next.indent !== row.col || next.seq || next.key === null) {
        last = null;
        item.set("\0malformed", { row: next, nested: [] });
        break;
      }
      if (item.has(next.key)) {
        item.set("\0duplicate", { row: next, nested: [] });
        break;
      }
      last = { row: next, nested: [] };
      item.set(next.key, last);
    }
    const name = item.get("name");
    if (name && scalarText(name.row.value) === ENFORCED_STEP)
      steps.push({ at, row, item });
  }
  if (steps.length === 0)
    throw new Error(`Could not find the '${ENFORCED_STEP}' step`);
  if (steps.length > 1)
    throw new Error(`Found ${steps.length} '${ENFORCED_STEP}' steps`);
  const { at, row: head, item } = steps[0];
  if (item.has("\0malformed"))
    throw new Error(
      `'${ENFORCED_STEP}': unreadable key at line ${item.get("\0malformed").row.i + 1}`,
    );
  if (item.has("\0duplicate"))
    throw new Error(
      `'${ENFORCED_STEP}': duplicate key '${item.get("\0duplicate").row.key}'`,
    );
  // The item must be a step: its parent node is a `steps:` key holding a
  // block sequence, not a continuation line of some other scalar.
  let parent = null;
  for (let j = at - 1; j >= 0; j--) {
    if (rows[j].kind === "node" && rows[j].indent < head.indent) {
      parent = rows[j];
      break;
    }
  }
  if (parent?.key !== "steps" || !EMPTY_VALUE.test(parent.value))
    throw new Error(`'${ENFORCED_STEP}' is not an item of a steps: list`);
  for (const [key, { row }] of item)
    if (/^[&*]/.test(row.value))
      throw new Error(`'${ENFORCED_STEP}': ${key} uses an anchor or alias`);
  assertReadable(item.get("name").row, `'${ENFORCED_STEP}' name`);

  const env = item.get("env");
  if (!env) throw new Error(`'${ENFORCED_STEP}' has no env: mapping`);
  assertReadable(env.row, `'${ENFORCED_STEP}' env`);
  if (!EMPTY_VALUE.test(env.row.value))
    throw new Error(`'${ENFORCED_STEP}' env: is not a block mapping`);
  const envAt = rows.indexOf(env.row);
  const vars = childKeys(
    rows,
    envAt + 1,
    env.row.col,
    `'${ENFORCED_STEP}' env`,
  );
  const deps = vars.get("GD_EXPECT_DEPS");
  if (!deps)
    throw new Error(`'${ENFORCED_STEP}' does not set GD_EXPECT_DEPS: "1"`);
  assertReadable(deps.row, "GD_EXPECT_DEPS");
  if (
    deps.nested.length > 0 ||
    !/^(?:"1"|'1'|1)\s*(?:#.*)?$/.test(deps.row.value)
  )
    throw new Error(`'${ENFORCED_STEP}' does not set GD_EXPECT_DEPS: "1"`);

  const run = item.get("run");
  if (!run) throw new Error(`'${ENFORCED_STEP}' has no run: key`);
  assertReadable(run.row, `'${ENFORCED_STEP}' run`);
  if (run.nested.length > 0)
    throw new Error(`'${ENFORCED_STEP}' run: continues past one line`);
  const match = run.row.value.match(/^node --test((?:\s+"[^"]*")+)\s*$/);
  if (!match)
    throw new Error(`Could not parse the run line: run: ${run.row.value}`);
  const suites = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const suite of suites) {
    if (!SUITE_PATH.test(suite))
      throw new Error(`Not a single suite path: ${suite}`);
    if (seen.has(suite)) throw new Error(`Listed twice: ${suite}`);
    seen.add(suite);
  }
  return seen;
}

/** Suites reading CARRIER_TOKEN that the enforced step doesn't list. */
export function unlistedCarriers(carriers, listed) {
  return [...carriers].filter((suite) => !listed.has(suite)).sort();
}

function main() {
  const root =
    process.env.GD_ENFORCED_SUITES_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const listed = parseEnforcedSuites(
      readFileSync(join(root, ".github/workflows/frontend.yml"), "utf8"),
    );
    const suites = readdirSync(join(root, "scripts"))
      .filter((name) => name.endsWith(".test.mjs"))
      .map((name) => `scripts/${name}`);
    if (suites.length === 0) throw new Error("no scripts/*.test.mjs found");
    const failures = [];
    const carriers = suites.filter((suite) => {
      try {
        return readsExpectDeps(readFileSync(join(root, suite), "utf8"), suite);
      } catch (err) {
        failures.push(err.message);
        return false;
      }
    });
    if (carriers.length === 0)
      failures.push(`no suite reads ${CARRIER_TOKEN}; refusing a vacuous pass`);
    const missing = unlistedCarriers(carriers, listed);
    if (missing.length)
      failures.push(
        `read GD_EXPECT_DEPS but missing from '${ENFORCED_STEP}': ${missing.join(", ")}`,
      );
    const absent = [...listed].filter((suite) => !suites.includes(suite));
    if (absent.length)
      failures.push(`listed but not on disk: ${absent.join(", ")}`);
    if (failures.length) {
      process.stderr.write(
        `enforced-node-suites: FAIL\n${failures.join("\n")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `enforced-node-suites: OK ${carriers.length} installed-only suites, all enforced\n`,
    );
  } catch (err) {
    process.stderr.write(`enforced-node-suites: FAIL ${err.message}\n`);
    process.exitCode = 1;
  }
}

// Path comparison keeps this gate active without relying on import.meta.main.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
