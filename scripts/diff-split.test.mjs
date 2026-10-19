// Pins the section keys the AI-ignore filter and PR file views share.
// The import reaches straight into src/ under Node's type stripping in the
// installless guards job, so diff-split.ts must stay free of runtime and
// aliased imports — and this dep-free suite never joins frontend.yml's
// node_modules-required roster.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  binaryRowPaths,
  diffSectionStats,
  sectionFilePath,
  sectionIsBinary,
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
  {
    name: "a binary rename to a name whose quotes are part of the filename",
    path: '"secret.txt"',
    section:
      'diff --git a/old2.txt b/"secret.txt"\n' +
      "rename from old2.txt\n" +
      'rename to "secret.txt"\n' +
      'Binary files a/old2.txt and b/"secret.txt" differ\n',
  },
  {
    name: "a git-quoted rename destination containing escaped quotes",
    path: '"escaped".txt',
    section:
      'diff --git a/old3.txt "b/\\"escaped\\".txt"\n' +
      "rename from old3.txt\n" +
      'rename to "\\"escaped\\".txt"\n' +
      "Binary files differ\n",
  },
  {
    name: "a raw rename destination containing quotes and a backslash",
    path: '"x\\y"',
    section:
      'diff --git a/old4.txt b/"x\\y"\n' +
      "rename from old4.txt\n" +
      'rename to "x\\y"\n',
  },
  {
    name: "a C-quoted old side with an escaped quote beside a plain new side",
    path: "z.txt",
    section: 'diff --git "a/x\\" b/y.txt" b/z.txt\n',
  },
  {
    name: "a raw binary rename whose old name contains a b-side-like quote run",
    path: '"secret.png"',
    section:
      'diff --git a/dir "b/old.png b/"secret.png"\n' +
      'rename from dir "b/old.png\n' +
      'rename to "secret.png"\n' +
      "Binary files differ\n",
  },
  {
    name: "a modification with an embedded line separator",
    path: "secret\u2028x.env",
    section:
      "diff --git a/secret\u2028x.env b/secret\u2028x.env\n" +
      "--- a/secret\u2028x.env\n" +
      "+++ b/secret\u2028x.env\n" +
      "@@ -1 +1 @@\n-old\n+new\n",
  },
  {
    name: "a new file with an embedded paragraph separator",
    path: "created\u2029x.env",
    section:
      "diff --git a/created\u2029x.env b/created\u2029x.env\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/created\u2029x.env\n" +
      "@@ -0,0 +1 @@\n+created\n",
  },
  {
    name: "a rename destination with an embedded line separator",
    path: "renamed\u2028x.env",
    section:
      "diff --git a/rename-ls-old.env b/renamed\u2028x.env\n" +
      "similarity index 100%\n" +
      "rename from rename-ls-old.env\n" +
      "rename to renamed\u2028x.env\n",
  },
  {
    name: "a copy destination with an embedded line separator",
    path: "copied\u2028x.env",
    section:
      "diff --git a/copy-ls-old.env b/copied\u2028x.env\n" +
      "similarity index 100%\n" +
      "copy from copy-ls-old.env\n" +
      "copy to copied\u2028x.env\n",
  },
  {
    name: "a deletion with an embedded line separator",
    path: "deleted\u2028x.env",
    section:
      "diff --git a/deleted\u2028x.env b/deleted\u2028x.env\n" +
      "deleted file mode 100644\n" +
      "--- a/deleted\u2028x.env\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-removed\n",
  },
  {
    name: "a mode change with an embedded line separator",
    path: "bin/run\u2028x.sh",
    section:
      "diff --git a/bin/run\u2028x.sh b/bin/run\u2028x.sh\n" +
      "old mode 100644\n" +
      "new mode 100755\n",
  },
  {
    name: "a binary change with an embedded line separator",
    path: "img/logo\u2028x.png",
    section:
      "diff --git a/img/logo\u2028x.png b/img/logo\u2028x.png\n" +
      "index 1111111..2222222 100644\n" +
      "Binary files a/img/logo\u2028x.png and b/img/logo\u2028x.png differ\n",
  },
  {
    name: "a raw line separator in the old name beside a C-quoted rename destination",
    path: "quoted-new\rx.env",
    section:
      'diff --git a/raw\u2028old.env "b/quoted-new\\rx.env"\n' +
      "similarity index 100%\n" +
      "rename from raw\u2028old.env\n" +
      'rename to "quoted-new\\rx.env"\n',
  },
  {
    name: "a deletion whose content has a line separator before a rename-like suffix",
    path: "src/ls-content.txt",
    section:
      "diff --git a/src/ls-content.txt b/src/ls-content.txt\n" +
      "deleted file mode 100644\n" +
      "--- a/src/ls-content.txt\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n-x\u2028rename to decoy.txt\n",
  },
  {
    name: "content with a carriage return before a diff-like suffix",
    path: "src/cr-content.txt",
    section:
      "diff --git a/src/cr-content.txt b/src/cr-content.txt\n" +
      "--- a/src/cr-content.txt\n" +
      "+++ b/src/cr-content.txt\n" +
      "@@ -1 +1,2 @@\n-old\n" +
      "+first\rdiff --git a/decoy.txt b/decoy.txt\n+second\n",
  },
  {
    name: "content with a line separator before a diff-like suffix",
    path: "src/ls-split-content.txt",
    section:
      "diff --git a/src/ls-split-content.txt b/src/ls-split-content.txt\n" +
      "--- a/src/ls-split-content.txt\n" +
      "+++ b/src/ls-split-content.txt\n" +
      "@@ -1 +1,2 @@\n-old\n" +
      "+first\u2028diff --git a/decoy.txt b/decoy.txt\n+second\n",
  },
  {
    name: "a modification with an embedded raw carriage return",
    path: "raw\rx.env",
    section:
      "diff --git a/raw\rx.env b/raw\rx.env\n" +
      "--- a/raw\rx.env\n" +
      "+++ b/raw\rx.env\n" +
      "@@ -1 +1 @@\n-old\n+new\n",
  },
];

