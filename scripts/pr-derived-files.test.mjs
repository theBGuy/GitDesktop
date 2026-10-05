// Pins the file list a PR prompt reads off the diff when the forge's file-list
// read came back empty: per-file counts from `diffSectionStats`, the disclosure
// both prompt builders append, and the gate the description generator shares.
// A non-empty list must render exactly as `assemble_pr_recipe` in generate.rs
// does, since the MCP twin's git lists never derive.
//
// `prompt.ts` imports extensionless and through `@/`, so the shared src hooks
// go in first and the imports are dynamic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { diffSectionStats } = await import("@/lib/git/diff-split");
const { buildPrPrompt, buildReviewPrompt, promptFileList } = await import(
  "@/lib/ai/prompt"
);

const DERIVED_LINE = "[file list derived from the diff]";

// Two edits (one with a `+++`/`---`-spelled hunk line each), a binary, a pure
// rename with no `+++` line, and a C-quoted non-ASCII path.
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+++plus",
  "diff --git a/src/b.rs b/src/b.rs",
  "--- a/src/b.rs",
  "+++ b/src/b.rs",
  "@@ -1 +1 @@",
  "--- dashes",
  "+x",
  "diff --git a/img.png b/img.png",
  "index 3333333..4444444 100644",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/old.txt b/new.txt",
  "similarity index 100%",
  "rename from old.txt",
  "rename to new.txt",
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  "new file mode 100644",
  "--- /dev/null",
  '+++ "b/caf\\303\\251.txt"',
  "@@ -0,0 +1 @@",
  "+hi",
  "",
].join("\n");

const EXPECTED = [
  { path: "src/a.ts", added: 2, deleted: 1, isBinary: false },
  { path: "src/b.rs", added: 1, deleted: 1, isBinary: false },
  { path: "img.png", added: 0, deleted: 0, isBinary: true },
  { path: "new.txt", added: 0, deleted: 0, isBinary: false },
  { path: "café.txt", added: 1, deleted: 0, isBinary: false },
];

const EXPECTED_SECTION = [
  "## Files changed",
  "src/a.ts +2 -1",
  "src/b.rs +1 -1",
  "img.png (binary)",
  "new.txt +0 -0",
  "café.txt +1 -0",
  DERIVED_LINE,
].join("\n");

const PR_BASE = {
  diffTruncated: false,
  commitSubjects: [],
  baseBranch: "main",
  headBranch: "feat",
  repoInstructions: null,
  globalInstructions: "",
  availableLabels: [],
};

const REVIEW_BASE = {
  title: "t",
  body: "",
  commitSubjects: [],
  diffTruncated: false,
};

/** The "## Files changed" section of a rendered prompt. */
function filesSection(prompt) {
  const start = prompt.indexOf("## Files changed");
  assert.ok(start >= 0, "prompt has no Files changed section");
  const end = prompt.indexOf("\n\n", start);
  return prompt.slice(start, end < 0 ? undefined : end);
}

test("diffSectionStats names every section and counts only hunk lines", () => {
  assert.deepEqual(diffSectionStats(DIFF), EXPECTED);
});

test("diffSectionStats reads a CRLF diff to the same list", () => {
  assert.deepEqual(diffSectionStats(DIFF.replaceAll("\n", "\r\n")), EXPECTED);
});

test("an unkeyable or non-string input never blanks the rest", () => {
  const withJunk = `diff --git garbage\n+x\n${DIFF}diff --git nonsense\n`;
  assert.deepEqual(diffSectionStats(withJunk), EXPECTED);
  assert.deepEqual(diffSectionStats(undefined), []);
  assert.deepEqual(diffSectionStats(""), []);
});

test("promptFileList derives only for an empty list beside a non-empty diff", () => {
  assert.deepEqual(promptFileList([], DIFF), {
    files: EXPECTED,
    derived: true,
  });
  // A genuinely empty diff keeps the description generator's refusal.
  assert.deepEqual(promptFileList([], ""), { files: [], derived: false });
  assert.deepEqual(promptFileList([], " \n"), { files: [], derived: false });
  const listed = [{ path: "x", added: 1, deleted: 0, isBinary: false }];
  assert.deepEqual(promptFileList(listed, DIFF), {
    files: listed,
    derived: false,
  });
});

test("both prompt builders list derived files under the same disclosure", () => {
  const pr = buildPrPrompt({ ...PR_BASE, diffText: DIFF, files: [] }).prompt;
  const review = buildReviewPrompt(
    { ...REVIEW_BASE, diffText: DIFF, files: [] },
    "general",
  ).prompt;
  assert.equal(filesSection(pr), EXPECTED_SECTION);
  assert.equal(filesSection(review), EXPECTED_SECTION);
});

