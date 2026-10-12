// Pins the detail views' switch hold (src/lib/entity-hold.ts): the old item
// stays painted for at most the bound from the hold's START, then the target
// shows, and the old item never comes back; offline and hidden-tab moves never
// hold; and the two-slot helper keyed hosts read. The clock-driven pieces are
// driven here the way useEntityHold drives them: a render applies
// `stepEntityHold`, then the layout effect stamps or expires against `now`.
//
// Not testable here: the hook's timer and effect remounts under <Activity>,
// what `inert` blocks, and HeldFrame's focus rescue. Those need the live app.
//
// The imports reach straight into `src/` under Node's type stripping, so both
// modules must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_BOUND_MS } from "../src/features/diff/diff-pane-slots.ts";
import {
  ENTITY_HOLD_BOUND_MS,
  entityHoldPhase,
  entityHoldSlots,
  entityKeyNumber,
  entityKeyScope,
  expireEntityHold,
  isEntityHolding,
  REVEAL_HIDDEN,
  revealCommit,
  revealGuard,
  stampEntityHold,
  startEntityHold,
  stepEntityHold,
} from "../src/lib/entity-hold.ts";

/** One move's inputs; the defaults are a visible, online, holdable, loading
 *  target. */
function input(key, over = {}) {
  return {
    key,
    settled: false,
    canHold: true,
    paused: false,
    active: true,
    ...over,
  };
}

/** A render at `now`: the render-time step, then the hook's layout effect
 *  (stamp an unstamped hold, expire a due one). */
function render(hold, inp, now) {
  let next = stepEntityHold(hold, inp);
  if (isEntityHolding(next)) {
    next =
      next.since === null
        ? stampEntityHold(next, now)
        : expireEntityHold(next, now);
  }
  return next;
}

const settledA = () => startEntityHold("A", true);

test("the bound matches the diff pane's", () => {
  assert.equal(ENTITY_HOLD_BOUND_MS, 400);
  assert.equal(ENTITY_HOLD_BOUND_MS, HOLD_BOUND_MS);
});

test("a move away from a settled item holds it", () => {
  const h = render(settledA(), input("B"), 0);
  assert.equal(isEntityHolding(h), true);
  assert.equal(h.shown, "A");
  assert.equal(h.target, "B");
  assert.equal(h.since, 0);
  assert.equal(entityHoldPhase(h, false), "holding");
});

test("an unchanged render returns the same object", () => {
  const a = settledA();
  assert.equal(stepEntityHold(a, input("A", { settled: true })), a);
  const h = render(a, input("B"), 0);
  assert.equal(stepEntityHold(h, input("B")), h);
});

test("A -> B -> C -> D within the bound expires 400 ms after A's departure", () => {
  let h = render(settledA(), input("B"), 1000);
  h = render(h, input("C"), 1150);
  h = render(h, input("D"), 1300);
  assert.equal(h.shown, "A");
  assert.equal(h.target, "D");
  assert.equal(h.since, 1000, "a retarget keeps the hold's start");
  h = render(h, input("D"), 1399);
  assert.equal(entityHoldPhase(h, false), "holding");
  h = render(h, input("D"), 1400);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "D");
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("after expiry the state never yields the held item again", () => {
  let h = render(settledA(), input("B"), 0);
  h = render(h, input("B"), 400);
  assert.equal(entityHoldPhase(h, false), "loading");
  const seen = [];
  const moves = [
    input("C"),
    input("D"),
    input("E", { settled: true }),
    input("F"),
  ];
  // C and D land before anything settles; E arrives cached; F holds over E.
  let now = 450;
  for (const m of moves) {
    h = render(h, m, now);
    seen.push(h.shown, h.target, h.shown === "A" || h.target === "A");
    now += 50;
  }
  assert.equal(seen.includes("A"), false);
  assert.equal(seen.includes(true), false);
  // B loading, then C: no hold over an item with no answer of its own.
  assert.equal(seen[0], "C");
  assert.equal(seen[3], "D");
  assert.equal(seen[6], "E");
  // E settled, so F holds over E, never A.
  assert.equal(h.shown, "E");
  assert.equal(h.target, "F");
});

test("the target settling promotes it at once", () => {
  let h = render(settledA(), input("B"), 0);
  h = render(h, input("B", { settled: true }), 50);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  assert.equal(h.since, null);
  assert.equal(entityHoldPhase(h, false), "shown");
});

test("moving back to the held item mid-hold ends the hold there", () => {
  let h = render(settledA(), input("B"), 0);
  h = render(h, input("C"), 100);
  h = render(h, input("A", { settled: true }), 200);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "A");
  assert.equal(entityHoldPhase(h, false), "shown");
  // A later move starts a fresh hold with a fresh start.
  h = render(h, input("D"), 300);
  assert.equal(h.since, 300);
  assert.deepEqual(entityHoldSlots(h), [
    { key: "A", role: "held" },
    { key: "D", role: "preparing" },
  ]);
});

