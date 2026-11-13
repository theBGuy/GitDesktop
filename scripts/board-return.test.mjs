// Pins the board return's pure step (src/features/projects/board-return.ts): every arm
// of `boardReturnStep` and `readState`, and for each pair of adjacent arms one input
// both match, expecting the earlier arm's step, so an arm reorder goes red here.
//
// Not testable here: the hook's effects, its focus rule and its drop on hide. Those are
// pinned through the hook in src/test/board-return.test.tsx.
//
// The import reaches straight into `src/` under Node's type stripping, so the module
// must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardReturnStep,
  readState,
} from "../src/features/projects/board-return.ts";

/** Home: the anchor's project and view drawn, every read ready, the card drawn and
 *  the items read settled, on the board layout. */
const base = (over = {}) => ({
  anchor: { projectId: "P1", viewId: "V1", itemId: "I1", showArchived: false },
  applied: { project: false, view: false, archived: false },
  claimed: null,
  claimFocused: false,
  focusHeld: false,
  gate: "open",
  catalog: "ready",
  projectIds: ["P1", "P2"],
  projectId: "P1",
  views: "ready",
  viewIds: ["V1", "V2"],
  activeViewId: "V1",
  fields: "ready",
  items: "ready",
  itemsFetching: false,
  archivedShown: false,
  seedPending: false,
  layoutDrawn: true,
  rows: false,
  rowsDrawn: false,
  rowCursor: false,
  firstRowKey: null,
  cardFound: true,
  firstItemId: "I9",
  ...over,
});
const anchor = (over) => ({ anchor: { ...base().anchor, ...over } });

const WAIT = { kind: "wait" };
const END = { kind: "end" };
const claim = (itemId, gone, recheck) => ({
  kind: "claim",
  itemId,
  gone,
  recheck,
});

test("readState: ready, loading and dead", () => {
  const q = (over) => ({
    data: undefined,
    isError: false,
    isPaused: false,
    isFetching: true,
    isEnabled: true,
    ...over,
  });
  assert.equal(readState(q({ data: { a: 1 } })), "ready");
  // A failed refresh over loaded data keeps a usable answer.
  assert.equal(readState(q({ data: { a: 1 }, isError: true })), "ready");
  assert.equal(readState(q({})), "loading");
  // A disabled read waits for whatever enables it.
  assert.equal(
    readState(q({ isEnabled: false, isFetching: false })),
    "loading",
  );
  assert.equal(readState(q({ isError: true })), "dead");
  assert.equal(readState(q({ isPaused: true })), "dead");
  assert.equal(readState(q({ data: 1, isPlaceholderData: true })), "loading");
  assert.equal(
    readState(q({ data: 1, isPlaceholderData: true, isPaused: true })),
    "dead",
  );
  assert.equal(
    readState(q({ data: 1, isPlaceholderData: true, isError: true })),
    "dead",
  );
});

test("readState: an enabled read with no data and no fetch in flight is dead", () => {
  const idle = {
    data: undefined,
    isError: false,
    isPaused: false,
    isFetching: false,
    isEnabled: true,
  };
  assert.equal(readState(idle), "dead");
  assert.equal(
    readState({ ...idle, data: 1, isPlaceholderData: true }),
    "dead",
  );
  // Loaded data is still an answer once the fetch is idle.
  assert.equal(readState({ ...idle, data: 1 }), "ready");
});

