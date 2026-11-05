// Pins the one property of the app-wide bare-F7 guard in useHotkeysListener
// (src/lib/hotkeys/hotkeys.tsx) that src/test/hotkeys-f7-guard.test.tsx cannot
// observe: the guard never stops propagation, by stopPropagation or its legacy
// cancelBubble spelling. The app listener sits on window, and stopping there
// never skips other window listeners (only stopImmediatePropagation does), so
// the interaction tests stay green under either.
//
// Not testable here or there: whether WebView2 actually suppresses the caret
// browsing prompt. That needs the live app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "src/lib/hotkeys/hotkeys.tsx";
const SOURCE = readFileSync(join(REPO_ROOT, FILE), "utf8");

/** The bare-F7 guard's braced block, masked, with its closing offset. */
function guardBlock(source) {
  const masked = maskNonCode(source, true);
  const blocks = [];
  for (const m of masked.matchAll(/\bif\s*\(/g)) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBrace(masked, parenOpen);
    assert.ok(parenClose > parenOpen, `${FILE}: unbalanced if condition`);
    if (!/\be\.key\s*===\s*"F7"/.test(source.slice(parenOpen, parenClose)))
      continue;
    const open =
      parenClose + 1 + /^\s*/.exec(masked.slice(parenClose + 1))[0].length;
    assert.equal(masked[open], "{", `${FILE}: the F7 guard needs a block`);
    const close = matchBrace(masked, open);
    assert.ok(close > open, `${FILE}: the F7 guard's block is unbalanced`);
    blocks.push({ block: masked.slice(open + 1, close), close });
  }
  assert.equal(blocks.length, 1, `${FILE}: expected one bare-F7 guard`);
  return blocks[0];
}

function pinNoStop(source) {
  assert.doesNotMatch(
    guardBlock(source).block,
    /\b(?:stopPropagation|cancelBubble)\b/,
    "the bare-F7 guard must never stop propagation",
  );
}

test("the bare-F7 guard never stops propagation", () => {
  pinNoStop(SOURCE);
});

test("negative controls: either stop spelling in the guard fails", () => {
  const { close } = guardBlock(SOURCE);
  for (const stop of ["e.stopPropagation();", "e.cancelBubble = true;"]) {
    const mutated = `${SOURCE.slice(0, close)}${stop}${SOURCE.slice(close)}`;
    assert.throws(() => pinNoStop(mutated), { code: "ERR_ASSERTION" }, stop);
  }
});
