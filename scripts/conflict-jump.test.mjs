// Pins focus-anchored wrapping, pane-position fallback and the on-open fold
// boundary. The direct .ts import uses Node's type stripping; the helper must
// keep to type-only imports. Negative controls run entirely in memory. Also
// pins, by source shape, that the strip's jump buttons keep focus put on
// mousedown: a native button would take it, so a click's anchor (the header
// the last jump focused) would be lost and every click would land region 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  JUMP_TOLERANCE_PX,
  nextConflictIndex,
  previousConflictIndex,
  shouldLandOnOpen,
} from "../src/features/repository/conflict-jump.ts";
import { maskNonCode, tagEnd } from "./lib/ts-mask.mjs";

const VIEW = "src/features/repository/ConflictFileView.tsx";
const VIEW_SOURCE = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), VIEW),
  "utf8",
);
const KEEP_FOCUS = "onMouseDown={(e)=>e.preventDefault()}";

const mixed = [-200, -50, 120, 600];
const cases = [
  {
    name: "empty, no anchor",
    anchor: null,
    tops: [],
    next: null,
    previous: null,
  },
  {
    name: "empty, anchor zero",
    anchor: 0,
    tops: [],
    next: null,
    previous: null,
  },
  { name: "anchored mid-list", anchor: 1, tops: mixed, next: 2, previous: 0 },
  { name: "anchored last wraps", anchor: 3, tops: mixed, next: 0, previous: 2 },
  {
    name: "anchored first wraps",
    anchor: 0,
    tops: mixed,
    next: 1,
    previous: 3,
  },
  // Distinguishing: position-only previous picks 2 near the end of the file.
  {
    name: "anchored near file end",
    anchor: 2,
    tops: [-500, -300, -20],
    next: 0,
    previous: 1,
  },
  // Distinguishing: position-only next returns 0 forever when all headers are
  // visible, because landConflictRegion never scrolls a visible header.
  {
    name: "anchored all visible",
    anchor: 0,
    tops: [10, 200, 400],
    next: 1,
    previous: 2,
  },
  {
    name: "anchored single self-wrap",
    anchor: 0,
    tops: [0.9],
    next: 0,
    previous: 0,
  },
  {
    name: "out-of-range anchor",
    anchor: 5,
    tops: [-200, 50],
    next: 1,
    previous: 0,
  },
  {
    name: "fallback single in view",
    anchor: null,
    tops: [0.9],
    next: 0,
    previous: 0,
  },
  {
    name: "fallback all above",
    anchor: null,
    tops: [-300, -100],
    next: 0,
    previous: 1,
  },
  {
    name: "fallback all below",
    anchor: null,
    tops: [50, 400],
    next: 0,
    previous: 1,
  },
  { name: "fallback mixed", anchor: null, tops: mixed, next: 2, previous: 1 },
  {
    name: "strict positive boundary",
    anchor: null,
    tops: [2, 300],
    next: 1,
    previous: 1,
  },
  {
    name: "strict negative boundary",
    anchor: null,
    tops: [-300, -2],
    next: 0,
    previous: 0,
  },
  {
    name: "fractional 1.5px",
    anchor: null,
    tops: [1.5, 300],
    next: 1,
    previous: 1,
  },
  {
    name: "fractional 0.49px",
    anchor: null,
    tops: [0.49, 300],
    next: 1,
    previous: 1,
  },
];

for (const { name, anchor, tops, next, previous } of cases) {
  test(name, () => {
    const positions = Object.freeze([...tops]);
    assert.equal(nextConflictIndex(anchor, positions), next);
    assert.equal(previousConflictIndex(anchor, positions), previous);
  });
}

for (const anchor of [-1, 2, 0.5, -0.5, NaN, Infinity, -Infinity]) {
  test(`invalid anchor ${anchor} uses the null-anchor fallback`, () => {
    assert.equal(nextConflictIndex(anchor, [-200, 50]), 1);
    assert.equal(previousConflictIndex(anchor, [-200, 50]), 0);
  });
}

test("default tolerance matches the pane contract", () => {
  assert.equal(JUMP_TOLERANCE_PX, 2);
});