const ARMS = [
  // The forge gate
  ["gate closed", base({ gate: "closed" }), END],
  ["gate pending", base({ gate: "pending" }), WAIT],
  // The project catalog read
  ["catalog dead", base({ catalog: "dead" }), END],
  ["catalog loading", base({ catalog: "loading" }), WAIT],
  // The one recheck after a claim made under a refetch
  [
    "recheck: items dead",
    base({ claimed: "I1", claimFocused: true, items: "dead" }),
    END,
  ],
  [
    "recheck: still fetching",
    base({ claimed: "I1", claimFocused: true, itemsFetching: true }),
    WAIT,
  ],
  ["recheck: card still drawn", base({ claimed: "I1" }), END],
  [
    "recheck: refused claim, card gone, announces",
    base({ claimed: "I1", cardFound: false }),
    { kind: "gone-notice" },
  ],
  [
    "recheck: focus moved by the user",
    base({ claimed: "I1", claimFocused: true, cardFound: false }),
    END,
  ],
  [
    "recheck: rows, focus held, the grid recovers",
    base({
      claimed: "I1",
      claimFocused: true,
      focusHeld: true,
      cardFound: false,
      rows: true,
      rowsDrawn: true,
    }),
    { kind: "gone-notice" },
  ],
  [
    "recheck: board, focus dropped, first card",
    base({
      claimed: "I1",
      claimFocused: true,
      focusHeld: true,
      cardFound: false,
    }),
    claim("I9", true, false),
  ],
  [
    "recheck: board, focus dropped, empty board",
    base({
      claimed: "I1",
      claimFocused: true,
      focusHeld: true,
      cardFound: false,
      firstItemId: null,
    }),
    { kind: "landing", gone: true },
  ],
  // No board to return to
  [
    "catalog answered with no board",
    base({ projectId: null, projectIds: [] }),
    { kind: "landing", gone: false },
  ],
  // The anchor's project
  [
    "another project that exists",
    base({ projectId: "P2" }),
    { kind: "switch-project", projectId: "P1" },
  ],
  [
    "another project that is gone: not home, no card",
    base({ projectId: "P2", projectIds: ["P2"] }),
    claim("I9", false, false),
  ],
  [
    "the switch already applied: not home",
    base({ projectId: "P2", applied: { ...base().applied, project: true } }),
    claim("I9", false, false),
  ],
  // The anchor's view
  [
    "a differing view",
    base({ activeViewId: "V2" }),
    { kind: "pick-view", viewId: "V1" },
  ],
  [
    "viewId null against an active view",
    base({ ...anchor({ viewId: null }), activeViewId: "V2" }),
    { kind: "pick-view", viewId: null },
  ],
  ["views dead", base({ activeViewId: "V2", views: "dead" }), END],
  ["views loading", base({ activeViewId: "V2", views: "loading" }), WAIT],
  ["the anchor's view active, views loading", base({ views: "loading" }), WAIT],
  ["the anchor's view active, views dead", base({ views: "dead" }), END],
  [
    "no saved view on either side waits for no views read",
    base({ ...anchor({ viewId: null }), activeViewId: null, views: "loading" }),
    claim("I1", false, false),
  ],
  [
    "not home, a saved view active, views loading",
    base({ projectId: "P2", projectIds: ["P2"], views: "loading" }),
    WAIT,
  ],
  [
    "not home, a saved view active, views dead",
    base({ projectId: "P2", projectIds: ["P2"], views: "dead" }),
    END,
  ],
  [
    "not home, no saved view active, waits for no views read",
    base({
      projectId: "P2",
      projectIds: ["P2"],
      activeViewId: null,
      views: "loading",
    }),
    claim("I9", false, false),
  ],
  [
    "an anchor view with none active waits for the views read",
    base({ activeViewId: null, views: "loading" }),
    WAIT,
  ],
  [
    "an anchor view with none active ends on a dead views read",
    base({ activeViewId: null, views: "dead" }),
    END,
  ],
  [
    "fields dead at the pick",
    base({ activeViewId: "V2", fields: "dead" }),
    END,
  ],
  [
    "a view that is gone falls through",
    base({ ...anchor({ viewId: "V7" }), activeViewId: "V2" }),
    claim("I1", false, false),
  ],
  [
    "the view pick already applied",
    base({ activeViewId: "V2", applied: { ...base().applied, view: true } }),
    claim("I1", false, false),
  ],
  // The anchor's Show archived
  [
    "showArchived true against a panel showing none",
    base(anchor({ showArchived: true })),
    { kind: "set-archived", shown: true },
  ],
  [
    "showArchived false against a panel showing them",
    base({ archivedShown: true }),
    { kind: "set-archived", shown: false },
  ],
  [
    "archived already applied",
    base({
      archivedShown: true,
      applied: { ...base().applied, archived: true },
    }),
    claim("I1", false, false),
  ],
  // A failed fields or items read
  ["fields dead", base({ fields: "dead" }), END],
  ["items dead", base({ items: "dead" }), END],
  // A layout not yet drawn
  ["seedPending", base({ seedPending: true }), WAIT],
  ["layout not drawn", base({ layoutDrawn: false }), WAIT],
  // The landing: the card, a row's cursor cell, or the body
  ["card drawn, settled", base(), claim("I1", false, false)],
  [
    "card drawn while the items refetch",
    base({ itemsFetching: true }),
    claim("I1", false, true),
  ],
  [
    "card absent until settle",
    base({ cardFound: false, itemsFetching: true }),
    WAIT,
  ],
  [
    "card gone with a first card",
    base({ cardFound: false }),
    claim("I9", true, false),
  ],
  [
    "card gone, empty board",
    base({ cardFound: false, firstItemId: null }),
    { kind: "landing", gone: true },
  ],
  [
    "first section collapsed, card gone: the first drawn item row",
    base({
      rows: true,
      rowsDrawn: true,
      cardFound: false,
      firstItemId: "I5",
      firstRowKey: "group:B1",
    }),
    claim("I5", true, false),
  ],
  [
    "card in a collapsed section counts as found",
    base({ rows: true, rowsDrawn: true, firstItemId: null }),
    claim("I1", false, false),
  ],
  [
    "no card on a board: the first card, quietly",
    base(anchor({ itemId: null })),
    claim("I9", false, false),
  ],
  [
    "no card on an empty board",
    base({ ...anchor({ itemId: null }), firstItemId: null }),
    { kind: "landing", gone: false },
  ],
  [
    "no card on rows with a cursor",
    base({
      ...anchor({ itemId: null }),
      rows: true,
      rowsDrawn: true,
      rowCursor: true,
      firstRowKey: "item:I9",
    }),
    { kind: "refocus", seedRowKey: null },
  ],
  [
    "no card on rows without a cursor seeds the first drawn row",
    base({
      ...anchor({ itemId: null }),
      rows: true,
      rowsDrawn: true,
      firstRowKey: "group:B1",
      firstItemId: null,
    }),
    { kind: "refocus", seedRowKey: "group:B1" },
  ],
  [
    "no card on rows with none drawn",
    base({ ...anchor({ itemId: null }), rows: true, firstItemId: null }),
    { kind: "landing", gone: false },
  ],
];

