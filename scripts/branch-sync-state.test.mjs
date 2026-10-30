// Pins the branch-sync decisions: which pushes publish, which of those would
// CREATE the branch on its destination (the only ones the publish confirm
// asks about), what "Update from <default>" merges and how its items read, and
// the publish prompt's copy (destination phrase, forge-shaped slugs, and the
// re-create wording's gate).
//
// The import below reaches straight into `src/` and relies on Node's default
// type stripping (>= 23.6), which resolves no bundler aliases, so
// `branch-sync-state.ts` must stay import-free.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  destinationPhrase,
  destinationSlug,
  forgeShapedUrl,
  isLocalUpstream,
  publishConfirmBody,
  publishConfirmTitle,
  remoteHasBranch,
  resolveUpdateFromDefault,
  segmentsText,
  willCreateOnRemote,
  willPublish,
} from "../src/features/repository/branch-sync-state.ts";

const EXPOSURE =
  "Anyone who can see the repository can see it, and CI may run on it.";

test("willPublish: untracked, gone, or an explicit retrack publish", () => {
  const cases = [
    // [upstream, gone, setUpstream, expected]
    [null, false, undefined, true],
    [null, false, false, true],
    [null, false, true, true],
    [null, true, undefined, true],
    ["origin/x", false, undefined, false],
    ["origin/x", false, false, false],
    ["origin/x", false, true, true],
    ["origin/x", true, undefined, true],
    ["origin/x", true, false, true],
    ["origin/x", true, true, true],
  ];
  for (const [upstream, upstreamGone, setUpstream, want] of cases) {
    const facts = { upstream, upstreamGone };
    if (setUpstream !== undefined) facts.setUpstream = setUpstream;
    assert.equal(willPublish(facts), want, JSON.stringify(facts));
  }
});

test("willCreateOnRemote: a publish creates unless the destination already has the name", () => {
  for (const upstream of [null, "origin/x"]) {
    for (const upstreamGone of [false, true]) {
      for (const setUpstream of [undefined, false, true]) {
        for (const remoteHasSameName of [true, false, undefined]) {
          const facts = { upstream, upstreamGone, remoteHasSameName };
          if (setUpstream !== undefined) facts.setUpstream = setUpstream;
          const publishes = willPublish(facts);
          // An existing same-named branch only fast-forwards and tracks; an
          // unknown list asks, the safe side.
          const want = publishes && remoteHasSameName !== true;
          assert.equal(willCreateOnRemote(facts), want, JSON.stringify(facts));
        }
      }
    }
  }
});

test("NEGATIVE CONTROL: a tracked push to a branch the remote has never creates", () => {
  assert.equal(
    willCreateOnRemote({
      upstream: "origin/feature",
      upstreamGone: false,
      remoteHasSameName: true,
    }),
    false,
  );
  // And the named arms the other way, so a constant predicate fails one side.
  assert.equal(
    willCreateOnRemote({
      upstream: null,
      upstreamGone: false,
      remoteHasSameName: undefined,
    }),
    true,
  );
  assert.equal(
    willCreateOnRemote({
      upstream: null,
      upstreamGone: false,
      remoteHasSameName: true,
    }),
    false,
  );
  assert.equal(
    willCreateOnRemote({
      upstream: "upstream/feature",
      upstreamGone: false,
      setUpstream: true,
      remoteHasSameName: false,
    }),
    true,
  );
});

test("remoteHasBranch: matches remote AND name; an unknown list stays unknown", () => {
  const list = [
    { remote: "origin", name: "feature/x" },
    { remote: "upstream", name: "main" },
  ];
  assert.equal(remoteHasBranch(list, "origin", "feature/x"), true);
  assert.equal(remoteHasBranch(list, "upstream", "feature/x"), false);
  assert.equal(remoteHasBranch(list, "origin", "main"), false);
  assert.equal(remoteHasBranch([], "origin", "feature/x"), false);
  assert.equal(remoteHasBranch(undefined, "origin", "feature/x"), undefined);
});

