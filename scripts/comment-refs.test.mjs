// Pins the forge-reference detector that keeps a posted AI review from minting
// stray cross-references, plus the branded comment body it feeds. The prior fix
// for this was prompt-only and shipped no test, which is why the regression came
// back unnoticed.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6) — that pairing is itself under test: stripping ERASES types
// rather than compiling them and resolves no bundler aliases, so
// `comment-branding.ts` must stay dependency-free and erasable-syntax-only. A
// runtime import added there fails this file, which is the point.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAiCommentBody,
  findSuspectRefs,
  formatRefList,
  neutralizeSuspectRefs,
} from "../src/lib/ai/comment-branding.ts";

// ------------------------------------------------------------ findSuspectRefs

test("a bare reference in prose is a hit", () => {
  assert.deepEqual(findSuspectRefs("Fixes #123 now"), ["#123"]);
});

test("parentheses do not neutralize a reference", () => {
  assert.deepEqual(findSuspectRefs("See (#123) for detail"), ["#123"]);
});

test("a list item's reference is a hit", () => {
  assert.deepEqual(findSuspectRefs("- fixes #7"), ["#7"]);
});

test("an inline code span hides its references", () => {
  assert.deepEqual(findSuspectRefs("the token `#123` stays plain"), []);
  // A doubled run closes only on a run of exactly two.
  assert.deepEqual(findSuspectRefs("``a ` #123``"), []);
});

test("a backtick fence hides its references, with or without a language tag", () => {
  assert.deepEqual(findSuspectRefs("```\nFixes #123\n```\n"), []);
  assert.deepEqual(findSuspectRefs("```ts\n// Fixes #123\n```\n"), []);
  // An unterminated fence runs to EOF.
  assert.deepEqual(findSuspectRefs("```\nFixes #123\n"), []);
});

test("a tilde fence hides its references", () => {
  assert.deepEqual(findSuspectRefs("~~~\nFixes #123\n~~~\n"), []);
  // A backtick line inside a tilde fence is content, not a close.
  assert.deepEqual(findSuspectRefs("~~~\n```\n#123\n~~~\n"), []);
});

test("markdown link syntax hides references in the label AND the destination", () => {
  assert.deepEqual(findSuspectRefs("[issue #123](https://x.test)"), []);
  // The destination arm needs a token the boundary rule would otherwise admit,
  // or the `/` before it does the work and the skip goes untested.
  assert.deepEqual(findSuspectRefs("[see it](x.test -#123)"), []);
  assert.deepEqual(findSuspectRefs("see it: x.test -#123"), ["#123"]);
});

test("a URL fragment is not a reference", () => {
  assert.deepEqual(findSuspectRefs("https://x.test/p#123"), []);
});

test("a word character before the trigger keeps it plain", () => {
  assert.deepEqual(findSuspectRefs("abc#123"), []);
});

test("an HTML entity is not a reference", () => {
  assert.deepEqual(findSuspectRefs("&#39;"), []);
});

test("no forge numbers an item 0", () => {
  assert.deepEqual(findSuspectRefs("#0"), []);
  assert.deepEqual(findSuspectRefs("#0123"), []);
});

test("the number grammar caps at ten digits", () => {
  assert.deepEqual(findSuspectRefs("#1234567890"), ["#1234567890"]);
  assert.deepEqual(findSuspectRefs("#12345678901"), []);
});

test("a trailing word character keeps the token plain", () => {
  assert.deepEqual(findSuspectRefs("#12a"), []);
});

test("an indented code line hides its references", () => {
  assert.deepEqual(findSuspectRefs("prose\n\n    Fixes #123\n"), []);
  assert.deepEqual(findSuspectRefs("prose\n\n\tFixes #123\n"), []);
  // Three spaces is prose, not code.
  assert.deepEqual(findSuspectRefs("   Fixes #123\n"), ["#123"]);
});

test("the trigger set decides what counts", () => {
  assert.deepEqual(findSuspectRefs("see !45", ["#", "!"]), ["!45"]);
  assert.deepEqual(findSuspectRefs("see !45", ["#"]), []);
  // Bitbucket autolinks nothing, so an empty trigger set finds nothing.
  assert.deepEqual(findSuspectRefs("see #45 and !45", []), []);
});

test("repeats collapse to one entry and order is first appearance", () => {
  assert.deepEqual(findSuspectRefs("#12 then again #12"), ["#12"]);
  assert.deepEqual(findSuspectRefs("#12 then #45"), ["#12", "#45"]);
  assert.deepEqual(findSuspectRefs("#45 then #12"), ["#45", "#12"]);
});

test("empty text finds nothing", () => {
  assert.deepEqual(findSuspectRefs(""), []);
  assert.deepEqual(findSuspectRefs("#"), []);
});

