// Pins how `filterDiffByAiIgnore` rebuilds a unified diff: a section no key
// decodes is withheld while AI-ignore patterns are active (it was never checked
// against them) and kept when none are, survivors come back byte-for-byte, and
// two sections sharing a key (a typechange's halves) both survive. Also pins
// cause attribution over its counts and `filterPathsByAiIgnore`'s, and the
// prompts' hidden-file notes against their generate.rs twins byte for byte.
//
// `ignore.ts` value-imports the git api barrel through the `@/` alias, and that
// barrel pulls @tauri-apps/api, so the src-import hooks go in first, every src
// import below is DYNAMIC, and the suite skips in the installless guards job.
// frontend.yml's installed step is the enforced run: it sets GD_EXPECT_DEPS,
// which turns any unresolved import there into a failure.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const MODULE = new URL("../src/lib/ai/ignore.ts", import.meta.url);

let filterDiffByAiIgnore = null;
let filterPathsByAiIgnore = null;
let emptyDiffCause = null;
let hiddenCause = null;
let unreadableNameCount = null;
let prompts = null;
let installTransport = null;
let skip = false;
try {
  ({
    filterDiffByAiIgnore,
    filterPathsByAiIgnore,
    emptyDiffCause,
    hiddenCause,
    unreadableNameCount,
  } = await import("@/lib/ai/ignore"));
  prompts = await import("@/lib/ai/prompt");
  ({ installTransport } = await import("@/lib/transport"));
} catch (err) {
  if (
    process.env.GD_EXPECT_DEPS ||
    err?.code !== "ERR_MODULE_NOT_FOUND" ||
    !existsSync(MODULE)
  )
    throw err;
  skip =
    "needs node_modules — frontend.yml's installed step is the enforced run";
}

// The one backend call the filter makes, answered the way git's matcher would
// for literal-path patterns: a path is hidden when a pattern names it exactly.
// Bound through the transport seam every `invoke()` routes through.
const calls = [];
installTransport?.({
  async invoke(cmd, args) {
    calls.push({ cmd, args });
    if (cmd !== "git_filter_ai_ignored") throw new Error(`unexpected ${cmd}`);
    return args.paths.filter((p) => args.exclude.includes(p));
  },
});

const B = String.fromCharCode(92);

const KEEP =
  "diff --git a/src/keep.txt b/src/keep.txt\n" +
  "index 1111111..2222222 100644\n" +
  "--- a/src/keep.txt\n" +
  "+++ b/src/keep.txt\n" +
  "@@ -1 +1 @@\n-old\n+new\n";
const QUOTED =
  `diff --git "a/src/caf${B}303${B}251.txt" "b/src/caf${B}303${B}251.txt"\n` +
  "deleted file mode 100644\n" +
  `--- "a/src/caf${B}303${B}251.txt"\n` +
  "+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n-removed\n";
const SPACED =
  "diff --git a/docs/space name.txt b/docs/space name.txt\n" +
  "--- a/docs/space name.txt\t\n" +
  "+++ b/docs/space name.txt\t\n" +
  "@@ -1 +1 @@\n-old\n+new\n";
const SECRET =
  "diff --git a/secret.txt b/secret.txt\n" +
  "--- a/secret.txt\n" +
  "+++ b/secret.txt\n" +
  "@@ -1 +1 @@\n-hush\n+still hush\n";
// An unkeyable section: noprefix-shaped text from a non-runner source, with
// nothing in it that decodes to a key.
const NOPREFIX =
  "diff --git src/plain.txt src/plain.txt\n" +
  "--- src/plain.txt\n" +
  "+++ src/plain.txt\n" +
  "@@ -1 +1 @@\n-a\n+b\n";
// A deletion whose name carries a raw LF, as an unquoting synthesizer wrote it.
const RAW_LF_DELETION =
  "diff --git a/evil\nname.txt b/evil\nname.txt\n" +
  "deleted file mode 100644\n" +
  "--- a/evil\nname.txt\n" +
  "+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n-secret\n";

function run(text, exclude, files = []) {
  calls.length = 0;
  return filterDiffByAiIgnore({ repoPath: "/repo", text, files, exclude });
}

test("no patterns: an unkeyable section stays", { skip }, async () => {
  const text = KEEP + NOPREFIX;
  const out = await run(text, []);
  assert.equal(out.text, text);
  assert.equal(out.excludedFiles, 0);
  assert.equal(out.unreadableFiles, 0);
  assert.equal(calls.length, 0);
});

test("patterns active: an unkeyable section drops", { skip }, async () => {
  // No key ties the section to its file entry, so the entry stays listed and
  // the drop counts as unreadable only, never as a pattern match.
  const files = [{ path: "src/keep.txt" }, { path: "evil\nname.txt" }];
  const out = await run(KEEP + RAW_LF_DELETION, ["nothing-matches.txt"], files);
  assert.equal(out.text, KEEP);
  assert.deepEqual(out.files, files);
  assert.equal(out.excludedFiles, 0);
  assert.equal(out.unreadableFiles, 1);
  assert.deepEqual(calls[0].args.paths, ["src/keep.txt", "evil\nname.txt"]);
});

