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

// Raw-HTML-block fixtures. GitHub's reference filter runs INSIDE raw HTML, so a
// `#N` there autolinks and must still be detected; a backtick wrap there is
// literal text that mangles the block and neutralizes nothing, so the region is
// left alone and its refs are disclosed instead. Region grammar on `scanRefs`.
const HTML_DETAILS = "<details>\nFixes #123\n</details>";
const HTML_DETAILS_SPACED = "<details>\n\nFixes #123\n\n</details>";
const HTML_SUMMARY_INLINE = "<details><summary>x</summary> Fixes #12";
const HTML_CLOSER_MID_TEXT = "prose #1\n</details>\nmore #2\n";
const HTML_SPAN_INLINE = "<span>see #5</span> and more prose";
const HTML_SPAN_ALONE = "<span>\nsee #5\n";
const HTML_MIXED = "prose #7\n\n<details>\nFixes #8\n</details>";
const HTML_SAME_TOKEN = "prose #7\n\n<details>\nFixes #7\n</details>";
const HTML_TICK_INSIDE = "<details>\na ` b\n</details>\n\nFixes #6";

// Region starts CommonMark reads at the container content column, a blank line it
// defines as spaces and tabs only, a block start that beats an open code span, and
// the type-1 end condition. Each of these wrapped a reference INSIDE raw HTML
// before the region grammar learned the rule.
const HTML_IN_QUOTE = "> <details>\n> Fixes #123\n> </details>\n";
const HTML_IN_LIST = "- <details>\n  Fixes #123\n  </details>\n";
const HTML_IN_ORDERED_LIST = "1. <details>\n   Fixes #3\n";
// The middle line is one NBSP, spelled as an escape so it stays visible in the
// source: whitespace to `String.trim`, CONTENT to CommonMark, so it must not end
// the block. The guard below pins that the fixture really carries one.
const HTML_NBSP_LINE = "<details>\n\u00a0\nFixes #123\n</details>\n";
const HTML_ACROSS_SPAN =
  "text ` open\n<details>\nstill ` closed\nFixes #123\n</details>\n";
const HTML_QUOTED_STRAY = "> prose ` x\n> <details>\n> #9\n";
const HTML_RAW_TEXT = "<pre>\nline one\n\nFixes #123\n</pre>\n";

// Link reference definitions. A wrap on one of these lines is spliced into the URL
// the definition supplies, so this region is skipped to prevent damage rather than a
// false claim — and the ref was never live there either, so detecting it at the
// manual seam was a false positive.
const LINK_DEF_USED = "[jump][dest]\n\n[dest]: #123\n";
const LINK_DEF_ALONE = "[dest]: #123\n";
const LINK_DEF_SPLIT = "[dest]:\n#123\n";
// Definition-SHAPED but continuing a paragraph, so CommonMark renders it as prose
// and the reference really does link: detection must still fire here.
const LINK_DEF_AS_PROSE = "see below\n[dest]: #123\n";

test("a link reference definition is not scanned", () => {
  for (const source of [LINK_DEF_USED, LINK_DEF_ALONE, LINK_DEF_SPLIT]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    const out = neutralizeSuspectRefs(source);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, [], label);
  }
});

test("a definition-shaped line continuing a paragraph is prose", () => {
  // The bound on the skip: only a line where a paragraph could START is a
  // definition, so this one is scanned and wrapped like any other prose.
  assert.deepEqual(findSuspectRefs(LINK_DEF_AS_PROSE), ["#123"]);
  const out = neutralizeSuspectRefs(LINK_DEF_AS_PROSE);
  assert.equal(out.text, "see below\n[dest]: `#123`\n");
  assert.deepEqual(out.wrapped, ["`#123`"]);
});

// Reference-link USE sites. A wrap inside the label breaks the lookup (label matching
// is case-fold and whitespace-collapse, nothing more), so the published link dies as
// bracket text — and the ref renders inside the anchor, where no forge filter reaches
// it, so detecting it was a false positive before the wrap broke anything.
const LINK_REF_SHORTCUT = "[issue #5]\n\n[issue #5]: https://example.com\n";
const LINK_REF_COLLAPSED = "[issue #5][]\n\n[issue #5]: /url\n";
const LINK_REF_FULL = "[jump #5][dest]\n\n[dest]: /url\n";
const LINK_REF_FOLDED = "[Issue   #5]\n\n[iSSUE #5]: /url\n";
// No definition anywhere, so the brackets are prose and the ref really does link.
const LINK_REF_NO_DEFINITION = "see [maybe #5] there\n";
// A definition inside a fence is code, not a definition, so the label resolves
// nothing and the use site below is prose.
const LINK_REF_FENCED_DEF = "```\n[issue #5]: /url\n```\n\n[issue #5]\n";

test("a resolving reference link is not scanned, in any of its forms", () => {
  for (const source of [
    LINK_REF_SHORTCUT,
    LINK_REF_COLLAPSED,
    LINK_REF_FULL,
    LINK_REF_FOLDED,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    const out = neutralizeSuspectRefs(source);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, [], label);
  }
});

test("a bracket span that resolves nothing is prose", () => {
  // The bound on the skip. Skipping every bracket span instead would ship this
  // reference live, which is the harm direction.
  assert.deepEqual(findSuspectRefs(LINK_REF_NO_DEFINITION), ["#5"]);
  assert.equal(
    neutralizeSuspectRefs(LINK_REF_NO_DEFINITION).text,
    "see [maybe `#5`] there\n",
  );
  // A full reference naming an undefined label is prose too.
  const undefinedLabel = "[jump #5][nope]\n\n[dest]: /url\n";
  assert.deepEqual(findSuspectRefs(undefinedLabel), ["#5"]);
});

test("a definition inside a fence defines nothing", () => {
  // The pre-pass runs the same line classification as the scan, so a definition
  // that is really code never enters the label set and its use site stays prose.
  assert.deepEqual(findSuspectRefs(LINK_REF_FENCED_DEF), ["#5"]);
  assert.equal(
    neutralizeSuspectRefs(LINK_REF_FENCED_DEF).text,
    "```\n[issue #5]: /url\n```\n\n[issue `#5`]\n",
  );
});

// A label proves nothing on its own: `not a valid url` cannot be a bare destination,
// so this whole line is a paragraph and BOTH its refs are live.
const DEF_INVALID_TAIL = "[issue #5]: not a valid url\n\n[issue #5]\n";
const DEF_DEFERRED_INVALID = "[dest]:\nnot a url #9\n";
const DEF_ANGLE_DEST = "[issue #5]: <a url with spaces>\n\n[issue #5]\n";
const DEF_TITLED = '[issue #5]: /url "A title"\n\n[issue #5]\n';
const DEF_TITLED_PARENS = "[issue #5]: /url (A title)\n\n[issue #5]\n";

test("a line whose tail is no destination is prose, label and all", () => {
  // Registering the label would have silenced the use site below it too.
  assert.deepEqual(findSuspectRefs(DEF_INVALID_TAIL), ["#5"]);
  assert.equal(
    neutralizeSuspectRefs(DEF_INVALID_TAIL).text,
    "[issue `#5`]: not a valid url\n\n[issue `#5`]\n",
  );
});

test("a deferred destination line is validated the same way", () => {
  // `[dest]:` alone defers to the next line — but only if that line really is a
  // destination, so this pair is a plain paragraph.
  assert.deepEqual(findSuspectRefs(DEF_DEFERRED_INVALID), ["#9"]);
  assert.equal(
    neutralizeSuspectRefs(DEF_DEFERRED_INVALID).text,
    "[dest]:\nnot a url `#9`\n",
  );
  // The valid shape still defers and still skips both lines.
  assert.deepEqual(findSuspectRefs(LINK_DEF_SPLIT), []);
});

