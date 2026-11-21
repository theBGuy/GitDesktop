// A visually hidden copy (`sr-only`, `position: absolute`) takes the nearest
// POSITIONED ancestor as its containing block, so a scroller that is neither
// positioned nor clipped at a positioned box doesn't contain it. Inside a
// body-portaled, absolutely positioned popup the escaped copies keep their
// layout positions down the whole list and grow the document: a window
// scrollbar over empty space below the app. Two arms, read on masked source,
// class tokens taken from the string literals of each tag's `className`:
// - ScrollArea: every `<ScrollArea>` in src/ (src/test/ included, the vendored
//   src/components/ui/ left out) resolves to hidden or clip on BOTH axes
//   (vertical: overflow-y-* else overflow-*; horizontal likewise); the vendored
//   Root is `relative` but clips nothing. auto/scroll would clip too, but make
//   the Root a second scroll container, so they don't count. A tag
//   with a spread counts as unclipped (the spread can override the class).
//   RepoList's one ScrollArea is pinned to its exact tokens: under its clip
//   the viewport's focus draws as an inset outline (the outset ring is zeroed).
// - Popup: every opening tag inside a popup element's range (ROSTER, plus
//   `<Alias>.Popup` for a raw Base UI part imported under another name), the
//   popup tag included, whose tokens scroll (`overflow-auto`, `overflow-y-auto`,
//   `overflow-scroll`, `overflow-y-scroll`, bare, variant-prefixed or
//   important) resolves to `relative`. A `<ScrollArea>` in range is the first
//   arm's.
// "Resolves": cn( drops earlier conflicts as tailwind-merge does; then the most
// specific property left wins, and two values at one specificity (stylesheet
// order) or a disallowed variant/important (`!x`, `x!`) token fail closed.
// SelectContent and ComboboxContent are out of the roster: their vendored
// popups resolve to `relative` and scroll (select: y auto, x hidden) or clip
// (combobox: hidden both axes) themselves, which VENDOR_PINS asserts through
// the same resolver, so a re-vendor that undoes either fails here. The roster
// was bounded by a one-off sweep; this guard's own run is the effective bound
// for the set.
// The viewport's `data-slot` (RepoList's selector) is pinned too, and so is its
// whole `className` literal by exact string equality: RepoList's inset focus
// outline overrides that paint, so any change to it is re-checked there.
// Known exceptions sit in ALLOWLIST as per-file, per-arm counts; a count that
// drifts either way, or an arm with no finding, fails. An aliased import of
// ScrollArea or a vendored roster wrapper, a namespace import of a Base UI or
// vendored ui module, a missing file, zero tags or zero popups all fail.
// Scope contract: the guard models literal class strings and a lone `cn()`
// with tailwind-merge's conflict rules plus the cascade. Out of contract by
// design, reviewed by hand rather than extended here: classes from constants,
// props or template strings; conditional `cn()` arms; an important utility
// (`relative!`, `overflow-hidden!`) on its own fails closed even when it
// names an allowed value (remedy: drop the `!` or add an allowlist row); popups built through a
// wrapper under another name or re-exported under an alias; escaped
// delimiters inside arbitrary variants. Also out of sight: scrollers rendered
// by a component defined outside the popup's range; whether an allowlisted
// scroller holds absolute content; a popup whose own box is taller than the
// window; dialogs (`fixed`) and in-app panels (under the app root's clip).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  elementRanges,
  hasSpread,
  lineOf,
  literalText,
  loadCorpus,
  maskNonCode,
  matchBrace,
  openingTags,
  ScanError,
  srcEntries,
  tagEnd,
} from "./lib/ts-mask.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDORED = "src/components/ui/";
const REPO_LIST = "src/features/repository/RepoList.tsx";
const VIEWPORT_FOCUS = "**:data-[slot=scroll-area-viewport]:focus-visible:";
const REPO_LIST_TOKENS = [
  "overflow-clip",
  ...["ring-0", "outline-2", "-outline-offset-2", "outline-solid"].map(
    (u) => VIEWPORT_FOCUS + u,
  ),
  `${VIEWPORT_FOCUS}outline-ring/50`,
].sort();

const ROSTER = [
  "PopoverContent",
  "Popover.Popup",
  "PopoverPrimitive.Popup",
  "HoverCardContent",
  "PreviewCard.Popup",
  "DropdownMenuContent",
  "DropdownMenuSubContent",
  "ContextMenuContent",
  "ContextMenuSubContent",
  "Menu.Popup",
  "ContextMenu.Popup",
  "Select.Popup",
  "Combobox.Popup",
];
/** Raw Base UI parts whose `.Popup` joins the roster under an import alias. */
const RAW_ROOTS = new Set([
  "Popover",
  "PreviewCard",
  "Menu",
  "ContextMenu",
  "Select",
  "Combobox",
]);
/** Names the scan reads by spelling, so an alias would hide them. */
const UNALIASABLE = new Set([
  "ScrollArea",
  "PopoverContent",
  "HoverCardContent",
  "DropdownMenuContent",
  "DropdownMenuSubContent",
  "ContextMenuContent",
  "ContextMenuSubContent",
]);

const SELECT = "src/components/ui/select.tsx";
const COMBOBOX = "src/components/ui/combobox.tsx";
const SCROLL_AREA = "src/components/ui/scroll-area.tsx";
/** Vendored tags, each with what its classes must resolve to (`position`,
 *  `overflow-x`, `overflow-y`), the `data-slot` it must keep (`slot`), or the
 *  whole `className` string literal it must carry (`classes`). */
