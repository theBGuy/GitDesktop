// Pins the Settings leave guard by source scans: every navigator in the ui store
// that writes `view` (itself or through another member) consults the guard
// before its epoch bump, or sits in a closed exempt list with its reason, and the
// intercept bumps for the request before the guard runs; a cross-repo jump held on
// the repo-shell warm-up consults the guard again before it lands, since the
// guard can be registered during the hold without a bump; the guard is registered
// while Settings holds unsaved edits or a save is writing, nulled at cleanup, and
// routes through the one `requestLeave` that Back and Esc call too, which asks,
// holds a move silently while a write is in flight (dropping it on a failed or
// superseded write), or goes; it is nulled before every resumed move; a Save
// continues only from its success arm, to the move as it stands when the Save
// lands (a move intercepted meanwhile replaces it, Keep editing cancels it),
// after the Automations write it started or joined lands, and only if no user
// action came since its press; a Save landing under the open prompt continues
// the held move; and the guard's escapes are used at exactly the two system
// landings. Each scan must pass the real source and go red under every mutation
// listed with it, so a scan that can't fail on those edits fails here instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLOSE,
  maskNonCode,
  matchBrace,
  OPEN,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const UI = "src/lib/stores/ui.ts";
const SCREEN = "src/features/settings/SettingsScreen.tsx";
const AUTOMATIONS = "src/features/automations/AutomationsSection.tsx";
const ACTIVITY = "src/features/activity/ActivityDock.tsx";
const OPEN_BY_PATH = "src/features/repository/useOpenRepoByPath.ts";
const BRANCH_SWITCHER = "src/features/repository/BranchSwitcher.tsx";

/** The notification jumps' navigators, each re-checked by `stillValid`. */
const JUMP_NAVIGATORS = ["openPr", "openRun", "openAgentTab", "openRepoView"];

/** The navigators that hold a cross-repo landing on the repo-shell warm-up. */
const HELD_NAVIGATORS = [...JUMP_NAVIGATORS, "openIssue"];

/** View writers that never leave Settings through the guard, each with why. */
const EXEMPT = {
  openSettings: "lands on Settings itself",
  openMcpBrowse: "lands on Settings itself",
  closeSettings:
    "only SettingsScreen calls it, after its own Back/Esc guard; intercepting would re-prompt a confirmed close",
  closeHelp: "reachable only from the Help view",
  closeExplore: "reachable only from the Explore view",
  closeMyWork: "reachable only from the My work view",
  closeRepoUnguarded:
    "the remove-open-repository close, before the repository is removed (and its folder trashed, when asked); its one caller is pinned in BYPASS_SITES",
};

/** The guard's escapes allowed outside the store, by file, in source order: a
 *  `bypassLeaveGuard: true` argument (named by the navigator it is passed to)
 *  or a call of `closeRepoUnguarded`. */
const BYPASS_SITES = {
  // Moves the app off a worktree folder the promote is about to delete.
  "src/lib/stores/worktree-removal.ts": ["openRepo"],
  // Stops status polling before the open repository is removed (and its folder
  // trashed, when asked).
  "src/features/repository/RepoDialogs.tsx": ["closeRepoUnguarded"],
};

/** `{key, keyAt, start, end}` for each depth-0 `key: value` member of the
 *  object literal spanning `open`..`close` in `masked` (value is start..end). */
function objectMembers(masked, open, close) {
  const members = [];
  let depth = 0;
  let expectKey = true;
  let current = null;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth === 0 && c === ",") {
      if (current) members.push({ ...current, end: i });
      current = null;
      expectKey = true;
    } else if (depth === 0 && expectKey && /[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(masked.slice(i))[0];
      let after = i + word.length;
      while (/\s/.test(masked[after])) after++;
      if (masked[after] === ":") {
        current = { key: word, keyAt: i, start: after + 1 };
        i = after;
      } else i += word.length - 1;
      expectKey = false;
    } else if (!/\s/.test(c)) expectKey = false;
  }
  if (current) members.push({ ...current, end: close });
  return members;
}