test("the valid destination forms are definitions", () => {
  for (const source of [DEF_ANGLE_DEST, DEF_TITLED, DEF_TITLED_PARENS]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

// A definition line inside a multi-line code span is not a definition, so its label
// must not resolve a later use site whose reference the renderer leaves live.
const DEF_INSIDE_SPAN =
  "See:\n`\n[dest #5]: /url\n`\n\nAlso [dest #5] is unresolved.\n";
// Deferred destinations that are really BLOCK STARTS. CommonMark settles block
// structure before it looks for definitions, so none of these supplies a destination:
// the `]:` line stays a paragraph (or becomes a setext heading) and its reference is
// live, as is the use site below. Verified against GitHub 2026-09-08.
//
// marked 18.0.11 disagrees on the leaf shapes — it swallows `---`, `***`, a type-6
// tag and a fence line into the destination and renders the pair as an empty
// definition. Where a fixture is marked-divergent it is pinned directly here and
// kept out of the renderer-oracle sweep; the container shapes below are NOT
// divergent (marked and the forge agree the marker prevents the definition).
const DEF_DEFERRED_SETEXT = "[dest #5]:\n---\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_BREAK = "[dest #5]:\n***\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_TAG =
  "[dest #5]:\n<details>x</details>\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_FENCE = "[dest #5]:\n```\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_QUOTE = "[dest #5]:\n> x\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_BULLET = "[dest #5]:\n- item\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_ORDERED = "[dest #5]:\n1. item\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_HEADING = "[dest #5]:\n## H\n\nAlso [dest #5] here.\n";
/** Fixtures the renderer oracle cannot judge, and why — kept to the ones that
 *  actually misbehave rather than the whole divergent family. Under marked the fence
 *  line becomes the destination, so the pair is a definition; wrapping the reference
 *  inside the LABEL changes that label, the use site below stops resolving against
 *  it, and it falls back to live text. The count is therefore 1 before and 1 after,
 *  and the strictly-decreases arm reads a regression where the forge sees two
 *  references correctly wrapped. The other divergent shapes (`---`, `***`, a type-6
 *  tag) still decrease under both models, so they stay in the sweep; all four are
 *  pinned directly regardless. */
const ORACLE_EXCLUDED = new Set([DEF_DEFERRED_FENCE]);

/** Also excluded, for a divergence isolated by differential measurement: marked
 *  renders a wrap inside a LIST ITEM whose paragraph holds an UNCLOSED inline tag as
 *  literal backticks, so the live count reads 1 before and 1 after. It forms the code
 *  span for the same shape with a CLOSED tag, and in a plain paragraph with an
 *  unclosed one — the item's paragraph content is `text\n<span>\n` + a code span, and
 *  nothing in CommonMark lets an unclosed inline tag swallow the rest of the item.
 *  The behaviour is pinned directly instead. */
function excludeListTagQuirk(...sources) {
  for (const source of sources) ORACLE_EXCLUDED.add(source);
}

test("a definition inside a code span defines nothing", () => {
  // Phase 0 runs the character scan for exactly this: without span state it would
  // collect a phantom label and phase 1 would skip the live use site below.
  assert.deepEqual(findSuspectRefs(DEF_INSIDE_SPAN), ["#5"]);
  assert.ok(neutralizeSuspectRefs(DEF_INSIDE_SPAN).text.includes("`#5`"));
});

test("a block start is not a deferred destination", () => {
  // Every one of these leaves both references live, so both must be detected. The
  // leaf shapes are pinned here rather than through the oracle because marked reads
  // them as definitions; the container shapes are not divergent.
  for (const source of [
    DEF_DEFERRED_SETEXT,
    DEF_DEFERRED_BREAK,
    DEF_DEFERRED_TAG,
    DEF_DEFERRED_FENCE,
    DEF_DEFERRED_QUOTE,
    DEF_DEFERRED_BULLET,
    DEF_DEFERRED_ORDERED,
    // A space makes a bare destination invalid, so the heading shape needs no rule
    // of its own — DEFINITION_TAIL already rejects it.
    DEF_DEFERRED_HEADING,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.notEqual(neutralizeSuspectRefs(source).text, source, label);
  }
});

const DEF_DEFERRED_QUOTE_TIGHT = "[dest #5]:\n>x\n\nAlso [dest #5] here.\n";
const DEF_DEFERRED_TYPE7 = "[dest #5]:\n<span>\n\nAlso [dest #5] here.\n";

test("a blockquote marker needs no space to stop a definition", () => {
  // `>x` is still a blockquote, so the container check has to read the marker rather
  // than rely on the destination grammar rejecting a space.
  assert.deepEqual(findSuspectRefs(DEF_DEFERRED_QUOTE_TIGHT), ["#5"]);
});

test("a type-7 tag DOES supply a deferred destination", () => {
  // The counterpart that keeps the predicate honest: type 7 cannot interrupt a
  // paragraph, so unlike a type-6 tag it never displaces the definition.
  assert.deepEqual(findSuspectRefs(DEF_DEFERRED_TYPE7), []);
  assert.equal(
    neutralizeSuspectRefs(DEF_DEFERRED_TYPE7).text,
    DEF_DEFERRED_TYPE7,
  );
});

const DEF_DEFERRED_IN_QUOTE =
  "> [dest #5]:\n> /url\n>\n> Also [dest #5] here.\n";

// A LAZY continuation — a shallower line under a quoted definition — folds back into
// the same paragraph, so it still supplies the destination. Rejecting it wraps a
// working URL's fragment.
const DEF_LAZY_CONTINUATION = "> [dest]:\n/a?x=#5\n";
const DEF_LAZY_DEDENT = "> > [dest]:\n> /a?x=#5\n";
const DEF_LAZY_WITH_USE = "> [dest]:\n/a?x=#5\n>\n> See [dest] now.\n";
const DEF_LAZY_BLOCK_START = "> [dest #5]:\n---\n\nAlso [dest #5] here.\n";

test("a lazy continuation still carries the destination", () => {
  // Only a container that OPENS ends the definition; a shallower line does not.
  for (const source of [
    DEF_LAZY_CONTINUATION,
    DEF_LAZY_DEDENT,
    DEF_LAZY_WITH_USE,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a lazy continuation that starts a block still ends the definition", () => {
  // The block-start checks apply on the lazy path too — `---` is a setext underline
  // here, so the label's own reference stays live.
  assert.deepEqual(findSuspectRefs(DEF_LAZY_BLOCK_START), ["#5"]);
});

test("a container already open still carries the destination", () => {
  // The depths are COMPARED, not required to be zero: a quoted definition's
  // destination wears the same `>` its label did, and rejecting it would splice
  // backticks into a working URL.
  assert.deepEqual(findSuspectRefs(DEF_DEFERRED_IN_QUOTE), []);
  assert.equal(
    neutralizeSuspectRefs(DEF_DEFERRED_IN_QUOTE).text,
    DEF_DEFERRED_IN_QUOTE,
  );
  // And with nothing after the `]:` at all there is no destination to defer to.
  assert.deepEqual(findSuspectRefs("[dest #5]:"), ["#5"]);
  assert.deepEqual(findSuspectRefs("[dest #5]:\n"), ["#5"]);
});

test("a real deferred destination still forms a definition", () => {
  // The next line is ordinary text, so it supplies the destination and both lines
  // are skipped — the behaviour the block-start rule must not disturb.
  for (const source of [
    "[dest #5]:\n/url\n\nAlso [dest #5] here.\n",
    LINK_DEF_SPLIT,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a malformed definition line is prose", () => {
  // A bracket that never closes, an all-whitespace label, and a missing colon are
  // none of them definitions, so each stays scannable.
  assert.deepEqual(findSuspectRefs("[dest #123\n"), ["#123"]);
  assert.deepEqual(findSuspectRefs("[ ]: #123\n"), ["#123"]);
  assert.deepEqual(findSuspectRefs("[dest] #123\n"), ["#123"]);
  // An unescaped `]` inside the label ends it, so this is not a definition either.
  assert.deepEqual(findSuspectRefs("[a]b]: #123\n"), ["#123"]);
});

/** A block opens at its container's content column, so the region is byte-identical
 *  and the ref inside it is disclosed rather than wrapped. */
function assertHeldWhole(source, form) {
  const out = neutralizeSuspectRefs(source);
  const label = JSON.stringify(source);
  assert.equal(out.text, source, label);
  assert.deepEqual(out.wrapped, [], label);
  assert.deepEqual(out.survived, [form], label);
}

test("a blockquote's marker does not stop a block from opening", () => {
  assertHeldWhole(HTML_IN_QUOTE, "`#123`");
});

test("a bullet list's marker does not stop a block from opening", () => {
  assertHeldWhole(HTML_IN_LIST, "`#123`");
});

test("an ordered list's marker does not stop a block from opening", () => {
  assertHeldWhole(HTML_IN_ORDERED_LIST, "`#3`");
});

test("a line of NBSP is content, not the blank line that ends a block", () => {
  assert.equal(HTML_NBSP_LINE.split("\n")[1], "\u00a0");
  const out = neutralizeSuspectRefs(HTML_NBSP_LINE);
  assert.equal(out.text, HTML_NBSP_LINE);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#123`"]);
});

test("an open code span cannot reach across a block opener", () => {
  // The opener is a block start and the block pass runs first, so the tick that
  // would have closed the span is unreachable and the ref below it is held.
  assertHeldWhole(HTML_ACROSS_SPAN, "`#123`");
});

test("a stray tick in a quoted paragraph cannot swallow the block below it", () => {
  assertHeldWhole(HTML_QUOTED_STRAY, "`#9`");
});

test("a raw-text block ends at its closing tag, not at a blank line", () => {
  // Type 1 ignores blank lines entirely, so `#123` two lines below one is still
  // inside the `<pre>` and a wrap there would be visible backtick garbage.
  const out = neutralizeSuspectRefs(HTML_RAW_TEXT);
  assert.equal(out.text, HTML_RAW_TEXT);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#123`"]);
  // The closing tag may share the opener's line, and the block ends there.
  const oneLine = neutralizeSuspectRefs("<pre>see #1</pre>\n\nFixes #2");
  assert.equal(oneLine.text, "<pre>see #1</pre>\n\nFixes `#2`");
  assert.deepEqual(oneLine.wrapped, ["`#2`"]);
  assert.deepEqual(oneLine.survived, ["`#1`"]);
});

test("a raw HTML block hides nothing from the detector", () => {
  assert.deepEqual(findSuspectRefs(HTML_DETAILS), ["#123"]);
  assert.deepEqual(findSuspectRefs(HTML_SUMMARY_INLINE), ["#12"]);
  assert.deepEqual(findSuspectRefs(HTML_SPAN_ALONE), ["#5"]);
  assert.deepEqual(findSuspectRefs(HTML_CLOSER_MID_TEXT), ["#1", "#2"]);
});

test("a reference in a raw HTML block is left alone and disclosed", () => {
  const out = neutralizeSuspectRefs(HTML_DETAILS);
  assert.equal(out.text, HTML_DETAILS);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#123`"]);
});

test("a blank line ends the block, so the reference below it wraps", () => {
  const out = neutralizeSuspectRefs(HTML_DETAILS_SPACED);
  assert.equal(out.text, "<details>\n\nFixes `#123`\n\n</details>");
  assert.deepEqual(out.wrapped, ["`#123`"]);
  assert.deepEqual(out.survived, []);
});

test("a type-6 opener covers the rest of its own line", () => {
  const out = neutralizeSuspectRefs(HTML_SUMMARY_INLINE);
  assert.equal(out.text, HTML_SUMMARY_INLINE);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#12`"]);
});

test("a lone closing tag opens a block and interrupts the paragraph", () => {
  const out = neutralizeSuspectRefs(HTML_CLOSER_MID_TEXT);
  assert.equal(out.text, "prose `#1`\n</details>\nmore #2\n");
  assert.deepEqual(out.wrapped, ["`#1`"]);
  assert.deepEqual(out.survived, ["`#2`"]);
});

test("a tag with trailing content on the line opens no block", () => {
  // `span` is not a type-6 tag, and type 7 wants the tag alone on its line, so
  // this is ordinary prose: the wrap must still fire.
  const out = neutralizeSuspectRefs(HTML_SPAN_INLINE);
  assert.equal(out.text, "<span>see `#5`</span> and more prose");
  assert.deepEqual(out.wrapped, ["`#5`"]);
  assert.deepEqual(out.survived, []);
});

test("a tag alone on its line is a type-7 block, whatever the tag", () => {
  const out = neutralizeSuspectRefs(HTML_SPAN_ALONE);
  assert.equal(out.text, HTML_SPAN_ALONE);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#5`"]);
});

const HTML_TYPE7_MID_PARAGRAPH = "text\n<span>\n#5\n";
const HTML_TYPE7_AFTER_BLANK = "text\n\n<span>\n#5\n";
const HTML_TYPE6_MID_PARAGRAPH = "text\n<details>\n#5\n";

// An inline tag is markup, not a text node: nothing inside it autolinks, and a wrap
// there corrupts it — a quoted value becomes href="`#123`" and the link dies, an
// unquoted one stops parsing as HTML at all. Its TEXT CONTENT is ordinary prose.
const TAG_ATTR_DOUBLE = 'See <a href="#123">the section</a>.';
const TAG_ATTR_SINGLE = "See <a href='#123'>x</a>.";
const TAG_ATTR_TWO = 'See <a title="#1" href="#2">x</a>.';
const TAG_ATTR_UNQUOTED = "See <a href=#123>x</a>.";
const TAG_TEXT_CONTENT = "See <b>fixes #123</b> now.";
const TAG_TEXT_AFTER = 'See <a href="/x">y</a> fixes #123.';
const TAG_TICKS_INSIDE = '<a title="`x`">y</a> and #5';
// Shapes the grammar must NOT swallow: no tag name, a digit start, an escape.
const TAG_NOT_A_TAG_DIGIT = "a <3 and 5> #5";
const TAG_NOT_A_TAG_BARE = "a < b and #5";
const TAG_ESCAPED_ANGLE = 'a \\<a href="#1"> b';

test("a reference in an attribute value is not scanned", () => {
  for (const source of [
    TAG_ATTR_DOUBLE,
    TAG_ATTR_SINGLE,
    TAG_ATTR_TWO,
    TAG_ATTR_UNQUOTED,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a reference in a tag's text content is still scanned", () => {
  for (const source of [TAG_TEXT_CONTENT, TAG_TEXT_AFTER]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#123"], label);
    assert.deepEqual(neutralizeSuspectRefs(source).wrapped, ["`#123`"], label);
  }
});

test("something that only looks like a tag stays prose", () => {
  // A tag name must start with a letter, and an escaped `<` is literal text.
  for (const source of [
    TAG_NOT_A_TAG_DIGIT,
    TAG_NOT_A_TAG_BARE,
    TAG_ESCAPED_ANGLE,
  ]) {
    const label = JSON.stringify(source);
    assert.equal(findSuspectRefs(source).length, 1, label);
    assert.notEqual(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a tag's own backticks are not strays", () => {
  // Code spans and raw HTML have equal precedence and the leftmost wins. This arm
  // only runs with no span open, so the tag starts first and its ticks are raw —
  // they cannot steal a single-tick wrap after it.
  const out = neutralizeSuspectRefs(TAG_TICKS_INSIDE);
  assert.deepEqual(findSuspectRefs(TAG_TICKS_INSIDE), ["#5"]);
  assert.deepEqual(out.wrapped, ["`#5`"]);
});

// A type-7 tag at a column the list marker's content had left is EITHER outside the
// item (a block start, refs raw HTML) OR a lazy continuation of its paragraph (refs
// prose). Both readings leave the reference live, so holding it is truthful either
// way — which is what lets one boolean stand in for an indentation model here.
const LIST_DEDENT_BULLET = "- text\n<span>\n#5";
const LIST_DEDENT_ORDERED = "1. text\n<span>\n   #5";
const LIST_DEDENT_AFTER_BODY = "- text\nmore\n<span>\n#5";
const LIST_DEDENT_AFTER_INDENTED_BODY = "- text\n  more\n<span>\n#5";
const LIST_DEDENT_AFTER_BLANK = "- text\n\n<span>\n#5";
// Indented INTO the item's content column: not a dedent, so this arm ignores it.
const LIST_TAG_INDENTED = "- text\n  <span>\n  #5";
const LIST_TAG_INDENTED_ORDERED = "1. text\n   <span>\n   #5";
excludeListTagQuirk(LIST_TAG_INDENTED, LIST_TAG_INDENTED_ORDERED);

// A fence behind a list marker pairs against the ITEM's content column. Missing the
// opener was never only cosmetic: the closer then opened a phantom fence that
// swallowed everything after it, so the mangled code example came with a silently
// missed reference below.
const LIST_FENCE_CHAIN = "- ~~~\n  #5\n  ~~~\n\nSee #6";
const LIST_FENCE_ORDERED = "1. ~~~\n   #5\n   ~~~\n\nSee #6";
const LIST_FENCE_BACKTICK = "- ```\n  #5\n  ```\n\nSee #6";
const LIST_FENCE_UNCLOSED = "- ~~~\n  #5\n\nSee #6";
const LIST_FENCE_DEDENT_ENDS = "- ~~~\n  #5\nplain #6";
const LIST_FENCE_INNER_BLANK = "- ~~~\n\n  #5\n  ~~~\n\nSee #6";
const LIST_FENCE_CONTINUATION = "- text\n  ~~~\n  #5\n  ~~~\n\nSee #6";
const LIST_FENCE_DEDENT_CLOSER = "- ~~~\n  #5\n~~~\n\nSee #6";

test("a fence behind a list marker is a fence", () => {
  // The reference inside stays untouched, and the one after the item is scanned.
  for (const source of [
    LIST_FENCE_CHAIN,
    LIST_FENCE_ORDERED,
    LIST_FENCE_BACKTICK,
    LIST_FENCE_CONTINUATION,
    LIST_FENCE_INNER_BLANK,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#6"], label);
    assert.ok(neutralizeSuspectRefs(source).text.includes("#5"), label);
    assert.ok(!neutralizeSuspectRefs(source).text.includes("`#5`"), label);
  }
});

test("a list fence ends with its item", () => {
  // Unclosed, it runs to the blank line that ends the item; a dedented line ends it
  // too. Either way the reference below is scanned rather than swallowed.
  for (const source of [LIST_FENCE_UNCLOSED, LIST_FENCE_DEDENT_ENDS]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#6"], label);
  }
});

test("a list fence closer takes the three-space slack", () => {
  // Measured against the renderer: the closer pairs from the item's column through
  // column+3, and a fourth space makes it code content instead. The reference below
  // it is item prose in the first case and inside the block in the second.
  for (let indent = 2; indent <= 5; indent++) {
    const source = `- ~~~\n  #5\n${" ".repeat(indent)}~~~\n  after #6`;
    assert.deepEqual(findSuspectRefs(source), ["#6"], JSON.stringify(source));
  }
  const tooDeep = `- ~~~\n  #5\n${" ".repeat(6)}~~~\n  after #6`;
  assert.deepEqual(findSuspectRefs(tooDeep), [], JSON.stringify(tooDeep));
});

test("a fence-shaped line inside the item does not re-open", () => {
  // The closer-as-opener flip is what turned a mangle into a swallow: treating this
  // line as content defers the item's end to the next ordinary line, which keeps the
  // reference after it scannable.
  assert.deepEqual(findSuspectRefs(LIST_FENCE_DEDENT_CLOSER), ["#6"]);
});

test("the fence arm leaves the list HTML shapes alone", () => {
  // Round 4's `- <details>` and round 14's dedent hold both run through the same
  // marker state, so they are pinned against this arm too.
  assert.deepEqual(neutralizeSuspectRefs(HTML_IN_LIST).survived, ["`#123`"]);
  assert.deepEqual(neutralizeSuspectRefs(LIST_DEDENT_BULLET).survived, [
    "`#5`",
  ]);
});

test("a tag that leaves a list item's indent holds its references", () => {
  for (const source of [
    LIST_DEDENT_BULLET,
    LIST_DEDENT_ORDERED,
    LIST_DEDENT_AFTER_BODY,
    LIST_DEDENT_AFTER_INDENTED_BODY,
    // A blank line clears the remembered column; the paragraph-start flag already
    // opens the region here, so this path holds for its own reason.
    LIST_DEDENT_AFTER_BLANK,
  ]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, ["`#5`"], label);
  }
});

test("a tag indented into the item is left to the ordinary arms", () => {
  // Still inside the item, so the heuristic does not fire and the reference wraps.
  for (const source of [LIST_TAG_INDENTED, LIST_TAG_INDENTED_ORDERED]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.deepEqual(neutralizeSuspectRefs(source).wrapped, ["`#5`"], label);
  }
});

test("a list line that is not a tag is untouched by the heuristic", () => {
  // The arm reads only the type-7 gate, so ordinary item prose still wraps.
  const source = "- text\n- more #5\n";
  assert.deepEqual(findSuspectRefs(source), ["#5"]);
  assert.deepEqual(neutralizeSuspectRefs(source).wrapped, ["`#5`"]);
  // And a type-6 tag on the marker's own line keeps its round-4 behaviour.
  assert.deepEqual(neutralizeSuspectRefs(HTML_IN_LIST).survived, ["`#123`"]);
});

test("the held reference gets a disclosure that is true either way", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: LIST_DEDENT_BULLET,
    neutralizeRefs: true,
  });
  assert.ok(body.includes(LIST_DEDENT_BULLET), body);
  assert.ok(
    body.endsWith(
      "_This automated run could not neutralize `#5` — verify before trusting any links it created._",
    ),
    body,
  );
});

test("a type-6 tag DOES interrupt a paragraph", () => {
  // The counterpart to the gate below: types 1 and 6 may interrupt, so this opener
  // is not gated and the reference under it is held rather than wrapped.
  const out = neutralizeSuspectRefs(HTML_TYPE6_MID_PARAGRAPH);
  assert.equal(out.text, HTML_TYPE6_MID_PARAGRAPH);
  assert.deepEqual(out.survived, ["`#5`"]);
});

// A container that OPENS on the line starts a fresh block context, so a type-7 tag
// may open inside it even mid-paragraph. The paragraph flag alone is depth-blind and
// said no, which wrapped these references inside raw HTML with a false claim.
const HTML_TYPE7_IN_CONTAINER = [
  "text\n> <span>\n> #5\n",
  "text\n> <span id=x>\n> #5\n",
  "text\n- <span>\n  #5\n",
  "text\n1. <span>\n   #5\n",
  "text\n> > <span>\n> > #5\n",
  "text\n> </span>\n> #5\n",
];

const HTML_TYPE7_CONTAINER_ALREADY_OPEN = "> text\n> <span>\n> #5\n";
const HTML_TYPE7_AFTER_QUOTED_FENCE =
  "> ```\n> c\n> ```\n> text\n> <span>\n> #5\n";

test("a container already open does not restart the paragraph", () => {
  // The depth has to INCREASE. Inside a quote that was already there the tag is
  // still mid-paragraph, so the reference below it is live prose and wraps — and
  // the second shape proves the depth stays fresh across skipped fence lines.
  for (const source of [
    HTML_TYPE7_CONTAINER_ALREADY_OPEN,
    HTML_TYPE7_AFTER_QUOTED_FENCE,
  ]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.deepEqual(out.wrapped, ["`#5`"], label);
    assert.deepEqual(out.survived, [], label);
  }
});

test("a type-7 tag opens inside a container that starts on its line", () => {
  for (const source of HTML_TYPE7_IN_CONTAINER) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, ["`#5`"], label);
  }
});

// `paragraphLimit` carries the same block state the scan does, so the two agree about
// where the paragraph ends. A type-7 line only counts as a block start when something
// makes it one; mid-paragraph, with no container opening and a paragraph still open
// above it, it is inline HTML and the span closes straight across it.
const SPAN_ACROSS_TYPE7 = "text ` open\n<span>\nstill ` closed\ncode #5 here\n";
const SPAN_HIDING_A_DEFINITION =
  "text `\n<span>\n[d #5]: /u2\n`\n\nSee [d #5] now.\n";

// A span CANDIDATE must not run through a container-opening line. If the closer
// search reads past one, the span opens, the `span === 0` guard suppresses the whole
// HTML arm on that line, and the reference inside the raw block is wrapped and
// falsely claimed. Both call sites read one shared container notion for that reason.
const SPAN_THROUGH_QUOTE_TYPE7 = "text ` open\n> <span>\n> a ` b #5";
const SPAN_THROUGH_LIST_TYPE7 = "text ` open\n- <span>\n  a ` b #5";
const SPAN_THROUGH_NESTED_TYPE7 = "text ` open\n> - <span>\n>   a ` b #5";
const SPAN_THROUGH_DEDENT_TYPE7 = "> text ` open\n<span>\n> a ` b #5";

// A type-7 tag also opens where the line above it left no paragraph — after a
// heading, or after a blockquote's own blank line. The closer search has to know
// that too, or the span swallows a reference the renderer leaves as raw HTML.
const SPAN_THROUGH_HEADING_TYPE7 = "a ` open\n## H\n<span>\n#5\nb ` c";
const SPAN_THROUGH_QUOTED_BLANK_TYPE7 =
  "> a ` open\n>\n> <span>\n> #5\n> b ` c";
const SPAN_FROM_HEADING_LINE = "## H ` x\n<span>\n#5\nb ` c";
// The paragraph the span opened in ends at the blockquote, so the closer inside it
// belongs to another block and cannot pair — the reference between them is prose.
const SPAN_STOPPED_BY_CONTAINER = "a ` open\n> q\n> <span>\n> #5\nb ` c";

// A paragraph-interrupting line ends the paragraph the span opened in, so a closer
// beyond it belongs to another block. Without the bound the span pairs across, the
// stray tick below is never recorded, and the wrap it picks is stolen by that tick.
const SPAN_ACROSS_HEADING = "a ` open\n## H\nb ` c #5";
const SPAN_ACROSS_QUOTED_HEADING = "> a ` open\n> ## H\n> b ` c #5";
const SPAN_CLOSER_ON_HEADING = "a ` open\n## H ` close\nb #5 c";
const SPAN_ACROSS_THEMATIC = "a ` open\n***\nb #5 ` c";
const SPAN_ACROSS_SETEXT = "a ` open\nH\n---\nb ` c #5";
// Prose the renderer keeps whole: a line without letters is NOT a block start, and
// `| a | b |` is a table only when a delimiter row follows. Splitting the paragraph
// here would wrap a reference the renderer had already sealed inside a code span.
const SPAN_OVER_EMOJI = "a ` open\n\u{1F916}\nb #5 ` c";
const SPAN_OVER_BANGS = "a ` open\n!!!\nb #5 ` c";
const SPAN_OVER_PIPES = "a ` open\n| x | y |\nb #5 ` c";

// The opener's OWN line can be the block that ends: a heading may carry a backtick
// and still close at its line end, so nothing below it can be that tick's closer.
// (Only the heading arm is reachable here — a setext underline or thematic break
// admits no backtick, so a span can never open on one.)
const SPAN_OPENS_ON_HEADING = "## H ` x\nb #5 ` c";
const SPAN_OPENS_ON_QUOTED_HEADING = "> ## H ` x\n> b #5 ` c";
// A `>`-only line is the blockquote's blank line. `BLANK_LINE` never sees it — it
// wants two newlines — and the depth is unchanged, so the gate has to test it.
const SPAN_ACROSS_QUOTED_BLANK = "> a ` open\n>\n> b #5 ` c";
// A shallower line under an OPEN paragraph is a lazy continuation the renderer folds
// back, so the span really does reach across it and the reference inside is inert.
const SPAN_OVER_LAZY_DEDENT = "> a ` open\nb #5 ` c";
const SPAN_OVER_LAZY_DEDENT_OUTSIDE = "> a ` open\nb ` c #5";
// Dedents that genuinely end the paragraph must still bound, via their own arms.
const SPAN_DEDENT_TO_HEADING = "> a ` open\n## H\nb #5 ` c";
const SPAN_DEDENT_TO_LIST = "> a ` open\n- item #5 ` c";

test("a heading on the opener's own line caps the search", () => {
  for (const source of [SPAN_OPENS_ON_HEADING, SPAN_OPENS_ON_QUOTED_HEADING]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.deepEqual(neutralizeSuspectRefs(source).wrapped, ["``#5``"], label);
  }
});

test("a blockquote's own blank line bounds the closer search", () => {
  assert.deepEqual(findSuspectRefs(SPAN_ACROSS_QUOTED_BLANK), ["#5"]);
  assert.deepEqual(neutralizeSuspectRefs(SPAN_ACROSS_QUOTED_BLANK).wrapped, [
    "``#5``",
  ]);
  // At depth zero `BLANK_LINE` already stops the walk before the blank line, so
  // this arm changes nothing there.
  assert.deepEqual(neutralizeSuspectRefs("a ` open\n\nb #5 ` c").wrapped, [
    "`#5`",
  ]);
});

test("a lazy continuation is not a container start", () => {
  // The span reaches across the dedent, so this reference is already inert —
  // wrapping it would put literal backticks inside the rendered code span.
  assert.deepEqual(findSuspectRefs(SPAN_OVER_LAZY_DEDENT), []);
  assert.equal(
    neutralizeSuspectRefs(SPAN_OVER_LAZY_DEDENT).text,
    SPAN_OVER_LAZY_DEDENT,
  );
  // With the reference past the closer the span leaves it live, and it wraps.
  assert.deepEqual(findSuspectRefs(SPAN_OVER_LAZY_DEDENT_OUTSIDE), ["#5"]);
});

test("a dedent that really ends the paragraph still bounds", () => {
  // Each of these leaves the quote AND starts something: the sibling arms catch
  // them even though the depth drop alone no longer counts.
  for (const source of [SPAN_DEDENT_TO_HEADING, SPAN_DEDENT_TO_LIST]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
  }
  // A fence dedent swallows the rest into code, so nothing is detected there.
  assert.deepEqual(findSuspectRefs("> a ` open\n```\nb #5 ` c"), []);
});

test("a heading bounds the closer search", () => {
  for (const source of [SPAN_ACROSS_HEADING, SPAN_ACROSS_QUOTED_HEADING]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    // Run TWO: the tick below the heading is a live stray once the span cannot
    // form, and a single-tick wrap would have been stolen by it.
    assert.deepEqual(neutralizeSuspectRefs(source).wrapped, ["``#5``"], label);
  }
});

test("the bounding line's own tick cannot close the span", () => {
  // The returned index is the bounding line's first character and the caller's
  // window is half-open, so that line is never searched.
  assert.deepEqual(findSuspectRefs(SPAN_CLOSER_ON_HEADING), ["#5"]);
  assert.deepEqual(neutralizeSuspectRefs(SPAN_CLOSER_ON_HEADING).wrapped, [
    "``#5``",
  ]);
});

test("a thematic break or setext underline bounds the closer search", () => {
  for (const source of [SPAN_ACROSS_THEMATIC, SPAN_ACROSS_SETEXT]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
  }
});

test("a paragraph the renderer keeps whole is not split", () => {
  // These bound nothing: the span forms, the reference inside it is already inert,
  // and wrapping there would put literal backticks into rendered code.
  for (const source of [SPAN_OVER_EMOJI, SPAN_OVER_BANGS, SPAN_OVER_PIPES]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a block start after a heading bounds the closer search", () => {
  for (const source of [
    SPAN_THROUGH_HEADING_TYPE7,
    SPAN_THROUGH_QUOTED_BLANK_TYPE7,
    // The opener's OWN line can be the heading, so the walk seeds from it rather
    // than assuming the line a span opened on leaves a paragraph behind.
    SPAN_FROM_HEADING_LINE,
  ]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.survived, ["`#5`"], label);
  }
});

test("a container start bounds the closer search", () => {
  // The depths are compared line to line, not against the opener: here the `<span>`
  // sits at the same depth as the `> q` above it, so it opens nothing and the
  // reference under it is ordinary quoted prose that wraps. The run is TWO because
  // the unpaired tick above the blockquote is still counted as a stray — it sits in
  // another block and could not have stolen a single-tick wrap, so this is the
  // over-long-but-safe direction `strays` is documented to take.
  const out = neutralizeSuspectRefs(SPAN_STOPPED_BY_CONTAINER);
  assert.deepEqual(findSuspectRefs(SPAN_STOPPED_BY_CONTAINER), ["#5"]);
  assert.deepEqual(out.wrapped, ["``#5``"]);
  assert.deepEqual(out.survived, []);
});

test("a span candidate cannot run through a container-opening type-7 line", () => {
  for (const source of [
    SPAN_THROUGH_QUOTE_TYPE7,
    SPAN_THROUGH_LIST_TYPE7,
    SPAN_THROUGH_NESTED_TYPE7,
  ]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.deepEqual(findSuspectRefs(source), ["#5"], label);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, ["`#5`"], label);
  }
});

test("a span candidate cannot run through a dedenting type-7 line", () => {
  // The depth DROP ends the paragraph just as a rise does, so the two call sites
  // read a change of depth rather than an increase.
  const out = neutralizeSuspectRefs(SPAN_THROUGH_DEDENT_TYPE7);
  assert.equal(out.text, SPAN_THROUGH_DEDENT_TYPE7);
  assert.deepEqual(out.survived, ["`#5`"]);
});

test("a depth drop lets a type-7 block open", () => {
  const source = "> text\n<span>\n> #5\n";
  const out = neutralizeSuspectRefs(source);
  assert.equal(out.text, source);
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#5`"]);
});

test("a code span closes across a mid-paragraph type-7 line", () => {
  // The tick pairs, so it is not a live stray and the wrap needs only one backtick.
  assert.equal(
    neutralizeSuspectRefs(SPAN_ACROSS_TYPE7).text,
    "text ` open\n<span>\nstill ` closed\ncode `#5` here\n",
  );
  // And the span's contents stay untouched: the definition line inside it is code,
  // so only the live use site below is wrapped.
  assert.equal(
    neutralizeSuspectRefs(SPAN_HIDING_A_DEFINITION).text,
    "text `\n<span>\n[d #5]: /u2\n`\n\nSee [d `#5`] now.\n",
  );
});

test("a type-7 tag cannot interrupt a paragraph", () => {
  // Mid-paragraph the renderer keeps both lines in the paragraph, so the reference
  // is live and wrapping it beats disclosing a phantom survivor.
  const mid = neutralizeSuspectRefs(HTML_TYPE7_MID_PARAGRAPH);
  assert.equal(mid.text, "text\n<span>\n`#5`\n");
  assert.deepEqual(mid.wrapped, ["`#5`"]);
  assert.deepEqual(mid.survived, []);
  // After a blank line it really does open a block, and the reference is held.
  const after = neutralizeSuspectRefs(HTML_TYPE7_AFTER_BLANK);
  assert.equal(after.text, HTML_TYPE7_AFTER_BLANK);
  assert.deepEqual(after.survived, ["`#5`"]);
});

test("wrapped and held references are reported side by side", () => {
  const out = neutralizeSuspectRefs(HTML_MIXED);
  assert.equal(out.text, "prose `#7`\n\n<details>\nFixes #8\n</details>");
  assert.deepEqual(out.wrapped, ["`#7`"]);
  assert.deepEqual(out.survived, ["`#8`"]);
});

test("a token wrapped in one place and held in another is disowned", () => {
  const out = neutralizeSuspectRefs(HTML_SAME_TOKEN);
  assert.equal(out.text, "prose `#7`\n\n<details>\nFixes #7\n</details>");
  assert.deepEqual(out.wrapped, []);
  assert.deepEqual(out.survived, ["`#7`"]);
});

test("a tick inside a raw HTML block cannot lengthen a later wrap", () => {
  // No inline syntax parses inside the block, and the blank line that ends one
  // clears the paragraph's strays anyway, so that tick reaches nothing.
  const out = neutralizeSuspectRefs(HTML_TICK_INSIDE);
  assert.equal(out.text, "<details>\na ` b\n</details>\n\nFixes `#6`");
  assert.deepEqual(out.wrapped, ["`#6`"]);
});

// Indented code cannot interrupt a paragraph, so these indented lines are prose
// continuations whose refs really do link — skipping them was a silent live ref.
const INDENT_PROSE_CONTINUATION = "Review notes:\n    Fixes #123\n";
const INDENT_LIST_CONTINUATION = "- Finding\n    See #123\n";
const INDENT_DEEP_LIST_CONTINUATION = "-   Finding\n        See #123\n";
// A real indented code block: opened where a paragraph could start, and its later
// lines stay inside it across a blank line.
const INDENT_CODE_BLOCK = "p\n\n    a #1\n\n    Fixes #123\n";
const INDENT_CODE_IN_LIST = "- Finding\n\n      See #123\n";

test("an indented line continuing a paragraph is prose", () => {
  for (const [source, wrapped] of [
    [INDENT_PROSE_CONTINUATION, "Review notes:\n    Fixes `#123`\n"],
    [INDENT_LIST_CONTINUATION, "- Finding\n    See `#123`\n"],
    [INDENT_DEEP_LIST_CONTINUATION, "-   Finding\n        See `#123`\n"],
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), ["#123"], label);
    assert.equal(neutralizeSuspectRefs(source).text, wrapped, label);
  }
});

test("a real indented code block is still skipped", () => {
  // No separate block state is needed: every skipped line leaves the paragraph-start
  // flag true, so the block's later lines and the blank line inside it stay code.
  for (const source of [
    INDENT_CODE_BLOCK,
    INDENT_CODE_IN_LIST,
    "    Fixes #123\n",
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

// An unterminated fence inside a blockquote dies with its container. Without that it
// swallows the rest of the comment, and those references post live and undisclosed.
const FENCE_QUOTE_UNPAIRED_REPLY =
  "> ```suggestion\n> const x = 1;\n\nThat still leaves the leak. Same root cause as #123, and it blocks !47.\n";
const FENCE_QUOTE_UNPAIRED_MIN = "> ~~~\n> code\n\nFixes #123\n";
const FENCE_QUOTE_LAZY = "> ~~~\nFixes #123\n";
const FENCE_UNQUOTED_UNPAIRED = "```\nFixes #123\n";
// A fence opens at the blockquote content column, and pairs only at its own depth.
const FENCE_IN_QUOTE = "> ~~~\n> #123\n> ~~~\n";

test("an unterminated fence in a blockquote ends with the blockquote", () => {
  // A blank line ends the quote, and so does a line that drops below its depth.
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_UNPAIRED_REPLY, ["#", "!"]), [
    "#123",
    "!47",
  ]);
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_UNPAIRED_MIN), ["#123"]);
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_LAZY), ["#123"]);
});

// A `>`-only line is a blank line INSIDE the blockquote, which a quoted fence
// absorbs as a blank code line. Reading it as the end of the container kills the
// fence early, and the real closer then opens a phantom fence over the rest.
const FENCE_QUOTE_BLANK_INSIDE =
  "> ```js\n> const a = 1;\n>\n> const b = 2;\n> ```\n> This fixes #123 as noted.";
const FENCE_QUOTE_BLANK_CONTENT = "> ```\n> code #1\n>\n> more #2\n> ```";

test("a quote-marker-only line does not end a quoted fence", () => {
  // Live-ref direction: the fence really closes at its closer, so the prose after
  // it inside the same quote is scanned.
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_BLANK_INSIDE), ["#123"]);
  // Mangling direction: everything between the markers stays code, both sides of
  // the blank line, so the neutralizer leaves it alone.
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_BLANK_CONTENT), []);
  assert.equal(
    neutralizeSuspectRefs(FENCE_QUOTE_BLANK_CONTENT).text,
    FENCE_QUOTE_BLANK_CONTENT,
  );
});

const FENCE_QUOTE_BLANK_THEN_PROSE =
  "> ```\n> a #1\n>\n> b #2\n> ```\n\nAfter #9\n";
const FENCE_NESTED_BLANK =
  "> > ```\n> > a #1\n> >\n> > b #2\n> > ```\n> > tail #3\n";

test("a quoted fence with an inner blank still ends at its own closer", () => {
  // Both refs inside stay code and only what follows the closer is scanned —
  // outside the quote entirely, and at a nested depth.
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_BLANK_THEN_PROSE), ["#9"]);
  assert.deepEqual(findSuspectRefs(FENCE_NESTED_BLANK), ["#3"]);
});

