// Pins `appliedOn="save"` on every LinkedIssuesField an Edit dialog renders
// (its `belowBody`), so the hint says the lines land on Save there, not on create.
// A source pin because the Bitbucket + Jira Edit dialog needs a chain of forge reads
// no harness answers; the local Edit site is also pinned in jsdom
// (src/test/local-pr-view-strip.test.tsx). In-memory mutants prove it can fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SITES = [
  ["src/features/pulls/RemotePrView.tsx", 2],
  ["src/features/pulls/LocalPrView.tsx", 1],
];
const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

/** Each `belowBody={…}` expression's text, matched by brace depth. */
function belowBodies(src) {
  const out = [];
  for (const m of src.matchAll(/belowBody=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") depth -= 1;
    }
    if (depth !== 0) return null;
    out.push(src.slice(m.index, i));
  }
  return out;
}

/** Null when the file's Edit-dialog fields number `expected` and each carries
 *  `appliedOn="save"`; otherwise the reason the pin fails. */
function hintMismatch(src, expected) {
  const bodies = belowBodies(src);
  if (bodies === null) return "an unbalanced belowBody expression";
  const fields = bodies.flatMap((b) =>
    [...b.matchAll(/<LinkedIssuesField\b[\s\S]*?\/>/g)].map((m) => m[0]),
  );
  if (fields.length !== expected)
    return `expected ${expected} Edit-dialog fields, read ${fields.length}`;
  const bare = fields.find((f) => !/\bappliedOn="save"/.test(f));
  return bare === undefined ? null : `no appliedOn="save" on ${bare}`;
}

test("every Edit dialog's LinkedIssuesField says the lines land on Save", () => {
  for (const [rel, expected] of SITES)
    assert.equal(hintMismatch(read(rel), expected), null, rel);
});

test("the pin fails when a site drops the prop or a field moves out of view", () => {
  for (const [rel, expected] of SITES) {
    const src = read(rel);
    const prop = 'appliedOn="save"';
    const at = src.indexOf(prop);
    assert.ok(at !== -1, rel);
    const mutants = [
      [
        "the first site's prop dropped",
        src.slice(0, at) + src.slice(at + prop.length),
      ],
      [
        "the last site's prop dropped",
        (() => {
          const last = src.lastIndexOf(prop);
          return src.slice(0, last) + src.slice(last + prop.length);
        })(),
      ],
      ["the prop set to create", src.replace(prop, () => 'appliedOn="create"')],
      ["no belowBody at all", src.replaceAll("belowBody={", "footer={")],
    ];
    for (const [name, mutant] of mutants)
      assert.notEqual(
        hintMismatch(mutant, expected),
        null,
        `${rel}: mutant passed: ${name}`,
      );
  }
});
