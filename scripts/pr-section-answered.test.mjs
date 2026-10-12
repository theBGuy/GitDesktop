// Pins the PR view's one readiness rule (src/features/pulls/pr-section-answered.ts):
// the switch hold settles, the Conversation feed mounts and a review
// notification's scroll fires on the same predicate, so the three can't drift
// apart again. A placeholder never answers, a parked or failed read does, and
// each section waits only for the reads it paints.
//
// Not testable here: which reads the view feeds in (target vs shown) and what
// renders around them. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prSectionAnswered,
  readAnswered,
} from "../src/features/pulls/pr-section-answered.ts";

/** A read with its own data. */
const loaded = (over = {}) => ({
  data: [],
  isError: false,
  isPaused: false,
  isPlaceholderData: false,
  ...over,
});
/** A read still in flight with nothing to show. */
const pending = () => loaded({ data: undefined });
/** A read serving another key's data. */
const placeholder = () => loaded({ isPlaceholderData: true });

/** Every input answered; each test breaks the one it is about. */
function reads(over = {}) {
  return {
    threads: loaded(),
    timeline: loaded(),
    forgeSettled: true,
    reactions: loaded(),
    tasks: loaded(),
    diff: loaded(),
    ...over,
  };
}

test("own data answers; a pending read does not", () => {
  assert.equal(readAnswered(loaded()), true);
  assert.equal(readAnswered(pending()), false);
});

test("placeholder data never answers", () => {
  assert.equal(readAnswered(placeholder()), false);
});

test("a parked or failed read answers: each renders its own notice", () => {
  assert.equal(readAnswered(loaded({ data: undefined, isPaused: true })), true);
  assert.equal(readAnswered(loaded({ data: undefined, isError: true })), true);
});

test("conversation waits for threads and the timeline", () => {
  assert.equal(prSectionAnswered("conversation", reads()), true);
  assert.equal(
    prSectionAnswered("conversation", reads({ threads: pending() })),
    false,
  );
  assert.equal(
    prSectionAnswered("conversation", reads({ timeline: pending() })),
    false,
  );
});

test("with no provider resolved, a settled forge probe stands in for the timeline", () => {
  assert.equal(
    prSectionAnswered(
      "conversation",
      reads({ timeline: null, forgeSettled: true }),
    ),
    true,
  );
  assert.equal(
    prSectionAnswered(
      "conversation",
      reads({ timeline: null, forgeSettled: false }),
    ),
    false,
  );
});

test("conversation waits for reactions and tasks only where they are read", () => {
  assert.equal(
    prSectionAnswered("conversation", reads({ reactions: pending() })),
    false,
  );
  assert.equal(
    prSectionAnswered("conversation", reads({ tasks: pending() })),
    false,
  );
  assert.equal(
    prSectionAnswered("conversation", reads({ reactions: null, tasks: null })),
    true,
  );
});

test("conversation ignores the diff", () => {
  assert.equal(
    prSectionAnswered("conversation", reads({ diff: pending() })),
    true,
  );
});

test("files needs its PR's own diff; a placeholder diff does not answer", () => {
  assert.equal(prSectionAnswered("files", reads()), true);
  assert.equal(prSectionAnswered("files", reads({ diff: pending() })), false);
  assert.equal(
    prSectionAnswered("files", reads({ diff: placeholder() })),
    false,
  );
  // Files ignores the feed's reads.
  assert.equal(
    prSectionAnswered(
      "files",
      reads({ threads: pending(), timeline: pending() }),
    ),
    true,
  );
});

test("commits and review need nothing beyond the details", () => {
  const none = reads({
    threads: pending(),
    timeline: pending(),
    reactions: pending(),
    tasks: pending(),
    diff: pending(),
    forgeSettled: false,
  });
  assert.equal(prSectionAnswered("commits", none), true);
  assert.equal(prSectionAnswered("review", none), true);
});

// Negative control: the same check over a readAnswered with the placeholder
// term dropped. It must pass where the real one fails, or the placeholder test
// above isn't testing that term.
test("negative control: dropping the placeholder term answers a placeholder", () => {
  const withoutPlaceholderTerm = (q) =>
    q.data !== undefined || q.isError || q.isPaused;
  assert.equal(withoutPlaceholderTerm(placeholder()), true);
  assert.notEqual(
    readAnswered(placeholder()),
    withoutPlaceholderTerm(placeholder()),
  );
});
