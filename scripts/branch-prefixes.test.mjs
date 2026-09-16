// Pins the branch-name prompt's convention evidence: the prefix frequency table
// the model reads instead of a window of branch names. These cases mirror the
// Rust ones in src-tauri/src/mcp_server/generate.rs one for one, because the MCP
// recipe tools render the same section and the two sides drift silently — a
// prompt has no type to break and no screen to look wrong on.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES types
// rather than compiling them and resolves no bundler aliases, so
// `branch-prefixes.ts` must stay free of runtime and aliased imports. Adding one
// there fails this file.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchPrefixCounts,
  branchPrefixSection,
  compareCodePoints,
} from "../src/lib/ai/branch-prefixes.ts";

const HEADER = "## Branch name prefixes in this repository (most used first)";

// ----------------------------------------------------- the rendered section

// Mirrors `branch_prefix_section_counts_descending_with_unprefixed_row`. The
// dominant prefix has to lead whatever order the branch list arrived in, and
// unprefixed branches need a row of their own rather than a silent absence — the
// evidence has to be able to say "this repository doesn't prefix".
test("counts descend, and bare names get their own row", () => {
  assert.equal(
    branchPrefixSection([
      "release",
      "fix/x",
      "feat/a",
      "main",
      "feat/b",
      "fix/y",
      "feat/c",
    ]),
    `${HEADER}\nfeat/ 3\n(no prefix — bare names) 2\nfix/ 2`,
  );
});

// Mirrors `branch_prefix_section_caps_rows_and_discloses_the_tail`. Rows are
// ordered by frequency, so the cap drops only least-used prefixes — but the
// count that fell off is disclosed rather than silently vanishing.
test("rows cap at 12 and the dropped tail is disclosed", () => {
  const names = [];
  for (let i = 0; i < 14; i++) {
    names.push(`p${String(i).padStart(2, "0")}/x`);
  }
  const section = branchPrefixSection(names);
  assert.ok(section.includes("p00/ 1\np01/ 1"), section);
  assert.ok(section.includes("p11/ 1"), section);
  assert.ok(!section.includes("p12/"), section);
  assert.ok(
    section.endsWith("\n[2 more prefix(es) used by fewer branches]"),
    section,
  );
});

// Mirrors `branch_prefix_section_absent_without_branches`. No branches ⇒ no
// section at all; the system prompt's no-counts arm covers a fresh repository,
// and an empty heading would read as "this repository uses nothing".
test("no branches yields no section", () => {
  assert.equal(branchPrefixSection([]), null);
});

test("a lone default branch is reported as a bare name", () => {
  assert.equal(
    branchPrefixSection(["main"]),
    `${HEADER}\n(no prefix — bare names) 1`,
  );
});

// -------------------------------------------------------------- tie-breaking

// Mirrors `branch_prefix_section_ties_break_in_code_point_order`. Rust compares
// UTF-8 bytes, which is code-POINT order; JS `<` compares UTF-16 code units and
// inverts this pair, so the two sides would render equal-count rows in different
// orders. The first assertion pins that premise: if it ever fails, `<` became
// safe and the comparator is redundant.
test("ties break in code-point order, matching Rust's str ordering", () => {
  const astral = "\u{10000}";
  const bmp = "\u{e000}";
  assert.equal(astral.length, 2, "astral char must be a surrogate pair");
  assert.equal(astral.codePointAt(0), 0x10000);
  assert.ok(astral < bmp, "UTF-16 order puts the surrogate pair first");
  assert.ok(
    compareCodePoints(bmp, astral) < 0,
    "code-point order puts U+E000 first",
  );

  const section = branchPrefixSection([`${astral}/a`, `${bmp}/b`]);
  assert.ok(
    section.indexOf(`${bmp}/`) < section.indexOf(`${astral}/`),
    section,
  );
});

test("compareCodePoints orders a prefix before its own extension", () => {
  assert.ok(compareCodePoints("feat/", "feature/") < 0);
  assert.equal(compareCodePoints("feat/", "feat/"), 0);
});

// ------------------------------------------------------------- the raw counts

// A branch's prefix is the segment before its FIRST slash; deeper slashes belong
// to the name, not to a second prefix level.
test("only the first segment counts as the prefix", () => {
  assert.deepEqual(branchPrefixCounts(["feat/a/b/c", "feat/d"]), [
    { prefix: "feat/", count: 2 },
  ]);
});

// A leading slash is not a prefix — there is no segment in front of it.
test("a name with no leading segment counts as bare", () => {
  assert.deepEqual(branchPrefixCounts(["/odd"]), [
    { prefix: "(no prefix — bare names)", count: 1 },
  ]);
});
