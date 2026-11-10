// The user pickers' pure half: row order (selected-first against an open-time
// snapshot), the filter, the cursor model behind Tab and the arrows, the
// shared sort rule, and the ceiling note.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPickerRows,
  ceilingNote,
  compareUsers,
  nextPickerStop,
  PICKER_LEGEND,
  rowStop,
  sortedSnapshot,
} from "../src/components/user-picker-model.ts";

const u = (id, label = id, avatarUrl = "") => ({
  id,
  label,
  avatarUrl,
  isBot: false,
});
const ids = (rows) => rows.map((r) => r.id);
const NONE = new Map();

describe("compareUsers", () => {
  it("sorts the shared S-SORT fixture like the backend: lowercased label, then id", () => {
    const users = ["bob", "Amy", "amy", "Zed"].map((label, i) =>
      u(["u2", "u9", "u1", "u3"][i], label),
    );
    assert.deepEqual(ids([...users].sort(compareUsers)), [
      "u1",
      "u9",
      "u2",
      "u3",
    ]);
    assert.deepEqual(ids(sortedSnapshot(users)), ["u1", "u9", "u2", "u3"]);
  });

  it("orders by code unit, not locale", () => {
    // localeCompare would put "é" between "e" and "f"; code units put it last.
    const users = [u("1", "é"), u("2", "f"), u("3", "e")];
    assert.deepEqual(ids(sortedSnapshot(users)), ["3", "2", "1"]);
  });
});

describe("ceilingNote", () => {
  it("prints the wire's number, locale-grouped", () => {
    assert.equal(ceilingNote(1000), "Showing the first 1,000 users.");
    assert.equal(ceilingNote(500), "Showing the first 500 users.");
  });

  it("keeps the legend's arrows as the literal characters", () => {
    assert.ok(PICKER_LEGEND.includes("↑↓"));
  });
});

describe("buildPickerRows", () => {
  it("shows the snapshot before the fetch lands", () => {
    const r = buildPickerRows({
      fetched: undefined,
      snapshot: [u("a"), u("b")],
      checked: NONE,
      filter: "",
    });
    assert.deepEqual(ids(r.rows), ["a", "b"]);
    assert.equal(r.restStart, 2);
    assert.equal(r.total, 2);
  });

  it("puts the snapshot first and keeps a snapshot user missing from the fetch", () => {
    const r = buildPickerRows({
      fetched: [u("a"), u("c"), u("d")],
      snapshot: [u("x"), u("c")],
      checked: NONE,
      filter: "",
    });
    assert.deepEqual(ids(r.rows), ["x", "c", "a", "d"]);
    assert.equal(r.restStart, 2);
    assert.equal(r.total, 4);
  });

  it("renders the fetched ref for a snapshot user, in the snapshot's position", () => {
    const r = buildPickerRows({
      fetched: [u("a"), u("c", "c", "https://img/c")],
      snapshot: [u("c")],
      checked: NONE,
      filter: "",
    });
    assert.deepEqual(ids(r.rows), ["c", "a"]);
    assert.equal(r.rows[0].avatarUrl, "https://img/c");
  });

  it("gives a checked user in neither list the last row", () => {
    const r = buildPickerRows({
      fetched: [u("a")],
      snapshot: [],
      checked: new Map([
        ["a", u("a")],
        ["z", u("z")],
      ]),
      filter: "",
    });
    assert.deepEqual(ids(r.rows), ["a", "z"]);
    assert.equal(r.restStart, 0);
  });

  it("keeps the order whatever is checked now", () => {
    const input = {
      fetched: [u("a"), u("b"), u("c")],
      snapshot: [u("b")],
      filter: "",
    };
    const before = buildPickerRows({ ...input, checked: new Map() });
    const after = buildPickerRows({
      ...input,
      checked: new Map([["c", u("c")]]),
    });
    assert.deepEqual(ids(after.rows), ids(before.rows));
    assert.deepEqual(ids(after.rows), ["b", "a", "c"]);
  });

  it("filters both groups after the split", () => {
    const fetched = [u("1", "Alice"), u("2", "bob"), u("3", "Alfred")];
    const onlyRest = buildPickerRows({
      fetched,
      snapshot: [u("2", "bob")],
      checked: NONE,
      filter: "al",
    });
    assert.deepEqual(ids(onlyRest.rows), ["1", "3"]);
    assert.equal(onlyRest.restStart, 0);
    assert.equal(onlyRest.total, 3);

    const none = buildPickerRows({
      fetched,
      snapshot: [],
      checked: NONE,
      filter: "zzz",
    });
    assert.deepEqual(none.rows, []);
    assert.equal(none.total, 3);

    const trimmed = buildPickerRows({
      fetched,
      snapshot: [u("2", "bob")],
      checked: NONE,
      filter: "  BO ",
    });
    assert.deepEqual(ids(trimmed.rows), ["2"]);
    assert.equal(trimmed.restStart, 1);
  });

  it("keeps two users with the same label apart", () => {
    const r = buildPickerRows({
      fetched: [u("{1}", "Sam"), u("{2}", "Sam")],
      snapshot: [],
      checked: NONE,
      filter: "sam",
    });
    assert.deepEqual(ids(r.rows), ["{1}", "{2}"]);
  });

  it("matches the label only, never the id", () => {
    const r = buildPickerRows({
      fetched: [u("{abc}", "Sam")],
      snapshot: [],
      checked: NONE,
      filter: "abc",
    });
    assert.deepEqual(r.rows, []);
  });
});

