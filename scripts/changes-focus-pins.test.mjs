// Pins the Changes list's keyboard-focus contracts. Rows rove one tab stop
// (folder rows, file rows and each file row's toggle button all read it, so no
// row carries a literal tabIndex 0). Vertical arrows focus through the panel's
// `focusRow`, never the shared helper's `rowKey`, whose focus skips a row the
// virtualizer has not mounted. A view flip dispatched from the palette keeps
// its focus claim while the closing dialog holds focus: the three flip arms
// treat dialog focus as landable, and the claim waits rather than retiring.
// The palette's AI resolve re-reads status before it starts anything, with the
// repo-switch refusal between the read and every start.
//
// A source scan over MASKED code (comments and string text blanked), since the
// panel only runs inside a React render; string comparisons read the source at
// the same offsets. Every lookup that finds nothing fails, and each behavior
// pin carries an in-memory mutation control proving it rejects the old shape.
//
// Runs in CI's installless `guards` job, so node built-ins ONLY.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CLOSE, maskNonCode, matchBrace, OPEN } from "./lib/ts-mask.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = "src/features/repository/ChangesPanel.tsx";
const ROW = "src/features/repository/FileRow.tsx";

function fromSource(source) {
  return { source, masked: maskNonCode(source, true) };
}

function load(file) {
  return fromSource(readFileSync(join(REPO_ROOT, file), "utf8"));
}

/** Whitespace-insensitive pattern over a literal snippet. */
function loose(snippet) {
  const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, String.raw`\s*`), "g");
}

/** The `[open, close]` brace offsets of `function name(…) {…}`'s body, or null. */
function functionBody(src, name) {
  const at = src.masked.search(new RegExp(String.raw`\bfunction ${name}\(`));
  if (at === -1) return null;
  const paren = src.masked.indexOf("(", at);
  const parenClose = matchBrace(src.masked, paren);
  if (parenClose === -1) return null;
  const open = src.masked.indexOf("{", parenClose);
  const close = matchBrace(src.masked, open);
  return close === -1 ? null : [open, close];
}

/** The top-level keys of the object literal opening at `open`. */
function topLevelKeys(masked, open) {
  const close = matchBrace(masked, open);
  const keys = [];
  for (let i = open + 1, depth = 0; i < close; i++) {
    const ch = masked[i];
    if (OPEN.has(ch)) depth++;
    else if (CLOSE.has(ch)) depth--;
    else if (depth === 0 && /[\w$]/.test(ch) && !/[\w$.]/.test(masked[i - 1])) {
      const key = /^([\w$]+)\s*[:,}]/.exec(masked.slice(i, close + 1));
      if (key) keys.push({ name: key[1], at: i });
      while (/[\w$]/.test(masked[i + 1])) i++;
    }
  }
  return { keys, close };
}

/** Failures for the roving tab stop (empty = pinned). */
function rovingFailures(panel, row) {
  const failures = [];
  if (loose("tabIndex={0}").test(panel.masked))
    failures.push("ChangesPanel carries a literal tabIndex={0}");
  if (loose("tabIndex={0}").test(row.masked))
    failures.push("FileRow carries a literal tabIndex={0}");
  if (!/\bconst tabStopKey\b/.test(panel.masked))
    failures.push("ChangesPanel declares no tabStopKey");
  if (
    !loose("tabIndex={rowKeyOf(row) === tabStopKey ? 0 : -1}").test(
      panel.masked,
    )
  )
    failures.push("the folder row's tabIndex doesn't read tabStopKey");
  if (
    !loose("tabStop={keyOf(row.entry.path, row.staged) === tabStopKey}").test(
      panel.masked,
    )
  )
    failures.push("FileRow's call site doesn't derive tabStop from tabStopKey");
  if (!loose("tabStop: boolean;").test(row.masked))
    failures.push("FileRow declares no boolean tabStop prop");
  const reads = row.masked.match(loose("tabIndex={tabStop ? 0 : -1}")) ?? [];
  if (reads.length !== 2)
    failures.push(
      `FileRow's row div and toggle button should both read tabStop (${reads.length} found)`,
    );
  return failures;
}

