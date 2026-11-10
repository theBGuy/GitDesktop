// Pins the facet byte cap the backend's `validate_run_filters` enforces
// (MAX_RUN_FACET_BYTES in src-tauri/src/github/actions.rs) equal to the one the
// Actions filter popover checks before offering a typed value
// (src/features/actions/run-filters.ts): a one-sided edit would offer values
// the read refuses, or refuse values it takes.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RUST = new URL("../src-tauri/src/github/actions.rs", import.meta.url);
const TS = new URL("../src/features/actions/run-filters.ts", import.meta.url);
const read = (url) => readFileSync(url, "utf8");

/** The integer literal of the file's ONE declaration matching `pattern` (whose
 *  group 1 is the literal), or null when there isn't exactly one. */
function oneLiteral(src, pattern) {
  const hits = [...src.matchAll(pattern)];
  return hits.length === 1 ? hits[0][1] : null;
}

const rustCap = (src) =>
  oneLiteral(src, /^const MAX_RUN_FACET_BYTES: usize = (\d+);$/gm);
const tsCap = (src) =>
  oneLiteral(src, /^export const MAX_RUN_FACET_BYTES = (\d+);$/gm);

/** Null when both sides declare the cap once with the same literal and the TS
 *  verdict reads it by name; otherwise the reason the pin fails. */
function capMismatch(rustSrc, tsSrc) {
  const r = rustCap(rustSrc);
  const t = tsCap(tsSrc);
  if (r === null) return "Rust cap not found exactly once";
  if (t === null) return "TS cap not found exactly once";
  if (!tsSrc.includes(".length > MAX_RUN_FACET_BYTES"))
    return "the TS verdict doesn't compare against the named cap";
  return r === t ? null : `Rust ${r} vs TS ${t}`;
}

test("the Rust and TS facet byte caps are equal", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  assert.equal(capMismatch(rustSrc, tsSrc), null);
  assert.equal(rustCap(rustSrc), "200");
});

test("the pin fails on a drifted, missing, duplicated or bypassed cap", () => {
  const rustSrc = read(RUST);
  const tsSrc = read(TS);
  const rustDecl = "const MAX_RUN_FACET_BYTES: usize = 200;";
  const tsDecl = "export const MAX_RUN_FACET_BYTES = 200;";
  const tsUse = ".length > MAX_RUN_FACET_BYTES";
  assert.ok(
    rustSrc.includes(rustDecl) &&
      tsSrc.includes(tsDecl) &&
      tsSrc.includes(tsUse),
  );

  const swap = (src, from, to) => src.replace(from, () => to);
  const mutants = [
    [
      "a raised Rust cap",
      swap(rustSrc, rustDecl, rustDecl.replace("200", "256")),
      tsSrc,
    ],
    [
      "a lowered TS cap",
      rustSrc,
      swap(tsSrc, tsDecl, tsDecl.replace("200", "100")),
    ],
    ["a removed TS constant", rustSrc, swap(tsSrc, tsDecl, "")],
    ["a second Rust declaration", `${rustSrc}\n${rustDecl}\n`, tsSrc],
    [
      "a TS verdict on an inline literal",
      rustSrc,
      swap(tsSrc, tsUse, ".length > 200"),
    ],
  ];
  for (const [name, r, t] of mutants)
    assert.notEqual(capMismatch(r, t), null, `mutant passed: ${name}`);
});
