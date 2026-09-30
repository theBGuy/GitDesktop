// Pins which queries the app-wide offline park refetches (src/lib/query-client.ts)
// the moment the OS reports no connection. The contract under test: a settled
// error over retained data parks, so the notice ladders speak of the outage
// instead of offering a Retry that would only park again; a query with no data,
// one whose network mode would really run, and one already fetching stay put.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so both modules
// must stay free of runtime imports (type-only imports are erased).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parkedUnlessPermanent,
  resolveRemoteSection,
} from "../src/features/conversations/remote-section-state.ts";
import { shouldParkOnOffline } from "../src/lib/offline-park.ts";

const ROWS = [{ number: 1 }];

/** A query as react-query holds it; `data` stays ROWS unless the caller names
 *  it, `undefined` included (a destructuring default would swallow that). */
function query(overrides = {}) {
  const { status = "error", fetchStatus = "idle", networkMode } = overrides;
  const data = "data" in overrides ? overrides.data : ROWS;
  return {
    state: { status, fetchStatus, data },
    options: networkMode === undefined ? {} : { networkMode },
  };
}

test("each query shape parks or stays put (table)", () => {
  const table = [
    ["errored with data, default mode", query(), true],
    ["errored with data, online mode", query({ networkMode: "online" }), true],
    ["errored with no data", query({ data: undefined }), false],
    ["errored, always mode", query({ networkMode: "always" }), false],
    [
      "errored, offlineFirst mode",
      query({ networkMode: "offlineFirst" }),
      false,
    ],
    ["errored, fetch in flight", query({ fetchStatus: "fetching" }), false],
    ["errored, already parked", query({ fetchStatus: "paused" }), false],
    ["healthy with data", query({ status: "success" }), false],
    [
      "pending first load",
      query({ status: "pending", data: undefined }),
      false,
    ],
    // A loaded empty answer is still data: `[]` and `null` are not undefined.
    ["errored over an empty list", query({ data: [] }), true],
    ["errored over a null payload", query({ data: null }), true],
  ];
  for (const [name, q, parks] of table)
    assert.equal(shouldParkOnOffline(q), parks, name);
});

test("a permanent verdict with data parks and keeps its verdict", () => {
  const error = { kind: "issuesDisabled", message: "" };
  // The predicate reads no error kind: the refetch keeps error and data.
  assert.equal(shouldParkOnOffline(query()), true);
  // After the park react-query reports isError AND isPaused over the retained
  // data; the list call sites feed the ladder parkedUnlessPermanent.
  const paused = parkedUnlessPermanent({ isPaused: true, error });
  assert.equal(paused, false);
  const section = (rowCount) =>
    resolveRemoteSection({
      ghPending: false,
      ghReady: true,
      listPending: false,
      error: true,
      rowCount,
      paused,
    });
  assert.equal(section(0), "error");
  assert.equal(section(3), "rows-degraded");
  // Negative control: a transient failure parked the same way reads offline.
  const transient = parkedUnlessPermanent({
    isPaused: true,
    error: { kind: "io", message: "" },
  });
  assert.equal(transient, true);
  assert.equal(
    resolveRemoteSection({
      ghPending: false,
      ghReady: true,
      listPending: false,
      error: true,
      rowCount: 3,
      paused: transient,
    }),
    "rows-offline",
  );
});
