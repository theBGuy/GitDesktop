// Pins the Settings footer Discard: its confirm copy (the staged-secret count
// singular at one value), when a confirmed Discard still acts, and, by source
// scans the pure helpers can't see, the wiring around them: the prompt's scope
// and copy, the one counter bump behind a confirmed answer, the reset's buffer
// and baseline writes, the toaster's offset-only props, and the clearance
// module's import-free shape. Every scan runs once against a mutated copy of
// its source, so a pin that can't go red fails here instead of passing quietly.
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

/** Problems with SettingsScreen's Discard prompt literal, `[]` when pinned. */
function askLiteralProblems(text) {
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
  return Object.entries(ASK_ENTRIES)
    .map(([key, want]) => [
      key,
      want,
      topLevelValue(masked, text, open, close, key),
    ])
    .filter(([, want, got]) => got !== want)
    .map(([key, want, got]) => `${key} is ${got ?? "missing"}, not ${want}`);
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

/** Problems with the footer-hide focus rule, `[]` when pinned: one layout
 *  effect keyed on the footer's visibility lands focus on the rail when the
 *  footer goes from shown to hidden and either a confirmed Discard aimed there
 *  or focus fell to body with the removed footer, and leaves it alone else. */
function footerHideProblems(text) {
  const masked = maskNonCode(text, true);
  const effects = [];
  for (const m of masked.matchAll(/useLayoutEffect\(\(\) => \{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1) continue;
    if (/^\s*,\s*\[footerVisible\]\s*\)/.test(masked.slice(close + 1)))
      effects.push(masked.slice(open, close));
  }
  if (effects.length !== 1)
    return [
      `expected one [footerVisible] layout effect, found ${effects.length}`,
    ];
  const body = effects[0];
  const problems = [];
  if (!/footerWasVisible\.current && !footerVisible/.test(body))
    problems.push("the effect no longer acts only on a shown-to-hidden flip");
  if (!/pendingRailFocus\.current = false/.test(body))
    problems.push("the effect no longer consumes the Discard aim");
  const gate = /if \(([^)]*)\)\s*focusRailItem\(/.exec(body);
  if (!gate) return [...problems, "the effect no longer focuses the rail"];
  for (const arm of ["aimed", "active === null", "active === document.body"])
    if (!gate[1].includes(arm)) problems.push(`the focus gate lost ${arm}`);
  if (!/const aimed = pendingRailFocus\.current/.test(body))
    problems.push("the gate's aim no longer reads pendingRailFocus");
  if (!/const active = document\.activeElement/.test(body))
    problems.push("the gate no longer reads document.activeElement");
  return problems;
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
  );
});

test("a failed settings write toasts and keeps the draft", () => {
  const unwrap = (s) =>
    s.replace(
      /try \{\n(\s*await saveSettings\.mutateAsync\([^;]*;)\n\s*\} catch \(e\) \{[\s\S]*?return;\n\s*\}/,
      (_m, write) => write.trim(),
    );
  pin(failedWriteProblems, source(SCREEN), unwrap, (s) =>
    s.replace(/(catch \(e\) \{[\s\S]*?)\n\s*return;/, "$1"),
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
