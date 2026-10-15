// Pins the review prompt's "Author's description" section: the runner's body
// resolution (`reviewBody`, `bodyFetchFrom`) and the three arms
// `buildReviewPrompt` renders from it, plus the omission an absent `bodyState`
// keeps for commit and interactive reviews.
//
// `prompt.ts` imports extensionless and through `@/`, so the shared src hooks
// go in first and the imports are dynamic.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { bodyFetchFrom, reviewBody } = await import(
  "@/lib/automations/review-body"
);
const { buildReviewPrompt } = await import("@/lib/ai/prompt");

const HEADING = "## Author's description\n";
const EMPTY_LINE = `${HEADING}(none — the author left the description empty)`;
const UNREADABLE_LINE = `${HEADING}(could not be read for this review — treat it as unknown, not as empty)`;

const BASE = {
  title: "t",
  body: "",
  commitSubjects: [],
  diffText: "",
  diffTruncated: false,
  files: [],
};

function render(input) {
  return buildReviewPrompt({ ...BASE, ...input }, "general").prompt;
}

/** The description section's text after its heading line, up to the next
 *  top-level section the builder emits. */
function sectionBody(prompt) {
  const start = prompt.indexOf(HEADING);
  assert.ok(start >= 0, "prompt has no Author's description section");
  const rest = prompt.slice(start + HEADING.length);
  const end = rest.indexOf("\n\n## ");
  return end < 0 ? rest : rest.slice(0, end);
}

test("reviewBody: a settled read wins over a stale non-empty event body", () => {
  assert.deepEqual(reviewBody("stale body", { ok: true, body: "fresh body" }), {
    body: "fresh body",
    bodyState: undefined,
  });
  assert.deepEqual(reviewBody("stale body", { ok: true, body: "   " }), {
    body: "   ",
    bodyState: "empty",
  });
});

test("reviewBody: a failed read falls back to a non-empty event body", () => {
  assert.deepEqual(reviewBody("  real body ", { ok: false }), {
    body: "  real body ",
    bodyState: undefined,
  });
});

test("reviewBody: with no read a non-empty event body stands", () => {
  assert.deepEqual(reviewBody("real", undefined), {
    body: "real",
    bodyState: undefined,
  });
});

test("reviewBody: empty event body with no forge read is authoritatively empty", () => {
  assert.deepEqual(reviewBody("", undefined), { body: "", bodyState: "empty" });
  assert.deepEqual(reviewBody("   \n\t", undefined), {
    body: "   \n\t",
    bodyState: "empty",
  });
});

test("reviewBody: empty event body takes a non-empty fetched body", () => {
  assert.deepEqual(reviewBody("", { ok: true, body: "fetched" }), {
    body: "fetched",
    bodyState: undefined,
  });
  assert.deepEqual(reviewBody("   \n\t", { ok: true, body: "fetched" }), {
    body: "fetched",
    bodyState: undefined,
  });
});

test("reviewBody: a fetched whitespace-only body is empty", () => {
  assert.deepEqual(reviewBody("", { ok: true, body: "   " }), {
    body: "   ",
    bodyState: "empty",
  });
  assert.deepEqual(reviewBody("", { ok: true, body: "" }), {
    body: "",
    bodyState: "empty",
  });
});

test("reviewBody: a failed read over an empty event body is unreadable", () => {
  assert.deepEqual(reviewBody("", { ok: false }), {
    body: "",
    bodyState: "unreadable",
  });
  assert.deepEqual(reviewBody("   \n\t", { ok: false }), {
    body: "",
    bodyState: "unreadable",
  });
});

test("bodyFetchFrom: a settled read is ok, a rejected one is not", async () => {
  assert.deepEqual(
    await bodyFetchFrom(Promise.resolve({ body: "fresh" }), false),
    { ok: true, body: "fresh" },
  );
  assert.deepEqual(
    await bodyFetchFrom(Promise.reject(new Error("forge down")), true),
    { ok: false },
  );
});

test("bodyFetchFrom: no read is unreadable only when the event needs a body", async () => {
  assert.deepEqual(await bodyFetchFrom(undefined, true), { ok: false });
  assert.equal(await bodyFetchFrom(undefined, false), undefined);
});

test("prompt: a non-empty body renders verbatim under the one heading", () => {
  const body = "Intro\n\n## Decisions\nKeep the `foo` shim on purpose.";
  const prompt = render({ body });
  assert.ok(prompt.includes(`${HEADING}${body}`));
  assert.equal(prompt.split("## Author's description").length, 2);
});

test("prompt: an over-long body is capped with a disclosed cut", () => {
  const prompt = render({ body: "d".repeat(9000) });
  const text = sectionBody(prompt);
  assert.ok(text.length <= 8000, `section body is ${text.length} chars`);
  assert.ok(text.startsWith("d"));
  assert.match(text, /omitted/);
  assert.ok(!text.endsWith("d"), "the cut note follows the kept text");
});

test("prompt: bodyState empty renders the explicit none line", () => {
  assert.ok(render({ body: "", bodyState: "empty" }).includes(EMPTY_LINE));
  assert.ok(render({ body: "  \n", bodyState: "empty" }).includes(EMPTY_LINE));
});

test("prompt: bodyState unreadable renders the could-not-be-read line", () => {
  assert.ok(
    render({ body: "", bodyState: "unreadable" }).includes(UNREADABLE_LINE),
  );
});

test("prompt: an empty body without bodyState omits the section", () => {
  assert.ok(!render({ body: "" }).includes("## Author's description"));
  assert.ok(!render({ body: "   \n\t" }).includes("## Author's description"));
});

test("prompt: bodyState is ignored when the body is non-empty", () => {
  for (const bodyState of ["empty", "unreadable"]) {
    const prompt = render({ body: "real body", bodyState });
    assert.ok(prompt.includes(`${HEADING}real body`));
    assert.ok(!prompt.includes(EMPTY_LINE));
    assert.ok(!prompt.includes(UNREADABLE_LINE));
  }
});
