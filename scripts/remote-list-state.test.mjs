// Pins the remote list section's render ladder and the board's failure-notice
// grouping. The contract under test: a failed read replaces a list only when it
// has no rows to draw; with rows cached, the rows stay and a degraded notice
// sits above them, so an outage never reads as data loss.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so
// `remote-section-state.ts` must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  groupNoticesByMessage,
  normalizeNoticeMessage,
  resolveRemoteSection,
} from "../src/features/conversations/remote-section-state.ts";

const BOOLS = [false, true];
const ROW_COUNTS = [0, 1, 7];

/** The ladder in the order the section checks it, written out rung by rung. */
function expected({ ghPending, ghReady, listPending, error, rowCount }) {
  if (ghPending) return "gh-skeleton";
  if (!ghReady) return "not-ready";
  if (listPending) return "list-skeleton";
  if (error && rowCount === 0) return "error";
  if (error) return "rows-degraded";
  if (rowCount === 0) return "empty";
  return "rows";
}

test("every ladder input resolves to its rung (full truth table)", () => {
  let cases = 0;
  for (const ghPending of BOOLS)
    for (const ghReady of BOOLS)
      for (const listPending of BOOLS)
        for (const error of BOOLS)
          for (const rowCount of ROW_COUNTS) {
            const input = { ghPending, ghReady, listPending, error, rowCount };
            assert.equal(
              resolveRemoteSection(input),
              expected(input),
              JSON.stringify(input),
            );
            cases++;
          }
  // 2^4 flag combinations x 3 row counts: a truncated loop fails here.
  assert.equal(cases, 48);
});

test("a failed refresh with cached rows keeps the rows (negative control)", () => {
  const ready = { ghPending: false, ghReady: true, listPending: false };
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 3 }),
    "rows-degraded",
  );
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 1 }),
    "rows-degraded",
  );
  // With nothing to draw, the error state still replaces the section.
  assert.equal(
    resolveRemoteSection({ ...ready, error: true, rowCount: 0 }),
    "error",
  );
});

test("the gates outrank an error: pending and not-ready never show rows", () => {
  const failed = { error: true, rowCount: 5 };
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: true,
      ghReady: true,
      listPending: false,
    }),
    "gh-skeleton",
  );
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: false,
      ghReady: false,
      listPending: false,
    }),
    "not-ready",
  );
  assert.equal(
    resolveRemoteSection({
      ...failed,
      ghPending: false,
      ghReady: true,
      listPending: true,
    }),
    "list-skeleton",
  );
});

const notice = (key, message) => ({ key, message });
const keys = (groups) => groups.map((g) => g.map((n) => n.key));

test("identical messages collapse into one group, in first-seen order", () => {
  const down = "Couldn't reach GitHub.";
  const groups = groupNoticesByMessage([
    notice("projects", down),
    notice("fields", down),
    notice("views", down),
    notice("items", down),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields", "views", "items"]]);
});

test("a two-and-two split yields two groups, each keeping its members", () => {
  const groups = groupNoticesByMessage([
    notice("projects", "A"),
    notice("fields", "B"),
    notice("views", "A"),
    notice("items", "B"),
  ]);
  assert.deepEqual(keys(groups), [
    ["projects", "views"],
    ["fields", "items"],
  ]);
});

test("distinct messages stay one line each", () => {
  const groups = groupNoticesByMessage([
    notice("projects", "A"),
    notice("fields", "B"),
    notice("views", "C"),
    notice("items", "D"),
  ]);
  assert.deepEqual(keys(groups), [
    ["projects"],
    ["fields"],
    ["views"],
    ["items"],
  ]);
});

test("no notices, no groups", () => {
  assert.deepEqual(groupNoticesByMessage([]), []);
});

// Shapes measured on a live board outage: every transport error names its own
// connection's ephemeral local port, so exact text never matches across reads.
const reset = (localPort) =>
  `read tcp 127.0.0.1:${localPort}->127.0.0.1:18431: wsarecv: An existing connection was forcibly closed by the remote host.`;
const BAD_GATEWAY = 'Post "https://api.github.com/graphql": Bad Gateway';
const dial = (localPort) =>
  `dial tcp 192.168.1.20:${localPort}->140.82.113.3:443: connectex: A connection attempt failed because the connected party did not properly respond after a period of time.`;

test("resets differing only in the local port group as one outage (negative control)", () => {
  const groups = groupNoticesByMessage([
    notice("projects", reset(63047)),
    notice("fields", reset(63051)),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields"]]);
  // The line shows the first member's own text, unmasked.
  assert.equal(groups[0][0].message, reset(63047));
});

test("a fixed-text failure on every read still groups as one", () => {
  const groups = groupNoticesByMessage([
    notice("projects", BAD_GATEWAY),
    notice("fields", BAD_GATEWAY),
    notice("views", BAD_GATEWAY),
    notice("items", BAD_GATEWAY),
  ]);
  assert.deepEqual(keys(groups), [["projects", "fields", "views", "items"]]);
});

test("a reset and a bad gateway stay two lines", () => {
  const groups = groupNoticesByMessage([
    notice("projects", reset(63047)),
    notice("fields", BAD_GATEWAY),
  ]);
  assert.deepEqual(keys(groups), [["projects"], ["fields"]]);
});

test("dial failures to one remote from different local ports group as one", () => {
  const groups = groupNoticesByMessage([
    notice("projects", dial(50112)),
    notice("views", dial(50119)),
    notice("items", dial(50123)),
  ]);
  assert.deepEqual(keys(groups), [["projects", "views", "items"]]);
});

test("masking touches address:port tokens only, never bare numbers", () => {
  assert.equal(
    normalizeNoticeMessage("dial tcp localhost:8080: refused"),
    "dial tcp <addr>: refused",
  );
  assert.equal(
    normalizeNoticeMessage("read tcp [::1]:63047->[::1]:18431: reset"),
    "read tcp <addr>-><addr>: reset",
  );
  // Different HTTP statuses, and a version-like number, are left alone.
  const groups = groupNoticesByMessage([
    notice("projects", "HTTP 502: Bad Gateway"),
    notice("fields", "HTTP 503: Service Unavailable"),
    notice("views", "HTTP 500 from 1.2.3"),
  ]);
  assert.deepEqual(keys(groups), [["projects"], ["fields"], ["views"]]);
});
