// Pins the confirm-swap successor order (src/components/confirm-successors.ts),
// the walk useConfirmSwapFocus runs when a leaving control took its row or
// section along: the rows after the removed one, then the earlier rows nearest
// first, then the section's fallbacks, then (section gone) the host's
// fallbacks, then the host. The rows are fakes, so what `focus()` refuses
// (disabled, unrendered) is the live app's to show, not this suite's.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rowSwapStops,
  SWAP_NODE_ATTR,
  successorCandidates,
  swapStopsOf,
} from "../src/components/confirm-successors.ts";

/** A fake element: a name, whether it is still in the document, whether the
 *  row itself carries the swap marker, and its marked descendants. */
function el(name, { connected = true, stop = false, marked = [] } = {}) {
  return { name, connected, stop, marked };
}

function view(overrides) {
  return {
    rows: [],
    before: [],
    connected: (e) => e.connected,
    stopsOf: (r) => rowSwapStops(r, r.stop, r.marked),
    sectionConnected: true,
    sectionFallbacks: [],
    hostFallbacks: [],
    host: null,
    ...overrides,
  };
}

const names = (list) => list.map((e) => e.name);

/** A fake DOM element with attributes and descendants, answering only the
 *  plain `[attr]` selectors the walk uses. `hasAttribute` is there so a
 *  predicate reading a different attribute fails the pins, not the fake. */
function domEl(name, attrs = [], children = []) {
  const has = new Set(attrs);
  const attrOf = (selector) => {
    const attr = selector.slice(1, -1);
    const plain = selector.startsWith("[") && selector.endsWith("]");
    if (!plain || attr === "" || /[^a-z-]/.test(attr))
      throw new Error(`unsupported selector ${selector}`);
    return attr;
  };
  const node = {
    name,
    hasAttribute: (a) => has.has(a),
    matches: (selector) => has.has(attrOf(selector)),
    querySelectorAll: (selector) => {
      const want = attrOf(selector);
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.hasAttribute(want)) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
    children,
  };
  return node;
}

/** The walk as it stood inside repo-settings/parts.tsx before it moved, for
 *  inputs without the new markers: same order, tried one by one. */
function legacyOrder({ rows, before, sectionFallbacks, host }) {
  const out = [];
  if (rows.length > 0) {
    const anchor = before.find((r) => r.connected);
    const at = anchor === undefined ? 0 : rows.indexOf(anchor) + 1;
    for (const r of [...rows.slice(at), ...rows.slice(0, at).reverse()])
      out.push(...r.marked);
  }
  out.push(...sectionFallbacks);
  if (host !== null) out.push(host);
  return out;
}

test("next rows first, then earlier rows nearest first, skipping a gone anchor", () => {
  const r0 = el("r0", { marked: [el("r0.del")] });
  const r2 = el("r2", { marked: [el("r2.del")] });
  const r3 = el("r3", { marked: [el("r3.del")] });
  const gone = el("r1", { connected: false });
  const v = view({ rows: [r0, r2, r3], before: [gone, r0] });
  assert.deepEqual(names(successorCandidates(v)), [
    "r2.del",
    "r3.del",
    "r0.del",
  ]);
});

test("no surviving earlier row starts the walk at the top", () => {
  const r0 = el("r0", { marked: [el("r0.del")] });
  const r1 = el("r1", { marked: [el("r1.del")] });
  const v = view({ rows: [r0, r1], before: [el("x", { connected: false })] });
  assert.deepEqual(names(successorCandidates(v)), ["r0.del", "r1.del"]);
});

test("a connected anchor missing from rows starts at the top (indexOf -1 + 1)", () => {
  const r0 = el("r0", { marked: [el("r0.del")] });
  const r1 = el("r1", { marked: [el("r1.del")] });
  const elsewhere = el("elsewhere");
  const v = view({ rows: [r0, r1], before: [elsewhere] });
  assert.deepEqual(names(successorCandidates(v)), ["r0.del", "r1.del"]);
});

test("a row marked itself precedes its marked descendants", () => {
  const r = el("row", { stop: true, marked: [el("row.remove")] });
  assert.deepEqual(names(rowSwapStops(r, r.stop, r.marked)), [
    "row",
    "row.remove",
  ]);
  assert.deepEqual(names(successorCandidates(view({ rows: [r] }))), [
    "row",
    "row.remove",
  ]);
});

