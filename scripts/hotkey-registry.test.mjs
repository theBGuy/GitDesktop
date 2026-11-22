// Pins the live hotkey-handler registry (src/lib/hotkeys/handler-registry.ts):
// among enabled entries the highest tier answers and the newest wins inside a
// tier, disabled ones fall through, an `eligible` filter narrows who runs but
// not who owns, an unregister removes only its own entry, a disabled-only
// registration still OWNS the chord without running anything, and the palette's
// availability snapshot changes identity exactly when the registry does. Also
// the pure halves of the modal rule (`hasOpenModal`, open-modal.ts) and of chord
// ownership (`chordOwners`, binding.ts). Two source scans: which files call
// `dispatchShortcut` and raw `dispatchAction` (S1), and that only the vendored
// DialogContent and SheetContent render `<PanelPortalReset` (S2). The scans
// cannot see a call through an alias or a re-export, or a dispatch spelled in a
// string; dispatch-shortcut.ts and modal-scope.ts import react, so neither is
// loaded here. Three tripwires: no `useHotkeyAction(` in a dialog owner's body,
// direct or one hook level down, gates on that dialog's `open` (T1), nothing
// outside the vendored primitives keeps a dialog mounted (T2), and every
// mod+enter handler ignores a nested modal's keys or is listed as a leaf (T3);
// each states its reach. open-modal.ts is pinned import-free and its selector
// strings are pinned, since this file is its only loader.
//
// Not testable here: WHEN `useHotkeyAction` registers relative to React's commit
// (layout vs passive effects). That timing is a property of React's scheduler and
// needs a live app; this file pins only what the registry does once called.
//
// The imports below reach straight into `src/` and rely on Node's default type
// stripping (>= 23.6), which resolves no bundler aliases, so those modules must
// stay free of runtime imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chordOwners } from "../src/lib/hotkeys/binding.ts";
import {
  dispatchAction,
  getAvailableSnapshot,
  hasLiveHandler,
  registerHandler,
  subscribe,
  unregisterHandler,
} from "../src/lib/hotkeys/handler-registry.ts";
import { fromOtherModal, hasOpenModal } from "../src/lib/hotkeys/open-modal.ts";
import {
  lineOf,
  loadCorpus,
  maskNonCode,
  matchBrace,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

/** An entry that records its own runs into `log` under `name`. */
function entry(log, name, enabled = true, extra = {}) {
  return { run: () => log.push(name), enabled, ...extra };
}

test("the newest enabled registration runs", () => {
  const log = [];
  const older = entry(log, "older");
  const newer = entry(log, "newer");
  registerHandler("t-newest", older);
  registerHandler("t-newest", newer);
  assert.equal(dispatchAction("t-newest"), true);
  assert.deepEqual(log, ["newer"]);
  unregisterHandler("t-newest", newer);
  unregisterHandler("t-newest", older);
});

test("a disabled newer registration falls through to an enabled older one", () => {
  const log = [];
  const older = entry(log, "older");
  const newer = entry(log, "newer", false);
  registerHandler("t-fall", older);
  registerHandler("t-fall", newer);
  assert.equal(dispatchAction("t-fall"), true);
  assert.deepEqual(log, ["older"]);
  unregisterHandler("t-fall", newer);
  unregisterHandler("t-fall", older);
});

test("unregister removes exactly its own entry", () => {
  const log = [];
  const first = entry(log, "first");
  const second = entry(log, "second");
  registerHandler("t-own", first);
  registerHandler("t-own", second);
  unregisterHandler("t-own", second);
  assert.equal(dispatchAction("t-own"), true);
  assert.deepEqual(log, ["first"], "the other entry stays");
  // Removing an entry that is already gone touches nothing else.
  unregisterHandler("t-own", second);
  assert.equal(hasLiveHandler("t-own"), true);
  unregisterHandler("t-own", first);
  assert.equal(hasLiveHandler("t-own"), false);
  assert.equal(dispatchAction("t-own"), false);
});

test("nothing runs when no registration is enabled", () => {
  assert.equal(dispatchAction("t-none"), false, "never registered");
  assert.equal(hasLiveHandler("t-none"), false);
});

test("a disabled-only registration owns the chord but runs nothing", () => {
  const log = [];
  const disabled = entry(log, "disabled", false);
  registerHandler("t-owned", disabled);
  assert.equal(hasLiveHandler("t-owned"), true);
  assert.equal(dispatchAction("t-owned"), false);
  assert.deepEqual(log, []);
  assert.equal(getAvailableSnapshot().has("t-owned"), false);
  unregisterHandler("t-owned", disabled);
});

test("the availability snapshot changes identity only with the registry", () => {
  let notified = 0;
  const unsubscribe = subscribe(() => {
    notified += 1;
  });
  const before = getAvailableSnapshot();
  assert.equal(getAvailableSnapshot(), before, "stable with no change");
  dispatchAction("t-snap");
  assert.equal(getAvailableSnapshot(), before, "a dispatch changes nothing");

  const live = entry([], "live");
  registerHandler("t-snap", live);
  const registered = getAvailableSnapshot();
  assert.notEqual(registered, before, "register rebuilds it");
  assert.equal(registered.has("t-snap"), true);
  assert.equal(getAvailableSnapshot(), registered, "stable after rebuild");

  unregisterHandler("t-snap", live);
  const unregistered = getAvailableSnapshot();
  assert.notEqual(unregistered, registered, "unregister rebuilds it");
  assert.equal(unregistered.has("t-snap"), false);
  assert.equal(notified, 2, "one notification per registry change");

  unsubscribe();
  registerHandler("t-snap", live);
  assert.equal(notified, 2, "an unsubscribed listener hears nothing");
  unregisterHandler("t-snap", live);
});

test("a fallback registered after an enabled surface entry loses until it is gone", () => {
  const log = [];
  const surface = entry(log, "surface");
  const fallback = entry(log, "fallback", true, { tier: "fallback" });
  registerHandler("t-fallback", surface);
  registerHandler("t-fallback", fallback);
  assert.equal(dispatchAction("t-fallback"), true);
  assert.deepEqual(log, ["surface"], "the newer fallback loses");

  // Disabled: re-registered the way useHotkeyAction does on an `enabled` flip.
  const disabled = entry(log, "surface", false);
  unregisterHandler("t-fallback", surface);
  registerHandler("t-fallback", disabled);
  assert.equal(dispatchAction("t-fallback"), true);
  assert.deepEqual(log, ["surface", "fallback"], "disabled surface: fallback");

  unregisterHandler("t-fallback", disabled);
  assert.equal(dispatchAction("t-fallback"), true);
  assert.deepEqual(
    log,
    ["surface", "fallback", "fallback"],
    "unregistered surface: fallback",
  );
  unregisterHandler("t-fallback", fallback);
});

test("a popup registered before a surface entry wins after that entry re-registers", () => {
  const log = [];
  const popup = entry(log, "popup", true, { tier: "popup" });
  registerHandler("t-popup", popup);
  const off = entry(log, "surface", false);
  registerHandler("t-popup", off);
  // The surface entry's `enabled` flips back on: a fresh, newer registration.
  unregisterHandler("t-popup", off);
  const on = entry(log, "surface");
  registerHandler("t-popup", on);
  assert.equal(dispatchAction("t-popup"), true);
  assert.deepEqual(log, ["popup"]);
  unregisterHandler("t-popup", on);
  unregisterHandler("t-popup", popup);
});

test("inside one tier the newest enabled entry runs and a disabled one falls through", () => {
  for (const tier of ["fallback", "surface", "popup"]) {
    const log = [];
    const older = entry(log, "older", true, { tier });
    const newer = entry(log, "newer", true, { tier });
    const newest = entry(log, "newest", false, { tier });
    const id = `t-tier-${tier}`;
    registerHandler(id, older);
    registerHandler(id, newer);
    registerHandler(id, newest);
    assert.equal(dispatchAction(id), true);
    assert.deepEqual(log, ["newer"], tier);
    unregisterHandler(id, newer);
    assert.equal(dispatchAction(id), true);
    assert.deepEqual(log, ["newer", "older"], tier);
    unregisterHandler(id, older);
    assert.equal(
      dispatchAction(id),
      false,
      `${tier}: only a disabled one left`,
    );
    unregisterHandler(id, newest);
  }
});

test("an eligible filter narrows who runs, never who owns", () => {
  const log = [];
  const scope = {};
  const low = entry(log, "low", true, { tier: "fallback", scope });
  const high = entry(log, "high", true, { tier: "popup", scope: null });
  registerHandler("t-eligible", low);
  registerHandler("t-eligible", high);
  const inScope = (e) => e.scope === scope;
  assert.equal(dispatchAction("t-eligible", inScope), true);
  assert.deepEqual(log, ["low"], "the rejected higher tier does not run");
  assert.equal(
    dispatchAction("t-eligible", () => false),
    false,
  );
  assert.deepEqual(log, ["low"], "nothing accepted, nothing runs");
  assert.equal(hasLiveHandler("t-eligible"), true);
  assert.equal(getAvailableSnapshot().has("t-eligible"), true);

  // The snapshot and hasLiveHandler count a rejected-only entry too.
  unregisterHandler("t-eligible", low);
  assert.equal(dispatchAction("t-eligible", inScope), false);
  assert.deepEqual(log, ["low"]);
  assert.equal(hasLiveHandler("t-eligible"), true);
  assert.equal(getAvailableSnapshot().has("t-eligible"), true);
  assert.equal(dispatchAction("t-eligible"), true, "no filter: all eligible");
  assert.deepEqual(log, ["low", "high"]);
  unregisterHandler("t-eligible", high);
});

// A stub DOM: elements are attribute maps, and the root's querySelectorAll
// matches the comma list of `[name]` / `[name="value"]` compounds that the
// module's selector is built from (anything else throws, so a selector this
// stub can't read fails the test instead of matching nothing).
function stubRoot(elements) {
  const parse = (sel) =>
    sel.split(",").map((compound) => {
      const parts = [
        ...compound.trim().matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g),
      ];
      if (parts.map((m) => m[0]).join("") !== compound.trim())
        throw new Error(`stub can't read selector: ${compound}`);
      return parts.map((m) => ({ name: m[1], value: m[2] }));
    });
  return {
    querySelectorAll(sel) {
      const alternatives = parse(sel);
      return elements.filter((el) =>
        alternatives.some((attrs) =>
          attrs.every(({ name, value }) =>
            value === undefined ? name in el : el[name] === value,
          ),
        ),
      );
    },
  };
}

