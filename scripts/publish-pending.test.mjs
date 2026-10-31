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
// button): `closeOrOpen` clears the stored draft only when no publish is
// running AND this instance owns this repo's draft (a late failure stamped
// while it showed defaults must survive its close), and drops that claim with
// it, so a later skip-seed reopen can't re-own another instance's draft. Two
// closes stay direct: a switch's (navigation destroys no draft, and it runs
// after the switch render) and the success arm's settle close. Exactly three
// store clears exist: the rule's, the success arm's and the reseed's retire.
function closeRuleProblems(text) {
  const problems = [];
  const need = {
    "dialog routes through the rule":
      /<Dialog open=\{open\} onOpenChange=\{closeOrOpen\}>/,
    "switch close keeps the draft": /close: \(\) => onOpenChange\(false\)/,
    "footer routes through the rule":
      /onClick=\{\(\) => closeOrOpen\(false\)\}/,
    "idle, owned-only discard":
      /function closeOrOpen\(next: boolean\) \{\s*if \(!next && !pendingPublish && ownsDraft === repoKey\) \{\s*setPublishDrafts\(\(drafts\) => clearDraft\(drafts, repoKey\)\);\s*setOwnsDraft\(null\);\s*\}\s*onOpenChange\(next\);\s*\}/,
  };
  for (const [what, re] of Object.entries(need)) {
    if (!re.test(text)) problems.push(`missing: ${what}`);
  }
  const clears = text.split("clearDraft(").length - 1;
  const routed =
    text.split("setPublishDrafts((drafts) => clearDraft(drafts, repoKey))")
      .length - 1;
  if (clears !== 3 || routed !== 3) {
    problems.push(`draft clears: ${clears}, routed: ${routed}`);
  }
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
  const gate = "if (!next && !pendingPublish && ownsDraft === repoKey)";
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
    live.replace(gate, "if (!next)"),
    live.replace(gate, "if (!next && !pendingPublish)"),
    live.replace(gate, "if (!next && !pendingPublish && ownsDraft)"),
    live.replace(gate, "if (!next && !pendingPublish && ownsDraft !== null)"),
    live.replace(
      "onClick={() => closeOrOpen(false)}",
      "onClick={() => { setPublishDrafts((drafts) => clearDraft(drafts, repoKey)); closeOrOpen(false); }}",
    ),
    live.replace(
      "      setPublishDrafts((drafts) => clearDraft(drafts, repoKey));\n      setOwnsDraft(null);\n    }\n    onOpenChange(next);",
      "      setPublishDrafts((drafts) => clearDraft(drafts, repoKey));\n    }\n    onOpenChange(next);",
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(closeRuleProblems(mutant), []);
  }
});

// What an opening dialog does with its form. Each arm is a case: a dropped
// provider check hands a Bitbucket reopen a GitHub draft, and a restore ranked
// above keep would reset the form under a running submit.
const REPO_A = "c:/work/harbor";
const REPO_B = "c:/work/anchor";
const draftValues = {
  name: "harbor",
  description: "d",
  homepage: "",
  topics: "",
  workspace: "",
  owner: "",
  isPrivate: true,
};
const failedA = { repo: REPO_A, provider: "github", values: draftValues };
const openArgs = (over) => ({
  prevRepo: REPO_A,
  repo: REPO_A,
  submitting: false,
  failed: null,
  provider: "github",
  ...over,
});

test("a same-repo reopen keeps the form while its publish runs", () => {
  assert.equal(keepDraftOnOpen(openArgs({ submitting: true })), "keep");
  assert.equal(
    keepDraftOnOpen(openArgs({ submitting: true, failed: failedA })),
    "keep",
  );
});

test("a failed draft for the same repo and provider restores", () => {
  assert.equal(keepDraftOnOpen(openArgs({ failed: failedA })), "restore");
});

test("a failed draft reseeds for another provider", () => {
  assert.equal(
    keepDraftOnOpen(openArgs({ failed: failedA, provider: "bitbucket" })),
    "reseed",
  );
});

