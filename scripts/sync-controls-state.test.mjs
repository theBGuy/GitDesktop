// Pins the sync bar's derivation: what each button is called, whether it is
// held and why, and which hotkeys fire, across the loading and settled states.
// The contract under test: nothing that acts on the branch is offered before
// the status has measured it ("Publish branch" sends `-u origin`), holds are
// ranked busy > offline > unknown read > the state's own description (save
// the Pull-options caret, which offline never holds: its network items carry
// their own offline holds), and every disabled control carries a reason.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so
// `sync-controls-state.ts` must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveSyncControls,
  PULL_OPTIONS_UNPUBLISHED_REASON,
  REMOTES_FAILED_REASON,
  REMOTES_PENDING_REASON,
  STATUS_PENDING_REASON,
  STATUS_READ_FAILED_REASON,
  SYNC_BUSY_REASON,
} from "../src/features/repository/sync-controls-state.ts";

// No `oid` key on purpose: a head without one must keep reading as born.
const head = (over = {}) => ({
  name: "feature",
  detached: false,
  upstream: "origin/feature",
  ahead: 0,
  behind: 0,
  upstreamGone: false,
  ...over,
});

const input = (over = {}) => ({
  head: head(),
  statusError: false,
  remotes: ["origin"],
  remotesError: false,
  busy: false,
  offlineHold: undefined,
  remoteRebased: false,
  mixedRewrite: false,
  localAtRisk: 0,
  ...over,
});

const NO_HOTKEYS = {
  fetch: false,
  pull: false,
  push: false,
  updateFromUpstream: false,
};

test("(1) status unknown, origin known: Fetch live, the rest held on the branch", () => {
  const s = deriveSyncControls(input({ head: undefined }));
  assert.equal(s.statusKnown, false);
  assert.equal(s.pushLabel, "Push");
  assert.equal(s.pullDescription, undefined);
  assert.equal(s.pullName, "Pull");
  assert.equal(s.pushName, "Push");
  assert.deepEqual(s.fetch, { disabled: false, reason: undefined });
  for (const h of [s.pull, s.push, s.pullOptions])
    assert.deepEqual(h, { disabled: true, reason: "Checking branch…" });
  assert.deepEqual(s.hotkeys, { ...NO_HOTKEYS, fetch: true });
});

test("(2) status read failed with no data: held with the read failure", () => {
  const s = deriveSyncControls(input({ head: undefined, statusError: true }));
  assert.equal(s.statusFailed, true);
  assert.equal(s.pushLabel, "Push");
  assert.equal(s.pullName, "Pull");
  assert.equal(s.fetch.disabled, false);
  for (const h of [s.pull, s.push, s.pullOptions])
    assert.deepEqual(h, {
      disabled: true,
      reason: STATUS_READ_FAILED_REASON,
    });
  assert.equal(
    STATUS_READ_FAILED_REASON,
    "Couldn't read the repository status",
  );
  assert.deepEqual(s.hotkeys, { ...NO_HOTKEYS, fetch: true });
});

test("a failed refetch over measured data holds nothing", () => {
  // The default input is a measured, clean branch tracking origin/feature.
  const s = deriveSyncControls(input({ statusError: true }));
  assert.equal(s.statusFailed, false);
  for (const h of [s.fetch, s.pull, s.push, s.pullOptions])
    assert.deepEqual(h, { disabled: false, reason: undefined });
  assert.equal(s.hotkeys.pull, true);
  assert.equal(s.hotkeys.push, true);
});

test("(3) remotes unknown: all four held on the remotes, whatever the status", () => {
  const heads = [
    head(),
    undefined,
    head({ name: null, detached: true, upstream: null }),
    head({ ahead: 2, behind: 1 }),
    head({ oid: null, upstream: null }),
  ];
  for (const h0 of heads)
    for (const statusError of [false, true])
      for (const [remotesError, reason] of [
        [false, "Checking remotes…"],
        [true, "Couldn't read the remotes"],
      ]) {
        const s = deriveSyncControls(
          input({ head: h0, statusError, remotes: undefined, remotesError }),
        );
        assert.equal(s.remotesKnown, false);
        // A failed read is never coerced to "no remotes": that would offer
        // Publish repository on a repo that may well have an origin.
        assert.equal(s.noOrigin, false);
        assert.equal(s.hasOrigin, false);
        for (const h of [s.fetch, s.pull, s.push, s.pullOptions])
          assert.deepEqual(h, { disabled: true, reason });
        assert.deepEqual(s.hotkeys, NO_HOTKEYS);
      }
});

