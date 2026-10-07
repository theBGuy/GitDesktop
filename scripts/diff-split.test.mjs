// Pins the shared section keys used by the AI-ignore privacy boundary and PR
// file views, together with section preservation and per-file hunk counts.
// The static .ts import is legal under Node >= 23.6 type stripping: diff-split.ts
// has only a relative import type, which is erased without resolving its target.
//
// INSTALLLESS-CI CONTRACT: .github/workflows/quality.yml's guards job, step
// "Guard self-tests", runs node --test "scripts/*.test.mjs" with NO install.
// Any npm import in this chain causes ERR_MODULE_NOT_FOUND there even when local
// node_modules masks it. Keep only the two built-ins and static import below;
// this suite rides that glob, not frontend.yml's node_modules-required roster.
//
// Deliberately excludes live PR fetching, UI rendering, AI-ignore glob matching,
// and budget/truncation behavior; these are deterministic parser fixtures only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffSectionStats,
  sectionFilePath,
  splitUnifiedDiff,
} from "../src/lib/git/diff-split.ts";

// ---------------------------------------------------------------- headerShapes

const shapes = [
  {
    name: "a plain modification",
    path: "src/plain.txt",
    section:
      "diff --git a/src/plain.txt b/src/plain.txt\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/plain.txt\n" +
      "+++ b/src/plain.txt\n" +
      "@@ -1,3 +1,3 @@\n" +
      " context\n-old\n---marker\n+new\n+++marker\n",
  },
  {
    name: "a pure rename without old or new file header lines",
    path: "src/renamed.txt",
    section:
      "diff --git a/src/original.txt b/src/renamed.txt\n" +
      "similarity index 100%\n" +
      "rename from src/original.txt\n" +
      "rename to src/renamed.txt\n",
  },
  {
    name: "a plain old side with a C-quoted new side containing an escaped carriage return",
    path: "src/mixed\rname.txt",
    section:
      'diff --git a/src/mixed.txt "b/src/mixed\\rname.txt"\n' +
      "similarity index 100%\n" +
      "rename from src/mixed.txt\n" +
      'rename to "src/mixed\\rname.txt"\n',
  },
  {
    name: "a header with both sides C-quoted as octal UTF-8 bytes",
    path: "src/modified-café.txt",
    section:
      'diff --git "a/src/modified-caf\\303\\251.txt" "b/src/modified-caf\\303\\251.txt"\n' +
      '--- "a/src/modified-caf\\303\\251.txt"\n' +
      '+++ "b/src/modified-caf\\303\\251.txt"\n' +
      "@@ -1 +1 @@\n-old\n+new\n",
  },
  {
    name: "a deletion with a null new side",
    path: "src/deleted.txt",
    // Fallback direction is pinned by the headerless-deletion case below:
    // without a diff --git line the --- side alone keys nothing.
    section:
      "diff --git a/src/deleted.txt b/src/deleted.txt\n" +
      "deleted file mode 100644\n" +
      "--- a/src/deleted.txt\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-removed\n",
  },
  {
    name: "a path containing a space with its trailing tab field",
    path: "docs/space name.txt",
    section:
      "diff --git a/docs/space name.txt b/docs/space name.txt\n" +
      "--- a/docs/space name.txt\t\n" +
      "+++ b/docs/space name.txt\t\n" +
      "@@ -1 +1 @@\n-old\n+new\n",
  },
  {
    name: "a new file with a null old side",
    path: "src/created.txt",
    section:
      "diff --git a/src/created.txt b/src/created.txt\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/src/created.txt\n" +
      "@@ -0,0 +1 @@\n+created\n",
  },
  {
    name: "a deletion keyed only by its quoted diff-header path",
    path: "src/café.txt",
    section:
      'diff --git "a/src/caf\\303\\251.txt" "b/src/caf\\303\\251.txt"\n' +
      "deleted file mode 100644\n" +
      '--- "a/src/caf\\303\\251.txt"\n' +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-removed\n",
  },
];

for (const { name, path, section } of shapes) {
  test(`the path and full section survive ${name}`, () => {
    assert.equal(sectionFilePath(section), path, name);
    assert.deepEqual([...splitUnifiedDiff(section)], [[path, section]], name);
  });
}

// ------------------------------------------------------------ combinedSections

const combined = shapes.map(({ section }) => section).join("");

test("all sections retain their keys and round-trip byte-identically", () => {
  const sections = splitUnifiedDiff(combined);
  assert.deepEqual(
    [...sections.keys()],
    shapes.map(({ path }) => path),
  );
  assert.equal([...sections.values()].join(""), combined);
});

test("all sections resolve by filename in the synthetic PR diff", () => {
  const sections = splitUnifiedDiff(combined);
  for (const { name, path, section } of shapes) {
    assert.equal(sections.get(path), section, name);
  }
});

// -------------------------------------------------------------- surrogatePairs

test("literal and octal-escaped emoji decode without replacement characters", () => {
  const fixtures = [
    { name: "literal emoji", token: '"b/icons/😀\\t.txt"' },
    {
      name: "octal emoji",
      token: '"b/icons/\\360\\237\\230\\200\\t.txt"',
    },
  ];
  const expected = "icons/😀\t.txt";
  for (const { name, token } of fixtures) {
    const section = `diff --git a/icons/old.txt ${token}\n`;
    const path = sectionFilePath(section);
    assert.equal(path.includes("\uFFFD"), false, name);
    assert.equal(path, expected, name);
    assert.deepEqual(
      [...splitUnifiedDiff(section)],
      [[expected, section]],
      name,
    );
  }
});

// -------------------------------------------------------------- hunkStatistics

test("per-file counts exclude headers and include hunk lines starting with three signs", () => {
  const diff = shapes[0].section + shapes[1].section + shapes[4].section;
  assert.deepEqual(diffSectionStats(diff), [
    { path: "src/plain.txt", added: 2, deleted: 2, isBinary: false },
    { path: "src/renamed.txt", added: 0, deleted: 0, isBinary: false },
    { path: "src/deleted.txt", added: 0, deleted: 1, isBinary: false },
  ]);
});

// ----------------------------------------------------- emptyAndHeaderlessInput

test("empty input has no path, sections, or statistics", () => {
  assert.equal(sectionFilePath(""), undefined);
  assert.deepEqual([...splitUnifiedDiff("")], []);
  assert.deepEqual(diffSectionStats(""), []);
});

test("headerless input without a usable new-side path is dropped", () => {
  const fixtures = [
    { name: "unkeyable text", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    {
      name: "deletion without a diff header",
      diff: "--- a/src/deleted.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n",
    },
  ];
  for (const { name, diff } of fixtures) {
    assert.equal(sectionFilePath(diff), undefined, name);
    assert.deepEqual([...splitUnifiedDiff(diff)], [], name);
    assert.deepEqual(diffSectionStats(diff), [], name);
  }
});

test("a headerless patch with a usable new-side path is retained", () => {
  // Current contract accepts +++ b/path even without a diff --git header.
  const diff = "--- a/loose.txt\n+++ b/loose.txt\n@@ -1 +1 @@\n-old\n+new\n";
  assert.equal(sectionFilePath(diff), "loose.txt");
  assert.deepEqual([...splitUnifiedDiff(diff)], [["loose.txt", diff]]);
  assert.deepEqual(diffSectionStats(diff), [
    { path: "loose.txt", added: 1, deleted: 1, isBinary: false },
  ]);
});
