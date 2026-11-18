// Pins the synchronous half of the local-clone lookup that My Work and the
// Projects board share: which recents may hold a target, the provider gate the
// display sites and the open read alike, the URL authority the origin proof
// compares, and the spoken wait. A wrong answer here never errors: a row
// advertises a landing the open refuses, or an open proves the wrong instance.
//
// The import below reaches straight into `src/` and relies on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases: `match.ts` may import
// types only. A runtime import added there fails this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  asForgeProvider,
  hasOpenableMatch,
  matchLocalRepos,
  openableMatches,
  openingStatus,
  PENDING_AFFORDANCE_MS,
  providerAgrees,
  urlAuthority,
} from "../src/lib/local-landing/match.ts";

const recent = (path, extra = {}) => ({
  path,
  name: path.split("/").at(-1),
  lastOpenedAt: "2026-01-01T00:00:00Z",
  ...extra,
});

const KEY = {
  provider: "github",
  host: "github.com",
  repoOwner: "acme",
  repoName: "widgets",
};

const probed = (path, extra = {}) =>
  recent(path, {
    host: "github.com",
    owner: "acme",
    repoName: "widgets",
    ...extra,
  });

test("the matcher compares host, owner and name case-insensitively, in recents order", () => {
  const recents = [
    probed("C:/b", { host: "GitHub.com", owner: "ACME", repoName: "Widgets" }),
    probed("C:/other", { repoName: "gadgets" }),
    probed("C:/other-host", { host: "github.example.com" }),
    probed("C:/other-owner", { owner: "umbrella" }),
    probed("C:/a"),
  ];
  assert.deepEqual(
    matchLocalRepos(
      { host: "GITHUB.COM", repoOwner: "Acme", repoName: "WIDGETS" },
      recents,
    ).map((r) => r.path),
    ["C:/b", "C:/a"],
  );
});

test("a recent the owner probe hasn't touched never matches", () => {
  const recents = [
    recent("C:/widgets"),
    recent("C:/widgets", { host: "github.com" }),
    recent("C:/widgets", { owner: "acme" }),
  ];
  assert.deepEqual(matchLocalRepos(KEY, recents), []);
});

test("a recent without repoName falls back to its folder name", () => {
  const recents = [
    recent("C:/src/widgets", { host: "github.com", owner: "acme" }),
  ];
  assert.deepEqual(
    matchLocalRepos(KEY, recents).map((r) => r.path),
    ["C:/src/widgets"],
  );
  // repoName, when present, wins over a folder that happens to match.
  const renamed = [probed("C:/src/widgets", { repoName: "gadgets" })];
  assert.deepEqual(matchLocalRepos(KEY, renamed), []);
});

test("any empty key field matches nothing", () => {
  const recents = [
    probed("C:/a"),
    recent("C:/x", { host: "", owner: "", repoName: "" }),
  ];
  for (const field of ["host", "repoOwner", "repoName"]) {
    assert.deepEqual(
      matchLocalRepos({ ...KEY, [field]: "" }, recents),
      [],
      field,
    );
  }
});

test("providerAgrees drops only a KNOWN different stored provider", () => {
  assert.equal(providerAgrees(probed("C:/a"), { provider: "github" }), true);
  assert.equal(
    providerAgrees(probed("C:/a", { provider: "github" }), {
      provider: "github",
    }),
    true,
  );
  assert.equal(
    providerAgrees(probed("C:/a", { provider: "forgejo" }), {
      provider: "github",
    }),
    true,
  );
  assert.equal(
    providerAgrees(probed("C:/a", { provider: "gitlab" }), {
      provider: "github",
    }),
    false,
  );
});

test("openableMatches and hasOpenableMatch agree on one mixed recents list", () => {
  const recents = [
    probed("C:/gitlab-classified", { provider: "gitlab" }),
    recent("C:/unprobed"),
    probed("C:/unknown", { provider: "forgejo" }),
    probed("C:/github", { provider: "github" }),
    probed("C:/unclassified"),
  ];
  assert.deepEqual(
    openableMatches(KEY, recents).map((r) => r.path),
    ["C:/unknown", "C:/github", "C:/unclassified"],
  );
  assert.equal(hasOpenableMatch(KEY, recents), true);
  const refused = [probed("C:/gitlab-classified", { provider: "gitlab" })];
  assert.deepEqual(openableMatches(KEY, refused), []);
  assert.equal(hasOpenableMatch(KEY, refused), false);
  assert.equal(hasOpenableMatch(KEY, []), false);
});

test("asForgeProvider passes the known ids and nothing else", () => {
  for (const id of ["github", "gitlab", "bitbucket"]) {
    assert.equal(asForgeProvider(id), id);
  }
  for (const id of [
    "constructor",
    "toString",
    "__proto__",
    "",
    "GitHub",
    undefined,
  ]) {
    assert.equal(asForgeProvider(id), null, String(id));
  }
});

test("urlAuthority is URL.host lowercased, null when unparseable", () => {
  assert.equal(urlAuthority("https://github.com:443/a/b/pull/1"), "github.com");
  assert.equal(
    urlAuthority("https://Git.Example.com:8443/a/b/-/issues/2"),
    "git.example.com:8443",
  );
  assert.equal(urlAuthority("https://GITHUB.COM/a/b"), "github.com");
  assert.equal(urlAuthority("not a url"), null);
  assert.equal(urlAuthority(""), null);
});

test("openingStatus speaks the repo, the kind and the number, with one ellipsis character", () => {
  assert.equal(
    openingStatus({ repoName: "widgets", isPullRequest: false, number: 12 }),
    "Opening widgets issue 12\u2026",
  );
  assert.equal(
    openingStatus({ repoName: "widgets", isPullRequest: true, number: 12 }),
    "Opening widgets pull request 12\u2026",
  );
  assert.ok(
    !openingStatus({ repoName: "w", isPullRequest: true, number: 1 }).includes(
      "...",
    ),
  );
});

test("the wait threshold is the shared 300 ms", () => {
  assert.equal(PENDING_AFFORDANCE_MS, 300);
});