test("each read's pending and failed wording is one exported constant", () => {
  assert.equal(STATUS_PENDING_REASON, "Checking branch…");
  assert.equal(REMOTES_PENDING_REASON, "Checking remotes…");
  assert.equal(REMOTES_FAILED_REASON, "Couldn't read the remotes");
  const pending = deriveSyncControls(input({ head: undefined }));
  assert.equal(pending.push.reason, STATUS_PENDING_REASON);
  const unread = deriveSyncControls(input({ remotes: undefined }));
  assert.equal(unread.fetch.reason, REMOTES_PENDING_REASON);
  const failed = deriveSyncControls(
    input({ remotes: undefined, remotesError: true }),
  );
  assert.equal(failed.fetch.reason, REMOTES_FAILED_REASON);
});

test("a failed remotes read outranks every status reason, and only while unread", () => {
  const failed = deriveSyncControls(
    input({
      head: undefined,
      statusError: true,
      remotes: undefined,
      remotesError: true,
    }),
  );
  for (const h of [failed.fetch, failed.pull, failed.push, failed.pullOptions])
    assert.deepEqual(h, {
      disabled: true,
      reason: "Couldn't read the remotes",
    });
  // Loaded remotes ignore the flag: only the status reason remains.
  const loaded = deriveSyncControls(
    input({ head: undefined, statusError: true, remotesError: true }),
  );
  assert.equal(loaded.remotesKnown, true);
  assert.deepEqual(loaded.fetch, { disabled: false, reason: undefined });
  assert.deepEqual(loaded.push, {
    disabled: true,
    reason: STATUS_READ_FAILED_REASON,
  });
});

test("the unknown-read reason matrix: remotes state x status state", () => {
  const remotesStates = {
    pending: { remotes: undefined, remotesError: false },
    failed: { remotes: undefined, remotesError: true },
    withOrigin: { remotes: ["origin"], remotesError: false },
  };
  const statusStates = {
    pending: { head: undefined, statusError: false },
    failed: { head: undefined, statusError: true },
    loaded: { head: head(), statusError: false },
  };
  // [fetch reason, branch reason] per cell; undefined = not held.
  const expected = {
    pending: {
      pending: ["Checking remotes…", "Checking remotes…"],
      failed: ["Checking remotes…", "Checking remotes…"],
      loaded: ["Checking remotes…", "Checking remotes…"],
    },
    failed: {
      pending: ["Couldn't read the remotes", "Couldn't read the remotes"],
      failed: ["Couldn't read the remotes", "Couldn't read the remotes"],
      loaded: ["Couldn't read the remotes", "Couldn't read the remotes"],
    },
    withOrigin: {
      pending: [undefined, "Checking branch…"],
      failed: [undefined, STATUS_READ_FAILED_REASON],
      loaded: [undefined, undefined],
    },
  };
  for (const [rName, r] of Object.entries(remotesStates))
    for (const [sName, st] of Object.entries(statusStates)) {
      const s = deriveSyncControls(input({ ...r, ...st }));
      const [fetchReason, branchReason] = expected[rName][sName];
      const cell = `remotes ${rName}, status ${sName}`;
      assert.equal(s.fetch.reason, fetchReason, cell);
      for (const h of [s.pull, s.push, s.pullOptions])
        assert.equal(h.reason, branchReason, cell);
    }
});

test("(4) synced with an upstream: Push and Pull enabled, bare names", () => {
  const s = deriveSyncControls(input());
  assert.equal(s.pushLabel, "Push");
  assert.equal(s.pushName, "Push");
  assert.equal(s.pullName, "Pull");
  assert.equal(s.push.disabled, false);
  assert.equal(s.pull.disabled, false);
  assert.equal(s.pullOptions.disabled, false);
  assert.deepEqual(s.hotkeys, {
    fetch: true,
    pull: true,
    push: true,
    updateFromUpstream: false,
  });
});

test("(5) ahead 3 / behind 2 reads as diverged: Force push, Pull held", () => {
  const s = deriveSyncControls(input({ head: head({ ahead: 3, behind: 2 }) }));
  assert.equal(s.diverged, true);
  assert.equal(s.pushLabel, "Force push");
  assert.equal(s.pushName, "Force push — 3 commits to push to origin/feature");
  assert.equal(
    s.pullName,
    "Pull — branch has diverged (2 commits behind origin/feature); use Pull with rebase or merge from the menu",
  );
  assert.deepEqual(s.pull, { disabled: true, reason: s.pullName });
  assert.equal(s.push.disabled, false);
  assert.equal(s.hotkeys.pull, false);
  assert.equal(s.hotkeys.push, true);
});

test("ahead-only and behind-only counts ride the names", () => {
  const ahead = deriveSyncControls(input({ head: head({ ahead: 1 }) }));
  assert.equal(ahead.pushName, "Push — 1 commit to push to origin/feature");
  assert.equal(ahead.pullName, "Pull");
  const behind = deriveSyncControls(input({ head: head({ behind: 2 }) }));
  assert.equal(behind.pullName, "Pull — 2 commits to pull from origin/feature");
  assert.equal(behind.pull.disabled, false);
});

