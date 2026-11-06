// Pins the PR conversation read-only derivation (src/lib/git/types/prs.ts):
// `prConversationHold` over the lock fields the forge read carries, and
// `isPrArchivedRefusal` over AppError payloads exactly as src-tauri/src/error.rs
// serializes them (an `AppError::Gh` is `{kind: "gh", message}` with no Display
// lead, so the message must equal the pinned copy byte for byte).
//
// `isPrArchivedRefusal` lives in error-summary.ts, whose `@/` imports Node's
// type stripping can't resolve, so the shared src hooks go in first and the
// imports are dynamic.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { PR_ARCHIVED_READONLY_MESSAGE, prConversationHold } = await import(
  "@/lib/git/types/prs"
);
const { isPrArchivedRefusal } = await import("@/lib/error-summary");

const ARCHIVED =
  "This pull request is archived, so its conversation is read-only.";
const LOCKED =
  "This conversation is locked, so only collaborators can comment.";
const REACTIONS_OFF = "Reactions are turned off for this pull request.";
const LIVE = { composer: null, reactions: null };

test("the archived copy mirrors GH_PR_ARCHIVED_READONLY verbatim", () => {
  assert.equal(PR_ARCHIVED_READONLY_MESSAGE, ARCHIVED);
});

test("an archived latch holds both, whatever the lock fields say", () => {
  const both = { composer: ARCHIVED, reactions: ARCHIVED };
  assert.deepEqual(prConversationHold(undefined, true, "github"), both);
  assert.deepEqual(prConversationHold({}, true, "github"), both);
  assert.deepEqual(
    prConversationHold(
      { locked: true, viewerCanComment: false, viewerCanReact: false },
      true,
      "github",
    ),
    both,
  );
  assert.deepEqual(
    prConversationHold(
      { locked: false, viewerCanComment: true, viewerCanReact: true },
      true,
      "github",
    ),
    both,
  );
});

test("locked + viewer can't comment holds the composer and reactions", () => {
  assert.deepEqual(
    prConversationHold(
      { locked: true, viewerCanComment: false },
      false,
      "github",
    ),
    { composer: LOCKED, reactions: LOCKED },
  );
  assert.deepEqual(
    prConversationHold(
      { locked: true, viewerCanComment: false, viewerCanReact: null },
      false,
      "github",
    ),
    { composer: LOCKED, reactions: LOCKED },
  );
  // GitLab mirrors the two flags.
  assert.deepEqual(
    prConversationHold(
      { locked: true, viewerCanComment: false, viewerCanReact: false },
      false,
      "github",
    ),
    { composer: LOCKED, reactions: REACTIONS_OFF },
  );
});

test("viewerCanReact false holds reactions alone, lock or not", () => {
  for (const pr of [
    { viewerCanReact: false },
    { locked: false, viewerCanReact: false },
    // A collaborator on a locked PR: comments live, reactions off for all.
    { locked: true, viewerCanComment: true, viewerCanReact: false },
    { locked: true, viewerCanComment: null, viewerCanReact: false },
  ])
    assert.deepEqual(
      prConversationHold(pr, false, "github"),
      { composer: null, reactions: REACTIONS_OFF },
      JSON.stringify(pr),
    );
});

test("unknown or unlocked stays live (negative controls)", () => {
  for (const pr of [
    undefined,
    // A row cached before the fields existed.
    {},
    { locked: false, viewerCanComment: false },
    // lockUnknown: GitHub's read failed, so `locked` reads false.
    { locked: false, lockUnknown: true },
    { locked: true, viewerCanComment: true, viewerCanReact: true },
    // TRIAGE, or a GitLab createNote read that failed: unknown.
    { locked: true, viewerCanComment: null },
    { locked: true, viewerCanComment: undefined },
    { locked: true },
    { locked: true, viewerCanComment: null, viewerCanReact: true },
  ])
    assert.deepEqual(
      prConversationHold(pr, false, "github"),
      LIVE,
      JSON.stringify(pr) ?? "undefined",
    );
});

test("the hold copy names the forge the viewer is on", () => {
  const locked = {
    locked: true,
    viewerCanComment: false,
    viewerCanReact: false,
  };
  const copy = {
    github: [LOCKED, REACTIONS_OFF],
    gitlab: [
      "This conversation is locked, so only project members can comment.",
      "Reactions are turned off for this merge request.",
    ],
    bitbucket: [
      "This conversation is locked, so you can't comment on it.",
      "Reactions are turned off for this conversation.",
    ],
    unknown: [
      "This conversation is locked, so you can't comment on it.",
      "Reactions are turned off for this conversation.",
    ],
  };
  for (const [name, [lockedCopy, reactionsCopy]] of Object.entries(copy)) {
    const provider = name === "unknown" ? undefined : name;
    assert.deepEqual(
      prConversationHold(locked, false, provider),
      { composer: lockedCopy, reactions: reactionsCopy },
      name,
    );
    assert.deepEqual(
      prConversationHold({ viewerCanReact: false }, false, provider),
      { composer: null, reactions: reactionsCopy },
      name,
    );
    // The archived message is provider-independent.
    assert.deepEqual(prConversationHold(undefined, true, provider), {
      composer: ARCHIVED,
      reactions: ARCHIVED,
    });
    // Unknown lock state keeps everything live whatever the provider.
    assert.deepEqual(
      prConversationHold({ locked: true }, false, provider),
      LIVE,
    );
  }
  assert.deepEqual(prConversationHold(locked, false, null), {
    composer: copy.unknown[0],
    reactions: copy.unknown[1],
  });
});

test("isPrArchivedRefusal matches only the pinned gh message", () => {
  assert.equal(isPrArchivedRefusal({ kind: "gh", message: ARCHIVED }), true);
  for (const e of [
    // The raw forge stderr the Rust classifier rewrites: never matched here.
    {
      kind: "gh",
      message:
        "GraphQL: Pull request is archived and its conversation is read-only (addComment)",
    },
    { kind: "gh", message: `${ARCHIVED} ` },
    { kind: "gh", message: `gh: ${ARCHIVED}` },
    { kind: "gh", message: ARCHIVED.slice(0, -1) },
    { kind: "git", message: ARCHIVED },
    { kind: "command", message: ARCHIVED },
    { message: ARCHIVED },
    { kind: "gh" },
    { kind: "gh", message: 42 },
    ARCHIVED,
    new Error(ARCHIVED),
    null,
    undefined,
  ])
    assert.equal(isPrArchivedRefusal(e), false, JSON.stringify(e));
});
