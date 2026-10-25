// Pins the Insights board's failure decisions
// (src/features/repository/insights/board-notice.ts): which cards count as
// loaded, what a card with no data draws, the per-card-and-window memory of
// each card's last reason, and the board's one notice line. The read states
// come from query-core 5.104.5: a refetch of a read with data keeps `isError`;
// a refetch of a never-loaded read resets it to pending (`isError` false,
// `error` null) and keeps `errorUpdatedAt`; a window toggle serves the other
// window's data as placeholder until its own read lands.
//
// Not testable here: the board's Retry token and its settle, and the live
// region announcing. Those need the live app.
//
// The imports reach straight into `src/` under Node's type stripping, so both
// modules must stay free of aliased imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshFailed } from "../src/features/conversations/remote-section-state.ts";
import {
  boardNotice,
  cardBody,
  cardErrorKey,
  cardLoaded,
  rememberCardErrors,
  unloadedCardBody,
} from "../src/features/repository/insights/board-notice.ts";

const summarize = (e) => `reason: ${e}`;
const read = (over) => ({
  data: [1],
  error: null,
  isError: false,
  isPaused: false,
  isFetching: false,
  isPlaceholderData: false,
  errorUpdatedAt: 0,
  dataUpdatedAt: 1,
  ...over,
});
const card = (r, lastError) => ({ read: r, lastError });
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
/** A never-loaded failed card mid-refetch, as fetchState leaves it. */
const resetEmpty = {
  ...failedEmpty,
  isError: false,
  error: null,
  isFetching: true,
};
/** The same, with the other window's rows as placeholder. */
const resetPlaceholder = {
  ...resetEmpty,
  data: [9],
  isPlaceholderData: true,
};

test("a failed card refetching in the background keeps the notice", () => {
  // A poll over loaded data: isError holds.
  const polling = { ...failedWithData, isFetching: true };
  const notice = boardNotice([card(healthy), card(polling)], false, summarize);
  assert.deepEqual(notice, {
    message: "Couldn't refresh some insights — showing the last loaded ones.",
    failed: [polling],
  });
  // Negative control: the settled-only predicate drops the row, which is what
  // blanked the notice on every poll.
  assert.equal(refreshFailed(polling), false);
});

test("a never-loaded card's refetch keeps the notice's text", () => {
  const before = boardNotice([card(failedEmpty, "gone")], false, summarize);
  const during = boardNotice([card(resetEmpty, "gone")], false, summarize);
  assert.equal(before?.message, "Couldn't load some insights. reason: gone");
  assert.equal(during?.message, before?.message);
  assert.deepEqual(during?.failed, [resetEmpty]);
});

test("placeholder rows from another window keep the load wording", () => {
  assert.equal(cardLoaded(resetPlaceholder), false);
  assert.equal(cardLoaded(healthy), true);
  assert.equal(
    boardNotice([card(resetPlaceholder, "gone")], false, summarize)?.message,
    "Couldn't load some insights. reason: gone",
  );
});

test("no reason known gives the bare sentence, never a quoted null", () => {
  assert.equal(
    boardNotice([card(resetEmpty)], false, summarize)?.message,
    "Couldn't load some insights.",
  );
});

test("a user's Retry mutes the notice until it settles", () => {
  assert.equal(boardNotice([card(failedWithData)], true, summarize), null);
  // Negative control: the same cards unmuted say it.
  assert.notEqual(boardNotice([card(failedWithData)], false, summarize), null);
});

test("a recovered card leaves the notice", () => {
  const recovered = { ...failedWithData, isError: false, dataUpdatedAt: 3 };
  assert.equal(
    boardNotice([card(healthy), card(recovered)], false, summarize),
    null,
  );
  const other = boardNotice(
    [card(recovered), card(failedEmpty)],
    false,
    summarize,
  );
  assert.deepEqual(other?.failed, [failedEmpty]);
});

test("a parked read is no failure", () => {
  const parked = { ...failedEmpty, isPaused: true };
  assert.equal(boardNotice([card(parked)], false, summarize), null);
});

test("refresh wording needs every failed card loaded", () => {
  assert.equal(
    boardNotice([card(failedWithData), card(failedWithData)], false, summarize)
      ?.message,
    "Couldn't refresh some insights — showing the last loaded ones.",
  );
  // One card with nothing loaded turns it into the load wording, quoting the
  // first failure in the cards' order.
  assert.equal(
    boardNotice([card(failedWithData), card(failedEmpty)], false, summarize)
      ?.message,
    "Couldn't load some insights. reason: boom",
  );
  assert.equal(
    boardNotice([card(healthy), card(failedEmpty)], false, summarize)?.message,
    "Couldn't load some insights. reason: gone",
  );
});

