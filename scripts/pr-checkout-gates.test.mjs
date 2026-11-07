// RemotePrView's three checkout gates (the palette action, the loading frame's
// held split control, the loaded header's split control) render on every
// provider, so each keys on `canCheckout`, never the GitHub-shaped `canWrite`.
// No test renders RemotePrView, so this pin is the only thing that catches a
// gate drifting. Each gate is found by its own anchor, must occur once, and its
// whole condition must equal the expected one (whitespace-collapsed), so an
// added or dropped conjunct fails. The production wiring rides the same rule:
// the plain checkout's mutation variables and the routing props the loaded
// header hands PrWorktreeCheckout, since no test drives either from this view.
// Not covered: a gate moved behind an intermediate variable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { maskNonCode, matchBrace, tagEnd } from "./lib/ts-mask.mjs";

const FILE = "src/features/pulls/RemotePrView.tsx";
const SOURCE = readFileSync(
  fileURLToPath(new URL(`../${FILE}`, import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const EXPECTED = {
  palette:
    'isSelectedPr && !detailsStale && loadedViewPainted && pr?.state === "OPEN" && canCheckout',
  frame: "rowOpen && canCheckout",
  loaded: "isOpen && canCheckout",
  checkoutVars: "{ number, lens, provider }",
  "prop provider": "provider",
  "prop crossRepository": "pr.crossRepository",
  "prop headRepositoryOwner": "pr.headRepositoryOwner",
  "prop prNoun": "prNoun",
};

const ROUTING_PROPS = [
  "provider",
  "crossRepository",
  "headRepositoryOwner",
  "prNoun",
];

const normalize = (s) => s.replace(/\s+/g, " ").trim().replace(/,$/, "").trim();

/** The top-level argument spans of the call whose `(` is at `open`, as
 *  [start, end) offsets, or null when the call never closes. */
function argSpans(masked, open) {
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) {
        spans.push([start, i]);
        return spans;
      }
    } else if (c === "," && depth === 1) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  return null;
}

/** Each gate's condition, read from the raw source at the offsets the masked
 *  scan found (masking keeps offsets but blanks string text). */
function gateConditions(raw) {
  const masked = maskNonCode(raw, true);
  const found = Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, []]));
  for (const m of masked.matchAll(/useHotkeyAction\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    if (!/^\(\s*"pr-checkout-worktree"/.test(raw.slice(open))) continue;
    const spans = argSpans(masked, open)?.filter(
      ([s, e]) => raw.slice(s, e).trim() !== "",
    );
    found.palette.push(
      spans?.length === 3 ? raw.slice(...spans[2]) : "<unreadable call>",
    );
  }
  const jsxGate = (tag) => new RegExp(`\\{([^{}]*)&&\\s*\\(\\s*${tag}`, "g");
  const conditionAt = (m) => raw.slice(m.index + 1, m.index + 1 + m[1].length);
  for (const m of masked.matchAll(
    jsxGate("<span className=\\{CHECKOUT_SPLIT_CLASS\\}>"),
  ))
    found.frame.push(conditionAt(m));
  for (const m of masked.matchAll(jsxGate("<PrWorktreeCheckout\\b")))
    found.loaded.push(conditionAt(m));
  for (const m of masked.matchAll(/(?<![\w$.])checkout\.mutateAsync\s*\(/g)) {
    const spans = argSpans(masked, m.index + m[0].length - 1);
    found.checkoutVars.push(
      spans?.length === 1 ? raw.slice(...spans[0]) : "<unreadable call>",
    );
  }
  for (const m of masked.matchAll(/<PrWorktreeCheckout\b/g)) {
    const end = tagEnd(masked, m.index);
    if (end < 0) continue;
    const tag = masked.slice(m.index, end);
    for (const prop of ROUTING_PROPS)
      for (const p of tag.matchAll(
        new RegExp(`(?<![\\w$-])${prop}=\\{`, "g"),
      )) {
        const open = m.index + p.index + p[0].length - 1;
        const close = matchBrace(masked, open);
        found[`prop ${prop}`].push(
          close < 0 ? "<unreadable prop>" : raw.slice(open + 1, close),
        );
      }
  }
  return found;
}

function gateProblems(raw) {
  const problems = [];
  for (const [gate, conds] of Object.entries(gateConditions(raw))) {
    if (conds.length !== 1) {
      problems.push(`${gate}: expected one gate, found ${conds.length}`);
      continue;
    }
    const got = normalize(conds[0]);
    if (got !== EXPECTED[gate])
      problems.push(
        `${gate}: gate is \`${got}\`, expected \`${EXPECTED[gate]}\``,
      );
  }
  return problems;
}

test("every checkout gate in RemotePrView is exactly its expected condition", () => {
  assert.deepEqual(gateProblems(SOURCE), []);
});

/** Applies `edit` at `site` and asserts that gate goes red. */
function assertCaught(gate, site, edit) {
  const mutated = SOURCE.replace(site, edit);
  assert.notEqual(mutated, SOURCE, `${gate}: mutation anchor not found`);
  const problems = gateProblems(mutated);
  assert.ok(
    problems.some((p) => p.startsWith(`${gate}:`)),
    `${gate}: mutation not caught (${problems.join("; ")})`,
  );
}

const SITES = {
  palette: /pr\?\.state === "OPEN" &&\s*canCheckout/,
  frame: /rowOpen && canCheckout/,
  loaded: /isOpen && canCheckout/,
};

test("a gate flipped back to canWrite goes red", () => {
  for (const [gate, site] of Object.entries(SITES))
    assertCaught(gate, site, (s) => s.replace("canCheckout", "canWrite"));
});

test("a gate with an added provider conjunct goes red", () => {
  for (const [gate, site] of Object.entries(SITES))
    assertCaught(gate, site, (s) => `${s} && provider === "github"`);
});

test("a gate with a dropped conjunct goes red", () => {
  assertCaught(
    "palette",
    /isSelectedPr &&\s*!detailsStale &&\s*loadedViewPainted/,
    () => "isSelectedPr && loadedViewPainted",
  );
  assertCaught("frame", /rowOpen && canCheckout/, () => "canCheckout");
  assertCaught("loaded", /isOpen && canCheckout/, () => "canCheckout");
});

test("the production checkout wiring is exactly its expected expression", () => {
  // The reviewer's mutation: the handler drops the real provider.
  assertCaught(
    "checkoutVars",
    /checkout\.mutateAsync\(\{ number, lens, provider \}\)/,
    () => "checkout.mutateAsync({ number, lens, provider: undefined })",
  );
  assertCaught(
    "checkoutVars",
    /checkout\.mutateAsync\(\{ number, lens, provider \}\)/,
    () => "checkout.mutateAsync({ number, lens })",
  );
  for (const prop of ROUTING_PROPS)
    assertCaught(
      `prop ${prop}`,
      new RegExp(`(<PrWorktreeCheckout[^>]*?\\s)${prop}=\\{[^}]*\\}`),
      (_s, lead) => `${lead}${prop}={undefined}`,
    );
});

test("a gate that can't be found fails closed", () => {
  const gone = SOURCE.replace(/"pr-checkout-worktree"/, '"pr-elsewhere"');
  assert.ok(gateProblems(gone).includes("palette: expected one gate, found 0"));
});
