// Pins the Insights board's failure notice
// (src/features/repository/insights/board-notice.ts): a failed card stays in
// the notice through a background refetch (a polling run list refetches every
// 5 s while a run is active), a user's Retry mutes it until it settles, a
// recovered card leaves, a park is no failure, and the wording tells a failed
// refresh over loaded data from a read with nothing loaded.
//
// Not testable here: the board's Retry token and its settle (component state),
// and the live region announcing. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardNotice } from "../src/features/repository/insights/board-notice.ts";

const summarize = (e) => `reason: ${e}`;
const read = (over) => ({
  data: [1],
  error: null,
  isError: false,
  isPaused: false,
  errorUpdatedAt: 0,
  dataUpdatedAt: 1,
  ...over,
});
const healthy = read({});
const failedWithData = read({
  error: "boom",
  isError: true,
  errorUpdatedAt: 2,
});
const failedEmpty = read({
  data: undefined,
  error: "gone",
  isError: true,
  errorUpdatedAt: 2,
  dataUpdatedAt: 0,
});

test("a failed card refetching in the background keeps the notice", () => {
  // react-query keeps isError through a refetch of a read with data.
  const polling = { ...failedWithData, isFetching: true };
  const notice = boardNotice([healthy, polling], false, summarize);
  assert.deepEqual(notice, {
    message: "Couldn't refresh some insights — showing the last loaded ones.",
    failed: [polling],
  });
  // Negative control: the settled-only predicate this replaced drops the row,
  // which is what blanked the notice on every poll.
  const settledOnly =
    polling.isError && !polling.isPaused && !polling.isFetching;
  assert.equal(settledOnly, false);
});

test("a never-loaded failed card refetching in the background still counts", () => {
  // Its refetch resets it to pending: isError is false, the error stays.
  const reset = { ...failedEmpty, isError: false, isFetching: true };
  assert.deepEqual(boardNotice([reset], false, summarize)?.failed, [reset]);
});

test("a user's Retry mutes the notice until it settles", () => {
  assert.equal(boardNotice([failedWithData], true, summarize), null);
  // Negative control: the same cards unmuted say it.
  assert.notEqual(boardNotice([failedWithData], false, summarize), null);
});

test("a recovered card leaves the notice", () => {
  const recovered = { ...failedWithData, isError: false, dataUpdatedAt: 3 };
  assert.equal(boardNotice([healthy, recovered], false, summarize), null);
  const other = boardNotice([recovered, failedEmpty], false, summarize);
  assert.deepEqual(other?.failed, [failedEmpty]);
});

test("a parked read is no failure", () => {
  const parked = { ...failedEmpty, isPaused: true };
  assert.equal(boardNotice([parked], false, summarize), null);
});

test("refresh wording needs every failed card to hold data", () => {
  assert.equal(
    boardNotice([failedWithData, failedWithData], false, summarize)?.message,
    "Couldn't refresh some insights — showing the last loaded ones.",
  );
  // One card with nothing loaded turns it into the load wording, quoting the
  // first failure in the cards' order.
  assert.equal(
    boardNotice([failedWithData, failedEmpty], false, summarize)?.message,
    "Couldn't load some insights. reason: boom",
  );
  assert.equal(
    boardNotice([healthy, failedEmpty], false, summarize)?.message,
    "Couldn't load some insights. reason: gone",
  );
});
