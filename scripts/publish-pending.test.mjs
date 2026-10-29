// Pins the pending-publish projection every Publish trigger, dialog and the
// repository status line read: which cache entries count as a publish of THIS
// repo, and which variables shapes survive the guard. A wrong answer never
// errors (a malformed entry silently holds nothing, a foreign one holds the
// wrong repo), so the negative set below is what the file enforces.
//
// The import reaches straight into `src/` under Node's type stripping, which
// resolves no bundler aliases: `pr-writes.ts` may import types only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  PUBLISH_REPO_KEY,
  pendingMutationEntries,
  pendingPublishesFor,
  publishRepoKey,
  tagPushKey,
} from "../src/lib/git/queries/pr-writes.ts";

const REPO = "C:/work/harbor";
const OTHER = "C:/work/anchor";

const entry = (key, vars) => ({ key, vars, paused: false });

test("the key is the one publish prefix plus the repo", () => {
  assert.deepEqual(publishRepoKey(REPO), ["publish-repo", REPO]);
  assert.equal(publishRepoKey(REPO)[0], PUBLISH_REPO_KEY[0]);
});

test("a pending publish of this repo reads back its provider and name", () => {
  for (const name of ["harbor", "acme/harbor"]) {
    assert.deepEqual(
      pendingPublishesFor(
        [entry(publishRepoKey(REPO), { provider: "github", name })],
        REPO,
      ),
      [{ provider: "github", name }],
    );
  }
});

test("only the projection's fields ride out, for every provider", () => {
  for (const provider of ["github", "gitlab", "bitbucket"]) {
    assert.deepEqual(
      pendingPublishesFor(
        [
          entry(publishRepoKey(REPO), {
            provider,
            name: "harbor",
            isPrivate: true,
            description: "",
            homepage: "",
            topics: [],
            workspace: "acme",
          }),
        ],
        REPO,
      ),
      [{ provider, name: "harbor" }],
    );
  }
});

test("malformed variables hold nothing", () => {
  const key = publishRepoKey(REPO);
  for (const vars of [
    { provider: 7, name: "harbor" },
    { provider: "gitea", name: "harbor" },
    { provider: "github" },
    { provider: "github", name: 42 },
    { provider: "github", name: null },
    null,
    undefined,
    "harbor",
    ["github", "harbor"],
  ]) {
    assert.deepEqual(
      pendingPublishesFor([entry(key, vars)], REPO),
      [],
      `vars ${JSON.stringify(vars)}`,
    );
  }
});

test("another repo's publish and a non-publish key hold nothing", () => {
  const vars = { provider: "github", name: "harbor" };
  assert.deepEqual(
    pendingPublishesFor([entry(publishRepoKey(OTHER), vars)], REPO),
    [],
  );
  assert.deepEqual(
    pendingPublishesFor([entry(tagPushKey(REPO), vars)], REPO),
    [],
  );
  assert.deepEqual(
    pendingPublishesFor([entry(["publish-repo"], vars)], REPO),
    [],
  );
  assert.deepEqual(pendingPublishesFor([entry(undefined, vars)], REPO), []);
});

test("two pending publishes of one repo both read back, in cache order", () => {
  assert.deepEqual(
    pendingPublishesFor(
      [
        entry(publishRepoKey(REPO), { provider: "github", name: "harbor" }),
        entry(publishRepoKey(OTHER), { provider: "gitlab", name: "anchor" }),
        entry(publishRepoKey(REPO), {
          provider: "gitlab",
          name: "acme/harbor",
        }),
      ],
      REPO,
    ),
    [
      { provider: "github", name: "harbor" },
      { provider: "gitlab", name: "acme/harbor" },
    ],
  );
});

// The projection reads no status: its callers narrow the cache to
// `status: "pending"` first (as the branch-push scan does), so a settled
// mutation never reaches it. Here, every entry it is handed counts.
test("entries arrive pre-filtered to pending; a paused one still holds", () => {
  const cache = [
    {
      mutationId: 3,
      options: { mutationKey: publishRepoKey(REPO) },
      state: {
        variables: { provider: "bitbucket", name: "harbor" },
        isPaused: true,
      },
    },
  ];
  assert.deepEqual(pendingPublishesFor(pendingMutationEntries(cache), REPO), [
    { provider: "bitbucket", name: "harbor" },
  ]);
});

// The hold line has ONE spelling, `publishingHoldParts` in the banner module:
// the banner renders its parts and every reason joins them. The module is TSX
// behind aliases, so this pins the source shape instead of importing it.
const HOLD_FILES = {
  banner: "src/features/repository/PublishPendingBanner.tsx",
  dialog: "src/features/repository/PublishDialog.tsx",
  control: "src/features/repository/PublishRepoControl.tsx",
};

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

/** "Publishing " written ahead of an interpolation, a JSX expression or an
 *  element: a hold line spelled by hand instead of through the parts. */
const handSpelled = (text) =>
  [...text.matchAll(/Publishing\s*(?:\$\{|\{|<)/g)].length;

/** The parts' own lead literal. */
const leadLiterals = (text) => text.split('"Publishing "').length - 1;

function holdSpellingProblems(texts) {
  const problems = [];
  for (const [name, text] of Object.entries(texts)) {
    if (handSpelled(text) > 0) problems.push(`${name}: hand-spelled hold`);
    const want = name === "banner" ? 1 : 0;
    if (leadLiterals(text) !== want) problems.push(`${name}: lead literal`);
  }
  const rendered =
    /\{line\.before\}[\s\S]*\{line\.name\}[\s\S]*\{line\.after\}/;
  if (!rendered.test(texts.banner ?? "")) {
    problems.push("banner: line not rendered from publishingHoldParts");
  }
  return problems;
}

const liveHoldSources = () =>
  Object.fromEntries(
    Object.entries(HOLD_FILES).map(([name, rel]) => [name, source(rel)]),
  );

test("the hold line is spelled once and rendered from its parts", () => {
  assert.deepEqual(holdSpellingProblems(liveHoldSources()), []);
});

test("a second spelling of the hold line is caught", () => {
  const live = liveHoldSources();
  const mutants = [
    {
      ...live,
      dialog: `${live.dialog}\nconst x = \`Publishing \${p.name} to GitHub…\`;\n`,
    },
    {
      ...live,
      banner: `${live.banner}\nconst y = <>Publishing <span>{p.name}</span></>;\n`,
    },
    { ...live, control: `${live.control}\nconst z = "Publishing " + n;\n` },
    {
      ...live,
      banner: live.banner.replace("{line.name}", "{p.name}"),
    },
  ];
  for (const mutant of mutants) {
    assert.notDeepEqual(holdSpellingProblems(mutant), []);
  }
});
