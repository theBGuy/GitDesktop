// Pins Edit history's plan compiler (src/features/history/edit-history-plan.ts):
// every row records the commit a squash or fixup there would combine into, drop
// rows are listed for the backend's coverage check, folds attach to the nearest
// older kept leader in chronological order, and a fold with nothing to combine
// into blocks the plan with its footer sentence verbatim.
//
// Not testable here: the dialog's rendering of these values (menu hints, row
// labels, the live region). Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beforeParentSteps,
  compilePlan,
  moveAnnouncement,
} from "../src/features/history/edit-history-plan.ts";

/** A row whose hash doubles as its subject; message defaults to the subject. */
const row = (hash, action, message = hash) => ({
  hash,
  subject: hash,
  action,
  message,
});

/** A row titled "wip": two of them are leaders that share a subject. */
const wip = (hash, action) => ({ hash, subject: "wip", action, message: "" });

/** Compiles newest-first rows against their own order as the original. */
const compile = (rows) =>
  compilePlan(
    rows,
    rows.map((r) => r.hash),
  );

test("a squash on the oldest row is held with the squash sentence", () => {
  const plan = compile([row("a", "pick"), row("b", "squash")]);
  assert.equal(
    plan.error,
    '"b" can\'t be squashed — no older commit in this list is kept to combine it into.',
  );
  assert.equal(plan.views[1].foldTarget, null);
  assert.deepEqual(plan.steps, [{ hashes: ["a"] }]);
});

test("a fixup on the oldest row is held with the fixup sentence", () => {
  const plan = compile([row("a", "pick"), row("b", "fixup")]);
  assert.equal(
    plan.error,
    '"b" can\'t be fixed up — no older commit in this list is kept to combine it into.',
  );
  assert.equal(plan.views[1].foldTarget, null);
});

test("a dropped row is skipped when finding the fold target", () => {
  const nothingKept = compile([
    row("p", "pick"),
    row("s", "squash"),
    row("d", "drop"),
  ]);
  assert.equal(nothingKept.views[1].foldTarget, null);
  assert.equal(
    nothingKept.error,
    '"s" can\'t be squashed — no older commit in this list is kept to combine it into.',
  );
  assert.deepEqual(nothingKept.dropped, ["d"]);

  const keptBelow = compile([
    row("p", "pick"),
    row("s", "squash"),
    row("d", "drop"),
    row("q", "pick"),
  ]);
  assert.equal(keptBelow.error, null);
  assert.equal(keptBelow.views[1].foldTarget, "q");
  assert.deepEqual(keptBelow.dropped, ["d"]);
  assert.deepEqual(
    keptBelow.steps.map((s) => s.hashes),
    [["q", "s"], ["p"]],
  );
});

test("folds stacked on one leader share its target, chronologically", () => {
  const plan = compile([
    row("s", "squash"),
    row("f", "fixup"),
    row("l", "pick"),
  ]);
  assert.equal(plan.error, null);
  assert.equal(plan.views[0].foldTarget, "l");
  assert.equal(plan.views[1].foldTarget, "l");
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(plan.steps[0].hashes, ["l", "f", "s"]);
});

test("a reword leader is the target and bakes its own message", () => {
  const plan = compile([row("f", "fixup"), row("r", "reword", "new message")]);
  assert.equal(plan.error, null);
  assert.equal(plan.views[0].foldTarget, "r");
  assert.deepEqual(plan.steps, [
    { hashes: ["r", "f"], message: "new message" },
  ]);
});

test("several folds join the leader and squash parts, never fixup parts", () => {
  const plan = compile([
    row("s2", "squash", "second squash"),
    row("f", "fixup", "fixup body"),
    row("s1", "squash", "  first squash  "),
    row("l", "pick", "leader"),
  ]);
  assert.equal(plan.error, null);
  assert.deepEqual(plan.steps, [
    {
      hashes: ["l", "s1", "f", "s2"],
      message: "leader\n\nfirst squash\n\nsecond squash",
    },
  ]);
  // The pick leader receiving a squash exposes its message for editing.
  assert.equal(plan.views[3].showMessage, true);
});

