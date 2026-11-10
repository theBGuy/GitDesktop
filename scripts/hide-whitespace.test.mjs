// Pins the whitespace mode of the local diff views: `readViewDiff` and
// `hasHunk` (src/lib/git/whitespace-diff.ts), the setting's heal arm, the copy
// in src/features/diff/whitespace-mode.ts, and the wiring no jsdom test can
// see: the fire-time belts, the palette registrations, the options sheet's
// place in the staging toolbar, the per-hook placeholders, the line-selection
// gates, the composer hold, the IPC key and the roster of view-diff fetches.
// Every source pin takes text and has an in-memory mutation control; a pin that
// cannot find its anchor fails, never skips.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { installSrcHooks } from "./lib/src-import-hooks.mjs";
import { maskNonCode, matchBrace, sourceFiles } from "./lib/ts-mask.mjs";

const hooks = installSrcHooks();
after(() => hooks.deregister());

const { hasHunk, readViewDiff } = await import("@/lib/git/whitespace-diff");
const mode = await import("@/features/diff/whitespace-mode");
const { DEFAULT_SETTINGS, healLoadedSettings } = await import(
  "@/lib/settings/heal"
);

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
const VIEWER = "src/features/diff/DiffViewer.tsx";
const SURFACE = "src/features/diff/DiffSurface.tsx";

/** Index of `needle`, which must occur exactly once in `text`. */
function once(text, needle, what = needle) {
  const n = text.split(needle).length - 1;
  if (n !== 1) throw new Error(`${what}: expected one "${needle}", found ${n}`);
  return text.indexOf(needle);
}

/** The `{…}` body of the function whose anchor (ending in its "(") occurs
 *  once: the parameter list is matched, then the first brace after it. */
function bodyOf(text, anchor, jsx = true) {
  const masked = maskNonCode(text, jsx);
  const at = once(text, anchor);
  const params = matchBrace(masked, at + anchor.length - 1);
  if (params < 0) throw new Error(`${anchor}: unmatched parameter list`);
  const open = masked.indexOf("{", params);
  const close = matchBrace(masked, open);
  if (open < 0 || close < 0) throw new Error(`${anchor}: no body`);
  return text.slice(open, close + 1);
}

/** The top-level argument texts of the call whose "(" is at `open`. */
function callArgs(text, open, jsx = true) {
  const masked = maskNonCode(text, jsx);
  const close = matchBrace(masked, open);
  if (close < 0) throw new Error("unmatched call");
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start, close).trim();
  if (last !== "") args.push(last);
  return args;
}

/** The enabled expression of the one `useHotkeyAction("<id>"` call in text. */
function hotkeyEnabled(text, id) {
  const re = new RegExp(String.raw`useHotkeyAction\(\s*"${id}"`, "g");
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1)
    throw new Error(`${id}: expected one registration, found ${hits.length}`);
  const args = callArgs(text, hits[0].index + "useHotkeyAction".length);
  return args[2] ?? "";
}

const red = (pin, text, what) =>
  assert.throws(() => pin(text), undefined, `mutation control: ${what}`);
const swap = (text, from, to) => {
  once(text, from, "control anchor");
  return text.replace(from, () => to);
};

// --- pure logic -----------------------------------------------------------

test("hasHunk spots a hunk header at the start or after a newline only", () => {
  assert.equal(hasHunk("@@ -1 +1 @@\n-a\n+b\n"), true);
  assert.equal(hasHunk("diff --git a/x b/x\n@@ -1 +1 @@\n"), true);
  assert.equal(hasHunk(""), false);
  assert.equal(
    hasHunk("diff --git a/x b/x\nrename from x\nrename to y\n"),
    false,
  );
  assert.equal(hasHunk(" @@ not a header"), false);
});

