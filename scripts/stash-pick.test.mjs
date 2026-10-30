// Pins View stashes' selection (src/features/repository/stash-pick.ts): a pick is
// a sha plus the slot it was made at, so duplicate rows of one commit stay
// separately reachable, a shifted stack keeps the picked stash, and a dropped pick
// lands on the row now at its slot.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  resolveStashPick,
  stashRowKey,
  stashRowReactKeys,
} from "../src/features/repository/stash-pick.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const rows = (...shas) => shas.map((sha, index) => ({ sha, index }));

test("duplicate rows of one commit resolve to distinct rows", () => {
  const list = rows(A, A, B);
  const keys = [
    { sha: A, index: 0 },
    { sha: A, index: 1 },
    { sha: B, index: 2 },
  ].map((pick) => stashRowKey(resolveStashPick(list, pick)));
  assert.deepEqual(keys, [`${A}:0`, `${A}:1`, `${B}:2`]);
  assert.equal(new Set(keys).size, 3);
});

test("a duplicate below another row is reachable too", () => {
  const list = rows(A, B, A, C);
  assert.equal(resolveStashPick(list, { sha: A, index: 2 }), list[2]);
  assert.equal(resolveStashPick(list, { sha: A, index: 0 }), list[0]);
});

test("a lower drop shifts the indices, and the sha still finds its row", () => {
  // Picked C at slot 2; B is dropped, so C now sits at slot 1.
  const after = rows(A, C);
  assert.equal(resolveStashPick(after, { sha: C, index: 2 }), after[1]);
  // A push above shifts it the other way.
  const pushed = rows(B, A, C);
  assert.equal(resolveStashPick(pushed, { sha: A, index: 0 }), pushed[1]);
});

test("a dropped pick lands on the row now at its slot, clamped to the last", () => {
  // B at slot 1 dropped: C slides into slot 1.
  const middle = rows(A, C);
  assert.equal(resolveStashPick(middle, { sha: B, index: 1 }), middle[1]);
  // The last row dropped: the new last row.
  const last = rows(A, B);
  assert.equal(resolveStashPick(last, { sha: C, index: 2 }), last[1]);
});

test("an empty list resolves to nothing, and no pick to the newest", () => {
  assert.equal(resolveStashPick([], { sha: A, index: 0 }), null);
  assert.equal(resolveStashPick([], null), null);
  const list = rows(A, B);
  assert.equal(resolveStashPick(list, null), list[0]);
});

test("row keys carry both the sha and the slot", () => {
  assert.equal(stashRowKey({ sha: A, index: 3 }), `${A}:3`);
  assert.notEqual(
    stashRowKey({ sha: A, index: 0 }),
    stashRowKey({ sha: A, index: 1 }),
  );
});

test("duplicate shas get distinct React keys", () => {
  const keys = stashRowReactKeys(rows(A, B, A, A));
  assert.deepEqual(keys, [`${A}#0`, `${B}#0`, `${A}#1`, `${A}#2`]);
  assert.equal(new Set(keys).size, 4);
  assert.deepEqual(stashRowReactKeys([]), []);
});

test("a push on top keeps every pre-existing row's React key", () => {
  const before = stashRowReactKeys(rows(A, B, A));
  const after = stashRowReactKeys(rows(C, A, B, A));
  assert.deepEqual(after.slice(1), before);
});

test("dropping an unrelated row keeps the remaining rows' React keys", () => {
  const before = stashRowReactKeys(rows(A, B, C, A));
  // B dropped: A, C and the second A shift up a slot but keep their keys.
  const after = stashRowReactKeys(rows(A, C, A));
  assert.deepEqual(after, [before[0], before[2], before[3]]);
});

const DIALOG = "src/features/repository/StashesDialog.tsx";

/** View stashes imports both helpers from ./stash-pick and defines neither name
 *  itself; a private copy under another name is out of this pin's reach. An
 *  empty or unreadable source fails rather than passing. */
