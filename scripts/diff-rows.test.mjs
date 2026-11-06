// Pins the line anchor a split/unified switch restores
// (src/features/diff/diff-rows.ts): which row anchors a reading position,
// where the restore puts it back, and the reducer that decides whether an
// armed restore fires, waits or disarms. The DOM wrappers run over minimal
// fakes; installless, so no DOM library.
//
// Not testable here: real row geometry, the library's row mounts, and the
// scroll the restore writes. Those need the live app.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  anchorFromRows,
  anchorRow,
  anchorSides,
  captureLineAnchor,
  fallbackLine,
  firstRowBelow,
  RESTORE_BOUND_MS,
  restoreDecision,
  restoreTop,
} from "../src/features/diff/diff-rows.ts";

test("diff rows: firstRowBelow bisects to the first bottom past scrollTop", () => {
  const bottoms = [20, 40, 60, 80];
  const at = (i) => bottoms[i];
  assert.equal(firstRowBelow(0, at, 0), 0);
  assert.equal(firstRowBelow(4, at, 0), 0);
  // A bottom exactly at scrollTop is scrolled past.
  assert.equal(firstRowBelow(4, at, 40), 2);
  assert.equal(firstRowBelow(4, at, 41), 2);
  assert.equal(firstRowBelow(4, at, 80), 4);
});

test("diff rows: the anchor skips number-less rows and keeps both sides", () => {
  const rows = [
    { top: 0, bottom: 20, old: 4, new: 6 },
    // A hunk row and a widget row hold no number.
    { top: 20, bottom: 40 },
    { top: 40, bottom: 60 },
    // Pure delete in split: the new side is a placeholder.
    { top: 60, bottom: 80, old: 5 },
    { top: 80, bottom: 100, old: 6, new: 8 },
  ];
  assert.deepEqual(anchorFromRows(rows, 25), {
    old: 5,
    new: undefined,
    offsetPx: 35,
    heightPx: 20,
    atTop: false,
  });
  // Partly scrolled past: a negative offset.
  assert.deepEqual(anchorFromRows(rows, 65), {
    old: 5,
    new: undefined,
    offsetPx: -5,
    heightPx: 20,
    atTop: false,
  });
  assert.deepEqual(anchorFromRows(rows, 85), {
    old: 6,
    new: 8,
    offsetPx: -5,
    heightPx: 20,
    atTop: false,
  });
  // Pure add: only the new side.
  assert.deepEqual(anchorFromRows([{ top: 10, bottom: 30, new: 9 }], 0), {
    old: undefined,
    new: 9,
    offsetPx: 10,
    heightPx: 20,
    atTop: true,
  });
});

test("diff rows: a row on the top edge at a fractional top is the anchor, not the row above", () => {
  // Rows lay out at fractional tops: the row above shows 0.5px below the edge.
  const rows = [
    { top: 789.5, bottom: 808.5, old: 34 },
    { top: 808.5, bottom: 827.5, new: 1 },
  ];
  assert.deepEqual(anchorFromRows(rows, 808), {
    old: undefined,
    new: 1,
    offsetPx: 0.5,
    heightPx: 19,
    atTop: false,
  });
  // A row with more than the edge tolerance showing is still the anchor.
  assert.equal(anchorFromRows(rows, 807)?.old, 34);
});

test("diff rows: no numbered row at or below the top means no anchor", () => {
  assert.equal(anchorFromRows([], 0), null);
  assert.equal(anchorFromRows([{ top: 0, bottom: 20 }], 0), null);
  assert.equal(anchorFromRows([{ top: 0, bottom: 20, new: 1 }], 20), null);
});

test("diff rows: the restore is an absolute scrollTop from the anchor's offset", () => {
  assert.equal(restoreTop({ new: 3, offsetPx: 35 }, 400), 365);
  assert.equal(restoreTop({ new: 3, offsetPx: -5 }, 400), 405);
  assert.equal(restoreTop({ old: 3, offsetPx: 0 }, 0), 0);
});

test("diff rows: a pane read at the top restores to the top, whatever its first row's offset", () => {
  // The first numbered row sits under a 30px hunk row; the target layout's
  // hunk row is 40px, so a row-offset restore would scroll 10px.
  assert.equal(restoreTop({ new: 1, offsetPx: 30, atTop: true }, 40, 20), 0);
  assert.equal(restoreTop({ new: 1, offsetPx: 30, atTop: false }, 40, 20), 10);
});

