// Pins the Settings leave guard by source scans: every navigator in the ui store
// that writes `view` (itself or through another member) consults the guard
// before its epoch bump, or sits in a closed exempt list with its reason; the
// guard is registered only while Settings holds unsaved edits and nulled at
// cleanup; it is nulled before every resumed move; a "Save and close" continues
// only from the Save's success arm, to the move as it stands when the Save lands
// (a move intercepted meanwhile replaces it, Keep editing cancels it), after the
// Automations write it started or joined lands, and only if no user action came
// since its press; a Save landing under the open prompt continues the held move;
// and the guard's escapes are used at exactly the two system landings. Each scan
// must pass the real source and go red under every mutation listed with it, so a
// scan that can't fail on those edits fails here instead.
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
    "the remove-repository flow's close before it trashes the folder; its one caller is pinned in BYPASS_SITES",
};

/** The guard's escapes allowed outside the store, by file, in source order: a
 *  `bypassLeaveGuard: true` argument (named by the navigator it is passed to)
 *  or a call of `closeRepoUnguarded`. */
const BYPASS_SITES = {
  // Moves the app off a worktree folder the promote is about to delete.
  "src/lib/stores/worktree-removal.ts": ["openRepo"],
  // Stops status polling before the folder is trashed.
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
    !/if \(view !== "settings" \|\| settingsLeaveGuard === null\) return false;\s*settingsLeaveGuard\(resume\);\s*return true;/.test(
      iBody,
    )
  )
    problems.push(
      "the interceptor no longer refuses off Settings or unguarded",
    );
  return problems;
}

/** Problems with SettingsScreen's guard registration, `[]` when pinned: one
 *  effect keyed on `closeDirty` registers a guard that, while a "Save and close"
 *  is saving with no prompt open, replaces where it continues (stamped with
 *  this request's epoch) and asks nothing, and otherwise holds the move and
 *  opens the dialog; its cleanup (every clean flip and the unmount) nulls it. */
function registrationProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /useEffect\(\(\) => \{\s*if \(!closeDirty\) return;\s*setSettingsLeaveGuard\(\(resume\) => \{\s*if \(\s*saveLock\.current &&\s*leaveAfterSave\.current !== null &&\s*!confirmCloseRef\.current\s*\) \{\s*leaveAfterSave\.current = \{\s*run: resume,\s*epoch: useUiStore\.getState\(\)\.interactionEpoch,?\s*\};\s*return;\s*\}\s*pendingLeave\.current = resume;\s*setConfirmClose\(true\);\s*\}\);\s*return \(\) => setSettingsLeaveGuard\(null\);\s*\}, \[closeDirty, setSettingsLeaveGuard\]\);/;
  const problems = [];
  if (!effect.test(masked))
    problems.push("the guard registration lost its shape or its cleanup");
  if ((masked.match(/\bsetSettingsLeaveGuard\(\(/g) ?? []).length !== 1)
    problems.push("expected exactly one guard registration");
  return problems;
}

/** Problems with the prompt's clean-under arm, `[]` when pinned: a Save that
 *  lands while the prompt is open closes it and continues to the held move,
 *  never while a write is still in flight (the Automations patch reads clean
 *  before its write lands). */
function cleanUnderPromptProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /useEffect\(\(\) => \{\s*if \(closeDirty \|\| saving \|\| !confirmClose\) return;\s*const leave = pendingLeave\.current \?\? closeSettings;\s*pendingLeave\.current = null;\s*setConfirmClose\(false\);\s*setSettingsLeaveGuard\(null\);\s*leave\(\);\s*\}, \[\s*closeDirty,\s*saving,\s*confirmClose,\s*closeSettings,\s*setSettingsLeaveGuard,?\s*\]\);/;
  return effect.test(masked)
    ? []
    : ["a Save landing under the prompt no longer continues its move"];
}

