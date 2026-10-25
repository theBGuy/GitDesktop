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

/** One render of a build site: what the gate decides over these reads, and
 *  whether the render builds (records new inputs) or keeps the paint. */
function render(painted, reads, { boundExpired = false, frozen = false } = {}) {
  const now = {
    reads: reads.reads ?? READS,
    text: reads.text,
    oldText: reads.old,
    newText: reads.new,
  };
  const pending = reads.wantContent !== false && reads.pending === true;
  const decision = contentBuildGate({
    wantContent: reads.wantContent !== false,
    oldSettled: !pending,
    newSettled: !pending,
    oldFetching: reads.oldFetching === true,
    newFetching: reads.newFetching === true,
    ...changesSince(painted, now),
    boundExpired,
    frozen,
  });
  const next = paintedAfter(painted, decision, pending, now);
  return { decision, painted: next, built: next !== null && next !== painted };
}

/** Runs a sequence of read states from a settled paint, counting builds. */
function run(start, steps) {
  let { painted } = render(null, start);
  let builds = 0;
  const decisions = [];
  for (const reads of steps) {
    const r = render(painted, reads);
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
    },
  );
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