const VENDOR_PINS = [
  [SELECT, "SelectPrimitive.Popup", "position", "relative"],
  [SELECT, "SelectPrimitive.Popup", "overflow-x", "hidden"],
  [SELECT, "SelectPrimitive.Popup", "overflow-y", "auto"],
  [COMBOBOX, "ComboboxPrimitive.Popup", "position", "relative"],
  [COMBOBOX, "ComboboxPrimitive.Popup", "overflow-x", "hidden"],
  [COMBOBOX, "ComboboxPrimitive.Popup", "overflow-y", "hidden"],
  [SCROLL_AREA, "ScrollAreaPrimitive.Root", "position", "relative"],
  [SCROLL_AREA, "ScrollAreaPrimitive.Viewport", "slot", "scroll-area-viewport"],
  [
    SCROLL_AREA,
    "ScrollAreaPrimitive.Viewport",
    "classes",
    "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
  ],
];

const IN_DIALOG = "inside a fixed Dialog, which bounds the page";
const ALLOWLIST = {
  "src/features/automations/AutomationResultDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/history/FileHistoryDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/hooks/HooksDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/repository/OperationHistoryDialog.tsx": {
    scrollArea: 1,
    rationale: IN_DIALOG,
  },
  "src/features/repository/StashesDialog.tsx": {
    scrollArea: 2,
    rationale: `${IN_DIALOG} (the stash list and the lost-stashes pane)`,
  },
  "src/features/scripts/TasksPanel.tsx": {
    scrollArea: 1,
    rationale: "a sidebar tab panel under the app root's overflow clip",
  },
  "src/features/repository/BranchSwitcher.tsx": {
    popupScroller: 1,
    rationale:
      "its only absolute content, a failed row's Retry reason, sits in the first row inside the visible cap; virtualized rows wrap in `relative`",
  },
  "src/features/diff/LanguagePicker.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
  "src/features/issues/JiraIssueView.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
  "src/features/projects/BoardCard.tsx": {
    popupScroller: 2,
    rationale:
      "no absolutely positioned content reachable (the markdown body's `absolute` hits are comments and a string)",
  },
  "src/features/projects/TableCell.tsx": {
    popupScroller: 2,
    rationale:
      "no absolutely positioned content reachable (the markdown body's `absolute` hits are comments and a string)",
  },
  "src/features/projects/ProjectsBoardPanel.tsx": {
    popupScroller: 1,
    rationale:
      "the views list; the DisabledReasonButtons' sr-only reasons sit after the scroller closes",
  },
  "src/features/tags/CreateReleaseDialog.tsx": {
    popupScroller: 1,
    rationale: "no absolutely positioned content in the list",
  },
};

const SCROLL_AREA_OPEN = /<ScrollArea(?![\w.$-])/g;
const SCROLLER = /^overflow-(?:y-)?(?:auto|scroll)$/;
const CLIPS = new Set(["hidden", "clip"]);
const POSITIONED = new Set(["relative"]);

/** A class token split into its utility (`base`, important `!` stripped) and
 *  whether a variant prefix or an important marker overrides out of order. A
 *  `:` inside `[…]` or `(…)` is part of the value, never a variant split. */
function parseToken(tok) {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < tok.length; i++) {
    const c = tok[i];
    if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    else if (c === ":" && depth === 0) cut = i;
  }
  const raw = tok.slice(cut + 1);
  const base = raw.replace(/^!|!$/g, "");
  return { base, override: cut >= 0 || base !== raw };
}

/** One property over a class value (the header's "resolves"). `classify(base)`
 *  gives a utility's `{ level, prop, value }`, a higher level being the more
 *  specific property, or null. Overriding tokens are returned apart. */
function resolveAxis({ tokens, merged }, classify) {
  const overrides = [];
  let kept = [];
  for (const t of tokens) {
    const { base, override } = parseToken(t);
    const c = classify(base);
    if (!c) continue;
    if (override) {
      overrides.push(c.value);
      continue;
    }
    if (merged) {
      kept = kept.filter((r) => r.level <= c.level && r.prop !== c.prop);
    }
    kept.push(c);
  }
  const top = Math.max(-1, ...kept.map((k) => k.level));
  const values = new Set(
    kept.filter((k) => k.level === top).map((k) => k.value),
  );
  return { value: [...values][0], ambiguous: values.size > 1, overrides };
}

const position = (base) =>
  /^(?:static|relative|absolute|fixed|sticky)$/.test(base)
    ? { level: 0, prop: "position", value: base }
    : null;
const overflowOn = (axis) => (base) => {
  const m = /^overflow-(?:([xy])-)?(visible|hidden|clip|scroll|auto)$/.exec(
    base,
  );
  if (!m || (m[1] && m[1] !== axis)) return null;
  return { level: m[1] ? 1 : 0, prop: m[1] ?? "both", value: m[2] };
};
const CLASSIFIERS = {
  position,
  "overflow-x": overflowOn("x"),
  "overflow-y": overflowOn("y"),
};

const resolvesIn = (cls, kind, allowed) => {
  const r = resolveAxis(cls, CLASSIFIERS[kind]);
  return (
    !r.ambiguous &&
    allowed.has(r.value) &&
    r.overrides.every((v) => allowed.has(v))
  );
};

