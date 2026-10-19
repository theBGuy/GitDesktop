// Pins how one streaming agent-CLI run settles (src/lib/ai/stream-settle.ts):
// the per-run settle machine runCliStream drives, and the channel gate that
// runAgentReview / runAgentSession put between the Tauri channel, the command's
// return value, and the caller's onEvent. A run settles exactly once, on a real
// terminal event; a return without one is incomplete unless a cancel was asked
// for; a returned terminal waits (bounded) for the channel's own copy so late
// deltas still land in order.
//
// Not testable here: the real Channel's index ordering and its async-fetch
// delivery of large payloads, and what each store does with the outcome.
// Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of `@/` aliases and runtime tauri imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as settleModule from "../src/lib/ai/stream-settle.ts";

const { createCliSettle } = settleModule;

/** The owner's cut-off record: the run's last delta ends mid-word. */
const CUT_DELTAS = [
  "Checking the save-transfer fix…",
  "\n\n",
  "### Report\n…body…\n\nI also re",
];
const FINAL = "### Report\n…body…\n\nI also reviewed X.";

const delta = (text) => ({ kind: "delta", text });
const done = (text, over = {}) => ({
  kind: "done",
  text,
  isError: false,
  costUsd: null,
  ...over,
});
const error = (message, over = {}) => ({
  kind: "error",
  message,
  partialText: null,
  timedOut: false,
  ...over,
});

/** A settle machine recording every text and status it pushes. */
function harness() {
  const texts = [];
  const statuses = [];
  const run = createCliSettle({
    setText: (t) => texts.push(t),
    setStatus: (s) => statuses.push(s),
  });
  return { run, texts, statuses };
}

