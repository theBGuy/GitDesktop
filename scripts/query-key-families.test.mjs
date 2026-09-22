// Guard: the five forge LIST query-key families are declared once, as builders on
// `repoKeys` in src/lib/git/queries/core.ts. A hand-spelled array literal elsewhere is
// what this refuses — a typo in an invalidation's spelling throws no error, it just
// leaves the surface stale, which is invisible until a user notices stale rows.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY: importing core.ts
// would pull in @tanstack and MODULE_NOT_FOUND the whole runner.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
/** The one file allowed to spell these families out. */
const DECLARATION = join("src", "lib", "git", "queries", "core.ts");

const FAMILIES = [
  { name: "pr-list", builder: "repoKeys.prList" },
  { name: "pr-ci", builder: "repoKeys.prCi" },
  { name: "pr-mergeability", builder: "repoKeys.prMergeability" },
  { name: "pr-review-state", builder: "repoKeys.prReviewState" },
  { name: "issue-list", builder: "repoKeys.issueList" },
];

// Two hand-spelled shapes are refused outside core.ts, by two mechanisms: the bare
// array literal `["repo", <anything>, "<family>"` is regular, so a regex settles it;
// the composed form `[...repoKeys.all(repo), "<family>"` is not, because a nested
// argument (`repoKeys.all(normalizeRepo(repo))`) puts a `)` in the way that no
// `[^)]*` can cross — that one takes a balanced-paren scan. `\s` covers CRLF in both.

const literalPattern = (family) =>
  new RegExp(`\\[\\s*"repo",\\s*[^\\]]*?"${family}"`);

/** Whether `source` reaches a family prefix through `repoKeys.all(…)` at any argument
 *  nesting depth. A `repoKeys.all(` whose parens never balance is not a spelling: the
 *  walk runs out and reports false rather than reading past the end. */
function hasComposedSpelling(source, family) {
  const opener = /repoKeys\.all\(/g;
  const tail = new RegExp(String.raw`^\s*,\s*"${family}"`);
  for (let m = opener.exec(source); m; m = opener.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    if (depth === 0 && tail.test(source.slice(i))) return true;
  }
  return false;
}

/** Either shape, for one family. */
const spellsFamily = (source, family) =>
  literalPattern(family).test(source) || hasComposedSpelling(source, family);

/** Floor for the scanned corpus, ~half the 700 .ts/.tsx files under src/ measured
 *  when this guard was written. A path-pinned scan that finds nothing scans nothing
 *  and reports OK, so the count is asserted rather than trusted. */
const SCAN_FLOOR = 350;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry.name)) yield full;
  }
}

test("every hand-spelled shape is matched (negative control)", () => {
  assert.ok(
    spellsFamily('  queryKey: ["repo", repoPath, "pr-list", lens],', "pr-list"),
    "the array-literal pattern went inert",
  );
  assert.ok(
    spellsFamily('  queryKey: [...repoKeys.all(repo), "pr-ci"],', "pr-ci"),
    "the repoKeys.all-composed scan went inert",
  );
  assert.ok(
    spellsFamily(
      '  queryKey: [...repoKeys.all(normalizeRepo(repo)), "pr-ci"],',
      "pr-ci",
    ),
    "the composed scan stopped at a NESTED argument's closing paren",
  );
  assert.equal(
    spellsFamily('[...repoKeys.all(repo, "pr-ci"', "pr-ci"),
    false,
    "an unbalanced repoKeys.all( tail must fall out false, never crash or match",
  );
});

test("core.ts still declares every family string", () => {
  const source = readFileSync(join(REPO_ROOT, DECLARATION), "utf8");
  for (const { name, builder } of FAMILIES) {
    assert.ok(
      source.includes(`"${name}"`),
      `${DECLARATION} no longer spells "${name}" — if ${builder} was renamed or dropped, this guard is scanning for a family nothing declares.`,
    );
  }
});

test("no file outside core.ts spells a list family", () => {
  const offenders = [];
  let scanned = 0;
  for (const file of sourceFiles(SRC)) {
    scanned++;
    const rel = relative(REPO_ROOT, file);
    if (rel.split(/[\\/]/).join("/") === DECLARATION.split(/[\\/]/).join("/"))
      continue;
    const source = readFileSync(file, "utf8");
    for (const { name, builder } of FAMILIES) {
      if (spellsFamily(source, name))
        offenders.push(
          `${rel}: spells the "${name}" family — build it from ${builder}() instead, or, in a comment, describe the shape in words instead of spelling the literal`,
        );
    }
  }
  assert.ok(
    scanned >= SCAN_FLOOR,
    `SCOPE PIN FAILED — scanned ${scanned} .ts/.tsx files under src/, below the floor ${SCAN_FLOOR}; the walk went inert (moved dir? changed filter?) and this guard is passing vacuously — re-point SRC, or re-pin SCAN_FLOOR after a deliberate reorg`,
  );
  assert.deepEqual(
    offenders,
    [],
    `Query-key families must be built from repoKeys (src/lib/git/queries/core.ts):\n${offenders.join("\n")}`,
  );
});
