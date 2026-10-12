#!/usr/bin/env node
// A node suite that skips without node_modules (the installless guards job)
// names frontend.yml's installed step as its enforced run, so that step must
// list it: an unlisted suite's skipped tests run in no CI job at all. This
// gate needs only Node stdlib because CI runs it before installing anything.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The skip reason a suite carries when its deps are absent. */
export const SKIP_PHRASE =
  "needs node_modules — frontend.yml's installed step is the enforced run";

/** The frontend.yml step that is those suites' one enforced run. */
export const ENFORCED_STEP = "Node suites needing node_modules (enforced)";

const SUITE_PATH = /^scripts\/[A-Za-z0-9_.-]+\.test\.mjs$/;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * The suites the enforced step runs, read from its single-line
 * `run: node --test "…" "…"`. Throws on anything it can't read as that shape
 * (missing step, no GD_EXPECT_DEPS, a block scalar, an unquoted or non-suite
 * argument, a duplicate, an empty list) rather than passing on a misread.
 */
export function parseEnforcedSuites(workflow) {
  const lines = workflow.split(/\r?\n/);
  const heads = lines
    .map((line, i) => [line, i])
    .filter(([line]) =>
      new RegExp(
        `^\\s*-\\s+name:\\s*["']?${ENFORCED_STEP.replace(/[()]/g, "\\$&")}["']?\\s*$`,
      ).test(line),
    );
  if (heads.length === 0)
    throw new Error(`Could not find the '${ENFORCED_STEP}' step`);
  if (heads.length > 1)
    throw new Error(`Found ${heads.length} '${ENFORCED_STEP}' steps`);
  const [head, start] = heads[0];
  const stepIndent = indentOf(head);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) <= stepIndent) break;
    body.push(line);
  }
  if (!body.some((line) => /^\s*GD_EXPECT_DEPS:\s*["']?1["']?\s*$/.test(line)))
    throw new Error(`'${ENFORCED_STEP}' does not set GD_EXPECT_DEPS: "1"`);
  const runs = body.filter((line) => /^\s*run:/.test(line));
  if (runs.length !== 1)
    throw new Error(`'${ENFORCED_STEP}' needs exactly one run: line`);
  const match = runs[0].match(/^\s*run:\s*node --test((?:\s+"[^"]*")+)\s*$/);
  if (!match)
    throw new Error(`Could not parse the run line: ${runs[0].trim()}`);
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

/** Carriers of the skip phrase that the enforced step doesn't list. */
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
    const carriers = suites.filter((suite) =>
      readFileSync(join(root, suite), "utf8").includes(SKIP_PHRASE),
    );
    const failures = [];
    if (carriers.length === 0)
      failures.push(
        "no suite carries the skip phrase; refusing a vacuous pass",
      );
    const missing = unlistedCarriers(carriers, listed);
    if (missing.length)
      failures.push(
        `skip in the guards job but missing from '${ENFORCED_STEP}': ${missing.join(", ")}`,
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
      `enforced-node-suites: OK ${carriers.length} skipping suites, all enforced\n`,
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