const row = (over = {}) => ({
  upstream: "origin/main",
  upstreamGone: false,
  upstreamRemote: "origin",
  upstreamAhead: 0,
  upstreamBehind: 0,
  ...over,
});
const local = {
  primary: { base: "main", label: "Update from main" },
  secondary: null,
};

test("resolveUpdateFromDefault: arms that merge the local default", () => {
  assert.deepEqual(resolveUpdateFromDefault("main", undefined), local);
  assert.deepEqual(
    resolveUpdateFromDefault(
      "main",
      row({ upstream: null, upstreamRemote: null }),
    ),
    local,
  );
  assert.deepEqual(
    resolveUpdateFromDefault(
      "main",
      row({ upstreamGone: true, upstreamBehind: 3 }),
    ),
    local,
  );
  // Tracking a LOCAL branch: git reports its remote as "." (git 2.51), the
  // model allows null; both are no-upstream here.
  for (const upstreamRemote of [null, "."]) {
    assert.deepEqual(
      resolveUpdateFromDefault(
        "main",
        row({ upstream: "trunk", upstreamRemote, upstreamBehind: 2 }),
      ),
      local,
      String(upstreamRemote),
    );
  }
  assert.deepEqual(resolveUpdateFromDefault("main", row()), local);
});

test("resolveUpdateFromDefault: strictly behind merges the upstream verbatim", () => {
  assert.deepEqual(
    resolveUpdateFromDefault("main", row({ upstreamBehind: 4 })),
    {
      primary: { base: "origin/main", label: "Update from origin/main" },
      secondary: null,
    },
  );
  // The short form git disambiguates is passed through, never recomposed.
  assert.deepEqual(
    resolveUpdateFromDefault(
      "main",
      row({ upstream: "remotes/origin/main", upstreamBehind: 1 }),
    ).primary,
    { base: "remotes/origin/main", label: "Update from remotes/origin/main" },
  );
  // Any remote the default tracks, and a remote name with "/" in it.
  assert.deepEqual(
    resolveUpdateFromDefault(
      "main",
      row({
        upstream: "corp/mirror/main",
        upstreamRemote: "corp/mirror",
        upstreamBehind: 1,
      }),
    ).primary,
    { base: "corp/mirror/main", label: "Update from corp/mirror/main" },
  );
});

test("resolveUpdateFromDefault: ahead or diverged keeps local first, upstream second", () => {
  assert.deepEqual(
    resolveUpdateFromDefault("main", row({ upstreamAhead: 1 })),
    {
      primary: {
        base: "main",
        label: "Update from main (1 commit not on origin)",
      },
      secondary: { base: "origin/main", label: "Update from origin/main" },
    },
  );
  assert.deepEqual(
    resolveUpdateFromDefault(
      "main",
      row({ upstreamAhead: 2, upstreamBehind: 5 }),
    ),
    {
      primary: {
        base: "main",
        label: "Update from main (2 commits not on origin)",
      },
      secondary: { base: "origin/main", label: "Update from origin/main" },
    },
  );
  // The parenthetical names the row's remote, never a split of the upstream.
  assert.equal(
    resolveUpdateFromDefault(
      "release/2.x",
      row({
        upstream: "corp/mirror/release/2.x",
        upstreamRemote: "corp/mirror",
        upstreamAhead: 3,
      }),
    ).primary.label,
    "Update from release/2.x (3 commits not on corp/mirror)",
  );
});

test("forgeShapedUrl: hosts yes, local paths and file:// no", () => {
  for (const url of [
    "https://github.com/theBGuy/GitDesktop.git",
    "http://gitlab.local/group/sub/repo",
    "ssh://git@github.com/o/r.git",
    "git@github.com:o/r.git",
    "  git@bitbucket.org:team/repo  ",
  ])
    assert.equal(forgeShapedUrl(url), true, url);
  for (const url of [
    "file:///C:/repos/r.git",
    "C:\\repos\\r.git",
    "C:/repos/r.git",
    "/srv/git/r.git",
    "../sibling/r",
    "",
  ])
    assert.equal(forgeShapedUrl(url), false, url);
});