for (const [name, input, expected] of ARMS)
  test(`arm: ${name}`, () =>
    assert.deepEqual(boardReturnStep(input), expected));

// Each row matches two adjacent arms; the earlier one must win.
const ADJACENT = [
  [
    "gate closed beats a ready board with the card drawn",
    base({ gate: "closed" }),
    END,
  ],
  [
    "gate pending beats a dead catalog",
    base({ gate: "pending", catalog: "dead" }),
    WAIT,
  ],
  [
    "a dead catalog beats the recheck",
    base({ catalog: "dead", claimed: "I1", itemsFetching: true }),
    END,
  ],
  [
    "the recheck beats a null board",
    base({ claimed: "I1", projectId: null }),
    END,
  ],
  [
    "a null board beats the project switch",
    base({ projectId: null }),
    { kind: "landing", gone: false },
  ],
  [
    "a gone project with a differing view expects no pick-view",
    base({ projectId: "P2", projectIds: ["P2"], activeViewId: "V2" }),
    claim("I9", false, false),
  ],
  [
    "a project switch beats an active saved view's loading views read",
    base({ projectId: "P2", views: "loading" }),
    { kind: "switch-project", projectId: "P1" },
  ],
  [
    "a project switch beats a differing view",
    base({ projectId: "P2", activeViewId: "V2" }),
    { kind: "switch-project", projectId: "P1" },
  ],
  [
    "a differing view with the fields loading waits, not pick-view",
    base({ activeViewId: "V2", fields: "loading" }),
    WAIT,
  ],
  [
    "the anchor's view active with the views loading beats the archived toggle",
    base({ ...anchor({ showArchived: true }), views: "loading" }),
    WAIT,
  ],
  [
    "the view pick beats the archived toggle",
    base({ ...anchor({ showArchived: true }), activeViewId: "V2" }),
    { kind: "pick-view", viewId: "V1" },
  ],
  [
    "the archived toggle beats a dead items read",
    base({ ...anchor({ showArchived: true }), items: "dead" }),
    { kind: "set-archived", shown: true },
  ],
  [
    "a dead items read with seedPending expects end",
    base({ items: "dead", seedPending: true }),
    END,
  ],
  [
    "seedPending with the card drawn expects wait",
    base({ seedPending: true }),
    WAIT,
  ],
  [
    "claimed set with the card drawn and the fetch settled expects end",
    base({ claimed: "I1", claimFocused: true, focusHeld: true }),
    END,
  ],
];

for (const [name, input, expected] of ADJACENT)
  test(`order: ${name}`, () =>
    assert.deepEqual(boardReturnStep(input), expected));

test("termination: every acting step disables its own arm once latched", () => {
  const latched = {
    applied: { project: true, view: true, archived: true },
  };
  for (const over of [
    { projectId: "P2" },
    { activeViewId: "V2" },
    { archivedShown: true },
  ]) {
    const step = boardReturnStep(base({ ...latched, ...over }));
    assert.ok(
      !["switch-project", "pick-view", "set-archived"].includes(step.kind),
      `${JSON.stringify(over)} -> ${step.kind}`,
    );
  }
  // A recheck claim's follow-up never asks for another recheck.
  const after = boardReturnStep(
    base({
      claimed: "I1",
      claimFocused: true,
      focusHeld: true,
      cardFound: false,
      itemsFetching: false,
    }),
  );
  assert.equal(after.kind === "claim" && after.recheck, false);
});
