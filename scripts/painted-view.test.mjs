// Pins painted-view.ts: where each comment goes (inline in the pane or
// listed) and the note a listed one carries, from what the pane reports it
// has mounted; the whitespace note's confirmation; the anchor rows'
// ref-counted registry, and the host relay of the visible slot's report.
// Imports src/ under Node's type stripping, so the module keeps relative
// runtime imports with their .ts suffix.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anchorKey,
  confirmWhitespace,
  createAnchorRegistry,
  createPaintedRelay,
  placeComments,
  shownRead,
} from "../src/features/diff/painted-view.ts";

/** A small deterministic PRNG (mulberry32), so a failure replays by seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A one-hunk patch whose new side holds `newLines` (added lines) and whose
 *  old side holds `oldLines` (removed lines), each run contiguous. */
function patchWith(oldLines, newLines) {
  const hunks = [];
  for (const n of [...newLines].sort((x, y) => x - y))
    hunks.push(`@@ -0,0 +${n},1 @@\n+n${n}\n`);
  for (const n of [...oldLines].sort((x, y) => x - y))
    hunks.push(`@@ -${n},1 +0,0 @@\n-o${n}\n`);
  return `diff --git a/f b/f\n--- a/f\n+++ b/f\n${hunks.join("")}`;
}

/** Longer than DIFF_MEGA_LINE_CHARS (20,000): the mega-line placeholder's. */
const MEGA = "m".repeat(20_001);

/** A new file of `count` added lines; line 1 is a mega line when `mega`. */
function addedFile(count, mega = false) {
  const body = Array.from(
    { length: count },
    (_, i) => `+${mega && i === 0 ? MEGA : `l${i + 1}`}\n`,
  ).join("");
  return `diff --git a/f b/f\n--- /dev/null\n+++ b/f\n@@ -0,0 +1,${count} @@\n${body}`;
}

const report = (patch, cut, extra = {}) => ({
  path: "f",
  patch,
  whitespaceHidden: false,
  truncated: false,
  cut,
  anchors: [],
  ...extra,
});

const CUTS = [null, "cap", "mega-line", "preview", "pending"];
const STEP_ORDER = ["raw", "show-diff-anyway", "show-full-diff"];
const PATCHES = [
  () => null,
  () => addedFile(300),
  () => addedFile(3, true),
  () => addedFile(300, true),
];

function randomCase(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const count = Math.floor(r() * 12);
  const long = r() < 0.4;
  const comments = Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    side: r() < 0.25 ? "old" : "new",
    // A narrow line range, so several comments share a line; past the cap
    // when the patch is long; an unresolved position now and then.
    line:
      r() < 0.1
        ? null
        : long && r() < 0.5
          ? 240 + Math.floor(r() * 6)
          : 1 + Math.floor(r() * 6),
  }));
  const keys = [
    ...new Set(
      comments
        .filter((c) => c.line !== null)
        .map((c) => anchorKey(c.side, c.line)),
    ),
  ];
  // Mounted rows: any subset of the comments' keys (a pinned one's included,
  // as when a report lags the pane), plus a stray key no comment has.
  const anchors = keys.filter(() => r() < 0.5);
  if (r() < 0.3) anchors.push("new:99");
  const big = pick(PATCHES)();
  const rep =
    r() < 0.15
      ? null
      : {
          path: "f",
          patch:
            big ??
            patchWith(
              [1, 2, 3, 4, 5, 6].filter(() => r() < 0.5),
              [1, 2, 3, 4, 5, 6].filter(() => r() < 0.5),
            ),
          whitespaceHidden: r() < 0.5,
          truncated: r() < 0.2,
          cut: pick(CUTS),
          anchors: anchors.sort(),
        };
  const pinned = new Set(comments.filter(() => r() < 0.25).map((c) => c.id));
  if (r() < 0.3) pinned.add("not-resolved");
  return { comments, report: rep, pinned, patchReady: r() < 0.7 };
}

test("placeComments: each comment placed exactly once, a pinned or unresolved one always listed, and every step list ordered with no repeat", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const { comments, report: rep, pinned, patchReady } = randomCase(seed);
    const { listed } = placeComments(comments, rep, pinned, patchReady);
    const mounted = new Set(rep?.anchors ?? []);
    const listedIds = listed.map((l) => l.comment.id);
    assert.equal(new Set(listedIds).size, listedIds.length, `seed ${seed}`);
    for (const c of comments) {
      const inline =
        c.line !== null &&
        !pinned.has(c.id) &&
        mounted.has(anchorKey(c.side, c.line))
          ? 1
          : 0;
      const inList = listedIds.includes(c.id) ? 1 : 0;
      assert.equal(inline + inList, 1, `seed ${seed}: ${c.id} placed once`);
      if (pinned.has(c.id) || c.line === null)
        assert.equal(inList, 1, `seed ${seed}: ${c.id} is listed`);
    }
    for (const { reason } of listed) {
      if (rep === null || rep.cut === "pending")
        assert.equal(reason, null, `seed ${seed}: an unjudged report`);
      if (!Array.isArray(reason)) continue;
      assert.ok(reason.length > 0, `seed ${seed}: an empty step list`);
      const at = reason.map((s) => STEP_ORDER.indexOf(s));
      assert.ok(
        at.every((i, k) => i >= 0 && (k === 0 || at[k - 1] < i)),
        `seed ${seed}: steps ${reason} out of order or repeated`,
      );
    }
  }
});