test("(6) no upstream: Publish branch, Pull held with the no-upstream text", () => {
  const s = deriveSyncControls(input({ head: head({ upstream: null }) }));
  assert.equal(s.pushLabel, "Publish branch");
  assert.equal(s.pushName, "Publish branch");
  assert.equal(s.push.disabled, false);
  assert.deepEqual(s.pull, {
    disabled: true,
    reason:
      "Pull — no upstream branch to pull from yet; publish the branch first",
  });
  assert.deepEqual(s.pullOptions, {
    disabled: true,
    reason: PULL_OPTIONS_UNPUBLISHED_REASON,
  });
  assert.equal(s.hotkeys.push, true);
  assert.equal(s.hotkeys.pull, false);
});

test("(7) upstream gone: Publish branch, Pull says the remote branch was deleted", () => {
  const s = deriveSyncControls(input({ head: head({ upstreamGone: true }) }));
  assert.equal(s.hasUpstream, false);
  assert.equal(s.pushLabel, "Publish branch");
  assert.deepEqual(s.pull, {
    disabled: true,
    reason:
      "Pull — upstream origin/feature was deleted on the remote (likely merged); use Publish branch to recreate it",
  });
});

test("(8) diverged with a rebased upstream: Force push names the replacement", () => {
  const s = deriveSyncControls(
    input({ head: head({ ahead: 2, behind: 2 }), remoteRebased: true }),
  );
  assert.equal(s.pushLabel, "Force push");
  assert.equal(
    s.pushName,
    "Force push — origin/feature already has your commits under different ids; force pushing would replace them with your copies",
  );
  assert.equal(
    s.pullName,
    'Pull — origin/feature already has your commits under different ids; use "Reset to origin/feature" from the Pull menu',
  );
  const mixed = deriveSyncControls(
    input({
      head: head({ ahead: 2, behind: 2 }),
      mixedRewrite: true,
      localAtRisk: 1,
    }),
  );
  assert.equal(
    mixed.pullName,
    "Pull — origin/feature already has some of your commits under different ids and you have 1 it doesn't; use Pull with rebase from the menu",
  );
});

test("(9) detached HEAD: Push and Pull held, caret explains it too", () => {
  const s = deriveSyncControls(
    input({
      head: head({ name: null, detached: true, upstream: null }),
      remotes: ["origin", "upstream"],
    }),
  );
  const pullText =
    "Pull — you're on a detached HEAD; check out a branch to pull";
  assert.deepEqual(s.push, {
    disabled: true,
    reason:
      "Publish branch — you're on a detached HEAD; check out a branch to push",
  });
  assert.deepEqual(s.pull, { disabled: true, reason: pullText });
  assert.deepEqual(s.pullOptions, { disabled: true, reason: pullText });
  assert.equal(s.canUpdateUpstream, false);
  assert.deepEqual(s.hotkeys, { ...NO_HOTKEYS, fetch: true });
});

test("(9b) a branch with no commits: Publish branch held until the first commit", () => {
  const unborn = head({ name: "main", oid: null, upstream: null });
  const s = deriveSyncControls(input({ head: unborn }));
  assert.equal(s.pushLabel, "Publish branch");
  assert.deepEqual(s.push, {
    disabled: true,
    reason:
      "Publish branch — main has no commits yet; make your first commit to publish it",
  });
  assert.equal(s.pushName, s.push.reason);
  assert.equal(s.hotkeys.push, false);
  assert.equal(s.hotkeys.fetch, true);
  // Offline still outranks the state's own description.
  const offline = deriveSyncControls(
    input({ head: unborn, offlineHold: "offline" }),
  );
  assert.deepEqual(offline.push, { disabled: true, reason: "offline" });
});

test("(9c) an unborn branch with an upstream: Pull never claims the remote branch's state", () => {
  const s = deriveSyncControls(
    input({
      head: head({
        name: "main",
        oid: null,
        upstream: "origin/main",
        upstreamGone: true,
      }),
    }),
  );
  assert.equal(s.hasUpstream, false);
  assert.deepEqual(s.pull, {
    disabled: true,
    reason:
      "Pull — main has no commits yet, so it can't be compared with origin/main",
  });
  assert.deepEqual(s.push, {
    disabled: true,
    reason:
      "Publish branch — main has no commits yet; make your first commit to publish it",
  });
  assert.equal(s.hotkeys.push, false);
  assert.equal(s.hotkeys.pull, false);
});

