// A detail pane's error arm renders only while its read has failed and isn't
// fetching (resolveDetailPane), so pressing its Retry swaps the arm away in
// the same render: a disabled state or an in-flight label there never paints.
// Ladder views copy one another's error arm, so that dead pair spreads by
// copy; this keeps every rescue-wired Retry (`ref={retryRef}`) in them free
// of it. Not covered: a Retry wired through another ref name.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSE,
  escapeRe,
  lineOf,
  maskNonCode,
  OPEN,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFINITION = "src/features/conversations/remote-section-state.ts";
const LADDER_CALL = /(?<![\w$.])resolveDetailPane\s*\(/;

/** Every src file that calls the ladder, masked, its definition excluded. */
function ladderCallers() {
  const files = [];
  for (const full of sourceFiles(path.join(ROOT, "src"))) {
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    if (rel === DEFINITION) continue;
    const raw = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    if (!LADDER_CALL.test(raw)) continue;
    const masked = maskNonCode(raw, rel.endsWith(".tsx"));
    if (LADDER_CALL.test(masked)) files.push({ rel, raw, masked });
  }
  return files;
}

/** The `<` opening the tag whose attribute sits at `at`: the nearest `<Name`
 *  behind it at bracket depth zero. */
function tagStart(masked, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (CLOSE.has(c)) depth++;
    else if (OPEN.has(c)) {
      if (depth === 0) return -1;
      depth--;
    } else if (depth === 0 && c === "<" && /[A-Za-z_$]/.test(masked[i + 1]))
      return i;
  }
  return -1;
}

/** End (exclusive) of the element whose opening tag starts at `start`, through
 *  its matching close tag. */
function elementEnd(masked, start) {
  const name = /^<([\w$.]+)/.exec(masked.slice(start))[1];
  const open = tagEnd(masked, start);
  if (open < 0) return -1;
  if (masked[open - 1] === "/") return open + 1;
  const re = new RegExp(`<(/?)${escapeRe(name)}(?![\\w$.])`, "g");
  re.lastIndex = open + 1;
  let depth = 1;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (m[1]) {
      if (--depth === 0) return masked.indexOf(">", m.index) + 1;
    } else {
      const end = tagEnd(masked, m.index);
      if (end < 0) return -1;
      if (masked[end - 1] !== "/") depth++;
      re.lastIndex = end + 1;
    }
  }
  return -1;
}

/** Every element carrying `ref={retryRef}`, as its span in the source. */
function retryElements({ rel, masked }) {
  const spans = [];
  for (const m of masked.matchAll(/(?<![\w$.-])ref=\{\s*retryRef\s*\}/g)) {
    const start = tagStart(masked, m.index);
    assert.ok(
      start >= 0,
      `${rel}:${lineOf(masked, m.index)}: no tag holds ref`,
    );
    const end = elementEnd(masked, start);
    assert.ok(
      end > start,
      `${rel}:${lineOf(masked, start)}: element never closes`,
    );
    spans.push({ start, end });
  }
  return spans;
}

/** The raw text of each blanked run in `from`..`to` that is a string or JSX
 *  text, with its offset; comment runs are skipped. A run is JSX text when it
 *  sits between a tag's `>` or an expression's `}` and the next `<` or `{`. */
function textRuns(masked, raw, from, to) {
  const runs = [];
  for (let i = from; i < to; ) {
    if (!/\s/.test(masked[i]) || masked[i] === raw[i]) {
      i++;
      continue;
    }
    let s = i;
    while (s > from && /\s/.test(masked[s - 1])) s--;
    let e = i;
    while (e < to && /\s/.test(masked[e])) e++;
    i = e;
    const text = raw.slice(s, e);
    let before = s - 1;
    while (before >= 0 && /\s/.test(masked[before])) before--;
    const jsxText =
      (masked[before] === ">" || masked[before] === "}") &&
      (masked[e] === "<" || masked[e] === "{");
    if (!jsxText && /^\s*\/[/*]/.test(text)) continue;
    runs.push({ at: s, text });
  }
  return runs;
}

const callers = ladderCallers();

test("the ladder's callers and their rescue-wired Retry buttons are found", () => {
  assert.ok(callers.length > 0, "no src file calls resolveDetailPane(");
  const found = callers.flatMap((f) => retryElements(f));
  assert.ok(
    found.length > 0,
    "no element carries ref={retryRef} in any resolveDetailPane( caller",
  );
});

for (const file of callers) {
  test(`${file.rel}: a rescue-wired Retry has no disabled state or in-flight label`, () => {
    const { rel, raw, masked } = file;
    const strays = [];
    for (const { start, end } of retryElements(file)) {
      const span = masked.slice(start, end);
      for (const m of span.matchAll(/(?<![\w$.-])disabled\b/g))
        strays.push(`${rel}:${lineOf(raw, start + m.index)}: disabled`);
      for (const run of textRuns(masked, raw, start, end)) {
        const hit = run.text.search(/Retrying/);
        if (hit >= 0)
          strays.push(`${rel}:${lineOf(raw, run.at + hit)}: "Retrying" label`);
      }
    }
    assert.equal(
      strays.length,
      0,
      `a Retry the error arm unmounts first: ${strays.join("; ")}`,
    );
  });
}