test("hasOpenModal counts open, rendered modal contents only", () => {
  const yes = () => true;
  const open = [
    { "data-slot": "dialog-content", "data-open": "" },
    { "data-slot": "sheet-content", "data-open": "" },
    { "data-slot": "drawer-content", "data-state": "open" },
  ];
  for (const el of open)
    assert.equal(hasOpenModal(stubRoot([el]), yes), true, el["data-slot"]);

  const notOpen = [
    { "data-slot": "dialog-content", "data-closed": "" },
    { "data-slot": "sheet-content" },
    { "data-slot": "drawer-content", "data-state": "closed", "data-open": "" },
    { "data-slot": "popover-content", "data-open": "" },
  ];
  assert.equal(hasOpenModal(stubRoot(notOpen), yes), false);
  assert.equal(hasOpenModal(stubRoot([]), yes), false, "empty");

  // An open content the rendered test rejects (a hidden tab panel's) is not
  // open; one rendered content among concealed ones is.
  const concealed = {
    "data-slot": "dialog-content",
    "data-open": "",
    hidden: 1,
  };
  const shown = { "data-slot": "sheet-content", "data-open": "" };
  const rendered = (el) => !("hidden" in el);
  assert.equal(hasOpenModal(stubRoot([concealed]), rendered), false);
  assert.equal(hasOpenModal(stubRoot([concealed, shown]), rendered), true);
});

