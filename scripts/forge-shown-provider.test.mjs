// Pins the pending-window provider naming in src/lib/git/types/forge.ts: copy
// names the probe's answer once it has one (settled null keeps the gh-routed
// "GitHub"), else the provider saved in the repo's recents entry, else nothing
// (the caller's neutral copy). Stored ids this build doesn't know read as
// unknown, never as GitHub.
//
// The import reaches straight into `src/` under Node's type stripping, so
// forge.ts must stay free of runtime imports.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  knownProvider,
  OPEN_IN_BROWSER,
  providerLabel,
  savedProvider,
  shownProvider,
  shownProviderLabel,
  UNKNOWN_HOST,
} from "../src/lib/git/types/forge.ts";

const RECENTS = [
  { path: "C:/r/gl", provider: "gitlab" },
  { path: "C:/r/bb", provider: "bitbucket" },
  { path: "C:/r/gh", provider: "github" },
  { path: "C:/r/none" },
  { path: "C:/r/null", provider: null },
  { path: "C:/r/odd", provider: "forgejo" },
];

const PENDING = undefined;
const SETTLED_NULL = { provider: null };

/** The label a pending-capable site shows for a probe state and a repo. */
function label(status, repo, recents = RECENTS) {
  return shownProviderLabel(
    shownProvider(status, savedProvider(recents, repo)),
  );
}

test("knownProvider narrows only ids this build knows", () => {
  assert.equal(knownProvider("gitlab"), "gitlab");
  assert.equal(knownProvider("bitbucket"), "bitbucket");
  assert.equal(knownProvider("github"), "github");
  assert.equal(knownProvider("forgejo"), undefined);
  assert.equal(knownProvider(""), undefined);
  assert.equal(knownProvider(null), undefined);
  assert.equal(knownProvider(undefined), undefined);
  // Own keys only: an inherited name is not a provider.
  assert.equal(knownProvider("__proto__"), undefined);
  assert.equal(knownProvider("toString"), undefined);
  assert.equal(knownProvider("constructor"), undefined);
});

test("savedProvider reads the recents entry by exact path", () => {
  assert.equal(savedProvider(RECENTS, "C:/r/gl"), "gitlab");
  assert.equal(savedProvider(RECENTS, "C:/r/bb"), "bitbucket");
  assert.equal(savedProvider(RECENTS, "C:/r/gh"), "github");
  assert.equal(savedProvider(RECENTS, "C:/r/none"), undefined);
  assert.equal(savedProvider(RECENTS, "C:/r/null"), undefined);
  assert.equal(savedProvider(RECENTS, "C:/r/odd"), undefined);
  assert.equal(savedProvider(RECENTS, "C:/r/missing"), undefined);
  assert.equal(savedProvider(RECENTS, "c:/r/gl"), undefined);
  assert.equal(savedProvider(undefined, "C:/r/gl"), undefined);
  assert.equal(savedProvider([], "C:/r/gl"), undefined);
});

test("pending names the saved provider, else nothing", () => {
  assert.equal(label(PENDING, "C:/r/gl"), "GitLab");
  assert.equal(label(PENDING, "C:/r/bb"), "Bitbucket");
  assert.equal(label(PENDING, "C:/r/gh"), "GitHub");
  assert.equal(label(PENDING, "C:/r/none"), null);
  assert.equal(label(PENDING, "C:/r/null"), null);
  assert.equal(label(PENDING, "C:/r/odd"), null);
  // Settings not loaded yet: nothing is saved.
  assert.equal(
    shownProviderLabel(
      shownProvider(PENDING, savedProvider(undefined, "C:/r/gl")),
    ),
    null,
  );
  assert.equal(shownProvider(PENDING, undefined), undefined);
});

test("a settled probe wins over any saved provider", () => {
  for (const repo of RECENTS.map((r) => r.path)) {
    assert.equal(label({ provider: "gitlab" }, repo), "GitLab");
    assert.equal(label({ provider: "bitbucket" }, repo), "Bitbucket");
    assert.equal(label({ provider: "github" }, repo), "GitHub");
    // Settled null is a known answer: the gh-routed GitHub default.
    assert.equal(label(SETTLED_NULL, repo), "GitHub");
  }
  assert.equal(shownProvider(SETTLED_NULL, "gitlab"), null);
  assert.equal(shownProvider({ provider: "github" }, "gitlab"), "github");
});

test("shownProviderLabel keeps providerLabel for every known answer", () => {
  for (const p of ["github", "gitlab", "bitbucket", null]) {
    assert.equal(shownProviderLabel(p), providerLabel(p));
  }
  assert.equal(shownProviderLabel(undefined), null);
});

test("neutral copy constants", () => {
  assert.equal(UNKNOWN_HOST, "the host");
  assert.equal(OPEN_IN_BROWSER, "Open in browser");
});
