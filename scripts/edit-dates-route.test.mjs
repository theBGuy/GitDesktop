// Pins editDatesRoute's precedence, one case per line of its ladder. Imports
// the module straight from src/ under Node's type stripping, so it must stay
// free of runtime imports. Node built-ins only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { editDatesRoute } from "../src/features/history/edit-dates-route.ts";

const HEAD = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const base = {
  hash: B,
  index: 1,
  headOid: HEAD,
  opInProgress: false,
  viewAgreed: true,
  unpushedCount: 3,
  editable: [HEAD, B],
};

const route = (over) => editDatesRoute({ ...base, ...over });

test("an operation in progress holds every row, HEAD included", () => {
  assert.deepEqual(route({ opInProgress: true }), {
    kind: "held",
    hold: "op",
  });
  assert.deepEqual(route({ hash: HEAD, index: 0, opInProgress: true }), {
    kind: "held",
    hold: "op",
  });
});

test("the log's top row that status calls HEAD takes the dialog", () => {
  assert.deepEqual(route({ hash: HEAD, index: 0 }), { kind: "head" });
  // A pushed HEAD and a disagreeing view still route to the dialog.
  assert.deepEqual(
    route({ hash: HEAD, index: 0, viewAgreed: false, unpushedCount: 0 }),
    { kind: "head" },
  );
});

test("a top row status doesn't call HEAD waits", () => {
  assert.deepEqual(route({ hash: C, index: 0 }), {
    kind: "held",
    hold: "head-sync",
  });
  assert.deepEqual(route({ hash: HEAD, index: 0, headOid: undefined }), {
    kind: "held",
    hold: "head-sync",
  });
});

test("a row that left the log waits", () => {
  assert.deepEqual(route({ index: -1 }), { kind: "held", hold: "head-sync" });
});

test("status's HEAD below the log's top waits", () => {
  assert.deepEqual(route({ hash: HEAD, index: 2 }), {
    kind: "held",
    hold: "head-sync",
  });
});

test("a log behind status waits on HEAD, never on the count", () => {
  // The count's disagreement (or failure) doesn't reach these rows' reason.
  assert.deepEqual(route({ hash: C, index: 0, viewAgreed: false }), {
    kind: "held",
    hold: "head-sync",
  });
  assert.deepEqual(
    route({ hash: HEAD, index: 1, viewAgreed: false, unpushedCount: 0 }),
    { kind: "held", hold: "head-sync" },
  );
});

test("a view the reads don't both vouch for waits", () => {
  assert.deepEqual(route({ viewAgreed: false }), {
    kind: "held",
    hold: "refreshing",
  });
});

test("an editable row opens Edit history", () => {
  assert.deepEqual(route({}), { kind: "history" });
});

test("an unpushed row Edit history can't reach is out of range", () => {
  assert.deepEqual(route({ hash: C, index: 2 }), {
    kind: "held",
    hold: "out-of-range",
  });
});

test("a pushed row is held as pushed", () => {
  assert.deepEqual(route({ hash: C, index: 3 }), {
    kind: "held",
    hold: "pushed",
  });
  assert.deepEqual(route({ hash: C, index: 1, unpushedCount: 1, editable: [] }), {
    kind: "held",
    hold: "pushed",
  });
});
