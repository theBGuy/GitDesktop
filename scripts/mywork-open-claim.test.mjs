// Pins My work's click-time open claim: `openItem` in
// src/features/mywork/MyWorkScreen.tsx calls `claimRepoOpen()` once, ahead of
// its first `return` and its first `await`. An older row's jump can still be
// held on its repo-shell warm-up, and that hold checks the open claims, not
// `openGen`, so a click that claimed only after an early exit or an await would
// let the older target land over the newer one. A narrow pin on this one
// function, not a src-wide scanner; each check must also go red on the in-memory
// mutants below, so a scan that can't fail on those edits fails here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const FILE = "src/features/mywork/MyWorkScreen.tsx";
const source = readFileSync(
  new URL(`../${FILE}`, import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** Problems with openItem's claim, `[]` when pinned. Fails closed when the
 *  function, its body, an early return or an await can't be found, so a rename
 *  or reshape never passes vacuously. Nested callbacks count: a `return` or
 *  `await` anywhere ahead of the claim fails. */
function openClaimProblems(text) {
  const masked = maskNonCode(text, true);
  const heads = [...masked.matchAll(/\basync function openItem\s*\(/g)];
  if (heads.length !== 1)
    return [`expected one async function openItem, found ${heads.length}`];
  const paramsOpen = heads[0].index + heads[0][0].length - 1;
  const paramsClose = matchBrace(masked, paramsOpen);
  if (paramsClose === -1) return ["openItem's parameter list was not found"];
  const open = /^\s*\{/.exec(masked.slice(paramsClose + 1));
  if (!open) return ["openItem has no block body"];
  const bodyOpen = paramsClose + open[0].length;
  const bodyClose = matchBrace(masked, bodyOpen);
  if (bodyClose === -1) return ["openItem's body was not closed"];
  const body = masked.slice(bodyOpen, bodyClose + 1);
  const claims = [...body.matchAll(/(?<![\w$.])claimRepoOpen\(\)\s*;/g)];
  const firstReturn = /(?<![\w$.])return(?![\w$])/.exec(body);
  const firstAwait = /(?<![\w$.])await(?![\w$])/.exec(body);
  const problems = [];
  if (!firstReturn) problems.push("openItem has no return to order against");
  if (!firstAwait) problems.push("openItem has no await to order against");
  if (claims.length !== 1) {
    problems.push(
      `expected one claimRepoOpen(); in openItem, found ${claims.length}`,
    );
    return problems;
  }
  const at = claims[0].index;
  if (firstReturn && firstReturn.index < at)
    problems.push("openItem can return before it claims the open");
  if (firstAwait && firstAwait.index < at)
    problems.push("openItem awaits before it claims the open");
  return problems;
}

/** `s` with `from` replaced exactly once (the mutation fails closed if absent). */
const once = (from, to) => (s) => s.replace(from, () => to);

const CLAIM = "    claimRepoOpen();\n";
const EARLY_RETURN = "      openUrl(item.url);\n      return;\n    }\n";
const FIRST_AWAIT = "      await validateRepo(match.path);\n";

const MUTANTS = {
  "the claim removed": once(CLAIM, ""),
  "the claim below the first early return": (s) =>
    once(EARLY_RETURN, `${EARLY_RETURN}${CLAIM}`)(once(CLAIM, "")(s)),
  "the claim below the first await": (s) =>
    once(FIRST_AWAIT, `${FIRST_AWAIT}  ${CLAIM}`)(once(CLAIM, "")(s)),
  "an await ahead of the claim": once(CLAIM, `    await null;\n${CLAIM}`),
  "openItem renamed": once(
    "async function openItem(",
    "async function openRow(",
  ),
};

test("My work's openItem claims the open before any return or await", () => {
  assert.deepEqual(openClaimProblems(source), []);
});

test("negative control: every mutant of the claim fails the pin", () => {
  for (const [name, mutate] of Object.entries(MUTANTS)) {
    const mutant = mutate(source);
    assert.notEqual(mutant, source, `mutant "${name}" didn't apply`);
    assert.ok(
      openClaimProblems(mutant).length > 0,
      `the pin passed mutant "${name}"`,
    );
  }
});
