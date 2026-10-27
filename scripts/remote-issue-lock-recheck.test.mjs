// Pins the issue view's lock re-check (src/features/issues/RemoteIssueView.tsx):
// opening the More-actions menu re-reads the issue while its lock state is
// unknown, which is the held "Lock or unlock conversation" row's only retry.
// The guard keeps the read to that case: not while it is already fetching, and
// not while offline, where it would only park. Source shape only; the live
// re-read needs the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const FILE = new URL(
  "../src/features/issues/RemoteIssueView.tsx",
  import.meta.url,
);
const GUARDS = ["issue.lockUnknown", "!details.isFetching", "!isOfflineNow()"];

/** Throws unless the `<DropdownMenu>` holding the "More actions" trigger has an
 *  `onOpenChange` whose `if` guard names every GUARDS term and whose guarded
 *  block calls `details.refetch()`. Comments and strings are masked, so only
 *  code counts. */
function assertLockRecheck(raw) {
  const src = raw.replace(/\r\n/g, "\n");
  const masked = maskNonCode(src, true);
  // The menu's trigger, not the loading frame's disabled stand-in of the same
  // name: a DropdownMenuTrigger whose own render carries the label.
  const triggers = [
    ...masked.matchAll(/<DropdownMenuTrigger(?![\w$])/g),
  ].filter((m) => {
    const close = masked.indexOf("</DropdownMenuTrigger>", m.index);
    return src.slice(m.index, close).includes('aria-label="More actions"');
  });
  assert.equal(triggers.length, 1, "one More actions menu trigger");
  const label = triggers[0].index;
  const opens = [...masked.slice(0, label).matchAll(/<DropdownMenu(?![\w$])/g)];
  assert.ok(opens.length > 0, "a DropdownMenu encloses the trigger");
  const start = opens.at(-1).index;
  const tag = masked.slice(start, tagEnd(masked, start) + 1);
  const handler = /\bonOpenChange\s*=\s*\{/.exec(tag);
  assert.ok(handler, "the More actions menu has an onOpenChange handler");
  const body = tag.slice(handler.index);
  const guard = /\bif\s*\(/.exec(body);
  assert.ok(guard, "onOpenChange guards its re-read");
  const condOpen = guard.index + guard[0].length - 1;
  const condClose = matchBrace(body, condOpen);
  const condition = body.slice(condOpen, condClose + 1).replace(/\s+/g, "");
  for (const term of GUARDS)
    assert.ok(condition.includes(term), `the guard includes ${term}`);
  const blockOpen = body.indexOf("{", condClose);
  const block = body.slice(blockOpen, matchBrace(body, blockOpen) + 1);
  assert.match(block, /\bdetails\.refetch\(\)/, "the guard re-reads details");
}

test("the More actions menu re-reads the issue while its lock is unknown", () => {
  const source = readFileSync(FILE, "utf8");
  assertLockRecheck(source);
  // CRLF is free.
  assertLockRecheck(source.replace(/\r?\n/g, "\r\n"));
});

test("the pin fails when the handler or one of its guards goes", () => {
  const source = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
  const handler = /onOpenChange=\{\(open\) => \{[\s\S]*?\n {14}\}\}\n/.exec(
    source,
  );
  assert.ok(handler, "the handler is found for the mutation controls");
  const removed = source.replace(handler[0], "");
  assert.notEqual(removed, source);
  assert.throws(() => assertLockRecheck(removed), /onOpenChange/);
  for (const term of GUARDS) {
    // The guard's line goes; a dangling `&&` is left, which the textual
    // check never reads.
    const dropped = source.replace(
      handler[0],
      handler[0].replace(new RegExp(`\\n\\s*${escape(term)}(?: &&)?`), ""),
    );
    assert.notEqual(dropped, source, term);
    assert.throws(() => assertLockRecheck(dropped), new RegExp(escape(term)));
  }
  const noRead = source.replace(
    handler[0],
    handler[0].replace("void details.refetch();", ""),
  );
  assert.notEqual(noRead, source);
  assert.throws(() => assertLockRecheck(noRead), /re-reads details/);
});

/** `term` as a literal pattern. */
function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\!]/g, "\\$&");
}
