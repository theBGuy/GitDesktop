// Pins the content-mode build gate (src/features/diff/file-content-gate.ts):
// a refresh brings new diff text and new whole-file reads in separate answers,
// and the gate keeps the previous paint up until they agree, so each refresh
// builds once. The import reaches straight into src/ under Node's type
// stripping, so the module stays free of runtime imports; this suite needs no
// install.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changesSince,
  contentBuildGate,
  contentReadsKey,
  paintedAfter,
} from "../src/features/diff/file-content-gate.ts";

/** The reads of the default fixture: one file at a commit pair. */
const READS = contentReadsKey("f.ts", "aaaa~1", "aaaa");

/** Whether two paints were built from the same inputs. */
const sameInputs = (a, b) =>
  a !== null &&
  b !== null &&
  a.reads === b.reads &&
  a.text === b.text &&
  a.oldText === b.oldText &&
  a.newText === b.newText;

/** One render of a build site: what the gate decides over these reads, and
 *  whether the render builds (records new inputs) or keeps the paint. */
function render(
  painted,
  reads,
  {
    boundExpired = false,
    frozen = false,
    gate = contentBuildGate,
    after = paintedAfter,
  } = {},
) {
  const now = {
    reads: reads.reads ?? READS,
    text: reads.text,
    oldText: reads.old,
    newText: reads.new,
  };
  const pending = reads.wantContent !== false && reads.pending === true;
  const oldFetching = reads.oldFetching === true;
  const newFetching = reads.newFetching === true;
  const decision = gate({
    wantContent: reads.wantContent !== false,
    oldSettled: !pending,
    newSettled: !pending,
    oldFetching,
    newFetching,
    ...changesSince(painted, now),
    boundExpired,
    frozen,
  });
  const next = after(painted, decision, pending, now, {
    wantContent: reads.wantContent !== false,
    inFlight: oldFetching || newFetching,
  });
  return {
    decision,
    painted: next,
    built: next !== null && !sameInputs(next, painted),
  };
}

/** Runs a sequence of read states from a settled paint, counting builds. */
function run(start, steps, opts = {}) {
  let { painted } = render(null, start, opts);
  let builds = 0;
  const decisions = [];
  for (const reads of steps) {
    const r = render(painted, reads, opts);
    painted = r.painted;
    decisions.push(r.decision);
    if (r.built) builds++;
  }
  return { builds, decisions, painted };
}

const BEFORE = { text: "@@ -1 +1 @@\n-a\n+b\n", old: "a\n", new: "b\n" };
const AFTER = { text: "@@ -1 +1 @@\n-a\n+c\n", old: "a\n", new: "c\n" };

test("a refresh whose text lands first holds, then builds once", () => {
  const { builds, decisions, painted } = run(BEFORE, [
    // The new text over the old reads, both refetching.
    { ...BEFORE, text: AFTER.text, oldFetching: true, newFetching: true },
    // One read lands; the other is still in flight.
    { ...AFTER, oldFetching: true },
    // Both landed.
    AFTER,
  ]);
  assert.deepEqual(decisions, ["hold-previous", "hold-previous", "build"]);
  assert.equal(builds, 1);
  assert.equal(painted.text, AFTER.text);
  assert.equal(painted.newText, AFTER.new);
});

test("a refresh whose read lands first holds, then builds once", () => {
  const { builds, decisions } = run(BEFORE, [
    // The worktree read answers ahead of the diff text it belongs to.
    { ...BEFORE, new: AFTER.new },
    AFTER,
  ]);
  assert.deepEqual(decisions, ["hold-previous", "build"]);
  assert.equal(builds, 1);
});

test("the hold keeps the previous paint, never a pending blank", () => {
  const { painted: before } = render(null, BEFORE);
  const held = render(before, {
    ...BEFORE,
    text: AFTER.text,
    newFetching: true,
  });
  assert.equal(held.decision, "hold-previous");
  assert.equal(held.painted, before);
});

test("bound expiry paints the new text with what the reads have", () => {
  const { painted: before } = render(null, BEFORE);
  const expired = render(
    before,
    { ...BEFORE, text: AFTER.text, newFetching: true },
    { boundExpired: true },
  );
  assert.equal(expired.decision, "hunk-only");
  assert.equal(expired.built, true);
  assert.equal(expired.painted.text, AFTER.text);
});