test("every row records a fold target, drops and leaders included", () => {
  const rows = [
    row("e", "edit"),
    row("s", "squash"),
    row("d", "drop"),
    row("p", "pick"),
    row("r", "reword", "reworded"),
  ];
  const plan = compile(rows);
  assert.equal(plan.views.length, rows.length);
  for (const view of plan.views) {
    assert.ok(Object.hasOwn(view, "foldTarget"));
    assert.notEqual(view.foldTarget, undefined);
  }
  // A leader's own target is the next kept leader older than it.
  assert.deepEqual(
    plan.views.map((v) => v.foldTarget),
    ["p", "p", "p", "r", null],
  );
});

test("result count, changed and hasEdit survive the walk", () => {
  const mixed = compile([
    row("e", "edit"),
    row("s", "squash"),
    row("d", "drop"),
    row("p", "pick"),
    row("r", "reword", "reworded"),
  ]);
  assert.equal(mixed.error, null);
  assert.equal(mixed.resultCount, 3);
  assert.equal(mixed.changed, true);
  assert.equal(mixed.hasEdit, true);
  assert.deepEqual(mixed.dropped, ["d"]);

  const untouched = compile([row("a", "pick"), row("b", "pick")]);
  assert.equal(untouched.resultCount, 2);
  assert.equal(untouched.changed, false);
  assert.equal(untouched.hasEdit, false);
  assert.deepEqual(untouched.dropped, []);

  const reordered = compilePlan(
    [row("b", "pick"), row("a", "pick")],
    ["a", "b"],
  );
  assert.equal(reordered.changed, true);
  assert.equal(reordered.resultCount, 2);
});

test("errorHash names the row the error is about", () => {
  // Two held folds: the walk meets the oldest first, and that one is reported.
  const held = compile([
    row("a", "pick"),
    row("s", "squash"),
    row("f", "fixup"),
  ]);
  assert.equal(
    held.error,
    '"f" can\'t be fixed up — no older commit in this list is kept to combine it into.',
  );
  assert.equal(held.errorHash, "f");

  const blank = compile([row("r", "reword", "  "), row("p", "pick")]);
  assert.equal(blank.error, 'Rewording "r" needs a commit message.');
  assert.equal(blank.errorHash, "r");

  const allDropped = compile([row("a", "drop")]);
  assert.notEqual(allDropped.error, null);
  assert.equal(allDropped.errorHash, null);

  assert.equal(compile([row("a", "pick")]).errorHash, null);
});

test("the fold target carries its leader's hash beside the subject", () => {
  const before = compile([
    row("s", "squash"),
    wip("w1", "pick"),
    wip("w2", "pick"),
  ]);
  const after = compile([
    wip("w1", "pick"),
    row("s", "squash"),
    wip("w2", "pick"),
  ]);
  // Same subject either side of the move, different commit to combine into.
  assert.equal(before.views[0].foldTarget, "wip");
  assert.equal(after.views[1].foldTarget, "wip");
  assert.equal(before.views[0].foldTargetHash, "w1");
  assert.equal(after.views[1].foldTargetHash, "w2");
  assert.equal(after.views[2].foldTargetHash, null);
});

test("dropped lists exactly the drop rows, oldest first", () => {
  const plan = compile([
    row("d1", "drop"),
    row("p", "pick"),
    row("d2", "drop"),
    row("q", "pick"),
  ]);
  assert.deepEqual(plan.dropped, ["d2", "d1"]);
});

test("a mixed plan lists every original commit exactly once", () => {
  const rows = [
    row("e", "edit"),
    row("s", "squash", "squash part"),
    row("d1", "drop"),
    row("r", "reword", "reworded"),
    row("f", "fixup"),
    row("d2", "drop"),
    row("p", "pick"),
  ];
  const plan = compile(rows);
  assert.equal(plan.error, null);
  const listed = [...plan.steps.flatMap((s) => s.hashes), ...plan.dropped];
  // The backend's coverage contract, seen from the UI: steps plus dropped are
  // the whole range, each hash once, so a valid plan is never refused.
  assert.equal(listed.length, rows.length);
  assert.deepEqual([...listed].sort(), rows.map((r) => r.hash).sort());
});