test("explicit tolerance applies to both strict fallback boundaries", () => {
  assert.equal(nextConflictIndex(null, [5, 6], 5), 1);
  assert.equal(previousConflictIndex(null, [-6, -5], 5), 0);
  assert.equal(nextConflictIndex(null, [0.49, 300], 0), 0);
  assert.equal(previousConflictIndex(null, [-300, -0.49], 0), 1);
  assert.equal(nextConflictIndex(0, [10, 200, 400], 1000), 1);
  assert.equal(previousConflictIndex(2, [-500, -300, -20], 1000), 1);
});

test("on-open landing uses the inclusive fold boundary", () => {
  for (const [firstTop, paneHeight, expected] of [
    [100, 500, false],
    [499, 500, true],
    [700, 500, true],
    [0, 500, false],
    [498, 500, true],
    [497.9, 500, false],
  ]) {
    assert.equal(shouldLandOnOpen(firstTop, paneHeight), expected);
  }
  assert.equal(shouldLandOnOpen(495, 500, 5), true);
  assert.equal(shouldLandOnOpen(494.9, 500, 5), false);
  assert.equal(shouldLandOnOpen(499, 500, 0), false);
  assert.equal(shouldLandOnOpen(500, 500, 0), true);
});

test("negative control: wrap expectations reject clamping", () => {
  // A stepHighlight-style clamp must fail each anchored wrap expectation.
  const clampNext = (anchor, tops) => Math.min(anchor + 1, tops.length - 1);
  const clampPrevious = (anchor) => Math.max(anchor - 1, 0);
  assert.throws(() => assert.equal(clampNext(3, mixed), 0), {
    code: "ERR_ASSERTION",
  });
  assert.throws(() => assert.equal(clampPrevious(0), 3), {
    code: "ERR_ASSERTION",
  });
});

test("negative control: distinguishing expectations reject position-only picks", () => {
  // Dropping the anchor must fail both distinguishing rows, even though the
  // same position fallback remains correct when focus is outside all regions.
  const positionNext = (_anchor, tops) => nextConflictIndex(null, tops);
  const positionPrevious = (_anchor, tops) => previousConflictIndex(null, tops);
  assert.throws(() => assert.equal(positionNext(0, [10, 200, 400]), 1), {
    code: "ERR_ASSERTION",
  });
  assert.throws(() => assert.equal(positionPrevious(2, [-500, -300, -20]), 1), {
    code: "ERR_ASSERTION",
  });
});

/** Asserts each jump button's opening tag keeps focus put on mousedown. */
function pinJumpMouseDown(source) {
  const masked = maskNonCode(source, true);
  const tags = [];
  for (const m of masked.matchAll(/<Button\b/g)) {
    const end = tagEnd(masked, m.index);
    assert.ok(end > m.index, `${VIEW}: unterminated <Button> tag`);
    tags.push(source.slice(m.index, end + 1).replace(/\s+/g, ""));
  }
  for (const handler of ["jumpPrevious", "jumpNext"]) {
    const found = tags.filter((t) => t.includes(`onClick={${handler}}`));
    assert.equal(found.length, 1, `${VIEW}: one <Button> runs ${handler}`);
    assert.ok(
      found[0].includes(KEEP_FOCUS),
      `${VIEW}: the ${handler} button must preventDefault its mousedown`,
    );
  }
}

test("jump buttons keep focus put on mousedown", () => {
  pinJumpMouseDown(VIEW_SOURCE);
});

test("negative control: a jump button that takes focus fails", () => {
  const keep = "onMouseDown={(e) => e.preventDefault()}";
  const first = VIEW_SOURCE.indexOf(keep);
  const last = VIEW_SOURCE.lastIndexOf(keep);
  assert.ok(first !== -1 && last > first, "both jump buttons carry the guard");
  const cut = (at) =>
    VIEW_SOURCE.slice(0, at) + VIEW_SOURCE.slice(at + keep.length);
  const mutations = {
    "Previous takes focus": cut(first),
    "Next takes focus": cut(last),
    "handler emptied": VIEW_SOURCE.replaceAll(keep, "onMouseDown={() => {}}"),
    "moved to pointerdown": VIEW_SOURCE.replaceAll(
      keep,
      "onPointerDown={(e) => e.preventDefault()}",
    ),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, VIEW_SOURCE, `${name}: the mutation must apply`);
    assert.throws(
      () => pinJumpMouseDown(mutated),
      { code: "ERR_ASSERTION" },
      `${name}: the pin must fail`,
    );
  }
});