test("diff rows: an offset inside the row scales to the target row's height", () => {
  // 30px of a 38px wrapped split row scrolled past is 15px of a 19px unified
  // row, never past the row's end.
  assert.equal(
    restoreTop({ new: 11, offsetPx: -30, heightPx: 38 }, 190, 19),
    205,
  );
  assert.equal(
    restoreTop({ new: 11, offsetPx: -15, heightPx: 19 }, 380, 38),
    410,
  );
  // An offset below the edge is the number-less rows above, kept as is.
  assert.equal(restoreTop({ new: 1, offsetPx: 30, heightPx: 19 }, 40, 38), 10);
  // No measured height: the offset as is.
  assert.equal(restoreTop({ new: 11, offsetPx: -30 }, 190, 19), 220);
});

/** A container whose querySelector answers only the selectors in `rows`, and
 *  whose querySelectorAll lists the `rendered` number-attribute values. */
const fakeContainer = (rows, rendered = {}) => {
  const asked = [];
  return {
    asked,
    querySelectorAll: (selector) =>
      (rendered[selector] ?? []).map((value) => ({
        getAttribute: () => value,
      })),
    querySelector: (selector) => {
      asked.push(selector);
      const row = rows[selector];
      return row ? { closest: (tag) => (tag === "tr" ? row : null) } : null;
    },
  };
};

test("diff rows: the anchored row is looked up in the new layout only, in its side order", () => {
  const splitNew = 'td[data-side="new"] span[data-line-num="8"]';
  const splitOld = 'td[data-side="old"] span[data-line-num="6"]';
  const both = fakeContainer({ [splitNew]: "new-row", [splitOld]: "old-row" });
  assert.equal(
    anchorRow(both, { old: 6, new: 8, offsetPx: 0 }, true),
    "new-row",
  );
  // A placeholder side falls back to the other.
  assert.equal(anchorRow(both, { old: 6, offsetPx: 0 }, true), "old-row");
  // Split never probes the unified spans.
  assert.ok(both.asked.every((s) => s.startsWith("td[data-side=")));
  // Unified lays a change's deleted lines first, so its old side wins.
  const unified = fakeContainer({
    'span[data-line-old-num="6"]': "u-old",
    'span[data-line-new-num="8"]': "u-new",
  });
  assert.equal(
    anchorRow(unified, { old: 6, new: 8, offsetPx: 0 }, false),
    "u-old",
  );
  assert.deepEqual(unified.asked, ['span[data-line-old-num="6"]']);
  assert.equal(anchorRow(unified, { new: 8, offsetPx: 0 }, false), "u-new");
  // The replaced layout's spans never resolve.
  assert.equal(anchorRow(both, { old: 6, new: 8, offsetPx: 0 }, false), null);
  assert.equal(anchorRow(fakeContainer({}), { offsetPx: 0 }, true), null);
});

/** A rendered row: its box and the number spans it holds. */
const fakeRow = (top, bottom, spans) => ({
  getBoundingClientRect: () => ({ top, bottom }),
  querySelector: (selector) => {
    const value = spans[selector];
    return value === undefined
      ? null
      : { getAttribute: () => (value === "" ? null : value) };
  },
});

test("diff rows: capture reads either layout's number spans below the top", () => {
  const scroller = (rows, scrollTop) => ({
    scrollTop,
    // The viewport starts 100px down the page.
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => rows,
  });
  // Rect tops are viewport coordinates: content top - scrollTop + 100.
  const unified = [
    fakeRow(80, 100, { "span[data-line-old-num]": "1" }),
    fakeRow(100, 120, {}),
    fakeRow(120, 140, {
      "span[data-line-old-num]": "",
      "span[data-line-new-num]": "7",
    }),
  ];
  assert.deepEqual(captureLineAnchor(scroller(unified, 50)), {
    old: undefined,
    new: 7,
    offsetPx: 20,
    heightPx: 20,
    atTop: false,
  });
  const split = [
    fakeRow(95, 115, {
      'td[data-side="old"] span[data-line-num]': "3",
      'td[data-side="new"] span[data-line-num]': "4",
    }),
  ];
  assert.deepEqual(captureLineAnchor(scroller(split, 0)), {
    old: 3,
    new: 4,
    offsetPx: -5,
    heightPx: 20,
    atTop: true,
  });
  assert.equal(captureLineAnchor(scroller([], 0)), null);
});

const ARMED = {
  armedMode: "split",
  armedFile: "src/a.ts",
  mode: "split",
  file: "src/a.ts",
  tookOver: false,
  elapsedMs: 10,
  rowReady: true,
};