test("readViewDiff: six cases, with the reads each one makes", async () => {
  const run = async (hide, answers) => {
    const calls = [];
    const out = await readViewDiff(hide, async (iw) => {
      calls.push(iw);
      return answers[String(iw)];
    });
    return { out, calls };
  };
  const hunk = { text: "@@ -1 +1 @@\n-a\n+b\n", isBinary: false };
  const empty = { text: "", isBinary: false };
  const binary = { text: "Binary files differ\n", isBinary: true };

  // The plain read is stamped too, so an unstamped answer never came through
  // here; it never claims whitespace-only.
  let r = await run(false, { false: hunk });
  assert.deepEqual(r.calls, [false]);
  assert.deepEqual(r.out, { ...hunk, whitespaceHidden: false });
  assert.equal("whitespaceOnly" in r.out, false);

  r = await run(false, { false: empty });
  assert.deepEqual(r.calls, [false]);
  assert.deepEqual(r.out, { ...empty, whitespaceHidden: false });

  r = await run(true, { true: hunk });
  assert.deepEqual(r.calls, [true]);
  assert.deepEqual(r.out, { ...hunk, whitespaceHidden: true });

  r = await run(true, { true: binary });
  assert.deepEqual(r.calls, [true]);
  assert.deepEqual(r.out, { ...binary, whitespaceHidden: true });

  r = await run(true, { true: empty, false: hunk });
  assert.deepEqual(r.calls, [true, false]);
  assert.deepEqual(r.out, {
    ...empty,
    whitespaceHidden: true,
    whitespaceOnly: true,
  });

  r = await run(true, { true: empty, false: empty });
  assert.deepEqual(r.calls, [true, false]);
  assert.deepEqual(r.out, { ...empty, whitespaceHidden: true });

  await assert.rejects(
    readViewDiff(true, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
});

test("the setting heals to a real boolean, off unless exactly true", () => {
  const { diffHideWhitespace: _drop, ...older } = DEFAULT_SETTINGS;
  assert.equal(DEFAULT_SETTINGS.diffHideWhitespace, false);
  assert.equal(healLoadedSettings(older).diffHideWhitespace, false);
  for (const [value, want] of [
    [true, true],
    [false, false],
    ["yes", false],
    [1, false],
    [null, false],
  ])
    assert.equal(
      healLoadedSettings({ ...DEFAULT_SETTINGS, diffHideWhitespace: value })
        .diffHideWhitespace,
      want,
      `healing ${JSON.stringify(value)}`,
    );
});

test("every whitespace copy table is total and non-empty", () => {
  const total = (record, keys) => {
    assert.deepEqual(Object.keys(record).sort(), [...keys].sort());
    for (const k of keys) assert.ok(record[k].trim().length > 0, k);
  };
  total(mode.WHITESPACE_STRIP_COPY, ["staged", "unstaged", "untracked"]);
  total(mode.WHITESPACE_HUNK_REASON, ["stage", "unstage", "discard"]);
  total(mode.WHITESPACE_REFUSAL, ["stage", "unstage", "discard"]);
  total(mode.WHITESPACE_ANNOUNCEMENT, ["hidden", "shown"]);
  assert.match(mode.WHITESPACE_STRIP_COPY.staged, /can't be unstaged/);
  assert.match(mode.WHITESPACE_STRIP_COPY.unstaged, /staged or discarded/);
  assert.ok(mode.WHITESPACE_COMPOSER_HELD.length > 0);
  assert.match(mode.LAYOUT_COMPOSER_HELD, /diff display/);
  assert.equal(
    mode.WHITESPACE_ONLY_MESSAGE,
    "Only whitespace changed in this file",
  );
  assert.equal(mode.SHOW_WHITESPACE_LABEL, "Show whitespace");
  assert.equal(mode.whitespaceWritesOff({ whitespaceHidden: true }), true);
  assert.equal(mode.whitespaceWritesOff({}), false);
  assert.equal(mode.whitespaceWritesOff(undefined), false);
});

// --- source pins --------------------------------------------------------------

const BELT =
  "if (whitespaceWritesOff(liveDiffRef.current) || hideWhitespaceRef.current)";
// The belt's body: the toast and the `return` that makes it a refusal.
const REFUSAL = "toast.info(WHITESPACE_REFUSAL[kind]);\n      return;\n    }";
const TOAST_ONLY = "toast.info(WHITESPACE_REFUSAL[kind]);\n    }";

function pinBelts(text) {
  const run = bodyOf(text, "async function runWrite(");
  const order = (body, steps, what) => {
    let at = -1;
    for (const step of steps) {
      const next = body.indexOf(step);
      if (next < 0 || next < at)
        throw new Error(`${what}: ${step} out of order`);
      at = next;
    }
  };
  order(
    run,
    [
      "if (writingRef.current) return;",
      BELT,
      REFUSAL,
      "writingRef.current = true;",
      "setWrite(",
    ],
    "runWrite",
  );
  const hunk = bodyOf(text, "function onHunkAction(");
  order(
    hunk,
    [
      "if (writingRef.current) return;",
      BELT,
      REFUSAL,
      'if (forText !== (diff.data?.text ?? "")) {',
      "setDiscard(",
    ],
    "onHunkAction",
  );
  if (hunk.indexOf("applyHunk(") < hunk.indexOf(BELT))
    throw new Error("onHunkAction: a write precedes the belt");
}

test("the fire-time belts refuse before any write", () => {
  const text = source(VIEWER);
  pinBelts(text);
  const run = bodyOf(text, "async function runWrite(");
  red(
    pinBelts,
    text.replace(run, () => run.replace(BELT, "if (false)")),
    "runWrite's belt removed",
  );
  for (const anchor of ["async function runWrite(", "function onHunkAction("]) {
    const body = bodyOf(text, anchor);
    once(body, REFUSAL, `${anchor} refusal`);
    red(
      pinBelts,
      text.replace(body, () => body.replace(REFUSAL, () => TOAST_ONLY)),
      `${anchor} refusal's return removed`,
    );
  }
  const hunk = bodyOf(text, "function onHunkAction(");
  const belt = `    // Ahead of the stale-text check, so a press after a flip names the reason.\n    ${BELT} {\n      toast.info(WHITESPACE_REFUSAL[kind]);\n      return;\n    }\n`;
  const stale = `    if (forText !== (diff.data?.text ?? "")) {\n      toast.info(STALE_HUNK_ACTION[kind]);\n      return;\n    }\n`;
  once(hunk, belt, "belt block");
  once(hunk, stale, "stale block");
  const moved = hunk
    .replace(belt, () => "")
    .replace(stale, () => `${stale}${belt}`);
  red(
    pinBelts,
    text.replace(hunk, () => moved),
    "onHunkAction's belt after the stale-text check",
  );
});

// jsdom never lays out the staging view's rows, so neither the hunk buttons the
// flip hold disables nor the Discard confirm they raise can be pressed there;
// the predicates are tested in scripts/diff-pane-hold.test.mjs, the wiring here.
const FLIP_HELD = "const flipHeld = whitespaceFlipHeld(wsFlip, diff);";
const STALE_RUN = "discardConfirmStale(discard.forText, liveDiffRef.current)";

function pinFlipHold(text) {
  const held = once(text, FLIP_HELD, "flip hold");
  const arm = once(text, "flipSeenRef.current = hideWhitespace;", "flip arm");
  const capture = text.indexOf("setWsFlip({", arm);
  if (capture < 0 || capture > held)
    throw new Error("the flip is captured in the effect keyed on the setting");
  // The capture effect's own deps: without the setting it never re-runs on a flip.
  const depsAt = text.indexOf("}, [", capture);
  const deps = text.slice(depsAt, text.indexOf("]);", depsAt));
  if (depsAt < 0 || depsAt > held || !/[[,\s]hideWhitespace[,\s\]]/.test(deps))
    throw new Error("the flip capture effect must key on hideWhitespace");
  const busyAt = once(text, "  const busy = writeHeld || flipHeld;", "busy");
  if (busyAt < held) throw new Error("busy must fold in the flip hold");
  // Every control `busy` holds reads the cause-aware reason.
  if (/disabled=\{busy\}\s*reason=\{UPDATING_DIFF_REASON\}/.test(text))
    throw new Error("a busy hold names a fixed reason");
  once(text, "HELD_DIFF_REASON[\n      heldDiffCause({", "the held reason");
  once(text, "if ((diffBehind || flipUnanswered) && diffIdle)", "flip refetch");
}

function pinStaleDiscardRun(text) {
  const check = once(text, STALE_RUN, "stale discard check");
  const toast = text.indexOf("toast.info(STALE_HUNK_ACTION.discard);", check);
  const run = once(text, "else discard?.run();", "the guarded run");
  if (toast < 0 || toast > run || check > run)
    throw new Error("the confirm checks its text before it runs");
  if (text.split(".run()").length - 1 !== 1)
    throw new Error("a Discard confirm runs only through the guarded call");
}

test("a whitespace flip holds the staging writes until new diff data", () => {
  const text = source(VIEWER);
  pinFlipHold(text);
  red(
    pinFlipHold,
    swap(
      text,
      "const busy = writeHeld || flipHeld;",
      "const busy = writeHeld;",
    ),
    "busy drops the hold",
  );
  red(
    pinFlipHold,
    text.replace("reason={busyReason}", () => "reason={UPDATING_DIFF_REASON}"),
    "a held control's reason fixed",
  );
  red(
    pinFlipHold,
    swap(text, FLIP_HELD, "const flipHeld = false;"),
    "the predicate unplugged",
  );
  red(
    pinFlipHold,
    swap(text, "(diffBehind || flipUnanswered) && diffIdle", "diffBehind"),
    "the flip's refetch dropped",
  );
  red(
    pinFlipHold,
    swap(
      text,
      "}, [hideWhitespace, queryClient, repoPath, file.path, file.staged]);",
      "}, [queryClient, repoPath, file.path, file.staged]);",
    ),
    "the capture effect no longer keys on the setting",
  );
});

test("a Discard confirm refuses once the diff moved past its text", () => {
  const text = source(VIEWER);
  pinStaleDiscardRun(text);
  red(pinStaleDiscardRun, swap(text, STALE_RUN, "false"), "check removed");
  red(
    pinStaleDiscardRun,
    swap(text, "else discard?.run();", "discard?.run();"),
    "the run escapes the check",
  );
});

function pinRegistrations(files) {
  const re = /useHotkeyAction\(\s*"toggle-hide-whitespace"/g;
  const where = [];
  for (const [rel, text] of files) {
    const n = [...text.matchAll(re)].length;
    for (let i = 0; i < n; i++) where.push(rel);
  }
  assert.deepEqual(where.sort(), [SURFACE, VIEWER].sort(), "registrations");
  const a = hotkeyEnabled(files.get(SURFACE), "toggle-hide-whitespace");
  if (!/\binteractive\b/.test(a) || !/\bwhitespaceControl\b/.test(a))
    throw new Error("DiffContent's registration lost its gate");
  if (/\bshowsToolbar\b/.test(a))
    throw new Error("DiffContent's registration must not wait on the toolbar");
  const b = hotkeyEnabled(files.get(VIEWER), "toggle-hide-whitespace");
  for (const need of ["interactive", "shownView !== null", "discard === null"])
    if (!b.includes(need)) throw new Error(`WorkingTreeDiff's gate: ${need}`);
}

/** The layout action: exactly the two complementary registrations, plus the
 *  gate arms no jsdom test reaches: both `interactive` arms (a held pane), and
 *  the staging gate's selection and discard arms (jsdom never builds the
 *  staging view's rows). */
function pinModeRegistrations(files) {
  const re = /useHotkeyAction\(\s*"toggle-diff-view-mode"/g;
  const where = [];
  for (const [rel, text] of files) {
    const n = [...text.matchAll(re)].length;
    for (let i = 0; i < n; i++) where.push(rel);
  }
  assert.deepEqual(where.sort(), [SURFACE, VIEWER].sort(), "registrations");
  const a = hotkeyEnabled(files.get(SURFACE), "toggle-diff-view-mode");
  if (!a.trimStart().startsWith("interactive &&"))
    throw new Error("DiffContent's layout gate: interactive");
  const b = hotkeyEnabled(files.get(VIEWER), "toggle-diff-view-mode");
  for (const need of [
    "interactive &&",
    "selection === null",
    "discard === null",
  ])
    if (!b.includes(need))
      throw new Error(`WorkingTreeDiff's layout gate: ${need}`);
}

function srcFiles() {
  const files = new Map();
  for (const abs of sourceFiles(SRC)) {
    const rel = `src/${relative(SRC, abs).replaceAll("\\", "/")}`;
    if (rel.startsWith("src/test/")) continue;
    files.set(rel, readFileSync(abs, "utf8").replace(/\r\n/g, "\n"));
  }
  if (files.size < 100) throw new Error("source scan found too few files");
  return files;
}

test("the palette action registers twice, each under its own gate", () => {
  const files = srcFiles();
  pinRegistrations(files);
  const surface = files.get(SURFACE);
  const enabled = hotkeyEnabled(surface, "toggle-hide-whitespace");
  red(
    pinRegistrations,
    new Map(files).set(
      SURFACE,
      surface.replace(enabled, () => `showsToolbar && ${enabled}`),
    ),
    "showsToolbar added to DiffContent's gate",
  );
  const viewer = files.get(VIEWER);
  const gate = hotkeyEnabled(viewer, "toggle-hide-whitespace");
  red(
    pinRegistrations,
    new Map(files).set(
      VIEWER,
      viewer.replace(gate, () => gate.replace(" && discard === null", "")),
    ),
    "discard === null dropped from WorkingTreeDiff's gate",
  );
});

// Their toolbar (showsToolbar, shownView !== null), preview and narrow-pane
// arms are exercised in src/test/hide-whitespace.test.tsx.
test("the layout action registers twice", () => {
  const files = srcFiles();
  pinModeRegistrations(files);
  const surface = files.get(SURFACE);
  const a = hotkeyEnabled(surface, "toggle-diff-view-mode");
  red(
    pinModeRegistrations,
    new Map(files).set(
      SURFACE,
      surface.replace(a, () => a.replace("interactive && ", "")),
    ),
    "interactive dropped from DiffContent's layout gate",
  );
  const viewer = files.get(VIEWER);
  const b = hotkeyEnabled(viewer, "toggle-diff-view-mode");
  for (const arm of [
    "interactive &&",
    "selection === null &&",
    "discard === null &&",
  ])
    red(
      pinModeRegistrations,
      new Map(files).set(
        VIEWER,
        viewer.replace(b, () => b.replace(arm, "")),
      ),
      `${arm} dropped from WorkingTreeDiff's layout gate`,
    );
  red(
    pinModeRegistrations,
    new Map(files).set(
      "src/features/diff/Extra.tsx",
      'useHotkeyAction("toggle-diff-view-mode", () => {}, true);',
    ),
    "a third registration",
  );
});

function pinStagingGear(text) {
  const gear = once(text, "<DiffOptionsSheet", "staging sheet");
  if (/<DiffModeToggle\b|<DiffViewOptionsMenu\b/.test(text))
    throw new Error("the sheet replaces the old toolbar controls");
  const ternary = once(text, "{selection ? (");
  const block = text.indexOf("{!previewOn && (", ternary);
  if (block < 0) throw new Error("no Preview block after the selection arm");
  const masked = maskNonCode(text, true);
  const end = matchBrace(masked, block + "{!previewOn && ".length);
  const wrap = text.indexOf("ref={langWrapRef}", block);
  const wrapClose = text.indexOf("</span>", wrap);
  if (!(wrap > block && wrapClose < gear && gear < end))
    throw new Error("the sheet follows the picker wrapper, inside the block");
}

test("the staging toolbar's sheet follows the picker", () => {
  const text = source(VIEWER);
  pinStagingGear(text);
  // The whole element, through its own closing line.
  const start = once(text, "<DiffOptionsSheet");
  const close = "\n                  />";
  const line = text.slice(start, text.indexOf(close, start) + close.length);
  const block = "{!previewOn && (";
  const above = swap(text, line, "");
  const idx = above.indexOf(block, above.indexOf("{selection ? ("));
  red(
    pinStagingGear,
    `${above.slice(0, idx)}${line}${above.slice(idx)}`,
    "gear moved above the Preview block",
  );
  red(
    pinStagingGear,
    swap(text, "{selection ? (\n", `{selection ? (\n${line}\n`),
    "a second gear in the selection arm",
  );
  red(
    pinStagingGear,
    swap(text, line, `${line}\n<DiffModeToggle splitDisabled={narrowPane} />`),
    "the old Unified/Split toggle back in the toolbar",
  );
});

const HOOKS = [
  [
    "src/lib/git/queries/workingtree.ts",
    "export function fileDiffQueryOptions(",
    false,
  ],
  [
    "src/lib/git/queries/workingtree.ts",
    "export function useSessionFileDiff(",
    false,
  ],
  [
    "src/lib/git/queries/history.ts",
    "export function useCommitFileDiff(",
    true,
  ],
  [
    "src/lib/git/queries/compare.ts",
    "export function useBranchFileDiff(",
    true,
  ],
  [
    "src/lib/git/queries/stashes.ts",
    "export function useOrphanedStashFileDiff(",
    true,
  ],
  // Spreads the factory above; a placeholder could also ride its call.
  ["src/lib/git/queries/workingtree.ts", "export function useFileDiff(", false],
];

function pinPlaceholder(text, anchor, keeps) {
  const body = bodyOf(text, anchor, false);
  if (keeps && !body.includes("placeholderData: keepPreviousDataForRepo(repo)"))
    throw new Error(`${anchor} must keep keepPreviousDataForRepo`);
  if (!keeps && body.includes("placeholderData"))
    throw new Error(`${anchor} takes no placeholder`);
}

test("placeholders per hook: none for Changes, the repo's for the rest", () => {
  for (const [rel, anchor, keeps] of HOOKS)
    pinPlaceholder(source(rel), anchor, keeps);
  const wt = source(HOOKS[0][0]);
  red(
    (t) => pinPlaceholder(t, HOOKS[0][1], false),
    swap(
      wt,
      "    enabled: file !== null,\n",
      "    enabled: file !== null,\n    placeholderData: keepPreviousDataForRepo(repo),\n",
    ),
    "a placeholder on fileDiffQueryOptions",
  );
  red(
    (t) => pinPlaceholder(t, HOOKS.at(-1)[1], false),
    swap(
      wt,
      "useQuery(fileDiffQueryOptions(repo, file, hide));",
      "useQuery({\n    ...fileDiffQueryOptions(repo, file, hide),\n    placeholderData: keepPreviousDataForRepo(repo),\n  });",
    ),
    "a placeholder on useFileDiff's spread",
  );
  const cmp = source(HOOKS[3][0]);
  const branch = bodyOf(cmp, HOOKS[3][1], false);
  red(
    (t) => pinPlaceholder(t, HOOKS[3][1], true),
    cmp.replace(branch, () =>
      branch.replace(
        "placeholderData: keepPreviousDataForRepo(repo)",
        "placeholderData: keepPreviousDataForKeyAxes(repo)",
      ),
    ),
    "useBranchFileDiff on the key-axes default",
  );
});

const EARLY =
  /if \(whitespaceOff\) \{\s*paintLines\(container, \[\], split\);\s*return;\s*\}/;

function pinSelectionGates(text) {
  const manager = once(text, "const manager = createDiffMultiSelectManager(");
  const effect = text.lastIndexOf("useEffect(() => {", manager);
  const masked = maskNonCode(text, true);
  const bodyEnd = matchBrace(masked, text.indexOf("{", effect));
  const head = text.slice(effect, manager);
  if (!EARLY.test(head))
    throw new Error(
      "the manager effect must return first while writes are off",
    );
  const deps = text.slice(bodyEnd, text.indexOf(");", bodyEnd));
  if (!/\bwhitespaceOff\b/.test(deps))
    throw new Error("the manager effect must depend on whitespaceOff");
  for (const id of ["stage-selected-lines", "clear-line-selection"])
    if (!hotkeyEnabled(text, id).includes("!whitespaceOff"))
      throw new Error(`${id} must be off while whitespace is hidden`);
  const clears = once(
    text,
    "if (!hunkMode && discard !== null) setDiscard(null);",
  );
  const next = text.slice(clears, clears + 400);
  for (const clear of [
    "if (whitespaceOff && selectionState !== null) setSelectionState(null);",
    "if (whitespaceOff && discard !== null) setDiscard(null);",
  ])
    if (!next.includes(clear)) throw new Error(`missing render-time ${clear}`);
}

test("line selection and its hotkeys are off while whitespace is hidden", () => {
  const text = source(VIEWER);
  pinSelectionGates(text);
  red(
    pinSelectionGates,
    text.replace(EARLY, () => ""),
    "early return removed",
  );
  // Both gates read the same; each control drops the first one after its id.
  const dropAfter = (id) => {
    const at = text.indexOf(`"${id}"`);
    return (
      text.slice(0, at) +
      text.slice(at).replace(" &&\n      !whitespaceOff", () => "")
    );
  };
  red(
    pinSelectionGates,
    dropAfter("stage-selected-lines"),
    "!whitespaceOff dropped from stage-selected-lines",
  );
  red(
    pinSelectionGates,
    dropAfter("clear-line-selection"),
    "!whitespaceOff dropped from clear-line-selection",
  );
  red(
    pinSelectionGates,
    swap(
      text,
      "  if (whitespaceOff && selectionState !== null) setSelectionState(null);\n",
      "",
    ),
    "the selection clear removed",
  );
  red(
    pinSelectionGates,
    swap(
      text,
      "  if (whitespaceOff && discard !== null) setDiscard(null);\n",
      "",
    ),
    "the Discard confirm clear removed",
  );
});

function pinHunkButtons(text) {
  const body = bodyOf(text, "function HunkActionButtons(");
  once(body, "const held = busy || trailing || whitespaceOff;");
  once(body, "WHITESPACE_HUNK_REASON[kind]");
  if (body.split("reason={reasonFor(").length - 1 !== 2)
    throw new Error("both hunk buttons take the whitespace-aware reason");
  const mounts = text.split("<HunkActionButtons").length - 1;
  const passed = [
    ...text.matchAll(
      /<HunkActionButtons\b[^>]*whitespaceOff=\{whitespaceOff\}/g,
    ),
  ];
  if (mounts !== 3 || passed.length !== 3)
    throw new Error(
      `hunk button mounts ${mounts}, with the flag ${passed.length}`,
    );
}

test("every hunk button mount is held, with the whitespace reason", () => {
  const text = source(VIEWER);
  pinHunkButtons(text);
  red(
    pinHunkButtons,
    swap(
      text,
      "const held = busy || trailing || whitespaceOff;",
      "const held = busy || trailing;",
    ),
    "held without the flag",
  );
});

function pinComposerHold(text) {
  const widget = text.slice(
    once(text, "const renderWidgetLine = useCallback("),
  );
  if (
    !/<div\s+data-diff-line-widget=\{rebuildsOnWhitespace \? "whitespace" : "layout"\}\s+className="m-2 rounded-none border bg-popover/.test(
      widget,
    )
  )
    throw new Error(
      "the composer wrapper must tag itself whitespace or layout by its host",
    );
  const body = bodyOf(text, "export function DiffContent(");
  const hosted = body.slice(once(body, "lineWidget={lineWidget}"));
  const tag = hosted.indexOf("rebuildsOnWhitespace={whitespaceControl}");
  if (tag < 0 || tag > hosted.indexOf("/>"))
    throw new Error("DiffContent's composer host must pass whitespaceControl");
  if (body.split("setHideWhitespaceRaw").length - 1 !== 2)
    throw new Error("setHideWhitespaceRaw: a declaration and one guarded call");
  once(body, "const setHideWhitespaceRaw = useSetHideWhitespace();");
  const flip = bodyOf(body, "function flipWhitespace(");
  const check = flip.indexOf("if (whitespaceComposerOpen()) {");
  const call = flip.indexOf("setHideWhitespaceRaw(next)");
  if (check < 0 || call < 0 || check > call)
    throw new Error("flipWhitespace checks for an open composer first");
}

test("an open line composer holds every flip DiffContent owns", () => {
  const text = source(SURFACE);
  pinComposerHold(text);
  red(
    pinComposerHold,
    swap(
      text,
      'data-diff-line-widget={rebuildsOnWhitespace ? "whitespace" : "layout"}',
      "data-diff-line-widget",
    ),
    "attribute without its value",
  );
  red(
    pinComposerHold,
    swap(text, "              rebuildsOnWhitespace={whitespaceControl}\n", ""),
    "the composer host drops the flag",
  );
  red(
    pinComposerHold,
    swap(
      text,
      "                  flipWhitespace(false);\n",
      "                  setHideWhitespaceRaw(false);\n",
    ),
    "the whitespace-only button calls the raw setter",
  );
  red(
    pinComposerHold,
    swap(
      text,
      "    if (whitespaceComposerOpen()) {\n      toast.info(WHITESPACE_COMPOSER_HELD);\n      return;\n    }\n    setHideWhitespaceRaw(next);",
      "    setHideWhitespaceRaw(next);",
    ),
    "the composer check removed",
  );
});

// TRIPWIRE: every writer of the two app-wide diff settings checks its composer
// probe in the block that writes, since a flip rebuilds a hidden tab's open
// composer too. A new writer file fails until it is guarded and listed here.
const WRITER_HOOKS = {
  useSetHideWhitespace: { probe: "whitespaceComposerOpen", call: "" },
  useDiffViewMode: { probe: "lineComposerOpen", call: ".write" },
};
const TRANSCRIPT_FILE = "src/features/sessions/AgentTranscript.tsx";
const WRITER_ROSTER = {
  [SURFACE]: { useSetHideWhitespace: 1, useDiffViewMode: 2 },
  [VIEWER]: { useSetHideWhitespace: 1, useDiffViewMode: 1 },
  [TRANSCRIPT_FILE]: { useSetHideWhitespace: 1 },
};
/** Writes held instead by a `readOnly` the probe sets when the sheet opens:
 *  [file, the write's trimmed line, the source lines the hold rides]. */
const HELD_BY_READONLY = [
  [
    SURFACE,
    'if (value === "unified" || value === "split") mode.write(value);',
    [
      "          layout: lineComposerOpen(),\n",
      "            readOnly={held.layout}\n            value={mode.effective}\n",
    ],
  ],
];
/** Where each hook is defined, so its own declaration isn't read as a use. */
const HOOK_DEFINITIONS = {
  useSetHideWhitespace: "src/lib/settings/hide-whitespace.ts",
  useDiffViewMode: SURFACE,
};

/** The open brace of the innermost block enclosing `at` in masked text. */
function innermostBlock(masked, at) {
  const stack = [];
  for (let i = 0; i < at; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}") stack.pop();
  }
  if (stack.length === 0) throw new Error("no enclosing block");
  return stack[stack.length - 1];
}

/** Each use of a writer hook in `rel`, its binding name and declaration index;
 *  an import or the hook's own definition is not a use. */
function writerBindings(rel, text, masked, hook) {
  const out = [];
  for (const m of masked.matchAll(new RegExp(`\\b${hook}\\b`, "g"))) {
    const at = m.index;
    const before = masked.slice(0, at);
    if (/import\s*(type\s*)?\{[^}]*$/.test(before)) continue;
    if (rel === HOOK_DEFINITIONS[hook] && /function\s+$/.test(before)) continue;
    const decl = /const\s+(\w+)\s*=\s*$/.exec(before.slice(-80));
    if (decl === null || masked[at + hook.length] !== "(")
      throw new Error(
        `${rel}: ${hook} must be bound as \`const x = ${hook}(…)\``,
      );
    out.push({ name: decl[1], at });
  }
  return out;
}

function pinWriterGuards(files) {
  const seen = {};
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, rel.endsWith(".tsx"));
    for (const [hook, { probe, call }] of Object.entries(WRITER_HOOKS)) {
      for (const { name, at } of writerBindings(rel, text, masked, hook)) {
        seen[rel] ??= {};
        seen[rel][hook] = (seen[rel][hook] ?? 0) + 1;
        const scopeEnd = matchBrace(masked, innermostBlock(masked, at));
        const scope = masked.slice(at, scopeEnd);
        for (const m of scope.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
          const pos = at + m.index;
          const after = masked.slice(pos + name.length);
          if (call === ".write" && after.startsWith(".effective")) continue;
          if (!after.startsWith(`${call}(`))
            throw new Error(
              `${rel}: ${name} is used as a value; call it where ${probe}() is checked`,
            );
          const line = text
            .slice(text.lastIndexOf("\n", pos) + 1, text.indexOf("\n", pos))
            .trim();
          const exempt = HELD_BY_READONLY.find(
            ([f, l]) => f === rel && l === line,
          );
          if (exempt !== undefined) {
            for (const hold of exempt[2])
              if (!text.includes(hold))
                throw new Error(`${rel}: the held write lost ${hold.trim()}`);
            continue;
          }
          const block = masked.slice(innermostBlock(masked, pos), pos);
          if (!block.includes(`if (${probe}()) {`))
            throw new Error(
              `${rel}: ${name}${call}() runs without checking ${probe}() first`,
            );
        }
      }
    }
  }
  assert.deepEqual(seen, WRITER_ROSTER, "writers of the diff settings");
}

test("every diff-settings writer checks its composer probe first", () => {
  const files = srcFiles();
  pinWriterGuards(files);
  const withFile = (rel, text) => new Map([...files, [rel, text]]);
  const NEW = "src/features/x/NewWriter.tsx";
  red(
    pinWriterGuards,
    withFile(
      NEW,
      "export function NewWriter() {\n  const set = useSetHideWhitespace();\n  return <button onClick={() => set(true)} />;\n}\n",
    ),
    "a new unguarded writer file",
  );
  red(
    pinWriterGuards,
    withFile(
      NEW,
      "export function NewWriter() {\n  const set = useSetHideWhitespace();\n  function flip() {\n    if (whitespaceComposerOpen()) {\n      return;\n    }\n    set(true);\n  }\n  return <button onClick={flip} />;\n}\n",
    ),
    "a new guarded writer outside the roster",
  );
  red(
    pinWriterGuards,
    withFile(
      NEW,
      "export function NewWriter() {\n  const mode = useDiffViewMode(false);\n  return <Sheet onPick={mode.write} />;\n}\n",
    ),
    "a writer passed on as a value",
  );
  red(
    pinWriterGuards,
    withFile(
      TRANSCRIPT_FILE,
      swap(
        files.get(TRANSCRIPT_FILE),
        "            if (whitespaceComposerOpen()) {\n",
        "            if (false) {\n",
      ),
    ),
    "the transcript's probe removed",
  );
  red(
    pinWriterGuards,
    withFile(
      VIEWER,
      swap(
        files.get(VIEWER),
        "    if (whitespaceComposerOpen()) {\n",
        "    if (lineComposerOpen()) {\n",
      ),
    ),
    "the staging flip checks the layout probe",
  );
  red(
    pinWriterGuards,
    withFile(
      VIEWER,
      swap(
        files.get(VIEWER),
        "      if (lineComposerOpen()) {\n        toast.info(LAYOUT_COMPOSER_HELD);\n        return;\n      }\n",
        "",
      ),
    ),
    "the staging layout flip unguarded",
  );
  red(
    pinWriterGuards,
    withFile(
      SURFACE,
      swap(
        files.get(SURFACE),
        "            readOnly={held.layout}\n            value=",
        "            value=",
      ),
    ),
    "the sheet's radiogroup no longer held",
  );
  red(
    pinWriterGuards,
    withFile(
      SURFACE,
      swap(
        files.get(SURFACE),
        "          layout: lineComposerOpen(),\n",
        "          layout: false,\n",
      ),
    ),
    "the sheet's layout hold no longer probed",
  );
});

const COMMANDS = [
  ["src/lib/git/api/workingtree.ts", "git_diff_file"],
  ["src/lib/git/api/workingtree.ts", "git_session_file_diff"],
  ["src/lib/git/api/history.ts", "git_commit_file_diff"],
  ["src/lib/git/api/compare.ts", "git_branch_file_diff"],
  ["src/lib/git/api/stashes.ts", "git_stash_file_diff"],
  ["src/lib/git/api/stashes.ts", "git_orphaned_stash_file_diff"],
];

function pinIpcKey(text, command) {
  const at = once(text, `invoke<FileDiff>("${command}", {`);
  const open = text.indexOf("{", at);
  const masked = maskNonCode(text, false);
  const obj = text.slice(open, matchBrace(masked, open) + 1);
  if (!/[{,\s]ignoreWhitespace\s*[,}:]/.test(obj))
    throw new Error(`${command} must send ignoreWhitespace`);
}

test("every view-diff invoke sends the ignoreWhitespace key", () => {
  for (const [rel, command] of COMMANDS) pinIpcKey(source(rel), command);
  const wt = source(COMMANDS[0][0]);
  const pin = (t) => pinIpcKey(t, "git_diff_file");
  red(
    pin,
    swap(
      wt,
      "    untracked,\n    ignoreWhitespace,\n",
      "    untracked,\n    ignoreWhiteSpace,\n",
    ),
    "key misspelled",
  );
  red(
    pin,
    swap(wt, "    untracked,\n    ignoreWhitespace,\n", "    untracked,\n"),
    "key dropped",
  );
});

const FETCHERS =
  /\b(gitDiffFile|gitSessionFileDiff|gitCommitFileDiff|gitBranchFileDiff|gitStashFileDiff|gitOrphanedStashFileDiff)\(/g;
const KEY_MARKS =
  /repoKeys\.(diff|commitFileDiff|branchFileDiff)\(|"orphaned-stash-diff"|"session-worktree-diff"/;

/** Every view-diff fetch in `rel`: its innermost enclosing `readViewDiff(`
 *  call takes the mode first, and the callback's parameter is the fetch's last
 *  (whitespace) argument, so a plain read can never be stamped as a `-w` one. */
function rosterSites(rel, text) {
  const jsx = rel.endsWith(".tsx");
  const masked = maskNonCode(text, jsx);
  const sites = [];
  for (const m of masked.matchAll(FETCHERS)) {
    let outer = -1;
    for (const w of masked.slice(0, m.index).matchAll(/readViewDiff\(/g)) {
      const end = matchBrace(masked, w.index + "readViewDiff".length);
      if (end > m.index) outer = w.index;
    }
    if (outer < 0) throw new Error(`${rel}: ${m[1]} outside readViewDiff`);
    const wrapper = callArgs(text, outer + "readViewDiff".length, jsx);
    if (wrapper[0] !== "hide")
      throw new Error(
        `${rel}: readViewDiff's first argument must be the mode, found ${wrapper[0]}`,
      );
    const param = /^\(?\s*(\w+)\s*\)?\s*=>/.exec(wrapper[1] ?? "")?.[1];
    if (param === undefined)
      throw new Error(`${rel}: readViewDiff's callback takes no flag`);
    const fetchOpen = m.index + m[0].length - 1;
    if (callArgs(text, fetchOpen, jsx).at(-1) !== param)
      throw new Error(
        `${rel}: ${m[1]} must receive the callback's flag as its last argument`,
      );
    sites.push({ wrapperAt: outer, fetchOpen, param });
  }
  return sites;
}

function pinRoster(files) {
  let calls = 0;
  let keys = 0;
  for (const [rel, text] of files) {
    if (rel.startsWith("src/lib/git/api/")) continue;
    calls += rosterSites(rel, text).length;
    const masked = maskNonCode(text, rel.endsWith(".tsx"));
    for (const m of masked.matchAll(/queryKey: \[/g)) {
      const open = m.index + "queryKey: ".length;
      const arr = text.slice(open, matchBrace(masked, open) + 1);
      if (!KEY_MARKS.test(arr)) continue;
      keys++;
      const last = arr.slice(1, -1).trim().replace(/,$/, "").split(",").pop();
      if (last?.trim() !== "hide")
        throw new Error(`${rel}: a file-diff key must end in the mode axis`);
    }
  }
  if (calls !== 6)
    throw new Error(`expected 6 view-diff fetch sites, found ${calls}`);
  if (keys !== 6)
    throw new Error(`expected 6 file-diff key literals, found ${keys}`);
}

test("every view-diff fetch rides readViewDiff and keys on the mode", () => {
  const files = srcFiles();
  pinRoster(files);
  const wtv = "src/features/sessions/WorktreeChangesView.tsx";
  const view = files.get(wtv);
  red(
    pinRoster,
    new Map(files).set(
      wtv,
      view.replace(
        /readViewDiff\(hide, \(iw\) =>\s*gitDiffFile\(repoPath, path, false, untracked, iw\),\s*\)/,
        () => "gitDiffFile(repoPath, path, false, untracked)",
      ),
    ),
    "an unwrapped fetch",
  );
  red(
    pinRoster,
    new Map(files).set(
      wtv,
      `${view}\nexport const extra = () => readViewDiff(false, (iw) => gitDiffFile("r", "p", false, false, iw));\n`,
    ),
    "a seventh fetch site",
  );
  red(
    pinRoster,
    new Map(files).set(
      wtv,
      swap(
        view,
        "      untracked,\n      hide,\n    ] as const,",
        "      untracked,\n    ] as const,",
      ),
    ),
    "a key without the axis",
  );
});

test("every fetch site: the mode goes first and the flag reaches the api", () => {
  const files = srcFiles();
  let controls = 0;
  for (const [rel, text] of files) {
    if (rel.startsWith("src/lib/git/api/")) continue;
    for (const site of rosterSites(rel, text)) {
      const lead = "readViewDiff(hide";
      assert.equal(
        text.slice(site.wrapperAt, site.wrapperAt + lead.length),
        lead,
      );
      const plainMode = `${text.slice(0, site.wrapperAt)}readViewDiff(true${text.slice(site.wrapperAt + lead.length)}`;
      assert.throws(
        () => pinRoster(new Map(files).set(rel, plainMode)),
        /first argument must be the mode/,
        `${rel}: a constant mode`,
      );
      const masked = maskNonCode(text, rel.endsWith(".tsx"));
      const close = matchBrace(masked, site.fetchOpen);
      const flag = text.lastIndexOf(site.param, close);
      assert.ok(flag > site.fetchOpen, `${rel}: the flag inside the call`);
      const dropped = `${text.slice(0, flag)}false${text.slice(flag + site.param.length)}`;
      assert.throws(
        () => pinRoster(new Map(files).set(rel, dropped)),
        /must receive the callback's flag/,
        `${rel}: a constant flag`,
      );
      controls++;
    }
  }
  assert.equal(controls, 6);
  const wtv = "src/features/sessions/WorktreeChangesView.tsx";
  assert.throws(
    () =>
      pinRoster(
        new Map(files).set(
          wtv,
          swap(
            files.get(wtv),
            "(iw) =>\n        gitDiffFile(repoPath, path, false, untracked, iw),",
            "() =>\n        gitDiffFile(repoPath, path, false, untracked),",
          ),
        ),
      ),
    /callback takes no flag/,
    "the session worktree view's callback drops its flag",
  );
});

const TRANSCRIPT = "src/features/sessions/AgentTranscript.tsx";
const WS_ARM = "if (diff.data.whitespaceOnly) {";
const EMPTY_ARM = "if (!diff.data.text.trim()) {";

function pinInlineDiffArm(text) {
  const body = bodyOf(text, "function InlineDiff(");
  const arm = once(body, WS_ARM);
  if (arm > once(body, EMPTY_ARM))
    throw new Error(
      "InlineDiff: the whitespace-only arm must precede the empty arm",
    );
  const close = matchBrace(maskNonCode(body, true), arm + WS_ARM.length - 1);
  const armText = body.slice(arm, close);
  const focus = armText.indexOf("host?.focus(");
  const flip = armText.indexOf("setHideWhitespace(false)");
  if (focus < 0 || flip < 0 || focus > flip)
    throw new Error("InlineDiff: the button focuses its host before the flip");
}

test("the transcript's whitespace-only arm: ahead of the empty arm, focus first", () => {
  const text = source(TRANSCRIPT);
  pinInlineDiffArm(text);
  const wsStart = once(text, `  ${WS_ARM}`);
  const empty = `  ${EMPTY_ARM}\n    return shell(<InlineNote>No changes to show.</InlineNote>);\n  }\n`;
  const emptyAt = once(text, empty);
  const wsArm = text.slice(wsStart, emptyAt);
  assert.throws(
    () => pinInlineDiffArm(swap(text, wsArm + empty, empty + wsArm)),
    /must precede the empty arm/,
  );
  assert.throws(
    () =>
      pinInlineDiffArm(
        swap(text, "            host?.focus({ preventScroll: true });\n", ""),
      ),
    /focuses its host before the flip/,
  );
});

function pinSubmodulePane(text) {
  for (const name of ["DiffOptionsSheet", "useHideWhitespace", "readViewDiff"])
    if (new RegExp(String.raw`\b${name}\b`).test(text))
      throw new Error(`the submodule pane must not reach ${name}`);
}

test("the submodule pane reaches no whitespace machinery", () => {
  const text = source("src/features/repository/SubmoduleChangesPane.tsx");
  pinSubmodulePane(text);
  red(
    pinSubmodulePane,
    `import { useHideWhitespace } from "@/lib/settings/hide-whitespace";\n${text}`,
    "an import of the mode",
  );
});
