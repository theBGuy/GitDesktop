// Pins how src/features/pulls/ChecksRollup.tsx wires the pending-check
// re-check (src/features/pulls/check-recheck.ts, pinned by
// scripts/check-recheck.test.mjs): the reducer is told the rollup's `open` as
// its visibility, so a collapse pauses it; the identities come from the PR's
// checks, with the watched pending criteria, over `headRunById`, never from the
// re-run latch; and the effect's cleanup clears only its timer, so a tab hide
// keeps each attempt's progress.
//
// A source-shape pin, so each case also runs the check over in-memory mutants
// to prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = new URL(
  "../src/features/pulls/ChecksRollup.tsx",
  import.meta.url,
);
const source = () => readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
/** The watched pending criteria, minus the run id the identities test. */
const WATCHED_PREDICATE = '(c) => !c.completedAt && bucketOf(c) === "pending"';

/** The span from `open` to its matching close bracket, or null. */
function balanced(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/** The arguments of the file's one `callee(` call, split at top-level commas,
 *  or null when there isn't exactly one readable call. */
function callArgs(src, callee) {
  const marker = `${callee}(`;
  if (src.split(marker).length - 1 !== 1) return null;
  const inner = balanced(src, src.indexOf(marker) + callee.length);
  if (inner === null) return null;
  const args = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth === 0 && ch === ",") {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/** The body of the first cleanup returned after the reducer call. */
function cleanupBody(src) {
  const call = src.indexOf("reconcileRecheck(");
  if (call < 0) return null;
  const ret = src.indexOf("return () => {", call);
  if (ret < 0) return null;
  const body = balanced(src, ret + "return () => ".length);
  return body === null ? null : body.replace(/\s+/g, " ").trim();
}

function pinFailures(src) {
  const failures = [];
  const ids = callArgs(src, "recheckIdentities");
  if (ids === null) failures.push("no readable recheckIdentities( call");
  else {
    if (ids[0] !== "checks") failures.push(`identities read \`${ids[0]}\``);
    if (ids[1] !== WATCHED_PREDICATE)
      failures.push("the pending predicate drifted from the watched criteria");
    if (ids[2] !== "headRunById") failures.push(`rows are \`${ids[2]}\``);
    if (ids.some((a) => /recentlyRerun|mountedWatchIds/.test(a)))
      failures.push("a latch-bearing list reaches the identities");
  }
  const reduce = callArgs(src, "reconcileRecheck");
  if (reduce === null) failures.push("no readable reconcileRecheck( call");
  else {
    if (reduce[2] !== "open") failures.push(`visibility is \`${reduce[2]}\``);
    if (reduce[4] !== "active")
      failures.push(`executing rows are \`${reduce[4]}\``);
  }
  const cleanup = cleanupBody(src);
  if (cleanup !== "if (timer !== undefined) clearTimeout(timer);")
    failures.push(`cleanup is \`${cleanup}\``);
  return failures;
}

/** `src` with exactly one occurrence of `from` swapped for `to`. */
function mutate(src, from, to) {
  assert.equal(src.split(from).length - 1, 1, `mutation anchor: ${from}`);
  return src.replace(from, () => to);
}

test("ChecksRollup wires the re-check to open, the checks and its timer", () => {
  assert.deepEqual(pinFailures(source()), []);
});

test("the pin fails when the reducer ignores the rollup's open state", () => {
  const mutant = mutate(
    source(),
    "        live,\n        open,\n        now,",
    "        live,\n        true,\n        now,",
  );
  assert.deepEqual(pinFailures(mutant), ["visibility is `true`"]);
});

test("the pin fails when the identities read the latch or drop a criterion", () => {
  const src = source();
  const latch = mutate(
    src,
    "          checks,\n          (c) =>",
    "          [...recentlyRerun.keys()],\n          (c) =>",
  );
  assert.deepEqual(pinFailures(latch), [
    "identities read `[...recentlyRerun.keys()]`",
    "a latch-bearing list reaches the identities",
  ]);
  const loose = mutate(
    src,
    '(c) => !c.completedAt && bucketOf(c) === "pending"',
    '(c) => bucketOf(c) === "pending"',
  );
  assert.deepEqual(pinFailures(loose), [
    "the pending predicate drifted from the watched criteria",
  ]);
  const wider = mutate(src, WATCHED_PREDICATE, `${WATCHED_PREDICATE} || c.foo`);
  assert.deepEqual(pinFailures(wider), [
    "the pending predicate drifted from the watched criteria",
  ]);
});

test("the pin fails when the reducer loses the executing rows", () => {
  const src = source();
  const anchor = "        now,\n        active,\n      );";
  const dropped = mutate(src, anchor, "        now,\n      );");
  assert.deepEqual(pinFailures(dropped), ["executing rows are `undefined`"]);
  const empty = mutate(src, anchor, "        now,\n        [],\n      );");
  assert.deepEqual(pinFailures(empty), ["executing rows are `[]`"]);
});

test("the pin fails when the cleanup drops the attempts' progress", () => {
  const mutant = mutate(
    source(),
    "      if (timer !== undefined) clearTimeout(timer);\n",
    "      if (timer !== undefined) clearTimeout(timer);\n      recheckState.current = new Map();\n",
  );
  assert.deepEqual(pinFailures(mutant), [
    "cleanup is `if (timer !== undefined) clearTimeout(timer); recheckState.current = new Map();`",
  ]);
});

test("the pin fails closed on a source it cannot read", () => {
  assert.deepEqual(pinFailures("const x = 1;"), [
    "no readable recheckIdentities( call",
    "no readable reconcileRecheck( call",
    "cleanup is `null`",
  ]);
});
