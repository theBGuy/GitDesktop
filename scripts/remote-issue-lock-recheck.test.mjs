// Pins the menu re-checks: opening a menu re-reads a held row's unknown state,
// the row's only retry (a menu row has no room for one). The issue view's
// More-actions menu re-reads the issue while its lock state is unknown
// (src/features/issues/RemoteIssueView.tsx); the Repository menu re-reads the
// star status after a failed read (src/features/repository/RepositoryMenu.tsx).
// Each guard keeps its read to that case: only on open, only where the row
// renders, not while the read is fetching or parked, and not while offline,
// where it would only park. Source shape only; the live re-read needs the app.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

/** Each menu, its trigger's label, the read it re-runs, and every conjunct of
 *  that read's guard, each required as written. */
const SITES = [
  {
    file: "src/features/issues/RemoteIssueView.tsx",
    label: "More actions",
    read: "details.refetch()",
    guards: [
      "open",
      "canLock",
      "!detailsStale",
      "issue.lockUnknown",
      "!details.isFetching",
      "!details.isPaused",
      "!isOfflineNow()",
    ],
  },
  {
    file: "src/features/repository/RepositoryMenu.tsx",
    label: "Repository actions",
    read: "starStatus.refetch()",
    guards: [
      "open",
      "canStar",
      "starStatus.isError",
      "!starStatus.isFetching",
      "!starStatus.isPaused",
      "!isOfflineNow()",
    ],
  },
];

const readSource = (site) =>
  readFileSync(new URL(`../${site.file}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** Throws unless the `<DropdownMenu>` holding the site's labelled trigger has
 *  an `onOpenChange` with an `if` whose block calls the site's read and whose
 *  guard has every one of its terms as a conjunct. Comments and strings are
 *  masked, so only code counts. */
function assertRecheck(raw, site) {
  const src = raw.replace(/\r\n/g, "\n");
  const masked = maskNonCode(src, true);
  // The menu's own trigger, never a disabled stand-in of the same name: a
  // DropdownMenuTrigger whose own render carries the label.
  const triggers = [
    ...masked.matchAll(/<DropdownMenuTrigger(?![\w$])/g),
  ].filter((m) => {
    const close = masked.indexOf("</DropdownMenuTrigger>", m.index);
    return src.slice(m.index, close).includes(`aria-label="${site.label}"`);
  });
  assert.equal(triggers.length, 1, `one ${site.label} menu trigger`);
  const opens = [
    ...masked.slice(0, triggers[0].index).matchAll(/<DropdownMenu(?![\w$])/g),
  ];
  assert.ok(opens.length > 0, "a DropdownMenu encloses the trigger");
  const start = opens.at(-1).index;
  const tag = masked.slice(start, tagEnd(masked, start) + 1);
  const handler = /\bonOpenChange\s*=\s*\{/.exec(tag);
  assert.ok(handler, `the ${site.label} menu has an onOpenChange handler`);
  const body = tag.slice(handler.index);
  const guarded = [...body.matchAll(/\bif\s*\(/g)]
    .map((m) => {
      const condOpen = m.index + m[0].length - 1;
      const condClose = matchBrace(body, condOpen);
      const blockOpen = body.indexOf("{", condClose);
      return {
        condition: body.slice(condOpen + 1, condClose),
        block: body.slice(blockOpen, matchBrace(body, blockOpen) + 1),
      };
    })
    .filter(({ block }) => block.includes(site.read));
  assert.equal(guarded.length, 1, `the guard re-reads ${site.read}`);
  // Whole conjuncts, so a term can't pass as part of another (`open`).
  const conjuncts = guarded[0].condition.replace(/\s+/g, "").split("&&");
  for (const term of site.guards)
    assert.ok(conjuncts.includes(term), `the guard includes ${term}`);
}

for (const site of SITES) {
  test(`the ${site.label} menu re-checks under its full guard`, () => {
    const source = readSource(site);
    assertRecheck(source, site);
    // CRLF is free.
    assertRecheck(source.replace(/\n/g, "\r\n"), site);
  });

  test(`the ${site.label} pin fails when its handler, a guard or the read goes`, () => {
    const source = readSource(site);
    const call = source.indexOf(`void ${site.read};`);
    assert.notEqual(call, -1, "the read is found for the mutation controls");
    const handlerStart = source.lastIndexOf("onOpenChange={(open) => {", call);
    const handlerEnd = source.indexOf("}}\n", call) + 3;
    const handler = source.slice(handlerStart, handlerEnd);
    assert.ok(handlerStart !== -1 && handlerEnd > call, "the handler is found");
    const removed = source.replace(handler, "");
    assert.throws(() => assertRecheck(removed, site), /onOpenChange/);
    const ifStart = source.lastIndexOf("if (", call);
    const header = source.slice(ifStart, call);
    for (const term of site.guards) {
      // The guard's line goes; a dangling `&&` is left, which the textual
      // check never reads.
      const cut = header.replace(
        new RegExp(`\\n\\s*${escape(term)}(?: &&)?`),
        "",
      );
      assert.notEqual(cut, header, term);
      const dropped = source.replace(header, cut);
      assert.throws(
        () => assertRecheck(dropped, site),
        new RegExp(escape(term)),
      );
    }
    const noRead = source.replace(`void ${site.read};`, "");
    assert.throws(() => assertRecheck(noRead, site), /re-reads/);
  });
}

/** `term` as a literal pattern. */
function escape(term) {
  return term.replace(/[.*+?^${}()|[\]\\!]/g, "\\$&");
}