test("an identical-text refetch builds nothing, in flight or landed", () => {
  const { painted: before } = render(null, BEFORE);
  for (const reads of [
    { ...BEFORE, oldFetching: true, newFetching: true },
    BEFORE,
  ]) {
    const r = render(before, reads);
    assert.notEqual(r.decision, "hold-previous");
    assert.equal(r.built, false);
    assert.equal(r.painted, before);
  }
});

test("new text whose reads are idle builds at once", () => {
  const { builds, decisions } = run(BEFORE, [{ ...BEFORE, text: AFTER.text }]);
  assert.deepEqual(decisions, ["build"]);
  assert.equal(builds, 1);
});

test("want-content false paints hunk-only and never holds", () => {
  const { painted: before } = render(null, BEFORE);
  const r = render(before, {
    ...BEFORE,
    text: AFTER.text,
    newFetching: true,
    wantContent: false,
  });
  assert.equal(r.decision, "hunk-only");
  assert.equal(r.built, true);
});

test("a pending read leaves nothing to hold, so the settle after it builds", () => {
  const { painted: before } = render(null, BEFORE);
  const pending = render(before, { ...AFTER, pending: true });
  assert.equal(pending.painted, null);
  const settled = render(pending.painted, AFTER);
  assert.equal(settled.decision, "build");
  assert.equal(settled.built, true);
});

test("the first settled paint builds", () => {
  const first = render(null, BEFORE);
  assert.equal(first.decision, "build");
  assert.equal(first.built, true);
});

test("a frozen paint holds through any change, past the bound too", () => {
  const { painted: before } = render(null, BEFORE);
  for (const reads of [{ ...BEFORE, new: AFTER.new }, AFTER]) {
    const r = render(before, reads, { frozen: true, boundExpired: true });
    assert.equal(r.decision, "hold-previous");
    assert.equal(r.painted, before);
  }
  // Nothing changed: nothing to hold, and nothing rebuilds.
  const same = render(before, BEFORE, { frozen: true });
  assert.equal(same.built, false);
});

test("changesSince: no paint means no change", () => {
  assert.deepEqual(
    changesSince(null, { reads: READS, text: "x", oldText: "", newText: "" }),
    {
      textChanged: false,
      contentChanged: false,
      previousComplete: true,
    },
  );
});

const REFRESHING = {
  ...BEFORE,
  text: AFTER.text,
  oldFetching: true,
  newFetching: true,
};

// Two retired completeness rules, each kept as the negative control of the pin
// it fails: "complete only when built with no read in flight" (a warm first
// paint starts incomplete, so a two-step landing builds twice), and "complete
// unless forced", with no inheritance (the forced paint's own re-render
// completes it, so its late reads hold again).
const inFlightRule = (painted, decision, pending, now, reads) => {
  if (pending) return null;
  if (decision === "hold-previous") return painted;
  const complete = decision === "build" && !reads.inFlight;
  if (sameInputs(painted, now))
    return complete && !painted.complete ? { ...painted, complete } : painted;
  return { ...now, complete };
};
const noInheritRule = (painted, decision, pending, now) => {
  if (pending) return null;
  if (decision === "hold-previous") return painted;
  const complete = decision !== "hunk-only";
  if (sameInputs(painted, now))
    return complete === painted.complete ? painted : { ...painted, complete };
  return { ...now, complete };
};

/** A first paint over warm reads that are refetching, then a changed landing
 *  in two steps, `order` first: the decisions and the build count. */
function warmTwoStep(order, after = paintedAfter) {
  const steps =
    order === "content"
      ? [{ ...BEFORE, new: AFTER.new, oldFetching: true }, AFTER]
      : [{ ...BEFORE, text: AFTER.text, newFetching: true }, AFTER];
  return run({ ...BEFORE, oldFetching: true, newFetching: true }, steps, {
    after,
  });
}

test("a warm first paint holds a two-step landing once and builds once", () => {
  for (const order of ["content", "text"]) {
    const { decisions, builds } = warmTwoStep(order);
    assert.deepEqual(decisions, ["hold-previous", "build"], order);
    assert.equal(builds, 1, order);
  }
});

