// Pins the account-change reset (src/lib/account-change.ts): forge caches carry no
// account axis, so when a forge-status read reports a different signed-in login on
// a host, every cached forge read is reset instead of repainting the previous
// account's answers. The contract under test: which login transitions count as a
// change (null is UNKNOWN, never a sign-out), which cached queries a reset may
// touch, and that the cache listener resets once per change per host.
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so the module must
// stay free of runtime imports (type-only imports are erased).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FORGE_ROOTS,
  installAccountChangeReset,
  loginChange,
  shouldResetOnAccountChange,
} from "../src/lib/account-change.ts";

const REPO = "C:/repos/app";
const OTHER_REPO = "C:/repos/lib";

/** Roots whose caches must survive an account change, each for its own reason. */
const MUST_NOT_RESET = [
  // Caches a plugin `Update` instance that the update check reuses; a reset
  // leaks the handle and re-downloads.
  "app-update",
  // A side-effecting poller, not a read.
  "background-pr-sync",
  // AI provider and agent model lists, keyed by their own credentials.
  "models",
  "agent-models",
  // Public web, package-registry and MCP-registry reads.
  "link-preview",
  "package-info",
  "npm-installs",
  "mcp-browse",
];

function q(queryKey, networkMode) {
  return {
    queryKey,
    options: networkMode === undefined ? {} : { networkMode },
  };
}

test("loginChange: each transition (table)", () => {
  const table = [
    ["first observation records only", undefined, "a", "none"],
    ["first observation of an unknown login", undefined, null, "none"],
    ["same login", "a", "a", "none"],
    ["a different login", "a", "b", "reset"],
    ["login turns unknown", "a", null, "none"],
  ];
  for (const [name, prev, next, verdict] of table)
    assert.equal(loginChange(prev, next), verdict, name);
});

test("shouldResetOnAccountChange: each query shape (table)", () => {
  const table = [
    // Local reads under "repo" are "always" by the networkmode guard.
    ["local status", q(["repo", REPO, "status"], "always"), false],
    [
      "local review drafts",
      q(["repo", REPO, "pr", "origin", 7, "review-drafts"], "always"),
      false,
    ],
    [
      "the triggering forge-status read",
      q(["repo", REPO, "forge-status"], "always"),
      false,
    ],
    ["pr list", q(["repo", REPO, "pr-list", "origin", "open", null, ""]), true],
    ["reactions", q(["repo", REPO, "reactions", ["pr", "origin", 7]]), true],
    [
      "project items",
      q(["repo", REPO, "project-items", "PVT_1", null, false, true]),
      true,
    ],
    ["explicit online mode", q(["repo", REPO, "pr-list"], "online"), true],
    ["my-work page", q(["forge-my-work", "github", null]), true],
    ["token scopes", q(["gh", "token-scopes", null]), true],
    // Jira is its own account, never the forge's.
    ["jira issues under repo", q(["repo", REPO, "jira-issues", "x"]), false],
    ["jira issue under repo", q(["repo", REPO, "jira-issue", "x"]), false],
    ["jira project search", q(["jira-project-search", "site", "k"]), false],
    ["jira labels", q(["jira-labels", "site"]), false],
    ["unknown root", q(["settings"]), false],
    ["empty key", q([]), false],
    ["non-string root", q([7, REPO]), false],
    [
      "a forge root in always mode",
      q(["forge-provider-features", "github"], "always"),
      false,
    ],
  ];
  for (const [name, query, verdict] of table)
    assert.equal(shouldResetOnAccountChange(query), verdict, name);
});

test("every must-not-reset root survives", () => {
  for (const root of MUST_NOT_RESET) {
    assert.equal(FORGE_ROOTS.has(root), false, `${root} is not a forge root`);
    assert.equal(
      shouldResetOnAccountChange(q([root, "x"])),
      false,
      `${root} is not reset`,
    );
  }
});

test("every forge root resets in a parkable mode", () => {
  assert.ok(FORGE_ROOTS.has("repo"));
  for (const root of FORGE_ROOTS)
    assert.equal(shouldResetOnAccountChange(q([root, "x"])), true, root);
});

/** A client that records what the installer asks of it and lets the test drive
 *  query-cache events by hand. */