/** Announces moving the row at `from` to `to` in newest-first `rows`. */
const announceMove = (rows, from, to) => {
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const original = rows.map((r) => r.hash);
  return moveAnnouncement({
    prev: compilePlan(rows, original),
    next: compilePlan(next, original),
    action: moved.action,
    hash: moved.hash,
    from,
    to,
    total: rows.length,
  });
};

test("a plain move names only its landing", () => {
  assert.equal(
    announceMove([row("a", "pick"), row("b", "pick")], 0, 1),
    "Moved to 2 of 2",
  );
});

test("a fold that retargets names its new target", () => {
  assert.equal(
    announceMove(
      [row("s", "squash"), row("x", "pick"), row("y", "pick")],
      0,
      1,
    ),
    'Moved to 2 of 3, into "y"',
  );
});

test("a fold that loses its target says so once, without its own error", () => {
  assert.equal(
    announceMove([row("s", "squash"), row("y", "pick")], 0, 1),
    "Moved to 2 of 2, no older kept commit to combine into",
  );
});

test("a move that holds ANOTHER row's fold appends that error", () => {
  assert.equal(
    announceMove([row("s", "squash"), row("l", "pick")], 1, 0),
    'Moved to 1 of 2. "s" can\'t be squashed — no older commit in this list is kept to combine it into.',
  );
});

test("a moved reword whose blank message becomes the error appends it", () => {
  assert.equal(
    announceMove([row("r", "reword", ""), row("s", "squash")], 0, 1),
    'Moved to 2 of 2. Rewording "r" needs a commit message.',
  );
});

test("a held fold that stays held but becomes the error appends it", () => {
  assert.equal(
    announceMove([row("f", "fixup"), row("s", "squash")], 0, 1),
    'Moved to 2 of 2. "f" can\'t be fixed up — no older commit in this list is kept to combine it into.',
  );
});

test("an unchanged error is not repeated", () => {
  assert.equal(
    announceMove(
      [row("a", "pick"), row("b", "pick"), row("s", "squash")],
      0,
      1,
    ),
    "Moved to 2 of 3",
  );
});

test("a fold that retargets to a same-subject leader still names it", () => {
  // By hash: under a subject comparison the move reads as no retarget at all.
  assert.equal(
    announceMove(
      [row("s", "squash"), wip("w1", "pick"), wip("w2", "pick")],
      0,
      1,
    ),
    'Moved to 2 of 3, into "wip"',
  );
});

test("zero rows compile to no error and no change, never a drop-all", () => {
  const plan = compilePlan([], []);
  assert.equal(plan.error, null);
  assert.equal(plan.changed, false);
  assert.equal(plan.resultCount, 0);
});

test("every row dropped is held with the drop-all sentence", () => {
  const plan = compile([row("a", "drop")]);
  assert.equal(
    plan.error,
    "Keep at least one commit — you can't drop them all.",
  );
});

const at = (epochSeconds, offsetMinutes = 0) => ({
  epochSeconds,
  offsetMinutes,
});
/** A row carrying new dates. */
const dated = (hash, action, dates) => ({ ...row(hash, action), dates });

test("a dates-only row changes the plan and rides its own step", () => {
  const plan = compile([
    row("b", "pick"),
    dated("a", "pick", { authorDate: at(5), committerDate: at(6, 60) }),
  ]);
  assert.equal(plan.error, null);
  assert.equal(plan.changed, true);
  assert.equal(plan.datedCount, 1);
  // Rows without a change carry neither key.
  assert.deepEqual(plan.steps, [
    { hashes: ["a"], authorDate: at(5), committerDate: at(6, 60) },
    { hashes: ["b"] },
  ]);

  const committerOnly = compile([dated("a", "pick", { committerDate: at(7) })]);
  assert.deepEqual(committerOnly.steps, [
    { hashes: ["a"], committerDate: at(7) },
  ]);
  assert.equal(committerOnly.datedCount, 1);

  const none = compile([row("a", "pick"), row("b", "pick")]);
  assert.equal(none.changed, false);
  assert.equal(none.datedCount, 0);
});

