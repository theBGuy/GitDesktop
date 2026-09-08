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

// Backslash-parity fixtures; rule on `isEscaped`, guard below pins the counts.
const ESC_1 = String.raw`\#123`;
const ESC_2 = String.raw`\\#123`;
const ESC_3 = String.raw`\\\#123`;
const ESC_4 = String.raw`\\\\#123`;
const ESCAPED_TICKS = "\\`#123\\`";

test("the escape fixtures carry the backslash runs they claim", () => {
  assert.deepEqual(
    [ESC_1, ESC_2, ESC_3, ESC_4].map((s) => s.indexOf("#")),
    [1, 2, 3, 4],
  );
});

test("an odd backslash run escapes the trigger", () => {
  assert.deepEqual(findSuspectRefs(ESC_1), []);
  assert.deepEqual(findSuspectRefs(ESC_3), []);
  assert.equal(neutralizeSuspectRefs(ESC_1).text, ESC_1);
  assert.deepEqual(neutralizeSuspectRefs(ESC_1).wrapped, []);
  assert.equal(neutralizeSuspectRefs(ESC_3).text, ESC_3);
  assert.deepEqual(findSuspectRefs(String.raw`\!45`, ["#", "!"]), []);
});

test("an even backslash run leaves the reference live", () => {
  assert.deepEqual(findSuspectRefs(ESC_2), ["#123"]);
  assert.deepEqual(findSuspectRefs(ESC_4), ["#123"]);
  const out = neutralizeSuspectRefs(ESC_2);
  // The doubled backslash is self-escaped, so the code span still forms.
  assert.equal(out.text, "\\\\`#123`");
  assert.deepEqual(out.wrapped, ["`#123`"]);
  assert.deepEqual(findSuspectRefs(out.text), []);
});

test("the backslash walk cannot cross a line boundary", () => {
  // A trailing backslash is a markdown hard break, not an escape for the next line.
  assert.deepEqual(findSuspectRefs("foo\\\n#123"), ["#123"]);
});

// Opener pins; why a false region is the dangerous direction is on `scanRefs`.
test("an escaped backtick opens no code span", () => {
  assert.equal(ESCAPED_TICKS.indexOf("#"), 2);
  assert.deepEqual(findSuspectRefs(ESCAPED_TICKS), ["#123"]);
});

test("the fusion separator skips an escaped tick", () => {
  // An escaped tick is a literal the renderer consumes with its backslash — it
  // can't fuse with the wrap's opener, so no space is added beside it.
  const out = neutralizeSuspectRefs("\\`#7");
  assert.equal(out.text, "\\``#7`");
  assert.deepEqual(out.wrapped, ["`#7`"]);
  assert.deepEqual(findSuspectRefs(out.text), []);
});

test("an escaped bracket opens no link", () => {
  assert.deepEqual(findSuspectRefs(String.raw`\[issue #123](https://x.test)`), [
    "#123",
  ]);
});

test("an unmatched backtick run is literal", () => {
  assert.deepEqual(findSuspectRefs("a ` b #6"), ["#6"]);
  // Inline syntax is parsed per paragraph, so a blank line bounds the search for a
  // closing run and both ticks here stay literal.
  assert.deepEqual(findSuspectRefs("` x\n\n#8 `"), ["#8"]);
  // A blank line carrying whitespace is still a paragraph boundary.
  assert.deepEqual(findSuspectRefs("` x\n \t \n#8 `"), ["#8"]);
});

test("a reference adjacent to a closed span is wrapped without fusing", () => {
  assert.deepEqual(findSuspectRefs("`#7`#123"), ["#123"]);
  const out = neutralizeSuspectRefs("`#7`#123");
  // Without the separator the wrap's opener joins the span's closer into a run of
  // two, and the renderer re-reads the whole thing as one longer span.
  assert.equal(out.text, "`#7` `#123`");
  assert.deepEqual(out.wrapped, ["`#123`"]);
});

test("a link label's ticks are live for pairing, so the wrap clears them", () => {
  // Code spans parse before links, so a tick inside a link label can steal a
  // single-tick wrap's opener and leave the reference outside the span.
  const one = neutralizeSuspectRefs("[a ` b](c) #7");
  assert.equal(one.text, "[a ` b](c) ``#7``");
  assert.deepEqual(one.wrapped, ["``#7``"]);
  assert.deepEqual(findSuspectRefs(one.text), []);
  // A run of two in the label cannot pair with a run of one, so L stays 1.
  const two = neutralizeSuspectRefs("[a `` b](c) #7");
  assert.equal(two.text, "[a `` b](c) `#7`");
  const pair = neutralizeSuspectRefs("[a ` b](c) #7 and #8");
  assert.equal(pair.text, "[a ` b](c) ``#7`` and ``#8``");
  assert.deepEqual(pair.wrapped, ["``#7``", "``#8``"]);
});

