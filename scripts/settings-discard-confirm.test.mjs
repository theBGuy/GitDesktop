// Pins the Settings footer Discard: its confirm copy (the staged-secret count
// singular at one value), when a confirmed Discard still acts, and, by source
// scans the pure helpers can't see, the wiring around them: the prompt's scope
// and copy, the one counter bump behind a confirmed answer, the reset's buffer,
// baseline and Automations-draft writes, the footer- and bar-hide focus rules,
// both screens' prompt dismissal at unmount, the failed write's arm, the
// Automations panel's own Discard prompt and draft registration, the toaster's
// offset props and its ban on the wrapper-overriding props, and the clearance
// module's import-free shape. Each scan must pass the real source and go red
// under every mutation listed with it, so a scan that can't fail on those edits
// fails here instead.
//
// `save-reset.ts` is runtime-import-free, so this suite imports it straight from
// `src/` under Node's type stripping and runs in the no-install `guards` job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  discardActs,
  discardConfirmBody,
} from "../src/features/settings/save-reset.ts";
import {
  CLOSE,
  escapeRe,
  maskNonCode,
  matchBrace,
  OPEN,
  tagEnd,
} from "./lib/ts-mask.mjs";

const source = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

const SCREEN = "src/features/settings/SettingsScreen.tsx";
const MAIN = "src/main.tsx";
const CLEARANCE = "src/lib/toast-clearance.ts";
const AUTOMATIONS = "src/features/automations/AutomationsSection.tsx";

// ------------------------------------------------------------- pure helpers

test("the confirm body omits secrets when none are staged", () => {
  assert.equal(
    discardConfirmBody(0),
    "Every edit since your last save is undone.",
  );
});

test("the confirm body counts one staged value in the singular", () => {
  assert.equal(
    discardConfirmBody(1),
    "Every edit since your last save is undone, including 1 secret value you typed. Secrets already saved to your keychain aren't touched.",
  );
});

test("the confirm body counts several staged values in the plural", () => {
  assert.equal(
    discardConfirmBody(2),
    "Every edit since your last save is undone, including 2 secret values you typed. Secrets already saved to your keychain aren't touched.",
  );
});

const draft = { theme: "dark", servers: [{ id: "a", name: "github" }] };

test("a confirmed Discard acts while secrets are staged", () => {
  assert.equal(
    discardActs({ current: draft, fresh: draft, stagedCount: 1 }),
    true,
  );
  assert.equal(
    discardActs({ current: draft, fresh: null, stagedCount: 2 }),
    true,
  );
});

test("a confirmed Discard does nothing once nothing is unsaved", () => {
  assert.equal(
    discardActs({ current: draft, fresh: { ...draft }, stagedCount: 0 }),
    false,
  );
  // Key order is not a difference: the store round-trips reordered objects.
  const reordered = { servers: [{ name: "github", id: "a" }], theme: "dark" };
  assert.equal(
    discardActs({ current: reordered, fresh: draft, stagedCount: 0 }),
    false,
  );
});

test("a confirmed Discard acts on a draft that differs from the cache", () => {
  assert.equal(
    discardActs({
      current: { ...draft, theme: "light" },
      fresh: draft,
      stagedCount: 0,
    }),
    true,
  );
});

test("a confirmed Discard with no cached settings and nothing staged does nothing", () => {
  assert.equal(
    discardActs({ current: draft, fresh: null, stagedCount: 0 }),
    false,
  );
});

// ------------------------------------------------------------- source scans

/** `[open, close]` of the `{…}` body of `function <name>(…)` in `masked`. */
function functionBody(masked, name) {
  const m = new RegExp(`function ${name}\\s*\\(`).exec(masked);
  if (!m) return null;
  const open = masked.indexOf("{", m.index + m[0].length);
  const close = open === -1 ? -1 : matchBrace(masked, open);
  return close === -1 ? null : [open, close];
}