describe("nextPickerStop", () => {
  const F = "filter";
  const R = "retry";
  const a = rowStop("a");
  const b = rowStop("b");
  const c = rowStop("c");
  const stopLists = [[F], [F, R], [F, a], [F, R, a, b, c]];
  const next = (stops, from, key, shift = false) =>
    nextPickerStop({ stops, from, key, shift });

  it("Tab and Shift+Tab wrap through every stop", () => {
    for (const stops of stopLists) {
      stops.forEach((from, i) => {
        const n = stops.length;
        assert.equal(next(stops, from, "Tab"), stops[(i + 1) % n]);
        assert.equal(next(stops, from, "Tab", true), stops[(i + n - 1) % n]);
      });
      const gone = rowStop("gone");
      assert.equal(next(stops, gone, "Tab"), stops[0]);
      assert.equal(next(stops, gone, "Tab", true), stops.at(-1));
    }
  });

  it("one stop keeps focus where it is", () => {
    assert.equal(next([F], F, "Tab"), F);
    assert.equal(next([F], F, "Tab", true), F);
  });

  it("ArrowDown enters the list, walks rows and clamps on the last", () => {
    assert.equal(next([F], F, "ArrowDown"), null);
    assert.equal(next([F, R], F, "ArrowDown"), null);
    assert.equal(next([F, R], R, "ArrowDown"), null);
    assert.equal(next([F, a], F, "ArrowDown"), a);
    assert.equal(next([F, a], a, "ArrowDown"), null);
    const all = [F, R, a, b, c];
    assert.equal(next(all, F, "ArrowDown"), a);
    assert.equal(next(all, R, "ArrowDown"), null);
    assert.equal(next(all, a, "ArrowDown"), b);
    assert.equal(next(all, b, "ArrowDown"), c);
    assert.equal(next(all, c, "ArrowDown"), null);
  });

  it("ArrowUp walks back and leaves the first row for the filter", () => {
    assert.equal(next([F], F, "ArrowUp"), null);
    assert.equal(next([F, R], F, "ArrowUp"), null);
    assert.equal(next([F, R], R, "ArrowUp"), null);
    assert.equal(next([F, a], F, "ArrowUp"), null);
    assert.equal(next([F, a], a, "ArrowUp"), F);
    const all = [F, R, a, b, c];
    assert.equal(next(all, F, "ArrowUp"), null);
    assert.equal(next(all, R, "ArrowUp"), null);
    assert.equal(next(all, a, "ArrowUp"), F);
    assert.equal(next(all, b, "ArrowUp"), a);
    assert.equal(next(all, c, "ArrowUp"), b);
  });
});