function fakeClient() {
  const calls = [];
  const listeners = [];
  const client = {
    getQueryCache: () => ({
      subscribe(listener) {
        calls.push(["subscribe"]);
        listeners.push(listener);
        return () => {};
      },
    }),
    resetQueries(filters) {
      calls.push(["reset", filters]);
      return Promise.resolve();
    },
    invalidateQueries(filters) {
      calls.push(["invalidate", filters.queryKey]);
      return Promise.resolve();
    },
  };
  const emit = (event) => {
    for (const listener of listeners) listener(event);
  };
  return { client, calls, emit };
}

function statusEvent({
  repo = REPO,
  host = "github.com",
  login,
  action = "success",
  key = ["repo", repo, "forge-status"],
}) {
  return {
    type: "updated",
    action: { type: action },
    query: {
      queryKey: key,
      state: { data: { host, login } },
      options: { networkMode: "always" },
    },
  };
}

const INVALIDATE_KEYS = [["bb-account"], ["my-work-sources"]];

function install() {
  const fake = fakeClient();
  installAccountChangeReset(fake.client, { invalidateKeys: INVALIDATE_KEYS });
  return fake;
}

const resets = (calls) => calls.filter(([kind]) => kind === "reset").length;

test("installs one cache subscription", () => {
  const { calls } = install();
  assert.deepEqual(calls, [["subscribe"]]);
});

test("a login change resets once, then invalidates the always-mode reads", () => {
  const { calls, emit } = install();
  emit(statusEvent({ login: "a" }));
  assert.equal(resets(calls), 0, "first observation only records");
  emit(statusEvent({ login: "a" }));
  assert.equal(resets(calls), 0, "same login");
  emit(statusEvent({ login: "b" }));
  assert.deepEqual(
    calls.slice(1).map(([kind, arg]) => (kind === "reset" ? kind : arg)),
    ["reset", ["bb-account"], ["my-work-sources"]],
  );
  const [, filters] = calls.find(([kind]) => kind === "reset");
  assert.equal(filters.predicate, shouldResetOnAccountChange);
  emit(statusEvent({ login: "b" }));
  assert.equal(resets(calls), 1, "a -> b -> b resets once");
});

test("an unknown login neither resets nor replaces the baseline", () => {
  const back = install();
  for (const login of ["a", null, "a"]) back.emit(statusEvent({ login }));
  assert.equal(resets(back.calls), 0, "a -> null -> a");

  const away = install();
  for (const login of ["a", null, "b"]) away.emit(statusEvent({ login }));
  assert.equal(resets(away.calls), 1, "a -> null -> b");

  const lost = install();
  for (const login of ["a", null]) lost.emit(statusEvent({ login }));
  assert.equal(resets(lost.calls), 0, "a -> null");
});

test("events other than a forge-status success are ignored", () => {
  const { calls, emit } = install();
  emit(statusEvent({ login: "a" }));
  emit(statusEvent({ login: "b", action: "error" }));
  emit(statusEvent({ login: "b", action: "fetch" }));
  emit({ ...statusEvent({ login: "b" }), type: "added" });
  emit(statusEvent({ login: "b", key: ["repo", REPO, "pr-list"] }));
  emit(statusEvent({ login: "b", key: ["forge-status"] }));
  assert.equal(resets(calls), 0);
  // The ignored events left the baseline alone.
  emit(statusEvent({ login: "b" }));
  assert.equal(resets(calls), 1);
});

test("the baseline is per host, shared by every repo on it", () => {
  const { calls, emit } = install();
  emit(statusEvent({ repo: REPO, login: "a" }));
  // A first visit to another repo on the same host is not a change.
  emit(statusEvent({ repo: OTHER_REPO, login: "a" }));
  assert.equal(resets(calls), 0);
  emit(statusEvent({ repo: REPO, login: "b" }));
  emit(statusEvent({ repo: OTHER_REPO, login: "b" }));
  assert.equal(resets(calls), 1, "two repos on one host reset once");
  // Another host keeps its own baseline.
  emit(statusEvent({ repo: OTHER_REPO, host: "gitlab.com", login: "b" }));
  assert.equal(resets(calls), 1, "first observation on another host");
});

test("malformed status data reads as an unknown login", () => {
  const { calls, emit } = install();
  emit(statusEvent({ login: "a" }));
  const event = statusEvent({ login: "b" });
  event.query.state.data = undefined;
  emit(event);
  emit(statusEvent({ login: 42 }));
  assert.equal(resets(calls), 0);
});
