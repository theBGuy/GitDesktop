// Pins the Changes tree's chord bail, which no component test mounts: the list
// key handler's horizontal-arrow arm (Left/Right fold and walk the tree, and
// prevent the key) runs only for an arrow without a chord modifier, so Go back's
// Alt+arrow reaches the window listener. The chorded-arrow-handler guard can't
// see this arm, since the file calls `hasChordModifier(` elsewhere too.
// Not covered: what the arm does (folding, focus), and a bail spelled any other
// way than `horizontal && !hasChordModifier(e)`, which fails closed here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const PANEL = new URL(
  "../src/features/repository/ChangesPanel.tsx",
  import.meta.url,
);
const FILE = "ChangesPanel.tsx";

function bailProblems(text) {
  const raw = text.replace(/\r\n/g, "\n");
  const masked = maskNonCode(raw, true);
  const heads = [
    ...masked.matchAll(
      /\bfunction handleListKeyDown\s*\(\s*e\s*:\s*KeyboardEvent\s*\)\s*\{/g,
    ),
  ];
  if (heads.length !== 1)
    return [
      `${FILE}: ${heads.length} readable handleListKeyDown heads, not one`,
    ];
  const open = heads[0].index + heads[0][0].length - 1;
  const close = matchBrace(masked, open);
  if (close < 0) return [`${FILE}: handleListKeyDown has no closing brace`];
  const body = masked.slice(open + 1, close);
  const rawBody = raw.slice(open + 1, close);
  const problems = [];
  // The anchor: `horizontal` is set from the two arrow keys, so the arm below is
  // the horizontal-arrow arm and the pin cannot pass on a handler that lost it.
  if (
    !/let horizontal\b/.test(body) ||
    !/if \(e\.key === "ArrowLeft"\) horizontal = arrowLeft;/.test(rawBody) ||
    !/else if \(e\.key === "ArrowRight"\) horizontal = arrowRight;/.test(
      rawBody,
    )
  )
    problems.push(`${FILE}: handleListKeyDown sets no horizontal arrow arm`);
  const arms = [...body.matchAll(/\bif\s*\(/g)].filter((m) => {
    const condOpen = m.index + m[0].length - 1;
    const cond = body.slice(condOpen + 1, matchBrace(body, condOpen));
    return /^\s*horizontal\b/.test(cond);
  });
  if (arms.length !== 1)
    problems.push(`${FILE}: ${arms.length} arms test \`horizontal\`, not one`);
  else {
    const condOpen = arms[0].index + arms[0][0].length - 1;
    const cond = body
      .slice(condOpen + 1, matchBrace(body, condOpen))
      .replace(/\s+/g, " ")
      .trim();
    if (cond !== "horizontal && !hasChordModifier(e)")
      problems.push(
        `${FILE}: the horizontal arrow arm is not gated on \`!hasChordModifier(e)\``,
      );
  }
  return problems;
}

const real = readFileSync(PANEL, "utf8").replace(/\r\n/g, "\n");

test("the Changes tree's horizontal arrow arm bails on a chord", () => {
  assert.deepEqual(bailProblems(real), []);
});

// NEGATIVE CONTROLS, each a mutation of the real file's text in memory.
const mutate = (from, to) => {
  assert.equal(real.split(from).length - 1, 1, from);
  return real.split(from).join(to);
};
const ARM = "if (horizontal && !hasChordModifier(e)) {";

test("each loss of the bail fails the pin", () => {
  for (const [name, mutant, expected] of [
    [
      "the chord gate removed",
      mutate(ARM, "if (horizontal) {"),
      /not gated on `!hasChordModifier\(e\)`/,
    ],
    [
      "the gate inverted",
      mutate(ARM, "if (horizontal && hasChordModifier(e)) {"),
      /not gated on `!hasChordModifier\(e\)`/,
    ],
    [
      "the gate commented out",
      mutate(ARM, "if (horizontal /* && !hasChordModifier(e) */) {"),
      /not gated on `!hasChordModifier\(e\)`/,
    ],
    [
      "the horizontal arm removed",
      mutate(
        'if (e.key === "ArrowLeft") horizontal = arrowLeft;',
        "horizontal = undefined;",
      ),
      /sets no horizontal arrow arm/,
    ],
    [
      "the handler renamed",
      mutate("function handleListKeyDown(", "function onListKeyDown("),
      /0 readable handleListKeyDown heads/,
    ],
  ]) {
    const problems = bailProblems(mutant);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${name}: ${JSON.stringify(problems)}`,
    );
  }
});
