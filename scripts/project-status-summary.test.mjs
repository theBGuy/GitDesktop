// Pins the one-line summary a project status strip shows for an update's Markdown
// note. Its failures are silent — a snippet quoting code, or eating a literal `*`,
// still renders — so each shape the summary has to get right is a case.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `status-summary.ts` must
// stay import-free. A runtime import added there fails this file, which is the point.
import assert from "node:assert/strict";
import { test } from "node:test";

import { plainFirstLine } from "../src/features/projects/status-summary.ts";

test("an absent or empty note summarizes to nothing", () => {
  assert.equal(plainFirstLine(null), "");
  assert.equal(plainFirstLine(""), "");
  assert.equal(plainFirstLine("\n  \n"), "");
});

test("prose after a fenced block wins over the code inside it", () => {
  assert.equal(
    plainFirstLine("```ts\nconst answer = 42;\n```\nParser fix shipped"),
    "Parser fix shipped",
  );
});

test("a note that is only code falls back to its first code line", () => {
  assert.equal(
    plainFirstLine("```ts\n\n  const a = 1;  \nb\n```"),
    "const a = 1;",
  );
  // An unterminated fence runs to the end, so everything after it is code.
  assert.equal(plainFirstLine("```\nunterminated\nprose?"), "unterminated");
});

test("a fence closes only on its own character, at least as long", () => {
  assert.equal(plainFirstLine("~~~\n```\ninside\n~~~\nprose"), "prose");
  assert.equal(
    plainFirstLine("````\n```\ninside\n```\nstill code\n````\nafter"),
    "after",
  );
});

test("block prefixes are stripped", () => {
  assert.equal(plainFirstLine("## Heading text"), "Heading text");
  assert.equal(plainFirstLine("> quoted line"), "quoted line");
  assert.equal(plainFirstLine("- [x] task done"), "task done");
  assert.equal(plainFirstLine("* [ ] task open"), "task open");
  assert.equal(plainFirstLine("3. third step"), "third step");
  assert.equal(plainFirstLine("1) first step"), "first step");
});

test("links and images reduce to their text", () => {
  assert.equal(
    plainFirstLine("See the [beta](https://x.test) notes"),
    "See the beta notes",
  );
  assert.equal(
    plainFirstLine("![logo](a.png) Launch <b>day</b>"),
    "logo Launch day",
  );
});

test("a thematic break is skipped", () => {
  assert.equal(plainFirstLine("---\nAfter the rule"), "After the rule");
  assert.equal(plainFirstLine("* * *\nAfter stars"), "After stars");
});

test("paired emphasis is stripped and its text kept", () => {
  assert.equal(
    plainFirstLine("**bold** and *it* and _u_ and __b2__"),
    "bold and it and u and b2",
  );
  assert.equal(plainFirstLine("~~old~~ new"), "old new");
  assert.equal(plainFirstLine("`api` ready"), "api ready");
  assert.equal(plainFirstLine("``a`b`` spans"), "a`b spans");
  assert.equal(plainFirstLine("***both***"), "both");
  assert.equal(plainFirstLine("_*mixed*_ and *_mixed_*"), "mixed and mixed");
});

test("unpaired delimiters survive as the characters they are", () => {
  assert.equal(plainFirstLine("2 * 3 builds left"), "2 * 3 builds left");
  assert.equal(plainFirstLine("an unpaired ` tick"), "an unpaired ` tick");
  assert.equal(plainFirstLine("a ** b and **x"), "a ** b and **x");
  assert.equal(
    plainFirstLine("snake_case_name stays"),
    "snake_case_name stays",
  );
  assert.equal(plainFirstLine("2*3*4 and file_*.rs"), "2*3*4 and file_*.rs");
  assert.equal(
    plainFirstLine("~~ spaced ~~ and a~~b"),
    "~~ spaced ~~ and a~~b",
  );
});

test("code spans are set aside first, so nothing reads inside them", () => {
  assert.equal(
    plainFirstLine("Fixed `<Dialog>` focus"),
    "Fixed <Dialog> focus",
  );
  assert.equal(plainFirstLine("`__init__` renamed"), "__init__ renamed");
  assert.equal(plainFirstLine("2 * 3 `*` left"), "2 * 3 * left");
  // A delimiter inside a span can't pair with one outside it.
  assert.equal(plainFirstLine("`*x` and y*"), "*x and y*");
  // One space padding each side of a span is its syntax, not its content.
  assert.equal(plainFirstLine("` spaced ` out"), "spaced out");
  // Emphasis AROUND a span still strips.
  assert.equal(plainFirstLine("**`x`** done"), "x done");
});

test("underscore strong can't open or close inside a word", () => {
  assert.equal(plainFirstLine("snake__case__name"), "snake__case__name");
  assert.equal(plainFirstLine("__a__b"), "__a__b");
  assert.equal(
    plainFirstLine("**in**word stays bold-stripped"),
    "inword stays bold-stripped",
  );
});

test("angle brackets are a tag only with a letter after them", () => {
  assert.equal(
    plainFirstLine("p95 < 200ms, p99 > 1s"),
    "p95 < 200ms, p99 > 1s",
  );
  assert.equal(plainFirstLine("a <b>bold</b> tag"), "a bold tag");
  assert.equal(
    plainFirstLine("see <https://x.test/a> and <me@x.test>"),
    "see https://x.test/a and me@x.test",
  );
});

test("a line with a backtick in its would-be info string is prose, not a fence", () => {
  assert.equal(plainFirstLine("``` inline ``` text\nnext"), "inline text");
  // Inside a fence, a marker line with text after it doesn't close the fence.
  assert.equal(plainFirstLine("```\n```ts\ncode\n```\nprose"), "prose");
});

test("a very long line is read only as far as the strip could show", () => {
  // The cap is what bounds the quadratic inline scans; the lengths are the proof.
  assert.equal(plainFirstLine("x".repeat(70000)).length, 400);
  const summary = plainFirstLine(`${"**a ".repeat(16000)}end`);
  assert.ok(summary.length <= 400);
  assert.ok(!summary.includes("end"));
});

test("a triple underscore pair strips like its star twin, but never inside a word", () => {
  assert.equal(plainFirstLine("___both___"), "both");
  assert.equal(plainFirstLine("***both***"), "both");
  assert.equal(plainFirstLine("snake___case___name"), "snake___case___name");
});

test("nested container prefixes strip together, then one heading marker", () => {
  assert.equal(plainFirstLine("> - quoted item"), "quoted item");
  assert.equal(plainFirstLine("- 1. step"), "step");
  assert.equal(plainFirstLine("> > nested quote"), "nested quote");
  assert.equal(plainFirstLine("> # Title"), "Title");
  // A heading holds no blocks, so what follows its marker is its text.
  assert.equal(plainFirstLine("# 1. Intro"), "1. Intro");
  // A thematic break is still read as one before any prefix is stripped.
  assert.equal(plainFirstLine("- - -\nafter"), "after");
});
