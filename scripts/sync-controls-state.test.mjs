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
  SYNC_BUSY_REASON,
} from "../src/features/repository/sync-controls-state.ts";

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
      reason: "Couldn't read the branch status",
    });
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
  ];
  for (const h0 of heads)
    for (const statusError of [false, true]) {
      const s = deriveSyncControls(
        input({ head: h0, statusError, remotes: undefined }),
      );
      assert.equal(s.remotesKnown, false);
      assert.equal(s.noOrigin, false);
      for (const h of [s.fetch, s.pull, s.push, s.pullOptions])
        assert.deepEqual(h, { disabled: true, reason: "Checking remotes…" });
      assert.deepEqual(s.hotkeys, NO_HOTKEYS);
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
  ];
  for (const h of heads)
    for (const remotes of [undefined, ["origin"], ["origin", "upstream"]])
      for (const statusError of [false, true])
        for (const busy of [false, true])
          for (const offlineHold of [undefined, "offline"]) {
            const s = deriveSyncControls(
              input({ head: h, remotes, statusError, busy, offlineHold }),
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