/** Whether offset `i` of the opening tag at `s` sits at its top level, outside
 *  every attribute's `{…}` value, so an element nested in another attribute's
 *  expression never lends the tag its classes (string contents are masked). */
function topLevel(masked, s, i) {
  let depth = 0;
  for (let k = s; k < i; k++) {
    if (masked[k] === "{") depth++;
    else if (masked[k] === "}") depth--;
  }
  return depth === 0;
}

/** The `className` tokens on the opening tag [s, e), so a token spelled in
 *  another attribute (a `title`, a data prop) never counts, and whether they
 *  merge as one `className={cn(…)}` call (tailwind-merge) or stand as written. */
function classValue(text, masked, s, e) {
  const out = [];
  let values = 0;
  let merged = false;
  const re = /\sclassName\s*=\s*/g;
  re.lastIndex = s;
  for (let m = re.exec(masked); m && m.index < e; m = re.exec(masked)) {
    if (!topLevel(masked, s, m.index)) continue;
    const v = m.index + m[0].length;
    let end;
    if (masked[v] === '"' || masked[v] === "'") {
      end = masked.indexOf(masked[v], v + 1) + 1;
    } else if (masked[v] === "{") {
      let depth = 0;
      for (end = v; end < e; end++) {
        if (masked[end] === "{") depth++;
        else if (masked[end] === "}" && --depth === 0) break;
      }
      end++;
    } else end = -1;
    if (end <= v || end > e) {
      throw new ScanError("a className value runs past its tag");
    }
    out.push(literalText(text, masked, v, end));
    values++;
    const call = /^\{\s*cn\s*\(/.exec(masked.slice(v, end));
    const close = call ? matchBrace(masked, v + call[0].length - 1) : -1;
    merged = close > 0 && /^\s*\}$/.test(masked.slice(close + 1, end));
  }
  const tokens = out.join(" ").split(/\s+/).filter(Boolean);
  return { tokens, merged: values === 1 && merged };
}

const classTokens = (text, masked, s, e) =>
  classValue(text, masked, s, e).tokens;

const IMPORT = /\bimport\s+(type\s+)?([\w$\s,{}*]*?)\s*from\s*(["'])/g;

/** Per file, the roster names its imports add (`<Alias>.Popup`) and the
 *  import forms the scan can't follow. The statement is matched on the masked
 *  source, so a comment inside the clause reads as blanks, and the specifier
 *  is read from the raw text between the matched quotes. */
function importsOf(rel, text, masked) {
  const roster = new Set();
  const hard = [];
  for (const m of masked.matchAll(IMPORT)) {
    if (m[1]) continue;
    const clause = m[2];
    const q = m.index + m[0].length - 1;
    const end = masked.indexOf(m[3], q + 1);
    if (end < 0) throw new ScanError(`${rel}: an import specifier never ends`);
    const from = text.slice(q + 1, end);
    const line = lineOf(text, m.index);
    const shared = /^@base-ui\/react(?:\/|$)|^@\/components\/ui\//.test(from);
    if (/\*\s*as\s/.test(clause) && shared) {
      hard.push(`${rel}:${line}: namespace import of ${from}`);
    }
    const braced = /\{([^}]*)\}/.exec(clause);
    for (const spec of braced ? braced[1].split(",") : []) {
      const a = /^\s*(type\s+)?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(spec);
      if (!a || a[1]) continue;
      if (UNALIASABLE.has(a[2])) {
        hard.push(`${rel}:${line}: ${a[2]} imported as ${a[3]}`);
      } else if (RAW_ROOTS.has(a[2]) && from.startsWith("@base-ui/react")) {
        roster.add(`${a[3]}.Popup`);
      }
    }
  }
  return { roster, hard };
}

/** RepoList's one ScrollArea: `cn(LIST_VIEWPORT_CLASS, …)` with exactly the
 *  pinned literal tokens. */
function repoListPin(files) {
  const text = files.get(REPO_LIST);
  if (text === undefined) return [`${REPO_LIST}: not in the corpus`];
  const masked = maskNonCode(text, true);
  const opens = [...masked.matchAll(SCROLL_AREA_OPEN)];
  if (opens.length !== 1) {
    return [`${REPO_LIST}: ${opens.length} <ScrollArea> tags, pin expects 1`];
  }
  const s = opens[0].index;
  const e = tagEnd(masked, s) + 1;
  const at = `${REPO_LIST}:${lineOf(text, s)}`;
  const tag = masked.slice(s, e);
  if (!/\sclassName\s*=\s*\{\s*cn\(\s*LIST_VIEWPORT_CLASS\s*,/.test(tag)) {
    return [`${at}: className is not cn(LIST_VIEWPORT_CLASS, …)`];
  }
  if (hasSpread(masked, s, e)) return [`${at}: the ScrollArea takes a spread`];
  const got = classTokens(text, masked, s, e).sort();
  if (got.join(" ") !== REPO_LIST_TOKENS.join(" ")) {
    return [
      `${at}: ScrollArea tokens are [${got.join(" ")}], pin expects [${REPO_LIST_TOKENS.join(" ")}]`,
    ];
  }
  return [];
}

/** The raw value of the tag's one `attr="…"` attribute in [s, e), located on
 *  the masked source so a commented-out copy never counts; undefined when the
 *  attribute is missing, repeated, or not a plain double-quoted string. */
function attrLiteral(text, masked, s, e, attr) {
  const re = new RegExp(`\\s${attr}\\s*=\\s*`, "g");
  const hits = [...masked.slice(s, e).matchAll(re)].filter((m) =>
    topLevel(masked, s, s + m.index),
  );
  if (hits.length !== 1) return undefined;
  const q = s + hits[0].index + hits[0][0].length;
  if (masked[q] !== '"') return undefined;
  const close = masked.indexOf('"', q + 1);
  if (close < 0 || close >= e) return undefined;
  return text.slice(q + 1, close);
}

/** Each vendored pin's tag still resolves to its pinned value, or keeps its
 *  pinned class token. */
function vendorPins(vendor) {
  const out = [];
  for (const [rel, name, kind, want] of VENDOR_PINS) {
    const text = vendor.get(rel);
    if (text === undefined) {
      out.push(`${rel}: not readable`);
      continue;
    }
    const masked = maskNonCode(text, true);
    const opens = elementRanges(rel, text, masked, name);
    if (opens.length !== 1) {
      out.push(`${rel}: ${opens.length} <${name}> tags, pin expects 1`);
      continue;
    }
    const [s] = opens[0];
    const e = tagEnd(masked, s) + 1;
    const cls = classValue(text, masked, s, e);
    const at = `${rel}:${lineOf(text, s)}: <${name}>`;
    if (kind === "slot") {
      const slot = attrLiteral(text, masked, s, e, "data-slot");
      if (slot !== want) out.push(`${at} lost its data-slot="${want}"`);
    } else if (kind === "classes") {
      if (attrLiteral(text, masked, s, e, "className") !== want) {
        out.push(
          `${at} the vendored ScrollArea viewport classes changed: re-check RepoList's inset focus outline override (${REPO_LIST}), then update this pin`,
        );
      }
    } else if (!resolvesIn(cls, kind, new Set([want]))) {
      out.push(`${at} no longer resolves ${kind} to ${want}`);
    }
  }
  return out;
}

/** Per file, the line of every finding in each arm, the hard (never
 *  allowlistable) findings, and the corpus counts. */
function scan(files) {
  const flagged = new Map();
  const hard = [];
  let scrollAreas = 0;
  let popups = 0;
  const flag = (rel, arm, line) => {
    const entry = flagged.get(rel) ?? { scrollArea: [], popupScroller: [] };
    entry[arm].push(line);
    flagged.set(rel, entry);
  };
  for (const [rel, text] of files) {
    const masked = maskNonCode(text, true);
    const imports = importsOf(rel, text, masked);
    hard.push(...imports.hard);
    for (const m of masked.matchAll(SCROLL_AREA_OPEN)) {
      scrollAreas++;
      const e = tagEnd(masked, m.index) + 1;
      if (e === 0) throw new ScanError(`${rel}: a <ScrollArea> never ends`);
      const clipped =
        !hasSpread(masked, m.index, e) &&
        ["overflow-x", "overflow-y"].every((axis) =>
          resolvesIn(classValue(text, masked, m.index, e), axis, CLIPS),
        );
      if (!clipped) flag(rel, "scrollArea", lineOf(text, m.index));
    }
    const seen = new Set();
    for (const name of new Set([...ROSTER, ...imports.roster])) {
      for (const [from, to] of elementRanges(rel, text, masked, name)) {
        popups++;
        for (const [s, e] of openingTags(rel, text, masked, from, to)) {
          if (seen.has(s) || /^<ScrollArea(?![\w.$-])/.test(masked.slice(s))) {
            continue;
          }
          seen.add(s);
          const cls = classValue(text, masked, s, e);
          if (
            cls.tokens.some((k) => SCROLLER.test(parseToken(k).base)) &&
            !resolvesIn(cls, "position", POSITIONED)
          ) {
            flag(rel, "popupScroller", lineOf(text, s));
          }
        }
      }
    }
  }
  return { flagged, hard, scrollAreas, popups };
}

function problems(files, allowlist = ALLOWLIST, vendor = VENDOR) {
  if (files.size === 0) return ["the walk read zero files"];
  const { flagged, hard, scrollAreas, popups } = scan(files);
  const out = [...hard, ...repoListPin(files), ...vendorPins(vendor)];
  if (scrollAreas === 0) out.push("no <ScrollArea> tags found");
  if (popups === 0) out.push("no popup ranges found");
  for (const arm of ["scrollArea", "popupScroller"]) {
    for (const [rel, entry] of flagged) {
      const lines = entry[arm];
      const want = allowlist[rel]?.[arm] ?? 0;
      if (lines.length > 0 && lines.length !== want) {
        out.push(
          `${rel}:${lines.join(",")}: ${lines.length} uncontained ${arm} finding(s), allowlist says ${want}`,
        );
      }
    }
    for (const [rel, entry] of Object.entries(allowlist)) {
      if (entry[arm] !== undefined && !flagged.get(rel)?.[arm].length) {
        out.push(
          `${rel}: stale ${arm} allowlist entry (0 hits, allowlist says ${entry[arm]})`,
        );
      }
    }
  }
  return out;
}

// Every .tsx under src/ outside the vendored primitives.
const CORPUS = loadCorpus(
  srcEntries(ROOT, (rel) => rel.endsWith(".tsx") && !rel.startsWith(VENDORED)),
);
const VENDOR = loadCorpus(
  VENDOR_PINS.map(([rel]) => [rel, readFileSync(join(ROOT, rel), "utf8")]),
);

test("every ScrollArea clips and every popup scroller is positioned", () => {
  assert.deepEqual(problems(CORPUS), []);
});

test("every allowlist entry carries a rationale and a count", () => {
  for (const [rel, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(entry.rationale.length > 0, rel);
    assert.ok(
      entry.scrollArea !== undefined || entry.popupScroller !== undefined,
      rel,
    );
  }
});

const REL = "src/features/zz/Synthetic.tsx";
const component = (body) =>
  ["export function Picker() {", "  return (", ...body, "  );", "}", ""].join(
    "\n",
  );
const popup = (popupClass, railClass, tag = "Popover.Popup") =>
  component([
    `    <${tag} className="${popupClass}">`,
    `      <div className="${railClass}">`,
    '        <span className="sr-only">held</span>',
    "      </div>",
    `    </${tag}>`,
  ]);
const area = (attrs) =>
  component([
    `    <ScrollArea ${attrs}>`,
    "      <p>x</p>",
    "    </ScrollArea>",
  ]);

/** A minimal corpus for the synthetic checks: RepoList (its pin, and a
 *  ScrollArea) and a stub popup, so no check needs the whole tree. */
const STUB = "src/features/zz/Stub.tsx";
const STUB_TEXT = component([
  '    <Popover.Popup className="w-60">x</Popover.Popup>',
]);
const base = () =>
  new Map([
    [REPO_LIST, CORPUS.get(REPO_LIST)],
    [STUB, STUB_TEXT],
  ]);
const withFile = (text, rel = REL) => base().set(rel, text);
/** `problems` with the allowlist rows for the files present. */
const check = (files, allowlist = ALLOWLIST, vendor = VENDOR) =>
  problems(
    files,
    Object.fromEntries(
      Object.entries(allowlist).filter(([rel]) => files.has(rel)),
    ),
    vendor,
  );

test("the minimal corpus passes on its own", () => {
  assert.deepEqual(check(base()), []);
});

/** The single problem a fixture raises, asserted to match `re`. */
function onlyProblem(files, re, allowlist) {
  const got = check(files, allowlist);
  assert.equal(got.length, 1, got.join("\n"));
  assert.match(got[0], re);
}

const repoListWith = (from, to) => {
  const real = CORPUS.get(REPO_LIST);
  assert.ok(real?.includes(from), `RepoList holds ${from}`);
  return real.replace(from, to);
};

test("G1: RepoList without its clip, its inset focus, or its cn( fails", () => {
  for (const u of ["ring-0", "-outline-offset-2", "outline-solid"]) {
    const cut = ` ${VIEWPORT_FOCUS}${u}`;
    onlyProblem(
      withFile(repoListWith(cut, ""), REPO_LIST),
      /RepoList\.tsx:\d+: ScrollArea tokens/,
    );
  }
  const noClip = repoListWith('"overflow-clip ', '"');
  const got = check(withFile(noClip, REPO_LIST));
  assert.equal(got.length, 2, got.join("\n"));
  assert.match(got.join("\n"), /RepoList\.tsx:\d+: ScrollArea tokens/);
  assert.match(got.join("\n"), /RepoList\.tsx:\d+: 1 uncontained scrollArea/);
  const bare = CORPUS.get(REPO_LIST).replace(
    /className=\{cn\(\s*LIST_VIEWPORT_CLASS,(?:\s*\/\/[^\n]*)*\s*"[^"]*",?\s*\)\}/,
    "className={LIST_VIEWPORT_CLASS}",
  );
  assert.notEqual(bare, CORPUS.get(REPO_LIST));
  const gotBare = check(withFile(bare, REPO_LIST)).join("\n");
  assert.match(gotBare, /RepoList\.tsx:\d+: className is not cn\(/);
  assert.match(gotBare, /RepoList\.tsx:\d+: 1 uncontained scrollArea/);
});

test("G2: an unclipped, variant-only or spread ScrollArea flags", () => {
  onlyProblem(
    withFile(area('className="h-40"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40 md:overflow-hidden"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40 overflow-hidden" {...rest}')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  onlyProblem(
    withFile(area('className="h-40" title="overflow-hidden"')),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
  assert.deepEqual(
    check(withFile(area('className="h-40 overflow-hidden"'))),
    [],
  );
  assert.deepEqual(check(withFile(area('className="h-40 overflow-clip"'))), []);
});

test("G2: overflow resolves per axis; ambiguity and overrides fail", () => {
  for (const cls of [
    'className={cn("overflow-hidden", "overflow-visible")}',
    'className="h-40 overflow-hidden sm:overflow-visible"',
    'className="overflow-hidden overflow-visible!"',
    'className="overflow-hidden !overflow-visible"',
    'className="overflow-hidden sm:overflow-x-auto"',
    // Plain strings: one specificity, two values -> stylesheet-ordered.
    'className="overflow-clip overflow-auto"',
    'className="overflow-visible overflow-hidden"',
    // Each axis must clip: y overrides the shorthand on its axis.
    'className="overflow-clip overflow-y-visible"',
    'className="overflow-hidden overflow-y-auto"',
    'className="overflow-hidden overflow-x-auto"',
    'className={cn("overflow-hidden", "overflow-y-auto")}',
    'className="overflow-y-hidden"',
  ]) {
    onlyProblem(
      withFile(area(cls)),
      /Synthetic\.tsx:3: 1 uncontained scrollArea/,
    );
  }
  for (const cls of [
    'className={cn("overflow-visible", "overflow-hidden")}',
    'className={cn("overflow-y-auto", "overflow-hidden")}',
    'className="overflow-hidden md:overflow-clip"',
    'className="overflow-x-hidden overflow-y-clip"',
    'className="overflow-auto overflow-x-hidden overflow-y-hidden"',
  ]) {
    assert.deepEqual(check(withFile(area(cls))), [], cls);
  }
});

test("G3: an unpositioned scroller in a popup flags; a relative one passes", () => {
  const hit = /Synthetic\.tsx:4: 1 uncontained popupScroller/;
  onlyProblem(withFile(popup("w-60", "max-h-64 overflow-y-auto")), hit);
  onlyProblem(
    withFile(popup("w-60", "max-h-64 sm:relative overflow-y-auto")),
    hit,
  );
  onlyProblem(withFile(popup("w-60", "max-h-64 md:overflow-auto")), hit);
  assert.deepEqual(
    check(withFile(popup("w-60", "relative max-h-64 overflow-y-auto"))),
    [],
  );
  onlyProblem(
    withFile(popup("w-60 max-h-64 overflow-y-auto", "py-2")),
    /Synthetic\.tsx:3: 1 uncontained popupScroller/,
  );
  onlyProblem(
    withFile(popup("w-60", "max-h-64 overflow-y-auto", "DropdownMenuContent")),
    hit,
  );
});

test("G3: position resolves through cn; ambiguity and overrides fail", () => {
  const hit = /Synthetic\.tsx:4: 1 uncontained popupScroller/;
  const rail = (attr) =>
    component([
      '    <Popover.Popup className="w-60">',
      `      <div ${attr}>`,
      '        <span className="sr-only">held</span>',
      "      </div>",
      "    </Popover.Popup>",
    ]);
  for (const attr of [
    'className={cn("relative overflow-y-auto", "static")}',
    'className="relative max-h-64 overflow-y-auto md:static"',
    'className="relative absolute overflow-y-auto"',
    'className="relative overflow-y-auto !static"',
    'className="relative overflow-y-auto static!"',
    'className="static relative overflow-y-auto"',
    'className="max-h-64 overflow-y-auto!"',
    'className="max-h-64 sm:overflow-y-scroll!"',
  ]) {
    onlyProblem(withFile(rail(attr)), hit);
  }
  for (const attr of [
    'className={cn("static", "relative overflow-y-auto")}',
    'className="relative overflow-y-auto md:relative"',
    'className="relative overflow-y-auto!"',
  ]) {
    assert.deepEqual(check(withFile(rail(attr))), [], attr);
  }
});

test("G3: classes inside another attribute's value are not the tag's", () => {
  const nested = (own) =>
    component([
      '    <Popover.Popup className="w-60">',
      `      <LabeledGroup className="${own}" actions={<button className="relative pb-2" />}>`,
      '        <span className="sr-only">held</span>',
      "      </LabeledGroup>",
      "    </Popover.Popup>",
    ]);
  onlyProblem(
    withFile(nested("max-h-64 overflow-y-auto")),
    /Synthetic\.tsx:4: 1 uncontained popupScroller/,
  );
  assert.deepEqual(
    check(withFile(nested("relative max-h-64 overflow-y-auto"))),
    [],
  );
  onlyProblem(
    withFile(
      area('className="h-40" actions={<b className="overflow-hidden" />}'),
    ),
    /Synthetic\.tsx:3: 1 uncontained scrollArea/,
  );
});

test("G3: scrollers outside a popup and SelectContent ranges are ignored", () => {
  const after = component([
    "    <>",
    '      <Popover.Popup className="w-60">x</Popover.Popup>',
    '      <div className="max-h-64 overflow-y-auto" />',
    "    </>",
  ]);
  assert.deepEqual(check(withFile(after)), []);
  assert.deepEqual(
    check(withFile(popup("w-60", "max-h-64 overflow-y-auto", "SelectContent"))),
    [],
  );
});

test("G3: a raw part imported under an alias joins the roster", () => {
  const text = `import { Popover as P } from "@base-ui/react/popover";\n${popup(
    "w-60",
    "max-h-64 overflow-y-auto",
    "P.Popup",
  )}`;
  onlyProblem(withFile(text), /Synthetic\.tsx:5: 1 uncontained popupScroller/);
  const commented = text.replace("Popover as P", "Popover /* popup */ as P");
  assert.notEqual(commented, text);
  assert.deepEqual(check(withFile(commented)), check(withFile(text)));
});

test("G4: an aliased ScrollArea or roster wrapper, or a namespace import, fails", () => {
  onlyProblem(
    withFile(
      'import { ScrollArea as SA } from "@/components/ui/scroll-area";\n',
    ),
    /Synthetic\.tsx:1: ScrollArea imported as SA/,
  );
  onlyProblem(
    withFile(
      'import { ScrollArea /* x */ as SA } from "@/components/ui/scroll-area";\n',
    ),
    /Synthetic\.tsx:1: ScrollArea imported as SA/,
  );
  onlyProblem(
    withFile(
      'import {\n  DropdownMenuContent as Menu,\n} from "@/components/ui/dropdown-menu";\n',
    ),
    /Synthetic\.tsx:1: DropdownMenuContent imported as Menu/,
  );
  onlyProblem(
    withFile('import * as PopoverNs from "@base-ui/react/popover";\n'),
    /Synthetic\.tsx:1: namespace import/,
  );
  assert.deepEqual(
    check(
      withFile(
        'import type { ScrollArea as SA } from "@/components/ui/scroll-area";\n',
      ),
    ),
    [],
  );
  assert.deepEqual(
    check(
      withFile(
        '// import { ScrollArea as SA } from "@/components/ui/scroll-area";\n',
      ),
    ),
    [],
  );
});

/** The vendored tags whose position (and, for the popups, overflow) resolve. */
const RESOLVED_TAGS = [
  [SELECT, "SelectPrimitive.Popup"],
  [COMBOBOX, "ComboboxPrimitive.Popup"],
  [SCROLL_AREA, "ScrollAreaPrimitive.Root"],
];

/** The vendored files with `name`'s first className string literal (the cn
 *  base the vendor writes) rewritten through `edit(tokens)`. Located by tag,
 *  never by its exact text, so a neutral vendor change keeps the fixtures. */
function vendorWith(rel, name, edit) {
  const real = VENDOR.get(rel);
  const masked = maskNonCode(real, true);
  const ranges = elementRanges(rel, real, masked, name);
  assert.equal(ranges.length, 1, `${rel}: one <${name}>`);
  const s = ranges[0][0];
  const e = tagEnd(masked, s) + 1;
  const at = masked.indexOf("className", s);
  const q = masked.indexOf('"', at);
  assert.ok(at > s && q > at && q < e, `${rel}: <${name}> class string`);
  const end = masked.indexOf('"', q + 1);
  const tokens = real
    .slice(q + 1, end)
    .split(/\s+/)
    .filter(Boolean);
  const next = `${real.slice(0, q + 1)}${edit(tokens).join(" ")}${real.slice(end)}`;
  assert.notEqual(next, real, `${rel}: the edit changed nothing`);
  return new Map([...VENDOR, [rel, next]]);
}
const plus = (extra) => (tokens) => [...tokens, extra];
const without = (token) => (tokens) => {
  assert.ok(tokens.includes(token), token);
  return tokens.filter((t) => t !== token);
};
/** The pin problems a vendor map raises, line numbers blanked. */
const pinProblems = (vendor) =>
  check(base(), {}, vendor).map((p) => p.replace(/:\d+:/, ":N:"));

test("G4: each vendored pin resolves today", () => {
  assert.deepEqual(vendorPins(VENDOR), []);
});

for (const [rel, name] of RESOLVED_TAGS) {
  test(`G4: <${name}> with a neutral class added still resolves`, () => {
    const beside = (tokens) => {
      const i = tokens.indexOf("relative");
      assert.ok(i >= 0, "relative");
      return [...tokens.slice(0, i + 1), "min-h-0", ...tokens.slice(i + 1)];
    };
    assert.deepEqual(pinProblems(vendorWith(rel, name, beside)), []);
    assert.deepEqual(pinProblems(vendorWith(rel, name, plus("isolate"))), []);
  });
  for (const [edit, label] of [
    [without("relative"), "without `relative`"],
    [plus("static"), "with a later `static`"],
    [plus("md:absolute"), "with a variant `md:absolute`"],
  ]) {
    test(`G4: <${name}> ${label} fails`, () => {
      assert.deepEqual(pinProblems(vendorWith(rel, name, edit)), [
        `${rel}:N: <${name}> no longer resolves position to relative`,
      ]);
    });
  }
}

for (const [rel, name] of RESOLVED_TAGS.slice(0, 2)) {
  test(`G4: <${name}> with a later \`overflow-visible\` fails`, () => {
    const vendor = vendorWith(rel, name, plus("overflow-visible"));
    assert.deepEqual(pinProblems(vendor), [
      `${rel}:N: <${name}> no longer resolves overflow-x to hidden`,
      `${rel}:N: <${name}> no longer resolves overflow-y to ${rel === SELECT ? "auto" : "hidden"}`,
    ]);
  });
}

for (const [rel, name, token, axes] of [
  [SELECT, "SelectPrimitive.Popup", "overflow-y-auto", ["overflow-y to auto"]],
  [
    SELECT,
    "SelectPrimitive.Popup",
    "overflow-x-hidden",
    ["overflow-x to hidden"],
  ],
  [
    COMBOBOX,
    "ComboboxPrimitive.Popup",
    "overflow-hidden",
    ["overflow-x to hidden", "overflow-y to hidden"],
  ],
]) {
  test(`G4: <${name}> without its \`${token}\` fails`, () => {
    assert.deepEqual(
      pinProblems(vendorWith(rel, name, without(token))),
      axes.map((a) => `${rel}:N: <${name}> no longer resolves ${a}`),
    );
  });
}

const VIEWPORT = "ScrollAreaPrimitive.Viewport";

test("G4: any change to the viewport's class literal fails", () => {
  const wider = (tokens) =>
    tokens.map((t) =>
      t === "focus-visible:ring-[3px]" ? "focus-visible:ring-[6px]" : t,
    );
  const want = [
    `${SCROLL_AREA}:N: <${VIEWPORT}> the vendored ScrollArea viewport classes changed: re-check RepoList's inset focus outline override (${REPO_LIST}), then update this pin`,
  ];
  assert.deepEqual(pinProblems(vendorWith(SCROLL_AREA, VIEWPORT, wider)), want);
  for (const extra of [
    "focus-visible:outline-none!",
    "focus-visible:outline-hidden",
    "focus-visible:ring-inset",
    "focus-visible:outline-dashed!",
    "focus-visible:ring-offset-2",
    "focus-visible:after:inset-0!",
  ]) {
    assert.deepEqual(
      pinProblems(vendorWith(SCROLL_AREA, VIEWPORT, plus(extra))),
      want,
      extra,
    );
  }
});

test("G4: a viewport without RepoList's data-slot fails", () => {
  const real = VENDOR.get(SCROLL_AREA);
  const cut = 'data-slot="scroll-area-viewport"';
  assert.equal(real.split(cut).length, 2, "the viewport slot, once");
  const vendor = new Map([
    ...VENDOR,
    [SCROLL_AREA, real.replace(cut, 'data-slot="viewport"')],
  ]);
  assert.deepEqual(pinProblems(vendor), [
    `${SCROLL_AREA}:N: <${VIEWPORT}> lost its data-slot="scroll-area-viewport"`,
  ]);
});

const VIEWPORT_CLASSES = VENDOR_PINS.find(
  ([, , kind]) => kind === "classes",
)[3];
const CLASS_MSG = `${SCROLL_AREA}:N: <${VIEWPORT}> the vendored ScrollArea viewport classes changed: re-check RepoList's inset focus outline override (${REPO_LIST}), then update this pin`;
for (const [label, from, to, want] of [
  [
    "a commented-out className",
    `className="${VIEWPORT_CLASSES}"`,
    `// className="${VIEWPORT_CLASSES}"\n        className="${VIEWPORT_CLASSES} p-1"`,
    CLASS_MSG,
  ],
  [
    "a commented-out data-slot",
    'data-slot="scroll-area-viewport"',
    '// data-slot="scroll-area-viewport"\n        data-slot="viewport"',
    `${SCROLL_AREA}:N: <${VIEWPORT}> lost its data-slot="scroll-area-viewport"`,
  ],
  [
    "a second className",
    `className="${VIEWPORT_CLASSES}"`,
    `className="${VIEWPORT_CLASSES}" className="x"`,
    CLASS_MSG,
  ],
]) {
  test(`G4: ${label} on the viewport never satisfies its pin`, () => {
    const real = VENDOR.get(SCROLL_AREA);
    assert.equal(real.split(from).length, 2, `${from} once`);
    const next = real.replace(from, () => to);
    assert.deepEqual(pinProblems(new Map([...VENDOR, [SCROLL_AREA, next]])), [
      want,
    ]);
  });
}

test("G4: a viewport attribute inside another attribute's value is not the viewport's", () => {
  const real = VENDOR.get(SCROLL_AREA);
  const from = `className="${VIEWPORT_CLASSES}"`;
  const decoy = `render={<i className="${VIEWPORT_CLASSES}" data-slot="scroll-area-viewport" />}`;
  const vendorOf = (own) =>
    new Map([
      ...VENDOR,
      [SCROLL_AREA, real.replace(from, () => `${decoy} ${own}`)],
    ]);
  assert.deepEqual(pinProblems(vendorOf(from)), []);
  assert.deepEqual(
    pinProblems(vendorOf(`className="${VIEWPORT_CLASSES} p-1"`)),
    [CLASS_MSG],
  );
});

test("G5: stale or drifted allowlist counts fail", () => {
  const stale = {
    "src/features/zz/Gone.tsx": { popupScroller: 1, rationale: "x" },
  };
  const got = problems(base(), stale);
  assert.equal(got.length, 1, got.join("\n"));
  assert.match(got[0], /Gone\.tsx: stale popupScroller/);
  const drifted = withFile(area('className="h-40"'));
  onlyProblem(
    drifted,
    /Synthetic\.tsx:3: 1 uncontained scrollArea finding\(s\), allowlist says 2/,
    { ...ALLOWLIST, [REL]: { scrollArea: 2, rationale: "x" } },
  );
});

test("G6: zero files, zero tags or an unclosed popup fail closed", () => {
  assert.deepEqual(problems(new Map()), ["the walk read zero files"]);
  const none = new Map([["src/features/zz/A.tsx", "export const a = 1;\n"]]);
  const got = problems(none, {});
  assert.ok(got.includes("no <ScrollArea> tags found"), got.join("\n"));
  assert.ok(got.includes("no popup ranges found"), got.join("\n"));
  const unclosed = component([
    '    <div><Popover.Popup className="w-60"></div>',
  ]);
  assert.throws(() => check(withFile(unclosed)), ScanError);
});

test("NC3: ProjectsPopover's rows scroller without `relative` fails", () => {
  const rel = "src/features/conversations/ProjectsPopover.tsx";
  const real = CORPUS.get(rel);
  const cut = 'className="relative max-h-64 overflow-y-auto py-2"';
  assert.equal(real.split(cut).length, 2, "the rows scroller, once");
  const files = withFile(
    real.replace(cut, 'className="max-h-64 overflow-y-auto py-2"'),
    rel,
  );
  onlyProblem(files, /ProjectsPopover\.tsx:\d+: 1 uncontained popupScroller/);
});
