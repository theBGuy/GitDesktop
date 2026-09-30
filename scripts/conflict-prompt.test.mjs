// Pins the AI conflict proposal's trailing newline. Extraction drops the file's
// last line break and the accept writes the proposal as-is, so the view
// restores the newline its reference side ends with: without it every accepted
// file loses its trailing newline, and a proposal identical to ours previews as
// a one-line "\ No newline" diff instead of an empty one.
//
// `conflict-prompt.ts` imports `./truncate` extensionless, which Node's type
// stripping cannot resolve, so the shared src hooks go in first and the import
// is dynamic (a static one links before the hooks exist).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { extractResolvedContent, withReferenceTrailingNewline } = await import(
  "@/lib/ai/conflict-prompt"
);

test("extraction never keeps the file's last line break, on every path", () => {
  // The contract the helper appends against: a closing fence takes exactly one
  // break with it, and the trim leaves none anywhere else.
  for (const [name, raw, want] of [
    ["fenced", "```\na\nb\n```", "a\nb"],
    ["fenced + language", "```ts\na\nb\n```", "a\nb"],
    ["fenced CRLF", "```\r\na\r\nb\r\n```", "a\r\nb"],
    ["fenced, blank last line", "```\na\n\n```", "a\n"],
    ["fenced, prose around", "Here:\n```\na\n```\nDone.", "a"],
    ["unterminated opener", "```\na\nb\n", "a\nb"],
    ["closing fence only", "a\nb\n```", "a\nb"],
    ["closing fence only, blank last line", "a\n\n```", "a\n"],
    ["closing fence only CRLF", "a\r\nb\r\n```", "a\r\nb"],
    ["plain, trimmed", "a\nb\n\n", "a\nb"],
  ]) {
    assert.equal(extractResolvedContent(raw), want, name);
  }
});

test("a file ending in a blank line round-trips through extraction", () => {
  for (const ours of ["fn a() {}\n\n", "a\r\n\r\n"]) {
    const merged = withReferenceTrailingNewline(
      extractResolvedContent(`\`\`\`\n${ours}\`\`\``),
      ours,
    );
    assert.equal(merged, ours, JSON.stringify(ours));
  }
});

test("a single-line proposal takes the reference's line ending", () => {
  const ours = "a\r\n";
  const merged = withReferenceTrailingNewline(
    extractResolvedContent("```\r\na\r\n```"),
    ours,
  );
  assert.equal(merged, ours);
  assert.equal(withReferenceTrailingNewline("a", "b\n"), "a\n");
});

test("CRLF round trip through extraction comes back byte-equal to ours", () => {
  const ours = "a\r\nb\r\n";
  const merged = withReferenceTrailingNewline(
    extractResolvedContent("```\r\na\r\nb\r\n```"),
    ours,
  );
  assert.equal(merged, ours);
});

test("no extracted-and-restored proposal ever ends in a doubled CR", () => {
  for (const raw of [
    "```\r\na\r\nb\r\n```",
    "```ts\r\na\r\nb\r\n```",
    "Here you go:\r\n```\r\na\r\n```\r\nDone.",
    "```\r\na\r\nb",
    "a\r\nb\r\n```",
  ]) {
    for (const reference of ["x\r\n", "x\n", "x"]) {
      const out = withReferenceTrailingNewline(
        extractResolvedContent(raw),
        reference,
      );
      assert.ok(!out.endsWith("\r\r\n"), JSON.stringify({ raw, out }));
      assert.ok(!out.endsWith("\r"), JSON.stringify({ raw, out }));
    }
  }
});

test("a proposal missing the reference's trailing newline gets it back", () => {
  assert.equal(withReferenceTrailingNewline("a\nb", "a\nc\n"), "a\nb\n");
  // CRLF proposal: the restored newline follows the proposal's own style.
  assert.equal(
    withReferenceTrailingNewline("a\r\nb", "a\r\nc\r\n"),
    "a\r\nb\r\n",
  );
  // A multi-line LF proposal against a CRLF reference stays LF (no mixed endings).
  assert.equal(withReferenceTrailingNewline("a\nb", "a\r\nc\r\n"), "a\nb\n");
});

test("round trip: a proposal identical to ours comes back byte-equal", () => {
  const ours = "fn a() {}\nfn b() {}\n";
  const merged = withReferenceTrailingNewline(
    extractResolvedContent(`\`\`\`rust\n${ours}\`\`\``),
    ours,
  );
  assert.equal(merged, ours);
});

test("neither side ending in a newline leaves the proposal unchanged", () => {
  assert.equal(withReferenceTrailingNewline("a\nb", "a\nc"), "a\nb");
  assert.equal(withReferenceTrailingNewline("a", ""), "a");
});

test("an empty proposal stays empty", () => {
  assert.equal(withReferenceTrailingNewline("", "a\n"), "");
});

test("a proposal ending in a blank line still gets the stripped break back", () => {
  // Extraction removed one break, so a remaining `\n` is a blank last line.
  assert.equal(withReferenceTrailingNewline("a\n", "a\n\n"), "a\n\n");
  assert.equal(withReferenceTrailingNewline("a\r\n", "a\r\n\r\n"), "a\r\n\r\n");
  // A reference without a trailing newline adds nothing, whatever the tail.
  assert.equal(withReferenceTrailingNewline("a\n\n", "a"), "a\n\n");
});
