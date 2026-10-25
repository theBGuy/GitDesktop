// Pins the blame-failure classifiers (src/features/history/blame-errors.ts)
// over AppError payloads exactly as src-tauri/src/error.rs serializes them:
// `message` is the Rust Display text, so an InvalidArgument carries its
// "invalid argument: " lead. Each matched shape names the Rust test that pins
// its producer in src-tauri/src/git/history.rs. Also pins appErrorDetail, the
// lead stripper they share (src/lib/error-summary.ts).
//
// The module imports the `@/` error-summary lead mirror, which Node's type
// stripping can't resolve, so the shared src hooks go in first and the import
// is dynamic. Not wrapped in a skip guard: the graph reaches no bare packages.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { isNoBlameHistoryError, isUnknownRevisionError } = await import(
  "@/features/history/blame-errors"
);
const errorSummary = await import("@/lib/error-summary");

const invalidArgument = (detail) => ({
  kind: "invalidArgument",
  message: `invalid argument: ${detail}`,
});
const git = (stderr, code = 128) => ({
  kind: "git",
  message: stderr.trim(),
  code,
  stderr,
});

// blame_unknown_rev_says_unknown_revision
const unknownRev = invalidArgument("unknown revision: no-such-rev");
// blame_untracked_file_says_no_such_path_in_head
const untracked = git("fatal: no such path 'new.txt' in HEAD\n");
// blame_unborn_head_errors
const unborn = invalidArgument(
  "repository has no commits yet — blame needs at least one commit",
);
// blame_in_a_broken_repo_reports_gits_reason
const broken = git(
  "fatal: not a git repository (or any of the parent directories): .git\n",
);

test("an unknown revision is recognized through its serialized lead", () => {
  assert.equal(isUnknownRevisionError(unknownRev), true);
  // Negative controls: another InvalidArgument, other failures, and the same
  // detail under another kind.
  assert.equal(
    isUnknownRevisionError(invalidArgument("invalid revision: -x")),
    false,
  );
  assert.equal(isUnknownRevisionError(unborn), false);
  assert.equal(isUnknownRevisionError(broken), false);
  assert.equal(
    isUnknownRevisionError({ kind: "command", message: "unknown revision: x" }),
    false,
  );
});

test("an untracked file or a commit-less repository has no blame history", () => {
  assert.equal(isNoBlameHistoryError(untracked), true);
  assert.equal(isNoBlameHistoryError(unborn), true);
  // A git payload carries stderr with a trimmed copy as its message; the
  // classifier reads stderr and falls back to the message, so either matches.
  assert.equal(
    isNoBlameHistoryError({ ...untracked, stderr: undefined }),
    true,
  );
});

test("any other blame failure is a failed read", () => {
  assert.equal(isNoBlameHistoryError(broken), false);
  assert.equal(isNoBlameHistoryError(unknownRev), false);
  // The phrase under another kind is not git's refusal.
  assert.equal(
    isNoBlameHistoryError({
      kind: "command",
      message: "fatal: no such path 'new.txt' in HEAD",
    }),
    false,
  );
});

test("appErrorDetail strips only a colon-ended lead", () => {
  const { appErrorDetail } = errorSummary;
  assert.equal(
    appErrorDetail("invalidArgument", "invalid argument: unknown revision: x"),
    "unknown revision: x",
  );
  // Whole-sentence leads pass through unchanged.
  assert.equal(
    appErrorDetail("timeout", "git operation timed out after 30s"),
    "git operation timed out after 30s",
  );
  assert.equal(
    appErrorDetail("gitNotFound", "git executable not found"),
    "git executable not found",
  );
  // Negative control: a message without its kind's lead.
  assert.equal(appErrorDetail("invalidArgument", "bad"), "bad");
});

test("non-AppError values classify as neither", () => {
  for (const value of [null, undefined, "unknown revision: x", 1, {}]) {
    assert.equal(isUnknownRevisionError(value), false);
    assert.equal(isNoBlameHistoryError(value), false);
  }
});