/** The raw text of property `key`'s value in the object literal spanning
 *  `open`..`close` of `masked`, read at that object's own depth only, so a
 *  key in a comment, a string or a nested object never counts (the same walk
 *  confirm-scope.test.mjs runs). `null` when the literal has no such key. */
function topLevelValue(masked, text, open, close, key) {
  let depth = 0;
  let expectKey = true;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (OPEN.has(c)) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (depth === 0 && c === ",") expectKey = true;
    else if (depth === 0 && expectKey && /[\w$]/.test(c)) {
      const word = /^[\w$]+/.exec(masked.slice(i))[0];
      let after = i + word.length;
      while (/\s/.test(masked[after])) after++;
      if (word === key && masked[after] === ":") {
        let end = after + 1;
        for (let d = 0; end < close; end++) {
          if (OPEN.has(masked[end])) d++;
          else if (CLOSE.has(masked[end])) d--;
          else if (d === 0 && masked[end] === ",") break;
        }
        return text.slice(after + 1, end).trim();
      }
      expectKey = false;
      i += word.length - 1;
    } else if (!/\s/.test(c)) expectKey = false;
  }
  return null;
}

const ASK_ENTRIES = {
  scope: '"app"',
  title: '"Discard unsaved changes?"',
  confirmLabel: '"Discard changes"',
  confirmVariant: '"destructive"',
};

/** Problems with `requestDiscard`'s prompt literal in `text` against
 *  `entries` (key to raw value), `[]` when pinned. */