test("fromOtherModal compares the nearest modal portals of target and container", () => {
  const PORTAL =
    '[data-slot="dialog-portal"],[data-slot="sheet-portal"],[data-slot="drawer-content"]';
  const inPortal = (portal) => ({
    closest: (sel) => {
      assert.equal(sel, PORTAL);
      return portal;
    },
  });
  const a = {};
  assert.equal(fromOtherModal(inPortal(a), inPortal(a)), false, "same");
  assert.equal(fromOtherModal(inPortal({}), inPortal(a)), true, "other");
  assert.equal(fromOtherModal(inPortal(a), inPortal(null)), true, "page");
  assert.equal(fromOtherModal(null, inPortal(a)), false, "null target");
});

const OPEN_MODAL = "src/lib/hotkeys/open-modal.ts";
const readSrc = (rel) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const IMPORT_RE =
  /(?<![\w$.])(?:import\b|require\s*\()|\bexport\b[^;]*\bfrom\b/;

test("open-modal.ts stays import-free", () => {
  assert.doesNotMatch(maskNonCode(readSrc(OPEN_MODAL), false), IMPORT_RE);
  for (const line of [
    'import { x } from "./x";',
    'import "./side-effect";',
    'export { y } from "./y";',
    'const z = await import("./z");',
  ])
    assert.match(maskNonCode(line, false), IMPORT_RE, line);
  assert.doesNotMatch(maskNonCode('// import x from "y"', false), IMPORT_RE);
});

test("open-modal selector strings name every modal content and portal slot", () => {
  const src = readSrc(OPEN_MODAL);
  for (const s of [
    '[data-slot="dialog-content"][data-open]',
    '[data-slot="sheet-content"][data-open]',
    '[data-slot="drawer-content"][data-state="open"]',
    '[data-slot="dialog-portal"],[data-slot="sheet-portal"],[data-slot="drawer-content"]',
  ])
    assert.ok(src.includes(s), s);
  assert.doesNotMatch(src, /\[role=/);
});

test("chordOwners gives a shared chord to its first holder and skips nulls", () => {
  const owners = chordOwners(
    new Map([
      ["first", "mod+g"],
      ["unbound", null],
      ["second", "mod+g"],
      ["other", "mod+k"],
    ]),
  );
  assert.equal(owners.get("mod+g"), "first");
  assert.equal(owners.get("mod+k"), "other");
  assert.equal(owners.size, 2, "a null binding owns nothing");
  assert.equal(owners.has(null), false);
  assert.equal(chordOwners(new Map()).size, 0);
});

// --- Source scans over src/ (src/test/ excluded) ---------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => !rel.startsWith("src/test/")),
);

/** Call counts of `name(` per file, in code only; a definition is no call. */
function callCounts(corpus, name) {
  const re = new RegExp(`(?<!function\\s+)(?<![\\w$.])${name}\\(`, "g");
  const counts = {};
  for (const [rel, text] of corpus) {
    const n = (maskNonCode(text, rel.endsWith(".tsx")).match(re) ?? []).length;
    if (n > 0) counts[rel] = n;
  }
  return counts;
}

// Every route that is not a press on a visible control.
const SHORTCUT_ROUTES = {
  "src/features/app-menu/useMacAppMenu.ts": 1,
  "src/features/shortcuts/CommandPalette.tsx": 1,
  "src/lib/hotkeys/hotkeys.tsx": 1,
  "src/lib/hotkeys/side-buttons.ts": 1,
};
// In-UI controls (a press is the surface acting), plus the rule itself.
const RAW_DISPATCHES = {
  "src/features/compare/ComparePanel.tsx": 2,
  "src/features/history/CommitDetailView.tsx": 1,
  "src/features/repository/BranchSwitcher.tsx": 1,
  "src/features/repository/ConflictBanner.tsx": 2,
  "src/features/repository/RepoSwitcher.tsx": 3,
  "src/features/repository/StashesDialog.tsx": 1,
  "src/features/repository/SubmoduleChangesPane.tsx": 1,
  "src/features/settings/KeyboardSection.tsx": 1,
  "src/features/welcome/WelcomeScreen.tsx": 3,
  "src/lib/hotkeys/dispatch-shortcut.ts": 2,
};

function dispatchRouteProblems(corpus) {
  if (corpus.size === 0) return ["empty corpus"];
  const problems = [];
  for (const [name, want] of [
    ["dispatchShortcut", SHORTCUT_ROUTES],
    ["dispatchAction", RAW_DISPATCHES],
  ]) {
    const got = callCounts(corpus, name);
    for (const rel of new Set([...Object.keys(want), ...Object.keys(got)]))
      if (got[rel] !== want[rel])
        problems.push(
          `${rel}: ${got[rel] ?? 0} ${name}( calls, expected ${want[rel] ?? 0}`,
        );
  }
  return problems;
}

/** Files rendering `<PanelPortalReset` in code. */
function portalResetProblems(corpus) {
  if (corpus.size === 0) return ["empty corpus"];
  const renderers = [...corpus]
    .filter(([rel, text]) =>
      /<PanelPortalReset(?![\w$])/.test(
        maskNonCode(text, rel.endsWith(".tsx")),
      ),
    )
    .map(([rel]) => rel)
    .sort();
  const want = ["src/components/ui/dialog.tsx", "src/components/ui/sheet.tsx"];
  return JSON.stringify(renderers) === JSON.stringify(want)
    ? []
    : [`PanelPortalReset is rendered by ${JSON.stringify(renderers)}`];
}

const withFile = (rel, text) => new Map([...CORPUS, [rel, text]]);
const editFile = (rel, from, to) => {
  const text = CORPUS.get(rel);
  assert.equal(text.split(from).length, 2, from);
  return withFile(rel, text.split(from).join(to));
};

test("S1 shortcut routes call dispatchShortcut; only in-UI controls call raw dispatchAction", () => {
  assert.deepEqual(dispatchRouteProblems(CORPUS), []);
});

test("S1 controls: a new raw call, a route back on raw dispatch, an empty corpus", () => {
  assert.notDeepEqual(
    dispatchRouteProblems(
      withFile(
        "src/features/x/Extra.tsx",
        'export const f = () => dispatchAction("commit");',
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    dispatchRouteProblems(
      editFile(
        "src/lib/hotkeys/side-buttons.ts",
        "return dispatchShortcut(SIDE_BUTTON_ACTIONS[button]);",
        "return dispatchAction(SIDE_BUTTON_ACTIONS[button]);",
      ),
    ),
    [],
  );
  assert.deepEqual(dispatchRouteProblems(new Map()), ["empty corpus"]);
});

test("S2 only the vendored DialogContent and SheetContent render PanelPortalReset", () => {
  assert.deepEqual(portalResetProblems(CORPUS), []);
});

test("S2 controls: another renderer, a dropped renderer, an empty corpus", () => {
  assert.notDeepEqual(
    portalResetProblems(
      withFile(
        "src/components/x.tsx",
        "export const X = () => <PanelPortalReset>{null}</PanelPortalReset>;",
      ),
    ),
    [],
  );
  assert.notDeepEqual(
    portalResetProblems(
      withFile(
        "src/components/ui/sheet.tsx",
        CORPUS.get("src/components/ui/sheet.tsx").replaceAll(
          "PanelPortalReset>",
          "Fragment>",
        ),
      ),
    ),
    [],
  );
  assert.deepEqual(portalResetProblems(new Map()), ["empty corpus"]);
});

// --- Tripwires over dialog files ---------------------------------------------

/** The argument texts of the call whose `(` sits at masked offset `open`,
 *  split at its top-level commas. */
function callArgs(masked, open) {
  const close = matchBrace(masked, open);
  if (close < 0) throw new Error("a call never closes");
  const args = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(masked.slice(from, i));
      from = i + 1;
    }
  }
  args.push(masked.slice(from, close));
  return args;
}

const DIALOG_TAG_RE = /<(?:Dialog|Sheet)(?![\w$.])/g;
const DIALOG_FAMILY_TAG_RE = /<(?:Dialog|Sheet)[\w$.]*/g;
const RENDERS_CONTENT_RE = /<(?:DialogContent|SheetContent)(?![\w$.])/;

const LITERAL_NAMES = new Set(["true", "false", "null", "undefined"]);

/** The identifiers `masked` passes whole as a Dialog/Sheet root's `open={...}`;
 *  a compound expression (`open={a && b}`) names none. */
function openStateNames(masked) {
  const names = new Set();
  for (const m of masked.matchAll(DIALOG_TAG_RE)) {
    const end = tagEnd(masked, m.index);
    if (end < 0) throw new Error("a dialog tag never ends");
    const attr = /\sopen=\{/.exec(masked.slice(m.index, end));
    if (attr === null) continue;
    const brace = m.index + attr.index + attr[0].length - 1;
    const value = masked.slice(brace + 1, matchBrace(masked, brace)).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(value) && !LITERAL_NAMES.has(value))
      names.add(value);
  }
  return names;
}

// T1 allowlist: `<file>|<action id>` -> reason. A negated "while closed" use
// (`!open`) is the shape that may join.
const OPEN_GATE_ALLOWED = new Map();

// T1 hook-level allowlist: `<file>|<hook>` -> the reason, and a check over the
// file's masked text and the call's arguments that the reason still holds.
const HOOK_GATE_ALLOWED = new Map([
  [
    "src/features/commit/CommitDialog.tsx|useCommitSubmit",
    {
      reason:
        "`inDialog: true` keeps the hook's commit registration a closed-state fallback; the open-state pair registers inside the content through <HotkeyAction>",
      holds: (masked, args) =>
        /(?<![\w$])inDialog:\s*true(?![\w$])/.test(args.join(",")) &&
        /<HotkeyAction(?![\w$.])/.test(masked),
    },
  ],
]);

/** The local names a file imports by name, mapped to the corpus path of the
 *  module (no extension) for `@/` and relative specifiers. */
function importedModules(rel, text) {
  const map = new Map();
  for (const m of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g,
  )) {
    const spec = m[2];
    let base;
    if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith("."))
      base = posix.normalize(posix.join(posix.dirname(rel), spec));
    else continue;
    for (const part of m[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (local) map.set(local, base);
    }
  }
  return map;
}