const HTML_QUOTE_BLANK_INSIDE = "> <details>\n> #1\n>\n> #2\n";

test("a quote-marker-only line DOES end a quoted HTML block", () => {
  // The asymmetry the fence rule turns on: a fence absorbs `>` as a blank code
  // line, a type-6 block ends at it. So the first ref is block content and held,
  // and the second is an ordinary quoted paragraph and wraps.
  const out = neutralizeSuspectRefs(HTML_QUOTE_BLANK_INSIDE);
  assert.deepEqual(findSuspectRefs(HTML_QUOTE_BLANK_INSIDE), ["#1", "#2"]);
  assert.deepEqual(out.survived, ["`#1`"]);
  assert.deepEqual(out.wrapped, ["`#2`"]);
});

test("an unterminated fence at depth zero still runs to the end", () => {
  // It has no container to lose, so this stays the pinned behaviour, and a properly
  // closed quoted fence keeps suppressing its contents.
  assert.deepEqual(findSuspectRefs(FENCE_UNQUOTED_UNPAIRED), []);
  assert.deepEqual(findSuspectRefs(FENCE_IN_QUOTE), []);
});

// Indented code opens right after each of these leaf blocks, so a wrap there would
// land inside rendered code while the footer claimed the reference was neutralized.
const INDENT_AFTER_HEADING = "## Findings\n    // repro\n    fixes #123\n";
const INDENT_AFTER_SETEXT = "Title\n---\n    fixes #123\n";
const INDENT_AFTER_BREAK = "a\n\n***\n    fixes #123\n";
const INDENT_AFTER_RAW_CLOSE = "<pre>\na\n</pre>\n    fixes #123\n";
const INDENT_AFTER_TABLE = "| a | b |\n| - | - |\n    fixes #123\n";
const INDENT_IN_QUOTE = "> intro\n>\n>     Fixes #123\n";
const DEF_AFTER_HEADING = "## References\n[d]: #123\n\nsee [d]\n";
const DEF_IN_QUOTE = "> intro\n>\n> [dest]: #123\n\nsee [dest]\n";