/** The ui store creator's returned object: `[open, close, creatorStart]`. */
function storeObject(masked) {
  const creator = masked.indexOf(
    "export const useUiStore = create<UiState>()(",
  );
  if (creator === -1) return null;
  const returns = [...masked.slice(creator).matchAll(/\n {2}return \{/g)];
  if (returns.length !== 1) return null;
  const open = creator + returns[0].index + returns[0][0].length - 1;
  const close = matchBrace(masked, open);
  return close === -1 ? null : [open, close, creator];
}

/** Problems with the store's view writers, `[]` when pinned: each member that
 *  writes `view`, itself or by calling another member that does, is exempt or
 *  opens with `if (… interceptSettingsLeave(() => get().<itself>(…)) …) return;`
 *  ahead of its epoch bump, no `view` write sits outside a member, and the
 *  interceptor refuses off Settings or unguarded. */
function viewWriterProblems(text) {
  const masked = maskNonCode(text, false);
  const obj = storeObject(masked);
  if (!obj) return ["the store creator's returned object was not found"];
  const [open, close, creator] = obj;
  const members = objectMembers(masked, open, close);
  const valueOf = (m) => masked.slice(m.start, m.end);
  const writers = new Set(
    members
      .filter((m) => /(?<![\w$])view\s*:/.test(valueOf(m)))
      .map((m) => m.key),
  );
  // A member reaching a writer through `get().<writer>(` writes `view` too.
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of members) {
      if (writers.has(m.key)) continue;
      for (const call of valueOf(m).matchAll(/\bget\(\)\.([\w$]+)\(/g))
        if (call[1] !== m.key && writers.has(call[1])) {
          writers.add(m.key);
          grew = true;
          break;
        }
    }
  }
  const problems = [];
  if (writers.size < Object.keys(EXEMPT).length + 10)
    problems.push(`only ${writers.size} view writers found`);
  // Every `view:` from the creator on is a member's key (the initial state) or
  // inside a member's value, so a helper can't write `view` around the scan.
  for (const m of masked
    .slice(creator, close)
    .matchAll(/(?<![\w$])view\s*:/g)) {
    const at = creator + m.index;
    const placed = members.some(
      (x) => x.keyAt === at || (at >= x.start && at < x.end),
    );
    if (!placed) problems.push("a view write sits outside the store's members");
  }
  for (const name of Object.keys(EXEMPT))
    if (!writers.has(name))
      problems.push(`exempt ${name} is not a view writer`);
  for (const m of members) {
    if (!writers.has(m.key) || Object.hasOwn(EXEMPT, m.key)) continue;
    const value = valueOf(m);
    const body = /^\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*\{/.exec(value);
    if (!body) {
      problems.push(`${m.key} has no block body`);
      continue;
    }
    const first = value.slice(body[0].length).trimStart();
    if (!first.startsWith("if (")) {
      problems.push(`${m.key} doesn't open with the leave guard`);
      continue;
    }
    const condOpen = value.length - first.length + 3;
    const condClose = matchBrace(value, condOpen);
    const cond = value.slice(condOpen, condClose + 1);
    const thunk = new RegExp(
      `interceptSettingsLeave\\(\\(\\) => get\\(\\)\\.${m.key}\\(`,
    );
    if (!thunk.test(cond))
      problems.push(`${m.key}'s guard doesn't resume ${m.key} itself`);
    if (!/^\s*return;/.test(value.slice(condClose + 1)))
      problems.push(`${m.key}'s guard doesn't return`);
    const bump = value.indexOf("bumpEpochNow(");
    if (bump !== -1 && bump < condClose)
      problems.push(`${m.key} bumps the epoch before its guard`);
  }
  const intercept =
    /const interceptSettingsLeave = \(resume: \(\) => void\): boolean => \{/.exec(
      masked,
    );
  if (!intercept) return [...problems, "interceptSettingsLeave not found"];
  const iOpen = intercept.index + intercept[0].length - 1;
  const iBody = text.slice(iOpen, matchBrace(masked, iOpen));
  if (
    !/if \(view !== "settings" \|\| settingsLeaveGuard === null\) return false;\s*bumpEpochNow\(\);\s*settingsLeaveGuard\(resume\);\s*return true;/.test(
      iBody,
    )
  )
    problems.push(
      "the interceptor no longer refuses off Settings or unguarded, or no longer bumps for the request before the guard runs",
    );
  return problems;
}

/** Problems with SettingsScreen's guard registration, `[]` when pinned: one
 *  effect keyed on `guardOn` (unsaved edits OR a save writing) registers a
 *  guard that hands every move to the latest `requestLeave`; its cleanup (every
 *  flip off and the unmount) nulls it. */
function registrationProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /const guardOn = closeDirty \|\| saving;\s*useEffect\(\(\) => \{\s*if \(!guardOn\) return;\s*setSettingsLeaveGuard\(\(resume\) => requestLeaveRef\.current\(resume\)\);\s*return \(\) => setSettingsLeaveGuard\(null\);\s*\}, \[guardOn, setSettingsLeaveGuard\]\);/;
  const problems = [];
  if (!effect.test(masked))
    problems.push("the guard registration lost its shape or its cleanup");
  if ((masked.match(/\bsetSettingsLeaveGuard\(\(/g) ?? []).length !== 1)
    problems.push("expected exactly one guard registration");
  if (!/const requestLeaveRef = useLatestRef\(requestLeave\);/.test(masked))
    problems.push("the guard doesn't read the latest requestLeave");
  return problems;
}

/** `[open, close]` of `requestLeave`'s body in `masked`, or null. */
function requestLeaveBody(masked) {
  const at = /function requestLeave\(move: \(\(\) => void\) \| null\) \{/.exec(
    masked,
  );
  if (!at) return null;
  const open = at.index + at[0].length - 1;
  const close = matchBrace(masked, open);
  return close === -1 ? null : [open, close];
}

/** Problems with the one leave route, `[]` when pinned. `requestLeave` drops any
 *  move held for an Automations write first (latest intent), bumps for Back and
 *  Esc's own request (`move` null; an intercepted move's intercept already
 *  bumped) BEFORE stamping the request's epoch, and decides from LIVE refs,
 *  never render-time values: an open prompt takes the move; unsaved edits ask
 *  unless a "Save and close" is saving; a running Save holds it in
 *  `leaveAfterSave`; an Automations write alone holds it on the join-only
 *  handle (never the write-starting one) and runs it only if every write
 *  landed, it is still the held move, and the Save's resume conditions hold;
 *  otherwise it goes. Back and Esc call it with `null` and nothing else. */
function requestLeaveProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const span = requestLeaveBody(masked);
  if (!span) return ["requestLeave not found"];
  const body = masked.slice(span[0], span[1] + 1);
  const steps = [
    [
      /^\{\s*heldForAutomations\.current = null;\s*if \(move === null\) useUiStore\.getState\(\)\.noteUserInteraction\(\);\s*const run = move \?\? closeSettings;\s*const epoch = useUiStore\.getState\(\)\.interactionEpoch;\s*const noNewerOpen = repoOpenWatermark\(\);/,
      "a new move no longer drops the one held for an Automations write, Back/Esc no longer bump for their request before the stamps, or a stamp is gone",
    ],
    [
      /if \(confirmCloseRef\.current\) \{\s*pendingLeave\.current = move;\s*pendingLeaveNoNewerOpen\.current = noNewerOpen;\s*return;\s*\}/,
      "an open prompt no longer takes the move with its open watermark",
    ],
    [
      /if \(\s*closeDirtyRef\.current &&\s*!\(saveLock\.current && leaveAfterSave\.current !== null\)\s*\) \{\s*pendingLeave\.current = move;\s*pendingLeaveNoNewerOpen\.current = noNewerOpen;\s*setConfirmClose\(true\);\s*return;\s*\}/,
      "unsaved edits no longer ask with the move's open watermark (or ask during Save and close)",
    ],
    [
      /if \(saveLock\.current\) \{\s*leaveAfterSave\.current = \{ run, epoch, noNewerOpen \};\s*return;\s*\}/,
      "a running Save no longer holds the move with its stamps",
    ],
    [
      /const inFlight = joinAutomationsRef\.current\?\.\(\) \?\? null;\s*if \(inFlight !== null\) \{\s*const held = \{ run, epoch, noNewerOpen \};\s*heldForAutomations\.current = held;\s*void automationsLanded\(inFlight\)\.then\(\(ok\) => \{\s*if \(heldForAutomations\.current !== held\) return;\s*heldForAutomations\.current = null;/,
      "an Automations write no longer holds the move, or a superseded hold can still run",
    ],
    [
      /setSettingsLeaveGuard\(null\);\s*run\(\);\s*\}$/,
      "with nothing writing, the move no longer goes",
    ],
  ];
  let from = 0;
  for (const [re, problem] of steps) {
    const m = re.exec(body.slice(from));
    if (!m) {
      problems.push(problem);
      continue;
    }
    from += m.index + m[0].length;
  }
  const settle = /\.then\(\(ok\) => \{/.exec(body);
  const run = body.indexOf("held.run()");
  if (!settle || run === -1) problems.push("the held move never runs");
  else {
    const cond = body.slice(settle.index, run);
    for (const check of [
      "ok &&",
      "mounted.current",
      'useUiStore.getState().view === "',
      "useUiStore.getState().interactionEpoch === held.epoch",
      "held.noNewerOpen()",
      "!confirmCloseRef.current",
      "pendingLeave.current === null",
      "useConfirm.getState().request === null",
      "!saveLock.current",
      "!automationsDirtyRef.current",
      "!unsavedNow()",
    ])
      if (!cond.includes(check.replace(/"$/, "")))
        problems.push(`the held move lost its check ${check}`);
  }
  if (/(?<![\w$])(?:closeDirty|automationsSaving)(?![\w$])/.test(body))
    problems.push("requestLeave reads a render-time value");
  if (/\bsaveAutomationsRef\b/.test(body))
    problems.push("requestLeave can start an Automations write");
  // The wait: the given write, then every inline one still in flight, joined
  // through the join-only handle alone.
  const landed =
    /async function automationsLanded\(first: Promise<boolean> \| null\) \{\s*let ok = first === null \|\| \(await first\);\s*for \(\s*let next = joinAutomationsRef\.current\?\.\(\) \?\? null;\s*ok && next !== null;\s*next = joinAutomationsRef\.current\?\.\(\) \?\? null\s*\)\s*ok = await next;\s*return ok;\s*\}/.exec(
      masked,
    );
  if (!landed)
    problems.push(
      "the Automations wait no longer joins every in-flight write, or can start one",
    );
  if (!/onClick=\{\(\) => requestLeave\(null\)\}/.test(masked))
    problems.push("Back doesn't go through requestLeave");
  if (
    !/if \(e\.key === "\s*" && !e\.defaultPrevented\)\s*requestLeaveRef\.current\(null\);/.test(
      masked,
    )
  )
    problems.push("Esc doesn't go through requestLeave");
  // Only requestLeave and the dialog's own open path may open the prompt.
  const opens = [...masked.matchAll(/setConfirmClose\(true\)/g)].filter(
    (m) => m.index < span[0] || m.index > span[1],
  );
  if (opens.length !== 1)
    problems.push("the prompt opens outside requestLeave");
  return problems;
}

/** Problems with the prompt's clean-under arm, `[]` when pinned: a Save that
 *  lands while the prompt is open closes it and continues to the held move,
 *  never while a write is still in flight (the Automations patch reads clean
 *  before its write lands), and never once a repository open was claimed since
 *  the move was asked about (the prompt closes; the open proceeds itself). */
function cleanUnderPromptProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /useEffect\(\(\) => \{\s*if \(closeDirty \|\| saving \|\| !confirmClose\) return;\s*const leave = pendingLeave\.current \?\? closeSettings;\s*const noNewerOpen = pendingLeaveNoNewerOpen\.current;\s*pendingLeave\.current = null;\s*pendingLeaveNoNewerOpen\.current = null;\s*setConfirmClose\(false\);\s*if \(noNewerOpen !== null && !noNewerOpen\(\)\) return;\s*setSettingsLeaveGuard\(null\);\s*leave\(\);\s*\}, \[\s*closeDirty,\s*saving,\s*confirmClose,\s*closeSettings,\s*setSettingsLeaveGuard,?\s*\]\);/;
  return effect.test(masked)
    ? []
    : ["a Save landing under the prompt no longer continues its move"];
}

/** Problems with the resumes, `[]` when pinned: every call of a held move
 *  (`leave()`, `leave.run()`, `held.run()`, `run()`) directly follows
 *  `setSettingsLeaveGuard(null);`: Discard and close and the clean-under arm
 *  each make one `leave()`, the Save's success arm the one `leave.run()`, and
 *  `requestLeave` one `held.run()` (an Automations hold) and one `run()` (no
 *  write in flight). */
function resumeProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const calls = [
    ...masked.matchAll(/(?<![\w$.])(leave|held|run)(\.run)?\(\)/g),
  ];
  const count = (name, dotted) =>
    calls.filter((c) => c[1] === name && !!c[2] === dotted).length;
  if (count("leave", false) !== 2)
    problems.push("expected two leave() resumes");
  if (count("leave", true) !== 1)
    problems.push("expected one leave.run() resume");
  if (count("held", true) !== 1)
    problems.push("expected one held.run() resume");
  if (count("run", false) !== 1) problems.push("expected one run() resume");
  if (calls.length !== 5) problems.push("an unexpected held-move call");
  for (const c of calls)
    if (!/setSettingsLeaveGuard\(null\);\s*$/.test(masked.slice(0, c.index)))
      problems.push(`${c[0]} runs without nulling the guard first`);
  return problems;
}

/** Problems with Keep editing, `[]` when pinned: it cancels the held move and
 *  an in-flight "Save and close"'s, and a backdrop click or Esc is the same. */
function keepEditingProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  if (
    !/function keepEditing\(\) \{\s*pendingLeave\.current = null;\s*leaveAfterSave\.current = null;\s*setConfirmClose\(false\);\s*\}/.test(
      masked,
    )
  )
    problems.push("Keep editing no longer cancels both held moves");
  if (
    !/onOpenChange=\{\(open\) => \{\s*if \(!open\) keepEditing\(\);\s*else setConfirmClose\(true\);\s*\}\}/.test(
      masked,
    )
  )
    problems.push("dismissing the prompt is no longer Keep editing");
  return problems;
}

/** `[open, close]` of the Save body (`onSubmit: async (…) => {…}`). */
function saveBody(masked) {
  const at = masked.indexOf("onSubmit: async");
  const open = at === -1 ? -1 : masked.indexOf("{", masked.indexOf("=>", at));
  const close = open === -1 ? -1 : matchBrace(masked, open);
  return close === -1 ? null : [open, close];
}

/** Problems with the Save's continuation, `[]` when pinned:
 *  - `save()` calls the panel's registered handle whenever it is set (never
 *    gated on `automationsDirty`) and stamps the move with the press's epoch;
 *  - the Save body reads the move only in its success arm, live, after awaiting
 *    the Automations result, so nothing captured at the press can run;
 *  - it resumes only if the epoch is unchanged, no prompt is open or holding a
 *    move, and nothing changed meanwhile;
 *  - every way out of the Save drops the move. */
function continuationProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const span = saveBody(masked);
  if (!span) return ["the Save body was not found"];
  const body = masked.slice(span[0], span[1] + 1);
  const take =
    /const automationsSaved = automationsAtSave\.current;\s*automationsAtSave\.current = null;/.exec(
      body,
    );
  const write = body.indexOf("saveSettings.mutateAsync(");
  if (!take || write === -1 || take.index > write)
    problems.push("the Automations result isn't taken before the write");
  const arm = /\} else \{\s*toast\.success\("[^"]*"\);/.exec(body);
  const reads = [...body.matchAll(/\bleaveAfterSave\.current\b(?!\s*=[^=])/g)];
  const live =
    /if \(\s*leaveAfterSave\.current !== null &&\s*\(await automationsLanded\(automationsSaved\)\)\s*\) \{\s*const leave = leaveAfterSave\.current;/.exec(
      body,
    );
  if (!arm || !live || live.index < arm.index)
    problems.push(
      "the move isn't read live in the success arm after the Automations await",
    );
  else if (reads.some((r) => r.index < live.index))
    problems.push("the move is read before the Save lands");
  if ((body.match(/\.run\(/g) ?? []).length !== 1)
    problems.push("expected the move to run from one place");
  if (live) {
    const cond = body.slice(
      live.index + live[0].length,
      body.indexOf(".run(", live.index),
    );
    for (const check of [
      "leave !== null",
      "mounted.current",
      'useUiStore.getState().view === "',
      "useUiStore.getState().interactionEpoch === leave.epoch",
      "leave.noNewerOpen()",
      "!confirmCloseRef.current",
      "pendingLeave.current === null",
      "useConfirm.getState().request === null",
      "stagedRef.current.length === 0",
      "!automationsDirtyRef.current",
      "stableStringify(form.state.values) === stableStringify(value)",
    ])
      if (!cond.includes(check.replace(/"$/, "")))
        problems.push(`the resume lost its check ${check}`);
  }
  const fin = body.lastIndexOf("finally {");
  if (
    fin === -1 ||
    !/^finally \{\s*leaveAfterSave\.current = null;/.test(body.slice(fin))
  )
    problems.push("a Save's end no longer drops its move");
  const save = /function save\(after: \(\(\) => void\) \| null\) \{/.exec(
    masked,
  );
  if (!save) return [...problems, "save() not found"];
  const sOpen = save.index + save[0].length - 1;
  const sBody = masked.slice(sOpen, matchBrace(masked, sOpen));
  if (
    !/^\{\s*if \(saveLock\.current\) return;\s*automationsAtSave\.current =\s*saveAutomationsRef\.current\?\.\(\{ quiet: true \}\) \?\? null;\s*leaveAfterSave\.current = after && \{\s*run: after,\s*epoch: useUiStore\.getState\(\)\.interactionEpoch,\s*noNewerOpen: repoOpenWatermark\(\),?\s*\};\s*form\.handleSubmit\(\);\s*$/.test(
      sBody,
    )
  )
    problems.push(
      "save() no longer calls the handle unconditionally or stamps the press's epoch and open watermark",
    );
  if (/\bautomationsDirty\b/.test(sBody))
    problems.push("save() gates the Automations handle on automationsDirty");
  return problems;
}

/** Problems with the panel's save registration, `[]` when pinned: it stays
 *  registered while a write is in flight (`saving`), since the optimistic patch
 *  clears `dirty` at press. */
function panelRegistrationProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /useEffect\(\(\) => \{\s*if \(!onRegisterSave\) return;\s*onRegisterSave\(\s*dirty \|\| saving\s*\?\s*\(opts\?: \{ quiet\?: boolean \}\) => doSaveRef\.current\(opts\)\s*:\s*null,?\s*\);\s*return \(\) => onRegisterSave\(null\);\s*\}, \[dirty, saving, onRegisterSave\]\);/;
  const problems = effect.test(masked)
    ? []
    : ["the panel's save registration no longer holds through a write"];
  // The join-only handle returns the write in flight and never starts one.
  if (
    !/useEffect\(\(\) => \{\s*if \(!onRegisterJoin\) return;\s*onRegisterJoin\(\(\) => pendingSave\.current\?\.promise \?\? null\);\s*return \(\) => onRegisterJoin\(null\);\s*\}, \[onRegisterJoin\]\);/.test(
      masked,
    )
  )
    problems.push("the panel's join handle can start a write, or isn't live");
  return problems;
}

/** Problems with the panel's `dirty`, `[]` when pinned: it compares the draft
 *  as a save writes it, so a blank pattern row (which never persists) can't
 *  hold "Save and close" in Settings after the save landed. */
function sanitizedDirtyProblems(text) {
  const masked = maskNonCode(text, true);
  return /const dirty =\s*seeded\.current &&\s*sortedJson\(sanitizeLifecycles\(draft\)\) !==\s*sortedJson\(sanitizeLifecycles\(saved\)\);/.test(
    masked,
  )
    ? []
    : ["the panel's dirty compares the raw draft"];
}

/** Problems with the Automations panel's mount, `[]` when pinned: it renders
 *  while active, unsaved or writing, hidden whenever another panel is active,
 *  so a panel switch keeps its draft and handles, and as the first child of
 *  `<main>` (JSX comments aside), so space-y-8's not-last-child margin never
 *  lands on a visible panel. */
function automationsMountProblems(text) {
  const problems = [];
  if (
    !/<main\b[^>]*>\s*(?:\{\/\*(?:(?!\*\/)[\s\S])*\*\/\}\s*)*\{\(activePanel === "automations" \|\|\s*automationsDirty \|\|\s*automationsSaving\) && \(\s*<div hidden=\{activePanel !== "automations"\}>\s*<AutomationsSection\b/.test(
      text,
    )
  )
    problems.push(
      "the Automations panel no longer stays mounted, hidden, while unsaved or writing, as <main>'s first child",
    );
  if ((text.match(/<AutomationsSection\b/g) ?? []).length !== 1)
    problems.push("expected one AutomationsSection mount");
  return problems;
}

/** Problems with the hidden Automations panel, `[]` when pinned: SettingsScreen
 *  tells it whether it is the active panel; its render function returns null
 *  while inactive, at its top level and below every hook call, so a hidden
 *  panel paints nothing (no portal included); and an effect keyed on `active`
 *  dismisses the panel's own open prompt, only while it is still the open one. */
function hiddenAutomationsProblems(screen, section) {
  const problems = [];
  const sMasked = maskNonCode(screen, true);
  const tags = [...sMasked.matchAll(/<AutomationsSection\b/g)];
  if (tags.length !== 1)
    problems.push(`expected one AutomationsSection tag, found ${tags.length}`);
  else {
    // The prop in code (a comment masks it), its string value on the raw text.
    const at = tags[0].index;
    const end = tagEnd(sMasked, at);
    const prop =
      end === -1
        ? null
        : /\sactive=\{activePanel === "/.exec(sMasked.slice(at, end));
    if (
      !prop ||
      !screen.startsWith(
        'active={activePanel === "automations"}',
        at + prop.index + 1,
      )
    )
      problems.push("SettingsScreen no longer tells the panel it is active");
  }
  const masked = maskNonCode(section, true);
  const fn = /render: function AutomationsSectionRender\(/.exec(masked);
  const params = fn ? fn.index + fn[0].length - 1 : -1;
  const paramsClose = params === -1 ? -1 : matchBrace(masked, params);
  const open = paramsClose === -1 ? -1 : masked.indexOf("{", paramsClose);
  const close = open === -1 ? -1 : matchBrace(masked, open);
  if (close === -1) return [...problems, "the render function was not found"];
  const body = masked.slice(open, close + 1);
  const ret = /\n\s*if \(!active\) return null;\n/.exec(body);
  if (!ret) problems.push("the inactive panel no longer renders nothing");
  else {
    let depth = 0;
    for (const c of body.slice(0, ret.index))
      if (OPEN.has(c)) depth++;
      else if (CLOSE.has(c)) depth--;
    if (depth !== 1)
      problems.push("the inactive return is not at the render's top level");
    const hook = /\buse[A-Z][\w$]*\s*\(/;
    if (!hook.test(body.slice(0, ret.index)))
      problems.push("no hook call precedes the inactive return");
    if (hook.test(body.slice(ret.index)))
      problems.push("a hook call follows the inactive return");
  }
  if (
    !/useEffect\(\(\) => \{\s*if \(!active && useConfirm\.getState\(\)\.request === promptRef\.current\)\s*promptRef\.current\?\.resolve\(false, false\);\s*\}, \[active\]\);/.test(
      masked,
    )
  )
    problems.push("hiding the panel no longer dismisses its own prompt");
  return problems;
}

/** Problems with the footer's condition, `[]` when pinned: an Automations
 *  draft shows it on every other panel, never on Automations (its own bar). */
function footerProblems(text) {
  return /const footerVisible =\s*dirty \|\|\s*secretsDirty \|\|\s*\(automationsDirty && activePanel !== "automations"\);/.test(
    text,
  )
    ? []
    : [
        "the footer no longer covers an Automations draft from the other panels alone",
      ];
}

/** Problems with the landing side effects, `[]` when pinned: each jump
 *  navigator's transition callback calls `target.onApplied?.();` once, after
 *  its stillValid refusal and its set, openRepo's calls `opts?.onApplied?.();`
 *  once after its set, and openRepo's resume thunk forwards its opts, so a held
 *  open keeps its `onApplied`. */
function onAppliedProblems(text) {
  const masked = maskNonCode(text, false);
  const obj = storeObject(masked);
  if (!obj) return ["the store creator's returned object was not found"];
  const values = new Map(
    objectMembers(masked, obj[0], obj[1]).map((m) => [
      m.key,
      masked.slice(m.start, m.end),
    ]),
  );
  const problems = [];
  for (const name of [...JUMP_NAVIGATORS, "openRepo"]) {
    const value = values.get(name);
    if (value === undefined) {
      problems.push(`${name} not found`);
      continue;
    }
    const call =
      name === "openRepo" ? "opts?.onApplied?.();" : "target.onApplied?.();";
    if (value.split(call).length !== 2) {
      problems.push(`expected one ${call} in ${name}`);
      continue;
    }
    const cb = /startViewTransition\(\(\) => \{/.exec(value);
    const close = cb ? matchBrace(value, cb.index + cb[0].length - 1) : -1;
    if (close === -1) {
      problems.push(`${name}'s transition callback has no block body`);
      continue;
    }
    const body = value.slice(cb.index, close + 1);
    const at = body.indexOf(call);
    if (at === -1) {
      problems.push(`${name}'s onApplied runs outside its transition callback`);
      continue;
    }
    const set = /(?<![\w$.])set\(/.exec(body);
    const setClose = set ? matchBrace(body, set.index + set[0].length - 1) : -1;
    if (setClose === -1 || at < setClose)
      problems.push(`${name}'s onApplied runs before its set`);
    if (name === "openRepo") continue;
    const refuse = body.indexOf(
      "if (target.stillValid?.(epochAtRequest) === false) return;",
    );
    if (refuse === -1 || at < refuse)
      problems.push(`${name}'s onApplied runs ahead of its stillValid refusal`);
  }
  if (
    !/interceptSettingsLeave\(\(\) => get\(\)\.openRepo\(info, opts\)\)/.test(
      masked,
    )
  )
    problems.push("openRepo's resume thunk drops its opts");
  return problems;
}

/** Problems with the held landings, `[]` when pinned. Every `holdNavigation`
 *  mention in ui.ts is its import or a call inside a store member, and the
 *  members making those calls are exactly HELD_NAVIGATORS (a call it can't
 *  attribute, or a member outside the set, fails). Each of those members is,
 *  end to end: the leave guard, the request's bump, the request-time motion,
 *  one `land` closure over `startViewTransition(`, the warm-up claimed only
 *  when the target repo differs from the open one, a synchronous `land();` with
 *  no warm-up, and one `holdNavigation(warm, () => {…})` call as its last
 *  statement, with `land()` called exactly twice. The callback is exactly
 *  `if (interceptSettingsLeave(() => get().<itself>(target))) return; land();`,
 *  preceded in the `stillValid` members by that refusal, so a jump its caller
 *  retired yields silently: typing into a clean Settings registers the guard
 *  without an epoch bump, so only this re-check stops a held landing leaving
 *  unsaved edits unprompted. */
function heldLandingProblems(text) {
  const masked = maskNonCode(text, false);
  const obj = storeObject(masked);
  if (!obj) return ["the store creator's returned object was not found"];
  const members = objectMembers(masked, obj[0], obj[1]);
  const problems = [];
  const holdsBy = new Map();
  for (const ref of masked.matchAll(/(?<![\w$.])holdNavigation(?![\w$])/g)) {
    const after = masked.slice(ref.index + ref[0].length);
    if (
      /^\s*\}\s*from\s/.test(after) &&
      /import\s*\{\s*$/.test(masked.slice(0, ref.index))
    )
      continue;
    if (!/^\s*\(/.test(after)) {
      problems.push(
        "holdNavigation is referenced other than by its import or a call",
      );
      continue;
    }
    const owner = members.find(
      (m) => ref.index >= m.start && ref.index < m.end,
    );
    if (!owner) {
      problems.push("a holdNavigation call sits outside the store's members");
      continue;
    }
    if (!HELD_NAVIGATORS.includes(owner.key)) {
      problems.push(
        `${owner.key} holds a landing but isn't a pinned held navigator`,
      );
      continue;
    }
    holdsBy.set(owner.key, (holdsBy.get(owner.key) ?? 0) + 1);
  }
  const values = new Map(
    members.map((m) => [m.key, masked.slice(m.start, m.end)]),
  );
  for (const name of HELD_NAVIGATORS) {
    const value = values.get(name);
    if (value === undefined) {
      problems.push(`${name} not found`);
      continue;
    }
    const takesStillValid = JUMP_NAVIGATORS.includes(name);
    const head = new RegExp(
      `^\\s*\\(target\\)\\s*=>\\s*\\{\\s*if \\(interceptSettingsLeave\\(\\(\\) => get\\(\\)\\.${name}\\(target\\)\\)\\) return;\\s*${takesStillValid ? "const epochAtRequest = " : ""}bumpEpochNow\\(\\);\\s*const motion = repoViewMotion\\(\\);\\s*const land = \\(\\) =>\\s*startViewTransition\\(`,
    ).exec(value);
    const landClose = head ? matchBrace(value, head[0].length - 1) : -1;
    const tail =
      landClose === -1
        ? null
        : /^\s*;\s*const warm =\s*get\(\)\.repoPath !== target\.repoPath\s*\?\s*claimWarmRepoShell\(target\.repoPath\)\s*:\s*null;\s*if \(!warm\) \{\s*land\(\);\s*return;\s*\}\s*holdNavigation\(/.exec(
            value.slice(landClose + 1),
          );
    const callOpen = tail ? landClose + tail[0].length : -1;
    const callClose = tail ? matchBrace(value, callOpen) : -1;
    if (callClose === -1 || !/^\s*;\s*\}\s*$/.test(value.slice(callClose + 1)))
      problems.push(
        `${name} isn't guard, bump, motion, land, a cross-repo-only warm-up, a synchronous land without one, then the hold as its last statement`,
      );
    if ((value.match(/(?<![\w$.])land\(\)/g) ?? []).length !== 2)
      problems.push(`${name} doesn't call land() exactly twice`);
    if ((holdsBy.get(name) ?? 0) !== 1) {
      problems.push(`expected one holdNavigation( in ${name}`);
      continue;
    }
    // An unreadable shape was reported above; nothing below could be located.
    if (callClose === -1) continue;
    const cb = /^\s*warm,\s*\(\)\s*=>\s*\{/.exec(value.slice(callOpen + 1));
    if (!cb) {
      problems.push(`${name}'s hold doesn't land through a block callback`);
      continue;
    }
    const bodyOpen = callOpen + cb[0].length;
    const bodyClose = matchBrace(value, bodyOpen);
    if (
      bodyClose === -1 ||
      !/^\s*,?\s*$/.test(value.slice(bodyClose + 1, callClose))
    ) {
      problems.push(
        `${name}'s hold callback has no block body, or arguments follow it`,
      );
      continue;
    }
    const refusal = takesStillValid
      ? "if \\(target\\.stillValid\\?\\.\\(epochAtRequest\\) === false\\) return;\\s*"
      : "";
    const guard = new RegExp(
      `^\\{\\s*${refusal}if \\(interceptSettingsLeave\\(\\(\\) => get\\(\\)\\.${name}\\(target\\)\\)\\) return;\\s*land\\(\\);\\s*\\}$`,
    );
    if (!guard.test(value.slice(bodyOpen, bodyClose + 1)))
      problems.push(
        `${name}'s held landing doesn't ${takesStillValid ? "refuse a retired jump, then " : ""}re-run the leave guard for itself before it lands`,
      );
  }
  return problems;
}

/** Problems with the notification read-marks, `[]` when pinned: inside
 *  navigate(), only the two synchronous acks (automation result, no route) mark
 *  before the routed arm, and each of the four jump navigators marks through its
 *  `onApplied`, so a cancelled, refused or superseded jump leaves its row
 *  unread. */
function markReadProblems(text) {
  const masked = maskNonCode(text, true);
  const at = /const navigate = \(n: AppNotification\) => \{/.exec(masked);
  if (!at) return ["navigate() not found"];
  const open = at.index + at[0].length - 1;
  const close = matchBrace(masked, open);
  if (close === -1) return ["navigate()'s body was not found"];
  const body = masked.slice(open, close + 1);
  const routed = body.indexOf("void (async () => {");
  if (routed === -1) return ["navigate()'s routed arm was not found"];
  const problems = [];
  const marks = [...body.matchAll(/(?<![\w$.])markNotificationRead\(/g)];
  const landed = marks.filter((m) =>
    /onApplied: \(\) =>\s*$/.test(body.slice(0, m.index)),
  );
  const callees = landed.map((m) => enclosingCallee(body, m.index)).sort();
  if (JSON.stringify(callees) !== JSON.stringify([...JUMP_NAVIGATORS].sort()))
    problems.push(
      `the jump navigators' onApplied read-marks are [${callees}], expected one each`,
    );
  const bare = marks.filter((m) => !landed.includes(m));
  if (bare.length !== 2 || bare.some((m) => m.index > routed))
    problems.push("a routed jump marks its row read before it lands");
  return problems;
}

/** Problems with the repo-open event, `[]` when pinned: `repo_opened` is
 *  tracked once, from the `onApplied` the open hands `openRepo`, and both the
 *  recorded and the worktree open forward their opts to the navigator. */
function repoOpenedProblems(text) {
  const masked = maskNonCode(text, false);
  const problems = [];
  const tracks = [...text.matchAll(/track\(\{ name: "repo_opened"/g)].filter(
    (m) => masked.startsWith("track(", m.index),
  );
  if (
    tracks.length !== 1 ||
    !/onApplied: \(\) =>\s*$/.test(text.slice(0, tracks[0].index))
  )
    problems.push("repo_opened is no longer tracked once, at the landing");
  if ((masked.match(/(?<![\w$.])openRepo\(info, opts\);/g) ?? []).length !== 2)
    problems.push("an open no longer forwards its opts to openRepo");
  return problems;
}

/** Problems with the branch switcher's worktree-opened toast, `[]` when
 *  pinned: its copy is built once and shown only from the `onApplied` it hands
 *  `openWorktree`, so a failed open, one retired before it was requested, or a
 *  Settings-held one that Keep editing cancels never claims the app changed
 *  folders. */
function worktreeOpenedProblems(text) {
  const problems = [];
  if ((text.match(/\.opened\(/g) ?? []).length !== 1)
    problems.push("expected the worktree-opened copy built once");
  if ((text.match(/toast\.success\(openedCopy\)/g) ?? []).length !== 1)
    problems.push("expected the worktree-opened toast shown once");
  if (
    !/await openWorktree\(\s*wtPath,[^;]*?\{\s*onApplied: \(\) => \{\s*if \(openedCopy\) toast\.success\(openedCopy\);\s*\},?\s*\},?\s*\);/.test(
      text,
    )
  )
    problems.push("the worktree-opened toast no longer waits for the landing");
  return problems;
}

/** The navigator a call argument at `index` is passed to: the identifier before
 *  the nearest unmatched `(` around it. */
function enclosingCallee(masked, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = masked[i];
    if (CLOSE.has(c)) depth++;
    else if (OPEN.has(c)) {
      if (depth > 0) depth--;
      else if (c === "(") {
        const name = /([\w$]+)\s*$/.exec(masked.slice(0, i));
        return name ? name[1] : null;
      }
    }
  }
  return null;
}

/** Problems with where the guard's escapes are used, `[]` when pinned: outside
 *  the store only the BYPASS_SITES uses (each `bypassLeaveGuard` a literal
 *  `true`; `closeRepoUnguarded` only selected and called); inside it, no
 *  literal `true`, so no resume thunk can pass it, and `closeRepoUnguarded` is
 *  called once, from `closeRepo` (the view-writer scan pins that guard). */
function bypassProblems(files) {
  const problems = [];
  const word = /(?<![\w$])(bypassLeaveGuard|closeRepoUnguarded)(?![\w$])/g;
  for (const [rel, text] of files) {
    if (
      !/\b(?:bypassLeaveGuard|closeRepoUnguarded)\b/.test(text) &&
      !Object.hasOwn(BYPASS_SITES, rel)
    )
      continue;
    const masked = maskNonCode(text, rel.endsWith(".tsx"));
    if (rel === UI) {
      if (/(?<![\w$])bypassLeaveGuard\s*:\s*true\b/.test(masked))
        problems.push("the store passes bypassLeaveGuard itself");
      if (
        (masked.match(/(?<![\w$])closeRepoUnguarded\s*\(/g) ?? []).length !== 1
      )
        problems.push(
          "closeRepoUnguarded is called in the store outside closeRepo",
        );
      continue;
    }
    const uses = [];
    for (const h of masked.matchAll(word)) {
      const after = masked.slice(h.index + h[0].length);
      const before = masked.slice(0, h.index);
      if (h[1] === "bypassLeaveGuard") {
        if (!/^\s*:\s*true(?![\w$])/.test(after))
          problems.push(`${rel}: a bypassLeaveGuard that isn't a literal true`);
        uses.push(enclosingCallee(masked, h.index));
      } else if (/^\s*\(/.test(after)) uses.push("closeRepoUnguarded");
      else if (!/\bs\.$/.test(before) && !/const\s+$/.test(before))
        problems.push(
          `${rel}: closeRepoUnguarded is passed around, not called`,
        );
    }
    const want = BYPASS_SITES[rel] ?? [];
    if (JSON.stringify(uses) !== JSON.stringify(want))
      problems.push(
        `${rel} escapes the guard at [${uses}], expected [${want}]`,
      );
  }
  for (const rel of Object.keys(BYPASS_SITES))
    if (!files.has(rel)) problems.push(`${rel} was not scanned`);
  return problems;
}

/** Every .ts/.tsx under src/, keyed by repo-relative path. */
function srcFiles() {
  const files = new Map();
  for (const full of sourceFiles(`${ROOT}src`))
    files.set(
      relative(ROOT, full).split("\\").join("/"),
      readFileSync(full, "utf8").replace(/\r\n/g, "\n"),
    );
  return files;
}

/** Asserts `check` passes the real `text` and fails every `mutate(text)`. */
function pin(check, text, ...mutations) {
  assert.deepEqual(check(text), []);
  for (const [i, mutate] of mutations.entries()) {
    const mutant = mutate(text);
    assert.notEqual(mutant, text, `mutation #${i} didn't apply`);
    assert.ok(check(mutant).length > 0, `the scan passed mutated source #${i}`);
  }
}

/** `s` with `from` replaced exactly once (the mutation fails closed if absent). */
const once = (from, to) => (s) => s.replace(from, () => to);

test("every view writer in the ui store consults the leave guard or is exempt", () => {
  pin(
    viewWriterProblems,
    source(UI),
    once(
      "      if (interceptSettingsLeave(() => get().openHelp())) return;\n",
      "",
    ),
    once(
      "      if (interceptSettingsLeave(() => get().openMyWork())) return;\n      bumpEpochNow();\n",
      "      bumpEpochNow();\n      if (interceptSettingsLeave(() => get().openMyWork())) return;\n",
    ),
    once(
      "interceptSettingsLeave(() => get().openExplore())",
      "interceptSettingsLeave(() => get().openHelp())",
    ),
    once(
      "    closeMyWork: () => {",
      '    goWelcome: () => set({ view: "welcome" }),\n    closeMyWork: () => {',
    ),
    once("    closeMyWork: () => {", "    closeMyWorkNow: () => {"),
    once(
      "  const interceptSettingsLeave =",
      '  const leaveNow = () => set({ view: "welcome" });\n  const interceptSettingsLeave =',
    ),
    once(
      'if (view !== "settings" || settingsLeaveGuard === null)',
      "if (settingsLeaveGuard === null)",
    ),
    // The delegating close losing its guard.
    once(
      "      if (interceptSettingsLeave(() => get().closeRepo())) return;\n",
      "",
    ),
    // A new member reaching the unguarded close.
    once(
      "    closeRepoUnguarded: () => {",
      "    leaveRepo: () => get().closeRepoUnguarded(),\n    closeRepoUnguarded: () => {",
    ),
  );
});

test("the exempt list is closed and every entry carries its reason", () => {
  assert.deepEqual(Object.keys(EXEMPT).sort(), [
    "closeExplore",
    "closeHelp",
    "closeMyWork",
    "closeRepoUnguarded",
    "closeSettings",
    "openMcpBrowse",
    "openSettings",
  ]);
  for (const reason of Object.values(EXEMPT)) assert.ok(reason.length > 0);
});

test("the intercept bumps for the request before handing the move to the guard", () => {
  pin(
    viewWriterProblems,
    source(UI),
    // Bumping after the guard ran: a hold would stamp the pre-request epoch.
    once(
      "    bumpEpochNow();\n    settingsLeaveGuard(resume);\n",
      "    settingsLeaveGuard(resume);\n    bumpEpochNow();\n",
    ),
    // Not bumping at all: an older claimed repo open outlives this request.
    once(
      "    bumpEpochNow();\n    settingsLeaveGuard(resume);\n",
      "    settingsLeaveGuard(resume);\n",
    ),
  );
});

test("Settings registers the guard while dirty or saving and nulls it on cleanup", () => {
  pin(
    registrationProblems,
    source(SCREEN),
    once(
      "    return () => setSettingsLeaveGuard(null);\n  }, [guardOn",
      "  }, [guardOn",
    ),
    once(
      "    if (!guardOn) return;\n    setSettingsLeaveGuard((resume)",
      "    setSettingsLeaveGuard((resume)",
    ),
    // Registered only while dirty: a clean-but-saving Settings leaves at once.
    once(
      "  const guardOn = closeDirty || saving;",
      "  const guardOn = closeDirty;",
    ),
    once(
      "setSettingsLeaveGuard((resume) => requestLeaveRef.current(resume));",
      "setSettingsLeaveGuard((resume) => resume());",
    ),
  );
});

test("the guard, Back and Esc share one leave route that asks, holds or goes", () => {
  pin(
    requestLeaveProblems,
    source(SCREEN),
    // Back reading closeDirty alone, past the hold.
    once(
      "onClick={() => requestLeave(null)}",
      "onClick={() => (closeDirty ? setConfirmClose(true) : closeSettings())}",
    ),
    // Esc reading closeDirty alone, past the hold.
    once(
      "        requestLeaveRef.current(null);",
      "        closeDirtyRef.current ? setConfirmClose(true) : closeSettings();",
    ),
    // A running Save no longer holding: the move leaves mid-write.
    once(
      "    if (saveLock.current) {\n",
      "    if (saveLock.current && closeDirtyRef.current) {\n",
    ),
    // An Automations write alone no longer holding.
    once(
      "    const inFlight = joinAutomationsRef.current?.() ?? null;",
      "    const inFlight = null;",
    ),
    // The hold calling the write-starting handle, which re-sends (or retries)
    // the draft when the write already settled.
    once(
      "    const inFlight = joinAutomationsRef.current?.() ?? null;",
      "    const inFlight = saveAutomationsRef.current?.({ quiet: true }) ?? null;",
    ),
    // The wait joining only the first write, past one started meanwhile.
    once("      ok = await next;\n", "      break;\n"),
    once(
      "      let next = joinAutomationsRef.current?.() ?? null;",
      "      let next = saveAutomationsRef.current?.({ quiet: true }) ?? null;",
    ),
    // Back/Esc without a bump of their own: an older claimed repo open still
    // passes its check and replaces their held close.
    once(
      "    if (move === null) useUiStore.getState().noteUserInteraction();\n",
      "",
    ),
    // The bump after the stamps: the hold carries the pre-request epoch, and
    // its watermark reads Back/Esc's own request as a newer navigation.
    (s) =>
      once(
        "    const noNewerOpen = repoOpenWatermark();\n",
        "    const noNewerOpen = repoOpenWatermark();\n    if (move === null) useUiStore.getState().noteUserInteraction();\n",
      )(
        once(
          "    if (move === null) useUiStore.getState().noteUserInteraction();\n",
          "",
        )(s),
      ),
    // Bumping on every route: an intercepted move's intercept already bumped.
    once(
      "    if (move === null) useUiStore.getState().noteUserInteraction();\n",
      "    useUiStore.getState().noteUserInteraction();\n",
    ),
    // Deciding from a render-time capture instead of the live ref.
    once(
      "      closeDirtyRef.current &&\n      !(saveLock",
      "      closeDirty &&\n      !(saveLock",
    ),
    // Unsaved edits during Save and close asking again instead of replacing.
    once(
      "      !(saveLock.current && leaveAfterSave.current !== null)\n",
      "      true\n",
    ),
    // A later move no longer superseding a held one.
    once(
      "  function requestLeave(move: (() => void) | null) {\n    heldForAutomations.current = null;\n",
      "  function requestLeave(move: (() => void) | null) {\n",
    ),
  );
});

test("a failed or superseded hold never navigates", () => {
  pin(
    requestLeaveProblems,
    source(SCREEN),
    // A failed Automations write still running the move.
    once(
      "          ok &&\n          mounted.current",
      "          mounted.current",
    ),
    // A superseded hold still running.
    once("        if (heldForAutomations.current !== held) return;\n", ""),
    // A newer user action not retiring it.
    once(
      "          useUiStore.getState().interactionEpoch === held.epoch &&\n",
      "",
    ),
    // A newer repository open not retiring it (a claim moves no epoch).
    once("          held.noNewerOpen() &&\n", ""),
    once(
      "      const held = { run, epoch, noNewerOpen };",
      "      const held = { run, epoch, noNewerOpen: () => true };",
    ),
    // The same for a move held into a running Save.
    once(
      "      leaveAfterSave.current = { run, epoch, noNewerOpen };",
      "      leaveAfterSave.current = { run, epoch, noNewerOpen: () => true };",
    ),
    // The prompt's moves recorded without their watermark.
    once(
      "      pendingLeave.current = move;\n      pendingLeaveNoNewerOpen.current = noNewerOpen;\n      return;",
      "      pendingLeave.current = move;\n      return;",
    ),
    once(
      "      pendingLeave.current = move;\n      pendingLeaveNoNewerOpen.current = noNewerOpen;\n      setConfirmClose(true);",
      "      pendingLeave.current = move;\n      setConfirmClose(true);",
    ),
    // The watermark taken before Back/Esc's own bump: it would read their own
    // request as a newer navigation and never run.
    (s) =>
      once(
        "    if (move === null) useUiStore.getState().noteUserInteraction();\n",
        "    const noNewerOpen = repoOpenWatermark();\n    if (move === null) useUiStore.getState().noteUserInteraction();\n",
      )(once("    const noNewerOpen = repoOpenWatermark();\n", "")(s)),
    // A Save started since, or an edit since, not stopping it.
    // (Leading newlines keep these off the Save's deeper-indented twins.)
    once("\n          !saveLock.current &&\n", "\n"),
    once("\n          !automationsDirtyRef.current &&\n", "\n"),
    once("\n          !unsavedNow()\n", "\n          true\n"),
    // An open prompt not stopping it.
    once("\n          useConfirm.getState().request === null &&\n", "\n"),
    once("\n          !confirmCloseRef.current &&\n", "\n"),
  );
});

test("a Save landing under the open prompt continues its held move", () => {
  pin(
    cleanUnderPromptProblems,
    source(SCREEN),
    once(
      "    setSettingsLeaveGuard(null);\n    leave();\n  }, [closeDirty, saving",
      "    setSettingsLeaveGuard(null);\n  }, [closeDirty, saving",
    ),
    once(
      "    pendingLeaveNoNewerOpen.current = null;\n    setConfirmClose(false);\n",
      "    pendingLeaveNoNewerOpen.current = null;\n",
    ),
    // Running the old move after a newer repository open was claimed, which
    // closes Settings and cancels that open.
    once("    if (noNewerOpen !== null && !noNewerOpen()) return;\n", ""),
    once(
      "    if (noNewerOpen !== null && !noNewerOpen()) return;\n",
      "    if (noNewerOpen !== null && !noNewerOpen()) {\n    }\n",
    ),
    // The watermark left behind for the next prompt's move.
    once("    pendingLeaveNoNewerOpen.current = null;\n", ""),
    once(
      "    if (closeDirty || saving || !confirmClose) return;",
      "    if (!closeDirty || saving || !confirmClose) return;",
    ),
    // Leaving while the Automations write is still in flight.
    once(
      "    if (closeDirty || saving || !confirmClose) return;",
      "    if (closeDirty || !confirmClose) return;",
    ),
    once(
      "  }, [closeDirty, saving, confirmClose,",
      "  }, [closeDirty, confirmClose,",
    ),
  );
});

test("the guard is nulled before every resumed move", () => {
  pin(
    resumeProblems,
    source(SCREEN),
    once(
      "    setSettingsLeaveGuard(null);\n    leave();\n  }\n",
      "    leave();\n  }\n",
    ),
    once(
      "              setSettingsLeaveGuard(null);\n              leave.run();",
      "              leave.run();",
    ),
    once(
      "    setSettingsLeaveGuard(null);\n    leave();\n  }, [closeDirty",
      "    leave();\n  }, [closeDirty",
    ),
    once("    save(leave);", "    leave();"),
    once(
      "          setSettingsLeaveGuard(null);\n          held.run();",
      "          held.run();",
    ),
    once(
      "    setSettingsLeaveGuard(null);\n    run();\n  }",
      "    run();\n  }",
    ),
  );
});

test("Keep editing and a dismissed prompt cancel both held moves", () => {
  pin(
    keepEditingProblems,
    source(SCREEN),
    once(
      "    pendingLeave.current = null;\n    leaveAfterSave.current = null;\n    setConfirmClose(false);\n  }\n\n  function discardAndLeave",
      "    pendingLeave.current = null;\n    setConfirmClose(false);\n  }\n\n  function discardAndLeave",
    ),
    once(
      "          if (!open) keepEditing();",
      "          if (!open) setConfirmClose(false);",
    ),
  );
});

test("a Save continues only from its success arm, live, after the Automations write lands", () => {
  pin(
    continuationProblems,
    source(SCREEN),
    // Press-time capture: the move taken before the Save lands.
    (s) =>
      once(
        "            const leave = leaveAfterSave.current;\n",
        "            const leave = leaveAtPress;\n",
      )(
        once(
          "        const automationsSaved = automationsAtSave.current;\n",
          "        const leaveAtPress = leaveAfterSave.current;\n        const automationsSaved = automationsAtSave.current;\n",
        )(s),
      ),
    // The Automations await dropped.
    once(
      "            (await automationsLanded(automationsSaved))\n",
      "            automationsSaved === null\n",
    ),
    // Waiting only for the write captured at the press, past an inline one
    // started after it.
    once(
      "            (await automationsLanded(automationsSaved))\n",
      "            (automationsSaved === null || (await automationsSaved))\n",
    ),
    // A settle-time resume without the press epoch check.
    once(
      "              useUiStore.getState().interactionEpoch === leave.epoch &&\n",
      "",
    ),
    // The press stamp dropped from save().
    once(
      "      epoch: useUiStore.getState().interactionEpoch,\n      noNewerOpen",
      "      epoch: 0,\n      noNewerOpen",
    ),
    // The press's open watermark dropped, or never checked at settle: a
    // repository open claimed during the Save is cancelled by the old move.
    once(
      "      noNewerOpen: repoOpenWatermark(),\n",
      "      noNewerOpen: () => true,\n",
    ),
    once("              leave.noNewerOpen() &&\n", ""),
    // The open-prompt backstops dropped.
    once("              !confirmCloseRef.current &&\n", ""),
    once("              pendingLeave.current === null &&\n", ""),
    once("              useConfirm.getState().request === null &&\n", ""),
    // A Save's end keeping its move.
    once(
      "        // Every way out of a Save drops its move: a failed Save never leaves.\n        leaveAfterSave.current = null;\n",
      "",
    ),
    // A move run from the failure arm.
    once(
      "          return;\n        }\n        // keepDefaultValues",
      "          leaveAfterSave.current?.run();\n          return;\n        }\n        // keepDefaultValues",
    ),
    once(
      "    automationsAtSave.current =\n      saveAutomationsRef.current?.({ quiet: true }) ?? null;",
      "    if (automationsDirty)\n      automationsAtSave.current =\n        saveAutomationsRef.current?.({ quiet: true }) ?? null;",
    ),
    once("              !automationsDirtyRef.current &&\n", ""),
  );
});

test("the Automations panel stays registered while its write is in flight", () => {
  pin(
    panelRegistrationProblems,
    source(AUTOMATIONS),
    once("        dirty || saving\n", "        dirty\n"),
    once(
      "    }, [dirty, saving, onRegisterSave]);",
      "    }, [dirty, onRegisterSave]);",
    ),
    // The join handle starting a write when none is in flight.
    once(
      "      onRegisterJoin(() => pendingSave.current?.promise ?? null);",
      "      onRegisterJoin(() => doSaveRef.current({ quiet: true }));",
    ),
    once("      return () => onRegisterJoin(null);\n", ""),
  );
});

test("the Automations panel reads dirty as a save would write the draft", () => {
  pin(
    sanitizedDirtyProblems,
    source(AUTOMATIONS),
    once(
      "      sortedJson(sanitizeLifecycles(draft)) !==",
      "      sortedJson(draft) !==",
    ),
  );
});

test("the Automations panel stays mounted, hidden, while unsaved or writing", () => {
  const wrapper = '              {(activePanel === "automations" ||';
  const wrapperEnd = "                </div>\n              )}\n";
  pin(
    automationsMountProblems,
    source(SCREEN),
    // Mounted only while active: a panel switch drops the draft.
    once(
      '{(activePanel === "automations" ||\n                automationsDirty ||\n                automationsSaving) && (',
      '{activePanel === "automations" && (',
    ),
    // A switch mid-write unmounting the panel, and its join handle with it.
    once(
      "automationsDirty ||\n                automationsSaving) && (",
      "automationsDirty) && (",
    ),
    once('<div hidden={activePanel !== "automations"}>', "<div>"),
    // Trailing the panels: space-y-8 hands the visible panel a stray margin.
    (s) => {
      const start = s.indexOf(wrapper);
      if (start === -1) return s;
      const end = s.indexOf(wrapperEnd, start) + wrapperEnd.length;
      const anchor =
        "<McpServersSection form={form} secrets={secrets} />\n              )}\n";
      return once(
        anchor,
        anchor + s.slice(start, end),
      )(s.slice(0, start) + s.slice(end));
    },
  );
});

test("the hidden Automations panel renders nothing and drops its own prompt", () => {
  const screen = source(SCREEN);
  const section = source(AUTOMATIONS);
  const returnNull = "    if (!active) return null;\n";
  const lastEffect =
    "    useEffect(() => {\n      if (!onRegisterDiscard) return;\n";
  pin(
    (s) => hiddenAutomationsProblems(s, section),
    screen,
    // The panel never told it is hidden.
    once('                    active={activePanel === "automations"}\n', ""),
  );
  pin(
    (s) => hiddenAutomationsProblems(screen, s),
    section,
    // A hidden panel still painting, its Select portal included.
    once(returnNull, ""),
    once(returnNull, "    if (active) return null;\n"),
    // A hook below the return: hiding would change the hook order.
    (s) => once(lastEffect, returnNull + lastEffect)(once(returnNull, "")(s)),
    once(returnNull, `${returnNull}    useLatestRef(active);\n`),
    // The prompt left open over the next panel.
    once(
      "    useEffect(() => {\n      if (!active && useConfirm.getState().request === promptRef.current)\n        promptRef.current?.resolve(false, false);\n    }, [active]);\n",
      "",
    ),
    // Resolving whatever prompt is open, another surface's included.
    once(
      "if (!active && useConfirm.getState().request === promptRef.current)",
      "if (!active)",
    ),
    once("    }, [active]);\n", "    }, []);\n"),
  );
  // Arms one mutation could trip alongside another, each asserted by its own
  // problem so a co-tripped arm can't stand in for it.
  const redFor = (problem, sc, se) => {
    assert.ok(sc !== screen || se !== section, `no mutation for: ${problem}`);
    const found = hiddenAutomationsProblems(sc, se);
    assert.ok(found.includes(problem), `expected "${problem}", got [${found}]`);
  };
  const propLine =
    '                    active={activePanel === "automations"}\n';
  redFor(
    "SettingsScreen no longer tells the panel it is active",
    once(
      propLine,
      '                    {/* active={activePanel === "automations"} */}\n',
    )(screen),
    section,
  );
  redFor(
    "SettingsScreen no longer tells the panel it is active",
    once(
      propLine,
      '                    active={activePanel === "automation"}\n',
    )(screen),
    section,
  );
  redFor(
    "expected one AutomationsSection tag, found 2",
    once(
      '{activePanel === "general" && <GeneralSection form={form} />}',
      '{activePanel === "general" && <AutomationsSection form={form} />}',
    )(screen),
    section,
  );
  redFor(
    "the inactive return is not at the render's top level",
    screen,
    once(returnNull, `    {\n  ${returnNull}    }\n`)(section),
  );
  redFor(
    "no hook call precedes the inactive return",
    screen,
    once(
      "    const automations = useAutomations();\n",
      `${returnNull}    const automations = useAutomations();\n`,
    )(once(returnNull, "")(section)),
  );
});

test("the footer covers an Automations draft from every other panel", () => {
  pin(
    footerProblems,
    source(SCREEN),
    once(
      '    dirty ||\n    secretsDirty ||\n    (automationsDirty && activePanel !== "automations");',
      "    dirty || secretsDirty;",
    ),
    // Shown on Automations too, doubling the panel's own bar.
    once(
      '(automationsDirty && activePanel !== "automations")',
      "automationsDirty",
    ),
  );
});

test("the navigators run onApplied only once their landing applies", () => {
  pin(
    onAppliedProblems,
    source(UI),
    // Ahead of the stillValid refusal: a refused landing would still fire it.
    (s) =>
      once(
        "        if (target.stillValid?.(epochAtRequest) === false) return;\n",
        "        target.onApplied?.();\n        if (target.stillValid?.(epochAtRequest) === false) return;\n",
      )(once("        target.onApplied?.();\n", "")(s)),
    once("        target.onApplied?.();\n", ""),
    once("        opts?.onApplied?.();\n", ""),
    // A held open resumed without its opts loses its onApplied.
    once("get().openRepo(info, opts))", "get().openRepo(info))"),
  );
});

test("a held cross-repo jump re-runs the leave guard before it lands", () => {
  pin(
    heldLandingProblems,
    source(UI),
    // Dropping the settle-time re-check: typing into Settings during the hold
    // would be left unprompted.
    once(
      "        if (interceptSettingsLeave(() => get().openPr(target))) return;\n        land();\n",
      "        land();\n",
    ),
    // Landing ahead of the re-check.
    once(
      "        if (interceptSettingsLeave(() => get().openRun(target))) return;\n        land();\n",
      "        land();\n        if (interceptSettingsLeave(() => get().openRun(target))) return;\n",
    ),
    // A resume that re-requests a different navigator.
    once(
      "get().openIssue(target))) return;\n        land();",
      "get().openPr(target))) return;\n        land();",
    ),
    // A same-repo jump held, or one without a warm-up no longer landing at once.
    once(
      "        get().repoPath !== target.repoPath\n          ? claimWarmRepoShell(target.repoPath)\n          : null;\n",
      "        claimWarmRepoShell(target.repoPath);\n",
    ),
    once("      if (!warm) {\n        land();\n        return;\n      }\n", ""),
    // A stillValid member re-checking Settings for a jump its caller retired.
    once(
      "        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openAgentTab(target))) return;\n",
      "        if (interceptSettingsLeave(() => get().openAgentTab(target))) return;\n",
    ),
    // The refusal after the re-check: a retired jump would still prompt.
    once(
      "        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openRepoView(target))) return;\n",
      "        if (interceptSettingsLeave(() => get().openRepoView(target))) return;\n        if (target.stillValid?.(epochAtRequest) === false) return;\n",
    ),
    // A second hold in one member.
    once(
      "      holdNavigation(warm, () => {\n        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openRun(",
      "      holdNavigation(warm, land);\n      holdNavigation(warm, () => {\n        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openRun(",
    ),
    // A callback that isn't an arrow with a block body.
    once(
      "      holdNavigation(warm, () => {\n        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openRepoView(",
      "      holdNavigation(warm, function () {\n        if (target.stillValid?.(epochAtRequest) === false) return;\n        if (interceptSettingsLeave(() => get().openRepoView(",
    ),
    // An argument after the callback.
    once(
      "        land();\n      });\n    },\n    setRepoTab:",
      "        land();\n      }, 0);\n    },\n    setRepoTab:",
    ),
    // An extra, unheld landing.
    once(
      "      // Held across repos like openPr, which carries the rationale.\n",
      "      land();\n",
    ),
    // A hold outside the store's members, a new member holding, and an alias.
    once(
      "export const useUiStore =",
      "const holdLater = (w, l) => holdNavigation(w, l);\nexport const useUiStore =",
    ),
    once(
      "    setRepoTab: (tab) =>",
      "    openElsewhere: (target) => {\n      holdNavigation(target.warm, () => target.land());\n    },\n    setRepoTab: (tab) =>",
    ),
    once(
      "export const useUiStore =",
      "const hold = holdNavigation;\nexport const useUiStore =",
    ),
  );
});

test("a notification jump reads its row only when the landing applies", () => {
  pin(
    markReadProblems,
    source(ACTIVITY),
    once(
      "      openPr({\n",
      "      markNotificationRead(n.id);\n      openPr({\n",
    ),
    once("          onApplied: () => markNotificationRead(n.id),\n", ""),
  );
});

test("repo_opened is tracked when the open lands", () => {
  pin(
    repoOpenedProblems,
    source(OPEN_BY_PATH),
    once(
      '    ) =>\n      openRecorded(info, stillCurrent, {\n        onApplied: () => track({ name: "repo_opened", properties: { source } }),\n      }),\n',
      '    ) => {\n      const opened = await openRecorded(info, stillCurrent);\n      if (opened) track({ name: "repo_opened", properties: { source } });\n      return opened;\n    },\n',
    ),
    once("      openRepo(info, opts);\n", "      openRepo(info);\n"),
    // The worktree open dropping its opts: its caller's toast never fires.
    once("        openRepo(info, opts);\n", "        openRepo(info);\n"),
  );
});

test("the worktree-opened toast waits for the open to land", () => {
  pin(
    worktreeOpenedProblems,
    source(BRANCH_SWITCHER),
    // Back to the request-time toast, gated only on the resolved verdict.
    once(
      "      await openWorktree(\n        wtPath,\n        () => switchRequest === switchRequestRef.current,\n        {\n          onApplied: () => {\n            if (openedCopy) toast.success(openedCopy);\n          },\n        },\n      );\n",
      "      const navigated = await openWorktree(\n        wtPath,\n        () => switchRequest === switchRequestRef.current,\n      );\n      if (navigated && openedCopy) toast.success(openedCopy);\n",
    ),
    // The toast both at the landing and at the request.
    once(
      "      return;\n    }\n    // with work in progress",
      "      if (openedCopy) toast.success(openedCopy);\n      return;\n    }\n    // with work in progress",
    ),
  );
});

test("the guard's escapes are used at exactly the two system landings", () => {
  const files = srcFiles();
  assert.deepEqual(bypassProblems(files), []);
  const mutated = (rel, mutate) => {
    const next = new Map(files);
    const text = next.get(rel);
    const mutant = mutate(text);
    assert.notEqual(mutant, text, "the mutation didn't apply");
    next.set(rel, mutant);
    return next;
  };
  for (const [rel, mutate] of [
    // A third passer.
    [
      "src/features/repository/useOpenRepoByPath.ts",
      once(
        "      openRepo(info, opts);\n",
        "      openRepo(info, { ...opts, bypassLeaveGuard: true });\n",
      ),
    ],
    // The failure reopen escaping again.
    [
      "src/features/repository/RepoDialogs.tsx",
      once(
        "openRepo({ root: repo.path, name: repo.name });",
        "openRepo({ root: repo.path, name: repo.name }, { bypassLeaveGuard: true });",
      ),
    ],
    // A resume thunk passing it.
    [
      UI,
      once(
        "get().openRepo(info, opts))",
        "get().openRepo(info, { ...opts, bypassLeaveGuard: true }))",
      ),
    ],
    // A site dropping its escape.
    [
      "src/lib/stores/worktree-removal.ts",
      once("openRepo(info, { bypassLeaveGuard: true })", "openRepo(info)"),
    ],
    [
      "src/features/repository/RepoDialogs.tsx",
      once("if (wasOpen) closeRepoUnguarded();", "if (wasOpen) closeRepo();"),
    ],
    // Something other than a literal true.
    [
      "src/lib/stores/worktree-removal.ts",
      once(
        "openRepo(info, { bypassLeaveGuard: true })",
        "openRepo(info, { bypassLeaveGuard: !!info })",
      ),
    ],
    // A new caller of the unguarded close, called or handed to a handler.
    [
      "src/features/repository/RepoHeader.tsx",
      once(
        "onClick={closeRepo}",
        "onClick={() => useUiStore.getState().closeRepoUnguarded()}",
      ),
    ],
    [
      "src/features/repository/RepoHeader.tsx",
      once(
        "onClick={closeRepo}",
        "onClick={useUiStore.getState().closeRepoUnguarded}",
      ),
    ],
  ])
    assert.ok(
      bypassProblems(mutated(rel, mutate)).length > 0,
      `the scan passed a mutated ${rel}`,
    );
});