const moduleText = (corpus, base) => {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""])
    if (corpus.has(base + ext)) return [base + ext, corpus.get(base + ext)];
  return undefined;
};

const IDENT_RE = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

/** T1: in a file rendering DialogContent or SheetContent, no
 *  `useHotkeyAction(` call's `enabled` argument names an identifier the file
 *  passes as a Dialog/Sheet root's `open`. Such a registration sits in the
 *  owner's body, outside the content, so the modal rule makes it inert in the
 *  very dialog it waits for; register it inside the content (HotkeyAction)
 *  instead. One hook level down: a call of a hook imported by name from a
 *  module that calls `useHotkeyAction(`, with an argument naming that open
 *  state, fails unless HOOK_GATE_ALLOWED lists it. Out of reach: hooks deeper
 *  than one level, hooks imported by default or through a re-export, a
 *  compound `open={a && b}`, a dialog rendered through a wrapper component
 *  whose DialogContent lives in another file, open state read through an
 *  object, and an alias or derived local of the open state. */
function openGateProblems(corpus) {
  if (corpus.size === 0) return ["empty corpus"];
  const problems = [];
  for (const [rel, text] of corpus) {
    if (!rel.endsWith(".tsx") || rel.startsWith("src/components/ui/")) continue;
    const masked = maskNonCode(text, true);
    if (!RENDERS_CONTENT_RE.test(masked)) continue;
    const open = openStateNames(masked);
    if (open.size === 0) continue;
    for (const m of masked.matchAll(/(?<![\w$.])useHotkeyAction\s*\(/g)) {
      const args = callArgs(masked, m.index + m[0].length - 1);
      const idAt = m.index + m[0].length + args[0].search(/\S/);
      const id = `"'`.includes(masked[idAt])
        ? text.slice(idAt + 1, masked.indexOf(masked[idAt], idAt + 1))
        : args[0].trim();
      for (const name of (args[2] ?? "").matchAll(
        /(?<![\w$.])[A-Za-z_$][\w$]*/g,
      ))
        if (open.has(name[0]) && !OPEN_GATE_ALLOWED.has(`${rel}|${id}`))
          problems.push(
            `${rel}: useHotkeyAction("${id}") is gated on the dialog's open state \`${name[0]}\``,
          );
    }
    const imports = importedModules(rel, text);
    for (const m of masked.matchAll(/(?<![\w$.])(use[A-Z][\w$]*)\s*\(/g)) {
      const hook = m[1];
      if (hook === "useHotkeyAction" || !imports.has(hook)) continue;
      const mod = moduleText(corpus, imports.get(hook));
      if (mod === undefined) continue;
      const registers = /(?<![\w$.])useHotkeyAction\s*\(/.test(
        maskNonCode(mod[1], mod[0].endsWith(".tsx")),
      );
      if (!registers) continue;
      const args = callArgs(masked, m.index + m[0].length - 1);
      const named = [...args.join(",").matchAll(IDENT_RE)].find((n) =>
        open.has(n[0]),
      );
      if (named === undefined) continue;
      const allowed = HOOK_GATE_ALLOWED.get(`${rel}|${hook}`);
      if (allowed?.holds(masked, args)) continue;
      problems.push(
        `${rel}: ${hook}(…) hands the dialog's open state \`${named[0]}\` to a hook that registers shortcuts`,
      );
    }
  }
  return problems;
}

/** T2: no file outside src/components/ui passes `keepMounted` to a Dialog or
 *  Sheet root, portal or popup. modal-scope.ts keeps a scope connected for as
 *  long as DialogContent/SheetContent is MOUNTED, so a kept-mounted closed
 *  dialog would hold a live scope that can outrank the dialog actually open
 *  (topModalScope picks by creation order) and silence its shortcuts. Out of
 *  reach: the prop passed through a spread or a props object. */
function keepMountedProblems(corpus) {
  if (corpus.size === 0) return ["empty corpus"];
  const problems = [];
  for (const [rel, text] of corpus) {
    if (!rel.endsWith(".tsx") || rel.startsWith("src/components/ui/")) continue;
    const masked = maskNonCode(text, true);
    for (const m of masked.matchAll(DIALOG_FAMILY_TAG_RE)) {
      const end = tagEnd(masked, m.index);
      if (end < 0) throw new Error(`${rel}: a dialog tag never ends`);
      if (/\skeepMounted(?![\w$])/.test(masked.slice(m.index, end)))
        problems.push(`${rel}: ${m[0]} is kept mounted`);
    }
  }
  return problems;
}

test("T1 no dialog owner registers its dialog's own shortcut from its body", () => {
  const read = [...CORPUS].filter(
    ([rel, text]) =>
      rel.endsWith(".tsx") &&
      openStateNames(maskNonCode(text, true)).size > 0 &&
      RENDERS_CONTENT_RE.test(maskNonCode(text, true)),
  );
  assert.ok(read.length > 20, `T1 read ${read.length} dialog owners`);
  assert.deepEqual(openGateProblems(CORPUS), []);
});

test("T1 controls: CommitDialog's pre-move hook call without its in-content pair", () => {
  const rel = "src/features/commit/CommitDialog.tsx";
  const text = CORPUS.get(rel);
  const preMove = text
    .replace(/\n\s*inDialog: true,/, "")
    .replaceAll("<HotkeyAction", "<Fragment");
  assert.notEqual(preMove, text);
  assert.deepEqual(openGateProblems(withFile(rel, preMove)), [
    `${rel}: useCommitSubmit(…) hands the dialog's open state \`open\` to a hook that registers shortcuts`,
  ]);
});

test("T1 controls: a direct open-gated useHotkeyAction call, an empty corpus", () => {
  const rel = "src/features/x/OwnerDialog.tsx";
  const owner = (gate) =>
    withFile(
      rel,
      [
        "export function OwnerDialog({ open, onOpenChange }) {",
        `  useHotkeyAction("commit", doCommit, ${gate});`,
        "  return (",
        "    <Dialog open={open} onOpenChange={onOpenChange}>",
        "      <DialogContent>{null}</DialogContent>",
        "    </Dialog>",
        "  );",
        "}",
      ].join("\r\n"),
    );
  assert.deepEqual(
    openGateProblems(owner("open && canCommit && !generating")),
    [
      `${rel}: useHotkeyAction("commit") is gated on the dialog's open state \`open\``,
    ],
  );
  assert.deepEqual(openGateProblems(owner("canCommit")), []);
  assert.deepEqual(openGateProblems(new Map()), ["empty corpus"]);
});

test("T2 no dialog outside the vendored primitives is kept mounted", () => {
  assert.deepEqual(keepMountedProblems(CORPUS), []);
});

test("T2 controls: a kept-mounted portal, an empty corpus", () => {
  const rel = "src/features/x/Kept.tsx";
  assert.deepEqual(
    keepMountedProblems(
      withFile(
        rel,
        "export const K = () => (\n  <DialogPortal keepMounted>\n    {null}\n  </DialogPortal>\n);\n",
      ),
    ),
    [`${rel}: <DialogPortal is kept mounted`],
  );
  assert.deepEqual(keepMountedProblems(new Map()), ["empty corpus"]);
});

// --- T3: nested-modal chords --------------------------------------------------

// The mod+enter spellings, matched over raw text and kept only where the match
// starts in code (so a comment quoting one is no hit).
const MOD_ENTER_RE =
  /\(e\.(?:ctrlKey|metaKey) \|\| e\.(?:ctrlKey|metaKey)\) && e\.key === "Enter"|e\.key === "Enter" && \(e\.(?:ctrlKey|metaKey) \|\| e\.(?:ctrlKey|metaKey)\)|eventToBinding\(e\) [!=]== "mod\+enter"/g;
const FROM_OTHER_MODAL_RE = /(?<![\w$.])fromOtherModal\s*\(/;

// Leaf handlers: `<file>` -> [unguarded hit count, reason]. A handler on a
// textarea hears only keys pressed in it, since its subtree renders nothing.
const MARKDOWN_LEAF =
  "MarkdownEditor forwards onKeyDown to its textarea's own handler (markdown-editor.tsx handleKeyDown); its lightbox is the textarea's sibling";
const NESTED_MODAL_LEAVES = new Map([
  ["src/features/conversations/CommentComposer.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/conversations/CommentEditor.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/discussions/DiscussionView.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/pulls/CommitComments.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/pulls/ReviewComposer.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/pulls/ReviewThreads.tsx", [1, MARKDOWN_LEAF]],
  ["src/features/plan/PlanView.tsx", [1, "on a raw <textarea>"]],
  ["src/features/research/ResearchView.tsx", [1, "on a raw <textarea>"]],
  [
    "src/features/pulls/MergePrDialog.tsx",
    [
      1,
      "merges only when the target carries the dialog's own message-field attribute",
    ],
  ],
]);
const GENERATE_CHORD = "src/lib/hotkeys/useGenerateChord.ts";

/** T3: every mod+enter check in src (outside src/test and the vendored
 *  primitives) sits in an onKeyDown handler that calls `fromOtherModal(`
 *  between its opener and two lines past the check, unless its file is a listed
 *  leaf with exactly that many unguarded checks; and the generate chord calls
 *  it before matching. React bubbles a nested modal's keys through a
 *  container's handlers across portals. Out of reach: other spellings of the
 *  chord (a stored binding compared to a variable, `e.key == "Enter"`), a
 *  handler whose opener is not spelled `onKeyDown`, and whether the guard is on
 *  the path that acts. */
function nestedModalProblems(corpus) {
  if (corpus.size === 0) return ["empty corpus"];
  const problems = [];
  let hits = 0;
  for (const [rel, text] of corpus) {
    if (!/\.tsx?$/.test(rel) || rel.startsWith("src/components/ui/")) continue;
    if (rel.startsWith("src/test/")) continue;
    const masked = maskNonCode(text, rel.endsWith(".tsx"));
    const unguarded = [];
    for (const m of text.matchAll(MOD_ENTER_RE)) {
      if (masked[m.index] !== text[m.index]) continue;
      hits++;
      const opener = masked.lastIndexOf("onKeyDown", m.index);
      let end = m.index;
      for (let n = 0; n < 3 && end >= 0; n++) end = text.indexOf("\n", end + 1);
      if (
        opener < 0 ||
        !FROM_OTHER_MODAL_RE.test(
          masked.slice(opener, end < 0 ? undefined : end),
        )
      )
        unguarded.push(lineOf(text, m.index));
    }
    const leaf = NESTED_MODAL_LEAVES.get(rel);
    if (leaf !== undefined && unguarded.length !== leaf[0])
      problems.push(
        `${rel}: ${unguarded.length} unguarded mod+enter checks, the leaf list expects ${leaf[0]}`,
      );
    if (leaf === undefined)
      for (const line of unguarded)
        problems.push(
          `${rel}:${line}: a mod+enter handler that does not ignore a nested modal's keys (fromOtherModal)`,
        );
  }
  for (const rel of NESTED_MODAL_LEAVES.keys())
    if (!corpus.has(rel)) problems.push(`${rel}: listed leaf is gone`);
  if (hits === 0) problems.push("no mod+enter check found");
  const gen = corpus.get(GENERATE_CHORD);
  const genMasked = gen === undefined ? "" : maskNonCode(gen, false);
  const guard = genMasked.search(
    /fromOtherModal\(e\.target, e\.currentTarget\)/,
  );
  const match = genMasked.search(/eventToBinding\(e\)/);
  if (guard < 0 || match < 0 || guard > match)
    problems.push(
      `${GENERATE_CHORD}: the chord must ask fromOtherModal before it matches`,
    );
  return problems;
}

test("T3 every mod+enter handler ignores a nested modal's keys or is a listed leaf", () => {
  assert.deepEqual(nestedModalProblems(CORPUS), []);
});

test("T3 controls: a stripped guard, an unlisted handler, the generate chord, an empty corpus", () => {
  const strip = (rel) =>
    withFile(
      rel,
      CORPUS.get(rel).replace(
        "if (fromOtherModal(e.target, e.currentTarget)) return;",
        "",
      ),
    );
  assert.equal(
    nestedModalProblems(strip("src/features/pulls/CreatePrDialog.tsx")).length,
    1,
  );
  assert.deepEqual(
    nestedModalProblems(
      withFile(
        "src/features/x/Extra.tsx",
        [
          "export const X = () => (",
          "  <DialogContent",
          "    onKeyDown={(e) => {",
          '      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();',
          "    }}",
          "  />",
          ");",
        ].join("\n"),
      ),
    ),
    [
      "src/features/x/Extra.tsx:4: a mod+enter handler that does not ignore a nested modal's keys (fromOtherModal)",
    ],
  );
  assert.equal(
    nestedModalProblems(
      withFile(
        "src/features/x/Quoted.tsx",
        '// if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();\n',
      ),
    ).length,
    0,
    "a comment quoting the check is no hit",
  );
  assert.equal(nestedModalProblems(strip(GENERATE_CHORD)).length, 1);
  assert.deepEqual(nestedModalProblems(new Map()), ["empty corpus"]);
});
