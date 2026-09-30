// Pins the AI conflict proposal's trailing newline. Extraction trims the fenced
// body's final newline and the accept writes the proposal as-is, so the view
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

test("extraction drops the whole newline, LF or CRLF, before the closing fence", () => {
  // The premise the helper exists for; if extraction ever keeps it, the helper
  // becomes a no-op rather than a double newline (it only adds when missing).
  assert.equal(extractResolvedContent("```ts\na\nb\n```"), "a\nb");
  // A CRLF response leaves no dangling `\r` for the helper to misread.
  assert.equal(extractResolvedContent("```\r\na\r\nb\r\n```"), "a\r\nb");
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
  // An LF proposal against a CRLF reference stays LF (no mixed endings).
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

test("an existing newline tail is never grown or trimmed", () => {
  assert.equal(withReferenceTrailingNewline("a\n", "a\n"), "a\n");
  assert.equal(withReferenceTrailingNewline("a\n\n", "a\n"), "a\n\n");
  // The helper only restores: a tail the reference lacks is left in place.
  assert.equal(withReferenceTrailingNewline("a\n\n", "a"), "a\n\n");
});