// ------------------------------------------------------ neutralizeSuspectRefs

test("wrapping backticks the token only, never the surrounding punctuation", () => {
  assert.equal(neutralizeSuspectRefs("Fixes #12 now").text, "Fixes `#12` now");
  assert.equal(
    neutralizeSuspectRefs("recorded decision (#10)").text,
    "recorded decision (`#10`)",
  );
});

test("the wrapped list carries the neutral form, distinct and in order", () => {
  const out = neutralizeSuspectRefs("#12, #45, then #12 again");
  assert.deepEqual(out.wrapped, ["`#12`", "`#45`"]);
});

test("neutralized output has nothing left to find", () => {
  const out = neutralizeSuspectRefs("Fixes #12 and (#45)");
  assert.deepEqual(findSuspectRefs(out.text), []);
});

test("neutralizing is idempotent", () => {
  const once = neutralizeSuspectRefs("Fixes #12 and (#45)");
  const twice = neutralizeSuspectRefs(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.wrapped, []);
});

test("skipped regions come through byte-identical", () => {
  const source = [
    "```ts",
    "// Fixes #123",
    "```",
    "",
    "an inline `#7` span, a [link #8](https://x.test/#9), and",
    "",
    "    indented #10",
    "",
    "an entity &#39; plus abc#11",
    "",
  ].join("\n");
  const out = neutralizeSuspectRefs(source);
  assert.equal(out.text, source);
  assert.deepEqual(out.wrapped, []);
});

test("text with no references comes through byte-identical", () => {
  const source =
    "No references here — just prose, a # alone, and !not-a-ref.\n";
  const out = neutralizeSuspectRefs(source);
  assert.equal(out.text, source);
  assert.deepEqual(out.wrapped, []);
});

// ----------------------------------------------------------- formatRefList

test("formatRefList joins one, two and three references", () => {
  assert.equal(formatRefList([]), "");
  assert.equal(formatRefList(["#12"]), "#12");
  assert.equal(formatRefList(["#12", "#45"]), "#12 and #45");
  assert.equal(formatRefList(["#12", "#45", "#103"]), "#12, #45, and #103");
});

test("formatRefList names five references and counts the rest", () => {
  const five = ["#1", "#2", "#3", "#4", "#5"];
  assert.equal(formatRefList(five), "#1, #2, #3, #4, and #5");
  assert.equal(
    formatRefList([...five, "#6"]),
    "#1, #2, #3, #4, #5, and 1 more",
  );
  assert.equal(
    formatRefList([...five, "#6", "#7", "#8"]),
    "#1, #2, #3, #4, #5, and 3 more",
  );
});

// -------------------------------------------------------- buildAiCommentBody

/** The shipped template, spelled out rather than derived — a drift tripwire is
 *  worthless if it recomputes the thing it is pinning. Both seams post this. */
const GOLDEN =
  "🤖 **GitDesktop AI review** · `sonnet` · automated\n" +
  "\n" +
  "---\n" +
  "\n" +
  "Looks good to me.\n" +
  "\n" +
  "---\n" +
  "\n" +
  "_Posted by [GitDesktop](https://gitdesktop.app) — AI output, verify before acting on it._";

const PARTS = {
  kind: "review",
  model: "sonnet",
  automated: true,
  text: "Looks good to me.",
};

test("the comment body matches the shipped template", () => {
  assert.equal(buildAiCommentBody(PARTS), GOLDEN);
});

test("a manual (non-automated) body drops the automated marker", () => {
  assert.equal(
    buildAiCommentBody({ ...PARTS, automated: false }),
    GOLDEN.replace(" · automated", ""),
  );
});

test("the neutralize flag changes nothing when there is nothing to wrap", () => {
  assert.equal(buildAiCommentBody({ ...PARTS, neutralizeRefs: true }), GOLDEN);
});

test("the neutralize flag wraps the refs and discloses it once", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: "Recorded decision (#10) and Disclosure #11.",
    neutralizeRefs: true,
  });
  assert.match(body, /Recorded decision \(`#10`\) and Disclosure `#11`\./);
  const disclosures = body.match(/_References /g) ?? [];
  assert.equal(disclosures.length, 1);
  assert.ok(
    body.endsWith(
      "_References `#10` and `#11` are shown as plain text — this automated run could not confirm they were meant to link._",
    ),
    body,
  );
  // The disclosure names the NEUTRAL forms, so it cannot itself cross-reference.
  assert.deepEqual(findSuspectRefs(body), []);
});

test("without the flag the refs are left exactly as written", () => {
  const text = "Recorded decision (#10).";
  const body = buildAiCommentBody({ ...PARTS, text });
  assert.ok(body.includes(text), body);
  assert.ok(!body.includes("_References "), body);
});