test("an unsettled shown item is replaced outright", () => {
  // First open, still loading: the next move shows directly.
  let h = startEntityHold("A", false);
  assert.equal(entityHoldPhase(h, false), "loading");
  h = render(h, input("B"), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("a key the host can't hold over shows directly", () => {
  const h = render(settledA(), input("B", { canHold: false }), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  // ...and a mid-hold move to one does too.
  let g = render(settledA(), input("B"), 0);
  g = render(g, input("X", { canHold: false }), 100);
  assert.equal(isEntityHolding(g), false);
  assert.equal(g.shown, "X");
});

test("a cached target shows directly", () => {
  const h = render(settledA(), input("B", { settled: true }), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(entityHoldPhase(h, false), "shown");
});

test("a paused target never holds and reads offline, not loading", () => {
  let h = render(settledA(), input("B", { paused: true }), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(entityHoldPhase(h, true), "offline");
  // Far past the bound, still offline: a paused target never expires into
  // loading.
  h = render(h, input("B", { paused: true }), 5000);
  assert.equal(entityHoldPhase(h, true), "offline");
  // The pause ends: normal rules resume.
  h = render(h, input("B"), 5100);
  assert.equal(entityHoldPhase(h, false), "loading");
  h = render(h, input("B", { settled: true }), 5200);
  assert.equal(entityHoldPhase(h, false), "shown");
  h = render(h, input("C"), 5300);
  assert.equal(entityHoldPhase(h, false), "holding");
});

test("a target that pauses mid-hold ends the hold onto the offline arm", () => {
  let h = render(settledA(), input("B"), 0);
  h = render(h, input("B", { paused: true }), 100);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  assert.equal(entityHoldPhase(h, true), "offline");
  h = render(h, input("B"), 200);
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("a move made while the tab is hidden shows directly", () => {
  let h = render(settledA(), input("B", { active: false }), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  // The tab returns before B lands: B loading, never A held.
  h = render(h, input("B"), 1000);
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("a hold whose bound passed while hidden expires on the first render after show", () => {
  let h = render(settledA(), input("B"), 0);
  // Hidden renders run no effects (<Activity> tears them down): steps only.
  h = stepEntityHold(h, input("B", { active: false }));
  h = stepEntityHold(h, input("B", { active: false }));
  assert.equal(isEntityHolding(h), true);
  // First render after show, 600 ms on: the timestamp alone expires it.
  h = render(h, input("B"), 600);
  assert.equal(isEntityHolding(h), false);
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("a hold still inside its bound on show keeps holding", () => {
  let h = render(settledA(), input("B"), 0);
  h = stepEntityHold(h, input("B", { active: false }));
  h = render(h, input("B"), 300);
  assert.equal(entityHoldPhase(h, false), "holding");
  h = render(h, input("B"), 400);
  assert.equal(entityHoldPhase(h, false), "loading");
});

test("an unstamped or ended hold never expires", () => {
  const unstamped = stepEntityHold(settledA(), input("B"));
  assert.equal(unstamped.since, null);
  assert.equal(expireEntityHold(unstamped, 1e9), unstamped);
  const a = settledA();
  assert.equal(expireEntityHold(a, 1e9), a);
  assert.equal(stampEntityHold(a, 5), a);
  // A stamp never moves an existing start.
  const h = stampEntityHold(unstamped, 10);
  assert.equal(stampEntityHold(h, 20), h);
});

test("the two-slot helper renders held + preparing, then the shown target", () => {
  const a = settledA();
  assert.deepEqual(entityHoldSlots(a), [{ key: "A", role: "shown" }]);
  let h = render(a, input("B"), 0);
  assert.deepEqual(entityHoldSlots(h), [
    { key: "A", role: "held" },
    { key: "B", role: "preparing" },
  ]);
  h = render(h, input("C"), 100);
  assert.deepEqual(entityHoldSlots(h), [
    { key: "A", role: "held" },
    { key: "C", role: "preparing" },
  ]);
  h = render(h, input("C"), 400);
  assert.deepEqual(entityHoldSlots(h), [{ key: "C", role: "shown" }]);
});

// ---------------------------------------------------------------- reveal guard

/** One render of the guard, then its commit (the hook's layout effect). */
function reveal(last, inp) {
  const guard = revealGuard(last, inp);
  return { guard, last: revealCommit(last, inp.visible, guard.revealing) };
}

/** A visible, painted commit: the steady in-tab state. */
const seen = () => revealCommit(REVEAL_HIDDEN, true, false);

test("a reveal with a lagging view paints the reveal frame, then the new item directly", () => {
  // Hidden on A; a navigator reveals the tab and selects B in one update, the
  // deferred view still on A.
  let r = reveal(REVEAL_HIDDEN, {
    visible: true,
    liveKey: "B",
    viewKey: "A",
    shownKey: "A",
  });
  assert.equal(r.guard.revealing, true);
  assert.equal(r.guard.active, false);
  // The extra render after that commit: still lagging, still revealing.
  r = reveal(r.last, {
    visible: true,
    liveKey: "B",
    viewKey: "A",
    shownKey: "A",
  });
  assert.equal(r.guard.revealing, true);
  assert.equal(r.guard.active, false);
  // The deferred view catches up: no reveal frame, and active stays false, so
  // the hold step shows B directly instead of holding A.
  r = reveal(r.last, {
    visible: true,
    liveKey: "B",
    viewKey: "B",
    shownKey: "A",
  });
  assert.equal(r.guard.active, false);
  const h = stepEntityHold(
    startEntityHold("A", true),
    input("B", { active: r.guard.active }),
  );
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
  // That render's frame is B's, not a reveal frame...
  r = reveal(r.last, {
    visible: true,
    liveKey: "B",
    viewKey: "B",
    shownKey: "B",
  });
  assert.equal(r.guard.revealing, false);
  // ...so from the next commit on, in-tab moves hold again.
  r = reveal(r.last, {
    visible: true,
    liveKey: "C",
    viewKey: "B",
    shownKey: "B",
  });
  assert.equal(r.guard.active, true);
  assert.equal(r.guard.revealing, false);
});

test("an in-tab move is active and never a reveal, even while the view lags", () => {
  const { guard, last } = reveal(seen(), {
    visible: true,
    liveKey: "B",
    viewKey: "A",
    shownKey: "A",
  });
  assert.deepEqual(guard, { revealing: false, active: true });
  assert.equal(last, revealCommit(last, true, false), "facts unchanged");
  const h = render(settledA(), input("B", { active: guard.active }), 0);
  assert.equal(isEntityHolding(h), true);
});

test("a reveal with no selection change is no reveal frame, and active from the next commit", () => {
  let r = reveal(REVEAL_HIDDEN, {
    visible: true,
    liveKey: "A",
    viewKey: "A",
    shownKey: "A",
  });
  assert.deepEqual(r.guard, { revealing: false, active: false });
  r = reveal(r.last, {
    visible: true,
    liveKey: "A",
    viewKey: "A",
    shownKey: "A",
  });
  assert.deepEqual(r.guard, { revealing: false, active: true });
});

test("a selection change while the tab is hidden never holds", () => {
  // The render that hides the tab also moves the selection: still inactive.
  const { guard } = reveal(seen(), {
    visible: false,
    liveKey: "B",
    viewKey: "B",
    shownKey: "A",
  });
  assert.deepEqual(guard, { revealing: false, active: false });
  const h = render(settledA(), input("B", { active: guard.active }), 0);
  assert.equal(isEntityHolding(h), false);
  assert.equal(h.shown, "B");
});

test("arriving while a hold keeps another item paints the reveal frame", () => {
  const { guard } = reveal(REVEAL_HIDDEN, {
    visible: true,
    liveKey: "B",
    viewKey: "B",
    shownKey: "A",
  });
  assert.equal(guard.revealing, true);
});

test("a key reads its number after the LAST #, and its scope up to it", () => {
  const key = "C:/repos/a#b#origin#48";
  assert.equal(entityKeyNumber(key), 48);
  assert.equal(entityKeyScope(key), "C:/repos/a#b#origin#");
});

test("keys share a scope only within one repo and lens", () => {
  assert.equal(entityKeyScope("/r#origin#7"), entityKeyScope("/r#origin#48"));
  assert.notEqual(
    entityKeyScope("/r#origin#7"),
    entityKeyScope("/r#upstream#7"),
  );
  assert.notEqual(entityKeyScope("/r#origin#7"), entityKeyScope("/s#origin#7"));
});
