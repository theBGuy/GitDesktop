// Pins the activation-key chord contract: an Enter/Space handler that activates
// a focused row, card or chip (or a list's marked row from its filter input)
// returns on `hasChordModifier(e)` before any preventDefault, so bound
// Ctrl/⌘/Alt chords reach the window listener (which skips defaultPrevented
// events). Also pins the two predicates' truth tables and the bare-Space
// carve-out (`consumeRequiresDispatch`) in both binding dispatchers: the window
// listener and the generate chord.
//
// The scan reads every src/**/*.tsx outside src/components/ui/ through
// maskNonCode, so comments and string text can't steer it. A SITE is an
// `onKeyDown={…}` whose code, inline or in a same-file named function it calls,
// tests "Enter" or " " and calls preventDefault or stopPropagation. A site on a
// focusable-shaped host (a tabIndex, an option/row/treeitem/gridcell/checkbox/
// button role, or a <button>/<Button>) must reference hasChordModifier( or
// isActivationKey( textually ahead of its first preventDefault or
// stopPropagation, or match an OWNS_CHORD entry, which names a deliberately
// unguarded site by `<tag>:<handler>` and carries its reason.
//
// Blind spots — sites the scan enumerates for OWNS_CHORD but never FLAGS:
// component hosts with no tabIndex or role of their own (DisabledReasonButton,
// DropdownMenuItem, FileList, …) and delegating containers without a tabIndex.
// Not read at all: member-expression handlers (`nav.onKeyDown`), handlers from
// another module or passed in as props, spread props, addEventListener
// listeners, and text inputs, whose Enter-submit handlers are a different
// class. A same-file function defined more than once is read at its first
// definition, and "ahead of" is textual order (the inline body, then the
// functions it calls in order of appearance), not control flow. Unreadable input
// fails closed: no files found, an unreadable file, a source maskNonCode can't
// lex, an onKeyDown outside a readable opening tag, or an unmatched brace.
//
// Node built-ins only: it runs in the installless guards job.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  consumeRequiresDispatch,
  hasChordModifier,
} from "../src/lib/hotkeys/binding.ts";
import {
  escapeRe,
  lineOf,
  maskNonCode,
  matchBrace,
  ScanError,
  sourceFiles,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

// --- predicates -------------------------------------------------------------

const ev = (mods = {}) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

test("hasChordModifier: Ctrl, Meta and Alt are chords; Shift and none are not", () => {
  assert.equal(hasChordModifier(ev({ ctrlKey: true })), true);
  assert.equal(hasChordModifier(ev({ metaKey: true })), true);
  assert.equal(hasChordModifier(ev({ altKey: true })), true);
  assert.equal(hasChordModifier({ ...ev(), shiftKey: true }), false);
  assert.equal(hasChordModifier(ev()), false);
});

test("hasChordModifier: AltGraph composes characters, so it is not a chord", () => {
  const altGr = {
    ...ev({ ctrlKey: true, altKey: true }),
    getModifierState: (key) => key === "AltGraph",
  };
  assert.equal(hasChordModifier(altGr), false);
  const leftCtrlAlt = {
    ...ev({ ctrlKey: true, altKey: true }),
    getModifierState: () => false,
  };
  assert.equal(hasChordModifier(leftCtrlAlt), true);
  // An event without getModifierState still reads its flags.
  assert.equal(hasChordModifier(ev({ ctrlKey: true, altKey: true })), true);
});

test("consumeRequiresDispatch: bare Space only", () => {
  assert.equal(consumeRequiresDispatch("space"), true);
  for (const b of ["shift+space", "f5", "mod+enter", "mod+r", "mod+p", "a"])
    assert.equal(consumeRequiresDispatch(b), false, b);
});

// --- the scan ---------------------------------------------------------------

const HOST_ROLES = new Set([
  "option",
  "row",
  "treeitem",
  "gridcell",
  "checkbox",
  "button",
]);
const HOST_TAGS = new Set(["button", "Button"]);
const ACTIVATION_TEST_RE =
  /(?:\.key\s*[!=]==?\s*|\bcase\s+)(?:"Enter"|" "|'Enter'|' ')/g;
const CONSUME_RE = /\.(?:preventDefault|stopPropagation)\s*\(/;
const GUARD_RE = /\b(?:hasChordModifier|isActivationKey)\s*\(/;

/** Start of the JSX opening tag holding the attribute at `at`: the first `<`
 *  before it at brace depth 0, or -1 when a `>` or an unopened `{` says the
 *  attribute isn't inside one. */
function tagStartBefore(masked, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return -1;
      depth--;
    } else if (depth === 0) {
      if (ch === ">") return -1;
      if (ch === "<" && /[A-Za-z]/.test(masked[i + 1] ?? "")) return i;
    }
  }
  return -1;
}

/** The region of a same-file `function name(…) {…}` or `const|let name = …;`,
 *  or null when the file defines no such binding. */
function definitionRegion(masked, name) {
  const fn = new RegExp(`\\bfunction\\s+${escapeRe(name)}\\s*\\(`).exec(masked);
  if (fn) {
    const paren = fn.index + fn[0].length - 1;
    const parenClose = matchBrace(masked, paren);
    const body = parenClose === -1 ? -1 : masked.indexOf("{", parenClose);
    const bodyClose = body === -1 ? -1 : matchBrace(masked, body);
    if (bodyClose === -1)
      throw new ScanError(
        `unmatched body of function ${name} at line ${lineOf(masked, fn.index)}`,
      );
    return { start: fn.index, end: bodyClose + 1 };
  }
  const decl = new RegExp(
    `\\b(?:const|let)\\s+${escapeRe(name)}\\s*(?::[^=;]+)?=(?![=>])`,
  ).exec(masked);
  if (!decl) return null;
  let depth = 0;
  for (let i = decl.index + decl[0].length; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return { start: decl.index, end: i };
    if (depth < 0) return { start: decl.index, end: i };
  }
  return { start: decl.index, end: masked.length };
}

/** Whether `raw` tests Enter or Space as CODE inside [start, end) — a comment
 *  quoting the test is blanked in `masked`, so the match must survive there. */
function testsActivationKey(raw, masked, start, end) {
  const slice = raw.slice(start, end);
  for (const m of slice.matchAll(ACTIVATION_TEST_RE)) {
    const at = start + m.index;
    if (masked.slice(at, at + 4) === raw.slice(at, at + 4)) return true;
  }
  return false;
}

/** Every Enter/Space-consuming onKeyDown site in one source, as
 *  `{ line, site, host, guarded }`: `site` is the line-independent identity
 *  `<tag>:<handler>` (the bare handler name, else the same-file functions an
 *  inline handler calls joined by "+", else "inline"), and `guarded` means a
 *  chord guard comes ahead of the first consume. Throws ScanError on input it
 *  cannot read. */
function activationSites(raw) {
  const masked = maskNonCode(raw, true);
  const sites = [];
  for (const m of masked.matchAll(/(?<![\w$.])onKeyDown=\{/g)) {
    const start = tagStartBefore(masked, m.index);
    if (start === -1)
      throw new ScanError(
        `onKeyDown outside a readable opening tag at line ${lineOf(masked, m.index)}`,
      );
    const end = tagEnd(masked, start);
    if (end === -1)
      throw new ScanError(
        `unclosed opening tag at line ${lineOf(masked, start)}`,
      );
    const tagMasked = masked.slice(start, end + 1);
    const tagRaw = raw.slice(start, end + 1);
    const tag = /^<([\w.]+)/.exec(tagMasked)?.[1] ?? "";
    const role = /\brole=\{?\s*["'](\w+)["']/.exec(tagRaw)?.[1];
    const host =
      HOST_TAGS.has(tag) ||
      /\btabIndex\s*=/.test(tagMasked) ||
      (role !== undefined && HOST_ROLES.has(role));
    const open = m.index + m[0].length - 1;
    const close = matchBrace(masked, open);
    if (close === -1)
      throw new ScanError(
        `unmatched onKeyDown handler at line ${lineOf(masked, open)}`,
      );
    const regions = [{ start: open, end: close + 1 }];
    const inner = masked.slice(open + 1, close);
    const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(inner)?.[1];
    const names = new Set(bare ? [bare] : []);
    for (const c of inner.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g))
      names.add(c[1]);
    const defined = [];
    for (const name of names) {
      const def = definitionRegion(masked, name);
      if (!def) continue;
      regions.push(def);
      defined.push(name);
    }
    const tests = regions.some((r) =>
      testsActivationKey(raw, masked, r.start, r.end),
    );
    const code = regions.map((r) => masked.slice(r.start, r.end)).join("\n");
    const consumeAt = code.search(CONSUME_RE);
    if (!tests || consumeAt === -1) continue;
    const guardAt = code.search(GUARD_RE);
    sites.push({
      line: lineOf(masked, m.index),
      site: `${tag}:${bare ?? (defined.join("+") || "inline")}`,
      host,
      guarded: guardAt !== -1 && guardAt < consumeAt,
      misordered: guardAt !== -1 && guardAt > consumeAt,
    });
  }
  return sites;
}

/** The sites the contract flags in one source: focusable hosts with no chord
 *  guard ahead of their first consume. */
function unguardedActivationHandlers(raw) {
  return activationSites(raw).filter((s) => s.host && !s.guarded);
}

/** Deliberately unguarded sites, by line-independent identity: `count` sites
 *  with that identity, no more and no fewer, each with its reason. */
const MODAL_NO_OWNER =
  "modal list with no chord owner of its own; a chord must not reach app bindings behind the dialog";
const OWNS_CHORD = [
  {
    file: "src/features/conversations/ConversationFilterPopover.tsx",
    site: "button:keepActivationLocal",
    count: 4,
    reason:
      "deliberate exception (owner-confirmed): the picker popover keeps Enter and Space, chorded or not, local to its own controls",
  },
  {
    file: "src/features/diff/DiffViewer.tsx",
    site: "Button:swallowRepeatedActivation",
    count: 1,
    reason:
      "swallowRepeatedActivation is repeat-only and already excludes ctrl/alt/meta in its own test",
  },
  {
    file: "src/features/projects/TableCell.tsx",
    site: "Button:inline",
    count: 1,
    reason:
      "the edit popup owns Enter as its commit; Clear's stopPropagation keeps its Enter out of that commit",
  },
  {
    file: "src/features/repository/RepositoryFilesDialog.tsx",
    site: "FileList:onListKeyDown",
    count: 1,
    reason: MODAL_NO_OWNER,
  },
  {
    file: "src/features/history/BlameFilePickerDialog.tsx",
    site: "FileList:onListKeyDown",
    count: 1,
    reason: MODAL_NO_OWNER,
  },
  {
    file: "src/features/settings/mcp/BrowseRegistryDialog.tsx",
    site: "div:add",
    count: 1,
    reason: MODAL_NO_OWNER,
  },
  {
    file: "src/features/tags/CreateReleaseDialog.tsx",
    site: "button:pick",
    count: 1,
    reason: `${MODAL_NO_OWNER} (the release dialog owns only its generate chord)`,
  },
  {
    file: "src/features/repo-settings/TopicsField.tsx",
    site: "button:onChipKeyDown",
    count: 1,
    reason: `${MODAL_NO_OWNER} (the repository settings dialog owns only its generate chord)`,
  },
];

/** Problems with one file's sites against the OWNS_CHORD entries for it. */
function ownershipProblems(file, sites, owns) {
  const problems = [];
  const mine = owns.filter((o) => o.file === file);
  const ownedIds = new Set(mine.map((o) => o.site));
  for (const s of sites) {
    if (s.misordered)
      problems.push(
        `${file}:${s.line} <${s.site}> calls preventDefault or stopPropagation before its chord guard — the guard must come first`,
      );
    else if (s.host && !s.guarded && !ownedIds.has(s.site))
      problems.push(
        `${file}:${s.line} <${s.site}> tests Enter/Space and consumes it without hasChordModifier(e) — return on it before any preventDefault, or add an OWNS_CHORD entry with its reason`,
      );
  }
  for (const o of mine) {
    if (!o.reason) problems.push(`${file} ${o.site}: no reason`);
    const n = sites.filter((s) => !s.guarded && s.site === o.site).length;
    if (n === 0)
      problems.push(`${file} ${o.site}: stale, no unguarded site has it`);
    else if (n !== o.count)
      problems.push(
        `${file} ${o.site}: ${n} unguarded site(s), the entry names ${o.count}`,
      );
  }
  return problems;
}

/** The guarded sites whose host the scan reads: neutralizing the guard must
 *  make the scan flag each one, so its reach can't quietly shrink. */
const GUARDED_SCANNED = [
  "src/features/repository/FileRow.tsx",
  "src/features/repository/ChangesPanel.tsx",
  "src/features/pulls/LinkedIssuesField.tsx",
  "src/features/projects/BoardCard.tsx",
  "src/features/pulls/PrTasksSection.tsx",
  "src/features/issues/JiraIssueView.tsx",
  "src/features/settings/McpServersSection.tsx",
  "src/features/settings/CommandsSection.tsx",
];

/** Guarded sites on a host the scan doesn't read: the presence of their guard
 *  is the pin. */
const GUARDED_PRESENCE = [
  // A delegating container: Enter/Space on a focused thread header.
  "src/features/pulls/ReviewThreads.tsx",
  // The filter's combobox input, whose Enter opens the marked repository row.
  "src/features/repository/RepoList.tsx",
  // Delegating containers: narration links and rendered-markdown images.
  "src/features/sessions/AgentNarration.tsx",
  "src/components/markdown/markdown.tsx",
];

/** Every site this change guarded: each must keep a hasChordModifier( call, so
 *  a removed guard fails even where the site's shape drifts out of the scan. */
const GUARDED = [...GUARDED_SCANNED, ...GUARDED_PRESENCE];

/** Every scanned .tsx as a repo-relative path → its activation sites. */
function scanRepo() {
  const out = new Map();
  for (const full of sourceFiles(
    fileURLToPath(new URL("../src", import.meta.url)),
  )) {
    const rel = relative(ROOT, full).replace(/\\/g, "/");
    if (!rel.endsWith(".tsx") || rel.startsWith("src/components/ui/")) continue;
    let raw;
    try {
      raw = readFileSync(full, "utf8").replace(/\r\n/g, "\n");
    } catch (e) {
      throw new Error(`unreadable source ${rel}: ${e.message}`);
    }
    try {
      out.set(rel, activationSites(raw));
    } catch (e) {
      if (e instanceof ScanError)
        throw new Error(`could not scan ${rel}: ${e.message}`);
      throw e;
    }
  }
  return out;
}

const scanned = scanRepo();

test("the scan reads a non-empty corpus", () => {
  assert.ok(scanned.size > 0, "zero .tsx files matched: the scan is inert");
  for (const file of GUARDED)
    assert.ok(scanned.has(file), `guarded site not scanned: ${file}`);
  for (const o of OWNS_CHORD)
    assert.ok(scanned.has(o.file), `owned site not scanned: ${o.file}`);
});

test("every focusable Enter/Space handler passes bound chords through", () => {
  const problems = [];
  for (const [file, sites] of scanned)
    problems.push(...ownershipProblems(file, sites, OWNS_CHORD));
  assert.deepEqual(problems, []);
});

test("the guarded sites keep their hasChordModifier( call", () => {
  for (const file of GUARDED)
    assert.match(
      maskNonCode(read(file), true),
      /\bhasChordModifier\(/,
      `${file} lost its chord guard`,
    );
});

test("the scan reaches every guarded site whose host it reads", () => {
  for (const file of GUARDED_SCANNED) {
    const raw = read(file);
    assert.equal(
      unguardedActivationHandlers(raw).length,
      0,
      `${file} is flagged as is`,
    );
    const unguarded = raw.replaceAll("hasChordModifier(e)", "false");
    assert.ok(
      unguardedActivationHandlers(unguarded).length > 0,
      `${file}: the scan no longer sees the site its guard protects`,
    );
  }
});

test("negative control: an owned site swapped for an unguarded one goes red", () => {
  const owned = `function swallow(e) {
  if (e.repeat && e.key === "Enter") e.preventDefault();
}
export const C = () => <Button onKeyDown={swallow} />;`;
  const owns = [
    { file: "f.tsx", site: "Button:swallow", count: 1, reason: "repeat-only" },
  ];
  assert.deepEqual(
    ownershipProblems("f.tsx", activationSites(owned), owns),
    [],
  );
  const swapped = owned.replace(
    "onKeyDown={swallow}",
    'onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}',
  );
  assert.notDeepEqual(
    ownershipProblems("f.tsx", activationSites(swapped), owns),
    [],
  );
  // A second site with the owned identity breaks the count too.
  const doubled = owned.replace(
    "<Button onKeyDown={swallow} />",
    "<><Button onKeyDown={swallow} /><Button onKeyDown={swallow} /></>",
  );
  assert.notDeepEqual(
    ownershipProblems("f.tsx", activationSites(doubled), owns),
    [],
  );
});

test("negative control: a guard after the first preventDefault goes red", () => {
  const late = `export const C = () => (
  <div
    role="option"
    tabIndex={0}
    onKeyDown={(e) => {
      e.preventDefault();
      if (hasChordModifier(e)) return;
      if (e.key === "Enter") act();
    }}
  />
);`;
  assert.notDeepEqual(
    ownershipProblems("f.tsx", activationSites(late), []),
    [],
  );
  const early = late.replace(
    "e.preventDefault();\n      if (hasChordModifier(e)) return;",
    "if (hasChordModifier(e)) return;\n      e.preventDefault();",
  );
  assert.deepEqual(ownershipProblems("f.tsx", activationSites(early), []), []);
});

// --- negative controls and fail-closed arms ----------------------------------

const PRE_FIX_ROW = `export function Row() {
  return (
    <div
      role="option"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry, staged, { ctrlOrMeta: false, shift: false });
        }
      }}
    />
  );
}`;

test("negative control: the pre-fix FileRow handler shape is flagged", () => {
  assert.equal(unguardedActivationHandlers(PRE_FIX_ROW).length, 1);
  const guarded = PRE_FIX_ROW.replace(
    "if (e.target !== e.currentTarget) return;",
    "if (e.target !== e.currentTarget || hasChordModifier(e)) return;",
  );
  assert.equal(unguardedActivationHandlers(guarded).length, 0);
});

test("negative control: a same-file named handler is followed", () => {
  const src = `function onChip(e) {
  if (e.key === "Enter") { e.preventDefault(); act(); }
}
export const C = () => <button onKeyDown={(e) => onChip(e)} />;`;
  assert.equal(unguardedActivationHandlers(src).length, 1);
  assert.equal(
    unguardedActivationHandlers(
      src.replace(
        "function onChip(e) {",
        "function onChip(e) {\n  if (hasChordModifier(e)) return;",
      ),
    ).length,
    0,
  );
});

test("a comment quoting the key test, or a non-focusable host, is not a hit", () => {
  const commented = PRE_FIX_ROW.replace(
    'if (e.key === "Enter" || e.key === " ") {',
    '// e.key === "Enter"\n        if (other) {',
  );
  assert.equal(unguardedActivationHandlers(commented).length, 0);
  const plain = PRE_FIX_ROW.replace('role="option"\n      tabIndex={0}\n', "");
  assert.equal(unguardedActivationHandlers(plain).length, 0);
});

test("fail closed: unreadable handler regions throw", () => {
  assert.throws(
    () => unguardedActivationHandlers("const s = `unterminated"),
    ScanError,
  );
  assert.throws(
    () =>
      unguardedActivationHandlers(
        "const x = <div tabIndex={0} onKeyDown={(e) => {",
      ),
    ScanError,
  );
});

// --- source pins with revert-goes-red controls --------------------------------

const FILE_ROW = "src/features/repository/FileRow.tsx";
const HOTKEYS = "src/lib/hotkeys/hotkeys.tsx";

/** Problems with FileRow's Space branch: it must toggle, once per press, with
 *  Shift+Space reserved — never select. Empty when pinned. */
function rowSpaceProblems(raw) {
  const masked = maskNonCode(raw, true);
  const at = masked.search(/(?<![\w$.])onKeyDown=\{/);
  if (at === -1) return ["FileRow has no onKeyDown"];
  const open = masked.indexOf("{", at);
  const close = matchBrace(masked, open);
  if (close === -1) return ["FileRow's onKeyDown is unreadable"];
  const handler = raw.slice(open, close + 1);
  const space = /else if \(e\.key === " "\) \{([\s\S]*)\}\s*\}$/.exec(handler);
  if (!space) return ["FileRow has no Space branch of its own"];
  const body = space[1];
  const problems = [];
  const guard = body.search(/if \(e\.repeat \|\| e\.shiftKey\) return;/);
  const toggle = body.search(/\bonToggle\(entry, staged\)/);
  if (guard === -1)
    problems.push("the Space branch acts on a held or Shift+Space");
  if (toggle === -1) problems.push("the Space branch doesn't toggle the row");
  if (guard !== -1 && toggle !== -1 && guard > toggle)
    problems.push("the repeat/Shift guard runs after the toggle");
  if (/\bonSelect\(/.test(body)) problems.push("the Space branch selects");
  return problems;
}

/** Problems with the listener's consume gate; empty when pinned. */
function listenerProblems(raw) {
  const masked = maskNonCode(raw, true);
  const ran = /\bconst\s+([\w$]+)\s*=\s*dispatchAction\(id\);/.exec(masked);
  if (!ran) return ["the listener ignores dispatchAction's result"];
  const gate = new RegExp(
    `if \\(${escapeRe(ran[1])} \\|\\| !consumeRequiresDispatch\\(binding\\)\\) e\\.preventDefault\\(\\);`,
  );
  return gate.test(masked)
    ? []
    : ["the listener's preventDefault isn't gated on the dispatch result"];
}

function mutate(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation target not unique: ${from}`);
  return parts.join(to);
}

test("FileRow's Space toggles the row once, never selects", () => {
  assert.deepEqual(rowSpaceProblems(read(FILE_ROW)), []);
});

test("FileRow pin controls go red", () => {
  const text = read(FILE_ROW);
  const start = text.indexOf('if (e.key === "Enter") {');
  const end = text.indexOf("onToggle(entry, staged);\n        }", start);
  assert.ok(start !== -1 && end !== -1, "FileRow control target not found");
  const preFix =
    text.slice(0, start) +
    `if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry, staged, { ctrlOrMeta: false, shift: false });
        }` +
    text.slice(end + "onToggle(entry, staged);\n        }".length);
  assert.notDeepEqual(rowSpaceProblems(preFix), []);
  assert.notDeepEqual(
    rowSpaceProblems(
      mutate(
        text,
        "if (e.repeat || e.shiftKey) return;",
        "if (e.repeat) return;",
      ),
    ),
    [],
  );
});

test("the listener consumes bare Space only when a dispatch ran", () => {
  assert.deepEqual(listenerProblems(read(HOTKEYS)), []);
});

test("listener pin control goes red", () => {
  const text = read(HOTKEYS);
  const preFix = mutate(
    text,
    "const ran = dispatchAction(id);\n      if (ran || !consumeRequiresDispatch(binding)) e.preventDefault();",
    "dispatchAction(id);\n      e.preventDefault();",
  );
  assert.notDeepEqual(listenerProblems(preFix), []);
});

const GENERATE_CHORD = "src/lib/hotkeys/useGenerateChord.ts";

/** Problems with the generate chord's consume gate: like the listener, it
 *  takes bare Space only when its action ran, and otherwise only stops the
 *  press reaching a handler behind the dialog. Empty when pinned. */
function generateChordProblems(raw) {
  const masked = maskNonCode(raw, false);
  const problems = [];
  if (
    !/if \(enabled \|\| !consumeRequiresDispatch\(binding\)\) e\.preventDefault\(\);\s*else e\.stopPropagation\(\);/.test(
      masked,
    )
  )
    problems.push(
      "the generate chord's preventDefault isn't gated on consumeRequiresDispatch",
    );
  if (/^\s*e\.preventDefault\(\);\s*$/m.test(masked))
    problems.push("the generate chord consumes unconditionally");
  return problems;
}

test("the generate chord consumes bare Space only when it runs", () => {
  assert.deepEqual(generateChordProblems(read(GENERATE_CHORD)), []);
});

test("generate chord pin control goes red", () => {
  const text = read(GENERATE_CHORD);
  const preFix = mutate(
    text,
    "if (enabled || !consumeRequiresDispatch(binding)) e.preventDefault();\n      else e.stopPropagation();",
    "e.preventDefault();",
  );
  assert.notDeepEqual(generateChordProblems(preFix), []);
});
