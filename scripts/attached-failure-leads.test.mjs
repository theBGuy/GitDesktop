// Pins the app sentences github/pr.rs writes for a failed attached write
// (src-tauri/src/github/pr.rs) to the rules that read them in
// src/lib/error-summary.ts: `attached_run_failure`'s line must start with one of
// NOTHING_EXISTS_DISCLOSURES, or the summary rewrites it as a network failure, and
// `edit_body_dropped_text`'s must start with SAVED_DISCLOSURE_LEAD and carry the
// saved-changes marker `otherChangesSaved` keys on. A one-sided rewording would
// silently lose either.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail. The TS module loads through the shared src hooks, as in
// error-summary.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const {
  NOTHING_EXISTS_DISCLOSURES,
  otherChangesSaved,
  presentError,
  SAVED_DISCLOSURE_LEAD,
} = await import("@/lib/error-summary");

const RUST = new URL("../src-tauri/src/github/pr.rs", import.meta.url);
const read = (url) => readFileSync(url, "utf8");

/** A gh transport line the summary rewrites unless line one outranks it. */
const TRANSPORT_TAIL =
  'Post "https://uploads.github.com/": dial tcp 140.82.112.6:443: i/o timeout';

/** The body of the file's ONE `fn <name>(`, up to its closing column-0 brace, or
 *  null when there isn't exactly one. */
function fnBody(src, name) {
  const heads = [...src.matchAll(new RegExp(`\\bfn ${name}\\(`, "g"))];
  if (heads.length !== 1) return null;
  const start = heads[0].index;
  // A CRLF checkout puts a CR before each newline.
  const close = src.slice(start).search(/\n\}\r?\n/);
  return close === -1 ? null : src.slice(start, start + close);
}

/** The first `format!` string literal in a body, or null. */
function formatLiteral(body) {
  const m = body.match(/format!\(\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

/** The lines `attached_run_failure` can build, one per verb, or the reason the
 *  source can't be read. */
function attachedLines(src) {
  const body = fnBody(src, "attached_run_failure");
  if (body === null) return "attached_run_failure not found exactly once";
  const verbs = [...body.matchAll(/AttachedWrite::\w+ => "(\w+)"/g)].map(
    (m) => m[1],
  );
  if (verbs.length !== 2) return `expected two verbs, read ${verbs.length}`;
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  const lines = verbs.map((verb) =>
    literal.replace("{verb}", verb).replace("{}", "image-1.png"),
  );
  if (lines.some((l) => /[{}\\]/.test(l)))
    return "the literal holds a placeholder or escape this pin can't fill";
  return lines;
}

/** Null when every attached line leads with a TS lead and the summary keeps it
 *  over a transport tail; otherwise the reason the pin fails. */
function attachedMismatch(src) {
  const lines = attachedLines(src);
  if (typeof lines === "string") return lines;
  for (const line of lines) {
    if (!NOTHING_EXISTS_DISCLOSURES.some((lead) => line.startsWith(lead)))
      return `no TS lead starts ${JSON.stringify(line)}`;
    const message = `${line}\n${TRANSPORT_TAIL}`;
    if (presentError({ kind: "gh", message }).summary !== line)
      return `the summary rewrites ${JSON.stringify(line)}`;
  }
  return null;
}

/** Null when `edit_body_dropped_text`'s sentence starts with the TS lead and
 *  carries the saved marker. */
function droppedMismatch(src) {
  const body = fnBody(src, "edit_body_dropped_text");
  if (body === null) return "edit_body_dropped_text not found exactly once";
  const literal = formatLiteral(body);
  if (literal === null) return "no format! literal";
  const line = literal.replace("{what}", "image-1.png");
  // A Rust escape such as `\n` is two characters here but a line break at
  // runtime, which could move the marker off line one unseen.
  if (/[{}\\]/.test(line))
    return "the literal holds a placeholder or escape this pin can't fill";
  if (!line.startsWith(SAVED_DISCLOSURE_LEAD))
    return `${JSON.stringify(line)} doesn't start with the TS lead`;
  return otherChangesSaved({ kind: "gh", message: line })
    ? null
    : `no saved marker in ${JSON.stringify(line)}`;
}

test("attached_run_failure's lines lead with the TS rule's leads", () => {
  const src = read(RUST);
  assert.equal(attachedMismatch(src), null);
  assert.deepEqual(attachedLines(src), [
    "Nothing was created because image-1.png didn't upload. Try again.",
    "Nothing was posted because image-1.png didn't upload. Try again.",
  ]);
});

test("edit_body_dropped_text's sentence leads with the TS lead and carries the saved-changes marker", () => {
  assert.equal(droppedMismatch(read(RUST)), null);
});

test("both pins fail on a reworded, renamed or duplicated Rust source", () => {
  const src = read(RUST);
  const lead = '"Nothing was {verb} because';
  const marker = "Your other changes were saved.";
  const droppedLead = "\"The description wasn't saved because";
  assert.ok(
    src.includes(lead) && src.includes(marker) && src.includes(droppedLead),
  );
  const swap = (from, to) => src.replace(from, () => to);
  const attachedMutants = [
    ["a reworded lead", swap(lead, '"Nothing got {verb} because')],
    ["a dropped because", swap(lead, '"Nothing was {verb}.')],
    ["a renamed verb", swap('=> "posted"', '=> "sent"')],
    ["a renamed fn", swap("fn attached_run_failure(", "fn run_failure(")],
    ["a duplicated fn", `${src}\nfn attached_run_failure() {\n}\n`],
  ];
  for (const [name, mutant] of attachedMutants)
    assert.notEqual(attachedMismatch(mutant), null, `mutant passed: ${name}`);
  const droppedMutants = [
    ["a reworded marker", swap(marker, "The rest was saved.")],
    [
      "a reworded lead",
      swap(droppedLead, '"The description was not saved because'),
    ],
    [
      "a lead moved off the start",
      swap(droppedLead, `"Edit: ${droppedLead.slice(1)}`),
    ],
    ["a line break before the marker", swap(marker, `\\n${marker}`)],
    ["a renamed fn", swap("fn edit_body_dropped_text(", "fn dropped_text(")],
  ];
  for (const [name, mutant] of droppedMutants)
    assert.notEqual(droppedMismatch(mutant), null, `mutant passed: ${name}`);
});