test("negative control: the in-flight rule builds a warm two-step landing twice", () => {
  for (const order of ["content", "text"]) {
    const { decisions, builds } = warmTwoStep(order, inFlightRule);
    assert.deepEqual(decisions, ["build", "build"], order);
    assert.equal(builds, 2, order);
  }
});

/** A refresh whose reads outlast the bound, with the forced paint's own
 *  re-render before they land: the decisions, and the builds at landing. */
function boundRunsOut({ gate = contentBuildGate, after = paintedAfter } = {}) {
  let { painted } = render(null, BEFORE);
  const decisions = [];
  let buildsAtLanding = 0;
  for (const [reads, opts, landing] of [
    [REFRESHING, {}],
    [REFRESHING, { boundExpired: true }],
    // The forced paint's own re-render, its reads still in flight.
    [REFRESHING, {}],
    // The reads land.
    [AFTER, {}, true],
  ]) {
    const r = render(painted, reads, { ...opts, gate, after });
    painted = r.painted;
    decisions.push(r.decision);
    if (landing && r.built) buildsAtLanding++;
  }
  return { decisions, painted, buildsAtLanding };
}

test("a paint the bound forced is never held over: its late reads build once", () => {
  const { decisions, painted, buildsAtLanding } = boundRunsOut();
  assert.deepEqual(decisions, ["hold-previous", "hunk-only", "build", "build"]);
  assert.equal(buildsAtLanding, 1);
  assert.equal(painted.newText, AFTER.new);
  assert.equal(painted.complete, true);
});

test("negative control: a forced paint its own re-render completes holds again", () => {
  const { decisions, buildsAtLanding } = boundRunsOut({ after: noInheritRule });
  assert.deepEqual(decisions, [
    "hold-previous",
    "hunk-only",
    "build",
    "hold-previous",
  ]);
  assert.equal(buildsAtLanding, 0);
});

test("negative control: a gate that counts a forced paint as complete holds again", () => {
  const { decisions } = boundRunsOut({
    gate: (i) => contentBuildGate({ ...i, previousComplete: true }),
  });
  assert.equal(decisions[3], "hold-previous");
});

test("a forced paint whose reads settle unchanged completes in place", () => {
  let { painted } = render(null, BEFORE);
  for (const [reads, opts] of [
    [REFRESHING, {}],
    [REFRESHING, { boundExpired: true }],
  ])
    painted = render(painted, reads, opts).painted;
  assert.equal(painted.complete, false);
  const settled = render(painted, { ...BEFORE, text: AFTER.text });
  assert.equal(settled.built, false);
  assert.equal(settled.painted.complete, true);
  // Complete again, the next refresh holds once and builds once.
  const next = render(settled.painted, { ...BEFORE, newFetching: true });
  assert.equal(next.decision, "hold-previous");
  assert.equal(render(next.painted, BEFORE).built, true);
});

test("revs changed: another commit's warm diff builds at once, never held", () => {
  // Arrowing back to a cached commit on the same path: its text and reads are
  // all cached, and a refetch of them may still be in flight.
  const { painted: before } = render(null, BEFORE);
  const other = render(before, {
    ...AFTER,
    reads: contentReadsKey("f.ts", "bbbb~1", "bbbb"),
    oldFetching: true,
    newFetching: true,
  });
  assert.equal(other.decision, "build");
  assert.equal(other.built, true);
});

test("another file at the same revs builds at once, never held", () => {
  const { painted: before } = render(null, BEFORE);
  const other = render(before, {
    ...AFTER,
    reads: contentReadsKey("g.ts", "aaaa~1", "aaaa"),
    newFetching: true,
  });
  assert.equal(other.decision, "build");
});

test("contentReadsKey: the working tree, an absent side and a rev never collide", () => {
  const keys = [
    contentReadsKey("f", null, null),
    contentReadsKey("f", undefined, null),
    contentReadsKey("f", null, undefined),
    contentReadsKey("f", ":0", null),
    contentReadsKey("f", "~", null),
    contentReadsKey("f", "-", null),
  ];
  assert.equal(new Set(keys).size, keys.length);
});