test("placeComments: an unresolved position is unplaced only under a judged report once the patch is ready", () => {
  const unresolved = { id: "u", side: "new", line: null };
  const patch = addedFile(300, true);
  const reports = [
    ["no report", null],
    ["pending", report(patch, "pending")],
    ["no cut", report(patch, null)],
    ["cap", report(patch, "cap")],
    ["mega-line", report(patch, "mega-line")],
    ["preview", report(patch, "preview")],
  ];
  for (const [name, rep] of reports)
    for (const ready of [true, false]) {
      const judged = rep !== null && rep.cut !== "pending";
      const [only] = placeComments([unresolved], rep, new Set(), ready).listed;
      assert.equal(
        only.reason,
        judged && ready ? "unplaced" : null,
        `${name}, patch ready ${ready}`,
      );
    }
});

test("placeComments: a held line's note lists the controls it takes, in order", () => {
  const early = { id: "e", side: "new", line: 1 };
  const late = { id: "l", side: "new", line: 250 };
  const notes = (patch, cut) =>
    placeComments(
      [early, late],
      report(patch, cut),
      new Set(),
      true,
    ).listed.map((l) => l.reason);
  const long = addedFile(300);
  const longMega = addedFile(300, true);
  // Preview over a mega line: Raw shows the placeholder, then its capped rows.
  assert.deepEqual(notes(longMega, "preview"), [
    ["raw", "show-diff-anyway"],
    ["raw", "show-diff-anyway", "show-full-diff"],
  ]);
  assert.deepEqual(notes(long, "preview"), [
    ["raw"],
    ["raw", "show-full-diff"],
  ]);
  assert.deepEqual(notes(longMega, "mega-line"), [
    ["show-diff-anyway"],
    ["show-diff-anyway", "show-full-diff"],
  ]);
  // Show diff anyway lifted the placeholder: the cap alone remains, and a
  // shown line whose row hasn't mounted yet is catching up.
  assert.deepEqual(notes(longMega, "cap"), [null, ["show-full-diff"]]);
  assert.deepEqual(notes(long, "cap"), [null, ["show-full-diff"]]);
  // A patch under the cap: the next rows draw all of it.
  const shortMega = addedFile(3, true);
  const [megaOnly] = placeComments(
    [early],
    report(shortMega, "preview"),
    new Set(),
    true,
  ).listed;
  assert.deepEqual(megaOnly.reason, ["raw", "show-diff-anyway"]);
  const [plainOnly] = placeComments(
    [early],
    report(patchWith([], [1]), "preview"),
    new Set(),
    true,
  ).listed;
  assert.deepEqual(plainOnly.reason, ["raw"]);
  assert.deepEqual(
    placeComments([early], report(patchWith([], [1]), "cap"), new Set(), true)
      .listed[0].reason,
    null,
  );
});

test("placeComments: no report mounts nothing, so every comment is listed with no note", () => {
  const comments = [
    { id: "a", side: "new", line: 1 },
    { id: "b", side: "old", line: 2 },
    { id: "u", side: "new", line: null },
  ];
  const { listed } = placeComments(comments, null, new Set(), true);
  assert.deepEqual(
    listed.map((l) => [l.comment.id, l.reason]),
    [
      ["a", null],
      ["b", null],
      ["u", null],
    ],
  );
});

test("placeComments: under no cut, a line the patch holds has no note, and one it lacks is unplaced or whitespace", () => {
  const patch = patchWith([2], [1]);
  const onPatch = { id: "p", side: "new", line: 1 };
  const onOld = { id: "o", side: "old", line: 2 };
  const offPatch = { id: "x", side: "new", line: 7 };
  const notes = (extra) =>
    placeComments(
      [onPatch, onOld, offPatch],
      report(patch, null, extra),
      new Set(),
      true,
    ).listed.map((l) => l.reason);
  assert.deepEqual(notes({ whitespaceHidden: true }), [
    null,
    null,
    "whitespace",
  ]);
  assert.deepEqual(notes({ whitespaceHidden: false }), [
    null,
    null,
    "unplaced",
  ]);
  // A cut -w read can't blame -w for a line it lacks: it may be past the cut.
  assert.deepEqual(notes({ whitespaceHidden: true, truncated: true }), [
    null,
    null,
    "unplaced",
  ]);
  assert.deepEqual(notes({ whitespaceHidden: false, truncated: true }), [
    null,
    null,
    "unplaced",
  ]);
  // A mounted, unpinned comment is inline; pinned, it stays listed.
  const mounted = report(patch, null, { anchors: ["new:1"] });
  assert.deepEqual(
    placeComments([onPatch], mounted, new Set(), true).listed,
    [],
  );
  assert.deepEqual(
    placeComments([onPatch], mounted, new Set(["p"]), true).listed.map(
      (l) => l.comment.id,
    ),
    ["p"],
  );
});

