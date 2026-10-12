// Pins the merge strip's arm ladder (src/features/pulls/merge-strip-arm.ts):
// an open PR always gets one line, each rung waits only on its OWN read (so a
// known conflict shows at once, offline too), and the waiting line blames the
// connection only for a forge read, which parks.
//
// Not testable here: how the view gates each read and what the banner draws for
// an arm. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeStripArm,
  PREVIEW_NO_CONFLICT,
} from "../src/features/pulls/merge-strip-arm.ts";

/** A forge read in flight with nothing to show. */
const loading = () => ({ data: undefined, isFetching: true });

/** An open, online, clean PR with every read answered; each test overrides
 *  what it is about. */
function inputs(over = {}) {
  return {
    isOpen: true,
    offline: false,
    mergeability: {
      data: { state: "mergeable" },
      isFetching: false,
      isError: false,
      polling: false,
    },
    preview: { enabled: false, isPending: false, data: undefined },
    resolve: { enabled: true, isPending: false, found: false },
    updating: false,
    blocked: false,
    divergence: { enabled: true, data: { behindBy: 0 }, isFetching: false },
    behindBy: 0,
    ...over,
  };
}

/** Every read below the forge's mergeability answer still loading. */
const lowerReadsPending = {
  preview: { enabled: true, isPending: true, data: undefined },
  resolve: { enabled: true, isPending: true, found: false },
  divergence: { enabled: true, ...loading() },
};

test("a cached conflicting answer wins while the lower reads are pending", () => {
  const r = mergeStripArm(
    inputs({
      mergeability: {
        data: { state: "conflicting" },
        isFetching: false,
        isError: false,
        polling: false,
      },
      ...lowerReadsPending,
    }),
  );
  assert.deepEqual(r, { arm: "conflicting", pendingOffline: false });
});

test("a cached conflict shows offline too", () => {
  const r = mergeStripArm(
    inputs({
      offline: true,
      mergeability: {
        data: { state: "conflicting" },
        isFetching: false,
        isError: false,
        polling: false,
      },
      ...lowerReadsPending,
    }),
  );
  assert.equal(r.arm, "conflicting");
});

test("offline with no mergeability answer waits, blaming the connection", () => {
  const r = mergeStripArm(
    inputs({
      offline: true,
      mergeability: {
        data: undefined,
        isFetching: false,
        isError: false,
        polling: false,
      },
    }),
  );
  assert.deepEqual(r, { arm: "pending", pendingOffline: true });
});

test("offline with only the local preview pending waits without blaming the connection", () => {
  const r = mergeStripArm(
    inputs({
      offline: true,
      mergeability: {
        data: { state: "unavailable" },
        isFetching: false,
        isError: false,
        polling: false,
      },
      preview: { enabled: true, isPending: true, data: undefined },
    }),
  );
  assert.deepEqual(r, { arm: "pending", pendingOffline: false });
});

test("a still-computing answer waits while the poll climbs, then reads unknown", () => {
  const checking = (polling) => ({
    data: { state: "checking" },
    isFetching: false,
    isError: false,
    polling,
  });
  assert.equal(
    mergeStripArm(inputs({ mergeability: checking(true) })).arm,
    "pending",
  );
  assert.equal(
    mergeStripArm(inputs({ mergeability: checking(false) })).arm,
    "unknown",
  );
});

test("a running update outranks the still-computing answer it causes", () => {
  const r = mergeStripArm(
    inputs({
      updating: true,
      mergeability: {
        data: { state: "checking" },
        isFetching: false,
        isError: false,
        polling: true,
      },
    }),
  );
  assert.equal(r.arm, "updating");
});

test("the base's rules outrank a base that has only moved on", () => {
  // The default mergeability is a settled "mergeable" answer, which BLOCKED rides.
  const r = mergeStripArm(inputs({ blocked: true, behindBy: 3 }));
  assert.equal(r.arm, "blocked");
});

test("mergeable reads clean, and so does a clean local prediction", () => {
  assert.equal(mergeStripArm(inputs()).arm, "clean");
  for (const status of PREVIEW_NO_CONFLICT) {
    const r = mergeStripArm(
      inputs({
        mergeability: {
          data: { state: "unavailable" },
          isFetching: false,
          isError: false,
          polling: false,
        },
        preview: { enabled: true, isPending: false, data: { status } },
      }),
    );
    assert.equal(r.arm, "clean", status);
  }
});

test("a predicted conflict where the forge has none to give", () => {
  const r = mergeStripArm(
    inputs({
      mergeability: {
        data: { state: "unavailable" },
        isFetching: false,
        isError: false,
        polling: false,
      },
      preview: {
        enabled: true,
        isPending: false,
        data: { status: "conflict" },
      },
    }),
  );
  assert.equal(r.arm, "predicted");
});

test("no answer anywhere reads unchecked", () => {
  const r = mergeStripArm(
    inputs({
      mergeability: {
        data: { state: "unavailable" },
        isFetching: false,
        isError: false,
        polling: false,
      },
      preview: { enabled: false, isPending: false, data: undefined },
      divergence: { enabled: false, data: undefined, isFetching: false },
    }),
  );
  assert.equal(r.arm, "unchecked");
});

test("a closed or merged PR has no line", () => {
  assert.deepEqual(mergeStripArm(inputs({ isOpen: false })), {
    arm: null,
    pendingOffline: false,
  });
});

test("behind waits for the divergence read, then shows", () => {
  assert.equal(
    mergeStripArm(inputs({ divergence: { enabled: true, ...loading() } })).arm,
    "pending",
  );
  assert.equal(mergeStripArm(inputs({ behindBy: 3 })).arm, "behind");
});

// Negative control: a ladder that waits on EVERY pending read before deciding
// (the rule this one replaced) must give a different answer for the cached
// conflict above, or the first test isn't pinning the rung order.
test("negative control: waiting on lower-ranked reads hides a known conflict", () => {
  const waitsOnAll = (input) => {
    const anyPending =
      (input.preview.enabled && input.preview.isPending) ||
      (input.resolve.enabled && input.resolve.isPending) ||
      (input.divergence.enabled &&
        input.divergence.data === undefined &&
        input.divergence.isFetching);
    return anyPending ? "pending" : mergeStripArm(input).arm;
  };
  const cachedConflict = inputs({
    mergeability: {
      data: { state: "conflicting" },
      isFetching: false,
      isError: false,
      polling: false,
    },
    ...lowerReadsPending,
  });
  assert.equal(waitsOnAll(cachedConflict), "pending");
  assert.notEqual(
    waitsOnAll(cachedConflict),
    mergeStripArm(cachedConflict).arm,
  );
});
