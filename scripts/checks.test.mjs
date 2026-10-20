// Negative controls for the guard scanners. Their worst failure mode is
// silent fail-open — a pattern that stops matching still prints "OK" — so every
// predicate keeps a fixture that MUST hit and a fixture that must not. The
// scripts export their predicates and gate their CLI body on a main-module path
// check (`process.argv[1]` vs `import.meta.url` — portable across node versions,
// unlike `import.meta.main`), so importing them here runs no scan, touches no
// disk, and cannot silently no-op on a runtime older than the gate.
//
// Node's stdlib test runner and node: imports only, no dev dependency, so the
// CI `guards` job runs `node --test "scripts/*.test.mjs"` with no install step.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXEMPT as APPIMAGE_EXEMPT,
  verdict as appimageTwinsVerdict,
  parseGuardAllowed,
  parseRustVars,
} from "./check-appimage-env-twins.mjs";
import {
  CHECKS,
  cookSource,
  cookStringBody,
  EXTENSIONS,
  generateChordCalls,
  isPreparingSlotHost,
  MCP_FLUSH_CALLER,
  MCP_FLUSH_MODULE,
  MCP_SECRET_API,
  MCP_SECRET_READ_ONLY,
  okReportLine,
  preparingSlotSites,
  reachesGitQueriesInternal,
  reachesQueriesInternalFromSibling,
  runCheck,
  scopePinFailure,
  SLOT_ROLES,
  splitTopLevel,
  stripComments,
  unscannedScripts,
  view,
} from "./check-banned-patterns.mjs";
import {
  footerOf,
  hasInlineGap,
  INLINE_GAP,
} from "./check-built-whitespace.mjs";
import { fragmentVerdict } from "./check-changelog-fragment.mjs";
import {
  parseInvoked,
  parseRegistered,
  staleAllowlistEntries as staleCommandEntries,
} from "./check-dead-surface.mjs";
import {
  CARRIER_TOKEN as ENFORCED_CARRIER_TOKEN,
  parseEnforcedSuites,
  readsExpectDeps,
  unlistedCarriers,
} from "./check-enforced-node-suites.mjs";
import {
  verdict as dedupeVerdict,
  parsePackageVersions,
  SINGLETONS,
} from "./check-lockfile-dedupe.mjs";
import {
  cardRefOf,
  frontmatterOf,
  isAbsoluteRef,
  servedRelPathsFor,
} from "./check-og-cards.mjs";
import {
  bindsReceiver,
  fileKey,
  pendingReads,
  ALLOWLIST as REUSED_VIEW_ALLOWLIST,
  LIMITATIONS as REUSED_VIEW_LIMITATIONS,
  MEMBERS as REUSED_VIEW_MEMBERS,
  verdict as reusedViewVerdict,
} from "./check-reused-view-pending.mjs";
import {
  CARRIERS,
  MOUNTED_CARRIERS,
  missingSentinels,
} from "./check-rule-mirrors.mjs";
import {
  checkBareBranchRevs,
  checkCompareEndpoints,
  checkMergeIgnoredGuard,
  checkRefspecTemplates,
  checkSecretArgv,
  checkShortRefNames,
  checkStderrOnlyGitError,
  checkSyncCommands,
  checkTestMarkerBranches,
  enclosingFn,
  lexRust,
  MERGE_GUARD_ALLOWLIST,
  MERGE_GUARD_NOTE,
  splitStaleEntries,
  staleAllowlistEntries,
  TEST_MARKER_ALLOWLIST,
} from "./check-rust-invariants.mjs";
import {
  diffTrees,
  EXEMPT,
  EXPECTED_ABSENT,
  isTextFile,
  normalize as normalizeSkill,
  SINGLE_TREE,
} from "./check-skill-mirrors.mjs";
import {
  crateNameFor,
  declaredNpmAliases,
  declaredNpmPackages,
  duplicateCrateNames,
  mismatchedPairs,
  npmNameFor,
  parseCrateVersions,
  parseNpmVersions,
  verdict,
} from "./check-tauri-plugin-parity.mjs";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";

// -------------------------------------------------- check-changelog-fragment

for (const [name, changedFiles, presentFiles, prTitle, required, satisfied] of [
  [
    "fragment present",
    ["src/app.ts"],
    ["changelog.d/added-app.md"],
    "",
    true,
    true,
  ],
  ["fragment missing", ["src/app.ts"], [], "", true, false],
  [
    "title opt-out",
    ["src/app.ts"],
    [],
    "fix: [SKIP-CHANGELOG] copy",
    false,
    true,
  ],
  ["site only", ["site/page.astro"], [], "", false, true],
  [
    "deleted fragment",
    ["src/app.ts", "changelog.d/fixed-app.md"],
    ["src/app.ts"],
    "",
    true,
    false,
  ],
  [
    "wrong category",
    ["src/app.ts"],
    ["changelog.d/removed-app.md"],
    "",
    true,
    false,
  ],
  ["wrong directory", ["src/app.ts"], ["other/fixed-app.md"], "", true, false],
  [
    "directory case",
    ["src/app.ts"],
    ["Changelog.d/fixed-app.md"],
    "",
    true,
    false,
  ],
  [
    "basename case",
    ["src/app.ts"],
    ["changelog.d/FIXED-app.MD"],
    "",
    true,
    true,
  ],
  [
    "nested fragment",
    ["src/app.ts"],
    ["changelog.d/fixed-dir/app.md"],
    "",
    true,
    false,
  ],
  ["empty slug", ["src/app.ts"], ["changelog.d/fixed-.md"], "", true, false],
  ["deleted Rust source", ["src-tauri/src/app.rs"], [], "", true, false],
  [
    "source prefix boundary",
    ["src-other/app.ts", "Src/app.ts"],
    [],
    "",
    false,
    true,
  ],
  ["empty diff", [], [], "", false, true],
  [
    "fragment precedes title opt-out",
    ["src/app.ts"],
    ["changelog.d/changed-app.md"],
    "skip-changelog",
    true,
    true,
  ],
]) {
  test(`changelog-fragment: ${name}`, () => {
    const result = fragmentVerdict({ changedFiles, presentFiles, prTitle });
    assert.equal(result.required, required);
    assert.equal(result.satisfied, satisfied);
    assert.ok(result.reason.length > 0);
    if (!satisfied) {
      assert.ok(
        result.reason.startsWith("::error::This PR changes src/ or src-tauri/"),
      );
    }
  });
}

test("changelog-fragment: invalid inputs fail closed", () => {
  for (const input of [
    { changedFiles: null, presentFiles: [], prTitle: "" },
    { changedFiles: [], presentFiles: [null], prTitle: "" },
    { changedFiles: [], presentFiles: [], prTitle: null },
  ]) {
    assert.throws(() => fragmentVerdict(input), TypeError);
  }
});

// ------------------------------------------------------- check-banned-patterns

/** The named check's scanner, applied to a fixture source string. */
function scanner(name) {
  const check = CHECKS.find((c) => c.name === name);
  assert.ok(check, `no check named ${name}`);
  return (source) => check.scan(view(source));
}

const hoverReveal = scanner("hover-reveal");
const modKey = scanner("hand-rolled-mod-key");
const inlineClipTitle = scanner("inline-clip-title");
const selectItemClipTitle = scanner("select-item-clip-title");
const setQueryData = scanner("setQueryData-noop");
const settingsRollback = scanner("async-settings-rollback");
const bareMutate = scanner("bare-mutate");
const menuSuppression = scanner("context-menu-suppression");
const loneActivity = scanner("lone-activity-boundary");
const seedOnOpen = scanner("seed-effect-on-open");
const finishAndSurface = scanner("generator-dialog-finish-and-surface");
const diffStatPair = scanner("hand-rolled-diff-stat");
const diffStatSlot = scanner("list-row-diff-stat-slot");
const kindBadge = scanner("kind-badge-single-source");
const binaryMarker = scanner("binary-marker-single-source");
const nullFallback = scanner("null-suspense-fallback");
const preparingSlotHide = scanner("preparing-slot-hide");
const bareGroupLabel = scanner("bare-group-label");
const unguardedDispatcher = scanner("unguarded-binding-dispatcher");
const titledDisabledTrigger = scanner("titled-disabled-trigger");
const titledBadge = scanner("titled-badge");
const ungatedProducer = scanner("ungated-notification-producer");
const handRolledStoreOpen = scanner("hand-rolled-store-open");
const rawStoreReload = scanner("raw-store-reload");
const inlineRepoIdentityQuery = scanner("inline-repo-identity-query");
const queriesInternalImport = scanner("queries-internal-import");
const queriesBarrelInternal = scanner("queries-barrel-internal-reference");
const queriesInternalReexport = scanner("queries-internal-reexport");
const unpinnedMutationIdentity = scanner("mutation-identity-pinning");
const rawReactQueryMutation = scanner("raw-react-query-mutation");

test("hover-reveal catches every Tailwind spelling of the idiom", () => {
  for (const classes of [
    "opacity-0 group-hover:opacity-100",
    "invisible group-hover:visible",
    "hidden group-hover:block",
    "hidden group-hover:flex",
    "hidden group-hover:inline",
    "hidden group-hover:inline-flex",
  ]) {
    assert.deepEqual(
      hoverReveal(`const cls = "${classes}";`),
      [1],
      `should flag ${classes}`,
    );
  }
});

test("hover-reveal pairs across a wrapped class list", () => {
  const source = [
    "<button",
    "  className={cn(",
    '    "invisible transition",',
    '    "group-hover:visible",',
    "  )}",
    "/>",
  ].join("\n");
  assert.deepEqual(hoverReveal(source), [3]);
});

test("hover-reveal does not pair a compound utility that merely ends in the token", () => {
  // The boundary guard's whole job: `overflow-hidden` is a layout utility, not
  // a hidden element, and pairing it would flag ordinary scroll containers.
  assert.deepEqual(
    hoverReveal('const cls = "overflow-hidden group-hover:block";'),
    [],
  );
  assert.deepEqual(
    hoverReveal('const cls = "group-hover:visible-ish invisible-thing";'),
    [],
  );
});

test("hover-reveal ignores a hiding utility with no reveal partner", () => {
  assert.deepEqual(hoverReveal('const cls = "hidden md:flex";'), []);
  assert.deepEqual(hoverReveal('const cls = "opacity-0 animate-in";'), []);
});

test("hover-reveal ignores the idiom named in a comment", () => {
  // src/main.tsx documents the vendored diff widget's own `group-hover:visible`
  // next to our `.invisible` utility; comment stripping is what keeps it clean.
  const source = [
    "// the add-widget button reveals via `group-hover:visible`,",
    "// which our `.invisible` utility would otherwise beat.",
    'import "@git-diff-view/react/styles/diff-view.css";',
  ].join("\n");
  assert.deepEqual(hoverReveal(source), []);
});

test("hand-rolled-mod-key flags a single raw flag and each half of a split pair", () => {
  assert.deepEqual(modKey("if (e.metaKey) submit();"), [1]);
  assert.deepEqual(modKey("if (e.ctrlKey) submit();"), [1]);
  const split = ["const mod =", "  e.metaKey ||", "  e.ctrlKey;"].join("\n");
  assert.deepEqual(modKey(split), [2, 3]);
});

test("hand-rolled-mod-key ignores other modifiers and the helper's own name", () => {
  assert.deepEqual(modKey("if (e.shiftKey || e.altKey) return;"), []);
  assert.deepEqual(modKey("const label = formatBinding(binding);"), []);
});

test("inline-clip-title flags each local spelling of the clip-tooltip idiom", () => {
  // The blank-on-else ternary — the ancestor-suppressing defect shape.
  const ternary = [
    "onMouseEnter={(e) => {",
    "  const el = e.currentTarget;",
    '  el.title = el.scrollWidth > el.clientWidth ? name : "";',
    "}}",
  ].join("\n");
  assert.deepEqual(inlineClipTitle(ternary), [3]);
  // The corrected if/else form is still an inline copy: the ratchet points
  // both shapes at the shared helper.
  const ifElse = [
    "const el = e.currentTarget;",
    "if (el.scrollWidth > el.clientWidth) el.title = value;",
    'else el.removeAttribute("title");',
  ].join("\n");
  assert.deepEqual(inlineClipTitle(ifElse), [2]);
  // The set-if-absent, both-axes variant: the guard READ doesn't pair (no
  // assignment), but the write downstream is still in range of the measure.
  const guarded = [
    "if (",
    "  !el.title &&",
    "  (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight)",
    ")",
    '  el.title = el.textContent ?? "";',
  ].join("\n");
  assert.deepEqual(inlineClipTitle(guarded), [3]);
});

test("inline-clip-title leaves title data reads and plain scroll code alone", () => {
  // A `.title` read is not the idiom — only the write anchors a pair. This is
  // the PlanView shape: a scroll-to-bottom near `{ title: draft.title }`.
  const dataRead = [
    "scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });",
    "setPendingIssueDraft({ title: draft.title, body: draft.body });",
  ].join("\n");
  assert.deepEqual(inlineClipTitle(dataRead), []);
  assert.deepEqual(
    inlineClipTitle("<span onMouseEnter={clipTitle(member.title)} />"),
    [],
  );
  // Scroll-stick and textarea autosize measure without touching `title`.
  assert.deepEqual(inlineClipTitle("el.scrollTop = el.scrollHeight;"), []);
  assert.deepEqual(
    inlineClipTitle("ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;"),
    [],
  );
});

test("inline-clip-title exempts the helper file and vendored ui only", () => {
  const { appliesTo } = CHECKS.find((c) => c.name === "inline-clip-title");
  assert.equal(appliesTo("src/lib/clip-title.ts"), false);
  assert.equal(appliesTo("src/components/ui/select.tsx"), false);
  assert.equal(appliesTo("src/features/pulls/PrTimeline.tsx"), true);
});

test("select-item-clip-title flags the superseded item-level handler, wrapped or not", () => {
  assert.deepEqual(
    selectItemClipTitle(
      "<SelectItem key={b} value={b} onMouseEnter={clipTitle(b)}>",
    ),
    [1],
  );
  // Wrapped props (the shape the WorktreesDialog sites had): the [\s\S] gap is
  // what reaches past the `=>` an intervening prop expression may carry.
  const wrapped = [
    "<SelectItem",
    "  key={b.name}",
    "  value={b.name}",
    "  onMouseEnter={clipTitle(b.name)}",
    ">",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(wrapped), [1]);
  // A clip handler on a hand-rolled span INSIDE the item is the same dead
  // shape: an unbounded span never measures clipped there either.
  const inner = [
    "<SelectItem key={b} value={b}>",
    "  <span onMouseEnter={clipTitleFromText}>{b}</span>",
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(inner), [1]);
  // The pre-conversion dead span carries no clipTitle token at all — only the
  // block-truncate arm sees this most-likely copy-paste regression.
  const deadSpan = [
    "<SelectItem key={b} value={b}>",
    '  <span className="block truncate">{b}</span>',
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(deadSpan), [1]);
  // A synthetic SELF-BOUNDED span (an explicit max-w keeps its handler live).
  // At close range it still pairs — the guard cannot see width bounds — so a
  // real one would need the allowlist. No in-tree site carries this shape
  // today: in-item path rows route through PathText.
  const bounded = [
    "<SelectItem key={i.id} value={i.id}>",
    "  <span",
    '    className="max-w-64 truncate font-mono"',
    "    onMouseEnter={clipTitle(found)}",
    "  >",
    "    {found}",
    "  </span>",
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(bounded), [1]);
});

test("select-item-clip-title leaves the SelectClipText idiom and trigger handlers alone", () => {
  const converted = [
    "<SelectItem key={b} value={b}>",
    "  <SelectClipText>{b}</SelectClipText>",
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(converted), []);
  // The closed field's handler sits on SelectValue, ABOVE the items — the
  // pairing direction (item first) is what keeps it clean.
  const trigger = [
    '<SelectTrigger className="w-full">',
    "  <SelectValue onMouseEnter={clipTitleFromText} />",
    "</SelectTrigger>",
    "<SelectContent>",
    "  <SelectItem key={b} value={b}>",
    "    <SelectClipText>{b}</SelectClipText>",
    "  </SelectItem>",
    "</SelectContent>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(trigger), []);
  // Row-level clipTitle away from any Select stays the sanctioned idiom.
  assert.deepEqual(
    selectItemClipTitle("<button onMouseEnter={clipTitle(path)} />"),
    [],
  );
  // Tempering stops the scan at the item's closing tag: an ADJACENT picker's
  // trigger handler right after a completed item can never pair, however
  // compact the layout — this exact fixture fired before the tempered step.
  const stacked = [
    "<SelectItem value={ALL}>All</SelectItem>",
    "</SelectContent>",
    "</Select>",
    "<Select value={x} onValueChange={setX}>",
    "  <SelectTrigger>",
    "    <SelectValue onMouseEnter={clipTitleFromText} />",
    "  </SelectTrigger>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(stacked), []);
});

test("select-item-clip-title exempts vendored ui only", () => {
  const { appliesTo } = CHECKS.find((c) => c.name === "select-item-clip-title");
  assert.equal(appliesTo("src/components/ui/select.tsx"), false);
  assert.equal(appliesTo("src/components/select-clip-text.tsx"), true);
  assert.equal(appliesTo("src/features/history/HistoryDialogs.tsx"), true);
});

test("select-item-clip-title flags the flex clip span across the override", () => {
  // The flex spelling of the dead span: `flex-1` alone never wins against
  // ItemText's nowrap intrinsic floor, so the truncate cannot engage.
  const bare = [
    "<SelectItem key={b} value={b}>",
    '  <span className="min-w-0 flex-1 truncate">{b}</span>',
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(bare), [1]);
  // SelectControl's real row, minus its clipTitleFromText prop so only this arm
  // can fire: the item-level override that revives the truncate sits between the
  // tag and the child, which is why the window doubles PAIR_GAP — the live site
  // measures 150 normalized chars, and a site drifting past 160 would go missed
  // with its allowlist entry reading stale.
  const overridden = [
    "<SelectItem",
    "  key={optionValue}",
    "  value={optionValue}",
    "  disabled={disabledItems?.has(optionValue)}",
    '  className="*:first:min-w-0 *:first:shrink"',
    ">",
    '  <span className="min-w-0 flex-1 truncate">{display}</span>',
    "</SelectItem>",
  ].join("\n");
  assert.deepEqual(selectItemClipTitle(overridden), [1]);
  // The arm's bound: the same utility trio is ordinary flex layout anywhere
  // else, so only the SelectItem anchor makes it the dead span.
  assert.deepEqual(
    selectItemClipTitle('<div className="min-w-0 flex-1 truncate">{d}</div>'),
    [],
  );
});

test("select-item-clip-title allowlists the flex spelling per file", () => {
  const check = CHECKS.find((c) => c.name === "select-item-clip-title");
  const row = [
    "<SelectItem key={v} value={v}>",
    '  <span className="min-w-0 flex-1 truncate">{d}</span>',
    "</SelectItem>",
  ].join("\n");
  const files = [
    "src/components/form/fields.tsx",
    "src/features/pulls/SomeNewPicker.tsx",
  ];
  const views = new Map(files.map((f) => [f, view(row)]));
  // The shared control's entry suppresses only its own file; the same markup in
  // a fresh picker (which carries no override) still reports.
  const { violations } = runCheck(check, files, views);
  assert.deepEqual(violations, ["src/features/pulls/SomeNewPicker.tsx:1"]);
});

test("setQueryData-noop catches a call wrapped across lines", () => {
  const source = [
    "queryClient.setQueryData(",
    "  keys.pullRequest(repo, number),",
    "  undefined,",
    ");",
  ].join("\n");
  assert.deepEqual(setQueryData(source), [1]);
});

test("setQueryData-noop sees through nested type arguments", () => {
  assert.deepEqual(
    setQueryData("qc.setQueryData<Record<string, Foo>>(key, undefined);"),
    [1],
  );
  assert.deepEqual(
    setQueryData("qc.setQueryData<Foo[]>(key, undefined);"),
    [1],
  );
});

test("setQueryData-noop resolves the LAST argument past a comma-bearing key", () => {
  assert.deepEqual(
    setQueryData("qc.setQueryData(keys.pr(repo, number), undefined);"),
    [1],
  );
});

test("setQueryData-noop leaves real writes alone", () => {
  assert.deepEqual(setQueryData("qc.setQueryData(key, previous);"), []);
  assert.deepEqual(
    setQueryData("qc.setQueryData(key, (old) => ({ ...old, x: 1 }));"),
    [],
  );
});

test("setQueryData-noop does not reach across a `;` statement boundary", () => {
  // The whole-file view joins lines, so the argument run is `;`-free and
  // length-bounded — otherwise this pairs one call with the next statement.
  // The bound is exactly that and no more: `;` is not the only boundary in JS,
  // so a JSX prop or object member holding `, undefined)` within 200 chars of a
  // clean call still pairs (a loud false positive, fixable at the call site),
  // and a `;` inside a string key ends the run early (the one fail-open).
  const source = [
    "qc.setQueryData(key, previous);",
    "logger.debug(label, undefined);",
  ].join("\n");
  assert.deepEqual(setQueryData(source), []);
});

test("async-settings-rollback flags an optimistic patch whose onError refetches", () => {
  // The pre-fix shape, in both its bodies: the arrow the two settings hooks
  // used, and the block detail-rail used to clear its focus arm in.
  const arrow = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "saveSettings.mutate(updated, {",
    "  onError: () =>",
    "    queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(arrow), [3]);
  const block = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "saveSettings.mutate(updated, {",
    "  onError: () => {",
    "    refocus.current = null;",
    "    queryClient.invalidateQueries({ queryKey: settingsKeys.settings });",
    "  },",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(block), [3]);
});

test("async-settings-rollback gates on a TYPED optimistic patch too", () => {
  // The gate is all-or-nothing per file: a spelling it can't see turns the whole
  // check off there. The repo already types the sibling read
  // (`getQueryData<AppSettings>`), so the typed write is a plausible next edit —
  // including the nested-generic form a `<[^>]*>` group would stop short of.
  for (const call of [
    "queryClient.setQueryData<AppSettings>(settingsKeys.settings, updated);",
    "queryClient.setQueryData<Record<string, AppSettings>>(settingsKeys.settings, u);",
  ]) {
    const source = [
      call,
      "saveSettings.mutate(updated, {",
      "  onError: () =>",
      "    queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
      "});",
    ].join("\n");
    assert.deepEqual(settingsRollback(source), [3], `should gate on ${call}`);
  }
});

test("async-settings-rollback pairs across functions, not just adjacent code", () => {
  // The property `onlyWhen` exists for: the gating patch and the mutation it
  // guards can live in different functions of the same hook file, far outside
  // any proximity window. Padding is deliberately >PAIR_GAP (160).
  const source = [
    "export function useSomethingCollapsed() {",
    "  function apply(next) {",
    "    queryClient.setQueryData(settingsKeys.settings, updated);",
    "  }",
    "  const pad1 = someHelper(alpha, beta, gamma, delta, epsilon, zeta, eta);",
    "  const pad2 = someHelper(alpha, beta, gamma, delta, epsilon, zeta, eta);",
    "  const pad3 = someHelper(alpha, beta, gamma, delta, epsilon, zeta, eta);",
    "  const pad4 = someHelper(alpha, beta, gamma, delta, epsilon, zeta, eta);",
    "  function persist(updated) {",
    "    saveSettings.mutate(updated, {",
    "      onError: () =>",
    "        queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
    "    });",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(settingsRollback(source), [11]);
});

test("async-settings-rollback needs BOTH halves, in the same file", () => {
  // No live file trips the failure half today — every settings invalidate
  // under src/ is success-path. The gate is forward-looking: a file that
  // refetches settings from an onError with nothing optimistic to roll back
  // stays clean.
  const noPatch = [
    "remove.mutate(path, {",
    "  onError: () =>",
    "    queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(noPatch), []);
  // The happy-path reconcile every settings mutation carries is onSuccess, so
  // the patch alone never pairs with it.
  const onSuccess = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "return useMutation({",
    "  mutationFn: saveSettingsMerged,",
    "  onSuccess: () =>",
    "    queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(onSuccess), []);
});

test("async-settings-rollback leaves the guarded synchronous restore alone", () => {
  // The guarded-restore shape this check exists to hold, in its onError
  // spelling: latest-write guard, then the snapshot written straight back.
  const fixed = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "saveSettings.mutate(updated, {",
    "  onError: () => {",
    "    const latest = queryClient.getQueryData(settingsKeys.settings);",
    "    if (latest?.theme !== next) return;",
    "    queryClient.setQueryData(settingsKeys.settings, current);",
    "  },",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(fixed), []);
});

test("async-settings-rollback flags the awaited catch form's refetch", () => {
  // The settings writers start their save as `void mutateAsync(…).catch(…)`, so
  // the rollback lives in a catch arrow — a refetch there is the same class.
  const arrow = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "void saveSettings.mutateAsync(updated).catch(() =>",
    "  queryClient.invalidateQueries({ queryKey: settingsKeys.settings }),",
    ");",
  ].join("\n");
  assert.deepEqual(settingsRollback(arrow), [2]);
  const block = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "try {",
    "  await saveSettings.mutateAsync(updated);",
    "} catch {",
    "  queryClient.invalidateQueries({ queryKey: settingsKeys.settings });",
    "}",
  ].join("\n");
  assert.deepEqual(settingsRollback(block), [4]);
});

test("async-settings-rollback leaves the catch form's snapshot restore alone", () => {
  // The shape the three settings writers ship (useApplyTheme, the detail rail,
  // the composer collapse).
  const fixed = [
    "queryClient.setQueryData(settingsKeys.settings, updated);",
    "void saveSettings.mutateAsync(updated).catch(() => {",
    "  const latest = queryClient.getQueryData(settingsKeys.settings);",
    "  if (latest?.theme !== next) return;",
    "  queryClient.setQueryData(settingsKeys.settings, current);",
    "});",
  ].join("\n");
  assert.deepEqual(settingsRollback(fixed), []);
});

test("bare-mutate flags every way a call reaches its callbacks", () => {
  // The reason this check matches the CALL and not the callbacks object: a
  // hoisted options object (`.mutate(vars, opts)`) carries the callbacks out of
  // sight, and no regex anchored on `onSuccess`/`onError` sees it.
  assert.deepEqual(
    bareMutate(
      'del.mutate(hook.id, { onSuccess: () => toast.success("x"), onError: e });',
    ),
    [1],
  );
  const hoisted = [
    "const opts = { onSuccess: done, onError: toastError };",
    "update.mutate({ id, body }, opts);",
  ].join("\n");
  assert.deepEqual(bareMutate(hoisted), [2]);
  assert.deepEqual(
    bareMutate("setEnforcement.mutate(vars, { onError: toastError });"),
    [1],
  );
});

test("bare-mutate flags a bare call carrying no callbacks", () => {
  // Deliberate: a fire-and-forget mutation here still loses nothing to the
  // unmount, but the ratchet stays a token match — an exemption is an
  // allowlist entry with rationale, not a hole in the pattern.
  assert.deepEqual(bareMutate("ping.mutate(hook.id);"), [1]);
  assert.deepEqual(bareMutate("refresh.mutate ();"), [1]);
});

test("bare-mutate catches the dot-less destructured route", () => {
  // `const { mutate } = useX()` reaches the same call with no `.mutate` token
  // for the first pattern to see (useReconcileLocalPrs is a live site).
  assert.deepEqual(
    bareMutate("const { mutate } = useUpdateLocalPr(repo);"),
    [1],
  );
  assert.deepEqual(
    bareMutate("const { mutate: save } = useUpdateThing(repo);"),
    [1],
  );
  assert.deepEqual(
    bareMutate("const { isPending, mutate } = useX(repo);"),
    [1],
  );
  // Wrapped by the formatter: caught because this pattern reads the whole-file
  // view, where `[^}]*` still can't cross the destructure's own closing brace.
  const wrapped = [
    "const {",
    "  mutate,",
    "  isPending,",
    "} = useUpdateSomethingWithALongName(repoPath);",
  ].join("\n");
  assert.deepEqual(bareMutate(wrapped), [1]);
});

test("bare-mutate leaves the awaited idiom and comments alone", () => {
  const awaited = [
    "await update.mutateAsync(form);",
    'toast.success("Repository settings saved");',
  ].join("\n");
  assert.deepEqual(bareMutate(awaited), []);
  // The `\b` after `mutate` is the whole reason the destructure pattern can
  // coexist with the idiom it is enforcing.
  assert.deepEqual(
    bareMutate("const { mutateAsync } = useUpdateRepoSettings(repo);"),
    [],
  );
  assert.deepEqual(
    bareMutate("const { mutateAsync, isPending } = useX(repo);"),
    [],
  );
  const documented = [
    "// never `.mutate(vars, { onSuccess, onError })` — the callbacks are",
    "// dropped when the observer unmounts.",
    "await save.mutateAsync(vars);",
  ].join("\n");
  assert.deepEqual(bareMutate(documented), []);
});

test("bare-mutate applies repo-wide outside the vendored primitives", () => {
  // Every surface can lose its observer mid-flight, so the scope is all of
  // src/; the vendored ui/ primitives are the one carve-out (never edited here,
  // and they never mutate). The floor pin keeps an appliesTo typo from leaving
  // the scan nearly inert while it still prints OK.
  const check = CHECKS.find((c) => c.name === "bare-mutate");
  for (const file of [
    "src/features/repo-settings/RulesetsSection.tsx",
    "src/features/pulls/useReconcileLocalPrs.ts",
    "src/features/diff/DiffViewer.tsx",
    "src/features/scripts/TasksPanel.tsx",
    "src/App.tsx",
    "src/lib/settings/queries.ts",
    "src/components/detail-rail.tsx",
  ]) {
    assert.equal(check.appliesTo(file), true, `should scan ${file}`);
  }
  assert.equal(
    check.appliesTo("src/components/ui/button.tsx"),
    false,
    "should not scan the vendored primitives",
  );
  assert.match(scopePinFailure(check, 499), /SCOPE PIN FAILED/);
  assert.equal(scopePinFailure(check, 702), null);
});

test("context-menu-suppression flags the state-reset-then-preventDefault shape", () => {
  const inline = [
    "function handleContextMenu(e) {",
    "  const row = e.target.closest('[data-repo-path]');",
    "  if (!row) {",
    "    setMenuRepo(null);",
    "    e.preventDefault();",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(menuSuppression(inline), [4]);
  // stopPropagation written out by hand is the same class: the constraint lives
  // in the helper's doc comment, so an inline copy is what drifts next.
  const handRolled = [
    "setMenuTarget(null);",
    "e.stopPropagation();",
    "e.preventDefault();",
  ].join("\n");
  assert.deepEqual(menuSuppression(handRolled), [1]);
});

test("context-menu-suppression leaves the helper route and its definition alone", () => {
  const fixed = [
    "setMenuPath(null);",
    "suppressContextMenu(e);",
    "return;",
  ].join("\n");
  assert.deepEqual(menuSuppression(fixed), []);
  // The helper itself holds the preventDefault with no state reset to pair with.
  const helper = [
    "export function suppressContextMenu(e) {",
    "  e.stopPropagation();",
    "  e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(menuSuppression(helper), []);
});

test("context-menu-suppression does not pair across a block boundary", () => {
  // `[^}]` is the bound: an unrelated null reset and an unrelated preventDefault
  // in two different handlers are not this idiom.
  const separate = [
    "function clearSelection() {",
    "  setMenuRepo(null);",
    "}",
    "function onKeyDown(e) {",
    "  e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(menuSuppression(separate), []);
});

test("seed-effect-on-open flags both spellings of the open guard", () => {
  const guarded = [
    "useEffect(() => {\n  if (open) seedOnOpen();\n}, [open]);",
    "useEffect(() => {\n  if (!open) return;\n  setTyped('');\n}, [open]);",
    "useEffect(() => {\n  if (open && ready) seed();\n}, [open, ready]);",
    "useLayoutEffect(() => {\n  if (open) setMode(initialMode);\n}, [open]);",
  ];
  for (const source of guarded)
    assert.deepEqual(seedOnOpen(source), [1], `should flag ${source}`);
});

test("seed-effect-on-open ignores the hook and non-first-statement reads", () => {
  assert.deepEqual(seedOnOpen("useSeedOnOpen(open, seedOnOpen);"), []);
  // `open` read somewhere in the body is a gate, not a seed — only an effect
  // that OPENS with the guard is the shape this check is about.
  const gate = [
    "useEffect(() => {",
    "  const el = ref.current;",
    "  if (!open || !el) return;",
    "  place(el);",
    "}, [open]);",
  ].join("\n");
  assert.deepEqual(seedOnOpen(gate), []);
});

test("generator-dialog-finish-and-surface flags each generator hook", () => {
  for (const hook of [
    "useGeneratePrDescription",
    "useGenerateIssueDraft",
    "useGenerateReleaseNotes",
    "useGenerateRepoDescription",
  ]) {
    const source = [
      `  const { generate, generating } = ${hook}(repoPath);`,
      "  const seedOnOpen = useEffectEvent(() => form.reset(seeds));",
      "  useSeedOnOpen(open, seedOnOpen);",
    ].join("\n");
    assert.deepEqual(finishAndSurface(source), [1], `should flag ${hook}`);
  }
});

test("generator-dialog-finish-and-surface needs both halves, and clears on the primitive", () => {
  // The adopted shape — the negative control for the check.
  const adopted = [
    "  const { generate, cancel, generating } = useGeneratePrDescription(repo);",
    "  const surface = useFinishAndSurface(repo, open, {",
    "    cancel,",
    "    generating,",
    "    readyTitle: t,",
    "  });",
    "  useSeedOnOpen(open, seedOnOpen);",
  ].join("\n");
  assert.deepEqual(finishAndSurface(adopted), []);
  // Each half alone is ordinary: a generator on a surface with no open-transition
  // seed (the edit dialogs), and a seeded dialog with no generator at all.
  assert.deepEqual(
    finishAndSurface(
      "  const { generate } = useGeneratePrDescription(repoPath);",
    ),
    [],
  );
  assert.deepEqual(finishAndSurface("  useSeedOnOpen(open, seedOnOpen);"), []);
  // A generator named in a comment is not a call site.
  const documented = [
    "  // useGeneratePrDescription() streams into this dialog's form.",
    "  useSeedOnOpen(open, seedOnOpen);",
  ].join("\n");
  assert.deepEqual(finishAndSurface(documented), []);
});

test("generator-dialog-finish-and-surface applies to .tsx call sites only", () => {
  // The .ts bound is what keeps each hook's own definition file — whose export
  // line matches the call pattern — from reading as a violation.
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "generator-dialog-finish-and-surface",
  );
  assert.equal(
    appliesTo("src/features/pulls/useGeneratePrDescription.ts"),
    false,
  );
  assert.equal(appliesTo("src/components/ui/dialog.tsx"), false);
  assert.equal(appliesTo("src/features/pulls/CreatePrDialog.tsx"), true);
});

const generateHeldWhileSubmitting = scanner("generate-held-while-submitting");

test("generate-held-while-submitting flags a form host's chord that ignores the submit", () => {
  const unheld = [
    "  const form = useAppForm({ onSubmit: async () => create() });",
    "  const generateChord = useGenerateChord({",
    "    enabled: aiEnabled && !generating,",
    "    run: runGenerate,",
    "  });",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(unheld), [2]);
  // The flag has to hold the chord, not merely appear in its options.
  const wrongPolarity = [
    "  const form = useAppForm({ onSubmit: async () => create() });",
    "  const generateChord = useGenerateChord({",
    "    enabled: isSubmitting || ready,",
    "    run: runGenerate,",
    "  });",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(wrongPolarity), [2]);
  // A withForm-rendered dialog hosts a form too.
  const withFormHost = [
    "export const Dialog = withForm({",
    "  render: function Render({ form }) {",
    "    const generateChord = useGenerateChord({ enabled: true, run });",
    "  },",
    "});",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(withFormHost), [3]);
});

test("generate-held-while-submitting reads only an && conjunct of the chord's enabled", () => {
  const host = (...chord) =>
    [
      "  const form = useAppForm({ onSubmit: async () => create() });",
      "  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);",
      ...chord,
    ].join("\n");
  // Each spelling mentions the negated flag without holding the chord on it.
  const unheld = {
    "a hold placed in run": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready,",
      "    run: () => { if (!isSubmitting) go(); },",
      "  });",
    ],
    "an || alternative": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready || !isSubmitting,",
      "    run,",
      "  });",
    ],
    "a parenthesized || inside an && chain": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready && (x || !isSubmitting),",
      "    run,",
      "  });",
    ],
    "the flag as a run argument": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready,",
      "    run: () => go(!isSubmitting),",
      "  });",
    ],
    "a shorthand enabled": [
      "  const enabled = ready && !isSubmitting;",
      "  const generateChord = useGenerateChord({ enabled, run });",
    ],
    "a ternary": [
      "  const generateChord = useGenerateChord({",
      "    enabled: busy ? false : !isSubmitting,",
      "    run,",
      "  });",
    ],
    "a ?? fallback": [
      "  const generateChord = useGenerateChord({",
      "    enabled: override ?? !isSubmitting,",
      "    run,",
      "  });",
    ],
    "a missing enabled": [
      "  const generateChord = useGenerateChord({ run: () => go(!isSubmitting) });",
    ],
    "a spread that can override enabled": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready && !isSubmitting,",
      "    ...opts,",
      "  });",
    ],
    "a duplicated enabled": [
      "  const generateChord = useGenerateChord({",
      "    enabled: ready && !isSubmitting,",
      "    enabled: ready,",
      "  });",
    ],
    "a non-literal options argument": [
      "  const generateChord = useGenerateChord(chordOptions(!isSubmitting));",
    ],
  };
  for (const [label, chord] of Object.entries(unheld)) {
    const callLine =
      3 + chord.findIndex((line) => line.includes("useGenerateChord("));
    assert.deepEqual(
      generateHeldWhileSubmitting(host(...chord)),
      [callLine],
      label,
    );
  }
  const held = {
    "the multiline house form": [
      "  const generateChord = useGenerateChord({",
      "    enabled:",
      '      aiEnabled && !generating && notes.trim() !== "" && !isSubmitting,',
      "    run: runGenerate,",
      "  });",
    ],
    "a negated || group as another conjunct": [
      "  const generateChord = useGenerateChord({",
      "    enabled:",
      "      !generating && !(sameBranch || ahead.length === 0) && !isSubmitting,",
      "    run: aiEnabled ? runGenerate : undefined,",
      "  });",
    ],
    "a member named enabled as another conjunct": [
      "  const generateChord = useGenerateChord({",
      "    enabled: generateAction.enabled && !isSubmitting,",
      "    run: generateAction.run,",
      "  });",
    ],
    "redundant parens and optional chaining": [
      "  const generateChord = useGenerateChord({",
      "    enabled: (draft?.ready && (!isSubmitting)),",
      "    run,",
      "  });",
    ],
  };
  for (const [label, chord] of Object.entries(held)) {
    assert.deepEqual(generateHeldWhileSubmitting(host(...chord)), [], label);
  }
});

test("generate-held-while-submitting accepts a held chord and ignores form-less surfaces", () => {
  const held = [
    "  const form = useAppForm({ onSubmit: async () => create() });",
    "  const isSubmitting = useSelector(form.store, (s) => s.isSubmitting);",
    "  const generateChord = useGenerateChord({",
    "    enabled:",
    '      aiEnabled && !generating && notes.trim() !== "" && !isSubmitting,',
    "    run: runGenerate,",
    "  });",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(held), []);
  // No form, no submit to wait on: the settings shell and the script dialog.
  assert.deepEqual(
    generateHeldWhileSubmitting(
      "  const generateChord = useGenerateChord({ enabled: true, run });",
    ),
    [],
  );
  // Comments name neither a form nor a chord.
  const documented = [
    "  // useAppForm({ onSubmit }) and useGenerateChord({ enabled }) live elsewhere.",
    "  const generateChord = useGenerateChord({ enabled: true, run });",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(documented), []);
  const chordInComment = [
    "  const form = useAppForm({ onSubmit: async () => create() });",
    "  // useGenerateChord({ enabled: ready }) is wired by the host.",
  ].join("\n");
  assert.deepEqual(generateHeldWhileSubmitting(chordInComment), []);
});

test("generate-held-while-submitting applies to .tsx outside the vendored primitives", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "generate-held-while-submitting",
  );
  // The hook's own definition is a .ts module.
  assert.equal(appliesTo("src/lib/hotkeys/useGenerateChord.ts"), false);
  assert.equal(appliesTo("src/components/ui/dialog.tsx"), false);
  assert.equal(appliesTo("src/features/pulls/CreatePrDialog.tsx"), true);
});

test("generate-held-while-submitting sees every real form-hosted chord", () => {
  // A rename of the chord hook, the form hooks, or the flag would leave the
  // check scanning nothing and printing OK; the floor is the ten create and
  // rewrite dialogs whose chords the extractor reads as held.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "generate-held-while-submitting",
  );
  const hosts = readdirSync(join(root, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).split("\\").join("/")}`)
    .filter(appliesTo)
    .filter((file) => {
      const { text } = view(readFileSync(join(root, file), "utf8"));
      const calls = generateChordCalls(text);
      return (
        /\b(?:useAppForm|withForm)\s*\(/.test(text) &&
        calls.length > 0 &&
        calls.every((call) => call.held)
      );
    });
  assert.ok(
    hosts.length >= 10,
    `expected at least 10 form-hosted chords held on submit, saw ${hosts.length}`,
  );
});

test("lone-activity-boundary flags a JSX Activity in either spelling", () => {
  assert.deepEqual(
    loneActivity('<Activity mode="hidden">{kids}</Activity>'),
    [1],
  );
  assert.deepEqual(loneActivity("<Activity>{kids}</Activity>"), [1]);
});

test("lone-activity-boundary ignores same-prefixed components and prose", () => {
  for (const tag of [
    "<ActivityDock />",
    "<ActivityBell />",
    "<ActivityStrip/>",
  ])
    assert.deepEqual(loneActivity(tag), [], `should ignore ${tag}`);
  // The many comments naming <Activity> are what comment stripping keeps clean.
  assert.deepEqual(
    loneActivity("// a hidden <Activity> subtree still fetches"),
    [],
  );
});

test("hand-rolled-diff-stat flags both minus glyphs and a wrapped class list", () => {
  const ascii = [
    '<span className="shrink-0 tabular-nums">',
    '  <span className="text-success">+{file.added}</span>{" "}',
    '  <span className="text-destructive">-{file.deleted}</span>',
    "</span>",
  ].join("\n");
  assert.deepEqual(diffStatPair(ascii), [2]);
  // The Insights spelling: U+2212, and counts routed through a formatter.
  const unicode = [
    '<span className="text-success">+{fmt(c.additions)}</span>{" "}',
    '<span className="text-destructive">−{fmt(c.deletions)}</span>',
  ].join("\n");
  assert.deepEqual(diffStatPair(unicode), [1]);
  // A cn()-wrapped class list, each count on its own wrapped line.
  const wrapped = [
    '<span className={cn("text-success", PLACEHOLDER_FADE, staleDim)}>',
    "  +{totalAdded}",
    "</span>",
    '<span className={cn("text-destructive", PLACEHOLDER_FADE, staleDim)}>',
    "  -{totalDeleted}",
    "</span>",
  ].join("\n");
  assert.deepEqual(diffStatPair(wrapped), [1]);
  // The boundary the 200-char class run exists for: a cn() list carrying
  // conditional utilities puts 95 chars between the class name and its `>`.
  const longList = [
    '<span className={cn("text-success", PLACEHOLDER_FADE, staleDim,',
    '  isActive && "font-medium", compact ? "text-[10px]" : "text-xs")}>',
    "  +{a}",
    "</span>",
    '<span className={cn("text-destructive", PLACEHOLDER_FADE, staleDim,',
    '  isActive && "font-medium", compact ? "text-[10px]" : "text-xs")}>',
    "  -{d}",
    "</span>",
  ].join("\n");
  assert.deepEqual(diffStatPair(longList), [1]);
});

test("hand-rolled-diff-stat leaves the component route and lone tokens alone", () => {
  assert.deepEqual(
    diffStatPair("<DiffStat added={file.added} deleted={file.deleted} />"),
    [],
  );
  // A success/destructive pair with no counts between them — the ordinary use.
  const statuses = [
    '<span className="text-success">Passing</span>',
    '<span className="text-destructive">{failed} failed</span>',
  ].join("\n");
  assert.deepEqual(diffStatPair(statuses), []);
  // Half the idiom is not the idiom.
  assert.deepEqual(
    diffStatPair('<span className="text-success">+{added}</span>'),
    [],
  );
});

test("hand-rolled-diff-stat exempts the component file and vendored ui only", () => {
  const { appliesTo } = CHECKS.find((c) => c.name === "hand-rolled-diff-stat");
  assert.equal(appliesTo("src/components/diff-stat.tsx"), false);
  assert.equal(appliesTo("src/components/ui/badge.tsx"), false);
  assert.equal(appliesTo("src/features/repository/FileRow.tsx"), true);
});

test("list-row-diff-stat-slot flags a counts cell gated on its own stat", () => {
  // The FileRow / CommitDialog shape the slot replaced, wrapped as formatted.
  const fileRow = [
    "      {nameCell}",
    "      {stat ? (",
    "        <DiffStat",
    "          added={stat.added}",
    "          deleted={stat.deleted}",
    "          isBinary={stat.isBinary}",
    '          className="text-[11px]"',
    "        />",
    "      ) : null}",
  ].join("\n");
  assert.deepEqual(diffStatSlot(fileRow), [2]);
  const andForm = [
    "{file.stats && (",
    "  <DiffStat added={file.stats.added} deleted={file.stats.deleted} />",
    ")}",
  ].join("\n");
  assert.deepEqual(diffStatSlot(andForm), [1]);
  assert.deepEqual(
    diffStatSlot(
      "{stat ? <DiffStat added={stat.added} deleted={stat.deleted} /> : null}",
    ),
    [1],
  );
});

test("list-row-diff-stat-slot flags a total on its own flag; the allowlist exempts RemotePrView", () => {
  // The shape is flagged whatever the condition: RemotePrView's header total,
  // hidden while totals are unknown, is exempt by its allowlist entry only.
  const total = [
    "{!totalsUnknown && (",
    "  <DiffStat added={pr.additions} deleted={pr.deletions} />",
    ")}",
  ].join("\n");
  assert.deepEqual(diffStatSlot(total), [1]);
  const check = CHECKS.find((c) => c.name === "list-row-diff-stat-slot");
  const file = "src/features/pulls/RemotePrView.tsx";
  const { violations, stale } = runCheck(
    check,
    [file],
    new Map([[file, view(total)]]),
  );
  assert.deepEqual(violations, []);
  assert.deepEqual(stale, []);
  // The entry covers exactly one real site.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(
    check.scan(view(readFileSync(join(root, file), "utf8")), file).length,
    1,
  );
});

test("list-row-diff-stat-slot flags the condition by shape, not by spelling", () => {
  assert.deepEqual(
    diffStatSlot("{ok ? <DiffStat added={stat.added} deleted={0} /> : null}"),
    [1],
  );
  assert.deepEqual(diffStatSlot("{stat && <DiffStat {...stat} />}"), [1]);
  assert.deepEqual(
    diffStatSlot(
      "{stat ? <DiffStat added={stat.added} deleted={stat.deleted} /> : null}",
    ),
    [1],
  );
  assert.deepEqual(
    diffStatSlot(
      "{stat != null && <DiffStat added={stat.added} deleted={stat.deleted} />}",
    ),
    [1],
  );
  assert.deepEqual(
    diffStatSlot(
      "{x?.stat && <DiffStat added={x.stat.added} deleted={x.stat.deleted} />}",
    ),
    [1],
  );
  assert.deepEqual(
    diffStatSlot("{map.get(path) && <DiffStat added={1} deleted={2} />}"),
    [1],
  );
  // The else branch and the `||` / `??` operands are the same shape.
  assert.deepEqual(
    diffStatSlot("{busy ? null : <DiffStat added={1} deleted={2} />}"),
    [1],
  );
  assert.deepEqual(
    diffStatSlot("{fallback ?? <DiffStat added={1} deleted={2} />}"),
    [1],
  );
});

test("list-row-diff-stat-slot leaves unconditional cells, the slot, and text alone", () => {
  assert.deepEqual(
    diffStatSlot("<DiffStat added={file.added} deleted={file.deleted} />"),
    [],
  );
  assert.deepEqual(
    diffStatSlot('<DiffStatSlot stat={stat} className="text-[11px]" />'),
    [],
  );
  assert.deepEqual(
    diffStatSlot("{stat ? <DiffStatSlot stat={stat} /> : null}"),
    [],
  );
  // Masked text: a comment or string can't trigger a hit.
  assert.deepEqual(
    diffStatSlot(
      "// {stat && <DiffStat added={1} deleted={2} />}\nconst a = 1;",
    ),
    [],
  );
  assert.deepEqual(
    diffStatSlot("{/* stat ? <DiffStat added={1} deleted={2} /> : null */}"),
    [],
  );
  assert.deepEqual(
    diffStatSlot('const s = "x && <DiffStat added={1} />";'),
    [],
  );
});

test("list-row-diff-stat-slot scans feature tsx files only", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "list-row-diff-stat-slot",
  );
  assert.equal(appliesTo("src/features/x/A.tsx"), true);
  assert.equal(appliesTo("src/components/diff-stat.tsx"), false);
  assert.equal(appliesTo("src/features/x/a.ts"), false);
});

test("kind-badge-single-source flags a re-declared table, exported or not", () => {
  // The two duplicates' own shape: a typed Record the formatter splits after
  // the `=`, so only the keyword-plus-name line has to match.
  const local = [
    "const KIND_BADGE: Record<",
    "  ChangeKind,",
    "  { letter: string; label: string; className: string }",
    "> = {",
    '  added: { letter: "A", label: "Added", className: "text-success" },',
    "};",
  ].join("\n");
  assert.deepEqual(kindBadge(local), [1]);
  assert.deepEqual(
    kindBadge('export const KIND_BADGE = { added: { letter: "A" } };'),
    [1],
  );
});

test("kind-badge-single-source leaves imports and reads of the shared table alone", () => {
  for (const source of [
    'import { KIND_BADGE } from "@/lib/git/change-kind-badge";',
    "const badge = KIND_BADGE[kind];",
    // A differently-named table is outside this check's shape by design.
    "const KIND_GLYPH = { added: PlusIcon };",
    // The comment naming the banned shape is what comment stripping keeps clean.
    "// a second `const KIND_BADGE` drifts from the shared table",
  ])
    assert.deepEqual(kindBadge(source), [], `should ignore ${source}`);
});

test("kind-badge-single-source exempts the shared module only", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "kind-badge-single-source",
  );
  assert.equal(appliesTo("src/lib/git/change-kind-badge.ts"), false);
  assert.equal(appliesTo("src/features/repository/FileRow.tsx"), true);
  assert.equal(appliesTo("src/features/commit/CommitDialog.tsx"), true);
});

test("binary-marker-single-source flags a re-spelled marker check", () => {
  // Fixtures stay in this file: a shell argument would collapse the `\\n`.
  for (const source of [
    'isBinary: section.includes("Binary files "),',
    'isBinary: section.includes("Binary files"),',
    'isBinary: part.includes("\\nBinary files "),',
    "isBinary: section.includes('Binary files '),",
    "isBinary: section.includes(`\\nBinary files `),",
    "const binary = /Binary files /.test(s);",
    "const binary = /^Binary files /m.test(s);",
    "const binary = /\\nBinary files /.test(s);",
  ])
    assert.deepEqual(binaryMarker(source), [1], `should flag ${source}`);
  // Wrapped by the formatter: the literal still sits whole on its own line.
  assert.deepEqual(
    binaryMarker(
      [
        "isBinary: (fileSections.get(effectivePath) ?? '').includes(",
        '  "Binary files ",',
        "),",
      ].join("\n"),
    ),
    [2],
  );
});

test("binary-marker-single-source reads other newline spellings, cases and regex leads", () => {
  for (const source of [
    // String arm: any run of newline escapes, RegExp() strings, either case.
    's.includes("\\r\\nBinary files ")',
    's.includes("\\n\\nBinary files ")',
    's.includes("\\x0aBinary files ")',
    's.includes("\\u000aBinary files ")',
    's.includes("\\u{a}Binary files ")',
    's.toLowerCase().includes("\\nbinary files ")',
    'new RegExp("^Binary files ", "m")',
    'new RegExp("\\\\nBinary files ")',
    // Template arm: the marker after a real newline inside a template.
    "  Binary files `)",
    // Regex arm: newline tokens, a class, the house lookbehinds, ` ?`, a case flag.
    "/^\\nBinary files/.test(s)",
    "/[\\n]Binary files /.test(s)",
    "/\\x0aBinary files /.test(s)",
    "/(?<![^\\n])Binary files /.test(s)",
    "/(?<=\\n)Binary files /.test(s)",
    "/Binary files ?/.test(s)",
    "/binary files /i.test(s)",
    // Fails closed by design: a quoted mention inside prose.
    "'rows saying \"Binary files\" read bin'",
  ])
    assert.deepEqual(binaryMarker(source), [1], `should flag ${source}`);
});

test("binary-marker-single-source near misses stop at the arm they target", () => {
  for (const source of [
    // Template arm: opens on the words, but text, not a backtick, follows.
    "  Binary files read \\`bin\\` in the list",
    // String arm: quote and words match, but text, not the quote, follows.
    's.includes("Binary files differ")',
    // Regex arm: lead and words match, but pattern, not the slash, follows.
    "/^Binary files .* differ$/m.test(s)",
    // The singular is UI copy, so no arm reads it.
    'const label = "Binary file";',
    's.includes("\\nBinary file")',
  ])
    assert.deepEqual(binaryMarker(source), [], `should ignore ${source}`);
});

test("binary-marker-single-source leaves prose and the helper call alone", () => {
  for (const source of [
    // The live prose negatives: the words sit mid-string.
    '"repo-relative. Binary files are rejected.",',
    "its Staged row and what's still outside it on its Changes row. Binary files read",
    'const label = "Binary files read `bin`";',
    'import { sectionIsBinary } from "@/lib/git/diff-split";',
    "isBinary: sectionIsBinary(section),",
    // Comment stripping keeps a documented spelling clean.
    '// the loose `includes("Binary files ")` matched hunk content',
  ])
    assert.deepEqual(binaryMarker(source), [], `should ignore ${source}`);
});

test("binary-marker-single-source exempts the helper module only", () => {
  const { appliesTo, allowlist } = CHECKS.find(
    (c) => c.name === "binary-marker-single-source",
  );
  assert.equal(appliesTo("src/lib/git/diff-split.ts"), false);
  assert.equal(appliesTo("src/features/pulls/RemotePrView.tsx"), true);
  assert.equal(appliesTo("src/features/pulls/PrCommitDetail.tsx"), true);
  assert.equal(appliesTo("src/lib/ai/prompt.ts"), true);
  assert.deepEqual(allowlist, ["src/lib/ai/prompt.ts"]);
});

test("null-suspense-fallback flags the literal on one line or wrapped", () => {
  assert.deepEqual(
    nullFallback("<Suspense fallback={null}>{kids}</Suspense>"),
    [1],
  );
  // The formatter's shape: the prop on its own line, with inner spacing.
  const wrapped = [
    "<Suspense",
    "  fallback={ null }",
    ">",
    "  <InsightsBoard />",
    "</Suspense>",
  ].join("\n");
  assert.deepEqual(nullFallback(wrapped), [2]);
});

test("null-suspense-fallback leaves a real fallback and a forwarded prop alone", () => {
  for (const source of [
    '<Suspense fallback={<LazyPanelFallback name="Insights" />}>{kids}</Suspense>',
    // A fallback naming a binding, not a literal — outside the check's shape.
    "<Suspense fallback={fallback}>{kids}</Suspense>",
    "<Suspense fallback={compact ? null : <Skeleton />}>{kids}</Suspense>",
  ])
    assert.deepEqual(nullFallback(source), [], `should ignore ${source}`);
});

/** Every hide utility preparing-slot-hide bans: visibility, each opacity
 *  below full, display, `sr-only`'s 1px box, and descendant variants of them. */
const SLOT_HIDE_UTILITIES = [
  "invisible",
  "collapse",
  "[visibility:hidden]",
  "[visibility:collapse]",
  "[visibility:hidden_!important]",
  "opacity-0",
  "opacity-5",
  "opacity-50",
  "opacity-80",
  "opacity-[0]",
  "opacity-[.0]",
  "opacity-[0.0]",
  "opacity-[0.5]",
  "opacity-[0%]",
  "opacity-[50%]",
  "opacity-[0_!important]",
  "[opacity:0]",
  "[opacity:0.5]",
  "[opacity:50%]",
  // An opacity the scan cannot read fails closed.
  "opacity-[var(--x)]",
  "[opacity:calc(1-var(--y))]",
  "hidden",
  "[display:none]",
  "[display:none!important]",
  "[content-visibility:hidden]",
  // A value the scan cannot read: Tailwind v4's variable shorthand, and a
  // visibility or display value that is not a plain keyword.
  "opacity-(--slot-o)",
  "[visibility:var(--v)]",
  "[display:var(--d)]",
  "sr-only",
  // Descendant variants hide the slot's content the same way: intended.
  "[&_svg]:invisible",
  "*:hidden",
  "**:opacity-0",
];
/** Tokens a preparing entry may carry: none of them hides. */
const SLOT_NEVER_HIDES = [
  "visible",
  "md:visible",
  "overflow-hidden",
  "aria-hidden:flex",
  "data-[hidden]:block",
  "hidden-x",
  "collapse-x",
  "not-sr-only",
  "bg-black/0",
  "text-white/50",
  "group-hover:opacity-100",
  "opacity-100",
  "opacity-[1]",
  "[opacity:1]",
  "opacity-[100%]",
  "[visibility:visible]",
  "[display:flex]",
];
const slotHideSpellings = (utility) => [
  utility,
  `md:${utility}`,
  `data-[x]:${utility}`,
  `!${utility}`,
  `${utility}!`,
  `md:!${utility}`,
];
const slotRecord = (value) =>
  `const SLOT_CLASS: Record<Role, string> = { shown: "h-full", held: "h-full", preparing: ${value} };`;
/** A one-line slot-host prelude: the vocabulary puts what follows in slot
 *  context, and its clipped entry keeps the host check satisfied. */
const SLOT_HOST =
  'import type { SlotPhase } from "@/features/diff/diff-pane-slots"; const SLOT: Record<SlotPhase, string> = { shown: "h-full", held: "h-full", preparing: "absolute inset-0 [clip-path:inset(50%)]" };';
const inHost = (source) => `${SLOT_HOST}\n${source}`;
const assertSlotFlags = (sources, lines = [1]) => {
  for (const source of sources)
    assert.deepEqual(preparingSlotHide(source), lines, source);
};
const assertSlotPasses = (sources) => {
  for (const source of sources)
    assert.deepEqual(preparingSlotHide(source), [], source);
};
/** Each source after the host prelude: flagged on its own first line. */
const assertHostFlags = (sources, lines = [2]) =>
  assertSlotFlags(sources.map(inHost), lines);
const assertHostPasses = (sources) => assertSlotPasses(sources.map(inHost));

test("preparing-slot-hide flags every hide utility in a preparing entry", () => {
  for (const utility of SLOT_HIDE_UTILITIES)
    assertSlotFlags(
      slotHideSpellings(utility).map((cls) =>
        slotRecord(`"absolute inset-0 ${cls}"`),
      ),
    );
  // Every token that only looks like a hide passes, in one entry each.
  assertSlotPasses(
    SLOT_NEVER_HIDES.map((cls) => slotRecord(`"absolute inset-0 ${cls}"`)),
  );
});

test("preparing-slot-hide reads every preparing key form", () => {
  assertSlotFlags([
    'const C = { shown: "", preparing: "absolute invisible" };',
    'const C = { shown: "", "preparing": "absolute invisible" };',
    "const C = { shown: '', 'preparing': 'absolute invisible' };",
    'const C = { shown: "", ["preparing"]: "absolute invisible" };',
    "const C = { shown: '', ['preparing']: 'absolute invisible' };",
    'const C = { shown: "", [`preparing`]: "absolute invisible" };',
    'const C = { shown: "", ["preparing" as const]: "absolute invisible" };',
    'const C = { shown: "", preparing() { return "absolute invisible"; } };',
    'const C = { shown: "", get preparing() { return "absolute invisible"; } };',
  ]);
});

test("preparing-slot-hide reads a preparing entry's whole class expression", () => {
  assertSlotFlags([
    slotRecord('cn("absolute inset-0", x && "opacity-0")'),
    slotRecord('cn("absolute inset-0", { invisible: live })'),
    slotRecord('"absolute " + "invisible"'),
    slotRecord('["absolute", "invisible"]'),
    slotRecord("`absolute ${x} invisible`"),
    slotRecord('`absolute ${x ? `invisible` : ""}`'),
    slotRecord('live ? "absolute" : "absolute invisible"'),
    slotRecord('clsx("absolute", live ? "" : twMerge("hidden"))'),
    // `||` and `??` yield their left operand: its classes apply.
    'const C = { shown: "h-full", preparing: cn((compact ? "invisible" : "") || "absolute [clip-path:inset(50%)]") };',
    'const C = { shown: "h-full", preparing: cn((compact ? "invisible" : null) ?? "absolute") };',
  ]);
  // An unreadable left operand of `||` or `??` fails as unreadable.
  assertSlotFlags([
    'function f(base) { return { shown: "h-full", preparing: cn(base || "absolute [clip-path:inset(50%)]") }; }',
    'function f(extra) { return { shown: "h-full", preparing: cn(extra ?? "absolute") }; }',
  ]);
  // A flag-named read in a value position is a value: a member read is
  // unreadable, and an alias is read through its initializer.
  assertSlotFlags([
    'function f(classes) { return { shown: "h-full", preparing: cn(classes.preparing || "absolute [clip-path:inset(50%)]") }; }',
  ]);
  assertSlotFlags(
    [
      'const hideCls = role === "preparing" && "invisible";\nconst C = { shown: "h-full", preparing: cn(hideCls || "absolute [clip-path:inset(50%)]") };',
    ],
    [2],
  );
  // A boolean left operand contributes no class.
  assertSlotPasses([
    'const C = { shown: "h-full", preparing: cn(live === false || "absolute [clip-path:inset(50%)]") };',
  ]);
  // The formatter's multi-line map, reported on the key's line.
  const wrapped = [
    "const SLOT_FRAME_CLASS: Record<Role, string> = {",
    '  shown: "h-full",',
    '  held: "h-full",',
    "  // Stacked over the held slot at full size.",
    "  preparing: cn(",
    '    "absolute inset-0",',
    '    "invisible",',
    "  ),",
    "};",
  ].join("\n");
  assertSlotFlags([wrapped], [5]);
});

test("preparing-slot-hide flags a class arm guarded by the preparing role", () => {
  assertHostFlags(
    [
      'role === "preparing" && "invisible"',
      'role == "preparing" && "invisible"',
      'role === "preparing" ? "absolute invisible" : "h-full"',
      'role == "preparing" ? "invisible" : ""',
      '"preparing" === role && "invisible"',
      '"preparing" == slot.role ? "invisible" : ""',
      "role === 'preparing' && 'invisible'",
      "'preparing' === role ? 'invisible' : ''",
      '(role === "preparing") && "invisible"',
      '("preparing" === role) ? "invisible" : ""',
      'role === "preparing" && `absolute ${x} invisible`',
      'preparing && "invisible"',
      'preparing ? "absolute invisible" : "h-full"',
      'isPreparing && "invisible"',
      'isPreparing ? "invisible" : ""',
      '(isPreparing) && "invisible"',
      // && chains after the guard.
      'role === "preparing" && live && "invisible"',
      'isPreparing && !reduced && "opacity-0"',
      // Disjunctions.
      '(role === "preparing" || role === "held") && "invisible"',
      'role === "preparing" || role === "held" ? "invisible" : ""',
      'role !== "preparing" || "invisible"',
      // Elimination over the other roles.
      'phase !== "shown" && "invisible"',
      'role !== "shown" && role !== "held" && "invisible"',
      'role === "shown" ? "h-full" : role === "held" ? "h-full" : "absolute inset-0 invisible"',
      // A negated guard's alternate.
      'role !== "preparing" ? "h-full" : "absolute invisible"',
      '!isPreparing ? "" : "invisible"',
      // Mixed negation, double negation, flag comparisons and members.
      '!(live && role === "preparing") && "invisible"',
      '!!isPreparing && "invisible"',
      'isPreparing === true && "invisible"',
      'isPreparing !== false && "invisible"',
      '!(isPreparing === false) && "invisible"',
      'slot.isPreparing && "invisible"',
      'props.preparing && "invisible"',
      // Element-access flags.
      'slot["isPreparing"] && "invisible"',
      "slot['preparing'] && 'invisible'",
      "slot[`isPreparing`] && 'invisible'",
      // Any operand against the literal.
      '"preparing" === roles[i] && "invisible"',
      '"preparing" === roleOf(slot) && "invisible"',
      'role===("preparing") && "invisible"',
      'slot?.role === "preparing" && "invisible"',
      // Compound consequents.
      'role === "preparing" ? cn("absolute", "invisible") : "h-full"',
      'role === "preparing" && ("absolute invisible")',
      'isPreparing && ["absolute", "invisible"]',
      // A template literal role.
      'role === `preparing` && "invisible"',
    ].map((expr) => `const c = cn("h-full", ${expr});`),
  );
  assertHostFlags([
    // A bare guard outside any class call is a site when its arm is class code.
    'const c = role === "preparing" ? "absolute invisible" : "h-full";',
    // JSX arms.
    'const x = <>{role === "preparing" ? <div className="absolute invisible" /> : <div />}</>;',
    // clsx objects: the key's classes apply when the value is true.
    'const c = cn("h-full", { invisible: role === "preparing" });',
    'const c = cn("h-full", { "absolute invisible": isPreparing });',
    // A className position needs no literal arm.
    "const x = <div className={isPreparing ? hideClass : undefined} />;",
  ]);
  // An alias: a const holding a role condition is that condition.
  assertHostFlags(
    [
      'const hiding = role === "preparing";\nconst C = cn("h-full", hiding && "invisible");',
    ],
    [3],
  );
  assertHostPasses([
    'const isShown = role === "shown";\nconst C = cn("h-full", isShown && "invisible");',
    // A repeated reference to one alias is no cycle.
    'const shown = role === "shown";\nconst C = cn(((shown && compact) || (shown && wide)) && "invisible");',
    // A true alias cycle terminates, as an unknown condition.
    'const a = b; const b = a; const C = cn("h-full", a && "invisible");',
  ]);
  // A role condition handed to a class helper the scan cannot read.
  assertHostFlags(
    [
      'const slotClass = (p) => (p ? "absolute invisible" : "h-full");\nconst E = () => <div className={slotClass(role === "preparing")} />;',
    ],
    [3],
  );
  // The role condition may sit anywhere in the helper's arguments.
  assertHostFlags([
    'const E = () => <div className={slotClass({ hide: role === "preparing" })} />;',
  ]);
  // A cycle through an alias still reads the atom beside it.
  assertHostFlags([
    'const a = b || role === "preparing"; const b = a; const C = cn("h-full", a && "invisible");',
  ]);
  // An alias the scan cannot resolve fails closed, whatever its arm holds.
  for (const arm of ['"invisible"', '"absolute"'])
    assertHostFlags(
      [
        `const hiding = role === "preparing";\nfunction g(hiding) { return hiding; }\nconst C = cn("h-full", hiding && ${arm});`,
      ],
      [4],
    );
  // A role argument outside class code is no class helper.
  assertHostPasses(['expirePane(h, "preparing");', 'setRole("preparing");']);
});

test("preparing-slot-hide flags a role branch's literals", () => {
  assertHostFlags([
    'function f(role) { switch (role) { case "preparing": return "absolute invisible"; default: return "h-full"; } }',
    'function f(role) { switch (role) { case "held": case "preparing": return "absolute invisible"; default: return "h-full"; } }',
    'function f(role) { switch (role) { case "held": return "h-full"; default: return "absolute invisible"; } }',
    'function f(role) { if (role === "preparing") return "absolute invisible"; return "h-full"; }',
    'function f(role) { if (role === "shown") { return "h-full"; } else { return "absolute invisible"; } }',
    // Only the last statement can end a clause: a try never does, and a
    // labelled break to a label inside the clause leaves only that block.
    'switch (role) { case "preparing": try { note(); } catch { break; } case "shown": return "invisible"; }',
    'switch (role) { case "preparing": inner: { break inner; } case "shown": return "invisible"; }',
    // A clause that does not end falls through into the next one.
    'const f = (role) => { switch (role) { case "preparing": note(); case "shown": return "invisible"; } return "h-full"; };',
    // `switch (true)`: each clause's condition is a role guard.
    'const f = (r) => { switch (true) { case r === "preparing": return "absolute invisible"; default: return "h-full"; } };',
    'switch (true) { case r === "shown": return "h-full"; default: return "absolute invisible"; }',
  ]);
  // Branches whose literals apply to other roles only.
  assertHostPasses([
    'function f(role) { switch (role) { case "preparing": return "absolute"; default: return "invisible"; } }',
    'function f(role) { if (role === "preparing") return "absolute"; else return "invisible"; }',
    // `break` ends the preparing clause, so nothing falls through.
    'const f = (role) => { switch (role) { case "preparing": break; case "shown": return "invisible"; } return "h-full"; };',
    'switch (true) { case r === "held": return "invisible"; default: return "h-full"; }',
    // Every case is tested before `default`, wherever it sits.
    'switch (true) { default: return "invisible"; case role === "preparing": return "absolute"; }',
    // An if/else whose two arms both return ends the clause.
    'switch (role) { case "preparing": if (a) return "x"; else return "y"; case "shown": return "invisible"; }',
  ]);
});

test("preparing-slot-hide flags a class token whose variant names the role", () => {
  assertHostFlags([
    'const x = <div className="h-full data-[role=preparing]:invisible" />;',
    'const c = "h-full data-preparing:hidden";',
    'const c = cn("h-full", "group-data-[slot=preparing]:opacity-0");',
    'const c = "h-full data-[state=Preparing]:invisible";',
  ]);
  // Inside a slot-shaped map, without the vocabulary.
  assertSlotFlags([
    'const C = { shown: "", preparing: "absolute [clip-path:inset(50%)]", note: "data-[role=preparing]:invisible" };',
  ]);
  assertHostPasses(['const c = "h-full data-[role=preparing]:block";']);
});

test("preparing-slot-hide fails class code it cannot read in a preparing slot", () => {
  assertHostFlags([
    'import { SLOT_HIDE } from "./slot"; const C = { preparing: SLOT_HIDE };',
    "const C = { preparing: SLOT_HIDE };",
    'function f(base) { return { preparing: cn(base, "absolute") }; }',
    'const C = { preparing: slotClass("preparing") };',
    'let hide = "absolute"; const C = { preparing: hide };',
    "const C = { preparing: THEME.preparing };",
    'const C = { preparing: cn("absolute", ...extra) };',
    'const c = cn("h-full", isPreparing && hideFor(slot));',
  ]);
  // A same-file const is read through: the hide it holds fails as a hide.
  assertHostFlags([
    'const HIDE = "invisible"; const C = { shown: "", preparing: HIDE };',
    'const BASE = "absolute"; const HIDE = cn(BASE, "opacity-0"); const C = { preparing: HIDE };',
  ]);
  assertHostPasses([
    'const BASE = "absolute"; const C = { preparing: BASE };',
    'const C = { preparing: cn("absolute", live && "z-10", undefined, null, false, "") };',
  ]);
  // Any other binding of the name makes a const unresolvable.
  const clip = 'const HIDE = "absolute [clip-path:inset(50%)]";';
  const entry = 'const C = { shown: "", preparing: HIDE };';
  assertHostFlags(
    [
      'import { HIDE } from "./x";\nfunction g() { const HIDE = "h-full"; return HIDE; }\nconst C = { shown: "h-full", preparing: HIDE };',
    ],
    [4],
  );
  assertHostFlags(
    [
      'import HIDE from "./x";',
      'import * as HIDE from "./x";',
      "const { HIDE } = props;",
      "const [HIDE] = list;",
      "try { run(); } catch (HIDE) {}",
      "function HIDE() {}",
      "class HIDE {}",
      "function f(HIDE) {}",
      "const f = (HIDE) => HIDE;",
      "let HIDE;",
    ].map((other) => `${clip} ${other} ${entry}`),
  );
  // A destructuring key that binds another name leaves the const readable.
  assertHostPasses([`${clip} const { HIDE: other } = props; ${entry}`]);
});

test("preparing-slot-hide fails any other role mention beside a hide", () => {
  assertHostFlags([
    'const c = cn("h-full", ["preparing"].includes(role) && "invisible");',
    'const c = isRole(r, "preparing") && "invisible";',
    'const m = new Map([["preparing", "absolute invisible"]]);',
    'const m = Object.fromEntries([["preparing", "absolute invisible"]]);',
    'const preparing = "absolute invisible"; const C = { shown, held, preparing };',
    // A flag read the guard grammar did not read.
    'const c = Boolean(isPreparing) && "invisible";',
  ]);
});

test("preparing-slot-hide analyses only slot context", () => {
  // Outside a slot-host file and a slot-shaped map, nothing is a site:
  // "preparing" is also a merge status, and `isPreparing` a loading flag.
  assertSlotPasses([
    'import { Loader2Icon, CheckIcon } from "lucide-react";\nconst ICONS = { preparing: Loader2Icon, ready: CheckIcon };',
    "setState({ preparing: isLoading });",
    "const s = { preparing: loading, ready: done };",
    'function B({ merge }) { if (merge.state === "preparing") { return <Badge className="hidden md:inline">Preparing</Badge>; } return null; }',
    'const P = { blocked: "text-destructive", preparing: "opacity-60 animate-pulse", clean: "" };',
    "const X = ({ className }) => <div>{isPreparing && <Loader className={className} />}</div>;",
    // A preparing key beside a held or shown key whose value is no class.
    "setState({ preparing: isLoading, shown: isOpen });",
    // The same const-keyed maps with only the clip.
    'const k = "preparing"; export const C = { shown: "h-full", held: "h-full", [k]: "absolute [clip-path:inset(50%)]" };',
    'const k0 = "preparing"; const k = k0; export const C = { shown: "h-full", held: "h-full", [k]: "absolute [clip-path:inset(50%)]" };',
    'const c = cn("h-full", isPreparing && "opacity-50");',
  ]);
  // A slot shape flags without the vocabulary.
  assertSlotFlags([
    'const C = { shown: "h-full", held: "h-full", preparing: "absolute invisible" };',
    'const C = { preparing: "invisible", shown: "h-full" };',
    '@Comp({ shown: "h-full", held: "h-full", preparing: "absolute invisible" }) class A {}',
    // A preparing key read through same-file consts, one hop or two.
    'const k = "preparing"; export const C = { shown: "h-full", held: "h-full", [k]: "absolute invisible" };',
    'const k0 = "preparing"; const k = k0; export const C = { shown: "h-full", held: "h-full", [k]: "absolute invisible" };',
    // A class body takes the same shape test.
    'class S { shown = "h-full"; preparing = "absolute invisible"; }',
    // A catch clause's pattern default.
    'try { a(); } catch ({ c = { shown: "", preparing: "invisible" } }) {}',
    // Other code the parser keeps: a class's `extends` expression, an enum
    // initializer and a destructuring default.
    'class A extends mixin({ shown: "", preparing: "invisible" }) {}',
    'enum E { A = pick({ shown: "", preparing: "invisible" }) }',
    'const { c = { shown: "", preparing: "invisible" } } = props;',
  ]);
});

test("preparing-slot-hide refuses a file it cannot read", () => {
  // ts-mask's documented ambiguity: postfix `++` then `/` reads as a regex.
  assert.throws(
    () => preparingSlotHide("const z = x++ / 2;"),
    /preparing-slot-hide: cannot lex <input>: unterminated regex literal/,
  );
  // A bracket that never closes is a lex failure, located by line.
  assert.throws(
    () => preparingSlotHide('const a = 1;\nconst x = ("preparing";'),
    /preparing-slot-hide: cannot lex <input>: unclosed `\(` at line 2/,
  );
  // A nesting deep enough to exhaust the stack names the file. The depth is
  // far past any stack budget, so the result never rides V8's frame size; the
  // lexer and bracket matching are iterative, so the cost stays linear.
  const check = CHECKS.find((c) => c.name === "preparing-slot-hide");
  const depth = 50000;
  const parens = `const x = ${"(".repeat(depth)}"preparing"${")".repeat(depth)};`;
  const ternary = `const x = ${'a ? "b" : '.repeat(depth)}"preparing";`;
  for (const deep of [parens, ternary])
    assert.throws(
      () => check.scan(view(deep), "src/features/x/deep.ts"),
      /preparing-slot-hide: cannot read src\/features\/x\/deep\.ts: /,
    );
});

test("preparing-slot-hide passes the hosts' shapes and the pinned non-sites", () => {
  assertSlotPasses([
    // The real hosts' map values.
    slotRecord('"absolute inset-0 [clip-path:inset(50%)]"'),
    // DiffViewer's frame and run-slots' slot.
    [
      'import type { SlotPhase } from "@/features/diff/diff-pane-slots";',
      'const C = { shown: "h-full", held: "h-full", preparing: "absolute inset-0 [clip-path:inset(50%)]" };',
      "export const F = ({ phase }) => (",
      "  <div",
      '    className={cn(SLOT_FRAME_CLASS[phase], PLACEHOLDER_FADE, phase === "held" && "opacity-80 delay-100")}',
      '    inert={phase !== "shown"}',
      "  />",
      ");",
      'export const R = ({ role }) => <HeldFrame holding={role === "held"} inert={role === "preparing"} className={SLOT_CLASS[role]} />;',
    ].join("\n"),
  ]);
  assertHostPasses([
    // Negations that exclude the preparing slot.
    'const c = cn("h-full", !(role === "preparing") && "invisible");',
    'const c = cn("h-full", !(isPreparing) && "hidden");',
    'const c = cn("h-full", !("preparing" === role) && "invisible");',
    'const c = cn("h-full", role !== "preparing" && "invisible");',
    'const c = cn("h-full", !preparing && "invisible");',
    'const c = cn("h-full", role != "preparing" ? "invisible" : "");',
    'const c = cn("h-full", !isPreparing ? "invisible" : "");',
    'const c = cn("h-full", isPreparing === false && "invisible");',
    'const c = cn("h-full", !slot["isPreparing"] && "invisible");',
    // Context propagation: the last arm applies to the shown slot only.
    'const c = role === "preparing" ? "a" : role === "held" ? "b" : "invisible";',
    // Entries keyed by another role narrow what their guards can reach.
    'const C = { held: role === "preparing" && "invisible" };',
    // Intended: a held-keyed sub-map styles the held slot, not the preparing one.
    'const C = { held: { preparing: "absolute invisible" } };',
    // Unknown conditions with no role atom, and a flag as a value.
    'const c = preparing?.x ? "invisible" : "";',
    'const c = preparing ?? "invisible";',
    'const c = ready ? preparing : "invisible";',
    // Type positions.
    'interface SlotMode { preparing: "hidden" | "clipped"; shown: "visible" }',
    'type T = { preparing: "hidden" };',
    'function f(x: { preparing: "hidden" }) {}',
    'const C: { preparing: string } = { preparing: "absolute" };',
    // A label map, a role value, a non-class array and an inert attribute.
    'const LABELS = { preparing: "Preparing merge…", ready: "Ready" };',
    'const slot = { key: hold.target, role: "preparing" };\nconst X = () => <div className="hidden md:flex" />;',
    'const BLOCKING = ["blocked", "preparing", "unknown"] as const;\nconst X = () => <div className="hidden" />;',
    'const X = () => <><div inert={role === "preparing"} /><span className="hidden @md/staging-pane:flex" /></>;',
    // A comment naming every banned utility beside a preparing key.
    [
      "const SLOT_CLASS = {",
      '  shown: "h-full",',
      `  // Never ${SLOT_HIDE_UTILITIES.join(", ")}.`,
      '  preparing: "absolute inset-0 [clip-path:inset(50%)]", /* not "invisible" */',
      "};",
    ].join("\n"),
    // A non-class arm outside any class position.
    'const view = phase === "held" ? slotView : target;',
  ]);
});

test("preparing-slot-hide lexes JSX text with an apostrophe", () => {
  // JSX text is blanked, so its apostrophe ends nothing.
  assertSlotPasses([
    "const L = { preparing: <span>it's loading</span>, held: <span>held</span> };\nexport const X = () => <div className=\"hidden md:flex\" />;",
  ]);
});

test("preparing-slot-hide known gaps stay unread", () => {
  const bs = String.fromCharCode(92);
  const held =
    'const S2 = { shown: "h-full", held: "h-full invisible", preparing: "absolute [clip-path:inset(50%)]" };';
  // Not handled yet; each is pinned at its current result, so a change here
  // is deliberate. In a slot-host file, so slot context is no excuse.
  assertHostPasses([
    // cva compound variants.
    'const v = cva("h-full", { compoundVariants: [{ role: "preparing", class: "invisible" }] });',
    // JSX props named for the role.
    'const X = () => <Slot role="preparing" className="absolute invisible" />;',
    'const X = () => <TwoSlotHost preparing="absolute invisible" />;',
    'const X = () => <TwoSlotHost preparingClassName="absolute invisible" />;',
    // Enum or constant roles in a comparison.
    'const c = cn("h-full", role === SlotRole.Preparing && "invisible");',
    // Control-flow narrowing.
    'function f(role) { if (role !== "preparing") return "h-full"; return "absolute invisible"; }',
    // An `inert:` variant.
    'const c = "absolute inert:invisible";',
    // Style objects.
    'const X = () => <div style={{ visibility: "hidden" }} />;',
    // A flag tested only in a loop condition.
    'while (isPreparing) { el.className = "invisible"; }',
    // A helper's result hoisted out of the class position.
    'const cls = slotClass(role === "preparing");\nconst E = () => <div className={cls} />;',
    // Collapsed-size hides (size-0, h-0/w-0 with an overflow clip, scale-0,
    // max-h-0): common layout idioms, so they stay out of the hide set.
    'const C = { preparing: "absolute size-0 overflow-hidden" };',
    // A render-site arm that replaces the map entry for the preparing slot
    // without a hide; a statement-level branch that renders the slot without
    // a className; an inline clip-path style.
    'const E = ({ r }) => <div className={r === "preparing" ? "absolute inset-0" : SLOT[r]} />;',
    'function f(r) { if (r === "preparing") return <div className="absolute" />; }',
    'function f(r) { if (r === "preparing") return <Skeleton />; return <div className={SLOT[r]} />; }',
    'const E = ({ r }) => <div className={SLOT[r]} style={{ clipPath: "none" }} />;',
    // An identifier-escaped key: the identifier lexer stops at the backslash.
    `const R = { shown: "h-full", ${bs}u0070reparing: "absolute inset-0" };`,
    // A map-entry key the scan cannot pin to one value is taken as the role
    // in force: a parameter (with a default, or not the one the guard tests),
    // a destructured binding, a `let`, an import, a name bound twice, and a
    // member chain of `.name` reads whose root is never resolved.
    `${held} function f(role, prev) { return cn(role === "preparing" && S2[prev]); }`,
    `${held} function g(role, k = "held") { return cn(role === "preparing" && S2[k]); }`,
    `${held} const { k } = { k: "held" }; const c = cn(role === "preparing" && S2[k]);`,
    `${held} let k = "held"; const c = cn(role === "preparing" && S2[k]);`,
    `${held} import { k } from "./keys"; const c = cn(role === "preparing" && S2[k]);`,
    `${held} const k = "held"; function g() { const k = "shown"; return k; } const c = cn(role === "preparing" && S2[k]);`,
    `${held} const x = { role: "held" }; const c = cn(role === "preparing" && S2[x.role]);`,
    // A delete of a preparing member; a spread the scan cannot read after a
    // spread of a slot map.
    "delete SLOT.preparing;",
    "const E = { ...SLOT, ...makeOverride() };",
  ]);
  // Outside a slot-host file and a role-keyed map.
  assertSlotPasses([
    // A slot map whose sibling values are not class literals.
    "const C = { shown: SHOWN_CLS, preparing: HIDE };",
    // A class variant naming the role, outside slot context.
    'export const H = () => <div className="h-full group-data-[slot=preparing]:invisible" />;',
    // A lone preparing entry.
    'const C = { preparing: "invisible" };',
    // A file whose only preparing spelling is escaped: the parse prefilter
    // reads raw source.
    `const C = { shown: "h-full", "prep${bs}x61ring": "absolute invisible" };`,
    // Slot code that is not a role-keyed map (a frame branching on a prop).
    'const Frame = ({ preparing }) => <div className={preparing ? "absolute invisible" : "h-full"} />;',
  ]);
});

test("preparing-slot-hide reads .ts and .tsx only", () => {
  // Stylesheets (selectors, @apply) are never read: the walked extensions are
  // pinned, so starting or stopping to read them is a deliberate change.
  assert.deepEqual(EXTENSIONS, [".ts", ".tsx"]);
});

test("preparing-slot-hide reads a number key without throwing", () => {
  // A number key carries its source text, like any other key.
  assert.deepEqual(
    preparingSlotHide('const C = { shown: "h-full", preparing: cn({ 1: true }) };'),
    [],
  );
  assert.doesNotThrow(() =>
    preparingSlotHide(
      'import type { SlotPhase } from "x";\nconst c = cn({ 0: isPreparing });',
    ),
  );
  // A clsx key reading no hide passes; one reading a hide flags.
  assertHostPasses(['const c = cn({ 0x1: role === "preparing" });']);
  assertHostFlags(['const c = cn({ 0x1: role === "preparing", invisible: isPreparing });']);
});

test("preparing-slot-hide reads a host's render sites for hides only", () => {
  // Labels, state and spinners keyed on the preparing role are not slot
  // classes; nothing but a hide fails at a render site.
  assertHostPasses([
    'const E = ({ r }) => <button aria-label={r === "preparing" ? "Loading" : "File"} />;',
    'const E = ({ r }) => <button title={r === "preparing" ? "Loading" : "Run"} />;',
    'const E = ({ r }) => <div data-state={r === "preparing" ? "closed" : "open"} />;',
    'const E = ({ r }) => <>{r === "preparing" && <Spinner />}</>;',
    'const E = ({ r }) => <>{r !== "held" && <Toolbar />}</>;',
    'const E = ({ r }) => <>{r === "preparing" ? <span className="sr-only">Loading</span> : null}</>;',
    'const reason = r === "preparing" ? "Loading" : null;',
    'function label(p: SlotPhase) { if (p === "preparing") return "Loading next file"; return "Current file"; }',
    'function label(p) { switch (p) { case "preparing": return "Loading"; default: return "Ready"; } }',
    'const c = cn(SLOT[r], r === "preparing" && "pointer-events-none");',
    "const E = ({ r }) => <div className={SLOT[r]} />;",
    'const E = ({ r }) => <div className={r === "preparing" ? SLOT.preparing : SLOT[r]} />;',
  ]);
  const bs = String.fromCharCode(92);
  assertHostFlags([
    'const c = cn(SLOT[r], r === "preparing" && "invisible");',
    'const E = ({ r }) => <>{r === "preparing" && <span className="invisible" />}</>;',
    // Role literals read cooked.
    `const E = ({ r }) => <div className={r === "prep${bs}x61ring" ? "absolute invisible" : SLOT[r]} />;`,
    // A read keyed by another role is not the preparing entry.
    'const c = cn("h-full", role === "preparing" && SLOT.held);',
  ]);
});

test("preparing-slot-hide holds a host's keys, writes and stray clips to the shape rule", () => {
  const bs = String.fromCharCode(92);
  assertHostFlags([
    // A slot map by its keys, whatever its sibling values hold.
    'const S = "h-full"; const R = { shown: S, held: S, preparing: "absolute inset-0" };',
    // A spread makes a map a slot map too.
    'const D = { ...SLOT, preparing: "absolute inset-0" };',
    // Role keys read cooked; an unreadable computed key fails.
    `const C = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)]", "prep${bs}x61ring": "absolute" };`,
    'const C = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)]", ["prep" + "aring"]: "absolute" };',
    'const P = "preparing"; const C = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)]", [P]: "absolute" };',
    // A map of computed keys the scan cannot read.
    'const R = { [Role.P]: "absolute", [Role.H]: "h-full" };',
    'import { k } from "./k"; const R = { ...SLOT, [k]: "absolute" };',
    'import { P } from "./p"; const R = { shown: "h-full", held: "h-full", [P]: "absolute inset-0" };',
    // A mixed-case property reaches Tailwind as a working rule.
    'const R = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)] [cLIP-PATH:none]" };',
    'const R = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)] [aLL:unset]" };',
    // No clip-path or `[all:…]` token outside a slot map's entry.
    'const E = ({ r }) => <div className={SLOT[r] + " md:[clip-path:none]"} />;',
    'const c = cn(SLOT[r], "[clip-path:none]");',
    'const c = cn(SLOT[r], "[all:unset]");',
    // No write to a preparing member.
    'SLOT.preparing = "absolute inset-0";',
    'SLOT["preparing"] += " pointer-events-none";',
    "[SLOT.preparing] = [\"absolute\"];",
    '({ x: SLOT.preparing } = { x: "absolute" });',
    '({ x: SLOT.preparing = "absolute" } = {});',
    '[...SLOT.preparing] = "absolute";',
    'Object.assign(SLOT, { preparing: "absolute inset-0" });',
    'Object.assign(SLOT, { ...{ preparing: "absolute" } });',
    'Object["assign"](SLOT, { preparing: "absolute" });',
    "Object.assign(SLOT, extra);",
    'Reflect.set(SLOT, "preparing", "absolute");',
    'Reflect.defineProperty(SLOT, "preparing", { value: "absolute" });',
    'Object.defineProperty(SLOT, "preparing", { value: "absolute" });',
    "SLOT.preparing++;",
    "SLOT.preparing--;",
    "++SLOT.preparing;",
    // JSX attribute strings decode character references.
    'const x = <>{r === "preparing" && <span className="a&#32;invisible" />}</>;',
    'const x = <div className="data-[role=preparing]:&#105;nvisible" />;',
    // In a class attribute, any other named reference is unreadable.
    'const x = <div className="a&nbsp;b" />;',
  ]);
  // A map-entry read keyed by anything but the preparing role or the role
  // variable is unreadable; a defineProperties descriptor is a write; a
  // reference named on Object.prototype is no known entity.
  const held =
    'const S2 = { shown: "h-full", held: "h-full invisible", preparing: "absolute [clip-path:inset(50%)]" };';
  assertHostFlags([
    `${held} const c = cn(role === "preparing" && S2[flag ? "held" : "shown"]);`,
    `${held} const c = cn(role === "preparing" && S2[pick(role)]);`,
    // A const of an expression the scan cannot read, or of another role.
    `${held} const k = flag ? "held" : "shown"; const c = cn(role === "preparing" && S2[k]);`,
    `${held} const k = pick(role); const c = cn(role === "preparing" && S2[k]);`,
    `${held} const k0 = flag ? "held" : "shown"; const k = k0; const c = cn(role === "preparing" && S2[k]);`,
    `${held} const k0 = "held"; const k = k0; const c = cn(role === "preparing" && S2[k]);`,
    `${held} const k = roles[i]; const c = cn(role === "preparing" && S2[k]);`,
    `${held} const c = cn(role === "preparing" && S2[roles[i]]);`,
    'Object.defineProperties(SLOT, { preparing: { value: "absolute" } });',
    'const x = <div className="h-full a&constructor;b" />;',
    'const x = <div className="h-full a&toString;b" />;',
  ]);
  assertHostPasses([
    `${held} const E = ({ role }) => <div className={S2[role]} />;`,
    `${held} const E = ({ slot }) => <div className={S2[slot.role]} />;`,
    `${held} const c = cn(role === "preparing" ? S2.preparing : S2[role]);`,
    `${held} const c = cn(role === "preparing" && S2["preparing"]);`,
    // A const of a `.name` member chain, of "preparing", or of an
    // unresolved name.
    `${held} const role = slot.role; const c = cn(role === "preparing" && S2[role]);`,
    `${held} const k0 = "preparing"; const k = k0; const c = cn(role === "preparing" && S2[k]);`,
    `${held} function f(r) { const k = r; return cn(r === "preparing" && S2[k]); }`,
    'const x = <div className="h-full a&amp;b" />;',
    // Not a character reference (a name starts with a letter): literal text.
    'const x = <div className="h-full a&__proto__;b" />;',
  ]);
  // A write through a const key, a const source, and a const spread override.
  assertHostFlags(['const P = "preparing";\nSLOT[P] = "absolute";'], [3]);
  assertHostFlags(['const P = "preparing";\nalias[P] = "absolute";'], [3]);
  assertHostFlags(
    ['const E = { preparing: "absolute" };\nObject.assign(SLOT, E);'],
    [3],
  );
  assertHostFlags(
    ['const OVR = { preparing: "absolute inset-0" };\nconst E = { ...SLOT, ...OVR };'],
    [3],
  );
  // A decoded reference is read for hides in any slot context.
  assertSlotFlags([
    'const C = { shown: "h-full", preparing: <span className="a&#32;invisible" /> };',
  ]);
  assertHostPasses([
    '<span className="sr-only">Loading</span>;',
    'const x = <div title="a &amp; b" />;',
    // A named reference outside class attributes is not class text.
    'const x = <p className="text-sm" title="Hidden&nbsp;until ready">x</p>;',
    'const x = <div title="Loading&hellip;" />;',
    // A spread of a clipped const map, and ordinary writes and state.
    'const OK = { preparing: "absolute [clip-path:inset(50%)]" };\nconst E = { ...SLOT, ...OK };',
    'const drafts = {}; drafts[key] = draft;',
    "const next = { ...state, [key]: ok ? \"ready\" : \"failed\" };",
    "Object.assign(target, extra);",
    'Reflect.set(target, key, "x");',
    // An unresolvable spread before the explicit key cannot override it.
    'const E = { ...props, shown: "h-full", preparing: "absolute [clip-path:inset(50%)]" };',
  ]);
  // An unresolvable spread after the key can override it.
  assertHostFlags([
    'const E = { shown: "h-full", preparing: "absolute [clip-path:inset(50%)]", ...props };',
  ]);
});

test("preparing-slot-hide fails closed on its listed residue", () => {
  // Each pinned flagging: the scan reads these as hides or unreadable.
  assertSlotFlags([
    // A label or prose string reading a hide utility inside a site.
    'const LABELS = { shown: "visible", held: "kept", preparing: "hidden" };',
    // A non-slot map that happens to key preparing beside shown.
    'const STATUS = { preparing: "opacity-60", shown: "" };',
  ]);
  assertHostFlags([
    // An unrelated hide in the extent a role mention climbs to.
    'const pair = [isRole(r, "preparing"), "hidden md:flex"];',
    // A JSX spread in a preparing class arm.
    'const x = role === "preparing" ? <div {...props} /> : null;',
    // A const whose name is bound twice in the file.
    'const HIDE = "absolute [clip-path:inset(50%)]"; function f() { const HIDE = "h-full"; } const C = { shown: "", preparing: HIDE };',
    // A role-literal comparison on a non-role value in a slot-host file.
    'function f(plan) { if (plan.kind === "held") return "h-full"; else return "hidden md:flex"; }',
    // In a host, any role-keyed map or state object is a slot map; use keys
    // other than the slot roles, or keep it outside the host file.
    'const LABELS = { held: "Previous file", shown: "Current file", preparing: "Loading" };',
    'const COUNTS = { held: 1, shown: 2, preparing: 3 };',
    // A clip-path animation on a non-slot element, and a clipped render-site
    // arm: move the element out of the host file, or put the clip in the map
    // entry.
    'const E = () => <div className="[clip-path:circle(0)] transition-[clip-path]" />;',
    'const E = ({ r }) => <div className={r === "preparing" ? "absolute inset-0 [clip-path:inset(50%)]" : SLOT[r]} />;',
    // A map-entry key read from a const of a call: read the role from a
    // prop or a destructured binding instead.
    'const role = useRole(); const c = cn(role === "preparing" && SLOT[role]);',
    // Object.assign copying a slot map into another object.
    'const copy = Object.assign({}, SLOT, { shown: "x" });',
    // A host's merge-status class map keyed `preparing`.
    'const MERGE = { preparing: "opacity-60 animate-pulse", clean: "" };',
  ]);
});

test("preparing-slot-hide reports the line each site starts on", () => {
  const source = inHost(
    [
      "import { cn } from '@/lib/utils';",
      "",
      "const SLOT_CLASS = {",
      '  shown: "h-full",',
      "  preparing:",
      "    cond",
      '      ? "absolute inset-0"',
      '      : "absolute inset-0 invisible",',
      '  held: "h-full",',
      "};",
      'const other = cn("a", isPreparing',
      '  && "opacity-0");',
    ].join("\n"),
  );
  assert.deepEqual(preparingSlotHide(source), [6, 12]);
  const sites = preparingSlotSites(source);
  assert.deepEqual(
    sites.map((s) => s.kind),
    ["entry", "entry", "guard"],
  );
});

test("preparing-slot-hide holds a slot host's preparing entries to a plain clipped class string", () => {
  const check = CHECKS.find((c) => c.name === "preparing-slot-hide");
  const file = "src/features/x/host.tsx";
  const run = (source) =>
    runCheck(check, [file], new Map([[file, view(source)]])).violations;
  const backslash = String.fromCharCode(92);
  const lines = (...body) =>
    [
      'import type { SlotPhase } from "@/features/diff/diff-pane-slots";',
      'const BASE = "absolute";',
      'const MD = "md:";',
      ...body,
      "export const F = ({ phase }: { phase: SlotPhase }) => <div className={C[phase]} />;",
    ].join("\n");
  // The entry sits on line 4.
  const entry = (value) =>
    lines(`const C = { shown: "h-full", held: "h-full", preparing: ${value} };`);
  for (const value of [
    '"absolute inset-0 [clip-path:inset(50%)]"',
    '"absolute " + "[clip-path:inset(50%)]"',
    "`absolute [clip-path:inset(50%)]`",
    '"absolute [clip-path:" + "inset(50%)]"',
    '"absolute " + ("[clip-path:" + "inset(50%)]")',
    '"absolute " + `[clip-path:inset(50%)]`',
    '"absolute [clip-path:inset(50%)!important]"',
    // The important marker may sit at one end, or ride the value.
    '"absolute [clip-path:inset(50%)]!"',
    '"absolute ![clip-path:inset(50%)]"',
    '"absolute [clip-path:inset(50%)_!important]"',
  ])
    assert.deepEqual(run(entry(value)), [], value);
  for (const value of [
    // Not a plain class string: the remedy is to write one.
    'cn("absolute", "[clip-path:inset(50%)]")',
    '`absolute ${"[clip-path:inset(50%)]"}`',
    'compact ? "absolute [clip-path:inset(50%)]" : "fixed [clip-path:inset(50%)]"',
    'cn({ "absolute [clip-path:inset(50%)]": true })',
    'cn({ "absolute [clip-path:inset(50%)]": false })',
    'cn("absolute", compact && "[clip-path:inset(50%)]")',
    'compact ? "absolute [clip-path:inset(50%)]" : "absolute"',
    '"absolute " + (compact ? "[clip-path:inset(50%)]" : "")',
    '`absolute ${compact && "[clip-path:inset(50%)]"}`',
    '`absolute ${{ "[clip-path:inset(50%)]": true }}`',
    '"absolute " + { "[clip-path:inset(50%)]": true }',
    '"absolute " + ["a", "[clip-path:inset(50%)]"]',
    '"absolute " + [, "[clip-path:inset(50%)]"]',
    '"absolute " + ["[clip-path:inset(50%)]"]',
    "`absolute ${MD}[clip-path:inset(50%)]`",
    '`absolute ${cn("[clip-path:inset(50%)]")}`',
    'cn("absolute", "[clip-path:inset(50%)]", wide && "[clip-path:inset(50%)]")',
    // Plain, but the clip is missing, glued, overridden (by another clip-path
    // token or an `[all:…]` reset), behind a variant (a descendant one too),
    // or marked `!` at both ends.
    '"absolute [clip-path:inset(50%)] [all:unset]!"',
    '"absolute inset-0"',
    '"absolute" + "[clip-path:inset(50%)]"',
    `"absolute${backslash}\n[clip-path:inset(50%)]"`,
    '"absolute [clip-path:inset(50%)] [clip-path:none]"',
    '"absolute [clip-path:inset(50%)] md:[clip-path:none]"',
    '"absolute [clip-path:inset(50%)] not-sr-only"',
    '"absolute inset-0 md:[clip-path:inset(50%)]"',
    '"absolute [&_*]:[clip-path:inset(50%)]"',
    '"absolute ![clip-path:inset(50%)]!"',
  ])
    assert.deepEqual(run(entry(value)), [`${file}:4`], value);
  // An unreadable interpolation also fails the class-expression reader, on
  // the same line.
  assert.deepEqual(run(entry("`absolute ${x}[clip-path:inset(50%)]`")), [
    `${file}:4`,
  ]);
  // A hide is read from the cooked text: the continuation joins `invisible`.
  assert.deepEqual(
    run(entry(`"absolute [clip-path:inset(50%)] in${backslash}\nvisible"`)),
    [`${file}:4`],
  );
  // Every slot-shaped map counts; the failure lands on the unclipped entry.
  assert.deepEqual(
    run(
      lines(
        'const A = { shown: "h-full", held: "h-full", preparing: "absolute [clip-path:inset(50%)]" };',
        'const C = { shown: "h-full", held: "h-full", preparing: "absolute inset-0" };',
      ),
    ),
    [`${file}:5`],
  );
  // A spread after the key can override the clip; one before it cannot.
  assert.deepEqual(
    run(
      lines(
        'const C = { shown: "h-full", held: "h-full", preparing: "absolute [clip-path:inset(50%)]", ...O };',
      ),
    ),
    [`${file}:4`],
  );
  assert.deepEqual(
    run(
      lines(
        'const C = { ...BASE, shown: "h-full", preparing: "absolute [clip-path:inset(50%)]" };',
      ),
    ),
    [],
  );
  // In a host a map is a slot map by its keys, so its siblings may be consts.
  assert.deepEqual(
    run(
      lines(
        'const S = "h-full"; const C = { shown: S, held: S, preparing: "absolute [clip-path:inset(50%)]" };',
      ),
    ),
    [],
  );
  // A map that is not slot-shaped is exempt, beside a clipped slot map.
  assert.deepEqual(
    run(
      lines(
        'const LABELS = { preparing: "Loading…", ready: "Ready" };',
        'const C = { shown: "h-full", held: "h-full", preparing: "absolute [clip-path:inset(50%)]" };',
      ),
    ),
    [],
  );
  // A host that renders classes keeps at least one slot-shaped map.
  assert.deepEqual(
    run(lines('const C = { shown: "h-full", held: "h-full" };')),
    [`${file}:1`],
  );
  // EntityHoldSlot alone makes a file a host.
  assert.deepEqual(
    run(
      [
        'import type { EntityHoldSlot } from "@/lib/use-entity-hold";',
        'const C = { shown: "h-full", held: "h-full", preparing: "absolute inset-0" };',
        "export const E = ({ slot }: { slot: EntityHoldSlot }) => <div className={C[slot.role]} />;",
      ].join("\n"),
    ),
    [`${file}:2`],
  );
  // The vocabulary alone, rendering no classes, is a definition module.
  assert.deepEqual(
    run('export type SlotPhase = "shown" | "held" | "preparing";'),
    [],
  );
});

test("preparing-slot-hide premise: the real roles, hosts and sites", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file) => readFileSync(join(root, file), "utf8");
  const members = (file, name) => {
    const m = new RegExp(`export type ${name} = ([^;]+);`).exec(read(file));
    assert.ok(m, `${name} moved out of ${file}`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  };
  const roles = [...SLOT_ROLES].sort();
  assert.deepEqual(members("src/lib/entity-hold.ts", "EntitySlotRole"), roles);
  assert.deepEqual(
    members("src/features/diff/diff-pane-slots.ts", "SlotPhase"),
    roles,
  );
  const check = CHECKS.find((c) => c.name === "preparing-slot-hide");
  assert.ok(check.expectScanned.atLeast >= 500);
  const hosts = [
    "src/features/actions/run-slots.tsx",
    "src/features/diff/DiffViewer.tsx",
  ];
  for (const file of hosts) {
    const source = read(file);
    const entries = preparingSlotSites(source, file).filter(
      (s) => s.kind === "entry",
    );
    assert.equal(entries.length, 1, `${file}: ${JSON.stringify(entries)}`);
    assert.ok(entries[0].value.includes("[clip-path:inset(50%)]"), file);
    assert.deepEqual(check.scan(view(source), file), [], file);
    // A host restructures a flagged expression; it never takes an exception.
    assert.ok(!check.allowlist.includes(file), file);
  }
  // Equals, so a third host is a deliberate update here.
  const seen = readdirSync(join(root, "src"), { recursive: true })
    .map((entry) => `src/${String(entry).split("\\").join("/")}`)
    .filter((file) => /\.tsx?$/.test(file))
    .filter(check.appliesTo)
    .filter((file) => isPreparingSlotHost(read(file), file))
    .sort();
  assert.deepEqual(seen, hosts, `slot hosts: ${JSON.stringify(seen)}`);
});

test("bare-group-label flags an attribute-less Label caption", () => {
  const caption = [
    '<div className="space-y-2">',
    "  <Label>Rules</Label>",
    '  <RuleToggle label="Require a pull request" checked={d.requirePr} />',
    "</div>",
  ].join("\n");
  assert.deepEqual(bareGroupLabel(caption), [2]);
  assert.deepEqual(bareGroupLabel("<Label>{label}</Label>"), [1]);
  // Two captions in one file are two findings, so a partial conversion can't
  // read as clean once the first is fixed.
  const two = ["<Label>Features</Label>", "<Label>Commits</Label>"].join("\n");
  assert.deepEqual(bareGroupLabel(two), [1, 2]);
});

test("bare-group-label flags a styled caption — className is not association", () => {
  // The most common spelling of the defect: a caption that looks deliberate
  // because it carries styling, but still names nothing.
  for (const source of [
    '<Label className="text-xs">Rules</Label>',
    '<Label className="text-xs text-muted-foreground">Pending invitations</Label>',
    // Styled AND self-closing, in both spellings.
    '<Label className="text-xs" />',
    "<Label/>",
    "<Label />",
  ])
    assert.deepEqual(bareGroupLabel(source), [1], `should flag ${source}`);
});

test("bare-group-label sees an open tag the formatter split across lines", () => {
  // The joined view is what makes this work: it trims each line and rejoins
  // with one space, which the `\s` between attributes absorbs.
  const split = [
    "<Label",
    "  key={e.id}",
    '  className="flex items-center gap-1.5 text-xs"',
    ">",
    "  Trigger events",
    "</Label>",
  ].join("\n");
  assert.deepEqual(bareGroupLabel(split), [1]);
  // A split open tag that DOES associate still passes — the lookahead reaches
  // across the rejoined attributes.
  const splitAssociated = [
    "<Label",
    "  htmlFor={`${idBase}-name`}",
    '  className="text-xs"',
    ">",
  ].join("\n");
  assert.deepEqual(bareGroupLabel(splitAssociated), []);
});

test("bare-group-label leaves every ASSOCIATED label alone", () => {
  for (const source of [
    // The single-control idiom.
    '<Label htmlFor="pages-cname">Custom domain</Label>',
    // The group idiom LabeledGroup emits — the id is what names the group.
    "<Label id={id}>{label}</Label>",
    // Association plus styling: the id still answers for the whole tag.
    '<Label id={invitesLabelId} className="text-xs text-muted-foreground">',
    // A lowercase `<label>` is the DOM element, not this component.
    '<label className="flex items-center gap-2"><Checkbox />Issues</label>',
    // The LabeledGroup call site itself.
    '<LabeledGroup label="Rules">{children}</LabeledGroup>',
  ])
    assert.deepEqual(bareGroupLabel(source), [], `should ignore ${source}`);
  // Comment stripping keeps the doc comment that NAMES the banned shape clean.
  assert.deepEqual(
    bareGroupLabel("// a bare `<Label>` names nothing for assistive tech"),
    [],
  );
});

test("bare-group-label allowlists whole files, and exempts vendored ui", () => {
  const check = CHECKS.find((c) => c.name === "bare-group-label");
  assert.equal(check.appliesTo("src/components/ui/label.tsx"), false);
  assert.equal(check.appliesTo("src/components/form/labeled-group.tsx"), true);
  assert.equal(
    check.appliesTo("src/features/repo-settings/PagesSection.tsx"),
    true,
  );
  // Entries are keyed per file: a WRAPPING label (implicit association, which
  // neither htmlFor nor id can express) is suppressed by its file's entry, and an
  // unlisted file still reports.
  const files = [
    "src/features/repo-settings/GitLabVariablesSection.tsx",
    "src/features/repo-settings/GitLabWebhooksSection.tsx",
    "src/features/repo-settings/PagesSection.tsx",
  ];
  const views = new Map([
    [
      "src/features/repo-settings/GitLabVariablesSection.tsx",
      view(
        '<Label className="flex items-center gap-1.5 text-xs">\n<Checkbox checked={isProtected} />\nProtected\n</Label>',
      ),
    ],
    // A wrapping label whose open tag the formatter split — the webhook shape.
    [
      "src/features/repo-settings/GitLabWebhooksSection.tsx",
      view(
        [
          "<Label",
          "  key={e.id}",
          '  className="flex items-center gap-1.5 text-xs font-normal"',
          ">",
          "  <Checkbox checked={events.includes(e.id)} />",
          "  {e.label}",
          "</Label>",
        ].join("\n"),
      ),
    ],
    [
      "src/features/repo-settings/PagesSection.tsx",
      view("<Label>Source</Label>"),
    ],
  ]);
  const { violations } = runCheck(check, files, views);
  assert.deepEqual(violations, [
    "src/features/repo-settings/PagesSection.tsx:1",
  ]);
});

test("unguarded-binding-dispatcher flags a swallowing dispatch with no guard", () => {
  // The shape the class fix closed: a second listener matching the live event
  // against a user binding and swallowing the key, with no editable guard.
  const source = [
    "function onKeyDown(e) {",
    "  const binding = eventToBinding(e);",
    "  if (binding && binding === effective) {",
    "    e.preventDefault();",
    "    run();",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(source), [2]);
});

test("unguarded-binding-dispatcher needs both tokens and clears on the full clause", () => {
  // Each token alone is ordinary: a binding read that swallows nothing, and a
  // preventDefault with no binding comparison at all.
  assert.deepEqual(
    unguardedDispatcher("const hint = eventToBinding(e) ?? null;"),
    [],
  );
  assert.deepEqual(unguardedDispatcher("e.preventDefault();"), []);
  // The WHOLE clause named ANYWHERE in the file clears it — the coarseness is
  // the documented trade: presence, not proof it guards this path. Mirrors the
  // canonical clause in hotkeys.tsx, because fixtures get copied.
  const guarded = [
    "function onKeyDown(e) {",
    "  const binding = eventToBinding(e);",
    "  if (!binding) return;",
    "  if (isEditableTarget(e.target) && !firesInEditable(binding)) return;",
    "  if (",
    "    !hasModifier(binding) &&",
    "    isTypeaheadKey(binding) &&",
    "    isTypeaheadTarget(e.target)",
    "  )",
    "    return;",
    "  if (binding === effective) e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(guarded), []);
});

test("unguarded-binding-dispatcher flags a HALF-guarded dispatcher", () => {
  // The two guards refuse different surfaces, so one without the other still
  // steals keys from the surface it does not cover.
  const editableOnly = [
    "function onKeyDown(e) {",
    "  if (isEditableTarget(e.target)) return;",
    "  const binding = eventToBinding(e);",
    "  if (binding === effective) e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(editableOnly), [3]);
  const typeaheadOnly = [
    "function onKeyDown(e) {",
    "  if (isTypeaheadTarget(e.target)) return;",
    "  const binding = eventToBinding(e);",
    "  if (binding === effective) e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(typeaheadOnly), [3]);
  // A key-narrowing helper is NOT a substitute for either target guard.
  const narrowingOnly = [
    "function onKeyDown(e) {",
    "  if (!isTypeaheadKey(binding)) return;",
    "  const binding = eventToBinding(e);",
    "  if (binding === effective) e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(narrowingOnly), [3]);
  // Two of three is still a subset: both target guards without the key half
  // is the drift shape — one dispatcher narrowing by key, its twin not.
  const targetsOnly = [
    "function onKeyDown(e) {",
    "  if (isEditableTarget(e.target)) return;",
    "  if (isTypeaheadTarget(e.target)) return;",
    "  const binding = eventToBinding(e);",
    "  if (binding === effective) e.preventDefault();",
    "}",
  ].join("\n");
  assert.deepEqual(unguardedDispatcher(targetsOnly), [4]);
});

test("unguarded-binding-dispatcher allowlists the non-rebindable dispatchers", () => {
  const check = CHECKS.find((c) => c.name === "unguarded-binding-dispatcher");
  const files = [
    "src/features/settings/KeyboardSection.tsx",
    "src/features/pulls/SomeNewView.tsx",
  ];
  const dispatcher = [
    "const binding = eventToBinding(e);",
    "if (binding === effective) e.preventDefault();",
  ].join("\n");
  const views = new Map([
    ["src/features/settings/KeyboardSection.tsx", view(dispatcher)],
    ["src/features/pulls/SomeNewView.tsx", view(dispatcher)],
  ]);
  // The recorder is exempt by contract; a NEW file with the same shape is not.
  assert.deepEqual(runCheck(check, files, views).violations, [
    "src/features/pulls/SomeNewView.tsx:1",
  ]);
});

test("titled-disabled-trigger flags both spellings of the hover-only reason", () => {
  // `disabled` on the trigger — the shape the pickers shipped in.
  const onTrigger = [
    "<span",
    "  title={disabledReason}",
    '  className={disabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"}',
    ">",
    "  <Popover.Trigger",
    "    disabled={!!disabledReason}",
    '    render={<Button variant="ghost" size="xs" aria-label="Edit labels" />}',
    "  >",
    "    Labels",
    "  </Popover.Trigger>",
    "</span>",
  ].join("\n");
  // Line 2, not 1: the match starts at the `title`, so a hit points at the
  // reason carrier rather than at the wrapper's opening tag.
  assert.deepEqual(titledDisabledTrigger(onTrigger), [2]);
  // Same class, `disabled` inside the render element instead — the reason is
  // hover-only either way, which is why the pattern anchors on the wrapper.
  const inRender = [
    '<span title={staleReason} className="inline-flex">',
    "  <DropdownMenuTrigger",
    "    render={",
    '      <Button variant="outline" size="xs" disabled={detailsStale} />',
    "    }",
    "  >",
    "    <DotsThreeIcon />",
    "  </DropdownMenuTrigger>",
    "</span>",
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(inRender), [1]);
});

test("titled-disabled-trigger leaves the primitive and the non-trigger wrappers alone", () => {
  // The fixed composition: no wrapper of its own, and the primitive's name in
  // the window blocks the match even if one survived for layout.
  const converted = [
    "<Popover.Trigger",
    "  render={",
    "    <DisabledReasonButton",
    '      variant="ghost"',
    '      aria-label="Edit labels"',
    "      disabled={!!disabledReason}",
    "      reason={disabledReason}",
    "    />",
    "  }",
    ">",
    "  Labels",
    "</Popover.Trigger>",
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(converted), []);
  const survivingWrapper = [
    '<span title={disabledReason} className="inline-flex">',
    "  <Popover.Trigger",
    "    render={<DisabledReasonButton disabled={!!disabledReason} reason={disabledReason} />}",
    "  >",
    "    Labels",
    "  </Popover.Trigger>",
    "</span>",
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(survivingWrapper), []);
  // A titled wrapper around a disabled NON-trigger control is the sanctioned
  // idiom for inputs the primitive can't wrap — no trigger tag, no match.
  for (const control of [
    '  <Input id="issue-due-date" type="date" disabled={blocked} />',
    '  <Switch id="issue-confidential" disabled={!!disabledReason} />',
  ]) {
    const wrapped = [
      '<span title={disabledReason} className="inline-flex">',
      control,
      "</span>",
    ].join("\n");
    assert.deepEqual(titledDisabledTrigger(wrapped), []);
  }
  // A menu SUB-trigger carries its reason in its own label (a disabled item has
  // no room for a tooltip), so it is excluded by name as well as by structure —
  // this fixture puts a titled wrapper around one to prove the name arm.
  const subTrigger = [
    '<span title={disabledReason} className="inline-flex">',
    "  <DropdownMenuSubTrigger",
    "    disabled={!!disabledReason}",
    '    className="data-disabled:opacity-50"',
    "  >",
    "    Hide…{disabledSuffix}",
    "  </DropdownMenuSubTrigger>",
    "</span>",
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(subTrigger), []);
  // Triggers that take `disabled` with no reason contract at all: nothing titles
  // them, so the wrapper anchor keeps them out without naming them.
  const plain = [
    '<TabsTrigger value="files" disabled={!hasFiles}>Files</TabsTrigger>',
    '<ContextMenuTrigger disabled={locked} render={<button type="button" />} />',
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(plain), []);
  // Tempering stops the scan where an element closes: a titled span that already
  // finished cannot pair with a later sibling's disabled trigger.
  const stacked = [
    '<span title={hint} className="inline-flex">',
    "  <Badge>{count}</Badge>",
    "</span>",
    "<DropdownMenuTrigger disabled={busy} render={<Button />}>",
    "  Menu",
    "</DropdownMenuTrigger>",
  ].join("\n");
  assert.deepEqual(titledDisabledTrigger(stacked), []);
});

test("titled-disabled-trigger reports every site now that the allowlist is empty", () => {
  const check = CHECKS.find((c) => c.name === "titled-disabled-trigger");
  const row = [
    '<span title={heldReason} className="inline-flex">',
    "  <Popover.Trigger",
    "    disabled={!!heldReason}",
    '    render={<Button variant="ghost" size="xs" />}',
    "  >",
    "    Projects",
    "  </Popover.Trigger>",
    "</span>",
  ].join("\n");
  const files = [
    "src/features/conversations/ProjectsPopover.tsx",
    "src/features/issues/SomeNewPicker.tsx",
  ];
  const views = new Map(files.map((f) => [f, view(row)]));
  // Every residual site converted, so the allowlist is empty: this ONE former
  // entry's path reports again alongside a fresh one, rather than staying
  // quiet as it did before. The separate stale-allowlist test is what pins
  // the general mechanism for every entry, past or future.
  assert.deepEqual(runCheck(check, files, views).violations, [
    "src/features/conversations/ProjectsPopover.tsx:1",
    "src/features/issues/SomeNewPicker.tsx:1",
  ]);
});

test("titled-badge flags a title on a Badge, on one line or wrapped", () => {
  assert.deepEqual(
    titledBadge('<Badge variant="secondary" title="Managed on the group">'),
    [1],
  );
  // The formatter's shape: the title several props into a split open tag, past
  // an arrow-valued prop the attribute run must step over.
  const wrapped = [
    '<div className="flex items-center gap-2">',
    "  <Badge",
    '    variant="outline"',
    "    onClick={() => setOpen(true)}",
    '    className="shrink-0 text-warning"',
    '    title={lockReason ? `Locked: ${lockReason}` : "Locked"}',
    "  >",
    "    Locked",
    "  </Badge>",
    "</div>",
  ].join("\n");
  assert.deepEqual(titledBadge(wrapped), [2]);
});

test("titled-badge leaves untitled badges and titles on other elements alone", () => {
  for (const source of [
    '<Badge variant="secondary">protected</Badge>',
    '<StatusDetailChip variant="secondary" label="Inherited" detail={hint} />',
    // A clip-titled sibling beside a plain badge: the open tag bounds the scan,
    // so the neighbour's title never pairs with the badge.
    '<Badge variant="secondary">inactive</Badge><p className="truncate" title={h.url}>{h.url}</p>',
    '<p className="truncate" title={h.url}>{h.url}</p><Badge variant="secondary">inactive</Badge>',
    // Look-alike props and a different component sharing the prefix.
    '<Badge subtitle="x" data-title="y">z</Badge>',
    '<BadgeList title="Labels" />',
  ])
    assert.deepEqual(titledBadge(source), [], `should ignore ${source}`);
  // Comment stripping keeps prose that NAMES the banned shape clean.
  assert.deepEqual(
    titledBadge('// never <Badge title="…"> — use the chip'),
    [],
  );
});

test("ungated-notification-producer flags both routes around the gate", () => {
  // The inbox route, in the spellings the seven producers shipped in: the lone
  // import, the mixed one, and the formatter-wrapped specifier list.
  assert.deepEqual(
    ungatedProducer(
      'import { pushNotification } from "@/lib/stores/notifications";',
    ),
    [1],
  );
  assert.deepEqual(
    ungatedProducer(
      'import { pushNotification, repoNameFromPath } from "@/lib/stores/notifications";',
    ),
    [1],
  );
  const wrapped = [
    "import {",
    "  type NotificationKind,",
    "  type NotificationTone,",
    "  pushNotification,",
    "  repoNameFromPath,",
    '} from "@/lib/stores/notifications";',
  ].join("\n");
  assert.deepEqual(ungatedProducer(wrapped), [1]);
  // A rename still reaches the same function, so the specifier's SOURCE name is
  // what the pattern keys on.
  assert.deepEqual(
    ungatedProducer(
      'import { pushNotification as push } from "@/lib/stores/notifications";',
    ),
    [1],
  );
  // The OS route: every export of the notify module is a direct ping, so the
  // module path alone is the match — specifier and namespace forms together.
  for (const source of [
    'import { notify } from "@/lib/notify";',
    'import { notifyIfUnfocused } from "@/lib/notify";',
    'import { notify, notifyIfUnfocused } from "@/lib/notify";',
    'import * as pings from "@/lib/notify";',
  ])
    assert.deepEqual(ungatedProducer(source), [1], `should flag ${source}`);
  // A file taking both routes reports each on its own line.
  const both = [
    'import { notifyIfUnfocused } from "@/lib/notify";',
    'import { pushNotification } from "@/lib/stores/notifications";',
  ].join("\n");
  assert.deepEqual(
    ungatedProducer(both).sort((a, b) => a - b),
    [1, 2],
  );
});

test("ungated-notification-producer sees past the alias into relative spellings", () => {
  // Both modules are reachable by path as well as by alias, and a producer may
  // legitimately sit in either directory — src/lib/stores/ already spells the
  // inbox module `./notifications` for an unrelated helper. Anchoring on the
  // trailing path segment is what keeps the alias from being the whole gate.
  for (const source of [
    'import { pushNotification } from "./notifications";',
    'import { pushNotification } from "../stores/notifications";',
    'import { pushNotification } from "../../lib/stores/notifications";',
    'import { pushNotification, repoNameFromPath } from "./notifications";',
    'import { notify } from "./notify";',
    'import { notifyIfUnfocused } from "../notify";',
    'import { notifyIfUnfocused } from "../../lib/notify";',
  ])
    assert.deepEqual(ungatedProducer(source), [1], `should flag ${source}`);
});

test("ungated-notification-producer flags a namespace import of the inbox module", () => {
  // `notifs.pushNotification(row)` names nothing at the import, so the
  // specifier arm cannot see it — hence its own arm, in every spelling.
  for (const source of [
    'import * as notifs from "@/lib/stores/notifications";',
    'import * as notifs from "./notifications";',
    'import * as inbox from "../stores/notifications";',
  ])
    assert.deepEqual(ungatedProducer(source), [1], `should flag ${source}`);
  // The namespace arm is scoped to the inbox module: a namespace import of any
  // OTHER module, the gate's own neighbours included, is ordinary.
  for (const source of [
    'import * as overrides from "@/lib/notifications/overrides";',
    'import * as api from "@/lib/settings/api";',
  ])
    assert.deepEqual(ungatedProducer(source), [], `should ignore ${source}`);
});

test("ungated-notification-producer leaves the gate's own siblings alone", () => {
  for (const source of [
    // The converted producer's imports: the gate, the resolution helpers, and
    // the type-only / helper exports the inbox module also carries.
    'import { emitNotification } from "@/lib/notifications/emit";',
    'import { repoNameFromPath } from "@/lib/stores/notifications";',
    'import type { NotificationTarget } from "@/lib/stores/notifications";',
    'import { type NotificationKind, repoNameFromPath } from "@/lib/stores/notifications";',
    // The RELATIVE spellings of those same legal imports — the segment anchor
    // widened the module match, never the identifier one. The first line is
    // src/lib/stores/repo-description-generation.ts's real import.
    'import { repoNameFromPath } from "./notifications";',
    'import type { NotificationKind } from "../stores/notifications";',
    // A neighbouring import cannot supply the token: `[^}]*` stops at the
    // import's own closing brace.
    'import { pushNotification } from "@/lib/stores/other";\nimport { repoNameFromPath } from "@/lib/stores/notifications";',
    // A CALL with no import of its own is emit.ts's own shape — the check is
    // anchored on the import, which is what a producer cannot avoid.
    "if (channels.inApp) pushNotification(row);",
    // The comment naming the banned route is what comment stripping keeps clean.
    '// never import { notifyIfUnfocused } from "@/lib/notify" in a producer',
  ])
    assert.deepEqual(ungatedProducer(source), [], `should ignore ${source}`);
});

test("ungated-notification-producer exempts the gate module only", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "ungated-notification-producer",
  );
  assert.equal(appliesTo("src/lib/notifications/emit.ts"), false);
  assert.equal(appliesTo("src/lib/notifications/overrides.ts"), true);
  assert.equal(appliesTo("src/lib/stores/notifications.ts"), true);
  assert.equal(appliesTo("src/features/sessions/store.ts"), true);
});

test("hand-rolled-store-open flags both routes to a hand-opened store", () => {
  for (const source of [
    // The import route, in every spelling a store module used: the value import,
    // the mixed value + type import the converted files all had, and an alias.
    'import { load } from "@tauri-apps/plugin-store";',
    'import { load, type Store } from "@tauri-apps/plugin-store";',
    'import { load as openStore } from "@tauri-apps/plugin-store";',
  ])
    assert.deepEqual(handRolledStoreOpen(source), [1], `should flag ${source}`);
  // The call route — the backstop for a load the import arm cannot see.
  assert.deepEqual(
    handRolledStoreOpen('const s = await load(storeName("x.json"), {});'),
    [1],
  );
});

test("hand-rolled-store-open sees the memo across the wrapped call", () => {
  const source = [
    'import * as store from "@tauri-apps/plugin-store";',
    "",
    "let storePromise = null;",
    "function getStore() {",
    '  storePromise ??= store.load(storeName("x.json"), {',
    "    autoSave: true,",
    "    defaults: {},",
    "  });",
    "  return storePromise;",
    "}",
  ].join("\n");
  // The namespace import carries no `load` specifier, so only the call arm fires.
  assert.deepEqual(handRolledStoreOpen(source), [5]);
});

test("hand-rolled-store-open leaves the helper route and type-only imports alone", () => {
  for (const source of [
    // The converted shape: the helper, and the `Store` type the stores that take a
    // store-typed parameter still need.
    'import { memoizedStoreLoader } from "@/lib/plugin-store";\nconst getStore = memoizedStoreLoader("x.json");',
    'import type { Store } from "@tauri-apps/plugin-store";',
    'import { type Store } from "@tauri-apps/plugin-store";',
    // A neighbouring import cannot supply the token: `[^}]*` stops at the import's
    // own closing brace.
    'import { load } from "./other";\nimport { type Store } from "@tauri-apps/plugin-store";',
    // A same-named import of something else entirely.
    'import { load } from "@/lib/settings/api";',
    // The idiom named in a comment is not a use of it.
    '// never `storePromise ??= load(storeName("x.json"), …)` — see plugin-store.ts',
  ])
    assert.deepEqual(
      handRolledStoreOpen(source),
      [],
      `should ignore ${source}`,
    );
});

test("hand-rolled-store-open exempts the helper module only", () => {
  const { appliesTo } = CHECKS.find((c) => c.name === "hand-rolled-store-open");
  assert.equal(appliesTo("src/lib/plugin-store.ts"), false);
  assert.equal(appliesTo("src/lib/jira/store.ts"), true);
  assert.equal(appliesTo("src/lib/repo-data-migration.ts"), true);
});

test("raw-store-reload flags a bare store reload, wrapped or not", () => {
  assert.deepEqual(
    rawStoreReload("await store.reload({ ignoreDefaults: true });"),
    [1],
  );
  assert.deepEqual(rawStoreReload("await store.reload();"), [1]);
  const wrapped = [
    "async function reloadRaw(store) {",
    "  try {",
    "    await store.reload({",
    "      ignoreDefaults: true,",
    "    });",
    "  } catch {}",
    "}",
  ].join("\n");
  assert.deepEqual(rawStoreReload(wrapped), [3]);
});

test("raw-store-reload leaves the helper route and a webview reload alone", () => {
  for (const source of [
    // The converted shape.
    'import { reloadToleratingEmptyStore } from "@/lib/plugin-store";\nawait reloadToleratingEmptyStore(await getStore());',
    // A different API entirely — excluded by the lookbehind, not by an allowlist.
    "<button onClick={() => window.location.reload()}>Reload</button>",
    "location.reload();",
    // Comment stripping keeps prose about the banned call clean.
    "// a bare store.reload() would swallow an unreadable file",
  ])
    assert.deepEqual(rawStoreReload(source), [], `should ignore ${source}`);
});

test("raw-store-reload exempts the helper module only", () => {
  const { appliesTo } = CHECKS.find((c) => c.name === "raw-store-reload");
  assert.equal(appliesTo("src/lib/plugin-store.ts"), false);
  assert.equal(appliesTo("src/lib/issues/local.ts"), true);
  assert.equal(appliesTo("src/components/ErrorBoundary.tsx"), true);
});

test("inline-repo-identity-query flags an inline observer of the shared key", () => {
  // The pre-fix shape all three observers had: the key spelled at the call site,
  // with its own options — which is how they drifted on networkMode.
  const inline = [
    "const { data: identity } = useQuery({",
    '  queryKey: ["repo-identity", repoPath],',
    "  queryFn: () => repoIdentity(repoPath),",
    "  enabled: !!repoPath,",
    "});",
  ].join("\n");
  assert.deepEqual(inlineRepoIdentityQuery(inline), [2]);
  // A cache read or an invalidation reaches the same key without useQuery at all.
  assert.deepEqual(
    inlineRepoIdentityQuery(
      'qc.invalidateQueries({ queryKey: ["repo-identity", repo] });',
    ),
    [1],
  );
  // Every quote style: the anchor is the quote pair, not the house style — and a
  // template literal is a valid key segment, so it must not slip past.
  assert.deepEqual(
    inlineRepoIdentityQuery("const k = ['repo-identity', r];"),
    [1],
  );
  assert.deepEqual(
    inlineRepoIdentityQuery("const k = [`repo-identity`, r];"),
    [1],
  );
});

test("inline-repo-identity-query leaves the factory route and the longer key alone", () => {
  for (const source of [
    // The converted shape: the options come from the factory, key included.
    'import { repoIdentityQueryOptions } from "@/lib/git/repo-identity-query";\nconst q = useQuery(repoIdentityQueryOptions(repoPath));',
    // A neighbouring repo-identity-flavoured key (NotificationsSection's own) that
    // is not this literal, and a hypothetical one sharing this exact PREFIX — the
    // closing-quote anchor is the only thing keeping the second out.
    'queryKey: ["notification-override-repo-identities", recentPaths],',
    'queryKey: ["repo-identity-scope", repoPath],',
    // The hook consumers, which never name the key.
    "const identity = useRepoIdentity(repoPath).data;",
    // Comment stripping keeps the several doc mentions of the key clean.
    '// every observer of ["repo-identity", repoPath] spreads the factory',
  ])
    assert.deepEqual(
      inlineRepoIdentityQuery(source),
      [],
      `should ignore ${source}`,
    );
});

test("inline-repo-identity-query exempts the factory module only", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "inline-repo-identity-query",
  );
  assert.equal(appliesTo("src/lib/git/repo-identity-query.ts"), false);
  assert.equal(appliesTo("src/lib/git/queries/core.ts"), true);
  assert.equal(appliesTo("src/lib/settings/queries.ts"), true);
  assert.equal(appliesTo("src/lib/scripts/queries.ts"), true);
});

test("queries-internal-import flags every spelling that reaches the private module", () => {
  // The alias route, which is how a feature file would most likely reach it.
  assert.deepEqual(
    queriesInternalImport(
      'import { useRepoMutation } from "@/lib/git/queries/internal";',
    ),
    [1],
  );
  // Relative routes of any depth, including a sibling inside src/lib/git/.
  assert.deepEqual(
    queriesInternalImport(
      'import { workingTreeKeys } from "./queries/internal";',
    ),
    [1],
  );
  assert.deepEqual(
    queriesInternalImport(
      'import { useRepoMutation } from "../../lib/git/queries/internal";',
    ),
    [1],
  );
  // An explicit extension, and the dynamic-import spelling, reach the same module.
  assert.deepEqual(
    queriesInternalImport('export { x } from "@/lib/git/queries/internal.ts";'),
    [1],
  );
  assert.deepEqual(
    queriesInternalImport(
      'const m = await import("@/lib/git/queries/internal");',
    ),
    [1],
  );
  // Non-normalized spellings that still RESOLVE to the private module. A pattern
  // matched against the raw path misses both; segment normalization is why these
  // are caught.
  assert.deepEqual(
    queriesInternalImport('import { x } from "@/lib/git/queries/./internal";'),
    [1],
  );
  assert.deepEqual(
    queriesInternalImport(
      'import { x } from "@/lib/git/queries/core/../internal";',
    ),
    [1],
  );
  // A subpath: internal.ts splitting into an internal/ directory is exactly the
  // move this package just made, so the boundary has to survive it.
  assert.deepEqual(
    queriesInternalImport(
      'import { x } from "@/lib/git/queries/internal/keys";',
    ),
    [1],
  );
});

test("queries-internal-import leaves the barrel and other packages' aliases alone", () => {
  for (const source of [
    // The supported route: the barrel, which never re-exports internal.ts.
    'import { useStage, useRepoStatus } from "@/lib/git/queries";',
    // A deeper public module of the same package is not the private one.
    'import { repoKeys } from "@/lib/git/queries/core";',
    // A longer name sharing the prefix — the segment boundary keeps it out.
    'import { x } from "@/lib/git/queries/internal-helpers";',
    // Some OTHER package's own internal module: the `git/queries/` anchor is what
    // scopes this check, so an unrelated sibling import must not trip it.
    'import { y } from "./internal";',
    'import { z } from "@/lib/notifications/internal";',
    // ANOTHER package's queries/internal, by alias. settings/ and scripts/ each own
    // a queries.ts that could split into a directory the same way this one did, and
    // an unanchored `queries/internal` tail would then flag their private module
    // as if it were this package's.
    'import { a } from "@/lib/settings/queries/internal";',
    'import { b } from "@/lib/scripts/queries/internal";',
    // A directory whose name merely ENDS in git is a different package.
    'import { c } from "@/lib/local-git/queries/internal";',
    'import { d } from "my-git/queries/internal";',
    // Comment stripping keeps the doc mentions of the boundary clean.
    '// never import from "@/lib/git/queries/internal" outside the package',
  ])
    assert.deepEqual(
      queriesInternalImport(source),
      [],
      `should ignore ${source}`,
    );
});

test("queries-internal-import over-reaches on a RELATIVE queries/internal", () => {
  // Documented bound, pinned so it stays deliberate: a bare `queries/internal`
  // tail has to flag, because that is how a file inside src/lib/git/ reaches this
  // package. The scanner sees a specifier, never the file it sits in, so the same
  // spelling from some other package's subdirectory flags too. The cost is a
  // false positive that an allowlist entry documents; the alternative is missing
  // the likeliest real violation.
  assert.deepEqual(
    queriesInternalImport('import { x } from "../queries/internal";'),
    [1],
  );
  assert.deepEqual(
    queriesInternalImport('import { x } from "./queries/internal";'),
    [1],
  );
});

test("queries-internal-import exempts the queries package itself", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "queries-internal-import",
  );
  // The package's own modules are the sanctioned consumers.
  assert.equal(appliesTo("src/lib/git/queries/internal.ts"), false);
  assert.equal(appliesTo("src/lib/git/queries/workingtree.ts"), false);
  assert.equal(appliesTo("src/lib/git/queries/index.ts"), false);
  // Everything outside it is scanned, including its immediate neighbours.
  assert.equal(appliesTo("src/lib/git/host.ts"), true);
  assert.equal(appliesTo("src/features/repository/FileRow.tsx"), true);
});

test("queries-internal-reexport catches a DOMAIN module republishing internals", () => {
  // `export *` chains republish, so one of these in any package module rides the
  // barrel's own `export * from "./<module>";` onto the public surface.
  for (const source of [
    'export * from "./internal";',
    'export { useRepoMutation } from "./internal";',
    'export * as internals from "./internal";',
    // The long ways round, and the subpath for when internal.ts becomes internal/.
    'export * from "@/lib/git/queries/internal";',
    'export * from "./core/../internal";',
    'export * from "./internal/keys";',
    // Vite suffixes address the same module.
    'export * from "./internal?raw";',
    'export * from "./internal.js?worker";',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [1],
      `should flag ${source}`,
    );
});

test("queries-internal-reexport catches a re-export SPLIT across two statements", () => {
  // The evasion a specifier-matching pattern can never see: the export clause
  // carries no module path at all, so the binding has to be tracked from its
  // import. index.ts's `export *` republishes it exactly like a direct re-export.
  // Line 2 every time: the report points at the offending EXPORT, not the
  // import, which is legal on its own and is not what needs removing.
  for (const source of [
    'import { workingTreeKeys } from "./internal";\nexport { workingTreeKeys };',
    // Aliased on the way in — the spelling that makes the export site look local.
    'import { useRepoMutation as m } from "./internal";\nexport { m };',
    'import { useRepoMutation as m } from "./internal";\nexport default m;',
    // Renamed on the way out; the LOCAL name is what ties it to the import.
    'import { a } from "./internal";\nexport { a as publicName };',
    // The alias spelling of the import reaches the same module.
    'import { x } from "@/lib/git/queries/internal";\nexport { x };',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [2],
      `should flag ${source}`,
    );
});

test("queries-internal-reexport catches TYPE-only re-exports of internal", () => {
  // Erased at runtime, but a type-only re-export still publishes the NAME through
  // the barrel's type space, so `export type { workingTreeKeys }` widens the
  // public surface exactly like the value form.
  for (const source of [
    // Statement-level `export type { … }` — the form that carries no specifier.
    'import { a } from "./internal";\nexport type { a };',
    'import type { a } from "./internal";\nexport type { a };',
    // The inline `type` modifier, on either side of the split.
    'import { type a } from "./internal";\nexport { a };',
    'import { a } from "./internal";\nexport { type a };',
    'import type { a } from "./internal";\nexport { a };',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [2],
      `should flag ${source}`,
    );
  // The specifier arm already owns the `from` spellings — it matches on `from`,
  // which `export type *` and `export type { … } from` both carry.
  assert.deepEqual(
    queriesInternalReexport('export type * from "./internal";'),
    [1],
  );
  assert.deepEqual(
    queriesInternalReexport('export type { A } from "./internal";'),
    [1],
  );
});

test("queries-internal-reexport leaves unrelated type exports alone", () => {
  for (const source of [
    // A type-only export with no internal import in the file.
    "export type { LocalType };",
    // A type re-exported from a PUBLIC sibling.
    'import { a } from "./core";\nexport type { a };',
    // A type ALIAS declaration is not an export clause at all.
    "export type Foo = { a: string };",
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [],
      `should ignore ${source}`,
    );
});

test("queries-internal-reexport ignores exports unrelated to internal", () => {
  for (const source of [
    // A bare export clause with no internal import in the file at all.
    "export { localThing };",
    // Imports internal, but exports only its own symbols — the legal shape.
    'import { workingTreeKeys } from "./internal";\nexport { myOwnHelper };',
    'import { workingTreeKeys } from "./internal";\nexport const x = 1;',
    // A split re-export of a PUBLIC sibling is ordinary package work.
    'import { a } from "./core";\nexport { a };',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [],
      `should ignore ${source}`,
    );
});

test("queries-internal-reexport does not pair an export DECLARATION with a later import", () => {
  // `export enum E { A }` ends without a semicolon, so a `;`-bounded gap alone
  // would run past it and pair with the next plain import's specifier. The gap is
  // bounded by the `import` keyword too, which is what keeps these clean.
  for (const source of [
    'export enum E { A }\nimport { workingTreeKeys } from "./internal";',
    'export interface I { a: string }\nimport { x } from "./internal";',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [],
      `should ignore ${source}`,
    );
  // And the bound costs no real detections: a re-exported name may CONTAIN
  // "import" without the word boundary matching.
  assert.deepEqual(
    queriesInternalReexport(
      'export { default as importedThing } from "./internal";',
    ),
    [1],
  );
});

test("queries-internal-reexport leaves plain imports of internal alone", () => {
  // Importing the shared helpers is the whole point of internal.ts; only
  // RE-exporting them widens the barrel's surface.
  for (const source of [
    'import { useRepoMutation } from "./internal";',
    'import { workingTreeKeys, repoSettingsKey } from "./internal";',
    'import { useRepoMutation } from "@/lib/git/queries/internal";',
    // A re-export of a PUBLIC sibling is ordinary barrel work.
    'export * from "./core";',
    // An export statement cannot pair with a later import's specifier: the gap
    // between `export` and `from` may not cross a `;`.
    'export const x = 1; import y from "./internal";',
  ])
    assert.deepEqual(
      queriesInternalReexport(source),
      [],
      `should ignore ${source}`,
    );
});

test("queries-internal-reexport covers the package but exempts internal.ts", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "queries-internal-reexport",
  );
  // Every module in the package, the barrel included — export * chains from any
  // of them reach the public surface.
  assert.equal(appliesTo("src/lib/git/queries/core.ts"), true);
  assert.equal(appliesTo("src/lib/git/queries/workingtree.ts"), true);
  assert.equal(appliesTo("src/lib/git/queries/index.ts"), true);
  // internal.ts is the module in question, so it cannot re-export itself.
  assert.equal(appliesTo("src/lib/git/queries/internal.ts"), false);
  // Outside the package, queries-internal-import owns the boundary instead.
  assert.equal(appliesTo("src/lib/git/host.ts"), false);
});

test("a path-pinned check fails loudly instead of going inert", () => {
  // The silent fail-open this file exists to prevent: a pinned check whose path
  // moved scans nothing and prints OK. The pin turns that into a failure.
  const barrel = CHECKS.find(
    (c) => c.name === "queries-barrel-internal-reference",
  );
  assert.equal(scopePinFailure(barrel, 1), null);
  const moved = scopePinFailure(barrel, 0);
  assert.match(moved, /SCOPE PIN FAILED/);
  // The message has to name the path to re-point, or it cannot be acted on.
  assert.match(moved, /src\/lib\/git\/queries\/index\.ts/);

  const pkg = CHECKS.find((c) => c.name === "queries-internal-reexport");
  assert.equal(scopePinFailure(pkg, 29), null);
  assert.match(scopePinFailure(pkg, 1), /SCOPE PIN FAILED/);
  // The floor sits near the real module count: a QUERIES_DIR typo that left only a
  // handful of files matching would otherwise pass while scanning almost nothing.
  assert.equal(pkg.expectScanned.atLeast, 20);
  assert.match(scopePinFailure(pkg, 5), /SCOPE PIN FAILED/);
  // A check with no pin is unaffected.
  assert.equal(scopePinFailure({ name: "unpinned" }, 0), null);
});

test("reachesGitQueriesInternal pins what counts as the package's internals", () => {
  // Asserted directly, not just through a scanner: this predicate is the semantic
  // core of the whole boundary family, and a scanner refactor must not be able to
  // quietly change what "reaches internal" means.
  for (const spec of [
    "@/lib/git/queries/internal",
    "@/lib/git/queries/internal.ts",
    "@/lib/git/queries/internal/keys", // internal.ts may become internal/
    "@/lib/git/queries/./internal", // non-normalized, still resolves there
    "@/lib/git/queries/core/../internal",
    "@/lib/git/queries/internal?raw", // vite suffixes address the same file
    "../../lib/git/queries/internal",
    "queries/internal", // the in-package relative spelling
  ])
    assert.equal(
      reachesGitQueriesInternal(spec),
      true,
      `should reach: ${spec}`,
    );

  for (const spec of [
    "@/lib/git/queries", // the barrel is the supported route
    "@/lib/git/queries/core",
    "@/lib/git/queries/internal-helpers", // segment boundary, not a prefix match
    "@/lib/settings/queries/internal", // another package's internals
    "@/lib/scripts/queries/internal",
    "@/lib/local-git/queries/internal", // a dir merely ENDING in git
    "my-git/queries/internal",
    "./internal", // a bare sibling belongs to whoever imports it
  ])
    assert.equal(reachesGitQueriesInternal(spec), false, `should not: ${spec}`);
});

test("reachesQueriesInternalFromSibling adds the in-package sibling spelling", () => {
  // Inside the package internal.ts is reached as `./internal`, a form carrying no
  // `queries/` segment at all — so this predicate is strictly wider than the one
  // above, and never narrower.
  for (const spec of [
    "./internal",
    "./internal.ts",
    "./././internal",
    "./core/../internal",
    "./internal/keys",
  ])
    assert.equal(
      reachesQueriesInternalFromSibling(spec),
      true,
      `sibling should reach: ${spec}`,
    );
  for (const spec of ["./core", "./internal-ish", "./internals", "./worktrees"])
    assert.equal(
      reachesQueriesInternalFromSibling(spec),
      false,
      `sibling should not: ${spec}`,
    );
  // Strictly wider: everything the outside-facing predicate accepts, this does too.
  for (const spec of ["@/lib/git/queries/internal", "queries/internal"])
    assert.equal(reachesQueriesInternalFromSibling(spec), true, spec);
});

test("okReportLine suppresses the OK line for a check that went inert", () => {
  const check = { name: "x" };
  const clean = { scanned: [1, 2], violations: [], stale: [] };
  assert.equal(okReportLine(check, clean, null), "x: OK (2 files scanned)\n");
  // The whole point: a moved path must never read as a pass.
  assert.equal(okReportLine(check, clean, "SCOPE PIN FAILED — …"), null);
  assert.equal(
    okReportLine(check, { scanned: [1], violations: ["a:1"], stale: [] }, null),
    null,
  );
  assert.equal(
    okReportLine(
      check,
      { scanned: [1], violations: [], stale: ["f.ts"] },
      null,
    ),
    null,
  );
});

test("queries-internal-present pins the module the whole family is named around", () => {
  // Renaming internal.ts makes every other rule vacuously green: the re-export
  // check simply starts treating the renamed module as an ordinary one, and its
  // floor is still met. This pin is the only thing that notices.
  const present = CHECKS.find((c) => c.name === "queries-internal-present");
  const { appliesTo } = present;
  assert.equal(appliesTo("src/lib/git/queries/internal.ts"), true);
  assert.equal(appliesTo("src/lib/git/queries/core.ts"), false);
  assert.equal(appliesTo("src/lib/settings/internal.ts"), false);
  // It carries no pattern of its own — existence is the whole assertion.
  assert.deepEqual(present.scan(view('export * from "./internal";')), []);
  assert.equal(scopePinFailure(present, 1), null);
  const renamed = scopePinFailure(present, 0);
  assert.match(renamed, /SCOPE PIN FAILED/);
  assert.match(renamed, /src\/lib\/git\/queries\/internal\.ts/);
});

test("queries-barrel-internal-reference catches the barrel naming its internals", () => {
  // The one line that undoes the package boundary, and the spellings around it.
  for (const source of [
    'export * from "./internal";',
    'export { useRepoMutation } from "./internal";',
    'export * from "./internal.ts";',
    // An import is no better: index.ts is a pure export list, so a reference to
    // internal there is a re-export or one edit from becoming one.
    'import { workingTreeKeys } from "./internal";',
    // The barrel can also name its own private module the long way round. A raw
    // `./internal` pattern misses every one of these.
    'export * from "@/lib/git/queries/internal";',
    'export * from "../queries/internal";',
    'export * from "./././internal";',
    'export * from "./core/../internal";',
    // And the subpath, for when internal.ts becomes internal/.
    'export * from "./internal/keys";',
  ])
    assert.deepEqual(
      queriesBarrelInternal(source),
      [1],
      `should flag ${source}`,
    );
});

test("queries-barrel-internal-reference leaves the real barrel lines alone", () => {
  for (const source of [
    'export * from "./core";',
    'export * from "./workingtree";',
    'export * from "./worktrees";',
    // Domain modules whose names merely start the same way.
    'export * from "./internal-ish";',
    'export * from "./internals";',
    // Comment stripping keeps the barrel's own explanatory header clean.
    "// internal.ts is intentionally absent — see its header.",
  ])
    assert.deepEqual(
      queriesBarrelInternal(source),
      [],
      `should ignore ${source}`,
    );
});

test("queries-barrel-internal-reference is pinned to the barrel file only", () => {
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "queries-barrel-internal-reference",
  );
  assert.equal(appliesTo("src/lib/git/queries/index.ts"), true);
  // A domain module is out of THIS check's scope, because importing internal
  // there is legal — but re-exporting it is not, and queries-internal-reexport
  // covers that half. The two together are what make the boundary hold.
  assert.equal(appliesTo("src/lib/git/queries/workingtree.ts"), false);
  assert.deepEqual(
    queriesInternalReexport('import { useRepoMutation } from "./internal";'),
    [],
    "a domain module may IMPORT internal",
  );
  assert.deepEqual(
    queriesInternalReexport('export * from "./internal";'),
    [1],
    "a domain module may NOT re-export internal",
  );
  assert.equal(appliesTo("src/lib/git/queries/internal.ts"), false);
  // And no other barrel in the repo is this one.
  assert.equal(appliesTo("src/lib/settings/index.ts"), false);
});

test("mutation-identity-pinning flags an unpinned repo-scoped create", () => {
  // The pre-fix shape every create-family hook had: the call and its invalidation
  // both closing over the hook's `repo`, with nothing pinning the mutation key.
  const plain = [
    "export function useCreateRuleset(repo: string) {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn: (body: Record<string, unknown>) =>",
    "      api.ghRulesetCreate(repo, body),",
    "    onSettled: () =>",
    "      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(plain), [3]);
  // The useRepoMutation form must fail the same way — six of the pinned sites are
  // plain useMutation, so a useRepoMutation-only scan would miss half the class.
  const viaHelper = [
    "export function useCreateTag(repo: string) {",
    "  return useRepoMutation(repo, (args: { name: string; hash: string }) =>",
    "    api.gitTag(repo, args.name, args.hash),",
    "  );",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(viaHelper), [2]);
  // The seed arm: not create-named, but a response written into a hook-scope key
  // on success — an exported repo-scoped seed, which keeps its pin for hold scoping.
  const seed = [
    "export function useUpdateGlRepoSettings(repo: string) {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn: (input: GitLabRepoSettingsInput) =>",
    "      api.forgeGlRepoSettingsUpdate(repo, input),",
    "    onSuccess: (data) =>",
    "      queryClient.setQueryData(glRepoSettingsKey(repo), data),",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(seed), [3]);
});

test("mutation-identity-pinning accepts a key wrapped across lines", () => {
  // THE formatting the guard has to survive: biome wraps a four-axis key onto its
  // own lines, so the literal lands on the line AFTER `mutationKey: [`. A
  // single-line anchor reads this exact (pinned) site as unpinned.
  const wrapped = [
    "export function useJiraCreateIssue(",
    "  repo: string,",
    "  link: JiraLink | null | undefined,",
    ") {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationKey: [",
    '      "jira-create-issue",',
    "      repo,",
    "      link?.siteHost ?? null,",
    "      link?.projectKey ?? null,",
    "    ],",
    "    mutationFn: (args: { issueTypeId: string }) =>",
    "      jiraIssueCreate((link as JiraLink).siteHost, args.issueTypeId),",
    "    onSettled: () => invalidateJiraForRepo(queryClient, repo),",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(wrapped), []);
  // Both spellings pin, on both call forms, wrapped or not.
  for (const source of [
    'export function useCreateDiscussion(repo: string) {\n  return useRepoMutation(repo, (a) => api.create(repo, a), {\n    identity: ["create-discussion", repo],\n  });\n}',
    'export function useCreatePr(repo: string) {\n  return useRepoMutation(\n    repo,\n    (a) => api.prCreate(repo, a),\n    {\n      identity: [\n        "create-pr",\n        repo,\n      ],\n    },\n  );\n}',
    'export function useCreateWebhook(repo: string) {\n  return useMutation({\n    mutationKey: ["webhook", "create", repo],\n    mutationFn: (i: WebhookInput) => api.ghHookCreate(repo, i),\n  });\n}',
  ])
    assert.deepEqual(
      unpinnedMutationIdentity(source),
      [],
      `should accept ${source}`,
    );
});

test("mutation-identity-pinning leaves mutations with no repo closure alone", () => {
  for (const source of [
    // The other valid remedy: the write target rides the VARIABLES, so the hook
    // has no repo in scope for a switch to redirect (useMoveBoardCard's shape).
    "export function useMoveBoardCard() {\n  return useMutation({\n    mutationFn: (args: { repo: string }) => api.move(args.repo),\n  });\n}",
    // Account-scoped, and a non-create name with no cache seed.
    "export function useGhPublishOwners(enabled: boolean) {\n  return useMutation({\n    mutationFn: () => api.publish(),\n  });\n}",
    // Repo-scoped but neither create nor seed: the convention still governs it,
    // this ratchet deliberately does not (see the check's appliesTo note).
    "export function useCheckoutBranch(repo: string) {\n  return useRepoMutation(repo, (n: string) => api.checkout(repo, n));\n}",
    // The export gate, pinned by a name CREATE_HOOK_RE does match: a private
    // helper no exported hook delegates to is not a mutation the package ships.
    "function useCreateThing(repo: string) {\n  return useMutation({ mutationFn: (a) => api.create(repo, a) });\n}",
    // Comment stripping keeps the convention's own prose out of the scan.
    '// useCreateThing(repo) must pass identity: ["create-thing", repo]',
  ])
    assert.deepEqual(
      unpinnedMutationIdentity(source),
      [],
      `should ignore ${source}`,
    );
});

test("mutation-identity-pinning follows a create hook into its private wrapper", () => {
  // webhooks.ts's real shape: the exported create hook builds nothing itself, it
  // delegates, so the key has to live on the WRAPPER. Scanning only the exported
  // hook's own body reads this whole five-hook family as clean.
  const wrapper = (key) =>
    [
      "function useWebhookMutation<TArgs, TData>(",
      "  repo: string,",
      "  op: string,",
      "  mutationFn: (args: TArgs) => Promise<TData>,",
      ") {",
      "  const queryClient = useQueryClient();",
      "  return useMutation({",
      ...(key ? [`    mutationKey: ["webhook", op, repo],`] : []),
      "    mutationFn,",
      "    onSettled: () =>",
      "      queryClient.invalidateQueries({ queryKey: webhooksKey(repo) }),",
      "  });",
      "}",
      "",
      "export function useCreateWebhook(repo: string) {",
      '  return useWebhookMutation(repo, "create", (input: WebhookInput) =>',
      "    api.ghHookCreate(repo, input),",
      "  );",
      "}",
    ].join("\n");
  // Unkeyed wrapper: reported at the wrapper's own useMutation, which is where the
  // fix goes — not at the delegating hook.
  assert.deepEqual(unpinnedMutationIdentity(wrapper(false)), [7]);
  assert.deepEqual(unpinnedMutationIdentity(wrapper(true)), []);
});

test("mutation-identity-pinning stops at its documented boundary", () => {
  // A seeding wrapper reached ONLY from non-create hooks — useTimeTrackingMutation's
  // shape. Inside the check's stated class (a response seeded on success by an
  // unpinned repo-scoped mutation, here keyed from its context) but outside what it
  // follows, since delegation is resolved from create hooks only.
  // Pinned as a fixture so widening the rule fails HERE, loudly, instead of quietly
  // turning every such wrapper into a new pin-or-allowlist decision.
  const seedingWrapper = [
    // Four parameters, matching the real useTimeTrackingMutation this pins, so the
    // fixture stays greppable against its site.
    "function useTimeTrackingMutation(",
    "  repo: string,",
    "  statsKey: (repo: string, number: number) => readonly unknown[],",
    "  viewKey: (repo: string, number: number) => readonly unknown[],",
    "  mutationFn: (args: { number: number }) => Promise<GitLabTimeStats>,",
    ") {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn,",
    "    onMutate: () => ({ repo }),",
    "    onSuccess: (stats, args, ctx) => {",
    "      queryClient.setQueryData(statsKey(ctx.repo, args.number), stats);",
    "    },",
    "  });",
    "}",
    "",
    "export function useAddMrSpentTime(repo: string) {",
    "  return useTimeTrackingMutation(repo, mrTimeStatsKey, mrViewKey, (args) =>",
    "    api.forgeGlMrAddSpentTime(repo, args.number),",
    "  );",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(seedingWrapper), []);
  // The same wrapper IS reached once a create-named hook delegates to it, which is
  // the line the boundary actually draws.
  assert.deepEqual(
    unpinnedMutationIdentity(
      `${seedingWrapper}\n\nexport function useCreateSpentTime(repo: string) {\n  return useTimeTrackingMutation(repo, k, v, (a) => api.x(repo, a));\n}`,
    ),
    [8],
  );
});

test("mutation-identity-pinning requires the identity ARGUMENT at a conditionally-keyed delegation", () => {
  // A conditionally-keyed delegation shape (no live instance in src today).
  // `MUTATION_KEYED_RE` sees the spread and reads the wrapper as pinned however
  // it is called, so the obligation is the delegating call's: without this the
  // key can be dropped and checks stay green.
  const mod = (identityArg) =>
    [
      "function useLocalPrMutation<TArgs, TData>(",
      "  repo: string,",
      "  fn: (args: TArgs) => Promise<TData>,",
      "  identity?: readonly unknown[],",
      ") {",
      "  const queryClient = useQueryClient();",
      "  return useMutation({",
      "    ...(identity ? { mutationKey: identity } : {}),",
      "    mutationFn: fn,",
      "    onSettled: () =>",
      "      queryClient.invalidateQueries({ queryKey: localPrKey(repo) }),",
      "  });",
      "}",
      "",
      "export function useCreateLocalPr(repo: string) {",
      "  return useLocalPrMutation(",
      "    repo,",
      "    (input: { title: string }) => createLocalPr(repo, input),",
      ...(identityArg ? ['    ["local-pr", "create", repo],'] : []),
      "  );",
      "}",
    ].join("\n");
  // Passing it: clean. Omitting it: the delegating call is the violation, reported
  // at its own line (16) — the wrapper body is not where the fix goes.
  assert.deepEqual(unpinnedMutationIdentity(mod(true)), []);
  assert.deepEqual(unpinnedMutationIdentity(mod(false)), [16]);
  // The `&&` spelling of the same spread has to behave identically — recognizing
  // only the ternary was its own fail-open: MUTATION_KEYED_RE reads the wrapper as
  // pinned, and a delegator dropping the key would have gone unreported.
  const andForm = (identityArg) =>
    [
      "function useLocalPrMutation<TArgs, TData>(",
      "  repo: string,",
      "  fn: (args: TArgs) => Promise<TData>,",
      "  identity?: readonly unknown[],",
      ") {",
      "  return useMutation({",
      "    ...(identity && { mutationKey: identity }),",
      "    mutationFn: fn,",
      "  });",
      "}",
      "",
      "export function useCreateLocalPr(repo: string) {",
      "  return useLocalPrMutation(",
      "    repo,",
      "    (input: { title: string }) => createLocalPr(repo, input),",
      ...(identityArg ? ['    ["local-pr", "create", repo],'] : []),
      "  );",
      "}",
    ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(andForm(true)), []);
  assert.deepEqual(unpinnedMutationIdentity(andForm(false)), [13]);
  // The two sides of the spread must name the SAME binding, or an unrelated pair
  // would read as a conditional key and move the obligation to the call.
  assert.deepEqual(
    unpinnedMutationIdentity(
      andForm(false).replace(
        "{ mutationKey: identity })",
        "{ mutationKey: other })",
      ),
    ),
    [],
  );
  // An unconditional key (useWebhookMutation's shape) is unaffected: there is no
  // optional parameter for the call to have to supply.
  const unconditional = [
    "function useWebhookMutation<TArgs, TData>(",
    "  repo: string,",
    "  op: string,",
    "  mutationFn: (args: TArgs) => Promise<TData>,",
    ") {",
    "  return useMutation({",
    '    mutationKey: ["webhook", op, repo],',
    "    mutationFn,",
    "  });",
    "}",
    "",
    "export function useCreateWebhook(repo: string) {",
    '  return useWebhookMutation(repo, "create", (i) => api.create(repo, i));',
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(unconditional), []);
});

test("mutation-identity-pinning sees through a generic parameter list", () => {
  // `function useX<T>(` puts a `<` where the anchor wants a `(`; an anchor that
  // demands the paren swallows every generic declaration without a sound.
  const generic = [
    "export function useCreateThing<TArgs, TData>(repo: string) {",
    "  return useMutation({",
    "    mutationFn: (a: TArgs) => api.create(repo, a),",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(unpinnedMutationIdentity(generic), [2]);
  // A constraint carrying an arrow type must not end the generic list early.
  const constrained =
    "export function useCreateThing<T extends (a: string) => void>(repo: string) {\n  return useMutation({ mutationFn: (a: T) => api.create(repo, a) });\n}";
  assert.deepEqual(unpinnedMutationIdentity(constrained), [2]);
});

test("mutation-identity-pinning is scoped to the query modules, with no allowlist", () => {
  const check = CHECKS.find((c) => c.name === "mutation-identity-pinning");
  assert.equal(check.appliesTo("src/lib/git/queries/branches.ts"), true);
  assert.equal(check.appliesTo("src/lib/jira/queries.ts"), true);
  // The local-entity modules: same repo-scoped create shape, own directories.
  assert.equal(check.appliesTo("src/lib/pulls/queries.ts"), true);
  assert.equal(check.appliesTo("src/lib/issues/queries.ts"), true);
  // Their neighbours are not swept in with them.
  assert.equal(check.appliesTo("src/lib/pulls/local.ts"), false);
  assert.equal(check.appliesTo("src/lib/issues/local.ts"), false);
  // Feature files declare no query hooks; .tsx never enters the scope.
  assert.equal(check.appliesTo("src/features/pulls/CreatePrDialog.tsx"), false);
  assert.equal(check.appliesTo("src/lib/settings/queries.ts"), false);
  // No exceptions: a new one is a reviewed decision, never a leftover.
  assert.deepEqual(check.allowlist, []);
  const flagged =
    "export function useStackCreate(repo: string, lens: RemoteLens) {\n  return useRepoMutation(repo, (prs: number[]) =>\n    api.forgeStackCreate(repo, prs, lens),\n  );\n}";
  assert.deepEqual(unpinnedMutationIdentity(flagged), [2]);
  const pinned =
    'export function useStackCreate(repo: string, lens: RemoteLens) {\n  return useRepoMutation(\n    repo,\n    (prs: number[]) => api.forgeStackCreate(repo, prs, lens),\n    { identity: ["pr-write", "stack-create", repo] },\n  );\n}';
  assert.deepEqual(unpinnedMutationIdentity(pinned), []);
  // End to end: a pinned module passes and an unpinned sibling is a violation, with
  // nothing allowlisted to go stale.
  const files = [
    "src/lib/git/queries/pr-write.ts",
    "src/lib/git/queries/branches.ts",
  ];
  const views = new Map([
    ["src/lib/git/queries/pr-write.ts", view(pinned)],
    [
      "src/lib/git/queries/branches.ts",
      view(
        "export function useCreateBranch(repo: string) {\n  return useRepoMutation(repo, (n: string) => api.gitCreateBranch(repo, n));\n}",
      ),
    ],
  ]);
  const { violations, stale } = runCheck(check, files, views);
  assert.deepEqual(violations, ["src/lib/git/queries/branches.ts:2"]);
  assert.deepEqual(stale, []);
});

test("splitTopLevel nests generics in a parameter list only", () => {
  // A comma inside `Promise<Record<string, unknown>>` is not a parameter break,
  // and the `>` of the arrow before it is not a close.
  assert.deepEqual(
    splitTopLevel(
      "repo: string, f: () => Promise<Record<string, unknown>>, key?: K",
      { params: true },
    ),
    ["repo: string", "f: () => Promise<Record<string, unknown>>", "key?: K"],
  );
  assert.equal(splitTopLevel("repo, fn, key").length, 3);
  // Argument lists keep bracket-only counting: `<`/`>` there are comparisons.
  assert.equal(splitTopLevel("a < b, c > d").length, 2);
});

test("mutation-identity-pinning reads a generic-carrying parameter list right", () => {
  // The conditionally-keyed wrapper's key parameter sits after a generic with a
  // comma in it; over-counting that list raised the required index, so a call
  // that DOES pass the key read as unpinned.
  const mod = (call) =>
    [
      "function useLocalMutation<K>(",
      "  repo: string,",
      "  f: () => Promise<Record<string, unknown>>,",
      "  key?: K,",
      ") {",
      "  return useMutation({",
      "    ...(key ? { mutationKey: key } : {}),",
      "    mutationFn: f,",
      "  });",
      "}",
      "",
      "export function useCreateLocalThing(repo: string) {",
      `  return ${call};`,
      "}",
    ].join("\n");
  assert.deepEqual(
    unpinnedMutationIdentity(
      mod('useLocalMutation(repo, fn, ["local", "create", repo])'),
    ),
    [],
  );
  assert.deepEqual(
    unpinnedMutationIdentity(mod("useLocalMutation(repo, fn)")),
    [13],
  );
});

/** The settle-cache-write scanner, resolved per call so a missing check fails
 *  its own tests instead of the whole file at load. */
const settleCacheWrite = (source) =>
  scanner("settle-cache-write-identity")(source);

test("settle-cache-write-identity flags a settle write keyed from hook scope", () => {
  // A bare `repo` in a success seed: hook scope, which names the right repo only
  // while the settle runs on the options in effect at the start; the context
  // keeps the key on the mutation's own state either way.
  const bareRepo = [
    "export function useUpdateGlRepoSettings(repo: string) {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn: (input: Input) => api.update(repo, input),",
    "    onSuccess: (data) =>",
    "      queryClient.setQueryData(glRepoSettingsKey(repo), data),",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(settleCacheWrite(bareRepo), [6]);
  // A key declared in the hook body, rolled back from onError — the useSetRepoStar
  // shape. The onMutate write on the same key runs at mutate time and is clean.
  const hookScopeKey = [
    "export function useSetRepoStar(repo: string) {",
    "  const queryClient = useQueryClient();",
    '  const key = ["repo", repo, "star-status"] as const;',
    "  return useMutation({",
    "    mutationFn: (starred: boolean) => api.setStar(repo, starred),",
    "    onMutate: async (starred: boolean) => {",
    "      await queryClient.cancelQueries({ queryKey: key });",
    "      const previous = queryClient.getQueryData<boolean>(key);",
    "      queryClient.setQueryData<boolean>(key, starred);",
    "      return { previous };",
    "    },",
    "    onError: (_e, _starred, ctx) => {",
    "      if (ctx) queryClient.setQueryData(key, ctx.previous);",
    "    },",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(settleCacheWrite(hookScopeKey), [13]);
  // A local built from hook scope inside the callback carries the same closure.
  const taintedLocal = [
    "export function useJiraComment(repo: string, link: JiraLink | null) {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn: (args: { issueKey: string }) => api.comment(args),",
    "    onSuccess: (comment, args) => {",
    "      if (!link) return;",
    "      const key = jiraIssueDetailKey(repo, link.siteHost, args.issueKey);",
    "      queryClient.setQueryData<JiraIssueDetails>(key, (d) => d);",
    "    },",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(settleCacheWrite(taintedLocal), [8]);
  // A value-typed hook parameter is hook scope too (an entity number, a kind);
  // `setQueriesData`, a `function` value and an `onSettled` all count.
  const hookParam = [
    "export function useEditItemProjects(repo: string, kind: Kind, number: number) {",
    "  const queryClient = useQueryClient();",
    "  return useMutation({",
    "    mutationFn: (a: Args) => api.edit(repo, a),",
    "    onSettled: function (_d, _e, _a, ctx) {",
    "      queryClient.setQueriesData(",
    "        { queryKey: itemProjectsKey(ctx.repo, kind, number) },",
    "        undefined,",
    "      );",
    "    },",
    "  });",
    "}",
  ].join("\n");
  assert.deepEqual(settleCacheWrite(hookParam), [6]);
});

test("settle-cache-write-identity accepts keys fixed at mutate time", () => {
  for (const source of [
    // The ctx-keyed rollback useOptimisticCacheMutation does.
    "export function useX(repo: string) {\n  return useMutation({\n    onMutate: async (a) => {\n      const key = k(repo, a);\n      return { prev: undefined, key };\n    },\n    onError: (_e, _a, ctx) => {\n      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);\n    },\n  });\n}",
    // Built from the callback's own parameters, inline or through a function-typed
    // hook parameter (useTimeTrackingMutation's statsKey).
    "function useTimeTracking(\n  repo: string,\n  statsKey: (repo: string, n: number) => readonly unknown[],\n) {\n  return useMutation({\n    onMutate: () => ({ repo }),\n    onSuccess: (stats, args, ctx) => {\n      queryClient.setQueryData(statsKey(ctx.repo, args.number), stats);\n    },\n  });\n}",
    // A local built inside the callback from its parameters.
    "export function useX(repo: string) {\n  return useMutation({\n    onSuccess: (comment, args, context) => {\n      const key = detailKey(context.repo, args.issueKey);\n      queryClient.setQueryData(key, comment);\n    },\n  });\n}",
    // The write target rides the variables (useStarRepo's shape), including a
    // destructured `repo` that shadows nothing in hook scope.
    "export function useStarRepo() {\n  return useMutation({\n    onError: (_e, args, ctx) => queryClient.setQueryData(starredKey(args.repo), ctx.prev),\n  });\n}",
    "export function useX(repo: string) {\n  return useMutation({\n    onSuccess: (data, { repo }) => queryClient.setQueryData(settingsKey(repo), data),\n  });\n}",
    // A key with no identity component at all.
    'export function useX(repo: string) {\n  return useMutation({\n    onSuccess: (data) => queryClient.setQueryData(["forge-repos", "github"], data),\n  });\n}',
    // onMutate is mutate time: a hook-scope key there is the CAPTURE, not a defect.
    "export function useX(repo: string) {\n  const key = k(repo);\n  return useMutation({\n    onMutate: () => {\n      queryClient.setQueryData(key, 1);\n      return { key };\n    },\n  });\n}",
    // Comment stripping keeps the rule's own prose out of the scan.
    "// onSuccess: (d) => queryClient.setQueryData(settingsKey(repo), d)",
  ])
    assert.deepEqual(settleCacheWrite(source), [], `should accept ${source}`);
});

test("settle-cache-write-identity stops at its documented blind spots", () => {
  // Pinned so widening the rule fails HERE: a write through a helper (the
  // landRealStatus shape) and a callback passed by name both read clean.
  for (const source of [
    "export function useT(repo: string, link: JiraLink) {\n  return useMutation({\n    onSuccess: (r, args) => landRealStatus(queryClient, repo, link, args.issueKey),\n  });\n}",
    "export function useT(repo: string) {\n  const onSuccess = (d) => queryClient.setQueryData(k(repo), d);\n  return useMutation({ onSuccess });\n}",
  ])
    assert.deepEqual(settleCacheWrite(source), [], `blind spot: ${source}`);
});

test("settle-cache-write-identity sees the shapes a narrow anchor would miss", () => {
  const cases = [
    // Method shorthand is a settle callback too.
    [
      "export function useX(repo: string) {\n  return useMutation({\n    onSuccess(d) {\n      queryClient.setQueryData(k(repo), d);\n    },\n  });\n}",
      [4],
    ],
    // Declared bare, then assigned from hook scope.
    [
      "export function useX(repo: string) {\n  return useMutation({\n    onSuccess: (d) => {\n      let key;\n      key = k(repo);\n      queryClient.setQueryData(key, d);\n    },\n  });\n}",
      [6],
    ],
    // Taint is sticky: a later clean assignment does not launder an earlier write.
    [
      "export function useX(repo: string) {\n  return useMutation({\n    onSuccess: (d, _a, ctx) => {\n      let key = k(repo);\n      queryClient.setQueryData(key, d);\n      key = ctx.key;\n    },\n  });\n}",
      [5],
    ],
    // A loop variable over a hook-scope list carries that list's identity.
    [
      "export function useX(repo: string) {\n  const hookKeys = [k(repo)];\n  return useMutation({\n    onError: () => {\n      for (const key of hookKeys) queryClient.setQueryData(key, undefined);\n    },\n  });\n}",
      [5],
    ],
    // A hook spelled as an arrow const has a hook scope like a declared one.
    [
      "export const useX = (r: string) => {\n  const key = k(r);\n  return useMutation({\n    onSuccess: (d) => queryClient.setQueryData(key, d),\n  });\n};",
      [4],
    ],
    // A parameter is skipped only when its TOP-LEVEL type is a function.
    [
      "export function useX(opts: { key: QueryKey; onDone?: () => void }) {\n  return useMutation({\n    onSuccess: (d) => queryClient.setQueryData(opts.key, d),\n  });\n}",
      [3],
    ],
    // Every enclosing function's scope counts, not just the innermost.
    [
      "export function useX(repo: string) {\n  const key = k(repo);\n  function build() {\n    return { onSuccess: (d) => queryClient.setQueryData(key, d) };\n  }\n  return useMutation(build());\n}",
      [4],
    ],
    // A CALL of a callback named onSuccess is not a method definition.
    [
      "export function useX(repo: string) {\n  opts.onSuccess(queryClient.setQueryData(k(repo), 1));\n}",
      [],
    ],
  ];
  for (const [source, expected] of cases)
    assert.deepEqual(settleCacheWrite(source), expected, source);
});

test("settle-cache-write-identity is scoped like mutation-identity-pinning, with no allowlist", () => {
  const check = CHECKS.find((c) => c.name === "settle-cache-write-identity");
  assert.ok(check, "no settle-cache-write-identity check");
  const pinning = CHECKS.find((c) => c.name === "mutation-identity-pinning");
  // Directly after the pinning check, over the same modules and the same floor.
  assert.equal(CHECKS.indexOf(check), CHECKS.indexOf(pinning) + 1);
  assert.deepEqual(check.expectScanned, pinning.expectScanned);
  for (const file of [
    "src/lib/git/queries/branches.ts",
    "src/lib/git/queries/internal.ts",
    "src/lib/jira/queries.ts",
    "src/lib/pulls/queries.ts",
    "src/lib/issues/queries.ts",
  ])
    assert.equal(check.appliesTo(file), true, file);
  for (const file of [
    "src/lib/pulls/local.ts",
    "src/features/pulls/CreatePrDialog.tsx",
    "src/lib/settings/queries.ts",
  ])
    assert.equal(check.appliesTo(file), false, file);
  assert.deepEqual(check.allowlist, []);
  const fixed =
    "export function useSetRepoStar(repo: string) {\n  return useMutation({\n    onMutate: () => ({ key: k(repo) }),\n    onError: (_e, _s, ctx) => queryClient.setQueryData(ctx.key, false),\n  });\n}";
  const unfixed =
    "export function useUpdateRepoSettings(repo: string) {\n  return useMutation({\n    onSuccess: (data) => queryClient.setQueryData(repoSettingsKey(repo), data),\n  });\n}";
  const files = [
    "src/lib/git/queries/repo-access.ts",
    "src/lib/git/queries/repo-settings.ts",
  ];
  const views = new Map([
    ["src/lib/git/queries/repo-access.ts", view(fixed)],
    ["src/lib/git/queries/repo-settings.ts", view(unfixed)],
  ]);
  const { violations, stale } = runCheck(check, files, views);
  assert.deepEqual(violations, ["src/lib/git/queries/repo-settings.ts:3"]);
  assert.deepEqual(stale, []);
});

test("raw-react-query-mutation flags every value route to react-query's constructors", () => {
  const RQ = '"@tanstack/react-query"';
  const cases = {
    "a named import": `import { useMutation, useQuery } from ${RQ};`,
    "a wrapped named import": `import {\n  type QueryKey,\n  useMutation,\n} from ${RQ};`,
    "an aliased import": `import { useMutation as useM } from ${RQ};`,
    "a string-named alias": `import { "useMutation" as useM } from ${RQ};`,
    "a MutationObserver value import": `import { MutationObserver } from ${RQ};`,
    "a value beside an inline type": `import { type UseMutationResult, useMutation } from ${RQ};`,
    "the core package":
      'import { MutationObserver } from "@tanstack/query-core";',
    "a subpath": `import { useMutation } from "@tanstack/react-query/build/modern/useMutation.js";`,
    "a re-export": `export { useMutation } from ${RQ};`,
    "an aliased re-export": `export { MutationObserver as Observer } from ${RQ};`,
    "an export star": `export * from ${RQ};`,
    "a namespace re-export": `export * as rq from ${RQ};`,
    "a dynamic import": `const rq = await import(${RQ});`,
    "a MutationCache value import": `import { MutationCache } from ${RQ};`,
    "a Mutation value import":
      'import { Mutation } from "@tanstack/query-core";',
    "a hydrate import": `import { hydrate } from ${RQ};`,
    "a HydrationBoundary import": `import { HydrationBoundary } from ${RQ};`,
    "a namespace import": `import * as rq from ${RQ};`,
    "a namespace beside names": `import * as rq, { useQuery } from ${RQ};`,
    "a default import": `import rq from ${RQ};`,
    "a default beside names": `import rq, { useQuery } from ${RQ};`,
    "a route through node_modules":
      'import { useMutation } from "../../node_modules/@tanstack/react-query";',
    "a pnpm store path":
      'import { MutationObserver } from "../node_modules/.pnpm/@tanstack+query-core@5.104.1/node_modules/@tanstack/query-core/build/modern/index.js";',
    "a whitespace-free import":
      'import{useMutation}from"@tanstack/react-query";',
    "a whitespace-free namespace": 'import*as rq from"@tanstack/react-query";',
    "a whitespace-free export star": 'export*from"@tanstack/react-query";',
    "an escaped name": `import { useMut\\u0061tion } from ${RQ};`,
    "a braced escape": `import { useMut\\u{61}tion as m } from ${RQ};`,
    // A `default` entry is a default import or re-export.
    "a braced default import": `import { default as rq } from ${RQ};`,
    "a quoted braced default": `import { "default" as rq } from ${RQ};`,
    "a default re-export": `export { default } from ${RQ};`,
    "an aliased default re-export": `export { default as rq } from ${RQ};`,
    // Unicode names, escaped or not.
    "a Unicode default import":
      'import é from "@tanstack/react-query/build/legacy/index.cjs";',
    "an escaped Unicode default": `import \\u00e9 from ${RQ};`,
    // Specifiers read as JS string values, case-folded, `\\` as `/`.
    "an identity-escaped specifier":
      'import { useMutation } from "\\@tanstack/react-query";',
    "a hex-escaped specifier":
      'import { useMutation } from "\\x40tanstack/react-query";',
    "a Unicode-escaped specifier":
      'import { useMutation } from "\\u0040tanstack/react-query";',
    "a case-folded specifier":
      'import { useMutation } from "@TanStack/React-Query";',
    "a backslash path":
      'import { useMutation } from "..\\\\node_modules\\\\@tanstack\\\\react-query";',
    "a continued specifier":
      'import { useMutation } from "@tanstack/re\\\nact-query";',
    // Module calls.
    "a concatenated dynamic import":
      'const m = await import("@tanstack/" + "react-query");',
    "a templated dynamic import":
      "const m = await import(`@tanstack/${name}`);",
    "a parenthesized dynamic import":
      'const m = await import(("@tanstack/react-query"));',
    "a dynamic import with options":
      'const m = await import("@tanstack/query-core", { with: {} });',
    "a require": 'const rq = require("@tanstack/react-query");',
    "a TS import-equals require": `import rq = require(${RQ});`,
    "a glob":
      'const m = import.meta.glob("/node_modules/@tanstack/react-query/**");',
    "a glob list":
      'const m = import.meta.glob(["./a/*.ts", "/node_modules/@tanstack/query-core/**"]);',
    "a generic glob":
      'const m = import.meta.glob<Mod>("/node_modules/@tanstack/react-query/**");',
    "a glob over the package segment":
      'const m = import.meta.glob("/node_modules/@tanstack/*/build/**");',
    "a glob brace set":
      'const m = import.meta.glob("@tanstack/{react-query,x}/**");',
    "a glob through any node_modules":
      'const m = import.meta.glob("/node_modules/**/useMutation.js");',
    "a glob over the pnpm store":
      'const m = import.meta.glob("/node_modules/.pnpm/@tanstack+query-core*/**");',
    "a string-named alias with no space": `import {"useMutation"as m} from ${RQ};`,
    "a dynamic import in a ternary":
      'const m = flag ? await import("@tanstack/react-query") : null;',
    "a local template head naming the package":
      "const m = await import(`./${dir}/@tanstack/react-query`);",
  };
  for (const [name, source] of Object.entries(cases))
    assert.deepEqual(rawReactQueryMutation(source), [1], name);
  // A namespace import fails at the import, whatever later reads it: spreading
  // or passing it on reaches the constructors through no member name at all.
  const ns = `import * as rq from ${RQ};`;
  for (const [name, use] of Object.entries({
    "a namespace call": "const m = rq.useMutation({ mutationFn });",
    "a namespace spread": "const { useMutation: m } = { ...rq };",
    "a namespace read of another member": "const c = rq.useQueryClient();",
  }))
    assert.deepEqual(rawReactQueryMutation(`${ns}\n${use}`), [1], name);
  // A variable holding a react-query specifier fails at the call that reads it.
  assert.deepEqual(
    rawReactQueryMutation(
      'const p = "@tanstack/react-query";\nconst m = await import(p);',
    ),
    [2],
  );
});

test("raw-react-query-mutation leaves types, other hooks and the DOM's observer alone", () => {
  const RQ = '"@tanstack/react-query"';
  for (const [name, source] of Object.entries({
    "a type-only import": `import type { MutationObserver, UseMutationResult } from ${RQ};`,
    "inline type specifiers": `import { type MutationObserver, useQuery } from ${RQ};`,
    "an inline type MutationCache": `import { type MutationCache, useQuery } from ${RQ};`,
    "a type-only namespace": `import type * as rq from ${RQ};\ntype O = rq.MutationObserver;`,
    "a whitespace-free type import":
      'import type{QueryKey}from"@tanstack/react-query";',
    "a type-only re-export": `export type { UseMutationOptions } from ${RQ};`,
    "the mutation-state hooks": `import { useIsMutating, useMutationState } from ${RQ};`,
    "a DOM MutationObserver": "const mo = new MutationObserver(() => {});",
    "the helper's export":
      'import { useMutation } from "@/lib/started-mutation";\nuseMutation({ mutationFn });',
    "a cache read": "const all = queryClient.getMutationCache().getAll();",
    "a commented import": `// import { useMutation } from ${RQ};`,
    "a lookalike package":
      'import { useMutation } from "@tanstack/react-query-devtools-x";',
    "a local dynamic import": 'const m = await import(("./local"));',
    "a templated local import":
      "const m = await import(`./locale/${lang}.json`);",
    "a local glob": 'const pages = import.meta.glob("./pages/*.tsx");',
    "a local require": 'const x = require("./local");',
  }))
    assert.deepEqual(rawReactQueryMutation(source), [], name);
  // In a file that does hold a react-query string, a method named `import` or
  // `require`, prose, and a local template head still aren't module calls.
  const HELD = 'const pkg = "@tanstack/react-query";\n';
  for (const [name, source] of Object.entries({
    "a method named import":
      "class Importer { import(path: string) { return path; } }",
    "an object method named import": "const o = { import(x) { return x; } };",
    "a method named require":
      "class Policy { require(flag: string) { return flag; } }",
    "a typed async method named import":
      "class I { async import(p: string): Promise<void> {} }",
    "prose in JSX":
      "const e = <p>Pushing will require (re)authentication.</p>;",
    "prose in a string":
      'const s = "This will require (at least) one reviewer";',
    "a local template head":
      "const m = await import(`./locales/${lang}.json`);",
  }))
    assert.deepEqual(rawReactQueryMutation(HELD + source), [], name);
  // A file's own react-query import is judged by its own arm, so it doesn't
  // make the file's non-literal module calls read as a reach.
  const RQ_IMPORT = `import { useQuery } from ${RQ};\n`;
  for (const [name, call] of Object.entries({
    "a local template": "const m = await import(`./locales/${lang}.json`);",
    "an aliased template":
      "const m = await import(`@/features/${name}/index.ts`);",
    "a variable path": "const m = await import(path);",
  }))
    assert.deepEqual(rawReactQueryMutation(RQ_IMPORT + call), [], name);
  assert.deepEqual(
    rawReactQueryMutation(
      `import type { QueryKey } from ${RQ};\nconst m = await import(path);`,
    ),
    [],
  );
});

test("raw-react-query-mutation judges a plain module literal by its exact package", () => {
  // Other TanStack packages this app depends on, and a local path naming the
  // word: each passes as a plain literal, with or without a react-query string
  // elsewhere in its file.
  const passes = [
    'const m = await import("@tanstack/react-virtual");',
    'const m = await import("@tanstack/react-form");',
    'const m = await import("@tanstack/react-store");',
    'const m = await import("./tanstack-adapter");',
    'const m = require("@tanstack/react-virtual");',
    'const m = require("@tanstack/react-form");',
    'const m = require("@tanstack/react-store");',
  ];
  const held =
    'import { useQuery } from "@tanstack/react-query";\nconst pkg = "@tanstack/react-query";\n';
  for (const prefix of ["", held])
    for (const call of passes)
      assert.deepEqual(
        rawReactQueryMutation(prefix + call),
        [],
        `${prefix ? "held: " : ""}${call}`,
      );
  for (const call of [
    'const m = await import("@tanstack/react-query");',
    "const m = await import(`@tanstack/${p}`);",
    'const m = await import("@tanstack/" + "react-query");',
    'const m = await import(("@tanstack/react-query"));',
  ])
    assert.deepEqual(rawReactQueryMutation(call), [1], call);
});

test("raw-react-query-mutation exempts the helper alone, and its pin notices a rename", () => {
  const check = CHECKS.find((c) => c.name === "raw-react-query-mutation");
  const helper = "src/lib/started-mutation.ts";
  assert.equal(check.appliesTo(helper), false);
  for (const file of [
    "src/lib/git/queries/internal.ts",
    "src/features/repository/BranchSwitcher.tsx",
    "src/components/ui/button.tsx",
    "src/lib/started-mutation.test.ts",
  ])
    assert.equal(check.appliesTo(file), true, file);
  assert.deepEqual(check.allowlist, []);
  assert.ok(check.expectScanned.atLeast >= 500);
  // The exemption is what passes the helper: its own source reads as a raw
  // construction, so a copy anywhere else would flag.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const helperView = view(readFileSync(join(root, helper), "utf8"));
  assert.notDeepEqual(check.scan(helperView), []);
  const views = new Map([
    [helper, helperView],
    ["src/lib/copy.ts", helperView],
  ]);
  const { violations } = runCheck(check, [helper, "src/lib/copy.ts"], views);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^src\/lib\/copy\.ts:\d+$/);

  const present = CHECKS.find((c) => c.name === "started-mutation-present");
  assert.equal(present.appliesTo(helper), true);
  assert.equal(present.appliesTo("src/lib/git/queries/internal.ts"), false);
  assert.deepEqual(present.scan(helperView), []);
  assert.equal(scopePinFailure(present, 1), null);
  const renamed = scopePinFailure(present, 0);
  assert.match(renamed, /SCOPE PIN FAILED/);
  assert.match(renamed, /src\/lib\/started-mutation\.ts/);
});

test("mutation-cache-access passes only a call followed by a read", () => {
  const cacheAccess = scanner("mutation-cache-access");
  for (const [name, source] of Object.entries({
    "a build": "queryClient.getMutationCache().build(queryClient, options);",
    "an optional build": "queryClient.getMutationCache()?.build(qc, o);",
    "a quoted build": 'queryClient.getMutationCache()["build"](qc, o);',
    "a template build": "queryClient.getMutationCache()[`build`](qc, o);",
    "an optional call": "queryClient.getMutationCache?.().build(qc, o);",
    "an asserted call": "queryClient.getMutationCache()!.build(qc, o);",
    "a parenthesized method": "(queryClient.getMutationCache)().build(qc, o);",
    "a generic call":
      "queryClient.getMutationCache<MutationCache>().build(qc, o);",
    "a prototype reach":
      "QueryClient.prototype.getMutationCache.call(qc).build(qc, o);",
    "a held reference": "const cache = queryClient.getMutationCache();",
    "a quoted method": 'queryClient["getMutationCache"]().findAll();',
    "a destructured method": "const { getMutationCache } = queryClient;",
    "a read member not called":
      "const f = queryClient.getMutationCache().getAll;",
    "an escaped method": "queryClient.getMutation\\u0043ache().build(qc, o);",
    "an internal remove": "queryClient.getMutationCache().remove(mutation);",
    "an internal resume":
      "queryClient.getMutationCache().resumePausedMutations();",
    "the holder statement outside its file":
      "const cache = useQueryClient().getMutationCache();",
  }))
    assert.deepEqual(cacheAccess(source), [1], name);
  for (const [name, source] of Object.entries({
    getAll: "const all = queryClient.getMutationCache().getAll();",
    find: "queryClient.getMutationCache().find({ mutationKey });",
    findAll: "queryClient.getMutationCache().findAll({ status });",
    "an optional findAll": "queryClient.getMutationCache()?.findAll({});",
    subscribe: "queryClient.getMutationCache().subscribe(() => {});",
    clear: "queryClient.getMutationCache().clear();",
    "a wrapped chain":
      "queryClient\n  .getMutationCache()\n  .subscribe(() => push());",
    "a generic find":
      "qc.getMutationCache().find<Data, Error, Vars>({ mutationKey });",
    hasListeners: "const busy = qc.getMutationCache().hasListeners();",
  }))
    assert.deepEqual(cacheAccess(source), [], name);
  // The holder's exemption is its exact statement, once, in its own file: the
  // real file passes by that statement alone, and any other reach added there
  // still fails.
  const check = CHECKS.find((c) => c.name === "mutation-cache-access");
  assert.deepEqual(check.allowlist, []);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const internal = "src/lib/git/queries/internal.ts";
  const source = readFileSync(join(root, internal), "utf8");
  const holder = "const cache = useQueryClient().getMutationCache();";
  assert.equal(source.split(holder).length, 2, "the holder statement moved");
  const run = (text) =>
    runCheck(check, [internal], new Map([[internal, view(text)]])).violations;
  assert.notDeepEqual(check.scan(view(source)), []);
  assert.deepEqual(run(source), []);
  const grown = `${source}\nexport function useRawBuild() { const qc = useQueryClient(); return qc.getMutationCache().build(qc, { mutationFn: save }); }\n`;
  assert.equal(run(grown).length, 1);
  assert.equal(run(`${source}\n${holder}\n`).length, 1);
  assert.ok(check.expectScanned.atLeast >= 500);
});

test("unscannedScripts names every src/ script the walk can't read", () => {
  assert.deepEqual(
    unscannedScripts([
      "src/a.ts",
      "src/b.mjs",
      "src/c.cjs",
      "src/d.d.ts",
      "src/e.tsx",
      "src/f.jsx",
      "src/g.mts",
      "src/h.cts",
      "src/i.js",
      "src/j.css",
      "src/k.JS",
      "src/l.TSX",
      "src/m.Ts",
      "src/n.tsX",
    ]),
    [
      "src/b.mjs",
      "src/c.cjs",
      "src/f.jsx",
      "src/g.mts",
      "src/h.cts",
      "src/i.js",
      "src/k.JS",
      "src/l.TSX",
      "src/m.Ts",
      "src/n.tsX",
    ],
  );
  assert.deepEqual(unscannedScripts(["src/b.mjs"], ["src/b.mjs"]), []);
});

test("cookStringBody reads a string literal as JS does", () => {
  assert.equal(cookStringBody("\\x40tanstack"), "@tanstack");
  assert.equal(cookStringBody("\\@tanstack"), "@tanstack");
  assert.equal(cookStringBody("re\\ act"), "react");
  assert.equal(cookStringBody("a\\nb"), "a\nb");
  assert.equal(cookStringBody("\\u{1F600}"), "\u{1F600}");
  assert.equal(cookStringBody("set\\Mutation"), "setMutation");
});

test("cookSource cooks what keeps the lexical shape, and maps back to the source", () => {
  const source = "a\\u0062c \"\\u0022\" \\x41 \\u{1F600} 'set\\Mut'";
  const { text, at } = cookSource(source);
  assert.equal(text, "abc \"\\u0022\" A \\u{1F600} 'setMut'");
  assert.equal(at.length, text.length);
  assert.equal(source[at[text.indexOf("A")]], "\\");
  assert.equal(at[text.indexOf("c")], source.indexOf("c"));
  // Outside a string, only a name escape decodes: a regex keeps its own.
  assert.equal(cookSource("/\\d+/").text, "/\\d+/");
});

test("mutation-defaults flags every way to give mutations a client default", () => {
  const mutationDefaults = scanner("mutation-defaults");
  for (const [name, source] of Object.entries({
    // The client's defaults API, in any spelling or reach.
    "a keyed default":
      'queryClient.setMutationDefaults(["save"], { mutationFn: save });',
    "a runtime default":
      "queryClient.setDefaultOptions({ mutations: { retry: 1 } });",
    "a runtime query default":
      "queryClient.setDefaultOptions({ queries: {} });",
    "a non-literal runtime default": "queryClient.setDefaultOptions(opts);",
    "a member runtime default":
      "queryClient.setDefaultOptions(cfg.defaultOptions);",
    "a cast runtime default":
      "queryClient.setDefaultOptions(opts as DefaultOptions);",
    "a quoted member call":
      'queryClient["setMutationDefaults"](["save"], { mutationFn: save });',
    "a quoted runtime default":
      'queryClient["setDefaultOptions"]({ mutations });',
    "an identity-escaped member":
      "queryClient['setMutation\\Defaults'](key, o);",
    "a continued member": "queryClient['setMutation\\\nDefaults'](key, o);",
    "an optional call": "queryClient.setDefaultOptions?.({ mutations });",
    "an optional keyed default": "queryClient.setMutationDefaults?.(key, o);",
    "a call through call": "queryClient.setMutationDefaults.call(qc, key, o);",
    "a call through apply": "queryClient.setMutationDefaults.apply(qc, args);",
    "a bound call": "const set = queryClient.setMutationDefaults.bind(qc);",
    "a write to the live defaults":
      "queryClient.getDefaultOptions().mutations = { onError };",
    "a merge into the live defaults":
      "Object.assign(queryClient.getDefaultOptions(), { mutations });",
    "a defaults read": 'const d = queryClient.getMutationDefaults(["save"]);',
    "an escaped API name":
      "queryClient.setDefault\\u004Fptions({ mutations });",
    "a merge-point override":
      "class C extends QueryClient { defaultMutationOptions(o) { return o; } }",
    "a merge-point patch": "qc.defaultMutationOptions = (o) => o;",
    // Defaults literals holding anything but a bare `queries` entry.
    "a mutations entry":
      "new QueryClient({ defaultOptions: { mutations: { onError } } });",
    "a double-quoted mutations key":
      'new QueryClient({ defaultOptions: { "mutations": { onError } } });',
    "a single-quoted mutations key":
      "new QueryClient({ defaultOptions: { 'mutations': { onError } } });",
    "a computed mutations key":
      'new QueryClient({ defaultOptions: { ["mutations"]: { onError } } });',
    "a computed variable key":
      "new QueryClient({ defaultOptions: { [K]: { onError } } });",
    "a computed template key":
      "new QueryClient({ defaultOptions: { [`mutations`]: { onError } } });",
    "an escaped mutations key":
      "new QueryClient({ defaultOptions: { mut\\u0061tions: { onError } } });",
    "a shorthand entry":
      "const c = { defaultOptions: { queries, mutations } };",
    "a method entry":
      "const c = { defaultOptions: { mutations() { return {}; } } };",
    "a spread": "new QueryClient({ defaultOptions: { ...base } });",
    "a brace inside a string":
      'new QueryClient({ defaultOptions: { queries: { meta: { note: "}" } }, mutations: { onError } } });',
    // A defaults literal read or assigned past its close.
    "a literal's constructor":
      "new QueryClient({ defaultOptions: { queries: {} }.constructor({ mutations }) });",
    "a literal member read":
      "new QueryClient({ defaultOptions: { queries: { mutations } }.queries });",
    "a literal index":
      "new QueryClient({ defaultOptions: { queries: {} }['queries'] });",
    // `defaultOptions` anywhere a value can't be proven harmless.
    "an unreadable value": "new QueryClient({ defaultOptions: base });",
    "a shorthand defaults key": "new QueryClient({ defaultOptions });",
    "a shorthand among others":
      "const config = { queryCache, defaultOptions, logger };",
    "a defaults binding": "const defaultOptions = { mutations: { retry: 0 } };",
    "an unreadable binding": "const defaultOptions = makeDefaults();",
    "a binding to a name": "const defaultOptions = base;",
    "a cast binding": "const defaultOptions = base as DefaultOptions;",
    "an annotated query-only binding":
      "const defaultOptions: DefaultOptions = { queries: { retry: 1 } };",
    "a double-quoted key":
      'new QueryClient({ "defaultOptions": { mutations: {} } });',
    "a single-quoted unreadable key": "const c = { 'defaultOptions': base };",
    "an identity-escaped key":
      "const c = { 'default\\Options': { mutations } };",
    "an escaped key":
      "new QueryClient({ defaultOpti\\u006fns: { mutations: {} } });",
    "a parameter default":
      "function make(defaultOptions: T = { mutations: { onError } }) {}",
    "a plain parameter default":
      "function make(defaultOptions: DefaultOptions = {}) {}",
    "an annotated class field":
      "class C { defaultOptions: T = { mutations: { onError } }; }",
    "an unannotated class field":
      "class C { defaultOptions = { mutations: { onError } }; }",
    "an optional field with an initializer":
      "class Cfg { defaultOptions?: DefaultOptions = { mutations: { onError } } }",
    "a type-literal annotation with an initializer":
      "class Cfg { defaultOptions: { queries: Q } = { mutations: { onError } }; }",
    "a regex value ending like a parameter":
      "const c = { defaultOptions: /a)/ };",
    "a regex value ending like a member": "const c = { defaultOptions: /a;/ };",
    "a getter": "const c = { get defaultOptions() { return { mutations } } };",
    "a method": "const c = { defaultOptions() { return { mutations }; } };",
    "a member write": "cfg.defaultOptions = { mutations };",
    "a member read": "const o = queryClient.defaultOptions;",
    "a destructuring rename": "const { defaultOptions: opts } = config;",
    "a shorthand destructure": "const { queryCache, defaultOptions } = config;",
    "a mention in a message": 'toast.info("defaultOptions changed");',
    // Documented fail-closed: an annotated parameter followed by another one
    // can't be told from an object entry.
    "an annotated parameter before another":
      "function make(defaultOptions: DefaultOptions, n: number) {}",
  }))
    assert.deepEqual(mutationDefaults(source), [1], name);
  // Wrapped across lines, it reports the line the mention starts on.
  assert.deepEqual(
    mutationDefaults(
      "new QueryClient({\n  defaultOptions: {\n    queries: { retry: 1 },\n    mutations: { retry: 0 },\n  },\n});",
    ),
    [2],
  );
});

test("mutation-defaults passes query defaults and type positions only", () => {
  const check = CHECKS.find((c) => c.name === "mutation-defaults");
  for (const [name, source] of Object.entries({
    "query defaults":
      "new QueryClient({\n  defaultOptions: {\n    queries: {\n      retry: 1,\n      refetchOnWindowFocus: true,\n    },\n  },\n});",
    "empty defaults": "new QueryClient({ defaultOptions: {} });",
    "a quoted key holding queries":
      'new QueryClient({ "defaultOptions": { queries: {} } });',
    "a shorthand queries entry":
      "new QueryClient({ defaultOptions: { queries } });",
    "an escaped queries key":
      "new QueryClient({ defaultOptions: { qu\\u0065ries: {} } });",
    "a brace inside a query string":
      'new QueryClient({ defaultOptions: { queries: { meta: { note: "}, mutations: {" } } } });',
    "a const assertion":
      "new QueryClient({ defaultOptions: { queries: {} } as const });",
    "a satisfies clause":
      "new QueryClient({ defaultOptions: { queries: {} } satisfies DefaultOptions });",
    "an unrelated name": "const mutations = [];\nmutations.push(1);",
    "a comment": "// queryClient.setMutationDefaults(key, opts)",
    "a type member": "interface Config {\n  defaultOptions: DefaultOptions;\n}",
    "an optional type member":
      "type Config = { defaultOptions?: DefaultOptions };",
    "an optional member before another":
      "type Config = { defaultOptions?: DefaultOptions, n: number };",
    "a readonly optional member":
      "interface Config { readonly defaultOptions?: DefaultOptions; }",
    "a private readonly field":
      "class C { private readonly defaultOptions: DefaultOptions; }",
    "an accessor field": "class C { accessor defaultOptions: DefaultOptions; }",
    "a protected abstract field":
      "abstract class C { protected abstract defaultOptions: DefaultOptions; }",
    "a generic type member":
      "interface Config {\n  defaultOptions: Partial<Record<string, DefaultOptions>>;\n}",
    "a type-literal member":
      "interface Config {\n  defaultOptions: { queries: QueryOptions };\n}",
    "a lone annotated parameter":
      "function make(defaultOptions: DefaultOptions) {}",
    "a last annotated parameter":
      "function make(n: number, defaultOptions: DefaultOptions) {}",
    "an annotated class field":
      "class C {\n  defaultOptions: DefaultOptions;\n}",
  }))
    assert.deepEqual(check.scan(view(source)), [], name);
  // The app's client: its defaults mention exists and reads as harmless, so the
  // real tree passes by proof rather than by the scan finding nothing.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const client = readFileSync(join(root, "src/lib/query-client.ts"), "utf8");
  assert.match(client, /\bdefaultOptions\b/);
  assert.deepEqual(check.scan(view(client)), []);
  assert.equal(check.appliesTo("src/lib/query-client.ts"), true);
  assert.equal(check.appliesTo("src/lib/started-mutation.ts"), true);
  assert.deepEqual(check.allowlist, []);
  assert.ok(check.expectScanned.atLeast >= 500);
});

test("an allowlist entry whose file no longer has the pattern is stale", () => {
  // Allowlisted files are scanned, not skipped: a live entry suppresses its hit
  // and stays; an entry with nothing left to suppress is reported so the ratchet
  // can only tighten.
  const check = {
    name: "fixture",
    appliesTo: () => true,
    scan: CHECKS.find((c) => c.name === "hover-reveal").scan,
    allowlist: ["still-reveals.tsx", "now-clean.tsx", "since-deleted.tsx"],
    message: "fixture message",
  };
  const files = ["still-reveals.tsx", "now-clean.tsx", "fresh.tsx"];
  const views = new Map([
    [
      "still-reveals.tsx",
      view('const c = "opacity-0 group-hover:opacity-100";'),
    ],
    ["now-clean.tsx", view('const c = "flex items-center gap-2";')],
    ["fresh.tsx", view('const c = "invisible group-hover:visible";')],
  ]);

  const { violations, stale } = runCheck(check, files, views);
  // The allowlisted hit is suppressed; the unlisted one is not.
  assert.deepEqual(violations, ["fresh.tsx:1"]);
  // Clean-now and no-longer-present entries both surface; the live one does not.
  assert.deepEqual(stale, ["now-clean.tsx", "since-deleted.tsx"]);
});

test("a rust allowlist record no hit maps to is stale, matched as (file, fn)", () => {
  const list = [
    { file: "git/ops.rs", fn: "live_one", rationale: "x" },
    { file: "git/ops.rs", fn: "site_removed", rationale: "x" },
    // Same fn name, different file: the pair must match, not either half.
    { file: "git/remote.rs", fn: "live_one", rationale: "x" },
  ];
  const hits = [
    { file: "git/ops.rs", fn: "live_one", allowlisted: true },
    { file: "git/ops.rs", fn: "unlisted", allowlisted: false },
  ];
  assert.deepEqual(
    staleAllowlistEntries(list, hits).map((e) => `${e.file}::${e.fn}`),
    ["git/ops.rs::site_removed", "git/remote.rs::live_one"],
  );
  // An empty allowlist (SECRET_ARGV_ALLOWLIST today) is a no-op, not a failure.
  assert.deepEqual(staleAllowlistEntries([], hits), []);
});

test("stripComments blanks comments but not comment-shaped strings", () => {
  assert.deepEqual(stripComments(["const a = 1; // e.metaKey"]), [
    "const a = 1; ",
  ]);
  assert.deepEqual(
    stripComments([
      "/* opacity-0",
      "   group-hover:opacity-100 */ const a = 1;",
    ]),
    ["", " const a = 1;"],
  );
  assert.deepEqual(stripComments(['const url = "https://x.dev/a";']), [
    'const url = "https://x.dev/a";',
  ]);
});

// -------------------------------------------------------- check-rust-invariants

function markerBranchHits(src, other = "", corpus = undefined) {
  const hits = [];
  checkTestMarkerBranches(
    "holder.rs",
    src,
    src.split("\n"),
    hits,
    corpus === undefined
      ? [
          { file: "holder.rs", src },
          { file: "victim.rs", src: other },
        ]
      : corpus,
  );
  return hits;
}

const markerHolder = (arg, setup = "TestRootOverride::set(&root);") =>
  `#[cfg(test)] mod tests {
    fn holder() {
      ${setup}
      UpdateMarker::create_for(&root.join("live"), ${arg});
    }
  }`;

test("marker branches flag cross-file and same-file victims", () => {
  const src = markerHolder('"feature"');
  const victim = 'fn victim() { switch("feature"); }';
  for (const hits of [
    markerBranchHits(src, victim),
    markerBranchHits(`${src}\n${victim}`),
  ]) {
    assert.equal(hits.length, 1);
    assert.equal(hits[0].fn, "holder");
    assert.equal(hits[0].allowlisted, false);
    assert.match(hits[0].fix, /unique/);
  }
});

test("marker branches follow one same-file override helper", () => {
  const src = `${markerHolder('"feature"', "holder_marker_root();")}
    fn holder_marker_root() { TestRootOverride::set(&root); }`;
  assert.equal(
    markerBranchHits(src, 'fn victim() { switch("feature"); }').length,
    1,
  );
});

test("marker branches fail closed on unresolved second arguments", () => {
  for (const arg of [
    'format!("branch-{}", id)',
    "parameter",
    "name()",
    '"literal".to_string()',
  ]) {
    const hits = markerBranchHits(markerHolder(arg));
    assert.equal(hits.length, 1, arg);
    assert.match(hits[0].fix, /cannot resolve/);
  }
  // A call that never closes inside its function.
  const unclosed = markerBranchHits(
    '#[cfg(test)] mod tests { fn holder() { TestRootOverride::set(&root); UpdateMarker::create_for(&root, "held" } }',
  );
  assert.equal(unclosed.length, 1);
  assert.match(unclosed[0].fix, /cannot resolve/);
  const unclosedAfterComma = markerBranchHits(
    '#[cfg(test)] mod tests { fn holder() { TestRootOverride::set(&root); UpdateMarker::create_for(&root, "held", } }',
  );
  assert.equal(unclosedAfterComma.length, 1);
  assert.match(unclosedAfterComma[0].fix, /cannot resolve/);
});

test("marker branches fail closed on a test-module site outside any function", () => {
  const hits = markerBranchHits(
    '#[cfg(test)] mod tests { const X: () = UpdateMarker::create_for(&root, "held"); }',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "<unreadable>");
  assert.match(hits[0].fix, /enclosing function/);
});

test("marker branches count comment-only reuse in another file", () => {
  assert.equal(markerBranchHits(markerHolder('"held"'), '// "held"').length, 1);
});

test("marker branches resolve raw literals and reject a nested function's binding", () => {
  assert.deepEqual(markerBranchHits(markerHolder('r#"held"#')), []);
  assert.equal(
    markerBranchHits(markerHolder('r#"held"#'), '// "held"').length,
    1,
  );
  const hits = markerBranchHits(
    markerHolder(
      "branch",
      'TestRootOverride::set(&root); fn nested() { let branch = "private"; }',
    ),
  );
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /cannot resolve/);
});

test("marker branches accept unique direct and bound names with same-function reuse", () => {
  for (const [arg, setup] of [
    ['"held"', 'TestRootOverride::set(&root); switch("held");'],
    [
      "branch",
      'TestRootOverride::set(&root);\n let branch = "held";\n switch(branch);',
    ],
  ]) {
    assert.deepEqual(markerBranchHits(markerHolder(arg, setup)), []);
  }
});

test("marker branch allowlist starts empty", () => {
  assert.deepEqual(TEST_MARKER_ALLOWLIST, []);
});

test("marker branches report an allowlist row stale when its holder is unique", () => {
  const row = {
    file: "holder.rs",
    fn: "holder",
    rationale: "Fixture for a holder whose branch became unique.",
  };
  TEST_MARKER_ALLOWLIST.push(row);
  try {
    const hits = markerBranchHits(markerHolder('"held"'));
    assert.deepEqual(hits, []);
    assert.deepEqual(splitStaleEntries(TEST_MARKER_ALLOWLIST, hits), {
      failing: [row],
      retired: [],
    });
  } finally {
    TEST_MARKER_ALLOWLIST.pop();
  }
});

test("marker branches balance wrapped calls and ignore comment delimiters", () => {
  const src = `#[cfg(test)] mod tests {
    fn holder() {
      TestRootOverride::set(&root);
      // } fn fake() { "held"
      UpdateMarker::create_for(
        &root.join(call("(,)", nested())),
        /* ), } "decoy" */ "held",
      );
    }
  }`;
  assert.deepEqual(markerBranchHits(src), []);
  assert.equal(markerBranchHits(src, '// "held"').length, 1);
});

test("marker branches skip private roots and production sites", () => {
  assert.deepEqual(
    markerBranchHits(markerHolder('"feature"', ""), '// "feature"'),
    [],
  );
  assert.deepEqual(
    markerBranchHits(
      'fn prod() { TestRootOverride::set(&root); UpdateMarker::create_for(&root, "feature"); }',
      '// "feature"',
    ),
    [],
  );
  assert.deepEqual(
    markerBranchHits(
      markerHolder('"feature"', "// TestRootOverride::set(&root);\n"),
      '// "feature"',
    ),
    [],
  );
});

test("marker branches reject empty, absent and unreadable corpora", () => {
  const src = markerHolder('"held"');
  for (const corpus of [
    [],
    null,
    [{ file: "elsewhere.rs", src: "" }],
    [{ file: "holder.rs", src: null }],
    [
      { file: "holder.rs", src },
      { file: "holder.rs", src },
    ],
  ]) {
    const hits = markerBranchHits(src, "", corpus);
    assert.equal(hits.length, 1);
    assert.match(hits[0].fix, /cannot read the Rust corpus/);
  }
});

test("marker branches use current source and normalize CRLF corpus offsets", () => {
  const src = markerHolder('"held"').replace(/\n/g, "\r\n");
  assert.deepEqual(
    markerBranchHits(src, "", [
      { file: "holder.rs", src: '// "held"' },
      { file: "victim.rs", src: "// no marker\r\n" },
    ]),
    [],
  );
});

test("marker branches report unterminated source", () => {
  const hits = markerBranchHits(`${markerHolder('"held"')}\n/*`);
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /closed literals and comments/);
});

function mergeGuardHits(src, file = "fixture.rs", allowlist = undefined) {
  const hits = [];
  checkMergeIgnoredGuard(file, src, src.split("\n"), hits, allowlist);
  return hits;
}

test("merge guard flags merge and pull argv, including incrementally built argv", () => {
  for (const argv of [
    '&["merge", target]',
    'vec!["merge"]',
    'vec!["merge".to_string()]',
    '&["pull", flag]',
    '& [ "merge", target]',
    'vec ! [ "pull", flag]',
  ]) {
    const hits = mergeGuardHits(
      "async fn unsafe_merge() {\n let args = " +
        argv +
        ';\n args.push("--ff-only");\n args.push("--no-overwrite-ignore");\n}',
    );
    assert.equal(hits.length, 1, argv);
    assert.equal(hits[0].fn, "unsafe_merge");
    assert.equal(hits[0].allowlisted, false);
  }
});

test("merge guard allowlists only the named non-argv const item", () => {
  const src =
    'const MERGE_METHODS: [&str; 3] = ["merge", "rebase_merge", "ff"];';
  const allowed = mergeGuardHits(src, "forge/gitlab.rs");
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].fn, "MERGE_METHODS");
  assert.equal(allowed[0].allowlisted, true);
  const elsewhere = mergeGuardHits(src);
  assert.equal(elsewhere.length, 1);
  assert.equal(elsewhere[0].allowlisted, false);
  // An item row is not a function row: a same-named fn gets no pass from it.
  const fnHits = mergeGuardHits(
    'fn MERGE_METHODS() { run(&["merge", sha]); }',
    "forge/gitlab.rs",
  );
  assert.equal(fnHits.length, 1);
  assert.equal(fnHits[0].allowlisted, false);
});

test("merge guard accepts a checked function and both literal exemptions", () => {
  for (const src of [
    'async fn guarded() { ignored_files_in_the_way(repo, sha, timeout).await?; run(&["merge", sha]); }',
    'fn abort() { run(&["merge", "--abort"]); }',
    'fn ff() { run(&["merge", "--ff-only", "--no-overwrite-ignore", sha]); }',
  ]) {
    assert.deepEqual(mergeGuardHits(src), []);
  }
});

test("merge guard requires its own executable guard call", () => {
  for (const body of [
    "// ignored_files_in_the_way(repo, sha, timeout)\n",
    'let prose = "ignored_files_in_the_way(repo, sha, timeout)";',
    "fn nested() { ignored_files_in_the_way(repo, sha, timeout); }",
    "let x = 0; fn inline_nested() { ignored_files_in_the_way(repo, sha, timeout); }",
  ]) {
    const src =
      "fn earlier() { ignored_files_in_the_way(repo, sha, timeout); }\nfn unsafe_merge() {\n" +
      body +
      '\nrun(&["merge", sha]);\n}\nfn later() { ignored_files_in_the_way(repo, sha, timeout); }';
    assert.equal(mergeGuardHits(src).length, 1, body);
  }
});

test("merge guard ignores test modules and literals but scans production after tests", () => {
  const src = [
    '#[cfg(test)] mod tests { fn fixture() { run(&["merge", sha]); } }',
    'fn prose() { let raw = r#"&["merge", sha]"#; }',
    'fn production() { run(&["merge", sha]); }',
  ].join("\n");
  const hits = mergeGuardHits(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "production");
});

test("merge guard allowlists only the named fresh-checkout function", () => {
  const src = 'async fn verify_pin_and_merge() { run(&["merge", sha]); }';
  const hits = mergeGuardHits(src, "git/branches.rs");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].allowlisted, true);
  assert.equal(mergeGuardHits(src, "fixture.rs")[0].allowlisted, false);
});

test("merge guard reports stale rows after removal or a guard", () => {
  const entry = MERGE_GUARD_ALLOWLIST.find(
    (row) => row.fn === "verify_pin_and_merge",
  );
  for (const src of [
    "fn verify_pin_and_merge() {}",
    'fn verify_pin_and_merge() { ignored_files_in_the_way(repo, sha, timeout); run(&["merge", sha]); }',
  ]) {
    assert.deepEqual(
      staleAllowlistEntries([entry], mergeGuardHits(src, entry.file)),
      [entry],
    );
  }
});

test("merge guard recognizes argv wrappers, config pairs and Command", () => {
  for (const argv of [
    '&["-c", "a=b", "-c", setting, "merge", sha]',
    'vec![String::from("merge"), sha]',
    'vec!["pull".into(), flag]',
    '&["merge".to_string(), sha]',
    'Command::new("git").args(["merge", sha])',
    'Command::new("git").arg("merge").arg(sha)',
    'Command::new("git").arg("-c").arg(setting).arg("pull")',
    '["pull", flag]',
  ]) {
    const src = "fn unsafe_merge() { let args = " + argv + "; }";
    const hits = mergeGuardHits(src);
    assert.equal(hits.length, 1, argv);
    assert.equal(hits[0].fn, "unsafe_merge", argv);
  }
});

test("merge guard recognizes typed arrays and array parameters", () => {
  const src = [
    "fn unsafe_merge(bytes: [u8; 4]) {",
    '  let args: [&str; 2] = ["merge", sha];',
    "}",
  ].join("\n");
  const hits = mergeGuardHits(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "unsafe_merge");
});

test("merge guard checks const and static argv at their uses and definition", () => {
  for (const item of ["const", "static", "static mut", "pub const"]) {
    for (const value of ['["merge", "ff"]', '&["merge", "ff"]']) {
      // Unused, or public (its users may live in another file): the definition
      // itself is the site.
      const src = item + " METHODS: [&str; 2] = " + value + ";";
      const hits = mergeGuardHits(src);
      assert.equal(hits.length, 1, src);
      assert.equal(hits[0].fn, "METHODS", src);
    }
  }
  const used = [
    'const FF: &[&str] = &["merge", "--no-edit"];',
    "fn unsafe_merge() { run(FF); }",
    "fn guarded() { ignored_files_in_the_way(repo, sha, timeout); run(FF); }",
  ].join("\n");
  const hits = mergeGuardHits(used);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "unsafe_merge");
  const associated = [
    "struct Merge;",
    "impl Merge {",
    '    const ARGS: &\'static [&\'static str] = &["merge", "--no-edit"];',
    "    fn run(&self) { git(Self::ARGS); }",
    "}",
  ].join("\n");
  const assocHits = mergeGuardHits(associated);
  assert.equal(assocHits.length, 1);
  assert.equal(assocHits[0].fn, "run");
  // A non-argv const stays silent.
  assert.deepEqual(
    mergeGuardHits('const KINDS: [&str; 2] = ["log", "merge"];'),
    [],
  );
});

test("merge guard requires the builder caller to check", () => {
  const src = [
    "async fn merge_pinned() { plain_merge_argv(repo, plain, flag).await; }",
    "async fn merge_pinned_autostash() {",
    "  ignored_files_in_the_way(repo, sha, timeout).await?;",
    "  plain_merge_argv(repo, plain, flag).await;",
    "}",
  ].join("\n");
  const hits = mergeGuardHits(src, "git/pull_guard.rs");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "merge_pinned");
  assert.equal(hits[0].allowlisted, false);
  const swapped = src
    .replace("fn merge_pinned()", "fn merge_pinned_autostash()")
    .replace("fn merge_pinned_autostash() {\n", "fn merge_pinned() {\n");
  const swappedHits = mergeGuardHits(swapped, "git/pull_guard.rs");
  assert.equal(swappedHits.length, 1);
  assert.equal(swappedHits[0].fn, "merge_pinned_autostash");
});

test("merge guard ignores builder prose and declarations", () => {
  const src = [
    "fn plain_merge_argv() {}",
    "fn prose() {",
    "  // plain_merge_argv(repo, plain, flag)",
    '  let text = "plain_merge_argv(repo, plain, flag)";',
    "}",
  ].join("\n");
  assert.deepEqual(mergeGuardHits(src), []);
});

test("merge guard limits fast-forward exemptions and skips control ops", () => {
  assert.equal(
    mergeGuardHits(
      'fn pull() { run(&["pull", "--ff-only", ' +
        '"--no-overwrite-ignore"]); }',
    ).length,
    1,
  );
  for (const flag of ["--abort", "--continue", "--quit"]) {
    for (const argv of [
      '&["merge", "' + flag + '"]',
      'Command::new("git").arg("merge").arg("' + flag + '")',
    ]) {
      assert.deepEqual(
        mergeGuardHits("fn control() { let args = " + argv + "; }"),
        [],
      );
    }
  }
  assert.deepEqual(
    mergeGuardHits(
      'fn ff() { run(&["-c", "a=b", "merge", "--ff-only", ' +
        '"--no-overwrite-ignore"]); }',
    ),
    [],
  );
});

test("merge guard counts a guard anywhere in its own function", () => {
  const src = [
    "fn guarded(bytes: [u8; 4]) {",
    '  run(&["merge", sha]);',
    "  if check { ignored_files_in_the_way(repo, sha, timeout); }",
    "}",
  ].join("\n");
  assert.deepEqual(mergeGuardHits(src), []);
});

/** One unguarded function around `body`, for the must-fail spellings. */
const unguarded = (body) => "fn unsafe_merge() {\n" + body + "\n}";

test("lexRust keeps offsets and lines while blanking comments and literals", () => {
  const src = [
    'let a = "x /* y"; /* outer /* inner */ still */ let b = 1;',
    "fn f<'a>(s: &'a str) -> char { '\"' } // tail",
    String.raw`let r = r#"he said "hi" // no"#; let c = b'\''; let d = "\"/*";`,
  ].join("\n");
  const { code, masked } = lexRust(src);
  assert.equal(code.length, src.length);
  assert.equal(masked.length, src.length);
  assert.deepEqual(
    code.split("\n").map((l) => l.trimEnd()),
    [
      'let a = "x /* y"; ' +
        " ".repeat("/* outer /* inner */ still */".length) +
        " let b = 1;",
      "fn f<'a>(s: &'a str) -> char { '\"' }",
      String.raw`let r = r#"he said "hi" // no"#; let c = b'\''; let d = "\"/*";`,
    ],
  );
  assert.ok(!/["']/.test(masked), masked);
  assert.ok(masked.includes("let b = 1;"));
  assert.ok(masked.includes("let d ="));
  assert.equal(lexRust(src).unterminated, -1);
});

test("merge guard fails closed on a literal or comment that never closes", () => {
  for (const opener of [
    'let s = "never closed;',
    'let s = r#"never closed";',
    "/* outer /* inner */ never closed",
  ]) {
    const src =
      "fn a() {}\nfn b() {\n  " + opener + '\n  run(&["merge", sha]);\n}';
    const hits = mergeGuardHits(src);
    assert.equal(hits.length, 1, opener);
    assert.equal(hits[0].fn, "<unreadable>", opener);
    // A stray quote pairs with the next one, so the run-off may start later.
    assert.ok(hits[0].line >= 3, opener);
    assert.equal(hits[0].allowlisted, false, opener);
  }
});

test("merge guard sees past comment-shaped text inside Rust strings", () => {
  for (const [label, before] of [
    [
      "gd/session/* on a multi-line string's continuation line",
      [
        '#[tool(description = "Refuses an agent-session branch \\',
        '                       (gd/session/*). Requires --allow-git-write.")]',
        "fn create_branch() {}",
      ].join("\n"),
    ],
    [
      "// on a multi-line string's continuation line",
      [
        "fn describe() {",
        '    let text = "first line',
        '        see https://example.com // not a comment";',
        "}",
      ].join("\n"),
    ],
  ]) {
    const src = before + '\nfn unsafe_merge() { run(&["merge", sha]); }';
    const hits = mergeGuardHits(src);
    assert.equal(hits.length, 1, label);
    assert.equal(hits[0].fn, "unsafe_merge", label);
  }
});

test("merge guard counts no guard that only a comment spells", () => {
  for (const [label, src] of [
    [
      "lifetime before a trailing comment",
      [
        "async fn unsafe_merge(state: State<'_, AppState>) { // ignored_files_in_the_way(",
        '    run(&["merge", sha]);',
        "}",
      ].join("\n"),
    ],
    [
      "nested block comment",
      unguarded(
        '/* outer /* inner */ ignored_files_in_the_way(repo, sha, t) */ run(&["merge", sha]);',
      ),
    ],
  ]) {
    assert.equal(mergeGuardHits(src).length, 1, label);
  }
});

test("merge guard reads &'static str annotations as lets, never const items", () => {
  for (const stmt of [
    'let mut args: Vec<&\'static str> = vec!["merge", "--no-edit"];',
    'let argv: &[&\'static str] = &["merge", x];',
    'let a: [&\'static str; 2] = ["merge", x];',
  ]) {
    const hits = mergeGuardHits(unguarded(stmt));
    assert.equal(hits.length, 1, stmt);
    assert.equal(hits[0].fn, "unsafe_merge", stmt);
  }
});

test("merge guard follows a receiver's pushes, extends and inserts", () => {
  for (const body of [
    'let mut a = vec!["-c", cfg]; a.push("merge");',
    'let mut a = Vec::new(); a.push("merge");',
    'let mut a: Vec<&str> = Vec::new(); a.extend(["merge", x]);',
    'let mut a = Vec::new(); a.extend_from_slice(&["pull", "--no-rebase"]);',
    'let mut a = vec!["--no-edit", x]; a.insert(0, "merge");',
    'let mut cmd = Command::new("git"); cmd.arg("-C").arg(dir); cmd.arg("merge");',
    'let mut a = vec!["-C", dir]; if sq { a.push("--squash"); } a.push("merge");',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
  for (const body of [
    'let mut args = vec!["merge", "--no-overwrite-ignore"]; args.extend(["-X", "ours"]); ' +
      "ignored_files_in_the_way(repo, sha, t);",
    'let mut args: Vec<&str> = Vec::new(); args.extend(["-X", "ours"]);',
    'let mut a = vec!["log"]; a.push("merge");',
    'let a = vec!["merge"]; let a = vec!["log"]; a.push("x"); ' +
      "ignored_files_in_the_way(repo, sha, t);",
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard resolves every element spelling of the verb", () => {
  for (const element of [
    '"merge".to_owned()',
    '&"merge".to_string()',
    'r"merge"',
    'r#"merge"#',
    'OsString::from("merge")',
    'std::string::String::from("merge")',
    'OsStr::new("pull")',
    'Cow::Borrowed("merge")',
    'format!("merge")',
    String.raw`"mer\x67e"`,
    "VERB",
    "Self::VERB",
    "verb",
  ]) {
    const src = [
      'const VERB: &str = "merge";',
      unguarded('let verb = "merge";\nrun(&[' + element + ", sha]);"),
    ].join("\n");
    const hits = mergeGuardHits(src);
    assert.equal(hits.length, 1, element);
    assert.equal(hits[0].fn, "unsafe_merge", element);
  }
});

test("merge guard skips git's global options before the verb", () => {
  for (const argv of [
    '&["-C", dir, "merge", sha]',
    '&["--no-pager", "merge", sha]',
    '&["--literal-pathspecs", "pull"]',
    '&["--no-optional-locks", "merge", sha]',
    '&["--git-dir=.git", "merge", sha]',
    '&["--work-tree=.", "merge", sha]',
    '&["--git-dir", gitdir, "--work-tree", wt, "merge", sha]',
    '&[&format!("--git-dir={gitdir}"), "merge", sha]',
    'vec!["-c", "a=b", "-C", dir, "--no-pager", "pull"]',
  ]) {
    assert.equal(
      mergeGuardHits(unguarded("run(" + argv + ");")).length,
      1,
      argv,
    );
  }
  // A verb before `merge` makes it a positional, and an opaque verb slot is
  // the named limitation, not a guess.
  for (const argv of [
    '&["-C", dir, "log", "merge"]',
    '&["checkout", "merge"]',
    "&[verb_from_caller, sha]",
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded("run(" + argv + ");")), [], argv);
  }
});

test("merge guard finds arrays wherever they sit", () => {
  for (const body of [
    'let a = if sq { ["merge", "--squash", x] } else { ["merge", x] };',
    'let a = match mode { Mode::Squash => ["merge", "--squash"], _ => ["log", x] };',
    'run(["merge", x].as_slice());',
    'run(vec!("merge", x));',
    'run(vec!{"pull"});',
    'let a = &mut ["merge", x];',
  ]) {
    assert.ok(mergeGuardHits(unguarded(body)).length >= 1, body);
  }
  // Indexing and attributes are not array literals.
  for (const body of [
    'let n = counts["merge"];',
    'let n = lookup(x)["merge"];',
    '#[doc = "merge"]\nlet n = 1;',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard voids the ff-only exemption beside an --overwrite-ignore", () => {
  const ff = 'run(&["merge", "--ff-only", "--no-overwrite-ignore", sha]);';
  assert.deepEqual(mergeGuardHits(unguarded(ff)), []);
  for (const extra of [
    'let flag = "--overwrite-ignore";',
    'other.arg("--overwrite-ignore");',
    'let raw = r"--overwrite-ignore";',
  ]) {
    assert.equal(mergeGuardHits(unguarded(extra + "\n" + ff)).length, 1, extra);
  }
  assert.equal(
    mergeGuardHits(
      unguarded(
        'Command::new("git").arg("merge").arg("--ff-only").arg("--no-overwrite-ignore");',
      ),
    ).length,
    1,
  );
  // Flags in a separate push may be conditional, so they grant nothing.
  assert.equal(
    mergeGuardHits(
      unguarded(
        'let mut a = vec!["merge"]; a.push("--ff-only"); a.push("--no-overwrite-ignore");',
      ),
    ).length,
    1,
  );
  assert.equal(
    mergeGuardHits(
      unguarded('let mut a = vec!["merge"]; if stop { a.push("--abort"); }'),
    ).length,
    1,
  );
});

test("merge guard requires every builder reference and alias to guard", () => {
  for (const src of [
    "fn caller() { plans.iter().map(plain_merge_argv).collect() }",
    "fn caller() { let f = plain_merge_argv; f(repo) }",
    [
      "use crate::git::pull_guard::plain_merge_argv as build;",
      "fn caller() { build(repo, plain, flag); }",
    ].join("\n"),
    [
      "use crate::git::pull_guard::{plain_merge_argv as build, other};",
      "fn caller() { build(repo, plain, flag); }",
    ].join("\n"),
  ]) {
    const hits = mergeGuardHits(src);
    assert.equal(hits.length, 1, src);
    assert.equal(hits[0].fn, "caller", src);
    assert.equal(hits[0].allowlisted, false, src);
  }
  assert.deepEqual(
    mergeGuardHits(
      "use crate::git::pull_guard::plain_merge_argv;\n" +
        "fn caller() { ignored_files_in_the_way(r, s, t); plain_merge_argv(r); }",
    ),
    [],
  );
});

test("merge guard states its function scope and its blind spots", () => {
  const [hit] = mergeGuardHits(unguarded('run(&["merge", sha]);'));
  assert.match(hit.fix, /no dominance/);
  assert.match(hit.fix, /pre-authorizes/);
  assert.match(MERGE_GUARD_NOTE, /^Not seen: /);
});

test("merge guard resolves a verb through same-name shadowing", () => {
  for (const body of [
    'let verb = "merge";\nlet verb = verb.clone();\nrun(&[verb, &sha]);',
    'let verb = "merge";\nlet verb = verb.to_string();\nrun(&[&verb, &sha]);',
    'let verb = "pull";\nlet verb = verb.to_owned();\nrun(&[verb.as_str()]);',
    'let v = "merge";\nlet v = v.clone();\nlet v = v.to_string();\nrun(&[&v, sha]);',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
  // A shadow with no earlier binding is a parameter: opaque, and it terminates.
  for (const src of [
    unguarded("let verb = verb.clone();\nrun(&[verb, sha]);"),
    [
      "const A: &str = B;",
      "const B: &str = A;",
      unguarded("run(&[A, sha]);"),
    ].join("\n"),
  ]) {
    assert.deepEqual(mergeGuardHits(src), [], src);
  }
});

test("merge guard unions the arms of an if or match verb", () => {
  for (const body of [
    'let op = if mode == "rebase" { "rebase" } else { "merge" };\nrun(&[op, "--no-edit", sha]);',
    'let op = match mode { "rebase" => "rebase", _ => "merge" };\nrun(&[op, sha]);',
    'let op = match mode { Mode::Rebase => { "rebase" } Mode::Merge => "pull" };\nrun(&[op]);',
    'run(&[if rebase { "rebase" } else { "merge" }, sha]);',
    'let op = if a { "log" } else if b { "pull" } else { "fetch" };\nrun(&[op]);',
    'let op = match m { A => "merge", _ => unreachable!() };\nrun(&[op, sha]);',
    'let op = if a { let x = 1; "merge" } else { return Err(e) };\nrun(&[op]);',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
  for (const body of [
    'let op = if mode == "rebase" { "rebase" } else { "fetch" };\nrun(&[op, sha]);',
    'let op = if a { "merge" } else { other() };\nrun(&[op, sha]);',
    // The shape at remote.rs/autostash.rs: an op label that never reaches argv.
    'let op = if mode == "rebase" { "rebase" } else { "merge" };\nrefuse_mid_op_for(&repo, op);',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard counts a verified guard wrapper as the guard", () => {
  const rows = [
    ...MERGE_GUARD_ALLOWLIST,
    {
      file: "fixture.rs",
      fn: "refuse_ignored",
      guard: true,
      rationale: "fixture wrapper",
    },
  ];
  const wrapper =
    "fn refuse_ignored(repo: &str) -> AppResult<()> { ignored_files_in_the_way(repo, sha, t)?; Ok(()) }";
  const caller = 'fn caller() { refuse_ignored(repo)?; run(&["merge", sha]); }';
  const hits = mergeGuardHits(wrapper + "\n" + caller, "fixture.rs", rows);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.allowlisted]),
    [["refuse_ignored", true]],
  );
  assert.deepEqual(splitStaleEntries(rows.slice(-1), hits).failing, []);
  // The wrapper's calls count from any file.
  assert.deepEqual(mergeGuardHits(caller, "other.rs", rows), []);
  // A wrapper that skips the real guard fails, and so does its caller.
  const hollow = mergeGuardHits(
    "fn refuse_ignored(repo: &str) -> AppResult<()> { Ok(()) }\n" + caller,
    "fixture.rs",
    rows,
  );
  assert.deepEqual(
    hollow.map((h) => [h.fn, h.allowlisted]),
    [["refuse_ignored", false]],
  );
  // A row whose wrapper is gone is stale.
  const gone = mergeGuardHits(caller, "fixture.rs", rows);
  assert.deepEqual(
    splitStaleEntries(rows.slice(-1), gone).failing,
    rows.slice(-1),
  );
  // Without the row the wrapper is just a function.
  assert.equal(mergeGuardHits(wrapper + "\n" + caller).length, 1);
});

test("merge guard reads slice patterns as patterns, not argv", () => {
  for (const body of [
    'match argv { ["merge", ..] => a(), ["pull", rest @ ..] => b(), _ => c() }',
    'match argv { ["merge", x] if x.is_empty() => a(), _ => c() }',
    'match argv { ["merge"] | ["pull"] => a(), _ => c() }',
    'if let ["pull", rest @ ..] = args { go(rest); }',
    'while let ["merge", ..] = args { step(); }',
    'let ["merge", target] = parts else { return; };',
    'let is_merge = matches!(args, ["merge", ..]);',
    'assert!(matches!(args, ["merge", ..] | ["pull"]));',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  // An array in a match arm's VALUE is still an argv.
  assert.equal(
    mergeGuardHits(
      unguarded('let a = match m { A => ["merge", x], _ => ["log", x] };'),
    ).length,
    1,
  );
});

test("merge guard reads insert as argv only on an argv-shaped receiver", () => {
  for (const body of [
    'let mut body = HashMap::new();\nbody.insert("merge_method", "merge");',
    'let mut m = serde_json::Map::new();\nm.insert("method".into(), "merge".into());',
    'map.insert(key, "pull");',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  for (const body of [
    'let mut a = Vec::new();\na.insert(i, "merge");',
    'let mut a = Vec::with_capacity(4);\na.insert(at, "pull");',
    'let mut a = vec!["--no-edit"];\na.insert(0, "merge");',
    'args.insert(0, "merge");',
    'args.insert(0usize, "pull");',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
});

test("merge guard voids the ff-only exemption on a later fast-forward flag", () => {
  const ff = '"merge", "--ff-only", "--no-overwrite-ignore", sha';
  for (const body of [
    "let mut a = vec![" + ff + '];\na.push("--no-ff");',
    "let mut a = vec![" + ff + '];\na.push("--ff");',
    'run(&["merge", "--ff-only", "--no-overwrite-ignore", "--no-ff", sha]);',
    "let mut a = vec![" + ff + "];\na.extend(extra);",
    "let mut a = vec![" + ff + "];\na.extend_from_slice(&flags);",
    'let f = if x { "--ff" } else { "--stat" };\nlet mut a = vec![' +
      ff +
      "];\na.push(f);",
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
  // A fast-forward flag BEFORE --ff-only loses to it.
  assert.deepEqual(
    mergeGuardHits(
      unguarded(
        'run(&["merge", "--no-ff", "--ff-only", "--no-overwrite-ignore", sha]);',
      ),
    ),
    [],
  );
});

test("merge guard voids the ff-only exemption on a resolved --overwrite-ignore", () => {
  for (const src of [
    [
      'const OW: &str = "--overwrite-ignore";',
      unguarded(
        'let mut a = vec!["merge", "--ff-only", "--no-overwrite-ignore", sha];\na.push(OW);',
      ),
    ].join("\n"),
    [
      'const OW: &str = "--overwrite-ignore";',
      unguarded(
        'run(&["merge", "--ff-only", "--no-overwrite-ignore", OW, sha]);',
      ),
    ].join("\n"),
  ]) {
    assert.equal(mergeGuardHits(src).length, 1, src);
  }
  // An --overwrite-ignore BEFORE the last --no-overwrite-ignore loses to it.
  assert.deepEqual(
    mergeGuardHits(
      [
        'const OW: &str = "--overwrite-ignore";',
        unguarded(
          'run(&["merge", OW, "--ff-only", "--no-overwrite-ignore", sha]);',
        ),
      ].join("\n"),
    ),
    [],
  );
});

test("merge guard skips --shallow-file and its value before the verb", () => {
  assert.equal(
    mergeGuardHits(unguarded('run(&["--shallow-file", path, "merge", sha]);'))
      .length,
    1,
  );
});

test("merge guard drops an arm whose block ends in a diverging statement", () => {
  for (const choose of [
    'let op = if a { "merge" } else { return Err(e); };',
    [
      "let op = if a {",
      '    "merge"',
      "} else {",
      '    log::warn!("no op");',
      "    return Err(e);",
      "};",
    ].join("\n"),
    'let op = match m { Mode::Merge => "merge", _ => { log::warn!("x"); return Ok(()); } };',
    'let op = match m { Mode::Merge => "merge", _ => { continue; } };',
    'let op = if a { "merge" } else if b { return Ok(()); } else { "log" };',
  ]) {
    const body = choose + "\nrun(&[op, sha]);";
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
  // A block ending in a statement that does not diverge stays opaque.
  assert.deepEqual(
    mergeGuardHits(
      unguarded('let op = if a { "merge" } else { log(); };\nrun(&[op, sha]);'),
    ),
    [],
  );
});

test("merge guard resolves pathological binding chains fast", () => {
  const shadows = (n) =>
    unguarded(
      'let a = "merge";\n' +
        "let a = match m { A => a, B => a, C => a };\n".repeat(n) +
        "run(&[a, sha]);",
    );
  for (const [label, src, expected] of [
    ["15 shadowed three-arm matches", shadows(15), 1],
    ["40 shadowed three-arm matches", shadows(40), 1],
    [
      "a self-referencing const match",
      "const A: &str = match X { 1 => A, 2 => A, 3 => A, _ => A };\n" +
        unguarded("run(&[A, sha]);"),
      0,
    ],
  ]) {
    const started = performance.now();
    const hits = mergeGuardHits(src);
    assert.ok(performance.now() - started < 1000, label);
    assert.equal(hits.length, expected, label);
  }
});

test("merge guard fails closed past its resolution hop cap", () => {
  const chain = (n) =>
    unguarded(
      'let a = "merge";\n' +
        "let a = a.clone();\n".repeat(n) +
        "run(&[a, sha]);",
    );
  const deep = mergeGuardHits(chain(600));
  assert.equal(deep.length, 1);
  assert.equal(deep[0].fn, "<unreadable>");
  assert.equal(deep[0].allowlisted, false);
  const within = mergeGuardHits(chain(300));
  assert.equal(within.length, 1);
  assert.equal(within[0].fn, "unsafe_merge");
});

test("merge guard reads compound slice patterns as patterns", () => {
  for (const body of [
    'if let ["merge", ..] | ["pull", ..] = args { go(); }',
    'match (args, ok) { (["merge", ..], true) => a(), _ => b() }',
    'match opt { Some(["merge", rest @ ..]) => a(rest), _ => b() }',
    'match nested { [["merge", ..], ..] => a(), _ => b() }',
    'if let Some(["merge", x]) = parts { go(x); }',
    'let f = |["merge", x]: [&str; 2]| x;',
    'assert_matches!(args, ["merge", ..]);',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  assert.deepEqual(
    mergeGuardHits('fn f(["merge", x]: [&str; 2]) -> &str { x }'),
    [],
  );
  // Real argvs inside groups, comparisons and struct fields stay sites.
  for (const body of [
    'let ok = run(&["merge", x]) == 0;',
    'let job = Job { argv: ["merge", x] };',
    'match run(&["merge", x]).await { Ok(_) => a(), Err(_) => b() }',
    'let r = matches!(run(&["merge", x]), Ok(_));',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
});

test("merge guard keeps an argv whose expression is followed by a pattern token", () => {
  for (const body of [
    'results[run(&["merge", sha])] = true;',
    'let code = run(&["merge", sha]) | 1;',
    'match mode { _ if run(&["merge", sha]) => go(), _ => stop() }',
    'match mode { Some(x) if check(run(&["merge", x])) => go(), _ => stop() }',
    'let ok = matches!(mode, _ if run(&["merge", sha]));',
    'let f = |x| run(&["merge", x]) | 1;',
    'match m { A => run(&["merge", sha]) | 1, _ => 0 };',
  ]) {
    const hits = mergeGuardHits(unguarded(body));
    assert.equal(hits.length, 1, body);
    assert.equal(hits[0].fn, "unsafe_merge", body);
  }
  for (const body of [
    'match argv { x | ["merge", ..] => a(), _ => b() }',
    'match m { A => { go(); } ["merge", ..] => b(), _ => c() }',
    'let ok = matches!(argv, ["merge", ..] if ready);',
    'match argv { ["merge", ..] if run(&["log"]).is_ok() => a(), _ => b() }',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  // Accepted false positive: an arm pattern starts after the last top-level
  // `}`, so a slice inside a struct pattern's braces reads as an expression.
  assert.equal(
    mergeGuardHits(
      unguarded('match m { Job { argv: ["merge", ..] } => a(), _ => b() }'),
    ).length,
    1,
  );
});

test("merge guard opens no pattern span at a raw identifier", () => {
  for (const body of [
    'r#let(&["merge", sha]);',
    'let f = |r#let| run(&["merge", r#let]);',
    'r#match(&["merge", sha]);',
    'r#match! { run(&["merge", sha]) => go() }',
    'let v = r#move | run(&["merge", sha]) | 1;',
    'let v = \u00e5let(&["merge", sha]);',
    'let ok = xmatches!(argv, ["merge", sha]);',
    'let ok = amatches!(argv, ["merge", sha]);',
  ]) {
    const hits = mergeGuardHits(unguarded(body));
    assert.equal(hits.length, 1, body);
    assert.equal(hits[0].fn, "unsafe_merge", body);
  }
  // `matches` is a macro name, not a keyword: its raw spelling is the macro.
  for (const body of [
    'let ok = r#matches!(argv, ["merge", ..]);',
    'r#assert_matches!(args, ["merge", ..]);',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard never reads a pattern's own pipe as a closure", () => {
  for (const body of [
    'match mode { | A if run(&["merge", sha]).is_ok() | ready => 1, _ => 0 };',
    'match m { A => 0, | B if run(&["merge", sha]).is_ok() | z => 1, _ => 2 }',
    'let ok = matches!(m, | A if run(&["merge", sha]).is_ok() | ready);',
    'match m { A => |x| run(&["merge", x]), _ => |x| x }',
  ]) {
    const hits = mergeGuardHits(unguarded(body));
    assert.equal(hits.length, 1, body);
    assert.equal(hits[0].fn, "unsafe_merge", body);
  }
  for (const body of [
    'match argv { | ["merge", ..] | ["pull", ..] => a(), _ => b() }',
    'let ok = matches!(argv, | ["merge", ..] | ["pull"]);',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard verifies every namesake of a guard wrapper", () => {
  const rows = [
    {
      file: "fixture.rs",
      fn: "refuse_ignored",
      guard: true,
      rationale: "fixture wrapper",
    },
  ];
  const hollow = mergeGuardHits(
    'fn refuse_ignored(repo: &str) -> AppResult<()> { Ok(()) }\nfn caller() { refuse_ignored(r)?; run(&["merge", sha]); }',
    "other.rs",
    rows,
  );
  assert.deepEqual(
    hollow.map((h) => [h.fn, h.allowlisted]),
    [["refuse_ignored", false]],
  );
  // A method of the same name is not the wrapper.
  assert.equal(
    mergeGuardHits(
      'fn caller() { self.refuse_ignored(r)?; run(&["merge", sha]); }',
      "other.rs",
      rows,
    ).length,
    1,
  );
  assert.deepEqual(
    mergeGuardHits(
      'fn caller() { refuse_ignored(r)?; run(&["merge", sha]); }',
      "other.rs",
      rows,
    ),
    [],
  );
});

test("merge guard reads Vec::default and Vec::from receivers as argv-shaped", () => {
  for (const init of ["Vec::default()", "Vec::from(base)"]) {
    const body = "let mut a = " + init + ';\na.insert(i, "merge");';
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
});

test("merge guard never lets a sibling branch's verb dismiss a merge", () => {
  for (const body of [
    'let mut cmd = Command::new("git");\nif probe { cmd.args(["status"]); } else { cmd.args(["merge", sha]); }',
    'let mut cmd = Command::new("git");\nif dry { cmd.args(["status"]); } else { cmd.args(["merge", sha]); }',
    'let mut cmd = Command::new("git");\nmatch mode { Mode::Probe => cmd.args(["status"]), _ => cmd.args(["merge", sha]) };',
    'let mut cmd = Command::new("git");\nmatch mode { Mode::Probe => { cmd.arg("status"); } _ => { cmd.arg("merge"); } }',
    'let mut cmd = Command::new("git");\nif probe { cmd.arg("status"); } else { cmd.arg("merge"); }',
    'let mut a = Vec::new();\nfor _ in 0..n { a.push("status"); }\na.push("merge");',
    'let mut a = Vec::new();\nitems.iter().for_each(|_| a.push("status"));\na.push("merge");',
  ]) {
    const hits = mergeGuardHits(unguarded(body));
    assert.equal(hits.length, 1, body);
    assert.equal(hits[0].fn, "unsafe_merge", body);
  }
  // A merge-led literal is a site on its own, whatever ran before it.
  assert.equal(
    mergeGuardHits(
      unguarded('let mut a = vec!["log"];\na.extend(["merge", sha]);'),
    ).length,
    1,
  );
  // A verb that runs first on every path still makes a pushed `merge` a
  // positional.
  for (const body of [
    'let mut a = vec!["log"];\nif x { a.push("merge"); }',
    'let mut cmd = Command::new("git");\ncmd.arg("log");\nif x { cmd.arg("merge"); }',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
});

test("merge guard resets a receiver at a collection-removal call", () => {
  for (const removal of [
    "args.clear();",
    "args.truncate(0);",
    "args.drain(..);",
    "args.retain(|a| a.starts_with('-'));",
    "args.remove(0);",
    "args.pop();",
    "args.split_off(0);",
  ]) {
    for (const add of [
      'args.extend_from_slice(&["merge", sha]);',
      'args.push("merge");',
    ]) {
      const body = 'let mut args = vec!["status"];\n' + removal + "\n" + add;
      assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
    }
  }
});

test("merge guard bounds later flags at a reset that runs first", () => {
  const safe =
    'let mut a = vec!["merge", "--ff-only", "--no-overwrite-ignore", sha];\nrun(&a);\n';
  for (const body of [
    safe + 'a = vec!["log"];\na.push("--no-ff");',
    'let mut a = vec!["merge", "--ff-only", "--no-overwrite-ignore"];\nrun(&a);\na = vec!["status"];\na.push("--ff");',
    safe + 'a.clear();\na.push("--no-ff");',
    safe + 'let a = vec!["log", "--no-ff"];\nrun(&a);',
    safe + 'a = vec!["log", "--no-ff"];',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  // A bound that may not run, or a partial removal, ends nothing.
  for (const body of [
    safe + 'if x { a = vec!["log"]; }\na.push("--no-ff");\nrun(&a);',
    safe + 'if x { a.clear(); }\na.push("--no-ff");\nrun(&a);',
    safe + 'a.pop();\na.push("--no-ff");',
    safe + 'a.push("--no-ff");\na = vec!["log"];',
  ]) {
    assert.equal(mergeGuardHits(unguarded(body)).length, 1, body);
  }
});

test("merge guard keeps its exemptions and flag non-hits under the new passes", () => {
  for (const body of [
    'let mut args = vec!["merge", "--no-overwrite-ignore"];\nargs.extend(["-X", "ours"]);\nignored_files_in_the_way(r, s, t);',
    'let mut args: Vec<&str> = Vec::new();\nargs.extend(["-X", "ours"]);',
    'run(&["merge", "--ff-only", "--no-overwrite-ignore", sha]);',
    'let a = vec!["merge", "--ff-only", "--no-overwrite-ignore", sha];\nrun(&a);',
    'run(&["-c", "a=b", "merge", "--ff-only", "--no-overwrite-ignore", sha]);',
    'let mut a = vec!["merge"];\nif stop { a.push("--abort"); }\nignored_files_in_the_way(r, s, t);',
  ]) {
    assert.deepEqual(mergeGuardHits(unguarded(body)), [], body);
  }
  // A site the passes overlap on is reported once.
  assert.equal(
    mergeGuardHits(
      unguarded('let mut a = vec!["merge", x];\na.push("--no-edit");'),
    ).length,
    1,
  );
});

test("enclosingFn attributes const, unsafe and extern signatures", () => {
  const cases = [
    ["pub const fn for_provider(p: Provider) -> Self {", "for_provider"],
    ["    const fn all() -> Self {", "all"],
    ["unsafe fn from_raw(p: *const u8) {", "from_raw"],
    ['pub unsafe extern "C" fn callback(v: i32) {', "callback"],
    // A bare `extern fn` is legal and defaults to the "C" ABI.
    ["extern fn bare_abi() {", "bare_abi"],
    ["pub(crate) const unsafe fn peek() -> u8 {", "peek"],
    ["pub async fn ordinary(x: u8) {", "ordinary"],
  ];
  for (const [signature, name] of cases) {
    // The preceding fn is the wrong answer a too-narrow pattern falls back to.
    const lines = ["fn preceding() {}", "}", signature, "    let x = 1;"];
    assert.equal(enclosingFn(lines, 3), name, `for ${signature}`);
  }
});

test("refspec-template hits are attributed to the enclosing fn", () => {
  const src = [
    "fn preceding() {}",
    "",
    "pub const fn build_ref(name: &str) -> String {",
    '    format!("refs/heads/{name}")',
    "}",
  ].join("\n");
  const hits = [];
  checkRefspecTemplates("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "build_ref");
  assert.equal(hits[0].line, 4);
  assert.equal(hits[0].allowlisted, false);
});

test("refspec-template check ignores format! templates with no ref marker", () => {
  const src = ["fn f() {", '    format!("hello {name}")', "}"].join("\n");
  const hits = [];
  checkRefspecTemplates("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("compare-endpoint check flags an interpolated basehead, either side", () => {
  for (const template of [
    "repos/{slug}/compare/{base}...{head}",
    // Only the head interpolates — still the injectable half.
    "repos/{slug}/compare/main...{head}",
    "repos/{slug}/compare/{base}...{owner}:{branch}?per_page=1",
  ]) {
    const src = [
      "fn build() -> String {",
      `    format!("${template}")`,
      "}",
    ].join("\n");
    const hits = [];
    checkCompareEndpoints("fixture.rs", src, src.split("\n"), hits);
    assert.equal(hits.length, 1, `should flag ${template}`);
    assert.equal(hits[0].fn, "build");
    assert.equal(hits[0].allowlisted, false);
  }
});

test("compare-endpoint check ignores a fully literal path and the slug alone", () => {
  for (const template of [
    // Nothing after the marker interpolates — no segment an attacker reaches.
    "repos/{slug}/compare/main...dev",
    "repos/{slug}/pulls/{number}",
  ]) {
    const src = [
      "fn build() -> String {",
      `    format!("${template}")`,
      "}",
    ].join("\n");
    const hits = [];
    checkCompareEndpoints("fixture.rs", src, src.split("\n"), hits);
    assert.deepEqual(hits, [], `should ignore ${template}`);
  }
});

test("short-ref check flags --abbrev-ref and :short formats in production code", () => {
  const src = [
    "async fn head(repo: &str) {",
    '    run(&["rev-parse", "--abbrev-ref", "HEAD"]);',
    "}",
    "async fn list(repo: &str) {",
    '    run(&["for-each-ref", "--format=%(refname:short)%00%(upstream:short)"]);',
    "}",
    "async fn strict(repo: &str) {",
    '    run(&["rev-parse", "--abbrev-ref=strict", "HEAD"]);',
    "}",
  ].join("\n");
  const hits = [];
  checkShortRefNames("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["head", 2],
      ["list", 5],
      ["list", 5],
      ["strict", 8],
    ],
  );
  assert.ok(hits.every((h) => !h.allowlisted));
});

test("short-ref check ignores comments, full refnames and test modules", () => {
  const src = [
    "/// Never `rev-parse --abbrev-ref`, never `%(refname:short)`.",
    "async fn full(repo: &str) {",
    '    run(&["for-each-ref", "--format=%(refname)%00%(upstream)"]); // not "--abbrev-ref"',
    "}",
    "#[cfg(test)]",
    "mod tests {",
    "    async fn helper(repo: &str) {",
    '        run(&["rev-parse", "--abbrev-ref", "HEAD"]);',
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkShortRefNames("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("short-ref check flags symbolic-ref --short, never rev-parse --short", () => {
  const src = [
    "async fn branch(repo: &str) {",
    '    run(&["symbolic-ref", "--short", "HEAD"]);',
    "}",
    "async fn quiet(repo: &str) {",
    '    run(&["symbolic-ref", "-q", "--short", "HEAD"]);',
    "}",
    "async fn sha(repo: &str, sha: &str) {",
    '    run(&["rev-parse", "--short", sha]);',
    '    run(&["symbolic-ref", "-q", "HEAD"]);',
    '    run(&["log", "--short"]);',
    "}",
    "#[cfg(test)]",
    "mod tests {",
    "    async fn helper(repo: &str) {",
    '        run(&["symbolic-ref", "--short", "HEAD"]);',
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkShortRefNames("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["branch", 2],
      ["quiet", 5],
    ],
  );
});

test("bare-rev check flags the pre-fix rewrite-status range and reflog walk", () => {
  // The shape `branch_rewrite_status` shipped with: a bare branch on the range's
  // left side and as the reflog-walk argument.
  const src = [
    "pub(crate) async fn branch_rewrite_status(repo: &str, branch: &str) {",
    '    let upstream_rev = format!("{branch}@{{upstream}}");',
    '    let range = format!("{branch}...{upstream_rev}");',
    "    let reflog = run_git_raw(",
    "        Some(repo),",
    '        &["rev-list", "--walk-reflogs", branch],',
    "    );",
    "}",
  ].join("\n");
  const hits = [];
  checkBareBranchRevs("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["branch_rewrite_status", 3],
      ["branch_rewrite_status", 6],
    ],
  );
  assert.ok(hits.every((h) => !h.allowlisted));
});

test("bare-rev check flags each rev shape and rev-taking argv", () => {
  const src = [
    "async fn shapes(base: &str, head: &str, target_ref: &str) {",
    '    let a = format!("{base}..HEAD");',
    '    let b = format!("HEAD...{head}");',
    '    let c = format!("{target_ref}^{{commit}}");',
    '    let d = format!("{base}@{{1}}");',
    "}",
    "async fn argv(branch: &str, base: String, compare: &str) {",
    "    run(&[",
    '        "merge-base",',
    '        "--is-ancestor",',
    "        &base,",
    "        branch,",
    "    ]);",
    '    run(&["merge", "--no-edit", compare]);',
    '    run(&["log", "--format=%s", &base]);',
    "}",
  ].join("\n");
  const hits = [];
  checkBareBranchRevs("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["shapes", 2],
      ["shapes", 3],
      ["shapes", 4],
      ["shapes", 5],
      ["argv", 11],
      ["argv", 12],
      ["argv", 14],
      ["argv", 15],
    ],
  );
});

test("bare-rev check passes resolved, qualified, upstream and non-rev uses", () => {
  const src = [
    '/// Never `format!("{branch}..x")` in a comment.',
    "async fn resolved(repo: &str, branch: &str, base: &str) {",
    "    let base = branch_first_rev(repo, base).await;",
    '    let x = format!("{base}...{tip}");',
    "    let (base, compare) = local_branch_revs(repo, base, compare).await;",
    '    run(&["rev-list", "--count", &base, &compare]);',
    "    let Some(head) = branch_tip_sha(repo, branch).await? else {",
    "        return;",
    "    };",
    '    run(&["merge-base", "--is-ancestor", &head, "HEAD"]);',
    '    let q = format!("refs/heads/{branch}^{{commit}}");',
    '    let u = format!("{branch}@{{upstream}}");',
    '    let lit = format!("{{branch}}..x");',
    "    let base_rev = branch_first_rev(repo, base).await;",
    '    run(&["fetch", ".", &format!("{base_rev}:refs/heads/{branch}")]);',
    '    run(&["push", "origin", branch]);',
    '    run(&["rev-parse", "--verify", sha]);',
    '    let label = format!("{branch} vs {base}");',
    "}",
    "#[cfg(test)]",
    "mod tests {",
    "    fn fixture(branch: &str) {",
    '        run(&["merge", branch]);',
    '        let r = format!("{branch}..HEAD");',
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkBareBranchRevs("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("bare-rev check flags widened verbs and a fetch refspec's source", () => {
  // `fetch .` resolves its refspec SOURCE tag-first, the shape the fast-forward
  // arm of update_branch_from shipped with; a bare destination is redirected
  // under refs/heads/ by git, so `:{branch}` alone is not a hit.
  const src = [
    "async fn widened(repo: &str, base: &str, branch: &str, target: &str) {",
    '    run(&["diff", "--no-color", &base, "--", path]);',
    '    run(&["fetch", ".", branch]);',
    '    run(&["fetch", ".", &format!("{base}:{branch}")]);',
    '    run(&["fetch", ".", &format!("refs/heads/x:{branch}")]);',
    '    run(&["reset", "--hard", target]);',
    "}",
  ].join("\n");
  const hits = [];
  checkBareBranchRevs("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["widened", 2],
      ["widened", 3],
      ["widened", 4],
      ["widened", 6],
    ],
  );
});

test("bare-rev check fails closed on a binding it cannot resolve as safe", () => {
  // A shadowing `let` from anything but the branch-first resolvers, and a binding
  // too far above to find, both still flag.
  const src = [
    "async fn rebinds(repo: &str, base: &str) {",
    "    let base = base.trim();",
    '    let r = format!("{base}..HEAD");',
    "}",
    "async fn far(repo: &str) {",
    "    let branch = branch_first_rev(repo, name).await;",
    ...Array.from({ length: 45 }, () => "    noop();"),
    '    run(&["rev-list", branch]);',
    "}",
  ].join("\n");
  const hits = [];
  checkBareBranchRevs("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => [h.fn, h.line]),
    [
      ["rebinds", 3],
      ["far", 52],
    ],
  );
});

test("a retiring allowlist entry with no match notes, a plain one fails", () => {
  const list = [
    { file: "a.rs", fn: "kept", rationale: "r" },
    { file: "a.rs", fn: "gone", rationale: "r" },
    {
      file: "a.rs",
      fn: "leaving",
      rationale: "r",
      retiring: "parallel change",
    },
  ];
  const hits = [{ file: "a.rs", fn: "kept" }];
  const { failing, retired } = splitStaleEntries(list, hits);
  assert.deepEqual(
    failing.map((e) => e.fn),
    ["gone"],
  );
  assert.deepEqual(
    retired.map((e) => e.fn),
    ["leaving"],
  );
});

test("secret-shaped argv is caught next to a -f-family flag", () => {
  const lines = [
    "fn send(token: &str) {",
    '    cmd.arg("-f")',
    '        .arg(format!("token={token}"));',
    "}",
  ];
  const hits = [];
  checkSecretArgv("fixture.rs", lines.join("\n"), lines, hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "send");
  assert.equal(hits[0].allowlisted, false);

  const benign = ["fn send() {", '    cmd.arg("-f").arg("title=hello");', "}"];
  const none = [];
  checkSecretArgv("fixture.rs", benign.join("\n"), benign, none);
  assert.deepEqual(none, []);
});

test("sync #[tauri::command] is caught, async is not, unreadable fails closed", () => {
  const sync = ["#[tauri::command]", "pub fn do_thing() -> u8 { 1 }"];
  const hits = [];
  checkSyncCommands("fixture.rs", sync.join("\n"), sync, hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "do_thing");
  assert.equal(hits[0].allowlisted, false);

  const asyncCmd = [
    "#[tauri::command]",
    '#[cfg(target_os = "macos")]',
    "pub async fn do_thing() -> u8 { 1 }",
  ];
  const none = [];
  checkSyncCommands("fixture.rs", asyncCmd.join("\n"), asyncCmd, none);
  assert.deepEqual(none, []);

  const unreadable = ["#[tauri::command]", "pub struct NotAFn;"];
  const failClosed = [];
  checkSyncCommands(
    "fixture.rs",
    unreadable.join("\n"),
    unreadable,
    failClosed,
  );
  assert.equal(failClosed.length, 1);
  assert.equal(failClosed[0].fn, "<unresolved>");
  assert.equal(failClosed[0].allowlisted, false);
});

test("stderr-only AppError::Git is caught, bare and format!-wrapped", () => {
  const src = [
    "async fn plain(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
    "async fn wrapped(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    '        stderr: format!("prefix\\n{}", out.stderr),',
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["plain", "wrapped"],
  );
  assert.equal(hits[0].allowlisted, false);
});

test("stderr-only check ignores correct shaping and bare binding patterns", () => {
  const src = [
    "async fn shaped(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.full_failure_text(),",
    "    }",
    "}",
    "fn matched(e: AppError) -> bool {",
    '    matches!(e, AppError::Git { stderr, .. } if stderr.contains("x"))',
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("a stderr value naming a binding is judged by that binding's initializer", () => {
  // The shape the conflict batch itself uses (`let report = …; stderr: report`):
  // the field alone says nothing, so substituting `.stderr` into the binding
  // later has to stay visible.
  const src = [
    "async fn good(commit: GitOutput) -> AppError {",
    "    let report = commit.full_failure_text();",
    "    let _lower = report.to_lowercase();",
    "    AppError::Git {",
    "        code: commit.code,",
    "        stderr: report,",
    "    }",
    "}",
    "async fn bad(commit: GitOutput) -> AppError {",
    "    let report = commit.stderr;",
    "    AppError::Git {",
    "        code: commit.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["bad"],
  );
});

test("an unresolvable stderr binding fails closed", () => {
  // A parameter has no initializer in range, so the checker cannot know which
  // shaping built it — that is a finding, not a pass.
  const src = [
    "async fn passthrough(code: i32, report: String) -> AppError {",
    "    AppError::Git {",
    "        code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "passthrough");
  assert.match(hits[0].fix, /cannot resolve/);
});

test("failure_text() substitution is caught apart from the combining helper", () => {
  const src = [
    "async fn substituting(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.failure_text(),",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /SUBSTITUTES/);
});

test("a comment naming full_failure_text does not disarm the check", () => {
  // The verdict is read from the field VALUE as an expression; a window-wide
  // substring test would have accepted this site on the strength of its prose.
  const src = [
    "async fn commented(out: GitOutput) -> AppError {",
    "    // full_failure_text() is what this should use.",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "commented");
});

test("a chain of stderr aliases is followed to its shaping", () => {
  // One hop lands on a bare ident that matches none of the shaping tests, which
  // reads as correctly shaped — so the walk has to continue.
  const src = [
    "async fn chained_bad(out: GitOutput) -> AppError {",
    "    let raw = out.stderr;",
    "    let report = raw;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
    "async fn chained_ok(out: GitOutput) -> AppError {",
    "    let raw = out.full_failure_text();",
    "    let report = raw;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["chained_bad"],
  );
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a cycle of stderr aliases fails closed", () => {
  const src = [
    "async fn looped(out: GitOutput) -> AppError {",
    "    let first = second;",
    "    let second = first;",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: first,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.match(hits[0].fix, /cannot resolve/);
});

test("a stderr field beyond a six-line constructor is still read", () => {
  // Brace balance, not a line count: rustfmt and a long field list push the
  // field down, and a window that ends first reads as "no stderr field".
  const src = [
    "async fn padded(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        // one",
    "        // two",
    "        // three",
    "        // four",
    "        // five",
    "        // six",
    "        // seven",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "padded");
});

test("an alias initializer is judged whole, not truncated at a `;`", () => {
  // The `;` that ends the statement can also sit inside a string literal, and
  // the truncated head matches no shaping test and is not an ident — a pass.
  const src = [
    "async fn semicolon_in_literal(out: GitOutput) -> AppError {",
    '    let report = format!("a; {}", out.stderr);',
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: report,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "semicolon_in_literal");
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a `stderr:` inside a string literal does not answer for the real field", () => {
  // Matching the first `stderr:` in the text lets an earlier field's STRING
  // stand in for the field — and a string naming the correct helper passes.
  const src = [
    "async fn masked(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    '        code: fallback("shape it as stderr: out.full_failure_text()"),',
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "masked");
  assert.match(hits[0].fix, /full_failure_text/);
});

test("a raw string literal does not swallow the rest of a constructor", () => {
  // `r"\\?\"` ends at its own quote — raw literals honor no escapes — but an
  // escape-aware scan reads the trailing backslash as escaping that quote and
  // consumes everything after it, so the real field is never reached.
  const src = [
    "async fn raw_in_ctor(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    String.raw`        code: parse(r"\\?\"),`,
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fn, "raw_in_ctor");
});

test("an attribute-decorated test module is still recognized as a span", () => {
  // The gate and the `mod` can be separated by outer attributes; missing the
  // span reads every renaming pattern inside it as an unresolvable field.
  const src = [
    "#[cfg(test)]",
    "#[allow(clippy::too_many_lines)]",
    "mod tests {",
    "    fn renamed(e: &AppError) {",
    "        if let AppError::Git { code: c, stderr: text } = e {",
    "            drop((c, text));",
    "        }",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(hits, []);
});

test("test modules are skipped by SPAN, so production code after one is scanned", () => {
  // A renaming pattern (`stderr: text`) is indistinguishable from an
  // unresolvable field, and only tests carry them. Cutting the scan at the
  // module instead of bounding it would leave everything below unchecked.
  const src = [
    "#[cfg(test)]",
    "mod tests {",
    "    fn renamed(e: &AppError) {",
    "        if let AppError::Git { code: c, stderr: text } = e {",
    "            drop((c, text));",
    "        }",
    "    }",
    "}",
    "async fn after_tests(out: GitOutput) -> AppError {",
    "    AppError::Git {",
    "        code: out.code,",
    "        stderr: out.stderr,",
    "    }",
    "}",
  ].join("\n");
  const hits = [];
  checkStderrOnlyGitError("fixture.rs", src, src.split("\n"), hits);
  assert.deepEqual(
    hits.map((h) => h.fn),
    ["after_tests"],
  );
});

// ----------------------------------------------------------- check-dead-surface

test("a commented-out handler entry does not read as registered", () => {
  // The dangerous direction: `foo` survives `split("::").pop()` from a
  // commented-out line, so a disabled-but-invoked command would read as clean.
  const source = [
    ".invoke_handler(tauri::generate_handler![",
    "    git::status,",
    "    // git::disabled_line,",
    "    /* git::disabled_block, */",
    "    git::commit,",
    "])",
  ].join("\n");
  assert.deepEqual([...parseRegistered(source, "fixture")].sort(), [
    "commit",
    "status",
  ]);
});

test("the registered parser survives nested brackets and a missing marker", () => {
  const nested = [
    "tauri::generate_handler![",
    "    git::status,",
    "    with_array::[a],",
    "    git::commit",
    "]",
  ].join("\n");
  const names = parseRegistered(nested, "fixture");
  assert.ok(names.has("status") && names.has("commit"));
  assert.throws(
    () => parseRegistered("no handler here", "fixture"),
    /Could not find/,
  );
});

test("a commented-out invoke does not read as a live call", () => {
  // The mirror of the handler-list bug: a retired command whose only call site
  // is commented out would otherwise stay "invoked" and never surface as dead.
  const source = [
    'const a = invoke("git_status");',
    '// const b = invoke("git_retired_command");',
    "/*",
    'const c = invoke("git_retired_block");',
    "*/",
    // A comment-shaped string is not a comment: this call still counts.
    'const d = invoke("git_open_url"); // see https://example.dev/docs',
  ].join("\n");
  assert.deepEqual([...parseInvoked(source)].sort(), [
    "git_open_url",
    "git_status",
  ]);
});

test("an allowlist entry that suppresses nothing is stale, in both shapes", () => {
  const registered = new Set(["git_status", "git_commit", "git_menu_only"]);
  const invoked = new Set(["git_status"]);
  // Only registered-but-uninvoked (`git_menu_only`) is what an entry is FOR, so
  // it stays. The other two shapes both suppress nothing: a command the handler
  // list no longer registers, and one with a live caller — which never reaches
  // the `dead` filter, so its entry quiets a hit that cannot happen.
  assert.deepEqual(
    staleCommandEntries(
      ["git_menu_only", "git_status", "git_retired_command"],
      registered,
      invoked,
    ),
    ["git_retired_command", "git_status"],
  );
  // The empty allowlist (today's tree) is a no-op, not a failure.
  assert.deepEqual(staleCommandEntries([], registered, invoked), []);
});

test("invoke matching survives nested generics and wrapped calls", () => {
  const source = [
    'const a = invoke<Record<string, string>>("git_branch_tips");',
    "const b = await invoke<PublishTarget[]>(",
    '  "forge_publish_targets",',
    ");",
    'const c = invoke("git_status");',
  ].join("\n");
  assert.deepEqual([...parseInvoked(source)].sort(), [
    "forge_publish_targets",
    "git_branch_tips",
    "git_status",
  ]);
});

// ----------------------------------------------------------- check-rule-mirrors

// Both fixtures wrap their sentences the way the real carriers do — the `-C`
// clause and the `is / forbidden` catchall each straddle a line break. That is
// deliberate: if the whitespace normalization ever came out, the passing
// fixture would read as a carrier missing two sentinels, so these cases pin the
// normalization as much as the patterns.
const carrierStatingTheRule = [
  "1. **Git is a whitelist.** Permitted: `git --no-pager diff / status / log /",
  "   show` and `git branch --list`, each optionally prefixed with `-C <path>`",
  "   to address a task worktree. Everything else — commit, add/stage, stash,",
  "   push, worktree, config — is",
  '   forbidden, even "just to test". The user commits their own work.',
].join("\n");

test("a carrier that still states the whole rule satisfies every sentinel", () => {
  assert.deepEqual(missingSentinels(carrierStatingTheRule), []);
});

test("a carrier that drops the line-wrapped catchall is caught", () => {
  // The dangerous direction: the whitelist forms are still listed, so the file
  // LOOKS like it carries the rule — only the sentence forbidding everything
  // else is gone, which is exactly the drift a reader would not notice.
  const softened = carrierStatingTheRule.replace(
    ["   push, worktree, config — is", "   forbidden, even"].join("\n"),
    "   push, worktree, config — are discouraged, except",
  );
  assert.notEqual(softened, carrierStatingTheRule);
  assert.deepEqual(
    missingSentinels(softened).map((s) => s.name),
    ["forbidden catchall"],
  );
});

test("a carrier that carves an exception into the catchall is caught", () => {
  // Worse than deleting the sentence, because the sentence is still there to
  // read: the rule is stated and then unstated in the same breath.
  const excepted = carrierStatingTheRule.replace(
    [
      "   push, worktree, config — is",
      '   forbidden, even "just to test".',
    ].join("\n"),
    "   push, worktree, config — is forbidden, except git commit.",
  );
  assert.notEqual(excepted, carrierStatingTheRule);
  assert.deepEqual(
    missingSentinels(excepted).map((s) => s.name),
    ["forbidden catchall"],
  );
});

test("a carrier that drops the -C sanction is caught", () => {
  // Losing this clause is what makes a worktree-scoped command read as
  // forbidden to an agent honoring its own charter.
  const unscoped = carrierStatingTheRule.replace(
    [
      "   show` and `git branch --list`, each optionally prefixed with `-C <path>`",
      "   to address a task worktree. Everything else",
    ].join("\n"),
    "   show` and `git branch --list`. Everything else",
  );
  assert.notEqual(unscoped, carrierStatingTheRule);
  assert.deepEqual(
    missingSentinels(unscoped).map((s) => s.name),
    ["-C worktree sanction"],
  );
});

test("a carrier that drops the branch --list allowance is caught", () => {
  const withoutBranch = carrierStatingTheRule.replace(
    "` and `git branch --list`,",
    "`,",
  );
  assert.notEqual(withoutBranch, carrierStatingTheRule);
  assert.deepEqual(
    missingSentinels(withoutBranch).map((s) => s.name),
    ["branch --list allowance"],
  );
});

test("a carrier that drops the read-only forms list is caught", () => {
  const withoutForms = carrierStatingTheRule.replace(
    [
      "1. **Git is a whitelist.** Permitted: `git --no-pager diff / status / log /",
      "   show`",
    ].join("\n"),
    "1. **Git is a whitelist.** Permitted: the read-only inspection forms",
  );
  assert.notEqual(withoutForms, carrierStatingTheRule);
  assert.deepEqual(
    missingSentinels(withoutForms).map((s) => s.name),
    ["read-only git forms"],
  );
});

test("every carrier path the gate checks exists on disk", () => {
  // The sentinels only fire on a file the gate can read: a carrier renamed or
  // moved without updating CARRIERS would otherwise fail as "cannot read" in
  // CI long after the rename landed.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const carrier of CARRIERS) {
    assert.ok(existsSync(join(root, carrier)), `missing carrier: ${carrier}`);
  }
});

test("a mounted carrier, when present, still states the whole rule", () => {
  // Mounted carriers exist only behind the owner's junction — also the only
  // place their drift can be authored — so the suite gates them exactly where
  // it can and skips them in clones, the same split the gate itself makes.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const carrier of MOUNTED_CARRIERS) {
    const path = join(root, carrier);
    if (!existsSync(path)) continue;
    assert.deepEqual(
      missingSentinels(readFileSync(path, "utf8")).map((s) => s.name),
      [],
      `mounted carrier lost the rule: ${carrier}`,
    );
  }
});

// ------------------------------------------------ check-built-whitespace

// The fixtures mirror what Astro actually emits: a newline between the anchors
// under `compressHTML: true`, and none under "jsx". Both sit inside a <footer>
// because that scoping IS the predicate — a gap anywhere else on the page must
// not satisfy it.
const footerWithGap = `<footer><div><a href="/a/">A</a>\n<a href="/b/">B</a></div></footer>`;
const footerCompressed = `<footer><div><a href="/a/">A</a><a href="/b/">B</a></div></footer>`;

test("the whitespace predicate fires on a compressed footer", () => {
  assert.equal(hasInlineGap(footerWithGap), true);
  assert.equal(hasInlineGap(footerCompressed), false);
});

test("an anchor gap outside the footer does not satisfy the gate", () => {
  // The page-wide form passed on CTA pairs while the footer row was compressed,
  // which is the fail-open this scoping closes.
  const ctaGapOnly = `<main><a href="/x/">X</a> <a href="/y/">Y</a></main>${footerCompressed}`;
  assert.equal(hasInlineGap(ctaGapOnly), false);
});

test("a block-level tag starting with 'a' does not satisfy the gate", () => {
  // `<a` unbounded also matches <aside>/<article>/<abbr>, so the gate could go
  // green on a block boundary with every real anchor pair compressed.
  for (const tag of ["aside", "article", "abbr"]) {
    assert.equal(INLINE_GAP.test(`</a>\n<${tag}>`), false, tag);
  }
  assert.equal(INLINE_GAP.test(`</a>\n<a href="/b/">`), true);
});

test("a page with no footer is not treated as passing", () => {
  assert.equal(footerOf("<main><p>no footer here</p></main>"), null);
  assert.equal(hasInlineGap("<main><p>no footer here</p></main>"), false);
});

test("a custom element whose name starts with 'footer' is not the footer", () => {
  // `<footer` unbounded also starts inside <footer-links>, so a gapped pair
  // there could carry the gate while the real footer stayed compressed.
  const page = `<footer-links><a href="/a/">A</a> <a href="/b/">B</a></footer-links>${footerCompressed}`;
  assert.equal(hasInlineGap(page), false);
  assert.ok(footerOf(page).startsWith("<footer>"));
});

test("a footer close tag with trailing space still delimits the element", () => {
  assert.equal(
    hasInlineGap(footerWithGap.replace("</footer>", "</footer >")),
    true,
  );
});

// --------------------------------------------------- check-tauri-plugin-parity

/** Cargo.lock text in the block shape the gate reads, LF or CRLF on demand. */
function cargoLock(entries, eol = "\n") {
  return entries
    .map(([name, version]) =>
      ["[[package]]", `name = "${name}"`, `version = "${version}"`].join(eol),
    )
    .join(eol + eol);
}

/** Crate names the check reports, driven from two in-memory maps. */
const splitCrates = (crates, npm) =>
  mismatchedPairs(new Map(crates), new Map(npm)).map((p) => p.crate);

test("parseCrateVersions reads the block shape under both line endings", () => {
  // CRLF is not hypothetical: a Windows checkout materializes Cargo.lock that
  // way under core.autocrlf, and an LF-only pattern would parse zero packages —
  // the gate then passes having compared nothing.
  const entries = [
    ["tauri", "2.11.5"],
    ["tauri-plugin-http", "2.6.0"],
  ];
  for (const eol of ["\n", "\r\n"]) {
    assert.deepEqual(
      [...parseCrateVersions(cargoLock(entries, eol))],
      entries,
      `should parse ${JSON.stringify(eol)} blocks`,
    );
  }
});

test("parseNpmVersions reads the root importer's resolved versions only", () => {
  const lock = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@tauri-apps/api':",
    "        specifier: ^2.11.1",
    "        version: 2.11.1",
    "      zustand:",
    "        specifier: ^5.0.15",
    "        version: 5.0.15(react@19.2.8)",
    "    devDependencies:",
    "      '@tauri-apps/cli':",
    "        specifier: ^2.11.4",
    "        version: 2.11.4",
    "",
    "  site:",
    "    dependencies:",
    "      '@tauri-apps/api':",
    "        specifier: ^1.0.0",
    "        version: 1.0.0",
    "",
    "packages:",
    "",
    "  '@tauri-apps/api@9.9.9':",
    "    resolution: {integrity: sha512-fixture}",
  ].join("\n");
  const npm = parseNpmVersions(lock);
  // devDependencies count (that is where @tauri-apps/cli lives), the resolved
  // version wins over the specifier, and a peer-resolution suffix is not part
  // of the version.
  assert.equal(npm.get("@tauri-apps/api"), "2.11.1");
  assert.equal(npm.get("@tauri-apps/cli"), "2.11.4");
  assert.equal(npm.get("zustand"), "5.0.15");
  // The sibling importer and the transitive `packages:` section both carry the
  // same name at a different version; either winning would compare a version
  // the app never installs.
  assert.equal(npm.size, 3);
});

test("parseNpmVersions yields nothing when there is no root importer", () => {
  // The degradation that feeds the `empty` fail-closed arm from the parser
  // side: no `  .:` importer block means no versions, and the transitive
  // `packages:` copies are out of scope whatever they resolve to.
  const noImporter = [
    "lockfileVersion: '9.0'",
    "",
    "packages:",
    "",
    "  '@tauri-apps/api@9.9.9':",
    "    resolution: {integrity: sha512-fixture}",
    "    version: 9.9.9",
  ].join("\n");
  assert.equal(parseNpmVersions(noImporter).size, 0);
});

test("npmNameFor pairs the two forms and nothing else", () => {
  assert.equal(npmNameFor("tauri"), "@tauri-apps/api");
  assert.equal(
    npmNameFor("tauri-plugin-notification"),
    "@tauri-apps/plugin-notification",
  );
  // The tauri-* build and runtime crates ship no npm half, and `tauri-plugin`
  // itself is the plugin SDK, not a plugin.
  for (const crate of [
    "tauri-build",
    "tauri-codegen",
    "tauri-runtime-wry",
    "tauri-utils",
    "tauri-plugin",
    "serde",
  ]) {
    assert.equal(npmNameFor(crate), null, `should not pair ${crate}`);
  }
});

test("mismatchedPairs passes halves aligned on major.minor", () => {
  assert.deepEqual(
    splitCrates(
      [["tauri-plugin-http", "2.6.0"]],
      [["@tauri-apps/plugin-http", "2.6.0"]],
    ),
    [],
  );
  // Patch drift is legal — tauri-cli compares major and minor only, so flagging
  // it would redden PRs whose bundle builds fine.
  assert.deepEqual(
    splitCrates(
      [["tauri-plugin-http", "2.6.0"]],
      [["@tauri-apps/plugin-http", "2.6.1"]],
    ),
    [],
  );
});

test("mismatchedPairs flags a split in either direction", () => {
  // Crate ahead: the Cargo.lock-only bump that ships a broken `tauri build`.
  assert.deepEqual(
    splitCrates(
      [["tauri-plugin-http", "2.6.0"]],
      [["@tauri-apps/plugin-http", "2.5.9"]],
    ),
    ["tauri-plugin-http"],
  );
  // npm ahead: the same break, reached from the other lockfile — a check that
  // only looked one way would call this clean.
  assert.deepEqual(
    splitCrates(
      [["tauri-plugin-http", "2.5.9"]],
      [["@tauri-apps/plugin-http", "2.6.0"]],
    ),
    ["tauri-plugin-http"],
  );
  assert.deepEqual(
    splitCrates([["tauri", "3.0.0"]], [["@tauri-apps/api", "2.6.0"]]),
    ["tauri"],
  );
});

test("mismatchedPairs carries both halves of the split it reports", () => {
  assert.deepEqual(
    mismatchedPairs(
      new Map([["tauri", "2.11.5"]]),
      new Map([["@tauri-apps/api", "2.10.1"]]),
    ),
    [
      {
        crate: "tauri",
        npm: "@tauri-apps/api",
        crateVersion: "2.11.5",
        npmVersion: "2.10.1",
      },
    ],
  );
});

test("verdict fails closed when the lockfiles yield no pairs at all", () => {
  // The branch a broken parser lands in: nothing to compare is not a clean
  // tree, because this repo always ships tauri on both sides.
  const none = verdict(new Map(), new Map());
  assert.equal(none.empty, true);
  assert.deepEqual(none.pairs, []);
  assert.deepEqual(none.mismatched, []);
});

test("verdict fails closed when the core pair is missing from a partial parse", () => {
  // Partial degradation is the residual fail-open: plugins still pair, so the
  // count looks healthy while the comparisons the gate exists for went missing.
  const partial = verdict(
    new Map([["tauri-plugin-http", "2.6.0"]]),
    new Map([["@tauri-apps/plugin-http", "2.6.0"]]),
  );
  assert.equal(partial.empty, false);
  assert.equal(partial.missingCore, true);
  assert.deepEqual(partial.mismatched, []);
});

test("verdict clears only when the core pair is present and aligned", () => {
  const clean = verdict(
    new Map([
      ["tauri", "2.11.5"],
      ["tauri-plugin-http", "2.6.0"],
    ]),
    new Map([
      ["@tauri-apps/api", "2.11.1"],
      ["@tauri-apps/plugin-http", "2.6.0"],
    ]),
    { declared: ["@tauri-apps/api", "@tauri-apps/plugin-http"] },
  );
  assert.equal(clean.empty, false);
  assert.equal(clean.missingCore, false);
  assert.deepEqual(clean.mismatched, []);
  assert.deepEqual(clean.duplicated, []);
  assert.deepEqual(clean.unpaired, []);
  assert.equal(clean.pairs.length, 2);
});

test("duplicateCrateNames names only the crates carrying two blocks", () => {
  const lock = cargoLock([
    ["tauri", "2.11.5"],
    ["windows-sys", "0.59.0"],
    ["windows-sys", "0.60.2"],
    ["tauri-plugin-http", "2.6.0"],
  ]);
  assert.deepEqual([...duplicateCrateNames(lock)], ["windows-sys"]);
});

test("verdict fails closed on a duplicated PAIRED crate only", () => {
  const crates = new Map([
    ["tauri", "2.11.5"],
    ["tauri-plugin-http", "2.6.0"],
  ]);
  const npm = new Map([
    ["@tauri-apps/api", "2.11.1"],
    ["@tauri-apps/plugin-http", "2.6.0"],
  ]);
  // Two blocks for a compared crate: the parse kept one version arbitrarily, so
  // the pair it reports may not be the one the app links.
  assert.deepEqual(
    verdict(crates, npm, { duplicates: new Set(["tauri-plugin-http"]) })
      .duplicated,
    ["tauri-plugin-http"],
  );
  // Duplication is ordinary for the crates this gate never compares.
  assert.deepEqual(
    verdict(crates, npm, {
      duplicates: new Set(["windows-sys", "tauri-plugin-fs"]),
    }).duplicated,
    [],
  );
});

test("declaredNpmPackages reads both dependency blocks, scoped to @tauri-apps", () => {
  const pkg = JSON.stringify({
    dependencies: { "@tauri-apps/api": "^2.11.1", zustand: "^5.0.15" },
    devDependencies: { "@tauri-apps/cli": "^2.11.4", vite: "^8.2.1" },
  });
  assert.deepEqual(declaredNpmPackages(pkg), [
    "@tauri-apps/api",
    "@tauri-apps/cli",
  ]);
  // A manifest with neither block is not a crash — the arm simply expects
  // nothing.
  assert.deepEqual(declaredNpmPackages("{}"), []);
});

// One class, two cells: a declared Tauri package that never reaches `declared`
// is a comparison the gate silently skips, and it can be lost either by the
// BLOCK it sits in or by the KEY it is declared under. A new input path added
// to the manifest scan belongs here.

test("declaredNpmPackages counts optional deps and exempts peers", () => {
  const pkg = JSON.stringify({
    dependencies: { "@tauri-apps/api": "^2.11.1" },
    optionalDependencies: { "@tauri-apps/plugin-shell": "^2.4.0" },
    // pnpm does not install an app's peers, so flagging one would redden a
    // required check over a package that was never meant to be there.
    peerDependencies: { "@tauri-apps/plugin-fs": "^2.5.0" },
  });
  assert.deepEqual(declaredNpmPackages(pkg), [
    "@tauri-apps/api",
    "@tauri-apps/plugin-shell",
  ]);
});

test("declaredNpmPackages resolves an npm: alias to the real package name", () => {
  // The alias hides the package on BOTH sides at once: the key carries no
  // `@tauri-apps/` prefix, and the lockfile's root importer keys the entry by
  // the alias — so without reading the value, nothing is ever compared.
  const pkg = JSON.stringify({
    dependencies: {
      "@tauri-apps/api": "^2.11.1",
      "tauri-store-alias": "npm:@tauri-apps/plugin-store@^2.4.4",
      "other-alias": "npm:left-pad@1.3.0",
    },
  });
  assert.deepEqual(declaredNpmPackages(pkg), [
    "@tauri-apps/api",
    "@tauri-apps/plugin-store",
  ]);
  assert.deepEqual(
    [...declaredNpmAliases(pkg)],
    [["@tauri-apps/plugin-store", "tauri-store-alias"]],
  );
  // The mirror case keeps its scoped KEY, so the importer entry still matches
  // and the garbage version lands in `mismatched` rather than here: it is a
  // declaration under its own name, not an alias.
  const forked = JSON.stringify({
    dependencies: { "@tauri-apps/plugin-store": "npm:fork@1.0.0" },
  });
  assert.deepEqual(declaredNpmPackages(forked), ["@tauri-apps/plugin-store"]);
  assert.deepEqual([...declaredNpmAliases(forked)], []);
});

test("a direct declaration cannot mask an alias of the same package", () => {
  // Both forms resolve, and pnpm keys the importer by each — the direct name
  // and the alias. The pair the direct declaration forms is exactly what would
  // swallow the alias if the two lists were one map.
  const pkg = JSON.stringify({
    dependencies: {
      "@tauri-apps/api": "^2.11.1",
      "@tauri-apps/plugin-store": "^2.4.4",
      "store-alias": "npm:@tauri-apps/plugin-store@2.4.4",
    },
  });
  assert.deepEqual(declaredNpmPackages(pkg), [
    "@tauri-apps/api",
    "@tauri-apps/plugin-store",
  ]);
  assert.deepEqual(declaredNpmAliases(pkg), [
    ["@tauri-apps/plugin-store", "store-alias"],
  ]);
  const decided = verdict(
    new Map([
      ["tauri", "2.11.5"],
      ["tauri-plugin-store", "2.4.4"],
    ]),
    new Map([
      ["@tauri-apps/api", "2.11.1"],
      ["@tauri-apps/plugin-store", "2.4.4"],
      ["store-alias", "2.4.4"],
    ]),
    { declared: declaredNpmPackages(pkg), aliases: declaredNpmAliases(pkg) },
  );
  // Every other arm is clean — the direct half pairs and matches — so `aliased`
  // is the only thing standing between this tree and a green gate.
  assert.deepEqual(decided.mismatched, []);
  assert.deepEqual(decided.unpaired, []);
  assert.equal(decided.empty, false);
  assert.equal(decided.missingCore, false);
  assert.deepEqual(decided.aliased, [
    ["@tauri-apps/plugin-store", "store-alias"],
  ]);
});

test("an aliased declaration reaches the unpaired arm", () => {
  // The end of the chain both cells feed: the name is declared, the crate is
  // there, no pair can form under the alias — so the gate reports rather than
  // passing over it.
  const pkg = JSON.stringify({
    dependencies: {
      "@tauri-apps/api": "^2.11.1",
      "tauri-store-alias": "npm:@tauri-apps/plugin-store@^2.4.4",
    },
  });
  const decided = verdict(
    new Map([
      ["tauri", "2.11.5"],
      ["tauri-plugin-store", "2.4.4"],
    ]),
    // What pnpm writes for an aliased install: the alias is the importer key.
    new Map([
      ["@tauri-apps/api", "2.11.1"],
      ["tauri-store-alias", "2.4.4"],
    ]),
    { declared: declaredNpmPackages(pkg), aliases: declaredNpmAliases(pkg) },
  );
  assert.deepEqual(decided.unpaired, ["@tauri-apps/plugin-store"]);
  // Both arms see an alias-only declaration; the CLI renders `aliased` first
  // because it names the cause rather than the symptom.
  assert.deepEqual(decided.aliased, [
    ["@tauri-apps/plugin-store", "tauri-store-alias"],
  ]);
});

test("crateNameFor inverts the pairing and stops at the npm-only package", () => {
  assert.equal(crateNameFor("@tauri-apps/api"), "tauri");
  assert.equal(crateNameFor("@tauri-apps/plugin-store"), "tauri-plugin-store");
  assert.equal(crateNameFor("@tauri-apps/cli"), null);
  assert.equal(crateNameFor("zustand"), null);
});

test("verdict fails closed on a declared package that produced no comparison", () => {
  const crates = new Map([
    ["tauri", "2.11.5"],
    ["tauri-plugin-http", "2.6.0"],
  ]);
  // The lockfile half lost one entry — a shape a format change makes, and one
  // the pair COUNT cannot see: the remaining pairs still look healthy.
  const degraded = verdict(crates, new Map([["@tauri-apps/api", "2.11.1"]]), {
    declared: ["@tauri-apps/api", "@tauri-apps/plugin-http", "@tauri-apps/cli"],
  });
  assert.equal(degraded.empty, false);
  assert.equal(degraded.missingCore, false);
  // @tauri-apps/cli maps to no crate name, so it owes nothing and stays out.
  assert.deepEqual(degraded.unpaired, ["@tauri-apps/plugin-http"]);
  // A declared package whose crate is absent from Cargo.lock ENTIRELY is the
  // same finding, not an exemption: a JS half calling a plugin the Rust side
  // never registers is exactly what this arm is for.
  assert.deepEqual(
    verdict(crates, new Map([["@tauri-apps/api", "2.11.1"]]), {
      declared: ["@tauri-apps/api", "@tauri-apps/plugin-dialog"],
    }).unpaired,
    ["@tauri-apps/plugin-dialog"],
  );
  // The must-NOT-hit twin: the npm-only package stays out even when it is the
  // only thing left to flag.
  assert.deepEqual(
    verdict(crates, new Map([["@tauri-apps/api", "2.11.1"]]), {
      declared: ["@tauri-apps/api", "@tauri-apps/cli"],
    }).unpaired,
    [],
  );
});

test("mismatchedPairs skips a half with no counterpart", () => {
  // Crate-only plugins and the npm-only CLI have nothing to disagree with, so
  // neither is a finding however far the versions sit apart.
  assert.deepEqual(
    splitCrates(
      [
        ["tauri-plugin-fs", "2.5.2"],
        ["tauri-plugin-single-instance", "2.4.4"],
      ],
      [["@tauri-apps/cli", "2.11.4"]],
    ),
    [],
  );
  assert.deepEqual(
    splitCrates([["tauri", "2.11.5"]], [["@tauri-apps/cli", "1.0.0"]]),
    [],
  );
});

// og-card gate: the reference check is only as good as its frontmatter parse,
// and its historical failure mode is fail-open (a quoting form the regex
// missed skipped the check entirely and the run stayed green).

test("cardRefOf reads every YAML quoting form", () => {
  // Every key/value quoting form must reach the check — a form the regex
  // misses is skipped silently, not rejected.
  assert.equal(cardRefOf('ogImage: "/og/a.png"'), "/og/a.png");
  assert.equal(cardRefOf("ogImage: '/og/b.png'"), "/og/b.png");
  assert.equal(cardRefOf("ogImage: /og/c.png"), "/og/c.png");
  assert.equal(
    cardRefOf("ogImage: https://cdn.example/d.png"),
    "https://cdn.example/d.png",
  );
  assert.equal(cardRefOf('"ogImage": "/og/f.png"'), "/og/f.png");
  assert.equal(cardRefOf("'ogImage': '/og/g.png'"), "/og/g.png");
  assert.equal(cardRefOf('ogImage : "/og/h.png"'), "/og/h.png");
});

test("cardRefOf does not fire on other keys or mid-line mentions", () => {
  assert.equal(cardRefOf('heroImage: "/og/e.png"'), undefined);
  assert.equal(cardRefOf("description: set ogImage: later"), undefined);
  assert.equal(cardRefOf(""), undefined);
});

test("frontmatterOf is total and CRLF-safe", () => {
  assert.equal(frontmatterOf("# heading only, no frontmatter\n"), "");
  assert.equal(
    cardRefOf(frontmatterOf('---\r\nogImage: "/og/x.png"\r\n---\r\nbody')),
    "/og/x.png",
  );
});

test("servedRelPathsFor obligates the webp sibling for png cards only", () => {
  assert.deepEqual(servedRelPathsFor("/og/a.png"), ["og/a.png", "og/a.webp"]);
  assert.deepEqual(servedRelPathsFor("/og/a.jpg"), ["og/a.jpg"]);
  assert.deepEqual(servedRelPathsFor("https://cdn.example/a.png"), []);
});

test("isAbsoluteRef exempts http(s) in any case, nothing else", () => {
  assert.equal(isAbsoluteRef("HTTPS://cdn.example/a.png"), true);
  assert.equal(isAbsoluteRef("http://cdn.example/a.png"), true);
  assert.equal(isAbsoluteRef("/og/a.png"), false);
});

test("og-blog.mjs's shared-predicate import resolves on disk", () => {
  // The derive tool has no CI execution of its own, so a renamed guard would
  // otherwise surface only on the author's next local run.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const ogBlog = join(root, "site/scripts/og-blog.mjs");
  const spec = readFileSync(ogBlog, "utf8").match(
    /from "(\.\.[^"]*check-og-cards\.mjs)"/,
  )?.[1];
  assert.ok(spec, "og-blog.mjs imports the shared og-card predicates");
  assert.ok(
    existsSync(resolve(dirname(ogBlog), spec)),
    `og-blog.mjs's import "${spec}" resolves to a real file`,
  );
});

test("servedRelPathsFor rejects refs that escape public/", () => {
  // The backslash arm is built char-by-char: an inline "\\" here has been
  // collapsed by tooling escape layers into a broken \x escape before.
  const bs = String.fromCharCode(92);
  assert.throws(() => servedRelPathsFor("/og/../package.json"));
  assert.throws(() => servedRelPathsFor("../secrets.txt"));
  assert.throws(() => servedRelPathsFor(`/og/..${bs}..${bs}x.png`));
  assert.throws(() => servedRelPathsFor("/./og/a.png"));
  // The legal shapes still pass untouched.
  assert.deepEqual(servedRelPathsFor("/og/a.png"), ["og/a.png", "og/a.webp"]);
});

// --------------------------------------------------------- check-lockfile-dedupe

/** A pnpm lockfile whose `packages:` section carries the given keys. */
function pnpmLock(packageKeys, eol = "\n") {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@codemirror/state':",
    "        specifier: ^6.0.0",
    "        version: 9.9.9",
    "",
    "packages:",
    "",
    ...packageKeys.flatMap((key) => [
      `  ${key}:`,
      "    resolution: {integrity: sha512-fixture}",
      "",
    ]),
    "snapshots:",
    "",
    "  '@codemirror/state@8.8.8':",
    "    dependencies:",
    "      style-mod: 7.7.7",
  ].join(eol);
}

/** One key per singleton at a single version — the clean baseline. */
const singletonKeys = () =>
  SINGLETONS.map((name) =>
    name.startsWith("@") ? `'${name}@1.0.0'` : `${name}@1.0.0`,
  );

const dedupeOf = (keys, eol) =>
  dedupeVerdict(parsePackageVersions(pnpmLock(keys, eol)));

test("check-lockfile-dedupe passes one version per singleton under both line endings", () => {
  // CRLF is what a Windows checkout materializes under core.autocrlf.
  for (const eol of ["\n", "\r\n"]) {
    assert.deepEqual(
      dedupeOf([...singletonKeys(), "zod@3.25.76", "zod@4.6.5"], eol),
      { empty: false, malformed: [], missing: [], split: [] },
      `should pass ${JSON.stringify(eol)} lockfiles`,
    );
  }
});

test("check-lockfile-dedupe flags a singleton at two versions, scoped or not", () => {
  // Non-singletons may legitimately split (zod above); these may not.
  const { split } = dedupeOf([
    ...singletonKeys(),
    "'@codemirror/state@6.7.10'",
    "style-mod@4.1.4",
  ]);
  assert.deepEqual(split, [
    { name: "@codemirror/state", versions: ["1.0.0", "6.7.10"] },
    { name: "style-mod", versions: ["1.0.0", "4.1.4"] },
  ]);
});

test("check-lockfile-dedupe reads only the packages: section", () => {
  // The importer and snapshots fixtures carry singletons at other versions; a
  // parse leaking past either boundary would report a phantom split.
  const { versions } = parsePackageVersions(pnpmLock(singletonKeys()));
  assert.deepEqual([...versions.get("@codemirror/state")], ["1.0.0"]);
  assert.deepEqual([...versions.get("style-mod")], ["1.0.0"]);
  assert.equal(versions.size, SINGLETONS.length);
});

test("check-lockfile-dedupe fails closed on inputs it cannot read", () => {
  // No `packages:` section at all.
  assert.equal(
    dedupeVerdict(parsePackageVersions("lockfileVersion: '9.0'\n")).empty,
    true,
  );
  // A key that does not split into name@version is reported, never skipped.
  assert.deepEqual(
    dedupeOf([...singletonKeys(), "no-version-here"]).malformed,
    ["no-version-here"],
  );
  // A singleton the lock no longer carries would otherwise check nothing.
  assert.deepEqual(dedupeOf(singletonKeys().slice(1)).missing, [SINGLETONS[0]]);
});

// ---------------------------------------------------------- check-skill-mirrors

/** Two one-file skill copies, as the gate reads them off disk. */
const copies = (claudeBody, agentsBody) => [
  new Map([["SKILL.md", claudeBody]]),
  new Map([["SKILL.md", agentsBody]]),
];

test("skill-mirrors passes identical copies", () => {
  const { onlyClaude, onlyAgents, differ } = diffTrees(
    ...copies("# A\n\nSame.\n", "# A\n\nSame.\n"),
  );
  assert.deepEqual(
    { onlyClaude, onlyAgents, differ },
    { onlyClaude: [], onlyAgents: [], differ: [] },
  );
});

test("skill-mirrors tolerates the three mechanical differences", () => {
  // Line endings: the trees are installed at different times.
  assert.deepEqual(
    diffTrees(...copies("# A\n\nSame.\n", "# A\r\n\r\nSame.\r\n")).differ,
    [],
  );
  // Each tree self-references its own path.
  assert.deepEqual(
    diffTrees(
      ...copies(
        "Run `node .claude/skills/d/x.mjs`.\n",
        "Run `node .agents/skills/d/x.mjs`.\n",
      ),
    ).differ,
    [],
  );
  // The command sigil differs per harness — scoped to the skill's own name.
  assert.deepEqual(
    diffTrees(...copies("Use `/d polish`.\n", "Use `$d polish`.\n"), "d")
      .differ,
    [],
  );
});

test("skill-mirrors scopes the sigil rule to the skill's own command", () => {
  // Stripping every backticked `/token` would equate unrelated prose: the gated
  // trees contain `/products`, `/collection` and the regex flag `/g`.
  assert.notEqual(
    normalizeSkill("fetch `/products`", "d"),
    normalizeSkill("fetch `$products`", "d"),
  );
  assert.notEqual(
    normalizeSkill("split on `/g`", "d"),
    normalizeSkill("split on `$g`", "d"),
  );
  assert.equal(
    normalizeSkill("run `/d polish`", "d"),
    normalizeSkill("run `$d polish`", "d"),
  );
});

test("skill-mirrors ignores every harness-only frontmatter key", () => {
  // The whole HARNESS_ONLY_KEYS set is Claude-only config, not content: without
  // the deletion these three would report as drift.
  const { differ, frontmatter } = diffTrees(
    ...copies(
      '---\nname: d\nallowed-tools:\n  - Bash\nuser-invocable: true\nargument-hint: "[x]"\n---\n\nBody.\n',
      "---\nname: d\n---\n\nBody.\n",
    ),
  );
  assert.deepEqual(differ, []);
  assert.deepEqual(frontmatter, []);
});

test("skill-mirrors normalization is reflexive over tree paths", () => {
  // Byte-identical copies must ALWAYS compare equal, including when they name a
  // tree. impeccable's scripts/hook-admin.mjs is exactly this: one identical
  // table listing the .claude, .agents, .cursor and .github stores. Neutralizing
  // only each copy's own prefix breaks this and reds the gate on identical files,
  // where the printed "copy one over the other" remedy is a no-op.
  for (const body of [
    'table: [".claude/skills/d", ".agents/skills/d"]\n',
    'run ".agents/skills/d/hook.mjs"\n',
    'run ".claude/skills/d/hook.mjs"\n',
  ]) {
    assert.deepEqual(
      diffTrees(
        new Map([["hook.mjs", body]]),
        new Map([["hook.mjs", body]]),
        "d",
      ).differ,
      [],
      `identical bodies must compare equal: ${body.trim()}`,
    );
  }
  // The rewrite still absorbs each copy's own self-reference.
  assert.deepEqual(
    diffTrees(
      new Map([["hook.mjs", 'run ".claude/skills/d/hook.mjs"\n']]),
      new Map([["hook.mjs", 'run ".agents/skills/d/hook.mjs"\n']]),
      "d",
    ).differ,
    [],
  );
});

test("skill-mirrors catches a description rewritten in one tree", () => {
  // description decides when the skill loads, so a one-tree rewrite silently
  // changes which harness picks it up — the body can be byte-identical.
  const { frontmatter } = diffTrees(
    ...copies(
      "---\nname: d\ndescription: triggers on React work\n---\n\nBody.\n",
      "---\nname: d\ndescription: NEVER load this skill\n---\n\nBody.\n",
    ),
  );
  assert.deepEqual(
    frontmatter.map((f) => f.field),
    ["description"],
  );
});

test("skill-mirrors catches a frontmatter block lost from one copy", () => {
  const { frontmatter } = diffTrees(
    ...copies("---\nname: d\n---\n\nBody.\n", "Body.\n"),
  );
  assert.deepEqual(
    frontmatter.map((f) => f.field),
    ["frontmatter block"],
  );
});

test("skill-mirrors catches real prose drift", () => {
  // The exact class this gate exists for: one copy edited, the other left behind.
  assert.deepEqual(
    diffTrees(...copies("It is stable.\n", "It is not stable.\n")).differ,
    ["SKILL.md"],
  );
});

test("skill-mirrors catches a file present in only one tree", () => {
  const claude = new Map([["SKILL.md", "x\n"]]);
  const agents = new Map([
    ["SKILL.md", "x\n"],
    ["EXTRA.md", "orphan\n"],
  ]);
  assert.deepEqual(diffTrees(claude, agents).onlyAgents, ["EXTRA.md"]);
  assert.deepEqual(diffTrees(agents, claude).onlyClaude, ["EXTRA.md"]);
});

test("skill-mirrors normalization does not collapse the sigil's name", () => {
  // Normalizing the sigil must not also eat the command name, or two different
  // commands would compare equal and the gate would fail open. The skill name
  // must be PASSED — without it the sigil branch never runs and the assertion
  // holds no matter what the regex does.
  assert.notEqual(
    normalizeSkill("Use `/polish`.\n", "polish"),
    normalizeSkill("Use `/distill`.\n", "polish"),
  );
});

test("skill-mirrors gates frontmatter keys beyond name/description", () => {
  // The vercel rule files rank themselves with impact/tags; gating only
  // name+description would let those drift silently.
  const { frontmatter } = diffTrees(
    ...copies(
      "---\nname: d\nimpact: HIGH\ntags: a, b\n---\n\nBody.\n",
      "---\nname: d\nimpact: LOW\ntags:\n---\n\nBody.\n",
    ),
  );
  assert.deepEqual(
    frontmatter.map((f) => f.field),
    ["impact", "tags"],
  );
});

test("skill-mirrors compares a folded description whole, not its indicator", () => {
  // `description: >` + indented lines truncated to ">" under a lazy field regex,
  // so two opposite descriptions compared equal.
  const { frontmatter } = diffTrees(
    ...copies(
      "---\nname: d\ndescription: >\n  Loads on React work.\n---\n\nBody.\n",
      "---\nname: d\ndescription: >\n  NEVER load this.\n---\n\nBody.\n",
    ),
  );
  assert.deepEqual(
    frontmatter.map((f) => f.field),
    ["description"],
  );
});

test("skill-mirrors accepts frontmatter that opens with a blank line", () => {
  // Real, and in the gated set: rules/rerender-memo-with-default-value.md opens
  // `---`, blank line, then `title:`. An opener that demanded a key line on the
  // first row rejected it, dropping its frontmatter into the body comparison
  // where the harness-only-key exemption no longer applies.
  const { frontmatter, differ } = diffTrees(
    ...copies(
      "---\n\ntitle: T\nallowed-tools:\n  - Bash\n---\n\nBody.\n",
      "---\n\ntitle: T\n---\n\nBody.\n",
    ),
  );
  assert.deepEqual(frontmatter, [], "harness-only key is still exempt here");
  assert.deepEqual(differ, [], "the block parsed as frontmatter, not body");
});

test("skill-mirrors does not treat an hr-opened prose block as frontmatter", () => {
  // Prose after a `---` horizontal rule must not be swallowed up to the next
  // `---`. A `Word: prose` line is genuinely ambiguous YAML and is a documented
  // limit; a colon-free line is not, and is the shape this catches.
  const { differ } = diffTrees(
    ...copies(
      "---\n\nAlpha text here.\n\n---\n\nTail.\n",
      "---\n\nBeta text here.\n\n---\n\nTail.\n",
    ),
  );
  assert.deepEqual(differ, ["SKILL.md"]);
});

test("skill-mirrors exemptions each carry a reason", () => {
  // An exemption emptied of its reason is an undocumented hole in the gate.
  assert.ok(EXEMPT.size > 0, "at least one exemption is recorded");
  for (const [name, reason] of EXEMPT) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 10, `${name}'s exemption states why`);
  }
});

test("skill-mirrors single-tree declarations each carry a reason", () => {
  assert.ok(
    SINGLE_TREE.size > 0,
    "the single-tree skills are declared, not inferred",
  );
  for (const name of EXPECTED_ABSENT)
    assert.ok(
      SINGLE_TREE.has(name),
      // A typo here silently suppresses a real stale-skip NOTE, which is the
      // only signal that a declaration has stopped describing anything.
      `${name} is expected-absent but not declared in SINGLE_TREE`,
    );
  for (const [name, reason] of SINGLE_TREE) {
    assert.equal(typeof reason, "string");
    assert.ok(
      reason.trim().length > 10,
      `${name}'s single-tree entry states why`,
    );
  }
});

test("skill-mirrors classifies binary assets for hash comparison", () => {
  // A utf8 decode collapses invalid bytes to U+FFFD, so two different PNGs can
  // decode to the same string; shadcn ships PNGs in a gated skill.
  assert.equal(isTextFile("assets/shadcn.png"), false);
  assert.equal(isTextFile("SKILL.md"), true);
  assert.equal(isTextFile("agents/openai.yml"), true);
});

test("skill-mirrors exits non-zero on drift, zero when clean", () => {
  // The pure-function tests above never reach main()'s exit code: dropping its
  // `failed = true` left every one of them green while the gate exited 0.
  const root = mkdtempSync(join(tmpdir(), "gd-skill-mirror-"));
  const gate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "check-skill-mirrors.mjs",
  );
  const write = (tree, skill, file, body) => {
    mkdirSync(join(root, tree, skill), { recursive: true });
    writeFileSync(join(root, tree, skill, file), body);
  };
  // Return the output too: an exit code alone cannot tell the branch that fired
  // from an unrelated crash, and cannot pin a SKIP-vs-NOTE decision at all.
  let lastOut = "";
  const run = () => {
    try {
      lastOut = String(
        execFileSync(process.execPath, [gate], {
          env: { ...process.env, GD_SKILL_MIRROR_ROOT: root },
          stdio: "pipe",
        }),
      );
      return 0;
    } catch (err) {
      lastOut = String(err.stdout || "") + String(err.stderr || "");
      return err.status;
    }
  };
  try {
    // TWO mirrored skills, so removing one leaves the intersection non-empty:
    // with only `demo`, deleting its twin empties the intersection and the run
    // exits 1 at the VACUITY guard instead of the single-tree branch under test —
    // the whole SINGLE_TREE mechanism could be deleted and this still passed.
    for (const tree of [".claude/skills", ".agents/skills"]) {
      write(tree, "demo", "SKILL.md", "Same.\n");
      write(tree, "keeper", "SKILL.md", "Kept.\n");
    }
    assert.equal(run(), 0, "identical copies exit 0");

    writeFileSync(join(root, ".agents/skills/demo/SKILL.md"), "Different.\n");
    assert.equal(run(), 1, "drifted copies exit 1");

    writeFileSync(join(root, ".agents/skills/demo/SKILL.md"), "Same.\n");
    rmSync(join(root, ".agents/skills/demo"), { recursive: true });
    assert.equal(run(), 1, "a deleted mirror copy exits 1, not a SKIP");

    // …and prove the previous assertion came from the single-tree branch, not
    // the vacuity guard: restoring the twin must go green again.
    write(".agents/skills", "demo", "SKILL.md", "Same.\n");
    assert.equal(run(), 0, "restoring the deleted mirror copy exits 0");

    // EXEMPT is the gate's largest fail-open lever: without the `if (reason)`
    // block this drift would fail the run, so the assertion discriminates it.
    write(".claude/skills", "impeccable", "SKILL.md", "A\n");
    write(".agents/skills", "impeccable", "SKILL.md", "B\n");
    assert.equal(
      run(),
      0,
      "drift inside an EXEMPT skill is suppressed by name",
    );
    // …and pin the SKIP-vs-NOTE decision, not just the exit code: a still-diverging
    // exemption must report SKIP. Otherwise the stale-exemption NOTE — the only
    // signal that an exemption has stopped suppressing anything — is unpinned.
    assert.match(lastOut, /SKIP impeccable \(exempt:/);

    // The same exemption with copies that now MATCH must flip to that NOTE.
    writeFileSync(join(root, ".agents/skills/impeccable/SKILL.md"), "A\n");
    assert.equal(run(), 0, "a reconciled exemption still exits 0");
    assert.match(lastOut, /NOTE impeccable is exempt but its copies now match/);

    // The stale-skip NOTE needs BOTH directions or it is unpinned: the negative
    // alone stays green if the whole loop is deleted. `gd-conventions` is the
    // committed single-tree entry and is not in this root yet, so its NOTE must
    // fire; the two gitignored mounts must stay quiet, which is what made the
    // line useless as a signal when it fired on every CI run.
    assert.match(
      lastOut,
      /NOTE gd-conventions is declared in SINGLE_TREE but absent/,
    );
    assert.doesNotMatch(lastOut, /NOTE (delegate|logo-creator)/);

    writeFileSync(join(root, ".agents/skills/impeccable/SKILL.md"), "B\n");

    // The SINGLE_TREE *skip* branch: a declared name present in one tree only.
    // Without the declaration this is the failing single-tree path above.
    write(".claude/skills", "gd-conventions", "SKILL.md", "Claude-only.\n");
    assert.equal(
      run(),
      0,
      "a declared single-tree skill skips, it does not fail",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill-mirrors fails rather than passing vacuously", () => {
  // Its own root: with no skill in BOTH trees the gate must not report success.
  // Without the vacuity guard the declared single-tree name below reaches the
  // single-tree loop, matches SINGLE_TREE, and the run exits 0 having compared
  // nothing at all.
  const root = mkdtempSync(join(tmpdir(), "gd-skill-mirror-vacuous-"));
  const gate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "check-skill-mirrors.mjs",
  );
  try {
    mkdirSync(join(root, ".claude/skills/gd-conventions"), { recursive: true });
    writeFileSync(join(root, ".claude/skills/gd-conventions/SKILL.md"), "x\n");
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    let code = 0;
    let out = "";
    try {
      execFileSync(process.execPath, [gate], {
        env: { ...process.env, GD_SKILL_MIRROR_ROOT: root },
        stdio: "pipe",
      });
    } catch (err) {
      code = err.status;
      out = String(err.stdout || "") + String(err.stderr || "");
    }
    assert.equal(code, 1, "an empty intersection exits 1");
    // Any uncaught throw also exits 1, so pin the REASON — otherwise this control
    // cannot tell the vacuity guard firing from the gate crashing before it.
    assert.match(out, /no skill exists in both trees/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------- check-appimage-env-twins

const appimageGuardFixture = [
  'allowed=" LD_LIBRARY_PATH PATH XDG_DATA_DIRS GTK_PATH"',
  'allowed="$allowed GST_PLUGIN_SYSTEM_PATH GST_PLUGIN_SYSTEM_PATH_1_0"',
  'allowed="$allowed GI_TYPELIB_PATH"',
  'allowed="$allowed PYTHONHOME PYTHONPATH PERLLIB QT_PLUGIN_PATH"',
  'allowed="$allowed GSETTINGS_SCHEMA_DIR GTK_EXE_PREFIX GTK_DATA_PREFIX"',
  'allowed="$allowed GTK_IM_MODULE_FILE GDK_PIXBUF_MODULE_FILE"',
  'allowed="$allowed GIO_EXTRA_MODULES GIO_MODULE_DIR"',
  'allowed="$allowed APPDIR " # expected hook re-export, also stripped from children',
].join("\n");

for (const ending of ["\n", "\r\n"]) {
  test(`appimage-env-twins parses ${JSON.stringify(ending)} lines`, () => {
    assert.deepEqual(
      parseGuardAllowed(appimageGuardFixture.replaceAll("\n", ending)),
      new Set([
        "LD_LIBRARY_PATH",
        "PATH",
        "XDG_DATA_DIRS",
        "GTK_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GI_TYPELIB_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERLLIB",
        "QT_PLUGIN_PATH",
        "GSETTINGS_SCHEMA_DIR",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE",
        "GIO_EXTRA_MODULES",
        "GIO_MODULE_DIR",
        "APPDIR",
      ]),
    );
  });
}

const appimageRustFixture = `
// const APPDIR_PATHLIST_VARS: &[&str] = &["COMMENTED_TABLE"];
const APPDIR_PATHLIST_VARS: &[&str] = &[
    "PATH", // "COMMENTED_LINE",
    /* "COMMENTED_BLOCK", */
];
const APPDIR_SCALAR_VARS: &[&str] = &["APPDIR"];
`;

test("appimage-env-twins parses Rust tables without comments", () => {
  for (const ending of ["\n", "\r\n"]) {
    assert.deepEqual(
      parseRustVars(appimageRustFixture.replaceAll("\n", ending)),
      new Set(["PATH", "APPDIR"]),
    );
  }
});

test("appimage-env-twins fails on missing markers or unsupported entries", () => {
  assert.throws(() => parseGuardAllowed("# no assignments"), /Could not find/);
  for (const marker of ["APPDIR_PATHLIST_VARS", "APPDIR_SCALAR_VARS"]) {
    assert.throws(
      () => parseRustVars(appimageRustFixture.replaceAll(marker, "REMOVED")),
      /Could not find/,
    );
  }
  assert.throws(() => parseGuardAllowed("allowed=' PATH '"), /Could not parse/);
  for (const assignment of [
    'allowed+=" NEWVAR"',
    'declare allowed="$allowed NEWVAR"',
    'local allowed="$allowed NEWVAR"',
    'export allowed="$allowed NEWVAR"',
    'declare -x allowed="$allowed NEWVAR"',
    'typeset allowed="$allowed NEWVAR"',
    'readonly allowed="$allowed NEWVAR"',
    '[ -n "$x" ] && allowed="$allowed NEWVAR"',
  ]) {
    assert.throws(
      () => parseGuardAllowed(`${appimageGuardFixture}\n${assignment}\n`),
      /Could not parse allowed assignment/,
    );
    assert.deepEqual(
      parseGuardAllowed(`${appimageGuardFixture}\n# ${assignment}\n`),
      parseGuardAllowed(appimageGuardFixture),
    );
  }
  assert.throws(
    () => parseRustVars(appimageRustFixture.replace('"APPDIR"', "COMPUTED")),
    /Could not parse/,
  );
});

test("appimage-env-twins rejects replacement allowed assignments", () => {
  for (const assignment of ['allowed=""', 'allowed="NEWVAR"']) {
    assert.throws(
      () => parseGuardAllowed(`${appimageGuardFixture}\n${assignment}\n`),
      { message: `Replacement allowed assignment: ${assignment}` },
    );
  }
});

test("appimage-env-twins exemptions each carry a reason", () => {
  for (const [name, reason] of APPIMAGE_EXEMPT) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.trim().length > 10, `${name}'s exemption states why`);
  }
});

test("appimage-env-twins exemptions ratchet names they no longer suppress", () => {
  const exempt = new Map([
    ["APPDIR", "Fixture exemption for a bundle export."],
  ]);
  const stripped = new Set(["PATH"]);
  assert.deepEqual(
    appimageTwinsVerdict(new Set(["PATH", "APPDIR"]), stripped, exempt),
    { empty: false, notStripped: [], notAllowed: [], stale: [] },
  );
  assert.deepEqual(appimageTwinsVerdict(stripped, stripped, exempt), {
    empty: false,
    notStripped: [],
    notAllowed: [],
    stale: ["APPDIR"],
  });
  assert.deepEqual(
    appimageTwinsVerdict(stripped, new Set(["PATH", "APPDIR"]), exempt),
    { empty: false, notStripped: [], notAllowed: [], stale: ["APPDIR"] },
  );
  assert.deepEqual(
    appimageTwinsVerdict(stripped, stripped, new Map([["PATH", "x"]])),
    { empty: false, notStripped: [], notAllowed: [], stale: ["PATH"] },
  );
});

test("appimage-env-twins CLI rejects drift and empty parses", () => {
  const root = mkdtempSync(join(tmpdir(), "gd-appimage-twins-"));
  const gate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "check-appimage-env-twins.mjs",
  );
  let lastOut = "";
  const run = () => {
    try {
      lastOut = String(
        execFileSync(process.execPath, [gate], {
          env: { ...process.env, GD_APPIMAGE_TWINS_ROOT: root },
          stdio: "pipe",
        }),
      );
      return 0;
    } catch (err) {
      lastOut = String(err.stdout || "") + String(err.stderr || "");
      return err.status;
    }
  };
  try {
    mkdirSync(join(root, ".github/scripts"), { recursive: true });
    mkdirSync(join(root, "src-tauri/src"), { recursive: true });
    const guard = join(root, ".github/scripts/appimage-guard.sh");
    const rust = join(root, "src-tauri/src/agent.rs");
    writeFileSync(guard, 'allowed=" PATH APPDIR "\r\n');
    writeFileSync(rust, appimageRustFixture);
    assert.equal(run(), 0, lastOut);
    assert.match(lastOut, /OK 2 variables in sync/);

    writeFileSync(rust, appimageRustFixture.replace('"APPDIR"', ""));
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /in guard but not stripped: APPDIR/);

    writeFileSync(rust, appimageRustFixture);
    writeFileSync(guard, 'allowed=" PATH "\n');
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /stripped but not allowed: APPDIR/);

    writeFileSync(guard, 'allowed=""\n');
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /empty parsed set/);

    writeFileSync(guard, 'allowed=" PATH APPDIR "\n');
    writeFileSync(rust, appimageRustFixture.replace(/"(?:PATH|APPDIR)"/g, ""));
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /empty parsed set/);

    writeFileSync(rust, appimageRustFixture);
    rmSync(guard);
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /appimage-env-twins: FAIL.*ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const rawCopyIconButton = scanner("raw-copy-icon-button");

test("raw-copy-icon-button flags an icon-only copy button in every spelling", () => {
  // One line, raw element.
  assert.deepEqual(
    rawCopyIconButton(
      '<button type="button" title="Copy command" onClick={() => copyText(cmd, "Command copied")}><CopyIcon className="size-3.5" /></button>',
    ),
    [1],
  );
  // The formatter-wrapped raw element, reported on its opening line.
  const wrapped = [
    "<code>{cmd}</code>",
    "<button",
    '  type="button"',
    '  className="shrink-0 cursor-pointer text-muted-foreground"',
    '  title="Copy command"',
    '  onClick={() => copyText(cmd, "Command copied")}',
    ">",
    '  <CopyIcon className="size-3.5" />',
    "</button>",
  ].join("\n");
  assert.deepEqual(rawCopyIconButton(wrapped), [2]);
  // The vendored Button, labelled, with a block-bodied arrow in its props: the
  // `=>` must not end the opening tag.
  const vendored = [
    "<Button",
    '  variant="ghost"',
    '  size="icon-xs"',
    '  aria-label="Copy thread as Markdown"',
    "  onClick={(e) => {",
    "    e.stopPropagation();",
    '    copyText(threadToMarkdown(thread), "Markdown copied");',
    "  }}",
    ">",
    "  <CopyIcon />",
    "</Button>",
  ].join("\n");
  assert.deepEqual(rawCopyIconButton(vendored), [1]);
  // A JSX comment beside the icon: stripComments leaves an empty `{}` pair,
  // which must not hide the button from the scan.
  const commented = [
    '<Button variant="ghost" size="icon-xs" aria-label="Copy link" onClick={onCopy}>',
    "  {/* the label names the control; the SVG is decoration */}",
    '  <CopyIcon className="size-3.5" aria-hidden="true" />',
    "</Button>",
  ].join("\n");
  assert.deepEqual(rawCopyIconButton(commented), [1]);
  // The after-icon side of the same skip: without it this spelling hides.
  assert.deepEqual(
    rawCopyIconButton(
      '<button type="button" title="Copy" onClick={onCopy}><CopyIcon />{/* trailing */}</button>',
    ),
    [1],
  );
});

test("raw-copy-icon-button leaves icon+text controls and the component alone", () => {
  for (const source of [
    // Icon then visible text (LogBlock's header button).
    [
      '<button type="button" onClick={() => copyText(trimmed, "Logs copied")}>',
      '  <CopyIcon className="size-3" />',
      "  Copy",
      "</button>",
    ].join("\n"),
    // Text then icon (the short-SHA copy in the commit headers).
    [
      '<button type="button" onClick={() => copyText(commit.oid, "SHA copied")}>',
      "  {commit.oid.slice(0, 7)}",
      '  <CopyIcon className="size-3" />',
      "</button>",
    ].join("\n"),
    // An inline-start icon on a labelled Button.
    [
      '<Button variant="ghost" size="sm" onClick={() => copyText(text, "Copied")}>',
      '  <CopyIcon data-icon="inline-start" />',
      "  Copy all",
      "</Button>",
    ].join("\n"),
    '<Button size="xs"><CopyIcon data-icon="inline-start" /> Copy</Button>',
    // A menu item is not a button, and carries its own text anyway.
    [
      '<DropdownMenuItem onClick={() => copyText(path, "Path copied")}>',
      "  <CopyIcon />",
      "  Copy path",
      "</DropdownMenuItem>",
    ].join("\n"),
    // The component route, and a different icon alone in a button.
    '<CopyIconButton text={cmd} label="Copy command" toast="Command copied" />',
    '<Button size="icon-xs" aria-label="Done"><CheckIcon /></Button>',
    // The idiom named in a comment is not a use of it.
    "// <button><CopyIcon /></button>",
  ]) {
    assert.deepEqual(rawCopyIconButton(source), [], source);
  }
});

test("raw-copy-icon-button exempts the component file and vendored ui only", () => {
  const check = CHECKS.find((c) => c.name === "raw-copy-icon-button");
  assert.equal(check.appliesTo("src/components/CopyIconButton.tsx"), false);
  assert.equal(check.appliesTo("src/components/ui/button.tsx"), false);
  assert.equal(
    check.appliesTo("src/features/repo-settings/ScopeRefreshHint.tsx"),
    true,
  );
  // The component's own body IS the idiom, so appliesTo is what keeps it clean —
  // pinned against the real file so a rename can't turn the exemption stale.
  const file = "src/components/CopyIconButton.tsx";
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", file),
    "utf8",
  );
  assert.notDeepEqual(rawCopyIconButton(source), []);
  const views = new Map([[file, view(source)]]);
  assert.deepEqual(runCheck(check, [file], views).violations, []);
});

// The PR-description prompt ships twice: `buildPrPrompt` for the app and
// `assemble_pr_recipe` for the MCP recipe tool, synced by hand. These are the
// label-policy sentences a one-sided edit would silently fork. Each source is
// read from disk with its own string escaping undone (TS template-literal
// backticks, Rust `\"`), so the check is byte-equality of the prompt text.
const PR_LABEL_PROMPT_SENTENCES = [
  "for most changes the right outcome is one label or none — never force one.",
  "After the description, always add a final line exactly like `Labels: name1, name2` listing ONLY label names from the list above, copied verbatim.",
  "When no label qualifies, write exactly `Labels: none` — never omit the line, and never invent a label.",
  " Output the title on the first line, a blank line, the description, then the final `Labels:` line (`Labels: none` when no label qualifies)",
  ", then the `Closes:` / `Relates:` line(s) for any qualifying issue",
  ", then the `Relates:` line for any qualifying issue",
];

/** A prompt source with its string-literal escaping undone. Throws when the file
 *  is unreadable, so a moved or deleted mirror fails rather than passing empty. */
function promptSource(rel) {
  const text = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", rel),
    "utf8",
  );
  assert.ok(text.length > 0, `${rel} is empty`);
  // A Windows checkout may carry CRLF; the markers below are LF-spelled.
  return text
    .replaceAll("\r\n", "\n")
    .replaceAll("\\`", "`")
    .replaceAll('\\"', '"');
}

test("the PR label-policy sentences are identical in prompt.ts and generate.rs", () => {
  // The Rust test module pins these same sentences as constants, so only the code
  // above it counts: otherwise a prompt edit its stale test copy still matched
  // would pass here.
  const rust = promptSource("src-tauri/src/mcp_server/generate.rs");
  const testsAt = rust.indexOf("\n#[cfg(test)]\nmod tests");
  assert.ok(testsAt > 0, "generate.rs test module marker not found");
  const sources = {
    "src/lib/ai/prompt.ts": promptSource("src/lib/ai/prompt.ts"),
    "src-tauri/src/mcp_server/generate.rs": rust.slice(0, testsAt),
  };
  for (const sentence of PR_LABEL_PROMPT_SENTENCES) {
    for (const [rel, text] of Object.entries(sources)) {
      assert.ok(text.includes(sentence), `${rel} lacks: ${sentence}`);
    }
  }
});

// The PR prompt's commits section: `assemble_pr_recipe` builds it from local
// commits, which are never partial, so the app's disclosure line must stay out of
// a complete list for the two to agree. The Rust format is pinned as source text
// (whitespace-collapsed, before its test module); the TS side is rendered for real.
const RUST_PR_COMMITS_SECTION =
  'if !p.commit_subjects.is_empty() { prompt_parts.push(format!( "## Commits in this {abbrev}\\n{}", p.commit_subjects .iter() .map(|s| format!("- {s}")) .collect::<Vec<_>>() .join("\\n") )); }';
const COMMITS_PARTIAL_LINE =
  "[commit list may be incomplete — the diff is authoritative]";
const COMMITS_UNAVAILABLE_LINE =
  "[commit list unavailable — the diff is authoritative]";

test("the PR prompt's commits section matches generate.rs for a complete list", async () => {
  const rust = promptSource("src-tauri/src/mcp_server/generate.rs");
  const testsAt = rust.indexOf("\n#[cfg(test)]\nmod tests");
  assert.ok(testsAt > 0, "generate.rs test module marker not found");
  assert.ok(
    rust
      .slice(0, testsAt)
      .replace(/\s+/g, " ")
      .includes(RUST_PR_COMMITS_SECTION),
    "generate.rs commits section drifted from its pinned format",
  );
  const hooks = installSrcHooks();
  try {
    const { buildPrPrompt } = await import("@/lib/ai/prompt");
    const base = {
      diffText: "diff --git a/x b/x\n+1\n",
      diffTruncated: false,
      files: [{ path: "x", added: 1, deleted: 0, isBinary: false }],
      commitSubjects: ["feat: thing", "fix: other"],
      baseBranch: "main",
      headBranch: "feat",
      repoInstructions: null,
      globalInstructions: "",
      availableLabels: [],
    };
    // What the pinned Rust format renders for this list under GitHub's "PR".
    const rustRendered = `## Commits in this PR\n${base.commitSubjects
      .map((s) => `- ${s}`)
      .join("\n")}`;
    const complete = buildPrPrompt(base).prompt;
    assert.ok(complete.includes(`${rustRendered}\n\n## Files changed`));
    assert.equal(
      buildPrPrompt({ ...base, commitsUnknown: false }).prompt,
      complete,
    );
    assert.ok(!complete.includes(COMMITS_PARTIAL_LINE));
    assert.ok(!complete.includes(COMMITS_UNAVAILABLE_LINE));
    // Partial and failed reads disclose; an empty complete list has no section.
    assert.ok(
      buildPrPrompt({ ...base, commitsUnknown: true }).prompt.includes(
        `${rustRendered}\n${COMMITS_PARTIAL_LINE}\n\n## Files changed`,
      ),
    );
    const failed = buildPrPrompt({
      ...base,
      commitSubjects: [],
      commitsUnknown: true,
    }).prompt;
    assert.ok(
      failed.includes(`## Commits in this PR\n${COMMITS_UNAVAILABLE_LINE}`),
    );
    assert.ok(
      !buildPrPrompt({ ...base, commitSubjects: [] }).prompt.includes(
        "## Commits",
      ),
    );
  } finally {
    hooks.deregister();
  }
});

// The review prompt's external section: a capped or partial forge read appends one
// cause-neutral line, distinct from the budget's own truncation line; unset, the
// prompt is byte-identical.
const EXTERNAL_INCOMPLETE_LINE = "[external review list may be incomplete]";

test("the review prompt discloses an incomplete external review list", async () => {
  const hooks = installSrcHooks();
  try {
    const { buildReviewPrompt } = await import("@/lib/ai/prompt");
    const base = {
      title: "t",
      body: "",
      commitSubjects: [],
      diffText: "diff --git a/x b/x\n+1\n",
      diffTruncated: false,
      files: [{ path: "x", added: 1, deleted: 0, isBinary: false }],
      externalFindings: "### CodeRabbit\n- `x:1` — possible bug",
      externalReviewers: ["CodeRabbit"],
    };
    const complete = buildReviewPrompt(base, "general").prompt;
    assert.equal(
      buildReviewPrompt({ ...base, externalIncomplete: false }, "general")
        .prompt,
      complete,
    );
    assert.ok(!complete.includes(EXTERNAL_INCOMPLETE_LINE));
    const findingsEnd = `${base.externalFindings}\n\n`;
    assert.ok(complete.includes(findingsEnd));
    assert.equal(
      buildReviewPrompt({ ...base, externalIncomplete: true }, "general")
        .prompt,
      complete.replace(
        findingsEnd,
        () => `${base.externalFindings}\n${EXTERNAL_INCOMPLETE_LINE}\n\n`,
      ),
    );
    // Rides beside the stale line rather than replacing it.
    const both = buildReviewPrompt(
      { ...base, externalStale: true, externalIncomplete: true },
      "general",
    ).prompt;
    assert.ok(
      both.includes(
        "\n[some findings were made against an earlier commit and may already be addressed]\n[external review list may be incomplete]\n\n",
      ),
    );
  } finally {
    hooks.deregister();
  }
});

// A partial read whose findings all filtered away still discloses, as a header-only
// section that never pulls in the clause vetting findings it doesn't carry. The own
// flag follows the same rule; the notes flag only rides beside lifted notes and never
// renders a section of its own. Every flag unset keeps the prompt byte-identical.
const EXTERNAL_HEADER_ONLY =
  "## Other AI reviewers\n[external review list may be incomplete — findings may exist that were not read]";
const EXTERNAL_CLAUSE_HEAD = "You are ALSO given findings that OTHER";
const OWN_INCOMPLETE_LINE =
  "[own comments list may be incomplete — further dispositions may exist on the PR thread that were not read]";
const OWN_HEADER_ONLY =
  "## Your prior GitDesktop comments on this PR\n[none were read, but the PR's comment read may be incomplete — recorded dispositions and refutations may exist on the PR thread; do not treat their absence here as evidence they don't exist]";
const OWN_CLAUSE_HEAD = "You are ALSO given comments attributed to GitDesktop";
const NOTES_INCOMPLETE_LINE =
  "[a newer notes comment may exist — the PR conversation read may be incomplete]";

function reviewPromptBase() {
  return {
    title: "t",
    body: "",
    commitSubjects: [],
    diffText: "diff --git a/x b/x\n+1\n",
    diffTruncated: false,
    files: [{ path: "x", added: 1, deleted: 0, isBinary: false }],
  };
}

test("a partial external read with no surviving findings renders a header-only marker", async () => {
  const hooks = installSrcHooks();
  try {
    const { buildReviewPrompt } = await import("@/lib/ai/prompt");
    const base = reviewPromptBase();
    const plain = buildReviewPrompt(base, "general");
    // Negative control: absent, false, or empty findings without the flag change nothing.
    for (const extra of [
      { externalIncomplete: false },
      { externalFindings: "", externalIncomplete: false },
    ]) {
      const same = buildReviewPrompt({ ...base, ...extra }, "general");
      assert.equal(same.prompt, plain.prompt);
      assert.equal(same.system, plain.system);
    }
    const partial = buildReviewPrompt(
      { ...base, externalIncomplete: true },
      "general",
    );
    assert.equal(
      partial.prompt,
      plain.prompt.replace(
        "\n\n## Diff\n",
        () => `\n\n${EXTERNAL_HEADER_ONLY}\n\n## Diff\n`,
      ),
    );
    // The clause says findings were given; none were, so it stays out.
    assert.equal(partial.system, plain.system);
    assert.ok(!partial.system.includes(EXTERNAL_CLAUSE_HEAD));
    // The with-findings arm keeps its own line and its clause.
    const withFindings = buildReviewPrompt(
      {
        ...base,
        externalFindings: "### CodeRabbit\n- `x:1` — possible bug",
        externalIncomplete: true,
      },
      "general",
    );
    assert.ok(!withFindings.prompt.includes(EXTERNAL_HEADER_ONLY));
    assert.ok(withFindings.system.includes(EXTERNAL_CLAUSE_HEAD));
  } finally {
    hooks.deregister();
  }
});

test("the review prompt discloses an incomplete own-comments read", async () => {
  const hooks = installSrcHooks();
  try {
    const { buildReviewPrompt } = await import("@/lib/ai/prompt");
    const base = reviewPromptBase();
    const ownItems = ["- (bot)\n  fixed in `abc1234`"];
    // With items: one line after the section body, clause unchanged.
    const complete = buildReviewPrompt({ ...base, ownItems }, "general");
    assert.equal(
      buildReviewPrompt({ ...base, ownItems, ownIncomplete: false }, "general")
        .prompt,
      complete.prompt,
    );
    assert.ok(!complete.prompt.includes(OWN_INCOMPLETE_LINE));
    const partial = buildReviewPrompt(
      { ...base, ownItems, ownIncomplete: true },
      "general",
    );
    assert.equal(
      partial.prompt,
      complete.prompt.replace(
        `${ownItems[0]}\n\n`,
        () => `${ownItems[0]}\n${OWN_INCOMPLETE_LINE}\n\n`,
      ),
    );
    assert.equal(partial.system, complete.system);
    assert.ok(partial.system.includes(OWN_CLAUSE_HEAD));
    // A distilled ledger takes the same line.
    assert.ok(
      buildReviewPrompt(
        { ...base, ownItems, ownDistilled: true, ownIncomplete: true },
        "general",
      ).prompt.includes(`${ownItems[0]}\n${OWN_INCOMPLETE_LINE}\n\n`),
    );
    // Zero items: header-only marker, no clause; unset ⇒ byte-identical.
    const plain = buildReviewPrompt(base, "general");
    for (const extra of [{ ownIncomplete: false }, { ownItems: [] }]) {
      assert.equal(
        buildReviewPrompt({ ...base, ...extra }, "general").prompt,
        plain.prompt,
      );
    }
    const none = buildReviewPrompt(
      { ...base, ownItems: [], ownIncomplete: true },
      "general",
    );
    assert.equal(
      none.prompt,
      plain.prompt.replace(
        "\n\n## Diff\n",
        () => `\n\n${OWN_HEADER_ONLY}\n\n## Diff\n`,
      ),
    );
    assert.equal(none.system, plain.system);
    assert.ok(!none.system.includes(OWN_CLAUSE_HEAD));
  } finally {
    hooks.deregister();
  }
});

test("the review prompt cautions that newer reviewer notes may exist", async () => {
  const hooks = installSrcHooks();
  try {
    const { buildReviewPrompt } = await import("@/lib/ai/prompt");
    const base = { ...reviewPromptBase(), reviewNotes: "Keep the retry." };
    const notesHead =
      "## Author's notes for reviewers\n<author_notes>\nKeep the retry.\n</author_notes>";
    const complete = buildReviewPrompt(base, "general").prompt;
    assert.equal(
      buildReviewPrompt({ ...base, reviewNotesIncomplete: false }, "general")
        .prompt,
      complete,
    );
    assert.ok(!complete.includes(NOTES_INCOMPLETE_LINE));
    assert.ok(complete.includes(`${notesHead}\n\n`));
    assert.equal(
      buildReviewPrompt({ ...base, reviewNotesIncomplete: true }, "general")
        .prompt,
      complete.replace(
        `${notesHead}\n\n`,
        () => `${notesHead}\n${NOTES_INCOMPLETE_LINE}\n\n`,
      ),
    );
    // No notes ⇒ no section for the caveat to ride, and the prompt is unchanged.
    const noNotes = reviewPromptBase();
    assert.equal(
      buildReviewPrompt({ ...noNotes, reviewNotesIncomplete: true }, "general")
        .prompt,
      buildReviewPrompt(noNotes, "general").prompt,
    );
  } finally {
    hooks.deregister();
  }
});

// ------------------------------------------------ check-enforced-node-suites

const enforcedWorkflowFixture = (suites, extra = "") =>
  [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Node suites needing node_modules (enforced)",
    "        env:",
    '          GD_EXPECT_DEPS: "1"',
    `        run: node --test ${suites.map((s) => `"${s}"`).join(" ")}`,
    extra,
    "      - name: Next step",
    "        run: echo done",
    "",
  ].join("\n");

test("enforced-node-suites reads the enforced step's list under both line endings", () => {
  for (const ending of ["\n", "\r\n"]) {
    assert.deepEqual(
      parseEnforcedSuites(
        enforcedWorkflowFixture([
          "scripts/a.test.mjs",
          "scripts/b.test.mjs",
        ]).replaceAll("\n", ending),
      ),
      new Set(["scripts/a.test.mjs", "scripts/b.test.mjs"]),
    );
  }
});

test("enforced-node-suites fails closed on a step it cannot read", () => {
  const ok = enforcedWorkflowFixture(["scripts/a.test.mjs"]);
  for (const [workflow, message] of [
    [ok.replace("(enforced)", "(renamed)"), /Could not find/],
    [ok.replace('GD_EXPECT_DEPS: "1"', 'OTHER: "1"'), /GD_EXPECT_DEPS/],
    [
      ok.replace(/run: node --test .*/, "run: |\n          node --test x"),
      /block scalar/,
    ],
    [
      ok.replace('"scripts/a.test.mjs"', "scripts/a.test.mjs"),
      /Could not parse the run line/,
    ],
    [ok.replace("scripts/a.test.mjs", "scripts/*.test.mjs"), /Not a single/],
    [
      enforcedWorkflowFixture(["scripts/a.test.mjs", "scripts/a.test.mjs"]),
      /Listed twice/,
    ],
    [ok.replace(/run: node --test .*/, "run: node --test"), /Could not parse/],
    [`${ok}\n${ok}`, /Found 2/],
  ]) {
    assert.throws(() => parseEnforcedSuites(workflow), message);
  }
});

// Every element the guard reads is structural: a direct key of the step, or a
// direct entry of its env: block mapping. Each fixture below is one way raw
// text could look like enforcement while GitHub would not apply it.
const enforcedStep = (...stepLines) =>
  [
    "jobs:",
    "  build:",
    "    steps:",
    "      - name: Other step",
    "        env:",
    "          OTHER: x",
    "        run: echo other",
    "      - name: Node suites needing node_modules (enforced)",
    ...stepLines.map((line) => (line === "" ? "" : `        ${line}`)),
    "      - name: Next step",
    "        run: echo done",
    "",
  ].join("\n");
const ENFORCED_RUN = 'run: node --test "scripts/a.test.mjs"';

test("enforced-node-suites: GD_EXPECT_DEPS inside another var's block scalar fails", () => {
  assert.throws(
    () =>
      parseEnforcedSuites(
        enforcedStep(
          "env:",
          "  UNUSED: |",
          '    GD_EXPECT_DEPS: "1"',
          ENFORCED_RUN,
        ),
      ),
    /does not set GD_EXPECT_DEPS/,
  );
});

test("enforced-node-suites: GD_EXPECT_DEPS only in a comment fails", () => {
  assert.throws(
    () =>
      parseEnforcedSuites(
        enforcedStep(
          "env:",
          "  OTHER: x",
          '  # GD_EXPECT_DEPS: "1"',
          ENFORCED_RUN,
        ),
      ),
    /does not set GD_EXPECT_DEPS/,
  );
});

test("enforced-node-suites: GD_EXPECT_DEPS in a different step's env fails", () => {
  const workflow = enforcedStep(ENFORCED_RUN).replace(
    "          OTHER: x",
    '          GD_EXPECT_DEPS: "1"',
  );
  assert.throws(() => parseEnforcedSuites(workflow), /has no env: mapping/);
});

test("enforced-node-suites: a run list inside another key's block scalar fails", () => {
  assert.throws(
    () =>
      parseEnforcedSuites(
        enforcedStep(
          "env:",
          '  GD_EXPECT_DEPS: "1"',
          "with:",
          "  script: |",
          `    ${ENFORCED_RUN}`,
        ),
      ),
    /has no run: key/,
  );
});

test("enforced-node-suites: a flow-mapping env: fails closed", () => {
  assert.throws(
    () =>
      parseEnforcedSuites(
        enforcedStep('env: { GD_EXPECT_DEPS: "1" }', ENFORCED_RUN),
      ),
    /env is a flow collection/,
  );
});

test("enforced-node-suites: a duplicate GD_EXPECT_DEPS key fails closed", () => {
  assert.throws(
    () =>
      parseEnforcedSuites(
        enforcedStep(
          "env:",
          '  GD_EXPECT_DEPS: "1"',
          '  GD_EXPECT_DEPS: "0"',
          ENFORCED_RUN,
        ),
      ),
    /duplicate key 'GD_EXPECT_DEPS'/,
  );
});

test("enforced-node-suites: extra env vars and comments between keys pass", () => {
  assert.deepEqual(
    parseEnforcedSuites(
      enforcedStep(
        "# why this step exists",
        "env:",
        "  FORCE_COLOR: 0",
        "  # the enforcement switch",
        "  GD_EXPECT_DEPS: '1' # turns skips into failures",
        "  NOTES: |",
        "    free text",
        "",
        "# the list",
        ENFORCED_RUN,
        "shell: bash",
      ),
    ),
    new Set(["scripts/a.test.mjs"]),
  );
});

test("enforced-node-suites fails closed on anchors, tabs, stray names and bad parents", () => {
  const valid = ["env:", '  GD_EXPECT_DEPS: "1"', ENFORCED_RUN];
  for (const [workflow, message] of [
    [
      enforcedStep("env: &deps", '  GD_EXPECT_DEPS: "1"', ENFORCED_RUN),
      /anchor or alias/,
    ],
    [enforcedStep("env:", "  <<: *deps", ENFORCED_RUN), /unreadable entry/],
    [
      enforcedStep("env:", '\tGD_EXPECT_DEPS: "1"', ENFORCED_RUN),
      /Tab in indentation/,
    ],
    [enforcedStep(...valid, "env:"), /duplicate key 'env'/],
    [
      enforcedStep(...valid).replace(
        "      - name: Node suites needing node_modules (enforced)",
        "      # - name: Node suites needing node_modules (enforced)",
      ),
      /Could not find/,
    ],
    [
      enforcedStep(...valid).replace("    steps:", "    services:"),
      /not an item of a steps: list/,
    ],
    [
      enforcedStep("env:", '  GD_EXPECT_DEPS: "1', ENFORCED_RUN),
      /Multi-line quoted value/,
    ],
  ]) {
    assert.throws(() => parseEnforcedSuites(workflow), message);
  }
});

test("enforced-node-suites names carriers the step leaves out", () => {
  assert.deepEqual(
    unlistedCarriers(
      ["scripts/b.test.mjs", "scripts/a.test.mjs"],
      new Set(["scripts/a.test.mjs"]),
    ),
    ["scripts/b.test.mjs"],
  );
});

test("enforced-node-suites CLI fails an unlisted carrier (negative control)", () => {
  const root = mkdtempSync(join(tmpdir(), "gd-enforced-suites-"));
  const gate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "check-enforced-node-suites.mjs",
  );
  let lastOut = "";
  const run = () => {
    try {
      lastOut = String(
        execFileSync(process.execPath, [gate], {
          env: { ...process.env, GD_ENFORCED_SUITES_ROOT: root },
          stdio: "pipe",
        }),
      );
      return 0;
    } catch (err) {
      lastOut = String(err.stdout || "") + String(err.stderr || "");
      return err.status;
    }
  };
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    const workflow = join(root, ".github/workflows/frontend.yml");
    // Built by interpolation: spelling the token here would make this file a
    // carrier the real gate then demands in the enforced step.
    const carrier = `if (${ENFORCED_CARRIER_TOKEN}) throw err;\nskip = "needs deps";\n`;
    writeFileSync(join(root, "scripts/a.test.mjs"), carrier);
    writeFileSync(join(root, "scripts/plain.test.mjs"), "// no deps\n");
    // A longer variable sharing the prefix is not the token.
    writeFileSync(
      join(root, "scripts/near.test.mjs"),
      `const x = ${ENFORCED_CARRIER_TOKEN}_OTHER;\n`,
    );
    writeFileSync(workflow, enforcedWorkflowFixture(["scripts/a.test.mjs"]));
    assert.equal(run(), 0, lastOut);
    assert.match(lastOut, /OK 1 installed-only suites/);

    writeFileSync(join(root, "scripts/b.test.mjs"), carrier);
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /missing from .*: scripts\/b\.test\.mjs/);

    // A suite wording its skip differently is still a carrier: detection keys
    // on the variable it reads, never on its skip text.
    rmSync(join(root, "scripts/b.test.mjs"));
    writeFileSync(
      join(root, "scripts/c.test.mjs"),
      `const expect = Boolean(${ENFORCED_CARRIER_TOKEN});\nconst skip = expect ? false : "optional deps absent";\n`,
    );
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /missing from .*: scripts\/c\.test\.mjs/);
    writeFileSync(join(root, "scripts/b.test.mjs"), carrier);
    rmSync(join(root, "scripts/c.test.mjs"));

    writeFileSync(
      workflow,
      enforcedWorkflowFixture([
        "scripts/a.test.mjs",
        "scripts/b.test.mjs",
        "scripts/gone.test.mjs",
      ]),
    );
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /listed but not on disk: scripts\/gone\.test\.mjs/);

    rmSync(join(root, "scripts/a.test.mjs"));
    rmSync(join(root, "scripts/b.test.mjs"));
    writeFileSync(
      workflow,
      enforcedWorkflowFixture(["scripts/plain.test.mjs"]),
    );
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /refusing a vacuous pass/);

    rmSync(workflow);
    assert.equal(run(), 1, lastOut);
    assert.match(lastOut, /FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Carrier recognition: every equivalent read of the variable marks a suite;
// any other code-level mention fails closed. The variable's name is spliced
// in so this file's own code never reads it.
const EXPECT_VAR = ENFORCED_CARRIER_TOKEN.split(".").at(-1);
const UNSUPPORTED_READ = /unsupported GD_EXPECT_DEPS read in s\.mjs/;

test("enforced-node-suites: a single-quoted bracket read is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process.env['${EXPECT_VAR}']) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: a double-quoted bracket read is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process.env["${EXPECT_VAR}"]) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: an optional-chaining read is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process?.env?.${EXPECT_VAR}) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: a read with whitespace around the dots is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process . env\n  . ${EXPECT_VAR}) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: destructuring from process.env is a carrier", () => {
  assert.equal(
    readsExpectDeps(
      `const { CI, ${EXPECT_VAR}: expect = "" } = process.env;`,
      "s.mjs",
    ),
    true,
  );
});

test("enforced-node-suites: a shorthand destructured binding fails closed at its use", () => {
  assert.throws(
    () =>
      readsExpectDeps(
        `const { ${EXPECT_VAR} } = process.env;\nif (${EXPECT_VAR}) x();`,
        "s.mjs",
      ),
    UNSUPPORTED_READ,
  );
});

test("enforced-node-suites: a shorthand binding with a default fails closed at its use", () => {
  assert.throws(
    () =>
      readsExpectDeps(
        `const { ${EXPECT_VAR} = "" } = process.env;\nif (${EXPECT_VAR}) x();`,
        "s.mjs",
      ),
    UNSUPPORTED_READ,
  );
});

test("enforced-node-suites: a backtick-quoted bracket read is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process.env[\`${EXPECT_VAR}\`]) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: an optional bracket read is a carrier", () => {
  assert.equal(
    readsExpectDeps(`if (process.env?.["${EXPECT_VAR}"]) x();`, "s.mjs"),
    true,
  );
});

test("enforced-node-suites: an unrecognized read fails closed", () => {
  assert.throws(
    () =>
      readsExpectDeps(
        `const e = process.env;\nif (e.${EXPECT_VAR}) x();`,
        "s.mjs",
      ),
    UNSUPPORTED_READ,
  );
});

test("enforced-node-suites: the name held in a string key fails closed", () => {
  assert.throws(
    () =>
      readsExpectDeps(
        `const k = "${EXPECT_VAR}";\nif (process.env[k]) x();`,
        "s.mjs",
      ),
    UNSUPPORTED_READ,
  );
});

test("enforced-node-suites: the name inside text or a comment is neither", () => {
  assert.equal(
    readsExpectDeps(
      `const yaml = '  ${EXPECT_VAR}: "1"';\n// process.env.${EXPECT_VAR}\n`,
      "s.mjs",
    ),
    false,
  );
});

test("enforced-node-suites: a suite it cannot scan fails closed", () => {
  assert.throws(
    () => readsExpectDeps("const a = 'unterminated\nconst b = 1;\n", "s.mjs"),
    /could not scan s\.mjs/,
  );
});

// ------------------------------------------------- check-reused-view-pending

const RV_FILE = "src/features/tags/TagDetailView.tsx";
const rvView = (body) =>
  `export function TagDetailView() {\n  const deleteRelease = useDeleteRelease(repoPath);\n${body}\n}\n`;
const rvRun = (src, allowlist = []) =>
  reusedViewVerdict(new Map([[RV_FILE, src]]), allowlist);
const rvReads = (src) =>
  pendingReads(src, RV_FILE).reads.map((r) => `${r.receiver}.${r.prop}`);

test("reused-view-pending flags an unlisted observer pending read", () => {
  const { violations, stale, errors } = rvRun(
    rvView("  const busy = deleteRelease.isPending;"),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(stale, []);
  assert.deepEqual(
    violations.map((r) => [r.line, r.fn, r.receiver, r.prop]),
    [[3, "TagDetailView", "deleteRelease", "isPending"]],
  );
});

test("reused-view-pending flags optional and bracket access", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        '  const a = deleteRelease?.isPending;\n  const b = deleteRelease["isPaused"];',
      ),
    ),
    ["deleteRelease.isPending", "deleteRelease.isPaused"],
  );
});

test("reused-view-pending flags destructuring from a call or an identifier", () => {
  for (const line of [
    "  const { isPending } = useDeleteRelease(repoPath);",
    "  const { mutate, isPending: busy } = useDeleteRelease(repoPath);",
    "  const { isPending } = createComment;",
    "  const { isPaused: parked } = createComment;",
  ]) {
    const { violations } = rvRun(rvView(line));
    assert.equal(violations.length, 1, line);
    assert.match(violations[0].form, /^destructure/, line);
  }
});

test("reused-view-pending fails any useMutationState or useIsMutating call", () => {
  for (const call of [
    "  const s = useMutationState({ filters });",
    "  const n = useIsMutating({ mutationKey });",
  ]) {
    const { violations } = rvRun(rvView(call));
    assert.deepEqual(
      violations.map((r) => r.form),
      ["banned-call"],
      call,
    );
  }
});

test("reused-view-pending reads .status only on hook-bound receivers", () => {
  assert.deepEqual(
    rvReads(rvView('  const a = deleteRelease.status === "pending";')),
    ["deleteRelease.status"],
  );
  assert.deepEqual(
    rvReads(rvView('  const b = "idle" !== deleteRelease.status;')),
    ["deleteRelease.status"],
  );
  // Domain fields named `status` on records are never hook-bound.
  assert.deepEqual(
    rvReads(rvView('  const c = issue.status === "pending";')),
    [],
  );
  assert.deepEqual(
    rvReads(rvView('  const d = deleteRelease.status === "success";')),
    [],
  );
});

test("reused-view-pending ignores comments and strings that name a read", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        '  // `update.isPending` alone can go idle\n  const s = "deleteRelease.isPending";\n  /* x.isPaused */',
      ),
    ),
    [],
  );
});

const rvEntry = (over = {}) => ({
  file: RV_FILE,
  fn: "TagDetailView",
  receiver: "deleteRelease",
  binding: "useDeleteRelease",
  props: ["isPaused"],
  reason: "fixture",
  ...over,
});

test("reused-view-pending admits an allowlisted receiver only for its props", () => {
  const src = rvView("  const p = deleteRelease.isPaused;");
  assert.deepEqual(rvRun(src, [rvEntry()]), {
    violations: [],
    stale: [],
    errors: [],
  });
  const widened = rvRun(
    rvView(
      "  const p = deleteRelease.isPaused;\n  const q = deleteRelease.isPending;",
    ),
    [rvEntry()],
  );
  assert.deepEqual(
    widened.violations.map((r) => r.prop),
    ["isPending"],
  );
  // The entry is pinned to its enclosing function, not the bare name.
  const elsewhere = rvRun(
    `${src}export function Other() {\n  const deleteRelease = useDeleteRelease(repoPath);\n  const p = deleteRelease.isPaused;\n}\n`,
    [rvEntry()],
  );
  assert.deepEqual(
    elsewhere.violations.map((r) => r.fn),
    ["Other"],
  );
});

test("reused-view-pending fails a stale binding and an unused entry", () => {
  const rebound = rvRun(
    "export function TagDetailView() {\n  const deleteRelease = useOther(repoPath);\n  const p = deleteRelease.isPaused;\n}\n",
    [rvEntry()],
  );
  assert.equal(rebound.stale.length, 1);
  assert.match(rebound.stale[0], /no longer bound from useDeleteRelease/);
  const unused = rvRun(rvView("  const p = 1;"), [rvEntry()]);
  assert.equal(unused.stale.length, 1);
  assert.match(unused.stale[0], /admits no read/);
});

test("reused-view-pending binds receivers destructured from an identifier", () => {
  assert.ok(
    bindsReceiver(
      "  const { parents, mainline, pick } = choice;",
      "parents",
      "choice",
    ),
  );
  assert.ok(
    !bindsReceiver("  const { mainline } = choice;", "parents", "choice"),
  );
  assert.ok(
    bindsReceiver(
      "  const parents = useCommitParents<X>(repo, hash);",
      "parents",
      "useCommitParents",
    ),
  );
});

test("reused-view-pending fails closed on inputs it cannot read", () => {
  assert.match(
    reusedViewVerdict(new Map(), []).errors.join("\n"),
    /no files scanned/,
  );
  assert.match(
    reusedViewVerdict(new Map([[RV_FILE, null]]), []).errors.join("\n"),
    /missing or unreadable/,
  );
  assert.match(
    rvRun("const a = 'unterminated\nconst b = 1;\n").errors.join("\n"),
    /could not scan/,
  );
});

test("reused-view-pending keeps its member list, reasons and limitations", () => {
  assert.equal(REUSED_VIEW_MEMBERS.length, 19);
  assert.equal(new Set(REUSED_VIEW_MEMBERS).size, 19);
  for (const e of REUSED_VIEW_ALLOWLIST) {
    assert.ok(REUSED_VIEW_MEMBERS.includes(e.file), e.file);
    assert.ok(e.reason.trim().length > 5, `${e.file} ${e.receiver} says why`);
    assert.ok(e.props.length > 0);
  }
  assert.equal(REUSED_VIEW_LIMITATIONS.length, 12);
});

test("reused-view-pending CLI fails a missing file and prints its limitations", () => {
  // A non-member path: the real allowlist pins member files, and would read
  // a fixture at one of their paths as stale.
  const file = "src/features/fixture/View.tsx";
  const root = mkdtempSync(join(tmpdir(), "gd-reused-view-"));
  const gate = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "check-reused-view-pending.mjs",
  );
  const run = (args) => {
    try {
      return {
        status: 0,
        out: String(
          execFileSync(process.execPath, [gate, ...args], { stdio: "pipe" }),
        ),
      };
    } catch (err) {
      return {
        status: err.status,
        out: String(err.stdout || "") + String(err.stderr || ""),
      };
    }
  };
  try {
    mkdirSync(join(root, "src/features/fixture"), { recursive: true });
    writeFileSync(
      join(root, file),
      rvView("  const busy = deleteRelease.isPending;").replaceAll(
        "\n",
        "\r\n",
      ),
    );
    const hit = run(["--root", root, file]);
    assert.equal(hit.status, 1, hit.out);
    assert.match(hit.out, /fixture\/View\.tsx:3 deleteRelease\.isPending/);
    assert.match(hit.out, /plain useState busy flag/);

    writeFileSync(join(root, file), rvView("  const ok = 1;"));
    const clean = run(["--root", root, file]);
    assert.equal(clean.status, 0, clean.out);
    // Only the checked files' entries are counted.
    assert.match(clean.out, /OK 1 files, 0 reviewed exceptions/);

    const missing = run(["--root", root, "src/features/fixture/Gone.tsx"]);
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.out, /Gone\.tsx: missing or unreadable/);

    assert.equal(run(["--root"]).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reused-view-pending flags non-null, typed and nested-pattern reads", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        '  const a = deleteRelease!.isPending;\n  const b = deleteRelease!["isPaused"];',
      ),
    ),
    ["deleteRelease.isPending", "deleteRelease.isPaused"],
  );
  for (const line of [
    '  const { isPending }: Pick<M, "isPending"> = useDeleteRelease(repoPath);',
    "  const { isPending, variables: { tag } = {} } = useDeleteRelease(repoPath);",
    "  const { variables: { tag } = {}, isPaused: parked } = deleteRelease;",
  ]) {
    const { violations } = rvRun(rvView(line));
    assert.equal(violations.length, 1, line);
    assert.match(violations[0].form, /^destructure/, line);
  }
});

test("reused-view-pending reads template interpolation as code, its text as text", () => {
  assert.deepEqual(
    rvReads(rvView("  const t = `held ${deleteRelease.isPending} now`;")),
    ["deleteRelease.isPending"],
  );
  assert.deepEqual(
    rvReads(rvView("  const t = `deleteRelease.isPending`;")),
    [],
  );
});

test("reused-view-pending masks regex literals and JSX text", () => {
  assert.deepEqual(
    rvReads(rvView("  const r = /deleteRelease.isPending/.test(s);")),
    [],
  );
  assert.deepEqual(
    rvReads(rvView("  const j = <p>deleteRelease.isPending</p>;")),
    [],
  );
  assert.deepEqual(
    rvReads(rvView("  const j = <p>{deleteRelease.isPending}</p>;")),
    ["deleteRelease.isPending"],
  );
});

test("reused-view-pending reads a chained receiver as its whole chain", () => {
  const entry = rvEntry({ props: ["isPending"] });
  for (const line of [
    "  const a = ops.deleteRelease.isPending;",
    "  const b = props?.deleteRelease!.isPending;",
  ]) {
    const { violations } = rvRun(
      rvView(`${line}\n  const own = deleteRelease.isPending;`),
      [entry],
    );
    assert.equal(violations.length, 1, line);
    assert.match(violations[0].receiver, /\.deleteRelease$/, line);
  }
});

test("reused-view-pending reads a non-null status and a typed hook binding", () => {
  assert.deepEqual(
    rvReads(rvView('  const a = deleteRelease!.status === "pending";')),
    ["deleteRelease.status"],
  );
  assert.deepEqual(
    rvReads(
      'export function V() {\n  const t: UseMutationResult<A, B> = useCreatePr();\n  const p = t.status === "pending";\n}\n',
    ),
    ["t.status"],
  );
});

test("reused-view-pending reads a key inside a one-level nested pattern", () => {
  assert.deepEqual(
    rvReads(rvView("  const { createPr: { isPending } } = ops;")),
    ["ops.isPending"],
  );
  assert.deepEqual(
    rvReads(rvView("  const { variables: { tag } = {} } = deleteRelease;")),
    [],
  );
});

test("reused-view-pending bans aliased, namespaced and imperative mutation counts", () => {
  for (const [label, src] of [
    [
      "alias",
      'import { useMutationState as useMS } from "@tanstack/react-query";\n' +
        rvView("  const s = useMS({});"),
    ],
    ["namespace", rvView("  const n = RQ.useIsMutating();")],
    [
      "imperative",
      rvView("  const n = queryClient.isMutating({ mutationKey });"),
    ],
    ["hook twin", rvView("  const n = useQueryClient().isMutating();")],
  ]) {
    const { violations } = rvRun(src);
    assert.deepEqual(
      violations.map((r) => r.form),
      ["banned-call"],
      label,
    );
  }
});

test("reused-view-pending fails a member with no named top-level declaration", () => {
  for (const src of [
    "",
    "   \n\n",
    'export { TagDetailView } from "./x";\n',
    'export * from "./Moved";\n',
  ]) {
    assert.match(
      rvRun(src).errors.join("\n"),
      /no top-level declaration to scan \(empty, or a re-export stub\)/,
      JSON.stringify(src),
    );
  }
});

test("reused-view-pending scans arrow-const and memo components", () => {
  for (const src of [
    "export const View = () => {\n  return null;\n};\n",
    "export const View = memo(function View() {\n  return null;\n});\n",
  ])
    assert.deepEqual(rvRun(src).errors, [], src);
});

test("reused-view-pending flags a spread of a whole hook result only", () => {
  assert.deepEqual(
    rvReads(rvView("  const el = <Child {...deleteRelease} />;")),
    ["deleteRelease...."],
  );
  for (const line of [
    "  const o = { ...deleteRelease, extra: 1 };",
    "  report(...deleteRelease);",
  ])
    assert.deepEqual(rvReads(rvView(line)), ["deleteRelease...."], line);
  // A field destructured from a hook is not the hook's result.
  assert.deepEqual(
    rvReads(
      rvView(
        "  const { nativeProps } = useDisabledReason(x);\n  const el = <b {...nativeProps} />;",
      ),
    ),
    [],
  );
});

test("reused-view-pending resolves a banned alias past a comment in the import", () => {
  for (const imp of [
    'import {\n  // count writes\n  useIsMutating as uim,\n} from "@tanstack/react-query";\n',
    'import { /* c */ useIsMutating as uim } from "@tanstack/react-query";\n',
  ]) {
    const { violations } = rvRun(imp + rvView("  const n = uim();"));
    assert.deepEqual(
      violations.map((r) => r.form),
      ["banned-call"],
      imp,
    );
  }
  // An alias imported from another module is not the banned hook.
  assert.deepEqual(
    rvRun(
      'import { useIsMutating as uim } from "./local";\n' +
        rvView("  const n = uim();"),
    ).violations,
    [],
  );
});

test("reused-view-pending treats a hook destructure's rest element as the result", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        "  const { data, ...rest } = useUpdateIssue();\n  const el = <C {...rest} />;",
      ),
    ),
    ["rest...."],
  );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const { data, ...rest } = useUpdateIssue();\n  const p = rest.status === "pending";',
      ),
    ),
    ["rest.status"],
  );
});

test("reused-view-pending reads a parenthesised or cast spread operand", () => {
  for (const line of [
    "  const el = <C {...(deleteRelease as Props)} />;",
    "  const o = { ...(deleteRelease) };",
    "  const o = { ...(deleteRelease as unknown as Props) };",
  ])
    assert.deepEqual(rvReads(rvView(line)), ["deleteRelease...."], line);
  // A field of the result is spread, not the result.
  assert.deepEqual(
    rvReads(rvView("  const a = [...(deleteRelease.data ?? [])];")),
    [],
  );
});

test("reused-view-pending pins only a const binding", () => {
  const src =
    "export function TagDetailView() {\n  let deleteRelease = useDeleteRelease(repoPath);\n  deleteRelease = useOther();\n  const p = deleteRelease.isPaused;\n}\n";
  assert.match(
    rvRun(src, [rvEntry()]).stale.join("\n"),
    /no longer bound from useDeleteRelease/,
  );
});

test("reused-view-pending reads a namespaced hook call as a hook result", () => {
  assert.deepEqual(
    rvReads(
      rvView("  const m = api.useUpdateIssue();\n  const el = <C {...m} />;"),
    ),
    ["m...."],
  );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const m = api.useUpdateIssue();\n  const p = m.status === "pending";',
      ),
    ),
    ["m.status"],
  );
});

// Shapes the masker must read as code, shared by the two tests below.
const MASKER_SHAPES = {
  nonNullDivision: rvView(
    "  return total! / 2 + Number(deleteRelease.isPending) / 3;",
  ),
  nonNullCompare: rvView(
    "  const few = count! < 3;\n  return few && deleteRelease.isPending;",
  ),
  keywordProperty: rvView(
    "  return size.in / 2 + Number(deleteRelease.isPending) / 3;",
  ),
  crlfContinuation: `export function TagDetailView() {\r\n  const deleteRelease = useDeleteRelease(repoPath);\r\n  const s = "a${String.fromCharCode(92)}\r\nb";\r\n  return deleteRelease.isPaused;\r\n}\r\n`,
  bom: `\uFEFF${rvView("  return deleteRelease.isPaused;")}`,
  templateColumnZero: rvView(
    "  const s = `head\n${deleteRelease.title}\ntail`;\n  return deleteRelease.isPaused;",
  ),
};

test("reused-view-pending: the masker reads a postfix `!` and a keyword property as operands", () => {
  for (const src of [
    MASKER_SHAPES.nonNullDivision,
    MASKER_SHAPES.nonNullCompare,
    MASKER_SHAPES.keywordProperty,
  ])
    assert.deepEqual(rvReads(src), ["deleteRelease.isPending"], src);
});

test("reused-view-pending: a CRLF line continuation, a BOM and a column-0 `${` scan clean", () => {
  for (const src of [
    MASKER_SHAPES.crlfContinuation,
    MASKER_SHAPES.bom,
    MASKER_SHAPES.templateColumnZero,
  ])
    assert.deepEqual(
      rvRun(src, [rvEntry()]),
      { violations: [], stale: [], errors: [] },
      JSON.stringify(src.slice(0, 40)),
    );
});

test("reused-view-pending reads nested and arrow-typed generic arguments", () => {
  for (const call of [
    "useMutation<Foo<Bar>, Error, Vars>({})",
    "useMutation<A<B<C>>>({})",
    "useMutation<(a: A) => B>({})",
  ]) {
    assert.deepEqual(
      rvReads(rvView(`  const m = ${call};\n  return <C {...m} />;`)),
      ["m...."],
      call,
    );
    assert.deepEqual(
      rvReads(rvView(`  const m = ${call};\n  return m.status === "pending";`)),
      ["m.status"],
      call,
    );
  }
  assert.deepEqual(
    rvReads(
      rvView(
        "  const { mutate, ...rest } = useMutation<Foo<Bar>>({});\n  return <C {...rest} />;",
      ),
    ),
    ["rest...."],
  );
  for (const src of [
    rvView(
      "  const s = useMutationState<MutationState<unknown, Error, V>>({});",
    ),
    'import { useMutationState as ms } from "@tanstack/react-query";\n' +
      rvView("  const s = ms<Array<string>>({});"),
    rvView("  return qc.isMutating<MutationFilters>({});"),
  ])
    assert.deepEqual(
      rvRun(src).violations.map((r) => r.form),
      ["banned-call"],
      src,
    );
  // A pinned binding called with a nested generic still satisfies its pin.
  assert.deepEqual(
    rvRun(
      "export function TagDetailView() {\n  const deleteRelease = useDeleteRelease<Foo<Bar>>(repoPath);\n  return deleteRelease.isPaused;\n}\n",
      [rvEntry()],
    ),
    { violations: [], stale: [], errors: [] },
  );
});

test("reused-view-pending tracks a rest element beside a nested or defaulted key", () => {
  for (const pattern of ["{ data: { x }, ...rest }", "{ data = {}, ...rest }"])
    assert.deepEqual(
      rvReads(
        rvView(`  const ${pattern} = useX();\n  return <C {...rest} />;`),
      ),
      ["rest...."],
      pattern,
    );
  // A nested pattern's own rest is a field of that field, not the result.
  assert.deepEqual(
    rvReads(
      rvView(
        "  const { data: { ...inner } } = useX();\n  return <C {...inner} />;",
      ),
    ),
    [],
  );
});

test("reused-view-pending binds a hook result after a comma in a declaration", () => {
  assert.deepEqual(
    rvReads(rvView("  const a = 1,\n    m = useX();\n  return <C {...m} />;")),
    ["m...."],
  );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const n = useY(),\n    m = useX();\n  return m.status === "pending";',
      ),
    ),
    ["m.status"],
  );
  // An object key after a comma is not a declarator.
  assert.deepEqual(
    rvReads(
      rvView(
        "  const o = useZ({ a, provider: forge.data });\n  const s = useS();\n  return { ...(provider === 1 ? {} : {}) };",
      ),
    ),
    [],
  );
});

test("reused-view-pending reads a chained status receiver by its root", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        '  const ops = useOps();\n  return ops.save.status === "pending";',
      ),
    ),
    ["ops.save.status"],
  );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const { a, ...rest } = useX();\n  return rest.inner.status === "pending";',
      ),
    ),
    ["rest.inner.status"],
  );
});

test("reused-view-pending reads optional-chained and multi-level namespaced hooks", () => {
  for (const call of ["api?.useX()", "a.b.useX()"])
    assert.deepEqual(
      rvReads(rvView(`  const m = ${call};\n  return <C {...m} />;`)),
      ["m...."],
      call,
    );
});

test("reused-view-pending bans a banned name as a bracket key", () => {
  for (const line of [
    '  return qc["isMutating"]();',
    "  return RQ['useIsMutating']();",
    "  return RQ[`useMutationState`]({});",
  ])
    assert.deepEqual(
      rvRun(rvView(line)).violations.map((r) => r.form),
      ["banned-call"],
      line,
    );
});

test("reused-view-pending admits an alias call only as a call", () => {
  const head =
    'import { useIsMutating as busy } from "@tanstack/react-query";\n';
  for (const line of [
    "  return editor.busy();",
    "  const o = { busy() { return 1; } };",
  ])
    assert.deepEqual(rvRun(head + rvView(line)).violations, [], line);
  assert.deepEqual(
    rvRun(head + rvView("  return busy();")).violations.map((r) => r.form),
    ["banned-call"],
  );
});

test("reused-view-pending: a field of a cast hook result is not a whole spread", () => {
  assert.deepEqual(
    rvReads(rvView("  return <C {...(deleteRelease as X).data} />;")),
    [],
  );
});

test("reused-view-pending fails an admitted prop no read uses", () => {
  const { stale } = rvRun(rvView("  const p = deleteRelease.isPaused;"), [
    rvEntry({ props: ["isPaused", "isPending"] }),
  ]);
  assert.deepEqual(stale, [
    `${RV_FILE} TagDetailView: deleteRelease.isPending admits no read (unused allowlist entry)`,
  ]);
});

test("reused-view-pending pins a destructure to its binding itself, at the top level", () => {
  const pin = rvEntry({ receiver: "parents", binding: "choice" });
  const run = (line) =>
    rvRun(
      `export function TagDetailView() {\n${line}\n  return parents.isPaused;\n}\n`,
      [pin],
    );
  assert.match(
    run("  const { parents } = choice.revertTarget;").stale.join("\n"),
    /no longer bound from choice/,
  );
  assert.match(
    run("  const { meta: { parents } } = choice;").stale.join("\n"),
    /no longer bound from choice/,
  );
  for (const line of [
    "  const { parents }: MainlineChoice = choice;",
    "  const { meta: { label }, parents } = choice;",
  ])
    assert.deepEqual(run(line).stale, [], line);
  // A namespaced hook satisfies a direct pin.
  assert.deepEqual(
    rvRun(
      "export function TagDetailView() {\n  const deleteRelease = queries.useDeleteRelease(repoPath);\n  return deleteRelease.isPaused;\n}\n",
      [rvEntry()],
    ).stale,
    [],
  );
});

test("reused-view-pending reports an unused entry beside a stale sibling", () => {
  const { stale } = rvRun(rvView("  return null;"), [
    rvEntry({ binding: "useOther", props: ["isPending"] }),
    rvEntry(),
  ]);
  assert.equal(stale.length, 2);
  assert.match(stale[0], /no longer bound from useOther/);
  assert.match(stale[1], /deleteRelease\.isPaused admits no read/);
});

test("reused-view-pending fails non-ASCII code, never JSX text", () => {
  assert.match(
    rvRun(
      rvView("  const ä = deleteRelease;\n  return ä.isPending;"),
    ).errors.join("\n"),
    /non-ASCII character in code at line 3/,
  );
  assert.deepEqual(
    rvRun(rvView("  return <p>Applying this change…</p>;")).errors,
    [],
  );
});

test("reused-view-pending keys a CLI file argument as the allowlist does", () => {
  const root = resolve("C:/repo");
  const member = "src/features/pulls/RemotePrView.tsx";
  for (const arg of [`./${member}`, member.toLowerCase(), join(root, member)])
    assert.equal(fileKey(root, arg, "win32"), member, arg);
  assert.equal(
    fileKey(root, member.toLowerCase(), "linux"),
    member.toLowerCase(),
  );
});

test("reused-view-pending: a status through a query's `data` is the entity's own", () => {
  for (const read of [
    "deleteRelease.data.status",
    "deleteRelease.data?.status",
    "deleteRelease?.data?.status",
  ])
    assert.deepEqual(
      rvReads(rvView(`  return ${read} === "pending";`)),
      [],
      read,
    );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const ops = useOps();\n  return ops.save.status === "pending";',
      ),
    ),
    ["ops.save.status"],
  );
});

test("reused-view-pending reads a reversed compare on a chained status", () => {
  assert.deepEqual(
    rvReads(
      rvView(
        '  const ops = useOps();\n  if ("pending" === ops.save.status) return null;',
      ),
    ),
    ["ops.save.status"],
  );
});

test("reused-view-pending keeps hook-bound names to their own component", () => {
  const src =
    'export function A() {\n  const run = useLatestRun(repo);\n  return run.data;\n}\n\nfunction B({ run }: { run: Run }) {\n  return run.status === "pending" ? <Spin /> : <C {...run} />;\n}\n';
  assert.deepEqual(rvReads(src), []);
  // The same shape bound by a hook in its own component still flags.
  assert.deepEqual(
    rvReads(
      'export function A() {\n  return null;\n}\n\nfunction B() {\n  const run = useLatestRun(repo);\n  return run.status === "pending" ? <Spin /> : <C {...run} />;\n}\n',
    ),
    ["run....", "run.status"],
  );
});

test("reused-view-pending pins a destructure only to the hook call itself", () => {
  const pin = rvEntry({ receiver: "details", binding: "usePrDetails" });
  const run = (line) =>
    rvRun(
      `export function TagDetailView() {\n${line}\n  return details.isPaused;\n}\n`,
      [pin],
    );
  assert.match(
    run("  const { details } = usePrDetails(id).x;").stale.join("\n"),
    /no longer bound from usePrDetails/,
  );
  assert.deepEqual(run("  const { details } = usePrDetails(id);").stale, []);
});

test("reused-view-pending: the masker reads a repeated or template postfix `!`", () => {
  for (const line of [
    "  return total!! / 2 + (deleteRelease.isPending ? 1 : 0) / 3;",
    "  return tag`x`! / 2 + deleteRelease.isPending / 3;",
  ])
    assert.deepEqual(rvReads(rvView(line)), ["deleteRelease.isPending"], line);
  // A prefix double-not still opens a regex.
  assert.deepEqual(
    rvReads(
      rvView("  return (!!/x.isPending/.test(s)) && deleteRelease.isPaused;"),
    ),
    ["deleteRelease.isPaused"],
  );
});

test("reused-view-pending scripts hold no invisible or bidi characters", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const invisible = new RegExp(
    `[${[0xfeff, 0x200b, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((c) => String.fromCharCode(c)).join("")}]`,
  );
  for (const file of ["check-reused-view-pending.mjs", "lib/ts-mask.mjs"])
    assert.ok(
      !invisible.test(readFileSync(join(dir, file), "utf8")),
      `${file} holds an invisible or bidi character`,
    );
});

test("reused-view-pending keys a mis-cased CLI argument on macOS too", () => {
  const member = "src/features/pulls/RemotePrView.tsx";
  assert.equal(fileKey(resolve("/r"), member.toLowerCase(), "darwin"), member);
});

test("reused-view-pending: a status read through a `data` binding is the entity's own", () => {
  for (const [bind, read] of [
    ["const { data: run } = useLatestRun(repo);", "run?.status"],
    ["const { data } = useLatestRun(repo);", "data?.status"],
    ["const run = useLatestRun(repo).data;", "run?.status"],
    ["const run = useLatestRun(repo)?.data;", "run.status"],
  ])
    assert.deepEqual(
      rvReads(rvView(`  ${bind}\n  return ${read} === "pending";`)),
      [],
      bind,
    );
  // The rest of the observer beside its data, and the observer itself, still read.
  assert.deepEqual(
    rvReads(
      rvView(
        '  const { data, ...rest } = useLatestRun(repo);\n  return rest.status === "pending";',
      ),
    ),
    ["rest.status"],
  );
  assert.deepEqual(
    rvReads(
      rvView(
        '  const run = useLatestRun(repo);\n  return run.status === "pending";',
      ),
    ),
    ["run.status"],
  );
});

test("reused-view-pending pins a binding only when it is the whole value", () => {
  const pin = rvEntry({ receiver: "parents", binding: "useChoice" });
  const run = (line) =>
    rvRun(
      `export function TagDetailView() {\n${line}\n  return parents.isPaused;\n}\n`,
      [pin],
    ).stale;
  for (const line of [
    "  const parents = useChoice(a).parents;",
    "  const parents = useChoice(a)?.parents;",
    "  const parents = useChoice(a) ?? other;",
    "  const parents = useChoice(a) || other;",
    "  const { parents } = useChoice(a) ?? fallback;",
  ])
    assert.match(run(line).join("\n"), /no longer bound from useChoice/, line);
  for (const line of [
    "  const parents = useChoice(a);",
    "  const { parents } = useChoice(a);",
    "  const { parents } = api.useChoice(a);",
  ])
    assert.deepEqual(run(line), [], line);
  const choicePin = rvEntry({ receiver: "parents", binding: "choice" });
  for (const line of [
    "  const { parents } = choice ?? other;",
    "  const { parents } = choice || other;",
  ])
    assert.match(
      rvRun(
        `export function TagDetailView() {\n${line}\n  return parents.isPaused;\n}\n`,
        [choicePin],
      ).stale.join("\n"),
      /no longer bound from choice/,
      line,
    );
});

test("reused-view-pending: a destructure of a hook's `data` binds the data", () => {
  for (const src of [
    rvView(
      '  const { run, jobs } = useRunDetail(repo, id).data ?? {};\n  return run?.status === "pending";',
    ),
    rvView(
      "  const { title, ...rest } = useIssueDetails(repo, n).data ?? {};\n  return <Meta {...rest} />;",
    ),
    rvView(
      '  const { save, data } = useBundle(repo).data;\n  return save.status === "pending";',
    ),
    rvView(
      '  const run = useRun(repo)!.data;\n  return run.status === "pending";',
    ),
    rvView(
      '  const { run } = useRun(repo)!.data;\n  return run.status === "pending";',
    ),
    rvView(
      '  const run = useRun(repo).data!;\n  return run.status === "pending";',
    ),
  ])
    assert.deepEqual(rvReads(src), [], src);
  // Without the `.data` read, the destructure still binds the observer's keys.
  assert.deepEqual(
    rvReads(
      rvView(
        '  const { save, data } = useBundle(repo);\n  return save.status === "pending";',
      ),
    ),
    ["save.status"],
  );
});

test("reused-view-pending pins a destructure to a key, never a rename target", () => {
  const pin = (receiver, binding) => rvEntry({ receiver, binding });
  const stale = (line, entry) =>
    rvRun(
      `export function TagDetailView() {\n${line}\n  return ${entry.receiver}.isPaused;\n}\n`,
      [entry],
    ).stale;
  for (const [line, entry] of [
    ["  const { revert: parents } = choice;", pin("parents", "choice")],
    ["  const { data: parents } = choice;", pin("parents", "choice")],
    [
      "  const { mutation: details } = useBundle(repo);",
      pin("details", "useBundle"),
    ],
  ])
    assert.match(stale(line, entry).join("\n"), /no longer bound from/, line);
  for (const line of [
    "  const { parents } = choice;",
    "  const { parents = d } = choice;",
    "  const { a, parents } = choice;",
  ])
    assert.deepEqual(stale(line, pin("parents", "choice")), [], line);
});

test("reused-view-pending: the masker reads `of` as a name outside a for-of head", () => {
  for (const line of [
    "  const half = of / 2 + Number(deleteRelease.isPending) / 3;",
    "  return of / 2 + Number(deleteRelease.isPending) / 3;",
  ])
    assert.deepEqual(rvReads(rvView(line)), ["deleteRelease.isPending"], line);
  // After a for-of binding it is the keyword, so a regex follows.
  for (const line of [
    "  for (const x of /a.isPending/.exec(s) ?? []) use(x, deleteRelease.isPaused);",
    "  for (const [a, b] of /a.isPending/.exec(s) ?? []) use(b, deleteRelease.isPaused);",
  ])
    assert.deepEqual(rvReads(rvView(line)), ["deleteRelease.isPaused"], line);
  // A binding may itself be named `of`.
  assert.deepEqual(
    rvReads(
      rvView(
        "  for (const of of /deleteRelease.isPending/.exec(s) ?? []) use(of);",
      ),
    ),
    [],
  );
  // An `of` after the for-of keyword is a name, so a division follows it.
  assert.deepEqual(
    rvReads(
      rvView(
        "  for (const x of of / Number(deleteRelease.isPending) / 3 > 1 ? a : b) use(x);",
      ),
    ),
    ["deleteRelease.isPending"],
  );
  // A member target named `of` is the for-of target, so the keyword and a regex
  // follow it.
  for (const line of [
    "  for (obj.of of /deleteRelease.isPending/.exec(s) ?? []) use(obj.of);",
    "  for (a.b.of of /[\"']/.source) use(a.b.of);",
  ]) {
    assert.deepEqual(rvRun(rvView(line)).errors, [], line);
    assert.deepEqual(rvReads(rvView(line)), [], line);
  }
});

// ---------------------------------------------------- mcp-secret-keychain-sites

const MCP_CHECK = CHECKS.find((c) => c.name === "mcp-secret-keychain-sites");
const MCP_BS = String.fromCharCode(92);
const MCP_DRAFT = "src/features/settings/McpServersSection.tsx";
const MCP_API = "src/lib/git/api/mcp.ts";
const MCP_SCREEN = "src/features/settings/SettingsScreen.tsx";

/** The scan of `lines` (joined with LF) as `file`, sorted. */
function mcpScan(file, lines) {
  return MCP_CHECK.scan(view(lines.join("\n")), file).sort((a, b) => a - b);
}

/** `lines` with line `n` (1-based) replaced by `insert` (none deletes it). */
function mcpSwap(lines, n, ...insert) {
  return [...lines.slice(0, n - 1), ...insert, ...lines.slice(n)];
}

/** `lines` with `insert` added after line `n` (1-based). */
function mcpAfter(lines, n, ...insert) {
  return [...lines.slice(0, n), ...insert, ...lines.slice(n)];
}

const MCP_SET = "const failed = await flushMcpSecretSets(plan.flush);";
const MCP_DEL = "flushMcpSecretDeletes(deletes);";

/** mcp.ts's keychain definitions as the formatter lays them out. */
const MCP_API_BASE = [
  'import { invoke } from "../../tauri/invoke";', // 1
  "const mcpRef = (serverId: string, key: string) =>", // 2
  "  `mcp-server/${serverId}/${key}`;", // 3
  "", // 4
  "export const setMcpSecret = (serverId: string, key: string, value: string) =>", // 5
  "  COLD_START", // 6
  "    ? Promise.resolve(coldStartSetSecret(mcpRef(serverId, key), value))", // 7
  '    : invoke<void>("set_mcp_secret", { serverId, key, value });', // 8
  "", // 9
  "export const deleteMcpSecret = (serverId: string, key: string) =>", // 10
  "  COLD_START", // 11
  "    ? Promise.resolve(coldStartDeleteSecret(mcpRef(serverId, key)))", // 12
  '    : invoke<void>("delete_mcp_secret", { serverId, key });', // 13
  "", // 14
  "export const mcpSecretExists = (serverId: string, key: string) =>", // 15
  "  COLD_START", // 16
  "    ? Promise.resolve(coldStartGetSecret(mcpRef(serverId, key)) !== null)", // 17
  '    : invoke<boolean>("mcp_secret_exists", { serverId, key });', // 18
];

/** SettingsScreen's Save as the formatter lays it out: the pinned import, the
 *  form options with a spread before onSubmit, and the real try/finally and
 *  if/else layout with a `${…}` toast template inside the body. */
const MCP_SCREEN_BASE = [
  "import {", // 1
  "  flushMcpSecretDeletes,", // 2
  "  flushMcpSecretSets,", // 3
  '} from "./mcp/flush-mcp-secrets";', // 4
  "export function SettingsScreen() {", // 5
  "  const form = useAppForm({", // 6
  "    ...settingsFormOpts,", // 7
  "    onSubmit: async ({ value }) => {", // 8
  "      saveLock.current = true;", // 9
  "      try {", // 10
  "        const plan = stagedSetFlushPlan({ staged, committed: value.x });", // 11
  `        ${MCP_SET}`, // 12
  "        if (failed.length > 0) {", // 13
  '          toast.error(`saved, ${failed.length} value${failed.length === 1 ? "" : "s"} failed`);', // 14
  "        } else {", // 15
  '          toast.success("Settings saved");', // 16
  "        }", // 17
  `        ${MCP_DEL}`, // 18
  "      } finally {", // 19
  "        saveLock.current = false;", // 20
  "      }", // 21
  "    },", // 22
  "  });", // 23
  "  function discard() {", // 24
  "    commitStaged([]);", // 25
  "  }", // 26
  "}", // 27
];

/** A decoy Save after the form: its statements must never satisfy the pins. */
const MCP_DECOY = [
  "  const decoy = {", // +1
  "    onSubmit: async () => {", // +2
  `      ${MCP_SET}`, // +3
  `      ${MCP_DEL}`, // +4
  "    },", // +5
  "  };", // +6
];

/** The base with the Save entry's header (line 8) swapped, and the decoy added
 *  after the form (it lands on lines 24-29, its statements on 26 and 27). */
const mcpDecoyed = (header) =>
  mcpAfter(mcpSwap(MCP_SCREEN_BASE, 8, header), 23, ...MCP_DECOY);

const MCP_FLUSH = "src/features/settings/mcp/flush-mcp-secrets.ts";

/** The flush module as the formatter lays it out. */
const MCP_FLUSH_BASE = [
  'import { deleteMcpSecret, setMcpSecret } from "@/lib/git/api";', // 1
  "import {", // 2
  "  createCallQueue,", // 3
  "  type McpSecretDelete,", // 4
  "  type McpSetFailure,", // 5
  "  type McpStagedSecret,", // 6
  '} from "./secret-ops";', // 7
  "", // 8
  "// The guard pins this module's code and lets only the settings screen", // 9
  "// import it.", // 10
  "", // 11
  "// One queue orders every keychain call this window issues.", // 12
  "", // 13
  "const inOrder = createCallQueue();", // 14
  "", // 15
  "/** Writes each staged value in turn and returns the failures. */", // 16
  "", // 17
  "", // 18
  "", // 19
  "export async function flushMcpSecretSets(", // 20
  "  sets: readonly McpStagedSecret[],", // 21
  "): Promise<McpSetFailure[]> {", // 22
  "  const failed: McpSetFailure[] = [];", // 23
  "  for (const entry of sets) {", // 24
  "    try {", // 25
  "      await inOrder(() => setMcpSecret(entry.serverId, entry.key, entry.value));", // 26
  "    } catch (error) {", // 27
  "      failed.push({ entry, error });", // 28
  "    }", // 29
  "  }", // 30
  "  return failed;", // 31
  "}", // 32
  "", // 33
  "/** Fires each delete without waiting, in queue order. */", // 34
  "", // 35
  "export function flushMcpSecretDeletes(", // 36
  "  deletes: readonly McpSecretDelete[],", // 37
  "): void {", // 38
  "  for (const { serverId, key } of deletes)", // 39
  "    void inOrder(() => deleteMcpSecret(serverId, key)).catch(() => undefined);", // 40
  "}", // 41
];

const MCP_FIXTURES = [
  // P1: names are read on raw source, so no lexing gap can hide a call.
  {
    name: "regex-slash-star-hides-call",
    file: MCP_DRAFT,
    lines: [
      `const p2 = p.replace(/${MCP_BS}/*$/, "");`,
      "await setMcpSecret(a, b, c);",
    ],
    expected: [2],
  },
  {
    name: "template-slash-star-hides-call",
    file: MCP_DRAFT,
    lines: [
      "const doc = `see",
      "docs/*",
      "here`;",
      "await setMcpSecret(a, b, c);",
    ],
    expected: [4],
  },
  {
    name: "regex-url-same-line",
    file: MCP_DRAFT,
    lines: [
      `const ok = /https?:${MCP_BS}/${MCP_BS}//.test(u) && setMcpSecret(a, b, c);`,
    ],
    expected: [1],
  },
  {
    name: "jsx-text-url-same-line",
    file: MCP_DRAFT,
    lines: ["const x = <p>See https://x.dev {String(setMcpSecret)}</p>;"],
    expected: [1],
  },
  {
    name: "line-continued-string",
    file: MCP_DRAFT,
    lines: [
      `const s = "first${MCP_BS}`,
      '// still the string"; void setMcpSecret(a, b, c);',
    ],
    expected: [2],
  },
  {
    name: "comment-mention-fails-closed",
    file: MCP_DRAFT,
    lines: ["const a = 1;", "// setMcpSecret used to run here"],
    expected: [2],
  },
  // P2/P4: every reach that names the module or a write command.
  {
    name: "flush-new-export-caller",
    file: MCP_DRAFT,
    lines: [
      'import { flushMcpSecret } from "./flush-mcp-secrets";',
      "flushMcpSecret(entry);",
    ],
    expected: [1],
  },
  {
    name: "flush-namespace-object-values",
    file: MCP_DRAFT,
    lines: [
      'import * as f from "./mcp/flush-mcp-secrets";',
      "for (const fn of Object.values(f)) void fn([]);",
    ],
    expected: [1],
  },
  {
    name: "flush-barrel-export-star",
    file: "src/features/settings/mcp/index.ts",
    lines: ['export * from "./flush-mcp-secrets";'],
    expected: [1],
  },
  {
    name: "flush-dynamic-import",
    file: MCP_DRAFT,
    lines: ["const m = await import(", '  "./mcp/flush-mcp-secrets"', ");"],
    expected: [2],
  },
  {
    name: "flush-require",
    file: MCP_DRAFT,
    lines: ['const m = require("./mcp/flush-mcp-secrets.ts");'],
    expected: [1],
  },
  {
    name: "plural-command-string",
    file: MCP_DRAFT,
    lines: ['await invoke("set_mcp_secrets", { serverId });'],
    expected: [1],
  },
  {
    name: "digit-command-string",
    file: MCP_DRAFT,
    lines: ['await invoke("set_mcp_secret_v2", { serverId });'],
    expected: [1],
  },
  {
    name: "read-only-command-stays-clean",
    file: MCP_DRAFT,
    lines: [
      'const ok = await invoke<boolean>("mcp_secret_exists", { serverId, key });',
      "const also = await mcpSecretExists(serverId, key);",
      "const setMcpSecrets = 1;",
    ],
    expected: [],
  },
  {
    name: "api-name-call",
    file: MCP_DRAFT,
    lines: ["void deleteMcpSecret(server.id, key).catch(() => undefined);"],
    expected: [1],
  },
  // P3: mcp.ts holds exactly its two pinned definitions.
  { name: "api-real-layout", file: MCP_API, lines: MCP_API_BASE, expected: [] },
  {
    name: "api-wrapper",
    file: MCP_API,
    lines: [
      ...MCP_API_BASE,
      "export const writeSecret = (a: string, b: string, c: string) =>",
      "  setMcpSecret(a, b, c);",
    ],
    expected: [20],
  },
  {
    name: "api-command-constant",
    file: MCP_API,
    lines: [...MCP_API_BASE, 'const SET_COMMAND = "set_mcp_secret";'],
    expected: [19],
  },
  {
    name: "api-second-invoke",
    file: MCP_API,
    lines: [
      ...MCP_API_BASE,
      "export const storeSecret = (serverId: string) =>",
      '  invoke<void>("delete_mcp_secret", { serverId });',
    ],
    expected: [20],
  },
  {
    name: "api-re-export-alias",
    file: MCP_API,
    lines: [...MCP_API_BASE, "export { setMcpSecret as writeMcpSecret };"],
    expected: [19],
  },
  {
    name: "api-renamed-definition",
    file: MCP_API,
    lines: mcpSwap(
      MCP_API_BASE,
      5,
      "export const putMcpSecret = (serverId: string, key: string, value: string) =>",
    ),
    expected: [1, 8],
  },
  {
    name: "api-definition-in-comment",
    file: MCP_API,
    lines: [
      ...mcpSwap(
        MCP_API_BASE,
        10,
        "export const removeMcpSecret = (serverId: string, key: string) =>",
      ),
      '// export const deleteMcpSecret = (serverId: string, key: string) => COLD_START ? Promise.resolve(coldStartDeleteSecret(mcpRef(serverId, key))) : invoke<void>("delete_mcp_secret", { serverId, key });',
    ],
    expected: [1, 13, 19],
  },
  // P5: the real Save in another syntax beside a decoy. The decoy's
  // statements (26, 27) never satisfy the pins; an unreadable Save fails line 1
  // and leaves its own statements (12, 18) unexempted.
  {
    name: "decoy-save-as-method",
    file: MCP_SCREEN,
    lines: mcpDecoyed("    async onSubmit({ value }) {"),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-as-function-expression",
    file: MCP_SCREEN,
    lines: mcpDecoyed("    onSubmit: async function ({ value }) {"),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-non-async-arrow",
    file: MCP_SCREEN,
    lines: mcpDecoyed("    onSubmit: ({ value }) => {"),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-quoted-key",
    file: MCP_SCREEN,
    lines: mcpDecoyed('    "onSubmit": async ({ value }) => {'),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-computed-key",
    file: MCP_SCREEN,
    lines: mcpDecoyed('    ["onSubmit"]: async ({ value }) => {'),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-return-typed",
    file: MCP_SCREEN,
    lines: mcpDecoyed("    onSubmit: async ({ value }): Promise<void> => {"),
    expected: [26, 27],
  },
  {
    name: "decoy-save-concise-body",
    file: MCP_SCREEN,
    lines: mcpAfter(
      mcpSwap(
        mcpSwap(MCP_SCREEN_BASE, 22, "    }),"),
        8,
        "    onSubmit: async ({ value }) => runSave(value, async () => {",
      ),
      23,
      ...MCP_DECOY,
    ),
    expected: [1, 12, 18, 26, 27],
  },
  {
    name: "decoy-save-shorthand",
    file: MCP_SCREEN,
    lines: [
      ...MCP_SCREEN_BASE.slice(0, 7),
      "    onSubmit,",
      "  });",
      "  async function onSubmit({ value }) {",
      ...MCP_SCREEN_BASE.slice(8, 21),
      "  }",
      ...MCP_DECOY,
      "}",
    ],
    expected: [1, 14, 20, 27, 28],
  },
  {
    name: "decoy-save-in-jsx-form",
    file: MCP_SCREEN,
    lines: [
      ...MCP_SCREEN_BASE.slice(0, 7),
      "  });",
      "  return (",
      "    <form",
      "      onSubmit={async () => {",
      `        ${MCP_SET}`,
      `        ${MCP_DEL}`,
      "      }}",
      "    />",
      "  );",
      "}",
    ],
    expected: [1, 12, 13],
  },
  {
    name: "decoy-in-validators",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      7,
      "    validators: {",
      "      onSubmit: async () => {",
      `        ${MCP_SET}`,
      `        ${MCP_DEL}`,
      "      },",
      "    },",
    ),
    expected: [10, 11],
  },
  // P5: the form options themselves must be readable.
  {
    name: "spread-after-onSubmit",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 22, "    ...extraOpts,"),
    expected: [1, 12, 18],
  },
  {
    name: "second-useAppForm",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      23,
      "  const other = useAppForm({ ...settingsFormOpts });",
    ),
    expected: [1, 12, 18],
  },
  {
    name: "onSubmit-not-literal-arg",
    file: MCP_SCREEN,
    lines: mcpSwap(
      mcpSwap(MCP_SCREEN_BASE, 23, "  };", "  const form = useAppForm(opts);"),
      6,
      "  const opts = {",
    ),
    expected: [1, 12, 18],
  },
  {
    name: "computed-key-in-form",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 7, "    [extraKey]: 1,"),
    expected: [1, 13, 19],
  },
  // P5/P6: real layouts that must stay clean.
  {
    name: "real-try-finally-if-else-layout",
    file: MCP_SCREEN,
    lines: MCP_SCREEN_BASE,
    expected: [],
  },
  {
    name: "return-typed-save",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      8,
      "    onSubmit: async ({ value }): Promise<() => void> => {",
    ),
    expected: [],
  },
  {
    name: "params-with-parens",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      8,
      "    onSubmit: async ({ value, meta = pick(value, (v) => v.x) }) => {",
    ),
    expected: [],
  },
  {
    name: "validators-onSubmit-alongside",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      7,
      "    validators: { onSubmit: ({ value }) => undefined },",
    ),
    expected: [],
  },
  {
    name: "jsx-form-onSubmit-alongside",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      26,
      "  return <form onSubmit={(e) => { e.preventDefault(); }}>x</form>;",
    ),
    expected: [],
  },
  {
    name: "interface-onSubmit-alongside",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      4,
      "interface Props { onSubmit: () => void }",
    ),
    expected: [],
  },
  {
    name: "spread-before-onSubmit",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 7, "    ...moreOpts,"),
    expected: [],
  },
  {
    name: "statement-on-brace-line",
    file: MCP_SCREEN,
    lines: mcpSwap(
      mcpSwap(MCP_SCREEN_BASE, 12),
      8,
      `    onSubmit: async ({ value }) => { ${MCP_SET}`,
    ),
    expected: [],
  },
  // P6: a pinned statement anywhere but directly in the Save body's blocks.
  {
    name: "closure-arrow-expr",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        discardFlush.current = () => ${MCP_DEL}`,
    ),
    expected: [19],
  },
  {
    name: "closure-block",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        pending.current = async () => { ${MCP_SET} };`,
    ),
    expected: [19],
  },
  {
    name: "settimeout-callback",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        setTimeout(() => { ${MCP_DEL} }, 60000);`,
    ),
    expected: [19],
  },
  {
    name: "void-prefixed-call",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 18, `        void ${MCP_DEL}`),
    expected: [19],
  },
  {
    name: "if-guarded-call",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 18, `        if (retry) ${MCP_DEL}`),
    expected: [19],
  },
  {
    name: "statement-in-template-string",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        const note = \`${MCP_DEL}\`;`,
    ),
    expected: [19],
  },
  {
    // A copy after `;` inside a string reads as a statement on raw source.
    name: "statement-copy-in-string",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        const note = "done; ${MCP_DEL}";`,
    ),
    expected: [19],
  },
  {
    name: "statement-copy-in-string-replaces-real",
    file: MCP_SCREEN,
    lines: mcpAfter(
      mcpSwap(MCP_SCREEN_BASE, 18),
      17,
      `        const note = "done; ${MCP_DEL}";`,
    ),
    expected: [1, 18],
  },
  {
    name: "case-block",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      18,
      `        switch (mode) { case 1: { ${MCP_DEL} } }`,
    ),
    expected: [19],
  },
  {
    name: "pinned-statement-twice-in-body",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 18, `        ${MCP_DEL}`),
    expected: [1, 18, 19],
  },
  {
    name: "delete-moved-into-discard",
    file: MCP_SCREEN,
    lines: mcpAfter(mcpSwap(MCP_SCREEN_BASE, 18), 24, `    ${MCP_DEL}`),
    expected: [1, 25],
  },
  {
    name: "second-call-in-discard",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      25,
      `    ${MCP_DEL}`,
      "    void flushMcpSecretSets(stagedRef.current);",
    ),
    expected: [26, 27],
  },
  {
    name: "api-call-in-screen",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      25,
      '    void setMcpSecret("id", "KEY", "test-value-1");',
    ),
    expected: [26],
  },
  {
    name: "missing-import",
    file: MCP_SCREEN,
    lines: MCP_SCREEN_BASE.slice(4),
    expected: [1],
  },
  {
    name: "unlexable-screen",
    file: MCP_SCREEN,
    lines: [...MCP_SCREEN_BASE, "const x = `open"],
    expected: [1, 2, 3, 4, 12, 18],
  },
  // F1: a binding-free catch is a block, the repo's idiom.
  {
    name: "catch-binding-free-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        try { void 0; } catch { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  {
    name: "catch-with-binding-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        try { void 0; } catch (err) { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  // F2: a brace after `}` is a block only when that `}` closed a block.
  {
    name: "function-object-return-type",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        function later(): { ok: true } { ${MCP_DEL} return { ok: true }; } setTimeout(later, 1000);`,
    ),
    expected: [1, 18],
  },
  {
    name: "function-expression-object-return-type",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        const later = function (): { ok: true } { ${MCP_DEL} return { ok: true }; }; window.addEventListener("blur", later);`,
    ),
    expected: [1, 18],
  },
  {
    name: "function-union-return-type",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        function later(): null | { n: number } { ${MCP_DEL} return null; } setTimeout(later, 1000);`,
    ),
    expected: [1, 18],
  },
  {
    name: "function-object-return-type-multiline",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      "        function later(): {",
      "          ok: true;",
      "        } {",
      `          ${MCP_DEL}`,
      "          return { ok: true };",
      "        }",
      "        setTimeout(later, 1000);",
    ),
    expected: [1, 21],
  },
  {
    name: "bare-block-after-if-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        if (x) { void 0; } { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  // F3: function closures never count as blocks.
  {
    name: "function-declaration-closure",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        function finish() { ${MCP_DEL} } queueMicrotask(finish);`,
    ),
    expected: [1, 18],
  },
  {
    name: "function-expression-closure",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        const finish = function () { ${MCP_DEL} };`,
    ),
    expected: [1, 18],
  },
  {
    name: "async-function-closure",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        async function finish() { ${MCP_DEL} }`,
    ),
    expected: [1, 18],
  },
  // F4: useAppForm type arguments the walk can't read fail closed.
  {
    name: "unreadable-type-args-on-the-save",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      6,
      "  const form = useAppForm<{ a: string; b: number }>({",
    ),
    expected: [1, 12, 18],
  },
  {
    name: "unreadable-type-args-on-a-second-call",
    file: MCP_SCREEN,
    lines: mcpAfter(
      MCP_SCREEN_BASE,
      23,
      "  const other = useAppForm<{ a: string; b: number }>({ ...settingsFormOpts });",
    ),
    expected: [1, 12, 18],
  },
  // F5: a comment inside a pinned Save statement voids the match.
  {
    name: "block-comment-inside-save-statement",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      12,
      "        const failed = /* flushMcpSecretDeletes(x) */ await flushMcpSecretSets(plan.flush);",
    ),
    expected: [1, 12],
  },
  {
    name: "line-comment-inside-save-statement",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      12,
      "        const failed = // was flushMcpSecretDeletes(x)",
      "          await flushMcpSecretSets(plan.flush);",
    ),
    expected: [1, 12, 13],
  },
  // F6: the flush module's code is pinned; nothing else there may name a token.
  {
    name: "flush-module-real-layout",
    file: MCP_FLUSH,
    lines: MCP_FLUSH_BASE,
    expected: [],
  },
  {
    name: "flush-module-scope-listener",
    file: MCP_FLUSH,
    lines: [
      ...MCP_FLUSH_BASE,
      'window.addEventListener("blur", () => void flushMcpSecretSets(x));',
    ],
    expected: [42],
  },
  {
    name: "flush-module-deferred-retry",
    file: MCP_FLUSH,
    lines: mcpAfter(
      MCP_FLUSH_BASE,
      26,
      "      setTimeout(() => void setMcpSecret(a, b, c), 5000);",
    ),
    expected: [1, 20, 26, 27],
  },
  {
    // The queue binding is pinned: a wrapped or passthrough queue would let a
    // delete land after a later set of the same pair.
    name: "flush-module-queue-retry",
    file: MCP_FLUSH,
    lines: mcpSwap(
      MCP_FLUSH_BASE,
      14,
      "const inOrder = withRetry(createCallQueue());",
    ),
    expected: [1],
  },
  {
    name: "flush-module-queue-passthrough",
    file: MCP_FLUSH,
    lines: mcpSwap(
      MCP_FLUSH_BASE,
      14,
      "const inOrder = <T,>(call: () => Promise<T>) => call();",
    ),
    expected: [1],
  },
  {
    name: "flush-module-queue-per-call",
    file: MCP_FLUSH,
    lines: mcpSwap(
      MCP_FLUSH_BASE,
      14,
      "const inOrder = <T,>(call: () => Promise<T>) => createCallQueue()(call);",
    ),
    expected: [1],
  },
  {
    name: "flush-module-comment-inside-pin",
    file: MCP_FLUSH,
    lines: mcpAfter(MCP_FLUSH_BASE, 30, "  // retried by the caller"),
    expected: [1, 20, 26],
  },
  // F8: documented rules, each on the real-file layout.
  {
    name: "duplicate-onSubmit-identifier",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 22, "    onSubmit: async () => {},"),
    expected: [1, 12, 18],
  },
  {
    name: "duplicate-onSubmit-quoted",
    file: MCP_SCREEN,
    lines: mcpAfter(MCP_SCREEN_BASE, 22, '    "onSubmit": async () => {},'),
    expected: [1, 12, 18],
  },
  {
    name: "while-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        while (again) { ${MCP_DEL} break; }`,
    ),
    expected: [],
  },
  {
    name: "do-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        do { ${MCP_DEL} } while (false);`,
    ),
    expected: [],
  },
  {
    name: "for-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        for (const d of [deletes]) { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  {
    name: "for-await-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        for await (const d of stream) { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  {
    name: "bare-block-after-semicolon",
    file: MCP_SCREEN,
    lines: mcpSwap(MCP_SCREEN_BASE, 18, `        void 0; { ${MCP_DEL} }`),
    expected: [],
  },
  {
    name: "else-if-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        if (a) { void 0; } else if (b) { ${MCP_DEL} }`,
    ),
    expected: [],
  },
  {
    name: "save-entry-tail-as-cast",
    file: MCP_SCREEN,
    lines: mcpSwap(MCP_SCREEN_BASE, 22, "    } as SubmitFn,"),
    expected: [1, 12, 18],
  },
  {
    name: "class-static-block",
    file: MCP_SCREEN,
    lines: mcpSwap(
      MCP_SCREEN_BASE,
      18,
      `        class Later { static { ${MCP_DEL} } }`,
    ),
    expected: [1, 18],
  },
];

for (const { name, file, lines, expected } of MCP_FIXTURES)
  test(`mcp-secret-keychain-sites: ${name}`, () => {
    assert.deepEqual(mcpScan(file, lines), expected);
  });

test("mcp-secret-keychain-sites pins, allowlist and scope", () => {
  assert.deepEqual(MCP_FLUSH_CALLER, {
    file: "src/features/settings/SettingsScreen.tsx",
    imports: [
      'import { flushMcpSecretDeletes, flushMcpSecretSets, } from "./mcp/flush-mcp-secrets";',
    ],
    onSubmit: [MCP_SET, MCP_DEL],
  });
  assert.equal(MCP_SECRET_API.file, "src/lib/git/api/mcp.ts");
  assert.equal(MCP_SECRET_API.definitions.length, 2);
  assert.deepEqual([...MCP_SECRET_READ_ONLY], ["mcp_secret_exists"]);
  assert.equal(MCP_FLUSH_MODULE.file, MCP_FLUSH);
  assert.equal(MCP_FLUSH_MODULE.statements.length, 4);
  assert.equal(
    MCP_FLUSH_MODULE.statements[1],
    "const inOrder = createCallQueue();",
  );
  assert.deepEqual(MCP_CHECK.allowlist, []);
  assert.deepEqual(MCP_CHECK.expectScanned, {
    atLeast: 500,
    hint: "every .ts/.tsx under src/",
  });
  for (const file of [
    MCP_SCREEN,
    MCP_DRAFT,
    MCP_API,
    "src/lib/git/api/secrets.ts",
    "src/features/agent/x.tsx",
  ])
    assert.equal(MCP_CHECK.appliesTo(file), true, file);
});

test("mcp-secret-keychain-sites passes the real files with no allowlist row", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    MCP_SCREEN,
    MCP_API,
    "src/features/settings/mcp/flush-mcp-secrets.ts",
  ];
  const views = new Map(
    files.map((f) => [f, view(readFileSync(join(root, f), "utf8"))]),
  );
  const { violations, stale } = runCheck(MCP_CHECK, files, views);
  assert.deepEqual(violations, []);
  assert.deepEqual(stale, []);
  // Every pinned file scans clean on its own, the flush module included.
  for (const f of files)
    assert.deepEqual(MCP_CHECK.scan(views.get(f), f), [], f);
});

test("mcp-secret-keychain-sites: the flush module's extra code violates under runCheck", () => {
  const lines = [
    ...MCP_FLUSH_BASE,
    'window.addEventListener("blur", () => void flushMcpSecretSets(x));',
  ];
  const { violations, stale } = runCheck(
    MCP_CHECK,
    [MCP_FLUSH],
    new Map([[MCP_FLUSH, view(lines.join("\n"))]]),
  );
  assert.deepEqual(violations, [`${MCP_FLUSH}:42`]);
  assert.deepEqual(stale, []);
});