/** Failures for the vertical arrows' focus routing (empty = pinned). */
function navRoutingFailures(panel) {
  const calls = [...panel.masked.matchAll(/\blistKeyboardNav\(/g)];
  if (calls.length !== 1)
    return [`expected one listKeyboardNav call, found ${calls.length}`];
  const open = panel.masked.indexOf("{", calls[0].index);
  const { keys, close } = topLevelKeys(panel.masked, open);
  const failures = [];
  if (keys.some((k) => k.name === "rowKey"))
    failures.push(
      "listKeyboardNav still takes rowKey (its focus skips unmounted rows)",
    );
  const activate = keys.find((k) => k.name === "onActivate");
  if (!activate) return [...failures, "listKeyboardNav has no onActivate"];
  const next = keys.find((k) => k.at > activate.at)?.at ?? close;
  if (!/\bfocusRow\(/.test(panel.masked.slice(activate.at, next)))
    failures.push("onActivate doesn't focus through focusRow");
  return failures;
}

/** The absolute offset of the first CODE match of `snippet` in `[from, to)`,
 *  or -1: string literals compare by source text, and a match that runs
 *  through a comment (blanked in the masked text) doesn't count. */
function codeSearch(src, snippet, from = 0, to = src.source.length) {
  const strip = (s) => s.replace(/"[^"\n]*"/g, '""');
  for (const m of src.source.slice(from, to).matchAll(loose(snippet))) {
    const at = from + m.index;
    const end = at + m[0].length;
    if (strip(src.masked.slice(at, end)) === strip(src.source.slice(at, end)))
      return at;
  }
  return -1;
}

/** Failures for the claim surviving dialog-held focus (empty = pinned). */
function claimSurvivalFailures(panel) {
  const body = functionBody(panel, "claimPendingFocus");
  if (!body) return ["no claimPendingFocus function"];
  const decline = codeSearch(
    panel,
    "if (!focusIsOrphaned() && !atSource) {",
    ...body,
  );
  if (decline === -1) return ["claimPendingFocus has no decline branch"];
  const blockOpen = panel.masked.indexOf("{", decline);
  const blockClose = matchBrace(panel.masked, blockOpen);
  const keep = codeSearch(
    panel,
    'if (pendingFocusFromFlip.current && waitingFocus() === "dialog") {',
    blockOpen,
    blockClose,
  );
  if (keep === -1)
    return [
      "the decline branch doesn't keep (only) a flip's dialog-held claim",
    ];
  const keepOpen = panel.masked.indexOf("{", keep);
  const keepClose = matchBrace(panel.masked, keepOpen);
  const failures = [];
  if (
    codeSearch(
      panel,
      "pendingFocusSource.current = null;",
      keepOpen,
      keepClose,
    ) === -1
  )
    failures.push(
      "the kept claim keeps its source row (Esc back to it would read as never moved)",
    );
  if (codeSearch(panel, "return false;", keepOpen, keepClose) === -1)
    failures.push(
      "the kept claim doesn't report itself unsettled (return false)",
    );
  const clear = codeSearch(panel, "clearPendingFocus()", blockOpen, blockClose);
  if (clear !== -1 && clear < keep)
    failures.push("the decline branch clears the claim before its dialog test");
  return failures;
}

/** Failures for the settle loop owning only its own claim (empty = pinned). */
function settleLoopFailures(panel) {
  const body = functionBody(panel, "settleFlipFocusAfterDialog");
  if (!body) return ["no settleFlipFocusAfterDialog function"];
  const failures = [];
  const params = panel.masked.slice(
    panel.masked.indexOf("(", panel.masked.lastIndexOf("function", body[0])),
    body[0],
  );
  if (!/\(\s*armed\s*:\s*object\s*\|\s*null\s*\)/.test(params))
    failures.push("the loop doesn't take the flip's armed token");
  if (codeSearch(panel, "pendingFocusKey.current", ...body) !== -1)
    failures.push(
      "the loop reads whatever claim is pending instead of its own",
    );
  if (codeSearch(panel, "pendingFocusToken.current === armed", ...body) === -1)
    failures.push("the loop's ownership test isn't the per-arm token");
  if (codeSearch(panel, "pendingFocusToken.current = token;") === -1)
    failures.push("deferFocusRow doesn't mint a per-arm token");
  return failures;
}

/** Failures for the three view-flip arms' dialog test (empty = pinned). */
function flipArmFailures(panel) {
  const body = functionBody(panel, "toggleViewMode");
  if (!body) return ["no toggleViewMode function"];
  const masked = panel.masked.slice(...body);
  const failures = [];
  if (
    codeSearch(
      panel,
      'const inDialog = waitingFocus() === "dialog";',
      ...body,
    ) === -1
  )
    failures.push("toggleViewMode doesn't read the dialog state");
  // Under the palette the toggle lands from the settle loop, never mid-dialog.
  const toggles = [
    ...masked.matchAll(/\bviewToggleRef\.current\?\.focus\(\)/g),
  ];
  if (toggles.length !== 2)
    failures.push(`expected two toggle landings, found ${toggles.length}`);
  for (const t of toggles)
    if (!/\belse\s+if\s*\(\s*!inDialog\s*\)\s*$/.test(masked.slice(0, t.index)))
      failures.push(
        `a toggle landing at offset ${t.index} fires while the dialog holds focus`,
      );
  const defers = [...masked.matchAll(/\bdeferFocusRow\(/g)];
  if (defers.length !== 3)
    failures.push(`expected three flip claims, found ${defers.length}`);
  for (const d of defers)
    if (!/\barmed\s*=\s*$/.test(masked.slice(0, d.index)))
      failures.push(
        `a flip claim at offset ${d.index} doesn't report its token`,
      );
  const arms = [...masked.matchAll(/\bfocusLeavingRow\(/g)];
  if (arms.length !== 3)
    failures.push(`expected three flip arms, found ${arms.length}`);
  for (const arm of arms)
    if (!/\(\s*inDialog\s*\|\|\s*$/.test(masked.slice(0, arm.index)))
      failures.push(`a flip arm at offset ${arm.index} skips the dialog test`);
  if (!loose("if (inDialog) settleFlipFocusAfterDialog(armed);").test(masked))
    failures.push(
      "toggleViewMode doesn't start the settle loop with its token",
    );
  return failures;
}

/** Failures for the view flip's hidden-selection gate: a selection inside a
 *  collapsed section mounts no row in either layout, so none of the three
 *  claim arms may arm for it (empty = pinned). */
function hiddenSelectionFailures(panel) {
  const body = functionBody(panel, "toggleViewMode");
  if (!body) return ["no toggleViewMode function"];
  const failures = [];
  const gates = {
    'const selectionHidden = selectedFile !== null && collapsedSections.has(selectedFile.staged ? "staged" : "unstaged");':
      "the hidden-selection test isn't the collapsed-section read",
    "if (activeKey !== null && !selectionHidden) armed = deferFocusRow(activeKey, nextMode);":
      "the folder-cursor arm claims a hidden selection",
    "if (selectedFile && activeKey !== null && !selectionHidden) {":
      "the swallowed-by-collapse arm runs for a hidden selection",
    "!swallowedByCollapse && !selectionHidden && activeFolderKey === null":
      "the general arm claims a hidden selection",
  };
  for (const [snippet, failure] of Object.entries(gates))
    if (codeSearch(panel, snippet, ...body) === -1) failures.push(failure);
  return failures;
}

/** Failures for the palette AI resolve's fire-time re-read (empty = pinned). */
function resolveRecheckFailures(panel) {
  const action = panel.source.indexOf('"resolve-conflict-ai"');
  if (action === -1) return ["no resolve-conflict-ai action wiring"];
  const call = panel.masked.lastIndexOf("useHotkeyAction(", action);
  const callClose = matchBrace(panel.masked, call + "useHotkeyAction".length);
  const args = panel.masked.slice(call, callClose);
  const handler = /=>\s*void\s+([\w$]+)\(\)/.exec(args);
  if (!handler) return ["the action doesn't delegate to a named handler"];
  if (!/,\s*canResolveConflicts\s*,?\s*$/.test(args))
    return ["the action's enable is no longer canResolveConflicts"];
  const body = functionBody(panel, handler[1]);
  if (!body) return [`no ${handler[1]} function`];
  const masked = panel.masked.slice(...body);
  const refetch = masked.search(loose("await status.refetch()"));
  const refuse = masked.search(/\brefuseIfSwitched\(/);
  const starts = [...masked.matchAll(/\bstartResolve(?:One|All)\(/g)];
  if (refetch === -1) return ["the handler doesn't await a status refetch"];
  if (refuse === -1) return ["the handler has no refuseIfSwitched check"];
  if (starts.length === 0) return ["the handler starts no resolve"];
  if (!(refetch < refuse)) return ["refuseIfSwitched runs before the refetch"];
  if (starts.some((s) => s.index < refuse))
    return ["a resolve starts before the refetch and the switch check"];
  // A cancelled refetch resolves with pre-refetch data: only data stamped at
  // or after the fire counts, and the stamp is taken before the await.
  const firedAt = masked.search(loose("const firedAt = Date.now();"));
  if (firedAt === -1 || firedAt > refetch)
    return ["the fire time isn't captured before the refetch"];
  if (!loose("result.dataUpdatedAt >= firedAt").test(masked))
    return ["the re-read isn't checked as newer than the fire"];
  // One run per fire: a second fire during the re-read is dropped.
  const guard = masked.search(
    loose("if (resolveCheckInFlight.current) return;"),
  );
  const set = masked.search(loose("resolveCheckInFlight.current = true;"));
  const reset = masked.search(loose("resolveCheckInFlight.current = false;"));
  if (guard === -1 || set === -1 || reset === -1)
    return ["the handler has no in-flight guard"];
  if (!(guard < set && set < refetch && refetch < reset && reset < refuse))
    return ["the in-flight guard doesn't span exactly the re-read"];
  // The press bumps once, before the read, and claims that epoch; a newer
  // interaction during the read drops the start, which lands on the claim.
  const bump = masked.search(
    loose("useUiStore.getState().noteUserInteraction();"),
  );
  const claim = masked.search(
    loose("const claimedEpoch = useUiStore.getState().interactionEpoch;"),
  );
  if (bump === -1 || claim === -1 || !(bump < claim && claim < refetch))
    return ["the press doesn't bump and claim its epoch before the re-read"];
  const moved = masked.search(
    loose(
      "if (useUiStore.getState().interactionEpoch !== claimedEpoch) return;",
    ),
  );
  if (moved === -1 || moved < refuse || starts.some((s) => s.index < moved))
    return ["a start doesn't wait for the claimed epoch check"];
  const claimed = [
    ...masked.matchAll(
      /\bstartResolve(?:One|All)\([^()]*,\s*firedOn,\s*\{\s*claimedEpoch\s*\}\)/g,
    ),
  ];
  if (claimed.length !== starts.length)
    return ["a start doesn't land on the claimed epoch"];
  return [];
}

/** Failures for the tab stop staying mounted (empty = pinned). */
function tabStopMountFailures(panel) {
  const failures = [];
  if (codeSearch(panel, "tabStopKey={tabStopKey}") === -1)
    failures.push("the list isn't handed the panel's tabStopKey");
  if (
    codeSearch(
      panel,
      "const tabStopIndex = tabStopKey ? flatRows.findIndex((r) => rowKeyOf(r) === tabStopKey) : -1;",
    ) === -1
  )
    failures.push("the list doesn't find the tab stop's flat index");
  if (
    codeSearch(
      panel,
      "mergePinnedIndexes(defaultRangeExtractor(range), [tabStopIndex], count)",
    ) === -1
  )
    failures.push("the range doesn't pin the tab stop's index");
  const call = panel.masked.search(/\bconst rowVirtualizer = useVirtualizer\(/);
  if (call === -1) return [...failures, "no rowVirtualizer"];
  const open = panel.masked.indexOf("{", call);
  const { keys } = topLevelKeys(panel.masked, open);
  if (!keys.some((k) => k.name === "rangeExtractor"))
    failures.push("the virtualizer doesn't take the pinning rangeExtractor");
  return failures;
}

/** Failures for a focus-caused cursor move skipping the cursor scroll, so a
 *  press on a file row is never carried out from under the pointer, while an
 *  arrow move keeps its scroll (empty = pinned). */
function focusMoveScrollFailures(panel) {
  const failures = [];
  if (codeSearch(panel, "focusCursorMove={focusCursorMove}") === -1)
    failures.push("the list isn't handed the panel's focusCursorMove");
  if (
    codeSearch(panel, "const focusMoveSeen = useRef(focusCursorMove);") === -1
  )
    failures.push("the list keeps no focusMoveSeen ref");
  if (
    codeSearch(
      panel,
      'focusMoveSeen.current === focusCursorMove ) rowVirtualizer.scrollToIndex(activeFlatIndex, { align: "auto" });',
    ) === -1
  )
    failures.push("the cursor scroll doesn't skip a focus move's commit");
  if (
    codeSearch(
      panel,
      "useEffect(() => { focusMoveSeen.current = focusCursorMove; });",
    ) === -1
  )
    failures.push("focusMoveSeen isn't synced every commit");
  if (panel.masked.match(/\bfocusMoveSeen\.current = /g)?.length !== 1)
    failures.push("the per-commit sync isn't focusMoveSeen's only write");
  if (panel.masked.match(/\bsetFocusCursorMove\(/g)?.length !== 1)
    failures.push("focusCursorMove is re-minted outside handleRowFocus");
  const body = functionBody(panel, "handleRowFocus");
  if (!body) return [...failures, "no handleRowFocus function"];
  const [open, close] = body;
  const text = panel.masked.slice(open, close);
  if (/\bselect(File)?\(/.test(text))
    failures.push("handleRowFocus selects on focus");
  if (
    codeSearch(
      panel,
      'const shown = useUiStore.getState().selectedFile; if ( row.type === "file" && activeFolderKey !== null && (shown === null || keyOf(shown.path, shown.staged) !== key) ) setFocusCursorMove({});',
      open,
      close,
    ) === -1
  )
    failures.push(
      "handleRowFocus doesn't mark exactly a file focus that moves the folder cursor off its row",
    );
  return failures;
}

const panel = load(PANEL);
const row = load(ROW);

test("Changes rows rove a single tab stop", () => {
  assert.deepEqual(rovingFailures(panel, row), []);
});

test("roving pin rejects a literal row tab stop", () => {
  const reverted = fromSource(
    row.source.replace(loose("tabIndex={tabStop ? 0 : -1}"), "tabIndex={0}"),
  );
  assert.notEqual(reverted.source, row.source);
  assert.notDeepEqual(rovingFailures(panel, reverted), []);
});

test("vertical arrows focus through focusRow, without the helper's rowKey", () => {
  assert.deepEqual(navRoutingFailures(panel), []);
});

test("nav pin rejects the helper's rowKey route", () => {
  const reverted = fromSource(
    panel.source.replace(
      /listKeyboardNav\(\{\s*items: navRows,/,
      (m) => `${m}\n    rowKey: rowKeyOf,`,
    ),
  );
  assert.notEqual(reverted.source, panel.source);
  assert.notDeepEqual(navRoutingFailures(reverted), []);
});

test("a focus claim survives while a dialog holds focus", () => {
  assert.deepEqual(claimSurvivalFailures(panel), []);
});

/** The panel with `find` (a literal snippet or a regex) replaced, asserting the
 *  mutation actually changed the source. */
function mutatedPanel(find, replace) {
  const pattern = typeof find === "string" ? loose(find) : find;
  const source = panel.source.replace(pattern, replace);
  assert.notEqual(source, panel.source, `mutation found nothing: ${pattern}`);
  return fromSource(source);
}

test("claim pin rejects a decline that retires dialog-held claims", () => {
  const keep =
    'if (pendingFocusFromFlip.current && waitingFocus() === "dialog") {';
  assert.notDeepEqual(
    claimSurvivalFailures(mutatedPanel(keep, "if (false) {")),
    [],
  );
});

test("claim pin rejects a commented-out keep", () => {
  const keep =
    'if (pendingFocusFromFlip.current && waitingFocus() === "dialog") {';
  assert.notDeepEqual(
    claimSurvivalFailures(
      mutatedPanel(keep, (m) => `// ${m}\n      if (false) {`),
    ),
    [],
  );
});

test("claim pin rejects a keep that holds every claim", () => {
  assert.notDeepEqual(
    claimSurvivalFailures(mutatedPanel("pendingFocusFromFlip.current && ", "")),
    [],
  );
});

test("claim pin rejects a kept claim that keeps its source row", () => {
  assert.notDeepEqual(
    claimSurvivalFailures(
      mutatedPanel(
        /(waitingFocus\(\) === "dialog"\) \{\s*)pendingFocusSource\.current = null;/,
        "$1",
      ),
    ),
    [],
  );
});

test("flip pin rejects a toggle landing while the dialog holds focus", () => {
  assert.notDeepEqual(
    flipArmFailures(
      mutatedPanel(/else if \(!inDialog\) (viewToggleRef)/, "else $1"),
    ),
    [],
  );
});

test("the settle loop owns only the claim its flip armed", () => {
  assert.deepEqual(settleLoopFailures(panel), []);
});

test("settle pin rejects a loop that adopts the pending claim", () => {
  const adopted = mutatedPanel(
    "pendingFocusToken.current === armed",
    "pendingFocusKey.current !== null",
  );
  assert.notDeepEqual(settleLoopFailures(adopted), []);
});

test("flip pin rejects an arm that doesn't report its token", () => {
  assert.notDeepEqual(
    flipArmFailures(mutatedPanel(/armed = (deferFocusRow\(swallowing)/, "$1")),
    [],
  );
});

test("settle pin rejects a key-only ownership test", () => {
  const keyOnly = mutatedPanel(
    "pendingFocusToken.current = token;",
    "void token;",
  );
  assert.notDeepEqual(settleLoopFailures(keyOnly), []);
});

test("resolve pin rejects a re-read accepted without its stamp", () => {
  assert.notDeepEqual(
    resolveRecheckFailures(
      mutatedPanel(" && result.dataUpdatedAt >= firedAt", ""),
    ),
    [],
  );
});

test("resolve pin rejects a handler without its in-flight guard", () => {
  assert.notDeepEqual(
    resolveRecheckFailures(
      mutatedPanel("if (resolveCheckInFlight.current) return;", ""),
    ),
    [],
  );
});

test("every view-flip arm treats dialog focus as landable", () => {
  assert.deepEqual(flipArmFailures(panel), []);
});

test("flip pin rejects an arm without the dialog test", () => {
  const reverted = fromSource(
    panel.source.replace(
      /inDialog \|\| focusLeavingRow\(activeKey\)\)\s*\)/,
      (m) => m.replace("inDialog || ", ""),
    ),
  );
  assert.notEqual(reverted.source, panel.source);
  assert.notDeepEqual(flipArmFailures(reverted), []);
});

test("the palette AI resolve re-reads status before starting", () => {
  assert.deepEqual(resolveRecheckFailures(panel), []);
});

test("resolve pin rejects each broken epoch claim", () => {
  for (const [find, replace] of [
    ["useUiStore.getState().noteUserInteraction();", ""],
    [
      "if (useUiStore.getState().interactionEpoch !== claimedEpoch) return;",
      "",
    ],
    [
      "startResolveOne(target.path, firedOn, { claimedEpoch });",
      "startResolveOne(target.path, firedOn);",
    ],
    [
      "startResolveAll(fresh, firedOn, { claimedEpoch });",
      "startResolveAll(fresh, firedOn);",
    ],
  ])
    assert.notDeepEqual(
      resolveRecheckFailures(mutatedPanel(find, replace)),
      [],
      `survived: ${find}`,
    );
});

test("the roving tab stop stays mounted at any scroll position", () => {
  assert.deepEqual(tabStopMountFailures(panel), []);
});

test("tab stop mount pin rejects each unpinned window", () => {
  for (const [find, replace] of [
    [/\n\s*rangeExtractor,\s*(overscan: 16,)/, "\n    $1"],
    ["[tabStopIndex], count)", "[], count)"],
    ["tabStopKey={tabStopKey}", "tabStopKey={null}"],
    [
      "(r) => rowKeyOf(r) === tabStopKey)",
      "(r) => rowKeyOf(r) === activeRowKey)",
    ],
  ])
    assert.notDeepEqual(
      tabStopMountFailures(mutatedPanel(find, replace)),
      [],
      `survived: ${find}`,
    );
});

test("a cursor move focus caused never scrolls the list", () => {
  assert.deepEqual(focusMoveScrollFailures(panel), []);
});

test("focus-move pin rejects each broken skip", () => {
  for (const [find, replace, message] of [
    [
      "sectionsSeen.current === collapsedSections && focusMoveSeen.current === focusCursorMove",
      "sectionsSeen.current === collapsedSections",
      "the cursor scroll doesn't skip a focus move's commit",
    ],
    [
      "focusCursorMove={focusCursorMove}",
      "focusCursorMove={{}}",
      "the list isn't handed the panel's focusCursorMove",
    ],
    [
      "focusMoveSeen.current = focusCursorMove; });",
      "focusMoveSeen.current = focusCursorMove; }, [activeFlatIndex]);",
      "focusMoveSeen isn't synced every commit",
    ],
    [
      "if (activeFlatIndex < 0) return;",
      "focusMoveSeen.current = focusCursorMove; if (activeFlatIndex < 0) return;",
      "the per-commit sync isn't focusMoveSeen's only write",
    ],
    // Every file focus marked: an arrow move would lose its scroll.
    [
      "(shown === null || keyOf(shown.path, shown.staged) !== key)",
      "true",
      "handleRowFocus doesn't mark exactly a file focus that moves the folder cursor off its row",
    ],
    [
      'row.type === "file" && activeFolderKey !== null &&',
      'row.type === "file" &&',
      "handleRowFocus doesn't mark exactly a file focus that moves the folder cursor off its row",
    ],
    [
      'setActiveFolderKey(row.type === "folder" ? key : null);',
      'setActiveFolderKey(row.type === "folder" ? key : null); if (row.type === "file") select(row.entry, row.staged);',
      "handleRowFocus selects on focus",
    ],
    [
      "function toggleKind(kind: FilterKind, on: boolean) {",
      "function toggleKind(kind: FilterKind, on: boolean) { setFocusCursorMove({});",
      "focusCursorMove is re-minted outside handleRowFocus",
    ],
  ]) {
    const failures = focusMoveScrollFailures(mutatedPanel(find, replace));
    assert.ok(
      failures.includes(message),
      `survived or misattributed: ${find} -> ${JSON.stringify(failures)}`,
    );
  }
});

test("resolve pin rejects a handler that starts from the cached read", () => {
  const reverted = fromSource(
    panel.source.replace(
      loose("const result = await status.refetch();"),
      "const result = status;",
    ),
  );
  assert.notEqual(reverted.source, panel.source);
  assert.notDeepEqual(resolveRecheckFailures(reverted), []);
});

test("a view flip arms no claim for a selection in a collapsed section", () => {
  assert.deepEqual(hiddenSelectionFailures(panel), []);
});

test("hidden-selection pin rejects each ungated arm", () => {
  const mutations = [
    [/(const selectionHidden =)[^;]*;/, "$1 false;"],
    [/(activeKey !== null) && !selectionHidden\)\s*armed/, "$1) armed"],
    [/(selectedFile && activeKey !== null) && !selectionHidden/, "$1"],
    [/(!swallowedByCollapse &&)\s*!selectionHidden &&/, "$1"],
  ];
  for (const [find, replace] of mutations)
    assert.notDeepEqual(
      hiddenSelectionFailures(mutatedPanel(find, replace)),
      [],
      String(find),
    );
});

/** {@link codeSearch} for snippets holding template literals, whose text the
 *  mask blanks: a match counts only when its masked text is the snippet's own
 *  masked skeleton, so a commented-out copy never does. */
function templateSearch(src, snippet, from = 0, to = src.source.length) {
  const norm = (s) => s.replace(/\s+/g, "");
  const skeleton = norm(maskNonCode(snippet, true));
  for (const m of src.source.slice(from, to).matchAll(loose(snippet))) {
    const at = from + m.index;
    if (norm(src.masked.slice(at, at + m[0].length)) === skeleton) return at;
  }
  return -1;
}

/** The `[open, close]` braces of the block a code `snippet` (ending in `{`)
 *  opens inside `[from, to)`, or null. */
function blockAfter(src, snippet, from, to) {
  const at = codeSearch(src, snippet, from, to);
  if (at === -1) return null;
  const open = src.masked.indexOf("{", at + snippet.length - 1);
  const close = matchBrace(src.masked, open);
  return close === -1 ? null : [open, close];
}

/** Failures for the folder-cursor backstop's wait under a closing dialog
 *  (empty = pinned): a re-keyed folder row lands focus once the dialog's
 *  return orphans it, never stealing focus the user moved. */
function backstopDialogFailures(panel) {
  const guard = codeSearch(
    panel,
    "if (activeFolderKey === null || navIndex !== -1) return;",
  );
  if (guard === -1) return ["no folder-cursor backstop effect"];
  const effect = panel.masked.lastIndexOf("useEffect(() => {", guard);
  const open = panel.masked.indexOf("{", effect);
  const close = matchBrace(panel.masked, open);
  if (effect === -1 || close === -1) return ["the backstop effect won't parse"];
  const failures = [];
  // Landing orphaned focus retires a wait still aimed at an older survivor.
  const orphan = blockAfter(
    panel,
    "if (nextKey !== null && focusIsOrphaned()) {",
    open,
    close,
  );
  const disarm =
    orphan && codeSearch(panel, "folderClaimTarget.current = null;", ...orphan);
  const land = orphan && codeSearch(panel, "focusRow(nextKey);", ...orphan);
  if (orphan === null || disarm === -1 || land === -1 || land < disarm)
    failures.push("the orphaned-focus arm doesn't disarm the wait");
  if (/\breturn\s*\(\s*\)\s*=>/.test(panel.masked.slice(open, close)))
    failures.push("a cleanup would cancel the wait on the cursor's own write");
  const branch = blockAfter(
    panel,
    'if (nextKey !== null && waitingFocus() === "dialog") {',
    open,
    close,
  );
  if (branch === null) return [...failures, "no dialog-held branch"];
  const must = {
    "const looping = folderClaimTarget.current !== null;":
      "the branch doesn't read whether a wait is running",
    "folderClaimTarget.current = { key: nextKey, from: staleKey };":
      "the branch doesn't aim the wait at the survivor",
    "const live = activeFolderKeyLatest();":
      "the wait doesn't read the live cursor",
    "target === null || (live !== target.key && live !== target.from &&":
      "the wait doesn't stop once its target is stale",
    // An advance clears the cursor off a row that is still listed; landing
    // focus there moves the cursor back.
    "!(live === null && folderRowListedLatest(target.key))) ||":
      "the wait drops once an advance clears the cursor",
    "if (looping) return;": "a re-key starts a second wait",
    "useUiStore.getState().repoPath !== firedOn":
      "the wait doesn't stop on a repo switch",
    // The claim bound runs from the dialog's close, not the re-key, and the
    // open dialog is polled slowly, never every frame.
    "let deadline: number | null = null;":
      "the wait's bound starts before the dialog closes",
    'if (waiting === "dialog" && focusInOpenPopup()) { deadline = null; window.setTimeout(step, DIALOG_HOLD_POLL_MS); return; }':
      "an open dialog isn't held with a slow poll",
    "deadline ??= performance.now() + DIALOG_CLAIM_MS;":
      "the claim bound doesn't start at the close",
    "dialogClaimStep(waiting, performance.now(), deadline)":
      "the wait doesn't step through dialogClaimStep",
    'if (verdict === "claim") focusRow(target.key);':
      "a claim verdict doesn't focus the survivor",
  };
  for (const [snippet, failure] of Object.entries(must))
    if (codeSearch(panel, snippet, ...branch) === -1) failures.push(failure);
  if (
    codeSearch(
      panel,
      "const folderClaimTarget = useRef<{ key: string; from: string } | null>(null);",
    ) === -1
  )
    failures.push("the wait's target is not a ref");
  if (
    codeSearch(
      panel,
      "const activeFolderKeyLatest = useEffectEvent(() => activeFolderKey);",
    ) === -1
  )
    failures.push("the live cursor isn't read through a latest wrapper");
  if (
    codeSearch(
      panel,
      "const folderRowListedLatest = useEffectEvent((key: string) => flatRows.some((r) => rowKeyOf(r) === key), );",
    ) === -1
  )
    failures.push("the listed check doesn't read the latest rows");
  const popup = functionBody(panel, "focusInOpenPopup");
  if (
    popup === null ||
    codeSearch(
      panel,
      'const popup = document.activeElement?.closest(CLAIM_HOLD_SELECTOR); return popup ? !popup.hasAttribute("data-closed") : false;',
      ...popup,
    ) === -1
  )
    failures.push("a closing popup still reads as open");
  return failures;
}

test("the folder backstop lands focus after a closing dialog", () => {
  assert.deepEqual(backstopDialogFailures(panel), []);
});

test("backstop pin rejects each broken dialog wait", () => {
  const mutations = [
    ['if (nextKey !== null && waitingFocus() === "dialog") {', "if (false) {"],
    [
      'if (verdict === "claim") focusRow(target.key);',
      'if (verdict === "claim") void target;',
    ],
    // The orphan arm keeps the wait armed at the survivor it replaced.
    [
      "focusIsOrphaned()) {\r\n      // Landed focus retires any wait still aimed at an older survivor.\r\n      folderClaimTarget.current = null;",
      "focusIsOrphaned()) {",
    ],
    // A step that never compares the live cursor claims a stale key.
    [
      "(live !== target.key && live !== target.from && !(live === null && folderRowListedLatest(target.key))) ||",
      "",
    ],
    // Dropping on a cleared cursor strands focus after the advance.
    [" && !(live === null && folderRowListedLatest(target.key))", ""],
    // Claiming on a cleared cursor whatever the rows list.
    ["live === null && folderRowListedLatest(target.key)", "live === null"],
    // A bound timed from the re-key drops a wait under a dialog left open.
    [
      "let deadline: number | null = null;",
      "let deadline: number | null = performance.now() + DIALOG_CLAIM_MS;",
    ],
    ["deadline = null;", ""],
    // Polling the open dialog every frame.
    [
      "window.setTimeout(step, DIALOG_HOLD_POLL_MS);",
      "requestAnimationFrame(step);",
    ],
    // A closing dialog read as open would hold past the close.
    [
      'return popup ? !popup.hasAttribute("data-closed") : false;',
      "return popup !== null && popup !== undefined;",
    ],
    // The arming render's cursor is stale by the time the dialog closes.
    ["const live = activeFolderKeyLatest();", "const live = activeFolderKey;"],
    ["if (looping) return;", ""],
    [
      /(requestAnimationFrame\(step\);\s*\}\s*)(\}, \[activeFolderKey, navIndex\]\);)/,
      "$1return () => { folderClaimTarget.current = null; };\n  $2",
    ],
  ];
  for (const [find, replace] of mutations)
    assert.notDeepEqual(
      backstopDialogFailures(mutatedPanel(find, replace)),
      [],
      String(find),
    );
});

/** Failures for the folder lead over a filtered folder (empty = pinned). */
function folderLeadFailures(panel) {
  const failures = [];
  const copy = [
    '"folder-hidden:unstaged": (path) => `${path} has no visible unstaged changes left.`,',
    '"folder-hidden:staged": (path) => `${path} has no visible staged changes left.`,',
    '"folder:unstaged": (path) => `${path} has no unstaged changes left.`,',
    '"folder:staged": (path) => `${path} has no staged changes left.`,',
  ];
  for (const snippet of copy)
    if (templateSearch(panel, snippet) === -1)
      failures.push(`ADVANCE_LEADS lacks ${snippet.slice(0, 24)}`);
  const arm = blockAfter(
    panel,
    "if (folder && !nowRowKeys.some(survives)) {",
    0,
    panel.source.length,
  );
  if (arm === null) return [...failures, "no folder-empty arm"];
  // The transition's own new read: a same-side descendant left in it is one
  // the filter hides, since no row at or under the folder survived.
  const hidden = codeSearch(
    panel,
    'const hiddenLeft = entriesUnderFolder( nowEntries.filter( (e) => (folder.section === "staged" ? e.staged : e.unstaged) !== null, ), (e) => e.path, folder.path, ).length;',
    ...arm,
  );
  if (hidden === -1) failures.push("hiddenLeft isn't counted from nowEntries");
  const pick = templateSearch(
    panel,
    'key: `${hiddenLeft > 0 ? "folder-hidden" : "folder"}:${folder.section}`,',
    ...arm,
  );
  if (pick === -1) failures.push("the lead key doesn't follow hiddenLeft");
  else if (hidden !== -1 && pick < hidden)
    failures.push("the lead key is picked before hiddenLeft is counted");
  return failures;
}

test("a filtered folder's lead says no visible changes are left", () => {
  assert.deepEqual(folderLeadFailures(panel), []);
});

test("folder lead pin rejects each broken pick", () => {
  const mutations = [
    ['hiddenLeft > 0 ? "folder-hidden" : "folder"', '"folder"'],
    [
      "nowEntries.filter(\n              (e) =>\n                (folder.section",
      "prevEntries.filter(\n              (e) =>\n                (folder.section",
    ],
    ["has no visible unstaged changes left.", "has no unstaged changes left."],
    [/(const hiddenLeft = )entriesUnderFolder\(/, "$1[].concat("],
  ];
  for (const [find, replace] of mutations)
    assert.notDeepEqual(
      folderLeadFailures(mutatedPanel(find, replace)),
      [],
      String(find),
    );
});
