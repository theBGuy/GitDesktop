// Pins the pending ids src/features/pulls/ChecksRollup.tsx hands `useHeadRuns`:
// the open rollup's watched runs and never the re-run latch keys. A latched run
// that finished must park; feeding the latch (or `mountedWatchIds`, which holds
// it) into the wake would poll it for a window on every attempt. The wake rule
// itself is pure and pinned in scripts/run-poll.test.mjs.
//
// A source-shape pin, so each case runs the same check over an in-memory
// mutant to prove the check can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = new URL(
  "../src/features/pulls/ChecksRollup.tsx",
  import.meta.url,
);
const EXPECTED_PENDING = "open ? watchedRunIds : []";

/** The arguments of the file's one `useHeadRuns(` call, split at top-level
 *  commas, or null when there isn't exactly one call. */
function headRunsCallArgs(src) {
  const calls = src.split("useHeadRuns(").length - 1;
  if (calls !== 1) return null;
  const start = src.indexOf("useHeadRuns(") + "useHeadRuns(".length;
  const args = [];
  let depth = 0;
  let current = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (depth === 0 && ch === ")") {
      if (current.trim() !== "") args.push(current.trim());
      return args;
    }
    if (depth === 0 && ch === ",") {
      args.push(current.trim());
      current = "";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    current += ch;
  }
  return null;
}

/** What the call must hold: the open-only watched ids as its fourth argument,
 *  and no latch-bearing id list anywhere in it. */
function pinFailures(src) {
  const args = headRunsCallArgs(src);
  if (args === null) return ["not exactly one readable useHeadRuns( call"];
  const failures = [];
  if (args[3] !== EXPECTED_PENDING)
    failures.push(`pending ids are \`${args[3]}\``);
  if (args.some((a) => /recentlyRerun|mountedWatchIds\b(?!\.length)/.test(a)))
    failures.push("a latch-bearing id list reaches the call");
  return failures;
}

const source = () => readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");

test("ChecksRollup feeds the wake the open-only, latch-free pending ids", () => {
  assert.deepEqual(pinFailures(source()), []);
});

test("the pin fails when the wake is fed the latch-bearing mounted ids", () => {
  const src = source();
  assert.ok(src.includes(`    ${EXPECTED_PENDING},\n`));
  // NEGATIVE CONTROL: the same call over `mountedWatchIds`.
  const mutant = src.replace(
    `    ${EXPECTED_PENDING},\n`,
    () => "    mountedWatchIds,\n",
  );
  assert.deepEqual(pinFailures(mutant), [
    "pending ids are `mountedWatchIds`",
    "a latch-bearing id list reaches the call",
  ]);
  // …and over the watched ids whatever the rollup's open state.
  const unscoped = src.replace(
    `    ${EXPECTED_PENDING},\n`,
    () => "    watchedRunIds,\n",
  );
  assert.deepEqual(pinFailures(unscoped), ["pending ids are `watchedRunIds`"]);
});

test("the pin fails closed on an unreadable call", () => {
  assert.deepEqual(pinFailures("const x = 1;"), [
    "not exactly one readable useHeadRuns( call",
  ]);
});