test("a failed draft for another repo reseeds", () => {
  assert.equal(
    keepDraftOnOpen(openArgs({ failed: { ...failedA, repo: REPO_B } })),
    "reseed",
  );
});

test("a cross-repo open reseeds with no draft and restores a matching one", () => {
  assert.equal(keepDraftOnOpen(openArgs({ prevRepo: REPO_B })), "reseed");
  assert.equal(
    keepDraftOnOpen(openArgs({ prevRepo: REPO_B, submitting: true })),
    "reseed",
  );
  assert.equal(
    keepDraftOnOpen(openArgs({ prevRepo: REPO_B, failed: failedA })),
    "restore",
  );
});

test("no failed draft and nothing submitting reseeds", () => {
  assert.equal(keepDraftOnOpen(openArgs({})), "reseed");
});

// The dialog's seed applies that rule with its live inputs: the store's entry
// for this repo key, a restore that survives useForm's per-render update(), and
// a reseed that retires the entry before its reset.
function seedRuleProblems(text) {
  const start = text.indexOf("const seedOnOpen = useEffectEvent(");
  const end = text.indexOf("useSeedOnOpen(open, seedOnOpen)");
  if (start < 0 || end < start) return ["seedOnOpen not found"];
  const body = text.slice(start, end);
  const problems = [];
  if (!body.includes("keepDraftOnOpen({")) {
    problems.push("seed doesn't apply keepDraftOnOpen");
  }
  for (const arg of [
    "const failed = draftFor(usePublishDraftStore.getState().byRepo, repoKey);",
    "prevRepo: prev,",
    "repo: repoKey,",
    "submitting: form.state.isSubmitting,",
  ]) {
    if (!body.includes(arg)) problems.push(`missing arg: ${arg}`);
  }
  // Shorthand: the store's entry and the dialog's own provider.
  if (!/^\s*failed,$/m.test(body)) problems.push("missing arg: failed");
  if (!/^\s*provider,$/m.test(body)) problems.push("missing arg: provider");
  if (!/if \(action === "keep"\) return;/.test(body)) {
    problems.push("keep arm doesn't return");
  }
  const restore =
    /if \(action === "restore" && failed\) \{\s*seedGenRef\.current \+= 1;[\s\S]*?form\.reset\(failed\.values, \{ keepDefaultValues: true \}\);\s*setOwnsDraft\(repoKey\);\s*return;\s*\}/;
  if (!restore.test(body)) problems.push("restore arm");
  const retire = body.indexOf(
    "setPublishDrafts((drafts) => clearDraft(drafts, repoKey));",
  );
  const drop = body.indexOf("setOwnsDraft(null);");
  const reset = body.indexOf("{ ...BLANK_PUBLISH_VALUES, name: defaultName }");
  if (retire < 0 || reset < 0 || retire > reset) {
    problems.push("reseed doesn't retire before its reset");
  }
  if (drop < 0 || drop > reset) problems.push("reseed keeps ownership");
  return problems;
}

test("the seed applies the draft-keeping rule with its live inputs", () => {
  assert.deepEqual(seedRuleProblems(source(HOLD_FILES.dialog)), []);
});

test("a seed that skips or misfeeds the rule is caught", () => {
  const live = source(HOLD_FILES.dialog);
  const restoreCall = "form.reset(failed.values, { keepDefaultValues: true });";
  const retire =
    "    // Retired before the reset, so the mirror can't write the defaults over it.\n    setPublishDrafts((drafts) => clearDraft(drafts, repoKey));\n";
  const mutants = [
    live.replace("keepDraftOnOpen({", "Boolean({"),
    live.replace("prevRepo: prev,", "prevRepo: repoKey,"),
    live.replace("repo: repoKey,", "repo: repoPath,"),
    live.replace(
      "      failed,\n      provider,",
      '      failed,\n      provider: "github",',
    ),
    live.replace(restoreCall, "form.reset(failed.values);"),
    live.replace(restoreCall, ""),
    live.replace(
      "      setOwnsDraft(repoKey);\n      return;",
      "      return;",
    ),
    live.replace(retire, ""),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(seedRuleProblems(mutant), []);
  }
});

