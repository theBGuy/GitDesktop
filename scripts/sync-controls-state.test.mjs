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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  deriveMismatchMenu,
  deriveSyncControls,
  forceConfirmKeptBranch,
  KEPT_LOCAL_PULL_REASON,
  KEPT_LOCAL_SUFFIX,
  keptLocalReason,
  PULL_OPTIONS_UNPUBLISHED_REASON,
  REMOTES_FAILED_REASON,
  REMOTES_PENDING_REASON,
  rowNameMismatch,
  rowSyncIndicator,
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
  upstreamRemote: null,
  upstreamBranch: null,
  pushNameMismatch: false,
  upstreamIsRemoteDefault: null,
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
  remoteNewExists: false,
  keptLocal: false,
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

test("(9b) a branch with no commits: Publish branch held until the first commit, and Pull says so", () => {
  const unborn = head({ name: "main", oid: null, upstream: null });
  const s = deriveSyncControls(input({ head: unborn }));
  assert.equal(s.pushLabel, "Publish branch");
  assert.deepEqual(s.push, {
    disabled: true,
    reason:
      "Publish branch — main has no commits yet; make your first commit to publish it",
  });
  assert.equal(s.pushName, s.push.reason);
  // Neither Pull nor the caret points at the held Publish.
  assert.deepEqual(s.pull, {
    disabled: true,
    reason:
      "Pull — main has no commits yet; make your first commit, then publish the branch",
  });
  assert.deepEqual(s.pullOptions, { disabled: true, reason: s.pull.reason });
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
  assert.deepEqual(s.pullOptions, { disabled: true, reason: s.pull.reason });
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

test("busy reason: the sync reason by default, the caller's when given, none when idle", () => {
  const controls = (d) => [d.fetch, d.pull, d.push, d.pullOptions];
  for (const h of controls(deriveSyncControls(input({ busy: true }))))
    assert.deepEqual(h, { disabled: true, reason: SYNC_BUSY_REASON });
  const custom = deriveSyncControls(
    input({ busy: true, busyReason: "A push is running." }),
  );
  for (const h of controls(custom))
    assert.deepEqual(h, { disabled: true, reason: "A push is running." });
  // The reason never changes what is held: the hotkeys still read `busy` alone.
  assert.deepEqual(custom.hotkeys, NO_HOTKEYS);
  const idle = deriveSyncControls(input({ busyReason: "A push is running." }));
  for (const h of controls(idle))
    assert.deepEqual(h, { disabled: false, reason: undefined });
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

// A renamed tracking branch: local feat/y tracks origin/feat/x, and the backend
// says a bare push would be refused for the differing names.
const renamed = (over = {}) =>
  head({
    name: "feat/y",
    upstream: "origin/feat/x",
    upstreamRemote: "origin",
    upstreamBranch: "feat/x",
    pushNameMismatch: true,
    upstreamIsRemoteDefault: false,
    ahead: 1,
    ...over,
  });

test("mismatch: Push opens a menu of named destinations, its description says why", () => {
  const two = deriveSyncControls(input({ head: renamed({ ahead: 2 }) }));
  assert.equal(two.mismatch, true);
  assert.equal(two.pushLabel, "Push");
  assert.equal(
    two.pushName,
    "Push — 2 commits to push; feat/y tracks origin/feat/x, which has a different name — choose where from the menu",
  );
  assert.deepEqual(two.mismatchMenu, {
    branch: "feat/y",
    remote: "origin",
    remoteBranch: "feat/x",
    groupLabel: "feat/y tracks origin/feat/x",
    pushToTracked: { label: "Push to origin/feat/x", disabled: false },
    publish: { label: "Publish as origin/feat/y", disabled: false },
  });
  assert.deepEqual(two.push, { disabled: false, reason: two.pushName });
  assert.equal(two.hotkeys.push, true);
  const one = deriveSyncControls(input({ head: renamed({ ahead: 1 }) }));
  assert.equal(
    one.pushName,
    "Push — 1 commit to push; feat/y tracks origin/feat/x, which has a different name — choose where from the menu",
  );
  // Nothing ahead drops the count clause and holds the tracked item.
  const zero = deriveSyncControls(input({ head: renamed({ ahead: 0 }) }));
  assert.equal(
    zero.pushName,
    "Push — feat/y tracks origin/feat/x, which has a different name — choose where from the menu",
  );
  assert.deepEqual(zero.mismatchMenu.pushToTracked, {
    label: "Push to origin/feat/x (nothing to push)",
    disabled: true,
  });
  // Publishing is still on offer, so the trigger stays live.
  assert.equal(zero.push.disabled, false);
  assert.equal(zero.hotkeys.push, true);
});

test("mismatch: the tracked item is omitted only for the remote's known default branch", () => {
  const onDefault = deriveSyncControls(
    input({
      head: renamed({
        name: "topic",
        upstream: "origin/main",
        upstreamBranch: "main",
        upstreamIsRemoteDefault: true,
      }),
    }),
  );
  assert.equal(onDefault.mismatchMenu.pushToTracked, null);
  assert.deepEqual(onDefault.mismatchMenu.publish, {
    label: "Publish as origin/topic",
    disabled: false,
  });
  for (const unknownOrNot of [false, null]) {
    const s = deriveSyncControls(
      input({ head: renamed({ upstreamIsRemoteDefault: unknownOrNot }) }),
    );
    assert.deepEqual(s.mismatchMenu.pushToTracked, {
      label: "Push to origin/feat/x",
      disabled: false,
    });
  }
  // Unknown is not exempt: behind still holds the publish item.
  const unknown = deriveSyncControls(
    input({ head: renamed({ upstreamIsRemoteDefault: null, behind: 1 }) }),
  );
  assert.deepEqual(unknown.mismatchMenu.publish, {
    label: "Publish as origin/feat/y (pull first)",
    disabled: true,
  });
});

test("mismatch beats divergence: no Force push, the tracked push and publish hold", () => {
  const s = deriveSyncControls(
    input({ head: renamed({ ahead: 2, behind: 1 }), remoteRebased: true }),
  );
  assert.equal(s.diverged, true);
  assert.equal(s.pushLabel, "Push");
  assert.equal(
    s.pushName,
    "Push — 2 commits to push; feat/y tracks origin/feat/x, which has a different name — use the Pull menu first",
  );
  assert.deepEqual(s.mismatchMenu.pushToTracked, {
    label: "Push to origin/feat/x (diverged — use the Pull menu first)",
    disabled: true,
  });
  assert.deepEqual(s.mismatchMenu.publish, {
    label: "Publish as origin/feat/y (pull first)",
    disabled: true,
  });
  // Everything held: the trigger itself holds with the description, and so
  // does the hotkey.
  assert.deepEqual(s.push, { disabled: true, reason: s.pushName });
  assert.equal(s.hotkeys.push, false);
});

test("mismatch: behind holds the publish item whether or not diverged, except on the remote's default branch", () => {
  const behind = deriveSyncControls(
    input({ head: renamed({ ahead: 0, behind: 1 }) }),
  );
  assert.deepEqual(behind.mismatchMenu.publish, {
    label: "Publish as origin/feat/y (pull first)",
    disabled: true,
  });
  // Nothing to push and the publish held: the whole menu is held.
  assert.deepEqual(behind.push, { disabled: true, reason: behind.pushName });
  assert.equal(behind.hotkeys.push, false);
  // On the remote's default branch the commits behind are that branch's own,
  // so the publish item stays live, diverged included, and so does the trigger.
  const onDefault = deriveSyncControls(
    input({
      head: renamed({ ahead: 1, behind: 1, upstreamIsRemoteDefault: true }),
    }),
  );
  assert.equal(onDefault.mismatchMenu.pushToTracked, null);
  assert.deepEqual(onDefault.mismatchMenu.publish, {
    label: "Publish as origin/feat/y",
    disabled: false,
  });
  assert.equal(onDefault.push.disabled, false);
  assert.equal(onDefault.hotkeys.push, true);
  // Ahead-only with the tracked item live keeps the trigger live.
  const aheadOnly = deriveSyncControls(input({ head: renamed({ ahead: 1 }) }));
  assert.equal(aheadOnly.push.disabled, false);
});

test("mismatch: an all-held menu's trigger names the pull remedy, never the menu", () => {
  // checkout -b topic origin/main, then fall behind: the tracked item is omitted
  // and the publish item stays live, so the menu still has a choice.
  const behindOnDefault = deriveSyncControls(
    input({
      head: renamed({
        name: "topic",
        upstream: "origin/main",
        upstreamBranch: "main",
        upstreamIsRemoteDefault: true,
        ahead: 0,
        behind: 1,
      }),
    }),
  );
  assert.equal(behindOnDefault.mismatchMenu.pushToTracked, null);
  assert.equal(
    behindOnDefault.pushName,
    "Push — topic tracks origin/main, which has a different name — choose where from the menu",
  );
  assert.deepEqual(behindOnDefault.push, {
    disabled: false,
    reason: behindOnDefault.pushName,
  });
  assert.deepEqual(behindOnDefault.mismatchMenu.publish, {
    label: "Publish as origin/topic",
    disabled: false,
  });
  // Behind with nothing to push: both items held, not diverged.
  const behind = deriveSyncControls(
    input({ head: renamed({ ahead: 0, behind: 2 }) }),
  );
  assert.equal(
    behind.push.reason,
    "Push — feat/y tracks origin/feat/x, which has a different name — pull first",
  );
  // Diverged on the default branch: the publish item is live, so the menu opens.
  const diverged = deriveSyncControls(
    input({
      head: renamed({ ahead: 1, behind: 1, upstreamIsRemoteDefault: true }),
    }),
  );
  assert.deepEqual(diverged.push, {
    disabled: false,
    reason:
      "Push — 1 commit to push; feat/y tracks origin/feat/x, which has a different name — choose where from the menu",
  });
  // Diverged on another branch: the count clause stays and the remedy points
  // at the Pull menu.
  const divergedOther = deriveSyncControls(
    input({ head: renamed({ ahead: 1, behind: 1 }) }),
  );
  assert.deepEqual(divergedOther.push, {
    disabled: true,
    reason:
      "Push — 1 commit to push; feat/y tracks origin/feat/x, which has a different name — use the Pull menu first",
  });
  // Any enabled item keeps the menu wording.
  for (const h of [renamed({ ahead: 1 }), renamed({ ahead: 0 })]) {
    const s = deriveSyncControls(input({ head: h }));
    assert.equal(s.push.disabled, false);
    assert.match(s.pushName, / — choose where from the menu$/);
  }
});

test("mismatch: an existing remote branch under the new name relabels the publish item", () => {
  const s = deriveSyncControls(
    input({ head: renamed(), remoteNewExists: true }),
  );
  assert.deepEqual(s.mismatchMenu.publish, {
    label: "Push to origin/feat/y and track it",
    disabled: false,
  });
  const held = deriveSyncControls(
    input({ head: renamed({ behind: 1 }), remoteNewExists: true }),
  );
  assert.equal(
    held.mismatchMenu.publish.label,
    "Push to origin/feat/y and track it (pull first)",
  );
  const onDefault = deriveSyncControls(
    input({
      head: renamed({ behind: 1, upstreamIsRemoteDefault: true }),
      remoteNewExists: true,
    }),
  );
  assert.deepEqual(onDefault.mismatchMenu.publish, {
    label: "Push to origin/feat/y and track it",
    disabled: false,
  });
});

test("mismatch: busy, offline, and an unknown read keep their precedence over the description", () => {
  const busy = deriveSyncControls(
    input({ head: renamed(), busy: true, offlineHold: "offline" }),
  );
  assert.deepEqual(busy.push, { disabled: true, reason: SYNC_BUSY_REASON });
  assert.equal(busy.hotkeys.push, false);
  const offline = deriveSyncControls(
    input({ head: renamed(), offlineHold: "offline" }),
  );
  assert.deepEqual(offline.push, { disabled: true, reason: "offline" });
  assert.equal(offline.hotkeys.push, false);
  const unread = deriveSyncControls(
    input({ head: renamed(), remotes: undefined }),
  );
  assert.deepEqual(unread.push, {
    disabled: true,
    reason: REMOTES_PENDING_REASON,
  });
});

test("no mismatch without the backend's verdict, a live upstream, and both names", () => {
  const cases = [
    renamed({ pushNameMismatch: false }),
    renamed({ upstreamGone: true }),
    renamed({ upstreamRemote: null }),
    renamed({ upstreamBranch: null }),
    renamed({ upstream: null }),
  ];
  for (const h of cases) {
    const s = deriveSyncControls(input({ head: h }));
    assert.equal(s.mismatch, false, JSON.stringify(h));
    assert.equal(s.mismatchMenu, null);
  }
  // Without a mismatch, a diverged branch keeps its Force push.
  const forced = deriveSyncControls(
    input({ head: renamed({ pushNameMismatch: false, ahead: 1, behind: 1 }) }),
  );
  assert.equal(forced.pushLabel, "Force push");
  assert.equal(
    deriveSyncControls(input({ head: undefined })).mismatchMenu,
    null,
  );
});

test("a push git sends somewhere other than the upstream names that destination", () => {
  const facts = {
    upstream: "origin/main",
    upstreamRemote: "origin",
    upstreamBranch: "main",
  };
  // Resolved and different: the destination, with no upstream-relative count,
  // at any count (the push still sends at zero).
  for (const ahead of [0, 1, 3]) {
    const s = deriveSyncControls(
      input({
        head: head({
          ...facts,
          ahead,
          pushRemote: "fork",
          pushBranch: "feature",
        }),
      }),
    );
    assert.equal(s.pushName, "Push to fork/feature", String(ahead));
    assert.ok(s.pushName.startsWith(s.pushLabel), "starts with the label");
    assert.deepEqual(s.push, { disabled: false, reason: s.pushName });
  }
  // Same remote, another branch.
  assert.equal(
    deriveSyncControls(
      input({
        head: head({
          ...facts,
          ahead: 2,
          pushRemote: "origin",
          pushBranch: "feature",
        }),
      }),
    ).pushName,
    "Push to origin/feature",
  );
  // Resolved to the upstream itself, or unresolved (null or absent): unchanged.
  for (const dest of [
    { pushRemote: "origin", pushBranch: "main" },
    { pushRemote: null, pushBranch: null },
    { pushRemote: "fork", pushBranch: null },
    {},
  ]) {
    const s = deriveSyncControls(
      input({ head: head({ ...facts, ahead: 2, ...dest }) }),
    );
    assert.equal(
      s.pushName,
      "Push — 2 commits to push to origin/main",
      JSON.stringify(dest),
    );
    const zero = deriveSyncControls(
      input({ head: head({ ...facts, ...dest }) }),
    );
    assert.equal(zero.pushName, "Push", JSON.stringify(dest));
  }
  // Force push keeps its own copy, destination or not.
  const diverged = deriveSyncControls(
    input({
      head: head({
        ...facts,
        ahead: 1,
        behind: 1,
        pushRemote: "fork",
        pushBranch: "feature",
      }),
    }),
  );
  assert.equal(
    diverged.pushName,
    "Force push — 1 commit to push to origin/main",
  );
  // A gone upstream publishes, whatever a stale destination says.
  const gone = deriveSyncControls(
    input({
      head: head({
        ...facts,
        upstreamGone: true,
        pushRemote: "fork",
        pushBranch: "feature",
      }),
    }),
  );
  assert.equal(gone.pushLabel, "Publish branch");
  assert.equal(gone.pushName, "Publish branch");
});

// Keep local: HEAD's branch-list row is marked, so every push of it is held
// with one reason that outranks every transient one.
const KEPT_PUSH = keptLocalReason("feature", "push");

test("Keep local: the reason's two spellings", () => {
  assert.equal(
    KEPT_PUSH,
    "feature is kept local. Turn off Keep local in the branch menu to push it.",
  );
  assert.equal(
    keptLocalReason("feature", "publish"),
    "feature is kept local. Turn off Keep local in the branch menu to publish it.",
  );
  assert.equal(KEPT_LOCAL_SUFFIX, " (kept local)");
});

test("Keep local holds Push, Publish branch and Force push, each naming its verb", () => {
  const rows = [
    ["tracked", head({ ahead: 2 }), "Push", "push"],
    ["untracked", head({ upstream: null }), "Publish branch", "publish"],
    ["gone", head({ upstreamGone: true }), "Publish branch", "publish"],
    ["diverged", head({ ahead: 2, behind: 1 }), "Force push", "push"],
  ];
  for (const [what, h, label, verb] of rows) {
    const d = deriveSyncControls(input({ head: h, keptLocal: true }));
    const reason = keptLocalReason("feature", verb);
    assert.equal(d.pushLabel, label, what);
    assert.equal(d.pushKeptLocalReason, reason, what);
    assert.deepEqual(d.push, { disabled: true, reason }, what);
    assert.equal(d.pushName, `${label} — ${reason}`, what);
    assert.equal(d.hotkeys.push, true, what);
  }
});

test("Keep local outranks busy, offline and an unknown remotes read", () => {
  const rows = [
    ["busy", { busy: true }],
    ["offline", { offlineHold: "You're offline" }],
    ["remotes pending", { remotes: undefined }],
    ["remotes failed", { remotes: undefined, remotesError: true }],
  ];
  for (const [what, over] of rows) {
    const held = deriveSyncControls(
      input({ head: head({ ahead: 1 }), keptLocal: true, ...over }),
    );
    assert.deepEqual(held.push, { disabled: true, reason: KEPT_PUSH }, what);
    assert.equal(held.hotkeys.push, true, what);
    const plain = deriveSyncControls(
      input({ head: head({ ahead: 1 }), ...over }),
    );
    assert.notEqual(plain.push.reason, KEPT_PUSH, what);
    assert.equal(plain.hotkeys.push, false, what);
  }
});

// With no origin the bar shows only Publish repository, so a toast naming the
// branch menu's Keep local would point at a control that isn't there.
test("Keep local's live push key needs an origin", () => {
  const rows = [
    ["tracked", head({ ahead: 1 })],
    ["untracked", head({ upstream: null })],
  ];
  for (const [what, h] of rows) {
    const bare = deriveSyncControls(
      input({ head: h, keptLocal: true, remotes: [] }),
    );
    assert.equal(bare.hotkeys.push, false, `no remotes, ${what}`);
    const other = deriveSyncControls(
      input({ head: h, keptLocal: true, remotes: ["upstream"] }),
    );
    assert.equal(other.hotkeys.push, false, `no origin, ${what}`);
    const withOrigin = deriveSyncControls(input({ head: h, keptLocal: true }));
    assert.equal(withOrigin.hotkeys.push, true, `origin, ${what}`);
    // Unmarked, the key reads exactly as before.
    const plain = deriveSyncControls(input({ head: h, remotes: [] }));
    assert.equal(plain.hotkeys.push, false, `unmarked no origin, ${what}`);
    const plainOrigin = deriveSyncControls(input({ head: h }));
    assert.equal(plainOrigin.hotkeys.push, true, `unmarked origin, ${what}`);
  }
});

test("Keep local holds both mismatch items and names no mismatch remedy", () => {
  const rows = [
    ["ahead", renamed({ ahead: 2 })],
    ["behind only", renamed({ ahead: 0, behind: 1 })],
    ["diverged", renamed({ ahead: 1, behind: 1 })],
  ];
  for (const [what, h] of rows) {
    const d = deriveSyncControls(input({ head: h, keptLocal: true }));
    const reason = keptLocalReason("feat/y", "push");
    assert.deepEqual(
      d.mismatchMenu?.pushToTracked,
      { label: "Push to origin/feat/x (kept local)", disabled: true },
      what,
    );
    assert.deepEqual(
      d.mismatchMenu?.publish,
      { label: "Publish as origin/feat/y (kept local)", disabled: true },
      what,
    );
    assert.deepEqual(d.push, { disabled: true, reason }, what);
    assert.equal(d.pushName, `Push — ${reason}`, what);
    for (const banned of ["pull first", "Pull menu", "choose where", "commit"])
      assert.ok(!d.pushName.includes(banned), `${what}: ${banned}`);
  }
  const onDefault = deriveSyncControls(
    input({
      head: renamed({ upstreamIsRemoteDefault: true, behind: 1 }),
      remoteNewExists: true,
      keptLocal: true,
    }),
  );
  assert.equal(onDefault.mismatchMenu?.pushToTracked, null);
  assert.deepEqual(onDefault.mismatchMenu?.publish, {
    label: "Push to origin/feat/y and track it (kept local)",
    disabled: true,
  });
});

test("Keep local's pushName never carries another arm's remedy or count", () => {
  const rows = [
    head({ ahead: 3 }),
    head({ upstream: null }),
    head({ ahead: 2, behind: 2 }),
    head({ ahead: 1, behind: 1, upstreamGone: false }),
    renamed({ ahead: 0, behind: 1 }),
    renamed({ ahead: 1, behind: 1 }),
  ];
  for (const h of rows) {
    const d = deriveSyncControls(input({ head: h, keptLocal: true }));
    assert.match(
      d.pushName,
      /is kept local\. Turn off Keep local in the branch menu to (push|publish) it\.$/,
    );
    for (const banned of [
      "pull first",
      "Pull menu",
      "choose where",
      "to push to",
    ])
      assert.ok(!d.pushName.includes(banned), `${d.pushName}: ${banned}`);
  }
});

test("Keep local holds nothing without a named HEAD", () => {
  for (const [what, over] of [
    ["status unknown", { head: undefined }],
    [
      "detached",
      { head: head({ name: null, detached: true, upstream: null }) },
    ],
  ]) {
    const d = deriveSyncControls(input({ ...over, keptLocal: true }));
    const plain = deriveSyncControls(input(over));
    assert.equal(d.pushKeptLocalReason, undefined, what);
    assert.deepEqual(d.push, plain.push, what);
    assert.equal(d.pushName, plain.pushName, what);
    assert.deepEqual(d.hotkeys, plain.hotkeys, what);
  }
});

test("an unmarked (or stale, or unloaded) list's false holds nothing", () => {
  const d = deriveSyncControls(
    input({ head: head({ ahead: 2 }), keptLocal: false }),
  );
  assert.equal(d.pushKeptLocalReason, undefined);
  assert.deepEqual(d.push, {
    disabled: false,
    reason: "Push — 2 commits to push to origin/feature",
  });
  assert.equal(d.pushName, "Push — 2 commits to push to origin/feature");
  assert.equal(d.hotkeys.push, true);
  const m = deriveSyncControls(
    input({ head: renamed({ ahead: 2 }), keptLocal: false }),
  );
  assert.deepEqual(m.mismatchMenu?.publish, {
    label: "Publish as origin/feat/y",
    disabled: false,
  });
});

// The shared mismatch derivation, called directly as the branch menu calls it.
const menuInput = (over = {}) => ({
  branch: "feat",
  remote: "origin",
  remoteBranch: "main",
  ahead: 0,
  behind: 0,
  upstreamIsRemoteDefault: true,
  remoteNewExists: false,
  keptLocal: false,
  ...over,
});
const LIVE = (label) => ({ label, disabled: false });
const HELD = (label) => ({ label, disabled: true });

/** Each [name, input overrides, pushToTracked, publish] row of the derivation. */
const MENU_ROWS = [
  ["default behind-only", { behind: 1 }, null, LIVE("Publish as origin/feat")],
  ["default ahead-only", { ahead: 2 }, null, LIVE("Publish as origin/feat")],
  [
    "default diverged",
    { ahead: 2, behind: 1 },
    null,
    LIVE("Publish as origin/feat"),
  ],
  [
    "other behind-only",
    { upstreamIsRemoteDefault: false, remoteBranch: "epic/x", behind: 1 },
    HELD("Push to origin/epic/x (nothing to push)"),
    HELD("Publish as origin/feat (pull first)"),
  ],
  [
    "other ahead-only",
    { upstreamIsRemoteDefault: false, remoteBranch: "epic/x", ahead: 2 },
    LIVE("Push to origin/epic/x"),
    LIVE("Publish as origin/feat"),
  ],
  [
    "other diverged",
    {
      upstreamIsRemoteDefault: false,
      remoteBranch: "epic/x",
      ahead: 2,
      behind: 1,
    },
    HELD("Push to origin/epic/x (diverged — use the Pull menu first)"),
    HELD("Publish as origin/feat (pull first)"),
  ],
  [
    "remote new exists",
    { behind: 1, remoteNewExists: true },
    null,
    LIVE("Push to origin/feat and track it"),
  ],
];

test("deriveMismatchMenu: a default upstream drops the push and never holds the publish for pull", () => {
  for (const [what, over, tracked, publish] of MENU_ROWS) {
    const m = deriveMismatchMenu(menuInput(over));
    assert.deepEqual(m.pushToTracked, tracked, what);
    assert.deepEqual(m.publish, publish, what);
    assert.equal(m.groupLabel, `feat tracks origin/${m.remoteBranch}`, what);
  }
});

test("deriveMismatchMenu: Keep local holds both items over every other hold", () => {
  for (const [what, over, tracked, publish] of MENU_ROWS) {
    const m = deriveMismatchMenu(menuInput({ ...over, keptLocal: true }));
    const base = (label) =>
      label.replace(/ \((?:nothing|diverged|pull).*$/, "");
    assert.deepEqual(
      m.pushToTracked,
      tracked && HELD(`${base(tracked.label)}${KEPT_LOCAL_SUFFIX}`),
      what,
    );
    assert.deepEqual(
      m.publish,
      HELD(`${base(publish.label)}${KEPT_LOCAL_SUFFIX}`),
      what,
    );
  }
});

const rowFacts = (over = {}) => ({
  name: "feat",
  upstream: "origin/main",
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamBranch: "main",
  upstreamAhead: 0,
  upstreamBehind: 0,
  upstreamIsRemoteDefault: true,
  keepLocal: false,
  ...over,
});
const REMOTES = ["origin", "up"];

test("rowNameMismatch: only a live upstream on a configured remote under another name", () => {
  const nulls = [
    ["same name", { upstream: "origin/feat", upstreamBranch: "feat" }],
    ["gone", { upstreamGone: true }],
    [
      "local .",
      { upstream: "main", upstreamRemote: ".", upstreamBranch: "main" },
    ],
    ["removed remote", { upstream: "old/main", upstreamRemote: "old" }],
    [
      "non-branch ref",
      { upstream: "origin/pull/7/head", upstreamBranch: null },
    ],
    [
      "no upstream",
      { upstream: null, upstreamRemote: null, upstreamBranch: null },
    ],
  ];
  for (const [what, over] of nulls)
    assert.equal(rowNameMismatch(rowFacts(over), REMOTES), null, what);
  assert.deepEqual(rowNameMismatch(rowFacts(), REMOTES), {
    remote: "origin",
    remoteBranch: "main",
    isRemoteDefault: true,
  });
  assert.deepEqual(
    rowNameMismatch(
      rowFacts({
        upstream: "up/epic/x",
        upstreamRemote: "up",
        upstreamBranch: "epic/x",
        upstreamIsRemoteDefault: false,
      }),
      REMOTES,
    ),
    { remote: "up", remoteBranch: "epic/x", isRemoteDefault: false },
  );
});

const START =
  "Not published. Tracks origin/main, where it started. Right-click to publish.";

test("rowSyncIndicator: every kind, with today's labels", () => {
  const rows = [
    [
      "removed remote",
      rowFacts({ upstream: "old/main", upstreamRemote: "old" }),
      {
        kind: "removedRemote",
        label: "Tracks old/main, but that remote is no longer configured.",
      },
    ],
    [
      "start point",
      rowFacts({ upstreamAhead: 2, upstreamBehind: 1 }),
      { kind: "startPoint", label: START },
    ],
    ["start point 0/0", rowFacts(), { kind: "startPoint", label: START }],
    [
      "same name",
      rowFacts({
        upstream: "origin/feat",
        upstreamBranch: "feat",
        upstreamIsRemoteDefault: false,
        upstreamAhead: 2,
      }),
      {
        kind: "arrows",
        label: "2 to push — vs origin/feat",
        ahead: 2,
        behind: 0,
        upstreamName: null,
      },
    ],
    [
      "other name",
      rowFacts({
        upstream: "origin/epic/x",
        upstreamBranch: "epic/x",
        upstreamIsRemoteDefault: false,
        upstreamAhead: 2,
        upstreamBehind: 1,
      }),
      {
        kind: "arrows",
        label: "2 to push, 1 to pull — vs origin/epic/x",
        ahead: 2,
        behind: 1,
        upstreamName: "origin/epic/x",
      },
    ],
    [
      "other name 0/0",
      rowFacts({
        upstream: "origin/epic/x",
        upstreamBranch: "epic/x",
        upstreamIsRemoteDefault: false,
      }),
      { kind: "none" },
    ],
    [
      "local . upstream",
      rowFacts({
        upstream: "main",
        upstreamRemote: ".",
        upstreamIsRemoteDefault: false,
        upstreamBehind: 3,
      }),
      {
        kind: "arrows",
        label: "3 to pull — vs main",
        ahead: 0,
        behind: 3,
        upstreamName: null,
      },
    ],
    [
      "gone",
      rowFacts({ upstream: "origin/feat", upstreamGone: true }),
      {
        kind: "gone",
        label:
          "Upstream origin/feat was deleted on the remote — likely merged. Right-click to publish again or delete.",
      },
    ],
    [
      "never published",
      rowFacts({ upstream: null, upstreamRemote: null, upstreamBranch: null }),
      {
        kind: "neverPublished",
        label: "Local only — never published. Right-click to publish.",
      },
    ],
  ];
  for (const [what, row, want] of rows)
    assert.deepEqual(rowSyncIndicator(row, REMOTES, "Right-click"), want, what);
});

test("rowSyncIndicator: no kept-local marker advises publishing", () => {
  const kept = (over) => rowFacts({ ...over, keepLocal: true });
  assert.deepEqual(
    rowSyncIndicator(
      kept({ upstream: null, upstreamRemote: null, upstreamBranch: null }),
      REMOTES,
      "Right-click",
    ),
    { kind: "none" },
  );
  assert.deepEqual(
    rowSyncIndicator(kept({ upstreamAhead: 1 }), REMOTES, "Right-click"),
    { kind: "none" },
  );
  // C-gone-kept: the usual gone marker minus its publish advice.
  assert.deepEqual(
    rowSyncIndicator(
      kept({ upstream: "origin/feat/x", upstreamGone: true }),
      REMOTES,
      "Right-click",
    ),
    {
      kind: "gone",
      label:
        "Upstream origin/feat/x was deleted on the remote — likely merged.",
    },
  );
  // A live same-name upstream keeps its arrows.
  assert.equal(
    rowSyncIndicator(
      kept({
        upstream: "origin/feat",
        upstreamBranch: "feat",
        upstreamAhead: 1,
      }),
      REMOTES,
      "Right-click",
    ).kind,
    "arrows",
  );
});

const OWN_NAME_START =
  "Tracks origin/main, where it started. origin/feat exists. Right-click to track it.";
const NOT_PUBLISHED_START =
  "Not published. Tracks origin/main, where it started. Right-click to publish.";

test("rowSyncIndicator: a start point whose own name is on the remote points at tracking it", () => {
  for (const ownNameOnRemote of [true, false])
    for (const keepLocal of [true, false]) {
      const want = keepLocal
        ? { kind: "none" }
        : {
            kind: "startPoint",
            label: ownNameOnRemote ? OWN_NAME_START : NOT_PUBLISHED_START,
          };
      assert.deepEqual(
        rowSyncIndicator(
          rowFacts({ keepLocal }),
          REMOTES,
          "Right-click",
          ownNameOnRemote,
        ),
        want,
        `ownNameOnRemote=${ownNameOnRemote} keepLocal=${keepLocal}`,
      );
    }
  // The remote in the label is the upstream's own.
  assert.equal(
    rowSyncIndicator(
      rowFacts({ upstream: "up/main", upstreamRemote: "up" }),
      REMOTES,
      "Control-click",
      true,
    ).label,
    "Tracks up/main, where it started. up/feat exists. Control-click to track it.",
  );
  // A non-default mismatch keeps its arrows whatever the remote lists.
  assert.deepEqual(
    rowSyncIndicator(
      rowFacts({
        upstream: "origin/epic/x",
        upstreamBranch: "epic/x",
        upstreamIsRemoteDefault: false,
        upstreamAhead: 2,
      }),
      REMOTES,
      "Right-click",
      true,
    ),
    {
      kind: "arrows",
      label: "2 to push — vs origin/epic/x",
      ahead: 2,
      behind: 0,
      upstreamName: "origin/epic/x",
    },
  );
});

test("a mutant dropping the own-name start-point arm fails the row", async () => {
  const noOwnName = await mutant(
    "        label: ownNameOnRemote\n",
    "        label: false\n",
  );
  assert.notDeepEqual(
    noOwnName.rowSyncIndicator(rowFacts(), REMOTES, "Right-click", true),
    { kind: "startPoint", label: OWN_NAME_START },
  );
});

// In-memory mutants: the module text with one arm changed, imported from a
// scratch copy outside the repo (the module is import-free).
const MODULE_URL = new URL(
  "../src/features/repository/sync-controls-state.ts",
  import.meta.url,
);
async function mutant(from, to) {
  const src = readFileSync(MODULE_URL, "utf8").replace(/\r\n/g, "\n");
  assert.ok(src.includes(from), `mutant anchor missing: ${from}`);
  const dir = mkdtempSync(join(tmpdir(), "sync-controls-mutant-"));
  try {
    const file = join(dir, "sync-controls-state.ts");
    writeFileSync(file, src.replace(from, to));
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mutants dropping the default-upstream exemption or a Keep local arm fail the rows", async () => {
  const noExemption = await mutant(
    "case behind > 0 && !i.upstreamIsRemoteDefault:",
    "case behind > 0:",
  );
  assert.notDeepEqual(
    noExemption.deriveMismatchMenu(menuInput({ behind: 1 })).publish,
    LIVE("Publish as origin/feat"),
  );
  const noKeptPublish = await mutant(
    "      case keptLocal:\n        return { label: `${publishBase}${KEPT_LOCAL_SUFFIX}`, disabled: true };\n",
    "",
  );
  assert.notDeepEqual(
    noKeptPublish.deriveMismatchMenu(menuInput({ keptLocal: true })).publish,
    HELD(`Publish as origin/feat${KEPT_LOCAL_SUFFIX}`),
  );
  const noKeptStart = await mutant(
    '      if (row.keepLocal) return { kind: "none" };\n      return {\n        kind: "startPoint",',
    '      return {\n        kind: "startPoint",',
  );
  assert.notDeepEqual(
    noKeptStart.rowSyncIndicator(
      rowFacts({ keepLocal: true }),
      REMOTES,
      "Right-click",
    ),
    { kind: "none" },
  );
  const noTrackedOmit = await mutant(
    "    if (i.upstreamIsRemoteDefault) return null;\n",
    "",
  );
  assert.notEqual(
    noTrackedOmit.deriveMismatchMenu(menuInput({ ahead: 2 })).pushToTracked,
    null,
  );
  const noKeptTracked = await mutant(
    "    if (keptLocal)\n      return { label: `${tracked}${KEPT_LOCAL_SUFFIX}`, disabled: true };\n",
    "",
  );
  assert.notDeepEqual(
    noKeptTracked.deriveMismatchMenu(
      menuInput({ upstreamIsRemoteDefault: false, ahead: 2, keptLocal: true }),
    ).pushToTracked,
    HELD(`Push to origin/main${KEPT_LOCAL_SUFFIX}`),
  );
  const sameNameMismatch = await mutant(
    " || row.upstreamBranch === row.name)",
    ")",
  );
  assert.notEqual(
    sameNameMismatch.rowNameMismatch(
      rowFacts({ upstream: "origin/feat", upstreamBranch: "feat" }),
      REMOTES,
    ),
    null,
  );
  const anyRemoteMismatch = await mutant(
    "  if (remote === null || !remoteNames.includes(remote)) return null;\n",
    "  if (remote === null) return null;\n",
  );
  assert.notEqual(
    anyRemoteMismatch.rowNameMismatch(
      rowFacts({ upstream: "old/main", upstreamRemote: "old" }),
      REMOTES,
    ),
    null,
  );
});

test("rowSyncIndicator: a kept-local row on a removed remote keeps its no-action marker", () => {
  assert.deepEqual(
    rowSyncIndicator(
      rowFacts({
        upstream: "old/main",
        upstreamRemote: "old",
        keepLocal: true,
      }),
      REMOTES,
      "Right-click",
    ),
    {
      kind: "removedRemote",
      label: "Tracks old/main, but that remote is no longer configured.",
    },
  );
});

test("forceConfirmKeptBranch: the confirm's branch while kept local, else HEAD's for no capture", () => {
  const rows = [
    ["captured kept local", "feat", "feat", "feat"],
    ["captured not kept local", "feat", null, null],
    ["no capture, kept-local HEAD", null, "feat", "feat"],
    ["no capture, no kept-local HEAD", null, null, null],
    ["captured differs from the kept-local HEAD", "other", "feat", null],
  ];
  for (const [what, captured, keptHead, want] of rows)
    assert.equal(forceConfirmKeptBranch(captured, keptHead), want, what);
});

test("Keep local: Pull never advises publishing an untracked or gone branch", () => {
  const rows = [
    [
      "untracked",
      head({ upstream: null }),
      KEPT_LOCAL_PULL_REASON.untracked("feature", ""),
      "Pull — no upstream branch to pull from yet; publish the branch first",
    ],
    [
      "gone",
      head({ upstreamGone: true }),
      KEPT_LOCAL_PULL_REASON.gone("feature", "origin/feature"),
      "Pull — upstream origin/feature was deleted on the remote (likely merged); use Publish branch to recreate it",
    ],
  ];
  for (const [what, h, kept, plain] of rows) {
    const k = deriveSyncControls(input({ head: h, keptLocal: true }));
    assert.equal(k.pullName, kept, what);
    assert.deepEqual(k.pull, { disabled: true, reason: kept }, what);
    assert.deepEqual(k.pullOptions, { disabled: true, reason: kept }, what);
    assert.ok(!/publish/i.test(k.pullName), what);
    const p = deriveSyncControls(input({ head: h }));
    assert.equal(p.pullName, plain, what);
    assert.deepEqual(
      p.pullOptions,
      { disabled: true, reason: PULL_OPTIONS_UNPUBLISHED_REASON },
      what,
    );
  }
  // A live upstream keeps today's Pull wording under Keep local.
  const tracked = deriveSyncControls(
    input({ head: head({ behind: 2 }), keptLocal: true }),
  );
  assert.equal(
    tracked.pullName,
    "Pull — 2 commits to pull from origin/feature",
  );
});

test("a mutant dropping the kept-local Pull arm fails the rows", async () => {
  const m = await mutant(
    "if (keptHeadName !== null && !hasUpstream)",
    "if (false && !hasUpstream)",
  );
  const d = m.deriveSyncControls(
    input({ head: head({ upstream: null }), keptLocal: true }),
  );
  assert.notEqual(d.pullName, KEPT_LOCAL_PULL_REASON.untracked("feature", ""));
});
