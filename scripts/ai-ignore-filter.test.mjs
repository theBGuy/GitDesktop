// Pins how `filterDiffByAiIgnore` rebuilds a unified diff: a section no key
// decodes is withheld while AI-ignore patterns are active (it was never checked
// against them) and kept when none are, survivors come back byte-for-byte, and
// two sections sharing a key (a typechange's halves) both survive.
//
// `ignore.ts` value-imports the git api barrel through the `@/` alias, and that
// barrel pulls @tauri-apps/api, so the src-import hooks go in first, every src
// import below is DYNAMIC, and the suite skips in the installless guards job.
// frontend.yml's installed step is the enforced run: it sets GD_EXPECT_DEPS,
// which turns any unresolved import there into a failure.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const MODULE = new URL("../src/lib/ai/ignore.ts", import.meta.url);

let filterDiffByAiIgnore = null;
let installTransport = null;
let skip = false;
try {
  ({ filterDiffByAiIgnore } = await import("@/lib/ai/ignore"));
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
// `diff.noprefix` output: real git, but nothing in it decodes to a key.
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
