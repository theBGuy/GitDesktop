// Pins the one confirm both manual AI-review posts ask (the live Post and a
// history row's Post): its title precedence, its confirm label, and its copy,
// byte for byte, so the two surfaces can't drift apart again.
//
// The import reaches straight into `src/` under Node's type stripping (>= 23.6),
// which resolves no bundler aliases: `review-post-confirm.ts` may import only the
// dependency-free comment-branding module at runtime.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  recordIncomplete,
  reviewPostConfirm,
  reviewPostedToast,
} from "../src/lib/pulls/review-post-confirm.ts";

const CANCELLED =
  "This run was cancelled before it finished, so the text may be incomplete.";
const TIMED_OUT =
  "This run timed out before it finished, so the text may be incomplete.";
const FAILED =
  "This run failed before completing, so the text may be incomplete.";
const ALREADY =
  "This review was already posted to the conversation — posting it again adds a second comment.";
const ONE_REF =
  "The text mentions #12 — posted as-is, it becomes a live cross-reference that notifies the thread it names. Backticks keep it plain.";
const TWO_REFS =
  "The text mentions #12 and !3 — posted as-is, each becomes a live cross-reference that notifies the thread it names. Backticks keep them plain.";
const CLOSE = "Post it as a comment anyway?";

const ask = (incomplete, already, suspectRefs) =>
  reviewPostConfirm({ incomplete, already, suspectRefs });

test("nothing to ask posts without a confirm", () => {
  assert.equal(ask(null, false, []), null);
});

test("each stop reason has its own sentence", () => {
  for (const [incomplete, sentence] of [
    ["cancelled", CANCELLED],
    ["timed-out", TIMED_OUT],
    ["failed", FAILED],
  ]) {
    assert.deepEqual(ask(incomplete, false, []), {
      title: "Post partial review?",
      body: `${sentence} ${CLOSE}`,
      confirmLabel: "Post anyway",
    });
  }
});

test("an already-posted review asks to post again", () => {
  assert.deepEqual(ask(null, true, []), {
    title: "Post this review again?",
    body: `${ALREADY} ${CLOSE}`,
    confirmLabel: "Post again",
  });
});

test("live references name themselves, singular and plural", () => {
  assert.deepEqual(ask(null, false, ["#12"]), {
    title: "Post review with live references?",
    body: `${ONE_REF} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
  assert.deepEqual(ask(null, false, ["#12", "!3"]), {
    title: "Post review with live references?",
    body: `${TWO_REFS} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
});

test("incomplete outranks already posted, and the body keeps both", () => {
  assert.deepEqual(ask("timed-out", true, []), {
    title: "Post partial review?",
    body: `${TIMED_OUT} ${ALREADY} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
});

test("already posted outranks live references; refs keep Post anyway", () => {
  assert.deepEqual(ask(null, true, ["#12"]), {
    title: "Post this review again?",
    body: `${ALREADY} ${ONE_REF} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
});

test("every reason at once reads in order: stop, already, refs", () => {
  assert.deepEqual(ask("cancelled", true, ["#12", "!3"]), {
    title: "Post partial review?",
    body: `${CANCELLED} ${ALREADY} ${TWO_REFS} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
  assert.deepEqual(ask("failed", false, ["#12"]), {
    title: "Post partial review?",
    body: `${FAILED} ${ONE_REF} ${CLOSE}`,
    confirmLabel: "Post anyway",
  });
});

test("recordIncomplete: a completed record is whole, a kept partial names its stop", () => {
  assert.equal(recordIncomplete({}), null);
  assert.equal(recordIncomplete({ timedOut: true }), null);
  assert.equal(
    recordIncomplete({ phase: "error", timedOut: true }),
    "timed-out",
  );
  assert.equal(recordIncomplete({ phase: "error" }), "failed");
  assert.equal(recordIncomplete({ phase: "error", timedOut: false }), "failed");
});

test("recordIncomplete compares untrusted flags by exact value", () => {
  assert.equal(recordIncomplete({ phase: "ERROR", timedOut: true }), null);
  assert.equal(
    recordIncomplete({ phase: "error", timedOut: "true" }),
    "failed",
  );
  assert.equal(recordIncomplete({ phase: "error", timedOut: 1 }), "failed");
});

test("the posted toast names the mode", () => {
  assert.equal(
    reviewPostedToast("security"),
    "Security audit posted to the conversation",
  );
  assert.equal(
    reviewPostedToast("general"),
    "Review posted to the conversation",
  );
});