test("(9d) unborn detection is strict: only oid === null on a branch", () => {
  // A fixture with no oid key, and one with a real oid, both read as born.
  for (const h0 of [head(), head({ oid: "0123abc" })]) {
    const s = deriveSyncControls(input({ head: h0 }));
    assert.deepEqual(s.push, { disabled: false, reason: undefined });
    assert.equal(s.hotkeys.push, true);
  }
  const gone = deriveSyncControls(
    input({ head: head({ upstreamGone: true }) }),
  );
  assert.match(gone.pull.reason, /was deleted on the remote/);
  // A detached HEAD keeps its own arm, oid or not.
  const detached = deriveSyncControls(
    input({
      head: head({ name: null, detached: true, upstream: null, oid: null }),
    }),
  );
  assert.equal(
    detached.push.reason,
    "Publish branch — you're on a detached HEAD; check out a branch to push",
  );
});

test("(10) fork with an upstream remote while status is pending: no update", () => {
  const s = deriveSyncControls(
    input({ head: undefined, remotes: ["origin", "upstream"] }),
  );
  assert.equal(s.hasUpstreamRemote, true);
  assert.equal(s.hotkeys.updateFromUpstream, false);
  assert.deepEqual(s.pullOptions, {
    disabled: true,
    reason: "Checking branch…",
  });
  const settled = deriveSyncControls(
    input({ head: head({ upstream: null }), remotes: ["origin", "upstream"] }),
  );
  assert.equal(settled.hotkeys.updateFromUpstream, true);
  // The menu still has "Update from upstream" to show.
  assert.deepEqual(settled.pullOptions, { disabled: false, reason: undefined });
});

test("hold precedence: busy > offline > unknown read > description", () => {
  const busy = deriveSyncControls(
    input({ head: undefined, busy: true, offlineHold: "offline" }),
  );
  for (const h of [busy.fetch, busy.pull, busy.push, busy.pullOptions])
    assert.deepEqual(h, { disabled: true, reason: SYNC_BUSY_REASON });
  const offline = deriveSyncControls(
    input({ head: undefined, offlineHold: "offline" }),
  );
  for (const h of [offline.fetch, offline.pull, offline.push])
    assert.deepEqual(h, { disabled: true, reason: "offline" });
  // The caret stays live offline; its items carry their own holds.
  assert.deepEqual(offline.pullOptions, {
    disabled: true,
    reason: "Checking branch…",
  });
  assert.deepEqual(
    deriveSyncControls(input({ offlineHold: "offline" })).pullOptions,
    { disabled: false, reason: undefined },
  );
  assert.deepEqual(offline.hotkeys, NO_HOTKEYS);
  // An unknown read outranks the head's own description: a detached head's
  // Pull and Push texts wait behind the remotes read.
  const unknown = deriveSyncControls(
    input({
      head: head({ name: null, detached: true, upstream: null }),
      remotes: undefined,
    }),
  );
  assert.ok(unknown.pullDescription);
  assert.ok(unknown.pushDescription);
  for (const h of [unknown.pull, unknown.push, unknown.pullOptions])
    assert.deepEqual(h, { disabled: true, reason: "Checking remotes…" });
});

test("no origin: the cluster yields to Publish and no sync hotkey fires", () => {
  const s = deriveSyncControls(input({ remotes: [] }));
  assert.equal(s.noOrigin, true);
  assert.equal(s.hasOrigin, false);
  assert.deepEqual(s.hotkeys, NO_HOTKEYS);
});

test("every disabled control carries a reason", () => {
  const heads = [
    undefined,
    head(),
    head({ upstream: null }),
    head({ upstreamGone: true }),
    head({ ahead: 1, behind: 1 }),
    head({ name: null, detached: true, upstream: null }),
    head({ oid: null, upstream: null }),
    head({ oid: null, upstreamGone: true }),
  ];
  for (const h of heads)
    for (const remotes of [undefined, ["origin"], ["origin", "upstream"]])
      for (const statusError of [false, true])
        for (const remotesError of [false, true])
          for (const busy of [false, true])
            for (const offlineHold of [undefined, "offline"]) {
              const s = deriveSyncControls(
                input({
                  head: h,
                  remotes,
                  statusError,
                  remotesError,
                  busy,
                  offlineHold,
                }),
              );
              for (const hold of [s.fetch, s.pull, s.push, s.pullOptions])
                if (hold.disabled) assert.ok(hold.reason, JSON.stringify(s));
            }
});

test("Publish branch only for a measured, untracked, non-diverged branch", () => {
  const heads = [
    undefined,
    head(),
    head({ upstream: null }),
    head({ upstreamGone: true }),
    head({ upstream: null, ahead: 1, behind: 1 }),
  ];
  for (const h of heads) {
    const s = deriveSyncControls(input({ head: h }));
    assert.equal(
      s.pushLabel === "Publish branch",
      s.statusKnown && !s.hasUpstream && !s.diverged,
    );
  }
});
