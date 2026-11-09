// The issue pickers' status ladder: only a read that answered may claim no
// match, a parked read says offline, and the partial-failure line needs two
// reads to contrast with.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { offlinePendingMessage } from "../src/features/conversations/remote-section-state.ts";
import {
  ISSUES_EMPTY,
  ISSUES_LOAD_FAILED,
  ISSUES_LOADING,
  ISSUES_PARTIAL,
  issuePickerStatus,
} from "../src/features/issues/issue-picker-status.ts";

const base = {
  data: undefined,
  isLoading: false,
  isPlaceholderData: false,
  isError: false,
  isPaused: false,
  isFetching: false,
};
const pending = { ...base, isLoading: true, isFetching: true };
const answered = (rows = []) => ({ ...base, data: rows });
const rejected = { ...base, isError: true };
const failedOver = (rows) => ({ ...base, data: rows, isError: true });
const parked = { ...base, isPaused: true };
const placeholder = { ...answered([1]), isPlaceholderData: true };
const neverFetches = base;
const OFFLINE = offlinePendingMessage("issues");

describe("issuePickerStatus", () => {
  const L = ISSUES_LOADING;
  const E = ISSUES_EMPTY;
  const F = ISSUES_LOAD_FAILED;
  const P = ISSUES_PARTIAL;
  const A = answered;
  const parkedFailure = { ...rejected, isPaused: true };
  const refetching = { ...rejected, isFetching: true };
  const failedRows = failedOver([1]);
  const cases = [
    ["both pending", [pending, pending], 0, L, null],
    ["open answered, closed pending", [A([1]), pending], 1, L, null],
    ["both answered, nothing matches", [A([]), A([])], 0, E, null],
    ["open rejected, closed with rows", [rejected, A([1])], 1, E, P],
    ["open rejected, closed empty", [rejected, A([])], 0, E, P],
    ["both rejected", [rejected, rejected], 0, F, null],
    ["both failed over rows", [failedOver([1]), failedOver([2])], 2, E, F],
    ["one failed over rows, one rejected", [failedRows, rejected], 1, E, F],
    ["one read parked with no data", [parked, A([1])], 1, OFFLINE, null],
    ["parked over a failure", [parkedFailure, A([])], 0, OFFLINE, null],
    ["placeholder reads as loading", [placeholder, A([])], 1, L, null],
    ["one read pending", [pending], 0, L, null],
    ["one read rejected", [rejected], 0, F, null],
    ["one read answered empty", [A([])], 0, E, null],
    ["one read answered with rows", [A([1])], 1, E, null],
    ["one read, failed over rows: partial is null", [failedRows], 1, E, null],
    ["a read that never fetches reads as loading", [neverFetches], 0, L, null],
    ["a failed read refetching is not failed", [refetching, A([])], 0, L, null],
  ];
  for (const [name, reads, rows, empty, partial] of cases) {
    it(name, () => {
      assert.deepEqual(issuePickerStatus(reads, rows), { empty, partial });
    });
  }

  it("spells the offline line exactly as offlinePendingMessage does", () => {
    assert.equal(issuePickerStatus([parked], 0).empty, OFFLINE);
  });

  it("never says no match before a read answered", () => {
    for (const r of [pending, rejected, parked, placeholder, neverFetches]) {
      assert.notEqual(issuePickerStatus([r], 0).empty, ISSUES_EMPTY);
      assert.notEqual(issuePickerStatus([r, r], 0).empty, ISSUES_EMPTY);
    }
  });
});