test("no patterns: U+FFFD drops, unkeyable stays", { skip }, async () => {
  const bad = `bad${String.fromCharCode(0xfffd)}.txt`;
  const lossy =
    `diff --git a/${bad} b/${bad}\n` +
    `--- a/${bad}\n` +
    `+++ b/${bad}\n` +
    "@@ -1 +1 @@\n-a\n+b\n";
  const out = await run(lossy + NOPREFIX + KEEP, []);
  assert.equal(out.text, NOPREFIX + KEEP);
  assert.equal(out.excludedFiles, 1);
  assert.equal(out.unreadableFiles, 1);
  assert.equal(calls.length, 0);
});

test("patterns active: a preamble counts unreadable", { skip }, async () => {
  const preamble = "From 1234567 Mon Sep 17 00:00:00 2001\nSubject: x\n\n";
  const out = await run(preamble + KEEP + SECRET, ["secret.txt"]);
  assert.equal(out.text, KEEP);
  assert.equal(out.excludedFiles, 1);
  assert.equal(out.unreadableFiles, 1);
});

test("a well-formed diff comes back byte-identical", { skip }, async () => {
  const text = KEEP + QUOTED + SPACED;
  const out = await run(text, ["nothing-matches.txt"]);
  assert.equal(out.text, text);
  assert.equal(out.excludedFiles, 0);
  assert.equal(out.unreadableFiles, 0);
  assert.deepEqual(calls[0].args.paths, [
    "src/keep.txt",
    "src/café.txt",
    "docs/space name.txt",
  ]);
});

test("both halves of a typechange survive filtering", { skip }, async () => {
  const symlinkHalf =
    "diff --git a/link b/link\n" +
    "deleted file mode 120000\n" +
    "--- a/link\n" +
    "+++ /dev/null\n" +
    "@@ -1 +0,0 @@\n-target\n" +
    `${B} No newline at end of file\n`;
  const fileHalf =
    "diff --git a/link b/link\n" +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    "+++ b/link\n" +
    "@@ -0,0 +1 @@\n+content\n";
  const files = [{ path: "link" }, { path: "secret.txt" }];
  const out = await run(symlinkHalf + SECRET + fileHalf, ["secret.txt"], files);
  assert.equal(out.text, symlinkHalf + fileHalf);
  assert.deepEqual(out.files, [{ path: "link" }]);
  assert.equal(out.excludedFiles, 1);
  assert.equal(out.unreadableFiles, 0);
});

const FFFD = String.fromCharCode(0xfffd);
const lossySection = (name) =>
  `diff --git a/${name} b/${name}\n` +
  `--- a/${name}\n` +
  `+++ b/${name}\n` +
  "@@ -1 +1 @@\n-a\n+b\n";

// The four ways a review diff can come back empty, each named for its cause.
test("an emptied diff names its true cause", { skip }, async () => {
  const cases = [
    // (i) pattern-hidden only
    ["pattern-hidden", SECRET, ["secret.txt"], "excluded", 0],
    // (ii) an unreadable name with ZERO patterns
    [
      "unreadable, no patterns",
      lossySection(`a${FFFD}.txt`),
      [],
      "unreadable-names",
      1,
    ],
    // an unreadable name while patterns are active: the name, not the checker
    [
      "unreadable, patterns active",
      lossySection(`a${FFFD}.txt`),
      ["nothing-matches.txt"],
      "unreadable-names",
      1,
    ],
    // (iii) both causes on names
    [
      "pattern + unreadable",
      SECRET + lossySection(`a${FFFD}.txt`),
      ["secret.txt"],
      "unreadable-names",
      1,
    ],
    // (iv) an unkeyable section while patterns are active
    ["unkeyable", RAW_LF_DELETION, ["secret.txt"], "withheld", 0],
    ["nothing at all", "", ["secret.txt"], null, 0],
  ];
  for (const [label, text, exclude, cause, names] of cases) {
    const out = await run(text, exclude);
    assert.equal(out.text.trim(), "", label);
    assert.equal(emptyDiffCause(out), cause, label);
    assert.equal(unreadableNameCount(out), names, label);
    assert.ok(unreadableNameCount(out) <= out.excludedFiles, label);
  }
  // The raw pair is not a subset: an unkeyable section counts unreadable only.
  const unkeyable = await run(RAW_LF_DELETION, ["secret.txt"]);
  assert.equal(unkeyable.unkeyableSections, 1);
  assert.equal(unkeyable.unreadableFiles, 1);
  assert.equal(unkeyable.excludedFiles, 0);
});

test("hiddenCause reads a subset pair", { skip }, () => {
  assert.equal(hiddenCause(0, 0), null);
  assert.equal(hiddenCause(3, 0), "patterns");
  assert.equal(hiddenCause(2, 2), "unreadable");
  assert.equal(hiddenCause(3, 1), "both");
});