test("fold-member and dropped-row dates are ignored; a leader's ride its step", () => {
  const plan = compile([
    dated("s", "fixup", { authorDate: at(1) }),
    dated("p", "pick", { authorDate: at(2) }),
    dated("d", "drop", { authorDate: at(3) }),
    row("q", "pick"),
  ]);
  assert.equal(plan.error, null);
  assert.deepEqual(plan.steps, [
    { hashes: ["q"] },
    { hashes: ["p", "s"], authorDate: at(2) },
  ]);
  assert.equal(plan.datedCount, 1);

  // Only a member or a dropped row is dated: no step carries a date.
  const ignored = compile([
    dated("s", "squash", { authorDate: at(1) }),
    row("p", "pick", "p"),
    dated("d", "drop", { authorDate: at(3) }),
  ]);
  assert.equal(ignored.datedCount, 0);
  assert.equal(
    ignored.steps.some((s) => "authorDate" in s || "committerDate" in s),
    false,
  );
});

// Original author dates: a oldest, then b, then c.
const ORIGINAL = { a: at(100), b: at(200), c: at(300) };
const BASE = { hash: "base", author: at(50) };
const flagged = (steps, base = BASE) =>
  beforeParentSteps({ steps, originalAuthor: ORIGINAL, base });

test("a child dated before its planned parent is flagged", () => {
  assert.deepEqual(
    flagged([{ hashes: ["a"] }, { hashes: ["b"] }, { hashes: ["c"], authorDate: at(150) }]),
    [{ hash: "c", parentHash: "b", parentDate: at(200) }],
  );
});

test("equal dates are in order", () => {
  assert.deepEqual(
    flagged([{ hashes: ["a"] }, { hashes: ["b"] }, { hashes: ["c"], authorDate: at(200) }]),
    [],
  );
});

test("the parent comes from the plan, not the original order", () => {
  // b moved below a: c's planned parent is a (250), not b.
  assert.deepEqual(
    flagged([
      { hashes: ["b"] },
      { hashes: ["a"], authorDate: at(250) },
      { hashes: ["c"], authorDate: at(150) },
    ]),
    [{ hash: "c", parentHash: "a", parentDate: at(250) }],
  );
});

test("a drop takes its commit out of the parent chain", () => {
  assert.deepEqual(
    flagged([{ hashes: ["a"] }, { hashes: ["c"], authorDate: at(150) }]),
    [],
  );
  assert.deepEqual(
    flagged([{ hashes: ["a"] }, { hashes: ["c"], authorDate: at(50) }]),
    [{ hash: "c", parentHash: "a", parentDate: at(100) }],
  );
});

test("a fold group is judged by its leader's date", () => {
  assert.deepEqual(
    flagged([{ hashes: ["a", "b"] }, { hashes: ["c"], authorDate: at(150) }]),
    [],
  );
  assert.deepEqual(
    flagged([{ hashes: ["a", "b"] }, { hashes: ["c"], authorDate: at(50) }]),
    [{ hash: "c", parentHash: "a", parentDate: at(100) }],
  );
});

test("the oldest step is judged against the base, or not at all without one", () => {
  const steps = [{ hashes: ["a"], authorDate: at(40) }, { hashes: ["b"] }];
  assert.deepEqual(flagged(steps), [
    { hash: "a", parentHash: "base", parentDate: at(50) },
  ]);
  assert.deepEqual(flagged(steps, null), []);
});

test("an inversion no date edit takes part in is not flagged", () => {
  // Reorder only: a (100) now sits above b (200).
  assert.deepEqual(flagged([{ hashes: ["b"] }, { hashes: ["a"] }, { hashes: ["c"] }]), []);
  // An untouched oldest row older than a newer base.
  assert.deepEqual(
    flagged([{ hashes: ["a"] }], { hash: "base", author: at(500) }),
    [],
  );
});

test("a parent's edit flags its untouched child", () => {
  assert.deepEqual(
    flagged([{ hashes: ["a"] }, { hashes: ["b"], authorDate: at(350) }, { hashes: ["c"] }]),
    [{ hash: "c", parentHash: "b", parentDate: at(350) }],
  );
});

test("a step with no original author date is not judged", () => {
  assert.deepEqual(
    beforeParentSteps({
      steps: [{ hashes: ["a"] }, { hashes: ["x"], authorDate: at(10) }],
      originalAuthor: ORIGINAL,
      base: BASE,
    }),
    [],
  );
});