test("a fence bounds the search for a closing run", () => {
  // The fence opens a block, so the paragraph's tick run never finds a closer and
  // the refs inside the block are never reached.
  assert.deepEqual(findSuspectRefs("note ``` a\n```\n#7\n"), []);
  assert.equal(
    neutralizeSuspectRefs("note ``` a\n```\n#7\n").text,
    "note ``` a\n```\n#7\n",
  );
  // Same reason in the other direction: the paragraph's lone tick is literal, so
  // the ref beside it is live and wraps clear of that stray.
  const out = neutralizeSuspectRefs("prose ` #4\n```\ny `\n```\n");
  assert.deepEqual(findSuspectRefs("prose ` #4\n```\ny `\n```\n"), ["#4"]);
  assert.equal(out.text, "prose ` ``#4``\n```\ny `\n```\n");
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

const SKIPPED_REGIONS = [
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

test("skipped regions come through byte-identical", () => {
  const out = neutralizeSuspectRefs(SKIPPED_REGIONS);
  assert.equal(out.text, SKIPPED_REGIONS);
  assert.deepEqual(out.wrapped, []);
});

test("a stray tick cannot steal the wrap's opener", () => {
  // One unpaired tick in the paragraph makes a single-tick wrap stealable: the
  // stray would pair with the wrap's opener, putting the reference OUTSIDE the
  // resulting span, live, while the disclosure claimed otherwise.
  const out = neutralizeSuspectRefs("a ` b #6");
  assert.equal(out.text, "a ` b ``#6``");
  assert.deepEqual(out.wrapped, ["``#6``"]);
  assert.deepEqual(findSuspectRefs(out.text), []);
});

test("the wrap run length clears every stray length in the paragraph", () => {
  const out = neutralizeSuspectRefs("a ` b `` c #6");
  assert.equal(out.text, "a ` b `` c ```#6```");
  assert.deepEqual(findSuspectRefs(out.text), []);
});

test("text with no references comes through byte-identical", () => {
  const source =
    "No references here — just prose, a # alone, and !not-a-ref.\n";
  const out = neutralizeSuspectRefs(source);
  assert.equal(out.text, source);
  assert.deepEqual(out.wrapped, []);
});

// ------------------------------------------------------- neutralizer property

/** Every fixture string used above, plus geometries built to break the wrap. */
const CORPUS = [
  "",
  "#",
  "Fixes #123 now",
  "See (#123) for detail",
  "- fixes #7",
  "the token `#123` stays plain",
  "``a ` #123``",
  "```\nFixes #123\n```\n",
  "```ts\n// Fixes #123\n```\n",
  "```\nFixes #123\n",
  "~~~\nFixes #123\n~~~\n",
  "~~~\n```\n#123\n~~~\n",
  "[issue #123](https://x.test)",
  "[see it](x.test -#123)",
  "see it: x.test -#123",
  "https://x.test/p#123",
  "abc#123",
  "&#39;",
  "#0",
  "#0123",
  "#1234567890",
  "#12345678901",
  "#12a",
  "prose\n\n    Fixes #123\n",
  "prose\n\n\tFixes #123\n",
  "   Fixes #123\n",
  ESC_1,
  ESC_2,
  ESC_3,
  ESC_4,
  String.raw`\!45`,
  "foo\\\n#123",
  ESCAPED_TICKS,
  String.raw`\[issue #123](https://x.test)`,
  "a ` b #6",
  "` x\n\n#8 `",
  "`#7`#123",
  "see !45",
  "see #45 and !45",
  "#12 then again #12",
  "#12 then #45",
  "#45 then #12",
  "Fixes #12 now",
  "recorded decision (#10)",
  "#12, #45, then #12 again",
  "Fixes #12 and (#45)",
  SKIPPED_REGIONS,
  "No references here — just prose, a # alone, and !not-a-ref.\n",
  "Recorded decision (#10) and Disclosure #11.",
  "Looks good to me.",
  // Adversarial geometries.
  "stray ` before #6",
  "#6 then a stray `",
  "a ` b `` c #6",
  "``x`` paired, ` stray, #6",
  `${ESCAPED_TICKS} then a stray \` and #6`,
  "#1#2",
  "#1 `` #2 ` #3",
  "` open\nstill open\n#9",
  "[a ` b](c) #7",
  "[a `` b](c) #7",
  "[a ` b](c) #7 and #8",
  "[a ` b](c) [d ` e](f) #7",
  "note ``` a\n```\n#7\n",
  "prose ` #4\n```\ny `\n```\n",
  "`#1``#2``#3``#4`#5",
  "` a ` ` b #7",
];

/** The token inside an emitted wrap form, whatever run length it used. */
function stripTicks(form) {
  return form.replace(/^`+|`+$/g, "");
}

test("neutralizing partitions every found ref into wrapped or still-detectable", () => {
  for (const source of CORPUS) {
    const found = new Set(findSuspectRefs(source));
    const out = neutralizeSuspectRefs(source);
    const wrappedTokens = new Set(out.wrapped.map(stripTicks));
    const survivors = new Set(findSuspectRefs(out.text));
    const label = JSON.stringify(source);
    for (const token of wrappedTokens) {
      assert.ok(
        !survivors.has(token),
        `${token} claimed but survives in ${label}`,
      );
    }
    for (const form of out.wrapped) {
      assert.ok(
        out.text.includes(form),
        `${form} claimed but absent in ${label}`,
      );
    }
    assert.deepEqual(
      [...wrappedTokens, ...survivors].sort(),
      [...found].sort(),
      `partition mismatch for ${label}`,
    );
  }
});

test("the reported split is scanner-relative but never self-contradicting", () => {
  for (const source of CORPUS) {
    const out = neutralizeSuspectRefs(source);
    const claimed = new Set(out.wrapped.map(stripTicks));
    for (const form of out.survived) {
      assert.ok(
        !claimed.has(stripTicks(form)),
        `${form} both claimed and disowned for ${JSON.stringify(source)}`,
      );
    }
  }
});

test("neutralizing reaches a fixed point in one pass", () => {
  for (const source of CORPUS) {
    const once = neutralizeSuspectRefs(source).text;
    assert.equal(
      neutralizeSuspectRefs(once).text,
      once,
      `not idempotent for ${JSON.stringify(source)}`,
    );
  }
});

// ------------------------------------------------------------ renderer oracle

/** Live-position occurrences of `token`, by the detector's own boundary grammar —
 *  a preceding `[\w/&]` or a trailing word char keeps it plain. Counted, not
 *  merely detected: the same token can appear more than once (an escaped copy the
 *  wrap deliberately leaves alone, say), so only an INCREASE is a regression. */
function liveCount(haystack, token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\w/&])${esc}(?!\\w)`, "g");
  let n = 0;
  while (re.exec(haystack) !== null) n++;
  return n;
}

/** The HTML with every code region removed — what a forge autolinker would still
 *  be free to linkify. `<pre>` first, so a fenced block's inner `<code>` goes with
 *  it rather than leaving its wrapper behind. */
function outsideCode(html) {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<code[\s\S]*?<\/code>/g, " ");
}

// The only oracle here that is not the scanner itself: every other property test
// proves self-consistency, this one puts the wrapped output through a real
// CommonMark parser and asserts the claim holds in the RENDERED shape. It skips
// when marked is absent because the CI guards job runs `node --test` with no
// install step — locally it runs, and the session's forge-render probes are the
// cross-check that marked's geometry matches the forges'.
test("a wrapped ref never renders more exposed than it started", async (t) => {
  let Marked;
  try {
    ({ Marked } = await import("marked"));
  } catch {
    t.skip(
      "marked is not installed — the guards job runs with no install step",
    );
    return;
  }
  const md = new Marked();
  for (const source of CORPUS) {
    const out = neutralizeSuspectRefs(source);
    if (out.wrapped.length === 0 && out.survived.length === 0) continue;
    const after = outsideCode(md.parse(out.text));
    const before = outsideCode(md.parse(source));
    const label = JSON.stringify(source);
    for (const form of out.wrapped) {
      const token = stripTicks(form);
      // Strictly-decreases with a floor, not === 0: an unrelated live-position
      // copy of the same token (escaped elsewhere, or inside a link label) is
      // not this wrap's to remove, and a hard zero would fail on correct output.
      const beforeN = liveCount(before, token);
      const afterN = liveCount(after, token);
      assert.ok(
        afterN <= Math.max(beforeN - 1, 0),
        `${token} still renders outside a code span for ${label} (${beforeN}->${afterN})`,
      );
    }
    for (const form of out.survived) {
      const token = stripTicks(form);
      assert.ok(
        liveCount(after, token) <= liveCount(before, token),
        `${token} renders MORE exposed after neutralizing ${label}`,
      );
    }
  }
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

test("a body the guard cannot fully clear never claims more than it did", () => {
  // The post-condition is the tripwire for a geometry the scan reads wrongly; no
  // input reaches it today, so this pins the shape the footer must keep rather
  // than a live case. Every corpus entry lands wholly in `wrapped` or in neither.
  for (const source of CORPUS) {
    const out = neutralizeSuspectRefs(source);
    const body = buildAiCommentBody({
      ...PARTS,
      text: source,
      neutralizeRefs: true,
    });
    if (out.survived.length === 0) {
      assert.ok(!body.includes("could not neutralize"), body);
      continue;
    }
    const named = formatRefList(out.survived);
    assert.ok(
      body.includes(
        out.wrapped.length
          ? ` It could not neutralize ${named}._`
          : `_This automated run could not neutralize ${named} — verify before trusting any links it created._`,
      ),
      body,
    );
  }
});