/** Problems with the resumes, `[]` when pinned: every call of a held move
 *  (`leave()`, `leave.run()`) directly follows `setSettingsLeaveGuard(null);`:
 *  Discard and close and the clean-under arm each make one `leave()`, the
 *  Save's success arm the one `leave.run()`. */
function resumeProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const calls = [...masked.matchAll(/(?<![\w$.])leave(\.run)?\(\)/g)];
  if (calls.filter((c) => !c[1]).length !== 2)
    problems.push("expected two leave() resumes");
  if (calls.filter((c) => c[1]).length !== 1)
    problems.push("expected one leave.run() resume");
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
    /if \(\s*leaveAfterSave\.current !== null &&\s*\(automationsSaved === null \|\| \(await automationsSaved\)\)\s*\) \{\s*const leave = leaveAfterSave\.current;/.exec(
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
    !/^\{\s*if \(saveLock\.current\) return;\s*automationsAtSave\.current =\s*saveAutomationsRef\.current\?\.\(\{ quiet: true \}\) \?\? null;\s*leaveAfterSave\.current = after && \{\s*run: after,\s*epoch: useUiStore\.getState\(\)\.interactionEpoch,?\s*\};\s*form\.handleSubmit\(\);\s*$/.test(
      sBody,
    )
  )
    problems.push(
      "save() no longer calls the handle unconditionally or stamps the press's epoch",
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
  return effect.test(masked)
    ? []
    : ["the panel's save registration no longer holds through a write"];
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
  for (const mutate of mutations) {
    const mutant = mutate(text);
    assert.notEqual(mutant, text, "the mutation didn't apply");
    assert.ok(check(mutant).length > 0, "the scan passed a mutated source");
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

test("Settings registers the guard only while dirty and nulls it on cleanup", () => {
  pin(
    registrationProblems,
    source(SCREEN),
    once(
      "    return () => setSettingsLeaveGuard(null);\n  }, [closeDirty",
      "  }, [closeDirty",
    ),
    once(
      "    if (!closeDirty) return;\n    setSettingsLeaveGuard((resume)",
      "    setSettingsLeaveGuard((resume)",
    ),
    once(
      "      pendingLeave.current = resume;\n      setConfirmClose(true);",
      "      resume();",
    ),
    // A move during "Save and close" asking again instead of replacing.
    once(
      "          epoch: useUiStore.getState().interactionEpoch,\n        };\n        return;\n",
      "          epoch: useUiStore.getState().interactionEpoch,\n        };\n",
    ),
    // The replacement keeping the press's epoch, so its own request reads as
    // a newer action and the Save never continues.
    once(
      "          epoch: useUiStore.getState().interactionEpoch,\n        };\n        return;",
      "          epoch: leaveAfterSave.current.epoch,\n        };\n        return;",
    ),
    // Replacing under an open prompt, where the answer should decide.
    once(
      "        leaveAfterSave.current !== null &&\n        !confirmCloseRef.current\n",
      "        leaveAfterSave.current !== null\n",
    ),
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
      "    pendingLeave.current = null;\n    setConfirmClose(false);\n    // Synchronously",
      "    pendingLeave.current = null;\n    // Synchronously",
    ),
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
      "            (automationsSaved === null || (await automationsSaved))\n",
      "            automationsSaved === null\n",
    ),
    // A settle-time resume without the press epoch check.
    once(
      "              useUiStore.getState().interactionEpoch === leave.epoch &&\n",
      "",
    ),
    // The press stamp dropped from save().
    once(
      "      epoch: useUiStore.getState().interactionEpoch,\n    };\n    form.handleSubmit();",
      "      epoch: 0,\n    };\n    form.handleSubmit();",
    ),
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
        "      openRepo(info);\n",
        "      openRepo(info, { bypassLeaveGuard: true });\n",
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
        "get().openRepo(info))",
        "get().openRepo(info, { bypassLeaveGuard: true }))",
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