test("the ignore-rules line still follows a derived list", () => {
  const pr = buildPrPrompt({
    ...PR_BASE,
    diffText: DIFF,
    files: [],
    excludedFiles: 2,
  }).prompt;
  assert.equal(
    filesSection(pr),
    `${EXPECTED_SECTION}\n[2 additional changed file(s) hidden by the user's AI ignore rules]`,
  );
});

test("an empty list beside an empty diff still renders (none)", () => {
  const pr = buildPrPrompt({ ...PR_BASE, diffText: "", files: [] }).prompt;
  const review = buildReviewPrompt(
    { ...REVIEW_BASE, diffText: "", files: [] },
    "general",
  ).prompt;
  assert.equal(filesSection(pr), "## Files changed\n(none)");
  assert.equal(filesSection(review), "## Files changed\n(none)");
});

// The Rust files section, pinned as whitespace-collapsed source text before its
// test module, with the TS side rendered for real against the same list.
const RUST_PR_FILES_SECTION =
  'let mut files_section = format!( "## Files changed\\n{}", if file_summary.is_empty() { "(none)" } else { &file_summary } );';
const RUST_FILE_SUMMARY_LINE =
  'if f.is_binary { format!("{} (binary)", f.path) } else { format!("{} +{} -{}", f.path, f.added, f.deleted) }';

test("a listed PR file section matches generate.rs and never discloses", () => {
  const raw = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src-tauri/src/mcp_server/generate.rs",
    ),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const testsAt = raw.indexOf("\n#[cfg(test)]\nmod tests");
  assert.ok(testsAt > 0, "generate.rs test module marker not found");
  const source = raw.slice(0, testsAt);
  const recipeAt = source.indexOf("fn assemble_pr_recipe(");
  assert.ok(recipeAt > 0, "assemble_pr_recipe not found");
  const recipe = source.slice(recipeAt, source.indexOf("\nfn ", recipeAt + 1));
  assert.ok(
    recipe.replace(/\s+/g, " ").includes(RUST_PR_FILES_SECTION),
    "generate.rs PR files section drifted from its pinned format",
  );
  assert.ok(
    source.replace(/\s+/g, " ").includes(RUST_FILE_SUMMARY_LINE),
    "generate.rs file summary line drifted from its pinned format",
  );
  const files = [
    { path: "x.rs", added: 3, deleted: 1, isBinary: false },
    { path: "y.png", added: 0, deleted: 0, isBinary: true },
  ];
  const pr = buildPrPrompt({ ...PR_BASE, diffText: DIFF, files }).prompt;
  assert.equal(
    filesSection(pr),
    "## Files changed\nx.rs +3 -1\ny.png (binary)",
  );
});

// The forge's files read failed or capped: a partial list says so, an empty one
// says unavailable, and the flag changes nothing when unset or when derived.
const PARTIAL_LINE =
  "[file list may be incomplete — the diff is authoritative]";
const UNAVAILABLE_LINE = "[file list unavailable — the diff is authoritative]";

/** The Files changed section from both builders, which must agree. */
function bothFilesSections(diffText, files, filesUnknown) {
  const pr = buildPrPrompt({ ...PR_BASE, diffText, files, filesUnknown });
  const review = buildReviewPrompt(
    { ...REVIEW_BASE, diffText, files, filesUnknown },
    "general",
  );
  const fromPr = filesSection(pr.prompt);
  assert.equal(filesSection(review.prompt), fromPr);
  return fromPr;
}

test("filesUnknown absent or false renders byte-identically", () => {
  const files = [{ path: "x.rs", added: 3, deleted: 1, isBinary: false }];
  for (const unknown of [undefined, false]) {
    assert.equal(bothFilesSections(DIFF, [], unknown), EXPECTED_SECTION);
    assert.equal(
      bothFilesSections(DIFF, files, unknown),
      "## Files changed\nx.rs +3 -1",
    );
    assert.equal(
      bothFilesSections("", [], unknown),
      "## Files changed\n(none)",
    );
  }
});

test("filesUnknown discloses a partial or unavailable list in both builders", () => {
  const files = [{ path: "x.rs", added: 3, deleted: 1, isBinary: false }];
  assert.equal(
    bothFilesSections(DIFF, files, true),
    `## Files changed\nx.rs +3 -1\n${PARTIAL_LINE}`,
  );
  assert.equal(
    bothFilesSections("", [], true),
    `## Files changed\n(none)\n${UNAVAILABLE_LINE}`,
  );
  // A derived list is whole from the diff, so it keeps its own single line.
  assert.equal(bothFilesSections(DIFF, [], true), EXPECTED_SECTION);
});
