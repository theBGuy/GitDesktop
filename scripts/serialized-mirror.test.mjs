// Pins the parked-writes mirror's ordering contract (src/lib/serialized-mirror.ts):
// the backend command is async, so concurrent calls may land out of order, and the
// quit guard reads whatever landed last. The mirror must keep one push in flight,
// coalesce to the newest value, and converge on it, retrying a failure only when
// called again so a rejecting backend can't spin it.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module must
// stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import { serializedMirror } from "../src/lib/serialized-mirror.ts";

/** A push whose calls settle only when the test says so. `landed` is the
 *  backend's value, written in SETTLE order like the real async command. */
function backend() {
  const calls = [];
  const state = { landed: undefined };
  const push = (value) =>
    new Promise((resolve, reject) => {
      calls.push({
        value,
        ok() {
          state.landed = value;
          resolve();
        },
        fail() {
          reject(new Error("ipc"));
        },
      });
    });
  return { calls, state, push };
}

/** Lets the mirror's settle handlers run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a park-resume-park burst converges on parked, never on a stale resume", async () => {
  const b = backend();
  const set = serializedMirror(b.push);
  set(true);
  set(false);
  set(true);
  assert.equal(b.calls.length, 1, "one push in flight at a time");
  b.calls[0].ok();
  await flush();
  assert.equal(b.state.landed, true);
  assert.equal(b.calls.length, 1, "the newest value had already landed");
});

test("a value that changed mid-flight is pushed once the first settles", async () => {
  const b = backend();
  const set = serializedMirror(b.push);
  set(true);
  set(false);
  b.calls[0].ok();
  await flush();
  assert.deepEqual(
    b.calls.map((c) => c.value),
    [true, false],
  );
  b.calls[1].ok();
  await flush();
  assert.equal(b.state.landed, false);
});

test("a value equal to what landed sends nothing", async () => {
  const b = backend();
  const set = serializedMirror(b.push);
  set(true);
  b.calls[0].ok();
  await flush();
  set(true);
  set(true);
  assert.equal(b.calls.length, 1);
});

test("a failed push is retried by the next call, not in a loop", async () => {
  const b = backend();
  const set = serializedMirror(b.push);
  set(true);
  b.calls[0].fail();
  await flush();
  assert.equal(b.calls.length, 1, "no retry until called again");
  set(true);
  assert.equal(b.calls.length, 2, "the same value is resent after a failure");
  b.calls[1].ok();
  await flush();
  assert.equal(b.state.landed, true);
});

test("a failure with a newer value waiting pushes that value", async () => {
  const b = backend();
  const set = serializedMirror(b.push);
  set(true);
  set(false);
  b.calls[0].fail();
  await flush();
  assert.deepEqual(
    b.calls.map((c) => c.value),
    [true, false],
  );
});

test("a synchronous throw settles as a failure instead of wedging the mirror", async () => {
  let throws = true;
  const sent = [];
  const set = serializedMirror((value) => {
    sent.push(value);
    if (throws) throw new Error("no transport");
    return Promise.resolve();
  });
  set(true);
  await flush();
  throws = false;
  set(true);
  await flush();
  assert.deepEqual(sent, [true, true]);
});