function dialogPickProblems(source) {
  if (typeof source !== "string" || source.trim() === "")
    return ["the dialog source is empty or unreadable"];
  const problems = [];
  const imports = [
    ...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/stash-pick";/g),
  ].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  for (const name of ["resolveStashPick", "stashRowKey", "stashRowReactKeys"]) {
    if (!imports.includes(name)) problems.push(`${name} is not imported`);
    const local = new RegExp(
      String.raw`(?:function\s+${name}\b|(?:const|let|var)\s+${name}\b)`,
    );
    if (local.test(source)) problems.push(`${name} is defined locally`);
  }
  return problems;
}

/** The row's React key comes from stashRowReactKeys (a per-list array indexed by
 *  the row's position), never stashRowKey, whose slot shifts with the stack and
 *  would remount a focused row; `data-stash` keeps stashRowKey, which keyboard
 *  nav and the highlight read. */
function dialogKeyProblems(source) {
  if (typeof source !== "string" || source.trim() === "")
    return ["the dialog source is empty or unreadable"];
  const problems = [];
  const keys = source.match(/const\s+(\w+)\s*=\s*stashRowReactKeys\(/);
  if (!keys) problems.push("no list of row keys from stashRowReactKeys");
  else if (!new RegExp(String.raw`\bkey=\{${keys[1]}\[\w+\]\}`).test(source))
    problems.push("no row takes its key from the stashRowReactKeys list");
  if (/\bkey=\{stashRowKey\(/.test(source))
    problems.push("a row is keyed by stashRowKey");
  if (!/\bdata-stash=\{stashRowKey\(\w+\)\}/.test(source))
    problems.push("data-stash does not read stashRowKey");
  return problems;
}

test("StashesDialog keys rows by stashRowReactKeys and marks them by stashRowKey", () => {
  const source = readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8");
  assert.deepEqual(dialogKeyProblems(source), []);
});

test("the key check fails on a stashRowKey key, a lost data-stash, or no source", () => {
  const source = readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8");
  const slotKeyed = source.replace(
    /\bkey=\{rowReactKeys\[i\]\}/,
    () => "key={stashRowKey(stash)}",
  );
  assert.notEqual(slotKeyed, source, "the fixture found the row key");
  assert.deepEqual(dialogKeyProblems(slotKeyed), [
    "no row takes its key from the stashRowReactKeys list",
    "a row is keyed by stashRowKey",
  ]);
  const unmarked = source.replace(
    /\bdata-stash=\{stashRowKey\(stash\)\}/,
    () => "data-stash={stash.sha}",
  );
  assert.notEqual(unmarked, source, "the fixture found data-stash");
  assert.deepEqual(dialogKeyProblems(unmarked), [
    "data-stash does not read stashRowKey",
  ]);
  assert.equal(dialogKeyProblems("").length, 1);
});

test("StashesDialog reads its selection from ./stash-pick", () => {
  const source = readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8");
  assert.deepEqual(dialogPickProblems(source), []);
});

test("the source check fails on an inlined copy, a dropped import, or no source", () => {
  const source = readFileSync(new URL(`../${DIALOG}`, import.meta.url), "utf8");
  const inlined = `${source}\nfunction resolveStashPick() {}\nconst stashRowKey = () => "";\n`;
  assert.deepEqual(dialogPickProblems(inlined), [
    "resolveStashPick is defined locally",
    "stashRowKey is defined locally",
  ]);
  const unimported = source.replace(
    /import\s*\{[^}]*\}\s*from\s*"\.\/stash-pick";/,
    () => "",
  );
  assert.notEqual(unimported, source, "the fixture found the import");
  assert.deepEqual(dialogPickProblems(unimported), [
    "resolveStashPick is not imported",
    "stashRowKey is not imported",
    "stashRowReactKeys is not imported",
  ]);
  assert.equal(dialogPickProblems("").length, 1);
  assert.equal(dialogPickProblems(undefined).length, 1);
});