test("a line that leaves no open paragraph lets indented code follow it", () => {
  // Only recognizable paragraph content blocks the next line from starting a block;
  // every other shape, modelled or not, falls back to treating the indent as code.
  for (const source of [
    INDENT_AFTER_HEADING,
    INDENT_AFTER_SETEXT,
    INDENT_AFTER_BREAK,
    INDENT_AFTER_RAW_CLOSE,
    INDENT_AFTER_TABLE,
  ]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

test("a blockquote's own blank line and indent are read at its content column", () => {
  // `>` alone is the blockquote's blank line, so what follows starts a block: an
  // indented line is code, and a definition line registers instead of corrupting.
  for (const source of [INDENT_IN_QUOTE, DEF_IN_QUOTE, DEF_AFTER_HEADING]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source), [], label);
    assert.equal(neutralizeSuspectRefs(source).text, source, label);
  }
});

const FENCE_DEPTH_MISMATCH = "> ```\n> a\n```\n#123\n";
const FENCE_QUOTE_THEN_PROSE = "> ~~~\n> a\n> ~~~\n\n#123\n";

test("a fence inside a blockquote is a fence", () => {
  // The tilde form is the one that showed the damage: backticks in a quoted fence
  // happen to open a code SPAN, which hid the refs by accident.
  assert.deepEqual(findSuspectRefs(FENCE_IN_QUOTE), []);
  assert.equal(neutralizeSuspectRefs(FENCE_IN_QUOTE).text, FENCE_IN_QUOTE);
  // And it closes, so prose after the blockquote is scanned again.
  assert.deepEqual(findSuspectRefs(FENCE_QUOTE_THEN_PROSE), ["#123"]);
});

test("a fence pairs only at its own container depth", () => {
  // An unquoted ``` line cannot close a fence opened inside a blockquote, so the
  // reference below stays inside code — which is where the renderer puts it too.
  assert.deepEqual(findSuspectRefs(FENCE_DEPTH_MISMATCH), []);
  assert.equal(
    neutralizeSuspectRefs(FENCE_DEPTH_MISMATCH).text,
    FENCE_DEPTH_MISMATCH,
  );
});

test("a fence recovers when a deeper quote drops a level", () => {
  assert.deepEqual(findSuspectRefs("> > ~~~\n> > c\n> after #1\n"), ["#1"]);
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

// The forges disagree about an escaped trigger, so the escape arm has two modes and
// both are pinned. GitHub's reference filter runs after rendering, on text the escape
// has already been consumed from, so `\#123` autolinks there; GitLab leaves it alone.
test("an escaped trigger is a candidate by default, backslash run and all", () => {
  assert.deepEqual(findSuspectRefs(ESC_1), [ESC_1]);
  assert.deepEqual(findSuspectRefs(ESC_3), [ESC_3]);
  assert.deepEqual(findSuspectRefs(String.raw`\!45`, ["#", "!"]), [
    String.raw`\!45`,
  ]);
  // The wrap must ENCLOSE the backslashes. Opening the span after them would leave
  // the span's own tick escaped, and the reference bare and live outside it.
  const one = neutralizeSuspectRefs(ESC_1);
  assert.equal(one.text, `\`${ESC_1}\``);
  assert.deepEqual(one.wrapped, [`\`${ESC_1}\``]);
  assert.equal(neutralizeSuspectRefs(ESC_3).text, `\`${ESC_3}\``);
  // A word character before the run still keeps it plain: the boundary rule reads
  // what ends up adjacent once the renderer consumes the backslash.
  assert.deepEqual(findSuspectRefs(`a${ESC_1}`), []);
});

const ESCAPED_IN_HTML = `<details>\nFixes ${ESC_1}\n</details>`;

test("an escaped reference inside a raw HTML block is held in BOTH modes", () => {
  // No escape processing happens inside raw HTML, so the backslash is literal text
  // and both forges linkify the reference beside it. The GitLab mode's reason for
  // leaving an escape alone does not reach in here. The raw-HTML arm still refuses
  // to rewrite, so it lands in `survived` carrying its backslash.
  for (const live of [true, false]) {
    const label = `escapedRefsLive=${live}`;
    assert.deepEqual(
      findSuspectRefs(ESCAPED_IN_HTML, ["#", "!"], live),
      [ESC_1],
      label,
    );
    const out = neutralizeSuspectRefs(ESCAPED_IN_HTML, ["#", "!"], live);
    assert.equal(out.text, ESCAPED_IN_HTML, label);
    assert.deepEqual(out.wrapped, [], label);
    assert.deepEqual(out.survived, [`\`${ESC_1}\``], label);
  }
});

test("the GitLab mode leaves an escaped trigger alone", () => {
  for (const source of [ESC_1, ESC_3, String.raw`\!45`]) {
    const label = JSON.stringify(source);
    assert.deepEqual(findSuspectRefs(source, ["#", "!"], false), [], label);
    const out = neutralizeSuspectRefs(source, ["#", "!"], false);
    assert.equal(out.text, source, label);
    assert.deepEqual(out.wrapped, [], label);
  }
  // An EVEN run is not an escape at all, so both modes agree about it.
  for (const source of [ESC_2, ESC_4]) {
    assert.deepEqual(
      findSuspectRefs(source, ["#", "!"], false),
      findSuspectRefs(source),
      JSON.stringify(source),
    );
  }
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
  // Raw HTML blocks — the population that makes `survived` reachable.
  HTML_DETAILS,
  HTML_DETAILS_SPACED,
  HTML_SUMMARY_INLINE,
  HTML_CLOSER_MID_TEXT,
  HTML_SPAN_INLINE,
  HTML_SPAN_ALONE,
  HTML_MIXED,
  HTML_SAME_TOKEN,
  HTML_TICK_INSIDE,
  // Negative controls: each one wrapped a reference INSIDE raw HTML before the
  // region grammar read container columns, CommonMark's blank line, and block
  // starts that beat an open span. The renderer oracle below is what catches them.
  HTML_IN_QUOTE,
  HTML_IN_LIST,
  HTML_IN_ORDERED_LIST,
  HTML_NBSP_LINE,
  HTML_ACROSS_SPAN,
  HTML_QUOTED_STRAY,
  HTML_RAW_TEXT,
  // The oracle cannot see href corruption (a wrapped destination still renders as
  // an anchor), so these are pinned by byte-identity above; here they only have to
  // stay consistent with the partition and fixed-point properties.
  LINK_DEF_USED,
  LINK_DEF_ALONE,
  LINK_DEF_SPLIT,
  LINK_DEF_AS_PROSE,
  LINK_REF_SHORTCUT,
  LINK_REF_COLLAPSED,
  LINK_REF_FULL,
  LINK_REF_FOLDED,
  LINK_REF_NO_DEFINITION,
  LINK_REF_FENCED_DEF,
  INDENT_PROSE_CONTINUATION,
  INDENT_LIST_CONTINUATION,
  INDENT_DEEP_LIST_CONTINUATION,
  INDENT_CODE_BLOCK,
  INDENT_CODE_IN_LIST,
  FENCE_IN_QUOTE,
  FENCE_DEPTH_MISMATCH,
  FENCE_QUOTE_THEN_PROSE,
  DEF_INVALID_TAIL,
  DEF_DEFERRED_INVALID,
  DEF_ANGLE_DEST,
  DEF_TITLED,
  DEF_TITLED_PARENS,
  FENCE_QUOTE_UNPAIRED_REPLY,
  FENCE_QUOTE_UNPAIRED_MIN,
  FENCE_QUOTE_LAZY,
  FENCE_UNQUOTED_UNPAIRED,
  FENCE_QUOTE_BLANK_INSIDE,
  FENCE_QUOTE_BLANK_CONTENT,
  FENCE_QUOTE_BLANK_THEN_PROSE,
  FENCE_NESTED_BLANK,
  HTML_QUOTE_BLANK_INSIDE,
  ESCAPED_IN_HTML,
  HTML_TYPE7_MID_PARAGRAPH,
  HTML_TYPE7_AFTER_BLANK,
  HTML_TYPE6_MID_PARAGRAPH,
  TAG_ATTR_DOUBLE,
  TAG_ATTR_SINGLE,
  TAG_ATTR_TWO,
  TAG_ATTR_UNQUOTED,
  TAG_TEXT_CONTENT,
  TAG_TEXT_AFTER,
  TAG_TICKS_INSIDE,
  TAG_NOT_A_TAG_DIGIT,
  TAG_NOT_A_TAG_BARE,
  TAG_ESCAPED_ANGLE,
  LIST_DEDENT_BULLET,
  LIST_DEDENT_ORDERED,
  LIST_DEDENT_AFTER_BODY,
  LIST_DEDENT_AFTER_INDENTED_BODY,
  LIST_DEDENT_AFTER_BLANK,
  LIST_TAG_INDENTED,
  LIST_TAG_INDENTED_ORDERED,
  LIST_FENCE_CHAIN,
  LIST_FENCE_ORDERED,
  LIST_FENCE_BACKTICK,
  LIST_FENCE_UNCLOSED,
  LIST_FENCE_DEDENT_ENDS,
  LIST_FENCE_INNER_BLANK,
  LIST_FENCE_CONTINUATION,
  LIST_FENCE_DEDENT_CLOSER,
  DEF_INSIDE_SPAN,
  DEF_DEFERRED_SETEXT,
  DEF_DEFERRED_BREAK,
  DEF_DEFERRED_TAG,
  DEF_DEFERRED_FENCE,
  DEF_DEFERRED_QUOTE,
  DEF_DEFERRED_BULLET,
  DEF_DEFERRED_ORDERED,
  DEF_DEFERRED_HEADING,
  ...HTML_TYPE7_IN_CONTAINER,
  SPAN_ACROSS_TYPE7,
  SPAN_HIDING_A_DEFINITION,
  DEF_DEFERRED_QUOTE_TIGHT,
  DEF_DEFERRED_TYPE7,
  DEF_DEFERRED_IN_QUOTE,
  DEF_LAZY_CONTINUATION,
  DEF_LAZY_DEDENT,
  DEF_LAZY_WITH_USE,
  DEF_LAZY_BLOCK_START,
  SPAN_THROUGH_QUOTE_TYPE7,
  SPAN_THROUGH_LIST_TYPE7,
  SPAN_THROUGH_NESTED_TYPE7,
  SPAN_THROUGH_DEDENT_TYPE7,
  SPAN_THROUGH_HEADING_TYPE7,
  SPAN_THROUGH_QUOTED_BLANK_TYPE7,
  SPAN_FROM_HEADING_LINE,
  SPAN_STOPPED_BY_CONTAINER,
  SPAN_ACROSS_HEADING,
  SPAN_ACROSS_QUOTED_HEADING,
  SPAN_CLOSER_ON_HEADING,
  SPAN_ACROSS_THEMATIC,
  SPAN_ACROSS_SETEXT,
  SPAN_OVER_EMOJI,
  SPAN_OVER_BANGS,
  SPAN_OVER_PIPES,
  SPAN_OPENS_ON_HEADING,
  SPAN_OPENS_ON_QUOTED_HEADING,
  SPAN_ACROSS_QUOTED_BLANK,
  SPAN_OVER_LAZY_DEDENT,
  SPAN_OVER_LAZY_DEDENT_OUTSIDE,
  SPAN_DEDENT_TO_HEADING,
  SPAN_DEDENT_TO_LIST,
  HTML_TYPE7_CONTAINER_ALREADY_OPEN,
  HTML_TYPE7_AFTER_QUOTED_FENCE,
  INDENT_AFTER_HEADING,
  INDENT_AFTER_SETEXT,
  INDENT_AFTER_BREAK,
  INDENT_AFTER_RAW_CLOSE,
  INDENT_AFTER_TABLE,
  INDENT_IN_QUOTE,
  DEF_AFTER_HEADING,
  DEF_IN_QUOTE,
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

/** The same document with Windows line endings. Written as a `\r` escape, never a
 *  literal byte: this repo checks out CRLF, so a real CR in a fixture would be both
 *  invisible in review and rewritten by the next checkout. */
const toCrlf = (s) => s.replace(/\n/g, "\r\n");

test("CRLF input classifies exactly as its LF twin", () => {
  // The scan splits on `\n`, so every line would otherwise carry a trailing `\r` into
  // tests anchored at `$` — a blank line stops reading blank, a closing fence's tail
  // stops reading empty, and the fence swallows the rest of the comment.
  for (const source of CORPUS) {
    const label = JSON.stringify(source);
    assert.deepEqual(
      findSuspectRefs(toCrlf(source)),
      findSuspectRefs(source),
      label,
    );
  }
});

test("CRLF output is its LF twin's output, transformed", () => {
  // The invariant that holds for every entry: wrapping commutes with the line-ending
  // transform. Wraps are inserted at offsets into the ORIGINAL text and never rewrite
  // a line ending, so converting first and wrapping second gives the same bytes as
  // wrapping first and converting second.
  for (const source of CORPUS) {
    const label = JSON.stringify(source);
    const lf = neutralizeSuspectRefs(source);
    const crlf = neutralizeSuspectRefs(toCrlf(source));
    assert.equal(crlf.text, toCrlf(lf.text), label);
    assert.deepEqual(crlf.wrapped, lf.wrapped, label);
    assert.deepEqual(crlf.survived, lf.survived, label);
  }
});

// Direct pins for the arms `\r` broke, each stated as its own shape rather than left
// to the sweep above. The fence chain is the reported one: unclosed, it swallowed
// every reference after it and posted them live with no disclosure.
const CRLF_FENCE_CHAIN = "~~~\r\nexample\r\n~~~\r\nSee #123";
const CRLF_BLANK_BOUND = "a ` open\r\n\r\nb #5 ` c";
const CRLF_DEFINITION = "[dest]: /url\r\n\r\nSee [dest] and #5.\r\n";
const CRLF_HTML_BLOCK = "<details>\r\nFixes #123\r\n</details>\r\n";
// One document with both endings, to prove the strip is per-line and not global.
const MIXED_EOL = "a ` open\r\n\nb #5 ` c\r\nSee #6\n";

test("a CRLF fence closes and the text after it is scanned", () => {
  assert.deepEqual(findSuspectRefs(CRLF_FENCE_CHAIN), ["#123"]);
  assert.ok(
    !neutralizeSuspectRefs(CRLF_FENCE_CHAIN).text.includes("`example`"),
  );
});

test("a CRLF blank line still bounds a paragraph", () => {
  assert.deepEqual(findSuspectRefs(CRLF_BLANK_BOUND), ["#5"]);
});

test("CRLF definition and HTML-block lines classify normally", () => {
  assert.deepEqual(findSuspectRefs(CRLF_DEFINITION), ["#5"]);
  const html = neutralizeSuspectRefs(CRLF_HTML_BLOCK);
  assert.equal(html.text, CRLF_HTML_BLOCK);
  assert.deepEqual(html.survived, ["`#123`"]);
});

test("a document with mixed line endings classifies per line", () => {
  assert.deepEqual(findSuspectRefs(MIXED_EOL), ["#5", "#6"]);
  // Every line ending is preserved exactly as it was. `#6` takes a run of two
  // because the tick after `#5` is an unpaired stray in the same paragraph, and
  // `#5` takes a run of one because the blank line above cleared the first tick.
  assert.equal(
    neutralizeSuspectRefs(MIXED_EOL).text,
    "a ` open\r\n\nb `#5` ` c\r\nSee ``#6``\n",
  );
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
    // marked parses a few geometries differently from the forges; those are pinned
    // directly instead — see ORACLE_EXCLUDED for which and why.
    if (ORACLE_EXCLUDED.has(source)) continue;
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
      // Survivors sit outside the strictly-decreases arm above on purpose: a
      // raw HTML block's ref is LEFT live and disclosed, so the only bar here
      // is that neutralizing never made it more exposed than it was.
      assert.ok(
        liveCount(after, token) <= liveCount(before, token),
        `${token} renders MORE exposed after neutralizing ${label}`,
      );
    }
  }
});

// The wrapped-arm oracle above cannot see this failure: a broken reference link still
// renders, just as bracket text instead of an anchor, and its ref is not MORE exposed
// than it started. So the link itself is what gets asserted.
test("a reference link still renders as a link afterwards", async (t) => {
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
  for (const source of [
    LINK_REF_SHORTCUT,
    LINK_REF_COLLAPSED,
    LINK_REF_FULL,
    LINK_REF_FOLDED,
  ]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    assert.match(md.parse(out.text), /<a href=/, label);
    assert.equal(md.parse(out.text), md.parse(source), label);
  }
});

test("the renderer agrees about the CRLF corpus too", async (t) => {
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
  // CommonMark accepts `\r\n`, so the same claim has to hold over the transformed
  // corpus. Exclusions are keyed on the LF original — the divergence they name is
  // about the parser's block model, not about line endings.
  for (const source of CORPUS) {
    if (ORACLE_EXCLUDED.has(source)) continue;
    const crlf = toCrlf(source);
    const out = neutralizeSuspectRefs(crlf);
    if (out.wrapped.length === 0 && out.survived.length === 0) continue;
    const after = outsideCode(md.parse(out.text));
    const before = outsideCode(md.parse(crlf));
    const label = JSON.stringify(crlf);
    for (const form of out.wrapped) {
      const token = stripTicks(form);
      const beforeN = liveCount(before, token);
      assert.ok(
        liveCount(after, token) <= Math.max(beforeN - 1, 0),
        `${token} still renders outside a code span for ${label}`,
      );
    }
  }
});

// The wrapped-arm oracle cannot speak for an escaped token: its own string carries a
// backslash the renderer consumes, so its live count is zero before AND after and the
// strictly-decreases assertion passes vacuously. What matters is the BARE reference
// the forge filter would see post-render, so that is asserted directly.
test("an escaped reference stops rendering live once wrapped", async (t) => {
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
  for (const source of [ESC_1, ESC_3]) {
    const label = JSON.stringify(source);
    const out = neutralizeSuspectRefs(source);
    // Before: marked consumes the escape, so `#123` is live body text — which is
    // exactly what GitHub's post-render filter linkifies.
    assert.equal(liveCount(outsideCode(md.parse(source)), "#123"), 1, label);
    assert.equal(liveCount(outsideCode(md.parse(out.text)), "#123"), 0, label);
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

test("the disclosure names the escaped form it actually shipped", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: `Fixes ${ESC_1} now`,
    neutralizeRefs: true,
  });
  assert.ok(body.includes(`Fixes \`${ESC_1}\` now`), body);
  assert.ok(
    body.endsWith(
      `_References \`${ESC_1}\` are shown as plain text — this automated run could not confirm they were meant to link._`,
    ),
    body,
  );
  // The footer's own copy sits in a code span, so it mints no reference either.
  assert.deepEqual(findSuspectRefs(body), []);
});

test("the footer names an escaped reference held inside raw HTML", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: ESCAPED_IN_HTML,
    neutralizeRefs: true,
  });
  assert.ok(body.includes(ESCAPED_IN_HTML), body);
  assert.ok(
    body.endsWith(
      `_This automated run could not neutralize \`${ESC_1}\` — verify before trusting any links it created._`,
    ),
    body,
  );
});