// The form's defaultValues never change: useForm's per-commit update() resets
// an untouched form to new defaults, and on a repo switch the old repo's
// mirror would write them into its draft. So defaultValues is the module-level
// constant of plain literals, and every reset in the file keeps the defaults
// (a bare reset with values moves them). Out of reach: a reset reached through
// an alias (a destructured reset, another receiver) and a defaults object
// assigned through the form's own options.
function defaultsProblems(text) {
  const problems = [];
  const uses = [...text.matchAll(/\bdefaultValues\s*:|\.defaultValues\b/g)]
    .length;
  if (
    !/\n {2}const form = useAppForm\(\{\n {4}defaultValues: BLANK_PUBLISH_VALUES,\n/.test(
      text,
    )
  ) {
    problems.push("defaultValues isn't the blank constant");
  }
  if (uses !== 1) problems.push("defaultValues spellings: " + uses);
  const decl =
    /\nconst BLANK_PUBLISH_VALUES: PublishFormValues = \{\n((?: {2}\w+: (?:""|true|false),\n)+)\};\n/.exec(
      text,
    );
  const component = text.indexOf("\nexport function PublishDialog(");
  if (!decl || component < 0 || decl.index > component) {
    problems.push("BLANK_PUBLISH_VALUES isn't a module-level literal constant");
  }
  const receivers = [...text.matchAll(/\.reset\(/g)].length;
  const resets = [...text.matchAll(/\bform\.reset\(/g)].map((m) => {
    let depth = 0;
    for (let i = m.index + "form.reset".length; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        return text.slice(m.index + "form.reset(".length, i);
      }
    }
    return "";
  });
  if (receivers !== resets.length) problems.push("reset on another receiver");
  if (resets.length === 0) problems.push("no seed reset found");
  for (const args of resets) {
    if (!/,\s*\{ keepDefaultValues: true \},?\s*$/.test(args)) {
      problems.push("reset moves the defaults: " + args.trim().slice(0, 60));
    }
  }
  if (/\bform\.update\(/.test(text)) problems.push("form.update call");
  return problems;
}

test("the form's defaults are constant and every reset keeps them", () => {
  assert.deepEqual(defaultsProblems(source(HOLD_FILES.dialog)), []);
});

test("defaults that follow the repo, or a reset that moves them, are caught", () => {
  const live = source(HOLD_FILES.dialog);
  const keep =
    "      { ...BLANK_PUBLISH_VALUES, name: defaultName },\n      { keepDefaultValues: true },\n";
  const mutants = [
    live.replace(
      "    defaultValues: BLANK_PUBLISH_VALUES,",
      "    defaultValues: { ...BLANK_PUBLISH_VALUES, name: defaultName },",
    ),
    live.replace(
      "    defaultValues: BLANK_PUBLISH_VALUES,",
      '    defaultValues: {\n      name: defaultName,\n      description: "",\n      homepage: "",\n      topics: "",\n      workspace: "",\n      owner: "",\n      isPrivate: true,\n    },',
    ),
    live.replace(
      '= {\n  name: "",\n  description: ""',
      '= {\n  name: repoName,\n  description: ""',
    ),
    live.replace(
      keep,
      "      { ...BLANK_PUBLISH_VALUES, name: defaultName },\n",
    ),
    live.replace(
      "form.reset(failed.values, { keepDefaultValues: true });",
      "form.reset(failed.values);",
    ),
    live.replace(
      '    if (action === "keep") return;',
      '    if (action === "keep") return form.reset();',
    ),
    live.replace(
      '    if (action === "keep") return;',
      '    if (action === "keep") return form.update({ defaultValues: BLANK_PUBLISH_VALUES });',
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(defaultsProblems(mutant), []);
  }
});

// The publish settle writes the STORE under the submit's repo key, mounted or
// not: a failure stamps unconditionally (the gate pair picks only which values,
// and only a form still holding the draft claims it), a success clears, and
// drops the claim only when it is still the submit's own repo key.
function settleProblems(text) {
  const problems = [];
  const stamp =
    /const formStillHoldsDraft =\s*draftRepoRef\.current === repoKey && seedGenRef\.current === submitGen;\s*setPublishDrafts\(\(drafts\) =>\s*stampDraft\(\s*drafts,\s*repoKey,\s*provider,\s*formStillHoldsDraft \? form\.state\.values : value,\s*\),\s*\);\s*if \(formStillHoldsDraft\) setOwnsDraft\(repoKey\);/;
  if (!stamp.test(text)) problems.push("catch arm doesn't stamp the store");
  if (text.split("stampDraft(").length - 1 !== 1) {
    problems.push("stamp count");
  }
  const clear =
    /if \(ourDraft\) onOpenChange\(false\);\s*setPublishDrafts\(\(drafts\) => clearDraft\(drafts, repoKey\)\);\s*(?:\/\/.*\n\s*)*setOwnsDraft\(\(owned\) => \(owned === repoKey \? null : owned\)\);/;
  if (!clear.test(text)) problems.push("success arm doesn't clear the store");
  return problems;
}

test("the publish settle stamps or clears the store under its repo key", () => {
  assert.deepEqual(settleProblems(source(HOLD_FILES.dialog)), []);
});

test("a settle that skips or gates its store write is caught", () => {
  const live = source(HOLD_FILES.dialog);
  const mutants = [
    live.replace(
      /\n\s*setPublishDrafts\(\(drafts\) =>\s*stampDraft\([\s\S]*?\),\s*\);/,
      "",
    ),
    live.replace(
      "        setPublishDrafts((drafts) =>\n          stampDraft(",
      "        if (formStillHoldsDraft) setPublishDrafts((drafts) =>\n          stampDraft(",
    ),
    live.replace(
      "if (ourDraft) onOpenChange(false);\n        setPublishDrafts((drafts) => clearDraft(drafts, repoKey));",
      "if (ourDraft) onOpenChange(false);",
    ),
    live.replace(
      "if (formStillHoldsDraft) setOwnsDraft(repoKey);",
      "setOwnsDraft(repoKey);",
    ),
    live.replace(
      "setOwnsDraft((owned) => (owned === repoKey ? null : owned));",
      "setOwnsDraft(null);",
    ),
    live.replace(
      "setOwnsDraft((owned) => (owned === repoKey ? null : owned));",
      "setOwnsDraft((owned) => (owned !== null ? null : owned));",
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(settleProblems(mutant), []);
  }
});

// The mirror keeps post-failure edits in the store while THIS open instance
// owns the draft. Its write pins the effect's repoKey, and its cleanup calls
// `unsubscribe()`: the store's subscribe returns a Subscription object.
function mirrorProblems(text) {
  const problems = [];
  const mirror =
    /useEffect\(\(\) => \{\s*if \(!open \|\| ownsDraft !== repoKey \|\| storedProvider !== provider\) return;\s*const sub = form\.store\.subscribe\(\(\) => \{\s*setPublishDrafts\(\(drafts\) =>\s*updateDraftValues\(drafts, repoKey, form\.state\.values\),\s*\);\s*\}\);\s*return \(\) => sub\.unsubscribe\(\);\s*\}, \[open, ownsDraft, storedProvider, provider, repoKey, form\]\);/;
  if (!mirror.test(text)) problems.push("mirror effect");
  if (
    !/usePublishDraftStore\(\s*\(s\) => s\.byRepo\[repoKey\]\?\.provider,\s*\)/.test(
      text,
    )
  ) {
    problems.push("stored provider select");
  }
  return problems;
}

test("post-failure edits mirror into the store while owned", () => {
  assert.deepEqual(mirrorProblems(source(HOLD_FILES.dialog)), []);
});

test("a mirror that leaks, retargets or never subscribes is caught", () => {
  const live = source(HOLD_FILES.dialog);
  const mutants = [
    live.replace(
      /const sub = form\.store\.subscribe\([\s\S]*?\}\);\s*return \(\) => sub\.unsubscribe\(\);/,
      "",
    ),
    live.replace(
      "return () => sub.unsubscribe();",
      "return sub as unknown as () => void;",
    ),
    live.replace(
      "const sub = form.store.subscribe(",
      "return form.store.subscribe(",
    ),
    live.replace(
      "if (!open || ownsDraft !== repoKey || storedProvider !== provider) return;",
      "if (!open || !ownsDraft) return;",
    ),
    live.replace(
      "updateDraftValues(drafts, repoKey, form.state.values)",
      "updateDraftValues(drafts, normPath(repoPath), form.state.values)",
    ),
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, live);
    assert.notDeepEqual(mirrorProblems(mutant), []);
  }
});

// Identity-keyed holds (P1-hold)

const WT_A = "C:/work/harbor";
const WT_B = "C:/work/harbor-feature";
const ID = "C:/work/harbor/.git";
const OTHER_ID = "C:/work/anchor/.git";
const ID_VARS = { provider: "github", name: "harbor" };

test("the identity rides the key as a third element", () => {
  assert.deepEqual(publishRepoKey(WT_A, ID), ["publish-repo", WT_A, ID]);
  assert.deepEqual(publishRepoKey(WT_A, undefined), ["publish-repo", WT_A]);
});

test("a sibling worktree with the same identity sees the publish", () => {
  const entries = [entry(publishRepoKey(WT_A, ID), ID_VARS)];
  assert.deepEqual(pendingPublishesFor(entries, WT_B, ID), [ID_VARS]);
  assert.deepEqual(pendingPublishesFor(entries, WT_A), [ID_VARS]);
  assert.deepEqual(pendingPublishesFor(entries, WT_B), []);
  assert.deepEqual(pendingPublishesFor(entries, WT_B, OTHER_ID), []);
});

test("a path-only entry never matches a foreign path by identity", () => {
  const entries = [entry(publishRepoKey(WT_A), ID_VARS)];
  assert.deepEqual(pendingPublishesFor(entries, WT_B, ID), []);
  // No undefined === undefined match: absent reader identity, absent key identity.
  assert.deepEqual(pendingPublishesFor(entries, WT_B, undefined), []);
  assert.deepEqual(pendingPublishesFor(entries, WT_A, ID), [ID_VARS]);
});

test("an identity equal to the checkout path (raw-path fallback) matches", () => {
  const entries = [entry(publishRepoKey(WT_A, WT_A), ID_VARS)];
  assert.deepEqual(pendingPublishesFor(entries, WT_A, WT_A), [ID_VARS]);
  assert.deepEqual(pendingPublishesFor(entries, WT_A), [ID_VARS]);
  assert.deepEqual(pendingPublishesFor(entries, WT_B, WT_A), [ID_VARS]);
});

test("identity-matched reads keep the hostile-shape and order rules", () => {
  assert.deepEqual(
    pendingPublishesFor([entry(["publish-repo"], ID_VARS)], WT_B, ID),
    [],
  );
  assert.deepEqual(
    pendingPublishesFor(
      [entry(publishRepoKey(WT_A, ID), { provider: "github" })],
      WT_B,
      ID,
    ),
    [],
  );
  assert.deepEqual(
    pendingPublishesFor(
      [
        entry(publishRepoKey(WT_A, ID), ID_VARS),
        {
          ...entry(publishRepoKey(WT_B, ID), { provider: "gitlab", name: "h" }),
          paused: true,
        },
      ],
      WT_B,
      ID,
    ),
    [ID_VARS, { provider: "gitlab", name: "h" }],
  );
});
