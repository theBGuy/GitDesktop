// Pins src/lib/git/queries/local-query-filter.ts: which cached repo queries a local
// git operation (fetch, pull, push, checkout, stash, discard) invalidates. LOCAL iff
// networkMode "always" minus the networked-"always" overrides; everything else is a
// forge read that keeps its own clock. A wrong answer never errors — a fetch either
// replays every GitHub read on screen or leaves a local read stale — so each row is a
// case.
//
// Both imports reach straight into `src/` under Node's type stripping, and both
// modules are import-free at runtime, so this suite needs no install.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { shouldResetOnAccountChange } from "../src/lib/account-change.ts";
import {
  isLocalRepoQuery,
  NETWORKED_ALWAYS_OVERRIDES,
} from "../src/lib/git/queries/local-query-filter.ts";

const REPO = "C:/repos/app";
const q = (kind, networkMode, ...rest) => ({
  queryKey: ["repo", REPO, kind, ...rest],
  options: networkMode === undefined ? {} : { networkMode },
});

test("the override set is exactly the ratchet's repo-rooted networked-always roster", () => {
  // The roster lives in scripts/networkmode-local-queries.test.mjs, which fails on a
  // networked "always" query it doesn't list; every repo-rooted entry it gains must
  // land here too, or a fetch would treat that forge read as local.
  const source = readFileSync(
    new URL("./networkmode-local-queries.test.mjs", import.meta.url),
    "utf8",
  );
  const block = /const NETWORKED_ALWAYS = \[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, "NETWORKED_ALWAYS roster not found: update this reader");
  const keys = [...block[1].matchAll(/queryKey:\s*'([^']*)'/g)].map(
    (m) => m[1],
  );
  assert.ok(keys.length > 0, "roster read no entries: update this reader");
  const repoRooted = keys
    .map((key) => /^\[\s*"repo",\s*[^,]+,\s*"([^"]+)"/.exec(key))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  assert.deepEqual(repoRooted, [...NETWORKED_ALWAYS_OVERRIDES].sort());
});

test("an override kind is networked even under networkMode always", () => {
  for (const kind of ["forge-status", "create-pr-parent-branches"])
    assert.equal(isLocalRepoQuery(q(kind, "always")), false, kind);
});

test("local reads set networkMode always and classify local", () => {
  for (const key of [
    ["status"],
    ["branches"],
    ["divergence"],
    ["worktrees"],
    ["stash-count"],
    ["contributors"],
    ["commit-activity"],
    ["code-frequency"],
    ["user-identity"],
    ["commit", "abc123", "on-remote"],
  ])
    assert.equal(
      isLocalRepoQuery(q(key[0], "always", ...key.slice(1))),
      true,
      key.join("/"),
    );
});

test("the commit subtree splits on networkMode alone", () => {
  assert.equal(
    isLocalRepoQuery(q("commit", "always", "abc123", "on-remote")),
    true,
  );
  assert.equal(
    isLocalRepoQuery(q("commit", undefined, "abc123", "comments", "origin")),
    false,
  );
  assert.equal(
    isLocalRepoQuery(q("commit", undefined, "abc123", "remote-diff")),
    false,
  );
});

test("a read without networkMode always is networked, whatever its kind", () => {
  for (const [kind, mode] of [
    ["pr-list", undefined],
    ["pr-ci", "online"],
    ["publish-targets", undefined],
    ["jira-issues", undefined],
    ["forge-session-health", undefined],
    ["a-kind-added-tomorrow", undefined],
    ["status", "offlineFirst"],
  ])
    assert.equal(isLocalRepoQuery(q(kind, mode)), false, `${kind}/${mode}`);
});

test("hostile key and option shapes classify without throwing", () => {
  assert.equal(
    isLocalRepoQuery({
      queryKey: ["repo", REPO],
      options: { networkMode: "always" },
    }),
    true,
  );
  assert.equal(
    isLocalRepoQuery({
      queryKey: ["repo", REPO, 7],
      options: { networkMode: "always" },
    }),
    true,
  );
  assert.equal(
    isLocalRepoQuery({ queryKey: ["repo", REPO, null], options: {} }),
    false,
  );
  // A key seeded by setQueryData before any observer: options carry no networkMode.
  assert.equal(
    isLocalRepoQuery({ queryKey: ["repo", REPO, "status"], options: {} }),
    false,
  );
});

test("agrees with the account-change reset on the shared premise", () => {
  // Shared ground: an "always" local read is local here and never reset there; a
  // forge read without "always" is networked here and reset there.
  for (const kind of ["status", "branches", "contributors"]) {
    const local = q(kind, "always");
    assert.equal(isLocalRepoQuery(local), true, kind);
    assert.equal(shouldResetOnAccountChange(local), false, kind);
  }
  for (const kind of ["pr-list", "issue-list", "publish-targets"]) {
    const forge = q(kind, undefined);
    assert.equal(isLocalRepoQuery(forge), false, kind);
    assert.equal(shouldResetOnAccountChange(forge), true, kind);
  }
});

test("the by-design divergences from the account-change reset", () => {
  // Override kinds: "always" yet networked here, exempt from the reset there.
  for (const kind of NETWORKED_ALWAYS_OVERRIDES) {
    const read = q(kind, "always");
    assert.equal(isLocalRepoQuery(read), false, kind);
    assert.equal(shouldResetOnAccountChange(read), false, kind);
  }
  // Jira kind slots: networked here like any read without "always", exempt from an
  // account reset there (a Jira link answers as its own account).
  const jira = q("jira-issues", undefined);
  assert.equal(isLocalRepoQuery(jira), false);
  assert.equal(shouldResetOnAccountChange(jira), false);
});