test("without the flag the refs are left exactly as written", () => {
  const text = "Recorded decision (#10).";
  const body = buildAiCommentBody({ ...PARTS, text });
  assert.ok(body.includes(text), body);
  assert.ok(!body.includes("_References "), body);
});

test("a body whose only refs sit in a raw HTML block still discloses them", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: HTML_DETAILS,
    neutralizeRefs: true,
  });
  // The region is byte-identical in the shipped body, so the footer is the only
  // thing standing between the reader and a live cross-reference.
  assert.ok(body.includes(HTML_DETAILS), body);
  assert.ok(!body.includes("_References "), body);
  assert.ok(
    body.endsWith(
      "_This automated run could not neutralize `#123` — verify before trusting any links it created._",
    ),
    body,
  );
});

test("a body with both outcomes names the wraps and the survivor", () => {
  const body = buildAiCommentBody({
    ...PARTS,
    text: HTML_MIXED,
    neutralizeRefs: true,
  });
  assert.ok(
    body.endsWith(
      "_References `#7` are shown as plain text — this automated run could not confirm they were meant to link. It could not neutralize `#8`._",
    ),
    body,
  );
});

test("a body the guard cannot fully clear never claims more than it did", () => {
  // The post-condition is the tripwire for a geometry the scan reads wrongly, and
  // the corpus entries whose refs sit INSIDE a raw HTML block are its live
  // producers, so both footer arms run against real output rather than a shape.
  // The fixtures that deliberately open no block (the blank-line-spaced, inline
  // `<span>`, and tick-inside variants) still wrap, and are the control.
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
