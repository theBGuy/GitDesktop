// Pins the one lead `gh_workflow_run`'s input-422 humanizer writes
// (src-tauri/src/github/actions.rs) byte-equal to the TS constant that
// `isDispatchInputsError` matches (src/lib/github/actions.ts): the dispatch
// dialog's probe invalidation keys on it, and a one-sided edit would leave the
// classifier silently false.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RUST = new URL("../src-tauri/src/github/actions.rs", import.meta.url);
const TS = new URL("../src/lib/github/actions.ts", import.meta.url);
const read = (url) => readFileSync(url, "utf8");

/** The string literal of the file's ONE declaration matching `pattern` (whose
 *  group 1 is the literal body), or null when there isn't exactly one. */
function oneLiteral(src, pattern) {
  const hits = [...src.matchAll(pattern)];
  return hits.length === 1 ? hits[0][1] : null;
}

const rustLead = (src) =>
  oneLiteral(
    src,
    /const DISPATCH_INPUTS_REJECTED_LEAD: &str = "((?:[^"\\]|\\.)*)";/g,
  );
const tsLead = (src) =>
  oneLiteral(
    src,
    /export const DISPATCH_INPUTS_REJECTED_LEAD = "((?:[^"\\]|\\.)*)";/g,
  );

/** Null when both sides declare the lead once and the literals are byte-equal;
 *  otherwise the reason the pin fails. */
function leadMismatch(rustSrc, tsSrc) {
  const r = rustLead(rustSrc);
  const t = tsLead(tsSrc);
  if (r === null) return "Rust lead not found exactly once";
  if (t === null) return "TS lead not found exactly once";
  if (r.includes("\\") || t.includes("\\"))
    return "a lead carries an escape, which the byte compare can't read";
  return r === t
    ? null
    : `Rust ${JSON.stringify(r)} vs TS ${JSON.stringify(t)}`;
}

test("the Rust and TS dispatch-inputs leads are byte-equal", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  assert.equal(leadMismatch(rustSrc, tsSrc), null);
  assert.equal(rustLead(rustSrc), "Workflow inputs rejected: ");
});

test("the pin fails on a drifted, missing or duplicated lead", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  const rustDecl =
    'DISPATCH_INPUTS_REJECTED_LEAD: &str = "Workflow inputs rejected: ";';
  const tsDecl =
    'DISPATCH_INPUTS_REJECTED_LEAD = "Workflow inputs rejected: ";';
  assert.ok(rustSrc.includes(rustDecl) && tsSrc.includes(tsDecl));

  const drift = (src, decl, to) => src.replace(decl, () => to);
  const mutants = [
    [
      "a dropped trailing space in Rust",
      drift(rustSrc, rustDecl, rustDecl.replace(': ";', ':";')),
      tsSrc,
    ],
    [
      "a recased TS lead",
      rustSrc,
      drift(tsSrc, tsDecl, tsDecl.replace("inputs", "Inputs")),
    ],
    ["a removed TS constant", rustSrc, drift(tsSrc, tsDecl, "")],
    ["a second Rust declaration", `${rustSrc}\nconst ${rustDecl}\n`, tsSrc],
  ];
  for (const [name, r, t] of mutants)
    assert.notEqual(leadMismatch(r, t), null, `mutant passed: ${name}`);
});