test("placeComments: a pinned row on a line the patch holds takes no note under any cut; off the patch it keeps its own", () => {
  const patch = addedFile(300, true);
  const onPatch = { id: "p", side: "new", line: 250 };
  const offPatch = { id: "x", side: "new", line: 400 };
  const pinned = new Set(["p", "x"]);
  for (const cut of CUTS)
    for (const whitespaceHidden of [false, true]) {
      const notes = placeComments(
        [onPatch, offPatch],
        report(patch, cut, { whitespaceHidden, anchors: ["new:250"] }),
        pinned,
        true,
      ).listed.map((l) => l.reason);
      const off = whitespaceHidden ? "whitespace" : "unplaced";
      assert.deepEqual(
        notes,
        [null, cut === "pending" ? null : off],
        `${cut}, -w ${whitespaceHidden}`,
      );
    }
});

test("confirmWhitespace: a whitespace candidate follows the whitespace-shown read", () => {
  const read = (text, extra = {}) => ({
    text,
    isBinary: false,
    isTruncated: false,
    ...extra,
  });
  const has = read(patchWith([], [1, 5]));
  const at = (line, r) => confirmWhitespace("whitespace", line, r);
  assert.equal(at(5, shownRead(undefined, false)), null, "unread");
  assert.equal(at(5, shownRead(has, false)), "whitespace", "has the line");
  assert.equal(at(6, shownRead(has, false)), "unplaced", "lacks the line");
  assert.equal(at(5, shownRead(undefined, true)), "unplaced", "failed");
  assert.equal(
    at(5, shownRead(has, true)),
    "whitespace",
    "data beats a failure",
  );
  assert.equal(
    at(5, shownRead(read(has.text, { isBinary: true }), false)),
    "unplaced",
    "binary",
  );
  // A truncated read drops its last line, which the cut may have split.
  const cut = shownRead(read(has.text, { isTruncated: true }), false);
  assert.equal(at(5, cut), "unplaced", "truncated last line");
  assert.equal(at(1, cut), "whitespace", "truncated, an earlier line");
  // Any other note passes untouched.
  const lacks = shownRead(read(patchWith([], [1])), false);
  for (const other of ["unplaced", ["raw"], null])
    assert.deepEqual(confirmWhitespace(other, 9, lacks), other);
});

test("anchor registry: a key stays mounted until its last row leaves, and only set changes notify", () => {
  const registry = createAnchorRegistry();
  let notified = 0;
  const off = registry.subscribe(() => notified++);
  const empty = registry.snapshot();
  const first = registry.add("new:5");
  const twice = registry.add("new:5");
  assert.equal(notified, 1);
  const one = registry.snapshot();
  assert.deepEqual(one, ["new:5"]);
  const other = registry.add("old:3");
  assert.deepEqual(registry.snapshot(), ["new:5", "old:3"]);
  first();
  first();
  assert.deepEqual(registry.snapshot(), ["new:5", "old:3"]);
  assert.equal(notified, 2);
  twice();
  other();
  assert.deepEqual(registry.snapshot(), []);
  assert.equal(notified, 4);
  assert.notEqual(registry.snapshot(), empty);
  const stable = registry.snapshot();
  assert.equal(registry.snapshot(), stable, "same array until a change");
  off();
  registry.add("new:1");
  assert.equal(notified, 4, "an unsubscribed listener hears nothing");
});

test("painted relay: the newest visible owner's view stands, and an equal view never notifies", () => {
  const relay = createPaintedRelay();
  let notified = 0;
  relay.subscribe(() => notified++);
  const view = (path, anchors) => ({
    path,
    patch: "",
    whitespaceHidden: false,
    truncated: false,
    cut: null,
    anchors,
  });
  const held = {};
  const promoted = {};
  relay.set(held, view("f", ["new:1"]));
  relay.set(held, view("f", ["new:1"]));
  assert.equal(notified, 1);
  relay.set(promoted, view("f", []));
  assert.deepEqual(relay.view()?.anchors, []);
  relay.clear(held);
  assert.deepEqual(relay.view()?.anchors, [], "a stale owner clears nothing");
  relay.set(promoted, view("g", []));
  assert.equal(
    relay.view()?.path,
    "g",
    "every report field is part of the value",
  );
  relay.clear(promoted);
  assert.equal(relay.view(), null);
  assert.equal(notified, 4);
});