for (const { name, path, section } of shapes) {
  test(`the path and full section survive ${name}`, () => {
    assert.equal(sectionFilePath(section), path, name);
    assert.deepEqual([...splitUnifiedDiff(section)], [[path, section]], name);
  });
}

test("a CR-only rename destination falls through to the diff header", () => {
  const path = "src/cr-only-fallback.txt";
  const section =
    "diff --git a/src/cr-only-fallback.txt b/src/cr-only-fallback.txt\n" +
    "rename to \r\n";
  assert.equal(sectionFilePath(section), path);
  assert.deepEqual([...splitUnifiedDiff(section)], [[path, section]]);
});

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

test("CRLF sections retain the same full paths and section bytes", () => {
  const crlf = combined.replaceAll("\n", "\r\n");
  const sections = splitUnifiedDiff(crlf);
  assert.deepEqual(
    [...sections.keys()],
    shapes.map(({ path }) => path),
  );
  assert.equal([...sections.values()].join(""), crlf);
  for (const { name, path, section } of shapes) {
    assert.equal(sectionFilePath(section.replaceAll("\n", "\r\n")), path, name);
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

test("a carriage return inside content preserves section keys and counts", () => {
  const { path, section } = shapes.find(
    ({ path }) => path === "src/cr-content.txt",
  );
  assert.deepEqual([...splitUnifiedDiff(section).keys()], [path]);
  assert.deepEqual(diffSectionStats(section), [
    { path, added: 2, deleted: 1, isBinary: false },
  ]);
});

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

// -------------------------------------------------------------- binaryMarkers

const binarySections = [
  {
    name: "a modified binary",
    path: "img/logo.png",
    section:
      "diff --git a/img/logo.png b/img/logo.png\n" +
      "index 1111111..2222222 100644\n" +
      "Binary files a/img/logo.png and b/img/logo.png differ\n",
  },
  {
    name: "an added binary",
    path: "img/new.png",
    section:
      "diff --git a/img/new.png b/img/new.png\n" +
      "new file mode 100644\n" +
      "index 0000000..3333333\n" +
      "Binary files /dev/null and b/img/new.png differ\n",
  },
  {
    name: "a deleted binary, keyed by its header's b-side name",
    path: "img/old.png",
    section:
      "diff --git a/img/old.png b/img/old.png\n" +
      "deleted file mode 100644\n" +
      "index 4444444..0000000\n" +
      "Binary files a/img/old.png and /dev/null differ\n",
  },
  {
    name: "a renamed binary without hunks, keyed by its new path",
    path: "img/after.png",
    section:
      "diff --git a/img/before.png b/img/after.png\n" +
      "similarity index 90%\n" +
      "rename from img/before.png\n" +
      "rename to img/after.png\n" +
      "index 5555555..6666666 100644\n" +
      "Binary files a/img/before.png and b/img/after.png differ\n",
  },
  {
    name: "a C-quoted binary, keyed by its decoded path",
    path: "img/café.png",
    section:
      'diff --git "a/img/caf\\303\\251.png" "b/img/caf\\303\\251.png"\n' +
      "index 7777777..8888888 100644\n" +
      'Binary files "a/img/caf\\303\\251.png" and "b/img/caf\\303\\251.png" differ\n',
  },
  {
    // reconstruct_file_diff (forge/gitlab.rs) writes the header and both file
    // lines, then GitLab's own per-file diff text.
    name: "a GitLab-rebuilt binary, file headers ahead of the marker",
    path: "img/gl.png",
    section:
      "diff --git a/img/gl.png b/img/gl.png\n" +
      "--- a/img/gl.png\n" +
      "+++ b/img/gl.png\n" +
      "Binary files a/img/gl.png and b/img/gl.png differ\n",
  },
];

// Text diffs whose hunk CONTENT mentions binary files: every hunk line carries
// its +/-/space prefix, so none of them may read as git's marker.
const contentMentions = [
  {
    name: "a context line",
    path: "docs/context.md",
    added: 1,
    deleted: 1,
    section:
      "diff --git a/docs/context.md b/docs/context.md\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/docs/context.md\n" +
      "+++ b/docs/context.md\n" +
      "@@ -1,2 +1,2 @@\n" +
      " Binary files a and b differ\n" +
      "-old\n+new\n",
  },
  {
    name: "an added line",
    path: "docs/added.md",
    added: 1,
    deleted: 0,
    section:
      "diff --git a/docs/added.md b/docs/added.md\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/docs/added.md\n" +
      "+++ b/docs/added.md\n" +
      "@@ -1 +1,2 @@\n" +
      " intro\n" +
      "+Binary files a/x and b/x differ\n",
  },
  {
    name: "a deleted line",
    path: "docs/deleted.md",
    added: 0,
    deleted: 1,
    section:
      "diff --git a/docs/deleted.md b/docs/deleted.md\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/docs/deleted.md\n" +
      "+++ b/docs/deleted.md\n" +
      "@@ -1,2 +1 @@\n" +
      " intro\n" +
      "-Binary files a/x and b/x differ\n",
  },
];

test("git's binary marker reads as binary on every section shape", () => {
  for (const { name, path, section } of binarySections) {
    assert.equal(sectionIsBinary(section), true, name);
    assert.deepEqual([...splitUnifiedDiff(section).keys()], [path], name);
  }
  // The suite's existing quoting fixtures with a marker read the same way.
  for (const { name, section } of shapes.filter(({ section }) =>
    /(?<![^\n])Binary files /.test(section),
  ))
    assert.equal(sectionIsBinary(section), true, name);
});

test("a text diff whose content mentions binary files is not binary", () => {
  for (const { name, section } of contentMentions) {
    // The trap: the loose substring check matches this content.
    assert.equal(section.includes("Binary files "), true, name);
    assert.equal(sectionIsBinary(section), false, name);
  }
});

test("sections without the marker are not binary", () => {
  for (const path of [
    "src/plain.txt",
    "src/renamed.txt",
    "bin/a b/run.sh",
    "a b/empty.txt",
  ]) {
    const { section } = shapes.find((shape) => shape.path === path);
    assert.equal(sectionIsBinary(section), false, path);
  }
  assert.equal(sectionIsBinary(""), false);
});

test("per-file stats flag the marker section and only it", () => {
  const diff =
    binarySections[0].section +
    contentMentions.map(({ section }) => section).join("");
  assert.deepEqual(diffSectionStats(diff), [
    { path: "img/logo.png", added: 0, deleted: 0, isBinary: true },
    ...contentMentions.map(({ path, added, deleted }) => ({
      path,
      added,
      deleted,
      isBinary: false,
    })),
  ]);
});

// ---------------------------------------------------------------- binaryRows

const rowDiff =
  binarySections.map(({ section }) => section).join("") +
  contentMentions.map(({ section }) => section).join("") +
  ["src/renamed.txt", "bin/a b/run.sh", "a b/empty.txt", "img/a b/logo.png"]
    .map((path) => shapes.find((shape) => shape.path === path).section)
    .join("");

test("rows flag binary only at 0/0 forge counts over a marker section", () => {
  const sections = splitUnifiedDiff(rowDiff);
  const files = [
    ...binarySections.map(({ path }) => ({ path, additions: 0, deletions: 0 })),
    // A spaced binary path from the quoting fixtures.
    { path: "img/a b/logo.png", additions: 0, deletions: 0 },
    // Text rows keep their counts.
    ...contentMentions.map(({ path, added, deleted }) => ({
      path,
      additions: added,
      deletions: deleted,
    })),
    // Pure rename, mode-only change and empty new file: 0/0, no marker.
    { path: "src/renamed.txt", additions: 0, deletions: 0 },
    { path: "bin/a b/run.sh", additions: 0, deletions: 0 },
    { path: "a b/empty.txt", additions: 0, deletions: 0 },
    // A row the (truncated) diff has no section for.
    { path: "img/missing.png", additions: 0, deletions: 0 },
  ];
  assert.deepEqual(
    [...binaryRowPaths(files, sections)].sort(),
    [...binarySections.map(({ path }) => path), "img/a b/logo.png"].sort(),
  );
});

test("a marker section under nonzero forge counts keeps the counts", () => {
  // GitHub's too-large fallback writes the marker for huge text files too, and
  // a moved head can pair new counts with an old diff.
  const sections = splitUnifiedDiff(binarySections[0].section);
  for (const counts of [
    { additions: 1200, deletions: 0 },
    { additions: 0, deletions: 3 },
    { additions: 5, deletions: 5 },
  ])
    assert.deepEqual(
      [...binaryRowPaths([{ path: "img/logo.png", ...counts }], sections)],
      [],
      JSON.stringify(counts),
    );
});

test("a one-file binary PR flags its only row", () => {
  const { path, section } = binarySections[0];
  assert.deepEqual(
    [
      ...binaryRowPaths(
        [{ path, additions: 0, deletions: 0 }],
        splitUnifiedDiff(section),
      ),
    ],
    [path],
  );
});

test("empty files or an empty section map flag nothing", () => {
  const sections = splitUnifiedDiff(rowDiff);
  assert.deepEqual([...binaryRowPaths([], sections)], []);
  assert.deepEqual([...binaryRowPaths([], new Map())], []);
  assert.deepEqual(
    [
      ...binaryRowPaths(
        [{ path: "img/logo.png", additions: 0, deletions: 0 }],
        splitUnifiedDiff(""),
      ),
    ],
    [],
  );
});