function promptLiteralProblems(text, entries) {
  const masked = maskNonCode(text, true);
  const request = functionBody(masked, "requestDiscard");
  if (!request) return ["requestDiscard not found"];
  const asks = [
    ...masked
      .slice(request[0], request[1])
      .matchAll(/useConfirm\s*\.getState\(\)\s*\.ask\(/g),
  ];
  if (asks.length !== 1)
    return [`expected one ask in requestDiscard, found ${asks.length}`];
  let open = request[0] + asks[0].index + asks[0][0].length;
  while (/\s/.test(masked[open])) open++;
  const close = masked[open] === "{" ? matchBrace(masked, open) : -1;
  if (close === -1) return ["the ask's argument is not an inline literal"];
  return Object.entries(entries)
    .map(([key, want]) => [
      key,
      want,
      topLevelValue(masked, text, open, close, key),
    ])
    .filter(([, want, got]) => got !== want)
    .map(([key, want, got]) => `${key} is ${got ?? "missing"}, not ${want}`);
}

/** Problems with SettingsScreen's Discard prompt literal, `[]` when pinned. */
const askLiteralProblems = (text) => promptLiteralProblems(text, ASK_ENTRIES);

const AUTOMATIONS_ASK_ENTRIES = {
  ...ASK_ENTRIES,
  body: '"Every automation rule change since your last save is undone."',
};

/** Problems with the Automations panel's inline Discard, `[]` when pinned:
 *  its button asks through `requestDiscard`, whose app-scoped prompt carries
 *  the confirmed copy and whose draft reset runs only after a confirmed answer. */
function automationsAskProblems(text) {
  const problems = promptLiteralProblems(text, AUTOMATIONS_ASK_ENTRIES);
  const masked = maskNonCode(text, true);
  const request = functionBody(masked, "requestDiscard");
  if (!request) return problems;
  const body = masked.slice(request[0], request[1]);
  const guard = body.indexOf("if (!ok) {");
  const guardEnd = guard === -1 ? -1 : matchBrace(body, guard + 9);
  const resets = [...body.matchAll(/\bdiscard\(\)/g)];
  if (guardEnd === -1 || resets.length !== 1 || resets[0].index < guardEnd)
    problems.push("the draft reset doesn't wait for a confirmed answer");
  if (!/onClick=\{requestDiscard\}/.test(masked))
    problems.push("the Discard button no longer asks first");
  if (/onClick=\{discard\}/.test(masked))
    problems.push("a button resets the draft without asking");
  return problems;
}

/** Problems with the footer Discard's reach into the Automations draft, `[]`
 *  when pinned: applyDiscard calls the panel's registered discard only while
 *  the panel is dirty, the host wires the registration, and the panel
 *  registers its discard while dirty. */
function automationsDiscardRefProblems(screen, section) {
  const masked = maskNonCode(screen, true);
  const apply = functionBody(masked, "applyDiscard");
  if (!apply) return ["applyDiscard not found"];
  const problems = [];
  if (
    !/if \(automationsDirtyRef\.current\)\s*discardAutomationsRef\.current\?\.\(\);/.test(
      masked.slice(apply[0], apply[1]),
    )
  )
    problems.push("applyDiscard no longer resets a dirty Automations draft");
  if (
    !/const automationsDirtyRef = useLatestRef\(automationsDirty\)/.test(masked)
  )
    problems.push("the dirty gate no longer reads the live automationsDirty");
  if (
    !/onRegisterDiscard=\{\(fn\) => \{\s*discardAutomationsRef\.current = fn;\s*\}\}/.test(
      masked,
    )
  )
    problems.push("the host no longer wires the panel's discard");
  const panel = maskNonCode(section, true);
  if (
    !/onRegisterDiscard\(dirty \? \(\) => discardRef\.current\(\) : null\)/.test(
      panel,
    )
  )
    problems.push("the panel no longer registers its discard while dirty");
  return problems;
}

/** Problems with where the Discard counter bumps, `[]` when pinned. */
function bumpProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const bumps = [...masked.matchAll(/discards\.current \+= 1/g)];
  const apply = functionBody(masked, "applyDiscard");
  const request = functionBody(masked, "requestDiscard");
  if (!apply) return ["applyDiscard not found"];
  if (!request) return ["requestDiscard not found"];
  if (bumps.length !== 1)
    problems.push(`expected one counter bump, found ${bumps.length}`);
  else if (bumps[0].index < apply[0] || bumps[0].index > apply[1])
    problems.push("the counter bump sits outside applyDiscard");
  const body = masked.slice(request[0], request[1]);
  const calls = [...body.matchAll(/\bapplyDiscard\(\)/g)];
  const check = body.indexOf("if (!ok)");
  if (calls.length !== 1)
    problems.push(`expected one applyDiscard() in requestDiscard`);
  else if (check === -1 || calls[0].index < check)
    problems.push("applyDiscard() runs before the `if (!ok)` check");
  return problems;
}

/** Problems with applyDiscard's buffer and baseline resets, `[]` when pinned. */
function resetProblems(text) {
  const masked = maskNonCode(text, true);
  const apply = functionBody(masked, "applyDiscard");
  if (!apply) return ["applyDiscard not found"];
  const body = masked.slice(apply[0], apply[1]);
  const problems = [];
  if (!/\bcommitStaged\(\[\]\)/.test(body))
    problems.push("applyDiscard no longer clears the staged buffer");
  if (!/\bmcpBaseline\.current\s*=/.test(body))
    problems.push("applyDiscard no longer resets the MCP baseline");
  return problems;
}

/** Problems with applyDiscard's settings read, `[]` when pinned: it reads the
 *  cache at call time, never the observer's last render. */
function freshReadProblems(text) {
  const masked = maskNonCode(text, true);
  const apply = functionBody(masked, "applyDiscard");
  if (!apply) return ["applyDiscard not found"];
  const body = masked.slice(apply[0], apply[1]);
  const problems = [];
  if (!/\.getQueryData\b[^;]*\(\s*settingsKeys\.settings\s*\)/.test(body))
    problems.push("applyDiscard no longer reads the settings cache");
  if (/\bsettings\.data\b/.test(body))
    problems.push("applyDiscard reads the observer's settings.data");
  return problems;
}

