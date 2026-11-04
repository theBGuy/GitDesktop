// Pins the app-wide bare-F7 guard in useHotkeysListener
// (src/lib/hotkeys/hotkeys.tsx): an unhandled F7 opens WebView2's caret
// browsing prompt, so the listener's keydown handler preventDefaults bare F7
// right after capturing the consumed flag, ahead of the repeat/consumed return
// (which reads that capture, never the flag the guard just set), the editable
// target return and the binding lookup, and never stops propagation or
// returns, so dispatch below it is unchanged.
//
// Not testable here: whether WebView2 actually suppresses the prompt. That
// needs the live app. Every lookup that finds nothing fails, and the negative
// controls mutate the source in memory only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "src/lib/hotkeys/hotkeys.tsx";
const SOURCE = readFileSync(join(REPO_ROOT, FILE), "utf8");

const TERMS = [
  'e.key === "F7"',
  "!e.ctrlKey",
  "!e.altKey",
  "!e.metaKey",
  "!e.shiftKey",
];
const CAPTURE = "constconsumed=e.defaultPrevented;";
const CONSUMED_RETURN =
  /\bif\s*\(\s*consumed\s*\|\|\s*e\.repeat\s*\)\s*return\s*;/;
const EDITABLE_RETURN =
  "if (isEditableTarget(e.target) && !firesInEditable(binding)) return;";

/** The `{ … }` offsets that follow the match of `re` in `masked`, from `from`. */
function bodyAfter(masked, re, from, what) {
  re.lastIndex = from;
  const m = re.exec(masked);
  assert.ok(m, `${FILE}: ${what} not found`);
  const open = m.index + m[0].length - 1;
  const close = matchBrace(masked, open);
  assert.ok(close > open, `${FILE}: ${what} has no balanced body`);
  return { open, close };
}

/** Asserts the guard's presence, placement and shape; returns its offsets. */
function pinGuard(source) {
  const masked = maskNonCode(source, true);
  const listener = bodyAfter(
    masked,
    /\bexport\s+function\s+useHotkeysListener\s*\(\s*\)\s*\{/g,
    0,
    "function useHotkeysListener()",
  );
  const handler = bodyAfter(
    masked,
    /\bconst\s+onKeyDown\s*=\s*useEffectEvent\(\s*\(\s*e\s*:\s*KeyboardEvent\s*\)\s*=>\s*\{/g,
    listener.open,
    "the onKeyDown handler",
  );
  assert.ok(
    handler.close < listener.close,
    "onKeyDown must sit inside useHotkeysListener",
  );

  const guards = [];
  for (const m of masked
    .slice(handler.open, handler.close)
    .matchAll(/\bif\s*\(/g)) {
    const parenOpen = handler.open + m.index + m[0].length - 1;
    const parenClose = matchBrace(masked, parenOpen);
    assert.ok(parenClose > parenOpen, "unbalanced if condition in onKeyDown");
    const terms = source
      .slice(parenOpen + 1, parenClose)
      .replace(/\s+/g, " ")
      .split("&&")
      .map((t) => t.trim());
    if (terms.includes(TERMS[0]))
      guards.push({ start: handler.open + m.index, parenClose, terms });
  }
  assert.equal(
    guards.length,
    1,
    `expected one bare-F7 guard in onKeyDown, found ${guards.length}`,
  );
  const [guard] = guards;
  assert.deepEqual(
    [...guard.terms].sort(),
    [...TERMS].sort(),
    "the guard must test the key and all four modifier flags, nothing else",
  );

  const blockOpen =
    guard.parenClose +
    1 +
    /^\s*/.exec(masked.slice(guard.parenClose + 1))[0].length;
  assert.equal(masked[blockOpen], "{", "the guard needs a braced block");
  const blockClose = matchBrace(masked, blockOpen);
  assert.ok(blockClose > blockOpen, "the guard's block is unbalanced");
  const block = masked.slice(blockOpen + 1, blockClose);
  assert.doesNotMatch(
    block,
    /\bstopPropagation\b/,
    "the guard must never stop propagation",
  );
  assert.doesNotMatch(
    block,
    /\breturn\b/,
    "the guard must fall through to dispatch",
  );
  assert.equal(
    block.replace(/\s+/g, " ").trim(),
    "e.preventDefault();",
    "the guard's block is exactly e.preventDefault()",
  );

  assert.equal(
    masked.slice(handler.open + 1, guard.start).replace(/[\s/]/g, ""),
    CAPTURE,
    "the guard must follow only the consumed-flag capture",
  );
  // The early return reads the pre-guard capture: a post-guard
  // `e.defaultPrevented` read sees the guard's own mark, so bare F7 would
  // never dispatch.
  const afterGuard = masked.slice(blockClose, handler.close);
  assert.doesNotMatch(
    afterGuard,
    /\be\.defaultPrevented\b/,
    "nothing after the guard may read e.defaultPrevented",
  );
  for (const [re, what] of [
    [CONSUMED_RETURN, "the consumed/repeat return"],
    [/\bisEditableTarget\s*\(/, "the editable-target return"],
    [/\beventToBinding\s*\(/, "the eventToBinding call"],
  ]) {
    const at = masked.slice(handler.open, handler.close).search(re);
    assert.notEqual(at, -1, `${what} not found in onKeyDown`);
    assert.ok(
      blockClose < handler.open + at,
      `the guard must close before ${what}`,
    );
  }
  return { start: guard.start, blockClose };
}

test("bare F7 is consumed first in the app-wide keydown handler", () => {
  pinGuard(SOURCE);
});

test("negative controls: mutated guards fail", () => {
  const { start, blockClose } = pinGuard(SOURCE);
  const guardText = SOURCE.slice(start, blockClose + 1);
  const removed = SOURCE.slice(0, start) + SOURCE.slice(blockClose + 1);
  const editableAt = removed.indexOf(EDITABLE_RETURN);
  assert.notEqual(editableAt, -1, "the editable-target return must exist");
  const insertAt = editableAt + EDITABLE_RETURN.length;
  const mutations = {
    removed,
    "moved after the editable return": `${removed.slice(0, insertAt)}\n${guardText}${removed.slice(insertAt)}`,
    "stopPropagation added": `${SOURCE.slice(0, blockClose)}e.stopPropagation();${SOURCE.slice(blockClose)}`,
    "return added": `${SOURCE.slice(0, blockClose)}return;${SOURCE.slice(blockClose)}`,
    "a modifier dropped": SOURCE.replace(/\s*&&\s*!e\.shiftKey/, ""),
    "shift required instead": SOURCE.replace("!e.shiftKey", "e.shiftKey"),
    "post-guard consumed read": SOURCE.replace(
      /if \(consumed \|\| e\.repeat\)/,
      "if (e.defaultPrevented || e.repeat)",
    ),
    "capture moved after the guard": `${SOURCE.slice(0, start).replace(/const consumed = e\.defaultPrevented;/, "")}${guardText}\n    const consumed = e.defaultPrevented;${SOURCE.slice(blockClose + 1)}`,
  };
  for (const [name, mutated] of Object.entries(mutations)) {
    assert.notEqual(mutated, SOURCE, `${name}: the mutation must apply`);
    assert.throws(
      () => pinGuard(mutated),
      { code: "ERR_ASSERTION" },
      `${name}: the pin must fail`,
    );
  }
});
