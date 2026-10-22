// Pins the bulk discard's one-target-per-path collapse: Git can list a path as
// a staged `D.` record beside an untracked `?` one, and the backend refuses a
// batch naming one path both ways.
//
// The import reaches straight into `src/` under Node's type stripping, so
// `discard-targets.ts` must stay free of runtime and aliased imports. The
// ChangesPanel/ChangesContextMenu wiring is pinned by mask-aware source scans,
// each with in-memory mutation controls that must turn it red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { collapseDiscardEntries } from "../src/features/repository/discard-targets.ts";
import { maskNonCode, matchBrace } from "./lib/ts-mask.mjs";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const PANEL = "src/features/repository/ChangesPanel.tsx";
const MENU = "src/features/repository/ChangesContextMenu.tsx";

const stagedDelete = { path: "a.txt", staged: "deleted", unstaged: null };
const untracked = { path: "a.txt", staged: null, unstaged: "untracked" };

test("a staged deletion beside an untracked twin keeps the untracked record", () => {
  assert.deepEqual(collapseDiscardEntries([stagedDelete, untracked]), [
    untracked,
  ]);
});

test("the untracked record first gives the same single target", () => {
  assert.deepEqual(collapseDiscardEntries([untracked, stagedDelete]), [
    untracked,
  ]);
});

test("distinct paths keep their first-seen order", () => {
  const b = { path: "b.txt", staged: null, unstaged: "modified" };
  const c = { path: "c.txt", staged: null, unstaged: "untracked" };
  assert.deepEqual(collapseDiscardEntries([b, stagedDelete, c, untracked]), [
    b,
    untracked,
    c,
  ]);
});

test("a lone tracked modification passes through unchanged", () => {
  const m = { path: "m.txt", staged: "modified", unstaged: "modified" };
  const out = collapseDiscardEntries([m]);
  assert.equal(out.length, 1);
  assert.equal(out[0], m);
});

test("an empty selection collapses to nothing", () => {
  assert.deepEqual(collapseDiscardEntries([]), []);
});

/** The masked body of `function <name>(…) { … }` in `masked`, or null. */
function functionBody(masked, name) {
  const m = new RegExp(`\\bfunction ${name}\\s*\\(`).exec(masked);
  if (!m) return null;
  const open = masked.indexOf("{", m.index);
  const close = matchBrace(masked, open);
  return close === -1 ? null : masked.slice(open, close + 1);
}

/** Problems with ChangesPanel's discard wiring; empty when it is pinned. */
function panelProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  if (
    !/\bconst discardableSelected = collapseDiscardEntries\(selectedEntries\);/.test(
      masked,
    )
  )
    problems.push("discardableSelected is not collapsed from selectedEntries");
  const body = functionBody(masked, "requestDiscardSelected");
  if (body === null) problems.push("requestDiscardSelected not found");
  else {
    if (!/\bentries:\s*discardableSelected\b/.test(body))
      problems.push("requestDiscardSelected does not scope the collapsed list");
    if (/\bselectedEntries\b/.test(body))
      problems.push("requestDiscardSelected reads raw selectedEntries");
  }
  if (!/\bdiscardSelectionCount=\{discardableSelected\.length\}/.test(masked))
    problems.push("the menu's discard count is not the collapsed count");
  const wired = [...masked.matchAll(/\bdiscardSelected:\s*([\w$]+)/g)];
  if (wired.length !== 1 || wired[0][1] !== "requestDiscardSelected")
    problems.push("the menu's discardSelected is not requestDiscardSelected");
  return problems;
}

/** Problems with the bulk menu's discard label; empty when it is pinned. */
function menuProblems(text) {
  const masked = maskNonCode(text, true);
  const at = masked.search(/onClick=\{actions\.discardSelected\}/);
  if (at === -1) return ["the bulk discard item is not found"];
  const end = masked.indexOf("</ContextMenuItem>", at);
  if (end === -1) return ["the bulk discard item is not closed"];
  // The label sits in a template literal, which the mask blanks: read it raw.
  const label = text.slice(at, end);
  const problems = [];
  if (!/\$\{discardSelectionCount\}/.test(label))
    problems.push("the discard label does not count discardSelectionCount");
  if (/\bselectionCount\b/.test(label))
    problems.push("the discard label reads selectionCount");
  return problems;
}

/** `text` with `from` swapped for `to` exactly once (a control that misses
 *  its target would pass vacuously). */
function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

test("the bulk discard scopes and counts the collapsed list", () => {
  assert.deepEqual(panelProblems(source(PANEL)), []);
  assert.deepEqual(menuProblems(source(MENU)), []);
});

test("panel pin mutation controls go red", () => {
  const text = source(PANEL);
  const mutants = [
    mutate(text, "entries: discardableSelected,", "entries: selectedEntries,"),
    mutate(
      text,
      "collapseDiscardEntries(selectedEntries);",
      "[...selectedEntries];",
    ),
    mutate(
      text,
      "discardSelectionCount={discardableSelected.length}",
      "discardSelectionCount={selectionCount}",
    ),
    mutate(
      text,
      "if (discardableSelected.length > 0)",
      "if (selectedEntries.length > 0)",
    ),
    // A comment spelling the pinned scope must not satisfy the pin.
    mutate(
      text,
      "entries: discardableSelected,",
      "entries: selectedEntries, // entries: discardableSelected",
    ),
    mutate(
      text,
      "discardSelected: requestDiscardSelected,",
      "discardSelected: requestStashSelected,",
    ),
    mutate(
      text,
      "discardSelected: requestDiscardSelected,",
      "discardSelected: requestStashSelected, // discardSelected: requestDiscardSelected",
    ),
  ];
  for (const m of mutants) assert.notDeepEqual(panelProblems(m), []);
});

test("menu pin mutation controls go red", () => {
  const text = source(MENU);
  const mutants = [
    mutate(text, "${discardSelectionCount} change", "${selectionCount} change"),
    mutate(
      text,
      "onClick={actions.discardSelected}",
      "onClick={actions.stashSelected}",
    ),
  ];
  for (const m of mutants) assert.notDeepEqual(menuProblems(m), []);
});