test("destinationSlug: a slug only for forge-shaped URLs", () => {
  const slugOf = (u) => `slug(${u})`;
  assert.equal(destinationSlug(null, slugOf), null);
  assert.equal(destinationSlug("C:/repos/r.git", slugOf), null);
  assert.equal(
    destinationSlug("git@github.com:o/r.git", slugOf),
    "slug(git@github.com:o/r.git)",
  );
  assert.equal(
    destinationSlug("https://h/o/r", () => null),
    null,
  );
});

test("destinationPhrase: slug and origin-only visibility", () => {
  const phrase = (...a) => segmentsText(destinationPhrase(...a));
  assert.equal(phrase("origin", "o/r", "public"), "origin (o/r, public)");
  assert.equal(phrase("origin", "o/r", null), "origin (o/r)");
  assert.equal(phrase("origin", null, "private"), "origin (private)");
  assert.equal(phrase("origin", null, null), "origin");
  // Visibility describes origin only.
  assert.equal(phrase("fork", "me/r", "public"), "fork (me/r)");
  assert.equal(phrase("fork", null, "public"), "fork");
  // Remote, slug in mono; the visibility word is not.
  assert.deepEqual(destinationPhrase("origin", "o/r", "public"), [
    { text: "origin", mono: true },
    { text: " (" },
    { text: "o/r", mono: true },
    { text: ", public)" },
  ]);
});

test("publishConfirmBody: untracked body, and the re-create body only for the destination's own gone upstream", () => {
  const base = {
    branch: "feature/x",
    remote: "origin",
    slug: "theBGuy/GitDesktop",
    visibility: "public",
    goneUpstream: false,
    upstreamRemote: null,
    upstreamBranch: null,
  };
  const gone = {
    ...base,
    goneUpstream: true,
    upstreamRemote: "origin",
    upstreamBranch: "feature/x",
  };
  const created = `Creates feature/x on origin (theBGuy/GitDesktop, public). ${EXPOSURE}`;
  assert.equal(segmentsText(publishConfirmBody(base)), created);
  assert.equal(
    segmentsText(publishConfirmBody(gone)),
    `feature/x was deleted on origin (theBGuy/GitDesktop, public), likely after a merge. Publishing creates it again. ${EXPOSURE}`,
  );
  // Gone on ANOTHER remote: nothing was deleted on the destination.
  assert.equal(
    segmentsText(publishConfirmBody({ ...gone, remote: "fork", slug: null })),
    `Creates feature/x on fork. ${EXPOSURE}`,
  );
  // Gone, but it tracked a DIFFERENTLY named branch (origin/feat): the push
  // creates a new feature/x, nothing of that name was deleted.
  assert.equal(
    segmentsText(publishConfirmBody({ ...gone, upstreamBranch: "feat" })),
    created,
  );
  // An unknown merge ref never claims a deletion.
  assert.equal(
    segmentsText(publishConfirmBody({ ...gone, upstreamBranch: null })),
    created,
  );
  const branchSeg = publishConfirmBody(base).find(
    (s) => s.text === "feature/x",
  );
  assert.equal(branchSeg?.mono, true);
});

test("isLocalUpstream: git's '.' (measured, git 2.51) and null are local", () => {
  assert.equal(isLocalUpstream("."), true);
  assert.equal(isLocalUpstream(null), true);
  for (const remote of ["origin", "upstream", "corp/mirror", "./x", ".."])
    assert.equal(isLocalUpstream(remote), false, remote);
});

test("publishConfirmTitle: plain text, so a cancel notice can name it", () => {
  assert.equal(publishConfirmTitle("feature/x"), "Publish feature/x?");
});
