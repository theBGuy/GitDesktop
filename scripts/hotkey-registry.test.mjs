// Pins the live hotkey-handler registry (src/lib/hotkeys/handler-registry.ts):
// the newest ENABLED registration answers an action and disabled ones fall
// through (the contract modal-gate.ts leans on), an unregister removes only its
// own entry, a disabled-only registration still OWNS the chord without running
// anything, and the palette's availability snapshot changes identity exactly when
// the registry does.
//
// Not testable here: WHEN `useHotkeyAction` registers relative to React's commit
// (layout vs passive effects). That timing is a property of React's scheduler and
// needs a live app; this file pins only what the registry does once called.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module must
// stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatchAction,
  getAvailableSnapshot,
  hasLiveHandler,
  registerHandler,
  subscribe,
  unregisterHandler,
} from "../src/lib/hotkeys/handler-registry.ts";

/** An entry that records its own runs into `log` under `name`. */
function entry(log, name, enabled = true) {
  return { run: () => log.push(name), enabled };
}

test("the newest enabled registration runs", () => {
  const log = [];
  const older = entry(log, "older");
  const newer = entry(log, "newer");
  registerHandler("t-newest", older);
  registerHandler("t-newest", newer);
  assert.equal(dispatchAction("t-newest"), true);
  assert.deepEqual(log, ["newer"]);
  unregisterHandler("t-newest", newer);
  unregisterHandler("t-newest", older);
});

test("a disabled newer registration falls through to an enabled older one", () => {
  const log = [];
  const older = entry(log, "older");
  const newer = entry(log, "newer", false);
  registerHandler("t-fall", older);
  registerHandler("t-fall", newer);
  assert.equal(dispatchAction("t-fall"), true);
  assert.deepEqual(log, ["older"]);
  unregisterHandler("t-fall", newer);
  unregisterHandler("t-fall", older);
});

test("unregister removes exactly its own entry", () => {
  const log = [];
  const first = entry(log, "first");
  const second = entry(log, "second");
  registerHandler("t-own", first);
  registerHandler("t-own", second);
  unregisterHandler("t-own", second);
  assert.equal(dispatchAction("t-own"), true);
  assert.deepEqual(log, ["first"], "the other entry stays");
  // Removing an entry that is already gone touches nothing else.
  unregisterHandler("t-own", second);
  assert.equal(hasLiveHandler("t-own"), true);
  unregisterHandler("t-own", first);
  assert.equal(hasLiveHandler("t-own"), false);
  assert.equal(dispatchAction("t-own"), false);
});

test("nothing runs when no registration is enabled", () => {
  assert.equal(dispatchAction("t-none"), false, "never registered");
  assert.equal(hasLiveHandler("t-none"), false);
});

test("a disabled-only registration owns the chord but runs nothing", () => {
  const log = [];
  const disabled = entry(log, "disabled", false);
  registerHandler("t-owned", disabled);
  assert.equal(hasLiveHandler("t-owned"), true);
  assert.equal(dispatchAction("t-owned"), false);
  assert.deepEqual(log, []);
  assert.equal(getAvailableSnapshot().has("t-owned"), false);
  unregisterHandler("t-owned", disabled);
});

test("the availability snapshot changes identity only with the registry", () => {
  let notified = 0;
  const unsubscribe = subscribe(() => {
    notified += 1;
  });
  const before = getAvailableSnapshot();
  assert.equal(getAvailableSnapshot(), before, "stable with no change");
  dispatchAction("t-snap");
  assert.equal(getAvailableSnapshot(), before, "a dispatch changes nothing");

  const live = entry([], "live");
  registerHandler("t-snap", live);
  const registered = getAvailableSnapshot();
  assert.notEqual(registered, before, "register rebuilds it");
  assert.equal(registered.has("t-snap"), true);
  assert.equal(getAvailableSnapshot(), registered, "stable after rebuild");

  unregisterHandler("t-snap", live);
  const unregistered = getAvailableSnapshot();
  assert.notEqual(unregistered, registered, "unregister rebuilds it");
  assert.equal(unregistered.has("t-snap"), false);
  assert.equal(notified, 2, "one notification per registry change");

  unsubscribe();
  registerHandler("t-snap", live);
  assert.equal(notified, 2, "an unsubscribed listener hears nothing");
  unregisterHandler("t-snap", live);
});
