// Pins the conflict banner's stash-reapply states
// (src/features/repository/conflict-banner-state.ts): which copy shows, when
// the freshness gate lets a marker-derived state through, when the marker
// clears, and the banner's op precedence.
//
// Not testable here: the banner's rendering, the confirm flow, and the focus
// rescues. Those need the live app.
//
// The import reaches straight into `src/` under Node's type stripping, so the
// module must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeRepoOp,
  deriveStashBannerState,
  opPhrase,
} from "../src/features/repository/conflict-banner-state.ts";

const REPO = "C:/repos/plugy";
const T = 1_000;

const marker = (over = {}) => ({
  repoPath: REPO,
  stashSha: "0cb34f6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  operationLabel: "update",
  detail: "master",
  recordedAt: T,
  ...over,
});

/** Fresh reads on both axes, a kept backup, no op, one conflict. */
const args = (over = {}) => ({
  marker: marker(),
  repoPath: REPO,
  opActive: false,
  conflictedCount: 1,
  statusUpdatedAt: T + 1,
  stashCount: 1,
  stashCountUpdatedAt: T + 1,
  ...over,
});

const NONE = { state: { kind: "none" }, clearMarker: false };

test("conflicted copy names the finished operation, singular and plural", () => {
  assert.deepEqual(deriveStashBannerState(args()), {
    state: {
      kind: "conflicted",
      lead: "Reapplying your stashed changes · 1 conflict",
      tail: "The update from master finished. Resolve it in the changes list; your changes are also kept in a backup stash.",
    },
    clearMarker: false,
  });
  assert.deepEqual(deriveStashBannerState(args({ conflictedCount: 3 })), {
    state: {
      kind: "conflicted",
      lead: "Reapplying your stashed changes · 3 conflicts",
      tail: "The update from master finished. Resolve them in the changes list; your changes are also kept in a backup stash.",
    },
    clearMarker: false,
  });
});

test("resolved copy and its announcement", () => {
  assert.deepEqual(deriveStashBannerState(args({ conflictedCount: 0 })), {
    state: {
      kind: "resolved",
      lead: "Reapplying your stashed changes · all conflicts resolved",
      tail: "Drop the backup stash if your changes look right, or keep it in View stashes.",
      announcement:
        "All conflicts resolved. Drop the backup stash if your changes look right, or keep it in View stashes.",
    },
    clearMarker: false,
  });
});

test("every op-phrase variant the copy lists", () => {
  const cases = [
    [{ operationLabel: "pull" }, "The pull finished."],
    [
      { operationLabel: "pull", detail: "origin/main" },
      "The pull from origin/main finished.",
    ],
    [
      { operationLabel: "update", detail: "master" },
      "The update from master finished.",
    ],
    [
      { operationLabel: "update", detail: "upstream/main" },
      "The update from upstream/main finished.",
    ],
    [
      { operationLabel: "merge", detail: "feature/x" },
      "The merge from feature/x finished.",
    ],
    [
      { operationLabel: "rebase", detail: "main", detailPreposition: "onto" },
      "The rebase onto main finished.",
    ],
    [
      { operationLabel: "switch", detail: "feature/x", detailPreposition: "to" },
      "The switch to feature/x finished.",
    ],
  ];
  for (const [over, sentence] of cases) {
    const m = marker({ detail: undefined, ...over });
    const { state } = deriveStashBannerState(args({ marker: m }));
    assert.equal(state.kind, "conflicted");
    assert.ok(state.tail.startsWith(`${sentence} Resolve it`), state.tail);
  }
});

test("opPhrase arms: bare label, default from, onto, to, long base", () => {
  assert.equal(opPhrase({ operationLabel: "pull" }), "pull");
  assert.equal(opPhrase({ operationLabel: "pull", detail: "" }), "pull");
  assert.equal(
    opPhrase({ operationLabel: "update", detail: "master" }),
    "update from master",
  );
  assert.equal(
    opPhrase({
      operationLabel: "rebase",
      detail: "main",
      detailPreposition: "onto",
    }),
    "rebase onto main",
  );
  assert.equal(
    opPhrase({
      operationLabel: "switch",
      detail: "feature/x",
      detailPreposition: "to",
    }),
    "switch to feature/x",
  );
  assert.equal(
    opPhrase({
      operationLabel: "update",
      detail: "origin/release/2026-10-hotfix-crash-safe-saves",
    }),
    "update from origin/release/2026-10-hotfix-crash-safe-saves",
  );
});

