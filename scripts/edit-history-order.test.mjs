// Pins the Edit history order toggle's pure layer: the display mapping in
// src/features/history/edit-history-plan.ts (displayIndex, visualMoveTarget, and
// moveAnnouncement's display-order position), that a reversed display leaves the
// compiled plan untouched, and the editHistoryOrder heal arm in
// src/lib/settings/heal.ts.
//
// The plan module is imported straight from `src/` under Node's type stripping,
// so it must stay free of runtime imports; heal.ts resolves its `@/` imports
// through the src hooks. Neither needs an install, so this suite runs in the
// no-install guards job.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  compilePlan,
  displayIndex,
  moveAnnouncement,
  visualMoveTarget,
} from "../src/features/history/edit-history-plan.ts";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { DEFAULT_SETTINGS, healLoadedSettings } = await import(
  "@/lib/settings/heal"
);

/** A row whose hash doubles as its subject. */
const row = (hash, action = "pick") => ({
  hash,
  subject: hash,
  action,
  message: hash,
});

/** Newest-first rows: the dialog's internal (data) order. */
const dataRows = (total) =>
  Array.from({ length: total }, (_, i) => row(`c${i}`));

/** The rows as an oldest-first display lists them, mapped back through
 *  displayIndex: what the dialog does when it reads a displayed row's data. */
const displayed = (rows, reversed) =>
  rows.map((_, d) => rows[displayIndex(d, rows.length, reversed)]);

test("displayIndex is the identity newest-first and a mirror oldest-first", () => {
  for (const total of [1, 2, 15]) {
    for (let i = 0; i < total; i++) {
      assert.equal(displayIndex(i, total, false), i);
      const d = displayIndex(i, total, true);
      assert.equal(d, total - 1 - i);
      assert.equal(displayIndex(d, total, true), i, "its own inverse");
    }
  }
  assert.equal(displayIndex(0, 15, true), 14);
  assert.equal(displayIndex(14, 15, true), 0);
});

// [index, total, dir, reversed, expected]
const MOVES = [
  // One commit: every visual move refuses, at the end the direction points to.
  [0, 1, "up", false, { at: "newest" }],
  [0, 1, "top", false, { at: "newest" }],
  [0, 1, "down", false, { at: "oldest" }],
  [0, 1, "bottom", false, { at: "oldest" }],
  [0, 1, "up", true, { at: "oldest" }],
  [0, 1, "top", true, { at: "oldest" }],
  [0, 1, "down", true, { at: "newest" }],
  [0, 1, "bottom", true, { at: "newest" }],
  // Newest-first, 15 rows: up/top move toward data index 0.
  [0, 15, "up", false, { at: "newest" }],
  [0, 15, "top", false, { at: "newest" }],
  [0, 15, "down", false, { to: 1 }],
  [0, 15, "bottom", false, { to: 14 }],
  [7, 15, "up", false, { to: 6 }],
  [7, 15, "down", false, { to: 8 }],
  [7, 15, "top", false, { to: 0 }],
  [7, 15, "bottom", false, { to: 14 }],
  [14, 15, "down", false, { at: "oldest" }],
  [14, 15, "bottom", false, { at: "oldest" }],
  [14, 15, "up", false, { to: 13 }],
  [14, 15, "top", false, { to: 0 }],
  // Oldest-first, 15 rows: the displayed top is data index 14 (the oldest).
  [14, 15, "up", true, { at: "oldest" }],
  [14, 15, "top", true, { at: "oldest" }],
  [14, 15, "down", true, { to: 13 }],
  [14, 15, "bottom", true, { to: 0 }],
  [7, 15, "up", true, { to: 8 }],
  [7, 15, "down", true, { to: 6 }],
  [7, 15, "top", true, { to: 14 }],
  [7, 15, "bottom", true, { to: 0 }],
  [0, 15, "down", true, { at: "newest" }],
  [0, 15, "bottom", true, { at: "newest" }],
  [0, 15, "up", true, { to: 1 }],
  [0, 15, "top", true, { to: 14 }],
];

test("visualMoveTarget maps each visual move to a data index or an end", () => {
  for (const [index, total, dir, reversed, expected] of MOVES) {
    assert.deepEqual(
      visualMoveTarget(index, total, dir, reversed),
      expected,
      `${dir} from ${index} of ${total}, reversed=${reversed}`,
    );
  }
});

test("a visual up/down lands one DISPLAYED row away in either order", () => {
  for (const reversed of [false, true]) {
    const total = 15;
    for (let i = 0; i < total; i++) {
      const d = displayIndex(i, total, reversed);
      for (const [dir, step] of [
        ["up", -1],
        ["down", 1],
      ]) {
        const move = visualMoveTarget(i, total, dir, reversed);
        if ("to" in move) {
          assert.equal(displayIndex(move.to, total, reversed), d + step);
        } else {
          assert.equal(d, step < 0 ? 0 : total - 1, "refuses only at an end");
        }
      }
    }
  }
});