/** The code-only text of `source` with every whitespace run removed. */
const squash = (source) => maskNonCode(source, true).replace(/\s+/g, "");

/** Index of `needle` in `hay` from `from`; a miss fails. */
function find(hay, needle, from, what) {
  const at = hay.indexOf(needle, from);
  assert.notEqual(at, -1, `${VIEW}: ${what} not found`);
  return at;
}

/** Asserts a per-region accept's announcement disarms once its write settled
 *  and a newer read rendered, whichever lands first, so a later poll-driven
 *  count change never announces for it (count unchanged or zero included). */
function pinAnnounceDisarm(source) {
  const code = squash(source);
  find(code, "constfileRead=file.data;", 0, "the read capture");
  const effects = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf("useLayoutEffect(()=>{", from);
    if (at === -1) break;
    const end = find(code, "]);", at, "a layout effect's deps");
    const text = code.slice(at, end + 3);
    if (text.includes("armed.read")) effects.push(text);
    from = at + 1;
  }
  assert.equal(effects.length, 1, "one layout effect reads armed.read");
  const [effect] = effects;
  const depsAt = effect.lastIndexOf("},[");
  assert.notEqual(depsAt, -1, "the announce effect has a deps array");
  const deps = effect.slice(depsAt + 3, -3).split(",");
  assert.ok(
    deps.includes("fileRead"),
    "the announce effect is keyed on the read identity",
  );
  const readReturn = find(
    effect,
    "if(fileRead===armed.read)return;",
    0,
    "the same-read return",
  );
  const committed = find(effect, "armed.committed=true;", 0, "the commit mark");
  assert.ok(readReturn < committed, "the commit mark follows the read return");
  const settledReturn = find(
    effect,
    "if(!armed.settled)return;announceRef.current=null;",
    committed,
    "the unconditional disarm after the settled check",
  );
  assert.ok(settledReturn > committed);

  const settleAt = find(
    code,
    "functionsettleAnnounce(armed:CountAnnounce){",
    0,
    "settleAnnounce",
  );
  find(
    code.slice(settleAt, settleAt + 400),
    "if(announceRef.current!==armed)return;if(!armed.committed){armed.settled=true;return;}announceRef.current=null;",
    0,
    "settleAnnounce's disarm once the read committed",
  );
}

test("an accept's announcement disarms once settled and re-read", () => {
  pinAnnounceDisarm(VIEW_SOURCE);
});

test("negative control: an announcement left armed fails", () => {
  const deps = "}, [fileRead, total, repoPath, path]);";
  const eol = VIEW_SOURCE.includes("\r\n") ? "\r\n" : "\n";
  const disarm = `    if (!armed.settled) return;${eol}    announceRef.current = null;${eol}`;
  const mutations = {
    "deps without the read": VIEW_SOURCE.replace(
      deps,
      "}, [total, repoPath, path]);",
    ),
    "effect disarm removed": VIEW_SOURCE.replace(
      disarm,
      `    if (!armed.settled) return;${eol}`,
    ),
    "effect disarm only with text": VIEW_SOURCE.replace(
      `${disarm}    if (armed.text !== null)${eol}`,
      `    if (!armed.settled) return;${eol}    if (armed.text !== null)${eol}`,
    ),
    "same-read return removed": VIEW_SOURCE.replace(
      `    if (fileRead === armed.read) return;${eol}`,
      "",
    ),
    "settle disarm removed": VIEW_SOURCE.replace(
      `      return;${eol}    }${eol}    announceRef.current = null;${eol}    if (armed.text === null) return;`,
      `      return;${eol}    }${eol}    if (armed.text === null) return;`,
    ),
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, VIEW_SOURCE, `${name}: the mutation must apply`);
    assert.throws(
      () => pinAnnounceDisarm(mutated),
      { code: "ERR_ASSERTION" },
      `${name}: the pin must fail`,
    );
  }
});