/** Problems with requestDiscard's nothing-left-to-undo arm, `[]` when pinned. */
function noOpGateProblems(text) {
  const masked = maskNonCode(text, true);
  const request = functionBody(masked, "requestDiscard");
  const unsaved = functionBody(masked, "unsavedNow");
  if (!request || !unsaved) return ["requestDiscard or unsavedNow not found"];
  const problems = [];
  if (!/\bdiscardActs\(/.test(masked.slice(unsaved[0], unsaved[1])))
    problems.push("unsavedNow no longer asks discardActs");
  const body = masked.slice(request[0], request[1]);
  const gate = /if \(!unsavedNow\(\)\) \{[^{}]*\breturn;\s*\}/.exec(body);
  const call = body.search(/\bapplyDiscard\(\)/);
  if (!gate) problems.push("requestDiscard lost its no-op arm");
  else if (call === -1 || call < gate.index)
    problems.push("applyDiscard() runs before the no-op arm");
  return problems;
}

/** Problems with the Save body's failed-write arm, `[]` when pinned: the
 *  settings write sits in a try whose catch toasts and returns before the
 *  form reset, so the draft survives and no keychain work runs. */
function failedWriteProblems(text) {
  const masked = maskNonCode(text, true);
  const at = masked.indexOf("onSubmit: async");
  const open = at === -1 ? -1 : masked.indexOf("{", masked.indexOf("=>", at));
  const close = open === -1 ? -1 : matchBrace(masked, open);
  if (close === -1) return ["the Save body was not found"];
  const write = masked.indexOf("saveSettings.mutateAsync(", open);
  if (write === -1 || write > close)
    return ["the settings write was not found"];
  let tryOpen = -1;
  for (const m of masked.slice(open, write).matchAll(/\btry\s*\{/g)) {
    const brace = open + m.index + m[0].length - 1;
    if (matchBrace(masked, brace) > write) tryOpen = brace;
  }
  if (tryOpen === -1) return ["the settings write is not inside a try"];
  if (!/\bawait\s+$/.test(masked.slice(tryOpen, write)))
    return ["the settings write is not awaited inside its try"];
  const tryClose = matchBrace(masked, tryOpen);
  const katch = /^\s*catch\s*\([^)]*\)\s*\{/.exec(masked.slice(tryClose + 1));
  if (!katch) return ["the write's try has no catch"];
  const catchOpen = tryClose + katch[0].length;
  const catchClose = matchBrace(masked, catchOpen);
  const handler = masked.slice(catchOpen, catchClose);
  const problems = [];
  if (!/\btoast(?:ComposedError|Error|ErrorWithNote)\(/.test(handler))
    problems.push("the catch shows no error toast");
  if (!/\breturn;/.test(handler)) problems.push("the catch doesn't return");
  const reset = masked.indexOf("form.reset(", open);
  if (reset !== -1 && reset < catchClose)
    problems.push("the form reset runs before the failed-write arm");
  return problems;
}

/** Problems with a hide-focus rule, `[]` when pinned: one layout effect keyed
 *  on the bar's visibility (`rule.shown`) acts only on a shown-to-hidden flip,
 *  consumes the Discard aim (`rule.aim`) on every flip before its guard, and
 *  then calls `rule.focus` only when that aim was set or focus fell to body
 *  with the removed bar, leaving it alone else. */
function hideFocusProblems(text, rule) {
  const { shown, was, aim, focus } = rule;
  const masked = maskNonCode(text, true);
  const effects = [];
  for (const m of masked.matchAll(/useLayoutEffect\(\(\) => \{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    const deps = new RegExp(`^\\s*,\\s*\\[${shown}\\]\\s*\\)`);
    if (deps.test(masked.slice(close + 1)))
      effects.push(masked.slice(open, close));
  }
  if (effects.length !== 1)
    return [`expected one [${shown}] layout effect, found ${effects.length}`];
  const body = effects[0];
  const has = (literal) => body.includes(literal);
  const problems = [];
  if (!has(`${was}.current && !${shown}`))
    problems.push("the effect no longer acts only on a shown-to-hidden flip");
  if (!has(`${was}.current = ${shown};`))
    problems.push("the effect no longer records the bar's visibility");
  if (!has(`const aimed = ${aim}.current`))
    problems.push(`the gate's aim no longer reads ${aim}`);
  if (!has(`${aim}.current = false`))
    problems.push("the effect no longer consumes the Discard aim");
  if (!has("const active = document.activeElement"))
    problems.push("the gate no longer reads document.activeElement");
  const gate = new RegExp(`if \\(([^)]*)\\)\\s*${escapeRe(focus)}`).exec(body);
  if (!gate) return [...problems, "the effect no longer moves focus"];
  for (const arm of ["aimed", "active === null", "active === document.body"])
    if (!gate[1].includes(arm)) problems.push(`the focus gate lost ${arm}`);
  if (
    !/if \(!hid\) return;\s*const active = document\.activeElement/.test(body)
  )
    problems.push("the hide guard no longer directly precedes the focus read");
  const consume = body.indexOf(`${aim}.current = false`);
  const guard = body.indexOf("if (!hid) return;");
  if (consume === -1 || guard === -1 || consume > guard)
    problems.push(
      "the Discard aim is no longer consumed before the hide guard",
    );
  return problems;
}

const footerHideProblems = (text) =>
  hideFocusProblems(text, {
    shown: "footerVisible",
    was: "footerWasVisible",
    aim: "pendingRailFocus",
    focus: "focusRailItem(",
  });

const barHideProblems = (text) =>
  hideFocusProblems(text, {
    shown: "dirty",
    was: "barWasShown",
    aim: "pendingHeadingFocus",
    focus: "headingRef.current?.focus(",
  });

/** Problems with a screen's prompt dismissal, `[]` when pinned:
 *  `requestDiscard` records the request its ask opened, and an unmount-only
 *  effect resolves it `false` only while it is still the open prompt. */
function promptDismissalProblems(text) {
  const masked = maskNonCode(text, true);
  const problems = [];
  const request = functionBody(masked, "requestDiscard");
  if (!request) return ["requestDiscard not found"];
  const body = masked.slice(request[0], request[1]);
  if (
    !/\.ask\([\s\S]*?\);\s*const mine = useConfirm\.getState\(\)\.request;\s*promptRef\.current = mine;/.test(
      body,
    )
  )
    problems.push("requestDiscard no longer records the request it opened");
  const cleanup =
    /useEffect\(\s*\(\) => \(\) => \{\s*if \(useConfirm\.getState\(\)\.request === promptRef\.current\)\s*promptRef\.current\?\.resolve\(false, false\);\s*\},\s*\[\],?\s*\)/;
  if (!cleanup.test(masked))
    problems.push("no unmount effect dismisses the screen's own prompt");
  return problems;
}

/** Problems with the panel's discard registration, `[]` when pinned: it
 *  registers while dirty and deregisters on every re-run and unmount. */
function discardRegistrationProblems(text) {
  const masked = maskNonCode(text, true);
  const effect =
    /useEffect\(\(\) => \{\s*if \(!onRegisterDiscard\) return;\s*onRegisterDiscard\(dirty \? \(\) => discardRef\.current\(\) : null\);\s*return \(\) => onRegisterDiscard\(null\);\s*\}, \[dirty, onRegisterDiscard\]\);/;
  return effect.test(masked)
    ? []
    : ["the panel's discard registration lost its shape or its cleanup"];
}

/** Problems with main.tsx's `<Toaster>` props, `[]` when pinned. */
function toasterProblems(text) {
  const masked = maskNonCode(text, true);
  const tags = [...masked.matchAll(/<Toaster\b/g)];
  if (tags.length !== 1)
    return [`expected one <Toaster>, found ${tags.length}`];
  const end = tagEnd(masked, tags[0].index);
  if (end === -1) return ["the <Toaster> tag doesn't close"];
  const tag = masked.slice(tags[0].index, end);
  const problems = [];
  for (const prop of ["offset", "mobileOffset"])
    if (!new RegExp(`\\s${prop}=`).test(tag)) problems.push(`missing ${prop}`);
  for (const prop of ["toastOptions", "style", "className"])
    if (new RegExp(`\\s${prop}=`).test(tag)) problems.push(`passes ${prop}`);
  if (/\{\s*\.\.\./.test(tag)) problems.push("spreads props");
  return problems;
}

/** Runtime imports in a module meant to have none, `[]` when clean. A type
 *  import must use the `import type { … }` declaration form: Node's type
 *  stripping keeps an inline `import { type X }` as a side-effect import. */
function runtimeImports(text) {
  const masked = maskNonCode(text, false);
  const found = [];
  for (const m of masked.matchAll(/\bimport\b/g))
    if (!/^import\s+type\s*\{/.test(masked.slice(m.index)))
      found.push(masked.slice(m.index, m.index + 20).trim());
  for (const m of masked.matchAll(
    /\brequire\s*\(|\bexport\s*(?:\*|\{[^}]*\})\s*from\b/g,
  ))
    found.push(m[0].trim());
  return found;
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

/** `text` with `from` replaced once inside `function <name>`'s source. */
function inFunction(text, name, from, to) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf("\n  }\n", start);
  if (start === -1 || end === -1) return text;
  const body = text.slice(start, end).replace(from, () => to);
  return text.slice(0, start) + body + text.slice(end);
}

test("the Discard prompt is app-scoped with the confirmed copy", () => {
  pin(
    askLiteralProblems,
    source(SCREEN),
    (s) => s.replace('scope: "app"', 'scope: "repo"'),
    // A commented-out key beside a wrong live one must not read as pinned.
    (s) => s.replace('scope: "app",', '// scope: "app",\n      scope: "repo",'),
    (s) =>
      s.replace('confirmVariant: "destructive"', 'confirmVariant: "default"'),
  );
});

test("applyDiscard resets from the settings cache read at call time", () => {
  pin(freshReadProblems, source(SCREEN), (s) =>
    inFunction(
      s,
      "applyDiscard",
      "queryClient.getQueryData<AppSettings>(settingsKeys.settings)",
      "settings.data",
    ),
  );
});

test("a confirmed Discard with nothing left to undo stops before the reset", () => {
  pin(noOpGateProblems, source(SCREEN), (s) =>
    inFunction(
      s,
      "requestDiscard",
      /\n {4}if \(!unsavedNow\(\)\) \{[^}]*\}/,
      "",
    ),
  );
});

test("the footer's hide lands focus on the rail only when it would drop", () => {
  pin(
    footerHideProblems,
    source(SCREEN),
    (s) => s.replace(" || active === document.body)", ")"),
    (s) => s.replace("if (aimed || active === null", "if (active === null"),
    (s) => s.replace("    footerWasVisible.current = footerVisible;\n", ""),
    (s) =>
      s
        .replace("    if (!hid) return;\n", "")
        .replace(
          "    const active = document.activeElement;\n",
          "    const active = document.activeElement;\n    if (!hid) return;\n",
        ),
    (s) =>
      s
        .replace(
          "    pendingRailFocus.current = false;\n    if (!hid)",
          "    if (!hid)",
        )
        .replace(
          "    if (!hid) return;\n",
          "    if (!hid) return;\n    pendingRailFocus.current = false;\n",
        ),
  );
});

test("the Automations bar's hide lands focus on its heading only when it would drop", () => {
  pin(
    barHideProblems,
    source(AUTOMATIONS),
    (s) => s.replace(" || active === document.body)", ")"),
    (s) => s.replace("if (aimed || active === null", "if (active === null"),
    (s) => s.replace("      barWasShown.current = dirty;\n", ""),
    (s) =>
      s
        .replace(
          "      pendingHeadingFocus.current = false;\n      if (!hid)",
          "      if (!hid)",
        )
        .replace(
          "      if (!hid) return;\n",
          "      if (!hid) return;\n      pendingHeadingFocus.current = false;\n",
        ),
  );
});

for (const file of [SCREEN, AUTOMATIONS])
  test(`${file} dismisses its own open prompt when it unmounts`, () => {
    pin(
      promptDismissalProblems,
      source(file),
      (s) =>
        s.replace(
          "if (useConfirm.getState().request === promptRef.current)",
          "if (promptRef.current)",
        ),
      (s) => s.replace("promptRef.current = mine;", ""),
    );
  });

test("the Automations panel deregisters its discard on every re-run", () => {
  pin(discardRegistrationProblems, source(AUTOMATIONS), (s) =>
    s.replace("      return () => onRegisterDiscard(null);\n", ""),
  );
});

test("a failed settings write toasts and keeps the draft", () => {
  const unwrap = (s) =>
    s.replace(
      /try \{\n(\s*await saveSettings\.mutateAsync\([^;]*;)\n\s*\} catch \(e\) \{[\s\S]*?return;\n\s*\}/,
      (_m, write) => write.trim(),
    );
  pin(
    failedWriteProblems,
    source(SCREEN),
    unwrap,
    (s) => s.replace(/(catch \(e\) \{[\s\S]*?)\n\s*return;/, "$1"),
    (s) =>
      s.replace(
        "await saveSettings.mutateAsync(",
        "void saveSettings.mutateAsync(",
      ),
  );
});

test("the Automations panel's Discard asks first with the confirmed copy", () => {
  pin(
    automationsAskProblems,
    source(AUTOMATIONS),
    (s) => s.replace('scope: "app"', 'scope: "repo"'),
    (s) =>
      s.replace(
        '"Every automation rule change since your last save is undone."',
        '"Every edit is undone."',
      ),
    (s) => s.replace("onClick={requestDiscard}", "onClick={discard}"),
    (s) =>
      s
        .replace(
          "      pendingHeadingFocus.current = true;\n      discard();\n",
          "",
        )
        .replace("      if (!ok) {\n", "      discard();\n      if (!ok) {\n"),
  );
});

test("the footer Discard also resets a dirty Automations draft", () => {
  const section = source(AUTOMATIONS);
  const check = (screen) => automationsDiscardRefProblems(screen, section);
  pin(
    check,
    source(SCREEN),
    (s) =>
      s.replace(
        "    if (automationsDirtyRef.current) discardAutomationsRef.current?.();\n",
        "",
      ),
    (s) =>
      s.replace(
        "if (automationsDirtyRef.current) discardAutomationsRef.current?.();",
        "discardAutomationsRef.current?.();",
      ),
    (s) => s.replace("discardAutomationsRef.current = fn;", ""),
  );
  assert.ok(
    automationsDiscardRefProblems(
      source(SCREEN),
      section.replace(
        "onRegisterDiscard(dirty ? () => discardRef.current() : null);",
        "onRegisterDiscard(null);",
      ),
    ).length > 0,
    "the scan passed a panel that never registers its discard",
  );
});

/** Problems with the panel's draft reset, `[]` when pinned: `discard` resets
 *  at once, to an in-flight save's lifecycles while it is pending, and no
 *  queued reset survives to land after the save settles. */
function automationsResetTargetProblems(text) {
  const masked = maskNonCode(text, true);
  const discard = functionBody(masked, "discard");
  if (!discard) return ["discard not found"];
  const problems = [];
  if (
    !/^\{\s*setDraft\(\s*save\.isPending && save\.variables\s*\?\s*save\.variables\.lifecycles\s*:\s*saved,?\s*\);\s*$/.test(
      masked.slice(discard[0], discard[1]),
    )
  )
    problems.push("discard no longer resets at once to the in-flight target");
  if (/resetQueued/i.test(text)) problems.push("a queued reset is back");
  return problems;
}

/** Problems with requestDiscard's no-op arm reaching the Automations draft,
 *  `[]` when pinned: a settings Save that settled under the prompt still
 *  leaves a dirty Automations draft to reset before the arm returns. */
function noOpAutomationsProblems(text) {
  const masked = maskNonCode(text, true);
  const request = functionBody(masked, "requestDiscard");
  if (!request) return ["requestDiscard not found"];
  const gate = /if \(!unsavedNow\(\)\) \{([^{}]*)\}/.exec(
    masked.slice(request[0], request[1]),
  );
  if (!gate) return ["requestDiscard lost its no-op arm"];
  return /^\s*if \(automationsDirtyRef\.current\) discardAutomationsRef\.current\?\.\(\);\s*focusRailAfterPrompt\(\);\s*return;\s*$/.test(
    gate[1],
  )
    ? []
    : ["the no-op arm no longer resets a dirty Automations draft first"];
}

test("the Automations discard resets at once to an in-flight save's target", () => {
  pin(automationsResetTargetProblems, source(AUTOMATIONS), (s) =>
    s.replace(/ {4}function discard\(\) \{\n[\s\S]*?\n {4}\}\n/, () =>
      [
        "    const [resetQueued, setResetQueued] = useState(false);",
        "    useEffect(() => {",
        "      if (!resetQueued || save.isPending) return;",
        "      setResetQueued(false);",
        "      setDraft(saved);",
        "    }, [resetQueued, save.isPending, saved]);",
        "    function discard() {",
        "      setResetQueued(true);",
        "    }",
        "",
      ].join("\n"),
    ),
  );
});

test("a Discard whose settings Save settled under the prompt still resets Automations", () => {
  const line =
    "      if (automationsDirtyRef.current) discardAutomationsRef.current?.();\n";
  pin(
    noOpAutomationsProblems,
    source(SCREEN),
    (s) => inFunction(s, "requestDiscard", line, ""),
    (s) =>
      inFunction(
        s,
        "requestDiscard",
        line,
        "      discardAutomationsRef.current?.();\n",
      ),
  );
});

test("the counter bumps once, in applyDiscard, behind a confirmed answer", () => {
  pin(bumpProblems, source(SCREEN), (s) => {
    const body = s.slice(s.indexOf("async function requestDiscard"));
    const moved = body
      .replace("    applyDiscard();\n", "")
      .replace("if (!ok) {", "applyDiscard();\n    if (!ok) {");
    return s.slice(0, s.indexOf("async function requestDiscard")) + moved;
  });
});

test("applyDiscard clears the staged buffer and resets the MCP baseline", () => {
  pin(resetProblems, source(SCREEN), (s) =>
    s.replace(/(function applyDiscard[\s\S]*?)commitStaged\(\[\]\);/, "$1"),
  );
});

test("the toaster takes only offset props, so the wrapper's class survives", () => {
  pin(toasterProblems, source(MAIN), (s) =>
    s.replace("closeButton\n", "closeButton\n      toastOptions={{}}\n"),
  );
});

test("the clearance module has no runtime import", () => {
  pin(
    runtimeImports,
    source(CLEARANCE),
    (s) => `import { type Ref } from "./ref";\n${s}`,
  );
  assert.deepEqual(runtimeImports('import type { A } from "./a";\n'), []);
  for (const bad of [
    'import "./side-effect";\n',
    'import { a } from "./a";\n',
    'export { a } from "./a";\n',
    'const m = await import("./a");\n',
  ])
    assert.ok(runtimeImports(bad).length > 0, bad);
});