test("reading displayed rows back through displayIndex compiles the identical plan", () => {
  const rows = [
    row("n4", "fixup"),
    row("n3", "pick"),
    row("n2", "squash"),
    row("n1", "drop"),
    row("n0", "pick"),
  ];
  const original = rows.map((r) => r.hash);
  const newest = compilePlan(rows, original);

  const shown = displayed(rows, true);
  assert.deepEqual(
    shown.map((r) => r.hash),
    ["n0", "n1", "n2", "n3", "n4"],
    "oldest-first display",
  );
  // The dialog keeps data order newest-first; mapping each displayed row back
  // through displayIndex recovers exactly that input.
  const back = shown.map((_, i) => shown[displayIndex(i, rows.length, true)]);
  const oldest = compilePlan(back, original);
  assert.deepEqual(oldest, newest);

  // A squash's fold target is the displayed row directly ABOVE it, as in git's
  // oldest-first todo (skipping the dropped row between them).
  const squashData = rows.findIndex((r) => r.hash === "n2");
  assert.equal(oldest.views[squashData].foldTarget, "n0");
  const fixupData = rows.findIndex((r) => r.hash === "n4");
  const fixupShown = displayIndex(fixupData, rows.length, true);
  assert.equal(
    oldest.views[fixupData].foldTarget,
    shown[fixupShown - 1].subject,
  );
});

test("a two-commit squash folds into the row above oldest-first, below newest-first", () => {
  const rows = [row("new", "squash"), row("old")];
  const plan = compilePlan(
    rows,
    rows.map((r) => r.hash),
  );
  assert.equal(plan.views[0].foldTarget, "old");
  assert.equal(displayed(rows, false)[1].hash, "old", "below newest-first");
  assert.equal(displayed(rows, true)[0].hash, "old", "above oldest-first");
});

test("moveAnnouncement counts the display position oldest-first", () => {
  const total = 15;
  const before = dataRows(total);
  // Oldest-first: the displayed top is data 14; one visual step down is data 13.
  const move = visualMoveTarget(14, total, "down", true);
  assert.deepEqual(move, { to: 13 });
  const after = [...before];
  const [moved] = after.splice(14, 1);
  after.splice(13, 0, moved);
  const hashes = before.map((r) => r.hash);
  const prev = compilePlan(before, hashes);
  const next = compilePlan(after, hashes);
  const args = {
    prev,
    next,
    action: "pick",
    hash: moved.hash,
    from: 14,
    to: 13,
    total,
  };
  assert.equal(
    moveAnnouncement({ ...args, reversed: true }),
    "Moved to 2 of 15",
  );
  assert.equal(
    moveAnnouncement(args),
    "Moved to 14 of 15",
    "default unchanged",
  );
  assert.equal(
    moveAnnouncement({ ...args, reversed: false }),
    "Moved to 14 of 15",
  );

  const toTop = { ...args, from: 0, to: 0, prev: next, next };
  assert.equal(
    moveAnnouncement({ ...toTop, reversed: true }),
    "Moved to 15 of 15",
  );
  assert.equal(moveAnnouncement({ ...toTop, to: 14 }), "Moved to 15 of 15");
});

test("moveAnnouncement speaks the caller's held label and error text", () => {
  // Newest-first [squash, leader]: the squash moving below its leader holds.
  const before = [row("s", "squash"), row("l")];
  const after = [row("l"), row("s", "squash")];
  const hashes = before.map((r) => r.hash);
  const prev = compilePlan(before, hashes);
  const next = compilePlan(after, hashes);
  const held = { prev, next, action: "squash", hash: "s", from: 0, to: 1 };
  assert.equal(
    moveAnnouncement({ ...held, total: 2 }),
    "Moved to 2 of 2, no older kept commit to combine into",
    "default unchanged",
  );
  assert.equal(
    moveAnnouncement({
      ...held,
      total: 2,
      reversed: true,
      heldLabel: "no older kept commit above to combine into",
    }),
    "Moved to 1 of 2, no older kept commit above to combine into",
  );

  // The leader moving instead: another row's new error is appended.
  const leaderMove = { prev, next, action: "pick", hash: "l", from: 1, to: 0 };
  assert.equal(
    moveAnnouncement({ ...leaderMove, total: 2 }),
    `Moved to 1 of 2. ${next.error}`,
    "default unchanged",
  );
  assert.equal(
    moveAnnouncement({ ...leaderMove, total: 2, errorText: "Spoken error." }),
    "Moved to 1 of 2. Spoken error.",
  );
  assert.equal(
    moveAnnouncement({ ...leaderMove, total: 2, errorText: null }),
    `Moved to 1 of 2. ${next.error}`,
    "null falls back to the plan's error",
  );
});

test("editHistoryOrder heals to newest-first and keeps oldest-first", () => {
  assert.equal(DEFAULT_SETTINGS.editHistoryOrder, "newest-first");
  const full = healLoadedSettings(undefined);
  assert.equal(full.editHistoryOrder, "newest-first", "no store");

  const { editHistoryOrder: _, ...absent } = full;
  assert.equal(healLoadedSettings(absent).editHistoryOrder, "newest-first");

  for (const junk of ["oldest", "OLDEST-FIRST", 1, null, true, {}]) {
    assert.equal(
      healLoadedSettings({ ...full, editHistoryOrder: junk }).editHistoryOrder,
      "newest-first",
      `junk ${JSON.stringify(junk)}`,
    );
  }

  const saved = { ...full, editHistoryOrder: "oldest-first" };
  const once = healLoadedSettings(saved);
  assert.equal(once.editHistoryOrder, "oldest-first");
  const reread = healLoadedSettings(JSON.parse(JSON.stringify(saved)));
  assert.equal(reread.editHistoryOrder, "oldest-first", "survives a reload");
  assert.equal(healLoadedSettings(once).editHistoryOrder, "oldest-first");
});
