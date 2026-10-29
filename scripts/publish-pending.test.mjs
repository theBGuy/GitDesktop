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
import { keepDraftOnOpen } from "../src/features/repository/publish-draft.ts";
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

// Every provider adds `origin` before its push, so the sync bar's Publish arm
// holds on this repo's pending publish, not on `noOrigin` alone: the providers
// probe, the render gate and the focus rescue all key on the hold. The sync
// bar's own work holds with it: all four sync hotkeys (the held arm shows none
// of their buttons) and auto-fetch, which would otherwise fire at the new origin.
const SYNC_CONTROLS = "src/features/repository/SyncControls.tsx";

function syncHoldProblems(text) {
  const problems = [];
  const need = {
    "reads the pending publish": /usePendingPublishes\(repoPath\)/,
    "arm = noOrigin || pending":
      /const publishArm = noOrigin \|\| publishPending;/,
    "probe keyed on the arm": /usePublishProviders\(repoPath, publishArm\)/,
    "rescue keyed on the arm":
      /useFocusOnControlsSwap\(publishArm, controlsRef\)/,
    "render gate on the arm": /if \(publishArm\) \{/,
    "auto-fetch busy while publishing":
      /useAutoFetch\(\{[^}]*busy:[^,]*\|\| publishPending,/,
  };
  for (const [what, re] of Object.entries(need)) {
    if (!re.test(text)) problems.push(`missing: ${what}`);
  }
  for (const stale of [
    /if \(noOrigin\) \{/,
    /usePublishProviders\(repoPath, noOrigin\)/,
    /useFocusOnControlsSwap\(noOrigin,/,
  ]) {
    if (stale.test(text)) problems.push(`keys on noOrigin: ${stale}`);
  }
  for (const key of ["fetch", "pull", "push", "updateFromUpstream"]) {
    const held = new RegExp(`hotkeys\\.${key} && !publishPending`);
    if (!held.test(text)) problems.push(`hotkey not held: ${key}`);
  }
  return problems;
}

test("the sync bar's Publish arm holds while the repo's publish runs", () => {
  assert.deepEqual(syncHoldProblems(source(SYNC_CONTROLS)), []);
});

test("a sync bar keyed back on noOrigin is caught", () => {
  const live = source(SYNC_CONTROLS);
  const mutants = [
    live.replace("if (publishArm) {", "if (noOrigin) {"),
    live.replace(
      "usePublishProviders(repoPath, publishArm)",
      "usePublishProviders(repoPath, noOrigin)",
    ),
    live.replace(
      "useFocusOnControlsSwap(publishArm, controlsRef)",
      "useFocusOnControlsSwap(noOrigin, controlsRef)",
    ),
    live.replace(
      "const publishArm = noOrigin || publishPending;",
      "const publishArm = noOrigin;",
    ),
    live.replace("hotkeys.push && !publishPending", "hotkeys.push"),
    live.replace(
      "hotkeys.updateFromUpstream && !publishPending",
      "hotkeys.updateFromUpstream",
    ),
    live.replace(
      "removals.length > 0 || publishPending,",
      "removals.length > 0,",
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(syncHoldProblems(mutant), []);
  }
});

// One close rule for the user's closes (Esc, the X, the backdrop, the footer
// button): `closeOrOpen` discards a failed draft only when no publish is
// running. Two closes stay direct: a switch's (navigation destroys no draft,
// and it runs after the switch render) and the success arm's settle close,
// which clears the draft itself.
function closeRuleProblems(text) {
  const problems = [];
  const need = {
    "dialog routes through the rule":
      /<Dialog open=\{open\} onOpenChange=\{closeOrOpen\}>/,
    "switch close keeps the draft": /close: \(\) => onOpenChange\(false\)/,
    "footer routes through the rule":
      /onClick=\{\(\) => closeOrOpen\(false\)\}/,
    "idle-only discard":
      /function closeOrOpen\(next: boolean\) \{\s*if \(!next && !pendingPublish\) failedDraftRef\.current = null;\s*onOpenChange\(next\);\s*\}/,
  };
  for (const [what, re] of Object.entries(need)) {
    if (!re.test(text)) problems.push(`missing: ${what}`);
  }
  // The rule's own clear and the success arm's; any other is a bypass.
  const clears = text.split("failedDraftRef.current = null").length - 1;
  if (clears !== 2) problems.push(`failed-draft clears: ${clears}`);
  // Only the switch's close and the success arm's call the prop directly.
  const direct = text.split("onOpenChange(false)").length - 1;
  if (direct !== 2) problems.push(`direct closes: ${direct}`);
  return problems;
}

test("the user's closes take the close rule; a switch's keeps the draft", () => {
  assert.deepEqual(closeRuleProblems(source(HOLD_FILES.dialog)), []);
});

test("a close route that bypasses the rule is caught", () => {
  const live = source(HOLD_FILES.dialog);
  const mutants = [
    live.replace("onOpenChange={closeOrOpen}", "onOpenChange={onOpenChange}"),
    live.replace(
      "onClick={() => closeOrOpen(false)}",
      "onClick={() => onOpenChange(false)}",
    ),
    live.replace(
      "close: () => onOpenChange(false)",
      "close: () => closeOrOpen(false)",
    ),
    live.replace("if (!next && !pendingPublish)", "if (!next)"),
    live.replace(
      "onClick={() => closeOrOpen(false)}",
      "onClick={() => { failedDraftRef.current = null; closeOrOpen(false); }}",
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(closeRuleProblems(mutant), []);
  }
});

// The draft-keeping rule an opening dialog applies before it reseeds. Each arm
// is a case: a dropped provider check hands a Bitbucket reopen a GitHub draft,
// and a dropped generation check brings back a draft a reseed retired.
const REPO_A = "C:/work/harbor";
const REPO_B = "C:/work/anchor";
const failedA = { repo: REPO_A, gen: 4, provider: "github" };
const openArgs = (over) => ({
  prevRepo: REPO_A,
  repo: REPO_A,
  submitting: false,
  failed: null,
  gen: 4,
  provider: "github",
  ...over,
});

test("a same-repo reopen keeps the draft while its publish runs", () => {
  assert.equal(keepDraftOnOpen(openArgs({ submitting: true })), true);
});

test("a same-repo reopen keeps a failed draft for the same provider and generation", () => {
  assert.equal(keepDraftOnOpen(openArgs({ failed: failedA })), true);
});

test("a failed draft reseeds for another provider", () => {
  assert.equal(
    keepDraftOnOpen(openArgs({ failed: failedA, provider: "bitbucket" })),
    false,
  );
});

test("a failed draft a reseed retired (generation moved on) reseeds", () => {
  assert.equal(keepDraftOnOpen(openArgs({ failed: failedA, gen: 5 })), false);
});

test("a failed draft for another repo reseeds", () => {
  assert.equal(
    keepDraftOnOpen(openArgs({ failed: { ...failedA, repo: REPO_B } })),
    false,
  );
});

test("a draft held for another repo reseeds, whatever it carries", () => {
  assert.equal(
    keepDraftOnOpen(openArgs({ prevRepo: REPO_B, failed: failedA })),
    false,
  );
  assert.equal(
    keepDraftOnOpen(openArgs({ prevRepo: REPO_B, submitting: true })),
    false,
  );
});

test("no failed draft and nothing submitting reseeds", () => {
  assert.equal(keepDraftOnOpen(openArgs({})), false);
});

// The dialog's seed applies that rule with its live inputs, ahead of the bump.
function seedRuleProblems(text) {
  const start = text.indexOf("const seedOnOpen = useEffectEvent(");
  const end = text.indexOf("useSeedOnOpen(open, seedOnOpen)");
  if (start < 0 || end < start) return ["seedOnOpen not found"];
  const body = text.slice(start, end);
  const problems = [];
  const call = body.indexOf("keepDraftOnOpen({");
  const bump = body.indexOf("seedGenRef.current += 1");
  if (call < 0) problems.push("seed doesn't apply keepDraftOnOpen");
  else if (bump < 0 || bump < call)
    problems.push("rule applied after the bump");
  for (const arg of [
    "prevRepo: prev,",
    "repo: repoPath,",
    "submitting: form.state.isSubmitting,",
    "failed: failedDraftRef.current,",
    "gen: seedGenRef.current,",
  ]) {
    if (!body.includes(arg)) problems.push(`missing arg: ${arg}`);
  }
  // Shorthand: the dialog's own provider, never a stand-in.
  if (!/^\s*provider,$/m.test(body)) problems.push("missing arg: provider");
  return problems;
}

test("the seed applies the draft-keeping rule with its live inputs", () => {
  assert.deepEqual(seedRuleProblems(source(HOLD_FILES.dialog)), []);
});

test("a seed that skips or misfeeds the rule is caught", () => {
  const live = source(HOLD_FILES.dialog);
  const mutants = [
    live.replace("keepDraftOnOpen({", "Boolean({"),
    live.replace(
      "gen: seedGenRef.current,",
      "gen: failedDraftRef.current?.gen ?? 0,",
    ),
    live.replace(
      "gen: seedGenRef.current,\n        provider,",
      'gen: seedGenRef.current,\n        provider: "github",',
    ),
    live.replace("prevRepo: prev,", "prevRepo: repoPath,"),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(seedRuleProblems(mutant), []);
  }
});
