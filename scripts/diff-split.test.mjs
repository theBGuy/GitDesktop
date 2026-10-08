// Pins the section keys the AI-ignore filter and PR file views share.
// The import reaches straight into src/ under Node's type stripping in the
// installless guards job, so diff-split.ts must stay free of runtime and
// aliased imports — and this dep-free suite never joins frontend.yml's
// node_modules-required roster.
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
  {
    name: "a deletion whose path contains a b-side separator",
    path: "docs/a b/c.txt",
    section:
      "diff --git a/docs/a b/c.txt b/docs/a b/c.txt\n" +
      "deleted file mode 100644\n" +
      "--- a/docs/a b/c.txt\t\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-secret\n",
  },
  {
    name: "a pure rename into a path containing a b-side separator",
    path: "src/a b/new.txt",
    section:
      "diff --git a/src/old.txt b/src/a b/new.txt\n" +
      "similarity index 100%\n" +
      "rename from src/old.txt\n" +
      "rename to src/a b/new.txt\n",
  },
  {
    name: "a pure rename between paths that both contain a b-side separator",
    path: "x b/z.txt",
    section:
      "diff --git a/x b/y.txt b/x b/z.txt\n" +
      "similarity index 100%\n" +
      "rename from x b/y.txt\n" +
      "rename to x b/z.txt\n",
  },
  {
    name: "a pure rename whose header also reads as an unrenamed path",
    path: "n.txt",
    section:
      "diff --git a/p b/n.txt b/p b/n.txt\n" +
      "similarity index 100%\n" +
      "rename from p b/n.txt b/p\n" +
      "rename to n.txt\n",
  },
  {
    name: "a copy into a path containing a b-side separator",
    path: "src/a b/copy.txt",
    section:
      "diff --git a/src/base.txt b/src/a b/copy.txt\n" +
      "similarity index 100%\n" +
      "copy from src/base.txt\n" +
      "copy to src/a b/copy.txt\n",
  },
  {
    name: "a deletion with both sides C-quoted and a b-side separator inside the quotes",
    path: "docs/café b/x.txt",
    section:
      'diff --git "a/docs/caf\\303\\251 b/x.txt" "b/docs/caf\\303\\251 b/x.txt"\n' +
      "deleted file mode 100644\n" +
      '--- "a/docs/caf\\303\\251 b/x.txt"\t\n' +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-secret\n",
  },
  {
    name: "a mode change whose path contains a b-side separator",
    path: "bin/a b/run.sh",
    section:
      "diff --git a/bin/a b/run.sh b/bin/a b/run.sh\n" +
      "old mode 100644\n" +
      "new mode 100755\n",
  },
  {
    name: "a binary change whose path contains a b-side separator",
    path: "img/a b/logo.png",
    section:
      "diff --git a/img/a b/logo.png b/img/a b/logo.png\n" +
      "index 1111111..2222222 100644\n" +
      "Binary files a/img/a b/logo.png and b/img/a b/logo.png differ\n",
  },
  {
    name: "an empty new file whose path contains a b-side separator",
    path: "a b/empty.txt",
    section:
      "diff --git a/a b/empty.txt b/a b/empty.txt\n" +
      "new file mode 100644\n" +
      "index 0000000..e69de29\n",
  },
  {
    name: "a deletion whose path repeats the b-side separator",
    path: "a b/b b/c.txt",
    section:
      "diff --git a/a b/b b/c.txt b/a b/b b/c.txt\n" +
      "deleted file mode 100644\n" +
      "--- a/a b/b b/c.txt\t\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-gone\n",
  },
  {
    name: "a C-quoted old side beside a plain new side containing a b-side separator",
    path: "p b/q.txt",
    section: 'diff --git "a/caf\\303\\251.txt" b/p b/q.txt\n',
  },
  {
    name: "a modification whose new-side name is empty, keyed by its diff header",
    path: "src/empty-plus.txt",
    section:
      "diff --git a/src/empty-plus.txt b/src/empty-plus.txt\n" +
      "--- a/src/empty-plus.txt\n" +
      "+++ b/\n" +
      "@@ -1 +1 @@\n-old\n+new\n",
  },
  {
    name: "a header-only rename without extended headers",
    path: "src/after.txt",
    section: "diff --git a/src/before.txt b/src/after.txt\n",
  },
  {
    name: "a binary rename whose raw destination starts with a quote",
    path: '"q".txt',
    section:
      'diff --git a/old.txt b/"q".txt\n' +
      "rename from old.txt\n" +
      'rename to "q".txt\n' +
      'Binary files a/old.txt and b/"q".txt differ\n',
  },
  {
    name: "a synthetic header with differing bare names of uneven length",
    path: "yx",
    section: "diff --git a/x b/yx\n",
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
