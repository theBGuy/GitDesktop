// Negative controls for the three guard scanners. Their worst failure mode is
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
import { test } from "node:test";

import {
  CHECKS,
  runCheck,
  stripComments,
  view,
} from "./check-banned-patterns.mjs";
import {
  parseInvoked,
  parseRegistered,
  staleAllowlistEntries as staleCommandEntries,
} from "./check-dead-surface.mjs";
import {
  checkCompareEndpoints,
  checkRefspecTemplates,
  checkSecretArgv,
  checkStderrOnlyGitError,
  checkSyncCommands,
  enclosingFn,
  staleAllowlistEntries,
} from "./check-rust-invariants.mjs";

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
const bareMutate = scanner("bare-mutate-in-converted-trees");
const menuSuppression = scanner("context-menu-suppression");
const loneActivity = scanner("lone-activity-boundary");
const seedOnOpen = scanner("seed-effect-on-open");
const diffStatPair = scanner("hand-rolled-diff-stat");
const nullFallback = scanner("null-suspense-fallback");

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
  // A SELF-BOUNDED span (explicit max-w) keeps its handler LIVE — TaskDialog's
  // interpreter-path sub-span. At close range it still pairs: the guard cannot
  // see width bounds, so this is the known false positive the allowlist
  // remedies. In the real tree the row's markup holds it ~2× outside the
  // window.
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
  // No live file trips the onError half today — every settings invalidate under
  // src/ is success-path. The gate is forward-looking: a file that refetches
  // settings from an onError with nothing optimistic to roll back stays clean.
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
  // The useApplyTheme shape this check exists to hold: latest-write guard, then
  // the snapshot written straight back.
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

test("bare-mutate-in-converted-trees flags every way a call reaches its callbacks", () => {
  // The reason this check matches the CALL and not the callbacks object: the
  // hoisted-options pair is the shape most of these sections used, and no
  // regex anchored on `onSuccess`/`onError` sees it.
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

test("bare-mutate-in-converted-trees flags a bare call carrying no callbacks", () => {
  // Deliberate: a fire-and-forget mutation here still loses nothing to the
  // unmount, but the ratchet stays a token match — an exemption is an
  // allowlist entry with rationale, not a hole in the pattern.
  assert.deepEqual(bareMutate("ping.mutate(hook.id);"), [1]);
  assert.deepEqual(bareMutate("refresh.mutate ();"), [1]);
});

test("bare-mutate-in-converted-trees catches the dot-less destructured route", () => {
  // `const { mutate } = useX()` reaches the same call with no `.mutate` token
  // for the first pattern to see — a live idiom elsewhere under src/.
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

test("bare-mutate-in-converted-trees leaves the awaited idiom and comments alone", () => {
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

test("bare-mutate-in-converted-trees applies to the converted trees only", () => {
  // The tier boundary is the deliberate part: the converted trees are in, and
  // the ones still carrying per-call callbacks in bulk are out until their own
  // conversion lands. Widening this is a decision, not a drive-by.
  const { appliesTo } = CHECKS.find(
    (c) => c.name === "bare-mutate-in-converted-trees",
  );
  for (const file of [
    "src/features/repo-settings/RulesetsSection.tsx",
    "src/features/explore/ExploreDetail.tsx",
    "src/features/actions/RunDetailView.tsx",
  ]) {
    assert.equal(appliesTo(file), true, `should scan ${file}`);
  }
  for (const file of [
    "src/features/pulls/LocalPrView.tsx",
    "src/features/repository/ChangesPanel.tsx",
  ]) {
    assert.equal(appliesTo(file), false, `should not scan ${file}`);
  }
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

test("null-suspense-fallback flags the literal on one line or wrapped", () => {
  assert.deepEqual(nullFallback("<Suspense fallback={null}>{kids}</Suspense>"), [
    1,
  ]);
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
    const src = ["fn build() -> String {", `    format!("${template}")`, "}"].join(
      "\n",
    );
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
    const src = ["fn build() -> String {", `    format!("${template}")`, "}"].join(
      "\n",
    );
    const hits = [];
    checkCompareEndpoints("fixture.rs", src, src.split("\n"), hits);
    assert.deepEqual(hits, [], `should ignore ${template}`);
  }
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