// (v) The listing route judges the backend's byte flag, not the spelling: a real
// U+FFFD name reaches the matcher and gets its verdict, a lost byte never does.
test("listing rows fail closed on the flag alone", { skip }, async () => {
  const real = `x${FFFD}y.txt`;
  const lost = `caf${FFFD}.txt`;
  const rows = [
    { path: "keep.txt", undecodable: false },
    { path: real, undecodable: false },
    { path: lost, undecodable: true },
    { path: "secret.txt", undecodable: false },
  ];
  calls.length = 0;
  const out = await filterPathsByAiIgnore({
    repoPath: "/repo",
    paths: rows,
    exclude: ["secret.txt"],
  });
  assert.deepEqual(out.paths, ["keep.txt", real]);
  assert.equal(out.excluded, 2);
  assert.equal(out.unreadable, 1);
  assert.deepEqual(calls[0].args.paths, ["keep.txt", real, "secret.txt"]);

  calls.length = 0;
  const matched = await filterPathsByAiIgnore({
    repoPath: "/repo",
    paths: [{ path: real, undecodable: false }],
    exclude: [real],
  });
  assert.deepEqual(matched, { paths: [], excluded: 1, unreadable: 0 });

  calls.length = 0;
  const none = await filterPathsByAiIgnore({
    repoPath: "/repo",
    paths: rows,
    exclude: [],
  });
  assert.deepEqual(none.paths, ["keep.txt", real, "secret.txt"]);
  assert.equal(none.unreadable, 1);
  assert.equal(calls.length, 0);
});

// The three hidden-file note forms per recipe, read straight out of generate.rs:
// each `"\n[…]"` literal in the recipe body, continuations joined, with
// `{pattern_hidden}` and the positional `{}` (always the unreadable count) filled.
function rustNotes(fnName, patternHidden, unreadable) {
  const raw = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src-tauri/src/mcp_server/generate.rs",
    ),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const at = raw.indexOf(`\nfn ${fnName}(`) + 1;
  assert.ok(at > 0, `top-level ${fnName} not found`);
  // Up to the next column-0 item of any kind (fn, impl, mod, attribute, doc
  // comment…): only the function's own closing brace sits at column 0 inside it.
  const end = raw.slice(at + 1).search(/\n[^\s}]/);
  assert.ok(end > 0, `${fnName}: no item follows it`);
  const body = raw.slice(at, at + 1 + end);
  const notes = [];
  for (const m of body.matchAll(/"\\n\[((?:[^"\\]|\\.)*)"/gs)) {
    const text = m[1].replace(/\\\n\s*/g, "");
    if (!/AI ignore rules|readable text/.test(text)) continue;
    notes.push(
      `\n[${text
        .replaceAll("{pattern_hidden}", String(patternHidden))
        .replaceAll("{}", String(unreadable))}`,
    );
  }
  return notes;
}

/** The hidden-file note a built prompt carries, or "" when it has none. */
const noteOf = (prompt) => {
  const m = prompt.match(/\n\[[^\n]*(?:AI ignore rules|readable text)[^\n]*\]/);
  return m ? m[0] : "";
};

test("hidden-file notes match generate.rs byte for byte", { skip }, () => {
  const P = 7;
  const U = 3;
  const counts = [
    [P + U, U],
    [P, 0],
    [U, U],
  ];
  const base = {
    diffText: "",
    diffTruncated: false,
    files: [],
    repoInstructions: null,
    globalInstructions: "",
  };
  const builders = {
    assemble_commit_recipe: (excludedFiles, unreadableFiles) =>
      prompts.buildCommitPrompt({
        ...base,
        excludedFiles,
        unreadableFiles,
        recentSubjects: [],
      }).prompt,
    assemble_pr_recipe: (excludedFiles, unreadableFiles) =>
      prompts.buildPrPrompt({
        ...base,
        excludedFiles,
        unreadableFiles,
        commitSubjects: [],
        baseBranch: "main",
        headBranch: "feat",
        availableLabels: [],
      }).prompt,
    assemble_branch_recipe: (excludedFiles, unreadableFiles) =>
      prompts.buildBranchNamePrompt({
        ...base,
        untrackedPaths: [],
        excludedFiles,
        unreadableFiles,
        commitSubjects: [],
        recentBranches: [],
      }).prompt,
  };
  for (const [fnName, build] of Object.entries(builders)) {
    const rust = rustNotes(fnName, P, U);
    assert.equal(rust.length, 3, `${fnName}: three forms in generate.rs`);
    const ts = counts.map(([excluded, unreadable]) =>
      noteOf(build(excluded, unreadable)),
    );
    assert.deepEqual(ts.toSorted(), rust.toSorted(), fnName);
    assert.equal(noteOf(build(0, 0)), "", `${fnName}: nothing hidden`);
  }
  // Fed the raw filter pair instead of `unreadableNameCount`, an unkeyable-only
  // diff (0 hidden names, 1 withheld section) would claim an unreadable name.
  const review = (unreadableFiles) =>
    noteOf(
      prompts.buildReviewPrompt(
        {
          ...base,
          title: "",
          body: "",
          commitSubjects: [],
          excludedFiles: 0,
          unreadableFiles,
        },
        "general",
      ).prompt,
    );
  assert.equal(
    review(unreadableNameCount({ unreadableFiles: 1, unkeyableSections: 1 })),
    "",
  );
});
