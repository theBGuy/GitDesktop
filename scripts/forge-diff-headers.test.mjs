// Classifies the forge-synthesized diff text the Rust reconstructors emit
// (GitLab's reconstruct_file_diff in forge/gitlab.rs, GitHub's >300-file
// reconstruct_pr_diff in github/pr.rs). Each literal is the exact string a Rust
// unit test pins, so the two sides meet on shared text: change one, change both.
// Dep-free like diff-split.test.mjs: the import reaches straight into src/.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  binaryRowPaths,
  classifyHeaderOnlyDiff,
  DIFF_SECTION_BOUNDARY,
  sectionFilePath,
  sectionIsBinary,
  splitUnifiedDiff,
} from "../src/lib/git/diff-split.ts";

const QUOTED_FORGED = "evil\\n+++ b/ok.txt\\ndiff --git a/ok.txt b/ok.txt";
const FORGED = "evil\n+++ b/ok.txt\ndiff --git a/ok.txt b/ok.txt";

/** One header-only section per Rust test: its key and its classification. */
const headerOnly = [
  {
    name: "GitLab rename without hunks",
    text: 'diff --git a/old3.txt "b/\\"escaped\\".txt"\nrename from old3.txt\nrename to "\\"escaped\\".txt"\n',
    path: '"escaped".txt',
    want: { kind: "rename", oldPath: "old3.txt", newPath: '"escaped".txt' },
  },
  {
    name: "GitLab mode-only change",
    text: "diff --git a/bin/run.sh b/bin/run.sh\nold mode 100644\nnew mode 100755\n",
    path: "bin/run.sh",
    want: {
      kind: "mode",
      transition: "to-exec",
      oldMode: "100644",
      newMode: "100755",
    },
  },
  {
    name: "GitLab new empty file",
    text: "diff --git a/.gitkeep b/.gitkeep\nnew file mode 100644\n",
    path: ".gitkeep",
    want: { kind: "new-empty" },
  },
  {
    name: "GitLab rename with a control byte",
    text: 'diff --git a/src/mixed.txt "b/src/mixed\\rname.txt"\nrename from src/mixed.txt\nrename to "src/mixed\\rname.txt"\n',
    path: "src/mixed\rname.txt",
    want: {
      kind: "rename",
      oldPath: "src/mixed.txt",
      newPath: "src/mixed\rname.txt",
    },
  },
  {
    name: "GitHub fallback pure rename",
    text: "diff --git a/docs/old.md b/docs/new-name.md\nrename from docs/old.md\nrename to docs/new-name.md\n",
    path: "docs/new-name.md",
    want: {
      kind: "rename",
      oldPath: "docs/old.md",
      newPath: "docs/new-name.md",
    },
  },
  {
    name: "GitHub fallback copy",
    text: "diff --git a/lib/orig.rs b/lib/copy.rs\ncopy from lib/orig.rs\ncopy to lib/copy.rs\n",
    path: "lib/copy.rs",
    want: { kind: "copy", oldPath: "lib/orig.rs", newPath: "lib/copy.rs" },
  },
];

for (const { name, text, path, want } of headerOnly) {
  test(`${name} keys by its new path and classifies header-only`, () => {
    const sections = splitUnifiedDiff(text);
    assert.deepEqual([...sections.keys()], [path]);
    const section = sections.get(path);
    assert.equal(sectionIsBinary(section), false);
    const got = classifyHeaderOnlyDiff(section);
    assert.ok(got, "classified");
    for (const [key, value] of Object.entries(want))
      assert.equal(got[key], value, key);
  });
}

// GitHub fallback: an empty added file, an empty removed file, then a file the
// marker is kept for (a rename without a usable pair) — first, middle, last.
const GITHUB_EMPTY_PAIR =
  "diff --git a/.gitkeep b/.gitkeep\nnew file mode 100644\n" +
  "diff --git a/old/.gitkeep b/old/.gitkeep\ndeleted file mode 100644\n";
const GITHUB_KEPT_MARKER =
  "diff --git a/same.txt b/same.txt\nBinary files a/same.txt and b/same.txt differ\n";

test("a multi-file fallback diff keys every section at its boundary", () => {
  const sections = splitUnifiedDiff(GITHUB_EMPTY_PAIR + GITHUB_KEPT_MARKER);
  assert.deepEqual(
    [...sections.keys()],
    [".gitkeep", "old/.gitkeep", "same.txt"],
  );
  assert.equal(
    classifyHeaderOnlyDiff(sections.get(".gitkeep"))?.kind,
    "new-empty",
  );
  assert.equal(
    classifyHeaderOnlyDiff(sections.get("old/.gitkeep"))?.kind,
    "deleted-empty",
  );
  const kept = sections.get("same.txt");
  assert.equal(classifyHeaderOnlyDiff(kept), null);
  assert.equal(sectionIsBinary(kept), true);
});

test("binaryRowPaths flags only the kept-marker file", () => {
  const sections = splitUnifiedDiff(
    headerOnly.map((s) => s.text).join("") + GITHUB_KEPT_MARKER,
  );
  const files = [...sections.keys()].map((path) => ({
    path,
    additions: 0,
    deletions: 0,
  }));
  assert.equal(files.length, headerOnly.length + 1);
  assert.deepEqual([...binaryRowPaths(files, sections)], ["same.txt"]);
});

test("a forged path on header-only lines cannot add a section", () => {
  const text =
    `diff --git "a/src/mixed\\rname.txt" "b/${QUOTED_FORGED}"\n` +
    `rename from "src/mixed\\rname.txt"\nrename to "${QUOTED_FORGED}"\n` +
    `diff --git "a/${QUOTED_FORGED}" "b/${QUOTED_FORGED}"\nnew file mode 100644\n`;
  const parts = text.split(DIFF_SECTION_BOUNDARY);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(sectionFilePath), [FORGED, FORGED]);
  assert.deepEqual(
    parts.map((p) => classifyHeaderOnlyDiff(p)?.kind),
    ["rename", "new-empty"],
  );
});