/** Lets pending promise callbacks and one macrotask run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a bare return without a terminal is incomplete, never a finished review", () => {
  const { run, texts } = harness();
  for (const d of CUT_DELTAS) assert.equal(run.onEvent(delta(d)), null);
  assert.deepEqual(run.finish(null, false), { kind: "incomplete" });
  // The cut text stays in setText so the caller's error record keeps it.
  assert.equal(texts.at(-1), CUT_DELTAS.join(""));
  // Settled: nothing re-settles it.
  assert.equal(run.finish(null, true), null);
  assert.equal(run.onEvent(done(FINAL)), null);
});

test("a terminal carried only by the return settles as done", () => {
  // Mismatched buffer: the cut stream is not a suffix of the final answer's
  // text, so nothing is peeled as narration.
  const cut = harness();
  for (const d of CUT_DELTAS) cut.run.onEvent(delta(d));
  assert.deepEqual(cut.run.finish(done(FINAL, { costUsd: 0.5 }), false), {
    kind: "done",
    costUsd: 0.5,
    thoughts: "",
  });
  assert.equal(cut.texts.at(-1), FINAL);

  // Matched buffer: the final answer streamed after the narration, so the
  // narration is peeled off as thoughts.
  const whole = harness();
  for (const d of ["Checking the save-transfer fix…", "\n\n", FINAL]) {
    whole.run.onEvent(delta(d));
  }
  assert.deepEqual(whole.run.finish(done(FINAL, { costUsd: 0.5 }), false), {
    kind: "done",
    costUsd: 0.5,
    thoughts: "Checking the save-transfer fix…",
  });
  assert.equal(whole.texts.at(-1), FINAL);
});

test("a cancelled bare return resolves, keeping the buffer as-is", () => {
  const { run, texts } = harness();
  for (const d of CUT_DELTAS) run.onEvent(delta(d));
  assert.deepEqual(run.finish(null, true), { kind: "cancelled" });
  assert.equal(texts.at(-1), CUT_DELTAS.join(""));
  // No predicate supplied: the backend mints a bare return only on cancel.
  const trusting = harness();
  trusting.run.onEvent(delta("partial"));
  assert.deepEqual(trusting.run.finish(null), { kind: "cancelled" });
});

test("events after the terminal are no-ops", () => {
  const { run, texts, statuses } = harness();
  run.onEvent(delta("Let me check.\n\n"));
  run.onEvent(delta(FINAL));
  assert.deepEqual(run.onEvent(done(FINAL)), {
    kind: "done",
    costUsd: null,
    thoughts: "Let me check.",
  });
  const settledTexts = texts.length;
  assert.equal(run.onEvent(delta(" trailing")), null);
  assert.equal(run.onEvent({ kind: "status", text: "late" }), null);
  assert.equal(run.onEvent(done("a second terminal")), null);
  assert.equal(run.onEvent(error("and an error")), null);
  assert.equal(run.finish(done(FINAL), false), null);
  assert.equal(texts.length, settledTexts);
  assert.equal(texts.at(-1), FINAL);
  assert.deepEqual(statuses, []);
});

test("an errored done fails with its error-shaped text as the reason", () => {
  const { run, texts } = harness();
  run.onEvent(delta("Half a review"));
  assert.deepEqual(
    run.onEvent(
      done("Claude AI usage limit reached", { isError: true, costUsd: 0.1 }),
    ),
    {
      kind: "failed",
      message: "Claude AI usage limit reached",
      timedOut: false,
      costUsd: 0.1,
    },
  );
  // The streamed text is kept; the error text never replaces it.
  assert.equal(texts.at(-1), "Half a review");
  // Run output in the terminal text is not a reason: the fallback copy is.
  const body = harness();
  assert.equal(
    body.run.onEvent(done("Para one.\n\nPara two.", { isError: true })).message,
    "The run ended with an error.",
  );
});

test("an error adopts partialText only when nothing streamed, and carries timedOut", () => {
  const quiet = harness();
  assert.deepEqual(
    quiet.run.onEvent(
      error("timed out", { partialText: "codex body", timedOut: true }),
    ),
    { kind: "failed", message: "timed out", timedOut: true },
  );
  assert.deepEqual(quiet.texts, ["codex body"]);

  const streamed = harness();
  streamed.run.onEvent(delta("streamed"));
  streamed.run.onEvent(error("boom", { partialText: "codex body" }));
  assert.deepEqual(streamed.texts, ["streamed"]);
});

test("status and tool events drive the status line", () => {
  const { run, statuses } = harness();
  run.onEvent({ kind: "status", text: "Preparing…" });
  run.onEvent({ kind: "tool", tool: "read", target: " src/a.ts " });
  run.onEvent({ kind: "tool", tool: "search", target: null });
  run.onEvent({ kind: "nativeSession", id: "ses_1" });
  assert.deepEqual(statuses, ["Preparing…", "Reading src/a.ts…", "Searching…"]);
});

test("gate: a returned terminal waits for the channel's own, keeping late deltas in order", async () => {
  const { createChannelGate } = settleModule;
  const { run, texts } = harness();
  const outcomes = [];
  const delivered = [];
  const gate = createChannelGate({
    boundMs: 10_000,
    deliver: (event) => {
      delivered.push(event);
      const outcome = run.onEvent(event);
      if (outcome) outcomes.push(outcome);
    },
  });
  gate.onMessage(delta("Let me check.\n\n"));
  // The invoke resolves while the channel still owes a large delta and its
  // own Done (a payload past tauri's 8 KiB inline limit rides an async fetch).
  const returned = done(FINAL, { costUsd: 0.5 });
  const finished = gate.finish(returned);
  await tick();
  const large = delta(FINAL.repeat(400));
  const channelDone = done(FINAL.repeat(400), { costUsd: 0.5 });
  gate.onMessage(large);
  gate.onMessage(channelDone);
  await finished;
  assert.equal(delivered.length, 3);
  assert.equal(delivered[1], large);
  assert.equal(delivered[2], channelDone);
  assert.ok(!delivered.includes(returned), "the returned copy is not replayed");
  // The late delta landed before the Done, so the narration still peels.
  assert.deepEqual(outcomes, [
    { kind: "done", costUsd: 0.5, thoughts: "Let me check." },
  ]);
  assert.equal(texts.at(-1), FINAL.repeat(400));
});

test("gate: when the bound elapses the returned terminal is replayed, and a later channel terminal is dropped", async () => {
  const { createChannelGate } = settleModule;
  const delivered = [];
  const gate = createChannelGate({
    boundMs: 20,
    deliver: (event) => delivered.push(event),
  });
  gate.onMessage(delta("partial"));
  const returned = done(FINAL);
  let finished = false;
  const settledP = gate.finish(returned).then(() => {
    finished = true;
  });
  await tick();
  assert.equal(finished, false, "the gate waits the bound first");
  await settledP;
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1], returned);
  gate.onMessage(delta("late"));
  gate.onMessage(done(FINAL));
  assert.equal(delivered.length, 2, "nothing re-settles after the replay");
});

test("gate: a null return settles at once, with no bound wait", async () => {
  const { createChannelGate } = settleModule;
  const delivered = [];
  const gate = createChannelGate({
    boundMs: 10_000,
    deliver: (event) => delivered.push(event),
  });
  gate.onMessage(delta("partial"));
  const order = [];
  const finished = gate.finish(null).then(() => order.push("finished"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  order.push("first timer");
  await finished;
  assert.deepEqual(order, ["finished", "first timer"]);
  assert.equal(delivered.length, 1);
});

test("gate: settles only after the waited channel terminal is delivered", async () => {
  const { createChannelGate } = settleModule;
  const log = [];
  const gate = createChannelGate({
    boundMs: 10_000,
    deliver: (event) => log.push(event.kind),
  });
  const finished = gate.finish(done(FINAL)).then(() => log.push("settled"));
  await tick();
  assert.deepEqual(log, []);
  gate.onMessage(delta("tail"));
  await tick();
  assert.deepEqual(log, ["delta"]);
  gate.onMessage(done(FINAL));
  await finished;
  assert.deepEqual(log, ["delta", "done", "settled"]);
});

test("gate: events after a channel terminal are dropped, and a later return settles at once", async () => {
  const { createChannelGate } = settleModule;
  const delivered = [];
  const gate = createChannelGate({
    boundMs: 10_000,
    deliver: (event) => delivered.push(event),
  });
  const first = error("boom");
  gate.onMessage(first);
  gate.onMessage(delta("late"));
  gate.onMessage(done("turn.failed after error"));
  const order = [];
  const finished = gate.finish(done(FINAL)).then(() => order.push("finished"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  order.push("first timer");
  await finished;
  assert.deepEqual(delivered, [first]);
  assert.deepEqual(order, ["finished", "first timer"]);
});

test("gate: the latch is set before a throwing consumer runs", async () => {
  const { createChannelGate } = settleModule;
  const delivered = [];
  const gate = createChannelGate({
    boundMs: 10_000,
    deliver: (event) => {
      delivered.push(event);
      if (event.kind === "done") throw new Error("consumer bug");
    },
  });
  assert.throws(() => gate.onMessage(done(FINAL)), /consumer bug/);
  // No second terminal, and the return settles without a replay.
  gate.onMessage(done(FINAL));
  await gate.finish(done(FINAL));
  assert.equal(delivered.length, 1);
});