test("diff rows: an armed restore fires once its row exists, and waits until then", () => {
  assert.equal(restoreDecision(ARMED), "fire");
  assert.equal(restoreDecision({ ...ARMED, rowReady: false }), "wait");
  assert.equal(
    restoreDecision({ ...ARMED, elapsedMs: RESTORE_BOUND_MS - 1 }),
    "fire",
  );
});

test("diff rows: takeover, a newer mode or file, and the bound each disarm", () => {
  assert.equal(RESTORE_BOUND_MS, 1000);
  assert.equal(
    restoreDecision({ ...ARMED, tookOver: true }),
    "disarm-takeover",
  );
  assert.equal(restoreDecision({ ...ARMED, mode: "unified" }), "disarm-mode");
  assert.equal(restoreDecision({ ...ARMED, file: "src/b.ts" }), "disarm-file");
  assert.equal(
    restoreDecision({ ...ARMED, elapsedMs: RESTORE_BOUND_MS }),
    "disarm-timeout",
  );
  assert.equal(
    restoreDecision({ ...ARMED, rowReady: false, elapsedMs: 5000 }),
    "disarm-timeout",
  );
});

test("diff rows: a taken-over restore never fires, and only the latch stops it", () => {
  const variants = [];
  for (const mode of ["split", "unified"])
    for (const file of ["src/a.ts", "src/b.ts"])
      for (const elapsedMs of [0, 10, RESTORE_BOUND_MS - 1, RESTORE_BOUND_MS])
        for (const rowReady of [true, false])
          variants.push({ ...ARMED, mode, file, elapsedMs, rowReady });
  for (const v of variants)
    assert.notEqual(restoreDecision({ ...v, tookOver: true }), "fire");
  // Negative control: the same inputs with the latch reverted do fire, so the
  // takeover arm is what holds every one of them.
  const reverted = variants.filter(
    (v) =>
      v.mode === v.armedMode &&
      v.file === v.armedFile &&
      v.elapsedMs < RESTORE_BOUND_MS &&
      v.rowReady,
  );
  assert.ok(reverted.length > 0);
  for (const v of reverted) assert.equal(restoreDecision(v), "fire");
});

test("diff rows: going to unified prefers the old side, going to split the new", () => {
  const both = { old: 6, new: 8, offsetPx: 0 };
  assert.deepEqual(anchorSides(both, false), [
    { side: "old", line: 6 },
    { side: "new", line: 8 },
  ]);
  assert.deepEqual(anchorSides(both, true), [
    { side: "new", line: 8 },
    { side: "old", line: 6 },
  ]);
  assert.deepEqual(anchorSides({ new: 8, offsetPx: 0 }, false), [
    { side: "new", line: 8 },
  ]);
  assert.deepEqual(anchorSides({ offsetPx: 0 }, true), []);
});

test("diff rows: a line the layout doesn't render falls back to the nearest at or before it", () => {
  assert.equal(fallbackLine([3, 12, 9], 10), 9);
  assert.equal(fallbackLine([3, 9, 12], 9), 9);
  // None precedes it: the first after it.
  assert.equal(fallbackLine([12, 30, 5], 2), 5);
  // No rendered line yet: nothing to stand in, so the restore keeps waiting.
  assert.equal(fallbackLine([], 5), null);
});

test("diff rows: a row rendered in the other layout only resolves to its stand-in", () => {
  // Old 40 was expanded context in split; unified renders 10, 35 and 50.
  const unified = fakeContainer(
    { 'span[data-line-old-num="35"]': "u-35" },
    { "span[data-line-old-num]": ["10", "35", "", "50"] },
  );
  assert.equal(
    anchorRow(unified, { old: 40, new: 41, offsetPx: 0 }, false),
    "u-35",
  );
  const split = fakeContainer(
    { 'td[data-side="new"] span[data-line-num="20"]': "s-20" },
    { 'td[data-side="new"] span[data-line-num]': ["60", "20"] },
  );
  assert.equal(anchorRow(split, { new: 41, offsetPx: 0 }, true), "s-20");
  // A layout with no numbered row yet resolves nothing.
  assert.equal(
    anchorRow(fakeContainer({}), { old: 40, offsetPx: 0 }, false),
    null,
  );
});

test("diff rows: capture bisects a cached row list without walking the scroller", () => {
  const scroller = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => {
      throw new Error("walked the scroller");
    },
  };
  const rows = [
    fakeRow(0, 20, { "span[data-line-new-num]": "1" }),
    fakeRow(20, 40, { "span[data-line-new-num]": "2" }),
  ];
  assert.deepEqual(captureLineAnchor(scroller, rows), {
    old: undefined,
    new: 1,
    offsetPx: 0,
    heightPx: 20,
    atTop: true,
  });
});