test("NEGATIVE: an unmarked row element is never a candidate", () => {
  const r = el("row", { marked: [el("row.remove")] });
  assert.deepEqual(names(rowSwapStops(r, false, r.marked)), ["row.remove"]);
  const out = names(successorCandidates(view({ rows: [r] })));
  assert.ok(!out.includes("row"), `row leaked into ${out.join(",")}`);
});

test("NEGATIVE: a connected section keeps the host's fallbacks out", () => {
  const v = view({
    sectionConnected: true,
    sectionFallbacks: [el("add")],
    hostFallbacks: [el("host.review")],
    host: el("host"),
  });
  assert.deepEqual(names(successorCandidates(v)), ["add", "host"]);
});

test("a section gone tries its own fallbacks, then the host's, then the host", () => {
  const v = view({
    sectionConnected: false,
    sectionFallbacks: [el("clear", { connected: false })],
    hostFallbacks: [el("host.review")],
    host: el("host"),
  });
  assert.deepEqual(names(successorCandidates(v)), [
    "clear",
    "host.review",
    "host",
  ]);
});

test("a null host yields no host candidate", () => {
  const v = view({ sectionConnected: false, sectionFallbacks: [el("add")] });
  const out = successorCandidates(v);
  assert.deepEqual(names(out), ["add"]);
  assert.ok(!out.includes(null));
});

test("the host is always the last candidate", () => {
  const host = el("host");
  const r = el("r", { stop: true, marked: [el("r.x")] });
  for (const sectionConnected of [true, false]) {
    const out = successorCandidates(
      view({
        rows: [r],
        sectionConnected,
        sectionFallbacks: [el("add")],
        hostFallbacks: [el("hf")],
        host,
      }),
    );
    assert.equal(out.at(-1), host);
    assert.equal(out.indexOf(host), out.length - 1);
  }
});

test("unmarked inputs order exactly as the walk did before it moved", () => {
  // Every row count up to 4, every removed position, every subset of earlier
  // rows gone, with and without a host and section fallbacks.
  for (let n = 0; n <= 4; n++) {
    for (let removed = 0; removed <= n; removed++) {
      for (let goneMask = 0; goneMask < 1 << removed; goneMask++) {
        for (const withHost of [false, true]) {
          const all = Array.from({ length: n + 1 }, (_, i) =>
            el(`r${i}`, {
              connected: !(goneMask & (1 << i)),
              marked: [el(`r${i}.a`), el(`r${i}.b`)],
            }),
          );
          const rows = all.filter((r, i) => i !== removed && r.connected);
          const before = all.slice(0, removed).reverse();
          const v = view({
            rows,
            before,
            sectionFallbacks: [el("fb")],
            host: withHost ? el("host") : null,
          });
          assert.deepEqual(
            names(successorCandidates(v)),
            names(legacyOrder(v)),
            `n=${n} removed=${removed} gone=${goneMask} host=${withHost}`,
          );
        }
      }
    }
  }
});

test("a row element literally carrying the marker is its own first stop", () => {
  const row = domEl(
    "row",
    ["data-confirm-row", SWAP_NODE_ATTR],
    [domEl("edit"), domEl("remove", [SWAP_NODE_ATTR])],
  );
  assert.deepEqual(names(swapStopsOf(row)), ["row", "remove"]);
});

test("NEGATIVE: a confirm row without the marker is never its own stop", () => {
  const row = domEl(
    "row",
    ["data-confirm-row"],
    [domEl("picker", [SWAP_NODE_ATTR]), domEl("remove", [SWAP_NODE_ATTR])],
  );
  assert.deepEqual(names(swapStopsOf(row)), ["picker", "remove"]);
});

test("marked descendants come in DOM order, nested ones included", () => {
  const row = domEl(
    "row",
    ["data-confirm-row"],
    [
      domEl("wrap", [], [domEl("deep", [SWAP_NODE_ATTR])]),
      domEl("x", [SWAP_NODE_ATTR]),
    ],
  );
  assert.deepEqual(names(swapStopsOf(row)), ["deep", "x"]);
});
