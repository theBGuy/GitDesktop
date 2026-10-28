// Pins the key split for reason-disabled buttons: a bare Enter or Space is the
// button's own activation and stays swallowed by Base UI, while every other key
// (chords included) skips Base UI's handler so window hotkeys and Escape still
// see it unprevented. Shift makes a chord too: shift+Enter is bindable, and any
// click the browser synthesizes from it is refused by useButton's onClick.
//
// Stdlib-only, so the installless `guards` job runs it — but the module under
// test value-imports react, so the import is dynamic and skips only when a
// specifier is unresolved (ERR_MODULE_NOT_FOUND) AND the module is still on
// disk; GD_EXPECT_DEPS turns that skip into a failure on an installed run.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";

const MODULE = new URL("../src/lib/use-disabled-reason.ts", import.meta.url);

let isActivationKey = null;
let passThroughNonActivationKeys = null;
let heldButtonRender = null;
let skip = false;
try {
  ({ isActivationKey, passThroughNonActivationKeys, heldButtonRender } =
    await import(MODULE.href));
} catch (err) {
  if (
    process.env.GD_EXPECT_DEPS ||
    err?.code !== "ERR_MODULE_NOT_FOUND" ||
    !existsSync(MODULE)
  )
    throw err;
  skip = "react is not installed — the guards job runs with no install step";
}

/** A keydown stub carrying only what the predicate and filter read. */
function keyEvent(key, mods = {}) {
  return {
    key,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    baseUIPrevented: 0,
    preventBaseUIHandler() {
      this.baseUIPrevented++;
    },
  };
}

const CASES = [
  ["Enter", {}, true],
  ["Space", { key: " " }, true],
  ["ctrl+P", { key: "p", ctrl: true }, false],
  ["mod+Enter (ctrl)", { key: "Enter", ctrl: true }, false],
  ["mod+Enter (meta)", { key: "Enter", meta: true }, false],
  ["Escape", { key: "Escape" }, false],
  ["ArrowDown", { key: "ArrowDown" }, false],
  ["Tab", { key: "Tab" }, false],
  ["alt+letter", { key: "k", alt: true }, false],
  ["alt+Enter", { key: "Enter", alt: true }, false],
  ["shift+Enter", { key: "Enter", shift: true }, false],
  ["shift+Space", { key: " ", shift: true }, false],
  ["ctrl+Space", { key: " ", ctrl: true }, false],
];

describe("isActivationKey", { skip }, () => {
  for (const [name, spec, expected] of CASES) {
    test(`${name} → ${expected ? "activation" : "pass-through"}`, () => {
      const { key = name, ...mods } = spec;
      assert.equal(isActivationKey(keyEvent(key, mods)), expected);
    });
  }
});

describe("passThroughNonActivationKeys", { skip }, () => {
  test("leaves Base UI's swallow in place for a bare Enter or Space", () => {
    for (const key of ["Enter", " "]) {
      const e = keyEvent(key);
      passThroughNonActivationKeys(e);
      assert.equal(e.baseUIPrevented, 0);
    }
  });

  test("skips Base UI's handler for chords and named keys", () => {
    for (const [key, mods] of [
      ["p", { ctrl: true }],
      ["Enter", { meta: true }],
      ["Escape", {}],
      ["Enter", { shift: true }],
    ]) {
      const e = keyEvent(key, mods);
      passThroughNonActivationKeys(e);
      assert.equal(e.baseUIPrevented, 1);
    }
  });
});

describe("heldButtonRender", { skip }, () => {
  test("held: a typeless native button carrying the key pass-through", () => {
    const element = heldButtonRender(true);
    assert.equal(element.type, "button");
    assert.equal("type" in element.props, false);
    assert.equal(element.props.onKeyDown, passThroughNonActivationKeys);
    let stopped = 0;
    element.props.onClick({
      stopPropagation() {
        stopped++;
      },
    });
    assert.equal(stopped, 1);
  });

  test("not held: the caller's own render, by reference", () => {
    const render = { mine: true };
    assert.equal(heldButtonRender(false, render), render);
    assert.equal(heldButtonRender(false), undefined);
  });
});