test("no marker, or a marker for another repo: none, and never a clear", () => {
  assert.deepEqual(deriveStashBannerState(args({ marker: null })), NONE);
  const foreign = marker({ repoPath: "C:/repos/other" });
  assert.deepEqual(deriveStashBannerState(args({ marker: foreign })), NONE);
  assert.deepEqual(
    deriveStashBannerState(args({ marker: foreign, stashCount: 0 })),
    NONE,
  );
});

test("a status read not newer than the marker shows the generic copy", () => {
  for (const statusUpdatedAt of [0, T - 1, T]) {
    for (const conflictedCount of [0, 1, 3]) {
      assert.deepEqual(
        deriveStashBannerState(args({ statusUpdatedAt, conflictedCount })),
        NONE,
        `status at ${statusUpdatedAt}, ${conflictedCount} conflicts`,
      );
    }
  }
});

test("a stale stash count never offers the drop and never clears", () => {
  for (const stashCountUpdatedAt of [0, T - 1, T]) {
    for (const stashCount of [0, 1]) {
      assert.deepEqual(
        deriveStashBannerState(
          args({ conflictedCount: 0, stashCount, stashCountUpdatedAt }),
        ),
        NONE,
        `count ${stashCount} at ${stashCountUpdatedAt}`,
      );
    }
  }
  // The stale-0 case: a repo with no stashes before the compound still shows
  // the conflicted copy.
  assert.equal(
    deriveStashBannerState(args({ stashCount: 0, stashCountUpdatedAt: T - 1 }))
      .state.kind,
    "conflicted",
  );
});

test("an unknown stash count offers no resolved row", () => {
  assert.deepEqual(
    deriveStashBannerState(
      args({ conflictedCount: 0, stashCount: undefined }),
    ),
    NONE,
  );
});

test("a fresh empty stash list clears the marker in every branch", () => {
  const clear = { state: { kind: "none" }, clearMarker: true };
  const fresh0 = { stashCount: 0, stashCountUpdatedAt: T + 1 };
  assert.deepEqual(deriveStashBannerState(args(fresh0)), clear);
  assert.deepEqual(
    deriveStashBannerState(args({ ...fresh0, conflictedCount: 0 })),
    clear,
  );
  assert.deepEqual(
    deriveStashBannerState(args({ ...fresh0, opActive: true })),
    clear,
  );
  // Even before a fresh status: the count alone decides there is nothing left.
  assert.deepEqual(
    deriveStashBannerState(args({ ...fresh0, statusUpdatedAt: T })),
    clear,
  );
});

test("an in-progress op always wins", () => {
  assert.deepEqual(deriveStashBannerState(args({ opActive: true })), NONE);
  assert.deepEqual(
    deriveStashBannerState(args({ opActive: true, conflictedCount: 0 })),
    NONE,
  );
});

test("activeRepoOp's precedence order; editPaused names no op", () => {
  const ops = {
    merging: false,
    rebasing: false,
    cherryPicking: false,
    reverting: false,
    editPaused: false,
  };
  assert.equal(activeRepoOp(undefined), null);
  assert.equal(activeRepoOp(ops), null);
  assert.equal(activeRepoOp({ ...ops, editPaused: true }), null);
  assert.equal(
    activeRepoOp({
      merging: true,
      rebasing: true,
      cherryPicking: true,
      reverting: true,
      editPaused: true,
    }),
    "merge",
  );
  assert.equal(
    activeRepoOp({
      ...ops,
      rebasing: true,
      cherryPicking: true,
      reverting: true,
    }),
    "rebase",
  );
  assert.equal(
    activeRepoOp({ ...ops, cherryPicking: true, reverting: true }),
    "cherry-pick",
  );
  assert.equal(activeRepoOp({ ...ops, reverting: true }), "revert");
});