test("a card with no data: offline, failed, or loading", () => {
  // Parked, before or after a failure.
  assert.equal(
    unloadedCardBody({ ...failedEmpty, isPaused: true }, false),
    "offline",
  );
  assert.equal(
    unloadedCardBody(read({ data: undefined, isPaused: true }), false),
    "offline",
  );
  // Settled failure, and a background refetch over it.
  assert.equal(unloadedCardBody(failedEmpty, false), "failed");
  assert.equal(unloadedCardBody(resetEmpty, false), "failed");
  // The board's own Retry, while this card refetches.
  assert.equal(unloadedCardBody(resetEmpty, true), "loading");
  // A Retry in flight doesn't relabel a failed card that isn't refetching.
  assert.equal(unloadedCardBody(failedEmpty, true), "failed");
  // A first load.
  assert.equal(
    unloadedCardBody(read({ data: undefined, isFetching: true }), false),
    "loading",
  );
});

test("a card draws its data, a placeholder while pending, never for a failure", () => {
  assert.equal(cardBody(healthy, false), "data");
  // A failed window's own read, with another window's rows as placeholder.
  assert.equal(cardBody(resetPlaceholder, false), "failed");
  // Negative control: a pending window with no failure keeps the placeholder.
  const pendingPlaceholder = read({ data: [9], isPlaceholderData: true });
  assert.equal(cardBody(pendingPlaceholder, false), "data");
  // The board's own Retry over the failed window: the placeholder holds.
  assert.equal(cardBody(resetPlaceholder, true), "data");
  // Nothing at all: the unloaded arms.
  assert.equal(cardBody(failedEmpty, false), "failed");
  assert.equal(cardBody(read({ data: undefined }), false), "loading");
});

test("memory keys: windowed per window, hosted by id alone", () => {
  assert.equal(cardErrorKey("commitActivity", 52), "commitActivity:52");
  assert.equal(cardErrorKey("commitActivity", 0), "commitActivity:0");
  assert.equal(cardErrorKey("traffic", null), "traffic");
  assert.notEqual(
    cardErrorKey("commitActivity", 52),
    cardErrorKey("commitActivity", 0),
  );
});

const k52 = cardErrorKey("commitActivity", 52);

test("the reason memory: kept through a reset, unchanged passes keep identity", () => {
  const first = rememberCardErrors(
    {},
    "/a",
    [{ key: k52, read: failedEmpty }],
    ["/a"],
  );
  assert.deepEqual(first, { "/a": { [k52]: "gone" } });
  // A reset error (null) keeps the entry, and an unchanged pass returns the
  // same object, so storing it during render settles.
  const kept = rememberCardErrors(
    first,
    "/a",
    [{ key: k52, read: resetEmpty }],
    ["/a"],
  );
  assert.equal(kept, first);
  // A repo with nothing failed adds no entry.
  const empty = {};
  assert.equal(
    rememberCardErrors(empty, "/a", [{ key: k52, read: healthy }], ["/a"]),
    empty,
  );
});

test("a repo switch never quotes the previous repo, and switching back keeps its reason", () => {
  const inA = rememberCardErrors(
    {},
    "/a",
    [{ key: k52, read: failedEmpty }],
    ["/a"],
  );
  // Switched to /b in this render: /b's lookup has nothing of /a's.
  const inB = rememberCardErrors(
    inA,
    "/b",
    [{ key: k52, read: healthy }],
    ["/b", "/a"],
  );
  assert.equal(inB["/b"]?.[k52], undefined);
  // Back to /a, whose cached failure refetches with its error reset to null.
  const backInA = rememberCardErrors(
    inB,
    "/a",
    [{ key: k52, read: resetEmpty }],
    ["/a", "/b"],
  );
  assert.equal(
    boardNotice([card(resetEmpty, backInA["/a"]?.[k52])], false, summarize)
      ?.message,
    "Couldn't load some insights. reason: gone",
  );
  // A repo outside the kept pair is pruned.
  const inC = rememberCardErrors(backInA, "/c", [], ["/c", "/b"]);
  assert.deepEqual(Object.keys(inC), []);
});

test("a window toggle quotes that window's own reason", () => {
  const memory = rememberCardErrors(
    {},
    "/a",
    [
      {
        key: cardErrorKey("commitActivity", 52),
        read: { ...failedEmpty, error: "year" },
      },
      {
        key: cardErrorKey("commitActivity", 0),
        read: { ...failedEmpty, error: "all" },
      },
    ],
    ["/a"],
  );
  const shown = (weeks) =>
    boardNotice(
      [
        card(
          resetPlaceholder,
          memory["/a"][cardErrorKey("commitActivity", weeks)],
        ),
      ],
      false,
      summarize,
    )?.message;
  assert.equal(shown(52), "Couldn't load some insights. reason: year");
  assert.equal(shown(0), "Couldn't load some insights. reason: all");
});
