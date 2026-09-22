// Pins the Tab branch of `listKeyboardNav`: the three row-only pickers trap Tab
// in both directions, so the index math IS the only way out of a row — an
// off-by-one leaves a popup whose last row cannot be reached, and a dropped
// modifier check swallows a window chord the browser owns.
//
// Stdlib-only, so the installless `guards` job runs it — but the module under
// test value-imports react, so the import is dynamic and skips only when a
// specifier is unresolved (ERR_MODULE_NOT_FOUND, measured on node 24) AND the
// module is still on disk: nothing type-checks this path, so a moved module
// must fail loudly. The frontend job's installed step is the enforced run: it
// sets GD_EXPECT_DEPS, which fails any unresolved import there.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";

const MODULE = new URL("../src/lib/list-keyboard-nav.ts", import.meta.url);

let listKeyboardNav = null;
let skip = false;
try {
  ({ listKeyboardNav } = await import(MODULE.href));
} catch (err) {
  if (
    process.env.GD_EXPECT_DEPS ||
    err?.code !== "ERR_MODULE_NOT_FOUND" ||
    !existsSync(MODULE)
  )
    throw err;
  skip = "react is not installed — the guards job runs with no install step";
}

const ITEMS = ["a", "b", "c"];

/** A keydown stub carrying only what the handler reads when no `rowKey` is
 *  passed: it never reaches `e.target` (ignoreTextEntry is off) or
 *  `e.currentTarget`, so no DOM is involved. */
function keyEvent(key, mods) {
  return {
    key,
    shiftKey: mods.shift === true,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    metaKey: mods.meta === true,
    prevented: 0,
    preventDefault() {
      this.prevented++;
    },
  };
}

/** Fires one key at a fresh handler and reports every move it made. */
function press(
  key,
  { activeIndex, items = ITEMS, tabAdvances = true, ...mods },
) {
  const moves = [];
  const onKeyDown = listKeyboardNav({
    items,
    activeIndex,
    onActivate: (item, to, shift) => moves.push({ item, to, shift }),
    tabAdvances,
  });
  const event = keyEvent(key, mods);
  onKeyDown(event);
  return { moves, prevented: event.prevented };
}

describe("listKeyboardNav Tab advance", { skip }, () => {
  test("Tab steps to the next row and wraps past the last", () => {
    assert.deepEqual(press("Tab", { activeIndex: 0 }).moves, [
      { item: "b", to: 1, shift: false },
    ]);
    const wrapped = press("Tab", { activeIndex: 2 });
    assert.deepEqual(wrapped.moves, [{ item: "a", to: 0, shift: false }]);
    assert.equal(wrapped.prevented, 1);
  });

  test("Shift+Tab steps back and wraps past the first", () => {
    assert.deepEqual(press("Tab", { activeIndex: 2, shift: true }).moves, [
      { item: "b", to: 1, shift: false },
    ]);
    const wrapped = press("Tab", { activeIndex: 0, shift: true });
    assert.deepEqual(wrapped.moves, [{ item: "c", to: 2, shift: false }]);
    assert.equal(wrapped.prevented, 1);
  });

  test("with nothing active, Tab enters at the first row and Shift+Tab at the last", () => {
    assert.deepEqual(press("Tab", { activeIndex: -1 }).moves, [
      { item: "a", to: 0, shift: false },
    ]);
    assert.deepEqual(press("Tab", { activeIndex: -1, shift: true }).moves, [
      { item: "c", to: 2, shift: false },
    ]);
  });

  test("a Tab move reports shift false, the Shift there being direction", () => {
    const [move] = press("Tab", { activeIndex: 1, shift: true }).moves;
    assert.equal(move.shift, false);
  });

  test("a modified Tab reaches the browser untouched", () => {
    for (const mod of ["ctrl", "alt", "meta"]) {
      const r = press("Tab", { activeIndex: 1, [mod]: true });
      assert.deepEqual(r.moves, [], `${mod}+Tab moved the selection`);
      assert.equal(r.prevented, 0, `${mod}+Tab was prevented`);
    }
  });

  test("an empty list leaves Tab native", () => {
    const r = press("Tab", { activeIndex: -1, items: [] });
    assert.deepEqual(r.moves, []);
    assert.equal(r.prevented, 0);
  });

  test("without tabAdvances, Tab is not this handler's key", () => {
    const r = press("Tab", { activeIndex: 0, tabAdvances: false });
    assert.deepEqual(r.moves, []);
    assert.equal(r.prevented, 0);
  });

  test("the arrows clamp at both ends where Tab wraps", () => {
    assert.deepEqual(press("ArrowDown", { activeIndex: 2 }).moves, [
      { item: "c", to: 2, shift: false },
    ]);
    assert.deepEqual(press("ArrowUp", { activeIndex: 0 }).moves, [
      { item: "a", to: 0, shift: false },
    ]);
  });
});
